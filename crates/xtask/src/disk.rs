//! `cargo xtask mkdisk --size S --seed N --out F`: a deterministic test disk (PLAN M9; used by
//! the virtio-blk tests of M14).
//!
//! **Why a pattern and not zeros.** A block-device test must prove the guest read the *right*
//! sector, not just *a* sector: a disk of zeros cannot tell sector 7 from sector 70. Every
//! 8-byte word here is the next output of xorshift64* (Vigna 2016, the same PRNG as the host
//! property tests, PLAN §0.3) seeded with `N`, so the test (or the guest) recomputes the
//! expected bytes of any offset from the seed alone.
//!
//! The size must be a positive multiple of 512 (a virtio-blk sector, virtio 1.2 §5.2.4) and at
//! most [`MAX_DISK`]. The output is never written through a symlink.

use std::io::{self, BufWriter, Write};
use std::path::Path;

/// The largest disk this tool writes.
pub const MAX_DISK: u64 = 64 << 30;
/// A virtio-blk sector.
pub const SECTOR: u64 = 512;

/// xorshift64* (module docs).
#[derive(Clone, Debug)]
pub struct XorShift(pub u64);

impl XorShift {
    /// A generator from `seed` (0 is mapped to 1: xorshift's state must not be zero).
    pub fn new(seed: u64) -> XorShift {
        XorShift(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

/// Write `size` bytes of the pattern for `seed` to `w`.
pub fn write_pattern(w: &mut impl Write, size: u64, seed: u64) -> io::Result<()> {
    let mut rng = XorShift::new(seed);
    let mut chunk = vec![0u8; 64 << 10];
    let mut left = size;
    while left > 0 {
        let n = left.min(chunk.len() as u64) as usize;
        for word in chunk[..n].chunks_mut(8) {
            let v = rng.next_u64().to_le_bytes();
            word.copy_from_slice(&v[..word.len()]);
        }
        w.write_all(&chunk[..n])?;
        left -= n as u64;
    }
    Ok(())
}

/// `cargo xtask mkdisk`.
pub fn run(size: u64, seed: u64, out: &Path) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if size == 0 || !size.is_multiple_of(SECTOR) || size > MAX_DISK {
        return Err(format!(
            "--size must be a positive multiple of {SECTOR} bytes, at most {MAX_DISK}"
        ));
    }
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(crate::O_NOFOLLOW)
        .open(out)
        .map_err(|e| format!("cannot create {}: {e}", out.display()))?;
    if !f.metadata().map(|m| m.is_file()).unwrap_or(false) {
        return Err(format!("{} is not a regular file", out.display()));
    }
    let mut w = BufWriter::new(f);
    write_pattern(&mut w, size, seed)
        .and_then(|()| w.flush())
        .map_err(|e| format!("cannot write {}: {e}", out.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pattern_is_deterministic_and_seeded() {
        let mut a = Vec::new();
        let mut b = Vec::new();
        let mut c = Vec::new();
        write_pattern(&mut a, 4096, 7).unwrap();
        write_pattern(&mut b, 4096, 7).unwrap();
        write_pattern(&mut c, 4096, 8).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        let mut r = XorShift::new(7);
        assert_eq!(a[..8], r.next_u64().to_le_bytes());
        let mut odd = Vec::new();
        write_pattern(&mut odd, 13, 7).unwrap();
        assert_eq!(odd[..], a[..13]);
    }
}
