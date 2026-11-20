// Checkpoint 17 contract (L1), frozen from the reference test crates/vmm/tests/worker_budget.rs.
// It names only items chapters 15 to 17 teach; the harness runs it against your crates.
//! PLAN M12 security test (threat model VQ-12, flaw F8; architecture §14.2, §14.3): a guest
//! that refills its ring forever must not keep the worker inside one batch.
//!
//! A "driver" thread plays a hostile guest: every buffer the device returns is posted again at
//! once and the doorbell rung, for as long as the test runs, so the ring is never empty. The
//! worker must still
//! 1. handle at most `N` chains per `process_queue` call, i.e. per hold of the device mutex
//!    (measured inside the device),
//! 2. release the device mutex between batches, so a second thread (a vCPU doing a
//!    config-space read, in the real VMM) gets it, repeatedly, while the flood goes on, and
//! 3. stop within 100 ms when asked, flood or not.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::backend::entropy::Entropy;
use vmm::control::VmControl;
use vmm::irq::NullIrq;
use vmm::memory::prelude::*;
use vmm::virtio::{Queue, QueueProgress, Rng, VirtioDevice, VirtioError, VirtioInterrupt, Worker};

const N: u16 = 16;

/// Rng plus a record of the most chains served in one `process_queue` call.
struct Counted {
    rng: Rng,
    max_per_call: Arc<AtomicU64>,
    calls: Arc<AtomicU64>,
}

impl VirtioDevice for Counted {
    fn device_id(&self) -> u32 {
        self.rng.device_id()
    }
    fn queue_max_sizes(&self) -> &[u16] {
        self.rng.queue_max_sizes()
    }
    fn device_features(&self) -> u64 {
        self.rng.device_features()
    }
    fn ack_features(&mut self, a: u64) {
        self.rng.ack_features(a);
    }
    fn read_config(&self, o: u32, d: &mut [u8]) {
        self.rng.read_config(o, d);
    }
    fn write_config(&mut self, o: u32, d: &[u8]) {
        self.rng.write_config(o, d);
    }
    fn activate(
        &mut self,
        m: Arc<dyn GuestMemoryOrdered>,
        q: Vec<Queue>,
        i: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        self.rng.activate(m, q, i)
    }
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        let before = self.rng.served().0;
        let r = self.rng.process_queue(index, budget);
        let served = self.rng.served().0 - before;
        self.max_per_call.fetch_max(served, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        r
    }
    fn reset(&mut self) {
        self.rng.reset();
    }
}

#[test]
fn a_ring_refilled_forever_cannot_hold_the_device_mutex_or_delay_stop() {
    let mem = mem();
    let ring = Ring::new(mem.clone(), N);
    for i in 0..N {
        ring.set_desc(i, d(BUF + 64 * u64::from(i), 64, WRITE, 0));
    }
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(NullIrq)));
    let max_per_call = Arc::new(AtomicU64::new(0));
    let calls = Arc::new(AtomicU64::new(0));
    let mut dev = Counted {
        rng: Rng::new(Entropy::os()),
        max_per_call: max_per_call.clone(),
        calls: calls.clone(),
    };
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    dev.activate(gm, vec![ring.queue()], vi.clone()).unwrap();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(dev));
    let ctl = Arc::new(VmControl::new());
    // The worker's budget is the queue's maximum (64); the device clamps it to N = 16.
    let worker = Worker::spawn("virtio-flood", device.clone(), vi.clone(), vec![64], ctl).unwrap();

    let done = Arc::new(AtomicBool::new(false));
    // The hostile driver: keep all N buffers posted, ring the doorbell after every refill.
    let driver = {
        let (done, worker) = (done.clone(), worker.clone());
        let mut ring = ring;
        std::thread::spawn(move || {
            let mut posted: u64 = 0;
            while !done.load(Ordering::SeqCst) {
                let used = u64::from(ring.used_idx());
                let in_flight = (posted as u16).wrapping_sub(used as u16);
                for _ in in_flight..N {
                    ring.push((posted % u64::from(N)) as u16);
                    posted += 1;
                }
                worker.notify(0);
                std::hint::spin_loop();
            }
            posted
        })
    };
    // The "vCPU": keeps taking the device mutex, as a config-space access would.
    let observer = {
        let (done, device) = (done.clone(), device.clone());
        std::thread::spawn(move || {
            let mut acquired = 0u64;
            while !done.load(Ordering::SeqCst) {
                drop(device.lock().unwrap());
                acquired += 1;
                std::thread::sleep(Duration::from_micros(200));
            }
            acquired
        })
    };
    std::thread::sleep(Duration::from_secs(1));
    let served_before_stop = calls.load(Ordering::SeqCst);
    let t0 = Instant::now();
    assert!(!worker.stop());
    let stop_took = t0.elapsed();
    done.store(true, Ordering::SeqCst);
    let posted = driver.join().unwrap();
    let acquired = observer.join().unwrap();
    let max = max_per_call.load(Ordering::SeqCst);
    say(&format!(
        "worker_budget: {served_before_stop} batches, {posted} buffers posted, max {max} chains \
         per batch, observer took the device mutex {acquired} times, stop took {stop_took:?}"
    ));
    assert!(served_before_stop > 10, "the flood was actually served");
    assert!(
        max <= u64::from(N),
        "a batch handled {max} chains (> N = {N})"
    );
    assert!(
        acquired >= 10,
        "the device mutex was released between batches"
    );
    assert!(
        stop_took < Duration::from_millis(100),
        "stop took {stop_took:?} under a ring refilled forever"
    );
    assert!(
        !vi.needs_reset(),
        "a busy but well-formed ring is not an error"
    );
}
