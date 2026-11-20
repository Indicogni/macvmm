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
//!    PL011 and PL031 wired to SPIs 1 and 2 of the GIC (M8, `virt::platform_irqs`), and the
//!    virtio devices in their slots, each with its worker thread (M12,
//!    `virt::register_virtio_with`; the workers are joined before RAM is freed);
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
//! **M18: firmware** (`--bios`). Step 1 plans a firmware boot (`loader::plan_firmware`: PC
//! at the flash base, `x0` = the DTB, nothing else in RAM); step 3 also allocates both flash
//! banks as one 128 MiB [`RomRegion`], copies the image into bank 0 (the rest reads as zero,
//! `loader::firmware::load_rom`) and maps it **read+execute** (MEM-3: it is not part of
//! `GuestMemory`, so no device can DMA into it). Bank 1 is mapped too, empty, because U-Boot
//! reads its environment from it (`docs/compat/uboot.md`). Step 5 puts a write-ignore
//! [`crate::devices::flash::FlashDevice`] on the bus over each bank, so a guest store to the
//! ROM is answered (MMIO-10) instead of stopping the VM. The ROM is unmapped and freed in the
//! same teardown as RAM (`vm::teardown`).
//!
//! **Run** ([`Machine::run`]) starts the vCPU thread(s), waits for the stop or the run's
//! `--timeout` deadline (one absolute `Instant` for every boot, from the reboot loop), and
//! tears the VM down. A teardown failure is an `Err` (exit code 1, never a reboot: MEM-11, flaw F22).
//!
//! **Inputs come only from `HostIo`** (HOSTIO-1): `build` never sees a path. The reboot loop
//! (M5) calls `build` again with the same `HostIo` and `generation + 1`.

pub mod virt;
// M21: the experimental macOS-guest board (ADR-0008 decision 3), off by default.
#[cfg(feature = "experimental-vmapple")]
pub mod vmapple;

use crate::arch::layout::{
    FLASH_BANK_SIZE, FLASH_SIZE, FLASH0_BASE, FLASH1_BASE, Layout, RAM_BASE,
};
use crate::backend::hostio::HostIo;
use crate::backend::serial::{SerialInput, SinkHandle};
use crate::bus::Bus;
use crate::config::{IrqChip, MmioPolicy, VmConfig};
use crate::control::{StopReason, VmControl};
use crate::error::{Error, Result};
use crate::fdt::{self, MachineDesc};
use crate::hostctl::HostCtl;
use crate::loader::{self, BootInputs, BootPlan, RamRange};
use crate::memory::{GuestAddress, GuestRam, RomRegion};
use crate::stats::BootStats;
use crate::trace::{Clock, Trace};
use crate::vcpu::exit::ExitEnv;
use crate::vcpu::run_loop::Observe;
use crate::vcpu::{BootParams, manager};
use crate::virtio::Worker;
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
    /// M16: the number of vCPUs (`--cpus`).
    cpus: usize,
    stats: bool,
    ram: Arc<GuestRam>,
    /// M18: flash bank 0 with the `--bios` image, mapped read+execute (`None` without it).
    rom: Option<RomRegion>,
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
    /// M12: this boot's stop control. Created at build time because the virtio workers need
    /// it before the vCPUs exist: a worker panic stops the VM (RUST-7).
    ctl: Arc<VmControl>,
    /// M12: one worker thread per populated virtio slot; stopped and joined before guest RAM
    /// is freed (MEM-9).
    workers: Vec<Arc<Worker>>,
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
    if host.bios.is_some() {
        return false; // M18: firmware is never a test guest (HC-2)
    }
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
    // M18: `--bios` is a firmware boot (`config.rs` refused every other input with it).
    if let Some(bios) = host.bios.as_deref() {
        return Ok(loader::plan_firmware(
            ram,
            (FLASH0_BASE, FLASH_BANK_SIZE),
            bios,
        )?);
    }
    Ok(loader::plan(ram, &boot_inputs(cfg, host))?)
}

// ANCHOR: machine_device_tree
/// Generate this boot's device tree and size `plan`'s DTB slot to it. Fresh
/// `rng-seed`/`kaslr-seed` come from `host.entropy` on every boot; the first boot (generation
/// 0; a guest reboot starts a new generation) also writes the seed-redacted copy to
/// `--dtb-out`. The guest gets the real seeds.
pub fn device_tree(
    cfg: &VmConfig,
    host: &HostIo,
    plan: &mut BootPlan,
    generation: u64,
) -> Result<Vec<u8>> {
    let mut desc = MachineDesc::from_entropy(cfg.cpus, cfg.mem_bytes, &host.entropy)
        .map_err(Error::Entropy)?;
    // Chapter 13: the kernel command line and the initrd range go to `/chosen`.
    desc.bootargs.clone_from(&plan.bootargs);
    desc.initrd = plan.initrd;
    // Chapter 15: one `/virtio_mmio@…` node per populated slot.
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
    #[cfg(feature = "experimental-vmapple")]
    if cfg.machine == crate::arch::layout::MachineProfile::VmApple {
        return vmapple::dry_run(cfg, host); // M21: no DTB, no boot plan
    }
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

/// Stop and join every worker (each finishes its current batch, VQ-12). True if any panicked.
/// M16: refuse `--cpus` above what this host allows per VM (`hv_vm_get_max_vcpu_count`,
/// [`Capabilities::max_vcpus`]). `config.rs` already capped it at `MAX_CPUS`; this is the host's
/// own limit, checked before the VM exists so the error names the flag instead of surfacing
/// later as a failed `hv_vcpu_create`. A pure function so a host test can cover a limit this
/// Mac does not have.
pub fn check_cpus(cpus: u32, host_max: u32) -> Result<()> {
    if cpus > host_max {
        return Err(Error::Config(format!(
            "--cpus {cpus}: this host allows at most {host_max} vCPUs per VM"
        )));
    }
    Ok(())
}

// ANCHOR: machine_load_firmware
/// M18: copy `--bios` into flash bank 0 (the rest of the flash reads as zero), map both banks
/// read+execute, and put a write-ignore flash device over each bank (module docs). A no-op
/// without `--bios`.
// ANCHOR: machine_load_firmware_body
fn load_firmware(
    rom: Option<&RomRegion>,
    host: &HostIo,
    vm: &hvf::Vm,
    bus: &mut Bus,
) -> Result<()> {
    let (Some(rom), Some(image)) = (rom, host.bios.as_deref()) else {
        return Ok(());
    };
    loader::firmware::load_rom(rom, image).map_err(|e| Error::Config(format!("--bios: {e}")))?;
    rom.map(vm)?;
    for (name, base) in [("flash0", FLASH0_BASE), ("flash1", FLASH1_BASE)] {
        bus.insert(
            name,
            base,
            FLASH_BANK_SIZE,
            Arc::new(Mutex::new(crate::devices::flash::FlashDevice::new())),
        )
        .map_err(Error::Bus)?;
    }
    Ok(())
}
// ANCHOR_END: machine_load_firmware_body
// ANCHOR_END: machine_load_firmware

fn stop_workers(workers: &[Arc<Worker>]) -> bool {
    crate::virtio::worker::stop_all(workers)
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
        // M16: `--cpus` is at most `MAX_CPUS` (config.rs) and at most what this host allows.
        check_cpus(cfg.cpus, caps.max_vcpus)?;
        let (vm, gic) = vm::create_vm_with(layout, ram_end, &caps, cfg.irqchip)?;
        // ANCHOR: machine_gic_checks
        // Startup assertions on the GIC layout, before any memory exists: on a mismatch, dropping
        // the VM destroys it and nothing else was built.
        if let Some(g) = &gic {
            vm::check_gic(g, layout)?;
        }
        // ANCHOR_END: machine_gic_checks
        // ANCHOR: machine_guest_ram
        // If allocation fails nothing is mapped yet: dropping the VM destroys it.
        let ram = Arc::new(GuestRam::new(
            &virt::ram_regions(cfg.mem_bytes),
            vm::ipa_bits(layout, ram_end),
        )?);
        // ANCHOR_END: machine_guest_ram
        let inputs = boot_inputs(cfg, host);
        let cpus = usize::try_from(cfg.cpus).map_err(|_| Error::Internal("cpus"))?;
        let mut bus = Bus::new();
        // M16: one PSCI row per vCPU, with the MPIDR that vCPU gets and the DT `cpu@N` names.
        let mpidrs: Vec<u64> = (0..cpus).map(crate::vcpu::mpidr_for).collect();
        let ctl = Arc::new(VmControl::with_cpus(&mpidrs));
        let mut workers = Vec::new();
        // M18: flash bank 0 for `--bios` (module docs). Allocated before anything is mapped,
        // so a failure here only has to drop the VM and RAM.
        let rom = match host.bios.as_deref() {
            Some(_) => match RomRegion::new(
                GuestAddress(FLASH0_BASE),
                FLASH_SIZE,
                vm::ipa_bits(layout, ram_end),
            ) {
                Ok(rom) => Some(rom),
                Err(e) => {
                    vm::teardown(vm, gic, ram, None)?;
                    return Err(e);
                }
            },
            None => None,
        };
        let loaded = ram
            .map(&vm)
            .and_then(|()| load_firmware(rom.as_ref(), host, &vm, &mut bus))
            .and_then(|()| Ok(loader::plan::load(&plan, &inputs, &*ram)?))
            .and_then(|()| Ok(loader::load_dtb(&plan, &dtb, &*ram)?))
            .and_then(|()| virt::register_devices(cfg, &mut bus))
            .and_then(|()| {
                // M12: devices in their ADR-0005 slots, each with a worker thread.
                let env = virt::VirtioEnv {
                    mem: ram.clone(),
                    gic: gic.as_ref(),
                    entropy: host.entropy,
                    ctl: Arc::clone(&ctl),
                    // M13: the console's sink, and its input when stdin is bound to it.
                    console: host.console.clone(),
                    console_input: (host.stdin == crate::backend::serial::StdinBinding::Console)
                        .then(|| Arc::clone(&host.console_input)),
                    // M14: the disk images HostIo opened and locked, in --disk order.
                    disks: host
                        .disks
                        .iter()
                        .cloned()
                        .map(|d| d as Arc<dyn crate::backend::file::BlockBackend>)
                        .collect(),
                    // M24: the NICs' sockets and MACs HostIo set up, in --net order.
                    nets: host.nets.clone(),
                };
                workers = virt::register_virtio_with(cfg, &mut bus, &env)?;
                Ok(())
            })
            .and_then(|()| virt::platform_irqs(gic.as_ref()))
            .and_then(|irqs| {
                virt::register_platform_with(
                    &mut bus,
                    &host.serial,
                    &host.serial_input,
                    cfg.cpus,
                    irqs,
                )
            });
        let uart = match loaded {
            Ok(uart) => uart,
            Err(e) => {
                // Tear the half-built VM down safely; the build error is the one to report,
                // unless teardown itself failed (then memory was leaked: the bigger problem).
                // The workers and the transports hold guest RAM: join and drop them first.
                stop_workers(&workers);
                drop(workers);
                drop(bus);
                vm::teardown(vm, gic, ram, rom)?;
                return Err(e);
            }
        };
        // ANCHOR: serial_input_hook
        // Input pushed by the stdin thread wakes this boot's UART. A weak reference: the
        // hook never keeps a torn-down machine's device alive.
        let weak = Arc::downgrade(&uart);
        host.serial_input.set_hook(Some(Arc::new(move || {
            if let Some(u) = weak.upgrade() {
                crate::sync::lock(&u).input_ready();
            }
        })));
        // ANCHOR_END: serial_input_hook
        Ok(Machine {
            vm,
            gic,
            irqchip: cfg.irqchip,
            cpus,
            stats: cfg.stats,
            ram,
            rom,
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
            ctl,
            workers,
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
        let ctl = Arc::clone(&self.ctl);
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
            watch: None,
            // M18: the ISV = 0 path may fetch instructions from the ROM (read-only).
            rom: self
                .rom
                .as_ref()
                .map(|r| r as &dyn crate::arch::stage1_walk::InsnRom),
        };
        // ANCHOR: boot_params_x0
        let boot = BootParams {
            pc: self.plan.entry,
            x: [self.plan.x0, 0, 0, 0],
            cpsr: self.plan.cpsr,
        };
        // ANCHOR_END: boot_params_x0
        let obs = Observe {
            trace: self.trace.as_deref(),
            clock: Clock::new(self.vtimer_offset),
            host: Some(&self.hostctl),
        };
        let per_vcpu = Mutex::new(Vec::new());
        let setup = manager::VcpuSetup {
            boot: &boot,
            cpus: self.cpus,
            redistributors: (self.irqchip == IrqChip::InKernelGicV3)
                .then_some(crate::arch::layout::GICR_BASE),
            vtimer_offset: self.vtimer_offset,
            irqchip: self.irqchip,
            stats: &per_vcpu,
        };
        // ANCHOR: machine_stats_start
        let cpu0 = hvf::host::process_cpu_time();
        let t0 = Instant::now();
        let reason = manager::run_vcpus(&self.vm, &setup, &env, &obs, deadline);
        // ANCHOR_END: machine_stats_start
        // M12 (architecture §14.5): the vCPUs are joined; stop the virtio workers. RUST-7: a
        // worker panic is the verdict even if a guest stop was posted just before it.
        let reason = crate::virtio::worker::final_reason(reason, stop_workers(&self.workers));
        // ANCHOR: machine_stats_end
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
            // ANCHOR_END: machine_stats_end
            let mut lines = stats.report();
            // M24: each NIC's counters (`net0 slot 1: tx_packets=… rx_dropped_foreign=…`),
            // from the companions the workers stopped above.
            lines.extend(self.workers.iter().flat_map(|w| w.companion_stats()));
            self.hostctl.set_stats(lines);
        }
        // M11: the bus owns the virtio transports, and an activated device holds an
        // `Arc` of guest RAM; drop them first so teardown can free RAM (MEM-9, D20). M12: the
        // workers (already joined above) hold the devices too.
        drop(self.workers);
        drop(self.bus);
        vm::teardown(self.vm, self.gic, self.ram, self.rom)?;
        Ok(reason)
    }
}

#[cfg(test)]
mod tests {
    use super::check_cpus;

    #[test]
    fn cpus_above_the_host_limit_are_refused() {
        let err = check_cpus(4, 2).unwrap_err().to_string();
        assert!(err.contains("--cpus 4"), "{err}");
        assert!(err.contains("at most 2"), "{err}");
        assert!(check_cpus(2, 2).is_ok());
        assert!(check_cpus(1, 64).is_ok());
        assert!(check_cpus(65, 64).is_err());
    }
}
