//! Host-side networking for virtio-net (M24; architecture §11.3; threat model §7.14; course ch19).
//!
//! - [`backend`]: the [`NetBackend`] trait between the device model (`virtio/net.rs`) and the
//!   host, and the frame-size constants every backend shares;
//! - [`unixgram`]: the v1 backend, one Unix datagram per Ethernet frame, no entitlement and no
//!   host network stack (NET-6).
//!
//! **Lifetime.** A NIC's backend is opened once by `HostIo::open` (before any vCPU runs, like
//! every host resource: HOSTIO-1) and lives in [`NetHost`] for the whole process, so an
//! in-process reboot (M5) keeps the same socket, the same MAC and, in `,learn` mode, the same
//! locked peer. Each boot's device model and RX thread borrow it through an `Arc`.
//!
//! This module (and `gdbstub/`, post-v1) is the only place in `crates/vmm` allowed to name
//! `std::net` or `std::os::unix::net` (RUST-6, `cargo xtask audit` rule `no-net`).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod backend;
pub mod unixgram;

pub use backend::NetBackend;

use core::fmt;
use std::sync::Arc;

/// The OUI-like prefix of a default MAC: `02` sets the "locally administered" bit and clears
/// the multicast bit (IEEE 802 §8.2.2), `6d:76` is "mv". The other three bytes are random.
pub const MAC_PREFIX: [u8; 3] = [0x02, 0x6d, 0x76];

/// One `--net` NIC's host side (module docs).
#[derive(Clone)]
pub struct NetHost {
    /// Where frames go.
    pub backend: Arc<dyn NetBackend>,
    /// The MAC the device reports in its config space (`mac=`, or [`default_mac`]).
    pub mac: [u8; 6],
}

impl fmt::Debug for NetHost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NetHost")
            .field("mac", &format_mac(&self.mac))
            .finish_non_exhaustive()
    }
}

/// `02:6d:76:xx:yy:zz` with the last three bytes from `random` (PLAN M24: `HostIo.entropy`).
pub fn default_mac(random: [u8; 3]) -> [u8; 6] {
    let [a, b, c] = MAC_PREFIX;
    let [x, y, z] = random;
    [a, b, c, x, y, z]
}

/// `aa:bb:cc:dd:ee:ff`.
pub fn format_mac(mac: &[u8; 6]) -> String {
    let [a, b, c, d, e, g] = mac;
    format!("{a:02x}:{b:02x}:{c:02x}:{d:02x}:{e:02x}:{g:02x}")
}

/// Parse `aa:bb:cc:dd:ee:ff` (hex, either case). A multicast address (the low bit of the first
/// byte set) is refused: a NIC's own address must be unicast (IEEE 802 §8.2.2), and Linux
/// refuses one anyway (`is_valid_ether_addr`).
pub fn parse_mac(s: &str) -> Result<[u8; 6], String> {
    let mut out = [0u8; 6];
    let mut parts = s.split(':');
    for slot in &mut out {
        let p = parts
            .next()
            .ok_or_else(|| format!("bad MAC {s:?}: need six hex bytes like 02:6d:76:00:00:01"))?;
        // `from_str_radix` alone would also take a leading `+`.
        if p.len() != 2 || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("bad MAC {s:?}: each byte is two hex digits"));
        }
        *slot = u8::from_str_radix(p, 16).map_err(|_| format!("bad MAC {s:?}: not hex"))?;
    }
    if parts.next().is_some() {
        return Err(format!("bad MAC {s:?}: more than six bytes"));
    }
    if out.iter().all(|&b| b == 0) {
        return Err(format!("bad MAC {s:?}: the all-zero address is not valid"));
    }
    if out.first().is_some_and(|b| b & 1 != 0) {
        return Err(format!(
            "bad MAC {s:?}: a multicast address cannot be a NIC's address"
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macs() {
        assert_eq!(parse_mac("02:6d:76:00:00:01"), Ok([2, 0x6d, 0x76, 0, 0, 1]));
        assert_eq!(parse_mac("02:6D:76:AA:bb:0c").map(|m| m[3]), Ok(0xaa));
        for bad in [
            "",
            "02:6d:76:00:00",
            "02:6d:76:00:00:01:02",
            "2:6d:76:00:00:01",
            "02:6d:76:00:00:zz",
            "01:00:5e:00:00:01",
            "00:00:00:00:00:00",
            "+2:6d:76:00:00:01",
        ] {
            assert!(parse_mac(bad).is_err(), "{bad}");
        }
        let m = default_mac([1, 2, 3]);
        assert_eq!(format_mac(&m), "02:6d:76:01:02:03");
        assert_eq!(parse_mac(&format_mac(&m)), Ok(m));
    }
}
