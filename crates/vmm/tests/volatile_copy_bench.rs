//! PLAN M14: what the MEM-5 volatile copies cost on the virtio-blk data path (threat model
//! MEM-5, risk R15; architecture §6.1).
//!
//! ```text
//! cargo test -p vmm --release --test volatile_copy_bench -- --ignored --nocapture
//! ```
//!
//! **Why measure.** Every byte a virtio-blk request moves crosses guest RAM through
//! `GuestRam::read`/`write`, which copy with `read_volatile`/`write_volatile` (a `u64` loop for
//! the aligned middle, bytes at the edges) instead of `ptr::copy_nonoverlapping`, so the
//! optimizer can never turn one copy into two reads of guest memory (flaw F4). Volatile loops
//! cannot be vectorised, so this is the price of the TOCTOU argument. The question for R15 is
//! whether it matters next to the disk: an NVMe SSD reads a few GB/s, and each blk chunk is a
//! 64 KiB bounce buffer (VQ-11, `MAX_BOUNCE`), exactly what is timed here.
//!
//! The benchmark allocates 64 MiB of guest RAM the way the machine does (`hv_vm_allocate`,
//! which needs no VM and no entitlement), then times 64 KiB copies guest → buffer and
//! buffer → guest over the whole region, against a plain `copy_from_slice` between two host
//! `Vec`s as the baseline. It prints MB/s; there is no pass/fail threshold (`#[ignore]`: it
//! is a measurement, not a test, and debug builds are meaningless for it). No bench
//! dependency (CLAUDE.md: std only).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::time::{Duration, Instant};
use vmm::memory::prelude::*;
use vmm::memory::{GuestAddress, GuestRam};

const RAM: u64 = 0x4000_0000;
const SIZE: u64 = 64 << 20;
const CHUNK: usize = 64 * 1024;
/// Passes over the 64 MiB region per measurement (1 GiB moved).
const PASSES: u64 = 16;

fn mbps(bytes: u64, t: Duration) -> f64 {
    bytes as f64 / t.as_secs_f64() / 1e6
}

fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

#[test]
#[ignore = "a measurement: run with --release -- --ignored --nocapture"]
fn volatile_copy_64k_throughput() {
    let ram = GuestRam::new(&[(GuestAddress(RAM), SIZE)], 36).expect("hv_vm_allocate");
    let mut buf = vec![0u8; CHUNK];
    let chunks = SIZE / CHUNK as u64;
    let total = PASSES * SIZE;
    // Warm up (fault every page in), then measure.
    for c in 0..chunks {
        ram.write(GuestAddress(RAM + c * CHUNK as u64), &buf)
            .unwrap();
    }
    let t = Instant::now();
    for p in 0..PASSES {
        buf[0] = p as u8;
        for c in 0..chunks {
            ram.write(GuestAddress(RAM + c * CHUNK as u64), &buf)
                .unwrap();
        }
    }
    let write = t.elapsed();
    let t = Instant::now();
    let mut sum = 0u64;
    for _ in 0..PASSES {
        for c in 0..chunks {
            ram.read(GuestAddress(RAM + c * CHUNK as u64), &mut buf)
                .unwrap();
            sum = sum.wrapping_add(u64::from(buf[0]));
        }
    }
    let read = t.elapsed();
    // Baseline: memcpy between host buffers of the same total size.
    let src = vec![1u8; SIZE as usize];
    let mut dst = vec![0u8; CHUNK];
    let t = Instant::now();
    for _ in 0..PASSES {
        for c in src.as_chunks::<CHUNK>().0 {
            dst.copy_from_slice(c);
            sum = sum.wrapping_add(u64::from(std::hint::black_box(&dst)[0]));
        }
    }
    let base = t.elapsed();
    say(&format!(
        "volatile_copy_bench: 64 KiB chunks, {} MiB moved per direction",
        total >> 20
    ));
    say(&format!(
        "volatile_copy_bench: guest->host (GuestRam::read)  {:>8.0} MB/s",
        mbps(total, read)
    ));
    say(&format!(
        "volatile_copy_bench: host->guest (GuestRam::write) {:>8.0} MB/s",
        mbps(total, write)
    ));
    say(&format!(
        "volatile_copy_bench: baseline copy_from_slice      {:>8.0} MB/s (checksum {sum})",
        mbps(total, base)
    ));
    // The memory is not mapped into any VM: freeing it is safe (MEM-11).
    let _ = ram.release(true);
}
