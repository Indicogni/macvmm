// Checkpoint 08 contract, frozen from the reference test crates/vmm/tests/psci_state.rs.
// It names only items the chapter 08 lesson teaches; the harness runs it against your crates.
//! Host test: the PSCI per-vCPU state machine (host acceptance;
//! Arm DEN 0022 §5.1.3–5.1.5; threat model: docs/security/threat-model.md).
//!
//! Every transition: `Off → OnPending` by CPU_ON, `OnPending → On` when the target takes its
//! mailbox, `On → Off` by CPU_OFF; and every refusal: ALREADY_ON (-4), ON_PENDING (-5), an
//! unknown or malformed MPIDR (-2), an entry point outside RAM or misaligned (-9, decided by
//! the SMCCC layer and passed in here), AFFINITY_INFO level > 0 (-2). A racing CPU_ON storm
//! from several threads starts the target exactly once.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::psci::{CpuPower, Psci, PsciError, code};

/// Four vCPUs with the MPIDRs `vcpu::mpidr_for` gives (bit 31 RES1).
fn four() -> Psci {
    Psci::new(&[0x8000_0000, 0x8000_0001, 0x8000_0002, 0x8000_0003])
}

#[test]
fn initial_states() {
    let p = four();
    assert_eq!(p.len(), 4);
    assert_eq!(p.state(0), Some(CpuPower::On), "the boot vCPU");
    for i in 1..4 {
        assert_eq!(p.state(i), Some(CpuPower::Off));
    }
    assert_eq!(p.state(4), None);
    assert_eq!(p.affinity_info(0, 0).map(CpuPower::affinity_info), Ok(0));
    assert_eq!(p.affinity_info(2, 0).map(CpuPower::affinity_info), Ok(1));
}

#[test]
fn every_transition() {
    let p = four();
    // Off → OnPending.
    assert_eq!(p.cpu_on(1, 0x4008_0000, 0xc7, true), Ok(1));
    assert_eq!(p.state(1), Some(CpuPower::OnPending));
    assert_eq!(p.affinity_info(1, 0).map(CpuPower::affinity_info), Ok(2));
    // A second CPU_ON while pending: ON_PENDING (-5), and the first request is kept.
    assert_eq!(p.cpu_on(1, 0x4009_0000, 0, true), Err(PsciError::OnPending));
    assert_eq!(PsciError::OnPending.code(), code::ON_PENDING);
    // OnPending → On: the target's thread takes the mailbox once.
    let on = p.take_power_on(1).unwrap();
    assert_eq!((on.entry, on.ctx), (0x4008_0000, 0xc7));
    assert_eq!(p.take_power_on(1), None);
    assert_eq!(p.state(1), Some(CpuPower::On));
    // On: ALREADY_ON (-4).
    assert_eq!(p.cpu_on(1, 0x4008_0000, 0, true), Err(PsciError::AlreadyOn));
    assert_eq!(p.cpu_on(0, 0x4008_0000, 0, true), Err(PsciError::AlreadyOn));
    assert_eq!(PsciError::AlreadyOn.code(), code::ALREADY_ON);
    // On → Off by CPU_OFF; then it can be started again.
    assert!(p.cpu_off(1));
    assert!(!p.cpu_off(1), "already off");
    assert_eq!(p.state(1), Some(CpuPower::Off));
    assert_eq!(p.cpu_on(1, 0x4008_0000, 0, true), Ok(1));
    // The machine is all-off only when every vCPU is.
    let p = Psci::new(&[0x8000_0000]);
    assert!(!p.all_off());
    assert!(p.cpu_off(0));
    assert!(p.all_off());
}

#[test]
fn invalid_mpidr_is_minus_two() {
    let p = four();
    for target in [
        4u64,          // no such vCPU
        0x100,         // Aff1 = 1: none
        0x8000_0001,   // bit 31 is not an affinity field
        0x1_0000_0000, // Aff3 = 1: none
        1 << 40,       // above Aff3
        u64::MAX,
    ] {
        assert_eq!(
            p.cpu_on(target, 0x4008_0000, 0, true),
            Err(PsciError::InvalidParameters),
            "{target:#x}"
        );
        assert_eq!(
            p.affinity_info(target, 0),
            Err(PsciError::InvalidParameters),
            "{target:#x}"
        );
    }
    assert_eq!(PsciError::InvalidParameters.code(), -2);
    assert_eq!(PsciError::InvalidParameters.reg(), u64::MAX - 1);
}

#[test]
fn invalid_entry_is_minus_nine() {
    let p = four();
    assert_eq!(
        p.cpu_on(2, 0x1000, 0, false),
        Err(PsciError::InvalidAddress)
    );
    assert_eq!(PsciError::InvalidAddress.code(), code::INVALID_ADDRESS);
    assert_eq!(PsciError::InvalidAddress.code(), -9);
    assert_eq!(
        p.state(2),
        Some(CpuPower::Off),
        "a refused CPU_ON changes nothing"
    );
    // The MPIDR is checked first: an unknown target with a bad entry is -2.
    assert_eq!(p.cpu_on(9, 0, 0, false), Err(PsciError::InvalidParameters));
}

#[test]
fn affinity_level_above_zero_is_minus_two() {
    let p = four();
    for level in [1u64, 2, 3, u64::MAX] {
        assert_eq!(p.affinity_info(0, level), Err(PsciError::InvalidParameters));
    }
}

/// HC-3: eight threads race 1000 CPU_ONs each at one Off vCPU; exactly one succeeds.
#[test]
fn racing_cpu_on_starts_once() {
    let p = Arc::new(four());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let p = Arc::clone(&p);
            std::thread::spawn(move || {
                (0..1000)
                    .filter(|_| p.cpu_on(3, 0x4008_0000, 0, true).is_ok())
                    .count()
            })
        })
        .collect();
    let wins: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
    assert_eq!(wins, 1);
    assert_eq!(p.state(3), Some(CpuPower::OnPending));
}

#[test]
fn park_returns_on_power_on_or_stop() {
    let p = Arc::new(four());
    let p2 = Arc::clone(&p);
    let t = std::thread::spawn(move || p2.park(2, || false));
    std::thread::sleep(std::time::Duration::from_millis(10));
    assert_eq!(p.cpu_on(2, 0x4008_0000, 5, true), Ok(2));
    assert_eq!(t.join().unwrap().map(|on| on.ctx), Some(5));
    assert_eq!(p.state(2), Some(CpuPower::On));
    // A stop flag that is already set returns at once.
    assert_eq!(p.park(1, || true), None);
}
