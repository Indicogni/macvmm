// Checkpoint 09 contract, frozen from the reference test crates/vmm/tests/pl031_regs.rs.
// It names only items the chapter 09 lesson teaches; the harness runs it against your crates.
//! Host test: the PL031 real-time clock (host acceptance; ARM DDI 0224B §3.3;
//! threat model: docs/security/threat-model.md).
//!
//! The host clock is injected, so "DR advances with host time" is exact, and the wrapping u32
//! arithmetic of `LR` is checked at the edges.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl031::{CR, DR, ICR, IMSC, LR, MIS, MR, PL031_SIZE, Pl031, RIS, host_clock};
use vmm::irq::TestIrq;

fn rtc(start: u64) -> (Pl031, Arc<AtomicU64>, Arc<TestIrq>) {
    let now = Arc::new(AtomicU64::new(start));
    let n = Arc::clone(&now);
    let irq = Arc::new(TestIrq::new());
    let dev = Pl031::with_clock(Box::new(move || n.load(Ordering::SeqCst)), irq.clone());
    (dev, now, irq)
}

fn r(d: &mut Pl031, off: u64) -> u64 {
    d.read(off, AccessSize::B4)
}

#[test]
fn dr_follows_the_host_clock() {
    let (mut d, now, _) = rtc(1_800_000_000);
    assert_eq!(r(&mut d, DR), 1_800_000_000);
    now.store(1_800_000_042, Ordering::SeqCst);
    assert_eq!(r(&mut d, DR), 1_800_000_042);
    assert_eq!(r(&mut d, CR), 1, "the counter always runs");
    // DR is read-only.
    d.write(DR, AccessSize::B4, 5);
    assert_eq!(r(&mut d, DR), 1_800_000_042);
    // The real clock is after 2025-01-01 (1735689600).
    let real = Pl031::new(Arc::new(TestIrq::new()));
    assert!(real.dr() >= 1_735_689_600, "{}", real.dr());
    assert!(host_clock()() >= 1_735_689_600);
}

#[test]
fn lr_write_shifts_dr_with_wrapping_seconds() {
    let (mut d, now, _) = rtc(1_000);
    d.write(LR, AccessSize::B4, 5_000);
    assert_eq!(r(&mut d, DR), 5_000);
    assert_eq!(r(&mut d, LR), 5_000);
    now.store(1_010, Ordering::SeqCst);
    assert_eq!(r(&mut d, DR), 5_010);
    // Set it into the past, and near the u32 edge: it wraps, it never overflows (MMIO-9).
    d.write(LR, AccessSize::B4, 0xffff_fff0);
    now.store(1_010 + 0x20, Ordering::SeqCst);
    assert_eq!(r(&mut d, DR), 0x10);
    d.write(LR, AccessSize::B4, 0);
    assert_eq!(r(&mut d, DR), 0);
    // A host clock past 2^32 seconds keeps its low 32 bits.
    let (mut far, _, _) = rtc(u64::MAX);
    assert_eq!(r(&mut far, DR), 0xffff_ffff);
}

#[test]
fn match_interrupt_level() {
    let (mut d, now, irq) = rtc(100);
    d.write(MR, AccessSize::B4, 105);
    d.write(IMSC, AccessSize::B4, 1);
    assert_eq!(r(&mut d, RIS), 0);
    now.store(105, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 1);
    assert_eq!(r(&mut d, MIS), 1);
    assert!(irq.level());
    d.write(ICR, AccessSize::B4, 1);
    assert_eq!(r(&mut d, RIS), 0);
    assert!(!irq.level());
    assert_eq!(irq.transitions(), vec![true, false]);
    // A match fires once per MR write.
    now.store(200, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 0);
    // An MR in the past does not fire: the PL031 matches on *equality*, so it is 2^32 - 50 s
    // away (ARM DDI 0224B §3.3.2; QEMU `pl031_set_alarm`).
    d.write(MR, AccessSize::B4, 150);
    now.store(10_000, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 0);
    // ...until the counter comes round again.
    now.store(200 + (1u64 << 32) - 50, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 1);
    d.write(ICR, AccessSize::B4, 1);
    // Masked: RIS set, MIS and the line not. MR == DR fires at once.
    d.write(IMSC, AccessSize::B4, 0);
    let dr = u32::try_from(r(&mut d, DR)).unwrap();
    d.write(MR, AccessSize::B4, u64::from(dr));
    assert_eq!(r(&mut d, RIS), 1);
    assert_eq!(r(&mut d, MIS), 0);
    assert!(!irq.level());
}

/// The match across the u32 wrap, and LR re-arming it from the new counter value.
#[test]
fn match_wraps_and_lr_rearms() {
    let (mut d, now, _) = rtc(1_000);
    d.write(LR, AccessSize::B4, 0xffff_fff0);
    d.write(ICR, AccessSize::B4, 1);
    d.write(MR, AccessSize::B4, 0x10); // 0x20 s ahead, across the wrap
    now.store(1_000 + 0x1f, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 0);
    now.store(1_000 + 0x20, Ordering::SeqCst);
    assert_eq!(r(&mut d, DR), 0x10);
    assert_eq!(r(&mut d, RIS), 1);
    d.write(ICR, AccessSize::B4, 1);
    // An LR write that jumps DR over MR does not fire (the counter never equalled MR)...
    d.write(MR, AccessSize::B4, 0x100);
    d.write(LR, AccessSize::B4, 0x200);
    assert_eq!(r(&mut d, RIS), 0);
    // ...and one that sets DR below MR re-arms the match from the new value.
    d.write(LR, AccessSize::B4, 0xf0);
    let t = 1_000 + 0x20;
    now.store(t + 0x0f, Ordering::SeqCst);
    assert_eq!(r(&mut d, RIS), 0);
    now.store(t + 0x10, Ordering::SeqCst);
    assert_eq!(r(&mut d, DR), 0x100);
    assert_eq!(r(&mut d, RIS), 1);
}

/// The real clock is read on every access (so it is right after host sleep) and never runs
/// backwards.
#[test]
fn host_clock_is_the_wall_clock_and_monotonic() {
    let c = host_clock();
    let a = c();
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let b = c();
    assert!(b >= a);
    assert!(b.abs_diff(wall) <= 1, "{b} vs {wall}");
}

#[test]
fn identification_registers() {
    let (mut d, _, _) = rtc(0);
    let want = [0x31u64, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];
    for (i, w) in want.iter().enumerate() {
        assert_eq!(r(&mut d, 0xfe0 + 4 * i as u64), *w);
    }
}

/// PLAN M6 security test (MMIO-8): every offset × every width, reads and writes, no panic.
#[test]
fn every_offset_and_width_is_total() {
    let (mut d, now, _) = rtc(7);
    for size in [
        AccessSize::B1,
        AccessSize::B2,
        AccessSize::B4,
        AccessSize::B8,
    ] {
        let mut off = 0u64;
        while off + size.bytes() <= PL031_SIZE {
            let v = d.read(off, size);
            assert_eq!(v & !size.mask(), 0);
            d.write(off, size, u64::MAX);
            off += 1;
        }
    }
    now.store(u64::MAX, Ordering::SeqCst);
    let _ = d.read(DR, AccessSize::B4);
    assert_eq!(d.read(0xfe0, AccessSize::B8), 0, "64-bit: RAZ");
}
