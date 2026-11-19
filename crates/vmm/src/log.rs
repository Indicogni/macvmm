//! Logging: `error!`, `warn!`, `info!`, `debug!`, `trace!`, and the rate-limited `guest_warn!`.
//!
//! **Why our own, not the `log` crate** (CLAUDE.md "Minimal dependencies"): we need five
//! levels, one line format and one guest-specific rule, which is about a hundred lines. The
//! format (architecture §16) is
//!
//! ```text
//! macvmm: <level>: [<thread>] <message>
//! ```
//!
//! where `<thread>` is the thread's name (`main`, `vcpu0`, `worker:blk0`, ...). The level comes
//! from `--log` or `MACVMM_LOG` (parsed by the CLI with [`Level::parse`]), default `warn`.
//!
//! **Guest-triggerable messages use `guest_warn!`** (threat model LOG-1). A guest decides how
//! often an unhandled MMIO access or an unknown SMCCC call happens, so a plain `warn!` there
//! would let it write to the host's terminal or log file as fast as it can trap: a disk- and
//! attention-filling denial of service. `guest_warn!` keeps a counter per call site
//! ([`RateLimit`]) and prints the first 10 messages, then every 1000th, saying how many it
//! suppressed in between.
//!
//! **Guest bytes are escaped** (LOG-2, TTY-8): callers format guest-supplied values with `{:?}`,
//! and [`emit`] additionally escapes every control character in the final message, so even a
//! mistaken `{}` cannot put an escape sequence on the host terminal.
//!
//! **Never `eprintln!`** (RUST-5): it panics when stderr is a closed pipe. Write errors are
//! ignored: a log line that cannot be written is not worth stopping the VM for.
//!
//! **Logging never blocks the caller (SINK-1, flaw F20 applied to stderr).** A warning can be
//! emitted on a vCPU thread while it holds a device mutex (a sink's "not keeping up" warning, a
//! PL011 `guest_warn!` for a bad offset, which the guest triggers at will). If that thread
//! called `write(2)` on a stderr whose reader stopped (`macvmm run … 2>&1 | less`), it would
//! block outside `hv_vcpu_run`, where `hv_vcpus_exit` cannot reach it, and no quit could ever
//! complete. So [`emit`] only appends the finished line to a bounded in-memory queue
//! ([`LOG_QUEUE_CAP`] = 64 KiB) and returns; one `log` writer thread, started on the first
//! line, is the only code that writes it to fd 2. A line that does not fit is dropped whole
//! (lines are never torn) and counted; the next line that fits is preceded by a note saying how
//! many were lost. The writer uses a raw `write(2)` ([`hvf::host::write_fd`]), not std's
//! stderr handle, so even a writer stuck in `write(2)` holds no lock any other thread needs.
//!
//! The CLI sends its own stderr lines through the same queue ([`line`]), so their order with
//! the log is kept, and calls [`flush`] once before the process exits: a bounded wait for the
//! writer to drain, after which anything still queued is abandoned with the process.

use std::collections::VecDeque;
use std::fmt::{self, Write as _};
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant};

/// Bytes of log lines waiting for the stderr writer thread (module docs).
pub const LOG_QUEUE_CAP: usize = 64 * 1024;
/// The most bytes the writer takes out of the queue per `write(2)` loop.
const LOG_WRITE_CHUNK: usize = 16 * 1024;

/// Log levels, most severe first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl Level {
    /// The lower-case name used in the line format and by `--log`.
    pub fn name(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }

    /// Parse a `--log` / `MACVMM_LOG` value. `off` is `Ok(None)`; unknown text is `Err(())`
    /// (the CLI turns that into exit code 2).
    #[allow(clippy::result_unit_err)]
    pub fn parse(s: &str) -> Result<Option<Level>, ()> {
        Ok(Some(match s {
            "off" | "none" => return Ok(None),
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            "info" => Level::Info,
            "debug" => Level::Debug,
            "trace" => Level::Trace,
            _ => return Err(()),
        }))
    }
}

/// 0 = off, otherwise the most verbose enabled `Level as u8`.
static MAX_LEVEL: AtomicU8 = AtomicU8::new(Level::Warn as u8);

/// Set the most verbose level that is printed; `None` turns logging off.
pub fn set_max_level(level: Option<Level>) {
    MAX_LEVEL.store(level.map_or(0, |l| l as u8), Ordering::Relaxed);
}

/// Whether messages at `level` are printed.
pub fn enabled(level: Level) -> bool {
    (level as u8) <= MAX_LEVEL.load(Ordering::Relaxed)
}

/// The messages a `guest_warn!` call site lets through: the first [`RateLimit::BURST`], then one
/// in every [`RateLimit::EVERY`]. One static per call site (the macro declares it).
#[derive(Debug)]
pub struct RateLimit {
    count: AtomicU64,
}

impl RateLimit {
    /// Messages printed before limiting starts.
    pub const BURST: u64 = 10;
    /// After the burst, every this-many-th message is printed.
    pub const EVERY: u64 = 1000;

    pub const fn new() -> RateLimit {
        RateLimit {
            count: AtomicU64::new(0),
        }
    }

    /// Count one message. `Some(suppressed)` if it should be printed, where `suppressed` is the
    /// number of messages dropped since the previous printed one.
    pub fn admit(&self) -> Option<u64> {
        // `fetch_add` wraps only after 2^64 messages, far beyond any run.
        let n = self.count.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        Self::decide(n)
    }

    /// The pure rule for the `n`-th message (1-based).
    pub fn decide(n: u64) -> Option<u64> {
        if n == 0 {
            return None;
        }
        if n <= Self::BURST {
            return Some(0);
        }
        if !n.is_multiple_of(Self::EVERY) {
            return None;
        }
        // The previously printed message: the last of the burst, or the previous multiple.
        let prev = if n == Self::EVERY {
            Self::BURST
        } else {
            n.saturating_sub(Self::EVERY)
        };
        Some(n.saturating_sub(prev).saturating_sub(1))
    }
}

impl Default for RateLimit {
    fn default() -> RateLimit {
        RateLimit::new()
    }
}

/// Append `msg` to `out`, escaping control characters (C0, DEL, C1) as `\u{..}`.
fn push_escaped(out: &mut String, msg: &str) {
    for c in msg.chars() {
        if c.is_control() {
            let _ = write!(out, "\\u{{{:x}}}", u32::from(c));
        } else {
            out.push(c);
        }
    }
}

/// Build one log line (without writing it).
pub fn format_line(level: Level, thread: &str, args: fmt::Arguments<'_>) -> String {
    let mut msg = String::new();
    let _ = msg.write_fmt(args);
    let mut line = String::with_capacity(msg.len().saturating_add(32));
    line.push_str("macvmm: ");
    line.push_str(level.name());
    line.push_str(": [");
    push_escaped(&mut line, thread);
    line.push_str("] ");
    push_escaped(&mut line, &msg);
    line.push('\n');
    line
}

/// The queue between every logging thread and the `log` writer thread (module docs).
struct LogState {
    buf: VecDeque<u8>,
    /// The writer has taken bytes out and is writing them.
    writing: bool,
    /// Lines dropped since the last drop note was queued, and in total.
    unreported: u64,
    dropped: u64,
}

static QUEUE: Mutex<LogState> = Mutex::new(LogState {
    buf: VecDeque::new(),
    writing: false,
    unreported: 0,
    dropped: 0,
});
/// The writer waits here for lines.
static DATA: Condvar = Condvar::new();
/// [`flush`] waits here for the writer to drain.
static IDLE: Condvar = Condvar::new();
static WRITER: Once = Once::new();
/// Set if the writer thread could not be started: lines then go out with a bounded write.
static NO_WRITER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn queue() -> MutexGuard<'static, LogState> {
    QUEUE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ANCHOR: log_queue
/// Append one finished line (it ends in `\n`) to the queue. Never blocks on stderr.
fn enqueue(line: &[u8]) {
    WRITER.call_once(|| {
        let spawned = std::thread::Builder::new()
            .name("log".into())
            .spawn(writer_loop);
        if spawned.is_err() {
            NO_WRITER.store(true, Ordering::SeqCst);
        }
    });
    if NO_WRITER.load(Ordering::SeqCst) {
        // No thread to wait on stderr for us: write what goes out without blocking.
        let _ = hvf::host::write_bounded(hvf::host::STDERR_FILENO, line, Duration::ZERO);
        return;
    }
    let mut st = queue();
    let room = LOG_QUEUE_CAP.saturating_sub(st.buf.len());
    let note = (st.unreported > 0).then(|| {
        format!(
            "macvmm: warn: [log] {} log lines were dropped: stderr is not keeping up\n",
            st.unreported
        )
    });
    let need = line
        .len()
        .saturating_add(note.as_ref().map_or(0, String::len));
    if need > room {
        st.unreported = st.unreported.saturating_add(1);
        st.dropped = st.dropped.saturating_add(1);
        return;
    }
    if let Some(n) = note {
        st.buf.extend(n.as_bytes());
        st.unreported = 0;
    }
    st.buf.extend(line);
    drop(st);
    DATA.notify_one();
}
// ANCHOR_END: log_queue

/// The `log` thread: the only code that writes log lines to fd 2 (module docs).
fn writer_loop() {
    let mut chunk = Vec::with_capacity(LOG_WRITE_CHUNK);
    loop {
        let mut st = queue();
        st.writing = false;
        while st.buf.is_empty() {
            IDLE.notify_all();
            st = DATA
                .wait(st)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        st.writing = true;
        let k = st.buf.len().min(LOG_WRITE_CHUNK);
        chunk.clear();
        chunk.extend(st.buf.drain(..k));
        drop(st);
        write_all_fd2(&chunk);
    }
}

/// `write(2)` everything to fd 2, waiting out `EAGAIN` (a non-blocking stderr shared with
/// another program); any other error drops the rest of the chunk.
fn write_all_fd2(mut rest: &[u8]) {
    while !rest.is_empty() {
        match hvf::host::write_fd(hvf::host::STDERR_FILENO, rest) {
            Ok(0) => return,
            Ok(n) => rest = rest.get(n..).unwrap_or(&[]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return,
        }
    }
}

/// Wait at most `timeout` for every queued line to reach stderr. Returns true if the queue
/// drained. The CLI calls this once, just before the process exits (module docs).
pub fn flush(timeout: Duration) -> bool {
    let start = Instant::now();
    let mut st = queue();
    while !st.buf.is_empty() || st.writing {
        let left = timeout.saturating_sub(start.elapsed());
        if left.is_zero() || NO_WRITER.load(Ordering::SeqCst) {
            return false;
        }
        st = match IDLE.wait_timeout(st, left) {
            Ok((g, _)) => g,
            Err(p) => p.into_inner().0,
        };
    }
    true
}

/// Log lines dropped so far because the queue was full (stderr not keeping up).
pub fn dropped_lines() -> u64 {
    queue().dropped
}

/// Write one line composed by the VMM itself (the CLI's verdicts, help, stats) to stderr
/// through the log queue, so it keeps its order with log lines and never blocks (module docs).
/// No prefix and no escaping is added: callers format only their own text and numbers.
pub fn line(text: &str) {
    let mut l = String::with_capacity(text.len().saturating_add(1));
    l.push_str(text);
    l.push('\n');
    enqueue(l.as_bytes());
}

/// Write one line at `level` if enabled. Used by the macros; call those instead.
pub fn emit(level: Level, args: fmt::Arguments<'_>) {
    if !enabled(level) {
        return;
    }
    let current = std::thread::current();
    let line = format_line(level, current.name().unwrap_or("thread"), args);
    #[cfg(test)]
    if test_capture::push(&line) {
        return;
    }
    enqueue(line.as_bytes());
}

/// `emit` for `guest_warn!`: adds the suppressed count when there is one.
pub fn emit_guest(suppressed: u64, args: fmt::Arguments<'_>) {
    emit_guest_at(Level::Warn, suppressed, args);
}

/// `emit_guest` at any level (`guest_debug!` uses `Debug`).
pub fn emit_guest_at(level: Level, suppressed: u64, args: fmt::Arguments<'_>) {
    if suppressed == 0 {
        emit(level, format_args!("guest: {args}"));
    } else {
        emit(
            level,
            format_args!("guest: {args} ({suppressed} similar messages suppressed)"),
        );
    }
}

/// Log at `error` level.
#[macro_export]
macro_rules! error {
    ($($arg:tt)+) => { $crate::log::emit($crate::log::Level::Error, format_args!($($arg)+)) };
}

/// Log at `warn` level. Not for anything a guest can trigger: use `guest_warn!`.
#[macro_export]
macro_rules! warn {
    ($($arg:tt)+) => { $crate::log::emit($crate::log::Level::Warn, format_args!($($arg)+)) };
}

/// Log at `info` level.
#[macro_export]
macro_rules! info {
    ($($arg:tt)+) => { $crate::log::emit($crate::log::Level::Info, format_args!($($arg)+)) };
}

/// Log at `debug` level.
#[macro_export]
macro_rules! debug {
    ($($arg:tt)+) => { $crate::log::emit($crate::log::Level::Debug, format_args!($($arg)+)) };
}

/// Log at `trace` level.
#[macro_export]
macro_rules! trace {
    ($($arg:tt)+) => { $crate::log::emit($crate::log::Level::Trace, format_args!($($arg)+)) };
}

// ANCHOR: guest_warn_macro
/// Warn about something the guest did, rate-limited per call site (threat model LOG-1): the
/// first 10 messages, then every 1000th with the number suppressed. Format guest values with
/// `{:?}` (LOG-2).
#[macro_export]
macro_rules! guest_warn {
    ($($arg:tt)+) => {{
        static LIMIT: $crate::log::RateLimit = $crate::log::RateLimit::new();
        if let Some(suppressed) = LIMIT.admit() {
            $crate::log::emit_guest(suppressed, format_args!($($arg)+));
        }
    }};
}
// ANCHOR_END: guest_warn_macro

/// `guest_warn!` at debug level: for guest-triggerable events that are not guest bugs (an
/// access to a RAZ/WI window), still rate-limited per call site (LOG-1). Counts only while
/// debug logging is on.
#[macro_export]
macro_rules! guest_debug {
    ($($arg:tt)+) => {{
        static LIMIT: $crate::log::RateLimit = $crate::log::RateLimit::new();
        if $crate::log::enabled($crate::log::Level::Debug) {
            if let Some(suppressed) = LIMIT.admit() {
                $crate::log::emit_guest_at(
                    $crate::log::Level::Debug,
                    suppressed,
                    format_args!($($arg)+),
                );
            }
        }
    }};
}

/// Test-only capture of emitted lines, per thread, so tests can assert on output without
/// touching the process's stderr or racing each other.
#[cfg(test)]
pub(crate) mod test_capture {
    use std::cell::RefCell;

    thread_local! {
        static LINES: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    }

    /// Start capturing this thread's log lines.
    pub fn start() {
        LINES.with(|l| *l.borrow_mut() = Some(Vec::new()));
    }

    /// Stop capturing and return what was captured.
    pub fn finish() -> Vec<String> {
        LINES.with(|l| l.borrow_mut().take()).unwrap_or_default()
    }

    /// Store `line` if this thread is capturing.
    pub fn push(line: &str) -> bool {
        LINES.with(|l| match l.borrow_mut().as_mut() {
            Some(v) => {
                v.push(line.to_owned());
                true
            }
            None => false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PLAN M2 acceptance (LOG-1): the first 10 messages of a call site print, then every
    /// 1000th, each carrying the number of messages suppressed since the previous one.
    #[test]
    fn guest_warn_rate_limits() {
        // The pure rule.
        for n in 1..=10 {
            assert_eq!(RateLimit::decide(n), Some(0), "n={n}");
        }
        for n in [11, 12, 500, 999, 1001, 1999, 2001] {
            assert_eq!(RateLimit::decide(n), None, "n={n}");
        }
        assert_eq!(RateLimit::decide(1000), Some(989)); // 11..=999
        assert_eq!(RateLimit::decide(2000), Some(999)); // 1001..=1999
        assert_eq!(RateLimit::decide(u64::MAX - 615), Some(999)); // a multiple of 1000
        assert_eq!(RateLimit::decide(0), None);

        // Through the macro: one call site, 2500 guest-triggered events.
        test_capture::start();
        for i in 0..2500u32 {
            crate::guest_warn!("unhandled MMIO write at {:#x}", 0x1000 + i);
        }
        let lines = test_capture::finish();
        assert_eq!(lines.len(), 12, "{lines:#?}");
        assert!(lines[0].starts_with("macvmm: warn: ["), "{}", lines[0]);
        assert!(lines[0].ends_with("] guest: unhandled MMIO write at 0x1000\n"));
        assert!(lines[9].contains("0x1009") && !lines[9].contains("suppressed"));
        assert!(lines[10].contains("0x13e7 (989 similar messages suppressed)"));
        assert!(lines[11].contains("0x17cf (999 similar messages suppressed)"));

        // A second call site has its own counter.
        test_capture::start();
        crate::guest_warn!("other site");
        assert_eq!(test_capture::finish().len(), 1);
    }

    #[test]
    fn line_format_escapes_control_characters() {
        let line = format_line(Level::Error, "vcpu0", format_args!("a\x1b]0;x\x07b\u{9b}c"));
        assert_eq!(line, "macvmm: error: [vcpu0] a\\u{1b}]0;x\\u{7}b\\u{9b}c\n");
        assert!(!line.trim_end_matches('\n').chars().any(char::is_control));
    }

    #[test]
    fn level_parse_and_order() {
        assert_eq!(Level::parse("warn"), Ok(Some(Level::Warn)));
        assert_eq!(Level::parse("trace"), Ok(Some(Level::Trace)));
        assert_eq!(Level::parse("off"), Ok(None));
        assert_eq!(Level::parse("loud"), Err(()));
        assert!(Level::Error < Level::Trace);
        // The default is `warn` (architecture §16); tests never change the global level.
        assert!(enabled(Level::Error) && enabled(Level::Warn));
        assert!(!enabled(Level::Info));
    }
}
