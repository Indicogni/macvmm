//! `mmio-probe`: ten MMIO checks against the scratch-register test device (course ch07, PLAN
//! M4). Run with `--testdev`, which maps 512 × u64 registers at `0x0b00_0000` whose reads
//! return the last value written at that offset, truncated to the access size.
//!
//! Every access is written in assembly, so the instruction (and therefore the syndrome the
//! VMM decodes: SAS, SSE, SRT, SF, WnR) is exactly the one named:
//!
//! | # | Check | What a wrong VMM does |
//! |---|---|---|
//! | 1–4 | `strb`/`strh`/`str w`/`str x` then the matching load at offset 0 | wrong size → wrong value |
//! | 5 | `strb` from a register with garbage above byte 0 | no write mask → upper bytes clobbered |
//! | 6 | `str xzr` over a non-zero register | SRT 31 passed to `hv_vcpu_get_reg` reads `HV_REG_PC` (31 in `hv_reg_t`) → the PC is stored, not 0 |
//! | 7 | `ldr xzr` of `0x1111` | SRT 31 passed to `hv_vcpu_set_reg` writes `HV_REG_PC` → the guest jumps to `0x1111` and dies on an instruction abort |
//! | 8 | `ldrsb w` of `0x80` | no sign extension, or 64-bit extension into a W register |
//! | 9 | `ldrsh x` of `0x8001` | no sign extension |
//! | 10 | `ldrsw x` of `0x8000_0000` | no sign extension |
//!
//! Rows 6 and 7 are HVF-specific: in `hv_reg_t` (SDK `hv_vcpu_types.h`) 0..=30 are X0..X30 and
//! **31 is `HV_REG_PC`**, so an unmasked SRT never reaches SP or x30. The VMM maps SRT 31 to
//! XZR in `hvf::Reg::x` (`Reg::x(31) == None`, host-tested in `hvf::regs::tests`). Check 7 also
//! compares SP before and after, which catches a VMM that maps 31 to SP instead.
//!
//! The run's trace (`--trace exits:F:mmio`) shows the decode: `mmio-probe.trace.txt` checks the
//! 1-, 2-, 4- and 8-byte stores at `"ipa":"0xb000000"`, the `"reg":31` store of `"value":"0x0"`
//! and the `ldrsh` load of `0xffffffffffff8001`.
#![no_std]
#![no_main]

use core::arch::asm;
use guest::println;

guest::entry!(main);

/// The test device (PLAN §1 `testdev` row).
const TESTDEV: u64 = 0x0b00_0000;

macro_rules! store {
    ($insn:literal, $off:expr, $v:expr) => {{
        let a: u64 = TESTDEV + $off;
        let v: u64 = $v;
        // SAFETY: an aligned store to the emulated test device (not RAM); it only traps.
        unsafe { asm!($insn, v = in(reg) v, a = in(reg) a, options(nostack)) };
    }};
}

macro_rules! load {
    ($insn:literal, $off:expr) => {{
        let a: u64 = TESTDEV + $off;
        let r: u64;
        // SAFETY: an aligned load from the emulated test device (not RAM); it only traps.
        unsafe { asm!($insn, r = out(reg) r, a = in(reg) a, options(nostack)) };
        r
    }};
}

fn sp() -> u64 {
    let v: u64;
    // SAFETY: copies SP to a register; no memory access.
    unsafe { asm!("mov {}, sp", out(reg) v, options(nomem, nostack)) };
    v
}

fn check(passed: &mut u32, name: &str, got: u64, want: u64) {
    if got == want {
        *passed += 1;
        println!("mmio-probe: {name} ok");
    } else {
        println!("mmio-probe: FAILED: {name}: got {got:#x}, want {want:#x}");
    }
}

fn main(_x0: u64) {
    let mut ok = 0u32;

    store!("strb {v:w}, [{a}]", 0, 0x5a);
    check(&mut ok, "strb/ldrb", load!("ldrb {r:w}, [{a}]", 0), 0x5a);
    store!("strh {v:w}, [{a}]", 0, 0xbeef);
    check(&mut ok, "strh/ldrh", load!("ldrh {r:w}, [{a}]", 0), 0xbeef);
    store!("str {v:w}, [{a}]", 0, 0xdead_beef);
    check(&mut ok, "str w/ldr w", load!("ldr {r:w}, [{a}]", 0), 0xdead_beef);
    store!("str {v}, [{a}]", 0, 0x0123_4567_89ab_cdef);
    check(&mut ok, "str x/ldr x", load!("ldr {r}, [{a}]", 0), 0x0123_4567_89ab_cdef);

    store!("str {v}, [{a}]", 8, u64::MAX);
    store!("strb {v:w}, [{a}]", 8, 0x1234_5678_9abc_de42);
    check(&mut ok, "write masked to 1 byte", load!("ldr {r}, [{a}]", 8), 0xffff_ffff_ffff_ff42);

    store!("str {v}, [{a}]", 16, u64::MAX);
    {
        let a: u64 = TESTDEV + 16;
        // SAFETY: as `store!`: an aligned store of XZR (SRT = 31) to the test device.
        unsafe { asm!("str xzr, [{a}]", a = in(reg) a, options(nostack)) };
    }
    check(&mut ok, "str xzr stores 0", load!("ldr {r}, [{a}]", 16), 0);

    store!("str {v}, [{a}]", 24, 0x1111);
    let before = sp();
    {
        let a: u64 = TESTDEV + 24;
        // SAFETY: as `load!`: an aligned load into XZR (SRT = 31), whose result is discarded.
        unsafe { asm!("ldr xzr, [{a}]", a = in(reg) a, options(nostack)) };
    }
    // A VMM that writes the loaded 0x1111 into register 31 sets HV_REG_PC: execution never
    // reaches this check (fatal instruction abort at 0x1111). SP is compared for a VMM that
    // maps 31 to SP instead.
    check(&mut ok, "ldr xzr discarded (sp kept)", sp(), before);

    store!("strb {v:w}, [{a}]", 32, 0x80);
    check(&mut ok, "ldrsb w sign-extends to 32", load!("ldrsb {r:w}, [{a}]", 32), 0xffff_ff80);
    store!("strh {v:w}, [{a}]", 40, 0x8001);
    check(&mut ok, "ldrsh x sign-extends to 64", load!("ldrsh {r}, [{a}]", 40), 0xffff_ffff_ffff_8001);
    store!("str {v:w}, [{a}]", 48, 0x8000_0000);
    check(&mut ok, "ldrsw x sign-extends to 64", load!("ldrsw {r}, [{a}]", 48), 0xffff_ffff_8000_0000);

    println!("mmio-probe: {ok}/10 ok");
}
