//! PSCI power state: which vCPUs are on, and the CPU_ON mailbox (architecture §8.1, §8.6;
//! course ch08; threat model HC-3, HC-4).
//!
//! **What PSCI is** (Arm DEN 0022, Power State Coordination Interface 1.1). An OS does not
//! start or stop CPUs by poking hardware; it asks firmware through SMCCC calls. Under a
//! hypervisor the "firmware" is the VMM: `hvc #0` with a PSCI function ID traps to us
//! (`smccc.rs`), and this module holds the state those calls act on.
//!
//! **The per-vCPU state machine** (DEN 0022 §5.1.4 CPU_ON, §5.1.5 AFFINITY_INFO, §5.1.3
//! CPU_OFF):
//!
//! ```text
//!            CPU_ON(target) by another vCPU        the target's thread takes the PowerOn
//!   Off  ───────────────────────────────────▶ OnPending ──────────────────────────────▶ On
//!    ▲                                                                                  │
//!    └──────────────────────────── CPU_OFF (by the vCPU itself) ────────────────────────┘
//! ```
//!
//! - `CPU_ON` on an `On` target is `ALREADY_ON` (-4), on an `OnPending` one `ON_PENDING` (-5),
//!   so a guest racing two CPU_ONs for one CPU gets a defined error, never a double start
//!   (HC-3). Every transition of a target happens under that target's mutex.
//! - An unknown MPIDR is `INVALID_PARAMETERS` (-2), and an entry point outside RAM (and, from
//!   M18, ROM) or not 4-byte aligned is `INVALID_ADDRESS` (-9) (HC-3).
//! - `AFFINITY_INFO` answers 0 (ON), 1 (OFF) or 2 (ON_PENDING) for level 0; any higher
//!   affinity level is `INVALID_PARAMETERS` (HC-4).
//!
//! **MPIDR matching.** A PSCI `target_cpu` carries only the affinity fields (`Aff3` in bits
//! 39:32, `Aff2..Aff0` in 23:0, DEN 0022 §5.1.4); the DT `cpu@N/reg` a kernel reads them from
//! has no bit 31. A target with any other bit set is `INVALID_PARAMETERS`.
//!
//! **One mutex per target** (M16, threat model HC-3 "under races"). With SMP, several vCPU
//! threads make PSCI calls at the same time, each on its own host thread (CLAUDE.md: one host
//! thread per vCPU). Each target vCPU has its own `Mutex<TargetState>` and `Condvar`: the
//! check-then-transition of a CPU_ON is atomic for that target, and CPU_ONs for different
//! targets never contend. The MPIDR table is immutable after [`Psci::new`], so looking a
//! target up takes no lock at all. Lock order: a thread holds at most one target lock at a
//! time and never takes a device lock under it (architecture §14.2).
//!
//! **Parking.** A vCPU that is off waits in [`Psci::park`] on its target's condition variable
//! (`vcpu/wait.rs`), outside `hv_vcpu_run`. It wakes for its `PowerOn` or for a VM stop
//! ([`Psci::wake_all`], called by `VmControl::request_stop` after it set the stop flag, so a
//! wake cannot be lost). Every secondary vCPU starts parked (architecture §8.1 step 4): with
//! `--cpus N` the table has N rows, created once, and a CPU_ON only fills a mailbox.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::sync::lock;
use std::sync::{Condvar, Mutex};

/// The MPIDR affinity fields a PSCI `target_cpu` may use: Aff3 (39:32) and Aff2..Aff0 (23:0).
pub const AFFINITY_MASK: u64 = 0xff_00ff_ffff;

/// PSCI return codes (DEN 0022 §5.2.2), as signed values.
pub mod code {
    pub const SUCCESS: i64 = 0;
    pub const NOT_SUPPORTED: i64 = -1;
    pub const INVALID_PARAMETERS: i64 = -2;
    pub const DENIED: i64 = -3;
    pub const ALREADY_ON: i64 = -4;
    pub const ON_PENDING: i64 = -5;
    pub const INTERNAL_FAILURE: i64 = -6;
    pub const NOT_PRESENT: i64 = -7;
    pub const DISABLED: i64 = -8;
    pub const INVALID_ADDRESS: i64 = -9;
}

/// A vCPU's power state (DEN 0022 §5.1.5, the AFFINITY_INFO return values).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CpuPower {
    On,
    Off,
    OnPending,
}

impl CpuPower {
    /// The AFFINITY_INFO return value: 0 ON, 1 OFF, 2 ON_PENDING.
    pub const fn affinity_info(self) -> u64 {
        match self {
            CpuPower::On => 0,
            CpuPower::Off => 1,
            CpuPower::OnPending => 2,
        }
    }
}

/// A CPU_ON request in flight: where the target starts and its `x0` (DEN 0022 §5.1.4
/// `entry_point_address`, `context_id`). The target starts with `CPSR = 0x3c5` and the MMU off.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PowerOn {
    pub entry: u64,
    pub ctx: u64,
}

/// Why a PSCI request was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PsciError {
    InvalidParameters,
    InvalidAddress,
    AlreadyOn,
    OnPending,
}

impl PsciError {
    /// The PSCI return code (module [`code`]).
    pub const fn code(self) -> i64 {
        match self {
            PsciError::InvalidParameters => code::INVALID_PARAMETERS,
            PsciError::InvalidAddress => code::INVALID_ADDRESS,
            PsciError::AlreadyOn => code::ALREADY_ON,
            PsciError::OnPending => code::ON_PENDING,
        }
    }

    /// The code as the register value the guest reads in `x0` (two's complement).
    pub const fn reg(self) -> u64 {
        self.code() as u64
    }
}

// ANCHOR: psci_target_state
/// One target vCPU's mutable PSCI state: its power state and its CPU_ON mailbox.
#[derive(Debug)]
struct TargetState {
    power: CpuPower,
    mailbox: Option<PowerOn>,
}

/// One target vCPU: its MPIDR (fixed for the boot) and its state behind **its own** mutex, with
/// the condition variable its thread parks on (module docs, "One mutex per target").
#[derive(Debug)]
struct Target {
    mpidr: u64,
    state: Mutex<TargetState>,
    wake: Condvar,
}

impl Target {
    /// `OnPending → On` if a `PowerOn` waits in the mailbox: take it.
    fn take(s: &mut TargetState) -> Option<PowerOn> {
        let on = s.mailbox.take()?;
        s.power = CpuPower::On;
        Some(on)
    }
}
// ANCHOR_END: psci_target_state

/// The power state of every vCPU of one boot, and their mailboxes.
#[derive(Debug)]
pub struct Psci {
    /// Indexed by vCPU index. The table itself never changes after [`Psci::new`] (all vCPUs
    /// exist from startup, architecture §8.1), so finding a target takes no lock.
    cpus: Box<[Target]>,
}

impl Default for Psci {
    /// One vCPU (MPIDR of index 0), on.
    fn default() -> Psci {
        Psci::new(&[crate::arch::regs::mpidr(0)])
    }
}

impl Psci {
    /// The vCPUs with these MPIDRs, by index. vCPU 0 (the boot CPU) starts `On`, every other
    /// one `Off` (architecture §8.1 step 4).
    pub fn new(mpidrs: &[u64]) -> Psci {
        let cpus = mpidrs
            .iter()
            .enumerate()
            .map(|(i, &mpidr)| Target {
                mpidr,
                state: Mutex::new(TargetState {
                    power: if i == 0 { CpuPower::On } else { CpuPower::Off },
                    mailbox: None,
                }),
                wake: Condvar::new(),
            })
            .collect();
        Psci { cpus }
    }

    /// The number of vCPUs.
    pub fn len(&self) -> usize {
        self.cpus.len()
    }

    /// True if there are no vCPUs (never, for a built machine).
    pub fn is_empty(&self) -> bool {
        self.cpus.is_empty()
    }

    // ANCHOR: psci_index_of
    /// The vCPU index whose MPIDR affinity equals `target`, or `INVALID_PARAMETERS` if
    /// `target` has bits outside [`AFFINITY_MASK`] or names no vCPU (HC-3: only created vCPUs
    /// are valid targets).
    // ANCHOR: psci_index_of_fn
    pub fn index_of(&self, target: u64) -> Result<usize, PsciError> {
        if target & !AFFINITY_MASK != 0 {
            return Err(PsciError::InvalidParameters);
        }
        self.cpus
            .iter()
            .position(|t| t.mpidr & AFFINITY_MASK == target)
            .ok_or(PsciError::InvalidParameters)
    }
    // ANCHOR_END: psci_index_of_fn
    // ANCHOR_END: psci_index_of

    fn target(&self, index: usize) -> Result<&Target, PsciError> {
        self.cpus.get(index).ok_or(PsciError::InvalidParameters)
    }

    /// vCPU `index`'s state, if it exists.
    pub fn state(&self, index: usize) -> Option<CpuPower> {
        self.cpus.get(index).map(|t| lock(&t.state).power)
    }

    // ANCHOR: psci_cpu_on
    // ANCHOR: psci_cpu_on_mailbox
    /// PSCI CPU_ON (DEN 0022 §5.1.4; HC-3). `entry_valid` is the caller's verdict on the entry
    /// point (in RAM or ROM, 4-byte aligned). On success the target goes `Off → OnPending`, its
    /// mailbox holds the `PowerOn`, its parked thread is woken, and its index is returned.
    ///
    /// The check of the state and the transition happen under the **target's** mutex, so of
    /// any number of racing CPU_ONs exactly one sees `Off` and wins; every other one sees
    /// `OnPending` (-5) or, once the target has taken its mailbox, `On` (-4). No thread is
    /// created here: the target's thread has existed since startup and only waits (a CPU_ON
    /// storm cannot spawn threads, threat model §10.2 M16).
    // ANCHOR: psci_cpu_on_fn
    pub fn cpu_on(
        &self,
        target: u64,
        entry: u64,
        ctx: u64,
        entry_valid: bool,
    ) -> Result<usize, PsciError> {
        let index = self.index_of(target)?;
        if !entry_valid {
            return Err(PsciError::InvalidAddress);
        }
        let t = self.target(index)?;
        let mut s = lock(&t.state);
        match s.power {
            CpuPower::On => Err(PsciError::AlreadyOn),
            CpuPower::OnPending => Err(PsciError::OnPending),
            CpuPower::Off => {
                s.power = CpuPower::OnPending;
                s.mailbox = Some(PowerOn { entry, ctx });
                drop(s);
                t.wake.notify_all();
                Ok(index)
            }
        }
    }
    // ANCHOR_END: psci_cpu_on_fn
    // ANCHOR_END: psci_cpu_on_mailbox
    // ANCHOR_END: psci_cpu_on

    // ANCHOR: psci_affinity_cpu_off
    /// PSCI AFFINITY_INFO (DEN 0022 §5.1.5; HC-4): the state of `target` at affinity level 0.
    /// A higher level is `INVALID_PARAMETERS`.
    // ANCHOR: psci_affinity_cpu_off_fn
    pub fn affinity_info(&self, target: u64, level: u64) -> Result<CpuPower, PsciError> {
        if level != 0 {
            return Err(PsciError::InvalidParameters);
        }
        let index = self.index_of(target)?;
        Ok(lock(&self.target(index)?.state).power)
    }

    /// PSCI CPU_OFF (DEN 0022 §5.1.3) by vCPU `index`: `On → Off`. Returns false if the vCPU
    /// was not on (a VMM bug: only a running vCPU can make the call).
    pub fn cpu_off(&self, index: usize) -> bool {
        let Some(t) = self.cpus.get(index) else {
            return false;
        };
        let mut s = lock(&t.state);
        if s.power != CpuPower::On {
            return false;
        }
        s.power = CpuPower::Off;
        s.mailbox = None;
        true
    }
    // ANCHOR_END: psci_affinity_cpu_off_fn
    // ANCHOR_END: psci_affinity_cpu_off

    /// True if no vCPU is on or about to be (every vCPU called CPU_OFF). Each target is read
    /// under its own lock, one after the other: the answer is a snapshot, used only for a
    /// warning.
    pub fn all_off(&self) -> bool {
        self.cpus
            .iter()
            .all(|t| lock(&t.state).power == CpuPower::Off)
    }

    /// If vCPU `index` has a pending `PowerOn`, take it: `OnPending → On`.
    pub fn take_power_on(&self, index: usize) -> Option<PowerOn> {
        Target::take(&mut lock(&self.cpus.get(index)?.state))
    }

    // ANCHOR: psci_park_wake
    /// Park vCPU `index` (it is `Off`) until its `PowerOn` arrives (returned) or `stopping()`
    /// becomes true (`None`); `None` at once for an index that does not exist. The wait itself
    /// is `vcpu::wait::wait_for` on this target's mutex and condition variable.
    pub fn park(&self, index: usize, stopping: impl Fn() -> bool) -> Option<PowerOn> {
        let t = self.cpus.get(index)?;
        crate::vcpu::wait::wait_for(&t.state, &t.wake, stopping, Target::take)
    }

    /// Wake every parked vCPU so it re-checks its mailbox and the stop flag. Each notify is
    /// made while holding that target's lock, so a waiter between its stop check and its wait
    /// cannot miss it (`vcpu::wait` module docs).
    pub fn wake_all(&self) {
        for t in self.cpus.iter() {
            let _held = lock(&t.state);
            t.wake.notify_all();
        }
    }
    // ANCHOR_END: psci_park_wake
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_cpu_answers() {
        let p = Psci::default();
        assert_eq!(p.len(), 1);
        assert_eq!(p.affinity_info(0, 0), Ok(CpuPower::On));
        assert_eq!(p.cpu_on(0, 0x4008_0000, 0, true), Err(PsciError::AlreadyOn));
        assert_eq!(
            p.cpu_on(1, 0x4008_0000, 0, true).map_err(PsciError::code),
            Err(-2)
        );
    }
}
