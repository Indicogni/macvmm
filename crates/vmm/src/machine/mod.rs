//! `Machine`: one boot of one VM, from `VmConfig` + `HostIo` bytes to a `StopReason`
//! (architecture §6.7, §12.3, §14.5).
//!
//! **Build** ([`Machine::build`]), in the order that keeps failures cheap and safe:
//! 1. validate the configuration and **plan** the boot (pure: a bad ELF or an overlapping
//!    `--raw` is refused with exit code 2 before any HVF call);
//!    Then generate the device tree (M7, [`device_tree`]; also pure apart from drawing its
//!    seeds from the host CSPRNG), size the DTB slot to it, and on the first boot write the
//!    seed-redacted copy to `--dtb-out` (FDT-4);
//! 2. probe the host and create the VM with its in-kernel GICv3 (`vm::create_vm_with`), then
//!    check the GIC against the layout (M8: `vm::check_gic`, architecture §9). With the hidden
//!    `--irqchip none` (M8, §9.1) no GIC is created and the DTB describes none;
//! 3. allocate and map guest RAM (`memory::GuestRam`, M2);
//! 4. copy the images, then the DTB, into RAM through `GuestMemory` (`loader::plan::load`,
//!    `loader::load_dtb`);
//! 5. build the MMIO bus with the devices `cfg` asks for (`virt::register_devices`), the
//!    PL011 and PL031 wired to SPIs 1 and 2 of the GIC (M8, `virt::platform_irqs`);
//! 6. capture the boot's virtual-counter offset (`timer::boot_offset`, architecture §8.1),
//!    which is also time zero of this boot's exit trace.
//!
//! **M8: `--stats`.** `run` measures the boot's wall time and process CPU time around the vCPU
//! threads, collects each vCPU's numbers, and leaves the report on `HostCtl` for the CLI to
//! print after the verdict (`stats::BootStats`).
//!
//! If anything after step 2 fails, the half-built machine is torn down in the MEM-9/MEM-11
//! order before the error is returned, so a failed build never leaks a mapped VM.
//!
//! **Run** ([`Machine::run`]) starts the vCPU thread(s), waits for the stop or the run's
//! `--timeout` deadline (one absolute `Instant` for every boot, from the reboot loop), and
//! tears the VM down. A teardown failure is an `Err` (exit code 1, never a reboot: MEM-11, flaw F22).
//!
//! **Inputs come only from `HostIo`** (HOSTIO-1): `build` never sees a path. The reboot loop
//! (M5) calls `build` again with the same `HostIo` and `generation + 1`.

pub mod virt;

use crate::arch::layout::{Layout, RAM_BASE};
use crate::backend::hostio::HostIo;
use crate::backend::serial::{SerialInput, SinkHandle};
use crate::bus::Bus;
use crate::config::{IrqChip, MmioPolicy, VmConfig};
use crate::control::{StopReason, VmControl};
use crate::error::{Error, Result};
use crate::fdt::{self, MachineDesc};
use crate::hostctl::HostCtl;
use crate::loader::{self, BootInputs, BootPlan, RamRange};
use crate::memory::GuestRam;
use crate::stats::BootStats;
use crate::trace::{Clock, Trace};
use crate::vcpu::exit::ExitEnv;
use crate::vcpu::run_loop::Observe;
use crate::vcpu::{BootParams, manager};
use crate::vm;
use hvf::{Capabilities, Gic, Vm};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// A built, loaded, not yet running machine.
pub struct Machine {
    vm: Vm,
    /// `None` only in the `--irqchip none` teaching mode.
    gic: Option<Gic>,
    irqchip: IrqChip,
    stats: bool,
    ram: Arc<GuestRam>,
    plan: BootPlan,
    bus: Bus,
    serial: SinkHandle,
    trace: Option<Arc<Trace>>,
    generation: u64,
    debug_calls: bool,
    unhandled_mmio: MmioPolicy,
    vtimer_offset: u64,
    /// M6: the console input queue (its push hook feeds this boot's PL011) and the attach
    /// point of the CLI's stdin and signal threads.
    serial_input: Arc<SerialInput>,
    hostctl: Arc<HostCtl>,
}

impl core::fmt::Debug for Machine {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Machine")
            .field("plan", &self.plan)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

/// True if this boot is a test guest, for which `DebugHvc::Auto` enables the macvmm debug
/// hypercalls (HC-2, flaw F7): an ELF `--kernel` or `--raw` blobs on the `virt` machine. An
/// arm64 Image (M9), `--bios` (M18) and `--machine vmapple` (M21) are real OSes or firmware,
/// so the extra surface stays off. Decided from the `HostIo` bytes, never a path (HOSTIO-1).
pub fn is_test_guest(cfg: &VmConfig, host: &HostIo) -> bool {
    let kernel_is_test = match host.kernel.as_deref() {
        Some(k) => loader::detect(k) == loader::ImageKind::Elf,
        None => true, // `--raw` only
    };
    cfg.machine == crate::arch::layout::MachineProfile::Virt && kernel_is_test
}

/// The loader's view of `host`'s bytes and `cfg`'s command line (M9: initrd and cmdline).
fn boot_inputs<'a>(cfg: &'a VmConfig, host: &'a HostIo) -> BootInputs<'a> {
    BootInputs {
        kernel: host.kernel.as_deref(),
        raw: &host.raw,
        initrd: host.initrd.as_deref(),
        cmdline: cfg.boot.cmdline.as_deref(),
    }
}

/// Plan a boot of `host`'s inputs on the machine `cfg` describes (pure; no HVF call).
pub fn plan_boot(cfg: &VmConfig, host: &HostIo) -> Result<BootPlan> {
    cfg.validate()?;
    cfg.validate_irqchip(is_test_guest(cfg, host))?;
    let layout = Layout::virt();
    layout
        .ram_end(cfg.mem_bytes)
        .map_err(|e| Error::Config(format!("--mem: {e}")))?;
    let ram = RamRange {
        base: RAM_BASE,
        size: cfg.mem_bytes,
    };
    Ok(loader::plan(ram, &boot_inputs(cfg, host))?)
}

// ANCHOR: machine_device_tree
/// Generate this boot's device tree (M7, architecture §12.2) and size `plan`'s DTB slot to it.
/// Fresh `rng-seed`/`kaslr-seed` come from `host.entropy` on every boot (FDT-3); the first
/// boot also writes the seed-redacted copy to `--dtb-out` (FDT-4). The guest gets the real
/// seeds.
pub fn device_tree(
    cfg: &VmConfig,
    host: &HostIo,
    plan: &mut BootPlan,
    generation: u64,
) -> Result<Vec<u8>> {
    let mut desc =
        MachineDesc::from_entropy(1, cfg.mem_bytes, &host.entropy).map_err(Error::Entropy)?;
    // M9: the kernel command line and the initrd range go to `/chosen`.
    desc.bootargs.clone_from(&plan.bootargs);
    desc.initrd = plan.initrd;
    // M11: one `/virtio_mmio@…` node per populated slot (none until M12).
    desc.virtio_slots = virt::virtio_populated(cfg);
    let with_gic = cfg.irqchip == IrqChip::InKernelGicV3;
    let dtb = fdt::build_dtb_with(Layout::virt(), &desc, with_gic)?;
    plan.set_dtb_len(u64::try_from(dtb.len()).unwrap_or(u64::MAX))?;
    if generation == 0 {
        host.write_dtb_out(&fdt::redact_seeds(&dtb)?)?;
    }
    Ok(dtb)
}
// ANCHOR_END: machine_device_tree

// ANCHOR: dry_run
/// `--dry-run` (M9, architecture §13.1, §21.2): plan the boot and build its device tree exactly
/// as [`Machine::build`] would, then describe them instead of creating a VM. Makes **no HVF
/// call** (it needs no entitlement; PLAN M9 tests it with an unentitled binary) and never
/// prints seed bytes (FDT-4): the summary names the seeds but not their values.
pub fn dry_run(cfg: &VmConfig, host: &HostIo) -> Result<String> {
    use core::fmt::Write as _;
    let mut plan = plan_boot(cfg, host)?;
    let dtb = device_tree(cfg, host, &mut plan, 0)?;
    let mut out = String::new();
    let w = |out: &mut String, line: core::fmt::Arguments<'_>| {
        let _ = out.write_fmt(line);
        out.push('\n');
    };
    w(
        &mut out,
        format_args!("macvmm boot plan (dry run, no VM created)"),
    );
    out.push_str(&plan.to_string());
    // ANCHOR_END: dry_run
    w(&mut out, format_args!("memory map ({:?}):", cfg.machine));
    let layout = Layout::virt();
    for r in layout.regions {
        let irq = r.intid.map(|i| format!(" intid {i}")).unwrap_or_default();
        w(
            &mut out,
            format_args!(
                "  {:#010x}..{:#010x}  {:<12} {:?}{irq}",
                r.base,
                r.end(),
                r.name,
                r.kind
            ),
        );
    }
    let ram_end = RAM_BASE.saturating_add(cfg.mem_bytes);
    w(
        &mut out,
        format_args!("  {RAM_BASE:#010x}..{ram_end:#010x}  {:<12} Ram", "ram"),
    );
    w(
        &mut out,
        format_args!(
            "device tree: {} bytes at {:#x} (limit {}), {} vCPU(s), irqchip {:?}, \
             rng-seed 64 bytes and kaslr-seed (values not shown)",
            dtb.len(),
            plan.dtb.addr,
            plan.dtb_limit,
            cfg.cpus,
            cfg.irqchip
        ),
    );
    if let Some((start, end)) = plan.initrd {
        w(
            &mut out,
            format_args!("  /chosen linux,initrd-start {start:#x} linux,initrd-end {end:#x}"),
        );
    }
    w(
        &mut out,
        format_args!(
            "debug hypercalls: {}",
            if cfg.debug_calls_enabled(is_test_guest(cfg, host)) {
                "on"
            } else {
                "off"
            }
        ),
    );
    Ok(out)
}

impl Machine {
    /// Build boot `generation` of the machine (module docs).
    pub fn build(cfg: &VmConfig, host: &HostIo, generation: u64) -> Result<Machine> {
        let mut plan = plan_boot(cfg, host)?;
        let dtb = device_tree(cfg, host, &mut plan, generation)?;
        let layout = Layout::virt();
        let ram_end = layout
            .ram_end(cfg.mem_bytes)
            .map_err(|e| Error::Config(format!("--mem: {e}")))?;
        let caps = Capabilities::probe().map_err(|err| Error::Hv {
            op: "probe capabilities",
            err,
        })?;
        let (vm, gic) = vm::create_vm_with(layout, ram_end, &caps, cfg.irqchip)?;
        // ANCHOR: machine_gic_checks
        // Architecture §9 startup assertions, before any memory exists: on a mismatch, dropping
        // the VM destroys it and nothing else was built.
        if let Some(g) = &gic {
            vm::check_gic(g, layout)?;
        }
        // ANCHOR_END: machine_gic_checks
        // If allocation fails nothing is mapped yet: dropping the VM destroys it.
        let ram = Arc::new(GuestRam::new(
            &virt::ram_regions(cfg.mem_bytes),
            vm::ipa_bits(layout, ram_end),
        )?);
        let inputs = boot_inputs(cfg, host);
        let mut bus = Bus::new();
        let loaded = ram
            .map(&vm)
            .and_then(|()| Ok(loader::plan::load(&plan, &inputs, &*ram)?))
            .and_then(|()| Ok(loader::load_dtb(&plan, &dtb, &*ram)?))
            .and_then(|()| virt::register_devices(cfg, &mut bus))
            .and_then(|()| virt::register_virtio(cfg, &mut bus))
            .and_then(|()| virt::platform_irqs(gic.as_ref()))
            .and_then(|irqs| {
                virt::register_platform_with(&mut bus, &host.serial, &host.serial_input, 1, irqs)
            });
        let uart = match loaded {
            Ok(uart) => uart,
            Err(e) => {
                // Tear the half-built VM down safely; the build error is the one to report,
                // unless teardown itself failed (then memory was leaked: the bigger problem).
                vm::teardown(vm, gic, ram, None)?;
                return Err(e);
            }
        };
        // M6: input pushed by the stdin thread wakes this boot's UART (architecture §14.4). A
        // weak reference: the hook never keeps a torn-down machine's device alive.
        let weak = Arc::downgrade(&uart);
        host.serial_input.set_hook(Some(Arc::new(move || {
            if let Some(u) = weak.upgrade() {
                crate::sync::lock(&u).input_ready();
            }
        })));
        Ok(Machine {
            vm,
            gic,
            irqchip: cfg.irqchip,
            stats: cfg.stats,
            ram,
            plan,
            bus,
            serial: Arc::clone(&host.serial),
            trace: host.trace.clone(),
            generation,
            debug_calls: cfg.debug_calls_enabled(is_test_guest(cfg, host)),
            unhandled_mmio: cfg.unhandled_mmio,
            vtimer_offset: crate::timer::boot_offset(),
            serial_input: Arc::clone(&host.serial_input),
            hostctl: Arc::clone(&host.hostctl),
        })
    }

    /// The boot plan this machine was loaded with.
    pub fn plan(&self) -> &BootPlan {
        &self.plan
    }

    /// Run until the VM stops or the absolute `deadline` passes (then the verdict is
    /// `StopReason::Timeout`), and tear it down (module docs). The deadline is the whole run's
    /// `--timeout`, computed once by the reboot loop (`vmm::run_with`), so a reboot never
    /// re-arms it; one already in the past stops the boot at once.
    pub fn run(self, deadline: Option<Instant>) -> Result<StopReason> {
        let ctl = Arc::new(VmControl::new());
        // M6: while this boot runs, a user quit (Ctrl-A x, SIGTERM) stops it.
        let attached = self.hostctl.attach(&ctl);
        let env = ExitEnv {
            mem: &*self.ram,
            serial: &self.serial,
            ctl: &ctl,
            bus: &self.bus,
            generation: self.generation,
            debug_calls: self.debug_calls,
            unhandled_mmio: self.unhandled_mmio,
        };
        let boot = BootParams {
            pc: self.plan.entry,
            x: [self.plan.x0, 0, 0, 0],
            cpsr: self.plan.cpsr,
        };
        let obs = Observe {
            trace: self.trace.as_deref(),
            clock: Clock::new(self.vtimer_offset),
            host: Some(&self.hostctl),
        };
        let per_vcpu = Mutex::new(Vec::new());
        let setup = manager::VcpuSetup {
            boot: &boot,
            vtimer_offset: self.vtimer_offset,
            irqchip: self.irqchip,
            stats: &per_vcpu,
        };
        let cpu0 = hvf::host::process_cpu_time();
        let t0 = Instant::now();
        let reason = manager::run_vcpus(&self.vm, &setup, &env, &obs, deadline);
        let wall = t0.elapsed();
        let cpu1 = hvf::host::process_cpu_time();
        drop(attached);
        self.serial_input.set_hook(None);
        if self.stats {
            let mut vcpus = crate::sync::lock(&per_vcpu).clone();
            vcpus.sort_by_key(|v| v.index);
            let stats = BootStats {
                vcpus,
                wall,
                host_cpu: cpu0.zip(cpu1).map(|(a, b)| b.saturating_sub(a)),
            };
            self.hostctl.set_stats(stats.report());
        }
        // M11: the bus owns the virtio transports, and an activated device holds an
        // `Arc` of guest RAM; drop them first so teardown can free RAM (MEM-9, D20).
        drop(self.bus);
        vm::teardown(self.vm, self.gic, self.ram, None)?;
        Ok(reason)
    }
}
