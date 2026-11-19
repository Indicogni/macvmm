//! Host test: the PL031 match interrupt rises **without a register access** (PLAN M8: the RTC
//! is wired to `GicSpi(34)`, architecture §10 "the match interrupt drives a level line";
//! `devices/pl031.rs` module docs, "Who notices the match").
//!
//! A guest that arms an alarm (`MR`, then `IMSC`) and waits for the interrupt never touches the
//! RTC again; the device's alarm thread must notice the match on its own. The host clock is
//! injected, so the test moves time and only watches the line.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl031::{DR, ICR, IMSC, MR, Pl031, RIS};
use vmm::irq::TestIrq;

fn rtc(start: u64) -> (Pl031, Arc<AtomicU64>, Arc<TestIrq>) {
    let now = Arc::new(AtomicU64::new(start));
    let n = Arc::clone(&now);
    let irq = Arc::new(TestIrq::new());
    let dev = Pl031::with_clock(Box::new(move || n.load(Ordering::SeqCst)), irq.clone());
    (dev, now, irq)
}

/// Wait up to `limit` for the line to reach `level`, touching nothing but the `TestIrq`.
fn wait_level(irq: &TestIrq, level: bool, limit: Duration) -> bool {
    let t0 = Instant::now();
    while t0.elapsed() < limit {
        if irq.level() == level {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    irq.level() == level
}

#[test]
fn alarm_raises_the_line_without_an_access() {
    let (mut d, now, irq) = rtc(1_000);
    d.write(MR, AccessSize::B4, 1_002);
    d.write(IMSC, AccessSize::B4, 1);
    assert!(!irq.level());
    now.store(1_001, Ordering::SeqCst);
    assert!(
        !wait_level(&irq, true, Duration::from_millis(300)),
        "fired a second early"
    );
    // The match second comes; no register is touched from here until the line is seen.
    now.store(1_002, Ordering::SeqCst);
    assert!(
        wait_level(&irq, true, Duration::from_secs(2)),
        "the alarm thread never raised the line"
    );
    assert_eq!(irq.transitions(), vec![true]);
    // The guest's handler then sees RIS and clears it, which drops the level line.
    assert_eq!(d.read(RIS, AccessSize::B4), 1);
    d.write(ICR, AccessSize::B4, 1);
    assert!(!irq.level());
}

/// A masked alarm still sets RIS on its own, but the line stays low; unmasking raises it.
#[test]
fn masked_alarm_sets_ris_only() {
    let (mut d, now, irq) = rtc(50);
    d.write(MR, AccessSize::B4, 51);
    let calls = irq.calls();
    now.store(51, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(400));
    assert!(!irq.level());
    assert!(
        irq.calls() > calls,
        "the alarm thread drove the (masked) line"
    );
    d.write(IMSC, AccessSize::B4, 1);
    assert!(irq.level());
    assert_eq!(d.read(RIS, AccessSize::B4), 1);
}

/// A far alarm (an MR in the past is ~136 years away) and a hostile clock never panic the
/// thread, and dropping the device joins it promptly.
#[test]
fn far_alarm_and_drop() {
    let (mut d, now, irq) = rtc(10_000);
    d.write(MR, AccessSize::B4, 5); // in the past: 2^32 - 9_995 s ahead
    now.store(u64::MAX, Ordering::SeqCst); // past any deadline: fires, saturating
    std::thread::sleep(Duration::from_millis(300));
    assert!(!irq.level(), "IMSC masks it");
    assert_eq!(d.read(RIS, AccessSize::B4), 1);
    let _ = d.read(DR, AccessSize::B4);
    let t0 = Instant::now();
    drop(d);
    assert!(
        t0.elapsed() < Duration::from_secs(1),
        "drop joins the alarm thread"
    );
}
