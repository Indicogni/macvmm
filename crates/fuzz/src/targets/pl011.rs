//! Target `pl011`: the PL011 UART model (`vmm::devices::pl011`; Arm PrimeCell UART (PL011)
//! TRM DDI 0183G §3; threat model MMIO-7, MMIO-9, TTY-1, TTY-10) under arbitrary register
//! sequences and host input.
//!
//! **Input:** MMIO operations (`mmio_ops`); the "event" bit pushes the value's low byte as host
//! keyboard input (the stdin thread's path, TTY-10).
//!
//! **Invariants** (threat model §9.3): no panic; every read fits its width; after every access
//! the interrupt line equals `(RIS & IMSC) != 0`, i.e. `MIS != 0` (TRM §3.3.12, level-sensitive
//! UARTINTR); everything written to the sink passed the terminal filter (TTY-1).

use super::{Probe, fits, mmio_ops, mmio_seed};
use crate::Target;
use crate::rng::Rng;
use std::sync::{Arc, Mutex};
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SerialInput, Sink};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl011::{
    CR, DMACR, DR, FR, IBRD, ICR, IFLS, IMSC, LCR_H, MIS, PL011_SIZE, Pl011, RIS,
};
use vmm::irq::TestIrq;

pub const TARGET: Target = Target {
    name: "pl011",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 11 * 512,
};

const REGS: [u64; 11] = [DR, FR, IBRD, LCR_H, CR, IFLS, IMSC, RIS, MIS, ICR, DMACR];

pub fn run(data: &[u8]) -> crate::Verdict {
    let out = Probe::default();
    let sink = Arc::new(Sink::new("fuzz", Box::new(out.clone()), FilterPolicy::Safe));
    let input = Arc::new(SerialInput::new());
    let irq = Arc::new(TestIrq::new());
    let uart = Arc::new(Mutex::new(Pl011::new(
        sink,
        Some(input.clone()),
        irq.clone(),
    )));
    // The production hook (machine/mod.rs): a push wakes the UART.
    let weak = Arc::downgrade(&uart);
    input.set_hook(Some(Arc::new(move || {
        if let Some(u) = weak.upgrade()
            && let Ok(mut u) = u.lock()
        {
            u.input_ready();
        }
    })));
    for op in mmio_ops(data, PL011_SIZE) {
        if op.event {
            input.push(&[op.value.to_le_bytes()[0]]);
        }
        let mut u = uart.lock().map_err(|_| "uart lock poisoned")?;
        if op.write {
            u.write(op.offset, op.size, op.value);
        } else {
            let v = u.read(op.offset, op.size);
            fits(&op, v)?;
        }
        let mis = u.read(MIS, AccessSize::B4);
        if irq.level() != (mis != 0) {
            return Err(format!(
                "irq line {} with MIS {mis:#x} after {op:?}",
                irq.level()
            ));
        }
    }
    let bytes = out.bytes();
    if !super::ansi::strictly_allowed(&bytes) {
        return Err(format!(
            "sink got unfiltered bytes: {}",
            bytes.escape_ascii()
        ));
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let n = 1 + rng.index(64);
    mmio_seed(rng, &REGS, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(16);
        for _ in 0..1_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 11 * 512);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
