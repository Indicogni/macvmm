// Checkpoint 19 contract, frozen from the reference test crates/vmm/tests/virtio_net_hostile.rs.
// It names only items chapters 15 to 19 teach; the harness runs it against your crates.
//! Host acceptance: the virtio-net device model against hostile rings and frames
//! (virtio 1.2 §5.1; threat model: docs/security/threat-model.md).
//!
//! The device is driven as the worker and the RX thread drive it (`process_queue(TX)` and
//! `Net::receive`) with `VecMemory` as guest RAM and a `MockBackend` as the wire, plus the
//! guest-visible path (transport register reads, the worker, the RX thread). Every drop must be
//! counted, must never become an error the guest can turn into NEEDS_RESET, and must leave
//! guest memory untouched where the rules say so (checked from the `VecMemory` access log).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::control::VmControl;
use vmm::irq::TestIrq;
use vmm::memory::VecMemory;
use vmm::memory::prelude::*;
use vmm::net::NetBackend;
use vmm::virtio::mmio::reg;
use vmm::virtio::net::{
    F_MAC, HDR_LEN, NET_CONFIG_LEN, NET_QUEUE_SIZE, RX_QUEUE, RxOutcome, TX_QUEUE, spawn_rx,
};
use vmm::virtio::worker::Companion;
use vmm::virtio::{
    DEVICE_ID_NET, Net, QueueError, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt,
    VirtioMmio, features,
};

const MAC: [u8; 6] = [0x02, 0x6d, 0x76, 0x00, 0x00, 0x01];
/// The TX ring sits after the RX ring (which uses the default DESC/AVAIL/USED).
const TX_DESC: u64 = RAM + 0x1_0000;
const TX_AVAIL: u64 = RAM + 0x1_3000;
const TX_USED: u64 = RAM + 0x1_4000;
/// Buffers: RX at `RX_BUF`, TX at `TX_BUF`.
const RX_BUF: u64 = RAM + 0x2_0000;
const TX_BUF: u64 = RAM + 0x4_0000;

/// A wire in memory: `send` records frames (or fails on demand), `recv` pops `inbox`.
#[derive(Default)]
struct MockBackend {
    sent: Mutex<Vec<Vec<u8>>>,
    inbox: Mutex<VecDeque<Vec<u8>>>,
    fail_send: AtomicBool,
}

impl NetBackend for MockBackend {
    fn send(&self, frame: &[u8]) -> io::Result<()> {
        if self.fail_send.load(Ordering::SeqCst) {
            return Err(io::Error::from(io::ErrorKind::ConnectionRefused));
        }
        self.sent.lock().unwrap().push(frame.to_vec());
        Ok(())
    }
    fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        let next = self.inbox.lock().unwrap().pop_front();
        match next {
            Some(f) => {
                let n = f.len().min(buf.len());
                buf[..n].copy_from_slice(&f[..n]);
                Ok(n)
            }
            None => {
                std::thread::sleep(Duration::from_millis(2));
                Err(io::Error::from(io::ErrorKind::WouldBlock))
            }
        }
    }
}

/// An activated NIC with a 16-entry RX ring and a 16-entry TX ring.
struct Dev {
    net: Net,
    rx: Ring,
    tx: Ring,
    mem: Arc<VecMemory>,
    backend: Arc<MockBackend>,
    irq: Arc<TestIrq>,
}

fn dev() -> Dev {
    let mem = mem();
    let rx = Ring::new(mem.clone(), 16);
    let tx = Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    let irq = Arc::new(TestIrq::new());
    let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
    let backend = Arc::new(MockBackend::default());
    let mut net = Net::new(MAC, backend.clone());
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    net.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
    Dev {
        net,
        rx,
        tx,
        mem,
        backend,
        irq,
    }
}

/// A recognisable frame of `len` bytes: broadcast destination, our source, IPv4 type, payload.
fn frame(len: usize, seed: u8) -> Vec<u8> {
    let mut f = vec![0u8; len];
    for (i, b) in f.iter_mut().enumerate() {
        *b = (i as u8).wrapping_mul(31).wrapping_add(seed);
    }
    if len >= 14 {
        f[..6].copy_from_slice(&[0xff; 6]);
        f[6..12].copy_from_slice(&MAC);
        f[12..14].copy_from_slice(&[0x08, 0x00]);
    }
    f
}

/// A TX packet: a header with `flags`/`gso_type`, then `body`.
fn tx_packet(flags: u8, gso_type: u8, body: &[u8]) -> Vec<u8> {
    let mut p = vec![0u8; HDR_LEN];
    p[0] = flags;
    p[1] = gso_type;
    p.extend_from_slice(body);
    p
}

impl Dev {
    fn put(&self, addr: u64, bytes: &[u8]) {
        self.mem.write(GuestAddress(addr), bytes).unwrap();
    }
    fn get(&self, addr: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        self.mem.read(GuestAddress(addr), &mut b).unwrap();
        b
    }
    /// Post `pkt` as a one-descriptor TX chain at head 0 and process the TX queue.
    fn send_one(&mut self, pkt: &[u8]) -> Result<QueueProgress, VirtioError> {
        self.put(TX_BUF, pkt);
        self.tx.set_desc(0, d(TX_BUF, pkt.len() as u32, 0, 0));
        self.tx.push(0);
        self.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE)
    }
    /// Post one writable RX buffer of `len` bytes at head 0.
    fn post_rx(&mut self, len: u32) {
        self.rx.set_desc(0, d(RX_BUF, len, WRITE, 0));
        self.rx.push(0);
    }
    fn stats(&self) -> vmm::virtio::net::NetStats {
        self.net.stats()
    }
}

// ---- TX (NET-5) ----

/// 1. A TX chain longer than 12 + 1514 bytes is dropped, counted, returned with len 0, and
///    nothing reaches the wire. Not NEEDS_RESET.
#[test]
fn tx_chain_longer_than_a_frame_is_dropped() {
    let mut v = dev();
    let pkt = tx_packet(0, 0, &frame(1515, 1));
    assert_eq!(v.send_one(&pkt), Ok(QueueProgress::Drained));
    assert!(v.backend.sent.lock().unwrap().is_empty());
    assert_eq!(v.stats().tx_dropped, 1);
    assert_eq!(v.tx.used_idx(), 1);
    assert_eq!(v.tx.used_elem(0), (0, 0));
    // The same length split over two descriptors is still one over-long chain.
    v.put(TX_BUF, &pkt);
    v.tx.set_desc(1, d(TX_BUF, 1000, NEXT, 2));
    v.tx.set_desc(2, d(TX_BUF + 1000, pkt.len() as u32 - 1000, 0, 0));
    v.tx.push(1);
    assert_eq!(
        v.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE),
        Ok(QueueProgress::Drained)
    );
    assert_eq!(v.stats().tx_dropped, 2);
    assert!(v.backend.sent.lock().unwrap().is_empty());
}

/// 2. A TX chain shorter than the 12-byte header (and one with a header but a runt frame).
#[test]
fn tx_chain_shorter_than_the_header_is_dropped() {
    let mut v = dev();
    assert_eq!(v.send_one(&[0u8; 11]), Ok(QueueProgress::Drained));
    assert_eq!(
        v.send_one(&tx_packet(0, 0, &[0u8; 13])),
        Ok(QueueProgress::Drained)
    );
    assert!(v.backend.sent.lock().unwrap().is_empty());
    let s = v.stats();
    assert_eq!((s.tx_dropped, s.tx_packets), (2, 0));
    assert_eq!(v.tx.used_idx(), 2);
}

/// 3. A TX chain containing a device-writable descriptor is dropped and that buffer is never
///    written (access log).
#[test]
fn tx_chain_with_a_writable_descriptor_is_dropped_unwritten() {
    let mut v = dev();
    let pkt = tx_packet(0, 0, &frame(60, 3));
    v.put(TX_BUF, &pkt);
    v.tx.set_desc(0, d(TX_BUF, pkt.len() as u32, NEXT, 1));
    v.tx.set_desc(1, d(TX_BUF + 0x1000, 64, WRITE, 0));
    v.tx.push(0);
    v.mem.enable_log();
    assert_eq!(
        v.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE),
        Ok(QueueProgress::Drained)
    );
    let writes = v
        .mem
        .log()
        .iter()
        .filter(|a| a.write && a.addr >= TX_BUF + 0x1000 && a.addr < TX_BUF + 0x1040)
        .count();
    assert_eq!(writes, 0);
    assert!(v.backend.sent.lock().unwrap().is_empty());
    assert_eq!(v.stats().tx_dropped, 1);
    assert_eq!(v.tx.used_elem(0), (0, 0));
}

/// 4. A non-zero `gso_type` (an offload we never offered) is dropped.
#[test]
fn tx_nonzero_gso_type_is_dropped() {
    let mut v = dev();
    for gso in [1u8, 3, 4, 0x80, 0xff] {
        v.send_one(&tx_packet(0, gso, &frame(60, gso))).unwrap();
    }
    assert!(v.backend.sent.lock().unwrap().is_empty());
    assert_eq!(v.stats().tx_dropped, 5);
}

/// 5. Non-zero `flags` (NEEDS_CSUM, DATA_VALID, RSC_INFO) are dropped.
#[test]
fn tx_nonzero_flags_are_dropped() {
    let mut v = dev();
    for flags in [1u8, 2, 4, 0xff] {
        v.send_one(&tx_packet(flags, 0, &frame(60, flags))).unwrap();
    }
    assert!(v.backend.sent.lock().unwrap().is_empty());
    assert_eq!(v.stats().tx_dropped, 4);
    // ...and a clean header right after goes out: the device is not wedged.
    v.send_one(&tx_packet(0, 0, &frame(60, 9))).unwrap();
    assert_eq!(v.backend.sent.lock().unwrap().len(), 1);
}

/// 6. The header is copied out once and checked on the copy (MEM-7): every TX buffer is read
///    exactly once, and a header split from its frame over two descriptors is fine.
#[test]
fn tx_buffers_are_read_once_and_may_be_split() {
    let mut v = dev();
    let body = frame(100, 4);
    let pkt = tx_packet(0, 0, &body);
    v.put(TX_BUF, &pkt[..HDR_LEN]);
    v.put(TX_BUF + 0x800, &pkt[HDR_LEN..]);
    v.tx.set_desc(0, d(TX_BUF, HDR_LEN as u32, NEXT, 1));
    v.tx.set_desc(1, d(TX_BUF + 0x800, body.len() as u32, 0, 0));
    v.tx.push(0);
    v.mem.enable_log();
    v.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE).unwrap();
    let log = v.mem.log();
    assert_eq!(reads_of(&log, TX_BUF, HDR_LEN as u64), 1);
    assert_eq!(reads_of(&log, TX_BUF + 0x800, body.len() as u64), 1);
    assert_eq!(
        v.backend.sent.lock().unwrap().as_slice(),
        std::slice::from_ref(&body)
    );
    let s = v.stats();
    assert_eq!((s.tx_packets, s.tx_bytes), (1, 100));
}

/// 7. A backend `send` error is counted and never propagates: the chain is returned and the
///    device keeps working.
#[test]
fn backend_send_error_is_counted_not_propagated() {
    let mut v = dev();
    v.backend.fail_send.store(true, Ordering::SeqCst);
    assert_eq!(
        v.send_one(&tx_packet(0, 0, &frame(60, 5))),
        Ok(QueueProgress::Drained)
    );
    assert_eq!(v.stats().tx_dropped, 1);
    assert_eq!(v.tx.used_elem(0), (0, 0));
    v.backend.fail_send.store(false, Ordering::SeqCst);
    v.send_one(&tx_packet(0, 0, &frame(60, 6))).unwrap();
    assert_eq!(v.stats().tx_packets, 1);
}

// ---- RX (NET-5) ----

/// 8. An RX chain smaller than 12 + frame is returned with len 0, counted, and not written.
#[test]
fn rx_chain_smaller_than_header_plus_frame_is_returned_empty() {
    let mut v = dev();
    let f = frame(100, 7);
    v.post_rx((HDR_LEN + f.len() - 1) as u32);
    v.put(RX_BUF, &[0xee; 200]);
    assert_eq!(v.net.receive(&f), Ok(RxOutcome::ChainUnusable));
    assert_eq!(v.rx.used_elem(0), (0, 0));
    assert_eq!(v.get(RX_BUF, 200), vec![0xee; 200]);
    assert_eq!(v.stats().rx_dropped_small, 1);
    assert!(v.irq.level(), "the returned buffer is signalled");
}

/// 9. An RX chain with a readable descriptor is returned with len 0; the readable buffer is
///    never written.
#[test]
fn rx_chain_with_a_readable_descriptor_is_returned_empty() {
    let mut v = dev();
    v.rx.set_desc(0, d(RX_BUF, 64, NEXT, 1));
    v.rx.set_desc(1, d(RX_BUF + 0x1000, 2048, WRITE, 0));
    v.rx.push(0);
    v.mem.enable_log();
    assert_eq!(v.net.receive(&frame(60, 8)), Ok(RxOutcome::ChainUnusable));
    let writes = v
        .mem
        .log()
        .iter()
        .filter(|a| a.write && a.addr >= RX_BUF && a.addr < RX_BUF + 0x2000)
        .count();
    assert_eq!(writes, 0);
    assert_eq!(v.rx.used_elem(0), (0, 0));
    assert_eq!(v.stats().rx_dropped_small, 1);
}

/// 10. RX with no posted buffer: dropped, counted, nothing written, no interrupt.
#[test]
fn rx_without_a_posted_buffer_is_dropped() {
    let mut v = dev();
    v.mem.enable_log();
    assert_eq!(v.net.receive(&frame(60, 9)), Ok(RxOutcome::NoBuffer));
    assert!(v.mem.log().iter().all(|a| !a.write), "nothing written");
    assert_eq!(v.rx.used_idx(), 0);
    assert!(!v.irq.level());
    assert_eq!(v.stats().rx_dropped_no_buffer, 1);
}

/// 11. RX datagrams outside 14..=1514 bytes are dropped before any ring is touched.
#[test]
fn rx_datagrams_outside_14_to_1514_are_dropped() {
    let mut v = dev();
    v.post_rx(4096);
    for len in [0usize, 1, 13, 1515, 2048] {
        assert_eq!(
            v.net.receive(&frame(len, 1)),
            Ok(RxOutcome::BadLength),
            "{len}"
        );
    }
    assert_eq!(v.rx.used_idx(), 0, "the posted buffer is still available");
    assert_eq!(v.stats().rx_dropped_len, 5);
    assert_eq!(v.net.receive(&frame(14, 1)), Ok(RxOutcome::Delivered));
}

/// 12. A 1514-byte frame round-trips byte-exactly: guest A's TX → MockBackend → guest B's RX,
///     with `num_buffers = 1`, the rest of the header zero, and used len = 12 + 1514.
#[test]
fn a_full_size_frame_round_trips_byte_exactly() {
    let mut a = dev();
    let mut b = dev();
    let f = frame(1514, 42);
    a.send_one(&tx_packet(0, 0, &f)).unwrap();
    let wire = a.backend.sent.lock().unwrap().pop().unwrap();
    assert_eq!(wire, f);
    // B posts its buffer as two descriptors, header and data apart (any layout is legal).
    b.rx.set_desc(0, d(RX_BUF, HDR_LEN as u32, WRITE | NEXT, 1));
    b.rx.set_desc(1, d(RX_BUF + 0x1000, 1518, WRITE, 0));
    b.rx.push(0);
    assert_eq!(b.net.receive(&wire), Ok(RxOutcome::Delivered));
    let mut hdr = vec![0u8; HDR_LEN];
    hdr[10] = 1; // num_buffers = 1, little-endian
    assert_eq!(b.get(RX_BUF, HDR_LEN), hdr);
    assert_eq!(b.get(RX_BUF + 0x1000, 1514), f);
    assert_eq!(b.rx.used_elem(0), (0, (HDR_LEN + 1514) as u32));
    assert!(b.irq.level());
    let s = b.stats();
    assert_eq!((s.rx_packets, s.rx_bytes), (1, 1514));
}

/// 13. A hostile queue structure still gives NEEDS_RESET (the shared queue code): a TX
///     descriptor loop and an RX descriptor loop are `Err`, and through the worker path
///     `report_error` latches NEEDS_RESET.
#[test]
fn a_descriptor_loop_is_an_error_on_both_queues() {
    let mut v = dev();
    v.tx.set_desc(0, d(TX_BUF, 32, NEXT, 1));
    v.tx.set_desc(1, d(TX_BUF + 32, 32, NEXT, 0));
    v.tx.push(0);
    let e = v.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE).unwrap_err();
    assert!(
        matches!(e, VirtioError::Queue(QueueError::ChainTooLong { .. })),
        "{e:?}"
    );
    assert!(v.backend.sent.lock().unwrap().is_empty());
    v.rx.set_desc(0, d(RX_BUF, 32, WRITE | NEXT, 0));
    v.rx.push(0);
    let e = v.net.receive(&frame(60, 1)).unwrap_err();
    assert!(
        matches!(e, VirtioError::Queue(QueueError::ChainTooLong { .. })),
        "{e:?}"
    );
    let vi = VirtioInterrupt::new(Arc::new(TestIrq::new()));
    vmm::virtio::mmio::report_error(&vi, RX_QUEUE, &e);
    assert!(vi.needs_reset());
    // An avail.idx jump on TX is refused the same way.
    let mut w = dev();
    w.tx.set_avail_idx(17);
    assert!(matches!(
        w.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE),
        Err(VirtioError::Queue(QueueError::AvailIdxJump { .. }))
    ));
}

/// 14. The MAC config space reads at every width and offset inside it; writes are ignored
///     (VQ-13); accesses beyond 6 bytes are RAZ through the transport. Features are exactly
///     VERSION_1 | MAC.
#[test]
fn mac_config_reads_at_every_width_and_ignores_writes() {
    let mem = mem();
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let backend: Arc<dyn NetBackend> = Arc::new(MockBackend::default());
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Net::new(MAC, backend)));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    let mut t = VirtioMmio::new(device.clone(), vi, Some(gm)).unwrap();
    assert_eq!(
        t.read(reg::DEVICE_ID, AccessSize::B4),
        u64::from(DEVICE_ID_NET)
    );
    {
        let dev = device.lock().unwrap();
        assert_eq!(dev.device_features(), features::VERSION_1 | F_MAC);
        assert_eq!(dev.config_len(), NET_CONFIG_LEN);
        assert_eq!(dev.queue_max_sizes(), &[NET_QUEUE_SIZE, NET_QUEUE_SIZE]);
    }
    let le = |off: usize, n: usize| -> u64 {
        let mut b = [0u8; 8];
        b[..n].copy_from_slice(&MAC[off..off + n]);
        u64::from_le_bytes(b)
    };
    for off in 0..6usize {
        assert_eq!(t.read(reg::CONFIG + off as u64, AccessSize::B1), le(off, 1));
    }
    for off in [0usize, 2, 4] {
        assert_eq!(t.read(reg::CONFIG + off as u64, AccessSize::B2), le(off, 2));
    }
    for off in [0usize, 2] {
        assert_eq!(t.read(reg::CONFIG + off as u64, AccessSize::B4), le(off, 4));
    }
    // Beyond the 6-byte space: RAZ (the transport's VQ-13 bound).
    assert_eq!(t.read(reg::CONFIG + 6, AccessSize::B1), 0);
    assert_eq!(t.read(reg::CONFIG + 4, AccessSize::B4), 0);
    // Writes at every width change nothing.
    t.write(reg::CONFIG, AccessSize::B4, 0xdead_beef);
    t.write(reg::CONFIG + 4, AccessSize::B2, 0xffff);
    t.write(reg::CONFIG + 5, AccessSize::B1, 0x00);
    for off in 0..6usize {
        assert_eq!(t.read(reg::CONFIG + off as u64, AccessSize::B1), le(off, 1));
    }
}

/// 15. Before activation and after reset nothing is delivered (and nothing panics); a notify
///     on the RX queue is a no-op; an unknown queue index is refused.
#[test]
fn inactive_device_drops_and_rx_notify_is_a_noop() {
    let backend = Arc::new(MockBackend::default());
    let mut net = Net::new(MAC, backend);
    assert_eq!(net.receive(&frame(60, 1)), Ok(RxOutcome::NoBuffer));
    assert_eq!(
        net.process_queue(TX_QUEUE, 16),
        Err(VirtioError::NotActivated)
    );
    let mut v = dev();
    assert_eq!(
        v.net.process_queue(RX_QUEUE, 16),
        Ok(QueueProgress::Drained)
    );
    assert!(matches!(
        v.net.process_queue(2, 16),
        Err(VirtioError::NoSuchQueue(2))
    ));
    v.net.reset();
    v.post_rx(2048);
    assert_eq!(v.net.receive(&frame(60, 1)), Ok(RxOutcome::NoBuffer));
    assert_eq!(
        v.rx.used_idx(),
        0,
        "the old ring is not touched after reset"
    );
}

/// 16. The TX budget (VQ-12): at most `budget` chains per call, then `MoreWork`.
#[test]
fn tx_respects_the_worker_budget() {
    let mut v = dev();
    let pkt = tx_packet(0, 0, &frame(60, 2));
    v.put(TX_BUF, &pkt);
    for i in 0..10u16 {
        v.tx.set_desc(i, d(TX_BUF, pkt.len() as u32, 0, 0));
        v.tx.push(i);
    }
    assert_eq!(
        v.net.process_queue(TX_QUEUE, 4),
        Ok(QueueProgress::MoreWork)
    );
    assert_eq!(v.backend.sent.lock().unwrap().len(), 4);
    assert_eq!(
        v.net.process_queue(TX_QUEUE, 16),
        Ok(QueueProgress::Drained)
    );
    assert_eq!(v.backend.sent.lock().unwrap().len(), 10);
}

/// 17. The RX thread: frames from the backend land in posted buffers; a hostile RX ring latches
///     NEEDS_RESET; the stats line carries the counters; `stop` joins within the recv timeout.
#[test]
fn rx_thread_delivers_reports_and_stops() {
    let mem = mem();
    let rx = Ring::new(mem.clone(), 16);
    let tx = Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    let irq = Arc::new(TestIrq::new());
    let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
    let backend = Arc::new(MockBackend::default());
    let net = Arc::new(Mutex::new(Net::new(MAC, backend.clone())));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    net.lock()
        .unwrap()
        .activate(gm, vec![rx.queue(), tx.queue()], vi.clone())
        .unwrap();
    let ctl = Arc::new(VmControl::new());
    let thread = spawn_rx(
        "net-rx-test",
        "net0 slot 0",
        net.clone(),
        vi.clone(),
        ctl.clone(),
    )
    .unwrap();
    let mut rx = rx;
    rx.set_desc(0, d(RX_BUF, 2048, WRITE, 0));
    rx.push(0);
    let f = frame(1000, 77);
    backend.inbox.lock().unwrap().push_back(f.clone());
    let t0 = Instant::now();
    while rx.used_idx() == 0 && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(rx.used_elem(0), (0, (HDR_LEN + 1000) as u32));
    let mut got = vec![0u8; 1000];
    mem.read(GuestAddress(RX_BUF + HDR_LEN as u64), &mut got)
        .unwrap();
    assert_eq!(got, f);
    // A looping RX chain: the thread reports it as NEEDS_RESET (VQ-10) and keeps running.
    rx.set_desc(1, d(RX_BUF, 32, WRITE | NEXT, 1));
    rx.push(1);
    backend.inbox.lock().unwrap().push_back(frame(60, 1));
    let t0 = Instant::now();
    while !vi.needs_reset() && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(vi.needs_reset());
    let line = Companion::stats(&thread).unwrap();
    assert!(line.starts_with("net0 slot 0: tx_packets=0"), "{line}");
    assert!(line.contains("rx_packets=1 rx_bytes=1000"), "{line}");
    assert!(line.contains("rx_dropped_foreign=0"), "{line}");
    let t0 = Instant::now();
    assert!(!Companion::stop(&thread), "no panic");
    assert!(
        t0.elapsed() < Duration::from_millis(500),
        "{:?}",
        t0.elapsed()
    );
    assert!(!Companion::stop(&thread), "idempotent");
    assert!(!ctl.is_stopping());
}

/// 18. Property test (PLAN §0.3 xorshift, `MACVMM_SEED`; the stand-in for the `net` fuzz
///     target until `crates/fuzz` exists, M22): random TX chains (random lengths, flags,
///     headers, descriptor splits, writable descriptors, out-of-RAM addresses) and random RX
///     frames against random RX chains. The device never panics; every frame on the wire is
///     14..=1514 bytes and came from a clean header; every used `len` is 0 or exactly 12 +
///     the frame; a structural error is the only `Err`.
#[test]
fn random_chains_and_frames_keep_the_caps() {
    let seed = seed(0x6e65_7476_6972_7431);
    say(&format!(
        "virtio_net_hostile property seed {seed} (MACVMM_SEED)"
    ));
    let mut r = XorShift::new(seed);
    for iter in 0..10_000u32 {
        let mut v = dev();
        v.mem.write(GuestAddress(TX_BUF), &[0u8; 4096]).unwrap();
        // --- TX: a 1..=3 descriptor chain over random lengths and flags ---
        let ndesc = 1 + r.below(3) as u16;
        let mut expect_clean = true;
        let mut total = 0u64;
        let mut first_len = 0u32;
        for i in 0..ndesc {
            let len = match r.below(4) {
                0 => r.below(16) as u32,
                1 => 12 + r.below(1600) as u32,
                _ => 1 + r.below(800) as u32,
            };
            let addr = if r.below(50) == 0 {
                RAM_END - u64::from(len / 2) // straddles the end of RAM
            } else {
                TX_BUF + 0x700 * u64::from(i)
            };
            let write = r.below(20) == 0;
            let flags = if i + 1 < ndesc { NEXT } else { 0 } | if write { WRITE } else { 0 };
            v.tx.set_desc(i, d(addr, len, flags, i + 1));
            expect_clean &= !write;
            total += u64::from(len);
            if i == 0 {
                first_len = len;
            }
        }
        // A random flags/gso_type pair, when both bytes sit in the first descriptor.
        if first_len >= 2 && r.below(4) == 0 {
            v.put(TX_BUF, &[r.below(256) as u8, r.below(256) as u8]);
        }
        v.tx.push(0);
        let res = v.net.process_queue(TX_QUEUE, NET_QUEUE_SIZE);
        let sent = v.backend.sent.lock().unwrap().clone();
        match res {
            Ok(_) => {
                assert!(sent.len() <= 1, "iter {iter}");
                if let Some(f) = sent.first() {
                    assert!((14..=1514).contains(&f.len()), "iter {iter}: {}", f.len());
                    assert!(expect_clean && (26..=1526).contains(&total), "iter {iter}");
                    if first_len >= 2 {
                        assert_eq!(v.get(TX_BUF, 2), vec![0, 0], "iter {iter}: clean header");
                    }
                }
                assert_eq!(v.tx.used_elem(0).1, 0, "iter {iter}: TX used len is 0");
            }
            Err(VirtioError::Queue(_)) => assert!(sent.is_empty(), "iter {iter}"),
            Err(e) => panic!("iter {iter}: unexpected {e:?}"),
        }
        // --- RX: a random frame into a random chain ---
        let flen = match r.below(5) {
            0 => r.below(20) as usize,
            1 => 1500 + r.below(100) as usize,
            _ => 14 + r.below(1501) as usize,
        };
        let cap = 1 + r.below(1700) as u32;
        let readable = r.below(10) == 0;
        v.rx.set_desc(0, d(RX_BUF, cap, if readable { 0 } else { WRITE }, 0));
        if r.below(3) != 0 {
            v.rx.push(0);
        }
        let posted = v.rx.avail_idx == 1;
        let out = v.net.receive(&frame(flen, iter as u8)).unwrap();
        let fits = !readable && u64::from(cap) >= (12 + flen) as u64;
        let want = if !(14..=1514).contains(&flen) {
            RxOutcome::BadLength
        } else if !posted {
            RxOutcome::NoBuffer
        } else if fits {
            RxOutcome::Delivered
        } else {
            RxOutcome::ChainUnusable
        };
        assert_eq!(
            out, want,
            "iter {iter}: flen {flen} cap {cap} readable {readable}"
        );
        if out == RxOutcome::Delivered {
            assert_eq!(v.rx.used_elem(0), (0, (12 + flen) as u32), "iter {iter}");
        } else if out == RxOutcome::ChainUnusable {
            assert_eq!(v.rx.used_elem(0), (0, 0), "iter {iter}");
        }
    }
}
