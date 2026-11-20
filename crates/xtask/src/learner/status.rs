//! `learner status`: where the learner is (CURRICULUM §3.1).
//!
//! **Why from `.progress.toml`:** the harness records each checkpoint that passed, `start`
//! records each chapter begun and its level, and `lifeline` records each borrowed module; this
//! command only reads that local file and the checkpoint list. Borrowed modules are shown
//! prominently, because a checkpoint passed with a lifeline is not yet the learner's own.
#![deny(clippy::arithmetic_side_effects)]

use super::Workspace;
use crate::checkpoint;
use std::path::Path;

/// The status lines.
pub fn status(repo: &Path, learner: &Path) -> Result<Vec<String>, String> {
    let ws = Workspace::open(learner)?;
    let p = ws.progress()?;
    let mut out = vec![format!("learner: {}", ws.root.display())];
    let ids = checkpoint::all_ids(repo);
    for id in &ids {
        let slug = checkpoint::load(repo, id)
            .map(|c| c.slug)
            .unwrap_or_default();
        let level = p
            .levels
            .iter()
            .find(|(k, _)| k == id)
            .map(|(_, v)| format!(" ({v})"))
            .unwrap_or_default();
        let state = if p.passed.contains(id) {
            format!("passed{level}")
        } else if p.started.contains(id) {
            format!("started{level}")
        } else {
            "-".into()
        };
        out.push(format!("  {id} {slug:<20} {state}"));
    }
    out.push(format!(
        "learner: {}/{} checkpoints passed",
        ids.iter().filter(|i| p.passed.contains(i)).count(),
        ids.len()
    ));
    if !p.borrowed.is_empty() {
        out.push(format!(
            "learner: borrowed (lifelines): {}; give one back with scripts/learner lifeline --return <module>",
            p.borrowed.join(", ")
        ));
    }
    Ok(out)
}
