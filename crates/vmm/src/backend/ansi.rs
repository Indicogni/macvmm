//! `AnsiFilter`: the allow-list filter every guest byte passes before it reaches a host sink
//! (threat model TTY-1, TTY-3, TTY-4; architecture §21.4).
//!
//! **Why.** A guest's serial output lands in the user's terminal emulator, which interprets far
//! more than text: queries that make the terminal *type a reply* into stdin (DA `CSI c`, DSR
//! `CSI 6 n`, DECRQSS `DCS $ q`, the title report `CSI 21 t`), clipboard writes (`OSC 52`),
//! hyperlinks and notifications, iTerm2's `OSC 1337`, tmux passthrough. A reply still queued
//! when macvmm exits is read by the host shell: input injection. Stripping every escape would
//! break shells and editors in the guest, so the `safe` policy is an **allow-list**: a short
//! set of harmless sequences passes byte-exact, everything else is dropped whole. It applies to
//! every sink whether or not it is a TTY, because `macvmm run … | tee log` still ends up on a
//! terminal (TTY-1).
//!
//! **Grammar** (ECMA-48 5th ed. §5.3–§5.4 for the sequence structure; xterm *ctlseqs* for the
//! meanings), exactly TTY-3:
//! - printable ASCII, and valid UTF-8 for printable code points; invalid UTF-8 → U+FFFD; C1
//!   code points U+0080–U+009F (raw 8-bit or UTF-8-encoded) → dropped;
//! - C0: BS, HT, LF, CR, and BEL at most once per second; every other C0 and DEL → dropped;
//! - `ESC 7`, `ESC 8`, `ESC M`, `ESC =`, `ESC >`, `ESC ( B`, `ESC ( 0`, `ESC ) B`, `ESC ) 0`;
//! - CSI with parameters `0-9 ; :` (at most 16, each at most 5 digits) and a final byte from
//!   [`CSI_FINALS`]; `SP q` (DECSCUSR); `h`/`l` only for private modes [`PRIVATE_MODES`] and
//!   public mode 4 (IRM);
//! - OSC, DCS, APC, PM and SOS → dropped entirely, up to their terminator (BEL or `ESC \`).
//!   Swallowing also ends at CAN or SUB (ECMA-48 §5.6: they cancel a sequence), and at LF: the
//!   terminal never saw the opening bytes, so what follows is plain text to it, and
//!   resynchronising on a newline keeps a guest's console readable after a broken sequence.
//!
//! A C0 control inside an escape or CSI aborts the sequence (it is dropped) and is then
//! handled as text. Real terminals execute it mid-sequence and continue; we never emit the
//! partial sequence, so the terminal sees only the control and the bytes after it as text.
//!
//! **Bounds** (TTY-4): the only buffered state is a CSI in progress, at most
//! [`ANSI_PENDING_MAX`] = 64 bytes in a fixed array, and a partial UTF-8 character (4 bytes).
//! A longer CSI is dropped and skipped up to its final byte. Work is O(1) per input byte,
//! nothing is allocated per byte (the output grows by at most 3 bytes per input byte, for
//! U+FFFD), strings of any length are swallowed in constant memory, and no input can panic.
//!
//! **Purity.** The filter does no I/O; the BEL rate limit uses the time passed to
//! [`AnsiFilter::push_at`].
//!
//! **The other policies** (TTY-2, TTY-5; M6). A sink chooses one with `--serial ...,strict` or
//! `...,raw`:
//! - [`FilterPolicy::Strict`] is for logs and CI, where seeing *what* the guest sent matters
//!   more than rendering it: printable ASCII and valid printable UTF-8 pass, as do CR, LF, HT
//!   and BS; every other control is **rendered visibly** and never emitted: C0 and DEL in caret
//!   notation (`ESC` → `^[`, `BEL` → `^G`, `DEL` → `^?`), raw 8-bit C1 bytes and other bytes
//!   that are not valid UTF-8 as `\xNN` (`0x9b` → `\x9b`), and UTF-8-encoded C1 code points as
//!   `\u{NN}` (U+009B → `\u{9b}`). The output therefore never contains a byte below 0x20 other
//!   than CR, LF, HT and BS, nor any C1 control in any encoding;
//! - [`FilterPolicy::Raw`] passes every byte unchanged. It exists for the rare guest whose
//!   output must reach the terminal byte-exact and that the user trusts; the CLI prints a
//!   one-line warning on stderr when it is chosen (TTY-2).
//!
//! Exit hygiene (the reset of terminal modes on exit, TTY-6) is not a filter job: it lives in
//! `macvmm/src/term.rs`, which writes the reset through the stdio sink after the guest's last
//! byte.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use std::time::{Duration, Instant};

/// The most bytes of one pending CSI the filter keeps (TTY-4).
pub const ANSI_PENDING_MAX: usize = 64;
/// CSI parameters allowed per sequence (TTY-3).
pub const CSI_MAX_PARAMS: usize = 16;
/// Digits allowed per CSI parameter (TTY-3).
pub const CSI_MAX_DIGITS: usize = 5;
/// Allowed CSI final bytes without intermediates: SGR `m`; cursor `A B C D E F G H f d` and
/// `` ` `` (HPA); erase `J K X`; edit `@ P L M`; scroll `S T`; DECSTBM `r`.
pub const CSI_FINALS: &[u8] = b"mABCDEFGHfd`JKX@PLMSTr";
/// Private modes `CSI ? n h|l` may set or reset: DECCKM, DECAWM, blink, cursor visibility,
/// the alternate screens and bracketed paste.
pub const PRIVATE_MODES: &[u32] = &[1, 7, 12, 25, 47, 1047, 1048, 1049, 2004];
/// Minimum time between two BELs that pass.
pub const BEL_INTERVAL: Duration = Duration::from_secs(1);

/// The filter policy of a sink (TTY-2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FilterPolicy {
    /// The TTY-3 allow-list (the default).
    #[default]
    Safe,
    /// Render every control visibly (TTY-5).
    Strict,
    /// No filtering at all (explicit opt-in, with a warning).
    Raw,
}

impl FilterPolicy {
    /// The policy's name as the CLI spells it.
    pub const fn name(self) -> &'static str {
        match self {
            FilterPolicy::Safe => "safe",
            FilterPolicy::Strict => "strict",
            FilterPolicy::Raw => "raw",
        }
    }
}

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const REPLACEMENT: &[u8] = "\u{FFFD}".as_bytes();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Ground,
    /// After ESC.
    Esc,
    /// After `ESC (` or `ESC )`: the designator byte.
    Charset(u8),
    /// After `ESC <intermediate>` that is not allowed: skip further intermediates (0x20–0x2F)
    /// up to the final byte, which for an escape sequence is anything in 0x30–0x7E (ECMA-35
    /// §13.2.1, ECMA-48 §5.3), e.g. the `8` of DECALN `ESC # 8`.
    EscSkip,
    /// Inside `ESC [`, collecting into `csi`.
    Csi,
    /// A CSI longer than the cap: skip parameters and intermediates (0x20–0x3F) up to its final
    /// byte, which for a control sequence is 0x40–0x7E (ECMA-48 §5.4).
    CsiSkip,
    /// Inside OSC/DCS/APC/PM/SOS: drop until the terminator.
    Str,
    /// ESC seen inside a string: `\` ends it; anything else starts a new escape.
    StrEsc,
    /// Inside a multi-byte UTF-8 character: `need` more continuation bytes, the code point so
    /// far, the smallest code point this length may encode (overlong check), bytes kept.
    Utf8 {
        need: u8,
        cp: u32,
        min: u32,
        len: u8,
    },
}

/// The streaming filter; one per sink.
#[derive(Debug)]
pub struct AnsiFilter {
    policy: FilterPolicy,
    state: State,
    csi: [u8; ANSI_PENDING_MAX],
    csi_len: usize,
    utf8: [u8; 4],
    last_bel: Option<Instant>,
    dropped: u64,
}

impl Default for AnsiFilter {
    fn default() -> Self {
        AnsiFilter::new(FilterPolicy::Safe)
    }
}

impl AnsiFilter {
    pub fn new(policy: FilterPolicy) -> AnsiFilter {
        AnsiFilter {
            policy,
            state: State::Ground,
            csi: [0; ANSI_PENDING_MAX],
            csi_len: 0,
            utf8: [0; 4],
            last_bel: None,
            dropped: 0,
        }
    }

    /// Bytes dropped so far (approximate: a dropped sequence counts its bytes as seen).
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Filter `input`, appending what may reach the terminal to `out`.
    pub fn push(&mut self, input: &[u8], out: &mut Vec<u8>) {
        self.push_at(input, out, Instant::now());
    }

    /// [`AnsiFilter::push`] with an explicit time for the BEL rate limit.
    pub fn push_at(&mut self, input: &[u8], out: &mut Vec<u8>, now: Instant) {
        match self.policy {
            FilterPolicy::Safe => {
                for &b in input {
                    self.byte(b, out, now);
                }
            }
            FilterPolicy::Strict => {
                for &b in input {
                    self.strict_byte(b, out);
                }
            }
            FilterPolicy::Raw => out.extend_from_slice(input),
        }
    }

    /// The policy this filter applies.
    pub fn policy(&self) -> FilterPolicy {
        self.policy
    }

    fn drop1(&mut self) {
        self.dropped = self.dropped.saturating_add(1);
    }

    /// One input byte: dispatch on the state.
    fn byte(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match self.state {
            State::Ground => self.ground(b, out, now),
            State::Esc => self.esc(b, out, now),
            State::Charset(intro) => self.charset(intro, b, out, now),
            State::EscSkip => self.esc_skip(b, out, now),
            State::CsiSkip => self.csi_skip(b, out, now),
            State::Csi => self.csi_byte(b, out, now),
            State::Str => self.string(b, out, now),
            State::StrEsc => {
                if b == b'\\' {
                    self.state = State::Ground; // ST: the string is over
                } else {
                    self.state = State::Esc;
                    self.esc(b, out, now);
                }
            }
            State::Utf8 { need, cp, min, len } => self.utf8_byte(b, need, cp, min, len, out, now),
        }
    }

    // ANCHOR: ansi_filter_safe
    /// Ground state: the text half of the TTY-3 allow-list.
    fn ground(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            ESC => self.state = State::Esc,
            b'\x08' | b'\t' | b'\n' | b'\r' | 0x20..=0x7e => out.push(b),
            BEL => self.bel(out, now),
            0xc2..=0xdf => self.start_utf8(b, 1, u32::from(b & 0x1f), 0x80),
            0xe0..=0xef => self.start_utf8(b, 2, u32::from(b & 0x0f), 0x800),
            0xf0..=0xf4 => self.start_utf8(b, 3, u32::from(b & 0x07), 0x1_0000),
            0x80..=0x9f => self.drop1(), // raw 8-bit C1 (0x9b is CSI, 0x9d OSC)
            0xa0..=0xff => out.extend_from_slice(REPLACEMENT), // stray continuation, C0/C1 lead, F5+
            _ => self.drop1(),                                 // every other C0, and DEL
        }
    }
}

/// Is `ESC [ <body> <fin>` on the allow-list? `body` is the parameter and intermediate bytes.
fn csi_allowed(body: &[u8], fin: u8) -> bool {
    let (private, rest) = match body.split_first() {
        Some((b'?', rest)) => (true, rest),
        _ => (false, body),
    };
    // A single trailing SP intermediate, only for DECSCUSR (`CSI n SP q`).
    let (params, sp) = match rest.split_last() {
        Some((b' ', p)) => (p, true),
        _ => (rest, false),
    };
    if !params
        .iter()
        .all(|c| matches!(c, b'0'..=b'9' | b';' | b':'))
    {
        return false;
    }
    let mut fields = params.split(|&c| c == b';' || c == b':');
    let shape_ok = fields
        .by_ref()
        .take(CSI_MAX_PARAMS)
        .all(|p| p.len() <= CSI_MAX_DIGITS);
    if !shape_ok || fields.next().is_some() {
        return false;
    }
    match (private, sp, fin) {
        (false, true, b'q') => true,
        (_, true, _) => false,
        (false, false, f) if CSI_FINALS.contains(&f) => true,
        (true, false, b'h' | b'l') => params
            .split(|&c| c == b';')
            .all(|m| parse_mode(m).is_some_and(|n| PRIVATE_MODES.contains(&n))),
        (false, false, b'h' | b'l') => params == b"4",
        _ => false, // DA, DSR, window ops, media copy, DECRQM, mouse modes, ...
    }
}
// ANCHOR_END: ansi_filter_safe

impl AnsiFilter {
    /// After ESC: the allowed two-byte sequences pass; CSI collects; strings are swallowed.
    fn esc(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            b'7' | b'8' | b'M' | b'=' | b'>' => {
                out.extend_from_slice(&[ESC, b]);
                self.state = State::Ground;
            }
            b'(' | b')' => self.state = State::Charset(b),
            b'[' => {
                self.csi_len = 0;
                self.state = State::Csi;
            }
            b']' | b'P' | b'_' | b'^' | b'X' => self.state = State::Str, // OSC DCS APC PM SOS
            ESC => self.drop1(),
            0x20..=0x2f => self.state = State::EscSkip,
            0x30..=0x7e => {
                self.drop1(); // RIS, DECID, ... everything else
                self.state = State::Ground;
            }
            _ => self.abort_and_reprocess(b, out, now),
        }
    }

    fn bel(&mut self, out: &mut Vec<u8>, now: Instant) {
        let ok = self
            .last_bel
            .is_none_or(|t| now.saturating_duration_since(t) >= BEL_INTERVAL);
        if ok {
            self.last_bel = Some(now);
            out.push(BEL);
        } else {
            self.drop1();
        }
    }

    fn charset(&mut self, intro: u8, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            b'B' | b'0' => {
                out.extend_from_slice(&[ESC, intro, b]);
                self.state = State::Ground;
            }
            ESC => self.state = State::Esc,
            // A further intermediate, e.g. `ESC ( % 5` (DEC Supplemental): the sequence is not
            // over yet, so its real final byte must not leak out as text.
            0x20..=0x2f => {
                self.drop1();
                self.state = State::EscSkip;
            }
            0x30..=0x7e => {
                self.drop1();
                self.state = State::Ground;
            }
            _ => self.abort_and_reprocess(b, out, now),
        }
    }

    /// Escape-sequence grammar (ECMA-35 §13.2.1): `ESC I* F` with intermediates I in 0x20–0x2F
    /// and the final F in 0x30–0x7E. Treating 0x30–0x3F as more intermediates (the CSI rule)
    /// would swallow the next printable byte of guest text as the "final".
    fn esc_skip(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            0x20..=0x2f => self.drop1(),
            0x30..=0x7e => {
                self.drop1();
                self.state = State::Ground;
            }
            ESC => self.state = State::Esc,
            _ => self.abort_and_reprocess(b, out, now),
        }
    }

    /// Control-sequence grammar (ECMA-48 §5.4): parameters 0x30–0x3F and intermediates
    /// 0x20–0x2F, ended by a final byte in 0x40–0x7E.
    fn csi_skip(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            0x20..=0x3f => self.drop1(),
            0x40..=0x7e => self.state = State::Ground,
            ESC => self.state = State::Esc,
            _ => self.abort_and_reprocess(b, out, now),
        }
    }

    fn csi_byte(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            0x20..=0x3f => {
                if let Some(slot) = self.csi.get_mut(self.csi_len) {
                    *slot = b;
                    self.csi_len = self.csi_len.saturating_add(1);
                } else {
                    self.state = State::CsiSkip; // TTY-4: too long, drop it whole
                }
            }
            0x40..=0x7e => {
                let body = self.csi.get(..self.csi_len).unwrap_or(&[]);
                if csi_allowed(body, b) {
                    out.extend_from_slice(&[ESC, b'[']);
                    out.extend_from_slice(body);
                    out.push(b);
                } else {
                    self.dropped = self.dropped.saturating_add(3);
                }
                self.state = State::Ground;
            }
            ESC => self.state = State::Esc,
            _ => self.abort_and_reprocess(b, out, now),
        }
    }

    fn string(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        match b {
            BEL | CAN | SUB => self.state = State::Ground,
            ESC => self.state = State::StrEsc,
            b'\n' => self.abort_and_reprocess(b, out, now),
            _ => self.drop1(),
        }
    }

    fn start_utf8(&mut self, b: u8, need: u8, cp: u32, min: u32) {
        self.utf8 = [b, 0, 0, 0];
        self.state = State::Utf8 {
            need,
            cp,
            min,
            len: 1,
        };
    }

    #[allow(clippy::too_many_arguments)] // the state's fields, unpacked by `byte`
    fn utf8_byte(
        &mut self,
        b: u8,
        need: u8,
        cp: u32,
        min: u32,
        len: u8,
        out: &mut Vec<u8>,
        now: Instant,
    ) {
        if b & 0xc0 != 0x80 {
            // Truncated character: one U+FFFD for it, then `b` on its own.
            out.extend_from_slice(REPLACEMENT);
            self.state = State::Ground;
            self.ground(b, out, now);
            return;
        }
        // At most 3 continuation bytes after a lead of ≤ 3 payload bits: cp < 2^21, no overflow.
        let cp = (cp << 6) | u32::from(b & 0x3f);
        if let Some(slot) = self.utf8.get_mut(usize::from(len)) {
            *slot = b;
        }
        let len = len.saturating_add(1);
        if need > 1 {
            self.state = State::Utf8 {
                need: need.saturating_sub(1),
                cp,
                min,
                len,
            };
            return;
        }
        self.state = State::Ground;
        match char::from_u32(cp) {
            _ if cp < min => out.extend_from_slice(REPLACEMENT), // overlong encoding
            Some(c) if c.is_control() => self.drop1(),           // C1 as UTF-8 (U+0080..9F)
            Some(_) => out.extend_from_slice(self.utf8.get(..usize::from(len)).unwrap_or(&[])),
            None => out.extend_from_slice(REPLACEMENT), // surrogate, or above U+10FFFF
        }
    }

    /// A control byte interrupted a sequence: drop the sequence, handle `b` as text.
    fn abort_and_reprocess(&mut self, b: u8, out: &mut Vec<u8>, now: Instant) {
        self.drop1();
        self.state = State::Ground;
        self.ground(b, out, now);
    }
}

impl AnsiFilter {
    // ANCHOR: ansi_filter_strict
    /// One byte under the `strict` policy (TTY-5, module docs): text passes, every other
    /// control is rendered visibly. Only the UTF-8 state is shared with `safe`.
    fn strict_byte(&mut self, b: u8, out: &mut Vec<u8>) {
        if let State::Utf8 { need, cp, min, len } = self.state {
            if b & 0xc0 == 0x80 {
                self.strict_continuation(b, need, cp, min, len, out);
                return;
            }
            // A truncated character: show its bytes, then handle `b` from the ground state.
            self.state = State::Ground;
            self.render_hex_pending(len, out);
        }
        match b {
            b'\x08' | b'\t' | b'\n' | b'\r' | 0x20..=0x7e => out.push(b),
            0x00..=0x1f => {
                self.drop1();
                out.extend_from_slice(&[b'^', b ^ 0x40]); // ESC -> ^[, BEL -> ^G
            }
            0x7f => {
                self.drop1();
                out.extend_from_slice(b"^?");
            }
            0xc2..=0xdf => self.start_utf8(b, 1, u32::from(b & 0x1f), 0x80),
            0xe0..=0xef => self.start_utf8(b, 2, u32::from(b & 0x0f), 0x800),
            0xf0..=0xf4 => self.start_utf8(b, 3, u32::from(b & 0x07), 0x1_0000),
            _ => {
                // Raw C1 (0x80..=0x9f), stray continuations, C0/C1 leads, F5+.
                self.drop1();
                hex_byte(b, out);
            }
        }
    }
    // ANCHOR_END: ansi_filter_strict

    #[allow(clippy::too_many_arguments)] // the state's fields, unpacked by `strict_byte`
    fn strict_continuation(
        &mut self,
        b: u8,
        need: u8,
        cp: u32,
        min: u32,
        len: u8,
        out: &mut Vec<u8>,
    ) {
        let cp = (cp << 6) | u32::from(b & 0x3f); // < 2^21: no overflow (see `utf8_byte`)
        if let Some(slot) = self.utf8.get_mut(usize::from(len)) {
            *slot = b;
        }
        let len = len.saturating_add(1);
        if need > 1 {
            self.state = State::Utf8 {
                need: need.saturating_sub(1),
                cp,
                min,
                len,
            };
            return;
        }
        self.state = State::Ground;
        match char::from_u32(cp) {
            Some(c) if cp >= min && c.is_control() => {
                // C1 as UTF-8 (U+0080..U+009F): name it, never emit it.
                self.drop1();
                out.extend_from_slice(b"\\u{");
                for d in format_hex(cp).iter().flatten() {
                    out.push(*d);
                }
                out.push(b'}');
            }
            Some(_) if cp >= min => {
                out.extend_from_slice(self.utf8.get(..usize::from(len)).unwrap_or(&[]));
            }
            _ => self.render_hex_pending(len, out), // overlong, surrogate, > U+10FFFF
        }
    }

    /// Render the first `len` bytes of the pending UTF-8 buffer as `\xNN`.
    fn render_hex_pending(&mut self, len: u8, out: &mut Vec<u8>) {
        let pending = self.utf8;
        for &p in pending.get(..usize::from(len)).unwrap_or(&[]) {
            self.drop1();
            hex_byte(p, out);
        }
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// `\xNN`, lowercase.
fn hex_byte(b: u8, out: &mut Vec<u8>) {
    let hi = HEX.get(usize::from(b >> 4)).copied().unwrap_or(b'?');
    let lo = HEX.get(usize::from(b & 0xf)).copied().unwrap_or(b'?');
    out.extend_from_slice(&[b'\\', b'x', hi, lo]);
}

/// The lowercase hex digits of `v` (< 2^24), without leading zeros (at least one digit).
fn format_hex(v: u32) -> [Option<u8>; 6] {
    let mut digits = [None; 6];
    let mut started = false;
    for (i, slot) in digits.iter_mut().enumerate() {
        let shift = 20u32.saturating_sub(u32::try_from(i).unwrap_or(0).saturating_mul(4));
        let nib = usize::try_from((v >> shift) & 0xf).unwrap_or(0);
        if nib != 0 || started || i == 5 {
            started = true;
            *slot = HEX.get(nib).copied();
        }
    }
    digits
}

fn parse_mode(digits: &[u8]) -> Option<u32> {
    if digits.is_empty() || digits.len() > CSI_MAX_DIGITS {
        return None;
    }
    core::str::from_utf8(digits).ok()?.parse().ok()
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    fn f(input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        AnsiFilter::default().push(input, &mut out);
        out
    }

    #[test]
    fn allowlist_spot_checks() {
        assert_eq!(f(b"hi\r\n"), b"hi\r\n");
        assert_eq!(f(b"\x1b[1;31mred\x1b[0m"), b"\x1b[1;31mred\x1b[0m");
        assert_eq!(f(b"\x1b[c"), b"");
        assert_eq!(f(b"\x1b]0;title\x07x"), b"x");
        assert_eq!(f(b"\x1b[?1049h"), b"\x1b[?1049h");
        assert_eq!(f(b"\x1b[?1000h"), b"");
        assert_eq!(f(b"\x1b[2 q"), b"\x1b[2 q");
        assert_eq!(f("é".as_bytes()), "é".as_bytes());
        assert_eq!(f(b"\xc3"), b"");
        assert_eq!(f(b"\xc3x"), "\u{FFFD}x".as_bytes());
    }

    #[test]
    fn csi_parameter_bounds() {
        let ok = format!("\x1b[{}m", vec!["1"; CSI_MAX_PARAMS].join(";"));
        assert_eq!(f(ok.as_bytes()), ok.as_bytes());
        let too_many = format!("\x1b[{}m", vec!["1"; CSI_MAX_PARAMS + 1].join(";"));
        assert_eq!(f(too_many.as_bytes()), b"");
        assert_eq!(f(b"\x1b[12345m"), b"\x1b[12345m");
        assert_eq!(f(b"\x1b[123456m"), b"");
    }
}
