//! `guest`: the shared library of the bare-metal test guests (architecture §3, PLAN M3).
//!
//! A test guest is a tiny `no_std` program that the VMM loads at `0x4008_0000` (as an ELF with
//! `--kernel` or as a flat binary with `--raw`) and that proves one thing about the VMM by
//! printing markers the e2e harness matches (`<guest-name>: <message>`, PLAN §0.3). This crate
//! is everything they share:
//!
//! - [`start`]: `_start` (stack, FP enable, BSS, vectors) and the [`entry!`] macro;
//! - [`hvc`]: the macvmm debug hypercalls (DEBUG_PUTC, DEBUG_EXIT, DEBUG_MEMHASH, BOOT_COUNT);
//! - [`psci`]: every SMCCC/PSCI call of the VMM table (VERSION .. SYSTEM_RESET, M5);
//! - [`console`]: `print!`/`println!` over DEBUG_PUTC (or the PL011 from M6);
//! - [`uart`]: the polled PL011 (RX and TX) and the PL031 clock (M6);
//! - [`fdt`]: a bounds-checked reader for the device tree passed in `x0` (M7);
//! - [`mmu`]: a 4 KiB identity map with two alias pages, to run with the MMU on (M17);
//! - [`exceptions`]: the full 16-entry vector table: hooks to catch a synchronous exception
//!   and resume, otherwise report it and stop the VM (M4), and an IRQ hook (M8);
//! - [`gic`]: GICv3 bring-up (distributor, redistributor by affinity, CPU interface) (M8);
//! - [`timer`]: the EL1 virtual timer and an IRQ-window `wfi` (M8).
//!
//! **Panics** print `guest panic: <message>` and call `DEBUG_EXIT(1)`, so macvmm exits 6 and
//! the harness shows why. `unsafe` is allowed in guests (architecture §4), but every block has
//! a `// SAFETY:` comment like the VMM's.
#![no_std]

pub mod console;
pub mod exceptions;
pub mod fdt;
pub mod gic;
pub mod hvc;
pub mod mmu;
pub mod psci;
pub mod start;
pub mod timer;
pub mod uart;

#[panic_handler]
fn panic(info: &core::panic::PanicInfo<'_>) -> ! {
    match info.location() {
        Some(loc) => println!(
            "guest panic: {} at {}:{}",
            info.message(),
            loc.file(),
            loc.line()
        ),
        None => println!("guest panic: {}", info.message()),
    }
    hvc::debug_exit(1)
}

/// Read the virtual counter `CNTVCT_EL0` (ARM ARM, CNTVCT_EL0 register description). The `isb`
/// stops the read from being taken early, out of program order (ARM ARM, "Reading the
/// counter" in the Generic Timer chapter).
pub fn cntvct() -> u64 {
    let v: u64;
    // SAFETY: reads a counter register; no memory access, no side effects.
    unsafe { core::arch::asm!("isb", "mrs {}, cntvct_el0", out(reg) v, options(nomem, nostack)) };
    v
}

/// The counter frequency in Hz (`CNTFRQ_EL0`), 24 MHz on Apple Silicon (spike finding 4).
pub fn cntfrq() -> u64 {
    let v: u64;
    // SAFETY: reads a read-only register; no memory access, no side effects.
    unsafe { core::arch::asm!("mrs {}, cntfrq_el0", out(reg) v, options(nomem, nostack)) };
    v
}
