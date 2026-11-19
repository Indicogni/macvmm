//! `RegDump`: a snapshot of the vCPU state the fatal report prints (architecture §15; course
//! ch06 objective 3).
//!
//! **What is in it, and why each register.** A crashed guest can only be diagnosed from its
//! registers, so the dump holds the questions a reader asks, in order:
//! - *where was it?* `PC`, and `CPSR` (which level, which stack, what was masked; decoded by
//!   `arch::regs::Pstate`);
//! - *what was it computing?* `X0..X30`, `SP_EL0`, `SP_EL1`;
//! - *did the guest take an exception of its own first?* `ELR_EL1` (where it was),
//!   `ESR_EL1` (why), `FAR_EL1` (which address) and `SPSR_EL1` (its PSTATE then): ch06's
//!   self-fault lesson, where the exit we see is the *second* fault and the first one is only
//!   visible here;
//! - *where would its handler be, and was translation on?* `VBAR_EL1`, `SCTLR_EL1`,
//!   `TCR_EL1`, `TTBR0_EL1`, `TTBR1_EL1`.
//!
//! The register names are those of `hv_reg_t`/`hv_sys_reg_t` (ARM ARM DDI 0487, the AArch64
//! system register descriptions in D19). Capture happens on the vCPU's own thread (only that
//! thread may touch its registers, spike finding 19), once, at a fatal stop.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use hvf::{CallError, Reg, SysReg};

/// The register snapshot (module docs). Numbers only (LOG-5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RegDump {
    /// `X0..X30` (X30 is the link register).
    pub x: [u64; 31],
    pub sp_el0: u64,
    pub sp_el1: u64,
    pub pc: u64,
    pub cpsr: u64,
    pub elr_el1: u64,
    pub spsr_el1: u64,
    pub esr_el1: u64,
    pub far_el1: u64,
    pub vbar_el1: u64,
    pub sctlr_el1: u64,
    pub tcr_el1: u64,
    pub ttbr0_el1: u64,
    pub ttbr1_el1: u64,
}

impl RegDump {
    /// Read every register of `v` (module docs). Called on the vCPU's thread.
    pub fn capture(v: &hvf::Vcpu<'_>) -> Result<RegDump, CallError> {
        let mut d = RegDump::default();
        for (n, slot) in (0u8..).zip(d.x.iter_mut()) {
            if let Some(r) = Reg::x(n) {
                *slot = v.get_reg(r)?;
            }
        }
        d.pc = v.get_reg(Reg::PC)?;
        d.cpsr = v.get_reg(Reg::CPSR)?;
        let sys = |r: SysReg| v.get_sys_reg(r);
        d.sp_el0 = sys(SysReg::SP_EL0)?;
        d.sp_el1 = sys(SysReg::SP_EL1)?;
        d.elr_el1 = sys(SysReg::ELR_EL1)?;
        d.spsr_el1 = sys(SysReg::SPSR_EL1)?;
        d.esr_el1 = sys(SysReg::ESR_EL1)?;
        d.far_el1 = sys(SysReg::FAR_EL1)?;
        d.vbar_el1 = sys(SysReg::VBAR_EL1)?;
        d.sctlr_el1 = sys(SysReg::SCTLR_EL1)?;
        d.tcr_el1 = sys(SysReg::TCR_EL1)?;
        d.ttbr0_el1 = sys(SysReg::TTBR0_EL1)?;
        d.ttbr1_el1 = sys(SysReg::TTBR1_EL1)?;
        Ok(d)
    }
}
