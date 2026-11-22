//! Guest time: the virtual counter's offset, its restore rule, the PL031's time base, and the
//! no-GIC timer logic of the ch11 teaching mode (architecture §8.1 step 5, §9, §9.1; course
//! ch11, ch12).
//!
//! **The counter offset.** A guest reads time from the generic timer's virtual counter,
//! `CNTVCT_EL0` (ARM ARM DDI 0487, D11.1 "The Generic Timer", D11.2.4 "The virtual counter").
//! The architecture defines it as the physical count minus `CNTVOFF_EL2`; Hypervisor.framework
//! exposes that offset per vCPU, so `CNTVCT_EL0 = mach_absolute_time() - vtimer_offset`
//! (`hv_vcpu.h`, `hv_vcpu_set_vtimer_offset`; one tick is 1/24 MHz, spike finding 4). A guest
//! expects two things of it:
//! 1. it **starts near zero** at boot, like a real machine's counter after reset. The boot
//!    offset is therefore `mach_absolute_time()` captured once per boot ([`boot_offset`]);
//! 2. it **never runs backwards**, and is the same on every CPU. Every vCPU gets the same
//!    offset before its first run (architecture §8.1 step 5), and after a gap (pause, snapshot
//!    restore, M25) the offset is recomputed from the counter value the guest last saw:
//!    `offset = mach_now − saved_cntvct` ([`restore_offset`]), so the guest resumes exactly
//!    where it stopped. The subtraction is modulo 2^64, like the hardware's: even a saved
//!    value above the current host count (a restore on another boot of the Mac) gives an
//!    offset under which the counter continues from `saved_cntvct`.
//!
//! **The PL031 time base** is the host's *wall* clock, not this counter: an RTC tells the date.
//! Architecture §9 described it as "SystemTime at boot + elapsed"; M6 refined that to reading
//! `SystemTime` on every access, clamped to never go backwards, because a monotonic clock stops
//! while the Mac sleeps (`devices/pl031.rs` module docs). [`pl031_time_base`] is that clock.
//!
//! **The no-GIC teaching mode** (`--irqchip none`, architecture §9.1). Without an interrupt
//! controller, Hypervisor.framework hands the timer to us: when `CNTV` fires it returns
//! `HV_EXIT_REASON_VTIMER_ACTIVATED` and masks the vtimer itself, and a WFI exits with EC 0x01
//! (spike findings 10, 12). The VMM then *is* the interrupt controller for one line:
//!
//! | Event | VMM action ([`NoGicTimer`]) |
//! |---|---|
//! | `VTIMER_ACTIVATED` | assert the vCPU's IRQ line; leave the vtimer masked; PC unchanged |
//! | before every entry | if the vtimer is masked and `CNTV_CTL` shows `ENABLE = 0`, `IMASK = 1` or `ISTATUS = 0`, drop the line and unmask; while the line is up, `hv_vcpu_set_pending_interrupt(IRQ)` (it is cleared after every run, `hv_vcpu.h`) |
//! | WFI | if no IRQ is pending, sleep until the `CNTV_CVAL` deadline ([`nogic_wfi_wait`]) in slices of at most [`NOGIC_WFI_SLICE`], re-checking the stop flag; PC + 4 |
//! | entry with the line up | arm a one-shot kick ([`LineKicker`]) [`NOGIC_LINE_RECHECK`] from now; with the line down, disarm it |
//!
//! **Why the kick.** The framework holds an IRQ set with `hv_vcpu_set_pending_interrupt` for
//! the *whole* `hv_vcpu_run` (it is cleared only when the run returns, `hv_vcpu.h`), and the
//! guest's way of silencing the timer (`CNTV_CTL.ENABLE = 0` or `IMASK = 1`, or a new `CVAL`) is a
//! plain system-register write that never traps. On real hardware the timer's output drops the
//! moment the guest writes `CNTV_CTL`; here the VMM only learns of it at the next exit. A normal
//! handler returns with `PSTATE.I` clear, takes the same still-pending IRQ again at once, and,
//! without an exit, would do so forever (measured in M8 Part A: 9.8 s of guest CPU, no
//! progress). So while the line is up the VMM bounds the run: [`LineKicker`] forces an exit
//! (`hv_vcpus_exit`, a `CANCELED` exit) [`NOGIC_LINE_RECHECK`] after the entry, the before-entry
//! rule re-reads `CNTV_CTL`, and the line drops. The guest therefore sees a level line that
//! lingers for at most about a millisecond after it is silenced (it may take the IRQ a few more
//! times in that window: a handler must, as on any level-triggered machine, tolerate finding the
//! source already quiet). The kick costs one exit per millisecond, and only while the line is up.
//! The helper thread exists only in this teaching mode; the in-kernel GIC sees the guest's
//! acknowledge and EOI itself and needs none of this (course ch12).
//!
//! `CNTV_CTL_EL0` bits (ARM ARM D19.11.15): `ENABLE` (0), `IMASK` (1), `ISTATUS` (2, read-only:
//! the timer condition `CNTVCT >= CNTV_CVAL` holds). The timer *asserts its interrupt* when
//! `ENABLE = 1`, `IMASK = 0` and `ISTATUS = 1`; that is the only state in which the line may
//! stay up (level semantics: unmasking while `ISTATUS = 1` re-exits at once, finding 12).
//!
//! **Hostile values.** `CNTV_CTL` and `CNTV_CVAL` are guest-written. The WFI sleep is bounded
//! whatever they hold: a deadline in the past wakes at once, `u64::MAX` (or any value whose
//! host deadline overflows) and a disabled or masked timer sleep one 100 ms slice at a time,
//! each slice interruptible by the stop flag, so a guest can never block `--timeout`, a
//! Ctrl-A x or a SIGTERM (threat model §10.2 M8).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::devices::pl031::{self, WallClock};
use crate::sync::lock;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

// ANCHOR: vtimer_offset_boot
/// The virtual-counter offset of a new boot: the host tick count now, so the guest's
/// `CNTVCT_EL0 = mach_absolute_time() - offset` starts at 0. `Machine::build` captures it once
/// and every vCPU of the boot gets the same value before its first run, so all CPUs agree.
pub fn boot_offset() -> u64 {
    hvf::host::mach_absolute_time()
}

/// The guest's counter at host tick `mach` under `offset` (modulo 2^64, as the hardware
/// subtracts the offset).
pub const fn guest_counter(mach: u64, offset: u64) -> u64 {
    mach.wrapping_sub(offset)
}

/// The offset that makes the guest's counter read `saved_cntvct` at host tick `mach_now`, so a
/// paused or restored guest continues where it stopped and never sees time run backwards
/// (the restore rule).
pub const fn restore_offset(mach_now: u64, saved_cntvct: u64) -> u64 {
    mach_now.wrapping_sub(saved_cntvct)
}
// ANCHOR_END: vtimer_offset_boot

/// The PL031's time base: host wall-clock seconds, never backwards (module docs).
pub fn pl031_time_base() -> WallClock {
    pl031::host_clock()
}

// ANCHOR: timer_cntv_ctl
/// `CNTV_CTL_EL0` bits (ARM ARM D19.11.15).
pub mod cntv_ctl {
    pub const ENABLE: u64 = 1 << 0;
    pub const IMASK: u64 = 1 << 1;
    pub const ISTATUS: u64 = 1 << 2;
}

/// True if the timer is asserting its interrupt: enabled, not masked, condition met.
pub const fn timer_asserted(ctl: u64) -> bool {
    ctl & cntv_ctl::ENABLE != 0 && ctl & cntv_ctl::IMASK == 0 && ctl & cntv_ctl::ISTATUS != 0
}
// ANCHOR_END: timer_cntv_ctl

/// The longest one no-GIC WFI sleep lasts before the stop flag and the timer registers are
/// checked again (a named cap: the guest picks the deadline, we pick the granularity).
pub const NOGIC_WFI_SLICE: Duration = Duration::from_millis(100);

/// What a no-GIC WFI does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WfiWait {
    /// Resume the guest now: the deadline has passed (or the timer is already asserting).
    Wake,
    /// Sleep this long (at most [`NOGIC_WFI_SLICE`]), then decide again.
    Sleep(Duration),
}

// ANCHOR: nogic_wfi_deadline
/// How long a WFI may sleep in the no-GIC mode, from the guest's `CNTV_CTL` and `CNTV_CVAL`,
/// the boot's counter `offset`, the host tick count `now` and the host timebase. Both registers
/// are guest-written, so every input, however hostile, ends in a bounded answer.
///
/// - timer disabled or masked: there is no deadline; sleep one slice (only a stop ends it);
/// - condition already met, or `CVAL` in the past: wake;
/// - deadline beyond `u64::MAX` host ticks, or an unknown timebase: sleep one slice;
/// - otherwise sleep until the deadline, at most one slice.
pub fn nogic_wfi_wait(
    ctl: u64,
    cval: u64,
    offset: u64,
    now: u64,
    timebase: Option<hvf::host::Timebase>,
) -> WfiWait {
    if ctl & cntv_ctl::ENABLE == 0 || ctl & cntv_ctl::IMASK != 0 {
        return WfiWait::Sleep(NOGIC_WFI_SLICE);
    }
    if ctl & cntv_ctl::ISTATUS != 0 {
        return WfiWait::Wake;
    }
    // CNTVCT = mach - offset reaches CVAL at host tick CVAL + offset.
    let Some(deadline) = cval.checked_add(offset) else {
        return WfiWait::Sleep(NOGIC_WFI_SLICE);
    };
    let Some(left) = deadline.checked_sub(now).filter(|t| *t > 0) else {
        return WfiWait::Wake;
    };
    match timebase {
        Some(tb) => {
            let d = Duration::from_nanos(tb.ticks_to_nanos(left));
            WfiWait::Sleep(d.min(NOGIC_WFI_SLICE))
        }
        None => WfiWait::Sleep(NOGIC_WFI_SLICE),
    }
}
// ANCHOR_END: nogic_wfi_deadline

// ANCHOR: nogic_timer_line
// ANCHOR: nogic_entry_action
/// What to do before entering the guest in the no-GIC mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EntryAction {
    /// Call `hv_vcpu_set_vtimer_mask(false)`.
    pub unmask: bool,
    /// Call `hv_vcpu_set_pending_interrupt(IRQ, true)` for this run.
    pub assert_irq: bool,
}

/// One vCPU's interrupt line in the no-GIC mode: raised by a VTIMER exit, re-asserted before
/// each entry, dropped (and the vtimer unmasked) once the guest's timer stops asserting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NoGicTimer {
    /// The boot's counter offset (for WFI deadlines).
    pub offset: u64,
    /// The host timebase (`None` only if the kernel would not say).
    pub timebase: Option<hvf::host::Timebase>,
    /// The VMM's model of the vCPU's IRQ input: raised by `VTIMER_ACTIVATED`, dropped when the
    /// guest has handled or disarmed the timer.
    line: bool,
}

impl NoGicTimer {
    pub fn new(offset: u64, timebase: Option<hvf::host::Timebase>) -> NoGicTimer {
        NoGicTimer {
            offset,
            timebase,
            line: false,
        }
    }
    // ANCHOR_END: nogic_entry_action
    // ANCHOR: nogic_before_entry_rule

    /// Is the IRQ line up?
    pub fn line(&self) -> bool {
        self.line
    }

    /// `VTIMER_ACTIVATED`: the framework masked the vtimer; raise the line.
    pub fn vtimer_activated(&mut self) {
        self.line = true;
    }

    /// The before-entry rule, given whether the framework currently masks the vtimer and the
    /// guest's `CNTV_CTL`: drop the line and unmask once the timer no longer asserts, otherwise
    /// keep re-asserting the (per-run) pending IRQ.
    pub fn before_entry(&mut self, masked: bool, ctl: u64) -> EntryAction {
        let mut a = EntryAction::default();
        if masked && !timer_asserted(ctl) {
            self.line = false;
            a.unmask = true;
        }
        a.assert_irq = self.line;
        a
    }

    /// Whether an IRQ is pending for a WFI: the line is up and the timer still asserts it.
    pub fn irq_pending(&self, ctl: u64) -> bool {
        self.line && timer_asserted(ctl)
    }
    // ANCHOR_END: nogic_before_entry_rule
}
// ANCHOR_END: nogic_timer_line

/// How long the no-GIC IRQ line may stay asserted in one `hv_vcpu_run` before the VMM forces
/// an exit to re-read `CNTV_CTL` (module docs, "Why the kick"). 1 ms: short against the
/// guest's 100 ms intervals, long against the ~µs cost of one exit.
pub const NOGIC_LINE_RECHECK: Duration = Duration::from_millis(1);

#[derive(Debug, Default)]
struct KickState {
    /// When to fire next; `None` = disarmed.
    at: Option<Instant>,
    quit: bool,
}

#[derive(Debug, Default)]
struct KickShared {
    state: Mutex<KickState>,
    cv: Condvar,
}

// ANCHOR: nogic_line_kicker
/// A one-shot deadline on a helper thread: [`LineKicker::arm`] makes `fire` run once, `after`
/// from now, unless [`LineKicker::disarm`] comes first. In the no-GIC mode `fire` is
/// `hv_vcpus_exit` for the vCPU, so a stale pending IRQ lasts at most one
/// [`NOGIC_LINE_RECHECK`]: the guest silences its timer without an exit, and only an exit lets
/// us drop the line. A kick that lands while the vCPU is outside `hv_vcpu_run` is sticky and
/// costs one spurious `CANCELED` exit, which the run loop already tolerates (verified on a real
/// Mac). Dropping the kicker stops and joins the thread.
#[derive(Debug)]
pub struct LineKicker {
    shared: Arc<KickShared>,
    thread: Option<JoinHandle<()>>,
}

impl LineKicker {
    /// Start the helper thread (named `name`); `fire` runs on it.
    pub fn spawn<F>(name: String, fire: F) -> std::io::Result<LineKicker>
    where
        F: Fn() + Send + 'static,
    {
        let shared = Arc::new(KickShared::default());
        let sh = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name(name)
            .spawn(move || kicker_loop(&sh, &fire))?;
        Ok(LineKicker {
            shared,
            thread: Some(thread),
        })
    }

    /// Fire `after` from now. An earlier pending deadline is kept (the line has been up since
    /// then), so re-arming on every entry cannot postpone the kick forever.
    pub fn arm(&self, after: Duration) {
        let now = Instant::now();
        let at = now.checked_add(after).unwrap_or(now);
        let mut st = lock(&self.shared.state);
        if st.at.is_none() {
            st.at = Some(at);
            self.shared.cv.notify_one();
        }
    }

    /// Cancel a pending deadline (the line dropped).
    pub fn disarm(&self) {
        lock(&self.shared.state).at = None;
    }
}
// ANCHOR_END: nogic_line_kicker

fn kicker_loop(sh: &KickShared, fire: &dyn Fn()) {
    let mut st = lock(&sh.state);
    loop {
        if st.quit {
            return;
        }
        match st.at {
            None => st = sh.cv.wait(st).unwrap_or_else(PoisonError::into_inner),
            Some(at) => {
                let left = at.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    st.at = None;
                    drop(st);
                    fire();
                    st = lock(&sh.state);
                } else {
                    st = sh
                        .cv
                        .wait_timeout(st, left)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0;
                }
            }
        }
    }
}

impl Drop for LineKicker {
    fn drop(&mut self) {
        lock(&self.shared.state).quit = true;
        self.shared.cv.notify_one();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;
    use hvf::host::Timebase;

    /// Apple Silicon: 24 MHz ticks, ns = ticks * 125 / 3.
    const TB: Option<Timebase> = Some(Timebase {
        numer: 125,
        denom: 3,
    });
    const ON: u64 = cntv_ctl::ENABLE;

    #[test]
    fn boot_counter_starts_near_zero() {
        let off = boot_offset();
        let now = hvf::host::mach_absolute_time();
        assert!(guest_counter(now, off) < 24_000_000, "under a second");
    }

    /// PLAN M8 host acceptance `timer::tests`: the restore offset keeps the guest counter
    /// monotonic, including a restore whose saved count is above the host's.
    #[test]
    fn restore_offset_keeps_the_counter_monotonic() {
        for (boot_mach, run_ticks, gap, resume_mach) in [
            (1_000u64, 500u64, 10_000u64, 0u64),
            (u64::MAX - 10, 100, 1, 0),
            (5, u64::MAX / 2, 0, 0),
            (1 << 40, 24_000_000, 0, 3), // restored on a "rebooted" host: mach is tiny
        ] {
            let offset = boot_mach;
            let stop_mach = boot_mach.wrapping_add(run_ticks);
            let saved = guest_counter(stop_mach, offset);
            let now = if resume_mach != 0 {
                resume_mach
            } else {
                stop_mach.wrapping_add(gap)
            };
            let off2 = restore_offset(now, saved);
            assert_eq!(guest_counter(now, off2), saved, "continues exactly");
            assert_eq!(guest_counter(now.wrapping_add(7), off2), saved + 7);
        }
    }

    /// Security test `nogic_wfi_deadline` (PLAN M8): CVAL in the past, `u64::MAX`, ENABLE = 0.
    #[test]
    fn nogic_wfi_deadline() {
        let offset = 1_000_000;
        let now = offset + 24_000_000; // guest counter = 1 s
        let cnt = now - offset;
        // In the past, or exactly now: wake.
        assert_eq!(nogic_wfi_wait(ON, cnt - 1, offset, now, TB), WfiWait::Wake);
        assert_eq!(nogic_wfi_wait(ON, 0, offset, now, TB), WfiWait::Wake);
        assert_eq!(nogic_wfi_wait(ON, cnt, offset, now, TB), WfiWait::Wake);
        // Condition already met.
        assert_eq!(
            nogic_wfi_wait(ON | cntv_ctl::ISTATUS, cnt + 1_000_000, offset, now, TB),
            WfiWait::Wake
        );
        // 10 ms ahead: sleep exactly that.
        assert_eq!(
            nogic_wfi_wait(ON, cnt + 240_000, offset, now, TB),
            WfiWait::Sleep(Duration::from_millis(10))
        );
        // 10 s ahead: one slice.
        assert_eq!(
            nogic_wfi_wait(ON, cnt + 240_000_000, offset, now, TB),
            WfiWait::Sleep(NOGIC_WFI_SLICE)
        );
        // u64::MAX overflows the host deadline: a bounded slice, never a panic or forever.
        assert_eq!(
            nogic_wfi_wait(ON, u64::MAX, offset, now, TB),
            WfiWait::Sleep(NOGIC_WFI_SLICE)
        );
        // Disabled or masked: no deadline, re-check every slice (only a kick or stop ends it).
        for ctl in [
            0,
            cntv_ctl::ISTATUS,
            ON | cntv_ctl::IMASK | cntv_ctl::ISTATUS,
        ] {
            assert_eq!(
                nogic_wfi_wait(ctl, cnt - 1, offset, now, TB),
                WfiWait::Sleep(NOGIC_WFI_SLICE),
                "{ctl:#x}"
            );
        }
        // Unknown timebase: bounded.
        assert_eq!(
            nogic_wfi_wait(ON, cnt + 240_000, offset, now, None),
            WfiWait::Sleep(NOGIC_WFI_SLICE)
        );
        // Every input is total: a coarse sweep never panics and never exceeds the slice.
        let vals = [0, 1, 4, 7, u64::MAX, u64::MAX / 2, offset, now];
        for &ctl in &vals {
            for &cval in &vals {
                for &off in &vals {
                    if let WfiWait::Sleep(d) = nogic_wfi_wait(ctl, cval, off, now, TB) {
                        assert!(d <= NOGIC_WFI_SLICE);
                    }
                }
            }
        }
    }

    #[test]
    fn nogic_line_follows_the_table() {
        let mut t = NoGicTimer::new(0, TB);
        let firing = ON | cntv_ctl::ISTATUS;
        assert_eq!(t.before_entry(false, 0), EntryAction::default());
        t.vtimer_activated();
        assert!(t.line() && t.irq_pending(firing));
        // Still firing and masked: keep asserting, do not unmask (it would re-exit at once).
        assert_eq!(
            t.before_entry(true, firing),
            EntryAction {
                unmask: false,
                assert_irq: true
            }
        );
        // The handler disabled the timer: drop the line and unmask.
        assert_eq!(
            t.before_entry(true, ISTATUS_ONLY),
            EntryAction {
                unmask: true,
                assert_irq: false
            }
        );
        assert!(!t.line() && !t.irq_pending(firing));
        // IMASK and re-armed (ISTATUS = 0) also deassert.
        for ctl in [firing | cntv_ctl::IMASK, ON] {
            t.vtimer_activated();
            assert!(t.before_entry(true, ctl).unmask);
            assert!(!t.line());
        }
    }
    const ISTATUS_ONLY: u64 = cntv_ctl::ISTATUS;

    fn counting_kicker() -> (LineKicker, Arc<std::sync::atomic::AtomicU32>) {
        let n = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let n2 = Arc::clone(&n);
        let k = LineKicker::spawn("test-kick".into(), move || {
            n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
        (k, n)
    }

    /// The stale-line bound (module docs, "Why the kick"): an armed kicker fires once, soon;
    /// re-arming does not postpone it; a disarmed one never fires; drop joins the thread.
    #[test]
    fn line_kicker_fires_once_and_disarms() {
        use std::sync::atomic::Ordering::SeqCst;
        let (k, n) = counting_kicker();
        k.arm(NOGIC_LINE_RECHECK);
        let t0 = Instant::now();
        while n.load(SeqCst) == 0 {
            assert!(t0.elapsed() < Duration::from_secs(2), "kick never fired");
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(n.load(SeqCst), 1, "one-shot");
        // Re-arming keeps the first deadline: four re-arms 30 ms apart do not postpone it. A
        // postponed kick could not fire before `last + FIRST`. The deadline is far longer than
        // the re-arms take, so that a slow machine (hosted CI) whose sleeps overrun still
        // finishes them before the kick; if it somehow does not, the loop stops re-arming,
        // because an arm after the kick is a fresh deadline, not a postponement.
        const FIRST: Duration = Duration::from_millis(400);
        k.arm(FIRST);
        let t1 = Instant::now();
        let mut last = t1;
        let mut rearms = 0;
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(30));
            if n.load(SeqCst) >= 2 {
                break;
            }
            k.arm(FIRST);
            last = Instant::now();
            rearms += 1;
        }
        while n.load(SeqCst) < 2 {
            assert!(
                t1.elapsed() < Duration::from_secs(2),
                "the kick never fired"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
        if rearms == 4 {
            assert!(Instant::now() < last + FIRST, "re-arm postponed it");
        }
        // Disarmed before the deadline: nothing fires. (The first disarm clears a deadline that
        // a re-arm racing with the kick above may have set.)
        k.disarm();
        let fired = n.load(SeqCst);
        k.arm(Duration::from_millis(50));
        k.disarm();
        std::thread::sleep(Duration::from_millis(120));
        assert_eq!(n.load(SeqCst), fired);
        let t2 = Instant::now();
        drop(k);
        assert!(t2.elapsed() < Duration::from_secs(1), "drop joins promptly");
    }
}
