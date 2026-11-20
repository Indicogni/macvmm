//! The Linux `BootPlan` (PLAN M9 acceptance `bootplan`, threat model LDR-5).
//!
//! `plan()` is pure, so its whole contract can be checked here without HVF: the PLAN §1
//! numbers for Alpine, the RAM and booting.rst §4 window limits, and a deterministic property
//! test over 10,000 random size combinations (seed printed on failure; `MACVMM_SEED=<n>`
//! replays one).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::layout::{DTB_MAX, LINUX_IMAGE_BASE, RAM_ALIGN, RAM_BASE, RAM_MAX, RAM_MIN};
use vmm::loader::plan::{self, BootInputs};
use vmm::loader::{LoaderError, RamRange, initrd, overlaps};

fn image(text_offset: u64, image_size: u64, len: usize) -> Vec<u8> {
    let mut b = vec![0u8; len.max(64)];
    b[8..16].copy_from_slice(&text_offset.to_le_bytes());
    b[16..24].copy_from_slice(&image_size.to_le_bytes());
    b[24..32].copy_from_slice(&0b1010u64.to_le_bytes());
    b[56..60].copy_from_slice(b"ARM\x64");
    b
}

fn ram(size: u64) -> RamRange {
    RamRange {
        base: RAM_BASE,
        size,
    }
}

/// PLAN M9: Alpine numbers give exactly a kernel at `0x40200000..0x424a0000` and an initrd at
/// `0x42600000`, and the printed plan has the `--dry-run` rows.
#[test]
fn alpine_numbers() {
    let k = image(0, 0x22a_0000, 4096);
    let rd = vec![0u8; 9_000_000];
    let p = plan::plan(
        ram(512 << 20),
        &BootInputs {
            kernel: Some(&k),
            initrd: Some(&rd),
            ..BootInputs::default()
        },
    )
    .unwrap();
    let img = p.image.unwrap();
    assert_eq!((img.load, img.end), (0x4020_0000, 0x424a_0000));
    assert_eq!(p.initrd, Some((0x4260_0000, 0x4260_0000 + 9_000_000)));
    assert_eq!((p.entry, p.x0, p.cpsr), (0x4020_0000, 0x4000_0000, 0x3c5));
    assert_eq!(p.dtb_limit, DTB_MAX);
    let mut p = p;
    p.set_dtb_len(1700).unwrap();
    let text = p.to_string();
    for want in [
        "kernel  0x40200000..0x424a0000",
        "initrd  0x42600000..",
        "dtb     0x40000000",
        "entry   pc=0x40200000 x0=0x40000000 cpsr=0x3c5",
        "cmdline \"console=ttyAMA0 earlycon=pl011,0x09000000\"",
    ] {
        assert!(text.contains(want), "missing {want:?} in\n{text}");
    }
    // An explicit --cmdline replaces the default.
    let p = plan::plan(
        ram(512 << 20),
        &BootInputs {
            kernel: Some(&k),
            cmdline: Some("console=ttyAMA0 macvmm.test=boot"),
            ..BootInputs::default()
        },
    )
    .unwrap();
    assert_eq!(
        p.bootargs.as_deref(),
        Some("console=ttyAMA0 macvmm.test=boot")
    );
    assert_eq!(p.initrd, None);
}

#[test]
fn initrd_too_large_for_ram() {
    let k = image(0, 0x22a_0000, 64);
    // 64 MiB of RAM: the initrd starts at 0x4260_0000; 0x1a0_0000 bytes are left.
    let left = RAM_BASE + RAM_MIN - 0x4260_0000;
    for (size, ok) in [(left, true), (left + 1, false), (RAM_MIN, false)] {
        let rd = vec![0u8; size as usize];
        let r = plan::plan(
            ram(RAM_MIN),
            &BootInputs {
                kernel: Some(&k),
                initrd: Some(&rd),
                ..BootInputs::default()
            },
        );
        assert_eq!(r.is_ok(), ok, "{size:#x}: {r:?}");
        if !ok {
            assert!(matches!(r, Err(LoaderError::OutsideRam { .. })));
        }
    }
}

/// booting.rst §4: kernel and initrd within one 1 GiB-aligned window of at most 32 GiB. With
/// 64 GiB of RAM a 33 GiB initrd fits RAM but not the window. (`initrd::place` is tested
/// directly: a 33 GiB host buffer is not something a test should allocate.)
#[test]
fn one_gib_window_rule() {
    let r = ram(64 << 30);
    let kstart = LINUX_IMAGE_BASE;
    let kend = LINUX_IMAGE_BASE + 0x22a_0000;
    let istart = 0x4260_0000u64;
    // Window base is RAM_BASE (1 GiB-aligned); the initrd may end at RAM_BASE + 32 GiB.
    let max = RAM_BASE + (32 << 30) - istart;
    assert_eq!(
        initrd::place(r, kstart, kend, max),
        Ok((istart, RAM_BASE + (32 << 30)))
    );
    assert_eq!(
        initrd::place(r, kstart, kend, max + 1),
        Err(LoaderError::InitrdWindow {
            start: istart,
            end: RAM_BASE + (32 << 30) + 1
        })
    );
    assert!(initrd::check_window(kstart, kend, istart, istart + 1).is_ok());
    // A kernel just below a 1 GiB boundary shifts the window base down to that boundary.
    let g = 1u64 << 30;
    assert!(initrd::check_window(2 * g - 4096, 2 * g, 2 * g, g + (32 << 30)).is_ok());
    assert!(initrd::check_window(2 * g - 4096, 2 * g, 2 * g, g + (32 << 30) + 1).is_err());
    assert_eq!(
        initrd::place(r, kstart, kend, 0),
        Err(LoaderError::InitrdEmpty)
    );
    assert!(initrd::place(r, kstart, u64::MAX - 5, 1).is_err());
}

/// xorshift64* (Vigna 2016), PLAN §0.3.
struct XorShift(u64);
impl XorShift {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// LDR-5: over 10,000 random (RAM, text_offset, image_size, file length, initrd size)
/// combinations, every accepted plan keeps the DTB slot, kernel and initrd inside RAM, pairwise
/// disjoint, the initrd 2 MiB-aligned and inside the booting.rst window; and every refusal is a
/// typed error (no panic). The initrd is planned with `initrd::place` on the same numbers the
/// plan would use, so no large host buffer is needed; 1 in 8 iterations goes through
/// `plan::plan` with a real (small) initrd.
#[test]
fn property_no_overlap_nothing_outside_ram() {
    let seed: u64 = std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x6d61_6376_6d6d_0009);
    let mut rng = XorShift(seed.max(1));
    let mut accepted = 0u32;
    for iter in 0..10_000u32 {
        let ram_size = match rng.below(4) {
            0 => RAM_MIN,
            1 => (rng.below(1024) + 32) * RAM_ALIGN,
            2 => (rng.below(RAM_MAX / RAM_ALIGN) + 1) * RAM_ALIGN,
            _ => 512 << 20,
        }
        .clamp(RAM_MIN, RAM_MAX);
        let r = ram(ram_size);
        let text_offset = match rng.below(4) {
            0 => 0,
            1 => 0x8_0000,
            2 => rng.below(1 << 20) & !0xfff,
            _ => rng.next() & !0xfff,
        };
        let image_size = match rng.below(4) {
            0 => rng.below(64 << 20) + 64,
            1 => rng.below(ram_size) + 64,
            2 => rng.next(),
            _ => 0x22a_0000,
        };
        let file_len = 64 + rng.below(256) as usize;
        let rd_size = match rng.below(4) {
            0 => rng.below(16 << 20) + 1,
            1 => rng.below(ram_size) + 1,
            2 => rng.next(),
            _ => rng.below(256) + 1,
        };
        let k = image(text_offset, image_size, file_len);
        let ctx = || {
            format!(
                "seed {seed} iter {iter}: ram {ram_size:#x} text_offset {text_offset:#x} \
                 image_size {image_size:#x} file {file_len} initrd {rd_size:#x}"
            )
        };
        let small = rng.below(8) == 0;
        let rd = vec![0u8; (rd_size % 4096 + 1) as usize];
        let inputs = BootInputs {
            kernel: Some(&k),
            initrd: if small { Some(&rd) } else { None },
            ..BootInputs::default()
        };
        let Ok(p) = plan::plan(r, &inputs) else {
            continue;
        };
        let img = p.image.unwrap();
        let (istart, iend) = if small {
            p.initrd.unwrap_or_else(|| panic!("{}", ctx()))
        } else {
            match initrd::place(r, img.load, img.end, rd_size) {
                Ok(x) => x,
                Err(_) => continue,
            }
        };
        // ANCHOR: bootplan_property_asserts
        accepted += 1;
        let ilen = iend - istart;
        let dtb = (RAM_BASE, DTB_MAX);
        let kernel = (img.load, img.header.image_size);
        assert!(r.contains(dtb.0, dtb.1.min(ram_size)), "{}", ctx());
        assert!(
            r.contains(kernel.0, kernel.1),
            "kernel outside RAM: {}",
            ctx()
        );
        assert!(r.contains(istart, ilen), "initrd outside RAM: {}", ctx());
        assert!(!overlaps(dtb.0, dtb.1, kernel.0, kernel.1), "{}", ctx());
        assert!(!overlaps(dtb.0, dtb.1, istart, ilen), "{}", ctx());
        assert!(!overlaps(kernel.0, kernel.1, istart, ilen), "{}", ctx());
        assert_eq!(istart % RAM_ALIGN, 0, "{}", ctx());
        assert!(
            initrd::check_window(kernel.0, img.end, istart, iend).is_ok(),
            "{}",
            ctx()
        );
        assert_eq!(p.entry, img.load);
        assert!(p.dtb_limit <= DTB_MAX && p.dtb_limit > 0);
        // ANCHOR_END: bootplan_property_asserts
    }
    assert!(
        accepted > 1000,
        "only {accepted} accepted plans (seed {seed})"
    );
}
