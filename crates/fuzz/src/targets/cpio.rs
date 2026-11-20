//! Target `cpio`: the newc archive *writer* (`xtask::cpio::Newc`; the "newc" format of
//! `cpio(5)` / Linux `Documentation/driver-api/early-userspace/buffer-format.rst`; threat model
//! SC-5) that builds the test initramfs overlay.
//!
//! **Why fuzz a writer.** What it writes is parsed by the guest kernel's initramfs unpacker, and
//! the names come from the command line (`--add SRC:DST`). A writer bug is a malformed archive
//! (a header field that overflows its 8 hex digits, a name that is not NUL-terminated, broken
//! 4-byte alignment) or an entry whose name escapes the root (`../`, absolute).
//!
//! **Input:** a sequence of entries `[kind, name length, name bytes, data length, data]`.
//!
//! **Invariants:** a name that `check_name` refuses is refused by the builder too; the finished
//! archive parses with an independent newc reader (magic, 13 hex fields, NUL-terminated name,
//! 4-byte alignment of header+name and of data) and ends with `TRAILER!!!`; every name in it
//! passes `check_name`; every accepted entry's name is in it.

use super::Input;
use crate::Target;
use crate::rng::Rng;
use xtask::cpio::{Newc, check_name};

pub const TARGET: Target = Target {
    name: "cpio",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 4096,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut i = Input::new(data);
    let mut a = Newc::new();
    let mut accepted = Vec::new();
    let mut n = 0;
    while !i.is_empty() && n < 32 {
        n += 1;
        let kind = i.u8() % 3;
        let nlen = usize::from(i.u8() % 64);
        let name = String::from_utf8_lossy(i.bytes(nlen)).into_owned();
        let dlen = usize::from(i.u8());
        let body = i.bytes(dlen).to_vec();
        let r = match kind {
            0 => a.file(&name, 0o644, &body),
            1 => a.dir(&name, 0o755),
            _ => a.symlink(&name, &String::from_utf8_lossy(&body)),
        };
        if check_name(&name).is_err() && r.is_ok() {
            return Err(format!("builder accepted refused name {name:?}"));
        }
        if r.is_ok() {
            accepted.push(name);
        }
    }
    let Ok(out) = a.finish() else {
        return Ok(());
    };
    let names = parse(&out)?;
    if names.last().map(String::as_str) != Some("TRAILER!!!") {
        return Err("archive does not end with TRAILER!!!".into());
    }
    for name in names.iter().take(names.len().saturating_sub(1)) {
        if check_name(name).is_err() {
            return Err(format!("archive holds refused name {name:?}"));
        }
    }
    for name in &accepted {
        if !names.contains(name) {
            return Err(format!(
                "accepted entry {name:?} is missing from the archive"
            ));
        }
    }
    Ok(())
}

/// A strict, independent newc reader: the names, in order.
fn parse(b: &[u8]) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
    let mut at = 0usize;
    while at < b.len() {
        let h = b.get(at..at + 110).ok_or("truncated header")?;
        if h.get(..6) != Some(b"070701") {
            return Err(format!("bad magic at {at}"));
        }
        let field = |k: usize| -> Result<usize, String> {
            let s = h.get(6 + 8 * k..14 + 8 * k).ok_or("field")?;
            let s = std::str::from_utf8(s).map_err(|_| "non-ASCII field")?;
            usize::from_str_radix(s, 16).map_err(|_| format!("bad hex field {s:?}"))
        };
        let filesize = field(6)?;
        let namesize = field(11)?;
        let name_end = at + 110 + namesize;
        let name = b.get(at + 110..name_end).ok_or("truncated name")?;
        let (last, name) = name.split_last().ok_or("empty name")?;
        if *last != 0 || name.contains(&0) {
            return Err("name not NUL-terminated exactly once".into());
        }
        let name = String::from_utf8(name.to_vec()).map_err(|_| "non-UTF-8 name")?;
        let data_at = name_end.next_multiple_of(4);
        let next = (data_at + filesize).next_multiple_of(4);
        if next > b.len() {
            return Err(format!("entry {name:?} runs past the end"));
        }
        let trailer = name == "TRAILER!!!";
        names.push(name);
        at = next;
        if trailer {
            if b.get(at..).is_some_and(|r| r.iter().any(|&c| c != 0)) {
                return Err("bytes after the trailer".into());
            }
            break;
        }
    }
    Ok(names)
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    const NAMES: &[&str] = &[
        "init",
        "etc/x",
        "a/b/c",
        "../e",
        "/abs",
        "a//b",
        "./x",
        "TRAILER!!!",
        "d",
    ];
    let mut b = Vec::new();
    for _ in 0..1 + rng.index(6) {
        let name = rng.pick(NAMES).unwrap_or("d");
        b.push(rng.byte());
        b.push(name.len() as u8);
        b.extend_from_slice(name.as_bytes());
        let n = rng.index(40);
        let body = rng.bytes(n);
        b.push(body.len() as u8);
        b.extend_from_slice(&body);
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(23);
        for _ in 0..2_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 4096);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
