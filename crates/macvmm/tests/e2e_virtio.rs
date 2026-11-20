//! E2E suite `virtio` (PLAN §0.3; M11 onwards): virtio-mmio devices seen from inside a guest.
//!
//! ```text
//! scripts/test-e2e.sh virtio
//! # = cargo test -p macvmm --features hvf-tests --test e2e_virtio -- --test-threads=1
//! ```
//!
//! M11 has the transport and no device: `virtio_probe_empty` checks that all 32 slots answer
//! as empty transports (virtio 1.2 §4.2.3.1.1) and the DT lists none. M12 (rng), M14 (blk)
//! and M24 (net) add their device tests here.
//!
//! **M12.** `virtio_probe_rng`: with `--rng` slot 0 holds DeviceID 4; the bare-metal driver
//! negotiates `VERSION_1`, posts one 32-byte writable buffer and gets 32 random bytes back
//! through the worker thread. `linux_rng`: the stock Alpine kernel's own `virtio-rng` driver
//! binds (`hw_random=virtio_rng.0`) and 1 MiB is read from `/dev/hwrng`. Both also assert, on
//! the VMM-only stderr, that the device never went to NEEDS_RESET and no thread panicked.
//!
//! **M13.** `linux_console_tx`: `yes macvmm | head -c 65536 > /dev/hvc0` reaches the
//! `--console file:` sink byte-exact under the default `safe` filter (sha256 compared with the
//! same bytes generated here). `linux_console_rx`: a line written to macvmm's stdin with
//! `--console stdio` arrives on the guest's `/dev/hvc0`. `both_stdio_rejected`: exit 2.
//! `console_stdin_escape_when_full` (TTY-10): a guest that never posts RX buffers, 8 KiB of
//! input, then Ctrl-A x → exit 130 within a second.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::Path;
use std::time::{Duration, Instant};
use support::{Running, artifact, check_markers, expect, expect_code, guest, run, scratch};

const T10: Duration = Duration::from_secs(10);

/// PLAN M11 on-machine acceptance: 32 slots, Magic and Version 2, DeviceID 0, narrow reads RAZ.
/// The `[stderr]` marker is the VMM's own warning for the narrow read (AS10).
#[test]
fn virtio_probe_empty() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("virtio-probe"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("virtio_probe_empty", &o, 0);
    expect("virtio-probe-empty", &o);
}

const T60: Duration = Duration::from_secs(60);

/// PLAN M12 on-machine acceptance: `--rng` puts virtio-rng (DeviceID 4) in slot 0, the
/// handshake reaches DRIVER_OK, and one entropy request returns 32 nonzero bytes.
#[test]
fn virtio_probe_rng() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--rng",
            "--kernel",
            &guest("virtio-probe"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("virtio_probe_rng", &o, 0);
    expect("virtio-probe-rng", &o);
}

/// PLAN M12 on-machine acceptance: Linux's virtio-rng driver against our device
/// (`scripts/initramfs/init` case `rng`). Needs `scripts/fetch.sh linux`.
#[test]
fn linux_rng() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return; // skipped (MACVMM_E2E_ALLOW_SKIP=1)
    };
    let o = run(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--rng",
            "--on-reset",
            "exit",
            "--timeout",
            "60",
            "--cmdline",
            "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test=rng",
        ],
        T60,
    );
    expect_code("linux_rng", &o, 0);
    expect("linux-rng", &o);
}

// ---- M13: virtio-console ----

/// The Linux console command line with test case `case`.
fn console_cmdline(case: &str) -> String {
    format!("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test={case}")
}

/// `shasum -a 256 FILE` → the hex digest.
fn sha256(p: &Path) -> String {
    let out = std::process::Command::new("/usr/bin/shasum")
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

/// Poll `path` until it contains `marker` (the serial sink is a file in these tests, so the
/// harness's stdout `WaitFor` cannot see the guest's markers); false after `limit` or exit.
fn wait_file(r: &mut Running, path: &Path, marker: &str, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if std::fs::read(path).is_ok_and(|b| String::from_utf8_lossy(&b).contains(marker)) {
            return true;
        }
        if r.child.try_wait().ok().flatten().is_some() {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

/// Check `tests/expect/<test>.txt` with the guest's markers taken from `serial` (a file sink).
fn expect_serial_file(test: &str, serial: &Path, o: &support::Outcome) {
    let spec_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/expect/{test}.txt"));
    let spec = std::fs::read_to_string(&spec_path).unwrap();
    let text = String::from_utf8_lossy(&std::fs::read(serial).unwrap_or_default()).into_owned();
    if let Err(why) = check_markers(&spec, &text, &o.stderr) {
        panic!("{test}: {why}\n--- serial file ---\n{text}\n{}", o.dump());
    }
}

/// PLAN M13 on-machine acceptance: Linux writes 65536 bytes to /dev/hvc0; the console file
/// sink holds exactly those bytes (TTY-2: plain text passes `safe` unchanged).
#[test]
fn linux_console_tx() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return;
    };
    let dir = scratch("linux_console_tx");
    let out = dir.join("hvc0.out");
    let sink = format!("file:{}", out.display());
    let cmdline = console_cmdline("console-tx");
    let o = run(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--console",
            &sink,
            "--on-reset",
            "exit",
            "--timeout",
            "60",
            "--stats",
            "--cmdline",
            &cmdline,
        ],
        T60,
    );
    expect_code("linux_console_tx", &o, 0);
    expect("linux-console-tx", &o);
    // The same 65536 bytes, generated here: `yes macvmm | head -c 65536`.
    let want: Vec<u8> = b"macvmm\n".iter().copied().cycle().take(65536).collect();
    let want_file = dir.join("want.bin");
    std::fs::write(&want_file, &want).unwrap();
    let got = std::fs::read(&out).unwrap();
    assert_eq!(got.len(), want.len(), "{}", o.dump());
    assert_eq!(sha256(&out), sha256(&want_file), "{}", o.dump());
    assert!(got == want);
    // Nothing was dropped or capped on the way (SINK-1, LOG-4 counters).
    assert!(
        o.stderr
            .contains("console_written=65536 console_sink_dropped=0"),
        "{}",
        o.dump()
    );
}

/// PLAN M13 on-machine acceptance: with `--console stdio`, a line typed on stdin reaches the
/// guest's /dev/hvc0 (the PL011 goes to a file, where the guest reports what it read).
#[test]
fn linux_console_rx() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return;
    };
    let dir = scratch("linux_console_rx");
    let serial = dir.join("s.txt");
    let sink = format!("file:{}", serial.display());
    let cmdline = console_cmdline("console-rx");
    let mut r = Running::spawn(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--console",
            "stdio",
            "--serial",
            &sink,
            "--on-reset",
            "exit",
            "--timeout",
            "60",
            "--cmdline",
            &cmdline,
        ],
        true,
    );
    let ready = wait_file(&mut r, &serial, "macvmm-console: rx ready", T60);
    r.send(b"macvmm-rx-test\n");
    let (o, _) = r.finish(T60);
    assert!(ready, "no rx ready marker\n{}", o.dump());
    expect_code("linux_console_rx", &o, 0);
    expect_serial_file("linux-console-rx", &serial, &o);
}

/// PLAN M13 on-machine acceptance: two stdio sinks are a usage error (exit 2) from the VMM.
#[test]
fn both_stdio_rejected() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--console",
            "stdio",
            "--serial",
            "stdio",
        ],
        T10,
    );
    expect_code("both_stdio_rejected", &o, 2);
    expect("linux-console-both-stdio", &o);
}

/// PLAN M13 security test (TTY-10, flaw F21): the guest never posts console RX buffers (the
/// `idle` case loads no virtio driver), 8 KiB of input fill and overflow the 4 KiB queue, and
/// Ctrl-A x still quits within a second.
#[test]
fn console_stdin_escape_when_full() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return;
    };
    let dir = scratch("console_stdin_escape_when_full");
    let serial = dir.join("s.txt");
    let sink = format!("file:{}", serial.display());
    let cmdline = console_cmdline("idle");
    let mut r = Running::spawn(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--console",
            "stdio",
            "--serial",
            &sink,
            "--stats",
            "--timeout",
            "60",
            "--cmdline",
            &cmdline,
        ],
        true,
    );
    let idle = wait_file(&mut r, &serial, "macvmm-idle: sleeping", T60);
    r.send(&[b'a'; 8192]);
    std::thread::sleep(Duration::from_millis(200));
    let sent = Instant::now();
    r.send(b"\x01x");
    let (o, exited) = r.finish(T10);
    assert!(idle, "the guest never reached the idle case\n{}", o.dump());
    expect_code("console_stdin_escape_when_full", &o, 130);
    let took = exited - sent;
    assert!(
        took < Duration::from_secs(1),
        "quit took {took:?}\n{}",
        o.dump()
    );
    expect_serial_file("linux-console-escape-full", &serial, &o);
    // The 4 KiB queue is full and the rest was dropped and counted (TTY-10).
    assert!(
        o.stderr
            .contains("console_input_dropped=4096 console_input_queued=4096"),
        "{}",
        o.dump()
    );
}

// ---- M14: virtio-blk ----

/// The test disk: 64 MiB.
const DISK_SIZE: usize = 64 << 20;
const T120: Duration = Duration::from_secs(120);

/// Write the deterministic test disk `cargo xtask mkdisk --size 64M --seed 1` writes (the same
/// xorshift64* words, `crates/xtask/src/disk.rs`), generated here so the test needs no nested
/// cargo. The tests compare against `shasum -a 256` of the file, never against this generator.
fn mkdisk(path: &Path) -> Vec<u8> {
    let mut x: u64 = 1;
    let mut bytes = Vec::with_capacity(DISK_SIZE);
    while bytes.len() < DISK_SIZE {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        bytes.extend_from_slice(&x.wrapping_mul(0x2545_f491_4f6c_dd1d).to_le_bytes());
    }
    std::fs::write(path, &bytes).unwrap();
    bytes
}

fn blk_cmdline(case: &str) -> String {
    format!("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test={case}")
}

/// Boot Alpine with `--disk <disk_arg>` and test case `case`; `None` if the Linux artifacts
/// are missing and skipping is allowed.
fn linux_blk(
    disk_arg: &str,
    case: &str,
    extra: &[&str],
    limit: Duration,
) -> Option<support::Outcome> {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return None; // skipped (MACVMM_E2E_ALLOW_SKIP=1)
    };
    let cmdline = blk_cmdline(case);
    let secs = limit.as_secs().to_string();
    let mut args = vec![
        "run",
        "--kernel",
        &kernel,
        "--initrd",
        &initrd,
        "--mem",
        "512M",
        "--disk",
        disk_arg,
        "--on-reset",
        "exit",
        "--timeout",
        &secs,
        "--cmdline",
        &cmdline,
    ];
    args.extend_from_slice(extra);
    Some(run(&args, limit))
}

/// PLAN M14 on-machine acceptance: Linux's virtio_blk reads the whole 64 MiB disk and its
/// sha256 equals the host's `shasum -a 256` of the image.
#[test]
fn linux_vda_read() {
    let dir = scratch("linux_vda_read");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let host = sha256(&disk);
    let Some(o) = linux_blk(disk.to_str().unwrap(), "vda", &[], T60) else {
        return;
    };
    expect_code("linux_vda_read", &o, 0);
    expect("linux-vda", &o);
    let want = format!("macvmm-vda: sha256={host}");
    assert!(o.stdout.contains(&want), "missing {want:?}\n{}", o.dump());
    assert_eq!(
        sha256(&disk),
        host,
        "a read-only workload changed the image"
    );
}

/// PLAN M14 on-machine acceptance: 1 MiB of `yes macvmm` at byte 8 MiB with `conv=fsync` (a
/// FLUSH, BLK-9) lands exactly there on the host, and nothing else in the image changes.
#[test]
fn linux_vda_write() {
    let dir = scratch("linux_vda_write");
    let disk = dir.join("disk.img");
    let mut want = mkdisk(&disk);
    let Some(o) = linux_blk(disk.to_str().unwrap(), "vda-write", &[], T60) else {
        return;
    };
    expect_code("linux_vda_write", &o, 0);
    expect("linux-vda-write", &o);
    let pattern: Vec<u8> = b"macvmm\n".iter().copied().cycle().take(1 << 20).collect();
    want[8 << 20..9 << 20].copy_from_slice(&pattern);
    let got = std::fs::read(&disk).unwrap();
    assert_eq!(got.len(), DISK_SIZE);
    assert!(
        got[8 << 20..9 << 20] == pattern[..],
        "bytes [8M, 9M) differ from the pattern"
    );
    assert!(got == want, "bytes outside [8M, 9M) changed");
}

/// PLAN M14 on-machine acceptance: with `,ro` Linux sees a read-only disk and refuses the
/// write; the image hash is unchanged (BLK-5).
#[test]
fn linux_vda_ro() {
    let dir = scratch("linux_vda_ro");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let host = sha256(&disk);
    let arg = format!("{},ro", disk.display());
    let Some(o) = linux_blk(&arg, "vda-ro", &[], T60) else {
        return;
    };
    expect_code("linux_vda_ro", &o, 0);
    expect("linux-vda-ro", &o);
    assert_eq!(sha256(&disk), host, "a ,ro disk changed");
}

/// PLAN M14 on-machine acceptance (BLK-8): a second macvmm on an image the first is using is
/// refused with exit 2 before it creates a VM; the first keeps running.
#[test]
fn disk_locked() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return;
    };
    let dir = scratch("disk_locked");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let d = disk.to_str().unwrap();
    let cmdline = blk_cmdline("shell");
    let mut first = Running::spawn(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--disk",
            d,
            "--on-reset",
            "exit",
            "--timeout",
            "60",
            "--cmdline",
            &cmdline,
        ],
        true,
    );
    let at_prompt = first.wait_for("/ # ", T60);
    let second = run(
        &[
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--disk",
            d,
            "--timeout",
            "10",
        ],
        T10,
    );
    // A read-only open needs a shared lock, which the writer's exclusive lock also refuses.
    let ro = format!("{d},ro");
    let third = run(
        &["run", "--kernel", &kernel, "--disk", &ro, "--timeout", "10"],
        T10,
    );
    first.send(b"poweroff -f\n");
    let (o, _) = first.finish(T60);
    assert!(
        at_prompt,
        "the first VM never reached its shell\n{}",
        o.dump()
    );
    expect_code("disk_locked (second)", &second, 2);
    assert!(
        second.stderr.contains("disk image is locked"),
        "{}",
        second.dump()
    );
    expect_code("disk_locked (third, ro)", &third, 2);
    assert!(
        third.stderr.contains("disk image is locked"),
        "{}",
        third.dump()
    );
    expect_code("disk_locked (first)", &o, 0);
}

/// PLAN M14 on-machine acceptance: the bare-metal probe finds virtio-blk (DeviceID 2) in slot
/// 0 and completes the handshake.
#[test]
fn virtio_probe_blk() {
    let dir = scratch("virtio_probe_blk");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--disk",
            disk.to_str().unwrap(),
            "--kernel",
            &guest("virtio-probe"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("virtio_probe_blk", &o, 0);
    expect("virtio-probe-blk", &o);
}

/// Whether this build has `--cpus` (PLAN M16). Read from the usage text an unknown flag
/// prints, so no VM is created.
fn cpus_flag_supported() -> bool {
    let o = run(&["run", "--no-such-flag-m14"], T10);
    o.stderr.contains("--cpus")
}

/// PLAN M14 (rev 1.2, first-principles R6): the lost-wakeup check for the `SeqCst` fence before
/// the `avail.flags` read (architecture §11.2 item 9). 20 rounds of 64 MiB of O_DIRECT reads
/// with 1 s idle between them, so the driver toggles `NO_INTERRUPT`; a lost wakeup hangs a
/// read and the run fails on its timeout. PLAN asks for `--cpus 2`; until M16 brings the flag
/// the soak runs on one vCPU (the test says which on stderr).
#[test]
fn linux_blk_soak() {
    let dir = scratch("linux_blk_soak");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let host = sha256(&disk);
    let arg = format!("{},ro", disk.display());
    let smp = cpus_flag_supported();
    let extra: &[&str] = if smp { &["--cpus", "2"] } else { &[] };
    let t0 = Instant::now();
    let Some(o) = linux_blk(&arg, "vda-soak", extra, T120) else {
        return;
    };
    support_say(&format!(
        "linux_blk_soak: {} vCPU(s), wall {:?}",
        if smp { 2 } else { 1 },
        t0.elapsed()
    ));
    expect_code("linux_blk_soak", &o, 0);
    expect("linux-vda-soak", &o);
    assert_eq!(sha256(&disk), host);
}

fn support_say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}
