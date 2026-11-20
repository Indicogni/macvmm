//! `macvmm run`: the flag parser and the command (architecture §13.1; threat model PATH-8, B5).
//!
//! **Hand-written, strict parsing.** No argument-parsing crate (CLAUDE.md "Minimal
//! dependencies"): the grammar is small, and being exact about it is a security property,
//! because a VMM is scripted and a lenient parser turns typos into surprises:
//! - `--flag value` and `--flag=value` both work; repeated `--raw` flags accumulate;
//! - an **unknown flag is an error** (exit code 2 with usage), never ignored;
//! - sizes (`--mem 64M`) use checked multiplication, so `--mem 99999999999G` is refused, not
//!   wrapped to a small number (PATH-8);
//! - `--raw F@ADDR` needs an explicit `0x` and must fit in 64 bits (`vmm::loader::raw`);
//! - `--timeout SECS` is a whole number of seconds, 1 ..= one year (`vmm::config::MAX_TIMEOUT`).
//!
//! **The command** opens every input once (`HostIo::open`, HOSTIO-1) *before* any HVF call, so
//! a missing or non-regular file is exit code 2 on any Mac, then runs the VM and turns the stop
//! reason into the exit code of architecture §13.2, printing the VMM's verdict on stderr.
//!
//! Flags arrive with their milestones (§13.1): M3 has `--mem`, `--kernel` (ELF; an arm64 Image
//! is refused until M9), `--raw`, `--timeout`, `--unhandled-mmio`; M4 adds
//! `--trace exits:F[:cats][,max=SIZE]` and `--testdev`; M5 `--on-reset reboot|exit`,
//! `--debug-hvc` and `--no-debug-hvc`; M7 `--dtb-out F`; M6 `--serial stdio|file:F|none` with
//! `,strict`/`,raw` and `,max=SIZE`, and `--stats`; `--log` is global (main.rs). M8 extends
//! `--stats` with the exit counts, exec/WFI time and host CPU, and adds the hidden
//! `--irqchip none` (the ch11 no-GIC teaching mode, architecture §9.1; not in `--help`, PLAN
//! D13). M9 adds `--initrd F`, `--cmdline S` and `--dry-run`, and `--kernel` accepts an arm64
//! Image (an EFI zboot is refused with a hint, exit code 2; LDR-4). M12 adds `--rng`; M14
//! `--disk F[,ro]` (repeatable; [`parse_disk`]). M21
//! adds `--machine virt|vmapple` and `--bios F`: `vmapple` exists only in a build with the
//! `experimental-vmapple` feature (otherwise exit code 2), defaults `--bios` to the system's
//! AVPBooter, and takes its SLA lock files in `$HOME/.cache/macvmm/vmapple-slots`: one directory
//! per user, whatever the working directory or `MACVMM_CACHE` (ADR-0008 decision 6). M13 adds
//! `--console stdio|file:F[,strict|,raw][,max=SIZE]`, a virtio-console with its own sink (same
//! grammar and rules as `--serial`, but no `none`); at most one of the two sinks may be
//! `stdio`, and that one gets stdin (architecture §14.4). M16 adds `--cpus N` (1..=64, and
//! at most `hv_vm_get_max_vcpu_count`, checked when the VM is built). M18 accepts `--bios F` on
//! the `virt` machine: firmware (U-Boot) in flash bank 0, alone (no `--kernel`, `--raw`,
//! `--initrd` or `--cmdline`; `VmConfig::validate`).
//! M22 adds `--sandbox[=best-effort]` and the hidden `--sandbox-selftest` (`sandbox.rs`; threat
//! model SBX-1..SBX-4): they are split off before [`parse_run`], and the lockdown is applied
//! after `HostIo::open` and the host threads, right before the first guest instruction.
//!
//! **M6: the terminal and the exit path.** Before the VM starts, `run` puts the terminal in raw
//! mode when stdin is a TTY and the serial sink is `stdio` (`term.rs`, PROC-1), starts the
//! signal thread (`signals.rs`) and, for an interactive sink, the stdin thread. After it stops,
//! the order is fixed by TTY-6 and SINK-1: drain the sinks (the stdio one writes the terminal
//! reset after the guest's last byte), restore termios and flush pending input, then print the
//! verdict (TTY-7: always, when the guest wrote to a terminal).

use crate::{err, signals, term};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::StdinBinding;
use vmm::config::{DebugHvc, IrqChip, MAX_TIMEOUT, MmioPolicy, ResetAction, TraceSpec, VmConfig};
use vmm::config::{DiskSpec, SinkKind, SinkSpec};
use vmm::trace::TraceCats;
use vmm::{HostIo, StopReason};

pub const RUN_USAGE: &str = "\
usage: macvmm run [options]

options:
  --mem SIZE               guest RAM, e.g. 64M, 2G (default 512M; 64M..255G, a multiple of 2M)
  --cpus N                 number of vCPUs, 1..64 and at most what this Mac allows (default 1);
                           vCPU 0 boots, the others wait for PSCI CPU_ON
  --kernel FILE            an ELF test guest or an arm64 Linux Image (detected from its
                           bytes; an EFI zboot vmlinuz is refused: run scripts/fetch.sh linux)
  --initrd FILE            an initramfs for an Image kernel, placed above the kernel
  --cmdline STRING         the kernel command line for an Image (at most 2047 bytes; default
                           console=ttyAMA0 earlycon=pl011,<the PL011 address>)
  --machine BOARD          virt (default) or vmapple (experimental: AVPBooter's first device
                           accesses, needs a build with --features experimental-vmapple;
                           it does not boot macOS; at most two per user, an advisory lock
                           in $HOME/.cache/macvmm/vmapple-slots)
  --bios FILE              a firmware ROM image, at most 64 MiB (virt: U-Boot in flash
                           bank 0, entered at 0x0 instead of --kernel; vmapple: default the
                           system AVPBooter, read in place and never copied)
  --dry-run                print the boot plan, memory map and device-tree summary, then exit
                           0 without creating a VM (needs no entitlement)
  --raw FILE@0xADDR        load FILE's bytes at guest-physical ADDR (repeatable); the first
                           one is the entry point when there is no --kernel
  --timeout SECS           stop the guest after SECS seconds (exit code 5)
  --unhandled-mmio POLICY  fatal (default: exit code 3) or log (read as zero, ignore writes)
  --trace exits:FILE[:CATS][,max=SIZE]
                           write one JSON line per VM exit to FILE (created 0600; never a
                           symlink). CATS: comma-separated mmio,hvc,sysreg,psci,cancel,all
                           (default all). SIZE caps the file (default 1G)
  --testdev                map the 512-register test device at 0x0b000000
  --disk FILE[,ro]         add a virtio-blk disk backed by the raw image FILE (repeatable;
                           the first is /dev/vda). ,ro opens it read-only. The image is
                           locked (flock) while macvmm runs; a locked image is refused
  --rng                    add a virtio-rng device fed by the host CSPRNG (getentropy)
  --net unixgram:LOCAL,peer=REMOTE[,mac=XX:XX:XX:XX:XX:XX]
                           add a virtio-net NIC whose wire is a Unix datagram socket bound
                           at LOCAL; frames go to, and are accepted only from, the socket at
                           REMOTE (another macvmm's LOCAL). Both must be in a directory you
                           own that is not group- or world-writable. A stale socket of yours
                           at LOCAL is replaced; anything else there is refused. Repeatable
                           (at most 4). Default MAC 02:6d:76 plus 3 random bytes.
                           unixgram:LOCAL,learn instead locks the peer to the first sender
                           (logged). No host network access and no entitlement
  --on-reset ACTION        reboot (default: rebuild the VM in-process) or exit (exit code 4)
                           when the guest calls PSCI SYSTEM_RESET
  --debug-hvc, --no-debug-hvc
                           force the macvmm debug hypercalls on or off (default: on for ELF
                           and --raw test guests, off for kernels and firmware)
  --dtb-out FILE           write the generated device tree to FILE (created 0600; never a
                           symlink), with its rng-seed and kaslr-seed zeroed
  --serial SINK[,strict|,raw][,max=SIZE]
                           where the PL011 console goes: stdio (default; also gets stdin, with
                           Ctrl-A x quit, Ctrl-A t trace ring, Ctrl-A s stats), file:FILE
                           (created 0600, never a symlink, capped at SIZE, default 1G) or none.
                           Guest output is filtered for terminal safety; strict shows every
                           control visibly, raw disables the filter (not recommended)
  --console SINK[,strict|,raw][,max=SIZE]
                           add a virtio-console (Linux /dev/hvc0) whose output goes to stdio
                           or file:FILE, filtered like --serial. At most one of --serial and
                           --console may be stdio, and that one gets stdin: --console stdio
                           needs --serial file:FILE or --serial none
  --stats                  print the console I/O counters, the exit counts, the vCPU exec and
                           WFI time and the host CPU time when the VM stops
  --log LEVEL              error|warn|info|debug|trace (default warn; also MACVMM_LOG)
  --sandbox[=best-effort]  after opening every file, confine macvmm: no file opened by path, no
                           network, no new process (macOS sandbox, threat model SBX-2). Exits 1
                           if the sandbox cannot be applied; best-effort warns and runs anyway.
                           Not with --net ...,learn
";

/// Parse a size with an optional binary suffix: `K`, `M`, `G` (case-insensitive; `KiB`,
/// `MiB`, `GiB` and `KB`/`MB`/`GB` mean the same). Overflow is an error (PATH-8).
pub fn parse_size(s: &str) -> Result<u64, String> {
    let lower = s.to_ascii_lowercase();
    let digits_end = lower
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(lower.len());
    let (digits, suffix) = lower.split_at(digits_end);
    let shift = match suffix {
        "" | "b" => 0,
        "k" | "kb" | "kib" => 10,
        "m" | "mb" | "mib" => 20,
        "g" | "gb" | "gib" => 30,
        _ => return Err(format!("invalid size {s:?}: use a number with K, M or G")),
    };
    if digits.is_empty() {
        return Err(format!("invalid size {s:?}: no digits"));
    }
    let n: u64 = digits
        .parse()
        .map_err(|_| format!("invalid size {s:?}: too large"))?;
    n.checked_mul(1u64 << shift)
        .ok_or(format!("invalid size {s:?}: too large"))
}

/// Parse `--timeout SECS`.
fn parse_timeout(s: &str) -> Result<Duration, String> {
    let secs: u64 = s
        .parse()
        .map_err(|_| format!("invalid --timeout {s:?}: a whole number of seconds"))?;
    let t = Duration::from_secs(secs);
    if secs == 0 || t > MAX_TIMEOUT {
        return Err(format!(
            "invalid --timeout {s:?}: 1..={} seconds",
            MAX_TIMEOUT.as_secs()
        ));
    }
    Ok(t)
}

/// Parse `--trace exits:F[:cats][,max=SIZE]` (architecture §13.1, LOG-3). The `,max=` suffix
/// is split off first, then a final `:cats` if every name in it is a known category, so a
/// path may itself contain `:` or `,` as long as it does not end like a category list.
pub fn parse_trace(s: &str) -> Result<TraceSpec, String> {
    let rest = s.strip_prefix("exits:").ok_or(format!(
        "invalid --trace {s:?}: use exits:FILE[:CATS][,max=SIZE]"
    ))?;
    let (rest, max) = match rest.rsplit_once(",max=") {
        Some((r, m)) => {
            let n = parse_size(m).map_err(|e| format!("--trace max: {e}"))?;
            if n == 0 {
                return Err("--trace max must be at least 1 byte".into());
            }
            (r, Some(n))
        }
        None => (rest, None),
    };
    let (path, cats) = match rest.rsplit_once(':') {
        Some((p, c)) => match TraceCats::parse(c) {
            Some(cats) => (p, Some(cats)),
            None => (rest, None),
        },
        None => (rest, None),
    };
    if path.is_empty() {
        return Err(format!("invalid --trace {s:?}: no file name"));
    }
    let mut spec = TraceSpec::new(PathBuf::from(path));
    if let Some(c) = cats {
        spec.cats = c;
    }
    if let Some(m) = max {
        spec.max_bytes = m;
    }
    Ok(spec)
}

/// Parse the arguments after `run` into a validated `VmConfig`.
pub fn parse_run(args: &[String]) -> Result<VmConfig, String> {
    let mut cfg = VmConfig::default();
    let mut serial_seen = false;
    let mut console_seen = false;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_owned())),
            _ => (arg.as_str(), None),
        };
        let mut value = || -> Result<String, String> {
            match &inline {
                Some(v) => Ok(v.clone()),
                None => it.next().cloned().ok_or(format!("{flag} needs a value")),
            }
        };
        match flag {
            "--mem" => cfg.mem_bytes = parse_size(&value()?).map_err(|e| format!("--mem: {e}"))?,
            // M16 (architecture §8.1): the range (1..=MAX_CPUS) is `VmConfig::validate`'s; the
            // host's own limit (`hv_vm_get_max_vcpu_count`) is checked in `Machine::build`.
            "--cpus" => cfg.cpus = parse_cpus(&value()?)?,
            "--kernel" => {
                if cfg.boot.kernel.is_some() {
                    return Err("--kernel given twice".into());
                }
                cfg.boot.kernel = Some(PathBuf::from(value()?));
            }
            // M9: Linux inputs (HostIo reads them; the plan checks them against the kernel).
            "--initrd" => {
                if cfg.boot.initrd.is_some() {
                    return Err("--initrd given twice".into());
                }
                let path = value()?;
                if path.is_empty() {
                    return Err("--initrd needs a file name".into());
                }
                cfg.boot.initrd = Some(PathBuf::from(path));
            }
            "--cmdline" => {
                if cfg.boot.cmdline.is_some() {
                    return Err("--cmdline given twice".into());
                }
                cfg.boot.cmdline = Some(value()?);
            }
            "--dry-run" => {
                if inline.is_some() {
                    return Err("--dry-run takes no value".into());
                }
                cfg.dry_run = true;
            }
            "--raw" => cfg
                .boot
                .raw
                .push(vmm::loader::raw::parse_spec(&value()?).map_err(|e| e.to_string())?),
            "--timeout" => cfg.timeout = Some(parse_timeout(&value()?)?),
            "--unhandled-mmio" => {
                cfg.unhandled_mmio = match value()?.as_str() {
                    "fatal" => MmioPolicy::Fatal,
                    "log" => MmioPolicy::Log,
                    other => return Err(format!("invalid --unhandled-mmio {other:?}: fatal|log")),
                }
            }
            "--trace" => {
                if cfg.trace.is_some() {
                    return Err("--trace given twice".into());
                }
                cfg.trace = Some(parse_trace(&value()?)?);
            }
            "--testdev" => {
                if inline.is_some() {
                    return Err("--testdev takes no value".into());
                }
                cfg.testdev = true;
            }
            // M21: the board, and a firmware ROM image (read by HostIo, LDR-1).
            "--machine" => {
                cfg.machine = parse_machine(&value()?)?;
            }
            "--bios" => {
                if cfg.boot.bios.is_some() {
                    return Err("--bios given twice".into());
                }
                let path = value()?;
                if path.is_empty() {
                    return Err("--bios needs a file name".into());
                }
                cfg.boot.bios = Some(PathBuf::from(path));
            }
            // M12: virtio-rng, in the slot after the disks (ADR-0005).
            // M14: virtio-blk, one per flag, in CLI order (ADR-0005: before every other device).
            "--disk" => cfg.disks.push(parse_disk(&value()?)?),
            // M24: virtio-net, one per flag, after the console (ADR-0005).
            "--net" => cfg.net.push(parse_net(&value()?)?),
            "--rng" => {
                if inline.is_some() {
                    return Err("--rng takes no value".into());
                }
                cfg.rng = true;
            }
            // M5: what SYSTEM_RESET does, and the HC-2 override of the debug-call default.
            "--on-reset" => {
                cfg.on_reset = match value()?.as_str() {
                    "reboot" => ResetAction::Reboot,
                    "exit" => ResetAction::Exit,
                    other => return Err(format!("invalid --on-reset {other:?}: reboot|exit")),
                }
            }
            "--debug-hvc" | "--no-debug-hvc" => {
                if inline.is_some() {
                    return Err(format!("{flag} takes no value"));
                }
                let want = if flag == "--debug-hvc" {
                    DebugHvc::On
                } else {
                    DebugHvc::Off
                };
                if cfg.debug_hvc != DebugHvc::Auto && cfg.debug_hvc != want {
                    return Err("--debug-hvc and --no-debug-hvc are exclusive".into());
                }
                cfg.debug_hvc = want;
            }
            // M7: an output (PATH-3..6, opened by HostIo). There is deliberately no flag that
            // sets the DTB seeds (FDT-3).
            "--dtb-out" => {
                if cfg.dtb_out.is_some() {
                    return Err("--dtb-out given twice".into());
                }
                let path = value()?;
                if path.is_empty() {
                    return Err("--dtb-out needs a file name".into());
                }
                cfg.dtb_out = Some(PathBuf::from(path));
            }
            // M6: the PL011 sink (TTY-2, LOG-4, PATH-3..6).
            "--serial" => {
                if serial_seen {
                    return Err("--serial given twice".into());
                }
                serial_seen = true;
                cfg.serial = parse_serial(&value()?)?;
            }
            // M13: the virtio-console sink (TTY-1/2, LOG-4, PATH-3..6), in the slot after --rng.
            "--console" => {
                if console_seen {
                    return Err("--console given twice".into());
                }
                console_seen = true;
                let spec = parse_sink("--console", &value()?)?;
                if spec.kind == SinkKind::None {
                    return Err(
                        "invalid --console: use stdio or file:FILE (leave it out for no console)"
                            .into(),
                    );
                }
                cfg.console = Some(spec);
            }
            "--stats" => {
                if inline.is_some() {
                    return Err("--stats takes no value".into());
                }
                cfg.stats = true;
            }
            // M8: hidden (architecture §13.1). `kernel` is accepted for symmetry, never needed.
            "--irqchip" => {
                cfg.irqchip = match value()?.as_str() {
                    "none" => IrqChip::None,
                    "gicv3" | "kernel" => IrqChip::InKernelGicV3,
                    v => return Err(format!("invalid --irqchip {v:?}: use none")),
                };
            }
            other => return Err(format!("run: unknown flag {other:?}")),
        }
    }
    vmapple_defaults(&mut cfg);
    cfg.validate().map_err(|e| e.to_string())?;
    Ok(cfg)
}

/// Parse the `--cpus` count: decimal digits only (no sign, no `0x`), so `--cpus -1` or
/// `--cpus 4k` is a usage error rather than a surprise.
fn parse_cpus(s: &str) -> Result<u32, String> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "invalid --cpus {s:?}: use a number from 1 to {}",
            vmm::arch::layout::MAX_CPUS
        ));
    }
    s.parse::<u32>().map_err(|_| {
        format!(
            "invalid --cpus {s:?}: use a number from 1 to {}",
            vmm::arch::layout::MAX_CPUS
        )
    })
}

/// Parse `--machine` (M21). `vmapple` needs the `experimental-vmapple` build (ADR-0008).
fn parse_machine(s: &str) -> Result<vmm::arch::layout::MachineProfile, String> {
    use vmm::arch::layout::MachineProfile;
    match s {
        "virt" => Ok(MachineProfile::Virt),
        #[cfg(feature = "experimental-vmapple")]
        "vmapple" => Ok(MachineProfile::VmApple),
        #[cfg(not(feature = "experimental-vmapple"))]
        "vmapple" => Err(
            "--machine vmapple: built without experimental-vmapple (rebuild with \
             `--features experimental-vmapple`; PLAN M21)"
                .into(),
        ),
        other => Err(format!("invalid --machine {other:?}: virt|vmapple")),
    }
}

/// M21: on `--machine vmapple`, default `--bios` to the system AVPBooter (read in place, never
/// copied: ADR-0008 decision 3) and name the SLA lock directory (ADR-0008 decision 6).
fn vmapple_defaults(cfg: &mut VmConfig) {
    if cfg.machine == vmm::arch::layout::MachineProfile::Virt {
        return;
    }
    if cfg.boot.bios.is_none() {
        cfg.boot.bios = Some(PathBuf::from(vmm::loader::firmware::AVPBOOTER_VMAPPLE2));
    }
    cfg.vmapple_slots = vmapple_slot_dir(std::env::var_os("HOME"));
}

/// The SLA lock directory for the user whose `HOME` is `home`: `$HOME/.cache/macvmm/vmapple-slots`.
///
/// **Why `HOME`, and not `MACVMM_CACHE` or the working directory.** The licence counts macOS VMs
/// per Mac; a lock directory that moved with the current directory or the download cache would
/// count them per directory, and two shells in two checkouts could start four. One fixed
/// directory per user is the most a `0700` lock can do: it cannot see another user's VMs, and
/// HVF, unlike VZ, enforces no limit of its own. So the guard is advisory and per user (it
/// stops accidents, not someone who sets `HOME` elsewhere). `None` (no absolute `HOME`) makes
/// `--machine vmapple` refuse to start (`machine::vmapple::validate`).
fn vmapple_slot_dir(home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let home = PathBuf::from(home.filter(|h| !h.is_empty())?);
    home.is_absolute()
        .then(|| home.join(".cache/macvmm/vmapple-slots"))
}

// ANCHOR: cli_parse_disk
/// `--disk FILE[,ro]` (M14). The only option is a trailing `,ro`; anything else after the last
/// comma is part of the file name, so a path containing a comma still works
/// (`--disk 'a,b.img'`), and `--disk 'a,b.img,ro'` is `a,b.img` read-only.
pub fn parse_disk(s: &str) -> Result<DiskSpec, String> {
    let (path, read_only) = match s.strip_suffix(",ro") {
        Some(p) => (p, true),
        None => (s, false),
    };
    if path.is_empty() {
        return Err("--disk needs a file name".into());
    }
    Ok(DiskSpec {
        path: PathBuf::from(path),
        read_only,
    })
}
// ANCHOR_END: cli_parse_disk

// ANCHOR: cli_parse_net
/// Parse `--net unixgram:LOCAL,peer=REMOTE[,mac=XX:..]` or `unixgram:LOCAL,learn[,mac=..]`
/// (M24, architecture §13.1). `peer=` is required unless `,learn` is given, and not both
/// (threat model NET-2: no silent first-sender learning). Paths cannot contain `,`.
pub fn parse_net(s: &str) -> Result<vmm::config::NetSpec, String> {
    use vmm::config::{NetPeer, NetSpec};
    let rest = s.strip_prefix("unixgram:").ok_or_else(|| {
        format!("invalid --net {s:?}: the only backend is unixgram:LOCAL,peer=REMOTE")
    })?;
    let mut parts = rest.split(',');
    let local = parts.next().unwrap_or_default();
    if local.is_empty() {
        return Err("--net unixgram needs a socket path: unixgram:LOCAL,peer=REMOTE".into());
    }
    let (mut peer, mut learn, mut mac) = (None, false, None);
    for opt in parts {
        if let Some(p) = opt.strip_prefix("peer=") {
            if p.is_empty() || peer.is_some() {
                return Err(format!("invalid --net {s:?}: one non-empty peer=PATH"));
            }
            peer = Some(PathBuf::from(p));
        } else if let Some(m) = opt.strip_prefix("mac=") {
            if mac.is_some() {
                return Err(format!("invalid --net {s:?}: mac= given twice"));
            }
            mac = Some(vmm::net::parse_mac(m).map_err(|e| format!("--net: {e}"))?);
        } else if opt == "learn" {
            learn = true;
        } else {
            return Err(format!(
                "invalid --net option {opt:?}: use peer=PATH, learn or mac=XX:XX:XX:XX:XX:XX"
            ));
        }
    }
    let peer = match (peer, learn) {
        (Some(p), false) => NetPeer::Path(p),
        (None, true) => NetPeer::Learn,
        (Some(_), true) => {
            return Err("--net unixgram: give peer=PATH or ,learn, not both".into());
        }
        (None, false) => return Err("--net unixgram needs peer=PATH (or ,learn)".into()),
    };
    Ok(NetSpec {
        local: PathBuf::from(local),
        peer,
        mac,
    })
}
// ANCHOR_END: cli_parse_net

/// Parse `--serial stdio|file:F|none[,strict|,raw|,safe][,max=SIZE]` (architecture §13.1).
/// Options are split off the end, so a file name may contain `,` as long as it does not end
/// like an option. `max=` applies to file sinks only (LOG-4: stdout has no cap).
pub fn parse_serial(s: &str) -> Result<SinkSpec, String> {
    parse_sink("--serial", s)
}

/// The sink grammar shared by `--serial` and `--console` (M13); `flag` names the option in
/// error messages.
fn parse_sink(flag: &str, s: &str) -> Result<SinkSpec, String> {
    let mut spec = SinkSpec::default();
    let mut policy: Option<FilterPolicy> = None;
    let mut max: Option<u64> = None;
    let mut rest = s;
    while let Some((head, opt)) = rest.rsplit_once(',') {
        let p = match opt {
            "safe" => Some(FilterPolicy::Safe),
            "strict" => Some(FilterPolicy::Strict),
            "raw" => Some(FilterPolicy::Raw),
            _ => None,
        };
        if let Some(p) = p {
            if policy.replace(p).is_some() {
                return Err(format!("invalid {flag} {s:?}: more than one filter policy"));
            }
        } else if let Some(m) = opt.strip_prefix("max=") {
            let n = parse_size(m).map_err(|e| format!("{flag} max: {e}"))?;
            if n == 0 {
                return Err(format!("{flag} max must be at least 1 byte"));
            }
            if max.replace(n).is_some() {
                return Err(format!("invalid {flag} {s:?}: max given twice"));
            }
        } else {
            break;
        }
        rest = head;
    }
    match rest {
        "stdio" => spec.kind = SinkKind::Stdio,
        "none" => spec.kind = SinkKind::None,
        _ => match rest.strip_prefix("file:") {
            Some(path) if !path.is_empty() => {
                spec.kind = SinkKind::File;
                spec.path = Some(PathBuf::from(path));
            }
            _ => {
                return Err(format!(
                    "invalid {flag} {s:?}: use stdio, file:FILE or none, then optionally \
                     ,strict or ,raw and ,max=SIZE"
                ));
            }
        },
    }
    if let Some(m) = max {
        if spec.kind != SinkKind::File {
            return Err(format!(
                "invalid {flag} {s:?}: max= applies to file sinks only"
            ));
        }
        spec.max_bytes = m;
    }
    if let Some(p) = policy {
        spec.policy = p;
    }
    Ok(spec)
}

/// Print the VMM's verdict on stderr (only the VMM prints these lines: AS10). `always`: also
/// for a clean exit, because the guest wrote to a terminal (TTY-7).
fn report(reason: &StopReason, cfg: &VmConfig, always: bool) {
    match reason {
        StopReason::PowerOff | StopReason::DebugExit(0) => {
            if always {
                err(&format!("macvmm: {reason}"));
            }
        }
        StopReason::DebugExit(code) => err(&format!("macvmm: guest exit code {code}")),
        StopReason::GuestFatal(g) => {
            err(&format!("macvmm: guest fatal: {}", g.reason));
            // Empty for a machine-level verdict (the reset storm): no vCPU state to show.
            let report = g.report();
            if !report.trim_end().is_empty() {
                err(report.trim_end());
            }
        }
        StopReason::Timeout => err(&format!(
            "macvmm: timeout: the guest was still running after --timeout {}s",
            cfg.timeout.map_or(0, |t| t.as_secs())
        )),
        StopReason::Reset => err("macvmm: guest requested a reset (exit code 4)"),
        StopReason::UserQuit => err("macvmm: user quit"),
        StopReason::Vmm(e) => err(&format!("macvmm: error: {e}")),
    }
}

fn exit(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// M22 (SBX-3, SBX-4): apply `--sandbox[=best-effort]` and the optional self-test. `Err` is
/// the line to print before exiting 1 (enforce mode could not lock down, or the self-test
/// failed); best-effort warns and carries on unconfined. Called once every host file is open.
fn confine(sandbox: crate::sandbox::Opts, cfg: &VmConfig) -> Result<(), String> {
    use crate::sandbox::Mode;
    if sandbox.mode == Mode::Off {
        return Ok(());
    }
    match crate::sandbox::lockdown(cfg) {
        Ok(_) => {}
        Err(e) if sandbox.mode == Mode::BestEffort => err(&format!(
            "macvmm: warning: --sandbox=best-effort: {e}; running WITHOUT the sandbox"
        )),
        Err(e) => return Err(format!("macvmm: --sandbox: {e}")),
    }
    if sandbox.selftest {
        let line = crate::sandbox::selftest().map_err(|line| format!("macvmm: {line}"))?;
        err(&format!("macvmm: {line}"));
    }
    Ok(())
}

/// `macvmm run …`.
pub fn run(args: &[String]) -> ExitCode {
    // M22: the sandbox flags are not part of the VM's configuration.
    let (sandbox, args) = match crate::sandbox::split_flags(args) {
        Ok(v) => v,
        Err(msg) => {
            err(&format!("macvmm: {msg}"));
            err(RUN_USAGE.trim_end());
            return ExitCode::from(2);
        }
    };
    let args = args.as_slice();
    let cfg = match parse_run(args) {
        Ok(cfg) => cfg,
        Err(msg) => {
            err(&format!("macvmm: {msg}"));
            err(RUN_USAGE.trim_end());
            return ExitCode::from(2);
        }
    };
    // HOSTIO-1: every input is opened and read here, once, before any HVF call.
    let host = match HostIo::open(&cfg) {
        Ok(h) => Arc::new(h),
        Err(e) => {
            err(&format!("macvmm: {e}"));
            return exit(e.exit_code());
        }
    };
    // M9: `--dry-run` describes the boot and exits; no terminal setup, no HVF call. It still
    // parses the untrusted kernel and initrd headers, so a `--sandbox` applies here too (SBX-4:
    // a sandbox flag never silently does nothing).
    if cfg.dry_run {
        if let Err(line) = confine(sandbox, &cfg) {
            host.close_sinks(&[]);
            err(&line);
            return ExitCode::from(1);
        }
        let result = vmm::machine::dry_run(&cfg, &host);
        host.close_sinks(&[]);
        return match result {
            Ok(report) => {
                crate::out(report.trim_end());
                ExitCode::SUCCESS
            }
            Err(e) => {
                err(&format!("macvmm: {e}"));
                exit(e.exit_code())
            }
        };
    }
    if cfg.serial.policy == FilterPolicy::Raw {
        // TTY-2: the opt-out of the terminal filter is never silent.
        err(
            "macvmm: warning: --serial ...,raw: guest output reaches the destination \
             unfiltered; escape sequences in it can query or reprogram your terminal",
        );
    }
    if cfg
        .console
        .as_ref()
        .is_some_and(|c| c.policy == FilterPolicy::Raw)
    {
        // TTY-2 for the M13 console sink.
        err(
            "macvmm: warning: --console ...,raw: guest output reaches the destination \
             unfiltered; escape sequences in it can query or reprogram your terminal",
        );
    }
    // PROC-1: raw mode only for an interactive TTY; stdin goes only to the stdio sink (the
    // serial or, M13, the console one: `HostIo::stdin`).
    let interactive = host.stdin != StdinBinding::Unbound;
    let mut terminal = term::Terminal::setup(interactive);
    if terminal.is_raw() {
        err("macvmm: console attached; Ctrl-A x quits, Ctrl-A h lists the escapes");
    }
    if let Err(e) = signals::spawn(Arc::clone(&host)) {
        err(&format!("macvmm: cannot install the signal handlers: {e}"));
        return ExitCode::from(1);
    }
    if interactive && let Err(e) = term::spawn_stdin(Arc::clone(&host)) {
        err(&format!("macvmm: cannot start the stdin thread: {e}"));
        return ExitCode::from(1);
    }
    // M22 (SBX-3): every host file is open and every host thread exists; lock down before the
    // first guest instruction. vCPU creation and any reboot run under the sandbox.
    if let Err(line) = confine(sandbox, &cfg) {
        // SBX-4: fail closed. Nothing ran yet; undo the terminal and stop.
        host.close_sinks(&[]);
        terminal.restore();
        err(&line);
        return ExitCode::from(1);
    }
    let result = vmm::run(&cfg, &host);
    finish(&cfg, &host, &mut terminal, result)
}

// ANCHOR: exit_hygiene
/// The exit path (module docs; TTY-6, TTY-7, SINK-1): drain the sinks and write the terminal
/// reset after the guest's last byte, restore termios and flush pending input, then print the
/// verdict and the stats.
fn finish(
    cfg: &VmConfig,
    host: &HostIo,
    terminal: &mut term::Terminal,
    result: vmm::Result<StopReason>,
) -> ExitCode {
    // M13: the stdio sink is the serial or the console one (never both).
    let stdio = host.stdio_sink();
    let tty = terminal.stdout_is_tty() && stdio.is_some();
    host.close_sinks(if tty { term::RESET_SEQUENCE } else { &[] });
    if tty && !stdio.is_some_and(|s| s.epilogue_written()) {
        // The sink was off after a write error, or its writer was stuck: TTY-6 still holds.
        term::write_reset_fallback();
    }
    terminal.restore();
    let (wrote, at_line_start) = stdio.map_or((false, true), |s| s.output_state());
    let guest_drew = tty && wrote;
    if guest_drew && !at_line_start {
        err("");
    }
    let code = match result {
        Ok(reason) => {
            report(&reason, cfg, guest_drew);
            reason.exit_code()
        }
        Err(e) => {
            err(&format!("macvmm: {e}"));
            if let vmm::Error::Hv { err: call, .. } = &e
                && call.error == hvf::HvError::Denied
            {
                // HV_DENIED means the signature lacks com.apple.security.hypervisor: the binary
                // was never signed, or a later `cargo build` relinked it (the linker's own
                // signature carries no entitlements).
                err("hint: HV_DENIED: this binary is not signed with the");
                err(
                    "      com.apple.security.hypervisor entitlement (never signed, or relinked by",
                );
                err(
                    "      a later cargo build). Run it through scripts/sign-and-run.sh (`cargo run",
                );
                err("      -p macvmm -- run ...` does this) or sign it with scripts/sign.sh.");
            }
            e.exit_code()
        }
    };
    if cfg.stats {
        err(&format!("macvmm: stats: {}", host.io_stats()));
        // ANCHOR: cli_stats_report
        for line in host.hostctl.stats() {
            err(&format!("macvmm: stats: {line}"));
        }
        // ANCHOR_END: cli_stats_report
        err(&crate::sandbox::rlimit_stats()); // M22 (PROC-4)
    }
    exit(code)
}
// ANCHOR_END: exit_hygiene

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    fn base() -> Vec<&'static str> {
        vec!["--raw", "g.bin@0x40080000"]
    }

    fn with(extra: &[&'static str]) -> Result<VmConfig, String> {
        let mut a = base();
        a.extend_from_slice(extra);
        parse_run(&v(&a))
    }

    /// M24: `--net` grammar. `peer=` is required unless `,learn` (NET-2); at most four NICs;
    /// MACs are validated; a NIC is never its own peer.
    #[test]
    fn net_flags() {
        use vmm::config::NetPeer;
        let c = with(&[
            "--net",
            "unixgram:/t/a.sock,peer=/t/b.sock,mac=02:6d:76:00:00:01",
        ])
        .unwrap();
        let n = &c.net[0];
        assert_eq!(n.local, PathBuf::from("/t/a.sock"));
        assert_eq!(n.peer, NetPeer::Path(PathBuf::from("/t/b.sock")));
        assert_eq!(n.mac, Some([2, 0x6d, 0x76, 0, 0, 1]));
        let l = with(&["--net=unixgram:a.sock,learn"]).unwrap();
        assert_eq!(
            (l.net[0].peer.clone(), l.net[0].mac),
            (NetPeer::Learn, None)
        );
        let e = with(&["--net", "unixgram:/t/a.sock"]).unwrap_err();
        assert!(e.contains("needs peer="), "{e}");
        for bad in [
            "tap:/t/a",
            "unixgram:",
            "unixgram:,peer=/t/b",
            "unixgram:/t/a,peer=",
            "unixgram:/t/a,peer=/t/b,learn",
            "unixgram:/t/a,peer=/t/b,peer=/t/c",
            "unixgram:/t/a,peer=/t/b,mac=01:00:5e:00:00:01",
            "unixgram:/t/a,peer=/t/b,mac=02:6d",
            "unixgram:/t/a,peer=/t/b,frob",
            "unixgram:/t/a,peer=/t/a",
        ] {
            assert!(with(&["--net", bad]).is_err(), "{bad}");
        }
        let twice = with(&[
            "--net",
            "unixgram:/t/a,peer=/t/b",
            "--net",
            "unixgram:/t/a,peer=/t/c",
        ]);
        assert!(twice.unwrap_err().contains("twice"));
        let four = [
            "--net",
            "unixgram:/t/1,peer=/t/p",
            "--net",
            "unixgram:/t/2,peer=/t/p",
            "--net",
            "unixgram:/t/3,peer=/t/p",
            "--net",
            "unixgram:/t/4,peer=/t/p",
        ];
        assert_eq!(with(&four).unwrap().net.len(), 4);
        let mut five = four.to_vec();
        five.extend_from_slice(&["--net", "unixgram:/t/5,peer=/t/p"]);
        assert!(with(&five).unwrap_err().contains("at most 4"));
    }

    /// M21: `--machine` and `--bios`. Without the feature, vmapple is a usage error naming it.
    #[test]
    fn machine_and_bios() {
        use vmm::arch::layout::MachineProfile;
        assert_eq!(
            with(&["--machine", "virt"]).unwrap().machine,
            MachineProfile::Virt
        );
        assert!(
            with(&["--machine", "pc"])
                .unwrap_err()
                .contains("virt|vmapple")
        );
        // M18: `--bios` alone on the virt machine is a firmware boot; with an OS input it is
        // a usage error naming the flag.
        let fw = parse_run(&v(&["--bios", "u-boot.bin"])).unwrap();
        assert_eq!(fw.machine, MachineProfile::Virt);
        assert_eq!(
            fw.boot.bios.as_deref(),
            Some(std::path::Path::new("u-boot.bin"))
        );
        let e = with(&["--bios", "u-boot.bin"]).unwrap_err();
        assert!(e.contains("cannot be combined with --bios"), "{e}");
        for extra in [
            &["--raw", "a.bin@0x40080000"][..],
            &["--initrd", "rd"][..],
            &["--cmdline", "x"][..],
        ] {
            let mut a = vec!["--bios", "u-boot.bin"];
            a.extend_from_slice(extra);
            assert!(parse_run(&v(&a)).is_err(), "{a:?}");
        }
        assert!(parse_run(&v(&["--bios", "u-boot.bin", "--disk", "d.img"])).is_ok());
        let vmapple = parse_run(&v(&["--machine", "vmapple"]));
        #[cfg(not(feature = "experimental-vmapple"))]
        assert!(
            vmapple
                .unwrap_err()
                .contains("built without experimental-vmapple")
        );
        #[cfg(feature = "experimental-vmapple")]
        {
            let c = vmapple.unwrap();
            assert_eq!(c.machine, MachineProfile::VmApple);
            assert_eq!(
                c.boot.bios.as_deref(),
                Some(std::path::Path::new(
                    vmm::loader::firmware::AVPBOOTER_VMAPPLE2
                ))
            );
            assert!(
                c.vmapple_slots
                    .unwrap()
                    .ends_with(".cache/macvmm/vmapple-slots")
            );
            let own = parse_run(&v(&["--machine=vmapple", "--bios", "x.bin"])).unwrap();
            assert_eq!(
                own.boot.bios.as_deref(),
                Some(std::path::Path::new("x.bin"))
            );
            assert!(parse_run(&v(&["--machine", "vmapple", "--kernel", "k"])).is_err());
        }
    }

    #[test]
    fn unknown_flag_fails() {
        let e = with(&["--frobnicate"]).unwrap_err();
        assert!(e.contains("unknown flag"), "{e}");
        assert!(with(&["extra"]).is_err());
        assert!(with(&["--mem"]).unwrap_err().contains("needs a value"));
    }

    #[test]
    fn mem_sizes() {
        assert!(with(&["--mem", "63M"]).is_err());
        assert!(with(&["--mem", "1000K"]).is_err());
        assert_eq!(with(&["--mem", "1G"]).unwrap().mem_bytes, 1 << 30);
        assert_eq!(with(&["--mem=64M"]).unwrap().mem_bytes, 64 << 20);
        let e = with(&["--mem", "99999999999G"]).unwrap_err();
        assert!(e.contains("too large"), "{e}");
        assert!(with(&["--mem", "256G"]).is_err()); // above 255 GiB
        assert!(with(&["--mem", "65M"]).is_err()); // not a multiple of 2 MiB
        assert!(with(&["--mem", "G"]).is_err());
        assert!(with(&["--mem", "-1G"]).is_err());
        assert_eq!(parse_size("2gib"), Ok(2 << 30));
        assert_eq!(parse_size("18446744073709551615"), Ok(u64::MAX));
        assert!(parse_size("18446744073709551616").is_err());
        assert!(parse_size("17179869184G").is_err()); // 2^34 GiB = 2^64 bytes
    }

    #[test]
    fn raw_addresses() {
        let bad = |s: &str| parse_run(&v(&["--raw", s])).is_err();
        assert!(bad("f@40080000"), "needs 0x");
        assert!(bad("f@0xffffffffffffffffff"), "more than 64 bits");
        assert!(bad("f"));
        let c = parse_run(&v(&["--raw", "a@0x40080000", "--raw=b@0x41000000"])).unwrap();
        assert_eq!(c.boot.raw.len(), 2);
        assert_eq!(c.boot.raw[1].addr, 0x4100_0000);
    }

    #[test]
    fn other_flags() {
        let c = with(&[
            "--timeout",
            "10",
            "--unhandled-mmio",
            "log",
            "--kernel",
            "k",
        ])
        .unwrap();
        assert_eq!(c.timeout, Some(Duration::from_secs(10)));
        assert_eq!(c.unhandled_mmio, MmioPolicy::Log);
        assert_eq!(c.boot.kernel, Some(PathBuf::from("k")));
        assert!(with(&["--timeout", "0"]).is_err());
        assert!(with(&["--timeout", "1.5"]).is_err());
        assert!(with(&["--timeout", "99999999999999999999"]).is_err());
        assert!(with(&["--unhandled-mmio", "ignore"]).is_err());
        assert!(with(&["--kernel", "a", "--kernel", "b"]).is_err());
        assert!(parse_run(&[]).unwrap_err().contains("nothing to boot"));
        assert!(with(&["--testdev"]).unwrap().testdev);
        assert!(!with(&[]).unwrap().testdev);
        assert!(with(&["--testdev=1"]).is_err());
        // M14: --disk accumulates in order; `,ro` is the only option.
        let c = with(&["--disk", "a.img", "--disk=b,c.img,ro"]).unwrap();
        assert_eq!(
            c.disks,
            vec![
                DiskSpec {
                    path: "a.img".into(),
                    read_only: false
                },
                DiskSpec {
                    path: "b,c.img".into(),
                    read_only: true
                },
            ]
        );
        assert!(with(&["--disk", ",ro"]).is_err());
        assert!(with(&["--disk", ""]).is_err());
        assert!(with(&["--disk"]).unwrap_err().contains("needs a value"));
        let many: Vec<&str> = std::iter::repeat_n(["--disk", "d.img"], 17)
            .flatten()
            .collect();
        assert!(with(&many).is_err(), "more than MAX_DISKS disks");
        // M12: --rng is a switch.
        assert!(with(&["--rng"]).unwrap().rng);
        assert!(!with(&[]).unwrap().rng);
        assert!(with(&["--rng=1"]).is_err());
    }

    #[test]
    fn trace_specs() {
        let t = parse_trace("exits:/tmp/t.jsonl").unwrap();
        assert_eq!(t.path, PathBuf::from("/tmp/t.jsonl"));
        assert_eq!((t.cats, t.max_bytes), (TraceCats::ALL, 1 << 30));
        let t = parse_trace("exits:t.jsonl:mmio").unwrap();
        assert_eq!(
            (t.path.to_str(), t.cats),
            (Some("t.jsonl"), TraceCats::MMIO)
        );
        let t = parse_trace("exits:t.jsonl:mmio,hvc,max=4K").unwrap();
        assert_eq!(t.cats, TraceCats::MMIO.union(TraceCats::HVC));
        assert_eq!(t.max_bytes, 4096);
        let t = parse_trace("exits:a:b.jsonl,max=1").unwrap();
        assert_eq!(
            (t.path.to_str(), t.cats, t.max_bytes),
            (Some("a:b.jsonl"), TraceCats::ALL, 1)
        );
        let t = parse_trace("exits:dir/x:notacat").unwrap();
        assert_eq!(t.path.to_str(), Some("dir/x:notacat"));
        for bad in [
            "t.jsonl",
            "exits:",
            "exits::mmio",
            "exits:t,max=0",
            "exits:t,max=lots",
            "exits:t,max=99999999999G",
        ] {
            assert!(parse_trace(bad).is_err(), "{bad:?}");
        }
        let c = with(&["--trace", "exits:t.jsonl:hvc"]).unwrap();
        assert_eq!(c.trace.unwrap().cats, TraceCats::HVC);
        assert!(with(&["--trace=exits:a", "--trace", "exits:b"]).is_err());
    }

    /// M7: `--dtb-out F` (FDT-4), and no flag can set the DTB seeds (FDT-3).
    #[test]
    fn dtb_out_and_no_seed_flags() {
        let c = with(&["--dtb-out", "v.dtb"]).unwrap();
        assert_eq!(c.dtb_out, Some(PathBuf::from("v.dtb")));
        assert_eq!(with(&[]).unwrap().dtb_out, None);
        assert!(with(&["--dtb-out=a", "--dtb-out", "b"]).is_err());
        assert!(with(&["--dtb-out="]).is_err());
        assert!(with(&["--dtb-out"]).unwrap_err().contains("needs a value"));
        for flag in ["--rng-seed", "--kaslr-seed", "--seed", "--dtb-seed"] {
            let e = with(&[flag, "0"]).unwrap_err();
            assert!(e.contains("unknown flag"), "{flag}: {e}");
        }
        assert!(RUN_USAGE.contains("--dtb-out FILE"));
        assert!(!RUN_USAGE.contains("seed="));
    }

    #[test]
    fn reset_and_debug_hvc_flags() {
        assert_eq!(with(&[]).unwrap().on_reset, ResetAction::Reboot);
        assert_eq!(
            with(&["--on-reset", "exit"]).unwrap().on_reset,
            ResetAction::Exit
        );
        assert_eq!(
            with(&["--on-reset=reboot"]).unwrap().on_reset,
            ResetAction::Reboot
        );
        assert!(with(&["--on-reset", "halt"]).is_err());
        assert_eq!(with(&[]).unwrap().debug_hvc, DebugHvc::Auto);
        assert_eq!(with(&["--debug-hvc"]).unwrap().debug_hvc, DebugHvc::On);
        assert_eq!(with(&["--no-debug-hvc"]).unwrap().debug_hvc, DebugHvc::Off);
        assert!(with(&["--debug-hvc", "--no-debug-hvc"]).is_err());
        assert!(with(&["--debug-hvc=1"]).is_err());
    }

    /// M6: `--serial` (TTY-2, LOG-4) and `--stats`.
    #[test]
    fn serial_and_stats_flags() {
        let d = with(&[]).unwrap();
        assert_eq!(
            (d.serial.kind, d.serial.policy, d.stats),
            (SinkKind::Stdio, FilterPolicy::Safe, false)
        );
        assert_eq!(d.serial.max_bytes, 1 << 30);
        let c = with(&["--serial", "file:/tmp/s.txt,strict,max=1K", "--stats"]).unwrap();
        assert_eq!(c.serial.kind, SinkKind::File);
        assert_eq!(c.serial.path, Some(PathBuf::from("/tmp/s.txt")));
        assert_eq!(
            (c.serial.policy, c.serial.max_bytes, c.stats),
            (FilterPolicy::Strict, 1024, true)
        );
        // Options in either order; a comma inside the name is kept.
        let c = with(&["--serial=file:a,b.txt,max=2K,raw"]).unwrap();
        assert_eq!(c.serial.path, Some(PathBuf::from("a,b.txt")));
        assert_eq!(
            (c.serial.policy, c.serial.max_bytes),
            (FilterPolicy::Raw, 2048)
        );
        assert_eq!(parse_serial("stdio,raw").unwrap().policy, FilterPolicy::Raw);
        assert_eq!(parse_serial("none").unwrap().kind, SinkKind::None);
        assert_eq!(
            parse_serial("stdio,safe").unwrap().policy,
            FilterPolicy::Safe
        );
        for bad in [
            "",
            "file:",
            "tty",
            "stdio,max=1K",
            "none,max=1K",
            "file:x,max=0",
            "file:x,max=99999999999G",
            "file:x,raw,strict",
            "file:x,max=1K,max=2K",
            "stdio,loud",
        ] {
            assert!(parse_serial(bad).is_err(), "{bad:?}");
        }
        assert!(with(&["--serial", "none", "--serial", "stdio"]).is_err());
        assert!(with(&["--stats=1"]).is_err());
    }

    /// M13: `--console` takes the `--serial` grammar minus `none`; at most one stdio sink.
    #[test]
    fn console_flag() {
        assert_eq!(with(&[]).unwrap().console, None);
        let c = with(&["--console", "file:/tmp/hvc0.out,max=64K"]).unwrap();
        let k = c.console.unwrap();
        assert_eq!(
            (k.kind, k.path, k.max_bytes, k.policy),
            (
                SinkKind::File,
                Some(PathBuf::from("/tmp/hvc0.out")),
                65536,
                FilterPolicy::Safe
            )
        );
        let c = with(&["--console=stdio,strict", "--serial", "file:s.txt"]).unwrap();
        let k = c.console.unwrap();
        assert_eq!((k.kind, k.policy), (SinkKind::Stdio, FilterPolicy::Strict));
        assert!(with(&["--console", "stdio", "--serial", "none"]).is_ok());
        // Both on stdio, explicitly or through the --serial default: exit code 2.
        for args in [
            &["--console", "stdio", "--serial", "stdio"][..],
            &["--console", "stdio"][..],
        ] {
            let e = with(args).unwrap_err();
            assert!(
                e.contains("only one of --serial/--console may be stdio"),
                "{e}"
            );
        }
        for bad in ["none", "", "file:", "stdio,max=1K", "tty", "file:x,max=0"] {
            let e = with(&["--serial", "none", "--console", bad]).unwrap_err();
            assert!(e.contains("--console"), "{bad:?}: {e}");
        }
        assert!(
            with(&[
                "--serial",
                "none",
                "--console",
                "stdio",
                "--console",
                "stdio"
            ])
            .unwrap_err()
            .contains("twice")
        );
    }

    /// M9: `--initrd`, `--cmdline`, `--dry-run`.
    #[test]
    fn linux_flags() {
        let c = parse_run(&v(&[
            "--kernel",
            "Image",
            "--initrd=rd.img",
            "--cmdline",
            "console=ttyAMA0 quiet",
            "--dry-run",
        ]))
        .unwrap();
        assert_eq!(c.boot.initrd, Some(PathBuf::from("rd.img")));
        assert_eq!(c.boot.cmdline.as_deref(), Some("console=ttyAMA0 quiet"));
        assert!(c.dry_run);
        assert!(!with(&[]).unwrap().dry_run);
        assert!(with(&["--dry-run=1"]).is_err());
        // Linux inputs need a kernel; repeated flags are errors.
        assert!(
            with(&["--initrd", "rd"])
                .unwrap_err()
                .contains("needs --kernel")
        );
        assert!(
            with(&["--cmdline", "x"])
                .unwrap_err()
                .contains("needs --kernel")
        );
        let k = |extra: &[&str]| {
            let mut a = vec!["--kernel", "Image"];
            a.extend_from_slice(extra);
            parse_run(&v(&a))
        };
        assert!(k(&["--initrd", "a", "--initrd", "b"]).is_err());
        assert!(k(&["--initrd="]).is_err());
        assert!(k(&["--cmdline", "a", "--cmdline", "b"]).is_err());
        // FDT-2: 2047 bytes are fine, 2048 are not.
        assert!(k(&["--cmdline", &"x".repeat(2047)]).is_ok());
        let e = k(&["--cmdline", &"x".repeat(2048)]).unwrap_err();
        assert!(e.contains("at most 2047"), "{e}");
        assert!(RUN_USAGE.contains("--dry-run"));
    }

    /// M16: `--cpus` (1..=64; the host's limit is checked when the VM is built).
    #[test]
    fn cpus_flag() {
        assert_eq!(with(&[]).unwrap().cpus, 1);
        assert_eq!(with(&["--cpus", "4"]).unwrap().cpus, 4);
        assert_eq!(with(&["--cpus=64"]).unwrap().cpus, 64);
        for bad in ["0", "65", "-1", "+4", "0x4", "4k", "", "99999999999"] {
            let e = with(&["--cpus", bad]).unwrap_err();
            assert!(e.contains("--cpus"), "{bad}: {e}");
        }
        assert!(with(&["--cpus"]).unwrap_err().contains("needs a value"));
        assert!(RUN_USAGE.contains("--cpus N"));
        // The no-GIC teaching mode stays single-vCPU.
        assert!(with(&["--cpus", "2", "--irqchip", "none"]).is_err());
    }

    /// M8: the hidden `--irqchip none`; with `--cpus 2` (M16) it is refused by `validate`
    /// (`vmm::config` test `irqchip_none_restrictions`).
    #[test]
    fn irqchip_flag() {
        assert_eq!(with(&[]).unwrap().irqchip, IrqChip::InKernelGicV3);
        assert_eq!(with(&["--irqchip", "none"]).unwrap().irqchip, IrqChip::None);
        assert_eq!(with(&["--irqchip=none"]).unwrap().irqchip, IrqChip::None);
        assert!(with(&["--irqchip", "gicv2"]).is_err());
        assert!(!RUN_USAGE.contains("irqchip"), "hidden flag");
        assert!(RUN_USAGE.contains("--serial SINK"));
    }

    /// Review fix (ADR-0008 decision 6): the lock directory follows `HOME` only, never the
    /// working directory or `MACVMM_CACHE`; no absolute `HOME`, no directory (refused later).
    #[test]
    fn vmapple_slot_dir_is_per_user() {
        assert_eq!(
            vmapple_slot_dir(Some("/Users/u".into())),
            Some(PathBuf::from("/Users/u/.cache/macvmm/vmapple-slots"))
        );
        assert_eq!(vmapple_slot_dir(None), None);
        assert_eq!(vmapple_slot_dir(Some("".into())), None);
        assert_eq!(vmapple_slot_dir(Some("relative/home".into())), None);
    }
    /// M22 (threat model §9.3 "cli", TEST-3): the real `run` front end, `sandbox::split_flags`
    /// then `parse_run`, on generated argument vectors, against the invariants of
    /// `fuzz::targets::cli::check_front_end` (sandbox tokens removed only outside a value
    /// position, a reference model of the flag rules, no panic in `parse_run`, unknown flags
    /// never ignored, `--dry-run` changes only `dry_run`). 10,000 iterations by default;
    /// `MACVMM_FUZZ_SECONDS` makes it a timed fuzz run (`scripts/fuzz.sh cli`).
    /// `split_flags` in the shape the fuzz crate can name.
    fn split_for_fuzz(args: &[String]) -> Result<fuzz::targets::cli::Split, String> {
        use crate::sandbox::Mode;
        use fuzz::targets::cli::SandboxMode;
        let (o, rest) = crate::sandbox::split_flags(args)?;
        let mode = match o.mode {
            Mode::Off => SandboxMode::Off,
            Mode::Enforce => SandboxMode::Enforce,
            Mode::BestEffort => SandboxMode::BestEffort,
        };
        Ok((mode, o.selftest, rest))
    }

    /// The fuzz check's notion of "takes the next argument" (`sandbox::VALUE_FLAGS`) must match
    /// `parse_run`'s: every listed `run` flag wants a value, and no other known flag does.
    #[test]
    fn value_flags_match_parse_run() {
        let known = [
            "--mem",
            "--kernel",
            "--initrd",
            "--cmdline",
            "--dry-run",
            "--raw",
            "--timeout",
            "--unhandled-mmio",
            "--trace",
            "--testdev",
            "--disk",
            "--rng",
            "--net",
            "--on-reset",
            "--debug-hvc",
            "--no-debug-hvc",
            "--dtb-out",
            "--serial",
            "--console",
            "--stats",
            "--irqchip",
            "--machine",
            "--bios",
            "--cpus",
        ];
        for f in known {
            let wants = parse_run(&[f.to_string()])
                .err()
                .is_some_and(|e| e.contains("needs a value"));
            assert_eq!(
                wants,
                crate::sandbox::VALUE_FLAGS.contains(&f),
                "{f}: parse_run and sandbox::VALUE_FLAGS disagree"
            );
        }
        // `--log` is the global flag (main.rs), which also takes the next argument.
        assert!(crate::sandbox::VALUE_FLAGS.contains(&"--log"));
    }

    #[test]
    fn cli_fuzz() {
        use fuzz::rng::Rng;
        let seed: u64 = std::env::var("MACVMM_SEED")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let secs: Option<u64> = std::env::var("MACVMM_FUZZ_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok());
        let deadline = secs.map(|s| std::time::Instant::now() + Duration::from_secs(s));
        let mut n = 0u64;
        loop {
            match deadline {
                Some(d) if std::time::Instant::now() >= d => break,
                None if n >= 10_000 => break,
                _ => {}
            }
            let mut rng = Rng::derive(seed, n);
            let len = rng.index(96);
            let mut data = rng.bytes(len);
            fuzz::mutate::bytes(&mut rng, &mut data, 512);
            if let Err(e) = fuzz::targets::cli::check_front_end(
                split_for_fuzz,
                crate::sandbox::VALUE_FLAGS,
                parse_run,
                &data,
            ) {
                panic!("fuzz cli (parse_run): seed {seed} iteration {n}: {e}");
            }
            n += 1;
        }
        let mut out = std::io::stdout().lock();
        let _ = std::io::Write::write_all(
            &mut out,
            format!("fuzz cli (parse_run): {n} iterations, 0 failures\n").as_bytes(),
        );
    }
}
