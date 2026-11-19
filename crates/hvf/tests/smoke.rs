//! On-machine acceptance tests for the `hvf` crate (PLAN M1). Each one re-checks, through the
//! safe wrappers, a behaviour the spike observed with raw FFI (`spikes/hvf-hello/RESULTS.md`),
//! so a macOS update that changes the framework's rules fails here first.
//!
//! Run: `cargo test -p hvf --features hvf-tests -- --test-threads=1`.
#![cfg(feature = "hvf-tests")]
// Test code may panic on failure (architecture §4: tests are exempt from the unwrap/expect ban;
// clippy's `allow-*-in-tests` does not reach helpers outside `#[test]` functions).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use hvf::{
    ExitReason, GicConfig, GicInterrupt, GicParams, HvError, MemFlags, Reg, SysReg, Vcpu,
    VmBuilder, ffi, host, vcpus_exit,
};
use std::time::{Duration, Instant};
use support::enc::{self, Asm};
use support::*;

/// A VM with the in-kernel GIC at the QEMU `virt` addresses.
fn vm_with_gic() -> (hvf::Vm, hvf::Gic) {
    let (vm, gic) = VmBuilder::new()
        .with_gic(GicConfig {
            distributor_base: GICD,
            redistributor_base: GICR,
            msi: None,
        })
        .create()
        .expect("VM with GIC");
    (vm, gic.expect("GIC requested"))
}

#[test]
fn vm_create_twice_is_busy() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().expect("hv_vm_create");
    // Our singleton answers first ...
    let err = VmBuilder::new().create().unwrap_err();
    assert_eq!((err.call, err.error), ("hv_vm_create", HvError::Busy));
    // ... and the framework agrees when asked directly (spike finding 19).
    // SAFETY: a NULL config is allowed; a VM already exists, so the call is refused and creates
    // nothing that would need destroying.
    let raw = unsafe { ffi::hv_vm_create(core::ptr::null_mut()) };
    assert_eq!(HvError::from_code(raw), HvError::Busy);
    vm.destroy().expect("hv_vm_destroy");
}

#[test]
fn vm_recreate_after_destroy() {
    let _s = serial();
    for round in 0..3 {
        let (vm, gic) = VmBuilder::new().create().expect("plain VM");
        assert!(gic.is_none());
        vm.destroy()
            .unwrap_or_else(|e| panic!("round {round}: {e}"));
        let (vm, _gic) = vm_with_gic();
        vm.destroy()
            .unwrap_or_else(|e| panic!("round {round} (GIC): {e}"));
    }
}

#[test]
fn map_requires_16k_alignment() {
    let _s = serial();
    // Declared before the VM so it is freed after the VM (and its mappings) are gone.
    let mem = host::allocate(2 * PAGE).expect("hv_vm_allocate");
    let (vm, _) = VmBuilder::new().create().expect("hv_vm_create");
    // The first two calls are expected to be refused, the third to succeed.
    // SAFETY: `mem` is one live allocation of 2 pages that outlives the VM; no Rust reference
    // to it exists.
    let ipa_4k = unsafe { vm.map(mem.as_ptr(), RAM + 0x1000, PAGE, MemFlags::RW) };
    assert_eq!(
        ipa_4k.unwrap_err().error,
        HvError::BadArgument,
        "4 KiB-aligned IPA"
    );
    // SAFETY: as above.
    let len_4k = unsafe { vm.map(mem.as_ptr(), RAM, 0x1000, MemFlags::RW) };
    assert_eq!(
        len_4k.unwrap_err().error,
        HvError::BadArgument,
        "4 KiB length"
    );
    // SAFETY: as above; this one is aligned and succeeds.
    unsafe { vm.map(mem.as_ptr(), RAM, PAGE, MemFlags::RW) }.expect("16 KiB-aligned map");
    vm.protect(RAM, PAGE, MemFlags::READ).expect("protect");
    vm.unmap(RAM, PAGE).expect("unmap");
    vm.destroy().expect("hv_vm_destroy");
}

#[test]
fn hvc_pc_already_advanced() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.movz(0, 0x2a, 0);
    a.hvc(0);
    a.b(a.here());
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let exit = vcpu.run().expect("run");
    assert_eq!(exit.reason, ExitReason::Exception);
    assert_eq!(exit.esr, 0x5a00_0000, "EC 0x16, IL 1, imm 0");
    assert_eq!(
        vcpu.get_reg(Reg::PC).unwrap(),
        RAM + 8,
        "PC is past the HVC"
    );
    assert_eq!(vcpu.get_reg(Reg::X0).unwrap(), 0x2a);
}

#[test]
fn smc_pc_not_advanced() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.smc(0);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let exit = vcpu.run().expect("run");
    assert_eq!(exit.reason, ExitReason::Exception);
    assert_eq!(ec_iss(exit.esr), (0x17, 0));
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), RAM, "PC still at the SMC");
}

#[test]
fn mmio_exit_reports_full_ipa_and_isv() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.movz(1, (UNMAPPED >> 16) as u32, 1);
    a.movz(2, 0x41, 0);
    let store = a.str_w(2, 1, 0x18);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let exit = vcpu.run().expect("run");
    assert_eq!(exit.reason, ExitReason::Exception);
    let (ec, iss) = ec_iss(exit.esr);
    assert_eq!(ec, 0x24, "data abort from a lower EL");
    assert_eq!((iss >> 24) & 1, 1, "ISV");
    assert_eq!((iss >> 22) & 3, 2, "SAS = word");
    assert_eq!((iss >> 16) & 0x1f, 2, "SRT = w2");
    assert_eq!((iss >> 6) & 1, 1, "WnR = write");
    assert_eq!(exit.ipa, UNMAPPED + 0x18, "full IPA, page offset included");
    assert_eq!(exit.far, UNMAPPED + 0x18, "MMU off: VA == IPA");
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), store, "PC at the store");
    assert_eq!(vcpu.get_reg(Reg::X2).unwrap(), 0x41);
}

#[test]
fn stp_to_mmio_gives_isv0() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.movz(3, (UNMAPPED >> 16) as u32, 1);
    a.stp_x(1, 2, 3);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let exit = vcpu.run().expect("run");
    let (ec, iss) = ec_iss(exit.esr);
    assert_eq!(ec, 0x24);
    assert_eq!((iss >> 24) & 1, 0, "ISV = 0: no register information");
    assert_eq!(exit.ipa, UNMAPPED);
}

#[test]
fn pmcr_read_traps_ec_0x18() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.mrs(4, enc::PMCR_EL0);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let exit = vcpu.run().expect("run");
    let (ec, iss) = ec_iss(exit.esr);
    assert_eq!(ec, 0x18, "trapped MRS");
    let iss = u32::try_from(iss).unwrap();
    assert_eq!(SysReg::from_iss(iss), SysReg::PMCR_EL0);
    assert_eq!(SysReg::from_iss(iss), 0xdce0);
    assert_eq!(iss & 1, 1, "direction = read");
    assert_eq!((iss >> 5) & 0x1f, 4, "Rt = x4");
    assert_eq!(iss, SysReg::PMCR_EL0.to_iss(4, true));
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), RAM, "PC at the MRS");
}

#[test]
fn vcpus_exit_from_other_thread() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.b(RAM); // spin forever
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    let handle = vcpu.handle();
    let start = Instant::now();
    let exit = std::thread::scope(|s| {
        s.spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            vcpus_exit(&[handle]).expect("hv_vcpus_exit from another thread");
        });
        vcpu.run().expect("run")
    });
    let waited = start.elapsed();
    assert_eq!(exit.reason, ExitReason::Canceled);
    assert!(
        waited >= Duration::from_millis(40),
        "returned too early: {waited:?}"
    );
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), RAM, "still in the loop");
}

#[test]
fn sticky_kick_returns_canceled() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.hvc(1);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    // Kick a vCPU that is not running: the kick waits for the next run.
    vcpus_exit(&[vcpu.handle()]).expect("hv_vcpus_exit");
    let start = Instant::now();
    let first = vcpu.run().expect("run");
    assert_eq!(first.reason, ExitReason::Canceled);
    assert!(start.elapsed() < Duration::from_millis(100));
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), RAM, "the guest never ran");
    // The kick is consumed: the next run executes the HVC.
    let second = vcpu.run().expect("run");
    assert_eq!(second.reason, ExitReason::Exception);
    assert_eq!(ec_iss(second.esr), (0x16, 1));
}

#[test]
fn simd_q5_roundtrip() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let mut a = Asm::new(RAM);
    a.umov_d(0, 5, 0);
    a.umov_d(1, 5, 1);
    a.hvc(0);
    let _mem = load(&vm, &a);
    let mut vcpu = vcpu_at(&vm, RAM);
    // CPACR_EL1.FPEN = 0b11 (bits 21:20): EL1 may use FP/SIMD without trapping.
    vcpu.set_sys_reg(SysReg::CPACR_EL1, 3 << 20)
        .expect("CPACR_EL1");
    let value = u128::from_le_bytes(core::array::from_fn(|i| 0xa0 + i as u8));
    vcpu.set_simd(5, value).expect("set Q5");
    assert_eq!(vcpu.get_simd(5).expect("get Q5"), value, "host round-trip");
    assert_eq!(vcpu.get_simd(4).expect("get Q4"), 0, "neighbour untouched");
    // The guest sees the same 128 bits, so the value really travelled in v0 (not x2:x3).
    let exit = vcpu.run().expect("run");
    assert_eq!(ec_iss(exit.esr), (0x16, 0));
    assert_eq!(vcpu.get_reg(Reg::X0).unwrap(), value as u64, "low half");
    assert_eq!(
        vcpu.get_reg(Reg::X1).unwrap(),
        (value >> 64) as u64,
        "high half"
    );
    assert!(vcpu.set_simd(32, 0).is_err(), "Q32 does not exist");
}

#[test]
fn gic_sizes_match_m5() {
    let _s = serial();
    let (vm, gic) = vm_with_gic();
    let p = GicParams::query().expect("GIC parameters");
    // The architecture §7 per-`Gic` accessors agree with the bulk query.
    assert_eq!(gic.distributor_size().unwrap(), p.distributor_size);
    assert_eq!(gic.redistributor_size().unwrap(), p.redistributor_size);
    assert_eq!(gic.spi_range().unwrap(), 32..1020);
    assert_eq!(p.distributor_size, 0x1_0000);
    assert_eq!(p.redistributor_size, 0x2_0000);
    assert_eq!(p.redistributor_region_size, 0x200_0000);
    assert_eq!(p.distributor_base_alignment, 0x1_0000);
    assert_eq!(p.redistributor_base_alignment, 0x1_0000);
    assert_eq!(p.msi_region_size, 0x1_0000);
    assert_eq!((p.spi_base, p.spi_count), (32, 988));
    assert_eq!(gic.intid(GicInterrupt::El1VirtualTimer).unwrap(), 27);
    assert_eq!(gic.intid(GicInterrupt::El1PhysicalTimer).unwrap(), 30);
    let typer = gic
        .distributor_reg(ffi::HV_GIC_DISTRIBUTOR_REG_GICD_TYPER)
        .expect("GICD_TYPER");
    assert_eq!(typer & 0x1f, 31, "ITLinesNumber: 1024 INTIDs");
    vm.destroy().unwrap();
}

#[test]
fn redistributor_base_requires_mpidr() {
    let _s = serial();
    let (vm, _gic) = vm_with_gic();
    let vcpu = Vcpu::create(&vm).expect("vcpu");
    assert_eq!(
        vcpu.get_sys_reg(SysReg::MPIDR_EL1).unwrap(),
        0,
        "default MPIDR"
    );
    let before = vcpu.gic_redistributor_base().unwrap_err();
    assert_eq!(
        before.error,
        HvError::BadArgument,
        "refused until MPIDR is written"
    );
    vcpu.set_sys_reg(SysReg::MPIDR_EL1, 0x8000_0000).unwrap();
    assert_eq!(vcpu.gic_redistributor_base().unwrap(), GICR, "slot 0");
    let typer = vcpu
        .gic_get_redistributor_reg(ffi::HV_GIC_REDISTRIBUTOR_REG_GICR_TYPER)
        .unwrap();
    assert_eq!((typer >> 4) & 1, 1, "Last: the only vCPU");
}

/// The guest programs the GIC for SPI 33 (PL011's line), unmasks IRQs and waits in WFI, which
/// the kernel handles without exiting. Another thread asserts the SPI; the vCPU must wake and
/// take the IRQ (spike finding 18).
///
/// "Waits in WFI" is checked, not assumed: the architecture lets WFI complete at once (it may
/// act as a NOP), and a guest spinning through `wfi; b idle` would also take the IRQ. So the
/// vCPU's in-kernel WFI time (`hv_vcpu_get_wait_for_interrupt_time`, macOS 27+, spike finding
/// 13) must grow by about the 30 ms the other thread sleeps before asserting the line.
#[test]
fn gic_set_spi_from_other_thread_wakes_wfi() {
    const SPI: u32 = 33;
    let _s = serial();
    let (vm, gic) = vm_with_gic();
    let mut vcpu = Vcpu::create(&vm).expect("vcpu");
    vcpu.set_sys_reg(SysReg::MPIDR_EL1, 0x8000_0000).unwrap();
    let rd = vcpu.gic_redistributor_base().expect("redistributor base");

    let mut a = Asm::new(RAM);
    a.movz(1, (GICD >> 16) as u32, 1);
    // GICD_CTLR. HVF's GIC has a single Security state (GICD_TYPER.SecurityExtn = 0 and
    // GICD_CTLR.DS = 1 out of reset, 0x50; spike finding 15), so the layout is the DS == 1 one
    // (GIC spec IHI 0069, GICD_CTLR register description, single Security state view):
    // bit 4 ARE, bit 1 EnableGrp1, bit 0 EnableGrp0. 0x12 = ARE | EnableGrp1: SPI 33 is a
    // Group 1 interrupt, so Group 0 stays disabled.
    a.movz(2, 0x12, 0);
    a.str_w(2, 1, 0x0);
    a.movz(2, 1 << (SPI - 32), 0);
    a.str_w(2, 1, 0x84); // GICD_IGROUPR1: SPI 33 -> group 1
    a.str_w(2, 1, 0x104); // GICD_ISENABLER1: enable SPI 33
    a.str_x(31, 1, 0x6000 + 8 * SPI); // GICD_IROUTER33 = affinity 0.0.0.0
    a.mov32(3, u32::try_from(rd).unwrap());
    a.str_w(31, 3, 0x14); // GICR_WAKER = 0: wake the redistributor
    a.movz(2, 0xff, 0);
    a.msr(enc::ICC_PMR_EL1, 2);
    a.movz(2, 1, 0);
    a.msr(enc::ICC_IGRPEN1_EL1, 2);
    a.isb();
    a.daifclr(2); // unmask IRQ
    a.hvc(0x20); // "ready"
    let idle = a.wfi();
    a.b(idle);
    let vbar = RAM + 0x800;
    for i in 0..16u32 {
        a.org(vbar + 0x80 * u64::from(i));
        if i == 5 {
            // Current EL with SP_ELx, IRQ.
            a.mrs(20, enc::ICC_IAR1_EL1);
            a.hvc(0x10);
        } else {
            a.hvc(0xe00 + i); // any other vector is a test failure
        }
    }
    let _mem = load(&vm, &a);
    vcpu.set_sys_reg(SysReg::VBAR_EL1, vbar).unwrap();
    vcpu.set_sys_reg(SysReg::SP_EL1, RAM + PAGE as u64).unwrap();
    vcpu.set_reg(Reg::PC, RAM).unwrap();
    vcpu.set_reg(Reg::CPSR, CPSR_EL1H_MASKED).unwrap();

    let dog = Watchdog::new(vcpu.handle(), Duration::from_secs(3));
    let ready = vcpu.run().expect("run to ready");
    assert_eq!(
        ec_iss(ready.esr),
        (0x16, 0x20),
        "GIC setup without stray exits: {ready:?}"
    );

    let wfi_before = vcpu.wfi_time().expect("WFI time before");
    let spi = gic.handle();
    let start = Instant::now();
    let exit = std::thread::scope(|s| {
        s.spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            spi.set_spi(SPI, true)
                .expect("hv_gic_set_spi from a non-vCPU thread");
        });
        vcpu.run().expect("run in WFI")
    });
    let woke_after = start.elapsed();
    let wfi_after = vcpu.wfi_time().expect("WFI time after");
    assert!(!dog.finish(), "watchdog fired: the SPI never woke the vCPU");
    assert_eq!(exit.reason, ExitReason::Exception, "{exit:?}");
    assert_eq!(ec_iss(exit.esr), (0x16, 0x10), "IRQ vector ran");
    assert_eq!(
        vcpu.get_reg(Reg::x(20).unwrap()).unwrap(),
        u64::from(SPI),
        "ICC_IAR1_EL1"
    );
    assert!(woke_after >= Duration::from_millis(25), "{woke_after:?}");
    match (wfi_before, wfi_after) {
        (Some(before), Some(after)) => {
            let tb = host::timebase().expect("mach timebase");
            let waited = Duration::from_nanos(tb.ticks_to_nanos(after.saturating_sub(before)));
            assert!(
                waited >= Duration::from_millis(20),
                "the vCPU was not waiting in WFI: only {waited:?} of WFI time in {woke_after:?}"
            );
            assert!(waited <= woke_after, "{waited:?} > {woke_after:?}");
        }
        // Before macOS 27 the call does not exist; only the delivery half is checked.
        (None, None) => {
            let major = host::macos_version().map_or(0, |(m, _)| m);
            assert!(
                major < 27,
                "macOS {major} should have hv_vcpu_get_wait_for_interrupt_time"
            );
        }
        other => panic!("WFI time availability changed mid-test: {other:?}"),
    }
    gic.handle().set_spi(SPI, false).expect("deassert");
    assert!(
        gic.handle().set_spi(1020, true).is_err(),
        "INTID beyond the SPI range"
    );
}

/// A GIC token is bound to the VM it came with: after that VM is destroyed and another one
/// (with its own GIC) exists, the old `Gic` and `GicHandle` are refused before the framework is
/// asked, while the new VM's tokens work. This is the in-process reboot of architecture §14.5:
/// a device thread still holding last boot's `GicHandle` must not raise lines in the new guest.
#[test]
fn stale_gic_tokens_are_refused() {
    let _s = serial();
    let (vm1, gic1) = vm_with_gic();
    let h1 = gic1.handle();
    h1.set_spi(33, true).expect("VM 1's own handle works");
    h1.set_spi(33, false).expect("deassert");
    vm1.destroy().expect("destroy VM 1");
    assert_eq!(
        h1.set_spi(33, true).unwrap_err().error,
        HvError::BadArgument
    );

    let (vm2, gic2) = vm_with_gic();
    // The framework alone would accept these (its GIC calls take no VM argument; checked by
    // disabling the generation test, which makes this `set_spi` succeed): the generation check
    // is what refuses them.
    let stale = h1.set_spi(33, true).unwrap_err();
    assert_eq!(
        (stale.call, stale.error),
        ("hv_gic_set_spi", HvError::BadArgument)
    );
    assert_eq!(gic1.reset().unwrap_err().error, HvError::BadArgument);
    assert!(gic1.save_state().is_err());
    assert!(
        gic1.distributor_reg(ffi::HV_GIC_DISTRIBUTOR_REG_GICD_CTLR)
            .is_err()
    );
    // VM 2's tokens are unaffected.
    gic2.handle().set_spi(33, true).expect("VM 2's handle");
    gic2.handle().set_spi(33, false).expect("deassert");
    gic2.distributor_reg(ffi::HV_GIC_DISTRIBUTOR_REG_GICD_CTLR)
        .expect("VM 2's GIC");
    vm2.destroy().expect("destroy VM 2");
    assert!(
        gic2.handle().set_spi(33, true).is_err(),
        "refused after its own VM is gone"
    );
}

/// `hv_vcpu.h` says per-vCPU calls must come from the owning thread. `Vcpu` is `!Send`, so safe
/// code cannot even try; here raw FFI does, and the framework refuses (spike).
#[test]
fn vcpu_get_reg_from_other_thread_fails() {
    let _s = serial();
    let (vm, _) = VmBuilder::new().create().unwrap();
    let vcpu = vcpu_at(&vm, RAM);
    let id = vcpu.id();
    let rc = std::thread::spawn(move || {
        let mut v = 0u64;
        // SAFETY: a live out-parameter; calling from a non-owner thread is exactly what is being
        // tested, and the framework rejects it without touching vCPU state.
        unsafe { ffi::hv_vcpu_get_reg(id, ffi::HV_REG_PC, &mut v) }
    })
    .join()
    .unwrap();
    assert_eq!(HvError::from_code(rc), HvError::BadArgument);
    assert_eq!(vcpu.get_reg(Reg::PC).unwrap(), RAM, "the owner still can");
}
