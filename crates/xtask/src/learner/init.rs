//! `learner init`: create `learner/` from `course/scaffolds/00/` (CURRICULUM §3.1).
//!
//! **Why a template and its own git repository:** the learner's VMM is theirs. It starts as an
//! empty Cargo workspace with the reference's crate names and lints (`forbid(unsafe_code)`
//! outside `crates/hvf` and `memory/host.rs`), the one-key entitlements plist and the signing
//! runner, so `cargo run` works from the first chapter; and it is a separate git repository
//! (the repo's `.gitignore` excludes `/learner`), so the learner's history is their own and a
//! `git pull` of the course never touches it.
//!
//! It refuses to run if `learner/` exists in any form (directory, file or symlink): it never
//! overwrites.
#![deny(clippy::arithmetic_side_effects)]

use super::{PROGRESS_FILE, Progress, list_files, safe_dest};
use std::fs;
use std::path::Path;
use std::process::Command;

/// Where the empty-workspace template lives.
pub const TEMPLATE_DIR: &str = "course/scaffolds/00";

/// Copy the template, write the progress file, `git init`, build once.
pub fn init(repo: &Path, learner: &Path) -> Result<String, String> {
    init_with(repo, learner, true)
}

/// [`init`], optionally without the build (host tests).
pub fn init_with(repo: &Path, learner: &Path, build: bool) -> Result<String, String> {
    if fs::symlink_metadata(learner).is_ok() {
        return Err(format!(
            "{} already exists; nothing changed (remove it yourself to start over)",
            learner.display()
        ));
    }
    let template = repo.join(TEMPLATE_DIR);
    let files = list_files(&template)?;
    if !files.iter().any(|f| f == "Cargo.toml") {
        return Err(format!("{} has no Cargo.toml", template.display()));
    }
    fs::create_dir(learner).map_err(|e| format!("mkdir {}: {e}", learner.display()))?;
    let root = learner
        .canonicalize()
        .map_err(|e| format!("{}: {e}", learner.display()))?;
    for rel in &files {
        let dst = safe_dest(&root, rel)?;
        fs::copy(template.join(rel), &dst).map_err(|e| format!("copy {rel}: {e}"))?;
    }
    let progress = Progress {
        started: vec!["00".into()],
        ..Progress::default()
    };
    progress.save(&root.join(PROGRESS_FILE))?;
    let git = Command::new("git")
        .current_dir(&root)
        .args(["init", "--quiet"])
        .status()
        .map_err(|e| format!("git init: {e}"))?;
    if !git.success() {
        return Err("git init failed".into());
    }
    if build {
        let o = Command::new("cargo")
            .current_dir(&root)
            .args(["build", "--quiet", "--offline"])
            .output()
            .map_err(|e| format!("cargo build: {e}"))?;
        if !o.status.success() {
            return Err(format!(
                "the template did not build (a course bug: please report it):\n{}",
                String::from_utf8_lossy(&o.stderr)
            ));
        }
    }
    Ok("learner: ready".into())
}
