//! Raw declarations for Hypervisor.framework (arm64), transcribed from the SDK headers.
//!
//! **Why hand-written** (ADR-0002): the FFI boundary is itself a lesson (course ch01–ch02), and
//! the spike found traps a generic wrapper can get silently wrong (`hv_sys_reg_t` is `u16`,
//! `hv_gic_redistributor_reg_t` is `u32`, `hv_vcpu_t` is `u64`, the by-value SIMD argument).
//! Every item below was read from
//! `$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/`
//! (`hv_vm.h`, `hv_vm_config.h`, `hv_vm_types.h`, `hv_vm_allocate.h`, `hv_vcpu.h`,
//! `hv_vcpu_types.h`, `hv_vcpu_config.h`, `hv_gic.h`, `hv_gic_config.h`, `hv_gic_parameters.h`,
//! `hv_gic_state.h`, `hv_gic_types.h`) and `usr/include/arm64/hv/hv_kern_types.h` (return codes).
//! Never edit these from memory: `scripts/check-ffi.sh` compiles `crates/hvf/abi/abi_dump.c`
//! against the real headers and diffs every constant and layout with
//! `cargo run -p hvf --example abi_dump`.
//!
//! **Baseline: macOS 15.0** (ADR-0002 item 2, decision D7), the first release with `hv_gic_*`.
//! Everything in the `#[link]` block below is `API_AVAILABLE(macos(<= 15.0))`, so linking it
//! statically cannot fail at load time on a supported host; `check-ffi.sh` enforces that by
//! compiling the function list with `-mmacosx-version-min=15.0 -Werror=unguarded-availability-new`.
//! Newer functions (macOS 15.2 SME, 26.0 IPA granule, 27.0 SError/WFI time/TLBI) are resolved at
//! run time in [`crate::optional`]; only their *types* and *constants* live here (constants and
//! types cannot fail to load).
//!
//! Type mapping notes (the header's `OS_ENUM(name, T, ...)` expands to `typedef T name_t`):
//! - `hv_return_t` is `mach_error_t` = `kern_return_t` = `int` (`i32`).
//! - Config and state objects (`hv_vm_config_t`, `hv_vcpu_config_t`, `hv_gic_config_t`,
//!   `hv_gic_state_t`) are OS objects (`OS_OBJECT_DECL`): opaque pointers returned retained,
//!   released with `os_release`.
//! - The enum typedefs keep their declared width: `hv_reg_t` `u32`, `hv_sys_reg_t` **`u16`**,
//!   `hv_gic_redistributor_reg_t` **`u32`** while the other GIC register enums are `u16`.
//! - `hv_simd_fp_uchar16_t` is a clang `ext_vector_type(16)` of `uint8_t` (size 16, align 16).
//!   Passed *by value* it travels in SIMD register `v0`, which stable Rust cannot declare in an
//!   `extern "C"` signature; [`crate::simd`] calls it through an inline-asm trampoline.
//!
//! The raw names mirror the headers exactly (hence the lint allowances), so a learner can grep
//! the SDK for any identifier in this file.
#![allow(non_camel_case_types, non_upper_case_globals)]

use core::ffi::{c_char, c_int, c_long, c_void};

// ---------------------------------------------------------------------------------------------
// Basic types (`hv_kern_types.h`, `hv_vm_types.h`, `hv_vm_allocate.h`)

/// `hv_return_t` (`hv_kern_types.h`): `0` is success, errors are `0xfae94000 | n`.
pub type hv_return_t = i32;
/// `hv_ipa_t` (`hv_vm_types.h`): an intermediate physical (guest physical) address.
pub type hv_ipa_t = u64;
/// `hv_memory_flags_t` (`hv_kern_types.h`): `HV_MEMORY_*` bits for map and protect.
pub type hv_memory_flags_t = u64;
/// `hv_allocate_flags_t` (`hv_vm_allocate.h`).
pub type hv_allocate_flags_t = u64;
/// `hv_vm_config_t` (`hv_vm_types.h`): opaque OS object, release with [`os_release`].
pub type hv_vm_config_t = *mut c_void;
/// `hv_vcpu_config_t` (`hv_vcpu_types.h`): opaque OS object, release with [`os_release`].
pub type hv_vcpu_config_t = *mut c_void;
/// `hv_gic_config_t` (`hv_gic_types.h`): opaque OS object, release with [`os_release`].
pub type hv_gic_config_t = *mut c_void;
/// `hv_gic_state_t` (`hv_gic_types.h`): opaque OS object, release with [`os_release`].
pub type hv_gic_state_t = *mut c_void;

// ANCHOR: ffi_return_codes
// Return codes, `hv_kern_types.h`: `err_local | err_sub(0xba5)` == 0xfae94000. The header writes
// the values as `unsigned` hex; the ABI type is `int`, hence the reinterpreting casts.
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
// ANCHOR_END: ffi_return_codes

// Memory permissions (`hv_kern_types.h`).
pub const HV_MEMORY_READ: hv_memory_flags_t = 1 << 0;
pub const HV_MEMORY_WRITE: hv_memory_flags_t = 1 << 1;
pub const HV_MEMORY_EXEC: hv_memory_flags_t = 1 << 2;

// `hv_vm_allocate.h`.
pub const HV_ALLOCATE_DEFAULT: hv_allocate_flags_t = 0;

// ---------------------------------------------------------------------------------------------
// vCPU types (`hv_vcpu_types.h`)

/// `hv_vcpu_t`: a small integer on arm64 (`uint64_t`; on x86 it is `unsigned`).
pub type hv_vcpu_t = u64;
/// `hv_exit_reason_t` (`OS_ENUM(..., uint32_t, ...)`).
pub type hv_exit_reason_t = u32;
/// `hv_exception_syndrome_t`: the guest's ESR_EL2 value for the exit.
pub type hv_exception_syndrome_t = u64;
/// `hv_exception_address_t`: the guest's FAR_EL2 value for the exit.
pub type hv_exception_address_t = u64;

pub const HV_EXIT_REASON_CANCELED: hv_exit_reason_t = 0;
pub const HV_EXIT_REASON_EXCEPTION: hv_exit_reason_t = 1;
pub const HV_EXIT_REASON_VTIMER_ACTIVATED: hv_exit_reason_t = 2;
pub const HV_EXIT_REASON_UNKNOWN: hv_exit_reason_t = 3;

// ANCHOR: ffi_vcpu_exit_t
/// `hv_vcpu_exit_exception_t`: what the guest did, as the hardware reported it to EL2.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct hv_vcpu_exit_exception_t {
    /// ESR_EL2 (ARM ARM, ESR_EL2 register description): EC in bits 31:26, IL in 25, ISS in
    /// 24:0.
    pub syndrome: hv_exception_syndrome_t,
    /// FAR_EL2: the faulting guest *virtual* address, when the EC defines one.
    pub virtual_address: hv_exception_address_t,
    /// The faulting IPA, page offset included (spike finding 7).
    pub physical_address: hv_ipa_t,
}

/// `hv_vcpu_exit_t`: written by the framework on every `hv_vcpu_run`. 32 bytes; `reason` at 0,
/// 4 bytes of padding, then the exception at 8 (syndrome 8, FAR 16, IPA 24).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct hv_vcpu_exit_t {
    pub reason: hv_exit_reason_t,
    pub exception: hv_vcpu_exit_exception_t,
}
// ANCHOR_END: ffi_vcpu_exit_t

/// `hv_simd_fp_uchar16_t`: `uint8_t __attribute__((ext_vector_type(16)))`, size 16, align 16.
/// Only ever passed *by pointer* from Rust; the by-value setter goes through [`crate::simd`].
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct hv_simd_fp_uchar16_t(pub [u8; 16]);

/// `hv_sme_zt0_uchar64_t` (macOS 15.2): `uint8_t ext_vector_type(64)`, size 64, align 16.
#[repr(C, align(16))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct hv_sme_zt0_uchar64_t(pub [u8; 64]);

/// `hv_vcpu_sme_state_t` (macOS 15.2): PSTATE.SM and PSTATE.ZA.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct hv_vcpu_sme_state_t {
    pub streaming_sve_mode_enabled: bool,
    pub za_storage_enabled: bool,
}

/// `hv_reg_t`: general-purpose and special registers for `hv_vcpu_{get,set}_reg`.
pub type hv_reg_t = u32;
pub const HV_REG_X0: hv_reg_t = 0;
pub const HV_REG_X1: hv_reg_t = 1;
pub const HV_REG_X2: hv_reg_t = 2;
pub const HV_REG_X3: hv_reg_t = 3;
pub const HV_REG_X4: hv_reg_t = 4;
pub const HV_REG_X5: hv_reg_t = 5;
pub const HV_REG_X6: hv_reg_t = 6;
pub const HV_REG_X7: hv_reg_t = 7;
pub const HV_REG_X8: hv_reg_t = 8;
pub const HV_REG_X9: hv_reg_t = 9;
pub const HV_REG_X10: hv_reg_t = 10;
pub const HV_REG_X11: hv_reg_t = 11;
pub const HV_REG_X12: hv_reg_t = 12;
pub const HV_REG_X13: hv_reg_t = 13;
pub const HV_REG_X14: hv_reg_t = 14;
pub const HV_REG_X15: hv_reg_t = 15;
pub const HV_REG_X16: hv_reg_t = 16;
pub const HV_REG_X17: hv_reg_t = 17;
pub const HV_REG_X18: hv_reg_t = 18;
pub const HV_REG_X19: hv_reg_t = 19;
pub const HV_REG_X20: hv_reg_t = 20;
pub const HV_REG_X21: hv_reg_t = 21;
pub const HV_REG_X22: hv_reg_t = 22;
pub const HV_REG_X23: hv_reg_t = 23;
pub const HV_REG_X24: hv_reg_t = 24;
pub const HV_REG_X25: hv_reg_t = 25;
pub const HV_REG_X26: hv_reg_t = 26;
pub const HV_REG_X27: hv_reg_t = 27;
pub const HV_REG_X28: hv_reg_t = 28;
pub const HV_REG_X29: hv_reg_t = 29;
pub const HV_REG_FP: hv_reg_t = HV_REG_X29;
pub const HV_REG_X30: hv_reg_t = 30;
pub const HV_REG_LR: hv_reg_t = HV_REG_X30;
pub const HV_REG_PC: hv_reg_t = 31;
pub const HV_REG_FPCR: hv_reg_t = 32;
pub const HV_REG_FPSR: hv_reg_t = 33;
pub const HV_REG_CPSR: hv_reg_t = 34;

/// `hv_simd_fp_reg_t`: Q0..Q31.
pub type hv_simd_fp_reg_t = u32;
pub const HV_SIMD_FP_REG_Q0: hv_simd_fp_reg_t = 0;
pub const HV_SIMD_FP_REG_Q1: hv_simd_fp_reg_t = 1;
pub const HV_SIMD_FP_REG_Q2: hv_simd_fp_reg_t = 2;
pub const HV_SIMD_FP_REG_Q3: hv_simd_fp_reg_t = 3;
pub const HV_SIMD_FP_REG_Q4: hv_simd_fp_reg_t = 4;
pub const HV_SIMD_FP_REG_Q5: hv_simd_fp_reg_t = 5;
pub const HV_SIMD_FP_REG_Q6: hv_simd_fp_reg_t = 6;
pub const HV_SIMD_FP_REG_Q7: hv_simd_fp_reg_t = 7;
pub const HV_SIMD_FP_REG_Q8: hv_simd_fp_reg_t = 8;
pub const HV_SIMD_FP_REG_Q9: hv_simd_fp_reg_t = 9;
pub const HV_SIMD_FP_REG_Q10: hv_simd_fp_reg_t = 10;
pub const HV_SIMD_FP_REG_Q11: hv_simd_fp_reg_t = 11;
pub const HV_SIMD_FP_REG_Q12: hv_simd_fp_reg_t = 12;
pub const HV_SIMD_FP_REG_Q13: hv_simd_fp_reg_t = 13;
pub const HV_SIMD_FP_REG_Q14: hv_simd_fp_reg_t = 14;
pub const HV_SIMD_FP_REG_Q15: hv_simd_fp_reg_t = 15;
pub const HV_SIMD_FP_REG_Q16: hv_simd_fp_reg_t = 16;
pub const HV_SIMD_FP_REG_Q17: hv_simd_fp_reg_t = 17;
pub const HV_SIMD_FP_REG_Q18: hv_simd_fp_reg_t = 18;
pub const HV_SIMD_FP_REG_Q19: hv_simd_fp_reg_t = 19;
pub const HV_SIMD_FP_REG_Q20: hv_simd_fp_reg_t = 20;
pub const HV_SIMD_FP_REG_Q21: hv_simd_fp_reg_t = 21;
pub const HV_SIMD_FP_REG_Q22: hv_simd_fp_reg_t = 22;
pub const HV_SIMD_FP_REG_Q23: hv_simd_fp_reg_t = 23;
pub const HV_SIMD_FP_REG_Q24: hv_simd_fp_reg_t = 24;
pub const HV_SIMD_FP_REG_Q25: hv_simd_fp_reg_t = 25;
pub const HV_SIMD_FP_REG_Q26: hv_simd_fp_reg_t = 26;
pub const HV_SIMD_FP_REG_Q27: hv_simd_fp_reg_t = 27;
pub const HV_SIMD_FP_REG_Q28: hv_simd_fp_reg_t = 28;
pub const HV_SIMD_FP_REG_Q29: hv_simd_fp_reg_t = 29;
pub const HV_SIMD_FP_REG_Q30: hv_simd_fp_reg_t = 30;
pub const HV_SIMD_FP_REG_Q31: hv_simd_fp_reg_t = 31;

/// `hv_sys_reg_t`: **16 bits**, encoded `op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2`. The named
/// values live in [`crate::regs::SysReg`], built from their ARM ARM coordinates and checked
/// against the header by `check-ffi.sh`.
pub type hv_sys_reg_t = u16;

/// `hv_sme_z_reg_t` (macOS 15.2): Z0..Z31.
pub type hv_sme_z_reg_t = u32;
pub const HV_SME_Z_REG_0: hv_sme_z_reg_t = 0;
pub const HV_SME_Z_REG_31: hv_sme_z_reg_t = 31;
/// `hv_sme_p_reg_t` (macOS 15.2): P0..P15.
pub type hv_sme_p_reg_t = u32;
pub const HV_SME_P_REG_0: hv_sme_p_reg_t = 0;
pub const HV_SME_P_REG_15: hv_sme_p_reg_t = 15;

/// `hv_interrupt_type_t`: the vCPU's IRQ/FIQ lines (only without an in-kernel GIC).
pub type hv_interrupt_type_t = u32;
pub const HV_INTERRUPT_TYPE_IRQ: hv_interrupt_type_t = 0;
pub const HV_INTERRUPT_TYPE_FIQ: hv_interrupt_type_t = 1;

/// `hv_cache_type_t`, for `hv_vcpu_config_get_ccsidr_el1_sys_reg_values`.
pub type hv_cache_type_t = u32;
pub const HV_CACHE_TYPE_DATA: hv_cache_type_t = 0;
pub const HV_CACHE_TYPE_INSTRUCTION: hv_cache_type_t = 1;

/// `hv_tlbi_op_t` (macOS 27.0): guest TLBI operations for `hv_vcpu_invalidate_tlb`.
pub type hv_tlbi_op_t = u16;
pub const HV_TLBI_OP_RVAE1IS: hv_tlbi_op_t = 0x11;
pub const HV_TLBI_OP_RVAAE1IS: hv_tlbi_op_t = 0x13;
pub const HV_TLBI_OP_RVALE1IS: hv_tlbi_op_t = 0x15;
pub const HV_TLBI_OP_RVAALE1IS: hv_tlbi_op_t = 0x17;
pub const HV_TLBI_OP_VMALLE1IS: hv_tlbi_op_t = 0x18;
pub const HV_TLBI_OP_VAE1IS: hv_tlbi_op_t = 0x19;
pub const HV_TLBI_OP_ASIDE1IS: hv_tlbi_op_t = 0x1a;
pub const HV_TLBI_OP_VAAE1IS: hv_tlbi_op_t = 0x1b;
pub const HV_TLBI_OP_VALE1IS: hv_tlbi_op_t = 0x1d;
pub const HV_TLBI_OP_VAALE1IS: hv_tlbi_op_t = 0x1f;

// ---------------------------------------------------------------------------------------------
// vCPU configuration (`hv_vcpu_config.h`) and VM configuration (`hv_vm_config.h`)

/// `hv_feature_reg_t`: ID registers readable through `hv_vcpu_config_get_feature_reg`.
pub type hv_feature_reg_t = u32;
pub const HV_FEATURE_REG_ID_AA64DFR0_EL1: hv_feature_reg_t = 0;
pub const HV_FEATURE_REG_ID_AA64DFR1_EL1: hv_feature_reg_t = 1;
pub const HV_FEATURE_REG_ID_AA64ISAR0_EL1: hv_feature_reg_t = 2;
pub const HV_FEATURE_REG_ID_AA64ISAR1_EL1: hv_feature_reg_t = 3;
pub const HV_FEATURE_REG_ID_AA64MMFR0_EL1: hv_feature_reg_t = 4;
pub const HV_FEATURE_REG_ID_AA64MMFR1_EL1: hv_feature_reg_t = 5;
pub const HV_FEATURE_REG_ID_AA64MMFR2_EL1: hv_feature_reg_t = 6;
pub const HV_FEATURE_REG_ID_AA64PFR0_EL1: hv_feature_reg_t = 7;
pub const HV_FEATURE_REG_ID_AA64PFR1_EL1: hv_feature_reg_t = 8;
pub const HV_FEATURE_REG_CTR_EL0: hv_feature_reg_t = 9;
pub const HV_FEATURE_REG_CLIDR_EL1: hv_feature_reg_t = 10;
pub const HV_FEATURE_REG_DCZID_EL0: hv_feature_reg_t = 11;
/// macOS 15.2.
pub const HV_FEATURE_REG_ID_AA64SMFR0_EL1: hv_feature_reg_t = 12;
/// macOS 15.2.
pub const HV_FEATURE_REG_ID_AA64ZFR0_EL1: hv_feature_reg_t = 13;
/// macOS 27.0.
pub const HV_FEATURE_REG_ID_AA64ISAR2_EL1: hv_feature_reg_t = 14;
/// macOS 27.0.
pub const HV_FEATURE_REG_ID_AA64PFR2_EL1: hv_feature_reg_t = 15;
/// macOS 27.0.
pub const HV_FEATURE_REG_ID_AA64MMFR3_EL1: hv_feature_reg_t = 16;
/// macOS 27.0.
pub const HV_FEATURE_REG_ID_AA64MMFR4_EL1: hv_feature_reg_t = 17;

/// `hv_ipa_granule_t` (macOS 26.0).
pub type hv_ipa_granule_t = u32;
pub const HV_IPA_GRANULE_4KB: hv_ipa_granule_t = 0;
pub const HV_IPA_GRANULE_16KB: hv_ipa_granule_t = 1;

// ---------------------------------------------------------------------------------------------
// GIC types (`hv_gic_types.h`)

/// `hv_gic_intid_t`: the fixed PPIs the framework wires to its in-kernel redistributors.
pub type hv_gic_intid_t = u16;
pub const HV_GIC_INT_PERFORMANCE_MONITOR: hv_gic_intid_t = 23;
pub const HV_GIC_INT_MAINTENANCE: hv_gic_intid_t = 25;
pub const HV_GIC_INT_EL2_PHYSICAL_TIMER: hv_gic_intid_t = 26;
pub const HV_GIC_INT_EL1_VIRTUAL_TIMER: hv_gic_intid_t = 27;
pub const HV_GIC_INT_EL1_PHYSICAL_TIMER: hv_gic_intid_t = 30;

/// `hv_gic_distributor_reg_t` (`u16`): **each value is the register's offset in the GICD frame**
/// (GIC architecture spec IHI 0069, §12.9). The header enumerates 1534 names (every
/// IPRIORITYR*n*, IROUTER*n*, ...); we declare the base of each family plus the ends, and
/// callers compute `base + 4*n` (or `8*n` for IROUTER), which `check-ffi.sh` spot-checks.
pub type hv_gic_distributor_reg_t = u16;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_CTLR: hv_gic_distributor_reg_t = 0x0000;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_TYPER: hv_gic_distributor_reg_t = 0x0004;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_IGROUPR0: hv_gic_distributor_reg_t = 0x0080;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ISENABLER0: hv_gic_distributor_reg_t = 0x0100;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ICENABLER0: hv_gic_distributor_reg_t = 0x0180;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ISPENDR0: hv_gic_distributor_reg_t = 0x0200;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ICPENDR0: hv_gic_distributor_reg_t = 0x0280;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ISACTIVER0: hv_gic_distributor_reg_t = 0x0300;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ICACTIVER0: hv_gic_distributor_reg_t = 0x0380;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_IPRIORITYR0: hv_gic_distributor_reg_t = 0x0400;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_IPRIORITYR254: hv_gic_distributor_reg_t = 0x07f8;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ICFGR0: hv_gic_distributor_reg_t = 0x0c00;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_ICFGR63: hv_gic_distributor_reg_t = 0x0cfc;
/// IROUTER exists only for SPIs, so the first one is INTID 32.
pub const HV_GIC_DISTRIBUTOR_REG_GICD_IROUTER32: hv_gic_distributor_reg_t = 0x6100;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_IROUTER1019: hv_gic_distributor_reg_t = 0x7fd8;
pub const HV_GIC_DISTRIBUTOR_REG_GICD_PIDR2: hv_gic_distributor_reg_t = 0xffe8;

/// `hv_gic_redistributor_reg_t`: **`u32`**, because the SGI-frame registers sit at
/// RD_base + 0x10000 and do not fit in 16 bits.
pub type hv_gic_redistributor_reg_t = u32;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_TYPER: hv_gic_redistributor_reg_t = 0x0008;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_PIDR2: hv_gic_redistributor_reg_t = 0xffe8;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IGROUPR0: hv_gic_redistributor_reg_t = 0x10080;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ISENABLER0: hv_gic_redistributor_reg_t = 0x10100;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ICENABLER0: hv_gic_redistributor_reg_t = 0x10180;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ISPENDR0: hv_gic_redistributor_reg_t = 0x10200;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ICPENDR0: hv_gic_redistributor_reg_t = 0x10280;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ISACTIVER0: hv_gic_redistributor_reg_t = 0x10300;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ICACTIVER0: hv_gic_redistributor_reg_t = 0x10380;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR0: hv_gic_redistributor_reg_t = 0x10400;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR1: hv_gic_redistributor_reg_t = 0x10404;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR2: hv_gic_redistributor_reg_t = 0x10408;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR3: hv_gic_redistributor_reg_t = 0x1040c;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR4: hv_gic_redistributor_reg_t = 0x10410;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR5: hv_gic_redistributor_reg_t = 0x10414;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR6: hv_gic_redistributor_reg_t = 0x10418;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR7: hv_gic_redistributor_reg_t = 0x1041c;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ICFGR0: hv_gic_redistributor_reg_t = 0x10c00;
pub const HV_GIC_REDISTRIBUTOR_REG_GICR_ICFGR1: hv_gic_redistributor_reg_t = 0x10c04;

/// `hv_gic_icc_reg_t` (`u16`, sysreg encoding): the GIC CPU interface registers of a vCPU.
pub type hv_gic_icc_reg_t = u16;
pub const HV_GIC_ICC_REG_PMR_EL1: hv_gic_icc_reg_t = 0xc230;
pub const HV_GIC_ICC_REG_BPR0_EL1: hv_gic_icc_reg_t = 0xc643;
pub const HV_GIC_ICC_REG_AP0R0_EL1: hv_gic_icc_reg_t = 0xc644;
pub const HV_GIC_ICC_REG_AP1R0_EL1: hv_gic_icc_reg_t = 0xc648;
pub const HV_GIC_ICC_REG_RPR_EL1: hv_gic_icc_reg_t = 0xc65b;
pub const HV_GIC_ICC_REG_BPR1_EL1: hv_gic_icc_reg_t = 0xc663;
pub const HV_GIC_ICC_REG_CTLR_EL1: hv_gic_icc_reg_t = 0xc664;
pub const HV_GIC_ICC_REG_SRE_EL1: hv_gic_icc_reg_t = 0xc665;
pub const HV_GIC_ICC_REG_IGRPEN0_EL1: hv_gic_icc_reg_t = 0xc666;
pub const HV_GIC_ICC_REG_IGRPEN1_EL1: hv_gic_icc_reg_t = 0xc667;
pub const HV_GIC_ICC_REG_SRE_EL2: hv_gic_icc_reg_t = 0xe64d;

/// `hv_gic_ich_reg_t` (`u16`): hypervisor-control registers, only with EL2 enabled.
pub type hv_gic_ich_reg_t = u16;
pub const HV_GIC_ICH_REG_AP0R0_EL2: hv_gic_ich_reg_t = 0xe640;
pub const HV_GIC_ICH_REG_AP1R0_EL2: hv_gic_ich_reg_t = 0xe648;
pub const HV_GIC_ICH_REG_HCR_EL2: hv_gic_ich_reg_t = 0xe658;
pub const HV_GIC_ICH_REG_VTR_EL2: hv_gic_ich_reg_t = 0xe659;
pub const HV_GIC_ICH_REG_MISR_EL2: hv_gic_ich_reg_t = 0xe65a;
pub const HV_GIC_ICH_REG_EISR_EL2: hv_gic_ich_reg_t = 0xe65b;
pub const HV_GIC_ICH_REG_ELRSR_EL2: hv_gic_ich_reg_t = 0xe65d;
pub const HV_GIC_ICH_REG_VMCR_EL2: hv_gic_ich_reg_t = 0xe65f;
pub const HV_GIC_ICH_REG_LR0_EL2: hv_gic_ich_reg_t = 0xe660;
pub const HV_GIC_ICH_REG_LR1_EL2: hv_gic_ich_reg_t = 0xe661;
pub const HV_GIC_ICH_REG_LR2_EL2: hv_gic_ich_reg_t = 0xe662;
pub const HV_GIC_ICH_REG_LR3_EL2: hv_gic_ich_reg_t = 0xe663;
pub const HV_GIC_ICH_REG_LR4_EL2: hv_gic_ich_reg_t = 0xe664;
pub const HV_GIC_ICH_REG_LR5_EL2: hv_gic_ich_reg_t = 0xe665;
pub const HV_GIC_ICH_REG_LR6_EL2: hv_gic_ich_reg_t = 0xe666;
pub const HV_GIC_ICH_REG_LR7_EL2: hv_gic_ich_reg_t = 0xe667;
pub const HV_GIC_ICH_REG_LR8_EL2: hv_gic_ich_reg_t = 0xe668;
pub const HV_GIC_ICH_REG_LR9_EL2: hv_gic_ich_reg_t = 0xe669;
pub const HV_GIC_ICH_REG_LR10_EL2: hv_gic_ich_reg_t = 0xe66a;
pub const HV_GIC_ICH_REG_LR11_EL2: hv_gic_ich_reg_t = 0xe66b;
pub const HV_GIC_ICH_REG_LR12_EL2: hv_gic_ich_reg_t = 0xe66c;
pub const HV_GIC_ICH_REG_LR13_EL2: hv_gic_ich_reg_t = 0xe66d;
pub const HV_GIC_ICH_REG_LR14_EL2: hv_gic_ich_reg_t = 0xe66e;
pub const HV_GIC_ICH_REG_LR15_EL2: hv_gic_ich_reg_t = 0xe66f;

/// `hv_gic_icv_reg_t` (`u16`): the virtual CPU interface, only with EL2 enabled.
pub type hv_gic_icv_reg_t = u16;
pub const HV_GIC_ICV_REG_PMR_EL1: hv_gic_icv_reg_t = 0xc230;
pub const HV_GIC_ICV_REG_BPR0_EL1: hv_gic_icv_reg_t = 0xc643;
pub const HV_GIC_ICV_REG_AP0R0_EL1: hv_gic_icv_reg_t = 0xc644;
pub const HV_GIC_ICV_REG_AP1R0_EL1: hv_gic_icv_reg_t = 0xc648;
pub const HV_GIC_ICV_REG_RPR_EL1: hv_gic_icv_reg_t = 0xc65b;
pub const HV_GIC_ICV_REG_BPR1_EL1: hv_gic_icv_reg_t = 0xc663;
pub const HV_GIC_ICV_REG_CTLR_EL1: hv_gic_icv_reg_t = 0xc664;
pub const HV_GIC_ICV_REG_SRE_EL1: hv_gic_icv_reg_t = 0xc665;
pub const HV_GIC_ICV_REG_IGRPEN0_EL1: hv_gic_icv_reg_t = 0xc666;
pub const HV_GIC_ICV_REG_IGRPEN1_EL1: hv_gic_icv_reg_t = 0xc667;

/// `hv_gic_msi_reg_t` (`u16`): registers of the GICv2m-style MSI frame.
pub type hv_gic_msi_reg_t = u16;
pub const HV_GIC_REG_GICM_TYPER: hv_gic_msi_reg_t = 0x0008;
pub const HV_GIC_REG_GICM_SET_SPI_NSR: hv_gic_msi_reg_t = 0x0040;

// ---------------------------------------------------------------------------------------------
// Functions available on macOS 15.0 (statically linked)

#[link(name = "Hypervisor", kind = "framework")]
unsafe extern "C" {
    // ANCHOR: ffi_vm_create
    // hv_vm.h (macOS 11.0). One VM per process: it has no handle.
    pub fn hv_vm_get_max_vcpu_count(max_vcpu_count: *mut u32) -> hv_return_t;
    /// `config` is `_Nullable`: NULL means the default configuration.
    pub fn hv_vm_create(config: hv_vm_config_t) -> hv_return_t;
    /// "Requires all vCPUs be destroyed" (`hv_vm.h`).
    pub fn hv_vm_destroy() -> hv_return_t;
    /// Map host memory `addr..addr+size` at guest IPA `ipa`. All three must be aligned to the
    /// IPA granule (16 KiB by default, spike finding 1).
    pub fn hv_vm_map(
        addr: *mut c_void,
        ipa: hv_ipa_t,
        size: usize,
        flags: hv_memory_flags_t,
    ) -> hv_return_t;
    pub fn hv_vm_unmap(ipa: hv_ipa_t, size: usize) -> hv_return_t;
    pub fn hv_vm_protect(ipa: hv_ipa_t, size: usize, flags: hv_memory_flags_t) -> hv_return_t;
    // ANCHOR_END: ffi_vm_create

    // hv_vm_allocate.h (macOS 12.1)
    /// Page-aligned anonymous memory "suitable to be mapped as guest memory".
    pub fn hv_vm_allocate(
        uvap: *mut *mut c_void,
        size: usize,
        flags: hv_allocate_flags_t,
    ) -> hv_return_t;
    pub fn hv_vm_deallocate(uva: *mut c_void, size: usize) -> hv_return_t;

    // hv_vm_config.h (macOS 13.0; EL2 15.0)
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

    // hv_vcpu_config.h (macOS 11.0)
    pub fn hv_vcpu_config_create() -> hv_vcpu_config_t;
    pub fn hv_vcpu_config_get_feature_reg(
        config: hv_vcpu_config_t,
        feature_reg: hv_feature_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    /// `values` is `uint64_t values[_Nonnull 8]`.
    pub fn hv_vcpu_config_get_ccsidr_el1_sys_reg_values(
        config: hv_vcpu_config_t,
        cache_type: hv_cache_type_t,
        values: *mut u64,
    ) -> hv_return_t;

    // hv_vcpu.h (macOS 11.0). Unless noted, "must be called by the owning thread".
    /// Creates a vCPU *for the calling thread*. `*exit` receives a framework-owned pointer that
    /// every `hv_vcpu_run` rewrites. `config` is `_Nullable`.
    pub fn hv_vcpu_create(
        vcpu: *mut hv_vcpu_t,
        exit: *mut *mut hv_vcpu_exit_t,
        config: hv_vcpu_config_t,
    ) -> hv_return_t;
    pub fn hv_vcpu_destroy(vcpu: hv_vcpu_t) -> hv_return_t;
    pub fn hv_vcpu_get_reg(vcpu: hv_vcpu_t, reg: hv_reg_t, value: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_reg(vcpu: hv_vcpu_t, reg: hv_reg_t, value: u64) -> hv_return_t;
    pub fn hv_vcpu_get_simd_fp_reg(
        vcpu: hv_vcpu_t,
        reg: hv_simd_fp_reg_t,
        value: *mut hv_simd_fp_uchar16_t,
    ) -> hv_return_t;
    // `hv_vcpu_set_simd_fp_reg(hv_vcpu_t, hv_simd_fp_reg_t, hv_simd_fp_uchar16_t value)` takes
    // the vector by value in v0: not declarable here. See `hv_vcpu_set_simd_fp_reg_addr` below.
    pub fn hv_vcpu_get_sys_reg(vcpu: hv_vcpu_t, reg: hv_sys_reg_t, value: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_sys_reg(vcpu: hv_vcpu_t, reg: hv_sys_reg_t, value: u64) -> hv_return_t;
    pub fn hv_vcpu_get_pending_interrupt(
        vcpu: hv_vcpu_t,
        type_: hv_interrupt_type_t,
        pending: *mut bool,
    ) -> hv_return_t;
    pub fn hv_vcpu_set_pending_interrupt(
        vcpu: hv_vcpu_t,
        type_: hv_interrupt_type_t,
        pending: bool,
    ) -> hv_return_t;
    pub fn hv_vcpu_get_trap_debug_exceptions(vcpu: hv_vcpu_t, value: *mut bool) -> hv_return_t;
    pub fn hv_vcpu_set_trap_debug_exceptions(vcpu: hv_vcpu_t, value: bool) -> hv_return_t;
    pub fn hv_vcpu_get_trap_debug_reg_accesses(vcpu: hv_vcpu_t, value: *mut bool) -> hv_return_t;
    pub fn hv_vcpu_set_trap_debug_reg_accesses(vcpu: hv_vcpu_t, value: bool) -> hv_return_t;
    pub fn hv_vcpu_run(vcpu: hv_vcpu_t) -> hv_return_t;
    /// **Any thread.** Forces the listed vCPUs out of `hv_vcpu_run` with
    /// `HV_EXIT_REASON_CANCELED`; sticky for a vCPU that is not running (spike finding 13).
    pub fn hv_vcpus_exit(vcpus: *mut hv_vcpu_t, vcpu_count: u32) -> hv_return_t;
    pub fn hv_vcpu_get_exec_time(vcpu: hv_vcpu_t, time: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_get_vtimer_mask(vcpu: hv_vcpu_t, vtimer_is_masked: *mut bool) -> hv_return_t;
    pub fn hv_vcpu_set_vtimer_mask(vcpu: hv_vcpu_t, vtimer_is_masked: bool) -> hv_return_t;
    pub fn hv_vcpu_get_vtimer_offset(vcpu: hv_vcpu_t, vtimer_offset: *mut u64) -> hv_return_t;
    pub fn hv_vcpu_set_vtimer_offset(vcpu: hv_vcpu_t, vtimer_offset: u64) -> hv_return_t;

    // hv_gic_config.h (macOS 15.0)
    // ANCHOR: ffi_gic_create
    /// "Create the GIC configuration after the virtual machine has been created."
    pub fn hv_gic_config_create() -> hv_gic_config_t;
    pub fn hv_gic_config_set_distributor_base(
        config: hv_gic_config_t,
        distributor_base_address: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_redistributor_base(
        config: hv_gic_config_t,
        redistributor_base_address: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_msi_region_base(
        config: hv_gic_config_t,
        msi_region_base_address: hv_ipa_t,
    ) -> hv_return_t;
    pub fn hv_gic_config_set_msi_interrupt_range(
        config: hv_gic_config_t,
        msi_intid_base: u32,
        msi_intid_count: u32,
    ) -> hv_return_t;
    /// Must be called after `hv_vm_create` and before any `hv_vcpu_create` (`hv_gic.h`).
    pub fn hv_gic_create(gic_config: hv_gic_config_t) -> hv_return_t;
    // ANCHOR_END: ffi_gic_create

    // hv_gic.h (macOS 15.0): interrupt injection and register access.
    /// Any thread. Asserts (`level = true`) or deasserts an SPI.
    pub fn hv_gic_set_spi(intid: u32, level: bool) -> hv_return_t;
    pub fn hv_gic_send_msi(address: hv_ipa_t, intid: u32) -> hv_return_t;
    pub fn hv_gic_get_distributor_reg(
        reg: hv_gic_distributor_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_set_distributor_reg(reg: hv_gic_distributor_reg_t, value: u64) -> hv_return_t;
    /// Owning thread; `HV_BAD_ARGUMENT` until MPIDR_EL1 has been written (spike finding 17).
    pub fn hv_gic_get_redistributor_base(
        vcpu: hv_vcpu_t,
        redistributor_base_address: *mut hv_ipa_t,
    ) -> hv_return_t;
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
    pub fn hv_gic_set_icc_reg(vcpu: hv_vcpu_t, reg: hv_gic_icc_reg_t, value: u64) -> hv_return_t;
    pub fn hv_gic_get_ich_reg(
        vcpu: hv_vcpu_t,
        reg: hv_gic_ich_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_set_ich_reg(vcpu: hv_vcpu_t, reg: hv_gic_ich_reg_t, value: u64) -> hv_return_t;
    pub fn hv_gic_get_icv_reg(
        vcpu: hv_vcpu_t,
        reg: hv_gic_icv_reg_t,
        value: *mut u64,
    ) -> hv_return_t;
    pub fn hv_gic_set_icv_reg(vcpu: hv_vcpu_t, reg: hv_gic_icv_reg_t, value: u64) -> hv_return_t;
    pub fn hv_gic_get_msi_reg(reg: hv_gic_msi_reg_t, value: *mut u64) -> hv_return_t;
    pub fn hv_gic_set_msi_reg(reg: hv_gic_msi_reg_t, value: u64) -> hv_return_t;
    /// After the GIC and vCPUs exist, before any vCPU runs (`hv_gic.h`).
    pub fn hv_gic_set_state(gic_state_data: *const c_void, gic_state_size: usize) -> hv_return_t;
    pub fn hv_gic_reset() -> hv_return_t;

    // hv_gic_parameters.h (macOS 15.0)
    pub fn hv_gic_get_distributor_size(distributor_size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_distributor_base_alignment(
        distributor_base_alignment: *mut usize,
    ) -> hv_return_t;
    pub fn hv_gic_get_redistributor_region_size(
        redistributor_region_size: *mut usize,
    ) -> hv_return_t;
    pub fn hv_gic_get_redistributor_size(redistributor_size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_redistributor_base_alignment(
        redistributor_base_alignment: *mut usize,
    ) -> hv_return_t;
    pub fn hv_gic_get_msi_region_size(msi_region_size: *mut usize) -> hv_return_t;
    pub fn hv_gic_get_msi_region_base_alignment(
        msi_region_base_alignment: *mut usize,
    ) -> hv_return_t;
    pub fn hv_gic_get_spi_interrupt_range(
        spi_intid_base: *mut u32,
        spi_intid_count: *mut u32,
    ) -> hv_return_t;
    pub fn hv_gic_get_intid(interrupt: hv_gic_intid_t, intid: *mut u32) -> hv_return_t;

    // hv_gic_state.h (macOS 15.0). The VM must be stopped while the state object is created.
    pub fn hv_gic_state_create() -> hv_gic_state_t;
    pub fn hv_gic_state_get_size(state: hv_gic_state_t, gic_state_size: *mut usize) -> hv_return_t;
    pub fn hv_gic_state_get_data(state: hv_gic_state_t, gic_state_data: *mut c_void)
    -> hv_return_t;
}

#[link(name = "Hypervisor", kind = "framework")]
unsafe extern "C" {
    /// The *address* of `hv_vcpu_set_simd_fp_reg`, declared with a dummy signature so Rust never
    /// calls it directly: its third argument is a 16-byte vector passed in `v0`, which an
    /// `extern "C"` declaration on stable Rust cannot express (ADR-0002 item 4). Only
    /// [`crate::simd`] uses it, as a branch target for its inline-asm trampoline.
    #[link_name = "hv_vcpu_set_simd_fp_reg"]
    pub(crate) fn hv_vcpu_set_simd_fp_reg_addr();
}

// ---------------------------------------------------------------------------------------------
// libSystem (always linked)

/// `mach_timebase_info_data_t` (`mach/mach_time.h`): ticks × numer / denom = nanoseconds.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct mach_timebase_info_data_t {
    pub numer: u32,
    pub denom: u32,
}

unsafe extern "C" {
    /// `<os/object.h>`: the C entry point behind the `os_release` macro when Objective-C is not
    /// in use (our situation). Releases `hv_vm_config_t` and the other OS objects.
    pub fn os_release(object: *mut c_void);
    /// `unistd.h`.
    pub fn sysconf(name: c_int) -> c_long;
    /// `mach/mach_time.h`: the host tick counter that the guest's CNTVCT_EL0 follows
    /// (`CNTVCT = mach_absolute_time() - vtimer_offset`, `hv_vcpu.h`).
    pub fn mach_absolute_time() -> u64;
    /// `mach/mach_time.h`. Returns a `kern_return_t`.
    pub fn mach_timebase_info(info: *mut mach_timebase_info_data_t) -> c_int;
    /// `dlfcn.h`: used by [`crate::optional`] to find post-15.0 symbols at run time.
    pub fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    /// `sys/sysctl.h`: read `kern.osproductversion` for the host macOS release.
    pub fn sysctlbyname(
        name: *const c_char,
        oldp: *mut c_void,
        oldlenp: *mut usize,
        newp: *mut c_void,
        newlen: usize,
    ) -> c_int;
}

/// `_SC_PAGESIZE` from `usr/include/unistd.h` (Darwin value).
pub const _SC_PAGESIZE: c_int = 29;
/// `RTLD_DEFAULT` from `dlfcn.h`: `((void *) -2)`, "search every image loaded so far". Kept as
/// an integer so it can be a `const`; [`crate::optional`] turns it into the pointer.
pub const RTLD_DEFAULT: isize = -2;
