//! Waiting outside the guest: a parked (PSCI OFF) vCPU, and the start gate that holds the boot
//! vCPU until every vCPU exists (architecture §8.1 steps 3–4, §14.5; course ch20).
//!
//! **Why a vCPU thread ever waits on a condition variable.** A vCPU that is *off* (every
//! secondary at boot, or one that called PSCI CPU_OFF, Arm DEN 0022 §5.1.3) must not execute
//! guest code, yet its thread must stay alive: `hv_vcpu_*` calls only work on the thread that
//! created the vCPU (`hv_vcpu.h`, "Must be called by the owning thread"), so the thread that
//! will run it after a CPU_ON is the one that created it at startup. It cannot sit in
//! `hv_vcpu_run` (that would run the guest), so it sleeps on a condition variable until its
//! CPU_ON mailbox is filled or the VM stops.
//!
//! **The lost-wakeup rule.** [`wait_for`] checks the stop flag and the mailbox *while holding
//! the mutex*, and every waker (`Psci::cpu_on`, `Psci::wake_all`) changes the state or notifies
//! *while holding (or after releasing) the same mutex*. `VmControl::request_stop` sets the
//! atomic stop flag **before** it calls `wake_all`. So either the waiter's check sees the
//! flag, or the waiter is already inside `Condvar::wait` (which releases the mutex atomically)
//! when the notify comes. There is no window in which a wake can fall between the check and
//! the wait. Spurious wakeups are harmless: the loop re-checks.
//!
//! **The start gate** ([`StartGate`]). `vcpu::manager` creates the vCPUs one at a time
//! (redistributor slots follow creation order, spike finding 17). The boot vCPU must not enter
//! the guest before the last one exists: the GIC's topology is "considered final" once a vCPU
//! has run (`hv_gic.h`), and a guest that sends an IPI (GICv3 SGI) or a CPU_ON to a vCPU that
//! does not exist yet would be wrong. The gate opens exactly once, after the creation loop,
//! whether it completed or stopped early on an error (then the stop flag is already set and
//! the boot vCPU leaves without running).

use crate::sync::lock;
use std::sync::{Condvar, Mutex};

// ANCHOR: vcpu_park_wait
/// Wait on `cv` until `take` finds something in the state behind `m` (returned) or
/// `stopping()` is true (`None`). Both are checked under the lock before every wait (module
/// docs, "The lost-wakeup rule"). A poisoned lock is recovered (`sync::lock` docs): this is on
/// the path that lets a stop finish.
pub fn wait_for<T, R>(
    m: &Mutex<T>,
    cv: &Condvar,
    stopping: impl Fn() -> bool,
    mut take: impl FnMut(&mut T) -> Option<R>,
) -> Option<R> {
    let mut guard = lock(m);
    loop {
        if stopping() {
            return None;
        }
        if let Some(r) = take(&mut guard) {
            return Some(r);
        }
        guard = match cv.wait(guard) {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
    }
}
// ANCHOR_END: vcpu_park_wait

/// A one-shot gate: closed at creation, opened once, never closed again (module docs).
#[derive(Debug, Default)]
pub struct StartGate {
    open: Mutex<bool>,
    cv: Condvar,
}

impl StartGate {
    pub fn new() -> StartGate {
        StartGate::default()
    }

    /// Open the gate and release every waiter. Idempotent.
    pub fn open(&self) {
        *lock(&self.open) = true;
        self.cv.notify_all();
    }

    /// Block until the gate is open. It always opens (the manager opens it after its creation
    /// loop on every path), so this needs no stop check of its own.
    pub fn wait(&self) {
        let _ = wait_for(&self.open, &self.cv, || false, |o| o.then_some(()));
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn gate_releases_every_waiter_once_opened() {
        let g = Arc::new(StartGate::new());
        let waiters: Vec<_> = (0..4)
            .map(|_| {
                let g = Arc::clone(&g);
                std::thread::spawn(move || g.wait())
            })
            .collect();
        std::thread::sleep(Duration::from_millis(10));
        assert!(
            waiters.iter().all(|w| !w.is_finished()),
            "gate still closed"
        );
        g.open();
        for w in waiters {
            w.join().unwrap();
        }
        g.open(); // idempotent
        g.wait(); // and stays open
    }

    #[test]
    fn wait_for_sees_a_stop_set_before_the_wake() {
        let m = Arc::new(Mutex::new(0u32));
        let cv = Arc::new(Condvar::new());
        let stop = Arc::new(AtomicBool::new(false));
        let (m2, cv2, s2) = (Arc::clone(&m), Arc::clone(&cv), Arc::clone(&stop));
        let t = std::thread::spawn(move || {
            wait_for(
                &m2,
                &cv2,
                || s2.load(Ordering::SeqCst),
                |_: &mut u32| None::<()>,
            )
        });
        std::thread::sleep(Duration::from_millis(10));
        // The VmControl::request_stop order: the flag, then a notify under the lock.
        stop.store(true, Ordering::SeqCst);
        {
            let _held = lock(&m);
            cv.notify_all();
        }
        assert_eq!(t.join().unwrap(), None);
        // And a value placed under the lock is taken.
        *lock(&m) = 7;
        assert_eq!(
            wait_for(&m, &cv, || false, |v| (*v == 7).then_some(*v)),
            Some(7)
        );
    }
}
