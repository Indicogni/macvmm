//! The end-to-end test harness (PLAN §0.3; architecture §17).
//!
//! An e2e test runs the real, signed `macvmm` binary as a child process, exactly as a user
//! would, and judges it by what only the outside can see: its exit code, its stdout (the guest's
//! serial output) and its stderr (the VMM's own verdicts). That is the point (test integrity,
//! AS10): a guest controls its own output and can print any marker, so every test also asserts
//! the process exit code, and VMM verdicts are matched on stderr, which a guest cannot write.
//!
//! What it provides:
//! - [`macvmm`]: a private copy of the binary under `target/e2e-bin/<pid>/`, signed once with
//!   `scripts/sign.sh` (hypervisor entitlement, hardened runtime) and verified with `codesign`,
//!   so a concurrent `cargo build` relinking `target/debug/macvmm` cannot unsign it mid-run;
//! - [`guest`] / [`guest_bin`]: the test guests, built once with `scripts/build-guests.sh`;
//! - [`run`] / [`run_steps`]: the child with `--timeout` in its arguments *and* a hard kill at
//!   that timeout + 10 s, with stdout and stderr captured separately and optional interaction
//!   steps ([`Step::WaitFor`], [`Step::Send`], [`Step::Sleep`]);
//! - [`check_markers`] / [`expect`]: the marker-file rules of PLAN §0.3 (`expect/<test>.txt`).
//!
//! New helpers are additive (PLAN §2.1: this file is a shared registration file).
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)] // each test crate uses a subset

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The repository root.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Cargo's target directory (the scripts honour `CARGO_TARGET_DIR` the same way).
pub fn target_dir() -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(t) if Path::new(&t).is_absolute() => PathBuf::from(t),
        Some(t) => repo_root().join(t),
        None => repo_root().join("target"),
    }
}

fn run_script(script: &str, args: &[&Path]) {
    let out = Command::new(repo_root().join(script))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("cannot run {script}: {e}"));
    assert!(
        out.status.success(),
        "{script} failed ({}):\n{}{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The `macvmm` binary under test: a **private copy**, signed and verified once per test
/// process.
///
/// Why a copy: `CARGO_BIN_EXE_macvmm` is `target/debug/macvmm`, the same path every
/// `cargo build`, `cargo test --workspace` or `cargo run` in the tree relinks. The linker writes
/// a fresh `linker-signed` signature with no entitlements, so a concurrent build between our
/// signing and a later spawn turned the next VM into `hv_vm_create: HV_DENIED (0xfae94007)`
/// (observed with several agents building at once; reproduced by relinking mid-suite). Cargo
/// never writes under `target/e2e-bin/<pid>/`, so once that copy is signed it stays signed for
/// the whole test process.
pub fn macvmm() -> &'static Path {
    static SIGNED: OnceLock<PathBuf> = OnceLock::new();
    SIGNED.get_or_init(|| {
        let root = target_dir().join("e2e-bin");
        prune_dead_pid_dirs(&root);
        let dir = root.join(std::process::id().to_string());
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("macvmm");
        // Copy to a temporary name and rename, so `bin` is never a half-written file. A copy
        // taken while the linker is still writing the source fails `codesign` below; retry.
        let mut last = String::new();
        for _ in 0..5 {
            let tmp = dir.join("macvmm.tmp");
            std::fs::copy(env!("CARGO_BIN_EXE_macvmm"), &tmp).unwrap();
            std::fs::rename(&tmp, &bin).unwrap();
            let out = Command::new(repo_root().join("scripts/sign.sh"))
                .arg(&bin)
                .stdin(Stdio::null())
                .output()
                .expect("run scripts/sign.sh");
            if out.status.success() {
                verify_signed(&bin);
                return bin;
            }
            last = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            std::thread::sleep(Duration::from_millis(500));
        }
        panic!(
            "scripts/sign.sh failed on {} 5 times:\n{last}",
            bin.display()
        );
    })
}

/// Check, independently of `sign.sh`, that `bin` carries exactly the hypervisor entitlement and
/// the hardened runtime (SIGN-1, SIGN-3) right before the harness uses it.
fn verify_signed(bin: &Path) {
    let ents = Command::new("/usr/bin/codesign")
        .args(["-d", "--entitlements", "-", "--xml"])
        .arg(bin)
        .output()
        .expect("run codesign -d --entitlements");
    let xml = String::from_utf8_lossy(&ents.stdout);
    let keys: Vec<&str> = xml
        .split("<key>")
        .skip(1)
        .filter_map(|s| s.split("</key>").next())
        .collect();
    assert_eq!(
        keys,
        ["com.apple.security.hypervisor"],
        "{}: wrong entitlements after signing: {xml}",
        bin.display()
    );
    let dv = Command::new("/usr/bin/codesign")
        .arg("-dv")
        .arg(bin)
        .output()
        .expect("run codesign -dv");
    let info = String::from_utf8_lossy(&dv.stderr);
    assert!(
        info.lines()
            .any(|l| l.starts_with("CodeDirectory ") && l.contains("runtime")),
        "{}: hardened runtime flag missing after signing:\n{info}",
        bin.display()
    );
}

/// Remove `root/<pid>` directories whose process is gone (earlier test runs leave their copy
/// behind: a test process has no exit hook). `/bin/kill -0` fails only for a dead pid here,
/// since every such pid was ours.
fn prune_dead_pid_dirs(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(pid) = name
            .to_str()
            .filter(|n| n.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        if pid == std::process::id().to_string() {
            continue;
        }
        let alive = Command::new("/bin/kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !alive {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// The directory holding the built guests (ELF `<name>` and flat `<name>.bin`).
pub fn guests_dir() -> &'static Path {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT.get_or_init(|| {
        run_script("scripts/build-guests.sh", &[]);
        target_dir().join("guests/aarch64-unknown-none/release")
    })
}

/// The ELF of guest `name`.
pub fn guest(name: &str) -> String {
    guests_dir().join(name).to_string_lossy().into_owned()
}

/// The flat binary of guest `name`.
pub fn guest_bin(name: &str) -> String {
    guests_dir()
        .join(format!("{name}.bin"))
        .to_string_lossy()
        .into_owned()
}

/// A fresh, private scratch directory for one test.
pub fn scratch(test: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("macvmm-e2e-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// One interaction step.
#[derive(Clone, Debug)]
pub enum Step {
    /// Wait until stdout contains this text (a plain substring).
    WaitFor(&'static str),
    /// Write these bytes to the child's stdin.
    Send(Vec<u8>),
    /// Sleep this many milliseconds.
    Sleep(u64),
}

/// What a run produced.
#[derive(Debug)]
pub struct Outcome {
    /// The exit code; `None` if killed by a signal (including the harness's hard kill).
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub wall: Duration,
    /// True if the harness had to kill the child.
    pub killed: bool,
}

impl Outcome {
    /// A readable dump for assertion messages.
    pub fn dump(&self) -> String {
        format!(
            "exit {:?} (killed {}) after {:?}\n--- stdout ---\n{}\n--- stderr ---\n{}",
            self.code, self.killed, self.wall, self.stdout, self.stderr
        )
    }
}

fn reader(mut r: impl Read + Send + 'static) -> (Arc<Mutex<Vec<u8>>>, std::thread::JoinHandle<()>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let b = Arc::clone(&buf);
    let t = std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => b.lock().unwrap().extend_from_slice(&chunk[..n]),
            }
        }
    });
    (buf, t)
}

/// Run `macvmm <args>` with no interaction; hard-kill after `limit` + 10 s.
pub fn run(args: &[&str], limit: Duration) -> Outcome {
    run_steps(args, &[], limit)
}

/// Run `macvmm <args>`, performing `steps` in order; hard-kill after `limit` + 10 s.
pub fn run_steps(args: &[&str], steps: &[Step], limit: Duration) -> Outcome {
    run_steps_env(args, &[], steps, limit)
}

/// [`run_steps`] with extra environment variables for the child (M21: `MACVMM_CACHE`).
pub fn run_steps_env(
    args: &[&str],
    env: &[(&str, &Path)],
    steps: &[Step],
    limit: Duration,
) -> Outcome {
    let start = Instant::now();
    let deadline = start + limit + Duration::from_secs(10);
    let mut child = Command::new(macvmm())
        .args(args)
        .envs(env.iter().copied())
        .env_remove("MACVMM_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn macvmm");
    let (out, out_t) = reader(child.stdout.take().unwrap());
    let (err, err_t) = reader(child.stderr.take().unwrap());
    let mut stdin = child.stdin.take();
    let mut killed = false;
    for step in steps {
        match step {
            Step::WaitFor(m) => {
                while !String::from_utf8_lossy(&out.lock().unwrap()).contains(m) {
                    if Instant::now() > deadline || child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Step::Send(bytes) => {
                if let Some(s) = stdin.as_mut() {
                    let _ = s.write_all(bytes);
                    let _ = s.flush();
                }
            }
            Step::Sleep(ms) => std::thread::sleep(Duration::from_millis(*ms)),
        }
    }
    drop(stdin); // EOF
    let status = loop {
        if let Some(st) = child.try_wait().expect("wait") {
            break st;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            killed = true;
            break child.wait().expect("wait after kill");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let wall = start.elapsed();
    out_t.join().unwrap();
    err_t.join().unwrap();
    let stdout = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
    let stderr = String::from_utf8_lossy(&err.lock().unwrap()).into_owned();
    Outcome {
        code: status.code(),
        stdout,
        stderr,
        wall,
        killed,
    }
}

/// Where `pat` (with `*` = any run of non-newline characters) first matches in `hay` at or
/// after byte `from`; returns the end of the match.
pub fn find_wild(hay: &str, pat: &str, from: usize) -> Option<usize> {
    let parts: Vec<&str> = pat.split('*').collect();
    let first = parts[0];
    let mut start = from;
    while start < hay.len() && !hay.is_char_boundary(start) {
        start += 1;
    }
    while start <= hay.len() {
        let at = start + hay.get(start..)?.find(first)?;
        let mut pos = at + first.len();
        let mut ok = true;
        for part in &parts[1..] {
            // The earliest occurrence is the best choice for what follows; it must be on the
            // same line (`*` never matches a newline).
            let rest = &hay[pos..];
            match rest.find(part) {
                Some(i) if !rest[..i].contains('\n') => pos += i + part.len(),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return Some(pos);
        }
        start = at + first.len().max(1);
        while start < hay.len() && !hay.is_char_boundary(start) {
            start += 1;
        }
    }
    None
}

/// Check marker rules (PLAN §0.3) against a run's output. `spec` is the marker file's text.
/// Markers on each stream must appear in order; `[stderr] ` lines match stderr, others stdout;
/// `!` lines must appear on neither stream (`![stderr] ` lines: not on stderr).
pub fn check_markers(spec: &str, stdout: &str, stderr: &str) -> Result<(), String> {
    let (mut out_pos, mut err_pos) = (0usize, 0usize);
    for line in spec.lines().map(str::trim_end).filter(|l| !l.is_empty()) {
        if let Some(neg) = line.strip_prefix('!') {
            let (streams, pat): (Vec<(&str, &str)>, &str) = match neg.strip_prefix("[stderr] ") {
                Some(p) => (vec![("stderr", stderr)], p),
                None => (vec![("stdout", stdout), ("stderr", stderr)], neg),
            };
            for (name, hay) in streams {
                if find_wild(hay, pat, 0).is_some() {
                    return Err(format!("forbidden marker {pat:?} appears on {name}"));
                }
            }
        } else if let Some(pat) = line.strip_prefix("[stderr] ") {
            err_pos = find_wild(stderr, pat, err_pos)
                .ok_or(format!("stderr marker {pat:?} missing (in order)"))?;
        } else {
            out_pos = find_wild(stdout, line, out_pos)
                .ok_or(format!("stdout marker {line:?} missing (in order)"))?;
        }
    }
    Ok(())
}

/// Assert `crates/macvmm/tests/expect/<test>.txt` against `o`, with a full dump on failure.
pub fn expect(test: &str, o: &Outcome) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/expect/{test}.txt"));
    let spec = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    if let Err(why) = check_markers(&spec, &o.stdout, &o.stderr) {
        panic!("{test}: {why}\n{}", o.dump());
    }
}

/// Assert the exit code (every e2e test does, AS10).
pub fn expect_code(test: &str, o: &Outcome, code: i32) {
    assert!(
        !o.killed,
        "{test}: hard-killed by the harness\n{}",
        o.dump()
    );
    assert_eq!(o.code, Some(code), "{test}: wrong exit code\n{}", o.dump());
}

/// Assert `crates/macvmm/tests/expect/<test>.trace.txt` against the JSONL trace at `path`
/// (PLAN §0.3: trace markers use the same rules, matched against the trace file; M4).
pub fn expect_trace(test: &str, path: &Path, o: &Outcome) {
    let spec_path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/expect/{test}.trace.txt"));
    let spec = std::fs::read_to_string(&spec_path).unwrap_or_else(|e| panic!("{spec_path:?}: {e}"));
    let trace = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    if let Err(why) = check_markers(&spec, &trace, "") {
        panic!("{test} trace: {why}\n--- trace ---\n{trace}\n{}", o.dump());
    }
}

// ---- M6 helpers: a running child that can be signalled, and a real pseudo-terminal ----

/// A `macvmm` child the test interacts with while it runs (M6: signals, stalled readers).
pub struct Running {
    pub child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    out: Option<Arc<Mutex<Vec<u8>>>>,
    err: Arc<Mutex<Vec<u8>>>,
    threads: Vec<std::thread::JoinHandle<()>>,
    pub start: Instant,
}

impl Running {
    /// Spawn `macvmm <args>` with piped stdin and stderr. `read_stdout = false` leaves stdout
    /// a pipe that nobody ever reads (the SINK-1 `sink_backpressure` case).
    pub fn spawn(args: &[&str], read_stdout: bool) -> Running {
        Running::spawn_env(args, &[], read_stdout)
    }

    /// [`Running::spawn`] with extra environment variables (M21: `MACVMM_CACHE`).
    pub fn spawn_env(args: &[&str], env: &[(&str, &Path)], read_stdout: bool) -> Running {
        let mut child = Command::new(macvmm())
            .args(args)
            .envs(env.iter().copied())
            .env_remove("MACVMM_LOG")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn macvmm");
        let start = Instant::now();
        let mut threads = Vec::new();
        let out = if read_stdout {
            let (buf, t) = reader(child.stdout.take().unwrap());
            threads.push(t);
            Some(buf)
        } else {
            None // the pipe stays open, unread, in `child.stdout`
        };
        let (err, t) = reader(child.stderr.take().unwrap());
        threads.push(t);
        let stdin = child.stdin.take();
        Running {
            child,
            stdin,
            out,
            err,
            threads,
            start,
        }
    }

    /// Wait until stdout contains `marker` (or `limit` passes, or the child exits).
    pub fn wait_for(&mut self, marker: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(out) = &self.out
                && String::from_utf8_lossy(&out.lock().unwrap()).contains(marker)
            {
                return true;
            }
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        false
    }

    /// Wait until stderr (the VMM's own lines) contains `marker` (or `limit` passes, or the
    /// child exits). M21: a readiness marker, so a test never has to probe a lock itself.
    pub fn wait_for_stderr(&mut self, marker: &str, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if String::from_utf8_lossy(&self.err.lock().unwrap()).contains(marker) {
                return true;
            }
            if self.child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        String::from_utf8_lossy(&self.err.lock().unwrap()).contains(marker)
    }

    /// Write `bytes` to the child's stdin.
    pub fn send(&mut self, bytes: &[u8]) {
        if let Some(s) = self.stdin.as_mut() {
            let _ = s.write_all(bytes);
            let _ = s.flush();
        }
    }

    /// Send signal `sig` (`TERM`, `INT`, `USR1`, ...) with `/bin/kill`.
    pub fn signal(&self, sig: &str) {
        let st = Command::new("/bin/kill")
            .arg(format!("-{sig}"))
            .arg(self.child.id().to_string())
            .status()
            .expect("kill");
        assert!(st.success(), "kill -{sig} failed");
    }

    /// Wait for the exit (hard kill after `limit`); returns the outcome and the moment it
    /// exited.
    pub fn finish(mut self, limit: Duration) -> (Outcome, Instant) {
        let deadline = Instant::now() + limit;
        let mut killed = false;
        let status = loop {
            if let Some(st) = self.child.try_wait().expect("wait") {
                break st;
            }
            if Instant::now() > deadline {
                let _ = self.child.kill();
                killed = true;
                break self.child.wait().expect("wait after kill");
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        let exited = Instant::now();
        drop(self.stdin.take());
        drop(self.child.stdout.take());
        for t in self.threads.drain(..) {
            t.join().unwrap();
        }
        let stdout = self
            .out
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.lock().unwrap()).into_owned())
            .unwrap_or_default();
        let stderr = String::from_utf8_lossy(&self.err.lock().unwrap()).into_owned();
        let o = Outcome {
            code: status.code(),
            stdout,
            stderr,
            wall: exited - self.start,
            killed,
        };
        (o, exited)
    }
}

/// Quote `s` for `/bin/sh` (single quotes; embedded quotes closed and escaped).
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// What a run inside a pseudo-terminal produced: everything the terminal received, raw.
#[derive(Debug)]
pub struct PtyOutcome {
    pub code: Option<i32>,
    pub bytes: Vec<u8>,
    pub wall: Duration,
    pub killed: bool,
}

impl PtyOutcome {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
    /// The bytes with controls made visible, for assertion messages.
    pub fn dump(&self) -> String {
        format!(
            "exit {:?} (killed {}) after {:?}\n--- terminal ---\n{}",
            self.code,
            self.killed,
            self.wall,
            self.bytes.escape_ascii()
        )
    }
}

/// Run `/bin/sh -c <shell>` inside a real pseudo-terminal (`script -q /dev/null`), so macvmm
/// sees a TTY on stdin and stdout (TEST-8). `steps` drive its stdin (`WaitFor` matches the
/// terminal output). Stdin stays open until the shell exits; hard kill after `limit`.
pub fn run_in_pty(shell: &str, steps: &[Step], limit: Duration) -> PtyOutcome {
    let start = Instant::now();
    let deadline = start + limit;
    let mut child = Command::new("/usr/bin/script")
        .args(["-q", "/dev/null", "/bin/sh", "-c", shell])
        .env_remove("MACVMM_LOG")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn script(1)");
    let (out, out_t) = reader(child.stdout.take().unwrap());
    let (_err, err_t) = reader(child.stderr.take().unwrap());
    let mut stdin = child.stdin.take();
    for step in steps {
        match step {
            Step::WaitFor(m) => {
                while !String::from_utf8_lossy(&out.lock().unwrap()).contains(m) {
                    if Instant::now() > deadline || child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            Step::Send(bytes) => {
                if let Some(s) = stdin.as_mut() {
                    let _ = s.write_all(bytes);
                    let _ = s.flush();
                }
            }
            Step::Sleep(ms) => std::thread::sleep(Duration::from_millis(*ms)),
        }
    }
    let mut killed = false;
    let status = loop {
        if let Some(st) = child.try_wait().expect("wait") {
            break st;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            killed = true;
            break child.wait().expect("wait after kill");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    drop(stdin);
    out_t.join().unwrap();
    err_t.join().unwrap();
    let bytes = out.lock().unwrap().clone();
    PtyOutcome {
        code: status.code(),
        bytes,
        wall: start.elapsed(),
        killed,
    }
}

// ---- M10 helpers: fetched artifacts (PLAN §0.3, §0.4) ----

/// The download cache: `${MACVMM_CACHE:-<repo>/.cache/macvmm}`. A relative `MACVMM_CACHE` is
/// taken relative to the repo root (a test's cwd is its crate directory, which means nothing
/// to the user), as `scripts/run-linux.sh` does by resolving it from the repo root.
///
/// An existing cache directory gets the SC-3 checks of `scripts/lib/common.sh` `cache_dir`: not
/// a symlink, a directory, owned by the current uid, not group- or world-writable; a failure
/// panics with the same message. It is not created here: nothing is fetched by a test.
pub fn cache_dir() -> PathBuf {
    let c = match std::env::var_os("MACVMM_CACHE") {
        Some(c) if Path::new(&c).is_absolute() => PathBuf::from(c),
        Some(c) => repo_root().join(c),
        None => repo_root().join(".cache/macvmm"),
    };
    let Ok(md) = std::fs::symlink_metadata(&c) else {
        return c; // absent: `artifact` reports the missing file
    };
    let shown = c.display();
    assert!(
        !md.file_type().is_symlink(),
        "cache dir {shown} is a symlink; refusing (SC-3)"
    );
    assert!(md.is_dir(), "cache dir {shown} is not a directory (SC-3)");
    {
        use std::os::unix::fs::MetadataExt;
        let uid = current_uid();
        assert_eq!(
            md.uid(),
            uid,
            "cache dir {shown} is owned by uid {}, not {uid} (SC-3)",
            md.uid()
        );
        assert_eq!(
            md.mode() & 0o022,
            0,
            "cache dir {shown} is group- or world-writable (mode {:o}); run: chmod 700 '{shown}' (SC-3)",
            md.mode() & 0o7777
        );
    }
    c
}

/// The current uid, from `/usr/bin/id -u` (test code stays free of `unsafe`, so no `getuid`).
fn current_uid() -> u32 {
    static UID: OnceLock<u32> = OnceLock::new();
    *UID.get_or_init(|| {
        let out = Command::new("/usr/bin/id")
            .arg("-u")
            .env_clear()
            .output()
            .expect("run /usr/bin/id -u");
        assert!(out.status.success(), "/usr/bin/id -u failed");
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .expect("numeric uid from /usr/bin/id -u")
    })
}

/// The fetched artifact `name` of fetch set `set`, as a path in [`cache_dir`]. It must be a
/// regular file and not a symlink (checked with `symlink_metadata`, so a link is not followed);
/// a symlink panics as a refusal. A missing artifact **fails** the test with
/// `missing artifact X: run scripts/fetch.sh <set>` (PLAN §0.3); only with
/// `MACVMM_E2E_ALLOW_SKIP=1` (hosted CI) does it return `None` so the test can skip. macvmm's
/// own `O_NOFOLLOW_ANY` open (PATH-2, `hostio.rs`) stays the enforcing check at run time.
pub fn artifact(name: &str, set: &str) -> Option<String> {
    let p = cache_dir().join(name);
    if let Ok(md) = std::fs::symlink_metadata(&p) {
        let ft = md.file_type();
        assert!(
            !ft.is_symlink(),
            "artifact {} is a symlink; refusing (SC-3)",
            p.display()
        );
        assert!(
            ft.is_file(),
            "artifact {} is not a regular file",
            p.display()
        );
        return Some(p.to_string_lossy().into_owned());
    }
    if std::env::var_os("MACVMM_E2E_ALLOW_SKIP").is_some_and(|v| v == "1") {
        eprintln!("SKIP: missing artifact {name}: run scripts/fetch.sh {set}");
        return None;
    }
    panic!("missing artifact {name}: run scripts/fetch.sh {set}");
}
