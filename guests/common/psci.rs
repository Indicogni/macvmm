//! PSCI and SMCCC calls from a test guest (Arm DEN 0022, PSCI 1.1; Arm DEN 0028, SMCCC 1.1).
//!
//! **Why PSCI, not a debug call, for the normal end.** `SYSTEM_OFF` (function ID `0x8400_0008`,
//! DEN 0022 §5.1.9) is what a real OS uses to power off, so a guest that ends through it
//! exercises the same VMM path as Linux's `poweroff`. The conduit is `hvc #0`, matching the
//! DT's `method = "hvc"` (architecture §8.6).
//!
//! **Every call in the VMM's table** (architecture §8.6) has a wrapper here, so `psci-probe`
//! (PLAN M5) and later SMP guests (M16) use the same IDs as `crates/vmm/src/smccc.rs`. Return
//! values are the signed PSCI codes (DEN 0022 §5.2.2): 0 success, -1 not supported, -2
//! invalid parameters, -4 already on, -5 on pending, -9 invalid address.

use crate::hvc::hvc_call;

/// SMCCC_VERSION (DEN 0028 §7.2).
pub const SMCCC_VERSION: u64 = 0x8000_0000;
/// SMCCC_ARCH_FEATURES (DEN 0028 §7.3).
pub const SMCCC_ARCH_FEATURES: u64 = 0x8000_0001;
/// PSCI_VERSION (DEN 0022 §5.1.1).
pub const VERSION: u64 = 0x8400_0000;
/// CPU_SUSPEND, SMC64 (DEN 0022 §5.1.2).
pub const CPU_SUSPEND: u64 = 0xC400_0001;
/// CPU_OFF (DEN 0022 §5.1.3).
pub const CPU_OFF: u64 = 0x8400_0002;
/// CPU_ON, SMC64 (DEN 0022 §5.1.4).
pub const CPU_ON: u64 = 0xC400_0003;
/// AFFINITY_INFO, SMC64 (DEN 0022 §5.1.5).
pub const AFFINITY_INFO: u64 = 0xC400_0004;
/// MIGRATE_INFO_TYPE (DEN 0022 §5.1.7).
pub const MIGRATE_INFO_TYPE: u64 = 0x8400_0006;
/// PSCI `SYSTEM_OFF` (SMC32 fast call, DEN 0022 §5.1.9).
pub const SYSTEM_OFF: u64 = 0x8400_0008;
/// PSCI `SYSTEM_RESET` (SMC32 fast call, DEN 0022 §5.1.10).
pub const SYSTEM_RESET: u64 = 0x8400_0009;
/// PSCI_FEATURES (DEN 0022 §5.1.14).
pub const FEATURES: u64 = 0x8400_000A;

/// `x0` of a call as the signed return code.
fn code(x0: u64) -> i64 {
    x0 as i64
}

/// PSCI_VERSION: `major << 16 | minor` (macvmm: `0x10001`, PSCI 1.1).
pub fn version() -> u64 {
    hvc_call(VERSION, 0, 0, 0)[0]
}

/// SMCCC_VERSION: `major << 16 | minor` (macvmm: `0x10001`, SMCCC 1.1).
pub fn smccc_version() -> u64 {
    hvc_call(SMCCC_VERSION, 0, 0, 0)[0]
}

/// SMCCC_ARCH_FEATURES(`fid`): 0 if implemented, otherwise negative.
pub fn smccc_arch_features(fid: u64) -> i64 {
    code(hvc_call(SMCCC_ARCH_FEATURES, fid, 0, 0)[0])
}

/// PSCI_FEATURES(`fid`): 0 (or feature flags) if implemented, -1 otherwise.
pub fn features(fid: u64) -> i64 {
    code(hvc_call(FEATURES, fid, 0, 0)[0])
}

/// CPU_SUSPEND(`power_state`, `entry`, `ctx`). macvmm treats every state as standby.
pub fn cpu_suspend(power_state: u64, entry: u64, ctx: u64) -> i64 {
    code(hvc_call(CPU_SUSPEND, power_state, entry, ctx)[0])
}

/// CPU_OFF: never returns on success; returns the error otherwise.
pub fn cpu_off() -> i64 {
    code(hvc_call(CPU_OFF, 0, 0, 0)[0])
}

/// CPU_ON(`target` MPIDR affinity, `entry`, `ctx`).
pub fn cpu_on(target: u64, entry: u64, ctx: u64) -> i64 {
    code(hvc_call(CPU_ON, target, entry, ctx)[0])
}

/// AFFINITY_INFO(`target`, `level`): 0 ON, 1 OFF, 2 ON_PENDING, or a negative error.
pub fn affinity_info(target: u64, level: u64) -> i64 {
    code(hvc_call(AFFINITY_INFO, target, level, 0)[0])
}

/// MIGRATE_INFO_TYPE: 2 = no Trusted OS to migrate.
pub fn migrate_info_type() -> i64 {
    code(hvc_call(MIGRATE_INFO_TYPE, 0, 0, 0)[0])
}

/// Make any SMCCC call through `hvc #0` and return `x0` as a signed code.
pub fn call(fid: u64, x1: u64, x2: u64, x3: u64) -> i64 {
    code(hvc_call(fid, x1, x2, x3)[0])
}

/// Power the machine off. macvmm exits 0.
pub fn power_off() -> ! {
    hvc_call(SYSTEM_OFF, 0, 0, 0);
    halt()
}

/// Ask for a reset. With `--on-reset exit` macvmm exits 4; with `reboot` (the default) the
/// machine is rebuilt and this guest starts again with `boot_count() + 1`.
pub fn reset() -> ! {
    hvc_call(SYSTEM_RESET, 0, 0, 0);
    halt()
}

/// Wait forever. Reached only if the VMM returned from a call that must not return.
pub fn halt() -> ! {
    loop {
        // SAFETY: `wfi` only waits for an interrupt; it touches no memory or registers.
        unsafe { core::arch::asm!("wfi", options(nomem, nostack)) };
    }
}
