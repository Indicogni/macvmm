//! Target `tar`: the host-side ustar/pax extractor (`xtask::tar`; POSIX.1-2001 pax; threat model
//! SC-6, SC-7, flaw F10) that unpacks downloaded archives (U-Boot `.apk`, Alpine minirootfs).
//!
//! **Why it is fuzzed like the VMM.** The archives are downloaded: after the sha256 pin they are
//! trusted not to change, but the pin was taken on a file someone else built, and the classic
//! extraction bugs (`../` names, absolute names, a symlink chain that turns a later member's
//! path into a write outside the staging directory) are about *where a write lands on the
//! host*. A bug here writes into the learner's home directory, not into a guest.
//!
//! **Input:** the archive bytes. Seeds are well-formed archives of files, directories, symlinks
//! (including `a -> .` and `b -> a/../..` chains) and hard links, with hostile names mixed in.
//!
//! **Invariants** (threat model §9.3 "tar, cpio, zboot"): each iteration extracts into a fresh
//! `root/` directory next to a **canary** file; afterwards the canary's content and mtime are
//! unchanged and the iteration directory still holds exactly `root/` and the canary (nothing was
//! created beside the root); nothing extracted is setuid/setgid; no panic.

use crate::Target;
use crate::rng::Rng;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const TARGET: Target = Target {
    name: "tar",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 32 * 512,
};

static ITER: AtomicU64 = AtomicU64::new(0);
const CANARY: &[u8] = b"macvmm fuzz canary: must never change\n";

/// A private 0700 work directory for this process, created once.
///
/// **Never an existing directory.** The name has an unpredictable 64-bit suffix (from
/// `/dev/urandom`) and is created with a single non-recursive `mkdir`, retried under a new name if
/// it already exists (`mkdtemp(3)`'s contract). If `$TMPDIR` is a shared directory such as `/tmp`,
/// another local user could otherwise create the directory first, own it, and swap the
/// per-iteration `<n>/root` entries for symlinks while the extractor writes hostile members into
/// them. A directory we created ourselves, 0700, has no such window.
fn work() -> Result<PathBuf, String> {
    static DIR: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
    DIR.get_or_init(create_work_dir).clone()
}

fn create_work_dir() -> Result<PathBuf, String> {
    use std::io::Read;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let mut urandom =
        std::fs::File::open("/dev/urandom").map_err(|e| format!("/dev/urandom: {e}"))?;
    for _ in 0..16 {
        let mut b = [0u8; 8];
        urandom
            .read_exact(&mut b)
            .map_err(|e| format!("/dev/urandom: {e}"))?;
        let d = std::env::temp_dir().join(format!(
            "macvmm-fuzz-tar-{}-{:016x}",
            std::process::id(),
            u64::from_le_bytes(b)
        ));
        match std::fs::DirBuilder::new().mode(0o700).create(&d) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("work dir {}: {e}", d.display())),
        }
        // The exclusive `mkdir` made it ours (std has no `getuid`, and this crate has no libc;
        // in a sticky `/tmp` nobody else can rename it away either); check that it is a
        // directory nobody else can enter.
        let md = std::fs::symlink_metadata(&d).map_err(|e| e.to_string())?;
        if !md.is_dir() || md.mode() & 0o077 != 0 {
            return Err(format!("{} is not a private directory", d.display()));
        }
        return Ok(d);
    }
    Err("could not create a fresh work directory under $TMPDIR".into())
}

pub fn run(data: &[u8]) -> crate::Verdict {
    use std::os::unix::fs::DirBuilderExt;
    let n = ITER.fetch_add(1, Ordering::Relaxed);
    let it = work()?.join(n.to_string());
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&it)
        .map_err(|e| format!("{}: {e}", it.display()))?;
    let result = check(data, &it);
    // `remove_dir_all` does not follow symlinks (std docs), so cleaning up a hostile tree is safe.
    let _ = std::fs::remove_dir_all(&it);
    result
}

fn check(data: &[u8], it: &Path) -> crate::Verdict {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let root = it.join("root");
    let canary = it.join("canary");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&root)
        .map_err(|e| e.to_string())?;
    std::fs::write(&canary, CANARY).map_err(|e| e.to_string())?;
    let before = std::fs::symlink_metadata(&canary).map_err(|e| e.to_string())?;
    let opts = xtask::tar::Options {
        limits: xtask::tar::Limits {
            max_member: 1 << 20,
            max_total: 4 << 20,
            max_members: 256,
            ..xtask::tar::Limits::default()
        },
        ignore_zeros: data.first().is_some_and(|b| b & 1 == 1),
        keep_exec: false,
    };
    let _ = xtask::tar::extract(data, &root, opts);
    let after = std::fs::symlink_metadata(&canary).map_err(|e| format!("canary: {e}"))?;
    let content = std::fs::read(&canary).map_err(|e| format!("canary: {e}"))?;
    if content != CANARY || after.mtime() != before.mtime() || after.ino() != before.ino() {
        return Err("the canary outside the extraction root changed (SC-7)".into());
    }
    let mut names: Vec<String> = std::fs::read_dir(it)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    if names != ["canary", "root"] {
        return Err(format!(
            "extraction created {names:?} beside its root (SC-7)"
        ));
    }
    let mut stack = vec![root];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let md = std::fs::symlink_metadata(e.path()).map_err(|e| e.to_string())?;
            if md.mode() & 0o6000 != 0 {
                return Err(format!("{} is setuid/setgid", e.path().display()));
            }
            if md.is_dir() {
                stack.push(e.path());
            }
        }
    }
    Ok(())
}

/// One ustar header block (POSIX.1-2001 ustar layout) followed by the data blocks.
pub fn member(name: &str, kind: u8, link: &str, data: &[u8]) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    let put = |h: &mut Vec<u8>, off: usize, s: &[u8]| {
        for (i, b) in s.iter().enumerate() {
            if let Some(slot) = h.get_mut(off + i) {
                *slot = *b;
            }
        }
    };
    put(&mut h, 0, &name.as_bytes()[..name.len().min(100)]);
    put(&mut h, 100, b"0000644\0");
    put(&mut h, 108, b"0000000\0");
    put(&mut h, 116, b"0000000\0");
    put(&mut h, 124, format!("{:011o}\0", data.len()).as_bytes());
    put(&mut h, 136, b"00000000000\0");
    put(&mut h, 148, b"        ");
    put(&mut h, 156, &[kind]);
    put(&mut h, 157, &link.as_bytes()[..link.len().min(100)]);
    put(&mut h, 257, b"ustar\0");
    put(&mut h, 263, b"00");
    let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
    put(&mut h, 148, format!("{sum:06o}\0 ").as_bytes());
    h.extend_from_slice(data);
    while !h.len().is_multiple_of(512) {
        h.push(0);
    }
    h
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    const NAMES: &[&str] = &[
        "a",
        "dir/",
        "dir/f",
        "./x",
        "../evil",
        "/abs",
        "a/b/c",
        "b",
        "lnk",
        "dir/../../e",
        "x/./y",
        "",
        "dir//z",
    ];
    let mut out = Vec::new();
    for _ in 0..1 + rng.index(6) {
        let name = rng.pick(NAMES).unwrap_or("a");
        let m = match rng.below(5) {
            0 => {
                let n = rng.index(700);
                member(name, b'0', "", &rng.bytes(n))
            }
            1 => member(name, b'5', "", &[]),
            2 => member(
                name,
                b'2',
                rng.pick(&[".", "a/../..", "/etc", "dir"]).unwrap_or("."),
                &[],
            ),
            3 => member(
                name,
                b'1',
                rng.pick(&["a", "dir/f", "/etc/passwd"]).unwrap_or("a"),
                &[],
            ),
            _ => member(
                name,
                rng.pick(b"034567xL").unwrap_or(b'0'),
                "",
                &rng.bytes(16),
            ),
        };
        out.extend_from_slice(&m);
    }
    // The F10 chain, sometimes.
    if rng.one_in(3) {
        out.extend(member("a", b'2', ".", &[]));
        out.extend(member("b", b'2', "a/../..", &[]));
        out.extend(member("b/x", b'0', "", b"escaped"));
    }
    out.extend_from_slice(&[0u8; 1024]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(22);
        for _ in 0..100 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 32 * 512);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
