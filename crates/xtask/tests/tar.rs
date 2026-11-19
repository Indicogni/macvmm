//! `xtask::tar` (PLAN M9 security tests; threat model SC-6, SC-7 / flaw F10).
//!
//! Every case runs in a fresh temp dir with a **canary file outside the staging root**, whose
//! content and mtime are checked after each extraction: no archive may write outside.
//! Archives are built here byte by byte (ustar, POSIX pax), so no fixtures are committed.

use std::path::{Path, PathBuf};
use std::time::SystemTime;
use xtask::tar::{self, Limits, Options, TarError};

/// One ustar header block + data.
fn member(name: &str, typeflag: u8, mode: u32, data: &[u8], link: &str) -> Vec<u8> {
    let mut h = [0u8; 512];
    h[..name.len()].copy_from_slice(name.as_bytes());
    h[100..107].copy_from_slice(format!("{mode:07o}").as_bytes());
    h[108..115].copy_from_slice(b"0000000");
    h[116..123].copy_from_slice(b"0000000");
    h[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
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
    member(name, b'0', 0o644, data, "")
}
fn dir(name: &str) -> Vec<u8> {
    member(name, b'5', 0o755, &[], "")
}
fn symlink(name: &str, target: &str) -> Vec<u8> {
    member(name, b'2', 0o777, &[], target)
}
fn end() -> Vec<u8> {
    vec![0u8; 1024]
}
fn archive(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut v: Vec<u8> = parts.concat();
    v.extend(end());
    v
}

/// A test sandbox: `root/canary` outside `root/stage`.
struct Sandbox {
    root: PathBuf,
    stage: PathBuf,
    mtime: SystemTime,
}

impl Sandbox {
    fn new(test: &str) -> Sandbox {
        let root = std::env::temp_dir().join(format!("xtask-tar-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("canary"), b"canary").unwrap();
        let mtime = std::fs::metadata(root.join("canary"))
            .unwrap()
            .modified()
            .unwrap();
        let stage = root.join("stage");
        std::fs::create_dir(&stage).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o700)).unwrap();
        Sandbox { root, stage, mtime }
    }
    fn extract(&self, bytes: &[u8], opts: Options) -> Result<tar::Report, TarError> {
        tar::extract(bytes, &self.stage, opts)
    }
    /// The canary is untouched and nothing new appeared next to the stage.
    fn check(&self) {
        assert_eq!(std::fs::read(self.root.join("canary")).unwrap(), b"canary");
        assert_eq!(
            std::fs::metadata(self.root.join("canary"))
                .unwrap()
                .modified()
                .unwrap(),
            self.mtime
        );
        let mut names: Vec<_> = std::fs::read_dir(&self.root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["canary", "stage"]);
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn refused(r: Result<tar::Report, TarError>) -> bool {
    r.is_err()
}

#[test]
fn symlink_chain_escape_is_refused() {
    // a -> ., b -> a/../.., then a member b/x: the classic chain.
    let s = Sandbox::new("chain");
    let a = archive(&[
        symlink("a", "."),
        symlink("b", "a/../.."),
        file("b/x", b"pwned"),
    ]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
    // The same with ../canary as the final name.
    let s = Sandbox::new("chain2");
    let a = archive(&[
        symlink("a", "."),
        symlink("b", "a/../.."),
        file("b/canary", b"pwned"),
    ]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
}

#[test]
fn write_through_symlinked_directory_is_refused() {
    let s = Sandbox::new("throughdir");
    let target = s.root.display().to_string();
    let a = archive(&[symlink("d", &target), file("d/canary", b"pwned")]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
    // A file member named like an earlier symlink is a duplicate, not a write through it.
    let s = Sandbox::new("samename");
    let a = archive(&[symlink("f", "../canary"), file("f", b"pwned")]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
}

#[test]
fn absolute_symlink_target_is_kept_verbatim() {
    let s = Sandbox::new("abslink");
    let a = archive(&[
        dir("bin"),
        file("bin/busybox", b"\x7fELF"),
        symlink("bin/sh", "/bin/busybox"),
        symlink("rel", "bin/busybox"),
    ]);
    let r = s.extract(&a, Options::default()).unwrap();
    assert_eq!((r.files, r.dirs, r.symlinks), (1, 1, 2));
    assert_eq!(
        std::fs::read_link(s.stage.join("bin/sh")).unwrap(),
        Path::new("/bin/busybox")
    );
    assert_eq!(
        std::fs::read_link(s.stage.join("rel")).unwrap(),
        Path::new("bin/busybox")
    );
    s.check();
}

#[test]
fn device_fifo_and_outside_hard_links_are_refused() {
    for (t, name) in [(b'3', "chr"), (b'4', "blk"), (b'6', "fifo")] {
        let s = Sandbox::new(name);
        let a = archive(&[member(name, t, 0o644, &[], "")]);
        assert!(refused(s.extract(&a, Options::default())), "{name}");
        s.check();
    }
    let s = Sandbox::new("hardout");
    let a = archive(&[member("h", b'1', 0o644, &[], "../canary")]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
    let s = Sandbox::new("hardabs");
    let canary = s.root.join("canary").display().to_string();
    let a = archive(&[member("h", b'1', 0o644, &[], &canary[1..])]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
    // A hard link to a file of this archive is fine.
    let s = Sandbox::new("hardin");
    let a = archive(&[file("f", b"data"), member("h", b'1', 0o644, &[], "f")]);
    let r = s.extract(&a, Options::default()).unwrap();
    assert_eq!(r.hardlinks, 1);
    assert_eq!(std::fs::read(s.stage.join("h")).unwrap(), b"data");
    // ... but not to a symlink of it.
    let s = Sandbox::new("hardlink2sym");
    let a = archive(&[
        symlink("l", "../canary"),
        member("h", b'1', 0o644, &[], "l"),
    ]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
}

#[test]
fn setuid_is_stripped_and_exec_kept_off_the_host() {
    use std::os::unix::fs::PermissionsExt;
    let s = Sandbox::new("setuid");
    let a = archive(&[member("su", b'0', 0o6755, b"x", "")]);
    let r = s.extract(&a, Options::default()).unwrap();
    assert_eq!(r.setid_stripped, ["su"]);
    assert_eq!(r.modes["su"], 0o755, "the intended mode, without setuid");
    let host = std::fs::metadata(s.stage.join("su"))
        .unwrap()
        .permissions()
        .mode()
        & 0o7777;
    assert_eq!(host, 0o644, "SC-4: no setuid and no exec bit on the host");
    let s = Sandbox::new("keepexec");
    let opts = Options {
        keep_exec: true,
        ..Options::default()
    };
    s.extract(&a, opts).unwrap();
    let host = std::fs::metadata(s.stage.join("su"))
        .unwrap()
        .permissions()
        .mode()
        & 0o7777;
    assert_eq!(host, 0o755);
}

#[test]
fn dotdot_and_absolute_names_are_refused() {
    for name in [
        "../canary",
        "a/../../canary",
        "/tmp/x",
        "./../canary",
        "a/..",
    ] {
        let s = Sandbox::new("names");
        let a = archive(&[dir("a"), file(name, b"pwned")]);
        assert!(refused(s.extract(&a, Options::default())), "{name}");
        s.check();
    }
    // A leading ./ is normal and accepted.
    let s = Sandbox::new("dotslash");
    let a = archive(&[dir("./"), dir("./etc"), file("./etc/motd", b"hi")]);
    s.extract(&a, Options::default()).unwrap();
    assert_eq!(std::fs::read(s.stage.join("etc/motd")).unwrap(), b"hi");
    // A member whose parent directory was never created by the archive is refused.
    let s = Sandbox::new("noparent");
    let a = archive(&[file("missing/x", b"x")]);
    assert!(refused(s.extract(&a, Options::default())));
}

#[test]
fn oversized_member_and_total_are_refused() {
    let small = Limits {
        max_member: 1000,
        max_total: 1500,
        ..Limits::default()
    };
    let opts = Options {
        limits: small,
        ..Options::default()
    };
    let s = Sandbox::new("member");
    assert!(refused(
        s.extract(&archive(&[file("big", &[1; 1001])]), opts)
    ));
    let s = Sandbox::new("total");
    let a = archive(&[file("a", &[1; 1000]), file("b", &[1; 1000])]);
    assert!(matches!(s.extract(&a, opts), Err(TarError::TooLarge(_))));
    // An oversized size field (more than the data present) is truncation, not a huge alloc.
    let s = Sandbox::new("sizefield");
    let mut m = file("x", b"abc");
    m[124..135].copy_from_slice(b"77777777777");
    let sum: u32 = {
        m[148..156].copy_from_slice(b"        ");
        m[..512].iter().map(|&b| u32::from(b)).sum()
    };
    m[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
    assert!(refused(s.extract(&archive(&[m]), Options::default())));
    // A base-256 size is refused.
    assert!(tar::octal(&[0x80, 0, 0, 1], "size").is_err());
    assert!(tar::octal(b"0000000012\0", "size").is_ok());
    assert!(tar::octal(b"00009", "size").is_err());
}

#[test]
fn truncated_blocks_and_bad_checksums() {
    let a = archive(&[file("f", &[7; 700])]);
    for cut in [100, 511, 513, 1023, 1100] {
        let s = Sandbox::new("trunc");
        let r = s.extract(&a[..cut], Options::default());
        assert!(r.is_err(), "cut at {cut}");
    }
    let mut bad = a.clone();
    bad[0] ^= 1;
    let s = Sandbox::new("chksum");
    assert!(matches!(
        s.extract(&bad, Options::default()),
        Err(TarError::BadChecksum { .. })
    ));
}

/// An `.apk`: several tar archives, each with its own end-of-archive zeros, in one stream.
/// Without `ignore_zeros` only the first is read; with it, all members are.
#[test]
fn apk_style_multi_member_archive() {
    let mut apk = archive(&[file(".SIGN.RSA.key.pub", b"sig")]);
    apk.extend(archive(&[file(".PKGINFO", b"pkgname = u-boot-qemu\n")]));
    apk.extend(archive(&[
        dir("usr"),
        dir("usr/share"),
        dir("usr/share/u-boot"),
        dir("usr/share/u-boot/qemu_arm64"),
        file("usr/share/u-boot/qemu_arm64/u-boot.bin", b"\x00uboot"),
    ]));
    let s = Sandbox::new("apk1");
    let r = s.extract(&apk, Options::default()).unwrap();
    assert_eq!(r.files, 1);
    let s = Sandbox::new("apk");
    let opts = Options {
        ignore_zeros: true,
        ..Options::default()
    };
    let r = s.extract(&apk, opts).unwrap();
    assert_eq!(r.files, 3);
    assert_eq!(
        std::fs::read(s.stage.join("usr/share/u-boot/qemu_arm64/u-boot.bin")).unwrap(),
        b"\x00uboot"
    );
    s.check();
}

#[test]
fn pax_and_gnu_long_names() {
    let long = format!("{}/f", "d".repeat(150));
    let rec = format!(" path={long}\n");
    let rec = format!("{}{rec}", rec.len() + 3); // the length counts its own 3 digits
    assert_eq!(rec.len(), rec[..3].parse::<usize>().unwrap());
    let s = Sandbox::new("pax");
    let a = archive(&[
        // GNU `L`: the next member's long name (the directory), then a PAX `path` (the file).
        member("././@LongLink", b'L', 0o644, "d".repeat(150).as_bytes(), ""),
        dir("ignored-short-name"),
        member("pax", b'x', 0o644, rec.as_bytes(), ""),
        file("short", b"long-named"),
    ]);
    s.extract(&a, Options::default()).unwrap();
    assert_eq!(std::fs::read(s.stage.join(&long)).unwrap(), b"long-named");
    // A PAX `size` record is refused (parser differential).
    let s = Sandbox::new("paxsize");
    let a = archive(&[
        member("pax", b'x', 0o644, b"12 size=999\n", ""),
        file("f", b"x"),
    ]);
    assert!(refused(s.extract(&a, Options::default())));
    // A path escaping through PAX is refused like any other.
    let s = Sandbox::new("paxescape");
    let a = archive(&[
        member("pax", b'x', 0o644, b"22 path=../../canary\n", ""),
        file("f", b"x"),
    ]);
    assert!(refused(s.extract(&a, Options::default())));
    s.check();
    // A malformed record.
    assert!(tar::pax_records(b"99 path=x\n").is_err());
    assert!(tar::pax_records(b"x path=x\n").is_err());
}

#[test]
fn destination_must_be_fresh() {
    let s = Sandbox::new("dest");
    std::fs::write(s.stage.join("old"), b"x").unwrap();
    assert!(matches!(
        s.extract(&archive(&[file("f", b"x")]), Options::default()),
        Err(TarError::Dest(_))
    ));
    let link = s.root.join("stagelink");
    std::os::unix::fs::symlink(&s.stage, &link).unwrap();
    assert!(tar::extract(&archive(&[])[..], &link, Options::default()).is_err());
    std::fs::remove_file(&link).unwrap();
}

/// Old-style directories: typeflag NUL (or '0') with a trailing `/` are directories, and their
/// children extract under them.
#[test]
fn old_style_nul_typeflag_directories() {
    for t in [0u8, b'0'] {
        let s = Sandbox::new(&format!("olddir{t}"));
        let a = archive(&[member("d/", t, 0o755, &[], ""), file("d/x", b"child")]);
        let r = s.extract(&a, Options::default()).unwrap();
        assert_eq!((r.dirs, r.files), (1, 1), "typeflag {t}");
        assert!(
            std::fs::symlink_metadata(s.stage.join("d"))
                .unwrap()
                .file_type()
                .is_dir()
        );
        assert_eq!(std::fs::read(s.stage.join("d/x")).unwrap(), b"child");
        s.check();
    }
}

/// SC-6: the total cap counts every consumed byte, not only file data.
#[test]
fn total_cap_counts_every_consumed_byte() {
    let opts = Options {
        limits: Limits {
            max_member: 1 << 20,
            max_total: 1 << 20,
            ..Limits::default()
        },
        ..Options::default()
    };
    // Non-file members with declared data are refused outright (ustar: links carry none).
    for (t, name, link) in [(b'5', "d", ""), (b'2', "l", "x"), (b'1', "h", "f")] {
        let s = Sandbox::new(&format!("nonfile{name}"));
        let mut parts = vec![file("f", b"x")];
        parts.push(member(name, t, 0o755, &[0u8; 4096], link));
        assert!(
            matches!(
                s.extract(&archive(&parts), opts),
                Err(TarError::Refused { .. })
            ),
            "{name}"
        );
        s.check();
    }
    // With ignore_zeros, zero blocks past the cap are charged and stop the read.
    let s = Sandbox::new("zeros");
    let mut a = vec![0u8; 2 << 20];
    a.extend(file("f", b"x"));
    a.extend(end());
    let z = Options {
        ignore_zeros: true,
        ..opts
    };
    assert!(matches!(s.extract(&a, z), Err(TarError::TooLarge(_))));
    s.check();
    // PAX data counts too: many extended headers under the per-PAX cap but over the total.
    let s = Sandbox::new("paxtotal");
    let body = format!(" comment={}\n", "c".repeat(4000));
    let rec = format!("{}{body}", body.len() + 4); // the length counts its own 4 digits
    assert_eq!(rec.len(), rec[..4].parse::<usize>().unwrap());
    let mut parts = Vec::new();
    for _ in 0..300 {
        parts.push(member("pax", b'g', 0o644, rec.as_bytes(), ""));
    }
    parts.push(file("f", b"x"));
    assert!(matches!(
        s.extract(&archive(&parts), opts),
        Err(TarError::TooLarge(_))
    ));
    s.check();
    // An ordinary archive under the cap still extracts.
    let s = Sandbox::new("undercap");
    s.extract(&archive(&[dir("d"), file("d/f", &[1; 1000])]), opts)
        .unwrap();
}
