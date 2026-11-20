//! PLAN M18 host acceptance for the firmware boot (`--bios` on the `virt` machine): the plan,
//! the configuration rules, the debug-hypercall default (threat model HC-2) and the
//! `--dry-run` description. No HVF: everything here is decided before a VM exists.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::arch::layout::{FLASH_BANK_SIZE, FLASH0_BASE, RAM_BASE};
use vmm::backend::hostio::HostIo;
use vmm::backend::serial::Sink;
use vmm::config::{DebugHvc, VmConfig};
use vmm::error::Error;
use vmm::machine;

/// A `HostIo` holding `bios` as the `--bios` bytes and nothing else.
fn bios_host(bios: Vec<u8>) -> HostIo {
    let mut h = HostIo::from_bytes(None, Vec::new(), Arc::new(Sink::none()));
    h.bios = Some(Arc::from(bios));
    h
}

fn bios_cfg() -> VmConfig {
    let mut cfg = VmConfig::default();
    cfg.boot.bios = Some("u-boot.bin".into());
    cfg
}

/// The plan: PC at the flash base, x0 = the DTB at the start of RAM, nothing else in RAM.
#[test]
fn bios_plans_a_firmware_boot() {
    let cfg = bios_cfg();
    let host = bios_host(vec![0x14; 8192]);
    let plan = machine::plan_boot(&cfg, &host).unwrap();
    assert_eq!(plan.entry, FLASH0_BASE);
    assert_eq!(plan.x0, RAM_BASE);
    assert_eq!(plan.cpsr, 0x3c5);
    assert!(plan.images.is_empty() && plan.elf.is_none() && plan.image.is_none());
    let fw = plan.firmware.unwrap();
    assert_eq!((fw.addr, fw.len), (FLASH0_BASE, 8192));
}

/// LDR-1 in the plan: an empty image and one larger than a flash bank are usage errors.
#[test]
fn bios_size_rules_are_config_errors() {
    let cfg = bios_cfg();
    for bad in [Vec::new(), vec![0u8; FLASH_BANK_SIZE as usize + 1]] {
        let e = machine::plan_boot(&cfg, &bios_host(bad)).unwrap_err();
        assert!(matches!(e, Error::Loader(_)), "{e:?}");
        assert!(e.to_string().contains("--bios"), "{e}");
    }
    assert!(machine::plan_boot(&cfg, &bios_host(vec![0; FLASH_BANK_SIZE as usize])).is_ok());
}

/// `--bios` boots alone: every OS input with it is refused before any host I/O.
#[test]
fn bios_excludes_os_inputs() {
    let mut c = bios_cfg();
    c.boot.kernel = Some("k".into());
    assert!(c.validate().unwrap_err().to_string().contains("--kernel"));
    let mut c = bios_cfg();
    c.boot.cmdline = Some("x".into());
    assert!(c.validate().unwrap_err().to_string().contains("--cmdline"));
    let mut c = bios_cfg();
    c.boot.initrd = Some("rd".into());
    assert!(c.validate().unwrap_err().to_string().contains("--initrd"));
    assert!(bios_cfg().validate().is_ok());
}

/// HC-2: the debug hypercalls are off for firmware under `Auto`; the flags still override.
/// The no-GIC teaching mode is refused for firmware (it is not a test guest).
#[test]
fn bios_is_not_a_test_guest() {
    let host = bios_host(vec![0x14; 64]);
    let mut cfg = bios_cfg();
    assert_eq!(cfg.debug_hvc, DebugHvc::Auto);
    assert!(!machine::is_test_guest(&cfg, &host));
    assert!(!cfg.debug_calls_enabled(machine::is_test_guest(&cfg, &host)));
    cfg.debug_hvc = DebugHvc::On;
    assert!(cfg.debug_calls_enabled(false), "--debug-hvc overrides");
    let mut none = bios_cfg();
    none.irqchip = vmm::config::IrqChip::None;
    assert!(machine::plan_boot(&none, &host).is_err());
}

/// `--dry-run` describes the firmware row, both flash banks as ROM, and debug calls off.
#[test]
fn bios_dry_run_describes_the_flash() {
    let out = machine::dry_run(&bios_cfg(), &bios_host(vec![0x14; 4096])).unwrap();
    assert!(out.contains("flash0  0x0..0x1000  firmware"), "{out}");
    assert!(out.contains("pc=0x0 x0=0x40000000"), "{out}");
    assert!(out.contains("flash0       Rom"), "{out}");
    assert!(out.contains("flash1       Rom"), "{out}");
    assert!(out.contains("debug hypercalls: off"), "{out}");
}
