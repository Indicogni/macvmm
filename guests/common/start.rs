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
//! 3. CPU 0 zeroes the BSS (Rust assumes zero-initialised statics are zero). Any other CPU
//!    that somehow enters `_start` parks: secondaries come in through `_secondary_start`.
//! 4. Installs the vector table from `exceptions.rs` in `VBAR_EL1`, so any fault prints a
//!    message instead of jumping through an uninitialised vector.
//! 5. Calls the guest's `guest_main(x0)` (defined by [`crate::entry!`]) with the untouched
//!    boot argument, then `guest_power_off()` (PSCI SYSTEM_OFF) if it returns.
//!
//! **`_secondary_start` (M16): the PSCI CPU_ON entry.** A secondary CPU is started by another
//! CPU's `CPU_ON(target, entry = _secondary_start, context_id)` (Arm DEN 0022 §5.1.4). PSCI
//! promises it the same state as a cold boot, except that `x0 = context_id`: EL1h, DAIF
//! masked, MMU and caches off (architecture §8.6). So it repeats the per-CPU half of `_start`:
//! 1. picks its own 64 KiB stack by its **linear index** `Aff1 × 16 + Aff0` (the VMM's
//!    `mpidr_for(i)` puts 16 CPUs per cluster, architecture §8.1); index ≥ 8 parks, because the
//!    linker script has eight stacks;
//! 2. enables FP/SIMD (`CPACR_EL1` is per CPU) and installs the vectors (`VBAR_EL1` is per
//!    CPU);
//! 3. does **not** touch the BSS: CPU 0 zeroed it long before, and other CPUs' data lives there;
//! 4. calls [`guest_secondary_main`] with `x0` = the context, which jumps to the function the
//!    guest registered with [`set_secondary_entry`]; when it returns the CPU calls PSCI
//!    CPU_OFF (so it can be started again) and parks if that fails.
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

// ANCHOR: guest_secondary_start_asm
global_asm!(
    r#"
    .section .text.boot, "ax"
    .global _secondary_start
_secondary_start:
    mrs     x9, mpidr_el1
    and     x10, x9, #0xff
    ubfx    x11, x9, #8, #8
    add     x9, x10, x11, lsl #4
    cmp     x9, #8
    b.hs    .Lsecondary_park
    adrp    x10, __stacks_start
    add     x10, x10, :lo12:__stacks_start
    add     x11, x9, #1
    lsl     x11, x11, #16
    add     x10, x10, x11
    mov     sp, x10
    mov     x10, #(3 << 20)
    msr     cpacr_el1, x10
    adrp    x10, guest_vectors
    add     x10, x10, :lo12:guest_vectors
    msr     vbar_el1, x10
    isb
    bl      guest_secondary_main
.Lsecondary_park:
    wfe
    b       .Lsecondary_park
"#
);
// ANCHOR_END: guest_secondary_start_asm

use core::sync::atomic::{AtomicUsize, Ordering};

/// The function a secondary CPU runs (0 = none registered: the CPU turns itself off).
static SECONDARY_ENTRY: AtomicUsize = AtomicUsize::new(0);

unsafe extern "C" {
    /// The PSCI CPU_ON entry point (above). Never called from Rust: only its address is used.
    fn _secondary_start();
}

/// Register the function every secondary CPU runs with its CPU_ON `context_id`. Call it on
/// CPU 0 before the first CPU_ON. A plain store: with the MMU off an atomic read-modify-write
/// would fault (guest `hostile.rs` module docs), and only CPU 0 writes it.
pub fn set_secondary_entry(f: fn(u64)) {
    SECONDARY_ENTRY.store(f as usize, Ordering::SeqCst);
}

/// The address to pass as CPU_ON's `entry_point_address`.
pub fn secondary_entry_point() -> u64 {
    _secondary_start as *const () as usize as u64
}

/// The linear CPU index `Aff1 × 16 + Aff0` of the calling CPU (`_secondary_start`'s stack
/// index; the VMM's vCPU index).
pub fn cpu_index() -> u64 {
    let m: u64;
    // SAFETY: reads an ID register; no memory access, no side effects.
    unsafe { core::arch::asm!("mrs {}, mpidr_el1", out(reg) m, options(nomem, nostack)) };
    (m & 0xff) + ((m >> 8) & 0xff) * 16
}

/// Called by `_secondary_start` with the CPU_ON context in `x0`: run the registered function,
/// then PSCI CPU_OFF (DEN 0022 §5.1.3), which does not return on success.
#[unsafe(no_mangle)]
pub extern "C" fn guest_secondary_main(ctx: u64) {
    let f = SECONDARY_ENTRY.load(Ordering::SeqCst);
    if f != 0 {
        // SAFETY: the only non-zero value ever stored is a `fn(u64)` cast to `usize` by
        // `set_secondary_entry`; function pointers and `usize` have the same size here.
        let f: fn(u64) = unsafe { core::mem::transmute::<usize, fn(u64)>(f) };
        f(ctx);
    }
    crate::psci::cpu_off();
}

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
