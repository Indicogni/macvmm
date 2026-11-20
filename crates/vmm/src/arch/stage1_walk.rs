//! The guest's stage-1 translation, done in software: guest VA → IPA through the guest's own
//! page tables (architecture §8.3 step 4; course ch21, ch27; threat model MMIO-5, F17).
//!
//! **Why the VMM walks the guest's tables.** A data abort with ISV = 0 reports the faulting IPA
//! but not the instruction, and the PC is a *virtual* address once the guest turns its MMU on
//! (`SCTLR_EL1.M = 1`). To fetch the instruction (`arch/insn.rs`), to cross-check the decoded
//! address against the exit IPA (MMIO-4), to print the instruction at PC in a fatal dump and,
//! post-v1, to read guest memory for gdb, the VMM has to translate the way the guest's MMU
//! would. HVF offers no "translate this VA" call, so we read the tables ourselves.
//!
//! **What is modelled** (ARM ARM DDI 0487, D8 "The AArch64 Virtual Memory System Architecture":
//! D8.1 the translation regimes and TCR fields, D8.2 the translation process, D8.3 the
//! VMSAv8-64 descriptor formats; register fields from D19.2 `TCR_EL1`, `TTBR0_EL1`,
//! `TTBR1_EL1`, `SCTLR_EL1`):
//! - the EL1&0 regime only, with its two VA ranges: `VA[55] = 0` → `TTBR0_EL1`/`T0SZ`/`TG0`,
//!   `VA[55] = 1` → `TTBR1_EL1`/`T1SZ`/`TG1`; the bits above the range (from bit 55 with
//!   top-byte-ignore, `TBIx`, else bit 63) must all equal `VA[55]`;
//! - the **4 KiB and 16 KiB granules** that Linux, FreeBSD, U-Boot and EDK2 use. They are
//!   chosen by the guest and are independent of HVF's own 16 KiB stage-2 granule
//!   (first-principles R12). 64 KiB is refused;
//! - `TxSZ` from 16 (48-bit VAs) to 39 (25-bit VAs), the range without FEAT_LVA/FEAT_TTST;
//! - table, block and page descriptors with 48-bit output addresses, checked against
//!   `TCR_EL1.IPS` (an address-size fault otherwise).
//!
//! **What is refused, and why each is safe to refuse.** 52-bit addressing (`TCR_EL1.DS = 1`,
//! FEAT_LPA2), 64 KiB granules, `TxSZ` outside 16..=39, a disabled walk (`EPDx`), reserved
//! `IPS`, and descriptors the architecture calls invalid or reserved. The caller treats any
//! [`WalkError`] as "cannot emulate": it injects an abort or prints "PC not mapped" in a dump.
//! Permissions, the access flag and memory attributes are *not* checked. The hardware already
//! checked them for the faulting access before it faulted at stage 2, but only for the page or
//! block that holds the faulting address. So [`Translation::mapping_size`] goes back to the
//! caller, and `arch/insn.rs` refuses any access (a pair's second element included) that leaves
//! that mapping (`Refusal::CrossesMapping`). The exit IPA cross-check (MMIO-4) catches a guest
//! that changed its tables since.
//!
//! **Instruction fetch from flash ROM** ([`fetch_insn_rom`], M18). The walk and
//! [`fetch_insn`] read through `GuestMemory`, which by design (MEM-3) excludes the flash ROM at
//! `0x0`. But execute-in-place firmware runs *from* flash before it relocates to RAM (U-Boot
//! `qemu_arm64` and EDK2 `ArmVirtQemu` SEC/PEI start at `0x0`), and U-Boot's very first
//! stores are an ISV = 0 `STP` pair (`save_boot_params` in
//! `board/emulation/qemu-arm/lowlevel_init.S` saves `x0..x3` into its own `.data`, which is in
//! flash; observed on machine, `docs/compat/uboot.md`). So when the PC's IPA is not RAM,
//! [`fetch_insn_rom`] asks a read-only [`InsnRom`] hook beside `GuestMemory`: one aligned
//! 4-byte, bounds-checked read of the ROM's host copy (`memory::RomRegion::read_u32`).
//! `GuestMemory` itself is never widened, so virtio DMA still cannot reach firmware. Page
//! tables are still read only from RAM: a table in ROM is refused as before.
//!
//! **Hostile tables (MMIO-5).** The tables are guest memory, so every descriptor is read with
//! one [`GuestMemory::read_u64`] (bounds-checked, RAM only: a table in MMIO or outside RAM is
//! [`WalkError::TableOutsideRam`]). The walk is a `for` loop over at most four levels and never
//! recurses, so a table entry pointing at its own table, or any cycle, ends after ≤ 4 reads.
//! All address arithmetic is `checked_*` or masking.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::memory::{GuestAddress, GuestMemory, MemoryError};
use core::fmt;

/// The most translation levels any supported configuration uses (levels 0..=3; MMIO-5).
pub const MAX_LEVELS: u32 = 4;
/// The last level (pages).
const LAST_LEVEL: u32 = 3;
/// The smallest supported `TxSZ` (48-bit VA range; 52-bit needs FEAT_LVA/LPA2, refused).
pub const MIN_TXSZ: u32 = 16;
/// The largest supported `TxSZ` (25-bit VA range; larger needs FEAT_TTST).
pub const MAX_TXSZ: u32 = 39;
/// Output addresses are at most 48 bits with 4K/16K granules and `DS = 0` (D8.3).
pub const OA_BITS: u32 = 48;

/// `SCTLR_EL1.M`: the stage-1 MMU is on.
const SCTLR_M: u64 = 1;

/// The translation registers of the vCPU, read by the caller from HVF.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TranslationRegs {
    pub sctlr_el1: u64,
    pub tcr_el1: u64,
    pub ttbr0_el1: u64,
    pub ttbr1_el1: u64,
}

/// A translation granule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granule {
    K4,
    K16,
}

impl Granule {
    /// log2 of the page size: 12 or 14.
    pub const fn page_shift(self) -> u32 {
        match self {
            Granule::K4 => 12,
            Granule::K16 => 14,
        }
    }

    /// VA bits resolved per level: one table page of 8-byte descriptors (9 or 11).
    pub const fn stride(self) -> u32 {
        match self {
            Granule::K4 => 9,
            Granule::K16 => 11,
        }
    }

    /// Whether a block descriptor is valid at `level` (D8.3, `DS = 0`): 4K at levels 1 and 2
    /// (1 GiB, 2 MiB), 16K at level 2 (32 MiB).
    pub const fn block_allowed(self, level: u32) -> bool {
        matches!((self, level), (Granule::K4, 1 | 2) | (Granule::K16, 2))
    }
}

/// Which VA range (and so which TTBR) a VA belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VaRange {
    Ttbr0,
    Ttbr1,
}

/// A successful translation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Translation {
    pub ipa: u64,
    /// `None` when the MMU is off (identity).
    pub range: Option<VaRange>,
    /// The level of the final descriptor (3 for a page); 0 when the MMU is off.
    pub level: u32,
    /// The size of the mapping the VA lies in (a page or a block); 0 when the MMU is off.
    pub mapping_size: u64,
}

/// Why a walk failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalkError {
    /// The bits above the VA range do not all equal `VA[55]` (a level-0 translation fault).
    VaOutOfRange { va: u64 },
    /// `EPD0`/`EPD1` disables walks for this range.
    WalkDisabled { range: VaRange },
    /// `TCR_EL1.DS = 1` (52-bit, FEAT_LPA2).
    Lpa2,
    /// A `TGx` encoding other than 4K or 16K.
    UnsupportedGranule { range: VaRange, tg: u8 },
    /// `TxSZ` outside `MIN_TXSZ..=MAX_TXSZ`.
    TxSzOutOfRange { range: VaRange, txsz: u32 },
    /// `TCR_EL1.IPS = 0b111` (reserved).
    ReservedIps,
    /// A descriptor (or the table it lives in) is outside guest RAM.
    TableOutsideRam { level: u32, addr: u64 },
    /// An invalid or reserved descriptor.
    InvalidDescriptor { level: u32, desc: u64 },
    /// An output or table address above `TCR_EL1.IPS`.
    AddressSize { level: u32, addr: u64 },
}

impl fmt::Display for WalkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            WalkError::VaOutOfRange { va } => write!(f, "VA {va:#x} is outside both ranges"),
            WalkError::WalkDisabled { range } => write!(f, "{range:?} walks are disabled (EPD)"),
            WalkError::Lpa2 => f.write_str("52-bit addressing (TCR_EL1.DS) is not supported"),
            WalkError::UnsupportedGranule { range, tg } => {
                write!(f, "{range:?} granule encoding {tg:#04b} is not 4K or 16K")
            }
            WalkError::TxSzOutOfRange { range, txsz } => {
                write!(f, "{range:?} TxSZ {txsz} outside {MIN_TXSZ}..={MAX_TXSZ}")
            }
            WalkError::ReservedIps => f.write_str("TCR_EL1.IPS is reserved"),
            WalkError::TableOutsideRam { level, addr } => {
                write!(f, "level {level} descriptor at {addr:#x} is outside RAM")
            }
            WalkError::InvalidDescriptor { level, desc } => {
                write!(f, "invalid level {level} descriptor {desc:#018x}")
            }
            WalkError::AddressSize { level, addr } => {
                write!(f, "level {level} address {addr:#x} exceeds TCR_EL1.IPS")
            }
        }
    }
}

impl std::error::Error for WalkError {}

/// `width` bits of `v` from bit `lo` (`width < 64`).
const fn field(v: u64, lo: u32, width: u32) -> u64 {
    let mask = match 1u64.checked_shl(width) {
        Some(m) => m.wrapping_sub(1),
        None => u64::MAX,
    };
    match v.checked_shr(lo) {
        Some(x) => x & mask,
        None => 0,
    }
}

/// Bits `[hi-1 : lo]` set (`lo ≤ hi ≤ 64`).
const fn mask_range(lo: u32, hi: u32) -> u64 {
    let below_hi = match 1u64.checked_shl(hi) {
        Some(m) => m.wrapping_sub(1),
        None => u64::MAX,
    };
    let below_lo = match 1u64.checked_shl(lo) {
        Some(m) => m.wrapping_sub(1),
        None => u64::MAX,
    };
    below_hi & !below_lo
}

/// The walk parameters for one VA range, from `TCR_EL1` (D19.2 `TCR_EL1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeConfig {
    pub range: VaRange,
    pub granule: Granule,
    /// `64 - TxSZ`.
    pub va_bits: u32,
    /// The physical (IPA) address size from `IPS`.
    pub pa_bits: u32,
    /// Top-byte-ignore for this range.
    pub tbi: bool,
    /// The level the walk starts at (0..=3).
    pub start_level: u32,
}

impl RangeConfig {
    /// Validate the `TCR_EL1` fields for `range`.
    ///
    /// | Field | TTBR0 | TTBR1 |
    /// |---|---|---|
    /// | TxSZ | 5:0 | 21:16 |
    /// | EPDx | 7 | 23 |
    /// | TGx | 15:14 (00 4K, 01 64K, 10 16K) | 31:30 (01 16K, 10 4K, 11 64K) |
    /// | TBIx | 37 | 38 |
    ///
    /// plus `IPS` (34:32) and `DS` (59).
    pub fn from_tcr(tcr: u64, range: VaRange) -> Result<RangeConfig, WalkError> {
        if field(tcr, 59, 1) != 0 {
            return Err(WalkError::Lpa2);
        }
        let (txsz, epd, tg, tbi) = match range {
            VaRange::Ttbr0 => (
                field(tcr, 0, 6),
                field(tcr, 7, 1),
                field(tcr, 14, 2),
                field(tcr, 37, 1),
            ),
            VaRange::Ttbr1 => (
                field(tcr, 16, 6),
                field(tcr, 23, 1),
                field(tcr, 30, 2),
                field(tcr, 38, 1),
            ),
        };
        if epd != 0 {
            return Err(WalkError::WalkDisabled { range });
        }
        let granule = match (range, tg) {
            (VaRange::Ttbr0, 0b00) | (VaRange::Ttbr1, 0b10) => Granule::K4,
            (VaRange::Ttbr0, 0b10) | (VaRange::Ttbr1, 0b01) => Granule::K16,
            _ => {
                let [tg, ..] = tg.to_le_bytes();
                return Err(WalkError::UnsupportedGranule { range, tg });
            }
        };
        // txsz is a 6-bit field, so the conversion and `64 - txsz` cannot fail.
        let txsz = u32::try_from(txsz).unwrap_or(u32::MAX);
        if !(MIN_TXSZ..=MAX_TXSZ).contains(&txsz) {
            return Err(WalkError::TxSzOutOfRange { range, txsz });
        }
        let va_bits = 64u32.saturating_sub(txsz);
        let pa_bits = match field(tcr, 32, 3) {
            0 => 32,
            1 => 36,
            2 => 40,
            3 => 42,
            4 => 44,
            // 0b110 (52 bits) is capped at 48 without DS (D8.3 "output address size").
            5 | 6 => 48,
            _ => return Err(WalkError::ReservedIps),
        };
        // levels = ceil((va_bits - page_shift) / stride) ∈ 1..=4, since va_bits ∈ 25..=48.
        let resolved = va_bits.saturating_sub(granule.page_shift());
        let levels = resolved.div_ceil(granule.stride()).clamp(1, MAX_LEVELS);
        Ok(RangeConfig {
            range,
            granule,
            va_bits,
            pa_bits,
            tbi: tbi != 0,
            start_level: MAX_LEVELS.saturating_sub(levels),
        })
    }

    /// The lowest VA bit resolved at `level`: `page_shift + stride * (3 - level)`.
    pub const fn level_shift(&self, level: u32) -> u32 {
        let up = 3u32
            .saturating_sub(level)
            .saturating_mul(self.granule.stride());
        self.granule.page_shift().saturating_add(up)
    }

    /// The number of VA bits a table at `level` resolves (fewer at the start level).
    pub const fn index_bits(&self, level: u32) -> u32 {
        let lo = self.level_shift(level);
        let full = self.granule.stride();
        let left = self.va_bits.saturating_sub(lo);
        if left < full { left } else { full }
    }
}

/// Which range `va` belongs to, after checking the bits above it (D8.1 "VA ranges").
fn select_range(tcr: u64, va: u64) -> Result<(VaRange, RangeConfig), WalkError> {
    let range = if field(va, 55, 1) != 0 {
        VaRange::Ttbr1
    } else {
        VaRange::Ttbr0
    };
    let cfg = RangeConfig::from_tcr(tcr, range)?;
    let top = if cfg.tbi { 56 } else { 64 };
    let upper = va & mask_range(cfg.va_bits, top);
    let expected = match range {
        VaRange::Ttbr0 => 0,
        VaRange::Ttbr1 => mask_range(cfg.va_bits, top),
    };
    if upper != expected {
        return Err(WalkError::VaOutOfRange { va });
    }
    Ok((range, cfg))
}

/// What one descriptor means for the walk.
enum Step {
    /// A table descriptor: continue at this table address.
    Next(u64),
    /// A block or page descriptor: the walk ends with this IPA and mapping size.
    Done { ipa: u64, size: u64 },
}

/// Interpret the descriptor `desc` read at `level` for `va` (D8.3 "VMSAv8-64 descriptor
/// formats"): bit 0 = valid; bit 1 = table (levels 0–2) or page (level 3); `01` is a block at
/// the levels [`Granule::block_allowed`] permits and reserved elsewhere. Output and table
/// addresses are bits [47:shift]; bits above `IPS` must be zero (an address-size fault).
fn step(cfg: &RangeConfig, level: u32, desc: u64, va: u64) -> Result<Step, WalkError> {
    let invalid = WalkError::InvalidDescriptor { level, desc };
    let oa_limit = mask_range(cfg.pa_bits, OA_BITS);
    let last = level >= LAST_LEVEL;
    if desc & 1 == 0 {
        return Err(invalid);
    }
    let bit1 = desc & 2 != 0;
    if !last && bit1 {
        let table = desc & mask_range(cfg.granule.page_shift(), OA_BITS);
        if desc & oa_limit != 0 {
            return Err(WalkError::AddressSize { level, addr: table });
        }
        return Ok(Step::Next(table));
    }
    if (last && !bit1) || (!last && !cfg.granule.block_allowed(level)) {
        return Err(invalid);
    }
    let shift = cfg.level_shift(level);
    let out = desc & mask_range(shift, OA_BITS);
    if desc & oa_limit != 0 {
        return Err(WalkError::AddressSize { level, addr: out });
    }
    Ok(Step::Done {
        ipa: out | (va & mask_range(0, shift)),
        size: 1u64.checked_shl(shift).unwrap_or(0),
    })
}

// ANCHOR: stage1_walk
/// Translate `va` the way the guest's EL1&0 stage-1 MMU would (module docs). With
/// `SCTLR_EL1.M = 0` the translation is the identity.
pub fn translate(
    mem: &dyn GuestMemory,
    regs: &TranslationRegs,
    va: u64,
) -> Result<Translation, WalkError> {
    if regs.sctlr_el1 & SCTLR_M == 0 {
        return Ok(Translation {
            ipa: va,
            range: None,
            level: 0,
            mapping_size: 0,
        });
    }
    let (range, cfg) = select_range(regs.tcr_el1, va)?;
    let ttbr = match range {
        VaRange::Ttbr0 => regs.ttbr0_el1,
        VaRange::Ttbr1 => regs.ttbr1_el1,
    };
    // BADDR is TTBR[47:1]; the bits below the start table's size are RES0 and ignored, so the
    // index arithmetic below always stays inside the table (D19.2 `TTBR0_EL1`).
    let first_table_bits = cfg.index_bits(cfg.start_level).saturating_add(3);
    let mut table = ttbr & mask_range(first_table_bits, OA_BITS);
    if table & mask_range(cfg.pa_bits, OA_BITS) != 0 {
        return Err(WalkError::AddressSize {
            level: cfg.start_level,
            addr: table,
        });
    }
    // At most MAX_LEVELS iterations, no recursion: a cycle in the tables cannot loop (MMIO-5).
    for level in cfg.start_level..MAX_LEVELS {
        let idx = field(va, cfg.level_shift(level), cfg.index_bits(level));
        // idx < 2^11 and the table is below 2^48, so neither step can overflow; checked anyway.
        let addr = idx
            .checked_mul(8)
            .and_then(|off| table.checked_add(off))
            .ok_or(WalkError::AddressSize { level, addr: table })?;
        let desc = mem
            .read_u64(GuestAddress(addr))
            .map_err(|_: MemoryError| WalkError::TableOutsideRam { level, addr })?;
        match step(&cfg, level, desc, va)? {
            Step::Next(t) => table = t,
            Step::Done { ipa, size } => {
                return Ok(Translation {
                    ipa,
                    range: Some(range),
                    level,
                    mapping_size: size,
                });
            }
        }
    }
    // Unreachable: `step` never returns `Next` at level 3. Kept total rather than panicking.
    Err(WalkError::InvalidDescriptor {
        level: LAST_LEVEL,
        desc: 0,
    })
}
// ANCHOR_END: stage1_walk

/// A read-only source of instruction words outside RAM: flash ROM (M18, module docs).
pub trait InsnRom: Sync {
    /// The little-endian word at 4-byte-aligned IPA `ipa`, or `None` outside the ROM.
    fn read_insn(&self, ipa: u64) -> Option<u32>;
}

/// Why [`fetch_insn`] could not read the instruction at a PC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchError {
    /// The PC is not 4-byte aligned (A64 instructions always are; a misaligned PC would have
    /// faulted in the guest first, so this means the state changed under us).
    Misaligned { pc: u64 },
    /// The PC does not translate.
    Walk(WalkError),
    /// The PC translates to an IPA outside guest RAM (and outside the ROM, if one was given
    /// to [`fetch_insn_rom`]). Flash ROM is not reachable through `GuestMemory` (MEM-3).
    NotRam { pc: u64, ipa: u64 },
}

impl fmt::Display for FetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            FetchError::Misaligned { pc } => write!(f, "pc {pc:#x} is not 4-byte aligned"),
            FetchError::Walk(e) => write!(f, "pc does not translate: {e}"),
            FetchError::NotRam { pc, ipa } => {
                write!(f, "pc {pc:#x} translates to {ipa:#x}, outside RAM")
            }
        }
    }
}

// ANCHOR: stage1_fetch_insn
/// Read the A64 instruction at virtual address `pc` through the guest's stage 1 (identity
/// with the MMU off). Instructions are always little-endian (ARM ARM B2.6.2, "Instruction
/// endianness"), and an aligned 4-byte word never crosses a page, so one translation covers
/// it. Used by the ISV = 0 path (`vcpu/mmio.rs`) and the fatal dump (`vcpu/dump.rs`).
pub fn fetch_insn(
    mem: &dyn GuestMemory,
    regs: &TranslationRegs,
    pc: u64,
) -> Result<u32, FetchError> {
    if !pc.is_multiple_of(4) {
        return Err(FetchError::Misaligned { pc });
    }
    let t = translate(mem, regs, pc).map_err(FetchError::Walk)?;
    mem.read_u32(GuestAddress(t.ipa))
        .map_err(|_: MemoryError| FetchError::NotRam { pc, ipa: t.ipa })
}
// ANCHOR_END: stage1_fetch_insn

// ANCHOR: stage1_fetch_insn_rom
/// [`fetch_insn`], then, if the PC's IPA is not RAM, the read-only ROM hook `rom` (module docs,
/// M18). The translation is the same (tables from RAM only); only the final word may come
/// from the ROM. `None` behaves exactly like [`fetch_insn`].
pub fn fetch_insn_rom(
    mem: &dyn GuestMemory,
    rom: Option<&dyn InsnRom>,
    regs: &TranslationRegs,
    pc: u64,
) -> Result<u32, FetchError> {
    match (fetch_insn(mem, regs, pc), rom) {
        (Err(FetchError::NotRam { pc, ipa }), Some(rom)) => {
            rom.read_insn(ipa).ok_or(FetchError::NotRam { pc, ipa })
        }
        (other, _) => other,
    }
}
// ANCHOR_END: stage1_fetch_insn_rom
