//! `AnsiFilter` (PLAN M3 security test, the first ≥ 20 cases for `safe`; PLAN M6 grows it to
//! ≥ 40 with the `strict` and `raw` policies; threat model TTY-1..TTY-5).
//!
//! Forbidden classes must produce **no ESC** in the output; allowed sequences pass byte-exact.
//! Properties (xorshift64*, fixed seed printed on failure, `MACVMM_SEED=<n>` replays):
//! idempotence `filter(filter(x)) == filter(x)`, byte-by-byte pushes equal one push, and every
//! output parses under an independent strict recognizer of the allow-list.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};
use vmm::backend::ansi::{AnsiFilter, CSI_FINALS, FilterPolicy, PRIVATE_MODES};

fn filt_at(input: &[u8], now: Instant) -> Vec<u8> {
    let mut out = Vec::new();
    AnsiFilter::new(FilterPolicy::Safe).push_at(input, &mut out, now);
    out
}

fn filt(input: &[u8]) -> Vec<u8> {
    filt_at(input, Instant::now())
}

fn no_esc(input: &[u8]) {
    let out = filt(input);
    assert!(!out.contains(&0x1b), "{input:?} leaked ESC: {out:?}");
    assert!(
        !out.iter()
            .any(|b| (0x80..=0x9f).contains(b) && !is_utf8_continuation_ok(&out)),
        "{out:?}"
    );
}

fn is_utf8_continuation_ok(out: &[u8]) -> bool {
    std::str::from_utf8(out).is_ok_and(|s| !s.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c)))
}

#[test]
fn allowed_csi_pass_byte_exact() {
    for &f in CSI_FINALS {
        for params in ["", "1", "1;2", "38;5;196", "38:2:0:255:0", "12345"] {
            let s = [b"\x1b[".as_slice(), params.as_bytes(), &[f]].concat();
            assert_eq!(filt(&s), s, "{:?}", String::from_utf8_lossy(&s));
        }
    }
    for m in PRIVATE_MODES {
        for hl in ["h", "l"] {
            let s = format!("\x1b[?{m}{hl}");
            assert_eq!(filt(s.as_bytes()), s.as_bytes());
        }
    }
    for s in ["\x1b[4h", "\x1b[4l", "\x1b[2 q", "\x1b[ q", "\x1b[?1;25h"] {
        assert_eq!(filt(s.as_bytes()), s.as_bytes(), "{s:?}");
    }
}

#[test]
fn allowed_two_byte_escapes() {
    for s in [
        "\x1b7", "\x1b8", "\x1bM", "\x1b=", "\x1b>", "\x1b(B", "\x1b(0", "\x1b)B", "\x1b)0",
    ] {
        assert_eq!(filt(s.as_bytes()), s.as_bytes(), "{s:?}");
    }
}

#[test]
fn text_and_c0() {
    assert_eq!(filt(b"a\tb\x08c\r\n"), b"a\tb\x08c\r\n");
    assert_eq!(filt("héllo ✓ 𝄞".as_bytes()), "héllo ✓ 𝄞".as_bytes());
    assert_eq!(filt(b"a\x00b\x05c\x0ed\x0fe\x0bf\x0cg\x7fh"), b"abcdefgh"); // NUL ENQ SO SI VT FF DEL
}

#[test]
fn device_attributes_dropped() {
    for s in ["\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[>0c", "\x1b[=c"] {
        no_esc(s.as_bytes());
    }
}

#[test]
fn device_status_reports_dropped() {
    for s in ["\x1b[6n", "\x1b[5n", "\x1b[?6n", "\x1b[?15n"] {
        no_esc(s.as_bytes());
    }
}

#[test]
fn window_ops_dropped() {
    for s in ["\x1b[21t", "\x1b[8;1;1t", "\x1b[14t", "\x1b[22;0t"] {
        no_esc(s.as_bytes());
    }
}

#[test]
fn media_copy_decrqm_and_mouse_modes_dropped() {
    for s in [
        "\x1b[i",
        "\x1b[5i",
        "\x1b[?1$p",
        "\x1b[4$p",
        "\x1b[!p",
        "\x1b[\"p",
        "\x1b[x",
    ] {
        no_esc(s.as_bytes());
    }
    for m in [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016] {
        no_esc(format!("\x1b[?{m}h").as_bytes());
    }
    no_esc(b"\x1b[?25;1000h"); // one forbidden mode spoils the whole sequence
    no_esc(b"\x1b[3h"); // public modes other than IRM
}

#[test]
fn osc_titles_clipboard_hyperlinks_iterm_dropped() {
    for s in [
        "\x1b]0;evil title\x07",
        "\x1b]2;evil\x1b\\",
        "\x1b]52;c;cm0gLXJmIH4=\x07",
        "\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
        "\x1b]1337;File=inline=1:AAAA\x07",
        "\x1b]9;notify\x07",
    ] {
        no_esc(s.as_bytes());
    }
    assert_eq!(filt(b"a\x1b]0;t\x07b"), b"ab");
    assert_eq!(filt(b"\x1b]8;;u\x07link\x1b]8;;\x07"), b"link");
}

#[test]
fn dcs_apc_pm_sos_dropped() {
    for s in [
        "\x1bP$q\"p\x1b\\",                    // DECRQSS
        "\x1bPtmux;\x1b\x1b]52;c;x\x07\x1b\\", // tmux passthrough
        "\x1b_Gf=24;AAAA\x1b\\",               // APC (kitty graphics)
        "\x1b^private\x1b\\",                  // PM
        "\x1bXstring\x1b\\",                   // SOS
        "\x1bPq#0;2;0;0;0#0~~\x1b\\",          // sixel
    ] {
        no_esc(s.as_bytes());
    }
}

#[test]
fn raw_c1_and_utf8_c1_dropped() {
    // A raw C1 byte is dropped without starting a sequence, so what follows is plain text.
    assert_eq!(filt(b"a\x9b6nb\x9d0;x\x07c\x90q"), b"a6nb0;x\x07cq");
    assert_eq!(filt("a\u{9b}6n".as_bytes()), b"a6n");
    assert_eq!(filt("\u{85}\u{9d}\u{80}".as_bytes()), b"");
}

#[test]
fn invalid_utf8_becomes_replacement() {
    let fffd = "\u{FFFD}";
    for (input, want) in [
        (b"\xc0\xaf".as_slice(), format!("{fffd}{fffd}")), // overlong '/'
        (b"\xe0\x80\xaf", fffd.to_string()),               // overlong 3-byte
        (b"\xed\xa0\x80", fffd.to_string()),               // surrogate
        (b"\xf5\x80", fffd.to_string()), // F5 lead; 0x80 alone is a raw C1 byte: dropped
        (b"\xf4\x90\x80\x80", fffd.to_string()), // > U+10FFFF
        (b"\xbf", fffd.to_string()),     // stray continuation
        (b"\xe2\x9cx", format!("{fffd}x")), // truncated
    ] {
        assert_eq!(filt(input), want.as_bytes(), "{input:?}");
    }
}

#[test]
fn other_escapes_dropped() {
    for s in [
        "\x1bc",
        "\x1bZ",
        "\x1b#8",
        "\x1b(A",
        "\x1b%G",
        "\x1bN",
        "\x1bO",
        "\x1b\x1b[6n",
    ] {
        no_esc(s.as_bytes());
    }
}

/// Escape sequences end on a final byte anywhere in 0x30..=0x7E (ECMA-35 §13.2.1), not only on
/// CSI's 0x40..=0x7E: the sequence is dropped and the guest text after it survives intact.
#[test]
fn escape_finals_in_0x30_0x3f_end_the_sequence() {
    for (input, want) in [
        (&b"\x1b#8hello"[..], &b"hello"[..]), // DECALN
        (b"\x1b#3abc", b"abc"),               // DECDHL
        (b"\x1b*0hello", b"hello"),           // G2 designation
        (b"\x1b(%5hello", b"hello"),          // DEC Supplemental, intermediate after `(`
        (b"\x1b)%6hello", b"hello"),
        (b"\x1b%Ghello", b"hello"), // final in 0x40..=0x7E still works
        (b"\x1b F x", b" x"),       // ESC SP F, then text
        (b"\x1b  #8ok", b"ok"),     // several intermediates
    ] {
        assert_eq!(filt(input), want, "{input:?}");
    }
}

#[test]
fn ten_megabyte_osc_dropped_in_bounded_memory() {
    let mut f = AnsiFilter::new(FilterPolicy::Safe);
    let mut out = Vec::new();
    f.push(b"\x1b]52;c;", &mut out);
    let chunk = vec![b'A'; 1 << 20];
    for _ in 0..10 {
        f.push(&chunk, &mut out);
        assert!(out.is_empty(), "OSC body leaked");
    }
    f.push(b"\x07after", &mut out);
    assert_eq!(out, b"after");
    assert!(
        std::mem::size_of::<AnsiFilter>() < 256,
        "state is a fixed-size struct"
    );
    assert!(f.dropped() >= 10 << 20);
}

#[test]
fn overlong_csi_dropped_and_resynchronised() {
    let long = format!("\x1b[{}m", "1;".repeat(100));
    assert_eq!(filt(format!("{long}ok").as_bytes()), b"ok");
    assert_eq!(filt(b"\x1b[1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1mX"), b"X"); // 17 params
    assert_eq!(filt(b"\x1b[123456mX"), b"X"); // 6 digits
}

#[test]
fn cancel_and_newline_end_strings() {
    assert_eq!(filt(b"\x1b]0;x\x18after"), b"after"); // CAN
    assert_eq!(filt(b"\x1b]0;x\x1aafter"), b"after"); // SUB
    assert_eq!(filt(b"\x1b]0;broken\nnext"), b"\nnext");
    assert_eq!(filt(b"\x1b[3\n1m"), b"\n1m"); // C0 inside CSI aborts it
}

#[test]
fn bel_is_rate_limited() {
    let t0 = Instant::now();
    let mut f = AnsiFilter::new(FilterPolicy::Safe);
    let mut out = Vec::new();
    f.push_at(b"\x07\x07\x07", &mut out, t0);
    assert_eq!(out, b"\x07");
    f.push_at(b"\x07", &mut out, t0 + Duration::from_millis(999));
    assert_eq!(out, b"\x07");
    f.push_at(b"\x07", &mut out, t0 + Duration::from_secs(1));
    assert_eq!(out, b"\x07\x07");
}

#[test]
fn enq_so_si_dropped() {
    // ENQ makes some terminals send an answerback string; SO/SI switch character sets.
    assert_eq!(filt(b"\x05\x0e\x0fok"), b"ok");
}

#[test]
fn utf8_and_csi_split_across_pushes() {
    let mut f = AnsiFilter::new(FilterPolicy::Safe);
    let mut out = Vec::new();
    for part in [
        b"\xe2".as_slice(),
        b"\x9c",
        b"\x93 \x1b[3",
        b"1m",
        b"x\x1b]0",
        b";t\x07y",
    ] {
        f.push(part, &mut out);
    }
    assert_eq!(out, "✓ \x1b[31mxy".as_bytes());
}

#[test]
fn forbidden_sequences_inside_allowed_text_keep_the_text() {
    let input = b"\x1b[1mbold\x1b[0m \x1b[6nquery\x1b]0;t\x07 \x1b[?1049hscreen";
    assert_eq!(filt(input), b"\x1b[1mbold\x1b[0m query \x1b[?1049hscreen");
}

// ---- properties ----

struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

fn seed() -> u64 {
    std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x6d61_6376_6d6d_0003)
        .max(1)
}

/// Random input biased towards escape-sequence material.
fn random_input(r: &mut XorShift) -> Vec<u8> {
    const PIECES: &[&[u8]] = &[
        b"\x1b",
        b"[",
        b"]",
        b"?",
        b";",
        b"1",
        b"25",
        b"1049",
        b"h",
        b"l",
        b"m",
        b"c",
        b"n",
        b"t",
        b"q",
        b" ",
        b"\x07",
        b"\x1b\\",
        b"P",
        b"_",
        b"(",
        b")",
        b"B",
        b"0",
        b"\n",
        b"\r",
        b"\x9b",
        b"\xc2\x9b",
        b"\xc3\xa9",
        b"\xe2\x9c\x93",
        b"\xf0\x9d\x84\x9e",
        b"\xff",
        b"\x80",
        b"abc",
        b"\x18",
        b"\x00",
        b"$p",
        b":",
        b"7",
        b"8",
        b"M",
    ];
    let n = (r.next() % 64) as usize;
    let mut v = Vec::new();
    for _ in 0..n {
        if r.next().is_multiple_of(4) {
            v.push(r.next() as u8);
        } else {
            v.extend_from_slice(PIECES[(r.next() as usize) % PIECES.len()]);
        }
    }
    v
}

/// An independent recognizer of the TTY-3 allow-list: true if `out` contains only allowed
/// text, controls and sequences.
fn strictly_allowed(out: &[u8]) -> bool {
    let Ok(s) = std::str::from_utf8(out) else {
        return false;
    };
    if s.chars()
        .any(|c| c.is_control() && !"\x08\t\n\r\x07\x1b".contains(c))
    {
        return false;
    }
    let b = out;
    let mut i = 0;
    while i < b.len() {
        if b[i] != 0x1b {
            i += 1;
            continue;
        }
        let rest = &b[i + 1..];
        let len = match rest {
            [b'7' | b'8' | b'M' | b'=' | b'>', ..] => 1,
            [b'(' | b')', b'B' | b'0', ..] => 2,
            [b'[', tail @ ..] => {
                let Some(end) = tail.iter().position(|c| (0x40..=0x7e).contains(c)) else {
                    return false;
                };
                let (body, fin) = (&tail[..end], tail[end]);
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

#[test]
fn properties_idempotent_chunking_and_strict_recognizer() {
    let seed = seed();
    let mut r = XorShift(seed);
    let now = Instant::now();
    let iters = if cfg!(debug_assertions) {
        10_000
    } else {
        100_000
    };
    for i in 0..iters {
        let x = random_input(&mut r);
        let once = filt_at(&x, now);
        assert_eq!(
            filt_at(&once, now),
            once,
            "idempotence failed (seed {seed}, iteration {i}) for {x:?}"
        );
        let mut f = AnsiFilter::new(FilterPolicy::Safe);
        let mut bytewise = Vec::new();
        for b in &x {
            f.push_at(std::slice::from_ref(b), &mut bytewise, now);
        }
        assert_eq!(
            bytewise, once,
            "chunking changed the output (seed {seed}, iteration {i})"
        );
        assert!(
            strictly_allowed(&once),
            "non-allow-listed output (seed {seed}, iteration {i}): {x:?} -> {once:?}"
        );
    }
}

// ---- M6: every forbidden class under every filtering policy, `strict`, `raw` ----

fn with(policy: FilterPolicy, input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    AnsiFilter::new(policy).push_at(input, &mut out, Instant::now());
    out
}

/// Threat model §9.2 / PLAN M6: one input per forbidden class.
const FORBIDDEN: &[(&str, &[u8])] = &[
    ("DA", b"\x1b[c"),
    ("DA2", b"\x1b[>c"),
    ("DSR", b"\x1b[6n"),
    ("CSI t", b"\x1b[21t"),
    ("CSI i", b"\x1b[5i"),
    ("DECRQM", b"\x1b[?2004$p"),
    ("mouse", b"\x1b[?1000h"),
    ("OSC 0", b"\x1b]0;title\x07"),
    ("OSC 2", b"\x1b]2;title\x1b\\"),
    ("OSC 8", b"\x1b]8;;https://e.example\x07"),
    ("OSC 52", b"\x1b]52;c;SGVsbG8=\x07"),
    ("OSC 1337", b"\x1b]1337;SetUserVar=a=b\x07"),
    ("DCS DECRQSS", b"\x1bP$q\"p\x1b\\"),
    ("DCS tmux", b"\x1bPtmux;\x1b\x1b[6n\x1b\\"),
    ("APC", b"\x1b_Gi=1;AAAA\x1b\\"),
    ("PM", b"\x1b^pm\x1b\\"),
    ("SOS", b"\x1bXsos\x1b\\"),
    ("ENQ", b"\x05"),
    ("SO/SI", b"\x0e\x0f"),
    ("raw C1 CSI", b"\x9b6n"),
    ("raw C1 OSC", b"\x9d0;t\x07"),
    ("UTF-8 U+009B", "\u{9b}6n".as_bytes()),
];

fn assert_no_terminal_controls(name: &str, policy: FilterPolicy, out: &[u8]) {
    assert!(!out.contains(&0x1b), "{name} {policy:?}: ESC in {out:?}");
    assert!(!out.contains(&0x05), "{name} {policy:?}: ENQ in {out:?}");
    assert!(
        !out.contains(&0x0e) && !out.contains(&0x0f),
        "{name} {policy:?}: SO/SI in {out:?}"
    );
    assert!(
        !out.iter().any(|b| (0x80..=0x9f).contains(b)) || is_utf8_continuation_ok(out),
        "{name} {policy:?}: raw C1 in {out:?}"
    );
    if let Ok(s) = std::str::from_utf8(out) {
        assert!(
            !s.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c)),
            "{name} {policy:?}: UTF-8 C1 in {out:?}"
        );
    }
}

#[test]
fn forbidden_classes_safe() {
    for (name, input) in FORBIDDEN {
        assert_no_terminal_controls(name, FilterPolicy::Safe, &with(FilterPolicy::Safe, input));
    }
}

#[test]
fn forbidden_classes_strict() {
    for (name, input) in FORBIDDEN {
        let out = with(FilterPolicy::Strict, input);
        assert_no_terminal_controls(name, FilterPolicy::Strict, &out);
        assert!(!out.is_empty(), "{name}: strict shows what was sent");
    }
}

#[test]
fn forbidden_classes_embedded_in_text_keep_the_text() {
    for policy in [FilterPolicy::Safe, FilterPolicy::Strict] {
        for (name, input) in FORBIDDEN {
            let mut x = b"before ".to_vec();
            x.extend_from_slice(input);
            x.extend_from_slice(b" after\n");
            let out = with(policy, &x);
            assert_no_terminal_controls(name, policy, &out);
            assert!(out.starts_with(b"before "), "{name} {policy:?}: {out:?}");
            assert!(out.ends_with(b" after\n"), "{name} {policy:?}: {out:?}");
        }
    }
}

/// TTY-5: the `strict` rendering, byte for byte.
#[test]
fn strict_rendering_golden() {
    let input: &[u8] = b"ok\x1b[6n\x07\x9b\xc2\x9b\x7f\tz\xff\xe2\x82y\r\n\x08\x00";
    let want = "ok^[[6n^G\\x9b\\u{9b}^?\tz\\xff\\xe2\\x82y\r\n\x08^@";
    assert_eq!(
        String::from_utf8(with(FilterPolicy::Strict, input)).unwrap(),
        want
    );
}

#[test]
fn strict_passes_printable_utf8() {
    let s = "héllo wörld €100 \u{1F600} 漢字\n";
    assert_eq!(with(FilterPolicy::Strict, s.as_bytes()), s.as_bytes());
}

#[test]
fn strict_renders_invalid_utf8_visibly() {
    for (input, want) in [
        (b"\xc0\xaf".as_slice(), "\\xc0\\xaf"),        // overlong '/'
        (b"\xed\xa0\x80", "\\xed\\xa0\\x80"),          // surrogate
        (b"\xf4\x90\x80\x80", "\\xf4\\x90\\x80\\x80"), // > U+10FFFF
        (b"\xe0\x80\xaf", "\\xe0\\x80\\xaf"),          // overlong 3-byte
        (b"\x80", "\\x80"),                            // stray continuation (raw C1)
        (b"\xf8", "\\xf8"),
    ] {
        assert_eq!(
            String::from_utf8(with(FilterPolicy::Strict, input)).unwrap(),
            want,
            "{input:?}"
        );
    }
}

#[test]
fn strict_caret_notation_for_every_c0() {
    for b in 0u8..0x20 {
        let out = with(FilterPolicy::Strict, &[b]);
        match b {
            b'\t' | b'\n' | b'\r' | 0x08 => assert_eq!(out, [b]),
            _ => assert_eq!(out, [b'^', b ^ 0x40], "{b:#x}"),
        }
    }
    assert_eq!(with(FilterPolicy::Strict, b"\x7f"), b"^?");
}

#[test]
fn strict_split_across_pushes_equals_one_push() {
    let mut input = "a\x1b]52;\u{9b}é\u{1F600}".as_bytes().to_vec();
    input.extend_from_slice(b"\x9b\xe2\x82z\n");
    let input = input.as_slice();
    let whole = with(FilterPolicy::Strict, input);
    let mut f = AnsiFilter::new(FilterPolicy::Strict);
    let mut out = Vec::new();
    for b in input {
        f.push(std::slice::from_ref(b), &mut out);
    }
    assert_eq!(out, whole);
}

#[test]
fn raw_passes_every_byte_unchanged() {
    let all: Vec<u8> = (0..=255u8).collect();
    let f = AnsiFilter::new(FilterPolicy::Raw);
    assert_eq!(f.policy(), FilterPolicy::Raw);
    assert_eq!(with(FilterPolicy::Raw, &all), all);
    assert_eq!(
        with(FilterPolicy::Raw, b"\x1b[6n\x1b]52;c;x\x07"),
        b"\x1b[6n\x1b]52;c;x\x07"
    );
}

#[test]
fn policy_names() {
    assert_eq!(FilterPolicy::default(), FilterPolicy::Safe);
    assert_eq!(
        [FilterPolicy::Safe, FilterPolicy::Strict, FilterPolicy::Raw].map(FilterPolicy::name),
        ["safe", "strict", "raw"]
    );
}

#[test]
fn csi_64_byte_pending_overflow_resynchronises_in_every_mode() {
    // TTY-4: a CSI longer than ANSI_PENDING_MAX is dropped whole; the text after it survives.
    let long = format!("\x1b[{}mtext\n", "1;".repeat(40));
    assert_eq!(with(FilterPolicy::Safe, long.as_bytes()), b"text\n");
    let long_private = format!("\x1b[?{}htext\n", "25;".repeat(30));
    assert_eq!(with(FilterPolicy::Safe, long_private.as_bytes()), b"text\n");
    // Exactly at the cap: 64 parameter bytes is still a sequence the filter can judge.
    let at_cap = format!("\x1b[{}m", "1".repeat(64));
    assert_eq!(
        with(FilterPolicy::Safe, at_cap.as_bytes()),
        b"",
        "too many digits"
    );
}

#[test]
fn safe_allows_the_modes_exit_hygiene_resets() {
    // TTY-6 resets exactly these; each must be something `safe` lets through, or the reset
    // would be pointless (and each set must be undone by the reset).
    for set in [
        "\x1b[1m",
        "\x1b[?25l",
        "\x1b[?1049h",
        "\x1b[?47h",
        "\x1b[?2004h",
        "\x1b[?1h",
        "\x1b[4h",
        "\x1b=",
        "\x1b(0",
        "\x1b[2;10r",
    ] {
        assert_eq!(
            with(FilterPolicy::Safe, set.as_bytes()),
            set.as_bytes(),
            "{set:?}"
        );
    }
}

#[test]
fn bracketed_paste_markers_are_data_for_the_filter() {
    // A guest echoing a paste: the 200~/201~ markers are not on the allow-list (final `~`).
    assert_eq!(
        with(FilterPolicy::Safe, b"\x1b[200~paste\x1b[201~"),
        b"paste"
    );
}

#[test]
fn osc_terminated_by_st_and_followed_by_csi() {
    assert_eq!(
        with(FilterPolicy::Safe, b"\x1b]0;x\x1b\\\x1b[1mB\x1b[0m"),
        b"\x1b[1mB\x1b[0m"
    );
}

#[test]
fn nested_escape_inside_csi_restarts() {
    assert_eq!(with(FilterPolicy::Safe, b"\x1b[1\x1b[2mX"), b"\x1b[2mX");
}

#[test]
fn property_strict_output_has_no_controls() {
    let seed = seed();
    let mut r = XorShift(seed ^ 0x5717);
    for i in 0..10_000 {
        let x = random_input(&mut r);
        let out = with(FilterPolicy::Strict, &x);
        let s = std::str::from_utf8(&out)
            .unwrap_or_else(|e| panic!("seed {seed} iter {i}: not UTF-8 ({e}): {x:?}"));
        assert!(
            !s.chars()
                .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\x08')),
            "seed {seed} iter {i}: control in strict output {s:?}"
        );
        assert_eq!(
            with(FilterPolicy::Strict, &out),
            out,
            "seed {seed} iter {i}: strict is not idempotent"
        );
    }
}

#[test]
fn property_raw_is_identity_and_safe_never_emits_c1() {
    let seed = seed();
    let mut r = XorShift(seed ^ 0x4a77);
    for i in 0..10_000 {
        let x = random_input(&mut r);
        assert_eq!(with(FilterPolicy::Raw, &x), x, "seed {seed} iter {i}");
        let safe = with(FilterPolicy::Safe, &x);
        assert!(
            !safe.iter().any(|b| (0x80..=0x9f).contains(b)) || is_utf8_continuation_ok(&safe),
            "seed {seed} iter {i}: {safe:?}"
        );
    }
}

#[test]
fn strict_names_every_utf8_c1_code_point() {
    for cp in 0x80u32..=0x9f {
        let c = char::from_u32(cp).unwrap();
        let mut buf = [0u8; 4];
        let out = with(FilterPolicy::Strict, c.encode_utf8(&mut buf).as_bytes());
        assert_eq!(String::from_utf8(out).unwrap(), format!("\\u{{{cp:x}}}"));
    }
}

#[test]
fn raw_and_safe_count_drops_differently() {
    let mut raw = AnsiFilter::new(FilterPolicy::Raw);
    let mut out = Vec::new();
    raw.push(b"\x1b[6n", &mut out);
    assert_eq!(raw.dropped(), 0);
    let mut safe = AnsiFilter::new(FilterPolicy::Safe);
    out.clear();
    safe.push(b"\x1b[6n", &mut out);
    assert!(out.is_empty() && safe.dropped() > 0);
    let mut strict = AnsiFilter::new(FilterPolicy::Strict);
    out.clear();
    strict.push(b"\x1b[6n", &mut out);
    assert_eq!(out, b"^[[6n");
    assert_eq!(strict.dropped(), 1, "one control rendered");
}

#[test]
fn strict_renders_osc_and_dcs_in_full() {
    assert_eq!(
        with(FilterPolicy::Strict, b"\x1b]52;c;QQ==\x07\x1bP+q544e\x1b\\"),
        b"^[]52;c;QQ==^G^[P+q544e^[\\"
    );
}
