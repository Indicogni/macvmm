// Checkpoint 01 contract. It names only items the chapter 01 lesson teaches
// (`hvf::HvError`, `hvf::ffi::hv_return_t` and the `HV_*` constants); the harness runs it
// against your `crates/hvf`.
//! `hv_return_t` decoding.
//!
//! The expected values are the header's, not the reference's: `hv_kern_types.h` (macOS 27.2
//! SDK) builds every code as `err_local | err_sub(0xba5) | n` = `0xfae94000 | n`. A learner whose
//! constants disagree with the SDK fails here before any VM is created. (The full ABI oracle,
//! `scripts/check-ffi.sh`, compares every declaration with what clang says about the headers.)
#![allow(clippy::unwrap_used, clippy::expect_used)]

use hvf::HvError;
use hvf::ffi;

/// The nine named codes of the 27.2 SDK, as `(raw code, variant, header name)`.
const KNOWN: [(u32, HvError, &str); 9] = [
    (0xfae9_4001, HvError::Error, "HV_ERROR"),
    (0xfae9_4002, HvError::Busy, "HV_BUSY"),
    (0xfae9_4003, HvError::BadArgument, "HV_BAD_ARGUMENT"),
    (
        0xfae9_4004,
        HvError::IllegalGuestState,
        "HV_ILLEGAL_GUEST_STATE",
    ),
    (0xfae9_4005, HvError::NoResources, "HV_NO_RESOURCES"),
    (0xfae9_4006, HvError::NoDevice, "HV_NO_DEVICE"),
    (0xfae9_4007, HvError::Denied, "HV_DENIED"),
    (0xfae9_4008, HvError::Exists, "HV_EXISTS"),
    (0xfae9_400f, HvError::Unsupported, "HV_UNSUPPORTED"),
];

#[test]
fn constants_match_the_header() {
    assert_eq!(ffi::HV_SUCCESS, 0);
    let consts = [
        ffi::HV_ERROR,
        ffi::HV_BUSY,
        ffi::HV_BAD_ARGUMENT,
        ffi::HV_ILLEGAL_GUEST_STATE,
        ffi::HV_NO_RESOURCES,
        ffi::HV_NO_DEVICE,
        ffi::HV_DENIED,
        ffi::HV_EXISTS,
        ffi::HV_UNSUPPORTED,
    ];
    for ((code, _, name), c) in KNOWN.iter().zip(consts) {
        assert_eq!(c as u32, *code, "{name}");
    }
}

#[test]
fn every_known_code_decodes_to_its_name() {
    for (code, want, name) in KNOWN {
        let e = HvError::from_code(code as ffi::hv_return_t);
        assert_eq!(e, want, "{code:#x}");
        assert_eq!(e.name(), name);
        assert_eq!(e.code(), code, "{name} round-trips");
    }
}

#[test]
fn display_has_name_and_exact_code() {
    let e = HvError::from_code(0xfae9_4007_u32 as ffi::hv_return_t);
    assert_eq!(e.to_string(), "HV_DENIED (0xfae94007)");
}

#[test]
fn unknown_codes_are_preserved_verbatim() {
    for code in [0xfae9_4009_u32, 0xfae9_400e, 0x1, 0xffff_ffff, 0x8000_0000] {
        let e = HvError::from_code(code as ffi::hv_return_t);
        assert_eq!(e, HvError::Unknown(code), "{code:#x}");
        assert_eq!(e.code(), code);
    }
}

#[test]
fn decoding_never_panics() {
    // A sweep across the HVF subsystem's code space and the edges of `int`.
    for n in 0u32..0x4000 {
        let _ = HvError::from_code((0xfae9_4000 | n) as ffi::hv_return_t).to_string();
    }
    for code in [i32::MIN, i32::MAX, -1, 1] {
        let _ = HvError::from_code(code).to_string();
    }
}
