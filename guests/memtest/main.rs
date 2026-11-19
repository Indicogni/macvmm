//! `memtest`: guest RAM is real, private, and seen identically by the VMM (course ch04, L2).
//!
//! It works on the fixed window `0x4100_0000..0x4200_0000` (16 MiB, so it needs `--mem ≥ 64M`;
//! the image itself lives at `0x4008_0000`, well below it):
//!
//! 1. writes 8 patterns over the window and verifies each locally;
//! 2. asks the VMM for DEBUG_MEMHASH of the same window and compares it with its own FNV-1a-64;
//! 3. calls `memhash(0xFFFF_FFFF_FFFF_FFF0, 0x20)`, whose end overflows `u64`, and expects the
//!    VMM to answer `-2` (threat model MEM-2: `checked_add`, never a wrap).
//!
//! **Why step 2 matters** (first-principles R6/R13). The guest runs with `SCTLR_EL1.M = 0`,
//! so its stores are Device or Non-cacheable at stage 1, while the VMM reads the same memory
//! through a cacheable host mapping. A matching hash is the on-machine evidence that MMU-off
//! guest writes are visible to the VMM without cache maintenance.
//!
//! All accesses are aligned 64-bit volatile loads and stores (MMU off: unaligned faults).
#![no_std]
#![no_main]

use guest::println;

guest::entry!(main);

const WINDOW: u64 = 0x4100_0000;
const WINDOW_LEN: u64 = 0x0100_0000;
const WORDS: u64 = WINDOW_LEN / 8;

/// The value pattern `p` stores in word `i`.
fn pattern(p: u32, i: u64) -> u64 {
    let addr = WINDOW + i * 8;
    match p {
        1 => 0,
        2 => u64::MAX,
        3 => 0xAAAA_AAAA_AAAA_AAAA,
        4 => 0x5555_5555_5555_5555,
        5 => addr,
        6 => !addr,
        7 => 1u64.rotate_left((i % 64) as u32),
        _ => {
            // xorshift64 of the index: a pattern with no structure an address bug could mimic.
            let mut x = i ^ 0x9E37_79B9_7F4A_7C15;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        }
    }
}

fn word(i: u64) -> *mut u64 {
    (WINDOW + i * 8) as *mut u64
}

/// FNV-1a-64 over the window's bytes, in address order (little-endian words).
fn fnv1a_window() -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for i in 0..WORDS {
        // SAFETY: aligned load inside the window, which is guest RAM with `--mem ≥ 64M`.
        let w = unsafe { core::ptr::read_volatile(word(i)) };
        for b in w.to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn main(_x0: u64) {
    for p in 1..=8u32 {
        for i in 0..WORDS {
            // SAFETY: aligned store inside the window (guest RAM).
            unsafe { core::ptr::write_volatile(word(i), pattern(p, i)) };
        }
        for i in 0..WORDS {
            // SAFETY: aligned load inside the window (guest RAM).
            let got = unsafe { core::ptr::read_volatile(word(i)) };
            let want = pattern(p, i);
            if got != want {
                println!(
                    "memtest: pattern {p} FAILED at {:#x}: got {got:#x} want {want:#x}",
                    WINDOW + i * 8
                );
                guest::hvc::debug_exit(2);
            }
        }
        println!("memtest: pattern {p} ok");
    }

    let mine = fnv1a_window();
    match guest::hvc::memhash(WINDOW, WINDOW_LEN) {
        Ok(theirs) if theirs == mine => println!("memtest: memhash ok"),
        Ok(theirs) => {
            println!("memtest: memhash MISMATCH: vmm {theirs:#x} guest {mine:#x}");
            guest::hvc::debug_exit(3);
        }
        Err(e) => {
            println!("memtest: memhash error {e}");
            guest::hvc::debug_exit(4);
        }
    }

    match guest::hvc::memhash(0xFFFF_FFFF_FFFF_FFF0, 0x20) {
        Err(guest::hvc::INVALID_PARAMETER) => println!("memtest: memhash rejects overflow ok"),
        other => {
            println!("memtest: memhash overflow not rejected: {other:?}");
            guest::hvc::debug_exit(5);
        }
    }
}
