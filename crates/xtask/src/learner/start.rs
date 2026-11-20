//! `learner start NN [--level …]`: copy a chapter's scaffold into `learner/` (CURRICULUM §3.1,
//! §3.4).
//!
//! **Why "never overwrite":** a learner's file is their work. If a scaffold file already exists
//! with other content (for example a later chapter wants to add `pub mod memory;` to a `lib.rs`
//! the learner already edited), the scaffold's version is written next to it as
//! `<file>.scaffold` and the difference is printed; merging is the learner's decision. Running
//! `start` twice changes nothing and says so (`learner: 0 files copied, N already present`).
//!
//! **Levels** (the fading schedule, §3.4): `worked` (00–05), `completion` (06–12), `spec`
//! (13–20) and `open` (21–27) are the defaults. The level is recorded in `.progress.toml`; at
//! `open` only the journal is copied (the learner writes from the design brief), at every other
//! level the generated scaffold files are copied too.
#![deny(clippy::arithmetic_side_effects)]

use super::{Workspace, list_files, safe_dest};
use crate::checkpoint::valid_id;
use std::fs;
use std::path::Path;
use std::process::Command;

/// The levels of the fading schedule.
pub const LEVELS: [&str; 4] = ["worked", "completion", "spec", "open"];

/// The default level of a chapter (CURRICULUM §3.4).
pub fn default_level(id: &str) -> &'static str {
    match id.parse::<u8>().unwrap_or(0) {
        0..=5 => "worked",
        6..=12 => "completion",
        13..=20 => "spec",
        _ => "open",
    }
}

/// What happened to one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Placed {
    Copied,
    Present,
    /// Written as `<file>.scaffold`; the unified diff (if `diff(1)` ran).
    Conflict(String),
}

/// Copy `src` to `root/rel` unless something is there (PLAN M27: never overwrite).
pub fn place(root: &Path, rel: &str, src: &Path) -> Result<Placed, String> {
    let new = fs::read(src).map_err(|e| format!("{}: {e}", src.display()))?;
    let dst = safe_dest(root, rel)?;
    match fs::symlink_metadata(&dst) {
        Err(_) => {
            fs::write(&dst, &new).map_err(|e| format!("{}: {e}", dst.display()))?;
            Ok(Placed::Copied)
        }
        Ok(m) if !m.file_type().is_file() => Err(format!(
            "{rel}: exists and is not a regular file; nothing written"
        )),
        Ok(_) => {
            let old = fs::read(&dst).map_err(|e| format!("{}: {e}", dst.display()))?;
            if old == new {
                return Ok(Placed::Present);
            }
            let side_rel = format!("{rel}.scaffold");
            let side = safe_dest(root, &side_rel)?;
            if fs::read(&side).is_ok_and(|s| s == new) {
                return Ok(Placed::Present); // already offered, unchanged
            }
            if fs::symlink_metadata(&side).is_ok_and(|m| !m.file_type().is_file()) {
                return Err(format!("{side_rel}: exists and is not a regular file"));
            }
            fs::write(&side, &new).map_err(|e| format!("{}: {e}", side.display()))?;
            let diff = Command::new("diff")
                .args(["-u", "--"])
                .arg(&dst)
                .arg(&side)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default();
            Ok(Placed::Conflict(diff))
        }
    }
}

/// The result of a `start`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartReport {
    pub copied: usize,
    pub present: usize,
    /// `(learner-relative path, diff)` of each conflict.
    pub conflicts: Vec<(String, String)>,
}

/// Copy chapter `id`'s scaffold (and journal template) into the workspace at `learner`.
pub fn start(repo: &Path, learner: &Path, id: &str, level: &str) -> Result<StartReport, String> {
    if !valid_id(id) {
        return Err(format!("chapter {id:?} must be two digits 00..27"));
    }
    if !LEVELS.contains(&level) {
        return Err(format!(
            "level {level:?} must be one of {}",
            LEVELS.join(", ")
        ));
    }
    let ws = Workspace::open(learner)?;
    let mut items: Vec<(String, std::path::PathBuf)> = Vec::new();
    if level != "open" && id != "00" {
        let files = repo.join("course/scaffolds").join(id).join("files");
        for rel in list_files(&files)? {
            items.push((rel.clone(), files.join(&rel)));
        }
    }
    let journal = repo.join("course/journal").join(format!("{id}.md"));
    if journal.is_file() {
        items.push((format!("journal/{id}.md"), journal));
    }
    let mut rep = StartReport::default();
    for (rel, src) in &items {
        match place(&ws.root, rel, src)? {
            Placed::Copied => rep.copied = rep.copied.saturating_add(1),
            Placed::Present => rep.present = rep.present.saturating_add(1),
            Placed::Conflict(d) => rep.conflicts.push((rel.clone(), d)),
        }
    }
    let mut p = ws.progress()?;
    if !p.started.iter().any(|s| s == id) {
        p.started.push(id.to_owned());
        p.started.sort();
    }
    p.set_level(id, level);
    p.save(&ws.progress_path())?;
    Ok(rep)
}

/// `learner start NN [--level L]`.
pub fn main(repo: &Path, learner: &Path, args: &[String]) -> Result<Vec<String>, String> {
    let mut id = None;
    let mut level = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--level" => level = Some(it.next().ok_or("--level needs a value")?.clone()),
            s if !s.starts_with('-') && id.is_none() => id = Some(s.to_owned()),
            other => return Err(format!("unexpected argument {other:?}")),
        }
    }
    let id = id.ok_or("which chapter? (learner start NN)")?;
    let level = level.unwrap_or_else(|| default_level(&id).to_owned());
    let rep = start(repo, learner, &id, &level)?;
    let mut out = Vec::new();
    for (rel, diff) in &rep.conflicts {
        out.push(format!(
            "learner: {rel} exists and differs: the scaffold's version is {rel}.scaffold; merge it yourself"
        ));
        if !diff.is_empty() {
            out.push(diff.trim_end().to_owned());
        }
    }
    let mut line = format!(
        "learner: {} files copied, {} already present",
        rep.copied, rep.present
    );
    if !rep.conflicts.is_empty() {
        line.push_str(&format!(
            ", {} written as <file>.scaffold (diff above)",
            rep.conflicts.len()
        ));
    }
    out.push(line);
    out.push(format!("learner: chapter {id} at level {level}"));
    Ok(out)
}
