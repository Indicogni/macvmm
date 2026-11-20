//! Mutators: how a fuzz input becomes a slightly wrong one.
//!
//! **Why structural mutators.** A purely random byte flip almost never turns a well-formed
//! virtqueue into an *interesting* malformed one: the bugs we hunt sit behind specific shapes
//! (a `next` that points back at an earlier descriptor, a length that ends in the hole between two
//! RAM regions, a flags word with `INDIRECT` and `NEXT` both set). Coverage-guided fuzzers find
//! those shapes by feedback; this one is dependency-free and blind (threat model §9.3), so it is
//! told where the shapes are. Each target lays its input out with fixed offsets and calls the
//! record mutators below on the right ranges (virtio 1.2 §2.7.5: a split-ring descriptor is
//! `{le64 addr, le32 len, le16 flags, le16 next}`).
//!
//! The byte mutators are biased the other way for text: toward the bytes that start terminal
//! escape sequences (ESC, `[`, `]`, `P`, `_`, the C1 CSI `0x9b`) and UTF-8 lead bytes, which is
//! where the TTY-3 filter's state machine has its edges (threat model §7.5).

use crate::rng::Rng;

/// Bytes that start or steer terminal escape sequences (ECMA-48 §5.3–§5.6) and UTF-8 lead bytes
/// (RFC 3629 §3), plus a few classics.
pub const INTERESTING_BYTES: [u8; 16] = [
    0x1b, b'[', b']', b'P', b'_', 0x9b, 0x9d, 0x07, 0xc2, 0xe2, 0xf0, 0x80, 0x00, 0xff, b';', b'?',
];

/// Integers that sit on boundaries (0, 1, powers of two, all-ones, sign bits).
pub const INTERESTING_U64: [u64; 14] = [
    0,
    1,
    2,
    0x7f,
    0x80,
    0xff,
    0xffff,
    0x8000_0000,
    0xffff_ffff,
    0x1_0000_0000,
    0x7fff_ffff_ffff_ffff,
    0x8000_0000_0000_0000,
    u64::MAX - 1,
    u64::MAX,
];

/// Write `v`'s low `n` bytes little-endian at `off`, if they fit.
pub fn put_le(buf: &mut [u8], off: usize, n: usize, v: u64) {
    let bytes = v.to_le_bytes();
    if let (Some(dst), Some(src)) = (
        off.checked_add(n).and_then(|end| buf.get_mut(off..end)),
        bytes.get(..n),
    ) {
        dst.copy_from_slice(src);
    }
}

/// Read `n` bytes little-endian at `off` (missing bytes read as 0).
pub fn get_le(buf: &[u8], off: usize, n: usize) -> u64 {
    let mut b = [0u8; 8];
    for (i, slot) in b.iter_mut().enumerate().take(n.min(8)) {
        *slot = off
            .checked_add(i)
            .and_then(|at| buf.get(at))
            .copied()
            .unwrap_or(0);
    }
    u64::from_le_bytes(b)
}

/// One generic byte-level mutation of `buf`, keeping it at most `max_len` bytes long.
pub fn bytes(rng: &mut Rng, buf: &mut Vec<u8>, max_len: usize) {
    if buf.is_empty() {
        buf.push(rng.byte());
        return;
    }
    let at = rng.index(buf.len());
    match rng.below(9) {
        // Flip one bit.
        0 => {
            if let Some(b) = buf.get_mut(at) {
                *b ^= 1u8 << rng.below(8);
            }
        }
        // A random byte.
        1 => {
            if let Some(b) = buf.get_mut(at) {
                *b = rng.byte();
            }
        }
        // An escape-biased byte.
        2 | 3 => {
            if let (Some(b), Some(v)) = (buf.get_mut(at), rng.pick(&INTERESTING_BYTES)) {
                *b = v;
            }
        }
        // A boundary integer of width 1, 2, 4 or 8.
        4 => {
            let n = 1usize << rng.below(4);
            let v = rng.pick(&INTERESTING_U64).unwrap_or(0);
            put_le(buf, at, n, v);
        }
        // Insert a short run of interesting bytes.
        5 => {
            let n = 1 + rng.index(8);
            for _ in 0..n {
                if buf.len() >= max_len {
                    break;
                }
                let v = rng.pick(&INTERESTING_BYTES).unwrap_or(0);
                buf.insert(at.min(buf.len()), v);
            }
        }
        // Delete a range.
        6 => {
            let n = 1 + rng.index(16);
            let end = at.saturating_add(n).min(buf.len());
            buf.drain(at..end);
        }
        // Duplicate a range (repeats, as in nested sequences).
        7 => {
            let n = 1 + rng.index(32);
            let end = at.saturating_add(n).min(buf.len());
            let chunk: Vec<u8> = buf.get(at..end).map(<[u8]>::to_vec).unwrap_or_default();
            let room = max_len.saturating_sub(buf.len());
            let take = chunk.len().min(room);
            let tail = buf.split_off(at);
            buf.extend_from_slice(chunk.get(..take).unwrap_or_default());
            buf.extend_from_slice(&tail);
        }
        // Add or subtract a small delta from a byte (off-by-one hunting).
        _ => {
            if let Some(b) = buf.get_mut(at) {
                *b = if rng.coin() {
                    b.wrapping_add(1)
                } else {
                    b.wrapping_sub(1)
                };
            }
        }
    }
    buf.truncate(max_len);
}

/// Descriptor flags (virtio 1.2 §2.7.5): NEXT, WRITE, INDIRECT.
const F_NEXT: u64 = 1;
const F_WRITE: u64 = 2;
const F_INDIRECT: u64 = 4;

/// Field offsets inside one 16-byte descriptor record.
const ADDR: usize = 0;
const LEN: usize = 8;
const FLAGS: usize = 12;
const NEXT: usize = 14;

/// Where guest RAM is, so address mutations can aim at its edges.
#[derive(Clone, Copy, Debug)]
pub struct RamShape<'a> {
    /// `(base, size)` of each region, sorted.
    pub regions: &'a [(u64, u64)],
    /// Interesting non-RAM addresses (device windows, the rings themselves).
    pub specials: &'a [u64],
}

/// One structural mutation of the descriptor table of `n` 16-byte records at `table` inside
/// `buf` (module docs). The shapes, from threat model §9.3 "virtqueue":
/// - **flip flags**: toggle NEXT, WRITE or INDIRECT (a readable after a writable, an indirect
///   with NEXT, a nested indirect);
/// - **point `next` at an earlier node**: a loop the hop budget must stop (VQ-5);
/// - **overflow lengths**: `len` = 0, `u32::MAX`, or exactly long enough to end inside a
///   *different* RAM region, across the hole (VQ-4: a buffer lies entirely in one region);
/// - **aim the address**: the last bytes of a region, a hole, a device window, the ring itself.
pub fn descriptor(rng: &mut Rng, buf: &mut [u8], table: usize, n: usize, ram: &RamShape<'_>) {
    if n == 0 {
        return;
    }
    let i = rng.index(n);
    let Some(rec) = i.checked_mul(16).and_then(|o| o.checked_add(table)) else {
        return;
    };
    match rng.below(6) {
        0 => {
            let bit = rng.pick(&[F_NEXT, F_WRITE, F_INDIRECT]).unwrap_or(F_NEXT);
            let flags = get_le(buf, rec + FLAGS, 2) ^ bit;
            put_le(buf, rec + FLAGS, 2, flags);
        }
        1 => {
            // A back edge: next = some j <= i, with NEXT set.
            let j = rng.index(i + 1);
            put_le(buf, rec + NEXT, 2, j as u64);
            let flags = get_le(buf, rec + FLAGS, 2) | F_NEXT;
            put_le(buf, rec + FLAGS, 2, flags);
        }
        2 => {
            let addr = get_le(buf, rec + ADDR, 8);
            let len = match rng.below(4) {
                0 => 0,
                1 => u64::from(u32::MAX),
                2 => 0x8000_0000,
                // End a few bytes into another region (crossing the hole between them).
                _ => {
                    let target = ram
                        .regions
                        .get(rng.index(ram.regions.len()))
                        .map_or(0, |&(b, s)| b.wrapping_add(rng.below(s.clamp(1, 64))));
                    target.wrapping_sub(addr).wrapping_add(1) & 0xffff_ffff
                }
            };
            put_le(buf, rec + LEN, 4, len);
        }
        3 => {
            let addr = match rng.below(4) {
                // The last few bytes of a region.
                0 => ram
                    .regions
                    .get(rng.index(ram.regions.len()))
                    .map_or(0, |&(b, s)| {
                        b.wrapping_add(s).wrapping_sub(1 + rng.below(32))
                    }),
                // Just past a region's end (the hole, or beyond RAM).
                1 => ram
                    .regions
                    .get(rng.index(ram.regions.len()))
                    .map_or(0, |&(b, s)| b.wrapping_add(s).wrapping_add(rng.below(16))),
                2 => ram
                    .specials
                    .get(rng.index(ram.specials.len()))
                    .copied()
                    .unwrap_or(0),
                _ => rng.pick(&INTERESTING_U64).unwrap_or(0),
            };
            put_le(buf, rec + ADDR, 8, addr);
        }
        4 => {
            // A long forward chain: NEXT to i + 1 (walks the whole table).
            put_le(buf, rec + NEXT, 2, ((i + 1) % n) as u64);
            let flags = get_le(buf, rec + FLAGS, 2) | F_NEXT;
            put_le(buf, rec + FLAGS, 2, flags);
        }
        _ => {
            let v = rng.pick(&INTERESTING_U64).unwrap_or(0);
            put_le(buf, rec + NEXT, 2, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutators_respect_bounds() {
        let mut rng = Rng::new(9);
        let regions = [(0x1000u64, 0x1000u64), (0x4000, 0x100)];
        let shape = RamShape {
            regions: &regions,
            specials: &[0x10],
        };
        for _ in 0..10_000 {
            let mut b = rng.bytes(64);
            bytes(&mut rng, &mut b, 80);
            assert!(b.len() <= 80);
            let mut t = vec![0u8; 64];
            descriptor(&mut rng, &mut t, 0, 4, &shape);
            descriptor(&mut rng, &mut t, 60, 4, &shape); // out of range: ignored
            assert_eq!(t.len(), 64);
        }
        assert_eq!(get_le(&[1, 2], 0, 4), 0x0201);
    }
}
