//! Shared helpers for the on-machine `hvf` tests (`--features hvf-tests`).
//!
//! Each test builds its own VM. HVF allows one VM per process, so the tests must not overlap:
//! PLAN §0.3 requires `--test-threads=1`, and [`serial`] enforces it anyway with a process-wide
//! lock, so a forgotten flag gives slow tests rather than spurious `HV_BUSY` failures.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

pub mod enc;

use hvf::{CallError, MemFlags, OwnedMapping, Reg, Vcpu, VcpuHandle, Vm};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

/// Guest RAM base of the QEMU `virt` layout (PLAN §1). Test code may spell layout addresses.
pub const RAM: u64 = 0x4000_0000;
/// One 16 KiB page: the default IPA granule.
pub const PAGE: usize = 0x4000;
/// PL011's address: unmapped in these tests, so any access is an MMIO exit.
pub const UNMAPPED: u64 = 0x0900_0000;
/// QEMU `virt` GIC frames.
pub const GICD: u64 = 0x0800_0000;
pub const GICR: u64 = 0x080a_0000;
/// EL1h, DAIF masked (CURRICULUM ch02: `0x3c0 | 0x5`).
pub const CPSR_EL1H_MASKED: u64 = 0x3c5;

static SERIAL: Mutex<()> = Mutex::new(());

/// Hold this for the whole test: one VM per process.
pub fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Map one RWX page at [`RAM`] holding `code`.
pub fn load<'vm>(vm: &'vm Vm, code: &enc::Asm) -> OwnedMapping<'vm> {
    let mem = OwnedMapping::new(vm, RAM, PAGE, MemFlags::RWX).expect("map guest RAM");
    mem.write(code.base - RAM, &code.bytes())
        .expect("code fits");
    mem
}

/// A vCPU for the calling thread, ready to start at `pc` in EL1h with interrupts masked.
pub fn vcpu_at(vm: &Vm, pc: u64) -> Vcpu<'_> {
    let vcpu = Vcpu::create(vm).expect("hv_vcpu_create");
    vcpu.set_reg(Reg::PC, pc).expect("set PC");
    vcpu.set_reg(Reg::CPSR, CPSR_EL1H_MASKED).expect("set CPSR");
    vcpu
}

/// `(EC, ISS)` of an ESR (ARM ARM, ESR_EL2 register description: EC = ESR[31:26],
/// ISS = ESR[24:0]).
pub fn ec_iss(esr: u64) -> (u64, u64) {
    ((esr >> 26) & 0x3f, esr & 0x1ff_ffff)
}

/// Kicks a vCPU out of `hv_vcpu_run` if the test has not finished within `limit`, so a broken
/// guest fails the test (with a CANCELED exit) instead of hanging it.
pub struct Watchdog {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<Result<bool, CallError>>>,
}

impl Watchdog {
    pub fn new(handle: VcpuHandle, limit: Duration) -> Watchdog {
        let (stop, rx) = mpsc::channel::<()>();
        let thread = std::thread::spawn(move || match rx.recv_timeout(limit) {
            Err(mpsc::RecvTimeoutError::Timeout) => hvf::vcpus_exit(&[handle]).map(|()| true),
            _ => Ok(false),
        });
        Watchdog {
            stop: Some(stop),
            thread: Some(thread),
        }
    }

    /// Stop the watchdog; true if it had fired.
    pub fn finish(mut self) -> bool {
        self.stop_inner()
    }

    fn stop_inner(&mut self) -> bool {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.thread
            .take()
            .and_then(|t| t.join().ok())
            .is_some_and(|r| r.unwrap_or(false))
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let _ = self.stop_inner();
    }
}
