//! `FlashDevice`: the trap side of the flash banks (PLAN M18, ADR-0007; threat model MMIO-10).
//!
//! **What a flash bank is on a real board.** QEMU's `virt` board has two 64 MiB NOR flash
//! banks at `0x0` and `0x0400_0000` (`hw/arm/virt.c`, `virt_flash_create`), modelled as Intel
//! CFI command-set-01 parts (`hw/block/pflash_cfi01.c`; JEDEC JESD68.01 "Common Flash
//! Interface"). NOR flash reads like ROM ("read-array mode"), so firmware executes in place
//! from it; to *program* it, software writes command bytes (`0x40` program, `0x20` erase,
//! `0x98` CFI query, `0x70` read status, `0xFF` back to read-array) and the chip changes what
//! its reads return until it is put back in read-array mode.
//!
//! **What we do in v1: writes ignored.** With `--bios`, both banks are one
//! [`crate::memory::RomRegion`] that is stage-2 mapped **read+execute** (MEM-3): bank 0 holds
//! the image, bank 1 is zero (U-Boot reads its environment from it). A guest load from either
//! is an ordinary memory access that never leaves the CPU. A guest **store** is a stage-2
//! permission fault (ARM ARM D8.4, "stage 2 permission fault": the descriptor's S2AP has no
//! write permission) that HVF reports as a data abort with the faulting IPA in flash
//! (architecture §8.3); `vcpu::mmio` finds this device (one per bank) on the bus and calls
//! [`FlashDevice::write`], which drops the value. So the image can never change, a firmware
//! that tries to save its environment simply does not persist it, and the access is answered
//! instead of stopping the VM as unhandled MMIO.
//!
//! PLAN M18's decision procedure says to build the CFI-01 state machine (query, status, ID,
//! romd unmap/remap) only if U-Boot hangs or aborts without it. It did not:
//! `docs/compat/uboot.md` records the observed boot. So there is no `flash@0` node in the
//! device tree, U-Boot's CFI driver finds no flash, and this device is only the
//! write-ignore half.
//!
//! **Total and quiet** (MMIO-8, MMIO-10). Every `(offset, size)` the bus passes gets an answer:
//! a read is all-ones (what an erased NOR cell reads as), a write is ignored. While the banks
//! are mapped no load ever traps, so `read` exists only so the device is total over its window. Writes are counted, and each one
//! is logged through `guest_warn!`, whose per-call-site rate limit (LOG-1: the first 10, then
//! one in 1000) keeps a guest that loops on flash writes from flooding stderr.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::bus::{AccessSize, MmioDevice};

/// The value a read returns: an erased NOR cell reads as all ones (CFI read-array mode of an
/// erased block), masked to the access width.
const ERASED: u64 = u64::MAX;

/// One flash bank's trap handler (module docs): reads are erased cells, writes are ignored.
/// `machine::load_firmware` puts one of these over each bank, so offsets and the write count
/// are per bank.
#[derive(Debug, Default)]
pub struct FlashDevice {
    writes: u64,
}

impl FlashDevice {
    pub fn new() -> FlashDevice {
        FlashDevice::default()
    }

    /// How many guest writes to *this bank* were ignored so far (for tests and
    /// `docs/compat/uboot.md`). Each bank has its own device and counter, so a boot's total is
    /// the sum over both banks.
    pub fn writes_ignored(&self) -> u64 {
        self.writes
    }
}

/// `ERASED` masked to `size` bytes.
fn erased(size: AccessSize) -> u64 {
    match size {
        AccessSize::B1 => 0xff,
        AccessSize::B2 => 0xffff,
        AccessSize::B4 => 0xffff_ffff,
        AccessSize::B8 => ERASED,
    }
}

impl MmioDevice for FlashDevice {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        crate::guest_debug!(
            "flash: {}-byte read at offset {offset:#x} outside the ROM mapping",
            size.bytes()
        );
        erased(size)
    }

    // ANCHOR: flash_write_ignored
    fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
        // MMIO-10: the ROM is read+execute at stage 2, so a store faults here; drop it. The
        // count saturates (a guest can loop forever) and the log is rate-limited (LOG-1).
        // ANCHOR: flash_write_ignored_body
        self.writes = self.writes.saturating_add(1);
        crate::guest_warn!(
            "flash: ignored {}-byte write of {value:#x} at offset {offset:#x} \
             (flash is read-only, write {} to this bank)",
            size.bytes(),
            self.writes
        );
        // ANCHOR_END: flash_write_ignored_body
    }
    // ANCHOR_END: flash_write_ignored
}

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects)] // tests: a panic fails the test
mod tests {
    use super::*;
    use crate::arch::layout::{FLASH_BANK_SIZE, FLASH0_BASE, Layout};
    use crate::bus::Bus;
    use std::sync::{Arc, Mutex};

    const SIZES: [AccessSize; 4] = [
        AccessSize::B1,
        AccessSize::B2,
        AccessSize::B4,
        AccessSize::B8,
    ];

    /// PLAN M18 host acceptance: writes are ignored, and no offset or width panics.
    #[test]
    fn write_ignored_and_total_at_every_width() {
        let mut f = FlashDevice::new();
        let offsets = [
            0,
            1,
            2,
            3,
            7,
            0x55 * 4,
            0xaaa,
            FLASH_BANK_SIZE / 2,
            FLASH_BANK_SIZE - 8,
            FLASH_BANK_SIZE - 1,
        ];
        let mut n = 0;
        for &off in &offsets {
            for size in SIZES {
                for v in [0, 0x98, 0xff, 0x70, 0x90, 0x40, u64::MAX] {
                    f.write(off, size, v);
                    n += 1;
                }
                let r = f.read(off, size);
                assert_eq!(r, erased(size), "offset {off:#x} {size:?}");
            }
        }
        assert_eq!(f.writes_ignored(), n);
        // CFI command writes change nothing: a query (0x98) still reads erased, not "QRY".
        f.write(0x55 * 4, AccessSize::B4, 0x98);
        assert_eq!(f.read(0x10 * 4, AccessSize::B4), 0xffff_ffff);
        // The counter saturates instead of overflowing.
        f.writes = u64::MAX;
        f.write(0, AccessSize::B1, 0);
        assert_eq!(f.writes_ignored(), u64::MAX);
    }

    /// The device fits flash bank 0's layout row exactly, and the bus routes every width to it.
    #[test]
    fn sits_in_the_flash0_row() {
        let row = Layout::virt().find(FLASH0_BASE).unwrap();
        assert_eq!((row.name, row.size), ("flash0", FLASH_BANK_SIZE));
        let mut bus = Bus::new();
        let dev = Arc::new(Mutex::new(FlashDevice::new()));
        bus.insert("flash0", FLASH0_BASE, FLASH_BANK_SIZE, dev.clone())
            .unwrap();
        for size in SIZES {
            bus.write(FLASH0_BASE + 0x100, size, 0x40).unwrap();
            assert_eq!(bus.read(FLASH0_BASE + 0x100, size), Ok(erased(size)));
        }
        assert_eq!(crate::sync::lock(&dev).writes_ignored(), 4);
        // The last byte is inside; one past the bank is not this device.
        assert!(
            bus.write(FLASH0_BASE + FLASH_BANK_SIZE - 1, AccessSize::B1, 0)
                .is_ok()
        );
        assert_ne!(
            bus.device_at(FLASH0_BASE + FLASH_BANK_SIZE).map(|d| d.0),
            Some("flash0")
        );
    }
}
