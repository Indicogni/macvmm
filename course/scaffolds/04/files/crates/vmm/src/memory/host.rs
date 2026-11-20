//! Host backing for guest memory: [`GuestRam`] (RAM) and [`RomRegion`] (flash), plus the
//! fail-closed teardown rule. **The only module of `vmm` that contains `unsafe`.**
//!
//! **What it does.** Each region is one `hv_vm_allocate` block (page-aligned anonymous memory
//! "suitable to be mapped as guest memory", `hv_vm_allocate.h`), mapped into stage 2 with
//! `hv_vm_map` so that the guest's IPA range *is* those host bytes (ARM ARM D8.1, the stage 2
//! translation, which HVF programs). The VMM then reaches them only through raw pointers, in
//! exactly three ways:
//!
//! 1. **Volatile element copies** (threat model MEM-5, flaw F4) for [`GuestMemory`]: a loop of
//!    `read_volatile`/`write_volatile` over `u64` for the aligned middle and `u8` for the edges.
//!    Never `ptr::copy_nonoverlapping` (the audit bans it in this crate): the guest and other
//!    threads write this memory concurrently, so a plain copy is a data race in Rust's abstract
//!    machine, and the optimizer may legally re-read the source instead of using the copy, a
//!    compiler-made double fetch that would silently undo the copy-then-validate rule (MEM-7).
//!    rust-vmm `vm-memory` uses volatile access for the same reason.
//! 2. **`AtomicU16::from_ptr`** for the two ordered virtqueue accessors (MEM-6).
//! 3. Nothing else: no `&[u8]`, no `&mut T`, no slice view (architecture §6.1).
//!
//! The host's view of the memory is read+write only, never executable (MEM-4):
//! `hv_vm_allocate` memory is RW in the host, the stage-2 EXEC permission applies to the guest
//! only, and nothing here jumps to, `mprotect`s or interprets guest bytes as host code.
//!
//! **Lifetime and teardown** (MEM-9, MEM-11, architecture §14.5). The order is: every holder of
//! an `Arc<GuestRam>` has joined; unmap every region; `hv_vm_destroy`; then free the host
//! blocks. If an unmap or the destroy **fails**, stage 2 may still map the blocks, and freeing
//! them would hand recycled host memory (another allocation's data, later) to the guest: an
//! escape primitive. So the blocks are then **leaked** (forgotten, counted in
//! `hvf::host::leaked_bytes`), never freed or reused, and the VMM stops with an error instead of
//! rebooting. The decision is the pure function [`teardown_action`]; [`crate::vm::teardown`]
//! applies it. Dropping a `GuestRam` or `RomRegion` that still has a mapping (or whose unmap
//! failed) also leaks: the safe default when nobody said the mappings are gone.
//!
//! **Zero fill** (MEM-10). `hv_vm_allocate` returns zeroed memory on the dev machine (verified
//! on 64 MiB by `hv_allocate_is_zeroed`, recorded in `docs/research/hvf-api.md`), like any fresh
//! anonymous mapping; every boot allocates fresh RAM, so nothing from the host or an earlier
//! boot reaches the guest.
#![allow(unsafe_code)]
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::region::RegionTable;
use super::{GuestAddress, GuestMemory, GuestMemoryOrdered, MemoryError, check_aligned_u16};
use crate::error::{Error, Result};
use hvf::host::Allocation;
use hvf::{CallError, MemFlags, Vm};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU16, Ordering};

/// What to do with the host blocks at teardown (MEM-11).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeardownAction {
    /// Every unmap and the VM destroy succeeded: `hv_vm_deallocate` the blocks.
    Deallocate,
    /// Something failed: stage 2 may still reach the blocks, so keep them allocated forever.
    Leak,
}

/// The fail-closed rule (MEM-11, F22): free guest memory only when the framework confirmed
/// both that every mapping was removed and that the VM is gone.
pub fn teardown_action(unmap_ok: bool, destroy_ok: bool) -> TeardownAction {
    if unmap_ok && destroy_ok {
        TeardownAction::Deallocate
    } else {
        TeardownAction::Leak
    }
}

/// Bytes leaked on purpose so far by the fail-closed rule (re-exported from `hvf`, which owns
/// the counter because it owns `Allocation::leak`).
pub fn leaked_bytes() -> u64 {
    hvf::host::leaked_bytes()
}

/// Mapping state of one block.
const NOT_MAPPED: u8 = 0;
const MAPPED: u8 = 1;
/// `hv_vm_unmap` failed: the block may still be mapped, so it must never be freed.
const UNMAP_FAILED: u8 = 2;

/// One `hv_vm_allocate` block and where it is (or will be) mapped.
#[derive(Debug)]
struct Block {
    /// The IPA of byte 0.
    ipa: u64,
    /// `Some` until `Drop` frees or leaks it.
    alloc: Option<Allocation>,
    len: usize,
    state: AtomicU8,
}

impl Block {
    fn new(ipa: u64, size: u64) -> Result<Block> {
        let len = usize::try_from(size).map_err(|_| Error::Config(format!("{size:#x} bytes")))?;
        let alloc = hvf::host::allocate(len).map_err(|err| Error::Hv {
            op: "allocate guest memory",
            err,
        })?;
        Ok(Block {
            ipa,
            alloc: Some(alloc),
            len,
            state: AtomicU8::new(NOT_MAPPED),
        })
    }

    /// Host address of byte `offset`, if `[offset, offset + len)` is inside the block. This
    /// re-checks what `RegionTable::locate` already proved, so a bug in a caller cannot turn
    /// into an out-of-bounds pointer.
    fn ptr(&self, offset: u64, len: usize) -> Option<*mut u8> {
        // LEARNER: block_ptr_bounds
        todo!("LEARNER: block_ptr_bounds")
        // LEARNER_END: block_ptr_bounds
    }

    /// Map the block at its IPA with `flags`. A block maps at most once at a time.
    fn map(&self, vm: &Vm, flags: MemFlags) -> Result<()> {
        if self
            .state
            .compare_exchange(NOT_MAPPED, MAPPED, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Error::Internal("guest memory block mapped twice"));
        }
        let ptr = self
            .alloc
            .as_ref()
            .map(Allocation::as_ptr)
            .ok_or(Error::Internal("guest memory block already released"))?;
        // SAFETY: (the `Vm::map` contract) `ptr..ptr+len` is one live `hv_vm_allocate` block owned
        // by this `Block`. It stays allocated until the mapping is gone, because `Drop` frees a
        // block only in state NOT_MAPPED (reached again only after a successful unmap) and
        // otherwise leaks it (MEM-9, MEM-11). No Rust reference to it is ever created: all
        // access is through the volatile copies and the atomic accessors below (MEM-5, MEM-6).
        // The block is never handed out as ordinary Rust memory.
        let mapped = unsafe { vm.map(ptr, self.ipa, self.len, flags) };
        if let Err(err) = mapped {
            self.state.store(NOT_MAPPED, Ordering::SeqCst);
            return Err(Error::Hv {
                op: "map guest memory",
                err,
            });
        }
        Ok(())
    }

    /// Remove the mapping, if there is one. A failure is remembered: the block is then leaked.
    fn unmap(&self, vm: &Vm) -> core::result::Result<(), CallError> {
        if self.state.load(Ordering::SeqCst) == NOT_MAPPED {
            return Ok(());
        }
        match vm.unmap(self.ipa, self.len) {
            Ok(()) => {
                self.state.store(NOT_MAPPED, Ordering::SeqCst);
                Ok(())
            }
            Err(err) => {
                self.state.store(UNMAP_FAILED, Ordering::SeqCst);
                Err(err)
            }
        }
    }

    fn is_mapped_or_unknown(&self) -> bool {
        self.state.load(Ordering::SeqCst) != NOT_MAPPED
    }

    /// Free the block, or leak it if `leak` (MEM-11).
    fn release(&mut self, leak: bool) {
        let Some(alloc) = self.alloc.take() else {
            return;
        };
        if leak {
            let _ = alloc.leak();
        } else if let Err(err) = hvf::host::deallocate(alloc) {
            // The framework kept the block: that is a leak too, which is the safe direction.
            crate::warn!("freeing guest memory at {:#x}: {err}", self.ipa);
        }
    }
}

/// Copy `buf.len()` bytes from guest-shared memory at `src` into `buf`: `u8` loads up to the
/// first 8-aligned address, `u64` loads for the middle, `u8` loads for the tail. Every load is
/// volatile, so each guest byte is read exactly once and the compiler cannot re-read it.
///
/// # Safety
/// `src..src + buf.len()` must lie inside one live allocation, and no Rust reference may point
/// into it.
unsafe fn volatile_read(src: *const u8, buf: &mut [u8]) {
    let head_len = src.align_offset(8).min(buf.len());
    let Some((head, rest)) = buf.split_at_mut_checked(head_len) else {
        return;
    };
    let mut p = src;
    for out in head {
        // SAFETY: `p` walks the caller's in-bounds range one byte per output byte.
        *out = unsafe { p.read_volatile() };
        p = p.wrapping_add(1);
    }
    let (words, tail) = rest.as_chunks_mut::<8>();
    for chunk in words {
        // SAFETY: `p` is 8-aligned here (we consumed `align_offset` bytes) and 8 bytes of the
        // caller's range remain, because `chunk` has 8 bytes.
        let w = unsafe { p.cast::<u64>().read_volatile() };
        *chunk = w.to_ne_bytes();
        p = p.wrapping_add(8);
    }
    for out in tail {
        // SAFETY: as for the head: one in-bounds byte per output byte.
        *out = unsafe { p.read_volatile() };
        p = p.wrapping_add(1);
    }
}

/// The mirror of [`volatile_read`]: copy `data` into guest-shared memory at `dst`.
///
/// # Safety
/// As for [`volatile_read`], for `dst..dst + data.len()`.
unsafe fn volatile_write(dst: *mut u8, data: &[u8]) {
    let head_len = dst.align_offset(8).min(data.len());
    let Some((head, rest)) = data.split_at_checked(head_len) else {
        return;
    };
    let mut p = dst;
    for &byte in head {
        // SAFETY: `p` walks the caller's in-bounds range one byte per input byte.
        unsafe { p.write_volatile(byte) };
        p = p.wrapping_add(1);
    }
    let (words, tail) = rest.as_chunks::<8>();
    for chunk in words {
        // SAFETY: `p` is 8-aligned and 8 bytes of the caller's range remain.
        unsafe { p.cast::<u64>().write_volatile(u64::from_ne_bytes(*chunk)) };
        p = p.wrapping_add(8);
    }
    for &byte in tail {
        // SAFETY: as for the head.
        unsafe { p.write_volatile(byte) };
        p = p.wrapping_add(1);
    }
}

/// Guest RAM: one `hv_vm_allocate` block per region of a validated [`RegionTable`].
///
/// **Why `Send + Sync` is sound** (the compiler derives both from `hvf::host::Allocation`,
/// whose own `unsafe impl`s carry the argument; this is the part that depends on *us*):
/// - access is copy-only, through raw pointers, with volatile element loads and stores
///   (or `AtomicU16` for the ordered pair). No reference into the memory exists, so no Rust
///   aliasing promise can be broken by the guest, a vCPU or a worker writing concurrently;
///   concurrent copies can at worst observe torn values, which callers validate anyway (MEM-7);
/// - every pointer is derived from a [`RegionTable::locate`] result and re-checked against
///   the block length, so it stays inside one live allocation;
/// - a block is freed only after its mapping is gone **and** the VM destroy succeeded; any
///   failure leaks it instead (MEM-11, [`teardown_action`]). `Arc` holders are joined first
///   (MEM-9, checked in [`crate::vm::teardown`]). So no copy can touch freed memory, and the
///   guest can never reach memory the host has reused.
#[derive(Debug)]
pub struct GuestRam {
    table: RegionTable,
    /// Parallel to `table.spans()`.
    blocks: Vec<Block>,
    /// Set by `release(.., false)` or a teardown that found the RAM still shared.
    leak_on_drop: AtomicBool,
}

const _: () = {
    const fn send_sync<T: Send + Sync>() {}
    send_sync::<GuestRam>();
    send_sync::<RomRegion>();
};

impl GuestRam {
    /// Allocate (but do not map) RAM for `regions` in a VM with `ipa_bits` of IPA space. The
    /// table rules of MEM-8 are checked first, so nothing is allocated for a bad layout.
    pub fn new(regions: &[(GuestAddress, u64)], ipa_bits: u32) -> Result<GuestRam> {
        let table = RegionTable::new(regions, ipa_bits)?;
        let mut blocks = Vec::with_capacity(table.spans().len());
        for span in table.spans() {
            blocks.push(Block::new(span.base.0, span.size)?);
        }
        Ok(GuestRam {
            table,
            blocks,
            leak_on_drop: AtomicBool::new(false),
        })
    }

    /// The validated region table.
    pub fn table(&self) -> &RegionTable {
        &self.table
    }

    /// Total RAM in bytes.
    pub fn size(&self) -> u64 {
        self.table.total_size()
    }

    /// Map every region into `vm`, read+write+execute for the guest (the guest's own page
    /// tables decide what it executes). On `Err`, regions mapped so far stay mapped; the
    /// caller tears down as usual.
    pub fn map(&self, vm: &Vm) -> Result<()> {
        self.blocks
            .iter()
            .try_for_each(|b| b.map(vm, MemFlags::RWX))
    }

    /// Unmap every region, trying all of them; the first failure is returned and every failed
    /// region is remembered (it will be leaked).
    pub fn unmap(&self, vm: &Vm) -> core::result::Result<(), CallError> {
        let mut first = Ok(());
        for b in &self.blocks {
            if let Err(e) = b.unmap(vm)
                && first.is_ok()
            {
                first = Err(e);
            }
        }
        first
    }

    /// Give the host memory back, as decided by [`teardown_action`]: `mappings_gone` is true
    /// only if every unmap **and** the VM destroy succeeded. Returns what was done. A block
    /// whose own unmap failed is leaked whatever the caller says.
    pub fn release(self, mappings_gone: bool) -> TeardownAction {
        if !mappings_gone {
            self.mark_leak();
        }
        let action = self.drop_action();
        drop(self);
        action
    }

    /// Make the eventual drop leak every block (MEM-11).
    pub(crate) fn mark_leak(&self) {
        self.leak_on_drop.store(true, Ordering::SeqCst);
    }

    fn drop_action(&self) -> TeardownAction {
        let leak = self.leak_on_drop.load(Ordering::SeqCst)
            || self.blocks.iter().any(Block::is_mapped_or_unknown);
        if leak {
            TeardownAction::Leak
        } else {
            TeardownAction::Deallocate
        }
    }

    /// The block and in-block pointer for an accepted access.
    fn host_ptr(
        &self,
        addr: GuestAddress,
        len: usize,
    ) -> core::result::Result<*mut u8, MemoryError> {
        let len64 = u64::try_from(len).map_err(|_| MemoryError::Overflow {
            addr: addr.0,
            len: u64::MAX,
        })?;
        let at = self.table.locate(addr, len64)?;
        self.blocks
            .get(at.index)
            .and_then(|b| b.ptr(at.offset, len))
            .ok_or(MemoryError::OutOfBounds {
                addr: addr.0,
                len: len64,
            })
    }
}

impl Drop for GuestRam {
    fn drop(&mut self) {
        let leak = self.drop_action() == TeardownAction::Leak;
        for b in &mut self.blocks {
            b.release(leak);
        }
    }
}

impl GuestMemory for GuestRam {
    fn read(&self, addr: GuestAddress, buf: &mut [u8]) -> core::result::Result<(), MemoryError> {
        let src = self.host_ptr(addr, buf.len())?;
        // SAFETY: `host_ptr` proved `[src, src + buf.len())` lies inside one live block
        // (see the type's safety argument); `buf` is VMM-owned memory, not guest memory.
        unsafe { volatile_read(src, buf) };
        Ok(())
    }

    fn write(&self, addr: GuestAddress, buf: &[u8]) -> core::result::Result<(), MemoryError> {
        let dst = self.host_ptr(addr, buf.len())?;
        // SAFETY: as in `read`, for the destination range.
        unsafe { volatile_write(dst, buf) };
        Ok(())
    }

    fn check_range(&self, addr: GuestAddress, len: u64) -> bool {
        self.table.contains(addr, len)
    }
}

impl GuestMemoryOrdered for GuestRam {
    fn read_u16_acquire(&self, addr: GuestAddress) -> core::result::Result<u16, MemoryError> {
        check_aligned_u16(addr)?;
        let p = self.host_ptr(addr, 2)?;
        // SAFETY: (MEM-6) `p` is inside a live block (checked) and 2-aligned (the IPA is
        // 2-aligned and blocks are page-aligned, so the host address is too). `AtomicU16` has
        // the size and alignment of `u16`. The guest is not Rust: its accesses, including
        // mixed-size ones, are outside the Rust memory model, and we only ever use the value we
        // loaded, which callers validate. The `&AtomicU16` lives for this one load.
        let v = unsafe { AtomicU16::from_ptr(p.cast::<u16>()) }.load(Ordering::Acquire);
        Ok(u16::from_le(v))
    }

    fn write_u16_release(
        &self,
        addr: GuestAddress,
        val: u16,
    ) -> core::result::Result<(), MemoryError> {
        check_aligned_u16(addr)?;
        let p = self.host_ptr(addr, 2)?;
        // SAFETY: (MEM-6) as in `read_u16_acquire`; the store publishes the VMM's earlier
        // writes (the used ring elements) to the guest.
        unsafe { AtomicU16::from_ptr(p.cast::<u16>()) }.store(val.to_le(), Ordering::Release);
        Ok(())
    }
}

/// Firmware flash: written by the host at load time, mapped **read+execute** for the guest, and
/// deliberately **not** a [`GuestMemory`] (MEM-3): no device can DMA into firmware through the
/// guest-memory API, and the guest's stores to it fault to the VMM.
#[derive(Debug)]
pub struct RomRegion {
    table: RegionTable,
    block: Block,
    leak_on_drop: AtomicBool,
    /// M18: set by the first [`RomRegion::load`]; until then the ROM is all zero (MEM-10).
    written: AtomicBool,
}

impl RomRegion {
    /// Allocate a zero-filled ROM of `size` bytes at `base` (MEM-8 rules apply).
    pub fn new(base: GuestAddress, size: u64, ipa_bits: u32) -> Result<RomRegion> {
        let table = RegionTable::new(&[(base, size)], ipa_bits)?;
        Ok(RomRegion {
            block: Block::new(base.0, size)?,
            table,
            leak_on_drop: AtomicBool::new(false),
            written: AtomicBool::new(false),
        })
    }

    /// M18: true until the first [`RomRegion::load`]: a fresh `hv_vm_allocate` block is
    /// zero-filled (MEM-10), so the firmware loader need not write the padding.
    pub fn is_fresh(&self) -> bool {
        !self.written.load(Ordering::SeqCst)
    }

    /// Guest-physical base address.
    pub fn base(&self) -> GuestAddress {
        GuestAddress(self.block.ipa)
    }

    /// Size in bytes.
    pub fn size(&self) -> u64 {
        self.table.total_size()
    }

    fn ptr(&self, offset: u64, len: usize) -> core::result::Result<*mut u8, MemoryError> {
        let len64 = u64::try_from(len).unwrap_or(u64::MAX);
        let addr = self
            .base()
            .checked_add(offset)
            .ok_or(MemoryError::Overflow {
                addr: offset,
                len: len64,
            })?;
        let at = self.table.locate(addr, len64)?;
        self.block
            .ptr(at.offset, len)
            .ok_or(MemoryError::OutOfBounds {
                addr: addr.0,
                len: len64,
            })
    }

    /// Host-side load of firmware bytes at `offset` (the loader's job, before the guest runs).
    pub fn load(&self, offset: u64, data: &[u8]) -> core::result::Result<(), MemoryError> {
        let dst = self.ptr(offset, data.len())?;
        self.written.store(true, Ordering::SeqCst);
        // SAFETY: `ptr` proved the range lies inside the live block; volatile because the
        // block may already be mapped (the guest can read, never write, it).
        unsafe { volatile_write(dst, data) };
        Ok(())
    }

    /// Host-side read of ROM bytes (tests, firmware sanity checks).
    pub fn read(&self, offset: u64, buf: &mut [u8]) -> core::result::Result<(), MemoryError> {
        let src = self.ptr(offset, buf.len())?;
        // SAFETY: as in `load`.
        unsafe { volatile_read(src, buf) };
        Ok(())
    }

    /// M18: the little-endian 32-bit word at guest-physical `ipa`, if `ipa` is 4-byte aligned
    /// and the word lies inside the ROM. Read-only and bounds-checked (`locate` + the block
    /// check): the ISV = 0 path's instruction fetch from execute-in-place firmware
    /// (`arch::stage1_walk::fetch_insn_rom`). This is the only guest-driven read of the ROM;
    /// nothing guest-driven ever writes it (MEM-3).
    pub fn read_u32(&self, ipa: GuestAddress) -> Option<u32> {
        if !ipa.0.is_multiple_of(4) {
            return None;
        }
        let offset = ipa.0.checked_sub(self.base().0)?;
        let mut b = [0u8; 4];
        self.read(offset, &mut b).ok()?;
        Some(u32::from_le_bytes(b))
    }

    /// Map into `vm` read+execute for the guest (PLAN §1: flash bank 0 is READ+EXEC).
    pub fn map(&self, vm: &Vm) -> Result<()> {
        self.block.map(vm, MemFlags::RX)
    }

    /// Remove the mapping (a failure makes the drop leak).
    pub fn unmap(&self, vm: &Vm) -> core::result::Result<(), CallError> {
        self.block.unmap(vm)
    }

    /// As [`GuestRam::release`].
    pub fn release(self, mappings_gone: bool) -> TeardownAction {
        if !mappings_gone {
            self.leak_on_drop.store(true, Ordering::SeqCst);
        }
        let action = self.drop_action();
        drop(self);
        action
    }

    fn drop_action(&self) -> TeardownAction {
        if self.leak_on_drop.load(Ordering::SeqCst) || self.block.is_mapped_or_unknown() {
            TeardownAction::Leak
        } else {
            TeardownAction::Deallocate
        }
    }
}

impl crate::arch::stage1_walk::InsnRom for RomRegion {
    fn read_insn(&self, ipa: u64) -> Option<u32> {
        self.read_u32(GuestAddress(ipa))
    }
}

impl Drop for RomRegion {
    fn drop(&mut self) {
        let leak = self.drop_action() == TeardownAction::Leak;
        self.block.release(leak);
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

    /// PLAN M2 security test (MEM-11): only `(true, true)` frees.
    #[test]
    fn teardown_action_table() {
        assert_eq!(teardown_action(true, true), TeardownAction::Deallocate);
        assert_eq!(teardown_action(false, true), TeardownAction::Leak);
        assert_eq!(teardown_action(true, false), TeardownAction::Leak);
        assert_eq!(teardown_action(false, false), TeardownAction::Leak);
    }

    /// The copy loops over every head/middle/tail split, against plain host memory (a `Vec`
    /// we own, so no HVF is needed). Proves each byte lands once and in order.
    #[test]
    #[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // test: panics fail it
    fn volatile_loops_cover_every_split() {
        let mut backing = vec![0u64; 8]; // 64 bytes, 8-aligned
        let base = backing.as_mut_ptr().cast::<u8>();
        for start in 0..24usize {
            for len in 0..40usize {
                let data: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(7) ^ 0x5a).collect();
                // SAFETY: `start + len <= 64`, inside `backing`, which no reference covers
                // while the raw pointer is used.
                unsafe {
                    for i in 0..64 {
                        base.add(i).write_volatile(0xee);
                    }
                    volatile_write(base.add(start), &data);
                    let mut out = vec![0u8; len];
                    volatile_read(base.add(start), &mut out);
                    assert_eq!(out, data, "start {start} len {len}");
                    assert_eq!(base.add(start + len).read_volatile(), 0xee);
                    if start > 0 {
                        assert_eq!(base.add(start - 1).read_volatile(), 0xee);
                    }
                }
            }
        }
    }
}
