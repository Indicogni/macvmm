//! PLAN M13 acceptance (host): the virtio-console device model (virtio 1.2 §5.3; architecture
//! §11.3, §14.4; threat model TTY-1, TTY-10, VQ-8, VQ-9, VQ-10, VQ-11, SINK-1, LOG-4).
//!
//! Two levels, as for virtio-rng: the device driven directly (`activate` + `process_queue`,
//! as the worker calls it), and the whole guest-visible path (the virtio-mmio transport, a
//! QueueNotify, the worker thread, the input queue's hook), with `VecMemory` as guest RAM.
//!
//! - **TX** (transmitq, queue 1): the exact bytes reach the sink, through the sink's own
//!   `AnsiFilter` (`console_tx_filtered`: OSC 52 and DSR never reach it); the chain comes back
//!   with `len = 0` and its writable descriptors are never written (access log); > 64 KiB is
//!   NEEDS_RESET (VQ-8).
//! - **RX** (receiveq, queue 0): with no buffers posted the input is held, bounded at 4 KiB
//!   (TTY-10), and no chain is popped while there is nothing to deliver; with buffers, the used
//!   `len` is exactly the bytes delivered (VQ-9), and readable descriptors are never touched.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::io::{self, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SERIAL_INPUT_CAP, SINK_QUEUE_CAP, SerialInput, Sink, SinkHandle};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::control::VmControl;
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::memory::{MemoryError, VecMemory};
use vmm::virtio::console::{
    CONSOLE_CONFIG_LEN, CONSOLE_MAX_TOTAL, CONSOLE_QUEUE_SIZE, RX_QUEUE, TX_QUEUE,
};
use vmm::virtio::mmio::reg;
use vmm::virtio::{
    Console, DEVICE_ID_CONSOLE, QueueError, QueueProgress, VirtioDevice, VirtioError,
    VirtioInterrupt, VirtioMmio, Worker, features, status as st,
};

/// The transmitq's ring sits after the receiveq's (each fits N = 64 in 0x400 / 0x200 / 0x400).
const TX_DESC: u64 = RAM + 0x2000;
const TX_AVAIL: u64 = RAM + 0x6000;
const TX_USED: u64 = RAM + 0x7000;
/// TX buffers live far from the RX ones.
const TX_BUF: u64 = RAM + 0x4_0000;

/// A `Write` that records what the sink wrote.
#[derive(Clone, Default)]
struct Probe(Arc<Mutex<Vec<u8>>>);

impl Write for Probe {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Probe {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().unwrap().clone()
    }
}

/// An in-memory sink (writes on the caller's thread) with `policy`.
fn sink(policy: FilterPolicy) -> (SinkHandle, Probe) {
    let p = Probe::default();
    (Arc::new(Sink::new("test", Box::new(p.clone()), policy)), p)
}

/// An activated console: rx on the default ring placement, tx on the `TX_*` one.
struct Dev {
    con: Console,
    rx: Ring,
    tx: Ring,
    mem: Arc<VecMemory>,
    irq: Arc<TestIrq>,
    vi: Arc<VirtioInterrupt>,
    out: Probe,
    input: Arc<SerialInput>,
}

fn dev_with(policy: FilterPolicy, size: u16) -> Dev {
    let mem = mem();
    let rx = Ring::new(mem.clone(), size);
    let tx = Ring::at(mem.clone(), size, TX_DESC, TX_AVAIL, TX_USED);
    let irq = Arc::new(TestIrq::new());
    let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
    let (s, out) = sink(policy);
    let input = Arc::new(SerialInput::console());
    let mut con = Console::new(s, Some(input.clone()));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    con.activate(gm, vec![rx.queue(), tx.queue()], vi.clone())
        .unwrap();
    Dev {
        con,
        rx,
        tx,
        mem,
        irq,
        vi,
        out,
        input,
    }
}

fn dev() -> Dev {
    dev_with(FilterPolicy::Safe, 16)
}

impl Dev {
    fn run_tx(&mut self) -> Result<QueueProgress, VirtioError> {
        self.con.process_queue(TX_QUEUE, CONSOLE_QUEUE_SIZE)
    }
    fn run_rx(&mut self) -> Result<QueueProgress, VirtioError> {
        self.con.process_queue(RX_QUEUE, CONSOLE_QUEUE_SIZE)
    }
    fn put(&self, addr: u64, bytes: &[u8]) {
        self.mem.write(GuestAddress(addr), bytes).unwrap();
    }
    fn bytes(&self, addr: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        self.mem.read(GuestAddress(addr), &mut b).unwrap();
        b
    }
    /// One single-descriptor TX chain carrying `bytes`, in descriptor `i`.
    fn send(&mut self, i: u16, at: u64, bytes: &[u8]) {
        self.put(at, bytes);
        self.tx.set_desc(i, desc(at, bytes.len() as u32, 0, 0));
        self.tx.push(i);
    }
}

/// Writes in the access log that touch `[addr, addr + len)`.
fn writes_into(mem: &VecMemory, addr: u64, len: u64) -> usize {
    mem.log()
        .iter()
        .filter(|a| a.write && !a.fence && a.addr < addr + len && addr < a.addr + a.len)
        .count()
}

/// Reads or writes in the access log that touch `[addr, addr + len)`.
fn touches(mem: &VecMemory, addr: u64, len: u64) -> usize {
    mem.log()
        .iter()
        .filter(|a| !a.fence && a.addr < addr + len && addr < a.addr + a.len)
        .count()
}

#[test]
fn identity_two_queues_version_1_zero_config() {
    let (s, _) = sink(FilterPolicy::Safe);
    let mut c = Console::new(s, None);
    assert_eq!(c.device_id(), DEVICE_ID_CONSOLE);
    assert_eq!(c.queue_max_sizes(), &[64, 64]);
    assert_eq!(
        c.device_features(),
        features::VERSION_1,
        "no SIZE/MULTIPORT"
    );
    assert_eq!(c.config_len(), CONSOLE_CONFIG_LEN);
    let mut cfg = [0xffu8; 12];
    c.read_config(0, &mut cfg);
    assert_eq!(cfg, [0u8; 12]);
    c.write_config(8, &[1, 2, 3, 4]); // emerg_wr without F_EMERG_WRITE: ignored (VQ-13)
    c.read_config(0, &mut cfg);
    assert_eq!(cfg, [0u8; 12]);
    assert_eq!(c.process_queue(TX_QUEUE, 8), Err(VirtioError::NotActivated));
    assert_eq!(c.process_queue(RX_QUEUE, 8), Err(VirtioError::NotActivated));
}

/// PLAN M13 host acceptance: TX writes the exact bytes to the sink, in order, across
/// descriptors and chains; the chain is returned with len 0 and nothing is written into it.
#[test]
fn tx_writes_the_exact_bytes_to_the_sink() {
    let mut d = dev();
    d.send(0, TX_BUF, b"hello, ");
    // A two-descriptor chain, plus a writable descriptor the device must ignore.
    d.put(TX_BUF + 0x100, b"virtio");
    d.put(TX_BUF + 0x200, b"-console\n");
    d.tx.set_desc(1, desc(TX_BUF + 0x100, 6, NEXT, 2));
    d.tx.set_desc(2, desc(TX_BUF + 0x200, 9, NEXT, 3));
    d.tx.set_desc(3, desc(TX_BUF + 0x300, 32, WRITE, 0));
    d.tx.push(1);
    d.mem.enable_log();
    assert_eq!(d.run_tx(), Ok(QueueProgress::Drained));
    assert_eq!(d.out.bytes(), b"hello, virtio-console\n");
    assert_eq!(d.tx.used_idx(), 2);
    assert_eq!(d.tx.used_elem(0), (0, 0), "VQ-9: nothing written");
    assert_eq!(d.tx.used_elem(1), (1, 0));
    assert_eq!(
        writes_into(&d.mem, TX_BUF + 0x300, 32),
        0,
        "the writable descriptor of a TX chain is never written"
    );
    assert_eq!(d.con.transferred(), (22, 0));
    assert!(d.irq.level());
    assert_eq!(d.vi.status(), 1);
}

/// Every byte value that the `safe` filter passes unchanged comes out byte-exact (TTY-2: the
/// `linux_console_tx` stream is plain text), even split at odd descriptor boundaries.
#[test]
fn tx_plain_text_is_byte_exact_under_safe() {
    let mut d = dev();
    let text: Vec<u8> = b"macvmm\n".iter().copied().cycle().take(65536).collect();
    let mut rng = XorShift::new(seed(13));
    let mut at = 0usize;
    let mut i = 0u16;
    while at < text.len() {
        let n = (1 + rng.below(8000) as usize).min(text.len() - at);
        d.send(
            i % 16,
            TX_BUF + (u64::from(i % 16) * 0x2000),
            &text[at..at + n],
        );
        d.run_tx().unwrap();
        at += n;
        i += 1;
    }
    assert_eq!(d.out.bytes(), text);
}

/// Security test `console_tx_filtered` (TTY-1): OSC 52 (clipboard write) and DSR (a query
/// whose answer would be typed into the guest) never reach the sink; the text around them does.
#[test]
fn console_tx_filtered() {
    let mut d = dev();
    let attack = b"ok \x1b]52;c;bWFjdm1tLXBvd25lZA==\x07 \x1b[6n \x1b[c done\n";
    d.send(0, TX_BUF, attack);
    d.run_tx().unwrap();
    let out = d.out.bytes();
    assert!(
        !out.windows(2).any(|w| w == b"\x1b]"),
        "OSC reached the sink: {out:?}"
    );
    assert!(!out.windows(4).any(|w| w == b"\x1b[6n"), "DSR: {out:?}");
    assert!(!out.windows(3).any(|w| w == b"\x1b[c"), "DA: {out:?}");
    assert!(
        !out.windows(8).any(|w| w == b"bWFjdm1t"),
        "OSC payload: {out:?}"
    );
    let text = String::from_utf8_lossy(&out);
    assert!(
        text.starts_with("ok ") && text.ends_with(" done\n"),
        "{text:?}"
    );
    // `strict` shows controls visibly instead; still no ESC byte.
    let mut d = dev_with(FilterPolicy::Strict, 16);
    d.send(0, TX_BUF, attack);
    d.run_tx().unwrap();
    assert!(!d.out.bytes().contains(&0x1b));
}

/// The filter keeps its state across chains: an escape sequence split over two chains (the
/// guest controls the split) is still recognised and dropped.
#[test]
fn tx_filter_state_spans_chains() {
    let mut d = dev();
    d.send(0, TX_BUF, b"a\x1b]52;c;");
    d.send(1, TX_BUF + 0x100, b"QUFBQQ==\x07b");
    d.run_tx().unwrap();
    assert_eq!(d.out.bytes(), b"ab");
}

/// Security test: a TX chain over 64 KiB is NEEDS_RESET (VQ-8); nothing reaches the sink.
#[test]
fn tx_chain_over_64_kib_is_refused() {
    let mut d = dev();
    d.tx.set_desc(0, desc(TX_BUF, 65536, NEXT, 1));
    d.tx.set_desc(1, desc(TX_BUF + 65536, 1, 0, 0));
    d.tx.push(0);
    let e = d.run_tx().unwrap_err();
    assert!(
        matches!(
            e,
            VirtioError::Queue(QueueError::TooLarge { max: 65536, .. })
        ),
        "{e:?}"
    );
    assert!(d.out.bytes().is_empty());
    assert_eq!(d.tx.used_idx(), 0);
    // Exactly 64 KiB is fine.
    let mut d = dev();
    d.put(TX_BUF, &vec![b'x'; 65536]);
    d.tx.set_desc(0, desc(TX_BUF, CONSOLE_MAX_TOTAL as u32, 0, 0));
    d.tx.push(0);
    d.run_tx().unwrap();
    assert_eq!(d.out.bytes().len(), 65536);
}

/// PLAN M13 host acceptance: RX with no buffers posted holds the input; security test: at
/// most 4 KiB of it (TTY-10), the rest dropped and counted.
#[test]
fn rx_without_buffers_holds_the_input_bounded() {
    let mut d = dev();
    assert_eq!(d.input.push(b"typed"), 5);
    assert_eq!(d.run_rx(), Ok(QueueProgress::Drained));
    assert_eq!(d.input.len(), 5, "held, not lost");
    assert_eq!(d.rx.used_idx(), 0);
    assert!(!d.irq.level());
    assert_eq!(d.input.push(&[b'a'; 8192]), SERIAL_INPUT_CAP - 5);
    assert_eq!(d.input.len(), SERIAL_INPUT_CAP);
    assert_eq!(d.input.dropped(), 8192 - (SERIAL_INPUT_CAP as u64 - 5));
    d.run_rx().unwrap();
    assert_eq!(d.input.len(), SERIAL_INPUT_CAP, "still at most 4 KiB");
}

/// With no input, a posted RX buffer is not popped (so the driver never gets an empty one
/// back, and its avail entry is not even read).
#[test]
fn rx_without_input_pops_nothing() {
    let mut d = dev();
    d.rx.set_desc(0, desc(BUF, 64, WRITE, 0));
    d.rx.push(0);
    d.mem.enable_log();
    assert_eq!(d.run_rx(), Ok(QueueProgress::Drained));
    assert_eq!(d.rx.used_idx(), 0);
    assert_eq!(touches(&d.mem, DESC, 16), 0, "the descriptor was not read");
    // Input arrives: the same buffer is used.
    d.input.push(b"hi\n");
    d.run_rx().unwrap();
    assert_eq!(d.rx.used_idx(), 1);
    assert_eq!(d.rx.used_elem(0), (0, 3));
    assert_eq!(d.bytes(BUF, 3), b"hi\n");
    assert!(d.irq.level());
}

/// RX fills buffers in order, reports exactly the bytes written (VQ-9), and leaves what does
/// not fit for the next buffer; readable descriptors on the receiveq are never touched.
#[test]
fn rx_delivers_in_order_with_exact_lengths() {
    let mut d = dev();
    d.put(BUF + 0x800, &[0x77; 16]);
    d.rx.set_desc(0, desc(BUF + 0x800, 16, NEXT, 1)); // readable: meaningless here
    d.rx.set_desc(1, desc(BUF, 4, WRITE | NEXT, 2));
    d.rx.set_desc(2, desc(BUF + 0x100, 3, WRITE, 0));
    d.rx.set_desc(3, desc(BUF + 0x200, 64, WRITE, 0));
    d.rx.push(0);
    d.rx.push(3);
    d.input.push(b"0123456789");
    d.mem.enable_log();
    d.run_rx().unwrap();
    assert_eq!(d.rx.used_idx(), 2);
    assert_eq!(d.rx.used_elem(0), (0, 7));
    assert_eq!(d.bytes(BUF, 4), b"0123");
    assert_eq!(d.bytes(BUF + 0x100, 3), b"456");
    assert_eq!(d.rx.used_elem(1), (3, 3));
    assert_eq!(d.bytes(BUF + 0x200, 3), b"789");
    assert_eq!(
        d.bytes(BUF + 0x203, 4),
        [0, 0, 0, 0],
        "nothing past len is written"
    );
    assert_eq!(
        touches(&d.mem, BUF + 0x800, 16),
        0,
        "readable never touched"
    );
    assert_eq!(d.input.len(), 0);
    assert_eq!(d.con.transferred(), (0, 10));
}

/// Input larger than the posted buffers: the rest waits for the next buffer.
#[test]
fn rx_leftover_waits_for_the_next_buffer() {
    let mut d = dev();
    d.rx.set_desc(0, desc(BUF, 2, WRITE, 0));
    d.rx.push(0);
    d.input.push(b"abcde");
    d.run_rx().unwrap();
    assert_eq!(d.rx.used_elem(0), (0, 2));
    assert_eq!(d.input.len(), 3);
    d.rx.set_desc(1, desc(BUF + 0x100, 16, WRITE, 0));
    d.rx.push(1);
    d.run_rx().unwrap();
    assert_eq!(d.rx.used_elem(1), (1, 3));
    assert_eq!(d.bytes(BUF + 0x100, 3), b"cde");
}

/// Without stdin bound to it, the console never receives and pops nothing.
#[test]
fn rx_unbound_console_never_receives() {
    let mem = mem();
    let rx = Ring::new(mem.clone(), 16);
    let tx = Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let (s, _) = sink(FilterPolicy::Safe);
    let mut c = Console::new(s, None);
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    c.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
    rx.set_desc(0, desc(BUF, 8, WRITE, 0));
    let mut rx = rx;
    rx.push(0);
    assert_eq!(c.process_queue(RX_QUEUE, 64), Ok(QueueProgress::Drained));
    assert_eq!(rx.used_idx(), 0);
    assert_eq!(c.process_queue(2, 64), Err(VirtioError::NoSuchQueue(2)));
}

/// Security test: hostile chains on either queue are errors (→ NEEDS_RESET), never panics,
/// and nothing is returned or written to the sink.
#[test]
fn hostile_chains_are_errors_never_panics() {
    type Setup = fn(&mut Ring);
    let cases: &[(&str, Setup)] = &[
        ("self loop", |r| r.set_desc(0, desc(BUF, 8, NEXT, 0))),
        ("2-cycle", |r| {
            r.set_desc(0, desc(BUF, 8, NEXT, 1));
            r.set_desc(1, desc(BUF + 8, 8, NEXT, 0));
        }),
        ("next out of range", |r| {
            r.set_desc(0, desc(BUF, 8, NEXT, 999))
        }),
        ("zero length", |r| r.set_desc(0, desc(BUF, 0, 0, 0))),
        ("buffer in MMIO", |r| {
            r.set_desc(0, desc(MMIO_ADDR, 32, 0, 0))
        }),
        ("straddles the end of RAM", |r| {
            r.set_desc(0, desc(RAM_END - 16, 32, 0, 0))
        }),
        ("addr + len overflows", |r| {
            r.set_desc(0, desc(u64::MAX - 8, u32::MAX, 0, 0))
        }),
        ("indirect, not negotiated", |r| {
            r.set_desc(0, desc(BUF, 16, INDIRECT, 0))
        }),
        ("readable after writable", |r| {
            r.set_desc(0, desc(BUF, 8, WRITE | NEXT, 1));
            r.set_desc(1, desc(BUF + 8, 8, 0, 0));
        }),
        ("len = u32::MAX", |r| {
            r.set_desc(0, desc(BUF, u32::MAX, WRITE, 0))
        }),
        ("writable over 64 KiB", |r| {
            r.set_desc(0, desc(BUF, 65536, WRITE | NEXT, 1));
            r.set_desc(1, desc(BUF + 65536, 1, WRITE, 0));
        }),
    ];
    for (name, setup) in cases {
        for queue in [TX_QUEUE, RX_QUEUE] {
            let mut d = dev();
            d.input.push(b"x"); // so the receiveq pops
            let ring = if queue == TX_QUEUE {
                &mut d.tx
            } else {
                &mut d.rx
            };
            setup(ring);
            ring.push(0);
            let r = d.con.process_queue(queue, 64);
            assert!(r.is_err(), "{name} on queue {queue}: {r:?}");
            assert_eq!(d.tx.used_idx(), 0, "{name}");
            assert_eq!(d.rx.used_idx(), 0, "{name}");
            assert!(d.out.bytes().is_empty(), "{name}");
        }
    }
}

#[test]
fn budget_is_clamped_and_more_work_is_reported() {
    let mut d = dev_with(FilterPolicy::Safe, 8);
    for i in 0..8u16 {
        d.send(i, TX_BUF + 0x100 * u64::from(i), b"z");
    }
    assert_eq!(
        d.con.process_queue(TX_QUEUE, 3),
        Ok(QueueProgress::MoreWork)
    );
    assert_eq!(d.tx.used_idx(), 3);
    assert_eq!(
        d.con.process_queue(TX_QUEUE, u16::MAX),
        Ok(QueueProgress::Drained)
    );
    assert_eq!(d.out.bytes(), b"zzzzzzzz");
    // RX: 8 one-byte buffers, 8 bytes of input, budget 3.
    for i in 0..8u16 {
        d.rx.set_desc(i, desc(BUF + 0x10 * u64::from(i), 1, WRITE, 0));
        d.rx.push(i);
    }
    d.input.push(b"12345678");
    assert_eq!(
        d.con.process_queue(RX_QUEUE, 3),
        Ok(QueueProgress::MoreWork)
    );
    assert_eq!(d.rx.used_idx(), 3);
    assert_eq!(
        d.con.process_queue(RX_QUEUE, 64),
        Ok(QueueProgress::Drained)
    );
    assert_eq!(d.rx.used_idx(), 8);
    assert_eq!(d.input.len(), 0);
}

#[test]
fn reset_drops_the_queues_but_keeps_the_input() {
    let mut d = dev();
    d.input.push(b"kept");
    d.con.reset();
    d.rx.set_desc(0, desc(BUF, 8, WRITE, 0));
    d.rx.push(0);
    assert_eq!(d.run_rx(), Err(VirtioError::NotActivated));
    assert_eq!(d.run_tx(), Err(VirtioError::NotActivated));
    assert_eq!(d.rx.used_idx(), 0);
    assert_eq!(d.input.len(), 4);
}

// ---- the whole guest-visible path: transport + worker + input hook ----

struct Guest {
    t: VirtioMmio,
    rx: Ring,
    tx: Ring,
    mem: Arc<VecMemory>,
    irq: Arc<TestIrq>,
    worker: Arc<Worker>,
    ctl: Arc<VmControl>,
    out: Probe,
    input: Arc<SerialInput>,
}

impl Guest {
    fn new() -> Guest {
        let mem = mem();
        let irq = Arc::new(TestIrq::new());
        let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
        let (s, out) = sink(FilterPolicy::Safe);
        let input = Arc::new(SerialInput::console());
        let device: Arc<Mutex<dyn VirtioDevice>> =
            Arc::new(Mutex::new(Console::new(s, Some(input.clone()))));
        let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
        let mut t = VirtioMmio::new(device.clone(), vi.clone(), Some(gm)).unwrap();
        let ctl = Arc::new(VmControl::new());
        let worker =
            Worker::spawn("virtio-console-test", device, vi, vec![64, 64], ctl.clone()).unwrap();
        let n: Arc<dyn vmm::virtio::QueueNotifier> = worker.clone();
        t.set_notifier(Some(n));
        // What `machine::virt::connect_console_input` installs.
        let weak = Arc::downgrade(&worker);
        input.set_hook(Some(Arc::new(move || {
            if let Some(w) = weak.upgrade() {
                w.notify(RX_QUEUE);
            }
        })));
        Guest {
            t,
            rx: Ring::new(mem.clone(), 16),
            tx: Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED),
            mem,
            irq,
            worker,
            ctl,
            out,
            input,
        }
    }
    fn r(&mut self, off: u64) -> u32 {
        self.t.read(off, AccessSize::B4) as u32
    }
    fn w(&mut self, off: u64, v: u32) {
        self.t.write(off, AccessSize::B4, u64::from(v));
    }
    /// The §3.1.1 handshake with both queues; returns Status.
    fn up(&mut self) -> u32 {
        self.w(reg::STATUS, 0);
        self.w(reg::STATUS, st::ACKNOWLEDGE);
        self.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER);
        self.w(reg::DRIVER_FEATURES_SEL, 1);
        self.w(reg::DRIVER_FEATURES, 1); // VERSION_1
        self.w(reg::STATUS, 11);
        let rings = [
            (self.rx.size, self.rx.desc, self.rx.avail, self.rx.used),
            (self.tx.size, self.tx.desc, self.tx.avail, self.tx.used),
        ];
        for (q, (size, desc, avail, used)) in rings.into_iter().enumerate() {
            self.w(reg::QUEUE_SEL, q as u32);
            self.w(reg::QUEUE_NUM, u32::from(size));
            for (lo, a) in [
                (reg::QUEUE_DESC_LOW, desc),
                (reg::QUEUE_DRIVER_LOW, avail),
                (reg::QUEUE_DEVICE_LOW, used),
            ] {
                self.w(lo, a as u32);
                self.w(lo + 4, (a >> 32) as u32);
            }
            self.w(reg::QUEUE_READY, 1);
        }
        self.w(reg::STATUS, 15);
        self.r(reg::STATUS)
    }
    fn wait(&mut self, mut cond: impl FnMut(&mut Guest) -> bool) -> bool {
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(2) {
            if cond(self) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }
}

#[test]
fn end_to_end_tx_and_rx_through_the_transport_and_the_worker() {
    let mut g = Guest::new();
    assert_eq!(g.r(reg::DEVICE_ID), 3);
    assert_eq!(g.up(), 15);
    // Config space: 12 zero bytes (cols, rows, max_nr_ports, emerg_wr).
    assert_eq!(g.t.read(reg::CONFIG, AccessSize::B4), 0);
    assert_eq!(g.t.read(reg::CONFIG + 8, AccessSize::B4), 0);
    // TX: one chain, one doorbell on queue 1.
    g.mem
        .write(GuestAddress(TX_BUF), b"guest says hi\n")
        .unwrap();
    g.tx.set_desc(0, desc(TX_BUF, 14, 0, 0));
    g.tx.push(0);
    g.w(reg::QUEUE_NOTIFY, 1);
    assert!(g.wait(|g| g.tx.used_idx() == 1), "TX served");
    assert_eq!(g.out.bytes(), b"guest says hi\n");
    assert!(g.wait(|g| g.irq.level()));
    g.w(reg::INTERRUPT_ACK, 1);
    // RX: input typed before any buffer is posted is held...
    g.input.push(b"typed early\n");
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(g.input.len(), 12);
    // ...and delivered when the driver posts a buffer and rings queue 0.
    g.rx.set_desc(0, desc(BUF, 64, WRITE, 0));
    g.rx.push(0);
    g.w(reg::QUEUE_NOTIFY, 0);
    assert!(
        g.wait(|g| g.rx.used_idx() == 1),
        "RX served on the doorbell"
    );
    assert_eq!(g.rx.used_elem(0), (0, 12));
    let mut b = [0u8; 12];
    g.mem.read(GuestAddress(BUF), &mut b).unwrap();
    assert_eq!(&b, b"typed early\n");
    // Input that arrives while a buffer is posted is delivered by the hook alone.
    g.rx.set_desc(1, desc(BUF + 0x100, 64, WRITE, 0));
    g.rx.push(1);
    g.w(reg::QUEUE_NOTIFY, 0); // nothing to deliver yet: the buffer stays posted
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(g.rx.used_idx(), 1);
    g.input.push(b"late");
    assert!(
        g.wait(|g| g.rx.used_idx() == 2),
        "the input hook rang queue 0"
    );
    assert_eq!(g.rx.used_elem(1), (1, 4));
    assert!(!g.ctl.is_stopping());
    assert!(!g.worker.stop());
}

/// PLAN M13 host acceptance: a hostile chain triggers NEEDS_RESET; the VMM keeps running and
/// the device works again after a reset.
#[test]
fn a_hostile_chain_means_needs_reset_and_the_vmm_keeps_running() {
    let mut g = Guest::new();
    assert_eq!(g.up(), 15);
    // A 64 KiB + 1 TX chain (VQ-8).
    g.tx.set_desc(0, desc(TX_BUF, 65536, NEXT, 1));
    g.tx.set_desc(1, desc(TX_BUF + 65536, 1, 0, 0));
    g.tx.push(0);
    g.w(reg::QUEUE_NOTIFY, 1);
    assert!(
        g.wait(|g| g.r(reg::STATUS) & st::DEVICE_NEEDS_RESET != 0),
        "DEVICE_NEEDS_RESET"
    );
    assert_eq!(
        g.r(reg::INTERRUPT_STATUS) & 2,
        2,
        "a configuration interrupt"
    );
    assert!(g.out.bytes().is_empty());
    let batches = g.worker.batches();
    g.w(reg::QUEUE_NOTIFY, 1);
    g.input.push(b"x"); // the hook's doorbell is refused too (VQ-10)
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(g.worker.batches(), batches, "no batch after NEEDS_RESET");
    assert!(!g.ctl.is_stopping());
    // Reset, fresh rings, and it works again (the held input byte is delivered).
    for off in (0..0x400).step_by(4) {
        g.mem.write_u32(GuestAddress(AVAIL + off), 0).unwrap();
        g.mem.write_u32(GuestAddress(TX_AVAIL + off), 0).unwrap();
    }
    g.rx = Ring::new(g.mem.clone(), 16);
    g.tx = Ring::at(g.mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    assert_eq!(g.up(), 15);
    g.rx.set_desc(0, desc(BUF, 8, WRITE, 0));
    g.rx.push(0);
    g.w(reg::QUEUE_NOTIFY, 0);
    assert!(g.wait(|g| g.rx.used_idx() == 1));
    assert_eq!(g.rx.used_elem(0), (0, 1));
    assert!(!g.worker.stop());
}

/// The support module's `d` (a local `d` is the device under test here).
fn desc(addr: u64, len: u32, flags: u16, next: u16) -> vmm::virtio::Descriptor {
    d(addr, len, flags, next)
}

/// A writer that blocks in `write` until released (a stdout nobody reads).
#[derive(Clone, Default)]
struct Stall {
    released: Arc<std::sync::atomic::AtomicBool>,
}

impl Write for Stall {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        while !self.released.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Security test (SINK-1, TTY-10; M13 review): console TX goes through the sink's bounded
/// queue, and one TX batch (one hold of the device mutex) waits at most 10 ms **in total** for
/// a stalled stdout reader, not 10 ms per chain: the worst case, a full ring of 64 chains of
/// 64 KiB each, would otherwise hold the device mutex for 64 x 10 ms. What does not fit is
/// dropped and counted, and every chain is still returned.
#[test]
fn tx_never_blocks_on_a_stalled_sink() {
    let stall = Stall::default();
    let sink: SinkHandle = Arc::new(
        Sink::spawn(
            "stalled",
            Box::new(stall.clone()),
            FilterPolicy::Safe,
            u64::MAX,
        )
        .unwrap(),
    );
    let mem = mem();
    let rx = Ring::new(mem.clone(), 64);
    let mut tx = Ring::at(mem.clone(), 64, TX_DESC, TX_AVAIL, TX_USED);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let mut c = Console::new(sink.clone(), None);
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    c.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
    // Wedge the writer in write(2) and fill the queue, so every TX byte meets a full queue.
    sink.write_guest(&vec![b'q'; SINK_QUEUE_CAP]);
    let t0 = Instant::now();
    while sink.queued() == SINK_QUEUE_CAP && t0.elapsed() < Duration::from_secs(2) {
        std::thread::sleep(Duration::from_millis(1)); // until the writer took its chunk
    }
    sink.write_guest(&vec![b'q'; SINK_QUEUE_CAP]);
    assert_eq!(sink.queued(), SINK_QUEUE_CAP, "the queue is full");
    let pre_dropped = sink.dropped();
    mem.write(GuestAddress(TX_BUF), &vec![b'x'; 65536]).unwrap();
    for i in 0..64u16 {
        tx.set_desc(i, desc(TX_BUF, 65536, 0, 0));
        tx.push(i);
    }
    // The bytes are copied and filtered either way; only the waiting is under test. Time a
    // batch against a sink that never waits (`none`) for the copy cost of this build.
    let base = {
        let mem = virtio_support::mem();
        let rx = Ring::new(mem.clone(), 64);
        let mut tx = Ring::at(mem.clone(), 64, TX_DESC, TX_AVAIL, TX_USED);
        let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
        let mut c = Console::new(Arc::new(Sink::none()), None);
        let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
        c.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
        mem.write(GuestAddress(TX_BUF), &vec![b'x'; 65536]).unwrap();
        for i in 0..64u16 {
            tx.set_desc(i, desc(TX_BUF, 65536, 0, 0));
            tx.push(i);
        }
        let t0 = Instant::now();
        c.process_queue(TX_QUEUE, 64).unwrap();
        t0.elapsed()
    };
    let t0 = Instant::now();
    // A full ring at budget 64 reports MoreWork (the worker comes back after releasing the
    // mutex); the point is how long this one hold lasted.
    assert_eq!(c.process_queue(TX_QUEUE, 64), Ok(QueueProgress::MoreWork));
    let took = t0.elapsed();
    assert_eq!(tx.used_idx(), 64, "every chain was returned");
    let waited = took.saturating_sub(base);
    say(&format!(
        "stalled sink: 64 x 64 KiB batch took {took:?} (copy cost {base:?}, waiting ~{waited:?})"
    ));
    // Per chain it would be >= 640 ms of waiting; per batch it is 10 ms plus scheduling noise.
    assert!(
        waited < Duration::from_millis(150),
        "TX batch waited {waited:?} (took {took:?}, copy cost {base:?})"
    );
    assert_eq!(
        sink.dropped() - pre_dropped,
        64 * 65536,
        "every TX byte was dropped and counted"
    );
    stall
        .released
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(sink.close(b""));
}

/// M13 review (§5.3.6.1): a receiveq chain with no device-writable byte could only go back
/// empty, so it is a driver error (NEEDS_RESET), not a used element of `len = 0`; the typed
/// bytes stay queued for the next driver.
#[test]
fn rx_readable_only_chain_is_needs_reset_and_keeps_the_input() {
    let mut d = dev();
    d.put(BUF, &[0x55; 16]);
    d.rx.set_desc(0, desc(BUF, 16, 0, 0)); // device-readable only
    d.rx.push(0);
    d.input.push(b"typed");
    let r = d.run_rx();
    assert!(matches!(r, Err(VirtioError::Device(_))), "{r:?}");
    assert_eq!(d.rx.used_idx(), 0, "no empty buffer is ever returned");
    assert_eq!(d.input.len(), 5, "the input is kept");
    assert_eq!(
        d.bytes(BUF, 16),
        [0x55; 16],
        "the readable buffer is untouched"
    );
    assert_eq!(d.con.transferred(), (0, 0));
}

/// Guest memory whose writes into `[deny, deny + len)` fail as if it had changed shape after
/// the chain was validated (the only way `write_writable` can fail).
struct FailWrites {
    inner: Arc<VecMemory>,
    deny: u64,
    len: u64,
}

impl GuestMemory for FailWrites {
    fn read(&self, addr: GuestAddress, buf: &mut [u8]) -> Result<(), MemoryError> {
        self.inner.read(addr, buf)
    }
    fn write(&self, addr: GuestAddress, buf: &[u8]) -> Result<(), MemoryError> {
        if addr.0 < self.deny + self.len && self.deny < addr.0 + buf.len() as u64 {
            return Err(MemoryError::OutOfBounds {
                addr: addr.0,
                len: buf.len() as u64,
            });
        }
        self.inner.write(addr, buf)
    }
    fn check_range(&self, addr: GuestAddress, len: u64) -> bool {
        self.inner.check_range(addr, len)
    }
}

impl GuestMemoryOrdered for FailWrites {
    fn read_u16_acquire(&self, addr: GuestAddress) -> Result<u16, MemoryError> {
        self.inner.read_u16_acquire(addr)
    }
    fn write_u16_release(&self, addr: GuestAddress, val: u16) -> Result<(), MemoryError> {
        self.inner.write_u16_release(addr, val)
    }
}

/// M13 review: bytes leave the input queue only after they were written into guest memory, so
/// an RX write that fails (NEEDS_RESET) loses no typed byte; the next driver gets them all.
#[test]
fn rx_failed_write_keeps_the_input() {
    let mem = mem();
    let mut rx = Ring::new(mem.clone(), 16);
    let tx = Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let (s, _) = sink(FilterPolicy::Safe);
    let input = Arc::new(SerialInput::console());
    let mut c = Console::new(s, Some(input.clone()));
    let bad: Arc<dyn GuestMemoryOrdered> = Arc::new(FailWrites {
        inner: mem.clone(),
        deny: BUF,
        len: 0x100,
    });
    c.activate(bad, vec![rx.queue(), tx.queue()], vi.clone())
        .unwrap();
    rx.set_desc(0, desc(BUF, 64, WRITE, 0));
    rx.push(0);
    input.push(b"precious");
    assert!(c.process_queue(RX_QUEUE, 64).is_err());
    assert_eq!(input.len(), 8, "nothing was taken");
    // A reset and a new driver with working memory get every byte.
    c.reset();
    let rx = Ring::new(mem.clone(), 16);
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    c.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
    let mut rx = rx;
    rx.set_desc(1, desc(BUF + 0x200, 64, WRITE, 0));
    rx.set_avail_idx(0);
    rx.push(1);
    c.process_queue(RX_QUEUE, 64).unwrap();
    assert_eq!(rx.used_idx(), 1);
    assert_eq!(rx.used_elem(0), (1, 8));
    let mut got = [0u8; 8];
    mem.read(GuestAddress(BUF + 0x200), &mut got).unwrap();
    assert_eq!(&got, b"precious");
    assert!(input.is_empty());
}

/// TTY-1 / LOG-4 for the console (M13 review): `--console file:F,max=N` built through
/// `HostIo::open` (the real PATH-3 output path and the SINK-1 writer thread) caps the file at
/// exactly N bytes of guest TX and counts the excess as `console_capped`, independently of the
/// serial sink's cap. This is what keeps a guest from filling the host disk through hvc0.
#[test]
fn console_file_cap_through_hostio() {
    use vmm::HostIo;
    use vmm::config::{SinkKind, SinkSpec, VmConfig};
    let dir = std::env::temp_dir().join(format!("macvmm-concap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let blob = dir.join("guest.bin");
    std::fs::write(&blob, [0u8; 4]).unwrap();
    let out = dir.join("hvc0.out");
    let mut cfg = VmConfig::default();
    cfg.mem_bytes = 64 << 20;
    cfg.boot.raw.push(vmm::config::RawSpec {
        path: blob,
        addr: 0x4008_0000,
    });
    cfg.serial.kind = SinkKind::None; // the serial cap (default 1 GiB) must not apply
    cfg.console = Some(SinkSpec {
        kind: SinkKind::File,
        path: Some(out.clone()),
        max_bytes: 1024,
        ..SinkSpec::default()
    });
    let host = HostIo::open(&cfg).unwrap();
    let con_sink = host.console.clone().expect("a console sink");
    let mem = mem();
    let rx = Ring::new(mem.clone(), 16);
    let mut tx = Ring::at(mem.clone(), 16, TX_DESC, TX_AVAIL, TX_USED);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let mut c = Console::new(con_sink.clone(), Some(host.console_input.clone()));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    c.activate(gm, vec![rx.queue(), tx.queue()], vi).unwrap();
    let text: Vec<u8> = (0..4096u32).map(|i| b'a' + (i % 26) as u8).collect();
    mem.write(GuestAddress(TX_BUF), &text).unwrap();
    tx.set_desc(0, desc(TX_BUF, 4096, 0, 0));
    tx.push(0);
    c.process_queue(TX_QUEUE, 16).unwrap();
    assert_eq!(tx.used_idx(), 1);
    assert!(host.close_sinks(b"never written to a file"));
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(bytes.len(), 1024, "stops exactly at the console cap");
    assert_eq!(&bytes[..], &text[..1024]);
    assert_eq!(con_sink.capped(), 4096 - 1024);
    let stats = host.io_stats();
    assert!(stats.contains("console_written=1024"), "{stats}");
    assert!(stats.contains("console_capped=3072"), "{stats}");
    let _ = std::fs::remove_dir_all(&dir);
}
