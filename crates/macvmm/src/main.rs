//! `macvmm`: the command-line front end.
//!
//! **Why so thin:** UX lives here, policy in `vmm`, mechanism in `hvf` (architecture
//! principle 4). `main` only parses the global flags, picks a subcommand and turns its outcome
//! into a process exit code (architecture §13.2: 0 success, 1 VMM/host failure, 2 usage error).
//!
//! Subcommands arrive with their milestones: `doctor` (M0), `first-exit` (M1), `run` (M3, with
//! the full flag parser in `cli.rs`). Registering a new one is an additive edit to [`dispatch`].
//!
//! **Process hardening comes first** ([`harden_process`], threat model PATH-6, PROC-4): before
//! anything else, `umask(0o077)` makes every file macvmm creates 0600, and
//! `setrlimit(RLIMIT_CORE, 0)` keeps guest RAM out of core dumps (asset AS7). Both cost one
//! call and must hold before any guest memory or output file exists.
//!
//! Output is written with `write!` on a locked handle and write errors are ignored, so
//! `macvmm doctor | head -1` ends quietly instead of panicking on `EPIPE` (the same reason
//! RUST-5 bans `println!` in `vmm`). Stderr lines go through `vmm::log`'s queue ([`err`]): they
//! keep their order with the log lines, and no thread ever blocks on a stalled stderr (SINK-1).
//! `main` gives that queue a bounded [`STDERR_DRAIN`] to drain before the process exits.
#![forbid(unsafe_code)]

mod cli;
mod doctor;
mod first_exit;
mod sandbox;
mod signals;
mod term;

use std::io::Write;
use std::process::ExitCode;

/// Verbosity for `--log` / `MACVMM_LOG` (architecture §13.1, §16). M2's `vmm::log` takes this
/// over; until then only `doctor` consults it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    fn parse(s: &str) -> Option<LogLevel> {
        match s {
            "error" => Some(LogLevel::Error),
            "warn" => Some(LogLevel::Warn),
            "info" => Some(LogLevel::Info),
            "debug" => Some(LogLevel::Debug),
            "trace" => Some(LogLevel::Trace),
            _ => None,
        }
    }
}

const USAGE: &str = "\
usage: macvmm [--log LEVEL] <command>

commands:
  doctor      check signing, entitlements and Hypervisor.framework support on this Mac
  first-exit  run three guest instructions and print the HVC exit (course ch02)
  run         run a VM (macvmm run --help for its options)
  help        print this message

options:
  --log LEVEL error|warn|info|debug|trace (default warn; also MACVMM_LOG)
  --version   print the version
";

/// Write to stdout, ignoring errors (closed pipe).
pub fn out(line: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{line}");
}

/// Write a line to stderr through the log queue (module docs): never blocks, never fails.
pub fn err(line: &str) {
    vmm::log::line(line);
}

/// How long `main` waits for queued stderr lines to be written before exiting. Short, so that
/// a stalled stderr delays the exit by no more than this (SINK-1).
const STDERR_DRAIN: std::time::Duration = std::time::Duration::from_millis(300);

fn usage_error(msg: &str) -> ExitCode {
    err(&format!("macvmm: {msg}"));
    err(USAGE.trim_end());
    ExitCode::from(2)
}

/// Parsed global options plus the remaining command words.
struct Args {
    log: LogLevel,
    command: Option<String>,
    rest: Vec<String>,
}

/// `--log` may appear before or after the command; both `--log X` and `--log=X` work.
/// Unknown flags are errors (architecture §13.1).
fn parse_args(argv: Vec<String>, env_log: Option<String>) -> Result<Args, String> {
    let mut log = None;
    let mut command = None;
    let mut rest = Vec::new();
    let mut it = argv.into_iter();
    while let Some(arg) = it.next() {
        let value = if arg == "--log" {
            Some(it.next().ok_or("--log needs a value")?)
        } else {
            arg.strip_prefix("--log=").map(str::to_owned)
        };
        if let Some(v) = value {
            log = Some(LogLevel::parse(&v).ok_or(format!("invalid --log value {v:?}"))?);
        } else if command.is_none()
            && (!arg.starts_with('-') || matches!(arg.as_str(), "--help" | "-h" | "--version"))
        {
            command = Some(arg);
        } else {
            rest.push(arg);
        }
    }
    let log = match (log, env_log) {
        (Some(l), _) => l,
        (None, Some(v)) => LogLevel::parse(&v).ok_or(format!("invalid MACVMM_LOG value {v:?}"))?,
        (None, None) => LogLevel::Warn,
    };
    Ok(Args { log, command, rest })
}

fn dispatch(args: Args) -> ExitCode {
    match args.command.as_deref() {
        // ANCHOR: main_doctor
        Some("doctor") => {
            if let Some(extra) = args.rest.first() {
                return usage_error(&format!("doctor: unexpected argument {extra:?}"));
            }
            doctor::run(args.log)
        }
        // ANCHOR_END: main_doctor
        // ANCHOR: main_first_exit
        Some("first-exit") => {
            if let Some(extra) = args.rest.first() {
                return usage_error(&format!("first-exit: unexpected argument {extra:?}"));
            }
            first_exit::run()
        }
        // ANCHOR_END: main_first_exit
        Some("run") => {
            if args.rest.iter().any(|a| a == "--help" || a == "-h") {
                out(cli::RUN_USAGE.trim_end());
                return ExitCode::SUCCESS;
            }
            cli::run(&args.rest)
        }
        Some("help" | "--help" | "-h") => {
            out(USAGE.trim_end());
            ExitCode::SUCCESS
        }
        Some("--version") => {
            out(concat!("macvmm ", env!("CARGO_PKG_VERSION")));
            ExitCode::SUCCESS
        }
        Some(other) => usage_error(&format!("unknown command {other:?}")),
        None => match args.rest.first() {
            Some(flag) => usage_error(&format!("unknown flag {flag:?}")),
            None => usage_error("missing command"),
        },
    }
}

/// Startup hardening, before anything else runs (module docs; PATH-6, PROC-4). Fails closed:
/// if the core limit cannot be set, macvmm refuses to run rather than risk a core full of
/// guest RAM.
// ANCHOR: harden_process
fn harden_process() -> std::io::Result<()> {
    hvf::host::set_umask(0o077);
    hvf::host::set_rlimit(hvf::host::RLIMIT_CORE, 0)
}
// ANCHOR_END: harden_process

/// `vmm::log` takes the level from `--log` / `MACVMM_LOG`.
fn vmm_level(l: LogLevel) -> vmm::log::Level {
    match l {
        LogLevel::Error => vmm::log::Level::Error,
        LogLevel::Warn => vmm::log::Level::Warn,
        LogLevel::Info => vmm::log::Level::Info,
        LogLevel::Debug => vmm::log::Level::Debug,
        LogLevel::Trace => vmm::log::Level::Trace,
    }
}

fn main() -> ExitCode {
    let code = real_main();
    vmm::log::flush(STDERR_DRAIN);
    code
}

fn real_main() -> ExitCode {
    if let Err(e) = harden_process() {
        err(&format!(
            "macvmm: cannot harden the process (setrlimit RLIMIT_CORE): {e}"
        ));
        return ExitCode::from(1);
    }
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let env_log = std::env::var("MACVMM_LOG").ok();
    match parse_args(argv, env_log) {
        Ok(args) => {
            vmm::log::set_max_level(Some(vmm_level(args.log)));
            dispatch(args)
        }
        Err(msg) => usage_error(&msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn log_flag_before_and_after_command() {
        let a = parse_args(v(&["--log", "debug", "doctor"]), None).unwrap();
        assert_eq!(
            (a.log, a.command.as_deref()),
            (LogLevel::Debug, Some("doctor"))
        );
        let a = parse_args(v(&["doctor", "--log=trace"]), None).unwrap();
        assert_eq!(
            (a.log, a.command.as_deref()),
            (LogLevel::Trace, Some("doctor"))
        );
        assert!(a.rest.is_empty());
    }

    #[test]
    fn env_log_is_fallback_and_flag_wins() {
        let a = parse_args(v(&["doctor"]), Some("info".into())).unwrap();
        assert_eq!(a.log, LogLevel::Info);
        let a = parse_args(v(&["doctor", "--log", "error"]), Some("info".into())).unwrap();
        assert_eq!(a.log, LogLevel::Error);
        assert_eq!(
            parse_args(v(&["doctor"]), None).unwrap().log,
            LogLevel::Warn
        );
    }

    #[test]
    fn bad_values_are_errors() {
        assert!(parse_args(v(&["--log"]), None).is_err());
        assert!(parse_args(v(&["--log", "loud", "doctor"]), None).is_err());
        assert!(parse_args(v(&["doctor"]), Some("LOUD".into())).is_err());
    }

    /// PLAN M3 security test `rlimit_core_zero` (PROC-4, PATH-6): after startup hardening the
    /// core limit reads back as 0 and the umask as 0o077. It changes process-wide state, which
    /// is harmless for the other unit tests of this binary (none creates files).
    #[test]
    fn rlimit_core_zero() {
        harden_process().unwrap();
        assert_eq!(
            hvf::host::get_rlimit(hvf::host::RLIMIT_CORE).unwrap(),
            (0, 0)
        );
        // umask(2) only reads by writing: set it again and look at the previous value.
        assert_eq!(hvf::host::set_umask(0o077), 0o077);
    }

    #[test]
    fn unknown_flags_are_kept_for_rejection() {
        let a = parse_args(v(&["doctor", "--frobnicate"]), None).unwrap();
        assert_eq!(a.rest, v(&["--frobnicate"]));
    }
}
