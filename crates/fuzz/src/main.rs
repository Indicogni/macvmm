//! `cargo run -p fuzz --release -- <target>|all|list [--seconds S] [--iters N] [--seed N]
//! [--timeout-ms MS] [--replay FILE]`: the fuzz driver (PLAN M22; threat model TEST-3).
//!
//! **Loop.** Iteration `i` derives its generator from `(seed, i)` (`Rng::derive`), draws a fresh
//! well-formed input from the target's seed generator, applies one to eight mutations (generic
//! byte mutators and the target's structural ones, `mutate.rs`), and runs the target. A panic or
//! a violated invariant is a **failure**: the input is saved to `target/fuzz/crashes/` (directory
//! 0700, file 0600, never overwritten) and the run stops for that target. The summary line is
//! `fuzz <target>: <iters> iterations, <n> failures` and the exit code is 1 if any target failed.
//!
//! **Hangs.** A watchdog thread checks that every iteration finishes within `--timeout-ms`
//! (default 2000; the `virtqueue_race` invariant is "no hang over 1 s"). On a hang it saves the
//! input, prints `HANG` and exits 1: a stuck walk cannot be interrupted from inside safe Rust,
//! and a hang *is* the finding (a missing hop budget, threat model VQ-5).
//!
//! **Replay.** `--replay F` runs one saved input and prints the verdict. Every crash becomes a
//! regression case in the matching `crates/vmm/tests/*_hostile.rs` (TEST-3).
#![forbid(unsafe_code)]

use fuzz::rng::Rng;
use fuzz::{Target, targets};
use std::io::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const USAGE: &str = "\
usage: fuzz <target>|all|list [--seconds S] [--iters N] [--seed N] [--timeout-ms MS]
       fuzz <target> --replay FILE
  --seconds S     run each target for S seconds (default 10)
  --iters N       stop after N iterations (whichever comes first)
  --seed N        the run's seed (default 1); iteration i is reproducible from (N, i)
  --timeout-ms MS one iteration longer than this is a hang (default 2000)
  --replay FILE   run FILE once and report";

struct Opts {
    which: String,
    seconds: u64,
    iters: u64,
    seed: u64,
    timeout: Duration,
    replay: Option<PathBuf>,
}

fn say(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

fn warn(line: &str) {
    let _ = writeln!(std::io::stderr(), "{line}");
}

fn parse_args(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts {
        which: String::new(),
        seconds: 10,
        iters: u64::MAX,
        seed: 1,
        timeout: Duration::from_millis(2000),
        replay: None,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut num = |name: &str| -> Result<u64, String> {
            it.next()
                .ok_or(format!("{name} needs a value"))?
                .parse()
                .map_err(|_| format!("{name}: not a number"))
        };
        match a.as_str() {
            "--seconds" => o.seconds = num("--seconds")?,
            "--iters" => o.iters = num("--iters")?,
            "--seed" => o.seed = num("--seed")?,
            "--timeout-ms" => o.timeout = Duration::from_millis(num("--timeout-ms")?),
            "--replay" => o.replay = Some(PathBuf::from(it.next().ok_or("--replay needs a file")?)),
            s if s.starts_with('-') => return Err(format!("unknown option {s}")),
            s if o.which.is_empty() => o.which = s.to_string(),
            s => return Err(format!("unexpected argument {s}")),
        }
    }
    if o.which.is_empty() {
        return Err("missing target".into());
    }
    Ok(o)
}

/// The panic message of the last panic on this process, captured by the hook.
static PANIC: Mutex<Option<String>> = Mutex::new(None);

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = info.to_string();
        if let Ok(mut p) = PANIC.lock() {
            *p = Some(msg);
        }
    }));
}

/// Run `t` on `input`: `Err` for a panic or a violated invariant.
fn run_one(t: &Target, input: &[u8]) -> Result<(), String> {
    match catch_unwind(AssertUnwindSafe(|| (t.run)(input))) {
        Ok(v) => v,
        Err(_) => Err(format!(
            "panic: {}",
            PANIC
                .lock()
                .ok()
                .and_then(|p| p.clone())
                .unwrap_or_default()
        )),
    }
}

/// `target/fuzz/crashes/` (created 0700).
fn crash_dir() -> PathBuf {
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"));
    target.join("fuzz").join("crashes")
}

/// Save a failing input (0600, never overwriting) and return its path.
fn save(name: &str, seed: u64, iter: u64, input: &[u8]) -> Option<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let dir = crash_dir();
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir);
    for k in 0..100u32 {
        let p = dir.join(format!("{name}-seed{seed}-iter{iter}-{k}.bin"));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&p)
        {
            return f.write_all(input).ok().map(|()| p);
        }
    }
    None
}

/// The watchdog's view of the running iteration.
struct Watch {
    name: Mutex<&'static str>,
    started_ms: AtomicU64,
    iter: AtomicU64,
    input: Mutex<Vec<u8>>,
}

fn now_ms(epoch: Instant) -> u64 {
    u64::try_from(epoch.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn spawn_watchdog(watch: Arc<Watch>, epoch: Instant, timeout: Duration, seed: u64) {
    let limit = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(50));
            let start = watch.started_ms.load(Ordering::SeqCst);
            if start == u64::MAX {
                continue;
            }
            if now_ms(epoch).saturating_sub(start) > limit {
                let name = watch.name.lock().map(|n| *n).unwrap_or("?");
                let iter = watch.iter.load(Ordering::SeqCst);
                let input = watch.input.lock().map(|i| i.clone()).unwrap_or_default();
                let saved = save(name, seed, iter, &input);
                say(&format!(
                    "fuzz {name}: HANG at iteration {iter} (> {limit} ms); input saved to {}",
                    saved.map_or("<not saved>".into(), |p| p.display().to_string())
                ));
                say(&format!("fuzz {name}: {iter} iterations, 1 failures"));
                std::process::exit(1);
            }
        }
    });
}

// ANCHOR: fuzz_loop
/// Fuzz one target; returns the number of failures (0 or 1: the run stops at the first).
fn fuzz(t: &'static Target, o: &Opts, watch: &Watch, epoch: Instant) -> u64 {
    let deadline = Instant::now() + Duration::from_secs(o.seconds);
    if let Ok(mut n) = watch.name.lock() {
        *n = t.name;
    }
    let mut iters = 0u64;
    while iters < o.iters && Instant::now() < deadline {
        let mut rng = Rng::derive(o.seed, iters);
        let mut input = (t.seed)(&mut rng);
        let rounds = rng.below(9);
        for _ in 0..rounds {
            if rng.coin() {
                (t.mutate)(&mut rng, &mut input);
            } else {
                fuzz::mutate::bytes(&mut rng, &mut input, t.max_len);
            }
        }
        input.truncate(t.max_len);
        if let Ok(mut w) = watch.input.lock() {
            w.clone_from(&input);
        }
        watch.iter.store(iters, Ordering::SeqCst);
        watch.started_ms.store(now_ms(epoch), Ordering::SeqCst);
        let r = run_one(t, &input);
        watch.started_ms.store(u64::MAX, Ordering::SeqCst);
        iters += 1;
        if let Err(e) = r {
            let saved = save(t.name, o.seed, iters - 1, &input);
            say(&format!(
                "fuzz {}: FAILURE at iteration {} (seed {}): {e}",
                t.name,
                iters - 1,
                o.seed
            ));
            say(&format!(
                "fuzz {}: input saved to {} (replay: cargo run -p fuzz --release -- {} --replay FILE)",
                t.name,
                saved.map_or("<not saved>".into(), |p| p.display().to_string()),
                t.name
            ));
            say(&format!("fuzz {}: {iters} iterations, 1 failures", t.name));
            return 1;
        }
    }
    say(&format!("fuzz {}: {iters} iterations, 0 failures", t.name));
    0
}
// ANCHOR_END: fuzz_loop

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "-h" || a == "--help") {
        say(USAGE);
        return std::process::ExitCode::SUCCESS;
    }
    let o = match parse_args(&args) {
        Ok(o) => o,
        Err(e) => {
            warn(&format!("fuzz: {e}"));
            warn(USAGE);
            return std::process::ExitCode::from(2);
        }
    };
    // Guest-triggered warnings are expected by the million here; keep stderr quiet.
    vmm::log::set_max_level(None);
    if o.which == "list" {
        for t in targets() {
            say(t.name);
        }
        return std::process::ExitCode::SUCCESS;
    }
    install_panic_hook();
    let chosen: Vec<&'static Target> = if o.which == "all" {
        targets().iter().collect()
    } else {
        match fuzz::find(&o.which) {
            Some(t) => vec![t],
            None => {
                warn(&format!("fuzz: no target {:?} (try `list`)", o.which));
                return std::process::ExitCode::from(2);
            }
        }
    };
    if let Some(path) = &o.replay {
        let Ok(input) = std::fs::read(path) else {
            warn(&format!("fuzz: cannot read {}", path.display()));
            return std::process::ExitCode::from(2);
        };
        let mut failed = false;
        for t in &chosen {
            match run_one(t, &input) {
                Ok(()) => say(&format!("fuzz {}: replay OK", t.name)),
                Err(e) => {
                    failed = true;
                    say(&format!("fuzz {}: replay FAILED: {e}", t.name));
                }
            }
        }
        return std::process::ExitCode::from(u8::from(failed));
    }
    let epoch = Instant::now();
    let watch = Arc::new(Watch {
        name: Mutex::new(""),
        started_ms: AtomicU64::new(u64::MAX),
        iter: AtomicU64::new(0),
        input: Mutex::new(Vec::new()),
    });
    spawn_watchdog(Arc::clone(&watch), epoch, o.timeout, o.seed);
    let failures: u64 = chosen.iter().map(|t| fuzz(t, &o, &watch, epoch)).sum();
    std::process::ExitCode::from(u8::from(failures > 0))
}
