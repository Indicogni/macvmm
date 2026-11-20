//! `timer`: the virtual timer through the in-kernel GICv3 (course ch12, PLAN M8).
//!
//! GICv3 bring-up, PPI 27 enabled in this CPU's redistributor, then 10 × (arm `CNTV_CVAL` for
//! 100 ms, WFI until the interrupt). The handler acknowledges INTID 27, disarms the timer
//! (`CNTV_CTL.ENABLE = 0`: the timer line is level, so it must stop asserting before EOI) and
//! records `CNTVCT`. Each interval is measured with the counter itself and must lie in
//! 95..150 ms (the WFI wake-up is 2-4 ms late on this host, spike finding 25).
//!
//! The point, in `--stats`: **zero** VTIMER_ACTIVATED and **zero** WFI exits, because the
//! kernel delivers the timer and handles WFI itself (spike finding 13); `timer-nogic` shows ten
//! of each without a GIC.
#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_irq_hook};
use guest::{gic, println, timer};

guest::entry!(main);

/// `+= 1` with a plain load and store: with the MMU off RAM is Device memory, where exclusives
/// and atomics fault (DFSC 0x35), and only this CPU touches the counters.
fn bump(c: &AtomicU32) {
    c.store(c.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

static FIRED_AT: AtomicU64 = AtomicU64::new(0);
static TIMER_IRQS: AtomicU32 = AtomicU32::new(0);
static SPURIOUS: AtomicU32 = AtomicU32::new(0);

fn on_irq(_frame: &mut ExceptionFrame) {
    let intid = gic::ack();
    if intid == gic::SPURIOUS {
        bump(&SPURIOUS);
        return;
    }
    if intid == timer::VTIMER_INTID {
        timer::set_ctl(0);
        FIRED_AT.store(guest::cntvct(), Ordering::Relaxed);
        bump(&TIMER_IRQS);
    }
    gic::eoi(intid);
}

fn main(_x0: u64) {
    let Some(rd) = gic::init() else {
        println!("timer: no redistributor for mpidr {:#x}", gic::mpidr());
        guest::hvc::debug_exit(1);
    };
    rd.enable_ppi(timer::VTIMER_INTID);
    set_irq_hook(Some(on_irq));
    let freq = guest::cntfrq();
    println!("timer: cntfrq={freq}");
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
            "timer: interval {i} = {ms} ms {}",
            if good { "ok" } else { "OUT OF RANGE" }
        );
    }
    println!(
        "timer: irqs={} spurious={}",
        TIMER_IRQS.load(Ordering::Relaxed),
        SPURIOUS.load(Ordering::Relaxed)
    );
    println!("timer: {ok}/10 intervals within 95..150 ms");
    if ok != 10 {
        guest::hvc::debug_exit(1);
    }
}
