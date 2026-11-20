//! `learner lifeline [--return] <module>`: borrow a reference module (CURRICULUM §3.5,
//! architecture §19 item 13, decision D10).
//!
//! **Why copy and not re-export:** a re-exported reference item (`pub use macvmm_ref::…`) is typed
//! against the reference's own `GuestMemory` or `IrqLine`, not the learner's frozen-contract
//! types, so it would not compile in the learner's crate. Copying the reference *source file*
//! into the learner's tree compiles against the learner's types as long as they follow the
//! frozen contracts (architecture §6). The learner's version is kept as `<file>.mine`, the
//! borrow is recorded in `.progress.toml` (`borrowed = ["virtio::queue"]`), and every
//! checkpoint then reports `CHECKPOINT NN PASS (borrowed: virtio::queue)` until
//! `lifeline --return` restores the learner's file byte for byte.
//!
//! **Module names:** `[vmm::|hvf::|macvmm::]seg(::seg)*`, each segment `[a-z_][a-z0-9_]*`;
//! `vmm::` is the default crate and is dropped from the recorded name. A module is either one
//! file (`crates/vmm/src/virtio/queue.rs`) or a directory module, in which case every `.rs`
//! file under it is borrowed (`memory` = `crates/vmm/src/memory/*.rs`). Anything else, such as
//! `../../etc/x`, is refused before a path is built, and every destination goes through
//! [`safe_dest`] (no symlink anywhere on the way).
#![deny(clippy::arithmetic_side_effects)]

use super::{Workspace, list_files, safe_dest, touch};
use std::fs;
use std::path::Path;

/// A parsed module name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Module {
    pub krate: String,
    pub segments: Vec<String>,
}

impl Module {
    /// The name recorded in `.progress.toml` and printed by the checkpoints.
    pub fn label(&self) -> String {
        let path = self.segments.join("::");
        if self.krate == "vmm" {
            path
        } else {
            format!("{}::{path}", self.krate)
        }
    }

    /// The module's base path relative to a workspace root, without extension.
    fn base(&self) -> String {
        format!("crates/{}/src/{}", self.krate, self.segments.join("/"))
    }
}

fn valid_segment(s: &str) -> bool {
    let mut b = s.bytes();
    b.next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == b'_')
        && b.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        && s.len() <= 64
}

/// Parse `memory`, `vmm::virtio::queue`, `hvf::vcpu`.
pub fn parse_module(s: &str) -> Result<Module, String> {
    let mut segs: Vec<&str> = s.split("::").collect();
    let krate = match segs.first() {
        Some(&c @ ("vmm" | "hvf" | "macvmm")) if segs.len() > 1 => {
            segs.remove(0);
            c
        }
        _ => "vmm",
    };
    if segs.is_empty() || segs.len() > 6 || !segs.iter().all(|x| valid_segment(x)) {
        return Err(format!(
            "refusing module {s:?}: want a Rust module path such as `memory` or `vmm::virtio::queue`"
        ));
    }
    Ok(Module {
        krate: krate.to_owned(),
        segments: segs.into_iter().map(str::to_owned).collect(),
    })
}

/// The reference files of a module, relative to the repository (= workspace) root.
pub fn module_files(repo: &Path, m: &Module) -> Result<Vec<String>, String> {
    let base = m.base();
    let file = format!("{base}.rs");
    if repo.join(&file).is_file() {
        return Ok(vec![file]);
    }
    let dir = repo.join(&base);
    if dir.is_dir() {
        let files: Vec<String> = list_files(&dir)?
            .into_iter()
            .filter(|f| f.ends_with(".rs"))
            .map(|f| format!("{base}/{f}"))
            .collect();
        if !files.is_empty() {
            return Ok(files);
        }
    }
    Err(format!(
        "the reference has no module {} (looked for {file} and {base}/)",
        m.label()
    ))
}

// ANCHOR: lifeline_copy
/// Borrow `module`: for each reference file, keep the learner's as `<file>.mine`, then copy the
/// reference file in. Every destination is checked before any file is changed, so a refusal
/// leaves the learner's files untouched (at most a missing parent directory was created).
pub fn borrow(repo: &Path, learner: &Path, module: &str) -> Result<Vec<String>, String> {
    let ws = Workspace::open(learner)?;
    let m = parse_module(module)?;
    let label = m.label();
    let mut p = ws.progress()?;
    if p.borrowed.contains(&label) {
        return Err(format!(
            "{label} is already borrowed (lifeline --return {label})"
        ));
    }
    let files = module_files(repo, &m)?;
    let mut plan = Vec::new();
    for rel in &files {
        let dst = safe_dest(&ws.root, rel)?;
        let mine = safe_dest(&ws.root, &format!("{rel}.mine"))?;
        if fs::symlink_metadata(&mine).is_ok() {
            return Err(format!("{rel}.mine already exists; nothing changed"));
        }
        let exists = match fs::symlink_metadata(&dst) {
            Ok(md) if md.file_type().is_file() => true,
            Ok(_) => return Err(format!("{rel} is not a regular file; nothing changed")),
            Err(_) => false,
        };
        plan.push((rel, dst, mine, exists));
    }
    for (rel, dst, mine, exists) in plan {
        if exists {
            fs::rename(&dst, &mine).map_err(|e| format!("keep {rel} as .mine: {e}"))?;
        } else {
            p.lifeline_created.push(rel.clone());
        }
        fs::copy(repo.join(rel), &dst).map_err(|e| format!("copy {rel}: {e}"))?;
        touch(&dst)?; // so cargo rebuilds (see `touch`)
    }
    p.borrowed.push(label.clone());
    p.save(&ws.progress_path())?;
    Ok(vec![
        format!(
            "learner: lifeline {label}: copied {} reference file(s); yours are kept as <file>.mine",
            files.len()
        ),
        format!(
            "learner: checkpoints now report (borrowed: {label}); give it back with scripts/learner lifeline --return {label}"
        ),
    ])
}
// ANCHOR_END: lifeline_copy

/// Give `module` back: restore each `<file>.mine`, remove files the lifeline created.
pub fn give_back(repo: &Path, learner: &Path, module: &str) -> Result<Vec<String>, String> {
    let ws = Workspace::open(learner)?;
    let m = parse_module(module)?;
    let label = m.label();
    let mut p = ws.progress()?;
    if !p.borrowed.contains(&label) {
        return Err(format!("{label} is not borrowed"));
    }
    let files = module_files(repo, &m)?;
    let mut restored = 0usize;
    for rel in &files {
        let dst = safe_dest(&ws.root, rel)?;
        let mine = safe_dest(&ws.root, &format!("{rel}.mine"))?;
        if fs::symlink_metadata(&mine).is_ok_and(|md| md.file_type().is_file()) {
            fs::rename(&mine, &dst).map_err(|e| format!("restore {rel}: {e}"))?;
            touch(&dst)?;
            restored = restored.saturating_add(1);
        } else if let Some(i) = p.lifeline_created.iter().position(|c| c == rel) {
            p.lifeline_created.remove(i);
            if fs::symlink_metadata(&dst).is_ok_and(|md| md.file_type().is_file()) {
                fs::remove_file(&dst).map_err(|e| format!("remove {rel}: {e}"))?;
            }
        }
    }
    p.borrowed.retain(|b| b != &label);
    p.save(&ws.progress_path())?;
    Ok(vec![format!(
        "learner: returned {label}: restored {restored} file(s) of yours"
    )])
}

/// `learner lifeline [--return] <module>`.
pub fn main(repo: &Path, learner: &Path, args: &[String]) -> Result<Vec<String>, String> {
    match args {
        [m] if !m.starts_with('-') => borrow(repo, learner, m),
        [flag, m] if flag == "--return" => give_back(repo, learner, m),
        _ => Err("usage: learner lifeline [--return] <module>".into()),
    }
}
