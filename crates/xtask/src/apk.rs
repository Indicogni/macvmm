//! `cargo xtask derive extract-apk APK OUT MEMBER`: copy one regular file out of an Alpine
//! `.apk` package (PLAN M18; threat model SC-4, SC-5, SC-6, SC-7; course ch21).
//!
//! **Why this exists.** The U-Boot we boot (`qemu_arm64`, ADR-0007) comes from Alpine's
//! `u-boot-qemu` package, the same pinned, versioned source as our kernel. The firmware file we
//! need, `usr/share/u-boot/qemu_arm64/u-boot.bin`, sits inside the package, so a host tool has
//! to unpack it. It is the VMM that later reads `u-boot.bin` (through `HostIo`, LDR-1); the
//! package itself never reaches the VMM.
//!
//! **What an `.apk` is** (Alpine `apk-tools`, "APK v2 package format"): three gzip streams
//! concatenated, each a tar archive without its end-of-archive blocks being meaningful: the
//! signature (`.SIGN.RSA.*`), the control segment (`.PKGINFO`, scripts), and the data (the
//! package's files). `gzip -dc` inflates concatenated members into one stream (RFC 1952 §2.2:
//! "a gzip file consists of a series of members"), and the tar reader then skips the zero
//! blocks between the archives (`ignore_zeros`).
//!
//! **Rules.**
//! - **Verify before parse** (SC-5): `scripts/fetch.sh` runs this only on an `.apk` whose
//!   sha256 matched its manifest pin in the same run (`run_derive` checks `is_verified`), and
//!   its output is pinned too, so a different `u-boot.bin` is refused before it is installed.
//! - **Caps** (SC-6): the package at most [`MAX_APK`], the inflated stream at most
//!   [`MAX_INFLATED`] (`gzip` is killed past it), the member at most [`MAX_MEMBER`] (one flash
//!   bank: the VMM would refuse a larger `--bios` anyway, LDR-1). The tar reader is M9's
//!   (`xtask::tar`, the SC-7 model), which also refuses device nodes, PAX `size` overrides and
//!   bad checksums.
//! - **Nothing is extracted to disk** but the one member: no staging directory, no symlink is
//!   ever created or followed. The member must be a regular file; a symlink or hard link with
//!   the wanted name is refused rather than resolved, and so is a name that appears twice (a
//!   parser differential: which copy would another tool pick?).
//! - **Never executable** (SC-4): the output is created `0644` with `O_EXCL|O_NOFOLLOW`
//!   ([`crate::zboot::create_new`]), so it never replaces or writes through an existing path.
//! - `gzip` is `/usr/bin/gzip` by absolute path with an empty environment (SC-5, as M9's
//!   `unzboot`).

use crate::tar::{self, Kind, Limits, Options, Reader};
use crate::zboot::{self, ZbootError};
use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The largest `.apk` read (Alpine's `u-boot-qemu` is about 0.6 MB).
pub const MAX_APK: u64 = 64 << 20;
/// The largest inflated tar stream (SC-6).
pub const MAX_INFLATED: u64 = 256 << 20;
/// The largest member extracted: one 64 MiB flash bank (LDR-1).
pub const MAX_MEMBER: u64 = 64 << 20;

/// Why an extraction failed.
#[derive(Debug)]
pub enum ApkError {
    /// The requested member name is not a clean relative path.
    BadMember(String),
    /// Reading or inflating the package failed.
    Inflate(ZbootError),
    /// The tar stream is malformed or over a cap.
    Tar(tar::TarError),
    /// The member is not in the package.
    Missing(String),
    /// The member exists but is not a regular file (a link or a directory).
    NotAFile(String),
    /// The member name appears more than once.
    Duplicate(String),
    /// Writing the output failed.
    Io(String, std::io::Error),
}

impl fmt::Display for ApkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApkError::BadMember(m) => {
                write!(f, "member name {m:?} must be a relative path with no '..'")
            }
            ApkError::Inflate(e) => write!(f, "cannot inflate the package: {e}"),
            ApkError::Tar(e) => write!(f, "malformed package: {e}"),
            ApkError::Missing(m) => write!(f, "the package has no member {m:?}"),
            ApkError::NotAFile(m) => write!(f, "member {m:?} is not a regular file"),
            ApkError::Duplicate(m) => {
                write!(f, "member {m:?} appears more than once (refused)")
            }
            ApkError::Io(w, e) => write!(f, "{w}: {e}"),
        }
    }
}

impl std::error::Error for ApkError {}

// ANCHOR: apk_find_member
/// Find regular-file member `want` in the inflated `.apk` tar stream `tar_bytes` and return
/// its data (module docs). The whole stream is read, so a duplicate name later in the archive
/// is still seen and refused.
pub fn find_member(tar_bytes: &[u8], want: &str) -> Result<Vec<u8>, ApkError> {
    let limits = Limits {
        max_member: MAX_MEMBER,
        max_total: MAX_INFLATED,
        ..Limits::default()
    };
    let want = tar::normalize(want, limits.max_name)
        .ok()
        .flatten()
        .ok_or_else(|| ApkError::BadMember(want.to_owned()))?;
    let opts = Options {
        limits,
        ignore_zeros: true,
        keep_exec: false,
    };
    let mut reader = Reader::new(tar_bytes, opts);
    let mut found: Option<Vec<u8>> = None;
    while let Some((m, data)) = reader.next_member().map_err(ApkError::Tar)? {
        let name = tar::normalize(&m.name, limits.max_name).map_err(ApkError::Tar)?;
        if name.as_deref() != Some(want.as_str()) {
            continue;
        }
        if found.is_some() {
            return Err(ApkError::Duplicate(want));
        }
        if m.kind != Kind::File {
            return Err(ApkError::NotAFile(want));
        }
        found = Some(data);
    }
    found.ok_or(ApkError::Missing(want))
}
// ANCHOR_END: apk_find_member

/// Inflate `apk` (concatenated gzip members) with `gzip` under [`MAX_INFLATED`] and extract
/// `member` ([`find_member`]).
pub fn extract_with(gzip: &Path, apk: &[u8], member: &str) -> Result<Vec<u8>, ApkError> {
    let tar_bytes = zboot::gunzip_capped(gzip, apk, MAX_INFLATED).map_err(ApkError::Inflate)?;
    find_member(&tar_bytes, member)
}

/// `cargo xtask derive extract-apk APK OUT MEMBER`: write `member` of `input` to `output`.
pub fn run(input: &Path, output: &Path, member: &str) -> Result<PathBuf, ApkError> {
    let apk = zboot::read_capped(input, MAX_APK).map_err(ApkError::Inflate)?;
    let data = extract_with(Path::new(zboot::GZIP), &apk, member)?;
    let mut f = zboot::create_new(output)
        .map_err(|e| ApkError::Io(format!("cannot create {}", output.display()), e))?;
    f.write_all(&data)
        .and_then(|()| f.sync_all())
        .map_err(|e| ApkError::Io(format!("cannot write {}", output.display()), e))?;
    Ok(output.to_path_buf())
}
