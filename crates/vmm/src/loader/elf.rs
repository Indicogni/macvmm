//! The ELF64 loader for test guests (architecture §12.1, threat model LDR-2; course ch13).
//!
//! **Why ELF.** It is the format the guest toolchain produces (`guests/`, linked at
//! `0x4008_0000`), and it says where every byte goes and where execution starts, which a flat
//! binary cannot. It is also the course's first real parser of hostile input: every field below
//! comes from a file the VMM did not write.
//!
//! **What is accepted** (System V gABI, "ELF Header" and "Program Header"; the AArch64 ELF
//! ABI, IHI 0056, for `EM_AARCH64` = 183), exactly LDR-2:
//! - `e_ident`: magic, `ELFCLASS64`, `ELFDATA2LSB`, `EV_CURRENT`; `e_type == ET_EXEC`,
//!   `e_machine == EM_AARCH64`, `e_version == EV_CURRENT`;
//! - `e_phentsize == 56` and `e_phnum ≤ 64` ([`MAX_PHNUM`]), and the program-header table
//!   inside the file, computed with `checked_mul`/`checked_add`;
//! - for every `PT_LOAD`: `p_filesz ≤ p_memsz`; `[p_offset, p_offset + p_filesz)` inside the
//!   file; `p_vaddr == p_paddr` (the guest starts with the MMU off, so the address it runs at
//!   *is* the physical address: a mismatch would silently run the wrong bytes); the memory range
//!   inside RAM; no overlap with the DTB slot or with another segment;
//! - `e_entry` inside an executable (`PF_X`) `PT_LOAD`.
//!
//! **Section headers are ignored entirely** (`e_shoff`, `e_shnum`, ...): they are not needed to
//! load a program, and every field we do not read is attack surface we do not have. Non-LOAD
//! program headers (`PT_GNU_STACK`, `PT_NOTE`, ...) are skipped after their size checks.
//!
//! **Loading** copies `p_filesz` bytes and zero-fills the rest up to `p_memsz` (the BSS), all
//! through the bounds-checked `GuestMemory::write`.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{LoaderError, Placement, RamRange, overlaps};
use crate::memory::{GuestAddress, GuestMemory};

/// The most program headers accepted (LDR-2, architecture §21.5).
pub const MAX_PHNUM: u16 = 64;
/// `sizeof(Elf64_Ehdr)`.
pub const EHDR_SIZE: usize = 64;
/// `sizeof(Elf64_Phdr)`; `e_phentsize` must equal it.
pub const PHDR_SIZE: u16 = 56;
/// `e_machine` for AArch64 (IHI 0056 §5.1).
pub const EM_AARCH64: u16 = 183;
pub const ET_EXEC: u16 = 2;
pub const PT_LOAD: u32 = 1;
pub const PF_X: u32 = 1;
const ELFCLASS64: u8 = 2;
const ELFDATA2LSB: u8 = 1;
const EV_CURRENT: u8 = 1;
/// Zero-fill chunk for the BSS (one stack buffer, no allocation sized by the guest).
const ZERO_CHUNK: usize = 64 * 1024;

/// The header fields the loader uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub entry: u64,
    pub phoff: u64,
    pub phnum: u16,
}

/// One validated `PT_LOAD` segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment {
    /// Its program-header index (for messages).
    pub index: usize,
    pub paddr: u64,
    pub offset: u64,
    pub filesz: u64,
    pub memsz: u64,
    pub exec: bool,
}

/// A fully validated ELF image: where each segment goes, and the entry point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ElfImage {
    pub entry: u64,
    pub segments: Vec<Segment>,
}

fn field<const N: usize>(b: &[u8], off: usize, what: &'static str) -> Result<[u8; N], LoaderError> {
    off.checked_add(N)
        .and_then(|end| b.get(off..end))
        .and_then(|s| <[u8; N]>::try_from(s).ok())
        .ok_or(LoaderError::ElfTruncated { what })
}
fn u16_at(b: &[u8], off: usize, what: &'static str) -> Result<u16, LoaderError> {
    field::<2>(b, off, what).map(u16::from_le_bytes)
}
fn u32_at(b: &[u8], off: usize, what: &'static str) -> Result<u32, LoaderError> {
    field::<4>(b, off, what).map(u32::from_le_bytes)
}
fn u64_at(b: &[u8], off: usize, what: &'static str) -> Result<u64, LoaderError> {
    field::<8>(b, off, what).map(u64::from_le_bytes)
}

fn require(field: &'static str, value: u64, ok: bool) -> Result<(), LoaderError> {
    if ok {
        Ok(())
    } else {
        Err(LoaderError::ElfUnsupported { field, value })
    }
}

// ANCHOR: elf_validate_header
/// Check the ELF header (module docs) and return the fields the loader needs. The program
/// header table's position is checked too, so the caller can index it safely.
pub fn validate_header(b: &[u8]) -> Result<Header, LoaderError> {
    let ident: [u8; 16] = field(b, 0, "e_ident")?;
    let [m0, m1, m2, m3, class, data, version, ..] = ident;
    require("magic", 0, [m0, m1, m2, m3] == *super::ELF_MAGIC)?;
    require("EI_CLASS", class.into(), class == ELFCLASS64)?;
    require("EI_DATA", data.into(), data == ELFDATA2LSB)?;
    require("EI_VERSION", version.into(), version == EV_CURRENT)?;
    if b.len() < EHDR_SIZE {
        return Err(LoaderError::ElfTruncated { what: "header" });
    }
    let e_type = u16_at(b, 16, "e_type")?;
    require("e_type", e_type.into(), e_type == ET_EXEC)?;
    let machine = u16_at(b, 18, "e_machine")?;
    require("e_machine", machine.into(), machine == EM_AARCH64)?;
    let e_version = u32_at(b, 20, "e_version")?;
    require(
        "e_version",
        e_version.into(),
        e_version == u32::from(EV_CURRENT),
    )?;
    let entry = u64_at(b, 24, "e_entry")?;
    let phoff = u64_at(b, 32, "e_phoff")?;
    let phentsize = u16_at(b, 54, "e_phentsize")?;
    require("e_phentsize", phentsize.into(), phentsize == PHDR_SIZE)?;
    let phnum = u16_at(b, 56, "e_phnum")?;
    if phnum > MAX_PHNUM {
        return Err(LoaderError::ElfTooManyPhdrs { phnum });
    }
    // The table must lie inside the file: phoff + phnum * 56 ≤ len, with no wrap.
    let table_end = u64::from(phnum)
        .checked_mul(u64::from(PHDR_SIZE))
        .and_then(|n| phoff.checked_add(n));
    let file_len = u64::try_from(b.len()).unwrap_or(u64::MAX);
    match table_end {
        Some(end) if end <= file_len => Ok(Header {
            entry,
            phoff,
            phnum,
        }),
        _ => Err(LoaderError::ElfPhdrsOutOfFile),
    }
}
// ANCHOR_END: elf_validate_header

/// Parse and validate `b` as an ELF to be loaded into `ram`, never overlapping `reserved`
/// (the DTB slot). Every rule of the module docs is checked here; [`load`] then cannot fail.
pub fn parse(b: &[u8], ram: RamRange, reserved: &[Placement]) -> Result<ElfImage, LoaderError> {
    let h = validate_header(b)?;
    let file_len = u64::try_from(b.len()).unwrap_or(u64::MAX);
    let mut segments: Vec<Segment> = Vec::new();
    for index in 0..usize::from(h.phnum) {
        // In the file: validate_header proved phoff + phnum * 56 ≤ len.
        let off = u64::try_from(index)
            .ok()
            .and_then(|i| i.checked_mul(u64::from(PHDR_SIZE)))
            .and_then(|o| o.checked_add(h.phoff))
            .and_then(|o| usize::try_from(o).ok())
            .ok_or(LoaderError::ElfPhdrsOutOfFile)?;
        let at = |d: usize| off.checked_add(d).ok_or(LoaderError::ElfPhdrsOutOfFile);
        let p_type = u32_at(b, off, "program header")?;
        if p_type != PT_LOAD {
            continue;
        }
        let flags = u32_at(b, at(4)?, "program header")?;
        let offset = u64_at(b, at(8)?, "program header")?;
        let vaddr = u64_at(b, at(16)?, "program header")?;
        let paddr = u64_at(b, at(24)?, "program header")?;
        let filesz = u64_at(b, at(32)?, "program header")?;
        let memsz = u64_at(b, at(40)?, "program header")?;
        if filesz > memsz {
            return Err(LoaderError::ElfFileszGtMemsz { index });
        }
        if offset.checked_add(filesz).is_none_or(|end| end > file_len) {
            return Err(LoaderError::ElfSegmentOutOfFile { index });
        }
        if memsz == 0 {
            continue; // occupies nothing
        }
        if vaddr != paddr {
            return Err(LoaderError::ElfVaddrNotPaddr { index });
        }
        let what = format!("ELF segment {index}");
        if !ram.contains(paddr, memsz) {
            return Err(LoaderError::OutsideRam {
                what,
                addr: paddr,
                len: memsz,
            });
        }
        if reserved
            .iter()
            .any(|r| overlaps(paddr, memsz, r.addr, r.len))
        {
            return Err(LoaderError::OverlapsDtb { what });
        }
        if let Some(other) = segments
            .iter()
            .find(|s| overlaps(paddr, memsz, s.paddr, s.memsz))
        {
            return Err(LoaderError::Overlap {
                a: what,
                b: format!("ELF segment {}", other.index),
            });
        }
        segments.push(Segment {
            index,
            paddr,
            offset,
            filesz,
            memsz,
            exec: flags & PF_X != 0,
        });
    }
    if segments.is_empty() {
        return Err(LoaderError::ElfNoSegments);
    }
    let entry_ok = segments.iter().any(|s| {
        s.exec && h.entry >= s.paddr && h.entry.checked_sub(s.paddr).is_some_and(|d| d < s.memsz)
    });
    if !entry_ok {
        return Err(LoaderError::ElfEntryNotExecutable { entry: h.entry });
    }
    Ok(ElfImage {
        entry: h.entry,
        segments,
    })
}

// ANCHOR: elf_load_segments
/// Copy each segment's file bytes to its address and zero its BSS tail. `img` must come from
/// [`parse`] over the same `b`; every range was checked there, and is checked again here by
/// the `GuestMemory` API (a mismatch is an `Err`, never an out-of-bounds write).
pub fn load(img: &ElfImage, b: &[u8], mem: &dyn GuestMemory) -> Result<(), LoaderError> {
    let zeros = [0u8; ZERO_CHUNK];
    for s in &img.segments {
        let file_bytes = usize::try_from(s.offset)
            .ok()
            .zip(usize::try_from(s.filesz).ok())
            .and_then(|(o, n)| b.get(o..o.checked_add(n)?))
            .ok_or(LoaderError::ElfSegmentOutOfFile { index: s.index })?;
        if !file_bytes.is_empty() {
            mem.write(GuestAddress(s.paddr), file_bytes)?;
        }
        // BSS: [paddr + filesz, paddr + memsz), in bounded chunks.
        let mut addr = s
            .paddr
            .checked_add(s.filesz)
            .ok_or(LoaderError::ElfNoSegments)?;
        let mut left = s.memsz.saturating_sub(s.filesz);
        while left > 0 {
            let n = usize::try_from(left).map_or(ZERO_CHUNK, |l| l.min(ZERO_CHUNK));
            mem.write(GuestAddress(addr), zeros.get(..n).unwrap_or(&zeros))?;
            let n64 = u64::try_from(n).unwrap_or(u64::MAX);
            left = left.saturating_sub(n64);
            addr = addr.saturating_add(n64);
        }
    }
    Ok(())
}
// ANCHOR_END: elf_load_segments
