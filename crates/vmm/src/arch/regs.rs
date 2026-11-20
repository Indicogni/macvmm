//! Register helpers: PSTATE (as `CPSR`/`SPSR` bits), `MPIDR_EL1` and `SCTLR_EL1` bits
//! (architecture §6.5; course ch06).
//!
//! **PSTATE in SPSR format** (ARM ARM DDI 0487, C5.2.18 `SPSR_EL1` and D1.4 "Process state,
//! PSTATE"). HVF's `HV_REG_CPSR` holds the guest's PSTATE in the same layout as `SPSR_EL2`:
//!
//! | Bits | Field | Meaning |
//! |---|---|---|
//! | 31:28 | N Z C V | condition flags |
//! | 9 | D | debug exceptions masked |
//! | 8 | A | SError masked |
//! | 7 | I | IRQ masked |
//! | 6 | F | FIQ masked |
//! | 4 | nRW | 0 = AArch64 |
//! | 3:2 | EL | exception level |
//! | 0 | SP | 0 = use SP_EL0 (`t`), 1 = use SP_ELx (`h`) |
//!
//! So `0x3c5` = D, A, I, F set (`0x3c0`), EL = 1 (`0x4`), SP = 1: **EL1h with every
//! interrupt masked**, which is how the VMM starts a vCPU (booting.rst §4: "all forms of
//! interrupt must be masked in PSTATE.DAIF"). `mrs x0, daif` returns the same bits 9:6, so a
//! guest started that way reads `DAIF = 0x3c0`, and `mrs x0, CurrentEL` reads `0x4` (EL in
//! bits 3:2; ARM ARM C5.2.1 `CurrentEL`).
//!
//! Everything here is a pure function of a `u64`, so the ch06 `pstate-builder` lab and the
//! fatal dump share it.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use core::fmt;

// ANCHOR: pstate_bits
/// PSTATE bits (SPSR format, module docs).
pub mod pstate {
    pub const N: u64 = 1 << 31;
    pub const Z: u64 = 1 << 30;
    pub const C: u64 = 1 << 29;
    pub const V: u64 = 1 << 28;
    pub const D: u64 = 1 << 9;
    pub const A: u64 = 1 << 8;
    pub const I: u64 = 1 << 7;
    pub const F: u64 = 1 << 6;
    pub const DAIF: u64 = D | A | I | F;
    /// `nRW`: set means AArch32 (we never run AArch32 guests).
    pub const NRW: u64 = 1 << 4;
    pub const SP: u64 = 1 << 0;
    /// The boot state: EL1h, DAIF masked (`0x3c5`).
    pub const EL1H_MASKED: u64 = DAIF | (1 << 2) | SP;
}
// ANCHOR_END: pstate_bits

// ANCHOR: sctlr_bits
/// `SCTLR_EL1` bits used by the VMM and its test guests (ARM ARM D19.2.118 `SCTLR_EL1`).
pub mod sctlr {
    /// Stage-1 MMU enable.
    pub const M: u64 = 1 << 0;
    /// Alignment check enable.
    pub const A: u64 = 1 << 1;
    /// Data cache enable (cacheability of data accesses).
    pub const C: u64 = 1 << 2;
    /// Instruction cache enable.
    pub const I: u64 = 1 << 12;
}
// ANCHOR_END: sctlr_bits

// ANCHOR: pstate_decode
/// A PSTATE value in SPSR format, with decoders for the dump.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pstate(pub u64);

impl Pstate {
    /// The exception level, bits 3:2.
    pub const fn el(self) -> u8 {
        ((self.0 >> 2) & 3) as u8
    }

    /// `SPSel`: true = SP_ELx (`h`), false = SP_EL0 (`t`).
    pub const fn sp_elx(self) -> bool {
        self.0 & pstate::SP != 0
    }

    /// True if the state is AArch32 (`nRW = 1`).
    pub const fn aarch32(self) -> bool {
        self.0 & pstate::NRW != 0
    }

    /// The D, A, I, F mask bits as they read in `mrs x, daif` (bits 9:6).
    pub const fn daif(self) -> u64 {
        self.0 & pstate::DAIF
    }

    /// The mode name: `EL0t`, `EL1t`, `EL1h`, `EL2t`, `EL2h`, ... or `AArch32` (unsupported).
    pub const fn mode_name(self) -> &'static str {
        if self.aarch32() {
            return "AArch32";
        }
        match (self.el(), self.sp_elx()) {
            (0, _) => "EL0t",
            (1, false) => "EL1t",
            (1, true) => "EL1h",
            (2, false) => "EL2t",
            (2, true) => "EL2h",
            (_, false) => "EL3t",
            (_, true) => "EL3h",
        }
    }
}
// ANCHOR_END: pstate_decode

/// Upper-case letter when the bit is set, lower-case when clear (`DAIF`, `dAif`, `nZcv`).
fn flags(f: &mut fmt::Formatter<'_>, v: u64, letters: &[(u64, char)]) -> fmt::Result {
    for &(bit, c) in letters {
        let c = if v & bit != 0 {
            c
        } else {
            c.to_ascii_lowercase()
        };
        f.write_fmt(format_args!("{c}"))?;
    }
    Ok(())
}

impl fmt::Display for Pstate {
    /// `EL1h, DAIF, nzcv`: the mode, then the mask and flag bits (upper case = set).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}, ", self.mode_name())?;
        flags(
            f,
            self.0,
            &[
                (pstate::D, 'D'),
                (pstate::A, 'A'),
                (pstate::I, 'I'),
                (pstate::F, 'F'),
            ],
        )?;
        f.write_str(", ")?;
        flags(
            f,
            self.0,
            &[
                (pstate::N, 'N'),
                (pstate::Z, 'Z'),
                (pstate::C, 'C'),
                (pstate::V, 'V'),
            ],
        )
    }
}

/// `CurrentEL` as `mrs x, CurrentEL` reads it for exception level `el` (EL in bits 3:2).
pub const fn current_el_value(el: u8) -> u64 {
    ((el & 3) as u64) << 2
}

// ANCHOR: mpidr_for_index
/// `MPIDR_EL1` for vCPU `index` (ARM ARM, register page `MPIDR_EL1`): bit 31 is RES1,
/// Aff1 (the cluster) = index / 16, Aff0 (the CPU in the cluster) = index % 16. Sixteen CPUs
/// per cluster, like QEMU `virt`, because the interrupt controller's CPU-to-CPU interrupt
/// message names at most 16 CPUs of one cluster (GICv3 spec, register `ICC_SGI1R_EL1`,
/// field `TargetList`; chapter 12).
pub fn mpidr(index: usize) -> u64 {
    let i = u64::try_from(index).unwrap_or(u64::MAX);
    (1 << 31) | (((i / 16) & 0xff) << 8) | (i % 16)
}
// ANCHOR_END: mpidr_for_index

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_pstate_is_el1h_masked() {
        let p = Pstate(pstate::EL1H_MASKED);
        assert_eq!(pstate::EL1H_MASKED, 0x3c5);
        assert_eq!(p.el(), 1);
        assert!(p.sp_elx());
        assert_eq!(p.daif(), 0x3c0);
        assert_eq!(p.to_string(), "EL1h, DAIF, nzcv");
        assert_eq!(current_el_value(p.el()), 0x4);
    }

    #[test]
    fn modes_and_flags() {
        assert_eq!(Pstate(0x3c4).mode_name(), "EL1t");
        assert_eq!(Pstate(0x3c9).mode_name(), "EL2h");
        assert_eq!(Pstate(0x0).mode_name(), "EL0t");
        assert_eq!(Pstate(0x10).mode_name(), "AArch32");
        assert_eq!(Pstate(0x6000_0105).to_string(), "EL1h, dAif, nZCv");
        assert_eq!(Pstate(0x6000_0145).to_string(), "EL1h, dAiF, nZCv");
        assert_eq!(Pstate(u64::MAX).mode_name(), "AArch32");
    }

    #[test]
    fn mpidr_layout() {
        assert_eq!(mpidr(0), 0x8000_0000);
        assert_eq!(mpidr(15), 0x8000_000f);
        assert_eq!(mpidr(16), 0x8000_0100);
        assert_eq!(mpidr(63), 0x8000_030f);
    }

    /// PLAN M16 "Acceptance: host" `mpidr_for_index`.
    #[test]
    fn mpidr_for_index() {
        assert_eq!(mpidr(0), 0x8000_0000);
        assert_eq!(mpidr(17), 0x8000_0101);
        // Aff3 and Aff2 stay 0 for every --cpus value, so the DT uses one address cell.
        assert!((0..64).all(|i| mpidr(i) & 0xff_00ff_0000 == 0));
    }
}
