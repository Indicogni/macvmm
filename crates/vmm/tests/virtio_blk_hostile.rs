//! PLAN M14 acceptance (host): the virtio-blk device model against hostile requests (virtio 1.2
//! §5.2; architecture §11.3; threat model BLK-1..BLK-7, BLK-9, VQ-8, VQ-9, VQ-11, MEM-7).
//!
//! The device is driven exactly as the worker drives it (`activate` + `process_queue`), with
//! `VecMemory` as guest RAM and [`MockDisk`] as the backend. The mock records every call, so
//! the tests can assert not only the status byte and the used `len` but also that a refused
//! request never reached the disk, that FLUSH synced exactly once, and that every bounce buffer
//! handed to the backend was freshly zeroed (VQ-11).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use virtio_support::d as desc;
use virtio_support::*;
use vmm::backend::file::BlockBackend;
use vmm::irq::TestIrq;
use vmm::memory::VecMemory;
use vmm::memory::prelude::*;
use vmm::virtio::blk::{
    BLK_BATCH_BYTES, BLK_CHAIN_MAX, BLK_CONFIG_LEN, BLK_MAX_DATA, BLK_QUEUE_SIZE, SEG_MAX,
    SIZE_MAX, blk_features, blk_status, disk_serial, req,
};
use vmm::virtio::{
    Blk, DEVICE_ID_BLOCK, QueueError, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt,
    features,
};

/// A disk in memory, with fault injection and a call log.
pub struct MockDisk {
    pub data: Mutex<Vec<u8>>,
    pub ro: bool,
    pub syncs: AtomicU64,
    pub reads: AtomicU64,
    pub writes: AtomicU64,
    pub fail_sync: AtomicBool,
    /// A read whose buffer was not all zero on entry (VQ-11 violated).
    pub dirty_buffer: AtomicBool,
}

impl MockDisk {
    pub fn new(sectors: usize, ro: bool) -> Arc<MockDisk> {
        let data = (0..sectors * 512)
            .map(|i| (i * 7 + i / 512) as u8)
            .collect();
        Arc::new(MockDisk {
            data: Mutex::new(data),
            ro,
            syncs: AtomicU64::new(0),
            reads: AtomicU64::new(0),
            writes: AtomicU64::new(0),
            fail_sync: AtomicBool::new(false),
            dirty_buffer: AtomicBool::new(false),
        })
    }
    pub fn snapshot(&self) -> Vec<u8> {
        self.data.lock().unwrap().clone()
    }
}

impl BlockBackend for MockDisk {
    fn capacity_sectors(&self) -> u64 {
        self.data.lock().unwrap().len() as u64 / 512
    }
    fn read_only(&self) -> bool {
        self.ro
    }
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if buf.iter().any(|b| *b != 0) {
            self.dirty_buffer.store(true, Ordering::SeqCst);
        }
        let d = self.data.lock().unwrap();
        let off = offset as usize;
        let n = buf.len().min(d.len().saturating_sub(off));
        buf[..n].copy_from_slice(&d[off..off + n]);
        Ok(n)
    }
    fn write_at(&self, buf: &[u8], offset: u64) -> io::Result<usize> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let mut d = self.data.lock().unwrap();
        let off = offset as usize;
        assert!(
            off + buf.len() <= d.len(),
            "write past the end reached the backend"
        );
        d[off..off + buf.len()].copy_from_slice(buf);
        Ok(buf.len())
    }
    fn sync(&self) -> io::Result<()> {
        self.syncs.fetch_add(1, Ordering::SeqCst);
        if self.fail_sync.load(Ordering::SeqCst) {
            Err(io::Error::from_raw_os_error(5))
        } else {
            Ok(())
        }
    }
}

/// Where the tests put the request parts in guest RAM.
const HDR: u64 = BUF; // 16-byte header
const STATUS: u64 = BUF + 0x100; // status byte
const DATA: u64 = BUF + 0x1000; // data buffers
/// The disk: 64 sectors (32 KiB).
const SECTORS: usize = 64;

pub struct Dev {
    pub blk: Blk,
    pub ring: Ring,
    pub mem: Arc<VecMemory>,
    pub disk: Arc<MockDisk>,
    pub vi: Arc<VirtioInterrupt>,
}

/// A device whose driver accepted every offered feature, as Linux does (write-back: FLUSH
/// negotiated). `indirect` is what the transport tells the queue.
pub fn dev_with(disk: Arc<MockDisk>, index: usize, indirect: bool) -> Dev {
    let all = Blk::new(disk.clone(), index).device_features();
    dev_accepting(disk, index, indirect, all)
}

/// A device whose driver accepted exactly `accepted` (FEATURES_OK, then DRIVER_OK).
pub fn dev_accepting(disk: Arc<MockDisk>, index: usize, indirect: bool, accepted: u64) -> Dev {
    let mem = mem();
    let ring = Ring::new(mem.clone(), BLK_QUEUE_SIZE);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let mut blk = Blk::new(disk.clone(), index);
    blk.ack_features(accepted);
    let mut q = ring.queue();
    q.set_indirect(indirect);
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    blk.activate(gm, vec![q], vi.clone()).unwrap();
    // Sentinel status: the device must overwrite it.
    mem.write_u8(GuestAddress(STATUS), 0xee).unwrap();
    Dev {
        blk,
        ring,
        mem,
        disk,
        vi,
    }
}

pub fn dev(ro: bool) -> Dev {
    dev_with(MockDisk::new(SECTORS, ro), 0, false)
}

pub fn header(kind: u32, sector: u64) -> [u8; 16] {
    let mut h = [0u8; 16];
    h[..4].copy_from_slice(&kind.to_le_bytes());
    h[8..].copy_from_slice(&sector.to_le_bytes());
    h
}

impl Dev {
    pub fn put_header(&self, kind: u32, sector: u64) {
        self.mem
            .write(GuestAddress(HDR), &header(kind, sector))
            .unwrap();
    }
    /// Chain `descs` as descriptors 0..n (F_NEXT added), publish head 0, run the device.
    pub fn submit(&mut self, descs: &[(u64, u32, u16)]) -> Result<(), VirtioError> {
        for (i, &(addr, len, flags)) in descs.iter().enumerate() {
            let last = i + 1 == descs.len();
            let flags = if last { flags } else { flags | NEXT };
            self.ring
                .set_desc(i as u16, desc(addr, len, flags, (i + 1) as u16));
        }
        self.ring.push(0);
        self.blk.process_queue(0, BLK_QUEUE_SIZE).map(|_| ())
    }
    /// A standard three-part request: header, optional data, status.
    pub fn request(&mut self, kind: u32, sector: u64, data_len: u32) -> Result<(), VirtioError> {
        self.put_header(kind, sector);
        let dir = if kind == req::OUT { 0 } else { WRITE };
        let mut descs = vec![(HDR, 16, 0)];
        if data_len > 0 {
            descs.push((DATA, data_len, dir));
        }
        descs.push((STATUS, 1, WRITE));
        self.submit(&descs)
    }
    pub fn status(&self) -> u8 {
        self.mem.read_u8(GuestAddress(STATUS)).unwrap()
    }
    /// The last used element's `len`.
    pub fn used_len(&self) -> u32 {
        let idx = self.ring.used_idx();
        assert!(idx > 0, "nothing was returned");
        self.ring.used_elem(idx - 1).1
    }
    pub fn bytes(&self, addr: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        self.mem.read(GuestAddress(addr), &mut b).unwrap();
        b
    }
    /// The request was answered with `status` and `len`, and the queue is still healthy.
    pub fn answered(&self, status: u8, len: u32) {
        assert_eq!(self.status(), status, "status byte");
        assert_eq!(self.used_len(), len, "used len (VQ-9)");
        assert!(!self.disk.dirty_buffer.load(Ordering::SeqCst), "VQ-11");
    }
}

// ---- the happy paths the hostile cases are measured against ----

#[test]
fn read_returns_the_disk_bytes_and_exact_len() {
    let mut d = dev(false);
    d.request(req::IN, 3, 1024).unwrap();
    d.answered(blk_status::OK, 1025);
    assert_eq!(d.bytes(DATA, 1024), d.disk.snapshot()[3 * 512..5 * 512]);
}

#[test]
fn write_reaches_the_disk() {
    let mut d = dev(false);
    d.mem.write(GuestAddress(DATA), &[0x5a; 512]).unwrap();
    d.request(req::OUT, 7, 512).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(&d.disk.snapshot()[7 * 512..8 * 512], &[0x5a; 512][..]);
}

#[test]
fn a_descriptor_larger_than_one_bounce_buffer_is_chunked() {
    // 256 KiB in one descriptor: four 64 KiB bounce buffers, every byte right.
    let mut d = dev_with(MockDisk::new(1024, false), 0, false);
    d.request(req::IN, 0, 256 * 1024).unwrap();
    d.answered(blk_status::OK, 256 * 1024 + 1);
    assert_eq!(d.bytes(DATA, 256 * 1024), d.disk.snapshot()[..256 * 1024]);
    assert_eq!(d.disk.reads.load(Ordering::SeqCst), 4);
}

// ---- BLK-2: bounds ----

#[test]
fn sector_past_the_end_is_ioerr_and_never_reaches_the_disk() {
    for (sector, len) in [(64, 512), (63, 1024), (u64::MAX / 512, 512)] {
        let mut d = dev(false);
        d.request(req::IN, sector, len).unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0, "sector {sector}");
        let mut d = dev(false);
        let before = d.disk.snapshot();
        d.request(req::OUT, sector, len).unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.disk.snapshot(), before);
    }
    // The last sector itself is fine.
    let mut d = dev(false);
    d.request(req::IN, 63, 512).unwrap();
    d.answered(blk_status::OK, 513);
}

#[test]
fn sector_times_512_overflow_is_ioerr_not_a_wrap() {
    // 2^55 * 512 = 2^64 wraps to offset 0: an unchecked multiply would read sector 0.
    for sector in [1u64 << 55, (1u64 << 55) + 1, u64::MAX] {
        let mut d = dev(false);
        d.request(req::IN, sector, 512).unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.bytes(DATA, 512), vec![0; 512], "sector {sector:#x}");
        assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn length_not_a_multiple_of_512_is_ioerr() {
    for len in [1u32, 100, 511, 513, 1000] {
        let mut d = dev(false);
        d.request(req::IN, 0, len).unwrap();
        d.answered(blk_status::IOERR, 1);
        let mut d = dev(false);
        d.request(req::OUT, 0, len).unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.disk.writes.load(Ordering::SeqCst), 0);
    }
}

// ---- BLK-3: the status descriptor ----

#[test]
fn missing_status_descriptor_is_needs_reset() {
    // OUT with header and data, both readable: nowhere to write a status.
    let mut d = dev(false);
    d.put_header(req::OUT, 0);
    let e = d.submit(&[(HDR, 16, 0), (DATA, 512, 0)]).unwrap_err();
    assert!(matches!(e, VirtioError::Device(_)), "{e:?}");
    assert_eq!(d.ring.used_idx(), 0, "nothing returned");
    assert_eq!(d.disk.writes.load(Ordering::SeqCst), 0);
    // A header alone.
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    assert!(d.submit(&[(HDR, 16, 0)]).is_err());
}

#[test]
fn read_only_status_descriptor_is_refused() {
    // header R, data W, status R: readable after writable is a chain error (VQ-7).
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    let e = d
        .submit(&[(HDR, 16, 0), (DATA, 512, WRITE), (STATUS, 1, 0)])
        .unwrap_err();
    assert_eq!(e, VirtioError::Queue(QueueError::ReadableAfterWritable));
    assert_eq!(d.status(), 0xee, "the status byte was not written");
    // header R, status R (no writable at all): no status byte, NEEDS_RESET.
    let mut d = dev(false);
    d.put_header(req::FLUSH, 0);
    assert!(matches!(
        d.submit(&[(HDR, 16, 0), (STATUS, 1, 0)]),
        Err(VirtioError::Device(_))
    ));
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 0);
}

#[test]
fn zero_length_status_is_refused() {
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    let e = d
        .submit(&[(HDR, 16, 0), (DATA, 512, WRITE), (STATUS, 0, WRITE)])
        .unwrap_err();
    assert!(
        matches!(e, VirtioError::Queue(QueueError::ZeroLength { .. })),
        "{e:?}"
    );
    assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn only_one_status_byte_is_written() {
    // A 16-byte status descriptor: only its last byte is the status; the rest is untouched.
    let mut d = dev(false);
    d.mem.write(GuestAddress(STATUS), &[0xcc; 16]).unwrap();
    d.put_header(req::FLUSH, 0);
    d.submit(&[(HDR, 16, 0), (STATUS, 16, WRITE)]).unwrap();
    // FLUSH has no data, so a 16-byte writable area is 15 data bytes + status: IOERR.
    let b = d.bytes(STATUS, 16);
    assert_eq!(&b[..15], &[0xcc; 15]);
    assert_eq!(b[15], blk_status::IOERR);
    assert_eq!(d.used_len(), 1);
}

// ---- BLK-1: the header ----

#[test]
fn header_shorter_than_16_bytes_is_ioerr() {
    for n in [1u32, 8, 15] {
        let mut d = dev(false);
        d.put_header(req::IN, 0);
        d.submit(&[(HDR, n, 0), (DATA, 512, WRITE), (STATUS, 1, WRITE)])
            .unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0, "{n}-byte header");
    }
}

#[test]
fn writable_header_is_ioerr() {
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    d.submit(&[(HDR, 16, WRITE), (DATA, 512, WRITE), (STATUS, 1, WRITE)])
        .unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
    // The header bytes in the writable descriptor were not overwritten as data either.
    assert_eq!(d.bytes(HDR, 16), header(req::IN, 0));
}

#[test]
fn header_is_read_exactly_once() {
    let mut d = dev(false);
    d.mem.enable_log();
    d.request(req::IN, 0, 512).unwrap();
    d.answered(blk_status::OK, 513);
    assert_eq!(reads_of(&d.mem.log(), HDR, 16), 1, "MEM-7");
}

#[test]
fn split_header_and_merged_status_follow_any_layout() {
    // §2.7.4: the header in two 8-byte pieces, data and status in one writable descriptor.
    let mut d = dev(false);
    d.put_header(req::IN, 2);
    d.submit(&[(HDR, 8, 0), (HDR + 8, 8, 0), (DATA, 513, WRITE)])
        .unwrap();
    assert_eq!(d.used_len(), 513);
    assert_eq!(d.bytes(DATA + 512, 1), vec![blk_status::OK]);
    assert_eq!(d.bytes(DATA, 512), d.disk.snapshot()[2 * 512..3 * 512]);
    // OUT with header and data in one readable descriptor.
    let mut d = dev(false);
    d.mem
        .write(GuestAddress(DATA), &header(req::OUT, 5))
        .unwrap();
    d.mem.write(GuestAddress(DATA + 16), &[0x77; 512]).unwrap();
    d.submit(&[(DATA, 16 + 512, 0), (STATUS, 1, WRITE)])
        .unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(&d.disk.snapshot()[5 * 512..6 * 512], &[0x77; 512][..]);
}

#[test]
fn wrong_data_direction_is_ioerr() {
    // IN with readable data after the header; OUT with writable data before the status.
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    d.submit(&[(HDR, 16, 0), (DATA, 512, 0), (STATUS, 1, WRITE)])
        .unwrap();
    d.answered(blk_status::IOERR, 1);
    let mut d = dev(false);
    d.put_header(req::OUT, 0);
    d.submit(&[(HDR, 16, 0), (DATA, 512, WRITE), (STATUS, 1, WRITE)])
        .unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.writes.load(Ordering::SeqCst), 0);
}

// ---- BLK-4: request types ----

#[test]
fn out_on_a_read_only_disk_is_ioerr() {
    let mut d = dev(true);
    let before = d.disk.snapshot();
    d.mem.write(GuestAddress(DATA), &[0x11; 512]).unwrap();
    d.request(req::OUT, 0, 512).unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.writes.load(Ordering::SeqCst), 0);
    assert_eq!(d.disk.snapshot(), before);
    // Reads still work, and FLUSH on a read-only disk is OK without a sync.
    d.request(req::IN, 0, 512).unwrap();
    d.answered(blk_status::OK, 513);
    d.request(req::FLUSH, 0, 0).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 0);
}

#[test]
fn unknown_type_is_unsupp() {
    for kind in [2u32, 3, 5, 7, 11, 13, 0x8000_0000, u32::MAX] {
        let mut d = dev(false);
        d.request(kind, 0, 512).unwrap();
        d.answered(blk_status::UNSUPP, 1);
        assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
        assert_eq!(d.disk.writes.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn get_id_writes_20_bytes_macvmm_disk0() {
    let mut d = dev(false);
    d.mem.write(GuestAddress(DATA), &[0xff; 32]).unwrap();
    d.request(req::GET_ID, 0, 20).unwrap();
    d.answered(blk_status::OK, 21);
    let id = d.bytes(DATA, 20);
    assert_eq!(&id[..12], b"macvmm-disk0");
    assert_eq!(&id[12..], &[0; 8]);
    assert_eq!(
        d.bytes(DATA + 20, 12),
        vec![0xff; 12],
        "nothing past 20 bytes"
    );
    // A shorter buffer gets min(20, len) bytes; a longer one still exactly 20.
    let mut d = dev(false);
    d.request(req::GET_ID, 0, 8).unwrap();
    d.answered(blk_status::OK, 9);
    assert_eq!(d.bytes(DATA, 8), b"macvmm-d");
    let mut d = dev(false);
    d.request(req::GET_ID, 0, 512).unwrap();
    d.answered(blk_status::OK, 21);
    // Disk 1's serial.
    let mut d = dev_with(MockDisk::new(8, false), 1, false);
    d.request(req::GET_ID, 0, 20).unwrap();
    assert_eq!(&d.bytes(DATA, 12), b"macvmm-disk1");
    assert_eq!(&disk_serial(10)[..13], b"macvmm-disk10");
}

#[test]
fn flush_calls_sync_once_and_reports_its_failure() {
    let mut d = dev(false);
    d.request(req::FLUSH, 0, 0).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 1);
    d.disk.fail_sync.store(true, Ordering::SeqCst);
    d.request(req::FLUSH, 0, 0).unwrap();
    d.answered(blk_status::IOERR, 1); // BLK-9: never OK before the data is durable
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 2);
}

// ---- §5.2.6 "stable" writes: write-back vs write-through ----

#[test]
fn write_back_when_flush_is_negotiated_leaves_durability_to_flush() {
    let mut d = dev(false); // every offered feature accepted, FLUSH included
    d.mem.write(GuestAddress(DATA), &[0x3c; 512]).unwrap();
    d.request(req::OUT, 2, 512).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(
        d.disk.syncs.load(Ordering::SeqCst),
        0,
        "OUT alone does not sync"
    );
    d.request(req::FLUSH, 0, 0).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 1);
}

#[test]
fn write_through_when_flush_is_not_negotiated() {
    // A minimal driver (hostile-vq's blk_up, a firmware) accepts only VERSION_1: it has no way
    // to ask for durability, so each OUT must be stable when it completes (§5.2.6).
    let mut d = dev_accepting(MockDisk::new(SECTORS, false), 0, false, features::VERSION_1);
    d.mem.write(GuestAddress(DATA), &[0x77; 1024]).unwrap();
    d.request(req::OUT, 5, 1024).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 1, "one sync per OUT");
    assert_eq!(&d.disk.snapshot()[5 * 512..7 * 512], &[0x77; 1024][..]);
    // Reads never sync.
    d.request(req::IN, 0, 512).unwrap();
    d.answered(blk_status::OK, 513);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 1);
    // A failed sync is IOERR, never OK (BLK-9 applied per write).
    d.disk.fail_sync.store(true, Ordering::SeqCst);
    d.request(req::OUT, 5, 512).unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 2);
    // A refused OUT (past the end) never reaches the backend, sync included.
    d.disk.fail_sync.store(false, Ordering::SeqCst);
    d.request(req::OUT, SECTORS as u64, 512).unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 2);
}

#[test]
fn reset_returns_to_write_through_until_features_are_acked_again() {
    let disk = MockDisk::new(SECTORS, false);
    let mut d = dev_with(disk.clone(), 0, false);
    d.blk.reset();
    // Re-activate without a new FEATURES_OK: the safe default is write-through.
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let gm: Arc<dyn GuestMemoryOrdered> = d.mem.clone();
    d.ring = Ring::new(d.mem.clone(), BLK_QUEUE_SIZE);
    d.blk.activate(gm, vec![d.ring.queue()], vi).unwrap();
    d.request(req::OUT, 0, 512).unwrap();
    d.answered(blk_status::OK, 1);
    assert_eq!(disk.syncs.load(Ordering::SeqCst), 1);
}

// ---- VQ-12: a batch is bounded by cost, not only by chain count ----

/// Post FLUSH requests as heads 0, 2, 4, … (header, status: two descriptors each).
fn post_flushes(d: &mut Dev, count: u16) {
    d.put_header(req::FLUSH, 0);
    for i in 0..count {
        let head = 2 * i;
        d.ring.set_desc(head, desc(HDR, 16, NEXT, head + 1));
        d.ring
            .set_desc(head + 1, desc(STATUS + u64::from(i), 1, WRITE, 0));
        d.ring.push(head);
    }
}

#[test]
fn a_batch_ends_after_one_sync() {
    let mut d = dev(false);
    post_flushes(&mut d, 3);
    for served in 1..=3u16 {
        let p = d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap();
        assert_eq!(
            p,
            QueueProgress::MoreWork,
            "batch {served}: the mutex goes back"
        );
        assert_eq!(d.ring.used_idx(), served, "one FLUSH per batch");
    }
    assert_eq!(
        d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap(),
        QueueProgress::Drained
    );
    assert_eq!(d.disk.syncs.load(Ordering::SeqCst), 3);
    // Write-through OUTs sync too, so they are one per batch as well.
    let mut d = dev_accepting(MockDisk::new(SECTORS, false), 0, false, features::VERSION_1);
    d.put_header(req::OUT, 0);
    for i in 0..2u16 {
        let head = 3 * i;
        d.ring.set_desc(head, desc(HDR, 16, NEXT, head + 1));
        d.ring.set_desc(head + 1, desc(DATA, 512, NEXT, head + 2));
        d.ring.set_desc(head + 2, desc(STATUS, 1, WRITE, 0));
        d.ring.push(head);
    }
    assert_eq!(
        d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap(),
        QueueProgress::MoreWork
    );
    assert_eq!(d.ring.used_idx(), 1);
}

#[test]
fn a_batch_ends_after_blk_batch_bytes() {
    // Three maximum-size (126 × 64 KiB) INs through indirect tables, all onto the same guest
    // buffer. Two of them reach BLK_BATCH_BYTES, so the third waits for the next batch.
    assert_eq!(BLK_BATCH_BYTES, 2 * BLK_MAX_DATA);
    let mut d = dev_with(MockDisk::new(1 << 15, false), 0, true); // 16 MiB disk
    d.put_header(req::IN, 0);
    let segs = SEG_MAX as u16;
    for i in 0..3u16 {
        let table = DATA + 0x1_0000 + u64::from(i) * 0x1000;
        d.ring.set_desc_at(table, 0, desc(HDR, 16, NEXT, 1));
        for s in 0..segs {
            d.ring
                .set_desc_at(table, 1 + s, desc(DATA, SIZE_MAX, WRITE | NEXT, 2 + s));
        }
        d.ring
            .set_desc_at(table, 1 + segs, desc(STATUS + u64::from(i), 1, WRITE, 0));
        d.ring
            .set_desc(i, desc(table, 16 * (u32::from(segs) + 2), INDIRECT, 0));
        d.ring.push(i);
    }
    assert_eq!(
        d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap(),
        QueueProgress::MoreWork
    );
    assert_eq!(d.ring.used_idx(), 2);
    d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap();
    assert_eq!(d.ring.used_idx(), 3);
    assert_eq!(d.ring.used_elem(2).1, BLK_MAX_DATA as u32 + 1);
}

// ---- VQ-8: size and segment caps ----

#[test]
fn data_longer_than_126_times_64k_is_ioerr() {
    // 17 overlapping 512 KiB writable descriptors: 8.5 MiB > 126 × 64 KiB.
    let seg = 512 * 1024u32;
    let mut d = dev_with(MockDisk::new(1 << 15, false), 0, false); // 16 MiB disk
    d.put_header(req::IN, 0);
    let mut descs = vec![(HDR, 16, 0)];
    descs.extend(std::iter::repeat_n((DATA, seg, WRITE), 17));
    descs.push((STATUS, 1, WRITE));
    assert!(17 * u64::from(seg) > BLK_MAX_DATA);
    d.submit(&descs).unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
    // Exactly BLK_MAX_DATA is allowed (126 × 64 KiB in 126 segments).
    let mut d = dev_with(MockDisk::new(1 << 15, false), 0, false);
    d.put_header(req::IN, 0);
    let mut descs = vec![(HDR, 16, 0)];
    descs.extend(std::iter::repeat_n(
        (DATA, SIZE_MAX, WRITE),
        SEG_MAX as usize,
    ));
    descs.push((STATUS, 1, WRITE));
    d.submit(&descs).unwrap();
    d.answered(blk_status::OK, BLK_MAX_DATA as u32 + 1);
    // Well over the cap is still IOERR, never NEEDS_RESET: BLK_MAX_DATA is not advertised, so
    // a compliant driver may send this (M19 review). 40 × 512 KiB = 20 MiB, then the largest
    // direct chain the ring allows: 254 × 512 KiB = 127 MiB.
    for n in [40usize, usize::from(BLK_QUEUE_SIZE) - 2] {
        let mut d = dev_with(MockDisk::new(1 << 15, false), 0, false);
        d.put_header(req::IN, 0);
        let mut descs = vec![(HDR, 16, 0)];
        descs.extend(std::iter::repeat_n((DATA, seg, WRITE), n));
        descs.push((STATUS, 1, WRITE));
        assert!(n as u64 * u64::from(seg) > 2 * BLK_MAX_DATA);
        d.submit(&descs).unwrap();
        d.answered(blk_status::IOERR, 1);
        assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
        // The disk keeps working: the next request is served normally.
        d.mem.write_u8(GuestAddress(STATUS), 0xee).unwrap();
        d.request(req::IN, 0, 512).unwrap();
        d.answered(blk_status::OK, 513);
    }
}

#[test]
fn no_walkable_chain_reaches_the_walk_cap() {
    // BLK_CHAIN_MAX is a walk bound, not the request cap: (queue_size - 1) direct descriptors
    // plus a queue_size-entry indirect table, each at most u32::MAX bytes, stay below it, so
    // QueueError::TooLarge can never turn an over-cap request into NEEDS_RESET.
    let most = (2 * u64::from(BLK_QUEUE_SIZE) - 1) * u64::from(u32::MAX);
    assert!(most < BLK_CHAIN_MAX);
}

#[test]
fn more_than_seg_max_segments_is_ioerr() {
    // 127 data segments of one sector (seg_max is 126).
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    let mut descs = vec![(HDR, 16, 0)];
    descs.extend(std::iter::repeat_n((DATA, 512, WRITE), 127));
    descs.push((STATUS, 1, WRITE));
    d.submit(&descs).unwrap();
    d.answered(blk_status::IOERR, 1);
    assert_eq!(d.disk.reads.load(Ordering::SeqCst), 0);
    // 126 is fine (the disk has only 64 sectors: use 32 sectors' worth).
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    let mut descs = vec![(HDR, 16, 0)];
    descs.extend(std::iter::repeat_n((DATA, 256, WRITE), 126));
    descs.push((STATUS, 1, WRITE));
    d.submit(&descs).unwrap();
    d.answered(blk_status::OK, 126 * 256 + 1);
}

// ---- the chain itself (VQ-4..VQ-6) ends in NEEDS_RESET, and the device keeps working ----

#[test]
fn hostile_chains_are_needs_reset_and_the_vmm_keeps_running() {
    // A self-loop.
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    d.ring.set_desc(0, desc(HDR, 16, NEXT, 0));
    d.ring.push(0);
    let e = d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap_err();
    assert!(matches!(
        e,
        VirtioError::Queue(QueueError::ChainTooLong { .. })
    ));
    // A data buffer in MMIO.
    let mut d = dev(false);
    d.put_header(req::IN, 0);
    let e = d
        .submit(&[(HDR, 16, 0), (MMIO_ADDR, 512, WRITE), (STATUS, 1, WRITE)])
        .unwrap_err();
    assert!(matches!(
        e,
        VirtioError::Queue(QueueError::BufferOutOfRam { .. })
    ));
    // Indirect without negotiation.
    let mut d = dev(false);
    d.ring.set_desc(0, desc(DATA, 48, INDIRECT, 0));
    d.ring.push(0);
    assert_eq!(
        d.blk.process_queue(0, BLK_QUEUE_SIZE),
        Err(VirtioError::Queue(QueueError::IndirectNotNegotiated))
    );
    // After a reset and re-activation the same device serves a good request.
    d.blk.reset();
    let ring = Ring::new(d.mem.clone(), BLK_QUEUE_SIZE);
    let gm: Arc<dyn GuestMemoryOrdered> = d.mem.clone();
    d.blk
        .activate(gm, vec![ring.queue()], d.vi.clone())
        .unwrap();
    d.ring = ring;
    d.request(req::IN, 0, 512).unwrap();
    d.answered(blk_status::OK, 513);
}

#[test]
fn indirect_requests_work_when_negotiated() {
    let mut d = dev_with(MockDisk::new(SECTORS, false), 0, true);
    d.put_header(req::IN, 4);
    let table = DATA + 0x2000;
    d.ring.set_desc_at(table, 0, desc(HDR, 16, NEXT, 1));
    d.ring
        .set_desc_at(table, 1, desc(DATA, 512, WRITE | NEXT, 2));
    d.ring.set_desc_at(table, 2, desc(STATUS, 1, WRITE, 0));
    d.ring.set_desc(0, desc(table, 48, INDIRECT, 0));
    d.ring.push(0);
    d.blk.process_queue(0, BLK_QUEUE_SIZE).unwrap();
    d.answered(blk_status::OK, 513);
    assert_eq!(d.bytes(DATA, 512), d.disk.snapshot()[4 * 512..5 * 512]);
}

// ---- features and config space ----

#[test]
fn features_and_config_space() {
    let rw = Blk::new(MockDisk::new(SECTORS, false), 0);
    let ro = Blk::new(MockDisk::new(SECTORS, true), 0);
    assert_eq!(rw.device_id(), DEVICE_ID_BLOCK);
    for (b, want_ro) in [(&rw, false), (&ro, true)] {
        let f = b.device_features();
        assert_ne!(f & features::VERSION_1, 0);
        assert_ne!(f & features::INDIRECT_DESC, 0);
        assert_eq!(f & features::NEVER_OFFERED, 0, "VQ-15");
        // M19: SIZE_MAX is not offered (FreeBSD's vtblk refuses a size_max below maxphys).
        assert_eq!(
            f & blk_features::SIZE_MAX,
            0,
            "size_max must not be offered (M19)"
        );
        for bit in [
            blk_features::SEG_MAX,
            blk_features::BLK_SIZE,
            blk_features::FLUSH,
        ] {
            assert_ne!(f & bit, 0);
        }
        // The cache mode is not guest-switchable (module docs, "Write-back or write-through").
        assert_eq!(f & blk_features::CONFIG_WCE, 0);
        assert_eq!(f & blk_features::RO != 0, want_ro);
    }
    assert_eq!(rw.config_len(), BLK_CONFIG_LEN);
    let mut c = [0u8; 24];
    rw.read_config(0, &mut c);
    assert_eq!(
        u64::from_le_bytes(c[..8].try_into().unwrap()),
        SECTORS as u64
    );
    assert_eq!(u32::from_le_bytes(c[8..12].try_into().unwrap()), SIZE_MAX);
    assert_eq!(u32::from_le_bytes(c[12..16].try_into().unwrap()), SEG_MAX);
    assert_eq!(&c[16..20], &[0; 4], "no geometry");
    assert_eq!(u32::from_le_bytes(c[20..24].try_into().unwrap()), 512);
    // Narrow reads at an offset; writes to read-only fields are ignored (VQ-13).
    let mut w = [0u8; 4];
    rw.read_config(8, &mut w);
    assert_eq!(u32::from_le_bytes(w), SIZE_MAX);
    let mut rw = rw;
    rw.write_config(0, &[0xff; 8]);
    let mut cap = [0u8; 8];
    rw.read_config(0, &mut cap);
    assert_eq!(u64::from_le_bytes(cap), SECTORS as u64);
}

#[test]
fn capacity_rounds_down_to_whole_sectors() {
    // A backend of 64 sectors + 100 bytes reports 64 sectors; the tail is unreachable.
    let disk = MockDisk::new(SECTORS, false);
    disk.data.lock().unwrap().extend_from_slice(&[0xaa; 100]);
    let mut d = dev_with(disk, 0, false);
    let mut cap = [0u8; 8];
    d.blk.read_config(0, &mut cap);
    assert_eq!(u64::from_le_bytes(cap), SECTORS as u64);
    d.request(req::IN, SECTORS as u64, 512).unwrap();
    d.answered(blk_status::IOERR, 1);
}

// ---- a model check: random requests against a reference ----

/// 10,000 random requests (PLAN §0.3), each checked against the expected status, used `len`,
/// guest bytes and disk bytes.
#[test]
fn random_requests_match_the_model() {
    let seed = seed(0xb1c);
    let mut r = XorShift::new(seed);
    let mut d = dev(false);
    let mut model = d.disk.snapshot();
    for i in 0..10_000u32 {
        let kind = [req::IN, req::OUT, req::FLUSH, req::GET_ID, 9][r.below(5) as usize];
        let sector = match r.below(4) {
            0 => r.below(80),
            1 => u64::MAX - r.below(4),
            _ => r.below(SECTORS as u64),
        };
        let len = match r.below(4) {
            0 => 512 * (1 + r.below(4) as u32),
            1 => 1 + r.below(2048) as u32,
            _ => 512,
        };
        let len = if kind == req::FLUSH { 0 } else { len };
        let fill = (r.next() & 0xff) as u8;
        if len > 0 {
            d.mem
                .write(GuestAddress(DATA), &vec![fill; len as usize])
                .unwrap();
        }
        d.request(kind, sector, len).unwrap();
        let in_range = len % 512 == 0
            && sector
                .checked_mul(512)
                .and_then(|o| o.checked_add(u64::from(len)))
                .is_some_and(|e| e <= (SECTORS * 512) as u64);
        let (status, used) = match kind {
            req::IN if in_range => (blk_status::OK, len + 1),
            req::OUT if in_range => {
                let o = sector as usize * 512;
                model[o..o + len as usize].fill(fill);
                (blk_status::OK, 1)
            }
            req::IN | req::OUT => (blk_status::IOERR, 1),
            req::FLUSH => (blk_status::OK, 1),
            req::GET_ID => (blk_status::OK, len.min(20) + 1),
            _ => (blk_status::UNSUPP, 1),
        };
        assert_eq!(
            (d.status(), d.used_len()),
            (status, used),
            "request {i} kind {kind} sector {sector:#x} len {len} (seed {seed})"
        );
        if kind == req::IN && status == blk_status::OK {
            let o = sector as usize * 512;
            assert_eq!(d.bytes(DATA, len as usize), model[o..o + len as usize]);
        }
    }
    assert_eq!(d.disk.snapshot(), model, "seed {seed}");
    assert!(!d.disk.dirty_buffer.load(Ordering::SeqCst));
}
