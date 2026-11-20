//! E2E suite `firmware` (PLAN M18 "Acceptance: on machine"; course ch21): stock U-Boot
//! 2026.04 (`qemu_arm64`, from Alpine's sha256-pinned `u-boot-qemu` package) runs from flash
//! bank 0 on the `virt` machine, reaches its prompt, finds the virtio-blk disk, and powers off
//! or resets through PSCI.
//!
//! ```text
//! scripts/fetch.sh uboot        # u-boot-qemu-2026.04-r1.apk, then the derived u-boot.bin
//! scripts/test-e2e.sh firmware
//! # = cargo test -p macvmm --features hvf-tests --test e2e_firmware -- --test-threads=1
//! ```
//!
//! Every case boots `--bios <cache>/u-boot.bin --mem 512M --timeout 60` with the default `safe`
//! serial policy (the PLAN M18 security test). The PLAN cases stop the countdown with Enter as
//! soon as `Hit any key to stop autoboot` appears, so the disk is never booted from.
//! `uboot_autoboot_dsr` lets it expire instead: only then does U-Boot's `efi_mgr` bootmeth
//! probe the terminal size with `ESC [6n` (DSR), so only that case can show that `safe` drops
//! the query (TTY-3; risk R18; it costs about 100 ms, `docs/compat/uboot.md` §6).
//!
//! **Test integrity (AS10).** The guest owns stdout and could print any U-Boot text, so each
//! test asserts the exit code and a stderr line only the VMM prints: `uboot_prompt` the flash
//! device's `ignored 8-byte write` of U-Boot's first `STP` (an ISV = 0 store executed *from
//! flash*: it proves the ROM instruction fetch and the write-ignore path, MMIO-10), and
//! `uboot_reset` the CLI's reset verdict, `uboot_autoboot_dsr` that the probe *around* the DSR
//! (`ESC [999;999H`) reached stdout, so the missing `ESC [6n` was filtered, not never sent.
//! The VMM-only verdicts that must never appear
//! (`unhandled MMIO`, `unknown SMCCC`, an ISV = 0 access `not emulated`, `guest fatal`) are
//! matched on stderr too.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::Path;
use std::time::Duration;
use support::{Outcome, Step, artifact, expect, expect_code, run_steps, scratch};

const T60: Duration = Duration::from_secs(60);

/// A 16 MiB zero-filled (sparse) raw disk for virtio-blk.
fn mkdisk(path: &Path) {
    let f = std::fs::File::create(path).unwrap();
    f.set_len(16 << 20).unwrap();
}

/// The steps that reach the `=> ` prompt: stop the countdown with Enter.
fn to_prompt() -> Vec<Step> {
    vec![
        Step::WaitFor("Hit any key to stop autoboot"),
        Step::Send(b"\n".to_vec()),
        Step::WaitFor("=> "),
    ]
}

/// Boot U-Boot with `extra` arguments, then run `steps`. `None` when the artifact is missing
/// and skipping is allowed (hosted CI only).
fn uboot(extra: &[&str], steps: &[Step]) -> Option<Outcome> {
    let bios = artifact("u-boot.bin", "uboot")?;
    let mut args = vec![
        "run",
        "--bios",
        bios.as_str(),
        "--mem",
        "512M",
        "--timeout",
        "60",
    ];
    args.extend_from_slice(extra);
    Some(run_steps(&args, steps, T60))
}

/// PLAN M18 `uboot_prompt`: the prompt, `version`, the virtio disk as `Device 0`, `poweroff`.
#[test]
fn uboot_prompt() {
    let dir = scratch("uboot_prompt");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let mut steps = to_prompt();
    steps.extend([
        Step::Send(b"version\n".to_vec()),
        Step::WaitFor("gcc ("),
        Step::Send(b"virtio scan; virtio info\n".to_vec()),
        Step::WaitFor("Device 0"),
        Step::Send(b"poweroff\n".to_vec()),
    ]);
    let Some(o) = uboot(
        &["--disk", disk.to_str().unwrap(), "--on-reset", "exit"],
        &steps,
    ) else {
        return;
    };
    expect_code("uboot_prompt", &o, 0);
    expect("uboot-prompt", &o);
}

/// Risk R18 under the default `safe` policy: let the countdown expire, so the bootflow scan
/// runs the `efi_mgr` bootmeth and U-Boot probes the terminal size (`ESC 7`, `ESC [r`,
/// `ESC [999;999H`, `ESC [6n`, `ESC 8`). The cursor moves reach stdout; the DSR query does not
/// (TTY-3). The `efi_mgr` bootflow it finds cannot load anything from the empty disk, so
/// U-Boot falls back to its prompt.
#[test]
fn uboot_autoboot_dsr() {
    let dir = scratch("uboot_autoboot_dsr");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let steps = [
        Step::WaitFor("Hit any key to stop autoboot"),
        Step::WaitFor("No more bootdevs"),
        Step::WaitFor(" valid)"),
        Step::WaitFor("=> "),
        Step::Send(b"poweroff\n".to_vec()),
    ];
    let Some(o) = uboot(
        &["--disk", disk.to_str().unwrap(), "--on-reset", "exit"],
        &steps,
    ) else {
        return;
    };
    expect_code("uboot_autoboot_dsr", &o, 0);
    expect("uboot-autoboot-dsr", &o);
    // The probe ran and its non-query sequences passed the filter, back to back: `ESC 7`,
    // `ESC [r`, `ESC [999;999H`, then (where the `ESC [6n` was) straight to `ESC 8`.
    assert!(
        o.stdout.contains("\x1b7\x1b[r\x1b[999;999H\x1b8"),
        "the terminal-size probe is not on stdout as expected (without it this test proves \
         nothing)\n{}",
        o.dump()
    );
    // ...and the query itself was dropped.
    assert!(
        !o.stdout.contains("\x1b[6n"),
        "DSR reached stdout under `safe`\n{}",
        o.dump()
    );
}

/// PLAN M18 `uboot_reset`: `reset` is PSCI SYSTEM_RESET, which `--on-reset exit` makes exit
/// code 4.
#[test]
fn uboot_reset() {
    let dir = scratch("uboot_reset");
    let disk = dir.join("disk.img");
    mkdisk(&disk);
    let mut steps = to_prompt();
    steps.push(Step::Send(b"reset\n".to_vec()));
    let Some(o) = uboot(
        &["--disk", disk.to_str().unwrap(), "--on-reset", "exit"],
        &steps,
    ) else {
        return;
    };
    expect_code("uboot_reset", &o, 4);
    expect("uboot-reset", &o);
}

/// PLAN M18 `uboot_no_disk`: without `--disk` the prompt is still reached, and `poweroff`
/// exits 0.
#[test]
fn uboot_no_disk() {
    let mut steps = to_prompt();
    steps.push(Step::Send(b"poweroff\n".to_vec()));
    let Some(o) = uboot(&[], &steps) else {
        return;
    };
    expect_code("uboot_no_disk", &o, 0);
    expect("uboot-no-disk", &o);
}
