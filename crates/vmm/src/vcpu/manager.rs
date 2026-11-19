//! vCPU threads: create them, run them, and wait for the VM to stop (architecture §8.1,
//! §14.1, §14.5).
//!
//! **One host thread per vCPU** (CLAUDE.md), because a vCPU's registers can only be touched by
//! the thread that created it and `hv_vcpu_run` blocks that thread while the guest runs. The
//! threads live inside a `std::thread::scope` that borrows the `Vm`, so the compiler proves
//! every vCPU is destroyed (on its own thread) before the VM can be dropped (§8.1 step 6).
//!
//! **M3: one vCPU.** Sequential creation with the redistributor check, parked secondaries and
//! the PSCI mailbox arrive with SMP (M16); the shape below already handles a list of threads.
//!
//! **The control thread** (the caller) waits on [`VmControl`] for the first stop reason or the
//! `--timeout` deadline, whichever comes first. On the deadline it requests
//! `StopReason::Timeout`, which kicks the vCPU out of `hv_vcpu_run` (§14.5).
//!
//! **M8.** Every vCPU applies the boot's virtual-counter offset (`timer::boot_offset`, captured
//! once in `Machine::build`) in [`Vcpu::reset`] before its first run, so the guest counter
//! starts near zero and is the same on every CPU (architecture §8.1 step 5). In the
//! `--irqchip none` mode the vCPU also gets its VMM-side timer line (`timer::NoGicTimer`).
//! When a thread ends it files its `--stats` numbers ([`VcpuSetup::stats`]).
//!
//! **Panics** (RUST-7). A panic on a vCPU thread is a VMM bug and stops the whole VM with exit
//! code 1. A guard on the thread posts the stop while unwinding, so the control thread is never
//! left waiting, and the join turns the panic into `StopReason::Vmm`.

use super::exit::ExitEnv;
use super::run_loop::{Observe, VcpuLog};
use super::{BootParams, Vcpu, run_loop};
use crate::config::IrqChip;
use crate::control::{StopReason, VmControl};
use crate::error::Error;
use crate::stats::VcpuStats;
use crate::sync::lock;
use hvf::Vm;
use std::sync::Mutex;
use std::time::Instant;

/// What every vCPU of one boot starts from.
#[derive(Debug)]
pub struct VcpuSetup<'a> {
    /// The boot vCPU's entry state.
    pub boot: &'a BootParams,
    /// The boot's virtual-counter offset (architecture §8.1 step 5).
    pub vtimer_offset: u64,
    /// In-kernel GIC or the no-GIC teaching mode.
    pub irqchip: IrqChip,
    /// Where each vCPU files its `--stats` numbers when it ends.
    pub stats: &'a Mutex<Vec<VcpuStats>>,
}

/// Posts a stop if the vCPU thread ends without one (a panic, or a missing verdict).
struct StopOnExit<'a>(&'a VmControl);

impl Drop for StopOnExit<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.0
                .request_stop(StopReason::Vmm(Error::Internal("a vCPU thread panicked")));
        } else if !self.0.is_stopping() {
            self.0.request_stop(StopReason::Vmm(Error::Internal(
                "a vCPU loop ended without a stop reason",
            )));
        }
    }
}

/// The body of vCPU thread `index`: create, reset, register, run, unregister.
fn vcpu_thread(vm: &Vm, index: usize, setup: &VcpuSetup<'_>, env: &ExitEnv<'_>, obs: &Observe<'_>) {
    let ctl = env.ctl;
    let _guard = StopOnExit(ctl);
    let mut vcpu = match Vcpu::create(vm, index) {
        Ok(v) => v,
        Err(e) => {
            ctl.request_stop(StopReason::Vmm(e));
            return;
        }
    };
    // ANCHOR: vcpu_apply_vtimer_offset
    if let Err(e) = vcpu.reset(setup.boot, setup.vtimer_offset) {
        ctl.request_stop(StopReason::Vmm(e));
        return;
    }
    if setup.irqchip == IrqChip::None
        && let Err(e) = vcpu.enable_nogic(setup.vtimer_offset)
    {
        ctl.request_stop(StopReason::Vmm(e));
        return;
    }
    // ANCHOR_END: vcpu_apply_vtimer_offset
    let handle = vcpu.handle();
    ctl.register(handle);
    let mut log = VcpuLog::default();
    if let Some(host) = obs.host {
        host.register_ring(index, &log.ring); // M6: Ctrl-A t / SIGUSR1 (LOG-6)
    }
    run_loop::run(&mut vcpu, env, obs, &mut log);
    if let Some(host) = obs.host {
        host.unregister_ring(index);
    }
    ctl.unregister(handle);
    crate::debug!("vcpu{index} exits: {}", log.stats.summary());
    let to_ns = |ticks: u64| hvf::host::timebase().map(|tb| tb.ticks_to_nanos(ticks));
    lock(setup.stats).push(VcpuStats {
        index,
        exits: log.stats.clone(),
        exec_ns: vcpu.exec_time().ok().and_then(to_ns),
        wfi_ns: vcpu.wfi_time().and_then(to_ns),
    });
    // `vcpu` drops here, on its own thread (`hv_vcpu_destroy`).
}

/// Run the boot vCPU until the VM stops or `deadline` passes, and return the stop reason.
pub fn run_vcpus(
    vm: &Vm,
    setup: &VcpuSetup<'_>,
    env: &ExitEnv<'_>,
    obs: &Observe<'_>,
    deadline: Option<Instant>,
) -> StopReason {
    let ctl = env.ctl;
    let panicked = std::thread::scope(|s| {
        let spawned = std::thread::Builder::new()
            .name("vcpu0".into())
            .spawn_scoped(s, || vcpu_thread(vm, 0, setup, env, obs));
        match spawned {
            Ok(handle) => {
                if !ctl.wait_until(deadline) {
                    ctl.request_stop(StopReason::Timeout);
                }
                handle.join().is_err()
            }
            Err(_) => {
                ctl.request_stop(StopReason::Vmm(Error::Internal(
                    "cannot spawn the vCPU thread",
                )));
                false
            }
        }
    });
    env.serial.flush();
    if let Some(t) = obs.trace {
        t.flush();
    }
    let reason = ctl.take_reason();
    if panicked {
        // RUST-7: a panic is the verdict even if a guest stop was posted just before it.
        return StopReason::Vmm(Error::Internal("a vCPU thread panicked"));
    }
    reason.unwrap_or(StopReason::Vmm(Error::Internal(
        "the VM stopped without a reason",
    )))
}
