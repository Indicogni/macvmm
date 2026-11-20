//! Target `pl031`: the PL031 real-time clock (`vmm::devices::pl031`; Arm PrimeCell RTC (PL031)
//! TRM DDI 0224C §3; threat model MMIO-7) with a controllable clock.
//!
//! **Input:** MMIO operations (`mmio_ops`); the "event" bit advances the host clock by the
//! value's low 16 bits of seconds (so the match interrupt can fire).
//!
//! **Invariants:** no panic; every read fits its width; after every access the interrupt line
//! equals `MIS != 0` (`RIS & IMSC`, TRM §3.3.6–§3.3.8).

use super::{fits, mmio_ops, mmio_seed};
use crate::Target;
use crate::rng::Rng;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl031::{CR, DR, ICR, IMSC, LR, MIS, MR, PL031_SIZE, Pl031, RIS};
use vmm::irq::TestIrq;

pub const TARGET: Target = Target {
    name: "pl031",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 11 * 512,
};

const REGS: [u64; 8] = [DR, MR, LR, CR, IMSC, RIS, MIS, ICR];

pub fn run(data: &[u8]) -> crate::Verdict {
    let now = Arc::new(AtomicU64::new(1_700_000_000));
    let n = Arc::clone(&now);
    let irq = Arc::new(TestIrq::new());
    let mut rtc = Pl031::with_clock(Box::new(move || n.load(Ordering::SeqCst)), irq.clone());
    for op in mmio_ops(data, PL031_SIZE) {
        if op.event {
            now.fetch_add(op.value & 0xffff, Ordering::SeqCst);
        }
        if op.write {
            rtc.write(op.offset, op.size, op.value);
        } else {
            let v = rtc.read(op.offset, op.size);
            fits(&op, v)?;
        }
        let mis = rtc.read(MIS, AccessSize::B4);
        if irq.level() != (mis != 0) {
            return Err(format!(
                "irq {} with MIS {mis:#x} after {op:?}",
                irq.level()
            ));
        }
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let n = 1 + rng.index(32);
    mmio_seed(rng, &REGS, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(17);
        for _ in 0..1_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 11 * 512);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
