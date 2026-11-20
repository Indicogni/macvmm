//! The experimental `vmapple` board: run Apple's macOS-guest boot ROM, AVPBooter, and record
//! what it touches (PLAN M21, stage S1 of `docs/macos-guest-requirements.md`; ADR-0008
//! decision 3; ADR-0009). Behind the cargo feature `experimental-vmapple`, off by default.
//!
//! **What this is, and what it is not.** A macOS guest needs far more than this board has
//! (`docs/macos-guest-requirements.md`): a configuration block, Apple's paravirtual disk
//! interface, PCIe, an AES engine, and above all a CPU mode that Hypervisor.framework refuses
//! to third-party VMMs (`HV_DENIED`, demonstrated by `tools/hv-denied-probe`). S1 makes no
//! attempt at any of it. Its whole claim is: *AVPBooter executes in macvmm, and we observe its
//! first device accesses.* It never boots macOS, and nothing here may say it does
//! (ADR-0008 decision 1).
//!
//! **The machine** (architecture §5.2, `layout.rs`):
//! - AVPBooter's bytes (read by `HostIo` from the system copy at run time, never written to
//!   disk: TEST-11) in a 1 MiB ROM at `ROM_BASE`, mapped read+execute (`loader::firmware`);
//! - RAM at `RAM_BASE`, `--mem` bytes, zero-filled (MEM-10);
//! - the in-kernel GICv3 at the vmapple GICD/GICR bases (ADR-0004);
//! - a PL011 at the vmapple UART base, on SPI 1;
//! - **nothing else**: every other access goes to the [`unknown::UnknownMmio`] logger. That
//!   includes an ISV = 0 access the M17 decoder cannot emulate (from the ROM it cannot fetch
//!   the instruction at all, the ROM not being `GuestMemory`): it is logged as `ISV=0, not
//!   emulated` and then **stops** the VM, instead of the synchronous external abort the `virt`
//!   board injects, because an abort the ROM would never see under VZ would turn the rest of
//!   the trace into macvmm's artefact.
//!
//! **The CPU** starts like a real core leaving reset into a boot ROM: EL1h with D, A, I and F
//! masked (`CPSR = 0x3c5`), the MMU and caches off, `PC = ROM_BASE`, `x0..x3 = 0` (there is no
//! DTB to point at: AVPBooter does not take one). Only vCPU 0 exists; PSCI CPU_ON is the only
//! way a secondary could start, and `--cpus` is refused.
//!
//! **The watch** ([`Watch`], an `ExitWatch`): it prints `vmapple: first exit at pc=…` for the
//! first exit, stops with `vmapple: stopped at unsupported HVC …` on a hypercall macvmm has no
//! answer for (rather than returning -1 and letting the ROM wander), and hands accesses to no
//! device to the logger when `--unhandled-mmio log` is given. With the default `fatal`, the
//! first such access is logged and then stops the VM as on `virt`. A refused ISV = 0 access
//! stops the VM under either policy (above).
//!
//! **Licence guard** (ADR-0008 decision 6): `HostIo::open` takes one of two lock files
//! (in `$HOME/.cache/macvmm/vmapple-slots`, one directory per user) before any HVF call; a
//! third concurrent vmapple instance of the same user is refused (exit code 2). The guard is
//! advisory: it prevents accidents, and HVF itself enforces no limit.
//!
//! **Debug hypercalls are off** (HC-2): AVPBooter is firmware, not a test guest, and
//! `--debug-hvc` is refused.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod layout;
pub mod unknown;

use crate::arch::esr::Exit;
use crate::backend::hostio::HostIo;
use crate::bus::Bus;
use crate::config::{DebugHvc, IrqChip, MmioPolicy, VmConfig};
use crate::control::{StopReason, VmControl};
use crate::devices::pl011::{PL011_SIZE, Pl011};
use crate::error::{Error, Result};
use crate::irq::{GicSpi, IrqLine, SpiLimits};
use crate::loader::firmware;
use crate::loader::plan::CPSR_EL1H_DAIF_MASKED;
use crate::memory::{GuestAddress, GuestRam, RomRegion};
use crate::stats::BootStats;
use crate::trace::Clock;
use crate::vcpu::exit::{
    ExitEnv, ExitWatch, MmioVerdict, RefusedAccess, UnclaimedAccess, VcpuRegs,
};
use crate::vcpu::run_loop::Observe;
use crate::vcpu::{BootParams, manager};
use crate::vm;
use hvf::{Capabilities, Gic, GicConfig, Vm, VmBuilder};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use unknown::UnknownMmio;

/// The `--machine vmapple` rules `VmConfig::validate` applies (exit code 2 on any).
pub fn validate(cfg: &VmConfig) -> Result<()> {
    let refuse = |what: &str| {
        Err(Error::Config(format!(
            "--machine vmapple: {what} (the vmapple board boots only its ROM, PLAN M21)"
        )))
    };
    if cfg.boot.bios.is_none() {
        return refuse("needs --bios FILE (the CLI defaults it to the system AVPBooter)");
    }
    if cfg.boot.kernel.is_some() || !cfg.boot.raw.is_empty() {
        return refuse("--kernel and --raw are not supported");
    }
    if cfg.boot.initrd.is_some() || cfg.boot.cmdline.is_some() {
        return refuse("--initrd and --cmdline are Linux-only");
    }
    // M13: `--console` too, or its file would be opened and stdin bound to a queue that no
    // device ever drains (vmapple registers no virtio devices).
    if cfg.testdev || cfg.dtb_out.is_some() || cfg.rng || cfg.console.is_some() {
        return refuse("--testdev, --dtb-out, --rng and --console are virt-only");
    }
    if cfg.cpus != 1 {
        return refuse("only one vCPU (secondaries stay off)");
    }
    if cfg.irqchip != IrqChip::InKernelGicV3 {
        return refuse("--irqchip none is for test guests");
    }
    if cfg.debug_hvc == DebugHvc::On {
        return refuse("--debug-hvc is never offered to firmware (HC-2)");
    }
    if cfg.vmapple_slots.is_none() {
        return refuse(
            "no SLA lock directory: HOME is unset or not absolute (ADR-0008 decision 6)",
        );
    }
    Ok(())
}

/// The vmapple exit watch (module docs).
#[derive(Debug, Default)]
pub struct Watch {
    first_exit: OnceLock<u64>,
    /// `--unhandled-mmio log`: keep going (RAZ/WI) until the cap.
    keep_going: bool,
    pub unknown: UnknownMmio,
}

impl Watch {
    pub fn new(policy: MmioPolicy) -> Watch {
        Watch {
            keep_going: policy == MmioPolicy::Log,
            ..Watch::default()
        }
    }

    /// The PC of the boot's first exit, once there was one.
    pub fn first_exit_pc(&self) -> Option<u64> {
        self.first_exit.get().copied()
    }
}

/// True if macvmm has an answer designed for SMCCC function `x0` (SMCCC 1.1 / PSCI 1.1, or a
/// known probe answered NOT_SUPPORTED on purpose). The macvmm debug calls do not count: they
/// are off for firmware (HC-2).
pub fn hvc_supported(x0: u64) -> bool {
    crate::smccc::function_name(x0).is_some_and(|name| !name.starts_with("DEBUG_"))
}

impl ExitWatch for Watch {
    fn before_exit(&self, regs: &dyn VcpuRegs, exit: &Exit) -> Result<Option<String>> {
        let pc = regs.pc()?;
        if self.first_exit.set(pc).is_ok() {
            crate::warn!("vmapple: first exit at pc={pc:#x}: {exit}");
        }
        let (conduit, imm) = match *exit {
            Exit::Hvc { imm } => ("HVC", imm),
            Exit::Smc { imm } => ("SMC", imm),
            _ => return Ok(None),
        };
        let x0 = regs.x(0)?;
        if imm != 0 || !hvc_supported(x0) {
            return Ok(Some(format!(
                "vmapple: stopped at unsupported {conduit} {x0:#x} (imm {imm:#x}) at pc {pc:#x}"
            )));
        }
        Ok(None)
    }

    fn unclaimed_mmio(&self, access: &UnclaimedAccess) -> Option<MmioVerdict> {
        let verdict = self.unknown.record(access);
        // `fatal`: the access is logged, then the usual unhandled-MMIO stop applies.
        self.keep_going.then_some(verdict)
    }

    fn refused_isv0(&self, access: &RefusedAccess) -> Option<String> {
        // Counted like any access to no device (a device-backed one is not "unknown"), then a
        // stop under either policy: no abort is injected into the ROM (module docs).
        if access.unclaimed {
            self.unknown
                .record_undecoded(access.pc, access.ipa, access.write);
        }
        Some(format!(
            "vmapple: ISV=0 {} at {:#x} pc {:#x} not emulated; stopping instead of injecting \
             an abort",
            if access.write { "write" } else { "read" },
            access.ipa,
            access.pc
        ))
    }
}

/// `--dry-run --machine vmapple`: describe the board; no HVF call, no lock beyond `HostIo`'s.
pub fn dry_run(cfg: &VmConfig, host: &HostIo) -> Result<String> {
    use core::fmt::Write as _;
    let bios = host
        .bios
        .as_deref()
        .ok_or(Error::Internal("vmapple without --bios bytes"))?;
    firmware::check_rom_image(bios, layout::ROM_SIZE)
        .map_err(|e| Error::Config(format!("--bios: {e}")))?;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "macvmm vmapple board (dry run, no VM created; experimental, does not boot macOS)"
    );
    let _ = writeln!(
        out,
        "entry    pc={:#x} x0=0 cpsr={CPSR_EL1H_DAIF_MASKED:#x} (EL1h, MMU off, no DTB)",
        layout::ROM_BASE
    );
    let _ = writeln!(
        out,
        "rom      {} bytes of --bios in a {}-byte read+execute ROM",
        bios.len(),
        layout::ROM_SIZE
    );
    let _ = writeln!(out, "memory map (VmApple):");
    for r in layout::vmapple().regions {
        let model = match r.name {
            "avpbooter" => "rom",
            "gicd" => "in-kernel GIC",
            "gicr" => "in-kernel GIC (one 128 KiB frame; the rest: unknown-MMIO logger)",
            "pl011" => "pl011",
            _ => "unknown-MMIO logger",
        };
        let _ = writeln!(
            out,
            "  {:#010x}..{:#010x}  {:<10} {model}",
            r.base,
            r.end(),
            r.name
        );
    }
    let end = layout::ram_end(cfg.mem_bytes).unwrap_or(u64::MAX);
    let _ = writeln!(
        out,
        "  {:#010x}..{end:#010x}  {:<10} ram",
        layout::RAM_BASE,
        "ram"
    );
    let _ = write!(
        out,
        "unknown MMIO: {} (cap {}); debug hypercalls: off (HC-2)",
        if cfg.unhandled_mmio == MmioPolicy::Log {
            "logged, read as zero"
        } else {
            "the first one is fatal (use --unhandled-mmio log)"
        },
        unknown::UNKNOWN_MMIO_CAP
    );
    Ok(out)
}

/// Build and run boot `generation` (the `vmm::run` reboot loop calls this per boot).
pub fn boot(
    cfg: &VmConfig,
    host: &HostIo,
    generation: u64,
    deadline: Option<Instant>,
) -> Result<StopReason> {
    VmApple::build(cfg, host, generation)?.run(cfg, host, deadline)
}

/// A built, loaded, not yet running vmapple machine.
struct VmApple {
    vm: Vm,
    gic: Gic,
    ram: Arc<GuestRam>,
    rom: RomRegion,
    bus: Bus,
    generation: u64,
}

/// The PL011's interrupt line: SPI 1 on the live GIC, validated against its SPI range.
fn uart_irq(gic: &Gic) -> Result<Arc<dyn IrqLine>> {
    let limits = SpiLimits::of(gic).map_err(|err| Error::Hv {
        op: "query the GIC's SPI range",
        err,
    })?;
    let spi = GicSpi::new(layout::PL011_INTID, &limits, gic.handle())
        .map_err(|e| Error::Config(format!("in-kernel GIC: {e}")))?;
    Ok(Arc::new(spi))
}

impl VmApple {
    fn build(cfg: &VmConfig, host: &HostIo, generation: u64) -> Result<VmApple> {
        let bios = host
            .bios
            .as_deref()
            .ok_or(Error::Internal("vmapple without --bios bytes"))?;
        firmware::check_rom_image(bios, layout::ROM_SIZE)
            .map_err(|e| Error::Config(format!("--bios: {e}")))?;
        let board = layout::vmapple();
        let ram_end = layout::ram_end(cfg.mem_bytes)
            .ok_or(Error::Config("--mem: the RAM end overflows".into()))?;
        let caps = Capabilities::probe().map_err(|err| Error::Hv {
            op: "probe capabilities",
            err,
        })?;
        let bits = board.ipa_bits_needed(ram_end);
        if bits > caps.max_ipa_bits {
            return Err(Error::Config(format!(
                "the vmapple machine needs a {bits}-bit IPA space; this host supports {}",
                caps.max_ipa_bits
            )));
        }
        // The in-kernel GIC at the vmapple bases, created with the VM (ADR-0004).
        let (vm, gic) = VmBuilder::new()
            .ipa_bits(bits)
            .with_gic(GicConfig {
                distributor_base: layout::GICD_BASE,
                redistributor_base: layout::GICR_BASE,
                msi: None,
            })
            .create()
            .map_err(|err| Error::Hv {
                op: "create VM",
                err,
            })?;
        let gic = gic.ok_or(Error::Internal("VmBuilder::with_gic returned no GIC"))?;
        // Architecture §9 startup assertions; on a mismatch, dropping the VM destroys it.
        vm::check_gic(&gic, board)?;
        let ram = Arc::new(GuestRam::new(
            &[(GuestAddress(layout::RAM_BASE), cfg.mem_bytes)],
            bits,
        )?);
        let rom = match RomRegion::new(GuestAddress(layout::ROM_BASE), layout::ROM_SIZE, bits) {
            Ok(rom) => rom,
            Err(e) => {
                vm::teardown(vm, Some(gic), ram, None)?;
                return Err(e);
            }
        };
        let mut bus = Bus::new();
        let built = ram
            .map(&vm)
            .and_then(|()| {
                firmware::load_rom(&rom, bios).map_err(|e| Error::Config(format!("--bios: {e}")))
            })
            .and_then(|()| rom.map(&vm))
            .and_then(|()| uart_irq(&gic))
            .and_then(|irq| {
                let uart = Arc::new(Mutex::new(Pl011::new(
                    Arc::clone(&host.serial),
                    Some(Arc::clone(&host.serial_input)),
                    irq,
                )));
                bus.insert("pl011", layout::PL011_BASE, PL011_SIZE, uart.clone())
                    .map_err(Error::Bus)?;
                Ok(uart)
            });
        let uart = match built {
            Ok(uart) => uart,
            Err(e) => {
                drop(bus);
                vm::teardown(vm, Some(gic), ram, Some(rom))?;
                return Err(e);
            }
        };
        // Console input wakes this boot's UART (as `Machine::build`); a weak reference.
        let weak = Arc::downgrade(&uart);
        host.serial_input.set_hook(Some(Arc::new(move || {
            if let Some(u) = weak.upgrade() {
                crate::sync::lock(&u).input_ready();
            }
        })));
        Ok(VmApple {
            vm,
            gic,
            ram,
            rom,
            bus,
            generation,
        })
    }

    fn run(self, cfg: &VmConfig, host: &HostIo, deadline: Option<Instant>) -> Result<StopReason> {
        let ctl = Arc::new(VmControl::new());
        let attached = host.hostctl.attach(&ctl);
        let watch = Watch::new(cfg.unhandled_mmio);
        let env = ExitEnv {
            mem: &*self.ram,
            serial: &host.serial,
            ctl: &ctl,
            bus: &self.bus,
            generation: self.generation,
            debug_calls: false, // HC-2
            unhandled_mmio: cfg.unhandled_mmio,
            watch: Some(&watch),
            rom: None, // M18: the ISV = 0 ROM fetch hook is the virt machine's
        };
        let boot = BootParams {
            pc: layout::ROM_BASE,
            x: [0; 4],
            cpsr: CPSR_EL1H_DAIF_MASKED,
        };
        let vtimer_offset = crate::timer::boot_offset();
        let obs = Observe {
            trace: host.trace.as_deref(),
            clock: Clock::new(vtimer_offset),
            host: Some(&host.hostctl),
        };
        let per_vcpu = Mutex::new(Vec::new());
        let setup = manager::VcpuSetup {
            boot: &boot,
            cpus: 1, // M16: SMP is a `virt` feature; the AVPBooter probe runs one vCPU
            redistributors: None,
            vtimer_offset,
            irqchip: IrqChip::InKernelGicV3,
            stats: &per_vcpu,
        };
        let cpu0 = hvf::host::process_cpu_time();
        let t0 = Instant::now();
        let reason = manager::run_vcpus(&self.vm, &setup, &env, &obs, deadline);
        let wall = t0.elapsed();
        let cpu1 = hvf::host::process_cpu_time();
        drop(attached);
        host.serial_input.set_hook(None);
        if watch.first_exit_pc().is_none() {
            crate::warn!("vmapple: no exit was observed before the stop");
        }
        watch.unknown.finish();
        for (region, n) in watch.unknown.by_region() {
            crate::warn!("vmapple:   {n} in {region}");
        }
        if cfg.stats {
            let mut vcpus = crate::sync::lock(&per_vcpu).clone();
            vcpus.sort_by_key(|v| v.index);
            let stats = BootStats {
                vcpus,
                wall,
                host_cpu: cpu0.zip(cpu1).map(|(a, b)| b.saturating_sub(a)),
            };
            host.hostctl.set_stats(stats.report());
        }
        drop(self.bus);
        vm::teardown(self.vm, Some(self.gic), self.ram, Some(self.rom))?;
        Ok(reason)
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::config::RawSpec;
    use crate::vcpu::exit::tests::Fake;

    fn cfg() -> VmConfig {
        let mut c = VmConfig {
            machine: crate::arch::layout::MachineProfile::VmApple,
            ..VmConfig::default()
        };
        c.boot.bios = Some("avp.bin".into());
        c.vmapple_slots = Some("slots".into());
        c
    }

    #[test]
    fn config_rules() {
        cfg().validate().unwrap();
        let bad: [fn(&mut VmConfig); 9] = [
            |c| c.boot.bios = None,
            |c| c.boot.kernel = Some("k".into()),
            |c| {
                c.boot.raw.push(RawSpec {
                    path: "r".into(),
                    addr: 0x7000_0000,
                })
            },
            |c| c.boot.cmdline = Some("x".into()),
            |c| c.testdev = true,
            |c| c.console = Some(crate::config::SinkSpec::default()), // M13
            |c| c.cpus = 2,
            |c| c.debug_hvc = DebugHvc::On,
            |c| c.vmapple_slots = None,
        ];
        for f in bad {
            let mut c = cfg();
            f(&mut c);
            assert!(matches!(c.validate(), Err(Error::Config(_))), "{c:?}");
        }
        // M18: `--bios` alone on the virt machine is a firmware boot (flash bank 0).
        let mut v = VmConfig::default();
        v.boot.bios = Some("u-boot.bin".into());
        assert!(v.validate().is_ok());
    }

    #[test]
    fn hvc_policy() {
        assert!(hvc_supported(0x8400_0000)); // PSCI_VERSION
        assert!(hvc_supported(0x8400_0008)); // SYSTEM_OFF
        assert!(!hvc_supported(0xC600_0001)); // DEBUG_PUTC: off for firmware (HC-2)
        assert!(!hvc_supported(0xC200_0042)); // an unknown vendor call
        let w = Watch::new(MmioPolicy::Log);
        let mut r = Fake {
            pc: layout::ROM_BASE + 0x40,
            ..Fake::default()
        };
        r.x[0] = 0xC200_0042;
        let why = w.before_exit(&r, &Exit::Hvc { imm: 0 }).unwrap().unwrap();
        assert_eq!(
            why,
            "vmapple: stopped at unsupported HVC 0xc2000042 (imm 0x0) at pc 0x100040"
        );
        assert_eq!(w.first_exit_pc(), Some(layout::ROM_BASE + 0x40));
        r.x[0] = 0x8400_0000;
        r.pc = layout::ROM_BASE + 0x80;
        assert_eq!(w.before_exit(&r, &Exit::Hvc { imm: 0 }).unwrap(), None);
        // The first exit stays the first one.
        assert_eq!(w.first_exit_pc(), Some(layout::ROM_BASE + 0x40));
        assert!(w.before_exit(&r, &Exit::Hvc { imm: 1 }).unwrap().is_some());
    }

    /// The run loop's entry (`handle_watched`) turns the watch's verdict into a `GuestFatal`
    /// stop, and an unknown access into RAZ/WI through the logger.
    #[test]
    fn watch_drives_the_exit_path() {
        use crate::control::StopReason;
        use crate::vcpu::exit::tests::with_env_bus;
        use crate::vcpu::exit::{ExitAction, handle_watched};
        let w = Watch::new(MmioPolicy::Log);
        with_env_bus(MmioPolicy::Fatal, &Bus::new(), |env| {
            let env = ExitEnv {
                watch: Some(&w),
                rom: None, // M18
                ..*env
            };
            let mut r = Fake {
                pc: layout::ROM_BASE + 8,
                ..Fake::default()
            };
            r.x[0] = 0xC200_0042;
            // HVC #0: EC 0x16, IL = 1.
            let raw = hvf::VcpuExit {
                reason: hvf::ExitReason::Exception,
                esr: (0x16 << 26) | (1 << 25),
                far: 0,
                ipa: 0,
            };
            let exit = Exit::from_hv(raw.reason, raw.esr);
            let mut rec = crate::trace::ExitRecord::default();
            match handle_watched(&mut r, &env, &exit, &raw, &mut rec).unwrap() {
                ExitAction::Stop(StopReason::GuestFatal(g)) => {
                    assert!(
                        g.reason.contains("unsupported HVC 0xc2000042"),
                        "{}",
                        g.reason
                    );
                }
                other => panic!("{other:?}"),
            }
            // A 4-byte store to the cfg block (ISV = 1, SRT = 1): logged, RAZ/WI, resumed
            // although the policy in `env` is `fatal`, because the watch keeps going.
            let raw = hvf::VcpuExit {
                reason: hvf::ExitReason::Exception,
                esr: 0x9381_0046,
                far: layout::CFG_BASE,
                ipa: layout::CFG_BASE,
            };
            let exit = Exit::from_hv(raw.reason, raw.esr);
            let a = handle_watched(&mut r, &env, &exit, &raw, &mut rec).unwrap();
            assert!(
                matches!(a, ExitAction::Resume { advance_pc: true }),
                "{a:?}"
            );
        });
        assert_eq!(w.unknown.entries().len(), 1);
        assert_eq!(w.unknown.entries()[0].region, Some("cfg"));
    }

    #[test]
    fn fatal_policy_logs_then_defers_to_the_policy() {
        let a = UnclaimedAccess {
            pc: layout::ROM_BASE,
            ipa: layout::CFG_BASE,
            size: 4,
            write: None,
        };
        let strict = Watch::new(MmioPolicy::Fatal);
        assert_eq!(strict.unclaimed_mmio(&a), None);
        assert_eq!(strict.unknown.entries().len(), 1);
        let lenient = Watch::new(MmioPolicy::Log);
        assert_eq!(lenient.unclaimed_mmio(&a), Some(MmioVerdict::RazWi));
    }

    /// Review fix: an ISV = 0 access from the ROM (whose instruction cannot be fetched: the
    /// ROM is not `GuestMemory`) is counted by the logger and stops the VM through the real
    /// exit path, instead of injecting an abort into the ROM.
    #[test]
    fn refused_isv0_is_counted_and_stops() {
        use crate::control::StopReason;
        use crate::vcpu::exit::tests::with_env_bus;
        use crate::vcpu::exit::{ExitAction, handle_watched};
        for policy in [MmioPolicy::Log, MmioPolicy::Fatal] {
            let w = Watch::new(policy);
            with_env_bus(policy, &Bus::new(), |env| {
                let env = ExitEnv {
                    watch: Some(&w),
                    rom: None, // M18
                    ..*env
                };
                let mut r = Fake {
                    pc: layout::ROM_BASE + 0x20,
                    ..Fake::default()
                };
                // A data abort, ISV = 0, WnR = 1, DFSC = translation fault level 2.
                let raw = hvf::VcpuExit {
                    reason: hvf::ExitReason::Exception,
                    esr: (0x24 << 26) | (1 << 25) | (1 << 6) | 0x06,
                    far: layout::CFG_BASE + 0x40,
                    ipa: layout::CFG_BASE + 0x40,
                };
                let exit = Exit::from_hv(raw.reason, raw.esr);
                let mut rec = crate::trace::ExitRecord::default();
                match handle_watched(&mut r, &env, &exit, &raw, &mut rec).unwrap() {
                    ExitAction::Stop(StopReason::GuestFatal(g)) => {
                        assert!(
                            g.reason.starts_with(
                                "vmapple: ISV=0 write at 0x400040 pc 0x100020 not emulated"
                            ),
                            "{}",
                            g.reason
                        );
                    }
                    other => panic!("{policy:?}: {other:?}"),
                }
            });
            let e = w.unknown.entries();
            assert_eq!(e.len(), 1, "{policy:?}");
            assert_eq!(e[0].dir, unknown::Dir::Undecoded { write: true });
            assert_eq!(w.unknown.by_region(), vec![("cfg", 1)]);
        }
    }
}
