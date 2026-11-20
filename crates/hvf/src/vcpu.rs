//! vCPUs: [`Vcpu`] runs one on its owning thread, [`VcpuHandle`] kicks it from anywhere.
//!
//! **The threading rule is the framework's, enforced by the type system** (ADR-0002 item 5):
//! `hv_vcpu_create` creates a vCPU *for the calling thread*, and almost every per-vCPU call
//! ("must be called by the owning thread", `hv_vcpu.h`) fails with `HV_BAD_ARGUMENT` from any
//! other thread (spike: `hv_vcpu_get_reg` from a non-owner). So:
//! - `Vcpu<'vm>` is **`!Send` and `!Sync`**: it can never reach another thread, so every method
//!   on it is called by the owner, and `Drop` (`hv_vcpu_destroy`) runs on the owner too.
//! - It borrows the [`Vm`], so a vCPU cannot outlive the VM ("`hv_vm_destroy` requires all
//!   vCPUs be destroyed"). Both rules are compile-time facts.
//! - [`VcpuHandle`] is `Copy + Send + Sync` and can do exactly one thing: `hv_vcpus_exit`, the
//!   one call documented for any thread. It forces the vCPU out of `hv_vcpu_run` with
//!   `HV_EXIT_REASON_CANCELED`; a kick sent while the vCPU is *not* running is remembered and
//!   makes the next run return CANCELED at once (spike finding 13), so run loops must tolerate
//!   spurious CANCELED exits.
//!
//! **Exits.** `hv_vcpu_create` hands back a pointer to a framework-owned `hv_vcpu_exit_t` that
//! every `hv_vcpu_run` rewrites. We read it with `read_volatile` right after each run and copy
//! it into an owned [`VcpuExit`], so no Rust reference to framework memory ever exists and the
//! compiler cannot cache a stale value. The syndrome is ESR_EL2 (ARM ARM, ESR_EL2 register
//! description), FAR_EL2 is the guest VA and `physical_address` the faulting IPA. Decoding them
//! is policy and lives in `vmm::arch::esr` (M4).
//!
//! The compile-time rules are tested by the doctests on the doctest-only modules at the end of
//! this file (`vcpu_not_send`, `vcpu_not_sync`, `vcpu_cannot_outlive_vm`, and the positive
//! controls `vcpu_handle_is_send_sync`, `vcpu_borrows_vm_ok` that prove the harness compiles).

use crate::error::{CallError, HvError, check};
use crate::ffi;
use crate::regs::{Reg, SysReg};
use crate::vm::Vm;
use core::marker::PhantomData;

// ANCHOR: vcpu_not_send
/// A vCPU, owned by the thread that created it. It is neither `Send` nor `Sync` (it cannot be
/// moved to or shared with another thread) and it borrows the [`Vm`] (it cannot outlive it).
#[derive(Debug)]
pub struct Vcpu<'vm> {
    id: ffi::hv_vcpu_t,
    /// Framework-owned; valid until `hv_vcpu_destroy`. Read only with `read_volatile`.
    exit: *const ffi::hv_vcpu_exit_t,
    _vm: PhantomData<&'vm Vm>,
    /// Explicit `!Send + !Sync` marker (the raw pointer above already implies it).
    _not_send: PhantomData<*const ()>,
}

/// A `Vcpu` cannot be sent to another thread:
///
/// ```compile_fail,E0277
/// fn assert_send<T: Send>() {}
/// assert_send::<hvf::Vcpu<'static>>();
/// ```
#[cfg(doctest)]
pub mod vcpu_not_send {}
// ANCHOR_END: vcpu_not_send

/// Nor shared between threads:
///
/// ```compile_fail,E0277
/// fn assert_sync<T: Sync>() {}
/// assert_sync::<hvf::Vcpu<'static>>();
/// ```
#[cfg(doctest)]
pub mod vcpu_not_sync {}

/// Nor outlive the VM, so `hv_vm_destroy` can never run while a vCPU exists:
///
/// ```compile_fail,E0505
/// let (vm, _) = hvf::VmBuilder::new().create().unwrap();
/// let vcpu = hvf::Vcpu::create(&vm).unwrap();
/// vm.destroy().unwrap(); // error: `vm` is still borrowed by `vcpu`
/// drop(vcpu);
/// ```
#[cfg(doctest)]
pub mod vcpu_cannot_outlive_vm {}

/// Positive control for the test above: the right order compiles. (`no_run`: doctest binaries
/// live outside the target dir, so the signing runner refuses to run them, SIGN-4.)
///
/// ```no_run,standalone_crate
/// let (vm, _) = hvf::VmBuilder::new().create().unwrap();
/// let vcpu = hvf::Vcpu::create(&vm).unwrap();
/// drop(vcpu);
/// vm.destroy().unwrap();
/// ```
#[cfg(doctest)]
pub mod vcpu_borrows_vm_ok {}

/// Positive control: `VcpuHandle` is meant to cross threads.
///
/// ```no_run,standalone_crate
/// fn assert_send_sync<T: Send + Sync + Copy>() {}
/// assert_send_sync::<hvf::VcpuHandle>();
/// assert_send_sync::<hvf::GicHandle>();
/// fn assert_send_sync_vm<T: Send + Sync>() {}
/// assert_send_sync_vm::<hvf::Vm>();
/// assert_send_sync_vm::<hvf::Gic>();
/// ```
#[cfg(doctest)]
pub mod vcpu_handle_is_send_sync {}

// ANCHOR: vcpu_exit_reason
/// Why `hv_vcpu_run` returned (`hv_exit_reason_t`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitReason {
    /// `hv_vcpus_exit` (possibly a sticky kick from before this run).
    Canceled,
    /// A synchronous exception to EL2: decode `esr`.
    Exception,
    /// The virtual timer fired (only without an in-kernel interrupt controller). The framework
    /// has masked it.
    VtimerActivated,
    /// `HV_EXIT_REASON_UNKNOWN`: "should not happen under normal operation".
    Unknown,
    /// A value this SDK does not define, kept verbatim. Never a panic.
    Other(u32),
}

impl ExitReason {
    fn from_raw(raw: ffi::hv_exit_reason_t) -> ExitReason {
        match raw {
            ffi::HV_EXIT_REASON_CANCELED => ExitReason::Canceled,
            ffi::HV_EXIT_REASON_EXCEPTION => ExitReason::Exception,
            ffi::HV_EXIT_REASON_VTIMER_ACTIVATED => ExitReason::VtimerActivated,
            ffi::HV_EXIT_REASON_UNKNOWN => ExitReason::Unknown,
            other => ExitReason::Other(other),
        }
    }

    /// The header's name without the `HV_EXIT_REASON_` prefix, for messages.
    pub fn name(self) -> &'static str {
        match self {
            ExitReason::Canceled => "CANCELED",
            ExitReason::Exception => "EXCEPTION",
            ExitReason::VtimerActivated => "VTIMER_ACTIVATED",
            ExitReason::Unknown => "UNKNOWN",
            ExitReason::Other(_) => "<undefined>",
        }
    }
}
// ANCHOR_END: vcpu_exit_reason

// ANCHOR: vcpu_exit_record
/// An owned copy of the framework's exit record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VcpuExit {
    pub reason: ExitReason,
    /// ESR_EL2 for the exit (`exception.syndrome`).
    pub esr: u64,
    /// FAR_EL2: the faulting guest virtual address, where defined.
    pub far: u64,
    /// The faulting IPA, page offset included.
    pub ipa: u64,
}

impl VcpuExit {
    fn from_raw(raw: ffi::hv_vcpu_exit_t) -> VcpuExit {
        VcpuExit {
            reason: ExitReason::from_raw(raw.reason),
            esr: raw.exception.syndrome,
            far: raw.exception.virtual_address,
            ipa: raw.exception.physical_address,
        }
    }
}
// ANCHOR_END: vcpu_exit_record

/// `Copy + Send + Sync`: the only thing another thread may do to a vCPU is make it exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct VcpuHandle(ffi::hv_vcpu_t);

impl VcpuHandle {
    /// The framework's vCPU id (small integers in creation order).
    pub fn id(self) -> u64 {
        self.0
    }
}

// ANCHOR: vcpus_exit_handle
/// Force every listed vCPU out of `hv_vcpu_run` (any thread). A handle whose vCPU is not
/// running gets a sticky kick: its next run returns CANCELED immediately. A stale handle (its
/// vCPU destroyed) is harmless: the framework rejects the id, or a new vCPU that reused it
/// sees one spurious CANCELED.
pub fn vcpus_exit(handles: &[VcpuHandle]) -> Result<(), CallError> {
    if handles.is_empty() {
        return Ok(());
    }
    let mut ids: Vec<ffi::hv_vcpu_t> = handles.iter().map(|h| h.0).collect();
    let count = u32::try_from(ids.len()).map_err(|_| CallError {
        call: "hv_vcpus_exit",
        error: HvError::BadArgument,
    })?;
    // SAFETY: `ids` is a live, writable array of exactly `count` vCPU ids (the C prototype
    // takes a non-const pointer, so we pass our own copy).
    check("hv_vcpus_exit", unsafe {
        ffi::hv_vcpus_exit(ids.as_mut_ptr(), count)
    })
}
// ANCHOR_END: vcpus_exit_handle

// ANCHOR: vcpu_get_via_out
/// Generate an owner-thread getter that reads one value through an out-pointer.
macro_rules! get_via_out {
    ($(#[$m:meta])* $fname:ident, $call:ident, $ty:ty, $($arg:expr),*) => {
        $(#[$m])*
        pub fn $fname(&self) -> Result<$ty, CallError> {
            let mut v: $ty = Default::default();
            // SAFETY: called on the owning thread (`Vcpu` is `!Send`); `v` is a live local of
            // the C out-parameter's type.
            check(stringify!($call), unsafe { ffi::$call(self.id, $($arg,)* &mut v) })?;
            Ok(v)
        }
    };
}
// ANCHOR_END: vcpu_get_via_out

impl<'vm> Vcpu<'vm> {
    // ANCHOR: vcpu_create
    /// Create a vCPU for the calling thread. A thread may own only one vCPU at a time (a second
    /// create returns `HV_BUSY`; checked on a real Mac).
    ///
    /// `vm` is not passed to the framework (the VM is per process); taking the borrow is what
    /// ties the vCPU's lifetime to the VM's.
    pub fn create(vm: &'vm Vm) -> Result<Vcpu<'vm>, CallError> {
        let _borrow: &'vm Vm = vm;
        let mut id: ffi::hv_vcpu_t = 0;
        let mut exit: *mut ffi::hv_vcpu_exit_t = core::ptr::null_mut();
        // SAFETY: both out-parameters are live locals; a NULL config means "default", which the
        // header allows (`_Nullable`). A VM exists because we borrow `vm`.
        check("hv_vcpu_create", unsafe {
            ffi::hv_vcpu_create(&mut id, &mut exit, core::ptr::null_mut())
        })?;
        if exit.is_null() {
            // Never observed; refuse rather than read through NULL later. Destroy on this,
            // the owning, thread.
            // SAFETY: `id` was just created by this thread and is destroyed once.
            let _ = unsafe { ffi::hv_vcpu_destroy(id) };
            return Err(CallError {
                call: "hv_vcpu_create",
                error: HvError::Error,
            });
        }
        Ok(Vcpu {
            id,
            exit,
            _vm: PhantomData,
            _not_send: PhantomData,
        })
    }
    // ANCHOR_END: vcpu_create

    /// The kick handle for other threads.
    pub fn handle(&self) -> VcpuHandle {
        VcpuHandle(self.id)
    }

    /// The framework's vCPU id.
    pub fn id(&self) -> u64 {
        self.id
    }

    // ANCHOR: vcpu_run
    /// Enter the guest until the next exit, then return an owned copy of the exit record.
    pub fn run(&mut self) -> Result<VcpuExit, CallError> {
        // SAFETY: owning thread; `self.id` is live until `drop`.
        check("hv_vcpu_run", unsafe { ffi::hv_vcpu_run(self.id) })?;
        // SAFETY: `self.exit` is the framework-owned record returned by `hv_vcpu_create` for
        // this vCPU, valid and aligned until `hv_vcpu_destroy`; the run has finished writing it.
        // A volatile read copies it without forming a reference the compiler could cache.
        let raw = unsafe { core::ptr::read_volatile(self.exit) };
        Ok(VcpuExit::from_raw(raw))
    }
    // ANCHOR_END: vcpu_run

    // ANCHOR: vcpu_regs
    /// Read a general-purpose or special register.
    pub fn get_reg(&self, reg: Reg) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter; the framework validates `reg`.
        check("hv_vcpu_get_reg", unsafe {
            ffi::hv_vcpu_get_reg(self.id, reg.0, &mut v)
        })?;
        Ok(v)
    }

    /// Write a general-purpose or special register.
    pub fn set_reg(&self, reg: Reg, value: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_reg", unsafe {
            ffi::hv_vcpu_set_reg(self.id, reg.0, value)
        })
    }
    // ANCHOR_END: vcpu_regs

    // ANCHOR: vcpu_sys_regs
    /// Read a system register. HVF reaches only the registers `hv_vcpu_types.h` lists (our
    /// copy of that list: [`SysReg::HV_ACCESSIBLE`]).
    pub fn get_sys_reg(&self, reg: SysReg) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter.
        check("hv_vcpu_get_sys_reg", unsafe {
            ffi::hv_vcpu_get_sys_reg(self.id, reg.0, &mut v)
        })?;
        Ok(v)
    }

    /// Write a system register.
    pub fn set_sys_reg(&self, reg: SysReg, value: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_sys_reg", unsafe {
            ffi::hv_vcpu_set_sys_reg(self.id, reg.0, value)
        })
    }
    // ANCHOR_END: vcpu_sys_regs

    /// Read SIMD/FP register Q`q` (0..=31) as a little-endian `u128` (byte 0 = lane 0).
    pub fn get_simd(&self, q: u32) -> Result<u128, CallError> {
        let mut v = ffi::hv_simd_fp_uchar16_t::default();
        // SAFETY: owning thread; `v` is a live, 16-byte-aligned `hv_simd_fp_uchar16_t`.
        check("hv_vcpu_get_simd_fp_reg", unsafe {
            ffi::hv_vcpu_get_simd_fp_reg(self.id, q, &mut v)
        })?;
        Ok(u128::from_le_bytes(v.0))
    }

    /// Write SIMD/FP register Q`q` (by value in `v0`, via [`crate::simd`]).
    pub fn set_simd(&self, q: u32, value: u128) -> Result<(), CallError> {
        // SAFETY: owning thread; the trampoline implements the C calling convention.
        check("hv_vcpu_set_simd_fp_reg", unsafe {
            crate::simd::set_simd_fp_reg(self.id, q, value.to_le_bytes())
        })
    }

    // ANCHOR: vcpu_vtimer_fns
    get_via_out!(
        /// `CNTVCT_EL0 = mach_absolute_time() - offset` for this vCPU.
        vtimer_offset, hv_vcpu_get_vtimer_offset, u64,
    );

    /// Set the virtual counter offset (the same value on every vCPU, before its first run).
    pub fn set_vtimer_offset(&self, offset: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_vtimer_offset", unsafe {
            ffi::hv_vcpu_set_vtimer_offset(self.id, offset)
        })
    }

    get_via_out!(
        /// Whether the framework currently masks the vtimer (no-GIC mode; it sets the mask
        /// itself on every VTIMER exit).
        vtimer_mask, hv_vcpu_get_vtimer_mask, bool,
    );

    /// Mask or unmask the vtimer exit (no-GIC mode).
    pub fn set_vtimer_mask(&self, masked: bool) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_vtimer_mask", unsafe {
            ffi::hv_vcpu_set_vtimer_mask(self.id, masked)
        })
    }
    // ANCHOR_END: vcpu_vtimer_fns

    // ANCHOR: vcpu_exec_time
    get_via_out!(
        /// Cumulative guest run time in mach ticks.
        exec_time, hv_vcpu_get_exec_time, u64,
    );
    // ANCHOR_END: vcpu_exec_time

    /// Time spent in WFI, in mach ticks. `Ok(None)` when this macOS lacks the call (27.0+);
    /// `HV_UNSUPPORTED` without a GIC (spike).
    pub fn wfi_time(&self) -> Result<Option<u64>, CallError> {
        let Some(f) = crate::optional::get().hv_vcpu_get_wait_for_interrupt_time else {
            return Ok(None);
        };
        let mut v = 0u64;
        // SAFETY: `f` is the resolved framework function; owning thread; live out-parameter.
        check("hv_vcpu_get_wait_for_interrupt_time", unsafe {
            f(self.id, &mut v)
        })?;
        Ok(Some(v))
    }

    /// Is a virtual SError pending? `Ok(None)` before macOS 27.
    pub fn serror(&self) -> Result<Option<bool>, CallError> {
        let Some(f) = crate::optional::get().hv_vcpu_get_serror else {
            return Ok(None);
        };
        let mut v = false;
        // SAFETY: resolved function; owning thread; live out-parameter.
        check("hv_vcpu_get_serror", unsafe { f(self.id, &mut v) })?;
        Ok(Some(v))
    }

    /// Set or clear a pending virtual SError. `HV_UNSUPPORTED` before macOS 27.
    pub fn set_serror(&self, pending: bool) -> Result<(), CallError> {
        let f = crate::optional::get().hv_vcpu_set_serror.ok_or(CallError {
            call: "hv_vcpu_set_serror",
            error: HvError::Unsupported,
        })?;
        // SAFETY: resolved function; owning thread; plain values.
        check("hv_vcpu_set_serror", unsafe { f(self.id, pending) })
    }

    /// Perform a guest TLBI operation (macOS 27+, `HV_UNSUPPORTED` before).
    pub fn invalidate_tlb(&self, op: ffi::hv_tlbi_op_t, param: u64) -> Result<(), CallError> {
        let f = crate::optional::get()
            .hv_vcpu_invalidate_tlb
            .ok_or(CallError {
                call: "hv_vcpu_invalidate_tlb",
                error: HvError::Unsupported,
            })?;
        // SAFETY: resolved function; owning thread; plain values.
        check("hv_vcpu_invalidate_tlb", unsafe { f(self.id, op, param) })
    }

    /// The vCPU's IRQ (`fiq = false`) or FIQ line for the next run (no-GIC mode only;
    /// `HV_UNSUPPORTED` once a GIC exists, spike).
    pub fn pending_interrupt(&self, fiq: bool) -> Result<bool, CallError> {
        let ty = if fiq {
            ffi::HV_INTERRUPT_TYPE_FIQ
        } else {
            ffi::HV_INTERRUPT_TYPE_IRQ
        };
        let mut v = false;
        // SAFETY: owning thread; live out-parameter.
        check("hv_vcpu_get_pending_interrupt", unsafe {
            ffi::hv_vcpu_get_pending_interrupt(self.id, ty, &mut v)
        })?;
        Ok(v)
    }

    // ANCHOR: vcpu_set_pending_interrupt
    /// Assert or clear the IRQ/FIQ line; auto-cleared after each `run` (`hv_vcpu.h`).
    pub fn set_pending_interrupt(&self, fiq: bool, pending: bool) -> Result<(), CallError> {
        let ty = if fiq {
            ffi::HV_INTERRUPT_TYPE_FIQ
        } else {
            ffi::HV_INTERRUPT_TYPE_IRQ
        };
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_pending_interrupt", unsafe {
            ffi::hv_vcpu_set_pending_interrupt(self.id, ty, pending)
        })
    }
    // ANCHOR_END: vcpu_set_pending_interrupt

    get_via_out!(
        /// Whether BRK/watchpoint exceptions exit to the VMM (gdbstub seam, M26).
        trap_debug_exceptions, hv_vcpu_get_trap_debug_exceptions, bool,
    );

    /// Route debug exceptions to the VMM.
    pub fn set_trap_debug_exceptions(&self, on: bool) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_trap_debug_exceptions", unsafe {
            ffi::hv_vcpu_set_trap_debug_exceptions(self.id, on)
        })
    }

    get_via_out!(
        /// Whether DBG*/MDSCR accesses trap to the VMM.
        trap_debug_reg_accesses, hv_vcpu_get_trap_debug_reg_accesses, bool,
    );

    /// Route debug-register accesses to the VMM.
    pub fn set_trap_debug_reg_accesses(&self, on: bool) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_vcpu_set_trap_debug_reg_accesses", unsafe {
            ffi::hv_vcpu_set_trap_debug_reg_accesses(self.id, on)
        })
    }

    get_via_out!(
        /// This vCPU's redistributor base IPA. `HV_BAD_ARGUMENT` until MPIDR_EL1 has been
        /// written at least once (spike finding 17); then `GICR base + id * 0x20000`.
        gic_redistributor_base, hv_gic_get_redistributor_base, u64,
    );

    /// Read a redistributor register of this vCPU (offset from RD_base; SGI frame at +0x10000).
    pub fn gic_get_redistributor_reg(
        &self,
        reg: ffi::hv_gic_redistributor_reg_t,
    ) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter.
        check("hv_gic_get_redistributor_reg", unsafe {
            ffi::hv_gic_get_redistributor_reg(self.id, reg, &mut v)
        })?;
        Ok(v)
    }

    /// Write a redistributor register of this vCPU.
    pub fn gic_set_redistributor_reg(
        &self,
        reg: ffi::hv_gic_redistributor_reg_t,
        value: u64,
    ) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_gic_set_redistributor_reg", unsafe {
            ffi::hv_gic_set_redistributor_reg(self.id, reg, value)
        })
    }

    /// Read one of this vCPU's ICC (GIC CPU interface) registers.
    pub fn gic_get_icc_reg(&self, reg: ffi::hv_gic_icc_reg_t) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter.
        check("hv_gic_get_icc_reg", unsafe {
            ffi::hv_gic_get_icc_reg(self.id, reg, &mut v)
        })?;
        Ok(v)
    }

    /// Write one of this vCPU's ICC registers (snapshot restore).
    pub fn gic_set_icc_reg(&self, reg: ffi::hv_gic_icc_reg_t, value: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_gic_set_icc_reg", unsafe {
            ffi::hv_gic_set_icc_reg(self.id, reg, value)
        })
    }

    /// Read an ICH (virtualization control) register; EL2-enabled VMs only.
    pub fn gic_get_ich_reg(&self, reg: ffi::hv_gic_ich_reg_t) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter.
        check("hv_gic_get_ich_reg", unsafe {
            ffi::hv_gic_get_ich_reg(self.id, reg, &mut v)
        })?;
        Ok(v)
    }

    /// Write an ICH register; EL2-enabled VMs only.
    pub fn gic_set_ich_reg(&self, reg: ffi::hv_gic_ich_reg_t, value: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_gic_set_ich_reg", unsafe {
            ffi::hv_gic_set_ich_reg(self.id, reg, value)
        })
    }

    /// Read an ICV (virtual CPU interface) register; EL2-enabled VMs only.
    pub fn gic_get_icv_reg(&self, reg: ffi::hv_gic_icv_reg_t) -> Result<u64, CallError> {
        let mut v = 0u64;
        // SAFETY: owning thread; live out-parameter.
        check("hv_gic_get_icv_reg", unsafe {
            ffi::hv_gic_get_icv_reg(self.id, reg, &mut v)
        })?;
        Ok(v)
    }

    /// Write an ICV register; EL2-enabled VMs only.
    pub fn gic_set_icv_reg(&self, reg: ffi::hv_gic_icv_reg_t, value: u64) -> Result<(), CallError> {
        // SAFETY: owning thread; plain values.
        check("hv_gic_set_icv_reg", unsafe {
            ffi::hv_gic_set_icv_reg(self.id, reg, value)
        })
    }

    /// PSTATE.SM / PSTATE.ZA. `Ok(None)` before macOS 15.2.
    pub fn sme_state(&self) -> Result<Option<ffi::hv_vcpu_sme_state_t>, CallError> {
        let Some(f) = crate::optional::get().hv_vcpu_get_sme_state else {
            return Ok(None);
        };
        let mut v = ffi::hv_vcpu_sme_state_t::default();
        // SAFETY: resolved function; owning thread; live out-parameter of the C struct layout.
        check("hv_vcpu_get_sme_state", unsafe { f(self.id, &mut v) })?;
        Ok(Some(v))
    }

    /// Read SME vector Z`n` into `buf`, which must be exactly the maximum SVL in bytes; the
    /// framework rejects other lengths and requires streaming mode (`hv_vcpu.h`).
    pub fn sme_z_reg(&self, n: ffi::hv_sme_z_reg_t, buf: &mut [u8]) -> Result<(), CallError> {
        let f = crate::optional::get()
            .hv_vcpu_get_sme_z_reg
            .ok_or(CallError {
                call: "hv_vcpu_get_sme_z_reg",
                error: HvError::Unsupported,
            })?;
        // SAFETY: resolved function; owning thread; the framework writes at most `buf.len()`
        // bytes into the live, writable slice.
        check("hv_vcpu_get_sme_z_reg", unsafe {
            f(self.id, n, buf.as_mut_ptr(), buf.len())
        })
    }
}

// ANCHOR: vcpu_drop
impl Drop for Vcpu<'_> {
    fn drop(&mut self) {
        // SAFETY: `Vcpu` is `!Send`, so this runs on the creating (owning) thread, as
        // `hv_vcpu_destroy` requires; the id is destroyed exactly once.
        let _ = unsafe { ffi::hv_vcpu_destroy(self.id) };
    }
}
// ANCHOR_END: vcpu_drop

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_reason_never_panics() {
        assert_eq!(ExitReason::from_raw(0), ExitReason::Canceled);
        assert_eq!(ExitReason::from_raw(1), ExitReason::Exception);
        assert_eq!(ExitReason::from_raw(2), ExitReason::VtimerActivated);
        assert_eq!(ExitReason::from_raw(3), ExitReason::Unknown);
        for raw in [4, 0x7fff_ffff, u32::MAX] {
            assert_eq!(ExitReason::from_raw(raw), ExitReason::Other(raw));
            assert_eq!(ExitReason::from_raw(raw).name(), "<undefined>");
        }
        assert_eq!(ExitReason::Exception.name(), "EXCEPTION");
    }

    #[test]
    fn exit_copy_keeps_fields() {
        let raw = ffi::hv_vcpu_exit_t {
            reason: ffi::HV_EXIT_REASON_EXCEPTION,
            exception: ffi::hv_vcpu_exit_exception_t {
                syndrome: 0x5a00_0000,
                virtual_address: 1,
                physical_address: 2,
            },
        };
        let e = VcpuExit::from_raw(raw);
        assert_eq!(
            (e.reason, e.esr, e.far, e.ipa),
            (ExitReason::Exception, 0x5a00_0000, 1, 2)
        );
    }

    #[test]
    fn exit_struct_layout() {
        use core::mem::{align_of, offset_of, size_of};
        assert_eq!(size_of::<ffi::hv_vcpu_exit_t>(), 32);
        assert_eq!(align_of::<ffi::hv_vcpu_exit_t>(), 8);
        assert_eq!(offset_of!(ffi::hv_vcpu_exit_t, reason), 0);
        assert_eq!(offset_of!(ffi::hv_vcpu_exit_t, exception), 8);
        let ex = offset_of!(ffi::hv_vcpu_exit_t, exception);
        assert_eq!(ex + offset_of!(ffi::hv_vcpu_exit_exception_t, syndrome), 8);
        assert_eq!(
            ex + offset_of!(ffi::hv_vcpu_exit_exception_t, virtual_address),
            16
        );
        assert_eq!(
            ex + offset_of!(ffi::hv_vcpu_exit_exception_t, physical_address),
            24
        );
    }

    #[test]
    fn vcpus_exit_empty_is_noop() {
        assert_eq!(vcpus_exit(&[]), Ok(()));
    }
}
