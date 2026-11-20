// Checkpoint 02 contract (PLAN M27 L1). It names only items the chapter 02 lesson teaches: your
// declarations of `hv_vcpu_exit_t`, `hv_vcpu_exit_exception_t` and the exit-reason constants in
// `hvf::ffi`. The harness runs it against your `crates/hvf`.
//! The `hv_vcpu_exit_t` layout (PLAN M1; CURRICULUM ch02 checkpoint, moved from 01 in v3.1).
//!
//! The framework writes this struct on every `hv_vcpu_run`; if the Rust declaration disagrees
//! with `hv_vcpu_types.h` by one field, every exit is misread. The expected numbers are what
//! clang reports for the 27.2 SDK headers (`scripts/check-ffi.sh`, the ABI oracle): 32 bytes,
//! align 8, `reason` at 0, `exception` at 8, and inside it `syndrome` 0, `virtual_address` 8,
//! `physical_address` 16.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use core::mem::{align_of, offset_of, size_of};
use hvf::ffi::{self, hv_vcpu_exit_exception_t, hv_vcpu_exit_t};

#[test]
fn exit_struct_is_32_bytes_align_8() {
    assert_eq!(size_of::<hv_vcpu_exit_t>(), 32);
    assert_eq!(align_of::<hv_vcpu_exit_t>(), 8);
    assert_eq!(size_of::<hv_vcpu_exit_exception_t>(), 24);
}

#[test]
fn field_offsets_match_the_header() {
    assert_eq!(offset_of!(hv_vcpu_exit_t, reason), 0);
    assert_eq!(offset_of!(hv_vcpu_exit_t, exception), 8);
    // As seen from the start of `hv_vcpu_exit_t`: 8, 16, 24.
    let base = offset_of!(hv_vcpu_exit_t, exception);
    assert_eq!(base + offset_of!(hv_vcpu_exit_exception_t, syndrome), 8);
    assert_eq!(
        base + offset_of!(hv_vcpu_exit_exception_t, virtual_address),
        16
    );
    assert_eq!(
        base + offset_of!(hv_vcpu_exit_exception_t, physical_address),
        24
    );
}

#[test]
fn field_widths() {
    let e = hv_vcpu_exit_t::default();
    assert_eq!(size_of_val(&e.reason), 4, "hv_exit_reason_t is uint32_t");
    assert_eq!(size_of_val(&e.exception.syndrome), 8);
    assert_eq!(size_of_val(&e.exception.virtual_address), 8);
    assert_eq!(size_of_val(&e.exception.physical_address), 8);
}

#[test]
fn exit_reasons_match_the_header() {
    assert_eq!(ffi::HV_EXIT_REASON_CANCELED, 0);
    assert_eq!(ffi::HV_EXIT_REASON_EXCEPTION, 1);
    assert_eq!(ffi::HV_EXIT_REASON_VTIMER_ACTIVATED, 2);
    assert_eq!(ffi::HV_EXIT_REASON_UNKNOWN, 3);
}
