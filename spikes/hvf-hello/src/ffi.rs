//! Hand-written FFI to Hypervisor.framework (arm64 only).
//!
//! Every declaration here was transcribed from the SDK headers at
//! `$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/`
//! (hv_vm.h, hv_vm_config.h, hv_vcpu.h, hv_vcpu_types.h, hv_gic*.h, hv_sme_config.h)
//! and `usr/include/arm64/hv/hv_kern_types.h` (return codes, memory flags).
//!
//! Type mapping notes:
//! * `OS_ENUM(name, uint32_t, ...)` expands to `typedef uint32_t name_t`, so the enums are
//!   plain integers of the stated width on the ABI.
//! * `hv_vm_config_t`, `hv_vcpu_config_t`, `hv_gic_config_t`, `hv_gic_state_t` are OS objects
//!   (pointers); release them with `os_release`.
//! * `hv_return_t` is `mach_error_t` = `kern_return_t` = `int`.
//! * `hv_simd_fp_uchar16_t` is a clang `ext_vector_type(16) uint8_t`, passed **by value in a
//!   SIMD register** (v0). It must be declared as `uint8x16_t`, not `u128` (which would go in
//!   x-registers and silently pass garbage).
#![allow(non_camel_case_types, dead_code)]

use core::arch::aarch64::uint8x16_t;
use core::ffi::c_void;

pub type hv_return_t = i32;
pub type hv_vcpu_t = u64;
pub type hv_ipa_t = u64;
pub type hv_memory_flags_t = u64;
pub type hv_reg_t = u32;
pub type hv_sys_reg_t = u16;
pub type hv_exit_reason_t = u32;
pub type hv_interrupt_type_t = u32;
pub type hv_ipa_granule_t = u32;
pub type hv_feature_reg_t = u32;
pub type hv_gic_intid_t = u16;
pub type hv_gic_distributor_reg_t = u16;
pub type hv_gic_redistributor_reg_t = u32;
pub type hv_gic_icc_reg_t = u16;
pub type hv_vm_config_t = *mut c_void;
pub type hv_vcpu_config_t = *mut c_void;
pub type hv_gic_config_t = *mut c_void;
pub type hv_gic_state_t = *mut c_void;

// hv_kern_types.h: err_local | err_sub(0xba5) == 0xfae94000
pub const HV_SUCCESS: hv_return_t = 0;
pub const HV_ERROR: hv_return_t = 0xfae9_4001_u32 as i32;
pub const HV_BUSY: hv_return_t = 0xfae9_4002_u32 as i32;
pub const HV_BAD_ARGUMENT: hv_return_t = 0xfae9_4003_u32 as i32;
pub const HV_ILLEGAL_GUEST_STATE: hv_return_t = 0xfae9_4004_u32 as i32;
pub const HV_NO_RESOURCES: hv_return_t = 0xfae9_4005_u32 as i32;
pub const HV_NO_DEVICE: hv_return_t = 0xfae9_4006_u32 as i32;
pub const HV_DENIED: hv_return_t = 0xfae9_4007_u32 as i32;
pub const HV_EXISTS: hv_return_t = 0xfae9_4008_u32 as i32;
pub const HV_UNSUPPORTED: hv_return_t = 0xfae9_400f_u32 as i32;

pub fn ret_name(r: hv_return_t) -> &'static str {
    match r {
        HV_SUCCESS => "HV_SUCCESS",
        HV_ERROR => "HV_ERROR",
        HV_BUSY => "HV_BUSY",
        HV_BAD_ARGUMENT => "HV_BAD_ARGUMENT",
        HV_ILLEGAL_GUEST_STATE => "HV_ILLEGAL_GUEST_STATE",
        HV_NO_RESOURCES => "HV_NO_RESOURCES",
        HV_NO_DEVICE => "HV_NO_DEVICE",
        HV_DENIED => "HV_DENIED",
        HV_EXISTS => "HV_EXISTS",
        HV_UNSUPPORTED => "HV_UNSUPPORTED",
        _ => "HV_<unknown>",
    }
}

pub const HV_MEMORY_READ: hv_memory_flags_t = 1 << 0;
pub const HV_MEMORY_WRITE: hv_memory_flags_t = 1 << 1;
pub const HV_MEMORY_EXEC: hv_memory_flags_t = 1 << 2;

// hv_exit_reason_t
pub const HV_EXIT_REASON_CANCELED: u32 = 0;
pub const HV_EXIT_REASON_EXCEPTION: u32 = 1;
pub const HV_EXIT_REASON_VTIMER_ACTIVATED: u32 = 2;
pub const HV_EXIT_REASON_UNKNOWN: u32 = 3;

// hv_ipa_granule_t (macOS 26+)
pub const HV_IPA_GRANULE_4KB: u32 = 0;
pub const HV_IPA_GRANULE_16KB: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct hv_vcpu_exit_exception_t {
    pub syndrome: u64,
    pub virtual_address: u64,
    pub physical_address: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct hv_vcpu_exit_t {
    pub reason: hv_exit_reason_t,
    pub exception: hv_vcpu_exit_exception_t,
}

// hv_reg_t: X0..X30 = 0..30, PC = 31, FPCR = 32, FPSR = 33, CPSR = 34
pub const HV_REG_X0: hv_reg_t = 0;
pub const HV_REG_PC: hv_reg_t = 31;
pub const HV_REG_FPCR: hv_reg_t = 32;
pub const HV_REG_FPSR: hv_reg_t = 33;
pub const HV_REG_CPSR: hv_reg_t = 34;

// hv_sys_reg_t: op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2 (same layout as the
// MSR/MRS trap ISS fields, so a trapped access maps directly onto this enum).
pub const HV_SYS_REG_MIDR_EL1: hv_sys_reg_t = 0xc000;
pub const HV_SYS_REG_MPIDR_EL1: hv_sys_reg_t = 0xc005;
pub const HV_SYS_REG_ID_AA64PFR0_EL1: hv_sys_reg_t = 0xc020;
pub const HV_SYS_REG_ID_AA64DFR0_EL1: hv_sys_reg_t = 0xc028;
pub const HV_SYS_REG_ID_AA64MMFR0_EL1: hv_sys_reg_t = 0xc038;
pub const HV_SYS_REG_SCTLR_EL1: hv_sys_reg_t = 0xc080;
pub const HV_SYS_REG_VBAR_EL1: hv_sys_reg_t = 0xc600;
pub const HV_SYS_REG_ELR_EL1: hv_sys_reg_t = 0xc201;
pub const HV_SYS_REG_SPSR_EL1: hv_sys_reg_t = 0xc200;
pub const HV_SYS_REG_SP_EL1: hv_sys_reg_t = 0xe208;
pub const HV_SYS_REG_CNTV_CTL_EL0: hv_sys_reg_t = 0xdf19;
pub const HV_SYS_REG_CNTV_CVAL_EL0: hv_sys_reg_t = 0xdf1a;
pub const HV_SYS_REG_CNTP_CTL_EL0: hv_sys_reg_t = 0xdf11;
pub const HV_SYS_REG_HCR_EL2: hv_sys_reg_t = 0xe088;

// hv_interrupt_type_t
pub const HV_INTERRUPT_TYPE_IRQ: hv_interrupt_type_t = 0;
pub const HV_INTERRUPT_TYPE_FIQ: hv_interrupt_type_t = 1;

// hv_gic_intid_t
pub const HV_GIC_INT_PERFORMANCE_MONITOR: hv_gic_intid_t = 23;
pub const HV_GIC_INT_MAINTENANCE: hv_gic_intid_t = 25;
pub const HV_GIC_INT_EL2_PHYSICAL_TIMER: hv_gic_intid_t = 26;
pub const HV_GIC_INT_EL1_VIRTUAL_TIMER: hv_gic_intid_t = 27;
pub const HV_GIC_INT_EL1_PHYSICAL_TIMER: hv_gic_intid_t = 30;

// hv_gic_distributor_reg_t values == GICv3 register offsets
pub const GICD_CTLR: u16 = 0x0000;
pub const GICD_TYPER: u16 = 0x0004;
pub const GICD_PIDR2: u16 = 0xffe8;
// hv_gic_redistributor_reg_t values == offsets from the vCPU's RD_base (SGI frame = +0x10000)
pub const GICR_TYPER: u32 = 0x0008;
pub const GICR_PIDR2: u32 = 0xffe8;
pub const GICR_IGROUPR0: u32 = 0x10080;
pub const GICR_ISENABLER0: u32 = 0x10100;
pub const GICR_ISPENDR0: u32 = 0x10200;
pub const GICR_ISACTIVER0: u32 = 0x10300;
// hv_gic_icc_reg_t
pub const HV_GIC_ICC_REG_PMR_EL1: u16 = 0xc230;
pub const HV_GIC_ICC_REG_CTLR_EL1: u16 = 0xc664;
pub const HV_GIC_ICC_REG_SRE_EL1: u16 = 0xc665;
pub const HV_GIC_ICC_REG_IGRPEN1_EL1: u16 = 0xc667;

#[link(name = "Hypervisor", kind = "framework")]
unsafe extern "C" {
    // hv_vm.h
    pub fn hv_vm_get_max_vcpu_count(max_vcpu_count: *mut u32) -> hv_return_t;
    pub fn hv_vm_create(config: hv_vm_config_t) -> hv_return_t;
    pub fn hv_vm_destroy() -> hv_return_t;
    pub fn hv_vm_map(
        addr: *mut c_void,
        ipa: hv_ipa_t,
        size: usize,
        flags: hv_memory_flags_t,
    ) -> hv_return_t;
    pub fn hv_vm_unmap(ipa: hv_ipa_t, size: usize) -> hv_return_t;
    pub fn hv_vm_protect(ipa: hv_ipa_t, size: usize, flags: hv_memory_flags_t) -> hv_return_t;
    // hv_vm_allocate.h
    pub fn hv_vm_allocate(uvap: *mut *mut c_void, size: usize, flags: u64) -> hv_return_t;
    pub fn hv_vm_deallocate(uva: *mut c_void, size: usize) -> hv_return_t;
    // hv_vm_config.h
    pub fn hv_vm_config_create() -> hv_vm_config_t;
    pub fn hv_vm_config_get_max_ipa_size(ipa_bit_length: *mut u32) -> hv_return_t;
    pub fn hv_vm_config_get_default_ipa_size(ipa_bit_length: *mut u32) -> hv_return_t;
    pub fn hv_vm_config_set_ipa_size(config: hv_vm_config_t, ipa_bit_length: u32) -> hv_return_t;
    pub fn hv_vm_config_get_ipa_size(
        config: hv_vm_config_t,
        ipa_bit_length: *mut u32,
    ) -> hv_return_t;
    pub fn hv_vm_config_get_el2_supported(el2_supported: *mut bool) -> hv_return_t;
    pub fn hv_vm_config_get_el2_enabled(
        config: hv_vm_config_t,
        el2_enabled: *mut bool,
    ) -> hv_return_t;
    pub fn hv_vm_config_set_el2_enabled(config: hv_vm_config_t, el2_enabled: bool) -> hv_return_t;
    pub fn hv_vm_config_get_default_ipa_granule(granule: *mut hv_ipa_granule_t) -> hv_return_t;
    pub fn hv_vm_config_get_ipa_granule(
        config: hv_vm_config_t,
        granule: *mut hv_ipa_granule_t,
    ) -> hv_return_t;
    pub fn hv_vm_config_set_ipa_granule(
        config: hv_vm_config_t,
        granule: hv_ipa_granule_t,
    ) -> hv_return_t;
    // hv_sme_config.h
    pub fn hv_sme_config_get_max_svl_bytes(value: *mut usize) -> hv_return_t;
    // hv_vcpu_config.h
    pub fn hv_vcpu_config_create() -> hv_vcpu_config_t;
    pub fn hv_vcpu_config_get_feature_reg(
        config: hv_vcpu_config_t,
        reg: hv_feature_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    // hv_vcpu.h
    pub fn hv_vcpu_create(
        vcpu: *mut hv_vcpu_t,
        exit: *mut *mut hv_vcpu_exit_t,
        config: hv_vcpu_config_t,
    ) -> hv_return_t;
    pub fn hv_vcpu_destroy(vcpu: hv_vcpu_t) -> hv_return_t;
    pub fn hv_vcpu_get_reg(vcpu: hv_vcpu_t, reg: hv_reg_t, value: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_reg(vcpu: hv_vcpu_t, reg: hv_reg_t, value: u64) -> hv_return_t;
    pub fn hv_vcpu_get_simd_fp_reg(vcpu: hv_vcpu_t, reg: u32, value: *mut [u8; 16]) -> hv_return_t;
    // NOTE: hv_vcpu_set_simd_fp_reg takes its value BY VALUE in v0. Stable Rust rejects SIMD
    // types in extern "C" signatures (`simd_ffi` is unstable), so we declare it with a dummy
    // signature and call it through `set_simd_fp_reg` below, which places the value in v0
    // with inline asm.
    #[link_name = "hv_vcpu_set_simd_fp_reg"]
    fn hv_vcpu_set_simd_fp_reg_raw();
    pub fn hv_vcpu_get_sys_reg(vcpu: hv_vcpu_t, reg: hv_sys_reg_t, value: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_sys_reg(vcpu: hv_vcpu_t, reg: hv_sys_reg_t, value: u64) -> hv_return_t;
    pub fn hv_vcpu_get_pending_interrupt(
        vcpu: hv_vcpu_t,
        ty: hv_interrupt_type_t,
        pending: *mut bool,
    ) -> hv_return_t;
    pub fn hv_vcpu_set_pending_interrupt(
        vcpu: hv_vcpu_t,
        ty: hv_interrupt_type_t,
        pending: bool,
    ) -> hv_return_t;
    pub fn hv_vcpu_run(vcpu: hv_vcpu_t) -> hv_return_t;
    pub fn hv_vcpus_exit(vcpus: *mut hv_vcpu_t, vcpu_count: u32) -> hv_return_t;
    pub fn hv_vcpu_get_exec_time(vcpu: hv_vcpu_t, time: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_get_wait_for_interrupt_time(vcpu: hv_vcpu_t, time: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_get_vtimer_mask(vcpu: hv_vcpu_t, masked: *mut bool) -> hv_return_t;
    pub fn hv_vcpu_set_vtimer_mask(vcpu: hv_vcpu_t, masked: bool) -> hv_return_t;
    pub fn hv_vcpu_get_vtimer_offset(vcpu: hv_vcpu_t, offset: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_vtimer_offset(vcpu: hv_vcpu_t, offset: u64) -> hv_return_t;
    // hv_gic_config.h / hv_gic_parameters.h / hv_gic.h / hv_gic_state.h (macOS 15+)
    pub fn hv_gic_config_create() -> hv_gic_config_t;
    pub fn hv_gic_config_set_distributor_base(
        config: hv_gic_config_t,
        base: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_redistributor_base(
        config: hv_gic_config_t,
        base: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_msi_region_base(
        config: hv_gic_config_t,
        base: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_msi_interrupt_range(
        config: hv_gic_config_t,
        base: u32,
        count: u32,
    ) -> hv_return_t;
    pub fn hv_gic_get_distributor_size(size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_distributor_base_alignment(align: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_redistributor_region_size(size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_redistributor_size(size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_redistributor_base_alignment(align: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_msi_region_size(size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_msi_region_base_alignment(align: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_spi_interrupt_range(base: *mut u32, count: *mut u32) -> hv_return_t;
    pub fn hv_gic_get_intid(interrupt: hv_gic_intid_t, intid: *mut u32) -> hv_return_t;
    pub fn hv_gic_create(config: hv_gic_config_t) -> hv_return_t;
    pub fn hv_gic_set_spi(intid: u32, level: bool) -> hv_return_t;
    pub fn hv_gic_get_distributor_reg(
        reg: hv_gic_distributor_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_get_redistributor_base(vcpu: hv_vcpu_t, base: *mut hv_ipa_t) -> hv_return_t;
    pub fn hv_gic_get_redistributor_reg(
        vcpu: hv_vcpu_t,
        reg: hv_gic_redistributor_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_set_redistributor_reg(
        vcpu: hv_vcpu_t,
        reg: hv_gic_redistributor_reg_t,
        value: u64,
    ) -> hv_return_t;
    pub fn hv_gic_get_icc_reg(
        vcpu: hv_vcpu_t,
        reg: hv_gic_icc_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_set_state(data: *const c_void, size: usize) -> hv_return_t;
    pub fn hv_gic_reset() -> hv_return_t;
    pub fn hv_gic_state_create() -> hv_gic_state_t;
    pub fn hv_gic_state_get_size(state: hv_gic_state_t, size: *mut usize) -> hv_return_t;
    pub fn hv_gic_state_get_data(state: hv_gic_state_t, data: *mut c_void) -> hv_return_t;
}

/// Call `hv_vcpu_set_simd_fp_reg(vcpu, reg, value)` with the AAPCS64 calling convention:
/// x0 = vcpu, w1 = reg, v0 = 16-byte vector, result in w0.
pub unsafe fn set_simd_fp_reg(vcpu: hv_vcpu_t, reg: u32, value: uint8x16_t) -> hv_return_t {
    let ret: u64;
    let f = hv_vcpu_set_simd_fp_reg_raw as *const ();
    // SAFETY(spike): standard C call; clobber_abi("C") marks every caller-saved register.
    unsafe {
        core::arch::asm!(
            "blr {f}",
            f = in(reg) f,
            inlateout("x0") vcpu => ret,
            in("x1") reg as u64,
            in("v0") value,
            clobber_abi("C"),
        );
    }
    ret as u32 as i32
}

// libSystem
unsafe extern "C" {
    /// Release an OS object (hv_*_config_t, hv_gic_state_t).
    pub fn os_release(object: *mut c_void);
    pub fn mach_absolute_time() -> u64;
    pub fn pthread_set_qos_class_self_np(qos_class: u32, relative_priority: i32) -> i32;
    pub fn sysconf(name: i32) -> i64;
}
pub const _SC_PAGESIZE: i32 = 29;
