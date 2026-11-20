//! Target `razwi`: the read-as-zero, write-ignored window (`vmm::devices::razwi`; the GIC
//! redistributor remainder of architecture §5.1; threat model MMIO-7).
//!
//! **Invariants:** no panic; every read returns 0 whatever was written before.

use super::{mmio_ops, mmio_seed};
use crate::Target;
use crate::rng::Rng;
use vmm::bus::MmioDevice;
use vmm::devices::razwi::RazWi;

pub const TARGET: Target = Target {
    name: "razwi",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 11 * 512,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut d = RazWi::new("fuzz");
    for op in mmio_ops(data, 0x1_0000) {
        if op.write {
            d.write(op.offset, op.size, op.value);
        } else {
            let v = d.read(op.offset, op.size);
            if v != 0 {
                return Err(format!("RAZ read {:#x} returned {v:#x}", op.offset));
            }
        }
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let n = 1 + rng.index(32);
    mmio_seed(rng, &[0, 4, 8, 0xffc], n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(19);
        for _ in 0..1_000 {
            assert_eq!(run(&seed(&mut r)), Ok(()));
        }
    }
}
