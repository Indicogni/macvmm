//! The run loop: enter the guest, handle the exit, repeat (architecture §8.2; course ch03,
//! ch07).
//!
//! **The whole VMM, in one loop.** Everything a guest "does" to its machine arrives here as an
//! exit: `hv_vcpu_run` returns, [`Exit::from_hv`] says what trapped (`arch/esr.rs`, pure),
//! [`exit::handle`] decides what it means, and the loop applies the decision: write registers,
//! advance the PC (or not: an HVC has already advanced it, spike finding 5), and go back in.
//! Nothing else runs on a vCPU thread.
//!
//! **Observing it** (architecture §16). Every exit becomes an `ExitRecord`, completed by the
//! handler, then counted (`stats`), pushed onto this vCPU's ring of the last 256 exits, and
//! written to the JSONL trace when `--trace` selects it. A fatal stop carries the last 32
//! records, the fatal one last, into the dump.
//!
//! **Parking** (M5). After a PSCI CPU_OFF the vCPU is off: the loop parks on the PSCI
//! mailbox (`VmControl::park`) and, on a CPU_ON, restarts the vCPU at its entry point.
//!
//! **Stopping.** The loop checks [`VmControl::is_stopping`] before every entry. A stop
//! requested by another thread (the timeout, a signal, another vCPU) sets the flag and kicks
//! this vCPU out of `hv_vcpu_run` with `CANCELED`; a stop decided here (SYSTEM_OFF,
//! DEBUG_EXIT, a fatal exit) is posted to the same `VmControl` so the first reason wins. No
//! lock is held across `hv_vcpu_run` (architecture §14.2).
//!
//! [`VmControl::is_stopping`]: crate::control::VmControl::is_stopping

use super::Vcpu;
use super::exit::{self, ExitAction, ExitEnv, VcpuRegs};
use crate::arch::esr::Exit;
use crate::control::StopReason;
use crate::hostctl::HostCtl;
use crate::stats::ExitStats;
use crate::trace::{Clock, ExitRecord, ExitRing, FATAL_LAST_EXITS, Trace};
use std::sync::Arc;

/// What the loop records into, besides the guest: the shared trace (if any) and the boot's
/// clock. The ring and the counters are per vCPU.
#[derive(Clone, Copy, Debug)]
pub struct Observe<'a> {
    pub trace: Option<&'a Trace>,
    pub clock: Clock,
    /// Where the vCPU registers its ring for Ctrl-A t and SIGUSR1 (M6, LOG-6).
    pub host: Option<&'a HostCtl>,
}

/// One vCPU's own records.
#[derive(Debug, Default)]
pub struct VcpuLog {
    /// Shared (read-only) with `HostCtl::dump_rings` while the vCPU runs (M6).
    pub ring: Arc<ExitRing>,
    pub stats: ExitStats,
}

/// PSCI CPU_OFF (M5): park this vCPU outside `hv_vcpu_run` until a CPU_ON for it (returned)
/// or the stop (`None`).
fn park(vcpu: &Vcpu<'_>, ctl: &crate::control::VmControl) -> Option<crate::psci::PowerOn> {
    if ctl.psci().all_off() {
        crate::guest_warn!(
            "vcpu{}: CPU_OFF: every vCPU is now off; the VM idles until it is stopped",
            vcpu.index
        );
    }
    ctl.park(vcpu.index)
}

// ANCHOR: run_loop
/// Run `vcpu` until the VM stops. Every outcome, including a framework error, ends in
/// `ctl.request_stop`, so the control thread always learns why.
pub fn run(vcpu: &mut Vcpu<'_>, env: &ExitEnv<'_>, obs: &Observe<'_>, log: &mut VcpuLog) {
    let ctl = env.ctl;
    loop {
        if ctl.is_stopping() {
            return;
        }
        let raw = match vcpu.run() {
            Ok(raw) => raw,
            Err(e) => {
                ctl.request_stop(StopReason::Vmm(e));
                return;
            }
        };
        let exit = Exit::from_hv(raw.reason, raw.esr);
        log.stats
            .record(&exit, raw.esr, raw.reason == hvf::ExitReason::Exception);
        let t_ns = obs.clock.now_ns();
        let mut rec = ExitRecord::new(
            t_ns,
            vcpu.index,
            env.generation,
            &raw,
            &exit,
            vcpu.pc().ok(),
        );
        let action = exit::handle_watched(vcpu, env, &exit, &raw, &mut rec);
        if let Some(trace) = obs.trace {
            trace.record(&rec);
        }
        log.ring.push(rec);
        let step = match action {
            Ok(ExitAction::Resume { advance_pc: true }) => vcpu.advance_pc(),
            Ok(ExitAction::Resume { advance_pc: false }) => Ok(()),
            Ok(ExitAction::Stop(StopReason::GuestFatal(mut g))) => {
                g.last_exits = log.ring.last(FATAL_LAST_EXITS);
                ctl.request_stop(StopReason::GuestFatal(g));
                return;
            }
            Ok(ExitAction::Stop(reason)) => {
                ctl.request_stop(reason);
                return;
            }
            // A vCPU that powered itself off (chapter 20): park outside `hv_vcpu_run` until it is
            // powered on again or the VM stops.
            Ok(ExitAction::CpuOff) => match park(vcpu, ctl) {
                Some(on) => vcpu.power_on(&on),
                None => return,
            },
            Err(e) => Err(e),
        };
        if let Err(e) = step {
            ctl.request_stop(StopReason::Vmm(e));
            return;
        }
    }
}
// ANCHOR_END: run_loop
