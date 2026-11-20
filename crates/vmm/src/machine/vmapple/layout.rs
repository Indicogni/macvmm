//! The `vmapple` memory map (architecture §5.2, ADR-0008 decision 3; PLAN M21).
//!
//! **Why a second map.** The `virt` board (`arch/layout.rs`) copies QEMU `virt` so that stock
//! firmware finds its devices. Apple's macOS-guest boot ROM, AVPBooter, was built for the
//! board Virtualization.framework emulates, and expects devices somewhere else entirely. The
//! values below are **facts**, not code, taken from `docs/research/macos-guest.md` §3.1, which
//! cites QEMU's public `hw/vmapple/vmapple.c` (`memmap[]`, QEMU v10.0.0) and its documentation
//! `docs/system/arm/vmapple.rst`. No QEMU code or prose is copied (GPL-2.0-or-later, ADR-0008
//! decision 4), and nothing here came from disassembling Apple code (D4, ADR-0009). We have
//! verified only that `hv_gic_create` accepts the two GIC bases `[verified-on-machine]`; every
//! other row is `[V-src]` until an observed access confirms it.
//!
//! **What S1 populates** (PLAN M21): RAM, the AVPBooter ROM (mapped read+execute), the
//! in-kernel GIC and the PL011. Every other row is documentation: an access there goes to the
//! unknown-MMIO logger (`unknown.rs`), which names the row it fell in. The rows exist so the
//! log can say "cfg" or "bdif" rather than a bare address, and so that S2 adds a device by
//! changing `kind`, not by inventing an address.
//!
//! This file and `arch/layout.rs` are the only two places where layout addresses may appear as
//! literals (`cargo xtask audit`, rule `layout-literal`).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::layout::{Layout, MachineProfile, Region, RegionKind};

// ANCHOR: vmapple_layout
/// AVPBooter's load and entry address. The CPU starts here, at EL1, with the MMU off.
pub const ROM_BASE: u64 = 0x0010_0000;
/// The ROM window: 1 MiB (AVPBooter.vmapple2.bin is about 335 KB on macOS 27.2).
pub const ROM_SIZE: u64 = 0x0010_0000;
/// The configuration block VZ fills in (ECID, serial, RAM size, ...): not modelled yet.
pub const CFG_BASE: u64 = 0x0040_0000;
pub const GICD_BASE: u64 = 0x1000_0000;
pub const GICD_SIZE: u64 = 0x0001_0000;
pub const GICR_BASE: u64 = 0x1001_0000;
/// Room for the redistributor frames; HVF implements one 128 KiB frame per vCPU at the base.
pub const GICR_WINDOW: u64 = 0x0040_0000;
pub const PL011_BASE: u64 = 0x2001_0000;
/// SPI 1 → INTID 33, as on `virt`.
pub const PL011_INTID: u32 = 33;
pub const PL031_BASE: u64 = 0x2005_0000;
pub const PL061_BASE: u64 = 0x2006_0000;
pub const PVPANIC_BASE: u64 = 0x2007_0000;
/// The "backdoor" block interface iBoot reads its disks through (not modelled yet).
pub const BDIF_BASE: u64 = 0x3000_0000;
/// RAM. AVPBooter is told nothing about its size here (no DTB, no cfg block).
pub const RAM_BASE: u64 = 0x7000_0000;

use RegionKind::*;
/// Every non-RAM row of the vmapple board, sorted by base.
#[rustfmt::skip]
pub const VMAPPLE_REGIONS: &[Region] = &[
    Region { name: "avpbooter", base: ROM_BASE,     size: ROM_SIZE,    kind: Rom,       intid: None },
    Region { name: "cfg",       base: CFG_BASE,     size: 0x0001_0000, kind: Reserved,  intid: None },
    Region { name: "gicd",      base: GICD_BASE,    size: GICD_SIZE,   kind: GicDist,   intid: None },
    Region { name: "gicr",      base: GICR_BASE,    size: GICR_WINDOW, kind: GicRedist, intid: None },
    Region { name: "pl011",     base: PL011_BASE,   size: 0x0001_0000, kind: Mmio,      intid: Some(PL011_INTID) },
    Region { name: "pl031",     base: PL031_BASE,   size: 0x1000,      kind: Reserved,  intid: Some(34) },
    Region { name: "pl061",     base: PL061_BASE,   size: 0x1000,      kind: Reserved,  intid: Some(37) },
    Region { name: "pvpanic",   base: PVPANIC_BASE, size: 0x2,         kind: Reserved,  intid: None },
    Region { name: "bdif",      base: BDIF_BASE,    size: 0x0020_0000, kind: Reserved,  intid: None },
];
// ANCHOR_END: vmapple_layout

static VMAPPLE: Layout = Layout {
    profile: MachineProfile::VmApple,
    regions: VMAPPLE_REGIONS,
};

/// The vmapple board.
pub fn vmapple() -> &'static Layout {
    &VMAPPLE
}

/// The RAM window of `size` bytes, or `None` if its end overflows. The size itself was checked
/// by `VmConfig::validate` (64 MiB..=255 GiB, a multiple of 2 MiB).
pub fn ram_end(size: u64) -> Option<u64> {
    RAM_BASE.checked_add(size)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;

    /// The same invariants `layout_invariants.rs` proves for `virt` (architecture §5.3).
    #[test]
    fn sorted_disjoint_aligned_and_below_ram() {
        for w in VMAPPLE_REGIONS.windows(2) {
            assert!(w[0].end() <= w[1].base, "{:?} overlaps {:?}", w[0], w[1]);
        }
        assert!(VMAPPLE_REGIONS.last().unwrap().end() <= RAM_BASE);
        for r in VMAPPLE_REGIONS {
            if r.kind.may_be_mapped() {
                assert_eq!(r.base % 0x4000, 0, "{} base not 16 KiB-aligned", r.name);
                assert_eq!(r.size % 0x4000, 0, "{} size not 16 KiB-aligned", r.name);
            }
            if let Some(i) = r.intid {
                assert!((32..1020).contains(&i), "{} INTID {i}", r.name);
            }
        }
        // The GIC frames: 64 KiB distributor, then the redistributor window right after it.
        assert_eq!(GICD_BASE + GICD_SIZE, GICR_BASE);
        // The entry point is the first byte of the ROM.
        assert_eq!(vmapple().find(ROM_BASE).map(|r| r.name), Some("avpbooter"));
        assert_eq!(vmapple().find(RAM_BASE), None);
        // 4 GiB of RAM ends at 0x1_7000_0000: a 36-bit IPA space is enough.
        assert_eq!(vmapple().ipa_bits_needed(ram_end(4 << 30).unwrap()), 36);
        assert_eq!(ram_end(u64::MAX), None);
    }
}
