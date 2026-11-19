//! The macOS-companion rules of `cargo xtask audit` (PLAN M20, threat model §10.2 M20, AS9,
//! SIGN-1, SC-1).
//!
//! **Why a separate module:** `audit.rs` checks the Rust workspace; these rules cover the
//! non-Rust trees that M20 adds or that teach learners what to type (`tools/`, `course/`,
//! `docs/macos/`). Each rule names the requirement it enforces:
//!
//! | Rule | Requirement |
//! |---|---|
//! | `csrutil`, `amfi_get_out_of_my_way` and `sudo` appear in `course/`, `docs/macos/` and `tools/` only inside an allow-listed forbidding phrase (`docs/security/forbidden-advice.txt`) | AS9 |
//! | every allow-list phrase has the fixed shape *negation, up to four filler words, one forbidden word* (`no sudo`, `never asks you to run csrutil`), so the list cannot whitelist advice | AS9 |
//! | no symlink in `tools/`, `course/` or `docs/` (the audit does not follow one, so it cannot vouch for its target) | AS9, SLA §2B |
//! | `tools/vz-mac/vz-mac.entitlements` holds exactly `com.apple.security.virtualization = true` | SIGN-1, ADR-0008 §2 |
//! | every `tools/**/*.sh` starts with the SC-1 preamble (`#!/usr/bin/env bash`, `set -euo pipefail`, `IFS=$'\n\t'`, `umask 077`) | SC-1 (`scripts/check.sh` only checks `scripts/`) |
//! | no `.ipsw` file and nothing named `AVPBooter*` (any case) in `tools/`, `course/` or `docs/` | SLA §2B, ADR-0008 §3 (no Apple binaries in the repo) |
//!
//! **Matching.** A forbidden word matches case-insensitively on ASCII word boundaries
//! (`pseudo` and `sudoers` are not `sudo`). An occurrence is allowed when an allow-list phrase
//! occurs, case-insensitively and also on ASCII word boundaries (so `no sudo` does not match
//! inside `piano sudo`), on the same line and covers it. Phrases are plain text, one per line;
//! `#` starts a comment line.
//!
//! **Fail closed.** Every file is scanned as bytes (`from_utf8_lossy`), so one Latin-1 byte
//! cannot hide a file; a file too large to scan and every symlink are findings, not skips.
//! Only the exact build-output paths in [`SKIP_PATHS`] are skipped, never a directory merely
//! *named* `target` or `dist`.

use crate::audit::{Finding, Report, plist_keys};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Words that must never appear as advice (AS9).
pub const FORBIDDEN_WORDS: [&str; 3] = ["csrutil", "amfi_get_out_of_my_way", "sudo"];

/// Trees scanned for forbidden advice.
pub const ADVICE_TREES: [&str; 3] = ["course", "docs/macos", "tools"];

/// The allow-list of forbidding phrases.
pub const ALLOWLIST: &str = "docs/security/forbidden-advice.txt";

/// The first word of every allow-list phrase (so it forbids rather than advises). Tokens
/// ending in `n't` (`don't`, `doesn't`) also count.
const NEGATIONS: [&str; 4] = ["no", "never", "not", "without"];

/// The only words allowed between the negation and the forbidden word, at most
/// [`MAX_FILLERS`] of them (`never asks you to run csrutil`). None of them can turn the phrase
/// into an instruction, because the phrase still has to start with the negation and end with
/// the forbidden word.
const FILLERS: [&str; 12] = [
    "ask", "asks", "need", "needs", "use", "uses", "using", "run", "runs", "you", "to", "for",
];
const MAX_FILLERS: usize = 4;

const VZ_ENTITLEMENTS: &str = "tools/vz-mac/vz-mac.entitlements";
const VZ_KEY: &str = "com.apple.security.virtualization";

/// Repo-relative build-output directories never descended into: exact paths only (gitignored
/// SwiftPM and site-builder output). A directory elsewhere that happens to be called `target`
/// or `dist` is scanned, because it would be committed.
pub const SKIP_PATHS: [&str; 4] = [
    "tools/vz-mac/.build",
    "tools/vz-mac/.swiftpm",
    "course/site/node_modules",
    "course/site/dist",
];

/// Largest file scanned for advice. A bigger file is a finding (it cannot be vouched for),
/// never a silent skip.
const MAX_SCAN_BYTES: u64 = 16 << 20;

fn add(report: &mut Report, path: &str, line: usize, rule: &'static str, message: String) {
    report.findings.push(Finding {
        path: path.to_owned(),
        line,
        rule,
        message,
    });
}

/// Run every rule of this module against the tree at `root`.
pub fn audit_tools(root: &Path, report: &mut Report) -> io::Result<()> {
    let phrases = match fs::read_to_string(root.join(ALLOWLIST)) {
        Ok(text) => parse_allowlist(&text, report),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    let mut files = Vec::new();
    let mut links = Vec::new();
    for top in ADVICE_TREES {
        collect(root, top, &mut files, &mut links)?;
    }
    for (rel, path) in &files {
        let meta = fs::symlink_metadata(path)?;
        if meta.len() > MAX_SCAN_BYTES {
            add(
                report,
                rel,
                1,
                "forbidden-advice",
                format!(
                    "{} bytes is over the {MAX_SCAN_BYTES}-byte scan limit, so the AS9 audit cannot vouch for it",
                    meta.len()
                ),
            );
            continue;
        }
        // Bytes, not `read_to_string`: a non-UTF-8 file is scanned too (AS9 fails closed).
        let bytes = fs::read(path)?;
        let text = String::from_utf8_lossy(&bytes);
        report.files_scanned += 1;
        audit_advice(rel, &text, &phrases, report);
        if rel.starts_with("tools/") && rel.ends_with(".sh") {
            audit_script_preamble(rel, &text, report);
        }
    }
    let mut apple = Vec::new();
    for top in ["tools", "course", "docs"] {
        collect(root, top, &mut apple, &mut links)?;
    }
    links.sort();
    links.dedup();
    for rel in &links {
        add(
            report,
            rel,
            1,
            "no-symlink",
            "symlink in a scanned tree: the audit does not follow it, so it cannot vouch for it (AS9, SLA §2B)".into(),
        );
    }
    for (rel, _) in &apple {
        let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
        if name.ends_with(".ipsw") || name.starts_with("avpbooter") {
            add(
                report,
                rel,
                1,
                "no-apple-binaries",
                "Apple software must not be stored in the repository (SLA §2B, ADR-0008 §3)".into(),
            );
        }
    }
    let ent = root.join(VZ_ENTITLEMENTS);
    if ent.is_file() {
        report.files_scanned += 1;
        audit_vz_entitlements(VZ_ENTITLEMENTS, &fs::read_to_string(&ent)?, report);
    } else if root.join("tools/vz-mac").is_dir() {
        add(
            report,
            VZ_ENTITLEMENTS,
            1,
            "vz-entitlements",
            "tools/vz-mac exists but its entitlements file does not".into(),
        );
    }
    Ok(())
}

/// Parse the allow-list; malformed phrases become findings and are dropped.
pub fn parse_allowlist(text: &str, report: &mut Report) -> Vec<String> {
    let mut out = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if !is_forbidding_phrase(&lower) {
            add(
                report,
                ALLOWLIST,
                i + 1,
                "forbidden-advice-allowlist",
                format!(
                    "phrase {line:?} must be: one of {NEGATIONS:?} (or a word ending in n't), at most {MAX_FILLERS} of {FILLERS:?}, then exactly one of {FORBIDDEN_WORDS:?}, and nothing else (letters, spaces and backticks only)"
                ),
            );
            continue;
        }
        out.push(lower);
    }
    out
}

/// The fixed allow-list grammar: `NEGATION FILLER{0,4} FORBIDDEN_WORD`, with only ASCII
/// letters, digits, `_`, `'`, spaces and backticks. Because the forbidden word must be the
/// *last* token and the negation the *first*, no clause can precede or follow it: `if it does
/// not boot, run sudo` (starts with `if`, has a comma) and `run csrutil disable, no questions
/// asked` (starts with `run`) are both rejected.
pub fn is_forbidding_phrase(lower: &str) -> bool {
    if !lower
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_' `".contains(&b))
    {
        return false;
    }
    let tokens: Vec<&str> = lower.split([' ', '`']).filter(|t| !t.is_empty()).collect();
    let [first, middle @ .., last] = tokens.as_slice() else {
        return false;
    };
    (NEGATIONS.contains(first) || first.ends_with("n't"))
        && FORBIDDEN_WORDS.contains(last)
        && middle.len() <= MAX_FILLERS
        && middle.iter().all(|t| FILLERS.contains(t))
}

/// Byte offsets of `word` (ASCII) in `lower` (already lowercase) on ASCII word boundaries:
/// the bytes just before and just after the match are not `[a-z0-9_]`.
pub fn word_matches(lower: &str, word: &str) -> Vec<usize> {
    let bytes = lower.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(pos) = lower.get(from..).and_then(|s| s.find(word)) {
        let start = from + pos;
        let end = start + word.len();
        let before = start.checked_sub(1).and_then(|i| bytes.get(i)).copied();
        let after = bytes.get(end).copied();
        if !before.is_some_and(is_word) && !after.is_some_and(is_word) {
            out.push(start);
        }
        // Retry one byte on, so a rejected match cannot hide an overlapping valid one. `word`
        // is ASCII (forbidden words, or phrases `is_forbidding_phrase` admitted), so the byte
        // at `start` is ASCII and `start + 1` is a char boundary.
        from = start + 1;
    }
    out
}

/// AS9: every forbidden word in `text` must sit inside an allow-listed forbidding phrase.
pub fn audit_advice(rel: &str, text: &str, phrases: &[String], report: &mut Report) {
    for (i, line) in text.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        // Spans covered by allow-listed phrases on this line.
        let covered: Vec<(usize, usize)> = phrases
            .iter()
            .flat_map(|p| {
                word_matches(&lower, p)
                    .into_iter()
                    .map(|s| (s, s + p.len()))
            })
            .collect();
        for w in FORBIDDEN_WORDS {
            for start in word_matches(&lower, w) {
                let end = start + w.len();
                if !covered.iter().any(|&(s, e)| s <= start && end <= e) {
                    add(
                        report,
                        rel,
                        i + 1,
                        "forbidden-advice",
                        format!(
                            "{w:?} outside an allow-listed forbidding phrase ({ALLOWLIST}); the course must never ask a learner for it (AS9)"
                        ),
                    );
                }
            }
        }
    }
}

/// SC-1 for scripts outside `scripts/`.
pub fn audit_script_preamble(rel: &str, text: &str, report: &mut Report) {
    let first = text.lines().next().unwrap_or("");
    if first != "#!/usr/bin/env bash" && first != "#!/bin/bash" {
        add(
            report,
            rel,
            1,
            "sc1-preamble",
            "not a bash script (SC-1)".into(),
        );
        return;
    }
    for need in ["set -euo pipefail", "IFS=$'\\n\\t'", "umask 077"] {
        if !text.lines().any(|l| l.trim() == need) {
            add(
                report,
                rel,
                1,
                "sc1-preamble",
                format!("missing {need:?} (SC-1)"),
            );
        }
    }
}

/// SIGN-1 for the companion tool: exactly the VZ key, set to `<true/>`.
pub fn audit_vz_entitlements(rel: &str, xml: &str, report: &mut Report) {
    let keys = plist_keys(xml);
    for (key, _) in &keys {
        if key != VZ_KEY {
            add(
                report,
                rel,
                1,
                "vz-entitlements",
                format!("unexpected entitlement {key:?}: vz-mac holds only {VZ_KEY} (SIGN-1)"),
            );
        }
    }
    let vz: Vec<&(String, bool)> = keys.iter().filter(|(k, _)| k == VZ_KEY).collect();
    match vz.as_slice() {
        [(_, true)] => {}
        [] => add(
            report,
            rel,
            1,
            "vz-entitlements",
            format!("{VZ_KEY} missing"),
        ),
        [(_, false)] => add(
            report,
            rel,
            1,
            "vz-entitlements",
            format!("{VZ_KEY} is not <true/>"),
        ),
        _ => add(
            report,
            rel,
            1,
            "vz-entitlements",
            format!("{VZ_KEY} listed twice"),
        ),
    }
}

/// Regular files under `root/top` as `(repo-relative path, absolute path)`, and the
/// repo-relative paths of symlinks (never followed; the caller reports them). Only the exact
/// [`SKIP_PATHS`] are skipped.
fn collect(
    root: &Path,
    top: &str,
    files: &mut Vec<(String, PathBuf)>,
    links: &mut Vec<String>,
) -> io::Result<()> {
    let dir = root.join(top);
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() => {
            links.push(top.to_owned());
            Ok(())
        }
        Ok(m) if m.is_dir() => collect_dir(root, &dir, files, links),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn collect_dir(
    root: &Path,
    dir: &Path,
    files: &mut Vec<(String, PathBuf)>,
    links: &mut Vec<String>,
) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let ty = entry.file_type()?; // does not follow symlinks
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if ty.is_symlink() {
            links.push(rel);
        } else if ty.is_dir() {
            if !SKIP_PATHS.contains(&rel.as_str()) {
                collect_dir(root, &path, files, links)?;
            }
        } else if ty.is_file() {
            files.push((rel, path));
        }
    }
    Ok(())
}
