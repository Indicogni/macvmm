//! The arm64 Linux `Image` loader (architecture §12.1, threat model LDR-3; course ch13).
//!
//! **Why the Image format.** An arm64 kernel is not booted from its ELF (`vmlinux`): the boot
//! protocol (Linux `Documentation/arch/arm64/booting.rst` §4 "Call the kernel image") hands the
//! loader a flat binary whose first 64 bytes are a header the loader must honour. The header
//! says how far above a 2 MiB-aligned base the kernel wants to sit (`text_offset`), how much
//! memory it will use from there (`image_size`, which includes its BSS and early page tables),
//! and a few flags. Everything else in the file is code we never look at.
//!
//! **The header** (booting.rst §4, all fields little endian):
//!
//! | Offset | Field | What we do with it |
//! |---|---|---|
//! | 0 | `code0`, `code1` | executable code (a branch past the header); ignored |
//! | 8 | `text_offset` | must be 4 KiB-aligned; the kernel starts at `LINUX_IMAGE_BASE + text_offset` |
//! | 16 | `image_size` | must be non-zero (a pre-3.17 kernel has 0 and is refused); `load + image_size` must lie in RAM |
//! | 24 | `flags` | bit 0 must be 0 (little-endian kernel); bits 1–2 page size must be 0, 1 or 2; bit 3 (placement) is satisfied by our placement either way; bits 4–63 are reserved and ignored |
//! | 32..56 | `res2..res4` | reserved; ignored |
//! | 56 | `magic` | `ARM\x64` |
//! | 60 | `res5` | the PE/COFF header offset for EFI stubs; ignored |
//!
//! **Why each rule** (LDR-3, every failure a typed [`LoaderError`], never a panic):
//! - length ≥ 64: otherwise the header itself is not in the file;
//! - big-endian kernels (flag bit 0) cannot run: the vCPU starts little-endian and we write
//!   little-endian device trees;
//! - page size 3 means "64 KiB pages only": Apple Silicon implements the 4 KiB and 16 KiB
//!   translation granules but not 64 KiB (`ID_AA64MMFR0_EL1.TGran64 = 0xF`), so such a kernel
//!   would die in early boot with no console output. Refusing it up front is kinder;
//! - `image_size == 0` is a kernel older than 3.17 whose real size we cannot know, so we cannot
//!   prove the initrd and DTB stay clear of its BSS;
//! - `text_offset` must keep the kernel page-aligned (the kernel maps itself with that
//!   assumption; booting.rst §4 historically used `0x80000`, modern kernels use 0);
//! - `load + image_size` is computed with `checked_add` and must lie inside RAM: `u64::MAX`
//!   wraps otherwise;
//! - the file may not be longer than `image_size`: the kernel would overwrite the tail with
//!   its BSS, and a file bigger than the memory it claims is malformed (or hostile padding).
//!
//! **Placement** ([`place`]): PLAN §1 puts the kernel at `LINUX_IMAGE_BASE + text_offset`
//! (`0x4020_0000` for every modern kernel), just above the 2 MiB DTB slot. That satisfies flag
//! bit 3 either way: bit 3 = 0 asks for a base "as close as possible to the base of DRAM", and
//! the 2 MiB below it are the DTB's.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{ARM64_IMAGE_MAGIC, ARM64_IMAGE_MAGIC_OFFSET, LoaderError, Placement, RamRange};
use crate::arch::layout::LINUX_IMAGE_BASE;
use crate::memory::{GuestAddress, GuestMemory};

/// The size of the Image header (booting.rst §4).
pub const IMAGE_HEADER_SIZE: usize = 64;
/// `text_offset` must keep the kernel 4 KiB-aligned.
pub const TEXT_OFFSET_ALIGN: u64 = 4096;
/// `flags` bit 0: kernel endianness, 1 = big endian.
pub const FLAG_BE: u64 = 1;
/// `flags` bits 1–2: the kernel's page size.
pub const FLAG_PAGE_SIZE_SHIFT: u32 = 1;
pub const FLAG_PAGE_SIZE_MASK: u64 = 0b11;
/// `flags` bit 3: 1 = the 2 MiB-aligned base may be anywhere in RAM.
pub const FLAG_PHYS_ANYWHERE: u64 = 1 << 3;

/// The page size a kernel declares (flags bits 1–2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageSize {
    Unspecified,
    K4,
    K16,
}

/// The validated header fields (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageHeader {
    pub text_offset: u64,
    pub image_size: u64,
    pub flags: u64,
    pub page_size: PageSize,
    /// Flag bit 3: the base may be anywhere in RAM.
    pub phys_anywhere: bool,
}

/// A planned Image: its header, where it goes, and how many file bytes are copied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArmImage {
    pub header: ImageHeader,
    /// The kernel's first byte: `LINUX_IMAGE_BASE + text_offset`.
    pub load: u64,
    /// `load + image_size`: the end of the memory the kernel owns.
    pub end: u64,
    /// The file length (≤ `image_size`).
    pub file_len: u64,
}

impl ArmImage {
    /// The memory the kernel owns, as a plan row.
    pub fn placement(&self) -> Placement {
        Placement {
            what: "kernel (arm64 Image)".into(),
            addr: self.load,
            len: self.header.image_size,
        }
    }
}

/// A little-endian u64 at `off`; `None` if the slice is too short.
fn le64(b: &[u8], off: usize) -> Option<u64> {
    let bytes: [u8; 8] = b.get(off..off.checked_add(8)?)?.try_into().ok()?;
    Some(u64::from_le_bytes(bytes))
}

// ANCHOR: image_header_parse
/// Validate an arm64 Image header (booting.rst §4; module docs, LDR-3). Pure: looks at the
/// first 64 bytes and the file length only.
pub fn parse_header(b: &[u8]) -> Result<ImageHeader, LoaderError> {
    let len = u64::try_from(b.len()).unwrap_or(u64::MAX);
    if b.len() < IMAGE_HEADER_SIZE {
        return Err(LoaderError::ImageTooShort { len });
    }
    let magic_end = ARM64_IMAGE_MAGIC_OFFSET.saturating_add(4);
    if b.get(ARM64_IMAGE_MAGIC_OFFSET..magic_end) != Some(ARM64_IMAGE_MAGIC.as_slice()) {
        return Err(LoaderError::ImageBadMagic);
    }
    let short = || LoaderError::ImageTooShort { len };
    let text_offset = le64(b, 8).ok_or_else(short)?;
    let image_size = le64(b, 16).ok_or_else(short)?;
    let flags = le64(b, 24).ok_or_else(short)?;
    if flags & FLAG_BE != 0 {
        return Err(LoaderError::ImageBigEndian);
    }
    let page_size = match (flags >> FLAG_PAGE_SIZE_SHIFT) & FLAG_PAGE_SIZE_MASK {
        0 => PageSize::Unspecified,
        1 => PageSize::K4,
        2 => PageSize::K16,
        field => return Err(LoaderError::ImagePageSize { field }),
    };
    if image_size == 0 {
        return Err(LoaderError::ImageZeroSize);
    }
    if !text_offset.is_multiple_of(TEXT_OFFSET_ALIGN) {
        return Err(LoaderError::ImageTextOffset { text_offset });
    }
    if len > image_size {
        return Err(LoaderError::ImageFileTooLong {
            file_len: len,
            image_size,
        });
    }
    Ok(ImageHeader {
        text_offset,
        image_size,
        flags,
        page_size,
        phys_anywhere: flags & FLAG_PHYS_ANYWHERE != 0,
    })
}
// ANCHOR_END: image_header_parse

// ANCHOR: bootplan_place_kernel
/// Parse `b` and place it at `LINUX_IMAGE_BASE + text_offset` (module docs). The whole
/// `image_size` span, not just the file, must fit in RAM: that is the memory the kernel will
/// use before it has parsed the device tree.
pub fn place(b: &[u8], ram: RamRange) -> Result<ArmImage, LoaderError> {
    let header = parse_header(b)?;
    let what = "kernel (arm64 Image)";
    let outside = |addr: u64| LoaderError::OutsideRam {
        what: what.into(),
        addr,
        len: header.image_size,
    };
    let load = LINUX_IMAGE_BASE
        .checked_add(header.text_offset)
        .ok_or_else(|| outside(u64::MAX))?;
    let end = load
        .checked_add(header.image_size)
        .ok_or_else(|| outside(load))?;
    if !ram.contains(load, header.image_size) {
        return Err(outside(load));
    }
    Ok(ArmImage {
        header,
        load,
        end,
        file_len: u64::try_from(b.len()).unwrap_or(u64::MAX),
    })
}
// ANCHOR_END: bootplan_place_kernel

/// Copy the Image's file bytes to its load address. The rest of `image_size` (BSS, early page
/// tables) is left as it is: guest RAM is freshly allocated, hence zero, on every boot, and
/// the kernel clears its own BSS anyway.
pub fn load(img: &ArmImage, b: &[u8], mem: &dyn GuestMemory) -> Result<(), LoaderError> {
    if u64::try_from(b.len()).unwrap_or(u64::MAX) != img.file_len {
        return Err(LoaderError::ImageFileTooLong {
            file_len: u64::try_from(b.len()).unwrap_or(u64::MAX),
            image_size: img.file_len,
        });
    }
    mem.write(GuestAddress(img.load), b)?;
    Ok(())
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation,
    clippy::unwrap_used
)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::arch::layout::{RAM_BASE, RAM_DEFAULT};

    fn header(text_offset: u64, image_size: u64, flags: u64, len: usize) -> Vec<u8> {
        let mut b = vec![0u8; len];
        b[8..16].copy_from_slice(&text_offset.to_le_bytes());
        b[16..24].copy_from_slice(&image_size.to_le_bytes());
        b[24..32].copy_from_slice(&flags.to_le_bytes());
        b[56..60].copy_from_slice(b"ARM\x64");
        b
    }

    #[test]
    fn alpine_like_header_places_at_2mib() {
        let ram = RamRange {
            base: RAM_BASE,
            size: RAM_DEFAULT,
        };
        let b = header(0, 0x22a_0000, 0b1010, 4096);
        let img = place(&b, ram).unwrap();
        assert_eq!(img.header.page_size, PageSize::K4);
        assert!(img.header.phys_anywhere);
        assert_eq!(img.load, LINUX_IMAGE_BASE);
        assert_eq!(img.end, LINUX_IMAGE_BASE + 0x22a_0000);
    }
}
