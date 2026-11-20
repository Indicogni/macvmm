//! Target `insn`: the ISV=0 instruction decoder and emulator (`vmm::arch::insn`; Arm ARM C4.1
//! "A64 instruction set encoding", C6.2 load/store pages; threat model MMIO-4..MMIO-6).
//!
//! **Input:** the instruction word (4 bytes), four register values (base, index, rt, rt2), an
//! exit-IPA selector, the WnR bit, and the device window's base offset.
//!
//! **Invariants** (threat model §9.3 "insn"): `decode` is total; for a load/store, planning is
//! total and a plan that executes makes **exactly one or two** bus accesses (two only for a
//! pair), each inside the single device window that was checked, of the decoded size; the first
//! access is at the exit IPA (MMIO-4: the syndrome's IPA, not the decoded address, is the
//! authority); a register writeback is reported only together with a successful commit, and
//! only for a writeback form.

use super::Input;
use crate::Target;
use crate::rng::Rng;
use vmm::arch::insn::{ExitFacts, Insn, Isv0Bus, Mapped, Operands, decode, execute, plan_isv0};
use vmm::bus::AccessSize;

pub const TARGET: Target = Target {
    name: "insn",
    run,
    seed,
    mutate: super::no_structure,
    max_len: 48,
};

/// A device window and a log of accesses.
struct Bus {
    base: u64,
    len: u64,
    log: Vec<(u64, u64, bool)>,
    fail_at: Option<usize>,
}

impl Isv0Bus for Bus {
    type Error = ();
    fn window(&self, ipa: u64, size: AccessSize) -> Option<u64> {
        super::within(ipa, size.bytes(), self.base, self.len).then_some(self.base)
    }
    fn read(&mut self, ipa: u64, size: AccessSize) -> Result<u64, ()> {
        self.log.push((ipa, size.bytes(), false));
        if self.fail_at == Some(self.log.len()) {
            return Err(());
        }
        Ok(0x1122_3344_5566_7788 & size.mask())
    }
    fn write(&mut self, ipa: u64, size: AccessSize, _value: u64) -> Result<(), ()> {
        self.log.push((ipa, size.bytes(), true));
        if self.fail_at == Some(self.log.len()) {
            return Err(());
        }
        Ok(())
    }
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut i = Input::new(data);
    let word = i.u32();
    let ops = Operands {
        base: i.u64(),
        index: i.u64(),
        rt: i.u64(),
        rt2: i.u64(),
    };
    let sel = i.u8();
    let wnr = i.bool();
    let fail = i.u8() % 4;
    let Ok(Insn::Mem(m)) = decode(word) else {
        return Ok(()); // total: an Err or a non-memory instruction is a fine answer
    };
    let (va, _) = m.addresses(ops.base, ops.index);
    // Stage 1: 4 KiB pages mapped VA -> IPA one to one.
    let mut translate = |va: u64| -> Option<Mapped> {
        Some(Mapped {
            ipa: va,
            mapping_size: 0x1000,
        })
    };
    let exit_ipa = match sel % 3 {
        0 => va,
        1 => va ^ 0x10,
        _ => va.wrapping_add(u64::from(sel)),
    };
    let window = exit_ipa & !0xfff;
    let mut bus = Bus {
        base: window,
        len: 0x1000,
        log: Vec::new(),
        fail_at: (fail > 0).then_some(usize::from(fail)),
    };
    let exit = ExitFacts { ipa: exit_ipa, wnr };
    let Ok(plan) = plan_isv0(&m, &ops, exit, &mut translate, &bus) else {
        return Ok(());
    };
    if plan.first.ipa != exit_ipa {
        return Err(format!(
            "first access at {:#x}, exit IPA {exit_ipa:#x} (MMIO-4)",
            plan.first.ipa
        ));
    }
    if plan.writeback.is_some() != m.writes_back() {
        return Err(format!("writeback {:?} for {m:?}", plan.writeback));
    }
    let result = execute(&plan, &mut bus);
    let want = 1 + usize::from(plan.second.is_some());
    let made = bus.log.len();
    match &result {
        Ok(commit) => {
            if made != want {
                return Err(format!("{made} bus accesses for {m:?} (expected {want})"));
            }
            if commit.writeback != plan.writeback {
                return Err("the commit's writeback differs from the plan's".into());
            }
        }
        Err(()) => {
            if made > want {
                return Err(format!("{made} bus accesses after a failure"));
            }
        }
    }
    for &(ipa, len, write) in &bus.log {
        if !super::within(ipa, len, bus.base, bus.len) || len != m.size.bytes() {
            return Err(format!(
                "access {ipa:#x}+{len} outside the checked window {:#x} or of the wrong size",
                bus.base
            ));
        }
        if write != m.is_store() {
            return Err("access direction differs from the instruction".into());
        }
    }
    Ok(())
}

/// Load/store encodings around the classes the emulator handles (C4.1.94).
fn seed(rng: &mut Rng) -> Vec<u8> {
    let words = [
        0xa9bf_7bfdu32, // stp x29, x30, [sp, #-16]!
        0xf940_0000,    // ldr x0, [x0]
        0xb800_0420,    // str w0, [x1], #0
        0x3940_0020,    // ldrb w0, [x1]
        0x7900_0020,    // strh w0, [x1]
        0x2940_0420,    // ldp w0, w1, [x1]
        0x6940_0420,    // ldpsw x0, x1, [x1]
        0xf860_6820,    // ldr x0, [x1, x0]
        0x3880_0c20,    // ldrsb x0, [x1, #0]!
    ];
    let mut w = rng.pick(&words).unwrap_or(0);
    if rng.coin() {
        w ^= 1 << rng.below(32);
    }
    let mut b = w.to_le_bytes().to_vec();
    let base = (1u64 << 30) + (rng.below(1 << 20) & !7);
    b.extend_from_slice(&base.to_le_bytes());
    b.extend_from_slice(&rng.below(64).to_le_bytes());
    b.extend_from_slice(&rng.next_u64().to_le_bytes());
    b.extend_from_slice(&rng.next_u64().to_le_bytes());
    b.push(rng.byte() & 0xfc);
    b.push(u8::from(w & (1 << 22) == 0));
    b.push(rng.byte());
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(14);
        for _ in 0..20_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            crate::mutate::bytes(&mut r, &mut s, 48);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
