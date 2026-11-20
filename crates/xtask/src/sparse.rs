//! `cargo xtask write-sparse OUT` and `cargo xtask derive write-sparse IN.xz OUT`: write a
//! stream to a **sparse** file, skipping every all-zero 64 KiB block (PLAN M19; threat model
//! SC-5, SC-6, SC-10; course ch22).
//!
//! **Why this exists.** The FreeBSD project ships its arm64 VM image as
//! `FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz`: about 600 MB compressed, about 6 GiB raw,
//! and most of those 6 GiB are zeros (free space in the UFS file system). A plain
//! `xz -dc > f.raw` writes every zero byte and costs 6 GiB of disk per copy. APFS, like most
//! modern file systems, supports *holes*: a range of a file that was never written reads back as
//! zeros and takes no blocks. So instead of writing a zero block we `lseek` over it, and at the
//! end `ftruncate` to the full length so a trailing run of zeros is a hole too. (Observed on
//! macOS 27.2: APFS keeps a hole only for a gap larger than about 8 MiB and zero-fills smaller
//! ones, so a sparse file is a property of *big* zero runs, which a disk image has.) The image then
//! occupies only its real data plus those small zero-filled gaps (measured: about 3.4 GB
//! allocated of 6.48 GB logical, roughly half), and each test's `cp -c` APFS clone of it is
//! instant and free until the guest writes.
//!
//! **Why 64 KiB.** It is a multiple of the APFS allocation block (4 KiB) and of every sector
//! size, so a skipped block is always a whole number of file-system blocks, and it is large
//! enough that the zero check (a plain loop the compiler vectorizes) costs nothing next to `xz`.
//!
//! **Rules.**
//! - **Verify before parse** (SC-5): `scripts/fetch.sh` runs the `derive` form only on an
//!   `.xz` whose sha256 matched its manifest pin in the same run, and that pin agrees with the
//!   FreeBSD project's `CHECKSUM.SHA256`. `xz` itself is the only parser of the compressed
//!   stream; this module only counts and copies bytes.
//! - **A cap on the output** (SC-6): at most [`MAX_OUTPUT`] (16 GiB) bytes, or a lower cap from
//!   `MACVMM_SPARSE_CAP` (tests only; it can never raise the cap). One byte more and the
//!   decompressor is killed, the output is **deleted**, and the command fails. A decompression
//!   bomb therefore costs at most the cap, and `fetch.sh` checks for 8 GiB of free space first.
//! - **Writes only its output path** (SC-6): the output is created `0644` with
//!   `O_CREAT|O_EXCL|O_NOFOLLOW` ([`crate::zboot::create_new`]): an existing file or a symlink at
//!   that path is refused, never replaced or written through. Never executable (SC-4).
//! - The derived file's hash is TOFU (SC-10): it is pinned at first build as a **regression
//!   check** (did `xz` or this writer change the bytes?), not as a trust root. Trust comes from
//!   the `.xz` pin.
//! - `xz` is found on `PATH` (macOS ships none; Homebrew's `xz` is the documented
//!   prerequisite) and runs with no shell, its input path after `--`, and an environment of
//!   just `PATH`. Its version is checked first (SC-8): XZ Utils 5.6.0 and 5.6.1 carried the
//!   CVE-2024-3094 backdoor and are refused, both as the `xz` program's version and as the
//!   run-time `liblzma` version it reports, as `scripts/setup.sh` refuses them
//!   ([`check_xz_version`]).

use std::fmt;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Command, Stdio};

// ANCHOR: sparse_block
/// The unit of the zero check: a whole 64 KiB block is either written or skipped.
pub const BLOCK: usize = 64 << 10;
/// The largest output accepted (SC-6): 16 GiB, about 2.7x the real FreeBSD image.
pub const MAX_OUTPUT: u64 = 16 << 30;
// ANCHOR_END: sparse_block

/// The environment variable that may **lower** [`MAX_OUTPUT`] (for `scripts/test-fetch.sh`).
pub const CAP_ENV: &str = "MACVMM_SPARSE_CAP";

/// Why a sparse write failed.
#[derive(Debug)]
pub enum SparseError {
    /// The input produced more than the cap (bytes); the output was deleted.
    TooLarge(u64),
    /// The decompressor could not be started, or exited with a failure.
    Decompress(String),
    /// Creating, writing or reading failed (what, why).
    Io(String, io::Error),
}

impl fmt::Display for SparseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SparseError::TooLarge(cap) => write!(
                f,
                "the stream is larger than the {cap}-byte cap (SC-6); the output was deleted"
            ),
            SparseError::Decompress(why) => write!(f, "decompression failed: {why}"),
            SparseError::Io(what, e) => write!(f, "{what}: {e}"),
        }
    }
}

impl std::error::Error for SparseError {}

/// What a sparse write did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    /// The logical length of the output.
    pub len: u64,
    /// Bytes actually written (the non-zero blocks).
    pub written: u64,
}

/// The effective cap: [`MAX_OUTPUT`], or a smaller positive value from [`CAP_ENV`].
pub fn effective_cap() -> u64 {
    cap_from(std::env::var(CAP_ENV).ok().as_deref())
}

/// The cap a [`CAP_ENV`] value gives (SC-6), kept pure so the "can only lower it" rule is
/// unit-tested: a positive number below [`MAX_OUTPUT`] lowers the cap; anything else (unset,
/// empty, `0`, not a number, or a value at or above [`MAX_OUTPUT`]) leaves it at [`MAX_OUTPUT`].
pub fn cap_from(value: Option<&str>) -> u64 {
    value
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&c| c > 0)
        .map_or(MAX_OUTPUT, |c| c.min(MAX_OUTPUT))
}

/// Fill `buf` from `r` as far as possible; returns how many bytes were read (less than
/// `buf.len()` only at end of stream).
fn fill(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(n)
}

// ANCHOR: sparse_copy
/// Copy `r` into `out`, seeking over all-zero [`BLOCK`]s, then set the length so trailing zeros
/// are a hole too. Fails with [`SparseError::TooLarge`] as soon as more than `cap` bytes
/// arrive (the caller deletes the output). `out` must be empty and positioned at 0.
pub fn copy_sparse<W: Write + Seek>(
    r: &mut impl Read,
    out: &mut W,
    cap: u64,
    set_len: impl FnOnce(&mut W, u64) -> io::Result<()>,
) -> Result<Stats, SparseError> {
    let mut buf = vec![0u8; BLOCK];
    let mut len: u64 = 0;
    let mut written: u64 = 0;
    // Bytes skipped since the last write: the next write first seeks over them.
    let mut pending_skip: u64 = 0;
    loop {
        let n = fill(r, &mut buf).map_err(|e| SparseError::Io("cannot read input".into(), e))?;
        if n == 0 {
            break;
        }
        // usize -> u64 is lossless on every target we build for.
        len = len
            .checked_add(n as u64)
            .ok_or(SparseError::TooLarge(cap))?;
        if len > cap {
            return Err(SparseError::TooLarge(cap));
        }
        let block = &buf[..n];
        if block.iter().all(|&b| b == 0) {
            pending_skip += n as u64;
        } else {
            if pending_skip > 0 {
                let off = i64::try_from(pending_skip).map_err(|_| SparseError::TooLarge(cap))?;
                out.seek(SeekFrom::Current(off))
                    .map_err(|e| SparseError::Io("cannot seek output".into(), e))?;
                pending_skip = 0;
            }
            out.write_all(block)
                .map_err(|e| SparseError::Io("cannot write output".into(), e))?;
            written += n as u64;
        }
        if n < BLOCK {
            break;
        }
    }
    out.flush()
        .map_err(|e| SparseError::Io("cannot flush output".into(), e))?;
    // A trailing zero run was only skipped: the length makes it part of the file (a hole).
    set_len(out, len).map_err(|e| SparseError::Io("cannot set output length".into(), e))?;
    Ok(Stats { len, written })
}
// ANCHOR_END: sparse_copy

/// Create `output` (refusing an existing path or a symlink) and copy `r` into it sparsely.
/// On any failure the output is deleted, so a partial or over-cap file never survives.
pub fn write_to_path(r: &mut impl Read, output: &Path, cap: u64) -> Result<Stats, SparseError> {
    let mut f = crate::zboot::create_new(output)
        .map_err(|e| SparseError::Io(format!("cannot create {}", output.display()), e))?;
    let res = copy_sparse(r, &mut f, cap, |f, len| f.set_len(len)).and_then(|s| {
        f.sync_all()
            .map_err(|e| SparseError::Io(format!("cannot sync {}", output.display()), e))?;
        Ok(s)
    });
    if res.is_err() {
        drop(f);
        // We created this path with O_EXCL a moment ago, so it is ours to remove.
        let _ = std::fs::remove_file(output);
    }
    res
}

/// `cargo xtask write-sparse OUT`: standard input to a sparse `OUT`, capped.
pub fn run_stdin(output: &Path) -> Result<Stats, SparseError> {
    let stdin = io::stdin();
    let mut lock = stdin.lock();
    write_to_path(&mut lock, output, effective_cap())
}

/// `cargo xtask derive write-sparse IN.xz OUT`: `xz -dc -- IN` into a sparse `OUT`, capped.
/// `xz` is killed if the cap is exceeded, and a non-zero `xz` exit fails the derive (a
/// truncated or corrupt stream must not become a "valid" short image).
pub fn run_xz(input: &Path, output: &Path) -> Result<Stats, SparseError> {
    let cap = effective_cap();
    let path = std::env::var_os("PATH").unwrap_or_default();
    let version = Command::new("xz")
        .arg("--version")
        .env_clear()
        .env("PATH", &path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| {
            SparseError::Decompress(format!(
                "cannot run xz ({e}); install it (macOS ships none), e.g. `brew install xz`"
            ))
        })?;
    check_xz_version(&String::from_utf8_lossy(&version.stdout))?;
    let mut child = Command::new("xz")
        .arg("-dc")
        .arg("--")
        .arg(input)
        .env_clear()
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| {
            SparseError::Decompress(format!(
                "cannot run xz ({e}); install it (macOS ships none), e.g. `brew install xz`"
            ))
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| SparseError::Decompress("xz has no stdout".into()))?;
    let res = write_to_path(&mut stdout, output, cap);
    drop(stdout);
    if res.is_err() {
        // Over the cap or a write error: stop the decompressor rather than drain it.
        let _ = child.kill();
    }
    let status = child.wait();
    let stats = res?;
    let status = status.map_err(|e| SparseError::Decompress(format!("wait for xz: {e}")))?;
    if !status.success() {
        let _ = std::fs::remove_file(output);
        return Err(SparseError::Decompress(format!("xz exited with {status}")));
    }
    Ok(stats)
}

/// XZ Utils releases that must never run (CVE-2024-3094: a backdoor in 5.6.0 and 5.6.1).
pub const XZ_REFUSED: [&str; 2] = ["5.6.0", "5.6.1"];

/// SC-8: accept `xz --version` output only from XZ Utils 5.x, and never a backdoored release.
/// The output looks like `xz (XZ Utils) 5.8.4` then `liblzma 5.8.4`. Both lines are checked:
/// the CVE-2024-3094 backdoor lives in **liblzma**, and the second line is the version of the
/// library the `xz` binary actually loaded at run time. A clean `xz` program linked against a
/// backdoored 5.6.0/5.6.1 liblzma (a mixed install) is refused too. A missing `liblzma` line
/// (older releases print none) is accepted; a malformed one is not.
pub fn check_xz_version(out: &str) -> Result<(), SparseError> {
    let mut lines = out.lines().map(str::trim);
    let line = lines.next().unwrap_or("");
    let ver = line
        .strip_prefix("xz (XZ Utils) ")
        .ok_or_else(|| SparseError::Decompress(format!("unrecognised `xz --version`: {line:?}")))?;
    check_xz_release("xz", ver.split_whitespace().next().unwrap_or(""))?;
    for line in lines {
        if let Some(lib) = line.strip_prefix("liblzma ") {
            check_xz_release("liblzma", lib.split_whitespace().next().unwrap_or(""))?;
        }
    }
    Ok(())
}

/// One version string (`what` is `xz` or `liblzma`): never a backdoored release, and 5.x.
fn check_xz_release(what: &str, ver: &str) -> Result<(), SparseError> {
    if XZ_REFUSED.contains(&ver) {
        return Err(SparseError::Decompress(format!(
            "{what} {ver} is a CVE-2024-3094 backdoored release; refusing (`brew upgrade xz`)"
        )));
    }
    let major: Option<u32> = ver.split('.').next().and_then(|m| m.parse().ok());
    if major.is_none_or(|m| m < 5) {
        return Err(SparseError::Decompress(format!(
            "{what} {ver:?} is not XZ Utils 5.x; refusing"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn effective_cap_never_raises() {
        // Without the variable the cap is the constant (the test harness does not set it).
        if std::env::var_os(CAP_ENV).is_none() {
            assert_eq!(effective_cap(), MAX_OUTPUT);
        }
    }

    #[test]
    fn cap_env_can_only_lower_the_cap() {
        // SC-6: above, at or far above MAX_OUTPUT leaves it at MAX_OUTPUT.
        assert_eq!(cap_from(Some("99999999999999")), MAX_OUTPUT);
        assert_eq!(cap_from(Some(&(MAX_OUTPUT + 1).to_string())), MAX_OUTPUT);
        assert_eq!(cap_from(Some(&u64::MAX.to_string())), MAX_OUTPUT);
        assert_eq!(cap_from(Some(&MAX_OUTPUT.to_string())), MAX_OUTPUT);
        // Below it lowers the cap (whitespace tolerated).
        assert_eq!(cap_from(Some("1048576")), 1_048_576);
        assert_eq!(cap_from(Some(" 4096\n")), 4096);
        assert_eq!(
            cap_from(Some(&(MAX_OUTPUT - 1).to_string())),
            MAX_OUTPUT - 1
        );
        // Garbage, zero, negative, overflowing, empty or unset: the constant.
        for v in ["0", "abc", "-5", "", "1e9", "18446744073709551616"] {
            assert_eq!(cap_from(Some(v)), MAX_OUTPUT, "{v:?}");
        }
        assert_eq!(cap_from(None), MAX_OUTPUT);
    }

    #[test]
    fn short_tail_block_is_written() {
        let data: Vec<u8> = (0..(BLOCK + 10)).map(|i| (i % 7) as u8).collect();
        let mut out = Cursor::new(Vec::new());
        let s = copy_sparse(&mut Cursor::new(&data), &mut out, MAX_OUTPUT, |c, l| {
            c.get_mut().resize(usize::try_from(l).unwrap(), 0);
            Ok(())
        })
        .unwrap();
        assert_eq!(s.len, data.len() as u64);
        assert_eq!(out.into_inner(), data);
    }

    #[test]
    fn xz_version_floor() {
        assert!(check_xz_version("xz (XZ Utils) 5.8.4\nliblzma 5.8.4\n").is_ok());
        assert!(check_xz_version("xz (XZ Utils) 5.4.6\n").is_ok());
        assert!(check_xz_version("xz (XZ Utils) 5.6.1\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 5.6.0\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 4.999.9beta\n").is_err());
        assert!(check_xz_version("something else 5.8\n").is_err());
        assert!(check_xz_version("").is_err());
        // The backdoor is in liblzma: a clean xz program loading a 5.6.x library is refused.
        assert!(check_xz_version("xz (XZ Utils) 5.8.4\nliblzma 5.6.1\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 5.8.4\nliblzma 5.6.0\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 5.8.4\nliblzma 4.999\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 5.8.4\nliblzma garbage\n").is_err());
        assert!(check_xz_version("xz (XZ Utils) 5.6.1\nliblzma 5.8.4\n").is_err());
    }

    #[test]
    fn over_cap_fails() {
        let data = vec![1u8; 100];
        let mut out = Cursor::new(Vec::new());
        let e = copy_sparse(&mut Cursor::new(&data), &mut out, 99, |_, _| Ok(())).unwrap_err();
        assert!(matches!(e, SparseError::TooLarge(99)));
    }
}
