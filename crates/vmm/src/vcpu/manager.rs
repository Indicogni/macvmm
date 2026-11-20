//! vCPU threads: create them, run them, and wait for the VM to stop (architecture §8.1,
//! §14.1, §14.5).
//!
//! **One host thread per vCPU** (CLAUDE.md), because a vCPU's registers can only be touched by
//! the thread that created it and `hv_vcpu_run` blocks that thread while the guest runs. The
//! threads live inside a `std::thread::scope` that borrows the `Vm`, so the compiler proves
//! every vCPU is destroyed (on its own thread) before the VM can be dropped (§8.1 step 6).
//!
//! **SMP (M16): N vCPUs, created one at a time** (architecture §8.1). [`run_vcpus`] spawns
//! thread *i* and waits for it to report that vCPU *i* exists, with its MPIDR written
//! (`0x8000_0000 | (i/16)<<8 | i%16`, `arch::regs::mpidr`) and, with the in-kernel GIC, its
//! redistributor at `GICR_BASE + i × 0x2_0000`, before it spawns thread *i+1*. The rendezvous
//! is what makes the redistributor check meaningful: HVF hands out redistributor frames in
//! vCPU **creation order**, not by MPIDR (spike finding 17), and the guest finds its frame by
//! matching `GICR_TYPER.Affinity` against its MPIDR, so creation order must equal index order.
//! Creating vCPUs late, after others ran, is never done (`hv_gic.h`: the topology "is
//! considered final" once vCPUs run; docs/research/hvf-api.md).
//!
//! Once every vCPU exists the start gate opens (`vcpu::wait::StartGate`): vCPU 0 resets to
//! the `BootPlan` and runs; every other vCPU is PSCI `Off` and parks (`Psci::park`) until a
//! CPU_ON fills its mailbox, then starts at the requested entry with `x0 = context_id`
//! (Arm DEN 0022 §5.1.4). A CPU_ON storm therefore never creates a thread or a vCPU: it can
//! only fill a mailbox of a thread that has existed since startup (threat model HC-3).
//!
//! **The control thread** (the caller) waits on [`VmControl`] for the first stop reason or the
//! `--timeout` deadline, whichever comes first. On the deadline it requests
//! `StopReason::Timeout`, which kicks every vCPU out of `hv_vcpu_run` (§14.5) and wakes the
//! parked ones.
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
use super::wait::StartGate;
use super::{BootParams, Vcpu, run_loop};
use crate::arch::layout::GICR_FRAME_SIZE;
use crate::config::IrqChip;
use crate::control::{StopReason, VmControl};
use crate::error::Error;
use crate::stats::VcpuStats;
use crate::sync::lock;
use hvf::Vm;
use std::sync::Mutex;
use std::sync::mpsc::{SyncSender, sync_channel};
use std::time::Instant;

/// What every vCPU of one boot starts from.
#[derive(Debug)]
pub struct VcpuSetup<'a> {
    /// The boot vCPU's entry state.
    pub boot: &'a BootParams,
    /// The number of vCPUs (`--cpus`, already checked against `MAX_CPUS` and the host).
    pub cpus: usize,
    /// The redistributor base the device tree describes (`GICR_BASE` on `virt`), checked
    /// against what HVF gave each vCPU; `None` skips the check (no in-kernel GIC, or a board
    /// whose map this module does not own, such as the one-vCPU `vmapple` probe).
    pub redistributors: Option<u64>,
    /// The boot's virtual-counter offset (architecture §8.1 step 5).
    pub vtimer_offset: u64,
    /// In-kernel GIC or the no-GIC teaching mode.
    pub irqchip: IrqChip,
    /// Where each vCPU files its `--stats` numbers when it ends.
    pub stats: &'a Mutex<Vec<VcpuStats>>,
}

// ANCHOR: vcpu_stop_on_exit
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
// ANCHOR_END: vcpu_stop_on_exit

/// The redistributor frame HVF must have given vCPU `index` when the region starts at `base`:
/// `base + index × 128 KiB` (architecture §8.1 step 2; GICv3 IHI 0069 §12.10: RD_base +
/// SGI_base, 64 KiB each). `None` only on overflow.
pub fn expected_redistributor(base: u64, index: usize) -> Option<u64> {
    let i = u64::try_from(index).ok()?;
    GICR_FRAME_SIZE.checked_mul(i)?.checked_add(base)
}

/// Create vCPU `index` on this thread, check its redistributor slot, and put it in its reset
/// state (the boot entry for vCPU 0; for a secondary the PC is overwritten by its CPU_ON, but
/// the MMU-off `SCTLR_EL1` and the VM-wide vtimer offset are set here, before any run).
fn create_vcpu<'vm>(
    vm: &'vm Vm,
    index: usize,
    setup: &VcpuSetup<'_>,
) -> crate::error::Result<Vcpu<'vm>> {
    // ANCHOR: vcpu_redistributor_check
    let mut vcpu = Vcpu::create(vm, index)?;
    if let Some(base) = setup.redistributors {
        let got = vcpu.redistributor_base()?;
        let want = expected_redistributor(base, index)
            .ok_or(Error::Internal("redistributor address overflow"))?;
        if got != want {
            return Err(Error::Config(format!(
                "in-kernel GIC: vCPU {index} got its redistributor at {got:#x}, but the \
                 device tree says {want:#x} (vCPUs must be created in index order)"
            )));
        }
    }
    // ANCHOR_END: vcpu_redistributor_check
    // ANCHOR: vcpu_apply_vtimer_offset
    vcpu.reset(setup.boot, setup.vtimer_offset)?;
    if setup.irqchip == IrqChip::None {
        vcpu.enable_nogic(setup.vtimer_offset)?;
    }
    // ANCHOR_END: vcpu_apply_vtimer_offset
    Ok(vcpu)
}

/// The body of vCPU thread `index`: create (and report it on `created`), wait for the start
/// gate, run (vCPU 0) or park until a CPU_ON (the others), then unregister and file stats.
fn vcpu_thread(
    vm: &Vm,
    index: usize,
    run: &RunCtx<'_, '_>,
    gate: &StartGate,
    created: SyncSender<bool>,
) {
    // ANCHOR: vcpu_thread_start
    // ANCHOR: vcpu_thread_create
    let (setup, env, obs) = (run.setup, run.env, run.obs);
    let ctl = env.ctl;
    let _guard = StopOnExit(ctl);
    let mut vcpu = match create_vcpu(vm, index, setup) {
        Ok(v) => v,
        Err(e) => {
            ctl.request_stop(StopReason::Vmm(e));
            let _ = created.send(false);
            return;
        }
    };
    let handle = vcpu.handle();
    ctl.register(handle);
    // The manager may create the next vCPU now. A send error means it gave up waiting (it
    // only does so after a stop), which the gate and the stop flag below handle.
    let _ = created.send(true);
    drop(created);
    gate.wait();
    // ANCHOR_END: vcpu_thread_create
    // ANCHOR: vcpu_register_ring
    let mut log = VcpuLog::default();
    if let Some(host) = obs.host {
        host.register_ring(index, &log.ring); // Ctrl-A t and SIGUSR1 can dump it now
    }
    // ANCHOR_END: vcpu_register_ring
    // A secondary starts PSCI-off (architecture §8.1 step 4): park until its CPU_ON.
    // ANCHOR: vcpu_thread_park
    let started = index == 0
        || match ctl.park(index) {
            Some(on) => match vcpu.power_on(&on) {
                Ok(()) => true,
                Err(e) => {
                    ctl.request_stop(StopReason::Vmm(e));
                    false
                }
            },
            None => false, // stopped while parked
        };
    if started {
        run_loop::run(&mut vcpu, env, obs, &mut log);
    }
    // ANCHOR_END: vcpu_thread_park
    // ANCHOR_END: vcpu_thread_start
    // ANCHOR: vcpu_unregister_ring
    if let Some(host) = obs.host {
        host.unregister_ring(index);
    }
    // ANCHOR_END: vcpu_unregister_ring
    ctl.unregister(handle);
    crate::debug!("vcpu{index} exits: {}", log.stats.summary());
    // ANCHOR: vcpu_file_stats
    let to_ns = |ticks: u64| hvf::host::timebase().map(|tb| tb.ticks_to_nanos(ticks));
    lock(setup.stats).push(VcpuStats {
        index,
        exits: log.stats.clone(),
        exec_ns: vcpu.exec_time().ok().and_then(to_ns),
        wfi_ns: vcpu.wfi_time().and_then(to_ns),
    });
    // ANCHOR_END: vcpu_file_stats
    // `vcpu` drops here, on its own thread (`hv_vcpu_destroy`).
}

/// What every vCPU thread borrows from [`run_vcpus`]'s caller.
struct RunCtx<'a, 'e> {
    setup: &'a VcpuSetup<'a>,
    env: &'a ExitEnv<'e>,
    obs: &'a Observe<'a>,
}

/// Run `setup.cpus` vCPUs until the VM stops or `deadline` passes, and return the stop reason.
pub fn run_vcpus(
    vm: &Vm,
    setup: &VcpuSetup<'_>,
    env: &ExitEnv<'_>,
    obs: &Observe<'_>,
    deadline: Option<Instant>,
) -> StopReason {
    let ctl = env.ctl;
    let gate = StartGate::new();
    let run = RunCtx { setup, env, obs };
    let panicked = std::thread::scope(|s| {
        let mut threads = Vec::with_capacity(setup.cpus);
        // ANCHOR: vcpu_sequential_create
        for index in 0..setup.cpus {
            // A rendezvous per vCPU: thread `index` says "created" (or "failed") before the
            // next thread is spawned, so HVF's redistributor slots follow index order.
            let (created, rendezvous) = sync_channel::<bool>(1);
            let (run, gate) = (&run, &gate);
            let spawned = std::thread::Builder::new()
                .name(format!("vcpu{index}"))
                .spawn_scoped(s, move || vcpu_thread(vm, index, run, gate, created));
            match spawned {
                Ok(handle) => threads.push(handle),
                Err(_) => {
                    ctl.request_stop(StopReason::Vmm(Error::Internal(
                        "cannot spawn a vCPU thread",
                    )));
                    break;
                }
            }
            // `Err` (the thread ended without sending: it panicked) or `false` (it failed and
            // posted the stop): create no more vCPUs.
            if rendezvous.recv() != Ok(true) {
                break;
            }
        }
        // Every vCPU exists (or the VM is already stopping): let vCPU 0 enter the guest.
        gate.open();
        // ANCHOR_END: vcpu_sequential_create
        // ANCHOR: run_vcpus_timeout
        if !ctl.wait_until(deadline) {
            ctl.request_stop(StopReason::Timeout);
        }
        // ANCHOR_END: run_vcpus_timeout
        // Join every thread, even after the first panic, so all vCPUs are destroyed.
        let panics: Vec<bool> = threads.into_iter().map(|t| t.join().is_err()).collect();
        panics.contains(&true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::layout::GICR_BASE;

    #[test]
    fn redistributor_slots_follow_index() {
        assert_eq!(expected_redistributor(GICR_BASE, 0), Some(0x080A_0000));
        assert_eq!(expected_redistributor(GICR_BASE, 1), Some(0x080C_0000));
        assert_eq!(
            expected_redistributor(GICR_BASE, 63),
            Some(0x080A_0000 + 63 * 0x2_0000)
        );
        assert_eq!(expected_redistributor(u64::MAX, 1), None);
        // The last of 64 frames ends inside the redistributor window, below the PL011.
        let end = expected_redistributor(GICR_BASE, 63).unwrap_or(u64::MAX) + GICR_FRAME_SIZE;
        assert!(end <= crate::arch::layout::GICR_WINDOW_END);
    }
}
