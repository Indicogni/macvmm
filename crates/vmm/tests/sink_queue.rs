//! Host test: the SINK-1 output queue (PLAN M6 security tests; threat model SINK-1, RUST-5,
//! flaw F20; architecture §14.2).
//!
//! - a writer that never drains: `write_guest` returns within `SINK_FULL_WAIT` (10 ms) plus
//!   scheduling slack, and counts the dropped bytes;
//! - setting the stop flag wakes a waiting producer at once, and later producers never wait;
//! - a writer returning `EPIPE` turns the sink into `none` with exactly one warning;
//! - when the consumer keeps up, 1 MiB arrives byte-exact and in order;
//! - `close` drains, then writes the epilogue after the last guest byte, and gives up on a
//!   stuck writer after `SINK_DRAIN_ON_STOP` (500 ms);
//! - the SINK-1 source audit: nothing under `devices/` or `virtio/` writes to a host stream,
//!   and no library module builds an in-memory `Sink::new` outside tests.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SINK_DRAIN_ON_STOP, SINK_FULL_WAIT, SINK_QUEUE_CAP, Sink};

/// A writer that blocks in `write` until the gate opens (a stdout pipe nobody reads).
#[derive(Clone, Default)]
struct Gate {
    open: Arc<(Mutex<bool>, Condvar)>,
    got: Arc<Mutex<Vec<u8>>>,
    entered: Arc<Mutex<u64>>,
}

impl Gate {
    fn release(&self) {
        *self.open.0.lock().unwrap() = true;
        self.open.1.notify_all();
    }
    fn wait_entered(&self) {
        let t0 = Instant::now();
        while *self.entered.lock().unwrap() == 0 {
            assert!(
                t0.elapsed() < Duration::from_secs(5),
                "writer never started"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }
}

impl Write for Gate {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        *self.entered.lock().unwrap() += 1;
        let (m, cv) = &*self.open;
        let mut open = m.lock().unwrap();
        while !*open {
            open = cv.wait(open).unwrap();
        }
        self.got.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A full sink: the writer is blocked holding one byte and the queue holds `SINK_QUEUE_CAP`.
fn full_sink() -> (Sink, Gate) {
    let gate = Gate::default();
    let s = Sink::spawn("t", Box::new(gate.clone()), FilterPolicy::Raw, u64::MAX).unwrap();
    s.write_guest(b"x");
    gate.wait_entered();
    s.write_guest(&vec![b'q'; SINK_QUEUE_CAP]);
    assert_eq!(s.queued(), SINK_QUEUE_CAP);
    assert_eq!(s.dropped(), 0);
    (s, gate)
}

#[test]
fn stalled_writer_bounds_the_producer_and_counts_drops() {
    let (s, gate) = full_sink();
    let t0 = Instant::now();
    s.write_guest(&[b'z'; 100]);
    let took = t0.elapsed();
    assert!(
        took >= SINK_FULL_WAIT - Duration::from_millis(1),
        "{took:?}"
    );
    assert!(
        took < SINK_FULL_WAIT + Duration::from_millis(90),
        "{took:?}"
    );
    assert_eq!(s.dropped(), 100);
    assert_eq!(s.warnings(), 1, "one warning for the first drop");
    s.write_guest(&[b'z'; 5]);
    assert_eq!(s.dropped(), 105);
    assert_eq!(s.warnings(), 1, "and no more");
    gate.release();
    assert!(s.close(b""));
    assert_eq!(gate.got.lock().unwrap().len(), 1 + SINK_QUEUE_CAP);
}

#[test]
fn stop_flag_wakes_a_waiting_producer_at_once() {
    let (s, gate) = full_sink();
    let s = Arc::new(s);
    // A producer waiting for space is woken by set_stopping well before its 10 ms are up.
    let mut early = false;
    for _ in 0..5 {
        let p = Arc::clone(&s);
        let t0 = Instant::now();
        let h = std::thread::spawn(move || {
            p.write_guest(b"w");
            Instant::now()
        });
        std::thread::sleep(Duration::from_millis(2));
        if s.queued() == SINK_QUEUE_CAP {
            s.set_stopping();
        }
        let done = h.join().unwrap();
        if done.duration_since(t0) < SINK_FULL_WAIT - Duration::from_millis(3) {
            early = true;
            break;
        }
    }
    assert!(early, "set_stopping did not wake the producer early");
    // Once stopping, a full queue never makes a producer wait: 200 pushes, far under 200 × 10 ms.
    let t0 = Instant::now();
    for _ in 0..200 {
        s.write_guest(b"y");
    }
    assert!(
        t0.elapsed() < Duration::from_millis(200),
        "{:?}",
        t0.elapsed()
    );
    assert!(s.dropped() >= 200);
    gate.release();
    s.close(b"");
}

#[derive(Clone, Default)]
struct Pipe {
    fail_after: usize,
    got: Arc<Mutex<Vec<u8>>>,
}

impl Write for Pipe {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let mut got = self.got.lock().unwrap();
        if got.len() >= self.fail_after {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        got.extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// RUST-5: `macvmm run … | head -1`: the reader goes away, the sink becomes `none` with
/// exactly one warning, and the producers never notice.
#[test]
fn epipe_turns_the_sink_into_none_with_one_warning() {
    let p = Pipe {
        fail_after: 3,
        ..Pipe::default()
    };
    let s = Sink::spawn("t", Box::new(p.clone()), FilterPolicy::Safe, u64::MAX).unwrap();
    s.write_guest(b"abc");
    let t0 = Instant::now();
    while s.written() < 3 {
        assert!(t0.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1));
    }
    for _ in 0..1000 {
        s.write_guest(b"more\n");
    }
    let t0 = Instant::now();
    while !s.is_none() {
        assert!(t0.elapsed() < Duration::from_secs(5), "never became none");
        std::thread::sleep(Duration::from_millis(1));
    }
    s.write_guest(b"after");
    assert_eq!(s.warnings(), 1);
    assert!(s.lost() > 0);
    assert_eq!(&*p.got.lock().unwrap(), b"abc");
    s.close(b"reset");
    assert_eq!(
        &*p.got.lock().unwrap(),
        b"abc",
        "no epilogue to a dead sink"
    );
}

#[derive(Clone, Default)]
struct Collect(Arc<Mutex<Vec<u8>>>);

impl Write for Collect {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn one_mib_in_order_when_the_consumer_keeps_up() {
    let c = Collect::default();
    let s = Sink::spawn("t", Box::new(c.clone()), FilterPolicy::Raw, u64::MAX).unwrap();
    let mut x: u64 = 0x5eed_0001;
    let mut want = Vec::with_capacity(1 << 20);
    while want.len() < (1 << 20) {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        let n = (x % 3000) as usize + 1;
        let chunk: Vec<u8> = (0..n).map(|i| (x >> (i % 56)) as u8).collect();
        s.write_guest(&chunk);
        want.extend_from_slice(&chunk);
    }
    assert!(s.close(b"<end>"));
    let got = c.0.lock().unwrap();
    assert_eq!(s.dropped(), 0);
    assert_eq!(got.len(), want.len() + 5);
    assert!(got[..want.len()] == want[..], "byte-exact, in order");
    assert_eq!(
        &got[want.len()..],
        b"<end>",
        "epilogue after the last guest byte"
    );
    assert_eq!(s.written(), want.len() as u64);
}

#[test]
fn close_gives_up_on_a_stuck_writer() {
    let (s, gate) = full_sink();
    let t0 = Instant::now();
    assert!(!s.close(b"reset"), "a stuck writer cannot drain");
    let took = t0.elapsed();
    assert!(
        took >= SINK_DRAIN_ON_STOP - Duration::from_millis(5),
        "{took:?}"
    );
    assert!(
        took < SINK_DRAIN_ON_STOP + Duration::from_millis(300),
        "{took:?}"
    );
    assert!(s.is_none());
    gate.release(); // let the abandoned thread finish
}

/// The SINK-1 audit (PLAN M6 checklist): no device or virtio code writes to a host stream; it
/// only calls `Sink::write_guest`. And `Sink::new` (in-memory, writes on the caller's thread)
/// is never used by library code outside `#[cfg(test)]`.
#[test]
fn sink1_source_audit() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect(&src, &mut files);
    assert!(files.len() > 20, "found {} files", files.len());
    let mut bad = Vec::new();
    for f in &files {
        let text = std::fs::read_to_string(f).unwrap();
        // Unit-test modules sit at the end of each file by convention.
        let body = text.split("#[cfg(test)]").next().unwrap_or("");
        let rel = f.strip_prefix(&src).unwrap().to_string_lossy().into_owned();
        let guest_facing = rel.starts_with("devices/") || rel.starts_with("virtio/");
        for (i, line) in body.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            if guest_facing
                && [
                    "write_all",
                    "io::Write",
                    "Write for",
                    ".flush(",
                    "stdout(",
                    "stderr(",
                ]
                .iter()
                .any(|p| code.contains(p))
            {
                bad.push(format!(
                    "{rel}:{}: host write in guest-facing code: {line}",
                    i + 1
                ));
            }
            if rel != "backend/serial.rs" && code.contains("Sink::new(") {
                bad.push(format!(
                    "{rel}:{}: in-memory Sink::new in library code",
                    i + 1
                ));
            }
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

fn collect(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}
