//! `hostile-tty`: TEST-7 phase 6, terminal attack strings on the PL011 (threat model §9.4,
//! TTY-1, TTY-3; PLAN M11).
//!
//! A guest owns the bytes it sends to the UART, and macvmm forwards them to the user's
//! terminal: a classic escape route. Terminal *queries* (DA, DSR, DECRQSS, `CSI 21 t`) make the
//! terminal type an answer back into stdin, which reaches the guest as input or, worse, a
//! shell after macvmm exits; OSC 52 writes the user's clipboard; OSC 8 forges links; DCS tmux
//! and APC (kitty graphics) talk to the multiplexer or the terminal's extensions; C1 controls
//! (raw 0x9B/0x9D, or UTF-8 U+009B) are CSI/OSC introducers on terminals that honour 8-bit
//! controls. This guest writes every one of them, byte by byte, to the PL011 data register. The
//! `safe` AnsiFilter (`backend/ansi.rs`) must drop them all; the e2e test checks the bytes that
//! reached macvmm's stdout.
#![no_std]
#![no_main]

use guest::{println, uart};

guest::entry!(main);

/// The TTY-3 forbidden list (threat model §7.5 and the `ansi_filter.rs` classes).
const ATTACKS: &[(&str, &[u8])] = &[
    ("DA", b"\x1b[c"),
    ("DA2", b"\x1b[>c"),
    ("DSR", b"\x1b[6n"),
    ("DSR status", b"\x1b[5n"),
    ("CSI t report", b"\x1b[21t"),
    ("CSI t resize", b"\x1b[8;1;1t"),
    ("CSI i print", b"\x1b[5i"),
    ("OSC 0 title", b"\x1b]0;pwned\x07"),
    ("OSC 2 title", b"\x1b]2;pwned\x1b\\"),
    (
        "OSC 8 link",
        b"\x1b]8;;https://example.invalid/\x07link\x1b]8;;\x07",
    ),
    ("OSC 52 clipboard", b"\x1b]52;c;bWFjdm1tLXBvd25lZA==\x07"),
    ("OSC 1337", b"\x1b]1337;File=inline=1:AAAA\x07"),
    ("DCS DECRQSS", b"\x1bP$qm\x1b\\"),
    ("DCS tmux", b"\x1bPtmux;\x1b\x1b]52;c;AAAA\x07\x1b\\"),
    ("APC", b"\x1b_Ga=d;AAAA\x1b\\"),
    ("PM", b"\x1b^private\x1b\\"),
    ("SOS", b"\x1bXstring\x1b\\"),
    ("ENQ", b"\x05"),
    ("SO/SI", b"\x0e\x0f"),
    ("C1 CSI raw", b"\x9b6n"),
    ("C1 OSC raw", b"\x9d52;c;AAAA\x07"),
    ("C1 CSI UTF-8", b"\xc2\x9b6n"),
];

fn main(_x0: u64) {
    uart::enable_console();
    println!("hostile-tty: begin");
    for (_name, bytes) in ATTACKS {
        for &b in *bytes {
            uart::putc(b);
        }
    }
    uart::putc(b'\n');
    println!("hostile-tty: {} attack strings sent", ATTACKS.len());
    println!("hostile-tty: end");
}
