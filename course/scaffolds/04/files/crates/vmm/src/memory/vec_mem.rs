//! `VecMemory`: a `Vec`-backed [`GuestMemory`] for host tests (architecture §6.1). No HVF.
//!
//! **Why a test double that obeys the real rules.** It validates its regions with the same
//! [`RegionTable`] as `GuestRam` and resolves every access with the same
//! [`RegionTable::locate`], so a device test that passes against it exercises the real bounds
//! logic (MEM-2, MEM-8). Only the copy itself differs: here it is an ordinary slice copy under
//! a mutex, which is fine because these bytes are not shared with a running guest.
//!
//! **Two instruments for the hostile-guest tests** (architecture §6.1 rev 1.1):
//! - an **access log** ([`VecMemory::enable_log`]): every successful `read`/`write` (and the
//!   ordered pair) records address, length, direction and whether it was ordered. M11 uses it
//!   to assert "each descriptor is read exactly once" (VQ-4, MEM-7) and that `avail.idx` is read
//!   with acquire before the ring entries (virtio 1.2 §2.7.13);
//! - a **mutation hook** ([`VecMemory::mutate_after`]): after the N-th read, rewrite some
//!   bytes, as a racing guest vCPU would. A device that re-reads guest memory after validating
//!   it (a double fetch) then sees the new bytes, and the test catches it. The hook's own write
//!   is the "guest" and is not logged;
//! - (M11) `fence_seq_cst` calls are logged too (`Access::fence`), so the virtqueue ordering
//!   test can see the full barrier between the `used.idx` store and the `avail.flags` load.
//!
//! Built under `cfg(test)` and with the `test-util` feature (integration tests and
//! `crates/fuzz`); never in a release `macvmm`.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::region::{RegionError, RegionTable};
use super::{GuestAddress, GuestMemory, GuestMemoryOrdered, MemoryError, check_aligned_u16};
use crate::sync::lock;
use std::sync::Mutex;

/// The IPA width `VecMemory` validates against: the M5 Pro's maximum (spike finding 3).
pub const VEC_MEMORY_IPA_BITS: u32 = 40;

/// The largest total size a `VecMemory` will allocate (RUST-4: tests and fuzzers build these
/// from arbitrary inputs, so the host allocation needs a named cap).
pub const VEC_MEMORY_MAX_TOTAL: u64 = 1 << 30;

/// One logged access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    pub addr: u64,
    pub len: u64,
    /// `write`/`write_u16_release` (true) or `read`/`read_u16_acquire` (false).
    pub write: bool,
    /// One of the two ordered accessors.
    pub ordered: bool,
    /// (M11) Not an access: a `fence_seq_cst` call, logged with `addr = 0, len = 0` so tests
    /// can check where the full barrier sits between the accesses (architecture §11.2 item 9).
    pub fence: bool,
}

/// After `after_reads` successful reads, write `bytes` at `addr` (once).
#[derive(Clone, Debug)]
pub struct Mutation {
    pub after_reads: usize,
    pub addr: GuestAddress,
    pub bytes: Vec<u8>,
}

/// Why `VecMemory::new` refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VecMemoryError {
    Region(RegionError),
    TooLarge { total: u64 },
}

impl From<RegionError> for VecMemoryError {
    fn from(e: RegionError) -> VecMemoryError {
        VecMemoryError::Region(e)
    }
}

#[derive(Debug)]
struct Inner {
    regions: Vec<Vec<u8>>,
    log: Option<Vec<Access>>,
    reads: usize,
    mutation: Option<Mutation>,
}

/// Guest memory backed by host `Vec`s.
#[derive(Debug)]
pub struct VecMemory {
    table: RegionTable,
    inner: Mutex<Inner>,
}

#[derive(Clone, Copy)]
struct Kind {
    write: bool,
    ordered: bool,
    logged: bool,
}

impl VecMemory {
    /// Zero-filled regions, validated like real RAM (MEM-8, 40-bit IPA space), at most
    /// [`VEC_MEMORY_MAX_TOTAL`] bytes in all.
    pub fn new(regions: &[(GuestAddress, u64)]) -> Result<VecMemory, VecMemoryError> {
        let table = RegionTable::new(regions, VEC_MEMORY_IPA_BITS)?;
        let total = table.total_size();
        if total > VEC_MEMORY_MAX_TOTAL {
            return Err(VecMemoryError::TooLarge { total });
        }
        let mut bufs = Vec::with_capacity(table.spans().len());
        for s in table.spans() {
            let len = usize::try_from(s.size).map_err(|_| VecMemoryError::TooLarge { total })?;
            bufs.push(vec![0u8; len]);
        }
        Ok(VecMemory {
            table,
            inner: Mutex::new(Inner {
                regions: bufs,
                log: None,
                reads: 0,
                mutation: None,
            }),
        })
    }

    /// The validated region table.
    pub fn table(&self) -> &RegionTable {
        &self.table
    }

    /// Start (or restart) recording accesses.
    pub fn enable_log(&self) {
        lock(&self.inner).log = Some(Vec::new());
    }

    /// The accesses recorded so far.
    pub fn log(&self) -> Vec<Access> {
        lock(&self.inner).log.clone().unwrap_or_default()
    }

    /// Successful reads so far (plain and ordered), whether or not the log is on.
    pub fn reads(&self) -> usize {
        lock(&self.inner).reads
    }

    /// Install the mutation hook (replacing any pending one).
    pub fn mutate_after(&self, m: Mutation) {
        lock(&self.inner).mutation = Some(m);
    }

    /// Resolve the access, run `op` on the target bytes and log it. Nothing happens on `Err`.
    fn access(
        &self,
        addr: GuestAddress,
        len: usize,
        kind: Kind,
        op: impl FnOnce(&mut [u8]),
    ) -> Result<(), MemoryError> {
        let len64 = u64::try_from(len).map_err(|_| MemoryError::Overflow {
            addr: addr.0,
            len: u64::MAX,
        })?;
        let at = self.table.locate(addr, len64)?;
        let oob = MemoryError::OutOfBounds {
            addr: addr.0,
            len: len64,
        };
        let start = usize::try_from(at.offset).map_err(|_| oob)?;
        let end = start.checked_add(len).ok_or(oob)?;
        let mut inner = lock(&self.inner);
        let region = inner.regions.get_mut(at.index).ok_or(oob)?;
        op(region.get_mut(start..end).ok_or(oob)?);
        if kind.logged
            && let Some(log) = inner.log.as_mut()
        {
            log.push(Access {
                addr: addr.0,
                len: len64,
                write: kind.write,
                ordered: kind.ordered,
                fence: false,
            });
        }
        Ok(())
    }

    /// Count a successful read and fire the mutation hook when it is due.
    fn after_read(&self) {
        let due = {
            let mut inner = lock(&self.inner);
            inner.reads = inner.reads.saturating_add(1);
            let reads = inner.reads;
            if inner
                .mutation
                .as_ref()
                .is_some_and(|m| reads >= m.after_reads)
            {
                inner.mutation.take()
            } else {
                None
            }
        };
        if let Some(m) = due {
            let guest = Kind {
                write: true,
                ordered: false,
                logged: false,
            };
            // A hook pointing outside RAM is a test bug; the access rules still apply to it.
            let _ = self.access(m.addr, m.bytes.len(), guest, |dst| {
                dst.copy_from_slice(&m.bytes)
            });
        }
    }
}

const READ: Kind = Kind {
    write: false,
    ordered: false,
    logged: true,
};
const WRITE: Kind = Kind {
    write: true,
    ordered: false,
    logged: true,
};

impl GuestMemory for VecMemory {
    fn read(&self, addr: GuestAddress, buf: &mut [u8]) -> Result<(), MemoryError> {
        self.access(addr, buf.len(), READ, |src| buf.copy_from_slice(src))?;
        self.after_read();
        Ok(())
    }

    fn write(&self, addr: GuestAddress, buf: &[u8]) -> Result<(), MemoryError> {
        self.access(addr, buf.len(), WRITE, |dst| dst.copy_from_slice(buf))
    }

    fn check_range(&self, addr: GuestAddress, len: u64) -> bool {
        self.table.contains(addr, len)
    }
}

impl GuestMemoryOrdered for VecMemory {
    fn read_u16_acquire(&self, addr: GuestAddress) -> Result<u16, MemoryError> {
        check_aligned_u16(addr)?;
        let mut b = [0u8; 2];
        let kind = Kind {
            ordered: true,
            ..READ
        };
        self.access(addr, 2, kind, |src| b.copy_from_slice(src))?;
        self.after_read();
        Ok(u16::from_le_bytes(b))
    }

    fn write_u16_release(&self, addr: GuestAddress, val: u16) -> Result<(), MemoryError> {
        check_aligned_u16(addr)?;
        let b = val.to_le_bytes();
        let kind = Kind {
            ordered: true,
            ..WRITE
        };
        self.access(addr, 2, kind, |dst| dst.copy_from_slice(&b))
    }

    fn fence_seq_cst(&self) {
        core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst);
        if let Some(log) = lock(&self.inner).log.as_mut() {
            log.push(Access {
                addr: 0,
                len: 0,
                write: false,
                ordered: true,
                fence: true,
            });
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails the test
mod tests {
    use super::*;

    #[test]
    fn roundtrip_log_and_mutation() {
        let m = VecMemory::new(&[(GuestAddress(0x4000_0000), 0x8000)]).unwrap();
        m.enable_log();
        m.write_u32(GuestAddress(0x4000_0010), 0xdead_beef).unwrap();
        assert_eq!(m.read_u32(GuestAddress(0x4000_0010)).unwrap(), 0xdead_beef);
        assert!(m.read_u32(GuestAddress(0x4000_7ffe)).is_err());
        let log = m.log();
        assert_eq!(log.len(), 2, "a refused access is not logged");
        assert!(log[0].write && !log[1].write && log[1].len == 4);
        m.mutate_after(Mutation {
            after_reads: 2,
            addr: GuestAddress(0x4000_0010),
            bytes: vec![1],
        });
        assert_eq!(m.read_u8(GuestAddress(0x4000_0010)).unwrap(), 0xef);
        assert_eq!(m.read_u8(GuestAddress(0x4000_0010)).unwrap(), 1);
        assert_eq!(m.reads(), 3);
        assert_eq!(m.log().len(), 4, "the hook's write is not logged");
        assert_eq!(
            VecMemory::new(&[(GuestAddress(0), 2 << 30)]).unwrap_err(),
            VecMemoryError::TooLarge { total: 2 << 30 }
        );
    }
}
