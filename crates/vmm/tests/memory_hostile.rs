//! Hostile-input tests for guest memory (PLAN M2, threat model MEM-2, MEM-3, MEM-6, MEM-8).
//!
//! Every value here is one a guest (through a descriptor, a register or a DMA address) or a
//! broken loader could hand the VMM. Each access must come back `Err` with nothing copied,
//! and nothing may panic. The double is `VecMemory`, which uses the same `RegionTable` as
//! `GuestRam`; the same rules on real `hv_vm_allocate` memory are exercised by
//! `hvf_memory.rs` (`volatile_copy_property_guest_ram`).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::layout::{Layout, RAM_BASE, VIRT_REGIONS};
use vmm::memory::region::{MAX_REGIONS, REGION_ALIGN};
use vmm::memory::{
    FromLeBytes, GuestAddress, GuestMemory, GuestMemoryExt, GuestMemoryOrdered, MemoryError,
    RegionError, RegionTable, VecMemory,
};

const K16: u64 = REGION_ALIGN;
/// Two adjacent 64 KiB regions (separate backings) and one far 16 KiB region.
const R0: u64 = RAM_BASE;
const R1: u64 = RAM_BASE + 0x1_0000;
const R1_END: u64 = R1 + 0x1_0000;
const FAR: u64 = 0x8000_0000;

fn mem() -> VecMemory {
    VecMemory::new(&[
        (GuestAddress(R0), 0x1_0000),
        (GuestAddress(R1), 0x1_0000),
        (GuestAddress(FAR), K16),
    ])
    .unwrap()
}

fn ga(a: u64) -> GuestAddress {
    GuestAddress(a)
}

fn oob(addr: u64, len: u64) -> Result<(), MemoryError> {
    Err(MemoryError::OutOfBounds { addr, len })
}

// --- MEM-2: overflow ---------------------------------------------------------------------

#[test]
fn read_at_u64_max_minus_3_len_8_overflows() {
    let mut buf = [0xaa; 8];
    assert_eq!(
        mem().read(ga(u64::MAX - 3), &mut buf),
        Err(MemoryError::Overflow {
            addr: u64::MAX - 3,
            len: 8
        })
    );
    assert_eq!(buf, [0xaa; 8], "nothing copied");
}

#[test]
fn write_at_u64_max_minus_3_len_8_overflows() {
    assert!(matches!(
        mem().write(ga(u64::MAX - 3), &[0; 8]),
        Err(MemoryError::Overflow { .. })
    ));
}

#[test]
fn check_range_at_u64_max_minus_3_len_8_is_false() {
    assert!(!mem().check_range(ga(u64::MAX - 3), 8));
}

#[test]
fn u64_max_len_1_overflows() {
    assert!(matches!(
        mem().read_u8(ga(u64::MAX)),
        Err(MemoryError::Overflow { .. })
    ));
}

#[test]
fn read_u64_wrapping_into_ram_is_refused() {
    // addr + 8 would wrap to a small value; never "lands" anywhere.
    assert!(mem().read_u64(ga(u64::MAX - 3)).is_err());
    assert!(!mem().check_range(ga(R0), u64::MAX));
    assert!(!mem().check_range(ga(R0 + 1), u64::MAX));
}

// --- MEM-2: exact ends -------------------------------------------------------------------

#[test]
fn read_ending_exactly_at_region_end_is_ok() {
    let m = mem();
    let mut buf = [0; 16];
    assert_eq!(m.read(ga(R1_END - 16), &mut buf), Ok(()));
    assert!(m.check_range(ga(R1_END - 16), 16));
    assert!(m.check_range(ga(FAR + K16 - 1), 1));
}

#[test]
fn read_one_byte_past_region_end_is_err() {
    let mut buf = [0; 17];
    assert_eq!(mem().read(ga(R1_END - 16), &mut buf), oob(R1_END - 16, 17));
    assert!(!mem().check_range(ga(FAR + K16 - 1), 2));
}

#[test]
fn write_one_byte_past_region_end_writes_nothing() {
    let m = mem();
    assert_eq!(
        m.write(ga(R1_END - 4), &[1, 2, 3, 4, 5]),
        oob(R1_END - 4, 5)
    );
    assert_eq!(m.read_u32(ga(R1_END - 4)), Ok(0), "no partial write");
    assert_eq!(m.write(ga(R1_END - 4), &[1, 2, 3, 4]), Ok(()));
    assert_eq!(m.read_u32(ga(R1_END - 4)), Ok(0x0403_0201));
}

#[test]
fn read_u64_straddling_region_end_is_err() {
    assert!(mem().read_u64(ga(FAR + K16 - 4)).is_err());
    assert!(mem().write_u64(ga(FAR + K16 - 4), 1).is_err());
}

// --- MEM-2: zero length ------------------------------------------------------------------

#[test]
fn zero_length_check_range_is_false() {
    assert!(!mem().check_range(ga(R0), 0));
    assert!(!mem().check_range(ga(R0 + 0x100), 0));
}

#[test]
fn zero_length_read_is_err() {
    assert_eq!(mem().read(ga(R0), &mut []), oob(R0, 0));
}

#[test]
fn zero_length_write_is_err() {
    assert_eq!(mem().write(ga(R0), &[]), oob(R0, 0));
}

// --- MEM-2: one region per access ---------------------------------------------------------

#[test]
fn read_spanning_two_adjacent_regions_is_err() {
    let mut buf = [0; 8];
    assert_eq!(mem().read(ga(R1 - 4), &mut buf), oob(R1 - 4, 8));
}

#[test]
fn write_spanning_two_adjacent_regions_writes_nothing() {
    let m = mem();
    assert!(m.write(ga(R1 - 2), &[0xff; 4]).is_err());
    assert_eq!(m.read_u16(ga(R1 - 2)), Ok(0));
    assert_eq!(m.read_u16(ga(R1)), Ok(0));
}

#[test]
fn check_range_across_boundary_is_false() {
    let m = mem();
    assert!(!m.check_range(ga(R1 - 1), 2));
    assert!(m.check_range(ga(R1 - 1), 1));
    assert!(m.check_range(ga(R1), 1));
    // The whole of both regions is 128 KiB of contiguous IPA space, yet not one access.
    assert!(!m.check_range(ga(R0), 0x2_0000));
}

#[test]
fn read_below_first_region_is_err() {
    assert!(mem().read_u8(ga(R0 - 1)).is_err());
    assert!(mem().read_u8(ga(0)).is_err());
}

#[test]
fn read_in_gap_between_regions_is_err() {
    assert!(mem().read_u32(ga(R1_END)).is_err());
    assert!(mem().read_u32(ga(FAR - 4)).is_err());
}

#[test]
fn read_above_last_region_is_err() {
    assert!(mem().read_u8(ga(FAR + K16)).is_err());
    assert!(mem().read_u8(ga(1 << 40)).is_err());
}

#[test]
fn failed_read_leaves_buffer_untouched() {
    let m = mem();
    m.write(ga(R1 - 4), &[9; 4]).unwrap();
    let mut buf = [0x55; 8];
    assert!(m.read(ga(R1 - 4), &mut buf).is_err());
    assert_eq!(buf, [0x55; 8]);
}

// --- MEM-6: ordered accessors -------------------------------------------------------------

#[test]
fn unaligned_acquire_is_err() {
    assert_eq!(
        mem().read_u16_acquire(ga(R0 + 1)),
        Err(MemoryError::Unaligned { addr: R0 + 1 })
    );
}

#[test]
fn unaligned_release_is_err_and_writes_nothing() {
    let m = mem();
    assert_eq!(
        m.write_u16_release(ga(R0 + 3), 0xffff),
        Err(MemoryError::Unaligned { addr: R0 + 3 })
    );
    assert_eq!(m.read_u32(ga(R0)), Ok(0));
}

#[test]
fn ordered_accessors_obey_bounds() {
    let m = mem();
    assert_eq!(m.write_u16_release(ga(FAR + K16 - 2), 0xbeef), Ok(()));
    assert_eq!(m.read_u16_acquire(ga(FAR + K16 - 2)), Ok(0xbeef));
    assert!(m.read_u16_acquire(ga(FAR + K16)).is_err());
    assert!(m.read_u16_acquire(ga(u64::MAX - 1)).is_err());
    assert!(m.write_u16_release(ga(u64::MAX - 1), 1).is_err());
}

// --- MEM-3: ROM, MMIO and holes are unreachable -------------------------------------------

#[test]
fn write_to_rom_address_through_guest_memory_is_err() {
    let m = mem();
    let flash = Layout::virt().find(0).unwrap();
    assert_eq!(flash.name, "flash0");
    assert!(m.write(ga(flash.base), &[0x14]).is_err());
    assert!(m.write_u32(ga(flash.base + 0x1000), 0xd503_201f).is_err());
    assert!(!m.check_range(ga(flash.base), 4));
}

#[test]
fn every_non_ram_region_of_the_layout_is_unreachable() {
    let m = mem();
    for r in VIRT_REGIONS {
        for ipa in [r.base, r.end() - 1] {
            assert!(m.read_u8(ga(ipa)).is_err(), "{} at {ipa:#x}", r.name);
            assert!(m.write_u8(ga(ipa), 0).is_err(), "{} at {ipa:#x}", r.name);
            assert!(!m.check_range(ga(ipa), 1), "{}", r.name);
        }
    }
}

// --- MEM-8: region-table construction -----------------------------------------------------

#[test]
fn region_table_rejects_overlap() {
    let r = RegionTable::new(&[(ga(0x4000_0000), 2 * K16), (ga(0x4000_4000), K16)], 40);
    assert_eq!(
        r,
        Err(RegionError::Overlap {
            first: 0x4000_0000,
            second: 0x4000_4000
        })
    );
    // Identical regions overlap too.
    assert!(RegionTable::new(&[(ga(0), K16), (ga(0), K16)], 40).is_err());
}

#[test]
fn region_table_rejects_zero_size() {
    assert_eq!(
        RegionTable::new(&[(ga(0x4000_0000), 0)], 40),
        Err(RegionError::ZeroSize { base: 0x4000_0000 })
    );
}

#[test]
fn region_table_rejects_unaligned_base() {
    for base in [0x4000_1000, 0x4000_0001, 0x4000_2000] {
        assert!(matches!(
            RegionTable::new(&[(ga(base), K16)], 40),
            Err(RegionError::Unaligned { .. })
        ));
    }
}

#[test]
fn region_table_rejects_unaligned_size() {
    for size in [0x1000, K16 + 1, K16 - 1] {
        assert!(matches!(
            RegionTable::new(&[(ga(0x4000_0000), size)], 40),
            Err(RegionError::Unaligned { .. })
        ));
    }
}

#[test]
fn region_table_rejects_base_plus_size_overflow() {
    let base = u64::MAX - K16 + 1; // 16 KiB-aligned
    assert_eq!(
        RegionTable::new(&[(ga(base), 2 * K16)], 40),
        Err(RegionError::Overflow {
            base,
            size: 2 * K16
        })
    );
}

#[test]
fn region_table_rejects_region_at_or_above_ipa_limit() {
    let limit = 1u64 << 40;
    assert!(matches!(
        RegionTable::new(&[(ga(limit), K16)], 40),
        Err(RegionError::AboveIpaLimit { .. })
    ));
    assert!(matches!(
        RegionTable::new(&[(ga(limit - K16), 2 * K16)], 40),
        Err(RegionError::AboveIpaLimit { .. })
    ));
    // At 36 bits, RAM ending at 64 GiB + 16 KiB does not fit.
    assert!(RegionTable::new(&[(ga(RAM_BASE), (1 << 36) - RAM_BASE + K16)], 36).is_err());
}

#[test]
fn region_ending_exactly_at_1_shl_40_is_accepted() {
    let limit = 1u64 << 40;
    let t = RegionTable::new(&[(ga(limit - K16), K16)], 40).unwrap();
    assert!(t.contains(ga(limit - 1), 1));
    assert!(!t.contains(ga(limit - 1), 2));
    assert!(!t.contains(ga(limit), 1));
}

#[test]
fn region_table_rejects_empty_too_many_and_bad_ipa_bits() {
    assert_eq!(RegionTable::new(&[], 40), Err(RegionError::Empty));
    let many: Vec<_> = (0..=MAX_REGIONS as u64)
        .map(|i| (ga(i * 2 * K16), K16))
        .collect();
    assert!(matches!(
        RegionTable::new(&many, 40),
        Err(RegionError::TooMany { .. })
    ));
    for bits in [0, 31, 53, 64, u32::MAX] {
        assert_eq!(
            RegionTable::new(&[(ga(0), K16)], bits),
            Err(RegionError::BadIpaBits { bits })
        );
    }
}

#[test]
fn vec_memory_refuses_bad_tables_too() {
    assert!(VecMemory::new(&[(ga(0x4000_1000), K16)]).is_err());
    assert!(VecMemory::new(&[(ga(R0), K16), (ga(R0), K16)]).is_err());
    assert!(VecMemory::new(&[]).is_err());
}

// --- Little-endian helpers -----------------------------------------------------------------

#[test]
fn le_roundtrip_u16() {
    let m = mem();
    m.write_u16(ga(R0 + 6), 0xa1b2).unwrap();
    assert_eq!(m.read_u16(ga(R0 + 6)), Ok(0xa1b2));
    assert_eq!(m.read_u8(ga(R0 + 6)), Ok(0xb2), "low byte first");
}

#[test]
fn le_roundtrip_u32() {
    let m = mem();
    m.write_u32(ga(R0 + 0x101), 0xdead_beef).unwrap(); // unaligned is fine for plain helpers
    assert_eq!(m.read_u32(ga(R0 + 0x101)), Ok(0xdead_beef));
    let mut b = [0; 4];
    m.read(ga(R0 + 0x101), &mut b).unwrap();
    assert_eq!(b, [0xef, 0xbe, 0xad, 0xde]);
}

#[test]
fn le_roundtrip_u64() {
    let m = mem();
    m.write_u64(ga(R1 - 8), 0x0102_0304_0506_0708).unwrap();
    assert_eq!(m.read_u64(ga(R1 - 8)), Ok(0x0102_0304_0506_0708));
    assert_eq!(m.read_u8(ga(R1 - 1)), Ok(0x01), "high byte last");
    m.write_u8(ga(R1 - 8), 0xff).unwrap();
    assert_eq!(m.read_u8(ga(R1 - 8)), Ok(0xff));
}

/// A 16-byte wire structure (the shape of a virtq descriptor, virtio 1.2 §2.7.5).
#[derive(Debug, PartialEq)]
struct Desc {
    addr: u64,
    len: u32,
    flags: u16,
    next: u16,
}

impl FromLeBytes for Desc {
    type Bytes = [u8; 16];
    fn decode_le(b: [u8; 16]) -> Desc {
        let [
            a0,
            a1,
            a2,
            a3,
            a4,
            a5,
            a6,
            a7,
            l0,
            l1,
            l2,
            l3,
            f0,
            f1,
            n0,
            n1,
        ] = b;
        Desc {
            addr: u64::from_le_bytes([a0, a1, a2, a3, a4, a5, a6, a7]),
            len: u32::from_le_bytes([l0, l1, l2, l3]),
            flags: u16::from_le_bytes([f0, f1]),
            next: u16::from_le_bytes([n0, n1]),
        }
    }
}

#[test]
fn read_obj_copies_the_whole_structure_once() {
    let m = mem();
    m.write_u64(ga(R0 + 0x40), 0x4000_2000).unwrap();
    m.write_u32(ga(R0 + 0x48), 0x200).unwrap();
    m.write_u16(ga(R0 + 0x4c), 1).unwrap();
    m.write_u16(ga(R0 + 0x4e), 7).unwrap();
    m.enable_log();
    let d: Desc = m.read_obj(ga(R0 + 0x40)).unwrap();
    assert_eq!(
        d,
        Desc {
            addr: 0x4000_2000,
            len: 0x200,
            flags: 1,
            next: 7
        }
    );
    let log = m.log();
    assert_eq!(log.len(), 1, "one copy (MEM-7): {log:?}");
    assert_eq!(
        (log[0].addr, log[0].len, log[0].write),
        (R0 + 0x40, 16, false)
    );
    // Through a trait object as well, and refused across a boundary.
    let dynm: &dyn GuestMemoryOrdered = &m;
    assert!(dynm.read_obj::<Desc>(ga(R1 - 8)).is_err());
    assert_eq!(dynm.read_obj::<u32>(ga(R0 + 0x48)), Ok(0x200));
}
