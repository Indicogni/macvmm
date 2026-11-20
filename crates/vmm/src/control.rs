//! Stopping a VM: why it stopped ([`StopReason`]), the exit code that maps to, and the
//! [`VmControl`] that every thread uses to ask for and wait on a stop (architecture §6.7,
//! §13.2, §14.5).
//!
//! **The stop protocol** (architecture §14.5). [`VmControl::request_stop`]:
//! 1. stores the *first* reason (later ones are ignored, so the verdict is the event that
//!    actually ended the VM, not the cleanup it caused);
//! 2. sets the atomic `stopping` flag;
//! 3. kicks every registered vCPU with `hv_vcpus_exit`.
//!
//! Setting the flag *before* the kick is what makes it race-free. A vCPU checks the flag just
//! before each `hv_vcpu_run`; if it checked a moment too early, the kick is sticky and its next
//! run returns `CANCELED` at once (spike finding 19). A vCPU that was running returns
//! `CANCELED` too. Either way its loop sees the flag and ends.
//!
//! **PSCI state lives here** (M5). `VmControl` also owns the boot's [`Psci`] table (who is on,
//! the CPU_ON mailboxes), because a stop must wake a parked vCPU: `request_stop` sets the flag,
//! wakes every parked vCPU, then kicks the running ones. With SMP (M16) there is one PSCI row
//! per `--cpus` vCPU, each behind its own mutex (`psci.rs`).
//!
//! **Exit codes** ([`StopReason::exit_code`], anchored as `exit_codes`) are architecture
//! §13.2's table, the contract with scripts and the e2e harness:
//!
//! | Code | Stop reason |
//! |---|---|
//! | 0 | `PowerOff` (PSCI SYSTEM_OFF) or `DebugExit(0)` |
//! | 1 | `Vmm(e)` for an HVF, I/O or internal error (and a panic) |
//! | 2 | `Vmm(Error::Config)` and other usage/input errors |
//! | 3 | `GuestFatal`: unhandled MMIO, instruction abort, unhandled exit class, reset storm |
//! | 4 | `Reset` with `--on-reset exit` (with `reboot` the VM is rebuilt instead) |
//! | 5 | `Timeout` |
//! | 6 | `DebugExit(n)` with `n != 0` |
//! | 130 | `UserQuit` |
//!
//! **Reset storms** (HC-5). [`ResetStorm`] counts the SYSTEM_RESETs that the reboot loop
//! (`vmm::run`) turns into rebuilds: more than [`RESET_STORM_MAX`] within [`RESET_STORM_WINDOW`]
//! is `GuestFatal("reset storm")`. Its clock is injected, so the limit is host-tested.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::esr::Exit;
use crate::error::Error;
use crate::psci::Psci;
use crate::sync::lock;
use crate::trace::ExitRecord;
use crate::vcpu::regs::RegDump;
use core::fmt;
use hvf::VcpuHandle;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// A guest did something the VMM will not continue from (architecture §15). It is a verdict
/// about the guest, not an [`Error`]: exit code 3. Every field is a number, a static name or a
/// message built from them (LOG-5), never guest bytes. `vcpu/dump.rs` formats the report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuestFatal {
    /// The vCPU index, or `None` for a verdict about the whole machine ([`GuestFatal::machine`],
    /// for example the reset storm), which has no vCPU state to report.
    pub vcpu: Option<usize>,
    /// One line, for example `unhandled MMIO write at 0xc000000 size 4 pc 0x40080010`.
    pub reason: String,
    /// The guest PC at the exit.
    pub pc: u64,
    /// ESR_EL2 of the exit (0 when the exit had none).
    pub esr: u64,
    /// The faulting IPA of the exit (meaningful for aborts).
    pub ipa: u64,
    /// The guest CPSR at the exit.
    pub cpsr: u64,
    /// The instruction word at `pc`, if it could be read from RAM (MMU off: PC is an IPA).
    pub insn: Option<u32>,
    /// The decoded exit (M4).
    pub exit: Option<Exit>,
    /// The full register snapshot, captured on the vCPU's thread (M4).
    pub regs: Option<Box<RegDump>>,
    /// The vCPU's last exits, oldest first, the fatal one last (at most 32, M4).
    pub last_exits: Vec<ExitRecord>,
}

impl fmt::Display for GuestFatal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reason)
    }
}

impl GuestFatal {
    /// A verdict about the whole machine rather than one exit (for example the reset storm,
    /// HC-5): no vCPU, no register state, no exit, so [`GuestFatal::report`] is empty rather
    /// than a made-up `vcpu0: pc=0x0 (EL0t)` dump.
    pub fn machine(reason: impl Into<String>) -> GuestFatal {
        GuestFatal {
            vcpu: None,
            reason: reason.into(),
            pc: 0,
            esr: 0,
            ipa: 0,
            cpsr: 0,
            insn: None,
            exit: None,
            regs: None,
            last_exits: Vec::new(),
        }
    }

    /// The report printed under the reason (architecture §15): see `vcpu::dump`. Empty for a
    /// machine-level verdict (`vcpu` is `None`): the reason line says it all.
    pub fn report(&self) -> String {
        crate::vcpu::dump::format_fatal(self)
    }
}

/// Why a VM stopped.
#[derive(Debug)]
pub enum StopReason {
    /// PSCI SYSTEM_OFF.
    PowerOff,
    /// PSCI SYSTEM_RESET. With `--on-reset reboot` (the default) `vmm::run` rebuilds the
    /// machine instead of returning it; with `--on-reset exit` it ends the process (exit 4).
    Reset,
    /// The guest called DEBUG_EXIT with this code.
    DebugExit(u32),
    /// The guest did something fatal (exit 3).
    GuestFatal(Box<GuestFatal>),
    /// `--timeout` expired (exit 5).
    Timeout,
    /// SIGINT, SIGTERM or Ctrl-A x (exit 130; the signal path arrives in M6).
    UserQuit,
    /// The VMM or the host failed (exit 1, or 2 for a configuration error).
    Vmm(Error),
}

// ANCHOR: exit_codes
impl StopReason {
    /// The process exit code (architecture §13.2).
    pub fn exit_code(&self) -> i32 {
        match self {
            StopReason::PowerOff | StopReason::DebugExit(0) => 0,
            StopReason::Vmm(e) => e.exit_code(),
            StopReason::GuestFatal(_) => 3,
            StopReason::Reset => 4,
            StopReason::Timeout => 5,
            StopReason::DebugExit(_) => 6,
            StopReason::UserQuit => 130,
        }
    }
}
// ANCHOR_END: exit_codes

impl fmt::Display for StopReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StopReason::PowerOff => f.write_str("guest powered off"),
            StopReason::Reset => f.write_str("guest requested a reset"),
            StopReason::DebugExit(code) => write!(f, "guest exit code {code}"),
            StopReason::GuestFatal(g) => write!(f, "guest fatal: {g}"),
            StopReason::Timeout => f.write_str("timeout"),
            StopReason::UserQuit => f.write_str("user quit"),
            StopReason::Vmm(e) => write!(f, "{e}"),
        }
    }
}

/// The VM's stop flag, first stop reason, vCPU kick list and PSCI state, shared by every
/// thread of one boot.
#[derive(Debug, Default)]
pub struct VmControl {
    stopping: AtomicBool,
    reason: Mutex<Option<StopReason>>,
    changed: Condvar,
    handles: Mutex<Vec<VcpuHandle>>,
    psci: Psci,
}

impl VmControl {
    /// A control block for one vCPU (index 0, on).
    pub fn new() -> VmControl {
        VmControl::default()
    }

    /// A control block for vCPUs with these MPIDRs (vCPU 0 on, the others off).
    pub fn with_cpus(mpidrs: &[u64]) -> VmControl {
        VmControl {
            psci: Psci::new(mpidrs),
            ..VmControl::default()
        }
    }

    /// The boot's PSCI power state and mailboxes.
    pub fn psci(&self) -> &Psci {
        &self.psci
    }

    /// Park vCPU `index` after its CPU_OFF until a CPU_ON for it (returned) or the stop
    /// (`None`). Called on the vCPU's own thread, outside `hv_vcpu_run`.
    pub fn park(&self, index: usize) -> Option<crate::psci::PowerOn> {
        self.psci.park(index, || self.is_stopping())
    }

    /// True once a stop was requested. vCPU loops check it before every run.
    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// Make `h` kickable. If a stop is already under way, kick it at once (its next run then
    /// returns `CANCELED`), so a vCPU that registers late cannot miss the stop.
    pub fn register(&self, h: VcpuHandle) {
        lock(&self.handles).push(h);
        if self.is_stopping() {
            kick(&[h]);
        }
    }

    /// Forget `h` (its vCPU is about to be destroyed on its own thread).
    pub fn unregister(&self, h: VcpuHandle) {
        lock(&self.handles).retain(|x| *x != h);
    }

    // ANCHOR: vm_control_request_stop
    // ANCHOR: request_stop
    /// Ask the VM to stop for `reason`. Returns true if this was the first request (whose
    /// reason is the verdict). Callable from any thread, any number of times.
    pub fn request_stop(&self, reason: StopReason) -> bool {
        let first = {
            let mut slot = lock(&self.reason);
            let first = slot.is_none();
            if first {
                *slot = Some(reason);
            }
            first
        };
        self.stopping.store(true, Ordering::SeqCst); // the flag before the kick (module docs)
        self.kick_all_vcpus();
        self.changed.notify_all();
        first
    }
    // ANCHOR_END: request_stop
    // ANCHOR_END: vm_control_request_stop

    // ANCHOR: kick_all_vcpus
    /// Make every vCPU look at the stop flag (architecture §14.5, steps 3 and 4): wake the
    /// parked ones (PSCI OFF, waiting in `vcpu::wait` on their target's condition variable),
    /// then force the running ones out of `hv_vcpu_run` with one `hv_vcpus_exit` over every
    /// registered handle. The kick is sticky (spike finding 19): a vCPU about to enter the
    /// guest returns `CANCELED` at once. With N vCPUs this is one framework call, not N.
    fn kick_all_vcpus(&self) {
        self.psci.wake_all();
        let handles = lock(&self.handles).clone();
        kick(&handles);
    }
    // ANCHOR_END: kick_all_vcpus

    /// Block until a stop is requested or `deadline` passes. Returns true if stopped.
    pub fn wait_until(&self, deadline: Option<Instant>) -> bool {
        let mut slot = lock(&self.reason);
        loop {
            if slot.is_some() {
                return true;
            }
            let wait = match deadline {
                None => Duration::from_secs(3600),
                Some(d) => match d.checked_duration_since(Instant::now()) {
                    Some(left) if !left.is_zero() => left,
                    _ => return false,
                },
            };
            slot = match self.changed.wait_timeout(slot, wait) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    /// Sleep up to `d` on this VM's condition variable, waking early when a stop is requested
    /// (the no-GIC WFI sleep, architecture §9.1: bounded by the caller's slice and never able
    /// to delay a stop). Returns true if the VM is stopping.
    pub fn sleep_unless_stopped(&self, d: Duration) -> bool {
        let slot = lock(&self.reason);
        if slot.is_some() || self.is_stopping() {
            return true;
        }
        let slot = match self.changed.wait_timeout(slot, d) {
            Ok((guard, _)) => guard,
            Err(poisoned) => poisoned.into_inner().0,
        };
        slot.is_some() || self.is_stopping()
    }

    /// Take the stop reason (once the VM's threads are joined).
    pub fn take_reason(&self) -> Option<StopReason> {
        lock(&self.reason).take()
    }
}

/// More than this many SYSTEM_RESETs within [`RESET_STORM_WINDOW`] is a reset storm (HC-5).
pub const RESET_STORM_MAX: usize = 10;
/// The sliding window of the reset-storm limit (HC-5).
pub const RESET_STORM_WINDOW: Duration = Duration::from_secs(10);

/// The reset-storm limiter (HC-5): a sliding window of the last resets' times. A guest that
/// resets in a loop would otherwise turn the rebuild path (VM create, RAM allocation, DTB)
/// into a host CPU and VM-churn loop.
#[derive(Debug, Default)]
pub struct ResetStorm {
    times: VecDeque<Instant>,
}

impl ResetStorm {
    pub fn new() -> ResetStorm {
        ResetStorm::default()
    }

    /// Record a reset at `now`; true if it makes a storm (the 11th within 10 s). `now` is
    /// injected so tests need no sleeps; times must not go backwards (`Instant` never does).
    pub fn record(&mut self, now: Instant) -> bool {
        while let Some(&t) = self.times.front() {
            // A reset exactly 10 s ago has left the window.
            if now
                .checked_duration_since(t)
                .is_some_and(|age| age >= RESET_STORM_WINDOW)
            {
                self.times.pop_front();
            } else {
                break;
            }
        }
        self.times.push_back(now);
        self.times.len() > RESET_STORM_MAX
    }
}

fn kick(handles: &[VcpuHandle]) {
    if let Err(e) = hvf::vcpus_exit(handles) {
        // A stale handle (vCPU already destroyed) is harmless; anything else is worth a line.
        crate::debug!("hv_vcpus_exit: {e}");
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;
    use std::sync::Arc;

    /// The no-GIC WFI sleep ends early on a stop from another thread (security checklist M8:
    /// stop is never blocked by WFI).
    #[test]
    fn sleep_is_interrupted_by_stop() {
        let ctl = Arc::new(VmControl::new());
        let t = Instant::now();
        assert!(!ctl.sleep_unless_stopped(Duration::from_millis(20)));
        assert!(t.elapsed() >= Duration::from_millis(15));
        let c2 = Arc::clone(&ctl);
        let h = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            c2.request_stop(StopReason::Timeout);
        });
        let t = Instant::now();
        assert!(ctl.sleep_unless_stopped(Duration::from_secs(30)));
        assert!(t.elapsed() < Duration::from_secs(5));
        h.join().unwrap();
        assert!(
            ctl.sleep_unless_stopped(Duration::from_secs(30)),
            "already stopping"
        );
    }

    #[test]
    fn exit_codes() {
        // The whole §13.2 table, including the machine-level fatal (reset storm, HC-5).
        let storm = StopReason::GuestFatal(Box::new(GuestFatal::machine("reset storm")));
        assert_eq!(storm.exit_code(), 3);
        assert_eq!(storm.to_string(), "guest fatal: reset storm");
        // No invented vCPU state under a machine-level verdict.
        assert_eq!(GuestFatal::machine("reset storm").report(), "");
        assert_eq!(StopReason::Vmm(Error::Internal("panic")).exit_code(), 1);
        exit_codes_match_architecture_13_2();
    }

    #[test]
    fn reset_storm_window() {
        let t0 = Instant::now();
        let mut s = ResetStorm::new();
        for i in 0..10u64 {
            assert!(!s.record(t0 + Duration::from_millis(i * 100)), "reset {i}");
        }
        assert!(
            s.record(t0 + Duration::from_millis(1000)),
            "the 11th within 10 s"
        );
        let mut s = ResetStorm::new();
        for i in 0..30u64 {
            assert!(
                !s.record(t0 + Duration::from_millis(i * 1100)),
                "spread: reset {i}"
            );
        }
    }

    #[test]
    fn stop_wakes_a_parked_vcpu() {
        let ctl = Arc::new(VmControl::with_cpus(&[0x8000_0000, 0x8000_0001]));
        let c2 = Arc::clone(&ctl);
        let t = std::thread::spawn(move || c2.park(1));
        std::thread::sleep(Duration::from_millis(20));
        ctl.request_stop(StopReason::PowerOff);
        assert_eq!(t.join().unwrap(), None);
        // And a CPU_ON reaches a parked vCPU.
        let ctl = Arc::new(VmControl::with_cpus(&[0x8000_0000, 0x8000_0001]));
        let c2 = Arc::clone(&ctl);
        let t = std::thread::spawn(move || c2.park(1));
        assert_eq!(ctl.psci().cpu_on(1, 0x4008_0000, 7, true), Ok(1));
        let on = t.join().unwrap().unwrap();
        assert_eq!((on.entry, on.ctx), (0x4008_0000, 7));
        assert_eq!(ctl.psci().state(1), Some(crate::psci::CpuPower::On));
    }

    fn exit_codes_match_architecture_13_2() {
        let fatal = StopReason::GuestFatal(Box::new(GuestFatal {
            vcpu: Some(0),
            reason: "x".into(),
            pc: 0,
            esr: 0,
            ipa: 0,
            cpsr: 0,
            insn: None,
            exit: None,
            regs: None,
            last_exits: Vec::new(),
        }));
        let cases = [
            (StopReason::PowerOff, 0),
            (StopReason::DebugExit(0), 0),
            (StopReason::Vmm(Error::Internal("bug")), 1),
            (StopReason::Vmm(Error::Config("bad".into())), 2),
            (fatal, 3),
            (StopReason::Reset, 4),
            (StopReason::Timeout, 5),
            (StopReason::DebugExit(1), 6),
            (StopReason::DebugExit(u32::MAX), 6),
            (StopReason::UserQuit, 130),
        ];
        for (r, code) in cases {
            assert_eq!(r.exit_code(), code, "{r}");
        }
    }

    #[test]
    fn first_reason_wins_and_wakes_waiters() {
        let ctl = Arc::new(VmControl::new());
        assert!(!ctl.is_stopping());
        let deadline = Instant::now() + Duration::from_millis(20);
        assert!(!ctl.wait_until(Some(deadline)), "nothing stopped it");
        let c2 = Arc::clone(&ctl);
        let t = std::thread::spawn(move || c2.wait_until(None));
        assert!(ctl.request_stop(StopReason::DebugExit(7)));
        assert!(!ctl.request_stop(StopReason::Timeout));
        assert!(t.join().unwrap());
        assert!(ctl.is_stopping());
        assert!(matches!(ctl.take_reason(), Some(StopReason::DebugExit(7))));
        assert!(ctl.take_reason().is_none());
    }

    #[test]
    fn report_has_numbers_only() {
        let g = GuestFatal {
            vcpu: Some(0),
            reason: "unhandled MMIO write at 0xc000000 size 4 pc 0x40080010".into(),
            pc: 0x4008_0010,
            esr: 0x9381_0046,
            ipa: 0x0c00_0000,
            cpsr: 0x3c5,
            insn: Some(0xb900_0001),
            exit: Some(Exit::decode(0x9381_0046)),
            regs: None,
            last_exits: Vec::new(),
        };
        let r = g.report();
        assert!(r.starts_with("vcpu0: data abort (EC 0x24): ISV=1"), "{r}");
        assert!(r.contains("esr=0x93810046 ipa=0xc000000"), "{r}");
        assert!(r.contains("insn at pc: 0xb9000001"), "{r}");
        assert!(
            StopReason::GuestFatal(Box::new(g))
                .to_string()
                .starts_with("guest fatal: ")
        );
    }
}
