//! The virtio-mmio transport, version 2 (virtio 1.2 §4.2.2 "MMIO Device Register Layout",
//! §4.2.3 "MMIO-specific Initialization And Device Operation"; architecture §11.1; threat model
//! VQ-1, VQ-13..VQ-16).
//!
//! **What the transport is.** A 0x200-byte register window per slot through which the driver
//! discovers the device (Magic, Version, DeviceID), negotiates features, tells the device where
//! its rings are, and rings the doorbell (QueueNotify). It never parses a ring: that is
//! `queue.rs` and `chain.rs`, called by the device model.
//!
//! **The device status state machine** (§2.1, §3.1.1 "Driver Requirements: Device
//! Initialization"). The driver must set ACKNOWLEDGE(1), DRIVER(2), FEATURES_OK(8) and
//! DRIVER_OK(4) in that order; the transport enforces it, because each step is a point where the
//! device commits to something:
//! - **FEATURES_OK** commits to a feature set. It latches only if `accepted ⊆ offered` and
//!   `VERSION_1 ∈ accepted` (§2.2.1, §6.1); otherwise the driver reads it back clear and gives
//!   up (§3.1.1 step 6). This is also how the features v1 does not implement (`EVENT_IDX`,
//!   `RING_PACKED`, `RING_RESET`, `ACCESS_PLATFORM`, `NOTIFICATION_DATA`) stay off even when a
//!   hostile driver sets them (VQ-15).
//! - **DRIVER_OK** commits to the ring addresses: every ready queue is checked with
//!   `Queue::validate`, then the device is activated. A failure sets DEVICE_NEEDS_RESET(64) and
//!   raises a configuration interrupt (§2.1.2) instead of touching a bad ring.
//! - **Writing 0** resets the device (§4.2.2 Status). It takes the device mutex, so it waits
//!   for an in-flight worker batch (M12) to finish, then drops the queues and the memory handle:
//!   nothing uses the old ring addresses afterwards (VQ-14). FAILED(128) is latched.
//!
//! **Register hygiene.**
//! - 0x000–0x0ff accept only aligned 32-bit accesses (§4.2.2.1: "The driver MUST only use 32
//!   bit wide and aligned reads and writes"); anything else is RAZ/WI with a `guest_warn!`.
//! - Config space (0x100+) accepts 1/2/4/8-byte accesses, each checked as
//!   `offset.checked_add(size) ≤ config_len` for *this* device (VQ-13).
//! - Queue registers are frozen once that queue is ready or DRIVER_OK is set (§4.2.3.2 order),
//!   QueueNum must be a power of two in `1..=QueueNumMax`, and QueueSel beyond the last queue
//!   reads 0 and ignores writes.
//! - 64-bit ring addresses are assembled as `hi << 32 | lo`, never by adding (VQ-1).
//! - QueueNotify `≥` the number of queues is ignored with a warning; InterruptACK is masked to
//!   bits 0–1 (VQ-13, VQ-16).
//!
//! **The doorbell.** A valid QueueNotify goes to the slot's [`QueueNotifier`] (M12: the
//! device's worker thread, architecture §14.1). Without one (M11, and host tests) the transport
//! processes the queue inline on the calling vCPU thread, at most [`INLINE_BATCHES`] batches of
//! `N` chains (VQ-12), and turns any error into DEVICE_NEEDS_RESET (VQ-10).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::interrupt::INT_MASK;
use super::{
    DEVICE_ID_NONE, QUEUE_SIZE_MAX, Queue, QueueProgress, VirtioDevice, VirtioError,
    VirtioInterrupt, features, status as st,
};
use crate::bus::{AccessSize, MmioDevice};
use crate::irq::{IrqLine, NullIrq};
use crate::memory::{GuestAddress, GuestMemoryOrdered};
use crate::sync::lock;
use std::sync::{Arc, Mutex};

// ANCHOR: virtio_mmio_registers
/// Register offsets (virtio 1.2 §4.2.2, table "MMIO Device Register Layout").
pub mod reg {
    pub const MAGIC: u64 = 0x000;
    pub const VERSION: u64 = 0x004;
    pub const DEVICE_ID: u64 = 0x008;
    pub const VENDOR_ID: u64 = 0x00c;
    pub const DEVICE_FEATURES: u64 = 0x010;
    pub const DEVICE_FEATURES_SEL: u64 = 0x014;
    pub const DRIVER_FEATURES: u64 = 0x020;
    pub const DRIVER_FEATURES_SEL: u64 = 0x024;
    pub const QUEUE_SEL: u64 = 0x030;
    pub const QUEUE_NUM_MAX: u64 = 0x034;
    pub const QUEUE_NUM: u64 = 0x038;
    pub const QUEUE_READY: u64 = 0x044;
    pub const QUEUE_NOTIFY: u64 = 0x050;
    pub const INTERRUPT_STATUS: u64 = 0x060;
    pub const INTERRUPT_ACK: u64 = 0x064;
    pub const STATUS: u64 = 0x070;
    pub const QUEUE_DESC_LOW: u64 = 0x080;
    pub const QUEUE_DESC_HIGH: u64 = 0x084;
    pub const QUEUE_DRIVER_LOW: u64 = 0x090;
    pub const QUEUE_DRIVER_HIGH: u64 = 0x094;
    pub const QUEUE_DEVICE_LOW: u64 = 0x0a0;
    pub const QUEUE_DEVICE_HIGH: u64 = 0x0a4;
    /// RAZ/WI: `VIRTIO_F_RING_RESET` is not offered (VQ-15).
    pub const QUEUE_RESET: u64 = 0x0c0;
    pub const CONFIG_GENERATION: u64 = 0x0fc;
    /// Device-specific configuration space starts here.
    pub const CONFIG: u64 = 0x100;
}

/// `"virt"` little-endian (§4.2.2 MagicValue).
pub const MAGIC_VALUE: u32 = 0x7472_6976;
/// The non-legacy virtio-mmio version (§4.2.2 Version).
pub const MMIO_VERSION: u32 = 2;
/// macvmm's VendorID: "MMVM" read as a little-endian u32 (any value is allowed, §4.2.2).
pub const VENDOR_ID: u32 = 0x4d56_4d4d;
/// The size of one transport window (PLAN §1: slots are 0x200 apart).
pub const WINDOW_SIZE: u64 = 0x200;
// ANCHOR_END: virtio_mmio_registers

/// Without a [`QueueNotifier`], one QueueNotify processes at most this many batches of `N`
/// chains on the vCPU thread before returning (VQ-12: the guest cannot keep its own vCPU, or
/// the device mutex, forever).
pub const INLINE_BATCHES: usize = 4;

/// Where a valid QueueNotify goes (M12: the device worker). Must not block.
pub trait QueueNotifier: Send + Sync {
    fn notify(&self, queue: usize);
}

/// The status values the driver may write, in order (§3.1.1): each is the previous plus one bit.
const STATUS_STEPS: [u32; 4] = [
    st::ACKNOWLEDGE,
    st::ACKNOWLEDGE | st::DRIVER,
    st::ACKNOWLEDGE | st::DRIVER | st::FEATURES_OK,
    st::ACKNOWLEDGE | st::DRIVER | st::FEATURES_OK | st::DRIVER_OK,
];

/// One virtio-mmio transport (module docs). It is the `MmioDevice` the bus sees for a slot.
pub struct VirtioMmio {
    device: Arc<Mutex<dyn VirtioDevice>>,
    device_id: u32,
    device_features: u64,
    config_len: u32,
    max_sizes: Vec<u16>,
    interrupt: Arc<VirtioInterrupt>,
    mem: Option<Arc<dyn GuestMemoryOrdered>>,
    notifier: Option<Arc<dyn QueueNotifier>>,
    status: u32,
    device_features_sel: u32,
    driver_features_sel: u32,
    driver_features: u64,
    /// The driver wrote a non-zero word to DriverFeatures with a selector beyond bit 63: bits
    /// nobody offered, so FEATURES_OK must fail (`accepted ⊆ offered`).
    driver_features_beyond: bool,
    queue_sel: u32,
    queues: Vec<Queue>,
    config_generation: u32,
}

impl core::fmt::Debug for VirtioMmio {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VirtioMmio")
            .field("device_id", &self.device_id)
            .field("status", &self.status)
            .field("queues", &self.queues)
            .finish_non_exhaustive()
    }
}

impl VirtioMmio {
    /// A transport for `device`, raising `interrupt`, whose rings live in `mem` (`None` only
    /// for a device that never activates, such as [`super::NullDevice`]).
    ///
    /// Refuses (a macvmm bug, never a guest's doing) a device that does not offer `VERSION_1`,
    /// offers a feature v1 must not offer (VQ-15), or has a queue size that is not a power of
    /// two in `1..=QUEUE_SIZE_MAX`.
    pub fn new(
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<VirtioInterrupt>,
        mem: Option<Arc<dyn GuestMemoryOrdered>>,
    ) -> Result<VirtioMmio, &'static str> {
        let (device_id, device_features, config_len, max_sizes) = {
            let d = lock(&device);
            (
                d.device_id(),
                d.device_features(),
                d.config_len(),
                d.queue_max_sizes().to_vec(),
            )
        };
        if device_id != DEVICE_ID_NONE {
            if device_features & features::VERSION_1 == 0 {
                return Err("a virtio device must offer VIRTIO_F_VERSION_1");
            }
            if device_features & features::NEVER_OFFERED != 0 {
                return Err("a virtio device offers a feature v1 does not implement (VQ-15)");
            }
            if max_sizes
                .iter()
                .any(|&n| n == 0 || n > QUEUE_SIZE_MAX || !n.is_power_of_two())
            {
                return Err("a virtio queue size must be a power of two up to 32768");
            }
            if u64::from(config_len) > WINDOW_SIZE.saturating_sub(reg::CONFIG) {
                return Err("a virtio config space must fit in the 0x200-byte window");
            }
        }
        let queues = max_sizes.iter().map(|&n| Queue::new(n)).collect();
        Ok(VirtioMmio {
            device,
            device_id,
            device_features,
            config_len,
            max_sizes,
            interrupt,
            mem,
            notifier: None,
            status: 0,
            device_features_sel: 0,
            driver_features_sel: 0,
            driver_features: 0,
            driver_features_beyond: false,
            queue_sel: 0,
            queues,
            config_generation: 0,
        })
    }

    /// An empty slot: a [`super::NullDevice`] with an unconnected line.
    pub fn empty() -> VirtioMmio {
        let line: Arc<dyn IrqLine> = Arc::new(NullIrq);
        let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(super::NullDevice));
        VirtioMmio {
            device,
            device_id: DEVICE_ID_NONE,
            device_features: 0,
            config_len: 0,
            max_sizes: Vec::new(),
            interrupt: Arc::new(VirtioInterrupt::new(line)),
            mem: None,
            notifier: None,
            status: 0,
            device_features_sel: 0,
            driver_features_sel: 0,
            driver_features: 0,
            driver_features_beyond: false,
            queue_sel: 0,
            queues: Vec::new(),
            config_generation: 0,
        }
    }

    /// Send valid doorbells to `n` instead of processing inline (M12).
    pub fn set_notifier(&mut self, n: Option<Arc<dyn QueueNotifier>>) {
        self.notifier = n;
    }

    /// The device's interrupt state (shared with the device and its worker).
    pub fn interrupt(&self) -> &Arc<VirtioInterrupt> {
        &self.interrupt
    }

    /// The device behind the transport.
    pub fn device(&self) -> &Arc<Mutex<dyn VirtioDevice>> {
        &self.device
    }

    /// The transport's copy of queue `i`'s registers (the device holds its own after
    /// activation).
    pub fn queue(&self, i: usize) -> Option<&Queue> {
        self.queues.get(i)
    }

    /// The Status register as the driver reads it.
    pub fn status(&self) -> u32 {
        if self.interrupt.needs_reset() {
            self.status | st::DEVICE_NEEDS_RESET
        } else {
            self.status
        }
    }

    /// The device changed its configuration (M14 capacity, M24 link): bump ConfigGeneration
    /// (§4.2.2: the driver re-reads config until the generation is stable) and raise a
    /// configuration interrupt (§2.5.1).
    pub fn config_changed(&mut self) {
        self.config_generation = self.config_generation.wrapping_add(1);
        self.interrupt.signal_config();
    }

    /// The selected queue, if QueueSel names one.
    fn selected(&self) -> Option<&Queue> {
        self.queues.get(usize::try_from(self.queue_sel).ok()?)
    }

    /// The selected queue if its registers may still change (not ready, no DRIVER_OK).
    fn selected_writable(&mut self, what: &str) -> Option<&mut Queue> {
        let frozen = self.status & st::DRIVER_OK != 0;
        let sel = self.queue_sel;
        let Some(q) = usize::try_from(sel).ok().and_then(|i| self.queues.get_mut(i)) else {
            crate::guest_warn!("virtio-mmio: {what} for queue {sel:?}, which does not exist");
            return None;
        };
        if frozen || q.ready() {
            crate::guest_warn!(
                "virtio-mmio: {what} for queue {sel:?} ignored: the queue is ready or DRIVER_OK is set"
            );
            return None;
        }
        Some(q)
    }

    fn read_reg(&self, offset: u64) -> u32 {
        if self.device_id == DEVICE_ID_NONE {
            // §4.2.3.1.1: an empty slot is Magic + Version + DeviceID 0; the rest is RAZ.
            return match offset {
                reg::MAGIC => MAGIC_VALUE,
                reg::VERSION => MMIO_VERSION,
                _ => 0,
            };
        }
        match offset {
            reg::MAGIC => MAGIC_VALUE,
            reg::VERSION => MMIO_VERSION,
            reg::DEVICE_ID => self.device_id,
            reg::VENDOR_ID => VENDOR_ID,
            reg::DEVICE_FEATURES => {
                let [lo, hi] = split(self.device_features);
                match self.device_features_sel {
                    0 => lo,
                    1 => hi,
                    _ => 0,
                }
            }
            reg::QUEUE_NUM_MAX => self.selected().map_or(0, |q| u32::from(q.max_size())),
            reg::QUEUE_READY => self.selected().map_or(0, |q| u32::from(q.ready())),
            reg::INTERRUPT_STATUS => self.interrupt.status(),
            reg::STATUS => self.status(),
            reg::QUEUE_RESET => 0,
            reg::CONFIG_GENERATION => self.config_generation,
            _ => {
                crate::guest_debug!(
                    "virtio-mmio: read of write-only or reserved register {offset:#x} (RAZ)"
                );
                0
            }
        }
    }

    fn write_reg(&mut self, offset: u64, v: u32) {
        if self.device_id == DEVICE_ID_NONE {
            crate::guest_debug!("virtio-mmio: write to an empty slot at {offset:#x} (WI)");
            return;
        }
        match offset {
            reg::DEVICE_FEATURES_SEL => self.device_features_sel = v,
            reg::DRIVER_FEATURES_SEL => self.driver_features_sel = v,
            reg::DRIVER_FEATURES => self.write_driver_features(v),
            reg::QUEUE_SEL => self.queue_sel = v,
            reg::QUEUE_NUM => {
                if let Some(q) = self.selected_writable("QueueNum") {
                    match u16::try_from(v) {
                        Ok(n) if q.size_ok(n) => q.set_size(n),
                        _ => crate::guest_warn!(
                            "virtio-mmio: QueueNum {v:?} ignored: not a power of two in 1..={:?}",
                            q.max_size()
                        ),
                    }
                }
            }
            reg::QUEUE_READY => {
                if let Some(q) = self.selected_writable_ready() {
                    match v {
                        0 => q.set_ready(false),
                        1 => q.set_ready(true),
                        _ => crate::guest_warn!("virtio-mmio: QueueReady {v:?} ignored"),
                    }
                }
            }
            reg::QUEUE_NOTIFY => self.notify(v),
            reg::INTERRUPT_ACK => self.interrupt.ack(v & INT_MASK),
            reg::STATUS => self.write_status(v),
            reg::QUEUE_DESC_LOW | reg::QUEUE_DESC_HIGH => {
                self.write_ring_addr(offset, v, Queue::desc_table, Queue::set_desc_table)
            }
            reg::QUEUE_DRIVER_LOW | reg::QUEUE_DRIVER_HIGH => {
                self.write_ring_addr(offset, v, Queue::avail_ring, Queue::set_avail_ring)
            }
            reg::QUEUE_DEVICE_LOW | reg::QUEUE_DEVICE_HIGH => {
                self.write_ring_addr(offset, v, Queue::used_ring, Queue::set_used_ring)
            }
            _ => crate::guest_debug!(
                "virtio-mmio: write to read-only or reserved register {offset:#x} (WI)"
            ),
        }
    }

    /// QueueReady may go 1 → 0 before DRIVER_OK, so only DRIVER_OK freezes it.
    fn selected_writable_ready(&mut self) -> Option<&mut Queue> {
        if self.status & st::DRIVER_OK != 0 {
            crate::guest_warn!("virtio-mmio: QueueReady ignored after DRIVER_OK");
            return None;
        }
        let sel = self.queue_sel;
        let q = usize::try_from(sel).ok().and_then(|i| self.queues.get_mut(i));
        if q.is_none() {
            crate::guest_warn!("virtio-mmio: QueueReady for queue {sel:?}, which does not exist");
        }
        q
    }

    /// One half of a 64-bit ring address: `hi << 32 | lo`, never an addition (VQ-1).
    fn write_ring_addr(
        &mut self,
        offset: u64,
        v: u32,
        get: fn(&Queue) -> GuestAddress,
        set: fn(&mut Queue, GuestAddress),
    ) {
        let high = !offset.is_multiple_of(8); // the High halves sit at 0x084, 0x094, 0x0a4
        if let Some(q) = self.selected_writable("a ring address") {
            let [lo, hi] = split(get(q).0);
            let (lo, hi) = if high { (lo, v) } else { (v, hi) };
            set(q, GuestAddress(join(lo, hi)));
        }
    }

    fn write_driver_features(&mut self, v: u32) {
        if self.status & st::DRIVER == 0 || self.status & st::FEATURES_OK != 0 {
            crate::guest_warn!(
                "virtio-mmio: DriverFeatures ignored in status {:?} (§3.1.1 order)",
                self.status
            );
            return;
        }
        let [lo, hi] = split(self.driver_features);
        match self.driver_features_sel {
            0 => self.driver_features = join(v, hi),
            1 => self.driver_features = join(lo, v),
            _ => {
                if v != 0 {
                    self.driver_features_beyond = true;
                }
            }
        }
    }

    // ANCHOR: virtio_status_machine
    /// A Status write (module docs; §2.1, §3.1.1, VQ-14).
    fn write_status(&mut self, v: u32) {
        if v == 0 {
            self.reset();
            return;
        }
        if v & st::FAILED != 0 {
            // The driver gave up (§2.1): latched until reset; the device does nothing more.
            self.status |= st::FAILED;
            return;
        }
        if self.status & st::FAILED != 0 || self.interrupt.needs_reset() {
            crate::guest_warn!(
                "virtio-mmio: Status {v:?} ignored: the device needs a reset (write 0)"
            );
            return;
        }
        // Bits are only ever added, and only in the order of STATUS_STEPS.
        if self.status & !v != 0 || !STATUS_STEPS.contains(&v) {
            crate::guest_warn!(
                "virtio-mmio: Status {v:?} after {:?} ignored: bits out of order",
                self.status
            );
            return;
        }
        let added = v & !self.status;
        if added & st::FEATURES_OK != 0 && !self.features_ok() {
            // Not latched: the driver reads FEATURES_OK back clear and must give up (§3.1.1).
            self.status = v & (st::ACKNOWLEDGE | st::DRIVER);
            return;
        }
        self.status = v;
        if added & st::DRIVER_OK != 0 {
            self.driver_ok();
        }
    }
    // ANCHOR_END: virtio_status_machine

    // ANCHOR: virtio_features_ok
    /// FEATURES_OK: `accepted ⊆ offered` and `VERSION_1 ∈ accepted` (§2.2.1, §6.1; VQ-15).
    /// On success the device learns the set and the queues learn whether indirect descriptors
    /// were negotiated (VQ-6).
    fn features_ok(&mut self) -> bool {
        let accepted = self.driver_features;
        let unoffered = accepted & !self.device_features;
        if unoffered != 0 || self.driver_features_beyond {
            crate::guest_warn!(
                "virtio-mmio: FEATURES_OK refused: features {unoffered:#x?} were not offered"
            );
            return false;
        }
        if accepted & features::VERSION_1 == 0 {
            crate::guest_warn!("virtio-mmio: FEATURES_OK refused: VIRTIO_F_VERSION_1 not accepted");
            return false;
        }
        lock(&self.device).ack_features(accepted);
        let indirect = accepted & features::INDIRECT_DESC != 0;
        for q in &mut self.queues {
            q.set_indirect(indirect);
        }
        true
    }
    // ANCHOR_END: virtio_features_ok

    /// DRIVER_OK: validate every ready queue, then activate; any failure → NEEDS_RESET.
    fn driver_ok(&mut self) {
        let Some(mem) = self.mem.clone() else {
            crate::guest_warn!("virtio-mmio: DRIVER_OK on a device without guest memory");
            self.interrupt.set_needs_reset();
            return;
        };
        for (i, q) in self.queues.iter().enumerate() {
            if q.ready()
                && let Err(e) = q.validate(&*mem)
            {
                crate::guest_warn!("virtio-mmio: queue {i:?} refused at DRIVER_OK: {e}");
                self.interrupt.set_needs_reset();
                return;
            }
        }
        let r = lock(&self.device).activate(
            mem,
            self.queues.clone(),
            Arc::clone(&self.interrupt),
        );
        if let Err(e) = r {
            crate::guest_warn!("virtio-mmio: activation failed: {e}");
            self.interrupt.set_needs_reset();
        }
    }

    /// Status ← 0 (VQ-14): the device mutex is taken first, so an in-flight worker batch
    /// finishes before the queues and the memory handle are dropped.
    fn reset(&mut self) {
        lock(&self.device).reset();
        self.queues = self.max_sizes.iter().map(|&n| Queue::new(n)).collect();
        self.status = 0;
        self.device_features_sel = 0;
        self.driver_features_sel = 0;
        self.driver_features = 0;
        self.driver_features_beyond = false;
        self.queue_sel = 0;
        self.interrupt.reset();
    }

    /// QueueNotify (VQ-13): only for an activated, healthy device and an existing ready queue.
    fn notify(&mut self, v: u32) {
        if self.status & st::DRIVER_OK == 0
            || self.status & st::FAILED != 0
            || self.interrupt.needs_reset()
        {
            crate::guest_warn!(
                "virtio-mmio: QueueNotify {v:?} ignored in status {:?}",
                self.status()
            );
            return;
        }
        let Some(index) = usize::try_from(v)
            .ok()
            .filter(|i| self.queues.get(*i).is_some_and(Queue::ready))
        else {
            crate::guest_warn!(
                "virtio-mmio: QueueNotify {v:?} ignored: no such ready queue ({:?} queues)",
                self.queues.len()
            );
            return;
        };
        match &self.notifier {
            Some(n) => n.notify(index),
            None => self.process_inline(index),
        }
    }

    /// Process queue `index` on this thread (no worker yet: M11, host tests).
    fn process_inline(&self, index: usize) {
        let budget = self
            .queues
            .get(index)
            .map_or(0, |q| q.size());
        let mut d = lock(&self.device);
        for _ in 0..INLINE_BATCHES {
            match d.process_queue(index, budget) {
                Ok(QueueProgress::Drained) => return,
                Ok(QueueProgress::MoreWork) => {}
                Err(e) => {
                    report_error(&self.interrupt, index, &e);
                    return;
                }
            }
        }
    }

    fn read_config(&self, offset: u64, size: AccessSize) -> u64 {
        let Some((off, n)) = self.config_range(offset, size) else {
            return 0;
        };
        let mut buf = [0u8; 8];
        if let Some(dst) = buf.get_mut(..n) {
            lock(&self.device).read_config(off, dst);
        }
        u64::from_le_bytes(buf)
    }

    fn write_config(&mut self, offset: u64, size: AccessSize, value: u64) {
        let Some((off, n)) = self.config_range(offset, size) else {
            return;
        };
        let bytes = value.to_le_bytes();
        if let Some(src) = bytes.get(..n) {
            lock(&self.device).write_config(off, src);
        }
    }

    /// `(config offset, length)` if `[offset, offset + size)` lies inside this device's config
    /// space (VQ-13); otherwise RAZ/WI with a warning.
    fn config_range(&self, offset: u64, size: AccessSize) -> Option<(u32, usize)> {
        let off = offset.checked_sub(reg::CONFIG)?;
        let end = off.checked_add(size.bytes());
        if self.device_id == DEVICE_ID_NONE || end.is_none_or(|e| e > u64::from(self.config_len))
        {
            crate::guest_warn!(
                "virtio-mmio: config access of {:?} bytes at {off:#x} outside the {:?}-byte config space (RAZ/WI)",
                size.bytes(),
                self.config_len
            );
            return None;
        }
        Some((
            u32::try_from(off).ok()?,
            usize::try_from(size.bytes()).ok()?,
        ))
    }
}

/// Put the device into DEVICE_NEEDS_RESET after a queue error (VQ-10): a config interrupt and
/// one rate-limited warning; nothing more is processed until Status = 0. Used by the inline
/// path here and by the M12 worker.
pub fn report_error(interrupt: &VirtioInterrupt, queue: usize, err: &VirtioError) {
    crate::guest_warn!("virtio: queue {queue:?} failed, device needs reset: {err}");
    interrupt.set_needs_reset();
}

/// `[low 32 bits, high 32 bits]` of `v`.
fn split(v: u64) -> [u32; 2] {
    let b = v.to_le_bytes();
    let [l0, l1, l2, l3, h0, h1, h2, h3] = b;
    [
        u32::from_le_bytes([l0, l1, l2, l3]),
        u32::from_le_bytes([h0, h1, h2, h3]),
    ]
}

/// `u64::from(hi) << 32 | u64::from(lo)` (VQ-1), spelled with bytes so no shift can overflow.
fn join(lo: u32, hi: u32) -> u64 {
    let [l0, l1, l2, l3] = lo.to_le_bytes();
    let [h0, h1, h2, h3] = hi.to_le_bytes();
    u64::from_le_bytes([l0, l1, l2, l3, h0, h1, h2, h3])
}

impl MmioDevice for VirtioMmio {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        if offset >= reg::CONFIG {
            return self.read_config(offset, size);
        }
        if size != AccessSize::B4 || !offset.is_multiple_of(4) {
            // §4.2.2.1: control registers take aligned 32-bit accesses only (VQ-13).
            crate::guest_warn!(
                "virtio-mmio: {:?}-byte read at {offset:#x} is not an aligned 32-bit access (RAZ)",
                size.bytes()
            );
            return 0;
        }
        u64::from(self.read_reg(offset))
    }

    fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
        if offset >= reg::CONFIG {
            self.write_config(offset, size, value);
            return;
        }
        if size != AccessSize::B4 || !offset.is_multiple_of(4) {
            crate::guest_warn!(
                "virtio-mmio: {:?}-byte write at {offset:#x} is not an aligned 32-bit access (WI)",
                size.bytes()
            );
            return;
        }
        let [lo, _] = split(value);
        self.write_reg(offset, lo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_join() {
        assert_eq!(split(0x1122_3344_5566_7788), [0x5566_7788, 0x1122_3344]);
        assert_eq!(join(0x5566_7788, 0x1122_3344), 0x1122_3344_5566_7788);
        let mut e = VirtioMmio::empty();
        assert_eq!(e.read(reg::MAGIC, AccessSize::B4), u64::from(MAGIC_VALUE));
        assert_eq!(e.read(reg::VERSION, AccessSize::B4), 2);
        assert_eq!(e.read(reg::DEVICE_ID, AccessSize::B4), 0);
        e.write(reg::STATUS, AccessSize::B4, 1);
        assert_eq!(e.read(reg::STATUS, AccessSize::B4), 0);
    }
}
