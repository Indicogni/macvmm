//! The signal thread: SIGINT, SIGTERM and SIGHUP quit the VM (exit code 130); SIGUSR1 prints
//! the exit rings (architecture §14.1; threat model PROC-2, LOG-6).
//!
//! **Why a thread.** A signal handler may only do async-signal-safe work, so the handler in
//! `hvf::host::SignalPipe` writes the signal number into a self-pipe and returns. This thread
//! reads the pipe and does the real work: `HostIo::request_quit` (which stops the running boot
//! through its `VmControl` and wakes any producer waiting on a full sink), or a ring dump.
//!
//! **A second quit signal exits at once.** If the VM does not stop after the first SIGINT /
//! SIGTERM / SIGHUP (a VMM bug, or a writer stuck on a dead terminal), the second one restores
//! the terminal (`term::emergency_restore`) and ends the process with exit code 130, so the
//! user is never left with a raw terminal and an unkillable VM short of SIGKILL.
//!
//! That path takes **no lock another thread might hold while blocked**. Any thread may be
//! stuck in `write(2)` on a stalled stdout or stderr (`2>&1 | less`), holding std's stdout or
//! stderr lock, or a device or sink mutex. So it restores termios (which needs neither), writes
//! the reset and its message with bounded raw writes (`term::emergency_line`, never std's
//! stderr handle), and leaves with `hvf::host::exit_now` (`_exit(2)`: no `atexit` handlers, no
//! stdio cleanup).
#![forbid(unsafe_code)]

use crate::{err, term};
use hvf::host::{SIGHUP, SIGINT, SIGTERM, SIGUSR1, SignalPipe};
use std::sync::Arc;
use vmm::HostIo;

/// The exit code of a user quit (architecture §13.2).
const USER_QUIT: i32 = 130;

// ANCHOR: signal_thread
/// Route the signals to the self-pipe and start the (detached) thread that serves it.
pub fn spawn(host: Arc<HostIo>) -> std::io::Result<()> {
    let pipe = SignalPipe::install(&[SIGINT, SIGTERM, SIGHUP, SIGUSR1])?;
    std::thread::Builder::new()
        .name("signal".into())
        .spawn(move || {
            loop {
                match pipe.wait() {
                    Ok(SIGUSR1) => err(host.hostctl.dump_rings().trim_end()),
                    Ok(_) => {
                        if !host.request_quit() {
                            term::emergency_restore();
                            term::emergency_line("macvmm: user quit (second signal: exiting now)");
                            hvf::host::exit_now(USER_QUIT);
                        }
                    }
                    Err(_) => return,
                }
            }
        })
        .map(|_| ())
}
// ANCHOR_END: signal_thread
