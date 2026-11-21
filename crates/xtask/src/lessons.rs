//! `cargo xtask lessons [FILE|NN]...`: the course lesson lint (`scripts/check-lessons`).
//!
//! **Why:** every chapter of the course is written by a different author against one template
//! (CURRICULUM §7, `course/STYLE.md`, `course/site/DESIGN.md` §9). A reviewer should spend their
//! time on the teaching, not on whether the "Concepts you'll need" box has its five groups, the
//! capture a lesson quotes exists, or author shorthand such as `[U]` or a milestone ID leaked onto
//! a learner page. This lint makes those mechanical rules executable. The format it checks is
//! documented for authors in `course/STYLE.md`, appendix A; keep the two in step.
//!
//! **What it checks**, per lesson `course/chapters/<part>/<NN-slug>.md`:
//!
//! - front matter: the fields of CURRICULUM §7 item 1, agreeing with `course/chapters.json`;
//! - the required blocks, in order: `:::retrieval` (from chapter 01), `:::concepts` with its
//!   five labelled groups, the opening puzzle (prose citing the ledger), `:::objectives`, the
//!   body, `## Checkpoint` (with `:::checkpoint`, a `:::term` capture, `### What's next`,
//!   `### Open question`), then `## Spec hunt` (2 or 3 items) as the last section;
//! - every `:::code` reference resolves to a real `// ANCHOR:` region, using the same marker
//!   scanner as `scripts/check-anchors` ([`crate::anchors`]);
//! - every `:::term source=` capture exists under `course/captures/` with a provenance header;
//! - every primer slug the Concepts box requires exists in `course/primers/`;
//! - every glossary link (`/build-your-own/vmm/glossary/#slug`) has an entry in `course/GLOSSARY.md`;
//! - no author notation reaches a learner (`[U]`, `[V]`, `§`, milestone/risk IDs such as M4, K11,
//!   R12, the L1/L2/L3 levels, `PLAN`, `CURRICULUM`, review names), in the lesson *and* its
//!   journal, rubric and retrieval bank;
//! - STYLE.md's banned words (simply, just, obviously, trivially) and `chNN` shorthand, as
//!   warnings.
//!
//! and the chapter's companions: `course/retrieval/NN.md` (6 to 10 items), `course/journal/NN.md`
//! (questions agree with `course/checkpoints/NN/checkpoint.toml`), `course/journal/NN.rubric.md`,
//! plus the format of `course/GLOSSARY.md`. Companions of chapters without a lesson file are not
//! checked: a chapter's author fixes them when the lesson lands.
//!
//! Errors fail the command; warnings are printed and do not.

use crate::anchors;
use crate::checkpoint::json_lite::{self, Json};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

/// The directory lessons live in.
pub const CHAPTERS_DIR: &str = "course/chapters";
/// Largest course text file read (a lesson is a few tens of KiB).
const MAX_TEXT: usize = 1 << 20;
/// Retrieval bank size (CURRICULUM §6.2).
const BANK_MIN: usize = 6;
const BANK_MAX: usize = 10;
/// A lesson longer than this should be split (STYLE.md §8).
const MAX_WORDS: usize = 4_000;
/// Callouts per chapter (STYLE.md §7).
const MAX_CALLOUTS: usize = 5;

/// The five callout labels written as blockquotes (STYLE.md §7; Predict is `:::predict`).
pub const CALLOUTS: [&str; 5] = [
    "Try it",
    "Aside",
    "Under the hood",
    "Security",
    "Production note",
];

/// Directives with a body closed by a bare `:::` line.
pub const CONTAINERS: [&str; 5] = ["objectives", "prereqs", "predict", "callout", "concepts"];
/// Single-line directives.
pub const LEAVES: [&str; 7] = [
    "code",
    "term",
    "diagram",
    "lab",
    "checkpoint",
    "retrieval",
    "stopping-point",
];

/// The Concepts box groups, in order. Index 2 and 3 are the two primer groups (at least one).
pub const CONCEPT_GROUPS: [&str; 6] = [
    "Core, taught here",
    "Core, from earlier",
    "Primers (read first)",
    "Primers (review)",
    "Pointers",
    "Forward definitions",
];

/// Front-matter keys a chapter must have (CURRICULUM §7 item 1).
pub const FM_REQUIRED: [&str; 11] = [
    "title",
    "part",
    "chapter",
    "id",
    "runs",
    "minutes",
    "prereqs",
    "start_tag",
    "labs",
    "command",
    "expect",
];
/// Optional front-matter keys.
const FM_OPTIONAL: [&str; 1] = ["draft"];

/// Fence languages a lesson may use. Program code comes only through `:::code anchor=`.
const FENCE_LANGS: [&str; 4] = ["sh", "text", "console", ""];

/// STYLE.md §1 banned words (warnings).
const BANNED_WORDS: [&str; 4] = ["simply", "just", "obviously", "trivially"];

/// Severity of a finding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error,
    Warning,
}

/// One finding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diag {
    pub path: String,
    pub line: usize,
    pub level: Level,
    pub msg: String,
}

impl fmt::Display for Diag {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let lvl = match self.level {
            Level::Error => "error",
            Level::Warning => "warning",
        };
        write!(f, "{}:{}: {lvl}: {}", self.path, self.line, self.msg)
    }
}

/// Everything one run found.
#[derive(Debug, Default)]
pub struct Report {
    pub diags: Vec<Diag>,
    pub lessons: usize,
}

impl Report {
    pub fn errors(&self) -> usize {
        self.diags
            .iter()
            .filter(|d| d.level == Level::Error)
            .count()
    }
    pub fn warnings(&self) -> usize {
        self.diags
            .iter()
            .filter(|d| d.level == Level::Warning)
            .count()
    }
}

/// Collects findings for one file.
struct Sink<'a> {
    path: String,
    out: &'a mut Vec<Diag>,
}

impl Sink<'_> {
    fn err(&mut self, line: usize, msg: impl Into<String>) {
        self.out.push(Diag {
            path: self.path.clone(),
            line,
            level: Level::Error,
            msg: msg.into(),
        });
    }
    fn warn(&mut self, line: usize, msg: impl Into<String>) {
        self.out.push(Diag {
            path: self.path.clone(),
            line,
            level: Level::Warning,
            msg: msg.into(),
        });
    }
}

// ---------------------------------------------------------------------------------------------
// course/chapters.json

/// One chapter of `course/chapters.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChapterMeta {
    pub id: String,
    pub part: String,
    pub number: String,
    pub title: String,
    pub runs: String,
    pub minutes: String,
    pub labs: Vec<String>,
    pub prereqs: Vec<String>,
    pub file: String,
}

/// What the lint needs from `course/chapters.json`.
#[derive(Clone, Debug, Default)]
pub struct Course {
    pub chapters: Vec<ChapterMeta>,
    pub primers: BTreeSet<String>,
    pub labs: BTreeSet<String>,
}

impl Course {
    pub fn chapter(&self, id: &str) -> Option<&ChapterMeta> {
        self.chapters.iter().find(|c| c.id == id)
    }
}

fn strs(v: Option<&Json>) -> Vec<String> {
    match v {
        Some(Json::Arr(a)) => a
            .iter()
            .filter_map(|x| match x {
                Json::Str(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Parse `course/chapters.json` (generated, so one JSON document; newlines are whitespace).
pub fn parse_course(text: &str) -> Result<Course, String> {
    let joined: String = text.lines().collect::<Vec<_>>().join(" ");
    let doc = json_lite::parse_line(&joined).map_err(|e| format!("chapters.json: {e}"))?;
    let mut course = Course::default();
    if let Some(Json::Arr(chs)) = doc.get("chapters") {
        for c in chs {
            let s = |k: &str| c.get_str(k).unwrap_or("").to_owned();
            course.chapters.push(ChapterMeta {
                id: s("id"),
                part: s("part"),
                number: s("number"),
                title: s("title"),
                runs: s("runs"),
                minutes: match c.get("minutes") {
                    Some(Json::Num(n)) => n.clone(),
                    _ => String::new(),
                },
                labs: strs(c.get("labs")),
                prereqs: strs(c.get("prereqs")),
                file: s("file"),
            });
        }
    }
    if let Some(Json::Arr(ps)) = doc.get("primers") {
        for p in ps {
            if let Some(slug) = p.get_str("slug") {
                course.primers.insert(slug.to_owned());
            }
        }
    }
    if let Some(Json::Arr(ls)) = doc.get("labs") {
        for l in ls {
            if let Some(name) = l.get_str("name") {
                course.labs.insert(name.to_owned());
            }
        }
    }
    if course.chapters.is_empty() {
        return Err("chapters.json: no chapters".into());
    }
    Ok(course)
}

// ---------------------------------------------------------------------------------------------
// Front matter (DESIGN.md §9; the same closed subset as course/site/lib/frontmatter.mjs)

/// A front-matter value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FmValue {
    Str(String),
    List(Vec<String>),
}

/// Parsed front matter: `(key, value, line)` in source order, and the first body line (1-based).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub fields: Vec<(String, FmValue, usize)>,
    pub body_line: usize,
}

impl FrontMatter {
    pub fn get(&self, key: &str) -> Option<&FmValue> {
        self.fields
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, v, _)| v)
    }
    fn str(&self, key: &str) -> Option<&str> {
        match self.get(key) {
            Some(FmValue::Str(s)) => Some(s),
            _ => None,
        }
    }
    fn list(&self, key: &str) -> Option<&[String]> {
        match self.get(key) {
            Some(FmValue::List(l)) => Some(l),
            _ => None,
        }
    }
    fn line(&self, key: &str) -> usize {
        self.fields
            .iter()
            .find(|(k, _, _)| k == key)
            .map_or(1, |(_, _, l)| *l)
    }
}

fn strip_comment(v: &str) -> &str {
    // "a  # note" -> "a"; a '#' without whitespace before it ("#address-cells") is kept.
    let b = v.as_bytes();
    for (i, w) in b.windows(2).enumerate() {
        if w[0].is_ascii_whitespace() && w[1] == b'#' {
            let after = b.get(i + 2);
            if after.is_none() || after.is_some_and(|c| c.is_ascii_whitespace()) {
                return v[..i].trim();
            }
        }
    }
    v.trim()
}

fn unquote(v: &str) -> String {
    let b = v.as_bytes();
    if b.len() >= 2
        && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\''))
    {
        return v[1..v.len() - 1].to_owned();
    }
    v.to_owned()
}

/// Parse the leading `---` block. Errors carry the 1-based line.
pub fn parse_front_matter(text: &str) -> Result<FrontMatter, (usize, String)> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return Err((
            1,
            "no front matter: the file must start with a `---` line".into(),
        ));
    }
    let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---") else {
        return Err((1, "front matter opened with `---` but never closed".into()));
    };
    let end = end + 1;
    let mut fm = FrontMatter {
        fields: Vec::new(),
        body_line: end + 2,
    };
    let mut list_key: Option<usize> = None;
    for (i, raw) in lines.iter().enumerate().take(end).skip(1) {
        let ln = i + 1;
        let t = raw.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(item) = t.strip_prefix("- ") {
            let Some(idx) = list_key else {
                return Err((ln, "list item without a key above it".into()));
            };
            if let FmValue::List(l) = &mut fm.fields[idx].1 {
                l.push(unquote(strip_comment(item)));
            }
            continue;
        }
        let Some((key, rest)) = raw.split_once(':') else {
            return Err((
                ln,
                format!("cannot parse {raw:?} (expected \"key: value\")"),
            ));
        };
        let key_ok = key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !key_ok || !(rest.is_empty() || rest.starts_with(' ')) {
            return Err((
                ln,
                format!("cannot parse {raw:?} (expected \"key: value\")"),
            ));
        }
        if fm.get(key).is_some() {
            return Err((ln, format!("duplicate key {key:?}")));
        }
        let v = strip_comment(rest);
        if v.is_empty() {
            fm.fields
                .push((key.to_owned(), FmValue::List(Vec::new()), ln));
            list_key = Some(fm.fields.len() - 1);
            continue;
        }
        list_key = None;
        let value = if let Some(inner) = v.strip_prefix('[') {
            let Some(inner) = inner.strip_suffix(']') else {
                return Err((ln, format!("unterminated inline list for {key:?}")));
            };
            let inner = inner.trim();
            FmValue::List(if inner.is_empty() {
                Vec::new()
            } else {
                inner.split(',').map(|s| unquote(s.trim())).collect()
            })
        } else {
            FmValue::Str(unquote(v))
        };
        fm.fields.push((key.to_owned(), value, ln));
    }
    Ok(fm)
}

// ---------------------------------------------------------------------------------------------
// Text helpers

/// Replace inline code spans (`` `x` ``) with spaces, keeping columns.
pub fn strip_code_spans(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for c in line.chars() {
        if c == '`' {
            in_code = !in_code;
            out.push(' ');
        } else if in_code {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// ASCII alphanumeric tokens with their byte offsets.
fn tokens(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        if c.is_ascii_alphanumeric() {
            if start.is_none() {
                start = Some(i);
            }
        } else if let Some(st) = start.take() {
            out.push((st, &s[st..i]));
        }
    }
    if let Some(st) = start {
        out.push((st, &s[st..]));
    }
    out
}

/// `PREFIX` followed by one or two digits, e.g. `M4`, `K11`.
fn is_id(tok: &str, prefix: char) -> bool {
    let mut cs = tok.chars();
    cs.next() == Some(prefix) && {
        let rest: Vec<char> = cs.collect();
        (1..=2).contains(&rest.len()) && rest.iter().all(char::is_ascii_digit)
    }
}

/// The site's anchor for a glossary term: lowercase, runs of non-alphanumerics become `-`.
pub fn slug(term: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in term.chars() {
        if c.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c.to_ascii_lowercase());
        } else {
            dash = true;
        }
    }
    out
}

/// Author notation that must never reach a learner page (CURRICULUM §7 item 10). Errors.
/// `line` is checked raw for tags and `§`, and with code spans removed for IDs and words.
pub fn notation_problems(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tag in ["[U]", "[V]", "[H]"] {
        if line.contains(tag) {
            out.push(format!(
                "author evidence tag {tag}: say \"we checked this on a real Mac\" (with what ran) or quote the capture"
            ));
        }
    }
    if line.contains('§') {
        out.push("section sign `§`: author cross-reference, not for learners".into());
    }
    let plain = strip_code_spans(line);
    let lower = plain.to_ascii_lowercase();
    for phrase in [
        "novice review",
        "socratic review",
        "first-principles review",
    ] {
        if lower.contains(phrase) {
            out.push(format!("review reference {phrase:?}: author notation"));
        }
    }
    let toks = tokens(&plain);
    let chip_context = plain.contains("Apple");
    for (i, (_, t)) in toks.iter().enumerate() {
        let next = toks.get(i + 1).map(|(_, n)| *n).unwrap_or("");
        match *t {
            "PLAN" | "CURRICULUM" => {
                out.push(format!("{t}: author document name; learners never see it"));
                continue;
            }
            _ => {}
        }
        if is_id(t, 'M') && !chip_context && !matches!(next, "Pro" | "Max" | "Ultra") {
            out.push(format!(
                "{t}: looks like a milestone ID (if you mean an Apple chip, write \"Apple {t}\")"
            ));
        } else if is_id(t, 'K') || (is_id(t, 'R') && t.len() > 2) {
            out.push(format!("{t}: looks like a risk ID; author notation"));
        } else if matches!(*t, "L1" | "L2" | "L3")
            && !matches!(
                next.to_ascii_lowercase().as_str(),
                "cache" | "caches" | "d" | "i"
            )
        {
            out.push(format!(
                "{t}: checkpoint level; say \"contract tests\", \"runs on your Mac\" or \"journal\""
            ));
        }
    }
    out
}

/// `s` with every `http://` / `https://` URL blanked (up to whitespace, `)` or `>`), so
/// prose rules do not fire inside a link target: the Rust book's `ch20-01-unsafe-rust.html` is
/// not `ch20` shorthand.
pub fn strip_urls(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let at = [rest.find("https://"), rest.find("http://")]
            .into_iter()
            .flatten()
            .min();
        let Some(at) = at else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        // The URL ends at whitespace, `>`, or a `)` that closes no `(` inside the URL, so a
        // Markdown link target like `.../Mutex_(computing))` is blanked whole.
        let mut depth = 0usize;
        let mut end = tail.len();
        for (i, c) in tail.char_indices() {
            match c {
                '(' => depth = depth.saturating_add(1),
                ')' if depth > 0 => depth -= 1,
                ')' | '>' => {
                    end = i;
                    break;
                }
                c if c.is_whitespace() => {
                    end = i;
                    break;
                }
                _ => {}
            }
        }
        // One space per character, so columns after the URL still line up.
        out.extend(std::iter::repeat_n(' ', tail[..end].chars().count()));
        rest = &tail[end..];
    }
}

/// Style warnings for one line (code spans and URLs removed).
pub fn style_problems(line: &str) -> Vec<String> {
    let plain = strip_urls(&strip_code_spans(line));
    let mut out = Vec::new();
    for (_, t) in tokens(&plain) {
        let l = t.to_ascii_lowercase();
        if BANNED_WORDS.contains(&l.as_str()) {
            out.push(format!("STYLE banned word {t:?}"));
        }
        let b = t.as_bytes();
        if b.len() == 4 && &b[..2] == b"ch" && b[2].is_ascii_digit() && b[3].is_ascii_digit() {
            out.push(format!("{t}: write \"chapter {}\" for learners", &t[2..]));
        }
    }
    out
}

/// The comment part of one source line, or `""` if it has none. A line-based approximation
/// (string literals are skipped, so `"// not a comment"` is code): enough for the short regions a
/// lesson quotes. C block-comment continuation lines (`* text`) count as comment.
pub fn comment_text(line: &str, syntax: anchors::Syntax) -> &str {
    let t = line.trim_start();
    let slash = |s: &'_ str| -> Option<usize> {
        let b = s.as_bytes();
        let mut in_str = false;
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\\' if in_str => i += 1,
                b'\'' if !in_str && b.get(i + 1) == Some(&b'"') && b.get(i + 2) == Some(&b'\'') => {
                    i += 2
                }
                b'"' => in_str = !in_str,
                b'/' if !in_str && b.get(i + 1) == Some(&b'/') => return Some(i),
                _ => {}
            }
            i += 1;
        }
        None
    };
    let hash = |s: &'_ str| -> Option<usize> {
        let b = s.as_bytes();
        let (mut sq, mut dq) = (false, false);
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\\' if !sq => i += 1,
                b'\'' if !dq => sq = !sq,
                b'"' if !sq => dq = !dq,
                b'#' if !sq && !dq && (i == 0 || b[i - 1].is_ascii_whitespace()) => {
                    return Some(i);
                }
                _ => {}
            }
            i += 1;
        }
        None
    };
    let block_cont = t.starts_with("/*") || t.starts_with('*');
    let at = match syntax {
        anchors::Syntax::Slash { block } => {
            if block && block_cont {
                Some(0)
            } else {
                slash(t)
            }
        }
        anchors::Syntax::Hash => hash(t),
        anchors::Syntax::Html => t.find("<!--"),
        anchors::Syntax::Linker => {
            if block_cont {
                Some(0)
            } else {
                hash(t)
            }
        }
    };
    at.map_or("", |i| &t[i..])
}

/// Hyphenated prefixes that are real standards, not tracking IDs (`UTF-8`, `SHA-256`, …).
const STANDARD_PREFIXES: [&str; 12] = [
    "UTF", "SHA", "CRC", "AES", "ISO", "IEEE", "ECMA", "GPL", "ELF", "RFC", "PCI", "ARM",
];

/// Internal documents whose section numbers mean nothing to a learner (`architecture §9`).
const INTERNAL_DOCS: [&str; 10] = [
    "architecture",
    "Architecture",
    "PLAN",
    "CURRICULUM",
    "DESIGN",
    "STYLE",
    "LABS",
    "DECISIONS",
    "CONCEPTS",
    "model",
];

/// Author notation in a *code comment* that a lesson displays through `:::code`. Errors.
///
/// Code comments may cite external specs by section (`virtio 1.2 §2.7.5`, `ARM ARM D19.2`,
/// `DEN 0022 §5.1.3`), so `§` alone is fine here; what is banned is the project's own tracking
/// vocabulary: milestone IDs (`M12`), risk and threat-model IDs (`K11`, `R12`, `HC-6`, `VQ-4`,
/// `S14`), `PLAN`/`CURRICULUM`, a section of an internal document (`architecture §13.2`,
/// `threat model §7.14`), `spike finding N`, review names and `chNN` shorthand. Say the reason
/// itself, or point at a file (`docs/security/threat-model.md`).
pub fn code_notation_problems(comment: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tag in ["[U]", "[V]", "[H]"] {
        if comment.contains(tag) {
            out.push(format!("author evidence tag {tag}"));
        }
    }
    let plain = strip_code_spans(comment);
    for (i, _) in plain.match_indices('§') {
        let before = plain[..i].trim_end();
        let word = before
            .rsplit(|c: char| !c.is_ascii_alphanumeric())
            .next()
            .unwrap_or("");
        if INTERNAL_DOCS.contains(&word) {
            out.push(format!(
                "`{word} §`: a section of an internal document; say the reason itself"
            ));
        }
    }
    let lower = plain.to_ascii_lowercase();
    for phrase in [
        "novice review",
        "socratic review",
        "first-principles review",
        "spike finding",
    ] {
        if lower.contains(phrase) {
            out.push(format!(
                "{phrase:?}: author notation; say what was observed"
            ));
        }
    }
    let toks = tokens(&plain);
    let chip_context = plain.contains("Apple");
    let digits = |s: &str, n: std::ops::RangeInclusive<usize>| {
        n.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
    };
    for (i, &(off, t)) in toks.iter().enumerate() {
        let next = toks.get(i + 1).map(|&(_, n)| n).unwrap_or("");
        let prev = i
            .checked_sub(1)
            .and_then(|p| toks.get(p))
            .map(|&(_, p)| p)
            .unwrap_or("");
        let id = |p: &str| t.strip_prefix(p).is_some_and(|r| digits(r, 1..=2));
        let b = t.as_bytes();
        let bad = if t == "PLAN" || t == "CURRICULUM" {
            Some(format!("{t}: author document name"))
        } else if is_id(t, 'M') && !chip_context && !matches!(next, "Pro" | "Max" | "Ultra") {
            Some(format!("{t}: milestone ID"))
        } else if is_id(t, 'K')
            || (is_id(t, 'R') && t.len() > 2)
            || id("RR")
            || id("AS")
            || t.strip_prefix('S').is_some_and(|r| digits(r, 2..=2))
            || t.strip_prefix('F').is_some_and(|r| digits(r, 2..=2))
            || (prev.eq_ignore_ascii_case("attacker") && id("A"))
            || (prev.eq_ignore_ascii_case("gate") && id("G"))
        {
            Some(format!("{t}: risk/threat-model ID"))
        } else if b.len() == 4 && &b[..2] == b"ch" && b[2].is_ascii_digit() && b[3].is_ascii_digit()
        {
            Some(format!("{t}: write \"chapter {}\"", &t[2..]))
        } else if (2..=7).contains(&t.len())
            && t.bytes().all(|c| c.is_ascii_uppercase())
            && !STANDARD_PREFIXES.contains(&t)
            && plain[off + t.len()..].starts_with('-')
            && toks
                .get(i + 1)
                .is_some_and(|&(o, n)| o == off + t.len() + 1 && digits(n, 1..=2))
        {
            Some(format!("{t}-{next}: threat-model/hardening ID"))
        } else {
            None
        };
        out.extend(bad);
    }
    out
}

/// Parse `key=value` / `key="a b"` arguments after a directive name.
pub fn directive_args(rest: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut s = rest.trim();
    while !s.is_empty() {
        let Some(eq) = s.find('=') else { break };
        let key = s[..eq].trim().to_owned();
        let after = &s[eq + 1..];
        let (val, next) = if let Some(q) = after.strip_prefix('"') {
            match q.find('"') {
                Some(end) => (q[..end].to_owned(), &q[end + 1..]),
                None => (q.to_owned(), ""),
            }
        } else {
            match after.find(char::is_whitespace) {
                Some(end) => (after[..end].to_owned(), &after[end..]),
                None => (after.to_owned(), ""),
            }
        };
        if key.contains(char::is_whitespace) {
            // Free text before the first key (e.g. a lab name): skip one word.
            let Some(sp) = s.find(char::is_whitespace) else {
                break;
            };
            s = s[sp..].trim_start();
            continue;
        }
        out.insert(key, val);
        s = next.trim_start();
    }
    out
}

/// Is `name` a capture file name: `NN-word[-word…].txt` or `….trace.jsonl`?
pub fn valid_capture_name(name: &str) -> bool {
    let stem = if let Some(s) = name.strip_suffix(".trace.jsonl") {
        s
    } else if let Some(s) = name.strip_suffix(".txt") {
        s
    } else {
        return false;
    };
    let b = stem.as_bytes();
    b.len() >= 4
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b'-'
        && stem[3..]
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !stem.ends_with('-')
        && !stem[3..].starts_with('-')
}

fn read(root: &Path, rel: &str) -> Result<String, String> {
    crate::checkpoint::read_capped(&root.join(rel), MAX_TEXT)
}

// ---------------------------------------------------------------------------------------------
// The glossary

/// One glossary entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlossEntry {
    pub term: String,
    pub expansion: Option<String>,
    pub section: String,
    pub line: usize,
}

/// Parse one entry line: `- **Term** (expansion): definition.`
pub fn parse_gloss_entry(line: &str) -> Option<(String, Option<String>, String)> {
    let rest = line.strip_prefix("- **")?;
    let end = rest.find("**")?;
    let term = rest[..end].trim().to_owned();
    let mut after = &rest[end + 2..];
    let mut expansion = None;
    if let Some(p) = after.strip_prefix(" (") {
        let close = p.find("):")?;
        expansion = Some(p[..close].trim().to_owned());
        after = &p[close + 1..];
    }
    let def = after.strip_prefix(": ")?.trim().to_owned();
    if term.is_empty() || def.is_empty() {
        return None;
    }
    Some((term, expansion, def))
}

/// Check `course/GLOSSARY.md` and return its entries.
pub fn check_glossary(text: &str, course: &Course, out: &mut Vec<Diag>) -> Vec<GlossEntry> {
    let mut sink = Sink {
        path: "course/GLOSSARY.md".into(),
        out,
    };
    let mut entries: Vec<GlossEntry> = Vec::new();
    let mut section: Option<String> = None;
    let mut last_chapter: Option<String> = None;
    let mut seen_h1 = false;
    let mut slugs: BTreeMap<String, usize> = BTreeMap::new();
    for (i, raw) in text.lines().enumerate() {
        let ln = i + 1;
        let t = raw.trim_end();
        if let Some(h) = t.strip_prefix("# ") {
            if seen_h1 || h != "Glossary" {
                sink.err(
                    ln,
                    "the only `#` heading is `# Glossary`, on the first line",
                );
            }
            seen_h1 = true;
            continue;
        }
        if let Some(h) = t.strip_prefix("## ") {
            if h == "Primers" {
                if section.is_some() {
                    sink.err(ln, "`## Primers` comes before the chapter sections");
                }
            } else if let Some(id) = h.strip_prefix("Chapter ") {
                if course.chapter(id).is_none() {
                    sink.err(ln, format!("`## Chapter {id}`: no such chapter"));
                }
                if last_chapter.as_deref().is_some_and(|p| p >= id) {
                    sink.err(
                        ln,
                        "chapter sections must be in increasing order, once each",
                    );
                }
                last_chapter = Some(id.to_owned());
            } else {
                sink.err(
                    ln,
                    format!("unknown section {h:?} (want `## Primers` or `## Chapter NN`)"),
                );
            }
            section = Some(h.to_owned());
            continue;
        }
        if t.trim().is_empty() || t.starts_with("###") {
            if t.starts_with("###") {
                sink.err(ln, "no `###` headings in the glossary");
            }
            continue;
        }
        let Some(sec) = &section else {
            continue; // the introduction paragraph before the first section
        };
        let Some((term, expansion, def)) = parse_gloss_entry(t) else {
            sink.err(
                ln,
                "not an entry: write `- **Term** (expansion): one-line definition.` (expansion optional)",
            );
            continue;
        };
        if !(def.ends_with('.') || def.ends_with(".)") || def.ends_with('`')) {
            sink.warn(
                ln,
                format!("definition of {term:?} should end with a full stop"),
            );
        }
        for p in notation_problems(&def) {
            sink.err(ln, p);
        }
        if sec == "Primers" {
            let names_primer = def
                .split('`')
                .skip(1)
                .step_by(2)
                .any(|s| course.primers.contains(s));
            if !names_primer {
                sink.err(
                    ln,
                    "a `## Primers` entry names its primer as a backticked slug",
                );
            }
        }
        let s = slug(&term);
        if let Some(prev) = slugs.insert(s.clone(), ln) {
            sink.err(
                ln,
                format!("duplicate term {term:?} (anchor #{s}, first at line {prev})"),
            );
        }
        entries.push(GlossEntry {
            term,
            expansion,
            section: sec.clone(),
            line: ln,
        });
    }
    if !seen_h1 {
        sink.err(1, "missing `# Glossary` heading");
    }
    entries
}

// ---------------------------------------------------------------------------------------------
// Companion files

/// Check `course/retrieval/NN.md`.
pub fn check_retrieval(rel: &str, id: &str, text: &str, out: &mut Vec<Diag>) {
    let mut sink = Sink {
        path: rel.to_owned(),
        out,
    };
    let mut items = 0usize;
    let mut cur: Option<(usize, bool, bool)> = None; // (line, has_q, has_a)
    let finish = |cur: &mut Option<(usize, bool, bool)>, sink: &mut Sink| {
        if let Some((l, q, a)) = cur.take()
            && !(q && a)
        {
            sink.err(l, "each item needs a `Q:` line, then an `A:` line");
        }
    };
    let mut seen_h1 = false;
    for (i, raw) in text.lines().enumerate() {
        let ln = i + 1;
        let t = raw.trim_end();
        if let Some(h) = t.strip_prefix("# ") {
            if !h.starts_with(&format!("Retrieval {id}: ")) {
                sink.err(
                    ln,
                    format!("title must be `# Retrieval {id}: <chapter title>`"),
                );
            }
            seen_h1 = true;
            continue;
        }
        if let Some(h) = t.strip_prefix("## ") {
            finish(&mut cur, &mut sink);
            items += 1;
            if h != format!("R{items}") {
                sink.err(
                    ln,
                    format!("items are `## R1`, `## R2`, … in order; expected `## R{items}`"),
                );
            }
            cur = Some((ln, false, false));
            continue;
        }
        if let Some(c) = cur.as_mut() {
            if t.starts_with("Q: ") {
                if c.1 {
                    sink.err(ln, "a second `Q:` in one item");
                }
                c.1 = true;
            } else if t.starts_with("A: ") {
                if !c.1 || c.2 {
                    sink.err(ln, "`A:` must follow the item's `Q:`, once");
                }
                c.2 = true;
            }
        }
        for p in notation_problems(t) {
            sink.err(ln, p);
        }
    }
    finish(&mut cur, &mut sink);
    if !seen_h1 {
        sink.err(1, format!("missing `# Retrieval {id}: <chapter title>`"));
    }
    if !(BANK_MIN..=BANK_MAX).contains(&items) {
        sink.err(
            1,
            format!("{items} items; a bank has {BANK_MIN} to {BANK_MAX}"),
        );
    }
}

/// `## Q<n>` sections (and `## Predict`) of a journal or rubric: (name, heading line, body lines).
/// A `##` section: its name (first word), heading line, and `(line, text)` body lines.
type Section = (String, usize, Vec<(usize, String)>);

fn h2_sections(text: &str) -> Vec<Section> {
    let mut out: Vec<Section> = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        if let Some(h) = raw.strip_prefix("## ") {
            let name = h.split_whitespace().next().unwrap_or("").to_owned();
            out.push((name, i + 1, Vec::new()));
        } else if let Some(last) = out.last_mut() {
            last.2.push((i + 1, raw.to_owned()));
        }
    }
    out
}

fn check_q_sequence(sink: &mut Sink, secs: &[Section]) -> usize {
    let mut n = 0usize;
    for (name, ln, _) in secs {
        if name == "Predict" {
            if n > 0 {
                sink.err(*ln, "`## Predict` comes before `## Q1`");
            }
            continue;
        }
        n += 1;
        if *name != format!("Q{n}") {
            sink.err(*ln, format!("expected `## Q{n}`, found `## {name}`"));
        }
    }
    n
}

/// Check `course/journal/NN.md`; `expect` is `(questions, predict)` from `checkpoint.toml`.
pub fn check_journal(
    rel: &str,
    id: &str,
    text: &str,
    expect: Option<(usize, bool)>,
    out: &mut Vec<Diag>,
) -> usize {
    let mut sink = Sink {
        path: rel.to_owned(),
        out,
    };
    if !text.starts_with(&format!("# Journal {id}: ")) {
        sink.err(
            1,
            format!("first line must be `# Journal {id}: <chapter title>`"),
        );
    }
    let secs = h2_sections(text);
    let n = check_q_sequence(&mut sink, &secs);
    for (name, ln, body) in &secs {
        if !body.iter().any(|(_, l)| l.starts_with("> ")) {
            sink.err(*ln, format!("`## {name}` needs its prompt as a `> ` quote"));
        }
    }
    if let Some((_, ln, body)) = secs.iter().rev().find(|(n, _, _)| n.starts_with('Q'))
        && !body.iter().any(|(_, l)| l.starts_with("> *Transfer"))
    {
        sink.warn(
            *ln,
            "the last question should be the transfer question (`> *Transfer …*`)",
        );
    }
    let has_predict = secs.iter().any(|(n, _, _)| n == "Predict");
    match expect {
        Some((q, p)) => {
            if q != n {
                sink.err(
                    1,
                    format!("{n} questions, but checkpoint.toml says questions = {q}"),
                );
            }
            if p != has_predict {
                sink.err(
                    1,
                    format!(
                        "checkpoint.toml says predict = {p}; `## Predict` present: {has_predict}"
                    ),
                );
            }
        }
        None => sink.warn(
            1,
            "no checkpoint.toml [journal] to compare the question count with",
        ),
    }
    for (i, l) in text.lines().enumerate() {
        for p in notation_problems(l) {
            sink.err(i + 1, p);
        }
        for p in style_problems(l) {
            if p.contains("write \"chapter") {
                sink.warn(i + 1, p);
            }
        }
    }
    n
}

/// Check `course/journal/NN.rubric.md` against the journal's question count.
pub fn check_rubric(rel: &str, id: &str, text: &str, questions: usize, out: &mut Vec<Diag>) {
    let mut sink = Sink {
        path: rel.to_owned(),
        out,
    };
    if !text.starts_with(&format!("# Rubric {id}: ")) {
        sink.err(
            1,
            format!("first line must be `# Rubric {id}: <chapter title>`"),
        );
    }
    let secs = h2_sections(text);
    let n = check_q_sequence(&mut sink, &secs);
    if n != questions {
        sink.err(1, format!("{n} questions; the journal has {questions}"));
    }
    for (name, ln, body) in &secs {
        if !body.iter().any(|(_, l)| l.starts_with("- ")) {
            sink.err(
                *ln,
                format!("`## {name}` needs at least one `- ` idea a strong answer contains"),
            );
        }
    }
    for (i, l) in text.lines().enumerate() {
        for p in notation_problems(l) {
            sink.err(i + 1, p);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The lesson itself

/// What a body line is.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Line {
    Blank,
    Fence,
    Code,
    Open(String, String),
    Leaf(String, String),
    Close,
    Heading(usize, String),
    Quote(String),
    Item(String),
    Text(String),
}

fn classify(lines: &[&str]) -> Vec<Line> {
    let mut out = Vec::with_capacity(lines.len());
    let mut in_fence = false;
    for raw in lines {
        let t = raw.trim_end();
        if t.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push(Line::Fence);
            continue;
        }
        if in_fence {
            out.push(Line::Code);
            continue;
        }
        if t.trim().is_empty() {
            out.push(Line::Blank);
        } else if t == ":::" {
            out.push(Line::Close);
        } else if let Some(d) = t.strip_prefix(":::") {
            let (name, rest) = d.split_once(' ').unwrap_or((d, ""));
            if CONTAINERS.contains(&name) {
                out.push(Line::Open(name.to_owned(), rest.trim().to_owned()));
            } else {
                out.push(Line::Leaf(name.to_owned(), rest.trim().to_owned()));
            }
        } else if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count();
            out.push(Line::Heading(level, t[level..].trim().to_owned()));
        } else if let Some(q) = t.strip_prefix('>') {
            out.push(Line::Quote(q.trim().to_owned()));
        } else if t.trim_start().starts_with("- ") || t.trim_start().starts_with("* ") {
            out.push(Line::Item(t.trim_start()[2..].to_owned()));
        } else {
            out.push(Line::Text(t.to_owned()));
        }
    }
    out
}

/// Glossary links on a line: the slugs after `/build-your-own/vmm/glossary/#`.
fn glossary_links(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let pat = "/build-your-own/vmm/glossary/#";
    let mut s = line;
    while let Some(p) = s.find(pat) {
        let rest = &s[p + pat.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
            .unwrap_or(rest.len());
        out.push(rest[..end].to_owned());
        s = &rest[end..];
    }
    out
}

/// Inputs shared by every lesson check.
pub struct Ctx<'a> {
    pub root: &'a Path,
    pub course: &'a Course,
    pub glossary: &'a [GlossEntry],
}

/// Check one lesson file (`rel` is repo-relative) and its companions.
pub fn check_lesson(ctx: &Ctx, rel: &str, text: &str, out: &mut Vec<Diag>) {
    let mut sink = Sink {
        path: rel.to_owned(),
        out,
    };
    // The chapter id comes from the file name: course/chapters/<part>/<NN-slug>.md.
    let fname = rel.rsplit('/').next().unwrap_or(rel);
    let id: String = fname.chars().take(2).collect();
    let Some(meta) = ctx.course.chapter(&id).cloned() else {
        sink.err(
            1,
            format!(
                "file name {fname:?} does not start with a chapter id from course/chapters.json"
            ),
        );
        return;
    };
    if meta.file != rel {
        sink.err(
            1,
            format!("course/chapters.json puts chapter {id} at {}", meta.file),
        );
    }
    let fm = match parse_front_matter(text) {
        Ok(fm) => fm,
        Err((l, m)) => {
            sink.err(l, m);
            return;
        }
    };
    check_front_matter(&mut sink, &fm, &meta, ctx.course);
    let all: Vec<&str> = text.lines().collect();
    let body_start = fm.body_line.saturating_sub(1).min(all.len());
    let body = &all[body_start..];
    let lines = classify(body);
    let ln = |i: usize| i + body_start + 1;
    check_body(ctx, &mut sink, &id, &fm, body, &lines, &ln);
    check_text(ctx, &mut sink, body, &lines, &ln);
    check_companions(ctx, sink.out, &id);
}

fn check_front_matter(sink: &mut Sink, fm: &FrontMatter, meta: &ChapterMeta, course: &Course) {
    let id = &meta.id;
    for k in FM_REQUIRED {
        if fm.get(k).is_none() {
            sink.err(
                1,
                format!(
                    "front matter lacks `{k}` (CURRICULUM §7 item 1 fields; see STYLE appendix A)"
                ),
            );
        }
    }
    for (k, _, l) in &fm.fields {
        if !FM_REQUIRED.contains(&k.as_str()) && !FM_OPTIONAL.contains(&k.as_str()) {
            sink.err(*l, format!("unknown front-matter key `{k}`"));
        }
    }
    let eq = |sink: &mut Sink, key: &str, want: &str, hard: bool| {
        if let Some(v) = fm.str(key)
            && v != want
        {
            let m = format!("`{key}: {v}` but course/chapters.json says {want:?}");
            if hard {
                sink.err(fm.line(key), m);
            } else {
                sink.warn(fm.line(key), m);
            }
        }
    };
    eq(sink, "id", id, true);
    eq(sink, "part", &meta.part, true);
    eq(sink, "chapter", &meta.number, true);
    eq(sink, "title", &meta.title, true);
    eq(sink, "runs", &meta.runs, false);
    eq(sink, "minutes", &meta.minutes, false);
    eq(
        sink,
        "command",
        &format!("scripts/checkpoint.sh {id}"),
        true,
    );
    eq(sink, "expect", &format!("CHECKPOINT {id} PASS"), true);
    if let Some(r) = fm.str("runs")
        && !matches!(r, "mac" | "browser" | "mac+browser")
    {
        sink.err(fm.line("runs"), "`runs` is mac, browser or mac+browser");
    }
    if let Some(m) = fm.str("minutes")
        && m.parse::<u32>().map_or(true, |v| v == 0)
    {
        sink.err(fm.line("minutes"), "`minutes` is a positive whole number");
    }
    for key in ["prereqs", "labs"] {
        if matches!(fm.get(key), Some(FmValue::Str(_))) {
            sink.err(
                fm.line(key),
                format!("`{key}` is a list (`[a, b]` or `[]`)"),
            );
        }
    }
    if let Some(p) = fm.list("prereqs") {
        for x in p {
            if course.chapter(x).is_none() || x.as_str() >= id.as_str() {
                sink.err(
                    fm.line("prereqs"),
                    format!("prerequisite {x:?} is not an earlier chapter id"),
                );
            }
        }
        if p != meta.prereqs.as_slice() {
            sink.warn(
                fm.line("prereqs"),
                format!(
                    "prereqs {p:?}; course/chapters.json says {:?}",
                    meta.prereqs
                ),
            );
        }
    }
    if let Some(l) = fm.list("labs") {
        for x in l {
            if !course.labs.contains(x) {
                sink.err(
                    fm.line("labs"),
                    format!("unknown lab {x:?} (not in course/chapters.json)"),
                );
            }
        }
        if l != meta.labs.as_slice() {
            sink.warn(
                fm.line("labs"),
                format!("labs {l:?}; course/chapters.json says {:?}", meta.labs),
            );
        }
    }
    if let Some(t) = fm.str("start_tag") {
        let ok = t.len() == 5 && t.starts_with("ch-") && t[3..].chars().all(|c| c.is_ascii_digit());
        if !ok && t != "none" {
            sink.warn(
                fm.line("start_tag"),
                "start_tag is `ch-NN` (the reference at the end of chapter NN) or `none`",
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn check_body(
    ctx: &Ctx,
    sink: &mut Sink,
    id: &str,
    fm: &FrontMatter,
    body: &[&str],
    lines: &[Line],
    ln: &dyn Fn(usize) -> usize,
) {
    let num: u32 = id.parse().unwrap_or(0);
    // Directive structure.
    let mut open: Option<(String, usize, usize)> = None; // (name, index, content lines)
    let mut first_content: Option<usize> = None;
    let mut retrieval = None;
    let mut concepts: Option<(usize, usize)> = None;
    let mut objectives: Option<(usize, usize)> = None;
    let mut checkpoints = Vec::new();
    let mut predicts = 0usize;
    let mut stops = Vec::new();
    let mut labs_used = BTreeSet::new();
    let mut h2: Vec<(usize, String)> = Vec::new();
    let mut h3: Vec<(usize, String)> = Vec::new();
    let mut callouts = 0usize;
    let mut fence_open: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        if first_content.is_none() && *l != Line::Blank {
            first_content = Some(i);
        }
        match l {
            Line::Fence => {
                if fence_open.take().is_none() {
                    fence_open = Some(i);
                    let lang = body[i].trim().trim_start_matches('`').trim();
                    if !FENCE_LANGS.contains(&lang) {
                        sink.err(ln(i), format!(
                            "a `{lang}` code fence: program code appears only through `:::code anchor=… file=…`"
                        ));
                    }
                    if lang.is_empty() {
                        sink.warn(
                            ln(i),
                            "label the fence (`sh` for commands, `text` for output or diagrams)",
                        );
                    }
                }
            }
            Line::Open(name, rest) => {
                if let Some((o, oi, _)) = &open {
                    sink.err(
                        ln(i),
                        format!("`:::{name}` inside `:::{o}` (opened at line {})", ln(*oi)),
                    );
                }
                if name == "predict" {
                    predicts += 1;
                    if rest.is_empty() {
                        sink.err(ln(i), "`:::predict` needs its question on the same line");
                    }
                }
                if name == "callout" {
                    sink.warn(ln(i), "write callouts as STYLE §7 blockquotes (`> **Aside.** …`), not `:::callout`");
                }
                if name == "prereqs" {
                    sink.err(
                        ln(i),
                        "chapters use `:::concepts` (it is rendered as the prerequisites box)",
                    );
                }
                open = Some((name.clone(), i, 0));
            }
            Line::Close => match open.take() {
                None => sink.err(ln(i), "`:::` closes nothing"),
                Some((name, oi, content)) => {
                    if content == 0 {
                        sink.err(ln(oi), format!("`:::{name}` is empty"));
                    }
                    match name.as_str() {
                        "concepts" => concepts = Some((oi, i)),
                        "objectives" => {
                            if objectives.is_some() {
                                sink.err(ln(oi), "more than one `:::objectives`");
                            }
                            objectives = Some((oi, i));
                        }
                        _ => {}
                    }
                }
            },
            Line::Leaf(name, rest) => {
                if let Some(o) = open.as_mut() {
                    o.2 += 1;
                }
                if !LEAVES.contains(&name.as_str()) {
                    sink.err(
                        ln(i),
                        format!("unknown directive `:::{name}` (see DESIGN.md §9)"),
                    );
                    continue;
                }
                let args = directive_args(rest);
                match name.as_str() {
                    "retrieval" => {
                        if retrieval.is_some() {
                            sink.err(ln(i), "more than one `:::retrieval`");
                        }
                        retrieval = Some(i);
                        if let Some(from) = args.get("from") {
                            for src in from.split(',') {
                                if ctx.course.chapter(src).is_none() || src >= id {
                                    sink.err(
                                        ln(i),
                                        format!(
                                            "retrieval source {src:?} is not an earlier chapter"
                                        ),
                                    );
                                } else if !ctx
                                    .root
                                    .join(format!("course/retrieval/{src}.md"))
                                    .is_file()
                                {
                                    sink.warn(ln(i), format!("retrieval bank course/retrieval/{src}.md does not exist yet"));
                                }
                            }
                        }
                    }
                    "checkpoint" => checkpoints.push(i),
                    "stopping-point" => {
                        stops.push(i);
                        if rest.is_empty() {
                            sink.err(ln(i), "`:::stopping-point` needs a short label");
                        }
                    }
                    "lab" => {
                        let lab = rest.split_whitespace().next().unwrap_or("");
                        if !fm.list("labs").is_some_and(|l| l.iter().any(|x| x == lab)) {
                            sink.err(
                                ln(i),
                                format!("`:::lab {lab}` is not in the front matter's `labs`"),
                            );
                        }
                        labs_used.insert(lab.to_owned());
                    }
                    "code" => {
                        if !args.contains_key("anchor") || !args.contains_key("file") {
                            sink.err(ln(i), "`:::code` needs both `anchor=NAME` and `file=PATH`");
                        }
                    }
                    "term" => match args.get("source") {
                        None => sink.err(ln(i), "`:::term` needs `source=captures/NN-name.txt`"),
                        Some(src) => check_capture_ref(ctx.root, sink, ln(i), src),
                    },
                    "diagram" => {
                        let src = args.get("src").cloned().unwrap_or_default();
                        if src.is_empty() || !args.contains_key("alt") {
                            sink.err(ln(i), "`:::diagram` needs `src=` and `alt=\"…\"`");
                        } else if src.contains("..") || !ctx.root.join(&src).is_file() {
                            sink.err(ln(i), format!("diagram {src:?} does not exist"));
                        }
                    }
                    _ => {}
                }
            }
            Line::Heading(level, text) => {
                if let Some((o, oi, _)) = &open {
                    sink.err(
                        ln(i),
                        format!("heading inside `:::{o}` (opened at line {})", ln(*oi)),
                    );
                }
                match level {
                    1 => sink.err(
                        ln(i),
                        "no `#` heading in a chapter body: the page title comes from `title:`",
                    ),
                    2 => h2.push((i, text.clone())),
                    3 => h3.push((i, text.clone())),
                    _ => sink.err(ln(i), "headings stop at `###` (STYLE §9)"),
                }
            }
            Line::Quote(q) => {
                if let Some(o) = open.as_mut() {
                    o.2 += 1;
                }
                if q.trim_start().starts_with(":::") {
                    sink.err(ln(i), "a directive inside a blockquote is invisible to the renderer and to check-anchors; put it after the callout");
                }
                if let Some(label) = q
                    .strip_prefix("**")
                    .and_then(|r| r.split_once(".**"))
                    .map(|(l, _)| l)
                {
                    if label == "Predict" {
                        sink.err(
                            ln(i),
                            "a Predict is a `:::predict Question` block with the answer inside",
                        );
                    } else if CALLOUTS.contains(&label) {
                        callouts += 1;
                    } else {
                        sink.err(
                            ln(i),
                            format!(
                                "callout label {label:?} is not one of STYLE §7's: {}",
                                CALLOUTS.join(", ")
                            ),
                        );
                    }
                }
            }
            Line::Item(_) | Line::Text(_) | Line::Code => {
                if let Some(o) = open.as_mut() {
                    o.2 += 1;
                }
                if let Line::Text(t) = l
                    && t.trim_start().starts_with('<')
                {
                    sink.err(
                        ln(i),
                        "raw HTML (comments included) is escaped by the renderer; remove it",
                    );
                }
            }
            Line::Blank => {}
        }
    }
    if let Some((o, oi, _)) = open {
        sink.err(ln(oi), format!("`:::{o}` is never closed"));
    }
    if let Some(f) = fence_open {
        sink.err(ln(f), "code fence is never closed");
    }

    // Required blocks and their order (CURRICULUM §7 items 2 to 9).
    let end = lines.len();
    match (retrieval, num) {
        (None, n) if n > 0 => sink.err(
            1,
            "missing `:::retrieval` (the warm-up; first block of the body)",
        ),
        (Some(r), _) if Some(r) != first_content => {
            sink.err(ln(r), "`:::retrieval` must be the first block of the body")
        }
        _ => {}
    }
    let Some((c_open, c_close)) = concepts else {
        sink.err(
            1,
            "missing the `:::concepts` box (\"Concepts you'll need\")",
        );
        return;
    };
    if retrieval.is_none() && first_content != Some(c_open) {
        sink.err(
            ln(c_open),
            "`:::concepts` must be the first block (after `:::retrieval`)",
        );
    }
    check_concepts(ctx, sink, &body[c_open + 1..c_close], ln(c_open));
    let Some((o_open, o_close)) = objectives else {
        sink.err(1, "missing `:::objectives`");
        return;
    };
    if o_open < c_close {
        sink.err(
            ln(o_open),
            "`:::objectives` comes after the Concepts box and the opening puzzle",
        );
    }
    let puzzle: Vec<&str> = (c_close + 1..o_open.max(c_close + 1))
        .filter(|&i| matches!(lines[i], Line::Text(_) | Line::Item(_) | Line::Quote(_)))
        .map(|i| body[i])
        .collect();
    if puzzle.is_empty() {
        sink.err(
            ln(c_close),
            "no opening puzzle: prose between `:::concepts` and `:::objectives`",
        );
    } else if num > 0
        && !puzzle
            .iter()
            .any(|l| l.to_ascii_lowercase().contains("ledger"))
    {
        sink.err(
            ln(c_close + 1),
            "the opening puzzle cites the ledger row this chapter closes (the word \"ledger\")",
        );
    }
    if let Some((i, _)) = h2.iter().find(|(i, _)| *i < o_open) {
        sink.err(
            ln(*i),
            "no `##` section before `:::objectives`: the puzzle opens the page",
        );
    }
    let items = (o_open + 1..o_close)
        .filter(|&i| matches!(lines[i], Line::Item(_)))
        .count();
    if items < 2 {
        sink.err(ln(o_open), "`:::objectives` lists at least two objectives");
    }
    for (i, l) in body.iter().enumerate().take(o_close).skip(o_open + 1) {
        if l.to_ascii_lowercase().contains("understand") {
            sink.err(
                ln(i),
                "objectives use measurable verbs, never \"understand\"",
            );
        }
    }
    if num >= 2 && predicts == 0 {
        sink.err(
            1,
            "at least one `:::predict` (every chapter from Part I on)",
        );
    }
    for lab in fm.list("labs").unwrap_or(&[]) {
        if !labs_used.contains(lab) {
            sink.warn(1, format!("lab {lab:?} is in `labs` but has no `:::lab {lab}` (fine if a primer embeds it)"));
        }
    }

    // ## Checkpoint, then ## Spec hunt, last.
    let cp = h2.iter().position(|(_, t)| t == "Checkpoint");
    let sh = h2.iter().position(|(_, t)| t == "Spec hunt");
    let Some(cp) = cp else {
        sink.err(1, "missing `## Checkpoint`");
        return;
    };
    match sh {
        None => sink.err(1, "missing `## Spec hunt`"),
        Some(s) if s + 1 != h2.len() => sink.err(ln(h2[s].0), "`## Spec hunt` is the last section"),
        Some(s) if s != cp + 1 => sink.err(
            ln(h2[cp].0),
            "`## Checkpoint` is followed directly by `## Spec hunt`",
        ),
        _ => {}
    }
    if h2.iter().filter(|(_, t)| t == "Checkpoint").count() > 1 {
        sink.err(1, "more than one `## Checkpoint`");
    }
    if cp == 0 {
        sink.err(
            ln(h2[cp].0),
            "the body needs its own `##` sections before `## Checkpoint`",
        );
    }
    let cp_start = h2[cp].0;
    let cp_end = h2.get(cp + 1).map_or(end, |(i, _)| *i);
    match checkpoints.as_slice() {
        [c] if (cp_start..cp_end).contains(c) => {}
        [] => sink.err(ln(cp_start), "`## Checkpoint` needs a `:::checkpoint` line"),
        [c] => sink.err(ln(*c), "`:::checkpoint` belongs in `## Checkpoint`"),
        _ => sink.err(1, "exactly one `:::checkpoint`"),
    }
    let terms_in_cp =
        (cp_start..cp_end).any(|i| matches!(&lines[i], Line::Leaf(n, _) if n == "term"));
    if !terms_in_cp {
        sink.err(
            ln(cp_start),
            "`## Checkpoint` shows the expected output with `:::term source=captures/…`",
        );
    }
    let wn = h3
        .iter()
        .find(|(i, t)| (cp_start..cp_end).contains(i) && t == "What's next");
    let oq = h3
        .iter()
        .find(|(i, t)| (cp_start..cp_end).contains(i) && t == "Open question");
    match (wn, oq) {
        (Some((w, _)), Some((o, _))) if w < o => {
            let has_q = (*o..cp_end).any(|i| body[i].contains('?'));
            if !has_q {
                sink.err(ln(*o), "`### Open question` asks a question");
            }
        }
        (Some(_), Some((o, _))) => {
            sink.err(ln(*o), "`### What's next` comes before `### Open question`")
        }
        _ => sink.err(
            ln(cp_start),
            "`## Checkpoint` ends with `### What's next` then `### Open question`",
        ),
    }
    if let Some(s) = sh {
        let s_start = h2[s].0;
        let n = (s_start..end)
            .filter(|&i| matches!(lines[i], Line::Item(_)) && body[i].starts_with("- "))
            .count();
        if !(2..=3).contains(&n) {
            sink.err(
                ln(s_start),
                format!("`## Spec hunt` has {n} items; it has 2 or 3"),
            );
        }
        for (i, l) in body.iter().enumerate().take(end).skip(s_start) {
            if l.starts_with("- ") && !l.contains('?') {
                sink.warn(
                    ln(i),
                    "each spec-hunt item pairs a source with the question it answers (`?`)",
                );
            }
        }
    }
    for &s in &stops {
        if s < o_close || s > cp_start {
            sink.err(
                ln(s),
                "`:::stopping-point` sits in the body, between the objectives and the checkpoint",
            );
        }
    }
    if callouts > MAX_CALLOUTS {
        sink.warn(
            1,
            format!("{callouts} callouts; STYLE §7 says about {MAX_CALLOUTS} per chapter"),
        );
    }
}

fn check_capture_ref(root: &Path, sink: &mut Sink, line: usize, src: &str) {
    let Some(name) = src.strip_prefix("captures/") else {
        sink.err(
            line,
            format!("capture {src:?} must be `captures/NN-name.txt` (relative to course/)"),
        );
        return;
    };
    if name.contains('/') || !valid_capture_name(name) {
        sink.err(
            line,
            format!("capture name {name:?} must be `NN-name.txt` (lowercase, digits, dashes)"),
        );
        return;
    }
    let path = root.join("course").join(src);
    match crate::checkpoint::read_capped(&path, MAX_TEXT) {
        Err(_) => sink.err(
            line,
            format!("capture course/{src} does not exist: capture it on your Mac first"),
        ),
        Ok(t) => {
            if !name.ends_with(".jsonl") && !t.starts_with("# ") {
                sink.err(line, format!("capture course/{src} has no `# ` provenance header (use scripts/capture.sh or scripts/capture-cmd)"));
            }
        }
    }
}

/// `text` with every parenthesised part (nesting included) removed.
fn without_parens(text: &str) -> String {
    let mut depth = 0usize;
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn check_concepts(ctx: &Ctx, sink: &mut Sink, inner: &[&str], first: usize) {
    let mut found: Vec<(usize, usize)> = Vec::new(); // (group index, line offset)
    let mut group: Option<usize> = None;
    for (k, raw) in inner.iter().enumerate() {
        let t = raw.trim_start();
        if let Some(rest) = t.strip_prefix("- **") {
            let label = rest.split(":**").next().unwrap_or("");
            if let Some(g) = CONCEPT_GROUPS.iter().position(|x| *x == label) {
                found.push((g, k));
                group = Some(g);
            } else if !raw.starts_with(' ') {
                sink.err(
                    first + k + 1,
                    format!(
                        "unknown Concepts group {label:?}; the groups are {}",
                        CONCEPT_GROUPS.join(" / ")
                    ),
                );
            }
        }
        // Backticked primer slugs anywhere in the box must exist. In the primer groups, a
        // backticked word outside parentheses is a primer reference; inside them it is part of
        // the description (`x0`, `movz`).
        let scan = if matches!(group, Some(2 | 3)) {
            without_parens(raw)
        } else {
            (*raw).to_owned()
        };
        for s in scan.split('`').skip(1).step_by(2) {
            let is_slug = !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !is_slug {
                continue;
            }
            if ctx.course.primers.contains(s) {
                if !ctx.root.join(format!("course/primers/{s}.md")).is_file() {
                    sink.err(
                        first + k + 1,
                        format!("primer course/primers/{s}.md does not exist"),
                    );
                }
            } else if matches!(group, Some(2 | 3)) {
                sink.err(
                    first + k + 1,
                    format!("`{s}` is not a primer slug; name non-primers in plain words"),
                );
            }
        }
    }
    let order: Vec<usize> = found.iter().map(|(g, _)| *g).collect();
    if order.windows(2).any(|w| w[0] >= w[1]) {
        sink.err(
            first,
            format!(
                "Concepts groups out of order or repeated; the order is {}",
                CONCEPT_GROUPS.join(" / ")
            ),
        );
    }
    for (g, name) in CONCEPT_GROUPS.iter().enumerate() {
        if matches!(g, 2 | 3) {
            continue;
        }
        if !order.contains(&g) {
            sink.err(
                first,
                format!("Concepts box lacks `- **{name}:**` (write \"none\" if empty)"),
            );
        }
    }
    if !order.contains(&2) && !order.contains(&3) {
        sink.err(
            first,
            "Concepts box lacks `- **Primers (read first):**` or `- **Primers (review):**`",
        );
    }
}

fn check_text(
    ctx: &Ctx,
    sink: &mut Sink,
    body: &[&str],
    lines: &[Line],
    ln: &dyn Fn(usize) -> usize,
) {
    let slugs: BTreeSet<String> = ctx.glossary.iter().map(|g| slug(&g.term)).collect();
    let mut words = 0usize;
    let mut plain_lines: Vec<(usize, String)> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if matches!(l, Line::Code | Line::Fence) {
            continue;
        }
        if matches!(l, Line::Leaf(n, _) if n == "code" || n == "term" || n == "diagram") {
            continue;
        }
        let raw = body[i];
        for p in notation_problems(raw) {
            sink.err(ln(i), p);
        }
        for p in style_problems(raw) {
            sink.warn(ln(i), p);
        }
        for s in glossary_links(raw) {
            if !slugs.contains(&s) {
                sink.err(
                    ln(i),
                    format!("glossary link #{s} has no entry in course/GLOSSARY.md"),
                );
            }
        }
        // A capture path mentioned in prose must exist too.
        for (p, _) in raw.match_indices("captures/") {
            let rest = &raw[p + "captures/".len()..];
            let name: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
                .collect();
            let name = name.trim_end_matches('.');
            if valid_capture_name(name) && !ctx.root.join("course/captures").join(name).is_file() {
                sink.err(ln(i), format!("capture captures/{name} does not exist"));
            }
        }
        let p = strip_code_spans(raw);
        words += p
            .split_whitespace()
            .filter(|w| w.chars().any(char::is_alphanumeric))
            .count();
        plain_lines.push((i, p));
    }
    if words > MAX_WORDS {
        sink.warn(
            1,
            format!("about {words} words; STYLE §8 says split a chapter above {MAX_WORDS}"),
        );
    }
    // Acronyms: the first plain-text use on the page should carry its expansion nearby.
    for g in ctx.glossary {
        let Some(exp) = &g.expansion else { continue };
        let acronym = g.term.as_str();
        let is_acronym = acronym.len() >= 2
            && acronym
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && acronym.chars().any(|c| c.is_ascii_uppercase());
        if !is_acronym {
            continue;
        }
        let first = plain_lines
            .iter()
            .find(|(_, p)| tokens(p).iter().any(|(_, t)| *t == acronym));
        let Some((i, _)) = first else { continue };
        let pos = plain_lines.iter().position(|(j, _)| j == i).unwrap_or(0);
        let window: String = plain_lines
            .iter()
            .skip(pos.saturating_sub(2))
            .take(5)
            .map(|(_, p)| p.to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        let key = exp.to_ascii_lowercase();
        let key_word = key.split_whitespace().next().unwrap_or("");
        if !window.contains(&key) && !(key_word.len() > 3 && window.contains(key_word)) {
            sink.warn(
                ln(*i),
                format!("first use of {acronym}: expand it here ({exp})"),
            );
        }
    }
}

fn missing(out: &mut Vec<Diag>, path: String, what: &str) {
    out.push(Diag {
        path,
        line: 1,
        level: Level::Error,
        msg: format!("missing {what} (STYLE appendix A)"),
    });
}

fn check_companions(ctx: &Ctx, out: &mut Vec<Diag>, id: &str) {
    let rrel = format!("course/retrieval/{id}.md");
    match read(ctx.root, &rrel) {
        Ok(t) => check_retrieval(&rrel, id, &t, out),
        Err(_) => missing(out, rrel, "the chapter's retrieval bank"),
    }
    let jrel = format!("course/journal/{id}.md");
    let expect = crate::checkpoint::load(ctx.root, id)
        .ok()
        .and_then(|c| c.journal)
        .map(|j| (j.questions, j.predict));
    let questions = match read(ctx.root, &jrel) {
        Ok(t) => Some(check_journal(&jrel, id, &t, expect, out)),
        Err(_) => {
            missing(out, jrel, "the chapter's journal template");
            None
        }
    };
    let rub = format!("course/journal/{id}.rubric.md");
    match (read(ctx.root, &rub), questions) {
        (Ok(t), Some(q)) => check_rubric(&rub, id, &t, q, out),
        (Ok(_), None) => {}
        (Err(_), _) => missing(out, rub, "the journal rubric"),
    }
}

// ---------------------------------------------------------------------------------------------
// Driver

fn lessons_under(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let dir = root.join(CHAPTERS_DIR);
    let Ok(parts) = fs::read_dir(&dir) else {
        return out;
    };
    for p in parts.flatten() {
        if !p.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(p.path()) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            if name.ends_with(".md") && f.file_type().is_ok_and(|t| t.is_file()) {
                out.push(format!(
                    "{CHAPTERS_DIR}/{}/{name}",
                    p.file_name().to_string_lossy()
                ));
            }
        }
    }
    out.sort();
    out
}

/// Resolve a command-line argument (a path or a chapter id) to a repo-relative lesson path.
fn resolve_arg(root: &Path, course: &Course, arg: &str) -> Result<String, String> {
    if arg.len() == 2 && arg.chars().all(|c| c.is_ascii_digit()) {
        return course
            .chapter(arg)
            .map(|c| c.file.clone())
            .ok_or_else(|| format!("no chapter {arg}"));
    }
    let p = PathBuf::from(arg);
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(p)
    };
    let abs = abs.canonicalize().map_err(|e| format!("{arg}: {e}"))?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let rel = abs
        .strip_prefix(&root)
        .map_err(|_| format!("{arg}: not inside the repository"))?
        .to_string_lossy()
        .replace('\\', "/");
    if !(rel.starts_with(&format!("{CHAPTERS_DIR}/")) && rel.ends_with(".md")) {
        return Err(format!(
            "{arg}: not a lesson (course/chapters/<part>/<NN-slug>.md)"
        ));
    }
    Ok(rel)
}

/// Run the lint over `args` (paths or chapter ids), or every lesson when `args` is empty.
pub fn run(root: &Path, args: &[String]) -> Result<Report, String> {
    let course_text = read(root, "course/chapters.json")?;
    let course = parse_course(&course_text)?;
    let mut report = Report::default();
    let glossary = match read(root, "course/GLOSSARY.md") {
        Ok(t) => check_glossary(&t, &course, &mut report.diags),
        Err(_) => {
            report.diags.push(Diag {
                path: "course/GLOSSARY.md".into(),
                line: 1,
                level: Level::Error,
                msg: "missing".into(),
            });
            Vec::new()
        }
    };
    let files = if args.is_empty() {
        lessons_under(root)
    } else {
        args.iter()
            .map(|a| resolve_arg(root, &course, a))
            .collect::<Result<Vec<_>, _>>()?
    };
    let ctx = Ctx {
        root,
        course: &course,
        glossary: &glossary,
    };
    for rel in &files {
        let text = read(root, rel)?;
        check_lesson(&ctx, rel, &text, &mut report.diags);
        report.lessons += 1;
    }
    if args.is_empty()
        && let Ok(rd) = fs::read_dir(root.join("course/captures"))
    {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !valid_capture_name(&name) {
                report.diags.push(Diag {
                    path: format!("course/captures/{name}"),
                    line: 1,
                    level: Level::Warning,
                    msg: "capture names are `NN-name.txt` or `NN-name.trace.jsonl`".into(),
                });
            }
        }
    }
    check_code_refs(root, &files, &mut report.diags)?;
    report
        .diags
        .sort_by(|a, b| (&a.path, a.line, a.level).cmp(&(&b.path, b.line, b.level)));
    report.diags.dedup();
    Ok(report)
}

/// Every `:::code anchor=… file=…` resolves to an ANCHOR region (the check-anchors scanner),
/// and the comments inside every region a lesson shows are free of author notation
/// ([`code_notation_problems`]): a learner reads them on the page.
fn check_code_refs(root: &Path, files: &[String], out: &mut Vec<Diag>) -> Result<(), String> {
    type Scanned = Option<(anchors::Syntax, String, Vec<anchors::Region>)>;
    let mut cache: BTreeMap<String, Scanned> = BTreeMap::new();
    // (file, anchor) -> the first lesson line that shows it.
    let mut shown: BTreeMap<(String, String), (String, usize)> = BTreeMap::new();
    for rel in files {
        let text = read(root, rel)?;
        for r in anchors::references(rel, &text) {
            let scanned = cache.entry(r.file.clone()).or_insert_with(|| {
                if r.file.contains("..") || r.file.starts_with('/') {
                    return None;
                }
                let syntax = anchors::Syntax::for_path(&r.file)?;
                let src = fs::read_to_string(root.join(&r.file)).ok()?;
                let (regions, _) = anchors::scan(&r.file, &src, syntax);
                let regions = regions
                    .into_iter()
                    .filter(|g| g.keyword == anchors::Keyword::Anchor)
                    .collect();
                Some((syntax, src, regions))
            });
            let msg = match scanned {
                None => Some(format!(
                    "`:::code` file {:?} does not exist or cannot hold anchors",
                    r.file
                )),
                Some((_, _, regions)) if !regions.iter().any(|g| g.name == r.anchor) => {
                    Some(format!(
                        "anchor {:?} not found in {} (run scripts/check-anchors)",
                        r.anchor, r.file
                    ))
                }
                _ => {
                    shown
                        .entry((r.file.clone(), r.anchor.clone()))
                        .or_insert_with(|| (rel.clone(), r.line));
                    None
                }
            };
            if let Some(msg) = msg {
                out.push(Diag {
                    path: rel.clone(),
                    line: r.line,
                    level: Level::Error,
                    msg,
                });
            }
        }
    }
    for ((file, anchor), (lesson, at)) in &shown {
        let Some(Some((syntax, src, regions))) = cache.get(file) else {
            continue;
        };
        let Some(region) = regions.iter().find(|g| &g.name == anchor) else {
            continue;
        };
        let lines: Vec<&str> = src.lines().collect();
        // Lines strictly between the markers (1-based start_line is the marker itself).
        for idx in region.start_line..region.end_line.saturating_sub(1) {
            let Some(raw) = lines.get(idx) else { break };
            if anchors::is_marker(raw, *syntax) {
                continue;
            }
            for p in code_notation_problems(comment_text(raw, *syntax)) {
                out.push(Diag {
                    path: file.clone(),
                    line: idx + 1,
                    level: Level::Error,
                    msg: format!(
                        "anchor {anchor:?} (shown by {lesson}:{at}): {p}; learners read this \
                         comment, so say it in plain words or point at a file"
                    ),
                });
            }
        }
    }
    Ok(())
}
