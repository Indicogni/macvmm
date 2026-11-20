//! Register names: [`Reg`] (`hv_reg_t`) and [`SysReg`] (`hv_sys_reg_t`).
//!
//! **Why a newtype per register space:** the framework has two register-id spaces of different
//! widths (`hv_reg_t` is `u32`, `hv_sys_reg_t` is **`u16`**) and mixing them up compiles fine in
//! C. Wrapping each in its own type makes `vcpu.get_sys_reg(Reg::PC)` a type error.
//!
//! **Why `SysReg` is built from coordinates:** an A64 system register is named by five fields,
//! `(op0, op1, CRn, CRm, op2)` (ARM ARM, the "Accessing <register>" part of each AArch64 system
//! register description; citation convention in the crate docs). HVF packs them as
//! `op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2` (`hv_vcpu_types.h`). The same five fields appear,
//! in a different order, in the ISS of a trapped `MRS`/`MSR` (ESR_EL2 with EC = 0x18; ARM ARM,
//! ESR_EL2 register description, table "ISS encoding for an exception from MSR, MRS, or System
//! instruction execution in AArch64 state"):
//! `Op0[21:20] Op2[19:17] Op1[16:14] CRn[13:10] Rt[9:5] CRm[4:1] Direction[0]`. So a trap can be
//! turned straight into a [`SysReg`] with [`SysReg::from_iss`], and every constant below is
//! written with the coordinates the ARM ARM prints. `scripts/check-ffi.sh` compares each value
//! in [`SysReg::HV_ACCESSIBLE`] with the header's `HV_SYS_REG_*` enumerator.
//!
//! [`SysReg::HV_ACCESSIBLE`] is exactly the header's list: only these can be read or written
//! with `hv_vcpu_{get,set}_sys_reg`. A few more registers that the VMM sees only as *traps*
//! (PMU, OS lock, the counter) or that test guests access are in [`SysReg::TRAP_ONLY`].

use crate::ffi;
use core::fmt;

// ANCHOR: reg_ids
/// A general-purpose or special register for `hv_vcpu_{get,set}_reg` (`hv_reg_t`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Reg(pub ffi::hv_reg_t);

impl Reg {
    pub const X0: Reg = Reg(ffi::HV_REG_X0);
    pub const X1: Reg = Reg(ffi::HV_REG_X1);
    pub const X2: Reg = Reg(ffi::HV_REG_X2);
    pub const X3: Reg = Reg(ffi::HV_REG_X3);
    pub const X4: Reg = Reg(ffi::HV_REG_X4);
    pub const X5: Reg = Reg(ffi::HV_REG_X5);
    pub const X6: Reg = Reg(ffi::HV_REG_X6);
    pub const X7: Reg = Reg(ffi::HV_REG_X7);
    /// Frame pointer (X29).
    pub const FP: Reg = Reg(ffi::HV_REG_FP);
    /// Link register (X30).
    pub const LR: Reg = Reg(ffi::HV_REG_LR);
    /// The program counter. After an HVC exit it already points past the HVC; after SMC, data
    /// abort and sysreg traps it points *at* the instruction (checked on a real Mac).
    pub const PC: Reg = Reg(ffi::HV_REG_PC);
    pub const FPCR: Reg = Reg(ffi::HV_REG_FPCR);
    pub const FPSR: Reg = Reg(ffi::HV_REG_FPSR);
    /// PSTATE as SPSR-format bits (`0x3c5` = EL1h with DAIF masked).
    pub const CPSR: Reg = Reg(ffi::HV_REG_CPSR);
    // ANCHOR_END: reg_ids

    // ANCHOR: reg_x_xzr
    /// `Xn` for `n` in 0..=30. `n = 31` is not a register here: in a load/store or MRS it means
    /// XZR (or SP), so the caller must decide, and this returns `None`.
    pub const fn x(n: u8) -> Option<Reg> {
        if n <= 30 {
            Some(Reg(n as ffi::hv_reg_t))
        } else {
            None
        }
    }
    // ANCHOR_END: reg_x_xzr
}

/// An A64 system register id as `hv_sys_reg_t` (`op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SysReg(pub ffi::hv_sys_reg_t);

// ANCHOR: sysreg_encoding
impl SysReg {
    // ANCHOR: sysreg_new
    /// Pack ARM ARM coordinates. Out-of-range fields are masked to their architectural widths
    /// (op0 2 bits, op1 3, CRn 4, CRm 4, op2 3), so the result is always a 16-bit encoding.
    pub const fn new(op0: u8, op1: u8, crn: u8, crm: u8, op2: u8) -> SysReg {
        let v = ((op0 as u16 & 0x3) << 14)
            | ((op1 as u16 & 0x7) << 11)
            | ((crn as u16 & 0xf) << 7)
            | ((crm as u16 & 0xf) << 3)
            | (op2 as u16 & 0x7);
        SysReg(v)
    }
    // ANCHOR_END: sysreg_new

    /// `(op0, op1, CRn, CRm, op2)`.
    pub const fn fields(self) -> (u8, u8, u8, u8, u8) {
        let v = self.0;
        (
            (v >> 14) as u8 & 0x3,
            (v >> 11) as u8 & 0x7,
            (v >> 7) as u8 & 0xf,
            (v >> 3) as u8 & 0xf,
            v as u8 & 0x7,
        )
    }

    /// The register named by the ISS of an EC = 0x18 trap. `Rt` (bits 9:5) and the direction
    /// (bit 0) are ignored; bits above 21 are ignored too, so any `u32` is accepted.
    pub const fn from_iss(iss: u32) -> SysReg {
        let op0 = ((iss >> 20) & 0x3) as u8;
        let op2 = ((iss >> 17) & 0x7) as u8;
        let op1 = ((iss >> 14) & 0x7) as u8;
        let crn = ((iss >> 10) & 0xf) as u8;
        let crm = ((iss >> 1) & 0xf) as u8;
        SysReg::new(op0, op1, crn, crm, op2)
    }

    /// The ISS an EC = 0x18 trap of this register would carry, with the given `Rt` (masked to
    /// 5 bits) and direction (`read` = MRS = 1).
    pub const fn to_iss(self, rt: u8, read: bool) -> u32 {
        let (op0, op1, crn, crm, op2) = self.fields();
        ((op0 as u32) << 20)
            | ((op2 as u32) << 17)
            | ((op1 as u32) << 14)
            | ((crn as u32) << 10)
            | (((rt & 0x1f) as u32) << 5)
            | ((crm as u32) << 1)
            | (read as u32)
    }
}
// ANCHOR_END: sysreg_encoding

impl PartialEq<u16> for SysReg {
    fn eq(&self, other: &u16) -> bool {
        self.0 == *other
    }
}

impl fmt::Debug for SysReg {
    /// `MPIDR_EL1(0xc005)`, or `S3_3_C9_C12_0(0xdce0)` for a register we have no name for
    /// (the generic `S<op0>_<op1>_C<n>_C<m>_<op2>` spelling assemblers accept).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.name() {
            Some(n) => write!(f, "{n}({:#06x})", self.0),
            None => {
                let (a, b, n, m, c) = self.fields();
                write!(f, "S{a}_{b}_C{n}_C{m}_{c}({:#06x})", self.0)
            }
        }
    }
}

impl SysReg {
    /// The register's ARM ARM name, if it is in one of our tables.
    pub fn name(self) -> Option<&'static str> {
        SysReg::HV_ACCESSIBLE
            .iter()
            .chain(SysReg::TRAP_ONLY)
            .find(|(_, r)| *r == self)
            .map(|(n, _)| *n)
    }
}

/// Declare the constants and a `(name, SysReg)` table in one go, so the table can never miss a
/// constant (the oracle iterates the table).
macro_rules! sysregs {
    ($table:ident, $doc:literal, { $($name:ident = ($o0:expr, $o1:expr, $n:expr, $m:expr, $o2:expr),)* }) => {
        impl SysReg {
            $(pub const $name: SysReg = SysReg::new($o0, $o1, $n, $m, $o2);)*
            #[doc = $doc]
            pub const $table: &'static [(&'static str, SysReg)] = &[$((stringify!($name), SysReg::$name)),*];
        }
    };
}

// Coordinates from the ARM ARM AArch64 system register descriptions (one page per register,
// "Accessing <register>"); the order and the macOS
// availability notes follow `hv_vcpu_types.h`. Entries without a note are macOS 11.0.
sysregs!(HV_ACCESSIBLE, "Every register `hv_vcpu_types.h` enumerates as `HV_SYS_REG_*`.", {
    DBGBVR0_EL1 = (2, 0, 0, 0, 4),
    DBGBCR0_EL1 = (2, 0, 0, 0, 5),
    DBGWVR0_EL1 = (2, 0, 0, 0, 6),
    DBGWCR0_EL1 = (2, 0, 0, 0, 7),
    DBGBVR1_EL1 = (2, 0, 0, 1, 4),
    DBGBCR1_EL1 = (2, 0, 0, 1, 5),
    DBGWVR1_EL1 = (2, 0, 0, 1, 6),
    DBGWCR1_EL1 = (2, 0, 0, 1, 7),
    MDCCINT_EL1 = (2, 0, 0, 2, 0),
    MDSCR_EL1 = (2, 0, 0, 2, 2),
    DBGBVR2_EL1 = (2, 0, 0, 2, 4),
    DBGBCR2_EL1 = (2, 0, 0, 2, 5),
    DBGWVR2_EL1 = (2, 0, 0, 2, 6),
    DBGWCR2_EL1 = (2, 0, 0, 2, 7),
    DBGBVR3_EL1 = (2, 0, 0, 3, 4),
    DBGBCR3_EL1 = (2, 0, 0, 3, 5),
    DBGWVR3_EL1 = (2, 0, 0, 3, 6),
    DBGWCR3_EL1 = (2, 0, 0, 3, 7),
    DBGBVR4_EL1 = (2, 0, 0, 4, 4),
    DBGBCR4_EL1 = (2, 0, 0, 4, 5),
    DBGWVR4_EL1 = (2, 0, 0, 4, 6),
    DBGWCR4_EL1 = (2, 0, 0, 4, 7),
    DBGBVR5_EL1 = (2, 0, 0, 5, 4),
    DBGBCR5_EL1 = (2, 0, 0, 5, 5),
    DBGWVR5_EL1 = (2, 0, 0, 5, 6),
    DBGWCR5_EL1 = (2, 0, 0, 5, 7),
    DBGBVR6_EL1 = (2, 0, 0, 6, 4),
    DBGBCR6_EL1 = (2, 0, 0, 6, 5),
    DBGWVR6_EL1 = (2, 0, 0, 6, 6),
    DBGWCR6_EL1 = (2, 0, 0, 6, 7),
    DBGBVR7_EL1 = (2, 0, 0, 7, 4),
    DBGBCR7_EL1 = (2, 0, 0, 7, 5),
    DBGWVR7_EL1 = (2, 0, 0, 7, 6),
    DBGWCR7_EL1 = (2, 0, 0, 7, 7),
    DBGBVR8_EL1 = (2, 0, 0, 8, 4),
    DBGBCR8_EL1 = (2, 0, 0, 8, 5),
    DBGWVR8_EL1 = (2, 0, 0, 8, 6),
    DBGWCR8_EL1 = (2, 0, 0, 8, 7),
    DBGBVR9_EL1 = (2, 0, 0, 9, 4),
    DBGBCR9_EL1 = (2, 0, 0, 9, 5),
    DBGWVR9_EL1 = (2, 0, 0, 9, 6),
    DBGWCR9_EL1 = (2, 0, 0, 9, 7),
    DBGBVR10_EL1 = (2, 0, 0, 10, 4),
    DBGBCR10_EL1 = (2, 0, 0, 10, 5),
    DBGWVR10_EL1 = (2, 0, 0, 10, 6),
    DBGWCR10_EL1 = (2, 0, 0, 10, 7),
    DBGBVR11_EL1 = (2, 0, 0, 11, 4),
    DBGBCR11_EL1 = (2, 0, 0, 11, 5),
    DBGWVR11_EL1 = (2, 0, 0, 11, 6),
    DBGWCR11_EL1 = (2, 0, 0, 11, 7),
    DBGBVR12_EL1 = (2, 0, 0, 12, 4),
    DBGBCR12_EL1 = (2, 0, 0, 12, 5),
    DBGWVR12_EL1 = (2, 0, 0, 12, 6),
    DBGWCR12_EL1 = (2, 0, 0, 12, 7),
    DBGBVR13_EL1 = (2, 0, 0, 13, 4),
    DBGBCR13_EL1 = (2, 0, 0, 13, 5),
    DBGWVR13_EL1 = (2, 0, 0, 13, 6),
    DBGWCR13_EL1 = (2, 0, 0, 13, 7),
    DBGBVR14_EL1 = (2, 0, 0, 14, 4),
    DBGBCR14_EL1 = (2, 0, 0, 14, 5),
    DBGWVR14_EL1 = (2, 0, 0, 14, 6),
    DBGWCR14_EL1 = (2, 0, 0, 14, 7),
    DBGBVR15_EL1 = (2, 0, 0, 15, 4),
    DBGBCR15_EL1 = (2, 0, 0, 15, 5),
    DBGWVR15_EL1 = (2, 0, 0, 15, 6),
    DBGWCR15_EL1 = (2, 0, 0, 15, 7),
    MIDR_EL1 = (3, 0, 0, 0, 0),
    MPIDR_EL1 = (3, 0, 0, 0, 5),
    ID_AA64PFR0_EL1 = (3, 0, 0, 4, 0),
    ID_AA64PFR1_EL1 = (3, 0, 0, 4, 1),
    ID_AA64PFR2_EL1 = (3, 0, 0, 4, 2),  // macOS 27.0
    ID_AA64ZFR0_EL1 = (3, 0, 0, 4, 4),  // macOS 15.2
    ID_AA64SMFR0_EL1 = (3, 0, 0, 4, 5),  // macOS 15.2
    ID_AA64DFR0_EL1 = (3, 0, 0, 5, 0),
    ID_AA64DFR1_EL1 = (3, 0, 0, 5, 1),
    ID_AA64ISAR0_EL1 = (3, 0, 0, 6, 0),
    ID_AA64ISAR1_EL1 = (3, 0, 0, 6, 1),
    ID_AA64ISAR2_EL1 = (3, 0, 0, 6, 2),  // macOS 27.0
    ID_AA64MMFR0_EL1 = (3, 0, 0, 7, 0),
    ID_AA64MMFR1_EL1 = (3, 0, 0, 7, 1),
    ID_AA64MMFR2_EL1 = (3, 0, 0, 7, 2),
    ID_AA64MMFR3_EL1 = (3, 0, 0, 7, 3),  // macOS 27.0
    ID_AA64MMFR4_EL1 = (3, 0, 0, 7, 4),  // macOS 27.0
    SCTLR_EL1 = (3, 0, 1, 0, 0),
    ACTLR_EL1 = (3, 0, 1, 0, 1),  // macOS 15.0
    CPACR_EL1 = (3, 0, 1, 0, 2),
    SMPRI_EL1 = (3, 0, 1, 2, 4),  // macOS 15.2
    SMCR_EL1 = (3, 0, 1, 2, 6),  // macOS 15.2
    TTBR0_EL1 = (3, 0, 2, 0, 0),
    TTBR1_EL1 = (3, 0, 2, 0, 1),
    TCR_EL1 = (3, 0, 2, 0, 2),
    APIAKEYLO_EL1 = (3, 0, 2, 1, 0),
    APIAKEYHI_EL1 = (3, 0, 2, 1, 1),
    APIBKEYLO_EL1 = (3, 0, 2, 1, 2),
    APIBKEYHI_EL1 = (3, 0, 2, 1, 3),
    APDAKEYLO_EL1 = (3, 0, 2, 2, 0),
    APDAKEYHI_EL1 = (3, 0, 2, 2, 1),
    APDBKEYLO_EL1 = (3, 0, 2, 2, 2),
    APDBKEYHI_EL1 = (3, 0, 2, 2, 3),
    APGAKEYLO_EL1 = (3, 0, 2, 3, 0),
    APGAKEYHI_EL1 = (3, 0, 2, 3, 1),
    SPSR_EL1 = (3, 0, 4, 0, 0),
    ELR_EL1 = (3, 0, 4, 0, 1),
    SP_EL0 = (3, 0, 4, 1, 0),
    AFSR0_EL1 = (3, 0, 5, 1, 0),
    AFSR1_EL1 = (3, 0, 5, 1, 1),
    ESR_EL1 = (3, 0, 5, 2, 0),
    FAR_EL1 = (3, 0, 6, 0, 0),
    PAR_EL1 = (3, 0, 7, 4, 0),
    MAIR_EL1 = (3, 0, 10, 2, 0),
    AMAIR_EL1 = (3, 0, 10, 3, 0),
    VBAR_EL1 = (3, 0, 12, 0, 0),
    CONTEXTIDR_EL1 = (3, 0, 13, 0, 1),
    TPIDR_EL1 = (3, 0, 13, 0, 4),
    SCXTNUM_EL1 = (3, 0, 13, 0, 7),  // macOS 15.2
    CNTKCTL_EL1 = (3, 0, 14, 1, 0),
    CSSELR_EL1 = (3, 2, 0, 0, 0),
    TPIDR_EL0 = (3, 3, 13, 0, 2),
    TPIDRRO_EL0 = (3, 3, 13, 0, 3),
    TPIDR2_EL0 = (3, 3, 13, 0, 5),  // macOS 15.2
    SCXTNUM_EL0 = (3, 3, 13, 0, 7),  // macOS 15.2
    CNTV_CTL_EL0 = (3, 3, 14, 3, 1),
    CNTV_CVAL_EL0 = (3, 3, 14, 3, 2),
    SP_EL1 = (3, 4, 4, 1, 0),
    CNTP_CTL_EL0 = (3, 3, 14, 2, 1),  // macOS 15.0
    CNTP_CVAL_EL0 = (3, 3, 14, 2, 2),  // macOS 15.0
    CNTP_TVAL_EL0 = (3, 3, 14, 2, 0),  // macOS 15.0
    CNTHCTL_EL2 = (3, 4, 14, 1, 0),  // macOS 15.0
    CNTHP_CTL_EL2 = (3, 4, 14, 2, 1),  // macOS 15.0
    CNTHP_CVAL_EL2 = (3, 4, 14, 2, 2),  // macOS 15.0
    CNTHP_TVAL_EL2 = (3, 4, 14, 2, 0),  // macOS 15.0
    CNTVOFF_EL2 = (3, 4, 14, 0, 3),  // macOS 15.0
    CPTR_EL2 = (3, 4, 1, 1, 2),  // macOS 15.0
    ELR_EL2 = (3, 4, 4, 0, 1),  // macOS 15.0
    ESR_EL2 = (3, 4, 5, 2, 0),  // macOS 15.0
    FAR_EL2 = (3, 4, 6, 0, 0),  // macOS 15.0
    HCR_EL2 = (3, 4, 1, 1, 0),  // macOS 15.0
    HPFAR_EL2 = (3, 4, 6, 0, 4),  // macOS 15.0
    MAIR_EL2 = (3, 4, 10, 2, 0),  // macOS 15.0
    MDCR_EL2 = (3, 4, 1, 1, 1),  // macOS 15.0
    SCTLR_EL2 = (3, 4, 1, 0, 0),  // macOS 15.0
    SPSR_EL2 = (3, 4, 4, 0, 0),  // macOS 15.0
    SP_EL2 = (3, 6, 4, 1, 0),  // macOS 15.0
    TCR_EL2 = (3, 4, 2, 0, 2),  // macOS 15.0
    TPIDR_EL2 = (3, 4, 13, 0, 2),  // macOS 15.0
    TTBR0_EL2 = (3, 4, 2, 0, 0),  // macOS 15.0
    TTBR1_EL2 = (3, 4, 2, 0, 1),  // macOS 15.0
    VBAR_EL2 = (3, 4, 12, 0, 0),  // macOS 15.0
    VMPIDR_EL2 = (3, 4, 0, 0, 5),  // macOS 15.0
    VPIDR_EL2 = (3, 4, 0, 0, 0),  // macOS 15.0
    VTCR_EL2 = (3, 4, 2, 1, 2),  // macOS 15.0
    VTTBR_EL2 = (3, 4, 2, 1, 0),  // macOS 15.0
});

sysregs!(TRAP_ONLY, "Registers HVF does not expose but that guests touch (traps, test guests).", {
    // PMU (ARM ARM, "Performance Monitors registers"): with EL2 off these trap to the VMM as EC 0x18 (spike finding 9).
    PMCR_EL0 = (3, 3, 9, 12, 0),
    PMUSERENR_EL0 = (3, 3, 9, 14, 0),
    // OS lock and double lock (ARM ARM, "Debug registers"): Linux writes them at boot.
    OSLAR_EL1 = (2, 0, 1, 0, 4),
    OSLSR_EL1 = (2, 0, 1, 1, 4),
    OSDLR_EL1 = (2, 0, 1, 3, 4),
    // Generic Timer (ARM ARM, "Generic Timer registers") and CurrentEL, read by test guests.
    CNTFRQ_EL0 = (3, 3, 14, 0, 0),
    CNTVCT_EL0 = (3, 3, 14, 0, 2),
    CURRENTEL = (3, 0, 4, 2, 2),
    // GIC CPU interface (GIC spec IHI 0069, §12.2): handled in-kernel when a GIC exists.
    ICC_PMR_EL1 = (3, 0, 4, 6, 0),
    ICC_IAR1_EL1 = (3, 0, 12, 12, 0),
    ICC_EOIR1_EL1 = (3, 0, 12, 12, 1),
    ICC_SRE_EL1 = (3, 0, 12, 12, 5),
    ICC_IGRPEN1_EL1 = (3, 0, 12, 12, 7),
});

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// `hv_reg_t` 0..=30 are X0..X30 and 31 is `HV_REG_PC` (`hv_vcpu_types.h`), so an MMIO
    /// SRT of 31 (XZR) must never be passed through: `Reg::x(31)` is `None`, and the VMM
    /// reads 0 / discards the write (mmio-probe checks 6 and 7).
    #[test]
    fn x31_is_xzr_not_pc() {
        assert_eq!(ffi::HV_REG_PC, 31);
        assert_eq!(Reg::x(31), None);
        assert_eq!(Reg::x(u8::MAX), None);
        assert_eq!(Reg::x(0), Some(Reg::X0));
        assert_eq!(Reg::x(29), Some(Reg::FP));
        assert_eq!(Reg::x(30), Some(Reg::LR));
        for n in 0..=30u8 {
            assert_ne!(Reg::x(n), Some(Reg::PC), "x{n}");
        }
    }

    #[test]
    fn plan_spot_values() {
        assert_eq!(SysReg::CNTV_CTL_EL0, 0xdf19);
        assert_eq!(SysReg::PMCR_EL0, 0xdce0);
        assert_eq!(SysReg::MPIDR_EL1, 0xc005);
        assert_eq!(SysReg::SP_EL1, 0xe208);
        assert_eq!(SysReg::SP_EL0, 0xc208);
        assert_eq!(SysReg::SMCR_EL1, 0xc096);
        assert_eq!(SysReg::TPIDR2_EL0, 0xde85);
    }

    #[test]
    fn hv_table_matches_header_size_and_is_unique() {
        // `hv_vcpu_types.h` (SDK 27.2) enumerates 152 `HV_SYS_REG_*` names.
        assert_eq!(SysReg::HV_ACCESSIBLE.len(), 152);
        let ids: BTreeSet<u16> = SysReg::HV_ACCESSIBLE.iter().map(|(_, r)| r.0).collect();
        assert_eq!(
            ids.len(),
            SysReg::HV_ACCESSIBLE.len(),
            "duplicate encodings"
        );
        let names: BTreeSet<&str> = SysReg::HV_ACCESSIBLE.iter().map(|(n, _)| *n).collect();
        assert_eq!(names.len(), SysReg::HV_ACCESSIBLE.len(), "duplicate names");
        // The trap-only table must not shadow an accessible register.
        for (n, r) in SysReg::TRAP_ONLY {
            assert!(!ids.contains(&r.0), "{n} is also HV-accessible");
        }
    }

    #[test]
    fn from_iss_round_trips() {
        for (name, r) in SysReg::HV_ACCESSIBLE.iter().chain(SysReg::TRAP_ONLY) {
            for rt in [0u8, 7, 30, 31] {
                for read in [false, true] {
                    let iss = r.to_iss(rt, read);
                    assert_eq!(SysReg::from_iss(iss), *r, "{name} rt={rt} read={read}");
                    assert_eq!((iss >> 5) & 0x1f, u32::from(rt));
                    assert_eq!(iss & 1, u32::from(read));
                    assert_eq!(iss >> 22, 0, "ISS uses bits 21:0 only");
                }
            }
            let (a, b, n, m, c) = r.fields();
            assert_eq!(SysReg::new(a, b, n, m, c), *r);
        }
        // Every 16-bit encoding survives encode -> ISS -> decode, named or not.
        for v in 0..=u16::MAX {
            assert_eq!(SysReg::from_iss(SysReg(v).to_iss(3, true)), SysReg(v));
        }
        // The spike's observed trap (RESULTS.md, basic #7): `mrs x4, PMCR_EL0` gave
        // ESR 0x6230e499, i.e. EC 0x18 and ISS 0x30e499 (read, Rt = 4).
        assert_eq!(SysReg::from_iss(0x0030_e499), SysReg::PMCR_EL0);
        assert_eq!(SysReg::PMCR_EL0.to_iss(4, true), 0x0030_e499);
        // Garbage above bit 21 (EC/IL leaking in) is ignored rather than trusted.
        assert_eq!(
            SysReg::from_iss(0xffc0_0000 | SysReg::PMCR_EL0.to_iss(0, true)),
            SysReg::PMCR_EL0
        );
    }

    #[test]
    fn new_masks_out_of_range_fields() {
        assert_eq!(SysReg::new(0xff, 0xff, 0xff, 0xff, 0xff), SysReg(0xffff));
        assert_eq!(SysReg::new(4, 8, 16, 16, 8), SysReg(0));
    }

    #[test]
    fn names_and_debug() {
        assert_eq!(SysReg::MPIDR_EL1.name(), Some("MPIDR_EL1"));
        assert_eq!(SysReg::PMCR_EL0.name(), Some("PMCR_EL0"));
        assert_eq!(format!("{:?}", SysReg::MPIDR_EL1), "MPIDR_EL1(0xc005)");
        assert_eq!(
            format!("{:?}", SysReg::new(3, 3, 9, 12, 1)),
            "S3_3_C9_C12_1(0xdce1)"
        );
    }

    #[test]
    fn reg_x_rejects_31() {
        assert_eq!(Reg::x(0), Some(Reg::X0));
        assert_eq!(Reg::x(29), Some(Reg::FP));
        assert_eq!(Reg::x(30), Some(Reg::LR));
        assert_eq!(Reg::x(31), None);
        assert_eq!(Reg::x(255), None);
        assert_eq!(Reg::PC.0, 31);
        assert_eq!(Reg::CPSR.0, 34);
    }
}
