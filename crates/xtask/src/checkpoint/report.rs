//! What the checkpoint harness prints, in the exact shape of CURRICULUM §3.3.
//!
//! **Why one module for output:** the learner reads these lines to decide whether they are done,
//! and lessons quote the last line in their `expect:` front matter, so the format is a contract
//! (`[PASS] L1 contract …`, `[PASS] L2 run …`, `[INFO] L3 journal …`, `CHECKPOINT NN PASS`).
//! Keeping every format string here keeps that contract in one place.
//!
//! Output goes to an [`Out`]: normally stdout, but `bughunt` (PLAN M27) collects the lines so it
//! can show the learner only the failing symptom and never the planted patch's name.
//!
//! **Failure detail** (PLAN M27 design notes): on a failed run the harness prints the first
//! mismatching marker, the last 20 trace records and the register dump `macvmm` printed (ch06
//! and ch07 teach how to read it). The dump is found in stderr by shape, never parsed further:
//! it is output of the code under test.
#![deny(clippy::arithmetic_side_effects, clippy::indexing_slicing)]

use std::io::Write;

/// How many trailing trace records a failure shows.
pub const TRACE_TAIL: usize = 20;
/// How many stderr lines a failure shows when no register dump is found.
pub const STDERR_TAIL: usize = 20;
/// The longest single line echoed back from the code under test (longer lines are cut).
pub const ECHO_LINE_MAX: usize = 400;

/// Where report lines go.
#[derive(Debug, Default)]
pub struct Out {
    /// `Some`: collect instead of printing.
    pub buf: Option<Vec<String>>,
}

impl Out {
    /// Print to stdout.
    pub fn stdout() -> Out {
        Out { buf: None }
    }

    /// Collect lines (for `bughunt`).
    pub fn collect() -> Out {
        Out {
            buf: Some(Vec::new()),
        }
    }

    /// One line of the report (several if `s` has newlines). Every line goes through
    /// [`escape_controls`] here, centrally: a detail line may quote the code under test (a
    /// compiler or test-binary tail, a test name, a marker that did not match), and no caller
    /// has to remember to filter it (threat model S25: every echoed line sanitized).
    pub fn line(&mut self, s: &str) {
        let lines = s.lines().map(escape_controls);
        match &mut self.buf {
            Some(b) => b.extend(lines),
            None => {
                let mut o = std::io::stdout().lock();
                for l in lines {
                    let _ = writeln!(o, "{l}");
                }
            }
        }
    }
}

/// Print to stderr (usage errors, setup problems), control characters made visible.
pub fn err(s: &str) {
    let mut e = std::io::stderr().lock();
    for l in s.lines() {
        let _ = writeln!(e, "{}", escape_controls(l));
    }
}

/// Make control characters other than tab visible (`\u{1b}`), without cutting the line. This
/// is the floor applied to every report line; [`sanitize`] also cuts long echoed lines.
pub fn escape_controls(line: &str) -> String {
    let mut s = String::with_capacity(line.len());
    for c in line.chars() {
        if c == '\t' || !c.is_control() {
            s.push(c);
        } else {
            s.extend(c.escape_default());
        }
    }
    s
}

/// The status column of a level line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail,
    Info,
}

impl Status {
    pub fn tag(self) -> &'static str {
        match self {
            Status::Pass => "[PASS]",
            Status::Fail => "[FAIL]",
            Status::Info => "[INFO]",
        }
    }
}

/// `[PASS] L1 contract  <detail>`: the level label is padded to 12 columns, so the detail
/// starts in the same column for `L1 contract`, `L2 run` and `L3 journal`, as in §3.3.
pub fn level_line(status: Status, level: &str, detail: &str) -> String {
    format!("{} {level:<12} {detail}", status.tag())
}

/// The verdict line: `CHECKPOINT NN PASS`, `CHECKPOINT NN PASS (borrowed: a, b)` or
/// `CHECKPOINT NN FAIL`.
pub fn verdict(id: &str, pass: bool, borrowed: &[String]) -> String {
    if !pass {
        return format!("CHECKPOINT {id} FAIL");
    }
    if borrowed.is_empty() {
        format!("CHECKPOINT {id} PASS")
    } else {
        format!("CHECKPOINT {id} PASS (borrowed: {})", borrowed.join(", "))
    }
}

/// The summary after `all`: `CHECKPOINTS: 13/13 PASS` (or `… FAIL`).
pub fn summary(passed: usize, total: usize) -> String {
    let word = if passed == total { "PASS" } else { "FAIL" };
    format!("CHECKPOINTS: {passed}/{total} {word}")
}

/// Cut a line from the code under test to [`ECHO_LINE_MAX`] bytes (on a char boundary) and
/// make control characters visible, so a hostile guest cannot drive the learner's terminal
/// through the harness's report (the VMM's own filter is what is being tested; the harness
/// does not rely on it).
pub fn sanitize(line: &str) -> String {
    let mut s = String::with_capacity(line.len().min(ECHO_LINE_MAX));
    for c in line.chars() {
        if s.len() >= ECHO_LINE_MAX {
            s.push_str(" …");
            break;
        }
        if c == '\t' || !c.is_control() {
            s.push(c);
        } else {
            s.extend(c.escape_default());
        }
    }
    s
}

/// The register dump `macvmm` printed on stderr, if any: the block around the first `  x0=`
/// line (from its unindented title line, while lines are indented), plus a following
/// `last exits:` block.
pub fn register_dump(stderr: &str) -> Vec<String> {
    let lines: Vec<&str> = stderr.lines().collect();
    let Some(x0) = lines
        .iter()
        .position(|l| l.trim_start().starts_with("x0=0x"))
    else {
        return Vec::new();
    };
    // Back up over the indented header lines to the unindented title (`vcpu0: …`).
    let mut start = x0;
    while start > 0
        && lines
            .get(start.saturating_sub(1))
            .is_some_and(|l| l.starts_with("  "))
    {
        start = start.saturating_sub(1);
    }
    start = start.saturating_sub(1);
    let mut out = Vec::new();
    let mut in_exits = false;
    for (i, l) in lines.iter().enumerate().skip(start) {
        let indented = l.starts_with("  ");
        if i == start || indented {
            out.push(sanitize(l));
        } else if l.starts_with("last exits:") && !in_exits {
            in_exits = true;
            out.push(sanitize(l));
        } else {
            break;
        }
        if out.len() >= 80 {
            break;
        }
    }
    out
}

/// The last [`STDERR_TAIL`] lines of stderr.
pub fn stderr_tail(stderr: &str) -> Vec<String> {
    let lines: Vec<&str> = stderr.lines().collect();
    let from = lines.len().saturating_sub(STDERR_TAIL);
    lines
        .get(from..)
        .unwrap_or(&[])
        .iter()
        .map(|l| sanitize(l))
        .collect()
}

/// The last [`TRACE_TAIL`] non-empty lines of a trace.
pub fn trace_tail(trace: &str) -> Vec<String> {
    let lines: Vec<&str> = trace.lines().filter(|l| !l.trim().is_empty()).collect();
    let from = lines.len().saturating_sub(TRACE_TAIL);
    lines
        .get(from..)
        .unwrap_or(&[])
        .iter()
        .map(|l| sanitize(l))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        assert_eq!(
            level_line(Status::Pass, "L1 contract", "esr (40 tests)"),
            "[PASS] L1 contract  esr (40 tests)"
        );
        assert_eq!(
            level_line(Status::Pass, "L2 run", "x"),
            "[PASS] L2 run       x"
        );
        assert_eq!(verdict("07", true, &[]), "CHECKPOINT 07 PASS");
        assert_eq!(
            verdict("04", true, &["memory".into()]),
            "CHECKPOINT 04 PASS (borrowed: memory)"
        );
        assert_eq!(
            verdict("04", false, &["memory".into()]),
            "CHECKPOINT 04 FAIL"
        );
        assert_eq!(summary(13, 13), "CHECKPOINTS: 13/13 PASS");
        assert_eq!(summary(12, 13), "CHECKPOINTS: 12/13 FAIL");
    }

    #[test]
    fn sanitize_escapes_controls() {
        assert_eq!(sanitize("a\u{1b}]0;x\u{7}b"), "a\\u{1b}]0;x\\u{7}b");
        assert_eq!(escape_controls("a\u{1b}[2Jb\tc"), "a\\u{1b}[2Jb\tc");
        let mut o = Out::collect();
        o.line("x\u{1b}]0;t\u{7}\ny\u{9b}31m");
        assert_eq!(o.buf.unwrap(), ["x\\u{1b}]0;t\\u{7}", "y\\u{9b}31m"]);
        assert!(sanitize(&"x".repeat(1000)).len() < ECHO_LINE_MAX + 8);
    }

    #[test]
    fn finds_the_dump() {
        let e = "macvmm: guest fatal: instruction abort\nvcpu0: instruction abort (EC 0x20)\n  esr=0x82000006\n  x0=0x0 x1=0x1\n  pc=0x200\nlast exits: 1 (oldest first)\n  {\"t_ns\":1}\nmacvmm: exit 3\n";
        let d = register_dump(e);
        assert_eq!(
            d.first().map(String::as_str),
            Some("vcpu0: instruction abort (EC 0x20)")
        );
        assert!(d.iter().any(|l| l.starts_with("last exits:")));
        assert!(!d.iter().any(|l| l.contains("exit 3")));
        assert!(register_dump("nothing here").is_empty());
    }
}
