//! `cargo xtask check-anchors`: keep lessons and code in sync (ADR-0006).
//!
//! **Why:** lessons quote real code through `:::code anchor=<name> file=<path>`, never pasted
//! text, so a snippet cannot silently drift. This checker is the build-time half of that
//! contract: it fails when a lesson points at a file or anchor that does not exist, and when a
//! file's markers are malformed. The site builder (`course/site/lib/anchors.mjs`) implements the
//! same rules; `crates/xtask/tests/anchors.rs` is the shared corpus.
//!
//! **Marker lines** (ADR-0006 §1). A marker is a whole line, after trimming, of the form
//! `<open> ANCHOR: <name> <close>` or `<open> ANCHOR_END: <name> <close>`, using the file's
//! comment syntax: `//` (Rust, C, JS, Swift; also `/* … */` in C and assembly), `#` (shell,
//! TOML, Python, YAML, extensionless scripts), `#` **or** `/* … */` in linker scripts (`.ld`), or
//! `<!-- … -->` (Markdown, HTML, XML/plist). Linker scripts accept both because ADR-0006 names
//! `#` (which LLVM lld, the linker our `aarch64-unknown-none` guests use, accepts) while
//! `/* … */` is the only comment form GNU ld also understands; `//` is not a linker-script
//! comment in either linker and is not a marker there. Prose
//! that merely *mentions* a marker in backticks is not a marker, and Markdown code fences are
//! skipped. Names match `^[a-z][a-z0-9_]*$`.
//!
//! **Errors:** unterminated, duplicate (within a file), `ANCHOR_END` without start, partial
//! overlap (nesting is fine), empty region, region longer than [`MAX_REGION_LINES`], invalid
//! name, and lesson references to a missing file or anchor. **Warnings:** anchors no lesson
//! references, and names used in more than one file.
//!
//! The same machinery validates `LEARNER:` / `LEARNER_END:` hole markers (M27), which follow the
//! same nesting rules but have no length limit and are not referenced by lessons.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// Lessons quote small pieces (ADR-0006 §3).
pub const MAX_REGION_LINES: usize = 60;

/// Which comment syntax a file uses for markers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Syntax {
    /// `// ANCHOR: x` (and `/* ANCHOR: x */` when `block` is set).
    Slash { block: bool },
    /// `# ANCHOR: x`
    Hash,
    /// `<!-- ANCHOR: x -->`
    Html,
    /// Linker scripts: `# ANCHOR: x` or `/* ANCHOR: x */`.
    Linker,
}

impl Syntax {
    /// Pick the syntax from a path, or `None` for files that cannot carry markers.
    pub fn for_path(path: &str) -> Option<Syntax> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let ext = name.rsplit_once('.').map(|(_, e)| e);
        match ext {
            Some("rs" | "js" | "mjs" | "cjs" | "ts" | "swift" | "m") => {
                Some(Syntax::Slash { block: false })
            }
            Some("c" | "h" | "S") => Some(Syntax::Slash { block: true }),
            Some("ld") => Some(Syntax::Linker),
            Some("sh" | "bash" | "toml" | "py" | "yml" | "yaml" | "txt") => Some(Syntax::Hash),
            Some("md" | "html" | "htm" | "xml" | "plist" | "svg") => Some(Syntax::Html),
            None => Some(Syntax::Hash), // extensionless scripts: scripts/check-anchors, init
            Some(_) => None,
        }
    }
}

/// A marker kind: the region keyword (`ANCHOR` or `LEARNER`) decides the rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Keyword {
    Anchor,
    Learner,
}

impl Keyword {
    fn start(self) -> &'static str {
        match self {
            Keyword::Anchor => "ANCHOR",
            Keyword::Learner => "LEARNER",
        }
    }
}

/// A parsed marker line.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Marker {
    keyword: Keyword,
    end: bool,
    name: String,
}

/// Recognize a marker line in the given syntax.
fn parse_marker(line: &str, syntax: Syntax) -> Option<Marker> {
    let t = line.trim();
    let inner = match syntax {
        Syntax::Slash { block } => t.strip_prefix("//").or_else(|| {
            if block {
                t.strip_prefix("/*").and_then(|r| r.strip_suffix("*/"))
            } else {
                None
            }
        }),
        Syntax::Hash => t.strip_prefix('#'),
        Syntax::Html => t.strip_prefix("<!--").and_then(|r| r.strip_suffix("-->")),
        Syntax::Linker => t
            .strip_prefix('#')
            .or_else(|| t.strip_prefix("/*").and_then(|r| r.strip_suffix("*/"))),
    }?
    .trim();
    for keyword in [Keyword::Anchor, Keyword::Learner] {
        let kw = keyword.start();
        let (end, rest) =
            if let Some(r) = inner.strip_prefix(kw).and_then(|r| r.strip_prefix("_END:")) {
                (true, r)
            } else if let Some(r) = inner.strip_prefix(kw).and_then(|r| r.strip_prefix(':')) {
                (false, r)
            } else {
                continue;
            };
        let name = rest.trim();
        if name.is_empty() || name.contains(char::is_whitespace) {
            return None;
        }
        return Some(Marker {
            keyword,
            end,
            name: name.to_owned(),
        });
    }
    None
}

/// True if `line` is an `ANCHOR`/`LEARNER` start or end marker in `syntax` (a lesson never
/// shows these lines).
pub fn is_marker(line: &str, syntax: Syntax) -> bool {
    parse_marker(line, syntax).is_some()
}

/// `^[a-z][a-z0-9_]*$`
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// One well-formed region.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub keyword: Keyword,
    pub name: String,
    /// 1-based line of the start marker.
    pub start_line: usize,
    /// 1-based line of the end marker.
    pub end_line: usize,
    /// The extracted text: lines strictly between the markers, nested marker lines dropped,
    /// common leading indentation removed (ADR-0006 §2).
    pub body: Vec<String>,
}

/// A rule violation in one file or lesson.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub line: usize,
    pub kind: ProblemKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProblemKind {
    Unterminated(String),
    Duplicate(String),
    EndWithoutStart(String),
    PartialOverlap { closing: String, open: String },
    Empty(String),
    TooLong { name: String, lines: usize },
    BadName(String),
    MissingFile(String),
    MissingAnchor { file: String, name: String },
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: ", self.path, self.line)?;
        match &self.kind {
            ProblemKind::Unterminated(n) => write!(f, "anchor {n:?} is never closed"),
            ProblemKind::Duplicate(n) => write!(f, "anchor {n:?} is defined twice in this file"),
            ProblemKind::EndWithoutStart(n) => write!(f, "end marker for {n:?} without a start"),
            ProblemKind::PartialOverlap { closing, open } => {
                write!(
                    f,
                    "{closing:?} closes while {open:?} (opened inside it) is still open"
                )
            }
            ProblemKind::Empty(n) => write!(f, "anchor {n:?} encloses no code"),
            ProblemKind::TooLong { name, lines } => {
                write!(
                    f,
                    "anchor {name:?} is {lines} lines (max {MAX_REGION_LINES})"
                )
            }
            ProblemKind::BadName(n) => {
                write!(f, "invalid anchor name {n:?} (want ^[a-z][a-z0-9_]*$)")
            }
            ProblemKind::MissingFile(p) => write!(f, "referenced file {p:?} does not exist"),
            ProblemKind::MissingAnchor { file, name } => {
                write!(f, "anchor {name:?} not found in {file:?}")
            }
        }
    }
}

/// Parse every marker of one file. Returns the well-formed regions and the problems.
pub fn scan(path: &str, text: &str, syntax: Syntax) -> (Vec<Region>, Vec<Problem>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut regions = Vec::new();
    let mut problems = Vec::new();
    let mut open: Vec<(Keyword, String, usize)> = Vec::new();
    let mut seen: BTreeMap<(String, &'static str), usize> = BTreeMap::new();
    let mut in_fence = false;
    let mut marker_lines = vec![false; lines.len()];
    let problem = |line: usize, kind: ProblemKind| Problem {
        path: path.to_owned(),
        line,
        kind,
    };

    for (idx, raw) in lines.iter().enumerate() {
        let line_no = idx + 1;
        if syntax == Syntax::Html && raw.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(m) = parse_marker(raw, syntax) else {
            continue;
        };
        marker_lines[idx] = true;
        if !valid_name(&m.name) {
            problems.push(problem(line_no, ProblemKind::BadName(m.name.clone())));
            continue;
        }
        if !m.end {
            let key = (m.name.clone(), m.keyword.start());
            if seen.insert(key, line_no).is_some() {
                problems.push(problem(line_no, ProblemKind::Duplicate(m.name.clone())));
            }
            open.push((m.keyword, m.name, line_no));
            continue;
        }
        match open
            .iter()
            .rposition(|(k, n, _)| *k == m.keyword && *n == m.name)
        {
            None => problems.push(problem(line_no, ProblemKind::EndWithoutStart(m.name))),
            Some(pos) => {
                if pos + 1 != open.len() {
                    // Something opened after this region is still open: partial overlap.
                    let inner = open[pos + 1].1.clone();
                    problems.push(problem(
                        line_no,
                        ProblemKind::PartialOverlap {
                            closing: m.name.clone(),
                            open: inner,
                        },
                    ));
                }
                let (keyword, name, start) = open.remove(pos);
                regions.push(Region {
                    keyword,
                    name,
                    start_line: start,
                    end_line: line_no,
                    body: Vec::new(),
                });
            }
        }
    }
    for (_, name, line) in open {
        problems.push(problem(line, ProblemKind::Unterminated(name)));
    }

    // Extract bodies now that every marker line is known.
    for r in &mut regions {
        let inner: Vec<&str> = (r.start_line..r.end_line.saturating_sub(1))
            .filter(|&i| !marker_lines.get(i).copied().unwrap_or(false))
            .filter_map(|i| lines.get(i).copied())
            .collect();
        r.body = dedent(&inner);
        if r.body.iter().all(|l| l.trim().is_empty()) {
            problems.push(problem(r.start_line, ProblemKind::Empty(r.name.clone())));
        } else if r.keyword == Keyword::Anchor && r.body.len() > MAX_REGION_LINES {
            problems.push(problem(
                r.start_line,
                ProblemKind::TooLong {
                    name: r.name.clone(),
                    lines: r.body.len(),
                },
            ));
        }
    }
    regions.sort_by_key(|r| r.start_line);
    problems.sort_by_key(|p| p.line);
    (regions, problems)
}

/// Remove the common leading whitespace of the non-blank lines.
fn dedent(lines: &[&str]) -> Vec<String> {
    let indent = lines
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.len() - l.trim_start().len())
        .min()
        .unwrap_or(0);
    lines
        .iter()
        .map(|l| l.get(indent..).unwrap_or("").trim_end().to_owned())
        .collect()
}

/// A lesson's `:::code anchor=<name> file=<path>` reference.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub lesson: String,
    pub line: usize,
    pub anchor: String,
    pub file: String,
}

/// Find `:::code` references in a lesson (outside code fences).
pub fn references(lesson: &str, text: &str) -> Vec<Reference> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for (i, raw) in text.lines().enumerate() {
        let t = raw.trim();
        if t.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || !t.starts_with(":::code") {
            continue;
        }
        let mut anchor = None;
        let mut file = None;
        for word in t.split_whitespace().skip(1) {
            if let Some(v) = word.strip_prefix("anchor=") {
                anchor = Some(v.trim_matches('"').to_owned());
            } else if let Some(v) = word.strip_prefix("file=") {
                file = Some(v.trim_matches('"').to_owned());
            }
        }
        if let (Some(anchor), Some(file)) = (anchor, file) {
            out.push(Reference {
                lesson: lesson.to_owned(),
                line: i + 1,
                anchor,
                file,
            });
        }
    }
    out
}

/// The result of a repository check.
#[derive(Debug, Default)]
pub struct RepoReport {
    pub problems: Vec<Problem>,
    pub warnings: Vec<String>,
    pub anchors: usize,
    pub references: usize,
}

/// Directories never scanned for markers.
const SKIP_DIRS: [&str; 6] = [
    "target",
    ".git",
    ".cache",
    "node_modules",
    "learner",
    "dist",
];

/// Check every file under `root`, plus every lesson under `course/chapters/`.
pub fn check_repo(root: &Path) -> io::Result<RepoReport> {
    let mut report = RepoReport::default();
    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    let mut by_file: BTreeMap<String, Vec<Region>> = BTreeMap::new();
    for rel in &files {
        let Some(syntax) = Syntax::for_path(rel) else {
            continue;
        };
        let Ok(text) = fs::read_to_string(root.join(rel)) else {
            continue;
        }; // binary file
        let (regions, problems) = scan(rel, &text, syntax);
        report.problems.extend(problems);
        let anchors: Vec<Region> = regions
            .into_iter()
            .filter(|r| r.keyword == Keyword::Anchor)
            .collect();
        if !anchors.is_empty() {
            by_file.insert(rel.clone(), anchors);
        }
    }

    let mut refs = Vec::new();
    for rel in files
        .iter()
        .filter(|f| f.starts_with("course/chapters/") && f.ends_with(".md"))
    {
        refs.extend(references(rel, &fs::read_to_string(root.join(rel))?));
    }
    let mut used: BTreeMap<(String, String), bool> = BTreeMap::new();
    for r in &refs {
        let target = root.join(&r.file);
        let problem = |kind| Problem {
            path: r.lesson.clone(),
            line: r.line,
            kind,
        };
        if r.file.contains("..") || r.file.starts_with('/') || !target.is_file() {
            report
                .problems
                .push(problem(ProblemKind::MissingFile(r.file.clone())));
        } else if !by_file
            .get(&r.file)
            .is_some_and(|v| v.iter().any(|a| a.name == r.anchor))
        {
            report.problems.push(problem(ProblemKind::MissingAnchor {
                file: r.file.clone(),
                name: r.anchor.clone(),
            }));
        } else {
            used.insert((r.file.clone(), r.anchor.clone()), true);
        }
    }

    let mut names: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (file, anchors) in &by_file {
        for a in anchors {
            report.anchors += 1;
            names.entry(&a.name).or_default().push(file);
            if !used.contains_key(&(file.clone(), a.name.clone())) {
                report.warnings.push(format!(
                    "{file}:{}: anchor {:?} is not referenced by any lesson",
                    a.start_line, a.name
                ));
            }
        }
    }
    for (name, files) in names {
        if files.len() > 1 {
            report.warnings.push(format!(
                "anchor name {name:?} is used in several files: {}",
                files.join(", ")
            ));
        }
    }
    report.references = refs.len();
    Ok(report)
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<String>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ty = entry.file_type()?;
        if ty.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect(root, &entry.path(), out)?;
        } else if ty.is_file() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(rel);
        }
    }
    Ok(())
}
