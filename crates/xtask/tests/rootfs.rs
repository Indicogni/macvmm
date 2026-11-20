//! `xtask::rootfs` (PLAN M15 security tests; threat model SC-5, SC-7, SC-9).
//!
//! Every staging case runs in a fresh temp dir with a **canary file next to the staging root**
//! (`work/canary` beside `work/root`), whose content and mtime are checked afterwards: no
//! archive, and not our own `/sbin/macvmm-init` insertion, may write outside the staging dir.
//! Archives are built here byte by byte (ustar), so no fixtures are committed.

use std::path::{Path, PathBuf};
use std::time::SystemTime;
use xtask::rootfs;

/// One ustar header block + data (the same builder as tests/tar.rs).
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

fn file(name: &str, mode: u32, data: &[u8]) -> Vec<u8> {
    member(name, b'0', mode, data, "")
}
fn dir(name: &str, mode: u32) -> Vec<u8> {
    member(name, b'5', mode, &[], "")
}
fn symlink(name: &str, target: &str) -> Vec<u8> {
    member(name, b'2', 0o777, &[], target)
}
fn archive(parts: &[Vec<u8>]) -> Vec<u8> {
    let mut v: Vec<u8> = parts.concat();
    v.extend(vec![0u8; 1024]);
    v
}

const INIT: &[u8] = b"#!/bin/sh\necho test init\n";

/// `work/` holding `canary` and the empty staging root `root/` (mode 0700, as `mkrootfs`
/// makes it).
struct Work {
    work: PathBuf,
    root: PathBuf,
    mtime: SystemTime,
}

impl Work {
    fn new(test: &str) -> Work {
        let work = std::env::temp_dir().join(format!("xtask-rootfs-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("canary"), b"canary").unwrap();
        let mtime = std::fs::metadata(work.join("canary"))
            .unwrap()
            .modified()
            .unwrap();
        let root = work.join("root");
        std::fs::create_dir(&root).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        Work { work, root, mtime }
    }
    fn stage(&self, tar: &[u8]) -> Result<rootfs::Staged, String> {
        rootfs::stage(tar, &self.root, INIT)
    }
    /// The canary is untouched and nothing new appeared next to the staging root.
    fn check(&self) {
        assert_eq!(std::fs::read(self.work.join("canary")).unwrap(), b"canary");
        assert_eq!(
            std::fs::metadata(self.work.join("canary"))
                .unwrap()
                .modified()
                .unwrap(),
            self.mtime
        );
        let mut names: Vec<_> = std::fs::read_dir(&self.work)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["canary", "root"]);
    }
    fn modes(&self) -> String {
        std::fs::read_to_string(self.root.join(rootfs::MODES_FILE)).unwrap()
    }
}

impl Drop for Work {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

/// The PLAN M15 security test `mkrootfs_staging_only` (SC-7, SC-9): a tarball holding
/// `a -> ..` and then `a/canary` must not touch the canary next to the staging dir; the build
/// fails. Without the second member, the link is kept verbatim as data for the guest.
#[test]
fn mkrootfs_staging_only() {
    let w = Work::new("staging-only");
    let evil = archive(&[
        dir("sbin/", 0o755),
        symlink("a", ".."),
        file("a/canary", 0o644, b"pwned"),
    ]);
    let err = w.stage(&evil).unwrap_err();
    assert!(err.contains("a/canary"), "{err}");
    w.check();

    let w = Work::new("link-as-data");
    let ok = archive(&[dir("sbin/", 0o755), symlink("a", "..")]);
    let staged = w.stage(&ok).unwrap();
    assert_eq!(staged.report.symlinks, 1);
    assert_eq!(
        std::fs::read_link(w.root.join("a")).unwrap(),
        Path::new("..")
    );
    w.check();
}

/// Our own insertion never writes through a link: an archive whose `sbin` is a symlink
/// (relative or absolute) fails, and nothing appears outside the staging root.
#[test]
fn init_never_written_through_a_symlinked_sbin() {
    for target in ["..", "/tmp", "."] {
        let w = Work::new(&format!("sbin-link-{}", target.len()));
        let tar = archive(&[symlink("sbin", target)]);
        let err = w.stage(&tar).unwrap_err();
        assert!(err.contains("sbin"), "{target}: {err}");
        w.check();
    }
    // An archive that already has /sbin/macvmm-init is refused rather than overwritten.
    let w = Work::new("init-exists");
    let tar = archive(&[dir("sbin/", 0o755), file("sbin/macvmm-init", 0o755, b"x")]);
    assert!(w.stage(&tar).is_err());
    w.check();
}

/// SC-4/SC-7 on the host, intended modes for the guest: setuid and execute bits are off in
/// the staging tree, the manifest carries the real modes (sticky kept, setid stripped), and
/// `/sbin/macvmm-init` is listed 0755.
#[test]
fn modes_live_in_the_manifest_not_on_the_host() {
    use std::os::unix::fs::PermissionsExt;
    let w = Work::new("modes");
    let tar = archive(&[
        dir("./", 0o755),
        dir("bin/", 0o755),
        file("bin/busybox", 0o4755, b"\x7fELF"),
        dir("sbin/", 0o755),
        dir("tmp/", 0o1777),
        file("etc-shadow", 0o640, b"root:*"),
    ]);
    let staged = w.stage(&tar).unwrap();
    assert_eq!(staged.report.setid_stripped, ["bin/busybox"]);
    let host = std::fs::metadata(w.root.join("bin/busybox"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(host & 0o7111, 0, "exec or setid bit on the host: {host:o}");
    let init = std::fs::metadata(w.root.join("sbin/macvmm-init"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(init & 0o111, 0, "macvmm-init executable on the host");
    assert_eq!(
        std::fs::read(w.root.join("sbin/macvmm-init")).unwrap(),
        INIT
    );
    let m = w.modes();
    for line in [
        "0755 .\n",
        "0755 bin\n",
        "0755 bin/busybox\n",
        "0640 etc-shadow\n",
        "0755 sbin\n",
        "0755 sbin/macvmm-init\n",
        "1777 tmp\n",
    ] {
        assert!(m.contains(line), "missing {line:?} in\n{m}");
    }
    assert_eq!(staged.modes, 7);
    w.check();
}

#[test]
fn manifest_refuses_names_a_shell_loop_could_misread() {
    let mut modes = std::collections::BTreeMap::new();
    modes.insert("etc/ok-name_1.2@x+y".to_owned(), 0o644);
    assert!(rootfs::modes_manifest(&modes).is_ok());
    for bad in ["a b", "a\nb", "a$b", "a`b", "a\\b", "a\"b"] {
        let mut m = modes.clone();
        m.insert(bad.to_owned(), 0o644);
        assert!(rootfs::modes_manifest(&m).is_err(), "{bad:?}");
    }
}

/// SC-5: only a real 64-hex pin authorises parsing.
#[test]
fn pinned_sha256_rules() {
    let h = "4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de";
    let m = format!(
        "# c\nrootfs x.tar.gz {h} https://e/x.tar.gz\nrootfs y TOFU https://e/y\nrootfs z {} https://e/z\n",
        h.to_uppercase()
    );
    assert_eq!(rootfs::pinned_sha256(&m, "x.tar.gz").unwrap(), h);
    assert!(rootfs::pinned_sha256(&m, "y").unwrap_err().contains("SC-5"));
    assert!(rootfs::pinned_sha256(&m, "z").is_err());
    assert!(rootfs::pinned_sha256(&m, "missing").is_err());
}

/// SC-5: a file whose hash does not match the pin is refused before any parsing; the right
/// hash returns the bytes.
#[test]
fn read_verified_checks_the_pin_first() {
    let w = Work::new("verify");
    let input = w.root.join("in.tar.gz");
    std::fs::write(&input, b"not really gzip").unwrap();
    let good = rootfs::sha256_file(&input).unwrap();
    assert_eq!(
        good,
        "63c043b641238f64f320aa5f28593585a2d8d400e2ac1b3fa93ca60a5d8c3d7a"
    );
    let manifest = w.root.join("m.txt");
    let bad = "0".repeat(64);
    std::fs::write(&manifest, format!("rootfs in.tar.gz {bad} https://e/x\n")).unwrap();
    let err = rootfs::read_verified(&input, &manifest, 1 << 20).unwrap_err();
    assert!(err.contains("sha256 mismatch"), "{err}");
    std::fs::write(&manifest, format!("rootfs in.tar.gz {good} https://e/x\n")).unwrap();
    assert_eq!(
        rootfs::read_verified(&input, &manifest, 1 << 20).unwrap(),
        b"not really gzip"
    );
    // Over the cap: refused (and never read).
    assert!(rootfs::read_verified(&input, &manifest, 4).is_err());
    // A symlink to a good file is refused (O_NOFOLLOW).
    let link = w.root.join("link").join("in.tar.gz");
    std::fs::create_dir(w.root.join("link")).unwrap();
    std::os::unix::fs::symlink(&input, &link).unwrap();
    assert!(rootfs::read_verified(&link, &manifest, 1 << 20).is_err());
}

#[test]
fn e2fsprogs_version_parse() {
    assert_eq!(
        rootfs::parse_e2fs_version("mke2fs 1.47.4 (6-Mar-2025)\n\tUsing EXT2FS Library"),
        Some((1, 47, 4))
    );
    assert_eq!(
        rootfs::parse_e2fs_version("mke2fs 1.46 (1-Jan-2020)"),
        Some((1, 46, 0))
    );
    assert_eq!(rootfs::parse_e2fs_version("mkfs 1.2"), None);
    assert!(rootfs::parse_e2fs_version("mke2fs 1.46.5 (x)").unwrap() < rootfs::E2FS_MIN);
}

#[test]
fn run_refuses_bad_sizes_before_doing_anything() {
    let w = Work::new("sizes");
    for size in [0, 16 << 20, (256 << 20) + 512, 16 << 30] {
        let a = rootfs::Args {
            out: w.root.join("r.img"),
            size,
            minirootfs: w.root.join("absent.tar.gz"),
            init: w.root.join("absent-init"),
            manifest: w.root.join("absent-manifest"),
        };
        let e = rootfs::run(&a).unwrap_err();
        assert!(e.message.contains("--size"), "{size}: {e}");
        assert!(!e.tool_missing);
    }
    assert!(!w.root.join("r.img").exists());
}
