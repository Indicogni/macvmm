//! Firmware ROM images (`--bios F`): check the bytes and copy them into a [`RomRegion`]
//! (architecture §12.1; threat model LDR-1, MEM-3; PLAN M18, M21).
//!
//! **What firmware is, to a VMM.** A kernel is loaded into RAM and entered with registers the
//! boot protocol defines (booting.rst §4). Firmware is lower down: it is the first code the
//! CPU runs after reset, from a ROM at a fixed address, and it finds the hardware itself.
//! So the VMM's job is small and exact: put the bytes at the ROM address, map them
//! **read+execute** (a store to a ROM must fault, as it would on a real board), and start the
//! vCPU at the ROM's entry point.
//!
//! **Why not `GuestMemory`** (MEM-3). The ROM is a separate host allocation, not part of guest
//! RAM: no device can DMA into firmware through the guest-memory API, and a guest store to it
//! is a stage-2 permission fault that reaches the VMM's MMIO path instead of silently
//! changing the code.
//!
//! **Two users.**
//! - M21 (this file's first user): Apple's `AVPBooter.vmapple2.bin`, the macOS-guest boot ROM
//!   that ships with Virtualization.framework, on the experimental `--machine vmapple`. It is
//!   **read at run time** from [`AVPBOOTER_VMAPPLE2`] (or the `--bios` the user names) by
//!   `HostIo`, held in this process's memory, and **never written to disk**: not to the repo,
//!   the cache, a test fixture or a trace (ADR-0008 decision 3, PLAN D4, TEST-11). Nothing in
//!   macvmm parses or disassembles it; the loader only checks its length.
//! - M18: U-Boot (`qemu_arm64`, ADR-0007) in flash bank 0 on the `virt` machine: one
//!   [`RomRegion`] over both 64 MiB banks at `FLASH0_BASE`, entered at `PC = 0` with `x0` = the
//!   DTB (`loader::plan`, anchor `bootplan_firmware`). The image (at most one bank,
//!   [`MAX_FIRMWARE`]) fills the start of bank 0 and **everything after it reads as zero**
//!   ([`load_rom`]), like QEMU's `-bios` (`hw/arm/boot.c`: the file is copied into a zeroed
//!   flash bank). A fresh `RomRegion` is already zero (`hv_vm_allocate`, MEM-10, verified in
//!   M2), so the padding is written only into a ROM that was written before
//!   ([`RomTarget::is_fresh`]): zeroing 128 MiB on every boot would commit 128 MiB of host
//!   memory for nothing.
//!
//! The bytes come from `HostIo`, never a path (HOSTIO-1): this module opens nothing.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::memory::{MemoryError, RomRegion};
use core::fmt;

/// The largest `--bios` file `HostIo` reads (LDR-1): one 64 MiB flash bank of the `virt`
/// board. A machine's own ROM may be smaller ([`check_rom_image`]); a larger ROM window (the
/// `virt` board's two banks) still takes at most this much image ([`load_rom`]).
pub const MAX_FIRMWARE: u64 = 64 << 20;

// ANCHOR: avpbooter_path
/// Where macOS keeps the vmapple boot ROM (Virtualization.framework, macOS 12 and later). The
/// `--machine vmapple` default for `--bios`. Read in place; never copied (module docs).
pub const AVPBOOTER_VMAPPLE2: &str = "/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin";
// ANCHOR_END: avpbooter_path

/// Why a firmware image cannot go into its ROM. A usage error (exit code 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FirmwareError {
    /// The image is empty.
    Empty,
    /// The image is longer than the ROM window it must fit.
    TooLarge { len: u64, rom: u64 },
    /// Copying into the ROM failed (a VMM bug: the size was checked first).
    Load(MemoryError),
}

impl fmt::Display for FirmwareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FirmwareError::Empty => write!(f, "the firmware image is empty"),
            FirmwareError::TooLarge { len, rom } => write!(
                f,
                "the firmware image is {len} bytes, larger than its {rom}-byte ROM window"
            ),
            FirmwareError::Load(e) => write!(f, "cannot copy the firmware into its ROM: {e}"),
        }
    }
}

impl std::error::Error for FirmwareError {}

/// Check that `image` fits a ROM of `rom_size` bytes (LDR-1). Pure: no allocation, no HVF.
pub fn check_rom_image(image: &[u8], rom_size: u64) -> Result<(), FirmwareError> {
    let len = u64::try_from(image.len()).unwrap_or(u64::MAX);
    if len == 0 {
        return Err(FirmwareError::Empty);
    }
    if len > rom_size {
        return Err(FirmwareError::TooLarge { len, rom: rom_size });
    }
    Ok(())
}

/// Where [`load_rom`] writes: a [`RomRegion`] in the VMM, a plain buffer in host tests (an
/// `hv_vm_allocate`d region needs the hypervisor entitlement, which `cargo test` lacks).
pub trait RomTarget {
    /// The ROM window's size in bytes.
    fn size(&self) -> u64;
    /// Copy `data` to `offset` (bounds-checked by the implementation).
    fn load(&self, offset: u64, data: &[u8]) -> Result<(), MemoryError>;
    /// True if every byte is known to be zero (never written since a zero-filled allocation),
    /// so [`load_rom`] may skip the padding. The default is the safe answer.
    fn is_fresh(&self) -> bool {
        false
    }
}

impl RomTarget for RomRegion {
    fn size(&self) -> u64 {
        RomRegion::size(self)
    }
    fn load(&self, offset: u64, data: &[u8]) -> Result<(), MemoryError> {
        RomRegion::load(self, offset, data)
    }
    fn is_fresh(&self) -> bool {
        RomRegion::is_fresh(self)
    }
}

/// The zero chunk [`load_rom`] pads with.
const PAD_CHUNK: usize = 1 << 20;

// ANCHOR: firmware_load_rom
/// Copy `image` to the start of `rom` and make the rest of the window read as zero (module
/// docs). The size is checked first (LDR-1: at most the window and at most
/// [`MAX_FIRMWARE`]), so a bad image changes nothing. The host copy goes into the ROM's own
/// allocation, the only place the bytes ever live besides `HostIo`'s buffer; the guest can
/// read and execute it, never write it (MEM-3).
// ANCHOR: firmware_load_rom_check
pub fn load_rom(rom: &dyn RomTarget, image: &[u8]) -> Result<(), FirmwareError> {
    let size = rom.size();
    check_rom_image(image, size.min(MAX_FIRMWARE))?;
    let fresh = rom.is_fresh();
    rom.load(0, image).map_err(FirmwareError::Load)?;
    // ANCHOR_END: firmware_load_rom_check
    if fresh {
        return Ok(()); // already zero past the image (MEM-10)
    }
    // Zero padding: [len, size) in 1 MiB chunks. `len <= size` was checked above.
    let zeros = vec![0u8; PAD_CHUNK];
    let mut at = u64::try_from(image.len()).unwrap_or(u64::MAX);
    while at < size {
        let n = usize::try_from(size.saturating_sub(at))
            .unwrap_or(PAD_CHUNK)
            .min(PAD_CHUNK);
        rom.load(at, zeros.get(..n).unwrap_or(&[]))
            .map_err(FirmwareError::Load)?;
        at = at.saturating_add(u64::try_from(n).unwrap_or(u64::MAX));
    }
    Ok(())
}
// ANCHOR_END: firmware_load_rom

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A ROM in a plain buffer, pre-filled with garbage so the padding is observable.
    struct VecRom(Mutex<Vec<u8>>);

    impl RomTarget for VecRom {
        fn size(&self) -> u64 {
            self.0.lock().unwrap().len() as u64
        }
        fn load(&self, offset: u64, data: &[u8]) -> Result<(), MemoryError> {
            let mut v = self.0.lock().unwrap();
            let start = usize::try_from(offset).unwrap();
            let end = start.checked_add(data.len()).unwrap();
            v.get_mut(start..end)
                .ok_or(MemoryError::OutOfBounds {
                    addr: offset,
                    len: data.len() as u64,
                })?
                .copy_from_slice(data);
            Ok(())
        }
    }

    /// PLAN M18 host acceptance: size 0, size > 64 MiB, zero padding.
    #[test]
    fn firmware_loader_caps_and_zero_padding() {
        // Size 0 and one byte over a full flash bank are refused before anything is written.
        let bank = crate::arch::layout::FLASH_BANK_SIZE;
        assert_eq!(MAX_FIRMWARE, bank);
        assert_eq!(check_rom_image(&[], bank), Err(FirmwareError::Empty));
        let big = vec![0x5a; usize::try_from(bank).unwrap() + 1];
        assert_eq!(
            check_rom_image(&big, bank),
            Err(FirmwareError::TooLarge {
                len: bank + 1,
                rom: bank
            })
        );
        let rom = VecRom(Mutex::new(vec![0xee; 3 * PAD_CHUNK + 123]));
        assert_eq!(load_rom(&rom, &[]), Err(FirmwareError::Empty));
        assert!(rom.0.lock().unwrap().iter().all(|&b| b == 0xee));
        let over = vec![1u8; 3 * PAD_CHUNK + 124];
        assert!(matches!(
            load_rom(&rom, &over),
            Err(FirmwareError::TooLarge { .. })
        ));
        assert!(rom.0.lock().unwrap().iter().all(|&b| b == 0xee));
        // A short image: its bytes, then zeros to the end of the window (several chunks and a
        // partial one).
        load_rom(&rom, b"\x00\x00\x00\x14fw").unwrap();
        let v = rom.0.lock().unwrap().clone();
        assert_eq!(&v[..6], b"\x00\x00\x00\x14fw");
        assert!(v[6..].iter().all(|&b| b == 0), "padding is zero");
        // An image exactly the size of the window needs no padding.
        let full = vec![7u8; v.len()];
        load_rom(&rom, &full).unwrap();
        assert!(rom.0.lock().unwrap().iter().all(|&b| b == 7));
    }

    #[test]
    fn size_rules() {
        assert_eq!(check_rom_image(&[], 4096), Err(FirmwareError::Empty));
        assert_eq!(check_rom_image(&[0; 4096], 4096), Ok(()));
        assert_eq!(
            check_rom_image(&[0; 4097], 4096),
            Err(FirmwareError::TooLarge {
                len: 4097,
                rom: 4096
            })
        );
        assert!(
            FirmwareError::TooLarge { len: 2, rom: 1 }
                .to_string()
                .contains("ROM window")
        );
        assert!(AVPBOOTER_VMAPPLE2.starts_with("/System/Library/Frameworks/"));
    }
}
