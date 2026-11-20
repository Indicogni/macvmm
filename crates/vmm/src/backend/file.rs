//! The block backend: a raw disk image in a host file (architecture §11.3 "Backends", §14.3;
//! threat model BLK-5..BLK-11; course ch18).
//!
//! **What a virtio-blk device needs from the host** is tiny: "read these bytes at this
//! offset", "write these bytes at this offset", "make everything written so far durable", and
//! the size. [`BlockBackend`] is exactly that, so the device model (`virtio/blk.rs`) can be
//! tested against an in-memory mock (short reads, `EIO`, a flush counter) and the real
//! [`DiskFile`] stays a few lines of std calls.
//!
//! **Why positional I/O.** `FileExt::read_at`/`write_at` are `pread(2)`/`pwrite(2)`: the offset
//! is an argument, there is no shared file cursor to seek, so nothing can interleave a seek
//! with a read. The device processes one request at a time on its worker thread (§14.3), but
//! the backend is still `Sync` without a lock.
//!
//! **Who opens the file.** Not this module: `backend::hostio` is the only place in the VMM that
//! opens a path (HOSTIO-1, `cargo xtask audit` rule `hostio-only`). `HostIo` opens the image
//! with `O_RDONLY` for a `,ro` disk (BLK-5: the kernel then refuses every write, even if the
//! device logic were bypassed) or `O_RDWR`, and hands the fd to [`DiskFile::new`], which works
//! only on that fd:
//! 1. `fstat` on the fd (never the path, so there is no check-then-use race): it must be a
//!    regular file (BLK-11, PATH-2). A block device such as `/dev/disk0` is a whole host disk;
//! 2. the capacity is computed **once**, here, from that `fstat` (BLK-6): `size / 512`, rounded
//!    down. A trailing partial sector is never addressable. If another process later truncates
//!    the file anyway, reads past the new end come back short and the device answers IOERR;
//! 3. the image is locked (BLK-8): `File::try_lock` (exclusive) for read-write and
//!    `File::try_lock_shared` for read-only, so two VMs never write one image and a writer
//!    never runs beside readers. On macOS std implements both with `flock(2)`
//!    `[V-src: std 1.99.0 library/std/src/sys/fs/unix.rs]`: **advisory** (a non-macvmm process
//!    that does not call `flock` is not stopped), held **per open file description** (so the
//!    same image given twice to one VM conflicts with itself and fails cleanly, exit code 2;
//!    `HostIo` also de-duplicates by inode first, PATH-5) and not reliable on SMB or NFS
//!    mounts (residual risk RR6). The lock is released when the fd closes, so a crashed
//!    macvmm never leaves an image locked.
//!
//! **Durability (BLK-9, risk R11 resolved).** [`BlockBackend::sync`] is `File::sync_all`. On
//! Apple targets std implements `sync_all` (and `sync_data`) with `fcntl(fd, F_FULLFSYNC)`
//! `[V-src: rustup toolchain 1.99.0, library/std/src/sys/fs/unix.rs, os_fsync]`, not plain
//! `fsync(2)`, which on macOS only reaches the drive's volatile cache. The toolchain is still
//! pinned at 1.99.0 in `rust-toolchain.toml` (re-checked for M14), so this holds. The device
//! reports a FLUSH as done only after `sync_all` returned `Ok`.
//!
//! **Raw images only (BLK-10).** There is no format probing, ever: the bytes of the file are
//! the bytes of the disk. A future image format must never follow a backing-file path read
//! from the image itself (QEMU CVE-2008-2004).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::fs::{File, TryLockError};
use std::io;
use std::os::unix::fs::FileExt;

/// A virtio-blk sector: the unit of `sector` and of `capacity` (virtio 1.2 §5.2.4,
/// §5.2.6: "the sector number indicates the offset (multiplied by 512)").
pub const SECTOR_SIZE: u64 = 512;

/// What the virtio-blk device needs from a disk (module docs). Every method takes `&self`:
/// the I/O is positional, so no lock is needed around it.
pub trait BlockBackend: Send + Sync {
    /// The disk size in 512-byte sectors, fixed when the disk was opened (BLK-6).
    fn capacity_sectors(&self) -> u64;
    /// Opened read-only (`,ro`): the device offers `VIRTIO_BLK_F_RO` and fails every OUT.
    fn read_only(&self) -> bool;
    /// `pread(2)`: up to `buf.len()` bytes at `offset`. May return fewer (end of file, a
    /// signal); 0 means end of file.
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize>;
    /// `pwrite(2)`: up to `buf.len()` bytes at `offset`. May write fewer.
    fn write_at(&self, buf: &[u8], offset: u64) -> io::Result<usize>;
    /// Make every completed write durable (BLK-9: `F_FULLFSYNC` on macOS).
    fn sync(&self) -> io::Result<()>;
}

/// Why an opened image cannot be used as a disk. `HostIo` turns each into a usage error
/// (exit code 2) naming the path.
#[derive(Debug)]
pub enum DiskError {
    /// `fstat` on the fd failed.
    Stat(io::Error),
    /// The fd is not a regular file (BLK-11, PATH-2).
    NotRegular,
    /// Another open file description holds a conflicting lock (BLK-8).
    Locked,
    /// `flock` failed for another reason.
    Lock(io::Error),
}

// ANCHOR: file_backend_open
/// A raw disk image: an fd `HostIo` opened, checked and locked (module docs).
#[derive(Debug)]
pub struct DiskFile {
    file: File,
    read_only: bool,
    size_bytes: u64,
    capacity_sectors: u64,
}

impl DiskFile {
    /// Wrap the fd `file`, opened `O_RDONLY` if `read_only` and `O_RDWR` otherwise: `fstat`
    /// it (a regular file, BLK-11), fix the capacity (BLK-6) and lock it (BLK-8).
    pub fn new(file: File, read_only: bool) -> Result<DiskFile, DiskError> {
        let meta = file.metadata().map_err(DiskError::Stat)?; // fstat(2) on the fd
        if !meta.file_type().is_file() {
            return Err(DiskError::NotRegular);
        }
        let locked = if read_only {
            file.try_lock_shared()
        } else {
            file.try_lock()
        };
        match locked {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(DiskError::Locked),
            Err(TryLockError::Error(e)) => return Err(DiskError::Lock(e)),
        }
        let size_bytes = meta.len();
        Ok(DiskFile {
            file,
            read_only,
            size_bytes,
            capacity_sectors: size_bytes / SECTOR_SIZE,
        })
    }

    /// The file size at open, in bytes.
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    /// True if the file size is not a whole number of sectors (its tail is unreachable).
    pub fn has_partial_sector(&self) -> bool {
        !self.size_bytes.is_multiple_of(SECTOR_SIZE)
    }
}
// ANCHOR_END: file_backend_open

// ANCHOR: file_backend_read_at
impl BlockBackend for DiskFile {
    fn capacity_sectors(&self) -> u64 {
        self.capacity_sectors
    }
    fn read_only(&self) -> bool {
        self.read_only
    }
    /// `pread(2)` on the image's fd. No cursor, no seek (module docs).
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        self.file.read_at(buf, offset)
    }
    /// `pwrite(2)`. On a `,ro` disk the fd is `O_RDONLY`, so the kernel answers `EBADF`
    /// whatever the caller checked (BLK-5; host test `disk_ro_is_o_rdonly`).
    fn write_at(&self, buf: &[u8], offset: u64) -> io::Result<usize> {
        self.file.write_at(buf, offset)
    }
    /// `File::sync_all` = `fcntl(F_FULLFSYNC)` on Apple targets (BLK-9).
    fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }
}
// ANCHOR_END: file_backend_read_at

/// Read `buf.len()` bytes at `offset`, retrying short reads and `EINTR`. Returns how many
/// bytes arrived and, if fewer than asked, why: `Ok` with a short count means end of file
/// (the image shrank, BLK-6); `Err` is the I/O error. Bytes past the count are left as they
/// were (the caller's buffer is freshly zeroed, VQ-11).
pub fn read_full(
    backend: &dyn BlockBackend,
    buf: &mut [u8],
    offset: u64,
) -> (usize, io::Result<()>) {
    let mut got: usize = 0;
    while let Some(rest) = buf.get_mut(got..) {
        if rest.is_empty() {
            break;
        }
        let Some(at) = u64::try_from(got).ok().and_then(|g| offset.checked_add(g)) else {
            return (got, Err(io::Error::from(io::ErrorKind::InvalidInput)));
        };
        match backend.read_at(rest, at) {
            Ok(0) => return (got, Ok(())), // end of file: a short read
            Ok(n) => got = got.saturating_add(n.min(rest.len())),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return (got, Err(e)),
        }
    }
    (got, Ok(()))
}

/// Write all of `buf` at `offset`, retrying short writes and `EINTR`. A write that makes no
/// progress is an error (`WriteZero`).
pub fn write_full(backend: &dyn BlockBackend, buf: &[u8], offset: u64) -> io::Result<()> {
    let mut done: usize = 0;
    while let Some(rest) = buf.get(done..) {
        if rest.is_empty() {
            break;
        }
        let at = u64::try_from(done)
            .ok()
            .and_then(|d| offset.checked_add(d))
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        match backend.write_at(rest, at) {
            Ok(0) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(n) => done = done.saturating_add(n.min(rest.len())),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
