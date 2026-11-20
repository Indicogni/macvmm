//! Guest memory: the [`GuestMemory`] contract and its implementations. [frozen ch04]
//!
//! **The problem.** The guest's RAM is host memory that the guest, every other vCPU and every
//! device worker can change at any moment, behind the VMM's back. Every value the VMM reads from
//! it is hostile (CLAUDE.md "Security rules"), and the VMM must also be careful about *how* it
//! reads, not only *what* it reads.
//!
//! **The contract** (architecture §6.1, threat model §7.1):
//! - Only copies. [`GuestMemory::read`] copies guest bytes into a buffer the VMM owns, and
//!   [`GuestMemory::write`] copies them back. There is no `get_slice`, `as_slice`, `as_ptr` or
//!   `&mut T` accessor, and none may be added (MEM-5): a `&[u8]` into guest RAM would promise
//!   the compiler that nobody changes those bytes while the reference lives, and the guest does.
//!   The VMM validates its *copy*, never the original, which is what defeats double-fetch
//!   (TOCTOU) attacks (MEM-7); [`GuestMemoryExt::read_obj`] reads a whole structure in one copy.
//! - Only RAM. An access is valid only if `[addr, addr + len)` lies inside **one** RAM region,
//!   with the end computed by `checked_add` (MEM-2). ROM, MMIO holes and unmapped IPAs are not
//!   reachable at all (MEM-3), so a device doing "DMA" through this trait can never write into
//!   firmware or into its own registers (the QEMU CVE-2021-3929 class).
//! - Only little-endian helpers: the guest runs little-endian (Linux arm64 `booting.rst` §4
//!   requires it at entry), so `read_u32` means "the LE 32-bit value at addr".
//!
//! **Two traits** (PLAN D12, architecture §6.1). [`GuestMemoryOrdered`] adds the two
//! acquire/release 16-bit accessors the virtqueue protocol needs (virtio 1.2 §2.7.13, ch16). It
//! is a separate trait so the ch04 contract stays minimal; both implementations provide both.
//!
//! **Implementations.**
//! - [`host::GuestRam`]: `hv_vm_allocate`d memory mapped into the VM. The only `unsafe` code in
//!   this crate lives in `host.rs`.
//! - [`host::RomRegion`]: flash. Mapped read+execute for the guest, and deliberately *not* a
//!   `GuestMemory`.
//! - `vec_mem::VecMemory` (feature `test-util` or `cfg(test)`): a `Vec`-backed double for host
//!   tests, with an access log and a mutation hook for TOCTOU tests.
//! - [`region::RegionTable`]: the pure bounds logic both of them use.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod address;
pub mod host;
pub mod region;
#[cfg(any(test, feature = "test-util"))]
pub mod vec_mem;

pub use address::GuestAddress;
pub use host::{GuestRam, RomRegion, TeardownAction, leaked_bytes, teardown_action};
pub use region::{RegionError, RegionTable};
#[cfg(any(test, feature = "test-util"))]
pub use vec_mem::{Access, Mutation, VecMemory, VecMemoryError};

use core::fmt;

/// Why a guest-memory access was refused. [frozen ch04]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MemoryError {
    /// `addr + len` passes `u64::MAX`.
    Overflow { addr: u64, len: u64 },
    /// The range is empty, or not entirely inside one RAM region.
    OutOfBounds { addr: u64, len: u64 },
    /// An ordered accessor was given an address that is not 2-byte aligned.
    Unaligned { addr: u64 },
}

impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            MemoryError::Overflow { addr, len } => {
                write!(f, "{len:#x} bytes at {addr:#x} overflow the address space")
            }
            MemoryError::OutOfBounds { addr, len } => {
                write!(
                    f,
                    "{len:#x} bytes at {addr:#x} are not inside one RAM region"
                )
            }
            MemoryError::Unaligned { addr } => {
                write!(f, "ordered access at {addr:#x} is not 2-byte aligned")
            }
        }
    }
}

impl std::error::Error for MemoryError {}

/// A value that can be decoded from its little-endian bytes, for [`GuestMemoryExt::read_obj`].
///
/// `Bytes` is the exact-size byte array (`[u8; N]`), so the whole object is read with one copy
/// (MEM-7). Virtio descriptors and block headers implement it in their own modules.
pub trait FromLeBytes: Sized {
    /// `[u8; size_of::<Self>()]` (or the wire size, for a structure).
    type Bytes: Default + AsMut<[u8]>;
    /// Decode the copied bytes.
    fn decode_le(bytes: Self::Bytes) -> Self;
}

macro_rules! from_le_int {
    ($($t:ty),*) => {$(
        impl FromLeBytes for $t {
            type Bytes = [u8; core::mem::size_of::<$t>()];
            fn decode_le(bytes: Self::Bytes) -> $t {
                <$t>::from_le_bytes(bytes)
            }
        }
    )*};
}
from_le_int!(u8, u16, u32, u64);

/// Copy `T` out of guest memory once and decode it (the body of `read_obj`).
fn read_obj_from<T: FromLeBytes, M: GuestMemory + ?Sized>(
    mem: &M,
    addr: GuestAddress,
) -> Result<T, MemoryError> {
    let mut bytes = T::Bytes::default();
    mem.read(addr, bytes.as_mut())?;
    Ok(T::decode_le(bytes))
}

/// Guest-physical RAM, reachable only by bounds-checked copies. [frozen ch04]
pub trait GuestMemory: Send + Sync {
    /// Copy guest bytes out. The whole `[addr, addr + buf.len())` must lie in ONE RAM region;
    /// otherwise nothing is copied and the result is `Err`. An empty `buf` is `Err` too, so
    /// that `read` succeeds exactly when `check_range` is true.
    fn read(&self, addr: GuestAddress, buf: &mut [u8]) -> Result<(), MemoryError>;

    /// Copy bytes into guest RAM (same rule; on `Err` nothing was written). ROM is never
    /// writable through this trait.
    fn write(&self, addr: GuestAddress, buf: &[u8]) -> Result<(), MemoryError>;

    /// True if `[addr, addr + len)` lies in one RAM region. `len == 0` is false.
    fn check_range(&self, addr: GuestAddress, len: u64) -> bool;

    fn read_u8(&self, addr: GuestAddress) -> Result<u8, MemoryError> {
        read_obj_from(self, addr)
    }
    fn read_u16(&self, addr: GuestAddress) -> Result<u16, MemoryError> {
        read_obj_from(self, addr)
    }
    fn read_u32(&self, addr: GuestAddress) -> Result<u32, MemoryError> {
        read_obj_from(self, addr)
    }
    fn read_u64(&self, addr: GuestAddress) -> Result<u64, MemoryError> {
        read_obj_from(self, addr)
    }
    fn write_u8(&self, addr: GuestAddress, v: u8) -> Result<(), MemoryError> {
        self.write(addr, &v.to_le_bytes())
    }
    fn write_u16(&self, addr: GuestAddress, v: u16) -> Result<(), MemoryError> {
        self.write(addr, &v.to_le_bytes())
    }
    fn write_u32(&self, addr: GuestAddress, v: u32) -> Result<(), MemoryError> {
        self.write(addr, &v.to_le_bytes())
    }
    fn write_u64(&self, addr: GuestAddress, v: u64) -> Result<(), MemoryError> {
        self.write(addr, &v.to_le_bytes())
    }
    // `read_obj::<T>(addr)` is provided for every implementation, and for `dyn GuestMemory`,
    // by the blanket extension trait `GuestMemoryExt` below.
}

/// `read_obj`: copy a whole structure out of guest memory **once** and decode it (MEM-7).
///
/// **Why an extension trait** (and not a provided method of [`GuestMemory`]): `read_obj` is
/// generic, and a generic method cannot be in a vtable, so on the trait it would need
/// `where Self: Sized` and would not exist on `dyn GuestMemory` or `dyn GuestMemoryOrdered`,
/// which is how devices hold guest memory (`Arc<dyn GuestMemoryOrdered>`). An inherent
/// `impl dyn GuestMemory { fn read_obj }` beside it is ambiguous at every call site (E0034).
/// A blanket impl over every `GuestMemory`, sized or not, gives one `mem.read_obj::<T>(addr)`
/// that works everywhere. It is in [`prelude`] together with the two traits.
pub trait GuestMemoryExt: GuestMemory {
    /// Copy `size_of::<T::Bytes>()` bytes at `addr` once and decode them as LE. Validate the
    /// returned value, never guest memory again (MEM-7).
    fn read_obj<T: FromLeBytes>(&self, addr: GuestAddress) -> Result<T, MemoryError> {
        read_obj_from(self, addr)
    }
}

impl<M: GuestMemory + ?Sized> GuestMemoryExt for M {}

/// `use vmm::memory::prelude::*;` brings the accessor traits into scope.
pub mod prelude {
    pub use super::{GuestAddress, GuestMemory, GuestMemoryExt, GuestMemoryOrdered};
}

/// The two ordered accessors of the split virtqueue (virtio 1.2 §2.7.13: the driver publishes
/// `avail.idx` after the ring entries, the device publishes `used.idx` after the used
/// elements). Frozen at ch16 (PLAN D12).
pub trait GuestMemoryOrdered: GuestMemory {
    /// Acquire-ordered 16-bit LE load (`avail.idx`). `addr` must be 2-aligned: reads that
    /// follow it see everything the guest wrote before publishing the index.
    fn read_u16_acquire(&self, addr: GuestAddress) -> Result<u16, MemoryError>;

    /// Release-ordered 16-bit LE store (`used.idx`). `addr` must be 2-aligned: every write
    /// before it is visible to the guest once it sees the new index.
    fn write_u16_release(&self, addr: GuestAddress, val: u16) -> Result<(), MemoryError>;

    /// A full (`SeqCst`) fence between our `used.idx` release store and our later load of
    /// `avail.flags` (M11, architecture §11.2 item 9, VQ-9). Release/acquire cannot order a
    /// store before a later load; only a full barrier can, and without it the device may read a
    /// stale `NO_INTERRUPT` after the driver re-enabled interrupts and went to sleep (the
    /// lost-wakeup race; Linux's `virtio_mb()` in `virtqueue_enable_cb` is the other half).
    ///
    /// It is a method (with this default) rather than a bare `fence` call in `virtio/queue.rs`
    /// so that the `VecMemory` access log can record *where* the fence sits relative to the
    /// accesses around it: the `used_idx_release_order` test asserts the order. Implementations
    /// other than test doubles keep the default.
    fn fence_seq_cst(&self) {
        core::sync::atomic::fence(core::sync::atomic::Ordering::SeqCst);
    }
}

/// The alignment check shared by the ordered accessors of every implementation.
pub(crate) fn check_aligned_u16(addr: GuestAddress) -> Result<(), MemoryError> {
    if addr.0.is_multiple_of(2) {
        Ok(())
    } else {
        Err(MemoryError::Unaligned { addr: addr.0 })
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
    fn errors_display() {
        for e in [
            MemoryError::Overflow { addr: 1, len: 2 },
            MemoryError::OutOfBounds { addr: 1, len: 2 },
            MemoryError::Unaligned { addr: 1 },
        ] {
            assert!(e.to_string().contains("0x1"), "{e}");
        }
        assert_eq!(<u32 as FromLeBytes>::decode_le([1, 2, 3, 4]), 0x0403_0201);
    }
}
