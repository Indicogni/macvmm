// Checkpoint 11 contract. It names only items the chapter 11 lesson teaches:
// `vmm::timer::{guest_counter, restore_offset, timer_asserted, nogic_wfi_wait, WfiWait,
// NoGicTimer, NOGIC_WFI_SLICE, cntv_ctl}`, `hvf::host::Timebase`, and the mode's restriction in
// `vmm::config::{VmConfig, IrqChip, RawSpec, IRQCHIP_NONE_RESTRICTION}` (`validate`,
// `validate_irqchip`).
//! The generic-timer rules of the `--irqchip none` mode (part A).
//!
//! - **Offset rule** (ARM ARM D12.1 "The Generic Timer", `CNTVCT = CNTPCT - CNTVOFF`): the
//!   guest's counter is the host's minus an offset, so a paused guest resumes where it stopped.
//! - **Deadline**: `CNTV_CVAL` is in guest ticks; the host deadline is `CVAL + offset` host
//!   ticks, converted with the host timebase (Apple Silicon: 24 MHz counter, `numer/denom =
//!   125/3`).
//! - **Unmask rule**: the timer asserts iff `ENABLE && !IMASK && ISTATUS` (ARM ARM D19.11.15,
//!   `CNTV_CTL_EL0`), a pure function of the register.
//! - **Restriction** (see docs/security/threat-model.md): `--irqchip none` is for test guests on one vCPU.
//!   It is checked here, on the configuration, because at chapter 11 the CLI has neither
//!   `--cpus` (chapter 20) nor `--kernel` (chapter 13): a black-box run could only ever see a
//!   usage error, whatever the VMM does (review finding on the old `nogic-smp-refused` run).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use hvf::host::Timebase;
use std::time::Duration;
use vmm::timer::{
    NOGIC_WFI_SLICE, NoGicTimer, WfiWait, cntv_ctl, guest_counter, nogic_wfi_wait, restore_offset,
    timer_asserted,
};

/// Apple Silicon's timebase: 24 MHz ticks, 125/3 ns per tick.
const TB: Timebase = Timebase {
    numer: 125,
    denom: 3,
};
const EN: u64 = cntv_ctl::ENABLE;
const MASK: u64 = cntv_ctl::IMASK;
const ST: u64 = cntv_ctl::ISTATUS;

#[test]
fn counter_is_monotonic_across_a_pause() {
    let offset = 1_000_000;
    let before = guest_counter(5_000_000, offset);
    // Paused for 10 s of host time (240M ticks): restoring keeps the counter where it was.
    let resumed = 5_000_000 + 240_000_000;
    let new_offset = restore_offset(resumed, before);
    assert_eq!(guest_counter(resumed, new_offset), before);
    assert!(guest_counter(resumed + 24, new_offset) > before);
}

#[test]
fn counter_wraps_like_the_hardware() {
    assert_eq!(guest_counter(5, 10), u64::MAX - 4);
    assert_eq!(guest_counter(3, restore_offset(3, u64::MAX)), u64::MAX);
}

#[test]
fn unmask_rule_truth_table() {
    for ctl in 0u64..8 {
        let want = ctl == (EN | ST);
        assert_eq!(timer_asserted(ctl), want, "ctl={ctl:#x}");
    }
    // Bits above ISTATUS are RES0 and must not change the answer.
    assert!(timer_asserted(EN | ST | 0xffff_ff00));
}

#[test]
fn deadline_converts_with_the_timebase() {
    let offset = 1_000;
    // CVAL 24_000 guest ticks after offset: 1 ms in the future at host tick `offset`.
    match nogic_wfi_wait(EN, 24_000, offset, offset, Some(TB)) {
        WfiWait::Sleep(d) => assert_eq!(d, Duration::from_millis(1)),
        other => panic!("{other:?}"),
    }
    // Far deadlines sleep at most one slice.
    assert_eq!(
        nogic_wfi_wait(EN, 24_000_000_000, offset, offset, Some(TB)),
        WfiWait::Sleep(NOGIC_WFI_SLICE)
    );
}

#[test]
fn hostile_timer_values_never_panic() {
    // A deadline in the past, or the condition already met: wake.
    assert_eq!(nogic_wfi_wait(EN, 0, 1_000, 5_000, Some(TB)), WfiWait::Wake);
    assert_eq!(
        nogic_wfi_wait(EN | ST, u64::MAX, 0, 0, Some(TB)),
        WfiWait::Wake
    );
    // Disabled or masked: no deadline, one slice.
    assert_eq!(
        nogic_wfi_wait(0, 5, 0, 0, Some(TB)),
        WfiWait::Sleep(NOGIC_WFI_SLICE)
    );
    assert_eq!(
        nogic_wfi_wait(EN | MASK, 5, 0, 0, Some(TB)),
        WfiWait::Sleep(NOGIC_WFI_SLICE)
    );
    // CVAL + offset overflows, or no timebase: one slice.
    assert_eq!(
        nogic_wfi_wait(EN, u64::MAX, u64::MAX, 0, Some(TB)),
        WfiWait::Sleep(NOGIC_WFI_SLICE)
    );
    assert_eq!(
        nogic_wfi_wait(EN, 10, 0, 0, None),
        WfiWait::Sleep(NOGIC_WFI_SLICE)
    );
}

#[test]
fn line_drops_only_when_the_timer_stops_asserting() {
    let mut t = NoGicTimer::new(0, Some(TB));
    assert!(!t.line());
    t.vtimer_activated();
    // Still asserting and masked by the framework: keep the IRQ pending, do not unmask.
    let a = t.before_entry(true, EN | ST);
    assert!(a.assert_irq && !a.unmask);
    assert!(t.irq_pending(EN | ST));
    // The guest masked the timer in its handler: drop the line, unmask.
    let a = t.before_entry(true, EN | MASK | ST);
    assert!(!a.assert_irq && a.unmask);
    assert!(!t.line());
}

/// `--irqchip none` is refused (a configuration error, exit code 2) with more than one vCPU or
/// for a guest that is not a test guest; the same machine with the GIC is fine.
#[test]
fn nogic_mode_is_single_vcpu_test_guests_only() {
    use vmm::config::{IRQCHIP_NONE_RESTRICTION, IrqChip, RawSpec, VmConfig};
    let mut c = VmConfig::default();
    c.boot.raw.push(RawSpec {
        path: "timer-nogic.bin".into(),
        addr: 0x4008_0000,
    });
    c.irqchip = IrqChip::None;
    assert!(c.validate().is_ok(), "one vCPU, --raw: allowed");
    assert!(c.validate_irqchip(true).is_ok());
    let e = c.validate_irqchip(false).unwrap_err();
    assert!(e.to_string().contains(IRQCHIP_NONE_RESTRICTION), "{e}");
    assert_eq!(e.exit_code(), 2, "a refusal is a usage error");
    c.cpus = 2;
    let e = c.validate().unwrap_err();
    assert!(e.to_string().contains(IRQCHIP_NONE_RESTRICTION), "{e}");
    assert_eq!(e.exit_code(), 2);
    assert!(c.validate_irqchip(true).is_err());
    c.irqchip = IrqChip::InKernelGicV3;
    assert!(c.validate().is_ok(), "two vCPUs with the GIC: allowed");
    assert!(c.validate_irqchip(false).is_ok());
}
