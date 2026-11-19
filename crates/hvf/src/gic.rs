//! The in-kernel GICv3: [`GicConfig`] places it, [`Gic`] proves it exists, [`GicHandle`] raises
//! interrupts from any thread.
//!
//! **Why the kernel's GIC** (ADR-0004): with `hv_gic_create` the distributor, the redistributors,
//! the ICC system registers, WFI and the virtual timer are all handled inside the kernel, with
//! zero exits to us (spike findings 14–16). The VMM's only interrupt job becomes
//! "assert or deassert an SPI line" ([`GicHandle::set_spi`]), which the GIC architecture calls a
//! level-sensitive SPI (GIC spec IHI 0069 §1.2.1 "Interrupt types", §4.1).
//!
//! **Ordering rule** (`hv_gic.h`): the GIC must be created after `hv_vm_create` and before any
//! `hv_vcpu_create`. [`crate::VmBuilder::with_gic`] does it inside `create`, before the `Vm` value
//! exists, so no `Vcpu` (which borrows the `Vm`) can be created first.
//!
//! **Geometry** is the framework's, not ours to choose ([`GicParams`]): on the M5 Pro the
//! distributor is 64 KiB, each vCPU's redistributor 128 KiB (RD_base + SGI_base frames), the
//! redistributor region 32 MiB, bases 64 KiB aligned, SPIs 32..1019 (spike finding 15).
//!
//! **Bound to one VM.** The framework's GIC calls take no handle: they act on "the" GIC of the
//! process's one VM. [`Gic`] and [`GicHandle`] therefore carry the generation of the VM they
//! were created with, and every state-touching call goes through `vm::with_live_vm`, which
//! refuses it with `HV_BAD_ARGUMENT` once that VM is destroyed, even after a new VM with its own
//! GIC exists (the in-process reboot of architecture §14.5). The geometry queries
//! ([`Gic::distributor_size`], [`Gic::redistributor_size`], [`Gic::spi_range`], [`GicParams`])
//! describe the framework, not a VM, and are not gated.
//!
//! **Threads:** distributor/MSI register access, `set_spi`, `send_msi`, state save/restore and
//! reset work from any thread (`hv_gic.h` gives no owner rule for them). Per-vCPU registers (ICC,
//! ICH, ICV, redistributor) are owner-thread only and live on [`crate::Vcpu`].

use crate::error::{CallError, check};
use crate::ffi;
use crate::host::OsObject;
use crate::vm::with_live_vm;
use core::ops::Range;

/// The optional GICv2m-style MSI frame (needed only for PCI MSIs, post-v1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MsiConfig {
    /// MSI frame base IPA (64 KiB aligned).
    pub base: u64,
    /// First SPI INTID reserved for MSIs.
    pub intid_base: u32,
    /// Number of SPIs reserved for MSIs.
    pub intid_count: u32,
}

/// Where the in-kernel GIC's frames live in guest-physical space.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GicConfig {
    /// GICD base IPA (64 KiB aligned).
    pub distributor_base: u64,
    /// Base IPA of the redistributor region (one 128 KiB frame pair per vCPU, creation order).
    pub redistributor_base: u64,
    /// The MSI frame, or `None` (no PCI).
    pub msi: Option<MsiConfig>,
}

// ANCHOR: gic_create
/// `hv_gic_config_create` → set bases → `hv_gic_create`. Requires a live VM with no vCPUs.
pub(crate) fn create(config: GicConfig, generation: u64) -> Result<Gic, CallError> {
    // SAFETY: called by `VmBuilder::create` after `hv_vm_create` succeeded, as
    // `hv_gic_config.h` requires; NULL is turned into an error by `OsObject::new`.
    let cfg = OsObject::new("hv_gic_config_create", unsafe {
        ffi::hv_gic_config_create()
    })?;
    // SAFETY: `cfg` is a live `hv_gic_config_t` owned by `cfg` for these calls.
    check("hv_gic_config_set_distributor_base", unsafe {
        ffi::hv_gic_config_set_distributor_base(cfg.as_ptr(), config.distributor_base)
    })?;
    // SAFETY: as above.
    check("hv_gic_config_set_redistributor_base", unsafe {
        ffi::hv_gic_config_set_redistributor_base(cfg.as_ptr(), config.redistributor_base)
    })?;
    if let Some(msi) = config.msi {
        // SAFETY: as above.
        check("hv_gic_config_set_msi_region_base", unsafe {
            ffi::hv_gic_config_set_msi_region_base(cfg.as_ptr(), msi.base)
        })?;
        // SAFETY: as above.
        check("hv_gic_config_set_msi_interrupt_range", unsafe {
            ffi::hv_gic_config_set_msi_interrupt_range(
                cfg.as_ptr(),
                msi.intid_base,
                msi.intid_count,
            )
        })?;
    }
    // SAFETY: a VM exists and no vCPU can exist yet (`Vcpu` borrows `Vm`, which the builder has
    // not returned), satisfying `hv_gic.h`'s ordering rule. The framework copies the config.
    check("hv_gic_create", unsafe { ffi::hv_gic_create(cfg.as_ptr()) })?;
    Ok(Gic { generation })
}
// ANCHOR_END: gic_create

/// The framework's GIC geometry (`hv_gic_parameters.h`). Queried, never assumed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GicParams {
    pub distributor_size: usize,
    pub distributor_base_alignment: usize,
    pub redistributor_region_size: usize,
    /// Size of one vCPU's redistributor (RD_base + SGI_base frames).
    pub redistributor_size: usize,
    pub redistributor_base_alignment: usize,
    pub msi_region_size: usize,
    pub msi_region_base_alignment: usize,
    /// First SPI INTID.
    pub spi_base: u32,
    /// Number of SPI INTIDs.
    pub spi_count: u32,
}

/// One `hv_gic_get_*` size query: `size_t *` out-parameter, no other arguments.
fn size(
    call: &'static str,
    f: unsafe extern "C" fn(*mut usize) -> ffi::hv_return_t,
) -> Result<usize, CallError> {
    let mut v = 0usize;
    // SAFETY: `f` is one of the `hv_gic_get_*` parameter queries, each taking a single
    // `size_t *` out-parameter (`hv_gic_parameters.h`); `v` is a live local.
    check(call, unsafe { f(&mut v) })?;
    Ok(v)
}

/// `hv_gic_get_spi_interrupt_range`: `(first SPI INTID, number of SPIs)`.
fn spi_base_count() -> Result<(u32, u32), CallError> {
    let mut spi_base = 0u32;
    let mut spi_count = 0u32;
    // SAFETY: two live `u32` out-parameters.
    check("hv_gic_get_spi_interrupt_range", unsafe {
        ffi::hv_gic_get_spi_interrupt_range(&mut spi_base, &mut spi_count)
    })?;
    Ok((spi_base, spi_count))
}

impl GicParams {
    /// Ask the framework for every size and alignment.
    pub fn query() -> Result<GicParams, CallError> {
        let (spi_base, spi_count) = spi_base_count()?;
        Ok(GicParams {
            distributor_size: size(
                "hv_gic_get_distributor_size",
                ffi::hv_gic_get_distributor_size,
            )?,
            distributor_base_alignment: size(
                "hv_gic_get_distributor_base_alignment",
                ffi::hv_gic_get_distributor_base_alignment,
            )?,
            redistributor_region_size: size(
                "hv_gic_get_redistributor_region_size",
                ffi::hv_gic_get_redistributor_region_size,
            )?,
            redistributor_size: size(
                "hv_gic_get_redistributor_size",
                ffi::hv_gic_get_redistributor_size,
            )?,
            redistributor_base_alignment: size(
                "hv_gic_get_redistributor_base_alignment",
                ffi::hv_gic_get_redistributor_base_alignment,
            )?,
            msi_region_size: size(
                "hv_gic_get_msi_region_size",
                ffi::hv_gic_get_msi_region_size,
            )?,
            msi_region_base_alignment: size(
                "hv_gic_get_msi_region_base_alignment",
                ffi::hv_gic_get_msi_region_base_alignment,
            )?,
            spi_base,
            spi_count,
        })
    }
}

/// The PPIs the framework wires to its own devices (`hv_gic_intid_t`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GicInterrupt {
    PerformanceMonitor,
    /// EL2 only.
    Maintenance,
    /// EL2 only.
    El2PhysicalTimer,
    /// The guest's CNTV: PPI 27 (spike finding 16).
    El1VirtualTimer,
    El1PhysicalTimer,
}

impl GicInterrupt {
    fn raw(self) -> ffi::hv_gic_intid_t {
        match self {
            GicInterrupt::PerformanceMonitor => ffi::HV_GIC_INT_PERFORMANCE_MONITOR,
            GicInterrupt::Maintenance => ffi::HV_GIC_INT_MAINTENANCE,
            GicInterrupt::El2PhysicalTimer => ffi::HV_GIC_INT_EL2_PHYSICAL_TIMER,
            GicInterrupt::El1VirtualTimer => ffi::HV_GIC_INT_EL1_VIRTUAL_TIMER,
            GicInterrupt::El1PhysicalTimer => ffi::HV_GIC_INT_EL1_PHYSICAL_TIMER,
        }
    }
}

/// Upper bound on a GIC state blob we are willing to allocate. The framework produced 126 363
/// bytes for one vCPU (spike, `hv_gic_state_get_size`); 64 vCPUs stay far below this.
pub const MAX_GIC_STATE_BYTES: usize = 64 << 20;

/// The in-kernel GIC of one VM, returned by [`crate::VmBuilder::create`] next to that [`Vm`].
///
/// Holding a `Gic` proves that the VM created in the same `create` call had a GIC. The value
/// may outlive that VM, but then every call except the geometry queries is refused with
/// `HV_BAD_ARGUMENT` (module docs, "Bound to one VM"), so it can never act on a later VM.
///
/// [`Vm`]: crate::Vm
#[derive(Debug)]
pub struct Gic {
    /// Generation of the VM this GIC belongs to (`vm.rs`).
    generation: u64,
}

impl Gic {
    /// A copyable handle for device threads (used by `vmm::irq::GicSpi`, M8), bound to the same
    /// VM as `self`.
    pub fn handle(&self) -> GicHandle {
        GicHandle {
            generation: self.generation,
        }
    }

    /// Size of the GICD frame in bytes (`hv_gic_get_distributor_size`; 64 KiB on the M5 Pro).
    pub fn distributor_size(&self) -> Result<usize, CallError> {
        size(
            "hv_gic_get_distributor_size",
            ffi::hv_gic_get_distributor_size,
        )
    }

    /// Size of **one** vCPU's redistributor (RD_base + SGI_base frames;
    /// `hv_gic_get_redistributor_size`, 128 KiB on the M5 Pro). The DT's GICR `reg` covers
    /// `ncpus` of these (ADR-0003).
    pub fn redistributor_size(&self) -> Result<usize, CallError> {
        size(
            "hv_gic_get_redistributor_size",
            ffi::hv_gic_get_redistributor_size,
        )
    }

    /// The SPI INTIDs the framework accepts in [`GicHandle::set_spi`], as a half-open range
    /// (`32..1020` on the M5 Pro). An MSI range, if configured, lies inside it.
    pub fn spi_range(&self) -> Result<Range<u32>, CallError> {
        let (base, count) = spi_base_count()?;
        // A framework answer that overflows is not something to build a range from.
        let end = base.checked_add(count).ok_or(CallError {
            call: "hv_gic_get_spi_interrupt_range",
            error: crate::HvError::Error,
        })?;
        Ok(base..end)
    }

    /// The INTID the framework assigned to one of its fixed interrupts.
    pub fn intid(&self, which: GicInterrupt) -> Result<u32, CallError> {
        with_live_vm(self.generation, "hv_gic_get_intid", || {
            let mut v = 0u32;
            // SAFETY: a valid enumerator and a live `u32` out-parameter.
            check("hv_gic_get_intid", unsafe {
                ffi::hv_gic_get_intid(which.raw(), &mut v)
            })?;
            Ok(v)
        })
    }

    /// Read a distributor register; `reg` is its offset in the GICD frame (`ffi.rs` notes).
    pub fn distributor_reg(&self, reg: ffi::hv_gic_distributor_reg_t) -> Result<u64, CallError> {
        with_live_vm(self.generation, "hv_gic_get_distributor_reg", || {
            let mut v = 0u64;
            // SAFETY: a live `u64` out-parameter; the framework validates `reg`.
            check("hv_gic_get_distributor_reg", unsafe {
                ffi::hv_gic_get_distributor_reg(reg, &mut v)
            })?;
            Ok(v)
        })
    }

    /// Write a distributor register.
    pub fn set_distributor_reg(
        &self,
        reg: ffi::hv_gic_distributor_reg_t,
        value: u64,
    ) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_set_distributor_reg", || {
            // SAFETY: plain values; the framework validates `reg`.
            check("hv_gic_set_distributor_reg", unsafe {
                ffi::hv_gic_set_distributor_reg(reg, value)
            })
        })
    }

    /// Read an MSI-frame register.
    pub fn msi_reg(&self, reg: ffi::hv_gic_msi_reg_t) -> Result<u64, CallError> {
        with_live_vm(self.generation, "hv_gic_get_msi_reg", || {
            let mut v = 0u64;
            // SAFETY: a live `u64` out-parameter.
            check("hv_gic_get_msi_reg", unsafe {
                ffi::hv_gic_get_msi_reg(reg, &mut v)
            })?;
            Ok(v)
        })
    }

    /// Write an MSI-frame register.
    pub fn set_msi_reg(&self, reg: ffi::hv_gic_msi_reg_t, value: u64) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_set_msi_reg", || {
            // SAFETY: plain values.
            check("hv_gic_set_msi_reg", unsafe {
                ffi::hv_gic_set_msi_reg(reg, value)
            })
        })
    }

    /// Reset distributor, redistributors and internal state (SYSTEM_RESET; spike: GICD_CTLR
    /// returns to 0x50).
    pub fn reset(&self) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_reset", || {
            // SAFETY: no arguments.
            check("hv_gic_reset", unsafe { ffi::hv_gic_reset() })
        })
    }

    /// Capture the opaque, versioned GIC state (everything except the per-vCPU ICC registers).
    /// The VM must be stopped (`hv_gic_state.h`).
    pub fn save_state(&self) -> Result<Vec<u8>, CallError> {
        with_live_vm(self.generation, "hv_gic_state_create", save_state)
    }

    /// Restore a blob from [`Gic::save_state`]. Call after the vCPUs exist and before any runs
    /// (`hv_gic.h`). The blob goes to a kernel parser, so `vmm` must authenticate snapshot
    /// files before handing them here (threat model POST-1).
    pub fn restore_state(&self, data: &[u8]) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_set_state", || {
            // SAFETY: `data` is a live slice; the framework reads exactly `data.len()` bytes.
            check("hv_gic_set_state", unsafe {
                ffi::hv_gic_set_state(data.as_ptr().cast(), data.len())
            })
        })
    }
}

/// The body of [`Gic::save_state`], run under the live-VM check.
fn save_state() -> Result<Vec<u8>, CallError> {
    // SAFETY: no arguments; NULL becomes an error.
    let state = OsObject::new("hv_gic_state_create", unsafe { ffi::hv_gic_state_create() })?;
    let mut size = 0usize;
    // SAFETY: `state` is live; `size` is a live out-parameter.
    check("hv_gic_state_get_size", unsafe {
        ffi::hv_gic_state_get_size(state.as_ptr(), &mut size)
    })?;
    if size > MAX_GIC_STATE_BYTES {
        return Err(CallError {
            call: "hv_gic_state_get_size",
            error: crate::HvError::NoResources,
        });
    }
    let mut buf = vec![0u8; size];
    // SAFETY: `buf` has exactly the `size` bytes the framework just asked for, and `state`
    // is the same object whose size it reported.
    check("hv_gic_state_get_data", unsafe {
        ffi::hv_gic_state_get_data(state.as_ptr(), buf.as_mut_ptr().cast())
    })?;
    Ok(buf)
}

/// `Copy + Send + Sync` capability to drive interrupt lines from any thread.
///
/// It holds no pointer (the framework's GIC is per process), only the generation of the VM it
/// was made for. Once that VM is destroyed every call returns `HV_BAD_ARGUMENT`, also after a
/// new VM with its own GIC exists, so a handle that survives a reboot cannot raise lines in the
/// next boot's guest (`vm::with_live_vm`; test `stale_gic_tokens_are_refused`).
#[derive(Clone, Copy, Debug)]
pub struct GicHandle {
    generation: u64,
}

impl GicHandle {
    /// Assert (`level = true`) or deassert an SPI. Any thread; wakes a vCPU sitting in
    /// in-kernel WFI (spike finding 18). An INTID outside the SPI range, or inside the MSI
    /// range, returns `HV_BAD_ARGUMENT` (`hv_gic.h`); `vmm::irq::GicSpi` validates first (M8).
    pub fn set_spi(&self, intid: u32, level: bool) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_set_spi", || {
            // SAFETY: plain values; the framework validates `intid`.
            check("hv_gic_set_spi", unsafe {
                ffi::hv_gic_set_spi(intid, level)
            })
        })
    }

    /// Signal an MSI as if a device wrote `intid` to the frame's `GICM_SETSPI_NSR` at `address`.
    pub fn send_msi(&self, address: u64, intid: u32) -> Result<(), CallError> {
        with_live_vm(self.generation, "hv_gic_send_msi", || {
            // SAFETY: plain values; the framework validates both.
            check("hv_gic_send_msi", unsafe {
                ffi::hv_gic_send_msi(address, intid)
            })
        })
    }
}
