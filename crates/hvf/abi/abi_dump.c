/*
 * abi_dump.c: the clang side of the hvf ABI oracle (ADR-0002 item 3, PLAN M1).
 *
 * Why: crates/hvf/src/ffi.rs is transcribed from the SDK headers by hand. This program is
 * compiled against those same headers by scripts/check-ffi.sh and prints, for every name the
 * Rust side declares, what the *compiler* says: the value of each constant, the size and
 * alignment of each type, the offset of each struct field, and the presence of each function.
 * `cargo run -p hvf --example abi_dump` prints the same lines from Rust; any difference fails
 * the check. Only the *names* are listed here; every value comes from the headers.
 *
 * Output lines (sorted by the script before diffing):
 *   const NAME=0xVALUE        value converted to unsigned long long (negative ints sign-extend,
 *                             exactly as Rust's `i32 as u64` does)
 *   size TYPE=N align=M       sizeof / _Alignof
 *   offset TYPE.FIELD=N       offsetof
 *   fn NAME                   a function Rust links statically
 *   optional NAME since=X.Y   a function Rust resolves with dlsym (crates/hvf/src/optional.rs)
 *
 * Availability (ADR-0002 item 2): the script compiles this file with
 * -mmacosx-version-min=15.0 -Werror=unguarded-availability-new, and only the STATIC_FNS block
 * is outside the pragma that silences availability warnings. So naming a function newer than
 * macOS 15.0 there is a compile error: the baseline rule is checked by the compiler.
 */
#include <Hypervisor/Hypervisor.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <os/object.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define CONSTS(C) \
  C(HV_SUCCESS) \
  C(HV_ERROR) \
  C(HV_BUSY) \
  C(HV_BAD_ARGUMENT) \
  C(HV_ILLEGAL_GUEST_STATE) \
  C(HV_NO_RESOURCES) \
  C(HV_NO_DEVICE) \
  C(HV_DENIED) \
  C(HV_EXISTS) \
  C(HV_UNSUPPORTED) \
  C(HV_MEMORY_READ) \
  C(HV_MEMORY_WRITE) \
  C(HV_MEMORY_EXEC) \
  C(HV_ALLOCATE_DEFAULT) \
  C(HV_EXIT_REASON_CANCELED) \
  C(HV_EXIT_REASON_EXCEPTION) \
  C(HV_EXIT_REASON_VTIMER_ACTIVATED) \
  C(HV_EXIT_REASON_UNKNOWN) \
  C(HV_REG_X0) \
  C(HV_REG_X1) \
  C(HV_REG_X2) \
  C(HV_REG_X3) \
  C(HV_REG_X4) \
  C(HV_REG_X5) \
  C(HV_REG_X6) \
  C(HV_REG_X7) \
  C(HV_REG_X8) \
  C(HV_REG_X9) \
  C(HV_REG_X10) \
  C(HV_REG_X11) \
  C(HV_REG_X12) \
  C(HV_REG_X13) \
  C(HV_REG_X14) \
  C(HV_REG_X15) \
  C(HV_REG_X16) \
  C(HV_REG_X17) \
  C(HV_REG_X18) \
  C(HV_REG_X19) \
  C(HV_REG_X20) \
  C(HV_REG_X21) \
  C(HV_REG_X22) \
  C(HV_REG_X23) \
  C(HV_REG_X24) \
  C(HV_REG_X25) \
  C(HV_REG_X26) \
  C(HV_REG_X27) \
  C(HV_REG_X28) \
  C(HV_REG_X29) \
  C(HV_REG_FP) \
  C(HV_REG_X30) \
  C(HV_REG_LR) \
  C(HV_REG_PC) \
  C(HV_REG_FPCR) \
  C(HV_REG_FPSR) \
  C(HV_REG_CPSR) \
  C(HV_SIMD_FP_REG_Q0) \
  C(HV_SIMD_FP_REG_Q1) \
  C(HV_SIMD_FP_REG_Q2) \
  C(HV_SIMD_FP_REG_Q3) \
  C(HV_SIMD_FP_REG_Q4) \
  C(HV_SIMD_FP_REG_Q5) \
  C(HV_SIMD_FP_REG_Q6) \
  C(HV_SIMD_FP_REG_Q7) \
  C(HV_SIMD_FP_REG_Q8) \
  C(HV_SIMD_FP_REG_Q9) \
  C(HV_SIMD_FP_REG_Q10) \
  C(HV_SIMD_FP_REG_Q11) \
  C(HV_SIMD_FP_REG_Q12) \
  C(HV_SIMD_FP_REG_Q13) \
  C(HV_SIMD_FP_REG_Q14) \
  C(HV_SIMD_FP_REG_Q15) \
  C(HV_SIMD_FP_REG_Q16) \
  C(HV_SIMD_FP_REG_Q17) \
  C(HV_SIMD_FP_REG_Q18) \
  C(HV_SIMD_FP_REG_Q19) \
  C(HV_SIMD_FP_REG_Q20) \
  C(HV_SIMD_FP_REG_Q21) \
  C(HV_SIMD_FP_REG_Q22) \
  C(HV_SIMD_FP_REG_Q23) \
  C(HV_SIMD_FP_REG_Q24) \
  C(HV_SIMD_FP_REG_Q25) \
  C(HV_SIMD_FP_REG_Q26) \
  C(HV_SIMD_FP_REG_Q27) \
  C(HV_SIMD_FP_REG_Q28) \
  C(HV_SIMD_FP_REG_Q29) \
  C(HV_SIMD_FP_REG_Q30) \
  C(HV_SIMD_FP_REG_Q31) \
  C(HV_SME_Z_REG_0) \
  C(HV_SME_Z_REG_31) \
  C(HV_SME_P_REG_0) \
  C(HV_SME_P_REG_15) \
  C(HV_INTERRUPT_TYPE_IRQ) \
  C(HV_INTERRUPT_TYPE_FIQ) \
  C(HV_CACHE_TYPE_DATA) \
  C(HV_CACHE_TYPE_INSTRUCTION) \
  C(HV_TLBI_OP_RVAE1IS) \
  C(HV_TLBI_OP_RVAAE1IS) \
  C(HV_TLBI_OP_RVALE1IS) \
  C(HV_TLBI_OP_RVAALE1IS) \
  C(HV_TLBI_OP_VMALLE1IS) \
  C(HV_TLBI_OP_VAE1IS) \
  C(HV_TLBI_OP_ASIDE1IS) \
  C(HV_TLBI_OP_VAAE1IS) \
  C(HV_TLBI_OP_VALE1IS) \
  C(HV_TLBI_OP_VAALE1IS) \
  C(HV_FEATURE_REG_ID_AA64DFR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64DFR1_EL1) \
  C(HV_FEATURE_REG_ID_AA64ISAR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64ISAR1_EL1) \
  C(HV_FEATURE_REG_ID_AA64MMFR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64MMFR1_EL1) \
  C(HV_FEATURE_REG_ID_AA64MMFR2_EL1) \
  C(HV_FEATURE_REG_ID_AA64PFR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64PFR1_EL1) \
  C(HV_FEATURE_REG_CTR_EL0) \
  C(HV_FEATURE_REG_CLIDR_EL1) \
  C(HV_FEATURE_REG_DCZID_EL0) \
  C(HV_FEATURE_REG_ID_AA64SMFR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64ZFR0_EL1) \
  C(HV_FEATURE_REG_ID_AA64ISAR2_EL1) \
  C(HV_FEATURE_REG_ID_AA64PFR2_EL1) \
  C(HV_FEATURE_REG_ID_AA64MMFR3_EL1) \
  C(HV_FEATURE_REG_ID_AA64MMFR4_EL1) \
  C(HV_IPA_GRANULE_4KB) \
  C(HV_IPA_GRANULE_16KB) \
  C(HV_GIC_INT_PERFORMANCE_MONITOR) \
  C(HV_GIC_INT_MAINTENANCE) \
  C(HV_GIC_INT_EL2_PHYSICAL_TIMER) \
  C(HV_GIC_INT_EL1_VIRTUAL_TIMER) \
  C(HV_GIC_INT_EL1_PHYSICAL_TIMER) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_CTLR) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_TYPER) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_IGROUPR0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ISENABLER0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ICENABLER0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ISPENDR0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ICPENDR0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ISACTIVER0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ICACTIVER0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_IPRIORITYR0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_IPRIORITYR254) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ICFGR0) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_ICFGR63) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_IROUTER32) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_IROUTER1019) \
  C(HV_GIC_DISTRIBUTOR_REG_GICD_PIDR2) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_TYPER) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_PIDR2) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IGROUPR0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ISENABLER0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ICENABLER0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ISPENDR0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ICPENDR0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ISACTIVER0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ICACTIVER0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR1) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR2) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR3) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR4) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR5) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR6) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_IPRIORITYR7) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ICFGR0) \
  C(HV_GIC_REDISTRIBUTOR_REG_GICR_ICFGR1) \
  C(HV_GIC_ICC_REG_PMR_EL1) \
  C(HV_GIC_ICC_REG_BPR0_EL1) \
  C(HV_GIC_ICC_REG_AP0R0_EL1) \
  C(HV_GIC_ICC_REG_AP1R0_EL1) \
  C(HV_GIC_ICC_REG_RPR_EL1) \
  C(HV_GIC_ICC_REG_BPR1_EL1) \
  C(HV_GIC_ICC_REG_CTLR_EL1) \
  C(HV_GIC_ICC_REG_SRE_EL1) \
  C(HV_GIC_ICC_REG_IGRPEN0_EL1) \
  C(HV_GIC_ICC_REG_IGRPEN1_EL1) \
  C(HV_GIC_ICC_REG_SRE_EL2) \
  C(HV_GIC_ICH_REG_AP0R0_EL2) \
  C(HV_GIC_ICH_REG_AP1R0_EL2) \
  C(HV_GIC_ICH_REG_HCR_EL2) \
  C(HV_GIC_ICH_REG_VTR_EL2) \
  C(HV_GIC_ICH_REG_MISR_EL2) \
  C(HV_GIC_ICH_REG_EISR_EL2) \
  C(HV_GIC_ICH_REG_ELRSR_EL2) \
  C(HV_GIC_ICH_REG_VMCR_EL2) \
  C(HV_GIC_ICH_REG_LR0_EL2) \
  C(HV_GIC_ICH_REG_LR1_EL2) \
  C(HV_GIC_ICH_REG_LR2_EL2) \
  C(HV_GIC_ICH_REG_LR3_EL2) \
  C(HV_GIC_ICH_REG_LR4_EL2) \
  C(HV_GIC_ICH_REG_LR5_EL2) \
  C(HV_GIC_ICH_REG_LR6_EL2) \
  C(HV_GIC_ICH_REG_LR7_EL2) \
  C(HV_GIC_ICH_REG_LR8_EL2) \
  C(HV_GIC_ICH_REG_LR9_EL2) \
  C(HV_GIC_ICH_REG_LR10_EL2) \
  C(HV_GIC_ICH_REG_LR11_EL2) \
  C(HV_GIC_ICH_REG_LR12_EL2) \
  C(HV_GIC_ICH_REG_LR13_EL2) \
  C(HV_GIC_ICH_REG_LR14_EL2) \
  C(HV_GIC_ICH_REG_LR15_EL2) \
  C(HV_GIC_ICV_REG_PMR_EL1) \
  C(HV_GIC_ICV_REG_BPR0_EL1) \
  C(HV_GIC_ICV_REG_AP0R0_EL1) \
  C(HV_GIC_ICV_REG_AP1R0_EL1) \
  C(HV_GIC_ICV_REG_RPR_EL1) \
  C(HV_GIC_ICV_REG_BPR1_EL1) \
  C(HV_GIC_ICV_REG_CTLR_EL1) \
  C(HV_GIC_ICV_REG_SRE_EL1) \
  C(HV_GIC_ICV_REG_IGRPEN0_EL1) \
  C(HV_GIC_ICV_REG_IGRPEN1_EL1) \
  C(HV_GIC_REG_GICM_TYPER) \
  C(HV_GIC_REG_GICM_SET_SPI_NSR) \
  C(_SC_PAGESIZE) \
  C(RTLD_DEFAULT)

#define SYS_REGS(C) \
  C(HV_SYS_REG_DBGBVR0_EL1) \
  C(HV_SYS_REG_DBGBCR0_EL1) \
  C(HV_SYS_REG_DBGWVR0_EL1) \
  C(HV_SYS_REG_DBGWCR0_EL1) \
  C(HV_SYS_REG_DBGBVR1_EL1) \
  C(HV_SYS_REG_DBGBCR1_EL1) \
  C(HV_SYS_REG_DBGWVR1_EL1) \
  C(HV_SYS_REG_DBGWCR1_EL1) \
  C(HV_SYS_REG_MDCCINT_EL1) \
  C(HV_SYS_REG_MDSCR_EL1) \
  C(HV_SYS_REG_DBGBVR2_EL1) \
  C(HV_SYS_REG_DBGBCR2_EL1) \
  C(HV_SYS_REG_DBGWVR2_EL1) \
  C(HV_SYS_REG_DBGWCR2_EL1) \
  C(HV_SYS_REG_DBGBVR3_EL1) \
  C(HV_SYS_REG_DBGBCR3_EL1) \
  C(HV_SYS_REG_DBGWVR3_EL1) \
  C(HV_SYS_REG_DBGWCR3_EL1) \
  C(HV_SYS_REG_DBGBVR4_EL1) \
  C(HV_SYS_REG_DBGBCR4_EL1) \
  C(HV_SYS_REG_DBGWVR4_EL1) \
  C(HV_SYS_REG_DBGWCR4_EL1) \
  C(HV_SYS_REG_DBGBVR5_EL1) \
  C(HV_SYS_REG_DBGBCR5_EL1) \
  C(HV_SYS_REG_DBGWVR5_EL1) \
  C(HV_SYS_REG_DBGWCR5_EL1) \
  C(HV_SYS_REG_DBGBVR6_EL1) \
  C(HV_SYS_REG_DBGBCR6_EL1) \
  C(HV_SYS_REG_DBGWVR6_EL1) \
  C(HV_SYS_REG_DBGWCR6_EL1) \
  C(HV_SYS_REG_DBGBVR7_EL1) \
  C(HV_SYS_REG_DBGBCR7_EL1) \
  C(HV_SYS_REG_DBGWVR7_EL1) \
  C(HV_SYS_REG_DBGWCR7_EL1) \
  C(HV_SYS_REG_DBGBVR8_EL1) \
  C(HV_SYS_REG_DBGBCR8_EL1) \
  C(HV_SYS_REG_DBGWVR8_EL1) \
  C(HV_SYS_REG_DBGWCR8_EL1) \
  C(HV_SYS_REG_DBGBVR9_EL1) \
  C(HV_SYS_REG_DBGBCR9_EL1) \
  C(HV_SYS_REG_DBGWVR9_EL1) \
  C(HV_SYS_REG_DBGWCR9_EL1) \
  C(HV_SYS_REG_DBGBVR10_EL1) \
  C(HV_SYS_REG_DBGBCR10_EL1) \
  C(HV_SYS_REG_DBGWVR10_EL1) \
  C(HV_SYS_REG_DBGWCR10_EL1) \
  C(HV_SYS_REG_DBGBVR11_EL1) \
  C(HV_SYS_REG_DBGBCR11_EL1) \
  C(HV_SYS_REG_DBGWVR11_EL1) \
  C(HV_SYS_REG_DBGWCR11_EL1) \
  C(HV_SYS_REG_DBGBVR12_EL1) \
  C(HV_SYS_REG_DBGBCR12_EL1) \
  C(HV_SYS_REG_DBGWVR12_EL1) \
  C(HV_SYS_REG_DBGWCR12_EL1) \
  C(HV_SYS_REG_DBGBVR13_EL1) \
  C(HV_SYS_REG_DBGBCR13_EL1) \
  C(HV_SYS_REG_DBGWVR13_EL1) \
  C(HV_SYS_REG_DBGWCR13_EL1) \
  C(HV_SYS_REG_DBGBVR14_EL1) \
  C(HV_SYS_REG_DBGBCR14_EL1) \
  C(HV_SYS_REG_DBGWVR14_EL1) \
  C(HV_SYS_REG_DBGWCR14_EL1) \
  C(HV_SYS_REG_DBGBVR15_EL1) \
  C(HV_SYS_REG_DBGBCR15_EL1) \
  C(HV_SYS_REG_DBGWVR15_EL1) \
  C(HV_SYS_REG_DBGWCR15_EL1) \
  C(HV_SYS_REG_MIDR_EL1) \
  C(HV_SYS_REG_MPIDR_EL1) \
  C(HV_SYS_REG_ID_AA64PFR0_EL1) \
  C(HV_SYS_REG_ID_AA64PFR1_EL1) \
  C(HV_SYS_REG_ID_AA64PFR2_EL1) \
  C(HV_SYS_REG_ID_AA64ZFR0_EL1) \
  C(HV_SYS_REG_ID_AA64SMFR0_EL1) \
  C(HV_SYS_REG_ID_AA64DFR0_EL1) \
  C(HV_SYS_REG_ID_AA64DFR1_EL1) \
  C(HV_SYS_REG_ID_AA64ISAR0_EL1) \
  C(HV_SYS_REG_ID_AA64ISAR1_EL1) \
  C(HV_SYS_REG_ID_AA64ISAR2_EL1) \
  C(HV_SYS_REG_ID_AA64MMFR0_EL1) \
  C(HV_SYS_REG_ID_AA64MMFR1_EL1) \
  C(HV_SYS_REG_ID_AA64MMFR2_EL1) \
  C(HV_SYS_REG_ID_AA64MMFR3_EL1) \
  C(HV_SYS_REG_ID_AA64MMFR4_EL1) \
  C(HV_SYS_REG_SCTLR_EL1) \
  C(HV_SYS_REG_ACTLR_EL1) \
  C(HV_SYS_REG_CPACR_EL1) \
  C(HV_SYS_REG_SMPRI_EL1) \
  C(HV_SYS_REG_SMCR_EL1) \
  C(HV_SYS_REG_TTBR0_EL1) \
  C(HV_SYS_REG_TTBR1_EL1) \
  C(HV_SYS_REG_TCR_EL1) \
  C(HV_SYS_REG_APIAKEYLO_EL1) \
  C(HV_SYS_REG_APIAKEYHI_EL1) \
  C(HV_SYS_REG_APIBKEYLO_EL1) \
  C(HV_SYS_REG_APIBKEYHI_EL1) \
  C(HV_SYS_REG_APDAKEYLO_EL1) \
  C(HV_SYS_REG_APDAKEYHI_EL1) \
  C(HV_SYS_REG_APDBKEYLO_EL1) \
  C(HV_SYS_REG_APDBKEYHI_EL1) \
  C(HV_SYS_REG_APGAKEYLO_EL1) \
  C(HV_SYS_REG_APGAKEYHI_EL1) \
  C(HV_SYS_REG_SPSR_EL1) \
  C(HV_SYS_REG_ELR_EL1) \
  C(HV_SYS_REG_SP_EL0) \
  C(HV_SYS_REG_AFSR0_EL1) \
  C(HV_SYS_REG_AFSR1_EL1) \
  C(HV_SYS_REG_ESR_EL1) \
  C(HV_SYS_REG_FAR_EL1) \
  C(HV_SYS_REG_PAR_EL1) \
  C(HV_SYS_REG_MAIR_EL1) \
  C(HV_SYS_REG_AMAIR_EL1) \
  C(HV_SYS_REG_VBAR_EL1) \
  C(HV_SYS_REG_CONTEXTIDR_EL1) \
  C(HV_SYS_REG_TPIDR_EL1) \
  C(HV_SYS_REG_SCXTNUM_EL1) \
  C(HV_SYS_REG_CNTKCTL_EL1) \
  C(HV_SYS_REG_CSSELR_EL1) \
  C(HV_SYS_REG_TPIDR_EL0) \
  C(HV_SYS_REG_TPIDRRO_EL0) \
  C(HV_SYS_REG_TPIDR2_EL0) \
  C(HV_SYS_REG_SCXTNUM_EL0) \
  C(HV_SYS_REG_CNTV_CTL_EL0) \
  C(HV_SYS_REG_CNTV_CVAL_EL0) \
  C(HV_SYS_REG_SP_EL1) \
  C(HV_SYS_REG_CNTP_CTL_EL0) \
  C(HV_SYS_REG_CNTP_CVAL_EL0) \
  C(HV_SYS_REG_CNTP_TVAL_EL0) \
  C(HV_SYS_REG_CNTHCTL_EL2) \
  C(HV_SYS_REG_CNTHP_CTL_EL2) \
  C(HV_SYS_REG_CNTHP_CVAL_EL2) \
  C(HV_SYS_REG_CNTHP_TVAL_EL2) \
  C(HV_SYS_REG_CNTVOFF_EL2) \
  C(HV_SYS_REG_CPTR_EL2) \
  C(HV_SYS_REG_ELR_EL2) \
  C(HV_SYS_REG_ESR_EL2) \
  C(HV_SYS_REG_FAR_EL2) \
  C(HV_SYS_REG_HCR_EL2) \
  C(HV_SYS_REG_HPFAR_EL2) \
  C(HV_SYS_REG_MAIR_EL2) \
  C(HV_SYS_REG_MDCR_EL2) \
  C(HV_SYS_REG_SCTLR_EL2) \
  C(HV_SYS_REG_SPSR_EL2) \
  C(HV_SYS_REG_SP_EL2) \
  C(HV_SYS_REG_TCR_EL2) \
  C(HV_SYS_REG_TPIDR_EL2) \
  C(HV_SYS_REG_TTBR0_EL2) \
  C(HV_SYS_REG_TTBR1_EL2) \
  C(HV_SYS_REG_VBAR_EL2) \
  C(HV_SYS_REG_VMPIDR_EL2) \
  C(HV_SYS_REG_VPIDR_EL2) \
  C(HV_SYS_REG_VTCR_EL2) \
  C(HV_SYS_REG_VTTBR_EL2)

#define STATIC_FNS(F) \
  F(hv_vm_get_max_vcpu_count) \
  F(hv_vm_create) \
  F(hv_vm_destroy) \
  F(hv_vm_map) \
  F(hv_vm_unmap) \
  F(hv_vm_protect) \
  F(hv_vm_allocate) \
  F(hv_vm_deallocate) \
  F(hv_vm_config_create) \
  F(hv_vm_config_get_max_ipa_size) \
  F(hv_vm_config_get_default_ipa_size) \
  F(hv_vm_config_set_ipa_size) \
  F(hv_vm_config_get_ipa_size) \
  F(hv_vm_config_get_el2_supported) \
  F(hv_vm_config_get_el2_enabled) \
  F(hv_vm_config_set_el2_enabled) \
  F(hv_vcpu_config_create) \
  F(hv_vcpu_config_get_feature_reg) \
  F(hv_vcpu_config_get_ccsidr_el1_sys_reg_values) \
  F(hv_vcpu_create) \
  F(hv_vcpu_destroy) \
  F(hv_vcpu_get_reg) \
  F(hv_vcpu_set_reg) \
  F(hv_vcpu_get_simd_fp_reg) \
  F(hv_vcpu_get_sys_reg) \
  F(hv_vcpu_set_sys_reg) \
  F(hv_vcpu_get_pending_interrupt) \
  F(hv_vcpu_set_pending_interrupt) \
  F(hv_vcpu_get_trap_debug_exceptions) \
  F(hv_vcpu_set_trap_debug_exceptions) \
  F(hv_vcpu_get_trap_debug_reg_accesses) \
  F(hv_vcpu_set_trap_debug_reg_accesses) \
  F(hv_vcpu_run) \
  F(hv_vcpus_exit) \
  F(hv_vcpu_get_exec_time) \
  F(hv_vcpu_get_vtimer_mask) \
  F(hv_vcpu_set_vtimer_mask) \
  F(hv_vcpu_get_vtimer_offset) \
  F(hv_vcpu_set_vtimer_offset) \
  F(hv_gic_config_create) \
  F(hv_gic_config_set_distributor_base) \
  F(hv_gic_config_set_redistributor_base) \
  F(hv_gic_config_set_msi_region_base) \
  F(hv_gic_config_set_msi_interrupt_range) \
  F(hv_gic_create) \
  F(hv_gic_set_spi) \
  F(hv_gic_send_msi) \
  F(hv_gic_get_distributor_reg) \
  F(hv_gic_set_distributor_reg) \
  F(hv_gic_get_redistributor_base) \
  F(hv_gic_get_redistributor_reg) \
  F(hv_gic_set_redistributor_reg) \
  F(hv_gic_get_icc_reg) \
  F(hv_gic_set_icc_reg) \
  F(hv_gic_get_ich_reg) \
  F(hv_gic_set_ich_reg) \
  F(hv_gic_get_icv_reg) \
  F(hv_gic_set_icv_reg) \
  F(hv_gic_get_msi_reg) \
  F(hv_gic_set_msi_reg) \
  F(hv_gic_set_state) \
  F(hv_gic_reset) \
  F(hv_gic_get_distributor_size) \
  F(hv_gic_get_distributor_base_alignment) \
  F(hv_gic_get_redistributor_region_size) \
  F(hv_gic_get_redistributor_size) \
  F(hv_gic_get_redistributor_base_alignment) \
  F(hv_gic_get_msi_region_size) \
  F(hv_gic_get_msi_region_base_alignment) \
  F(hv_gic_get_spi_interrupt_range) \
  F(hv_gic_get_intid) \
  F(hv_gic_state_create) \
  F(hv_gic_state_get_size) \
  F(hv_gic_state_get_data) \
  F(os_release) \
  F(sysconf) \
  F(mach_absolute_time) \
  F(mach_timebase_info) \
  F(dlsym) \
  F(sysctlbyname) \
  F(hv_vcpu_set_simd_fp_reg)

/* The post-15.0 functions (name, first macOS release). Must match optional::SYMBOLS. */
#define OPTIONAL_FNS(O) \
  O(hv_sme_config_get_max_svl_bytes, "15.2") \
  O(hv_vcpu_get_sme_state, "15.2") \
  O(hv_vcpu_set_sme_state, "15.2") \
  O(hv_vcpu_get_sme_z_reg, "15.2") \
  O(hv_vcpu_set_sme_z_reg, "15.2") \
  O(hv_vcpu_get_sme_p_reg, "15.2") \
  O(hv_vcpu_set_sme_p_reg, "15.2") \
  O(hv_vcpu_get_sme_za_reg, "15.2") \
  O(hv_vcpu_set_sme_za_reg, "15.2") \
  O(hv_vcpu_get_sme_zt0_reg, "15.2") \
  O(hv_vcpu_set_sme_zt0_reg, "15.2") \
  O(hv_vm_config_get_default_ipa_granule, "26.0") \
  O(hv_vm_config_get_ipa_granule, "26.0") \
  O(hv_vm_config_set_ipa_granule, "26.0") \
  O(hv_vcpu_get_wait_for_interrupt_time, "27.0") \
  O(hv_vcpu_get_serror, "27.0") \
  O(hv_vcpu_set_serror, "27.0") \
  O(hv_vcpu_invalidate_tlb, "27.0")

/* Every typedef and struct ffi.rs declares. */
#define TYPES(T) \
  T(hv_return_t) T(hv_ipa_t) T(hv_memory_flags_t) T(hv_allocate_flags_t) \
  T(hv_vm_config_t) T(hv_vcpu_config_t) T(hv_gic_config_t) T(hv_gic_state_t) \
  T(hv_vcpu_t) T(hv_exit_reason_t) T(hv_exception_syndrome_t) T(hv_exception_address_t) \
  T(hv_reg_t) T(hv_simd_fp_reg_t) T(hv_sys_reg_t) T(hv_sme_z_reg_t) T(hv_sme_p_reg_t) \
  T(hv_interrupt_type_t) T(hv_cache_type_t) T(hv_tlbi_op_t) T(hv_feature_reg_t) \
  T(hv_ipa_granule_t) T(hv_gic_intid_t) T(hv_gic_distributor_reg_t) \
  T(hv_gic_redistributor_reg_t) T(hv_gic_icc_reg_t) T(hv_gic_ich_reg_t) T(hv_gic_icv_reg_t) \
  T(hv_gic_msi_reg_t) \
  T(hv_vcpu_exit_exception_t) T(hv_vcpu_exit_t) T(hv_simd_fp_uchar16_t) \
  T(hv_sme_zt0_uchar64_t) T(hv_vcpu_sme_state_t) T(mach_timebase_info_data_t)

/* Struct fields, as (type, member designator). */
#define FIELDS(X) \
  X(hv_vcpu_exit_t, reason) \
  X(hv_vcpu_exit_t, exception) \
  X(hv_vcpu_exit_t, exception.syndrome) \
  X(hv_vcpu_exit_t, exception.virtual_address) \
  X(hv_vcpu_exit_t, exception.physical_address) \
  X(hv_vcpu_exit_exception_t, syndrome) \
  X(hv_vcpu_exit_exception_t, virtual_address) \
  X(hv_vcpu_exit_exception_t, physical_address) \
  X(hv_vcpu_sme_state_t, streaming_sve_mode_enabled) \
  X(hv_vcpu_sme_state_t, za_storage_enabled) \
  X(mach_timebase_info_data_t, numer) \
  X(mach_timebase_info_data_t, denom)

#define PRINT_FN(f) printf("fn %s\n", #f); (void)sizeof(&f);
/* The (uintptr_t) step is a no-op for integers and lets RTLD_DEFAULT, a pointer, print too. */
#define PRINT_CONST(c) printf("const %s=0x%llx\n", #c, (unsigned long long)(uintptr_t)(c));
#define PRINT_OPT(f, since) printf("optional %s since=%s\n", #f, since); (void)sizeof(&f);
#define PRINT_TYPE(t) printf("size %s=%zu align=%zu\n", #t, sizeof(t), _Alignof(t));
#define PRINT_FIELD(t, m) printf("offset %s.%s=%zu\n", #t, #m, offsetof(t, m));

int main(void) {
  /* Strict section: a function introduced after macOS 15.0 is a compile error here. */
  STATIC_FNS(PRINT_FN)

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
  OPTIONAL_FNS(PRINT_OPT)
  CONSTS(PRINT_CONST)
  SYS_REGS(PRINT_CONST)
  TYPES(PRINT_TYPE)
  FIELDS(PRINT_FIELD)
#pragma clang diagnostic pop
  return 0;
}
