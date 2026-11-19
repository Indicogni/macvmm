//! `macvmm run --dry-run` makes no HVF call (PLAN M9 acceptance; threat model §10.2 M9: "`--dry-run`
//! makes no HVF call and needs no entitlement").
//!
//! The proof is behavioural: a copy of the binary is re-signed **without** the hypervisor
//! entitlement (`scripts/sign.sh --no-entitlements`), so any `hv_vm_create` it made would fail
//! with `HV_DENIED` and exit 1. The dry run of a synthetic Image + initrd must still exit 0 with
//! the PLAN §1 plan, and the positive control (a real run of the same binary) must exit 1. This
//! is a host test: it needs no VM, so it runs in `cargo test --workspace`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn target_dir() -> PathBuf {
    match std::env::var_os("CARGO_TARGET_DIR") {
        Some(t) if Path::new(&t).is_absolute() => PathBuf::from(t),
        Some(t) => repo_root().join(t),
        None => repo_root().join("target"),
    }
}

/// A copy of `macvmm` signed with no entitlements, under the target dir (SIGN-4).
fn unentitled() -> PathBuf {
    let dir = target_dir().join(format!("m9-unentitled-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("macvmm");
    std::fs::copy(env!("CARGO_BIN_EXE_macvmm"), &bin).unwrap();
    let out = Command::new(repo_root().join("scripts/sign.sh"))
        .arg("--no-entitlements")
        .arg(&bin)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ents = Command::new("codesign")
        .args(["-d", "--entitlements", "-"])
        .arg(&bin)
        .output()
        .unwrap();
    let all = format!(
        "{}{}",
        String::from_utf8_lossy(&ents.stdout),
        String::from_utf8_lossy(&ents.stderr)
    );
    assert!(!all.contains("com.apple.security.hypervisor"), "{all}");
    bin
}

/// A synthetic arm64 Image header (booting.rst §4): 1 MiB `image_size`, 4 KiB pages.
fn image() -> Vec<u8> {
    let mut b = vec![0u8; 4096];
    b[16..24].copy_from_slice(&(1u64 << 20).to_le_bytes());
    b[24..32].copy_from_slice(&0b1010u64.to_le_bytes());
    b[56..60].copy_from_slice(b"ARM\x64");
    b
}

#[test]
fn dry_run_needs_no_entitlement() {
    let bin = unentitled();
    let dir = bin.parent().unwrap().to_path_buf();
    std::fs::write(dir.join("Image"), image()).unwrap();
    std::fs::write(dir.join("initrd"), [0x30u8; 1000]).unwrap();
    let out = Command::new(&bin)
        .args(["run", "--dry-run", "--mem", "512M", "--kernel"])
        .arg(dir.join("Image"))
        .arg("--initrd")
        .arg(dir.join("initrd"))
        .args(["--cmdline", "console=ttyAMA0 macvmm.test=boot"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(0), "{stdout}\n{stderr}");
    for want in [
        "kernel  0x40200000..0x40300000",
        "initrd  0x40400000..0x404003e8",
        "dtb     0x40000000",
        "entry   pc=0x40200000 x0=0x40000000 cpsr=0x3c5",
        "cmdline \"console=ttyAMA0 macvmm.test=boot\"",
        "linux,initrd-start 0x40400000 linux,initrd-end 0x404003e8",
        "debug hypercalls: off",
    ] {
        assert!(stdout.contains(want), "missing {want:?}:\n{stdout}");
    }
    assert!(!stderr.contains("HV_"), "an HVF call was made: {stderr}");

    // An EFI zboot is refused with the hint, exit code 2, also without HVF.
    let mut zboot = b"MZ\0\0zimg".to_vec();
    zboot.resize(4096, 0);
    std::fs::write(dir.join("vmlinuz"), zboot).unwrap();
    let out = Command::new(&bin)
        .args(["run", "--serial", "none", "--kernel"])
        .arg(dir.join("vmlinuz"))
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("EFI zboot image"));

    // Positive control: the same binary really cannot create a VM (exit 1: HV_DENIED, or
    // HV_UNSUPPORTED on a host without a hypervisor), so the dry run above made no HVF call.
    let out = Command::new(&bin)
        .args(["run", "--serial", "none", "--timeout", "5", "--kernel"])
        .arg(dir.join("Image"))
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("hv_vm_create"), "{stderr}");
    std::fs::remove_dir_all(&dir).unwrap();
}
