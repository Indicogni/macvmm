//! `cargo xtask <command>`: dispatch to the host tools in this crate.
//!
//! Commands:
//! - `check-anchors [--root DIR]`: ADR-0006 marker and lesson-reference check.
//! - `audit [--root DIR] [--deps]`: the architecture §4 security audit; `--deps` checks the
//!   dependency allowlist against manifests and `Cargo.lock` (SC-11).
//! - `derive [--] <kind> <input> <output> [arg]`: build a derived artifact for
//!   `scripts/fetch.sh`. A kind that is planned but not implemented yet exits [`EX_PENDING`]
//!   (64) and prints `pending M<n>` so `fetch.sh` reports `PENDING` instead of failing. Its
//!   arguments are never parsed as flags (they come from the fetch manifest). M18 implements
//!   `extract-apk <apk> <out> <member>` ([`xtask::apk`]).
//!   M19 implements `write-sparse <in.xz> <out>` ([`xtask::sparse`]): `xz -dc` into a sparse file.
//! - `write-sparse OUT` (M19): standard input to a sparse file, capped ([`xtask::sparse`]).
//! - `unzboot IN OUT` (M9): unwrap an EFI zboot kernel into a raw arm64 Image ([`xtask::zboot`]).
//!   Also the `unzboot` derive kind.
//! - `mkinitramfs --base F --init F [--add SRC:DST]... --out F` (M9, [`xtask::cpio`]).
//! - `mkdisk --size S --seed N --out F` (M9, [`xtask::disk`]).
//! - `mkrootfs --out F --size S [--minirootfs F] [--init F] [--manifest F]` (M15,
//!   [`xtask::rootfs`]): the ext4 root image; exits 69 (`EX_UNAVAILABLE`) when `mkfs.ext4` is
//!   missing.
//! - `checkpoint <NN|all> [--ref | --impl DIR] [--keep] [--capture]` (M27): the course's
//!   checkpoint harness ([`xtask::checkpoint`]); `scripts/checkpoint.sh` and
//!   `scripts/capture.sh` wrap it.
//! - `learner <init|start|hint|lifeline|status|gen-scaffold> …` (M27, [`xtask::learner`]);
//!   `scripts/learner` wraps it.
//! - `bughunt <part> [--patch NAME] [--keep]` (M27, [`xtask::checkpoint::bughunt`]);
//!   `scripts/bughunt.sh` wraps it.
//! - `lessons [FILE|NN]...`: the course lesson lint ([`xtask::lessons`]); `scripts/check-lessons`
//!   wraps it. With no argument it checks every lesson under `course/chapters/`.
//! - `capture [opts] OUT -- CMD...`: record a real run as a course capture ([`xtask::capture`]);
//!   `scripts/capture-cmd` wraps it.
//! - `export-vectors [--check]`: copy the ESR test vectors (M4), the FDT vectors (M7) and the
//!   virtqueue vectors (M11) to the course labs ([`xtask::vectors`]); `--check` only verifies
//!   the copies are current.
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

const USAGE: &str = "usage: cargo xtask lessons [FILE|NN]... | capture [opts] OUT -- CMD... | checkpoint <NN|all> [--ref | --impl DIR] [--keep] [--capture] | learner <init|start|hint|lifeline|status|gen-scaffold> ... | bughunt <part> | check-anchors [--root DIR] | audit [--root DIR] [--deps] | derive [--] <kind> <input> <output> [arg] | export-vectors [--root DIR] [--check] | unzboot IN OUT | mkinitramfs --base F --init F [--add SRC:DST]... --out F | mkdisk --size S --seed N --out F | mkrootfs --out F --size S [--minirootfs F] [--init F] [--manifest F] | write-sparse OUT";

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
    // M27: the course harness parses its own arguments.
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    match cmd.as_str() {
        "checkpoint" => return ExitCode::from(xtask::checkpoint::main(&repo_root, rest)),
        "learner" => return ExitCode::from(xtask::learner::main(&repo_root, rest)),
        "bughunt" => return ExitCode::from(xtask::checkpoint::bughunt::main(&repo_root, rest)),
        "lessons" => return lessons(&repo_root, rest),
        "capture" => return capture(&repo_root, rest),
        _ => {}
    }
    match cmd.as_str() {
        "unzboot" => return unzboot(rest),
        "mkinitramfs" => return mkinitramfs(rest),
        "mkdisk" => return mkdisk(rest),
        "mkrootfs" => return mkrootfs(rest),         // M15
        "write-sparse" => return write_sparse(rest), // M19
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
            // M4's ESR corpus, M7's FDT corpus, then M11's virtqueue corpus; the first
            // failure wins.
            let esr = export_vectors(&root, check);
            let fdt = export_fdt_vectors(&root, check);
            let vq = export_virtqueue_vectors(&root, check);
            [esr, fdt, vq]
                .into_iter()
                .find(|c| *c != ExitCode::SUCCESS)
                .unwrap_or(ExitCode::SUCCESS)
        }
        other => {
            warn(&format!("xtask: unknown command {other:?}\n{USAGE}"));
            ExitCode::from(2)
        }
    }
}

fn lessons(root: &std::path::Path, args: &[String]) -> ExitCode {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        say("usage: scripts/check-lessons [FILE|NN]...   (no argument: every lesson)");
        return ExitCode::SUCCESS;
    }
    let report = match xtask::lessons::run(root, args) {
        Ok(r) => r,
        Err(e) => {
            warn(&format!("check-lessons: {e}"));
            return ExitCode::from(2);
        }
    };
    for d in &report.diags {
        warn(&format!("check-lessons: {d}"));
    }
    let (e, w) = (report.errors(), report.warnings());
    if e == 0 {
        say(&format!(
            "LESSONS OK: {} lesson(s), {w} warning(s)",
            report.lessons
        ));
        ExitCode::SUCCESS
    } else {
        warn(&format!(
            "check-lessons: {e} error(s), {w} warning(s) in {} lesson(s)",
            report.lessons
        ));
        ExitCode::from(1)
    }
}

fn capture(root: &std::path::Path, args: &[String]) -> ExitCode {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        say(xtask::capture::USAGE);
        return ExitCode::SUCCESS;
    }
    match xtask::capture::main(root, args) {
        Ok(t) => {
            let _ = write!(std::io::stdout().lock(), "{t}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("capture-cmd: {e}"));
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

/// `export-vectors` for the virtqueue corpus (M11, [`vectors::run_virtqueue`]).
fn export_virtqueue_vectors(root: &std::path::Path, check: bool) -> ExitCode {
    match vectors::run_virtqueue(root, check) {
        Ok(Ok(vectors::Outcome::Written { vectors, path })) => {
            say(&format!(
                "VECTORS: wrote {vectors} virtqueue vectors to {}",
                path.display()
            ));
            ExitCode::SUCCESS
        }
        Ok(Ok(vectors::Outcome::UpToDate { vectors })) => {
            say(&format!(
                "VECTORS OK: {vectors} virtqueue vectors, {} is current",
                vectors::VQ_TARGET
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

/// `mkrootfs --out F --size S [--minirootfs F] [--init F] [--manifest F]` (M15).
fn mkrootfs(args: &[String]) -> ExitCode {
    use xtask::rootfs;
    let parsed = || -> Result<rootfs::Args, String> {
        let f = flags(
            args,
            &["--out", "--size", "--minirootfs", "--init", "--manifest"],
        )?;
        let opt = |key: &str| -> Result<Option<String>, String> {
            match one(&f, key) {
                Ok(v) => Ok(Some(v)),
                Err(_) if f.iter().all(|(k, _)| k != key) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        // `${MACVMM_CACHE:-<repo>/.cache/macvmm}`, relative to the repo root (SC-3, S14).
        let cache = match std::env::var_os("MACVMM_CACHE") {
            Some(c) if std::path::Path::new(&c).is_absolute() => PathBuf::from(c),
            Some(c) => repo.join(c),
            None => repo.join(".cache/macvmm"),
        };
        Ok(rootfs::Args {
            out: PathBuf::from(one(&f, "--out")?),
            size: parse_size(&one(&f, "--size")?)?,
            minirootfs: opt("--minirootfs")?
                .map_or_else(|| cache.join(rootfs::MINIROOTFS), PathBuf::from),
            init: opt("--init")?
                .map_or_else(|| repo.join("scripts/rootfs/macvmm-init"), PathBuf::from),
            manifest: opt("--manifest")?
                .map_or_else(|| repo.join("scripts/fetch-manifest.txt"), PathBuf::from),
        })
    };
    let a = match parsed() {
        Ok(a) => a,
        Err(e) => {
            warn(&format!("mkrootfs: {e}\n{USAGE}"));
            return ExitCode::from(2);
        }
    };
    match rootfs::run(&a) {
        Ok(m) => {
            say(&m);
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("mkrootfs: {e}"));
            ExitCode::from(if e.tool_missing {
                rootfs::EX_UNAVAILABLE
            } else {
                1
            })
        }
    }
}

/// `cargo xtask write-sparse OUT` (M19): standard input to a sparse `OUT`, capped (SC-6).
fn write_sparse(args: &[String]) -> ExitCode {
    let [output] = args else {
        warn("usage: cargo xtask write-sparse OUT   (reads standard input)");
        return ExitCode::from(2);
    };
    match xtask::sparse::run_stdin(output.as_ref()) {
        Ok(s) => {
            say(&format!(
                "write-sparse: wrote {output} ({} bytes, {} of them data)",
                s.len, s.written
            ));
            ExitCode::SUCCESS
        }
        Err(e) => {
            warn(&format!("write-sparse: {e}"));
            ExitCode::from(1)
        }
    }
}

/// `derive <kind> <input> <output> [args]`: the build steps `scripts/fetch.sh` runs on a
/// verified download. Implemented: `unzboot` (M9), `extract-apk` (M18) and `write-sparse`
/// (M19); any other kind in `DERIVE_KINDS` reports pending with its milestone.
fn derive(args: &[String]) -> ExitCode {
    let Some(kind) = args.first() else {
        warn("usage: cargo xtask derive <kind> <input> <output> [args...]");
        return ExitCode::from(2);
    };
    // M18: `extract-apk <apk> <out> <member>` (the member path comes from the manifest).
    if kind == "extract-apk" {
        return match args.get(1..) {
            Some([input, output, member]) => {
                match xtask::apk::run(input.as_ref(), output.as_ref(), member) {
                    Ok(p) => {
                        say(&format!("extract-apk: wrote {}", p.display()));
                        ExitCode::SUCCESS
                    }
                    Err(e) => {
                        warn(&format!("extract-apk: {e}"));
                        ExitCode::from(1)
                    }
                }
            }
            _ => {
                warn("usage: cargo xtask derive extract-apk <apk> <output> <member>");
                ExitCode::from(2)
            }
        };
    }
    // M19: `write-sparse <in.xz> <out>`: `xz -dc` into a sparse file, capped (SC-6).
    if kind == "write-sparse" {
        return match args.get(1..) {
            Some([input, output]) => match xtask::sparse::run_xz(input.as_ref(), output.as_ref()) {
                Ok(s) => {
                    say(&format!(
                        "write-sparse: wrote {output} ({} bytes, {} of them data)",
                        s.len, s.written
                    ));
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    warn(&format!("write-sparse: {e}"));
                    ExitCode::from(1)
                }
            },
            _ => {
                warn("usage: cargo xtask derive write-sparse <input.xz> <output>");
                ExitCode::from(2)
            }
        };
    }
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
