//! `xtask mkinitramfs` (PLAN M9): golden newc bytes and the overlay rules.

use std::path::PathBuf;
use xtask::cpio::{self, Newc};

/// Golden bytes: one `init` entry (mode 0100755, 3 bytes "#!\n") and the trailer, exactly as
/// buffer-format.rst lays them out (110-byte header, name + NUL padded to 4, data padded to 4).
#[test]
fn golden_single_init_and_trailer() {
    let mut a = Newc::new();
    a.file("init", 0o755, b"#!\n").unwrap();
    let got = a.finish().unwrap();
    let mut want = Vec::new();
    // magic, then ino mode uid gid nlink mtime filesize devmajor devminor rdevmajor rdevminor
    // namesize check: 13 fields of 8 hex digits.
    want.extend_from_slice(
        concat!(
            "070701", "00000001", "000081ed", "00000000", "00000000", "00000001", "00000000",
            "00000003", "00000000", "00000000", "00000000", "00000000", "00000005", "00000000",
        )
        .as_bytes(),
    );
    want.extend_from_slice(b"init\0\0"); // 110 + 5 = 115, padded to 116
    want.extend_from_slice(b"#!\n\0"); // 3 data bytes, padded to 4
    want.extend_from_slice(
        concat!(
            "070701", "00000000", "00000000", "00000000", "00000000", "00000001", "00000000",
            "00000000", "00000000", "00000000", "00000000", "00000000", "0000000b", "00000000",
        )
        .as_bytes(),
    );
    want.extend_from_slice(b"TRAILER!!!\0\0\0\0"); // 110 + 11 = 121, padded to 124
    assert_eq!(
        String::from_utf8_lossy(&got),
        String::from_utf8_lossy(&want)
    );
    assert_eq!(got, want);
    assert_eq!(got.len() % 4, 0);
}

#[test]
fn names_are_checked_and_parents_emitted() {
    // "TRAILER!!!": M22 fuzz regression (the `cpio` target), an early end-of-archive entry.
    for bad in [
        "",
        "/init",
        "a/../b",
        "./x",
        "a//b",
        "..",
        "a\0b",
        "TRAILER!!!",
        "TRAILER!!!/x",
    ] {
        assert!(cpio::check_name(bad).is_err(), "{bad:?}");
    }
    let mut a = Newc::new();
    a.file("usr/bin/t", 0o4755, b"x").unwrap();
    let out = a.finish().unwrap();
    let s = String::from_utf8_lossy(&out);
    let usr = s.find("usr\0").unwrap();
    let bin = s.find("usr/bin\0").unwrap();
    let t = s.find("usr/bin/t\0").unwrap();
    assert!(usr < bin && bin < t);
    // setuid dropped: mode 0100755.
    assert!(s.contains("000081ed"));
    assert!(!s.contains("000089ed"));
}

#[test]
fn overlay_reads_only_given_paths_and_never_follows_symlinks() {
    let dir = std::env::temp_dir().join(format!("xtask-cpio-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("tree/sub")).unwrap();
    std::fs::write(dir.join("init"), b"#!/bin/sh\n").unwrap();
    std::fs::write(dir.join("secret"), b"host secret").unwrap();
    std::fs::write(dir.join("tree/sub/f"), b"data").unwrap();
    std::os::unix::fs::symlink(dir.join("secret"), dir.join("tree/link")).unwrap();
    let adds = vec![(dir.join("tree"), "opt/t".to_owned())];
    let ov = cpio::overlay(&dir.join("init"), &adds).unwrap();
    let s = String::from_utf8_lossy(&ov);
    assert!(s.contains("opt/t/sub/f\0"));
    assert!(s.contains("opt/t/link\0"));
    assert!(!s.contains("host secret"), "a symlink was followed");
    assert!(
        s.contains(&dir.join("secret").display().to_string()),
        "target kept as data"
    );
    // A symlink given directly as --init is refused (O_NOFOLLOW).
    std::os::unix::fs::symlink(dir.join("init"), dir.join("init-link")).unwrap();
    assert!(cpio::overlay(&dir.join("init-link"), &[]).is_err());
    // Base + pad to 4 + overlay; the output is created fresh.
    std::fs::write(dir.join("base"), b"\x1f\x8b\x08abcde").unwrap(); // 8 bytes
    std::fs::write(dir.join("base7"), b"1234567").unwrap();
    let n = cpio::run(&dir.join("base7"), &dir.join("init"), &[], &dir.join("out")).unwrap();
    let out = std::fs::read(dir.join("out")).unwrap();
    assert_eq!(n as usize, out.len());
    assert_eq!(&out[..8], b"1234567\0");
    assert_eq!(&out[8..14], b"070701");
    assert!(cpio::run(&dir.join("base"), &dir.join("init"), &[], &dir.join("out")).is_err());
    // --add parsing.
    assert_eq!(
        cpio::parse_add("a:b:/etc/x").unwrap(),
        (PathBuf::from("a:b"), "etc/x".to_owned())
    );
    assert!(cpio::parse_add("a:../x").is_err());
    assert!(cpio::parse_add("nocolon").is_err());
    // A FIFO source is refused.
    let st = std::process::Command::new("mkfifo")
        .arg(dir.join("fifo"))
        .status()
        .unwrap();
    assert!(st.success());
    let mut a = Newc::new();
    assert!(cpio::add_path(&mut a, &dir.join("fifo"), "fifo").is_err());
    std::fs::remove_dir_all(&dir).unwrap();
}
