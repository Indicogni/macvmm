//! The marker rules of PLAN §0.3, shared by the checkpoint harness and the e2e suite
//! (architecture §17, §19 item 14; decision D9).
//!
//! **Why markers and not regular expressions:** a learner reads an expectation file to find out
//! what their VMM must print. One line per marker, matched in order as substrings, is readable
//! without knowing a regex dialect, and the harness needs no regex engine (CLAUDE.md: minimal
//! dependencies). The rules:
//!
//! - each non-empty line of a marker file is one marker;
//! - markers on one stream must appear **in order**, as substrings;
//! - `*` matches any run of characters except a newline;
//! - a line prefixed `[stderr] ` matches stderr, every other line stdout (the serial output);
//! - a line starting `!` must appear nowhere (`!` alone: on neither stream; `![stderr] `: not on
//!   stderr).
//!
//! The e2e harness (`crates/macvmm/tests/support/mod.rs`) implements the same rules for its own
//! test crate; `crates/xtask/tests/data/markers_fixtures.txt` is the fixture table both
//! implementations are tested against (`crates/xtask/tests/checkpoint.rs` and
//! `crates/macvmm/tests/markers_shared.rs`), so they cannot drift apart.
#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

// ANCHOR: marker_match
/// Where `pat` (with `*` = any run of non-newline characters) first matches in `hay` at or
/// after byte `from`; returns the byte just past the match.
///
/// The search tries each occurrence of the first literal piece in turn; after it, each later
/// piece takes its earliest occurrence on the same line, which is always the best choice for
/// what follows (a `*` never crosses a newline).
pub fn find_wild(hay: &str, pat: &str, from: usize) -> Option<usize> {
    let mut parts = pat.split('*');
    let first = parts.next().unwrap_or("");
    let rest: Vec<&str> = parts.collect();
    let mut start = next_boundary(hay, from);
    while start <= hay.len() {
        let at = start.checked_add(hay.get(start..)?.find(first)?)?;
        let mut pos = at.checked_add(first.len())?;
        let mut ok = true;
        for part in &rest {
            let tail = hay.get(pos..)?;
            match tail.find(part) {
                Some(i) if !tail.get(..i)?.contains('\n') => {
                    pos = pos.checked_add(i)?.checked_add(part.len())?;
                }
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            return Some(pos);
        }
        start = next_boundary(hay, at.checked_add(first.len().max(1))?);
    }
    None
}
// ANCHOR_END: marker_match

fn next_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i = i.saturating_add(1);
    }
    i
}

/// What a marker file asked for and what matched.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// Positive markers (stdout and stderr) in the file.
    pub total: usize,
    /// How many of them matched, in order, before the first failure.
    pub matched: usize,
    /// Negative (`!`) markers checked.
    pub negatives: usize,
}

/// The first marker that did not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// 1-based line of the marker in its file.
    pub line: usize,
    /// The marker line as written.
    pub marker: String,
    /// Why it failed, in the e2e harness's words.
    pub why: String,
    pub tally: Tally,
}

/// One parsed marker line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Marker<'a> {
    Stdout(&'a str),
    Stderr(&'a str),
    /// Must not appear on stdout or stderr.
    Nowhere(&'a str),
    /// Must not appear on stderr.
    NotStderr(&'a str),
}

/// Parse a marker file into `(line number, marker)` pairs, skipping empty lines.
pub fn parse(spec: &str) -> Vec<(usize, Marker<'_>)> {
    spec.lines()
        .enumerate()
        .map(|(i, l)| (i.saturating_add(1), l.trim_end()))
        .filter(|(_, l)| !l.is_empty())
        .map(|(n, l)| {
            let m = if let Some(neg) = l.strip_prefix('!') {
                match neg.strip_prefix("[stderr] ") {
                    Some(p) => Marker::NotStderr(p),
                    None => Marker::Nowhere(neg),
                }
            } else if let Some(p) = l.strip_prefix("[stderr] ") {
                Marker::Stderr(p)
            } else {
                Marker::Stdout(l)
            };
            (n, m)
        })
        .collect()
}

/// Check a marker file against a run's output (PLAN §0.3). For a trace marker file, pass the
/// trace as `stdout` and `""` as `stderr`.
pub fn check(spec: &str, stdout: &str, stderr: &str) -> Result<Tally, Mismatch> {
    let markers = parse(spec);
    let mut tally = Tally {
        total: markers
            .iter()
            .filter(|(_, m)| matches!(m, Marker::Stdout(_) | Marker::Stderr(_)))
            .count(),
        ..Tally::default()
    };
    let (mut out_pos, mut err_pos) = (0usize, 0usize);
    for (line, m) in markers {
        let fail = |why: String, tally: &Tally, raw: &str| Mismatch {
            line,
            marker: raw.to_owned(),
            why,
            tally: tally.clone(),
        };
        match m {
            Marker::Nowhere(p) => {
                tally.negatives = tally.negatives.saturating_add(1);
                for (name, hay) in [("stdout", stdout), ("stderr", stderr)] {
                    if find_wild(hay, p, 0).is_some() {
                        return Err(fail(
                            format!("forbidden marker {p:?} appears on {name}"),
                            &tally,
                            &format!("!{p}"),
                        ));
                    }
                }
            }
            Marker::NotStderr(p) => {
                tally.negatives = tally.negatives.saturating_add(1);
                if find_wild(stderr, p, 0).is_some() {
                    return Err(fail(
                        format!("forbidden marker {p:?} appears on stderr"),
                        &tally,
                        &format!("![stderr] {p}"),
                    ));
                }
            }
            Marker::Stderr(p) => match find_wild(stderr, p, err_pos) {
                Some(e) => {
                    err_pos = e;
                    tally.matched = tally.matched.saturating_add(1);
                }
                None => {
                    return Err(fail(
                        format!("stderr marker {p:?} missing (in order)"),
                        &tally,
                        &format!("[stderr] {p}"),
                    ));
                }
            },
            Marker::Stdout(p) => match find_wild(stdout, p, out_pos) {
                Some(e) => {
                    out_pos = e;
                    tally.matched = tally.matched.saturating_add(1);
                }
                None => {
                    return Err(fail(
                        format!("stdout marker {p:?} missing (in order)"),
                        &tally,
                        p,
                    ));
                }
            },
        }
    }
    Ok(tally)
}

/// One case of the shared fixture table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fixture {
    pub name: String,
    pub spec: String,
    pub stdout: String,
    pub stderr: String,
    pub ok: bool,
}

/// Parse the fixture table format: blocks started by `=== <name>`, each with `--- spec`,
/// `--- stdout`, `--- stderr` sections (lines joined with `\n`, no final newline; the escape
/// `\n` inside a line is not interpreted) and `--- expect` followed by `ok` or `err`.
pub fn parse_fixtures(text: &str) -> Result<Vec<Fixture>, String> {
    let mut out = Vec::new();
    let mut cur: Option<(String, [Vec<&str>; 3], Option<bool>)> = None;
    let mut section: Option<usize> = None;
    let mut finish = |cur: &mut Option<(String, [Vec<&str>; 3], Option<bool>)>| {
        if let Some((name, [spec, so, se], ok)) = cur.take() {
            let ok = ok.ok_or(format!("fixture {name:?} has no `--- expect`"))?;
            out.push(Fixture {
                name,
                spec: spec.join("\n"),
                stdout: so.join("\n"),
                stderr: se.join("\n"),
                ok,
            });
        }
        Ok::<(), String>(())
    };
    for (i, line) in text.lines().enumerate() {
        if let Some(name) = line.strip_prefix("=== ") {
            finish(&mut cur)?;
            cur = Some((name.trim().to_owned(), [Vec::new(), Vec::new(), Vec::new()], None));
            section = None;
            continue;
        }
        let Some((_, bufs, ok)) = cur.as_mut() else {
            if line.starts_with('#') || line.trim().is_empty() {
                continue;
            }
            return Err(format!("line {}: text before the first `===`", i.saturating_add(1)));
        };
        match line {
            "--- spec" => section = Some(0),
            "--- stdout" => section = Some(1),
            "--- stderr" => section = Some(2),
            "--- expect" => section = Some(3),
            _ => match section {
                Some(3) => match line.trim() {
                    "ok" => *ok = Some(true),
                    "err" => *ok = Some(false),
                    "" => {}
                    other => {
                        return Err(format!(
                            "line {}: expect must be ok or err, not {other:?}",
                            i.saturating_add(1)
                        ));
                    }
                },
                Some(s) => {
                    if let Some(b) = bufs.get_mut(s) {
                        b.push(line);
                    }
                }
                None => {
                    return Err(format!(
                        "line {}: text outside a section",
                        i.saturating_add(1)
                    ));
                }
            },
        }
    }
    finish(&mut cur)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tally_counts() {
        let t = check("a\n[stderr] b\n!c\n", "a", "b").unwrap();
        assert_eq!((t.total, t.matched, t.negatives), (2, 2, 1));
        let m = check("a\nz\n", "a", "").unwrap_err();
        assert_eq!((m.line, m.marker.as_str()), (2, "z"));
        assert_eq!(m.tally.matched, 1);
    }
}
