//! The terminal: raw mode, the stdin thread with its Ctrl-A escapes, and exit hygiene
//! (architecture §14.4; course ch09; threat model PROC-1, TTY-6, TTY-7, TTY-9, TTY-10).
//!
//! **Raw mode, and only on a TTY (PROC-1).** A serial console wants every keystroke as it is
//! typed, including Ctrl-C (which belongs to the guest's shell), so when stdin is a terminal
//! and the serial sink is `stdio`, [`Terminal::setup`] switches it to the raw variant of
//! `hvf::host::Termios` (no line editing, no echo, no signal keys; output post-processing is
//! kept so `\n` still renders as a new line). Under a pipe, as in every test, nothing changes.
//! The saved state is restored by [`Terminal::restore`] (normal exit), its `Drop`, a panic hook
//! ([`install_panic_hook`]) and the signal path (`signals.rs`), so no exit path leaves the
//! user's shell raw.
//!
//! **Ctrl-A escapes (TTY-9).** The stdin thread ([`spawn_stdin`]) runs every byte through an
//! [`EscapeParser`] *before* anything reaches the guest, so a guest can never produce a host
//! command, and a terminal reply forged by guest output that contains `^A x` can at most quit
//! the guest's own VM:
//!
//! | Keys | Action |
//! |---|---|
//! | Ctrl-A x | quit (exit code 130) |
//! | Ctrl-A t | print every vCPU's last exits (the trace ring) on stderr |
//! | Ctrl-A s | print the console I/O counters on stderr |
//! | Ctrl-A h or ? | print this help on stderr |
//! | Ctrl-A Ctrl-A | send one Ctrl-A to the guest |
//!
//! Any other byte after Ctrl-A is discarded with the escape.
//!
//! **The stdin thread never waits for the guest (TTY-10, flaw F21).** It only ever blocks in
//! `read(0)`. Guest-bound bytes go into `HostIo::serial_input`, whose `push` drops and counts
//! what does not fit, so the thread is always back in `read` and always sees Ctrl-A x, even
//! when the guest stopped reading its UART. EOF on stdin ends the thread quietly: the guest
//! simply gets no more input.
//!
//! **Exit hygiene (TTY-6, TTY-7, flaw F1).** A guest may have left the terminal in the
//! alternate screen, with the cursor hidden, bracketed paste on, and so on (everything the
//! `safe` filter lets through). When stdout is a TTY, the CLI's exit path is, in this order:
//! 1. the stdio sink drains its queue (at most 500 ms) and writes [`RESET_SEQUENCE`] **after
//!    the guest's last byte** (`HostIo::close_sinks`, SINK-1 ordering). If the sink could not
//!    (it turned `none` after a write error, or its writer was stuck and abandoned),
//!    [`write_reset_fallback`] writes the reset itself with a bounded, non-blocking write;
//! 2. [`Terminal::restore`] puts the saved termios back and calls `tcflush(0, TCIFLUSH)`, which
//!    discards any terminal reply or keystroke still queued for the guest, so the host shell
//!    never reads it;
//! 3. if the guest printed to the terminal, a newline (when the cursor is not at column 0) and
//!    `macvmm: <reason>` on stderr, so a guest-drawn fake prompt is never the last thing on
//!    screen.
#![forbid(unsafe_code)]

use crate::err;
use std::io::{self, Read};
use std::sync::{Arc, Mutex, Once};
use vmm::HostIo;

// ANCHOR: reset_sequence
/// Reset every mode the `safe` filter lets a guest set (TTY-6), in this order:
///
/// | Bytes | Undoes |
/// |---|---|
/// | `CSI 0 m` | SGR colours and attributes |
/// | `CSI ? 25 h` | a hidden cursor (DECTCEM) |
/// | `CSI ? 1049 l`, `CSI ? 1047 l`, `CSI ? 47 l` | the three alternate screens |
/// | `CSI ? 2004 l` | bracketed paste |
/// | `CSI ? 1 l` | application cursor keys (DECCKM) |
/// | `CSI ? 7 h` | autowrap off (DECAWM; on is the default) |
/// | `CSI ? 12 l` | a blinking cursor (att610) |
/// | `CSI 0 SP q` | a cursor shape (DECSCUSR 0: the terminal's default) |
/// | `CSI 4 l` | insert mode (IRM) |
/// | `ESC >` | the application keypad (DECKPNM) |
/// | `ESC ( B`, `ESC ) B` | DEC line drawing in G0 or G1 |
/// | `ESC 7`, `CSI r`, `ESC 8` | a scroll region (DECSTBM), keeping the cursor where it is |
///
/// The last row matters for TTY-7: `CSI r` also homes the cursor (VT510 DECSTBM; xterm's
/// `CASE_DECSTBM` calls `CursorSet(0, 0)`), which would put macvmm's verdict line over the top
/// line of the screen. DECSC/DECRC (`ESC 7`/`ESC 8`) save and restore the cursor around it.
/// They also save the SGR attributes and the charsets, which is why they come after `CSI 0 m`
/// and `ESC ( B`: what they restore is the reset state. `CSI ? 1048 h|l` (save/restore the
/// cursor) is an action, not a mode, so nothing undoes it. The unit test
/// `reset_sequence_covers_every_mode_safe_allows` probes the filter itself, so a mode added to
/// the allow-list without a reset here fails it.
pub const RESET_SEQUENCE: &[u8] =
    b"\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?2004l\x1b[?1l\
\x1b[?7h\x1b[?12l\x1b[0 q\x1b[4l\x1b>\x1b(B\x1b)B\x1b7\x1b[r\x1b8";
// ANCHOR_END: reset_sequence

/// How long the last-resort paths wait for a stalled terminal before giving up on a write.
const EMERGENCY_WRITE: std::time::Duration = std::time::Duration::from_millis(100);

/// The escape key (Ctrl-A).
pub const CTRL_A: u8 = 0x01;

const HELP: &str = "macvmm: escapes: Ctrl-A x quit, Ctrl-A t trace ring, Ctrl-A s stats, \
                    Ctrl-A Ctrl-A send Ctrl-A";

/// The termios to put back, shared with the panic hook and the signal path. `None` when the
/// terminal was not changed or is already restored.
static SAVED: Mutex<Option<hvf::host::Termios>> = Mutex::new(None);

fn saved() -> std::sync::MutexGuard<'static, Option<hvf::host::Termios>> {
    SAVED.lock().unwrap_or_else(|p| p.into_inner())
}

/// Put the saved termios back and flush unread input. Idempotent; true if it restored.
fn restore_saved() -> bool {
    let Some(t) = saved().take() else {
        return false;
    };
    let _ = t.apply(hvf::host::STDIN_FILENO);
    let _ = hvf::host::tcflush_input(hvf::host::STDIN_FILENO);
    true
}

/// The terminal state of one `macvmm run`.
#[derive(Debug)]
pub struct Terminal {
    stdin_tty: bool,
    stdout_tty: bool,
    raw: bool,
}

impl Terminal {
    // ANCHOR: term_raw_mode
    /// Enter raw mode if `interactive` (the serial sink is `stdio`, so stdin is bound to the
    /// guest) and stdin is a TTY (PROC-1). Installs the panic hook first, so the terminal is
    /// never raw without a way back.
    pub fn setup(interactive: bool) -> Terminal {
        install_panic_hook();
        let stdin_tty = hvf::host::isatty(hvf::host::STDIN_FILENO);
        let stdout_tty = hvf::host::isatty(hvf::host::STDOUT_FILENO);
        let mut raw = false;
        if interactive
            && stdin_tty
            && let Ok(t) = hvf::host::Termios::get(hvf::host::STDIN_FILENO)
        {
            let mut slot = saved();
            if t.raw_variant().apply(hvf::host::STDIN_FILENO).is_ok() {
                *slot = Some(t);
                raw = true;
            }
        }
        Terminal {
            stdin_tty,
            stdout_tty,
            raw,
        }
    }
    // ANCHOR_END: term_raw_mode

    /// Is stdout a terminal (TTY-6 and TTY-7 apply)?
    pub fn stdout_is_tty(&self) -> bool {
        self.stdout_tty
    }

    /// Was raw mode entered?
    pub fn is_raw(&self) -> bool {
        self.raw
    }

    /// TTY-6 steps 2 and 3: restore termios, then discard input nobody read. Call after the
    /// sinks were closed (step 1). Idempotent.
    pub fn restore(&mut self) {
        if !restore_saved() && self.stdin_tty {
            let _ = hvf::host::tcflush_input(hvf::host::STDIN_FILENO);
        }
        self.raw = false;
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.restore();
    }
}

/// The last-resort restore for the panic hook and a second quit signal: termios back, input
/// flushed, and the mode reset written to stderr if it is a TTY. It takes **no lock another
/// thread may hold while blocked**: not std's stderr lock (a thread may be stuck in `write(2)`
/// inside it) and not stdout's (a sink writer may be). The reset goes out with a bounded,
/// non-blocking raw write (`hvf::host::write_bounded`), so a stalled terminal costs at most
/// [`EMERGENCY_WRITE`] and never a hang.
pub fn emergency_restore() {
    restore_saved();
    if hvf::host::isatty(hvf::host::STDERR_FILENO) {
        let mut b = RESET_SEQUENCE.to_vec();
        b.push(b'\n');
        let _ = hvf::host::write_bounded(hvf::host::STDERR_FILENO, &b, EMERGENCY_WRITE);
    }
}

/// Write `line` and a newline to stderr without blocking and without std's stderr lock (the
/// second-signal path, where any lock may be held by a thread stuck in `write(2)`).
pub fn emergency_line(line: &str) {
    let mut b = line.as_bytes().to_vec();
    b.push(b'\n');
    let _ = hvf::host::write_bounded(hvf::host::STDERR_FILENO, &b, EMERGENCY_WRITE);
}

/// TTY-6 step 1 when the stdio sink could not write the reset (it turned `none` after a write
/// error, or its writer was abandoned): write [`RESET_SEQUENCE`] ourselves with a bounded,
/// non-blocking write, to stdout if it is a TTY, else to stderr if that is one. Returns true if
/// the whole sequence went out.
pub fn write_reset_fallback() -> bool {
    [hvf::host::STDOUT_FILENO, hvf::host::STDERR_FILENO]
        .into_iter()
        .filter(|&fd| hvf::host::isatty(fd))
        .any(|fd| {
            hvf::host::write_bounded(fd, RESET_SEQUENCE, EMERGENCY_WRITE) == RESET_SEQUENCE.len()
        })
}

/// Install (once) a panic hook that restores the terminal before the default hook prints the
/// panic (PROC-1, TTY-6).
pub fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            emergency_restore();
            previous(info);
        }));
    });
}

/// A host command typed after Ctrl-A.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Quit,
    DumpRing,
    Stats,
    Help,
}

// ANCHOR: stdin_escape
/// The Ctrl-A escape state machine (TTY-9): pure, so it is unit-tested; state survives across
/// `feed` calls, so an escape split across two reads still works.
#[derive(Debug, Default)]
pub struct EscapeParser {
    after_ctrl_a: bool,
}

impl EscapeParser {
    /// Split `input` into guest-bound bytes (appended to `to_guest`) and host commands
    /// (appended to `cmds`), in order. After a `Quit`, the rest of `input` is discarded.
    pub fn feed(&mut self, input: &[u8], to_guest: &mut Vec<u8>, cmds: &mut Vec<Command>) {
        for &b in input {
            if !self.after_ctrl_a {
                if b == CTRL_A {
                    self.after_ctrl_a = true;
                } else {
                    to_guest.push(b);
                }
                continue;
            }
            self.after_ctrl_a = false;
            match b {
                b'x' | b'X' => {
                    cmds.push(Command::Quit);
                    return;
                }
                b't' | b'T' => cmds.push(Command::DumpRing),
                b's' | b'S' => cmds.push(Command::Stats),
                b'h' | b'H' | b'?' => cmds.push(Command::Help),
                CTRL_A => to_guest.push(CTRL_A),
                _ => {} // unknown escape: both bytes are discarded
            }
        }
    }
}
// ANCHOR_END: stdin_escape

/// Run the stdin thread (detached; it ends at EOF, on a read error, or after Ctrl-A x).
pub fn spawn_stdin(host: Arc<HostIo>) -> io::Result<()> {
    std::thread::Builder::new()
        .name("stdin".into())
        .spawn(move || stdin_loop(&host))
        .map(|_| ())
}

fn stdin_loop(host: &HostIo) {
    let mut stdin = io::stdin().lock();
    let mut buf = [0u8; 4096];
    let mut parser = EscapeParser::default();
    let mut to_guest = Vec::with_capacity(buf.len());
    let mut cmds = Vec::new();
    loop {
        let n = match stdin.read(&mut buf) {
            Ok(0) => return, // EOF: the guest just sees no more input
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        };
        to_guest.clear();
        parser.feed(buf.get(..n).unwrap_or(&[]), &mut to_guest, &mut cmds);
        if !to_guest.is_empty() {
            host.serial_input.push(&to_guest); // never blocks (TTY-10)
        }
        for cmd in cmds.drain(..) {
            match cmd {
                Command::Quit => {
                    host.request_quit();
                    return;
                }
                Command::DumpRing => err(host.hostctl.dump_rings().trim_end()),
                Command::Stats => err(&format!("macvmm: stats: {}", host.io_stats())),
                Command::Help => err(HELP),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vmm::backend::ansi::{self as vm, AnsiFilter, FilterPolicy};

    fn feed(p: &mut EscapeParser, input: &[u8]) -> (Vec<u8>, Vec<Command>) {
        let (mut g, mut c) = (Vec::new(), Vec::new());
        p.feed(input, &mut g, &mut c);
        (g, c)
    }

    #[test]
    fn escapes_are_handled_before_the_guest_sees_them() {
        let mut p = EscapeParser::default();
        assert_eq!(feed(&mut p, b"ls\r"), (b"ls\r".to_vec(), vec![]));
        assert_eq!(
            feed(&mut p, b"a\x01tb\x01sc\x01?"),
            (
                b"abc".to_vec(),
                vec![Command::DumpRing, Command::Stats, Command::Help]
            )
        );
        assert_eq!(feed(&mut p, b"\x01\x01"), (vec![CTRL_A], vec![]));
        assert_eq!(feed(&mut p, b"\x01zq"), (b"q".to_vec(), vec![]), "unknown");
        // Split across reads.
        assert_eq!(feed(&mut p, b"y\x01"), (b"y".to_vec(), vec![]));
        assert_eq!(feed(&mut p, b"x after"), (vec![], vec![Command::Quit]));
        // Ctrl-C is just a byte for the guest (raw mode).
        let mut p = EscapeParser::default();
        assert_eq!(feed(&mut p, b"\x03"), (vec![0x03], vec![]));
    }

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// Does the `safe` filter pass `seq` unchanged?
    fn passes(seq: &[u8]) -> bool {
        let mut f = AnsiFilter::new(FilterPolicy::Safe);
        let mut out = Vec::new();
        f.push(seq, &mut out);
        out == seq
    }

    /// TTY-6: every mode-setting sequence the `safe` filter lets a guest send has its reset in
    /// [`RESET_SEQUENCE`]. The expectations come from probing the filter, not from a copy of
    /// its tables, so widening the allow-list without extending the reset fails here.
    #[test]
    fn reset_sequence_covers_every_mode_safe_allows() {
        let has = |s: &str| find(RESET_SEQUENCE, s.as_bytes()).is_some();
        // The default state of each private mode: true = set (`h`) by default.
        // DECAWM (7) and DECTCEM (25, cursor visible) are on by default.
        let default_set = |n: u32| matches!(n, 7 | 25);
        // `CSI ? 1048 h|l` saves/restores the cursor: an action, not a mode.
        let actions = [1048u32];
        // Private and public modes: every 1-5 digit number, both directions.
        let mut private = Vec::new();
        for n in 0..=99_999u32 {
            let (h, l) = (format!("\x1b[?{n}h"), format!("\x1b[?{n}l"));
            if passes(h.as_bytes()) || passes(l.as_bytes()) {
                private.push(n);
                if !actions.contains(&n) {
                    let want = if default_set(n) { &h } else { &l };
                    assert!(has(want), "private mode {n}: no {want:?} in the reset");
                }
            }
            let (h, l) = (format!("\x1b[{n}h"), format!("\x1b[{n}l"));
            if passes(h.as_bytes()) || passes(l.as_bytes()) {
                assert!(has(&l), "public mode {n}: no {l:?} in the reset");
            }
        }
        assert_eq!(
            private,
            vm::PRIVATE_MODES,
            "the probe agrees with the table"
        );
        // CSI finals with no intermediate: every one the filter passes is either an action
        // (cursor movement, erase, edit, scroll) or has its reset.
        let actions = b"ABCDEFGHfd`JKX@PLMST";
        for fin in 0x40u8..=0x7e {
            let seq = [b"\x1b[1".as_slice(), &[fin]].concat();
            if !passes(&seq) || actions.contains(&fin) || matches!(fin, b'h' | b'l') {
                continue;
            }
            match fin {
                b'm' => assert!(has("\x1b[0m")),
                b'r' => assert!(has("\x1b7\x1b[r\x1b8")),
                _ => panic!(
                    "CSI final {:?} is allowed but neither an action nor reset",
                    fin as char
                ),
            }
        }
        // CSI with a SP intermediate: DECSCUSR.
        for fin in 0x40u8..=0x7e {
            let seq = [b"\x1b[2 ".as_slice(), &[fin]].concat();
            if passes(&seq) {
                assert_eq!(fin, b'q', "CSI SP {:?} is allowed: reset it", fin as char);
                assert!(has("\x1b[0 q"));
            }
        }
        // Two- and three-byte escapes.
        for b in 0x20u8..=0x7e {
            if passes(&[0x1b, b]) {
                match b {
                    b'7' | b'8' | b'M' => {} // save, restore, reverse index: actions
                    b'=' | b'>' => assert!(has("\x1b>")),
                    _ => panic!("ESC {:?} is allowed but not classified", b as char),
                }
            }
            for intro in *b"()" {
                if passes(&[0x1b, intro, b]) {
                    assert!(
                        has(std::str::from_utf8(&[0x1b, intro, b'B']).unwrap()),
                        "ESC {} {:?}: no ASCII reset",
                        intro as char,
                        b as char
                    );
                }
            }
        }
    }

    /// TTY-7: the cursor stays where it is. `CSI r` (which homes the cursor) sits between
    /// DECSC and DECRC, DECRC is the last thing, and DECSC comes after the SGR and charset
    /// resets so it saves the reset state. The reset itself passes the `safe` filter.
    #[test]
    fn reset_sequence_keeps_the_cursor() {
        let at = |s: &[u8]| find(RESET_SEQUENCE, s).unwrap();
        assert!(RESET_SEQUENCE.ends_with(b"\x1b7\x1b[r\x1b8"));
        assert_eq!(
            RESET_SEQUENCE.windows(3).filter(|w| w == b"\x1b[r").count(),
            1
        );
        let save = at(b"\x1b7");
        assert!(at(b"\x1b[0m") < save && at(b"\x1b(B") < save && at(b"\x1b)B") < save);
        assert!(passes(RESET_SEQUENCE));
    }

    /// PROC-1: under a test runner stdin is not a TTY, so nothing becomes raw.
    #[test]
    fn no_raw_mode_without_a_tty() {
        if hvf::host::isatty(hvf::host::STDIN_FILENO) {
            return; // run by hand from a terminal: nothing to assert
        }
        let mut t = Terminal::setup(true);
        assert!(!t.is_raw());
        t.restore();
    }
}
