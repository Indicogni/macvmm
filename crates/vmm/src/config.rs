//! `VmConfig`: everything the user asked for, as plain data (architecture §6.7, §13.1).
//!
//! **Why a separate type, with no argv parsing here.** The CLI (`crates/macvmm/src/cli.rs`)
//! turns flags into a `VmConfig`; tests, the future API socket and the course's checkpoint
//! harness build one directly. Keeping parsing out of the library means every entry point gets
//! the same [`VmConfig::validate`], and the library never sees a string it has to interpret
//! (threat model B5: user foot-guns become attacks once scripted).
//!
//! **Paths are not inputs yet.** A `VmConfig` only *names* host files. They are opened and
//! read exactly once by `backend::hostio::HostIo::open` (threat model HOSTIO-1), and the
//! machine is built from those bytes, never from the paths (architecture §21.2).
//!
//! Fields arrive with their milestones (architecture §6.7 lists the full set): M3 has the RAM
//! size, the boot inputs, the serial sink, `--timeout`, `--unhandled-mmio` and the debug-call
//! switch; M4 adds `--trace` ([`TraceSpec`]) and `--testdev`; M5 `--on-reset`
//! ([`ResetAction`]) and `--debug-hvc` / `--no-debug-hvc` ([`DebugHvc`]); M8 the hidden
//! `--irqchip none` ([`IrqChip`], architecture §9.1) and the `cpus` field its restriction
//! needs (the `--cpus` flag itself is M16). The struct is `#[non_exhaustive]`, so adding one is
//! additive.

use crate::arch::layout::{Layout, MachineProfile, RAM_DEFAULT};
use crate::backend::ansi::FilterPolicy;
use crate::error::{Error, Result};
use crate::trace::{DEFAULT_TRACE_MAX, TraceCats};
use std::path::PathBuf;
use std::time::Duration;

/// The most `--raw` blobs one VM may load (a named cap, RUST-4: each is a host read).
pub const MAX_RAW_INPUTS: usize = 16;
/// The longest `--timeout` accepted: one year. `Instant + Duration` panics on overflow, so an
/// unbounded value from the user must never reach the deadline arithmetic.
pub const MAX_TIMEOUT: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// `--raw F@ADDR`: a flat binary loaded at a guest-physical address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawSpec {
    pub path: PathBuf,
    pub addr: u64,
}

/// What to boot. M3: an ELF (`--kernel`) and/or flat blobs (`--raw`). M9 adds the arm64
/// Image (also `--kernel`, told apart by its bytes), `--initrd` and `--cmdline`; M18 `--bios`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BootSource {
    pub kernel: Option<PathBuf>,
    pub raw: Vec<RawSpec>,
    /// `--initrd F` (M9): read by `HostIo` under the RAM-size cap (LDR-1).
    pub initrd: Option<PathBuf>,
    /// `--cmdline S` (M9): `/chosen/bootargs`, at most 2047 bytes without NUL (FDT-2).
    pub cmdline: Option<String>,
}

/// `--unhandled-mmio`: what a guest access to an IPA that is neither RAM nor a device does
/// (architecture §8.3 step 1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MmioPolicy {
    /// Stop the VM, exit code 3 (the default: a silent RAZ/WI hides guest bugs).
    #[default]
    Fatal,
    /// Read as zero, ignore writes, `guest_warn!` (rate-limited, LOG-1).
    Log,
}

/// The macvmm debug hypercalls `0xC600_4D01..4` (architecture §8.6, threat model HC-2).
/// `Auto` turns them on only for test guests (ELF and `--raw` boots), so a real OS never sees
/// the extra surface. `--debug-hvc` / `--no-debug-hvc` (M5) override it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DebugHvc {
    #[default]
    Auto,
    On,
    Off,
}

/// `--on-reset`: what a guest's PSCI SYSTEM_RESET does (architecture §14.5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ResetAction {
    /// Rebuild the machine in-process from the same `HostIo` bytes, `generation + 1` (the
    /// default; HOSTIO-1, HC-5).
    #[default]
    Reboot,
    /// End the process with exit code 4 (what tests use).
    Exit,
}

/// `--irqchip` (M8, architecture §9, §9.1): who delivers interrupts to the vCPU.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IrqChip {
    /// HVF's in-kernel GICv3 (`hv_gic_create`, ADR-0004): the default and the only mode real
    /// OSes run in.
    #[default]
    InKernelGicV3,
    /// No interrupt controller: the VMM turns `VTIMER_ACTIVATED` into the vCPU's IRQ line
    /// itself and emulates WFI (the ch11 teaching mode, hidden flag `--irqchip none`). Allowed
    /// only for test guests (ELF or `--raw`) on one vCPU (threat model §10.2 M8).
    None,
}

/// The `--irqchip none` refusal (exit code 2), shared by both restriction checks.
pub const IRQCHIP_NONE_RESTRICTION: &str = "--irqchip none needs a test guest and --cpus 1";

/// Where a byte stream from the guest goes (`--serial stdio|file:F|none`, M6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SinkKind {
    /// The process's stdout; this sink also gets stdin (architecture §14.4).
    #[default]
    Stdio,
    /// The file in [`SinkSpec::path`], opened by `HostIo` under PATH-3..6.
    File,
    /// Discard.
    None,
}

/// A guest output sink: where, through which terminal filter (TTY-1, TTY-2), and with which
/// byte cap (LOG-4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SinkSpec {
    pub kind: SinkKind,
    pub policy: FilterPolicy,
    /// The output file for [`SinkKind::File`].
    pub path: Option<PathBuf>,
    /// The byte cap of a file sink (`,max=SIZE`, default 1 GiB, at least 1). Stdout has none.
    pub max_bytes: u64,
}

impl Default for SinkSpec {
    fn default() -> SinkSpec {
        SinkSpec {
            kind: SinkKind::Stdio,
            policy: FilterPolicy::Safe,
            path: None,
            max_bytes: crate::backend::serial::DEFAULT_SINK_MAX,
        }
    }
}

/// `--trace exits:F[:cats][,max=SIZE]` (architecture §13.1; LOG-3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TraceSpec {
    /// The JSONL output file (opened by `HostIo` under PATH-3..6).
    pub path: PathBuf,
    /// Which exits to write (default: all).
    pub cats: TraceCats,
    /// The byte cap (default 1 GiB, at least 1).
    pub max_bytes: u64,
}

impl TraceSpec {
    /// A trace of every exit to `path` with the default cap.
    pub fn new(path: PathBuf) -> TraceSpec {
        TraceSpec {
            path,
            cats: TraceCats::ALL,
            max_bytes: DEFAULT_TRACE_MAX,
        }
    }
}

/// The whole VM configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct VmConfig {
    pub machine: MachineProfile,
    /// RAM size in bytes (`--mem`, default 512 MiB).
    pub mem_bytes: u64,
    pub boot: BootSource,
    /// The PL011's output and DEBUG_PUTC (`--serial`, M6).
    pub serial: SinkSpec,
    /// `--timeout`: wall-clock limit, then exit code 5.
    pub timeout: Option<Duration>,
    pub unhandled_mmio: MmioPolicy,
    pub debug_hvc: DebugHvc,
    /// `--trace exits:...`: the JSONL exit trace (M4).
    pub trace: Option<TraceSpec>,
    /// `--testdev`: map the scratch-register test device at `TESTDEV_BASE` (M4).
    pub testdev: bool,
    /// `--dtb-out F`: write the generated device tree, seeds zeroed (M7, FDT-4). An output
    /// under PATH-3..6, opened by `HostIo`.
    pub dtb_out: Option<PathBuf>,
    /// `--on-reset reboot|exit` (M5).
    pub on_reset: ResetAction,
    /// `--stats`: print the counters at stop (M6: the console I/O counters; M8 adds exits).
    pub stats: bool,
    /// `--irqchip` (M8; hidden flag, architecture §9.1).
    pub irqchip: IrqChip,
    /// Number of vCPUs. Always 1 until `--cpus` arrives in M16; M8 needs the field for the
    /// `--irqchip none` restriction.
    pub cpus: u32,
    /// `--dry-run` (M9): print the boot plan, memory map and DTB summary, then exit 0 without
    /// any HVF call.
    pub dry_run: bool,
}

impl Default for VmConfig {
    fn default() -> VmConfig {
        VmConfig {
            machine: MachineProfile::Virt,
            mem_bytes: RAM_DEFAULT,
            boot: BootSource::default(),
            serial: SinkSpec::default(),
            timeout: None,
            unhandled_mmio: MmioPolicy::default(),
            debug_hvc: DebugHvc::default(),
            trace: None,
            testdev: false,
            dtb_out: None,
            on_reset: ResetAction::default(),
            stats: false,
            irqchip: IrqChip::default(),
            cpus: 1,
            dry_run: false,
        }
    }
}

impl VmConfig {
    /// Check everything that can be checked without touching the host: the RAM size against
    /// the layout, that something is booted, and the caps. Every failure is `Error::Config`
    /// (exit code 2).
    pub fn validate(&self) -> Result<()> {
        Layout::virt()
            .ram_end(self.mem_bytes)
            .map_err(|e| Error::Config(format!("--mem: {e}")))?;
        if self.boot.kernel.is_none() && self.boot.raw.is_empty() {
            return Err(Error::Config(
                "nothing to boot: give --kernel F or --raw F@ADDR".into(),
            ));
        }
        // M9: Linux-only inputs need a kernel; whether it is an Image is decided from its
        // bytes by the loader plan (the path says nothing, HOSTIO-1).
        if self.boot.kernel.is_none() {
            if self.boot.initrd.is_some() {
                return Err(Error::Config("--initrd needs --kernel".into()));
            }
            if self.boot.cmdline.is_some() {
                return Err(Error::Config("--cmdline needs --kernel".into()));
            }
        }
        if let Some(c) = &self.boot.cmdline {
            crate::loader::plan::check_cmdline(c).map_err(|e| Error::Config(e.to_string()))?;
        }
        if self.serial.kind == SinkKind::File && self.serial.path.is_none() {
            return Err(Error::Config("--serial file: needs a file name".into()));
        }
        if self.serial.max_bytes == 0 {
            return Err(Error::Config(
                "--serial: max must be at least 1 byte".into(),
            ));
        }
        if self.boot.raw.len() > MAX_RAW_INPUTS {
            return Err(Error::Config(format!(
                "at most {MAX_RAW_INPUTS} --raw inputs are allowed"
            )));
        }
        if let Some(t) = &self.trace
            && t.max_bytes == 0
        {
            return Err(Error::Config("--trace: max must be at least 1 byte".into()));
        }
        if let Some(t) = self.timeout
            && (t.is_zero() || t > MAX_TIMEOUT)
        {
            return Err(Error::Config(format!(
                "--timeout must be between 1 and {} seconds",
                MAX_TIMEOUT.as_secs()
            )));
        }
        if self.cpus == 0 || self.cpus > crate::arch::layout::MAX_CPUS {
            return Err(Error::Config(format!(
                "--cpus must be between 1 and {}",
                crate::arch::layout::MAX_CPUS
            )));
        }
        if self.irqchip == IrqChip::None && self.cpus != 1 {
            return Err(Error::Config(IRQCHIP_NONE_RESTRICTION.into()));
        }
        Ok(())
    }

    // ANCHOR: irqchip_none_restrictions
    /// The half of the `--irqchip none` restriction that needs the input bytes (threat model
    /// §10.2 M8): the teaching mode exists for test guests only. `test_guest` is
    /// `machine::is_test_guest` (decided from the `HostIo` bytes, HOSTIO-1). An arm64 Image,
    /// firmware or vmapple boot would expect a GIC (the DTB of a real OS describes one), so it
    /// is refused with exit code 2 before any HVF call.
    pub fn validate_irqchip(&self, test_guest: bool) -> Result<()> {
        if self.irqchip == IrqChip::None && (!test_guest || self.cpus != 1) {
            return Err(Error::Config(IRQCHIP_NONE_RESTRICTION.into()));
        }
        Ok(())
    }
    // ANCHOR_END: irqchip_none_restrictions

    /// Whether the debug hypercalls answer for this boot (HC-2). `test_guest` is true for ELF
    /// and `--raw` boots and false for an arm64 Image, `--bios` and `--machine vmapple`
    /// (`machine::is_test_guest` decides it from the `HostIo` bytes).
    pub fn debug_calls_enabled(&self, test_guest: bool) -> bool {
        match self.debug_hvc {
            DebugHvc::Auto => test_guest,
            DebugHvc::On => true,
            DebugHvc::Off => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_raw() -> VmConfig {
        VmConfig {
            boot: BootSource {
                kernel: None,
                raw: vec![RawSpec {
                    path: "x.bin".into(),
                    addr: 0x4008_0000,
                }],
                ..BootSource::default()
            },
            ..VmConfig::default()
        }
    }

    #[test]
    fn validate_rules() {
        assert!(with_raw().validate().is_ok());
        assert!(matches!(
            VmConfig::default().validate(),
            Err(Error::Config(m)) if m.contains("nothing to boot")
        ));
        let mut c = with_raw();
        c.mem_bytes = 63 << 20;
        assert!(c.validate().is_err());
        c.mem_bytes = u64::MAX;
        assert!(c.validate().is_err());
        let mut c = with_raw();
        c.timeout = Some(Duration::ZERO);
        assert!(c.validate().is_err());
        c.timeout = Some(MAX_TIMEOUT + Duration::from_secs(1));
        assert!(c.validate().is_err());
        c.timeout = Some(Duration::from_secs(10));
        assert!(c.validate().is_ok());
        let mut c = with_raw();
        c.boot.raw = vec![c.boot.raw[0].clone(); MAX_RAW_INPUTS + 1];
        assert!(c.validate().is_err());
        let mut c = with_raw();
        let mut t = TraceSpec::new("t.jsonl".into());
        t.max_bytes = 0;
        c.trace = Some(t);
        assert!(c.validate().is_err());
    }

    /// Security test `irqchip_none_restrictions` (PLAN M8): `--irqchip none` only with a test
    /// guest and one vCPU; both refusals are config errors (exit code 2).
    #[test]
    fn irqchip_none_restrictions() {
        let mut c = with_raw();
        assert_eq!(c.irqchip, IrqChip::InKernelGicV3);
        c.irqchip = IrqChip::None;
        assert!(c.validate().is_ok());
        assert!(c.validate_irqchip(true).is_ok());
        // An arm64 Image (not a test guest) with --irqchip none.
        let e = c.validate_irqchip(false).unwrap_err();
        assert!(matches!(&e, Error::Config(m) if m == IRQCHIP_NONE_RESTRICTION));
        assert_eq!(e.exit_code(), 2);
        // --cpus 2 --irqchip none.
        c.cpus = 2;
        let e = c.validate().unwrap_err();
        assert!(matches!(&e, Error::Config(m) if m == IRQCHIP_NONE_RESTRICTION));
        assert!(c.validate_irqchip(true).is_err());
        // The same machine with the GIC is fine, and the vCPU count is bounded.
        c.irqchip = IrqChip::InKernelGicV3;
        assert!(c.validate().is_ok() && c.validate_irqchip(false).is_ok());
        c.cpus = 0;
        assert!(c.validate().is_err());
        c.cpus = crate::arch::layout::MAX_CPUS + 1;
        assert!(c.validate().is_err());
    }

    #[test]
    fn debug_call_defaults() {
        let mut c = VmConfig::default();
        assert!(c.debug_calls_enabled(true));
        assert!(!c.debug_calls_enabled(false));
        c.debug_hvc = DebugHvc::Off;
        assert!(!c.debug_calls_enabled(true));
        c.debug_hvc = DebugHvc::On;
        assert!(c.debug_calls_enabled(false));
    }
}
