//! The guest entry point, `_start`: from "the vCPU's PC is our first byte" to Rust.
//!
//! **What the VMM gives us** (architecture §6.5, §8.1): EL1h (`CPSR = 0x3c5`, so SP is
//! SP_EL1 and D, A, I, F are masked), the MMU and caches off (`SCTLR_EL1.M = C = I = 0`),
//! `PC` = our load address, and `x0` = the boot argument (the DTB address on a Linux-style
//! boot; Linux `Documentation/arch/arm64/booting.rst` §4). Nothing else is initialised for us:
//! no stack, no zeroed BSS, no exception vectors, FP/SIMD possibly trapped.
//!
//! **What `_start` does, in order:**
//! 1. Reads `MPIDR_EL1.Aff0` (bits [7:0]; ARM ARM, MPIDR_EL1 register description) to pick
//!    one of eight 64 KiB stacks from the linker script. CPUs with Aff0 ≥ 8 park.
//! 2. Enables FP/SIMD at EL1 (`CPACR_EL1.FPEN = 0b11`, bits [21:20]; ARM ARM, CPACR_EL1
//!    register description). The `aarch64-unknown-none` target lets the compiler use NEON
//!    registers in ordinary code (for example in `core::fmt`), and with FPEN = 0 the first such
//!    instruction would trap with EC 0x07.
//! 3. CPU 0 zeroes the BSS (Rust assumes zero-initialised statics are zero). Secondary CPUs
//!    park here; `_secondary_start`, the PSCI CPU_ON entry, is reserved for M16.
//! 4. Installs the vector table from `exceptions.rs` in `VBAR_EL1`, so any fault prints a
//!    message instead of jumping through an uninitialised vector.
//! 5. Calls the guest's `guest_main(x0)` (defined by [`crate::entry!`]) with the untouched
//!    boot argument, then `guest_power_off()` (PSCI SYSTEM_OFF) if it returns.
//!
//! Every address is formed with `adrp`/`add :lo12:` (PC-relative), which is correct whatever
//! the VMM did, and needs no relocation processing. The BSS loop uses 8-byte aligned stores
//! only, because with the MMU off an unaligned access faults (guests/.cargo/config.toml).

use core::arch::global_asm;

// ANCHOR: guest_start_asm
global_asm!(
    r#"
    .section .text.boot, "ax"
    .global _start
_start:
    mrs     x9, mpidr_el1
    and     x9, x9, #0xff
    cmp     x9, #8
    b.hs    .Lpark
    adrp    x10, __stacks_start
    add     x10, x10, :lo12:__stacks_start
    add     x11, x9, #1
    lsl     x11, x11, #16
    add     x10, x10, x11
    mov     sp, x10
    mov     x10, #(3 << 20)
    msr     cpacr_el1, x10
    isb
    cbnz    x9, .Lpark
    adrp    x10, __bss_start
    add     x10, x10, :lo12:__bss_start
    adrp    x11, __bss_end
    add     x11, x11, :lo12:__bss_end
1:  cmp     x10, x11
    b.hs    2f
    str     xzr, [x10], #8
    b       1b
2:  adrp    x10, guest_vectors
    add     x10, x10, :lo12:guest_vectors
    msr     vbar_el1, x10
    isb
    bl      guest_main
    bl      guest_power_off
.Lpark:
    wfe
    b       .Lpark
"#
);
// ANCHOR_END: guest_start_asm

/// Called by `_start` when `guest_main` returns: a clean PSCI SYSTEM_OFF (exit code 0).
#[unsafe(no_mangle)]
pub extern "C" fn guest_power_off() -> ! {
    crate::psci::power_off()
}

/// Define the guest's entry function: `guest::entry!(main);` with `fn main(x0: u64)`.
///
/// `_start` calls the symbol `guest_main` with the boot argument in `x0` (AAPCS64: the first
/// integer argument). The macro gives each guest binary exactly one such symbol, so the
/// assembly never depends on the name a guest chose.
#[macro_export]
macro_rules! entry {
    ($main:path) => {
        /// The symbol `_start` branches to (common/start.rs).
        #[unsafe(no_mangle)]
        pub extern "C" fn guest_main(x0: u64) {
            let f: fn(u64) = $main;
            f(x0)
        }
    };
}
