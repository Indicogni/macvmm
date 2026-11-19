//! Invariants of the `virt` memory map (PLAN M2 acceptance, architecture §5.3, threat model
//! MEM-8). If a later milestone edits `arch/layout.rs` and breaks one of these, the board no
//! longer matches QEMU `virt` (ADR-0003) or no longer fits HVF's rules.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeSet;
use vmm::arch::layout::*;
use vmm::memory::region::REGION_ALIGN;
use vmm::memory::{GuestAddress, RegionTable};

fn ram_max() -> Region {
    Region {
        name: "ram",
        base: RAM_BASE,
        size: RAM_MAX,
        kind: RegionKind::Ram,
        intid: None,
    }
}

/// Every region, RAM at its largest size included.
fn all() -> Vec<Region> {
    let mut v = VIRT_REGIONS.to_vec();
    v.push(ram_max());
    v
}

#[test]
fn no_region_overflows_and_none_overlap() {
    let mut rs = all();
    for r in &rs {
        assert!(r.size > 0, "{}", r.name);
        assert!(r.base.checked_add(r.size).is_some(), "{} overflows", r.name);
    }
    rs.sort_by_key(|r| r.base);
    for w in rs.windows(2) {
        assert!(w[0].end() <= w[1].base, "{:?} overlaps {:?}", w[0], w[1]);
    }
    // The static table is already sorted (find() and the lessons rely on reading it in order).
    assert!(VIRT_REGIONS.windows(2).all(|w| w[0].base < w[1].base));
}

#[test]
fn mapped_regions_are_16k_aligned() {
    assert_eq!(REGION_ALIGN, 16 * 1024);
    for r in all().iter().filter(|r| r.kind.may_be_mapped()) {
        assert_eq!(r.base % REGION_ALIGN, 0, "{} base", r.name);
        assert_eq!(r.size % REGION_ALIGN, 0, "{} size", r.name);
    }
    // Every legal RAM size is a 2 MiB multiple, hence 16 KiB-aligned too.
    assert_eq!(RAM_ALIGN % REGION_ALIGN, 0);
    // GICR frames for any vCPU count stay 16 KiB-aligned.
    assert_eq!(GICR_FRAME_SIZE % REGION_ALIGN, 0);
}

#[test]
fn everything_is_below_1_shl_40() {
    for r in all() {
        assert!(r.end() <= 1 << 40, "{} ends at {:#x}", r.name, r.end());
    }
    assert_eq!(RAM_MAX_END, 1 << 38);
    assert_eq!(RAM_BASE + RAM_MAX, RAM_MAX_END);
}

#[test]
fn intids_are_unique_spis() {
    let l = Layout::virt();
    let mut seen = BTreeSet::new();
    let region_intids = VIRT_REGIONS.iter().filter_map(|r| r.intid);
    let slot_intids = (0..VIRTIO_MMIO_SLOTS).map(|i| l.virtio_slot(i).unwrap().1);
    // A reserved block counts as every INTID in it, so a device line inside PCIe INTx or the
    // GICv2m MSI range, or two blocks that overlap, is a duplicate (PLAN §1).
    let reserved_intids = RESERVED_INTIDS.iter().flat_map(|r| r.first..=r.last);
    for intid in region_intids.chain(slot_intids).chain(reserved_intids) {
        assert!((32..=1019).contains(&intid), "INTID {intid} is not an SPI");
        assert!(seen.insert(intid), "INTID {intid} used twice");
    }
    assert_eq!(PL011_INTID, 32 + 1);
    assert_eq!(PL031_INTID, 32 + 2);
    // The virtual timer is a PPI (16..=31), never an SPI.
    assert!((16..32).contains(&VTIMER_INTID));
}

#[test]
fn reserved_intid_blocks_match_plan_section_1() {
    // PLAN §1: PCIe INTx SPI 3–6, GICv2m SPI 48–111 (SPI n is INTID 32 + n).
    assert_eq!(
        (PCIE_INTX_INTIDS.first, PCIE_INTX_INTIDS.last),
        (32 + 3, 32 + 6)
    );
    assert_eq!(
        (GIC_V2M_INTIDS.first, GIC_V2M_INTIDS.last),
        (32 + 48, 32 + 111)
    );
    for r in RESERVED_INTIDS {
        assert!(r.first <= r.last, "{} is empty", r.name);
        assert!(r.contains(r.first) && r.contains(r.last), "{}", r.name);
        assert!(
            !r.contains(r.first - 1) && !r.contains(r.last + 1),
            "{}",
            r.name
        );
    }
    assert!(RESERVED_INTIDS.windows(2).all(|w| w[0].last < w[1].first));
    // The virtio block 48..=79 ends right below the GICv2m block.
    let (_, last_slot) = Layout::virt().virtio_slot(VIRTIO_MMIO_SLOTS - 1).unwrap();
    assert_eq!(last_slot + 1, GIC_V2M_INTIDS.first);
    // The block names its region: the INTx lines belong to the PCIe window, the MSI SPIs to
    // the v2m frame.
    for (block, region) in [("pcie-intx", "pcie-mmio"), ("gic-v2m", "gic-v2m")] {
        assert!(RESERVED_INTIDS.iter().any(|r| r.name == block), "{block}");
        assert!(VIRT_REGIONS.iter().any(|r| r.name == region), "{region}");
    }
}

#[test]
fn virtio_slots() {
    let l = Layout::virt();
    assert_eq!(l.virtio_slot(0), Some((0x0a00_0000, 48)));
    assert_eq!(l.virtio_slot(31), Some((0x0a00_3e00, 79)));
    assert_eq!(l.virtio_slot(32), None);
    assert_eq!(l.virtio_slot(usize::MAX), None);
    let window = VIRT_REGIONS
        .iter()
        .find(|r| r.name == "virtio-mmio")
        .unwrap();
    for i in 0..VIRTIO_MMIO_SLOTS {
        let (base, _) = l.virtio_slot(i).unwrap();
        assert!(window.contains(base) && window.contains(base + VIRTIO_MMIO_STRIDE - 1));
        assert_eq!(l.find(base).map(|r| r.name), Some("virtio-mmio"));
    }
}

#[test]
fn ipa_bits() {
    let l = Layout::virt();
    assert_eq!(l.ipa_bits_needed(0x6000_0000), 36);
    assert_eq!(l.ipa_bits_needed(0x40_0000_0000), 38);
    assert_eq!(
        l.ipa_bits_needed(1 << 36),
        36,
        "exactly 2^36 still fits 36 bits"
    );
    assert_eq!(l.ipa_bits_needed((1 << 36) + 1), 37);
    assert_eq!(l.ipa_bits_needed(0), 36, "never below the HVF default");
    assert_eq!(l.ipa_bits_needed(u64::MAX), 64);
    // Every legal RAM size gives a table that validates at the computed width (MEM-8).
    for size in [RAM_MIN, RAM_DEFAULT, 4 << 30, RAM_MAX] {
        let end = l.ram_end(size).unwrap();
        let bits = l.ipa_bits_needed(end);
        assert!(bits <= 38, "{size:#x}: {bits}");
        RegionTable::new(&[(GuestAddress(RAM_BASE), size)], bits).unwrap();
    }
}

#[test]
fn dt_unit_addresses_derive_from_base() {
    for r in all() {
        let ua = r.unit_address();
        assert_eq!(u64::from_str_radix(&ua, 16).unwrap(), r.base, "{}", r.name);
        assert_eq!(ua, ua.to_lowercase());
        assert!(
            !ua.starts_with("0x") && (ua == "0" || !ua.starts_with('0')),
            "{ua}"
        );
    }
    let by = |n: &str| {
        VIRT_REGIONS
            .iter()
            .find(|r| r.name == n)
            .unwrap()
            .unit_address()
    };
    // The node names Linux and U-Boot expect (architecture §12.2, PLAN §1).
    assert_eq!(format!("pl011@{}", by("pl011")), "pl011@9000000");
    assert_eq!(format!("pl031@{}", by("pl031")), "pl031@9010000");
    assert_eq!(format!("intc@{}", by("gicd")), "intc@8000000");
    assert_eq!(
        format!("memory@{}", ram_max().unit_address()),
        "memory@40000000"
    );
    let (slot1, _) = Layout::virt().virtio_slot(1).unwrap();
    assert_eq!(format!("virtio_mmio@{slot1:x}"), "virtio_mmio@a000200");
}

#[test]
fn gic_frames_fit_their_window() {
    let l = Layout::virt();
    let gicr = VIRT_REGIONS.iter().find(|r| r.name == "gicr").unwrap();
    assert_eq!((gicr.base, gicr.end()), (GICR_BASE, GICR_WINDOW_END));
    let max = l.gicr_size(MAX_CPUS).unwrap();
    assert!(GICR_BASE + max <= GICR_WINDOW_END);
    assert_eq!(l.gicr_size(MAX_CPUS + 1), None);
    // The in-kernel GIC needs 64 KiB-aligned bases (spike finding 15).
    assert_eq!(GICD_BASE % 0x1_0000, 0);
    assert_eq!(GICR_BASE % 0x1_0000, 0);
}

#[test]
fn find_and_ram_limits() {
    let l = Layout::virt();
    for r in VIRT_REGIONS {
        assert_eq!(l.find(r.base).map(|x| x.name), Some(r.name));
        assert_eq!(l.find(r.end() - 1).map(|x| x.name), Some(r.name));
    }
    assert_eq!(l.find(RAM_BASE), None, "RAM is not a static region");
    assert_eq!(l.find(0x0e00_0000), None, "gap after the probe hole");
    assert_eq!(l.find(u64::MAX), None);
    assert_eq!(l.ram_end(RAM_DEFAULT), Ok(RAM_BASE + (512 << 20)));
    assert!(l.ram_end(RAM_MIN - RAM_ALIGN).is_err());
    assert!(l.ram_end(RAM_MAX + RAM_ALIGN).is_err());
    assert!(l.ram_end(RAM_DEFAULT + 0x4000).is_err());
    // The test-guest link address leaves exactly the 512 KiB DTB slot.
    assert_eq!(TEST_GUEST_BASE - RAM_BASE, DTB_MAX_TEST_GUEST);
}
