//! E2E suite `rootfs` (PLAN M15 "Acceptance: on machine"; course ch18 part 2): Alpine boots
//! into an ext4 root filesystem on virtio-blk, writes a file, resets through PSCI
//! SYSTEM_RESET, and finds the file intact on the next boot of the same process.
//!
//! ```text
//! scripts/fetch.sh linux rootfs                     # Image-virt, initramfs, minirootfs, modloop
//! cargo xtask mkrootfs --out .cache/macvmm/rootfs.img --size 256M
//! scripts/test-e2e.sh rootfs
//! ```
//!
//! **The setup.** `ext4.ko` is not in Alpine's `initramfs-virt`, so the test attaches Alpine's
//! `modloop-virt` (a squashfs of every module, sha256-pinned and RSA-signature cross-checked,
//! SC-10) as a second, **read-only** disk; the initramfs `rootfs` case (anchor
//! `initramfs_rootfs`) loads ext4 from it, mounts `/dev/vda` and `switch_root`s into
//! `/sbin/macvmm-init` (`scripts/rootfs/macvmm-init`). macvmm runs with the default
//! `--on-reset reboot`, so the guest's `reboot -f` rebuilds the VM in-process over the same
//! open disk file (anchor `reboot_loop`).
//!
//! **Security (threat model SC-14).** After the run the clone's every byte is guest-controlled.
//! The test therefore boots an **APFS clone** (`cp -c`) of the cached image, never the image
//! itself, and `rootfs_fsck_clean` is the only host parser that ever reads it: `e2fsck -fn`
//! (read-only), on that clone only, with an empty environment, by an e2fsck that passes the
//! 1.47.0 floor itself, under a deadline, and with its output (which echoes the guest-chosen
//! volume label) through the strict `AnsiFilter`. Nothing mounts or attaches it.
//!
//! **Test integrity (AS10).** The guest owns stdout and could print the markers itself, so the
//! reboot is also proven by the VMM's own stderr line `guest reset: rebooting (boot 1)` (at
//! `--log info`), which no guest byte reaches, and the exit code is asserted.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use support::{Outcome, artifact, cache_dir, expect, expect_code, run, scratch};
use vmm::backend::ansi::{AnsiFilter, FilterPolicy};

const T120: Duration = Duration::from_secs(120);
const CMDLINE: &str =
    "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 root=/dev/vda macvmm.test=rootfs";

/// Homebrew's keg-only e2fsprogs (PLAN D8), Apple Silicon then Intel prefix.
const E2FSCK: [&str; 2] = [
    "/opt/homebrew/opt/e2fsprogs/sbin/e2fsck",
    "/usr/local/opt/e2fsprogs/sbin/e2fsck",
];

fn allow_skip() -> bool {
    std::env::var_os("MACVMM_E2E_ALLOW_SKIP").is_some_and(|v| v == "1")
}

/// `<cache>/rootfs.img`, which `cargo xtask mkrootfs` builds (it is not a download, so
/// `support::artifact`'s fetch hint does not apply). Missing fails, unless skipping is allowed.
fn rootfs_image() -> Option<PathBuf> {
    let p = cache_dir().join("rootfs.img");
    match std::fs::symlink_metadata(&p) {
        Ok(m) => {
            assert!(
                m.file_type().is_file(),
                "{} is not a regular file (or is a symlink); refusing",
                p.display()
            );
            Some(p)
        }
        Err(_) if allow_skip() => {
            eprintln!("SKIP: missing artifact rootfs.img: run cargo xtask mkrootfs");
            None
        }
        Err(_) => panic!(
            "missing artifact rootfs.img: run scripts/fetch.sh rootfs && cargo xtask mkrootfs \
             --out .cache/macvmm/rootfs.img --size 256M"
        ),
    }
}

/// `shasum -a 256 FILE` → the hex digest.
fn sha256(p: &Path) -> String {
    let out = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(p)
        .env_clear()
        .output()
        .expect("run shasum");
    assert!(out.status.success(), "shasum {}", p.display());
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

/// The value after `prefix` on the first stdout line that has it.
fn after<'a>(stdout: &'a str, prefix: &str) -> Option<&'a str> {
    stdout
        .lines()
        .find_map(|l| l.split_once(prefix).map(|(_, v)| v.trim()))
}

/// One persistence run shared by both tests (the suite runs with `--test-threads=1`): the
/// clone it booted and what macvmm did.
struct Persisted {
    clone: PathBuf,
    outcome: Outcome,
}

fn persisted() -> Option<&'static Persisted> {
    static RUN: OnceLock<Option<Persisted>> = OnceLock::new();
    RUN.get_or_init(|| {
        let (Some(kernel), Some(initrd), Some(modloop), Some(image)) = (
            artifact("Image-virt", "linux"),
            artifact("initramfs-test.img", "linux"),
            artifact("modloop-virt", "rootfs"),
            rootfs_image(),
        ) else {
            return None; // skipped (MACVMM_E2E_ALLOW_SKIP=1)
        };
        let before = sha256(&image);
        let dir = scratch("linux_rootfs_persist");
        let clone = dir.join("r.img");
        // An APFS clone: copy-on-write, so the cached image is never written (SC-14).
        let st = Command::new("/bin/cp")
            .arg("-c")
            .arg(&image)
            .arg(&clone)
            .env_clear()
            .status()
            .expect("run cp -c");
        assert!(
            st.success(),
            "cp -c {} {}",
            image.display(),
            clone.display()
        );
        let disk = clone.to_str().unwrap().to_owned();
        let ro = format!("{modloop},ro");
        let secs = T120.as_secs().to_string();
        let args = [
            "run",
            "--kernel",
            &kernel,
            "--initrd",
            &initrd,
            "--mem",
            "512M",
            "--disk",
            &disk,
            "--disk",
            &ro,
            "--timeout",
            &secs,
            "--log",
            "info",
            "--cmdline",
            CMDLINE,
        ];
        let outcome = run(&args, T120);
        assert_eq!(sha256(&image), before, "the cached rootfs.img changed");
        Some(Persisted { clone, outcome })
    })
    .as_ref()
}

/// PLAN M15 `linux_rootfs_persist`: boot 1 writes 16 MiB of random data and its sha256 to the
/// ext4 root and resets; boot 2 (same process, `--on-reset reboot`) verifies them and powers
/// off; exit 0.
#[test]
fn linux_rootfs_persist() {
    let Some(p) = persisted() else { return };
    let o = &p.outcome;
    expect_code("linux_rootfs_persist", o, 0);
    expect("linux-rootfs", o);
    let wrote = after(&o.stdout, "macvmm-rootfs: wrote /persist.bin sha256=").unwrap();
    let read = after(&o.stdout, "macvmm-rootfs: persist ok sha256=").unwrap();
    assert_eq!(wrote.len(), 64, "{}", o.dump());
    assert_eq!(wrote, read, "boot 2 read different bytes\n{}", o.dump());
    assert_eq!(
        o.stdout.matches("macvmm-initramfs: ready").count(),
        2,
        "expected exactly two boots\n{}",
        o.dump()
    );
    eprintln!("linux_rootfs_persist: wall {:?}", o.wall);
}

/// e2fsck is a host parser fed a hostile image: it must be at least this release (the same
/// SC-14 floor as `xtask::rootfs::E2FS_MIN`, which `mkrootfs` and `setup.sh` apply to
/// `mkfs.ext4`; that may be a different binary, e.g. `$MACVMM_MKFS_EXT4`, so the e2fsck that
/// actually parses the clone is checked itself).
const E2FSCK_MIN: (u32, u32, u32) = (1, 47, 0);

/// e2fsck on a crafted image has a history of very long runs and loops; the guest wrote this
/// one, so it gets a deadline like the VM run before it.
const FSCK_LIMIT: Duration = Duration::from_secs(60);

/// At most this much e2fsck output is read back (a hostile image can make it chatty).
const FSCK_OUT_MAX: u64 = 64 << 10;

/// `e2fsck 1.47.4 (6-Mar-2025)` → `(1, 47, 4)`.
fn parse_e2fsck_version(text: &str) -> Option<(u32, u32, u32)> {
    let word = text
        .split_whitespace()
        .skip_while(|w| *w != "e2fsck")
        .nth(1)?;
    let mut it = word.split('.').map(|p| p.parse::<u32>().ok());
    let a = it.next()??;
    let b = it.next()??;
    let c = it.next().flatten().unwrap_or(0);
    Some((a, b, c))
}

/// Bytes the guest may control, made safe for the developer's terminal: e2fsck prints the
/// ext4 volume label (`s_volume_name`, which the guest can rewrite through /dev/vda) verbatim
/// as the device name of its summary line, so its output is guest output and goes through the
/// project's [`AnsiFilter`] like every other sink (CLAUDE.md; threat model TTY-1, S26). The
/// `strict` policy renders every control visibly (`ESC` → `^[`) and never emits one.
fn filtered(bytes: &[u8]) -> String {
    let mut f = AnsiFilter::new(FilterPolicy::Strict);
    let mut out = Vec::with_capacity(bytes.len());
    f.push(bytes, &mut out);
    String::from_utf8_lossy(&out).into_owned()
}

/// Read at most [`FSCK_OUT_MAX`] bytes of `p`.
fn read_capped(p: &Path) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Ok(f) = std::fs::File::open(p) {
        let _ = f.take(FSCK_OUT_MAX).read_to_end(&mut buf);
    }
    buf
}

/// The strict filter's contract, checked without HVF: an e2fsck summary line whose "device
/// name" is a hostile 16-byte label (window title, screen clear, bell) reaches the terminal
/// with no ESC, BEL or other C0 byte.
#[test]
fn fsck_output_is_filtered() {
    let line = b"\x1b]0;PWN\x07\x1b[2J: 12/2048 files (0.0% non-contiguous)\n";
    let s = filtered(line);
    assert!(
        !s.bytes().any(|b| b < 0x20 && b != b'\n'),
        "control byte escaped the filter: {s:?}"
    );
    assert!(s.contains("12/2048 files"), "{s:?}");
    assert_eq!(
        parse_e2fsck_version("e2fsck 1.47.4 (6-Mar-2025)\n"),
        Some((1, 47, 4))
    );
    assert_eq!(parse_e2fsck_version("e2fsck 1.46 (x)"), Some((1, 46, 0)));
    assert_eq!(parse_e2fsck_version("garbage"), None);
}

/// PLAN M15 `rootfs_fsck_clean` (SC-14): `e2fsck -fn` on the clone the guest wrote exits 0.
/// Read-only (`-n`), on the per-test clone only, with an empty environment, by an e2fsck of at
/// least [`E2FSCK_MIN`], under a [`FSCK_LIMIT`] deadline, and its output filtered.
#[test]
fn rootfs_fsck_clean() {
    let Some(p) = persisted() else { return };
    expect_code(
        "linux_rootfs_persist (for rootfs_fsck_clean)",
        &p.outcome,
        0,
    );
    assert!(
        !p.clone.starts_with(cache_dir()),
        "e2fsck must only read the per-test clone (SC-14)"
    );
    let Some(e2fsck) = E2FSCK.iter().map(Path::new).find(|p| p.is_file()) else {
        if allow_skip() {
            eprintln!("SKIP: e2fsck missing: brew install e2fsprogs");
            return;
        }
        panic!("missing tool e2fsck: brew install e2fsprogs (PLAN D8)");
    };
    // The version floor, on this very binary (`-V` reads no image; its output is the tool's).
    let v = Command::new(e2fsck)
        .arg("-V")
        .env_clear()
        .output()
        .expect("run e2fsck -V");
    let vtext = format!(
        "{}{}",
        String::from_utf8_lossy(&v.stdout),
        String::from_utf8_lossy(&v.stderr)
    );
    let Some(ver) = parse_e2fsck_version(&vtext) else {
        panic!(
            "cannot read the e2fsprogs version from {} -V:\n{}",
            e2fsck.display(),
            filtered(vtext.as_bytes())
        );
    };
    assert!(
        ver >= E2FSCK_MIN,
        "e2fsck {}.{}.{} at {} is older than {}.{}.{} (SC-14: it parses guest-written images); \
         run: brew upgrade e2fsprogs",
        ver.0,
        ver.1,
        ver.2,
        e2fsck.display(),
        E2FSCK_MIN.0,
        E2FSCK_MIN.1,
        E2FSCK_MIN.2
    );
    // Output goes to files next to the clone (no pipe to fill and stall on), the run is
    // polled against a deadline and killed on expiry.
    let dir = p.clone.parent().unwrap();
    let out_path = dir.join("e2fsck.out");
    let err_path = dir.join("e2fsck.err");
    let mut child = Command::new(e2fsck)
        .arg("-fn")
        .arg(&p.clone)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(std::fs::File::create(&out_path).unwrap())
        .stderr(std::fs::File::create(&err_path).unwrap())
        .spawn()
        .expect("run e2fsck");
    let deadline = Instant::now() + FSCK_LIMIT;
    let status = loop {
        if let Some(st) = child.try_wait().expect("wait e2fsck") {
            break st;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!(
                "e2fsck -fn did not finish within {FSCK_LIMIT:?} on the guest-written clone: \
                 a hostile image can make e2fsck hang (SC-14)"
            );
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut raw = read_capped(&out_path);
    raw.extend_from_slice(&read_capped(&err_path));
    let text = filtered(&raw);
    eprintln!(
        "rootfs_fsck_clean: e2fsck {}.{}.{} -fn exited {:?}\n{text}",
        ver.0,
        ver.1,
        ver.2,
        status.code()
    );
    assert_eq!(status.code(), Some(0), "e2fsck -fn found problems:\n{text}");
}
