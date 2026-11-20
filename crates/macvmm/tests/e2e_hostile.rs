//! E2E suite `hostile` (threat model TEST-7, §9.4): bare-metal guests that attack the VMM from
//! inside a real VM. The VMM must survive each phase and end with that phase's exit code.
//!
//! ```text
//! scripts/test-e2e.sh hostile
//! # = cargo test -p macvmm --features hvf-tests --test e2e_hostile -- --test-threads=1
//! ```
//!
//! Phases arrive with the milestones that own them (PLAN §2.2 table): **1, 3, 6, 7, 8 and the
//! device-less part of 5 with M11** (below), 4 and the device parts of 5 with M12/M14/M16 (M16: `hostile_smccc_storm`,
//! `hostile_vq_live_toctou`, guest `hostile-smp`), and
//! **phase 2 (ISV = 0 garbage) with M17**. Each
//! test asserts the exit code and a `[stderr]` marker only the VMM prints (AS10).
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;
use support::{expect, expect_code, guest, run, scratch};

const T10: Duration = Duration::from_secs(10);

/// The `--stats` line `serial_filtered=N`, or 0.
fn serial_filtered(stderr: &str) -> u64 {
    stderr
        .split("serial_filtered=")
        .nth(1)
        .and_then(|r| r.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// TEST-7 phase 1 (M11): every trapped device window, every width, every 1-byte offset, a
/// read and a random write, then 20,000 random accesses; all virtio slots empty, unhandled MMIO
/// logged. The VMM survives: exit 0, and its own `--unhandled-mmio log` warning on stderr.
#[test]
fn hostile_mmio() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--testdev",
            "--unhandled-mmio",
            "log",
            "--kernel",
            &guest("hostile-mmio"),
            "--timeout",
            "60",
        ],
        Duration::from_secs(60),
    );
    expect_code("hostile_mmio", &o, 0);
    expect("hostile-mmio", &o);
    println!("hostile_mmio: {:?}", o.wall);
}

/// TEST-7 phase 3 (M11, HC-6): all 16384 `S3_*` encodings read, the UNDEFINED ones written;
/// UNDEFs are counted in the guest and the VMM never stops. `--stats` shows the sysreg exits
/// that reached macvmm (a VMM-only marker, AS10).
#[test]
fn hostile_sysreg() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--stats",
            "--kernel",
            &guest("hostile-sysreg"),
            "--timeout",
            "60",
        ],
        Duration::from_secs(60),
    );
    expect_code("hostile_sysreg", &o, 0);
    expect("hostile-sysreg", &o);
}

/// TEST-7 phase 5, device-less part (M11): hostile handshakes, out-of-range QueueNotify and
/// narrow accesses on all 32 empty virtio slots. Exit 0; the VMM's narrow-access warning.
#[test]
fn hostile_vq_empty_slots() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hostile-vq"),
            "--timeout",
            "30",
        ],
        Duration::from_secs(30),
    );
    expect_code("hostile_vq_empty_slots", &o, 0);
    expect("hostile-vq", &o);
}

/// TEST-7 phase 5, device part (M12, VQ-1..VQ-10): with `--rng`, slot 0 is attacked as a
/// device (descriptor loops, `next`/head out of range, `avail.idx` jumps, buffers and indirect
/// tables in MMIO, a buffer straddling the end of RAM, an over-cap request, a used ring at the
/// end of RAM). Each attack must end in DEVICE_NEEDS_RESET, the device must recover after a
/// reset, and the VMM keeps running: exit 0, with the worker's own NEEDS_RESET warning on
/// stderr (AS10: no guest byte reaches stderr).
#[test]
fn hostile_vq_rng() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--rng",
            "--kernel",
            &guest("hostile-vq"),
            "--timeout",
            "30",
        ],
        Duration::from_secs(30),
    );
    expect_code("hostile_vq_rng", &o, 0);
    expect("hostile-vq-rng", &o);
}

/// TEST-7 phase 6 (M11, TTY-1, TTY-3): the full forbidden list written to the PL011. None of
/// `ESC ]`, `ESC P`, `ESC [ c`, `ESC [ 6 n`, `ESC _` or `0x9b` may reach stdout, and the
/// filter's own counter (`--stats`, VMM-only) shows it dropped them.
#[test]
fn hostile_tty() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--stats",
            "--kernel",
            &guest("hostile-tty"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("hostile_tty", &o, 0);
    expect("hostile-tty", &o);
    let out = o.stdout.as_bytes();
    let forbidden: &[(&str, &[u8])] = &[
        ("ESC ]", b"\x1b]"),
        ("ESC P", b"\x1bP"),
        ("ESC [ c", b"\x1b[c"),
        ("ESC [ 6 n", b"\x1b[6n"),
        ("ESC _", b"\x1b_"),
        ("ESC ^", b"\x1b^"),
        ("ESC X", b"\x1bX"),
        ("C1 CSI 0x9b", b"\x9b"),
        ("ENQ", b"\x05"),
    ];
    for (name, seq) in forbidden {
        assert!(
            !out.windows(seq.len()).any(|w| w == *seq),
            "{name} reached stdout\n{}",
            o.stdout.escape_debug()
        );
    }
    // The harness reads stdout lossily: a raw 0x9b/0x9d would arrive as U+FFFD, and the UTF-8
    // form C2 9B as U+009B.
    assert!(!o.stdout.contains('\u{9b}'), "U+009B reached stdout");
    assert!(
        !o.stdout.contains('\u{fffd}'),
        "a raw C1 byte reached stdout"
    );
    let filtered = serial_filtered(&o.stderr);
    assert!(filtered >= 100, "serial_filtered={filtered}\n{}", o.dump());
}

/// TEST-7 phase 7 (M11, HC-5): SYSTEM_RESET on every boot. The 11th reset within 10 s is a
/// reset storm: exit 3 with the VMM's verdict on stderr, quickly.
#[test]
fn hostile_reset() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hostile-reset"),
            "--timeout",
            "30",
        ],
        Duration::from_secs(30),
    );
    expect_code("hostile_reset", &o, 3);
    expect("hostile-reset", &o);
    assert!(o.wall < Duration::from_secs(10), "{:?}", o.wall);
}

/// TEST-7 phase 8 (M11, LOG-4, SINK-1): 4 MiB of output into `--serial file:F,max=1M`. The
/// file is exactly 1 MiB, there is exactly one cap warning, and the guest still runs to its
/// power-off (exit 0).
#[test]
fn hostile_flood() {
    let dir = scratch("hostile_flood");
    let f = dir.join("f");
    let sink = format!("file:{},max=1M", f.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--serial",
            &sink,
            "--kernel",
            &guest("hostile-flood"),
            "--timeout",
            "60",
        ],
        Duration::from_secs(60),
    );
    expect_code("hostile_flood", &o, 0);
    let len = std::fs::metadata(&f).unwrap().len();
    assert_eq!(len, 1 << 20, "{}", o.dump());
    assert_eq!(
        o.stderr
            .matches("sink reached its cap of 1048576 bytes")
            .count(),
        1,
        "{}",
        o.dump()
    );
    assert!(
        !o.stdout.contains("hostile-flood"),
        "output went to the file only"
    );
    println!("hostile_flood: {len} bytes in the file after {:?}", o.wall);
    let _ = std::fs::remove_dir_all(&dir);
}

/// TEST-7 phase 2 (M17, MMIO-4, MMIO-6): pairs across a device boundary (MMU off, and MMU on
/// with the second page mapped to the PL011) and SIMD loads/stores are all answered with
/// synchronous external aborts that the guest counts; nothing is half-written; exit 0.
#[test]
fn hostile_isv0() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--testdev",
            "--kernel",
            &guest("hostile-isv0"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("hostile_isv0", &o, 0);
    expect("hostile-isv0", &o);
}

/// TEST-7 phase 5, blk part (M14, BLK-1..5, VQ-9): with `--disk F,ro`, slot 0 is attacked as
/// virtio-blk (sector past and straddling the end, `sector × 512` overflow, a length that is
/// not a multiple of 512, 127 segments, a writable header, a short header, an unknown type, a
/// missing or zero-length status, data in MMIO, an OUT on the read-only disk). Each ends in a
/// status (IOERR/UNSUPP with `len` 1) or in NEEDS_RESET; the device then serves GET_ID and a
/// read; the VMM keeps running (exit 0); the image's sha256 is unchanged.
#[test]
fn hostile_vq_blk() {
    let dir = scratch("hostile_vq_blk");
    let disk = dir.join("disk.img");
    let bytes: Vec<u8> = (0..64u32 << 20).map(|i| (i % 251) as u8).collect();
    std::fs::write(&disk, &bytes).unwrap();
    let arg = format!("{},ro", disk.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--disk",
            &arg,
            "--kernel",
            &guest("hostile-vq"),
            "--timeout",
            "30",
        ],
        Duration::from_secs(30),
    );
    expect_code("hostile_vq_blk", &o, 0);
    expect("hostile-vq-blk", &o);
    assert!(
        std::fs::read(&disk).unwrap() == bytes,
        "the read-only image changed"
    );
}

// ---- M16: TEST-7 phase 4 and the live-TOCTOU part of phase 5, from several vCPUs ----------

/// TEST-7 phase 4 (M16, HC-1, HC-3, HC-4): 4 vCPUs make 3000 random SMCCC calls each at once
/// (random `x0`, bad MPIDRs and entry points, `hvc #imm ≠ 0`, `smc #0`), then three of them
/// storm CPU_ON at the fourth while it keeps turning itself off: one start per SUCCESS, no
/// wrong answer, no VMM error, exit 0. The VMM's own rate-limited `unknown SMCCC` warning and
/// its per-vCPU `--stats` lines are the stderr markers.
#[test]
fn hostile_smccc_storm() {
    let o = run(
        &[
            "run",
            "--cpus",
            "4",
            "--mem",
            "64M",
            "--stats",
            "--kernel",
            &guest("hostile-smp"),
            "--timeout",
            "60",
        ],
        Duration::from_secs(60),
    );
    expect_code("hostile_smccc_storm", &o, 0);
    expect("hostile-smp-storm", &o);
    assert!(!o.stderr.contains("panicked"), "{}", o.dump());
}

/// TEST-7 phase 5, live TOCTOU (M16, VQ-1..7, MEM-7): vCPU 1 rewrites the rng and blk
/// descriptors in a tight loop while vCPU 0 notifies, 10 s per device. Every request is
/// served or ends in NEEDS_RESET, both devices recover, the VMM never stops (exit 0), the
/// read-only image is unchanged, and the exit trace shows no guest MMIO access outside the
/// virtio-mmio window (the attack's only device accesses).
///
/// The trace check is about the guest. The device-side oracle is the guest's canary (module
/// docs of `guests/hostile-smp`): 16 MiB of patterned RAM that no descriptor ever names,
/// hashed by the VMM (DEBUG_MEMHASH) before the attack and after each device's round. A device
/// write anywhere outside the queue area changes it, and the `canary intact after …` markers
/// fail.
#[test]
fn hostile_vq_live_toctou() {
    let dir = scratch("hostile_vq_live_toctou");
    let disk = dir.join("disk.img");
    let bytes: Vec<u8> = (0..64u32 << 20).map(|i| (i % 253) as u8).collect();
    std::fs::write(&disk, &bytes).unwrap();
    let arg = format!("{},ro", disk.display());
    let trace = dir.join("exits.jsonl");
    let spec = format!("exits:{}:mmio", trace.display());
    let o = run(
        &[
            "run",
            "--cpus",
            "2",
            "--mem",
            "64M",
            "--rng",
            "--disk",
            &arg,
            "--stats",
            "--trace",
            &spec,
            "--kernel",
            &guest("hostile-smp"),
            "--timeout",
            "60",
        ],
        Duration::from_secs(60),
    );
    expect_code("hostile_vq_live_toctou", &o, 0);
    expect("hostile-smp-toctou", &o);
    assert!(
        std::fs::read(&disk).unwrap() == bytes,
        "the read-only image changed"
    );
    let text = std::fs::read_to_string(&trace).unwrap();
    let mut n = 0u64;
    for line in text.lines() {
        let ipa = line
            .split("\"ipa\":\"0x")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .and_then(|h| u64::from_str_radix(h, 16).ok())
            .unwrap_or_else(|| panic!("MMIO record without an IPA: {line}"));
        assert!(
            (0x0a00_0000..0x0a00_4000).contains(&ipa),
            "MMIO outside the virtio window: {line}"
        );
        n += 1;
    }
    assert!(n > 0, "no MMIO traced");
    let _ = std::fs::remove_file(&trace);
    println!("hostile_vq_live_toctou: {n} MMIO exits, all in the virtio window");
}
