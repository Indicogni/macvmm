//! The machine memory map: the single source of truth for every guest-physical address
//! (architecture §5, PLAN §1, ADR-0003).
//!
//! **Why QEMU `virt`'s map.** Stock firmware (U-Boot `qemu_arm64`, EDK2 ArmVirtQemu) and stock
//! kernels hard-code or probe these addresses (QEMU `hw/arm/virt.c`, `base_memmap[]`), so
//! mirroring them lets them boot unmodified. Every other module asks this one; `cargo xtask
//! audit` refuses the well-known layout addresses as hex literals anywhere else (architecture
//! §4), so a lesson that changes an address changes it here and nowhere else.
//!
//! **The table is the full board**, including regions whose devices arrive later (PL011 in
//! M6, virtio in M11, flash in M18) and regions that are only *reserved* (QEMU's GICv2 CPU
//! interface, ITS, fw_cfg, PCIe windows). Listing them now means overlaps are caught by
//! `layout_invariants.rs` today, a guest access to a reserved hole can be named in a log, and a
//! lesson can show the whole board at once.
//!
//! **What "mapped" means.** Stage 2 (ARM ARM D8.1, "the stage 2 translation") only covers RAM,
//! flash (with `--bios`) and the in-kernel GIC frames that HVF services. Everything else is left
//! unmapped on purpose, so each guest access is a data abort to EL2 that the VMM emulates
//! (architecture §8.3). Mapped regions must be 16 KiB-aligned (the default stage-2 granule,
//! `docs/research/hvf-api.md` §5); trapped ones may be any size (PL011 is 4 KiB, a virtio slot
//! 0x200 bytes).
//!
//! **Interrupts.** SPI *n* is INTID 32 + *n* (GIC architecture specification, IHI 0069, §2.2
//! "INTIDs"); SPIs are INTIDs 32..=1019. Every device line is level-high, encoded in the DT as
//! `<0 n 4>` (Linux `Documentation/devicetree/bindings/interrupt-controller/arm,gic-v3.yaml`).
//! A region with one line carries it in [`Region::intid`]. Lines that come as a *block* (the four
//! PCIe INTx lines, the 64 SPIs a GICv2m frame hands out as MSIs) are in [`RESERVED_INTIDS`],
//! so `layout_invariants.rs` refuses a later device whose INTID falls inside one, even though
//! nothing uses those blocks yet (QEMU `hw/arm/virt.c`, `a15irqmap[]` and `NUM_GICV2M_SPIS`).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use core::fmt;

/// Which board is being built (architecture §5.3). `VmApple` (M21) exists only with the
/// `experimental-vmapple` feature (ADR-0008 decision 3); its map is `machine/vmapple/layout.rs`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MachineProfile {
    Virt,
    #[cfg(feature = "experimental-vmapple")]
    VmApple,
}

/// What a region is, which decides how the VMM treats an access to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionKind {
    /// Guest RAM, mapped RWX at stage 2. Not in [`VIRT_REGIONS`]: its size comes from `--mem`.
    Ram,
    /// Flash: mapped RX with `--bios` (bank 0 the image, bank 1 empty; M18), else unmapped.
    Rom,
    /// In-kernel GIC distributor (HVF services it, no exits).
    GicDist,
    /// In-kernel GIC redistributors, `ncpus` frames of 128 KiB; the rest of the window is RAZ/WI.
    GicRedist,
    /// GICv2m MSI frame (in-kernel, only with PCI, post-v1).
    GicMsi,
    /// Trapped device window: every access exits to the VMM.
    Mmio,
    /// Reserved or never populated: an access is unhandled MMIO.
    Reserved,
}

impl RegionKind {
    /// True if regions of this kind can ever be stage-2 mapped (and so must be 16 KiB-aligned).
    pub const fn may_be_mapped(self) -> bool {
        matches!(
            self,
            RegionKind::Ram
                | RegionKind::Rom
                | RegionKind::GicDist
                | RegionKind::GicRedist
                | RegionKind::GicMsi
        )
    }
}

// ANCHOR: layout_virt_regions
/// One row of the map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub name: &'static str,
    pub base: u64,
    pub size: u64,
    pub kind: RegionKind,
    /// The region's interrupt as an INTID, where it has one.
    pub intid: Option<u32>,
}

pub const FLASH0_BASE: u64 = 0x0000_0000;
pub const FLASH1_BASE: u64 = 0x0400_0000;
pub const FLASH_BANK_SIZE: u64 = 0x0400_0000;
/// Both flash banks (M18): one read+execute `RomRegion` from `FLASH0_BASE`. Bank 1 must be
/// readable because U-Boot `qemu_arm64` reads its environment memory-mapped from
/// `CONFIG_ENV_ADDR = 0x0400_0000` before any driver probes (observed, `docs/compat/uboot.md`).
pub const FLASH_SIZE: u64 = 0x0800_0000;
pub const GICD_BASE: u64 = 0x0800_0000;
pub const GICD_SIZE: u64 = 0x0001_0000;
pub const GIC_MSI_BASE: u64 = 0x0802_0000;
pub const GICR_BASE: u64 = 0x080A_0000;
pub const PL011_BASE: u64 = 0x0900_0000;
pub const PL011_INTID: u32 = 33; // SPI 1
pub const PL031_BASE: u64 = 0x0901_0000;
pub const PL031_INTID: u32 = 34; // SPI 2
pub const VIRTIO_MMIO_BASE: u64 = 0x0a00_0000;
pub const TESTDEV_BASE: u64 = 0x0b00_0000;
/// The never-populated hole that `guests/mmio-poke` stores into.
pub const PROBE_HOLE_BASE: u64 = 0x0c00_0000;
pub const RAM_BASE: u64 = 0x4000_0000;

use RegionKind::*;
/// Every region of the `virt` board except RAM, sorted by base (PLAN §1, one row per line).
#[rustfmt::skip]
pub const VIRT_REGIONS: &[Region] = &[
    Region { name: "flash0",      base: FLASH0_BASE,      size: FLASH_BANK_SIZE, kind: Rom,       intid: None },
    Region { name: "flash1",      base: FLASH1_BASE,      size: FLASH_BANK_SIZE, kind: Rom,       intid: None },
    Region { name: "gicd",        base: GICD_BASE,        size: GICD_SIZE,       kind: GicDist,   intid: None },
    Region { name: "gicv2-cpu",   base: 0x0801_0000,      size: 0x0001_0000,     kind: Reserved,  intid: None },
    Region { name: "gic-v2m",     base: GIC_MSI_BASE,     size: 0x0001_0000,     kind: GicMsi,    intid: None },
    Region { name: "gic-its",     base: 0x0808_0000,      size: 0x0002_0000,     kind: Reserved,  intid: None },
    Region { name: "gicr",        base: GICR_BASE,        size: 0x00F6_0000,     kind: GicRedist, intid: None },
    Region { name: "pl011",       base: PL011_BASE,       size: 0x1000,          kind: Mmio,      intid: Some(PL011_INTID) },
    Region { name: "pl031",       base: PL031_BASE,       size: 0x1000,          kind: Mmio,      intid: Some(PL031_INTID) },
    Region { name: "fw-cfg",      base: 0x0902_0000,      size: 0x18,            kind: Reserved,  intid: None },
    Region { name: "pl061",       base: 0x0903_0000,      size: 0x1000,          kind: Reserved,  intid: Some(39) },
    Region { name: "virtio-mmio", base: VIRTIO_MMIO_BASE, size: 0x4000,          kind: Mmio,      intid: None },
    Region { name: "testdev",     base: TESTDEV_BASE,     size: 0x1000,          kind: Mmio,      intid: None },
    Region { name: "probe-hole",  base: PROBE_HOLE_BASE,  size: 0x0200_0000,     kind: Reserved,  intid: None },
    Region { name: "pcie-mmio",   base: 0x1000_0000,      size: 0x2eff_0000,     kind: Reserved,  intid: None },
    Region { name: "pcie-pio",    base: 0x3eff_0000,      size: 0x0001_0000,     kind: Reserved,  intid: None },
    Region { name: "pcie-ecam",   base: 0x3f00_0000,      size: 0x0100_0000,     kind: Reserved,  intid: None },
];
// ANCHOR_END: layout_virt_regions

/// One redistributor (RD_base + SGI_base frames), 128 KiB (GICv3 spec IHI 0069, §12.10
/// "The GIC Redistributor register map").
pub const GICR_FRAME_SIZE: u64 = 0x0002_0000;
/// The redistributor window ends where the PL011 begins; unclaimed frames are RAZ/WI.
pub const GICR_WINDOW_END: u64 = PL011_BASE;
/// The most vCPUs the `virt` board describes (architecture §5.1: 64 × 128 KiB = 8 MiB of
/// redistributors, well inside the 0xF6_0000-byte window).
pub const MAX_CPUS: u32 = 64;
pub const VIRTIO_MMIO_STRIDE: u64 = 0x200;
pub const VIRTIO_MMIO_SLOTS: usize = 32;
/// SPI 16 → INTID 48 for slot 0.
pub const VIRTIO_FIRST_INTID: u32 = 48;
/// The virtual timer PPI (INTID 27; architecture §5.1 PPI table).
pub const VTIMER_INTID: u32 = 27;

/// A block of consecutive INTIDs, `first..=last`, that the board reserves for a group of lines
/// rather than for one device (PLAN §1, interrupt column).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IntidRange {
    pub name: &'static str,
    pub first: u32,
    pub last: u32,
}

impl IntidRange {
    /// True if `intid` lies in `first..=last`.
    pub const fn contains(&self, intid: u32) -> bool {
        intid >= self.first && intid <= self.last
    }
}

/// PCIe legacy INTA..INTD: SPI 3–6 → INTID 35–38 (PLAN §1, the reserved PCIe MMIO row).
pub const PCIE_INTX_INTIDS: IntidRange = IntidRange {
    name: "pcie-intx",
    first: 35,
    last: 38,
};
/// The SPIs the GICv2m frame turns MSIs into: SPI 48–111 → INTID 80–143 (PLAN §1). It sits
/// directly above the virtio block (INTID 48–79), so a 33rd virtio slot would collide with it.
pub const GIC_V2M_INTIDS: IntidRange = IntidRange {
    name: "gic-v2m",
    first: 80,
    last: 143,
};
/// Every reserved INTID block, sorted by `first`. No device line may fall inside one.
pub const RESERVED_INTIDS: &[IntidRange] = &[PCIE_INTX_INTIDS, GIC_V2M_INTIDS];

/// RAM limits (architecture §5.1): 64 MiB ≤ size ≤ 255 GiB, a multiple of 2 MiB (so the
/// Linux Image's 2 MiB-aligned placement, booting.rst §4, always fits whole blocks).
pub const RAM_MIN: u64 = 64 << 20;
/// The top of the RAM window: 255 GiB of RAM ends at `0x40_0000_0000` (2^38).
pub const RAM_MAX_END: u64 = 0x40_0000_0000;
pub const RAM_MAX: u64 = RAM_MAX_END - RAM_BASE;
pub const RAM_ALIGN: u64 = 2 << 20;
pub const RAM_DEFAULT: u64 = 512 << 20;

/// The DTB slot at the start of RAM: 2 MiB for a Linux Image, 512 KiB when a test guest
/// (linked at `RAM_BASE + 512 KiB`) is loaded (PLAN §1 "Placement in RAM").
pub const DTB_MAX: u64 = 2 << 20;
pub const DTB_MAX_TEST_GUEST: u64 = 512 << 10;
/// Where test guests are linked (CURRICULUM ch03).
pub const TEST_GUEST_BASE: u64 = RAM_BASE + DTB_MAX_TEST_GUEST;

/// M9 (PLAN §1 "Placement in RAM"): the 2 MiB-aligned base a Linux arm64 Image is placed at,
/// right after the 2 MiB DTB slot. The kernel itself starts `text_offset` bytes above it
/// (booting.rst §4: "placed text_offset bytes from a 2MB aligned base address").
pub const LINUX_IMAGE_BASE: u64 = RAM_BASE + DTB_MAX;
/// The alignment of the Image's base address and of the initrd (booting.rst §4; PLAN §1).
pub const LINUX_ALIGN: u64 = 2 << 20;
/// booting.rst §4: the initrd must lie, with the kernel Image, inside one 1 GiB-aligned
/// physical window of at most 32 GiB.
pub const LINUX_WINDOW_ALIGN: u64 = 1 << 30;
pub const LINUX_WINDOW_MAX: u64 = 32 << 30;

/// The smallest IPA width the VMM asks for (HVF's default is 36, spike finding 3).
pub const MIN_IPA_BITS: u32 = 36;

impl Region {
    /// One past the last byte. `layout_invariants.rs` proves no row overflows, so the
    /// saturation never triggers for the static table.
    pub const fn end(&self) -> u64 {
        self.base.saturating_add(self.size)
    }

    /// True if `ipa` lies in this region.
    pub const fn contains(&self, ipa: u64) -> bool {
        ipa >= self.base && ipa < self.end()
    }

    /// The DT unit address of a node for this region: the base in lowercase hex without a
    /// prefix or leading zeros (DT spec v0.4 §2.2.1 "Node names": `node-name@unit-address`,
    /// where the unit address matches the first address in `reg`). Derived from `base` so the
    /// node name and `reg` can never disagree.
    pub fn unit_address(&self) -> String {
        format!("{:x}", self.base)
    }
}

/// Why a `--mem` size was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RamSizeError {
    TooSmall { size: u64 },
    TooLarge { size: u64 },
    Unaligned { size: u64 },
}

impl fmt::Display for RamSizeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            RamSizeError::TooSmall { size } => {
                write!(
                    f,
                    "RAM size {size:#x} is below the minimum {RAM_MIN:#x} (64 MiB)"
                )
            }
            RamSizeError::TooLarge { size } => {
                write!(
                    f,
                    "RAM size {size:#x} is above the maximum {RAM_MAX:#x} (255 GiB)"
                )
            }
            RamSizeError::Unaligned { size } => {
                write!(f, "RAM size {size:#x} is not a multiple of 2 MiB")
            }
        }
    }
}

impl std::error::Error for RamSizeError {}

/// A board: its profile and its static regions.
#[derive(Debug)]
pub struct Layout {
    pub profile: MachineProfile,
    pub regions: &'static [Region],
}

static VIRT: Layout = Layout {
    profile: MachineProfile::Virt,
    regions: VIRT_REGIONS,
};

impl Layout {
    /// The QEMU-`virt`-compatible board.
    pub fn virt() -> &'static Layout {
        &VIRT
    }

    /// Base address and INTID of virtio-mmio slot `i` (0..32); `None` past the last slot.
    pub fn virtio_slot(&self, i: usize) -> Option<(u64, u32)> {
        if i >= VIRTIO_MMIO_SLOTS {
            return None;
        }
        let base = VIRTIO_MMIO_STRIDE
            .checked_mul(u64::try_from(i).ok()?)?
            .checked_add(VIRTIO_MMIO_BASE)?;
        Some((
            base,
            VIRTIO_FIRST_INTID.checked_add(u32::try_from(i).ok()?)?,
        ))
    }

    /// The non-RAM region containing `ipa`, if any.
    pub fn find(&self, ipa: u64) -> Option<&Region> {
        self.regions.iter().find(|r| r.contains(ipa))
    }

    /// Bytes of redistributor frames for `ncpus` vCPUs (`1..=MAX_CPUS`); the rest of the
    /// window up to [`GICR_WINDOW_END`] is the RAZ/WI remainder.
    pub fn gicr_size(&self, ncpus: u32) -> Option<u64> {
        if ncpus == 0 || ncpus > MAX_CPUS {
            return None;
        }
        GICR_FRAME_SIZE.checked_mul(u64::from(ncpus))
    }

    /// Check a `--mem` size and return where RAM ends (`RAM_BASE + size`).
    pub fn ram_end(&self, size: u64) -> Result<u64, RamSizeError> {
        if size < RAM_MIN {
            return Err(RamSizeError::TooSmall { size });
        }
        if size > RAM_MAX {
            return Err(RamSizeError::TooLarge { size });
        }
        if !size.is_multiple_of(RAM_ALIGN) {
            return Err(RamSizeError::Unaligned { size });
        }
        RAM_BASE
            .checked_add(size)
            .ok_or(RamSizeError::TooLarge { size })
    }

    // ANCHOR: layout_ipa_bits
    /// The smallest IPA width ≥ 36 that covers `max(ram_end, highest region end)`: a VM with
    /// `n` IPA bits can address `[0, 2^n)` (ARM ARM D8.1: the stage-2 input size,
    /// VTCR_EL2.T0SZ, which HVF derives from `hv_vm_config_set_ipa_size`). Asking for no more
    /// than needed keeps the stage-2 tables shallow. The caller refuses a result above the
    /// host's `max_ipa_bits` (`vm::create_vm`).
    pub fn ipa_bits_needed(&self, ram_end: u64) -> u32 {
        let top = self.regions.iter().map(Region::end).fold(ram_end, u64::max);
        let mut bits = MIN_IPA_BITS;
        while bits < 64 && 1u64.checked_shl(bits).is_some_and(|limit| limit < top) {
            bits = bits.saturating_add(1);
        }
        bits
    }
    // ANCHOR_END: layout_ipa_bits
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;

    #[test]
    fn sorted_disjoint_and_slots() {
        for w in VIRT_REGIONS.windows(2) {
            assert!(w[0].end() <= w[1].base, "{:?} overlaps {:?}", w[0], w[1]);
        }
        assert!(VIRT_REGIONS.last().unwrap().end() <= RAM_BASE);
        let l = Layout::virt();
        assert_eq!(l.virtio_slot(0), Some((0x0a00_0000, 48)));
        assert_eq!(l.virtio_slot(31), Some((0x0a00_3e00, 79)));
        assert_eq!(l.virtio_slot(32), None);
        assert_eq!(l.virtio_slot(usize::MAX), None);
        assert_eq!(l.ipa_bits_needed(0x6000_0000), 36);
        assert_eq!(l.ipa_bits_needed(0x40_0000_0000), 38);
        assert_eq!(l.find(PROBE_HOLE_BASE).map(|r| r.name), Some("probe-hole"));
        assert_eq!(l.find(RAM_BASE), None);
    }

    #[test]
    fn ram_sizes_and_gicr() {
        let l = Layout::virt();
        assert_eq!(l.ram_end(RAM_DEFAULT), Ok(0x6000_0000));
        assert_eq!(l.ram_end(RAM_MAX), Ok(RAM_MAX_END));
        assert!(matches!(
            l.ram_end(RAM_MIN - RAM_ALIGN),
            Err(RamSizeError::TooSmall { .. })
        ));
        assert!(matches!(
            l.ram_end(RAM_MAX + RAM_ALIGN),
            Err(RamSizeError::TooLarge { .. })
        ));
        assert!(matches!(
            l.ram_end(u64::MAX),
            Err(RamSizeError::TooLarge { .. })
        ));
        assert!(matches!(
            l.ram_end(RAM_MIN + 4096),
            Err(RamSizeError::Unaligned { .. })
        ));
        assert_eq!(l.gicr_size(1), Some(GICR_FRAME_SIZE));
        assert_eq!(l.gicr_size(64), Some(0x80_0000));
        assert_eq!(l.gicr_size(0), None);
        assert_eq!(l.gicr_size(65), None);
        assert!(
            RamSizeError::Unaligned { size: 1 }
                .to_string()
                .contains("2 MiB")
        );
    }
}
