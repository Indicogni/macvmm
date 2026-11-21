//! `cargo xtask learner <init|start|hint|lifeline|status|gen-scaffold> …`: learner mode
//! (CURRICULUM §3.1, §3.4, §3.5; PLAN M27; architecture §19 item 13).
//!
//! **Why a learner workspace:** learners build their *own* VMM, chapter by chapter, in
//! `learner/`, a separate Cargo workspace with the same crate names as the reference and its own
//! git repository. The reference is the oracle the checkpoints are kept honest against, never
//! the starting point. These commands manage that workspace:
//!
//! - [`init`]: create `learner/` from `course/scaffolds/00/` (the empty template), `git init`
//!   it, build it once, print `learner: ready`;
//! - [`start`]: copy a chapter's scaffold files in, **never overwriting** a learner file (a
//!   conflicting file is written as `<file>.scaffold` and the diff printed);
//! - [`hint`]: the four-rung hint ladder of a checkpoint (conceptual, spec, pseudocode, anchor);
//! - [`lifeline`]: copy a reference module over the learner's (kept as `<file>.mine`) and
//!   record it, so checkpoints report `PASS (borrowed: …)`; `--return` restores it;
//! - [`status`]: checkpoints started, passed and borrowed, from `.progress.toml`;
//! - [`scaffold`]: `gen-scaffold NN` turns reference files into scaffold files by replacing
//!   each `LEARNER` region's body with a stub (ADR-0006 markers).
//!
//! **Safety** (PLAN M27 security checklist): every path written is relative to `learner/`,
//! made only of plain components (no `..`, not absolute) and resolved without following a
//! symlink in any component ([`safe_dest`]); learner files are never overwritten except by an
//! explicit lifeline, which keeps the original as `<file>.mine`. `.progress.toml` is local:
//! nothing in this crate talks to the network, and there is no telemetry.
#![deny(clippy::arithmetic_side_effects)]

pub mod hint;
pub mod init;
pub mod lifeline;
pub mod scaffold;
pub mod start;
pub mod status;

use crate::checkpoint::{read_capped, safe_rel, toml_lite};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The learner workspace, relative to the repository root (gitignored by the repo).
pub const LEARNER_DIR: &str = "learner";
/// The progress file inside the learner workspace.
pub const PROGRESS_FILE: &str = ".progress.toml";

/// `learner/.progress.toml`: local only, never uploaded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Progress {
    /// Chapters whose scaffold was copied (`learner start`).
    pub started: Vec<String>,
    /// Checkpoints that passed (recorded by the harness).
    pub passed: Vec<String>,
    /// Lifelines in use, e.g. `virtio::queue` (recorded by `learner lifeline`).
    pub borrowed: Vec<String>,
    /// Learner-relative files a lifeline created (no `.mine` to restore: `--return` removes them).
    pub lifeline_created: Vec<String>,
    /// The fading level each chapter was started at: `(chapter, level)`.
    pub levels: Vec<(String, String)>,
}

impl Progress {
    /// Load a progress file (capped and parsed by `toml_lite`).
    pub fn load(path: &Path) -> Result<Progress, String> {
        let text = read_capped(path, toml_lite::MAX_INPUT)?;
        let doc = toml_lite::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let list = |k: &str| -> Result<Vec<String>, String> {
            Ok(doc
                .root
                .strs(k)
                .map_err(|e| format!("{}: {e}", path.display()))?
                .unwrap_or(&[])
                .to_vec())
        };
        let mut levels = Vec::new();
        if let Some(t) = doc.tables.get("levels") {
            for (k, v) in &t.entries {
                if let toml_lite::Value::Str(s) = v {
                    levels.push((k.clone(), s.clone()));
                }
            }
        }
        Ok(Progress {
            started: list("started")?,
            passed: list("passed")?,
            borrowed: list("borrowed")?,
            lifeline_created: list("lifeline_created")?,
            levels,
        })
    }

    /// Serialize (stable order, so an unchanged progress file is byte-identical).
    pub fn render(&self) -> String {
        let q = toml_lite::quote_array;
        let mut s =
            String::from("# macvmm learner progress. Local only: never uploaded, no telemetry.\n");
        s.push_str(&format!("started = {}\n", q(&self.started)));
        s.push_str(&format!("passed = {}\n", q(&self.passed)));
        s.push_str(&format!("borrowed = {}\n", q(&self.borrowed)));
        s.push_str(&format!(
            "lifeline_created = {}\n",
            q(&self.lifeline_created)
        ));
        if !self.levels.is_empty() {
            s.push_str("\n[levels]\n");
            for (k, v) in &self.levels {
                s.push_str(&format!("{k} = {}\n", toml_lite::quote(v)));
            }
        }
        s
    }

    /// Write atomically (temporary file, then rename), only if the content changed.
    ///
    /// The temporary file is created with `create_new` and `O_NOFOLLOW`: neither a symlink
    /// planted at `.progress.toml.tmp` nor any other existing file there is ever written
    /// through (PLAN M27 checklist: no symlink escape). A stale *regular* temporary file (a
    /// crash between write and rename) is removed first; anything else there is refused.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        use std::os::unix::fs::OpenOptionsExt;
        let text = self.render();
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!(
                "{} is a symlink; refusing to write it",
                path.display()
            ));
        }
        if fs::read_to_string(path).is_ok_and(|old| old == text) {
            return Ok(());
        }
        let tmp = path.with_extension("toml.tmp");
        match fs::symlink_metadata(&tmp) {
            Ok(m) if m.file_type().is_file() => {
                fs::remove_file(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
            }
            Ok(_) => {
                return Err(format!(
                    "{} exists and is not a regular file; refusing to write through it",
                    tmp.display()
                ));
            }
            Err(_) => {}
        }
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(crate::O_NOFOLLOW)
            .open(&tmp)
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes())
            .and_then(|()| f.sync_all())
            .map_err(|e| format!("{}: {e}", tmp.display()))?;
        drop(f);
        fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Set the level of `chapter`.
    pub fn set_level(&mut self, chapter: &str, level: &str) {
        match self.levels.iter_mut().find(|(k, _)| k == chapter) {
            Some(e) => e.1 = level.to_owned(),
            None => {
                self.levels.push((chapter.to_owned(), level.to_owned()));
                self.levels.sort();
            }
        }
    }
}

/// A learner workspace: its canonical root.
#[derive(Clone, Debug)]
pub struct Workspace {
    pub root: PathBuf,
}

impl Workspace {
    /// Open an existing workspace: a real directory (not a symlink) with a progress file.
    pub fn open(dir: &Path) -> Result<Workspace, String> {
        let meta = fs::symlink_metadata(dir).map_err(|_| {
            format!(
                "{} does not exist: run scripts/learner init first",
                dir.display()
            )
        })?;
        if !meta.file_type().is_dir() {
            return Err(format!(
                "{} is not a directory (symlinks are refused)",
                dir.display()
            ));
        }
        let root = dir
            .canonicalize()
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        if !root.join(PROGRESS_FILE).is_file() {
            return Err(format!(
                "{} has no {PROGRESS_FILE}: not a learner workspace (scripts/learner init)",
                root.display()
            ));
        }
        Ok(Workspace { root })
    }

    pub fn progress_path(&self) -> PathBuf {
        self.root.join(PROGRESS_FILE)
    }

    pub fn progress(&self) -> Result<Progress, String> {
        Progress::load(&self.progress_path())
    }
}

/// Resolve `rel` inside `root` for writing: `rel` must be a plain relative path
/// ([`safe_rel`]), and no existing component may be a symlink (so nothing escapes `root`
/// through a planted link). Missing parent directories are created. Returns the full path.
pub fn safe_dest(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !safe_rel(rel) {
        return Err(format!(
            "refusing path {rel:?}: it must be relative, inside the learner workspace, with no `..`"
        ));
    }
    let comps: Vec<&str> = rel.split('/').collect();
    let mut cur = root.to_path_buf();
    for (i, c) in comps.iter().enumerate() {
        cur.push(c);
        let last = i.saturating_add(1) == comps.len();
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!(
                    "refusing {rel:?}: {} is a symlink (it could point outside the workspace)",
                    cur.display()
                ));
            }
            Ok(m) if !last && !m.file_type().is_dir() => {
                return Err(format!(
                    "refusing {rel:?}: {} is not a directory",
                    cur.display()
                ));
            }
            Ok(_) => {}
            Err(_) if !last => {
                fs::create_dir(&cur).map_err(|e| format!("mkdir {}: {e}", cur.display()))?;
            }
            Err(_) => {}
        }
    }
    Ok(cur)
}

/// Set `p`'s modification time to now. `fs::copy` (clonefile on macOS) and `fs::rename` keep a
/// file's old mtime, and cargo decides what to rebuild by mtime: a lifeline that put an *older*
/// file in place of one cargo already compiled would leave the learner's stale build in use.
pub fn touch(p: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .write(true)
        .open(p)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()))
        .map_err(|e| format!("touch {}: {e}", p.display()))
}

/// Every regular file under `dir`, as sorted `/`-separated paths relative to `dir`.
pub fn list_files(dir: &Path) -> Result<Vec<String>, String> {
    fn walk(base: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) -> Result<(), String> {
        if depth > 8 {
            return Err(format!("{}: nested too deep", dir.display()));
        }
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let ty = e.file_type().map_err(|e| e.to_string())?;
            let p = e.path();
            if ty.is_dir() {
                walk(base, &p, depth.saturating_add(1), out)?;
            } else if ty.is_file() {
                let rel = p
                    .strip_prefix(base)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(rel);
            } else {
                return Err(format!(
                    "{}: not a regular file (symlinks are refused)",
                    p.display()
                ));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if dir.is_dir() {
        walk(dir, dir, 0, &mut out)?;
    }
    Ok(out)
}

fn say(s: &str) {
    let _ = writeln!(std::io::stdout().lock(), "{s}");
}

fn warn(s: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{s}");
}

pub const USAGE: &str = "usage: cargo xtask learner init\n\
       cargo xtask learner start NN [--level worked|completion|spec|open]\n\
       cargo xtask learner hint NN [1-4]\n\
       cargo xtask learner lifeline [--return] <module>   (e.g. memory, vmm::virtio::queue)\n\
       cargo xtask learner status\n\
       cargo xtask learner gen-scaffold NN [--check]";

/// `cargo xtask learner …`; returns the process exit code.
pub fn main(repo: &Path, args: &[String]) -> u8 {
    let learner = repo.join(LEARNER_DIR);
    let Some((cmd, rest)) = args.split_first() else {
        warn(USAGE);
        return 2;
    };
    let r: Result<Vec<String>, String> = match cmd.as_str() {
        "init" if rest.is_empty() => init::init(repo, &learner).map(|m| vec![m]),
        "start" => start::main(repo, &learner, rest),
        "hint" => hint::main(repo, rest),
        "lifeline" => lifeline::main(repo, &learner, rest),
        "status" if rest.is_empty() => status::status(repo, &learner),
        "gen-scaffold" => scaffold::main(repo, rest),
        _ => {
            warn(USAGE);
            return 2;
        }
    };
    match r {
        Ok(lines) => {
            for l in lines {
                say(&l);
            }
            0
        }
        Err(e) => {
            warn(&format!("learner: {e}"));
            1
        }
    }
}
