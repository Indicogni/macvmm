//! Exception injection: make the guest take a synchronous exception to EL1, exactly as the
//! hardware would have (architecture §8.5; course ch08; threat model HC-7).
//!
//! **Why the VMM has to do this by hand.** When a trapped instruction should fault *in the
//! guest* (an `MRS` of a PMU register that does not exist, or, from M17, an MMIO access we
//! cannot emulate), the exception never happened in hardware: the access went to EL2 instead.
//! So the VMM performs the architectural exception entry itself (ARM ARM DDI 0487, D1.10
//! "Exception entry", and the `AArch64.TakeException()` pseudocode in J1):
//!
//! | Register | Value | Answers |
//! |---|---|---|
//! | `ELR_EL1` | the PC of the faulting instruction | *where* to resume |
//! | `SPSR_EL1` | the PSTATE (`CPSR`) at the fault | *in what state* to resume |
//! | `ESR_EL1` | `EC << 26 \| IL << 25 \| ISS` | *why* (D17.2.40 `ESR_ELx`) |
//! | `FAR_EL1` | the faulting virtual address (aborts only) | *which address* |
//! | `PSTATE` | EL1h, D/A/I/F masked; SS, IL, BTYPE, UAO cleared; NZCV, DIT kept; PAN set when `SCTLR_EL1.SPAN = 0`; SSBS = `SCTLR_EL1.DSSBS` | the handler's state |
//! | `PC` | `VBAR_EL1 + offset` | *where to go* |
//!
//! The course derives this table from the syscall path: an `svc` from EL0 does all of it in
//! hardware, and a VMM-injected UNDEF must be indistinguishable from a real one.
//!
//! **The vector offset** depends on where the exception came from (D1.10.2 "Exception
//! vectors"; each group of four is sync, IRQ, FIQ, SError):
//!
//! | PSTATE at the fault (`M[4:0]`) | Source | Offset |
//! |---|---|---|
//! | `0b00100` EL1t | current EL, SP_EL0 | `0x000` |
//! | `0b00101` EL1h | current EL, SP_EL1 | `0x200` |
//! | `0b00000` EL0t | lower EL, AArch64 | `0x400` |
//! | anything else (AArch32 `nRW = 1`, EL2, EL3, reserved) | — | [`InjectError::UnsupportedMode`] |
//!
//! **Totality (HC-7).** The `CPSR` is guest state. [`vector_offset`] is a total `match` on the
//! mode bits, and anything our vCPUs never run (AArch32, EL2 with EL2 off) is a typed error
//! that the exit handler turns into a `GuestFatal`, never a panic. `VBAR_EL1 + offset` uses
//! `checked_add` for the same reason.
//!
//! **Not modelled** (documented simplifications): `PSTATE.TCO` (FEAT_MTE, not exposed to HVF
//! guests), `PSTATE.ALLINT` (FEAT_NMI) and the AArch32 IT bits.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::esr::ec;
use super::regs::pstate;
use core::fmt;

/// The vector offsets (module docs).
pub mod offset {
    /// Synchronous exception, current EL with SP_EL0.
    pub const CURRENT_SP0: u64 = 0x000;
    /// Synchronous exception, current EL with SP_ELx.
    pub const CURRENT_SPX: u64 = 0x200;
    /// Synchronous exception, lower EL using AArch64.
    pub const LOWER_A64: u64 = 0x400;
}

/// `ESR_ELx.IL`: the trapped instruction was 32 bits (always, for A64).
pub const ESR_IL: u64 = 1 << 25;
/// DFSC `0b010000`: synchronous external abort, not on a translation table walk (D17.2.40).
pub const DFSC_SYNC_EXTERNAL: u32 = 0x10;
/// Data-abort ISS `WnR`, bit 6.
pub const ISS_WNR: u32 = 1 << 6;

/// PSTATE bits touched by exception entry, beyond `arch::regs::pstate` (SPSR format).
pub mod pstate_ext {
    /// `PAN`, bit 22 (FEAT_PAN).
    pub const PAN: u64 = 1 << 22;
    /// `SS`, bit 21: software step.
    pub const SS: u64 = 1 << 21;
    /// `IL`, bit 20: illegal execution state.
    pub const IL: u64 = 1 << 20;
    /// `DIT`, bit 24 (FEAT_DIT): kept across exception entry.
    pub const DIT: u64 = 1 << 24;
    /// `SSBS`, bit 12 (FEAT_SSBS).
    pub const SSBS: u64 = 1 << 12;
    /// N, Z, C, V: kept across exception entry.
    pub const NZCV: u64 = 0xf000_0000;
    /// `M[4:0]`: `nRW` plus EL and SP.
    pub const MODE: u64 = 0x1f;
}

/// `SCTLR_EL1` bits that shape the entry PSTATE (ARM ARM D19.2.118).
pub mod sctlr_ext {
    /// `SPAN`, bit 23: 0 = set PSTATE.PAN on exception entry to EL1.
    pub const SPAN: u64 = 1 << 23;
    /// `DSSBS`, bit 44: the PSTATE.SSBS value on exception entry.
    pub const DSSBS: u64 = 1 << 44;
}

/// The vCPU state injection reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VcpuState {
    /// The PC of the faulting instruction (a trap leaves the PC *at* it).
    pub pc: u64,
    /// PSTATE at the fault, SPSR format.
    pub cpsr: u64,
    pub vbar_el1: u64,
    pub sctlr_el1: u64,
}

/// The register writes that perform the injection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Injection {
    pub elr_el1: u64,
    pub spsr_el1: u64,
    pub esr_el1: u64,
    /// `Some` for aborts: the faulting virtual address.
    pub far_el1: Option<u64>,
    pub cpsr: u64,
    pub pc: u64,
}

/// Why an exception cannot be injected. The exit handler turns it into a `GuestFatal`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InjectError {
    /// The PSTATE mode at the fault is not EL0t, EL1t or EL1h (HC-7).
    UnsupportedMode { cpsr: u64 },
    /// `VBAR_EL1 + offset` overflows 64 bits.
    VectorOverflow { vbar: u64, offset: u64 },
}

impl fmt::Display for InjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            InjectError::UnsupportedMode { cpsr } => write!(
                f,
                "cannot inject an exception: unsupported PSTATE mode {:#x} (cpsr {cpsr:#x})",
                cpsr & pstate_ext::MODE
            ),
            InjectError::VectorOverflow { vbar, offset } => write!(
                f,
                "cannot inject an exception: VBAR_EL1 {vbar:#x} + {offset:#x} overflows"
            ),
        }
    }
}

/// The synchronous-exception vector offset for an exception taken from `cpsr` (module docs
/// table). Total over every `u64` (HC-7).
pub const fn vector_offset(cpsr: u64) -> Result<u64, InjectError> {
    match cpsr & pstate_ext::MODE {
        0b00100 => Ok(offset::CURRENT_SP0),
        0b00101 => Ok(offset::CURRENT_SPX),
        0b00000 => Ok(offset::LOWER_A64),
        _ => Err(InjectError::UnsupportedMode { cpsr }),
    }
}

/// True if an exception from `cpsr` is taken from EL0 (a "lower EL"). Only meaningful when
/// [`vector_offset`] accepted `cpsr`.
pub const fn from_lower_el(cpsr: u64) -> bool {
    cpsr & pstate_ext::MODE == 0
}

/// PSTATE on entry to the EL1h handler (module docs table).
pub const fn entry_pstate(old: u64, sctlr_el1: u64) -> u64 {
    let mut p = pstate::EL1H_MASKED | (old & (pstate_ext::NZCV | pstate_ext::DIT));
    p |= if sctlr_el1 & sctlr_ext::SPAN == 0 {
        pstate_ext::PAN
    } else {
        old & pstate_ext::PAN
    };
    if sctlr_el1 & sctlr_ext::DSSBS != 0 {
        p |= pstate_ext::SSBS;
    }
    p
}

// ANCHOR: inject_sync_exception
/// Compute the register writes that make the guest take a synchronous exception with
/// exception class `ec` and syndrome `iss` (25 bits; higher bits are dropped) to EL1. `far`
/// is the faulting VA for aborts. Pure: the caller writes the result to the vCPU.
pub fn sync_exception(
    st: &VcpuState,
    ec: u8,
    iss: u32,
    far: Option<u64>,
) -> Result<Injection, InjectError> {
    let off = vector_offset(st.cpsr)?;
    let pc = st
        .vbar_el1
        .checked_add(off)
        .ok_or(InjectError::VectorOverflow {
            vbar: st.vbar_el1,
            offset: off,
        })?;
    Ok(Injection {
        elr_el1: st.pc, // the faulting instruction itself: the handler decides whether to skip it
        spsr_el1: st.cpsr,
        esr_el1: (u64::from(ec & 0x3f) << 26) | ESR_IL | u64::from(iss & 0x01ff_ffff),
        far_el1: far,
        cpsr: entry_pstate(st.cpsr, st.sctlr_el1),
        pc,
    })
}
// ANCHOR_END: inject_sync_exception

/// An UNDEFINED-instruction exception: EC `0x00` ("unknown reason"), ISS 0, IL 1, so
/// `ESR_EL1 = 0x0200_0000`. What a guest sees for a register that does not exist.
pub fn undef(st: &VcpuState) -> Result<Injection, InjectError> {
    sync_exception(st, ec::UNKNOWN, 0, None)
}

// ANCHOR: inject_data_abort
/// A synchronous external data abort at virtual address `far` (DFSC `0x10`): EC `0x25` from
/// EL1, `0x24` from EL0, with `WnR` for a write and ISV = 0 (no instruction syndrome). Used
/// for MMIO the VMM refuses to emulate (M17, MMIO-4/MMIO-6).
pub fn data_abort(st: &VcpuState, far: u64, is_write: bool) -> Result<Injection, InjectError> {
    // Validate the mode first, so an unsupported mode is reported as such.
    vector_offset(st.cpsr)?;
    let ec = if from_lower_el(st.cpsr) {
        ec::DABT_LOWER
    } else {
        ec::DABT_CUR
    };
    let iss = DFSC_SYNC_EXTERNAL | if is_write { ISS_WNR } else { 0 };
    sync_exception(st, ec, iss, Some(far))
}
// ANCHOR_END: inject_data_abort

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undef_from_el1h() {
        let st = VcpuState {
            pc: 0x4008_0100,
            cpsr: 0x3c5,
            vbar_el1: 0x4008_0800,
            sctlr_el1: sctlr_ext::SPAN,
        };
        let i = undef(&st).unwrap();
        assert_eq!(i.esr_el1, 0x0200_0000);
        assert_eq!(
            (i.elr_el1, i.spsr_el1, i.pc),
            (0x4008_0100, 0x3c5, 0x4008_0a00)
        );
        assert_eq!(i.cpsr, 0x3c5);
        assert_eq!(i.far_el1, None);
    }
}
