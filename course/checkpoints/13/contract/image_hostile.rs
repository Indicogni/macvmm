// Checkpoint 13 contract (L1), frozen from the reference test crates/vmm/tests/image_hostile.rs.
// It names only items the chapter 13 lesson teaches; the harness runs it against your crates.
//! Hostile arm64 Image headers (PLAN M9 security test `image_hostile`, threat model LDR-3).
//!
//! Every header here is synthetic (no kernel binary is committed). Each malformed one must be a
//! typed `LoaderError`, never a panic and never a placement outside RAM; the last cases are
//! valid Alpine-like headers. booting.rst §4 is the specification.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;
use vmm::arch::layout::{LINUX_IMAGE_BASE, RAM_BASE};
use vmm::loader::image::{self, PageSize, parse_header};
use vmm::loader::plan::{self, BootInputs};
use vmm::loader::{LoaderError, RamRange};
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};

const RAM: RamRange = RamRange {
    base: RAM_BASE,
    size: 512 << 20,
};
/// Alpine 6.18.60-0-virt's `image_size`.
const ALPINE_IMAGE_SIZE: u64 = 0x22a_0000;

struct Hdr {
    text_offset: u64,
    image_size: u64,
    flags: u64,
    len: usize,
    magic: [u8; 4],
}

impl Hdr {
    fn alpine() -> Hdr {
        Hdr {
            text_offset: 0,
            image_size: ALPINE_IMAGE_SIZE,
            flags: 0b1010, // 4K pages, anywhere
            len: 4096,
            magic: *b"ARM\x64",
        }
    }
    fn bytes(&self) -> Vec<u8> {
        let mut b = vec![0u8; self.len.max(64)];
        b[0..4].copy_from_slice(&0x1400_0010u32.to_le_bytes()); // b +0x40
        b[8..16].copy_from_slice(&self.text_offset.to_le_bytes());
        b[16..24].copy_from_slice(&self.image_size.to_le_bytes());
        b[24..32].copy_from_slice(&self.flags.to_le_bytes());
        b[56..60].copy_from_slice(&self.magic);
        b.truncate(self.len);
        b
    }
}

fn place(h: &Hdr) -> Result<image::ArmImage, LoaderError> {
    image::place(&h.bytes(), RAM)
}

#[test]
fn file_under_64_bytes() {
    for len in [0, 1, 56, 60, 63] {
        let b = Hdr {
            len,
            ..Hdr::alpine()
        }
        .bytes();
        assert_eq!(
            parse_header(&b),
            Err(LoaderError::ImageTooShort { len: len as u64 }),
            "{len}"
        );
    }
}

#[test]
fn bad_magic() {
    let h = Hdr {
        magic: *b"ARM\x65",
        ..Hdr::alpine()
    };
    assert_eq!(place(&h), Err(LoaderError::ImageBadMagic));
    let h = Hdr {
        magic: [0; 4],
        ..Hdr::alpine()
    };
    assert_eq!(parse_header(&h.bytes()), Err(LoaderError::ImageBadMagic));
}

#[test]
fn big_endian_flag() {
    let h = Hdr {
        flags: 0b1011,
        ..Hdr::alpine()
    };
    assert_eq!(place(&h), Err(LoaderError::ImageBigEndian));
}

#[test]
fn page_size_64k_refused() {
    let h = Hdr {
        flags: 0b110,
        ..Hdr::alpine()
    };
    assert_eq!(place(&h), Err(LoaderError::ImagePageSize { field: 3 }));
}

#[test]
fn page_sizes_0_1_2_accepted() {
    for (flags, want) in [
        (0b000, PageSize::Unspecified),
        (0b010, PageSize::K4),
        (0b100, PageSize::K16),
    ] {
        let h = Hdr {
            flags,
            ..Hdr::alpine()
        };
        assert_eq!(place(&h).unwrap().header.page_size, want);
    }
}

#[test]
fn image_size_zero_is_pre_3_17() {
    let h = Hdr {
        image_size: 0,
        ..Hdr::alpine()
    };
    assert_eq!(place(&h), Err(LoaderError::ImageZeroSize));
}

#[test]
fn image_size_u64_max() {
    let h = Hdr {
        image_size: u64::MAX,
        ..Hdr::alpine()
    };
    assert!(matches!(place(&h), Err(LoaderError::OutsideRam { .. })));
}

#[test]
fn text_offset_unaligned() {
    for t in [1, 0x800, 0x80001] {
        let h = Hdr {
            text_offset: t,
            ..Hdr::alpine()
        };
        assert_eq!(
            place(&h),
            Err(LoaderError::ImageTextOffset { text_offset: t })
        );
    }
}

#[test]
fn text_offset_overflow() {
    let h = Hdr {
        text_offset: !0xfff,
        ..Hdr::alpine()
    };
    assert!(matches!(place(&h), Err(LoaderError::OutsideRam { .. })));
}

#[test]
fn load_plus_size_beyond_ram() {
    // Exactly to the end of RAM is fine; one 4 KiB page more is not.
    let fits = RAM.base + RAM.size - LINUX_IMAGE_BASE;
    let h = Hdr {
        image_size: fits,
        ..Hdr::alpine()
    };
    assert_eq!(place(&h).unwrap().end, RAM.base + RAM.size);
    let h = Hdr {
        image_size: fits + 1,
        ..Hdr::alpine()
    };
    assert!(matches!(place(&h), Err(LoaderError::OutsideRam { .. })));
    let h = Hdr {
        text_offset: 0x1000,
        image_size: fits,
        ..Hdr::alpine()
    };
    assert!(matches!(place(&h), Err(LoaderError::OutsideRam { .. })));
}

#[test]
fn file_longer_than_image_size() {
    let h = Hdr {
        image_size: 4095,
        ..Hdr::alpine()
    };
    assert_eq!(
        place(&h),
        Err(LoaderError::ImageFileTooLong {
            file_len: 4096,
            image_size: 4095
        })
    );
}

#[test]
fn reserved_flag_bits_are_ignored() {
    let h = Hdr {
        flags: 0xffff_fff0 | 0b010,
        ..Hdr::alpine()
    };
    assert!(place(&h).is_ok());
}

#[test]
fn zboot_and_image_detection_through_the_plan() {
    let mut zboot = b"MZ\0\0zimg".to_vec();
    zboot.resize(64, 0);
    let inputs = BootInputs {
        kernel: Some(&zboot),
        ..BootInputs::default()
    };
    let e = plan::plan(RAM, &inputs).unwrap_err();
    assert_eq!(e, LoaderError::EfiZboot);
    assert!(e.to_string().starts_with("EFI zboot image"), "{e}");
}

#[test]
fn initrd_and_cmdline_are_linux_only() {
    let elf = b"\x00\x00\x00\x14".to_vec();
    let raw: Vec<(u64, Arc<[u8]>)> = vec![(RAM_BASE + (1 << 20), Arc::from(&elf[..]))];
    let rd = [1u8; 16];
    let inputs = BootInputs {
        raw: &raw,
        initrd: Some(&rd),
        ..BootInputs::default()
    };
    assert_eq!(
        plan::plan(RAM, &inputs),
        Err(LoaderError::LinuxOnly { what: "--initrd" })
    );
    let inputs = BootInputs {
        raw: &raw,
        cmdline: Some("quiet"),
        ..BootInputs::default()
    };
    assert_eq!(
        plan::plan(RAM, &inputs),
        Err(LoaderError::LinuxOnly { what: "--cmdline" })
    );
}

#[test]
fn bad_cmdline() {
    let b = Hdr::alpine().bytes();
    let long = "x".repeat(2048);
    for c in [long.as_str(), "console=ttyAMA0\0rdinit=/evil"] {
        let inputs = BootInputs {
            kernel: Some(&b),
            cmdline: Some(c),
            ..BootInputs::default()
        };
        assert!(matches!(
            plan::plan(RAM, &inputs),
            Err(LoaderError::BadCmdline { .. })
        ));
    }
}

#[test]
fn empty_initrd() {
    let b = Hdr::alpine().bytes();
    let inputs = BootInputs {
        kernel: Some(&b),
        initrd: Some(&[]),
        ..BootInputs::default()
    };
    assert_eq!(plan::plan(RAM, &inputs), Err(LoaderError::InitrdEmpty));
}

/// The valid case: an Alpine-like header plans, loads and prints like PLAN §1.
#[test]
fn valid_alpine_like_header() {
    let h = Hdr::alpine();
    let b = h.bytes();
    let img = place(&h).unwrap();
    assert_eq!((img.load, img.end), (LINUX_IMAGE_BASE, 0x424a_0000));
    let rd = vec![7u8; 9 << 20];
    let inputs = BootInputs {
        kernel: Some(&b),
        initrd: Some(&rd),
        ..BootInputs::default()
    };
    let p = plan::plan(RAM, &inputs).unwrap();
    assert_eq!((p.entry, p.x0, p.cpsr), (0x4020_0000, RAM_BASE, 0x3c5));
    assert_eq!(p.initrd, Some((0x4260_0000, 0x4260_0000 + (9 << 20))));
    assert_eq!(
        p.bootargs.as_deref(),
        Some("console=ttyAMA0 earlycon=pl011,0x09000000")
    );
    let mem = VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)]).unwrap();
    plan::load(&p, &inputs, &mem).unwrap();
    assert_eq!(
        mem.read_u32(GuestAddress(0x4020_0000)).unwrap(),
        0x1400_0010
    );
    assert_eq!(
        mem.read_u32(GuestAddress(0x4260_0000)).unwrap(),
        0x0707_0707
    );
    // A mismatched initrd at load time (not the bytes that were planned) is refused.
    let other = vec![7u8; 10];
    let wrong = BootInputs {
        initrd: Some(&other),
        ..inputs
    };
    assert!(plan::load(&p, &wrong, &mem).is_err());
}

/// Random corruption of a valid header never panics, and every accepted header lies in RAM.
#[test]
fn random_headers_never_panic() {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = || {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    };
    let base = Hdr::alpine().bytes();
    for _ in 0..20_000 {
        let mut b = base[..64].to_vec();
        for _ in 0..(next() % 6 + 1) {
            let i = (next() as usize) % b.len();
            b[i] = next() as u8;
        }
        if next() % 3 == 0 {
            b.truncate((next() as usize) % 65);
        }
        if let Ok(img) = image::place(&b, RAM) {
            assert!(RAM.contains(img.load, img.header.image_size));
            assert!(img.file_len <= img.header.image_size);
        }
    }
}
