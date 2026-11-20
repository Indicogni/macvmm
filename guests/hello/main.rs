//! `hello`: the smallest useful guest (course ch03).
//!
//! It proves the whole M3 path end to end: the loader put our bytes at `0x4008_0000`, the vCPU
//! started at `_start` with the boot argument in `x0`, DEBUG_PUTC reaches the host's stdout
//! through the `AnsiFilter`, and PSCI SYSTEM_OFF ends the VM with exit code 0. It works both as
//! an ELF (`--kernel hello`) and as a flat binary (`--raw hello.bin@0x40080000`).
// ANCHOR: guest_hello
#![no_std]
#![no_main]

use guest::println;

guest::entry!(main);

fn main(x0: u64) {
    println!("hello from guest, x0={x0:#x}");
    println!("guest done");
}
// ANCHOR_END: guest_hello
