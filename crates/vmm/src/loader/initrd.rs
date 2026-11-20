//! The initrd (initramfs) placement (architecture §12.1, threat model LDR-1, LDR-5; course ch13).
//!
//! **What the kernel needs.** The initrd is opaque bytes to the VMM: a cpio archive, possibly
//! compressed, that the kernel unpacks into its root file system (Linux
//! `Documentation/driver-api/early-userspace/buffer-format.rst`). The VMM never parses it. It
//! only has to put it somewhere the kernel can find and accept:
//! - the DT says where: `/chosen/linux,initrd-start` and `linux,initrd-end` (end exclusive;
//!   DT spec §3.6, Linux `drivers/of/fdt.c` `early_init_dt_check_for_initrd`);
//! - booting.rst §4: "If an initrd/initramfs is passed to the kernel at boot, it must reside
//!   entirely within a 1 GB aligned physical memory window of up to 32 GB in size that fully
//!   covers the kernel Image as well." ([`check_window`]);
//! - it must not overlap the kernel's `image_size` span, or the kernel's BSS would erase it.
//!
//! **Placement** (PLAN §1): `align_up(kernel_load + image_size, 2 MiB)`. For Alpine 6.18.60
//! that is kernel `0x4020_0000..0x424a_0000`, initrd at `0x4260_0000`. The size must be > 0
//! and ≤ the RAM size (the `HostIo` read cap, LDR-1), and the whole initrd must lie in RAM.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{LoaderError, RamRange};
use crate::arch::layout::{LINUX_ALIGN, LINUX_WINDOW_ALIGN, LINUX_WINDOW_MAX};

/// `x` rounded up to a multiple of `align` (a power of two); `None` on overflow.
pub fn align_up(x: u64, align: u64) -> Option<u64> {
    let mask = align.checked_sub(1)?;
    Some(x.checked_add(mask)? & !mask)
}

// ANCHOR: bootplan_place_initrd
/// Place a `size`-byte initrd above a kernel whose memory ends at `kernel_end` (module docs).
/// Returns `[start, end)`.
pub fn place(
    ram: RamRange,
    kernel_start: u64,
    kernel_end: u64,
    size: u64,
) -> Result<(u64, u64), LoaderError> {
    if size == 0 {
        return Err(LoaderError::InitrdEmpty);
    }
    let outside = |addr| LoaderError::OutsideRam {
        what: "initrd".into(),
        addr,
        len: size,
    };
    let start = align_up(kernel_end, LINUX_ALIGN).ok_or_else(|| outside(kernel_end))?;
    let end = start.checked_add(size).ok_or_else(|| outside(start))?;
    if size > ram.size || !ram.contains(start, size) {
        return Err(outside(start));
    }
    check_window(kernel_start, kernel_end, start, end)?;
    Ok((start, end))
}
// ANCHOR_END: bootplan_place_initrd

// ANCHOR: initrd_window_check
/// booting.rst section 4: the kernel `[kstart, kend)` and the initrd `[istart, iend)` must both lie in
/// one 1 GiB-aligned window of at most 32 GiB. The best window starts at the 1 GiB boundary at
/// or below the lower of the two starts; the rule holds iff the higher end is within 32 GiB of
/// it.
pub fn check_window(kstart: u64, kend: u64, istart: u64, iend: u64) -> Result<(), LoaderError> {
    let low = kstart.min(istart);
    let base = low & !(LINUX_WINDOW_ALIGN.wrapping_sub(1));
    let high = kend.max(iend);
    match high.checked_sub(base) {
        Some(span) if span <= LINUX_WINDOW_MAX => Ok(()),
        _ => Err(LoaderError::InitrdWindow {
            start: istart,
            end: iend,
        }),
    }
}
// ANCHOR_END: initrd_window_check

#[cfg(test)]
#[allow(clippy::arithmetic_side_effects, clippy::unwrap_used)] // tests: a panic fails it
mod tests {
    use super::*;

    #[test]
    fn align_and_window() {
        assert_eq!(align_up(0x424a_0000, 2 << 20), Some(0x4260_0000));
        assert_eq!(align_up(0x4260_0000, 2 << 20), Some(0x4260_0000));
        assert_eq!(align_up(u64::MAX, 2 << 20), None);
        let g = 1u64 << 30;
        assert!(check_window(g, g + 10, g + 20, g + (32 << 30) - g / 2).is_ok());
        assert!(check_window(g, g + 10, g + 20, 2 * g + (32 << 30)).is_err());
    }
}
