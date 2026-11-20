//! `vmm`: the macvmm virtual machine monitor library.
//!
//! **Policy lives here** (architecture principle 4): `hvf` reports what the hardware did; this
//! crate decides what it means for the machine. It models a QEMU `virt`-compatible arm64 board
//! (ADR-0003) so stock firmware and kernels boot unmodified.
//!
//! **Safety rules** (architecture §4, threat model §7.0):
//! - `unsafe` is denied crate-wide. The single exception is `memory/host.rs` (M2), which
//!   opts back in with a module-level `#![allow(unsafe_code)]` because it holds raw host
//!   pointers into guest RAM.
//! - No `print!`-family macros anywhere in this crate (RUST-5): they panic on `EPIPE` and bypass
//!   the terminal filter. Output goes through `log.rs` and the sinks.
//! - Every guest-controlled value is hostile and checked at the point of use.
//!
//! Modules arrive milestone by milestone (PLAN §2): `memory`, `arch` (M2), `vcpu`, `loader`
//! (M3), `bus`, `devices`, `trace`, `stats` (M4–M6), `fdt` (M7), `irq` (M8), `virtio` (M11+), `net` (M24). Each `mod` line is
//! added by the milestone that creates the module (additive edits only, PLAN §2.1).
#![deny(unsafe_code)]

pub mod arch;
pub mod backend;
pub mod bus;
pub mod config;
pub mod control;
pub mod devices;
pub mod error;
pub mod fdt;
pub mod hostctl;
pub mod irq;
pub mod loader;
pub mod log;
pub mod machine;
pub mod memory;
pub mod net;
pub mod psci;
pub mod smccc;
pub mod stats;
pub mod sync;
pub mod timer;
pub mod trace;
pub mod vcpu;
pub mod virtio;
pub mod vm;

pub use backend::hostio::HostIo;
pub use config::VmConfig;
pub use control::StopReason;
pub use error::{Error, Result};

// ANCHOR: vmm_run
/// Run the VM `cfg` describes, from the inputs `host` already read, until it stops
/// (architecture §6.7, §14.5).
///
/// `Ok(reason)` is the guest's verdict (power off, DEBUG_EXIT, fatal, timeout, ...), whose
/// [`StopReason::exit_code`] the CLI exits with. `Err` means the VMM or the host failed: a
/// configuration or input error (exit code 2), or an HVF/teardown failure (exit code 1).
///
/// This is the **reboot loop** of architecture §14.5: a PSCI SYSTEM_RESET under
/// `--on-reset reboot` (the default) builds a fresh `Machine` (VM, GIC, vCPUs, RAM, devices:
/// a cold boot) from the same `host` bytes with `generation + 1`, which DEBUG_BOOT_COUNT
/// reports. No path is opened again (HOSTIO-1, flaw F3), more than ten resets in ten seconds
/// is a reset storm (HC-5, exit code 3), and a teardown failure ends the loop with `Err`
/// instead of rebooting (MEM-11).
///
/// **`--timeout` bounds the whole run, not one boot** (architecture §13.1: a wall-clock
/// limit). The deadline is computed once, here, and every boot waits on the same absolute
/// `Instant`; otherwise a guest that resets a little more slowly than the storm limit would get
/// a fresh timeout per boot and run forever, defeating the bound a user or CI script relies on.
pub fn run(cfg: &VmConfig, host: &HostIo) -> Result<StopReason> {
    run_with(
        cfg,
        host,
        std::time::Instant::now,
        |cfg, host, generation, deadline| {
            // M21: the experimental vmapple board has its own build and run (ADR-0008).
            #[cfg(feature = "experimental-vmapple")]
            if cfg.machine == arch::layout::MachineProfile::VmApple {
                return machine::vmapple::boot(cfg, host, generation, deadline);
            }
            let machine = machine::Machine::build(cfg, host, generation)?;
            crate::debug!("boot plan (generation {generation}):\n{}", machine.plan());
            machine.run(deadline)
        },
    )
}
// ANCHOR_END: vmm_run

// ANCHOR: reboot_loop
/// The reboot loop with its two seams injected: `boot` builds and runs boot `generation` of
/// the machine from `host` alone until it stops or the absolute `deadline` passes, and `now`
/// is the clock of both the reset-storm limit and the `--timeout` deadline. `run` passes
/// `Machine::build` + `Machine::run` and `Instant::now`; host tests pass fakes.
pub fn run_with(
    cfg: &VmConfig,
    host: &HostIo,
    mut now: impl FnMut() -> std::time::Instant,
    mut boot: impl FnMut(&VmConfig, &HostIo, u64, Option<std::time::Instant>) -> Result<StopReason>,
) -> Result<StopReason> {
    // Once per process (doc comment above). `checked_add`: `--timeout` is capped
    // (config::MAX_TIMEOUT), but never trust it in deadline arithmetic.
    let deadline = cfg.timeout.and_then(|t| now().checked_add(t));
    let mut storm = control::ResetStorm::new();
    let mut generation: u64 = 0;
    loop {
        let reason = boot(cfg, host, generation, deadline)?; // Err: never reboot (MEM-11)
        match reason {
            StopReason::Reset if cfg.on_reset == config::ResetAction::Reboot => {
                let at = now();
                // The run's time is up: do not build another machine just to time it out.
                if deadline.is_some_and(|d| at >= d) {
                    return Ok(StopReason::Timeout);
                }
                if storm.record(at) {
                    return Ok(StopReason::GuestFatal(Box::new(
                        control::GuestFatal::machine(format!(
                            "reset storm: more than {} resets within {} s",
                            control::RESET_STORM_MAX,
                            control::RESET_STORM_WINDOW.as_secs()
                        )),
                    )));
                }
                generation = generation.saturating_add(1);
                crate::info!("guest reset: rebooting (boot {generation})");
            }
            other => return Ok(other),
        }
    }
}
// ANCHOR_END: reboot_loop
