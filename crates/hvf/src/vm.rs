//! The VM: [`VmBuilder`] configures it, [`Vm`] owns it, dropping `Vm` destroys it; plus
//! stage-2 mapping ([`Vm::map`], [`Vm::unmap`], [`Vm::protect`]) and [`OwnedMapping`].
//!
//! **Why these types** (ADR-0002 item 5): Hypervisor.framework has exactly one VM per process,
//! with no handle; `hv_vm_create` binds it to the calling process and `hv_vm_destroy` tears it
//! down. Encoding that in Rust means:
//! - `Vm` is a **singleton**: a process-wide flag refuses a second live `Vm` before the framework
//!   is even asked (the framework would answer `HV_BUSY`, spike finding 19), so a second value
//!   can never destroy the first one's VM on drop.
//! - `Drop` calls `hv_vm_destroy`, so an early return cannot leak the VM. Callers that care
//!   about the result (the doctor's create/destroy loop, M2's teardown rules MEM-11) call
//!   [`Vm::destroy`] explicitly.
//! - The in-kernel GICv3 is created **inside** [`VmBuilder::create`], right after
//!   `hv_vm_create`, because `hv_gic.h` requires it after the VM and before any vCPU. Doing it in
//!   the builder makes the order a type-level fact (ADR-0004).
//! - Each VM gets a **generation** number. The GIC tokens ([`Gic`], [`crate::GicHandle`]) carry
//!   the generation of the VM they were created with, and every call they make first checks it
//!   against the live VM's ([`with_live_vm`]). The framework's GIC calls take no VM argument
//!   (there is one VM per process), so without this a handle kept from boot N would drive the
//!   GIC of boot N+1 after an in-process reboot (architecture §14.5).
//!
//! **Stage-2 mapping.** `hv_vm_map(host, ipa, len, flags)` makes host memory guest-physical
//! memory: the guest's IPA `ipa..ipa+len` *is* the host's `host..host+len` (ARM ARM D8.1 "the
//! stage 2 translation", which HVF programs for us). With the default 16 KiB IPA granule, host
//! VA, IPA and length must all be 16 KiB aligned (spike finding 1). Mapping is `unsafe` because
//! from that moment the guest can write those host bytes at any time: the caller must keep the
//! memory alive until it is unmapped and must never hold a Rust reference into it (MEM-5).
//! Unmapping and changing permissions cannot create aliasing, so they are safe.
//!
//! [`OwnedMapping`] is the safe packaging used by `first-exit` and the tests: it allocates,
//! maps, offers a bounds-checked [`OwnedMapping::write`], and unmaps then frees on drop (or
//! leaks, fail-closed, if the unmap fails; threat model MEM-11).

use crate::error::{CallError, HvError, check};
use crate::ffi;
use crate::gic::{self, Gic, GicConfig};
use crate::host::{self, OsObject};
use core::ops::{BitOr, Range};
use std::sync::RwLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Set while a `Vm` value exists in this process.
static VM_LIVE: AtomicBool = AtomicBool::new(false);

/// Source of VM generations; 0 is never handed out.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// The generation of the live VM, 0 when there is none. `Vm::destroy` holds the write lock
/// across `hv_vm_destroy`, and [`with_live_vm`] holds a read lock across the framework call, so
/// a GIC call either completes on its own VM before that VM is destroyed or is refused: it can
/// never land on a later VM. The lock is uncontended except during teardown.
static LIVE_GENERATION: RwLock<u64> = RwLock::new(0);

// ANCHOR: with_live_vm
/// Run `f` (one framework call made on behalf of a VM-bound token) only if `generation` is still
/// the live VM's. A stale token gets `HV_BAD_ARGUMENT` for `call` without the framework being
/// asked, which is what the framework itself answers for a GIC call when no VM exists.
pub(crate) fn with_live_vm<T>(
    generation: u64,
    call: &'static str,
    f: impl FnOnce() -> Result<T, CallError>,
) -> Result<T, CallError> {
    // Poisoning cannot leave the value half-written (it is a plain `u64` store), so a panic
    // elsewhere is no reason to refuse every later GIC call.
    let live = LIVE_GENERATION.read().unwrap_or_else(|e| e.into_inner());
    if generation == 0 || *live != generation {
        return Err(CallError {
            call,
            error: HvError::BadArgument,
        });
    }
    let result = f();
    drop(live);
    result
}
// ANCHOR_END: with_live_vm

/// Stage-2 permissions (`HV_MEMORY_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemFlags(pub ffi::hv_memory_flags_t);

impl MemFlags {
    /// Mapped, but every access faults (spike: `flags = 0` maps successfully).
    pub const NONE: MemFlags = MemFlags(0);
    pub const READ: MemFlags = MemFlags(ffi::HV_MEMORY_READ);
    pub const WRITE: MemFlags = MemFlags(ffi::HV_MEMORY_WRITE);
    pub const EXEC: MemFlags = MemFlags(ffi::HV_MEMORY_EXEC);
    pub const RW: MemFlags = MemFlags(ffi::HV_MEMORY_READ | ffi::HV_MEMORY_WRITE);
    pub const RX: MemFlags = MemFlags(ffi::HV_MEMORY_READ | ffi::HV_MEMORY_EXEC);
    pub const RWX: MemFlags =
        MemFlags(ffi::HV_MEMORY_READ | ffi::HV_MEMORY_WRITE | ffi::HV_MEMORY_EXEC);
}

impl BitOr for MemFlags {
    type Output = MemFlags;
    fn bitor(self, rhs: MemFlags) -> MemFlags {
        MemFlags(self.0 | rhs.0)
    }
}

/// The stage-2 IPA granule (`hv_ipa_granule_t`, macOS 26+).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IpaGranule {
    K4,
    K16,
}

impl IpaGranule {
    pub(crate) fn raw(self) -> ffi::hv_ipa_granule_t {
        match self {
            IpaGranule::K4 => ffi::HV_IPA_GRANULE_4KB,
            IpaGranule::K16 => ffi::HV_IPA_GRANULE_16KB,
        }
    }

    pub(crate) fn from_raw(raw: ffi::hv_ipa_granule_t) -> Option<IpaGranule> {
        match raw {
            ffi::HV_IPA_GRANULE_4KB => Some(IpaGranule::K4),
            ffi::HV_IPA_GRANULE_16KB => Some(IpaGranule::K16),
            _ => None,
        }
    }
}

/// Configuration for [`Vm`]. Everything left unset keeps the framework default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VmBuilder {
    ipa_bits: Option<u32>,
    el2: bool,
    granule: Option<IpaGranule>,
    gic: Option<GicConfig>,
}

impl VmBuilder {
    /// A builder with the framework defaults (36-bit IPA, 16 KiB granule, EL2 off, no GIC).
    pub fn new() -> VmBuilder {
        VmBuilder::default()
    }

    /// Request an IPA width in bits. More than `Capabilities::max_ipa_bits` makes
    /// `create` fail with `HV_UNSUPPORTED` (spike finding 3).
    pub fn ipa_bits(mut self, bits: u32) -> VmBuilder {
        self.ipa_bits = Some(bits);
        self
    }

    /// Enable virtual EL2 (nested virtualization, macOS 15+, M3 or later chips).
    pub fn el2(mut self, enabled: bool) -> VmBuilder {
        self.el2 = enabled;
        self
    }

    /// Choose the stage-2 granule (macOS 26+; `create` fails with `HV_UNSUPPORTED` on older
    /// hosts because the setter is an optional symbol).
    pub fn ipa_granule(mut self, granule: IpaGranule) -> VmBuilder {
        self.granule = Some(granule);
        self
    }

    /// Create the in-kernel GICv3 at these addresses as part of `create`.
    pub fn with_gic(mut self, config: GicConfig) -> VmBuilder {
        self.gic = Some(config);
        self
    }

    // ANCHOR: vm_builder_create
    /// Create the process's VM, and its GIC if requested (then `Some(Gic)`).
    pub fn create(self) -> Result<(Vm, Option<Gic>), CallError> {
        if VM_LIVE.swap(true, Ordering::AcqRel) {
            return Err(CallError {
                call: "hv_vm_create",
                error: HvError::Busy,
            });
        }
        // On failure VM_LIVE is released here and only here: `create_inner` never builds a `Vm`
        // on an error path, so no `Vm::drop` can clear the flag a second time (which could
        // clear another thread's claim taken in between).
        let result = self.create_inner();
        if result.is_err() {
            VM_LIVE.store(false, Ordering::Release);
        }
        result
    }

    /// Everything after claiming VM_LIVE. Returns a `Vm` only on success.
    fn create_inner(self) -> Result<(Vm, Option<Gic>), CallError> {
        // SAFETY: no preconditions; the result is checked for NULL by `OsObject::new`.
        let config = OsObject::new("hv_vm_config_create", unsafe { ffi::hv_vm_config_create() })?;
        if let Some(bits) = self.ipa_bits {
            // SAFETY: `config` is a live `hv_vm_config_t` owned by `config`.
            check("hv_vm_config_set_ipa_size", unsafe {
                ffi::hv_vm_config_set_ipa_size(config.as_ptr(), bits)
            })?;
        }
        if self.el2 {
            // SAFETY: as above.
            check("hv_vm_config_set_el2_enabled", unsafe {
                ffi::hv_vm_config_set_el2_enabled(config.as_ptr(), true)
            })?;
        }
        if let Some(granule) = self.granule {
            set_ipa_granule(&config, granule)?;
        }
        // SAFETY: `config` is a live configuration; the framework copies what it needs, so
        // releasing `config` afterwards is allowed (`hv_vm.h`).
        check("hv_vm_create", unsafe {
            ffi::hv_vm_create(config.as_ptr())
        })?;
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let gic = match self.gic.map(|c| gic::create(c, generation)).transpose() {
            Ok(gic) => gic,
            Err(e) => {
                // Tear the half-built VM down directly rather than through `Vm::drop`, so the
                // flag is released once, by `create`. The GIC error is the one worth reporting.
                // SAFETY: `hv_vm_create` succeeded above, no vCPU exists, and no `Vm` value
                // represents this VM, so it is destroyed exactly once, here.
                let _ = unsafe { ffi::hv_vm_destroy() };
                return Err(e);
            }
        };
        // Publish last: no token of this generation works before the VM is complete.
        Ok((Vm::publish(generation), gic))
    }
    // ANCHOR_END: vm_builder_create
}

/// `hv_vm_config_set_ipa_granule`, an optional (macOS 26+) symbol.
fn set_ipa_granule(config: &OsObject, granule: IpaGranule) -> Result<(), CallError> {
    let set = crate::optional::get()
        .hv_vm_config_set_ipa_granule
        .ok_or(CallError {
            call: "hv_vm_config_set_ipa_granule",
            error: HvError::Unsupported,
        })?;
    // SAFETY: `set` is the resolved framework function; `config` is a live `hv_vm_config_t`.
    check("hv_vm_config_set_ipa_granule", unsafe {
        set(config.as_ptr(), granule.raw())
    })
}

/// The process's one VM. Dropping it calls `hv_vm_destroy`.
///
/// `Send + Sync`: vCPU threads borrow it through `std::thread::scope`.
#[derive(Debug)]
pub struct Vm {
    live: bool,
    /// This VM's generation (see the module docs); never 0.
    generation: u64,
}

impl Vm {
    /// Make `generation` the live one and wrap the just-created VM (end of a successful
    /// `create`).
    fn publish(generation: u64) -> Vm {
        *LIVE_GENERATION.write().unwrap_or_else(|e| e.into_inner()) = generation;
        Vm {
            live: true,
            generation,
        }
    }

    /// Destroy the VM now and report the framework's answer.
    ///
    /// Owners of guest memory must look at the answer (threat model MEM-11): if the destroy
    /// failed, stage 2 may still map their host pages, so they must leak them, never free them
    /// (`vmm::memory::host::teardown_action`). `Drop` runs the same code but has to discard the
    /// result.
    pub fn destroy(mut self) -> Result<(), CallError> {
        self.destroy_inner()
    }

    fn destroy_inner(&mut self) -> Result<(), CallError> {
        if !self.live {
            return Ok(());
        }
        self.live = false;
        // Retire the generation first and keep the write lock across the destroy: in-flight
        // GIC calls finish before it, later ones from this VM's tokens are refused.
        let mut live = LIVE_GENERATION.write().unwrap_or_else(|e| e.into_inner());
        if *live == self.generation {
            *live = 0;
        }
        // SAFETY: this value represents the live VM created by `VmBuilder::create`, and nothing
        // borrowing it (no `Vcpu`, no `OwnedMapping`) can outlive it; destroying it once is valid.
        let result = check("hv_vm_destroy", unsafe { ffi::hv_vm_destroy() });
        drop(live);
        VM_LIVE.store(false, Ordering::Release);
        // Test builds only: report a failure the framework did not produce (MEM-11 tests).
        #[cfg(feature = "fault-injection")]
        if crate::testing::take(crate::testing::Op::Destroy) {
            return Err(CallError {
                call: "hv_vm_destroy",
                error: HvError::Error,
            });
        }
        result
    }

    // ANCHOR: vm_map
    /// Map `len` bytes of host memory at `host` to guest IPA `ipa` with `flags`.
    ///
    /// The framework checks alignment (16 KiB by default) and returns `HV_BAD_ARGUMENT`
    /// otherwise, and `HV_ERROR` for an overlap; nothing is pre-checked here, so callers and
    /// tests see the framework's real answer.
    ///
    /// # Safety
    ///
    /// - `host..host+len` must be a single live allocation (for example a [`host::Allocation`])
    ///   that stays allocated until this IPA range is unmapped or the VM is destroyed.
    /// - While mapped, the guest may read and write those bytes at any moment: no Rust
    ///   reference (`&`/`&mut`, slice) to them may exist; access them with volatile raw-pointer
    ///   operations only (threat model MEM-5).
    /// - The same host range must not also be handed out as ordinary Rust memory.
    pub unsafe fn map(
        &self,
        host: *mut u8,
        ipa: u64,
        len: usize,
        flags: MemFlags,
    ) -> Result<(), CallError> {
        // SAFETY: the caller upholds the contract above; the framework validates alignment.
        check("hv_vm_map", unsafe {
            ffi::hv_vm_map(host.cast(), ipa, len, flags.0)
        })
    }
    // ANCHOR_END: vm_map

    /// Remove a stage-2 mapping. Unmapping a range that was never mapped succeeds (spike).
    pub fn unmap(&self, ipa: u64, len: usize) -> Result<(), CallError> {
        // SAFETY: removing guest access to an IPA range cannot invalidate host memory or
        // create aliasing; the framework validates alignment.
        let result = check("hv_vm_unmap", unsafe { ffi::hv_vm_unmap(ipa, len) });
        // Test builds only: report a failure the framework did not produce (MEM-11 tests).
        #[cfg(feature = "fault-injection")]
        if crate::testing::take(crate::testing::Op::Unmap) {
            return Err(CallError {
                call: "hv_vm_unmap",
                error: HvError::Error,
            });
        }
        result
    }

    /// Change the permissions of a mapped range (dirty tracking, ROM).
    pub fn protect(&self, ipa: u64, len: usize, flags: MemFlags) -> Result<(), CallError> {
        // SAFETY: changes guest permissions only; host memory is unaffected.
        check("hv_vm_protect", unsafe {
            ffi::hv_vm_protect(ipa, len, flags.0)
        })
    }
}

impl Drop for Vm {
    fn drop(&mut self) {
        // A destroy failure cannot be reported from `drop`; callers who need it use `destroy`.
        let _ = self.destroy_inner();
    }
}

/// An access outside an [`OwnedMapping`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OutOfBounds {
    pub offset: u64,
    pub len: usize,
    pub size: usize,
}

impl core::fmt::Display for OutOfBounds {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "{} bytes at offset {:#x} do not fit in a {:#x}-byte mapping",
            self.len, self.offset, self.size
        )
    }
}

impl std::error::Error for OutOfBounds {}

// ANCHOR: owned_mapping_range
/// The byte range `offset..offset+len` inside a `size`-byte block, or an error. Pure, so the
/// bounds logic is host-testable (`owned_mapping_write_bounds`). `checked_add` makes
/// `offset = u64::MAX` an error instead of a wrapped, in-range-looking index.
pub fn checked_span(size: usize, offset: u64, len: usize) -> Result<Range<usize>, OutOfBounds> {
    let err = OutOfBounds { offset, len, size };
    let start = usize::try_from(offset).map_err(|_| err)?;
    let end = start.checked_add(len).ok_or(err)?;
    if end > size {
        return Err(err);
    }
    Ok(start..end)
}
// ANCHOR_END: owned_mapping_range

/// Host memory that this value allocated and mapped at a fixed IPA; unmapped and freed on drop.
///
/// It borrows the [`Vm`], so it cannot outlive it. Host-side access copies bytes with volatile
/// operations through a raw pointer, never through a reference, because the guest may be
/// running and writing the same bytes.
#[derive(Debug)]
pub struct OwnedMapping<'vm> {
    vm: &'vm Vm,
    ipa: u64,
    alloc: Option<host::Allocation>,
}

impl<'vm> OwnedMapping<'vm> {
    /// Allocate `len` bytes (a non-zero multiple of the host page size) and map them at `ipa`.
    pub fn new(
        vm: &'vm Vm,
        ipa: u64,
        len: usize,
        flags: MemFlags,
    ) -> Result<OwnedMapping<'vm>, CallError> {
        let alloc = host::allocate(len)?;
        // SAFETY: `alloc` is one live `hv_vm_allocate` block of exactly `len` bytes; it is
        // owned by the returned value, which unmaps before freeing (see `Drop`), and its bytes
        // are only ever touched through volatile raw-pointer copies.
        unsafe { vm.map(alloc.as_ptr(), ipa, len, flags)? };
        Ok(OwnedMapping {
            vm,
            ipa,
            alloc: Some(alloc),
        })
    }

    /// The guest-physical base address.
    pub fn ipa(&self) -> u64 {
        self.ipa
    }

    /// Size in bytes.
    pub fn len(&self) -> usize {
        self.alloc.as_ref().map_or(0, host::Allocation::len)
    }

    /// Always false (zero-sized mappings are refused).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    // ANCHOR: owned_mapping_write
    /// Copy `data` into the mapping at byte `offset`. Out-of-range writes are refused whole.
    pub fn write(&self, offset: u64, data: &[u8]) -> Result<(), OutOfBounds> {
        let Some(alloc) = &self.alloc else {
            return Err(OutOfBounds {
                offset,
                len: data.len(),
                size: 0,
            });
        };
        let span = checked_span(alloc.len(), offset, data.len())?;
        for (i, byte) in span.zip(data) {
            // SAFETY: `i < alloc.len()` by `checked_span`, so the pointer stays inside the live
            // allocation; a volatile byte store creates no reference to guest-shared memory.
            unsafe { alloc.as_ptr().add(i).write_volatile(*byte) };
        }
        Ok(())
    }
    // ANCHOR_END: owned_mapping_write

    /// Copy bytes out of the mapping at `offset` into `buf`.
    pub fn read(&self, offset: u64, buf: &mut [u8]) -> Result<(), OutOfBounds> {
        let Some(alloc) = &self.alloc else {
            return Err(OutOfBounds {
                offset,
                len: buf.len(),
                size: 0,
            });
        };
        let span = checked_span(alloc.len(), offset, buf.len())?;
        for (i, out) in span.zip(buf.iter_mut()) {
            // SAFETY: as in `write`: in bounds, volatile, no reference into the mapping.
            *out = unsafe { alloc.as_ptr().add(i).read_volatile() };
        }
        Ok(())
    }
}

impl Drop for OwnedMapping<'_> {
    fn drop(&mut self) {
        if let Some(alloc) = self.alloc.take() {
            if self.vm.unmap(self.ipa, alloc.len()).is_ok() {
                drop(alloc);
            } else {
                // Fail closed (MEM-11): memory the guest may still reach is never freed.
                let _ = alloc.leak();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PLAN M1 security test: the pure range helper behind `OwnedMapping::write`.
    #[test]
    fn owned_mapping_write_bounds() {
        let size = 0x4000;
        assert_eq!(checked_span(size, 0, 4), Ok(0..4));
        assert_eq!(checked_span(size, 0x3ffc, 4), Ok(0x3ffc..0x4000));
        assert_eq!(checked_span(size, 0x4000, 0), Ok(0x4000..0x4000));
        assert_eq!(checked_span(size, 0, size), Ok(0..size));
        // One byte past the end, in every way of getting there.
        for (offset, len) in [
            (0x3ffd, 4),
            (0x4000, 1),
            (0x4001, 0),
            (0, size + 1),
            (u64::MAX, 1),
            (u64::MAX, 0),
            (u64::MAX - 3, 8),
            (1 << 63, 1),
            (1, usize::MAX),
            (0, usize::MAX),
        ] {
            let err = checked_span(size, offset, len).unwrap_err();
            assert_eq!(
                err,
                OutOfBounds { offset, len, size },
                "{offset:#x}+{len:#x}"
            );
            assert!(!err.to_string().is_empty());
        }
        // A zero-sized block refuses everything but an empty access at 0.
        assert_eq!(checked_span(0, 0, 0), Ok(0..0));
        assert!(checked_span(0, 0, 1).is_err());
    }

    #[test]
    fn mem_flags_compose() {
        assert_eq!(MemFlags::READ | MemFlags::WRITE, MemFlags::RW);
        assert_eq!(MemFlags::RW | MemFlags::EXEC, MemFlags::RWX);
        assert_eq!(MemFlags::RX.0, 5);
        assert_eq!(
            IpaGranule::from_raw(IpaGranule::K4.raw()),
            Some(IpaGranule::K4)
        );
        assert_eq!(
            IpaGranule::from_raw(IpaGranule::K16.raw()),
            Some(IpaGranule::K16)
        );
        assert_eq!(IpaGranule::from_raw(7), None);
    }
}

#[cfg(all(test, feature = "hvf-tests"))]
mod hvf_tests {
    use super::*;

    /// A failed GIC creation tears the VM down and releases the singleton exactly once, so
    /// the process can create a VM again, and the flag still refuses a second live one.
    #[test]
    fn gic_failure_releases_singleton_once() {
        // 4 KiB is below the 64 KiB GIC base alignment (spike finding 15).
        let misaligned = GicConfig {
            distributor_base: 0x1000,
            redistributor_base: 0x2000,
            msi: None,
        };
        let err = VmBuilder::new().with_gic(misaligned).create().unwrap_err();
        assert!(err.call.starts_with("hv_gic"), "{err:?}");
        assert!(!VM_LIVE.load(Ordering::Acquire));

        let (vm, gic) = VmBuilder::new()
            .create()
            .expect("VM after a failed GIC create");
        assert!(gic.is_none());
        let busy = VmBuilder::new().create().unwrap_err();
        assert_eq!(busy.error, HvError::Busy);
        // The refused second create must not have cleared the first VM's claim.
        assert!(VM_LIVE.load(Ordering::Acquire));
        vm.destroy().expect("hv_vm_destroy");
        assert!(!VM_LIVE.load(Ordering::Acquire));
    }

    /// `OwnedMapping` round-trips bytes, refuses out-of-range access, and unmaps on drop so
    /// the same IPA can be mapped again.
    #[test]
    fn owned_mapping_roundtrip_and_remap() {
        let (vm, _) = VmBuilder::new().create().expect("hv_vm_create");
        let page = crate::caps::host_page_size();
        let ipa = 1 << 30;
        {
            let m = OwnedMapping::new(&vm, ipa, page, MemFlags::RW).expect("map");
            assert_eq!((m.ipa(), m.len(), m.is_empty()), (ipa, page, false));
            m.write(8, &[1, 2, 3, 4]).expect("write");
            let mut buf = [0u8; 6];
            m.read(7, &mut buf).expect("read");
            assert_eq!(buf, [0, 1, 2, 3, 4, 0]);
            assert!(m.write(page as u64 - 1, &[0, 0]).is_err());
            assert!(m.read(u64::MAX, &mut buf).is_err());
            // Overlap with a live mapping: `HV_ERROR` (spike).
            let clash = OwnedMapping::new(&vm, ipa, page, MemFlags::RW).unwrap_err();
            assert_eq!(clash.error, HvError::Error);
        }
        let again = OwnedMapping::new(&vm, ipa, page, MemFlags::RW).expect("remap after drop");
        drop(again);
        vm.destroy().expect("hv_vm_destroy");
    }
}
