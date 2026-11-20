//! `Entropy`: the VMM's one source of randomness, the host OS CSPRNG (threat model FDT-3;
//! architecture §6.7 `HostIo.entropy`, §12.2).
//!
//! **What it is for.** M7 fills the device tree's `/chosen/rng-seed` (64 bytes) and
//! `/chosen/kaslr-seed` (a `u64`) from it on every boot. Linux mixes `rng-seed` into its
//! entropy pool before the first random number is drawn (`drivers/of/fdt.c`,
//! `early_init_dt_scan_chosen` → `add_bootloader_randomness`) and randomises the kernel's
//! virtual base with `kaslr-seed` (`arch/arm64/kernel/pi/kaslr_early.c`). M12's virtio-rng
//! reads the same source.
//!
//! **Why `getentropy(2)` and nothing else.** A predictable seed is a real weakness (threat
//! model §4, row I: a fixed test seed in production would give every guest the same KASLR
//! offset and the same initial pool), so:
//! - the only constructor is [`Entropy::os`]; there is no "fixed" variant, and no CLI flag
//!   sets a seed. Deterministic seeds exist only as plain fields of
//!   `fdt::machine::MachineDesc`, which tests build directly;
//! - it is a syscall, not a path: nothing is opened, so it is not an input under HOSTIO-1 and it
//!   keeps working after the M22 sandbox lockdown;
//! - requests are split into ≤ 256-byte calls (`GETENTROPY_MAX`), the kernel's limit.
//!
//! The bytes are secrets of the guest: they are never logged, and `--dtb-out` zeroes them
//! (FDT-4, `fdt::machine::redact_seeds`).

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use hvf::host::GETENTROPY_MAX;

/// A handle on the host CSPRNG (module docs). Cheap; holds no descriptor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entropy {
    _private: (),
}

impl Entropy {
    /// The OS CSPRNG (`getentropy(2)`).
    pub fn os() -> Entropy {
        Entropy { _private: () }
    }

    // ANCHOR: entropy_fill
    /// Fill `buf` with random bytes, in ≤ 256-byte `getentropy(2)` calls.
    pub fn fill(&self, buf: &mut [u8]) -> std::io::Result<()> {
        for chunk in buf.chunks_mut(GETENTROPY_MAX) {
            hvf::host::getentropy(chunk)?;
        }
        Ok(())
    }
    // ANCHOR_END: entropy_fill

    /// A random `u64`.
    pub fn u64(&self) -> std::io::Result<u64> {
        let mut b = [0u8; 8];
        self.fill(&mut b)?;
        Ok(u64::from_ne_bytes(b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_large_buffers_in_chunks_and_differs() {
        let e = Entropy::os();
        let mut a = vec![0u8; 1000]; // four calls, the last one short
        let mut b = vec![0u8; 1000];
        e.fill(&mut a).unwrap();
        e.fill(&mut b).unwrap();
        assert_ne!(a, b);
        // 1000 random bytes with a 256-byte all-zero tail would be a chunking bug.
        assert!(a.iter().skip(744).any(|&x| x != 0));
        assert_ne!(e.u64().unwrap(), e.u64().unwrap());
        assert!(hvf::host::getentropy(&mut [0u8; GETENTROPY_MAX + 1]).is_err());
        e.fill(&mut []).unwrap();
    }
}
