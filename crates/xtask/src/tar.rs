//! A ustar reader and extractor that never follows a symlink on the host (PLAN M9; threat model
//! SC-6, SC-7 / flaw F10; course ch13 and ch18).
//!
//! **Why our own.** Later milestones unpack downloaded archives on the host: the U-Boot `.apk`
//! (M18) and the Alpine minirootfs (M15). An archive is attacker-shaped input, and the classic
//! extraction bugs are all about *where* a write lands: `../` names, absolute names, and
//! symlinks that turn a later member's path into a write outside the staging directory (the
//! chain `a -> .`, `b -> a/../..`, then `b/x`). The old rule "reject symlinks escaping the root"
//! is the wrong model: it rejects legitimate rootfs content (`/bin/sh -> /bin/busybox` is an
//! absolute link that is correct *inside the guest*) while missing chains like the one above.
//!
//! **The SC-7 model implemented here:**
//! 1. the destination must be an existing, **empty** directory owned by us (the caller makes
//!    it with `mktemp -d`), not a symlink;
//! 2. member names are normalised: a leading `./` and empty or `.` components are dropped; `..`
//!    components and absolute names are refused;
//! 3. pass one creates directories and regular files only. Every parent of a member must be a
//!    directory **this extraction created** (tracked in a set), so a path can never cross a
//!    symlink: there are none yet, and the set proves each parent is one of ours. Files are
//!    created with `O_CREAT|O_EXCL` and `O_NOFOLLOW_ANY` (macOS; `O_NOFOLLOW` elsewhere), so an
//!    existing name is never overwritten or written through;
//! 4. pass two creates **all symlinks**, with their targets kept verbatim (data for the guest),
//!    after every file exists; nothing is ever written through them;
//! 5. hard links are allowed only to a regular file this archive already extracted; anything
//!    else (outside the archive, to a link, to a directory) is refused. Device, FIFO and socket
//!    members are refused;
//! 6. setuid and setgid bits are stripped and reported; and by default the execute bits too,
//!    because SC-4 forbids `chmod +x` of downloaded bytes on the host. The intended mode of each
//!    member is returned in [`Report::modes`], so a tool building a guest image can apply it
//!    inside the guest;
//! 7. caps ([`Limits`]): each member, the total, the number of members, name lengths, and the
//!    size of PAX headers. The total counts **every byte the reader consumes** (headers, PAX
//!    and GNU long-name data, padding, skipped zero blocks), not just file data, so it bounds
//!    the work a decompression bomb can cause. Directory, symlink and hard-link members must
//!    declare size 0 (ustar requires it for links; a body that one tar skips and another
//!    reads is a parser differential). Truncated blocks and bad header checksums are errors.
//!
//! **Format** (POSIX.1-2001 `pax`/ustar, IEEE Std 1003.1 "pax" Extended header): 512-byte
//! blocks; a header holds name (0..100), mode (100), size (124, octal), chksum (148), typeflag
//! (156), linkname (157..257), magic `ustar` (257), prefix (345..500). PAX `x` headers carry
//! `path` and `linkpath` records; GNU `L`/`K` long names are read as well. An all-zero block
//! ends the archive, unless `ignore_zeros` is set: an `.apk` is three gzip streams of tar
//! archives (signature, control, data) concatenated, so after `gzip -dc` there are several
//! end-of-archive markers in one stream.
//!
//! Directory modes are applied last (a `0555` directory would otherwise block its own
//! members), and timestamps and owners are not restored (they are host metadata, not data).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

pub const BLOCK: usize = 512;

/// Size caps (SC-6).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_member: u64,
    /// Bytes of tar stream consumed, all blocks included (module docs, rule 7).
    pub max_total: u64,
    pub max_members: usize,
    pub max_name: usize,
    pub max_pax: u64,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            max_member: 256 << 20,
            max_total: 1 << 30,
            max_members: 100_000,
            max_name: 4095,
            max_pax: 64 << 10,
        }
    }
}

/// Extraction options.
#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub limits: Limits,
    /// Skip zero blocks instead of ending at the first one (`.apk` files).
    pub ignore_zeros: bool,
    /// Keep execute bits on extracted files. Off by default (SC-4): the intended modes are in
    /// [`Report::modes`].
    pub keep_exec: bool,
}

/// What an extraction did.
#[derive(Debug, Default)]
pub struct Report {
    pub files: usize,
    pub dirs: usize,
    pub symlinks: usize,
    pub hardlinks: usize,
    pub bytes: u64,
    /// Members whose setuid/setgid bits were stripped.
    pub setid_stripped: Vec<String>,
    /// The archive's intended permission bits per member (setuid/setgid already removed).
    pub modes: BTreeMap<String, u32>,
}

#[derive(Debug)]
pub enum TarError {
    Truncated,
    BadChecksum { offset: u64 },
    BadField(&'static str),
    BadName(String),
    Refused { name: String, why: &'static str },
    TooLarge(String),
    Dest(String),
    Io(String, io::Error),
}

impl fmt::Display for TarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TarError::Truncated => f.write_str("truncated tar archive"),
            TarError::BadChecksum { offset } => write!(f, "bad header checksum at {offset:#x}"),
            TarError::BadField(w) => write!(f, "malformed tar header field {w}"),
            TarError::BadName(n) => write!(f, "refused member name {n:?}"),
            TarError::Refused { name, why } => write!(f, "refused member {name:?}: {why}"),
            TarError::TooLarge(w) => write!(f, "tar cap exceeded: {w}"),
            TarError::Dest(w) => write!(f, "bad destination: {w}"),
            TarError::Io(w, e) => write!(f, "{w}: {e}"),
        }
    }
}

impl std::error::Error for TarError {}

/// A member's kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink(String),
    Hardlink(String),
}

/// One parsed member (data excluded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub name: String,
    pub kind: Kind,
    pub mode: u32,
    pub size: u64,
}

/// Parse an octal numeric field (NUL/space padded). Base-256 (GNU) is refused: every size we
/// accept fits octal.
pub fn octal(field: &[u8], what: &'static str) -> Result<u64, TarError> {
    if field.first().is_some_and(|b| b & 0x80 != 0) {
        return Err(TarError::BadField(what));
    }
    let mut v: u64 = 0;
    let mut seen = false;
    for &c in field {
        match c {
            b'0'..=b'7' => {
                seen = true;
                v = v
                    .checked_mul(8)
                    .and_then(|v| v.checked_add(u64::from(c - b'0')))
                    .ok_or(TarError::BadField(what))?;
            }
            b' ' | 0 if !seen => {}
            b' ' | 0 => break,
            _ => return Err(TarError::BadField(what)),
        }
    }
    Ok(v)
}

fn cstr(field: &[u8]) -> &[u8] {
    match field.iter().position(|&c| c == 0) {
        Some(n) => &field[..n],
        None => field,
    }
}

/// Normalise a member name (module docs, rule 2). `Ok(None)` is the archive root (`./`).
pub fn normalize(raw: &str, max: usize) -> Result<Option<String>, TarError> {
    if raw.len() > max || raw.contains('\0') {
        return Err(TarError::BadName(raw.to_owned()));
    }
    if raw.starts_with('/') {
        return Err(TarError::BadName(raw.to_owned()));
    }
    let mut parts = Vec::new();
    for c in raw.split('/') {
        match c {
            "" | "." => {}
            ".." => return Err(TarError::BadName(raw.to_owned())),
            c => parts.push(c),
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(parts.join("/")))
}

/// A streaming reader of members.
pub struct Reader<R: Read> {
    r: R,
    opts: Options,
    offset: u64,
    members: usize,
    done: bool,
}

fn read_block<R: Read>(r: &mut R, buf: &mut [u8; BLOCK]) -> Result<bool, TarError> {
    let mut got = 0;
    while got < BLOCK {
        match r.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(TarError::Io("reading archive".into(), e)),
        }
    }
    match got {
        0 => Ok(false),
        BLOCK => Ok(true),
        _ => Err(TarError::Truncated),
    }
}

fn padded(size: u64) -> Option<u64> {
    size.checked_add(511).map(|s| s & !511)
}

impl<R: Read> Reader<R> {
    pub fn new(r: R, opts: Options) -> Reader<R> {
        Reader {
            r,
            opts,
            offset: 0,
            members: 0,
            done: false,
        }
    }

    /// Account `n` more consumed bytes against `max_total` (SC-6). `self.offset` advances for
    /// every block the reader takes, of any kind, so it *is* the consumed total.
    fn consume(&mut self, n: u64) -> Result<(), TarError> {
        self.offset = self
            .offset
            .checked_add(n)
            .ok_or(TarError::BadField("size"))?;
        if self.offset > self.opts.limits.max_total {
            return Err(TarError::TooLarge(format!(
                "the archive total (more than {} bytes)",
                self.opts.limits.max_total
            )));
        }
        Ok(())
    }

    /// Read exactly `size` data bytes (plus padding) into a vector, under `cap`. The padded
    /// size is charged to the total *before* anything is read.
    fn data(&mut self, size: u64, cap: u64, what: &str) -> Result<Vec<u8>, TarError> {
        if size > cap {
            return Err(TarError::TooLarge(format!("{what} is {size} bytes")));
        }
        let padded = padded(size).ok_or(TarError::BadField("size"))?;
        self.consume(padded)?;
        let mut v = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        let mut rest = padded;
        let mut block = [0u8; BLOCK];
        while rest > 0 {
            if !read_block(&mut self.r, &mut block)? {
                return Err(TarError::Truncated);
            }
            let take = (size - v.len() as u64).min(BLOCK as u64) as usize;
            v.extend_from_slice(&block[..take]);
            rest -= BLOCK as u64;
        }
        Ok(v)
    }

    /// The next member and its data (empty for non-files), or `None` at the end.
    pub fn next_member(&mut self) -> Result<Option<(Member, Vec<u8>)>, TarError> {
        let lim = self.opts.limits;
        let mut long_name: Option<String> = None;
        let mut long_link: Option<String> = None;
        let mut block = [0u8; BLOCK];
        loop {
            if self.done {
                return Ok(None);
            }
            if !read_block(&mut self.r, &mut block)? {
                self.done = true;
                return Ok(None);
            }
            let here = self.offset;
            if block.iter().all(|&b| b == 0) && !self.opts.ignore_zeros {
                // The end-of-archive marker: stop without charging it.
                self.done = true;
                return Ok(None);
            }
            // Every other block, skipped zero blocks included, counts against the total.
            self.consume(BLOCK as u64)?;
            if block.iter().all(|&b| b == 0) {
                continue; // `ignore_zeros`
            }
            let want = octal(&block[148..156], "chksum")?;
            let sum: u64 = block
                .iter()
                .enumerate()
                .map(|(i, &b)| {
                    if (148..156).contains(&i) {
                        32
                    } else {
                        u64::from(b)
                    }
                })
                .sum();
            if sum != want {
                return Err(TarError::BadChecksum { offset: here });
            }
            self.members += 1;
            if self.members > lim.max_members {
                return Err(TarError::TooLarge(format!(
                    "more than {} members",
                    lim.max_members
                )));
            }
            let size = octal(&block[124..136], "size")?;
            let mode = u32::try_from(octal(&block[100..108], "mode")? & 0o7777)
                .map_err(|_| TarError::BadField("mode"))?;
            let typeflag = block[156];
            let text = |b: &[u8]| String::from_utf8_lossy(cstr(b)).into_owned();
            match typeflag {
                b'x' | b'L' | b'K' | b'g' => {
                    let d = self.data(size, lim.max_pax, "an extended header")?;
                    match typeflag {
                        b'L' => long_name = Some(text(&d)),
                        b'K' => long_link = Some(text(&d)),
                        b'x' => {
                            for (k, v) in pax_records(&d)? {
                                match k.as_str() {
                                    "path" => long_name = Some(v),
                                    "linkpath" => long_link = Some(v),
                                    // A second, disagreeing size is a classic
                                    // parser-differential trick; every member we accept fits
                                    // the octal field, so a PAX size is refused outright.
                                    "size" => return Err(TarError::BadField("pax size")),
                                    _ => {}
                                }
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                _ => {}
            }
            let mut name = long_name.take().unwrap_or_else(|| {
                let n = text(&block[0..100]);
                let prefix = text(&block[345..500]);
                if &block[257..262] == b"ustar" && !prefix.is_empty() {
                    format!("{prefix}/{n}")
                } else {
                    n
                }
            });
            let link = long_link.take().unwrap_or_else(|| text(&block[157..257]));
            if name.len() > lim.max_name || link.len() > lim.max_name {
                return Err(TarError::BadName(name));
            }
            // Old (pre-POSIX) tars mark a directory as a regular-file member whose name ends
            // in `/`; GNU tar and libarchive read typeflag NUL or '0' that way too.
            let old_dir = matches!(typeflag, 0 | b'0') && name.ends_with('/');
            let kind = match typeflag {
                0 | b'0' if old_dir => Kind::Dir,
                b'0' | 0 | b'7' => Kind::File,
                b'5' => Kind::Dir,
                b'2' => Kind::Symlink(link),
                b'1' => Kind::Hardlink(link),
                b'3' | b'4' => {
                    return Err(TarError::Refused {
                        name,
                        why: "device node",
                    });
                }
                b'6' => return Err(TarError::Refused { name, why: "FIFO" }),
                _ => {
                    return Err(TarError::Refused {
                        name,
                        why: "unknown member type",
                    });
                }
            };
            if old_dir {
                name.pop();
            }
            let data = if kind == Kind::File {
                self.data(size, lim.max_member, &format!("member {name:?}"))?
            } else if size != 0 {
                // ustar: links carry no data; a directory body is skipped by some tars and
                // read by others. Refuse rather than guess (rule 7).
                return Err(TarError::Refused {
                    name,
                    why: "non-file member with a non-zero size",
                });
            } else {
                Vec::new()
            };
            return Ok(Some((
                Member {
                    name,
                    kind,
                    mode,
                    size,
                },
                data,
            )));
        }
    }
}

/// Parse PAX records `"<len> <key>=<value>\n"`.
pub fn pax_records(d: &[u8]) -> Result<Vec<(String, String)>, TarError> {
    let mut out = Vec::new();
    let mut rest = d;
    while !rest.is_empty() {
        if rest.iter().all(|&b| b == 0) {
            break;
        }
        let sp = rest
            .iter()
            .position(|&b| b == b' ')
            .ok_or(TarError::BadField("pax"))?;
        let len: usize = std::str::from_utf8(&rest[..sp])
            .ok()
            .and_then(|s| s.parse().ok())
            .ok_or(TarError::BadField("pax"))?;
        if len <= sp + 1 || len > rest.len() || rest[len - 1] != b'\n' {
            return Err(TarError::BadField("pax"));
        }
        let rec = &rest[sp + 1..len - 1];
        let eq = rec
            .iter()
            .position(|&b| b == b'=')
            .ok_or(TarError::BadField("pax"))?;
        out.push((
            String::from_utf8_lossy(&rec[..eq]).into_owned(),
            String::from_utf8_lossy(&rec[eq + 1..]).into_owned(),
        ));
        rest = &rest[len..];
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
const OPEN_NOFOLLOW: i32 = crate::O_NOFOLLOW_ANY;
#[cfg(not(target_os = "macos"))]
const OPEN_NOFOLLOW: i32 = crate::O_NOFOLLOW;

/// Check rule 1: an existing, empty, real directory owned by us.
fn check_dest(dest: &Path) -> Result<(), TarError> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(dest)
        .map_err(|e| TarError::Io(format!("cannot stat {}", dest.display()), e))?;
    if !meta.file_type().is_dir() {
        return Err(TarError::Dest(format!(
            "{} is not a directory",
            dest.display()
        )));
    }
    let mut it = std::fs::read_dir(dest)
        .map_err(|e| TarError::Io(format!("cannot list {}", dest.display()), e))?;
    if it.next().is_some() {
        return Err(TarError::Dest(format!("{} is not empty", dest.display())));
    }
    if meta.mode() & 0o022 != 0 {
        return Err(TarError::Dest(format!(
            "{} is group- or world-writable",
            dest.display()
        )));
    }
    // Owned by us: a file we create is owned by our effective uid, so compare with a probe
    // (std has no getuid, and this crate has no libc).
    let probe = dest.join(".macvmm-owner-probe");
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|e| TarError::Io(format!("cannot write into {}", dest.display()), e))?;
    let uid = f.metadata().map(|m| m.uid());
    drop(f);
    std::fs::remove_file(&probe)
        .map_err(|e| TarError::Io(format!("cannot remove {}", probe.display()), e))?;
    match uid {
        Ok(u) if u == meta.uid() => Ok(()),
        _ => Err(TarError::Dest(format!(
            "{} is not owned by us",
            dest.display()
        ))),
    }
}

/// The parent of `name` ("" for top-level members).
fn parent_of(name: &str) -> &str {
    name.rsplit_once('/').map_or("", |(p, _)| p)
}

/// Extract `r` into the fresh, empty directory `dest` (module docs).
pub fn extract<R: Read>(r: R, dest: &Path, opts: Options) -> Result<Report, TarError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    check_dest(dest)?;
    // Resolve the user's path once (macOS's own `/var -> private/var` is user intent): from
    // here on, every open uses `O_NOFOLLOW_ANY` under this real directory.
    let real = std::fs::canonicalize(dest)
        .map_err(|e| TarError::Io(format!("cannot resolve {}", dest.display()), e))?;
    let dest = real.as_path();
    let mut report = Report::default();
    let mut dirs: BTreeSet<String> = BTreeSet::new(); // created by us; "" is dest itself
    dirs.insert(String::new());
    let mut dir_modes: Vec<(String, u32)> = Vec::new();
    let mut files: BTreeSet<String> = BTreeSet::new();
    let mut links: Vec<(String, String)> = Vec::new();
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let mut reader = Reader::new(r, opts);
    while let Some((m, data)) = reader.next_member()? {
        let Some(name) = normalize(&m.name, opts.limits.max_name)? else {
            continue; // the archive root, `./`
        };
        let mut mode = m.mode & 0o777;
        if m.mode & 0o6000 != 0 {
            report.setid_stripped.push(name.clone());
        }
        if !dirs.contains(parent_of(&name)) {
            return Err(TarError::Refused {
                name,
                why: "its parent is not a directory created by this extraction",
            });
        }
        let path = dest.join(&name);
        let io = |e, what: &str| TarError::Io(format!("{what} {}", path.display()), e);
        match &m.kind {
            Kind::Dir => {
                if dirs.contains(&name) {
                    continue;
                }
                if !taken.insert(name.clone()) {
                    return Err(TarError::Refused {
                        name,
                        why: "duplicate member",
                    });
                }
                std::fs::create_dir(&path).map_err(|e| io(e, "cannot create"))?;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
                    .map_err(|e| io(e, "cannot chmod"))?;
                dirs.insert(name.clone());
                dir_modes.push((name.clone(), mode));
                report.dirs += 1;
            }
            Kind::File => {
                if !taken.insert(name.clone()) {
                    return Err(TarError::Refused {
                        name,
                        why: "duplicate member",
                    });
                }
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(OPEN_NOFOLLOW)
                    .open(&path)
                    .map_err(|e| io(e, "cannot create"))?;
                f.write_all(&data).map_err(|e| io(e, "cannot write"))?;
                let host_mode = if opts.keep_exec { mode } else { mode & 0o666 };
                f.set_permissions(std::fs::Permissions::from_mode(host_mode))
                    .map_err(|e| io(e, "cannot chmod"))?;
                files.insert(name.clone());
                report.files += 1;
                report.bytes = report.bytes.saturating_add(m.size);
            }
            Kind::Hardlink(target) => {
                let t =
                    normalize(target, opts.limits.max_name)?.ok_or_else(|| TarError::Refused {
                        name: name.clone(),
                        why: "hard link to the root",
                    })?;
                if !files.contains(&t) {
                    return Err(TarError::Refused {
                        name,
                        why: "hard link to something that is not a file of this archive",
                    });
                }
                if !taken.insert(name.clone()) {
                    return Err(TarError::Refused {
                        name,
                        why: "duplicate member",
                    });
                }
                std::fs::hard_link(dest.join(&t), &path).map_err(|e| io(e, "cannot link"))?;
                files.insert(name.clone());
                report.hardlinks += 1;
                mode = report.modes.get(&t).copied().unwrap_or(mode);
            }
            Kind::Symlink(target) => {
                if target.is_empty() || target.contains('\0') {
                    return Err(TarError::Refused {
                        name,
                        why: "empty symlink target",
                    });
                }
                if !taken.insert(name.clone()) {
                    return Err(TarError::Refused {
                        name,
                        why: "duplicate member",
                    });
                }
                links.push((name.clone(), target.clone()));
            }
        }
        report.modes.insert(name, mode);
    }
    // Pass two: symlinks, targets verbatim; `symlink` fails on an existing name, so a link is
    // never placed over (or written through) anything.
    for (name, target) in &links {
        let path = dest.join(name);
        std::os::unix::fs::symlink(target, &path)
            .map_err(|e| TarError::Io(format!("cannot create symlink {}", path.display()), e))?;
        report.symlinks += 1;
    }
    // Directory modes last, deepest first.
    dir_modes.sort_by(|a, b| b.0.cmp(&a.0));
    for (name, mode) in dir_modes {
        let path: PathBuf = dest.join(&name);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode | 0o700))
            .map_err(|e| TarError::Io(format!("cannot chmod {}", path.display()), e))?;
    }
    Ok(report)
}
