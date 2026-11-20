//! `hostile-sysreg`: TEST-7 phase 3, the system-register sweep (threat model §9.4, HC-6;
//! PLAN M11). Reads **every** `S3_<op1>_C<n>_C<m>_<op2>` encoding (op0 = 3: 8 × 16 × 16 × 8 =
//! 16384 registers), then writes zero to each encoding whose read was UNDEFINED.
//!
//! Each access is one `mrs`/`msr` instruction generated at run time into a small code buffer
//! (an encoding is part of the instruction, so a sweep cannot be written as a loop of fixed
//! instructions), followed by `ret`. Registers fall into three groups: those the hardware lets
//! EL1 read directly, those the hardware or HVF makes UNDEFINED (absent features, EL2/EL3
//! registers), and those HVF forwards to macvmm as EC 0x18, where the policy table answers
//! or injects an UNDEF (`arch/sysreg.rs`, HC-6). The guest cannot tell the last two apart, and
//! must not need to: it counts UNDEFs and steps over them. Two architectural variants are
//! counted too: FEAT_IDST reports unallocated ID registers as EC 0x18, and the SVE/SME control
//! registers trap on this guest's own `CPACR_EL1` (EC 0x19/0x1D). The VMM must never stop.
//!
//! **Why zero, and only where the read UNDEFed.** Writing to a register that exists at EL1
//! (SCTLR_EL1, VBAR_EL1, TTBR0_EL1, …) would break this guest, not the VMM; the hostile part is
//! the traps, and an encoding that UNDEFs on read is the one most likely to reach the VMM's
//! default path on write too. The GIC CPU-interface block (op1 0, CRn 12) is skipped for
//! writes: `ICC_*` writes are acknowledgements and SGIs, not register state.
//!
//! The code buffer is executed with the MMU off: instruction fetches are Normal
//! Non-cacheable, and the stores that write it are Device accesses, so `dsb ish; ic iallu;
//! dsb ish; isb` after each rewrite is enough (ARM ARM B2.4.4, "Concurrent modification and
//! execution of instructions").
#![no_std]
#![no_main]

use core::arch::asm;
use guest::hostile::{FEATURE_TRAPS, UNDEFS, install_fault_counter};
use guest::println;

guest::entry!(main);

#[repr(C, align(64))]
struct Code([u32; 4]);
static mut CODE: Code = Code([0xd503_201f, 0xd65f_03c0, 0, 0]); // nop; ret

/// `mrs x0, S3_op1_Cn_Cm_op2` (ARM ARM C6.2.247: 1101 0101 0011 1 op1 CRn CRm op2 Rt).
fn mrs(op1: u32, crn: u32, crm: u32, op2: u32) -> u32 {
    0xd538_0000 | op1 << 16 | crn << 12 | crm << 8 | op2 << 5
}

/// `msr S3_op1_Cn_Cm_op2, xzr` (C6.2.249: 1101 0101 0001 1 op1 CRn CRm op2 Rt=31).
fn msr_zero(op1: u32, crn: u32, crm: u32, op2: u32) -> u32 {
    0xd518_0000 | op1 << 16 | crn << 12 | crm << 8 | op2 << 5 | 31
}

/// Put `insn; ret` in the code buffer and run it once.
fn run(insn: u32) {
    let p = &raw mut CODE as *mut u32;
    // SAFETY: CODE is this guest's own 16-byte buffer; the writes are volatile, the cache and
    // pipeline maintenance below makes them visible to instruction fetch, and the buffer holds
    // `insn; ret`, which returns to us (an UNDEF is stepped over by the fault counter, landing
    // on the `ret`). x0 is clobbered by `mrs`; x30 by the call.
    unsafe {
        p.write_volatile(insn);
        p.add(1).write_volatile(0xd65f_03c0);
        asm!("dsb ish", "ic iallu", "dsb ish", "isb", options(nostack));
        asm!("blr {f}", f = in(reg) p as u64, out("x0") _, out("x30") _, options(nostack));
    }
}

fn main(_x0: u64) {
    install_fault_counter();
    let (mut reads, mut writes, mut read_undefs, mut write_undefs) = (0u64, 0u64, 0u64, 0u64);
    for op1 in 0..8 {
        for crn in 0..16 {
            for crm in 0..16 {
                for op2 in 0..8 {
                    let before = UNDEFS.get() + FEATURE_TRAPS.get();
                    run(mrs(op1, crn, crm, op2));
                    reads += 1;
                    if UNDEFS.get() + FEATURE_TRAPS.get() != before {
                        read_undefs += 1;
                        if op1 == 0 && crn == 12 {
                            continue;
                        }
                        let before = UNDEFS.get() + FEATURE_TRAPS.get();
                        run(msr_zero(op1, crn, crm, op2));
                        writes += 1;
                        if UNDEFS.get() + FEATURE_TRAPS.get() != before {
                            write_undefs += 1;
                        }
                    }
                }
            }
        }
        println!("hostile-sysreg: op1 {op1} done");
    }
    println!(
        "hostile-sysreg: {reads} reads ({read_undefs} undef), {writes} writes ({write_undefs} undef), {} CPACR traps",
        FEATURE_TRAPS.get()
    );
    println!("hostile-sysreg: survived");
}
