//! `cargo xtask audit`: the static security gate (architecture §4, threat model TEST-1).
//!
//! **Why a custom audit:** clippy cannot express repository rules such as "`unsafe` only in
//! these files" or "no `File::open` in the VMM outside `HostIo`". Each rule below names the
//! requirement it enforces, so a failure message points at the reason:
//!
//! | Rule | Requirement |
//! |---|---|
//! | `unsafe` only in `crates/hvf/**`, `crates/vmm/src/memory/host.rs`, `guests/**` | architecture §4 |
//! | no `allow`/`expect`/`warn(unsafe_code)` outside those files (it would undo `vmm`'s `deny`) | architecture §4 |
//! | every `unsafe {` / `unsafe impl` has `// SAFETY:` directly above | architecture §4, ADR-0002 |
//! | crate roots outside `hvf` carry `forbid(unsafe_code)` (`vmm`: `deny`) | architecture §4 |
//! | no `#[path = …]` attribute, no `include!`, no symlink in a scanned tree (each would pull in code the audit never reads) | TEST-1 |
//! | no hex literal of a machine-layout address outside `layout.rs`, tests, `guests/` | principle 2 |
//! | no `print!`-family macro (or `dbg!`) in `crates/vmm` | RUST-5 |
//! | no `std::process::Command` outside `crates/xtask`, `macvmm/src/doctor.rs`, `tests/` | RUST-6, PROC-3 |
//! | no `std::net` / `std::os::unix::net` outside `vmm/src/{net,gdbstub}/`, `tests/` | RUST-6 |
//! | no path-based file access in `crates/vmm` outside `backend/hostio.rs` (tests exempt) | HOSTIO-1, RUST-6 |
//! | no `copy_nonoverlapping` / `from_raw_parts` in `crates/vmm` | MEM-5 |
//! | every registry dependency is in the `docs/dependencies.md` allowlist; no git, alternative-registry, `[patch]`/`[replace]` or out-of-tree path source | SC-11 |
//! | `entitlements.plist` holds exactly `com.apple.security.hypervisor = true` | SIGN-1, F18 |
//! | `vmm::fdt::reader` is gated by `cfg(test)`/`test-util` and named only by tests, `crates/fuzz/` and itself | FDT-1, PLAN M7 |
//! | `hvf`'s `fault-injection` feature is named only in `dev-dependencies` tables and its own definition; `crates/macvmm/Cargo.toml` never names it | MEM-11, PLAN M2 |
//! | no `hdiutil attach`/`mount`/`open` of a `*.img`/`*.raw` path in `scripts/`, `crates/`, `course/` (unless negated on the line; [`crate::image_audit`]) | SC-14, PLAN M15 |
//! | M20 rules for `tools/`, `course/`, `docs/macos/` (forbidden advice, the vz-mac entitlement, SC-1 for tool scripts, no Apple binaries): see [`crate::vz_audit`] | AS9, SIGN-1, SC-1 |
//!
//! `--deps` additionally checks every third-party package in `Cargo.lock` (the transitive
//! closure, for every platform, so it is a superset of `cargo tree`): each must be allowlisted,
//! come from crates.io, and carry a checksum.
//!
//! **How paths are matched.** The banned items (`Command`, `net`, the `std::fs` functions that
//! take a path) are found in every spelling the lexer can see: expression paths
//! (`std::fs::copy(..)`, `fs::copy(..)`), every leaf of a `use` tree after expansion
//! (`use std::{io, net::TcpStream}` is `std::net::TcpStream`), and any glob or rename of a module
//! on the way to a banned item (`use std::process::*`, `use std::fs as f`, `use std as s`,
//! `use std::fs::File as F`), since those hide later uses from a token search. What a lexer cannot
//! see (a `type` alias of `File`, a re-export from another of our modules) stays a review item.
//!
//! **Scope.** Every file under `crates/` and `guests/` is scanned, hidden directories included;
//! only the guests' build output `guests/target/` is skipped. "Tests" means integration-test
//! crates (`crates/<name>/tests/**`) and the body of a `#[cfg(test)] mod <name> { … }` (other
//! attributes may sit between the two). A `tests/` directory inside `src/` is library code.
//! Checks whose target files do not exist yet pass vacuously (PLAN M0).

use crate::rust_lex::{self, Kind, Token};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// One rule violation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub path: String,
    pub line: usize,
    pub rule: &'static str,
    pub message: String,
}

/// Everything the audit found.
#[derive(Debug, Default)]
pub struct Report {
    pub findings: Vec<Finding>,
    /// Informational lines (risk R20 counters), never failures.
    pub notes: Vec<String>,
    pub files_scanned: usize,
}

impl Report {
    fn add(&mut self, path: &str, line: usize, rule: &'static str, message: String) {
        self.findings.push(Finding {
            path: path.to_owned(),
            line,
            rule,
            message,
        });
    }
}

/// The layout addresses that must only be spelled in `arch/layout.rs` (architecture §4). Kept as
/// strings so this file does not itself contain the literals it bans.
const LAYOUT_ADDRESSES: [&str; 5] = [
    "0x0900_0000",
    "0x0a00_0000",
    "0x4000_0000",
    "0x0800_0000",
    "0x080a_0000",
];

/// Entitlements that must never appear (SIGN-1); any key other than the hypervisor one fails,
/// these just get a more specific message.
const FORBIDDEN_ENTITLEMENTS: [&str; 6] = [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.get-task-allow",
    "com.apple.vm.networking",
];
const HYPERVISOR_ENTITLEMENT: &str = "com.apple.security.hypervisor";

/// The only package source SC-11 accepts in `Cargo.lock` (Cargo records crates.io under this id
/// whatever protocol fetched it).
const CRATES_IO: &str = "registry+https://github.com/rust-lang/crates.io-index";

/// Modules whose glob import or rename would hide a later `Command` use from the token search.
const COMMAND_MODULES: &[&[&str]] = &[&["std", "process"]];
/// Likewise for the networking modules (RUST-6).
const NET_MODULES: &[&[&str]] = &[&["std", "net"], &["std", "os", "unix", "net"]];
/// Likewise for the file-system modules (HOSTIO-1).
const FS_MODULES: &[&[&str]] = &[&["std", "fs"], &["std", "os", "unix", "fs"]];
/// `std::fs` / `std::os::unix::fs` functions that open, create, read, write or change host files
/// **by path** (HOSTIO-1). Types such as `File` and fd-based traits such as `FileExt` stay usable
/// on descriptors `HostIo` already opened.
const FS_PATH_FNS: &[&str] = &[
    "read",
    "read_to_string",
    "write",
    "copy",
    "rename",
    "create_dir",
    "create_dir_all",
    "hard_link",
    "soft_link",
    "symlink",
    "remove_file",
    "remove_dir",
    "remove_dir_all",
    "read_dir",
    "read_link",
    "set_permissions",
    "metadata",
    "symlink_metadata",
    "canonicalize",
    "exists",
    "chown",
    "lchown",
    "chroot",
    "mkfifo",
];
/// `File::<these>` open or create a file by path.
const FILE_OPENERS: &[&str] = &["open", "create", "create_new", "options"];
/// Builders that open or create by path, banned by name wherever they appear.
const FS_BUILDERS: &[&str] = &[
    "OpenOptions",
    "OpenOptionsExt",
    "DirBuilder",
    "DirBuilderExt",
];

// ---------------------------------------------------------------------------------------------
// Entry points

/// The default audit: source rules, manifest dependencies, cargo config, entitlements.
pub fn audit(root: &Path) -> io::Result<Report> {
    let mut report = Report::default();
    let allow = read_allowlist(root)?;
    let tree = walk(root, &["crates", "guests"])?;
    report_symlinks(&tree, &mut report);
    for (rel, path) in &tree.files {
        if rel.ends_with(".rs") {
            let src = fs::read_to_string(path)?;
            report.files_scanned += 1;
            audit_rust(rel, &src, &mut report);
        } else if rel.ends_with("/Cargo.toml") {
            let src = fs::read_to_string(path)?;
            report.files_scanned += 1;
            audit_manifest(rel, &src, &allow, &mut report);
        } else if is_cargo_config(rel) {
            let src = fs::read_to_string(path)?;
            report.files_scanned += 1;
            audit_cargo_config(rel, &src, &mut report);
        }
    }
    let root_manifest = root.join("Cargo.toml");
    if root_manifest.is_file() {
        let src = fs::read_to_string(&root_manifest)?;
        audit_manifest("Cargo.toml", &src, &allow, &mut report);
    }
    for rel in [".cargo/config.toml", ".cargo/config"] {
        let path = root.join(rel);
        if path.is_file() {
            report.files_scanned += 1;
            audit_cargo_config(rel, &fs::read_to_string(&path)?, &mut report);
        }
    }
    let plist = root.join("entitlements.plist");
    if plist.is_file() {
        let src = fs::read_to_string(&plist)?;
        report.files_scanned += 1;
        audit_entitlements("entitlements.plist", &src, &mut report);
    }
    // M20: tools/, course/, docs/macos/ (AS9, the vz-mac entitlement, SC-1 for tools/).
    crate::vz_audit::audit_tools(root, &mut report)?;
    // M15: no host mount/attach/open of a disk image in scripts/, crates/, course/ (SC-14).
    crate::image_audit::audit_host_mounts(root, &mut report)?;
    Ok(report)
}

/// `--deps`: manifests plus every third-party package in `Cargo.lock`.
pub fn audit_deps(root: &Path) -> io::Result<Report> {
    let mut report = Report::default();
    let allow = read_allowlist(root)?;
    let tree = walk(root, &["crates", "guests"])?;
    report_symlinks(&tree, &mut report);
    let mut manifests: Vec<(String, PathBuf)> = tree
        .files
        .into_iter()
        .filter(|(rel, _)| rel.ends_with("/Cargo.toml"))
        .collect();
    manifests.push(("Cargo.toml".to_owned(), root.join("Cargo.toml")));
    for (rel, path) in manifests {
        if path.is_file() {
            report.files_scanned += 1;
            audit_manifest(&rel, &fs::read_to_string(&path)?, &allow, &mut report);
        }
    }
    for lock in ["Cargo.lock", "guests/Cargo.lock"] {
        let path = root.join(lock);
        if path.is_file() {
            report.files_scanned += 1;
            audit_lock(lock, &fs::read_to_string(&path)?, &allow, &mut report);
        }
    }
    Ok(report)
}

fn report_symlinks(tree: &Tree, report: &mut Report) {
    for rel in &tree.symlinks {
        report.add(
            rel,
            1,
            "no-symlink",
            "symlink in a scanned tree: the audit does not follow it, so it cannot vouch for it"
                .into(),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Rust source rules

/// Integration-test crates only: `crates/<name>/tests/**`. A `tests` directory under `src/` is
/// compiled into the library (`pub mod tests;`), so it gets no exemption.
fn is_test_path(rel: &str) -> bool {
    let mut parts = rel.split('/');
    parts.next() == Some("crates") && parts.next().is_some() && parts.next() == Some("tests")
}

fn unsafe_allowed(rel: &str) -> bool {
    rel.starts_with("crates/hvf/")
        || rel == "crates/vmm/src/memory/host.rs"
        || rel.starts_with("guests/")
}

/// The index of the token closing the bracket opened at `toks[open]`, if it is closed.
fn matching(toks: &[Token], open: usize, o: char, c: char) -> Option<usize> {
    let mut depth = 0usize;
    for (k, t) in toks.iter().enumerate().skip(open) {
        if t.is_punct(o) {
            depth += 1;
        } else if t.is_punct(c) {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(k);
            }
        }
    }
    None
}

/// `#[ … ]` / `#![ … ]` attributes as `(index of '[', index of ']')`.
fn attribute_ranges(toks: &[Token]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        if !t.is_punct('#') {
            continue;
        }
        let open = if toks.get(i + 1).is_some_and(|n| n.is_punct('[')) {
            i + 1
        } else if toks.get(i + 1).is_some_and(|n| n.is_punct('!'))
            && toks.get(i + 2).is_some_and(|n| n.is_punct('['))
        {
            i + 2
        } else {
            continue;
        };
        if let Some(end) = matching(toks, open, '[', ']') {
            out.push((open, end));
        }
    }
    out
}

/// Token ranges `(first, last)` of every `#[cfg(test)]` module: the attribute, optionally more
/// outer attributes, optionally `pub`/`pub(…)`, then `mod <name> { … }`. Only the module body
/// is exempt; a `#[cfg(test)]` on anything else (a `use`, a function) exempts nothing.
fn test_regions(toks: &[Token]) -> Vec<(usize, usize)> {
    let is = |k: usize, c: char| toks.get(k).is_some_and(|t| t.is_punct(c));
    let word = |k: usize| toks.get(k).and_then(Token::ident);
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < toks.len() {
        let cfg_test = is(i, '#')
            && is(i + 1, '[')
            && word(i + 2) == Some("cfg")
            && is(i + 3, '(')
            && word(i + 4) == Some("test")
            && is(i + 5, ')')
            && is(i + 6, ']');
        if !cfg_test {
            i += 1;
            continue;
        }
        let mut j = i + 7;
        while is(j, '#') && is(j + 1, '[') {
            match matching(toks, j + 1, '[', ']') {
                Some(end) => j = end + 1,
                None => break,
            }
        }
        if word(j) == Some("pub") {
            j += 1;
            if is(j, '(') {
                j = matching(toks, j, '(', ')').map_or(j, |e| e + 1);
            }
        }
        if word(j) == Some("mod")
            && word(j + 1).is_some()
            && is(j + 2, '{')
            && let Some(end) = matching(toks, j + 2, '{', '}')
        {
            out.push((i, end));
            i = end + 1;
        } else {
            i += 1;
        }
    }
    out
}

/// A path the rules look at: an expression path (`std::fs::copy`) or one expanded leaf of a
/// `use` tree, with whether that leaf was a glob or a rename.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PathRef {
    segs: Vec<String>,
    /// Token index the path is attributed to (its first token, or the `use` keyword).
    tok: usize,
    line: usize,
    glob: bool,
    renamed: bool,
}

impl PathRef {
    /// How to name this path in a message: an alias says what it hides.
    fn describe(&self) -> String {
        let p = self.segs.join("::");
        match (self.glob, self.renamed) {
            (true, _) => format!("`use {p}::*` (a glob import hides later uses)"),
            (_, true) => format!("`use {p} as …` (a rename hides later uses)"),
            _ => format!("`{p}`"),
        }
    }
    fn has(&self, a: &str, b: &str) -> bool {
        self.segs.windows(2).any(|w| w[0] == a && w[1] == b)
    }
    /// A glob or rename of `modules` or of a module on the way to one (`std`, `std::os`, …).
    fn aliases(&self, modules: &[&[&str]]) -> bool {
        (self.glob || self.renamed)
            && !self.segs.is_empty()
            && modules.iter().any(|m| {
                m.len() >= self.segs.len() && m.iter().zip(&self.segs).all(|(a, b)| a == b)
            })
    }
}

/// Expand one use tree starting at `toks[i]` under `prefix`; returns the index after it.
fn parse_use_tree(
    toks: &[Token],
    mut i: usize,
    prefix: &[String],
    use_tok: usize,
    out: &mut Vec<PathRef>,
    depth: usize,
) -> usize {
    let is = |k: usize, c: char| toks.get(k).is_some_and(|t| t.is_punct(c));
    let line = toks.get(use_tok).map_or(0, |t| t.line);
    let mut segs = prefix.to_vec();
    if depth > 32 {
        return i;
    }
    loop {
        if is(i, ':') && is(i + 1, ':') {
            i += 2;
        } else if is(i, '*') {
            out.push(PathRef {
                segs,
                tok: use_tok,
                line,
                glob: true,
                renamed: false,
            });
            return i + 1;
        } else if is(i, '{') {
            i += 1;
            loop {
                if i >= toks.len() {
                    return i;
                }
                if is(i, '}') {
                    return i + 1;
                }
                if is(i, ',') {
                    i += 1;
                    continue;
                }
                let next = parse_use_tree(toks, i, &segs, use_tok, out, depth + 1);
                if next == i {
                    return i; // malformed: no progress
                }
                i = next;
            }
        } else if let Some(w) = toks.get(i).and_then(Token::ident)
            && w != "as"
        {
            segs.push(w.to_owned());
            i += 1;
            if !(is(i, ':') && is(i + 1, ':')) {
                break;
            }
        } else {
            break;
        }
    }
    let mut renamed = false;
    if toks.get(i).and_then(Token::ident) == Some("as") {
        // `as _` imports a trait anonymously: nothing nameable, so nothing hidden.
        renamed = toks.get(i + 1).and_then(Token::ident) != Some("_");
        i += 2;
    }
    if segs.last().is_some_and(|s| s == "self") {
        segs.pop();
    }
    if !segs.is_empty() {
        out.push(PathRef {
            segs,
            tok: use_tok,
            line,
            glob: false,
            renamed,
        });
    }
    i
}

/// Every path in the file: expanded `use` leaves, then expression paths outside `use` items.
fn collect_paths(toks: &[Token]) -> Vec<PathRef> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < toks.len() {
        let Some(word) = toks.get(i).and_then(Token::ident) else {
            i += 1;
            continue;
        };
        if word == "use" {
            i = parse_use_tree(toks, i + 1, &[], i, &mut out, 0).max(i + 1);
            continue;
        }
        let first = i;
        let mut segs = vec![word.to_owned()];
        while toks.get(i + 1).is_some_and(|t| t.is_punct(':'))
            && toks.get(i + 2).is_some_and(|t| t.is_punct(':'))
            && let Some(next) = toks.get(i + 3).and_then(Token::ident)
        {
            segs.push(next.to_owned());
            i += 3;
        }
        out.push(PathRef {
            segs,
            tok: first,
            line: toks.get(first).map_or(0, |t| t.line),
            glob: false,
            renamed: false,
        });
        i += 1;
    }
    out
}

/// All per-file Rust rules.
pub fn audit_rust(rel: &str, src: &str, report: &mut Report) {
    let toks = rust_lex::tokenize(src);
    let lines: Vec<&str> = src.lines().collect();
    let regions = test_regions(&toks);
    let in_tests =
        |tok: usize| is_test_path(rel) || regions.iter().any(|&(a, b)| (a..=b).contains(&tok));
    let in_vmm = rel.starts_with("crates/vmm/");
    let mut seen: BTreeSet<(usize, &'static str)> = BTreeSet::new();
    let mut add = |report: &mut Report, line: usize, rule: &'static str, message: String| {
        if seen.insert((line, rule)) {
            report.add(rel, line, rule, message);
        }
    };

    // unsafe quarantine and SAFETY comments.
    for (i, t) in toks.iter().enumerate() {
        if t.ident() != Some("unsafe") {
            continue;
        }
        if !unsafe_allowed(rel) {
            add(
                report,
                t.line,
                "unsafe-quarantine",
                "`unsafe` outside the quarantine (architecture §4)".into(),
            );
            continue;
        }
        let next = toks.get(i + 1);
        let needs_comment = next.is_some_and(|n| n.is_punct('{') || n.ident() == Some("impl"));
        if needs_comment && !has_safety_comment(&lines, t.line) {
            add(
                report,
                t.line,
                "safety-comment",
                "`unsafe` block without `// SAFETY:` directly above".into(),
            );
        }
    }

    // `#[allow(unsafe_code)]` (or expect/warn) would undo `vmm`'s crate-level `deny` for the
    // item it decorates, so only the quarantined files may carry it.
    if !unsafe_allowed(rel) {
        for (i, t) in toks.iter().enumerate() {
            if matches!(t.ident(), Some("allow" | "expect" | "warn"))
                && toks.get(i + 1).is_some_and(|n| n.is_punct('('))
                && let Some(end) = matching(&toks, i + 1, '(', ')')
                && toks
                    .get(i + 1..end)
                    .is_some_and(|inner| inner.iter().any(|x| x.ident() == Some("unsafe_code")))
            {
                add(
                    report,
                    t.line,
                    "unsafe-allow",
                    "lint override of `unsafe_code` outside the quarantine (architecture §4)"
                        .into(),
                );
            }
        }
    }

    // Code the audit would never read: `#[path = …]` modules and `include!`.
    for (open, end) in attribute_ranges(&toks) {
        for k in open..end {
            if toks.get(k).and_then(Token::ident) == Some("path")
                && toks.get(k + 1).is_some_and(|n| n.is_punct('='))
                && let Some(t) = toks.get(k)
            {
                add(
                    report,
                    t.line,
                    "no-path-attr",
                    "`#[path = …]` module: the audit scans files by location (TEST-1)".into(),
                );
            }
        }
    }
    for (i, t) in toks.iter().enumerate() {
        if t.ident() == Some("include") && toks.get(i + 1).is_some_and(|n| n.is_punct('!')) {
            add(
                report,
                t.line,
                "no-include",
                "`include!` pulls in source the audit does not scan (TEST-1)".into(),
            );
        }
        if t.ident() == Some("extern")
            && toks.get(i + 1).and_then(Token::ident) == Some("crate")
            && toks.get(i + 2).and_then(Token::ident) == Some("std")
            && toks.get(i + 3).and_then(Token::ident) == Some("as")
        {
            add(
                report,
                t.line,
                "std-alias",
                "`extern crate std as …` hides std paths from the audit".into(),
            );
        }
    }

    // Crate roots must forbid (vmm: deny) unsafe code.
    let is_root =
        rel.ends_with("/src/lib.rs") || rel.ends_with("/src/main.rs") || rel.contains("/src/bin/");
    if rel.starts_with("crates/") && is_root && !rel.starts_with("crates/hvf/") {
        let want_forbid = has_inner_attr(&toks, "forbid", "unsafe_code");
        let want_deny = has_inner_attr(&toks, "deny", "unsafe_code");
        let ok = if rel == "crates/vmm/src/lib.rs" {
            want_forbid || want_deny
        } else {
            want_forbid
        };
        if !ok {
            add(
                report,
                1,
                "forbid-unsafe",
                "crate root lacks `#![forbid(unsafe_code)]`".into(),
            );
        }
    }

    // Layout literals.
    let exempt_literals = rel.ends_with("/arch/layout.rs")
        || rel.ends_with("/machine/vmapple/layout.rs")
        || rel.starts_with("guests/");
    if !exempt_literals {
        let banned: Vec<u128> = LAYOUT_ADDRESSES
            .iter()
            .filter_map(|s| rust_lex::hex_value(s))
            .collect();
        for (i, t) in toks.iter().enumerate() {
            if let Kind::Number(n) = &t.kind
                && let Some(v) = rust_lex::hex_value(n)
                && banned.contains(&v)
                && !in_tests(i)
            {
                add(
                    report,
                    t.line,
                    "layout-literal",
                    format!("layout address {n} outside arch/layout.rs"),
                );
            }
        }
    }

    // RUST-6 / PROC-3 / HOSTIO-1 on paths (expression paths and expanded `use` leaves).
    let hostio_applies =
        |tok: usize| in_vmm && rel != "crates/vmm/src/backend/hostio.rs" && !in_tests(tok);
    for p in collect_paths(&toks) {
        if !command_allowed(rel) && (p.has("process", "Command") || p.aliases(COMMAND_MODULES)) {
            add(
                report,
                p.line,
                "no-command",
                format!(
                    "{}: `std::process::Command` outside xtask and doctor.rs (PROC-3)",
                    p.describe()
                ),
            );
        }
        if !net_allowed(rel)
            && (p.has("std", "net") || p.has("unix", "net") || p.aliases(NET_MODULES))
        {
            add(
                report,
                p.line,
                "no-net",
                format!(
                    "{}: `net` module outside vmm/src/{{net,gdbstub}}/ (RUST-6)",
                    p.describe()
                ),
            );
        }
        if hostio_applies(p.tok)
            && (FS_PATH_FNS.iter().any(|f| p.has("fs", f))
                || p.aliases(FS_MODULES)
                || (p.renamed && FS_BUILDERS.iter().chain(&["File"]).any(|b| p.has("fs", b))))
        {
            add(
                report,
                p.line,
                "hostio-only",
                format!(
                    "{}: host file access outside backend/hostio.rs (HOSTIO-1)",
                    p.describe()
                ),
            );
        }
    }

    for (i, t) in toks.iter().enumerate() {
        let Some(word) = t.ident() else { continue };
        let next = |k: usize| toks.get(i + k);

        // RUST-5: print-family macros in the VMM library.
        if in_vmm
            && matches!(word, "print" | "println" | "eprint" | "eprintln" | "dbg")
            && next(1).is_some_and(|n| n.is_punct('!'))
        {
            add(
                report,
                t.line,
                "no-print",
                format!("`{word}!` in crates/vmm (RUST-5: use the log/sink API)"),
            );
        }

        // HOSTIO-1: builders by name, and `File::open` (also `<File>::open`) on any path.
        if hostio_applies(i) {
            let k = if next(1).is_some_and(|n| n.is_punct('>')) {
                2
            } else {
                1
            };
            let file_open = word == "File"
                && next(k).is_some_and(|a| a.is_punct(':'))
                && next(k + 1).is_some_and(|b| b.is_punct(':'))
                && next(k + 2)
                    .and_then(Token::ident)
                    .is_some_and(|m| FILE_OPENERS.contains(&m));
            if file_open || FS_BUILDERS.contains(&word) {
                add(
                    report,
                    t.line,
                    "hostio-only",
                    format!("`{word}` file access outside backend/hostio.rs (HOSTIO-1)"),
                );
            }
        }

        // MEM-5: guest copies are volatile; never create references to guest memory.
        if in_vmm
            && matches!(
                word,
                "copy_nonoverlapping" | "from_raw_parts" | "from_raw_parts_mut"
            )
        {
            add(
                report,
                t.line,
                "volatile-only",
                format!("`{word}` in crates/vmm (MEM-5)"),
            );
        }
    }

    // FDT-1 (M7): the test-only device-tree parser stays unreachable from `macvmm run`.
    audit_fdt_reader(rel, &toks, &lines, &in_tests, report);

    // Risk R20: count arithmetic allows (code only, not comments or strings), report only.
    let allows = toks
        .windows(6)
        .filter(|w| {
            w[0].ident() == Some("allow")
                && w[1].is_punct('(')
                && w[2].ident() == Some("clippy")
                && w[3].is_punct(':')
                && w[4].is_punct(':')
                && w[5].ident() == Some("arithmetic_side_effects")
        })
        .count();
    if allows > 0 {
        report.notes.push(format!(
            "{rel}: {allows} #[allow(clippy::arithmetic_side_effects)]"
        ));
    }
}

/// The `cfg` lines that may gate `fdt/reader.rs` (FDT-1): tests and the `test-util` feature.
const FDT_READER_GATES: [&str; 3] = [
    "#[cfg(test)]",
    "#[cfg(feature = \"test-util\")]",
    "#[cfg(any(test, feature = \"test-util\"))]",
];

// ANCHOR: audit_fdt_reader
/// Rule `fdt-reader-unreachable` (threat model FDT-1, PLAN M7): `vmm::fdt::reader` parses
/// device trees, a hostile-input surface the VMM must not have, so it exists only for tests and
/// fuzzing. Its `mod` declaration in `fdt/mod.rs` must carry one of [`FDT_READER_GATES`] on the
/// line above, and no code outside tests, `crates/fuzz/` and the reader itself may name it:
/// `fdt::reader` in any path or `use` leaf, `super::reader`/`self::reader`/`reader::…` inside
/// `fdt/`, or a glob or rename of `fdt` (or, inside `fdt/`, of `super`/`self`): those would
/// import it or hide a later `alias::reader::…` from the path match.
fn audit_fdt_reader(
    rel: &str,
    toks: &[Token],
    lines: &[&str],
    in_tests: &dyn Fn(usize) -> bool,
    report: &mut Report,
) {
    const RULE: &str = "fdt-reader-unreachable";
    let in_fdt = rel.starts_with("crates/vmm/src/fdt/");
    if rel == "crates/vmm/src/fdt/mod.rs" {
        for (i, t) in toks.iter().enumerate() {
            if t.ident() == Some("mod") && toks.get(i + 1).and_then(Token::ident) == Some("reader")
            {
                let above = t.line.checked_sub(2).and_then(|k| lines.get(k));
                if !above.is_some_and(|l| FDT_READER_GATES.contains(&l.trim())) {
                    report.add(
                        rel,
                        t.line,
                        RULE,
                        "`mod reader` must be gated by #[cfg(any(test, feature = \"test-util\"))] on the line above (FDT-1)".into(),
                    );
                }
            }
        }
    }
    if rel == "crates/vmm/src/fdt/reader.rs" || rel.starts_with("crates/fuzz/") {
        return;
    }
    for p in collect_paths(toks) {
        let first_is_reader = p.segs.len() >= 2 && p.segs.first().is_some_and(|s| s == "reader");
        let hides = (p.glob || p.renamed)
            && (p.segs.last().is_some_and(|s| s == "fdt")
                || (in_fdt && p.aliases(&[&["super", "reader"], &["self", "reader"]])));
        let names = p.has("fdt", "reader")
            || hides
            || (in_fdt && (p.has("super", "reader") || p.has("self", "reader") || first_is_reader));
        if names && !in_tests(p.tok) {
            report.add(
                rel,
                p.line,
                RULE,
                format!(
                    "{}: fdt::reader is test/fuzz only; `macvmm run` must not reach it (FDT-1)",
                    p.describe()
                ),
            );
        }
    }
}
// ANCHOR_END: audit_fdt_reader

fn command_allowed(rel: &str) -> bool {
    rel.starts_with("crates/xtask/") || rel == "crates/macvmm/src/doctor.rs" || is_test_path(rel)
}

fn net_allowed(rel: &str) -> bool {
    rel.starts_with("crates/vmm/src/net/")
        || rel.starts_with("crates/vmm/src/gdbstub/")
        || is_test_path(rel)
}

/// `#![attr(arg)]` anywhere in the token stream.
fn has_inner_attr(toks: &[Token], attr: &str, arg: &str) -> bool {
    toks.windows(6).any(|w| {
        w[0].is_punct('#')
            && w[1].is_punct('!')
            && w[2].is_punct('[')
            && w[3].ident() == Some(attr)
            && w[4].is_punct('(')
            && w[5].ident() == Some(arg)
    })
}

/// The contiguous `//` comment lines directly above `line` (1-based) include `// SAFETY:`.
fn has_safety_comment(lines: &[&str], line: usize) -> bool {
    let mut idx = line.saturating_sub(1); // index of the unsafe line
    while idx > 0 {
        idx -= 1;
        let above = lines.get(idx).map_or("", |l| l.trim());
        if !above.starts_with("//") {
            return false;
        }
        if above.starts_with("// SAFETY:") {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------------------------
// Dependencies (SC-11)

/// Crate names from the allowlist block of `docs/dependencies.md`: the lines between
/// `<!-- allowlist:begin -->` and `<!-- allowlist:end -->`, first word of each non-empty line
/// that is not a comment or a code fence. A missing file means an empty allowlist.
pub fn read_allowlist(root: &Path) -> io::Result<Vec<String>> {
    let path = root.join("docs/dependencies.md");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    Ok(parse_allowlist(&fs::read_to_string(path)?))
}

pub fn parse_allowlist(md: &str) -> Vec<String> {
    let mut inside = false;
    let mut names = Vec::new();
    for line in md.lines() {
        let l = line.trim();
        if l == "<!-- allowlist:begin -->" {
            inside = true;
        } else if l == "<!-- allowlist:end -->" {
            inside = false;
        } else if inside
            && !l.is_empty()
            && !l.starts_with('#')
            && !l.starts_with("```")
            && let Some(name) = l.split_whitespace().next()
        {
            names.push(name.to_owned());
        }
    }
    names
}

/// Where a manifest dependency comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DepSource {
    /// crates.io: a version string, or a table without `path`/`workspace`/`git`/`registry`.
    Registry,
    /// `path = …`, resolved lexically against the manifest's directory to a repo-relative path,
    /// or `None` if it is absolute or climbs out of the repository.
    Path(Option<String>),
    /// `workspace = true`: inherited from the root `[workspace.dependencies]`, audited there.
    Workspace,
    /// A git or alternative-registry source, or a key the audit does not understand.
    Rejected(String),
}

/// One dependency entry of a manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dep {
    pub line: usize,
    /// The dependency key (`foo` in `foo = …`).
    pub key: String,
    /// The crate actually depended on: `package = "…"` if given, else the key.
    pub package: String,
    pub source: DepSource,
}

/// What [`manifest_deps`] found: the dependencies, and lines the audit refuses outright
/// (`[patch]`/`[replace]` sections, syntax it cannot parse safely).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManifestScan {
    pub deps: Vec<Dep>,
    pub problems: Vec<(usize, String)>,
}

/// One step of a TOML string scanner: updates `quote`/`escaped` for `c`, and returns true when
/// `c` is outside any string (and is not the quote that just closed one).
fn toml_outside(c: char, quote: &mut Option<char>, escaped: &mut bool) -> bool {
    match *quote {
        Some('"') if *escaped => *escaped = false,
        Some('"') if c == '\\' => *escaped = true,
        Some(q) if c == q => *quote = None,
        Some(_) => {}
        None if c == '"' || c == '\'' => *quote = Some(c),
        None => return true,
    }
    false
}

/// `line` without a trailing `#` comment; `#` inside a basic or literal string is kept.
fn strip_toml_comment(line: &str) -> &str {
    let (mut quote, mut escaped) = (None, false);
    for (i, c) in line.char_indices() {
        if toml_outside(c, &mut quote, &mut escaped) && c == '#' {
            return line.get(..i).unwrap_or(line);
        }
    }
    line
}

/// Split `text` at every top-level `sep` (outside strings and `[]`/`{}`).
fn split_top(text: &str, sep: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut quote, mut escaped) = (None, false);
    let mut depth = 0i32;
    let mut begin = 0usize;
    for (i, c) in text.char_indices() {
        if !toml_outside(c, &mut quote, &mut escaped) {
            continue;
        }
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => depth -= 1,
            _ if c == sep && depth == 0 => {
                parts.push(text.get(begin..i).unwrap_or(""));
                begin = i + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(text.get(begin..).unwrap_or(""));
    parts
}

/// Net `[` and `{` depth of a line outside strings (positive: the value continues below).
fn open_depth(text: &str) -> (i32, i32) {
    let (mut sq, mut br) = (0i32, 0i32);
    let (mut quote, mut escaped) = (None, false);
    for c in text.chars() {
        if !toml_outside(c, &mut quote, &mut escaped) {
            continue;
        }
        match c {
            '[' => sq += 1,
            ']' => sq -= 1,
            '{' => br += 1,
            '}' => br -= 1,
            _ => {}
        }
    }
    (sq, br)
}

/// A dotted TOML key (`a."b.c".d`) as its unquoted parts.
fn key_parts(key: &str) -> Vec<String> {
    split_top(key.trim(), '.')
        .into_iter()
        .map(|p| {
            let p = p.trim();
            p.strip_prefix('"')
                .and_then(|r| r.strip_suffix('"'))
                .or_else(|| p.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')))
                .unwrap_or(p)
                .to_owned()
        })
        .collect()
}

/// A simple string value (`"…"` without escapes, or `'…'`), else `None`.
fn toml_str(value: &str) -> Option<String> {
    let v = value.trim();
    let inner = v
        .strip_prefix('"')
        .and_then(|r| r.strip_suffix('"'))
        .filter(|r| !r.contains(['\\', '"']))
        .or_else(|| {
            v.strip_prefix('\'')
                .and_then(|r| r.strip_suffix('\''))
                .filter(|r| !r.contains('\''))
        })?;
    Some(inner.to_owned())
}

/// The `key = value` pairs of a one-line inline table, or `None` if it is not one.
fn inline_table(value: &str) -> Option<Vec<(String, String)>> {
    let inner = value.trim().strip_prefix('{')?.strip_suffix('}')?;
    let mut out = Vec::new();
    for part in split_top(inner, ',') {
        if part.trim().is_empty() {
            continue;
        }
        let kv = split_top(part, '=');
        let [k, v] = kv.as_slice() else { return None };
        out.push((key_parts(k).join("."), v.trim().to_owned()));
    }
    Some(out)
}

/// Lexically resolve `path` against the repo-relative directory `dir`.
fn resolve_rel(dir: &str, path: &str) -> Option<String> {
    if path.starts_with('/') || path.contains('\\') {
        return None;
    }
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            c => parts.push(c),
        }
    }
    Some(parts.join("/"))
}

/// Keys a dependency table may use. Anything else (`git`, `branch`, `registry`, `base`, …) is
/// refused rather than guessed at.
const DEP_KEYS: &[&str] = &[
    "version",
    "features",
    "default-features",
    "default_features",
    "optional",
    "package",
    "path",
    "workspace",
    "public",
];

fn classify(dir: &str, key: &str, line: usize, attrs: &[(String, String)]) -> Dep {
    let mut package = key.to_owned();
    let mut path: Option<Option<String>> = None;
    let mut workspace = false;
    let mut rejected: Option<String> = None;
    for (k, v) in attrs {
        let why = match k.as_str() {
            "git" | "branch" | "tag" | "rev" => {
                Some(format!("git source (`{k}`); SC-11 allows crates.io only"))
            }
            "registry" | "registry-index" => Some(format!("alternative registry (`{k}`)")),
            "package" => match toml_str(v) {
                Some(p) => {
                    package = p;
                    None
                }
                None => Some("unparsable `package` value".into()),
            },
            "path" => match toml_str(v) {
                Some(p) => {
                    path = Some(resolve_rel(dir, &p));
                    None
                }
                None => Some("unparsable `path` value".into()),
            },
            "workspace" if v.trim() == "true" => {
                workspace = true;
                None
            }
            "workspace" => Some("`workspace` must be `true`".into()),
            other if DEP_KEYS.contains(&other) => None,
            other => Some(format!("unsupported dependency key `{other}`")),
        };
        if rejected.is_none() {
            rejected = why;
        }
    }
    let source = match (rejected, path, workspace) {
        (Some(why), _, _) => DepSource::Rejected(why),
        (None, Some(p), _) => DepSource::Path(p),
        (None, None, true) => DepSource::Workspace,
        (None, None, false) => DepSource::Registry,
    };
    Dep {
        line,
        key: key.to_owned(),
        package,
        source,
    }
}

/// A dependency being collected: key, first line, `(attribute, raw value)` pairs.
type Entry = (String, usize, Vec<(String, String)>);

/// Parse the dependency tables of a manifest whose directory is `dir` (repo-relative).
///
/// Fail closed: a multi-line string, a multi-line inline table, a `[patch]`/`[replace]`
/// section, or a line inside a dependency table that is not `key = value` becomes a problem
/// instead of being skipped, so syntax the parser does not model cannot hide a dependency.
pub fn manifest_deps(dir: &str, src: &str) -> ManifestScan {
    #[derive(PartialEq)]
    enum Section {
        Other,
        Table,
        Single(usize),
    }
    let mut scan = ManifestScan::default();
    // (dependency key, first line, attributes), in first-seen order.
    let mut entries: Vec<Entry> = Vec::new();
    fn entry(entries: &mut Vec<Entry>, key: &str, line: usize) -> usize {
        if let Some(pos) = entries.iter().position(|(k, _, _)| k == key) {
            return pos;
        }
        entries.push((key.to_owned(), line, Vec::new()));
        entries.len() - 1
    }
    let mut section = Section::Other;
    let mut continuation = 0i32; // open `[` of a multi-line array value
    for (i, raw) in src.lines().enumerate() {
        let line_no = i + 1;
        if raw.contains("\"\"\"") || raw.contains("'''") {
            scan.problems.push((
                line_no,
                "multi-line strings are not supported by the audit's manifest parser".into(),
            ));
            continue;
        }
        let line = strip_toml_comment(raw).trim();
        if continuation > 0 {
            continuation += open_depth(line).0;
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = Section::Other;
            if line.starts_with("[[") {
                continue; // [[bin]], [[test]], …
            }
            let header = line.trim_start_matches('[').trim_end_matches(']');
            let parts = key_parts(header);
            if parts
                .first()
                .is_some_and(|p| p == "patch" || p == "replace")
            {
                scan.problems
                    .push((line_no, format!("[{header}] overrides dependency sources")));
                continue;
            }
            let is_dep_kind = |p: &String| {
                matches!(
                    p.as_str(),
                    "dependencies" | "dev-dependencies" | "build-dependencies"
                )
            };
            section = match parts.iter().position(is_dep_kind) {
                Some(pos) if pos + 1 == parts.len() => Section::Table,
                Some(pos) if pos + 2 == parts.len() => {
                    let name = parts.get(pos + 1).cloned().unwrap_or_default();
                    Section::Single(entry(&mut entries, &name, line_no))
                }
                Some(_) => {
                    scan.problems
                        .push((line_no, format!("unexpected table [{header}]")));
                    Section::Other
                }
                None => Section::Other,
            };
            continue;
        }
        if section == Section::Other {
            continue;
        }
        let kv = split_top(line, '=');
        let [k, v] = kv.as_slice() else {
            scan.problems
                .push((line_no, format!("cannot parse `{line}`")));
            continue;
        };
        let (sq, br) = open_depth(v);
        if br != 0 {
            scan.problems
                .push((line_no, "multi-line inline table".into()));
            continue;
        }
        continuation = sq.max(0);
        let key = key_parts(k);
        let value = v.trim().to_owned();
        match section {
            Section::Table => {
                let Some(name) = key.first() else { continue };
                let idx = entry(&mut entries, name, line_no);
                let attr = key.get(1..).map(|r| r.join(".")).unwrap_or_default();
                let mut new_attrs = Vec::new();
                if !attr.is_empty() {
                    new_attrs.push((attr, value));
                } else if toml_str(&value).is_some() {
                    new_attrs.push(("version".to_owned(), value));
                } else if let Some(pairs) = inline_table(&value) {
                    new_attrs = pairs;
                } else {
                    scan.problems
                        .push((line_no, format!("cannot parse dependency `{name}`")));
                }
                if let Some(e) = entries.get_mut(idx) {
                    e.2.extend(new_attrs);
                }
            }
            Section::Single(idx) => {
                if let Some(e) = entries.get_mut(idx) {
                    e.2.push((key.join("."), value));
                }
            }
            Section::Other => {}
        }
    }
    for (key, line, attrs) in &entries {
        scan.deps.push(classify(dir, key, *line, attrs));
    }
    scan
}

fn audit_manifest(rel: &str, src: &str, allow: &[String], report: &mut Report) {
    for (line, why) in fault_injection_scope(rel, src) {
        report.add(
            rel,
            line,
            "fault-injection-scope",
            format!("{why} (MEM-11)"),
        );
    }
    let dir = rel.rsplit_once('/').map_or("", |(d, _)| d);
    let scan = manifest_deps(dir, src);
    for (line, why) in scan.problems {
        report.add(rel, line, "deps-source", format!("{why} (SC-11)"));
    }
    for dep in scan.deps {
        match &dep.source {
            DepSource::Registry => {
                if !allow.contains(&dep.package) {
                    report.add(
                        rel,
                        dep.line,
                        "deps-allowlist",
                        format!(
                            "dependency {:?} is not in the docs/dependencies.md allowlist (SC-11)",
                            dep.package
                        ),
                    );
                }
            }
            DepSource::Path(Some(p)) if p.starts_with("crates/") || p.starts_with("guests/") => {}
            DepSource::Path(p) => report.add(
                rel,
                dep.line,
                "deps-source",
                format!(
                    "path dependency {:?} resolves to {}, outside crates/ and guests/ (SC-11)",
                    dep.key,
                    p.as_deref().unwrap_or("a place outside the repository")
                ),
            ),
            DepSource::Workspace => {}
            DepSource::Rejected(why) => report.add(
                rel,
                dep.line,
                "deps-source",
                format!("dependency {:?}: {why} (SC-11)", dep.key),
            ),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// MEM-11: `hvf`'s `fault-injection` feature stays out of every non-test build (PLAN M2)

/// The test-only feature of `crates/hvf` that makes the next unmap/destroy report `HV_ERROR`.
const FAULT_FEATURE: &str = "fault-injection";
/// The product binary's manifest: it may not mention the feature at all, not even in a comment
/// or a dev-dependency, so a reader of that one file can see the binary never has it.
const PRODUCT_MANIFEST: &str = "crates/macvmm/Cargo.toml";
/// The manifest that defines the feature.
const FEATURE_OWNER: &str = "crates/hvf/Cargo.toml";

/// Lines of manifest `rel` that could turn `fault-injection` on in a non-test build.
///
/// **Why a text rule, not a feature-graph walk.** A Cargo feature can be switched on from many
/// places: a `features = [...]` list on a dependency (inline or in a `[dependencies.hvf]`
/// table, under `[target.…]`, or in `[workspace.dependencies]`, which members inherit), a
/// feature of another crate that forwards to `hvf/fault-injection` or `hvf?/fault-injection`,
/// and `hvf`'s own `default` or `hvf-tests` features (which `macvmm`'s `hvf-tests` reaches via
/// `vmm`). Every one of those spells the feature name inside the manifest, so the rule is: the
/// name may appear only
/// - in a `dev-dependencies` table of any manifest except [`PRODUCT_MANIFEST`] (with resolver
///   2 or later, which the workspace uses, dev-dependency features do not reach a normal build),
///   and
/// - in [`FEATURE_OWNER`]'s `[features]` table, on the feature's own definition line(s).
///
/// Comments are ignored except in [`PRODUCT_MANIFEST`]. A `\u` escape outside a comment is
/// refused everywhere, because a TOML basic string could spell the name with one and hide it
/// from a text search (fail closed, like [`manifest_deps`]).
///
/// What a manifest cannot show stays a review item: `cargo build -p macvmm --features
/// hvf/fault-injection` on the command line. That build is still refused without
/// `debug_assertions` by the `compile_error!` in `crates/hvf/src/lib.rs`.
pub fn fault_injection_scope(rel: &str, src: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let product = rel == PRODUCT_MANIFEST;
    let owner = rel == FEATURE_OWNER;
    // Section state: inside a dev-dependencies table; inside `[features]` and, if so, the key
    // whose (possibly multi-line) value the current line belongs to.
    let mut dev = false;
    let mut features = false;
    let mut feature_key = String::new();
    for (i, raw) in src.lines().enumerate() {
        let line_no = i + 1;
        if product && raw.contains(FAULT_FEATURE) {
            out.push((
                line_no,
                format!("{PRODUCT_MANIFEST} must not mention `{FAULT_FEATURE}` at all"),
            ));
            continue;
        }
        let line = strip_toml_comment(raw).trim();
        if line.contains("\\u") || line.contains("\\U") {
            out.push((
                line_no,
                format!("a `\\u` escape in a manifest could spell `{FAULT_FEATURE}` unseen"),
            ));
            continue;
        }
        if line.starts_with('[') && !line.starts_with("[[") {
            let header = line.trim_start_matches('[').trim_end_matches(']');
            let parts = key_parts(header);
            dev = parts.iter().any(|p| p == "dev-dependencies");
            features = parts.len() == 1 && parts.first().is_some_and(|p| p == "features");
            feature_key.clear();
        } else if line.starts_with("[[") {
            dev = false;
            features = false;
            feature_key.clear();
        } else if features && let [k, _] = split_top(line, '=').as_slice() {
            feature_key = key_parts(k).join(".");
        }
        if !line.contains(FAULT_FEATURE) {
            continue;
        }
        let allowed = (dev && !product) || (owner && features && feature_key == FAULT_FEATURE);
        if !allowed {
            out.push((
                line_no,
                format!(
                    "`{FAULT_FEATURE}` is test-only: name it only in a [dev-dependencies] table \
                     (or in its own definition in {FEATURE_OWNER})"
                ),
            ));
        }
    }
    out
}

/// One `[[package]]` of a lockfile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockPkg {
    pub line: usize,
    pub name: String,
    /// `source = …` (absent for workspace members and path dependencies).
    pub source: Option<String>,
    pub checksum: bool,
}

pub fn lock_packages(src: &str) -> Vec<LockPkg> {
    let mut out: Vec<LockPkg> = Vec::new();
    let mut in_pkg = false;
    for (i, line) in src.lines().enumerate() {
        let l = line.trim();
        if l.starts_with('[') {
            in_pkg = l == "[[package]]";
            if in_pkg {
                out.push(LockPkg {
                    line: i + 1,
                    name: String::new(),
                    source: None,
                    checksum: false,
                });
            }
            continue;
        }
        let Some(pkg) = out.last_mut().filter(|_| in_pkg) else {
            continue;
        };
        if let Some(v) = l.strip_prefix("name = ") {
            pkg.name = v.trim_matches('"').to_owned();
        } else if let Some(v) = l.strip_prefix("source = ") {
            pkg.source = Some(v.trim_matches('"').to_owned());
        } else if l.starts_with("checksum = ") {
            pkg.checksum = true;
        }
    }
    out
}

/// Every package with a `source` is third-party: it must be allowlisted, come from crates.io
/// (a git source has no checksum in `Cargo.lock`), and carry a checksum.
fn audit_lock(rel: &str, src: &str, allow: &[String], report: &mut Report) {
    for pkg in lock_packages(src) {
        let Some(source) = &pkg.source else { continue };
        if !allow.contains(&pkg.name) {
            report.add(
                rel,
                pkg.line,
                "deps-allowlist",
                format!(
                    "package {:?} is not in the docs/dependencies.md allowlist",
                    pkg.name
                ),
            );
        }
        if source != CRATES_IO {
            report.add(
                rel,
                pkg.line,
                "deps-source",
                format!(
                    "package {:?} comes from {source:?}, not crates.io (SC-11)",
                    pkg.name
                ),
            );
        } else if !pkg.checksum {
            report.add(
                rel,
                pkg.line,
                "deps-source",
                format!("package {:?} has no checksum (SC-11)", pkg.name),
            );
        }
    }
}

fn is_cargo_config(rel: &str) -> bool {
    rel.ends_with("/.cargo/config.toml") || rel.ends_with("/.cargo/config")
}

/// `.cargo/config.toml` can redirect sources without touching any manifest: `[patch]`,
/// `[source]` replacement and the `paths` override are refused (SC-11).
fn audit_cargo_config(rel: &str, src: &str, report: &mut Report) {
    let mut top_level = true;
    for (i, raw) in src.lines().enumerate() {
        let line = strip_toml_comment(raw).trim();
        if line.starts_with('[') {
            top_level = false;
            let header = line.trim_start_matches('[').trim_end_matches(']');
            if key_parts(header)
                .first()
                .is_some_and(|p| p == "patch" || p == "source")
            {
                report.add(
                    rel,
                    i + 1,
                    "deps-source",
                    format!("[{header}] in cargo config redirects dependency sources (SC-11)"),
                );
            }
        } else if top_level
            && let [k, _] = split_top(line, '=').as_slice()
            && key_parts(k)
                .first()
                .is_some_and(|p| p == "paths" || p == "patch" || p == "source")
        {
            report.add(
                rel,
                i + 1,
                "deps-source",
                "`paths`/`patch`/`source` override in cargo config (SC-11)".into(),
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Entitlements (SIGN-1)

/// `<key>` names of a plist, XML comments removed, in order, with whether the next element is
/// `<true/>`.
pub fn plist_keys(xml: &str) -> Vec<(String, bool)> {
    let mut text = String::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<!--") {
        text.push_str(&rest[..start]);
        rest = rest[start..]
            .find("-->")
            .map_or("", |end| &rest[start + end + 3..]);
    }
    text.push_str(rest);
    let mut keys = Vec::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find("<key>") {
        let after = &rest[start + 5..];
        let Some(end) = after.find("</key>") else {
            break;
        };
        let tail = after[end + 6..].trim_start();
        keys.push((after[..end].trim().to_owned(), tail.starts_with("<true/>")));
        rest = &after[end..];
    }
    keys
}

fn audit_entitlements(rel: &str, xml: &str, report: &mut Report) {
    let keys = plist_keys(xml);
    for (key, _) in &keys {
        if key != HYPERVISOR_ENTITLEMENT {
            let why = if FORBIDDEN_ENTITLEMENTS.contains(&key.as_str())
                || key.starts_with("com.apple.private.")
            {
                "forbidden entitlement"
            } else {
                "unexpected entitlement"
            };
            report.add(rel, 1, "entitlements", format!("{why} {key:?} (SIGN-1)"));
        }
    }
    let hv: Vec<&(String, bool)> = keys
        .iter()
        .filter(|(k, _)| k == HYPERVISOR_ENTITLEMENT)
        .collect();
    match hv.as_slice() {
        [(_, true)] => {}
        [] => report.add(
            rel,
            1,
            "entitlements",
            format!("{HYPERVISOR_ENTITLEMENT} missing (SIGN-1)"),
        ),
        [(_, false)] => report.add(
            rel,
            1,
            "entitlements",
            format!("{HYPERVISOR_ENTITLEMENT} is not <true/>"),
        ),
        _ => report.add(
            rel,
            1,
            "entitlements",
            format!("{HYPERVISOR_ENTITLEMENT} listed twice"),
        ),
    }
}

// ---------------------------------------------------------------------------------------------
// File walking

/// What [`walk`] found under the scanned tops.
#[derive(Debug, Default)]
pub struct Tree {
    /// Regular files as `(repo-relative path, absolute path)`, sorted.
    pub files: Vec<(String, PathBuf)>,
    /// Repo-relative paths of symlinks, which are never followed (and are findings).
    pub symlinks: Vec<String>,
}

/// Directories never scanned: the guests' own build output (the workspace's `target/` is at
/// the repository root, outside the scanned tops). Nothing nested under `crates/` is skipped:
/// a module directory may legitimately be called `target` or start with a dot.
const SKIP_DIRS: &[&str] = &["guests/target"];

/// Every file under `root/<top>` for each top directory.
pub fn walk(root: &Path, tops: &[&str]) -> io::Result<Tree> {
    let mut files = BTreeMap::new();
    let mut symlinks = Vec::new();
    for top in tops {
        let dir = root.join(top);
        if dir.is_symlink() {
            symlinks.push((*top).to_owned());
        } else if dir.is_dir() {
            walk_dir(root, &dir, &mut files, &mut symlinks)?;
        }
    }
    symlinks.sort();
    Ok(Tree {
        files: files.into_iter().collect(),
        symlinks,
    })
}

fn walk_dir(
    root: &Path,
    dir: &Path,
    files: &mut BTreeMap<String, PathBuf>,
    symlinks: &mut Vec<String>,
) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?; // does not follow symlinks
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if ty.is_symlink() {
            symlinks.push(rel);
        } else if ty.is_dir() {
            if !SKIP_DIRS.contains(&rel.as_str()) {
                walk_dir(root, &path, files, symlinks)?;
            }
        } else if ty.is_file() {
            files.insert(rel, path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(rel: &str, src: &str) -> Vec<&'static str> {
        let mut r = Report::default();
        audit_rust(rel, src, &mut r);
        let mut rules: Vec<&'static str> = r.findings.iter().map(|f| f.rule).collect();
        rules.dedup();
        rules
    }

    /// FDT-1 (M7): the audit check `fdt_reader_unreachable`.
    #[test]
    fn fdt_reader_unreachable() {
        let gated =
            "#[cfg(any(test, feature = \"test-util\"))]\npub mod reader;\npub mod writer;\n";
        assert!(run("crates/vmm/src/fdt/mod.rs", gated).is_empty());
        for bad in [
            "pub mod reader;\n",
            "#[cfg(feature = \"fuzzing\")]\npub mod reader;\n",
            "#[cfg(all())]\npub mod reader;\n",
        ] {
            assert_eq!(
                run("crates/vmm/src/fdt/mod.rs", bad),
                ["fdt-reader-unreachable"],
                "{bad}"
            );
        }
        for (rel, src) in [
            (
                "crates/vmm/src/machine/mod.rs",
                "fn f() { crate::fdt::reader::parse(b); }\n",
            ),
            (
                "crates/vmm/src/lib.rs",
                "#![deny(unsafe_code)]\nuse crate::fdt::{reader, writer};\n",
            ),
            (
                "crates/macvmm/src/cli.rs",
                "use vmm::fdt::reader::parse as p;\n",
            ),
            ("crates/macvmm/src/cli.rs", "use vmm::fdt::*;\n"),
            (
                "crates/macvmm/src/sneaky.rs",
                "use vmm::fdt as dt;\npub fn f(b: &[u8]) { let _ = dt::reader::parse(b); }\n",
            ),
            ("crates/macvmm/src/cli.rs", "use vmm::{fdt as dt};\n"),
            ("crates/vmm/src/machine/mod.rs", "use crate::fdt as f;\n"),
            ("crates/vmm/src/lib.rs", "use self::fdt as f;\n"),
            ("crates/vmm/src/fdt/machine.rs", "use super::{self as m};\n"),
            ("crates/macvmm/src/cli.rs", "use vmm::fdt::{self as dt};\n"),
            ("crates/vmm/src/fdt/mod.rs", "pub use self::reader as r;\n"),
            ("crates/vmm/src/fdt/machine.rs", "use super::reader::Fdt;\n"),
            (
                "crates/vmm/src/fdt/mod.rs",
                "#[cfg(test)]\npub mod reader;\npub use reader::parse;\n",
            ),
        ] {
            assert!(
                run(rel, src).contains(&"fdt-reader-unreachable"),
                "{rel}: {src}"
            );
        }
        // Tests, the fuzz crate and the reader itself may use it.
        for (rel, src) in [
            ("crates/vmm/tests/fdt_writer.rs", "use vmm::fdt::reader;\n"),
            (
                "crates/macvmm/tests/e2e_guests.rs",
                "fn f() { vmm::fdt::reader::parse(b); }\n",
            ),
            ("crates/fuzz/src/fdt.rs", "use vmm::fdt::reader;\n"),
            (
                "crates/vmm/src/fdt/machine.rs",
                "fn f() {}\n#[cfg(test)]\nmod tests { use super::super::reader; use crate::fdt::reader::parse; }\n",
            ),
            ("crates/vmm/src/fdt/reader.rs", "use self::reader::x;\n"),
            // Naming `fdt` without a rename, or renaming something beside it, is fine.
            (
                "crates/macvmm/src/cli.rs",
                "use vmm::fdt;\nuse vmm::fdt::writer as w;\n",
            ),
            (
                "crates/vmm/src/machine/mod.rs",
                "use crate::fdt::FdtWriter as W;\n",
            ),
        ] {
            assert!(
                !run(rel, src).contains(&"fdt-reader-unreachable"),
                "{rel}: {src}"
            );
        }
    }

    #[test]
    fn safety_comment_rules() {
        let ok = "fn f() {\n    // SAFETY: fine\n    // more words\n    unsafe { g() }\n}\n";
        assert!(run("crates/hvf/src/x.rs", ok).is_empty());
        let bad = "fn f() {\n    let x = 1;\n    unsafe { g() }\n}\n";
        assert_eq!(run("crates/hvf/src/x.rs", bad), vec!["safety-comment"]);
        assert!(
            run(
                "crates/hvf/src/x.rs",
                "pub unsafe fn f() {}\nunsafe extern \"C\" {}\n"
            )
            .is_empty()
        );
        assert_eq!(
            run(
                "crates/vmm/src/bus.rs",
                "fn f() { let _ = 1; }\nunsafe fn g() {}\n"
            ),
            vec!["unsafe-quarantine"]
        );
    }

    #[test]
    fn unsafe_lint_overrides_outside_quarantine() {
        for attr in [
            "#[allow(unsafe_code)]",
            "#![allow(unsafe_code)]",
            "#[expect(unsafe_code)]",
            "#[warn(unsafe_code)]",
            "#[allow(dead_code, unsafe_code)]",
            "#[cfg_attr(any(), allow(unsafe_code))]",
        ] {
            let src = format!("{attr}\npub fn f() {{}}\n");
            assert_eq!(
                run("crates/vmm/src/a.rs", &src),
                vec!["unsafe-allow"],
                "{attr}"
            );
        }
        let host = "#![allow(unsafe_code)]\npub fn f() {}\n";
        assert!(run("crates/vmm/src/memory/host.rs", host).is_empty());
        assert!(run("crates/vmm/src/a.rs", "#![deny(unsafe_code)]\n").is_empty());
    }

    #[test]
    fn path_attributes_include_and_std_rename_are_refused() {
        assert_eq!(
            run(
                "crates/vmm/src/lib2.rs",
                "#[path = \".priv/x.rs\"]\nmod x;\n"
            ),
            vec!["no-path-attr"]
        );
        assert_eq!(
            run(
                "crates/vmm/src/a.rs",
                "#[cfg_attr(unix, path = \"u.rs\")]\nmod x;\n"
            ),
            vec!["no-path-attr"]
        );
        assert_eq!(
            run("crates/vmm/src/a.rs", "include!(\"gen.rs\");\n"),
            vec!["no-include"]
        );
        assert_eq!(
            run("crates/macvmm/src/a.rs", "extern crate std as s;\n"),
            vec!["std-alias"]
        );
        // A variable called `path` and include_str! are fine.
        assert!(
            run(
                "crates/vmm/src/a.rs",
                "fn f() { let path = \"x\"; let _ = include_str!(\"a.txt\"); }\n"
            )
            .is_empty()
        );
    }

    #[test]
    fn layout_literal_spellings() {
        for lit in ["0x0900_0000", "0x09000000", "0X0900_0000u64", "0x4000_0000"] {
            let src = format!("const A: u64 = {lit};\n");
            assert_eq!(
                run("crates/macvmm/src/x.rs", &src),
                vec!["layout-literal"],
                "{lit}"
            );
        }
        assert!(
            run(
                "crates/vmm/src/arch/layout.rs",
                "const A: u64 = 0x0900_0000;\n"
            )
            .is_empty()
        );
        assert!(
            run(
                "crates/vmm/src/x.rs",
                "fn f() {}\n#[cfg(test)]\nmod t { const A: u64 = 0x0900_0000; }\n"
            )
            .is_empty()
        );
        assert!(
            run(
                "crates/vmm/src/x.rs",
                "// 0x0900_0000 in a comment\nconst S: &str = \"0x0900_0000\";\n"
            )
            .is_empty()
        );
    }

    #[test]
    fn cfg_test_exempts_only_the_test_module() {
        // `#[cfg(test)]` on a `use` exempts nothing that follows.
        let src = "#[cfg(test)]\nuse std::fs as _f;\npub fn open() -> u64 { let _ = std::fs::File::open(\"x\"); 0x4000_0000u64 }\n";
        let mut rules = run("crates/vmm/src/a.rs", src);
        rules.sort();
        assert_eq!(rules, vec!["hostio-only", "layout-literal"]);
        // Code after a test module is not exempt either.
        let src = "#[cfg(test)]\n#[allow(clippy::all)]\nmod tests { const A: u64 = 0x4000_0000; }\npub const B: u64 = 0x4000_0000;\n";
        let mut r = Report::default();
        audit_rust("crates/vmm/src/a.rs", src, &mut r);
        assert_eq!(
            r.findings
                .iter()
                .map(|f| (f.rule, f.line))
                .collect::<Vec<_>>(),
            vec![("layout-literal", 4)]
        );
    }

    #[test]
    fn only_integration_test_crates_are_test_paths() {
        assert!(is_test_path("crates/macvmm/tests/support/mod.rs"));
        assert!(is_test_path("crates/vmm/tests/memory_hostile.rs"));
        assert!(!is_test_path("crates/vmm/src/devices/tests/helpers.rs"));
        assert!(!is_test_path("crates/vmm/src/tests.rs"));
        let src = "use std::process::Command;\nuse std::net::TcpStream;\npub fn f() { let _ = std::fs::File::open(\"x\"); }\n";
        let mut rules = run("crates/vmm/src/devices/tests/helpers.rs", src);
        rules.sort();
        assert_eq!(rules, vec!["hostio-only", "no-command", "no-net"]);
    }

    #[test]
    fn command_net_and_file_rules() {
        assert_eq!(
            run("crates/vmm/src/a.rs", "use std::process::Command;\n"),
            vec!["no-command"]
        );
        assert_eq!(
            run(
                "crates/vmm/src/a.rs",
                "use std::process::{exit, Command};\n"
            ),
            vec!["no-command"]
        );
        assert!(
            run(
                "crates/macvmm/src/doctor.rs",
                "use std::process::Command;\n"
            )
            .is_empty()
        );
        assert!(
            run(
                "crates/macvmm/tests/support/mod.rs",
                "use std::process::Command;\n"
            )
            .is_empty()
        );
        assert!(
            run(
                "crates/macvmm/src/main.rs",
                "#![forbid(unsafe_code)]\nuse std::process::ExitCode;\n"
            )
            .is_empty()
        );
        assert_eq!(
            run("crates/vmm/src/a.rs", "use std::net::TcpStream;\n"),
            vec!["no-net"]
        );
        assert_eq!(
            run(
                "crates/vmm/src/a.rs",
                "use std::os::unix::net::UnixDatagram;\n"
            ),
            vec!["no-net"]
        );
        assert!(
            run(
                "crates/vmm/src/net/unixgram.rs",
                "use std::os::unix::net::UnixDatagram;\n"
            )
            .is_empty()
        );
        assert_eq!(
            run(
                "crates/vmm/src/a.rs",
                "fn f() { let _ = std::fs::File::open(p); }\n"
            ),
            vec!["hostio-only"]
        );
        assert_eq!(
            run(
                "crates/vmm/src/a.rs",
                "fn f() { let _ = std::fs::read(p); }\n"
            ),
            vec!["hostio-only"]
        );
        assert!(
            run(
                "crates/vmm/src/backend/hostio.rs",
                "fn f() { let _ = std::fs::File::open(p); }\n"
            )
            .is_empty()
        );
        assert!(
            run(
                "crates/macvmm/src/main.rs",
                "#![forbid(unsafe_code)]\nfn f() { let _ = std::fs::read(p); }\n"
            )
            .is_empty()
        );
    }

    #[test]
    fn every_import_spelling_of_banned_items_is_caught() {
        let cases: &[(&str, &str)] = &[
            ("use std::{io, net::TcpStream};\n", "no-net"),
            ("use std::{os::{unix::{net::UnixStream}}};\n", "no-net"),
            ("use ::std::net::UdpSocket;\n", "no-net"),
            ("use std::net::*;\n", "no-net"),
            (
                "use std::os::unix as u;\nfn f() { u::net::UnixStream::pair(); }\n",
                "no-net",
            ),
            (
                "fn f() { let _ = ::std::net::TcpListener::bind(a); }\n",
                "no-net",
            ),
            (
                "use std::process::*;\nfn f() { Command::new(\"sh\"); }\n",
                "no-command",
            ),
            (
                "use std::process as p;\nfn f() { p::Command::new(\"sh\"); }\n",
                "no-command",
            ),
            ("use std::{process::{self as p}};\n", "no-command"),
            (
                "use std::process;\nfn f() { process::Command::new(\"sh\"); }\n",
                "no-command",
            ),
            ("use std::{io, process::Command};\n", "no-command"),
            ("use std as s;\n", "no-command"),
            (
                "use std::fs::File as F;\nfn f() { F::open(p); }\n",
                "hostio-only",
            ),
            ("use std::fs::*;\n", "hostio-only"),
            ("use std::fs as f;\n", "hostio-only"),
            (
                "use std::fs::copy;\nfn f() { copy(a, b); }\n",
                "hostio-only",
            ),
            (
                "fn f() { std::fs::copy(a, b); std::fs::rename(a, b); }\n",
                "hostio-only",
            ),
            (
                "use std::fs;\nfn f() { fs::create_dir_all(p); }\n",
                "hostio-only",
            ),
            (
                "fn f() { std::os::unix::fs::symlink(a, b); }\n",
                "hostio-only",
            ),
            ("use std::os::unix::fs::OpenOptionsExt;\n", "hostio-only"),
            ("fn f() { <std::fs::File>::create(p); }\n", "hostio-only"),
            (
                "use std::{fs::{File}};\nfn f() { File::options(); }\n",
                "hostio-only",
            ),
        ];
        for (src, rule) in cases {
            let rules = run("crates/vmm/src/a.rs", src);
            assert!(rules.contains(rule), "{src:?}: {rules:?}");
        }
        // Allowed: types and fd-based traits, `as _` trait imports, unrelated `write`.
        let ok = "use std::fs::File;\nuse std::os::unix::fs::FileExt;\nuse std::io::Write as _;\nfn f(file: &File) { let _ = file.read_at(b, 0); let _ = std::fmt::write(o, a); }\n";
        assert!(run("crates/vmm/src/a.rs", ok).is_empty());
    }

    #[test]
    fn manifest_parsing() {
        let toml = "[package]\nname = \"x\"\n[dependencies]\nhvf = { path = \"../hvf\" }\nlibc = \"0.2\"\n\
                    [target.'cfg(unix)'.dev-dependencies]\nrand = \"0.8\"\n[dependencies.serde]\nversion = \"1\"\n";
        let scan = manifest_deps("crates/vmm", toml);
        assert!(scan.problems.is_empty(), "{:?}", scan.problems);
        let got: Vec<(&str, &DepSource)> = scan
            .deps
            .iter()
            .map(|d| (d.package.as_str(), &d.source))
            .collect();
        assert_eq!(
            got,
            vec![
                ("hvf", &DepSource::Path(Some("crates/hvf".into()))),
                ("libc", &DepSource::Registry),
                ("rand", &DepSource::Registry),
                ("serde", &DepSource::Registry),
            ]
        );
    }

    #[test]
    fn manifest_local_detection_is_by_key_not_substring() {
        let toml = "[dependencies]\n\
            evil = { version = \"1\", features = [\"xpath\"] }\n\
            glob-path = \"1\"\n\
            ws = { version = \"1\", features = [\"workspace\"] }\n\
            foo = { git = \"https://example.com/some/path/foo\" }\n\
            bar = { version = \"1\", registry = \"workspace-mirror\" }\n\
            alias = { package = \"real-crate\", version = \"1\" }\n\
            up = { path = \"../../../elsewhere\" }\n\
            abs = { path = \"/tmp/x\" }\n\
            inh.workspace = true\n\
            dotted.git = \"https://example.com/x\"\n";
        let scan = manifest_deps("crates/vmm", toml);
        let by = |k: &str| {
            scan.deps
                .iter()
                .find(|d| d.key == k)
                .map(|d| (d.package.clone(), d.source.clone()))
                .unwrap()
        };
        assert_eq!(by("evil").1, DepSource::Registry);
        assert_eq!(by("glob-path").1, DepSource::Registry);
        assert_eq!(by("ws").1, DepSource::Registry);
        assert!(matches!(by("foo").1, DepSource::Rejected(_)));
        assert!(matches!(by("bar").1, DepSource::Rejected(_)));
        assert_eq!(by("alias"), ("real-crate".into(), DepSource::Registry));
        assert_eq!(by("up").1, DepSource::Path(None));
        assert_eq!(by("abs").1, DepSource::Path(None));
        assert_eq!(by("inh").1, DepSource::Workspace);
        assert!(matches!(by("dotted").1, DepSource::Rejected(_)));
    }

    #[test]
    fn manifest_fails_closed_on_unmodelled_syntax() {
        for toml in [
            "[patch.crates-io]\nfoo = { git = \"https://x\" }\n",
            "[replace]\n\"foo:1.0.0\" = { git = \"https://x\" }\n",
            "[dependencies]\nfoo = { version = \"1\",\n  git = \"https://x\" }\n",
            "[package]\ndescription = \"\"\"\n[package]\n\"\"\"\n",
            "[dependencies]\nnot a key value line\n",
        ] {
            assert!(
                !manifest_deps("crates/vmm", toml).problems.is_empty(),
                "{toml:?}"
            );
        }
        // A multi-line array is fine, and its lines are not dependencies.
        let toml = "[dependencies.foo]\nversion = \"1\"\nfeatures = [\n  \"a\",\n  \"b\",\n]\n[dependencies]\nbar = \"1\"\n";
        let scan = manifest_deps("crates/vmm", toml);
        assert!(scan.problems.is_empty(), "{:?}", scan.problems);
        assert_eq!(
            scan.deps.iter().map(|d| d.key.as_str()).collect::<Vec<_>>(),
            vec!["foo", "bar"]
        );
        // `#` inside a string is not a comment.
        let scan = manifest_deps(
            "crates/vmm",
            "[dependencies]\nx = { git = \"https://h/#a\" }\n",
        );
        assert!(matches!(scan.deps[0].source, DepSource::Rejected(_)));
    }

    #[test]
    fn lock_sources_and_checksums() {
        let lock = "version = 4\n[[package]]\nname = \"hvf\"\nversion = \"0.1.0\"\n\n\
            [[package]]\nname = \"libc\"\nversion = \"0.2\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"ab\"\n\n\
            [[package]]\nname = \"libc2\"\nversion = \"0.2\"\nsource = \"git+https://example.com/evil-libc#abc\"\n\n\
            [[package]]\nname = \"nosum\"\nversion = \"1\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        let allow = vec!["libc".to_owned(), "libc2".to_owned(), "nosum".to_owned()];
        let mut r = Report::default();
        audit_lock("Cargo.lock", lock, &allow, &mut r);
        let got: Vec<(usize, &str)> = r.findings.iter().map(|f| (f.line, f.rule)).collect();
        assert_eq!(got, vec![(12, "deps-source"), (17, "deps-source")]);
        assert_eq!(lock_packages(lock).len(), 4);
    }

    #[test]
    fn cargo_config_source_overrides_fail() {
        for cfg in [
            "[patch.crates-io]\nfoo = { path = \"x\" }\n",
            "[source.crates-io]\nreplace-with = \"evil\"\n",
            "paths = [\"../evil\"]\n",
        ] {
            let mut r = Report::default();
            audit_cargo_config(".cargo/config.toml", cfg, &mut r);
            assert_eq!(r.findings.len(), 1, "{cfg:?}");
        }
        let ok = "[target.aarch64-apple-darwin]\nrunner = [\"scripts/sign-and-run.sh\"]\n[alias]\nxtask = \"run --quiet -p xtask --\"\n";
        let mut r = Report::default();
        audit_cargo_config(".cargo/config.toml", ok, &mut r);
        assert!(r.findings.is_empty(), "{:?}", r.findings);
    }

    #[test]
    fn fault_injection_stays_test_only() {
        let lines = |rel: &str, toml: &str| -> Vec<usize> {
            fault_injection_scope(rel, toml)
                .into_iter()
                .map(|(l, _)| l)
                .collect()
        };
        // The real hvf shape: the definition, and a comment naming it, are fine.
        let hvf = "[package]\nname = \"hvf\"\n[dev-dependencies]\nvmm = { path = \"../vmm\" }\n\
                   [features]\nhvf-tests = []\n# fault-injection: test-only\n\
                   fault-injection = [\"hvf-tests\"]\n";
        assert!(lines(FEATURE_OWNER, hvf).is_empty());
        // ...but no other hvf feature may imply it (macvmm's `hvf-tests` reaches `hvf-tests`).
        let bad_hvf = [
            "[features]\ndefault = [\"fault-injection\"]\n",
            "[features]\nhvf-tests = [\"fault-injection\"]\nfault-injection = []\n",
            "[features]\nhvf-tests = [\n  \"x\",\n  \"fault-injection\",\n]\n",
            "features.default = [\"fault-injection\"]\n",
        ];
        for toml in bad_hvf {
            assert!(!lines(FEATURE_OWNER, toml).is_empty(), "{toml:?}");
        }
        // Every non-dev spelling in another crate is refused.
        let bad = [
            "[dependencies]\nhvf = { path = \"../hvf\", features = [\"fault-injection\"] }\n",
            "[dependencies.hvf]\npath = \"../hvf\"\nfeatures = [\n  \"fault-injection\",\n]\n",
            "[target.'cfg(unix)'.dependencies]\nhvf = { path = \"../hvf\", features = [\"fault-injection\"] }\n",
            "[features]\ndebug-teardown = [\"hvf/fault-injection\"]\n",
            "[features]\nx = [\"hvf?/fault-injection\"]\n",
            "[features]\nfault-injection = [\"hvf/fault-injection\"]\n",
            "[workspace.dependencies]\nhvf = { path = \"crates/hvf\", features = [\"fault-injection\"] }\n",
            "[dependencies]\nhvf = { path = \"../hvf\", features = [\"fault\\u002Dinjection\"] }\n",
        ];
        for toml in bad {
            assert!(!lines("crates/vmm/Cargo.toml", toml).is_empty(), "{toml:?}");
            assert!(!lines("Cargo.toml", toml).is_empty(), "{toml:?}");
        }
        assert_eq!(lines("crates/vmm/Cargo.toml", bad[1]), vec![4]);
        // A dev-dependency edge is fine outside macvmm, in any table spelling.
        let dev = "[dev-dependencies]\nhvf = { path = \"../hvf\", features = [\"fault-injection\"] }\n\
                   [target.'cfg(unix)'.dev-dependencies.hvf]\nfeatures = [\"fault-injection\"]\n\
                   [features]\nother = []\n";
        assert!(lines("crates/vmm/Cargo.toml", dev).is_empty());
        // The section ends at the next header: a later [features] line is checked again.
        let after = format!("{dev}x = [\"hvf/fault-injection\"]\n");
        assert_eq!(lines("crates/vmm/Cargo.toml", &after), vec![7]);
        // macvmm: any mention at all, a dev-dependency or a comment included.
        for toml in [
            "[dev-dependencies]\nhvf = { path = \"../hvf\", features = [\"fault-injection\"] }\n",
            "# turn on fault-injection for debugging\n[features]\nx = []\n",
        ] {
            assert!(!lines(PRODUCT_MANIFEST, toml).is_empty(), "{toml:?}");
        }
        // Wired into the manifest audit.
        let mut r = Report::default();
        audit_manifest("crates/vmm/Cargo.toml", bad[3], &[], &mut r);
        assert_eq!(
            r.findings.iter().map(|f| f.rule).collect::<Vec<_>>(),
            vec!["fault-injection-scope"]
        );
    }

    #[test]
    fn plist_comments_are_ignored() {
        let xml = "<plist><!-- <key>com.apple.security.cs.allow-jit</key> --><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>";
        assert_eq!(
            plist_keys(xml),
            vec![("com.apple.security.hypervisor".to_owned(), true)]
        );
    }
}
