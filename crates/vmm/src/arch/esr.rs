//! Exit decoding: turn what `hv_vcpu_run` reports into the frozen [`Exit`] enum (architecture
//! §6.4; course ch07; threat model MMIO-1).
//!
//! **Where the information comes from.** For `HV_EXIT_REASON_EXCEPTION` the framework hands us
//! the guest's syndrome as it was written to `ESR_EL2` (ARM ARM DDI 0487, D17.2.40 `ESR_EL2`):
//!
//! ```text
//!  63      56 55          32 31    26 25 24                              0
//! +----------+--------------+--------+--+---------------------------------+
//! |   RES0   |     ISS2     |   EC   |IL|               ISS               |
//! +----------+--------------+--------+--+---------------------------------+
//! ```
//!
//! (Armv8.7 introduced ISS2 as bits 36:32; later issues of DDI 0487 widened it to 55:32. We
//! ignore it either way.)
//!
//! `EC` (exception class) says *what* trapped, `IL` whether the trapped instruction was 32 bits
//! (always 1 for A64), and `ISS` (instruction-specific syndrome) carries the details, with a
//! layout that depends on the EC. The ECs a guest can produce under HVF are the ones in
//! [`ec`]; every other value decodes to [`Exit::Unknown`] and stops the VM with a dump.
//!
//! **The data-abort ISS** (D17.2.40, "ISS encoding for an exception from a Data Abort") is the
//! one ch07 is about, because it is how MMIO is emulated without decoding instructions:
//!
//! | Bits | Field | Meaning |
//! |---|---|---|
//! | 24 | ISV | the fields 23:14 below are valid (instruction syndrome valid) |
//! | 23:22 | SAS | access size: `1 << SAS` bytes |
//! | 21 | SSE | a load sign-extends |
//! | 20:16 | SRT | the register transferred; 31 means XZR, never SP |
//! | 15 | SF | the register is 64 bits wide (X), not 32 (W) |
//! | 14 | AR | acquire/release semantics |
//! | 10 | FnV | FAR is not valid |
//! | 7 | S1PTW | the fault happened during the guest's own stage-1 table walk |
//! | 6 | WnR | write, not read |
//! | 5:0 | DFSC | data fault status code (translation fault level n, permission, ...) |
//!
//! **Totality (MMIO-1).** The syndrome comes from hardware describing what a hostile guest did,
//! so [`Exit::decode`] is a pure function that is defined for every `u64`: it only shifts and
//! masks, never indexes, and has no `unwrap`. `tests/esr_vectors.rs` sweeps a million xorshift
//! values through it. The data-abort fields are decoded even when ISV is 0; bits 23:14 are
//! then RES0 (no valid instruction syndrome), and `vcpu/mmio.rs` must not use them (it
//! refuses ISV=0 until M17).
//!
//! **What is not decided here.** This module says what an exit *is*; `vcpu/exit.rs` decides
//! what it *means* (the PC-advance table), and `vcpu/mmio.rs` emulates data aborts.
// ANCHOR: esr_lints
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]
// ANCHOR_END: esr_lints

use core::fmt;
use hvf::{ExitReason, SysReg};

/// Exception classes the VMM recognises (ARM ARM D17.2.40, `ESR_EL2.EC`).
pub mod ec {
    /// Unknown reason (an UNDEFINED instruction, among others).
    pub const UNKNOWN: u8 = 0x00;
    /// WFI, WFE, WFIT or WFET (only trapped without the in-kernel GIC).
    pub const WFX: u8 = 0x01;
    /// HVC from AArch64. The PC has already advanced past it (spike finding 5).
    pub const HVC64: u8 = 0x16;
    /// SMC from AArch64. The PC still points at it (spike finding 6).
    pub const SMC64: u8 = 0x17;
    /// MSR, MRS or a system instruction, trapped.
    pub const SYSREG: u8 = 0x18;
    /// Instruction abort from a lower EL (a stage-2 fault on an instruction fetch).
    pub const IABT_LOWER: u8 = 0x20;
    /// Instruction abort taken without a change of EL (seen in a *guest's* ESR_EL1).
    pub const IABT_CUR: u8 = 0x21;
    /// Data abort from a lower EL (a stage-2 fault on a load or store: MMIO).
    pub const DABT_LOWER: u8 = 0x24;
    /// Data abort taken without a change of EL (seen in a *guest's* ESR_EL1).
    pub const DABT_CUR: u8 = 0x25;
    /// BRK instruction (only trapped with debug exceptions routed to the VMM).
    pub const BRK64: u8 = 0x3c;
}

// ANCHOR: esr_fields
// ANCHOR: esr_field_helpers
/// The value of `width` bits of `v` starting at bit `lo` (`width ≤ 16`). Total: the mask is
/// built with a checked shift and the result fits by construction.
const fn field(v: u64, lo: u32, width: u32) -> u64 {
    let mask = match 1u64.checked_shl(width) {
        Some(m) => m.wrapping_sub(1),
        None => u64::MAX,
    };
    match v.checked_shr(lo) {
        Some(s) => s & mask,
        None => 0,
    }
}

/// `field` narrowed to `u8` (callers pass `width ≤ 8`, so nothing is lost).
#[allow(clippy::cast_possible_truncation)] // masked to 8 bits first
const fn field8(v: u64, lo: u32, width: u32) -> u8 {
    (field(v, lo, width) & 0xff) as u8
}

/// `field` narrowed to `u16` (callers pass `width ≤ 16`).
#[allow(clippy::cast_possible_truncation)] // masked to 16 bits first
const fn field16(v: u64, lo: u32, width: u32) -> u16 {
    (field(v, lo, width) & 0xffff) as u16
}

const fn bit(v: u64, n: u32) -> bool {
    field(v, n, 1) != 0
}

// ANCHOR_END: esr_field_helpers
// ANCHOR: esr_header_fields
/// `ESR.EC`, bits 31:26.
pub const fn esr_ec(esr: u64) -> u8 {
    field8(esr, 26, 6)
}

/// `ESR.IL`, bit 25: the trapped instruction was 32 bits long (always 1 for A64).
pub const fn esr_il(esr: u64) -> bool {
    bit(esr, 25)
}

/// `ESR.ISS`, bits 24:0.
#[allow(clippy::cast_possible_truncation)] // masked to 25 bits first
pub const fn esr_iss(esr: u64) -> u32 {
    (field(esr, 0, 25) & 0x01ff_ffff) as u32
}
// ANCHOR_END: esr_header_fields
// ANCHOR_END: esr_fields

// ANCHOR: esr_data_abort_struct
/// A data abort's syndrome (the module docs table). Frozen: later chapters use this shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DataAbort {
    pub isv: bool,
    /// Access size as `log2(bytes)`: 0..=3.
    pub sas: u8,
    pub sse: bool,
    /// Register number 0..=31; 31 is XZR.
    pub srt: u8,
    pub sf: bool,
    pub ar: bool,
    pub fnv: bool,
    pub s1ptw: bool,
    pub wnr: bool,
    pub dfsc: u8,
}
// ANCHOR_END: esr_data_abort_struct

// ANCHOR: esr_data_abort_size
impl DataAbort {
    /// The access size in bytes, `1 << SAS` (1, 2, 4 or 8; SAS is two bits, so always valid).
    pub const fn size_bytes(&self) -> u8 {
        match 1u8.checked_shl((self.sas & 3) as u32) {
            Some(n) => n,
            None => 8, // unreachable: the shift is at most 3
        }
    }
}
// ANCHOR_END: esr_data_abort_size

// ANCHOR: esr_sysreg_access
/// A trapped `MSR`/`MRS`/system instruction (EC 0x18; D17.2.40, "ISS encoding for an exception
/// from MSR, MRS, or System instruction execution in AArch64 state"). Frozen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SysRegAccess {
    pub op0: u8,
    pub op1: u8,
    pub crn: u8,
    pub crm: u8,
    pub op2: u8,
    /// The general-purpose register; 31 means XZR.
    pub rt: u8,
    /// `Direction = 1`: MRS (a read into Rt).
    pub read: bool,
}

impl SysRegAccess {
    /// The register as `hv_sys_reg_t` (`op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2`), the id
    /// `hv_vcpu_{get,set}_sys_reg` takes (verified against the header by `hvf`'s tests).
    pub const fn encoding(&self) -> SysReg {
        SysReg::new(self.op0, self.op1, self.crn, self.crm, self.op2)
    }
}
// ANCHOR_END: esr_sysreg_access

// ANCHOR: exit_enum
/// What one `hv_vcpu_run` return was. Frozen: later chapters add handlers, never variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    /// `HV_EXIT_REASON_CANCELED`: our own kick; may be spurious or sticky (seen on real hardware).
    Canceled,
    /// `HV_EXIT_REASON_VTIMER_ACTIVATED` (never seen with the in-kernel GIC).
    VtimerActivated,
    /// EC 0x01. `ti`: 0 WFI, 1 WFE, 2 WFIT, 3 WFET.
    Wfx { ti: u8 },
    /// EC 0x16. The PC has ALREADY advanced past the HVC.
    Hvc { imm: u16 },
    /// EC 0x17. The PC still points AT the SMC.
    Smc { imm: u16 },
    /// EC 0x18.
    SysReg(SysRegAccess),
    /// EC 0x20.
    InstructionAbort { ifsc: u8, s1ptw: bool },
    /// EC 0x24.
    DataAbort(DataAbort),
    /// EC 0x3c (only with debug exceptions trapped).
    Brk { imm: u16 },
    /// Any other EC, and `HV_EXIT_REASON_UNKNOWN` or an undefined reason.
    Unknown { ec: u8, esr: u64 },
}
// ANCHOR_END: exit_enum

/// Data-abort ISS `CM`, bit 8: the abort came from a cache-maintenance instruction (`DC`/`IC`
/// by VA) rather than a load or store (D17.2.40). Only the ISV = 0 path needs it (M17: such an
/// instruction is skipped, not emulated), so it is not part of the frozen [`DataAbort`].
pub const fn data_abort_cm(esr: u64) -> bool {
    bit(esr, 8)
}

// ANCHOR: esr_decode_data_abort
/// Decode a data-abort ISS (module docs table). Every field is masked to its width, so any
/// `esr` gives a value; with ISV = 0 bits 23:14 are RES0, so those fields carry nothing.
pub const fn decode_data_abort(esr: u64) -> DataAbort {
    DataAbort {
        isv: bit(esr, 24),
        sas: field8(esr, 22, 2),
        sse: bit(esr, 21),
        srt: field8(esr, 16, 5),
        sf: bit(esr, 15),
        ar: bit(esr, 14),
        fnv: bit(esr, 10),
        s1ptw: bit(esr, 7),
        wnr: bit(esr, 6),
        dfsc: field8(esr, 0, 6),
    }
}
// ANCHOR_END: esr_decode_data_abort

// ANCHOR: esr_decode_sysreg
/// Decode a sysreg-trap ISS (EC 0x18).
pub const fn decode_sysreg(esr: u64) -> SysRegAccess {
    SysRegAccess {
        op0: field8(esr, 20, 2),
        op2: field8(esr, 17, 3),
        op1: field8(esr, 14, 3),
        crn: field8(esr, 10, 4),
        rt: field8(esr, 5, 5),
        crm: field8(esr, 1, 4),
        read: bit(esr, 0),
    }
}
// ANCHOR_END: esr_decode_sysreg

// ANCHOR: esr_decode
impl Exit {
    /// Decode an `ESR_EL2` value from an `EXCEPTION` exit. Pure and total: never panics for
    /// any `u64`, because a hostile guest chooses what trapped. An EC we do not handle is
    /// [`Exit::Unknown`], which the exit handler turns into a fatal stop with a dump.
    pub const fn decode(esr: u64) -> Exit {
        let imm = field16(esr, 0, 16);
        match esr_ec(esr) {
            ec::WFX => Exit::Wfx {
                ti: field8(esr, 0, 2),
            },
            ec::HVC64 => Exit::Hvc { imm },
            ec::SMC64 => Exit::Smc { imm },
            ec::SYSREG => Exit::SysReg(decode_sysreg(esr)),
            ec::IABT_LOWER => Exit::InstructionAbort {
                ifsc: field8(esr, 0, 6),
                s1ptw: bit(esr, 7),
            },
            ec::DABT_LOWER => Exit::DataAbort(decode_data_abort(esr)),
            ec::BRK64 => Exit::Brk { imm },
            other => Exit::Unknown { ec: other, esr },
        }
    }

    /// Combine the framework's exit reason with the syndrome: `CANCELED` and
    /// `VTIMER_ACTIVATED` carry no syndrome, `EXCEPTION` is decoded, and `UNKNOWN` (or a value
    /// this SDK does not define) is [`Exit::Unknown`] with the syndrome kept for the dump.
    pub const fn from_hv(reason: ExitReason, esr: u64) -> Exit {
        match reason {
            ExitReason::Canceled => Exit::Canceled,
            ExitReason::VtimerActivated => Exit::VtimerActivated,
            ExitReason::Exception => Exit::decode(esr),
            ExitReason::Unknown | ExitReason::Other(_) => Exit::Unknown {
                ec: esr_ec(esr),
                esr,
            },
        }
    }
}
// ANCHOR_END: esr_decode

impl Exit {
    /// A short static name, for traces, stats and messages.
    pub const fn name(&self) -> &'static str {
        match self {
            Exit::Canceled => "canceled",
            Exit::VtimerActivated => "vtimer",
            Exit::Wfx { .. } => "wfx",
            Exit::Hvc { .. } => "hvc",
            Exit::Smc { .. } => "smc",
            Exit::SysReg(_) => "sysreg",
            Exit::InstructionAbort { .. } => "instruction abort",
            Exit::DataAbort(_) => "data abort",
            Exit::Brk { .. } => "brk",
            Exit::Unknown { .. } => "unknown",
        }
    }
}

// ANCHOR: esr_ec_name
/// A static name for an exception class, for dumps (ARM ARM, register page `ESR_EL1`, the EC
/// table). `None` for a class we never expect to see.
pub const fn ec_name(ec: u8) -> Option<&'static str> {
    Some(match ec {
        0x00 => "unknown reason",
        0x01 => "WFI/WFE",
        0x07 => "SVE/SIMD/FP access",
        0x0e => "illegal execution state",
        0x15 => "SVC (AArch64)",
        0x16 => "HVC (AArch64)",
        0x17 => "SMC (AArch64)",
        0x18 => "MSR/MRS/system instruction",
        0x19 => "SVE access",
        0x20 => "instruction abort from a lower EL",
        0x21 => "instruction abort, same EL",
        0x22 => "PC alignment fault",
        0x24 => "data abort from a lower EL",
        0x25 => "data abort, same EL",
        0x26 => "SP alignment fault",
        0x2c => "floating-point exception",
        0x2f => "SError",
        0x30 | 0x31 => "breakpoint",
        0x32 | 0x33 => "software step",
        0x34 | 0x35 => "watchpoint",
        0x3c => "BRK (AArch64)",
        _ => return None,
    })
}
// ANCHOR_END: esr_ec_name

/// A static name for a data or instruction fault status code (DFSC/IFSC; D17.2.40, the
/// DFSC table, long-descriptor format). `None` for codes we do not name.
pub const fn fsc_name(fsc: u8) -> Option<&'static str> {
    Some(match fsc {
        0x00..=0x03 => "address size fault",
        0x04..=0x07 => "translation fault",
        0x08..=0x0b => "access flag fault",
        0x0c..=0x0f => "permission fault",
        0x10 => "synchronous external abort",
        0x11 => "synchronous tag check fault",
        0x14..=0x17 => "synchronous external abort on a table walk",
        0x21 => "alignment fault",
        0x30 => "TLB conflict abort",
        _ => return None,
    })
}

impl fmt::Display for DataAbort {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ISV={} SAS={} ({} bytes) SSE={} SRT={} SF={} AR={} FnV={} S1PTW={} WnR={} DFSC={:#x}",
            u8::from(self.isv),
            self.sas,
            self.size_bytes(),
            u8::from(self.sse),
            self.srt,
            u8::from(self.sf),
            u8::from(self.ar),
            u8::from(self.fnv),
            u8::from(self.s1ptw),
            u8::from(self.wnr),
            self.dfsc
        )?;
        if let Some(n) = fsc_name(self.dfsc) {
            write!(f, " ({n})")?;
        }
        Ok(())
    }
}

impl fmt::Display for Exit {
    /// One line naming the exit and its decoded fields. Only numbers and static names
    /// (LOG-5), so it is safe in a dump.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Exit::Canceled => f.write_str("canceled (hv_vcpus_exit)"),
            Exit::VtimerActivated => f.write_str("vtimer activated"),
            Exit::Wfx { ti } => {
                let what = match ti {
                    0 => "WFI",
                    1 => "WFE",
                    2 => "WFIT",
                    _ => "WFET",
                };
                write!(f, "wfx (EC 0x01): {what}")
            }
            Exit::Hvc { imm } => write!(f, "hvc (EC 0x16): imm={imm:#x}"),
            Exit::Smc { imm } => write!(f, "smc (EC 0x17): imm={imm:#x}"),
            Exit::SysReg(s) => {
                write!(
                    f,
                    "sysreg (EC 0x18): {} S{}_{}_C{}_C{}_{} rt={}",
                    if s.read { "MRS" } else { "MSR" },
                    s.op0,
                    s.op1,
                    s.crn,
                    s.crm,
                    s.op2,
                    s.rt
                )?;
                if let Some(n) = s.encoding().name() {
                    write!(f, " ({n})")?;
                }
                Ok(())
            }
            Exit::InstructionAbort { ifsc, s1ptw } => {
                write!(
                    f,
                    "instruction abort (EC 0x20): IFSC={ifsc:#x} S1PTW={}",
                    u8::from(*s1ptw)
                )?;
                if let Some(n) = fsc_name(*ifsc) {
                    write!(f, " ({n})")?;
                }
                Ok(())
            }
            Exit::DataAbort(da) => write!(f, "data abort (EC 0x24): {da}"),
            Exit::Brk { imm } => write!(f, "brk (EC 0x3c): imm={imm:#x}"),
            Exit::Unknown { ec, esr } => {
                write!(f, "unknown (EC {ec:#04x}, ESR {esr:#x})")?;
                if let Some(n) = ec_name(*ec) {
                    write!(f, ": {n}")?;
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;

    /// The syndromes the M1 spike observed on this machine (spikes/hvf-hello/RESULTS.md).
    #[test]
    fn spike_syndromes() {
        assert_eq!(Exit::decode(0x5a00_0001), Exit::Hvc { imm: 1 });
        assert_eq!(Exit::decode(0x5e00_0003), Exit::Smc { imm: 3 });
        assert_eq!(Exit::decode(0x07e0_0000), Exit::Wfx { ti: 0 });
        // `str w1, [x0]` with x0 = 0x0900_0000.
        assert_eq!(
            Exit::decode(0x9381_0046),
            Exit::DataAbort(DataAbort {
                isv: true,
                sas: 2,
                sse: false,
                srt: 1,
                sf: false,
                ar: false,
                fnv: false,
                s1ptw: false,
                wnr: true,
                dfsc: 6
            })
        );
        // `ldp` to MMIO: ISV = 0.
        let Exit::DataAbort(da) = Exit::decode(0x9200_0046) else {
            panic!()
        };
        assert!(!da.isv && da.wnr && da.dfsc == 6);
        // The PMCR_EL0 read (`mrs x4, pmcr_el0`).
        let Exit::SysReg(s) = Exit::decode(0x6230_e499) else {
            panic!()
        };
        assert_eq!(s.encoding(), SysReg::PMCR_EL0);
        assert_eq!(SysReg::from_iss(esr_iss(0x6230_e499)), s.encoding());
        assert!(s.read && s.rt == 4);
        assert_eq!(
            Exit::decode(0x8200_0006),
            Exit::InstructionAbort {
                ifsc: 6,
                s1ptw: false
            }
        );
    }

    #[test]
    fn from_hv_reasons() {
        assert_eq!(
            Exit::from_hv(ExitReason::Canceled, 0x5a00_0000),
            Exit::Canceled
        );
        assert_eq!(
            Exit::from_hv(ExitReason::VtimerActivated, 0),
            Exit::VtimerActivated
        );
        assert_eq!(
            Exit::from_hv(ExitReason::Other(77), 0x5a00_0000),
            Exit::Unknown {
                ec: 0x16,
                esr: 0x5a00_0000
            }
        );
        assert_eq!(
            Exit::from_hv(ExitReason::Exception, 0xf200_0007),
            Exit::Brk { imm: 7 }
        );
        assert_eq!(
            Exit::from_hv(ExitReason::Exception, 0x9600_0021),
            Exit::Unknown {
                ec: 0x25,
                esr: 0x9600_0021
            }
        );
    }

    #[test]
    fn sizes_and_display() {
        for sas in 0..4u8 {
            let esr = 0x9300_0000u64 | (u64::from(sas) << 22);
            let Exit::DataAbort(da) = Exit::decode(esr) else {
                panic!()
            };
            assert_eq!(da.size_bytes(), 1 << sas);
        }
        assert_eq!(
            Exit::decode(0x9381_0046).to_string(),
            "data abort (EC 0x24): ISV=1 SAS=2 (4 bytes) SSE=0 SRT=1 SF=0 AR=0 FnV=0 S1PTW=0 \
             WnR=1 DFSC=0x6 (translation fault)"
        );
        assert_eq!(
            Exit::decode(0x8200_0006).to_string(),
            "instruction abort (EC 0x20): IFSC=0x6 S1PTW=0 (translation fault)"
        );
        assert_eq!(
            Exit::decode(0x6230_e499).to_string(),
            "sysreg (EC 0x18): MRS S3_3_C9_C12_0 rt=4 (PMCR_EL0)"
        );
        assert_eq!(
            Exit::decode(0x0200_0000).to_string(),
            "unknown (EC 0x00, ESR 0x2000000): unknown reason"
        );
        assert_eq!(esr_ec(u64::MAX), 0x3f);
        assert!(esr_il(0x5a00_0000));
        assert_eq!(esr_iss(u64::MAX), 0x01ff_ffff);
    }
}
