//! MMIO emulation for data aborts: ISV = 1 from the syndrome, ISV = 0 by decoding the
//! instruction (architecture §8.3; course ch07, ch21; threat model MMIO-2, MMIO-3, MMIO-4,
//! MMIO-6).
//!
//! **The story.** The guest ran `str w2, [x1]` and `x1` pointed at a hole in stage 2. Before
//! handing us the exit, the hardware wrote a note in `ESR_EL2` (decoded by `arch/esr.rs`):
//! this was a write (WnR), of 4 bytes (SAS), from register 2 (SRT), a 32-bit register (SF = 0);
//! for loads, whether to sign-extend (SSE). ISV says whether the note was written at all. With
//! ISV = 1 we emulate the *access*, never the instruction (ARM ARM DDI 0487, D17.2.40, the ISS
//! encoding for a Data Abort; on x86 a VMM has to fetch and decode the instruction itself).
//!
//! **The steps** ([`handle`]):
//! 1. `S1PTW = 1`: the guest's own stage-1 table walk touched a non-RAM IPA. Its page tables
//!    point at MMIO; that is fatal, never emulated (MMIO-2).
//! 2. **Classify the exit IPA with our own map, never with DFSC** ([`classify_ipa`], MMIO-2,
//!    spike finding 7): RAM, a device on the [`Bus`], ROM without a device, or nothing. RAM is
//!    always fully mapped, so a fault there is a VMM bug (fatal; dirty tracking would retry
//!    here, post-v1).
//! 3. ISV = 0 (`ldp`/`stp`, writeback forms, exclusives, atomics, SIMD: the note has room for
//!    one register and no writeback): [`isv0`] (M17) fetches the instruction at the PC through
//!    the guest's stage 1 (`arch::stage1_walk`), decodes it (`arch::insn`), checks it against
//!    the exit (the decoded address must translate to the exit IPA, the direction must match
//!    `WnR`, a pair must stay inside one device window: MMIO-4), performs the accesses on the
//!    exit IPA and only then writes the registers (loads, then the base writeback, with
//!    Rn = 31 meaning the SP that PSTATE selects). Anything refused or unsupported (SIMD/FP,
//!    exclusives, atomics, `DC ZVA`, a mismatch) is answered with a synchronous external
//!    abort injected into the guest, never a VMM error (MMIO-6). `PRFM` and cache
//!    maintenance by VA with `ESR.CM = 1` make no access and just advance the PC.
//! 4. Build the [`MmioAccess`] ([`MmioAccess::from_data_abort`], MMIO-3): `size = 1 << SAS`
//!    (always valid: SAS is two bits); on a write the value is `X[SRT]` **masked to the size**,
//!    and `SRT = 31` is XZR, so the value is 0 (it is never SP in a load/store syndrome);
//! 5. dispatch to the device; a read result is extended per SSE and SF ([`sign_extend`]) and
//!    written to `X[SRT]`, discarded when `SRT = 31`; a straddling or unmapped access goes to
//!    the `--unhandled-mmio` policy;
//! 6. the caller advances the PC by 4 (a data abort's saved PC is the faulting instruction:
//!    without the advance the guest retries the same store forever).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::exit::{ExitEnv, MmioVerdict, VcpuRegs, unhandled_mmio_policy};
use crate::arch::esr::{DataAbort, data_abort_cm};
use crate::arch::insn::{self, ExitFacts, Gpr, Insn, Isv0Bus, Isv0Error, Operands, SpSel};
use crate::arch::layout::{Layout, RegionKind};
use crate::arch::regs::Pstate;
use crate::arch::stage1_walk::{self, TranslationRegs};
use crate::bus::{AccessSize, Bus, BusError};
use crate::config::MmioPolicy;
use crate::error::Result;
use crate::memory::{GuestAddress, GuestMemory};
use crate::trace::{Action, ExitRecord};
use core::fmt;
use hvf::SysReg;

/// One decoded MMIO access (architecture §6.4). [frozen ch07]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MmioAccess {
    pub ipa: u64,
    pub size: AccessSize,
    /// `Some(value)` for a store: `X[SRT]` masked to `size` (0 for XZR).
    pub write: Option<u64>,
    /// SRT: the register loaded or stored; 31 = XZR.
    pub reg: u8,
    /// SSE: sign-extend a load.
    pub sign_extend: bool,
    /// SF: the register is an X register (64-bit), not W.
    pub sixty_four: bool,
}

// ANCHOR: mmio_sign_extend
/// Extend a `size`-byte value loaded from a device into what the instruction puts in its
/// register (MMIO-3): with SSE, sign-extend from `size * 8` bits; then, for a W register
/// (SF = 0), keep 32 bits, because writing `Wt` zeroes the upper half of `Xt`. So `ldrsh w`
/// of `0x8001` gives `0xffff_8001` and `ldrsh x` gives `0xffff_ffff_ffff_8001`.
pub fn sign_extend(value: u64, size: AccessSize, sse: bool, sixty_four: bool) -> u64 {
    let v = value & size.mask();
    let v = if sse && size != AccessSize::B8 {
        // Shift the sign bit to bit 63, then arithmetic-shift back.
        let unused =
            64u32.saturating_sub(u32::try_from(size.bytes().saturating_mul(8)).unwrap_or(64));
        let shifted = v.checked_shl(unused).unwrap_or(0).cast_signed();
        shifted.checked_shr(unused).unwrap_or(0).cast_unsigned()
    } else {
        v
    };
    if sixty_four { v } else { v & 0xffff_ffff }
}
// ANCHOR_END: mmio_sign_extend

impl MmioAccess {
    // ANCHOR: mmio_from_data_abort
    /// The access a data abort with ISV = 1 describes, or `None` when ISV = 0 (the syndrome
    /// fields are then UNKNOWN and must not be used). For a store the source register is read
    /// now: XZR (SRT = 31) reads as 0, and the value is masked to the access size (MMIO-3).
    pub fn from_data_abort(
        ipa: u64,
        da: &DataAbort,
        regs: &dyn VcpuRegs,
    ) -> Result<Option<MmioAccess>> {
        if !da.isv {
            return Ok(None);
        }
        let size = AccessSize::from_sas(da.sas);
        let reg = da.srt & 31;
        let write = if da.wnr {
            let x = if reg == 31 { 0 } else { regs.x(reg)? };
            Some(x & size.mask())
        } else {
            None
        };
        Ok(Some(MmioAccess {
            ipa,
            size,
            write,
            reg,
            sign_extend: da.sse,
            sixty_four: da.sf,
        }))
    }
    // ANCHOR_END: mmio_from_data_abort

    /// The register value a load of `device_value` produces ([`sign_extend`]).
    pub fn load_result(&self, device_value: u64) -> u64 {
        sign_extend(device_value, self.size, self.sign_extend, self.sixty_four)
    }
}

/// What an IPA is, by our own map (step 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpaClass {
    /// Guest RAM (always mapped: a fault here is a VMM bug).
    Ram,
    /// A device window on the bus, at this offset.
    Device { name: &'static str, offset: u64 },
    /// The flash region with no device on the bus (no `--bios`).
    Rom,
    /// Nothing: a reserved region (named) or a hole.
    Unmapped { region: Option<&'static str> },
}

// ANCHOR: mmio_classify_ipa
/// Classify `ipa` against RAM, the bus and the board layout, in that order (MMIO-2). DFSC is
/// never consulted: it says *how* stage 2 failed, not *what* lives at the address.
pub fn classify_ipa(ipa: u64, mem: &dyn GuestMemory, bus: &Bus) -> IpaClass {
    if mem.check_range(GuestAddress(ipa), 1) {
        return IpaClass::Ram;
    }
    if let Some((name, offset)) = bus.device_at(ipa) {
        return IpaClass::Device { name, offset };
    }
    match Layout::virt().find(ipa) {
        Some(r) if r.kind == RegionKind::Rom => IpaClass::Rom,
        Some(r) => IpaClass::Unmapped {
            region: Some(r.name),
        },
        None => IpaClass::Unmapped { region: None },
    }
}
// ANCHOR_END: mmio_classify_ipa

/// The outcome of [`handle`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MmioOutcome {
    /// Emulated (or RAZ/WI by policy): advance the PC.
    Done,
    /// Stop the VM with this reason (exit code 3).
    Fatal(String),
    /// Refused (ISV = 0, M17: MMIO-4, MMIO-6): inject a synchronous external abort at `far`
    /// (the faulting VA, FAR_EL2) with `WnR = write`. The PC is not advanced.
    Abort { far: u64, write: bool },
}

/// Emulate the data abort `da` reported by `raw` (module docs, steps 1–5), filling the trace
/// fields of `rec`. `pc` is the PC of the faulting instruction.
pub fn handle(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    raw: &hvf::VcpuExit,
    da: &DataAbort,
    pc: u64,
    rec: &mut ExitRecord,
) -> Result<MmioOutcome> {
    let ipa = raw.ipa;
    if da.s1ptw {
        return Ok(MmioOutcome::Fatal(format!(
            "stage-1 table walk touched non-RAM IPA {ipa:#x} pc {pc:#x}"
        )));
    }
    let class = classify_ipa(ipa, env.mem, env.bus);
    if class == IpaClass::Ram {
        return Ok(MmioOutcome::Fatal(format!(
            "stage-2 fault in RAM at {ipa:#x} pc {pc:#x} (dfsc {:#x})",
            da.dfsc
        )));
    }
    let Some(access) = MmioAccess::from_data_abort(ipa, da, regs)? else {
        return isv0(regs, env, raw, da, pc, rec);
    };
    rec.isv = Some(true);
    rec.wnr = Some(access.write.is_some());
    rec.size = u8::try_from(access.size.bytes()).ok();
    rec.reg = Some(access.reg);
    rec.action = Some(Action::Mmio);
    let routed = match (class, access.write) {
        (IpaClass::Device { .. }, Some(v)) => env.bus.write(ipa, access.size, v).map(|()| v),
        (IpaClass::Device { .. }, None) => env
            .bus
            .read(ipa, access.size)
            .map(|v| access.load_result(v)),
        _ => Err(BusError::Unmapped { ipa }),
    };
    match routed {
        Ok(value) => {
            if access.write.is_none() {
                regs.set_x(access.reg, value)?; // SRT = 31: XZR, discarded by set_x
            }
            rec.value = Some(value);
            Ok(MmioOutcome::Done)
        }
        Err(BusError::Unmapped { .. } | BusError::Straddle { .. }) => {
            match unhandled_mmio_policy(env.unhandled_mmio, ipa, da, pc) {
                MmioVerdict::Fatal(why) => {
                    rec.action = None;
                    Ok(MmioOutcome::Fatal(why))
                }
                MmioVerdict::RazWi => {
                    if access.write.is_none() {
                        regs.set_x(access.reg, 0)?;
                    }
                    rec.value = Some(access.write.unwrap_or(0));
                    Ok(MmioOutcome::Done)
                }
            }
        }
        // `insert`-time errors cannot come from a lookup; treat them as unmapped too.
        Err(BusError::Overlap { .. } | BusError::InvalidRange { .. }) => Ok(MmioOutcome::Fatal(
            format!("MMIO bus refused the access at {ipa:#x} pc {pc:#x}"),
        )),
    }
}

/// The translation registers of the vCPU, for the walk (`arch::stage1_walk`).
fn translation_regs(regs: &dyn VcpuRegs) -> Result<TranslationRegs> {
    Ok(TranslationRegs {
        sctlr_el1: regs.sys_reg(SysReg::SCTLR_EL1)?,
        tcr_el1: regs.sys_reg(SysReg::TCR_EL1)?,
        ttbr0_el1: regs.sys_reg(SysReg::TTBR0_EL1)?,
        ttbr1_el1: regs.sys_reg(SysReg::TTBR1_EL1)?,
    })
}

/// The banked stack pointer register 31 names as a base (C1.2.5).
const fn sp_reg(sel: SpSel) -> SysReg {
    match sel {
        SpSel::El0 => SysReg::SP_EL0,
        SpSel::El1 => SysReg::SP_EL1,
    }
}

/// Read an operand register. `sp` is `None` outside an AArch64 EL1&0 context, where the
/// caller has already refused.
fn read_gpr(regs: &dyn VcpuRegs, g: Gpr, sp: SpSel) -> Result<u64> {
    match g {
        Gpr::X(n) => regs.x(n),
        Gpr::Zr => Ok(0),
        Gpr::Sp => regs.sys_reg(sp_reg(sp)),
    }
}

/// Write a destination register: a loaded value or the base writeback.
fn write_gpr(regs: &mut dyn VcpuRegs, g: Gpr, sp: SpSel, v: u64) -> Result<()> {
    match g {
        Gpr::X(n) => regs.set_x(n, v),
        Gpr::Zr => Ok(()),
        Gpr::Sp => regs.set_sys_reg(sp_reg(sp), v),
    }
}

/// SAS for a size (the inverse of `AccessSize::from_sas`), for the unhandled-MMIO message.
const fn sas_of(size: AccessSize) -> u8 {
    match size {
        AccessSize::B1 => 0,
        AccessSize::B2 => 1,
        AccessSize::B4 => 2,
        AccessSize::B8 => 3,
    }
}

/// [`Isv0Bus`] over the machine [`Bus`]. An access to no device goes to the
/// `--unhandled-mmio` policy exactly as an ISV = 1 access does (fatal by default, RAZ/WI with
/// `log`); the error is the fatal reason.
struct MachineBus<'a> {
    bus: &'a Bus,
    policy: MmioPolicy,
    da: DataAbort,
    pc: u64,
}

impl MachineBus<'_> {
    fn unhandled(
        &self,
        ipa: u64,
        size: AccessSize,
        write: bool,
        e: &BusError,
    ) -> core::result::Result<(), String> {
        match e {
            BusError::Unmapped { .. } | BusError::Straddle { .. } => {
                // With ISV = 0 the syndrome's SAS is UNKNOWN: describe the decoded access.
                let da = DataAbort {
                    sas: sas_of(size),
                    wnr: write,
                    ..self.da
                };
                match unhandled_mmio_policy(self.policy, ipa, &da, self.pc) {
                    MmioVerdict::Fatal(why) => Err(why),
                    MmioVerdict::RazWi => Ok(()),
                }
            }
            BusError::Overlap { .. } | BusError::InvalidRange { .. } => Err(format!(
                "MMIO bus refused the access at {ipa:#x} pc {:#x}",
                self.pc
            )),
        }
    }
}

impl Isv0Bus for MachineBus<'_> {
    type Error = String;

    fn window(&self, ipa: u64, size: AccessSize) -> Option<u64> {
        let (_, off) = self.bus.device_at(ipa)?;
        let base = ipa.checked_sub(off)?;
        let last = ipa.checked_add(size.bytes().checked_sub(1)?)?;
        let (_, off_last) = self.bus.device_at(last)?;
        (last.checked_sub(off_last)? == base).then_some(base)
    }

    fn read(&mut self, ipa: u64, size: AccessSize) -> core::result::Result<u64, String> {
        match self.bus.read(ipa, size) {
            Ok(v) => Ok(v),
            Err(e) => self.unhandled(ipa, size, false, &e).map(|()| 0),
        }
    }

    fn write(
        &mut self,
        ipa: u64,
        size: AccessSize,
        value: u64,
    ) -> core::result::Result<(), String> {
        match self.bus.write(ipa, size, value) {
            Ok(()) => Ok(()),
            Err(e) => self.unhandled(ipa, size, true, &e),
        }
    }
}

/// Answer a refused ISV = 0 access with an abort, warning once per call site (LOG-1). `why`
/// is numbers and static names only (LOG-5).
fn refuse(
    vcpu: usize,
    raw: &hvf::VcpuExit,
    da: &DataAbort,
    pc: u64,
    why: &dyn fmt::Display,
) -> MmioOutcome {
    crate::guest_warn!(
        "vcpu{vcpu}: ISV=0 {} at {:#x} pc {pc:#x} not emulated ({why}): injecting a \
         synchronous external abort",
        if da.wnr { "write" } else { "read" },
        raw.ipa
    );
    MmioOutcome::Abort {
        far: raw.far,
        write: da.wnr,
    }
}

/// Steps 1 and 2 of [`isv0`]: the instruction at `pc`, decoded, or the outcome to return at
/// once. Hints and cache maintenance (with `ESR.CM = 1`) make no access, so they are `Done`
/// and the PC advances (insn.rs module docs). Everything undecodable is a refusal.
fn decode_at_pc(
    mem: &dyn GuestMemory,
    tr: &TranslationRegs,
    raw: &hvf::VcpuExit,
    da: &DataAbort,
    pc: u64,
    vcpu: usize,
) -> core::result::Result<insn::MemInsn, MmioOutcome> {
    let word = stage1_walk::fetch_insn(mem, tr, pc).map_err(|e| refuse(vcpu, raw, da, pc, &e))?;
    match insn::decode(word) {
        Ok(Insn::Mem(m)) => Ok(m),
        Ok(Insn::Prefetch) => Err(MmioOutcome::Done),
        Ok(Insn::CacheMaintenance) if data_abort_cm(raw.esr) => Err(MmioOutcome::Done),
        Ok(Insn::CacheMaintenance) => Err(refuse(
            vcpu,
            raw,
            da,
            pc,
            &"cache maintenance with ESR.CM = 0",
        )),
        Err(u) => Err(refuse(vcpu, raw, da, pc, &u)),
    }
}

/// Step 5 of [`isv0`]: write the loaded values, then the base register.
fn apply_commit(regs: &mut dyn VcpuRegs, sp: SpSel, commit: &insn::Commit) -> Result<()> {
    for (g, v) in commit.loads.into_iter().flatten() {
        write_gpr(regs, g, sp, v)?;
    }
    match commit.writeback {
        Some((g, v)) => write_gpr(regs, g, sp, v),
        None => Ok(()),
    }
}

// ANCHOR: isv0_emulate
/// A data abort with ISV = 0 (module docs, step 3; M17). The exit IPA is authoritative: the
/// instruction is only read to learn *what* the access was, and every way it can disagree
/// with the exit is a refusal (MMIO-4). No register changes until every bus access succeeded.
fn isv0(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    raw: &hvf::VcpuExit,
    da: &DataAbort,
    pc: u64,
    rec: &mut ExitRecord,
) -> Result<MmioOutcome> {
    rec.isv = Some(false);
    rec.wnr = Some(da.wnr);
    let vcpu = regs.index();
    let tr = translation_regs(regs)?;
    // 1, 2. Fetch the instruction at the PC through stage 1 and decode it.
    let m = match decode_at_pc(env.mem, &tr, raw, da, pc, vcpu) {
        Ok(m) => m,
        Err(outcome) => return Ok(outcome),
    };
    // 3. Read the operands. Register 31 as a base is the SP that PSTATE selects.
    let Some(sp) = SpSel::from_pstate(Pstate(regs.cpsr()?)) else {
        return Ok(refuse(vcpu, raw, da, pc, &"not an AArch64 EL1&0 context"));
    };
    let ops = Operands::gather(&m, |g| read_gpr(&*regs, g, sp))?;
    // 4. Check against the exit, then perform the accesses on the exit IPA.
    let exit = ExitFacts {
        ipa: raw.ipa,
        wnr: da.wnr,
    };
    let mut translate = |va: u64| stage1_walk::translate(env.mem, &tr, va).ok().map(|t| t.ipa);
    let mut bus = MachineBus {
        bus: env.bus,
        policy: env.unhandled_mmio,
        da: *da,
        pc,
    };
    let commit = match insn::emulate_isv0(&m, &ops, exit, &mut translate, &mut bus) {
        Ok(c) => c,
        Err(Isv0Error::Refused(r)) => return Ok(refuse(vcpu, raw, da, pc, &r)),
        Err(Isv0Error::Bus(why)) => return Ok(MmioOutcome::Fatal(why)),
    };
    // 5. Only now change registers: loads, then the base writeback.
    apply_commit(regs, sp, &commit)?;
    rec.size = u8::try_from(m.size.bytes()).ok();
    rec.reg = Some(m.rt);
    rec.value = m
        .store_data(ops.rt)
        .or_else(|| commit.loads.first().copied().flatten().map(|(_, v)| v));
    rec.action = Some(Action::Mmio);
    Ok(MmioOutcome::Done)
}
// ANCHOR_END: isv0_emulate

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::arch::esr::{Exit, decode_data_abort};
    use crate::arch::layout::{FLASH0_BASE, PROBE_HOLE_BASE, RAM_BASE, TESTDEV_BASE};
    use crate::config::MmioPolicy;
    use crate::devices::testdev::TestDev;
    use crate::memory::VecMemory;
    use crate::vcpu::exit::tests::{Fake, with_env_bus};
    use std::sync::{Arc, Mutex};

    /// The exit record for a data abort at `ipa` (MMU off: FAR = IPA).
    fn at(ipa: u64) -> hvf::VcpuExit {
        hvf::VcpuExit {
            reason: hvf::ExitReason::Exception,
            esr: 0,
            far: ipa,
            ipa,
        }
    }

    /// A data-abort ESR: ISV=1, SAS, SSE, SRT, SF, WnR, DFSC = translation fault level 2.
    fn esr(sas: u64, sse: bool, srt: u64, sf: bool, wnr: bool) -> u64 {
        (0x24 << 26)
            | (1 << 25)
            | (1 << 24)
            | (sas << 22)
            | (u64::from(sse) << 21)
            | (srt << 16)
            | (u64::from(sf) << 15)
            | (u64::from(wnr) << 6)
            | 0x06
    }

    /// The sign-extension matrix {B, H, W} × {32, 64} × {SSE 0, 1} (PLAN M4).
    #[test]
    fn sign_extension_matrix() {
        use AccessSize::*;
        // (size, raw device value with the top bit of the size set, sse, sf, expected)
        let cases: [(AccessSize, u64, bool, bool, u64); 12] = [
            (B1, 0x80, false, false, 0x80),
            (B1, 0x80, false, true, 0x80),
            (B1, 0x80, true, false, 0xffff_ff80),
            (B1, 0x80, true, true, 0xffff_ffff_ffff_ff80),
            (B2, 0x8001, false, false, 0x8001),
            (B2, 0x8001, false, true, 0x8001),
            (B2, 0x8001, true, false, 0xffff_8001),
            (B2, 0x8001, true, true, 0xffff_ffff_ffff_8001),
            (B4, 0x8000_0000, false, false, 0x8000_0000),
            (B4, 0x8000_0000, false, true, 0x8000_0000),
            (B4, 0x8000_0000, true, false, 0x8000_0000),
            (B4, 0x8000_0000, true, true, 0xffff_ffff_8000_0000),
        ];
        for (size, v, sse, sf, want) in cases {
            assert_eq!(
                sign_extend(v, size, sse, sf),
                want,
                "{size:?} sse {sse} sf {sf}"
            );
            // Positive values are never extended; garbage above the size is dropped.
            let pos = (v >> 1) | 0xdead_0000_0000_0000;
            assert_eq!(
                sign_extend(pos, size, sse, sf),
                (v >> 1) & size.mask(),
                "{size:?} positive"
            );
        }
        assert_eq!(sign_extend(u64::MAX, B8, true, true), u64::MAX);
        assert_eq!(sign_extend(u64::MAX, B8, false, false), 0xffff_ffff);
    }

    #[test]
    fn write_value_masked_and_xzr_store_is_zero() {
        let mut r = Fake::default();
        r.x[3] = 0x1122_3344_5566_7788;
        for (sas, want) in [
            (0, 0x88),
            (1, 0x7788),
            (2, 0x5566_7788),
            (3, 0x1122_3344_5566_7788),
        ] {
            let da = decode_data_abort(esr(sas, false, 3, sas == 3, true));
            let a = MmioAccess::from_data_abort(TESTDEV_BASE, &da, &r)
                .unwrap()
                .unwrap();
            assert_eq!(a.write, Some(want), "sas {sas}");
            assert_eq!(a.size.bytes(), 1 << sas);
        }
        // SRT = 31 is XZR: the value is 0, never SP or x30.
        r.x[30] = 0xffff;
        let da = decode_data_abort(esr(3, false, 31, true, true));
        let a = MmioAccess::from_data_abort(TESTDEV_BASE, &da, &r)
            .unwrap()
            .unwrap();
        assert_eq!((a.write, a.reg), (Some(0), 31));
        // ISV = 0: no access is built from UNKNOWN fields.
        let da = decode_data_abort(esr(3, false, 1, true, true) & !(1 << 24));
        assert_eq!(
            MmioAccess::from_data_abort(TESTDEV_BASE, &da, &r).unwrap(),
            None
        );
    }

    fn testdev_bus() -> Bus {
        let mut bus = Bus::new();
        bus.insert(
            "testdev",
            TESTDEV_BASE,
            crate::devices::testdev::TESTDEV_SIZE,
            Arc::new(Mutex::new(TestDev::new())),
        )
        .unwrap();
        bus
    }

    #[test]
    fn classification_ram_rom_bus_unmapped() {
        let mem = VecMemory::new(&[(GuestAddress(RAM_BASE), 1 << 20)]).unwrap();
        let bus = testdev_bus();
        assert_eq!(classify_ipa(RAM_BASE + 8, &mem, &bus), IpaClass::Ram);
        assert_eq!(
            classify_ipa(TESTDEV_BASE + 0x10, &mem, &bus),
            IpaClass::Device {
                name: "testdev",
                offset: 0x10
            }
        );
        assert_eq!(classify_ipa(FLASH0_BASE + 0x200, &mem, &bus), IpaClass::Rom);
        assert_eq!(
            classify_ipa(PROBE_HOLE_BASE, &mem, &bus),
            IpaClass::Unmapped {
                region: Some("probe-hole")
            }
        );
        // Past the end of RAM and far above everything.
        assert_eq!(
            classify_ipa(RAM_BASE + (1 << 20), &mem, &bus),
            IpaClass::Unmapped { region: None }
        );
        assert_eq!(
            classify_ipa(u64::MAX, &mem, &bus),
            IpaClass::Unmapped { region: None }
        );
        // Without --testdev the window is just a reserved board region.
        assert_eq!(
            classify_ipa(TESTDEV_BASE, &mem, &Bus::new()),
            IpaClass::Unmapped {
                region: Some("testdev")
            }
        );
    }

    /// Store then load through the testdev: the XZR load is discarded (x31 untouched; the fake
    /// has no SP to clobber), the loaded value is sign-extended, the record says what happened.
    #[test]
    fn emulate_through_the_bus() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            r.x[1] = 0xffff_ffff_ffff_8001;
            let mut rec = ExitRecord::default();
            // strh w1, [x0]
            let da = decode_data_abort(esr(1, false, 1, false, true));
            let o = handle(&mut r, env, &at(TESTDEV_BASE), &da, RAM_BASE, &mut rec).unwrap();
            assert_eq!(o, MmioOutcome::Done);
            assert_eq!(
                (rec.wnr, rec.size, rec.reg, rec.value, rec.action),
                (
                    Some(true),
                    Some(2),
                    Some(1),
                    Some(0x8001),
                    Some(Action::Mmio)
                )
            );
            // ldrsh x2, [x0]
            let da = decode_data_abort(esr(1, true, 2, true, false));
            let mut rec = ExitRecord::default();
            handle(&mut r, env, &at(TESTDEV_BASE), &da, RAM_BASE, &mut rec).unwrap();
            assert_eq!(r.x[2], 0xffff_ffff_ffff_8001);
            assert_eq!(rec.value, Some(0xffff_ffff_ffff_8001));
            // ldrsh w2, [x0]
            let da = decode_data_abort(esr(1, true, 2, false, false));
            handle(
                &mut r,
                env,
                &at(TESTDEV_BASE),
                &da,
                RAM_BASE,
                &mut ExitRecord::default(),
            )
            .unwrap();
            assert_eq!(r.x[2], 0xffff_8001);
            // ldr xzr, [x0]: nothing written anywhere. `handle` passes SRT 31 to `set_x`, and
            // the fake resolves it through `hvf::Reg::x` as the real `Vcpu` does; if 31 ever
            // reached `hv_reg_t` 31 (HV_REG_PC), the PC would move.
            let before = r.x;
            let (pc_before, xzr_before) = (r.pc, r.xzr_writes);
            let da = decode_data_abort(esr(3, false, 31, true, false));
            handle(
                &mut r,
                env,
                &at(TESTDEV_BASE),
                &da,
                RAM_BASE,
                &mut ExitRecord::default(),
            )
            .unwrap();
            assert_eq!(r.x, before);
            assert_eq!(r.pc, pc_before);
            assert_eq!(r.xzr_writes, xzr_before + 1);
            // An 8-byte access at the last 4 bytes straddles the window: unhandled (fatal).
            let da = decode_data_abort(esr(3, false, 1, true, false));
            let o = handle(
                &mut r,
                env,
                &at(TESTDEV_BASE + 0xffc),
                &da,
                RAM_BASE,
                &mut ExitRecord::default(),
            )
            .unwrap();
            assert!(
                matches!(o, MmioOutcome::Fatal(m) if m.starts_with("unhandled MMIO read at 0xb000ffc size 8"))
            );
        });
    }

    #[test]
    fn fatal_cases() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Log, &bus, |env| {
            let mut r = Fake::default();
            let base = esr(2, false, 1, false, true);
            let run = |r: &mut Fake, e: u64, ipa: u64| {
                let Exit::DataAbort(da) = Exit::decode(e) else {
                    panic!()
                };
                handle(
                    r,
                    env,
                    &at(ipa),
                    &da,
                    0x4008_0000,
                    &mut ExitRecord::default(),
                )
                .unwrap()
            };
            assert!(
                matches!(run(&mut r, base | (1 << 7), TESTDEV_BASE), MmioOutcome::Fatal(m) if m.contains("stage-1"))
            );
            assert!(
                matches!(run(&mut r, base, RAM_BASE), MmioOutcome::Fatal(m) if m.contains("stage-2 fault in RAM"))
            );
            assert_eq!(
                run(&mut r, base & !(1 << 24), TESTDEV_BASE),
                MmioOutcome::Abort {
                    far: TESTDEV_BASE,
                    write: true
                }
            );
            // Log policy: the hole is RAZ/WI.
            r.x[1] = 7;
            let ld = esr(2, false, 1, false, false);
            assert_eq!(run(&mut r, ld, PROBE_HOLE_BASE), MmioOutcome::Done);
            assert_eq!(r.x[1], 0);
        });
    }

    // ---- ISV = 0 (M17): decode, cross-check, emulate or abort ----

    /// ISV = 0 data-abort syndromes (DFSC = translation fault level 2).
    const ISV0_STORE: u64 = (0x24 << 26) | (1 << 25) | (1 << 6) | 0x06;
    const ISV0_LOAD: u64 = (0x24 << 26) | (1 << 25) | 0x06;
    /// `ESR.CM`, bit 8.
    const CM: u64 = 1 << 8;
    /// Where the faulting instruction is placed.
    const CODE: u64 = RAM_BASE + 0x100;

    /// Run one ISV = 0 exit at `ipa` for the instruction `word` at [`CODE`].
    fn isv0_run(
        r: &mut Fake,
        env: &ExitEnv<'_>,
        word: u32,
        esr: u64,
        ipa: u64,
    ) -> (MmioOutcome, ExitRecord) {
        isv0_run_at(r, env, word, esr, ipa, ipa)
    }

    fn isv0_run_at(
        r: &mut Fake,
        env: &ExitEnv<'_>,
        word: u32,
        esr: u64,
        ipa: u64,
        far: u64,
    ) -> (MmioOutcome, ExitRecord) {
        env.mem.write_u32(GuestAddress(CODE), word).unwrap();
        r.pc = CODE;
        let raw = hvf::VcpuExit {
            reason: hvf::ExitReason::Exception,
            esr,
            far,
            ipa,
        };
        let mut rec = ExitRecord::default();
        let da = decode_data_abort(esr);
        let o = handle(r, env, &raw, &da, CODE, &mut rec).unwrap();
        (o, rec)
    }

    fn dev(env: &ExitEnv<'_>, off: u64, size: AccessSize) -> u64 {
        env.bus.read(TESTDEV_BASE + off, size).unwrap()
    }

    /// `stp x1, x2, [x0, #16]!`: both elements written, then x0 moves; the record says ISV=0.
    #[test]
    fn isv0_stp_pre_index() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            (r.x[0], r.x[1], r.x[2]) = (TESTDEV_BASE, 0x1111, 0x2222);
            let (o, rec) = isv0_run(&mut r, env, 0xa981_0801, ISV0_STORE, TESTDEV_BASE + 16);
            assert_eq!(o, MmioOutcome::Done);
            assert_eq!(dev(env, 16, AccessSize::B8), 0x1111);
            assert_eq!(dev(env, 24, AccessSize::B8), 0x2222);
            assert_eq!(r.x[0], TESTDEV_BASE + 16);
            assert_eq!(
                (rec.isv, rec.wnr, rec.size, rec.reg, rec.value, rec.action),
                (
                    Some(false),
                    Some(true),
                    Some(8),
                    Some(1),
                    Some(0x1111),
                    Some(Action::Mmio)
                )
            );
            assert!(rec.to_json().contains(r#""isv":false"#));
        });
    }

    /// `ldp w3, w4, [sp], #8`: Rn = 31 is the SP that PSTATE selects (SP_EL1 for EL1h, SP_EL0
    /// for EL1t), and only that one is written back.
    #[test]
    fn isv0_ldp_post_index_sp_base() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            for (cpsr, used, other) in [
                (0x3c5, SysReg::SP_EL1, SysReg::SP_EL0),
                (0x3c4, SysReg::SP_EL0, SysReg::SP_EL1),
            ] {
                let mut r = Fake {
                    cpsr: Some(cpsr),
                    ..Fake::default()
                };
                r.sys.insert(used.0, TESTDEV_BASE + 0x40);
                r.sys.insert(other.0, 0x7777);
                env.bus
                    .write(TESTDEV_BASE + 0x40, AccessSize::B4, 0xaaaa_bbbb)
                    .unwrap();
                env.bus
                    .write(TESTDEV_BASE + 0x44, AccessSize::B4, 0xcccc_dddd)
                    .unwrap();
                let (o, _) = isv0_run(&mut r, env, 0x28c1_13e3, ISV0_LOAD, TESTDEV_BASE + 0x40);
                assert_eq!(o, MmioOutcome::Done, "cpsr {cpsr:#x}");
                assert_eq!((r.x[3], r.x[4]), (0xaaaa_bbbb, 0xcccc_dddd));
                assert_eq!(r.sys[&used.0], TESTDEV_BASE + 0x48);
                assert_eq!(r.sys[&other.0], 0x7777);
            }
        });
    }

    /// `ldpsw x5, x6, [x0, #8]`: each word sign-extended to 64 bits; no writeback.
    #[test]
    fn isv0_ldpsw_sign_extends() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            r.x[0] = TESTDEV_BASE;
            env.bus
                .write(TESTDEV_BASE + 8, AccessSize::B4, 0x8000_0000)
                .unwrap();
            env.bus
                .write(TESTDEV_BASE + 12, AccessSize::B4, 0x7fff_ffff)
                .unwrap();
            let (o, rec) = isv0_run(&mut r, env, 0x6941_1805, ISV0_LOAD, TESTDEV_BASE + 8);
            assert_eq!(o, MmioOutcome::Done);
            assert_eq!((r.x[5], r.x[6]), (0xffff_ffff_8000_0000, 0x7fff_ffff));
            assert_eq!(r.x[0], TESTDEV_BASE);
            assert_eq!(rec.value, Some(0xffff_ffff_8000_0000));
        });
    }

    /// MMIO-6: `str q0, [x0]` is SIMD/FP: an abort at FAR with WnR, and no device access.
    #[test]
    fn isv0_simd_store_aborts() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            r.x[0] = TESTDEV_BASE + 0x80;
            let (o, rec) = isv0_run(&mut r, env, 0x3d80_0000, ISV0_STORE, TESTDEV_BASE + 0x80);
            assert_eq!(
                o,
                MmioOutcome::Abort {
                    far: TESTDEV_BASE + 0x80,
                    write: true
                }
            );
            assert_eq!(rec.isv, Some(false));
            assert_eq!(rec.action, None, "the exit handler sets inject_abort");
        });
    }

    /// MMIO-4: a decoded address that is not the exit IPA, or a store under a read syndrome,
    /// is an abort and touches nothing; so is a pair that runs off the end of its window.
    #[test]
    fn isv0_refusals_touch_nothing() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            (r.x[0], r.x[1], r.x[2]) = (TESTDEV_BASE + 0x100, 0x1111, 0x2222);
            let stp = 0xa900_0801; // stp x1, x2, [x0]
            let abort = |write| MmioOutcome::Abort {
                far: TESTDEV_BASE + 0x200,
                write,
            };
            let (o, _) = isv0_run(&mut r, env, stp, ISV0_STORE, TESTDEV_BASE + 0x200);
            assert_eq!(o, abort(true));
            let (o, _) = isv0_run_at(
                &mut r,
                env,
                stp,
                ISV0_LOAD,
                TESTDEV_BASE + 0x100,
                TESTDEV_BASE + 0x200,
            );
            assert_eq!(o, abort(false));
            r.x[0] = TESTDEV_BASE + 0xff8;
            let (o, _) = isv0_run(&mut r, env, stp, ISV0_STORE, TESTDEV_BASE + 0xff8);
            assert!(matches!(o, MmioOutcome::Abort { write: true, .. }));
            for off in [0x100, 0x108, 0x200, 0x208, 0xff8] {
                assert_eq!(dev(env, off, AccessSize::B8), 0, "offset {off:#x}");
            }
        });
    }

    /// `str x1, [x0, #8]!` into a hole follows `--unhandled-mmio`: fatal (and x0 unchanged),
    /// or RAZ/WI with the writeback applied.
    #[test]
    fn isv0_single_into_hole_follows_policy() {
        let bus = testdev_bus();
        for (policy, done) in [(MmioPolicy::Fatal, false), (MmioPolicy::Log, true)] {
            with_env_bus(policy, &bus, |env| {
                let mut r = Fake::default();
                r.x[0] = PROBE_HOLE_BASE - 8;
                let (o, _) = isv0_run(&mut r, env, 0xf800_8c01, ISV0_STORE, PROBE_HOLE_BASE);
                if done {
                    assert_eq!(o, MmioOutcome::Done);
                    assert_eq!(r.x[0], PROBE_HOLE_BASE);
                } else {
                    assert!(
                        matches!(&o, MmioOutcome::Fatal(m) if m.starts_with("unhandled MMIO write at 0xc000000 size 8")),
                        "{o:?}"
                    );
                    assert_eq!(r.x[0], PROBE_HOLE_BASE - 8);
                }
            });
        }
    }

    /// `dc civac, x0` is skipped when the syndrome says CM = 1, and aborted when it does not.
    #[test]
    fn isv0_cache_maintenance() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            r.x[0] = TESTDEV_BASE;
            let dc = 0xd50b_7e20;
            let (o, _) = isv0_run(&mut r, env, dc, ISV0_STORE | CM, TESTDEV_BASE);
            assert_eq!(o, MmioOutcome::Done);
            let (o, _) = isv0_run(&mut r, env, dc, ISV0_STORE, TESTDEV_BASE);
            assert!(matches!(o, MmioOutcome::Abort { .. }));
        });
    }

    /// With the MMU on, the PC and the decoded address go through the guest's stage 1: an
    /// `ldp` through an alias VA (0x0b10_0000 → the testdev page) is emulated, and the same
    /// instruction with the MMU off is refused (the identity of the VA is not the exit IPA).
    #[test]
    fn isv0_through_stage1_alias() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            const VALID: u64 = 0b01;
            const TABLE: u64 = 0b11;
            let (l1, l2, l3) = (RAM_BASE + 0x1000, RAM_BASE + 0x2000, RAM_BASE + 0x3000);
            let w = |a: u64, v: u64| env.mem.write_u64(GuestAddress(a), v).unwrap();
            w(l1 + 8, RAM_BASE | VALID); // VA 1-2 GiB: identity 1 GiB block (RAM, code)
            w(l1, l2 | TABLE);
            w(l2 + 88 * 8, l3 | TABLE); // 0x0b00_0000 >> 21 = 88
            w(l3 + 0x100 * 8, TESTDEV_BASE | TABLE); // VA 0x0b10_0000 → IPA 0x0b00_0000
            let mut r = Fake::default();
            r.sys.insert(SysReg::SCTLR_EL1.0, 1);
            // T0SZ = 25 (39-bit VAs, start at level 1), TG0 = 4K, IPS = 48 bits, EPD1.
            r.sys
                .insert(SysReg::TCR_EL1.0, 25 | (0b101 << 32) | (1 << 23));
            r.sys.insert(SysReg::TTBR0_EL1.0, l1);
            r.x[0] = 0x0b10_0000;
            env.bus
                .write(TESTDEV_BASE, AccessSize::B8, 0x0123_4567_89ab_cdef)
                .unwrap();
            env.bus
                .write(TESTDEV_BASE + 8, AccessSize::B8, 0xfedc_ba98_7654_3210)
                .unwrap();
            let ldp = 0xa940_0801; // ldp x1, x2, [x0]
            let (o, _) = isv0_run_at(&mut r, env, ldp, ISV0_LOAD, TESTDEV_BASE, 0x0b10_0000);
            assert_eq!(o, MmioOutcome::Done);
            assert_eq!(
                (r.x[1], r.x[2]),
                (0x0123_4567_89ab_cdef, 0xfedc_ba98_7654_3210)
            );
            r.sys.insert(SysReg::SCTLR_EL1.0, 0);
            (r.x[1], r.x[2]) = (0, 0);
            let (o, _) = isv0_run_at(&mut r, env, ldp, ISV0_LOAD, TESTDEV_BASE, 0x0b10_0000);
            assert!(matches!(o, MmioOutcome::Abort { .. }), "{o:?}");
            assert_eq!((r.x[1], r.x[2]), (0, 0));
        });
    }

    /// A PC that does not translate to RAM cannot be decoded: abort, not a VMM error.
    #[test]
    fn isv0_pc_outside_ram_aborts() {
        let bus = testdev_bus();
        with_env_bus(MmioPolicy::Fatal, &bus, |env| {
            let mut r = Fake::default();
            let raw = hvf::VcpuExit {
                reason: hvf::ExitReason::Exception,
                esr: ISV0_STORE,
                far: TESTDEV_BASE,
                ipa: TESTDEV_BASE,
            };
            let da = decode_data_abort(ISV0_STORE);
            for pc in [FLASH0_BASE + 0x100, CODE + 2] {
                let o = handle(&mut r, env, &raw, &da, pc, &mut ExitRecord::default()).unwrap();
                assert!(matches!(o, MmioOutcome::Abort { .. }), "pc {pc:#x}: {o:?}");
            }
        });
    }
}
