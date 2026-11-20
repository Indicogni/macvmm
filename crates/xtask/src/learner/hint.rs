//! `learner hint NN [1-4]`: the hint ladder (CURRICULUM §3.1, §3.5).
//!
//! **Why a ladder:** a stuck learner needs the smallest push that unblocks them, so the hints
//! escalate one rung at a time: 1 conceptual, 2 the spec section, 3 pseudocode, 4 the reference
//! anchor to read. Asking for rung `n` prints rungs 1..=n, so the context is never lost. The
//! hints live in the checkpoint's `[hints]` table, next to the tests they unblock.
#![deny(clippy::arithmetic_side_effects)]

use std::path::Path;

/// The rung names, in order.
pub const RUNGS: [&str; 4] = ["conceptual", "spec", "pseudocode", "anchor"];

/// Hints 1..=`upto` of checkpoint `id`.
pub fn hints(repo: &Path, id: &str, upto: usize) -> Result<Vec<String>, String> {
    if !(1..=4).contains(&upto) {
        return Err("the hint level is 1 to 4".into());
    }
    let cp = crate::checkpoint::load(repo, id)?;
    let mut out = Vec::new();
    for (i, (rung, text)) in RUNGS.iter().zip(cp.hints.iter()).enumerate().take(upto) {
        if text.is_empty() {
            continue;
        }
        out.push(format!("hint {} ({rung}): {text}", i.saturating_add(1)));
    }
    if out.is_empty() {
        out.push(format!("learner: checkpoint {id} has no hints yet"));
    } else if upto < 4 {
        out.push(format!(
            "(next rung: scripts/learner hint {id} {})",
            upto.saturating_add(1)
        ));
    }
    Ok(out)
}

/// `learner hint NN [level]`.
pub fn main(repo: &Path, args: &[String]) -> Result<Vec<String>, String> {
    match args {
        [id] => hints(repo, id, 1),
        [id, n] => hints(
            repo,
            id,
            n.parse()
                .map_err(|_| format!("hint level {n:?} is not 1-4"))?,
        ),
        _ => Err("usage: learner hint NN [1-4]".into()),
    }
}
