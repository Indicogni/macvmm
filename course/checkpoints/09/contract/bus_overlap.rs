// Checkpoint 09 contract (PLAN M27 L1), frozen from the reference test crates/vmm/tests/bus_overlap.rs.
// It names only items the chapter 09 lesson teaches; the harness runs it against your crates.
//! Host test: building the MMIO bus (PLAN M6 "Acceptance: host"; architecture §6.2; threat
//! model MMIO-7).
//!
//! The bus is built once per boot from the device table, so these are the rules that make
//! "at most one device owns an address" true: overlapping windows are refused, adjacent ones
//! are fine, an empty window or one whose end overflows `u64` is refused, and an access that
//! starts inside a device but runs past its end is `Straddle` (the caller treats it like an
//! unmapped access, so no device ever sees a partial access). The machine's real devices are
//! checked too: `register_platform` and `register_devices` never collide.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use vmm::backend::serial::{SerialInput, Sink};
use vmm::bus::{AccessSize, Bus, BusError, MmioDevice};
use vmm::config::VmConfig;
use vmm::devices::razwi::RazWi;
use vmm::machine::virt;

fn dev() -> Arc<Mutex<RazWi>> {
    Arc::new(Mutex::new(RazWi::new("t")))
}

#[test]
fn overlap_is_rejected_adjacent_is_ok() {
    let mut b = Bus::new();
    b.insert("a", 0x1000, 0x1000, dev()).unwrap();
    b.insert("b", 0x2000, 0x1000, dev()).unwrap(); // adjacent above
    b.insert("z", 0x0800, 0x0800, dev()).unwrap(); // adjacent below
    for (base, size) in [(0x1fff, 1), (0x0fff, 2), (0x1800, 0x10), (0x0, 0x10_0000)] {
        let e = b.insert("x", base, size, dev()).unwrap_err();
        assert!(
            matches!(e, BusError::Overlap { .. }),
            "{base:#x}+{size:#x}: {e}"
        );
    }
    assert_eq!(b.len(), 3);
    assert_eq!(b.device_at(0x1fff), Some(("a", 0xfff)));
    assert_eq!(b.device_at(0x2000), Some(("b", 0)));
}

#[test]
fn size_zero_and_overflow_are_rejected() {
    let mut b = Bus::new();
    assert!(matches!(
        b.insert("zero", 0x1000, 0, dev()),
        Err(BusError::InvalidRange { .. })
    ));
    assert!(matches!(
        b.insert("wrap", u64::MAX - 1, 3, dev()),
        Err(BusError::InvalidRange { .. })
    ));
    assert!(matches!(
        b.insert("huge", 1, u64::MAX, dev()),
        Err(BusError::InvalidRange { .. })
    ));
    assert!(b.is_empty());
    b.insert("top", u64::MAX - 0xff, 0xff, dev()).unwrap(); // ends exactly at u64::MAX
}

#[test]
fn straddling_access_is_straddle() {
    let mut b = Bus::new();
    b.insert("d", 0x1000, 0x10, dev()).unwrap();
    assert_eq!(b.read(0x100c, AccessSize::B4), Ok(0));
    assert_eq!(
        b.read(0x100d, AccessSize::B4),
        Err(BusError::Straddle {
            ipa: 0x100d,
            size: AccessSize::B4
        })
    );
    assert_eq!(
        b.write(0x1009, AccessSize::B8, 0),
        Err(BusError::Straddle {
            ipa: 0x1009,
            size: AccessSize::B8
        })
    );
    assert_eq!(
        b.read(0x1010, AccessSize::B1),
        Err(BusError::Unmapped { ipa: 0x1010 })
    );
    assert_eq!(
        b.read(u64::MAX, AccessSize::B8),
        Err(BusError::Unmapped { ipa: u64::MAX })
    );
}

/// The real board: the platform devices and the optional test device fit together, and a
/// second registration is an overlap error, never a panic.
#[test]
fn machine_devices_do_not_overlap() {
    let mut b = Bus::new();
    let sink = Arc::new(Sink::none());
    let input = Arc::new(SerialInput::new());
    let mut cfg = VmConfig::default();
    cfg.testdev = true;
    virt::register_devices(&cfg, &mut b).unwrap();
    virt::register_platform(&mut b, &sink, &input, 1).unwrap();
    assert_eq!(b.len(), 4, "{b:?}");
    assert!(matches!(
        virt::register_platform(&mut b, &sink, &input, 1),
        Err(vmm::Error::Bus(BusError::Overlap { .. }))
    ));
}

/// A device that sees an access learns only an offset and size inside its window.
#[test]
fn devices_only_see_accesses_inside_their_window() {
    struct Check(u64);
    impl MmioDevice for Check {
        fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
            assert!(offset + size.bytes() <= self.0);
            0
        }
        fn write(&mut self, offset: u64, size: AccessSize, _v: u64) {
            assert!(offset + size.bytes() <= self.0);
        }
    }
    let mut b = Bus::new();
    b.insert("c", 0x9000, 0x1000, Arc::new(Mutex::new(Check(0x1000))))
        .unwrap();
    for ipa in 0x8ff0..0xa010u64 {
        for size in [
            AccessSize::B1,
            AccessSize::B2,
            AccessSize::B4,
            AccessSize::B8,
        ] {
            let _ = b.read(ipa, size);
            let _ = b.write(ipa, size, u64::MAX);
        }
    }
}
