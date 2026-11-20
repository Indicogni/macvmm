//! PLAN M14 security test (threat model VQ-12, flaw F8; virtio-blk's cost budget, `blk.rs`
//! module docs "Batches"): a blk ring kept full of expensive requests must not keep the worker
//! inside one long batch.
//!
//! `worker_budget.rs` (M12) proves the chain-count budget with rng, where every chain is
//! cheap. For blk one chain can move 8 MiB or run an `F_FULLFSYNC`, so a full ring of 64 such
//! chains would hold the device mutex for seconds on slow media. Here a hostile "driver"
//! thread keeps 64 requests posted, alternating a 1 MiB OUT and a FLUSH, over a backend that
//! is deliberately slow (30 ms per sync, 2 ms per 64 KiB write). The worker must
//! 1. end each batch after at most one sync (so at most an OUT and a FLUSH: ~60 ms), which is
//!    also the longest the device mutex is held in one go, and
//! 2. stop within a bound set by one batch, not by the ring (without the cost budget a batch
//!    is 32 × (32 ms + 30 ms) ≈ 2 s).
//!
//! A "vCPU" thread also takes the device mutex in a loop, and its count and worst wait are
//! printed but **not asserted**: `std::sync::Mutex` is not fair, and the worker re-locks the
//! device for its next batch nanoseconds after unlocking it, before a parked waiter has woken.
//! Under a flood that never lets the worker go idle the waiter can lose many hand-offs in a
//! row. That is a property of the worker loop (M12, `worker.rs`), not of blk's batch bound.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::backend::file::BlockBackend;
use vmm::control::VmControl;
use vmm::irq::NullIrq;
use vmm::memory::prelude::*;
use vmm::virtio::blk::req;
use vmm::virtio::{Blk, Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt, Worker};

/// The ring size: 32 OUTs and 32 FLUSHes in flight at all times.
const N: u16 = 64;
const SYNC_DELAY: Duration = Duration::from_millis(30);
const WRITE_DELAY: Duration = Duration::from_millis(2); // per 64 KiB bounce buffer
/// 4 × 256 KiB overlapping data descriptors per OUT.
const SEG: u32 = 256 * 1024;
const SEGS: u16 = 4;

/// Guest RAM layout (inside the 1 MiB `mem()`).
const HDRS: u64 = BUF; // 16 bytes per head
const STATUSES: u64 = BUF + 0x800; // 1 byte per head
const TABLES: u64 = BUF + 0x1_0000; // 0x100 bytes of indirect table per head
const DATA: u64 = BUF + 0x4_0000; // 256 KiB, shared by every OUT

/// A disk that stores nothing and is slow on purpose.
struct SlowDisk {
    syncs: AtomicU64,
}

impl BlockBackend for SlowDisk {
    fn capacity_sectors(&self) -> u64 {
        1 << 21 // 1 GiB
    }
    fn read_only(&self) -> bool {
        false
    }
    fn read_at(&self, buf: &mut [u8], _offset: u64) -> io::Result<usize> {
        Ok(buf.len())
    }
    fn write_at(&self, buf: &[u8], _offset: u64) -> io::Result<usize> {
        std::thread::sleep(WRITE_DELAY);
        Ok(buf.len())
    }
    fn sync(&self) -> io::Result<()> {
        std::thread::sleep(SYNC_DELAY);
        self.syncs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// Blk plus a record of the most requests and the longest time in one `process_queue` call.
struct Timed {
    blk: Blk,
    max_per_call: Arc<AtomicU64>,
    max_call_us: Arc<AtomicU64>,
    calls: Arc<AtomicU64>,
}

impl VirtioDevice for Timed {
    fn device_id(&self) -> u32 {
        self.blk.device_id()
    }
    fn queue_max_sizes(&self) -> &[u16] {
        self.blk.queue_max_sizes()
    }
    fn device_features(&self) -> u64 {
        self.blk.device_features()
    }
    fn ack_features(&mut self, a: u64) {
        self.blk.ack_features(a);
    }
    fn config_len(&self) -> u32 {
        self.blk.config_len()
    }
    fn read_config(&self, o: u32, d: &mut [u8]) {
        self.blk.read_config(o, d);
    }
    fn write_config(&mut self, o: u32, d: &[u8]) {
        self.blk.write_config(o, d);
    }
    fn activate(
        &mut self,
        m: Arc<dyn GuestMemoryOrdered>,
        q: Vec<Queue>,
        i: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        self.blk.activate(m, q, i)
    }
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        let count = |s: vmm::virtio::blk::BlkStats| s.writes + s.flushes + s.ioerr;
        let before = count(self.blk.stats());
        let t0 = Instant::now();
        let r = self.blk.process_queue(index, budget);
        let us = t0.elapsed().as_micros() as u64;
        self.max_call_us.fetch_max(us, Ordering::SeqCst);
        self.max_per_call
            .fetch_max(count(self.blk.stats()) - before, Ordering::SeqCst);
        self.calls.fetch_add(1, Ordering::SeqCst);
        r
    }
    fn reset(&mut self) {
        self.blk.reset();
    }
}

fn header(kind: u32) -> [u8; 16] {
    let mut h = [0u8; 16];
    h[..4].copy_from_slice(&kind.to_le_bytes());
    h
}

#[test]
fn a_ring_of_slow_requests_cannot_hold_the_device_mutex_or_delay_stop() {
    let mem = mem();
    let ring = Ring::new(mem.clone(), N);
    // Head i: an indirect table. Even heads are a 1 MiB OUT, odd heads a FLUSH.
    for i in 0..N {
        let (hdr, status, table) = (
            HDRS + 16 * u64::from(i),
            STATUSES + u64::from(i),
            TABLES + 0x100 * u64::from(i),
        );
        let n = if i % 2 == 0 {
            mem.write(GuestAddress(hdr), &header(req::OUT)).unwrap();
            ring.set_desc_at(table, 0, d(hdr, 16, NEXT, 1));
            for s in 0..SEGS {
                ring.set_desc_at(table, 1 + s, d(DATA, SEG, NEXT, 2 + s));
            }
            ring.set_desc_at(table, 1 + SEGS, d(status, 1, WRITE, 0));
            SEGS + 2
        } else {
            mem.write(GuestAddress(hdr), &header(req::FLUSH)).unwrap();
            ring.set_desc_at(table, 0, d(hdr, 16, NEXT, 1));
            ring.set_desc_at(table, 1, d(status, 1, WRITE, 0));
            2
        };
        ring.set_desc(i, d(table, 16 * u32::from(n), INDIRECT, 0));
    }
    let disk = Arc::new(SlowDisk {
        syncs: AtomicU64::new(0),
    });
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(NullIrq)));
    let max_per_call = Arc::new(AtomicU64::new(0));
    let max_call_us = Arc::new(AtomicU64::new(0));
    let calls = Arc::new(AtomicU64::new(0));
    let mut dev = Timed {
        blk: Blk::new(disk.clone(), 0),
        max_per_call: max_per_call.clone(),
        max_call_us: max_call_us.clone(),
        calls: calls.clone(),
    };
    // Linux's choice: every offered feature, so FLUSH is negotiated (write-back).
    let all = dev.device_features();
    dev.ack_features(all);
    let mut q = ring.queue();
    q.set_indirect(true);
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    dev.activate(gm, vec![q], vi.clone()).unwrap();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(dev));
    let ctl = Arc::new(VmControl::new());
    let worker =
        Worker::spawn("virtio-blk-slow", device.clone(), vi.clone(), vec![N], ctl).unwrap();

    let done = Arc::new(AtomicBool::new(false));
    // The hostile driver: keep all N requests posted, ring the doorbell after every refill.
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
                std::thread::sleep(Duration::from_micros(100));
            }
            posted
        })
    };
    // The "vCPU": keeps taking the device mutex, as a config-space access or a reset would.
    let observer = {
        let (done, device) = (done.clone(), device.clone());
        std::thread::spawn(move || {
            let (mut acquired, mut worst) = (0u64, Duration::ZERO);
            while !done.load(Ordering::SeqCst) {
                let t0 = Instant::now();
                drop(device.lock().unwrap());
                worst = worst.max(t0.elapsed());
                acquired += 1;
                std::thread::sleep(Duration::from_millis(1));
            }
            (acquired, worst)
        })
    };
    std::thread::sleep(Duration::from_millis(1500));
    let batches = calls.load(Ordering::SeqCst);
    let t0 = Instant::now();
    assert!(!worker.stop());
    let stop_took = t0.elapsed();
    done.store(true, Ordering::SeqCst);
    let posted = driver.join().unwrap();
    let (acquired, worst_wait) = observer.join().unwrap();
    let max = max_per_call.load(Ordering::SeqCst);
    let longest = Duration::from_micros(max_call_us.load(Ordering::SeqCst));
    say(&format!(
        "blk_budget: {batches} batches, {posted} requests posted, {} syncs, max {max} requests \
         and {longest:?} per batch, observer took the device mutex {acquired} times (worst wait \
         {worst_wait:?}), stop took {stop_took:?}",
        disk.syncs.load(Ordering::SeqCst)
    ));
    assert!(batches > 10, "the flood was actually served");
    assert!(
        max <= 2,
        "a batch handled {max} requests: more than an OUT and one FLUSH"
    );
    // One batch is at most an OUT (16 × 2 ms) and a FLUSH (30 ms) ≈ 62 ms; allow scheduling
    // slack, but stay far below the ≈ 2 s a ring's worth would take.
    let bound = Duration::from_millis(250);
    assert!(longest < bound, "one batch held the mutex for {longest:?}");
    assert!(
        stop_took < bound,
        "stop took {stop_took:?} under a ring of slow requests"
    );
    assert!(
        !vi.needs_reset(),
        "a slow but well-formed ring is not an error"
    );
}
