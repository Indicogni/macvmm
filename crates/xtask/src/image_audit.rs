//! The SC-14 rule of `cargo xtask audit`: no script, test or lesson hands a disk image to a
//! host parser that runs in the macOS kernel (PLAN M15; threat model SC-14, flaw F24).
//!
//! **Why.** After a VM has run, every byte of its writable disk is guest-controlled. `hdiutil
//! attach`, `mount` or `open(1)` on such an image gives a guest-crafted FAT/HFS/APFS/ext
//! filesystem to the host kernel's filesystem drivers, which is a kernel attack surface. The
//! only host parser allowed on a guest-written image is the read-only `e2fsck -fn` of the
//! `rootfs_fsck_clean` test, on a per-test clone; inspection otherwise happens inside a VM
//! (attach the image `,ro` to a fresh guest).
//!
//! **The rule.** Under `scripts/`, `crates/` and `course/`:
//! - a *command* `mount` (or a macOS helper `mount_<fs>`) or `open` whose arguments (up to the
//!   end of that command: `;`, `|`, `&`, `)` or the end of the line) include a path ending in
//!   `.img` or `.raw` (any case, quotes and trailing punctuation ignored) is a finding;
//! - a command `hdiutil attach` or `hdiutil mount` is a finding **whatever its argument**
//!   (`hdiutil attach "$IMG"` hides the path in a variable, and attaching *any* image hands it
//!   to a kernel filesystem parser);
//! - in a `.rs` file, `Command::new("…")` naming `hdiutil`, `mount`, `mount_<fs>`, `open` or
//!   `diskutil` (bare or by absolute path) is a finding whatever its arguments: Rust tests
//!   spawn tools that way, and nothing in this repo has a reason to.
//!
//! A command is matched on the **basename** of its word, so `/sbin/mount`, `/usr/bin/open` and
//! `/usr/bin/hdiutil` (this repo runs host tools by absolute path) are the same commands. A
//! word is in command position at the start of a line (after comment, list or quote markers),
//! after a shell separator or a prefix word ([`PREFIX_WORDS`]: `sudo`, `env`, `nohup`, `then`
//! …; option words such as `-n` or `-u root` and `VAR=value` assignments after a prefix keep
//! the position), or inside a word after `$(`, `(`, a backquote or a quote. Words are
//! separated by whitespace, so `File::open(img)` and `OpenOptions::new().open(&disk)` are not
//! commands.
//!
//! **Teaching the rule is allowed.** A lesson must be able to say "never `mount` a
//! guest-written `disk.img` on the host". An occurrence is therefore allowed when a negation
//! word (`never`, `not`, `don't`, `do not`, `no`, `must not`) appears earlier **in the same
//! command segment**: after the last shell separator (`;`, `|`, `&`, `$(`) before the command,
//! so `echo no; hdiutil attach r.img` is still a finding. Backquotes do not end the segment,
//! because Markdown uses them for inline code ("Never run `hdiutil attach …`"). This is the
//! same convention as the AS9 forbidden-advice audit ([`crate::vz_audit`]). The `Command::new`
//! form has no exemption: it is code, not prose.
//!
//! Files are read as bytes (`from_utf8_lossy`), so a non-UTF-8 file is scanned too; only the
//! build-output paths in [`SKIP_PATHS`] and this rule's own two files ([`SELF_FILES`], which
//! must spell the commands they detect) are skipped.

use crate::audit::{Finding, Report};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The trees scanned.
pub const TREES: [&str; 3] = ["scripts", "crates", "course"];

/// Build output that is never committed (exact repo-relative paths).
pub const SKIP_PATHS: [&str; 2] = ["course/site/node_modules", "course/site/dist"];

/// The rule's own definition and its fixtures, which must spell offending commands. Exact
/// paths: nothing else is exempt.
pub const SELF_FILES: [&str; 2] = [
    "crates/xtask/src/image_audit.rs",
    "crates/xtask/tests/image_audit.rs",
];

/// Files larger than this are not scanned (no source or lesson comes close).
const MAX_SCAN_BYTES: u64 = 16 << 20;

const RULE: &str = "no-host-mount-of-guest-image";

/// Words after which the next word is in command position (the shell's reserved words that
/// precede a command, and the wrappers that run their argument as a command).
pub const PREFIX_WORDS: [&str; 10] = [
    "sudo", "exec", "command", "then", "do", "else", "env", "nohup", "time", "nice",
];

/// Program basenames a Rust `Command::new` may not name (see the module doc).
const RUST_FORBIDDEN: [&str; 4] = ["hdiutil", "mount", "open", "diskutil"];

/// Negations that make an occurrence teaching rather than advice.
const NEGATIONS: [&str; 5] = ["never", "not", "don't", "no", "dont"];

/// Scan `root`'s [`TREES`] and add a finding per offending command.
pub fn audit_host_mounts(root: &Path, report: &mut Report) -> io::Result<()> {
    let mut files = Vec::new();
    for top in TREES {
        collect(root, &root.join(top), &mut files)?;
    }
    files.sort();
    for (rel, path) in files {
        if SELF_FILES.contains(&rel.as_str()) {
            continue;
        }
        let meta = fs::symlink_metadata(&path)?;
        if meta.len() > MAX_SCAN_BYTES {
            continue;
        }
        let bytes = fs::read(&path)?;
        report.files_scanned += 1;
        audit_text(&rel, &String::from_utf8_lossy(&bytes), report);
    }
    Ok(())
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Ok(()); // a tree that does not exist yet passes vacuously
    };
    for entry in rd {
        let entry = entry?;
        let ty = entry.file_type()?; // never follows symlinks (audit.rs reports them)
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if ty.is_dir() {
            if !SKIP_PATHS.contains(&rel.as_str()) && rel != "guests/target" {
                collect(root, &path, out)?;
            }
        } else if ty.is_file() {
            out.push((rel, path));
        }
    }
    Ok(())
}

/// Strip quotes, backquotes and trailing punctuation from a shell word.
fn bare(w: &str) -> &str {
    w.trim_matches(|c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '(' | ')' | ',' | '.' | ':' | '{' | '}'
        )
    })
}

fn is_image_path(w: &str) -> bool {
    let b = bare(w).to_ascii_lowercase();
    // `bare` already dropped a trailing `.`, so `disk.img.` is `disk.img`.
    b.len() > 4 && (b.ends_with(".img") || b.ends_with(".raw"))
}

fn negated(before: &str) -> bool {
    // Only the current command segment counts: a negation in an earlier command of the line
    // (`echo no; hdiutil attach r.img`) does not make this one teaching.
    let seg = before
        .rfind([';', '|', '&'])
        .map(|k| k + 1)
        .into_iter()
        .chain(before.rfind("$(").map(|k| k + 2))
        .max()
        .map_or(before, |k| &before[k..]);
    let lower = seg.to_ascii_lowercase();
    lower
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '\''))
        .any(|w| NEGATIONS.contains(&w))
}

/// The program a command word names: quotes stripped, then the basename (`/sbin/mount` →
/// `mount`).
fn command_name(w: &str) -> &str {
    let b = bare(w);
    b.rsplit('/').next().unwrap_or(b)
}

/// `NAME=value`, a shell variable assignment, which leaves the next word in command position.
fn is_assignment(w: &str) -> bool {
    match w.split_once('=') {
        Some((name, _)) => {
            !name.is_empty()
                && !name.starts_with(|c: char| c.is_ascii_digit())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        None => false,
    }
}

/// The offending commands of one line, as `(byte offset, command name)`.
pub fn offending_commands(line: &str) -> Vec<(usize, &'static str)> {
    // Split into words, remembering offsets; separators end a command and put the next word
    // in command position.
    let mut out = Vec::new();
    let mut words: Vec<(usize, &str)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in line.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                words.push((s, &line[s..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        words.push((s, &line[s..]));
    }
    let mut cmd_pos = true;
    // After a prefix word (`sudo`, `env` …): its options and assignments keep command position.
    let mut after_prefix = false;
    // The previous word was an option such as `-u` of `sudo -u root`, whose argument follows.
    let mut after_option = false;
    let mut i = 0;
    while i < words.len() {
        let (off, raw) = words[i];
        // A word may contain `$(`, a backquote, `(` or a quote (`out=$(hdiutil`, `sh("mount`,
        // Markdown's `` `open ``): what follows the last of them is in command position.
        let (w, opens) = match raw.rfind(['(', '`', '"', '\'']) {
            Some(k) => (&raw[k + 1..], true),
            None => (raw, false),
        };
        let ends_cmd = raw.ends_with([';', '|', '&', ')', '`']);
        if cmd_pos || opens {
            let name = command_name(w);
            let cmd: Option<(&'static str, bool)> = match name {
                "mount" => Some(("mount", false)),
                n if n.starts_with("mount_") && n.len() > 6 => Some(("mount", false)),
                "open" => Some(("open", false)),
                "hdiutil" => match words.get(i + 1).map(|(_, n)| bare(n)) {
                    Some("attach") => Some(("hdiutil attach", true)),
                    Some("mount") => Some(("hdiutil mount", true)),
                    _ => None,
                },
                _ => None,
            };
            if let Some((cmd, always)) = cmd {
                let mut hit = always;
                if !always && !ends_cmd {
                    let mut j = i + 1;
                    while j < words.len() {
                        let a = words[j].1;
                        if is_image_path(a.trim_end_matches([';', '|', '&', ')'])) {
                            hit = true;
                        }
                        if a.ends_with([';', '|', '&', ')', '`']) {
                            break;
                        }
                        j += 1;
                    }
                }
                if hit && !negated(&line[..off]) {
                    out.push((off, cmd));
                }
            }
        }
        let b = bare(raw);
        let is_prefix = PREFIX_WORDS.contains(&b);
        let separator = ends_cmd || matches!(raw, ";" | "|" | "||" | "&&" | "&" | "$(" | "`");
        // A word that opened a nested command (`out=$(hdiutil`) was itself the command.
        let keeps = cmd_pos
            && !ends_cmd
            && !opens
            && (is_assignment(b) || (after_prefix && (b.starts_with('-') || after_option)));
        after_option = keeps && after_prefix && b.starts_with('-') && !b.contains('=');
        after_prefix = !separator && (is_prefix || (after_prefix && keeps));
        cmd_pos = separator || is_prefix || keeps;
        i += 1;
    }
    out
}

/// The offending `Command::new("…")` calls of a Rust source, as `(byte offset, program)`.
/// The literal may follow `(` on the next line (rustfmt) and may be a raw string `r"…"`.
pub fn offending_rust_commands(text: &str) -> Vec<(usize, String)> {
    const CALL: &str = "Command::new(";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(k) = text[from..].find(CALL) {
        let at = from + k;
        from = at + CALL.len();
        let rest = text[from..].trim_start();
        let rest = rest.strip_prefix('r').unwrap_or(rest);
        let Some(lit) = rest.strip_prefix('"') else {
            continue; // a variable or constant: not decidable here
        };
        let Some(end) = lit.find('"') else { continue };
        let prog = &lit[..end];
        let base = prog.rsplit('/').next().unwrap_or(prog);
        if RUST_FORBIDDEN.contains(&base) || (base.starts_with("mount_") && base.len() > 6) {
            out.push((at, prog.to_owned()));
        }
    }
    out
}

/// Check one file's text.
pub fn audit_text(rel: &str, text: &str, report: &mut Report) {
    for (n, line) in text.lines().enumerate() {
        // List markers, quote markers, comment markers and a `$ ` shell prompt all precede a
        // command in lessons and scripts; inline code backquotes are handled per word.
        let line = line.trim_start_matches(['#', '/', '>', '-', '*', ' ', '\t']);
        let line = line.strip_prefix("$ ").unwrap_or(line);
        for (_, cmd) in offending_commands(line) {
            report.findings.push(Finding {
                path: rel.to_owned(),
                line: n + 1,
                rule: RULE,
                message: format!(
                    "`{cmd}` of a disk image on the host: guest-written images are hostile to \
                     host parsers (SC-14); inspect them inside a VM (attach `,ro` to a fresh guest)"
                ),
            });
        }
    }
    if rel.ends_with(".rs") {
        for (off, prog) in offending_rust_commands(text) {
            report.findings.push(Finding {
                path: rel.to_owned(),
                line: 1 + text[..off].matches('\n').count(),
                rule: RULE,
                message: format!(
                    "`Command::new(\"{prog}\")`: no Rust code spawns a host mount/attach/open \
                     tool; guest-written images are hostile to host parsers (SC-14)"
                ),
            });
        }
    }
}
