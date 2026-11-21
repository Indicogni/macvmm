//! Running a checkpoint: L1 contract tests, L2 black-box runs, L3 journal (CURRICULUM §3.3).
//! The printed labels are learner words, not level numbers: see [`report::CONTRACT`].
//!
//! **Why the harness builds and signs the implementation itself:** a checkpoint must judge the
//! learner's *own* VMM exactly as a user would meet it: the binary built from their tree, signed
//! with the one hypervisor entitlement (SIGN-1), run as a child process with a timeout and a
//! hard kill (PLAN §0.3), and judged only by what the outside can see (exit code, stdout,
//! stderr, the trace file). That is the same discipline as the e2e suite (AS10): a guest can
//! print any marker, so every run asserts the exit code, and VMM verdicts are `[stderr]`
//! markers.
//!
//! **Where things go.** Everything the harness writes lives under the cargo target dir
//! (`$CARGO_TARGET_DIR`, default `<repo>/target`), which is gitignored and the only place
//! `scripts/sign.sh` signs (SIGN-4):
//!
//! - `target/checkpoint/NN/<key>/crate/`: the throwaway L1 crate (PLAN M27 design note L1);
//! - `target/checkpoint/build/<key>/`: `CARGO_TARGET_DIR` for an `--impl` tree's build;
//! - `target/checkpoint/l1/<key>/`: `CARGO_TARGET_DIR` of the L1 crates, shared by all
//!   checkpoints of one implementation so `vmm` compiles once;
//! - `target/checkpoint/bin/<pid>/`: private signed copies of `macvmm` (a concurrent
//!   `cargo build` cannot relink them between signing and running);
//! - `target/checkpoint/NN/<key>/out/<pid>/<run>/`: each run's `{out}` directory.
//!
//! `<key>` is a hash of the implementation tree's canonical path, so two invocations at once
//! (a `bughunt` copy in one terminal, the learner's tree in another) never share a generated
//! crate or an output directory. Two invocations on the *same* tree share the L1 crate, which
//! is why it is synced in place (each file written only when it changed, through a private
//! temporary name and a rename) instead of being deleted and recreated; their `{out}`
//! directories are apart by pid.
//!
//! Nothing here opens a socket, and the only programs started are `cargo`, the repository's
//! own scripts, the implementation's `macvmm`, and the argv a checkpoint definition names.
#![deny(clippy::arithmetic_side_effects)]

use super::markers;
use super::report::{self, Out, Status};
use super::{Checkpoint, Exec, Options, RunSpec, Sign, Step, Target, json_lite, toml_lite};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The guest load address of `{guest_raw}` and `{blob_raw}` (`TEST_GUEST_BASE`, PLAN §1):
/// chapters before 13 load flat binaries because learners write the ELF loader in ch13
/// (CURRICULUM §3.3 step 2).
pub const RAW_LOAD_ADDR: &str = "0x40080000";
/// The failure text of [`Proc::pipes_held`].
const PIPES_HELD: &str = "output pipe still held by a subprocess after the run ended \
     (it was killed; output may be incomplete)";
/// The hard kill comes this long after a run's own timeout (PLAN §0.3).
pub const HARD_KILL_GRACE: Duration = Duration::from_secs(10);
/// The most bytes kept of one stream of a child (the rest is drained and dropped).
pub const STREAM_CAP: usize = 16 * 1024 * 1024;
/// The largest trace file read back.
pub const TRACE_CAP: usize = 32 * 1024 * 1024;
/// The largest journal file read.
pub const JOURNAL_CAP: usize = 64 * 1024;
/// The largest capture written (per stream).
pub const CAPTURE_CAP: usize = 256 * 1024;

/// How long [`run_child`] waits for the output pipes to close once the child is gone, before
/// killing its process group, and again after that kill.
pub const PIPE_GRACE: Duration = Duration::from_secs(2);

/// A finished child.
#[derive(Debug, Default)]
pub struct Proc {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub wall: Duration,
    pub killed: bool,
    /// A subprocess of the child still held stdout or stderr open after the child was gone
    /// (and after its process group was killed): the output may be incomplete. A FAIL.
    pub pipes_held: bool,
}

/// The binaries one invocation built and signed.
#[derive(Clone, Debug)]
struct Built {
    macvmm: PathBuf,
    noent: PathBuf,
}

/// Everything one `cargo xtask checkpoint` invocation shares across checkpoints.
pub struct Env {
    pub repo: PathBuf,
    pub repo_target: PathBuf,
    pub impl_dir: PathBuf,
    /// The hash of `impl_dir` naming this tree's private directories (see the module docs).
    pub key: String,
    pub reference: bool,
    /// The tree has a `.progress.toml`: L3 is enforced and passes are recorded.
    pub learner: bool,
    /// `CARGO_TARGET_DIR` for building the implementation (`None`: the reference's own).
    pub impl_target: Option<PathBuf>,
    pub l1_target: PathBuf,
    pub keep: bool,
    pub capture: bool,
    pub borrowed: Vec<String>,
    built: Option<Result<Built, String>>,
    guests: Option<Result<PathBuf, String>>,
}

/// FNV-1a, for short directory keys derived from a path.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// The cargo target dir the repository's scripts use (`scripts/lib/common.sh` `target_dir`).
pub fn repo_target(repo: &Path) -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(t) if Path::new(&t).is_absolute() => PathBuf::from(t),
        Some(t) => repo.join(t),
        None => repo.join("target"),
    }
}

/// `mkdir -p` with mode 0700 for the directories created.
pub fn mkdir_private(p: &Path) -> Result<(), String> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(p)
        .map_err(|e| format!("mkdir {}: {e}", p.display()))
}

/// Remove `p` if it exists and create it empty (0700). `p` must be under `under`.
pub fn fresh_dir(p: &Path, under: &Path) -> Result<(), String> {
    if !p.starts_with(under) {
        return Err(format!(
            "internal: refusing to clear {} outside {}",
            p.display(),
            under.display()
        ));
    }
    match fs::symlink_metadata(p) {
        Ok(m) if m.file_type().is_symlink() => {
            return Err(format!(
                "{} is a symlink; refusing to clear it",
                p.display()
            ));
        }
        Ok(_) => fs::remove_dir_all(p).map_err(|e| format!("rm {}: {e}", p.display()))?,
        Err(_) => {}
    }
    mkdir_private(p)
}

impl Env {
    /// Resolve the target tree (`--ref`, `--impl DIR`, or `./learner` if it exists).
    pub fn new(repo: &Path, opts: &Options) -> Result<Env, String> {
        let repo = repo
            .canonicalize()
            .map_err(|e| format!("{}: {e}", repo.display()))?;
        let target = match &opts.target {
            Some(t) => t.clone(),
            None if repo.join("learner/Cargo.toml").is_file() => Target::Impl(repo.join("learner")),
            None => Target::Reference,
        };
        let (impl_dir, reference) = match target {
            Target::Reference => (repo.clone(), true),
            Target::Impl(d) => {
                let d = d
                    .canonicalize()
                    .map_err(|e| format!("--impl {}: {e}", d.display()))?;
                (d.clone(), d == repo)
            }
        };
        if opts.capture && !reference {
            return Err(format!(
                "--capture records the reference only, not {}: use it with --ref",
                impl_dir.display()
            ));
        }
        if !impl_dir.join("Cargo.toml").is_file() {
            return Err(format!(
                "{} has no Cargo.toml: not an implementation tree",
                impl_dir.display()
            ));
        }
        let repo_target = repo_target(&repo);
        let key = format!("{:016x}", fnv1a(impl_dir.as_os_str().as_encoded_bytes()));
        let ck = repo_target.join("checkpoint");
        let impl_target = if reference {
            None
        } else {
            Some(ck.join("build").join(&key))
        };
        let progress = impl_dir.join(".progress.toml");
        let learner = !reference && progress.is_file();
        let borrowed = if progress.is_file() {
            crate::learner::Progress::load(&progress)
                .map(|p| p.borrowed)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Env {
            l1_target: ck.join("l1").join(&key),
            key,
            repo,
            repo_target,
            impl_dir,
            reference,
            learner,
            impl_target,
            keep: opts.keep,
            capture: opts.capture,
            borrowed,
            built: None,
            guests: None,
        })
    }

    fn ck_dir(&self) -> PathBuf {
        self.repo_target.join("checkpoint")
    }

    /// `target/checkpoint/NN/<key>/`: checkpoint `id`'s directory for this tree.
    fn cp_dir(&self, id: &str) -> PathBuf {
        self.ck_dir().join(id).join(&self.key)
    }

    /// `target/checkpoint/NN/<key>/out/<pid>/`: this invocation's run outputs of `id`.
    fn out_root(&self, id: &str) -> PathBuf {
        self.cp_dir(id)
            .join("out")
            .join(std::process::id().to_string())
    }

    /// Build the implementation's `macvmm` once, copy it to a private directory and sign two
    /// copies: one with the hypervisor entitlement, one with none (ch01's HV_DENIED run).
    fn built(&mut self) -> Result<Built, String> {
        if let Some(b) = &self.built {
            return b.clone();
        }
        let r = self.build_and_sign();
        self.built = Some(r.clone());
        r
    }

    fn build_and_sign(&self) -> Result<Built, String> {
        let mut cmd = Command::new("cargo");
        cmd.current_dir(&self.impl_dir)
            .args(["build", "--quiet", "-p", "macvmm"]);
        if self.reference {
            cmd.arg("--locked");
        }
        let out_dir = match &self.impl_target {
            Some(t) => {
                cmd.env("CARGO_TARGET_DIR", t);
                t.clone()
            }
            None => self.repo_target.clone(),
        };
        let p = capture_output(&mut cmd)?;
        if p.code != Some(0) {
            return Err(format!(
                "`cargo build -p macvmm` in {} failed:\n{}",
                self.impl_dir.display(),
                sanitized_tail(&p.stderr, 25)
            ));
        }
        let bin = out_dir.join("debug/macvmm");
        let priv_dir = self
            .ck_dir()
            .join("bin")
            .join(std::process::id().to_string());
        fresh_dir(&priv_dir, &self.ck_dir())?;
        let macvmm = priv_dir.join("macvmm");
        let noent = priv_dir.join("macvmm-no-entitlements");
        for (dst, flag) in [(&macvmm, None), (&noent, Some("--no-entitlements"))] {
            fs::copy(&bin, dst).map_err(|e| format!("copy {}: {e}", bin.display()))?;
            let mut s = Command::new(self.repo.join("scripts/sign.sh"));
            s.current_dir(&self.repo);
            if let Some(f) = flag {
                s.arg(f);
            }
            s.arg(dst);
            let p = capture_output(&mut s)?;
            if p.code != Some(0) {
                return Err(format!(
                    "scripts/sign.sh {} failed:\n{}\n{}",
                    dst.display(),
                    sanitized_tail(&p.stdout, 25),
                    sanitized_tail(&p.stderr, 25)
                ));
            }
        }
        Ok(Built { macvmm, noent })
    }

    /// Build the shared bare-metal guests once (`scripts/build-guests.sh`).
    fn guests(&mut self) -> Result<PathBuf, String> {
        if let Some(g) = &self.guests {
            return g.clone();
        }
        let mut cmd = Command::new(self.repo.join("scripts/build-guests.sh"));
        cmd.current_dir(&self.repo);
        let r = capture_output(&mut cmd).and_then(|p| {
            if p.code == Some(0) {
                Ok(self.repo_target.join("guests/aarch64-unknown-none/release"))
            } else {
                Err(format!(
                    "scripts/build-guests.sh failed:\n{}",
                    sanitized_tail(&p.stderr, 25)
                ))
            }
        });
        self.guests = Some(r.clone());
        r
    }
}

/// Run a command to completion, capturing both streams (builds and signing only).
pub fn capture_output(cmd: &mut Command) -> Result<Proc, String> {
    let start = Instant::now();
    let o = cmd
        .env_remove("MACVMM_LOG")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot start {:?}: {e}", cmd.get_program()))?;
    Ok(Proc {
        code: o.status.code(),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        wall: start.elapsed(),
        killed: false,
        pipes_held: false,
    })
}

/// The last `n` lines of `s`.
pub fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let from = lines.len().saturating_sub(n);
    lines.get(from..).unwrap_or(&[]).join("\n")
}

/// The last `n` lines of output of the code under test, each through [`report::sanitize`]
/// (controls made visible, long lines cut).
fn sanitized_tail(s: &str, n: usize) -> String {
    tail_lines(s, n)
        .lines()
        .map(report::sanitize)
        .collect::<Vec<_>>()
        .join("\n")
}

fn reader(mut r: impl Read + Send + 'static) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let b = Arc::clone(&buf);
    let t = std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut v) = b.lock()
                        && v.len() < STREAM_CAP
                    {
                        let room = STREAM_CAP.saturating_sub(v.len());
                        v.extend_from_slice(chunk.get(..n.min(room)).unwrap_or(&[]));
                    }
                }
            }
        }
    });
    (buf, t)
}

fn text_of(b: &Arc<Mutex<Vec<u8>>>) -> String {
    b.lock()
        .map(|v| String::from_utf8_lossy(&v).into_owned())
        .unwrap_or_default()
}

/// One interaction step of [`run_child`].
fn do_step(
    step: &Step,
    child: &mut std::process::Child,
    stdin: Option<&mut std::process::ChildStdin>,
    out: &Arc<Mutex<Vec<u8>>>,
    deadline: Instant,
) {
    match step {
        Step::Wait(m) => {
            while !text_of(out).contains(m.as_str()) {
                if Instant::now() > deadline || child.try_wait().ok().flatten().is_some() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        Step::Send(s) => {
            if let Some(w) = stdin {
                let _ = w.write_all(s.as_bytes());
                let _ = w.flush();
            }
        }
        Step::Sleep(ms) => std::thread::sleep(Duration::from_millis(*ms)),
        Step::Signal(sig) => {
            // `kill(1)`: this crate has no libc; the name was validated at load time.
            let _ = Command::new("/bin/kill")
                .args(["-s", sig.as_str(), &child.id().to_string()])
                .status();
        }
    }
}

/// SIGKILL every process in the process group `pgid` (`kill(1)`: this crate has no libc).
///
/// **Why a whole group.** Many runs are wrappers (`cargo run` → `sign-and-run.sh` → `macvmm`,
/// `/bin/sh -c`, `script(1)`, `cargo test` → the test binary). Killing only the direct child
/// would leave the real program running, still holding the inherited stdout and stderr pipes,
/// and the harness would wait on those pipes forever. So [`run_child`] makes the child lead its
/// own process group (`process_group(0)`) and the hard kill signals the whole group while the
/// child is still unreaped (its pid, which is the group id, cannot be reused yet).
fn kill_group(pgid: u32) {
    let _ = Command::new("/bin/kill")
        .args(["-s", "KILL", "--", &format!("-{pgid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// After the child is gone: wait for both output pipes to close. If something the child started
/// still holds one after [`PIPE_GRACE`], kill the group (a group that still has a member keeps
/// its id: POSIX "process group lifetime") and wait once more; then stop waiting and leave the
/// reader threads blocked (they end with this process). Returns whether the pipes closed.
fn drain_pipes(
    pgid: u32,
    out_t: std::thread::JoinHandle<()>,
    err_t: std::thread::JoinHandle<()>,
) -> bool {
    let mut done = readers_done(&[&out_t, &err_t], PIPE_GRACE);
    if !done {
        kill_group(pgid);
        done = readers_done(&[&out_t, &err_t], PIPE_GRACE);
    }
    if done {
        let _ = out_t.join();
        let _ = err_t.join();
    }
    done
}

/// Wait until both reader threads are done (their pipes reached EOF) or `limit` passes.
fn readers_done(threads: &[&std::thread::JoinHandle<()>], limit: Duration) -> bool {
    let until = Instant::now().checked_add(limit);
    loop {
        if threads.iter().all(|t| t.is_finished()) {
            return true;
        }
        if until.is_none_or(|u| Instant::now() > u) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ANCHOR: checkpoint_l2_run
/// Run one child the way PLAN §0.3 prescribes: piped stdio, the interaction `steps` in order,
/// and a hard kill of its whole process group at `limit` + [`HARD_KILL_GRACE`] ([`kill_group`],
/// [`drain_pipes`]). A `wait:` step gives up at the deadline or when the child exits.
/// `close_stdin` sends EOF after the last step (a `macvmm` run); `script(1)` keeps stdin open.
pub fn run_child(
    mut cmd: Command,
    steps: &[Step],
    limit: Duration,
    close_stdin: bool,
) -> Result<Proc, String> {
    let start = Instant::now();
    let deadline = start
        .checked_add(limit)
        .and_then(|t| t.checked_add(HARD_KILL_GRACE))
        .ok_or("timeout out of range")?;
    let mut child = cmd
        .env_remove("MACVMM_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start {:?}: {e}", cmd.get_program()))?;
    let (out, out_t) = reader(child.stdout.take().ok_or("no stdout pipe")?);
    let (err, err_t) = reader(child.stderr.take().ok_or("no stderr pipe")?);
    let mut stdin = child.stdin.take();
    for step in steps {
        do_step(step, &mut child, stdin.as_mut(), &out, deadline);
    }
    if close_stdin {
        drop(stdin.take());
    }
    let mut killed = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(format!("wait: {e}")),
        }
        if Instant::now() > deadline {
            kill_group(child.id()); // before reaping: the group id cannot be reused yet
            let _ = child.kill();
            killed = true;
            break child.wait().map_err(|e| format!("wait after kill: {e}"))?;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    drop(stdin);
    let wall = start.elapsed();
    let pipes_held = !drain_pipes(child.id(), out_t, err_t);
    Ok(Proc {
        code: status.code(),
        stdout: text_of(&out),
        stderr: text_of(&err),
        wall,
        killed,
        pipes_held,
    })
}
// ANCHOR_END: checkpoint_l2_run

/// Substitute the placeholders of a run's argv (`course/checkpoints/README.md`).
pub struct Subst {
    pub pairs: Vec<(&'static str, String)>,
}

impl Subst {
    pub fn apply(&self, s: &str) -> String {
        let mut out = s.to_owned();
        for (k, v) in &self.pairs {
            out = out.replace(k, v);
        }
        out
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Is `tool` an executable file in a `PATH` directory?
pub fn on_path(tool: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|d| {
        let p = d.join(tool);
        fs::metadata(&p).is_ok_and(|m| m.is_file())
    })
}

/// Parse `stats: host cpu … (N%)` from stderr.
pub fn host_cpu_percent(stderr: &str) -> Option<u64> {
    let line = stderr.lines().find(|l| l.contains("stats: host cpu"))?;
    let open = line.rfind('(')?;
    let inner = line.get(open.checked_add(1)?..)?.strip_suffix("%)")?;
    let int = inner.split('.').next()?;
    int.trim().parse().ok()
}

/// The `test result:` counts of one `cargo test` target: `(passed, failed)`.
pub fn test_counts(stdout: &str) -> Option<(usize, usize)> {
    let mut found = None;
    for l in stdout.lines() {
        let Some(rest) = l.strip_prefix("test result: ") else {
            continue;
        };
        let num = |word: &str| -> Option<usize> {
            rest.split(';')
                .map(str::trim)
                .find_map(|p| p.strip_suffix(word))
                .and_then(|n| n.trim().rsplit(' ').next())
                .and_then(|n| n.parse().ok())
        };
        let (p, f) = (num(" passed")?, num(" failed")?);
        let (tp, tf) = found.unwrap_or((0usize, 0usize));
        found = Some((tp.saturating_add(p), tf.saturating_add(f)));
    }
    found
}

/// The names of failed tests (`test name ... FAILED`), sanitized: the names come from the
/// code under test.
pub fn failed_tests(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|l| l.strip_prefix("test ")?.strip_suffix(" ... FAILED"))
        .map(report::sanitize)
        .collect()
}

/// The first failure's panic message block (`---- name stdout ----` …), a few lines.
fn first_panic(stdout: &str) -> Vec<String> {
    let lines: Vec<&str> = stdout.lines().collect();
    let Some(i) = lines.iter().position(|l| l.starts_with("---- ")) else {
        return Vec::new();
    };
    lines
        .iter()
        .skip(i)
        .take(12)
        .map(|l| report::sanitize(l))
        .collect()
}

/// The first compiler error of a failed build, a few lines.
fn first_error(stderr: &str) -> Vec<String> {
    let lines: Vec<&str> = stderr.lines().collect();
    let Some(i) = lines.iter().position(|l| l.starts_with("error")) else {
        return tail_lines(stderr, 15)
            .lines()
            .map(report::sanitize)
            .collect();
    };
    lines
        .iter()
        .skip(i)
        .take(15)
        .map(|l| report::sanitize(l))
        .collect()
}

/// A test file's stem (`contract/esr_decode.rs` -> `esr_decode`).
fn stem(file: &str) -> String {
    Path::new(file)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Generate the throwaway L1 crate for `cp` (PLAN M27 design note L1) and return its path.
pub fn l1_crate(env: &Env, cp: &Checkpoint) -> Result<PathBuf, String> {
    let crate_dir = env.cp_dir(&cp.id).join("crate");
    if fs::symlink_metadata(&crate_dir).is_ok_and(|m| !m.file_type().is_dir()) {
        return Err(format!(
            "{} is not a directory; refusing to use it",
            crate_dir.display()
        ));
    }
    mkdir_private(&crate_dir)?;
    let mut crates: Vec<String> = cp
        .contract
        .as_ref()
        .map(|c| c.crates.clone())
        .unwrap_or_else(|| vec!["vmm".into()]);
    if cp
        .runs
        .iter()
        .any(|r| matches!(r.exec, Exec::ContractHvf(_)))
    {
        for c in ["vmm", "hvf"] {
            if !crates.iter().any(|x| x == c) {
                crates.push(c.into());
            }
        }
    }
    let mut deps = String::new();
    let mut feats = Vec::new();
    for c in &crates {
        let manifest = env.impl_dir.join("crates").join(c).join("Cargo.toml");
        if !manifest.is_file() {
            continue; // reported by cargo as an unresolved import, in the learner's terms
        }
        let path = path_str(&env.impl_dir.join("crates").join(c));
        let extra = if c == "vmm" {
            ", features = [\"test-util\"]"
        } else {
            ""
        };
        deps.push_str(&format!(
            "{c} = {{ path = {}{extra} }}\n",
            toml_lite::quote(&path)
        ));
        feats.push(format!("\"{c}/hvf-tests\""));
    }
    let manifest = format!(
        "# Generated by `cargo xtask checkpoint {id}` (PLAN M27 L1). Do not edit: regenerated on every run.\n\
         [package]\nname = \"checkpoint-{id}\"\nversion = \"0.0.0\"\nedition = \"2024\"\npublish = false\n\n\
         [dependencies]\n{deps}\n[features]\nhvf-tests = [{}]\n\n\
         # Not a member of the repository's workspace.\n[workspace]\n",
        feats.join(", "),
        id = cp.id
    );
    put_file(&crate_dir.join("Cargo.toml"), manifest.as_bytes())?;
    mkdir_private(&crate_dir.join("src"))?;
    put_file(
        &crate_dir.join("src/lib.rs"),
        b"//! Generated: the contract tests live in `tests/`.\n",
    )?;
    // The runner signs test binaries that link Hypervisor.framework (SIGN-4), as in the repo.
    mkdir_private(&crate_dir.join(".cargo"))?;
    put_file(
        &crate_dir.join(".cargo/config.toml"),
        format!(
            "[target.aarch64-apple-darwin]\nrunner = [{}]\n",
            toml_lite::quote(&path_str(&env.repo.join("scripts/sign-and-run.sh")))
        )
        .as_bytes(),
    )?;
    // Pin dependency versions to the implementation's lock file (no resolution, `--offline`).
    let lock = env.impl_dir.join("Cargo.lock");
    let crate_lock = crate_dir.join("Cargo.lock");
    if lock.is_file() {
        let bytes = fs::read(&lock).map_err(|e| format!("{}: {e}", lock.display()))?;
        put_file(&crate_lock, &bytes)?;
    } else if crate_lock.is_file() {
        let _ = fs::remove_file(&crate_lock);
    }
    // Mirror the whole contract/ directory (tests plus their data files) into tests/.
    let src = cp.dir.join("contract");
    let tests = crate_dir.join("tests");
    mkdir_private(&tests)?;
    if src.is_dir() {
        sync_tree(&src, &tests, 0)?;
    }
    Ok(crate_dir)
}

/// Write `bytes` to `p` unless it already holds exactly them, through a temporary file private
/// to this process and a rename: an invocation on the same tree that is reading `p` at the same
/// moment sees the old or the new copy, never a torn one, and an unchanged file keeps its mtime
/// (so cargo does not rebuild the L1 crate for nothing). A symlink at `p` is refused.
pub fn put_file(p: &Path, bytes: &[u8]) -> Result<(), String> {
    match fs::symlink_metadata(p) {
        Ok(m) if !m.file_type().is_file() => {
            return Err(format!(
                "{} is not a regular file; refusing it",
                p.display()
            ));
        }
        Ok(_) if fs::read(p).is_ok_and(|old| old == bytes) => return Ok(()),
        _ => {}
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = p.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&tmp);
    fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, p).map_err(|e| format!("{}: {e}", p.display()))
}

/// Make `dst` mirror the regular files (never symlinks) of `src`, at most 4 levels deep:
/// changed files are rewritten with [`put_file`], files and directories no longer in `src`
/// are removed. Returns how many files `src` has.
pub fn sync_tree(src: &Path, dst: &Path, depth: usize) -> Result<usize, String> {
    if depth > 4 {
        return Err(format!("{}: nested too deep", src.display()));
    }
    let mut n = 0usize;
    let mut entries: Vec<_> = fs::read_dir(src)
        .map_err(|e| format!("{}: {e}", src.display()))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(|e| e.file_name());
    let mut keep = Vec::new();
    for e in entries {
        let ty = e.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(e.file_name());
        if ty.is_dir() {
            if fs::symlink_metadata(&to).is_ok_and(|m| !m.file_type().is_dir()) {
                fs::remove_file(&to).map_err(|err| format!("{}: {err}", to.display()))?;
            }
            mkdir_private(&to)?;
            n = n.saturating_add(sync_tree(&e.path(), &to, depth.saturating_add(1))?);
        } else if ty.is_file() {
            if fs::symlink_metadata(&to).is_ok_and(|m| m.file_type().is_dir()) {
                fs::remove_dir_all(&to).map_err(|err| format!("{}: {err}", to.display()))?;
            }
            let bytes =
                fs::read(e.path()).map_err(|err| format!("{}: {err}", e.path().display()))?;
            put_file(&to, &bytes)?;
            n = n.saturating_add(1);
        } else {
            return Err(format!("{}: not a regular file", e.path().display()));
        }
        keep.push(e.file_name());
    }
    for e in fs::read_dir(dst)
        .map_err(|e| format!("{}: {e}", dst.display()))?
        .filter_map(Result::ok)
    {
        let name = e.file_name();
        // Another invocation's in-flight temporary (`.<name>.<pid>.tmp`) is not stale.
        if keep.contains(&name) || name.to_string_lossy().ends_with(".tmp") {
            continue;
        }
        let p = e.path();
        let _ = match e.file_type() {
            Ok(t) if t.is_dir() => fs::remove_dir_all(&p),
            _ => fs::remove_file(&p),
        };
    }
    Ok(n)
}

/// `cargo test` of one target in the L1 crate, as a [`run_child`] run: the build and the tests
/// together get `limit` plus the hard-kill grace, and the kill reaches the test binary (a
/// learner's test can loop forever, or `hv_vcpu_run` never return, PLAN §0.3).
fn cargo_test(
    env: &Env,
    crate_dir: &Path,
    test: &str,
    hvf: bool,
    limit: Duration,
) -> Result<Proc, String> {
    let mut cmd = Command::new("cargo");
    cmd.current_dir(crate_dir)
        .env("CARGO_TARGET_DIR", &env.l1_target)
        .args(["test", "--offline", "--test", test]);
    if hvf {
        cmd.args(["--features", "hvf-tests", "--", "--test-threads=1"]);
    }
    run_child(cmd, &[], limit, true)
}

/// The time an L1 `cargo test` target gets (build included): L1 has no `timeout` key, so the
/// longest a definition may give a run.
const L1_TIMEOUT: Duration = Duration::from_secs(super::MAX_TIMEOUT_S);

/// The outcome of one contract target, as report text.
enum TestOutcome {
    Pass(usize),
    Fail(String, Vec<String>),
}

fn judge_tests(p: &Proc, test: &str, limit: Duration) -> TestOutcome {
    if p.killed {
        return TestOutcome::Fail(
            format!(
                "{test}: hard-killed: `cargo test` still running {}s after its {}s timeout",
                HARD_KILL_GRACE.as_secs(),
                limit.as_secs()
            ),
            sanitized_tail(&p.stdout, 15)
                .lines()
                .map(str::to_owned)
                .collect(),
        );
    }
    if p.pipes_held {
        return TestOutcome::Fail(format!("{test}: {PIPES_HELD}"), Vec::new());
    }
    match test_counts(&p.stdout) {
        Some((n, 0)) if p.code == Some(0) && n > 0 => TestOutcome::Pass(n),
        Some((0, 0)) if p.code == Some(0) => TestOutcome::Fail(
            format!("{test}: 0 tests ran (is a cfg or feature hiding them?)"),
            Vec::new(),
        ),
        Some((_, f)) if f > 0 => {
            let names = failed_tests(&p.stdout);
            TestOutcome::Fail(
                format!(
                    "{test}: {f} failed: {}",
                    names
                        .iter()
                        .take(6)
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                first_panic(&p.stdout),
            )
        }
        _ => TestOutcome::Fail(
            format!("{test}: did not build or run"),
            first_error(&p.stderr),
        ),
    }
}

/// L1: the contract tests (host only).
fn level1(env: &Env, cp: &Checkpoint, out: &mut Out) -> bool {
    let Some(contract) = cp.contract.as_ref().filter(|c| !c.tests.is_empty()) else {
        out.line(&report::level_line(
            Status::Info,
            report::CONTRACT,
            "none for this chapter",
        ));
        return true;
    };
    let crate_dir = match l1_crate(env, cp) {
        Ok(d) => d,
        Err(e) => {
            out.line(&report::level_line(Status::Fail, report::CONTRACT, &e));
            return false;
        }
    };
    let mut parts = Vec::new();
    for t in &contract.tests {
        let name = stem(t);
        let p = match cargo_test(env, &crate_dir, &name, false, L1_TIMEOUT) {
            Ok(p) => p,
            Err(e) => {
                out.line(&report::level_line(Status::Fail, report::CONTRACT, &e));
                return false;
            }
        };
        match judge_tests(&p, &name, L1_TIMEOUT) {
            TestOutcome::Pass(n) => parts.push(format!("{name} ({n} tests)")),
            TestOutcome::Fail(why, detail) => {
                out.line(&report::level_line(Status::Fail, report::CONTRACT, &why));
                for l in detail {
                    out.line(&format!("    {l}"));
                }
                return false;
            }
        }
    }
    out.line(&report::level_line(
        Status::Pass,
        report::CONTRACT,
        &parts.join(", "),
    ));
    true
}

/// The serial/trace verdict of one run.
struct Judged {
    ok: bool,
    detail: Vec<String>,
    summary: Vec<String>,
    first_failure: Option<String>,
}

impl Judged {
    fn fail(&mut self, why: String) {
        if self.first_failure.is_none() {
            self.first_failure = Some(why.clone());
        }
        self.ok = false;
        self.detail.push(why);
    }
}

fn read_marker_file(cp: &Checkpoint, rel: &str) -> Result<String, String> {
    super::read_capped(&cp.dir.join(rel), toml_lite::MAX_INPUT)
}

/// Read a trace file and check that every line is one JSON value (TRACE.md).
pub fn read_trace(path: &Path) -> Result<String, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("trace {}: {e} (did the run write it?)", path.display()))?;
    if !meta.file_type().is_file() {
        return Err(format!("trace {}: not a regular file", path.display()));
    }
    if meta.len() > u64::try_from(TRACE_CAP).unwrap_or(u64::MAX) {
        return Err(format!(
            "trace {}: {} bytes is over the {TRACE_CAP}-byte cap",
            path.display(),
            meta.len()
        ));
    }
    let bytes = fs::read(path).map_err(|e| format!("trace {}: {e}", path.display()))?;
    let text = String::from_utf8(bytes)
        .map_err(|e| format!("trace {}: not UTF-8 ({e})", path.display()))?;
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        json_lite::parse_line(line)
            .map_err(|e| format!("trace line {}: {e}", i.saturating_add(1)))?;
    }
    Ok(text)
}

fn judge_run(env: &Env, cp: &Checkpoint, r: &RunSpec, p: &Proc, out_dir: &Path) -> Judged {
    let _ = env;
    let mut j = Judged {
        ok: true,
        detail: Vec::new(),
        summary: Vec::new(),
        first_failure: None,
    };
    if let Some(rel) = &r.serial {
        match read_marker_file(cp, rel) {
            Err(e) => j.fail(e),
            Ok(spec) => match markers::check(&spec, &p.stdout, &p.stderr) {
                Ok(t) => j
                    .summary
                    .push(format!("{}/{} serial markers", t.matched, t.total)),
                Err(m) => j.fail(format!(
                    "{rel}:{}: {} ({}/{} serial markers matched before it)",
                    m.line, m.why, m.tally.matched, m.tally.total
                )),
            },
        }
    }
    let mut trace_text = None;
    if let Some(tf) = &r.trace_file {
        match read_trace(&out_dir.join(tf)) {
            Ok(t) => trace_text = Some(t),
            Err(e) => j.fail(e),
        }
    }
    if let (Some(rel), Some(trace)) = (&r.trace, &trace_text) {
        match read_marker_file(cp, rel) {
            Err(e) => j.fail(e),
            Ok(spec) => match markers::check(&spec, trace, "") {
                Ok(t) => j
                    .summary
                    .push(format!("{}/{} trace markers", t.matched, t.total)),
                // The trace is matched as the "stdout" stream: name it what it is.
                Err(m) => j.fail(format!(
                    "{rel}:{}: {} ({}/{} trace markers matched before it)",
                    m.line,
                    m.why.replace("stdout marker", "trace marker"),
                    m.tally.matched,
                    m.tally.total
                )),
            },
        }
    }
    if let (Some(needle), Some(plus), Some(trace)) = (
        &r.count_trace,
        r.count_equals_stdout_bytes_plus,
        &trace_text,
    ) {
        let n = trace
            .lines()
            .filter(|l| l.contains(needle.as_str()))
            .count();
        let want = i64::try_from(p.stdout.len())
            .ok()
            .and_then(|b| b.checked_add(plus));
        let got = i64::try_from(n).ok();
        if want.is_some() && want == got {
            j.summary.push(format!(
                "{n} {needle} records = {} stdout bytes + {plus}",
                p.stdout.len()
            ));
        } else {
            j.fail(format!(
                "{n} trace records contain {needle}, but stdout has {} bytes (want bytes + {plus})",
                p.stdout.len()
            ));
        }
    }
    if let Some(max) = r.max_host_cpu_percent {
        match host_cpu_percent(&p.stderr) {
            Some(pct) if pct < max => j.summary.push(format!("host cpu {pct}% < {max}%")),
            Some(pct) => j.fail(format!("host cpu {pct}% is not under {max}%")),
            None => j.fail("no `stats: host cpu … (N%)` line on stderr (--stats?)".into()),
        }
    }
    if let Some(prefix) = &r.equal_lines {
        let lines: Vec<&str> = p
            .stdout
            .lines()
            .map(|l| l.trim_end_matches(['\r', '\n']))
            .filter(|l| l.starts_with(prefix.as_str()))
            .collect();
        match lines.split_first() {
            Some((first, rest)) if !rest.is_empty() && rest.iter().all(|l| l == first) => {
                j.summary
                    .push(format!("{} equal {prefix} lines", lines.len()));
            }
            _ => j.fail(format!(
                "want at least two identical lines starting {prefix:?}, got {}: {:?}",
                lines.len(),
                lines.iter().take(4).collect::<Vec<_>>()
            )),
        }
    }
    if p.killed {
        j.fail(format!(
            "hard-killed: still running {}s after its {}s timeout",
            HARD_KILL_GRACE.as_secs(),
            r.timeout_s
        ));
    } else if p.pipes_held {
        j.fail(PIPES_HELD.to_owned());
    } else if p.code != Some(r.expect_exit_code) {
        j.fail(format!(
            "exit {} (want {})",
            p.code
                .map_or_else(|| "by signal".to_owned(), |c| c.to_string()),
            r.expect_exit_code
        ));
    }
    if j.ok {
        j.summary.push(format!(
            "exit {} in {:.2}s",
            r.expect_exit_code,
            p.wall.as_secs_f64()
        ));
    }
    if !j.ok {
        if let Some(t) = &trace_text {
            j.detail
                .push(format!("last {} trace records:", report::TRACE_TAIL));
            j.detail
                .extend(report::trace_tail(t).into_iter().map(|l| format!("  {l}")));
        }
        let dump = report::register_dump(&p.stderr);
        if dump.is_empty() {
            j.detail.push("stderr (last lines):".into());
            j.detail.extend(
                report::stderr_tail(&p.stderr)
                    .into_iter()
                    .map(|l| format!("  {l}")),
            );
        } else {
            j.detail.push("register dump:".into());
            j.detail.extend(dump.into_iter().map(|l| format!("  {l}")));
        }
    }
    j
}

/// Replace machine-specific paths in a capture with stable names, and make control characters
/// visible (`\u{1b}`): a capture is read with `cat` and quoted in lessons, so it must not carry
/// terminal escape sequences (the VMM's own terminal restore, or anything a guest printed).
fn normalize(s: &str, env: &Env, out_dir: &Path, guests: Option<&Path>) -> String {
    let mut t = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\n' || c == '\t' || !c.is_control() {
            t.push(c);
        } else {
            t.extend(c.escape_default());
        }
    }
    if let Some(Ok(b)) = &env.built {
        t = t.replace(&path_str(&b.macvmm), "{macvmm}");
        t = t.replace(&path_str(&b.noent), "{macvmm-no-entitlements}");
    }
    let mut t = t.replace(&path_str(out_dir), "{out}");
    if let Some(g) = guests {
        t = t.replace(&path_str(g), "{guests}");
    }
    t = t.replace(&path_str(&env.ck_dir()), "{checkpoint}");
    t.replace(&path_str(&env.repo), "<repo>")
}

fn cap(s: &str) -> &str {
    if s.len() <= CAPTURE_CAP {
        return s;
    }
    let mut end = CAPTURE_CAP;
    while end > 0 && !s.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    s.get(..end).unwrap_or("")
}

#[allow(clippy::too_many_arguments)]
fn write_capture(
    env: &Env,
    cp: &Checkpoint,
    r: &RunSpec,
    argv: &[String],
    p: &Proc,
    out_dir: &Path,
    guests: Option<&Path>,
) -> Result<(), String> {
    let dir = env.repo.join(super::CAPTURES_DIR);
    mkdir_private(&dir)?;
    let n = |s: &str| normalize(s, env, out_dir, guests);
    let mut text = format!(
        "# scripts/capture.sh {id}: run {name:?} of course/checkpoints/{id}, captured from the reference\n\
         # on real hardware. Regenerate with scripts/capture.sh {id}; never edit by hand (course/STYLE.md appendix A).\n\
         $ {}\nexit: {}\n--- stdout ---\n{}\n--- stderr ---\n{}\n",
        n(&argv.join(" ")),
        p.code
            .map_or_else(|| "signal".to_owned(), |c| c.to_string()),
        n(cap(&p.stdout)),
        n(cap(&p.stderr)),
        id = cp.id,
        name = r.name
    );
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let base = format!("{}-{}", cp.id, r.name);
    fs::write(dir.join(format!("{base}.txt")), text).map_err(|e| e.to_string())?;
    if let Some(tf) = &r.trace_file
        && let Ok(t) = read_trace(&out_dir.join(tf))
    {
        fs::write(dir.join(format!("{base}.trace.jsonl")), n(cap(&t)))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Run one `[[run]]`; returns whether it passed.
fn level2_run(env: &mut Env, cp: &Checkpoint, r: &RunSpec, out: &mut Out) -> bool {
    let label = report::RUNS;
    if let Some(tool) = &r.requires_tool
        && !on_path(tool)
    {
        out.line(&report::level_line(
            Status::Info,
            label,
            &format!("{}: skipped, `{tool}` is not installed", r.name),
        ));
        return true;
    }
    let out_dir = env.out_root(&cp.id).join(&r.name);
    if let Err(e) = fresh_dir(&out_dir, &env.ck_dir()) {
        out.line(&report::level_line(Status::Fail, label, &e));
        return false;
    }
    let fail = |out: &mut Out, why: &str| {
        out.line(&report::level_line(
            Status::Fail,
            label,
            &format!("{}: {why}", r.name),
        ));
        false
    };
    if let Exec::ContractHvf(file) = &r.exec {
        let crate_dir = match l1_crate(env, cp) {
            Ok(d) => d,
            Err(e) => return fail(out, &e),
        };
        let name = stem(file);
        // `timeout` bounds the build plus the tests; `expect_exit_code` is 0 (checked at load
        // time: a contract run passes only when `cargo test` exits 0 with tests run).
        let limit = Duration::from_secs(r.timeout_s);
        let p = match cargo_test(env, &crate_dir, &name, true, limit) {
            Ok(p) => p,
            Err(e) => return fail(out, &e),
        };
        return match judge_tests(&p, &name, limit) {
            TestOutcome::Pass(n) => {
                out.line(&report::level_line(
                    Status::Pass,
                    label,
                    &format!(
                        "{}: HVF contract {name} ({n} tests) in {:.2}s",
                        r.name,
                        p.wall.as_secs_f64()
                    ),
                ));
                true
            }
            TestOutcome::Fail(why, detail) => {
                fail(out, &why);
                for l in detail {
                    out.line(&format!("    {l}"));
                }
                false
            }
        };
    }
    let guests = if r.guest.is_some() {
        match env.guests() {
            Ok(g) => Some(g),
            Err(e) => return fail(out, &e),
        }
    } else {
        None
    };
    let built = match &r.exec {
        Exec::Macvmm(_) => match env.built() {
            Ok(b) => Some(b),
            Err(e) => return fail(out, &e),
        },
        Exec::Command(argv) if argv.iter().any(|a| a.contains("{macvmm}")) => match env.built() {
            Ok(b) => Some(b),
            Err(e) => return fail(out, &e),
        },
        _ => None,
    };
    if let Some(blob) = &r.blob
        && let Err(e) = fs::write(out_dir.join("blob.bin"), blob)
    {
        return fail(out, &format!("blob.bin: {e}"));
    }
    let mut pairs: Vec<(&'static str, String)> = vec![
        ("{out}", path_str(&out_dir)),
        (
            "{blob_raw}",
            format!("{}@{RAW_LOAD_ADDR}", path_str(&out_dir.join("blob.bin"))),
        ),
        ("{repo}", path_str(&env.repo)),
        ("{impl}", path_str(&env.impl_dir)),
    ];
    if let (Some(g), Some(name)) = (&guests, &r.guest) {
        let elf = g.join(name);
        let bin = g.join(format!("{name}.bin"));
        if !elf.is_file() || !bin.is_file() {
            return fail(
                out,
                &format!("guest {name:?} was not built by scripts/build-guests.sh"),
            );
        }
        // `{guest_raw}` before `{guest}`: replacement is by substring, longest first.
        pairs.insert(
            0,
            ("{guest_raw}", format!("{}@{RAW_LOAD_ADDR}", path_str(&bin))),
        );
        pairs.insert(1, ("{guest_bin}", path_str(&bin)));
        pairs.insert(2, ("{guest}", path_str(&elf)));
    }
    if let Some(b) = &built {
        pairs.push(("{macvmm}", path_str(&b.macvmm)));
    }
    let sub = Subst { pairs };
    let (cmd, argv, close_stdin) = match &r.exec {
        Exec::Macvmm(args) => {
            let Some(b) = &built else {
                return fail(out, "internal: no binary");
            };
            let bin = match r.sign {
                Sign::Hypervisor => b.macvmm.clone(),
                Sign::NoEntitlements => b.noent.clone(),
            };
            let args: Vec<String> = args.iter().map(|a| sub.apply(a)).collect();
            let mut c = Command::new(&bin);
            c.args(&args).current_dir(&out_dir);
            let mut argv = vec!["macvmm".to_owned()];
            argv.extend(args);
            (c, argv, true)
        }
        Exec::Command(argv) => {
            let argv: Vec<String> = argv.iter().map(|a| sub.apply(a)).collect();
            let cwd = if r.cwd_repo {
                env.repo.clone()
            } else {
                env.impl_dir.clone()
            };
            let Some((prog, rest)) = argv.split_first() else {
                return fail(out, "empty command");
            };
            let prog_path = if prog.contains('/') && !Path::new(prog).is_absolute() {
                cwd.join(prog)
            } else {
                PathBuf::from(prog)
            };
            let mut c = Command::new(prog_path);
            c.args(rest).current_dir(&cwd);
            if !r.cwd_repo
                && let Some(t) = &env.impl_target
            {
                c.env("CARGO_TARGET_DIR", t);
            }
            (c, argv, false)
        }
        Exec::ContractHvf(_) => return fail(out, "internal: handled above"),
    };
    let p = match run_child(cmd, &r.steps, Duration::from_secs(r.timeout_s), close_stdin) {
        Ok(p) => p,
        Err(e) => return fail(out, &e),
    };
    if env.capture
        && let Err(e) = write_capture(env, cp, r, &argv, &p, &out_dir, guests.as_deref())
    {
        report::err(&format!("checkpoint: capture: {e}"));
    }
    let j = judge_run(env, cp, r, &p, &out_dir);
    if j.ok {
        out.line(&report::level_line(
            Status::Pass,
            label,
            &format!("{}: {}", r.name, j.summary.join(", ")),
        ));
    } else {
        out.line(&report::level_line(
            Status::Fail,
            label,
            &format!(
                "{}: {}",
                r.name,
                j.first_failure.as_deref().unwrap_or("failed")
            ),
        ));
        for l in j.detail.iter().skip(1) {
            out.line(&format!("    {l}"));
        }
    }
    if !env.keep {
        let _ = fs::remove_dir_all(&out_dir);
    }
    j.ok
}

/// L2: every `[[run]]`.
fn level2(env: &mut Env, cp: &Checkpoint, out: &mut Out) -> bool {
    if cp.runs.is_empty() {
        out.line(&report::level_line(
            Status::Info,
            report::RUNS,
            "none for this chapter",
        ));
        return true;
    }
    let mut ok = true;
    for r in &cp.runs {
        ok &= level2_run(env, cp, r, out);
    }
    if !env.keep {
        let _ = fs::remove_dir_all(env.out_root(&cp.id));
    }
    ok
}

/// What a journal check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalCheck {
    pub answered: usize,
    pub questions: usize,
    pub predict: Option<bool>,
}

/// Check a journal's text (PLAN M27 L3): `## Q1` … `## Q<n>` each with a non-empty answer, and
/// a `## Predict` section with text when `predict`. Answer text is any line that is not blank,
/// not a heading, not a `>` quote (the prompt) and not inside an HTML comment.
pub fn check_journal(text: &str, questions: usize, predict: bool) -> JournalCheck {
    let mut sections: Vec<(String, bool)> = Vec::new();
    let mut in_comment = false;
    for line in text.lines() {
        let t = line.trim();
        if in_comment {
            if t.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        if t.starts_with("<!--") {
            in_comment = !t.contains("-->");
            continue;
        }
        if let Some(h) = t.strip_prefix("## ") {
            sections.push((h.trim().to_owned(), false));
            continue;
        }
        if t.is_empty() || t.starts_with('#') || t.starts_with('>') {
            continue;
        }
        if let Some(last) = sections.last_mut() {
            last.1 = true;
        }
    }
    let q_answered = |n: usize| {
        let want = format!("Q{n}");
        sections.iter().any(|(h, a)| {
            *a && (h == &want
                || h.strip_prefix(want.as_str())
                    .is_some_and(|r| r.starts_with([' ', '.', ':', ')'])))
        })
    };
    let answered = (1..=questions).filter(|n| q_answered(*n)).count();
    let predict = predict.then(|| {
        sections
            .iter()
            .any(|(h, a)| *a && h.to_ascii_lowercase().starts_with("predict"))
    });
    JournalCheck {
        answered,
        questions,
        predict,
    }
}

/// L3: the journal (learner trees only; never uploaded).
fn level3(env: &Env, cp: &Checkpoint, out: &mut Out) -> bool {
    let label = report::JOURNAL;
    let Some(j) = &cp.journal else {
        out.line(&report::level_line(
            Status::Info,
            label,
            "none for this chapter",
        ));
        return true;
    };
    if !env.learner {
        out.line(&report::level_line(
            Status::Info,
            label,
            "not checked (not a learner tree)",
        ));
        return true;
    }
    let path = env.impl_dir.join(&j.file);
    let text = match super::read_capped(&path, JOURNAL_CAP) {
        Ok(t) => t,
        Err(_) => {
            out.line(&report::level_line(
                Status::Fail,
                label,
                &format!(
                    "{} is missing (scripts/learner start {} copies the template)",
                    j.file, cp.id
                ),
            ));
            return false;
        }
    };
    let c = check_journal(&text, j.questions, j.predict);
    let predict_ok = c.predict.unwrap_or(true);
    if c.answered < c.questions || !predict_ok {
        let mut why = format!("{}: {}/{} answered", j.file, c.answered, c.questions);
        if !predict_ok {
            why.push_str(", the `## Predict` guess is missing");
        }
        out.line(&report::level_line(Status::Fail, label, &why));
        return false;
    }
    let mut detail = format!("{}/{} answered", c.answered, c.questions);
    if c.predict.is_some() {
        detail.push_str(", predict recorded");
    }
    let rubric = env
        .repo
        .join("course/journal")
        .join(format!("{}.rubric.md", cp.id));
    let rubric_text = super::read_capped(&rubric, JOURNAL_CAP).ok();
    if rubric_text.is_some() {
        detail.push_str("; rubric printed below");
    }
    out.line(&report::level_line(Status::Info, label, &detail));
    if let Some(t) = rubric_text {
        for l in t.lines() {
            out.line(&format!("    {l}"));
        }
    }
    true
}

/// Run one checkpoint; returns whether it passed.
pub fn run_one(env: &mut Env, id: &str, out: &mut Out) -> bool {
    let cp = match super::load(&env.repo, id) {
        Ok(c) => c,
        Err(e) => {
            out.line(&format!("[FAIL] definition {e}"));
            out.line(&report::verdict(id, false, &[]));
            return false;
        }
    };
    if env.learner {
        let passed = crate::learner::Progress::load(&env.impl_dir.join(".progress.toml"))
            .map(|p| p.passed)
            .unwrap_or_default();
        for r in &cp.requires {
            if !passed.contains(r) {
                out.line(&report::level_line(
                    Status::Info,
                    "requires",
                    &format!("{r} is not recorded as passed yet (scripts/checkpoint.sh {r})"),
                ));
            }
        }
    }
    let l1 = level1(env, &cp, out);
    let l2 = level2(env, &cp, out);
    let l3 = level3(env, &cp, out);
    let ok = l1 && l2 && l3;
    out.line(&report::verdict(&cp.id, ok, &env.borrowed));
    if ok && env.learner {
        let path = env.impl_dir.join(".progress.toml");
        if let Ok(mut p) = crate::learner::Progress::load(&path) {
            if !p.passed.contains(&cp.id) {
                p.passed.push(cp.id.clone());
                p.passed.sort();
            }
            if let Err(e) = p.save(&path) {
                report::err(&format!("checkpoint: cannot record the pass: {e}"));
            }
        }
    }
    ok
}

/// Run every requested checkpoint; the process exit code (0 all passed, 1 otherwise).
pub fn run_all(repo: &Path, opts: &Options) -> u8 {
    let mut out = Out::stdout();
    run_all_to(repo, opts, &mut out)
}

/// [`run_all`] with an explicit output sink.
pub fn run_all_to(repo: &Path, opts: &Options, out: &mut Out) -> u8 {
    let mut env = match Env::new(repo, opts) {
        Ok(e) => e,
        Err(e) => {
            report::err(&format!("checkpoint: {e}"));
            return 2;
        }
    };
    if !env.reference {
        out.line(&format!(
            "checkpoint: implementation {}",
            env.impl_dir.display()
        ));
    }
    let mut passed = 0usize;
    for id in &opts.ids {
        if run_one(&mut env, id, out) {
            passed = passed.saturating_add(1);
        }
    }
    if opts.ids.len() > 1 {
        out.line(&report::summary(passed, opts.ids.len()));
    }
    if let Some(Ok(b)) = &env.built
        && let Some(d) = b.macvmm.parent()
    {
        let _ = fs::remove_dir_all(d);
    }
    if passed == opts.ids.len() { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_names() {
        let s = "running 2 tests\ntest a ... ok\ntest b::c ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
        assert_eq!(test_counts(s), Some((1, 1)));
        assert_eq!(failed_tests(s), ["b::c"]);
        assert_eq!(
            test_counts("test result: ok. 40 passed; 0 failed; 0 ignored"),
            Some((40, 0))
        );
        assert_eq!(test_counts("nothing"), None);
    }

    #[test]
    fn cpu_line() {
        assert_eq!(
            host_cpu_percent("x\nmacvmm: stats: host cpu 0.05s user+sys in 1.20s wall (4%)\n"),
            Some(4)
        );
        assert_eq!(host_cpu_percent("stats: host cpu 1s (12.5%)"), Some(12));
        assert_eq!(host_cpu_percent("none"), None);
    }

    #[test]
    fn journal_rules() {
        let t = "# Journal 04\n\n## Q1 What?\n> prompt\nmy answer\n\n## Q2 Why?\n<!-- write here -->\n\n## Predict\nit faults\n";
        let c = check_journal(t, 2, true);
        assert_eq!(c.answered, 1);
        assert_eq!(c.predict, Some(true));
        let c = check_journal("## Q1\na\n## Q2\nb\n## Q3\n<!--\nmulti\n-->\n", 3, true);
        assert_eq!((c.answered, c.predict), (2, Some(false)));
        // Q10 does not answer Q1.
        assert_eq!(check_journal("## Q10\nx\n", 1, false).answered, 0);
    }
}
