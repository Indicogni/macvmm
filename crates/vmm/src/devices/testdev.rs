//! `TestDev`: 512 × u64 scratch registers at `0x0b00_0000` (`--testdev` only; architecture
//! §10; course ch07; threat model MMIO-8).
//!
//! **Why a device that does nothing.** To test MMIO *decoding* we need a device whose
//! behaviour is trivially predictable, so that any surprise is the decoder's fault: a store of
//! N bytes at offset `o` followed by a load of N bytes at `o` must return exactly what was
//! stored, truncated to N bytes. `guests/mmio-probe` uses it to check access sizes, write
//! masking, `xzr` as a source and as a destination, and sign extension (`ldrsb`, `ldrsh`,
//! `ldrsw`) end to end through a real vCPU; M17's `isv0-probe` reuses it for ISV=0.
//!
//! **Model.** Register `r = offset / 8` holds 8 byte lanes; an N-byte access at `offset`
//! touches lanes `offset % 8 ..` of that register, little-endian, like a 64-bit register file
//! with byte enables. A naturally aligned access (`offset % N == 0`) never crosses a register,
//! so "last value written at that offset, truncated to the access size" holds for every
//! width. A misaligned access (which a guest can only make with the MMU on and Normal
//! memory, since Device memory faults it in the guest first) is RAZ/WI with a rate-limited
//! warning, as MMIO-8 requires. The bus guarantees `offset + size ≤ 0x1000`; the device
//! checks again with `.get()` rather than trusting it.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::bus::{AccessSize, MmioDevice};

/// Number of 64-bit scratch registers.
pub const TESTDEV_REGS: usize = 512;
/// The window size: 512 × 8 bytes = 4 KiB (architecture §5.1 `testdev` row).
pub const TESTDEV_SIZE: u64 = (TESTDEV_REGS as u64) * 8;

/// The scratch-register device.
#[derive(Debug)]
pub struct TestDev {
    regs: Box<[u64; TESTDEV_REGS]>,
}

impl Default for TestDev {
    fn default() -> TestDev {
        TestDev::new()
    }
}

/// Where an access lands: register index and the lane shift in bits, if it is aligned and in
/// the window.
fn locate(offset: u64, size: AccessSize) -> Option<(usize, u32)> {
    if !offset.is_multiple_of(size.bytes()) {
        return None;
    }
    let index = usize::try_from(offset / 8).ok()?;
    if index >= TESTDEV_REGS {
        return None;
    }
    // offset % 8 < 8, and alignment keeps lane + size within the register.
    let shift = u32::try_from((offset % 8).checked_mul(8)?).ok()?;
    Some((index, shift))
}

impl TestDev {
    pub fn new() -> TestDev {
        TestDev {
            regs: Box::new([0; TESTDEV_REGS]),
        }
    }
}

impl MmioDevice for TestDev {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        match locate(offset, size).and_then(|(i, s)| Some((*self.regs.get(i)?, s))) {
            Some((reg, shift)) => reg.checked_shr(shift).unwrap_or(0) & size.mask(),
            None => {
                crate::guest_warn!(
                    "testdev: {}-byte read at offset {offset:#x} is misaligned or outside the \
                     window (read as zero)",
                    size.bytes()
                );
                0
            }
        }
    }

    fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
        let slot = locate(offset, size).and_then(|(i, s)| Some((self.regs.get_mut(i)?, s)));
        match slot {
            Some((reg, shift)) => {
                let lanes = size.mask().checked_shl(shift).unwrap_or(0);
                let v = (value & size.mask()).checked_shl(shift).unwrap_or(0);
                *reg = (*reg & !lanes) | v;
            }
            None => crate::guest_warn!(
                "testdev: {}-byte write at offset {offset:#x} is misaligned or outside the \
                 window (ignored)",
                size.bytes()
            ),
        }
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;

    const SIZES: [AccessSize; 4] = [
        AccessSize::B1,
        AccessSize::B2,
        AccessSize::B4,
        AccessSize::B8,
    ];

    #[test]
    fn read_returns_last_write_truncated() {
        let mut d = TestDev::new();
        d.write(0, AccessSize::B8, 0x0123_4567_89ab_cdef);
        assert_eq!(d.read(0, AccessSize::B8), 0x0123_4567_89ab_cdef);
        assert_eq!(d.read(0, AccessSize::B4), 0x89ab_cdef);
        assert_eq!(d.read(4, AccessSize::B4), 0x0123_4567);
        assert_eq!(d.read(6, AccessSize::B2), 0x0123);
        assert_eq!(d.read(7, AccessSize::B1), 0x01);
        d.write(1, AccessSize::B1, 0xffff_ff42); // only the low byte counts
        assert_eq!(d.read(0, AccessSize::B8), 0x0123_4567_89ab_42ef);
        d.write(0xff8, AccessSize::B8, u64::MAX);
        assert_eq!(d.read(0xffc, AccessSize::B4), 0xffff_ffff);
    }

    /// MMIO-8: every offset and width in (and just past) the window is answered, never a panic;
    /// misaligned and out-of-window accesses are RAZ/WI; aligned ones round-trip.
    #[test]
    fn total_over_window_every_offset_and_width() {
        let mut d = TestDev::new();
        let mut bad = 0u64;
        crate::log::test_capture::start();
        for off in 0..TESTDEV_SIZE + 16 {
            for size in SIZES {
                let v = 0xa5a5_5a5a_dead_beef ^ off;
                d.write(off, size, v);
                let r = d.read(off, size);
                let aligned = off % size.bytes() == 0 && off < TESTDEV_SIZE;
                if aligned {
                    assert_eq!(r, v & size.mask(), "off {off:#x} {size:?}");
                } else {
                    assert_eq!(r, 0, "off {off:#x} {size:?}");
                    bad += 1;
                }
            }
        }
        for off in [u64::MAX, u64::MAX - 7, 1 << 63] {
            for size in SIZES {
                d.write(off, size, 1);
                assert_eq!(d.read(off, size), 0);
            }
        }
        // Rate-limited (LOG-1): per call site the first 10, then every 1000th.
        let lines = crate::log::test_capture::finish().len() as u64;
        assert!(bad > 8_000, "{bad}");
        assert!(
            lines <= 2 * (10 + (bad + 24) / 1000 + 1),
            "{lines} lines for {bad}"
        );
    }
}
