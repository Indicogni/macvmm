//! `hvf`: hand-written FFI to Apple's Hypervisor.framework on arm64, plus thin safe wrappers.
//!
//! **Mechanism, not policy** (architecture principle 4): this crate says *what the framework
//! does*; the `vmm` crate decides what to do about it. It does not decode syndromes, advance the
//! PC or choose addresses. It is the only crate (besides `vmm::memory::host`) allowed to contain
//! `unsafe`, and every `unsafe` block carries a `// SAFETY:` comment
//! (`clippy::undocumented_unsafe_blocks = "deny"`, ADR-0002 item 7).
//!
//! **The framework's rules, as types** (ADR-0002 item 5, architecture §7):
//! - One VM per process: [`Vm`] is a singleton; `Drop` destroys it.
//! - The GIC before any vCPU: [`VmBuilder::with_gic`] creates it inside `create`.
//! - A vCPU belongs to its thread: [`Vcpu`] is `!Send + !Sync` and borrows the `Vm`;
//!   [`VcpuHandle`] (`Copy + Send + Sync`) can only kick it with [`vcpus_exit`].
//! - Mapping host memory into the guest creates shared, guest-writable memory: [`Vm::map`] is
//!   `unsafe fn`; [`OwnedMapping`] is the safe, bounds-checked package.
//! - Exit records are framework-owned: read with `read_volatile` into an owned [`VcpuExit`].
//!
//! Layout:
//! - [`ffi`]: raw declarations transcribed from the SDK headers (macOS 15.0 baseline), checked
//!   by `scripts/check-ffi.sh` against clang.
//! - [`optional`]: post-15.0 functions resolved with `dlsym`.
//! - [`error`]: `hv_return_t` → [`HvError`], with call context in [`CallError`].
//! - [`caps`]: the host capability probe used by `macvmm doctor` and VM sizing.
//! - [`vm`], [`vcpu`], [`gic`], [`regs`], [`simd`] (private), [`host`].
//! - `testing` (feature `fault-injection`, test builds only): make the next unmap or destroy
//!   report an error, to exercise the fail-closed teardown rule (threat model MEM-11).
//!
//! **Citations.** "ARM ARM" is the *Arm Architecture Reference Manual for A-profile
//! architecture*, Arm DDI 0487. Arm renumbers its part-D sections in most issues (the AArch64
//! system register chapter has changed number several times), so a bare "D24.2.43" is only
//! meaningful together with an issue letter. This crate therefore cites a system register by
//! the title of its register-description page (for example "ARM ARM, ESR_EL2 register
//! description") and a table by its exact title (for example "ISS encoding for an exception from
//! an HVC or SVC instruction"); both are searchable in every issue. Instruction pages are cited
//! by mnemonic (the "Alphabetical list of A64 base instructions").
#![deny(unsafe_op_in_unsafe_fn, clippy::undocumented_unsafe_blocks)]

// Fault injection (threat model MEM-11) must never reach an optimized, shippable build.
#[cfg(all(feature = "fault-injection", not(debug_assertions)))]
compile_error!("the `fault-injection` feature is for debug test builds only (threat model MEM-11)");

pub mod caps;
pub mod error;
pub mod ffi;
pub mod gic;
pub mod host;
pub mod optional;
pub mod regs;
mod simd;
#[cfg(feature = "fault-injection")]
pub mod testing;
pub mod vcpu;
pub mod vm;

pub use caps::Capabilities;
pub use error::{CallError, HvError};
pub use gic::{Gic, GicConfig, GicHandle, GicInterrupt, GicParams, MsiConfig};
pub use regs::{Reg, SysReg};
pub use vcpu::{ExitReason, Vcpu, VcpuExit, VcpuHandle, vcpus_exit};
pub use vm::{IpaGranule, MemFlags, OutOfBounds, OwnedMapping, Vm, VmBuilder};
