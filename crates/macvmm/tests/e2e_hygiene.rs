//! E2E suite `hygiene` (PLAN M6 security tests, threat model §9.2: TEST-8, SINK-1, TTY-10).
//!
//! ```text
//! scripts/test-e2e.sh hygiene
//! # = cargo test -p macvmm --features hvf-tests --test e2e_hygiene -- --test-threads=1
//! ```
//!
//! - `tty_hygiene` (TEST-8, TTY-1/3/6): a guest that leaves the terminal in the alternate
//!   screen with the cursor hidden and bracketed paste on, asks it for the cursor position and
//!   writes the clipboard, run in a real pseudo-terminal: no query and no OSC reaches the
//!   terminal, the reset sequence follows the guest's last byte, `stty -g` is unchanged;
//! - `sink_backpressure` (SINK-1, flaw F20): a flooding guest with stdout connected to a pipe
//!   nobody reads still stops on SIGTERM within a second (exit 130);
//! - `sink_backpressure_shared_stderr` (SINK-1, M6 review): the same with stdout **and**
//!   stderr on one pipe nobody reads (`macvmm run … 2>&1 | less`), so the guest-triggered
//!   "not keeping up" warning itself meets a stalled stderr; SIGTERM still ends it, exit 130,
//!   within a second;
//! - `stdin_escape_when_full` (TTY-10, flaw F21): a guest that never reads its UART, 8 KiB of
//!   input, then Ctrl-A x: exit 130 within a second, and `--stats` shows the dropped input.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::{Duration, Instant};
use support::{Running, expect_code, guest, macvmm, run_in_pty, scratch, sh_quote};

const T10: Duration = Duration::from_secs(10);
/// The TTY-6 reset (the same bytes as `macvmm/src/term.rs` `RESET_SEQUENCE`).
const RESET: &[u8] = b"\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1047l\x1b[?47l\x1b[?2004l\x1b[?1l\
\x1b[?7h\x1b[?12l\x1b[0 q\x1b[4l\x1b>\x1b(B\x1b)B\x1b7\x1b[r\x1b8";

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[test]
fn tty_hygiene() {
    let shell = format!(
        "stty -g; {} run --mem 64M --kernel {} --timeout 10; echo \"rc=$?\"; stty -g",
        sh_quote(&macvmm().to_string_lossy()),
        sh_quote(&guest("tty-hygiene"))
    );
    let o = run_in_pty(&shell, &[], T10);
    assert!(!o.killed, "{}", o.dump());
    let b = &o.bytes;
    let text = o.text();
    assert!(text.contains("rc=0"), "{}", o.dump());
    // The guest's allowed mode changes did reach the terminal (so the reset matters)...
    assert!(find(b, b"\x1b[?1049h").is_some(), "{}", o.dump());
    assert!(find(b, b"\x1b[?25l").is_some(), "{}", o.dump());
    assert!(find(b, b"\x1b[?2004h").is_some(), "{}", o.dump());
    // ...but no query and no OSC did (TTY-3).
    assert!(find(b, b"\x1b[6n").is_none(), "DSR leaked\n{}", o.dump());
    assert!(find(b, b"\x1b]").is_none(), "OSC leaked\n{}", o.dump());
    assert!(
        find(b, b"bWFjdm1t").is_none(),
        "OSC 52 payload leaked\n{}",
        o.dump()
    );
    // The reset follows the guest's last byte, and nothing after it is an escape (TTY-6):
    // only macvmm's own verdict line (TTY-7) and the shell's output.
    let done = find(b, b"tty-hygiene: done").expect("guest output");
    let reset = find(b, RESET).unwrap_or_else(|| panic!("no reset sequence\n{}", o.dump()));
    assert!(
        reset > done,
        "reset before the guest's last byte\n{}",
        o.dump()
    );
    let tail = &b[reset + RESET.len()..];
    assert!(
        !tail.contains(&0x1b),
        "escape after the reset\n{}",
        o.dump()
    );
    assert!(
        String::from_utf8_lossy(tail).contains("macvmm: guest exit code 0"),
        "TTY-7 verdict line\n{}",
        o.dump()
    );
    // The terminal settings are restored exactly (TTY-6 step 2).
    let stty: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| l.starts_with("gfmt1:"))
        .collect();
    assert_eq!(stty.len(), 2, "{}", o.dump());
    assert_eq!(stty[0], stty[1], "stty -g changed\n{}", o.dump());
}

#[test]
fn sink_backpressure() {
    let mut r = Running::spawn(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("flood"),
            "--timeout",
            "20",
        ],
        false, // stdout: a pipe nobody reads
    );
    std::thread::sleep(Duration::from_secs(1));
    assert!(r.child.try_wait().unwrap().is_none(), "flood exited early");
    let sent = Instant::now();
    r.signal("TERM");
    let (o, exited) = r.finish(T10);
    expect_code("sink_backpressure", &o, 130);
    let took = exited - sent;
    assert!(
        took < Duration::from_secs(1),
        "exit took {took:?} after SIGTERM\n{}",
        o.dump()
    );
    assert!(o.stderr.contains("user quit"), "{}", o.dump());
    assert!(o.stderr.contains("not keeping up"), "{}", o.dump());
}

#[test]
fn sink_backpressure_shared_stderr() {
    use std::io::Read as _;
    use std::process::{Command, Stdio};
    let (mut reader, writer) = std::io::pipe().unwrap();
    let mut child = Command::new(macvmm())
        .args([
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("flood"),
            "--timeout",
            "20",
        ])
        .env_remove("MACVMM_LOG")
        .stdin(Stdio::null())
        .stdout(writer.try_clone().unwrap())
        .stderr(writer)
        .spawn()
        .expect("spawn macvmm");
    // The pipe (held open by `reader`) fills within milliseconds and is never read while the
    // VM runs: the sink drops, and its warning goes to the same stalled pipe.
    std::thread::sleep(Duration::from_secs(1));
    assert!(child.try_wait().unwrap().is_none(), "flood exited early");
    let sent = Instant::now();
    let st = std::process::Command::new("/bin/kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(st.success());
    let deadline = sent + T10;
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break Some(st);
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    let took = sent.elapsed();
    let mut seen = Vec::new();
    reader.read_to_end(&mut seen).unwrap();
    let tail = String::from_utf8_lossy(&seen[seen.len().saturating_sub(300)..]).into_owned();
    let status = status.unwrap_or_else(|| panic!("hung after SIGTERM; pipe tail {tail:?}"));
    assert_eq!(status.code(), Some(130), "pipe tail {tail:?}");
    assert!(
        took < Duration::from_secs(1),
        "exit took {took:?} after SIGTERM; pipe tail {tail:?}"
    );
}

#[test]
fn stdin_escape_when_full() {
    let dir = scratch("stdin_escape_when_full");
    let spin = dir.join("spin.bin");
    std::fs::write(&spin, [0x00, 0x00, 0x00, 0x14]).unwrap(); // `b .`: never reads the UART
    let raw = format!("{}@0x40080000", spin.display());
    let mut r = Running::spawn(
        &[
            "run",
            "--mem",
            "64M",
            "--raw",
            &raw,
            "--stats",
            "--timeout",
            "10",
        ],
        true,
    );
    std::thread::sleep(Duration::from_millis(300));
    r.send(&[b'a'; 8192]);
    std::thread::sleep(Duration::from_millis(200));
    let sent = Instant::now();
    r.send(b"\x01x");
    let (o, exited) = r.finish(T10);
    expect_code("stdin_escape_when_full", &o, 130);
    let took = exited - sent;
    assert!(
        took < Duration::from_secs(1),
        "exit took {took:?} after Ctrl-A x\n{}",
        o.dump()
    );
    assert!(o.stderr.contains("user quit"), "{}", o.dump());
    let dropped: u64 = o
        .stderr
        .split("serial_input_dropped=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no stats line\n{}", o.dump()));
    assert!(dropped > 0, "{}", o.dump());
    support::check_markers(
        "[stderr] stats:*serial_input_dropped=*",
        &o.stdout,
        &o.stderr,
    )
    .unwrap_or_else(|e| panic!("{e}\n{}", o.dump()));
    let _ = std::fs::remove_dir_all(&dir);
}
