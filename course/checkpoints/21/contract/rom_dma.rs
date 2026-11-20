// Checkpoint 21 contract (L1), frozen from the reference test crates/vmm/tests/rom_dma.rs.
// It names only items the chapter 21 lesson teaches; the harness runs it against your crates.
//! PLAN M18 security test `rom_unreachable_by_dma` (threat model MEM-3; QEMU CVE-2021-3929
//! is the class: device DMA aimed at memory the device must not reach).
//!
//! A virtio-rng driver posts one *writable* descriptor whose address is `0x0000_0000`, the
//! first byte of flash bank 0 where `--bios` firmware lives. The device writes only through
//! `GuestMemory`, which covers RAM and nothing else, so the chain is refused: the device goes
//! to DEVICE_NEEDS_RESET (virtio 1.2 §2.1.2) and nothing is written anywhere (the `VecMemory`
//! access log).
//!
//! **What actually keeps the ROM safe, and what this test checks.** MEM-3 rests on two facts:
//!
//! 1. *The type split.* `RomRegion` is not a `GuestMemory`, so it can never be handed to a
//!    virtio device: the ROM's bytes are unreachable by construction. That is why the
//!    "ROM bytes unchanged" assertions below hold *structurally*: the ROM buffer is a separate
//!    object the device never sees, so they could not fail even if the device misbehaved.
//!    They stay as a record of the property, not as its proof.
//! 2. *The wiring.* `Machine::build` gives the virtio devices (`VirtioEnv.mem`) the same
//!    `GuestRam` it builds from `machine::virt::ram_regions(cfg.mem_bytes)`. The device memory
//!    here is built from that same helper, and the tests assert that the regions it returns
//!    (for every `--mem` size, and as a real `GuestRam` under `hvf-tests`) contain neither
//!    flash bank. If the machine's RAM ever grew over the flash range, these would fail.
//!
//! The behavioural assertions are the NEEDS_RESET status, the device's access log (no write,
//! nothing below RAM) and `check_range(FLASH0_BASE)` on the exact memory object the device
//! holds.
//!
//! The host test keeps the ROM in a plain buffer loaded by the real `firmware::load_rom` (an
//! `hv_vm_allocate`d `RomRegion` needs the hypervisor entitlement); with `--features
//! hvf-tests` the same scenario runs against a real `RomRegion` and a real `GuestRam`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use virtio_support::*;
use vmm::arch::layout::{FLASH_BANK_SIZE, FLASH0_BASE, FLASH1_BASE, Layout};
use vmm::backend::entropy::Entropy;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::control::VmControl;
use vmm::irq::TestIrq;
use vmm::loader::firmware::{RomTarget, load_rom};
use vmm::machine::virt::ram_regions;
use vmm::memory::prelude::*;
use vmm::memory::{MemoryError, RegionTable, VecMemory};
use vmm::virtio::mmio::reg;
use vmm::virtio::{Rng, VirtioDevice, VirtioInterrupt, VirtioMmio, Worker, status as st};

/// A stand-in firmware image: a branch-to-self reset vector and a recognisable pattern.
fn firmware() -> Vec<u8> {
    let mut fw = 0x1400_0000u32.to_le_bytes().to_vec(); // b .
    fw.extend((0..4092u32).map(|i| (i.wrapping_mul(31) ^ 0xa5) as u8));
    fw
}

/// A 64 KiB ROM in a host buffer (the host-test stand-in for `RomRegion`).
struct BufRom(Mutex<Vec<u8>>);

impl RomTarget for BufRom {
    fn size(&self) -> u64 {
        self.0.lock().unwrap().len() as u64
    }
    fn load(&self, offset: u64, data: &[u8]) -> Result<(), MemoryError> {
        let mut v = self.0.lock().unwrap();
        let start = offset as usize;
        v.get_mut(start..start + data.len())
            .ok_or(MemoryError::OutOfBounds {
                addr: offset,
                len: data.len() as u64,
            })?
            .copy_from_slice(data);
        Ok(())
    }
}

/// The driver side: an activated virtio-rng behind its transport and worker. Its memory is a
/// `VecMemory` over `machine::virt::ram_regions`, the regions `Machine::build` builds the
/// virtio devices' `GuestRam` from (module docs).
struct Guest {
    t: VirtioMmio,
    ring: Ring,
    mem: Arc<VecMemory>,
    worker: Arc<Worker>,
    ctl: Arc<VmControl>,
}

impl Guest {
    fn new() -> Guest {
        let mem = Arc::new(VecMemory::new(&ram_regions(RAM_SIZE)).unwrap());
        // The rings (virtio_support) sit at the start of RAM, which is where the machine puts it.
        assert!(mem.check_range(GuestAddress(RAM), RAM_SIZE));
        let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
        let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(Rng::new(Entropy::os())));
        let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
        let mut t = VirtioMmio::new(device.clone(), vi.clone(), Some(gm)).unwrap();
        let ctl = Arc::new(VmControl::new());
        let worker = Worker::spawn("virtio-rng-rom", device, vi, vec![64], ctl.clone()).unwrap();
        let n: Arc<dyn vmm::virtio::QueueNotifier> = worker.clone();
        t.set_notifier(Some(n));
        Guest {
            t,
            ring: Ring::new(mem.clone(), 16),
            mem,
            worker,
            ctl,
        }
    }
    fn r(&mut self, off: u64) -> u32 {
        self.t.read(off, AccessSize::B4) as u32
    }
    fn w(&mut self, off: u64, v: u32) {
        self.t.write(off, AccessSize::B4, u64::from(v));
    }
    fn up(&mut self) -> u32 {
        for s in [0, 1, 3] {
            self.w(reg::STATUS, s);
        }
        self.w(reg::DRIVER_FEATURES_SEL, 1);
        self.w(reg::DRIVER_FEATURES, 1); // VERSION_1
        self.w(reg::STATUS, 11);
        self.w(reg::QUEUE_SEL, 0);
        self.w(reg::QUEUE_NUM, u32::from(self.ring.size));
        for (lo, a) in [
            (reg::QUEUE_DESC_LOW, self.ring.desc),
            (reg::QUEUE_DRIVER_LOW, self.ring.avail),
            (reg::QUEUE_DEVICE_LOW, self.ring.used),
        ] {
            self.w(lo, a as u32);
            self.w(lo + 4, (a >> 32) as u32);
        }
        self.w(reg::QUEUE_READY, 1);
        self.w(reg::STATUS, 15);
        self.r(reg::STATUS)
    }
}

/// Post a 32-byte writable descriptor at the flash base and ring the doorbell; returns once
/// the device reports DEVICE_NEEDS_RESET (or panics after 2 s).
fn dma_into_flash(g: &mut Guest) {
    assert_eq!(g.up(), 15);
    g.ring.set_desc(0, d(FLASH0_BASE, 32, WRITE, 0));
    g.ring.push(0);
    // Record only what the device does from the doorbell on.
    g.mem.enable_log();
    g.w(reg::QUEUE_NOTIFY, 0);
    let t0 = Instant::now();
    while g.r(reg::STATUS) & st::DEVICE_NEEDS_RESET == 0 {
        assert!(
            t0.elapsed() < Duration::from_secs(2),
            "no DEVICE_NEEDS_RESET"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(g.ring.used_idx(), 0, "nothing returned to the driver");
    // The device read the ring and the descriptor, refused the chain, and wrote nothing.
    let log = g.mem.log();
    let device = log.as_slice();
    assert!(!device.is_empty(), "the worker ran");
    assert!(
        device.iter().all(|a| a.fence || !a.write),
        "the device wrote: {device:?}"
    );
    assert!(
        log.iter().all(|a| a.fence || a.addr >= RAM),
        "an access below RAM: {log:?}"
    );
    assert!(
        !g.mem.check_range(GuestAddress(FLASH0_BASE), 1),
        "flash is not GuestMemory (MEM-3)"
    );
    assert!(!g.ctl.is_stopping(), "a guest error never stops the VMM");
    assert!(!g.worker.stop());
}

/// The machine's RAM regions (what `Machine::build` makes `GuestRam`, and so the virtio
/// devices' memory, from) never cover either flash bank, for any `--mem` size the layout
/// accepts (module docs, fact 2).
#[test]
fn machine_ram_regions_exclude_flash() {
    let layout = Layout::virt();
    for mem in [16 << 20, 512 << 20, 1 << 30, 4 << 30, 64u64 << 30] {
        if layout.ram_end(mem).is_err() {
            continue;
        }
        let regions = ram_regions(mem);
        let table = RegionTable::new(&regions, 40).unwrap();
        for (bank, base) in [("flash0", FLASH0_BASE), ("flash1", FLASH1_BASE)] {
            for off in [0, FLASH_BANK_SIZE - 1] {
                assert!(
                    !table.contains(GuestAddress(base + off), 1),
                    "--mem {mem:#x}: {bank} + {off:#x} is in RAM: {regions:?}"
                );
            }
        }
    }
}

#[test]
fn rom_unreachable_by_dma() {
    let fw = firmware();
    let rom = BufRom(Mutex::new(vec![0xee; 64 << 10]));
    load_rom(&rom, &fw).unwrap();
    let before = rom.0.lock().unwrap().clone();
    let mut g = Guest::new();
    dma_into_flash(&mut g);
    let after = rom.0.lock().unwrap().clone();
    // Structural (module docs, fact 1): the device never held `rom`, so this cannot fail. The
    // behavioural checks are in `dma_into_flash`.
    assert_eq!(
        before, after,
        "ROM bytes unchanged (structural: ROM is not GuestMemory)"
    );
    assert_eq!(&after[..fw.len()], fw.as_slice());
    assert!(after[fw.len()..].iter().all(|&b| b == 0), "zero padding");
}

/// The same with a real `RomRegion`, plus the real `GuestRam` `Machine::build` would make for
/// `--bios --mem 512M` (on machine: `hv_vm_allocate` needs the entitlement).
#[cfg(feature = "hvf-tests")]
#[test]
fn rom_unreachable_by_dma_real_rom_region() {
    use vmm::arch::layout::FLASH_SIZE;
    use vmm::memory::{GuestRam, RomRegion};
    // Fact 2 on the real type: the machine's RAM for a firmware boot covers neither bank.
    let ram = GuestRam::new(&ram_regions(512 << 20), 36).unwrap();
    for base in [FLASH0_BASE, FLASH1_BASE] {
        assert!(
            !ram.check_range(GuestAddress(base), 1),
            "{base:#x} is GuestMemory"
        );
    }
    assert!(ram.check_range(GuestAddress(RAM), 512 << 20));
    drop(ram);
    let fw = firmware();
    let rom = RomRegion::new(GuestAddress(FLASH0_BASE), FLASH_SIZE, 36).unwrap();
    assert!(rom.is_fresh());
    load_rom(&rom, &fw).unwrap();
    assert!(!rom.is_fresh());
    let mut g = Guest::new();
    dma_into_flash(&mut g);
    let mut back = vec![0u8; fw.len() + 64];
    rom.read(0, &mut back).unwrap();
    // Structural (module docs, fact 1): the device never held `rom`.
    assert_eq!(
        &back[..fw.len()],
        fw.as_slice(),
        "ROM bytes unchanged (structural: ROM is not GuestMemory)"
    );
    assert!(back[fw.len()..].iter().all(|&b| b == 0));
    // The ISV = 0 fetch hook reads words, aligned and in bounds only.
    assert_eq!(rom.read_u32(GuestAddress(FLASH0_BASE)), Some(0x1400_0000));
    assert_eq!(rom.read_u32(GuestAddress(FLASH0_BASE + 2)), None);
    assert_eq!(rom.read_u32(GuestAddress(FLASH0_BASE + FLASH_SIZE)), None);
    assert_eq!(
        rom.read_u32(GuestAddress(FLASH0_BASE + FLASH_SIZE - 4)),
        Some(0)
    );
}
