// Checkpoint 04 HVF contract (PLAN M27 L2, `contract_hvf`). It names only items the chapter 04
// lesson teaches: `vmm::memory::{GuestRam, RomRegion, GuestAddress, VecMemory}` and the
// `GuestMemory` trait, all from `memory/host.rs` and its siblings.
//! The memory/host.rs half of the hostile cases (PLAN M2; threat model MEM-2, MEM-3, MEM-6,
//! MEM-8).
//!
//! `memory_hostile.rs` (L1) checks the rules on the host double `VecMemory`. This file checks
//! the same rules on real `hv_vm_allocate` memory, the only code that turns a guest address
//! into a host pointer: every refusal must be an `Err` and never a panic or a wrapped pointer.
//! It allocates host memory with the hypervisor entitlement but creates no VM, so it is quick
//! and cannot disturb anything else.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Mutex, MutexGuard};
use vmm::memory::prelude::*;
use vmm::memory::{GuestRam, RomRegion, TeardownAction, VecMemory};

/// PLAN §1: guest RAM starts at 1 GiB.
const RAM_BASE: u64 = 0x4000_0000;
const K16: u64 = 0x4000;

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

fn ga(a: u64) -> GuestAddress {
    GuestAddress(a)
}

#[test]
fn guest_ram_refuses_hostile_ranges() {
    let _s = serial();
    let ram = GuestRam::new(&[(ga(RAM_BASE), 0x1_0000)], 40).unwrap();
    let end = RAM_BASE + 0x1_0000;
    let mut buf = [0u8; 8];
    // The wrapping-add attack: u64::MAX - 3 + 8 wraps to 4.
    assert!(ram.read(ga(u64::MAX - 3), &mut buf).is_err());
    assert!(ram.write(ga(u64::MAX - 3), &buf).is_err());
    assert!(!ram.check_range(ga(u64::MAX - 3), 8));
    // Exactly to the end is fine; one byte past it is not.
    assert!(ram.write(ga(end - 8), &buf).is_ok());
    assert!(ram.write(ga(end - 7), &buf).is_err());
    assert!(ram.read(ga(RAM_BASE - 1), &mut buf[..2]).is_err());
    // Zero length is never a valid range.
    assert!(!ram.check_range(ga(RAM_BASE), 0));
    // The ordered accessors: misaligned and out-of-range are refused.
    assert!(ram.read_u16_acquire(ga(RAM_BASE + 1)).is_err());
    assert!(ram.read_u16_acquire(ga(u64::MAX - 1)).is_err());
    assert!(ram.write_u16_release(ga(end), 1).is_err());
    assert_eq!(ram.release(true), TeardownAction::Deallocate);
}

#[test]
fn guest_ram_round_trips_little_endian() {
    let _s = serial();
    let ram = GuestRam::new(&[(ga(RAM_BASE), K16)], 40).unwrap();
    ram.write_u32(ga(RAM_BASE + 0x10), 0xdead_beef).unwrap();
    let mut b = [0u8; 4];
    ram.read(ga(RAM_BASE + 0x10), &mut b).unwrap();
    assert_eq!(b, [0xef, 0xbe, 0xad, 0xde]);
    assert_eq!(ram.read_u32(ga(RAM_BASE + 0x10)), Ok(0xdead_beef));
    assert_eq!(ram.release(true), TeardownAction::Deallocate);
}

/// The ROM in memory/host.rs takes host-side offsets (the loader's): an offset near
/// `u64::MAX` must be an `Err`, not an overflow, whatever the ROM's base.
#[test]
fn rom_region_refuses_hostile_offsets() {
    let _s = serial();
    // Flash bank 1 (PLAN §1): a non-zero base, so `base + offset` can overflow.
    let rom = RomRegion::new(ga(0x0400_0000), K16, 40).unwrap();
    assert!(rom.load(u64::MAX - 3, &[0u8; 8]).is_err());
    let mut b = [0u8; 8];
    assert!(rom.read(u64::MAX - 3, &mut b).is_err());
    assert!(rom.load(K16 - 4, &[0u8; 8]).is_err(), "straddles the end");
    assert!(rom.load(K16 - 8, &[1u8; 8]).is_ok());
    rom.read(K16 - 8, &mut b).unwrap();
    assert_eq!(b, [1u8; 8]);
    assert_eq!(rom.release(true), TeardownAction::Deallocate);
}

/// Random reads and writes on a `GuestRam` and a `VecMemory` with the same table agree in
/// every byte and every accept/refuse decision (seeded xorshift, PLAN §0.3).
#[test]
fn guest_ram_agrees_with_vec_memory() {
    let _s = serial();
    let regions = [
        (ga(RAM_BASE), 0x1_0000),
        (ga(RAM_BASE + 0x1_0000), K16),
        (ga((1 << 40) - K16), K16),
    ];
    let ram = GuestRam::new(&regions, 40).unwrap();
    let oracle = VecMemory::new(&regions).unwrap();
    let seed = 0x6d61_6376_6d6d_0004u64;
    let mut x = seed;
    let mut next = move || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let edges = [
        RAM_BASE,
        RAM_BASE + 0x1_0000,
        RAM_BASE + 0x1_4000,
        (1 << 40) - K16,
        1 << 40,
        u64::MAX,
    ];
    for i in 0..10_000 {
        let e = edges[(next() % edges.len() as u64) as usize];
        let addr = e.wrapping_add(next() % 96).wrapping_sub(48);
        let len = (next() % 80) as usize;
        let ctx = format!("seed {seed:#x} iteration {i}: {addr:#x}+{len}");
        if next() % 2 == 0 {
            let data: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            assert_eq!(
                ram.write(ga(addr), &data),
                oracle.write(ga(addr), &data),
                "{ctx}"
            );
        } else {
            let (mut a, mut b) = (vec![0x11u8; len], vec![0x11u8; len]);
            assert_eq!(
                ram.read(ga(addr), &mut a),
                oracle.read(ga(addr), &mut b),
                "{ctx}"
            );
            assert_eq!(a, b, "{ctx}");
        }
    }
    assert_eq!(ram.release(true), TeardownAction::Deallocate);
}
