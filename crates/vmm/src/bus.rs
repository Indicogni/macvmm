//! The MMIO bus: which emulated device answers a guest-physical address (architecture §6.2;
//! course ch07, frozen in ch09; threat model MMIO-7, MMIO-8).
//!
//! **Why a bus at all.** A device window is a stage-2 hole left on purpose (architecture §10,
//! first-principles R5): reading the PL011 data register pops a FIFO, writing it transmits a
//! byte, and RAM cannot express "something happens when you touch this". Every access to a
//! hole arrives as a data abort with the faulting IPA; `vcpu/mmio.rs` decodes the access and
//! asks the bus which device owns that IPA, and at what offset.
//!
//! **The rules** (MMIO-7):
//! - the table is built once, before the first vCPU runs, and never changes (no hotplug), so
//!   lookups need no lock: [`Bus`] is `Sync` and shared by `&` between vCPU threads;
//! - [`Bus::insert`] refuses a zero-sized window, a window whose end overflows `u64`, and any
//!   overlap with an existing window, so at most one device can ever own an address;
//! - lookup is a binary search over the windows sorted by base, total for every
//!   `(ipa, size)`: an address in no window is [`BusError::Unmapped`], and an access that
//!   starts inside a window but runs past its end is [`BusError::Straddle`], which the caller
//!   treats like `Unmapped` (no device ever sees a partial access);
//! - each device sits behind its **own** `Mutex`, taken only for the one call, so two vCPUs
//!   touching different devices never contend (architecture §14.2). A device mutex poisoned
//!   by a panic is a VMM bug; `sync::lock` recovers the guard only so that shutdown can run
//!   (RUST-7), and the panic itself already stopped the VM.
//!
//! **Devices are total over their window** (MMIO-8): [`MmioDevice::read`] and
//! [`MmioDevice::write`] are called with every `offset < size` and every [`AccessSize`], even
//! unaligned ones, and must answer each (RAZ/WI plus `guest_warn!` for what they do not
//! support). The bus guarantees `offset + size ≤ window size`.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::sync::lock;
use core::fmt;
use std::sync::{Arc, Mutex};

/// The width of one MMIO access (a load or store of 1, 2, 4 or 8 bytes). [frozen ch09]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum AccessSize {
    B1 = 1,
    B2 = 2,
    B4 = 4,
    B8 = 8,
}

impl AccessSize {
    /// The size in bytes.
    pub const fn bytes(self) -> u64 {
        self as u64
    }

    /// The low `bytes() * 8` bits set: `0xff`, `0xffff`, `0xffff_ffff` or `u64::MAX`.
    pub const fn mask(self) -> u64 {
        match self {
            AccessSize::B1 => 0xff,
            AccessSize::B2 => 0xffff,
            AccessSize::B4 => 0xffff_ffff,
            AccessSize::B8 => u64::MAX,
        }
    }

    /// From a data abort's `SAS` field (`size = 1 << SAS`). Only the low two bits are used,
    /// so every input gives a size (MMIO-3).
    pub const fn from_sas(sas: u8) -> AccessSize {
        match sas & 3 {
            0 => AccessSize::B1,
            1 => AccessSize::B2,
            2 => AccessSize::B4,
            _ => AccessSize::B8,
        }
    }

    /// From a byte count, if it is 1, 2, 4 or 8.
    pub const fn from_bytes(n: u64) -> Option<AccessSize> {
        match n {
            1 => Some(AccessSize::B1),
            2 => Some(AccessSize::B2),
            4 => Some(AccessSize::B4),
            8 => Some(AccessSize::B8),
            _ => None,
        }
    }
}

// ANCHOR: mmio_device_trait
/// An emulated device on the bus. [frozen ch09]
pub trait MmioDevice: Send {
    /// `offset` is relative to the device base. Return value is zero-extended to 64 bits;
    /// the caller sign-extends if the instruction asked for it.
    fn read(&mut self, offset: u64, size: AccessSize) -> u64;
    /// `value` holds the low `size` bytes of the source register.
    fn write(&mut self, offset: u64, size: AccessSize, value: u64);
}
// ANCHOR_END: mmio_device_trait

/// Why a bus operation was refused. [frozen ch09]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BusError {
    /// `insert`: the new window overlaps `with`.
    Overlap {
        name: &'static str,
        base: u64,
        size: u64,
        with: &'static str,
    },
    /// `insert`: the window is empty or its end passes `u64::MAX`.
    InvalidRange {
        name: &'static str,
        base: u64,
        size: u64,
    },
    /// No device owns `ipa`.
    Unmapped { ipa: u64 },
    /// The access starts inside a device but runs past its end (handled like `Unmapped`).
    Straddle { ipa: u64, size: AccessSize },
}

impl fmt::Display for BusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BusError::Overlap {
                name,
                base,
                size,
                with,
            } => write!(
                f,
                "device {name} at {base:#x} (+{size:#x}) overlaps device {with}"
            ),
            BusError::InvalidRange { name, base, size } => write!(
                f,
                "device {name} has an invalid window: {size:#x} bytes at {base:#x}"
            ),
            BusError::Unmapped { ipa } => write!(f, "no device at {ipa:#x}"),
            BusError::Straddle { ipa, size } => write!(
                f,
                "a {}-byte access at {ipa:#x} runs past the end of its device",
                size.bytes()
            ),
        }
    }
}

impl std::error::Error for BusError {}

/// One device window.
struct Entry {
    name: &'static str,
    base: u64,
    /// One past the last byte; `base < end` (checked by `insert`).
    end: u64,
    dev: Arc<Mutex<dyn MmioDevice>>,
}

/// The machine's device windows, sorted by base, immutable once the VM runs. [frozen ch09]
#[derive(Default)]
pub struct Bus {
    entries: Vec<Entry>,
}

impl fmt::Debug for Bus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut l = f.debug_list();
        for e in &self.entries {
            l.entry(&format_args!("{} {:#x}..{:#x}", e.name, e.base, e.end));
        }
        l.finish()
    }
}

impl Bus {
    pub fn new() -> Bus {
        Bus::default()
    }

    /// Add `dev` at `[base, base + size)`. Refuses size 0, an overflowing end and any
    /// overlap (MMIO-7). Called only while the machine is built.
    pub fn insert(
        &mut self,
        name: &'static str,
        base: u64,
        size: u64,
        dev: Arc<Mutex<dyn MmioDevice>>,
    ) -> Result<(), BusError> {
        let end = match base.checked_add(size) {
            Some(end) if size > 0 => end,
            _ => return Err(BusError::InvalidRange { name, base, size }),
        };
        // The first window that ends after `base` is the only one that can overlap.
        let at = self.entries.partition_point(|e| e.end <= base);
        if let Some(next) = self.entries.get(at)
            && next.base < end
        {
            return Err(BusError::Overlap {
                name,
                base,
                size,
                with: next.name,
            });
        }
        self.entries.insert(
            at,
            Entry {
                name,
                base,
                end,
                dev,
            },
        );
        Ok(())
    }

    // ANCHOR: bus_lookup
    /// The window containing `ipa`, and the offset of `ipa` inside it. Binary search: the last
    /// window whose base is `≤ ipa` is the only candidate.
    fn find(&self, ipa: u64) -> Option<(&Entry, u64)> {
        let after = self.entries.partition_point(|e| e.base <= ipa);
        let e = self.entries.get(after.checked_sub(1)?)?;
        if ipa < e.end {
            Some((e, ipa.wrapping_sub(e.base))) // ipa ≥ base: no wrap
        } else {
            None
        }
    }

    /// The device and offset for a `size`-byte access at `ipa` (module docs): total, never
    /// panics for any input.
    fn route(&self, ipa: u64, size: AccessSize) -> Result<(&Entry, u64), BusError> {
        let (e, offset) = self.find(ipa).ok_or(BusError::Unmapped { ipa })?;
        match ipa.checked_add(size.bytes()) {
            Some(last) if last <= e.end => Ok((e, offset)),
            _ => Err(BusError::Straddle { ipa, size }),
        }
    }
    // ANCHOR_END: bus_lookup

    // ANCHOR: bus_dispatch
    /// A `size`-byte read at `ipa`, zero-extended.
    pub fn read(&self, ipa: u64, size: AccessSize) -> Result<u64, BusError> {
        let (e, offset) = self.route(ipa, size)?;
        let value = lock(&e.dev).read(offset, size);
        Ok(value & size.mask())
    }

    /// A `size`-byte write at `ipa`; only the low `size` bytes of `value` are passed on.
    pub fn write(&self, ipa: u64, size: AccessSize, value: u64) -> Result<(), BusError> {
        let (e, offset) = self.route(ipa, size)?;
        lock(&e.dev).write(offset, size, value & size.mask());
        Ok(())
    }
    // ANCHOR_END: bus_dispatch

    /// The name of the device at `ipa` and the offset inside it, if any.
    pub fn device_at(&self, ipa: u64) -> Option<(&'static str, u64)> {
        self.find(ipa).map(|(e, off)| (e.name, off))
    }

    /// The number of devices.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True if no device is registered.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
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

    /// Remembers the last access; reads return `offset` so routing is visible.
    #[derive(Default)]
    struct Probe {
        last: Option<(u64, AccessSize, Option<u64>)>,
    }

    impl MmioDevice for Probe {
        fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
            self.last = Some((offset, size, None));
            offset | 0xffff_ffff_0000_0000
        }
        fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
            self.last = Some((offset, size, Some(value)));
        }
    }

    fn dev() -> Arc<Mutex<Probe>> {
        Arc::new(Mutex::new(Probe::default()))
    }

    #[test]
    fn insert_rejects_overlap_zero_and_overflow() {
        let mut b = Bus::new();
        b.insert("a", 0x1000, 0x1000, dev()).unwrap();
        b.insert("c", 0x3000, 0x100, dev()).unwrap();
        b.insert("b", 0x2000, 0x1000, dev()).unwrap(); // exactly between: fine
        for (base, size) in [
            (0x1fff, 2),
            (0x0, 0x1001),
            (0x2fff, 0x2),
            (0x0, u64::MAX),
            (0x1800, 0x10),
        ] {
            assert!(
                matches!(
                    b.insert("x", base, size, dev()),
                    Err(BusError::Overlap { .. })
                ),
                "{base:#x}+{size:#x}"
            );
        }
        assert!(matches!(
            b.insert("z", 0x9000, 0, dev()),
            Err(BusError::InvalidRange { .. })
        ));
        assert!(matches!(
            b.insert("o", u64::MAX, 2, dev()),
            Err(BusError::InvalidRange { .. })
        ));
        // A window ending exactly at u64::MAX is fine (end = base + size fits).
        b.insert("top", u64::MAX - 0xfff, 0xfff, dev()).unwrap();
        assert_eq!(b.len(), 4);
        assert!(b.to_string_debug().contains("a 0x1000..0x2000"));
    }

    impl Bus {
        fn to_string_debug(&self) -> String {
            format!("{self:?}")
        }
    }

    #[test]
    fn routing_offsets_masks_and_straddles() {
        let mut b = Bus::new();
        let d = dev();
        b.insert("d", 0x0b00_0000, 0x1000, d.clone()).unwrap();
        assert_eq!(b.read(0x0b00_0010, AccessSize::B2), Ok(0x10));
        assert_eq!(
            b.read(0x0b00_0ff8, AccessSize::B8),
            Ok(0xffff_ffff_0000_0ff8)
        );
        b.write(0x0b00_0004, AccessSize::B1, 0x1234).unwrap();
        assert_eq!(
            d.lock().unwrap().last,
            Some((4, AccessSize::B1, Some(0x34)))
        );
        assert_eq!(
            b.read(0x0b00_0ffc, AccessSize::B8),
            Err(BusError::Straddle {
                ipa: 0x0b00_0ffc,
                size: AccessSize::B8
            })
        );
        assert_eq!(
            b.write(0x0b00_1000, AccessSize::B1, 0),
            Err(BusError::Unmapped { ipa: 0x0b00_1000 })
        );
        assert_eq!(
            b.read(0, AccessSize::B4),
            Err(BusError::Unmapped { ipa: 0 })
        );
        assert_eq!(b.device_at(0x0b00_0123), Some(("d", 0x123)));
        assert_eq!(b.device_at(0x0aff_ffff), None);
        assert!(Bus::new().is_empty());
        assert_eq!(Bus::new().device_at(u64::MAX), None);
    }

    #[test]
    fn access_size_helpers() {
        for (sas, n, m) in [
            (0u8, 1u64, 0xffu64),
            (1, 2, 0xffff),
            (2, 4, 0xffff_ffff),
            (3, 8, u64::MAX),
        ] {
            let s = AccessSize::from_sas(sas);
            assert_eq!((s.bytes(), s.mask()), (n, m));
            assert_eq!(AccessSize::from_bytes(n), Some(s));
            assert_eq!(AccessSize::from_sas(sas | 0xfc), s);
        }
        assert_eq!(AccessSize::from_bytes(3), None);
        assert_eq!(AccessSize::from_bytes(0), None);
    }

    /// PLAN M4 security test `bus_lookup_property` (MMIO-7): 10,000 random `(ipa, size)`
    /// against a linear-scan model, over a bus with windows packed around interesting edges
    /// (adjacent windows, one ending at `u64::MAX`). xorshift64*, fixed seed printed on
    /// failure (PLAN §0.3).
    #[test]
    fn bus_lookup_property() {
        let seed: u64 = std::env::var("MACVMM_SEED")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0x4d34_0b05_u64);
        let mut x = seed.max(1);
        let mut next = move || {
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            x.wrapping_mul(0x2545_f491_4f6c_dd1d)
        };
        let windows: &[(&'static str, u64, u64)] = &[
            ("w0", 0x0, 0x10),
            ("w1", 0x10, 0x8),
            ("w2", 0x1000, 0x1000),
            ("w3", 0x0b00_0000, 0x1000),
            ("w4", 0x0b00_1000, 0x200),
            ("w5", 0x4000_0000_0000, 0x3),
            ("w6", u64::MAX - 0xf, 0xf),
        ];
        let mut b = Bus::new();
        for &(n, base, size) in windows {
            b.insert(n, base, size, dev()).unwrap();
        }
        let edges: Vec<u64> = windows
            .iter()
            .flat_map(|&(_, base, size)| [base, base.wrapping_add(size)])
            .chain([u64::MAX, 0])
            .collect();
        let model = |ipa: u64, size: AccessSize| -> Result<u64, BusError> {
            for &(_, base, len) in windows {
                let end = base + len; // no window overflows (checked above)
                if ipa >= base && ipa < end {
                    return match ipa.checked_add(size.bytes()) {
                        Some(l) if l <= end => Ok(ipa - base),
                        _ => Err(BusError::Straddle { ipa, size }),
                    };
                }
            }
            Err(BusError::Unmapped { ipa })
        };
        for i in 0..10_000u32 {
            let r = next();
            let ipa = if r % 4 == 0 {
                next()
            } else {
                edges[(next() % edges.len() as u64) as usize]
                    .wrapping_add(next() % 24)
                    .wrapping_sub(12)
            };
            let size = AccessSize::from_sas((next() & 3) as u8);
            let want = model(ipa, size);
            // The probe device returns the offset in its low bits, masked by the bus.
            let got = b.read(ipa, size);
            let want_read = want
                .clone()
                .map(|off| (off | 0xffff_ffff_0000_0000) & size.mask());
            assert_eq!(
                got, want_read,
                "seed {seed:#x} iter {i} ipa {ipa:#x} {size:?}"
            );
            assert_eq!(
                b.write(ipa, size, next()),
                want.clone().map(|_| ()),
                "seed {seed:#x} iter {i}"
            );
            assert_eq!(
                b.device_at(ipa).map(|(_, off)| off),
                model(ipa, AccessSize::B1).ok(),
                "seed {seed:#x} iter {i}"
            );
        }
    }
}
