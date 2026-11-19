//! E2E suite `irq` (PLAN M8 "Acceptance: on machine"): interrupts and the timer, with the
//! in-kernel GICv3 (Part B, ch12) and without any interrupt controller (Part A, ch11).
//!
//! ```text
//! scripts/test-e2e.sh irq
//! # = cargo test -p macvmm --features hvf-tests --test e2e_irq -- --test-threads=1
//! ```
//!
//! Every test asserts the exit code (AS10). The `--stats` lines are printed by the VMM on
//! stderr, which a guest cannot write, so the exit counts and the host CPU percentage parsed
//! from them are the VMM's own measurements.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;
use support::{Outcome, Step, expect, expect_code, expect_trace, guest, run, run_steps, scratch};

const T10: Duration = Duration::from_secs(10);

/// A number following `key` in the stderr line starting with `prefix`.
fn stat(o: &Outcome, prefix: &str, key: &str) -> u64 {
    let line = o
        .stderr
        .lines()
        .find(|l| l.contains(prefix))
        .unwrap_or_else(|| panic!("no {prefix:?} line\n{}", o.dump()));
    let after = line
        .split(key)
        .nth(1)
        .unwrap_or_else(|| panic!("no {key:?} in {line:?}\n{}", o.dump()));
    after
        .trim_start()
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no number after {key:?} in {line:?}"))
}

/// The `N` of `stats: host cpu … (N%)`.
fn host_cpu_percent(o: &Outcome) -> u64 {
    let line = o
        .stderr
        .lines()
        .find(|l| l.contains("stats: host cpu"))
        .unwrap_or_else(|| panic!("no host cpu line\n{}", o.dump()));
    line.rsplit('(')
        .next()
        .and_then(|s| s.strip_suffix("%)"))
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("cannot parse {line:?}"))
}

/// `irq`: three bytes typed → three PL011 interrupts (INTID 33) through the in-kernel GIC.
#[test]
fn irq() {
    let o = run_steps(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("irq"),
            "--timeout",
            "10",
        ],
        &[
            Step::WaitFor("irq: ready"),
            Step::Send(b"a".to_vec()),
            Step::Sleep(200),
            Step::Send(b"b".to_vec()),
            Step::Sleep(200),
            Step::Send(b"c".to_vec()),
        ],
        T10,
    );
    expect_code("irq", &o, 0);
    expect("irq", &o);
}

/// `timer` (Part B): 10 × 100 ms on the in-kernel GIC: zero VTIMER and zero WFI exits, and an
/// idle guest costs under 10 % of a host CPU.
#[test]
fn timer() {
    let dir = scratch("timer");
    let t = dir.join("t.jsonl");
    let trace = format!("exits:{}:all", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("timer"),
            "--stats",
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("timer", &o, 0);
    expect("timer", &o);
    expect_trace("timer", &t, &o);
    assert_eq!(
        stat(&o, "stats: vcpu0 exits:", "vtimer "),
        0,
        "{}",
        o.dump()
    );
    assert_eq!(stat(&o, "stats: vcpu0 exits:", "wfx "), 0, "{}", o.dump());
    let pct = host_cpu_percent(&o);
    eprintln!("timer: host cpu {pct}%");
    assert!(pct < 10, "idle guest used {pct}% host CPU\n{}", o.dump());
    let _ = std::fs::remove_dir_all(&dir);
}

/// `timer_nogic` (Part A): the same 10 × 100 ms with `--irqchip none`: the VMM delivers the
/// timer itself, at the cost of ≥ 10 VTIMER and ≥ 10 WFI exits (the ch11/ch12 comparison).
#[test]
fn timer_nogic() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--irqchip",
            "none",
            "--kernel",
            &guest("timer-nogic"),
            "--stats",
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("timer_nogic", &o, 0);
    expect("timer-nogic", &o);
    let vtimer = stat(&o, "stats: vcpu0 exits:", "vtimer ");
    let wfx = stat(&o, "stats: vcpu0 exits:", "wfx ");
    eprintln!("timer_nogic: vtimer exits {vtimer}, wfx exits {wfx}");
    assert!(vtimer >= 10 && wfx >= 10, "{}", o.dump());
}

/// Security test (PLAN M8): with `--irqchip none`, a guest that never arms its timer and sits
/// in WFI cannot hold the VM: `--timeout 5` still ends it with exit 5 within 6 s.
#[test]
fn timer_nogic_wfi_forever_times_out() {
    let dir = scratch("nogic_wfi");
    let blob = dir.join("wfi.bin");
    // `wfi; b .-4` (ARM ARM C6.2: WFI = 0xd503207f; B imm26 = -1 → 0x17ffffff).
    std::fs::write(&blob, [0x7f, 0x20, 0x03, 0xd5, 0xff, 0xff, 0xff, 0x17]).unwrap();
    let raw = format!("{}@0x40080000", blob.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--irqchip",
            "none",
            "--raw",
            &raw,
            "--stats",
            "--timeout",
            "5",
        ],
        Duration::from_secs(5),
    );
    let wall = o.wall;
    expect_code("timer_nogic_wfi_forever", &o, 5);
    assert!(wall < Duration::from_secs(6), "took {wall:?}\n{}", o.dump());
    assert!(o.stderr.contains("timeout"), "{}", o.dump());
    assert!(stat(&o, "stats: vcpu0 exits:", "wfx ") >= 1, "{}", o.dump());
    let _ = std::fs::remove_dir_all(&dir);
}

/// `--irqchip none` with an ELF test guest is allowed, and the GIC-less machine (no `intc`
/// node in the DTB, no `hv_gic_create`) boots `hello` (exit 0). The refusals (an arm64 Image,
/// two vCPUs) are host tests: `vmm::config::tests::irqchip_none_restrictions`.
#[test]
fn irqchip_none_boots_a_test_guest() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--irqchip",
            "none",
            "--kernel",
            &guest("hello"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("irqchip_none_hello", &o, 0);
    expect("hello", &o);
}
