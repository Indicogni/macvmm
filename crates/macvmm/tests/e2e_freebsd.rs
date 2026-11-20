//! E2E suite `freebsd` (PLAN M19 "Acceptance: on machine"; course ch22): the stock FreeBSD 15.1
//! arm64 VM image boots through stock U-Boot's UEFI implementation on the `virt` machine, to a
//! root login, and powers off through PSCI.
//!
//! ```text
//! scripts/fetch.sh uboot freebsd   # u-boot.bin; the .raw.xz, then the derived sparse .raw
//! scripts/test-e2e.sh freebsd
//! # = cargo test -p macvmm --features hvf-tests --test e2e_freebsd -- --test-threads=1
//! ```
//!
//! The chain, every link of it unmodified upstream code: U-Boot 2026.04 (`qemu_arm64`, in flash
//! bank 0) → its `efi_mgr` bootmeth finds the EFI system partition on the virtio-blk disk →
//! `\EFI\BOOT\BOOTAA64.EFI`, FreeBSD's `loader.efi` → the loader reads `/boot/kernel/kernel`
//! from UFS through U-Boot's EFI Block I/O and hands it the device tree U-Boot got from us
//! ("Using DTB provided by EFI") → the GENERIC kernel attaches `vtblk0`, mounts
//! `ufs:/dev/gpt/rootfs`, runs `rc`, and `getty` prints `login:` on `ttyu0` (the PL011).
//!
//! **Each run gets its own APFS clone** of the pinned image (`cp -c`, PLAN M19): instant, takes
//! no space until the guest writes, and the cached image is never modified, so its TOFU pin
//! stays valid (SC-10). A clone that cannot be made (the temp dir on another volume) fails the
//! test instead of silently copying 6 GiB.
//!
//! **Escape sequences.** U-Boot's EFI text console follows *every character* the loader prints
//! with `ESC [?25h` (show cursor), so on the raw stream `FreeBSD/arm64 EFI loader` is not a
//! substring. The markers are matched against stdout with CSI and `ESC 7`/`ESC 8` sequences and
//! carriage returns removed ([`plain`]); the default `safe` serial filter is what is under test
//! for terminal safety, not this copy.
//!
//! **Test integrity (AS10).** The guest owns stdout. The test also asserts the exit code (0:
//! FreeBSD's `shutdown -p now` ends in PSCI SYSTEM_OFF) and a stderr line only the VMM prints
//! (the flash device's `ignored 8-byte write` of U-Boot's first `STP`, as in M18), and the
//! VMM-only verdicts that must never appear (`unhandled MMIO`, `unknown SMCCC`, an ISV = 0 access
//! `not emulated`, `guest fatal`). The M19 fix itself is guarded by a forbidden stdout marker:
//! `vtblk0: host requires unsupported maximum segment size feature`, the line FreeBSD printed
//! while the device still offered `VIRTIO_BLK_F_SIZE_MAX` (`docs/compat/freebsd.md`).
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::Path;
use std::process::Command;
use std::time::Duration;
use support::{Outcome, Step, artifact, expect, expect_code, run_steps, scratch};

/// The whole run (PLAN M19 `--timeout 240`). On the dev machine `login:` appears after about
/// 13 s, 10 of them the loader's autoboot countdown.
const T240: Duration = Duration::from_secs(240);

/// `cp -c SRC DST`: an APFS clone (`clonefile(2)`); fails rather than falling back to a copy.
fn clone_image(src: &str, dst: &Path) {
    let out = Command::new("/bin/cp")
        .arg("-c")
        .arg("--")
        .arg(src)
        .arg(dst)
        .output()
        .expect("run /bin/cp -c");
    assert!(
        out.status.success(),
        "cp -c {src} {} failed (is the temp dir on the same APFS volume as the cache?): {}",
        dst.display(),
        String::from_utf8_lossy(&out.stderr)
    );
}

/// `s` without ANSI CSI sequences (`ESC [` params, intermediates, a final byte), `ESC 7`,
/// `ESC 8`, and carriage returns: what a person reading the console would see.
fn plain(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.peek() {
                Some('[') => {
                    it.next();
                    // Parameter and intermediate bytes 0x20..=0x3f, then one final 0x40..=0x7e.
                    while let Some(&n) = it.peek() {
                        it.next();
                        if ('\u{40}'..='\u{7e}').contains(&n) {
                            break;
                        }
                    }
                }
                Some('7' | '8') => {
                    it.next();
                }
                _ => {}
            },
            '\r' => {}
            c => out.push(c),
        }
    }
    out
}

/// PLAN M19 `freebsd_login`: U-Boot → FreeBSD's EFI loader → the kernel → `login:`, log in
/// as root (the VM image ships with an empty root password), `uname -sr`, power off.
#[test]
fn freebsd_login() {
    let Some(bios) = artifact("u-boot.bin", "uboot") else {
        return;
    };
    let Some(image) = artifact("freebsd-15.1-ufs.raw", "freebsd") else {
        return;
    };
    let dir = scratch("freebsd_login");
    let disk = dir.join("f.raw");
    clone_image(&image, &disk);
    let steps = [
        Step::WaitFor("login: "),
        Step::Send(b"root\n".to_vec()),
        Step::WaitFor("root@freebsd:~ # "),
        Step::Send(b"uname -sr\n".to_vec()),
        // The kernel banner and the motd also start with `FreeBSD 15.1-RELEASE`, but neither
        // ends the line there: this is `uname`'s output.
        Step::WaitFor("\nFreeBSD 15.1-RELEASE\r\n"),
        Step::Send(b"shutdown -p now\n".to_vec()),
    ];
    let o = run_steps(
        &[
            "run",
            "--bios",
            bios.as_str(),
            "--disk",
            disk.to_str().unwrap(),
            "--mem",
            "2G",
            "--cpus",
            "2",
            "--timeout",
            "240",
            "--on-reset",
            "exit",
        ],
        &steps,
        T240,
    );
    let _ = std::fs::remove_dir_all(&dir);
    expect_code("freebsd_login", &o, 0);
    let seen = Outcome {
        code: o.code,
        stdout: plain(&o.stdout),
        stderr: o.stderr.clone(),
        wall: o.wall,
        killed: o.killed,
    };
    expect("freebsd-login", &seen);
    eprintln!("freebsd_login: powered off after {:?}", o.wall);
}

#[test]
fn plain_strips_the_efi_console_noise() {
    assert_eq!(
        plain("F\x1b[?25hr\x1b[?25he\x1b[0;37;40me\x1b7\x1b8\r\n"),
        "Free\n"
    );
}
