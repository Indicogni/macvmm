//! The inline-asm trampoline for `hv_vcpu_set_simd_fp_reg`.
//!
//! **Why a trampoline** (ADR-0002 item 4): the C prototype is
//! `hv_return_t hv_vcpu_set_simd_fp_reg(hv_vcpu_t vcpu, hv_simd_fp_reg_t reg,
//! hv_simd_fp_uchar16_t value)`, and `hv_simd_fp_uchar16_t` is a clang `ext_vector_type(16)`.
//! The AAPCS64 procedure-call standard (Arm IHI 0055, §6.8.2 "Parameter passing rules", rule
//! C.1/C.3 for Short Vector Types) passes such a 16-byte vector *by value in SIMD register
//! `v0`*. Stable Rust refuses SIMD types in `extern "C"` signatures (`simd_ffi` is unstable),
//! and a `u128` or `[u8; 16]` argument would travel in general registers (x2:x3) or by
//! reference: the framework would read garbage and still return `HV_SUCCESS`.
//!
//! So we make the call ourselves: put `vcpu` in `x0`, `reg` in `w1`, the vector in `v0`, branch
//! with link to the function's address, and take the result from `w0`. `clobber_abi("C")` tells
//! the compiler that every caller-saved register (x0–x17, x30, v0–v7, v16–v31 and the upper
//! halves of v8–v15) may be overwritten, exactly as a normal call would. The spike verified this
//! with a Q-register round-trip (RESULTS.md), and `tests/smoke.rs::simd_q5_roundtrip` re-checks
//! it from the guest's side.

use crate::ffi;
use core::arch::aarch64::uint8x16_t;

// ANCHOR: simd_trampoline
/// Call `hv_vcpu_set_simd_fp_reg(vcpu, reg, value)` with `value` in `v0`.
///
/// # Safety
///
/// Same contract as the C function: call it on the thread that owns `vcpu`.
pub(crate) unsafe fn set_simd_fp_reg(
    vcpu: ffi::hv_vcpu_t,
    reg: ffi::hv_simd_fp_reg_t,
    value: [u8; 16],
) -> ffi::hv_return_t {
    // SAFETY: `[u8; 16]` and `uint8x16_t` have the same size and every bit pattern is valid for
    // both; lane i of the vector is byte i, matching the C vector's memory order.
    let v: uint8x16_t = unsafe { core::mem::transmute::<[u8; 16], uint8x16_t>(value) };
    let target = ffi::hv_vcpu_set_simd_fp_reg_addr as *const ();
    let ret: u64;
    // SAFETY: an ordinary AAPCS64 call to a framework function: arguments in x0, w1 and v0,
    // result in w0. `clobber_abi("C")` declares everything the callee may clobber, including
    // x30 (the link register `blr` writes); the stack pointer is untouched and stays 16-byte
    // aligned, as `asm!` guarantees on entry.
    unsafe {
        core::arch::asm!(
            "blr {target}",
            target = in(reg) target,
            inlateout("x0") vcpu => ret,
            in("x1") u64::from(reg),
            in("v0") v,
            clobber_abi("C"),
        );
    }
    // `hv_return_t` is a 32-bit `int` returned in w0: keep the low half, reinterpret the bits.
    ret as u32 as i32
}
// ANCHOR_END: simd_trampoline
