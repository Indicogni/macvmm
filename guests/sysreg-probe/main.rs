//! `sysreg-probe`: what a trapped system register looks like from inside the guest (course
//! ch08, PLAN M5; architecture §8.4, §8.5).
//!
//! 1. **A register that does not exist.** The vCPU reports `ID_AA64DFR0_EL1.PMUVer = 0`, so
//!    the PMU is absent and `mrs xN, PMCR_EL0` must be UNDEFINED. With EL2 off, HVF forwards
//!    the access to macvmm as EC 0x18 (spike finding 9), and macvmm injects an UNDEF: this
//!    guest's own EL1 vector sees exactly **one** synchronous exception with
//!    `ESR_EL1.EC = 0x00` and `ELR_EL1` at the `mrs`. The hook steps over it and counts.
//!    *Measured (M5):* with the in-kernel GIC that every macvmm machine has, HVF injects this
//!    UNDEF itself and the VMM never sees the access; without a GIC it is forwarded (spike
//!    finding 9). The guest cannot tell the difference, which is the point.
//! 2. **A register that exists, emulated as zero.** The vCPU reports
//!    `ID_AA64MMFR1_EL1.LO = 1` (FEAT_LOR implemented), so `mrs xN, LORID_EL1` is defined and
//!    must *not* UNDEF. HVF forwards it as EC 0x18 and macvmm's policy table reads it as zero
//!    (no LORegions; KVM gives the same answer). The guest checks both halves: `LO = 1`, then
//!    `LORID_EL1 = 0` with no exception; the trace records `"sysreg":"LORID_EL1"`,
//!    `"action":"sysreg"`.
//! 3. **A forwarded register in no row of the policy table.** With the in-kernel GIC, HVF
//!    injects the UNDEF itself for every register the ID registers say is absent (measured in
//!    M5: PMU, MPAM, SPE, TRF, AMU, unallocated encodings), so no *absent* register reaches the
//!    VMM. `mrs xN, MDCCSR_EL0` is forwarded and has no row, so the HC-6 default applies:
//!    macvmm injects the UNDEF (`arch/inject.rs`), and the trace records
//!    `"sysreg":"MDCCSR_EL0"` with `"action":"inject_undef"`. Exactly one UNDEF, EC 0x00. This
//!    step tests macvmm's injection on real HVF (ESR, ELR, vector), not the architectural
//!    status of `MDCCSR_EL0`, which is part of the base debug architecture; whether it should
//!    become RAZ is an open question in `arch/sysreg.rs`.
//! 4. **An emulated register.** The OS lock: `msr OSLAR_EL1, 1` then `mrs OSLSR_EL1` must
//!    show `OSLK = 1` (bit 1), and writing 0 must clear it (ARM ARM D19.3, OSLAR_EL1 and
//!    OSLSR_EL1). This holds whether or not HVF traps these registers; the exit trace
//!    (`--trace exits:F:sysreg`) records which.
#![no_std]
#![no_main]

use core::arch::asm;
use core::sync::atomic::{AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_sync_hook};
use guest::println;

guest::entry!(main);

static UNDEFS: AtomicU64 = AtomicU64::new(0);
static LAST_EC: AtomicU64 = AtomicU64::new(u64::MAX);
static LAST_ELR: AtomicU64 = AtomicU64::new(0);

/// Catch an UNDEF (EC 0x00), record it and step over the faulting instruction (a fault leaves
/// `ELR_EL1` *at* the instruction, unlike an `svc`).
fn on_undef(frame: &mut ExceptionFrame) -> bool {
    if frame.ec() != 0x00 {
        return false; // not ours: report and stop
    }
    // Load + store, not `fetch_add`: with the MMU off every access is Device memory, where an
    // exclusive or atomic read-modify-write faults (DFSC 0x35). One CPU, so this is race-free.
    UNDEFS.store(UNDEFS.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    LAST_EC.store(frame.ec(), Ordering::SeqCst);
    LAST_ELR.store(frame.elr, Ordering::SeqCst);
    frame.elr += 4;
    true
}

/// `ID_AA64MMFR1_EL1.LO`, bits [19:16]: 1 = FEAT_LOR implemented.
fn mmfr1_lo() -> u64 {
    let v: u64;
    // SAFETY: reads an ID register; no memory access, no side effects.
    unsafe { asm!("mrs {}, id_aa64mmfr1_el1", out(reg) v, options(nomem, nostack)) };
    (v >> 16) & 0xf
}

/// `mrs x0, LORID_EL1` (S3_0_C10_C4_7).
fn read_lorid() -> u64 {
    let v: u64;
    // SAFETY: reads a FEAT_LOR ID register; if it UNDEFs, the hook counts it and resumes.
    unsafe {
        asm!(
            "mov {v}, #0x5a",
            "mrs {v}, s3_0_c10_c4_7",
            v = out(reg) v,
            options(nostack),
        )
    };
    v
}

/// `mrs x0, MDCCSR_EL0` (S2_3_C0_C1_0), and the address of that instruction.
fn read_mdccsr() -> (u64, u64) {
    let (v, at): (u64, u64);
    // SAFETY: as `read_pmcr`: the UNDEF is taken by our vector and the hook resumes after it.
    unsafe {
        asm!(
            "adr {at}, 1f",
            "mov {v}, #0x5a",
            "1: mrs {v}, s2_3_c0_c1_0",
            v = out(reg) v,
            at = out(reg) at,
            options(nostack),
        )
    };
    (v, at)
}

/// Run `probe` with the UNDEF hook installed and report as `sysreg-probe: <what>...`.
fn expect_one_undef(what: &str, probe: fn() -> (u64, u64)) {
    UNDEFS.store(0, Ordering::SeqCst);
    LAST_EC.store(u64::MAX, Ordering::SeqCst);
    set_sync_hook(Some(on_undef));
    let (value, at) = probe();
    set_sync_hook(None);
    let n = UNDEFS.load(Ordering::SeqCst);
    let ec = LAST_EC.load(Ordering::SeqCst);
    println!("sysreg-probe: {what}undef count={n} ec={ec:#x}");
    let elr = LAST_ELR.load(Ordering::SeqCst);
    if n == 1 && elr == at && value == 0x5a {
        println!("sysreg-probe: {what}elr ok (the mrs at {at:#x}; Rt untouched)");
    } else {
        println!("sysreg-probe: {what}FAILED: elr={elr:#x} want {at:#x}, Rt={value:#x}");
    }
}

/// `mrs x0, PMCR_EL0`, and the address of that instruction.
fn read_pmcr() -> (u64, u64) {
    let (v, at): (u64, u64);
    // SAFETY: reads a (nonexistent) PMU register; the resulting UNDEF is taken by our own
    // vector and the hook resumes after the `mrs`. `adr` only computes an address.
    unsafe {
        asm!(
            "adr {at}, 1f",
            "mov {v}, #0x5a",
            "1: mrs {v}, pmcr_el0",
            v = out(reg) v,
            at = out(reg) at,
            options(nostack),
        )
    };
    (v, at)
}

fn write_oslar(v: u64) {
    // SAFETY: writes the OS Lock Access Register; it only affects debug-register access.
    unsafe { asm!("msr oslar_el1, {}", "isb", in(reg) v, options(nostack)) };
}

fn read_oslsr() -> u64 {
    let v: u64;
    // SAFETY: reads the OS Lock Status Register; no memory access, no side effects.
    unsafe { asm!("mrs {}, oslsr_el1", out(reg) v, options(nomem, nostack)) };
    v
}

fn main(_x0: u64) {
    expect_one_undef("", read_pmcr);

    // FEAT_LOR is advertised, so LORID_EL1 must read (as zero), not UNDEF.
    let lo = mmfr1_lo();
    UNDEFS.store(0, Ordering::SeqCst);
    set_sync_hook(Some(on_undef));
    let lorid = read_lorid();
    set_sync_hook(None);
    let n = UNDEFS.load(Ordering::SeqCst);
    println!("sysreg-probe: lo={lo} lorid={lorid:#x} undef count={n}");
    if lo == 1 && lorid == 0 && n == 0 {
        println!("sysreg-probe: lorid ok");
    } else {
        println!("sysreg-probe: lorid FAILED");
    }

    expect_one_undef("mdccsr ", read_mdccsr);

    write_oslar(1);
    let locked = read_oslsr();
    write_oslar(0);
    let unlocked = read_oslsr();
    println!("sysreg-probe: oslsr after lock={locked:#x} after unlock={unlocked:#x}");
    if locked & 2 != 0 && unlocked & 2 == 0 {
        println!("sysreg-probe: oslsr ok");
    } else {
        println!("sysreg-probe: FAILED: OSLK did not follow OSLAR");
    }
}
