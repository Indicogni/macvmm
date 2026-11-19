//! `mmio-poke`: one store into a hole in the machine map (course ch05, L2 test).
//!
//! `0x0c00_0000` is the "never-populated hole" of PLAN §1: no RAM and no device. The store
//! takes a stage-2 translation fault, HVF reports a data abort (EC 0x24, ISV = 1, spike
//! finding 7) with the IPA, and the VMM's default `--unhandled-mmio fatal` policy stops the VM
//! with exit code 3 and `unhandled MMIO write at 0xc000000 size 4 pc 0x…`. With
//! `--unhandled-mmio log` the store is ignored (RAZ/WI) and the guest goes on to print
//! `mmio-poke: survived` and power off.
#![no_std]
#![no_main]

use guest::println;

guest::entry!(main);

/// The hole: unmapped, and never given a device (PLAN §1).
const HOLE: usize = 0x0c00_0000;

fn main(_x0: u64) {
    println!("mmio-poke: storing 0x4d to {HOLE:#x}");
    // SAFETY: a 32-bit aligned store to an address that is not guest RAM; it can only trap to
    // the VMM, which is the point of this guest.
    unsafe { core::ptr::write_volatile(HOLE as *mut u32, 0x4d) };
    println!("mmio-poke: survived");
}
