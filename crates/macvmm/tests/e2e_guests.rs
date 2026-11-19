//! E2E suite `guests` (PLAN M3 "Acceptance: on machine"): the first test guests, booted by the
//! real signed binary.
//!
//! ```text
//! scripts/test-e2e.sh guests
//! # = cargo test -p macvmm --features hvf-tests --test e2e_guests -- --test-threads=1
//! ```
//!
//! Every test asserts the exit code (AS10). Verdicts that only the VMM can give (unhandled
//! MMIO, timeout, refused inputs) are matched on stderr.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::{Duration, Instant};
use support::{expect, expect_code, expect_trace, guest, guest_bin, run, scratch};

const T10: Duration = Duration::from_secs(10);

#[test]
fn hello_raw() {
    let raw = format!("{}@0x40080000", guest_bin("hello"));
    let o = run(
        &["run", "--mem", "64M", "--raw", &raw, "--timeout", "10"],
        T10,
    );
    expect_code("hello_raw", &o, 0);
    expect("hello", &o);
}

#[test]
fn hello_elf() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("hello_elf", &o, 0);
    expect("hello", &o);
}

#[test]
fn memtest() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("memtest"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("memtest", &o, 0);
    expect("memtest", &o);
}

#[test]
fn mmio_poke() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("mmio-poke"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("mmio_poke", &o, 3);
    expect("mmio-poke", &o);
}

/// `--unhandled-mmio log`: the store is ignored (RAZ/WI) with a rate-limited warning, and the
/// guest goes on to power off.
#[test]
fn mmio_poke_log_policy() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("mmio-poke"),
            "--unhandled-mmio",
            "log",
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("mmio_poke_log_policy", &o, 0);
    assert!(o.stdout.contains("mmio-poke: survived"), "{}", o.dump());
    assert!(
        o.stderr.contains("unhandled MMIO write at 0xc000000"),
        "{}",
        o.dump()
    );
}

#[test]
fn timeout() {
    let dir = scratch("timeout");
    let spin = dir.join("spin.bin");
    std::fs::write(&spin, [0x00, 0x00, 0x00, 0x14]).unwrap(); // `b .`
    let raw = format!("{}@0x40080000", spin.display());
    let o = run(
        &["run", "--mem", "64M", "--raw", &raw, "--timeout", "1"],
        Duration::from_secs(1),
    );
    expect_code("timeout", &o, 5);
    expect("timeout", &o);
    assert!(o.wall < Duration::from_secs(5), "{:?}", o.wall);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn exit_bench() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("exit-bench"),
            "--timeout",
            "30",
        ],
        Duration::from_secs(30),
    );
    expect_code("exit_bench", &o, 0);
    expect("exit-bench", &o);
    let line = o
        .stdout
        .lines()
        .find(|l| l.starts_with("exit-bench: 100000 hvc"))
        .unwrap();
    let ns: u64 = line
        .rsplit(", ")
        .next()
        .and_then(|s| s.strip_suffix(" ns/exit"))
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| panic!("cannot parse {line:?}"));
    assert!(ns > 0, "{line}");
    println!("exit_bench: {ns} ns per guest→VMM→guest round trip ({line})");
}

#[test]
fn input_not_regular() {
    let dir = scratch("input_not_regular");
    let fifo = dir.join("fifo");
    let st = std::process::Command::new("/usr/bin/mkfifo")
        .arg(&fifo)
        .status()
        .unwrap();
    assert!(st.success());
    for input in [
        std::path::Path::new("/dev/zero"),
        fifo.as_path(),
        dir.as_path(),
    ] {
        let t0 = Instant::now();
        let o = run(&["run", "--kernel", input.to_str().unwrap()], T10);
        expect_code("input_not_regular", &o, 2);
        expect("input_not_regular", &o);
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "{input:?} took {:?}",
            t0.elapsed()
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn input_too_large() {
    let dir = scratch("input_too_large");
    let big = dir.join("big.bin");
    std::fs::File::create(&big)
        .unwrap()
        .set_len(65 << 20)
        .unwrap(); // sparse
    let raw = format!("{}@0x40080000", big.display());
    let o = run(&["run", "--mem", "64M", "--raw", &raw], T10);
    expect_code("input_too_large", &o, 2);
    expect("input_too_large", &o);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------------------------
// M4: vCPU state, the fatal dump, MMIO emulation and the exit trace.

#[test]
fn regcheck() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("regcheck"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("regcheck", &o, 0);
    expect("regcheck", &o);
}

/// ch06: the alignment fault goes to the guest's own EL1 vector (VBAR_EL1 = 0), whose fetch
/// at 0x200 faults in stage 2: the VMM's first non-HVC exit (after the DEBUG_PUTC HVCs that
/// printed the banner) is that instruction abort, and the dump
/// shows the first fault in ELR_EL1/ESR_EL1. Exit code 3 (a VMM verdict, AS10).
#[test]
fn self_fault() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("self-fault"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("self_fault", &o, 3);
    expect("self-fault", &o);
    // The ring's newest record is the fatal instruction abort; before it, DEBUG_PUTC HVCs.
    let ring: Vec<&str> = o
        .stderr
        .lines()
        .skip_while(|l| !l.starts_with("last exits: "))
        .skip(1)
        .collect();
    let fatal = ring.last().unwrap();
    assert!(
        fatal.contains(r#""ec":"0x20","pc":"0x200","ipa":"0x200","action":"stop""#),
        "{}",
        o.dump()
    );
    assert!(ring.len() <= 32);
    assert!(
        ring[..ring.len() - 1]
            .iter()
            .all(|l| l.contains(r#""ec":"0x16""#))
    );
    assert!(
        o.stderr.contains("note: pc is VBAR_EL1 + 0x200"),
        "{}",
        o.dump()
    );
}

#[test]
fn mmio_probe() {
    let dir = scratch("mmio_probe");
    let t = dir.join("t.jsonl");
    let trace = format!("exits:{}:mmio", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--testdev",
            "--kernel",
            &guest("mmio-probe"),
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("mmio_probe", &o, 0);
    expect("mmio-probe", &o);
    expect_trace("mmio-probe", &t, &o);
    // Every record is a data abort (the :mmio category), one per probe access.
    let text = std::fs::read_to_string(&t).unwrap();
    let n = text.lines().count();
    assert!(
        text.lines().all(|l| l.contains("\"ec\":\"0x24\"")),
        "{text}"
    );
    println!("mmio_probe: {n} MMIO records");
    let mode =
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&t).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600, "PATH-6");
    let _ = std::fs::remove_dir_all(&dir);
}

/// One HVC record per printed byte (DEBUG_PUTC) plus one for PSCI SYSTEM_OFF.
#[test]
fn hello_trace_counts() {
    let dir = scratch("hello_trace_counts");
    let t = dir.join("h.jsonl");
    let trace = format!("exits:{}:hvc", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("hello_trace_counts", &o, 0);
    expect("hello", &o);
    let text = std::fs::read_to_string(&t).unwrap();
    let hvc = text
        .lines()
        .filter(|l| l.contains("\"ec\":\"0x16\""))
        .count();
    assert_eq!(hvc, o.stdout.len() + 1, "{text}\n{}", o.dump());
    assert_eq!(hvc, text.lines().count(), "only HVC records with :hvc");
    let last = text.lines().last().unwrap();
    assert!(
        last.contains("\"fn\":\"PSCI_SYSTEM_OFF\",\"action\":\"psci\""),
        "{last}"
    );
    println!(
        "hello_trace_counts: {hvc} HVC records for {} bytes",
        o.stdout.len()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// LOG-3 end to end: a tiny cap gives at most `max` bytes of records plus one
/// `trace_truncated` record, one warning, and the guest is unaffected.
#[test]
fn trace_cap() {
    let dir = scratch("trace_cap");
    let t = dir.join("c.jsonl");
    let trace = format!("exits:{},max=1K", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("trace_cap", &o, 0);
    expect("hello", &o);
    let text = std::fs::read_to_string(&t).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let (last, body) = lines.split_last().unwrap();
    assert!(last.contains("\"action\":\"trace_truncated\""), "{text}");
    let body_bytes: usize = body.iter().map(|l| l.len() + 1).sum();
    assert!(body_bytes <= 1024, "{body_bytes}");
    assert_eq!(text.matches("trace_truncated").count(), 1);
    assert_eq!(o.stderr.matches("byte cap").count(), 1, "{}", o.dump());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------------------------
// M7: the generated device tree, as the guest and `dtc` see it.

/// The golden DTS the host test `fdt_machine::golden_dts_matches` pins: exactly what a
/// `--mem 512M` test-guest boot writes with `--dtb-out` (seeds zeroed, FDT-4).
fn golden_dts() -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../vmm/tests/golden/virt-1cpu-512m.dts");
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p:?}: {e}"))
}

/// The guest finds a valid DTB at x0 and reads what a kernel reads first.
#[test]
fn dtb_reader() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("dtb-reader"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("dtb_reader", &o, 0);
    expect("dtb-reader", &o);
}

/// booting.rst §4: x0 holds the DTB's physical address, the start of RAM.
#[test]
fn hello_x0_is_dtb() {
    let o = run(
        &["run", "--kernel", &guest("hello"), "--timeout", "10"],
        T10,
    );
    expect_code("hello_x0_is_dtb", &o, 0);
    expect("hello", &o);
    assert!(
        o.stdout.contains("hello from guest, x0=0x40000000\n"),
        "{}",
        o.dump()
    );
}

/// `--dtb-out` writes a blob `dtc` decompiles with no warning, and (default 512 MiB, one
/// vCPU, a test guest) it decompiles to the golden DTS.
#[test]
fn dtb_out_dtc_clean() {
    let dir = scratch("dtb_out_dtc_clean");
    let dtb = dir.join("v.dtb");
    let o = run(
        &[
            "run",
            "--kernel",
            &guest("hello"),
            "--dtb-out",
            dtb.to_str().unwrap(),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("dtb_out_dtc_clean", &o, 0);
    expect("hello", &o);
    let mode =
        std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&dtb).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600, "PATH-6");
    let out = std::process::Command::new("dtc")
        .args(["-I", "dtb", "-O", "dts", "-o", "-"])
        .arg(&dtb)
        .output()
        .expect("dtc is required for this acceptance test (brew install dtc)");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "dtc failed: {stderr}");
    assert_eq!(stderr, "", "dtc printed warnings");
    let dts = String::from_utf8(out.stdout).unwrap();
    assert_eq!(dts, golden_dts(), "--dtb-out differs from the golden DTS");
    println!(
        "dtb_out_dtc_clean: dtc exit {:?}, {} bytes of stderr, {} DTS lines == golden",
        out.status.code(),
        stderr.len(),
        dts.lines().count()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// FDT-4: the dumped DTB has both seeds zeroed, while the guest of the same run (dtb-reader)
/// received non-zero ones.
#[test]
fn dtb_out_has_no_seeds() {
    let dir = scratch("dtb_out_has_no_seeds");
    for kernel in ["hello", "dtb-reader"] {
        let dtb = dir.join(format!("{kernel}.dtb"));
        let o = run(
            &[
                "run",
                "--mem",
                "64M",
                "--kernel",
                &guest(kernel),
                "--dtb-out",
                dtb.to_str().unwrap(),
                "--timeout",
                "10",
            ],
            T10,
        );
        expect_code("dtb_out_has_no_seeds", &o, 0);
        if kernel == "dtb-reader" {
            expect("dtb-reader", &o);
        }
        let blob = std::fs::read(&dtb).unwrap();
        let f = vmm::fdt::reader::parse(&blob).unwrap();
        let chosen = f.find("/chosen").unwrap();
        let rng = &chosen.prop("rng-seed").unwrap().value;
        assert_eq!(rng.len(), 64);
        assert!(rng.iter().all(|&b| b == 0), "rng-seed not zeroed");
        assert_eq!(chosen.prop("kaslr-seed").unwrap().u64(), Some(0));
        // Nothing on either stream reveals seed bytes: only the guest's yes/no.
        assert!(!o.stderr.contains("seed"), "{}", o.dump());
        println!(
            "dtb_out_has_no_seeds ({kernel}): {} bytes, rng-seed 64 zero bytes, kaslr-seed 0",
            blob.len()
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------------------------
// M5: system registers, exception injection, SMCCC/PSCI, the reboot loop and its limit.

/// ch08: `mrs PMCR_EL0` (no PMU) traps to the VMM, which injects exactly one UNDEF into the
/// guest's own vector; the OS lock round-trips. The trace shows the trap and the injection.
#[test]
fn sysreg_probe() {
    let dir = scratch("sysreg_probe");
    let t = dir.join("s.jsonl");
    let trace = format!("exits:{}:sysreg", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("sysreg-probe"),
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("sysreg_probe", &o, 0);
    expect("sysreg-probe", &o);
    expect_trace("sysreg-probe", &t, &o);
    let text = std::fs::read_to_string(&t).unwrap();
    // Which of the OS-lock registers HVF forwards (architecture §8.4: measured, not assumed).
    let forwarded: Vec<&str> = ["OSLAR_EL1", "OSLSR_EL1"]
        .into_iter()
        .filter(|r| text.contains(&format!("\"sysreg\":\"{r}\"")))
        .collect();
    // With the in-kernel GIC, HVF injects the PMCR_EL0 UNDEF itself (measured in M5); the
    // guest-side verdict above holds either way, so this is reported, not asserted.
    let pmcr = text.contains("\"sysreg\":\"PMCR_EL0\"");
    println!(
        "sysreg_probe: {} EC 0x18 records; OS-lock registers trapped: {forwarded:?}; \
         PMCR_EL0 forwarded to the VMM: {pmcr}\n{text}",
        text.lines().count()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// The SMCCC/PSCI answers, then SYSTEM_RESET under the default `--on-reset reboot`: the
/// machine is rebuilt in-process and DEBUG_BOOT_COUNT reports boot 1, which powers off.
#[test]
fn psci_probe_reboot() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("psci-probe"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("psci_probe_reboot", &o, 0);
    expect("psci-probe-reboot", &o);
    assert_eq!(
        o.stdout.matches("psci-probe: boot ").count(),
        2,
        "{}",
        o.dump()
    );
}

/// `--on-reset exit`: the reset is the verdict, exit code 4, no second boot.
#[test]
fn psci_probe_exit() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("psci-probe"),
            "--on-reset",
            "exit",
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("psci_probe_exit", &o, 4);
    expect("psci-probe-exit", &o);
}

/// HC-5: a guest that calls SYSTEM_RESET at once, forever. The 11th reset within 10 s is a
/// reset storm: exit 3 with a verdict only the VMM prints, quickly.
#[test]
fn reset_storm() {
    let dir = scratch("reset_storm");
    let bin = dir.join("storm.bin");
    let words: [u32; 4] = [
        0xd280_0120, // movz x0, #0x9
        0xf2b0_8000, // movk x0, #0x8400, lsl #16   (x0 = 0x8400_0009, PSCI SYSTEM_RESET)
        0xd400_0002, // hvc #0
        0x1400_0000, // b .
    ];
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    std::fs::write(&bin, bytes).unwrap();
    let raw = format!("{}@0x40080000", bin.display());
    let o = run(
        &["run", "--mem", "64M", "--raw", &raw, "--timeout", "20"],
        Duration::from_secs(20),
    );
    expect_code("reset_storm", &o, 3);
    assert!(
        o.stderr.contains("macvmm: guest fatal: reset storm"),
        "{}",
        o.dump()
    );
    assert!(o.wall < Duration::from_secs(5), "{:?}", o.wall);
    println!("reset_storm: stopped after {:?}", o.wall);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `--timeout` is one wall-clock bound for the whole run (architecture §13.1), not one per
/// boot: a guest that spins about a second and then calls SYSTEM_RESET, under the default
/// `--on-reset reboot`, stays far below the HC-5 storm rate, and must still end with exit 5
/// soon after `--timeout 3`. Before the fix every reboot re-armed the timeout and it ran
/// forever.
#[test]
fn timeout_spans_reboots() {
    let dir = scratch("timeout_spans_reboots");
    let bin = dir.join("slowreset.bin");
    let words: [u32; 7] = [
        0xd2c0_0022, // movz x2, #0x1, lsl #32       (about a second of countdown)
        0xf100_0442, // 1: subs x2, x2, #1
        0x54ff_ffe1, // b.ne 1b
        0xd280_0120, // movz x0, #0x9
        0xf2b0_8000, // movk x0, #0x8400, lsl #16   (x0 = 0x8400_0009, PSCI SYSTEM_RESET)
        0xd400_0002, // hvc #0
        0x1400_0000, // b .
    ];
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
    std::fs::write(&bin, bytes).unwrap();
    let raw = format!("{}@0x40080000", bin.display());
    let o = run(
        &[
            "--log",
            "info",
            "run",
            "--mem",
            "64M",
            "--raw",
            &raw,
            "--timeout",
            "3",
        ],
        Duration::from_secs(3),
    );
    expect_code("timeout_spans_reboots", &o, 5);
    assert!(
        o.stderr.contains("guest reset: rebooting (boot 1)"),
        "the guest must have rebooted at least once: {}",
        o.dump()
    );
    assert!(o.stderr.contains("macvmm: timeout"), "{}", o.dump());
    assert!(!o.stderr.contains("reset storm"), "{}", o.dump());
    assert!(o.wall < Duration::from_secs(5), "{:?}", o.wall);
    println!(
        "timeout_spans_reboots: {} reboots, stopped after {:?}",
        o.stderr.matches("guest reset: rebooting").count(),
        o.wall
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// PLAN M17 `isv0_probe`: pairs and writeback forms (ISV = 0) decoded by the VMM, with the
/// guest's MMU on, and a SIMD store answered with a synchronous external abort.
#[test]
fn isv0_probe() {
    let dir = scratch("isv0_probe");
    let t = dir.join("i.jsonl");
    let trace = format!("exits:{}:mmio", t.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--testdev",
            "--kernel",
            &guest("isv0-probe"),
            "--trace",
            &trace,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("isv0_probe", &o, 0);
    expect("isv0-probe", &o);
    expect_trace("isv0-probe", &t, &o);
    let text = std::fs::read_to_string(&t).unwrap();
    let isv0 = text
        .lines()
        .filter(|l| l.contains(r#""isv":false"#))
        .count();
    let isv1 = text.lines().filter(|l| l.contains(r#""isv":true"#)).count();
    // 14 decoded accesses (plus the refused SIMD store); every plain ldr/str says isv:true.
    assert!(isv0 >= 15, "{isv0} ISV=0 records\n{text}");
    assert!(isv1 > 0, "{text}");
    println!("isv0_probe: {isv0} ISV=0 records, {isv1} ISV=1 records");
    let _ = std::fs::remove_dir_all(&dir);
}
