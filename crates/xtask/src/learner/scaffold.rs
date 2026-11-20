//! `learner gen-scaffold NN [--check]`: generate a chapter's scaffold from the reference
//! (PLAN M27 design notes; ADR-0006 §4; CURRICULUM §3.4).
//!
//! **Why generated, never hand-written:** a hand-written scaffold drifts from the reference the
//! first time either is edited, and then a learner fills holes in code that no longer matches
//! the lesson. Instead the reference marks each hole in place:
//!
//! ```text
//! pub fn checked_add(self, off: u64) -> Option<GuestAddress> {
//!     // LEARNER: guest_address_checked_add
//!     self.0.checked_add(off).map(GuestAddress)
//!     // LEARNER_END: guest_address_checked_add
//! }
//! ```
//!
//! and `gen-scaffold` copies each file listed in `course/scaffolds/NN/manifest.toml` to
//! `course/scaffolds/NN/files/<same path>`, replacing the body of every `LEARNER` region with a
//! stub that still compiles: `todo!("LEARNER: <hole>")` in Rust, and in shell
//! `echo "LEARNER: <hole> is not written yet" >&2; exit 1` (the region's own `# LEARNER:` marker
//! line names the hole). The `LEARNER` marker lines are kept, so the learner sees where to
//! write; `ANCHOR` marker lines are dropped (lessons quote the reference, not the scaffold).
//!
//! **Errors:** unbalanced, nested or misnamed `LEARNER` markers (the same rules
//! `check-anchors` applies), a file type without a stub form, a manifest path that is not a
//! plain relative path, and reference files over 1 MiB.
#![deny(clippy::arithmetic_side_effects)]

use crate::anchors::{self, Syntax};
use crate::checkpoint::{read_capped, safe_rel, toml_lite, valid_id};
use std::fs;
use std::path::Path;

/// The largest reference file a scaffold copies.
pub const MAX_FILE: usize = 1024 * 1024;

/// The stub language of a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stub {
    Rust,
    Shell,
}

impl Stub {
    /// By extension: `.rs` is Rust; `.sh` and extensionless files are shell.
    pub fn for_path(path: &str) -> Option<Stub> {
        let name = path.rsplit('/').next().unwrap_or(path);
        match name.rsplit_once('.') {
            Some((_, "rs")) => Some(Stub::Rust),
            Some((_, "sh")) | None => Some(Stub::Shell),
            Some(_) => None,
        }
    }

    fn line(self, indent: &str, hole: &str) -> String {
        match self {
            Stub::Rust => format!("{indent}todo!(\"LEARNER: {hole}\")"),
            Stub::Shell => {
                format!("{indent}echo \"LEARNER: {hole} is not written yet\" >&2; exit 1")
            }
        }
    }

    fn syntax(self) -> Syntax {
        match self {
            Stub::Rust => Syntax::Slash { block: false },
            Stub::Shell => Syntax::Hash,
        }
    }
}

/// Is this line an `ANCHOR`/`ANCHOR_END` or `LEARNER`/`LEARNER_END` marker of `syntax`?
/// Returns `(is_learner, is_end, name)`.
fn marker(line: &str, stub: Stub) -> Option<(bool, bool, String)> {
    let t = line.trim();
    let inner = match stub {
        Stub::Rust => t.strip_prefix("//")?,
        Stub::Shell => t.strip_prefix('#')?,
    }
    .trim();
    for (kw, learner) in [("LEARNER", true), ("ANCHOR", false)] {
        if let Some(r) = inner.strip_prefix(kw) {
            let (end, rest) = if let Some(r) = r.strip_prefix("_END:") {
                (true, r)
            } else if let Some(r) = r.strip_prefix(':') {
                (false, r)
            } else {
                continue;
            };
            let name = rest.trim();
            if !name.is_empty() && !name.contains(char::is_whitespace) {
                return Some((learner, end, name.to_owned()));
            }
        }
    }
    None
}

/// Replace every `LEARNER` region body of `text` with a stub. `path` is for messages.
pub fn stub_file(path: &str, text: &str, stub: Stub) -> Result<String, String> {
    // The shared marker rules first: balance, nesting, names.
    let (_, problems) = anchors::scan(path, text, stub.syntax());
    if let Some(p) = problems.first() {
        return Err(p.to_string());
    }
    let mut out = String::with_capacity(text.len());
    let mut open: Option<(String, usize)> = None;
    for (i, line) in text.lines().enumerate() {
        let line_no = i.saturating_add(1);
        match marker(line, stub) {
            Some((false, _, _)) => continue, // ANCHOR lines are dropped
            Some((true, false, name)) => {
                if let Some((outer, at)) = &open {
                    return Err(format!(
                        "{path}:{line_no}: LEARNER {name:?} is nested in {outer:?} (line {at}); holes do not nest"
                    ));
                }
                if !anchors::valid_name(&name) {
                    return Err(format!("{path}:{line_no}: invalid LEARNER name {name:?}"));
                }
                out.push_str(line);
                out.push('\n');
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                out.push_str(&stub.line(&indent, &name));
                out.push('\n');
                open = Some((name, line_no));
            }
            Some((true, true, name)) => match &open {
                Some((o, _)) if *o == name => {
                    out.push_str(line);
                    out.push('\n');
                    open = None;
                }
                _ => {
                    return Err(format!(
                        "{path}:{line_no}: LEARNER_END {name:?} without its LEARNER start"
                    ));
                }
            },
            None => {
                if open.is_none() {
                    out.push_str(line);
                    out.push('\n');
                }
            }
        }
    }
    if let Some((name, at)) = open {
        return Err(format!("{path}:{at}: LEARNER {name:?} is never closed"));
    }
    if !text.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }
    Ok(out)
}

/// Count the `LEARNER` holes of a file (for reports).
pub fn holes(text: &str, stub: Stub) -> usize {
    text.lines()
        .filter(|l| matches!(marker(l, stub), Some((true, false, _))))
        .count()
}

/// The files a scaffold manifest lists.
pub fn manifest_files(repo: &Path, id: &str) -> Result<Vec<String>, String> {
    let path = repo.join("course/scaffolds").join(id).join("manifest.toml");
    let text = read_capped(&path, toml_lite::MAX_INPUT)?;
    let doc = toml_lite::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let unknown = doc.root.unknown_keys(&["chapter", "files"]);
    if !unknown.is_empty() || !doc.tables.is_empty() || !doc.arrays.is_empty() {
        return Err(format!(
            "{}: only `chapter` and `files` are allowed",
            path.display()
        ));
    }
    if doc.root.str("chapter")? != Some(id) {
        return Err(format!("{}: `chapter` must be {id:?}", path.display()));
    }
    let files = doc.root.strs("files")?.unwrap_or(&[]).to_vec();
    for f in &files {
        if !safe_rel(f) {
            return Err(format!(
                "{}: {f:?} is not a plain relative path",
                path.display()
            ));
        }
        if Stub::for_path(f).is_none() {
            return Err(format!("{f}: no stub form for this file type"));
        }
    }
    Ok(files)
}

/// Generate (or, with `check`, verify) `course/scaffolds/NN/files/`. Returns report lines.
pub fn generate(repo: &Path, id: &str, check: bool) -> Result<Vec<String>, String> {
    if !valid_id(id) || id == "00" {
        return Err(format!(
            "chapter {id:?}: 01..27 (00 is the hand-made empty template)"
        ));
    }
    let files = manifest_files(repo, id)?;
    let out_dir = repo.join("course/scaffolds").join(id).join("files");
    let mut stale = Vec::new();
    let mut total_holes = 0usize;
    for rel in &files {
        let stub = Stub::for_path(rel).ok_or("unreachable")?;
        let text = read_capped(&repo.join(rel), MAX_FILE)?;
        total_holes = total_holes.saturating_add(holes(&text, stub));
        let generated = stub_file(rel, &text, stub)?;
        let dst = out_dir.join(rel);
        if check {
            if fs::read_to_string(&dst).ok().as_deref() != Some(generated.as_str()) {
                stale.push(rel.clone());
            }
        } else {
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            fs::write(&dst, generated).map_err(|e| format!("{}: {e}", dst.display()))?;
        }
    }
    if check {
        if stale.is_empty() {
            Ok(vec![format!(
                "SCAFFOLD OK: {id}: {} files, {total_holes} holes, current",
                files.len()
            )])
        } else {
            Err(format!(
                "scaffold {id} is stale ({}); run cargo xtask learner gen-scaffold {id}",
                stale.join(", ")
            ))
        }
    } else {
        Ok(vec![format!(
            "SCAFFOLD: {id}: wrote {} files with {total_holes} holes to course/scaffolds/{id}/files",
            files.len()
        )])
    }
}

/// `learner gen-scaffold NN [--check]`.
pub fn main(repo: &Path, args: &[String]) -> Result<Vec<String>, String> {
    match args {
        [id] => generate(repo, id, false),
        [id, c] if c == "--check" => generate(repo, id, true),
        _ => Err("usage: learner gen-scaffold NN [--check]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(Stub::for_path("a/b.rs"), Some(Stub::Rust));
        assert_eq!(Stub::for_path("scripts/learner"), Some(Stub::Shell));
        assert_eq!(Stub::for_path("x.sh"), Some(Stub::Shell));
        assert_eq!(Stub::for_path("x.md"), None);
    }
}
