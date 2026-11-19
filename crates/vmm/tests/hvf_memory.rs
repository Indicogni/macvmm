//! On-machine guest-memory tests (PLAN M2 acceptance; threat model MEM-3, MEM-5, MEM-9,
//! MEM-10, MEM-11).
//!
//! ```text
//! cargo test -p vmm --features hvf-tests --test hvf_memory -- --test-threads=1
//! ```
//!
//! One VM per process (HVF), so every test holds [`serial`]. Test code may spell layout
//! addresses; the guest programs are hand-encoded A64 (ARM ARM, "Alphabetical list of A64
//! base instructions").
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use hvf::{Capabilities, ExitReason, Reg, Vcpu, VcpuHandle};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use vmm::arch::layout::{FLASH0_BASE, Layout, RAM_BASE};
use vmm::error::Error;
use vmm::memory::prelude::*;
use vmm::memory::{GuestRam, RomRegion, TeardownAction, VecMemory};
use vmm::vm::{create_vm, teardown};

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|p| p.into_inner())
}

const MIB: u64 = 1 << 20;
/// EL1h with DAIF masked (Linux booting.rst §4 entry state).
const CPSR_EL1H_MASKED: u64 = 0x3c5;

// A64 encodings used below.
/// `MOVZ Wd, #imm16`.
fn movz_w(rd: u32, imm16: u32) -> u32 {
    0x5280_0000 | (imm16 << 5) | rd
}
/// `STR Wt, [Xn]` (unsigned offset 0).
fn str_w(rt: u32, rn: u32) -> u32 {
    0xb900_0000 | (rn << 5) | rt
}
/// `LDR Wt, [Xn]` (unsigned offset 0).
fn ldr_w(rt: u32, rn: u32) -> u32 {
    0xb940_0000 | (rn << 5) | rt
}
const HVC_0: u32 = 0xd400_0002;

fn code(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_le_bytes()).collect()
}

fn caps() -> Capabilities {
    Capabilities::probe().expect("capability probe")
}

/// Run `vcpu` once, kicking it out after 5 s so a broken guest fails instead of hanging.
fn run_once(vcpu: &mut Vcpu<'_>) -> hvf::VcpuExit {
    let handle: VcpuHandle = vcpu.handle();
    let (stop, rx) = mpsc::channel::<()>();
    let dog = std::thread::spawn(move || {
        if rx.recv_timeout(Duration::from_secs(5)) == Err(mpsc::RecvTimeoutError::Timeout) {
            let _ = hvf::vcpus_exit(&[handle]);
        }
    });
    let exit = vcpu.run().expect("hv_vcpu_run");
    drop(stop);
    dog.join().unwrap();
    assert_ne!(exit.reason, ExitReason::Canceled, "watchdog fired");
    exit
}

fn ec(esr: u64) -> u64 {
    (esr >> 26) & 0x3f
}

#[test]
fn map_512m_ram_and_roundtrip() {
    let _s = serial();
    let layout = Layout::virt();
    let size = 512 * MIB;
    let ram_end = layout.ram_end(size).unwrap();
    let (vm, gic) = create_vm(layout, ram_end, &caps()).expect("create VM with GIC");
    let bits = layout.ipa_bits_needed(ram_end);
    assert_eq!(bits, 36);
    let ram = Arc::new(GuestRam::new(&[(GuestAddress(RAM_BASE), size)], bits).unwrap());
    ram.map(&vm).expect("map 512 MiB");
    assert_eq!(ram.size(), size);
    for (addr, v) in [
        (RAM_BASE, 0x0123_4567_89ab_cdefu64),
        (RAM_BASE + size / 2 + 3, 0xfeed_face_cafe_beef),
        (ram_end - 8, 0x1122_3344_5566_7788),
    ] {
        ram.write_u64(GuestAddress(addr), v).unwrap();
        assert_eq!(ram.read_u64(GuestAddress(addr)), Ok(v), "{addr:#x}");
    }
    // A 1 MiB buffer copy across the volatile u64 middle and unaligned edges.
    let data: Vec<u8> = (0..MIB as usize).map(|i| (i * 31 + 7) as u8).collect();
    ram.write(GuestAddress(RAM_BASE + 0x1_0003), &data).unwrap();
    let mut back = vec![0u8; data.len()];
    ram.read(GuestAddress(RAM_BASE + 0x1_0003), &mut back)
        .unwrap();
    assert_eq!(back, data);
    // Bounds still hold on real memory.
    assert!(ram.read_u64(GuestAddress(ram_end - 4)).is_err());
    assert!(ram.read_u8(GuestAddress(RAM_BASE - 1)).is_err());
    assert!(!ram.check_range(GuestAddress(RAM_BASE), size + 1));

    let leaked = hvf::host::leaked_bytes();
    let freed = hvf::host::deallocate_calls();
    teardown(vm, Some(gic), ram, None).expect("clean teardown");
    assert_eq!(hvf::host::leaked_bytes(), leaked, "nothing leaked");
    assert_eq!(hvf::host::deallocate_calls(), freed + 1, "one block freed");
}

#[test]
fn guest_store_is_visible_through_guest_memory() {
    let _s = serial();
    let layout = Layout::virt();
    let size = 64 * MIB;
    let ram_end = layout.ram_end(size).unwrap();
    let (vm, gic) = create_vm(layout, ram_end, &caps()).unwrap();
    let ram = Arc::new(
        GuestRam::new(
            &[(GuestAddress(RAM_BASE), size)],
            layout.ipa_bits_needed(ram_end),
        )
        .unwrap(),
    );
    ram.map(&vm).unwrap();
    // movz w0, #0x1234 ; str w0, [x1] ; hvc #0
    ram.write(
        GuestAddress(RAM_BASE),
        &code(&[movz_w(0, 0x1234), str_w(0, 1), HVC_0]),
    )
    .unwrap();
    {
        let mut vcpu = Vcpu::create(&vm).unwrap();
        vcpu.set_reg(Reg::PC, RAM_BASE).unwrap();
        vcpu.set_reg(Reg::CPSR, CPSR_EL1H_MASKED).unwrap();
        vcpu.set_reg(Reg::X1, RAM_BASE + 0x1000).unwrap();
        let exit = run_once(&mut vcpu);
        assert_eq!(exit.reason, ExitReason::Exception);
        assert_eq!(ec(exit.esr), 0x16, "HVC from AArch64: esr {:#x}", exit.esr);
    }
    assert_eq!(ram.read_u32(GuestAddress(RAM_BASE + 0x1000)), Ok(0x1234));
    teardown(vm, Some(gic), ram, None).unwrap();
}

#[test]
fn rom_region_maps_rx_and_rejects_guest_memory_write() {
    let _s = serial();
    let layout = Layout::virt();
    let size = 64 * MIB;
    let ram_end = layout.ram_end(size).unwrap();
    let bits = layout.ipa_bits_needed(ram_end);
    let (vm, gic) = create_vm(layout, ram_end, &caps()).unwrap();
    let ram = Arc::new(GuestRam::new(&[(GuestAddress(RAM_BASE), size)], bits).unwrap());
    ram.map(&vm).unwrap();
    let rom = RomRegion::new(GuestAddress(FLASH0_BASE), 0x10_0000, bits).unwrap();
    // At 0: ldr w3, [x4] ; hvc #0 ; str w3, [x5] ; hvc #0. Data word at 0x100.
    rom.load(0, &code(&[ldr_w(3, 4), HVC_0, str_w(3, 5), HVC_0]))
        .unwrap();
    rom.load(0x100, &0xc0de_f00du32.to_le_bytes()).unwrap();
    rom.map(&vm).expect("map ROM read+execute");

    // MEM-3: guest memory reaches RAM only; the ROM's IPAs are not in it.
    assert!(ram.write_u32(GuestAddress(FLASH0_BASE), 0).is_err());
    assert!(ram.write_u32(GuestAddress(FLASH0_BASE + 0x100), 0).is_err());
    assert!(!ram.check_range(GuestAddress(FLASH0_BASE), 4));
    {
        let mut vcpu = Vcpu::create(&vm).unwrap();
        vcpu.set_reg(Reg::PC, FLASH0_BASE).unwrap();
        vcpu.set_reg(Reg::CPSR, CPSR_EL1H_MASKED).unwrap();
        vcpu.set_reg(Reg::X4, FLASH0_BASE + 0x100).unwrap();
        vcpu.set_reg(Reg::X5, FLASH0_BASE + 0x200).unwrap();
        // The guest executes from ROM and reads it.
        let exit = run_once(&mut vcpu);
        assert_eq!(ec(exit.esr), 0x16, "HVC: esr {:#x}", exit.esr);
        assert_eq!(vcpu.get_reg(Reg::X3).unwrap(), 0xc0de_f00d);
        // A guest store to ROM is a stage-2 data abort to the VMM (EC 0x24, WnR = 1).
        let exit = run_once(&mut vcpu);
        assert_eq!(ec(exit.esr), 0x24, "data abort: esr {:#x}", exit.esr);
        assert_eq!((exit.esr >> 6) & 1, 1, "WnR");
        assert_eq!(exit.ipa, FLASH0_BASE + 0x200);
    }
    let mut word = [0u8; 4];
    rom.read(0x200, &mut word).unwrap();
    assert_eq!(word, [0; 4], "the store did not land");
    teardown(vm, Some(gic), ram, Some(rom)).unwrap();
}

/// MEM-10: fresh `hv_vm_allocate` memory is zero-filled. 64 MiB, every byte.
#[test]
fn hv_allocate_is_zeroed() {
    let _s = serial();
    let size = 64 * MIB;
    let ram = GuestRam::new(&[(GuestAddress(RAM_BASE), size)], 36).unwrap();
    let mut buf = vec![0xa5u8; MIB as usize];
    let mut nonzero = 0usize;
    for chunk in 0..size / MIB {
        ram.read(GuestAddress(RAM_BASE + chunk * MIB), &mut buf)
            .unwrap();
        nonzero += buf.iter().filter(|&&b| b != 0).count();
    }
    assert_eq!(nonzero, 0, "hv_vm_allocate returned non-zero bytes");
    assert_eq!(ram.release(true), TeardownAction::Deallocate);
}

/// MEM-9: guest RAM still held by a "worker" at teardown is leaked, never freed.
#[test]
fn shared_ram_at_teardown_is_leaked() {
    let _s = serial();
    let layout = Layout::virt();
    let size = 64 * MIB;
    let ram_end = layout.ram_end(size).unwrap();
    let (vm, gic) = create_vm(layout, ram_end, &caps()).unwrap();
    let ram = Arc::new(GuestRam::new(&[(GuestAddress(RAM_BASE), size)], 36).unwrap());
    ram.map(&vm).unwrap();
    let worker: Arc<dyn GuestMemoryOrdered> = ram.clone();
    let leaked = hvf::host::leaked_bytes();
    let freed = hvf::host::deallocate_calls();
    let err = teardown(vm, Some(gic), ram, None).unwrap_err();
    assert!(matches!(err, Error::Internal(_)), "{err}");
    // The worker can still use its handle safely: the memory was not freed.
    worker.write_u16_release(GuestAddress(RAM_BASE), 7).unwrap();
    assert_eq!(worker.read_u16_acquire(GuestAddress(RAM_BASE)), Ok(7));
    drop(worker);
    assert_eq!(hvf::host::deallocate_calls(), freed, "never deallocated");
    assert_eq!(hvf::host::leaked_bytes(), leaked + size);
}

/// The configured IPA width must fit the host: RAM ending past 2^40 is a config error, and
/// no VM is left behind.
#[test]
fn ipa_beyond_host_limit_is_config_error() {
    let _s = serial();
    let c = caps();
    let ram_end = (1u64 << c.max_ipa_bits) + 0x4000;
    let err = create_vm(Layout::virt(), ram_end, &c).unwrap_err();
    assert!(matches!(err, Error::Config(_)), "{err}");
    let (vm, _gic) = create_vm(Layout::virt(), RAM_BASE + 64 * MIB, &c).expect("VM afterwards");
    vm.destroy().unwrap();
}

/// `volatile_copy_property` (memory_property.rs) on real `hv_vm_allocate` memory and the
/// volatile copy loops: random reads and writes on a `GuestRam` and a `VecMemory` with the
/// same table must agree, byte for byte and in every accept/refuse decision.
#[test]
fn volatile_copy_property_guest_ram() {
    let _s = serial();
    let regions = [
        (GuestAddress(RAM_BASE), 0x1_0000),
        (GuestAddress(RAM_BASE + 0x1_0000), 0x4000),
        (GuestAddress((1 << 40) - 0x4000), 0x4000),
    ];
    let ram = GuestRam::new(&regions, 40).unwrap();
    let oracle = VecMemory::new(&regions).unwrap();
    let seed = 0x6d61_6376_6d6d_0003u64;
    let mut x = seed;
    let mut next = move || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let edges = [
        RAM_BASE,
        RAM_BASE + 0x1_0000,
        RAM_BASE + 0x1_4000,
        (1 << 40) - 0x4000,
        1 << 40,
        u64::MAX,
    ];
    for i in 0..10_000 {
        let e = edges[(next() % edges.len() as u64) as usize];
        let addr = e.wrapping_add(next() % 96).wrapping_sub(48);
        let len = (next() % 80) as usize;
        let ctx = format!("seed {seed:#x} iteration {i}: {addr:#x}+{len}");
        if next() % 2 == 0 {
            let data: Vec<u8> = (0..len).map(|_| next() as u8).collect();
            let a = ram.write(GuestAddress(addr), &data);
            let b = oracle.write(GuestAddress(addr), &data);
            assert_eq!(a, b, "{ctx}");
        } else {
            let (mut a, mut b) = (vec![0x11u8; len], vec![0x11u8; len]);
            let ra = ram.read(GuestAddress(addr), &mut a);
            let rb = oracle.read(GuestAddress(addr), &mut b);
            assert_eq!(ra, rb, "{ctx}");
            assert_eq!(a, b, "{ctx}");
        }
        if addr.is_multiple_of(2) {
            assert_eq!(
                ram.read_u16_acquire(GuestAddress(addr)),
                oracle.read_u16_acquire(GuestAddress(addr)),
                "{ctx}"
            );
        }
    }
    assert_eq!(ram.release(true), TeardownAction::Deallocate);
}
