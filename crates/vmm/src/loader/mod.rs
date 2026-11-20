//! Boot-image loaders: from host bytes to guest RAM (architecture §12.1, threat model LDR-1,
//! LDR-2; course ch03 and the ELF half of ch13).
//!
//! **Inputs are bytes, never paths** (HOSTIO-1, LDR-1). `backend::hostio::HostIo` opened and
//! read each file once, checked it is regular and under its cap; a loader receives `&[u8]`,
//! validates *every* field it uses, and writes to guest memory only through the bounds-checked
//! `GuestMemory` API. A malformed image is a typed [`LoaderError`] (exit code 2), never a
//! panic, never an out-of-bounds write.
//!
//! **What is recognised** ([`detect`]):
//! - ELF (`\x7fELF`, ELF spec §1 "ELF Identification"): [`elf`];
//! - an arm64 Linux `Image` (`ARM\x64` at offset 56, Linux
//!   `Documentation/arch/arm64/booting.rst` §4): [`image`] (M9), optionally with an
//!   [`initrd`] and a kernel command line;
//! - an EFI zboot (`MZ` + `zimg` at offset 4): refused with a hint, because the VMM has no
//!   decompressor (LDR-4) and `scripts/fetch.sh linux` unwraps it on the host;
//! - anything else is raw, allowed only through `--raw F@ADDR` ([`raw`]).
//!
//! [`plan`] decides where everything goes (pure and printable) and then loads it. M18 adds
//! the other kind of boot, firmware in flash ([`firmware`], [`plan::plan_firmware`]): the VMM
//! loads only the ROM and the device tree, and the firmware finds and loads the OS itself.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod elf;
pub mod firmware;
pub mod image;
pub mod initrd;
pub mod plan;
pub mod raw;

pub use plan::{BootInputs, BootPlan, Placement, load_dtb, plan, plan_firmware};

use crate::memory::MemoryError;
use core::fmt;

/// What a boot input looks like.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    Elf,
    ArmImage,
    EfiZboot,
    Raw,
}

/// The ELF magic (ELF spec, `e_ident[EI_MAG0..EI_MAG3]`).
pub const ELF_MAGIC: &[u8; 4] = b"\x7fELF";
/// The arm64 Image magic and its offset (booting.rst §4, the `magic` header field).
pub const ARM64_IMAGE_MAGIC: &[u8; 4] = b"ARM\x64";
pub const ARM64_IMAGE_MAGIC_OFFSET: usize = 56;

/// Classify `bytes` by their magic numbers. Total: any input, including an empty one, gets an
/// answer.
pub fn detect(bytes: &[u8]) -> ImageKind {
    if bytes.starts_with(ELF_MAGIC) {
        ImageKind::Elf
    } else if bytes.starts_with(b"MZ") && bytes.get(4..8) == Some(b"zimg") {
        ImageKind::EfiZboot
    } else if bytes.get(ARM64_IMAGE_MAGIC_OFFSET..ARM64_IMAGE_MAGIC_OFFSET.saturating_add(4))
        == Some(ARM64_IMAGE_MAGIC.as_slice())
    {
        ImageKind::ArmImage
    } else {
        ImageKind::Raw
    }
}

/// The guest RAM the loaders may write: `[base, base + size)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RamRange {
    pub base: u64,
    pub size: u64,
}

impl RamRange {
    /// True if `[addr, addr + len)` lies inside RAM (`len > 0`, no overflow).
    pub fn contains(&self, addr: u64, len: u64) -> bool {
        let (Some(end), Some(ram_end)) = (addr.checked_add(len), self.base.checked_add(self.size))
        else {
            return false;
        };
        len > 0 && addr >= self.base && end <= ram_end
    }
}

/// Half-open ranges `[a, a + alen)` and `[b, b + blen)` intersect (both assumed in RAM, so
/// the ends do not overflow; an overflowing end is treated as reaching `u64::MAX`).
pub fn overlaps(a: u64, alen: u64, b: u64, blen: u64) -> bool {
    let a_end = a.saturating_add(alen);
    let b_end = b.saturating_add(blen);
    a < b_end && b < a_end
}

/// Why a boot input cannot be loaded. Each is a configuration error (exit code 2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoaderError {
    /// The Image is shorter than its 64-byte header (LDR-3).
    ImageTooShort { len: u64 },
    /// The Image magic `ARM\x64` is missing at offset 56.
    ImageBadMagic,
    /// `flags` bit 0: a big-endian kernel.
    ImageBigEndian,
    /// `flags` bits 1–2 = 3 (64 KiB pages), which Apple Silicon does not implement.
    ImagePageSize { field: u64 },
    /// `image_size == 0`: a kernel older than 3.17.
    ImageZeroSize,
    /// `text_offset` is not 4 KiB-aligned.
    ImageTextOffset { text_offset: u64 },
    /// The file is longer than the `image_size` it declares.
    ImageFileTooLong { file_len: u64, image_size: u64 },
    /// `--initrd` was given with an empty file.
    InitrdEmpty,
    /// The initrd and the kernel do not fit one 1 GiB-aligned 32 GiB window (booting.rst §4).
    InitrdWindow { start: u64, end: u64 },
    /// `--initrd` or `--cmdline` without an arm64 Image `--kernel` (they are Linux only).
    LinuxOnly { what: &'static str },
    /// The kernel command line is longer than [`plan::MAX_CMDLINE`] bytes or contains NUL
    /// (FDT-2).
    BadCmdline { len: usize },
    /// `--kernel` is an EFI zboot wrapper (LDR-4).
    EfiZboot,
    /// `--kernel` is neither ELF nor Image.
    NotAKernel,
    /// The ELF file is shorter than the structure being read.
    ElfTruncated { what: &'static str },
    /// An `e_ident` or header field has a value we do not load (class, data, version, type,
    /// machine, `e_phentsize`).
    ElfUnsupported { field: &'static str, value: u64 },
    /// `e_phnum` is above [`elf::MAX_PHNUM`].
    ElfTooManyPhdrs { phnum: u16 },
    /// The program-header table does not fit in the file.
    ElfPhdrsOutOfFile,
    /// Segment `index`'s file bytes lie outside the file.
    ElfSegmentOutOfFile { index: usize },
    /// Segment `index` has `p_filesz > p_memsz`.
    ElfFileszGtMemsz { index: usize },
    /// Segment `index` has `p_vaddr != p_paddr` (the MMU is off at entry: VA = PA).
    ElfVaddrNotPaddr { index: usize },
    /// No `PT_LOAD` segment with bytes in it.
    ElfNoSegments,
    /// `e_entry` is not inside an executable `PT_LOAD`.
    ElfEntryNotExecutable { entry: u64 },
    /// An image (segment, raw blob) is not entirely inside RAM.
    OutsideRam { what: String, addr: u64, len: u64 },
    /// Two images overlap.
    Overlap { a: String, b: String },
    /// An image overlaps the DTB slot at the start of RAM.
    OverlapsDtb { what: String },
    /// The device tree does not fit its slot: `len` is 0, above `limit` (the least of 2 MiB,
    /// the RAM size and the space below the lowest image), or not the size the slot was
    /// planned for (M7).
    DtbTooLarge { len: u64, limit: u64 },
    /// Nothing to boot.
    NoImage,
    /// A guest-memory write was refused (cannot happen after planning; kept total).
    Memory(MemoryError),
    /// M18: the `--bios` image does not fit its flash bank (LDR-1).
    Firmware(firmware::FirmwareError),
}

impl fmt::Display for LoaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use LoaderError::*;
        match self {
            ImageTooShort { len } => {
                write!(
                    f,
                    "arm64 Image is {len} bytes, shorter than its 64-byte header"
                )
            }
            ImageBadMagic => f.write_str("arm64 Image magic ARM\\x64 missing at offset 56"),
            ImageBigEndian => f.write_str("arm64 Image is a big-endian kernel (flags bit 0)"),
            ImagePageSize { field } => write!(
                f,
                "arm64 Image page-size field {field} (64 KiB pages) is not supported by Apple \
                 Silicon; use a 4K or 16K kernel"
            ),
            ImageZeroSize => f.write_str(
                "arm64 Image has image_size 0 (a kernel older than 3.17), so its memory use is \
                 unknown",
            ),
            ImageTextOffset { text_offset } => {
                write!(
                    f,
                    "arm64 Image text_offset {text_offset:#x} is not 4 KiB-aligned"
                )
            }
            ImageFileTooLong {
                file_len,
                image_size,
            } => write!(
                f,
                "arm64 Image file ({file_len:#x} bytes) is longer than its image_size {image_size:#x}"
            ),
            InitrdEmpty => f.write_str("--initrd is empty"),
            InitrdWindow { start, end } => write!(
                f,
                "initrd {start:#x}..{end:#x} and the kernel do not fit one 1 GiB-aligned 32 GiB \
                 window (booting.rst §4); use less RAM or a smaller initrd"
            ),
            LinuxOnly { what } => write!(f, "{what} needs an arm64 Image --kernel"),
            BadCmdline { len } => write!(
                f,
                "--cmdline is {len} bytes; at most {} bytes without NUL are allowed",
                plan::MAX_CMDLINE
            ),
            EfiZboot => f.write_str(
                "EFI zboot image; run scripts/fetch.sh linux (unwraps it) or pass the raw Image",
            ),
            NotAKernel => {
                f.write_str("--kernel is not an ELF file; load a flat binary with --raw F@ADDR")
            }
            ElfTruncated { what } => write!(f, "ELF file too short for its {what}"),
            ElfUnsupported { field, value } => {
                write!(
                    f,
                    "unsupported ELF {field} {value:#x} (need ELF64 LE AArch64 ET_EXEC)"
                )
            }
            ElfTooManyPhdrs { phnum } => {
                write!(
                    f,
                    "ELF has {phnum} program headers (at most {})",
                    elf::MAX_PHNUM
                )
            }
            ElfPhdrsOutOfFile => f.write_str("ELF program-header table lies outside the file"),
            ElfSegmentOutOfFile { index } => {
                write!(f, "ELF segment {index}: file bytes lie outside the file")
            }
            ElfFileszGtMemsz { index } => write!(f, "ELF segment {index}: p_filesz > p_memsz"),
            ElfVaddrNotPaddr { index } => write!(
                f,
                "ELF segment {index}: p_vaddr != p_paddr (the guest starts with the MMU off)"
            ),
            ElfNoSegments => f.write_str("ELF has no loadable segment"),
            ElfEntryNotExecutable { entry } => {
                write!(
                    f,
                    "ELF entry {entry:#x} is not inside an executable segment"
                )
            }
            OutsideRam { what, addr, len } => write!(
                f,
                "{what} ({len:#x} bytes at {addr:#x}) does not fit inside guest RAM"
            ),
            Overlap { a, b } => write!(f, "{a} overlaps {b}"),
            OverlapsDtb { what } => {
                write!(
                    f,
                    "{what} overlaps the device-tree slot at the start of RAM"
                )
            }
            DtbTooLarge { len, limit } => write!(
                f,
                "the device tree ({len} bytes) does not fit its slot at the start of RAM \
                 (limit {limit} bytes: the least of 2 MiB, the RAM size and the space below \
                 the lowest image)"
            ),
            NoImage => f.write_str("nothing to boot"),
            Memory(e) => write!(f, "guest memory: {e}"),
            Firmware(e) => write!(f, "--bios: {e}"),
        }
    }
}

impl std::error::Error for LoaderError {}

impl From<MemoryError> for LoaderError {
    fn from(e: MemoryError) -> LoaderError {
        LoaderError::Memory(e)
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    #[test]
    fn detect_is_total() {
        assert_eq!(detect(b""), ImageKind::Raw);
        assert_eq!(detect(b"\x7fELF\x02"), ImageKind::Elf);
        assert_eq!(detect(b"MZ\0\0zimg"), ImageKind::EfiZboot);
        let mut img = vec![0u8; 64];
        img[56..60].copy_from_slice(b"ARM\x64");
        assert_eq!(detect(&img), ImageKind::ArmImage);
        assert_eq!(detect(&img[..58]), ImageKind::Raw);
    }

    #[test]
    fn ram_range_and_overlap() {
        let r = RamRange {
            base: 0x4000_0000,
            size: 0x400_0000,
        };
        assert!(r.contains(0x4000_0000, 1));
        assert!(r.contains(0x43ff_ffff, 1));
        assert!(!r.contains(0x4400_0000, 1));
        assert!(!r.contains(0x4000_0000, 0));
        assert!(!r.contains(u64::MAX, 2));
        assert!(!r.contains(0x3fff_ffff, 2));
        assert!(overlaps(0, 10, 9, 1));
        assert!(!overlaps(0, 10, 10, 1));
        assert!(overlaps(u64::MAX - 1, 5, u64::MAX - 1, 1));
    }
}
