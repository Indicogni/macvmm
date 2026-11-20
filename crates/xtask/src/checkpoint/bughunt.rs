//! `cargo xtask bughunt <part> [--patch NAME] [--keep]`: an interleaved bug hunt (CURRICULUM
//! §6.4, PLAN M27).
//!
//! **Why:** finding a bug you did not plant is a different skill from writing code that passes.
//! A bug hunt copies the reference implementation into a fresh directory under `$TMPDIR`,
//! applies one planted fault from `course/bughunts/<part>/` (chosen at random unless `--patch`
//! names one), runs the matching checkpoint against the copy, and prints **only the failing
//! symptom**: the `[FAIL]` lines, their detail and the verdict. The patch's name and contents
//! are never printed; that is the puzzle.
//!
//! **Safety** (PLAN M27 security checklist; SC-1 temp-dir rules): the working tree is never
//! touched. The copy is a new directory created with `create_dir` (it must not exist) and mode
//! 0700 inside `$TMPDIR`; it receives regular files only (never symlinks), listed by
//! `git ls-files` so ignored build output and the learner's tree are not copied; the patch is
//! applied there with `git apply`, which refuses paths outside the tree; the copy is removed
//! afterwards unless `--keep`. Build output goes to the repository's ignored target dir.
//!
//! **Patch naming:** `NN-<slug>.patch`, where `NN` is the checkpoint that must catch the fault.
#![deny(clippy::arithmetic_side_effects)]

use super::report::{self, Out};
use super::{Options, Target, run};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the planted faults live.
pub const BUGHUNTS_DIR: &str = "course/bughunts";

/// The top-level paths of the reference that make up an implementation tree.
const IMPL_PATHS: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "clippy.toml",
    "entitlements.plist",
    ".cargo/",
    "crates/",
    "scripts/",
];

/// A part name: lowercase roman numerals (`iii`, `vii`).
pub fn valid_part(p: &str) -> bool {
    !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| matches!(b, b'i' | b'v' | b'x'))
}

/// The planted patches of a part, sorted: `(file name, checkpoint id)`.
pub fn patches(repo: &Path, part: &str) -> Result<Vec<(String, String)>, String> {
    if !valid_part(part) {
        return Err(format!("part {part:?} must be a roman numeral such as iii"));
    }
    let dir = repo.join(BUGHUNTS_DIR).join(part);
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Err(format!(
            "part {part} has no planted faults yet ({BUGHUNTS_DIR}/{part}/ does not exist)"
        ));
    }
    let entries = fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for e in entries.filter_map(Result::ok) {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(base) = name.strip_suffix(".patch") else {
            continue;
        };
        let id = base.get(..2).unwrap_or("");
        if !super::valid_id(id) || base.as_bytes().get(2) != Some(&b'-') {
            return Err(format!("{name}: planted patches are named NN-<slug>.patch"));
        }
        if !e.file_type().is_ok_and(|t| t.is_file()) {
            return Err(format!("{name}: not a regular file"));
        }
        out.push((name.clone(), id.to_owned()));
    }
    out.sort();
    if out.is_empty() {
        return Err(format!("no planted faults in {}", dir.display()));
    }
    Ok(out)
}

/// The reference's tracked and untracked-but-not-ignored files under [`IMPL_PATHS`].
fn impl_files(repo: &Path) -> Result<Vec<String>, String> {
    let o = Command::new("git")
        .current_dir(repo)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
        ])
        .args(IMPL_PATHS)
        .output()
        .map_err(|e| format!("git ls-files: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "git ls-files failed: {}",
            String::from_utf8_lossy(&o.stderr)
        ));
    }
    let mut v: Vec<String> = o
        .stdout
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    v.sort();
    v.dedup();
    Ok(v)
}

/// Copy the reference's implementation files into `dst` (regular files only).
pub fn copy_reference(repo: &Path, dst: &Path) -> Result<usize, String> {
    let files = impl_files(repo)?;
    let mut n = 0usize;
    for rel in files {
        if !super::safe_rel(&rel) {
            continue; // a name the harness would not create itself
        }
        let src = repo.join(&rel);
        let meta = match fs::symlink_metadata(&src) {
            Ok(m) => m,
            Err(_) => continue, // listed but deleted in the working tree
        };
        if !meta.file_type().is_file() {
            continue;
        }
        let to = dst.join(&rel);
        if let Some(parent) = to.parent() {
            run::mkdir_private(parent)?;
        }
        fs::copy(&src, &to).map_err(|e| format!("copy {rel}: {e}"))?;
        n = n.saturating_add(1);
    }
    Ok(n)
}

/// A pseudo-random index below `n` from the clock (a bug hunt needs variety, not secrecy).
fn pick(n: usize) -> usize {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let x = run::fnv1a(&nanos.to_le_bytes());
    let n64 = u64::try_from(n.max(1)).unwrap_or(1);
    usize::try_from(x.checked_rem(n64).unwrap_or(0)).unwrap_or(0)
}

/// Lines of a checkpoint report that describe the symptom (never the cause).
pub fn symptom_lines(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fail = false;
    for l in lines {
        if l.starts_with("[FAIL]") {
            in_fail = true;
            out.push(l.clone());
        } else if l.starts_with("CHECKPOINT ") {
            in_fail = false;
            out.push(l.clone());
        } else if l.starts_with('[') || l.starts_with("checkpoint: implementation") {
            in_fail = false;
        } else if in_fail {
            out.push(l.clone());
        }
    }
    out
}

/// `cargo xtask bughunt …`; returns the exit code (0: the checkpoint caught the fault).
pub fn main(repo: &Path, args: &[String]) -> u8 {
    let mut part = None;
    let mut named = None;
    let mut keep = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--patch" => named = it.next().cloned(),
            "--keep" => keep = true,
            s if !s.starts_with('-') && part.is_none() => part = Some(s.to_owned()),
            other => {
                report::err(&format!(
                    "bughunt: unexpected argument {other:?}\nusage: cargo xtask bughunt <part> [--patch NAME] [--keep]"
                ));
                return 2;
            }
        }
    }
    let Some(part) = part else {
        report::err("usage: cargo xtask bughunt <part> [--patch NAME] [--keep]");
        return 2;
    };
    let list = match patches(repo, &part) {
        Ok(l) => l,
        Err(e) => {
            report::err(&format!("bughunt: {e}"));
            return 2;
        }
    };
    let chosen = match &named {
        Some(n) => match list.iter().find(|(f, _)| f == n) {
            Some(c) => c.clone(),
            None => {
                report::err(&format!("bughunt: no patch {n:?} in part {part}"));
                return 2;
            }
        },
        None => list
            .get(pick(list.len()))
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new())),
    };
    let (file, id) = chosen;
    let tmp = std::env::temp_dir();
    let work: PathBuf = tmp.join(format!(
        "macvmm-bughunt-{}-{:x}",
        std::process::id(),
        run::fnv1a(file.as_bytes())
            ^ u64::from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.subsec_nanos())
                    .unwrap_or(0)
            )
    ));
    // `create_dir`, not `create_dir_all`: the directory must be new (no reuse, no symlink).
    if let Err(e) =
        std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700).create(&work)
    {
        report::err(&format!("bughunt: cannot create {}: {e}", work.display()));
        return 2;
    }
    let result = hunt(repo, &part, &file, &id, &work);
    // The copy's build output (keyed by its path, `run::Env::new`) is useless after the hunt:
    // a new hunt is a new directory. Remove it so hunts do not pile up gigabytes in target/.
    if !keep && let Ok(canon) = work.canonicalize() {
        let key = format!("{:016x}", run::fnv1a(canon.as_os_str().as_encoded_bytes()));
        let ck = run::repo_target(repo).join("checkpoint");
        for d in [ck.join("build").join(&key), ck.join("l1").join(&key)] {
            if d.starts_with(&ck) && d.is_dir() {
                let _ = fs::remove_dir_all(&d);
            }
        }
    }
    if keep {
        report::err(&format!(
            "bughunt: kept the patched copy at {}",
            work.display()
        ));
    } else if work.starts_with(&tmp) {
        let _ = fs::remove_dir_all(&work);
    }
    match result {
        Ok(code) => code,
        Err(e) => {
            report::err(&format!("bughunt: {e}"));
            2
        }
    }
}

fn hunt(repo: &Path, part: &str, file: &str, id: &str, work: &Path) -> Result<u8, String> {
    let n = copy_reference(repo, work)?;
    let patch = repo.join(BUGHUNTS_DIR).join(part).join(file);
    let o = Command::new("git")
        .current_dir(work)
        .args(["apply", "--whitespace=nowarn"])
        .arg(&patch)
        .output()
        .map_err(|e| format!("git apply: {e}"))?;
    if !o.status.success() {
        return Err(format!(
            "a planted fault of part {part} no longer applies to the reference (authors: refresh it)\n{}",
            String::from_utf8_lossy(&o.stderr)
        ));
    }
    let mut out = Out::stdout();
    out.line(&format!(
        "bughunt: part {part}: a fault is planted in a copy of the reference ({n} files); running checkpoint {id}"
    ));
    let opts = Options {
        ids: vec![id.to_owned()],
        target: Some(Target::Impl(work.to_path_buf())),
        keep: false,
        capture: false,
    };
    let mut buf = Out::collect();
    let code = run::run_all_to(repo, &opts, &mut buf);
    let lines = buf.buf.unwrap_or_default();
    for l in symptom_lines(&lines) {
        out.line(&l);
    }
    if code == 0 {
        out.line(&format!(
            "bughunt: checkpoint {id} PASSED with the fault planted: the checkpoint misses it (authors: strengthen it)"
        ));
        Ok(1)
    } else {
        out.line(&format!(
            "bughunt: checkpoint {id} fails. Find the bug from the symptom above: re-run with --keep to get the copy, then use the dump, the trace and the tests."
        ));
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_and_symptoms() {
        assert!(valid_part("iii") && valid_part("vii") && !valid_part("../x") && !valid_part(""));
        let lines: Vec<String> = [
            "checkpoint: implementation /tmp/x",
            "[PASS] contract tests   a (3 tests)",
            "[FAIL] runs on your Mac probe: exit 5 (want 0)",
            "    last 20 trace records:",
            "[INFO] journal          not checked",
            "CHECKPOINT 07 FAIL",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        assert_eq!(
            symptom_lines(&lines),
            [
                "[FAIL] runs on your Mac probe: exit 5 (want 0)",
                "    last 20 trace records:",
                "CHECKPOINT 07 FAIL"
            ]
        );
    }
}
