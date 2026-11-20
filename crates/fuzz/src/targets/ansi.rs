//! Target `ansi`: the terminal-safety filter (`vmm::backend::ansi::AnsiFilter`, policy `safe`)
//! that every guest byte passes on its way to a TTY or file (threat model §7.5, TTY-1, TTY-3).
//!
//! **Why fuzz a filter.** Its job is to be a *total* state machine over hostile bytes: any
//! sequence it lets through can query or reprogram the user's terminal (OSC 52 clipboard writes,
//! DSR replies typed into the shell, DCS to tmux). The mutators bias input toward the bytes that
//! open sequences (ESC, `[`, `]`, `P`, `_`, the 8-bit CSI `0x9b`) and UTF-8 lead bytes, where the
//! state machine has its edges.
//!
//! **Invariants:**
//! 1. the output is accepted by an independent reference recognizer of the TTY-3 allow-list
//!    ([`strictly_allowed`], the same one as `crates/vmm/tests/ansi_filter.rs`);
//! 2. idempotence: `filter(filter(x)) == filter(x)` (allowed output passes unchanged);
//! 3. split invariance: pushing the input in two pieces gives the same bytes as one push;
//! 4. bounded output: at most 3 bytes per input byte (one U+FFFD) plus a constant.

use crate::Target;
use crate::rng::Rng;
use std::time::Instant;
use vmm::backend::ansi::{AnsiFilter, CSI_FINALS, FilterPolicy, PRIVATE_MODES};

pub const TARGET: Target = Target {
    name: "ansi",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 4096,
};

fn filt(input: &[u8], now: Instant) -> Vec<u8> {
    let mut out = Vec::new();
    AnsiFilter::new(FilterPolicy::Safe).push_at(input, &mut out, now);
    out
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let now = Instant::now();
    let out = filt(data, now);
    if !strictly_allowed(&out) {
        return Err(format!(
            "output outside the allow-list (TTY-3): {}",
            out.escape_ascii()
        ));
    }
    let again = filt(&out, now);
    if again != out {
        return Err(format!(
            "not idempotent: {} then {}",
            out.escape_ascii(),
            again.escape_ascii()
        ));
    }
    let cut = data.len() / 2;
    let (a, b) = data.split_at(cut);
    let mut f = AnsiFilter::new(FilterPolicy::Safe);
    let mut split = Vec::new();
    f.push_at(a, &mut split, now);
    f.push_at(b, &mut split, now);
    if split != out {
        return Err(format!(
            "split at {cut} differs: {} vs {}",
            split.escape_ascii(),
            out.escape_ascii()
        ));
    }
    if out.len() > data.len().saturating_mul(3).saturating_add(64) {
        return Err(format!(
            "{} output bytes for {} input bytes",
            out.len(),
            data.len()
        ));
    }
    Ok(())
}

/// Escape-heavy text: allowed CSIs, forbidden OSC/DCS/APC, raw C1, broken UTF-8.
fn seed(rng: &mut Rng) -> Vec<u8> {
    const PIECES: &[&[u8]] = &[
        b"hello ",
        b"\x1b[31m",
        b"\x1b[0m",
        b"\x1b[?25l",
        b"\x1b[?1049h",
        b"\x1b]52;c;bWFjdm1t\x07",
        b"\x1b]0;title\x1b\\",
        b"\x1bP$q\"p\x1b\\",
        b"\x1b_apc\x1b\\",
        b"\x1b[6n",
        b"\x1b[c",
        b"\x9b31m",
        b"\xc2\x9b",
        b"\xe2\x82",
        b"\x0e\x0f\x05",
        b"\r\n",
        b"\x1b[38;5;196m",
        b"\x1b(0",
    ];
    let mut b = Vec::new();
    for _ in 0..1 + rng.index(12) {
        b.extend_from_slice(rng.pick(PIECES).unwrap_or_default());
    }
    b
}

/// The reference recognizer (module docs): true if `out` contains only allowed text, controls
/// (BS, HT, LF, CR, BEL) and allow-listed escape sequences (TTY-3).
pub fn strictly_allowed(out: &[u8]) -> bool {
    let Ok(s) = std::str::from_utf8(out) else {
        return false;
    };
    if s.chars()
        .any(|c| c.is_control() && !"\x08\t\n\r\x07\x1b".contains(c))
    {
        return false;
    }
    let mut i = 0;
    while i < out.len() {
        if out.get(i) != Some(&0x1b) {
            i += 1;
            continue;
        }
        let rest = out.get(i + 1..).unwrap_or_default();
        let len = match rest {
            [b'7' | b'8' | b'M' | b'=' | b'>', ..] => 1,
            [b'(' | b')', b'B' | b'0', ..] => 2,
            [b'[', tail @ ..] => {
                let Some(end) = tail.iter().position(|c| (0x40..=0x7e).contains(c)) else {
                    return false;
                };
                let (body, fin) = (tail.get(..end).unwrap_or_default(), tail.get(end).copied());
                let Some(fin) = fin else { return false };
                let (private, body) = match body.split_first() {
                    Some((b'?', r)) => (true, r),
                    _ => (false, body),
                };
                let (params, sp) = match body.split_last() {
                    Some((b' ', p)) => (p, true),
                    _ => (body, false),
                };
                if !params
                    .iter()
                    .all(|c| c.is_ascii_digit() || *c == b';' || *c == b':')
                {
                    return false;
                }
                let ok = match (private, sp, fin) {
                    (false, true, b'q') => true,
                    (false, false, f) if CSI_FINALS.contains(&f) => true,
                    (true, false, b'h' | b'l') => params.split(|c| *c == b';').all(|m| {
                        std::str::from_utf8(m)
                            .ok()
                            .and_then(|m| m.parse::<u32>().ok())
                            .is_some_and(|m| PRIVATE_MODES.contains(&m))
                    }),
                    (false, false, b'h' | b'l') => params == b"4",
                    _ => false,
                };
                if !ok {
                    return false;
                }
                end + 2
            }
            _ => return false,
        };
        i += 1 + len;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(8);
        for _ in 0..5_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 4096);
            assert_eq!(run(&s), Ok(()));
        }
        assert!(!strictly_allowed(b"\x1b]0;x\x07"));
        assert!(strictly_allowed(b"\x1b[1;2m ok"));
    }
}
