//! Virtio: the paravirtual device family every macvmm guest disk, entropy source, console and
//! NIC speaks (architecture §6.6, §11; course ch15–ch17; virtio 1.2, OASIS `virtio-v1.2-cs01`).
//!
//! **Why virtio, and why from scratch.** Emulating a real disk controller register by register
//! costs one trap per register access. Virtio replaces the registers with *shared memory*: the
//! driver puts buffer descriptions in rings in guest RAM, rings one doorbell, and the device
//! (us) walks the rings. That shared memory is the largest attack surface of any VMM (QEMU's
//! virtio CVE history), so every byte of it is treated as hostile here (threat model §7.2).
//!
//! **The pieces** (one file each, so each lesson can show one idea):
//! - [`mmio`]: the virtio-mmio v2 *transport* (virtio 1.2 §4.2.2): the register window, the
//!   device-status state machine (§2.1), feature negotiation (§2.2) and queue setup (§4.2.3.2);
//! - [`queue`]: the *split virtqueue* (§2.7): ring placement checks, `pop` from the available
//!   ring, `add_used` to the used ring, and the `NO_INTERRUPT` check with its barrier;
//! - [`chain`]: walking one *descriptor chain* (§2.7.5), direct and indirect (§2.7.5.3), with
//!   every hardening rule of architecture §11.2 (hop budget, ordering, totals, TOCTOU);
//! - [`interrupt`]: `InterruptStatus` plus one level-sensitive line under one mutex (§4.2.2,
//!   ADR-0003), so no interrupt is ever lost;
//! - [`null`]: the device in an empty slot (DeviceID 0, §4.2.3.1.1);
//! - [`worker`] (M12): one host thread per device that runs `process_queue` off the vCPU
//!   thread, with the VQ-12 budget, notify coalescing and the RUST-7 panic stop;
//! - [`rng`] (M12): virtio-rng (§5.4), the first real device model;
//! - [`console`] (M13): virtio-console (§5.3), two queues with opposite directions, TX through
//!   the sink's `AnsiFilter` (TTY-1), RX from a bounded input queue (TTY-10).
//! - [`net`] (M24): virtio-net (§5.1), `VERSION_1 | MAC` only, TX on the worker and RX on its
//!   own thread through a `net::NetBackend` (threat model NET-5).
//!
//! The device models (rng M12, console M13, blk M14, net M24) implement [`VirtioDevice`] and
//! never touch the transport registers; the transport never parses a ring.
//!
//! **Errors are the guest's, not ours.** A [`QueueError`] or [`VirtioError`] never becomes a
//! [`crate::Error`]: the transport answers it with DEVICE_NEEDS_RESET plus a config interrupt
//! (§2.1.2, VQ-10) and a rate-limited `guest_warn!`, and the device stays dead until the driver
//! writes Status = 0.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod blk;
pub mod chain;
pub mod console;
pub mod interrupt;
pub mod mmio;
pub mod net;
pub mod null;
pub mod queue;
pub mod rng;
pub mod worker;

pub use blk::Blk;
pub use chain::{Descriptor, DescriptorChain, ValidatedChain};
pub use console::Console;
pub use interrupt::VirtioInterrupt;
pub use mmio::{QueueNotifier, VirtioMmio};
pub use net::Net;
pub use null::NullDevice;
pub use queue::Queue;
pub use rng::Rng;
pub use worker::Worker;

use crate::memory::{GuestMemoryOrdered, MemoryError};
use core::fmt;
use std::sync::Arc;

// ANCHOR: virtio_ids
/// Device IDs (virtio 1.2 §5, "Device Types"). 0 means "no device" (§4.2.3.1.1).
pub const DEVICE_ID_NONE: u32 = 0;
pub const DEVICE_ID_NET: u32 = 1;
pub const DEVICE_ID_BLOCK: u32 = 2;
pub const DEVICE_ID_CONSOLE: u32 = 3;
pub const DEVICE_ID_RNG: u32 = 4;
// ANCHOR_END: virtio_ids

// ANCHOR: virtio_features
/// Reserved feature bits (virtio 1.2 §6). Device-specific bits are 0..=23 and live with each
/// device.
pub mod features {
    /// `VIRTIO_F_INDIRECT_DESC` (§2.7.5.3): indirect descriptor tables. Offered only by blk.
    pub const INDIRECT_DESC: u64 = 1 << 28;
    /// `VIRTIO_F_EVENT_IDX` (§2.7.7.2, §2.7.10): **not offered** in v1.
    pub const EVENT_IDX: u64 = 1 << 29;
    /// `VIRTIO_F_VERSION_1` (§6.1): a modern (non-legacy) device. Required (§4.2.2: legacy
    /// interfaces are not supported by a Version 2 transport).
    pub const VERSION_1: u64 = 1 << 32;
    /// `VIRTIO_F_ACCESS_PLATFORM` (§6.1): an IOMMU translates addresses. Not offered.
    pub const ACCESS_PLATFORM: u64 = 1 << 33;
    /// `VIRTIO_F_RING_PACKED` (§2.8): the packed ring. Not offered.
    pub const RING_PACKED: u64 = 1 << 34;
    /// `VIRTIO_F_NOTIFICATION_DATA` (§6.1). Not offered.
    pub const NOTIFICATION_DATA: u64 = 1 << 38;
    /// `VIRTIO_F_RING_RESET` (§2.6.1): per-queue reset; QueueReset is RAZ. Not offered.
    pub const RING_RESET: u64 = 1 << 40;
    /// Features v1 must never offer without new hostile tests.
    pub const NEVER_OFFERED: u64 =
        EVENT_IDX | ACCESS_PLATFORM | RING_PACKED | NOTIFICATION_DATA | RING_RESET;
}
// ANCHOR_END: virtio_features

// ANCHOR: virtio_status_bits
/// Device status bits (virtio 1.2 §2.1).
pub mod status {
    pub const ACKNOWLEDGE: u32 = 1;
    pub const DRIVER: u32 = 2;
    pub const DRIVER_OK: u32 = 4;
    pub const FEATURES_OK: u32 = 8;
    pub const DEVICE_NEEDS_RESET: u32 = 64;
    pub const FAILED: u32 = 128;
}
// ANCHOR_END: virtio_status_bits

/// The largest queue size the transport accepts as `QueueNumMax` (virtio 1.2 §2.7: "Queue
/// Size … the maximum Queue Size value is 32768"; VQ-3, architecture §21.5).
pub const QUEUE_SIZE_MAX: u16 = 32768;

/// The largest bounce buffer a device allocates for one descriptor (VQ-11, architecture
/// §11.2 item 11 and §21.5). Allocated per request, zero-initialised, never reused.
pub const MAX_BOUNCE: usize = 64 * 1024;

// ANCHOR: queue_error
/// Why a ring or a descriptor chain was refused (`docs/security/threat-model.md`
/// lists each rule).
/// Every variant is something the *guest* did; the transport answers each with
/// DEVICE_NEEDS_RESET.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueError {
    /// The queue size is 0, above its maximum, or not a power of two (§2.7).
    BadSize { size: u16, max: u16 },
    /// A ring address is not aligned as §2.7 requires (16 / 2 / 4).
    Unaligned { ring: Ring, addr: u64 },
    /// A ring does not fit in one RAM region, or its end overflows.
    RingOutOfRam { ring: Ring, addr: u64, len: u64 },
    /// `avail.idx` moved by more than the queue size since we last looked.
    AvailIdxJump {
        avail_idx: u16,
        next_avail: u16,
        size: u16,
    },
    /// An avail-ring entry names a descriptor `≥ N`.
    HeadOutOfRange { head: u16, size: u16 },
    /// A descriptor's `next` is outside its table.
    NextOutOfRange { next: u16, table_len: u16 },
    /// `addr + len` overflows.
    Overflow { addr: u64, len: u32 },
    /// A buffer is not entirely inside one RAM region: outside RAM, in MMIO, or straddling
    /// the end of RAM.
    BufferOutOfRam { addr: u64, len: u32 },
    /// A zero-length descriptor.
    ZeroLength { index: u16 },
    /// More descriptors than the hop budget (`N`, or `len / 16` inside an indirect table):
    /// a loop or an over-long chain.
    ChainTooLong { budget: u16 },
    /// `F_INDIRECT` without the feature negotiated.
    IndirectNotNegotiated,
    /// `F_INDIRECT` inside an indirect table (§2.7.5.3.1).
    NestedIndirect,
    /// `F_INDIRECT` together with `F_NEXT` (§2.7.5.3.1).
    IndirectWithNext,
    /// An indirect table length that is 0, not a multiple of 16, or more than `N` entries.
    BadIndirectLen { len: u32 },
    /// A device-readable descriptor after a device-writable one (§2.7.4.2).
    ReadableAfterWritable,
    /// The chain's readable or writable total exceeds the device's `max_total`.
    TooLarge { total: u64, max: u64 },
    /// A guest-memory access failed on a ring itself (cannot happen after `validate` unless
    /// memory changed shape; kept total, never a panic).
    Memory(MemoryError),
    /// The queue already failed and the driver has not reset the device.
    Broken,
    /// The queue is not ready or has no size (a driver bug or a device bug).
    NotReady,
}
// ANCHOR_END: queue_error

/// Which ring a [`QueueError`] is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ring {
    Desc,
    Avail,
    Used,
}

impl From<MemoryError> for QueueError {
    fn from(e: MemoryError) -> QueueError {
        QueueError::Memory(e)
    }
}

impl fmt::Display for QueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // `{:?}` for every guest value (LOG-2): no guest string reaches a log raw.
        write!(f, "virtqueue: {self:?}")
    }
}

impl std::error::Error for QueueError {}

/// Why a device refused to activate or to process a queue. Guest-induced (module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VirtioError {
    /// A ring or chain was malformed.
    Queue(QueueError),
    /// The device has no queue with this index.
    NoSuchQueue(usize),
    /// The device is not activated (no memory handle, no queues).
    NotActivated,
    /// A device-specific protocol violation (a bad blk header, ...), described for the log.
    Device(&'static str),
}

impl From<QueueError> for VirtioError {
    fn from(e: QueueError) -> VirtioError {
        VirtioError::Queue(e)
    }
}

impl fmt::Display for VirtioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VirtioError::Queue(e) => write!(f, "{e}"),
            VirtioError::NoSuchQueue(i) => write!(f, "no queue {i:?}"),
            VirtioError::NotActivated => write!(f, "device not activated"),
            VirtioError::Device(what) => write!(f, "device: {what}"),
        }
    }
}

impl std::error::Error for VirtioError {}

/// What one `process_queue` call left behind (VQ-12).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueProgress {
    /// The available ring was empty when the call returned.
    Drained,
    /// The budget ran out with chains still pending: call again (the M12 worker re-queues
    /// itself after releasing the device mutex and checking its stop flag).
    MoreWork,
}

// ANCHOR: virtio_device_trait
/// A virtio device model behind the transport. The transport owns the
/// registers and the status machine; the device owns its queues once activated.
pub trait VirtioDevice: Send {
    /// The virtio device ID (§5): 2 blk, 3 console, 4 rng, 1 net; 0 for an empty slot.
    fn device_id(&self) -> u32;
    /// One entry per queue: its maximum size (a power of two, ≤ [`QUEUE_SIZE_MAX`]).
    fn queue_max_sizes(&self) -> &[u16];
    /// The features offered. MUST include [`features::VERSION_1`] and none of
    /// [`features::NEVER_OFFERED`].
    fn device_features(&self) -> u64;
    /// Called once, at a FEATURES_OK write the transport accepted (`accepted ⊆ offered`).
    fn ack_features(&mut self, accepted: u64);
    /// The size of the device configuration space in bytes: the per-device bound the
    /// transport enforces (it refuses any config access beyond it).
    fn config_len(&self) -> u32 {
        0
    }
    /// Read `data.len()` config bytes at `offset`; the transport already checked
    /// `offset + data.len() ≤ config_len()`.
    fn read_config(&self, offset: u32, data: &mut [u8]);
    /// Write config bytes (same bound). Read-only fields MUST ignore writes.
    fn write_config(&mut self, offset: u32, data: &[u8]);
    /// At DRIVER_OK, after every ready queue passed `Queue::validate`. `queues` has one entry
    /// per `queue_max_sizes` entry (check `Queue::ready`).
    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError>;
    /// Process at most `budget` chains of queue `index`, then return, so one busy
    /// queue cannot starve the others. On `Err` the
    /// caller puts the device into DEVICE_NEEDS_RESET.
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError>;
    /// Status ← 0: drop the queues and the memory handle. Nothing may use the old
    /// ring addresses afterwards.
    fn reset(&mut self);
}
// ANCHOR_END: virtio_device_trait
