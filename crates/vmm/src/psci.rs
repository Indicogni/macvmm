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
//!   (HC-3). Every transition happens under one mutex.
//! - An unknown MPIDR is `INVALID_PARAMETERS` (-2), and an entry point outside RAM (and, from
//!   M18, ROM) or not 4-byte aligned is `INVALID_ADDRESS` (-9) (HC-3).
//! - `AFFINITY_INFO` answers 0 (ON), 1 (OFF) or 2 (ON_PENDING) for level 0; any higher
//!   affinity level is `INVALID_PARAMETERS` (HC-4).
//!
//! **MPIDR matching.** A PSCI `target_cpu` carries only the affinity fields (`Aff3` in bits
//! 39:32, `Aff2..Aff0` in 23:0, DEN 0022 §5.1.4); the DT `cpu@N/reg` a kernel reads them from
//! has no bit 31. A target with any other bit set is `INVALID_PARAMETERS`.
//!
//! **Parking.** A vCPU that is off waits in [`Psci::park`] on a condition variable, outside
//! `hv_vcpu_run`. It wakes for its `PowerOn` or for a VM stop ([`Psci::wake_all`], called by
//! `VmControl::request_stop` after it set the stop flag, so a wake cannot be lost). **M5 runs
//! one vCPU**, so the table has one row and CPU_ON can only answer -2 or -4; the multi-row
//! machinery is host-tested here and used by SMP (M16).
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

#[derive(Debug)]
struct Slot {
    mpidr: u64,
    power: CpuPower,
    mailbox: Option<PowerOn>,
}

/// The power state of every vCPU of one boot, and their mailboxes.
#[derive(Debug)]
pub struct Psci {
    cpus: Mutex<Vec<Slot>>,
    wake: Condvar,
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
            .map(|(i, &mpidr)| Slot {
                mpidr,
                power: if i == 0 { CpuPower::On } else { CpuPower::Off },
                mailbox: None,
            })
            .collect();
        Psci {
            cpus: Mutex::new(cpus),
            wake: Condvar::new(),
        }
    }

    /// The number of vCPUs.
    pub fn len(&self) -> usize {
        lock(&self.cpus).len()
    }

    /// True if there are no vCPUs (never, for a built machine).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The vCPU index whose MPIDR affinity equals `target`, or `INVALID_PARAMETERS` if
    /// `target` has bits outside [`AFFINITY_MASK`] or names no vCPU.
    fn find(cpus: &[Slot], target: u64) -> Result<usize, PsciError> {
        if target & !AFFINITY_MASK != 0 {
            return Err(PsciError::InvalidParameters);
        }
        cpus.iter()
            .position(|s| s.mpidr & AFFINITY_MASK == target)
            .ok_or(PsciError::InvalidParameters)
    }

    /// The vCPU index for MPIDR affinity `target` (see [`Psci::find`]).
    pub fn index_of(&self, target: u64) -> Result<usize, PsciError> {
        Psci::find(&lock(&self.cpus), target)
    }

    /// vCPU `index`'s state, if it exists.
    pub fn state(&self, index: usize) -> Option<CpuPower> {
        lock(&self.cpus).get(index).map(|s| s.power)
    }

    // ANCHOR: psci_cpu_on
    /// PSCI CPU_ON (DEN 0022 §5.1.4; HC-3). `entry_valid` is the caller's verdict on the entry
    /// point (in RAM or ROM, 4-byte aligned). On success the target goes `Off → OnPending`, its
    /// mailbox holds the `PowerOn`, its thread is woken, and its index is returned.
    pub fn cpu_on(
        &self,
        target: u64,
        entry: u64,
        ctx: u64,
        entry_valid: bool,
    ) -> Result<usize, PsciError> {
        let mut cpus = lock(&self.cpus);
        let index = Psci::find(&cpus, target)?;
        if !entry_valid {
            return Err(PsciError::InvalidAddress);
        }
        let slot = cpus.get_mut(index).ok_or(PsciError::InvalidParameters)?;
        match slot.power {
            CpuPower::On => Err(PsciError::AlreadyOn),
            CpuPower::OnPending => Err(PsciError::OnPending),
            CpuPower::Off => {
                slot.power = CpuPower::OnPending;
                slot.mailbox = Some(PowerOn { entry, ctx });
                drop(cpus);
                self.wake.notify_all();
                Ok(index)
            }
        }
    }
    // ANCHOR_END: psci_cpu_on

    /// PSCI AFFINITY_INFO (DEN 0022 §5.1.5; HC-4): the state of `target` at affinity level 0.
    /// A higher level is `INVALID_PARAMETERS`.
    pub fn affinity_info(&self, target: u64, level: u64) -> Result<CpuPower, PsciError> {
        if level != 0 {
            return Err(PsciError::InvalidParameters);
        }
        let cpus = lock(&self.cpus);
        let index = Psci::find(&cpus, target)?;
        cpus.get(index)
            .map(|s| s.power)
            .ok_or(PsciError::InvalidParameters)
    }

    /// PSCI CPU_OFF (DEN 0022 §5.1.3) by vCPU `index`: `On → Off`. Returns false if the vCPU
    /// was not on (a VMM bug: only a running vCPU can make the call).
    pub fn cpu_off(&self, index: usize) -> bool {
        let mut cpus = lock(&self.cpus);
        match cpus.get_mut(index) {
            Some(s) if s.power == CpuPower::On => {
                s.power = CpuPower::Off;
                s.mailbox = None;
                true
            }
            _ => false,
        }
    }

    /// True if no vCPU is on or about to be (every vCPU called CPU_OFF).
    pub fn all_off(&self) -> bool {
        lock(&self.cpus).iter().all(|s| s.power == CpuPower::Off)
    }

    /// If vCPU `index` has a pending `PowerOn`, take it: `OnPending → On`.
    pub fn take_power_on(&self, index: usize) -> Option<PowerOn> {
        let mut cpus = lock(&self.cpus);
        Psci::take(&mut cpus, index)
    }

    fn take(cpus: &mut [Slot], index: usize) -> Option<PowerOn> {
        let slot = cpus.get_mut(index)?;
        let on = slot.mailbox.take()?;
        slot.power = CpuPower::On;
        Some(on)
    }

    /// Park vCPU `index` (it is `Off`) until its `PowerOn` arrives (returned) or `stopping()`
    /// becomes true (`None`). `stopping` is read under the table lock, and
    /// [`Psci::wake_all`] notifies under it, so a stop requested at any moment wakes us.
    pub fn park(&self, index: usize, stopping: impl Fn() -> bool) -> Option<PowerOn> {
        let mut cpus = lock(&self.cpus);
        loop {
            if stopping() {
                return None;
            }
            if let Some(on) = Psci::take(&mut cpus, index) {
                return Some(on);
            }
            cpus = match self.wake.wait(cpus) {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
    }

    /// Wake every parked vCPU so it re-checks its mailbox and the stop flag.
    pub fn wake_all(&self) {
        let _held = lock(&self.cpus);
        self.wake.notify_all();
    }
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
