//! [`GuestAddress`]: a guest-physical address (an IPA), as a type of its own. [frozen ch04]
//!
//! **Why a newtype.** The VMM handles three kinds of address that are all `u64`: guest virtual
//! addresses (translated by the guest's stage 1), guest physical addresses / IPAs (translated by
//! stage 2, ARM ARM D8.1 "Translation process"), and host virtual addresses (pointers). Mixing
//! them up is a classic VMM bug. A distinct type makes "this is a guest-physical address" part of
//! every signature, and keeps raw `+` off it: guest-supplied addresses are hostile, and
//! `addr + len` on a `u64` silently wraps in release builds (threat model MEM-2). Every
//! arithmetic operation here is checked and returns `Option`.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use core::fmt;

/// A guest-physical address (IPA).
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GuestAddress(pub u64);

impl GuestAddress {
    /// `self + off`, or `None` if it would pass `u64::MAX`. A guest that hands us
    /// `addr = u64::MAX - 3, len = 8` gets `None` here, not a small wrapped address that
    /// happens to land inside RAM.
    pub fn checked_add(self, off: u64) -> Option<GuestAddress> {
        // LEARNER: checked_add_body
        todo!("LEARNER: checked_add_body")
        // LEARNER_END: checked_add_body
    }

    /// `self - base`, or `None` if `self` lies below `base`.
    pub fn offset_from(self, base: GuestAddress) -> Option<u64> {
        self.0.checked_sub(base.0)
    }

    /// Round up to a multiple of `align`, which must be a power of two (`None` otherwise, and
    /// `None` if rounding up would pass `u64::MAX`).
    pub fn align_up(self, align: u64) -> Option<GuestAddress> {
        if !align.is_power_of_two() {
            return None;
        }
        let mask = align.checked_sub(1)?;
        self.0.checked_add(mask).map(|v| GuestAddress(v & !mask))
    }
}

impl fmt::LowerHex for GuestAddress {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::LowerHex::fmt(&self.0, f)
    }
}

impl fmt::Display for GuestAddress {
    /// `0x40001000`: addresses are always shown in hex.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:#x}", self.0)
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

    #[test]
    fn checked_arithmetic() {
        let a = GuestAddress(u64::MAX - 3);
        assert_eq!(a.checked_add(3), Some(GuestAddress(u64::MAX)));
        assert_eq!(a.checked_add(8), None);
        assert_eq!(
            GuestAddress(0x1010).offset_from(GuestAddress(0x1000)),
            Some(0x10)
        );
        assert_eq!(GuestAddress(0xfff).offset_from(GuestAddress(0x1000)), None);
        assert_eq!(
            GuestAddress(0x1001).align_up(0x1000),
            Some(GuestAddress(0x2000))
        );
        assert_eq!(
            GuestAddress(0x2000).align_up(0x1000),
            Some(GuestAddress(0x2000))
        );
        assert_eq!(GuestAddress(5).align_up(1), Some(GuestAddress(5)));
        assert_eq!(GuestAddress(5).align_up(0), None);
        assert_eq!(GuestAddress(5).align_up(3), None);
        assert_eq!(GuestAddress(u64::MAX).align_up(2), None);
        assert_eq!(GuestAddress(0x4000_1000).to_string(), "0x40001000");
        assert_eq!(format!("{:x}", GuestAddress(255)), "ff");
    }
}
