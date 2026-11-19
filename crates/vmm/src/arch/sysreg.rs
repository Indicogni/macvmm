//! System-register traps: what the VMM does with an `MSR`/`MRS` that Hypervisor.framework
//! forwards as EC 0x18 (architecture §8.4; course ch08; threat model HC-6).
//!
//! **Who decides what traps** (first-principles R10). There are two supervisors. HVF, at EL2,
//! owns the trap configuration (`HCR_EL2`, `MDCR_EL2`, the ID-register values the guest sees)
//! and forwards only some accesses to us; for example `PMCR_EL0` traps as EC 0x18 with EL2 off
//! (spike finding 9). This module is **our half**: a static, host-testable policy table that
//! says what each forwarded register means. Which registers actually trap is *measured* (the
//! trace's `sysreg` category, M10/M18/M19 logs), not looked up in the ARM ARM.
//!
//! **Measured on this machine (M5, macOS 27.2, M5 Pro, EL2 off).** Whether HVF forwards a
//! register depends on the VM configuration. *Without* the in-kernel GIC, `mrs PMCR_EL0`
//! exits as EC 0x18 (spike finding 9). *With* it, which is every macvmm machine, HVF injects
//! the UNDEF itself (`ESR_EL1 = 0x0200_0000`, `ELR_EL1` at the `mrs`) and the VMM never sees
//! the access; the same holds for every other PMU register and the IMPLEMENTATION DEFINED
//! `S3_<n>_C15_*` space probed. Forwarded to us: `OSLAR_EL1`, `OSLSR_EL1`, `OSDLR_EL1`,
//! `MRS MDCCSR_EL0`, and the FEAT_LOR registers (`MRS LORID_EL1`; `LORSA_EL1`, `LOREA_EL1`,
//! `LORN_EL1`, `LORC_EL1` in both directions). `MDSCR_EL1`, `DBGBVR0_EL1`, `DBGCLAIMSET_EL1`
//! and `ERRIDR_EL1` are handled in the framework, and so is every access the guest's ID
//! registers make UNDEFINED that was probed (MPAM, SPE, TRF, AMU registers, unallocated
//! encodings) and every wrong-direction access (`MRS OSLAR_EL1`, `MSR OSLSR_EL1`,
//! `MSR MDCCSR_EL0`, `MSR LORID_EL1`): HVF injects those UNDEFs itself. The PMU rows below are
//! therefore the policy for the configurations that do forward them (no GIC, future macOS), not
//! dead code.
//!
//! **Policies must agree with the guest's ID registers.** UNDEF is the right answer only for a
//! register the guest was told does not exist. The guest sees `ID_AA64MMFR1_EL1.LO = 1`
//! (FEAT_LOR implemented; spikes/hvf-hello/RESULTS.md, and read back from inside a guest), so
//! the LOR registers are architecturally defined at EL1 and must not UNDEF. They read as zero:
//! `LORID_EL1 = 0` advertises no LORegions and no descriptors, so the RAZ/WI region registers
//! can never describe a region, and `LORC_EL1.EN` has nothing to enable. This is what KVM does
//! when it exposes FEAT_LOR (`trap_loregion` in `arch/arm64/kvm/sys_regs.c`). The alternative,
//! clearing `LO` so the UNDEF is consistent, needs a writable ID register, which
//! `hv_vcpu_config` does not offer (`hv_vcpu_config_get_feature_reg` only).
//!
//! **Open question (for the lead).** `MRS MDCCSR_EL0` (the debug communications channel status)
//! is now the only forwarded register in no row, so it gets the HC-6 default UNDEF, and
//! `guests/sysreg-probe` uses it to exercise macvmm's own injection on real HVF. The DCC is part
//! of the base debug architecture, so by the same rule it arguably should be RAZ (KVM:
//! `trap_raz_wi`); no guest has been seen touching it (Linux only with `CONFIG_HVC_DCC`).
//!
//! **The syndrome** (ARM ARM DDI 0487, D17.2.40 `ESR_EL2`, "ISS encoding for an exception from
//! MSR, MRS, or System instruction execution in AArch64 state"): `Op0, Op2, Op1, CRn, Rt, CRm,
//! Direction`, decoded by `arch::esr::decode_sysreg` into [`SysRegAccess`]. The five
//! coordinates are the register's name (`hv_sys_reg_t` packs the same fields).
//!
//! **The policy** ([`POLICY`], anchored as `sysreg_policy_table`):
//!
//! | Registers | Policy | Why |
//! |---|---|---|
//! | `OSLAR_EL1` (W), `OSLSR_EL1` (R), `OSDLR_EL1` (RW) | emulate the OS lock, per vCPU | Linux writes `OSLAR_EL1 = 0` at boot (`clear_os_lock`); QEMU emulates the same. ARM ARM D19.3 "OSLAR_EL1", "OSLSR_EL1", "OSDLR_EL1". |
//! | `DBG{B,W}{V,C}R<n>_EL1`, `MDCCINT_EL1`, `MDSCR_EL1` | RAZ/WI | no self-hosted debug for guests yet; the gdbstub (M26) may take these over |
//! | `LORID_EL1` (R) | RAZ, read-only (`MSR` is UNDEF) | `LO = 1`: FEAT_LOR is advertised, with zero LORegions (ARM ARM register description "LORID_EL1"); KVM gives the same answer |
//! | `LORSA_EL1`, `LOREA_EL1`, `LORN_EL1`, `LORC_EL1` | RAZ/WI | with `LORID_EL1.LR = 0` no region exists, so the registers have no effect (ARM ARM, "Limited ordering regions", FEAT_LOR; KVM: RAZ/WI) |
//! | PMU (`PMCR_EL0`, `PMCNTEN*`, `PMOVS*`, `PMSELR`, `PMCEID*`, `PMCCNTR`, `PMXEV*`, `PMUSERENR`, `PMINTEN*`, `PMEV*`, `PMCCFILTR`) | **inject UNDEF** | the guest sees `ID_AA64DFR0_EL1.PMUVer = 0`, so these registers do not exist and UNDEFINED is the architected response (ARM ARM D24, "Performance Monitors Extension"); HVF does the same itself with EL2 on |
//! | anything else forwarded | **inject UNDEF** | HC-6: the default is never "let it through"; RAZ/WI exceptions are added only with evidence of a real guest touching them |
//!
//! **Writes never reach host state** (HC-6). An emulated write changes only the per-vCPU
//! [`SysRegState`] below; nothing is forwarded to `hv_vcpu_set_sys_reg`.
//!
//! **Direction matters.** `OSLAR_EL1` is write-only and `OSLSR_EL1` read-only (the ARM ARM
//! lists the other direction as UNDEFINED), so an `MRS` of `OSLAR_EL1` is an UNDEF too.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::esr::SysRegAccess;
use hvf::SysReg;

/// What the VMM does with a trapped access (module docs table).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// `OSLAR_EL1`: writing bit 0 sets or clears the OS lock (write-only).
    OsLockAccess,
    /// `OSLSR_EL1`: reports the OS lock state (read-only).
    OsLockStatus,
    /// `OSDLR_EL1`: the OS double lock, bit 0 (read/write).
    OsDoubleLock,
    /// Read as zero, ignore writes.
    RazWi,
    /// Read as zero; the register is read-only, so an `MSR` is UNDEFINED.
    RazRo,
    /// Inject an UNDEFINED-instruction exception (`ESR_EL1.EC = 0x00`).
    Undef,
}

impl Policy {
    /// A short static name, for the trace and messages.
    pub const fn name(self) -> &'static str {
        match self {
            Policy::OsLockAccess | Policy::OsLockStatus | Policy::OsDoubleLock => "os-lock",
            Policy::RazWi => "raz/wi",
            Policy::RazRo => "raz/ro",
            Policy::Undef => "undef",
        }
    }
}

/// One row of [`POLICY`]: a group of registers that share `op0`, `op1` and `CRn`, with
/// inclusive `CRm` and `op2` ranges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule {
    /// The row's name, for documentation and tests (not the register's own name).
    pub what: &'static str,
    pub op0: u8,
    pub op1: u8,
    pub crn: u8,
    /// Inclusive `CRm` range.
    pub crm: (u8, u8),
    /// Inclusive `op2` range.
    pub op2: (u8, u8),
    pub policy: Policy,
}

impl Rule {
    /// True if `r` is one of this row's registers.
    pub const fn matches(&self, r: SysReg) -> bool {
        let (op0, op1, crn, crm, op2) = r.fields();
        op0 == self.op0
            && op1 == self.op1
            && crn == self.crn
            && crm >= self.crm.0
            && crm <= self.crm.1
            && op2 >= self.op2.0
            && op2 <= self.op2.1
    }
}

const fn one(
    what: &'static str,
    (op0, op1, crn, crm, op2): (u8, u8, u8, u8, u8),
    policy: Policy,
) -> Rule {
    Rule {
        what,
        op0,
        op1,
        crn,
        crm: (crm, crm),
        op2: (op2, op2),
        policy,
    }
}

/// A row covering inclusive `CRm` and `op2` ranges of the registers at `(op0, op1, CRn)`.
const fn span(
    what: &'static str,
    (op0, op1, crn): (u8, u8, u8),
    crm: (u8, u8),
    op2: (u8, u8),
    policy: Policy,
) -> Rule {
    Rule {
        what,
        op0,
        op1,
        crn,
        crm,
        op2,
        policy,
    }
}

// ANCHOR: sysreg_policy_table
/// The policy table (module docs). Coordinates are `(op0, op1, CRn, CRm, op2)` as each
/// register's ARM ARM description prints them ("Accessing <register>"); [`span`] rows give
/// inclusive `(lo, hi)` ranges for `CRm` and `op2`. First match wins; a register in no row
/// gets [`Policy::Undef`] (HC-6).
pub const POLICY: &[Rule] = &[
    // The OS lock (ARM ARM D19.3: OSLAR_EL1 2,0,1,0,4; OSLSR_EL1 2,0,1,1,4; OSDLR_EL1 2,0,1,3,4).
    one("OSLAR_EL1", (2, 0, 1, 0, 4), Policy::OsLockAccess),
    one("OSLSR_EL1", (2, 0, 1, 1, 4), Policy::OsLockStatus),
    one("OSDLR_EL1", (2, 0, 1, 3, 4), Policy::OsDoubleLock),
    // Breakpoint and watchpoint value/control registers: DBGBVR<n> op2 4, DBGBCR<n> 5,
    // DBGWVR<n> 6, DBGWCR<n> 7, with n = CRm (2,0,0,n,op2).
    span(
        "DBG{B,W}{V,C}R<n>_EL1",
        (2, 0, 0),
        (0, 15),
        (4, 7),
        Policy::RazWi,
    ),
    one("MDCCINT_EL1", (2, 0, 0, 2, 0), Policy::RazWi),
    one("MDSCR_EL1", (2, 0, 0, 2, 2), Policy::RazWi),
    // FEAT_LOR, advertised by `ID_AA64MMFR1_EL1.LO = 1` (module docs): LORSA_EL1 3,0,10,4,0,
    // LOREA_EL1 3,0,10,4,1, LORN_EL1 3,0,10,4,2, LORC_EL1 3,0,10,4,3 and LORID_EL1 3,0,10,4,7.
    // 3,0,10,4,4..6 (MPAMIDR_EL1 and reserved) are not LOR registers and keep the default.
    span(
        "LOR (LORSA, LOREA, LORN, LORC)",
        (3, 0, 10),
        (4, 4),
        (0, 3),
        Policy::RazWi,
    ),
    one("LORID_EL1", (3, 0, 10, 4, 7), Policy::RazRo),
    // PMU (ARM ARM D24.5): PMCR/PMCNTENSET/PMCNTENCLR/PMOVSCLR/PMSWINC/PMSELR/PMCEID0/1
    // (3,3,9,12,*), PMCCNTR/PMXEVTYPER/PMXEVCNTR (3,3,9,13,*), PMUSERENR/PMOVSSET (3,3,9,14,*),
    // PMINTENSET/PMINTENCLR/PMMIR (3,0,9,14,*), PMEVCNTR<n>/PMEVTYPER<n>/PMCCFILTR (3,3,14,8..15,*).
    // Listed explicitly, although UNDEF is also the default, so the table documents the decision
    // and a later RAZ/WI exception has a row to replace.
    span(
        "PMU (PMCR_EL0 .. PMOVSSET_EL0)",
        (3, 3, 9),
        (12, 14),
        (0, 7),
        Policy::Undef,
    ),
    span(
        "PMU (PMINTEN{SET,CLR}_EL1, PMMIR)",
        (3, 0, 9),
        (14, 14),
        (0, 7),
        Policy::Undef,
    ),
    span(
        "PMU (PMEV*<n>_EL0, PMCCFILTR)",
        (3, 3, 14),
        (8, 15),
        (0, 7),
        Policy::Undef,
    ),
];
// ANCHOR_END: sysreg_policy_table

/// The table row for `r`, if any.
pub fn rule_for(r: SysReg) -> Option<&'static Rule> {
    POLICY.iter().find(|rule| rule.matches(r))
}

/// The policy for `r`: its row's, or [`Policy::Undef`] (HC-6).
pub fn policy_for(r: SysReg) -> Policy {
    rule_for(r).map_or(Policy::Undef, |rule| rule.policy)
}

/// Registers HVF was **observed** forwarding as EC 0x18 that `hvf`'s tables do not name
/// (M5, docs/research/hvf-api.md §13 item 6), so traces and warnings can say which one it was.
/// Coordinates from the ARM ARM register descriptions.
pub const OBSERVED_NAMES: &[(&str, SysReg)] = &[
    ("MDCCSR_EL0", SysReg::new(2, 3, 0, 1, 0)),
    ("LORSA_EL1", SysReg::new(3, 0, 10, 4, 0)),
    ("LOREA_EL1", SysReg::new(3, 0, 10, 4, 1)),
    ("LORN_EL1", SysReg::new(3, 0, 10, 4, 2)),
    ("LORC_EL1", SysReg::new(3, 0, 10, 4, 3)),
    ("LORID_EL1", SysReg::new(3, 0, 10, 4, 7)),
];

/// The register's ARM ARM name, from `hvf`'s tables or [`OBSERVED_NAMES`] (a static string,
/// so it can go into a trace record, TTY-8).
pub fn static_name(r: SysReg) -> Option<&'static str> {
    r.name().or_else(|| {
        OBSERVED_NAMES
            .iter()
            .find(|(_, reg)| *reg == r)
            .map(|(n, _)| *n)
    })
}

/// The register's ARM ARM name if known ([`static_name`]), otherwise the generic
/// `S<op0>_<op1>_C<n>_C<m>_<op2>` spelling assemblers accept (for example `S3_0_C15_C0_0`).
pub fn display_name(r: SysReg) -> String {
    match static_name(r) {
        Some(n) => n.to_owned(),
        None => {
            let (a, b, n, m, c) = r.fields();
            format!("S{a}_{b}_C{n}_C{m}_{c}")
        }
    }
}

/// `OSLSR_EL1.OSLM` = `0b10` (bits {3, 0}): the OS lock is implemented with a 64-bit
/// `OSLAR_EL1` (ARM ARM D19.3 "OSLSR_EL1"). `nTT` (bit 2) is 0.
pub const OSLSR_OSLM_IMPLEMENTED: u64 = 1 << 3;
/// `OSLSR_EL1.OSLK`, bit 1: the OS lock is locked.
pub const OSLSR_OSLK: u64 = 1 << 1;

/// The emulated debug-lock state of one vCPU (HC-6: per vCPU, never host state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SysRegState {
    /// The OS lock. **Set on a cold reset** (ARM ARM D19.3 "OSLSR_EL1.OSLK": "On a Cold reset,
    /// this field resets to 1"), which is why Linux clears it early in boot.
    pub os_lock: bool,
    /// The OS double lock (`OSDLR_EL1.DLK`), clear on reset.
    pub os_double_lock: bool,
}

impl Default for SysRegState {
    fn default() -> SysRegState {
        SysRegState {
            os_lock: true,
            os_double_lock: false,
        }
    }
}

impl SysRegState {
    /// The value an `MRS OSLSR_EL1` reads.
    pub const fn oslsr(&self) -> u64 {
        OSLSR_OSLM_IMPLEMENTED | if self.os_lock { OSLSR_OSLK } else { 0 }
    }
}

/// What a trapped access resolves to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SysRegOutcome {
    /// An `MRS`: write this value into `Rt` (nothing if `Rt` is 31, XZR) and step over it.
    Read(u64),
    /// An `MSR` that was emulated or ignored: step over it.
    Written,
    /// Inject UNDEF; the PC moves to the guest's vector, not past the instruction.
    Undef,
}

// ANCHOR: sysreg_handle
/// Resolve one trapped access. `value` is `X[Rt]` for an `MSR` (ignored for an `MRS`). Pure:
/// only `state` changes, and only for the OS-lock registers.
pub fn handle(state: &mut SysRegState, access: &SysRegAccess, value: u64) -> SysRegOutcome {
    match (policy_for(access.encoding()), access.read) {
        (Policy::OsLockAccess, false) => {
            state.os_lock = value & 1 != 0; // OSLAR_EL1.OSLK, bit 0
            SysRegOutcome::Written
        }
        (Policy::OsLockStatus, true) => SysRegOutcome::Read(state.oslsr()),
        (Policy::OsDoubleLock, true) => SysRegOutcome::Read(u64::from(state.os_double_lock)),
        (Policy::OsDoubleLock, false) => {
            state.os_double_lock = value & 1 != 0; // OSDLR_EL1.DLK, bit 0
            SysRegOutcome::Written
        }
        (Policy::RazWi | Policy::RazRo, true) => SysRegOutcome::Read(0),
        (Policy::RazWi, false) => SysRegOutcome::Written,
        // MRS OSLAR_EL1, MSR OSLSR_EL1 and MSR LORID_EL1 are UNDEFINED, like every unlisted
        // register.
        (Policy::OsLockAccess, true)
        | (Policy::OsLockStatus, false)
        | (Policy::RazRo, false)
        | (Policy::Undef, _) => SysRegOutcome::Undef,
    }
}
// ANCHOR_END: sysreg_handle

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;

    fn acc(r: SysReg, read: bool) -> SysRegAccess {
        let (op0, op1, crn, crm, op2) = r.fields();
        SysRegAccess {
            op0,
            op1,
            crn,
            crm,
            op2,
            rt: 0,
            read,
        }
    }

    #[test]
    fn table_names_match_hvf() {
        for r in POLICY {
            if !r.what.contains(['(', '<']) {
                let reg = SysReg::new(r.op0, r.op1, r.crn, r.crm.0, r.op2.0);
                assert_eq!(static_name(reg), Some(r.what), "{r:?}");
            }
        }
    }

    #[test]
    fn os_lock_round_trip() {
        let mut s = SysRegState::default();
        assert!(s.os_lock, "locked from cold reset");
        let lar = acc(SysReg::OSLAR_EL1, false);
        let lsr = acc(SysReg::OSLSR_EL1, true);
        assert_eq!(handle(&mut s, &lsr, 0), SysRegOutcome::Read(0xa));
        assert_eq!(handle(&mut s, &lar, 0), SysRegOutcome::Written);
        assert_eq!(handle(&mut s, &lsr, 0), SysRegOutcome::Read(0x8));
        assert_eq!(handle(&mut s, &lar, 0xffff_fff1), SysRegOutcome::Written);
        assert_eq!(handle(&mut s, &lsr, 0), SysRegOutcome::Read(0xa));
    }
}
