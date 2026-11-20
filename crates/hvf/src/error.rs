//! `hv_return_t` decoding: turn the framework's integer return codes into named errors.
//!
//! **Why a type and not raw integers:** every HVF call returns `hv_return_t`, and a VMM that
//! prints `-85377017` teaches nothing. `hv_kern_types.h` builds the codes as
//! `err_local | err_sub(0xba5) | n` = `0xfae94000 | n` (mach error-code layout: system field
//! `err_local` = 0x3e in bits 31..26, subsystem 0xba5 in bits 25..14, code in bits 13..0).
//! The nine named values below are the whole set the 27.2 SDK defines.
//!
//! **Unknown codes are preserved verbatim** rather than collapsed into a generic error: a future
//! macOS may add codes, and the exact value is the evidence a bug report needs. Decoding never
//! panics.

use crate::ffi;
use core::fmt;

// ANCHOR: hv_error_enum
/// A non-success `hv_return_t`, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HvError {
    /// `HV_ERROR` (0xfae94001): unspecified failure (for example an overlapping map).
    Error,
    /// `HV_BUSY` (0xfae94002): the resource already exists (second VM, second GIC).
    Busy,
    /// `HV_BAD_ARGUMENT` (0xfae94003): misaligned address, wrong thread, bad register id.
    BadArgument,
    /// `HV_ILLEGAL_GUEST_STATE` (0xfae94004).
    IllegalGuestState,
    /// `HV_NO_RESOURCES` (0xfae94005).
    NoResources,
    /// `HV_NO_DEVICE` (0xfae94006): no hypervisor support on this machine.
    NoDevice,
    /// `HV_DENIED` (0xfae94007): the process lacks `com.apple.security.hypervisor`.
    Denied,
    /// `HV_EXISTS` (0xfae94008).
    Exists,
    /// `HV_UNSUPPORTED` (0xfae9400f): the operation is not available in this configuration.
    Unsupported,
    /// Any other value, kept exactly as returned.
    Unknown(u32),
}
// ANCHOR_END: hv_error_enum

// ANCHOR: hv_error_from_code
impl HvError {
    /// Decode a raw `hv_return_t`. `HV_SUCCESS` is not an error; use [`check`] for call results.
    pub fn from_code(code: ffi::hv_return_t) -> HvError {
        match code {
            ffi::HV_ERROR => HvError::Error,
            ffi::HV_BUSY => HvError::Busy,
            ffi::HV_BAD_ARGUMENT => HvError::BadArgument,
            ffi::HV_ILLEGAL_GUEST_STATE => HvError::IllegalGuestState,
            ffi::HV_NO_RESOURCES => HvError::NoResources,
            ffi::HV_NO_DEVICE => HvError::NoDevice,
            ffi::HV_DENIED => HvError::Denied,
            ffi::HV_EXISTS => HvError::Exists,
            ffi::HV_UNSUPPORTED => HvError::Unsupported,
            // `hv_return_t` is a C `int` holding an unsigned mach code: reinterpret the bits.
            other => HvError::Unknown(other as u32),
        }
    }
}

/// Turn a call's return value into a `Result`, keeping the call's name for the message.
pub fn check(call: &'static str, ret: ffi::hv_return_t) -> Result<(), CallError> {
    if ret == ffi::HV_SUCCESS {
        Ok(())
    } else {
        Err(CallError {
            call,
            error: HvError::from_code(ret),
        })
    }
}
// ANCHOR_END: hv_error_from_code

impl HvError {
    /// The header's name for the code, for example `"HV_DENIED"`.
    pub fn name(self) -> &'static str {
        match self {
            HvError::Error => "HV_ERROR",
            HvError::Busy => "HV_BUSY",
            HvError::BadArgument => "HV_BAD_ARGUMENT",
            HvError::IllegalGuestState => "HV_ILLEGAL_GUEST_STATE",
            HvError::NoResources => "HV_NO_RESOURCES",
            HvError::NoDevice => "HV_NO_DEVICE",
            HvError::Denied => "HV_DENIED",
            HvError::Exists => "HV_EXISTS",
            HvError::Unsupported => "HV_UNSUPPORTED",
            HvError::Unknown(_) => "HV_<unknown>",
        }
    }

    /// The raw code as the header prints it (unsigned).
    pub fn code(self) -> u32 {
        match self {
            HvError::Error => ffi::HV_ERROR as u32,
            HvError::Busy => ffi::HV_BUSY as u32,
            HvError::BadArgument => ffi::HV_BAD_ARGUMENT as u32,
            HvError::IllegalGuestState => ffi::HV_ILLEGAL_GUEST_STATE as u32,
            HvError::NoResources => ffi::HV_NO_RESOURCES as u32,
            HvError::NoDevice => ffi::HV_NO_DEVICE as u32,
            HvError::Denied => ffi::HV_DENIED as u32,
            HvError::Exists => ffi::HV_EXISTS as u32,
            HvError::Unsupported => ffi::HV_UNSUPPORTED as u32,
            HvError::Unknown(code) => code,
        }
    }
}

// ANCHOR: hv_error_display
impl fmt::Display for HvError {
    /// `HV_DENIED (0xfae94007)`: name and exact code, so logs are greppable either way.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({:#010x})", self.name(), self.code())
    }
}
// ANCHOR_END: hv_error_display

impl std::error::Error for HvError {}

// ANCHOR: call_error
/// A failed framework call: which function, and what it returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CallError {
    /// The C function name, for example `"hv_vm_create"`.
    pub call: &'static str,
    /// The decoded return code.
    pub error: HvError,
}

impl fmt::Display for CallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.call, self.error)
    }
}
// ANCHOR_END: call_error

impl std::error::Error for CallError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_codes_map_to_names() {
        let table: [(u32, HvError, &str); 9] = [
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
        for (raw, want, name) in table {
            let got = HvError::from_code(raw as i32);
            assert_eq!(got, want, "{raw:#x}");
            assert_eq!(got.name(), name);
            assert_eq!(got.code(), raw);
            assert_eq!(got.to_string(), format!("{name} ({raw:#010x})"));
        }
        assert_eq!(HvError::Denied.to_string(), "HV_DENIED (0xfae94007)");
    }

    #[test]
    fn unknown_code_is_preserved() {
        for raw in [0xfae9_4009_u32, 0xfae9_4000, 0x1234_5678, 0xffff_ffff, 1] {
            let got = HvError::from_code(raw as i32);
            assert_eq!(got, HvError::Unknown(raw));
            assert_eq!(got.code(), raw);
            assert_eq!(got.name(), "HV_<unknown>");
            assert!(got.to_string().contains(&format!("{raw:#010x}")));
        }
    }

    #[test]
    fn check_maps_success_and_failure() {
        assert_eq!(check("hv_vm_create", 0), Ok(()));
        let err = check("hv_vm_create", 0xfae9_4007_u32 as i32).unwrap_err();
        assert_eq!(err.error, HvError::Denied);
        assert_eq!(err.to_string(), "hv_vm_create: HV_DENIED (0xfae94007)");
    }
}
