//! `tty-hygiene`: a guest that tries to leave the user's terminal in a mess and to make it
//! answer (PLAN M6 security test TEST-8; threat model TTY-1, TTY-3, TTY-6).
//!
//! Through the PL011 it:
//! - switches to the alternate screen (`CSI ? 1049 h`), hides the cursor (`CSI ? 25 l`) and
//!   turns on bracketed paste (`CSI ? 2004 h`): allowed by the `safe` filter, so they reach
//!   the terminal, and macvmm must undo them on exit (TTY-6);
//! - asks for the cursor position (DSR, `CSI 6 n`), which makes a terminal *type* a reply
//!   into stdin: the filter must drop it (TTY-3);
//! - writes the clipboard with OSC 52: the filter must drop the whole string;
//!
//! then prints `tty-hygiene: done` and calls DEBUG_EXIT(0). The e2e test runs it under
//! `script(1)` (a real pseudo-terminal) and checks the captured stream: no `ESC [ 6 n`, no
//! `ESC ]`, the reset sequence after the guest's last byte, and `stty -g` unchanged.
#![no_std]
#![no_main]

use guest::{hvc, print, println, uart};

guest::entry!(main);

fn main(_x0: u64) {
    uart::enable_console();
    println!("tty-hygiene: start");
    print!("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    print!("\x1b[6n");
    print!("\x1b]52;c;bWFjdm1tLWNsaXBib2FyZA==\x07");
    println!("tty-hygiene: done");
    hvc::debug_exit(0)
}
