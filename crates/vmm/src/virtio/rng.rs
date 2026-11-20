//! virtio-rng: the entropy device (virtio 1.2 §5.4 "Entropy Device"; architecture §11.3;
//! threat model VQ-8, VQ-11, FDT-3; course ch17).
//!
//! **What it is for.** A freshly booted guest has almost no entropy of its own: no disk
//! timings, no keyboard, a deterministic boot path. The device tree's `rng-seed` (M7) gives
//! Linux one 64-byte seed at boot; virtio-rng gives it a *source*, so `/dev/hwrng` and the
//! kernel's `hwrng` fill thread can draw fresh host randomness at any time. It is also the
//! smallest real virtio device there is, which is why ch17 builds it first:
//!
//! - device ID 4, **one queue** (`requestq`, §5.4.2), no feature bits of its own (§5.4.3), no
//!   configuration space (§5.4.4);
//! - the driver posts **device-writable** buffers; the device fills them with random bytes and
//!   returns each chain with the number of bytes written (§5.4.6: "the device MUST place one or
//!   more random bytes into the buffer ... MAY return fewer bytes than the buffer holds").
//!
//! **Where the bytes come from (FDT-3).** `backend::entropy::Entropy`, the host CSPRNG through
//! `getentropy(2)` in ≤ 256-byte calls. It is a syscall, not a path: nothing is opened after
//! setup, so the device keeps working under the M22 sandbox lockdown, and there is no seedable
//! or deterministic variant to misconfigure.
//!
//! **Hostile-input rules** (on top of everything `queue.rs` and `chain.rs` check):
//! - **VQ-8:** a request's writable total is capped at [`RNG_MAX_REQUEST`] (64 KiB); a larger
//!   chain is refused with `QueueError::TooLarge`, which is DEVICE_NEEDS_RESET. Readable
//!   descriptors are allowed (the spec gives them no meaning here) but **never written**;
//! - **VQ-11:** each request gets its own zero-initialised bounce buffer (`vec![0; n]`), filled
//!   from the CSPRNG, then copied out. Nothing is reused between requests, so a short fill can
//!   never expose an earlier request's bytes;
//! - **VQ-9:** the used `len` is what `write_writable` actually copied, never the buffer size
//!   the guest claimed;
//! - **VQ-12:** at most `budget` chains per call (clamped to the queue size the driver chose);
//!   the worker releases the device mutex between calls.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{
    DEVICE_ID_RNG, MAX_BOUNCE, Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt,
    features,
};
use crate::backend::entropy::Entropy;
use crate::memory::GuestMemoryOrdered;
use std::sync::Arc;

/// The requestq's maximum size (architecture §11.3).
pub const RNG_QUEUE_SIZE: u16 = 64;
/// The most bytes one request may ask for (VQ-8): one bounce buffer (VQ-11).
pub const RNG_MAX_REQUEST: u64 = MAX_BOUNCE as u64;

/// What the device holds between DRIVER_OK and reset.
struct Active {
    mem: Arc<dyn GuestMemoryOrdered>,
    queue: Queue,
    irq: Arc<VirtioInterrupt>,
}

/// The virtio-rng device model (module docs).
pub struct Rng {
    entropy: Entropy,
    active: Option<Active>,
    requests: u64,
    bytes: u64,
}

impl core::fmt::Debug for Rng {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Rng")
            .field("active", &self.active.is_some())
            .field("requests", &self.requests)
            .field("bytes", &self.bytes)
            .finish_non_exhaustive()
    }
}

impl Rng {
    /// A device serving `entropy` (`HostIo.entropy`).
    pub fn new(entropy: Entropy) -> Rng {
        Rng {
            entropy,
            active: None,
            requests: 0,
            bytes: 0,
        }
    }

    /// Requests served and bytes produced since the VM started.
    pub fn served(&self) -> (u64, u64) {
        (self.requests, self.bytes)
    }
}

impl VirtioDevice for Rng {
    fn device_id(&self) -> u32 {
        DEVICE_ID_RNG
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &[RNG_QUEUE_SIZE]
    }
    /// §5.4.3: "None currently defined"; only the transport-level `VERSION_1`.
    fn device_features(&self) -> u64 {
        features::VERSION_1
    }
    fn ack_features(&mut self, _accepted: u64) {}
    /// §5.4.4: "None currently defined". `config_len` stays 0, so every config access is
    /// refused by the transport (VQ-13).
    fn read_config(&self, _offset: u32, data: &mut [u8]) {
        data.fill(0);
    }
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

    // ANCHOR: rng_process_queue
    /// Fill up to `budget` posted chains with host randomness (module docs).
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        if index != 0 {
            return Err(VirtioError::NoSuchQueue(index));
        }
        let Some(a) = self.active.as_mut() else {
            return Err(VirtioError::NotActivated);
        };
        let budget = budget.min(a.queue.size()); // VQ-12: one ring's worth at most
        let mem = &*a.mem;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        for n in 0..=budget {
            if n == budget {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = a.queue.pop(mem)? else {
                break;
            };
            // VQ-4..VQ-8: every descriptor checked; the writable total capped at 64 KiB.
            let req = chain.into_validated(RNG_MAX_REQUEST)?;
            let want = usize::try_from(req.writable_len)
                .map_err(|_| VirtioError::Device("rng request larger than the address space"))?;
            // VQ-11: a fresh, zeroed buffer per request, never reused.
            let mut buf = vec![0u8; want];
            self.entropy
                .fill(&mut buf)
                .map_err(|_| VirtioError::Device("the host entropy source failed"))?;
            // Only `req.writable` is written: readable descriptors are never touched.
            let written = req.write_writable(mem, &buf)?;
            a.queue.add_used(mem, req.head, written)?; // VQ-9: the bytes actually written
            self.requests = self.requests.saturating_add(1);
            self.bytes = self.bytes.saturating_add(u64::from(written));
            used = true;
        }
        if used && a.queue.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(progress)
    }
    // ANCHOR_END: rng_process_queue

    fn reset(&mut self) {
        // VQ-14: the queue and the memory handle go; nothing uses the old rings again.
        self.active = None;
    }
}
