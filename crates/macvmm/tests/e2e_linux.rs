//! E2E suite `linux` (PLAN M10 "Acceptance: on machine", Gate G1; course ch14): the stock
//! Alpine `linux-virt` 6.18 kernel and our test initramfs boot on the `virt` machine, reach the
//! busybox prompt on the PL011 and power off through PSCI SYSTEM_OFF.
//!
//! ```text
//! scripts/fetch.sh linux       # Image-virt, initramfs-test.img (sha256-pinned, SC-5)
//! scripts/test-e2e.sh linux
//! # = cargo test -p macvmm --features hvf-tests --test e2e_linux -- --test-threads=1
//! ```
//!
//! Every case uses the PLAN M10 command line
//! `console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test=<t>` with `--mem 512M` and
//! `--on-reset exit`; `<t>` selects the arm of `scripts/initramfs/init` (anchor
//! `initramfs_dispatch`). `panic=-1` makes a panic reboot at once (kernel/panic.c), which is a
//! PSCI SYSTEM_RESET (booting.rst does not cover this; the PSCI spec DEN0022 §5.1.10 does), so
//! `--on-reset exit` turns it into exit code 4.
//!
//! **Test integrity (AS10).** The guest owns stdout and could print any Linux string, so every
//! test asserts the exit code, and the VMM's own verdicts (`unhandled MMIO`, `unknown SMCCC`)
//! are matched on stderr, which no guest byte reaches. `linux_boot_exits` judges the boot by
//! the VMM's JSONL trace instead of guest text: every trapped system register (EC 0x18) must be
//! in the policy table (`crates/vmm/src/arch/sysreg.rs`) or answered with UNDEF, and every HVC
//! must be a named PSCI/SMCCC call, never a macvmm debug call (HC-2: off for an Image boot).
//!
//! **TTY-3 from a real kernel.** `linux_tty_attack` makes Linux's own tty layer write the whole
//! TTY-3 forbidden list to the PL011 (OSC 52, DSR, DA, DCS, APC, C1 CSI in UTF-8 and raw 8-bit)
//! and asserts in code that macvmm's default `safe` filter let none of them reach stdout, with
//! positive controls (the exact `6n6n` remnant and `serial_filtered=` from `--stats`) so a
//! payload that never reached the PL011 fails instead of passing vacuously.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::{Duration, Instant};
use support::{Running, Step, artifact, expect, expect_code, run, run_steps, scratch};

/// The PLAN M10 command line, minus the `macvmm.test=` word.
const CMDLINE: &str = "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1";
const T30: Duration = Duration::from_secs(30);

/// The kernel and initramfs paths, or `None` (skip) under `MACVMM_E2E_ALLOW_SKIP=1`.
fn linux() -> Option<(String, String)> {
    Some((
        artifact("Image-virt", "linux")?,
        artifact("initramfs-test.img", "linux")?,
    ))
}

/// `macvmm run` arguments for test case `t`, with `extra` appended.
fn args(kernel: &str, initrd: &str, cmdline: &str, timeout: &str, extra: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = [
        "run",
        "--kernel",
        kernel,
        "--initrd",
        initrd,
        "--mem",
        "512M",
        "--on-reset",
        "exit",
        "--timeout",
        timeout,
        "--cmdline",
        cmdline,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    v.extend(extra.iter().map(|s| (*s).to_owned()));
    v
}

fn cmdline(t: &str) -> String {
    format!("{CMDLINE} macvmm.test={t}")
}

fn strs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// `linux_boot`: the boot log in order, the initramfs marker, a clean PSCI power-off, no panic
/// and no VMM warning; exit 0 in under 30 s.
#[test]
fn linux_boot() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("boot"), "30", &[]);
    let o = run(&strs(&a), T30);
    expect_code("linux_boot", &o, 0);
    expect("linux-boot", &o);
    assert!(o.wall < T30, "linux_boot took {:?}\n{}", o.wall, o.dump());
    eprintln!("linux_boot: wall {:?}", o.wall);
}

/// `linux_boot_exits` (security checklist M10, HC-2): the VMM's trace of the same boot. Every
/// EC 0x18 is emulated by the policy table (`action":"sysreg"`) or injected as UNDEF; every
/// HVC is a named call and none is a macvmm debug call.
#[test]
fn linux_boot_exits() {
    let Some((k, i)) = linux() else { return };
    let dir = scratch("linux_boot_exits");
    let trace = dir.join("exits.jsonl");
    let spec = format!("exits:{}:sysreg,hvc", trace.display());
    let a = args(&k, &i, &cmdline("boot"), "30", &["--trace", &spec]);
    let o = run(&strs(&a), T30);
    expect_code("linux_boot_exits", &o, 0);
    let text = std::fs::read_to_string(&trace).unwrap();
    let (mut sysregs, mut hvcs) = (Vec::new(), Vec::new());
    for line in text.lines() {
        if line.contains("\"ec\":\"0x18\"") {
            assert!(
                line.contains("\"action\":\"sysreg\"")
                    || line.contains("\"action\":\"inject_undef\""),
                "EC 0x18 neither in the policy table nor UNDEF: {line}"
            );
            sysregs.push(field(line, "sysreg").unwrap_or("?").to_owned());
        } else if line.contains("\"ec\":\"0x16\"") {
            let f = field(line, "fn").unwrap_or_else(|| panic!("unnamed HVC: {line}"));
            assert!(
                !f.starts_with("DEBUG_"),
                "debug HVC answered for an Image: {line}"
            );
            hvcs.push(f.to_owned());
        }
    }
    assert!(!hvcs.is_empty(), "no HVC traced\n{text}");
    assert!(
        hvcs.iter().any(|f| f == "PSCI_SYSTEM_OFF"),
        "no SYSTEM_OFF in {hvcs:?}"
    );
    assert!(!o.stderr.contains("unknown SMCCC"), "{}", o.dump());
    sysregs.sort();
    sysregs.dedup();
    hvcs.sort();
    hvcs.dedup();
    eprintln!("linux_boot_exits: EC 0x18 seen: {sysregs:?}");
    eprintln!("linux_boot_exits: HVC calls seen: {hvcs:?}");
}

/// The string value of `"key":"…"` in a trace line (values are static names, LOG-5).
fn field<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let pat = format!("\"{key}\":\"");
    let start = line.find(&pat)? + pat.len();
    let len = line[start..].find('"')?;
    Some(&line[start..start + len])
}

/// `linux_shell`: type at the busybox shell on the PL011, then power off from it.
#[test]
fn linux_shell() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("shell"), "30", &[]);
    let o = run_steps(
        &strs(&a),
        &[
            Step::WaitFor("/ # "),
            Step::Send(b"echo macvmm-shell: $((6*7))\n".to_vec()),
            Step::WaitFor("macvmm-shell: 42"),
            Step::Send(b"poweroff -f\n".to_vec()),
            Step::WaitFor("reboot: Power down"),
        ],
        T30,
    );
    expect_code("linux_shell", &o, 0);
    expect("linux-shell", &o);
}

/// `linux_panic_resets`: `echo c > /proc/sysrq-trigger` panics; `panic=-1` reboots at once
/// (PSCI SYSTEM_RESET), and `--on-reset exit` makes that exit code 4.
#[test]
fn linux_panic_resets() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("panic"), "30", &[]);
    let o = run(&strs(&a), T30);
    expect_code("linux_panic_resets", &o, 4);
    expect("linux-panic", &o);
}

/// `linux_sigint`: SIGINT at the shell prompt quits the VM within 2 s (exit 130).
#[test]
fn linux_sigint() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("shell"), "30", &[]);
    let mut r = Running::spawn(&strs(&a), true);
    assert!(r.wait_for("/ # ", T30), "no shell prompt");
    let sent = Instant::now();
    r.signal("INT");
    let (o, exited) = r.finish(Duration::from_secs(10));
    expect_code("linux_sigint", &o, 130);
    let took = exited - sent;
    assert!(
        took < Duration::from_secs(2),
        "SIGINT took {took:?}\n{}",
        o.dump()
    );
    eprintln!("linux_sigint: exited {took:?} after SIGINT");
}

/// `linux_timer_latency`: 100 × `usleep 10000` timed with `/proc/uptime` takes < 2.0 s. This
/// measures the guest's timer wake-up latency through HVF's in-kernel GICv3: HVF itself delivers
/// the virtual timer (PPI 27) and completes the guest's WFI inside `hv_vcpu_run`, so the run
/// loop sees no `HV_EXIT_REASON_VTIMER_ACTIVATED` and no WFx exits at all (hvf-api.md §8 and
/// §19: `vtimer 0, wfx 0` for this case; architecture §9). `VTIMER_ACTIVATED` belongs to the
/// no-GIC mode (`--irqchip none`), which `e2e_irq::timer_nogic` covers.
#[test]
fn linux_timer_latency() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("timer-latency"), "30", &[]);
    let o = run(&strs(&a), T30);
    expect_code("linux_timer_latency", &o, 0);
    expect("linux-timer-latency", &o);
    let line = o
        .stdout
        .lines()
        .find(|l| l.starts_with("macvmm-timer: 100x usleep(10ms) took "))
        .unwrap();
    let secs: f64 = line
        .trim_end_matches(['\r', '\n'])
        .trim_end_matches(" s")
        .rsplit(' ')
        .next()
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("cannot parse {line:?}"));
    eprintln!("linux_timer_latency: {line}");
    assert!(secs < 2.0, "timer latency {secs} s >= 2.0 s\n{}", o.dump());
    assert!(
        secs >= 0.99,
        "100 x 10 ms took {secs} s, less than 1 s: the clock is wrong"
    );
}

/// Bytes the `safe` filter must count as dropped for the `tty-attack` payload of
/// `scripts/initramfs/init`. The filter counts a dropped string's body and a dropped CSI as 3
/// (`AnsiFilter::dropped`): OSC 52 body 25 + DSR 3 + DA 3 + DCS body 3 + APC body 9 + UTF-8 C1
/// CSI 1 + raw C1 CSI 1 = 45. Every payload line adds at least 1 and a plain Linux boot adds 0
/// (measured with `--stats`, `macvmm.test=boot`: `serial_filtered=0`), so a line that never
/// reached the PL011 takes the count below this floor.
const TTY_ATTACK_FILTERED: u64 = 45;

/// `linux_tty_attack` (TTY-3, security test of M10): none of the forbidden sequences Linux
/// wrote to the PL011 reaches stdout. The positive controls prove the payload was emitted and
/// filtered rather than never sent: what survives between the markers is exactly the `6n6n`
/// left by the two C1-CSI lines, and the VMM's own `--stats` counter (stderr, which no guest
/// byte reaches) shows at least [`TTY_ATTACK_FILTERED`] dropped bytes.
#[test]
fn linux_tty_attack() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("tty-attack"), "30", &["--stats"]);
    let o = run(&strs(&a), T30);
    expect_code("linux_tty_attack", &o, 0);
    expect("linux-tty-attack", &o);
    let between = o
        .stdout
        .split_once("macvmm-tty: begin")
        .and_then(|(_, rest)| rest.split_once("macvmm-tty: end"))
        .map(|(mid, _)| mid)
        .unwrap_or_else(|| panic!("no tty markers\n{}", o.dump()));
    assert_eq!(
        between.trim_matches(['\r', '\n']),
        "6n6n",
        "the filtered payload's remnant between the markers\n{}",
        o.dump()
    );
    let filtered: u64 = o
        .stderr
        .split_whitespace()
        .find_map(|w| w.strip_prefix("serial_filtered="))
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no serial_filtered= in --stats\n{}", o.dump()));
    eprintln!("linux_tty_attack: serial_filtered={filtered}");
    assert!(
        filtered >= TTY_ATTACK_FILTERED,
        "serial_filtered={filtered} < {TTY_ATTACK_FILTERED}: the payload did not reach the filter\n{}",
        o.dump()
    );
    let out = o.stdout.as_bytes();
    let forbidden: &[(&str, &[u8])] = &[
        ("ESC ]", b"\x1b]"),
        ("ESC P", b"\x1bP"),
        ("ESC [ c", b"\x1b[c"),
        ("ESC [ 6 n", b"\x1b[6n"),
        ("ESC _", b"\x1b_"),
        ("C1 CSI 0x9b", b"\x9b"),
    ];
    for (name, seq) in forbidden {
        assert!(
            !out.windows(seq.len()).any(|w| w == *seq),
            "{name} reached stdout\n{}",
            o.stdout.escape_debug()
        );
    }
    // The harness reads stdout lossily: a raw 0x9b would arrive as U+FFFD, and the UTF-8 form
    // C2 9B as U+009B. Neither may appear (Linux's own boot log is plain ASCII).
    assert!(!o.stdout.contains('\u{9b}'), "U+009B reached stdout");
    assert!(
        !o.stdout.contains('\u{fffd}'),
        "a non-UTF-8 byte (raw 0x9b?) reached stdout"
    );
}

/// `linux_ring_dump` (M10 `trace.rs` item, LOG-6): SIGUSR1 at the shell prompt prints the
/// exit ring on stderr while Linux keeps running; the shell still answers and powers off.
#[test]
fn linux_ring_dump() {
    let Some((k, i)) = linux() else { return };
    let a = args(&k, &i, &cmdline("shell"), "30", &[]);
    let mut r = Running::spawn(&strs(&a), true);
    assert!(r.wait_for("/ # ", T30), "no shell prompt");
    r.signal("USR1");
    std::thread::sleep(Duration::from_millis(300));
    r.send(b"echo macvmm-shell: $((6*7))\n");
    assert!(
        r.wait_for("macvmm-shell: 42", T30),
        "shell stopped answering"
    );
    r.send(b"poweroff -f\n");
    let (o, _) = r.finish(Duration::from_secs(10));
    expect_code("linux_ring_dump", &o, 0);
    assert!(
        o.stderr.contains("vcpu0: last 256 exits, oldest first:"),
        "{}",
        o.dump()
    );
    let records = o
        .stderr
        .lines()
        .filter(|l| l.starts_with("  {\"t_ns\":"))
        .count();
    assert!(records >= 256, "{records} ring records\n{}", o.dump());
}
