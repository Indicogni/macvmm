//! `NetBackend`: where a virtio-net NIC's Ethernet frames go on the host (architecture §11.3,
//! §22 "Networking beyond v1"; course ch19).
//!
//! **Why a trait.** The device model (`virtio/net.rs`) only knows "send this frame" and "give me
//! the next frame". Everything about *how* frames leave the process (a Unix datagram socket in
//! v1; a learning switch, a user-mode NAT or vmnet later) stays behind this seam, so the guest-
//! facing parser and its hostile tests never change when a backend is added, and the host tests
//! drive the device with an in-memory `MockBackend`.
//!
//! **The contract** (every backend, threat model NET-5):
//! - one call moves one whole Ethernet frame (destination MAC to payload, no FCS, no virtio
//!   header): [`ETH_MIN_FRAME`]`..=`[`ETH_MAX_FRAME`] bytes;
//! - `send` never blocks for long: it is called on the device's virtio worker with the device
//!   mutex held, so it gives up after a few milliseconds and the frame is dropped and counted
//!   (Ethernet is lossy; TCP retransmits);
//! - `recv` waits at most a short, fixed time ([`RECV_TIMEOUT`]) and then returns a
//!   `WouldBlock` or `TimedOut` error, so the RX thread sees its stop flag and joins promptly;
//! - a datagram the backend itself refuses (a foreign sender, NET-1) is reported as a
//!   [`ErrorKind::PermissionDenied`](std::io::ErrorKind::PermissionDenied) error **after** the
//!   backend counted it in [`NetBackend::rx_dropped_foreign`]; the RX thread just goes round.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::io;
use std::time::Duration;

/// The shortest Ethernet frame a NIC accepts: the 14-byte header (destination, source,
/// EtherType; IEEE 802.3 §3.1.1) with no payload. Frames are not padded to 60 bytes here: the
/// padding is a wire-level rule and neither side of a datagram needs it.
pub const ETH_MIN_FRAME: usize = 14;
/// The longest frame: a 1500-byte MTU payload plus the 14-byte header. VLAN tags and jumbo
/// frames are not supported (no `VIRTIO_NET_F_MTU`, no offloads: NET-5).
pub const ETH_MAX_FRAME: usize = 1514;
/// How long one `recv` may wait (PLAN M24: the RX thread checks its stop flag at least this
/// often, so a VM stops within about 100 ms).
pub const RECV_TIMEOUT: Duration = Duration::from_millis(100);
/// How long one `send` may keep retrying a full peer before the frame is dropped (PLAN M24:
/// "`set_write_timeout(10 ms)`").
pub const SEND_TIMEOUT: Duration = Duration::from_millis(10);

// ANCHOR: net_backend_trait
/// A host-side frame transport for one NIC (module docs for the contract).
pub trait NetBackend: Send + Sync {
    /// Send one Ethernet frame. An `Err` means the frame was dropped; the caller counts it.
    fn send(&self, frame: &[u8]) -> io::Result<()>;
    /// Receive one frame into `buf` and return its length, or an error after at most
    /// [`RECV_TIMEOUT`] (`WouldBlock`/`TimedOut`: nothing arrived; `PermissionDenied`: a
    /// datagram arrived and the backend dropped it, already counted).
    fn recv(&self, buf: &mut [u8]) -> io::Result<usize>;
    /// Datagrams dropped because they did not come from the peer (NET-1). Cumulative for the
    /// lifetime of the backend, which spans in-process reboots.
    fn rx_dropped_foreign(&self) -> u64 {
        0
    }
}
// ANCHOR_END: net_backend_trait

/// True if a `recv` error only means "nothing to deliver this time" (a timeout, or a datagram
/// the backend already dropped and counted): the RX thread goes round without a warning.
pub fn is_quiet(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::PermissionDenied
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_bounds_and_quiet_errors() {
        assert_eq!(ETH_MAX_FRAME - ETH_MIN_FRAME, 1500);
        assert!(is_quiet(&io::Error::from(io::ErrorKind::WouldBlock)));
        assert!(is_quiet(&io::Error::from(io::ErrorKind::PermissionDenied)));
        assert!(!is_quiet(&io::Error::from(io::ErrorKind::BrokenPipe)));
    }
}
