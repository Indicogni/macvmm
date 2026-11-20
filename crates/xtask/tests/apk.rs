//! `xtask derive extract-apk` (PLAN M18; threat model SC-4, SC-5, SC-6, SC-7). Synthetic
//! `.apk` files only (three concatenated gzip members of tar archives, as Alpine's), made
//! here with `/usr/bin/gzip`; no package is committed.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use xtask::apk::{self, ApkError, MAX_MEMBER};
use xtask::zboot::GZIP;

/// One ustar header block + data (padded).
fn member(name: &str, typeflag: u8, data: &[u8], size_field: Option<u64>, link: &str) -> Vec<u8> {
    let mut h = [0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..107].copy_from_slice(b"0000755");
    h[108..115].copy_from_slice(b"0000000");
    h[116..123].copy_from_slice(b"0000000");
    let size = size_field.unwrap_or(data.len() as u64);
    h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
    h[136..147].copy_from_slice(b"00000000000");
    h[156] = typeflag;
    h[157..157 + link.len()].copy_from_slice(link.as_bytes());
    h[257..263].copy_from_slice(b"ustar\0");
    h[263..265].copy_from_slice(b"00");
    h[148..156].copy_from_slice(b"        ");
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
    let mut v = h.to_vec();
    v.extend_from_slice(data);
    while v.len() % 512 != 0 {
        v.push(0);
    }
    v
}

fn file(name: &str, data: &[u8]) -> Vec<u8> {
    member(name, b'0', data, None, "")
}

/// A tar segment: members then the two end-of-archive blocks.
fn segment(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut v = parts.concat();
    v.extend(vec![0u8; 1024]);
    v
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut child = Command::new(GZIP)
        .args(["-1", "-c"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = data.to_vec();
    let w = std::thread::spawn(move || stdin.write_all(&input).unwrap());
    let out = child.wait_with_output().unwrap();
    w.join().unwrap();
    assert!(out.status.success());
    out.stdout
}

const UBOOT: &str = "usr/share/u-boot/qemu_arm64/u-boot.bin";

/// An `.apk`: signature, control and data segments, each its own gzip member.
fn apk(data_members: &[Vec<u8>]) -> Vec<u8> {
    let sig = segment(&[file(".SIGN.RSA.test.rsa.pub", b"not a real signature")]);
    let control = segment(&[file(".PKGINFO", b"pkgname = u-boot-qemu\n")]);
    let data = segment(data_members);
    [gzip(&sig), gzip(&control), gzip(&data)].concat()
}

fn payload() -> Vec<u8> {
    let mut b = 0x1400_0000u32.to_le_bytes().to_vec();
    b.extend((0..5000u32).map(|i| (i % 251) as u8));
    b
}

#[test]
fn extracts_the_member_across_concatenated_gzip_members() {
    let a = apk(&[
        member("usr/", b'5', &[], None, ""),
        file("usr/share/u-boot/qemu_arm/u-boot.bin", b"the 32-bit one"),
        file(UBOOT, &payload()),
    ]);
    assert_eq!(
        apk::extract_with(GZIP.as_ref(), &a, UBOOT).unwrap(),
        payload()
    );
    // The member name is normalised like the archive's (`./` prefix, doubled slashes).
    let b = apk(&[file(&format!("./{UBOOT}"), &payload())]);
    assert_eq!(
        apk::extract_with(
            GZIP.as_ref(),
            &b,
            "usr//share/./u-boot/qemu_arm64/u-boot.bin"
        )
        .unwrap(),
        payload()
    );
}

#[test]
fn run_writes_a_new_non_executable_file_only() {
    let dir = std::env::temp_dir().join(format!("xtask-apk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join("u-boot-qemu.apk");
    std::fs::write(&input, apk(&[file(UBOOT, &payload())])).unwrap();
    let out = dir.join("u-boot.bin");
    apk::run(&input, &out, UBOOT).unwrap();
    assert_eq!(std::fs::read(&out).unwrap(), payload());
    let mode = std::fs::metadata(&out).unwrap().permissions().mode();
    assert_eq!(mode & 0o111, 0, "never executable (SC-4): {mode:o}");
    // O_EXCL: an existing output is never replaced.
    assert!(matches!(
        apk::run(&input, &out, UBOOT),
        Err(ApkError::Io(..))
    ));
    // O_NOFOLLOW: a planted symlink is never written through.
    let canary = dir.join("canary");
    std::fs::write(&canary, b"keep").unwrap();
    let link = dir.join("link.bin");
    std::os::unix::fs::symlink(&canary, &link).unwrap();
    assert!(apk::run(&input, &link, UBOOT).is_err());
    assert_eq!(std::fs::read(&canary).unwrap(), b"keep");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hostile_packages_are_refused() {
    let gz = GZIP.as_ref();
    // Missing member.
    let a = apk(&[file("usr/bin/other", b"x")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::Missing(_))
    ));
    // The name twice (a parser differential): refused, whichever copy comes first.
    let a = apk(&[file(UBOOT, b"one"), file(UBOOT, b"two")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::Duplicate(_))
    ));
    // A symlink or hard link with the wanted name is refused, never resolved.
    let a = apk(&[member(UBOOT, b'2', &[], None, "/etc/passwd")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::NotAFile(_))
    ));
    let a = apk(&[file("usr/x", b"x"), member(UBOOT, b'1', &[], None, "usr/x")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::NotAFile(_))
    ));
    // A member over the cap is refused from its header, before its data is read (SC-6).
    let a = apk(&[member(UBOOT, b'0', &[], Some(MAX_MEMBER + 1), "")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::Tar(_))
    ));
    // A `..` member name in the archive is a malformed package (SC-7 normalisation).
    let a = apk(&[file("../escape", b"x"), file(UBOOT, b"x")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::Tar(_))
    ));
    // Device nodes are refused by the tar reader.
    let a = apk(&[member("dev/null", b'3', &[], None, "")]);
    assert!(matches!(
        apk::extract_with(gz, &a, UBOOT),
        Err(ApkError::Tar(_))
    ));
    // Not gzip at all; a truncated gzip stream.
    assert!(matches!(
        apk::extract_with(gz, b"PK\x03\x04", UBOOT),
        Err(ApkError::Inflate(_))
    ));
    let good = apk(&[file(UBOOT, &payload())]);
    assert!(apk::extract_with(gz, &good[..good.len() - 20], UBOOT).is_err());
}

#[test]
fn bad_member_arguments_are_refused() {
    let a = apk(&[file(UBOOT, b"x")]);
    for bad in [
        "",
        "/",
        "/usr/share/u-boot.bin",
        "../u-boot.bin",
        "a/../../b",
        "./",
    ] {
        assert!(
            matches!(
                apk::extract_with(GZIP.as_ref(), &a, bad),
                Err(ApkError::BadMember(_))
            ),
            "{bad:?}"
        );
    }
}
