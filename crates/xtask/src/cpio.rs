//! `cargo xtask mkinitramfs --base F --init F [--add SRC:DST]... --out F` (PLAN M9; threat
//! model SC-5; course ch13).
//!
//! **What an initramfs is.** The kernel unpacks one or more cpio archives, each optionally
//! compressed, *concatenated* into one buffer (Linux
//! `Documentation/driver-api/early-userspace/buffer-format.rst`). Later members replace earlier
//! ones with the same name. So we never unpack or rebuild Alpine's stock `initramfs-virt`: the
//! test initramfs is that archive, byte for byte, zero-padded to a 4-byte boundary (the
//! unpacker in `init/initramfs.c` only recognises a cpio header at a 4-byte-aligned offset),
//! followed by a small uncompressed overlay whose `/init` replaces Alpine's.
//!
//! **The newc format** (buffer-format.rst; `usr/gen_init_cpio.c`): each entry is a 110-byte
//! ASCII header, `070701` followed by 13 fields of 8 hex digits (ino, mode, uid, gid, nlink,
//! mtime, filesize, devmajor, devminor, rdevmajor, rdevminor, namesize, check), then the name
//! with its NUL, padded to a multiple of 4, then the data, padded to a multiple of 4. The
//! archive ends with an entry named `TRAILER!!!`. We write uid = gid = 0, mtime = 0 and
//! `check` = 0, so the overlay is reproducible: same inputs, same bytes.
//!
//! **What it reads** (the M9 security checklist): only the paths it is given. `--init` and
//! each `--add SRC` are opened with `O_NOFOLLOW`; a directory `SRC` is walked with
//! `symlink_metadata`, and a symlink inside it is stored as a symlink entry (its target is
//! data for the guest), never followed, so nothing outside the source tree is read. Device
//! nodes, FIFOs and sockets are refused; setuid/setgid bits are dropped. Every size is
//! checked against a cap and against the 8-hex-digit field (`u32`). `--base` is copied
//! verbatim: it is the hash-verified download (SC-5) and this tool never parses it.

use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// The newc magic.
pub const NEWC_MAGIC: &[u8; 6] = b"070701";
/// The header size.
pub const NEWC_HEADER: usize = 110;
/// The largest single overlay file, and the overlay as a whole.
pub const MAX_FILE: u64 = 64 << 20;
pub const MAX_OVERLAY: u64 = 256 << 20;
/// The largest `--base` archive copied.
pub const MAX_BASE: u64 = 512 << 20;
/// The most entries one overlay may have.
pub const MAX_ENTRIES: usize = 10_000;
/// The longest member name (Linux `PATH_MAX`).
pub const MAX_NAME: usize = 4095;

pub const S_IFREG: u32 = 0o100_000;
pub const S_IFDIR: u32 = 0o040_000;
pub const S_IFLNK: u32 = 0o120_000;

#[derive(Debug)]
pub enum CpioError {
    BadName(String),
    TooLarge(String),
    Unsupported(String),
    Io(String, io::Error),
}

impl fmt::Display for CpioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CpioError::BadName(n) => write!(f, "invalid archive name {n:?}"),
            CpioError::TooLarge(w) => write!(f, "too large: {w}"),
            CpioError::Unsupported(w) => write!(f, "unsupported: {w}"),
            CpioError::Io(w, e) => write!(f, "{w}: {e}"),
        }
    }
}

impl std::error::Error for CpioError {}

/// A newc archive being written.
#[derive(Debug, Default)]
pub struct Newc {
    out: Vec<u8>,
    next_ino: u32,
    entries: usize,
    dirs: Vec<String>,
}

fn pad4(v: &mut Vec<u8>) {
    while !v.len().is_multiple_of(4) {
        v.push(0);
    }
}

/// Check an archive path: relative, `/`-separated, no empty, `.` or `..` component.
pub fn check_name(name: &str) -> Result<(), CpioError> {
    let bad = name.is_empty()
        || name.len() > MAX_NAME
        || name.starts_with('/')
        || name.contains('\0')
        || name
            .split('/')
            .any(|c| c.is_empty() || c == "." || c == "..");
    if bad {
        return Err(CpioError::BadName(name.to_owned()));
    }
    Ok(())
}

impl Newc {
    pub fn new() -> Newc {
        Newc {
            next_ino: 1,
            ..Newc::default()
        }
    }

    // ANCHOR: cpio_newc_entry
    /// Append one entry: the 110-byte header, the NUL-terminated name padded to 4, the data
    /// padded to 4 (module docs). Sizes are checked to fit their 8-hex-digit fields.
    pub fn entry(
        &mut self,
        name: &str,
        mode: u32,
        nlink: u32,
        data: &[u8],
    ) -> Result<(), CpioError> {
        let namesize = u32::try_from(name.len() + 1)
            .map_err(|_| CpioError::TooLarge(format!("name {name:?}")))?;
        let filesize =
            u32::try_from(data.len()).map_err(|_| CpioError::TooLarge(format!("{name:?}")))?;
        self.entries += 1;
        if self.entries > MAX_ENTRIES + 1 {
            return Err(CpioError::TooLarge(format!(
                "more than {MAX_ENTRIES} entries"
            )));
        }
        let ino = if name == "TRAILER!!!" {
            0
        } else {
            self.next_ino
        };
        self.next_ino = self.next_ino.wrapping_add(1);
        let fields = [ino, mode, 0, 0, nlink, 0, filesize, 0, 0, 0, 0, namesize, 0];
        self.out.extend_from_slice(NEWC_MAGIC);
        for f in fields {
            self.out.extend_from_slice(format!("{f:08x}").as_bytes());
        }
        self.out.extend_from_slice(name.as_bytes());
        self.out.push(0);
        pad4(&mut self.out);
        self.out.extend_from_slice(data);
        pad4(&mut self.out);
        if self.out.len() as u64 > MAX_OVERLAY {
            return Err(CpioError::TooLarge("the overlay".into()));
        }
        Ok(())
    }
    // ANCHOR_END: cpio_newc_entry

    /// Add directory entries for every missing parent of `name`.
    fn parents(&mut self, name: &str) -> Result<(), CpioError> {
        let mut acc = String::new();
        let comps: Vec<&str> = name.split('/').collect();
        for c in comps.iter().take(comps.len().saturating_sub(1)) {
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(c);
            if !self.dirs.contains(&acc) {
                self.dirs.push(acc.clone());
                let d = acc.clone();
                self.entry(&d, S_IFDIR | 0o755, 2, &[])?;
            }
        }
        Ok(())
    }

    /// A regular file `name` with permission bits `perm` (setuid/setgid/sticky dropped).
    pub fn file(&mut self, name: &str, perm: u32, data: &[u8]) -> Result<(), CpioError> {
        check_name(name)?;
        if data.len() as u64 > MAX_FILE {
            return Err(CpioError::TooLarge(format!("{name:?}")));
        }
        self.parents(name)?;
        self.entry(name, S_IFREG | (perm & 0o777), 1, data)
    }

    /// A directory `name`.
    pub fn dir(&mut self, name: &str, perm: u32) -> Result<(), CpioError> {
        check_name(name)?;
        self.parents(name)?;
        if !self.dirs.iter().any(|d| d == name) {
            self.dirs.push(name.to_owned());
            self.entry(name, S_IFDIR | (perm & 0o777), 2, &[])?;
        }
        Ok(())
    }

    /// A symlink `name -> target` (the target is stored verbatim: data for the guest).
    pub fn symlink(&mut self, name: &str, target: &str) -> Result<(), CpioError> {
        check_name(name)?;
        if target.is_empty() || target.len() > MAX_NAME || target.contains('\0') {
            return Err(CpioError::BadName(target.to_owned()));
        }
        self.parents(name)?;
        self.entry(name, S_IFLNK | 0o777, 1, target.as_bytes())
    }

    /// End the archive with the trailer and return its bytes.
    pub fn finish(mut self) -> Result<Vec<u8>, CpioError> {
        self.entry("TRAILER!!!", 0, 1, &[])?;
        Ok(self.out)
    }
}

/// Open `path` without following a final symlink and read it, capped.
fn read_nofollow(path: &Path, cap: u64) -> Result<(Vec<u8>, u32), CpioError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let io = |e| CpioError::Io(format!("cannot read {}", path.display()), e);
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(crate::O_NOFOLLOW | crate::O_NONBLOCK)
        .open(path)
        .map_err(io)?;
    let meta = f.metadata().map_err(io)?;
    if !meta.is_file() {
        return Err(CpioError::Unsupported(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let mut b = Vec::new();
    f.take(cap.saturating_add(1))
        .read_to_end(&mut b)
        .map_err(io)?;
    if b.len() as u64 > cap {
        return Err(CpioError::TooLarge(path.display().to_string()));
    }
    Ok((b, meta.permissions().mode()))
}

/// Add `src` (a file, or a directory walked without following symlinks) as `dst`.
pub fn add_path(a: &mut Newc, src: &Path, dst: &str) -> Result<(), CpioError> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::symlink_metadata(src)
        .map_err(|e| CpioError::Io(format!("cannot stat {}", src.display()), e))?;
    let ft = meta.file_type();
    if ft.is_symlink() {
        let t = std::fs::read_link(src)
            .map_err(|e| CpioError::Io(format!("cannot read link {}", src.display()), e))?;
        let t = t
            .to_str()
            .ok_or_else(|| CpioError::BadName(t.display().to_string()))?
            .to_owned();
        a.symlink(dst, &t)
    } else if ft.is_dir() {
        a.dir(dst, meta.permissions().mode())?;
        let mut names: Vec<PathBuf> = std::fs::read_dir(src)
            .map_err(|e| CpioError::Io(format!("cannot list {}", src.display()), e))?
            .map(|e| e.map(|e| e.path()))
            .collect::<Result<_, _>>()
            .map_err(|e| CpioError::Io(format!("cannot list {}", src.display()), e))?;
        names.sort();
        for p in names {
            let leaf = p
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| CpioError::BadName(p.display().to_string()))?;
            add_path(a, &p, &format!("{dst}/{leaf}"))?;
        }
        Ok(())
    } else if ft.is_file() {
        let (data, mode) = read_nofollow(src, MAX_FILE)?;
        a.file(dst, mode, &data)
    } else {
        Err(CpioError::Unsupported(format!(
            "{} is a device, FIFO or socket",
            src.display()
        )))
    }
}

/// Parse `SRC:DST` (split at the last `:`; DST is an archive path).
pub fn parse_add(s: &str) -> Result<(PathBuf, String), CpioError> {
    let (src, dst) = s
        .rsplit_once(':')
        .ok_or_else(|| CpioError::BadName(format!("--add {s:?}: use SRC:DST")))?;
    let dst = dst.trim_start_matches('/');
    check_name(dst)?;
    if src.is_empty() {
        return Err(CpioError::BadName(s.to_owned()));
    }
    Ok((PathBuf::from(src), dst.to_owned()))
}

/// Build the overlay (`init` + the `--add` entries) as a finished newc archive.
pub fn overlay(init: &Path, adds: &[(PathBuf, String)]) -> Result<Vec<u8>, CpioError> {
    let mut a = Newc::new();
    let (data, _) = read_nofollow(init, MAX_FILE)?;
    a.file("init", 0o755, &data)?;
    for (src, dst) in adds {
        add_path(&mut a, src, dst)?;
    }
    a.finish()
}

/// `base` padded to 4 bytes, then `overlay` (module docs).
pub fn concat(base: &[u8], overlay: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(base.len() + 3 + overlay.len());
    out.extend_from_slice(base);
    pad4(&mut out);
    out.extend_from_slice(overlay);
    out
}

/// `cargo xtask mkinitramfs ...`.
pub fn run(
    base: &Path,
    init: &Path,
    adds: &[(PathBuf, String)],
    out: &Path,
) -> Result<u64, CpioError> {
    let (base_bytes, _) = read_nofollow(base, MAX_BASE)?;
    let ov = overlay(init, adds)?;
    let all = concat(&base_bytes, &ov);
    let mut f = crate::zboot::create_new(out)
        .map_err(|e| CpioError::Io(format!("cannot create {}", out.display()), e))?;
    f.write_all(&all)
        .and_then(|()| f.sync_all())
        .map_err(|e| CpioError::Io(format!("cannot write {}", out.display()), e))?;
    Ok(all.len() as u64)
}
