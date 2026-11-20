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
//! needs; M16 the `--cpus` flag that sets it (1..=`MAX_CPUS`, checked in `validate`). The struct is `#[non_exhaustive]`, so adding one is
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

/// The most `--disk` images one VM may have (M14; a named cap, RUST-4: each is an open,
/// locked fd and a worker thread, and the 32 virtio-mmio slots are shared with the other
/// devices).
pub const MAX_DISKS: usize = 16;

/// `--disk F[,ro]` (M14): a raw disk image behind virtio-blk, opened and locked by `HostIo`
/// (threat model BLK-5, BLK-8, BLK-11).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskSpec {
    pub path: PathBuf,
    /// `,ro`: opened `O_RDONLY` with a shared lock; the device offers `VIRTIO_BLK_F_RO`.
    pub read_only: bool,
}

/// The most `--net` NICs one VM may have (M24, architecture §13.1).
pub const MAX_NETS: usize = 4;

/// Who a `--net unixgram` NIC talks to (M24; threat model NET-2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetPeer {
    /// `peer=PATH`: frames go there, and only datagrams from there are accepted (NET-1).
    Path(PathBuf),
    /// `,learn` (PLAN D17): the first sender bound at an absolute path becomes the peer, locked
    /// and logged.
    Learn,
}

/// `--net unixgram:LOCAL,peer=REMOTE[,mac=XX:..]` or `unixgram:LOCAL,learn` (M24): a virtio-net
/// NIC whose wire is a Unix datagram socket bound at `local` (architecture §11.3). The socket
/// is set up by `HostIo` (NET-3, NET-4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetSpec {
    pub local: PathBuf,
    pub peer: NetPeer,
    /// `mac=`; `None`: `02:6d:76` plus three bytes from `HostIo.entropy`.
    pub mac: Option<[u8; 6]>,
}

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
    /// `--bios F`: a firmware ROM image, read by `HostIo` (LDR-1: at most
    /// `loader::firmware::MAX_FIRMWARE`). M21 uses it for AVPBooter on `--machine vmapple`;
    /// M18 puts it in flash bank 0 of the `virt` machine (U-Boot), alone: the firmware loads
    /// the OS, so `--kernel`, `--raw`, `--initrd` and `--cmdline` are refused with it.
    pub bios: Option<PathBuf>,
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

/// The refusal of `--serial stdio` together with `--console stdio` (M13; exit code 2). The
/// serial sink defaults to `stdio`, so `--console stdio` needs `--serial file:F` or `none`.
pub const BOTH_STDIO: &str = "only one of --serial/--console may be stdio";

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
    /// Number of vCPUs (`--cpus`, M16): 1..=`MAX_CPUS` here, and at most the host's
    /// `hv_vm_get_max_vcpu_count` when the VM is built. `--irqchip none` needs exactly 1.
    pub cpus: u32,
    /// `--dry-run` (M9): print the boot plan, memory map and DTB summary, then exit 0 without
    /// any HVF call.
    pub dry_run: bool,
    /// `--rng` (M12): a virtio-rng device fed by the host CSPRNG (architecture §11.3), in the
    /// slot ADR-0005 assigns it (after the disks).
    pub rng: bool,
    /// `--disk F[,ro]` (M14), in command-line order: disk `i` is virtio-blk in slot `i`
    /// (ADR-0005), so the first one is always Linux's `/dev/vda`.
    pub disks: Vec<DiskSpec>,
    /// M21: the directory of the two vmapple SLA lock files (ADR-0008 decision 6; the CLI sets
    /// `$HOME/.cache/macvmm/vmapple-slots`, one per user, independent of the working directory
    /// and `MACVMM_CACHE`). Used only by `--machine vmapple`.
    pub vmapple_slots: Option<PathBuf>,
    /// `--console stdio|file:F[,strict|,raw][,max=SIZE]` (M13): a virtio-console whose TX goes
    /// to this sink through its own `AnsiFilter` (TTY-1), in the slot after `--rng` (ADR-0005).
    /// `None`: no console device. Its kind is never [`SinkKind::None`].
    pub console: Option<SinkSpec>,
    /// `--net` (M24), in command-line order, at most [`MAX_NETS`]: virtio-net NICs in the slots
    /// after `--console` (ADR-0005).
    pub net: Vec<NetSpec>,
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
            rng: false,
            disks: Vec::new(),
            vmapple_slots: None,
            console: None,
            net: Vec::new(),
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
        if self.machine != MachineProfile::Virt {
            // M21: the vmapple board boots only its ROM and has its own rules.
            #[cfg(feature = "experimental-vmapple")]
            crate::machine::vmapple::validate(self)?;
        } else if self.boot.bios.is_some() {
            // M18: firmware boots alone (`loader::plan::plan_firmware`).
            let others = [
                (self.boot.kernel.is_some(), "--kernel"),
                (!self.boot.raw.is_empty(), "--raw"),
                (self.boot.initrd.is_some(), "--initrd"),
                (self.boot.cmdline.is_some(), "--cmdline"),
            ];
            if let Some((_, flag)) = others.iter().find(|(given, _)| *given) {
                return Err(Error::Config(format!(
                    "{flag} cannot be combined with --bios: the firmware loads the OS itself \
                     (from a --disk)"
                )));
            }
        } else if self.boot.kernel.is_none() && self.boot.raw.is_empty() {
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
        // M13: the console sink. Stdin is bound to the one `stdio` sink (architecture §14.4),
        // so two would be ambiguous: refused (exit code 2).
        if let Some(c) = &self.console {
            if c.kind == SinkKind::Stdio && self.serial.kind == SinkKind::Stdio {
                return Err(Error::Config(BOTH_STDIO.into()));
            }
            if c.kind == SinkKind::None {
                return Err(Error::Config(
                    "--console takes stdio or file:FILE (leave it out for no console)".into(),
                ));
            }
            if c.kind == SinkKind::File && c.path.is_none() {
                return Err(Error::Config("--console file: needs a file name".into()));
            }
            if c.max_bytes == 0 {
                return Err(Error::Config(
                    "--console: max must be at least 1 byte".into(),
                ));
            }
        }
        if self.disks.len() > MAX_DISKS {
            return Err(Error::Config(format!(
                "at most {MAX_DISKS} --disk images are allowed"
            )));
        }
        // M24: at most four NICs, each on its own socket, never its own peer.
        if self.net.len() > MAX_NETS {
            return Err(Error::Config(format!(
                "at most {MAX_NETS} --net devices are allowed"
            )));
        }
        for (i, n) in self.net.iter().enumerate() {
            if n.local.as_os_str().is_empty() {
                return Err(Error::Config("--net unixgram: needs a socket path".into()));
            }
            if n.peer == NetPeer::Path(n.local.clone()) {
                return Err(Error::Config(format!(
                    "--net unixgram: {:?} cannot be its own peer",
                    n.local
                )));
            }
            if self.net.iter().take(i).any(|m| m.local == n.local) {
                return Err(Error::Config(format!(
                    "--net unixgram: {:?} given twice",
                    n.local
                )));
            }
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
    /// The `--irqchip none` restriction: the teaching mode exists only for our own test guests
    /// on one vCPU. A real operating system expects an interrupt controller, so anything else
    /// is refused with exit code 2 before any Hypervisor.framework call. `test_guest` says
    /// whether the loaded bytes are one of our test guests.
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

    /// M13: at most one `stdio` sink (stdin goes to it, architecture §14.4); exit code 2.
    #[test]
    fn console_sink_rules() {
        let stdio = SinkSpec::default();
        let file = SinkSpec {
            kind: SinkKind::File,
            path: Some("c.out".into()),
            ..SinkSpec::default()
        };
        let mut c = with_raw();
        c.console = Some(stdio.clone());
        let e = c.validate().unwrap_err();
        assert!(matches!(&e, Error::Config(m) if m == BOTH_STDIO), "{e:?}");
        assert_eq!(e.exit_code(), 2);
        c.serial = file.clone();
        assert!(c.validate().is_ok());
        c.serial = SinkSpec::default();
        c.console = Some(file.clone());
        assert!(c.validate().is_ok());
        c.console = Some(SinkSpec {
            kind: SinkKind::None,
            ..SinkSpec::default()
        });
        assert!(c.validate().is_err());
        c.console = Some(SinkSpec {
            path: None,
            ..file.clone()
        });
        assert!(c.validate().is_err());
        c.console = Some(SinkSpec {
            max_bytes: 0,
            ..file
        });
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
