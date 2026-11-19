//! `regcheck`: read back the reset state the VMM gave this vCPU (course ch06, PLAN M4).
//!
//! `Vcpu::reset` promises a guest (architecture §6.5, booting.rst §4): EL1h with every
//! interrupt masked (`CPSR = 0x3c5`), the MMU and caches off, and `MPIDR_EL1 = 0x8000_0000` on
//! vCPU 0. This guest reads each of those from the inside, with the instructions a kernel
//! would use, and prints them as markers:
//!
//! - `mrs CurrentEL`: the EL in bits 3:2, so EL1 reads `0x4` (ARM ARM C5.2.1);
//! - `mrs MPIDR_EL1`: bit 31 RES1, affinity 0 (ARM ARM D19.2.101);
//! - `mrs SCTLR_EL1`, bit 0 (M): 0 = stage-1 translation off (ARM ARM D19.2.118);
//! - `mrs DAIF`: bits 9:6, all set = `0x3c0` (ARM ARM C5.2.2);
//! - `x0`: the boot argument `_start` passed through untouched.
//!
//! It then checks the vector table's catch-and-resume path once: an `svc #0x4d` is taken to
//! EL1 (EC 0x15, never to the VMM), a hook records it and resumes after it.
#![no_std]
#![no_main]

use core::arch::asm;
use core::sync::atomic::{AtomicU64, Ordering};
use guest::exceptions::{ExceptionFrame, set_sync_hook};
use guest::println;

guest::entry!(main);

fn read_current_el() -> u64 {
    let v: u64;
    // SAFETY: reads a read-only system register; no memory access.
    unsafe { asm!("mrs {}, CurrentEL", out(reg) v, options(nomem, nostack)) };
    v
}

fn read_mpidr() -> u64 {
    let v: u64;
    // SAFETY: reads a read-only system register; no memory access.
    unsafe { asm!("mrs {}, mpidr_el1", out(reg) v, options(nomem, nostack)) };
    v
}

fn read_sctlr() -> u64 {
    let v: u64;
    // SAFETY: reads a system register; no memory access, no side effects.
    unsafe { asm!("mrs {}, sctlr_el1", out(reg) v, options(nomem, nostack)) };
    v
}

fn read_daif() -> u64 {
    let v: u64;
    // SAFETY: reads PSTATE.DAIF; no memory access, no side effects.
    unsafe { asm!("mrs {}, daif", out(reg) v, options(nomem, nostack)) };
    v
}

/// The ESR the hook saw (0 = not called).
static SEEN_ESR: AtomicU64 = AtomicU64::new(0);

fn on_svc(frame: &mut ExceptionFrame) -> bool {
    if frame.ec() != 0x15 {
        return false; // not ours: report and stop
    }
    SEEN_ESR.store(frame.esr, Ordering::SeqCst);
    true // ELR_EL1 already points past the svc (an svc is a call, not a fault)
}

fn main(x0: u64) {
    println!("regcheck: CurrentEL={:#x}", read_current_el());
    println!("regcheck: MPIDR_EL1={:#x}", read_mpidr());
    println!("regcheck: SCTLR_EL1.M={}", read_sctlr() & 1);
    println!("regcheck: DAIF={:#x}", read_daif());
    println!("regcheck: x0={x0:#x}");

    set_sync_hook(Some(on_svc));
    // SAFETY: `svc` is taken to our own EL1 vector table; the hook resumes after it and the
    // exception entry/exit saves and restores every general-purpose register.
    unsafe { asm!("svc #0x4d", options(nostack)) };
    set_sync_hook(None);
    let esr = SEEN_ESR.load(Ordering::SeqCst);
    if esr >> 26 == 0x15 && esr & 0xffff == 0x4d {
        println!("regcheck: vectors ok (svc caught at EL1, esr={esr:#x})");
    } else {
        println!("regcheck: FAILED: svc not caught (esr={esr:#x})");
    }
}
