//! The EL1 virtual timer, `CNTV_*`, for test guests (course ch11, ch12; PLAN M8).
//!
//! **The registers** (ARM ARM DDI 0487, D11.2 "The AArch64 view of the Generic Timer" and the
//! register descriptions): `CNTVCT_EL0` counts at `CNTFRQ_EL0` (24 MHz under HVF, spike finding
//! 4); writing `CNTV_CVAL_EL0` sets an absolute deadline in that count; `CNTV_CTL_EL0.ENABLE`
//! (bit 0) arms the comparator, `IMASK` (bit 1) masks its interrupt and `ISTATUS` (bit 2, RO)
//! says the condition `CNTVCT >= CVAL` holds. The interrupt is **level**: it stays asserted
//! until the guest moves CVAL forward, sets IMASK, or clears ENABLE, which is why both timer
//! guests clear ENABLE in their handler.
//!
//! **Where the interrupt goes.** With the in-kernel GIC it is PPI 27 (`ICC_IAR1_EL1` = 27,
//! spike finding 13); with `--irqchip none` the VMM raises the vCPU's IRQ line itself and the
//! guest's IRQ vector runs without any GIC (architecture §9.1). Either way the exception enters
//! at `VBAR_EL1 + 0x280` (IRQ, current EL with SPx; ARM ARM D1.10.2).
//!
//! **Waiting.** [`wait_for_interrupt`] unmasks IRQs (`DAIF.I`) only around one `wfi`, so a
//! handler can only run at that point; the `asm!` block declares every caller-saved register
//! clobbered (`clobber_abi("C")`), because the vector table saves only the general registers
//! and the Rust handler may use any caller-saved register (AAPCS64 §6.1).

use core::arch::asm;

/// `CNTV_CTL_EL0` bits.
pub const ENABLE: u64 = 1 << 0;
pub const IMASK: u64 = 1 << 1;
pub const ISTATUS: u64 = 1 << 2;

/// The virtual timer's PPI with the in-kernel GIC (PLAN §1).
pub const VTIMER_INTID: u32 = 27;

/// Write `CNTV_CVAL_EL0`.
pub fn set_cval(v: u64) {
    // SAFETY: an EL1-accessible timer register; only arms the comparator.
    unsafe { asm!("msr cntv_cval_el0, {}", "isb", in(reg) v, options(nostack)) };
}

/// Write `CNTV_CTL_EL0`.
pub fn set_ctl(v: u64) {
    // SAFETY: an EL1-accessible timer register.
    unsafe { asm!("msr cntv_ctl_el0, {}", "isb", in(reg) v, options(nostack)) };
}

/// Read `CNTV_CTL_EL0`.
pub fn ctl() -> u64 {
    let v: u64;
    // SAFETY: reads a timer register; no side effects.
    unsafe { asm!("mrs {}, cntv_ctl_el0", out(reg) v, options(nomem, nostack)) };
    v
}

/// Arm the timer `ticks` counter ticks from now, interrupt unmasked. Returns the start count.
pub fn arm_in(ticks: u64) -> u64 {
    let now = crate::cntvct();
    set_cval(now.wrapping_add(ticks));
    set_ctl(ENABLE);
    now
}

/// Whole milliseconds in `ticks` of a `freq` Hz counter.
pub fn ticks_to_ms(ticks: u64, freq: u64) -> u64 {
    if freq == 0 {
        return 0;
    }
    ticks.saturating_mul(1000) / freq
}

// ANCHOR: guest_wait_for_interrupt
/// Unmask IRQs, wait in WFI, mask them again. A pending interrupt is taken between the
/// unmask and the re-mask, so the handler has run (or WFI woke spuriously) when this returns.
pub fn wait_for_interrupt() {
    // SAFETY: changes only PSTATE.I and waits; the handler that may run in between is ours,
    // and `clobber_abi("C")` tells the compiler every caller-saved register may change.
    unsafe {
        asm!(
            "msr daifclr, #2",
            "wfi",
            "msr daifset, #2",
            clobber_abi("C")
        )
    };
}
// ANCHOR_END: guest_wait_for_interrupt
