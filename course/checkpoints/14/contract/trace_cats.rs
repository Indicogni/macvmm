// Checkpoint 14 contract: the two debugging affordances of chapter 14, host only.
// It names only items the chapter 14 lesson teaches; the harness runs it against your crates.
//! 1. `TraceCats::parse` reads a comma-separated list of categories into one set, refuses an
//!    unknown name and an empty list, and `selects` keeps an exit of any listed category.
//! 2. `HostCtl` keeps only a weak reference to each vCPU's `ExitRing`: once the vCPU's own
//!    `Arc` is gone, a dump no longer shows that ring, even if nobody unregistered it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::hostctl::HostCtl;
use vmm::trace::{ExitRing, TraceCats};

#[test]
fn comma_list_is_a_union() {
    assert_eq!(TraceCats::parse("hvc"), Some(TraceCats::HVC));
    assert_eq!(
        TraceCats::parse("hvc,sysreg"),
        Some(TraceCats::HVC.union(TraceCats::SYSREG))
    );
    assert_eq!(
        TraceCats::parse("sysreg,hvc"),
        TraceCats::parse("hvc,sysreg"),
        "order does not matter"
    );
    assert_eq!(TraceCats::parse("all"), Some(TraceCats::ALL));
    assert_eq!(TraceCats::parse("mmio,all"), Some(TraceCats::ALL));
}

#[test]
fn unknown_or_empty_is_refused() {
    for bad in ["", ",", "hvc,", ",hvc", "hvc,bogus", "HVC", "hvc sysreg"] {
        assert_eq!(TraceCats::parse(bad), None, "{bad:?}");
    }
}

#[test]
fn a_dump_never_keeps_a_ring_alive() {
    let host = HostCtl::new();
    let ring = Arc::new(ExitRing::new());
    host.register_ring(0, &ring);
    assert!(
        host.dump_rings().contains("vcpu0:"),
        "a registered ring is dumped"
    );
    host.unregister_ring(0);
    assert!(
        !host.dump_rings().contains("vcpu0:"),
        "an unregistered ring is not"
    );
    host.register_ring(1, &ring);
    assert_eq!(
        Arc::strong_count(&ring),
        1,
        "the registry holds no strong reference"
    );
    drop(ring);
    assert!(
        !host.dump_rings().contains("vcpu1:"),
        "a ring whose vCPU dropped it is skipped, not resurrected"
    );
}
