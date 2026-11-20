//! Descriptor chains: walking one request's buffers out of a hostile descriptor table
//! (virtio 1.2 §2.7.5 "The Virtqueue Descriptor Table", §2.7.5.3 "Indirect Descriptors";
//! architecture §11.2 items 4–8; threat model VQ-4..VQ-8, MEM-7).
//!
//! **What a chain is.** The avail ring names a *head* descriptor; each 16-byte descriptor
//! `{addr: le64, len: le32, flags: le16, next: le16}` describes one guest buffer and, with
//! `F_NEXT`, names the next descriptor. `F_WRITE` marks a buffer the device writes
//! (device-writable); otherwise the device only reads it. `F_INDIRECT` says that `addr/len` is
//! not a buffer but a *table* of further descriptors (only when `VIRTIO_F_INDIRECT_DESC` was
//! negotiated).
//!
//! **Every field is the guest's, and the guest can rewrite it at any moment.** So:
//! - each descriptor is copied out **once** with `read_obj` into a local [`Descriptor`], and
//!   every check and every later use reads the copy (MEM-7; the TOCTOU tests in
//!   `virtqueue_toctou.rs` assert "each descriptor is read exactly once" from the access log);
//! - `next < table_len`, `len > 0`, `addr + len` without overflow and inside one RAM region
//!   (`check_range`: never MMIO, never ROM, never straddling the end of RAM) (VQ-4);
//! - a **hop budget** of `N` per chain (and `len / 16` once inside an indirect table) bounds
//!   the walk: a self-loop, a 2-cycle or a 5-cycle all run out of budget, with no visited set
//!   to allocate (VQ-5);
//! - indirect tables: `len % 16 == 0`, `1 ≤ len/16 ≤ N`, the table in RAM, never `F_NEXT` with
//!   `F_INDIRECT`, never nested, only if negotiated (VQ-6, §2.7.5.3.1);
//! - [`DescriptorChain::into_validated`] also enforces readable-before-writable (VQ-7,
//!   §2.7.4.2) and the per-device total `max_total` with `checked_add` (VQ-8).
//!
//! After the first `Err` the iterator yields nothing more: a broken chain is never half-used.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::QueueError;
use crate::memory::{FromLeBytes, GuestAddress, GuestMemoryExt, GuestMemoryOrdered};

/// `VIRTQ_DESC_F_NEXT` (§2.7.5).
pub const F_NEXT: u16 = 1;
/// `VIRTQ_DESC_F_WRITE`: device-writable (§2.7.5).
pub const F_WRITE: u16 = 2;
/// `VIRTQ_DESC_F_INDIRECT` (§2.7.5.3).
pub const F_INDIRECT: u16 = 4;
/// The size of one descriptor in a table (§2.7.5).
pub const DESC_SIZE: u64 = 16;

/// One descriptor, as copied out of guest memory (the copy is what we validate, MEM-7).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Descriptor {
    pub addr: u64,
    pub len: u32,
    pub flags: u16,
    pub next: u16,
}

impl Descriptor {
    /// `F_WRITE`: the device writes this buffer.
    pub fn is_write(&self) -> bool {
        self.flags & F_WRITE != 0
    }
    /// The 16 wire bytes (tests and the course vectors build rings with it).
    pub fn to_le_bytes(&self) -> [u8; 16] {
        let a = self.addr.to_le_bytes();
        let l = self.len.to_le_bytes();
        let f = self.flags.to_le_bytes();
        let n = self.next.to_le_bytes();
        [
            a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], l[0], l[1], l[2], l[3], f[0], f[1],
            n[0], n[1],
        ]
    }
}

impl FromLeBytes for Descriptor {
    type Bytes = [u8; 16];
    fn decode_le(b: [u8; 16]) -> Descriptor {
        let [
            a0,
            a1,
            a2,
            a3,
            a4,
            a5,
            a6,
            a7,
            l0,
            l1,
            l2,
            l3,
            f0,
            f1,
            n0,
            n1,
        ] = b;
        Descriptor {
            addr: u64::from_le_bytes([a0, a1, a2, a3, a4, a5, a6, a7]),
            len: u32::from_le_bytes([l0, l1, l2, l3]),
            flags: u16::from_le_bytes([f0, f1]),
            next: u16::from_le_bytes([n0, n1]),
        }
    }
}

/// An iterator over one chain's buffer descriptors (indirect tables flattened in place).
pub struct DescriptorChain<'m> {
    mem: &'m dyn GuestMemoryOrdered,
    head: u16,
    queue_size: u16,
    /// The table being walked: the queue's descriptor table, or an indirect table.
    table: GuestAddress,
    table_len: u16,
    next: Option<u16>,
    /// Hops left in the current table (VQ-5).
    budget: u16,
    in_indirect: bool,
    indirect_allowed: bool,
    failed: bool,
}

impl core::fmt::Debug for DescriptorChain<'_> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DescriptorChain")
            .field("head", &self.head)
            .field("next", &self.next)
            .field("budget", &self.budget)
            .field("in_indirect", &self.in_indirect)
            .finish_non_exhaustive()
    }
}

/// A chain that passed every check, split by direction (architecture §6.6).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ValidatedChain {
    /// The head index, for `Queue::add_used`.
    pub head: u16,
    pub readable: Vec<Descriptor>,
    pub writable: Vec<Descriptor>,
    pub readable_len: u64,
    pub writable_len: u64,
}

impl<'m> DescriptorChain<'m> {
    /// The chain starting at `head` (already checked `< queue_size` by `Queue::pop`) of a
    /// queue whose descriptor table is at `table`.
    pub(crate) fn new(
        mem: &'m dyn GuestMemoryOrdered,
        table: GuestAddress,
        queue_size: u16,
        head: u16,
        indirect_allowed: bool,
    ) -> DescriptorChain<'m> {
        DescriptorChain {
            mem,
            head,
            queue_size,
            table,
            table_len: queue_size,
            next: Some(head),
            budget: queue_size,
            in_indirect: false,
            indirect_allowed,
            failed: false,
        }
    }

    /// The head index.
    pub fn head(&self) -> u16 {
        self.head
    }

    /// Read descriptor `index` of the current table: once, into a local (MEM-7).
    fn read_desc(&self, index: u16) -> Result<Descriptor, QueueError> {
        if index >= self.table_len {
            return Err(QueueError::NextOutOfRange {
                next: index,
                table_len: self.table_len,
            });
        }
        let addr = DESC_SIZE
            .checked_mul(u64::from(index))
            .and_then(|off| self.table.checked_add(off))
            .ok_or(QueueError::Overflow {
                addr: self.table.0,
                len: u32::from(index),
            })?;
        Ok(self.mem.read_obj::<Descriptor>(addr)?)
    }

    // ANCHOR: chain_next_descriptor
    /// One step of the walk: the next *buffer* descriptor, or `None` at the end of the chain.
    fn step(&mut self) -> Result<Option<Descriptor>, QueueError> {
        loop {
            let Some(index) = self.next else {
                return Ok(None);
            };
            // VQ-5: the hop budget catches loops and over-long chains without a visited set.
            self.budget = self.budget.checked_sub(1).ok_or(QueueError::ChainTooLong {
                budget: if self.in_indirect {
                    self.table_len
                } else {
                    self.queue_size
                },
            })?;
            let d = self.read_desc(index)?;
            if d.flags & F_INDIRECT != 0 {
                self.enter_indirect(&d)?;
                continue;
            }
            // VQ-4, on the copy: non-empty, no overflow, entirely in one RAM region.
            if d.len == 0 {
                return Err(QueueError::ZeroLength { index });
            }
            let overflow = QueueError::Overflow {
                addr: d.addr,
                len: d.len,
            };
            GuestAddress(d.addr)
                .checked_add(u64::from(d.len))
                .ok_or(overflow)?;
            if !self.mem.check_range(GuestAddress(d.addr), u64::from(d.len)) {
                return Err(QueueError::BufferOutOfRam {
                    addr: d.addr,
                    len: d.len,
                });
            }
            self.next = if d.flags & F_NEXT != 0 {
                if d.next >= self.table_len {
                    return Err(QueueError::NextOutOfRange {
                        next: d.next,
                        table_len: self.table_len,
                    });
                }
                Some(d.next)
            } else {
                None
            };
            return Ok(Some(d));
        }
    }
    // ANCHOR_END: chain_next_descriptor

    // ANCHOR: chain_indirect
    /// Switch the walk to the indirect table `d` describes (§2.7.5.3; VQ-6). The referring
    /// descriptor's `F_WRITE` is ignored, as §2.7.5.3.2 requires of the device.
    fn enter_indirect(&mut self, d: &Descriptor) -> Result<(), QueueError> {
        if !self.indirect_allowed {
            return Err(QueueError::IndirectNotNegotiated);
        }
        if self.in_indirect {
            return Err(QueueError::NestedIndirect);
        }
        if d.flags & F_NEXT != 0 {
            return Err(QueueError::IndirectWithNext);
        }
        let entries = u64::from(d.len) / DESC_SIZE;
        if d.len == 0
            || !u64::from(d.len).is_multiple_of(DESC_SIZE)
            || entries > u64::from(self.queue_size)
        {
            return Err(QueueError::BadIndirectLen { len: d.len });
        }
        let entries =
            u16::try_from(entries).map_err(|_| QueueError::BadIndirectLen { len: d.len })?;
        GuestAddress(d.addr)
            .checked_add(u64::from(d.len))
            .ok_or(QueueError::Overflow {
                addr: d.addr,
                len: d.len,
            })?;
        if !self.mem.check_range(GuestAddress(d.addr), u64::from(d.len)) {
            return Err(QueueError::BufferOutOfRam {
                addr: d.addr,
                len: d.len,
            });
        }
        self.table = GuestAddress(d.addr);
        self.table_len = entries;
        self.next = Some(0);
        self.budget = entries; // the hop budget restarts at len / 16 (architecture §11.2 item 6)
        self.in_indirect = true;
        Ok(())
    }
    // ANCHOR_END: chain_indirect

    /// Walk the whole chain and check it as one request: readable descriptors first (VQ-7),
    /// and each direction's total at most `max_total` bytes (VQ-8).
    pub fn into_validated(mut self, max_total: u64) -> Result<ValidatedChain, QueueError> {
        let mut v = ValidatedChain {
            head: self.head,
            ..ValidatedChain::default()
        };
        while let Some(d) = self.next().transpose()? {
            let len = u64::from(d.len);
            if d.is_write() {
                v.writable_len = v
                    .writable_len
                    .checked_add(len)
                    .filter(|t| *t <= max_total)
                    .ok_or(QueueError::TooLarge {
                        total: v.writable_len.saturating_add(len),
                        max: max_total,
                    })?;
                v.writable.push(d);
            } else {
                if !v.writable.is_empty() {
                    return Err(QueueError::ReadableAfterWritable);
                }
                v.readable_len = v
                    .readable_len
                    .checked_add(len)
                    .filter(|t| *t <= max_total)
                    .ok_or(QueueError::TooLarge {
                        total: v.readable_len.saturating_add(len),
                        max: max_total,
                    })?;
                v.readable.push(d);
            }
        }
        Ok(v)
    }
}

impl Iterator for DescriptorChain<'_> {
    type Item = Result<Descriptor, QueueError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.failed {
            return None;
        }
        match self.step() {
            Ok(Some(d)) => Some(Ok(d)),
            Ok(None) => {
                self.next = None;
                None
            }
            Err(e) => {
                self.failed = true;
                Some(Err(e))
            }
        }
    }
}

impl ValidatedChain {
    /// Copy `data` into the writable buffers in order, and return how many bytes were written:
    /// the value `add_used` must report (VQ-9: never the requested length). Stops at the end of
    /// `data` or of the buffers. Buffers were range-checked during the walk; a failing write
    /// (memory changed shape) is an `Err`, never a panic.
    pub fn write_writable(
        &self,
        mem: &dyn GuestMemoryOrdered,
        data: &[u8],
    ) -> Result<u32, QueueError> {
        let mut done: usize = 0;
        for d in &self.writable {
            let Some(rest) = data.get(done..) else { break };
            if rest.is_empty() {
                break;
            }
            let n = rest.len().min(usize::try_from(d.len).unwrap_or(usize::MAX));
            let chunk = rest.get(..n).unwrap_or_default();
            mem.write(GuestAddress(d.addr), chunk)?;
            done = done.saturating_add(n);
        }
        u32::try_from(done).map_err(|_| QueueError::TooLarge {
            total: u64::try_from(done).unwrap_or(u64::MAX),
            max: u64::from(u32::MAX),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descriptor_bytes_roundtrip() {
        let d = Descriptor {
            addr: 0x1122_3344_5566_7788,
            len: 0x99aa_bbcc,
            flags: 0xddee,
            next: 0xff01,
        };
        assert_eq!(Descriptor::decode_le(d.to_le_bytes()), d);
        assert!(!d.is_write() || d.flags & F_WRITE != 0);
    }
}
