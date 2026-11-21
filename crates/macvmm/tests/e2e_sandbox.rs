//! E2E suite `sandbox` (PLAN M22 "Acceptance: on machine"; threat model SBX-1..SBX-4, TEST-10,
//! PROC-4; course ch25).
//!
//! ```text
//! scripts/test-e2e.sh sandbox
//! ```
//!
//! **What it proves.** The sandbox is on by default: `macvmm run --sandbox-selftest` (no other
//! sandbox flag) locks the process down after `HostIo::open` and before the first guest
//! instruction, prints `sandbox: open denied, socket denied, spawn denied` (SBX-3 item 4), and
//! then everything a VM does after that point still works under the profile (SBX-3 items 1–3
//! and the ch18 reboot):
//! - `sandbox_default_confined`: a run with no sandbox flag is confined, `--sandbox` is the
//!   same run, `--no-sandbox` is not confined, and the contradictory or unconfinable command
//!   lines are usage errors (exit 2);
//! - `sandbox_smp`: four vCPUs created after the lockdown race CPU_ON (smp-race);
//! - `sandbox_reboot`: an in-process reboot (`hv_vm_create`, `hv_vm_allocate`,
//!   `hv_gic_create` again) and guest output after it (psci-probe, SINK-1 writer threads);
//! - `sandbox_blk_read` / `sandbox_blk_flush`: Linux reads the whole disk (sha256) and writes
//!   with `conv=fsync` (a virtio-blk FLUSH, `F_FULLFSYNC` on the open fd);
//! - `sandbox_rootfs_persist`: the ch18 ext4 rootfs persistence run across a guest reboot;
//! - `sandbox_ctrl_a_x`: the stdin thread still delivers Ctrl-A x (exit 130 within 1 s, TTY-10);
//! - `sandbox_tty_restored`: the exit path can still restore the terminal (`stty -g` identical:
//!   the profile allows exactly the `tcsetattr`/`tcflush` ioctls, PROC-1, TTY-6);
//! - `sandbox_fail_closed`: if `sandbox_init` fails (here: macvmm already runs under
//!   `sandbox-exec`, which forbids a second profile), the default run and `--sandbox` exit 1,
//!   `--sandbox=best-effort` warns and runs, `--no-sandbox` runs (SBX-4), and `--dry-run`
//!   fails closed as well;
//! - `sandbox_dry_run`: `--dry-run` (which parses the kernel) runs confined, self-test included;
//! - `sandbox_exec_fallback`: `scripts/sandbox-exec-fallback.sh` runs a guest with a reboot and
//!   a serial file under an exec-time `(deny default)` profile (SBX-1);
//! - `rlimit_stats`: `--stats` prints `rlimit core=0 nofile=<n>`, and the default sandbox
//!   lowers `n` below the `--no-sandbox` value (PROC-4);
//! - `sandbox_net`: two sandboxed VMs exchange 32 MiB over `--net unixgram` (the profile's
//!   per-peer `network-outbound` allowance, SBX-2).
//!
//! **Test integrity (AS10).** The sandbox line and the `rlimit` line are on stderr, which no
//! guest byte reaches; every test asserts the exit code.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use support::{
    Running, artifact, cache_dir, check_markers, expect, expect_code, guest, macvmm, run,
    run_in_pty, scratch, sh_quote,
};

const T10: Duration = Duration::from_secs(10);
const T60: Duration = Duration::from_secs(60);
const T120: Duration = Duration::from_secs(120);
const SELFTEST: &str = "[stderr] sandbox: open denied, socket denied, spawn denied";

fn markers(o: &support::Outcome, spec: &str) {
    check_markers(spec, &o.stdout, &o.stderr).unwrap_or_else(|e| panic!("{e}\n{}", o.dump()));
}

/// `nofile=<n>` from the `--stats` rlimit line.
fn nofile(o: &support::Outcome) -> u64 {
    o.stderr
        .split("rlimit core=0 nofile=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no rlimit stats line\n{}", o.dump()))
}

/// SBX-3 item 1 / TEST-10: four vCPUs created after the lockdown.
#[test]
fn sandbox_smp() {
    let o = run(
        &[
            "run",
            "--sandbox-selftest",
            "--cpus",
            "4",
            "--kernel",
            &guest("smp-race"),
            "--timeout",
            "20",
            "--stats",
        ],
        T60,
    );
    expect_code("sandbox_smp", &o, 0);
    expect("smp-race", &o);
    markers(&o, SELFTEST);
}

/// SBX-3 item 2: an in-process reboot under the lockdown, with guest output after it.
#[test]
fn sandbox_reboot() {
    let o = run(
        &[
            "run",
            "--sandbox-selftest",
            "--kernel",
            &guest("psci-probe"),
            "--timeout",
            "10",
            "--stats",
        ],
        T10,
    );
    expect_code("sandbox_reboot", &o, 0);
    expect("psci-probe-reboot", &o);
    markers(&o, &format!("{SELFTEST}\n[stderr] rlimit core=0 nofile=*"));
    let boot1 = o.stdout.find("psci-probe: boot 1").expect("boot 1");
    assert!(
        o.stdout[..boot1].matches("psci-probe: version=").count() == 2,
        "the second boot printed through the sink\n{}",
        o.dump()
    );
}

/// The deterministic 64 MiB test disk of `e2e_virtio` (xorshift64*, seed 1).
fn mkdisk(path: &Path) {
    let mut x: u64 = 1;
    let mut bytes = Vec::with_capacity(64 << 20);
    while bytes.len() < 64 << 20 {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        bytes.extend_from_slice(&x.wrapping_mul(0x2545_f491_4f6c_dd1d).to_le_bytes());
    }
    std::fs::write(path, &bytes).unwrap();
}

fn sha256(p: &Path) -> String {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(p)
        .env_clear()
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

/// Linux with `--disk` and `macvmm.test=case`, sandboxed. `None` if skipping is allowed.
fn linux_blk(disk: &Path, case: &str) -> Option<support::Outcome> {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return None;
    };
    let cmdline = format!("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test={case}");
    Some(run(
        &[
            "run",
            "--sandbox-selftest",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--disk",
            disk.to_str().unwrap(),
            "--on-reset",
            "exit",
            "--timeout",
            "60",
            "--cmdline",
            &cmdline,
        ],
        T60,
    ))
}

/// SBX-3 item 3 (read): the guest's sha256 of `/dev/vda` equals the host's.
#[test]
fn sandbox_blk_read() {
    let dir = scratch("sandbox_blk_read");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let host = sha256(&disk);
    let Some(o) = linux_blk(&disk, "vda") else {
        return;
    };
    expect_code("sandbox_blk_read", &o, 0);
    markers(&o, SELFTEST);
    let want = format!("macvmm-vda: sha256={host}");
    assert!(o.stdout.contains(&want), "missing {want:?}\n{}", o.dump());
    let _ = std::fs::remove_dir_all(&dir);
}

/// SBX-3 item 3 (FLUSH): `dd ... conv=fsync` makes Linux send VIRTIO_BLK_T_FLUSH, which the
/// device answers only after `F_FULLFSYNC` on the open fd succeeded (BLK-9), under the sandbox.
#[test]
fn sandbox_blk_flush() {
    let dir = scratch("sandbox_blk_flush");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let before = sha256(&disk);
    let Some(o) = linux_blk(&disk, "vda-write") else {
        return;
    };
    expect_code("sandbox_blk_flush", &o, 0);
    markers(&o, &format!("{SELFTEST}\nmacvmm-vda: write done\n!FAILED"));
    assert_ne!(sha256(&disk), before, "the write did not reach the image");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The ch18 rootfs reboot test (`e2e_rootfs` `linux_rootfs_persist`, M15) under the sandbox:
/// boot 1 writes a file on ext4 and resets, boot 2 of the same process verifies it.
#[test]
fn sandbox_rootfs_persist() {
    let (Some(kernel), Some(initrd), Some(modloop)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
        artifact("modloop-virt", "rootfs"),
    ) else {
        return;
    };
    let image = cache_dir().join("rootfs.img");
    assert!(
        image.is_file(),
        "missing artifact rootfs.img: run scripts/fetch.sh rootfs && cargo xtask mkrootfs \
         --out .cache/macvmm/rootfs.img --size 256M"
    );
    let dir = scratch("sandbox_rootfs_persist");
    let clone: PathBuf = dir.join("r.img");
    // An APFS clone (copy-on-write): the cached image is never written (SC-14).
    let st = Command::new("/bin/cp")
        .arg("-c")
        .arg(&image)
        .arg(&clone)
        .env_clear()
        .status()
        .unwrap();
    assert!(st.success());
    let ro = format!("{modloop},ro");
    let o = run(
        &[
            "run",
            "--sandbox-selftest",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--disk",
            clone.to_str().unwrap(),
            "--disk",
            &ro,
            "--timeout",
            "120",
            "--log",
            "info",
            "--cmdline",
            "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 root=/dev/vda macvmm.test=rootfs",
        ],
        T120,
    );
    expect_code("sandbox_rootfs_persist", &o, 0);
    expect("linux-rootfs", &o);
    markers(&o, SELFTEST);
    assert_eq!(
        o.stdout.matches("macvmm-initramfs: ready").count(),
        2,
        "expected two boots\n{}",
        o.dump()
    );
    let wrote = o
        .stdout
        .split("macvmm-rootfs: wrote /persist.bin sha256=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or_else(|| panic!("no write marker\n{}", o.dump()));
    assert!(
        o.stdout
            .contains(&format!("macvmm-rootfs: persist ok sha256={wrote}")),
        "{}",
        o.dump()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TTY-10 / SINK-1 under the lockdown: the stdin thread (started before it) still sees
/// Ctrl-A x, and the run stops with 130 within a second.
#[test]
fn sandbox_ctrl_a_x() {
    let dir = scratch("sandbox_ctrl_a_x");
    let spin = dir.join("spin.bin");
    std::fs::write(&spin, [0x00, 0x00, 0x00, 0x14]).unwrap(); // `b .`
    let raw = format!("{}@0x40080000", spin.display());
    let mut r = Running::spawn(
        &["run", "--mem", "64M", "--raw", &raw, "--timeout", "10"],
        true,
    );
    std::thread::sleep(Duration::from_millis(500));
    let sent = Instant::now();
    r.send(b"\x01x");
    let (o, exited) = r.finish(T10);
    expect_code("sandbox_ctrl_a_x", &o, 130);
    assert!(
        exited - sent < Duration::from_secs(1),
        "exit took {:?}\n{}",
        exited - sent,
        o.dump()
    );
    assert!(o.stderr.contains("user quit"), "{}", o.dump());
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROC-1 / TTY-6 under the lockdown: raw mode is entered before it and restored after it.
#[test]
fn sandbox_tty_restored() {
    let shell = format!(
        "stty -g; {} run --mem 64M --kernel {} --timeout 10; echo \"rc=$?\"; stty -g",
        sh_quote(&macvmm().to_string_lossy()),
        sh_quote(&guest("tty-hygiene"))
    );
    let o = run_in_pty(&shell, &[], T10);
    assert!(!o.killed, "{}", o.dump());
    let text = o.text();
    assert!(text.contains("rc=0"), "{}", o.dump());
    let stty: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| l.starts_with("gfmt1:"))
        .collect();
    assert_eq!(stty.len(), 2, "{}", o.dump());
    assert_eq!(
        stty[0],
        stty[1],
        "stty -g changed under the sandbox\n{}",
        o.dump()
    );
}

/// Run macvmm with `args` under `sandbox-exec -p '(version 1)(allow default)'`: an
/// already-sandboxed process, whose own `sandbox_init` must fail.
fn under_sandbox_exec(args: &[&str]) -> std::process::Output {
    Command::new("/usr/bin/sandbox-exec")
        .args(["-p", "(version 1)(allow default)"])
        .arg(macvmm())
        .args(args)
        .env_remove("MACVMM_LOG")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap()
}

/// SBX-4: the sandbox is never silently skipped. Only `--no-sandbox` runs unconfined.
#[test]
fn sandbox_fail_closed() {
    let hello = guest("hello");
    for flags in [&[][..], &["--sandbox"][..]] {
        let mut args = vec!["run"];
        args.extend_from_slice(flags);
        args.extend_from_slice(&["--kernel", &hello, "--timeout", "5"]);
        let o = under_sandbox_exec(&args);
        let err = String::from_utf8_lossy(&o.stderr);
        assert_eq!(o.status.code(), Some(1), "{flags:?}: {err}");
        assert!(err.contains("macvmm: sandbox: sandbox_init:"), "{err}");
        assert!(err.contains("--no-sandbox"), "the opt-out is named: {err}");
        assert!(
            !String::from_utf8_lossy(&o.stdout).contains("hello from guest"),
            "{flags:?}: the guest ran although the sandbox failed"
        );
    }
    let o = under_sandbox_exec(&[
        "run",
        "--sandbox=best-effort",
        "--kernel",
        &hello,
        "--timeout",
        "5",
    ]);
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(0), "{err}");
    assert!(err.contains("running WITHOUT the sandbox"), "{err}");
    assert!(String::from_utf8_lossy(&o.stdout).contains("hello from guest"));
    // `--no-sandbox` never calls `sandbox_init`, so it runs inside another sandbox silently.
    let o = under_sandbox_exec(&["run", "--no-sandbox", "--kernel", &hello, "--timeout", "5"]);
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(0), "{err}");
    assert!(!err.contains("sandbox"), "{err}");
    assert!(String::from_utf8_lossy(&o.stdout).contains("hello from guest"));
    // Review fix: `--dry-run` is no exception; it parses the kernel, so it fails closed too.
    let o = under_sandbox_exec(&["run", "--dry-run", "--kernel", &hello]);
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(1), "{err}");
    assert!(err.contains("macvmm: sandbox: sandbox_init:"), "{err}");
    assert!(o.stdout.is_empty(), "a boot plan was printed unconfined");
}

/// D21: with no sandbox flag the run is confined (the self-test passes and `RLIMIT_NOFILE` is
/// lowered), `--sandbox` is the same run, and `--no-sandbox` is not confined. Contradictory
/// flags, a self-test without a sandbox and a `,learn` NIC under the default sandbox are usage
/// errors (exit 2), refused before any file or socket is opened.
#[test]
fn sandbox_default_confined() {
    let hello = guest("hello");
    for flags in [&[][..], &["--sandbox"][..]] {
        let mut args = vec!["run"];
        args.extend_from_slice(flags);
        args.extend_from_slice(&[
            "--sandbox-selftest",
            "--kernel",
            &hello,
            "--timeout",
            "5",
            "--stats",
        ]);
        let o = run(&args, T10);
        expect_code("sandbox_default_confined", &o, 0);
        expect("hello", &o);
        markers(&o, SELFTEST);
        assert!((19..=64).contains(&nofile(&o)), "{flags:?}\n{}", o.dump());
    }
    let open = run(
        &[
            "run",
            "--no-sandbox",
            "--kernel",
            &hello,
            "--timeout",
            "5",
            "--stats",
        ],
        T10,
    );
    expect_code("sandbox_default_confined (--no-sandbox)", &open, 0);
    expect("hello", &open);
    assert!(!open.stderr.contains("sandbox:"), "{}", open.dump());
    assert!(nofile(&open) > 64, "{}", open.dump());
    let t = scratch("sandbox_default_confined");
    std::fs::set_permissions(&t, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let learn = format!("unixgram:{},learn", t.join("a.sock").display());
    for (args, want) in [
        (
            vec!["run", "--sandbox", "--no-sandbox", "--kernel", &hello],
            "macvmm: --sandbox and --no-sandbox cannot be used together",
        ),
        (
            vec![
                "run",
                "--no-sandbox",
                "--sandbox-selftest",
                "--kernel",
                &hello,
            ],
            "macvmm: --sandbox-selftest cannot be used with --no-sandbox",
        ),
        (
            vec!["run", "--kernel", &hello, "--net", &learn],
            "macvmm: --net ...,learn cannot run under the sandbox",
        ),
    ] {
        let o = run(&args, T10);
        expect_code("sandbox_default_confined (usage)", &o, 2);
        assert!(o.stderr.contains(want), "{args:?}\n{}", o.dump());
    }
    assert!(
        !t.join("a.sock").exists(),
        "the learn NIC's socket was bound before the usage error"
    );
    let _ = std::fs::remove_dir_all(&t);
}

/// SBX-4 (review fix): `--dry-run` parses the untrusted kernel and initrd headers, so the
/// sandbox confines it as well, and `--sandbox-selftest` reports, before the plan is printed.
#[test]
fn sandbox_dry_run() {
    let o = run(
        &[
            "run",
            "--sandbox-selftest",
            "--dry-run",
            "--kernel",
            &guest("hello"),
        ],
        T10,
    );
    expect_code("sandbox_dry_run", &o, 0);
    markers(&o, SELFTEST);
    assert!(!o.stdout.trim().is_empty(), "no boot plan\n{}", o.dump());
}

/// SBX-1: the exec-time fallback, with an in-process reboot and an output file.
#[test]
fn sandbox_exec_fallback() {
    let dir = scratch("sandbox_exec_fallback");
    let out = dir.join("serial.txt");
    let probe = guest("psci-probe");
    let serial = format!("file:{}", out.display());
    let o = Command::new(support::repo_root().join("scripts/sandbox-exec-fallback.sh"))
        .args(["--read", &probe, "--write", out.to_str().unwrap(), "--"])
        .arg(macvmm())
        .args([
            "run",
            "--kernel",
            &probe,
            "--serial",
            &serial,
            "--timeout",
            "10",
        ])
        .env_remove("MACVMM_LOG")
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&o.stderr);
    assert_eq!(o.status.code(), Some(0), "{err}");
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(text.contains("psci-probe: boot 1"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PROC-4: `RLIMIT_CORE` is 0 always; the default sandbox lowers `RLIMIT_NOFILE` to the fds in
/// use plus 16, and `--no-sandbox` leaves it alone.
#[test]
fn rlimit_stats() {
    let hello = guest("hello");
    let plain = run(
        &[
            "run",
            "--no-sandbox",
            "--kernel",
            &hello,
            "--timeout",
            "5",
            "--stats",
        ],
        T10,
    );
    expect_code("rlimit_stats", &plain, 0);
    let boxed = run(
        &["run", "--kernel", &hello, "--timeout", "5", "--stats"],
        T10,
    );
    expect_code("rlimit_stats", &boxed, 0);
    let (p, b) = (nofile(&plain), nofile(&boxed));
    assert!(b < p, "nofile {b} under the sandbox, {p} with --no-sandbox");
    assert!((19..=64).contains(&b), "nofile {b}\n{}", boxed.dump());
}

/// SBX-2 "as shipped" item 2: two sandboxed VMs talk over `--net unixgram` (M24). Each profile
/// allows `send_to` exactly its peer's socket path; receiving on the bound socket needs no
/// rule. Ping 5/5 and a 32 MiB transfer with equal hashes, as in `e2e_net`.
#[test]
fn sandbox_net() {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return;
    };
    let t = scratch("sandbox_net");
    std::fs::set_permissions(&t, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    let (a, b) = (t.join("a.sock"), t.join("b.sock"));
    let vm = |me: &Path, peer: &Path, mac: &str, case: &str| -> Vec<String> {
        let net = format!(
            "unixgram:{},peer={},mac={mac}",
            me.display(),
            peer.display()
        );
        let cmdline =
            format!("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test={case}");
        [
            "run",
            "--sandbox-selftest",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--on-reset",
            "exit",
            "--timeout",
            "120",
            "--stats",
            "--net",
            &net,
            "--cmdline",
            &cmdline,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    };
    let argv_b = vm(&b, &a, "02:6d:76:00:00:02", "net-b");
    let argv_b: Vec<&str> = argv_b.iter().map(String::as_str).collect();
    let mut vm_b = Running::spawn(&argv_b, true);
    assert!(
        vm_b.wait_for("macvmm-net: listening", T60),
        "VM B never listened"
    );
    let argv_a = vm(&a, &b, "02:6d:76:00:00:01", "net-a");
    let argv_a: Vec<&str> = argv_a.iter().map(String::as_str).collect();
    let vm_a = Running::spawn(&argv_a, true);
    let (oa, _) = vm_a.finish(T120 + T60);
    let (ob, _) = vm_b.finish(T120 + T60);
    expect_code("sandbox_net (A)", &oa, 0);
    expect_code("sandbox_net (B)", &ob, 0);
    expect("net-a", &oa);
    expect("net-b", &ob);
    markers(&oa, SELFTEST);
    markers(&ob, SELFTEST);
    let sha = |o: &support::Outcome, m: &str| {
        o.stdout
            .lines()
            .find(|l| l.contains(m))
            .and_then(|l| l.split("sha256=").nth(1))
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    let (sa, sb) = (
        sha(&oa, "macvmm-net: sent 33554432 bytes"),
        sha(&ob, "macvmm-net: received 33554432 bytes"),
    );
    assert_eq!(sa.len(), 64, "{}", oa.dump());
    assert_eq!(sa, sb, "hashes differ\n{}\n{}", oa.dump(), ob.dump());
    let _ = std::fs::remove_dir_all(&t);
}
