//! Fail-closed teardown (PLAN M2 rev 1.2; threat model MEM-11, flaw F22).
//!
//! ```text
//! cargo test -p hvf --features hvf-tests,fault-injection --test teardown -- --test-threads=1
//! ```
//!
//! **The rule under test.** If `hv_vm_unmap` or `hv_vm_destroy` reports an error, stage 2 may
//! still map the guest's host pages. Freeing them would let the next host allocation that
//! reuses those pages be read and written by the guest, an escape primitive. So the VMM must
//! *leak* them (never call `hv_vm_deallocate`, never reuse them), count the bytes, and stop with
//! `Error::Hv { op: "teardown" }` instead of rebooting.
//!
//! The framework never fails these calls in a normal run, so `hvf::testing::fail_next` replaces
//! the *reported* result of the next unmap or destroy with `HV_ERROR` (the real call still runs,
//! so the process stays clean for the next test). The deallocate counter and the leak counter
//! are `hvf::host::{deallocate_calls, leaked_bytes}`, which `vmm`'s `GuestRam` goes through.
//!
//! `teardown_failure_codes_probe` answers the threat model §13 question "can unmap or destroy
//! fail after a normal run, and with which codes?" from the real framework.
#![cfg(all(feature = "hvf-tests", feature = "fault-injection"))]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use hvf::testing::{self, Op};
use hvf::{HvError, MemFlags, OwnedMapping, Vcpu, VmBuilder, ffi, host};
use std::sync::Arc;
use support::{PAGE, RAM, serial};
use vmm::arch::layout::{Layout, RAM_BASE};
use vmm::error::Error;
use vmm::memory::prelude::*;
use vmm::memory::{GuestRam, TeardownAction, teardown_action};
use vmm::vm::{create_vm, teardown};

const SIZE: u64 = 64 << 20;

/// A mapped 64 MiB `GuestRam` in a fresh VM with a GIC.
fn machine() -> (hvf::Vm, hvf::Gic, Arc<GuestRam>) {
    testing::clear();
    let layout = Layout::virt();
    let ram_end = layout.ram_end(SIZE).unwrap();
    let caps = hvf::Capabilities::probe().unwrap();
    let (vm, gic) = create_vm(layout, ram_end, &caps).unwrap();
    let ram = Arc::new(GuestRam::new(&[(GuestAddress(RAM_BASE), SIZE)], 36).unwrap());
    ram.map(&vm).unwrap();
    ram.write_u64(GuestAddress(RAM_BASE), 0x5ec2e7).unwrap();
    (vm, gic, ram)
}

fn assert_teardown_error(r: Result<(), Error>, call: &str) {
    match r {
        Err(Error::Hv {
            op: "teardown",
            err,
        }) => {
            assert_eq!((err.call, err.error), (call, HvError::Error))
        }
        other => panic!("expected Error::Hv {{ op: \"teardown\" }} from {call}, got {other:?}"),
    }
}

#[test]
fn unmap_failure_leaks_allocation() {
    let _s = serial();
    let (vm, gic, ram) = machine();
    let freed = host::deallocate_calls();
    let leaked = host::leaked_bytes();
    testing::fail_next(Op::Unmap);
    let r = teardown(vm, Some(gic), ram, None);
    testing::clear();
    assert_teardown_error(r, "hv_vm_unmap");
    assert_eq!(
        host::deallocate_calls(),
        freed,
        "hv_vm_deallocate must not be called"
    );
    assert_eq!(
        host::leaked_bytes() - leaked,
        SIZE,
        "the whole region is leaked"
    );
}

#[test]
fn destroy_failure_leaks_allocation() {
    let _s = serial();
    let (vm, gic, ram) = machine();
    let freed = host::deallocate_calls();
    let leaked = host::leaked_bytes();
    testing::fail_next(Op::Destroy);
    let r = teardown(vm, Some(gic), ram, None);
    testing::clear();
    assert_teardown_error(r, "hv_vm_destroy");
    assert_eq!(
        host::deallocate_calls(),
        freed,
        "hv_vm_deallocate must not be called"
    );
    assert_eq!(
        host::leaked_bytes() - leaked,
        SIZE,
        "the whole region is leaked"
    );
}

/// The reboot path (architecture §14.5) builds a fresh machine only after `teardown` returned
/// `Ok`. A failed teardown must surface as `Error::Hv { op: "teardown" }`, a VMM failure (exit
/// 1, architecture §15) that `vmm::run` propagates with `?` instead of rebooting.
#[test]
fn run_refuses_reboot_after_failed_teardown() {
    let _s = serial();
    for op in [Op::Unmap, Op::Destroy] {
        let (vm, gic, ram) = machine();
        testing::fail_next(op);
        let r = teardown(vm, Some(gic), ram, None);
        testing::clear();
        let reboot_allowed = r.is_ok();
        assert!(!reboot_allowed, "{op:?}");
        assert!(
            matches!(r, Err(Error::Hv { op: "teardown", .. })),
            "{op:?}: {r:?}"
        );
    }
}

/// The rule is the pure function: only (true, true) frees.
#[test]
fn teardown_rule_matches_pure_function() {
    assert_eq!(teardown_action(true, true), TeardownAction::Deallocate);
    for (u, d) in [(false, true), (true, false), (false, false)] {
        assert_eq!(teardown_action(u, d), TeardownAction::Leak);
    }
}

/// The `hvf`-level owner follows the same rule: `OwnedMapping` leaks when its unmap fails.
#[test]
fn owned_mapping_unmap_failure_leaks() {
    let _s = serial();
    testing::clear();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let freed = host::deallocate_calls();
    let leaked = host::leaked_bytes();
    let m = OwnedMapping::new(&vm, RAM, PAGE, MemFlags::RW).unwrap();
    testing::fail_next(Op::Unmap);
    drop(m);
    testing::clear();
    assert_eq!(host::deallocate_calls(), freed);
    assert_eq!(host::leaked_bytes() - leaked, PAGE as u64);
    vm.destroy().unwrap();
}

/// Threat model §13: which codes do unmap and destroy return, in a normal run and on misuse?
/// The normal path must succeed; the misuse answers are printed and pinned below.
#[test]
fn teardown_failure_codes_probe() {
    let _s = serial();
    testing::clear();
    // Normal run: create, map, run nothing, unmap exactly what was mapped, destroy.
    for _ in 0..20 {
        let (vm, gic, ram) = machine();
        teardown(vm, Some(gic), ram, None).expect("normal teardown succeeds");
    }
    let (vm, _) = VmBuilder::new().create().unwrap();
    let alloc = host::allocate(2 * PAGE).unwrap();
    // SAFETY: `alloc` is a live 2-page block owned here; it is unmapped (or leaked) before it
    // is freed, and nothing holds a reference into it.
    unsafe { vm.map(alloc.as_ptr(), RAM, 2 * PAGE, MemFlags::RW).unwrap() };
    let partial = vm.unmap(RAM, PAGE).map_err(|e| e.error);
    let misaligned = vm.unmap(RAM + 0x1000, PAGE).map_err(|e| e.error);
    let whole = vm.unmap(RAM, 2 * PAGE).map_err(|e| e.error);
    let again = vm.unmap(RAM, 2 * PAGE).map_err(|e| e.error);
    drop(alloc);
    // Destroy while a vCPU still exists (the safe API makes this impossible; raw FFI here).
    let vcpu = Vcpu::create(&vm).unwrap();
    // SAFETY: a deliberate misuse probe: the VM exists; if the call succeeds the VM is gone
    // and the later `Vcpu` drop and `Vm::destroy` report errors, which is what we record.
    let live_vcpu = unsafe { ffi::hv_vm_destroy() };
    drop(vcpu);
    let after = vm.destroy().map_err(|e| e.error);
    eprintln!(
        "teardown probe: 20 normal teardowns OK; unmap half of a mapping -> {partial:?}; \
         unmap at a 4 KiB-misaligned IPA -> {misaligned:?}; unmap whole -> {whole:?}; \
         unmap again -> {again:?}; hv_vm_destroy with a live vCPU -> {:?}; \
         Vm::destroy afterwards -> {after:?}",
        HvError::from_code(live_vcpu)
    );
    assert_eq!(whole, Ok(()));
    assert_eq!(
        again,
        Ok(()),
        "unmapping an unmapped range succeeds (spike)"
    );
    // Observed on macOS 27.2 (M5 Pro), recorded in docs/research/hvf-api.md §5: an aligned
    // partial unmap succeeds, a misaligned one is refused, and destroying a VM that still has a
    // vCPU is refused with HV_BUSY and leaves the VM intact (so `Vm::destroy` then succeeds).
    assert_eq!(partial, Ok(()));
    assert_eq!(misaligned, Err(HvError::BadArgument));
    assert_eq!(HvError::from_code(live_vcpu), HvError::Busy);
    assert_eq!(after, Ok(()));
}
