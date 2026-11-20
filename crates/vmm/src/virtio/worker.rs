//! The device worker: one host thread per virtio device that does the device's work off the
//! vCPU thread (architecture §14.1, §14.3; threat model VQ-12, RUST-7; course ch17).
//!
//! **Why a separate thread.** A QueueNotify is an MMIO write, so it arrives on a vCPU thread
//! that is *outside* `hv_vcpu_run` while we handle it: the guest CPU is stopped until the
//! handler returns. Processing the queue right there (what M11 does, inline) means a disk read
//! or a burst of entropy requests is time the guest cannot run, and a guest that keeps
//! refilling its ring keeps its own vCPU (and the device mutex) busy. So the vCPU only rings a
//! doorbell here ([`Worker::notify`]: set a bit, wake a condvar, return in microseconds) and
//! this thread does the work. It is the same split as a real device: the driver writes a
//! register, the device's own engine reads the rings.
//!
//! **The loop** (anchor `worker_loop`):
//! 1. sleep on the condvar until a queue bit is pending (or stop);
//! 2. take *all* pending bits at once. Ten doorbells that arrived while we were busy become
//!    one pass: **notify coalescing**, which is safe because a notify carries no data, it only
//!    says "look at the ring", and one look sees every buffer published so far (virtio 1.2
//!    §2.7.13: the driver may batch notifications, and the device must not rely on getting one
//!    per buffer);
//! 3. for each pending queue: lock the device, `process_queue(index, budget)`, report an error
//!    (step 5) while the lock is still held, **unlock**;
//! 4. `QueueProgress::MoreWork` means the budget ran out with buffers left: set the bit again
//!    and go round, which first passes the stop and pause checks;
//! 5. an `Err` is the guest's fault: DEVICE_NEEDS_RESET plus a config interrupt
//!    (`mmio::report_error`, VQ-10). The worker itself keeps running and serves the device
//!    again after the driver resets it.
//!
//! **The budget (VQ-12, flaw F8).** One `process_queue` call handles at most `budget` chains,
//! the queue's maximum size `N` (the device clamps it to the size the driver chose). Without
//! it a guest that refills the ring as fast as we drain it would keep this thread inside one
//! call forever: holding the device mutex (so a vCPU's config-space read would hang, §14.2),
//! and never reaching the stop check (so the VM could not be stopped). With it the mutex is
//! released at least once every `N` chains and [`Worker::stop`] returns within one batch
//! (`worker_budget.rs` measures both).
//!
//! **Reset races.** The driver may write Status = 0 while a batch runs. The transport's reset
//! takes the device mutex, so it waits for the batch to finish and then drops the queues
//! (VQ-14). A doorbell still pending at that moment finds the device not activated
//! (`VirtioError::NotActivated`): that is not the guest's fault and is ignored, never turned
//! into NEEDS_RESET on the freshly reset device. A batch that *failed* latches NEEDS_RESET
//! before it releases the device mutex (lock order device → interrupt, architecture §14.2), so
//! a reset waiting on that mutex always runs after the latch and its `interrupt.reset()`
//! clears it. Reporting after the unlock would let the reset slip in between and leave the
//! fresh device stuck in NEEDS_RESET (`virtio_worker.rs`
//! `a_failed_batch_racing_a_reset_never_marks_the_fresh_device`).
//!
//! **Panics (RUST-7, flaw F15).** A panic here is a macvmm bug. A guard on the thread notices
//! the unwind, records it, and asks the VM to stop with exit code 1
//! (`StopReason::Vmm(Error::Internal)`). The guard also marks the worker stopped and wakes a
//! waiting [`Worker::pause`], which would otherwise wait forever for a pass that never ends.
//! The device mutex is then poisoned. The transport treats a poisoned device as dead (every
//! register RAZ/WI, `mmio.rs`), so the VM never keeps running on device state the panic may
//! have left half-updated; `sync::lock` recovers the mutex only on the shutdown path.
//! [`final_reason`] makes the panic the verdict even when a guest stop was posted first.
//!
//! **Pause** is the seam for snapshots and the gdbstub (architecture §14.5): [`Worker::pause`]
//! returns once the worker is between batches, and no batch starts until [`Worker::resume`].
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::mmio::{QueueNotifier, report_error};
use super::{QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt};
use crate::control::{StopReason, VmControl};
use crate::error::Error;
use crate::sync::lock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;

/// The most queues one worker serves: one bit each in the pending mask. No v1 device has more
/// than 2 (architecture §11.3).
pub const MAX_WORKER_QUEUES: usize = 64;

/// The verdict a worker panic posts (RUST-7: exit code 1).
pub const WORKER_PANIC: &str = "a virtio worker thread panicked";

#[derive(Debug, Default)]
struct State {
    /// Bit `i`: queue `i` was notified (or re-queued itself) and has not been looked at yet.
    pending: u64,
    stop: bool,
    paused: bool,
    /// The worker is between taking the pending bits and finishing that pass.
    busy: bool,
}

/// What the worker thread and its handle share.
#[derive(Debug, Default)]
struct Shared {
    state: Mutex<State>,
    /// Wakes the worker: a doorbell, stop, resume.
    wake: Condvar,
    /// Wakes `pause()`: the worker finished a pass.
    idle: Condvar,
    panicked: AtomicBool,
    /// `process_queue` calls made (tests and `--stats`).
    batches: AtomicU64,
}

impl Shared {
    fn wait<'a>(cv: &Condvar, g: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        cv.wait(g).unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

// ANCHOR: worker_companion
/// Another host thread that belongs to the same device (a NIC's RX thread, for example). It is
/// attached to the device's worker ([`Worker::attach`]) so the machine needs no second list:
/// stopping the worker stops and joins its companions too (before guest RAM is freed),
/// and their `--stats` lines come out with the worker's ([`Worker::companion_stats`]).
pub trait Companion: Send + Sync {
    /// Stop the thread and join it. Idempotent. Returns true if it panicked.
    fn stop(&self) -> bool;
    /// One `--stats` line (numbers and static names only, never guest text), if it has counters.
    fn stats(&self) -> Option<String> {
        None
    }
}
// ANCHOR_END: worker_companion

/// A device's worker thread and the handle that rings its doorbell (module docs). It is the
/// transport's [`QueueNotifier`]. Dropping it stops and joins the thread.
pub struct Worker {
    name: String,
    shared: Arc<Shared>,
    thread: Mutex<Option<JoinHandle<()>>>,
    queues: usize,
    /// M24: threads stopped and joined with this one ([`Companion`]).
    companions: Mutex<Vec<Arc<dyn Companion>>>,
}

impl core::fmt::Debug for Worker {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Worker")
            .field("name", &self.name)
            .field("queues", &self.queues)
            .field("panicked", &self.panicked())
            .finish_non_exhaustive()
    }
}

/// Everything the thread owns. Nothing here points back at the transport (lock order §14.2:
/// device → interrupt, never transport).
struct Job {
    shared: Arc<Shared>,
    device: Arc<Mutex<dyn VirtioDevice>>,
    interrupt: Arc<VirtioInterrupt>,
    budgets: Vec<u16>,
    ctl: Arc<VmControl>,
}

/// Posts the RUST-7 stop if the worker thread unwinds.
struct PanicGuard {
    shared: Arc<Shared>,
    ctl: Arc<VmControl>,
}

impl Drop for PanicGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.shared.panicked.store(true, Ordering::SeqCst);
            {
                // The pass never reaches `finish_pass`: end it here so `pause()` returns.
                // Poison recovery is fine: this is the shutdown path (sync.rs).
                let mut s = lock(&self.shared.state);
                s.busy = false;
                s.stop = true;
                self.shared.idle.notify_all();
            }
            self.ctl
                .request_stop(StopReason::Vmm(Error::Internal(WORKER_PANIC)));
        }
    }
}

/// Stop and join every worker (each finishes its current batch, VQ-12). True if any panicked.
/// Every worker is stopped even after one reports a panic.
pub fn stop_all(workers: &[Arc<Worker>]) -> bool {
    workers.iter().fold(false, |any, w| w.stop() | any)
}

// ANCHOR: worker_final_reason
/// The run's verdict once the vCPUs are joined and the workers stopped (RUST-7). A worker panic
/// wins over whatever the vCPUs report: `VmControl` keeps the *first* stop reason, so a guest
/// SYSTEM_OFF posted a moment before the panic would otherwise hide a macvmm bug behind exit 0.
pub fn final_reason(vcpu_reason: StopReason, workers_panicked: bool) -> StopReason {
    if workers_panicked {
        StopReason::Vmm(Error::Internal(WORKER_PANIC))
    } else {
        vcpu_reason
    }
}
// ANCHOR_END: worker_final_reason

impl Worker {
    /// Start the worker thread `name` for `device`, whose queues have the maximum sizes
    /// `budgets` (one entry per queue: the VQ-12 budget). `interrupt` is the device's
    /// (for NEEDS_RESET); `ctl` is the VM a panic stops (RUST-7).
    pub fn spawn(
        name: &str,
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<VirtioInterrupt>,
        budgets: Vec<u16>,
        ctl: Arc<VmControl>,
    ) -> std::io::Result<Arc<Worker>> {
        if budgets.len() > MAX_WORKER_QUEUES {
            return Err(std::io::Error::other("a virtio device has too many queues"));
        }
        let shared = Arc::new(Shared::default());
        let queues = budgets.len();
        let job = Job {
            shared: Arc::clone(&shared),
            device,
            interrupt,
            budgets,
            ctl,
        };
        let thread = std::thread::Builder::new()
            .name(name.to_owned())
            .spawn(move || job.run())?;
        Ok(Arc::new(Worker {
            name: name.to_owned(),
            shared,
            thread: Mutex::new(Some(thread)),
            queues,
            companions: Mutex::new(Vec::new()),
        }))
    }

    /// M24: stop and join `c` together with this worker ([`Companion`]). A companion attached
    /// after [`stop`](Self::stop) is stopped at once.
    pub fn attach(&self, c: Arc<dyn Companion>) {
        let stopped = lock(&self.shared.state).stop;
        if stopped {
            c.stop();
        }
        lock(&self.companions).push(c);
    }

    /// The companions' `--stats` lines.
    pub fn companion_stats(&self) -> Vec<String> {
        lock(&self.companions)
            .iter()
            .filter_map(|c| c.stats())
            .collect()
    }

    // ANCHOR: worker_notify
    /// The doorbell (on a vCPU thread): mark queue `queue` pending and wake the worker. Never
    /// blocks on the device: the state mutex is held only by the worker's bookkeeping, never
    /// across a batch.
    pub fn notify(&self, queue: usize) {
        let Some(bit) = u32::try_from(queue).ok().and_then(|q| 1u64.checked_shl(q)) else {
            crate::guest_warn!(
                "virtio worker {}: notify for queue {queue:?} ignored",
                self.name
            );
            return;
        };
        if queue >= self.queues {
            crate::guest_warn!(
                "virtio worker {}: notify for queue {queue:?} ignored",
                self.name
            );
            return;
        }
        let mut s = lock(&self.shared.state);
        s.pending |= bit; // ten doorbells before the worker wakes are one bit (coalescing)
        self.shared.wake.notify_one();
    }
    // ANCHOR_END: worker_notify

    // ANCHOR: worker_stop
    /// Stop the thread and wait for it: it finishes the batch in progress (at most `N` chains,
    /// its budget) and exits. Idempotent. Returns true if the thread panicked.
    pub fn stop(&self) -> bool {
        {
            let mut s = lock(&self.shared.state);
            s.stop = true;
            self.shared.wake.notify_all();
            self.shared.idle.notify_all(); // a waiting `pause()` returns too
        }
        let handle = lock(&self.thread).take();
        if let Some(h) = handle
            && h.join().is_err()
        {
            self.shared.panicked.store(true, Ordering::SeqCst);
        }
        // The companions (a NIC's RX thread) go with the worker. Every one is stopped,
        // even after one reports a panic.
        let companions: Vec<Arc<dyn Companion>> = lock(&self.companions).clone();
        let companion_panicked = companions.iter().fold(false, |any, c| c.stop() | any);
        if companion_panicked {
            self.shared.panicked.store(true, Ordering::SeqCst);
        }
        self.panicked()
    }
    // ANCHOR_END: worker_stop

    /// True if the worker thread panicked.
    pub fn panicked(&self) -> bool {
        self.shared.panicked.load(Ordering::SeqCst)
    }

    /// Hold the worker at a batch boundary: returns once no batch is running; none starts
    /// until [`resume`](Self::resume). Doorbells keep accumulating meanwhile. Returns at once
    /// if the worker stopped or panicked (no batch can run then).
    pub fn pause(&self) {
        let mut s = lock(&self.shared.state);
        s.paused = true;
        while s.busy && !s.stop && !self.panicked() {
            s = Shared::wait(&self.shared.idle, s);
        }
    }

    /// Undo [`pause`](Self::pause).
    pub fn resume(&self) {
        let mut s = lock(&self.shared.state);
        s.paused = false;
        self.shared.wake.notify_all();
    }

    /// `process_queue` calls made so far.
    pub fn batches(&self) -> u64 {
        self.shared.batches.load(Ordering::SeqCst)
    }

    /// The thread's name (`virtio-<device>-<slot>`).
    pub fn name(&self) -> &str {
        &self.name
    }
}

impl QueueNotifier for Worker {
    fn notify(&self, queue: usize) {
        Worker::notify(self, queue);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Job {
    /// The thread body (module docs, steps 1–5).
    fn run(self) {
        let _guard = PanicGuard {
            shared: Arc::clone(&self.shared),
            ctl: Arc::clone(&self.ctl),
        };
        // ANCHOR: worker_loop
        while let Some(mask) = self.wait_for_work() {
            let mut requeue = 0u64;
            for (index, &budget) in self.budgets.iter().enumerate() {
                let bit = 1u64.checked_shl(u32::try_from(index).unwrap_or(u32::MAX));
                let Some(bit) = bit.filter(|b| mask & b != 0) else {
                    continue;
                };
                if self.interrupt.needs_reset() {
                    // The device already failed; nothing is processed until Status = 0
                    // resets it. The doorbell is dropped, not kept.
                    continue;
                }
                // The device mutex is held for exactly one batch of at most `budget` chains,
                // and for the error report: a Status = 0 reset waiting on this mutex then runs
                // after NEEDS_RESET is latched and clears it (module docs, "Reset races").
                let mut device = lock(&self.device);
                let progress = device.process_queue(index, budget);
                self.shared.batches.fetch_add(1, Ordering::SeqCst);
                match progress {
                    Ok(QueueProgress::Drained) => {}
                    Ok(QueueProgress::MoreWork) => requeue |= bit,
                    // A reset raced the doorbell (module docs): not the guest's fault.
                    Err(VirtioError::NotActivated) => {}
                    Err(e) => report_error(&self.interrupt, index, &e),
                }
                drop(device);
            }
            self.finish_pass(requeue);
        }
        // ANCHOR_END: worker_loop
    }

    // ANCHOR: worker_wait
    /// Sleep until a queue is pending (and not paused); take every pending bit. `None` on stop.
    fn wait_for_work(&self) -> Option<u64> {
        let mut s = lock(&self.shared.state);
        loop {
            if s.stop {
                return None;
            }
            if !s.paused && s.pending != 0 {
                s.busy = true;
                return Some(core::mem::take(&mut s.pending));
            }
            s = Shared::wait(&self.shared.wake, s);
        }
    }

    /// End of a pass: re-queue what ran out of budget (it goes round through the stop and
    /// pause checks first) and tell a waiting `pause()` that no batch is running.
    fn finish_pass(&self, requeue: u64) {
        let mut s = lock(&self.shared.state);
        s.pending |= requeue;
        s.busy = false;
        self.shared.idle.notify_all();
    }
    // ANCHOR_END: worker_wait
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::irq::NullIrq;
    use crate::virtio::NullDevice;

    #[test]
    fn notify_out_of_range_is_ignored_and_stop_is_idempotent() {
        let ctl = Arc::new(VmControl::new());
        let irq = Arc::new(VirtioInterrupt::new(Arc::new(NullIrq)));
        let dev: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(NullDevice));
        let w = Worker::spawn("t", dev, irq, vec![8], ctl.clone()).unwrap();
        w.notify(1);
        w.notify(64);
        w.notify(usize::MAX);
        assert!(!w.stop());
        assert!(!w.stop());
        assert_eq!(w.batches(), 0);
        assert!(!ctl.is_stopping());
        let too_many = vec![1u16; MAX_WORKER_QUEUES + 1];
        let dev: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(NullDevice));
        let irq = Arc::new(VirtioInterrupt::new(Arc::new(NullIrq)));
        assert!(Worker::spawn("t", dev, irq, too_many, ctl).is_err());
    }
}
