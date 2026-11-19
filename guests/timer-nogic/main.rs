//! `timer-nogic`: the virtual timer with **no interrupt controller** (`--irqchip none`; course
//! ch11, PLAN M8 Part A, architecture §9.1).
//!
//! The guest does what `timer` does, minus the GIC: 10 × (arm `CNTV_CVAL` for 100 ms, WFI until
//! the interrupt). Without a GIC, Hypervisor.framework reports the timer to the VMM
//! (`VTIMER_ACTIVATED`) and the WFI to the VMM (EC 0x01); macvmm raises this vCPU's IRQ line
//! with `hv_vcpu_set_pending_interrupt` and sleeps the WFI until the deadline. The exception
//! enters at `VBAR_EL1 + 0x280` (IRQ, current EL with SPx); there is no `ICC_IAR1` to read, so
//! the handler only silences the source (`CNTV_CTL.ENABLE = 0`), which is what lets the VMM
//! drop the line and unmask the vtimer again.
//!
//! **The lesson of the missing controller** (measured in M8 Part A): the framework holds the
//! pending IRQ for the *whole* `hv_vcpu_run`, and nothing the handler does here traps, so the
//! VMM only learns that the timer was silenced at the guest's **next exit**. Before the VMM
//! bounded that (the first version of this guest), a handler returning with IRQs unmasked took
//! the same, still-asserted line again at once, forever: 9.8 s of guest CPU, no progress. The
//! VMM now forces an exit within about 1 ms while the line is up (`vmm::timer::LineKicker`), so
//! this handler is the plain one a learner writes: silence the source, return (with `PSTATE.I`
//! clear, as `eret` restores it). In that millisecond the guest may take the IRQ a few more
//! times and find the timer already quiet; it counts those as `stale` and does nothing, as any
//! handler of a level-triggered line must. A GIC solves this properly: the acknowledge (`IAR1`)
//! and end-of-interrupt (`EOIR1`) are what the controller sees, and the in-kernel one sees them
//! without any exit. With `--stats` this costs ≥ 10 VTIMER and ≥ 10 WFI exits; `timer` under
//! the in-kernel GIC costs zero of each (the ch12 measurement).
//!
//! It also prints `timer-nogic: pfr0.gic=0`: with no `hv_gic_create`, the guest's own `MRS` of
//! `ID_AA64PFR0_EL1` advertises no GIC system registers (risk R3's comparison; `irq` prints 1).
#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_irq_hook};
use guest::{println, timer};

guest::entry!(main);

/// `+= 1` with a plain load and store: with the MMU off RAM is Device memory, where exclusives
/// and atomics fault (DFSC 0x35), and only this CPU touches the counters.
fn bump(c: &AtomicU32) {
    c.store(c.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

static FIRED_AT: AtomicU64 = AtomicU64::new(0);
static IRQS: AtomicU32 = AtomicU32::new(0);
static STALE: AtomicU32 = AtomicU32::new(0);

fn on_irq(_frame: &mut ExceptionFrame) {
    // No PSTATE games: return as taken. A stale re-take finds the timer quiet (module docs).
    let ctl = timer::ctl();
    if ctl & timer::ENABLE != 0 && ctl & timer::ISTATUS != 0 {
        timer::set_ctl(0);
        FIRED_AT.store(guest::cntvct(), Ordering::Relaxed);
        bump(&IRQS);
    } else {
        bump(&STALE);
    }
}

fn main(_x0: u64) {
    set_irq_hook(Some(on_irq));
    let freq = guest::cntfrq();
    println!("timer-nogic: cntfrq={freq}");
    println!("timer-nogic: pfr0.gic={}", guest::gic::pfr0_gic());
    let mut ok = 0;
    for i in 0..10 {
        FIRED_AT.store(0, Ordering::Relaxed);
        let start = timer::arm_in(freq / 10);
        while FIRED_AT.load(Ordering::Relaxed) == 0 {
            timer::wait_for_interrupt();
        }
        let ms = timer::ticks_to_ms(FIRED_AT.load(Ordering::Relaxed).wrapping_sub(start), freq);
        let good = (95..150).contains(&ms);
        if good {
            ok += 1;
        }
        println!(
            "timer-nogic: interval {i} = {ms} ms {}",
            if good { "ok" } else { "OUT OF RANGE" }
        );
    }
    println!(
        "timer-nogic: irqs={} stale={}",
        IRQS.load(Ordering::Relaxed),
        STALE.load(Ordering::Relaxed)
    );
    println!("timer-nogic: {ok}/10 intervals within 95..150 ms");
    if ok != 10 {
        guest::hvc::debug_exit(1);
    }
}
