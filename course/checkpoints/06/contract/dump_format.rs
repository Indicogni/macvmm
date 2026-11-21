// Checkpoint 06 contract. It names only items the chapter 06 lesson teaches:
// `vmm::vcpu::regs::RegDump`, `vmm::vcpu::dump::format_regs` and `vmm::arch::regs::Pstate`.
//! The register dump's golden format and the PSTATE helpers.
//!
//! The dump is a contract, not decoration: checkpoint markers (`[stderr] pc=0x200`,
//! `[stderr] ELR_EL1=0x4008*`) and the bug-hunt symptoms match it, and ch06 teaches reading it.
//! PSTATE layout: ARM ARM C5.2.18 (SPSR_EL1): M[3:2] = EL, M[0] = SPSel, M[4] = nRW,
//! D/A/I/F = bits 9..6, N/Z/C/V = bits 31..28.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::regs::Pstate;
use vmm::vcpu::dump::format_regs;
use vmm::vcpu::regs::RegDump;

/// The self-fault state of ch06: an instruction abort at `VBAR_EL1 + 0x200` after an
/// alignment fault at EL1.
fn self_fault() -> RegDump {
    let mut d = RegDump::default();
    for (i, x) in d.x.iter_mut().enumerate() {
        *x = i as u64 * 0x1111;
    }
    d.sp_el1 = 0x4010_0000;
    d.pc = 0x200;
    d.cpsr = 0x3c5;
    d.elr_el1 = 0x4008_0abc;
    d.spsr_el1 = 0x3c5;
    d.esr_el1 = 0x9600_0021;
    d.far_el1 = 0x4010_0001;
    d.sctlr_el1 = 0x30d0_0802;
    d
}

#[test]
fn regs_golden() {
    // No `\` line continuation: it would strip the leading spaces of the first line.
    let want = "  x0=0x0000000000000000 x1=0x0000000000001111 x2=0x0000000000002222 x3=0x0000000000003333
  x4=0x0000000000004444 x5=0x0000000000005555 x6=0x0000000000006666 x7=0x0000000000007777
  x8=0x0000000000008888 x9=0x0000000000009999 x10=0x000000000000aaaa x11=0x000000000000bbbb
  x12=0x000000000000cccc x13=0x000000000000dddd x14=0x000000000000eeee x15=0x000000000000ffff
  x16=0x0000000000011110 x17=0x0000000000012221 x18=0x0000000000013332 x19=0x0000000000014443
  x20=0x0000000000015554 x21=0x0000000000016665 x22=0x0000000000017776 x23=0x0000000000018887
  x24=0x0000000000019998 x25=0x000000000001aaa9 x26=0x000000000001bbba x27=0x000000000001cccb
  x28=0x000000000001dddc x29=0x000000000001eeed x30=0x000000000001fffe
  sp_el0=0x0 sp_el1=0x40100000
  pc=0x200 cpsr=0x3c5 (EL1h, DAIF, nzcv)
  ELR_EL1=0x40080abc SPSR_EL1=0x3c5 ESR_EL1=0x96000021 (EC 0x25: data abort, same EL) FAR_EL1=0x40100001
  VBAR_EL1=0x0 SCTLR_EL1=0x30d00802 TCR_EL1=0x0 TTBR0_EL1=0x0 TTBR1_EL1=0x0
  note: pc is VBAR_EL1 + 0x200, an exception vector: the guest took an exception at EL1 first, so ELR_EL1 and ESR_EL1 describe the first fault
";
    assert_eq!(format_regs(&self_fault()), want);
}

#[test]
fn no_vector_note_away_from_the_table() {
    let mut d = self_fault();
    d.vbar_el1 = 0x4008_0800;
    d.pc = 0x4008_0010;
    let s = format_regs(&d);
    assert!(!s.contains("note:"), "{s}");
    // Named registers are not zero-padded, so `pc=0x4008*` markers work.
    assert!(
        s.contains("  pc=0x40080010 cpsr=0x3c5 (EL1h, DAIF, nzcv)\n"),
        "{s}"
    );
    // A PC inside the table but not on a 0x80 boundary is not a vector entry.
    d.pc = 0x4008_0810;
    assert!(!format_regs(&d).contains("note:"));
    d.pc = 0x4008_0880;
    assert!(format_regs(&d).contains("VBAR_EL1 + 0x80, an exception vector"));
}

#[test]
fn pstate_fields() {
    let p = Pstate(0x3c5);
    assert_eq!(p.el(), 1);
    assert!(p.sp_elx());
    assert!(!p.aarch32());
    assert_eq!(p.daif(), 0x3c0);
    assert_eq!(p.mode_name(), "EL1h");
    assert_eq!(Pstate(0x3c4).mode_name(), "EL1t");
    assert_eq!(Pstate(0x0).mode_name(), "EL0t");
    assert_eq!(Pstate(0x9).mode_name(), "EL2h");
    assert_eq!(Pstate(0x10).mode_name(), "AArch32");
}

#[test]
fn pstate_display_cases_flags() {
    assert_eq!(Pstate(0x3c5).to_string(), "EL1h, DAIF, nzcv");
    assert_eq!(Pstate(0x6000_0005 | 0x80).to_string(), "EL1h, daIf, nZCv");
    assert_eq!(Pstate(0xf000_0004).to_string(), "EL1t, daif, NZCV");
}
