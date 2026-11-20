//! PLAN M12 acceptance (host): the device worker thread (architecture §14.1, §14.3; threat
//! model VQ-12, VQ-14, RUST-7).
//!
//! - notify coalescing: ten doorbells → between one and ten `process_queue` calls, and every
//!   buffer consumed;
//! - `stop()` joins within 100 ms;
//! - a Status = 0 reset while a batch runs waits for the batch and leaves no queues behind,
//!   and a doorbell that raced the reset is not turned into NEEDS_RESET;
//! - a batch that *fails* while a reset waits never leaves the fresh device in NEEDS_RESET;
//! - `worker_panic_stops_vm` (RUST-7): a device that panics in `process_queue` stops the VM
//!   with the exit-1 reason, the panic hook ran, and the transport never calls the dead device
//!   again; the panic overrides a guest verdict posted before it (`worker::final_reason`, what
//!   `Machine::run` returns);
//! - pause holds the worker at a batch boundary, and returns when the worker panics mid-batch.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::backend::entropy::Entropy;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::control::{StopReason, VmControl};
use vmm::irq::{NullIrq, TestIrq};
use vmm::memory::prelude::*;
use vmm::virtio::mmio::reg;
use vmm::virtio::status as st;
use vmm::virtio::worker::{WORKER_PANIC, final_reason, stop_all};
use vmm::virtio::{
    Queue, QueueNotifier, QueueProgress, Rng, VirtioDevice, VirtioError, VirtioInterrupt,
    VirtioMmio, Worker,
};

/// Wraps a device: counts `process_queue` calls, optionally sleeps inside each (holding the
/// device mutex, like a slow disk), optionally panics after the sleep. `touched` counts every
/// call that is not one of the three constant getters.
struct Probe {
    inner: Rng,
    calls: Arc<AtomicU64>,
    delay: Duration,
    panic: bool,
    has_queue: Arc<AtomicUsize>,
    touched: Arc<AtomicU64>,
}

impl Probe {
    fn new(calls: Arc<AtomicU64>) -> Probe {
        Probe {
            inner: Rng::new(Entropy::os()),
            calls,
            delay: Duration::ZERO,
            panic: false,
            has_queue: Arc::new(AtomicUsize::new(0)),
            touched: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl VirtioDevice for Probe {
    fn device_id(&self) -> u32 {
        self.inner.device_id()
    }
    fn queue_max_sizes(&self) -> &[u16] {
        self.inner.queue_max_sizes()
    }
    fn device_features(&self) -> u64 {
        self.inner.device_features()
    }
    fn ack_features(&mut self, a: u64) {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.inner.ack_features(a);
    }
    fn read_config(&self, o: u32, d: &mut [u8]) {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.inner.read_config(o, d);
    }
    fn write_config(&mut self, o: u32, d: &[u8]) {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.inner.write_config(o, d);
    }
    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.has_queue.store(1, Ordering::SeqCst);
        self.inner.activate(mem, queues, irq)
    }
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(self.delay);
        if self.panic {
            panic!("probe device panics in process_queue (expected in this test)");
        }
        self.inner.process_queue(index, budget)
    }
    fn reset(&mut self) {
        self.touched.fetch_add(1, Ordering::SeqCst);
        self.has_queue.store(0, Ordering::SeqCst);
        self.inner.reset();
    }
}

/// A transport + worker around `probe`, already through DRIVER_OK on a 16-entry ring.
struct Fx {
    t: VirtioMmio,
    ring: Ring,
    worker: Arc<Worker>,
    ctl: Arc<VmControl>,
    vi: Arc<VirtioInterrupt>,
}

fn fx(probe: Probe) -> Fx {
    let mem = mem();
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(probe));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    let mut t = VirtioMmio::new(device.clone(), vi.clone(), Some(gm)).unwrap();
    let ctl = Arc::new(VmControl::new());
    let worker = Worker::spawn(
        "virtio-probe-test",
        device,
        vi.clone(),
        vec![64],
        ctl.clone(),
    )
    .unwrap();
    let n: Arc<dyn QueueNotifier> = worker.clone();
    t.set_notifier(Some(n));
    let ring = Ring::new(mem, 16);
    let mut f = Fx {
        t,
        ring,
        worker,
        ctl,
        vi,
    };
    let w = |f: &mut Fx, off: u64, v: u64| f.t.write(off, AccessSize::B4, v);
    w(&mut f, reg::STATUS, 1);
    w(&mut f, reg::STATUS, 3);
    w(&mut f, reg::DRIVER_FEATURES_SEL, 1);
    w(&mut f, reg::DRIVER_FEATURES, 1);
    w(&mut f, reg::STATUS, 11);
    w(&mut f, reg::QUEUE_NUM, 16);
    for (lo, a) in [
        (reg::QUEUE_DESC_LOW, DESC),
        (reg::QUEUE_DRIVER_LOW, AVAIL),
        (reg::QUEUE_DEVICE_LOW, USED),
    ] {
        w(&mut f, lo, a & 0xffff_ffff);
        w(&mut f, lo + 4, a >> 32);
    }
    w(&mut f, reg::QUEUE_READY, 1);
    w(&mut f, reg::STATUS, 15);
    assert_eq!(f.t.read(reg::STATUS, AccessSize::B4), 15);
    f
}

fn wait_for(limit: Duration, mut cond: impl FnMut() -> bool) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    cond()
}

#[test]
fn ten_notifies_coalesce_into_at_most_ten_calls_and_consume_every_buffer() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut p = Probe::new(calls.clone());
    p.delay = Duration::from_millis(5); // doorbells pile up while a batch runs
    let mut f = fx(p);
    for i in 0..10u16 {
        f.ring.set_desc(i, d(BUF + 64 * u64::from(i), 64, WRITE, 0));
        f.ring.push(i);
        f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    }
    assert!(wait_for(Duration::from_secs(2), || f.ring.used_idx() == 10));
    let n = calls.load(Ordering::SeqCst);
    assert!(
        (1..=10).contains(&n),
        "{n} process_queue calls for 10 notifies"
    );
    say(&format!(
        "coalescing: 10 notifies -> {n} process_queue calls"
    ));
    for i in 0..10 {
        assert_eq!(f.ring.used_elem(i), (u32::from(i), 64));
    }
    assert!(!f.worker.stop());
}

#[test]
fn stop_joins_within_100_ms() {
    let f = fx(Probe::new(Arc::new(AtomicU64::new(0))));
    let t0 = Instant::now();
    assert!(!f.worker.stop());
    let took = t0.elapsed();
    assert!(took < Duration::from_millis(100), "stop took {took:?}");
    // After stop a doorbell is harmless.
    f.worker.notify(0);
    assert!(!f.ctl.is_stopping());
}

#[test]
fn a_reset_during_processing_leaves_no_queues() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut p = Probe::new(calls.clone());
    p.delay = Duration::from_millis(50);
    let has_queue = p.has_queue.clone();
    let mut f = fx(p);
    assert_eq!(has_queue.load(Ordering::SeqCst), 1);
    f.ring.set_desc(0, d(BUF, 64, WRITE, 0));
    f.ring.push(0);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    assert!(wait_for(Duration::from_secs(1), || calls
        .load(Ordering::SeqCst)
        == 1));
    // The batch is sleeping with the device mutex held. Status = 0 takes that mutex, so it
    // returns only after the batch finished (VQ-14).
    let t0 = Instant::now();
    f.t.write(reg::STATUS, AccessSize::B4, 0);
    let waited = t0.elapsed();
    say(&format!("reset waited {waited:?} for the batch"));
    // What proves the wait: the in-flight request completed on the old ring *before* the
    // reset returned. Had the reset not waited for the device mutex, the batch would have
    // found the device reset (NotActivated) and `used.idx` would still be 0.
    assert_eq!(
        f.ring.used_idx(),
        1,
        "the batch finished on the old queue before the reset"
    );
    assert!(
        waited >= Duration::from_millis(30),
        "the reset returned after {waited:?}, inside a 50 ms batch"
    );
    assert_eq!(
        has_queue.load(Ordering::SeqCst),
        0,
        "no queue survives the reset"
    );
    assert_eq!(f.t.read(reg::STATUS, AccessSize::B4), 0);
    // A doorbell that raced the reset reaches a device with no queues: ignored, not NEEDS_RESET.
    f.worker.notify(0);
    assert!(wait_for(Duration::from_secs(1), || calls
        .load(Ordering::SeqCst)
        >= 2));
    std::thread::sleep(Duration::from_millis(60));
    assert!(
        !f.vi.needs_reset(),
        "a stale doorbell is not the guest's fault"
    );
    assert_eq!(f.ring.used_idx(), 1, "the old ring is never touched again");
    assert!(!f.worker.stop());
}

#[test]
fn a_failed_batch_racing_a_reset_never_marks_the_fresh_device() {
    // A hostile chain (a self-loop) fails inside a slow batch while the driver writes
    // Status = 0. The worker latches NEEDS_RESET while it still holds the device mutex, so the
    // reset (which waits on that mutex) runs after the latch and clears it. Reported after the
    // unlock, the latch could land on the freshly reset device (seen 3 times in 200 runs) and
    // the driver's next handshake would be refused. Many short rounds widen the window.
    for round in 0..100 {
        let calls = Arc::new(AtomicU64::new(0));
        let mut p = Probe::new(calls.clone());
        p.delay = Duration::from_millis(3);
        let mut f = fx(p);
        f.ring.set_desc(0, d(BUF, 8, WRITE | NEXT, 0));
        f.ring.push(0);
        f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
        assert!(wait_for(Duration::from_secs(1), || calls
            .load(Ordering::SeqCst)
            == 1));
        f.t.write(reg::STATUS, AccessSize::B4, 0); // waits for the failing batch
        assert!(
            !f.vi.needs_reset(),
            "round {round}: NEEDS_RESET survived the reset"
        );
        assert_eq!(f.t.read(reg::STATUS, AccessSize::B4), 0, "round {round}");
        f.t.write(reg::STATUS, AccessSize::B4, u64::from(st::ACKNOWLEDGE));
        assert_eq!(
            f.t.read(reg::STATUS, AccessSize::B4),
            u64::from(st::ACKNOWLEDGE),
            "round {round}: the fresh device accepts a new handshake"
        );
        assert!(!f.worker.stop());
        assert!(!f.ctl.is_stopping());
    }
}

#[test]
fn worker_panic_stops_vm() {
    static HOOK_RAN: AtomicUsize = AtomicUsize::new(0);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if std::thread::current().name() == Some("virtio-probe-test") {
            HOOK_RAN.fetch_add(1, Ordering::SeqCst);
        }
        previous(info);
    }));
    let mut p = Probe::new(Arc::new(AtomicU64::new(0)));
    p.panic = true;
    let touched = p.touched.clone();
    let mut f = fx(p);
    f.ring.set_desc(0, d(BUF, 64, WRITE, 0));
    f.ring.push(0);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    // What `Machine::run` waits on: the VM's stop control.
    assert!(
        f.ctl
            .wait_until(Some(Instant::now() + Duration::from_secs(2))),
        "the panic stopped the VM"
    );
    let reason = f.ctl.take_reason().unwrap();
    assert_eq!(reason.exit_code(), 1, "{reason}");
    assert!(matches!(&reason, StopReason::Vmm(e) if e.to_string().contains(WORKER_PANIC)));
    // The device mutex is poisoned: the transport treats the device as dead (RUST-7, no
    // poisoned-mutex continue). vCPU accesses that arrive before the kick reach no device code.
    assert!(f.t.is_dead());
    let before = touched.load(Ordering::SeqCst);
    f.t.write(reg::STATUS, AccessSize::B4, 0);
    f.t.write(reg::STATUS, AccessSize::B4, 1);
    let _ = f.t.read(reg::CONFIG, AccessSize::B4);
    f.t.write(reg::CONFIG, AccessSize::B4, 0x1234);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    assert_eq!(f.t.read(reg::STATUS, AccessSize::B4), 0, "RAZ");
    assert_eq!(f.t.read(reg::MAGIC, AccessSize::B4), 0, "RAZ");
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(
        touched.load(Ordering::SeqCst),
        before,
        "nothing calls into a device that panicked"
    );
    assert!(f.worker.stop(), "stop() reports the panic");
    assert!(f.worker.panicked());
    assert!(HOOK_RAN.load(Ordering::SeqCst) >= 1, "the panic hook ran");
}

#[test]
fn a_worker_panic_overrides_a_guest_verdict_posted_first() {
    // `VmControl` keeps the first stop reason. A guest SYSTEM_OFF that lands just before the
    // panic is the reason `ctl` returns; `final_reason` (what `Machine::run` returns) must
    // still report the panic, exit 1.
    let mut p = Probe::new(Arc::new(AtomicU64::new(0)));
    p.panic = true;
    let mut f = fx(p);
    assert!(f.ctl.request_stop(StopReason::PowerOff));
    f.ring.set_desc(0, d(BUF, 64, WRITE, 0));
    f.ring.push(0);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    assert!(wait_for(Duration::from_secs(2), || f.worker.panicked()));
    let vcpu_reason = f.ctl.take_reason().unwrap();
    assert_eq!(
        vcpu_reason.exit_code(),
        0,
        "first wins: the guest's verdict"
    );
    let reason = final_reason(vcpu_reason, stop_all(std::slice::from_ref(&f.worker)));
    assert_eq!(reason.exit_code(), 1, "{reason}");
    assert!(matches!(&reason, StopReason::Vmm(e) if e.to_string().contains(WORKER_PANIC)));
    // Without a panic the vCPUs' verdict stands.
    assert_eq!(final_reason(StopReason::PowerOff, false).exit_code(), 0);
}

#[test]
fn pause_returns_when_the_worker_panics_mid_batch() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut p = Probe::new(calls.clone());
    p.panic = true;
    p.delay = Duration::from_millis(50); // the panic comes after pause() starts waiting
    let mut f = fx(p);
    f.ring.set_desc(0, d(BUF, 64, WRITE, 0));
    f.ring.push(0);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    assert!(wait_for(Duration::from_secs(1), || calls
        .load(Ordering::SeqCst)
        == 1));
    let (tx, rx) = std::sync::mpsc::channel();
    let w = f.worker.clone();
    std::thread::spawn(move || {
        let t0 = Instant::now();
        w.pause();
        let _ = tx.send(t0.elapsed());
    });
    let took = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("pause() returned after the worker panicked");
    say(&format!(
        "pause returned {took:?} after the mid-batch panic"
    ));
    assert!(f.worker.panicked());
    assert!(f.worker.stop());
    // A later pause on the dead worker returns at once.
    f.worker.pause();
}

#[test]
fn pause_holds_the_worker_at_a_batch_boundary() {
    let calls = Arc::new(AtomicU64::new(0));
    let mut f = fx(Probe::new(calls.clone()));
    f.worker.pause();
    f.ring.set_desc(0, d(BUF, 64, WRITE, 0));
    f.ring.push(0);
    f.t.write(reg::QUEUE_NOTIFY, AccessSize::B4, 0);
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(calls.load(Ordering::SeqCst), 0, "no batch while paused");
    f.worker.resume();
    assert!(wait_for(Duration::from_secs(1), || f.ring.used_idx() == 1));
    assert!(!f.worker.stop());
}

#[test]
fn a_worker_without_a_ready_device_is_quiet() {
    let ctl = Arc::new(VmControl::new());
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(NullIrq)));
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Rng::new(Entropy::os())));
    let w = Worker::spawn("virtio-idle", device, vi.clone(), vec![64], ctl.clone()).unwrap();
    w.notify(0); // before DRIVER_OK: NotActivated, ignored
    assert!(wait_for(Duration::from_secs(1), || w.batches() == 1));
    assert!(!vi.needs_reset());
    drop(w); // Drop stops and joins
    assert!(!ctl.is_stopping());
}
