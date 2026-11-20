//! `cargo xtask export-vectors [--check]`: publish the ESR test vectors to the course site
//! (PLAN M4; course ch07, the `esr-decoder` lab).
//!
//! **One corpus, two readers.** `crates/vmm/tests/data/esr_vectors.json` is the source of
//! truth: `crates/vmm/tests/esr_vectors.rs` checks every vector against `Exit::from_hv`, and the
//! browser lab shows the same values, so the lab can never teach a decode the VMM does not do.
//! This command copies the file byte for byte to `course/site/labs/vectors/esr.json` after a
//! structural check; `--check` only verifies that the published copy is current (for CI).
//!
//! The check is deliberately shallow (the decode itself is the Rust test's job): the file must
//! be at most [`MAX_VECTORS_BYTES`], contain at least [`MIN_VECTORS`] vectors (counted by their
//! `"exit"` key), every `"esr": "0x…"` value must be 1–16 lowercase hex digits, and braces and
//! brackets must balance outside strings.
//!
//! **M7 adds the FDT corpus** ([`run_fdt`]): `crates/vmm/tests/data/fdt_vectors.json`, which
//! `crates/vmm/tests/fdt_machine.rs` regenerates from the real `fdt::writer` and `fdt::reader`
//! and checks is current, is copied to `course/site/labs/vectors/fdt.json` for the ch10 DTB lab.
//! Its check: at most [`MAX_VECTORS_BYTES`], balanced, at least [`MIN_FDT_VECTORS`] vectors
//! (counted by their `"dtb"` key), and every `"dtb"` value an even-length lowercase hex string
//! of at most 2 MiB of bytes whose first word is the FDT magic, except that hostile vectors
//! (those with a non-null `"error"`) may start with anything.
//!
//! **M11 adds the virtqueue corpus** ([`run_virtqueue`]):
//! `crates/vmm/tests/data/virtqueue_vectors.json`, which `crates/vmm/tests/virtqueue_hostile.rs`
//! regenerates from its hostile ring cases and the real `virtio::{queue,chain}` code, is copied
//! to `course/site/labs/vectors/virtqueue.json` for the ch16 virtqueue lab. Its check: at most
//! [`MAX_VECTORS_BYTES`], balanced, at least [`MIN_VIRTQUEUE_VECTORS`] vectors (counted by their
//! `"outcome"` key), every `"addr"`/ring value `0x` + 1–16 lowercase hex digits, and every
//! outcome either a chain summary, `empty` or an `error`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The corpus, relative to the repository root.
pub const SOURCE: &str = "crates/vmm/tests/data/esr_vectors.json";
/// The published copy, relative to the repository root.
pub const TARGET: &str = "course/site/labs/vectors/esr.json";
/// PLAN M4: at least 40 vectors.
pub const MIN_VECTORS: usize = 40;
/// A sanity cap on the corpus size (it is read whole).
pub const MAX_VECTORS_BYTES: u64 = 1 << 20;

/// Validate the corpus text; returns the number of vectors.
pub fn validate(text: &str) -> Result<usize, String> {
    let (mut depth, mut in_str, mut esc) = (0i64, false, false);
    for c in text.chars() {
        if in_str {
            match (esc, c) {
                (true, _) => esc = false,
                (false, '\\') => esc = true,
                (false, '"') => in_str = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth < 0 {
                    return Err("unbalanced closing bracket".into());
                }
            }
            _ => {}
        }
    }
    if depth != 0 || in_str {
        return Err("unbalanced brackets or an unterminated string".into());
    }
    for part in text.split("\"esr\": \"").skip(1) {
        let value = part.split('"').next().unwrap_or("");
        let digits = value
            .strip_prefix("0x")
            .ok_or(format!("esr {value:?} lacks 0x"))?;
        if digits.is_empty()
            || digits.len() > 16
            || !digits
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        {
            return Err(format!("esr {value:?} is not 1-16 lowercase hex digits"));
        }
    }
    let n = text.matches("\"exit\": \"").count();
    if n < MIN_VECTORS {
        return Err(format!("{n} vectors, need at least {MIN_VECTORS}"));
    }
    Ok(n)
}

/// What `run` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Written { vectors: usize, path: PathBuf },
    UpToDate { vectors: usize },
}

/// Export (or with `check`, verify) the vectors under `root`.
pub fn run(root: &Path, check: bool) -> io::Result<Result<Outcome, String>> {
    let src = root.join(SOURCE);
    if fs::metadata(&src)?.len() > MAX_VECTORS_BYTES {
        return Ok(Err(format!("{SOURCE} exceeds {MAX_VECTORS_BYTES} bytes")));
    }
    let text = fs::read_to_string(&src)?;
    let vectors = match validate(&text) {
        Ok(n) => n,
        Err(e) => return Ok(Err(format!("{SOURCE}: {e}"))),
    };
    let dst = root.join(TARGET);
    let current = fs::read_to_string(&dst).ok();
    if current.as_deref() == Some(text.as_str()) {
        return Ok(Ok(Outcome::UpToDate { vectors }));
    }
    if check {
        return Ok(Err(format!(
            "{TARGET} is out of date: run `cargo xtask export-vectors`"
        )));
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&dst, &text)?;
    Ok(Ok(Outcome::Written { vectors, path: dst }))
}

/// The FDT corpus (M7), relative to the repository root.
pub const FDT_SOURCE: &str = "crates/vmm/tests/data/fdt_vectors.json";
/// Its published copy.
pub const FDT_TARGET: &str = "course/site/labs/vectors/fdt.json";
/// PLAN M7: the writer cases, the two machine trees and the hostile cases.
pub const MIN_FDT_VECTORS: usize = 6;
/// A DTB is at most 2 MiB (booting.rst §2), so its hex is at most 4 Mi characters.
const MAX_DTB_HEX: usize = 4 << 20;

/// Brackets and braces balance outside strings, and no string is left open.
fn balanced(text: &str) -> bool {
    let (mut depth, mut in_str, mut esc) = (0i64, false, false);
    for c in text.chars() {
        if in_str {
            match (esc, c) {
                (true, _) => esc = false,
                (false, '\\') => esc = true,
                (false, '"') => in_str = false,
                _ => {}
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' | '[' => depth += 1,
            '}' | ']' => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    depth == 0 && !in_str
}

// ANCHOR: vectors_fdt
/// Validate the FDT corpus text (module docs); returns the number of vectors.
pub fn validate_fdt(text: &str) -> Result<usize, String> {
    if !balanced(text) {
        return Err("unbalanced brackets or an unterminated string".into());
    }
    let mut n = 0usize;
    for part in text.split("\"dtb\": \"").skip(1) {
        n += 1;
        let value = part.split('"').next().unwrap_or("");
        if value.is_empty()
            || value.len() % 2 != 0
            || value.len() > MAX_DTB_HEX
            || !value
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        {
            return Err(format!("vector {n}: dtb is not even-length lowercase hex"));
        }
        let hostile = part
            .split("\"error\": ")
            .nth(1)
            .is_some_and(|e| !e.starts_with("null"));
        if !hostile && !value.starts_with("d00dfeed") {
            return Err(format!("vector {n}: a valid dtb must start with d00dfeed"));
        }
    }
    if n < MIN_FDT_VECTORS {
        return Err(format!("{n} FDT vectors, need at least {MIN_FDT_VECTORS}"));
    }
    Ok(n)
}
// ANCHOR_END: vectors_fdt

/// Export (or with `check`, verify) the FDT corpus under `root` (M7).
pub fn run_fdt(root: &Path, check: bool) -> io::Result<Result<Outcome, String>> {
    let src = root.join(FDT_SOURCE);
    if fs::metadata(&src)?.len() > MAX_VECTORS_BYTES {
        return Ok(Err(format!(
            "{FDT_SOURCE} exceeds {MAX_VECTORS_BYTES} bytes"
        )));
    }
    let text = fs::read_to_string(&src)?;
    let vectors = match validate_fdt(&text) {
        Ok(n) => n,
        Err(e) => return Ok(Err(format!("{FDT_SOURCE}: {e}"))),
    };
    let dst = root.join(FDT_TARGET);
    if fs::read_to_string(&dst).ok().as_deref() == Some(text.as_str()) {
        return Ok(Ok(Outcome::UpToDate { vectors }));
    }
    if check {
        return Ok(Err(format!(
            "{FDT_TARGET} is out of date: run `cargo xtask export-vectors`"
        )));
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&dst, &text)?;
    Ok(Ok(Outcome::Written { vectors, path: dst }))
}

/// The virtqueue corpus (M11), relative to the repository root.
pub const VQ_SOURCE: &str = "crates/vmm/tests/data/virtqueue_vectors.json";
/// Its published copy.
pub const VQ_TARGET: &str = "course/site/labs/vectors/virtqueue.json";
/// PLAN M11: the hostile corpus has at least 40 cases.
pub const MIN_VIRTQUEUE_VECTORS: usize = 40;

/// `0x` + 1–16 lowercase hex digits.
fn is_hex_u64(v: &str) -> bool {
    v.strip_prefix("0x").is_some_and(|d| {
        !d.is_empty()
            && d.len() <= 16
            && d.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    })
}

// ANCHOR: vectors_virtqueue
/// Validate the virtqueue corpus text (module docs); returns the number of vectors.
pub fn validate_virtqueue(text: &str) -> Result<usize, String> {
    if !balanced(text) {
        return Err("unbalanced brackets or an unterminated string".into());
    }
    for key in [
        "\"addr\": \"",
        "\"desc_table\": \"",
        "\"avail_ring\": \"",
        "\"used_ring\": \"",
    ] {
        for part in text.split(key).skip(1) {
            let value = part.split('"').next().unwrap_or("");
            if !is_hex_u64(value) {
                return Err(format!(
                    "{key}{value:?} is not 0x + 1-16 lowercase hex digits"
                ));
            }
        }
    }
    let mut n = 0usize;
    for part in text.split("\"outcome\": ").skip(1) {
        n += 1;
        if !["{\"readable\": ", "{\"empty\": true}", "{\"error\": \""]
            .iter()
            .any(|p| part.starts_with(p))
        {
            return Err(format!("vector {n}: unknown outcome"));
        }
    }
    if n < MIN_VIRTQUEUE_VECTORS {
        return Err(format!(
            "{n} virtqueue vectors, need at least {MIN_VIRTQUEUE_VECTORS}"
        ));
    }
    Ok(n)
}
// ANCHOR_END: vectors_virtqueue

/// Export (or with `check`, verify) the virtqueue corpus under `root` (M11).
pub fn run_virtqueue(root: &Path, check: bool) -> io::Result<Result<Outcome, String>> {
    let src = root.join(VQ_SOURCE);
    if fs::metadata(&src)?.len() > MAX_VECTORS_BYTES {
        return Ok(Err(format!(
            "{VQ_SOURCE} exceeds {MAX_VECTORS_BYTES} bytes"
        )));
    }
    let text = fs::read_to_string(&src)?;
    let vectors = match validate_virtqueue(&text) {
        Ok(n) => n,
        Err(e) => return Ok(Err(format!("{VQ_SOURCE}: {e}"))),
    };
    let dst = root.join(VQ_TARGET);
    if fs::read_to_string(&dst).ok().as_deref() == Some(text.as_str()) {
        return Ok(Ok(Outcome::UpToDate { vectors }));
    }
    if check {
        return Ok(Err(format!(
            "{VQ_TARGET} is out of date: run `cargo xtask export-vectors`"
        )));
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&dst, &text)?;
    Ok(Ok(Outcome::Written { vectors, path: dst }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M11: the virtqueue corpus rules, and the repository's copy is valid and published.
    #[test]
    fn virtqueue_corpus() {
        let v = |addr: &str, out: &str| format!("{{\"addr\": \"{addr}\", \"outcome\": {out}}}");
        let corpus = |items: Vec<String>| format!("{{\"vectors\": [{}]}}", items.join(","));
        let good: Vec<String> = (0..40)
            .map(|i| {
                v(
                    "0x40000000",
                    [
                        "{\"empty\": true}",
                        "{\"error\": \"x\"}",
                        "{\"readable\": 1}",
                    ][i % 3],
                )
            })
            .collect();
        assert_eq!(validate_virtqueue(&corpus(good.clone())), Ok(40));
        assert!(validate_virtqueue(&corpus(good[..39].to_vec())).is_err());
        for bad in [
            v("40000000", "{\"empty\": true}"),
            v("0xABC", "{\"empty\": true}"),
            v("0x1", "{\"maybe\": 1}"),
        ] {
            let mut items = good.clone();
            items.push(bad.clone());
            assert!(validate_virtqueue(&corpus(items)).is_err(), "{bad}");
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let text = fs::read_to_string(root.join(VQ_SOURCE)).unwrap();
        assert!(validate_virtqueue(&text).unwrap() >= MIN_VIRTQUEUE_VECTORS);
        assert!(matches!(
            run_virtqueue(&root, true).unwrap(),
            Ok(Outcome::UpToDate { .. })
        ));
    }

    /// M7: the FDT corpus rules, and the repository's copy is valid and published.
    #[test]
    fn fdt_corpus() {
        let v = |dtb: &str, err: &str| format!("{{\"dtb\": \"{dtb}\", \"error\": {err}}}");
        let corpus = |items: Vec<String>| format!("{{\"vectors\": [{}]}}", items.join(","));
        let good: Vec<String> = (0..6).map(|_| v("d00dfeed00", "null")).collect();
        assert_eq!(validate_fdt(&corpus(good.clone())), Ok(6));
        assert!(validate_fdt(&corpus(good[..5].to_vec())).is_err());
        for bad in ["d00dfeed0", "D00DFEED", "", "d00dfeedzz", "deadbeef"] {
            let mut items = good.clone();
            items.push(v(bad, "null"));
            assert!(validate_fdt(&corpus(items)).is_err(), "{bad}");
        }
        let mut items = good.clone();
        items.push(v("deadbeef", "\"BadMagic\""));
        assert_eq!(validate_fdt(&corpus(items)), Ok(7));
        assert!(validate_fdt("{\"dtb\": \"").is_err());
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let text = fs::read_to_string(root.join(FDT_SOURCE)).unwrap();
        assert!(validate_fdt(&text).unwrap() >= MIN_FDT_VECTORS);
        assert!(matches!(
            run_fdt(&root, true).unwrap(),
            Ok(Outcome::UpToDate { .. })
        ));
    }

    fn corpus(n: usize, esr: &str) -> String {
        let v: Vec<String> = (0..n)
            .map(|_| format!("{{\"esr\": \"{esr}\", \"exit\": \"Hvc\"}}"))
            .collect();
        format!("{{\"vectors\": [{}]}}", v.join(","))
    }

    #[test]
    fn validation() {
        assert_eq!(validate(&corpus(40, "0x93810046")), Ok(40));
        assert!(validate(&corpus(39, "0x1")).is_err());
        for bad in [
            "93810046",
            "0x",
            "0xG",
            "0X1",
            "0x11111111111111111",
            "0xABC",
        ] {
            assert!(validate(&corpus(40, bad)).is_err(), "{bad}");
        }
        assert!(validate(&(corpus(40, "0x1") + "]")).is_err());
        assert!(validate("{\"a\": \"}").is_err());
        // Brackets inside strings do not count.
        let s = corpus(40, "0x1").replacen("{\"esr\"", "{\"n\": \"[{\\\"\", \"esr\"", 1);
        assert_eq!(validate(&s), Ok(40));
    }

    /// The repository's own corpus is valid, and the published copy is current.
    #[test]
    fn repository_corpus_is_published() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let text = fs::read_to_string(root.join(SOURCE)).unwrap();
        assert!(validate(&text).unwrap() >= MIN_VECTORS);
        assert!(matches!(
            run(&root, true).unwrap(),
            Ok(Outcome::UpToDate { .. })
        ));
    }
}
