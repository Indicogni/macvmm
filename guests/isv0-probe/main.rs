//! `isv0-probe`: loads and stores that reach the VMM with ISV = 0, run with the MMU on (PLAN
//! M17; course ch07 extension, ch21). Run with `--testdev`.
//!
//! **What ISV = 0 means.** For a pair (`ldp`/`stp`/`ldpsw`) or a writeback form (`[x0, #8]!`,
//! `[x0], #8`), the data-abort syndrome cannot describe the access (ARM ARM DDI 0487, D17.2.40:
//! ISV is 0 for those), so the VMM has to read the instruction at the PC and decode it
//! (`crates/vmm/src/arch/insn.rs`). With the MMU on (`guest::mmu`), the PC and the base register
//! are *virtual* addresses, so the VMM must also walk this guest's page tables
//! (`crates/vmm/src/arch/stage1_walk.rs`).
//!
//! **The 16 checks.** Every value is read back with plain `ldr`/`str` (ISV = 1, already proven
//! by `mmio-probe`), and every writeback is compared with the expected base:
//!
//! | # | Instruction | Checks |
//! |---|---|---|
//! | 1, 2 | `stp x` / `ldp x`, offset | both elements |
//! | 3, 4 | `stp w` / `ldp w`, offset | both elements, upper halves zero |
//! | 5 | `ldpsw`, offset | sign extension of both |
//! | 6, 7 | `stp x` pre-index / `ldp x` post-index | values and base writeback |
//! | 8, 9 | `stp w` post-index / `ldp w` pre-index | values and base writeback |
//! | 10 | `ldpsw` pre-index | sign extension and writeback |
//! | 11 | `str x` pre-index (one register, writeback) | value and writeback |
//! | 12 | `ldrsh x` post-index | sign extension and writeback |
//! | 13 | `ldp x` through `mmu::TESTDEV_ALIAS` | the VMM walked the tables for the data address (VA ≠ IPA) |
//! | 14 | `stp x, [sp, #-16]!` at EL1t | Rn = 31 is SP_EL0 there, written back |
//! | 15 | `ldp x, [sp], #16` at EL1h | Rn = 31 is SP_EL1 there (the live stack pointer), written back |
//! | 16 | `ldp x` run from `mmu::CODE_ALIAS` | the VMM walked the tables for the PC: its identity IPA is not RAM |
//!
//! Then `str q0` (a SIMD store, which the VMM must not emulate, MMIO-6) must arrive as a
//! synchronous external abort: `ESR_EL1.EC = 0x25`, DFSC `0x10`, `WnR = 1`, `FAR_EL1` = the
//! address, and the device register unchanged.
#![no_std]
#![no_main]

use core::arch::asm;
use core::sync::atomic::{AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_sync_hook};
use guest::mmu::{self, TESTDEV, TESTDEV_ALIAS, code_alias};
use guest::println;

guest::entry!(main);

/// Plain 8-byte store (ISV = 1).
fn put(off: u64, v: u64) {
    let a = TESTDEV + off;
    // SAFETY: an aligned store to the emulated test device (Device memory); it only traps.
    unsafe { asm!("str {v}, [{a}]", v = in(reg) v, a = in(reg) a, options(nostack)) };
}

/// Plain 8-byte load (ISV = 1).
fn get(off: u64) -> u64 {
    let a = TESTDEV + off;
    let v: u64;
    // SAFETY: an aligned load from the emulated test device; it only traps.
    unsafe { asm!("ldr {v}, [{a}]", v = out(reg) v, a = in(reg) a, options(nostack)) };
    v
}

/// Plain 4-byte load (ISV = 1), zero-extended.
fn get_w(off: u64) -> u64 {
    let a = TESTDEV + off;
    let v: u64;
    // SAFETY: as `get`.
    unsafe { asm!("ldr {v:w}, [{a}]", v = out(reg) v, a = in(reg) a, options(nostack)) };
    v
}

fn check(ok: &mut u32, name: &str, got: &[u64], want: &[u64]) {
    if got == want {
        *ok += 1;
        println!("isv0-probe: {name} ok");
    } else {
        println!("isv0-probe: FAILED: {name}: got {got:x?}, want {want:x?}");
    }
}

/// `asm!` for a pair/writeback instruction with base `b` (in/out), `r1`, `r2` (in/out).
macro_rules! pair {
    ($insn:literal, $b:expr, $r1:expr, $r2:expr) => {{
        let mut b: u64 = $b;
        let mut r1: u64 = $r1;
        let mut r2: u64 = $r2;
        // SAFETY: the base points at the test device (or its alias); the instruction only
        // traps to the VMM, which emulates it. No guest RAM is touched.
        unsafe {
            asm!("// operands {r1} {r2}", $insn, b = inout(reg) b, r1 = inout(reg) r1, r2 = inout(reg) r2,
                 options(nostack))
        };
        (b, r1, r2)
    }};
}

/// The SIMD-store abort, as the hook saw it: ESR and FAR (0 = not taken).
static ABORT_ESR: AtomicU64 = AtomicU64::new(0);
static ABORT_FAR: AtomicU64 = AtomicU64::new(0);

/// Catch a synchronous external data abort at the current EL (EC 0x25, DFSC 0x10) and step
/// over the instruction; anything else is reported by the vector table.
fn abort_hook(f: &mut ExceptionFrame) -> bool {
    if f.ec() != 0x25 || f.esr & 0x3f != 0x10 {
        return false;
    }
    ABORT_ESR.store(f.esr, Ordering::SeqCst);
    ABORT_FAR.store(f.far, Ordering::SeqCst);
    f.elr += 4;
    true
}

fn main(_x0: u64) {
    mmu::enable();
    if !mmu::enabled() {
        println!("isv0-probe: FAILED: SCTLR_EL1.M is still 0");
        return;
    }
    println!("isv0-probe: mmu on");
    let t = TESTDEV;
    let mut ok = 0u32;
    let (x1, x2) = (0x1111_2222_3333_4444u64, 0x5555_6666_7777_8888u64);

    // 1, 2: X pair, offset.
    pair!("stp {r1}, {r2}, [{b}]", t, x1, x2);
    check(&mut ok, "stp x", &[get(0), get(8)], &[x1, x2]);
    put(0x10, 0xa1);
    put(0x18, 0xa2);
    let (_, a, b) = pair!("ldp {r1}, {r2}, [{b}, #16]", t, 0, 0);
    check(&mut ok, "ldp x", &[a, b], &[0xa1, 0xa2]);

    // 3, 4: W pair, offset (one 8-byte register holds both lanes).
    put(0x20, 0);
    pair!(
        "stp {r1:w}, {r2:w}, [{b}, #32]",
        t,
        0xdead_beef_0bad_f00d,
        0x1234_5678
    );
    check(&mut ok, "stp w", &[get(0x20)], &[0x1234_5678_0bad_f00d]);
    put(0x28, 0x8765_4321_cafe_babe);
    let (_, a, b) = pair!("ldp {r1:w}, {r2:w}, [{b}, #40]", t, u64::MAX, u64::MAX);
    check(&mut ok, "ldp w", &[a, b], &[0xcafe_babe, 0x8765_4321]);

    // 5: LDPSW, offset.
    put(0x30, 0x7fff_ffff_8000_0001);
    let (_, a, b) = pair!("ldpsw {r1}, {r2}, [{b}, #48]", t, 0, 0);
    check(
        &mut ok,
        "ldpsw",
        &[a, b],
        &[0xffff_ffff_8000_0001, 0x7fff_ffff],
    );

    // 6: X pair, pre-index store.
    let (nb, _, _) = pair!("stp {r1}, {r2}, [{b}, #0x40]!", t, x2, x1);
    check(
        &mut ok,
        "stp x pre-index",
        &[get(0x40), get(0x48), nb],
        &[x2, x1, t + 0x40],
    );

    // 7: X pair, post-index load.
    put(0x50, 0xb1);
    put(0x58, 0xb2);
    let (nb, a, b) = pair!("ldp {r1}, {r2}, [{b}], #-16", t + 0x50, 0, 0);
    check(
        &mut ok,
        "ldp x post-index",
        &[a, b, nb],
        &[0xb1, 0xb2, t + 0x40],
    );

    // 8: W pair, post-index store.
    let (nb, _, _) = pair!("stp {r1:w}, {r2:w}, [{b}], #8", t + 0x60, 0xc1, 0xc2);
    check(
        &mut ok,
        "stp w post-index",
        &[get_w(0x60), get_w(0x64), nb],
        &[0xc1, 0xc2, t + 0x68],
    );

    // 9: W pair, pre-index load.
    put(0x70, 0xd2_0000_00d1);
    let (nb, a, b) = pair!("ldp {r1:w}, {r2:w}, [{b}, #8]!", t + 0x68, 0, 0);
    check(
        &mut ok,
        "ldp w pre-index",
        &[a, b, nb],
        &[0xd1, 0xd2, t + 0x70],
    );

    // 10: LDPSW, pre-index.
    put(0x80, 0x8000_0000_ffff_fffe);
    let (nb, a, b) = pair!("ldpsw {r1}, {r2}, [{b}, #-8]!", t + 0x88, 0, 0);
    check(
        &mut ok,
        "ldpsw pre-index",
        &[a, b, nb],
        &[u64::MAX - 1, 0xffff_ffff_8000_0000, t + 0x80],
    );

    // 11: one register, pre-index store.
    let (nb, _, _) = pair!("str {r1}, [{b}, #8]!", t + 0x88, 0xe1e2_e3e4_e5e6_e7e8, 0);
    check(
        &mut ok,
        "str x pre-index",
        &[get(0x90), nb],
        &[0xe1e2_e3e4_e5e6_e7e8, t + 0x90],
    );

    // 12: one register, sign-extending post-index load.
    put(0x98, 0x8001);
    let (nb, a, _) = pair!("ldrsh {r1}, [{b}], #2", t + 0x98, 0, 0);
    check(
        &mut ok,
        "ldrsh x post-index",
        &[a, nb],
        &[0xffff_ffff_ffff_8001, t + 0x9a],
    );

    // 13: through the alias VA: the exit IPA is the testdev's, the base register is not.
    put(0xa0, 0xf1);
    put(0xa8, 0xf2);
    let (_, a, b) = pair!("ldp {r1}, {r2}, [{b}, #0xa0]", TESTDEV_ALIAS, 0, 0);
    check(&mut ok, "ldp x via stage-1 alias", &[a, b], &[0xf1, 0xf2]);

    // 14: SP as the base, at EL1t (SP_EL0), pre-index. An exception taken meanwhile would
    // switch to SP_EL1, the real stack, so nothing is pushed to the device.
    let mut nb: u64 = t + 0xc0;
    // SAFETY: SP_EL0 is pointed at the test device only for one trapping `stp` with interrupts
    // masked (DAIF from boot); SP_EL0 and SPSel are restored before any Rust code runs.
    unsafe {
        asm!(
            "msr spsel, #0",
            "mov x9, sp",
            "mov sp, {b}",
            "stp {r1}, {r2}, [sp, #-16]!",
            "mov {b}, sp",
            "mov sp, x9",
            "msr spsel, #1",
            b = inout(reg) nb,
            r1 = in(reg) 0x5151u64,
            r2 = in(reg) 0x5252u64,
            out("x9") _,
        )
    };
    check(
        &mut ok,
        "stp x [sp]! at EL1t",
        &[get(0xb0), get(0xb8), nb],
        &[0x5151, 0x5252, t + 0xb0],
    );

    // 15: SP as the base at EL1h, where Rn = 31 is SP_EL1, the stack this code runs on: the
    // VMM must read and write the live SP_EL1 (HV_SYS_REG_SP_EL1), not a stale banked copy.
    put(0xd0, 0x6161);
    put(0xd8, 0x6262);
    let mut nb: u64 = t + 0xd0;
    let (a, b): (u64, u64);
    // SAFETY: SP_EL1 is pointed at the test device only for one trapping `ldp` with interrupts
    // masked (DAIF from boot), and restored from `tmp` before any Rust code runs. Nothing is
    // pushed meanwhile: an exception would be a failure anyway, reported by the VMM.
    unsafe {
        asm!(
            "mov {tmp}, sp",
            "mov sp, {b}",
            "ldp {r1}, {r2}, [sp], #16",
            "mov {b}, sp",
            "mov sp, {tmp}",
            b = inout(reg) nb,
            r1 = out(reg) a,
            r2 = out(reg) b,
            tmp = out(reg) _,
        )
    };
    check(
        &mut ok,
        "ldp x [sp], #16 at EL1h",
        &[a, b, nb],
        &[0x6161, 0x6262, t + 0xe0],
    );

    // 16: the faulting instruction runs from `mmu::CODE_ALIAS`, so the PC the VMM sees is a VA
    // whose identity IPA (0x8000_0000 + ...) is not RAM. Only a VMM that walks the tables for
    // the PC finds the `ldp`.
    put(0xe0, 0x7171);
    put(0xe8, 0x7272);
    let (a, b): (u64, u64);
    // SAFETY: `blr` jumps to the alias VA of the two-instruction stub at `1:` (same bytes,
    // executable Normal memory, mmu.rs), which loads from the test device and returns to the
    // `b 2f` after the `blr`. x30 is declared clobbered; the stub touches only its operands.
    unsafe {
        asm!(
            "adr {tmp}, 1f",
            "sub {tmp}, {tmp}, {ram}",
            "add {tmp}, {tmp}, {alias}",
            "blr {tmp}",
            "b 2f",
            "1:",
            "ldp {r1}, {r2}, [{b}]",
            "ret",
            "2:",
            b = in(reg) t + 0xe0,
            r1 = out(reg) a,
            r2 = out(reg) b,
            tmp = out(reg) _,
            ram = in(reg) 0x4000_0000u64,
            alias = in(reg) code_alias(0x4000_0000),
            out("x30") _,
            options(nostack),
        )
    };
    check(
        &mut ok,
        "ldp x with pc via stage-1 code alias",
        &[a, b],
        &[0x7171, 0x7272],
    );

    println!("isv0-probe: {ok}/16 ok");

    // A SIMD store is never emulated: a synchronous external abort, nothing written.
    put(0x100, 0x0123);
    set_sync_hook(Some(abort_hook));
    let a = t + 0x100;
    // SAFETY: `a` is the test device; the store traps and comes back as an abort that
    // `abort_hook` steps over. v0 is declared clobbered.
    unsafe {
        asm!("movi v0.16b, #0x5a", "str q0, [{a}]", a = in(reg) a, out("v0") _,
             options(nostack))
    };
    set_sync_hook(None);
    let (esr, far) = (
        ABORT_ESR.load(Ordering::SeqCst),
        ABORT_FAR.load(Ordering::SeqCst),
    );
    let wnr = esr & (1 << 6) != 0;
    if esr != 0 && wnr && far == a && get(0x100) == 0x0123 {
        println!("isv0-probe: simd store -> sync external abort ok");
    } else {
        println!(
            "isv0-probe: FAILED: simd store: esr {esr:#x} far {far:#x} value {:#x}",
            get(0x100)
        );
    }
}
