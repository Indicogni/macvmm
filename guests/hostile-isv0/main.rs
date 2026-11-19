//! `hostile-isv0`: TEST-7 phase 2, ISV = 0 garbage (threat model §9.4, MMIO-4, MMIO-6; PLAN
//! M17). Run with `--testdev`. The VMM must refuse every access below with a synchronous
//! external abort *in the guest* (ESR_EL1.EC 0x25, DFSC 0x10), never emulate part of one, and
//! never stop: the guest counts the aborts and exits 0.
//!
//! | # | Access | Why the VMM must refuse |
//! |---|---|---|
//! | 1–3 | `stp x`, `ldp x`, `stp w` at the last element of the testdev window (MMU off) | the second element is outside the device: a pair is only emulated inside one window |
//! | 4, 5 | `stp x`, `ldp x` at the end of `mmu::TESTDEV_ALIAS` (MMU on) | the second element's VA maps to the **PL011**: a confused deputy (F17) if the VMM followed the exit IPA + 8 or the decoded VA blindly |
//! | 6–12 | `str q0`, `str d0`, `str s0`, `stp q0, q1`, `st1 {v0.16b}`, `ldr q0`, and `stp d0, d1` through the alias | SIMD/FP registers are not in the VMM's register file (MMIO-6) |
//!
//! After the aborts it checks that no device register changed (a store pair never
//! half-happens) and that the loads left their destination registers alone.
#![no_std]
#![no_main]

use core::arch::asm;
use core::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_sync_hook};
use guest::mmu::{self, TESTDEV, TESTDEV_ALIAS};
use guest::println;

guest::entry!(main);

const CASES: u32 = 12;
const SENTINEL: u64 = 0x5e5e_5e5e_5e5e_5e5e;

static ABORTS: AtomicU32 = AtomicU32::new(0);
static LAST_FAR: AtomicU64 = AtomicU64::new(0);
static LAST_ESR: AtomicU64 = AtomicU64::new(0);

/// Count a synchronous external data abort at the current EL and step over the instruction.
fn abort_hook(f: &mut ExceptionFrame) -> bool {
    if f.ec() != 0x25 || f.esr & 0x3f != 0x10 {
        return false;
    }
    // A plain load and store, not `fetch_add`: with the MMU off RAM is Device memory, where an
    // atomic read-modify-write takes an "unsupported atomic access" fault (DFSC 0x35). One CPU.
    ABORTS.store(
        ABORTS.load(Ordering::SeqCst).wrapping_add(1),
        Ordering::SeqCst,
    );
    LAST_FAR.store(f.far, Ordering::SeqCst);
    LAST_ESR.store(f.esr, Ordering::SeqCst);
    f.elr += 4;
    true
}

fn put(off: u64, v: u64) {
    let a = TESTDEV + off;
    // SAFETY: an aligned store to the emulated test device; it only traps.
    unsafe { asm!("str {v}, [{a}]", v = in(reg) v, a = in(reg) a, options(nostack)) };
}

fn get(off: u64) -> u64 {
    let a = TESTDEV + off;
    let v: u64;
    // SAFETY: an aligned load from the emulated test device; it only traps.
    unsafe { asm!("ldr {v}, [{a}]", v = out(reg) v, a = in(reg) a, options(nostack)) };
    v
}

/// One refused access: run `$insn` with base `a` and two GPRs, expect exactly one more abort
/// whose FAR lies in `[a, a + 32)` and whose WnR is `$write`. Returns the GPRs after it.
macro_rules! refused {
    ($fails:ident, $name:literal, $write:expr, $a:expr, $insn:literal) => {{
        let before = ABORTS.load(Ordering::SeqCst);
        let a: u64 = $a;
        let mut r1: u64 = 0x1111;
        let mut r2: u64 = 0x2222;
        // SAFETY: `a` is the test device or its alias pages (Device memory): the access traps
        // to the VMM, which injects an abort that `abort_hook` steps over. v0/v1 are clobbered.
        unsafe {
            asm!("// operands {r1} {r2}", "movi v0.16b, #0x77", "movi v1.16b, #0x66", $insn,
                 a = in(reg) a, r1 = inout(reg) r1, r2 = inout(reg) r2,
                 out("v0") _, out("v1") _, options(nostack))
        };
        let far = LAST_FAR.load(Ordering::SeqCst);
        let wnr = LAST_ESR.load(Ordering::SeqCst) & (1 << 6) != 0;
        let n = ABORTS.load(Ordering::SeqCst).wrapping_sub(before);
        if n != 1 || far.wrapping_sub(a) >= 32 || wnr != $write {
            $fails += 1;
            println!("hostile-isv0: FAILED: {}: {n} aborts, far {far:#x}, wnr {wnr}", $name);
        }
        (r1, r2)
    }};
}

fn main(_x0: u64) {
    let t = TESTDEV;
    let mut fails = 0u32;
    for off in [0xfe8, 0xff0, 0xff8] {
        put(off, SENTINEL);
    }
    set_sync_hook(Some(abort_hook));

    // 1-3: a pair that runs off the end of the testdev window (MMU off: VA = IPA).
    refused!(
        fails,
        "stp x across window end",
        true,
        t + 0xff8,
        "stp {r1}, {r2}, [{a}]"
    );
    let lp = refused!(
        fails,
        "ldp x across window end",
        false,
        t + 0xff8,
        "ldp {r1}, {r2}, [{a}]"
    );
    if lp != (0x1111, 0x2222) {
        fails += 1;
        println!("hostile-isv0: FAILED: refused ldp changed registers: {lp:x?}");
    }
    refused!(
        fails,
        "stp w across window end",
        true,
        t + 0xffc,
        "stp {r1:w}, {r2:w}, [{a}]"
    );

    // 4, 5: with the MMU on, the second element's page is the PL011 (F17).
    mmu::enable();
    let edge = TESTDEV_ALIAS + 0xff8;
    refused!(
        fails,
        "stp x into another device",
        true,
        edge,
        "stp {r1}, {r2}, [{a}]"
    );
    let lp = refused!(
        fails,
        "ldp x from another device",
        false,
        edge,
        "ldp {r1}, {r2}, [{a}]"
    );
    if lp != (0x1111, 0x2222) {
        fails += 1;
        println!("hostile-isv0: FAILED: refused ldp changed registers: {lp:x?}");
    }

    // 6-12: SIMD/FP loads and stores.
    refused!(fails, "str q0", true, t + 0xfe0, "str q0, [{a}]");
    refused!(fails, "str d0", true, t + 0xfe8, "str d0, [{a}]");
    refused!(fails, "str s0", true, t + 0xff0, "str s0, [{a}]");
    refused!(fails, "stp q0, q1", true, t + 0xfe0, "stp q0, q1, [{a}]");
    refused!(
        fails,
        "st1 {v0.16b}",
        true,
        t + 0xfe0,
        "st1 {{v0.16b}}, [{a}]"
    );
    refused!(fails, "ldr q0", false, t + 0xfe0, "ldr q0, [{a}]");
    refused!(
        fails,
        "stp d0, d1 via alias",
        true,
        TESTDEV_ALIAS + 0xfe8,
        "stp d0, d1, [{a}]"
    );

    set_sync_hook(None);
    let n = ABORTS.load(Ordering::SeqCst);
    println!("hostile-isv0: {n}/{CASES} external aborts");
    let intact = [0xfe8, 0xff0, 0xff8].iter().all(|&o| get(o) == SENTINEL);
    if intact {
        println!("hostile-isv0: device state intact");
    } else {
        fails += 1;
        println!(
            "hostile-isv0: FAILED: device changed: {:#x} {:#x} {:#x}",
            get(0xfe8),
            get(0xff0),
            get(0xff8)
        );
    }
    if n == CASES && fails == 0 {
        println!("hostile-isv0: phase 2 ok");
    }
}
