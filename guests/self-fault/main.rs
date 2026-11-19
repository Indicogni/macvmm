//! `self-fault`: a guest that faults inside itself, then faults again on its missing vector
//! table (course ch06, "the self-fault chain, link by link"; PLAN M4).
//!
//! 1. Set `SCTLR_EL1.A = 1` (alignment checking; ARM ARM D19.2.118) and `VBAR_EL1 = 0`, then
//!    load 8 bytes from an address that is not a multiple of 8. With A = 1 that is an
//!    alignment fault whether HVF treats MMU-off accesses as Device or Normal memory.
//! 2. The fault is routed to **EL1**, the guest's own level, not to EL2: the VMM sees nothing.
//!    `ELR_EL1` = the load's address (`0x4008…`), `ESR_EL1` = EC 0x25 (data abort, same EL),
//!    DFSC 0x21 (alignment fault): `0x9600_0021`.
//! 3. The CPU jumps to `VBAR_EL1 + 0x200` (current EL, SP_ELx, synchronous) = `0x200`.
//! 4. Nothing is mapped at IPA `0x200` (flash, no `--bios`): the instruction fetch faults in
//!    stage 2.
//! 5. That instruction abort is routed to EL2, and HVF hands it to the VMM: the *first
//!    non-HVC* exit of the run (the only exits before it are the DEBUG_PUTC HVCs that printed
//!    the banner), with PC `0x200`.
//! 6. The VMM's dump shows the second fault and, in `ELR_EL1`/`ESR_EL1`, the first one.
//!    Expected: `guest fatal: instruction abort`, exit code 3.
#![no_std]
#![no_main]

use core::arch::asm;
use guest::println;

guest::entry!(main);

/// 16 bytes of RAM; the load reads 8 of them starting at byte 1.
static BUF: [u64; 2] = [0x1122_3344_5566_7788, 0x99aa_bbcc_ddee_ff00];

fn main(_x0: u64) {
    let addr = core::ptr::addr_of!(BUF) as u64 + 1;
    println!("self-fault: SCTLR_EL1.A=1, VBAR_EL1=0, loading 8 bytes from {addr:#x}");
    // SAFETY: deliberately faults (module docs); nothing after the load runs if the VMM is
    // right. The registers named as outputs are the only ones written.
    unsafe {
        asm!(
            "mrs {t}, sctlr_el1",
            "orr {t}, {t}, #2",
            "msr sctlr_el1, {t}",
            "isb",
            "msr vbar_el1, xzr",
            "isb",
            "ldr {v}, [{a}]",
            t = out(reg) _,
            v = out(reg) _,
            a = in(reg) addr,
            options(nostack),
        );
    }
    println!("self-fault: FAILED: the unaligned load did not fault");
}
