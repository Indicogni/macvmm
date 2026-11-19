//! Property tests for guest memory (PLAN M2 security tests `volatile_copy_property` and
//! `vec_memory_access_log`; threat model MEM-2, MEM-5, MEM-7).
//!
//! **`volatile_copy_property`**: 10,000 random `(addr, len)` pairs (more under `--release`),
//! biased towards region edges and `u64::MAX`, must be judged identically by
//! - a `u128` model, which cannot overflow: accepted iff `len > 0` and
//!   `[addr, addr + len)` lies inside one region;
//! - `RegionTable::locate`, the pure range function `GuestRam` uses;
//! - `VecMemory`, through `check_range`, `read` and `write`, with data checked against a shadow
//!   copy of every region.
//!
//! The same property over real `hv_vm_allocate` memory and the volatile copy loops is
//! `volatile_copy_property_guest_ram` in `hvf_memory.rs`.
//!
//! The PRNG is a dependency-free xorshift64* (PLAN §0.3). The seed is printed on failure;
//! `MACVMM_SEED=<n>` replays one.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::arch::layout::RAM_BASE;
use vmm::memory::{
    GuestAddress, GuestMemory, GuestMemoryOrdered, MemoryError, Mutation, RegionTable, VecMemory,
};

/// xorshift64* (Vigna 2016): small, fast, good enough to drive tests.
struct XorShift(u64);

impl XorShift {
    fn new(seed: u64) -> XorShift {
        XorShift(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn seed() -> u64 {
    std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x6d61_6376_6d6d_0002)
}

fn iterations() -> usize {
    if cfg!(debug_assertions) {
        10_000
    } else {
        200_000
    }
}

/// Two adjacent regions (still two accesses' worth, never one) and one that ends exactly at
/// `1 << 40`, the IPA limit `VecMemory` validates against.
fn regions() -> Vec<(GuestAddress, u64)> {
    vec![
        (GuestAddress(RAM_BASE), 0x1_0000),
        (GuestAddress(RAM_BASE + 0x1_0000), 0x4000),
        (GuestAddress((1 << 40) - 0x4000), 0x4000),
    ]
}

/// The model: `Some((region index, offset))` iff the access is valid.
fn model(regions: &[(GuestAddress, u64)], addr: u64, len: u64) -> Option<(usize, u64)> {
    let (a, l) = (u128::from(addr), u128::from(len));
    if l == 0 {
        return None;
    }
    // `regions()` is sorted by base, so its indices are the table's.
    regions.iter().enumerate().find_map(|(idx, r)| {
        let (b, s) = (u128::from(r.0.0), u128::from(r.1));
        (a >= b && a + l <= b + s).then(|| (idx, addr - r.0.0))
    })
}

/// A random access, biased towards the interesting places.
fn pick(rng: &mut XorShift, regions: &[(GuestAddress, u64)]) -> (u64, u64) {
    let edges: Vec<u64> = regions
        .iter()
        .flat_map(|r| [r.0.0, r.0.0 + r.1])
        .chain([0, u64::MAX, u64::MAX - 7, 1 << 40])
        .collect();
    let addr = match rng.below(4) {
        0 => rng.next(),
        _ => {
            let e = edges[rng.below(edges.len() as u64) as usize];
            e.wrapping_add(rng.below(64)).wrapping_sub(32)
        }
    };
    let len = match rng.below(8) {
        0 => 0,
        1 => u64::MAX - rng.below(16),
        2 => rng.below(0x2_0000),
        3 => 1 << rng.below(17),
        _ => rng.below(72),
    };
    (addr, len)
}

#[test]
fn volatile_copy_property() {
    let seed = seed();
    let mut rng = XorShift::new(seed);
    let regions = regions();
    let table = RegionTable::new(&regions, 40).unwrap();
    let mem = VecMemory::new(&regions).unwrap();
    let mut shadow: Vec<Vec<u8>> = table
        .spans()
        .iter()
        .map(|s| vec![0u8; s.size as usize])
        .collect();
    let mut accepted = 0usize;
    for i in 0..iterations() {
        let (addr, len) = pick(&mut rng, &regions);
        let ctx = format!("seed {seed} iteration {i}: addr {addr:#x} len {len:#x}");
        let want = model(&regions, addr, len);
        let got = table.locate(GuestAddress(addr), len);
        match (want, got) {
            (Some((idx, off)), Ok(at)) => assert_eq!((at.index, at.offset), (idx, off), "{ctx}"),
            (None, Err(e)) => {
                let overflows = u128::from(addr) + u128::from(len) > u128::from(u64::MAX);
                assert_eq!(
                    matches!(e, MemoryError::Overflow { .. }),
                    overflows,
                    "{ctx}: {e}"
                );
            }
            (w, g) => panic!("{ctx}: model {w:?}, locate {g:?}"),
        }
        assert_eq!(
            mem.check_range(GuestAddress(addr), len),
            want.is_some(),
            "{ctx}"
        );
        // Real copies only for lengths a buffer can have.
        if len > 0x2_0000 {
            continue;
        }
        let n = len as usize;
        if rng.below(2) == 0 {
            let data: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
            let r = mem.write(GuestAddress(addr), &data);
            assert_eq!(r.is_ok(), want.is_some(), "{ctx}: write {r:?}");
            if let Some((idx, off)) = want {
                shadow[idx][off as usize..off as usize + n].copy_from_slice(&data);
            }
        } else {
            let mut buf = vec![0x5a; n];
            let r = mem.read(GuestAddress(addr), &mut buf);
            assert_eq!(r.is_ok(), want.is_some(), "{ctx}: read {r:?}");
            match want {
                Some((idx, off)) => {
                    assert_eq!(buf, shadow[idx][off as usize..off as usize + n], "{ctx}")
                }
                None => assert!(buf.iter().all(|&b| b == 0x5a), "{ctx}: partial copy"),
            }
        }
        accepted += usize::from(want.is_some());
    }
    // The bias must actually produce both outcomes in quantity.
    assert!(
        accepted > iterations() / 10,
        "seed {seed}: only {accepted} accepted"
    );
}

#[test]
fn vec_memory_access_log() {
    let mem = VecMemory::new(&regions()).unwrap();
    let a = GuestAddress(RAM_BASE + 0x100);
    mem.write_u64(a, 0x1122_3344_5566_7788).unwrap(); // before the log: not recorded
    mem.enable_log();
    let mut buf = [0u8; 16];
    mem.read(a, &mut buf).unwrap();
    mem.read_u32(a).unwrap();
    assert!(mem.read_u32(GuestAddress(RAM_BASE - 4)).is_err()); // refused: not recorded
    mem.write_u16_release(a, 3).unwrap();
    mem.read_u16_acquire(a).unwrap();
    mem.write(GuestAddress(RAM_BASE + 0x1_0000), &[1, 2, 3])
        .unwrap();
    let log: Vec<_> = mem
        .log()
        .iter()
        .map(|x| (x.addr - RAM_BASE, x.len, x.write, x.ordered))
        .collect();
    assert_eq!(
        log,
        [
            (0x100, 16, false, false),
            (0x100, 4, false, false),
            (0x100, 2, true, true),
            (0x100, 2, false, true),
            (0x1_0000, 3, true, false),
        ]
    );
    assert_eq!(mem.reads(), 3);

    // The mutation hook plays a racing guest: the second read sees the rewritten bytes, which
    // is exactly what a device that double-fetches would see (MEM-7, VQ-4).
    mem.enable_log();
    mem.mutate_after(Mutation {
        after_reads: 4,
        addr: a,
        bytes: vec![0xff; 4],
    });
    let first = mem.read_u32(a).unwrap();
    let second = mem.read_u32(a).unwrap();
    assert_ne!(first, second);
    assert_eq!(second, 0xffff_ffff);
    assert_eq!(
        mem.log().len(),
        2,
        "the hook's write is the guest's, not logged"
    );
}
