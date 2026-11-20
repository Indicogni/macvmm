//! Target `esr`: the `ESR_EL2` syndrome decoder (`vmm::arch::esr`; Arm ARM D24.2.47 ESR_EL2,
//! ISS encodings for EC 0x01, 0x16, 0x17, 0x18, 0x20, 0x24, 0x3c; threat model MMIO-1).
//!
//! **Input:** 8 bytes, the syndrome.
//!
//! **Invariants:** the decoder is total (MMIO-1: no `u64` makes it panic), and it
//! **round-trips**: re-encoding the fields it extracted reproduces exactly the bits it read, so
//! no field is taken from the wrong bit range or silently truncated.

use super::Input;
use crate::Target;
use crate::rng::Rng;
use vmm::arch::esr::{Exit, esr_ec};

pub const TARGET: Target = Target {
    name: "esr",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 8,
};

fn bits(v: u64, lo: u32, n: u32) -> u64 {
    (v >> lo) & ((1u64 << n) - 1)
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let esr = Input::new(data).u64();
    let exit = Exit::decode(esr);
    let ec = u8::try_from(bits(esr, 26, 6)).unwrap_or(0);
    if esr_ec(esr) != ec {
        return Err(format!(
            "esr_ec({esr:#x}) = {:#x}, bits 31:26 = {ec:#x}",
            esr_ec(esr)
        ));
    }
    let b = |lo, n| bits(esr, lo, n);
    let f = |x: bool| u64::from(x);
    let (got, want) = match exit {
        Exit::Wfx { ti } => (u64::from(ti), b(0, 2)),
        Exit::Hvc { imm } | Exit::Smc { imm } | Exit::Brk { imm } => (u64::from(imm), b(0, 16)),
        Exit::SysReg(s) => (
            u64::from(s.op0) << 20
                | u64::from(s.op2) << 17
                | u64::from(s.op1) << 14
                | u64::from(s.crn) << 10
                | u64::from(s.rt) << 5
                | u64::from(s.crm) << 1
                | f(s.read),
            b(0, 22),
        ),
        Exit::InstructionAbort { ifsc, s1ptw } => {
            (u64::from(ifsc) | f(s1ptw) << 7, b(0, 6) | b(7, 1) << 7)
        }
        Exit::DataAbort(d) => (
            f(d.isv) << 24
                | u64::from(d.sas) << 22
                | f(d.sse) << 21
                | u64::from(d.srt) << 16
                | f(d.sf) << 15
                | f(d.ar) << 14
                | f(d.fnv) << 10
                | f(d.s1ptw) << 7
                | f(d.wnr) << 6
                | u64::from(d.dfsc),
            esr & (1 << 24 | 3 << 22 | 1 << 21 | 0x1f << 16 | 3 << 14 | 1 << 10 | 3 << 6 | 0x3f),
        ),
        Exit::Unknown { ec: e, esr: kept } => {
            (u64::from(e) << 32 | kept, u64::from(ec) << 32 | esr)
        }
        Exit::Canceled | Exit::VtimerActivated => {
            return Err("an EXCEPTION syndrome decoded as a non-exception exit".into());
        }
    };
    if got != want {
        return Err(format!(
            "{exit:?} from {esr:#x}: fields re-encode to {got:#x}, the syndrome has {want:#x}"
        ));
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let ec = rng
        .pick(&[0x01u64, 0x16, 0x17, 0x18, 0x20, 0x24, 0x3c, 0x00, 0x3f])
        .unwrap_or(0);
    (ec << 26 | 1 << 25 | rng.below(1 << 25))
        .to_le_bytes()
        .to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep() {
        let mut r = Rng::new(13);
        for _ in 0..100_000 {
            assert_eq!(run(&r.next_u64().to_le_bytes()), Ok(()));
            assert_eq!(run(&seed(&mut r)), Ok(()));
        }
    }
}
