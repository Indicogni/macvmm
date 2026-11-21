// Checkpoint 18 contract, frozen from the reference test crates/vmm/tests/blk_short_read.rs.
// It names only items chapters 04 and 15 to 18 teach; the harness runs it against your crates.
//! Host security test: short reads and I/O errors from the block backend (see docs/security/threat-model.md).
//!
//! **Why this matters.** A disk image can shrink under a running VM (the disk lock is
//! advisory, so a non-macvmm process can truncate it), and a host disk can fail. In both cases
//! the device must:
//! - answer IOERR (never OK with a partial buffer);
//! - report a used `len` that counts only the bytes it actually produced: the guest
//!   trusts that number;
//! - never copy anything to the guest beyond what the host really read. Bounce buffers are
//!   zero-initialised per request, so even a bug that copied the whole buffer could only
//!   leak zeros, never another request's (or another disk's) data. The mock asserts
//!   that every buffer it is handed is all zeros.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use virtio_support::d as desc;
use virtio_support::*;
use vmm::backend::file::{BlockBackend, read_full, write_full};
use vmm::irq::TestIrq;
use vmm::memory::VecMemory;
use vmm::memory::prelude::*;
use vmm::virtio::blk::{BLK_QUEUE_SIZE, blk_status, req};
use vmm::virtio::{Blk, VirtioDevice, VirtioInterrupt};

/// How the faulty disk misbehaves.
#[derive(Clone, Copy, Debug)]
enum Fault {
    /// The file "shrank": everything at or after this byte reads as end of file.
    EofAt(u64),
    /// `EIO` for any read touching this byte or later.
    EioAt(u64),
    /// Every read returns at most this many bytes (a legal short read; must be retried).
    Dribble(usize),
    /// The first read fails with `EINTR` (must be retried).
    InterruptOnce,
    /// Writes at or after this byte fail with `EIO`.
    WriteEioAt(u64),
}

struct FaultyDisk {
    data: Mutex<Vec<u8>>,
    fault: Fault,
    interrupted: AtomicBool,
    calls: AtomicU64,
    dirty_buffer: AtomicBool,
}

impl FaultyDisk {
    fn new(sectors: usize, fault: Fault) -> Arc<FaultyDisk> {
        Arc::new(FaultyDisk {
            data: Mutex::new((0..sectors * 512).map(|i| (i % 251) as u8 | 1).collect()),
            fault,
            interrupted: AtomicBool::new(false),
            calls: AtomicU64::new(0),
            dirty_buffer: AtomicBool::new(false),
        })
    }
}

impl BlockBackend for FaultyDisk {
    fn capacity_sectors(&self) -> u64 {
        self.data.lock().unwrap().len() as u64 / 512
    }
    fn read_only(&self) -> bool {
        false
    }
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if buf.iter().any(|b| *b != 0) {
            self.dirty_buffer.store(true, Ordering::SeqCst);
        }
        let d = self.data.lock().unwrap();
        let mut end = d.len() as u64;
        let mut max = buf.len();
        match self.fault {
            Fault::EofAt(at) => end = end.min(at),
            Fault::EioAt(at) if offset + buf.len() as u64 > at => {
                return Err(io::Error::from_raw_os_error(5));
            }
            Fault::Dribble(n) => max = max.min(n),
            Fault::InterruptOnce if !self.interrupted.swap(true, Ordering::SeqCst) => {
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            _ => {}
        }
        let n = max.min(end.saturating_sub(offset) as usize);
        let off = offset as usize;
        buf[..n].copy_from_slice(&d[off..off + n]);
        Ok(n)
    }
    fn write_at(&self, buf: &[u8], offset: u64) -> io::Result<usize> {
        if let Fault::WriteEioAt(at) = self.fault
            && offset + buf.len() as u64 > at
        {
            return Err(io::Error::from_raw_os_error(5));
        }
        let mut d = self.data.lock().unwrap();
        let off = offset as usize;
        d[off..off + buf.len()].copy_from_slice(buf);
        Ok(buf.len())
    }
    fn sync(&self) -> io::Result<()> {
        Ok(())
    }
}

const HDR: u64 = BUF;
const STATUS: u64 = BUF + 0x100;
const DATA: u64 = BUF + 0x1000;
/// The guest's data buffers start out holding this, so "nothing was copied" is visible.
const SENTINEL: u8 = 0xee;

struct Dev {
    blk: Blk,
    ring: Ring,
    mem: Arc<VecMemory>,
    disk: Arc<FaultyDisk>,
}

fn dev(fault: Fault) -> Dev {
    let mem = mem();
    let ring = Ring::new(mem.clone(), BLK_QUEUE_SIZE);
    let disk = FaultyDisk::new(512, fault); // 256 KiB
    let mut blk = Blk::new(disk.clone(), 0);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    blk.activate(gm, vec![ring.queue()], vi).unwrap();
    mem.write(GuestAddress(DATA), &vec![SENTINEL; 0x2_0000])
        .unwrap();
    Dev {
        blk,
        ring,
        mem,
        disk,
    }
}

impl Dev {
    /// IN of `segs` writable data descriptors of `seg` bytes each, at `sector`.
    fn read(&mut self, sector: u64, segs: u16, seg: u32) -> (u8, u32) {
        let mut h = [0u8; 16];
        h[..4].copy_from_slice(&req::IN.to_le_bytes());
        h[8..].copy_from_slice(&sector.to_le_bytes());
        self.mem.write(GuestAddress(HDR), &h).unwrap();
        self.ring.set_desc(0, desc(HDR, 16, NEXT, 1));
        for i in 0..segs {
            let at = DATA + u64::from(i) * u64::from(seg);
            self.ring
                .set_desc(1 + i, desc(at, seg, WRITE | NEXT, 2 + i));
        }
        self.ring.set_desc(1 + segs, desc(STATUS, 1, WRITE, 0));
        self.ring.push(0);
        self.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap();
        let st = self.mem.read_u8(GuestAddress(STATUS)).unwrap();
        let (_, len) = self.ring.used_elem(self.ring.used_idx() - 1);
        (st, len)
    }
    fn data(&self, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        self.mem.read(GuestAddress(DATA), &mut b).unwrap();
        b
    }
    fn expected(&self, sector: u64, len: usize) -> Vec<u8> {
        let o = sector as usize * 512;
        self.disk.data.lock().unwrap()[o..o + len].to_vec()
    }
}

/// The file "shrank" mid-request: 4 sectors asked, 1.5 available → IOERR, `len` = 768 + 1, the
/// 768 bytes are the disk's, and nothing past them was touched.
#[test]
fn short_read_is_ioerr_with_the_bytes_produced() {
    let mut d = dev(Fault::EofAt(10 * 512 + 768));
    let (st, len) = d.read(10, 1, 2048);
    assert_eq!(st, blk_status::IOERR);
    assert_eq!(
        len,
        768 + 1,
        "VQ-9: only the bytes actually read, plus the status"
    );
    let got = d.data(2048);
    assert_eq!(got[..768], d.expected(10, 768)[..]);
    assert!(
        got[768..].iter().all(|b| *b == SENTINEL),
        "no byte past the short read was written to the guest"
    );
    assert!(!d.disk.dirty_buffer.load(Ordering::SeqCst), "VQ-11");
}

/// The same across descriptor boundaries: the short read lands in the second of three
/// 512-byte segments.
#[test]
fn short_read_across_segments() {
    let mut d = dev(Fault::EofAt(700));
    let (st, len) = d.read(0, 3, 512);
    assert_eq!((st, len), (blk_status::IOERR, 700 + 1));
    let got = d.data(1536);
    assert_eq!(got[..700], d.expected(0, 700)[..]);
    assert!(got[700..].iter().all(|b| *b == SENTINEL));
}

/// A read wholly past the shrunken end: IOERR, `len` = 1, the guest buffer untouched.
#[test]
fn read_entirely_past_a_shrunken_end() {
    let mut d = dev(Fault::EofAt(4096));
    let (st, len) = d.read(16, 1, 512);
    assert_eq!((st, len), (blk_status::IOERR, 1));
    assert!(d.data(512).iter().all(|b| *b == SENTINEL));
}

/// `EIO` in the second 64 KiB chunk of a 128 KiB descriptor: the first chunk was delivered,
/// the second not.
#[test]
fn eio_is_ioerr_with_the_bytes_before_it() {
    let mut d = dev(Fault::EioAt(64 * 1024 + 4096));
    let (st, len) = d.read(0, 1, 128 * 1024);
    assert_eq!(st, blk_status::IOERR);
    assert_eq!(len, 64 * 1024 + 1);
    let got = d.data(128 * 1024);
    assert_eq!(got[..64 * 1024], d.expected(0, 64 * 1024)[..]);
    assert!(got[64 * 1024..].iter().all(|b| *b == SENTINEL));
    assert!(!d.disk.dirty_buffer.load(Ordering::SeqCst));
}

/// Legal short reads (a dribbling backend) and `EINTR` are retried: the request succeeds.
#[test]
fn partial_reads_and_eintr_are_retried() {
    let mut d = dev(Fault::Dribble(100));
    let (st, len) = d.read(2, 2, 512);
    assert_eq!((st, len), (blk_status::OK, 1025));
    assert_eq!(d.data(1024), d.expected(2, 1024));
    assert!(d.disk.calls.load(Ordering::SeqCst) >= 11);
    let mut d = dev(Fault::InterruptOnce);
    let (st, len) = d.read(0, 1, 512);
    assert_eq!((st, len), (blk_status::OK, 513));
}

/// A write that fails is IOERR with `len` = 1 (nothing written to the guest).
#[test]
fn write_eio_is_ioerr() {
    let mut d = dev(Fault::WriteEioAt(1024));
    let mut h = [0u8; 16];
    h[..4].copy_from_slice(&req::OUT.to_le_bytes());
    d.mem.write(GuestAddress(HDR), &h).unwrap();
    d.ring.set_desc(0, desc(HDR, 16, NEXT, 1));
    d.ring.set_desc(1, desc(DATA, 2048, NEXT, 2));
    d.ring.set_desc(2, desc(STATUS, 1, WRITE, 0));
    d.ring.push(0);
    d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap();
    assert_eq!(
        d.mem.read_u8(GuestAddress(STATUS)).unwrap(),
        blk_status::IOERR
    );
    assert_eq!(d.ring.used_elem(0).1, 1);
}

/// The helpers themselves: `read_full` reports the count and the reason; `write_full` refuses
/// a backend that makes no progress.
#[test]
fn read_full_and_write_full() {
    let disk = FaultyDisk::new(4, Fault::EofAt(1000));
    let mut buf = vec![0u8; 2048];
    let (n, r) = read_full(&*disk, &mut buf, 0);
    assert_eq!(n, 1000);
    assert!(r.is_ok(), "end of file is a short count, not an error");
    let disk = FaultyDisk::new(4, Fault::EioAt(0));
    let (n, r) = read_full(&*disk, &mut buf, 0);
    assert_eq!(n, 0);
    assert_eq!(r.unwrap_err().raw_os_error(), Some(5));

    struct Stuck;
    impl BlockBackend for Stuck {
        fn capacity_sectors(&self) -> u64 {
            1
        }
        fn read_only(&self) -> bool {
            false
        }
        fn read_at(&self, _: &mut [u8], _: u64) -> io::Result<usize> {
            Ok(0)
        }
        fn write_at(&self, _: &[u8], _: u64) -> io::Result<usize> {
            Ok(0)
        }
        fn sync(&self) -> io::Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        write_full(&Stuck, &[1; 512], 0).unwrap_err().kind(),
        io::ErrorKind::WriteZero
    );
    assert!(write_full(&Stuck, &[], 0).is_ok());
}
