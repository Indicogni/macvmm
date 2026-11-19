//! `cargo xtask checkpoint <NN|all> [--ref | --impl DIR] [--keep] [--capture]`: the course's
//! checkpoint harness (PLAN M27; CURRICULUM §3.2, §3.3; architecture §19 items 13 and 14).
//!
//! **Why a harness:** every chapter ends with "it works", and the learner's word for that must
//! be the same as the author's. A checkpoint runs three levels against an implementation tree
//! (the learner's `learner/`, the reference repo, or any other tree):
//!
//! - **L1, contract** ([`run::level1`]): a throwaway crate under `target/checkpoint/NN/` that
//!   depends on `<impl>/crates/vmm` (feature `test-util`) and/or `<impl>/crates/hvf`, with the
//!   chapter's `contract/*.rs` copied in as integration tests. Host only, no HVF. The tests use
//!   only items the lesson names, so a learner's own types satisfy them (the frozen contracts of
//!   architecture §6).
//! - **L2, black-box runs** ([`run::level2`]): `<impl>`'s `macvmm` is built, signed with
//!   `scripts/sign.sh` (only `com.apple.security.hypervisor`), and each `[[run]]` is executed
//!   with a timeout plus a hard kill at timeout + 10 s; serial and trace marker files (the
//!   [`markers`] rules of PLAN §0.3, decision D9) and the exit code decide.
//! - **L3, journal** ([`run::level3`]): for a learner tree, `journal/NN.md` must exist and every
//!   `## Q<n>` must have an answer. It is checked for presence only and never uploaded.
//!
//! The file format is documented for authors in `course/checkpoints/README.md`; this module is
//! its parser ([`load`]) and the command line ([`main`]). Every file it reads is bounded
//! ([`toml_lite::MAX_INPUT`], [`json_lite::MAX_LINE`]), every path inside a checkpoint
//! definition must stay inside its directory, and nothing is ever sent anywhere (no network
//! code exists in this crate).
#![deny(clippy::arithmetic_side_effects)]

pub mod bughunt;
pub mod json_lite;
pub mod markers;
pub mod report;
pub mod run;
pub mod toml_lite;

use std::fs;
use std::path::{Path, PathBuf};

use toml_lite::Table;

/// Where checkpoint definitions live, relative to the repository root.
pub const CHECKPOINTS_DIR: &str = "course/checkpoints";
/// Where `--capture` writes raw transcripts, relative to the repository root.
pub const CAPTURES_DIR: &str = "course/captures";
/// The longest checkpoint run allowed (seconds); a definition asking for more is an error.
pub const MAX_TIMEOUT_S: u64 = 600;
/// The most `[[run]]` entries in one checkpoint.
pub const MAX_RUNS: usize = 32;

/// How a run's `macvmm` copy is signed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sign {
    /// `scripts/sign.sh`: the hypervisor entitlement and the hardened runtime.
    Hypervisor,
    /// `scripts/sign.sh --no-entitlements`: the HV_DENIED negative test (ch01).
    NoEntitlements,
}

/// One interaction step of a run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Wait until stdout contains this text.
    Wait(String),
    /// Write these bytes to stdin.
    Send(String),
    /// Sleep this many milliseconds.
    Sleep(u64),
    /// Send this signal (`TERM`, `INT`, `USR1`) to the child.
    Signal(String),
}

/// What a `[[run]]` executes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exec {
    /// `macvmm <args>`.
    Macvmm(Vec<String>),
    /// An arbitrary command (argv), for the scripts of ch00 and the pty test of ch09.
    Command(Vec<String>),
    /// An HVF contract test from `contract/`, run in the L1 crate with `--features hvf-tests`.
    ContractHvf(String),
}

/// One `[[run]]` (L2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSpec {
    pub name: String,
    pub guest: Option<String>,
    pub exec: Exec,
    /// Working directory of a `command`: the implementation (default) or the repository.
    pub cwd_repo: bool,
    pub sign: Sign,
    pub steps: Vec<Step>,
    pub timeout_s: u64,
    pub expect_exit_code: i32,
    /// Marker file over stdout/stderr, relative to the checkpoint directory.
    pub serial: Option<String>,
    /// Marker file over the trace, relative to the checkpoint directory.
    pub trace: Option<String>,
    /// The trace file the run writes, relative to `{out}` (inferred from `--trace exits:`).
    pub trace_file: Option<String>,
    /// Count trace lines containing this substring …
    pub count_trace: Option<String>,
    /// … which must equal the stdout byte count plus this.
    pub count_equals_stdout_bytes_plus: Option<i64>,
    /// The `stats: host cpu … (N%)` line must report less than this.
    pub max_host_cpu_percent: Option<u64>,
    /// Skip (INFO, not FAIL) when this tool is not on `PATH`.
    pub requires_tool: Option<String>,
    /// Bytes written to `{out}/blob.bin` before the run (`{blob_raw}`).
    pub blob: Option<Vec<u8>>,
    /// Every stdout line starting with this prefix must be identical (at least two).
    pub equal_lines: Option<String>,
}

/// `[contract]` (L1).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Contract {
    /// Which implementation crates the throwaway crate depends on (`vmm`, `hvf`).
    pub crates: Vec<String>,
    /// Test files relative to the checkpoint directory.
    pub tests: Vec<String>,
}

/// `[journal]` (L3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Journal {
    pub file: String,
    pub questions: usize,
    pub predict: bool,
}

/// A loaded `checkpoint.toml`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    pub id: String,
    pub slug: String,
    pub requires: Vec<String>,
    pub contract: Option<Contract>,
    pub runs: Vec<RunSpec>,
    pub journal: Option<Journal>,
    /// The hint ladder (`learner hint NN 1..4`): conceptual, spec, pseudocode, anchor.
    pub hints: Vec<String>,
    /// The checkpoint directory (absolute).
    pub dir: PathBuf,
}

/// A two-digit chapter id `00`..`27`.
pub fn valid_id(id: &str) -> bool {
    id.len() == 2
        && id.bytes().all(|b| b.is_ascii_digit())
        && id.parse::<u8>().is_ok_and(|n| n <= 27)
}

/// A name usable as a run or guest name: `^[a-z0-9][a-z0-9-]*$`, at most 64 bytes.
pub fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.len() <= 64
        && n.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && n.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A relative path that stays inside its base: no `..`, not absolute, no empty or `.`
/// components, only `[A-Za-z0-9._-]` in each component.
pub fn safe_rel(p: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && p.split('/').all(|c| {
            !c.is_empty()
                && c != "."
                && c != ".."
                && c.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

fn need_safe(dir: &Path, rel: &str, what: &str) -> Result<String, String> {
    if !safe_rel(rel) {
        return Err(format!("{what} path {rel:?} must be relative and stay inside the checkpoint"));
    }
    let p = dir.join(rel);
    if !p.is_file() {
        return Err(format!("{what} file {rel:?} does not exist in {}", dir.display()));
    }
    Ok(rel.to_owned())
}

/// Parse one step string: `wait:TEXT`, `send:TEXT`, `sleep:MS`, `signal:NAME`.
pub fn parse_step(s: &str) -> Result<Step, String> {
    let (kind, arg) = s
        .split_once(':')
        .ok_or_else(|| format!("step {s:?}: expected kind:argument"))?;
    match kind {
        "wait" if !arg.is_empty() => Ok(Step::Wait(arg.to_owned())),
        "send" if !arg.is_empty() => Ok(Step::Send(arg.to_owned())),
        "sleep" => arg
            .parse::<u64>()
            .ok()
            .filter(|&ms| ms <= 60_000)
            .map(Step::Sleep)
            .ok_or_else(|| format!("step {s:?}: sleep takes 0..=60000 ms")),
        "signal" if matches!(arg, "TERM" | "INT" | "USR1" | "HUP") => {
            Ok(Step::Signal(arg.to_owned()))
        }
        _ => Err(format!("step {s:?}: unknown or empty (wait|send|sleep|signal)")),
    }
}

/// The trace file named by a `--trace exits:{out}/FILE[:CATS][,max=…]` argument.
fn infer_trace_file(args: &[String]) -> Option<String> {
    let i = args.iter().position(|a| a == "--trace")?;
    let spec = args.get(i.checked_add(1)?)?;
    let rest = spec.strip_prefix("exits:{out}/")?;
    let end = rest.find([':', ',']).unwrap_or(rest.len());
    rest.get(..end).map(str::to_owned)
}

/// The `--timeout N` in a macvmm argument list.
fn arg_timeout(args: &[String]) -> Option<u64> {
    let i = args.iter().position(|a| a == "--timeout")?;
    args.get(i.checked_add(1)?)?.parse().ok()
}

fn parse_hex(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() || s.len() % 2 != 0 || s.len() > 8192 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i.checked_add(2)?)?, 16).ok())
        .collect()
}

const RUN_KEYS: &[&str] = &[
    "name",
    "guest",
    "args",
    "command",
    "contract_hvf",
    "cwd",
    "sign",
    "steps",
    "timeout",
    "expect_exit_code",
    "serial",
    "trace",
    "trace_file",
    "count_trace",
    "count_equals_stdout_bytes_plus",
    "max_host_cpu_percent",
    "requires_tool",
    "blob_hex",
    "equal_lines",
];

fn parse_run(t: &Table, dir: &Path) -> Result<RunSpec, String> {
    let unknown = t.unknown_keys(RUN_KEYS);
    if !unknown.is_empty() {
        return Err(format!("unknown key(s) {unknown:?}"));
    }
    let name = t.str("name")?.ok_or("a run needs `name`")?.to_owned();
    if !valid_name(&name) {
        return Err(format!("run name {name:?} must match ^[a-z0-9][a-z0-9-]*$"));
    }
    let ctx = |e: String| format!("run {name:?}: {e}");
    let guest = t.str("guest").map_err(ctx)?.map(str::to_owned);
    if let Some(g) = &guest
        && !valid_name(g)
    {
        return Err(ctx(format!("guest name {g:?} is not valid")));
    }
    let args = t.strs("args").map_err(ctx)?;
    let command = t.strs("command").map_err(ctx)?;
    let contract_hvf = t.str("contract_hvf").map_err(ctx)?;
    let exec = match (args, command, contract_hvf) {
        (Some(a), None, None) => Exec::Macvmm(a.to_vec()),
        (None, Some(c), None) if !c.is_empty() => Exec::Command(c.to_vec()),
        (None, None, Some(f)) => {
            let f = need_safe(dir, f, "contract_hvf").map_err(ctx)?;
            if !f.ends_with(".rs") {
                return Err(ctx("contract_hvf must name a .rs file".into()));
            }
            Exec::ContractHvf(f)
        }
        _ => {
            return Err(ctx(
                "exactly one of `args`, `command` (non-empty) or `contract_hvf` is required".into(),
            ));
        }
    };
    let cwd_repo = match t.str("cwd").map_err(ctx)? {
        None | Some("impl") => false,
        Some("repo") => true,
        Some(o) => return Err(ctx(format!("cwd must be \"impl\" or \"repo\", not {o:?}"))),
    };
    let sign = match t.str("sign").map_err(ctx)? {
        None | Some("hypervisor") => Sign::Hypervisor,
        Some("no-entitlements") => Sign::NoEntitlements,
        Some(o) => return Err(ctx(format!("sign must be hypervisor or no-entitlements, not {o:?}"))),
    };
    let steps = t
        .strs("steps")
        .map_err(ctx)?
        .unwrap_or(&[])
        .iter()
        .map(|s| parse_step(s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(ctx)?;
    let from_args = match &exec {
        Exec::Macvmm(a) => arg_timeout(a),
        _ => None,
    };
    let timeout_s = match t.int("timeout").map_err(ctx)? {
        Some(v) => u64::try_from(v).map_err(|_| ctx("timeout must be positive".into()))?,
        None => from_args.unwrap_or(30),
    };
    if timeout_s == 0 || timeout_s > MAX_TIMEOUT_S {
        return Err(ctx(format!("timeout must be 1..={MAX_TIMEOUT_S} s")));
    }
    let expect_exit_code = t
        .int("expect_exit_code")
        .map_err(ctx)?
        .ok_or_else(|| ctx("`expect_exit_code` is required (AS10: every run asserts it)".into()))?;
    let expect_exit_code = i32::try_from(expect_exit_code)
        .ok()
        .filter(|c| (0..=255).contains(c))
        .ok_or_else(|| ctx("expect_exit_code must be 0..=255".into()))?;
    let serial = t
        .str("serial")
        .map_err(ctx)?
        .map(|s| need_safe(dir, s, "serial"))
        .transpose()
        .map_err(ctx)?;
    let trace = t
        .str("trace")
        .map_err(ctx)?
        .map(|s| need_safe(dir, s, "trace"))
        .transpose()
        .map_err(ctx)?;
    let trace_file = match t.str("trace_file").map_err(ctx)? {
        Some(f) if safe_rel(f) => Some(f.to_owned()),
        Some(f) => return Err(ctx(format!("trace_file {f:?} must be a plain relative name"))),
        None => match &exec {
            Exec::Macvmm(a) => infer_trace_file(a),
            _ => None,
        },
    };
    let count_trace = t.str("count_trace").map_err(ctx)?.map(str::to_owned);
    let count_equals_stdout_bytes_plus = t.int("count_equals_stdout_bytes_plus").map_err(ctx)?;
    if (trace.is_some() || count_trace.is_some()) && trace_file.is_none() {
        return Err(ctx(
            "a trace check needs `--trace exits:{out}/FILE` in args or `trace_file`".into(),
        ));
    }
    if count_trace.is_some() != count_equals_stdout_bytes_plus.is_some() {
        return Err(ctx(
            "count_trace and count_equals_stdout_bytes_plus go together".into(),
        ));
    }
    let max_host_cpu_percent = t
        .int("max_host_cpu_percent")
        .map_err(ctx)?
        .map(|v| u64::try_from(v).map_err(|_| ctx("max_host_cpu_percent must be positive".into())))
        .transpose()?;
    let requires_tool = t.str("requires_tool").map_err(ctx)?.map(str::to_owned);
    if let Some(tool) = &requires_tool
        && !valid_name(tool)
    {
        return Err(ctx(format!("requires_tool {tool:?} is not a plain tool name")));
    }
    let blob = t
        .str("blob_hex")
        .map_err(ctx)?
        .map(|h| parse_hex(h).ok_or_else(|| ctx(format!("blob_hex {h:?} is not even-length hex"))))
        .transpose()?;
    let equal_lines = t.str("equal_lines").map_err(ctx)?.map(str::to_owned);
    if guest.is_none() {
        let text = match &exec {
            Exec::Macvmm(a) | Exec::Command(a) => a.join(" "),
            Exec::ContractHvf(_) => String::new(),
        };
        if text.contains("{guest") {
            return Err(ctx("uses {guest…} but names no `guest`".into()));
        }
    }
    Ok(RunSpec {
        name,
        guest,
        exec,
        cwd_repo,
        sign,
        steps,
        timeout_s,
        expect_exit_code,
        serial,
        trace,
        trace_file,
        count_trace,
        count_equals_stdout_bytes_plus,
        max_host_cpu_percent,
        requires_tool,
        blob,
        equal_lines,
    })
}

/// Load and validate `course/checkpoints/<id>/checkpoint.toml`.
pub fn load(repo: &Path, id: &str) -> Result<Checkpoint, String> {
    if !valid_id(id) {
        return Err(format!("checkpoint id {id:?} must be two digits 00..27"));
    }
    let dir = repo.join(CHECKPOINTS_DIR).join(id);
    let path = dir.join("checkpoint.toml");
    let text = read_capped(&path, toml_lite::MAX_INPUT)?;
    let doc = toml_lite::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let ctx = |e: String| format!("{}: {e}", path.display());
    let unknown = doc.root.unknown_keys(&["id", "slug", "requires"]);
    if !unknown.is_empty() {
        return Err(ctx(format!("unknown key(s) {unknown:?}")));
    }
    for name in doc.tables.keys() {
        if !matches!(name.as_str(), "contract" | "journal" | "hints") {
            return Err(ctx(format!("unknown table [{name}]")));
        }
    }
    for name in doc.arrays.keys() {
        if name != "run" {
            return Err(ctx(format!("unknown array of tables [[{name}]]")));
        }
    }
    let file_id = doc.root.str("id").map_err(ctx)?.ok_or_else(|| ctx("`id` is required".into()))?;
    if file_id != id {
        return Err(ctx(format!("id {file_id:?} does not match its directory {id:?}")));
    }
    let slug = doc.root.str("slug").map_err(ctx)?.unwrap_or("").to_owned();
    let requires = doc.root.strs("requires").map_err(ctx)?.unwrap_or(&[]).to_vec();
    for r in &requires {
        if !valid_id(r) || r.as_str() >= id {
            return Err(ctx(format!("requires {r:?} must be an earlier checkpoint")));
        }
    }
    let contract = match doc.tables.get("contract") {
        None => None,
        Some(t) => {
            let unknown = t.unknown_keys(&["crate", "crates", "tests"]);
            if !unknown.is_empty() {
                return Err(ctx(format!("[contract]: unknown key(s) {unknown:?}")));
            }
            let mut crates: Vec<String> = t.strs("crates").map_err(ctx)?.unwrap_or(&[]).to_vec();
            if let Some(c) = t.str("crate").map_err(ctx)? {
                crates.push(c.to_owned());
            }
            if crates.is_empty() {
                crates.push("vmm".into());
            }
            for c in &crates {
                if !matches!(c.as_str(), "vmm" | "hvf") {
                    return Err(ctx(format!("[contract] crate {c:?} must be vmm or hvf")));
                }
            }
            let tests = t
                .strs("tests")
                .map_err(ctx)?
                .unwrap_or(&[])
                .iter()
                .map(|f| need_safe(&dir, f, "contract test"))
                .collect::<Result<Vec<_>, _>>()
                .map_err(ctx)?;
            if tests.iter().any(|f| !f.ends_with(".rs")) {
                return Err(ctx("contract tests must be .rs files".into()));
            }
            Some(Contract { crates, tests })
        }
    };
    let runs_t = doc.arrays.get("run").map(Vec::as_slice).unwrap_or(&[]);
    if runs_t.len() > MAX_RUNS {
        return Err(ctx(format!("more than {MAX_RUNS} runs")));
    }
    let mut runs = Vec::new();
    for t in runs_t {
        let r = parse_run(t, &dir).map_err(|e| format!("{}:{}: {e}", path.display(), t.line))?;
        if runs.iter().any(|o: &RunSpec| o.name == r.name) {
            return Err(ctx(format!("two runs named {:?}", r.name)));
        }
        runs.push(r);
    }
    let journal = match doc.tables.get("journal") {
        None => None,
        Some(t) => {
            let unknown = t.unknown_keys(&["file", "questions", "predict"]);
            if !unknown.is_empty() {
                return Err(ctx(format!("[journal]: unknown key(s) {unknown:?}")));
            }
            let file = t
                .str("file")
                .map_err(ctx)?
                .map_or_else(|| format!("journal/{id}.md"), str::to_owned);
            if !safe_rel(&file) {
                return Err(ctx(format!("journal file {file:?} must be relative")));
            }
            let questions = t.int("questions").map_err(ctx)?.unwrap_or(3);
            let questions = usize::try_from(questions)
                .ok()
                .filter(|q| (1..=10).contains(q))
                .ok_or_else(|| ctx("journal questions must be 1..=10".into()))?;
            let predict = t.bool("predict").map_err(ctx)?.unwrap_or(false);
            Some(Journal {
                file,
                questions,
                predict,
            })
        }
    };
    let mut hints = Vec::new();
    if let Some(t) = doc.tables.get("hints") {
        let names = ["conceptual", "spec", "pseudocode", "anchor"];
        let unknown = t.unknown_keys(&names);
        if !unknown.is_empty() {
            return Err(ctx(format!("[hints]: unknown key(s) {unknown:?}")));
        }
        for n in names {
            hints.push(t.str(n).map_err(ctx)?.unwrap_or("").to_owned());
        }
    }
    Ok(Checkpoint {
        id: id.to_owned(),
        slug,
        requires,
        contract,
        runs,
        journal,
        hints,
        dir,
    })
}

/// Every checkpoint id that has a definition, in order.
pub fn all_ids(repo: &Path) -> Vec<String> {
    (0u8..=27)
        .map(|n| format!("{n:02}"))
        .filter(|id| repo.join(CHECKPOINTS_DIR).join(id).join("checkpoint.toml").is_file())
        .collect()
}

/// Read a regular file (never through a symlink) of at most `cap` bytes.
pub fn read_capped(path: &Path, cap: usize) -> Result<String, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.file_type().is_file() {
        return Err(format!("{}: not a regular file", path.display()));
    }
    if meta.len() > u64::try_from(cap).unwrap_or(u64::MAX) {
        return Err(format!(
            "{}: {} bytes is over the {cap}-byte cap",
            path.display(),
            meta.len()
        ));
    }
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Which tree a command targets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    Reference,
    Impl(PathBuf),
}

/// Options of `cargo xtask checkpoint`.
#[derive(Clone, Debug)]
pub struct Options {
    pub ids: Vec<String>,
    pub target: Option<Target>,
    pub keep: bool,
    pub capture: bool,
}

pub const USAGE: &str =
    "usage: cargo xtask checkpoint <NN|all> [--ref | --impl DIR] [--keep] [--capture]";

/// Parse the arguments after `checkpoint`.
pub fn parse_args(repo: &Path, args: &[String]) -> Result<Options, String> {
    let mut which: Option<String> = None;
    let mut target = None;
    let mut keep = false;
    let mut capture = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--ref" if target.is_none() => target = Some(Target::Reference),
            "--impl" if target.is_none() => {
                let d = it.next().ok_or("--impl needs a directory")?;
                target = Some(Target::Impl(PathBuf::from(d)));
            }
            "--ref" | "--impl" => return Err("give at most one of --ref and --impl".into()),
            "--keep" => keep = true,
            "--capture" => capture = true,
            s if !s.starts_with('-') && which.is_none() => which = Some(s.to_owned()),
            other => return Err(format!("unexpected argument {other:?}")),
        }
    }
    let which = which.ok_or("which checkpoint? (NN or all)")?;
    let ids = if which == "all" {
        all_ids(repo)
    } else if valid_id(&which) {
        vec![which]
    } else {
        return Err(format!("checkpoint {which:?} must be two digits or `all`"));
    };
    if ids.is_empty() {
        return Err("no checkpoint definitions found".into());
    }
    if capture && target.as_ref().is_some_and(|t| *t != Target::Reference) {
        return Err("--capture records the reference only: use it with --ref".into());
    }
    Ok(Options {
        ids,
        target,
        keep,
        capture,
    })
}

/// `cargo xtask checkpoint …`: returns the process exit code (0 pass, 1 fail, 2 usage).
pub fn main(repo: &Path, args: &[String]) -> u8 {
    let opts = match parse_args(repo, args) {
        Ok(o) => o,
        Err(e) => {
            report::err(&format!("checkpoint: {e}\n{USAGE}"));
            return 2;
        }
    };
    run::run_all(repo, &opts)
}
