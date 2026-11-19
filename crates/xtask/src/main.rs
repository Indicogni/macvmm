//! `cargo xtask <command>`: dispatch to the host tools in this crate.
//!
//! Commands:
//! - `check-anchors [--root DIR]`: ADR-0006 marker and lesson-reference check.
//! - `audit [--root DIR] [--deps]`: the architecture §4 security audit; `--deps` checks the
//!   dependency allowlist against manifests and `Cargo.lock` (SC-11).
//! - `derive [--] <kind> <input> <output> [arg]`: build a derived artifact for
//!   `scripts/fetch.sh`. A kind that is planned but not implemented yet exits [`EX_PENDING`]
//!   (64) and prints `pending M<n>` so `fetch.sh` reports `PENDING` instead of failing. Its
//!   arguments are never parsed as flags (they come from the fetch manifest).
//! - `unzboot IN OUT` (M9): unwrap an EFI zboot kernel into a raw arm64 Image ([`xtask::zboot`]).
//!   Also the `unzboot` derive kind.
//! - `mkinitramfs --base F --init F [--add SRC:DST]... --out F` (M9, [`xtask::cpio`]).
//! - `mkdisk --size S --seed N --out F` (M9, [`xtask::disk`]).
//! - `export-vectors [--check]`: copy the ESR test vectors (M4) and the FDT vectors (M7) to
//!   the course labs ([`xtask::vectors`]); `--check` only verifies the copies are current.
#![forbid(unsafe_code)]

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;
use xtask::{anchors, audit, cpio, disk, vectors, zboot};

/// `EX_USAGE` from `sysexits.h`, reused as "this derive kind is not implemented yet".
const EX_PENDING: u8 = 64;

// ANCHOR: xtask_derive_kinds
/// Derive kinds named in `scripts/fetch-manifest.txt`, with the milestone that implements each.
const DERIVE_KINDS: [(&str, &str); 3] = [
    ("unzboot", "M9"),       // vmlinuz-virt (EFI zboot) -> raw arm64 Image
    ("extract-apk", "M18"),  // u-boot-qemu .apk -> u-boot.bin
    ("write-sparse", "M19"), // FreeBSD .raw.xz -> sparse .raw
];
// ANCHOR_END: xtask_derive_kinds

const USAGE: &str = "usage: cargo xtask check-anchors [--root DIR] | audit [--root DIR] [--deps] | derive [--] <kind> <input> <output> [arg] | export-vectors [--root DIR] [--check] | unzboot IN OUT | mkinitramfs --base F --init F [--add SRC:DST]... --out F | mkdisk --size S --seed N --out F";

fn say(line: &str) {
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

fn warn(line: &str) {
    let _ = writeln!(std::io::stderr().lock(), "{line}");
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = args.split_first() else {
        warn(USAGE);
        return ExitCode::from(2);
    };
    // `derive` takes its arguments verbatim (an optional leading `--` is dropped): they come
    // from the fetch manifest, so a member path spelled `--deps` or `--root` must never be
    // reinterpreted as one of our flags. Only `check-anchors` and `audit` take flags.
    if cmd == "derive" {
        let rest = rest.strip_prefix(&["--".to_owned()]).unwrap_or(rest);
        return derive(rest);
    }
    match cmd.as_str() {
        "unzboot" => return unzboot(rest),
        "mkinitramfs" => return mkinitramfs(rest),
        "mkdisk" => return mkdisk(rest),
        _ => {}
    }
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut deps = false;
    let mut check = false;
    let mut it = rest.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" => match it.next() {
                Some(r) => root = PathBuf::from(r),
                None => {
                    warn("--root needs a value");
                    return ExitCode::from(2);
                }
            },
            "--deps" if cmd == "audit" => deps = true,
            "--check" if cmd == "export-vectors" => check = true,
            other => {
                warn(&format!(
                    "xtask {cmd}: unexpected argument {other:?}\n{USAGE}"
                ));
                return ExitCode::from(2);
            }
        }
    }
    match cmd.as_str() {
        "check-anchors" => check_anchors(&root),
        "audit" => run_audit(&root, deps),
        "export-vectors" => {
            // M4's ESR corpus, then M7's FDT corpus; the first failure wins.
            let esr = export_vectors(&root, check);
            let fdt = export_fdt_vectors(&root, check);
            if esr == ExitCode::SUCCESS { fdt } else { esr }
        }
        other => {
            warn(&format!("xtask: unknown command {other:?}\n{USAGE}"));
            ExitCode::from(2)
        }
    }
}

fn check_anchors(root: &std::path::Path) -> ExitCode {
    let report = match anchors::check_repo(root) {
        Ok(r) => r,
        Err(e) => {
            warn(&format!("check-anchors: {e}"));
            return ExitCode::from(1);
        }
    };
    for w in &report.warnings {
        warn(&format!("check-anchors: warning: {w}"));
    }
    for p in &report.problems {
        warn(&format!("check-anchors: error: {p}"));
    }
    if report.problems.is_empty() {
        say(&format!(
            "ANCHORS OK: {} anchors, {} lesson references, {} warnings",
            report.anchors,
            report.references,
            report.warnings.len()
        ));
        ExitCode::SUCCESS
    } else {
        warn(&format!(
            "check-anchors: {} error(s)",
            report.problems.len()
        ));
        ExitCode::from(1)
    }
}

fn run_audit(root: &std::path::Path, deps: bool) -> ExitCode {
    let result = if deps {
        audit::audit_deps(root)
    } else {
        audit::audit(root)
    };
    let report = match result {
        Ok(r) => r,
        Err(e) => {
            warn(&format!("audit: {e}"));
            return ExitCode::from(1);
        }
    };
    let total: usize = report
        .notes
        .iter()
        .filter_map(|n| {
            n.split(": ")
                .nth(1)?
                .split(' ')
                .next()?
                .parse::<usize>()
                .ok()
        })
        .sum();
    for n in &report.notes {
        say(&format!("audit: note: {n}"));
    }
    if total > 0 {
        say(&format!(
            "audit: note: {total} arithmetic_side_effects allow(s) in total (risk R20)"
        ));
    }
    for f in &report.findings {
        warn(&format!(
            "audit: FAIL {}:{}: [{}] {}",
            f.path, f.line, f.rule, f.message
        ));
    }
    let what = if deps { "AUDIT DEPS" } else { "AUDIT" };
    if report.findings.is_empty() {
        say(&format!("{what} OK: {} files", report.files_scanned));
        ExitCode::SUCCESS
    } else {
        warn(&format!(
            "{what} FAILED: {} finding(s)",
            report.findings.len()
        ));
        ExitCode::from(1)
    }
}

fn export_vectors(root: &std::path::Path, check: bool) -> ExitCode {
    match vectors::run(root, check) {
        Ok(Ok(vectors::Outcome::Written { vectors, path })) => {
            say(&format!(
                "VECTORS: wrote {vectors} vectors to {}",
                path.display()
            ));
            ExitCode::SUCCESS
        }
        Ok(Ok(vectors::Outcome::UpToDate { vectors })) => {
            say(&format!(
                "VECTORS OK: {vectors} vectors, {} is current",
                vectors::TARGET
            ));
            ExitCode::SUCCESS
        }
        Ok(Err(msg)) => {
            warn(&format!("export-vectors: {msg}"));
            ExitCode::from(1)
        }
        Err(e) => {
            warn(&format!("export-vectors: {e}"));
            ExitCode::from(1)
        }
    }
}

/// `export-vectors` for the FDT corpus (M7, [`vectors::run_fdt`]).
fn export_fdt_vectors(root: &std::path::Path, check: bool) -> ExitCode {
    match vectors::run_fdt(root, check) {
        Ok(Ok(vectors::Outcome::Written { vectors, path })) => {
            say(&format!(
                "VECTORS: wrote {vectors} FDT vectors to {}",
                path.display()
            ));
            ExitCode::SUCCESS
        }
        Ok(Ok(vectors::Outcome::UpToDate { vectors })) => {
            say(&format!(
                "VECTORS OK: {vectors} FDT vectors, {} is current",
                vectors::FDT_TARGET
            ));
            ExitCode::SUCCESS
        }
        Ok(Err(msg)) => {
            warn(&format!("export-vectors: {msg}"));
            ExitCode::from(1)
        }
        Err(e) => {
            warn(&format!("export-vectors: {e}"));
            ExitCode::from(1)
        }
    }
}

/// `unzboot IN OUT`.
fn unzboot(args: &[String]) -> ExitCode {
    let [input, output] = args else {
        warn("usage: cargo xtask unzboot IN OUT");
        return ExitCode::from(2);
    };
    match zboot::run(input.as_ref(), output.as_ref()) {
        Ok(p) => {
            say(&format!("unzboot: wrote {}", p.display()));
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("unzboot: {e}"));
            ExitCode::from(1)
        }
    }
}

/// Collect `--flag value` / `--flag=value` pairs; every flag must be in `known`.
fn flags(args: &[String], known: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (k, v) = match a.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_owned(), v.to_owned()),
            _ => {
                let v = it.next().ok_or(format!("{a} needs a value"))?;
                (a.clone(), v.clone())
            }
        };
        if !known.contains(&k.as_str()) {
            return Err(format!("unexpected argument {k:?}"));
        }
        out.push((k, v));
    }
    Ok(out)
}

fn one(f: &[(String, String)], key: &str) -> Result<String, String> {
    let mut v = f.iter().filter(|(k, _)| k == key).map(|(_, v)| v.clone());
    match (v.next(), v.next()) {
        (Some(x), None) => Ok(x),
        (None, _) => Err(format!("{key} is required")),
        _ => Err(format!("{key} given twice")),
    }
}

/// `mkinitramfs --base F --init F [--add SRC:DST]... --out F`.
fn mkinitramfs(args: &[String]) -> ExitCode {
    let run = || -> Result<String, String> {
        let f = flags(args, &["--base", "--init", "--add", "--out"])?;
        let (base, init, out) = (one(&f, "--base")?, one(&f, "--init")?, one(&f, "--out")?);
        let adds = f
            .iter()
            .filter(|(k, _)| k == "--add")
            .map(|(_, v)| cpio::parse_add(v).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        let n = cpio::run(base.as_ref(), init.as_ref(), &adds, out.as_ref())
            .map_err(|e| e.to_string())?;
        Ok(format!("mkinitramfs: wrote {out} ({n} bytes)"))
    };
    match run() {
        Ok(m) => {
            say(&m);
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("mkinitramfs: {e}"));
            ExitCode::from(1)
        }
    }
}

/// Parse a size with an optional K/M/G suffix (binary), checked.
fn parse_size(s: &str) -> Result<u64, String> {
    let (digits, shift) = match s.char_indices().last() {
        Some((i, 'K' | 'k')) => (&s[..i], 10),
        Some((i, 'M' | 'm')) => (&s[..i], 20),
        Some((i, 'G' | 'g')) => (&s[..i], 30),
        _ => (s, 0),
    };
    digits
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(1u64 << shift))
        .ok_or(format!("invalid size {s:?}"))
}

/// `mkdisk --size S --seed N --out F`.
fn mkdisk(args: &[String]) -> ExitCode {
    let run = || -> Result<String, String> {
        let f = flags(args, &["--size", "--seed", "--out"])?;
        let size = parse_size(&one(&f, "--size")?)?;
        let seed: u64 = one(&f, "--seed")?
            .parse()
            .map_err(|_| "--seed must be a number".to_owned())?;
        let out = one(&f, "--out")?;
        disk::run(size, seed, out.as_ref())?;
        Ok(format!("mkdisk: wrote {out} ({size} bytes, seed {seed})"))
    };
    match run() {
        Ok(m) => {
            say(&m);
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("mkdisk: {e}"));
            ExitCode::from(1)
        }
    }
}

/// `derive <kind> <input> <output> [args]`. M9 implements `unzboot`; the others report
/// pending with their milestone.
fn derive(args: &[String]) -> ExitCode {
    let Some(kind) = args.first() else {
        warn("usage: cargo xtask derive <kind> <input> <output> [args...]");
        return ExitCode::from(2);
    };
    if kind == "unzboot" {
        return match args.get(1..) {
            Some([input, output]) => unzboot(&[input.clone(), output.clone()]),
            _ => {
                warn("usage: cargo xtask derive unzboot <input> <output>");
                ExitCode::from(2)
            }
        };
    }
    match DERIVE_KINDS.iter().find(|(k, _)| k == kind) {
        Some((_, milestone)) => {
            say(&format!("pending {milestone}"));
            warn(&format!(
                "xtask derive: {kind} is not implemented yet ({milestone})"
            ));
        }
        None => {
            say("pending M?");
            warn(&format!("xtask derive: unknown kind {kind:?}"));
        }
    }
    ExitCode::from(EX_PENDING)
}
