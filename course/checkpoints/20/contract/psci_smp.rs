// Checkpoint 20 contract tests, frozen from the reference test crates/vmm/tests/psci_smp.rs.
// It names items chapters 08, 10 and 20 teach; the harness runs it against your crates.
//! Host test: PSCI under SMP races, and the SMP machine description (PLAN M16 "Acceptance:
//! host" and "Security tests"; architecture §8.1, §8.6, §12.2; Arm DEN 0022 §5.1.3–5.1.5;
//! threat model HC-3, HC-4).
//!
//! With `--cpus N` every vCPU has its own host thread, so PSCI calls arrive concurrently. The
//! state machine (`Off → OnPending → On → Off`) must stay exact under that:
//!
//! - **One winner.** Eight threads racing CPU_ON at one target: exactly one SUCCESS; every
//!   other call is ALREADY_ON (-4) or ON_PENDING (-5), never a second start (HC-3). The target
//!   is a real parked "vCPU" thread that takes its mailbox partway through the race, staged so
//!   that every round asserts at least two of each refusal (the test's own docs say how).
//! - **CPU_OFF then CPU_ON** restarts the CPU, many times over, with the mailbox's entry and
//!   context each time.
//! - **AFFINITY_INFO** reports each transition (DEN 0022 §5.1.5: 0 ON, 1 OFF, 2 ON_PENDING),
//!   and while racing, never reports a state the observer's own knowledge rules out.
//! - **mpidr_for_index**, and the 4-CPU, 1 GiB device tree against its golden file
//!   (`tests/golden/virt-4cpu-1g.dts`, what `macvmm run --cpus 4 --mem 1G --kernel <test guest>
//!   --dtb-out F` writes; compared when `dtc` is installed, `MACVMM_BLESS_GOLDEN=1` rewrites).
//!
//! The PLAN's security test runs this file 100 times under `--release`:
//! `scripts/test-psci-smp-loop.sh` (stops at the first failing run).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use vmm::arch::layout::Layout;
use vmm::arch::regs::mpidr;
use vmm::backend::entropy::Entropy;
use vmm::fdt::machine::RNG_SEED_LEN;
use vmm::fdt::{MachineDesc, build_dtb, redact_seeds};
use vmm::psci::{CpuPower, PowerOn, Psci, PsciError};

const ENTRY: u64 = 0x4008_0000;

fn machine(n: usize) -> Arc<Psci> {
    let mpidrs: Vec<u64> = (0..n).map(mpidr).collect();
    Arc::new(Psci::new(&mpidrs))
}

/// The affinity (PSCI `target_cpu`) of vCPU `i`: the MPIDR without bit 31.
fn aff(i: usize) -> u64 {
    mpidr(i) & vmm::psci::AFFINITY_MASK
}

fn info(p: &Psci, i: usize) -> u64 {
    p.affinity_info(aff(i), 0).unwrap().affinity_info()
}

/// How many rounds `eight_threads_race_cpu_on` runs. Each round is a fresh machine; the
/// scripted 100-run loop under `--release` (`scripts/test-psci-smp-loop.sh`) multiplies it.
const RACE_ROUNDS: usize = 500;

/// PLAN M16: 8 threads race CPU_ON on the same target while the target's own thread parks
/// and takes its mailbox partway through the race: exactly one SUCCESS, the rest ALREADY_ON or
/// ON_PENDING, and both refusals occur in every round.
///
/// How the target is made to take its mailbox mid-race, deterministically:
/// - racers 0..6 are released together by one barrier;
/// - the target thread parks once 3 of them have returned. Those 3 calls ended before it took
///   the mailbox, so the refusals among them (at least 2: one SUCCESS at most) are ON_PENDING;
/// - racers 6 and 7 call only after the target took its mailbox, so they are ALREADY_ON;
/// - the remaining racers 0..6 race the target's take: either refusal is right for them.
#[test]
fn eight_threads_race_cpu_on() {
    let (mut pending_total, mut already_total) = (0usize, 0usize);
    for round in 0..RACE_ROUNDS {
        let p = machine(4);
        let start = Arc::new(Barrier::new(7));
        let returned = Arc::new(AtomicU64::new(0));
        let taken = Arc::new(AtomicBool::new(false));
        // The target "vCPU" 3: parks after 3 racers returned, then reports the take.
        let target = {
            let (p, start, returned, taken) = (
                Arc::clone(&p),
                Arc::clone(&start),
                Arc::clone(&returned),
                Arc::clone(&taken),
            );
            std::thread::spawn(move || {
                start.wait();
                while returned.load(Ordering::SeqCst) < 3 {
                    std::hint::spin_loop();
                }
                let on = p.park(3, || false);
                taken.store(true, Ordering::SeqCst);
                on
            })
        };
        let racers: Vec<_> = (0..8u64)
            .map(|ctx| {
                let (p, start, returned, taken) = (
                    Arc::clone(&p),
                    Arc::clone(&start),
                    Arc::clone(&returned),
                    Arc::clone(&taken),
                );
                std::thread::spawn(move || {
                    if ctx < 6 {
                        start.wait();
                    } else {
                        while !taken.load(Ordering::SeqCst) {
                            std::hint::spin_loop();
                        }
                    }
                    let r = p.cpu_on(aff(3), ENTRY, ctx, true);
                    // Ordering: the count is bumped after the call returned, so the target's
                    // `returned >= 3` means 3 calls finished before it parked.
                    let early = returned.fetch_add(1, Ordering::SeqCst) < 3;
                    (r, early)
                })
            })
            .collect();
        let results: Vec<_> = racers.into_iter().map(|t| t.join().unwrap()).collect();
        let on = target.join().unwrap().expect("the target was started");
        let wins: Vec<_> = results.iter().filter(|(r, _)| r.is_ok()).collect();
        assert_eq!(wins.len(), 1, "round {round}: {results:?}");
        assert_eq!(wins[0].0, Ok(3));
        for (i, (r, early)) in results.iter().enumerate() {
            assert!(
                matches!(
                    r,
                    Ok(3) | Err(PsciError::AlreadyOn) | Err(PsciError::OnPending)
                ),
                "round {round}: racer {i}: {r:?}"
            );
            // Returned before the take: SUCCESS or ON_PENDING, never ALREADY_ON.
            if *early {
                assert_ne!(*r, Err(PsciError::AlreadyOn), "round {round}: racer {i}");
            }
            // Called after the take: ALREADY_ON.
            if i >= 6 {
                assert_eq!(*r, Err(PsciError::AlreadyOn), "round {round}: racer {i}");
            }
        }
        let pending = results
            .iter()
            .filter(|(r, _)| *r == Err(PsciError::OnPending))
            .count();
        let already = results
            .iter()
            .filter(|(r, _)| *r == Err(PsciError::AlreadyOn))
            .count();
        assert!(pending >= 2, "round {round}: {results:?}");
        assert!(already >= 2, "round {round}: {results:?}");
        pending_total += pending;
        already_total += already;
        assert!(on.ctx < 6 && on.entry == ENTRY);
        assert_eq!(p.state(3), Some(CpuPower::On));
        assert_eq!(info(&p, 3), 0);
    }
    // Implied by the per-round checks; kept as the across-rounds statement of coverage.
    assert!(pending_total >= 2 * RACE_ROUNDS && already_total >= 2 * RACE_ROUNDS);
}

/// CPU_OFF followed by CPU_ON works, and AFFINITY_INFO is right at every step.
#[test]
fn cpu_off_then_on_with_affinity_at_each_step() {
    let p = machine(4);
    let p2 = Arc::clone(&p);
    // vCPU 2's thread: park, take the PowerOn, "run", call CPU_OFF; five times. Three
    // rendezvous per cycle: it is running; the test allows the CPU_OFF; it is off.
    let sync = Arc::new(Barrier::new(2));
    let s2 = Arc::clone(&sync);
    let vcpu2 = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..5 {
            let on: PowerOn = p2.park(2, || false).unwrap();
            seen.push(on.ctx);
            s2.wait(); // running
            s2.wait(); // the "guest" calls CPU_OFF now
            assert!(p2.cpu_off(2), "CPU_OFF from an On vCPU");
            s2.wait(); // off
        }
        seen
    });
    for ctx in 0..5u64 {
        assert_eq!(info(&p, 2), 1, "OFF before CPU_ON {ctx}");
        assert_eq!(p.cpu_on(aff(2), ENTRY + 4 * ctx, ctx, true), Ok(2));
        // ON_PENDING until the thread took its mailbox, then ON.
        let s = info(&p, 2);
        assert!(s == 2 || s == 0, "after CPU_ON: {s}");
        sync.wait();
        assert_eq!(info(&p, 2), 0, "ON while running");
        assert_eq!(p.cpu_on(aff(2), ENTRY, 0, true), Err(PsciError::AlreadyOn));
        sync.wait();
        sync.wait();
        assert_eq!(info(&p, 2), 1, "OFF after CPU_OFF");
    }
    assert_eq!(vcpu2.join().unwrap(), vec![0, 1, 2, 3, 4]);
    // ON_PENDING is visible when nobody takes the mailbox.
    assert_eq!(p.cpu_on(aff(1), ENTRY, 9, true), Ok(1));
    assert_eq!(info(&p, 1), 2);
    assert_eq!(p.cpu_on(aff(1), ENTRY, 9, true), Err(PsciError::OnPending));
    assert_eq!(p.take_power_on(1).map(|o| o.ctx), Some(9));
    assert_eq!(info(&p, 1), 0);
    // The boot CPU is ON from the start; bad levels and targets are refused (HC-4, HC-3).
    assert_eq!(info(&p, 0), 0);
    assert_eq!(
        p.affinity_info(aff(0), 1),
        Err(PsciError::InvalidParameters)
    );
    assert_eq!(
        p.affinity_info(aff(4), 0),
        Err(PsciError::InvalidParameters)
    );
}

/// A CPU_ON storm from 4 threads at a target that keeps turning itself off again: the number
/// of SUCCESS answers equals the number of starts the target saw (never a double start), and
/// an observer polling AFFINITY_INFO only ever reads 0, 1 or 2.
#[test]
fn storm_against_a_cycling_target_starts_once_per_success() {
    let p = machine(8);
    let stop = Arc::new(AtomicBool::new(false));
    let starts = Arc::new(AtomicU64::new(0));
    let target = {
        let (p, stop, starts) = (Arc::clone(&p), Arc::clone(&stop), Arc::clone(&starts));
        std::thread::spawn(move || {
            while let Some(_on) = p.park(5, || stop.load(Ordering::SeqCst)) {
                starts.fetch_add(1, Ordering::SeqCst);
                // While it runs, it is ON to everyone.
                assert_eq!(p.state(5), Some(CpuPower::On));
                assert!(p.cpu_off(5));
            }
        })
    };
    let observer = {
        let (p, stop) = (Arc::clone(&p), Arc::clone(&stop));
        std::thread::spawn(move || {
            let mut seen = [0u64; 3];
            while !stop.load(Ordering::SeqCst) {
                let s = info(&p, 5);
                assert!(s <= 2, "AFFINITY_INFO {s}");
                seen[s as usize] += 1;
            }
            seen
        })
    };
    let deadline = Instant::now() + Duration::from_millis(300);
    let racers: Vec<_> = (0..4)
        .map(|_| {
            let p = Arc::clone(&p);
            std::thread::spawn(move || {
                let mut wins = 0u64;
                while Instant::now() < deadline {
                    match p.cpu_on(aff(5), ENTRY, 0, true) {
                        Ok(5) => wins += 1,
                        Err(PsciError::AlreadyOn | PsciError::OnPending) => {}
                        other => panic!("unexpected {other:?}"),
                    }
                }
                wins
            })
        })
        .collect();
    let wins: u64 = racers.into_iter().map(|t| t.join().unwrap()).sum();
    // Let the last start (if one is pending) finish its cycle, then stop the target.
    let quiet = Instant::now() + Duration::from_secs(5);
    while p.state(5) != Some(CpuPower::Off) && Instant::now() < quiet {
        std::thread::yield_now();
    }
    stop.store(true, Ordering::SeqCst);
    p.wake_all();
    target.join().unwrap();
    let seen = observer.join().unwrap();
    assert!(wins > 0, "the storm never started the target");
    assert_eq!(starts.load(Ordering::SeqCst), wins, "one start per SUCCESS");
    assert!(seen.iter().sum::<u64>() > 0);
}

/// CPU_ONs to different targets do not interfere (one mutex per target): 7 secondaries all
/// started at once by 7 threads, each exactly once.
#[test]
fn independent_targets_in_parallel() {
    let p = machine(8);
    let parked: Vec<_> = (1..8)
        .map(|i| {
            let p = Arc::clone(&p);
            std::thread::spawn(move || p.park(i, || false).map(|on| on.ctx))
        })
        .collect();
    let start = Arc::new(Barrier::new(7));
    let callers: Vec<_> = (1..8)
        .map(|i| {
            let (p, start) = (Arc::clone(&p), Arc::clone(&start));
            std::thread::spawn(move || {
                start.wait();
                p.cpu_on(aff(i), ENTRY, i as u64, true)
            })
        })
        .collect();
    for (i, c) in (1..8).zip(callers) {
        assert_eq!(c.join().unwrap(), Ok(i));
    }
    for (i, t) in (1..8u64).zip(parked) {
        assert_eq!(t.join().unwrap(), Some(i));
    }
    assert!((0..8).all(|i| p.state(i) == Some(CpuPower::On)));
}

/// A stop wakes every parked vCPU, on every target (`Psci::wake_all`).
#[test]
fn stop_wakes_every_parked_target() {
    let p = machine(16);
    let stop = Arc::new(AtomicBool::new(false));
    let parked: Vec<_> = (1..16)
        .map(|i| {
            let (p, stop) = (Arc::clone(&p), Arc::clone(&stop));
            std::thread::spawn(move || p.park(i, || stop.load(Ordering::SeqCst)))
        })
        .collect();
    std::thread::sleep(Duration::from_millis(20));
    // The VmControl::request_stop order: the flag first, then the wake.
    stop.store(true, Ordering::SeqCst);
    p.wake_all();
    for t in parked {
        assert_eq!(t.join().unwrap(), None);
    }
}

/// PLAN M16 `mpidr_for_index`: i = 0 → 0x8000_0000, i = 17 → 0x8000_0101; and PSCI finds
/// each of 64 vCPUs by the affinity the DT `cpu@N/reg` carries.
#[test]
fn mpidr_for_index() {
    assert_eq!(mpidr(0), 0x8000_0000);
    assert_eq!(mpidr(17), 0x8000_0101);
    assert_eq!(vmm::vcpu::mpidr_for(17), 0x8000_0101);
    let p = machine(64);
    for i in 0..64 {
        assert_eq!(p.index_of(aff(i)), Ok(i));
    }
    assert_eq!(p.index_of(0x400), Err(PsciError::InvalidParameters)); // Aff1 = 4: none
    assert_eq!(p.index_of(mpidr(3)), Err(PsciError::InvalidParameters)); // bit 31 set
}

// ---- The 4-CPU, 1 GiB device tree (PLAN M16 golden file) -----------------------------------

/// What `macvmm run --cpus 4 --mem 1G --kernel <test guest>` generates: no bootargs, no initrd,
/// no virtio device, seeds zeroed by `redact_seeds` (as `--dtb-out` writes them).
fn smp_desc() -> MachineDesc {
    MachineDesc {
        ncpus: 4,
        mem_bytes: 1 << 30,
        bootargs: None,
        initrd: None,
        virtio_slots: vec![],
        rng_seed: [0x5a; RNG_SEED_LEN],
        kaslr_seed: 1,
    }
}

fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/virt-4cpu-1g.dts")
}

/// Run `dtc -I dtb -O dts` on `blob`; `None` if dtc is not installed.
fn dtc(blob: &[u8]) -> Option<(bool, String, String)> {
    let dir = std::env::temp_dir().join(format!("macvmm-psci-smp-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("smp.dtb");
    std::fs::write(&input, blob).unwrap();
    let out = match Command::new("dtc")
        .args(["-I", "dtb", "-O", "dts", "-o", "-"])
        .arg(&input)
        .output()
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("cannot run dtc: {e}"),
    };
    let _ = std::fs::remove_file(&input);
    Some((
        out.status.success(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    ))
}

fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// PLAN M16: the 4-CPU DTS matches the golden file, and dtc has no warning.
#[test]
fn four_cpu_dts_matches_golden() {
    let blob = redact_seeds(&build_dtb(Layout::virt(), &smp_desc()).unwrap()).unwrap();
    let Some((ok, dts, warnings)) = dtc(&blob) else {
        say("dtc not installed; golden comparison skipped");
        return;
    };
    assert!(ok, "dtc failed: {warnings}");
    assert_eq!(warnings, "", "dtc warnings on the 4-CPU tree");
    if std::env::var_os("MACVMM_BLESS_GOLDEN").is_some() {
        std::fs::write(golden_path(), &dts).unwrap();
    }
    let golden = std::fs::read_to_string(golden_path()).unwrap();
    assert_eq!(dts, golden, "DTS differs from {}", golden_path().display());
    // The parts M16 owns, spelled out so a blessed golden cannot silently lose them.
    for want in [
        "cpu@0 {",
        "cpu@3 {",
        "reg = <0x03>;",
        "enable-method = \"psci\";",
        // GICD 64 KiB, then 4 redistributor frames of 128 KiB = 0x80000.
        "reg = <0x00 0x8000000 0x00 0x10000 0x00 0x80a0000 0x00 0x80000>;",
    ] {
        assert!(golden.contains(want), "golden lacks {want:?}");
    }
    assert!(!golden.contains("cpu@4"));
    say(&format!(
        "4-CPU golden comparison ran: {} lines match",
        golden.lines().count()
    ));
}

/// The seeds really come from the entropy source when not fixed (FDT-3 still holds with N
/// CPUs): two descriptions drawn from the same source differ.
#[test]
fn smp_desc_from_entropy() {
    let e = Entropy::os();
    let a = MachineDesc::from_entropy(4, 1 << 30, &e).unwrap();
    let b = MachineDesc::from_entropy(4, 1 << 30, &e).unwrap();
    assert_eq!(a.ncpus, 4);
    assert_ne!(a.rng_seed, b.rng_seed);
}
