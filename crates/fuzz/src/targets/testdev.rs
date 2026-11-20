//! Target `testdev`: the `--testdev` register file (`vmm::devices::testdev`; threat model
//! MMIO-7, MMIO-8).
//!
//! **Input:** MMIO operations over its 4 KiB window.
//!
//! **Invariants:** no panic, every read fits its width, and the device agrees with a byte-array
//! reference model of its contract: a naturally aligned N-byte access reads or writes bytes
//! `[offset, offset + N)` little-endian; a misaligned one is read-as-zero, write-ignored
//! (MMIO-8).

use super::{fits, mmio_ops, mmio_seed};
use crate::Target;
use crate::rng::Rng;
use vmm::bus::MmioDevice;
use vmm::devices::testdev::TestDev;

pub const TARGET: Target = Target {
    name: "testdev",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 11 * 512,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut d = TestDev::new();
    let mut model = vec![0u8; 0x1000];
    for op in mmio_ops(data, 0x1000) {
        let n = usize::try_from(op.size.bytes()).unwrap_or(8);
        let at = usize::try_from(op.offset).unwrap_or(usize::MAX);
        let aligned = at.is_multiple_of(n) && at.saturating_add(n) <= model.len();
        if op.write {
            d.write(op.offset, op.size, op.value);
            if let (true, Some(dst)) = (aligned, model.get_mut(at..at.saturating_add(n))) {
                dst.copy_from_slice(op.value.to_le_bytes().get(..n).unwrap_or_default());
            }
        } else {
            let v = d.read(op.offset, op.size);
            fits(&op, v)?;
            let want = match (aligned, model.get(at..at.saturating_add(n))) {
                (true, Some(src)) => crate::mutate::get_le(src, 0, n),
                _ => 0,
            };
            if v != want {
                return Err(format!(
                    "{n}-byte read at {:#x} = {v:#x}, the reference model says {want:#x}",
                    op.offset
                ));
            }
        }
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let regs: Vec<u64> = (0..16).map(|i| i * 8).collect();
    let n = 1 + rng.index(32);
    mmio_seed(rng, &regs, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(18);
        for _ in 0..1_000 {
            let s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
