//! The macvmm debug hypercalls, and the raw `hvc #0` they are made of.
//!
//! **Why hypercalls before a UART.** A test guest needs to print and to report a verdict long
//! before the VMM emulates any device (the PL011 arrives in M6). `hvc #0` traps straight to
//! the VMM with EC 0x16 (ARM ARM, ESR_EL2 register description, "HVC instruction execution in
//! AArch64 state"), so a four-register calling convention is all a guest needs.
//!
//! **Calling convention.** SMCCC (Arm DEN 0028, §2 and §3): the function ID in `x0`, arguments
//! in `x1..x3`, results in `x0..x3`. The IDs `0xC600_4D01..4` are SMC64 fast calls in the
//! "vendor-specific hypervisor service" range (OEN 6, DEN 0028 §6.2), so they cannot collide
//! with PSCI or Arm-architecture calls. They are **not** `0xC600_0001..4`: Hypervisor.framework
//! answers W0 in `0xC600_0000..=0xC600_001F` in the kernel without an exit (measured in M3,
//! docs/research/hvf-api.md §15), so a call there never reaches macvmm. The VMM side is
//! `crates/vmm/src/smccc.rs` (architecture §8.6). Registers `x4..x17` are treated as
//! clobbered, as SMCCC v1.0 allows; the VMM only writes `x0..x3`.

use core::arch::asm;

// ANCHOR: guest_debug_ids
/// `DEBUG_PUTC(x1 = byte)`: one byte to the serial sink, through the VMM's `AnsiFilter`.
pub const DEBUG_PUTC: u64 = 0xC600_4D01;
/// `DEBUG_EXIT(x1 = code)`: stop the VM; code 0 → macvmm exits 0, anything else → exit 6.
pub const DEBUG_EXIT: u64 = 0xC600_4D02;
// ANCHOR_END: guest_debug_ids
/// `DEBUG_MEMHASH(x1 = ipa, x2 = len)`: `x0 = 0, x1 = FNV-1a-64`, or `x0 = -2`.
pub const DEBUG_MEMHASH: u64 = 0xC600_4D03;
/// `DEBUG_BOOT_COUNT`: `x0 = 0, x1 = boot generation`.
pub const DEBUG_BOOT_COUNT: u64 = 0xC600_4D04;

/// SMCCC `NOT_SUPPORTED`.
pub const NOT_SUPPORTED: i64 = -1;
/// SMCCC `INVALID_PARAMETER` (used by MEMHASH for a range outside RAM).
pub const INVALID_PARAMETER: i64 = -2;

// ANCHOR: guest_hvc_call
/// Make one SMCCC call through `hvc #0` and return `x0..x3`.
#[inline(always)]
pub fn hvc_call(x0: u64, x1: u64, x2: u64, x3: u64) -> [u64; 4] {
    let (mut r0, mut r1, mut r2, mut r3) = (x0, x1, x2, x3);
    // SAFETY: `hvc #0` traps to the VMM, which reads and writes only x0..x3 (declared inout)
    // and may clobber x4..x17 (declared lateout). It is not `nomem`: DEBUG_MEMHASH reads guest
    // memory and DEBUG_PUTC has an effect, so the compiler must not move stores across it.
    unsafe {
        asm!(
            "hvc #0",
            inout("x0") r0, inout("x1") r1, inout("x2") r2, inout("x3") r3,
            lateout("x4") _, lateout("x5") _, lateout("x6") _, lateout("x7") _,
            lateout("x8") _, lateout("x9") _, lateout("x10") _, lateout("x11") _,
            lateout("x12") _, lateout("x13") _, lateout("x14") _, lateout("x15") _,
            lateout("x16") _, lateout("x17") _,
            options(nostack),
        );
    }
    [r0, r1, r2, r3]
}
// ANCHOR_END: guest_hvc_call

// ANCHOR: guest_debug_putc
/// Print one byte through the VMM (`hvc #0` with `x0 = 0xC600_4D01`, `x1 = byte`).
pub fn debug_putc(byte: u8) {
    hvc_call(DEBUG_PUTC, u64::from(byte), 0, 0);
}
// ANCHOR_END: guest_debug_putc

// ANCHOR: guest_debug_exit
/// Stop the VM with `code` (0 = success). Never returns: if the VMM ignored the call, spin.
pub fn debug_exit(code: u32) -> ! {
    hvc_call(DEBUG_EXIT, u64::from(code), 0, 0);
    crate::psci::halt()
}
// ANCHOR_END: guest_debug_exit

/// FNV-1a-64 of guest RAM `[ipa, ipa + len)` as the VMM sees it, or the negative SMCCC error.
pub fn memhash(ipa: u64, len: u64) -> Result<u64, i64> {
    let r = hvc_call(DEBUG_MEMHASH, ipa, len, 0);
    match r[0] {
        0 => Ok(r[1]),
        err => Err(err as i64),
    }
}

/// How many times this VM has been rebooted in-process (0 on the first boot).
pub fn boot_count() -> u64 {
    hvc_call(DEBUG_BOOT_COUNT, 0, 0, 0)[1]
}
