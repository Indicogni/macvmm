//! E2E suite `smp` (PLAN M16 "Acceptance: on machine"; course ch20; architecture §8.1, §8.6,
//! §14): several vCPUs, each on its own host thread, started and stopped through PSCI.
//!
//! ```text
//! scripts/fetch.sh linux       # Image-virt, initramfs-test.img (the Linux cases)
//! scripts/test-e2e.sh smp
//! # = cargo test -p macvmm --features hvf-tests --test e2e_smp -- --test-threads=1
//! ```
//!
//! - `smp_race`: the bare-metal `smp-race` guest on 4 vCPUs (CPU_ON twice, a three-way CPU_ON
//!   race with exactly one winner, CPU_OFF then AFFINITY_INFO = OFF, CPU_ON again, refusals).
//! - `linux_smp`, `linux_smp_hotplug`, `linux_smp_stress`, `linux_smp_64`: Alpine's
//!   `linux-virt` brings up every vCPU through PSCI, takes them offline and online, runs a
//!   30 s disk-and-console load on all of them, and boots on 64 vCPUs.
//! - `cpus_65_rejected`: `--cpus 65` is a usage error (exit 2) before any VM exists.
//!
//! **Test integrity (AS10).** The guest owns stdout, so each test also asserts the exit code and
//! a `[stderr]` marker only the VMM prints: `--stats` lists one `vcpuN exits:` line per vCPU
//! thread that existed, which a guest cannot fake. Kernel trouble (`rcu: INFO`, `soft lockup`,
//! `Kernel panic`) and VMM complaints (`unknown SMCCC`, `unhandled MMIO`) are `!` markers.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;
use support::{artifact, expect, expect_code, guest, run, scratch};

const CMDLINE: &str = "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1";

fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// Boot Alpine with `--cpus cpus --mem mem`, test case `case`, and `extra` flags; `None` if the
/// Linux artifacts are missing and skipping is allowed.
fn linux(cpus: &str, mem: &str, case: &str, extra: &[&str], secs: u64) -> Option<support::Outcome> {
    let kernel = artifact("Image-virt", "linux")?;
    let initrd = artifact("initramfs-test.img", "linux")?;
    let cmdline = format!("{CMDLINE} macvmm.test={case}");
    let timeout = secs.to_string();
    let mut args = vec![
        "run",
        "--kernel",
        &kernel,
        "--initrd",
        &initrd,
        "--cpus",
        cpus,
        "--mem",
        mem,
        "--on-reset",
        "exit",
        "--stats",
        "--timeout",
        &timeout,
        "--cmdline",
        &cmdline,
    ];
    args.extend_from_slice(extra);
    Some(run(&args, Duration::from_secs(secs)))
}

/// PLAN M16 `smp_race`: `--cpus 4 --mem 64M --kernel <smp-race>`, exit 0. The guest checks the
/// second CPU_ON is -4 or -5; the test checks it again from the output.
#[test]
fn smp_race() {
    let o = run(
        &[
            "run",
            "--cpus",
            "4",
            "--mem",
            "64M",
            "--stats",
            "--kernel",
            &guest("smp-race"),
            "--timeout",
            "20",
        ],
        Duration::from_secs(20),
    );
    expect_code("smp_race", &o, 0);
    expect("smp-race", &o);
    let second = o
        .stdout
        .split("second=")
        .nth(1)
        .and_then(|r| r.lines().next())
        .unwrap_or("");
    assert!(
        second == "-4" || second == "-5",
        "second CPU_ON: {second:?}"
    );
    say(&format!("smp_race: wall {:?}", o.wall));
}

/// PLAN M16 `linux_smp`: 4 vCPUs, 1 GiB; Linux brings up 4 CPUs, each takes timer interrupts,
/// and IPIs (GICv3 SGIs, handled inside HVF) reach every CPU.
#[test]
fn linux_smp() {
    let Some(o) = linux("4", "1G", "smp", &[], 60) else {
        return;
    };
    expect_code("linux_smp", &o, 0);
    expect("linux-smp", &o);
    for line in o.stdout.lines().filter(|l| l.starts_with("macvmm-smp:")) {
        say(&format!("linux_smp: {line}"));
    }
}

/// PLAN M16 `linux_smp_hotplug`: three rounds of every secondary offline (CPU_OFF, polled with
/// AFFINITY_INFO) and online (CPU_ON). Every one of the 9 kills must be confirmed by
/// AFFINITY_INFO reporting OFF.
#[test]
fn linux_smp_hotplug() {
    let Some(o) = linux("4", "512M", "smp-hotplug", &[], 60) else {
        return;
    };
    expect_code("linux_smp_hotplug", &o, 0);
    expect("linux-smp-hotplug", &o);
    // Linux (arch/arm64/kernel/psci.c, `cpu_psci_cpu_kill`) prints one line per kill:
    // "psci: CPU%d killed (polled %d ms)" once AFFINITY_INFO reports OFF, or "CPU%d may not
    // have shut down cleanly (AFFINITY_INFO reports %d)" if it never does within 100 ms. Count
    // only the first form, so a wrong AFFINITY_INFO answer fails here (the marker file also
    // forbids the second form).
    let killed = o.stdout.matches(" killed (polled ").count();
    say(&format!(
        "linux_smp_hotplug: {killed} clean PSCI CPU kills, wall {:?}",
        o.wall
    ));
    assert_eq!(
        killed,
        9,
        "3 rounds x 3 secondaries, each confirmed OFF by AFFINITY_INFO\n{}",
        o.dump()
    );
}

/// The 64 MiB test disk: deterministic bytes, so its sha256 can be compared after the run.
fn mkdisk(path: &std::path::Path) -> Vec<u8> {
    let mut x: u64 = 0x5eed;
    let mut bytes = Vec::with_capacity(64 << 20);
    while bytes.len() < 64 << 20 {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        bytes.extend_from_slice(&x.wrapping_mul(0x2545_f491_4f6c_dd1d).to_le_bytes());
    }
    std::fs::write(path, &bytes).unwrap();
    bytes
}

/// PLAN M16 `linux_smp_stress`: `--cpus 4 --disk $T/disk.img,ro`, 30 s of parallel O_DIRECT
/// reads and console output from every CPU, `--timeout 90`; no RCU stall, no soft lockup.
#[test]
fn linux_smp_stress() {
    let dir = scratch("linux_smp_stress");
    let disk = dir.join("disk.img");
    let bytes = mkdisk(&disk);
    let arg = format!("{},ro", disk.display());
    let Some(o) = linux("4", "512M", "smp-stress", &["--disk", &arg], 90) else {
        return;
    };
    expect_code("linux_smp_stress", &o, 0);
    expect("linux-smp-stress", &o);
    let passes: Vec<usize> = (0..4)
        .map(|c| {
            o.stdout
                .matches(&format!("macvmm-smp: cpu{c} pass "))
                .count()
        })
        .collect();
    say(&format!(
        "linux_smp_stress: passes per worker {passes:?}, wall {:?}",
        o.wall
    ));
    assert!(passes.iter().all(|&p| p > 0), "{}", o.dump());
    assert!(
        std::fs::read(&disk).unwrap() == bytes,
        "the read-only image changed"
    );
}

/// PLAN M16 `linux_smp_64`: 64 vCPUs (the `MAX_CPUS` cap, and this host's
/// `hv_vm_get_max_vcpu_count`), 2 GiB, `--timeout 120`.
#[test]
fn linux_smp_64() {
    let Some(o) = linux("64", "2G", "smp", &[], 120) else {
        return;
    };
    expect_code("linux_smp_64", &o, 0);
    expect("linux-smp-64", &o);
    say(&format!("linux_smp_64: wall {:?}", o.wall));
}

/// PLAN M16 `cpus_65_rejected`: `--cpus 65` → exit 2 with the VMM's `--cpus` message, before
/// any input is read or any VM is created.
#[test]
fn cpus_65_rejected() {
    let o = run(
        &["run", "--cpus", "65", "--kernel", &guest("hello")],
        Duration::from_secs(10),
    );
    expect_code("cpus_65_rejected", &o, 2);
    expect("cpus-65-rejected", &o);
    assert!(o.stdout.is_empty(), "no guest ran\n{}", o.dump());
}
