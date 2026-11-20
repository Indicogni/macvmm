//! Target `cli`: the command-line grammar (architecture §13.1; threat model PATH-8) on arbitrary
//! argument vectors.
//!
//! **Two halves.** The `macvmm run` front end (`sandbox::split_flags`, then `cli::parse_run`)
//! lives in the `macvmm` *binary* crate, which no other crate can link. So this module provides
//! the argv generator and the invariant checks ([`argv`], [`check_front_end`]);
//! `crates/macvmm/src/cli.rs`'s test `cli_fuzz` drives the real functions with them
//! (`scripts/fuzz.sh cli` runs both halves). The target registered here fuzzes the pieces of the
//! grammar that live in `vmm`: `--raw F@ADDR` (`loader::raw::parse_spec`), `mac=`
//! (`net::parse_mac`), trace categories (`TraceCats::parse`).
//!
//! **Invariants (this target):** no panic on any UTF-8; a parser returns `Err` or a value that
//! satisfies its own contract (a `--raw` address equals a reference parse of the same text, a MAC
//! is never multicast or all-zero).
//!
//! **Invariants (`check_front_end`, M22 SBX-4):**
//! - `split_flags` removes only the three sandbox tokens, and only outside a *value position*
//!   (the argument right after a flag that takes its value as the next argument): the kept
//!   arguments are the input in order with exactly those tokens taken out, so
//!   `--cmdline --sandbox` keeps `--sandbox` as a command line;
//! - its verdict agrees with a reference model written here: `--sandbox-selftest` without
//!   `--sandbox` is `Err`, a second `--sandbox` is `Err`, `--sandbox=<other>` is `Err`;
//! - `parse_run` does not panic. (Its own `Ok` already means "`validate` accepted it", since it
//!   ends with `cfg.validate()?`, so re-validating would check nothing.) Two properties that do
//!   not restate the parser: an unknown flag appended to an accepted argument list is always
//!   rejected (unknown flags are never ignored, architecture §13.1), and appending `--dry-run`
//!   to an accepted list yields the same configuration with only `dry_run` set.

use super::Input;
use crate::Target;
use crate::rng::Rng;
use vmm::VmConfig;

pub const TARGET: Target = Target {
    name: "cli",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 512,
};

/// Flags and values the generator draws from (architecture §13.1), plus junk.
const FLAGS: &[&str] = &[
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
    "--sandbox",
    "--sandbox=best-effort",
    "--sandbox-selftest",
    "--cpus",
    "--log",
    "--frob",
    "-",
    "--",
    "",
];
const VALUES: &[&str] = &[
    "64M",
    "1G",
    "99999999999G",
    "0",
    "1",
    "-1",
    "18446744073709551616",
    "k",
    "g@0x40080000",
    "g@40080000",
    "@0x1",
    "exits:t.jsonl:mmio,max=1K",
    "exits:",
    "file:x,raw,max=0",
    "stdio",
    "none",
    "file:",
    "unixgram:/t/a,peer=/t/b",
    "unixgram:/t/a,learn,mac=02:00:00:00:00:01",
    "unixgram:/t/a,peer=/t/b,mac=01:00:5e:00:00:01",
    "reboot",
    "exit",
    "fatal",
    "log",
    "a,b.img,ro",
    ",ro",
    "virt",
    "vmapple",
    "none",
    "gicv3",
    "\u{0}",
    "\u{1b}]52;c;x\u{7}",
    "é",
    "4",
];

/// Turn fuzz bytes into an argument vector: mostly known flags with plausible or hostile
/// values, sometimes raw UTF-8 (lossy) tokens.
pub fn argv(data: &[u8]) -> Vec<String> {
    let mut i = Input::new(data);
    let mut out = Vec::new();
    while !i.is_empty() && out.len() < 24 {
        let b = i.u8();
        fn pick<'a>(list: &[&'a str], k: u8) -> Option<&'a str> {
            list.get(usize::from(k) % list.len()).copied()
        }
        let tok = match b % 5 {
            0 | 1 => pick(FLAGS, i.u8()).unwrap_or("").to_string(),
            2 => pick(VALUES, i.u8()).unwrap_or("").to_string(),
            3 => {
                let flag = pick(FLAGS, i.u8()).unwrap_or("");
                let val = pick(VALUES, i.u8()).unwrap_or("");
                format!("{flag}={val}")
            }
            _ => {
                let n = usize::from(i.u8() % 16);
                String::from_utf8_lossy(i.bytes(n)).into_owned()
            }
        };
        out.push(tok);
    }
    out
}

/// The sandbox modes, as `split_flags` reports them (mirrors `macvmm::sandbox::Mode`, which this
/// crate cannot name).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxMode {
    Off,
    Enforce,
    BestEffort,
}

/// What `split_flags` returned on success: the mode, `--sandbox-selftest`, the kept arguments.
pub type Split = (SandboxMode, bool, Vec<String>);

const SANDBOX_TOKENS: &[&str] = &["--sandbox", "--sandbox=best-effort", "--sandbox-selftest"];

/// For each argument, true if it is the value of the flag before it (`value_flags`, given as
/// the next argument). A value is never itself a flag, so `--cmdline --mem 1G` makes `--mem` a
/// value and `1G` not one.
fn value_positions(args: &[String], value_flags: &[&str]) -> Vec<bool> {
    let mut out = Vec::with_capacity(args.len());
    let mut next = false;
    for a in args {
        let is_value = std::mem::take(&mut next);
        out.push(is_value);
        next = !is_value && value_flags.contains(&a.as_str());
    }
    out
}

/// The reference model of `split_flags` (module docs); `None` means "must be `Err`".
fn reference_split(args: &[String], value_flags: &[&str]) -> Option<Split> {
    let mut mode = SandboxMode::Off;
    let mut selftest = false;
    let mut rest = Vec::new();
    for (a, is_value) in args.iter().zip(value_positions(args, value_flags)) {
        let set = match a.as_str() {
            _ if is_value => None,
            "--sandbox" => Some(SandboxMode::Enforce),
            "--sandbox=best-effort" => Some(SandboxMode::BestEffort),
            "--sandbox-selftest" => {
                selftest = true;
                continue;
            }
            s if s.starts_with("--sandbox=") || s.starts_with("--sandbox-selftest=") => {
                return None;
            }
            _ => None,
        };
        match set {
            Some(_) if mode != SandboxMode::Off => return None,
            Some(m) => mode = m,
            None => rest.push(a.clone()),
        }
    }
    if selftest && mode == SandboxMode::Off {
        return None;
    }
    Some((mode, selftest, rest))
}

/// The invariants of the `run` front end (module docs) on the argv `data` generates. `split` is
/// `sandbox::split_flags`, `value_flags` its list of flags that take the next argument, `parse`
/// is `cli::parse_run`.
pub fn check_front_end(
    split: impl Fn(&[String]) -> Result<Split, String>,
    value_flags: &[&str],
    parse: impl Fn(&[String]) -> Result<VmConfig, String>,
    data: &[u8],
) -> crate::Verdict {
    let args = argv(data);
    let expected = reference_split(&args, value_flags);
    let (mode, selftest, rest) = match (split(&args), expected) {
        (Err(_), None) => return Ok(()),
        (Err(e), Some(_)) => return Err(format!("split_flags refused {args:?}: {e}")),
        (Ok(got), None) => {
            return Err(format!(
                "split_flags accepted {args:?} as {got:?}; the reference refuses it"
            ));
        }
        (Ok(got), Some(want)) => {
            if got != want {
                return Err(format!(
                    "split_flags({args:?}) = {got:?}, reference {want:?}"
                ));
            }
            got
        }
    };
    // Restated without the reference, as the plain properties a reader checks: the kept
    // arguments are the input in order, the removed ones are sandbox tokens outside a value
    // position, and a self-test never comes without a sandbox.
    let values = value_positions(&args, value_flags);
    let mut j = 0;
    for (i, a) in args.iter().enumerate() {
        if rest.get(j) == Some(a) {
            j += 1;
        } else if values.get(i) == Some(&true) {
            return Err(format!("split_flags removed the value {a:?} in {args:?}"));
        } else if !SANDBOX_TOKENS.contains(&a.as_str()) {
            return Err(format!("split_flags removed {a:?} from {args:?}"));
        }
    }
    if j != rest.len() {
        return Err(format!(
            "split_flags invented arguments: {rest:?} from {args:?}"
        ));
    }
    if selftest && mode == SandboxMode::Off {
        return Err(format!(
            "--sandbox-selftest accepted without --sandbox: {args:?}"
        ));
    }
    // `parse_run`: no panic (the caller's test harness catches one), plus two properties.
    let Ok(cfg) = parse(&rest) else {
        return Ok(());
    };
    let mut more = rest.clone();
    more.push("--frob".into());
    if parse(&more).is_ok() {
        return Err(format!("parse_run ignored an unknown flag: {more:?}"));
    }
    more.pop();
    more.push("--dry-run".into());
    let mut want = cfg;
    want.dry_run = true;
    match parse(&more) {
        Ok(got) if got == want => Ok(()),
        Ok(got) => Err(format!(
            "appending --dry-run to {rest:?} changed more than dry_run: {want:?} became {got:?}"
        )),
        Err(e) => Err(format!(
            "parse_run accepted {rest:?} but not with --dry-run appended: {e}"
        )),
    }
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let text = String::from_utf8_lossy(data);
    for s in text.split('\n').take(16) {
        if let Ok(spec) = vmm::loader::raw::parse_spec(s) {
            // The reference: the text after the last `@`, `0x`/`0X`, `_` separators dropped.
            let tail = s.rsplit_once('@').map_or("", |(_, a)| a);
            let digits: String = tail
                .get(2..)
                .unwrap_or("")
                .chars()
                .filter(|&c| c != '_')
                .collect();
            if u64::from_str_radix(&digits, 16) != Ok(spec.addr) {
                return Err(format!("--raw {s:?} parsed to {:#x}", spec.addr));
            }
        }
        if let Ok(mac) = vmm::net::parse_mac(s)
            && (mac.first().is_some_and(|b| b & 1 == 1) || mac == [0; 6])
        {
            return Err(format!(
                "mac={s:?} accepted a multicast or zero address {mac:?}"
            ));
        }
        let _ = vmm::trace::TraceCats::parse(s);
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = Vec::new();
    for _ in 0..1 + rng.index(8) {
        match rng.below(3) {
            0 => b.extend_from_slice(rng.pick(VALUES).unwrap_or("").as_bytes()),
            1 => b.extend_from_slice(format!("x@0x{:x}", rng.next_u64()).as_bytes()),
            _ => b.extend_from_slice(b"02:6d:76:01:02:03"),
        }
        b.push(b'\n');
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(21);
        for _ in 0..2_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 512);
            assert_eq!(run(&s), Ok(()));
            assert!(argv(&s).len() <= 24);
        }
    }
}
