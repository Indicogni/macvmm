// Checkpoint 03 contract, frozen from the reference test crates/vmm/tests/raw_loader.rs.
// It names only items the chapter 03 lesson teaches; the harness runs it against your crates.
//! `--raw F@ADDR` parsing and placement (host acceptance; threat model: docs/security/threat-model.md).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::loader::plan::{self, BootInputs};
use vmm::loader::raw::{RawSpecError, check_placement, parse_spec};
use vmm::loader::{LoaderError, RamRange};

/// PLAN §1, spelled here because `arch::layout` is chapter 05's: RAM at 1 GiB, and test guests
/// load 512 KiB above it (the DTB's space comes first).
const RAM_BASE: u64 = 0x4000_0000;
const TEST_GUEST_BASE: u64 = 0x4008_0000;

const RAM: RamRange = RamRange {
    base: RAM_BASE,
    size: 64 << 20,
};

fn blob(n: usize) -> Arc<[u8]> {
    vec![0x5a; n].into()
}

#[test]
fn parses_file_at_address() {
    let s = parse_spec("F@0x40080000").unwrap();
    assert_eq!(s.path.to_str(), Some("F"));
    assert_eq!(s.addr, TEST_GUEST_BASE);
    assert_eq!(
        parse_spec("dir/with@sign.bin@0x4008_0000").unwrap().addr,
        0x4008_0000
    );
}

#[test]
fn missing_at() {
    assert_eq!(parse_spec("F0x40080000"), Err(RawSpecError::MissingAt));
    assert_eq!(parse_spec(""), Err(RawSpecError::MissingAt));
}

#[test]
fn non_hex_or_unprefixed_address() {
    assert_eq!(
        parse_spec("F@40080000"),
        Err(RawSpecError::MissingHexPrefix)
    );
    assert_eq!(parse_spec("F@0xg0080000"), Err(RawSpecError::BadAddress));
    assert_eq!(parse_spec("F@0x-1"), Err(RawSpecError::BadAddress));
    assert_eq!(parse_spec("F@0x 1"), Err(RawSpecError::BadAddress));
    assert_eq!(
        parse_spec("F@0x10000000000000000"),
        Err(RawSpecError::BadAddress)
    );
}

#[test]
fn address_outside_ram() {
    for addr in [0, 0x0c00_0000, RAM_BASE - 1, RAM.base + RAM.size, u64::MAX] {
        assert!(
            matches!(
                check_placement(RAM, 0, addr, 4),
                Err(LoaderError::OutsideRam { .. })
            ),
            "{addr:#x}"
        );
    }
}

#[test]
fn file_larger_than_remaining_ram() {
    let end = RAM.base + RAM.size;
    assert!(check_placement(RAM, 0, end - 4, 4).is_ok());
    assert!(matches!(
        check_placement(RAM, 0, end - 4, 5),
        Err(LoaderError::OutsideRam { .. })
    ));
    let raw = vec![(TEST_GUEST_BASE, blob((64 << 20) - (512 << 10) + 1))];
    let inputs = BootInputs {
        kernel: None,
        raw: &raw,
        ..BootInputs::default()
    };
    assert!(matches!(
        plan::plan(RAM, &inputs),
        Err(LoaderError::OutsideRam { .. })
    ));
}

#[test]
fn overlaps_and_entry() {
    // Into the DTB slot.
    let raw = vec![(RAM_BASE, blob(4))];
    let inputs = BootInputs {
        kernel: None,
        raw: &raw,
        ..BootInputs::default()
    };
    assert!(matches!(
        plan::plan(RAM, &inputs),
        Err(LoaderError::OverlapsDtb { .. })
    ));
    // Two blobs on top of each other.
    let raw = vec![(TEST_GUEST_BASE, blob(16)), (TEST_GUEST_BASE + 8, blob(16))];
    let inputs = BootInputs {
        kernel: None,
        raw: &raw,
        ..BootInputs::default()
    };
    assert!(matches!(
        plan::plan(RAM, &inputs),
        Err(LoaderError::Overlap { .. })
    ));
    // Adjacent blobs are fine; the first is the entry.
    let raw = vec![
        (TEST_GUEST_BASE + 16, blob(16)),
        (TEST_GUEST_BASE, blob(16)),
    ];
    let inputs = BootInputs {
        kernel: None,
        raw: &raw,
        ..BootInputs::default()
    };
    let p = plan::plan(RAM, &inputs).unwrap();
    assert_eq!(p.entry, TEST_GUEST_BASE + 16);
    assert_eq!(
        plan::plan(
            RAM,
            &BootInputs {
                kernel: None,
                raw: &[],
                ..BootInputs::default()
            }
        ),
        Err(LoaderError::NoImage)
    );
}
