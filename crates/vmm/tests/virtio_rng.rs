//! PLAN M12 acceptance (host): the virtio-rng device model (virtio 1.2 §5.4; architecture
//! §11.3; threat model VQ-8, VQ-9, VQ-10, VQ-11, FDT-3).
//!
//! Two levels: the device driven directly (`activate` + `process_queue`, as the worker calls
//! it), and the whole path a guest uses (the virtio-mmio transport, a QueueNotify, the worker
//! thread, the used ring and the interrupt line), with `VecMemory` as guest RAM and `TestIrq`
//! as the line. "Readable descriptors are never written" is checked from the `VecMemory`
//! access log, not just from the bytes.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::backend::entropy::Entropy;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::control::VmControl;
use vmm::irq::TestIrq;
use vmm::memory::VecMemory;
use vmm::memory::prelude::*;
use vmm::virtio::mmio::reg;
use vmm::virtio::rng::{RNG_MAX_REQUEST, RNG_QUEUE_SIZE};
use vmm::virtio::{
    DEVICE_ID_RNG, QueueError, QueueProgress, Rng, VirtioDevice, VirtioError, VirtioInterrupt,
    VirtioMmio, Worker, features, status as st,
};

/// An activated rng on a 16-entry ring at the default placement.
struct Dev {
    rng: Rng,
    ring: Ring,
    mem: Arc<VecMemory>,
    irq: Arc<TestIrq>,
    vi: Arc<VirtioInterrupt>,
}

fn dev(size: u16) -> Dev {
    let mem = mem();
    let ring = Ring::new(mem.clone(), size);
    let irq = Arc::new(TestIrq::new());
    let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
    let mut rng = Rng::new(Entropy::os());
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    rng.activate(gm, vec![ring.queue()], vi.clone()).unwrap();
    Dev {
        rng,
        ring,
        mem,
        irq,
        vi,
    }
}

impl Dev {
    fn run(&mut self) -> Result<QueueProgress, VirtioError> {
        self.rng.process_queue(0, RNG_QUEUE_SIZE)
    }
    fn fill(&self, addr: u64, len: usize, byte: u8) {
        self.mem
            .write(GuestAddress(addr), &vec![byte; len])
            .unwrap();
    }
    fn bytes(&self, addr: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        self.mem.read(GuestAddress(addr), &mut b).unwrap();
        b
    }
}

/// Writes in the access log that touch `[addr, addr + len)`.
fn writes_into(mem: &VecMemory, addr: u64, len: u64) -> usize {
    mem.log()
        .iter()
        .filter(|a| a.write && !a.fence && a.addr < addr + len && addr < a.addr + a.len)
        .count()
}

/// 32 random bytes are "nonzero" unless the CSPRNG is broken (p = 2^-256).
fn nonzero(b: &[u8]) -> bool {
    b.iter().any(|&x| x != 0)
}

#[test]
fn identity_one_queue_version_1_no_config() {
    let r = Rng::new(Entropy::os());
    assert_eq!(r.device_id(), DEVICE_ID_RNG);
    assert_eq!(r.queue_max_sizes(), &[64]);
    assert_eq!(r.device_features(), features::VERSION_1);
    assert_eq!(r.config_len(), 0);
}

#[test]
fn fills_only_writable_descriptors_and_ignores_readable_ones() {
    let mut d = dev(16);
    let (rd, wr) = (BUF, BUF + 0x1000);
    d.fill(rd, 64, 0x5a);
    d.ring.set_desc(0, desc(rd, 64, NEXT, 1));
    d.ring.set_desc(1, desc(wr, 32, WRITE, 0));
    d.ring.push(0);
    d.mem.enable_log();
    assert_eq!(d.run(), Ok(QueueProgress::Drained));
    assert_eq!(d.ring.used_idx(), 1);
    assert_eq!(
        d.ring.used_elem(0),
        (0, 32),
        "len counts only the writable bytes"
    );
    assert_eq!(
        d.bytes(rd, 64),
        vec![0x5a; 64],
        "the readable buffer is untouched"
    );
    assert_eq!(
        writes_into(&d.mem, rd, 64),
        0,
        "and never even written (access log)"
    );
    assert!(nonzero(&d.bytes(wr, 32)));
    assert_eq!(writes_into(&d.mem, wr, 32), 1);
}

#[test]
fn a_readable_only_chain_is_returned_with_len_0() {
    let mut d = dev(16);
    d.fill(BUF, 16, 0x11);
    d.ring.set_desc(0, desc(BUF, 16, 0, 0));
    d.ring.push(0);
    d.mem.enable_log();
    d.run().unwrap();
    assert_eq!(d.ring.used_elem(0), (0, 0));
    assert_eq!(writes_into(&d.mem, BUF, 16), 0);
}

#[test]
fn used_len_is_exact_across_several_writable_descriptors() {
    let mut d = dev(16);
    d.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 1));
    d.ring.set_desc(1, desc(BUF + 0x100, 24, WRITE | NEXT, 2));
    d.ring.set_desc(2, desc(BUF + 0x200, 1, WRITE, 0));
    d.ring.push(0);
    d.run().unwrap();
    assert_eq!(d.ring.used_elem(0), (0, 33));
    assert_eq!(d.rng.served(), (1, 33));
}

#[test]
fn exactly_64_kib_is_served() {
    for split in [1u32, 2, 16] {
        let mut d = dev(16);
        let each = (RNG_MAX_REQUEST as u32) / split;
        for i in 0..split {
            let flags = if i + 1 < split { WRITE | NEXT } else { WRITE };
            let at = BUF + u64::from(i) * u64::from(each);
            d.ring
                .set_desc(i as u16, desc(at, each, flags, i as u16 + 1));
        }
        d.ring.push(0);
        d.run().unwrap();
        assert_eq!(d.ring.used_elem(0), (0, 65536), "split {split}");
        assert!(!d.bytes(BUF + 65536 - 32, 32).iter().all(|&b| b == 0));
    }
}

#[test]
fn more_than_64_kib_is_refused_and_nothing_is_written() {
    let mut d = dev(16);
    d.ring.set_desc(0, desc(BUF, 65536, WRITE | NEXT, 1));
    d.ring.set_desc(1, desc(BUF + 65536, 1, WRITE, 0));
    d.ring.push(0);
    d.mem.enable_log();
    let e = d.run().unwrap_err();
    assert!(
        matches!(
            e,
            VirtioError::Queue(QueueError::TooLarge { max: 65536, .. })
        ),
        "{e:?}"
    );
    assert_eq!(writes_into(&d.mem, BUF, 65537), 0);
    assert_eq!(d.ring.used_idx(), 0, "the chain is not returned");
}

#[test]
fn each_request_gets_fresh_bytes() {
    let mut d = dev(16);
    d.ring.set_desc(0, desc(BUF, 64, WRITE, 0));
    d.ring.set_desc(1, desc(BUF + 64, 64, WRITE, 0));
    d.ring.push(0);
    d.ring.push(1);
    d.run().unwrap();
    assert_eq!(d.ring.used_idx(), 2);
    assert_ne!(d.bytes(BUF, 64), d.bytes(BUF + 64, 64));
}

#[test]
fn hostile_chains_are_errors_never_panics() {
    type Setup = fn(&mut Dev);
    let cases: &[(&str, Setup)] = &[
        ("self loop", |d| {
            d.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 0))
        }),
        ("2-cycle", |d| {
            d.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 1));
            d.ring.set_desc(1, desc(BUF + 8, 8, WRITE | NEXT, 0));
        }),
        ("next out of range", |d| {
            d.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 999))
        }),
        ("zero length", |d| {
            d.ring.set_desc(0, desc(BUF, 0, WRITE, 0))
        }),
        ("buffer in MMIO", |d| {
            d.ring.set_desc(0, desc(MMIO_ADDR, 32, WRITE, 0))
        }),
        ("buffer straddles the end of RAM", |d| {
            d.ring.set_desc(0, desc(RAM_END - 16, 32, WRITE, 0))
        }),
        ("addr + len overflows", |d| {
            d.ring.set_desc(0, desc(u64::MAX - 8, u32::MAX, WRITE, 0))
        }),
        ("indirect, not negotiated", |d| {
            d.ring.set_desc(0, desc(BUF, 16, INDIRECT, 0))
        }),
        ("readable after writable", |d| {
            d.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 1));
            d.ring.set_desc(1, desc(BUF + 8, 8, 0, 0));
        }),
        ("len = u32::MAX", |d| {
            d.ring.set_desc(0, desc(BUF, u32::MAX, WRITE, 0))
        }),
    ];
    for (name, setup) in cases {
        let mut d = dev(16);
        setup(&mut d);
        d.ring.push(0);
        assert!(d.run().is_err(), "{name}");
        assert_eq!(d.ring.used_idx(), 0, "{name}: nothing returned");
        // VQ-10 "nothing more is processed" is enforced above the device: the worker and the
        // transport refuse doorbells once NEEDS_RESET is latched (tested through the
        // transport below).
    }
    // avail.idx jumping by N + 1, and a head >= N.
    let mut d = dev(16);
    d.ring.set_avail_idx(17);
    assert!(matches!(
        d.run(),
        Err(VirtioError::Queue(QueueError::AvailIdxJump { .. }))
    ));
    let mut d = dev(16);
    d.mem.write_u16(GuestAddress(AVAIL + 4), 16).unwrap();
    d.ring.set_avail_idx(1);
    assert!(matches!(
        d.run(),
        Err(VirtioError::Queue(QueueError::HeadOutOfRange { .. }))
    ));
}

#[test]
fn budget_is_clamped_to_the_queue_and_more_work_is_reported() {
    let mut d = dev(8);
    for i in 0..8 {
        d.ring
            .set_desc(i, desc(BUF + 64 * u64::from(i), 64, WRITE, 0));
        d.ring.push(i);
    }
    assert_eq!(d.rng.process_queue(0, 3), Ok(QueueProgress::MoreWork));
    assert_eq!(d.ring.used_idx(), 3);
    // A budget above the queue size is clamped to it (VQ-12: one ring's worth).
    assert_eq!(d.rng.process_queue(0, u16::MAX), Ok(QueueProgress::Drained));
    assert_eq!(d.ring.used_idx(), 8);
    assert_eq!(d.rng.process_queue(0, 8), Ok(QueueProgress::Drained));
}

#[test]
fn interrupt_unless_no_interrupt_and_wrong_queue_index() {
    let mut d = dev(16);
    d.ring.set_desc(0, desc(BUF, 8, WRITE, 0));
    d.ring.set_avail_flags(1); // VIRTQ_AVAIL_F_NO_INTERRUPT
    d.ring.push(0);
    d.run().unwrap();
    assert!(!d.irq.level(), "NO_INTERRUPT is respected");
    d.ring.set_avail_flags(0);
    d.ring.push(0);
    d.run().unwrap();
    assert!(d.irq.level());
    assert_eq!(d.vi.status(), 1);
    assert_eq!(d.rng.process_queue(1, 8), Err(VirtioError::NoSuchQueue(1)));
}

#[test]
fn reset_drops_the_queue() {
    let mut d = dev(16);
    d.rng.reset();
    d.ring.set_desc(0, desc(BUF, 8, WRITE, 0));
    d.ring.push(0);
    assert_eq!(d.run(), Err(VirtioError::NotActivated));
    assert_eq!(
        d.ring.used_idx(),
        0,
        "the old ring is not touched after reset"
    );
}

// ---- the whole guest-visible path: transport + worker ----

struct Guest {
    t: VirtioMmio,
    ring: Ring,
    mem: Arc<VecMemory>,
    irq: Arc<TestIrq>,
    worker: Arc<Worker>,
    ctl: Arc<VmControl>,
}

impl Guest {
    fn new() -> Guest {
        let mem = mem();
        let irq = Arc::new(TestIrq::new());
        let vi = Arc::new(VirtioInterrupt::new(irq.clone()));
        let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Rng::new(Entropy::os())));
        let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
        let mut t = VirtioMmio::new(device.clone(), vi.clone(), Some(gm)).unwrap();
        let ctl = Arc::new(VmControl::new());
        let worker = Worker::spawn("virtio-rng-test", device, vi, vec![64], ctl.clone()).unwrap();
        let n: Arc<dyn vmm::virtio::QueueNotifier> = worker.clone();
        t.set_notifier(Some(n));
        Guest {
            t,
            ring: Ring::new(mem.clone(), 16),
            mem,
            irq,
            worker,
            ctl,
        }
    }
    fn r(&mut self, off: u64) -> u32 {
        self.t.read(off, AccessSize::B4) as u32
    }
    fn w(&mut self, off: u64, v: u32) {
        self.t.write(off, AccessSize::B4, u64::from(v));
    }
    /// The §3.1.1 handshake with queue 0 on `self.ring`; returns Status.
    fn up(&mut self) -> u32 {
        self.w(reg::STATUS, 0);
        self.w(reg::STATUS, st::ACKNOWLEDGE);
        self.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER);
        self.w(reg::DRIVER_FEATURES_SEL, 1);
        self.w(reg::DRIVER_FEATURES, 1); // VERSION_1
        self.w(reg::STATUS, 11);
        self.w(reg::QUEUE_SEL, 0);
        self.w(reg::QUEUE_NUM, u32::from(self.ring.size));
        for (lo, a) in [
            (reg::QUEUE_DESC_LOW, self.ring.desc),
            (reg::QUEUE_DRIVER_LOW, self.ring.avail),
            (reg::QUEUE_DEVICE_LOW, self.ring.used),
        ] {
            self.w(lo, a as u32);
            self.w(lo + 4, (a >> 32) as u32);
        }
        self.w(reg::QUEUE_READY, 1);
        self.w(reg::STATUS, 15);
        self.r(reg::STATUS)
    }
    /// Poll until `cond` or 2 s.
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
fn end_to_end_through_the_transport_and_the_worker() {
    let mut g = Guest::new();
    assert_eq!(g.r(reg::DEVICE_ID), 4);
    assert_eq!(g.up(), 15);
    g.ring.set_desc(0, desc(BUF, 32, WRITE, 0));
    g.ring.push(0);
    g.w(reg::QUEUE_NOTIFY, 0);
    assert!(
        g.wait(|g| g.ring.used_idx() == 1),
        "the worker served the request"
    );
    assert_eq!(g.ring.used_elem(0), (0, 32));
    assert!(g.wait(|g| g.irq.level()));
    assert_eq!(g.r(reg::INTERRUPT_STATUS), 1);
    g.w(reg::INTERRUPT_ACK, 1);
    assert!(!g.irq.level());
    let mut b = [0u8; 32];
    g.mem.read(GuestAddress(BUF), &mut b).unwrap();
    assert!(nonzero(&b));
    // Config space is empty: every access reads as zero (VQ-13).
    assert_eq!(g.t.read(reg::CONFIG, AccessSize::B4), 0);
    assert!(g.worker.batches() >= 1);
    assert!(!g.worker.stop());
}

#[test]
fn a_hostile_chain_means_needs_reset_and_the_vmm_keeps_running() {
    let mut g = Guest::new();
    assert_eq!(g.up(), 15);
    g.ring.set_desc(0, desc(BUF, 8, WRITE | NEXT, 0)); // a self-loop
    g.ring.push(0);
    g.w(reg::QUEUE_NOTIFY, 0);
    assert!(
        g.wait(|g| g.r(reg::STATUS) & st::DEVICE_NEEDS_RESET != 0),
        "DEVICE_NEEDS_RESET"
    );
    assert_eq!(
        g.r(reg::INTERRUPT_STATUS) & 2,
        2,
        "a configuration interrupt"
    );
    assert!(g.irq.level());
    // Further doorbells are ignored until the driver resets the device (VQ-10). The hostile
    // chain is still at the head of the ring, so a regression would process it again.
    let batches = g.worker.batches();
    g.w(reg::QUEUE_NOTIFY, 0);
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(g.worker.batches(), batches, "no batch after NEEDS_RESET");
    assert_eq!(g.ring.used_idx(), 0, "nothing returned");
    // The VM was not stopped: a guest error is never a VMM error.
    assert!(!g.ctl.is_stopping());
    // After Status = 0 and a fresh handshake, the device works again.
    g.ring = Ring::new(g.mem.clone(), 16);
    for off in (0..0x300).step_by(4) {
        g.mem.write_u32(GuestAddress(AVAIL + off), 0).unwrap();
    }
    assert_eq!(g.up(), 15);
    assert!(!g.irq.level(), "reset lowered the line");
    g.ring.set_desc(0, desc(BUF, 16, WRITE, 0));
    g.ring.push(0);
    g.w(reg::QUEUE_NOTIFY, 0);
    assert!(g.wait(|g| g.ring.used_idx() == 1));
    assert_eq!(g.ring.used_elem(0), (0, 16));
    assert!(!g.worker.stop());
}

#[test]
fn rings_out_of_ram_are_refused_at_driver_ok() {
    let mut g = Guest::new();
    g.ring = Ring::at(g.mem.clone(), 16, DESC, AVAIL, RAM_END - 4);
    let s = g.up();
    assert_ne!(s & st::DEVICE_NEEDS_RESET, 0, "{s:#x}");
    g.w(reg::QUEUE_NOTIFY, 0);
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(g.worker.batches(), 0, "a refused device is never processed");
    assert!(!g.ctl.is_stopping());
}

/// `d` with the support module's argument order (addr, len, flags, next).
fn desc(addr: u64, len: u32, flags: u16, next: u16) -> vmm::virtio::Descriptor {
    d(addr, len, flags, next)
}
