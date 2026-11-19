//! Host test: the system-register trap policy (PLAN M5 "Acceptance: host"; architecture §8.4;
//! threat model HC-6).
//!
//! - the OS-lock registers are emulated per vCPU, in both directions, and only in the
//!   architected direction (`MRS OSLAR_EL1` and `MSR OSLSR_EL1` are UNDEF);
//! - every PMU register is UNDEF (`PMUVer = 0`), and so is every unlisted register, swept over
//!   all 65,536 encodings (HC-6: the default is never "let it through");
//! - debug breakpoint/watchpoint registers are RAZ/WI;
//! - the FEAT_LOR registers read as zero (the guest sees `ID_AA64MMFR1_EL1.LO = 1`, so they
//!   exist), `LORID_EL1` is read-only;
//! - unnamed registers print in the generic `S<op0>_<op1>_C<n>_C<m>_<op2>` form.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use hvf::SysReg;
use vmm::arch::esr::{SysRegAccess, decode_sysreg};
use vmm::arch::sysreg::{
    POLICY, Policy, SysRegOutcome, SysRegState, display_name, handle, policy_for,
};

fn access(r: SysReg, read: bool, rt: u8) -> SysRegAccess {
    // Through the real ISS decoder, as a trap would arrive.
    decode_sysreg(u64::from(r.to_iss(rt, read)) | (0x18 << 26) | (1 << 25))
}

#[test]
fn os_lock_transitions() {
    let mut s = SysRegState::default();
    let lar = access(SysReg::OSLAR_EL1, false, 1);
    let lsr = access(SysReg::OSLSR_EL1, true, 2);
    // Cold reset: locked (OSLK = 1), OSLM = 0b10.
    assert_eq!(handle(&mut s, &lsr, 0), SysRegOutcome::Read(0b1010));
    for (write, want) in [
        (0u64, 0b1000u64),
        (1, 0b1010),
        (1, 0b1010),
        (0, 0b1000),
        (2, 0b1000),
    ] {
        assert_eq!(handle(&mut s, &lar, write), SysRegOutcome::Written);
        assert_eq!(
            handle(&mut s, &lsr, 0),
            SysRegOutcome::Read(want),
            "write {write}"
        );
    }
    // Wrong directions are UNDEFINED and change nothing.
    let before = s;
    assert_eq!(
        handle(&mut s, &access(SysReg::OSLAR_EL1, true, 0), 0),
        SysRegOutcome::Undef
    );
    assert_eq!(
        handle(&mut s, &access(SysReg::OSLSR_EL1, false, 0), 1),
        SysRegOutcome::Undef
    );
    assert_eq!(s, before);
    // The double lock: DLK, bit 0, read back.
    let dlr_w = access(SysReg::OSDLR_EL1, false, 0);
    let dlr_r = access(SysReg::OSDLR_EL1, true, 0);
    assert_eq!(handle(&mut s, &dlr_r, 0), SysRegOutcome::Read(0));
    assert_eq!(handle(&mut s, &dlr_w, 0xff), SysRegOutcome::Written);
    assert_eq!(handle(&mut s, &dlr_r, 0), SysRegOutcome::Read(1));
    // Per vCPU: a second state is untouched.
    assert_eq!(SysRegState::default().oslsr(), 0b1010);
}

#[test]
fn pmu_is_undef() {
    let pmu = [
        SysReg::PMCR_EL0,
        SysReg::PMUSERENR_EL0,
        SysReg::new(3, 3, 9, 12, 1),  // PMCNTENSET_EL0
        SysReg::new(3, 3, 9, 12, 2),  // PMCNTENCLR_EL0
        SysReg::new(3, 3, 9, 13, 0),  // PMCCNTR_EL0
        SysReg::new(3, 0, 9, 14, 1),  // PMINTENSET_EL1
        SysReg::new(3, 3, 14, 8, 0),  // PMEVCNTR0_EL0
        SysReg::new(3, 3, 14, 15, 7), // PMCCFILTR_EL0
    ];
    for r in pmu {
        assert_eq!(policy_for(r), Policy::Undef, "{r:?}");
        let mut s = SysRegState::default();
        for read in [true, false] {
            assert_eq!(
                handle(&mut s, &access(r, read, 4), 0xffff),
                SysRegOutcome::Undef
            );
        }
        assert_eq!(s, SysRegState::default(), "{r:?}: no state change");
    }
}

#[test]
fn debug_registers_are_raz_wi() {
    let mut s = SysRegState::default();
    for n in 0..16u8 {
        for op2 in 4..=7u8 {
            let r = SysReg::new(2, 0, 0, n, op2);
            assert_eq!(policy_for(r), Policy::RazWi, "{r:?}");
            assert_eq!(
                handle(&mut s, &access(r, true, 0), 0),
                SysRegOutcome::Read(0)
            );
            assert_eq!(
                handle(&mut s, &access(r, false, 0), u64::MAX),
                SysRegOutcome::Written
            );
        }
    }
    assert_eq!(policy_for(SysReg::MDSCR_EL1), Policy::RazWi);
    assert_eq!(policy_for(SysReg::MDCCINT_EL1), Policy::RazWi);
    assert_eq!(s, SysRegState::default());
}

/// HC-6: every encoding not in the table is UNDEF, both directions, and never changes state.
#[test]
fn unknown_is_undef_sweep() {
    let listed = |r: SysReg| POLICY.iter().any(|rule| rule.matches(r));
    let mut undef = 0u32;
    for v in 0..=u16::MAX {
        let r = SysReg(v);
        if listed(r) {
            continue;
        }
        assert_eq!(policy_for(r), Policy::Undef, "{r:?}");
        let mut s = SysRegState::default();
        for read in [true, false] {
            assert_eq!(
                handle(&mut s, &access(r, read, 0), u64::MAX),
                SysRegOutcome::Undef,
                "{r:?}"
            );
        }
        assert_eq!(s, SysRegState::default());
        undef += 1;
    }
    // Rows: 3 OS-lock + 64 DBG + 2 MD* + 4 LOR + LORID + 24 + 8 + 64 PMU encodings.
    assert_eq!(undef, 65_536 - (3 + 64 + 2 + 4 + 1 + 24 + 8 + 64));
    // Registers HVF exposes but that only trap if HVF forwards them are UNDEF too.
    for r in [
        SysReg::CNTVCT_EL0,
        SysReg::new(3, 0, 15, 0, 0),
        SysReg::MIDR_EL1,
    ] {
        assert_eq!(policy_for(r), Policy::Undef, "{r:?}");
    }
}

/// FEAT_LOR is advertised (`ID_AA64MMFR1_EL1.LO = 1`), so its registers must not UNDEF: they
/// read as zero (no LORegions), the region registers ignore writes, `LORID_EL1` is read-only.
#[test]
fn lor_registers_read_as_zero() {
    let mut s = SysRegState::default();
    for op2 in 0..=3u8 {
        let r = SysReg::new(3, 0, 10, 4, op2); // LORSA, LOREA, LORN, LORC
        assert_eq!(policy_for(r), Policy::RazWi, "{r:?}");
        assert_eq!(
            handle(&mut s, &access(r, true, 1), 0),
            SysRegOutcome::Read(0)
        );
        assert_eq!(
            handle(&mut s, &access(r, false, 1), u64::MAX),
            SysRegOutcome::Written
        );
    }
    let lorid = SysReg::new(3, 0, 10, 4, 7);
    assert_eq!(display_name(lorid), "LORID_EL1");
    assert_eq!(policy_for(lorid), Policy::RazRo);
    assert_eq!(
        handle(&mut s, &access(lorid, true, 0), 0),
        SysRegOutcome::Read(0)
    );
    assert_eq!(
        handle(&mut s, &access(lorid, false, 0), 1),
        SysRegOutcome::Undef
    );
    // Neighbours that are not LOR registers keep the default (MPAMIDR_EL1: MPAM is absent).
    for op2 in 4..=6u8 {
        assert_eq!(policy_for(SysReg::new(3, 0, 10, 4, op2)), Policy::Undef);
    }
    assert_eq!(s, SysRegState::default());
}

#[test]
fn name_formatting() {
    assert_eq!(display_name(SysReg::new(3, 0, 15, 0, 0)), "S3_0_C15_C0_0");
    assert_eq!(display_name(SysReg::new(3, 3, 9, 12, 1)), "S3_3_C9_C12_1");
    assert_eq!(display_name(SysReg::PMCR_EL0), "PMCR_EL0");
    assert_eq!(display_name(SysReg::OSLAR_EL1), "OSLAR_EL1");
    assert_eq!(display_name(SysReg::MPIDR_EL1), "MPIDR_EL1");
}
