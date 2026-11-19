//! The crate's one error type (architecture §15).
//!
//! **Why one enum, hand-written** (no `thiserror`, CLAUDE.md "Minimal dependencies"): every
//! failure the VMM reports to its caller is a value of [`Error`], with a `Display` that names the
//! operation and the cause, so `macvmm` can print one line and pick an exit code.
//!
//! **What is not an `Error`.** Guest-induced conditions (a bad MMIO access, a descriptor that
//! points outside RAM) are handled where they happen: a device error state, an injected
//! exception or a `GuestFatal` stop (architecture §15). A guest must never be able to turn its
//! own misbehaviour into an `Error`, because `Error` means "the VMM or the host failed" and ends
//! the process with exit code 1. [`MemoryError`] is the exception that proves the rule: callers
//! on guest paths match on it and react locally; only setup code (loaders) converts it.
//!
//! Variants arrive with the milestones that need them (`Input` and `Loader` in M3, `Bus` in M4,
//! `Fdt` in M7, `Virtio` in M11). The enum is `#[non_exhaustive]` so adding one is additive.

use crate::backend::hostio::InputError;
use crate::bus::BusError;
use crate::fdt::FdtError;
use crate::loader::LoaderError;
use crate::memory::MemoryError;
use crate::memory::region::RegionError;
use core::fmt;

/// `Result` with this crate's [`Error`] as the default error type.
pub type Result<T, E = Error> = core::result::Result<T, E>;

/// Everything that can make the VMM fail (as opposed to the guest).
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// A Hypervisor.framework call failed. `op` says what the VMM was doing (for example
    /// `"create VM"`, `"map guest RAM"`, `"teardown"`), `err` which call failed and how.
    Hv {
        op: &'static str,
        err: hvf::CallError,
    },
    /// The requested machine cannot be built (RAM size out of range, IPA bits beyond the host's
    /// maximum, ...).
    Config(String),
    /// A guest-physical access made by setup code (a loader) was refused.
    Memory(MemoryError),
    /// The guest-memory region table was rejected (threat model MEM-8).
    Region(RegionError),
    /// A host input file was refused or could not be read (`HostIo::open`, PATH-1/2, LDR-1).
    /// A usage error: exit code 2.
    Input(InputError),
    /// A boot input was malformed or does not fit the machine (LDR-2). Exit code 2.
    Loader(LoaderError),
    /// The device table could not be built (an overlap: a VMM bug, exit code 1).
    Bus(BusError),
    /// The device tree could not be generated (M7). Every name and value comes from our own
    /// code (FDT-2), so this is a VMM bug: exit code 1.
    Fdt(FdtError),
    /// The host CSPRNG failed (`getentropy(2)`, M7 FDT-3). Exit code 1.
    Entropy(std::io::Error),
    /// A VMM invariant was broken: always a bug in macvmm, never something a guest can cause.
    Internal(&'static str),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Hv { op, err } => write!(f, "{op}: {err}"),
            Error::Config(msg) => write!(f, "invalid configuration: {msg}"),
            Error::Memory(err) => write!(f, "guest memory: {err}"),
            Error::Region(err) => write!(f, "guest memory layout: {err}"),
            Error::Input(err) => write!(f, "{err}"),
            Error::Loader(err) => write!(f, "cannot load the guest: {err}"),
            Error::Bus(err) => write!(f, "MMIO bus: {err}"),
            Error::Fdt(err) => write!(f, "device tree: {err}"),
            Error::Entropy(err) => write!(f, "host entropy (getentropy): {err}"),
            Error::Internal(what) => write!(f, "internal error (a macvmm bug): {what}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Hv { err, .. } => Some(err),
            Error::Memory(err) => Some(err),
            Error::Region(err) => Some(err),
            Error::Input(err) => Some(err),
            Error::Loader(err) => Some(err),
            Error::Bus(err) => Some(err),
            Error::Fdt(err) => Some(err),
            Error::Entropy(err) => Some(err),
            Error::Config(_) | Error::Internal(_) => None,
        }
    }
}

impl Error {
    /// The process exit code for this error (architecture §13.2): 2 for what the *user* got
    /// wrong (configuration, an input file, a guest image that does not fit), 1 for everything
    /// the VMM or the host got wrong.
    pub fn exit_code(&self) -> i32 {
        match self {
            Error::Config(_) | Error::Input(_) | Error::Loader(_) => 2,
            Error::Hv { .. }
            | Error::Memory(_)
            | Error::Region(_)
            | Error::Bus(_)
            | Error::Fdt(_)
            | Error::Entropy(_)
            | Error::Internal(_) => 1,
        }
    }
}

impl From<InputError> for Error {
    fn from(err: InputError) -> Error {
        Error::Input(err)
    }
}

impl From<FdtError> for Error {
    fn from(err: FdtError) -> Error {
        Error::Fdt(err)
    }
}

impl From<LoaderError> for Error {
    fn from(err: LoaderError) -> Error {
        Error::Loader(err)
    }
}

impl From<MemoryError> for Error {
    fn from(err: MemoryError) -> Error {
        Error::Memory(err)
    }
}

impl From<RegionError> for Error {
    fn from(err: RegionError) -> Error {
        Error::Region(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hvf::{CallError, HvError};

    #[test]
    fn display_names_op_and_cause() {
        let e = Error::Hv {
            op: "teardown",
            err: CallError {
                call: "hv_vm_destroy",
                error: HvError::Error,
            },
        };
        assert_eq!(
            e.to_string(),
            "teardown: hv_vm_destroy: HV_ERROR (0xfae94001)"
        );
        assert!(std::error::Error::source(&e).is_some());
        let m: Error = MemoryError::Unaligned { addr: 3 }.into();
        assert!(m.to_string().contains("0x3"), "{m}");
        assert!(Error::Internal("x").to_string().contains("bug"));
        assert!(Error::Config("y".into()).to_string().contains('y'));
        assert_eq!(Error::Config("y".into()).exit_code(), 2);
        assert_eq!(Error::Internal("x").exit_code(), 1);
        assert_eq!(e.exit_code(), 1);
    }
}
