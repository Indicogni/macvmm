//! `--sandbox`: confine the running VMM with a `(deny default)` profile (PLAN M22; threat model
//! §7.12 SBX-1..SBX-4, F5; PROC-4).
//!
//! **Why.** The VMM parses hostile guest data (virtqueues, MMIO, the console stream). If a
//! parser bug ever lets a guest run code inside `macvmm`, the attacker has whatever the process
//! has, and an ad-hoc signed CLI has everything its user has: it can read `~/.ssh`, open
//! sockets and spawn shells. The hypervisor entitlement confines nothing (SIGN-2, F5). A
//! sandbox does: after the lockdown the process can open no file by path, reach no network and
//! start no process, so a compromised VMM keeps only what it already held, the guest's RAM and
//! the fds `HostIo` opened.
//!
//! **Mechanism (SBX-1).** `sandbox_init` with an SBPL profile string, mid-process
//! (`hvf::host::sandbox_init_profile`). It is the same engine `sandbox-exec -p` and App Sandbox
//! use. The SDK declares the call deprecated and documents only named profiles; the string form
//! is undocumented but verified on macOS 27.2 (threat model §13). If it ever stops working,
//! `scripts/sandbox-exec-fallback.sh` applies an equivalent profile from exec time.
//!
//! **Timing (SBX-3, F5).** [`lockdown`] runs after `HostIo::open` (every input read, every output
//! and disk opened, sockets bound: HOSTIO-1), after the signal and stdin threads exist, and before
//! the first guest instruction. Everything after it, including **vCPU creation, an in-process
//! reboot (`hv_vm_create`, `hv_vm_allocate`, `hv_gic_create`) and the entropy reads**, must work
//! under the profile; the self-test exercises exactly those.
//!
//! **The profile ([`PROFILE`], SBX-2).** `(deny default)` plus:
//! - `sysctl-read` (the host page size, `kern.osproductversion`);
//! - four terminal ioctls on the fds we hold: `TIOCSETA`/`TIOCSETAW`/`TIOCSETAF` (`tcsetattr`)
//!   and `TIOCFLUSH` (`tcflush`). Without them the exit path cannot restore the terminal
//!   (PROC-1, TTY-6): measured in M22, `(deny default)` refuses `tcsetattr` with `EPERM` while
//!   `tcgetattr` still works. `TIOCSTI` (inject keystrokes into the user's shell) stays denied;
//! - for each `--net unixgram` peer, `network-outbound` to that one socket path (M24's frames are
//!   `send_to(peer)`; receiving on the bound socket needs no rule, measured), plus
//!   `file-read-metadata` on each symlink in the peer path as given (`/var -> private/var`):
//!   resolving the path reads the link, and `(deny default)` refuses that (measured).
//!
//! It grants **no `mach-lookup` and no `iokit-open`**: Hypervisor.framework needs neither for VM
//! create, the in-kernel GIC, vCPU runs, destroy and re-create (measured with `sandbox_init` in
//! M22 and with `sandbox-exec` in threat model §13). Already-open fds keep working under
//! `(deny default)`: reads, writes, `pread`/`pwrite`, `F_FULLFSYNC` and `flock`ed disks were all
//! measured to work, so path-based `file-read*`/`file-write*` can be denied outright.
//!
//! **`RLIMIT_NOFILE` (PROC-4).** Just before `sandbox_init`, the fd limit is lowered to the
//! highest fd in use + 1 + 16, so a compromised VMM cannot hoard descriptors (and has none to
//! spare for anything the profile might still allow). The slack covers what later work opens
//! without a path (vCPU threads, a reboot's VM).
//!
//! **Fail closed (SBX-4).** `--sandbox` exits 1 if `sandbox_init` fails; `--sandbox=best-effort`
//! warns and continues unconfined. A sandbox flag never silently does nothing.

use std::path::{Path, PathBuf};
use vmm::VmConfig;
use vmm::config::NetPeer;

/// What `--sandbox` asks for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Mode {
    /// No `--sandbox` flag (the default until the lead decides otherwise, DECISIONS D15).
    #[default]
    Off,
    /// `--sandbox`: lock down or exit 1.
    Enforce,
    /// `--sandbox=best-effort`: lock down, or warn and run unconfined.
    BestEffort,
}

/// The sandbox flags, taken out of the `run` arguments before the main parser sees them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Opts {
    pub mode: Mode,
    /// Hidden `--sandbox-selftest`: after the lockdown, prove that an open, a socket connect
    /// and a spawn are refused (SBX-3 item 4, TEST-10), then run the VM as usual.
    pub selftest: bool,
}

/// The `run` flags that take their value as the *next* argument (architecture §13.1). Their
/// value is passed through untouched, so `--cmdline --sandbox` stays a command line.
pub(crate) const VALUE_FLAGS: &[&str] = &[
    "--mem",
    "--kernel",
    "--initrd",
    "--cmdline",
    "--machine",
    "--bios",
    "--raw",
    "--timeout",
    "--unhandled-mmio",
    "--trace",
    "--disk",
    "--net",
    "--on-reset",
    "--dtb-out",
    "--serial",
    "--console",
    "--irqchip",
    "--cpus",
    "--log",
];

/// Split `--sandbox[=best-effort]` and `--sandbox-selftest` off `args`; the rest goes to
/// `cli::parse_run` unchanged.
pub fn split_flags(args: &[String]) -> Result<(Opts, Vec<String>), String> {
    let mut o = Opts::default();
    let mut rest = Vec::with_capacity(args.len());
    let mut value_next = false;
    for a in args {
        if std::mem::take(&mut value_next) {
            rest.push(a.clone());
            continue;
        }
        value_next = VALUE_FLAGS.contains(&a.as_str());
        let mode = match a.as_str() {
            "--sandbox" => Some(Mode::Enforce),
            "--sandbox=best-effort" => Some(Mode::BestEffort),
            "--sandbox-selftest" => {
                o.selftest = true;
                None
            }
            s if s.starts_with("--sandbox=") => {
                return Err(format!(
                    "invalid {s:?}: use --sandbox or --sandbox=best-effort"
                ));
            }
            s if s.starts_with("--sandbox-selftest=") => {
                return Err("--sandbox-selftest takes no value".into());
            }
            _ => {
                rest.push(a.clone());
                None
            }
        };
        if let Some(m) = mode {
            if o.mode != Mode::Off {
                return Err("--sandbox given twice".into());
            }
            o.mode = m;
        }
    }
    if o.selftest && o.mode == Mode::Off {
        return Err("--sandbox-selftest needs --sandbox".into());
    }
    Ok((o, rest))
}

// ANCHOR: sandbox_profile
/// The lockdown profile (SBX-2; module docs). SBPL, the Scheme dialect of macOS's Seatbelt.
/// Rules are matched last-to-first with `deny default` as the fallback; the explicit denials
/// restate the policy for the reader (and keep it if a later edit adds a broad `allow`).
pub const PROFILE: &str = r#"(version 1)
(deny default)
(allow sysctl-read)
(allow file-ioctl
       (ioctl-command TIOCSETA)
       (ioctl-command TIOCSETAW)
       (ioctl-command TIOCSETAF)
       (ioctl-command TIOCFLUSH))
(deny file-read* file-write* file-write-create)
(deny network*)
(deny process-exec* process-fork)
"#;
// ANCHOR_END: sandbox_profile

/// A path as an SBPL string literal, or `Err` if it holds a character we will not escape (a
/// quote, a backslash, a control character): such a path is refused rather than risk a
/// profile that means something else.
fn sbpl_literal(p: &Path) -> Result<String, String> {
    let s = p
        .to_str()
        .ok_or_else(|| format!("{}: not UTF-8", p.display()))?;
    if s.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
        return Err(format!(
            "--sandbox: the path {s:?} cannot be written into the sandbox profile"
        ));
    }
    Ok(format!("\"{s}\""))
}

/// The spellings of a peer socket path the kernel may check: as given (made absolute) and with
/// its directory resolved (`/tmp` is `/private/tmp` on macOS).
fn peer_spellings(p: &Path) -> Vec<PathBuf> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|d| d.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    };
    let mut out = vec![abs.clone()];
    if let (Some(dir), Some(name)) = (abs.parent(), abs.file_name())
        && let Ok(real) = std::fs::canonicalize(dir)
    {
        let r = real.join(name);
        if r != abs {
            out.push(r);
        }
    }
    out
}

/// The ancestors of `path` that are symbolic links (checked with `symlink_metadata`, which does
/// not follow the last component). A link whose target holds another link is not followed
/// further; the e2e cases (`/var`, `/tmp`) are single links.
fn symlinks_on(path: &Path) -> Vec<PathBuf> {
    path.ancestors()
        .skip(1)
        .filter(|a| a.parent().is_some())
        .filter(|a| std::fs::symlink_metadata(a).is_ok_and(|m| m.file_type().is_symlink()))
        .map(Path::to_path_buf)
        .collect()
}

/// [`PROFILE`] plus this configuration's allowances (module docs). `,learn` NICs are refused:
/// their peer is unknown when the profile is written, and the profile cannot grow later.
pub fn profile_for(cfg: &VmConfig) -> Result<String, String> {
    let mut p = String::from(PROFILE);
    for n in &cfg.net {
        match &n.peer {
            NetPeer::Path(peer) => {
                let spellings = peer_spellings(peer);
                for s in &spellings {
                    p.push_str(&format!(
                        "(allow network-outbound (remote unix-socket (path-literal {})))\n",
                        sbpl_literal(s)?
                    ));
                }
                // `send_to` resolves the path as given: each symlink on it (`/var`, `/tmp`)
                // is read (`readlink`), which `(deny default)` refuses (measured: EPERM for a
                // peer under `/var/folders`). Allow exactly those links' metadata.
                if let Some(given) = spellings.first() {
                    for link in symlinks_on(given) {
                        p.push_str(&format!(
                            "(allow file-read-metadata (literal {}))\n",
                            sbpl_literal(&link)?
                        ));
                    }
                }
            }
            NetPeer::Learn => {
                return Err(
                    "--sandbox: --net ...,learn is not supported (the peer must be known when the \
                     sandbox is applied); use peer=PATH"
                        .into(),
                );
            }
        }
    }
    Ok(p)
}

/// What [`lockdown`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lockdown {
    /// The `RLIMIT_NOFILE` now in force (soft = hard).
    pub nofile: u64,
}

/// Extra descriptors left free under the lowered `RLIMIT_NOFILE` (module docs).
pub const NOFILE_SLACK: u64 = 16;

// ANCHOR: sandbox_lockdown
/// Lower `RLIMIT_NOFILE`, then apply the profile (module docs: timing, PROC-4, SBX-2).
/// Irrevocable. `Err` is the reason; the caller decides between exit 1 and a warning (SBX-4).
pub fn lockdown(cfg: &VmConfig) -> Result<Lockdown, String> {
    let profile = profile_for(cfg)?;
    let (soft, _) = hvf::host::get_rlimit(hvf::host::RLIMIT_NOFILE)
        .map_err(|e| format!("getrlimit(RLIMIT_NOFILE): {e}"))?;
    let scan = i32::try_from(soft.min(1 << 16)).unwrap_or(1 << 16);
    let highest = hvf::host::highest_open_fd(scan).unwrap_or(2);
    let nofile = u64::try_from(highest)
        .unwrap_or(2)
        .saturating_add(1)
        .saturating_add(NOFILE_SLACK)
        .min(soft);
    hvf::host::set_rlimit(hvf::host::RLIMIT_NOFILE, nofile)
        .map_err(|e| format!("setrlimit(RLIMIT_NOFILE, {nofile}): {e}"))?;
    hvf::host::sandbox_init_profile(&profile).map_err(|e| format!("sandbox_init: {e}"))?;
    Ok(Lockdown { nofile })
}
// ANCHOR_END: sandbox_lockdown

/// The `--stats` line for the process limits in force (PROC-4): `rlimit core=0 nofile=<n>`
/// (`nofile` is lowered by `--sandbox`, [`lockdown`]).
pub fn rlimit_stats() -> String {
    let lim = |r| hvf::host::get_rlimit(r).map_or_else(|_| "?".into(), |(s, _)| s.to_string());
    format!(
        "macvmm: stats: rlimit core={} nofile={}",
        lim(hvf::host::RLIMIT_CORE),
        lim(hvf::host::RLIMIT_NOFILE)
    )
}

/// One probe's verdict: `Ok(())` if the sandbox refused it.
fn denied(what: &str, r: std::io::Result<()>, refused_also: &[i32]) -> Result<(), String> {
    match r {
        Ok(()) => Err(format!("{what} ALLOWED")),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => Ok(()),
        Err(e) if e.raw_os_error().is_some_and(|c| refused_also.contains(&c)) => Ok(()),
        Err(e) => Err(format!("{what} failed for another reason ({e})")),
    }
}

/// `ECONNREFUSED` (macOS `sys/errno.h`): the connect reached the network stack.
const ECONNREFUSED: i32 = 61;

/// The SBX-3 item 4 probes, after [`lockdown`]: `open("/etc/hosts")`, a loopback TCP connect
/// and `posix_spawn("/usr/bin/true")` must all be refused by the sandbox. `Ok` is the line to
/// print; `Err` names what got through.
pub fn selftest() -> Result<String, String> {
    let mut bad = Vec::new();
    if let Err(e) = denied("open", hvf::host::probe_open("/etc/hosts"), &[]) {
        bad.push(e);
    }
    match hvf::host::probe_connect_loopback() {
        Err(e) if e.raw_os_error() == Some(ECONNREFUSED) => {
            bad.push("socket connect ALLOWED (ECONNREFUSED: it reached the network stack)".into())
        }
        r => {
            if let Err(e) = denied("socket connect", r, &[]) {
                bad.push(e);
            }
        }
    }
    if let Err(e) = denied("spawn", hvf::host::probe_spawn("/usr/bin/true"), &[]) {
        bad.push(e);
    }
    if bad.is_empty() {
        Ok("sandbox: open denied, socket denied, spawn denied".into())
    } else {
        Err(format!("sandbox: self-test FAILED: {}", bad.join(", ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_split_off() {
        let (o, rest) = split_flags(&v(&["--sandbox", "--kernel", "k"])).unwrap();
        assert_eq!(o.mode, Mode::Enforce);
        assert!(!o.selftest);
        assert_eq!(rest, v(&["--kernel", "k"]));
        let (o, _) = split_flags(&v(&["--sandbox=best-effort", "--sandbox-selftest"])).unwrap();
        assert_eq!((o.mode, o.selftest), (Mode::BestEffort, true));
        assert_eq!(
            split_flags(&v(&["--mem", "64M"])).unwrap().0,
            Opts::default()
        );
        // A flag's value is never taken for a sandbox flag.
        let (o, rest) = split_flags(&v(&["--cmdline", "--sandbox", "--kernel", "k"])).unwrap();
        assert_eq!(o, Opts::default());
        assert_eq!(rest, v(&["--cmdline", "--sandbox", "--kernel", "k"]));
        for bad in [
            &["--sandbox", "--sandbox"][..],
            &["--sandbox=strict"][..],
            &["--sandbox-selftest"][..],
            &["--sandbox", "--sandbox-selftest=1"][..],
        ] {
            assert!(split_flags(&v(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn profile_shape() {
        assert!(PROFILE.contains("(deny default)"));
        assert!(
            !PROFILE.contains("mach-lookup"),
            "SBX-2: no mach-lookup allowance"
        );
        assert!(!PROFILE.contains("iokit"), "SBX-2: no IOKit allowance");
        assert!(!PROFILE.contains("TIOCSTI"));
        let mut cfg = VmConfig::default();
        assert_eq!(profile_for(&cfg).unwrap(), PROFILE);
        cfg.net.push(vmm::config::NetSpec {
            local: "/t/a.sock".into(),
            peer: NetPeer::Path("/t/b.sock".into()),
            mac: None,
        });
        let p = profile_for(&cfg).unwrap();
        assert!(p.contains(r#"(path-literal "/t/b.sock")"#), "{p}");
        // `/tmp` is a symlink to `private/tmp` on macOS: resolving the peer path reads it.
        cfg.net[0].peer = NetPeer::Path("/tmp/b.sock".into());
        let p = profile_for(&cfg).unwrap();
        assert!(
            p.contains(r#"(allow file-read-metadata (literal "/tmp"))"#),
            "{p}"
        );
        assert!(p.contains(r#"(path-literal "/private/tmp/b.sock")"#), "{p}");
        cfg.net[0].peer = NetPeer::Path("/t/b\".sock".into());
        assert!(
            profile_for(&cfg).is_err(),
            "a quote cannot reach the profile"
        );
        cfg.net[0].peer = NetPeer::Learn;
        assert!(profile_for(&cfg).unwrap_err().contains("learn"));
    }
}
