//! Chapter 04's demonstration: what a `&[u8]` promises the optimiser, made visible.
//!
//! This file is not part of the workspace. It is compiled on its own so the lesson can show
//! the machine code the optimiser makes from each function (the capture
//! `course/captures/04-hoist-asm.txt`):
//!
//! ```sh
//! rustc --edition 2024 -O --crate-type=lib --emit=asm=hoist.s course/examples/04-hoist.rs
//! ```
//!
//! All three functions wait for byte 0 of some memory to become non-zero, trying at most `limit`
//! times. Imagine that the memory is guest RAM and the guest sets the byte from another CPU.

// ANCHOR: hoist_slice
/// Through a shared slice: Rust promises that nobody changes `flag` while we hold it.
#[unsafe(no_mangle)]
pub fn wait_slice(flag: &[u8], limit: u32) -> u32 {
    let mut tries = 0;
    while tries < limit && flag[0] == 0 {
        tries += 1;
    }
    tries
}
// ANCHOR_END: hoist_slice

// ANCHOR: hoist_raw
/// Through a raw pointer, with an ordinary (non-volatile) load: no reference anywhere.
///
/// # Safety
/// `flag` must point at one readable byte for the whole call.
#[unsafe(no_mangle)]
pub unsafe fn wait_raw(flag: *const u8, limit: u32) -> u32 {
    let mut tries = 0;
    // SAFETY: the caller promises `flag` is readable for the whole call.
    while tries < limit && unsafe { *flag } == 0 {
        tries += 1;
    }
    tries
}
// ANCHOR_END: hoist_raw

// ANCHOR: hoist_volatile
/// Through a raw pointer, with a volatile load: the compiler must load on every try.
///
/// # Safety
/// `flag` must point at one readable byte for the whole call.
#[unsafe(no_mangle)]
pub unsafe fn wait_volatile(flag: *const u8, limit: u32) -> u32 {
    let mut tries = 0;
    // SAFETY: the caller promises `flag` is readable for the whole call.
    while tries < limit && unsafe { flag.read_volatile() } == 0 {
        tries += 1;
    }
    tries
}
// ANCHOR_END: hoist_volatile
