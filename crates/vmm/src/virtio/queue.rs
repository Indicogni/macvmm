//! The split virtqueue, device side (virtio 1.2 §2.7 "Split Virtqueues"; architecture §11.2;
//! threat model VQ-1..VQ-3, VQ-9, VQ-10).
//!
//! **Three rings in guest RAM**, placed by the driver (§2.7, table "Virtqueue Part Alignment"):
//!
//! | Part | Alignment | Size (N = queue size) | Written by |
//! |---|---|---|---|
//! | descriptor table | 16 | `16·N` | driver |
//! | available ring `{flags, idx, ring[N], used_event}` | 2 | `6 + 2·N` | driver |
//! | used ring `{flags, idx, ring[N]{id, len}, avail_event}` | 4 | `6 + 8·N` | device (us) |
//!
//! [`Queue::validate`] checks all three at DRIVER_OK with `checked_*` arithmetic and
//! `check_range` (one RAM region each; VQ-1). A failure means DEVICE_NEEDS_RESET.
//!
//! **The protocol is lock-free shared memory between two CPUs** (architecture §11.2, "Why the
//! ordering rules exist"; first-principles R6). The driver writes ring entries and descriptors,
//! issues a write barrier, then bumps `avail.idx`; our **acquire** load of `avail.idx` pairs with
//! that barrier, so every later plain copy of an entry or a descriptor sees what the driver
//! wrote before the bump. In the other direction we write the used element, then **release**
//! store `used.idx`, which pairs with the driver's read barrier after it loads `used.idx`. Those
//! are the only two ordered accesses (`GuestMemoryOrdered`), plus one **full fence** before
//! reading `avail.flags` (see [`Queue::should_interrupt`]).
//!
//! **Our indices are ours.** `next_avail` and `next_used` are kept here (`Wrapping<u16>`: §2.7.6
//! and §2.7.8 say the indices wrap at 65536). We never read `used.idx` back from guest memory,
//! so a guest overwriting it changes nothing on our side (VQ-4 TOCTOU, `virtqueue_toctou.rs`).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::chain::{DESC_SIZE, DescriptorChain};
use super::{QUEUE_SIZE_MAX, QueueError, Ring};
use crate::memory::{GuestAddress, GuestMemory, GuestMemoryExt, GuestMemoryOrdered};
use core::num::Wrapping;

/// `VIRTQ_AVAIL_F_NO_INTERRUPT` (§2.7.7): the driver does not want used-buffer interrupts.
pub const AVAIL_F_NO_INTERRUPT: u16 = 1;

/// One queue: the registers the driver programmed, and our ring positions (module docs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Queue {
    max_size: u16,
    size: u16,
    ready: bool,
    desc_table: GuestAddress,
    avail_ring: GuestAddress,
    used_ring: GuestAddress,
    next_avail: Wrapping<u16>,
    next_used: Wrapping<u16>,
    indirect: bool,
    broken: bool,
}

/// `(offset of ring[i])` helpers: `base + head + elem·i` with `checked_*` (VQ-1).
fn at(base: GuestAddress, head: u64, elem: u64, i: u16) -> Result<GuestAddress, QueueError> {
    elem.checked_mul(u64::from(i))
        .and_then(|off| off.checked_add(head))
        .and_then(|off| base.checked_add(off))
        .ok_or(QueueError::Overflow {
            addr: base.0,
            len: u32::from(i),
        })
}

impl Queue {
    /// A queue whose `QueueNumMax` is `max_size` (clamped to [`QUEUE_SIZE_MAX`]). Its size
    /// starts at the maximum (QEMU's default too), so a driver that never writes QueueNum
    /// still gets a valid queue.
    pub fn new(max_size: u16) -> Queue {
        let max_size = max_size.min(QUEUE_SIZE_MAX);
        Queue {
            max_size,
            size: max_size,
            ready: false,
            desc_table: GuestAddress(0),
            avail_ring: GuestAddress(0),
            used_ring: GuestAddress(0),
            next_avail: Wrapping(0),
            next_used: Wrapping(0),
            indirect: false,
            broken: false,
        }
    }

    pub fn max_size(&self) -> u16 {
        self.max_size
    }
    pub fn size(&self) -> u16 {
        self.size
    }
    pub fn ready(&self) -> bool {
        self.ready
    }
    pub fn desc_table(&self) -> GuestAddress {
        self.desc_table
    }
    pub fn avail_ring(&self) -> GuestAddress {
        self.avail_ring
    }
    pub fn used_ring(&self) -> GuestAddress {
        self.used_ring
    }
    /// Our next available-ring position.
    pub fn next_avail(&self) -> u16 {
        self.next_avail.0
    }
    /// Our next used-ring position (the value of the last `used.idx` we published).
    pub fn next_used(&self) -> u16 {
        self.next_used.0
    }

    /// Is `size` acceptable as QueueNum: a power of two in `1..=max_size` (§2.7, VQ-3)?
    pub fn size_ok(&self, size: u16) -> bool {
        size != 0 && size <= self.max_size && size.is_power_of_two()
    }

    /// QueueNum (the transport checks [`size_ok`](Self::size_ok) and the freeze rules).
    pub fn set_size(&mut self, size: u16) {
        self.size = size;
    }
    pub fn set_ready(&mut self, ready: bool) {
        self.ready = ready;
    }
    pub fn set_desc_table(&mut self, a: GuestAddress) {
        self.desc_table = a;
    }
    pub fn set_avail_ring(&mut self, a: GuestAddress) {
        self.avail_ring = a;
    }
    pub fn set_used_ring(&mut self, a: GuestAddress) {
        self.used_ring = a;
    }
    /// `VIRTIO_F_INDIRECT_DESC` was negotiated (VQ-6).
    pub fn set_indirect(&mut self, on: bool) {
        self.indirect = on;
    }
    /// Start positions (tests of index wrap-around; a real queue starts at 0, §2.7.6).
    pub fn set_positions(&mut self, next_avail: u16, next_used: u16) {
        self.next_avail = Wrapping(next_avail);
        self.next_used = Wrapping(next_used);
    }

    /// True once a `pop` failed: the queue refuses all work until the device is reset (VQ-10).
    pub fn is_broken(&self) -> bool {
        self.broken
    }

    fn check_usable(&self) -> Result<(), QueueError> {
        if self.broken {
            return Err(QueueError::Broken);
        }
        if !self.ready || !self.size_ok(self.size) {
            return Err(QueueError::NotReady);
        }
        Ok(())
    }

    // ANCHOR: queue_validate_rings
    /// Check the ring placement at DRIVER_OK (§2.7 alignment table; VQ-1): size, alignment,
    /// and each ring entirely inside one RAM region, all lengths with `checked_*`.
    pub fn validate(&self, mem: &dyn GuestMemory) -> Result<(), QueueError> {
        if !self.size_ok(self.size) {
            return Err(QueueError::BadSize {
                size: self.size,
                max: self.max_size,
            });
        }
        let n = u64::from(self.size);
        let rings = [
            (Ring::Desc, self.desc_table, 16, DESC_SIZE.checked_mul(n)),
            (
                Ring::Avail,
                self.avail_ring,
                2,
                n.checked_mul(2).and_then(|b| b.checked_add(6)),
            ),
            (
                Ring::Used,
                self.used_ring,
                4,
                n.checked_mul(8).and_then(|b| b.checked_add(6)),
            ),
        ];
        for (ring, addr, align, len) in rings {
            if !addr.0.is_multiple_of(align) {
                return Err(QueueError::Unaligned { ring, addr: addr.0 });
            }
            let len = len.ok_or(QueueError::RingOutOfRam {
                ring,
                addr: addr.0,
                len: u64::MAX,
            })?;
            // `check_range` computes the end with `checked_add` and demands one region (MEM-2).
            if !mem.check_range(addr, len) {
                return Err(QueueError::RingOutOfRam {
                    ring,
                    addr: addr.0,
                    len,
                });
            }
        }
        Ok(())
    }
    // ANCHOR_END: queue_validate_rings

    // ANCHOR: queue_pop_avail
    /// Take the next available chain, if any (§2.7.13.x device side; VQ-2, VQ-3). On `Err`
    /// the queue is marked broken (VQ-10).
    pub fn pop<'m>(
        &mut self,
        mem: &'m dyn GuestMemoryOrdered,
    ) -> Result<Option<DescriptorChain<'m>>, QueueError> {
        let r = self.pop_inner(mem);
        // A ring the guest broke latches; asking an unready queue is not the ring's fault.
        if let Err(e) = &r
            && !matches!(e, QueueError::NotReady | QueueError::Broken)
        {
            self.broken = true;
        }
        r
    }

    fn pop_inner<'m>(
        &mut self,
        mem: &'m dyn GuestMemoryOrdered,
    ) -> Result<Option<DescriptorChain<'m>>, QueueError> {
        self.check_usable()?;
        // Acquire: pairs with the driver's write barrier before it bumped avail.idx, so the
        // entry and descriptor copies below see what it wrote first (module docs).
        let avail_idx = mem.read_u16_acquire(at(self.avail_ring, 2, 0, 0)?)?;
        let pending = Wrapping(avail_idx) - self.next_avail;
        if pending.0 > self.size {
            // VQ-2: the index jumped by more than the queue holds.
            return Err(QueueError::AvailIdxJump {
                avail_idx,
                next_avail: self.next_avail.0,
                size: self.size,
            });
        }
        if pending.0 == 0 {
            return Ok(None);
        }
        // `size` is a power of two (checked), so `& (size - 1)` is `% size` (§2.7.6).
        let slot = self.next_avail.0 & self.size.wrapping_sub(1);
        let head = mem.read_obj::<u16>(at(self.avail_ring, 4, 2, slot)?)?; // copied once (MEM-7)
        if head >= self.size {
            return Err(QueueError::HeadOutOfRange {
                head,
                size: self.size,
            });
        }
        self.next_avail += Wrapping(1);
        Ok(Some(DescriptorChain::new(
            mem,
            self.desc_table,
            self.size,
            head,
            self.indirect,
        )))
    }
    // ANCHOR_END: queue_pop_avail

    /// Give one chain back without using it: our `next_avail` steps back (for a device that
    /// popped a chain it cannot serve yet, such as an RX queue with no frame).
    pub fn undo_pop(&mut self) {
        self.next_avail -= Wrapping(1);
    }

    // ANCHOR: queue_add_used
    /// Return chain `head` to the driver with `written` bytes produced (§2.7.8; VQ-9).
    ///
    /// `written` MUST be the number of bytes the device actually wrote into the chain's
    /// writable buffers, never the requested or the available length: the driver trusts it
    /// (a too-large `len` makes the guest read stale bytes, or previous requests' data). The
    /// element `{id, len}` is one 8-byte copy; then `used.idx` is published with a **release**
    /// store, which orders the element (and every buffer write before it) before the index.
    pub fn add_used(
        &mut self,
        mem: &dyn GuestMemoryOrdered,
        head: u16,
        written: u32,
    ) -> Result<(), QueueError> {
        self.check_usable()?;
        if head >= self.size {
            return Err(QueueError::HeadOutOfRange {
                head,
                size: self.size,
            });
        }
        let slot = self.next_used.0 & self.size.wrapping_sub(1);
        let mut elem = [0u8; 8];
        let (id, len) = elem.split_at_mut(4);
        id.copy_from_slice(&u32::from(head).to_le_bytes());
        len.copy_from_slice(&written.to_le_bytes());
        mem.write(at(self.used_ring, 4, 8, slot)?, &elem)?;
        self.next_used += Wrapping(1);
        // Release: pairs with the driver's read barrier after loading used.idx.
        mem.write_u16_release(at(self.used_ring, 2, 0, 0)?, self.next_used.0)?;
        Ok(())
    }
    // ANCHOR_END: queue_add_used

    // ANCHOR: queue_should_interrupt
    /// After `add_used`: does the driver want a used-buffer interrupt (§2.7.7)? It does unless
    /// `avail.flags` has `NO_INTERRUPT` (a hint: the driver may still poll).
    ///
    /// **The full fence** (VQ-9; architecture §11.2 item 9). Our `used.idx` store and our
    /// `avail.flags` load are a store followed by a load to *different* addresses; release and
    /// acquire do not order those, so the CPU may perform the load first. Meanwhile the driver
    /// does the mirror image in `virtqueue_enable_cb`: clear NO_INTERRUPT, `virtio_mb()`, re-read
    /// `used.idx`, sleep if nothing new. Without a fence on our side both can read the other's
    /// stale value: we see NO_INTERRUPT still set and stay silent, the driver sees the old
    /// `used.idx` and sleeps: a lost wakeup and a hung guest. The `SeqCst` fence here pairs
    /// with the driver's `virtio_mb()`, so at least one of us sees the other's write.
    pub fn should_interrupt(&self, mem: &dyn GuestMemoryOrdered) -> Result<bool, QueueError> {
        mem.fence_seq_cst();
        let flags = mem.read_obj::<u16>(self.avail_ring)?;
        Ok(flags & AVAIL_F_NO_INTERRUPT == 0)
    }
    // ANCHOR_END: queue_should_interrupt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_rules() {
        let q = Queue::new(256);
        assert_eq!(q.size(), 256);
        for (s, ok) in [
            (0, false),
            (1, true),
            (3, false),
            (128, true),
            (256, true),
            (512, false),
        ] {
            assert_eq!(q.size_ok(s), ok, "{s}");
        }
        assert_eq!(Queue::new(u16::MAX).max_size(), QUEUE_SIZE_MAX);
    }
}
