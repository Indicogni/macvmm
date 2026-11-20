//! E2E suite `vmapple` (PLAN M21 "Acceptance: on machine"; stage S1 of
//! `docs/macos-guest-requirements.md`; ADR-0008 decision 3, ADR-0009; course ch24).
//!
//! ```text
//! scripts/test-e2e.sh vmapple
//! # = cargo test -p macvmm --features hvf-tests --test e2e_vmapple -- --test-threads=1
//! #   the default build: `--machine vmapple` exits 2, TEST-11, the HV_DENIED probe
//! cargo test -p macvmm --features hvf-tests,experimental-vmapple --test e2e_vmapple -- --test-threads=1
//! #   the experimental build: AVPBooter's first exit and device accesses, the SLA lock
//! ```
//!
//! **What is asserted, and what is not.** The claim of S1 is only "AVPBooter executes in
//! macvmm, and we observe its first device accesses". So the tests check the VMM's own stderr
//! verdicts (which no guest byte reaches, AS10): the first exit's PC lies inside the ROM
//! (`0x10_0000..0x20_0000`), and the run ends with either the unknown-MMIO summary or the
//! unsupported-HVC stop. Nothing here, or anywhere, says that macOS boots (ADR-0008 decision 1).
//!
//! **The SLA lock lives under `$HOME`** (ADR-0008 decision 6): every vmapple run here sets
//! `HOME` to the test's scratch directory, so the suite neither holds the user's real slots nor
//! collides with another checkout's run.
//!
//! **AVPBooter is never copied** (TEST-11, SLA §2B/§2N, PLAN D4). The ROM is read in place from
//! the system path; `avpbooter_never_copied` hashes every file of the same size in the repo and
//! the cache and fails if one is AVPBooter. The JSONL trace holds exit records only (numbers).
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use support::{cache_dir, repo_root, run_steps_env, scratch};

/// The system copy of the vmapple boot ROM (`vmm::loader::firmware::AVPBOOTER_VMAPPLE2`).
const AVPBOOTER: &str = "/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin";

/// The ROM window the first exit must fall in (PLAN M21).
#[cfg(feature = "experimental-vmapple")]
const ROM: std::ops::Range<u64> = 0x10_0000..0x20_0000;

fn avpbooter() -> Option<&'static str> {
    if Path::new(AVPBOOTER).is_file() {
        return Some(AVPBOOTER);
    }
    if std::env::var_os("MACVMM_E2E_ALLOW_SKIP").is_some_and(|v| v == "1") {
        eprintln!("SKIP: {AVPBOOTER} is missing (Virtualization.framework, macOS 12+)");
        return None;
    }
    panic!("{AVPBOOTER} is missing: this Mac's Virtualization.framework has no vmapple ROM");
}

/// `shasum -a 256 FILE` → the hex digest.
fn sha256(p: &Path) -> String {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(p)
        .output()
        .expect("run shasum");
    assert!(out.status.success(), "shasum {}", p.display());
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

/// Every regular file under `dir` (symlinks are not followed), skipping `.git`.
fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_dir() && e.file_name() != ".git" {
            walk(&p, out);
        } else if ft.is_file()
            && let Ok(md) = e.metadata()
        {
            out.push((p, md.len()));
        }
    }
}

/// PLAN M21 / threat model TEST-11: no file in the repo (build outputs included) or in the
/// download cache is AVPBooter. Only files of exactly its size can be copies, so only those are
/// hashed.
#[test]
fn avpbooter_never_copied() {
    let Some(rom) = avpbooter() else { return };
    let rom = Path::new(rom);
    let size = std::fs::metadata(rom).unwrap().len();
    let digest = sha256(rom);
    let mut files = Vec::new();
    walk(&repo_root(), &mut files);
    walk(&cache_dir(), &mut files);
    let mut hashed = 0;
    for (p, len) in files.iter().filter(|(_, len)| *len == size) {
        hashed += 1;
        assert_ne!(
            sha256(p),
            digest,
            "{} ({len} bytes) is a copy of AVPBooter: Apple software must never be copied \
             into the repo or the cache (ADR-0008 decision 3, TEST-11)",
            p.display()
        );
    }
    eprintln!(
        "avpbooter_never_copied: {} files scanned, {hashed} of AVPBooter's size ({size} bytes) \
         hashed, none matches sha256 {}…",
        files.len(),
        &digest[..12]
    );
    assert!(files.len() > 100, "the walk found almost nothing");
}

/// PLAN M21: the stand-alone probe shows the private Apple-ISA mode is refused.
#[test]
fn hv_denied_probe() {
    let out = Command::new(repo_root().join("tools/hv-denied-probe/run.sh"))
        .output()
        .expect("run tools/hv-denied-probe/run.sh");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("hv_vm_create with private ISA 3: HV_DENIED (0xfae94007)"),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(out.status.code(), Some(0));
}

/// PLAN M21: the default build refuses `--machine vmapple` with exit code 2.
#[cfg(not(feature = "experimental-vmapple"))]
#[test]
fn vmapple_needs_the_feature() {
    let t = scratch("vmapple_needs_the_feature");
    let o = run_steps_env(
        &["run", "--machine", "vmapple", "--timeout", "5"],
        &[("MACVMM_CACHE", &t), ("HOME", &t)],
        &[],
        Duration::from_secs(5),
    );
    assert_eq!(o.code, Some(2), "{}", o.dump());
    assert!(
        o.stderr.contains("built without experimental-vmapple"),
        "{}",
        o.dump()
    );
    // Nothing was locked or created: the refusal comes before HostIo.
    assert!(!t.join(".cache").exists());
    assert!(!t.join("vmapple-slots").exists());
}

/// The decimal number right before `marker` in `hay` (`vmapple: 34 unknown MMIO ...`).
#[cfg(feature = "experimental-vmapple")]
fn count_before(hay: &str, marker: &str) -> Option<u64> {
    let head = &hay[..hay.find(marker)?];
    let digits: String = head
        .chars()
        .rev()
        .take_while(char::is_ascii_digit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().ok()
}

/// The hex number after `marker` in `hay`.
#[cfg(feature = "experimental-vmapple")]
fn hex_after(hay: &str, marker: &str) -> Option<u64> {
    let rest = &hay[hay.find(marker)? + marker.len()..];
    let hex: String = rest
        .trim_start_matches("0x")
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .collect();
    u64::from_str_radix(&hex, 16).ok()
}

/// The PLAN M21 acceptance run:
/// `run --machine vmapple --bios <AVPBooter> --mem 4G --unhandled-mmio log
///  --trace exits:$T/avp.jsonl --timeout 20`.
#[cfg(feature = "experimental-vmapple")]
#[test]
fn vmapple_first_probe() {
    let Some(rom) = avpbooter() else { return };
    let t = scratch("vmapple_first_probe");
    let trace = t.join("avp.jsonl");
    let trace_arg = format!("exits:{}", trace.display());
    let o = run_steps_env(
        &[
            "run",
            "--machine",
            "vmapple",
            "--bios",
            rom,
            "--mem",
            "4G",
            "--unhandled-mmio",
            "log",
            "--trace",
            &trace_arg,
            "--timeout",
            "20",
        ],
        &[("MACVMM_CACHE", &t), ("HOME", &t)],
        &[],
        Duration::from_secs(20),
    );
    eprintln!("{}", o.dump());
    let pc = hex_after(&o.stderr, "vmapple: first exit at pc=").expect("no first-exit line");
    assert!(ROM.contains(&pc), "first exit at {pc:#x}, outside the ROM");
    // The summary is printed on every run, even for 0: only N >= 1 (with a matching per-access
    // line and per-row totals) shows the watch saw device accesses, unless an HVC stopped it.
    let logged = count_before(&o.stderr, " unknown MMIO accesses logged")
        .expect("no unknown-MMIO summary line");
    let hvc = o.stderr.contains("vmapple: stopped at unsupported HVC 0x");
    assert!(logged >= 1 || hvc, "neither verdict:\n{}", o.dump());
    if logged >= 1 {
        assert!(
            o.stderr.contains("vmapple: unknown MMIO #1: pc=0x"),
            "{}",
            o.dump()
        );
        assert!(
            o.stderr
                .contains(&format!("vmapple: unknown MMIO #{logged}: pc=0x")),
            "{}",
            o.dump()
        );
        let per_row: u64 = o
            .stderr
            .lines()
            .filter_map(|l| l.split("vmapple:   ").nth(1))
            .filter_map(|r| r.split(" in ").next()?.parse::<u64>().ok())
            .sum();
        assert_eq!(per_row, logged, "per-row totals:\n{}", o.dump());
    }
    // 5: still running at the timeout; 3: the logger's cap or an unsupported HVC stopped it.
    assert!(matches!(o.code, Some(3 | 5)), "{}", o.dump());
    // The trace's first record is that same exit, and it holds numbers only.
    let jsonl = std::fs::read_to_string(&trace).unwrap();
    let first = jsonl.lines().next().expect("empty trace");
    assert!(first.contains(&format!("\"pc\":\"{pc:#x}\"")), "{first}");
    assert!(jsonl.is_ascii());
    assert!(!o.stderr.to_lowercase().contains("boots"));
}

/// With the default `--unhandled-mmio fatal`, the first unknown access is logged and stops
/// the VM with exit code 3, exactly as on `virt`.
#[cfg(feature = "experimental-vmapple")]
#[test]
fn vmapple_fatal_by_default() {
    let Some(rom) = avpbooter() else { return };
    let t = scratch("vmapple_fatal_by_default");
    let o = run_steps_env(
        &[
            "run",
            "--machine",
            "vmapple",
            "--bios",
            rom,
            "--timeout",
            "20",
        ],
        &[("MACVMM_CACHE", &t), ("HOME", &t)],
        &[],
        Duration::from_secs(20),
    );
    assert_eq!(o.code, Some(3), "{}", o.dump());
    assert!(o.stderr.contains("unhandled MMIO"), "{}", o.dump());
    assert!(
        o.stderr.contains("vmapple: 1 unknown MMIO accesses logged"),
        "{}",
        o.dump()
    );
}

/// ADR-0008 decision 6 (PATH-7): two vmapple instances hold the two slots; a third is refused
/// with exit code 2 before any VM is created. The lock directory is 0700.
///
/// The test never probes a lock itself (a successful `try_lock` from here would *take* the
/// slot, and a starting instance could then find both busy): each instance is known to hold
/// its slot once it prints its first-exit line, because `HostIo::open` takes the slot before
/// any HVF call.
#[cfg(feature = "experimental-vmapple")]
#[test]
fn vmapple_third_instance_refused() {
    use std::os::unix::fs::PermissionsExt;
    use support::Running;
    let Some(rom) = avpbooter() else { return };
    let t = scratch("vmapple_third_instance_refused");
    let env = [("MACVMM_CACHE", t.as_path()), ("HOME", t.as_path())];
    let args = [
        "run",
        "--machine",
        "vmapple",
        "--bios",
        rom,
        "--unhandled-mmio",
        "log",
        "--serial",
        "none",
        "--timeout",
        "30",
    ];
    let ready = "vmapple: first exit at pc=";
    let mut a = Running::spawn_env(&args, &env, true);
    assert!(
        a.wait_for_stderr(ready, Duration::from_secs(15)),
        "A never ran"
    );
    let mut b = Running::spawn_env(&args, &env, true);
    assert!(
        b.wait_for_stderr(ready, Duration::from_secs(15)),
        "B never ran"
    );
    let slots = t.join(".cache/macvmm/vmapple-slots");
    let mode = std::fs::metadata(&slots).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o700);
    let c = run_steps_env(&args, &env, &[], Duration::from_secs(10));
    assert_eq!(c.code, Some(2), "{}", c.dump());
    assert!(c.stderr.contains("macOS-VM slots"), "{}", c.dump());
    for r in [a, b] {
        r.signal("TERM");
        let (o, _) = r.finish(Duration::from_secs(10));
        assert_eq!(o.code, Some(130), "{}", o.dump());
    }
}

/// Review fix (ADR-0008 decision 6): the slots are per user, not per directory. With both of
/// this `HOME`'s slots held, a run from another working directory with another `MACVMM_CACHE`
/// is still refused, and creates no lock directory of its own; freeing one slot lets it start.
/// `--dry-run` takes the slot like a real run (in `HostIo::open`) but creates no VM.
#[cfg(feature = "experimental-vmapple")]
#[test]
fn vmapple_slots_are_per_user() {
    use std::os::unix::fs::DirBuilderExt;
    let Some(rom) = avpbooter() else { return };
    let t = scratch("vmapple_slots_are_per_user");
    let slots = t.join(".cache/macvmm/vmapple-slots");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&slots)
        .unwrap();
    // Held by this test process, the way two running instances would hold them.
    let hold = |i: u32| {
        let f = std::fs::File::create(slots.join(format!("{i}.lock"))).unwrap();
        f.try_lock().unwrap();
        f
    };
    let held = [hold(0), hold(1)];
    let other = t.join("other");
    std::fs::create_dir_all(&other).unwrap();
    let dry = || {
        Command::new(support::macvmm())
            .args(["run", "--machine", "vmapple", "--bios", rom, "--dry-run"])
            .current_dir(&other)
            .env("HOME", &t)
            .env("MACVMM_CACHE", other.join("cache"))
            .env_remove("MACVMM_LOG")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("run macvmm")
    };
    let o = dry();
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(2), "{err}");
    assert!(err.contains("macOS-VM slots"), "{err}");
    assert!(!other.join("cache/vmapple-slots").exists());
    assert!(!other.join(".cache").exists());
    let [first, _second] = held;
    drop(first);
    let o = dry();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&o.stderr)
    );
    assert!(String::from_utf8_lossy(&o.stdout).contains("macvmm vmapple board (dry run"));
}
