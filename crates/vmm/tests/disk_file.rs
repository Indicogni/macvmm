//! PLAN M14 security tests (host): the disk backend as `HostIo` opens it (threat model BLK-5,
//! BLK-6, BLK-8, BLK-11, PATH-4, PATH-5).
//!
//! - `disk_ro_is_o_rdonly`: a `,ro` disk's fd refuses `pwrite` with `EBADF` even when the
//!   device logic is bypassed and the backend is called directly (BLK-5);
//! - the capacity is the `fstat` size of the open fd rounded down to whole sectors (BLK-6);
//! - locks: read-write is exclusive, read-only is shared, and a conflict is
//!   `disk image is locked` (BLK-8); the lock goes away with the fd;
//! - non-regular files are refused (BLK-11); the same inode twice is refused (PATH-5); an
//!   output onto a disk image is refused and the image is untouched (PATH-4).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use vmm::backend::file::{BlockBackend, SECTOR_SIZE};
use vmm::backend::hostio::{InputError, open_disk};
use vmm::config::{DiskSpec, SinkKind, VmConfig};
use vmm::{Error, HostIo};

/// `EBADF` in `<sys/errno.h>` (macOS and Linux agree).
const EBADF: i32 = 9;

fn scratch(test: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("macvmm-disk-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn image(dir: &Path, name: &str, len: usize) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, (0..len).map(|i| (i % 253) as u8).collect::<Vec<u8>>()).unwrap();
    p
}

#[test]
fn disk_ro_is_o_rdonly() {
    let dir = scratch("ro");
    let p = image(&dir, "ro.img", 4096);
    let before = std::fs::read(&p).unwrap();
    let (disk, _) = open_disk(&p, true, &[]).unwrap();
    assert!(disk.read_only());
    // The device would refuse an OUT first; here the backend is called directly.
    let e = disk.write_at(&[0xff; 512], 0).unwrap_err();
    assert_eq!(e.raw_os_error(), Some(EBADF), "{e}");
    let mut b = [0u8; 512];
    assert_eq!(disk.read_at(&mut b, 512).unwrap(), 512);
    assert_eq!(&b[..], &before[512..1024]);
    drop(disk);
    assert_eq!(std::fs::read(&p).unwrap(), before);
    // A read-write disk does write.
    let (rw, _) = open_disk(&p, false, &[]).unwrap();
    assert_eq!(rw.write_at(&[0xff; 512], 0).unwrap(), 512);
    rw.sync().unwrap();
    assert_eq!(&std::fs::read(&p).unwrap()[..512], &[0xff; 512][..]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn capacity_is_the_fd_size_rounded_down() {
    let dir = scratch("cap");
    let p = image(&dir, "odd.img", 1024 * 1024 + 100);
    let (disk, _) = open_disk(&p, true, &[]).unwrap();
    assert_eq!(disk.capacity_sectors(), 2048);
    assert!(disk.has_partial_sector());
    assert_eq!(disk.size_bytes(), 1024 * 1024 + 100);
    // Growing the file later does not change the capacity (computed once, BLK-6).
    std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .unwrap()
        .set_len(4 * 1024 * 1024)
        .unwrap();
    assert_eq!(disk.capacity_sectors(), 2048);
    let even = image(&dir, "even.img", 8 * SECTOR_SIZE as usize);
    let (disk, _) = open_disk(&even, false, &[]).unwrap();
    assert_eq!(disk.capacity_sectors(), 8);
    assert!(!disk.has_partial_sector());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Calls `open` until it stops failing with `DiskLocked` (at most ~2 s), then unwraps it.
fn retry_unlocked<T>(mut open: impl FnMut() -> Result<T, InputError>) -> T {
    for _ in 0..200 {
        match open() {
            Err(InputError::DiskLocked { .. }) => {
                std::thread::sleep(std::time::Duration::from_millis(10))
            }
            r => return r.unwrap_or_else(|e| panic!("unexpected {e}")),
        }
    }
    panic!("disk image still locked after 2 s");
}

#[test]
fn locks_are_exclusive_for_rw_and_shared_for_ro() {
    let dir = scratch("lock");
    let p = image(&dir, "l.img", 4096);
    let locked = |r: Result<_, InputError>| match r {
        Err(e @ InputError::DiskLocked { .. }) => {
            assert!(e.to_string().starts_with("disk image is locked"), "{e}");
            true
        }
        Err(e) => panic!("unexpected {e}"),
        Ok(_) => false,
    };
    let (rw, _) = open_disk(&p, false, &[]).unwrap();
    assert!(locked(open_disk(&p, false, &[])), "rw + rw");
    assert!(locked(open_disk(&p, true, &[])), "rw + ro");
    drop(rw); // closing the fd releases the lock
    // ...eventually: another test in this binary may be spawning a child process right now, and
    // between fork and exec that child holds a duplicate of every open file description, ours
    // included, so the flock lingers for a moment. Retry briefly instead of flaking.
    let (ro1, _) = retry_unlocked(|| open_disk(&p, true, &[]));
    let (ro2, _) = open_disk(&p, true, &[]).unwrap(); // ro + ro: shared
    assert!(locked(open_disk(&p, false, &[])), "ro + rw");
    drop((ro1, ro2));
    retry_unlocked(|| open_disk(&p, false, &[]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn non_regular_files_are_refused() {
    for (path, ro) in [
        ("/dev/null", true),
        ("/dev/zero", true),
        ("/dev/null", false),
    ] {
        let e = open_disk(Path::new(path), ro, &[]).map(|_| ()).unwrap_err();
        assert!(matches!(e, InputError::NotRegular { .. }), "{path}: {e}");
        assert!(e.to_string().starts_with("not a regular file: "));
    }
    let dir = scratch("nonreg");
    // A directory (read-only open succeeds, then fstat says it is not a file).
    assert!(matches!(
        open_disk(&dir, true, &[]).map(|_| ()),
        Err(InputError::NotRegular { .. })
    ));
    assert!(open_disk(&dir, false, &[]).is_err());
    // A FIFO must not block the open.
    let fifo = dir.join("fifo");
    assert!(
        std::process::Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let t0 = std::time::Instant::now();
    assert!(matches!(
        open_disk(&fifo, true, &[]).map(|_| ()),
        Err(InputError::NotRegular { .. })
    ));
    assert!(t0.elapsed() < std::time::Duration::from_secs(2));
    assert!(matches!(
        open_disk(&dir.join("missing.img"), true, &[]).map(|_| ()),
        Err(InputError::Open { .. })
    ));
    let _ = std::fs::remove_dir_all(&dir);
}

fn cfg_with(dir: &Path, disks: Vec<DiskSpec>) -> VmConfig {
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let mut c = VmConfig::default();
    c.boot.kernel = Some(kernel);
    c.mem_bytes = 64 << 20;
    c.serial.kind = SinkKind::None;
    c.disks = disks;
    c
}

fn input_err(r: vmm::Result<HostIo>) -> InputError {
    match r {
        Err(Error::Input(e)) => e,
        Err(e) => panic!("not an input error: {e}"),
        Ok(_) => panic!("accepted"),
    }
}

#[test]
fn hostio_dedups_disks_by_inode_and_never_writes_an_output_onto_one() {
    let dir = scratch("hostio");
    let p = image(&dir, "d.img", 4096);
    let before = std::fs::read(&p).unwrap();
    let spec = |path: &Path, read_only| DiskSpec {
        path: path.to_path_buf(),
        read_only,
    };
    // The same image twice, also via a hard link and as ro + ro: PATH-5.
    let link = dir.join("alias.img");
    std::fs::hard_link(&p, &link).unwrap();
    for (a, b) in [
        (spec(&p, false), spec(&p, false)),
        (spec(&p, true), spec(&p, true)),
        (spec(&p, false), spec(&link, true)),
    ] {
        let e = input_err(HostIo::open(&cfg_with(&dir, vec![a, b])));
        assert!(matches!(e, InputError::DiskTwice { .. }), "{e}");
        assert!(e.to_string().contains("is the same disk image as"), "{e}");
    }
    // PATH-4: `--serial file:d.img` with `--disk d.img` is refused and the image is intact.
    let mut c = cfg_with(&dir, vec![spec(&p, false)]);
    c.serial.kind = SinkKind::File;
    c.serial.path = Some(p.clone());
    let e = input_err(HostIo::open(&c));
    assert!(matches!(e, InputError::OutputClash { .. }), "{e}");
    assert_eq!(std::fs::read(&p).unwrap(), before);
    // Two different images are fine, in order, and each is locked while HostIo lives.
    let q = image(&dir, "e.img", 8192);
    let host = HostIo::open(&cfg_with(&dir, vec![spec(&p, false), spec(&q, true)])).unwrap();
    assert_eq!(host.disks.len(), 2);
    assert_eq!(host.disks[0].capacity_sectors(), 8);
    assert_eq!(host.disks[1].capacity_sectors(), 16);
    assert!(host.disks[1].read_only());
    assert!(matches!(
        open_disk(&p, true, &[]).map(|_| ()),
        Err(InputError::DiskLocked { .. })
    ));
    drop(host);
    assert!(open_disk(&p, false, &[]).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
