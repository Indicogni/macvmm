//! A64 load/store decoder for data aborts with ISV = 0 (architecture §8.3 step 4; course ch07
//! extension, ch21; threat model MMIO-4, MMIO-6, F17).
//!
//! **Why a VMM decodes instructions at all.** For most loads and stores that miss stage 2 the
//! hardware writes a complete *instruction syndrome* into `ESR_EL2` (ISV = 1: size, register,
//! sign extension; `arch/esr.rs`), and the VMM emulates the access without looking at the
//! instruction. The syndrome has room for one register and no writeback, so the ARM ARM only
//! provides it for single-register loads and stores without writeback (DDI 0487, D17.2.40, "ISS
//! encoding for an exception from a Data Abort", ISV: "for other faults reported in ESR_EL2, ISV
//! is 0 ... includes ... load/store pair, ... writeback, ... SIMD/FP, exclusives, atomics").
//! `stp` to MMIO gives ISV = 0 on this machine (spike finding 8). Linux's `readl`/`writel`
//! never do that, but firmware does (U-Boot's `memcpy_toio`, EDK2's `MmioWrite` helpers, M18),
//! so for those the VMM must read the instruction at PC and decode it itself, as an x86 VMM
//! always has to.
//!
//! **Scope** (PLAN M17). The encodings live in ARM ARM C4.1.94 "Loads and Stores" (the top-level
//! group `op0 = x1x0`, bits 28:25); field names below follow C6.2 (the per-instruction pages):
//!
//! | Class (C4.1.94) | Bits | Supported |
//! |---|---|---|
//! | Load/store register (unsigned immediate) | `size 111 V 01 opc imm12 Rn Rt` | LDR/STR B/H/W/X, LDRS{B,H,W}, PRFM |
//! | … (unscaled immediate) | `size 111 V 00 opc 0 imm9 00 Rn Rt` | LDUR/STUR, LDURS*, PRFUM |
//! | … (immediate post-indexed / pre-indexed) | `… imm9 01 …` / `… imm9 11 …` | yes |
//! | … (register offset) | `size 111 V 00 opc 1 Rm option S 10 Rn Rt` | yes, UXTW/LSL/SXTW/SXTX |
//! | Load/store register pair (offset / pre / post) | `opc 101 V mode L imm7 Rt2 Rn Rt` | LDP/STP W and X, LDPSW |
//! | everything else in the group | | no |
//!
//! Every word decodes to [`Insn`] or to an [`Unsupported`] class; there is no third outcome, no
//! panic, and no indexing ([`decode`] is a pure function of a `u32`; `tests/insn_decode.rs`
//! decodes 10,000+ random words). The caller answers [`Unsupported`] with a synchronous external
//! abort injected into the guest (DFSC `0x10`, MMIO-6): exclusives cannot be emulated
//! (there is no monitor to clear), atomics would need a read-modify-write the device cannot
//! promise, SIMD/FP registers are not in our register file, and `DC ZVA` (with the FEAT_MTE
//! `DC GVA`/`DC GZVA`) writes a whole block.
//!
//! **Cache maintenance by VA is skipped, not aborted** ([`Insn::CacheMaintenance`]). `DC CIVAC`,
//! `DC CVAC`, `DC IVAC`, `IC IVAU` and the rest are legal on Device memory, and hardware does not
//! fault on them there. Only `DC ZVA`, which is a store, does (ARM ARM, "Data cache maintenance
//! instructions" and C6.2 DC ZVA; ESR_EL2.ISS.CM, D17.2.40, is 1 for these and 0 for `DC ZVA`). A
//! stage-2 miss on one reaches us because the IPA is not RAM, and there is nothing in a device
//! window to clean. KVM does the same (`kvm_handle_guest_abort`: if `kvm_vcpu_dabt_is_cm()`, the
//! guest "is just being cautious", so skip the instruction). The caller makes no bus access and
//! advances the PC by 4. It does that only when the syndrome agrees (CM = 1). A decode/CM
//! disagreement **in either direction** means the code changed under us, which is an abort, the
//! same as a `WnR` mismatch: cache maintenance with CM = 0, and also a load, store or prefetch
//! with CM = 1. The second direction matters most. Cache maintenance by VA reports `WnR = 1`
//! (D17.2.40) and needs only read permission at stage 1 (EL0 needs only `SCTLR_EL1.UCI`), so a
//! racing vCPU that swaps `dc civac, x0` for `stp x1, x2, [x0]` after the fault would otherwise
//! pass the direction and address checks and write a device through a mapping the guest kernel
//! made read-only (a confused deputy inside the guest, F17). Firmware that cleans a range
//! overlapping the flash or a device window after a flash write therefore keeps running, as it
//! does on hardware, and nothing else rides on the CM exemption.
//!
//! **CONSTRAINED UNPREDICTABLE forms are refused** ([`Unsupported::Unpredictable`]). A
//! writeback form whose base is also a transfer register (`ldr x1, [x1, #8]!`, Rn = Rt ≠ 31), and
//! `ldp` with Rt = Rt2, have no single defined result (C6.2 LDR (immediate), LDP: "if wback &&
//! n == t && n != 31 then ConstrainUnpredictable"). Picking one would mean emulating an outcome
//! the hardware might not produce, so they get the abort (MMIO-4). Register 31 means SP as a
//! base and XZR as a transfer or index register (C1.2.5), which is why Rn = Rt = 31 is fine.
//!
//! **The exit IPA is authoritative** ([`plan_isv0`], MMIO-4, F17). By the time the VMM reads the
//! instruction, another vCPU may have rewritten it or the page tables. So the decoded address is
//! only used as a *cross-check*: translated by `stage1_walk`, it must equal the IPA the exit
//! reported (HVF reports the full byte address, `docs/research/hvf-api.md` "exit info"), and the
//! direction must equal `WnR`. The accesses themselves use the exit IPA. A mismatch is an abort,
//! never an emulated access to a device the guest did not actually fault on.
//!
//! **Stage-1 permissions come from the faulting page only** ([`Mapped`], MMIO-4). The VMM does
//! not check stage-1 permissions: the hardware already checked them for the access that
//! faulted, before stage 2 (D8.2). But it checked them only for the page or block that holds
//! the faulting address. So every byte the VMM emulates must lie in that same stage-1 mapping.
//! A pair whose second element falls on the next page is refused
//! ([`Refusal::CrossesMapping`]), even when the guest's tables map that page contiguously onto
//! the same device window: its descriptor may forbid the access (AP, PAN, an EL0-only page),
//! and the VMM would be bypassing a permission fault the hardware would have raised. With the
//! MMU off there is no stage-1 mapping and nothing to bypass.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::regs::Pstate;
use crate::bus::AccessSize;
use core::fmt;

/// `width` bits of `w` starting at bit `lo`. Total: checked shifts, no arithmetic that can wrap.
const fn field(w: u32, lo: u32, width: u32) -> u32 {
    let mask = match 1u32.checked_shl(width) {
        Some(m) => m.wrapping_sub(1),
        None => u32::MAX,
    };
    match w.checked_shr(lo) {
        Some(v) => v & mask,
        None => 0,
    }
}

/// Bit `n` of `w`.
const fn bit(w: u32, n: u32) -> bool {
    field(w, n, 1) != 0
}

/// A 5-bit register number at bit `lo` (always 0..=31).
const fn reg(w: u32, lo: u32) -> u8 {
    let [b, _, _, _] = field(w, lo, 5).to_le_bytes();
    b
}

/// Sign-extend the low `width` bits of `v` (`1 ≤ width ≤ 32`) to 64 bits.
const fn sext(v: u32, width: u32) -> i64 {
    let unused = 64u32.saturating_sub(width);
    let wide = match (v as u64).checked_shl(unused) {
        Some(x) => x.cast_signed(),
        None => 0,
    };
    match wide.checked_shr(unused) {
        Some(x) => x,
        None => 0,
    }
}

/// How a loaded value becomes a register value (C6.2 LDRSB/LDRSH/LDRSW/LDPSW).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoadExt {
    /// Zero-extend (LDRB/LDRH/LDR W/LDR X; writing a W register clears bits 63:32).
    Zero,
    /// Sign-extend to 32 bits, then zero bits 63:32 (`ldrsb w`, `ldrsh w`).
    Sign32,
    /// Sign-extend to 64 bits (`ldrsb x`, `ldrsh x`, `ldrsw`, `ldpsw`).
    Sign64,
}

/// Load (with its extension) or store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Load(LoadExt),
    Store,
}

/// Addressing mode (C1.3.3 "Load/Store addressing modes").
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Index {
    /// `[Xn, off]`: no writeback.
    Offset,
    /// `[Xn, off]!`: access at `Xn + off`, then `Xn = Xn + off`.
    Pre,
    /// `[Xn], off`: access at `Xn`, then `Xn = Xn + off`.
    Post,
}

/// The index-register extension of the register-offset form (C6.2 LDR (register), `option`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Extend {
    /// `option = 010`: zero-extend `Wm`.
    Uxtw,
    /// `option = 011`: `Xm` unchanged (written `lsl`).
    Lsl,
    /// `option = 110`: sign-extend `Wm`.
    Sxtw,
    /// `option = 111`: `Xm` unchanged (written `sxtx`).
    Sxtx,
}

/// Where the offset comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Offset {
    /// A byte offset, already scaled (imm12 and imm7 are scaled by the access size).
    Imm(i64),
    /// `extend(Xm) << shift`; `rm = 31` is XZR.
    Reg { rm: u8, extend: Extend, shift: u8 },
}

/// A general-purpose register operand as the caller must read or write it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gpr {
    /// `X0`..`X30`.
    X(u8),
    /// Register 31 as a transfer or index register: reads 0, writes are discarded.
    Zr,
    /// Register 31 as a base: the stack pointer PSTATE selects ([`SpSel::from_pstate`]).
    Sp,
}

/// A decoded load or store this module can emulate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemInsn {
    pub dir: Direction,
    /// Size of each element (a pair makes two accesses of this size).
    pub size: AccessSize,
    pub rt: u8,
    /// The second transfer register of LDP/STP/LDPSW.
    pub rt2: Option<u8>,
    /// The base register; 31 = SP.
    pub rn: u8,
    pub index: Index,
    pub offset: Offset,
}

/// The result of a successful decode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Insn {
    /// A load or store to emulate.
    Mem(MemInsn),
    /// PRFM/PRFUM: a hint with no architectural effect; the caller just advances the PC.
    Prefetch,
    /// `DC`/`IC` maintenance by VA other than `DC ZVA`/`GVA`/`GZVA` (`SYS #op1, C7, Cm, #op2`,
    /// C5.3): no bus access; the caller advances the PC by 4 when ESR_EL2.CM = 1 and aborts
    /// otherwise. A [`Insn::Mem`] or [`Insn::Prefetch`] under CM = 1 is an abort too (module
    /// docs, "Cache maintenance by VA is skipped").
    CacheMaintenance,
}

/// Why a word is not emulated. Each one is answered with an injected synchronous external abort
/// (MMIO-6), never a panic or a VMM error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unsupported {
    /// LDXR/STXR/LDAXR/LDXP… (C4.1.94 "Load/store exclusive"): needs an exclusive monitor.
    Exclusive,
    /// LDADD/SWP/CAS/CASP… (FEAT_LSE): a read-modify-write the device cannot make atomic.
    Atomic,
    /// LDAR/STLR/LDAPUR… (load-acquire/store-release): normally ISV = 1; not decoded here.
    Ordered,
    /// Any SIMD/FP load or store (`V = 1`, bit 26): the V registers are not in our register file.
    SimdFp,
    /// `DC ZVA` (and FEAT_MTE's `DC GVA`, `DC GZVA`): writes a whole block (DCZID_EL0), which
    /// no device register can mean. Hardware faults on it for Device memory (C6.2 DC ZVA).
    DcZva,
    /// `AT S1E1R` and friends (`SYS` with CRn = 7, CRm = 8 or 9). They fault at stage 2 only
    /// inside the stage-1 walk (S1PTW = 1), which is fatal before any decode (MMIO-2). They are
    /// named here so that they are never mistaken for skippable cache maintenance: skipping one
    /// would leave PAR_EL1 stale.
    AddressTranslation,
    /// LDR (literal) and PRFM (literal): PC-relative, never device accesses in practice.
    Literal,
    /// LDTR/STTR…, LDTP/STTP: unprivileged accesses (EL0 permissions checked at EL1).
    Unprivileged,
    /// LDNP/STNP.
    NonTemporalPair,
    /// LDRAA/LDRAB (FEAT_PAuth).
    PointerAuth,
    /// STG/STGP/LDG… (FEAT_MTE).
    MemoryTag,
    /// A CONSTRAINED UNPREDICTABLE form (module docs).
    Unpredictable(&'static str),
    /// An unallocated encoding inside the load/store group.
    Unallocated,
    /// Not a load or store at all (the PC moved, or the code changed under us).
    NotLoadStore,
}

impl Unsupported {
    /// A stable short name (traces, the corpus, the fatal dump).
    pub const fn name(self) -> &'static str {
        match self {
            Unsupported::Exclusive => "exclusive",
            Unsupported::Atomic => "atomic",
            Unsupported::Ordered => "ordered",
            Unsupported::SimdFp => "simd-fp",
            Unsupported::DcZva => "dc-zva",
            Unsupported::AddressTranslation => "address-translation",
            Unsupported::Literal => "literal",
            Unsupported::Unprivileged => "unprivileged",
            Unsupported::NonTemporalPair => "non-temporal-pair",
            Unsupported::PointerAuth => "pointer-auth",
            Unsupported::MemoryTag => "memory-tag",
            Unsupported::Unpredictable(_) => "unpredictable",
            Unsupported::Unallocated => "unallocated",
            Unsupported::NotLoadStore => "not-load-store",
        }
    }
}

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unsupported::Unpredictable(why) => write!(f, "unsupported: unpredictable: {why}"),
            other => write!(f, "unsupported: {}", other.name()),
        }
    }
}

/// The `size` field (bits 31:30) as an access size.
const fn size_from_field(s: u32) -> AccessSize {
    match s & 3 {
        0 => AccessSize::B1,
        1 => AccessSize::B2,
        2 => AccessSize::B4,
        _ => AccessSize::B8,
    }
}

/// `log2(size)` as a shift amount (0..=3).
const fn size_log2(s: AccessSize) -> u8 {
    match s {
        AccessSize::B1 => 0,
        AccessSize::B2 => 1,
        AccessSize::B4 => 2,
        AccessSize::B8 => 3,
    }
}

/// `imm * size` as a shift. The inputs are an imm12 (≤ 4095) or an imm7 (±64) and the shift is
/// at most 3, so the result never loses bits; `checked_shl` only guards the shift amount.
fn scale(imm: i64, size: AccessSize) -> i64 {
    imm.checked_shl(u32::from(size_log2(size))).unwrap_or(0)
}

/// What `size:opc` means for the single-register classes (C6.2 LDR/STR/LDRS*/PRFM tables).
enum SizeOpc {
    Mem(Direction, AccessSize),
    Prefetch,
}

fn single_size_opc(w: u32) -> Result<SizeOpc, Unsupported> {
    let size = field(w, 30, 2);
    let sz = size_from_field(size);
    match (size, field(w, 22, 2)) {
        (_, 0b00) => Ok(SizeOpc::Mem(Direction::Store, sz)),
        (_, 0b01) => Ok(SizeOpc::Mem(Direction::Load(LoadExt::Zero), sz)),
        (0b11, 0b10) => Ok(SizeOpc::Prefetch),
        (_, 0b10) => Ok(SizeOpc::Mem(Direction::Load(LoadExt::Sign64), sz)),
        (0b00 | 0b01, _) => Ok(SizeOpc::Mem(Direction::Load(LoadExt::Sign32), sz)),
        _ => Err(Unsupported::Unallocated),
    }
}

/// Refuse writeback forms whose base is also a transfer register (module docs).
fn check_writeback(m: &MemInsn) -> Result<(), Unsupported> {
    if m.index == Index::Offset || m.rn == 31 {
        return Ok(());
    }
    if m.rn == m.rt || m.rt2 == Some(m.rn) {
        return Err(Unsupported::Unpredictable(
            "writeback base is a transfer register",
        ));
    }
    Ok(())
}

/// The three single-register immediate/register forms, distinguished by the caller.
#[derive(Clone, Copy)]
enum SingleForm {
    /// imm12, scaled by the size.
    UnsignedImm,
    /// imm9 (bits 20:12), unscaled, with the mode in bits 11:10.
    Imm9,
    /// Register offset.
    RegOffset,
}

// ANCHOR: insn_decode_ldst
/// Single-register loads and stores: LDR/STR (unsigned immediate, unscaled, pre-, post-index,
/// register offset), their B/H/sign-extending variants, and PRFM/PRFUM.
fn decode_single(w: u32, form: SingleForm) -> Result<Insn, Unsupported> {
    // PRFM's fields (size = 11) give the offset scale; the direction is never used.
    let (dir, size, prefetch) = match single_size_opc(w)? {
        SizeOpc::Mem(d, s) => (d, s, false),
        SizeOpc::Prefetch => (Direction::Store, AccessSize::B8, true),
    };
    let (index, offset) = match form {
        SingleForm::UnsignedImm => {
            let imm = i64::from(field(w, 10, 12));
            (Index::Offset, Offset::Imm(scale(imm, size)))
        }
        SingleForm::Imm9 => {
            let imm = Offset::Imm(sext(field(w, 12, 9), 9));
            match field(w, 10, 2) {
                0b00 => (Index::Offset, imm),
                0b01 => (Index::Post, imm),
                0b11 => (Index::Pre, imm),
                _ => return Err(Unsupported::Unprivileged),
            }
        }
        SingleForm::RegOffset => {
            let extend = match field(w, 13, 3) {
                0b010 => Extend::Uxtw,
                0b011 => Extend::Lsl,
                0b110 => Extend::Sxtw,
                0b111 => Extend::Sxtx,
                _ => return Err(Unsupported::Unallocated),
            };
            let shift = if bit(w, 12) { size_log2(size) } else { 0 };
            let rm = reg(w, 16);
            (Index::Offset, Offset::Reg { rm, extend, shift })
        }
    };
    if prefetch {
        // PRFM has no pre/post-indexed form (C6.2 PRFM: those encodings are unallocated).
        return if index == Index::Offset {
            Ok(Insn::Prefetch)
        } else {
            Err(Unsupported::Unallocated)
        };
    }
    let m = MemInsn {
        dir,
        size,
        rt: reg(w, 0),
        rt2: None,
        rn: reg(w, 5),
        index,
        offset,
    };
    check_writeback(&m)?;
    Ok(Insn::Mem(m))
}
// ANCHOR_END: insn_decode_ldst

// ANCHOR: insn_decode_pair
/// LDP/STP (W, X) and LDPSW, with signed offset, pre- and post-index (C6.2 LDP, STP, LDPSW):
/// `opc 101 0 mode L imm7 Rt2 Rn Rt`, the offset is `imm7` scaled by the element size.
fn decode_pair(w: u32) -> Result<Insn, Unsupported> {
    let index = match field(w, 23, 2) {
        0b00 => return Err(Unsupported::NonTemporalPair),
        0b01 => Index::Post,
        0b10 => Index::Offset,
        _ => Index::Pre,
    };
    let load = bit(w, 22);
    let (dir, size) = match (field(w, 30, 2), load) {
        (0b00, false) => (Direction::Store, AccessSize::B4),
        (0b00, true) => (Direction::Load(LoadExt::Zero), AccessSize::B4),
        (0b01, true) => (Direction::Load(LoadExt::Sign64), AccessSize::B4),
        (0b01, false) => return Err(Unsupported::MemoryTag), // STGP
        (0b10, false) => (Direction::Store, AccessSize::B8),
        (0b10, true) => (Direction::Load(LoadExt::Zero), AccessSize::B8),
        // opc = 11 is LDTP/STTP (FEAT_LSUI, unprivileged pairs) in recent ARM ARMs.
        _ => return Err(Unsupported::Unprivileged),
    };
    let off = scale(sext(field(w, 15, 7), 7), size);
    let (rt, rt2) = (reg(w, 0), reg(w, 10));
    if load && rt == rt2 {
        return Err(Unsupported::Unpredictable("load pair with Rt == Rt2"));
    }
    let m = MemInsn {
        dir,
        size,
        rt,
        rt2: Some(rt2),
        rn: reg(w, 5),
        index,
        offset: Offset::Imm(off),
    };
    check_writeback(&m)?;
    Ok(Insn::Mem(m))
}
// ANCHOR_END: insn_decode_pair

/// The block-writing `DC` instructions, `SYS #3, C7, C4, #op2, Xt` (C6.2 DC; C5.3 "A64 system
/// instructions for cache maintenance"): `1101 0101 0000 1 011 0111 0100 op2 Rt` with
/// op2 = 1 (`ZVA`), 3 (`GVA`) or 4 (`GZVA`). The hardware treats these as stores (CM = 0).
const fn is_dc_store(w: u32) -> bool {
    field(w, 8, 24) == field(0xd50b_7400, 8, 24) && matches!(field(w, 5, 3), 1 | 3 | 4)
}

/// Any `SYS` with `op0 = 01`, `CRn = 7` (C5.3: cache maintenance, address translation and the
/// prediction-restriction instructions).
const fn is_sys_crn7(w: u32) -> bool {
    field(w, 19, 13) == field(0xd508_0000, 19, 13) && field(w, 12, 4) == 7
}

/// Decode one A64 instruction word (little-endian, as fetched). Total for every `u32`.
pub fn decode(w: u32) -> Result<Insn, Unsupported> {
    if is_dc_store(w) {
        return Err(Unsupported::DcZva);
    }
    if is_sys_crn7(w) {
        // CRm (bits 11:8) = 8 or 9 is AT; every other CRn = 7 SYS is DC/IC maintenance or a
        // prediction-restriction hint, and none of those transfers data.
        return match field(w, 8, 4) {
            8 | 9 => Err(Unsupported::AddressTranslation),
            _ => Ok(Insn::CacheMaintenance),
        };
    }
    // The "Loads and Stores" group: op0 (bits 28:25) = x1x0 (C4.1, Table C4-1).
    if !bit(w, 27) || bit(w, 25) {
        return Err(Unsupported::NotLoadStore);
    }
    // op1 (bit 26) is V in every class of the group: a SIMD/FP register is transferred.
    if bit(w, 26) {
        return Err(Unsupported::SimdFp);
    }
    // Bits 29:27 (27 is 1 here) and 24 select the class; bits 31:30 and 23:21 refine it.
    match (field(w, 28, 2), bit(w, 24)) {
        // 001 0 0 0: exclusive, ordered and compare-and-swap.
        (0b00, false) => Err(classify_exclusive(w)),
        (0b00, true) => Err(Unsupported::Unallocated),
        // 011 0 0x: literal.
        (0b01, false) => Err(Unsupported::Literal),
        // 011 0 01: RCpc unscaled (LDAPUR/STLUR) and the memory-tag instructions.
        (0b01, true) => Err(if !bit(w, 21) && field(w, 10, 2) == 0 {
            Unsupported::Ordered
        } else if field(w, 30, 2) == 0b11 && bit(w, 21) {
            Unsupported::MemoryTag
        } else {
            Unsupported::Unallocated
        }),
        // 101 0 xx: pairs.
        (0b10, _) => decode_pair(w),
        // 111 0 01: unsigned immediate.
        (_, true) => decode_single(w, SingleForm::UnsignedImm),
        // 111 0 00: imm9 forms (bit 21 = 0), or atomics / register offset / PAC (bit 21 = 1).
        (_, false) => match (bit(w, 21), field(w, 10, 2)) {
            (false, _) => decode_single(w, SingleForm::Imm9),
            (true, 0b00) => Err(Unsupported::Atomic),
            (true, 0b10) => decode_single(w, SingleForm::RegOffset),
            (true, _) => Err(Unsupported::PointerAuth),
        },
    }
}

/// Split the `size 001000 o2 L o1 Rs o0 Rt2 Rn Rt` class for the message: CAS (o2 = 1,
/// o1 = 1) and CASP (o2 = 0, o1 = 1, bit 31 = 0) are atomics, LDAR/STLR (o2 = 1, o1 = 0) are
/// ordered, and the rest are exclusives (C4.1.94).
const fn classify_exclusive(w: u32) -> Unsupported {
    match (bit(w, 23), bit(w, 21), bit(w, 31)) {
        (true, true, _) | (false, true, false) => Unsupported::Atomic,
        (true, false, _) => Unsupported::Ordered,
        _ => Unsupported::Exclusive,
    }
}

impl MemInsn {
    /// True for STR/STP.
    pub const fn is_store(&self) -> bool {
        matches!(self.dir, Direction::Store)
    }

    /// `Some(v masked to the access size)` for a store, `None` for a load.
    pub fn store_data(&self, v: u64) -> Option<u64> {
        self.is_store().then_some(v & self.size.mask())
    }

    /// True if the base register is updated (pre- or post-index).
    pub const fn writes_back(&self) -> bool {
        !matches!(self.index, Index::Offset)
    }

    /// The base register operand.
    pub const fn base(&self) -> Gpr {
        if self.rn == 31 {
            Gpr::Sp
        } else {
            Gpr::X(self.rn)
        }
    }

    /// The first transfer register.
    pub const fn transfer(&self) -> Gpr {
        xr(self.rt)
    }

    /// The second transfer register of a pair.
    pub const fn transfer2(&self) -> Option<Gpr> {
        match self.rt2 {
            Some(r) => Some(xr(r)),
            None => None,
        }
    }

    /// The index register of the register-offset form.
    pub const fn index_reg(&self) -> Option<Gpr> {
        match self.offset {
            Offset::Reg { rm, .. } => Some(xr(rm)),
            Offset::Imm(_) => None,
        }
    }

    /// `(address of the first element, new base)` for base value `base` and index register
    /// value `index` (ignored for immediate offsets). Address arithmetic is modulo 2^64, as in
    /// the ARM ARM pseudocode (`bits(64)` addition, J1.1), so `wrapping_add` is the spec.
    pub fn addresses(&self, base: u64, index: u64) -> (u64, u64) {
        let off = match self.offset {
            Offset::Imm(i) => i.cast_unsigned(),
            Offset::Reg { extend, shift, .. } => {
                let v = match extend {
                    Extend::Uxtw => index & 0xffff_ffff,
                    Extend::Sxtw => sext32(index),
                    Extend::Lsl | Extend::Sxtx => index,
                };
                v.checked_shl(u32::from(shift & 3)).unwrap_or(0)
            }
        };
        let moved = base.wrapping_add(off);
        let first = if self.index == Index::Post {
            base
        } else {
            moved
        };
        (first, moved)
    }

    /// The register value a load of `raw` (the device's `size`-byte value) produces.
    pub fn load_value(&self, raw: u64) -> u64 {
        let v = raw & self.size.mask();
        let bits = match self.size {
            AccessSize::B1 => 8u32,
            AccessSize::B2 => 16,
            AccessSize::B4 => 32,
            AccessSize::B8 => 64,
        };
        match self.dir {
            Direction::Load(LoadExt::Sign64) if bits < 64 => sext_u64(v, bits),
            Direction::Load(LoadExt::Sign32) if bits < 32 => sext_u64(v, bits) & 0xffff_ffff,
            _ => v,
        }
    }
}

/// Register 31 as a transfer/index register is XZR.
const fn xr(r: u8) -> Gpr {
    if r >= 31 { Gpr::Zr } else { Gpr::X(r) }
}

/// Sign-extend the low 32 bits of `v`.
fn sext32(v: u64) -> u64 {
    sext_u64(v & 0xffff_ffff, 32)
}

/// Sign-extend the low `bits` (1..=63) of `v` to 64.
fn sext_u64(v: u64, bits: u32) -> u64 {
    let unused = 64u32.saturating_sub(bits);
    let s = v.checked_shl(unused).unwrap_or(0).cast_signed();
    s.checked_shr(unused).unwrap_or(0).cast_unsigned()
}

impl fmt::Display for Gpr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Gpr::X(n) => write!(f, "x{n}"),
            Gpr::Zr => f.write_str("xzr"),
            Gpr::Sp => f.write_str("sp"),
        }
    }
}

/// `r1` / `zr` for transfer registers in [`Insn`]'s display.
struct T(u8);

impl fmt::Display for T {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.0 >= 31 {
            f.write_str("zr")
        } else {
            write!(f, "r{}", self.0)
        }
    }
}

impl fmt::Display for MemInsn {
    /// The corpus notation (`tests/data/insn_corpus.txt`): `ld.sh64 r1, [x2, #-2]!`,
    /// `stp.x r29, r30, [sp, #-16]!`, `ld.w r1, [x2, w3, sxtw #2]`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sz = match self.size {
            AccessSize::B1 => "b",
            AccessSize::B2 => "h",
            AccessSize::B4 => "w",
            AccessSize::B8 => "x",
        };
        let (op, ext) = match self.dir {
            Direction::Store => ("st", ""),
            Direction::Load(LoadExt::Zero) => ("ld", ""),
            Direction::Load(LoadExt::Sign32) => ("ld", "32"),
            Direction::Load(LoadExt::Sign64) => ("ld", "64"),
        };
        let p = if self.rt2.is_some() { "p" } else { "" };
        let s = if ext.is_empty() { "" } else { "s" };
        write!(f, "{op}{p}.{s}{sz}{ext} {}", T(self.rt))?;
        if let Some(r2) = self.rt2 {
            write!(f, ", {}", T(r2))?;
        }
        let base = self.base();
        match (self.index, self.offset) {
            (Index::Offset, Offset::Imm(i)) => write!(f, ", [{base}, #{i}]"),
            (Index::Pre, Offset::Imm(i)) => write!(f, ", [{base}, #{i}]!"),
            (Index::Post, Offset::Imm(i)) => write!(f, ", [{base}], #{i}"),
            (_, Offset::Reg { rm, extend, shift }) => {
                let (w, name) = match extend {
                    Extend::Uxtw => ("w", "uxtw"),
                    Extend::Lsl => ("x", "lsl"),
                    Extend::Sxtw => ("w", "sxtw"),
                    Extend::Sxtx => ("x", "sxtx"),
                };
                if rm >= 31 {
                    write!(f, ", [{base}, {w}zr, {name} #{shift}]")
                } else {
                    write!(f, ", [{base}, {w}{rm}, {name} #{shift}]")
                }
            }
        }
    }
}

impl fmt::Display for Insn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Insn::Mem(m) => m.fmt(f),
            Insn::Prefetch => f.write_str("prfm"),
            Insn::CacheMaintenance => f.write_str("cache-maintenance: skip"),
        }
    }
}

/// Which stack pointer register 31 means as a base (C1.2.5; D1.4 PSTATE.SP): at EL0 always
/// `SP_EL0`; at EL1 `SP_EL0` for EL1t and `SP_EL1` for EL1h.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpSel {
    El0,
    El1,
}

impl SpSel {
    /// `None` for AArch32 or EL2/EL3 (not an EL1&0 guest: the caller aborts).
    pub const fn from_pstate(p: Pstate) -> Option<SpSel> {
        if p.aarch32() {
            return None;
        }
        match (p.el(), p.sp_elx()) {
            (0, _) | (1, false) => Some(SpSel::El0),
            (1, true) => Some(SpSel::El1),
            _ => None,
        }
    }
}

/// The register values an emulation needs, read by the caller *after* decoding.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Operands {
    /// The base register (the selected SP when Rn = 31).
    pub base: u64,
    /// The index register (0 for XZR or an immediate form).
    pub index: u64,
    /// Store data, first element (0 for XZR or a load).
    pub rt: u64,
    /// Store data, second element of a pair.
    pub rt2: u64,
}

impl Operands {
    /// Read exactly the registers `insn` needs through `read`. `read` is never called with
    /// [`Gpr::Zr`] (it reads as 0); store data is only read for stores.
    pub fn gather<E>(
        insn: &MemInsn,
        mut read: impl FnMut(Gpr) -> Result<u64, E>,
    ) -> Result<Operands, E> {
        let mut get = |g: Option<Gpr>| match g {
            None | Some(Gpr::Zr) => Ok(0),
            Some(r) => read(r),
        };
        let base = get(Some(insn.base()))?;
        let index = get(insn.index_reg())?;
        let (rt, rt2) = if insn.is_store() {
            (get(Some(insn.transfer()))?, get(insn.transfer2())?)
        } else {
            (0, 0)
        };
        Ok(Operands {
            base,
            index,
            rt,
            rt2,
        })
    }
}

/// What the planner's `translate` callback reports for a guest VA (module docs, "Stage-1
/// permissions come from the faulting page only").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mapped {
    /// The IPA the VA translates to.
    pub ipa: u64,
    /// The size of the stage-1 page or block that holds the VA (a power of two:
    /// `stage1_walk::Translation::mapping_size`), or 0 when the MMU is off and VA = IPA.
    pub mapping_size: u64,
}

impl Mapped {
    /// The MMU-off translation: identity, no stage-1 mapping.
    pub const fn identity(va: u64) -> Mapped {
        Mapped {
            ipa: va,
            mapping_size: 0,
        }
    }
}

/// What the exit said: the faulting IPA (authoritative) and `WnR`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExitFacts {
    pub ipa: u64,
    pub wnr: bool,
}

/// What the ISV = 0 path needs from the MMIO bus: window identity for the same-device rule
/// ([`plan_isv0`]) and the accesses themselves ([`execute`]). `vcpu/mmio.rs` implements it over
/// `bus::Bus`. `Bus::device_at` gives `ipa - offset`, which is the window base, and the window
/// holds the access when the last byte has the same base. The host tests use a mock that logs
/// every access, which proves that a refused plan touches no device (PLAN M17 security tests).
pub trait Isv0Bus {
    type Error;
    /// An identity for the one device window that holds the whole `size`-byte access at `ipa`.
    /// The window's base address works, because windows never overlap (MMIO-7). The result is
    /// `None` when no single window holds it (unmapped or straddling). This lookup must not
    /// access any device: it runs before the guest's access is allowed to happen.
    fn window(&self, ipa: u64, size: AccessSize) -> Option<u64>;
    /// A `size`-byte device read at `ipa`, zero-extended.
    fn read(&mut self, ipa: u64, size: AccessSize) -> Result<u64, Self::Error>;
    /// A `size`-byte device write at `ipa` (`value` already masked to the size).
    fn write(&mut self, ipa: u64, size: AccessSize, value: u64) -> Result<(), Self::Error>;
}

/// One bus access of a plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BusAccess {
    pub ipa: u64,
    pub size: AccessSize,
    /// `Some(value masked to size)` for a store.
    pub write: Option<u64>,
}

/// The emulation of an ISV = 0 access, checked against the exit and the bus. [`execute`]
/// performs `first`, then `second`. Both are already known to lie in the same device window
/// (MMIO-4). Only when both succeed does it return the register updates ([`Commit`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Plan {
    /// The instruction the plan was made from (transfer registers and load extension).
    pub insn: MemInsn,
    /// The guest VA of the first element (for traces).
    pub va: u64,
    pub first: BusAccess,
    pub second: Option<BusAccess>,
    /// The base register and its new value, for pre- and post-index forms.
    pub writeback: Option<(Gpr, u64)>,
}

/// Why [`plan_isv0`] refused: each one means "inject an abort, emulate nothing" (MMIO-4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The instruction's direction differs from the syndrome's `WnR`.
    Direction { insn_store: bool, wnr: bool },
    /// The decoded address does not translate (stage 1 no longer maps it).
    Untranslatable { va: u64 },
    /// The decoded address translates somewhere other than the exit IPA.
    AddressMismatch { decoded: u64, exit: u64 },
    /// A pair's second element does not translate to `exit IPA + size`.
    PairMismatch { decoded: Option<u64>, expected: u64 },
    /// The `len`-byte access at `va` leaves the stage-1 page or block (`mapping_size` bytes)
    /// that holds `va`, whose permissions are the only ones the hardware checked (module docs).
    CrossesMapping {
        va: u64,
        len: u64,
        mapping_size: u64,
    },
    /// A pair's two elements are not both inside one device window: an element is unmapped,
    /// straddles a window end, or sits in a different device (MMIO-4, F17 confused deputy).
    /// The values are [`Isv0Bus::window`] identities.
    CrossDevice {
        first: Option<u64>,
        second: Option<u64>,
    },
    /// An address computation passed `u64::MAX`.
    Overflow,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Refusal::Direction { insn_store, wnr } => write!(
                f,
                "instruction is a {} but the syndrome says WnR={}",
                if insn_store { "store" } else { "load" },
                u8::from(wnr)
            ),
            Refusal::Untranslatable { va } => write!(f, "decoded address {va:#x} has no mapping"),
            Refusal::AddressMismatch { decoded, exit } => write!(
                f,
                "decoded address translates to {decoded:#x}, exit IPA is {exit:#x}"
            ),
            Refusal::PairMismatch { decoded, expected } => match decoded {
                Some(d) => write!(f, "second element at {d:#x}, expected {expected:#x}"),
                None => write!(f, "second element has no mapping (expected {expected:#x})"),
            },
            Refusal::CrossesMapping {
                va,
                len,
                mapping_size,
            } => write!(
                f,
                "{len}-byte access at {va:#x} leaves its {mapping_size:#x}-byte stage-1 mapping"
            ),
            Refusal::CrossDevice { first, second } => {
                let w =
                    |o: Option<u64>| o.map_or_else(|| "none".to_string(), |b| format!("{b:#x}"));
                write!(
                    f,
                    "pair is not inside one device window (first {}, second {})",
                    w(first),
                    w(second)
                )
            }
            Refusal::Overflow => f.write_str("address overflow"),
        }
    }
}

// ANCHOR: isv0_plan
/// Turn a decoded instruction into bus accesses **anchored on the exit IPA** (MMIO-4, F17).
///
/// `translate` maps a guest VA to an IPA and the size of the stage-1 mapping that holds it
/// (`stage1_walk::translate` with the vCPU's current translation registers, or
/// [`Mapped::identity`] with the MMU off); `None` = no mapping. The decoded address is only a
/// cross-check: it must translate to exactly `exit.ipa`, the direction must match `WnR`, and
/// the access must stay inside that one stage-1 mapping ([`within_mapping`]). A pair has the
/// extra rules of [`plan_second`]. `bus` is only asked for window identities here, never
/// accessed.
pub fn plan_isv0<B: Isv0Bus + ?Sized>(
    insn: &MemInsn,
    ops: &Operands,
    exit: ExitFacts,
    translate: &mut dyn FnMut(u64) -> Option<Mapped>,
    bus: &B,
) -> Result<Plan, Refusal> {
    if insn.is_store() != exit.wnr {
        return Err(Refusal::Direction {
            insn_store: insn.is_store(),
            wnr: exit.wnr,
        });
    }
    let (va, new_base) = insn.addresses(ops.base, ops.index);
    let map = translate(va).ok_or(Refusal::Untranslatable { va })?;
    if map.ipa != exit.ipa {
        return Err(Refusal::AddressMismatch {
            decoded: map.ipa,
            exit: exit.ipa,
        });
    }
    within_mapping(va, insn.size.bytes(), map)?;
    let first = BusAccess {
        ipa: exit.ipa,
        size: insn.size,
        write: insn.store_data(ops.rt),
    };
    let second = match insn.rt2 {
        None => None,
        Some(_) => Some(plan_second(insn, ops, va, map, exit, translate, bus)?),
    };
    let writeback = insn.writes_back().then_some((insn.base(), new_base));
    Ok(Plan {
        insn: *insn,
        va,
        first,
        second,
        writeback,
    })
}
// ANCHOR_END: isv0_plan

/// Refuse an access of `len` bytes at `va` that leaves the stage-1 page or block `map`
/// describes (module docs, "Stage-1 permissions come from the faulting page only"). With the
/// MMU off (`mapping_size == 0`) there is no mapping to leave.
fn within_mapping(va: u64, len: u64, map: Mapped) -> Result<(), Refusal> {
    if map.mapping_size == 0 {
        return Ok(());
    }
    let last = len
        .checked_sub(1)
        .and_then(|l| va.checked_add(l))
        .ok_or(Refusal::Overflow)?;
    let crosses = match map.mapping_size.checked_sub(1) {
        // Both ends share every address bit above the mapping's offset bits.
        Some(offset_bits) if map.mapping_size.is_power_of_two() => (va ^ last) & !offset_bits != 0,
        _ => true,
    };
    if crosses {
        return Err(Refusal::CrossesMapping {
            va,
            len,
            mapping_size: map.mapping_size,
        });
    }
    Ok(())
}

// ANCHOR: isv0_pair
/// The second element of LDP/STP/LDPSW (MMIO-4). It must translate to exactly
/// `exit.ipa + size`, the whole pair must lie in the stage-1 mapping `first_map` of the first
/// (faulting) element, whose permissions are the only ones the hardware checked, and both
/// elements must lie wholly inside **one** device window of `bus`. Otherwise a guest whose page
/// tables map a pair across the end of a device window would send the second element to the
/// neighbouring device, which never saw a fault (F17, a confused deputy). Because the check runs
/// before any access, a store pair can never half-happen.
fn plan_second<B: Isv0Bus + ?Sized>(
    insn: &MemInsn,
    ops: &Operands,
    va: u64,
    first_map: Mapped,
    exit: ExitFacts,
    translate: &mut dyn FnMut(u64) -> Option<Mapped>,
    bus: &B,
) -> Result<BusAccess, Refusal> {
    let n = insn.size.bytes();
    let expected = exit.ipa.checked_add(n).ok_or(Refusal::Overflow)?;
    let va2 = va.checked_add(n).ok_or(Refusal::Overflow)?;
    let got = translate(va2).map(|m| m.ipa);
    if got != Some(expected) {
        return Err(Refusal::PairMismatch {
            decoded: got,
            expected,
        });
    }
    within_mapping(va, n.checked_mul(2).ok_or(Refusal::Overflow)?, first_map)?;
    let first = bus.window(exit.ipa, insn.size);
    let second = bus.window(expected, insn.size);
    if first.is_none() || first != second {
        return Err(Refusal::CrossDevice { first, second });
    }
    Ok(BusAccess {
        ipa: expected,
        size: insn.size,
        write: insn.store_data(ops.rt2),
    })
}
// ANCHOR_END: isv0_pair

/// The register updates of a finished emulation. The caller applies `loads`, then `writeback`,
/// then advances the PC by 4. The decoder refuses writeback forms whose base is a transfer
/// register, so the two never name the same register.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Commit {
    /// `(Rt, value)` and `(Rt2, value)` for a load, already extended
    /// ([`MemInsn::load_value`]). Only `Gpr::X`: XZR targets and stores give `None`.
    pub loads: [Option<(Gpr, u64)>; 2],
    /// The base register and its new value (pre- and post-index forms).
    pub writeback: Option<(Gpr, u64)>,
}

/// Either side of [`emulate_isv0`] failing. Each one means the caller injects an abort.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isv0Error<E> {
    /// The plan was refused. No device was touched.
    Refused(Refusal),
    /// A bus access failed. With the window check above this cannot happen for a pair's second
    /// element, but it is still handled. No register is changed.
    Bus(E),
}

// ANCHOR: isv0_execute
/// Perform a plan's accesses in order and return the register updates. It changes no register
/// itself, so a failure leaves the vCPU exactly as the fault found it (writeback only after
/// both accesses succeed, MMIO-4).
pub fn execute<B: Isv0Bus + ?Sized>(plan: &Plan, bus: &mut B) -> Result<Commit, B::Error> {
    let mut one = |a: BusAccess| match a.write {
        Some(v) => bus.write(a.ipa, a.size, v).map(|()| None),
        None => bus.read(a.ipa, a.size).map(Some),
    };
    let r1 = one(plan.first)?;
    let r2 = match plan.second {
        Some(a) => one(a)?,
        None => None,
    };
    let load = |reg: Option<Gpr>, raw: Option<u64>| match (reg, raw) {
        (Some(g @ Gpr::X(_)), Some(v)) => Some((g, plan.insn.load_value(v))),
        _ => None,
    };
    Ok(Commit {
        loads: [
            load(Some(plan.insn.transfer()), r1),
            load(plan.insn.transfer2(), r2),
        ],
        writeback: plan.writeback,
    })
}

/// [`plan_isv0`] then [`execute`]: the one call the ISV = 0 path makes after decoding and
/// gathering operands. A refused plan returns before `bus` is accessed.
pub fn emulate_isv0<B: Isv0Bus + ?Sized>(
    insn: &MemInsn,
    ops: &Operands,
    exit: ExitFacts,
    translate: &mut dyn FnMut(u64) -> Option<Mapped>,
    bus: &mut B,
) -> Result<Commit, Isv0Error<B::Error>> {
    let plan = plan_isv0(insn, ops, exit, translate, &*bus).map_err(Isv0Error::Refused)?;
    execute(&plan, bus).map_err(Isv0Error::Bus)
}
// ANCHOR_END: isv0_execute
