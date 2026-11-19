//! A 4 KiB-granule stage-1 identity map, so a test guest can run with its MMU on (PLAN M17;
//! course ch21, ch27).
//!
//! **Why a test guest turns its MMU on.** Once `SCTLR_EL1.M = 1`, every address the guest uses
//! (its PC, its stack, the base register of a load) is a *virtual* address. A VMM that has to
//! decode the instruction behind an ISV = 0 data abort (`crates/vmm/src/arch/insn.rs`) must then
//! fetch it through the guest's own page tables and cross-check the decoded address the same
//! way (`crates/vmm/src/arch/stage1_walk.rs`, threat model MMIO-4/MMIO-5). With the MMU off,
//! VA = IPA and a VMM that ignores the tables would still pass; this map makes it fail.
//!
//! **The map** (ARM ARM DDI 0487, D8.2 "Translation process" and D8.3 "Translation table
//! descriptor formats", 4 KiB granule, `T0SZ = 25`: 39-bit VAs, so the walk starts at level 1
//! and has three levels):
//!
//! | VA | → IPA | How | Attributes |
//! |---|---|---|---|
//! | `0x4000_0000` + 1 GiB | identity | level-1 block | Normal write-back (MAIR attr 1) |
//! | `0x0900_0000` + 2 MiB (PL011, PL031) | identity | level-2 block | Device-nGnRnE (attr 0), XN |
//! | `0x0b00_0000` + 4 KiB (testdev) | identity | level-3 page | Device-nGnRnE, XN |
//! | [`TESTDEV_ALIAS`] + 4 KiB | the testdev page | level-3 page | Device-nGnRnE, XN |
//! | [`UART_ALIAS`] + 4 KiB (right after it) | the PL011 page | level-3 page | Device-nGnRnE, XN |
//!
//! Everything else is invalid, so a stray access takes a stage-1 translation fault *in the
//! guest* and the vector table reports it. The two aliases are deliberately not identity: an
//! access through [`TESTDEV_ALIAS`] faults at stage 2 on the testdev's IPA, which only a VMM
//! that really walks the tables can match to the decoded address; and a pair straddling the end
//! of [`TESTDEV_ALIAS`] has its second element in a *different device* (the PL011), the
//! confused-deputy case of threat-model flaw F17 that the VMM must refuse.
//!
//! **Registers** (D19.2): `MAIR_EL1` attr0 = `0x00` (Device-nGnRnE), attr1 = `0xff` (Normal,
//! inner/outer write-back, read/write-allocate); `TCR_EL1` = `T0SZ 25`, `IRGN0 = ORGN0 = 01`
//! (write-back walks), `SH0 = 11` (inner shareable), `TG0 = 00` (4 KiB), `EPD1 = 1` (no TTBR1
//! walks), `IPS = 001` (36-bit IPAs); `TTBR0_EL1` = the level-1 table. Then `TLBI VMALLE1`,
//! and `SCTLR_EL1.{M, C, I}` set, with `ISB`s between, as D8.11 ("Translation table
//! maintenance") and booting.rst's own MMU-on sequence do.

use core::arch::asm;

/// The test device (PLAN §1 `testdev` row).
pub const TESTDEV: u64 = 0x0b00_0000;
/// The PL011 UART (PLAN §1).
pub const UART: u64 = 0x0900_0000;
/// A second VA for the testdev page (module docs).
pub const TESTDEV_ALIAS: u64 = 0x0b10_0000;
/// The page right after [`TESTDEV_ALIAS`], mapped to the PL011.
pub const UART_ALIAS: u64 = TESTDEV_ALIAS + PAGE;

const PAGE: u64 = 0x1000;
const RAM: u64 = 0x4000_0000;

/// Descriptor bits (D8.3): bits 1:0, AttrIndx (4:2), SH (9:8), AF (10), PXN (53), UXN (54).
const BLOCK: u64 = 0b01;
const TABLE_OR_PAGE: u64 = 0b11;
const ATTR_DEVICE: u64 = 0 << 2;
const ATTR_NORMAL: u64 = 1 << 2;
const SH_INNER: u64 = 0b11 << 8;
const AF: u64 = 1 << 10;
const XN: u64 = (1 << 53) | (1 << 54);
const NORMAL: u64 = ATTR_NORMAL | SH_INNER | AF;
const DEVICE: u64 = ATTR_DEVICE | AF | XN;

const MAIR: u64 = 0xff << 8;
const TCR: u64 = 25 | (0b01 << 8) | (0b01 << 10) | (0b11 << 12) | (1 << 23) | (0b001 << 32);
/// `SCTLR_EL1.M` (MMU), `C` (data cache), `I` (instruction cache).
const SCTLR_M: u64 = 1;
const SCTLR_C: u64 = 1 << 2;
const SCTLR_I: u64 = 1 << 12;

/// One translation table: 512 descriptors, 4 KiB-aligned (D8.2: a table is aligned to its size).
#[repr(C, align(4096))]
struct Table([u64; 512]);

static mut L1: Table = Table([0; 512]);
static mut L2: Table = Table([0; 512]);
static mut L3: Table = Table([0; 512]);

/// Write descriptor `index` of `table`.
///
/// # Safety
/// `table` must point at one of the statics above, and the MMU must not be using it yet.
unsafe fn set(table: *mut Table, index: u64, desc: u64) {
    let i = usize::try_from(index & 511).unwrap_or(0);
    // SAFETY: `i < 512` keeps the pointer inside the table; the caller guarantees nothing else
    // reads or writes it concurrently (one CPU, before the MMU uses it).
    unsafe {
        (&raw mut (*table).0)
            .cast::<u64>()
            .add(i)
            .write_volatile(desc)
    };
}

/// The level-1/2/3 index of `va` (4 KiB granule: 9 bits per level from bit 30, 21, 12).
const fn idx(va: u64, shift: u32) -> u64 {
    (va >> shift) & 511
}

/// Build the map (module docs) and turn the MMU and caches on. Call once, on CPU 0, before any
/// other CPU runs. Execution continues at the next instruction: the code is identity-mapped.
pub fn enable() {
    let (l1, l2, l3) = (&raw mut L1, &raw mut L2, &raw mut L3);
    // SAFETY: single-CPU setup of tables the MMU is not using yet; the addresses are those of
    // 4 KiB-aligned statics in RAM, which is identity-mapped by the same tables.
    unsafe {
        set(l1, idx(RAM, 30), RAM | NORMAL | BLOCK);
        set(l1, 0, l2 as u64 | TABLE_OR_PAGE);
        set(l2, idx(UART, 21), UART | DEVICE | BLOCK);
        set(l2, idx(TESTDEV, 21), l3 as u64 | TABLE_OR_PAGE);
        set(l3, idx(TESTDEV, 12), TESTDEV | DEVICE | TABLE_OR_PAGE);
        set(l3, idx(TESTDEV_ALIAS, 12), TESTDEV | DEVICE | TABLE_OR_PAGE);
        set(l3, idx(UART_ALIAS, 12), UART | DEVICE | TABLE_OR_PAGE);
    }
    let ttbr0 = l1 as u64;
    // SAFETY: the standard MMU-on sequence (module docs). The tables map this code, the stack
    // and the data at their current addresses, so nothing moves under the running program.
    unsafe {
        asm!(
            "dsb ish",
            "msr mair_el1, {mair}",
            "msr tcr_el1, {tcr}",
            "msr ttbr0_el1, {ttbr}",
            "isb",
            "tlbi vmalle1",
            "dsb nsh",
            "isb",
            "mrs {t}, sctlr_el1",
            "orr {t}, {t}, {bits}",
            "msr sctlr_el1, {t}",
            "isb",
            mair = in(reg) MAIR,
            tcr = in(reg) TCR,
            ttbr = in(reg) ttbr0,
            bits = in(reg) SCTLR_M | SCTLR_C | SCTLR_I,
            t = out(reg) _,
            options(nostack),
        );
    }
}

/// True if `SCTLR_EL1.M` is set (the MMU is on).
pub fn enabled() -> bool {
    let v: u64;
    // SAFETY: reads a system register; no memory access.
    unsafe { asm!("mrs {}, sctlr_el1", out(reg) v, options(nomem, nostack)) };
    v & SCTLR_M != 0
}
