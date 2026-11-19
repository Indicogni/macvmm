//! E2E suite `serial` (PLAN M6 "Acceptance: on machine"): the PL011 and PL031 through a real
//! guest, the serial sink choices, and the ways a user stops a VM.
//!
//! ```text
//! scripts/test-e2e.sh serial
//! # = cargo test -p macvmm --features hvf-tests --test e2e_serial -- --test-threads=1
//! ```
//!
//! Every test asserts the process exit code (AS10). `user quit` and the `raw` warning are
//! printed by the VMM on stderr, which a guest cannot write.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;
use support::{
    Running, Step, expect, expect_code, guest, macvmm, run, run_in_pty, run_steps, scratch,
    sh_quote,
};

const T10: Duration = Duration::from_secs(10);

/// `uart-echo`: TX and RX through the PL011, then the date from the PL031.
#[test]
fn uart_echo() {
    let o = run_steps(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("uart-echo"),
            "--timeout",
            "10",
        ],
        &[
            Step::WaitFor("uart-echo: ready"),
            Step::Send(b"ping\n".to_vec()),
        ],
        T10,
    );
    expect_code("uart_echo", &o, 0);
    expect("uart-echo", &o);
    let year: u32 = o
        .stdout
        .split("uart-echo: rtc year=")
        .nth(1)
        .and_then(|s| s.lines().next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or_else(|| panic!("no year\n{}", o.dump()));
    assert!(
        year >= 2025,
        "the RTC follows the host clock: {year}\n{}",
        o.dump()
    );
}

/// `--serial file:F`: the guest's output lands in the file, not on stdout.
#[test]
fn serial_file() {
    let dir = scratch("serial_file");
    let f = dir.join("s.txt");
    let sink = format!("file:{}", f.display());
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--serial",
            &sink,
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("serial_file", &o, 0);
    let text = std::fs::read_to_string(&f).unwrap();
    assert!(text.contains("hello from guest"), "{text:?}\n{}", o.dump());
    assert!(!o.stdout.contains("hello from guest"), "{}", o.dump());
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// TTY-2: opting out of the filter is never silent.
#[test]
fn serial_raw_warns() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("hello"),
            "--serial",
            "stdio,raw",
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("serial_raw_warns", &o, 0);
    assert!(o.stdout.contains("hello from guest"), "{}", o.dump());
    assert!(
        o.stderr.contains("warning: --serial ...,raw"),
        "{}",
        o.dump()
    );
}

/// Ctrl-A x in a real terminal: exit 130, and the terminal settings are exactly what they were
/// (PROC-1, TTY-6).
#[test]
fn tty_escape() {
    let shell = format!(
        "stty -g; {} run --mem 64M --kernel {} --timeout 10; echo \"rc=$?\"; stty -g",
        sh_quote(&macvmm().to_string_lossy()),
        sh_quote(&guest("uart-echo"))
    );
    let o = run_in_pty(
        &shell,
        &[
            Step::WaitFor("uart-echo: ready"),
            Step::Sleep(100),
            Step::Send(b"\x01x".to_vec()),
        ],
        T10,
    );
    assert!(!o.killed, "{}", o.dump());
    let text = o.text();
    assert!(text.contains("rc=130"), "{}", o.dump());
    assert!(text.contains("macvmm: user quit"), "{}", o.dump());
    let stty: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| l.starts_with("gfmt1:"))
        .collect();
    assert_eq!(stty.len(), 2, "{}", o.dump());
    assert_eq!(stty[0], stty[1], "stty -g changed\n{}", o.dump());
}

/// SIGTERM after `ready`: the VMM says `user quit` and exits 130.
#[test]
fn sigterm() {
    let mut r = Running::spawn(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("uart-echo"),
            "--timeout",
            "10",
        ],
        true,
    );
    assert!(r.wait_for("uart-echo: ready", T10));
    r.signal("TERM");
    let (o, _) = r.finish(T10);
    expect_code("sigterm", &o, 130);
    assert!(o.stderr.contains("user quit"), "{}", o.dump());
}

/// SIGINT works the same (Ctrl-C in a cooked terminal; in raw mode Ctrl-C goes to the guest).
#[test]
fn sigint() {
    let mut r = Running::spawn(
        &[
            "run",
            "--mem",
            "64M",
            "--kernel",
            &guest("uart-echo"),
            "--timeout",
            "10",
        ],
        true,
    );
    assert!(r.wait_for("uart-echo: ready", T10));
    r.signal("USR1"); // LOG-6: the ring dump, the VM keeps running
    std::thread::sleep(Duration::from_millis(200));
    r.signal("INT");
    let (o, _) = r.finish(T10);
    expect_code("sigint", &o, 130);
    assert!(o.stderr.contains("vcpu0: last "), "ring dump\n{}", o.dump());
    assert!(o.stderr.contains(r#""action":"mmio""#), "{}", o.dump());
    assert!(o.stderr.contains("user quit"), "{}", o.dump());
}
