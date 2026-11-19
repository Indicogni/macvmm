//! Fault injection for teardown tests (feature `fault-injection`, test builds only).
//!
//! **Why this exists** (threat model MEM-11, flaw F22): the rule "if `hv_vm_unmap` or
//! `hv_vm_destroy` fails, leak the host allocation instead of freeing it" protects against an
//! escape primitive (stage 2 still mapping freed, recycled host pages), but the framework never
//! fails these calls in a normal run on the dev machine (PLAN M2 records this). A rule that is
//! never exercised rots, so this module lets a test make the *next* unmap or destroy report
//! `HV_ERROR`, and then check that the VMM leaked instead of deallocating.
//!
//! **How it fails.** The real framework call still runs first, and only its *reported* result
//! is replaced. The test process therefore stays clean (the VM really is gone, the next test can
//! create one), and what is under test is exactly the VMM's reaction to the error code, which is
//! all MEM-11 is about.
//!
//! **Never in a product binary.** The feature implies `hvf-tests`, `crates/hvf/src/lib.rs`
//! refuses to compile it without `debug_assertions`, and `cargo xtask audit` (rule
//! `fault-injection-scope`) fails if `crates/macvmm/Cargo.toml` mentions it at all, or if any
//! other manifest names it outside a `dev-dependencies` table (so no feature of `vmm`, of the
//! workspace, or of `hvf` itself, such as `default` or `hvf-tests`, can switch it on). Only a
//! `--features hvf/fault-injection` typed on the command line escapes the audit, and then only
//! in a debug build.

use std::sync::atomic::{AtomicBool, Ordering};

/// Which framework call the next injected failure applies to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// The next [`crate::Vm::unmap`] reports `HV_ERROR`.
    Unmap,
    /// The next [`crate::Vm::destroy`] (or `Vm` drop) reports `HV_ERROR`.
    Destroy,
}

static FAIL_UNMAP: AtomicBool = AtomicBool::new(false);
static FAIL_DESTROY: AtomicBool = AtomicBool::new(false);

fn flag(op: Op) -> &'static AtomicBool {
    match op {
        Op::Unmap => &FAIL_UNMAP,
        Op::Destroy => &FAIL_DESTROY,
    }
}

/// Make the next `op` report `HV_ERROR`. One-shot: the flag clears when it fires.
pub fn fail_next(op: Op) {
    flag(op).store(true, Ordering::SeqCst);
}

/// Cancel a pending injection (tests call it in cleanup so one test cannot leak a pending
/// failure into the next).
pub fn clear() {
    FAIL_UNMAP.store(false, Ordering::SeqCst);
    FAIL_DESTROY.store(false, Ordering::SeqCst);
}

/// True once if a failure was requested for `op` (and clears the request).
pub(crate) fn take(op: Op) -> bool {
    flag(op).swap(false, Ordering::SeqCst)
}
