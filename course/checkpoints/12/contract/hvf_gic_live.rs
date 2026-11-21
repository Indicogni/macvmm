// Checkpoint 12 contract, frozen from the reference test crates/vmm/tests/hvf_gic_live.rs.
// It names only items the chapter 12 lesson teaches; the harness runs it against your crates.
//! On-machine GIC test `hvf_gic_live` (on-machine acceptance).
//!
//! ```text
//! cargo test -p vmm --features hvf-tests --test hvf_gic_live -- --test-threads=1 --nocapture
//! ```
//!
//! 1. The live framework's GIC passes the startup assertions (`vm::check_gic`: GICD 64 KiB,
//!    GICR 128 KiB per vCPU, the SPI range holds every layout INTID, vtimer 27, ptimer 30);
//! 2. the `GicSpi` lines the machine wires are accepted by the live SPI range, and driving
//!    them works; an INTID outside it is refused before any framework call;
//! 3. the `ID_AA64PFR0_EL1` of a live vCPU after `hv_gic_create`, **as the VMM reads it**
//!    through `hv_vcpu_get_sys_reg`, is printed and its GIC field (bits 27:24, ARM ARM
//!    D19.2.64) checked: 1 = "GICv3/v4 system registers implemented". This is the API's view,
//!    not the guest's: no guest instruction runs here. The open question is what the guest's own
//!    `MRS` returns (Linux reads this field before touching `ICC_*`); that half is checked by
//!    the `irq` guest, which prints `irq: pfr0.gic=N` from an `MRS` and whose marker file
//!    requires `irq: pfr0.gic=1` (`crates/macvmm/tests/e2e_irq.rs`).
//!
//! One VM per process (HVF), so the tests share a lock.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use hvf::{Capabilities, SysReg};
use std::sync::{Mutex, MutexGuard};
use vmm::arch::layout::{Layout, PL011_INTID, PL031_INTID, RAM_BASE};
use vmm::config::IrqChip;
use vmm::irq::{GicSpi, IrqLine, SpiError, SpiLimits};
use vmm::vm::{GicFacts, check_gic, create_vm_with};

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

/// A line on the test's stderr (crates/vmm bans the print macros, RUST-5).
fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

const RAM_END: u64 = RAM_BASE + (64 << 20);

/// `ID_AA64PFR0_EL1.GIC`, bits 27:24.
fn gic_field(pfr0: u64) -> u64 {
    (pfr0 >> 24) & 0xf
}

#[test]
fn gic_sizes_intids_and_pfr0() {
    let _g = serial();
    let caps = Capabilities::probe().unwrap();
    let layout = Layout::virt();
    let (vm, gic) = create_vm_with(layout, RAM_END, &caps, IrqChip::InKernelGicV3).unwrap();
    let gic = gic.expect("a GIC");
    let facts = GicFacts::query(&gic).unwrap();
    say(&format!("hvf_gic_live: {facts:?}"));
    assert_eq!(facts.distributor_size, 0x1_0000);
    assert_eq!(facts.redistributor_size, 0x2_0000);
    assert_eq!((facts.vtimer, facts.ptimer), (27, 30));
    check_gic(&gic, layout).unwrap();

    // The lines the machine wires, on the live SPI range.
    let limits = SpiLimits::of(&gic).unwrap();
    say(&format!("hvf_gic_live: spi range {:?}", limits.spi));
    for intid in [PL011_INTID, PL031_INTID] {
        let line = GicSpi::new(intid, &limits, gic.handle()).unwrap();
        line.set_level(true);
        line.set_level(false);
        gic.handle().set_spi(intid, false).unwrap();
    }
    assert!(matches!(
        GicSpi::new(limits.spi.end, &limits, gic.handle()),
        Err(SpiError::NotAnSpi { .. })
    ));
    assert!(matches!(
        GicSpi::new(100, &limits, gic.handle()),
        Err(SpiError::InMsiRange { .. })
    ));

    // A live vCPU's ID_AA64PFR0_EL1 with the GIC, as the API reports it (risk R3, VMM side;
    // the guest side is the `irq` e2e test), read on a thread of its own.
    let pfr0 = std::thread::scope(|s| {
        s.spawn(|| {
            let vcpu = hvf::Vcpu::create(&vm).unwrap();
            vcpu.set_sys_reg(SysReg::MPIDR_EL1, 0x8000_0000).unwrap();
            vcpu.get_sys_reg(SysReg::ID_AA64PFR0_EL1).unwrap()
        })
        .join()
        .unwrap()
    });
    say(&format!(
        "hvf_gic_live: ID_AA64PFR0_EL1 (hv_vcpu_get_sys_reg) = {pfr0:#018x} (GIC field {})",
        gic_field(pfr0)
    ));
    assert_eq!(gic_field(pfr0), 1, "GICv3 system registers advertised");

    // No RAM was mapped, so the VM is destroyed directly (the RAM-owning teardown is
    // `hvf_memory`'s subject).
    let _ = gic;
    vm.destroy().unwrap();
}

/// Without a GIC (`--irqchip none`), the same vCPU register as the API reads it, for comparison
/// (the guest's own view without a GIC is `timer-nogic: pfr0.gic=0`), and
/// `hv_vcpu_set_pending_interrupt` succeeds (risk R19, architecture §9.1).
#[test]
fn nogic_pfr0_and_pending_interrupt() {
    let _g = serial();
    let caps = Capabilities::probe().unwrap();
    let (vm, gic) = create_vm_with(Layout::virt(), RAM_END, &caps, IrqChip::None).unwrap();
    assert!(gic.is_none());
    let (pfr0, set) = std::thread::scope(|s| {
        s.spawn(|| {
            let vcpu = hvf::Vcpu::create(&vm).unwrap();
            let pfr0 = vcpu.get_sys_reg(SysReg::ID_AA64PFR0_EL1).unwrap();
            let set = vcpu.set_pending_interrupt(false, true);
            (pfr0, set)
        })
        .join()
        .unwrap()
    });
    say(&format!(
        "hvf_gic_live: no GIC: ID_AA64PFR0_EL1 = {pfr0:#018x} (GIC field {}); \
         hv_vcpu_set_pending_interrupt(IRQ) = {set:?}",
        gic_field(pfr0)
    ));
    assert!(set.is_ok(), "R19: {set:?}");
    vm.destroy().unwrap();
}
