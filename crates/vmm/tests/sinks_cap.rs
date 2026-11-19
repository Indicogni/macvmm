//! Host test: output byte caps (threat model LOG-3, LOG-4; flaw F2; PLAN M4 security tests).
//!
//! A guest decides how many exits it makes and how much it prints, so every file the VMM writes
//! for it has a byte cap. **M4 half (the trace):** a `TraceWriter` with `max = 4096` fed 1 MiB of
//! records stops at ≤ 4096 bytes of records plus exactly one `trace_truncated` line, and writes
//! nothing after it. M6 adds the file-sink half (LOG-4).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Write;
use std::sync::{Arc, Mutex};
use vmm::trace::{Action, ExitRecord, TraceCats, TraceWriter};

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn record(i: u64) -> ExitRecord {
    ExitRecord {
        t_ns: i,
        ec: Some(0x24),
        pc: Some(0x4008_0000 + i * 4),
        ipa: Some(0x0b00_0000 + (i % 4096)),
        wnr: Some(i.is_multiple_of(2)),
        size: Some(8),
        reg: Some(u8::try_from(i % 32).unwrap()),
        value: Some(i.wrapping_mul(0x9e37_79b9_7f4a_7c15)),
        action: Some(Action::Mmio),
        ..ExitRecord::default()
    }
}

#[test]
fn trace_cap_4096_one_truncation_record() {
    let out = Shared::default();
    let mut w = TraceWriter::new(Box::new(out.clone()), TraceCats::ALL, 4096);
    // Feed 1 MiB worth of serialized records.
    let mut fed = 0usize;
    let mut i = 0u64;
    while fed < (1 << 20) {
        let r = record(i);
        fed += r.to_json().len() + 1;
        w.record(&r);
        i += 1;
    }
    w.flush();
    let bytes = out.0.lock().unwrap().clone();
    let text = String::from_utf8(bytes).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let (last, body) = lines.split_last().unwrap();
    let body_bytes: usize = body.iter().map(|l| l.len() + 1).sum();
    assert!(body_bytes <= 4096, "{body_bytes} bytes of records");
    assert_eq!(body_bytes as u64, w.written());
    assert!(
        body_bytes > 4096 - 200,
        "the cap is used, not wasted: {body_bytes}"
    );
    assert!(
        last.starts_with('{') && last.contains(r#""action":"trace_truncated""#),
        "{last}"
    );
    assert!(last.contains(r#""max":4096"#), "{last}");
    assert_eq!(text.matches("trace_truncated").count(), 1);
    assert!(w.is_truncated());
    assert!(body.iter().all(|l| l.contains(r#""action":"mmio""#)));
    // Nothing more is ever written.
    w.record(&record(1));
    w.flush();
    assert_eq!(out.0.lock().unwrap().len(), text.len());
}

#[test]
fn cap_of_one_byte_writes_only_the_truncation_record() {
    let out = Shared::default();
    let mut w = TraceWriter::new(Box::new(out.clone()), TraceCats::ALL, 1);
    for i in 0..1000 {
        w.record(&record(i));
    }
    let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
    assert_eq!(text.lines().count(), 1, "{text}");
    assert!(text.contains("trace_truncated") && text.ends_with('\n'));
    assert_eq!(w.written(), 0);
}

#[test]
fn unselected_records_do_not_count_against_the_cap() {
    let out = Shared::default();
    let mut w = TraceWriter::new(Box::new(out.clone()), TraceCats::HVC, 4096);
    for i in 0..100_000 {
        w.record(&record(i)); // all data aborts: none selected
    }
    assert_eq!(w.written(), 0);
    assert!(!w.is_truncated());
    assert!(out.0.lock().unwrap().is_empty());
}

// ---- M6: the file-sink half (LOG-4) ----

/// `--serial file:F,max=1K`: a guest that prints 1 MiB leaves exactly 1 KiB in the file, one
/// warning, and keeps running (the producer is never told). Built through `HostIo::open`, so
/// the real PATH-3 output path and the SINK-1 writer thread are exercised.
#[test]
fn serial_file_cap_1k_one_warning() {
    use vmm::HostIo;
    use vmm::config::{SinkKind, VmConfig};
    let dir = std::env::temp_dir().join(format!("macvmm-sinkcap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let blob = dir.join("guest.bin");
    std::fs::write(&blob, [0u8; 4]).unwrap();
    let out = dir.join("serial.txt");
    let mut cfg = VmConfig::default();
    cfg.mem_bytes = 64 << 20;
    cfg.boot.raw.push(vmm::config::RawSpec {
        path: blob,
        addr: 0x4008_0000,
    });
    cfg.serial.kind = SinkKind::File;
    cfg.serial.path = Some(out.clone());
    cfg.serial.max_bytes = 1024;
    let host = HostIo::open(&cfg).unwrap();
    let line = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n";
    for _ in 0..(1 << 20) / line.len() {
        host.serial.write_guest(line);
    }
    assert!(host.close_sinks(b"never written to a file"));
    let bytes = std::fs::read(&out).unwrap();
    assert_eq!(bytes.len(), 1024, "stops exactly at the cap");
    assert!(bytes.iter().all(|b| line.contains(b)));
    assert_eq!(host.serial.written(), 1024);
    assert_eq!(host.serial.capped(), (1 << 20) - 1024);
    assert_eq!(host.serial.warnings(), 1, "one warning");
    assert_eq!(host.serial.dropped(), 0, "nothing was lost to the queue");
    let _ = std::fs::remove_dir_all(&dir);
}
