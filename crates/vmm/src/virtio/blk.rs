//! virtio-blk: the block device (virtio 1.2 §5.2 "Block Device"; architecture §11.3, §14.3;
//! threat model BLK-1..BLK-11, VQ-8, VQ-9, VQ-11; course ch18).
//!
//! **What it is.** A disk the guest drives through one virtqueue (`requestq`, §5.2.2). Every
//! request is one descriptor chain laid out as `struct virtio_blk_req` (§5.2.6):
//!
//! ```text
//! le32 type; le32 reserved; le64 sector;   16-byte header, device-readable
//! u8   data[];                             IN: device-writable; OUT: device-readable
//! u8   status;                             1 byte, device-writable, last
//! ```
//!
//! `type` is IN (0, read sectors), OUT (1, write sectors), FLUSH (4, make writes durable) or
//! GET_ID (8, a 20-byte serial number). `sector` counts 512-byte units whatever the logical
//! block size (§5.2.6). The device answers by writing the status byte, OK (0), IOERR (1) or
//! UNSUPP (2), and returning the chain with the number of bytes it wrote (§2.7.8).
//!
//! **Framing.** `VIRTIO_F_VERSION_1` implies "any layout" (§2.7.4 "Message Framing": the device
//! MUST NOT assume a particular arrangement of descriptors). So this device reads the
//! *readable* descriptors as one byte stream (header, then OUT data) and the *writable* ones as
//! another (IN or GET_ID data, then the status byte as the very last byte). Linux, U-Boot and
//! FreeBSD use one descriptor per part; a driver that merges them still works.
//!
//! **Every field is hostile** (threat model §7.3); the checks, in the order they run:
//! - the chain itself was walked and capped by `chain.rs` (VQ-4..VQ-7). Its per-direction
//!   total, [`BLK_CHAIN_MAX`], is set above anything the walk can produce, so a chain that is
//!   merely too large always reaches the IOERR checks below instead of a device reset;
//! - **BLK-3:** there must be at least one writable byte, the status, at the end of the chain.
//!   Without one there is nowhere to report an error, so the chain is a protocol violation:
//!   DEVICE_NEEDS_RESET (VQ-10). Only that one byte is written for the status;
//! - **BLK-1:** the 16-byte header is copied **once** into a local [`BlkHeader`] (MEM-7) from the
//!   readable stream. Fewer than 16 readable bytes (a short header, or a header placed in a
//!   writable descriptor) → IOERR;
//! - **segments:** at most [`SEG_MAX`] data descriptors (plus header and status) per request,
//!   and at most [`BLK_MAX_DATA`] data bytes → IOERR (VQ-8). The guest learns `seg_max` from
//!   the config space, but the byte cap is **not advertised** (see "Why `size_max` is not
//!   offered" below), so a spec-compliant driver *can* exceed it: without `size_max`, §5.2
//!   bounds only the segment count. The cap is above what Linux (default `max_sectors_kb`, a
//!   few MiB), FreeBSD (`maxphys`, 1 MiB) or U-Boot were seen to put in one request; a driver
//!   tuned for larger ones (Linux after root raises `max_sectors_kb` past 8192) gets IOERR for
//!   them, never a device reset. A known limitation, the price of not offering `size_max`;
//! - **BLK-2:** `data_len % 512 == 0`; `offset = sector.checked_mul(512)`;
//!   `offset.checked_add(data_len) ≤ capacity × 512`, else IOERR. Overflow is an error, never
//!   a wrap: `sector = 2^55` would otherwise wrap to offset 0 and read the boot sector;
//! - **BLK-4:** IN, OUT, FLUSH, GET_ID; anything else → UNSUPP. GET_ID writes
//!   `min(20, writable data bytes)` of the serial `macvmm-disk<N>`, NUL-padded (§5.2.6.1);
//! - **BLK-5:** OUT on a `,ro` disk → IOERR before the backend is touched (and the fd is
//!   `O_RDONLY` anyway, so a bypass of this check still cannot write);
//! - **BLK-6, VQ-11:** data moves through bounce buffers of at most [`MAX_BOUNCE`] bytes,
//!   allocated per chunk and **zeroed** (`vec![0; n]`), never reused across requests or disks
//!   (BLK-7). A short read or an error → IOERR, and only the bytes actually read are copied to
//!   the guest;
//! - **VQ-9:** the used `len` is the number of bytes written into writable buffers: IN data
//!   actually produced, GET_ID bytes, plus the status byte. Never the requested length;
//! - **BLK-9:** FLUSH answers OK only after `sync_all` (`F_FULLFSYNC`) returned `Ok`.
//!
//! **Write-back or write-through (§5.2.6, "stable" writes).** The device always *offers*
//! `VIRTIO_BLK_F_FLUSH`, but what a completed OUT promises depends on what the driver
//! *accepted*. The spec calls a write stable once it completed and either a later FLUSH
//! completed, or "neither VIRTIO_BLK_F_CONFIG_WCE nor VIRTIO_BLK_F_FLUSH feature were
//! negotiated, but VIRTIO_BLK_F_FLUSH was offered by the device". So:
//! - FLUSH negotiated (Linux, U-Boot, FreeBSD): **write-back**. An OUT is a `pwrite` into the
//!   host page cache, and durability is the driver's job, by sending FLUSH;
//! - FLUSH not negotiated (a minimal firmware or bare-metal driver): **write-through**. The
//!   driver has no way to ask for durability, so every OUT is followed by `sync` and answers OK
//!   only if that succeeded (BLK-9 applied per write).
//!
//! `VIRTIO_BLK_F_CONFIG_WCE` (a guest-switchable cache mode) is not offered.
//!
//! **Why `size_max` is not offered (PLAN M19, found booting FreeBSD).** `VIRTIO_BLK_F_SIZE_MAX`
//! promises that `size_max` in the config space bounds every data *segment*. Up to M18 this
//! device offered it with 64 KiB. Linux and U-Boot accept that, but FreeBSD's `vtblk` driver
//! refuses to attach to any device whose `size_max` is below its `maxphys` (1 MiB on arm64),
//! because its `sglist(9)` coalesces adjacent pages and so cannot honour a per-segment limit
//! (`sys/dev/virtio/block/virtio_blk.c`, `vtblk_attach`; observed on the console as
//! `vtblk0: host requires unsupported maximum segment size feature` / `attach returned 45`, and
//! the root file system was never found). The device never needed the promise: data moves
//! through [`MAX_BOUNCE`]-sized chunks whatever the segment size (BLK-6), so a large segment
//! costs no more memory than a small one. QEMU does not offer `VIRTIO_BLK_F_SIZE_MAX` either.
//! So the bit is no longer offered (the config field still reads [`SIZE_MAX`]; without the
//! feature the driver ignores it, §5.2.4), and the request size is bounded by [`BLK_MAX_DATA`]
//! alone: a device-side limit the driver is not told about, enforced with IOERR.
//!
//! **Batches (VQ-12).** Requests are executed one at a time, in ring order, on the worker
//! thread (architecture §14.3). One `process_queue` call holds the device mutex, which every
//! vCPU config access, `Status ← 0` reset and the worker's stop/pause checks also need. A
//! chain count alone does not bound how long that is: one chain can move 8 MiB or run a
//! `F_FULLFSYNC`. So a batch ends at whichever comes first: `budget` chains, [`BLK_BATCH_BYTES`]
//! bytes moved, or [`BLK_BATCH_SYNCS`] syncs (a FLUSH, or a write-through OUT). The worker then
//! releases the mutex, checks stop and pause, and comes back for the rest.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{
    DEVICE_ID_BLOCK, Descriptor, MAX_BOUNCE, Queue, QueueProgress, ValidatedChain, VirtioDevice,
    VirtioError, VirtioInterrupt, features,
};
use crate::backend::file::{BlockBackend, SECTOR_SIZE, read_full, write_full};
use crate::memory::{FromLeBytes, GuestAddress, GuestMemoryExt, GuestMemoryOrdered};
use std::sync::Arc;

/// The requestq's maximum size (architecture §11.3).
pub const BLK_QUEUE_SIZE: u16 = 256;
/// The value of the `size_max` config field: one bounce buffer (VQ-11). Since M19 the
/// `VIRTIO_BLK_F_SIZE_MAX` feature is **not offered** (module docs), so drivers ignore it; it
/// remains the unit of [`BLK_MAX_DATA`].
pub const SIZE_MAX: u32 = 64 * 1024;
/// `seg_max`: the most data segments per request (`VIRTIO_BLK_F_SEG_MAX`). 126 leaves room for
/// the header and status in a 128-entry indirect table, as QEMU does.
pub const SEG_MAX: u32 = 126;
/// The most data bytes one request may move (VQ-8): `seg_max × 64 KiB`, about 8 MiB. **Not
/// advertised** (module docs), so a compliant driver may send more and gets IOERR. Above
/// Linux's default `max_sectors_kb` and eight times FreeBSD's `maxphys`. It bounds how long one
/// request holds the device mutex, not memory (bounce buffers are per chunk).
pub const BLK_MAX_DATA: u64 = SEG_MAX as u64 * SIZE_MAX as u64;
/// The per-direction cap handed to `into_validated`. Deliberately **not** a request-size cap:
/// that is [`BLK_MAX_DATA`], answered with IOERR. A walk yields at most `queue_size - 1` direct
/// descriptors plus one indirect table of at most `queue_size` entries (`chain.rs`, VQ-5/VQ-6),
/// each at most `u32::MAX` bytes, so `2 × BLK_QUEUE_SIZE × u32::MAX` (just under 2 TiB) is never
/// reached and `QueueError::TooLarge` cannot fire for this device. Without that, a well-formed
/// request a little over the cap would latch DEVICE_NEEDS_RESET and kill the disk. The totals
/// are only summed (checked), never allocated, so the large value costs nothing.
pub const BLK_CHAIN_MAX: u64 = 2 * BLK_QUEUE_SIZE as u64 * u32::MAX as u64;
// The walk bound above must stay above what any accepted chain can carry.
const _: () = assert!(BLK_CHAIN_MAX >= 2 * BLK_QUEUE_SIZE as u64 * u32::MAX as u64);
const _: () = assert!(BLK_CHAIN_MAX > BLK_MAX_DATA);
/// A batch ends once it has moved at least this many data bytes (module docs, "Batches").
/// Two maximum-size requests: about 16 MiB, a few milliseconds of page-cache traffic.
pub const BLK_BATCH_BYTES: u64 = 2 * BLK_MAX_DATA;
/// A batch ends after this many backend syncs (module docs, "Batches"). One `F_FULLFSYNC` can
/// take milliseconds on an internal SSD and far longer on external media.
pub const BLK_BATCH_SYNCS: u32 = 1;
// ANCHOR: blk_wire_format
/// The request header (`struct virtio_blk_req` up to `data`, §5.2.6).
pub const BLK_HDR_LEN: u64 = 16;
/// GET_ID's buffer: "20 bytes", NUL-padded, not NUL-terminated when 20 long (§5.2.6.1).
pub const BLK_ID_BYTES: usize = 20;
/// The config space this device implements: capacity, size_max, seg_max, geometry, blk_size
/// (§5.2.4, offsets 0..24). Fields beyond belong to features that are not offered.
pub const BLK_CONFIG_LEN: u32 = 24;

// ANCHOR: blk_req_types
/// Request types (§5.2.6).
pub mod req {
    pub const IN: u32 = 0;
    pub const OUT: u32 = 1;
    pub const FLUSH: u32 = 4;
    pub const GET_ID: u32 = 8;
}

/// Status values (§5.2.6).
pub mod blk_status {
    pub const OK: u8 = 0;
    pub const IOERR: u8 = 1;
    pub const UNSUPP: u8 = 2;
}
// ANCHOR_END: blk_req_types

/// Device feature bits (§5.2.3). Only these are offered.
pub mod blk_features {
    /// `size_max` in the config space is valid. **Not offered** since M19 (module docs: FreeBSD
    /// refuses a `size_max` below its `maxphys`).
    pub const SIZE_MAX: u64 = 1 << 1;
    /// `seg_max` in the config space is valid.
    pub const SEG_MAX: u64 = 1 << 2;
    /// The device is read-only (`,ro`).
    pub const RO: u64 = 1 << 5;
    /// `blk_size` in the config space is valid.
    pub const BLK_SIZE: u64 = 1 << 6;
    /// The device accepts FLUSH (§5.2.6.2: "a write cache is present and flush is supported").
    pub const FLUSH: u64 = 1 << 9;
    /// The cache mode is guest-switchable through `writeback` in the config space. **Never
    /// offered** (module docs); listed so tests can check that.
    pub const CONFIG_WCE: u64 = 1 << 11;
}
// ANCHOR_END: blk_wire_format

/// The request header, as copied once out of guest memory (MEM-7, BLK-1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlkHeader {
    pub kind: u32,
    pub reserved: u32,
    pub sector: u64,
}

impl FromLeBytes for BlkHeader {
    type Bytes = [u8; 16];
    fn decode_le(b: [u8; 16]) -> BlkHeader {
        let [
            t0,
            t1,
            t2,
            t3,
            r0,
            r1,
            r2,
            r3,
            s0,
            s1,
            s2,
            s3,
            s4,
            s5,
            s6,
            s7,
        ] = b;
        BlkHeader {
            kind: u32::from_le_bytes([t0, t1, t2, t3]),
            reserved: u32::from_le_bytes([r0, r1, r2, r3]),
            sector: u64::from_le_bytes([s0, s1, s2, s3, s4, s5, s6, s7]),
        }
    }
}

/// What the device holds between DRIVER_OK and reset.
struct Active {
    mem: Arc<dyn GuestMemoryOrdered>,
    queue: Queue,
    irq: Arc<VirtioInterrupt>,
}

/// Request counters (numbers only: LOG-5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlkStats {
    pub reads: u64,
    pub writes: u64,
    pub flushes: u64,
    pub ids: u64,
    pub ioerr: u64,
    pub unsupp: u64,
    pub bytes_read: u64,
    pub bytes_written: u64,
}

/// The virtio-blk device model over one [`BlockBackend`] (module docs).
pub struct Blk {
    backend: Arc<dyn BlockBackend>,
    id: [u8; BLK_ID_BYTES],
    capacity_bytes: u64,
    read_only: bool,
    /// The driver accepted `VIRTIO_BLK_F_FLUSH`: write-back. `false` (the state after reset and
    /// until `ack_features`) is write-through: every OUT is synced (module docs).
    writeback: bool,
    active: Option<Active>,
    stats: BlkStats,
    /// What the current batch has cost so far (module docs, "Batches").
    batch_bytes: u64,
    batch_syncs: u32,
}

impl core::fmt::Debug for Blk {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Blk")
            .field("capacity_bytes", &self.capacity_bytes)
            .field("read_only", &self.read_only)
            .field("writeback", &self.writeback)
            .field("active", &self.active.is_some())
            .field("stats", &self.stats)
            .finish_non_exhaustive()
    }
}

/// The GET_ID serial of disk `index`: `macvmm-disk<index>`, NUL-padded to 20 bytes.
pub fn disk_serial(index: usize) -> [u8; BLK_ID_BYTES] {
    let mut id = [0u8; BLK_ID_BYTES];
    let s = format!("macvmm-disk{index}");
    for (dst, src) in id.iter_mut().zip(s.bytes()) {
        *dst = src;
    }
    id
}

/// Why a request failed with a status (as opposed to a protocol violation, which resets).
type Answer = (u8, u32); // (status, data bytes written into writable buffers)

impl Blk {
    /// Disk number `index` (its `--disk` position) over `backend`.
    pub fn new(backend: Arc<dyn BlockBackend>, index: usize) -> Blk {
        let read_only = backend.read_only();
        // Capacity in bytes, computed once; a disk too large for u64 bytes is clamped to the
        // largest whole number of sectors that fits (no real file is that large).
        let capacity_bytes = backend
            .capacity_sectors()
            .checked_mul(SECTOR_SIZE)
            .unwrap_or(u64::MAX / SECTOR_SIZE * SECTOR_SIZE);
        Blk {
            backend,
            id: disk_serial(index),
            capacity_bytes,
            read_only,
            writeback: false,
            active: None,
            stats: BlkStats::default(),
            batch_bytes: 0,
            batch_syncs: 0,
        }
    }

    /// The counters since the VM started.
    pub fn stats(&self) -> BlkStats {
        self.stats
    }

    /// The config space bytes (§5.2.4), little-endian.
    fn config(&self) -> [u8; BLK_CONFIG_LEN as usize] {
        let mut c = [0u8; BLK_CONFIG_LEN as usize];
        let fields: [(usize, &[u8]); 4] = [
            (0, &(self.capacity_bytes / SECTOR_SIZE).to_le_bytes()), // capacity (sectors)
            (8, &SIZE_MAX.to_le_bytes()),                            // size_max
            (12, &SEG_MAX.to_le_bytes()),                            // seg_max
            // 16..20: geometry, not offered (VIRTIO_BLK_F_GEOMETRY): zero.
            (20, &512u32.to_le_bytes()), // blk_size
        ];
        for (off, bytes) in fields {
            if let Some(dst) = c.get_mut(off..off.saturating_add(bytes.len())) {
                dst.copy_from_slice(bytes);
            }
        }
        c
    }

    // ANCHOR: blk_parse_request
    // ANCHOR: blk_status_rule
    /// Execute one validated chain; returns the used `len` (the bytes
    /// actually written, never the length the guest asked for). `Err` is a protocol
    /// violation that leaves nowhere to write a status (DEVICE_NEEDS_RESET).
    fn execute(
        &mut self,
        mem: &dyn GuestMemoryOrdered,
        req: &ValidatedChain,
    ) -> Result<u32, VirtioError> {
        // The status is the last writable byte, so the chain needs ≥ 1 writable byte
        // (zero-length descriptors were already refused by the walk).
        let status_at = last_byte(&req.writable).ok_or(VirtioError::Device(
            "blk request without a writable status byte",
        ))?;
        let data_in = req.writable_len.saturating_sub(1);
        let (status, written) = match self.parse_and_run(mem, req, data_in) {
            Ok(written) => (blk_status::OK, written),
            Err((status, written)) => (status, written),
        };
        match status {
            blk_status::IOERR => self.stats.ioerr = self.stats.ioerr.saturating_add(1),
            blk_status::UNSUPP => self.stats.unsupp = self.stats.unsupp.saturating_add(1),
            _ => {}
        }
        // Exactly one byte is written for the status.
        mem.write_u8(status_at, status)
            .map_err(|e| VirtioError::Queue(e.into()))?;
        Ok(written.saturating_add(1))
    }
    // ANCHOR_END: blk_status_rule

    // ANCHOR: blk_parse_header
    /// The header rule and the segment cap: the header, copied once from readable bytes only, and the
    /// OUT data length behind it. `Err` is IOERR.
    fn parse(
        mem: &dyn GuestMemoryOrdered,
        req: &ValidatedChain,
    ) -> Result<(BlkHeader, u64), Answer> {
        const IOERR: Answer = (blk_status::IOERR, 0);
        if req.readable_len < BLK_HDR_LEN {
            return Err(IOERR); // a short header, or one in a writable descriptor
        }
        let hdr = read_header(mem, &req.readable).map_err(|_| IOERR)?;
        // Segments: header + SEG_MAX data + status at most (`seg_max`).
        let descs = req.readable.len().saturating_add(req.writable.len());
        let max = usize::try_from(SEG_MAX).unwrap_or(usize::MAX);
        if descs > max.saturating_add(2) {
            return Err(IOERR);
        }
        Ok((hdr, req.readable_len.saturating_sub(BLK_HDR_LEN)))
    }
    // ANCHOR_END: blk_parse_header
    // ANCHOR_END: blk_parse_request

    // ANCHOR: blk_execute
    // ANCHOR: blk_execute_io
    /// One parsed request. `data_out` readable and `data_in` writable data
    /// bytes surround the header and the status; each type allows data in one direction only.
    /// `Ok(written)` is OK; `Err` carries the status and the data bytes already written.
    fn parse_and_run(
        &mut self,
        mem: &dyn GuestMemoryOrdered,
        req: &ValidatedChain,
        data_in: u64,
    ) -> Result<u32, Answer> {
        const IOERR: Answer = (blk_status::IOERR, 0);
        let (hdr, data_out) = Self::parse(mem, req)?;
        match hdr.kind {
            req::IN if data_out == 0 => {
                let offset = self.bounds_check(hdr.sector, data_in).ok_or(IOERR)?;
                self.read_into_guest(mem, &req.writable, offset, data_in)
            }
            req::OUT if data_in == 0 => {
                if self.read_only {
                    return Err(IOERR); // a read-only disk
                }
                let offset = self.bounds_check(hdr.sector, data_out).ok_or(IOERR)?;
                self.write_from_guest(mem, &req.readable, offset, data_out)?;
                Ok(0)
            }
            // ANCHOR_END: blk_execute_io
            // ANCHOR: blk_execute_rest
            req::FLUSH if data_out == 0 && data_in == 0 => {
                self.stats.flushes = self.stats.flushes.saturating_add(1);
                // OK only once the data is durable. A read-only disk has nothing to
                // flush (and its fd is O_RDONLY).
                if !self.read_only {
                    self.sync().map_err(|_| IOERR)?;
                }
                Ok(0)
            }
            req::GET_ID if data_out == 0 => {
                // The ID string: min(20, writable data bytes).
                let n = usize::try_from(data_in)
                    .unwrap_or(usize::MAX)
                    .min(BLK_ID_BYTES);
                let id = self.id.get(..n).unwrap_or_default();
                copy_to_guest(mem, &req.writable, 0, id).map_err(|_| IOERR)?;
                self.stats.ids = self.stats.ids.saturating_add(1);
                Ok(u32::try_from(n).unwrap_or(0))
            }
            req::IN | req::OUT | req::FLUSH | req::GET_ID => Err(IOERR), // wrong data direction
            _ => Err((blk_status::UNSUPP, 0)),
        }
    }
    // ANCHOR_END: blk_execute_rest
    // ANCHOR_END: blk_execute

    /// The backend's `sync` (`F_FULLFSYNC`), counted against the batch (module docs).
    fn sync(&mut self) -> std::io::Result<()> {
        self.batch_syncs = self.batch_syncs.saturating_add(1);
        self.backend.sync()
    }

    // ANCHOR: blk_bounds_check
    /// The byte offset of `sector`, if `len` bytes from there are a whole number of
    /// sectors, at most [`BLK_MAX_DATA`], and inside the disk. Every step is checked: a
    /// wrapped multiplication would turn a huge sector number into a small offset.
    fn bounds_check(&self, sector: u64, len: u64) -> Option<u64> {
        if !len.is_multiple_of(SECTOR_SIZE) || len > BLK_MAX_DATA {
            return None;
        }
        let offset = sector.checked_mul(SECTOR_SIZE)?;
        let end = offset.checked_add(len)?;
        (end <= self.capacity_bytes).then_some(offset)
    }
    // ANCHOR_END: blk_bounds_check

    // ANCHOR: blk_data_path
    /// IN: disk → bounce buffer → guest, chunk by chunk (a fresh, zeroed buffer). Returns the bytes written to
    /// the guest; a short read or an I/O error is IOERR with the bytes produced so far.
    fn read_into_guest(
        &mut self,
        mem: &dyn GuestMemoryOrdered,
        writable: &[Descriptor],
        offset: u64,
        len: u64,
    ) -> Result<u32, Answer> {
        let mut done: u64 = 0;
        for (addr, seg) in ranges(writable, 0, len) {
            let mut seg_done: u64 = 0;
            while seg_done < seg {
                let n = seg.saturating_sub(seg_done).min(MAX_BOUNCE as u64);
                let mut buf = vec![0u8; usize::try_from(n).unwrap_or(0)]; // fresh and zeroed
                self.batch_bytes = self.batch_bytes.saturating_add(n);
                let (got, res) = read_full(&*self.backend, &mut buf, offset.saturating_add(done));
                let got_u = u64::try_from(got).unwrap_or(0);
                if got > 0 {
                    let to = GuestAddress(addr.saturating_add(seg_done));
                    mem.write(to, buf.get(..got).unwrap_or_default())
                        .map_err(|_| (blk_status::IOERR, written(done)))?;
                }
                done = done.saturating_add(got_u);
                seg_done = seg_done.saturating_add(got_u);
                if res.is_err() || got_u < n {
                    return Err((blk_status::IOERR, written(done))); // short: the file shrank since open
                }
            }
        }
        self.stats.reads = self.stats.reads.saturating_add(1);
        self.stats.bytes_read = self.stats.bytes_read.saturating_add(done);
        Ok(written(done))
    }

    // ANCHOR_END: blk_data_path

    // ANCHOR: blk_write_path
    /// OUT: guest → bounce buffer → disk, chunk by chunk. Each guest byte is read once into a
    /// fresh buffer and written from that copy. In write-through mode (FLUSH not negotiated,
    /// module docs) the write is synced before it may answer OK (§5.2.6).
    fn write_from_guest(
        &mut self,
        mem: &dyn GuestMemoryOrdered,
        readable: &[Descriptor],
        offset: u64,
        len: u64,
    ) -> Result<(), Answer> {
        const IOERR: Answer = (blk_status::IOERR, 0);
        let mut done: u64 = 0;
        for (addr, seg) in ranges(readable, BLK_HDR_LEN, len) {
            let mut seg_done: u64 = 0;
            while seg_done < seg {
                let n = seg.saturating_sub(seg_done).min(MAX_BOUNCE as u64);
                let mut buf = vec![0u8; usize::try_from(n).unwrap_or(0)];
                mem.read(GuestAddress(addr.saturating_add(seg_done)), &mut buf)
                    .map_err(|_| IOERR)?;
                self.batch_bytes = self.batch_bytes.saturating_add(n);
                write_full(&*self.backend, &buf, offset.saturating_add(done)).map_err(|_| IOERR)?;
                done = done.saturating_add(n);
                seg_done = seg_done.saturating_add(n);
            }
        }
        if !self.writeback {
            self.sync().map_err(|_| IOERR)?; // write-through: stable before OK
        }
        self.stats.writes = self.stats.writes.saturating_add(1);
        self.stats.bytes_written = self.stats.bytes_written.saturating_add(done);
        Ok(())
    }
    // ANCHOR_END: blk_write_path
}

/// A byte count that fits a used `len` (requests are capped far below 4 GiB).
fn written(n: u64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The address of the last byte of the last descriptor in `descs`.
fn last_byte(descs: &[Descriptor]) -> Option<GuestAddress> {
    let d = descs.last()?;
    let last = u64::from(d.len).checked_sub(1)?;
    d.addr.checked_add(last).map(GuestAddress)
}

/// The guest ranges `(addr, len)` covering bytes `[start, start + len)` of the byte stream
/// formed by `descs` in order (module docs, "Framing"). The descriptors were range-checked by
/// the walk, so every piece is inside RAM.
fn ranges(descs: &[Descriptor], start: u64, len: u64) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut skip = start;
    let mut left = len;
    for d in descs {
        if left == 0 {
            break;
        }
        let dlen = u64::from(d.len);
        if skip >= dlen {
            skip = skip.saturating_sub(dlen);
            continue;
        }
        let take = dlen.saturating_sub(skip).min(left);
        out.push((d.addr.saturating_add(skip), take));
        left = left.saturating_sub(take);
        skip = 0;
    }
    out
}

/// BLK-1: copy the 16 header bytes once out of the readable stream (usually one descriptor:
/// one `read_obj`; a driver that splits the header still gets each byte read once).
fn read_header(
    mem: &dyn GuestMemoryOrdered,
    readable: &[Descriptor],
) -> Result<BlkHeader, crate::memory::MemoryError> {
    if let Some(first) = readable.first()
        && u64::from(first.len) >= BLK_HDR_LEN
    {
        return mem.read_obj::<BlkHeader>(GuestAddress(first.addr));
    }
    let mut bytes = [0u8; 16];
    let mut at: usize = 0;
    for (addr, n) in ranges(readable, 0, BLK_HDR_LEN) {
        let n = usize::try_from(n).unwrap_or(0);
        let end = at.saturating_add(n);
        if let Some(dst) = bytes.get_mut(at..end) {
            mem.read(GuestAddress(addr), dst)?;
        }
        at = end;
    }
    Ok(BlkHeader::decode_le(bytes))
}

/// Copy `data` into the writable stream starting at byte `start`.
fn copy_to_guest(
    mem: &dyn GuestMemoryOrdered,
    writable: &[Descriptor],
    start: u64,
    data: &[u8],
) -> Result<(), crate::memory::MemoryError> {
    let mut at: usize = 0;
    let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
    for (addr, n) in ranges(writable, start, len) {
        let n = usize::try_from(n).unwrap_or(0);
        let end = at.saturating_add(n);
        if let Some(src) = data.get(at..end) {
            mem.write(GuestAddress(addr), src)?;
        }
        at = end;
    }
    Ok(())
}

impl VirtioDevice for Blk {
    fn device_id(&self) -> u32 {
        DEVICE_ID_BLOCK
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &[BLK_QUEUE_SIZE]
    }
    // ANCHOR: blk_features_offer
    /// Architecture §11.3: VERSION_1, SEG_MAX, BLK_SIZE, FLUSH, INDIRECT_DESC, and RO for a
    /// `,ro` disk. Nothing in `features::NEVER_OFFERED` (VQ-15). Not SIZE_MAX (M19, module
    /// docs "Why `size_max` is not offered").
    // ANCHOR: blk_device_features
    fn device_features(&self) -> u64 {
        let mut f = features::VERSION_1
            | features::INDIRECT_DESC
            | blk_features::SEG_MAX
            | blk_features::BLK_SIZE
            | blk_features::FLUSH;
        if self.read_only {
            f |= blk_features::RO;
        }
        f
    }
    // ANCHOR_END: blk_device_features
    // ANCHOR: blk_ack_features
    /// One accepted bit changes the device: `FLUSH` selects write-back, its absence
    /// write-through (module docs, §5.2.6). The rest need nothing here: `INDIRECT_DESC` is
    /// enforced by the queue (the transport tells it), and an OUT on a read-only disk fails
    /// even if the driver ignored `RO`.
    fn ack_features(&mut self, accepted: u64) {
        self.writeback = accepted & blk_features::FLUSH != 0;
    }
    // ANCHOR_END: blk_ack_features
    // ANCHOR_END: blk_features_offer
    fn config_len(&self) -> u32 {
        BLK_CONFIG_LEN
    }
    fn read_config(&self, offset: u32, data: &mut [u8]) {
        let c = self.config();
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        match c.get(start..start.saturating_add(data.len())) {
            Some(src) => data.copy_from_slice(src),
            None => data.fill(0),
        }
    }
    /// Every implemented field is read-only (`writeback` needs `VIRTIO_BLK_F_CONFIG_WCE`, not
    /// offered): writes are ignored (VQ-13).
    fn write_config(&mut self, _offset: u32, _data: &[u8]) {}

    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        let queue = queues
            .into_iter()
            .next()
            .ok_or(VirtioError::NoSuchQueue(0))?;
        self.active = Some(Active { mem, queue, irq });
        Ok(())
    }

    /// Serve up to `budget` requests (VQ-12), one at a time, in ring order (§14.3).
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        if index != 0 {
            return Err(VirtioError::NoSuchQueue(index));
        }
        let Some(a) = self.active.take() else {
            return Err(VirtioError::NotActivated);
        };
        // `execute` needs `&mut self` for the counters, so the active state is moved out for
        // the batch and always put back, error or not.
        let mut a = a;
        let r = self.batch(&mut a, budget);
        self.active = Some(a);
        r
    }

    fn reset(&mut self) {
        // VQ-14: the queue and the memory handle go; nothing uses the old rings again. The
        // cache mode goes back to write-through until the next FEATURES_OK.
        self.active = None;
        self.writeback = false;
    }
}

impl Blk {
    // ANCHOR: blk_batch
    /// One batch: at most `budget` chains, [`BLK_BATCH_BYTES`] bytes and [`BLK_BATCH_SYNCS`]
    /// syncs (module docs, "Batches"; VQ-12). `MoreWork` hands the mutex back to the worker,
    /// which checks stop and pause and then calls again.
    fn batch(&mut self, a: &mut Active, budget: u16) -> Result<QueueProgress, VirtioError> {
        let budget = budget.min(a.queue.size()); // VQ-12: one ring's worth at most
        let mem = &*a.mem;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        self.batch_bytes = 0;
        self.batch_syncs = 0;
        for n in 0..=budget {
            let costly = self.batch_bytes >= BLK_BATCH_BYTES || self.batch_syncs >= BLK_BATCH_SYNCS;
            if n == budget || costly {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = a.queue.pop(mem)? else {
                break;
            };
            let req = chain.into_validated(BLK_CHAIN_MAX)?; // VQ-4..VQ-7; VQ-8 is in `parse`
            let len = self.execute(mem, &req)?;
            a.queue.add_used(mem, req.head, len)?; // VQ-9
            used = true;
        }
        if used && a.queue.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(progress)
    }
    // ANCHOR_END: blk_batch
}
