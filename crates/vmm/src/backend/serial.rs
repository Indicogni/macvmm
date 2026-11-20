//! Guest byte streams on the host side: the output sinks ([`Sink`], [`SinkHandle`]) and the
//! console input queue ([`SerialInput`]) (architecture §10, §14.1, §14.2, §14.4, §16; threat
//! model TTY-1, TTY-10, SINK-1, LOG-4, RUST-5).
//!
//! # Output: a bounded queue and one writer thread per sink (SINK-1, flaw F20)
//!
//! **The problem.** A guest's console output must eventually reach `write(2)` on the host's
//! stdout or a file. If the *vCPU thread* made that call (as M3's DEBUG_PUTC did), a stdout
//! whose reader stopped reading (`macvmm run … | less` waiting for a key, a stuck CI log
//! collector) would block the vCPU inside `write(2)`, outside `hv_vcpu_run`. The stop kick
//! (`hv_vcpus_exit`) only reaches a vCPU that is *inside* `hv_vcpu_run`, so the VM could never
//! be stopped, not even by Ctrl-A x or SIGTERM.
//!
//! **The design.** Each sink has a bounded byte queue ([`SINK_QUEUE_CAP`] = 64 KiB) and its own
//! writer thread, which is the only thread that ever calls `write(2)` on it:
//!
//! ```text
//!  vCPU (PL011 DR write, DEBUG_PUTC)            sink writer thread
//!  ── AnsiFilter ──► [ 64 KiB queue ] ──────────► write_all(stdout | file)
//!        │ full? wait ≤ 10 ms on a condvar,
//!        │ waking early on the stop flag,
//!        └ then drop the bytes and count them (sink_dropped)
//! ```
//!
//! - [`Sink::write_guest`] (the producer API, unchanged since M3) filters the bytes (TTY-1),
//!   applies the file cap (LOG-4), and appends them to the queue. If the queue is full it waits
//!   on the queue's condvar for at most [`SINK_FULL_WAIT`] = 10 ms, waking at once if
//!   [`Sink::set_stopping`] was called, then drops what did not fit and counts it
//!   ([`Sink::dropped`], one warning). This is the **only bounded wait allowed under a device
//!   mutex** (architecture §14.2): it caps how long a vCPU can be outside `hv_vcpu_run`.
//! - The 10 ms is a bound **per device-mutex hold**, not per call. A producer that writes
//!   several buffers under one hold (the virtio-console's TX batch: up to 64 chains, M13)
//!   passes one [`FullWait`] to [`Sink::write_guest_within`] for all of them: the first write
//!   that finds the queue full starts the 10 ms clock, and later writes in the same hold wait
//!   only for what is left of it, then drop at once. Without this, a stalled reader would cost
//!   64 × 10 ms per batch.
//! - The writer thread drains the queue with `write_all` in chunks of up to 16 KiB. On any
//!   write error, `EPIPE` included (`macvmm run … | head -1`), the sink turns into `none` with
//!   exactly one warning, and the guest keeps running: losing console output is safe, killing
//!   the VM for it is not (RUST-5, flaw F16). Rust ignores `SIGPIPE`, so a closed pipe arrives
//!   here as `EPIPE` instead of killing the process.
//! - [`Sink::close`] (at process exit) stops new output, lets the writer drain for at most
//!   [`SINK_DRAIN_ON_STOP`] = 500 ms, and then has it write an *epilogue* (the TTY-6 terminal
//!   reset, from `macvmm/src/term.rs`) **after the guest's last queued byte**. A writer stuck in
//!   `write(2)` is abandoned: the process exits anyway, and bytes still queued are reported.
//! - When the consumer keeps up, the stream is byte-exact and in order: there is one queue,
//!   one writer, and producers append under one lock (`sink_queue.rs` checks 1 MiB).
//!
//! Bytes are counted at every stage, so loss is always visible (`--stats`): `written` (reached
//! the destination), `dropped` (queue full), `capped` (over the file cap), `lost` (after the sink
//! became `none`), and the filter's own `filtered_out`.
//!
//! **Lock order** (architecture §14.2): device mutex → sink front (filter) → sink queue. The
//! writer takes only the queue lock, and never while writing.
//!
//! **In-memory sinks.** [`Sink::new`] builds a sink that writes on the producer's thread, for
//! writers that cannot block (a `Vec` in a unit test). Host sinks are made only with
//! [`Sink::stdout`], [`Sink::spawn`] and [`Sink::none`] (`HostIo`); the SINK-1 audit in
//! `tests/sink_queue.rs` checks that no other module constructs a sink with `Sink::new`.
//!
//! # Input: [`SerialInput`] (TTY-9, TTY-10, flaw F21)
//!
//! Bytes typed on the host (after the Ctrl-A escape was handled, TTY-9) wait here for the
//! guest's UART to take them. It is bounded to [`SERIAL_INPUT_CAP`] = 4 KiB, and
//! [`SerialInput::push`] **never blocks**: what does not fit is dropped and counted
//! (`serial_input_dropped` in `--stats`, one warning). An earlier design blocked the stdin
//! thread when the queue was full; then a guest that stops reading its UART also stopped the
//! host from reading Ctrl-A x, and the user lost every in-band way to quit.
//!
//! After a push, the queue calls its *hook* (set by `Machine::build`), which locks the PL011
//! and lets it refill its 32-entry RX FIFO and update its interrupt line. The hook is called
//! with the queue unlocked, so the lock order device → `SerialInput` holds (architecture
//! §14.2). `SerialInput` lives in `HostIo` and persists across reboots; each boot installs its
//! own device's hook.
//!
//! **M13: which device gets stdin** ([`StdinBinding`], architecture §14.4). With
//! `--console stdio` the virtio-console, not the PL011, is the interactive device, so stdin is
//! bound to the console's own queue (`HostIo::console_input`, the same bounded, never-blocking
//! [`SerialInput`]) and the PL011's queue gets nothing. Exactly one device is bound: the one
//! whose sink is `stdio`; at most one sink may be `stdio` (`VmConfig::validate`). The console
//! drains its queue into RX buffers the guest posted, taking bytes only once they are in
//! guest memory ([`SerialInput::peek_into`], then [`SerialInput::discard`]); while it posts
//! none, the queue holds at most [`SERIAL_INPUT_CAP`] bytes and drops the rest (TTY-10). Its
//! overflow warning names the console and `console_input_dropped` ([`SerialInput::console`]).

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::backend::ansi::{AnsiFilter, FilterPolicy};
use crate::config::SinkKind;
use crate::sync::lock;
use std::collections::VecDeque;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Bytes of filtered guest output a sink buffers before producers wait (SINK-1).
pub const SINK_QUEUE_CAP: usize = 64 * 1024;
/// The longest a producer waits for queue space before dropping (SINK-1).
pub const SINK_FULL_WAIT: Duration = Duration::from_millis(10);
/// How long [`Sink::close`] lets the writer drain (SINK-1, TTY-6 ordering).
pub const SINK_DRAIN_ON_STOP: Duration = Duration::from_millis(500);
/// Bytes of host input waiting for the guest's UART or virtio-console (TTY-10, MMIO-9).
pub const SERIAL_INPUT_CAP: usize = 4 * 1024;
/// The default byte cap of a file sink (`--serial file:F[,max=SIZE]`, LOG-4).
pub const DEFAULT_SINK_MAX: u64 = 1 << 30;
/// The most bytes the writer takes out of the queue per `write_all`.
const WRITE_CHUNK: usize = 16 * 1024;

/// A sink shared by every thread that produces guest output. It lives in `HostIo` and
/// persists across reboots, so the filter state, the counters and the cap span them.
pub type SinkHandle = Arc<Sink>;

/// What the producer side owns: the filter and its scratch buffer.
struct Front {
    filter: AnsiFilter,
    /// Reused per call: filtered bytes waiting to be queued.
    buf: Vec<u8>,
    /// [`Sink::new`] only: the writer, called on the producer's thread.
    inline: Option<Box<dyn Write + Send>>,
    /// The byte cap (LOG-4), and the bytes accepted towards it.
    max: u64,
    accepted: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// Accepting output.
    Open,
    /// [`Sink::close`] was called: the writer drains, writes the epilogue and exits.
    Closing,
    /// Discarding everything: `--serial none`, a write error, or closed.
    Off,
}

struct QState {
    buf: VecDeque<u8>,
    mode: Mode,
    epilogue: Vec<u8>,
    /// The epilogue (TTY-6 reset) reached the destination.
    epilogue_written: bool,
    /// The writer thread has exited (or there never was one).
    writer_done: bool,
    written: u64,
    dropped: u64,
    capped: u64,
    lost: u64,
    warnings: u64,
    warned_full: bool,
    warned_cap: bool,
    /// Has anything reached the destination, and was the last byte a line end (TTY-7)?
    any_output: bool,
    at_line_start: bool,
}

struct Queue {
    st: Mutex<QState>,
    /// Producers wait here for space.
    space: Condvar,
    /// The writer waits here for data.
    data: Condvar,
    /// `close` waits here for the writer to finish.
    idle: Condvar,
    /// Set by [`Sink::set_stopping`]: producers stop waiting for space.
    stopping: AtomicBool,
}

impl Queue {
    fn new(mode: Mode, writer_done: bool) -> Queue {
        Queue {
            st: Mutex::new(QState {
                buf: VecDeque::new(),
                mode,
                epilogue: Vec::new(),
                epilogue_written: false,
                writer_done,
                written: 0,
                dropped: 0,
                capped: 0,
                lost: 0,
                warnings: 0,
                warned_full: false,
                warned_cap: false,
                any_output: false,
                at_line_start: true,
            }),
            space: Condvar::new(),
            data: Condvar::new(),
            idle: Condvar::new(),
            stopping: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, QState> {
        lock(&self.st)
    }
}

fn len64(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

fn wait_timeout<'a>(
    cv: &Condvar,
    g: MutexGuard<'a, QState>,
    d: Duration,
) -> MutexGuard<'a, QState> {
    match cv.wait_timeout(g, d) {
        Ok((g, _)) => g,
        Err(poisoned) => poisoned.into_inner().0,
    }
}

/// Note `bytes` that reached the destination (counters and the TTY-7 column state).
fn note_written(st: &mut QState, bytes: &[u8]) {
    st.written = st.written.saturating_add(len64(bytes.len()));
    if let Some(&last) = bytes.last() {
        st.any_output = true;
        st.at_line_start = matches!(last, b'\n' | b'\r');
    }
}

/// The full-queue wait budget of one device-mutex hold (SINK-1, module docs): unset until a
/// write first finds the queue full, then [`SINK_FULL_WAIT`] from that moment, shared by
/// every later write made with the same `FullWait`.
#[derive(Debug, Default)]
pub struct FullWait {
    until: Option<Instant>,
}

impl FullWait {
    /// A fresh budget: no wait has started yet.
    pub fn new() -> FullWait {
        FullWait::default()
    }

    /// The deadline, started at `now` if this is the first wait.
    fn deadline(&mut self, now: Instant) -> Instant {
        *self
            .until
            .get_or_insert_with(|| now.checked_add(SINK_FULL_WAIT).unwrap_or(now))
    }
}

/// One guest output sink (stdout, a file, or nothing). Module docs.
pub struct Sink {
    name: &'static str,
    front: Mutex<Front>,
    q: Arc<Queue>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl core::fmt::Debug for Sink {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Sink").field("name", &self.name).finish()
    }
}

impl Sink {
    fn front(policy: FilterPolicy, max: u64, inline: Option<Box<dyn Write + Send>>) -> Front {
        Front {
            filter: AnsiFilter::new(policy),
            buf: Vec::new(),
            inline,
            max,
            accepted: 0,
        }
    }

    /// An **in-memory** sink that writes on the producer's thread (module docs): only for
    /// writers that never block, such as a buffer in a test. Host destinations use
    /// [`Sink::stdout`] or [`Sink::spawn`].
    pub fn new(name: &'static str, out: Box<dyn Write + Send>, policy: FilterPolicy) -> Sink {
        Sink {
            name,
            front: Mutex::new(Sink::front(policy, u64::MAX, Some(out))),
            q: Arc::new(Queue::new(Mode::Open, true)),
            writer: Mutex::new(None),
        }
    }

    // ANCHOR: sink_spawn
    /// A sink whose bytes `out` receives on a dedicated writer thread (SINK-1), filtered with
    /// `policy` and capped at `max` bytes (LOG-4; `u64::MAX` for none). Fails only if the
    /// thread cannot be created.
    pub fn spawn(
        name: &'static str,
        out: Box<dyn Write + Send>,
        policy: FilterPolicy,
        max: u64,
    ) -> io::Result<Sink> {
        let q = Arc::new(Queue::new(Mode::Open, false));
        let wq = Arc::clone(&q);
        let handle = std::thread::Builder::new()
            .name(format!("sink:{name}"))
            .spawn(move || writer_loop(name, &wq, out))?;
        Ok(Sink {
            name,
            front: Mutex::new(Sink::front(policy, max, None)),
            q,
            writer: Mutex::new(Some(handle)),
        })
    }
    // ANCHOR_END: sink_spawn

    /// The process's stdout. Stdout has no byte cap (LOG-4), but its backpressure never
    /// reaches a vCPU (SINK-1).
    pub fn stdout(policy: FilterPolicy) -> io::Result<Sink> {
        Sink::spawn("stdout", Box::new(io::stdout()), policy, u64::MAX)
    }

    /// A sink that discards everything (`--serial none`).
    pub fn none() -> Sink {
        Sink {
            name: "none",
            front: Mutex::new(Sink::front(FilterPolicy::Safe, u64::MAX, None)),
            q: Arc::new(Queue::new(Mode::Off, true)),
            writer: Mutex::new(None),
        }
    }

    /// The sink's name (`stdout`, `file`, `none`, ...).
    pub fn name(&self) -> &'static str {
        self.name
    }

    // ANCHOR: sink_write_guest
    /// Filter `bytes` from the guest and queue what survives (module docs). Never fails, never
    /// panics, and never waits longer than [`SINK_FULL_WAIT`].
    pub fn write_guest(&self, bytes: &[u8]) {
        self.write_guest_within(bytes, &mut FullWait::new());
    }

    /// [`Sink::write_guest`] for one of several writes made under one device-mutex hold: all
    /// of them share `wait`, so together they wait at most [`SINK_FULL_WAIT`] (module docs).
    pub fn write_guest_within(&self, bytes: &[u8], wait: &mut FullWait) {
        let mut guard = lock(&self.front);
        let f = &mut *guard;
        f.buf.clear();
        f.filter.push(bytes, &mut f.buf);
        if f.buf.is_empty() {
            return;
        }
        // A file sink stops at its cap (`,max=`); the guest is not told, nor stopped.
        let n = f.buf.len();
        let room = usize::try_from(f.max.saturating_sub(f.accepted)).unwrap_or(usize::MAX);
        let take = n.min(room);
        if take < n {
            self.over_cap(n.saturating_sub(take), f.max);
        }
        let data = f.buf.get(..take).unwrap_or(&[]);
        if data.is_empty() {
            return;
        }
        // The cap counts what was actually queued (or written), not what a full queue dropped.
        let queued = match f.inline.as_mut() {
            Some(w) => self.write_inline(w, data),
            None => self.enqueue(data, wait),
        };
        f.accepted = f.accepted.saturating_add(len64(queued));
        if f.inline.is_some() && self.is_none() {
            f.inline = None;
        }
    }
    // ANCHOR_END: sink_write_guest

    /// `Sink::new`: write on this thread (in-memory writers only). Returns the bytes written.
    fn write_inline(&self, w: &mut Box<dyn Write + Send>, data: &[u8]) -> usize {
        let mut st = self.q.lock();
        if st.mode != Mode::Open {
            st.lost = st.lost.saturating_add(len64(data.len()));
            return 0;
        }
        match w.write_all(data).and_then(|()| w.flush()) {
            Ok(()) => {
                note_written(&mut st, data);
                data.len()
            }
            Err(e) => {
                st.mode = Mode::Off;
                st.lost = st.lost.saturating_add(len64(data.len()));
                st.warnings = st.warnings.saturating_add(1);
                drop(st);
                warn_write_failed(self.name, &e);
                0
            }
        }
    }

    // ANCHOR: sink_enqueue
    /// Append `data` to the queue, waiting for space until `wait`'s deadline (at most
    /// [`SINK_FULL_WAIT`] after the first full queue it saw) and not at all once stopping; drop
    /// and count the rest (SINK-1). Returns the number of bytes queued.
    fn enqueue(&self, data: &[u8], wait: &mut FullWait) -> usize {
        let mut st = self.q.lock();
        if st.mode != Mode::Open {
            st.lost = st.lost.saturating_add(len64(data.len()));
            return 0;
        }
        let mut rest = data;
        let mut queued = 0usize;
        loop {
            let space = SINK_QUEUE_CAP.saturating_sub(st.buf.len());
            if space > 0 {
                let (now, later) = rest.split_at(space.min(rest.len()));
                st.buf.extend(now.iter().copied());
                rest = later;
                queued = queued.saturating_add(now.len());
                self.q.data.notify_one();
                if rest.is_empty() {
                    return queued;
                }
            }
            if self.q.stopping.load(Ordering::SeqCst) || st.mode != Mode::Open {
                break;
            }
            let now = Instant::now();
            let until = wait.deadline(now);
            match until.checked_duration_since(now) {
                Some(left) if !left.is_zero() => st = wait_timeout(&self.q.space, st, left),
                _ => break,
            }
        }
        st.dropped = st.dropped.saturating_add(len64(rest.len()));
        let first = !st.warned_full;
        if first {
            st.warned_full = true;
            st.warnings = st.warnings.saturating_add(1);
        }
        drop(st);
        if first {
            crate::warn!(
                "{} sink: the reader is not keeping up; guest output is being dropped \
                 (see sink_dropped in --stats)",
                self.name
            );
        }
        queued
    }
    // ANCHOR_END: sink_enqueue

    fn over_cap(&self, n: usize, max: u64) {
        let mut st = self.q.lock();
        st.capped = st.capped.saturating_add(len64(n));
        if st.warned_cap {
            return;
        }
        st.warned_cap = true;
        st.warnings = st.warnings.saturating_add(1);
        drop(st);
        crate::warn!(
            "{} sink reached its cap of {max} bytes; further guest output to it is dropped \
             (the guest keeps running)",
            self.name
        );
    }

    /// Stop waiting for queue space: every waiting producer wakes at once and later ones drop
    /// immediately when the queue is full. Called when the VM is stopping (a user quit) and by
    /// [`Sink::close`]; it never un-sets.
    pub fn set_stopping(&self) {
        self.q.stopping.store(true, Ordering::SeqCst);
        // Take the lock so a producer between its flag check and its wait cannot miss this.
        drop(self.q.lock());
        self.q.space.notify_all();
    }

    // ANCHOR: sink_close
    /// End the sink (process exit): no more output is accepted, the writer drains what is
    /// queued for at most [`SINK_DRAIN_ON_STOP`], writes `epilogue` after it (the TTY-6 reset,
    /// or nothing), and is joined. Returns true if everything queued was written. Idempotent.
    pub fn close(&self, epilogue: &[u8]) -> bool {
        self.set_stopping();
        if let Some(w) = lock(&self.front).inline.as_mut()
            && !epilogue.is_empty()
            && w.write_all(epilogue).and_then(|()| w.flush()).is_ok()
        {
            self.q.lock().epilogue_written = true;
        }
        let now = Instant::now();
        let deadline = now.checked_add(SINK_DRAIN_ON_STOP).unwrap_or(now);
        let mut st = self.q.lock();
        if st.mode == Mode::Open {
            st.mode = Mode::Closing;
            st.epilogue = epilogue.to_vec();
        }
        self.q.data.notify_all();
        while !st.writer_done {
            match deadline.checked_duration_since(Instant::now()) {
                Some(left) if !left.is_zero() => st = wait_timeout(&self.q.idle, st, left),
                _ => break,
            }
        }
        let done = st.writer_done;
        let stuck = len64(st.buf.len());
        if !done {
            // Abandon a writer stuck in write(2); the process exits without it.
            st.mode = Mode::Off;
            st.lost = st.lost.saturating_add(stuck);
            st.buf.clear();
        } else if st.mode == Mode::Closing {
            st.mode = Mode::Off;
        }
        drop(st);
        let handle = lock(&self.writer).take();
        if done {
            if let Some(h) = handle {
                let _ = h.join();
            }
        } else {
            crate::warn!(
                "{} sink: the writer did not drain within {} ms; {stuck} queued bytes were \
                 dropped",
                self.name,
                SINK_DRAIN_ON_STOP.as_millis()
            );
        }
        done
    }
    // ANCHOR_END: sink_close

    /// Flush an in-memory sink. A threaded sink's writer flushes after every chunk, so this
    /// only wakes it.
    pub fn flush(&self) {
        if let Some(w) = lock(&self.front).inline.as_mut() {
            let _ = w.flush();
        }
        self.q.data.notify_all();
    }

    /// True once the sink discards everything (by request, after a write error, or closed).
    pub fn is_none(&self) -> bool {
        self.q.lock().mode == Mode::Off
    }

    /// Filtered bytes that reached the destination.
    pub fn written(&self) -> u64 {
        self.q.lock().written
    }

    /// Bytes dropped because the queue stayed full (`sink_dropped`, SINK-1).
    pub fn dropped(&self) -> u64 {
        self.q.lock().dropped
    }

    /// Bytes dropped by the byte cap (LOG-4).
    pub fn capped(&self) -> u64 {
        self.q.lock().capped
    }

    /// Bytes discarded because the sink is `none` (by request or after an error).
    pub fn lost(&self) -> u64 {
        self.q.lock().lost
    }

    /// Bytes queued and not yet taken by the writer.
    pub fn queued(&self) -> usize {
        self.q.lock().buf.len()
    }

    /// Warnings this sink has printed (each kind at most once: write error, queue full, cap).
    pub fn warnings(&self) -> u64 {
        self.q.lock().warnings
    }

    /// Bytes dropped by the terminal filter so far.
    pub fn filtered_out(&self) -> u64 {
        lock(&self.front).filter.dropped()
    }

    /// Did the epilogue given to [`Sink::close`] reach the destination? False if the sink was
    /// already `none` (a write error), the writer was abandoned, or the epilogue was empty: the
    /// CLI then writes the TTY-6 reset itself, with a bounded write.
    pub fn epilogue_written(&self) -> bool {
        self.q.lock().epilogue_written
    }

    /// `(anything written, last byte was a line end)`, for TTY-7.
    pub fn output_state(&self) -> (bool, bool) {
        let st = self.q.lock();
        (st.any_output, st.at_line_start)
    }

    /// The sink's counters as `key=value` pairs prefixed by `prefix` (numbers only, LOG-5).
    pub fn stats(&self, prefix: &str) -> String {
        let filtered = self.filtered_out();
        let st = self.q.lock();
        format!(
            "{prefix}_written={} {prefix}_sink_dropped={} {prefix}_capped={} {prefix}_lost={} \
             {prefix}_filtered={filtered}",
            st.written, st.dropped, st.capped, st.lost
        )
    }
}

impl Drop for Sink {
    /// A sink dropped without [`Sink::close`] still gets its bounded drain.
    fn drop(&mut self) {
        if lock(&self.writer).is_some() {
            self.close(&[]);
        }
    }
}

fn warn_write_failed(name: &str, e: &io::Error) {
    crate::warn!(
        "{name} sink: write failed ({}); guest output to it is discarded from now on",
        describe(e)
    );
}

// ANCHOR: sink_writer_loop
/// The writer thread: the only code that blocks on the sink's destination (module docs).
fn writer_loop(name: &'static str, q: &Queue, mut out: Box<dyn Write + Send>) {
    let mut chunk: Vec<u8> = Vec::with_capacity(WRITE_CHUNK);
    loop {
        let mut st = q.lock();
        while st.buf.is_empty() {
            if st.mode != Mode::Open {
                // Drained (or switched off): the epilogue goes after the last guest byte.
                let epilogue = std::mem::take(&mut st.epilogue);
                let write_it = st.mode == Mode::Closing && !epilogue.is_empty();
                drop(st);
                let wrote = write_it && out.write_all(&epilogue).and_then(|()| out.flush()).is_ok();
                let mut st = q.lock();
                st.epilogue_written |= wrote;
                st.writer_done = true;
                q.idle.notify_all();
                return;
            }
            st = match q.data.wait(st) {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        let k = st.buf.len().min(WRITE_CHUNK);
        chunk.clear();
        chunk.extend(st.buf.drain(..k));
        q.space.notify_all();
        drop(st);
        let res = out.write_all(&chunk).and_then(|()| out.flush());
        let mut st = q.lock();
        match res {
            Ok(()) => note_written(&mut st, &chunk),
            Err(e) => {
                let rest = len64(st.buf.len());
                st.lost = st
                    .lost
                    .saturating_add(len64(chunk.len()))
                    .saturating_add(rest);
                st.buf.clear();
                st.mode = Mode::Off;
                st.writer_done = true;
                st.warnings = st.warnings.saturating_add(1);
                q.space.notify_all();
                q.idle.notify_all();
                drop(st);
                warn_write_failed(name, &e);
                return;
            }
        }
    }
}
// ANCHOR_END: sink_writer_loop

fn describe(e: &io::Error) -> String {
    if e.kind() == io::ErrorKind::BrokenPipe {
        "EPIPE: the reader went away".into()
    } else {
        e.to_string()
    }
}

/// Called after bytes were pushed into a [`SerialInput`] (module docs).
pub type InputHook = Arc<dyn Fn() + Send + Sync>;

/// Host input waiting for the guest's UART or virtio-console: bounded, never blocking
/// (TTY-10). Module docs.
pub struct SerialInput {
    q: Mutex<VecDeque<u8>>,
    dropped: AtomicU64,
    warned: AtomicBool,
    hook: Mutex<Option<InputHook>>,
    /// Who should be reading this queue, and its drop counter in `--stats`, for the one
    /// overflow warning (TTY-10 diagnostics name the right device).
    device: &'static str,
    stat: &'static str,
}

impl Default for SerialInput {
    /// The PL011's queue.
    fn default() -> SerialInput {
        SerialInput::named("its UART", "serial_input_dropped")
    }
}

impl core::fmt::Debug for SerialInput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SerialInput")
            .field("len", &self.len())
            .field("dropped", &self.dropped())
            .finish()
    }
}

impl SerialInput {
    /// The PL011's input queue (`HostIo::serial_input`).
    pub fn new() -> SerialInput {
        SerialInput::default()
    }

    /// The virtio-console's input queue (`HostIo::console_input`, M13): its overflow warning
    /// names the console and `console_input_dropped`, the counter `--stats` shows for it.
    pub fn console() -> SerialInput {
        SerialInput::named("its virtio-console (/dev/hvc0)", "console_input_dropped")
    }

    /// An input queue whose overflow warning says the guest is not reading `device` and points
    /// at the `stat` counter of `--stats` (M13: the virtio-console's `console_input`).
    pub fn named(device: &'static str, stat: &'static str) -> SerialInput {
        SerialInput {
            q: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
            warned: AtomicBool::new(false),
            hook: Mutex::new(None),
            device,
            stat,
        }
    }

    // ANCHOR: serial_input_push
    /// Queue `bytes` for the guest. What does not fit in [`SERIAL_INPUT_CAP`] is dropped and
    /// counted, with one warning; this never blocks. Then the hook runs (the queue unlocked).
    /// Returns how many bytes were accepted.
    pub fn push(&self, bytes: &[u8]) -> usize {
        let accepted = {
            let mut q = lock(&self.q);
            let room = SERIAL_INPUT_CAP.saturating_sub(q.len());
            let take = bytes.len().min(room);
            q.extend(bytes.iter().take(take).copied());
            take
        };
        let lost = bytes.len().saturating_sub(accepted);
        if lost > 0 {
            self.dropped.fetch_add(len64(lost), Ordering::Relaxed);
            if !self.warned.swap(true, Ordering::Relaxed) {
                crate::warn!(
                    "console input: the guest is not reading {}; typed bytes are being \
                     dropped (see {} in --stats). Ctrl-A x still quits.",
                    self.device,
                    self.stat
                );
            }
        }
        let hook = lock(&self.hook).clone();
        if let Some(h) = hook {
            h();
        }
        accepted
    }
    // ANCHOR_END: serial_input_push

    /// Take the oldest byte.
    pub fn pop(&self) -> Option<u8> {
        lock(&self.q).pop_front()
    }

    // ANCHOR: serial_input_peek_into
    /// Copy up to `out.len()` of the oldest bytes into `out` **without** taking them, and
    /// return how many. With [`SerialInput::discard`] this is a two-step take for a consumer
    /// that may fail between the copy and the commit (M13: a guest-memory write), so a failed
    /// delivery loses no typed byte. Only correct with one consumer (`push` only appends).
    pub fn peek_into(&self, out: &mut [u8]) -> usize {
        let q = lock(&self.q);
        let n = out.len().min(q.len());
        for (slot, b) in out.iter_mut().zip(q.iter().take(n)) {
            *slot = *b;
        }
        n
    }

    /// Remove the `n` oldest bytes (after a successful [`SerialInput::peek_into`]).
    pub fn discard(&self, n: usize) {
        let mut q = lock(&self.q);
        let n = n.min(q.len());
        q.drain(..n);
    }
    // ANCHOR_END: serial_input_peek_into

    /// Bytes waiting.
    pub fn len(&self) -> usize {
        lock(&self.q).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bytes dropped because the queue was full (`serial_input_dropped`).
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Install (or remove) the hook run after each push.
    pub fn set_hook(&self, hook: Option<InputHook>) {
        *lock(&self.hook) = hook;
    }
}

// ANCHOR: stdin_binding
/// Which device's input queue the stdin thread feeds (M13, architecture §14.4): the one whose
/// sink is `stdio`. With neither sink on stdio, stdin is not read at all (PROC-1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdinBinding {
    /// The PL011 (`--serial stdio`, the default).
    Serial,
    /// The virtio-console (`--console stdio`).
    Console,
    /// No sink is `stdio`: the stdin thread is not started.
    Unbound,
}

impl StdinBinding {
    /// The binding for a serial sink of kind `serial` and an optional console sink.
    /// `VmConfig::validate` already refused both being `stdio`; if they were, the console
    /// would win, but that configuration never reaches here.
    pub fn of(serial: SinkKind, console: Option<SinkKind>) -> StdinBinding {
        match (serial, console) {
            (_, Some(SinkKind::Stdio)) => StdinBinding::Console,
            (SinkKind::Stdio, _) => StdinBinding::Serial,
            _ => StdinBinding::Unbound,
        }
    }
}
// ANCHOR_END: stdin_binding

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    /// A writer that records bytes and can be told to fail.
    #[derive(Clone, Default)]
    struct Probe {
        bytes: Arc<Mutex<Vec<u8>>>,
        fail: Arc<Mutex<Option<io::ErrorKind>>>,
    }

    impl Write for Probe {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if let Some(k) = *lock(&self.fail) {
                return Err(io::Error::from(k));
            }
            lock(&self.bytes).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn filters_then_writes() {
        let p = Probe::default();
        let s = Sink::new("test", Box::new(p.clone()), FilterPolicy::Safe);
        s.write_guest(b"ok\x1b[6n\x1b]52;c;AAAA\x07!\n");
        assert_eq!(&*lock(&p.bytes), b"ok!\n");
        assert_eq!(s.written(), 4);
        assert!(s.filtered_out() > 0);
        assert_eq!(s.output_state(), (true, true));
    }

    /// RUST-5: EPIPE turns the sink into `none` with one warning; no panic, guest unaffected.
    #[test]
    fn epipe_becomes_none_with_one_warning() {
        let p = Probe::default();
        let s = Sink::new("test", Box::new(p.clone()), FilterPolicy::Safe);
        s.write_guest(b"a");
        *lock(&p.fail) = Some(io::ErrorKind::BrokenPipe);
        crate::log::test_capture::start();
        for _ in 0..100 {
            s.write_guest(b"b");
        }
        let lines = crate::log::test_capture::finish();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("EPIPE"), "{}", lines[0]);
        assert!(s.is_none());
        assert_eq!(&*lock(&p.bytes), b"a");
        assert_eq!(s.lost(), 100);
        s.flush();
        assert!(Sink::none().is_none());
        Sink::none().write_guest(b"x");
    }

    #[test]
    fn threaded_sink_delivers_then_closes_with_epilogue() {
        let p = Probe::default();
        let s = Sink::spawn("t", Box::new(p.clone()), FilterPolicy::Safe, u64::MAX).unwrap();
        s.write_guest(b"hello\n");
        s.write_guest(b"world");
        assert!(s.close(b"<reset>"));
        assert_eq!(&*lock(&p.bytes), b"hello\nworld<reset>");
        assert_eq!(s.output_state(), (true, false));
        assert!(s.is_none());
        s.write_guest(b"late");
        assert_eq!(s.lost(), 4);
        assert!(s.close(b"again"), "idempotent");
        assert_eq!(&*lock(&p.bytes), b"hello\nworld<reset>");
    }

    /// A writer that blocks in `write` until released (a stalled reader).
    #[derive(Clone, Default)]
    struct Stall {
        released: Arc<AtomicBool>,
        entered: Arc<AtomicBool>,
    }

    impl Write for Stall {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.entered.store(true, Ordering::SeqCst);
            while !self.released.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// LOG-4 counts only bytes actually queued: bytes SINK-1 dropped on a full queue do not
    /// use up the file cap (M6 review).
    #[test]
    fn dropped_bytes_do_not_count_towards_the_cap() {
        let w = Stall::default();
        let max = 100 * 1024;
        let s = Sink::spawn("t", Box::new(w.clone()), FilterPolicy::Raw, max).unwrap();
        s.write_guest(b"x");
        while !w.entered.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        // The writer holds 1 byte; the queue takes 64 KiB of 96 KiB, the rest is dropped.
        s.write_guest(&vec![b'a'; 96 * 1024]);
        assert_eq!(s.dropped(), 32 * 1024);
        assert_eq!(s.capped(), 0);
        // 40 KiB more: the cap has 100 KiB - (64 KiB + 1) left; only the excess is capped.
        s.write_guest(&vec![b'b'; 40 * 1024]);
        let left = max - (64 * 1024 + 1);
        assert_eq!(s.capped(), 40 * 1024 - left);
        w.released.store(true, Ordering::SeqCst);
        assert!(s.close(b""));
    }

    /// TTY-6 fallback signal: the epilogue is reported written only when it was.
    #[test]
    fn epilogue_written_is_reported() {
        let p = Probe::default();
        let s = Sink::spawn("t", Box::new(p.clone()), FilterPolicy::Safe, u64::MAX).unwrap();
        s.write_guest(b"a");
        assert!(s.close(b"<reset>"));
        assert!(s.epilogue_written());
        let p = Probe::default();
        let s = Sink::spawn("t", Box::new(p.clone()), FilterPolicy::Safe, u64::MAX).unwrap();
        *lock(&p.fail) = Some(io::ErrorKind::WouldBlock);
        crate::log::test_capture::start();
        s.write_guest(b"a");
        while !s.is_none() {
            std::thread::sleep(Duration::from_millis(1));
        }
        s.close(b"<reset>");
        assert!(!s.epilogue_written(), "the sink was off after the error");
        let _ = crate::log::test_capture::finish();
        assert!(!Sink::none().epilogue_written());
    }

    #[test]
    fn serial_input_is_bounded_and_calls_the_hook() {
        let si = SerialInput::new();
        let calls = Arc::new(AtomicU64::new(0));
        let c = Arc::clone(&calls);
        si.set_hook(Some(Arc::new(move || {
            c.fetch_add(1, Ordering::Relaxed);
        })));
        assert_eq!(si.push(&[7u8; SERIAL_INPUT_CAP - 1]), SERIAL_INPUT_CAP - 1);
        assert_eq!(si.push(b"ab"), 1);
        assert_eq!(si.dropped(), 1);
        assert_eq!(si.len(), SERIAL_INPUT_CAP);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert_eq!(si.pop(), Some(7));
        si.set_hook(None);
        si.push(b"z");
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }

    /// M13 review: peek + discard is a take that can be abandoned between its two steps.
    #[test]
    fn peek_then_discard_takes_only_on_commit() {
        let si = SerialInput::new();
        si.push(b"hello");
        let mut out = [0u8; 3];
        assert_eq!(si.peek_into(&mut out), 3);
        assert_eq!(&out, b"hel");
        assert_eq!(si.len(), 5, "a peek takes nothing");
        si.discard(3);
        let mut big = [0u8; 16];
        assert_eq!(si.peek_into(&mut big), 2);
        assert_eq!(&big[..2], b"lo");
        si.discard(99); // clamped
        assert!(si.is_empty());
    }

    /// M13 review (TTY-10 diagnostics): the overflow warning names the device that should be
    /// reading the queue and its own `--stats` counter.
    #[test]
    fn overflow_warning_names_the_device_and_its_counter() {
        crate::log::test_capture::start();
        SerialInput::new().push(&[0u8; SERIAL_INPUT_CAP + 1]);
        let con = SerialInput::console();
        con.push(&[0u8; SERIAL_INPUT_CAP + 1]);
        con.push(b"x"); // one warning per queue
        let lines = crate::log::test_capture::finish();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("its UART") && lines[0].contains("serial_input_dropped"));
        assert!(lines[1].contains("virtio-console") && lines[1].contains("console_input_dropped"));
        assert!(!lines[1].contains("serial_input_dropped") && !lines[1].contains("UART"));
    }

    /// SINK-1 (M13 review): writes that share one [`FullWait`] wait at most 10 ms *in total*
    /// on a stalled reader, however many there are; separate calls each get their own 10 ms.
    #[test]
    fn full_wait_is_shared_by_the_writes_of_one_hold() {
        let w = Stall::default();
        let s = Sink::spawn("t", Box::new(w.clone()), FilterPolicy::Raw, u64::MAX).unwrap();
        s.write_guest(&vec![b'q'; SINK_QUEUE_CAP + 1]); // the writer holds some, queue full
        while !w.entered.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        s.write_guest(&vec![b'q'; SINK_QUEUE_CAP]); // refill whatever the writer took
        let mut wait = FullWait::new();
        let t0 = Instant::now();
        for _ in 0..40 {
            s.write_guest_within(b"0123456789", &mut wait);
        }
        let shared = t0.elapsed();
        assert!(shared >= SINK_FULL_WAIT, "it did wait: {shared:?}");
        assert!(
            shared < Duration::from_millis(150),
            "40 writes took {shared:?}"
        );
        let t0 = Instant::now();
        for _ in 0..20 {
            s.write_guest(b"0123456789");
        }
        let separate = t0.elapsed();
        assert!(separate >= SINK_FULL_WAIT * 20, "per call: {separate:?}");
        w.released.store(true, Ordering::SeqCst);
        assert!(s.close(b""));
    }

    #[test]
    fn stdin_goes_to_the_stdio_sink_only() {
        use SinkKind::{File, None as Off, Stdio};
        assert_eq!(StdinBinding::of(Stdio, None), StdinBinding::Serial);
        assert_eq!(StdinBinding::of(File, Some(Stdio)), StdinBinding::Console);
        assert_eq!(StdinBinding::of(Off, Some(Stdio)), StdinBinding::Console);
        assert_eq!(StdinBinding::of(Stdio, Some(File)), StdinBinding::Serial);
        assert_eq!(StdinBinding::of(File, Some(File)), StdinBinding::Unbound);
        assert_eq!(StdinBinding::of(Off, None), StdinBinding::Unbound);
    }
}
