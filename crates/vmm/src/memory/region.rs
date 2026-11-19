//! The guest-RAM region table: sorted, non-overlapping, 16 KiB-aligned spans of IPA space, and
//! the one function that decides whether an access is inside one of them.
//!
//! **Why a pure table.** Bounds checking is the security core of guest memory (threat model
//! MEM-2, MEM-8), so it lives here with no pointers and no framework calls: [`RegionTable`] is
//! what both [`super::host::GuestRam`] (real `hv_vm_allocate` memory) and
//! [`super::vec_mem::VecMemory`] (host tests) consult, and the property test
//! `volatile_copy_property` checks it against a `u128` model on 10,000 random accesses.
//!
//! **The construction rules (MEM-8)** and why each exists:
//! - *non-zero size*: a zero-sized region has no meaningful end and breaks "base ≤ addr < end";
//! - *16 KiB-aligned base and size* ([`REGION_ALIGN`]): `hv_vm_map` needs host address, IPA and
//!   length aligned to the stage-2 granule, 16 KiB by default on Apple Silicon (spike finding 1;
//!   `docs/research/hvf-api.md` §5). Checking here gives a clear error instead of
//!   `HV_BAD_ARGUMENT` from deep inside setup;
//! - *no `base + size` overflow*: otherwise the end wraps and the region "contains" low memory;
//! - *below `1 << ipa_bits`*: an IPA the VM cannot address can never be mapped (ARM ARM D8.1:
//!   the input address size of stage 2 is set by VTCR_EL2.T0SZ/PS, which HVF derives from the
//!   configured IPA size);
//! - *no overlap*: one guest-physical byte must have exactly one host backing;
//! - *at most [`MAX_REGIONS`]*: bounded work per lookup and a bounded table.
//!
//! **The access rule (MEM-2).** An access `[addr, addr + len)` is valid only if `addr + len`
//! does not overflow, `len > 0`, and the whole range lies in **one** region. Two regions that
//! happen to be adjacent are still two regions: their host backings are separate allocations, so
//! a copy that crossed the boundary would run off the end of the first one.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{GuestAddress, MemoryError};
use core::fmt;

/// Alignment of every region base and size: the default 16 KiB stage-2 granule.
pub const REGION_ALIGN: u64 = 16 * 1024;

/// The most regions one table may hold (RUST-4: a named cap). The `virt` machine uses one RAM
/// region; the rest is headroom (high RAM, hotplug experiments).
pub const MAX_REGIONS: usize = 16;

/// Smallest accepted IPA width: ID_AA64MMFR0_EL1.PARange 0b0000 is 32 bits (ARM ARM,
/// ID_AA64MMFR0_EL1 register description).
pub const MIN_IPA_BITS: u32 = 32;
/// Largest accepted IPA width: PARange 0b0110 is 52 bits, the architectural maximum.
pub const MAX_IPA_BITS: u32 = 52;

/// One region: `[base, end)`, with `end = base + size` known not to overflow.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub base: GuestAddress,
    pub size: u64,
    end: u64,
}

impl Span {
    /// One past the last byte.
    pub fn end(&self) -> u64 {
        self.end
    }
}

/// Where an accepted access landed: region `index` (in table order) at byte `offset`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub index: usize,
    pub offset: u64,
}

/// Why a region table was refused (MEM-8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionError {
    /// No regions at all.
    Empty,
    /// More than [`MAX_REGIONS`].
    TooMany { count: usize },
    /// The IPA width is outside `MIN_IPA_BITS..=MAX_IPA_BITS`.
    BadIpaBits { bits: u32 },
    /// A region of size 0.
    ZeroSize { base: u64 },
    /// Base or size not a multiple of [`REGION_ALIGN`].
    Unaligned { base: u64, size: u64 },
    /// `base + size` passes `u64::MAX`.
    Overflow { base: u64, size: u64 },
    /// The region reaches at or above `1 << ipa_bits`.
    AboveIpaLimit { base: u64, size: u64, ipa_bits: u32 },
    /// Two regions share at least one byte.
    Overlap { first: u64, second: u64 },
}

impl fmt::Display for RegionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            RegionError::Empty => write!(f, "no memory regions"),
            RegionError::TooMany { count } => {
                write!(f, "{count} memory regions (at most {MAX_REGIONS})")
            }
            RegionError::BadIpaBits { bits } => write!(
                f,
                "IPA width {bits} bits is outside {MIN_IPA_BITS}..={MAX_IPA_BITS}"
            ),
            RegionError::ZeroSize { base } => write!(f, "region at {base:#x} has size 0"),
            RegionError::Unaligned { base, size } => write!(
                f,
                "region {base:#x}+{size:#x} is not {REGION_ALIGN:#x}-aligned"
            ),
            RegionError::Overflow { base, size } => {
                write!(f, "region {base:#x}+{size:#x} overflows the address space")
            }
            RegionError::AboveIpaLimit {
                base,
                size,
                ipa_bits,
            } => write!(
                f,
                "region {base:#x}+{size:#x} does not fit in a {ipa_bits}-bit IPA space"
            ),
            RegionError::Overlap { first, second } => {
                write!(f, "regions at {first:#x} and {second:#x} overlap")
            }
        }
    }
}

impl std::error::Error for RegionError {}

/// A validated, sorted region table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegionTable {
    spans: Vec<Span>,
}

impl RegionTable {
    /// Validate `regions` (`(base, size)` pairs, any order) for a VM with `ipa_bits` of IPA
    /// space. The result is sorted by base.
    pub fn new(regions: &[(GuestAddress, u64)], ipa_bits: u32) -> Result<RegionTable, RegionError> {
        if regions.is_empty() {
            return Err(RegionError::Empty);
        }
        if regions.len() > MAX_REGIONS {
            return Err(RegionError::TooMany {
                count: regions.len(),
            });
        }
        if !(MIN_IPA_BITS..=MAX_IPA_BITS).contains(&ipa_bits) {
            return Err(RegionError::BadIpaBits { bits: ipa_bits });
        }
        // `ipa_bits <= 52`, so the shift cannot overflow; `checked_shl` keeps the lint quiet
        // without an `allow`.
        let limit = 1u64
            .checked_shl(ipa_bits)
            .ok_or(RegionError::BadIpaBits { bits: ipa_bits })?;
        let mut spans = Vec::with_capacity(regions.len());
        for &(base, size) in regions {
            let b = base.0;
            if size == 0 {
                return Err(RegionError::ZeroSize { base: b });
            }
            if !b.is_multiple_of(REGION_ALIGN) || !size.is_multiple_of(REGION_ALIGN) {
                return Err(RegionError::Unaligned { base: b, size });
            }
            let end = b
                .checked_add(size)
                .ok_or(RegionError::Overflow { base: b, size })?;
            if end > limit {
                return Err(RegionError::AboveIpaLimit {
                    base: b,
                    size,
                    ipa_bits,
                });
            }
            spans.push(Span { base, size, end });
        }
        spans.sort_by_key(|s| s.base);
        for pair in spans.windows(2) {
            if let [a, b] = pair
                && b.base.0 < a.end
            {
                return Err(RegionError::Overlap {
                    first: a.base.0,
                    second: b.base.0,
                });
            }
        }
        Ok(RegionTable { spans })
    }

    /// The regions, sorted by base.
    pub fn spans(&self) -> &[Span] {
        &self.spans
    }

    /// Sum of all region sizes (cannot overflow: the regions are disjoint inside a 52-bit
    /// space; saturating anyway).
    pub fn total_size(&self) -> u64 {
        self.spans
            .iter()
            .fold(0u64, |t, s| t.saturating_add(s.size))
    }

    // ANCHOR: guest_ram_bounds_check
    /// Decide whether `[addr, addr + len)` is one valid access, and where it lands.
    ///
    /// - `addr + len` overflowing `u64` is [`MemoryError::Overflow`];
    /// - `len == 0`, a range outside every region, or one that crosses a region boundary
    ///   (even into an adjacent region) is [`MemoryError::OutOfBounds`].
    pub fn locate(&self, addr: GuestAddress, len: u64) -> Result<Located, MemoryError> {
        let a = addr.0;
        let end = a
            .checked_add(len)
            .ok_or(MemoryError::Overflow { addr: a, len })?;
        let oob = MemoryError::OutOfBounds { addr: a, len };
        if len == 0 {
            return Err(oob);
        }
        // The last region whose base is <= addr: the only one that can contain the start.
        let index = self
            .spans
            .partition_point(|s| s.base.0 <= a)
            .checked_sub(1)
            .ok_or(oob)?;
        let span = self.spans.get(index).ok_or(oob)?;
        if end > span.end {
            return Err(oob);
        }
        let offset = addr.offset_from(span.base).ok_or(oob)?;
        Ok(Located { index, offset })
    }
    // ANCHOR_END: guest_ram_bounds_check

    /// True if [`RegionTable::locate`] accepts the access.
    pub fn contains(&self, addr: GuestAddress, len: u64) -> bool {
        self.locate(addr, len).is_ok()
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails the test
mod tests {
    use super::*;

    const K16: u64 = REGION_ALIGN;

    #[test]
    fn construction_rules() {
        let t =
            RegionTable::new(&[(GuestAddress(4 * K16), K16), (GuestAddress(0), K16)], 36).unwrap();
        assert_eq!(t.spans()[0].base, GuestAddress(0));
        assert_eq!(t.spans()[1].end(), 5 * K16);
        assert_eq!(t.total_size(), 2 * K16);
        assert_eq!(RegionTable::new(&[], 36), Err(RegionError::Empty));
        assert_eq!(
            RegionTable::new(&[(GuestAddress(0), K16)], 31),
            Err(RegionError::BadIpaBits { bits: 31 })
        );
        assert_eq!(
            RegionTable::new(&[(GuestAddress(0), K16)], 53),
            Err(RegionError::BadIpaBits { bits: 53 })
        );
        let many: Vec<_> = (0..=MAX_REGIONS as u64)
            .map(|i| (GuestAddress(i * K16), K16))
            .collect();
        assert_eq!(
            RegionTable::new(&many, 36),
            Err(RegionError::TooMany {
                count: MAX_REGIONS + 1
            })
        );
        assert!(RegionTable::new(&many[..MAX_REGIONS], 36).is_ok());
    }

    #[test]
    fn locate_edges() {
        let t = RegionTable::new(&[(GuestAddress(K16), K16)], 36).unwrap();
        assert_eq!(
            t.locate(GuestAddress(K16), K16),
            Ok(Located {
                index: 0,
                offset: 0
            })
        );
        assert_eq!(
            t.locate(GuestAddress(2 * K16 - 1), 1),
            Ok(Located {
                index: 0,
                offset: K16 - 1
            })
        );
        assert!(t.locate(GuestAddress(2 * K16 - 1), 2).is_err());
        assert!(t.locate(GuestAddress(K16 - 1), 1).is_err());
        assert!(t.locate(GuestAddress(0), 1).is_err());
        assert!(t.locate(GuestAddress(K16), 0).is_err());
        assert_eq!(
            t.locate(GuestAddress(u64::MAX), 1),
            Err(MemoryError::Overflow {
                addr: u64::MAX,
                len: 1
            })
        );
    }
}
