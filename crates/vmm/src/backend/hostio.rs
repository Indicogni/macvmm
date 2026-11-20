//! `HostIo`: every host file the VMM touches, opened and read **once**, before the first vCPU
//! runs (threat model HOSTIO-1, PATH-1, PATH-2, LDR-1; architecture §21.2–§21.3).
//!
//! **Why read the host once.** The machine is built from the *bytes* in `HostIo`, never from
//! paths. That closes three holes at once:
//! - the kernel-swap TOCTOU: replacing `Image` on disk between two in-process reboots (M5) has
//!   no effect, because the reboot reuses these bytes (flaw F3);
//! - the M22 lockdown: after `HostIo::open` the process opens no path, so a `(deny default)`
//!   sandbox can be applied without breaking reboot;
//! - review surface: this file is the only place in `crates/vmm` allowed to open a file
//!   (`cargo xtask audit`, rule `hostio-only`). Loaders take `&[u8]` and never open anything.
//!
//! **How an input is read** ([`read_input`], PATH-1/2, LDR-1):
//! 1. open it read-only. Rust's `File::open` always passes `O_CLOEXEC` (PROC-3: nothing leaks
//!    into a child). We add `O_NONBLOCK`, because opening a FIFO for reading otherwise blocks
//!    until a writer appears, before we ever get to look at what it is. Symlinks the user gave
//!    are followed: that is user intent;
//! 2. `fstat` the **fd** (not the path, so there is no check-then-open race) and require
//!    `S_ISREG`. A FIFO would block or stream forever, `/dev/zero` is an unbounded read (OOM),
//!    `/dev/tty` steals the terminal, a block device is a raw host disk, and a directory is not
//!    an image: all are refused with `not a regular file: <path>` (exit 2);
//! 3. compare the size with the input's cap **before** reading (kernel, ELF and `--raw` ≤ the
//!    RAM size), so a huge file is refused without allocating for it;
//! 4. read through `take(cap + 1)`: if the file grew between `fstat` and the read, the extra
//!    byte shows it and the input is refused instead of being silently truncated.
//!
//! **How an output is opened** ([`open_output`], PATH-3..6; M4 for `--trace`, M6 reuses it
//! for file sinks and `--dtb-out`):
//! 1. resolve the *parent directory* (`canonicalize`): symlinks the user put in the directory
//!    part, such as macOS's own `/tmp -> private/tmp`, are user intent;
//! 2. open `<resolved parent>/<name>` with `O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW_ANY`,
//!    mode `0600`, **without** `O_TRUNC`. (`O_NOFOLLOW_ANY` covers the last component too;
//!    adding `O_NOFOLLOW` makes macOS return `EINVAL`, verified on macOS 27.2.) A symlink as the last component (the
//!    planted `/tmp/trace.jsonl -> ~/.ssh/authorized_keys` of attacker A4), or any component
//!    swapped for a link after step 1, fails with `ELOOP`: `refusing symlinked output` (exit 2);
//! 3. `fstat` the fd: it must be a regular file owned by our uid;
//! 4. it must not be the same inode (`st_dev`, `st_ino`) as any input or other output
//!    (PATH-4: `--trace exits:Image` would otherwise destroy the kernel);
//! 5. it must have exactly one link (`st_nlink == 1`). `O_NOFOLLOW_ANY` stops a planted
//!    *symlink*, but a planted *hard link* is the same inode under a second name, and macOS
//!    lets any user hard-link a file they do not own (on the same volume, so `/tmp` and
//!    `/Users` qualify): `ln ~victim/.zshrc /tmp/trace.jsonl`. The owner check passes (the
//!    victim owns the inode), so without this step `--trace exits:/tmp/trace.jsonl` would
//!    truncate the victim's `.zshrc`. A file this call just created always has one link;
//!    `refusing output ...: it has N hard links` (exit 2);
//! 6. only now truncate it, and `fchmod` it to 0600 in case it already existed with a wider
//!    mode (PATH-6; files we create are 0600 from the mode and the startup `umask(0o077)`).
//!
//! Later milestones add kinds here: initrd (M9, done: same rules and cap as the kernel), firmware (M18, ≤ 64 MiB), disks (M14:
//! opened, locked, `fstat`ed fds). M6 opens `--serial file:F` through [`open_output`] and adds
//! the console input queue and the user-request attach point (`serial_input`, `hostctl`). M13
//! opens `--console file:F` the same way (after the serial sink, so PATH-4 refuses the two
//! naming one file), gives the virtio-console its own input queue (`console_input`), and
//! decides once which queue stdin feeds (`stdin`, [`HostIo::stdin_queue`]; architecture §14.4).

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::backend::entropy::Entropy;
use crate::backend::serial::{SerialInput, Sink, SinkHandle, StdinBinding};
use crate::config::{SinkKind, TraceSpec, VmConfig};
use crate::error::{Error, Result};
use crate::hostctl::HostCtl;
use crate::trace::{Trace, TraceWriter};
use core::fmt;
use std::fs::File;
use std::io::{self, BufWriter, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The trace file's write buffer: records are copied here and written per 64 KiB.
const TRACE_BUFFER: usize = 64 * 1024;

/// Why a host input was refused. Every variant is a usage error (exit code 2).
#[derive(Debug)]
pub enum InputError {
    /// The file could not be opened (missing, permissions, ...).
    Open { path: PathBuf, err: io::Error },
    /// The opened inode is not a regular file (PATH-2).
    NotRegular { path: PathBuf },
    /// `fstat` said the file is larger than its cap (LDR-1).
    TooLarge {
        path: PathBuf,
        size: u64,
        cap: u64,
        what: &'static str,
    },
    /// The file grew past its cap while it was being read (LDR-1, `take(cap + 1)`).
    Grew { path: PathBuf, cap: u64 },
    /// Reading failed half-way.
    Read { path: PathBuf, err: io::Error },
    /// The file is empty: nothing to load.
    Empty { path: PathBuf },
    /// An output path (or a component of it) is a symbolic link (PATH-3).
    OutputSymlink { path: PathBuf },
    /// An output exists and is not a regular file (PATH-3).
    OutputNotRegular { path: PathBuf },
    /// An output exists and belongs to another user (PATH-3).
    OutputNotOwned { path: PathBuf },
    /// An output is the same file as an input or another output (PATH-4).
    OutputClash { path: PathBuf, other: PathBuf },
    /// An output has more than one hard link: it may be a planted alias of another file
    /// (PATH-3).
    OutputHardLink { path: PathBuf, nlink: u64 },
    /// An output could not be created or prepared.
    OutputOpen { path: PathBuf, err: io::Error },
    /// Writing an output failed (M7: `--dtb-out`).
    OutputWrite { path: PathBuf, err: io::Error },
    /// M21: every vmapple SLA slot is held by another macvmm (ADR-0008 decision 6).
    SlotsBusy { dir: PathBuf, slots: u32 },
    /// M21: the lock directory is not a private directory of ours (PATH-7).
    SlotDir { dir: PathBuf, why: &'static str },
    /// M21: locking a slot file failed for a reason other than "held elsewhere".
    SlotLock { path: PathBuf, err: io::Error },
    /// M14: another open file description (another macvmm) holds a conflicting lock on a disk
    /// image (BLK-8).
    DiskLocked { path: PathBuf },
    /// M14: `flock` on a disk image failed for another reason.
    DiskLock { path: PathBuf, err: io::Error },
    /// M14: the same disk image (same inode) was given twice (PATH-5).
    DiskTwice { path: PathBuf, other: PathBuf },
    /// M24: a `--net` socket's directory is not ours, or is group- or world-writable (NET-3).
    NetDir { dir: PathBuf },
    /// M24: something other than a socket (a file, a symlink, ...) is at LOCAL (NET-4).
    NetNotSocket { path: PathBuf },
    /// M24: the socket at LOCAL belongs to another user (NET-4).
    NetNotOwned { path: PathBuf },
    /// M24: the socket at LOCAL is live: another process is bound to it (NET-4).
    NetLiveSocket { path: PathBuf },
    /// M24: inspecting, probing or removing a socket path failed.
    NetSetup { path: PathBuf, err: io::Error },
    /// M24: binding or configuring the socket failed (`net::unixgram::SetupError`).
    NetBind { path: PathBuf, why: String },
}

impl fmt::Display for InputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Paths are printed with `{:?}`: they come from the user, but quoting keeps control
        // characters in a file name off the terminal (TTY-8 spirit).
        match self {
            InputError::Open { path, err } => write!(f, "cannot open {path:?}: {err}"),
            InputError::NotRegular { path } => write!(f, "not a regular file: {path:?}"),
            InputError::TooLarge {
                path,
                size,
                cap,
                what,
            } => write!(
                f,
                "{path:?} is {size} bytes, which exceeds the size cap of {cap} bytes ({what})"
            ),
            InputError::Grew { path, cap } => write!(
                f,
                "{path:?} grew past the size cap of {cap} bytes while it was being read"
            ),
            InputError::Read { path, err } => write!(f, "cannot read {path:?}: {err}"),
            InputError::Empty { path } => write!(f, "{path:?} is empty"),
            InputError::OutputSymlink { path } => {
                write!(f, "refusing symlinked output: {path:?}")
            }
            InputError::OutputNotRegular { path } => {
                write!(f, "refusing output {path:?}: not a regular file")
            }
            InputError::OutputNotOwned { path } => {
                write!(f, "refusing output {path:?}: owned by another user")
            }
            InputError::OutputClash { path, other } => write!(
                f,
                "refusing output {path:?}: it is the same file as {other:?}"
            ),
            InputError::OutputHardLink { path, nlink } => write!(
                f,
                "refusing output {path:?}: it has {nlink} hard links (it may be another file under a second name)"
            ),
            InputError::OutputOpen { path, err } => write!(f, "cannot create {path:?}: {err}"),
            InputError::OutputWrite { path, err } => write!(f, "cannot write {path:?}: {err}"),
            InputError::SlotsBusy { dir, slots } => write!(
                f,
                "vmapple: all {slots} macOS-VM slots in {dir:?} are in use; the macOS licence \
                 allows at most two macOS VMs per Mac, and this guard counts this user's \
                 (advisory: HVF enforces no limit itself; ADR-0008 decision 6)"
            ),
            InputError::SlotDir { dir, why } => {
                write!(f, "vmapple: refusing lock directory {dir:?}: {why}")
            }
            InputError::SlotLock { path, err } => write!(f, "cannot lock {path:?}: {err}"),
            InputError::DiskLocked { path } => write!(
                f,
                "disk image is locked: {path:?} is in use by another process (macvmm takes \
                 an advisory flock on every --disk; BLK-8)"
            ),
            InputError::DiskLock { path, err } => write!(f, "cannot lock {path:?}: {err}"),
            InputError::DiskTwice { path, other } => write!(
                f,
                "--disk {path:?} is the same disk image as {other:?}: one image may back only \
                 one disk"
            ),
            InputError::NetDir { dir } => write!(
                f,
                "unsafe socket directory: {dir:?} (--net sockets must live in a directory you \
                 own that is not group- or world-writable, e.g. one made with mkdir -m 700; NET-3)"
            ),
            InputError::NetNotSocket { path } => write!(
                f,
                "refusing to replace non-socket path {path:?} (--net only replaces a stale \
                 socket of yours; NET-4)"
            ),
            InputError::NetNotOwned { path } => write!(
                f,
                "refusing to replace a socket owned by another user: {path:?} (NET-4)"
            ),
            InputError::NetLiveSocket { path } => write!(
                f,
                "refusing to replace a live socket: {path:?} is bound by another process (NET-4)"
            ),
            InputError::NetSetup { path, err } => {
                write!(f, "--net: cannot set up socket {path:?}: {err}")
            }
            InputError::NetBind { path, why } => write!(f, "--net: socket {path:?}: {why}"),
        }
    }
}

impl std::error::Error for InputError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            InputError::Open { err, .. }
            | InputError::Read { err, .. }
            | InputError::OutputOpen { err, .. }
            | InputError::OutputWrite { err, .. }
            | InputError::SlotLock { err, .. }
            | InputError::DiskLock { err, .. }
            | InputError::NetSetup { err, .. } => Some(err),
            _ => None,
        }
    }
}

// ANCHOR: hostio_open_input
/// Open `path` once, check it is a regular file of at most `cap` bytes, and read it all
/// (module docs, steps 1–4). `what` names the cap in the error ("the RAM size").
pub fn read_input(
    path: &Path,
    cap: u64,
    what: &'static str,
) -> core::result::Result<Arc<[u8]>, InputError> {
    read_input_id(path, cap, what).map(|(bytes, _)| bytes)
}

/// [`read_input`], also returning the file's identity for the PATH-4 clash check.
pub fn read_input_id(
    path: &Path,
    cap: u64,
    what: &'static str,
) -> core::result::Result<(Arc<[u8]>, FileId), InputError> {
    let p = || path.to_path_buf();
    let file = File::options()
        .read(true)
        .custom_flags(hvf::host::O_NONBLOCK) // a FIFO must not block the open (PATH-2)
        .open(path)
        .map_err(|err| InputError::Open { path: p(), err })?;
    let meta = file
        .metadata() // fstat(2) on the fd: no path race
        .map_err(|err| InputError::Read { path: p(), err })?;
    if !meta.file_type().is_file() {
        return Err(InputError::NotRegular { path: p() });
    }
    let id = FileId::of(&meta);
    let size = meta.len();
    if size > cap {
        return Err(InputError::TooLarge {
            path: p(),
            size,
            cap,
            what,
        });
    }
    if size == 0 {
        return Err(InputError::Empty { path: p() });
    }
    // `size ≤ cap ≤ RAM size`, and the RAM itself is allocated later, so this bounds the
    // host allocation by what the user asked the VM to have.
    let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
    file.take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|err| InputError::Read { path: p(), err })?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > cap {
        return Err(InputError::Grew { path: p(), cap });
    }
    Ok((bytes.into(), id))
}
// ANCHOR_END: hostio_open_input

// ANCHOR: hostio_open_disk
/// Open the disk image of `--disk path[,ro]` (M14; threat model BLK-5, BLK-6, BLK-8, BLK-11,
/// PATH-1, PATH-2, PATH-5) and return it with its identity:
/// 1. open it `O_RDONLY` for `,ro` (so the kernel refuses every write, whatever the device
///    logic does, BLK-5) or `O_RDWR`, with `O_CLOEXEC` (std) and `O_NONBLOCK` (a FIFO must not
///    block the open; it is refused at step 2 anyway);
/// 2. `backend::file::DiskFile::new` `fstat`s the **fd**: a regular file only (BLK-11, so
///    `/dev/disk0` is `not a regular file`), capacity fixed from that size (BLK-6);
/// 3. the same inode as an earlier disk in `seen` is refused (PATH-5), before any lock, so
///    the message names the duplicate rather than a lock conflict with ourselves;
/// 4. it locks the image (`flock`, exclusive or shared, BLK-8). A lock held elsewhere is
///    `disk image is locked` (exit code 2).
///
/// The bytes are never read here: a disk is not loaded into memory, and nothing in it is
/// parsed by the VMM (BLK-10, raw images only).
pub fn open_disk(
    path: &Path,
    read_only: bool,
    seen: &[(FileId, PathBuf)],
) -> core::result::Result<(Arc<crate::backend::file::DiskFile>, FileId), InputError> {
    use crate::backend::file::{DiskError, DiskFile, SECTOR_SIZE};
    let p = || path.to_path_buf();
    let file = File::options()
        .read(true)
        .write(!read_only)
        .custom_flags(hvf::host::O_NONBLOCK)
        .open(path)
        .map_err(|err| InputError::Open { path: p(), err })?;
    let meta = file
        .metadata() // fstat(2) on the fd
        .map_err(|err| InputError::Read { path: p(), err })?;
    let id = FileId::of(&meta);
    if let Some((_, other)) = seen.iter().find(|(d, _)| *d == id) {
        return Err(InputError::DiskTwice {
            path: p(),
            other: other.clone(),
        });
    }
    let disk = DiskFile::new(file, read_only).map_err(|e| match e {
        DiskError::Stat(err) => InputError::Read { path: p(), err },
        DiskError::NotRegular => InputError::NotRegular { path: p() },
        DiskError::Locked => InputError::DiskLocked { path: p() },
        DiskError::Lock(err) => InputError::DiskLock { path: p(), err },
    })?;
    if disk.has_partial_sector() {
        crate::warn!(
            "--disk {path:?}: {} bytes is not a multiple of 512; the last {} bytes are not part \
             of the disk",
            disk.size_bytes(),
            disk.size_bytes() % SECTOR_SIZE
        );
    }
    Ok((Arc::new(disk), id))
}
// ANCHOR_END: hostio_open_disk

/// A file's identity: `(st_dev, st_ino)` (PATH-4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

impl FileId {
    fn of(meta: &std::fs::Metadata) -> FileId {
        FileId {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
}

// ANCHOR: hostio_open_output
/// Open the output `path` under PATH-3..6 (module docs, steps 1–6). `taken` lists the inputs
/// and outputs already open; a clash with any of them is refused before anything is
/// truncated.
pub fn open_output(
    path: &Path,
    taken: &[(FileId, PathBuf)],
) -> core::result::Result<(File, FileId), InputError> {
    let p = || path.to_path_buf();
    let open_err = |err| InputError::OutputOpen { path: p(), err };
    let name = path
        .file_name()
        .ok_or_else(|| open_err(io::Error::from(io::ErrorKind::InvalidInput)))?;
    let parent = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d,
        _ => Path::new("."),
    };
    let full = std::fs::canonicalize(parent).map_err(open_err)?.join(name);
    let file = File::options()
        .write(true)
        .create(true)
        .mode(0o600)
        // O_NOFOLLOW_ANY alone: it also refuses a final-component link, and combined with
        // O_NOFOLLOW the open fails with EINVAL (verified on macOS 27.2, M4).
        .custom_flags(hvf::host::O_NOFOLLOW_ANY | hvf::host::O_NONBLOCK)
        .open(&full)
        .map_err(|err| match err.raw_os_error() {
            Some(e) if e == hvf::host::ELOOP => InputError::OutputSymlink { path: p() },
            _ => open_err(err),
        })?;
    let meta = file.metadata().map_err(open_err)?; // fstat(2) on the fd
    if !meta.file_type().is_file() {
        return Err(InputError::OutputNotRegular { path: p() });
    }
    if meta.uid() != hvf::host::getuid() {
        return Err(InputError::OutputNotOwned { path: p() });
    }
    let id = FileId::of(&meta);
    if let Some((_, other)) = taken.iter().find(|(t, _)| *t == id) {
        return Err(InputError::OutputClash {
            path: p(),
            other: other.clone(),
        });
    }
    // A hard link to someone else's file passes every check above (step 5).
    if meta.nlink() != 1 {
        return Err(InputError::OutputHardLink {
            path: p(),
            nlink: meta.nlink(),
        });
    }
    file.set_len(0).map_err(open_err)?; // ftruncate: only after every check
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(open_err)?; // fchmod
    Ok((file, id))
}
// ANCHOR_END: hostio_open_output

/// Open the `--trace` file and wrap it in a buffered, capped writer.
fn open_trace(
    spec: &TraceSpec,
    taken: &mut Vec<(FileId, PathBuf)>,
) -> core::result::Result<Arc<Trace>, InputError> {
    let (file, id) = open_output(&spec.path, taken)?;
    taken.push((id, spec.path.clone()));
    let out = BufWriter::with_capacity(TRACE_BUFFER, file);
    Ok(Arc::new(Trace::new(TraceWriter::new(
        Box::new(out),
        spec.cats,
        spec.max_bytes,
    ))))
}

/// How many macOS VMs one Mac may run under the macOS software licence (§2B(iii)), and so how
/// many vmapple slots exist (ADR-0008 decision 6).
pub const VMAPPLE_SLOTS: u32 = 2;

/// A held vmapple SLA slot: an open `<dir>/<slot>.lock` with an exclusive `flock(2)` on it.
/// The kernel drops the lock when the file is closed, so a crashed macvmm never keeps a slot.
#[derive(Debug)]
pub struct SlotLock {
    pub slot: u32,
    pub path: PathBuf,
    _file: File,
}

// ANCHOR: vmapple_slot_lock
/// Take the first free slot of `slots` in `dir`, or fail with [`InputError::SlotsBusy`] if
/// every slot is held by another process (two slots: the macOS licence permits two more copies).
///
/// The names are fixed (`0.lock`, `1.lock`); nothing in them comes from the guest or
/// the user except `dir` itself. `dir` is created `0700`, and an existing one must be a real
/// directory (not a symlink) owned by us with no group or other permission bits, so another
/// user can neither take our slots nor plant a link where a lock file goes. Each file is
/// opened like any output ([`open_output`]: `O_NOFOLLOW_ANY`, ours, one link, `0600`) and
/// locked with `File::try_lock` (an exclusive, non-blocking `flock(2)`).
pub fn take_slot(dir: &Path, slots: u32) -> core::result::Result<SlotLock, InputError> {
    let bad = |why| InputError::SlotDir {
        dir: dir.to_path_buf(),
        why,
    };
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|err| InputError::OutputOpen {
            path: dir.to_path_buf(),
            err,
        })?;
    let meta = std::fs::symlink_metadata(dir).map_err(|err| InputError::OutputOpen {
        path: dir.to_path_buf(),
        err,
    })?;
    if !meta.file_type().is_dir() {
        return Err(bad("not a directory (or a symbolic link)"));
    }
    if meta.uid() != hvf::host::getuid() {
        return Err(bad("owned by another user"));
    }
    if meta.mode() & 0o077 != 0 {
        return Err(bad("group or other users have access (it must be 0700)"));
    }
    // ANCHOR: vmapple_slot_loop
    for slot in 0..slots {
        let path = dir.join(format!("{slot}.lock"));
        let (file, _) = open_output(&path, &[])?;
        match file.try_lock() {
            Ok(()) => {
                return Ok(SlotLock {
                    slot,
                    path,
                    _file: file,
                });
            }
            Err(std::fs::TryLockError::WouldBlock) => continue,
            Err(std::fs::TryLockError::Error(err)) => {
                return Err(InputError::SlotLock { path, err });
            }
        }
    }
    Err(InputError::SlotsBusy {
        dir: dir.to_path_buf(),
        slots,
    })
    // ANCHOR_END: vmapple_slot_loop
}
// ANCHOR_END: vmapple_slot_lock

// ANCHOR: hostio_net_dir
/// The directory holding a `--net` socket path must be a real directory (checked with
/// `symlink_metadata`, so a symlinked directory is refused), owned by us and not group- or
/// world-writable. Otherwise another local user could create, replace or connect to the socket
/// file (see `docs/security/threat-model.md`). The socket file itself is `srwx------` (owner
/// only) because of the startup `umask(0o077)`.
fn check_socket_dir(path: &Path) -> core::result::Result<(), InputError> {
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let md = std::fs::symlink_metadata(dir).map_err(|err| InputError::NetSetup {
        path: dir.to_path_buf(),
        err,
    })?;
    if !md.file_type().is_dir() || md.uid() != hvf::host::getuid() || md.mode() & 0o022 != 0 {
        return Err(InputError::NetDir {
            dir: dir.to_path_buf(),
        });
    }
    Ok(())
}

// ANCHOR_END: hostio_net_dir

/// `p` made absolute against the working directory (so another process, with another working
/// directory, sees the same source address: a datagram's source is the sender's `bind` path).
fn absolute(p: &Path) -> core::result::Result<PathBuf, InputError> {
    if p.is_absolute() {
        return Ok(p.to_path_buf());
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(p))
        .map_err(|err| InputError::NetSetup {
            path: p.to_path_buf(),
            err,
        })
}

// ANCHOR: hostio_peer_spellings
/// The spellings a datagram from the peer may carry as its source: the absolute path,
/// and the same path with its directory resolved (`/tmp/x/b.sock` and `/private/tmp/x/b.sock`
/// are the same socket on macOS). Only *our* configuration is resolved, here, once; a received
/// source path is never resolved, so a sender cannot pass by binding a symlink.
///
/// A relative `peer=` as typed is **not** a spelling: a datagram's source is the sender's
/// `sun_path` exactly as it was bound (checked on a real Mac), so `b.sock` bound from *any* directory arrives as
/// `b.sock`. Accepting it would let any process that can write to LOCAL pose as the peer from a
/// directory of its own choosing. A macvmm peer never needs it: `open_unixgram` always binds an
/// absolute LOCAL.
fn peer_spellings(abs: &Path) -> Vec<PathBuf> {
    debug_assert!(abs.is_absolute());
    let mut out = vec![abs.to_path_buf()];
    if let (Some(dir), Some(name)) = (abs.parent(), abs.file_name())
        && let Ok(real) = std::fs::canonicalize(dir)
    {
        let real = real.join(name);
        if real.as_path() != abs {
            out.push(real);
        }
    }
    out
}
// ANCHOR_END: hostio_peer_spellings

// ANCHOR: hostio_net_socket
/// Set up one `--net unixgram` NIC's socket (architecture §11.3, threat model NET-1..4):
/// 1. LOCAL and the peer path are made absolute and their directories checked (NET-3);
/// 2. an existing LOCAL is inspected with `symlink_metadata`, **never** `metadata` (which would
///    follow a planted symlink to, say, `$SSH_AUTH_SOCK`). It is removed only if it is a socket,
///    owned by us, and **stale**: a test `connect` gets `ECONNREFUSED`
///    (`net::unixgram::probe`). A live socket, a symlink or any other file → exit 2 (NET-4);
/// 3. `bind(LOCAL)`, 1 MiB buffers, timeouts (`UnixgramBackend::bind`).
pub fn open_unixgram(
    spec: &crate::config::NetSpec,
) -> core::result::Result<crate::net::unixgram::UnixgramBackend, InputError> {
    use crate::config::NetPeer;
    use crate::net::unixgram::{PeerSpec, Probe, UnixgramBackend, probe};
    use std::os::unix::fs::FileTypeExt as _;
    let local = absolute(&spec.local)?;
    check_socket_dir(&local)?;
    let peer = match &spec.peer {
        NetPeer::Path(p) => {
            let abs = absolute(p)?;
            check_socket_dir(&abs)?;
            PeerSpec::Fixed {
                accept: peer_spellings(&abs),
                target: abs,
            }
        }
        NetPeer::Learn => PeerSpec::Learn,
    };
    // ANCHOR: hostio_net_stale
    match std::fs::symlink_metadata(&local) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(InputError::NetSetup { path: local, err }),
        Ok(md) => {
            if !md.file_type().is_socket() {
                return Err(InputError::NetNotSocket { path: local });
            }
            if md.uid() != hvf::host::getuid() {
                return Err(InputError::NetNotOwned { path: local });
            }
            match probe(&local) {
                Probe::Stale => {
                    std::fs::remove_file(&local).map_err(|err| InputError::NetSetup {
                        path: local.clone(),
                        err,
                    })?
                }
                Probe::Live => return Err(InputError::NetLiveSocket { path: local }),
                Probe::Unknown(err) => return Err(InputError::NetSetup { path: local, err }),
            }
        }
    }
    // ANCHOR_END: hostio_net_stale
    UnixgramBackend::bind(&local, peer).map_err(|e| InputError::NetBind {
        why: e.to_string(),
        path: local,
    })
}
// ANCHOR_END: hostio_net_socket

/// The host side of one VM: its boot-input bytes and its output sinks (architecture §6.7).
/// Built once by the CLI; every (re)boot reads from it.
#[derive(Debug)]
pub struct HostIo {
    /// `--kernel` (an ELF in M3).
    pub kernel: Option<Arc<[u8]>>,
    /// `--raw F@ADDR`, in command-line order.
    pub raw: Vec<(u64, Arc<[u8]>)>,
    /// `--initrd F` (M9), read under the RAM-size cap (LDR-1).
    pub initrd: Option<Arc<[u8]>>,
    /// DEBUG_PUTC (and from M6 the PL011).
    pub serial: SinkHandle,
    /// `--trace exits:F`: the JSONL exit trace (M4). Shared across reboots, so its byte cap
    /// spans them.
    pub trace: Option<Arc<Trace>>,
    /// The host CSPRNG, for the DTB seeds (M7, FDT-3) and virtio-rng (M12).
    pub entropy: Entropy,
    /// `--dtb-out F`, opened under PATH-3..6 (M7). Written once, by the first boot.
    pub dtb_out: Option<DtbOut>,
    /// Host keyboard input waiting for the PL011 (M6, TTY-10). Persists across reboots.
    pub serial_input: Arc<SerialInput>,
    /// Where the CLI's stdin and signal threads reach the running boot (M6).
    pub hostctl: Arc<HostCtl>,
    /// `--bios F`, read under [`crate::loader::firmware::MAX_FIRMWARE`] (LDR-1). M21: the
    /// AVPBooter bytes live only here and in the ROM allocation, never on disk (TEST-11).
    pub bios: Option<Arc<[u8]>>,
    /// M21: the vmapple SLA slot this process holds until it exits ([`take_slot`]).
    pub vmapple_slot: Option<SlotLock>,
    /// M14: `--disk` images in command-line order, opened, checked and locked ([`open_disk`]).
    /// Shared by every (re)boot: the locks are held until the process exits.
    pub disks: Vec<Arc<crate::backend::file::DiskFile>>,
    /// `--console` (M13): the virtio-console's TX sink, `None` without a console. Its own
    /// filter, cap and writer thread (TTY-1, LOG-4, SINK-1); persists across reboots.
    pub console: Option<SinkHandle>,
    /// M13: host keyboard input waiting for the virtio-console's RX buffers (TTY-10: 4 KiB,
    /// never blocking). Fed only when `stdin` is [`StdinBinding::Console`].
    pub console_input: Arc<SerialInput>,
    /// M13: which input queue the stdin thread feeds (architecture §14.4).
    pub stdin: StdinBinding,
    /// M24: `--net` NICs in command-line order: each one's bound socket and MAC
    /// ([`open_unixgram`]). Shared by every (re)boot, so the socket, the MAC and a `,learn`
    /// peer survive an in-process reboot.
    pub nets: Vec<crate::net::NetHost>,
}

/// An open `--dtb-out` file (M7).
#[derive(Debug)]
pub struct DtbOut {
    pub path: PathBuf,
    file: File,
}

impl HostIo {
    /// Open every input `cfg` names (module docs). The caps are the RAM size (LDR-1). No HVF
    /// call is made, so a bad input fails with exit code 2 before any VM exists.
    pub fn open(cfg: &VmConfig) -> Result<HostIo> {
        cfg.validate()?;
        let cap = cfg.mem_bytes;
        // Every file opened so far, for the PATH-4 clash check of the outputs.
        let mut taken: Vec<(FileId, PathBuf)> = Vec::new();
        let kernel = match &cfg.boot.kernel {
            Some(path) => {
                let (bytes, id) = read_input_id(path, cap, "the RAM size")?;
                taken.push((id, path.clone()));
                Some(bytes)
            }
            None => None,
        };
        let mut raw = Vec::with_capacity(cfg.boot.raw.len());
        for spec in &cfg.boot.raw {
            let (bytes, id) = read_input_id(&spec.path, cap, "the RAM size")?;
            taken.push((id, spec.path.clone()));
            raw.push((spec.addr, bytes));
        }
        // M9: the initrd is an input like the kernel (PATH-1/2, LDR-1: cap = RAM size).
        let initrd = match &cfg.boot.initrd {
            Some(path) => {
                let (bytes, id) = read_input_id(path, cap, "the RAM size")?;
                taken.push((id, path.clone()));
                Some(bytes)
            }
            None => None,
        };
        // M21: `--bios F` is an input like the kernel (PATH-1/2), capped at one flash bank.
        let bios = match &cfg.boot.bios {
            Some(path) => {
                let cap = crate::loader::firmware::MAX_FIRMWARE;
                let (bytes, id) = read_input_id(path, cap, "64 MiB, one flash bank")?;
                taken.push((id, path.clone()));
                Some(bytes)
            }
            None => None,
        };
        // M21: one of the two vmapple SLA slots, before any HVF call (ADR-0008 decision 6).
        let vmapple_slot = match &cfg.vmapple_slots {
            Some(dir) if cfg.machine != crate::arch::layout::MachineProfile::Virt => {
                Some(take_slot(dir, VMAPPLE_SLOTS)?)
            }
            _ => None,
        };
        // M14: disk images are inputs too (PATH-1/2), opened and locked here; the same inode
        // twice is refused before the second lock (PATH-5), and no output may be a disk
        // (PATH-4: `--serial file:disk.img` would destroy the image).
        let mut disks = Vec::with_capacity(cfg.disks.len());
        let mut disk_ids: Vec<(FileId, PathBuf)> = Vec::with_capacity(cfg.disks.len());
        for spec in &cfg.disks {
            let (disk, id) = open_disk(&spec.path, spec.read_only, &disk_ids)?;
            disk_ids.push((id, spec.path.clone()));
            taken.push((id, spec.path.clone()));
            disks.push(disk);
        }
        // Outputs after every input (PATH-4).
        let trace = match &cfg.trace {
            Some(spec) => Some(open_trace(spec, &mut taken)?),
            None => None,
        };
        // M7: `--dtb-out F` is an output like any other (PATH-3..6, PATH-4).
        let dtb_out = match &cfg.dtb_out {
            Some(path) => {
                let (file, id) = open_output(path, &taken)?;
                taken.push((id, path.clone()));
                Some(DtbOut {
                    path: path.clone(),
                    file,
                })
            }
            None => None,
        };
        // M6: the serial sink. A file is an output like any other (PATH-3..6, PATH-4), capped
        // at `max` bytes (LOG-4); every sink but `none` gets its own writer thread (SINK-1).
        let no_thread = |_| Error::Internal("cannot start the serial sink's writer thread");
        let serial = match (cfg.serial.kind, &cfg.serial.path) {
            (SinkKind::Stdio, _) => Sink::stdout(cfg.serial.policy).map_err(no_thread)?,
            (SinkKind::File, Some(path)) => {
                let (file, id) = open_output(path, &taken)?;
                taken.push((id, path.clone()));
                Sink::spawn(
                    "serial file",
                    Box::new(file),
                    cfg.serial.policy,
                    cfg.serial.max_bytes,
                )
                .map_err(no_thread)?
            }
            (SinkKind::File, None) | (SinkKind::None, _) => Sink::none(),
        };
        // M13: the console sink, after the serial one, under the same rules (PATH-3..6 and
        // PATH-4 against every other file, so `--console file:X --serial file:X` is refused).
        let console = match &cfg.console {
            None => None,
            Some(spec) => {
                let no_thread =
                    |_| Error::Internal("cannot start the console sink's writer thread");
                let sink = match (spec.kind, &spec.path) {
                    (SinkKind::Stdio, _) => Sink::stdout(spec.policy).map_err(no_thread)?,
                    (SinkKind::File, Some(path)) => {
                        let (file, id) = open_output(path, &taken)?;
                        taken.push((id, path.clone()));
                        Sink::spawn("console file", Box::new(file), spec.policy, spec.max_bytes)
                            .map_err(no_thread)?
                    }
                    (SinkKind::File, None) | (SinkKind::None, _) => Sink::none(),
                };
                Some(Arc::new(sink))
            }
        };
        // M24: the NICs' sockets, last (NET-3, NET-4). A NIC without `mac=` gets
        // 02:6d:76 plus three random bytes, drawn once so a reboot keeps the address.
        let mut nets = Vec::with_capacity(cfg.net.len());
        for spec in &cfg.net {
            let backend = open_unixgram(spec)?;
            let mac = match spec.mac {
                Some(m) => m,
                None => {
                    let mut r = [0u8; 3];
                    Entropy::os().fill(&mut r).map_err(Error::Entropy)?;
                    crate::net::default_mac(r)
                }
            };
            nets.push(crate::net::NetHost {
                backend: Arc::new(backend),
                mac,
            });
        }
        Ok(HostIo {
            kernel,
            raw,
            initrd,
            serial: Arc::new(serial),
            trace,
            entropy: Entropy::os(),
            dtb_out,
            serial_input: Arc::new(SerialInput::new()),
            hostctl: Arc::new(HostCtl::new()),
            bios,
            vmapple_slot,
            disks,
            console,
            console_input: Arc::new(SerialInput::console()),
            stdin: StdinBinding::of(cfg.serial.kind, cfg.console.as_ref().map(|c| c.kind)),
            nets,
        })
    }

    /// A `HostIo` from bytes already in memory (tests, the checkpoint harness).
    pub fn from_bytes(
        kernel: Option<Arc<[u8]>>,
        raw: Vec<(u64, Arc<[u8]>)>,
        serial: SinkHandle,
    ) -> HostIo {
        HostIo {
            kernel,
            raw,
            initrd: None,
            serial,
            trace: None,
            entropy: Entropy::os(),
            dtb_out: None,
            serial_input: Arc::new(SerialInput::new()),
            hostctl: Arc::new(HostCtl::new()),
            bios: None,
            vmapple_slot: None,
            disks: Vec::new(),
            console: None,
            console_input: Arc::new(SerialInput::console()),
            stdin: StdinBinding::Serial,
            nets: Vec::new(),
        }
    }

    /// The same `HostIo` with a virtio-console sink (host tests; M13). Stdin stays unbound
    /// from the console unless `stdin` says so.
    pub fn with_console(mut self, console: Option<SinkHandle>, stdin: StdinBinding) -> HostIo {
        self.console = console;
        self.stdin = stdin;
        self
    }

    // ANCHOR: hostio_stdin_queue
    /// The input queue the stdin thread pushes into (M13, architecture §14.4): the console's
    /// when `--console stdio`, else the PL011's. Unbound stdin is never read (`macvmm` starts
    /// no stdin thread), so the PL011's queue is returned only as a harmless default.
    pub fn stdin_queue(&self) -> &Arc<SerialInput> {
        match self.stdin {
            StdinBinding::Console => &self.console_input,
            StdinBinding::Serial | StdinBinding::Unbound => &self.serial_input,
        }
    }
    // ANCHOR_END: hostio_stdin_queue

    /// The sink that writes to the process's stdout, if any (M13: the serial or the console
    /// sink, never both). The exit path writes the TTY-6 reset through it.
    pub fn stdio_sink(&self) -> Option<&SinkHandle> {
        std::iter::once(&self.serial)
            .chain(self.console.as_ref())
            .find(|s| s.name() == "stdout")
    }

    /// The same `HostIo` with an initrd (tests, the checkpoint harness; M9).
    pub fn with_initrd(mut self, initrd: Option<Arc<[u8]>>) -> HostIo {
        self.initrd = initrd;
        self
    }

    // ANCHOR: hostio_user_requests
    /// The user asked to quit (Ctrl-A x, SIGINT, SIGTERM, SIGHUP): stop the running boot with
    /// exit code 130 and stop every producer waiting on a full sink at once (SINK-1), so the
    /// stop never waits for a stalled stdout reader. Returns true the first time.
    pub fn request_quit(&self) -> bool {
        self.serial.set_stopping();
        if let Some(c) = &self.console {
            c.set_stopping();
        }
        self.hostctl.request_quit()
    }

    /// The console I/O counters, `key=value` separated by spaces (numbers only, LOG-5): what
    /// `--stats` and Ctrl-A s print (TTY-10, SINK-1, LOG-4).
    pub fn io_stats(&self) -> String {
        let mut s = format!(
            "serial_input_dropped={} serial_input_queued={} {}",
            self.serial_input.dropped(),
            self.serial_input.len(),
            self.serial.stats("serial")
        );
        // M13: the console's counters, only when there is a console.
        if let Some(c) = &self.console {
            s.push_str(&format!(
                " console_input_dropped={} console_input_queued={} {}",
                self.console_input.dropped(),
                self.console_input.len(),
                c.stats("console")
            ));
        }
        s
    }

    /// End the guest output sinks at process exit (SINK-1, TTY-6): each drains for at most
    /// 500 ms; `stdio_epilogue` (the terminal reset) is written by the stdio sink after the
    /// guest's last byte. Returns true if everything queued was written.
    pub fn close_sinks(&self, stdio_epilogue: &[u8]) -> bool {
        let close = |s: &SinkHandle| {
            let epilogue = if s.name() == "stdout" {
                stdio_epilogue
            } else {
                &[]
            };
            s.close(epilogue)
        };
        // M13: the console sink too (at most one of the two is stdout).
        let console = self.console.as_ref().is_none_or(close);
        close(&self.serial) & console
    }
    // ANCHOR_END: hostio_user_requests

    // ANCHOR: hostio_dtb_out
    /// Write `blob` (already seed-redacted by `fdt::machine::redact_seeds`, FDT-4) to the
    /// `--dtb-out` file, if one was given. Runs on the main thread during the machine build,
    /// never on a vCPU thread.
    pub fn write_dtb_out(&self, blob: &[u8]) -> Result<()> {
        if let Some(out) = &self.dtb_out {
            let err = |err| InputError::OutputWrite {
                path: out.path.clone(),
                err,
            };
            let mut f = &out.file; // `impl Write for &File`: the fd we opened and checked
            f.write_all(blob).map_err(err)?;
            f.flush().map_err(err)?;
        }
        Ok(())
    }
    // ANCHOR_END: hostio_dtb_out
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("macvmm-hostio-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn reads_regular_files_under_the_cap() {
        let p = tmp("ok.bin");
        std::fs::write(&p, [1u8, 2, 3]).unwrap();
        assert_eq!(&*read_input(&p, 3, "cap").unwrap(), &[1, 2, 3]);
        let e = read_input(&p, 2, "the RAM size").unwrap_err();
        assert!(
            matches!(
                e,
                InputError::TooLarge {
                    size: 3,
                    cap: 2,
                    ..
                }
            ),
            "{e}"
        );
        assert!(
            e.to_string()
                .contains("exceeds the size cap of 2 bytes (the RAM size)")
        );
        std::fs::write(&p, []).unwrap();
        assert!(matches!(
            read_input(&p, 3, "cap"),
            Err(InputError::Empty { .. })
        ));
        let _ = std::fs::remove_file(&p);
    }

    /// PATH-3..6 for an output file (M4: `--trace`).
    #[test]
    fn output_policy() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tmp("out");
        std::fs::create_dir_all(&dir).unwrap();
        // Created 0600 (mode, independent of this test process's umask).
        let new = dir.join("t.jsonl");
        let _ = std::fs::remove_file(&new);
        let (_f, id) = open_output(&new, &[]).unwrap();
        let mode = std::fs::metadata(&new).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // An existing file is truncated (only after the checks) and narrowed to 0600.
        std::fs::write(&new, b"old contents").unwrap();
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o644)).unwrap();
        let (_f, id2) = open_output(&new, &[]).unwrap();
        assert_eq!(id, id2);
        assert_eq!(std::fs::metadata(&new).unwrap().len(), 0);
        assert_eq!(
            std::fs::metadata(&new).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A clash with an input is refused and the input is NOT truncated.
        let input = dir.join("kernel");
        std::fs::write(&input, b"\x7fELF").unwrap();
        let (_, in_id) = read_input_id(&input, 64, "cap").unwrap();
        let e = open_output(&input, &[(in_id, input.clone())]).unwrap_err();
        assert!(matches!(e, InputError::OutputClash { .. }), "{e}");
        assert_eq!(std::fs::read(&input).unwrap(), b"\x7fELF");
        // A hard link to another file (here the input, not passed as `taken`) is refused and
        // its target is NOT truncated.
        let hard = dir.join("hard.jsonl");
        let _ = std::fs::remove_file(&hard);
        std::fs::hard_link(&input, &hard).unwrap();
        let e = open_output(&hard, &[]).unwrap_err();
        assert!(
            matches!(e, InputError::OutputHardLink { nlink: 2, .. }),
            "{e}"
        );
        assert!(e.to_string().contains("it has 2 hard links"), "{e}");
        assert_eq!(std::fs::read(&input).unwrap(), b"\x7fELF");
        std::fs::remove_file(&hard).unwrap();
        // A symlink, dangling or not, is refused (and its target untouched).
        let link = dir.join("link.jsonl");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&input, &link).unwrap();
        let e = open_output(&link, &[]).unwrap_err();
        assert!(
            e.to_string().starts_with("refusing symlinked output: "),
            "{e}"
        );
        assert_eq!(std::fs::read(&input).unwrap(), b"\x7fELF");
        let dangling = dir.join("dangling.jsonl");
        let _ = std::fs::remove_file(&dangling);
        std::os::unix::fs::symlink(dir.join("nowhere"), &dangling).unwrap();
        assert!(matches!(
            open_output(&dangling, &[]),
            Err(InputError::OutputSymlink { .. })
        ));
        assert!(!dir.join("nowhere").exists());
        // Not a regular file; a missing directory.
        assert!(matches!(
            open_output(Path::new("/dev/null"), &[]),
            Err(InputError::OutputNotRegular { .. })
        ));
        assert!(matches!(
            open_output(&dir.join("no/such/dir/t"), &[]),
            Err(InputError::OutputOpen { .. })
        ));
        assert!(matches!(
            open_output(&dir, &[]),
            Err(InputError::OutputOpen { .. }) | Err(InputError::OutputNotRegular { .. })
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PATH-7 for the vmapple SLA lock (M21 review fix): every refusal branch of
    /// [`take_slot`], and the two-slot limit itself.
    #[test]
    fn take_slot_policy() {
        let root = tmp("slots");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // A new directory is created 0700 and the two slots are handed out in order.
        let dir = root.join("ok/vmapple-slots");
        let a = take_slot(&dir, VMAPPLE_SLOTS).unwrap();
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        let b = take_slot(&dir, VMAPPLE_SLOTS).unwrap();
        assert_eq!((a.slot, b.slot), (0, 1));
        // (f) Both held (flock is per open file, so this process conflicts with itself): a
        // third is refused; dropping one frees exactly that slot.
        let e = take_slot(&dir, VMAPPLE_SLOTS).unwrap_err();
        assert!(matches!(e, InputError::SlotsBusy { slots: 2, .. }), "{e}");
        assert!(e.to_string().contains("macOS-VM slots"), "{e}");
        drop(a);
        let c = take_slot(&dir, VMAPPLE_SLOTS).unwrap();
        assert_eq!(c.slot, 0);
        drop((b, c));
        // (a) Group or other permission bits.
        let wide = root.join("wide");
        std::fs::create_dir(&wide).unwrap();
        std::fs::set_permissions(&wide, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = take_slot(&wide, VMAPPLE_SLOTS).unwrap_err();
        assert!(matches!(e, InputError::SlotDir { .. }), "{e}");
        assert!(e.to_string().contains("it must be 0700"), "{e}");
        assert!(!wide.join("0.lock").exists());
        // (b) A symlink to a good 0700 directory.
        let link = root.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let e = take_slot(&link, VMAPPLE_SLOTS).unwrap_err();
        assert!(matches!(e, InputError::SlotDir { .. }), "{e}");
        assert!(e.to_string().contains("not a directory"), "{e}");
        // (c) A regular file where the directory goes.
        let file = root.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(matches!(
            take_slot(&file, VMAPPLE_SLOTS),
            Err(InputError::SlotDir { .. } | InputError::OutputOpen { .. })
        ));
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
        // (d) `0.lock` is a symlink: refused, its target untouched.
        let d = root.join("sym");
        std::fs::DirBuilder::new().mode(0o700).create(&d).unwrap();
        let victim = root.join("victim");
        std::fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, d.join("0.lock")).unwrap();
        assert!(matches!(
            take_slot(&d, VMAPPLE_SLOTS),
            Err(InputError::OutputSymlink { .. })
        ));
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        // (e) `0.lock` is a hard link to another file: refused, the file untouched.
        let h = root.join("hard");
        std::fs::DirBuilder::new().mode(0o700).create(&h).unwrap();
        std::fs::hard_link(&victim, h.join("0.lock")).unwrap();
        assert!(matches!(
            take_slot(&h, VMAPPLE_SLOTS),
            Err(InputError::OutputHardLink { nlink: 2, .. })
        ));
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_non_regular_inputs() {
        for path in ["/dev/zero", "/dev/null", "/"] {
            let e = read_input(Path::new(path), 1 << 20, "cap").unwrap_err();
            assert!(matches!(e, InputError::NotRegular { .. }), "{path}: {e}");
            assert!(e.to_string().starts_with("not a regular file: "));
        }
        let e = read_input(Path::new("/nonexistent/macvmm"), 1, "cap").unwrap_err();
        assert!(matches!(e, InputError::Open { .. }), "{e}");
    }
}
