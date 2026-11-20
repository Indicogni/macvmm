// Checkpoint 16 contract (L1), frozen from the reference test crates/vmm/tests/virtqueue_toctou.rs.
// It names only items chapters 04, 15 and 16 teach; the harness runs it against your crates.
//! PLAN M11 security test (threat model VQ-4, MEM-7; architecture §11.2 item 13;
//! first-principles R9): the guest rewrites ring memory *while* the device walks it.
//!
//! A double fetch is the classic virtqueue bug: the device validates `desc.len`, then reads
//! `desc.len` again to use it, and a second guest vCPU changed it in between (the shape of
//! several hypervisor escapes). The defence is structural: every descriptor, ring entry and
//! indirect entry is copied out **once** (`read_obj`), and only the copy is checked and used.
//!
//! Two kinds of test:
//! - **deterministic**, with the `VecMemory` mutation hook: rewrite a descriptor, an avail-ring
//!   entry, `avail.idx`, `used.idx` or an indirect table right after the device's first read,
//!   and check the outcome is consistent with the first copy (or NEEDS_RESET), and that the
//!   access log shows each descriptor read **exactly once**;
//! - **racing**, with a second thread flipping `len` for one second between a valid value and
//!   one that runs past the end of RAM (byte cap off): two deliberately re-reading walkers
//!   (one hand-written, one a re-reading device on top of the real walker) must be caught
//!   accepting an out-of-RAM buffer, and the real walker must never be.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::irq::TestIrq;
use vmm::memory::Mutation;
use vmm::memory::prelude::*;
use vmm::virtio::mmio::reg;
use vmm::virtio::{Descriptor, QueueError, VirtioInterrupt, VirtioMmio};

const K64: u64 = 64 * 1024;
const TABLE: u64 = RAM + 0x2_0000;

fn desc_addr(i: u16) -> u64 {
    DESC + 16 * u64::from(i)
}

/// Reads before the device reaches descriptor `head`: avail.idx, then the avail-ring entry.
const READS_BEFORE_HEAD: usize = 2;

#[test]
fn descriptor_rewritten_after_its_first_read() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 16, NEXT, 1));
    ring.set_desc(1, d(BUF + 0x100, 64, WRITE, 0));
    ring.push(0);
    // Right after descriptor 0 is copied: point it at MMIO, make it huge, loop it.
    let evil = d(MMIO_ADDR, u32::MAX, NEXT | WRITE, 0);
    mem.mutate_after(Mutation {
        after_reads: READS_BEFORE_HEAD + 1,
        addr: GuestAddress(desc_addr(0)),
        bytes: evil.to_le_bytes().to_vec(),
    });
    mem.enable_log();
    let mut q = ring.queue();
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!(
        v.readable,
        vec![d(BUF, 16, NEXT, 1)],
        "the first copy is used"
    );
    assert_eq!(v.writable_len, 64);
    let log = mem.log();
    assert_eq!(reads_of(&log, desc_addr(0), 16), 1, "{log:?}");
    assert_eq!(reads_of(&log, desc_addr(1), 16), 1, "{log:?}");
}

#[test]
fn next_rewritten_into_a_loop_after_the_read_changes_nothing() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 16, NEXT, 1));
    ring.set_desc(1, d(BUF, 16, 0, 0));
    ring.push(0);
    mem.mutate_after(Mutation {
        after_reads: READS_BEFORE_HEAD + 2, // after descriptor 1 is read
        addr: GuestAddress(desc_addr(1)),
        bytes: d(BUF, 16, NEXT, 0).to_le_bytes().to_vec(),
    });
    let mut q = ring.queue();
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!(v.readable.len(), 2);
}

#[test]
fn avail_ring_entry_rewritten_mid_pop() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(3, d(BUF, 16, 0, 0));
    ring.push(3);
    mem.mutate_after(Mutation {
        after_reads: READS_BEFORE_HEAD, // right after the head was copied
        addr: GuestAddress(AVAIL + 4),
        bytes: 9u16.to_le_bytes().to_vec(), // now ≥ N
    });
    mem.enable_log();
    let mut q = ring.queue();
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!(v.head, 3);
    let log = mem.log();
    assert_eq!(reads_of(&log, AVAIL + 4, 2), 1, "{log:?}");
    assert_eq!(reads_of(&log, desc_addr(3), 16), 1);
    assert_eq!(
        reads_of(&log, desc_addr(9), 16),
        0,
        "the rewritten head is never used"
    );
}

#[test]
fn avail_idx_rewritten_after_the_acquire_load() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 16, 0, 0));
    ring.push(0);
    mem.mutate_after(Mutation {
        after_reads: 1,
        addr: GuestAddress(AVAIL + 2),
        bytes: 100u16.to_le_bytes().to_vec(),
    });
    let mut q = ring.queue();
    // This pop works from the index it loaded (1)...
    assert!(pop_validated(&mut q, &mem, K64).unwrap().is_some());
    // ...and the next one sees the jump and refuses (NEEDS_RESET), never a wild walk.
    assert!(matches!(
        q.pop(&*mem).err(),
        Some(QueueError::AvailIdxJump {
            avail_idx: 100,
            next_avail: 1,
            size: 8
        })
    ));
}

#[test]
fn used_idx_overwritten_by_the_guest_is_ignored() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 16, WRITE, 0));
    ring.set_desc(1, d(BUF, 16, WRITE, 0));
    ring.push(0);
    ring.push(1);
    let mut q = ring.queue();
    let a = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    q.add_used(&*mem, a.head, 16).unwrap();
    mem.write_u16(GuestAddress(USED + 2), 0x1234).unwrap(); // the "guest"
    let b = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    mem.enable_log();
    q.add_used(&*mem, b.head, 16).unwrap();
    let log = mem.log();
    assert_eq!(ring.used_idx(), 2, "our own counter, not 0x1235");
    assert_eq!(ring.used_elem(1), (1, 16), "slot 1, not slot 0x1234 % 8");
    assert!(
        log.iter().all(|x| x.write),
        "used.idx is never read back: {log:?}"
    );
}

#[test]
fn indirect_table_rewritten_after_the_first_read() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(TABLE, 32, INDIRECT, 0));
    ring.set_desc_at(TABLE, 0, d(BUF, 16, NEXT, 1));
    ring.set_desc_at(TABLE, 1, d(BUF + 0x40, 32, WRITE, 0));
    ring.push(0);
    // After the referrer and entry 0 are copied: rewrite entry 0 and grow the referrer.
    mem.mutate_after(Mutation {
        after_reads: READS_BEFORE_HEAD + 2,
        addr: GuestAddress(TABLE),
        bytes: d(MMIO_ADDR, u32::MAX, INDIRECT, 0).to_le_bytes().to_vec(),
    });
    mem.enable_log();
    let mut q = ring.queue();
    q.set_indirect(true);
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!((v.readable_len, v.writable_len), (16, 32));
    let log = mem.log();
    assert_eq!(reads_of(&log, desc_addr(0), 16), 1);
    assert_eq!(reads_of(&log, TABLE, 16), 1);
    assert_eq!(reads_of(&log, TABLE + 16, 16), 1);
}

#[test]
fn referring_descriptor_rewritten_after_the_read() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(TABLE, 16, INDIRECT, 0));
    ring.set_desc_at(TABLE, 0, d(BUF, 16, 0, 0));
    ring.set_desc_at(TABLE, 1, d(BUF, 16, 0, 0));
    ring.push(0);
    mem.mutate_after(Mutation {
        after_reads: READS_BEFORE_HEAD + 1,
        addr: GuestAddress(desc_addr(0)),
        bytes: d(TABLE, 32, INDIRECT, 0).to_le_bytes().to_vec(),
    });
    let mut q = ring.queue();
    q.set_indirect(true);
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!(v.readable.len(), 1, "the table stays one entry long");
}

/// Through the transport and a device: 8 chains, and every descriptor copied exactly once.
#[test]
fn transport_path_reads_each_descriptor_once() {
    let mem = mem();
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    let mut t = VirtioMmio::new(
        Arc::new(Mutex::new(MockDevice::new(&[8]))),
        Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new()))),
        Some(gm),
    )
    .unwrap();
    let w = |t: &mut VirtioMmio, off, v: u64| t.write(off, AccessSize::B4, v);
    w(&mut t, reg::STATUS, 1);
    w(&mut t, reg::STATUS, 3);
    w(&mut t, reg::DRIVER_FEATURES_SEL, 1);
    w(&mut t, reg::DRIVER_FEATURES, 1);
    w(&mut t, reg::STATUS, 11);
    w(&mut t, reg::QUEUE_NUM, 8);
    w(&mut t, reg::QUEUE_DESC_LOW, DESC & 0xffff_ffff);
    w(&mut t, reg::QUEUE_DRIVER_LOW, AVAIL & 0xffff_ffff);
    w(&mut t, reg::QUEUE_DEVICE_LOW, USED & 0xffff_ffff);
    w(&mut t, reg::QUEUE_READY, 1);
    w(&mut t, reg::STATUS, 15);
    let mut ring = Ring::new(mem.clone(), 8);
    for i in 0..4u16 {
        ring.set_desc(2 * i, d(BUF, 8, NEXT, 2 * i + 1));
        ring.set_desc(2 * i + 1, d(BUF + 0x100, 8, WRITE, 0));
    }
    for i in 0..8u16 {
        ring.push(2 * (i % 4));
    }
    mem.enable_log();
    w(&mut t, reg::QUEUE_NOTIFY, 0);
    assert_eq!(ring.used_idx(), 8);
    let log = mem.log();
    for i in 0..8u16 {
        assert_eq!(
            reads_of(&log, desc_addr(i), 16),
            2,
            "two pops use descriptor {i}"
        );
    }
    assert_eq!(
        log.iter()
            .filter(|a| a.ordered && !a.write && !a.fence)
            .count(),
        9,
        "one acquire load of avail.idx per pop, plus the final empty check"
    );
}

/// The value the racing `len` flipper alternates with 16: from `BUF` it runs past the end of
/// RAM, so it fails `check_range` (never the 64 KiB cap, which the race below switches off).
const LEN_OUT_OF_RAM: u32 = RAM_SIZE as u32;

/// The race's oracle, independent of any walker: the buffer a walker accepted and will use
/// lies entirely in guest RAM.
fn buffer_in_ram(mem: &dyn GuestMemoryOrdered, addr: u64, len: u64) -> bool {
    mem.check_range(GuestAddress(addr), len)
}

/// Planted bug 1, a hand-written walker: it validates its copy of descriptor 0, then uses a
/// fresh read of `len` (the bug class TEST-4's fourth planted bug models). Returns the
/// `(addr, len)` it would hand the device.
fn double_fetch_walker(mem: &dyn GuestMemoryOrdered) -> Option<(u64, u64)> {
    let x: Descriptor = mem.read_obj(GuestAddress(desc_addr(0))).ok()?;
    if x.len == 0 || !mem.check_range(GuestAddress(x.addr), u64::from(x.len)) {
        return None;
    }
    std::thread::yield_now();
    let len = mem.read_u32(GuestAddress(desc_addr(0) + 8)).ok()?; // the bug
    Some((x.addr, u64::from(len)))
}

/// Planted bug 2, on the real code path: the real `pop` + `into_validated`, followed by a
/// device model that re-reads the descriptor's `len` from guest memory instead of using the
/// validated copy. Same oracle, same race: if this is not caught, the race has no teeth.
fn rereading_device_on_the_real_walker(
    q: &mut vmm::virtio::Queue,
    mem: &vmm::memory::VecMemory,
) -> Option<(u64, u64)> {
    let v = pop_validated(q, mem, u64::MAX).ok()??;
    let d = v.writable.first()?;
    std::thread::yield_now();
    let len = mem.read_u32(GuestAddress(desc_addr(0) + 8)).ok()?; // the bug
    Some((d.addr, u64::from(len)))
}

/// One second against a thread flipping `desc.len` between 16 (valid) and a length that runs
/// past the end of RAM, with the byte cap off (`max_total = u64::MAX`) so only the range check
/// stands between the guest and an out-of-RAM buffer. Oracle: every accepted buffer is in RAM.
/// Both planted double fetches (a hand-written walker, and a re-reading device on top of the
/// real walker) are caught at least once; the real walker never is: every chain it accepts is
/// exactly the validated `(BUF, 16)`, everything else is refused as out of RAM, and a sample of
/// pops (access log on) shows descriptor 0 read exactly once per pop (MEM-7).
#[test]
fn racing_len_flip_catches_a_double_fetch_but_not_the_real_walker() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 16, WRITE, 0));
    ring.push(0);
    assert!(!buffer_in_ram(&*mem, BUF, u64::from(LEN_OUT_OF_RAM)));
    let stop = Arc::new(AtomicBool::new(false));
    let flipper = {
        let (mem, stop) = (mem.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut big = false;
            while !stop.load(Ordering::Relaxed) {
                big = !big;
                let len: u32 = if big { LEN_OUT_OF_RAM } else { 16 };
                mem.write_u32(GuestAddress(desc_addr(0) + 8), len).unwrap();
            }
        })
    };
    let third = Duration::from_millis(333);

    let (mut walker_caught, mut walker_runs) = (0u64, 0u64);
    let t0 = Instant::now();
    while t0.elapsed() < third {
        walker_runs += 1;
        if let Some((addr, len)) = double_fetch_walker(&*mem)
            && !buffer_in_ram(&*mem, addr, len)
        {
            walker_caught += 1;
        }
    }

    let (mut device_caught, mut device_runs) = (0u64, 0u64);
    let t1 = Instant::now();
    while t1.elapsed() < third {
        device_runs += 1;
        let mut q = ring.queue();
        if let Some((addr, len)) = rereading_device_on_the_real_walker(&mut q, &mem)
            && !buffer_in_ram(&*mem, addr, len)
        {
            device_caught += 1;
        }
    }

    let (mut ok, mut refused, mut real_runs, mut sampled) = (0u64, 0u64, 0u64, 0u64);
    let t2 = Instant::now();
    while t2.elapsed() < third {
        real_runs += 1;
        let sample = real_runs % 16 == 0;
        if sample {
            mem.enable_log(); // starts a fresh log
        }
        let mut q = ring.queue();
        match pop_validated(&mut q, &mem, u64::MAX) {
            Ok(Some(v)) => {
                assert_eq!(
                    v.writable,
                    vec![d(BUF, 16, WRITE, 0)],
                    "the real walker accepted a descriptor it never validated"
                );
                assert!(v.readable.is_empty() && v.writable_len == 16);
                for b in &v.writable {
                    assert!(buffer_in_ram(&*mem, b.addr, u64::from(b.len)));
                }
                ok += 1;
            }
            Err(QueueError::BufferOutOfRam { addr, len }) => {
                assert_eq!((addr, len), (BUF, LEN_OUT_OF_RAM));
                refused += 1;
            }
            other => panic!("unexpected {other:?}"),
        }
        if sample {
            let log = mem.log();
            assert_eq!(
                reads_of(&log, desc_addr(0), 16),
                1,
                "descriptor 0 copied once per pop: {log:?}"
            );
            assert_eq!(
                log.iter()
                    .filter(|a| !a.write && !a.fence && a.addr == desc_addr(0) + 8)
                    .count(),
                0,
                "len is never re-read on its own"
            );
            sampled += 1;
        }
    }
    stop.store(true, Ordering::Relaxed);
    flipper.join().unwrap();
    say(&format!(
        "racing_len_flip: double-fetch walker caught {walker_caught}/{walker_runs}; \
         re-reading device on the real walker caught {device_caught}/{device_runs}; \
         real walker {ok} ok + {refused} refused of {real_runs} ({sampled} log-sampled)"
    ));
    assert!(
        walker_caught > 0,
        "the planted double-fetch walker must be caught (the oracle has teeth)"
    );
    assert!(
        device_caught > 0,
        "the re-reading device on the real walker must be caught (the race reaches the real path)"
    );
    assert!(
        ok > 0 && refused > 0,
        "the real walker observed both values"
    );
    assert!(sampled > 0);
}
