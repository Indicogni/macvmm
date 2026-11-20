//! `cargo xtask capture OUT -- CMD [ARGS...]`: record one command's real output as a course
//! capture (`scripts/capture-cmd`).
//!
//! **Why:** every terminal block a lesson shows must be a real run on a real Mac (CLAUDE.md,
//! CURRICULUM §3.6). `scripts/capture.sh NN` records a chapter's *checkpoint* runs; lessons also
//! show runs that are not checkpoint steps: a deliberate break, a "Try it" variant, a hang that a
//! timeout ends. This command records those in the same transcript format, so a lesson quotes
//! them with `:::term source=captures/NN-name.txt` and `scripts/check-lessons` can verify the
//! file exists and carries its provenance header.
//!
//! **Format** (shared with `scripts/capture.sh`; the first line is the provenance header):
//!
//! ```text
//! # scripts/capture-cmd 02: real output, Apple M5 Pro, macOS 27.2.1, commit dad6c99, 2026-11-20.
//! # <one line per --note>
//! # Regenerate with scripts/capture-cmd (course/STYLE.md appendix A); never edit by hand.
//! $ <the command as the learner types it (--show), or the real argv>
//! exit: 0                                (or: "exit: none (stopped by --timeout 5 s: still running)")
//! --- stdout ---
//! …
//! --- stderr ---
//! …
//! ```
//!
//! **Privacy and safety.** The repository path becomes `<repo>`, the `--cwd` tree `<tree>` and the
//! home directory `~`; if the user's login name still appears anywhere (say, in an encoded
//! temporary path), nothing is written and the author is asked for a `--subst`. Control characters other than
//! newline and tab are written as `\x1b`-style escapes, so a capture cannot carry terminal escape
//! sequences into a lesson. The output file must be a well-named file directly in
//! `course/captures/`, and files that `scripts/capture.sh` owns are refused (the harness
//! regenerates those). The command runs with a hard timeout that kills its whole process group
//! ([`crate::checkpoint::run::run_child`]).

use crate::checkpoint::run;
use crate::lessons::valid_capture_name;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// Parsed arguments.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
    pub out: String,
    pub timeout: u64,
    pub cwd: Option<String>,
    pub show: Option<String>,
    pub notes: Vec<String>,
    pub substs: Vec<(String, String)>,
    pub cmd: Vec<String>,
}

pub const USAGE: &str = "usage: scripts/capture-cmd [--timeout SECS] [--cwd DIR] [--show \"CMD\"] [--note TEXT]... [--subst PATH=TOKEN]... course/captures/NN-name.txt -- CMD [ARGS...]";

/// Parse `capture` arguments.
pub fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut a = Args {
        timeout: 60,
        ..Args::default()
    };
    let mut it = args.iter();
    while let Some(x) = it.next() {
        let mut val = |name: &str| it.next().cloned().ok_or(format!("{name} needs a value"));
        match x.as_str() {
            "--timeout" => {
                a.timeout = val("--timeout")?
                    .parse()
                    .ok()
                    .filter(|t| (1..=600).contains(t))
                    .ok_or("--timeout is 1 to 600 seconds")?;
            }
            "--cwd" => a.cwd = Some(val("--cwd")?),
            "--show" => a.show = Some(val("--show")?),
            "--note" => a.notes.push(val("--note")?),
            "--subst" => {
                let v = val("--subst")?;
                let (p, t) = v.split_once('=').ok_or("--subst is PATH=TOKEN")?;
                if p.is_empty() {
                    return Err("--subst PATH is empty".into());
                }
                a.substs.push((p.to_owned(), t.to_owned()));
            }
            "--" => {
                a.cmd = it.cloned().collect();
                break;
            }
            s if s.starts_with("--") => return Err(format!("unknown option {s}")),
            s => {
                if !a.out.is_empty() {
                    return Err(format!(
                        "unexpected argument {s:?} (put the command after `--`)"
                    ));
                }
                a.out = s.to_owned();
            }
        }
    }
    if a.out.is_empty() || a.cmd.is_empty() {
        return Err(USAGE.into());
    }
    Ok(a)
}

/// Make captured text safe to publish: escape control characters, apply path substitutions.
pub fn sanitize(text: &str, substs: &[(String, String)]) -> String {
    let mut s = text.to_owned();
    // Longest paths first, so a tree inside the repo is not half-replaced by `<repo>`.
    let mut pairs: Vec<&(String, String)> = substs.iter().collect();
    pairs.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
    for (p, t) in pairs {
        s = s.replace(p.as_str(), t);
    }
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_control() && c != '\n' && c != '\t' {
            out.push_str(&format!("\\x{:02x}", u32::from(c)));
        } else {
            out.push(c);
        }
    }
    out
}

fn one_line(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|| "unknown".into())
}

/// Resolve and validate the output path; returns (absolute path, file name).
fn out_path(root: &Path, out: &str) -> Result<(PathBuf, String), String> {
    let p = PathBuf::from(out);
    let abs = if p.is_absolute() {
        p
    } else {
        std::env::current_dir().map_err(|e| e.to_string())?.join(p)
    };
    let name = abs
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or("no file name")?;
    if !valid_capture_name(&name) || name.ends_with(".jsonl") {
        return Err(format!(
            "{name:?}: a capture is course/captures/NN-name.txt (lowercase, digits, dashes)"
        ));
    }
    let dir = abs
        .parent()
        .ok_or("no directory")?
        .canonicalize()
        .map_err(|e| format!("{out}: {e}"))?;
    let want = root
        .join("course/captures")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if dir != want {
        return Err(format!("{out}: captures live directly in course/captures/"));
    }
    let abs = dir.join(&name);
    if let Ok(meta) = std::fs::symlink_metadata(&abs) {
        if !meta.file_type().is_file() {
            return Err(format!("{out}: exists and is not a regular file"));
        }
        let head = std::fs::read_to_string(&abs).unwrap_or_default();
        if head.starts_with("# scripts/capture.sh") {
            return Err(format!(
                "{out}: written by scripts/capture.sh (a checkpoint run); regenerate it with that"
            ));
        }
    }
    Ok((abs, name))
}

/// Run the command and write the capture. Returns the transcript written.
pub fn main(root: &Path, raw: &[String]) -> Result<String, String> {
    let a = parse_args(raw)?;
    let (path, name) = out_path(root, &a.out)?;
    let root_c = root.canonicalize().map_err(|e| e.to_string())?;
    let mut substs = a.substs.clone();
    if let Some(cwd) = &a.cwd {
        let c = Path::new(cwd)
            .canonicalize()
            .map_err(|e| format!("--cwd {cwd}: {e}"))?;
        substs.push((c.to_string_lossy().into_owned(), "<tree>".into()));
        // macOS reports /tmp paths both with and without the /private prefix.
        if let Ok(rest) = c.strip_prefix("/private") {
            substs.push((format!("/{}", rest.to_string_lossy()), "<tree>".into()));
        }
    }
    substs.push((root_c.to_string_lossy().into_owned(), "<repo>".into()));
    if let Some(home) = std::env::var_os("HOME") {
        let h = home.to_string_lossy().into_owned();
        if h.len() > 1 {
            substs.push((h, "~".into()));
        }
    }

    let mut cmd = Command::new(&a.cmd[0]);
    cmd.args(&a.cmd[1..]);
    if let Some(cwd) = &a.cwd {
        cmd.current_dir(cwd);
    }
    let limit = Duration::from_secs(a.timeout);
    let proc = run::run_child(cmd, &[], limit, true)?;

    let chip = one_line("/usr/sbin/sysctl", &["-n", "machdep.cpu.brand_string"]);
    let macos = one_line("/usr/bin/sw_vers", &["-productVersion"]);
    let commit = one_line(
        "git",
        &[
            "-C",
            &root_c.to_string_lossy(),
            "rev-parse",
            "--short",
            "HEAD",
        ],
    );
    let date = one_line("/bin/date", &["+%Y-%m-%d"]);
    let id = &name[..2];
    let shown = a.show.clone().unwrap_or_else(|| a.cmd.join(" "));
    let exit = if proc.killed {
        format!(
            "exit: none (stopped by --timeout {} s: still running)",
            a.timeout
        )
    } else {
        match proc.code {
            Some(c) => format!("exit: {c}"),
            None => "exit: none (ended by a signal)".into(),
        }
    };
    let mut t = format!(
        "# scripts/capture-cmd {id}: real output, {chip}, macOS {macos}, commit {commit}, {date}.\n"
    );
    for n in &a.notes {
        t.push_str(&format!("# {}\n", n.replace('\n', " ")));
    }
    t.push_str(
        "# Regenerate with scripts/capture-cmd (course/STYLE.md appendix A); never edit by hand.\n",
    );
    t.push_str(&format!("$ {shown}\n{exit}\n--- stdout ---\n"));
    t.push_str(&proc.stdout);
    if !proc.stdout.is_empty() && !proc.stdout.ends_with('\n') {
        t.push('\n');
    }
    t.push_str("\n--- stderr ---\n");
    t.push_str(&proc.stderr);
    if !proc.stderr.is_empty() && !proc.stderr.ends_with('\n') {
        t.push('\n');
    }
    let t = sanitize(&t, &substs);
    // Privacy guard: no capture may carry the user's login name (for example inside an encoded
    // temporary path that no substitution covered). Refuse rather than publish it.
    if let Some(user) = std::env::var_os("HOME")
        .as_deref()
        .map(Path::new)
        .and_then(Path::file_name)
        .map(|u| u.to_string_lossy().into_owned())
        .filter(|u| u.len() >= 3)
        && t.contains(&user)
    {
        return Err(format!(
            "the output still contains your user name {user:?}; add --subst PATH=TOKEN for the path that carries it (nothing was written)"
        ));
    }
    std::fs::write(&path, &t).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(t)
}
