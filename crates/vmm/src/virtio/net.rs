//! virtio-net: the network card (virtio 1.2 §5.1 "Network Device"; architecture §11.3; threat
//! model §7.14 NET-1..6; course ch19).
//!
//! **What the guest sees.** DeviceID 1 with two queues, `receiveq1` (index 0) and `transmitq1`
//! (index 1), each at most [`NET_QUEUE_SIZE`] entries (§5.1.2), and a 6-byte configuration space
//! holding the MAC address (§5.1.4, `VIRTIO_NET_F_MAC`). Nothing else is offered: no checksum or
//! segmentation offload (`CSUM`, `GUEST_*`, `HOST_*`), no mergeable RX buffers (`MRG_RXBUF`), no
//! control queue, no `STATUS` (so the link is simply up, §5.1.4.2), no `MTU`. Each offload is a
//! new way for the guest to describe a packet, and so a new parser to harden (NET-5, architecture
//! §22): v1 offers `VERSION_1 | MAC` only.
//!
//! **The header.** Every buffer starts with a `struct virtio_net_hdr` (§5.1.6). With
//! `VERSION_1` it is always the 12-byte form, `num_buffers` included, even without `MRG_RXBUF`
//! (§5.1.6.1: "the header ... num_buffers ... is always present"):
//!
//! ```text
//!   0 flags  1 gso_type  2 hdr_len  4 gso_size  6 csum_start  8 csum_offset  10 num_buffers
//! ```
//!
//! With no offload negotiated, a driver MUST send `flags = 0` and `gso_type = GSO_NONE (0)`
//! (§5.1.6.2), and the device sets `num_buffers = 1` and everything else to 0 on receive
//! (§5.1.6.4).
//!
//! **TX** (anchor `net_tx_frame`, on the device's virtio worker after a QueueNotify): pop a
//! chain; it must be readable-only and its length `12 + 14 ..= 12 + 1514` bytes. It is copied
//! out of guest memory **once** into a local buffer, the header is checked on the copy (so the
//! guest cannot change it after the check, MEM-7), stripped, and the frame goes to the backend.
//! A bad chain or a failed send is **dropped and counted**, never an error the guest can turn
//! into NEEDS_RESET: Ethernet is lossy, and the chain is always returned (`add_used(head, 0)`;
//! a TX chain has nothing for the device to write). Only a malformed *ring* (a loop, an index
//! jump, a buffer outside RAM) is `Err` and therefore NEEDS_RESET (VQ-10).
//!
//! **RX** (anchor `net_rx_frame`, on the NIC's RX thread, [`spawn_rx`]): the backend hands over
//! one datagram. Outside `14..=1514` bytes it is dropped (`rx_dropped_len`). Otherwise one posted
//! RX chain is popped; none posted → drop (`rx_dropped_no_buffer`: the guest is not keeping up,
//! like a real NIC with a full ring). The chain must be writable-only with room for
//! `12 + frame`; if not it is returned with `len 0` (`rx_dropped_small`). Then a zeroed header
//! with `num_buffers = 1` and the frame are written, `add_used(head, 12 + len)` (VQ-9: what was
//! written), and the interrupt is raised if the driver wants one.
//!
//! **Threads.** TX runs on the worker, RX on its own thread, and both take the device mutex for
//! one frame at a time, so neither blocks a vCPU (a vCPU only rings the doorbell, M12) and RX
//! never waits on the guest: `recv` returns after 100 ms at most and the thread checks its stop
//! flag ([`RxThread::stop`]). The RX thread is joined with the worker (it is the worker's
//! [`Companion`]).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::mmio::report_error;
use super::worker::Companion;
use super::{
    DEVICE_ID_NET, Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt, features,
};
use crate::control::{StopReason, VmControl};
use crate::error::Error;
use crate::memory::{GuestAddress, GuestMemoryOrdered};
use crate::net::NetBackend;
use crate::net::backend::{ETH_MAX_FRAME, ETH_MIN_FRAME, is_quiet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// Both queues' maximum size (PLAN M24).
pub const NET_QUEUE_SIZE: u16 = 256;
/// `receiveq1` (§5.1.2).
pub const RX_QUEUE: usize = 0;
/// `transmitq1` (§5.1.2).
pub const TX_QUEUE: usize = 1;
/// `VIRTIO_NET_F_MAC` (§5.1.3): the config space holds the device's MAC.
pub const F_MAC: u64 = 1 << 5;
/// The features offered (module docs).
pub const NET_FEATURES: u64 = features::VERSION_1 | F_MAC;
/// The size of `struct virtio_net_hdr` with `VERSION_1` (§5.1.6).
pub const HDR_LEN: usize = 12;
/// The longest TX chain accepted: one header and one full frame (NET-5).
pub const MAX_TX_CHAIN: usize = 1526;
/// The shortest TX chain accepted: one header and an Ethernet header. NET-5 only requires
/// `≥ 12`; a frame shorter than its own Ethernet header could only be dropped by the peer, so
/// it is dropped (and counted) here instead.
pub const MIN_TX_CHAIN: usize = 26;
/// The config space: `mac[6]` only (§5.1.4; `status`, `max_virtqueue_pairs` and `mtu` exist only
/// with features we do not offer).
pub const NET_CONFIG_LEN: u32 = 6;
/// The RX thread's receive buffer, sized like macOS's `net.local.dgram.maxdgram` (2048).
/// `maxdgram` is only the *default* send buffer of a datagram socket, not a cap: a sender that
/// raises its own `SO_SNDBUF` can send a longer datagram `[V]`, and `recv` silently truncates it
/// to this buffer. That is safe because the buffer is **longer than any frame**: a truncated
/// datagram is exactly `RX_BUFFER` bytes, more than [`ETH_MAX_FRAME`], so [`Net::receive`]
/// always drops it (`rx_dropped_len`) and a truncation can never pass as a valid frame. The
/// assertion below keeps that invariant true if either constant changes.
pub const RX_BUFFER: usize = 2048;
const _: () = assert!(
    RX_BUFFER > ETH_MAX_FRAME,
    "a truncated datagram must not fit a frame"
);

/// The verdict an RX-thread panic posts (RUST-7: exit code 1).
pub const RX_PANIC: &str = "a virtio-net RX thread panicked";

/// The NIC's counters (`--stats`), shared by the device, its RX thread and the stats line.
#[derive(Debug, Default)]
pub struct NetCounters {
    tx_packets: AtomicU64,
    tx_bytes: AtomicU64,
    tx_dropped: AtomicU64,
    rx_packets: AtomicU64,
    rx_bytes: AtomicU64,
    rx_dropped_no_buffer: AtomicU64,
    rx_dropped_small: AtomicU64,
    rx_dropped_len: AtomicU64,
}

/// A snapshot of [`NetCounters`] plus the backend's NET-1 count.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NetStats {
    /// Frames sent to the backend, and their bytes (no virtio header).
    pub tx_packets: u64,
    pub tx_bytes: u64,
    /// TX chains dropped: bad shape, bad header, or a failed send.
    pub tx_dropped: u64,
    /// Frames written into guest RX buffers, and their bytes (no virtio header).
    pub rx_packets: u64,
    pub rx_bytes: u64,
    /// Frames dropped because no RX chain was posted (or the device was not live).
    pub rx_dropped_no_buffer: u64,
    /// Frames dropped because the posted chain was too small or had a readable descriptor.
    pub rx_dropped_small: u64,
    /// Datagrams outside `14..=1514` bytes.
    pub rx_dropped_len: u64,
    /// Datagrams from someone other than the peer (NET-1), counted by the backend.
    pub rx_dropped_foreign: u64,
}

fn bump(c: &AtomicU64, by: u64) {
    c.fetch_add(by, Ordering::Relaxed);
}

impl NetCounters {
    /// The current values (`foreign` from the backend).
    pub fn snapshot(&self, foreign: u64) -> NetStats {
        let g = |c: &AtomicU64| c.load(Ordering::Relaxed);
        NetStats {
            tx_packets: g(&self.tx_packets),
            tx_bytes: g(&self.tx_bytes),
            tx_dropped: g(&self.tx_dropped),
            rx_packets: g(&self.rx_packets),
            rx_bytes: g(&self.rx_bytes),
            rx_dropped_no_buffer: g(&self.rx_dropped_no_buffer),
            rx_dropped_small: g(&self.rx_dropped_small),
            rx_dropped_len: g(&self.rx_dropped_len),
            rx_dropped_foreign: foreign,
        }
    }
}

impl NetStats {
    /// The `--stats` line body: `key=value` pairs, numbers only (LOG-5).
    pub fn line(&self) -> String {
        format!(
            "tx_packets={} tx_bytes={} tx_dropped={} rx_packets={} rx_bytes={} \
             rx_dropped_no_buffer={} rx_dropped_small={} rx_dropped_len={} rx_dropped_foreign={}",
            self.tx_packets,
            self.tx_bytes,
            self.tx_dropped,
            self.rx_packets,
            self.rx_bytes,
            self.rx_dropped_no_buffer,
            self.rx_dropped_small,
            self.rx_dropped_len,
            self.rx_dropped_foreign
        )
    }
}

/// What happened to one received frame ([`Net::receive`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RxOutcome {
    /// Written into a guest RX buffer.
    Delivered,
    /// Outside `14..=1514` bytes.
    BadLength,
    /// No RX chain posted, or the device is not live.
    NoBuffer,
    /// The posted chain was too small or not writable-only; returned with `len 0`.
    ChainUnusable,
}

/// Why a TX chain was dropped (for the rate-limited warning).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TxDrop {
    Writable,
    Length(u64),
    Header { flags: u8, gso_type: u8 },
    Send,
}

/// What the device holds between DRIVER_OK and reset.
struct Active {
    mem: Arc<dyn GuestMemoryOrdered>,
    rx: Queue,
    tx: Queue,
    irq: Arc<VirtioInterrupt>,
}

/// The virtio-net device model (module docs).
pub struct Net {
    mac: [u8; 6],
    backend: Arc<dyn NetBackend>,
    counters: Arc<NetCounters>,
    active: Option<Active>,
}

impl core::fmt::Debug for Net {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Net")
            .field("mac", &crate::net::format_mac(&self.mac))
            .field("active", &self.active.is_some())
            .field("counters", &self.counters)
            .finish_non_exhaustive()
    }
}

/// The TX header rule (§5.1.6.2 with no offload negotiated): `flags == 0` and
/// `gso_type == GSO_NONE`. The other fields carry no meaning without offloads and are ignored.
fn header_ok(hdr: &[u8]) -> Result<(), TxDrop> {
    let flags = hdr.first().copied().unwrap_or(0xff);
    let gso_type = hdr.get(1).copied().unwrap_or(0xff);
    if flags != 0 || gso_type != 0 {
        return Err(TxDrop::Header { flags, gso_type });
    }
    Ok(())
}

impl Net {
    /// A NIC with address `mac` whose frames go to `backend`.
    pub fn new(mac: [u8; 6], backend: Arc<dyn NetBackend>) -> Net {
        Net {
            mac,
            backend,
            counters: Arc::new(NetCounters::default()),
            active: None,
        }
    }

    /// The MAC in the config space.
    pub fn mac(&self) -> [u8; 6] {
        self.mac
    }

    /// The counters (shared with the RX thread and the stats line).
    pub fn counters(&self) -> &Arc<NetCounters> {
        &self.counters
    }

    /// The counters now, the backend's foreign-sender count included.
    pub fn stats(&self) -> NetStats {
        self.counters.snapshot(self.backend.rx_dropped_foreign())
    }

    // ANCHOR: net_tx_frame
    /// Send one popped TX chain: shape and length first, then **one** copy out of guest memory,
    /// then the header check on the copy, then the backend (module docs, NET-5). Returns the
    /// frame length sent, or why it was dropped. A guest-memory failure (memory changed shape
    /// under a validated chain) is the only `Err`.
    fn tx_one(
        mem: &dyn GuestMemoryOrdered,
        backend: &dyn NetBackend,
        req: &super::ValidatedChain,
    ) -> Result<Result<usize, TxDrop>, VirtioError> {
        if !req.writable.is_empty() {
            return Ok(Err(TxDrop::Writable));
        }
        let total = req.readable_len;
        if total < MIN_TX_CHAIN as u64 || total > MAX_TX_CHAIN as u64 {
            return Ok(Err(TxDrop::Length(total)));
        }
        // `total` ≤ 1526 (checked above), so this allocation is bounded by us, not the guest.
        let len = usize::try_from(total).map_err(|_| VirtioError::Device("tx length"))?;
        let mut pkt = vec![0u8; len];
        let mut off = 0usize;
        for d in &req.readable {
            let n = usize::try_from(d.len).map_err(|_| VirtioError::Device("tx length"))?;
            let end = off.checked_add(n).ok_or(VirtioError::Device("tx length"))?;
            let dst = pkt
                .get_mut(off..end)
                .ok_or(VirtioError::Device("tx chain longer than its total"))?;
            mem.read(GuestAddress(d.addr), dst)
                .map_err(|e| VirtioError::Queue(e.into()))?;
            off = end;
        }
        let (hdr, frame) = pkt.split_at(HDR_LEN);
        if let Err(why) = header_ok(hdr) {
            return Ok(Err(why));
        }
        match backend.send(frame) {
            Ok(()) => Ok(Ok(frame.len())),
            Err(_) => Ok(Err(TxDrop::Send)),
        }
    }
    // ANCHOR_END: net_tx_frame

    /// Process up to `budget` TX chains (the worker's VQ-12 batch).
    fn process_tx(&mut self, budget: u16) -> Result<QueueProgress, VirtioError> {
        let Some(a) = self.active.as_mut() else {
            return Err(VirtioError::NotActivated);
        };
        if !a.tx.ready() {
            return Err(VirtioError::NoSuchQueue(TX_QUEUE));
        }
        let budget = budget.min(a.tx.size());
        let mem = &*a.mem;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        for n in 0..=budget {
            if n == budget {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = a.tx.pop(mem)? else {
                break;
            };
            // Structure only (VQ-4..VQ-7): the hop budget bounds the walk; the length rule is
            // the device's own and a violation is a drop, not NEEDS_RESET.
            let req = chain.into_validated(u64::MAX)?;
            match Self::tx_one(mem, &*self.backend, &req)? {
                Ok(len) => {
                    bump(&self.counters.tx_packets, 1);
                    bump(&self.counters.tx_bytes, len as u64);
                }
                Err(why) => {
                    bump(&self.counters.tx_dropped, 1);
                    crate::guest_warn!("virtio-net: TX frame dropped: {why:?}");
                }
            }
            a.tx.add_used(mem, req.head, 0)?; // a TX chain has nothing for us to write
            used = true;
        }
        if used && a.tx.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(progress)
    }

    // ANCHOR: net_rx_frame
    /// Deliver one received frame into the next posted RX chain (module docs, NET-5). Drops are
    /// counted and returned as an outcome; only a malformed ring is `Err` (the caller reports
    /// it: NEEDS_RESET, VQ-10).
    pub fn receive(&mut self, frame: &[u8]) -> Result<RxOutcome, VirtioError> {
        if !(ETH_MIN_FRAME..=ETH_MAX_FRAME).contains(&frame.len()) {
            bump(&self.counters.rx_dropped_len, 1);
            crate::guest_warn!(
                "virtio-net: RX datagram of {:?} bytes dropped (not 14..=1514)",
                frame.len()
            );
            return Ok(RxOutcome::BadLength);
        }
        // No driver yet, reset, receiveq not ready, or NEEDS_RESET: there is no buffer to use.
        let usable = self
            .active
            .as_mut()
            .filter(|a| a.rx.ready() && !a.irq.needs_reset());
        let Some(a) = usable else {
            bump(&self.counters.rx_dropped_no_buffer, 1);
            crate::guest_warn!("virtio-net: RX frame dropped: device or receiveq not ready");
            return Ok(RxOutcome::NoBuffer);
        };
        let mem = &*a.mem;
        let Some(chain) = a.rx.pop(mem)? else {
            bump(&self.counters.rx_dropped_no_buffer, 1);
            crate::guest_warn!("virtio-net: RX frame dropped: no receive buffer posted");
            return Ok(RxOutcome::NoBuffer);
        };
        let req = chain.into_validated(u64::MAX)?;
        let need = HDR_LEN
            .checked_add(frame.len())
            .ok_or(VirtioError::Device("rx length"))? as u64;
        let outcome = if !req.readable.is_empty() || req.writable_len < need {
            bump(&self.counters.rx_dropped_small, 1);
            crate::guest_warn!(
                "virtio-net: RX frame dropped: chain has {:?} readable descriptors and {:?} \
                 writable bytes, needs 0 and {need:?}",
                req.readable.len(),
                req.writable_len
            );
            a.rx.add_used(mem, req.head, 0)?;
            RxOutcome::ChainUnusable
        } else {
            // A fresh buffer per frame (VQ-11): the zeroed header, num_buffers = 1, the frame.
            let mut pkt = vec![0u8; HDR_LEN];
            if let Some(nb) = pkt.get_mut(10..12) {
                nb.copy_from_slice(&1u16.to_le_bytes());
            }
            pkt.extend_from_slice(frame);
            let written = req.write_writable(mem, &pkt)?;
            a.rx.add_used(mem, req.head, written)?; // VQ-9: what was actually written
            bump(&self.counters.rx_packets, 1);
            bump(&self.counters.rx_bytes, frame.len() as u64);
            RxOutcome::Delivered
        };
        if a.rx.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(outcome)
    }
    // ANCHOR_END: net_rx_frame
}

impl VirtioDevice for Net {
    fn device_id(&self) -> u32 {
        DEVICE_ID_NET
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &[NET_QUEUE_SIZE, NET_QUEUE_SIZE]
    }
    fn device_features(&self) -> u64 {
        NET_FEATURES
    }
    fn ack_features(&mut self, _accepted: u64) {}
    fn config_len(&self) -> u32 {
        NET_CONFIG_LEN
    }
    /// `mac[6]` (§5.1.4). The transport already bounded `offset + data.len() ≤ 6`.
    fn read_config(&self, offset: u32, data: &mut [u8]) {
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        for (i, b) in data.iter_mut().enumerate() {
            *b = start
                .checked_add(i)
                .and_then(|j| self.mac.get(j))
                .copied()
                .unwrap_or(0);
        }
    }
    /// Read-only (VQ-13): without `VIRTIO_NET_F_CTRL_MAC_ADDR` a `VERSION_1` driver may not
    /// change the MAC through the config space (§5.1.4.2), and a write is ignored.
    fn write_config(&mut self, _offset: u32, _data: &[u8]) {}

    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        let mut it = queues.into_iter();
        let rx = it.next().ok_or(VirtioError::NoSuchQueue(RX_QUEUE))?;
        let tx = it.next().ok_or(VirtioError::NoSuchQueue(TX_QUEUE))?;
        self.active = Some(Active { mem, rx, tx, irq });
        Ok(())
    }

    /// TX on QueueNotify of queue 1. A notify on queue 0 only says "RX buffers were posted":
    /// they are consumed when a frame arrives ([`Net::receive`]), so there is nothing to do.
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        match index {
            RX_QUEUE => {
                if self.active.is_none() {
                    return Err(VirtioError::NotActivated);
                }
                Ok(QueueProgress::Drained)
            }
            TX_QUEUE => self.process_tx(budget),
            _ => Err(VirtioError::NoSuchQueue(index)),
        }
    }

    fn reset(&mut self) {
        // VQ-14: the queues and the memory handle go; the counters stay for --stats.
        self.active = None;
    }
}

/// What the RX thread and its handle share.
#[derive(Debug, Default)]
struct RxShared {
    stop: AtomicBool,
    panicked: AtomicBool,
}

/// One NIC's RX thread (module docs): `recv` → lock → [`Net::receive`] → unlock. It is the
/// worker's [`Companion`], so stopping the worker stops and joins it too.
pub struct RxThread {
    label: String,
    shared: Arc<RxShared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    counters: Arc<NetCounters>,
    backend: Arc<dyn NetBackend>,
}

impl core::fmt::Debug for RxThread {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RxThread")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

/// Posts the RUST-7 stop if the RX thread unwinds.
struct RxPanicGuard {
    shared: Arc<RxShared>,
    ctl: Arc<VmControl>,
}

impl Drop for RxPanicGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.shared.panicked.store(true, Ordering::SeqCst);
            self.ctl
                .request_stop(StopReason::Vmm(Error::Internal(RX_PANIC)));
        }
    }
}

// ANCHOR: net_rx_thread
/// Start the RX thread `name` for `device` (module docs). `label` names the NIC in the stats
/// line (`net0 slot 1`); `interrupt` is the device's (NEEDS_RESET on a malformed RX ring);
/// `ctl` is the VM a panic stops (RUST-7).
pub fn spawn_rx(
    name: &str,
    label: &str,
    device: Arc<Mutex<Net>>,
    interrupt: Arc<VirtioInterrupt>,
    ctl: Arc<VmControl>,
) -> std::io::Result<RxThread> {
    let (backend, counters) = {
        let d = crate::sync::lock(&device);
        (Arc::clone(&d.backend), Arc::clone(&d.counters))
    };
    let shared = Arc::new(RxShared::default());
    let job_shared = Arc::clone(&shared);
    let job_backend = Arc::clone(&backend);
    let thread = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(move || {
            let _guard = RxPanicGuard {
                shared: Arc::clone(&job_shared),
                ctl,
            };
            let mut buf = vec![0u8; RX_BUFFER];
            while !job_shared.stop.load(Ordering::SeqCst) {
                let n = match job_backend.recv(&mut buf) {
                    Ok(n) => n,
                    Err(e) if is_quiet(&e) => continue,
                    Err(e) => {
                        crate::guest_warn!("virtio-net: receive failed: {e}");
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                };
                let frame = buf.get(..n).unwrap_or_default();
                // A poisoned device (a worker panicked, RUST-7) is never touched again.
                let Ok(mut dev) = device.lock() else { break };
                match dev.receive(frame) {
                    Ok(_) | Err(VirtioError::NotActivated) => {}
                    // Reported with the device mutex held, like the worker (lock order device
                    // → interrupt): a Status = 0 reset waiting on the mutex then clears it.
                    Err(e) => report_error(&interrupt, RX_QUEUE, &e),
                }
            }
        })?;
    Ok(RxThread {
        label: label.to_owned(),
        shared,
        thread: Mutex::new(Some(thread)),
        counters,
        backend,
    })
}
// ANCHOR_END: net_rx_thread

impl RxThread {
    /// The counters now (also after the thread stopped).
    pub fn stats(&self) -> NetStats {
        self.counters.snapshot(self.backend.rx_dropped_foreign())
    }
}

impl Companion for RxThread {
    /// Set the stop flag and join: the thread notices within one `recv` timeout (100 ms).
    fn stop(&self) -> bool {
        self.shared.stop.store(true, Ordering::SeqCst);
        let handle = crate::sync::lock(&self.thread).take();
        if let Some(h) = handle
            && h.join().is_err()
        {
            self.shared.panicked.store(true, Ordering::SeqCst);
        }
        self.shared.panicked.load(Ordering::SeqCst)
    }

    fn stats(&self) -> Option<String> {
        Some(format!("{}: {}", self.label, RxThread::stats(self).line()))
    }
}

impl Drop for RxThread {
    fn drop(&mut self) {
        Companion::stop(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_rules() {
        assert_eq!(header_ok(&[0; 12]), Ok(()));
        assert!(header_ok(&[1, 0]).is_err());
        assert!(header_ok(&[0, 1]).is_err());
        assert!(header_ok(&[]).is_err());
        assert_eq!(MAX_TX_CHAIN, HDR_LEN + ETH_MAX_FRAME);
        assert_eq!(MIN_TX_CHAIN, HDR_LEN + ETH_MIN_FRAME);
        assert_eq!(NET_FEATURES & features::NEVER_OFFERED, 0);
    }
}
