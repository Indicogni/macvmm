// Checkpoint 13 contract, frozen from the reference test crates/vmm/tests/elf_hostile.rs.
// It names only items the chapter 13 lesson teaches; the harness runs it against your crates.
//! Hostile ELF corpus (Security test; threat model: docs/security/threat-model.md).
//!
//! Each case starts from a valid minimal ELF built here, breaks one rule, and asserts a typed
//! `LoaderError`: never a panic, never a write outside RAM. The last cases load valid ones.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::arch::layout::RAM_BASE;
use vmm::loader::elf::{self, ElfImage};
use vmm::loader::plan::{self, BootInputs};
use vmm::loader::{LoaderError, Placement, RamRange};
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};

const RAM: RamRange = RamRange {
    base: RAM_BASE,
    size: 64 << 20,
};
const LOAD: u64 = 0x4008_0000;

/// A program header to put in the test ELF.
#[derive(Clone, Copy)]
struct Ph {
    p_type: u32,
    flags: u32,
    offset: u64,
    vaddr: u64,
    paddr: u64,
    filesz: u64,
    memsz: u64,
}

fn load_ph(addr: u64, offset: u64, filesz: u64, memsz: u64, flags: u32) -> Ph {
    Ph {
        p_type: 1,
        flags,
        offset,
        vaddr: addr,
        paddr: addr,
        filesz,
        memsz,
    }
}

/// A builder for ELF64 files; defaults are valid.
struct Elf {
    ident: [u8; 16],
    e_type: u16,
    machine: u16,
    version: u32,
    entry: u64,
    phoff: u64,
    phentsize: u16,
    phnum: Option<u16>,
    phs: Vec<Ph>,
    payload: Vec<u8>,
}

impl Elf {
    fn valid() -> Elf {
        let mut ident = [0u8; 16];
        ident[..4].copy_from_slice(b"\x7fELF");
        ident[4] = 2; // ELFCLASS64
        ident[5] = 1; // ELFDATA2LSB
        ident[6] = 1; // EV_CURRENT
        Elf {
            ident,
            e_type: 2,
            machine: 183,
            version: 1,
            entry: LOAD,
            phoff: 64,
            phentsize: 56,
            phnum: None,
            // One RX segment of 16 bytes of code plus 0x100 bytes of BSS, at file offset 0x100.
            phs: vec![load_ph(LOAD, 0x100, 16, 0x110, 5)],
            payload: (1..=16).collect(),
        }
    }

    fn bytes(&self) -> Vec<u8> {
        let mut b = vec![0u8; 0x100];
        b[..16].copy_from_slice(&self.ident);
        b[16..18].copy_from_slice(&self.e_type.to_le_bytes());
        b[18..20].copy_from_slice(&self.machine.to_le_bytes());
        b[20..24].copy_from_slice(&self.version.to_le_bytes());
        b[24..32].copy_from_slice(&self.entry.to_le_bytes());
        b[32..40].copy_from_slice(&self.phoff.to_le_bytes());
        b[52..54].copy_from_slice(&64u16.to_le_bytes());
        b[54..56].copy_from_slice(&self.phentsize.to_le_bytes());
        let phnum = self.phnum.unwrap_or(self.phs.len() as u16);
        b[56..58].copy_from_slice(&phnum.to_le_bytes());
        for (i, ph) in self.phs.iter().enumerate() {
            let o = 64 + i * 56;
            assert!(
                o + 56 <= 0x100,
                "the builder holds at most 3 program headers"
            );
            b[o..o + 4].copy_from_slice(&ph.p_type.to_le_bytes());
            b[o + 4..o + 8].copy_from_slice(&ph.flags.to_le_bytes());
            b[o + 8..o + 16].copy_from_slice(&ph.offset.to_le_bytes());
            b[o + 16..o + 24].copy_from_slice(&ph.vaddr.to_le_bytes());
            b[o + 24..o + 32].copy_from_slice(&ph.paddr.to_le_bytes());
            b[o + 32..o + 40].copy_from_slice(&ph.filesz.to_le_bytes());
            b[o + 40..o + 48].copy_from_slice(&ph.memsz.to_le_bytes());
        }
        b.extend_from_slice(&self.payload);
        b
    }
}

fn dtb() -> Vec<Placement> {
    vec![Placement {
        what: "dtb".into(),
        addr: RAM_BASE,
        len: 512 << 10,
    }]
}

fn parse(b: &[u8]) -> Result<ElfImage, LoaderError> {
    elf::parse(b, RAM, &dtb())
}

fn err(e: &Elf) -> LoaderError {
    parse(&e.bytes()).expect_err("must be rejected")
}

fn unsupported(field: &str) -> impl Fn(&LoaderError) -> bool + '_ {
    move |e| matches!(e, LoaderError::ElfUnsupported { field: f, .. } if *f == field)
}

#[test]
fn truncated_ident() {
    let b = Elf::valid().bytes();
    for n in [0, 1, 4, 15] {
        assert!(
            matches!(
                parse(&b[..n]),
                Err(LoaderError::ElfTruncated { .. }) | Err(LoaderError::ElfUnsupported { .. })
            ),
            "{n}"
        );
    }
    assert!(matches!(
        parse(&b[..40]),
        Err(LoaderError::ElfTruncated { .. })
    ));
}

#[test]
fn bad_magic() {
    let mut e = Elf::valid();
    e.ident[1] = b'X';
    assert!(unsupported("magic")(&err(&e)));
}

#[test]
fn elfclass32() {
    let mut e = Elf::valid();
    e.ident[4] = 1;
    assert!(unsupported("EI_CLASS")(&err(&e)));
}

#[test]
fn big_endian() {
    let mut e = Elf::valid();
    e.ident[5] = 2;
    assert!(unsupported("EI_DATA")(&err(&e)));
}

#[test]
fn bad_ident_version() {
    let mut e = Elf::valid();
    e.ident[6] = 0;
    assert!(unsupported("EI_VERSION")(&err(&e)));
}

#[test]
fn wrong_machine() {
    for m in [0u16, 62, 40, 182, 184, u16::MAX] {
        let mut e = Elf::valid();
        e.machine = m;
        assert!(unsupported("e_machine")(&err(&e)), "{m}");
    }
}

#[test]
fn et_dyn_and_others() {
    for t in [0u16, 1, 3, 4, 0xfe00, u16::MAX] {
        let mut e = Elf::valid();
        e.e_type = t;
        assert!(unsupported("e_type")(&err(&e)), "{t}");
    }
}

#[test]
fn bad_e_version() {
    let mut e = Elf::valid();
    e.version = 2;
    assert!(unsupported("e_version")(&err(&e)));
}

#[test]
fn phentsize_not_56() {
    for s in [0u16, 32, 55, 57, 64, u16::MAX] {
        let mut e = Elf::valid();
        e.phentsize = s;
        assert!(unsupported("e_phentsize")(&err(&e)), "{s}");
    }
}

#[test]
fn phnum_65535_and_65() {
    for n in [65u16, 0xffff] {
        let mut e = Elf::valid();
        e.phnum = Some(n);
        assert_eq!(err(&e), LoaderError::ElfTooManyPhdrs { phnum: n });
    }
}

#[test]
fn phoff_plus_size_overflows() {
    for off in [u64::MAX, u64::MAX - 55, u64::MAX - 0x1000, 1 << 63] {
        let mut e = Elf::valid();
        e.phoff = off;
        assert_eq!(err(&e), LoaderError::ElfPhdrsOutOfFile, "{off:#x}");
    }
}

#[test]
fn phdrs_beyond_file() {
    let mut e = Elf::valid();
    e.phnum = Some(64); // the table would need 64 * 56 bytes
    assert_eq!(err(&e), LoaderError::ElfPhdrsOutOfFile);
}

#[test]
fn segment_file_range_beyond_file() {
    let mut e = Elf::valid();
    e.phs[0].offset = 0x1_0000;
    assert_eq!(err(&e), LoaderError::ElfSegmentOutOfFile { index: 0 });
    let mut e = Elf::valid();
    e.phs[0].offset = u64::MAX - 4; // offset + filesz overflows
    assert_eq!(err(&e), LoaderError::ElfSegmentOutOfFile { index: 0 });
    let mut e = Elf::valid();
    e.phs[0].filesz = 0x10_0000;
    e.phs[0].memsz = 0x10_0000;
    assert_eq!(err(&e), LoaderError::ElfSegmentOutOfFile { index: 0 });
}

#[test]
fn filesz_greater_than_memsz() {
    let mut e = Elf::valid();
    e.phs[0].memsz = 8;
    assert_eq!(err(&e), LoaderError::ElfFileszGtMemsz { index: 0 });
}

#[test]
fn segment_beyond_ram_end() {
    let end = RAM.base + RAM.size;
    for (addr, memsz) in [
        (end, 16),
        (end - 8, 16),
        (u64::MAX - 8, 16),
        (0x1000, 16),
        (LOAD, u64::MAX),
    ] {
        let mut e = Elf::valid();
        e.phs[0].vaddr = addr;
        e.phs[0].paddr = addr;
        e.phs[0].memsz = memsz;
        e.entry = addr;
        assert!(
            matches!(err(&e), LoaderError::OutsideRam { .. }),
            "{addr:#x}+{memsz:#x}"
        );
    }
}

#[test]
fn segment_overlapping_dtb_slot() {
    for addr in [RAM_BASE, RAM_BASE + 0x7_fff8] {
        let mut e = Elf::valid();
        e.phs[0].vaddr = addr;
        e.phs[0].paddr = addr;
        e.entry = addr;
        assert!(
            matches!(err(&e), LoaderError::OverlapsDtb { .. }),
            "{addr:#x}"
        );
    }
}

#[test]
fn two_overlapping_segments() {
    let mut e = Elf::valid();
    e.phs.push(load_ph(LOAD + 0x100, 0x100, 16, 16, 4));
    assert!(matches!(err(&e), LoaderError::Overlap { .. }));
}

#[test]
fn vaddr_differs_from_paddr() {
    let mut e = Elf::valid();
    e.phs[0].vaddr = 0xffff_0000_0000_0000;
    assert_eq!(err(&e), LoaderError::ElfVaddrNotPaddr { index: 0 });
}

#[test]
fn entry_outside_executable_segment() {
    for entry in [0, LOAD - 4, LOAD + 0x110, u64::MAX] {
        let mut e = Elf::valid();
        e.entry = entry;
        assert_eq!(err(&e), LoaderError::ElfEntryNotExecutable { entry });
    }
    // Inside a segment, but one without PF_X.
    let mut e = Elf::valid();
    e.phs[0].flags = 4; // R only
    assert_eq!(err(&e), LoaderError::ElfEntryNotExecutable { entry: LOAD });
}

#[test]
fn no_loadable_segment() {
    let mut e = Elf::valid();
    e.phs[0].p_type = 0x6474_e551; // PT_GNU_STACK
    assert_eq!(err(&e), LoaderError::ElfNoSegments);
    let mut e = Elf::valid();
    e.phs.clear();
    assert_eq!(err(&e), LoaderError::ElfNoSegments);
}

#[test]
fn image_and_zboot_and_raw_as_kernel() {
    let mut img = vec![0u8; 64];
    img[56..60].copy_from_slice(b"ARM\x64");
    let mut zboot = b"MZ\0\0zimg".to_vec();
    zboot.resize(64, 0);
    for (bytes, want) in [
        (img, LoaderError::ImageZeroSize),
        (zboot, LoaderError::EfiZboot),
        (b"\x00\x00\x00\x14".to_vec(), LoaderError::NotAKernel),
    ] {
        let inputs = BootInputs {
            kernel: Some(&bytes),
            raw: &[],
            ..BootInputs::default()
        };
        assert_eq!(plan::plan(RAM, &inputs), Err(want));
    }
}

/// Random corruption of a valid ELF never panics (and never loads outside RAM).
#[test]
fn random_mutations_never_panic() {
    let base = {
        let mut e = Elf::valid();
        e.phs.push(load_ph(LOAD + 0x1000, 0x100, 16, 0x2000, 6));
        e.bytes()
    };
    let mut x = 0x2545_f491_4f6c_dd1du64;
    let mut next = || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let mem = VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)]).unwrap();
    for _ in 0..10_000 {
        let mut b = base.clone();
        for _ in 0..(next() % 8 + 1) {
            let i = (next() as usize) % b.len();
            b[i] = next() as u8;
        }
        if next().is_multiple_of(4) {
            b.truncate((next() as usize) % b.len());
        }
        if let Ok(img) = parse(&b) {
            for s in &img.segments {
                assert!(RAM.contains(s.paddr, s.memsz));
            }
            elf::load(&img, &b, &mem).unwrap();
        }
    }
}

#[test]
fn valid_minimal_elf_loads() {
    let e = Elf::valid();
    let b = e.bytes();
    let img = parse(&b).unwrap();
    assert_eq!(img.entry, LOAD);
    assert_eq!(img.segments.len(), 1);
    let mem = VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)]).unwrap();
    // Dirty the BSS first: load must zero it.
    mem.write(GuestAddress(LOAD + 16), &[0xAA; 0x100]).unwrap();
    elf::load(&img, &b, &mem).unwrap();
    let mut got = [0u8; 0x110];
    mem.read(GuestAddress(LOAD), &mut got).unwrap();
    assert_eq!(&got[..16], &e.payload[..]);
    assert!(got[16..].iter().all(|&v| v == 0), "BSS zero-filled");

    // Through the plan, with a non-overlapping --raw blob too.
    let raw: Vec<(u64, Arc<[u8]>)> = vec![(0x4100_0000, Arc::from(&b"blob"[..]))];
    let inputs = BootInputs {
        kernel: Some(&b),
        raw: &raw,
        ..BootInputs::default()
    };
    let p = plan::plan(RAM, &inputs).unwrap();
    // x0 is the device tree's address, the start of RAM (M7, booting.rst §4).
    assert_eq!((p.entry, p.cpsr, p.x0), (LOAD, 0x3c5, RAM_BASE));
    assert_eq!(p.images.len(), 2);
    plan::load(&p, &inputs, &mem).unwrap();
    assert_eq!(
        mem.read_u32(GuestAddress(0x4100_0000)).unwrap(),
        u32::from_le_bytes(*b"blob")
    );
    assert!(p.to_string().contains("ELF segment 0"));
}

#[test]
fn bss_larger_than_zero_chunk_and_non_load_headers() {
    let mut e = Elf::valid();
    e.phs[0].memsz = 3 << 20; // 3 MiB of BSS: several zero chunks
    e.phs.insert(
        0,
        Ph {
            p_type: 4,
            flags: 0,
            offset: 0,
            vaddr: 0,
            paddr: 0,
            filesz: 0,
            memsz: 0,
        },
    );
    let b = e.bytes();
    let img = parse(&b).unwrap();
    assert_eq!(img.segments[0].index, 1);
    let mem = VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)]).unwrap();
    mem.write(GuestAddress(LOAD + (3 << 20) - 1), &[0xAA])
        .unwrap();
    elf::load(&img, &b, &mem).unwrap();
    assert_eq!(mem.read_u8(GuestAddress(LOAD + (3 << 20) - 1)).unwrap(), 0);
}

/// The real guest ELFs, when they have been built (`scripts/build-guests.sh`), load.
#[test]
fn built_guests_parse_when_present() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/guests/aarch64-unknown-none/release");
    for name in ["hello", "memtest", "mmio-poke", "exit-bench"] {
        if let Ok(b) = std::fs::read(dir.join(name)) {
            let img = parse(&b).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(img.entry, LOAD, "{name}");
        }
    }
}
