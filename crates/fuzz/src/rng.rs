//! The fuzzers' pseudo-random number generator: xorshift64* (Vigna, "An experimental
//! exploration of Marsaglia's xorshift generators, scrambled", ACM TOMS 42(2), 2016).
//!
//! **Why this and not a crate.** The fuzz crate has no dependencies (PLAN M22 design notes), and
//! a fuzzer needs only two things from its generator: speed, and *determinism*. The same
//! `--seed` must replay the same inputs on every machine, so a failure seen once can be reproduced
//! by anyone (threat model TEST-3). xorshift64* is three shifts, three xors and a multiply; its
//! statistical quality is far beyond what input generation needs. It is **not** a CSPRNG and is
//! never used for anything a guest could exploit (the VMM's own randomness comes from
//! `getentropy(2)`, threat model FDT-3).
//!
//! The host property tests in `crates/vmm/tests/` use the same generator (`virtio_support`'s
//! `XorShift`), so a seed means the same stream in both places (PLAN §0.3).

/// xorshift64* state. The state is never 0 (0 is a fixed point of xorshift).
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
    /// A generator for `seed`; seed 0 is mapped to 1.
    pub fn new(seed: u64) -> Rng {
        Rng(seed.max(1))
    }

    /// A generator derived from `(seed, stream)`, so iteration `n` of a run can be regenerated
    /// without replaying iterations `0..n`. SplitMix64's finalizer decorrelates the two.
    pub fn derive(seed: u64, stream: u64) -> Rng {
        let mut z = seed ^ stream.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        Rng::new(z ^ (z >> 31))
    }

    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    /// A value in `0..n` (`0` when `n == 0`). The modulo bias is irrelevant here.
    pub fn below(&mut self, n: u64) -> u64 {
        self.next_u64().checked_rem(n).unwrap_or(0)
    }

    /// A `usize` in `0..n`.
    pub fn index(&mut self, n: usize) -> usize {
        usize::try_from(self.below(u64::try_from(n).unwrap_or(u64::MAX))).unwrap_or(0)
    }

    /// True with probability `1 / n`.
    pub fn one_in(&mut self, n: u64) -> bool {
        self.below(n) == 0
    }

    /// A random byte.
    pub fn byte(&mut self) -> u8 {
        self.next_u64().to_le_bytes()[0]
    }

    /// A random boolean.
    pub fn coin(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }

    /// One element of `items` (`None` if empty).
    pub fn pick<T: Copy>(&mut self, items: &[T]) -> Option<T> {
        items.get(self.index(items.len())).copied()
    }

    /// `n` random bytes.
    pub fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.byte()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_and_nonzero() {
        let a: Vec<u64> = (0..8)
            .map({
                let mut r = Rng::new(42);
                move |_| r.next_u64()
            })
            .collect();
        let b: Vec<u64> = (0..8)
            .map({
                let mut r = Rng::new(42);
                move |_| r.next_u64()
            })
            .collect();
        assert_eq!(a, b);
        assert!(a.iter().all(|&x| x != 0));
        // Seed 0 behaves like seed 1 rather than sticking at 0.
        assert_eq!(Rng::new(0).next_u64(), Rng::new(1).next_u64());
        assert_ne!(Rng::derive(7, 1).next_u64(), Rng::derive(7, 2).next_u64());
        assert_eq!(Rng::new(5).below(0), 0);
    }
}
