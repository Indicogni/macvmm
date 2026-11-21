// Checkpoint 21 contract, frozen from the reference test crates/vmm/tests/inject.rs.
// It names only items the chapter 21 lesson teaches; the harness runs it against your crates.
//! Host test: synchronous exception injection (host acceptance;
//! threat model: docs/security/threat-model.md).
//!
//! - the vector offset follows the mode at the fault: EL1t `+0x000`, EL1h `+0x200`, EL0
//!   `+0x400`, and every other mode (AArch32, EL2, EL3, reserved) is a typed error, swept over
//!   every value of `M[4:0]` and 10,000 xorshift CPSRs (total, never a panic);
//! - `ELR_EL1` = the faulting PC, `SPSR_EL1` = the old CPSR, `ESR_EL1` = `EC<<26 | IL | ISS`,
//!   `FAR_EL1` only for aborts;
//! - the CPSR after injection is `0x3c5` (EL1h, DAIF) once the guest has set `SCTLR_EL1.SPAN`,
//!   with NZCV and DIT kept and PAN/SSBS following `SCTLR_EL1.SPAN`/`DSSBS`. Every macvmm vCPU
//!   starts with `SCTLR_EL1 = 0` (HVF's default, spikes/hvf-hello/RESULTS.md; `Vcpu::reset`
//!   only clears M/C/I), so SPAN = 0 and an UNDEF injected into a guest that never wrote SCTLR
//!   enters with PAN set: `0x4003c5`. That is architecturally right, since the guest sees
//!   FEAT_PAN (`ID_AA64MMFR1_EL1.PAN = 3`); `boot_sctlr_sets_pan` pins it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::inject::{
    InjectError, VcpuState, data_abort, offset, sctlr_ext, sync_exception, undef, vector_offset,
};

const VBAR: u64 = 0x4008_0800;
const PC: u64 = 0x4008_1234;
/// SCTLR_EL1 with SPAN = 1 (PAN unchanged on entry) and DSSBS = 0: what a guest that has
/// configured SCTLR (Linux sets SPAN) runs with. Not macvmm's boot value, which is 0
/// (`boot_sctlr_sets_pan`).
const SCTLR: u64 = sctlr_ext::SPAN;
/// `SCTLR_EL1` as every macvmm vCPU starts (HVF default 0; `Vcpu::reset` clears only M/C/I).
const BOOT_SCTLR: u64 = 0;
/// `PSTATE.PAN`, bit 22.
const PAN: u64 = 1 << 22;

fn st(cpsr: u64) -> VcpuState {
    VcpuState {
        pc: PC,
        cpsr,
        vbar_el1: VBAR,
        sctlr_el1: SCTLR,
    }
}

#[test]
fn vector_offsets() {
    assert_eq!(vector_offset(0x3c4), Ok(0x000), "EL1t");
    assert_eq!(vector_offset(0x3c5), Ok(0x200), "EL1h");
    assert_eq!(vector_offset(0x000), Ok(0x400), "EL0t");
    assert_eq!(vector_offset(0x3c0), Ok(offset::LOWER_A64));
    for (cpsr, base) in [(0x3c4u64, 0x000u64), (0x3c5, 0x200), (0x0, 0x400)] {
        assert_eq!(undef(&st(cpsr)).unwrap().pc, VBAR + base, "{cpsr:#x}");
    }
    // Every other mode: AArch32 (nRW = 1), EL2t/EL2h, EL3t/EL3h, the reserved EL0h.
    for mode in 0u64..32 {
        let ok = matches!(mode, 0b00000 | 0b00100 | 0b00101);
        let r = vector_offset(0x3c0 | mode);
        assert_eq!(r.is_ok(), ok, "mode {mode:#07b}");
        if !ok {
            assert_eq!(r, Err(InjectError::UnsupportedMode { cpsr: 0x3c0 | mode }));
            assert!(undef(&st(mode)).is_err());
            assert!(data_abort(&st(mode), 0, true).is_err());
        }
    }
}

#[test]
fn undef_registers() {
    let i = undef(&st(0x3c5)).unwrap();
    assert_eq!(i.elr_el1, PC, "the faulting instruction");
    assert_eq!(i.spsr_el1, 0x3c5);
    assert_eq!(i.esr_el1, 0x0200_0000, "EC 0x00, IL 1, ISS 0");
    assert_eq!(i.esr_el1 >> 26, 0x00);
    assert_eq!(i.far_el1, None, "UNDEF has no FAR");
    assert_eq!(i.cpsr, 0x3c5);
    // From EL0 with interrupts unmasked and flags set: the handler still starts masked in EL1h;
    // SPSR keeps the old state, NZCV carry over.
    let i = undef(&st(0x6000_0000)).unwrap();
    assert_eq!(i.spsr_el1, 0x6000_0000);
    assert_eq!(i.cpsr, 0x6000_03c5);
    assert_eq!(i.pc, VBAR + 0x400);
}

#[test]
fn cpsr_after_injection() {
    for old in [
        0x3c5u64, 0x3c4, 0x0, 0x345, 0x20_0005,  /* SS */
        0x200_0005, /* TCO */
        0x10_0005,  /* IL */
    ] {
        let i = undef(&st(old)).unwrap();
        assert_eq!(i.cpsr, 0x3c5, "from {old:#x}");
    }
    // SPAN = 0: PAN is set on entry. DSSBS = 1: SSBS is set.
    let mut s = st(0x3c5);
    s.sctlr_el1 = 0;
    assert_eq!(undef(&s).unwrap().cpsr, 0x3c5 | (1 << 22));
    s.sctlr_el1 = sctlr_ext::SPAN | sctlr_ext::DSSBS;
    assert_eq!(undef(&s).unwrap().cpsr, 0x3c5 | (1 << 12));
    // SPAN = 1 keeps PAN as it was; DIT is kept.
    s.sctlr_el1 = sctlr_ext::SPAN;
    s.cpsr = 0x3c5 | (1 << 22) | (1 << 24);
    assert_eq!(undef(&s).unwrap().cpsr, 0x3c5 | (1 << 22) | (1 << 24));
}

/// The CPSR a test guest actually gets: with the boot `SCTLR_EL1 = 0`, SPAN = 0, so exception
/// entry to EL1 sets PAN (ARM ARM, `SCTLR_EL1.SPAN` field description): `0x3c5 | PAN`.
#[test]
fn boot_sctlr_sets_pan() {
    for old in [0x3c5u64, 0x3c4, 0x0] {
        let mut s = st(old);
        s.sctlr_el1 = BOOT_SCTLR;
        assert_eq!(undef(&s).unwrap().cpsr, 0x3c5 | PAN, "from {old:#x}");
        assert_eq!(undef(&s).unwrap().cpsr, 0x4003c5);
    }
}

#[test]
fn data_abort_registers() {
    // From EL1: EC 0x25, DFSC 0x10, WnR.
    let i = data_abort(&st(0x3c5), 0xdead_0000, true).unwrap();
    assert_eq!(i.esr_el1, (0x25 << 26) | (1 << 25) | (1 << 6) | 0x10);
    assert_eq!(i.far_el1, Some(0xdead_0000));
    assert_eq!((i.elr_el1, i.pc), (PC, VBAR + 0x200));
    // From EL0: EC 0x24, a read.
    let i = data_abort(&st(0x0), 0x1000, false).unwrap();
    assert_eq!(i.esr_el1, (0x24 << 26) | (1 << 25) | 0x10);
    assert_eq!(i.pc, VBAR + 0x400);
    // Generic entry: the ISS is masked to 25 bits.
    let i = sync_exception(&st(0x3c5), 0x15, u32::MAX, None).unwrap();
    assert_eq!(i.esr_el1, (0x15 << 26) | (1 << 25) | 0x01ff_ffff);
}

#[test]
fn vbar_overflow_is_an_error() {
    let mut s = st(0x3c5);
    s.vbar_el1 = u64::MAX - 0x1ff;
    assert_eq!(
        undef(&s),
        Err(InjectError::VectorOverflow {
            vbar: u64::MAX - 0x1ff,
            offset: 0x200
        })
    );
    assert!(undef(&s).unwrap_err().to_string().contains("overflows"));
}

/// HC-7: any guest-controlled CPSR, VBAR and SCTLR give a result, never a panic.
#[test]
fn total_over_random_state() {
    let mut x: u64 = 0x1234_5678_9abc_def1;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut ok = 0;
    for _ in 0..10_000 {
        let s = VcpuState {
            pc: next(),
            cpsr: next(),
            vbar_el1: next(),
            sctlr_el1: next(),
        };
        if let Ok(i) = undef(&s) {
            ok += 1;
            assert_eq!(i.cpsr & 0x3df, 0x3c5);
            assert_eq!(i.elr_el1, s.pc);
        }
        let _ = data_abort(&s, next(), next() & 1 == 0);
    }
    assert!(ok > 0);
}
