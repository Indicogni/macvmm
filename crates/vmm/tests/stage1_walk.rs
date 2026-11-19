//! Host test: the software stage-1 walk (`arch/stage1_walk.rs`, PLAN M17 acceptance; threat
//! model MMIO-5; course ch21, ch27).
//!
//! The page tables are built in a `VecMemory` by a small, independent builder below (ARM ARM
//! DDI 0487, D8.3 descriptor formats), then walked. Coverage: 4K at 3 and 4 levels, 16K at 3
//! and 4 levels, page and block descriptors, TTBR1 for high addresses, top-byte-ignore, and
//! the refusals (invalid descriptors, a table outside RAM, TxSZ out of range, 64K, LPA2, EPD,
//! IPS). The hostile half: a self-referencing table ends within the level bound, and 20,000
//! random tables/TCRs/VAs never panic and never read more than four descriptors.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::stage1_walk::{MAX_LEVELS, TranslationRegs, VaRange, WalkError, translate};
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};

const RAM: u64 = 0x4000_0000;
const RAM_SIZE: u64 = 8 << 20;

// TCR_EL1 fields (D19.2 TCR_EL1).
const IPS_48: u64 = 0b101 << 32;
const TG0_4K: u64 = 0b00 << 14;
const TG0_16K: u64 = 0b10 << 14;
const TG0_64K: u64 = 0b01 << 14;
const TG1_4K: u64 = 0b10 << 30;
const EPD0: u64 = 1 << 7;
const EPD1: u64 = 1 << 23;
const TBI0: u64 = 1 << 37;
const DS: u64 = 1 << 59;
const fn t0sz(n: u64) -> u64 {
    n
}
const fn t1sz(n: u64) -> u64 {
    n << 16
}

/// An independent page-table builder: a bump allocator of zeroed table pages in guest RAM.
struct Tables {
    mem: VecMemory,
    page: u64,
    stride: u32,
    va_bits: u32,
    next: u64,
}

impl Tables {
    fn new(page_shift: u32, va_bits: u32) -> Tables {
        let mem = VecMemory::new(&[(GuestAddress(RAM), RAM_SIZE)]).unwrap();
        Tables {
            mem,
            page: 1 << page_shift,
            stride: page_shift - 3,
            va_bits,
            next: RAM,
        }
    }

    fn alloc(&mut self) -> u64 {
        let t = self.next;
        self.next += self.page;
        assert!(self.next <= RAM + RAM_SIZE);
        t
    }

    fn shift(&self, level: u32) -> u32 {
        self.page.trailing_zeros() + self.stride * (3 - level)
    }

    fn start_level(&self) -> u32 {
        let resolved = self.va_bits - self.page.trailing_zeros();
        4 - resolved.div_ceil(self.stride)
    }

    /// Map `va` → `oa` with a leaf at `leaf_level` (3 = page, else block), under `root`.
    fn map(&mut self, root: u64, va: u64, oa: u64, leaf_level: u32) {
        let mut table = root;
        for level in self.start_level()..=leaf_level {
            let bits = (self.va_bits - self.shift(level)).min(self.stride);
            let idx = (va >> self.shift(level)) & ((1 << bits) - 1);
            let slot = GuestAddress(table + idx * 8);
            if level == leaf_level {
                let kind = if level == 3 { 0b11 } else { 0b01 };
                let af = 1 << 10;
                self.mem.write_u64(slot, oa | af | kind).unwrap();
                return;
            }
            let d = self.mem.read_u64(slot).unwrap();
            table = if d & 1 == 0 {
                let t = self.alloc();
                self.mem.write_u64(slot, t | 0b11).unwrap();
                t
            } else {
                d & 0x0000_ffff_ffff_f000 & !(self.page - 1)
            };
        }
    }
}

fn regs(tcr: u64, ttbr0: u64, ttbr1: u64) -> TranslationRegs {
    TranslationRegs {
        sctlr_el1: 1,
        tcr_el1: tcr,
        ttbr0_el1: ttbr0,
        ttbr1_el1: ttbr1,
    }
}

#[test]
fn mmu_off_is_identity() {
    let t = Tables::new(12, 48);
    let r = TranslationRegs {
        sctlr_el1: 0,
        tcr_el1: u64::MAX,
        ..Default::default()
    };
    for va in [0, 0x4008_0000, u64::MAX] {
        let tr = translate(&t.mem, &r, va).unwrap();
        assert_eq!((tr.ipa, tr.range), (va, None));
    }
}

#[test]
fn k4_four_levels_page() {
    let mut t = Tables::new(12, 48);
    let root = t.alloc();
    let va = 0x0000_1234_5678_9000;
    t.map(root, va, 0x0b00_0000, 3);
    let r = regs(IPS_48 | TG0_4K | t0sz(16), root, 0);
    let tr = translate(&t.mem, &r, va + 0xabc).unwrap();
    assert_eq!(tr.ipa, 0x0b00_0abc);
    assert_eq!(
        (tr.level, tr.mapping_size, tr.range),
        (3, 4096, Some(VaRange::Ttbr0))
    );
    // The neighbouring page is not mapped: an invalid level-3 descriptor.
    assert!(matches!(
        translate(&t.mem, &r, va + 0x1000),
        Err(WalkError::InvalidDescriptor { level: 3, desc: 0 })
    ));
}

#[test]
fn k4_three_levels_page_and_blocks() {
    // T0SZ = 25: 39-bit VAs, the walk starts at level 1.
    let mut t = Tables::new(12, 39);
    let root = t.alloc();
    t.map(root, 0x7f_ffff_f000, 0x4010_0000, 3);
    t.map(root, 0x40_0000_0000, 0x8000_0000, 1); // 1 GiB block
    t.map(root, 0x00_4020_0000, 0x4020_0000, 2); // 2 MiB block
    let r = regs(IPS_48 | TG0_4K | t0sz(25), root, 0);
    let tr = translate(&t.mem, &r, 0x7f_ffff_f123).unwrap();
    assert_eq!((tr.ipa, tr.level), (0x4010_0123, 3));
    let tr = translate(&t.mem, &r, 0x40_1234_5678).unwrap();
    assert_eq!(
        (tr.ipa, tr.level, tr.mapping_size),
        (0x9234_5678, 1, 1 << 30)
    );
    let tr = translate(&t.mem, &r, 0x00_402f_fff8).unwrap();
    assert_eq!(
        (tr.ipa, tr.level, tr.mapping_size),
        (0x402f_fff8, 2, 2 << 20)
    );
    // A VA above the 39-bit range in the TTBR0 half is out of range.
    assert_eq!(
        translate(&t.mem, &r, 0x80_0000_0000),
        Err(WalkError::VaOutOfRange { va: 0x80_0000_0000 })
    );
}

#[test]
fn k16_pages_and_blocks_at_three_and_four_levels() {
    // 48-bit VAs with 16K pages: 4 levels, level 0 has 2 entries.
    let mut t = Tables::new(14, 48);
    let root = t.alloc();
    let va = 0x0000_8765_4321_c000;
    t.map(root, va, 0x0a00_4000, 3);
    let r = regs(IPS_48 | TG0_16K | t0sz(16), root, 0);
    let tr = translate(&t.mem, &r, va + 0x3fff).unwrap();
    assert_eq!(
        (tr.ipa, tr.level, tr.mapping_size),
        (0x0a00_7fff, 3, 16 << 10)
    );

    // 47-bit VAs with 16K pages: 3 levels starting at level 1; a 32 MiB level-2 block.
    let mut t = Tables::new(14, 47);
    let root = t.alloc();
    t.map(root, 0x0000_1000_0200_0000, 0x4200_0000, 2);
    let r = regs(IPS_48 | TG0_16K | t0sz(17), root, 0);
    let tr = translate(&t.mem, &r, 0x0000_1000_03ff_fff0).unwrap();
    assert_eq!(
        (tr.ipa, tr.level, tr.mapping_size),
        (0x43ff_fff0, 2, 32 << 20)
    );
}

#[test]
fn ttbr1_for_high_addresses() {
    let mut t = Tables::new(12, 48);
    let lo = t.alloc();
    let hi = t.alloc();
    t.map(lo, 0x1000, 0x1000, 3);
    t.map(hi, 0xffff_0000_0000_1000, 0x4000_1000, 3);
    let r = regs(IPS_48 | TG0_4K | TG1_4K | t0sz(16) | t1sz(16), lo, hi);
    let tr = translate(&t.mem, &r, 0xffff_0000_0000_1234).unwrap();
    assert_eq!((tr.ipa, tr.range), (0x4000_1234, Some(VaRange::Ttbr1)));
    let tr = translate(&t.mem, &r, 0x1234).unwrap();
    assert_eq!((tr.ipa, tr.range), (0x1234, Some(VaRange::Ttbr0)));
    // A VA with bit 55 set but not all-ones above bit 48 is in neither range.
    assert!(matches!(
        translate(&t.mem, &r, 0x00ff_0000_0000_1000),
        Err(WalkError::VaOutOfRange { .. })
    ));
    // EPD1 disables the upper range only.
    let r = regs(
        IPS_48 | TG0_4K | TG1_4K | t0sz(16) | t1sz(16) | EPD1,
        lo,
        hi,
    );
    assert_eq!(
        translate(&t.mem, &r, 0xffff_0000_0000_1000),
        Err(WalkError::WalkDisabled {
            range: VaRange::Ttbr1
        })
    );
    assert!(translate(&t.mem, &r, 0x1000).is_ok());
}

#[test]
fn top_byte_ignore() {
    let mut t = Tables::new(12, 48);
    let root = t.alloc();
    t.map(root, 0x2000, 0x4000_2000, 3);
    let tagged = 0x5a00_0000_0000_2010;
    let r = regs(IPS_48 | TG0_4K | t0sz(16), root, 0);
    assert_eq!(
        translate(&t.mem, &r, tagged),
        Err(WalkError::VaOutOfRange { va: tagged })
    );
    let r = regs(IPS_48 | TG0_4K | t0sz(16) | TBI0, root, 0);
    assert_eq!(translate(&t.mem, &r, tagged).unwrap().ipa, 0x4000_2010);
}

#[test]
fn configuration_refusals() {
    let t = Tables::new(12, 48);
    let ok = IPS_48 | TG0_4K;
    let walk = |tcr: u64| translate(&t.mem, &regs(tcr, RAM, RAM), 0x1000);
    assert_eq!(
        walk(ok | t0sz(15)),
        Err(WalkError::TxSzOutOfRange {
            range: VaRange::Ttbr0,
            txsz: 15
        })
    );
    assert_eq!(
        walk(ok | t0sz(40)),
        Err(WalkError::TxSzOutOfRange {
            range: VaRange::Ttbr0,
            txsz: 40
        })
    );
    assert_eq!(
        walk(ok | t0sz(0)),
        Err(WalkError::TxSzOutOfRange {
            range: VaRange::Ttbr0,
            txsz: 0
        })
    );
    assert_eq!(
        walk(IPS_48 | TG0_64K | t0sz(16)),
        Err(WalkError::UnsupportedGranule {
            range: VaRange::Ttbr0,
            tg: 0b01
        })
    );
    assert_eq!(walk(ok | t0sz(16) | DS), Err(WalkError::Lpa2));
    assert_eq!(
        walk(ok | t0sz(16) | EPD0),
        Err(WalkError::WalkDisabled {
            range: VaRange::Ttbr0
        })
    );
    assert_eq!(
        walk((0b111 << 32) | TG0_4K | t0sz(16)),
        Err(WalkError::ReservedIps)
    );
    // TG1 = 00 is reserved (TTBR1's encoding differs from TG0's).
    let hi = translate(&t.mem, &regs(ok | t0sz(16) | t1sz(16), RAM, RAM), u64::MAX);
    assert_eq!(
        hi,
        Err(WalkError::UnsupportedGranule {
            range: VaRange::Ttbr1,
            tg: 0
        })
    );
}

#[test]
fn tables_outside_ram() {
    let mut t = Tables::new(12, 48);
    let r = regs(IPS_48 | TG0_4K | t0sz(16), 0x0900_0000, 0);
    assert_eq!(
        translate(&t.mem, &r, 0x1000),
        Err(WalkError::TableOutsideRam {
            level: 0,
            addr: 0x0900_0000
        })
    );
    // A level-0 table descriptor pointing at MMIO (a hostile next-level address).
    let root = t.alloc();
    t.mem
        .write_u64(GuestAddress(root), 0x0a00_0000 | 0b11)
        .unwrap();
    let r = regs(IPS_48 | TG0_4K | t0sz(16), root, 0);
    assert_eq!(
        translate(&t.mem, &r, 0x1000),
        Err(WalkError::TableOutsideRam {
            level: 1,
            addr: 0x0a00_0000
        })
    );
    // A table at the very end of RAM: index 511 of a table whose page is RAM's last.
    let last = RAM + RAM_SIZE - 0x1000;
    t.mem.write_u64(GuestAddress(root), last | 0b11).unwrap();
    assert!(matches!(
        translate(&t.mem, &r, 0x0000_007f_c000_0000),
        Err(WalkError::InvalidDescriptor { level: 1, desc: 0 })
    ));
}

#[test]
fn invalid_and_reserved_descriptors() {
    let mut t = Tables::new(12, 48);
    let root = t.alloc();
    let r = regs(IPS_48 | TG0_4K | t0sz(16), root, 0);
    // A block at level 0 is reserved with 4K and DS = 0.
    t.mem
        .write_u64(GuestAddress(root), 0x4000_0000 | 0b01)
        .unwrap();
    assert!(matches!(
        translate(&t.mem, &r, 0x1000),
        Err(WalkError::InvalidDescriptor { level: 0, .. })
    ));
    // bits[1:0] = 01 at level 3 is reserved.
    let mut t = Tables::new(12, 48);
    let root = t.alloc();
    t.map(root, 0x1000, 0x4000_1000, 3);
    let l3 = {
        let mut table = root;
        for _ in 0..3 {
            table = t.mem.read_u64(GuestAddress(table)).unwrap() & 0xffff_ffff_f000;
        }
        table
    };
    t.mem
        .write_u64(GuestAddress(l3 + 8), 0x4000_1000 | 0b01)
        .unwrap();
    let r = regs(IPS_48 | TG0_4K | t0sz(16), root, 0);
    assert!(matches!(
        translate(&t.mem, &r, 0x1000),
        Err(WalkError::InvalidDescriptor { level: 3, .. })
    ));
    // 16K: a level-1 block is reserved (blocks only at level 2).
    let mut t = Tables::new(14, 47);
    let root = t.alloc();
    t.mem
        .write_u64(GuestAddress(root), 0x4000_0000 | 0b01)
        .unwrap();
    let r = regs(IPS_48 | TG0_16K | t0sz(17), root, 0);
    assert!(matches!(
        translate(&t.mem, &r, 0x10),
        Err(WalkError::InvalidDescriptor { level: 1, .. })
    ));
}

#[test]
fn output_address_beyond_ips_is_an_address_size_fault() {
    let mut t = Tables::new(12, 48);
    let root = t.alloc();
    t.map(root, 0x1000, 0x1_0000_0000, 3); // needs 33 bits
    let r = regs(t0sz(16) | TG0_4K, root, 0); // IPS = 0: 32 bits
    assert!(matches!(
        translate(&t.mem, &r, 0x1000),
        Err(WalkError::AddressSize {
            level: 3,
            addr: 0x1_0000_0000
        })
    ));
    assert_eq!(
        translate(&t.mem, &regs(IPS_48 | t0sz(16) | TG0_4K, root, 0), 0x1000)
            .unwrap()
            .ipa,
        0x1_0000_0000
    );
}

/// PLAN M17 security test (MMIO-5): a table entry pointing at its own table terminates within
/// the level bound.
#[test]
fn self_referencing_table_terminates() {
    for (shift, tg) in [(12, TG0_4K), (14, TG0_16K)] {
        let mut t = Tables::new(shift, 48);
        let root = t.alloc();
        t.mem.write_u64(GuestAddress(root), root | 0b11).unwrap();
        let r = regs(IPS_48 | tg | t0sz(16), root, 0);
        let before = t.mem.reads();
        let tr = translate(&t.mem, &r, 0x10).unwrap();
        let reads = t.mem.reads() - before;
        assert!(reads <= MAX_LEVELS as usize, "{reads} descriptor reads");
        // The level-3 read reinterprets the entry as a page: the walk "maps" the table itself.
        assert_eq!((tr.ipa, tr.level), (root | 0x10, 3));
    }
}

fn xorshift(x: &mut u64) -> u64 {
    *x ^= *x >> 12;
    *x ^= *x << 25;
    *x ^= *x >> 27;
    x.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

/// PLAN M17 security test (MMIO-5): random descriptors, TCRs and VAs never panic, never read
/// more than `MAX_LEVELS` descriptors, and every success is consistent with the VA's offset.
#[test]
fn hostile_tables_property() {
    let seed: u64 = std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x5717_0a1c_0de5_eed5);
    let mut x = seed.max(1);
    let mem = VecMemory::new(&[(GuestAddress(RAM), 64 << 10)]).unwrap();
    let (mut ok, mut deepest) = (0u32, 0usize);
    for i in 0..20_000u32 {
        if i % 64 == 0 {
            // Refill RAM with descriptors that mostly point back into it (some valid tables,
            // blocks and pages, some garbage), so walks go deep.
            for off in (0..64u64 << 10).step_by(8) {
                let r = xorshift(&mut x);
                let d = match r % 4 {
                    0 => r,
                    _ => (RAM + (r >> 8) % (64 << 10)) & !0xfff | (r & 3) | 1,
                };
                mem.write_u64(GuestAddress(RAM + off), d).unwrap();
            }
        }
        let r = xorshift(&mut x);
        let tcr = match i % 3 {
            0 => r,
            1 => IPS_48 | TG0_4K | TG1_4K | t0sz(16 + r % 24) | t1sz(16 + (r >> 8) % 24),
            _ => IPS_48 | TG0_16K | (0b01 << 30) | t0sz(16 + r % 24) | t1sz(16 + (r >> 8) % 24),
        };
        let ttbr = RAM + (xorshift(&mut x) % (64 << 10));
        // Mostly in-range VAs (low for TTBR0, sign-extended high for TTBR1) so that walks
        // actually read descriptors; one in eight is a raw 64-bit value.
        let v = xorshift(&mut x);
        let low = v >> (16 + v % 24);
        let va = match v % 8 {
            0 => v,
            1..=4 => low,
            _ => !low,
        };
        let regs = regs(tcr, ttbr, ttbr ^ 0x800);
        let before = mem.reads();
        let res = translate(&mem, &regs, va);
        let reads = mem.reads() - before;
        assert!(
            reads <= MAX_LEVELS as usize,
            "seed {seed} iter {i}: {reads} reads"
        );
        deepest = deepest.max(reads);
        if let Ok(tr) = res {
            ok += 1;
            assert!(tr.level <= 3 && tr.mapping_size.is_power_of_two(), "{tr:?}");
            let off = tr.mapping_size - 1;
            assert_eq!(tr.ipa & off, va & off, "seed {seed} iter {i}");
            assert!(tr.ipa < 1 << 48);
        }
    }
    // The generator must exercise full-depth walks and successes, not only early refusals.
    assert_eq!(
        deepest, MAX_LEVELS as usize,
        "seed {seed}: no walk reached level 3"
    );
    assert!(ok > 100, "seed {seed}: only {ok} successful walks");
}
