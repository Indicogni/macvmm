//! Target `smccc`: the SMCCC/PSCI dispatcher (`vmm::smccc`, `vmm::psci`; Arm DEN 0028 SMCCC
//! §2–§3, DEN 0022 PSCI §5; threat model HC-1, HC-3, HC-4, HC-7) on arbitrary calls from
//! 1–4 vCPUs.
//!
//! **Input:** byte 0 the vCPU count (1..=4; MPIDRs `0..n` in Aff0), byte 1 debug calls on or
//! off (HC-2), then 36-byte calls: `x0..x3` (32 bytes), the calling vCPU, the conduit, the
//! immediate (2 bytes).
//!
//! **Invariants** (threat model §9.3 "smccc"):
//! 1. `dispatch` is total (HC-1) and a `Return` writes at most `x0..x3` (the type cannot say
//!    otherwise; this target checks `x0` is always written, as SMCCC §5.2 requires);
//! 2. PSCI state machine (DEN 0022 §5.1.4): a CPU_ON returns SUCCESS only for a target that
//!    was `Off`, which is then `OnPending`; CPU_OFF from a vCPU that was not `On` is DENIED;
//! 3. **at most one ON per race**: after the sequence, two threads issue CPU_ON for the same
//!    `Off` target at once, and at most one succeeds (HC-3, M16's CPU_ON storm).

use super::Input;
use crate::Target;
use crate::rng::Rng;
use vmm::backend::serial::Sink;
use vmm::control::VmControl;
use vmm::memory::{GuestAddress, VecMemory};
use vmm::psci::CpuPower;
use vmm::smccc::{
    Call, Conduit, Ctx, Outcome, PSCI_AFFINITY_INFO_64, PSCI_CPU_OFF, PSCI_CPU_ON_32,
    PSCI_CPU_ON_64, PSCI_FEATURES, PSCI_VERSION, dispatch,
};

pub const TARGET: Target = Target {
    name: "smccc",
    run,
    seed,
    mutate,
    max_len: 2 + 36 * 64,
};

const CALL: usize = 36;

fn fid(x0: u64) -> u32 {
    u32::try_from(x0 & 0xffff_ffff).unwrap_or(0)
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut i = Input::new(data);
    let ncpu = 1 + usize::from(i.u8() % 4);
    let debug = i.bool();
    let mpidrs: Vec<u64> = (0..ncpu as u64).collect();
    let ctl = VmControl::with_cpus(&mpidrs);
    let mem = VecMemory::new(&[(GuestAddress(super::RAM_A), 1 << 20)])
        .map_err(|e| format!("VecMemory: {e:?}"))?;
    let serial = Sink::none();
    let mut calls = 0;
    while !i.is_empty() && calls < 64 {
        calls += 1;
        let x = [i.u64(), i.u64(), i.u64(), i.u64()];
        let vcpu = usize::from(i.u8()) % ncpu;
        let conduit = if i.bool() { Conduit::Smc } else { Conduit::Hvc };
        let (sel, val) = (i.u8(), i.u8());
        let imm = if sel % 8 == 0 { u16::from(val) } else { 0 };
        let ctx = Ctx {
            mem: &mem,
            serial: &serial,
            ctl: &ctl,
            vcpu,
            generation: 0,
            debug_calls: debug,
        };
        let f = fid(x[0]);
        let target = if f == PSCI_CPU_ON_32 {
            x[1] & 0xffff_ffff
        } else {
            x[1]
        };
        let target_idx = ctl.psci().index_of(target).ok();
        let before = target_idx.and_then(|t| ctl.psci().state(t));
        let caller_before = ctl.psci().state(vcpu);
        let out = dispatch(&ctx, &Call { conduit, imm, x });
        match &out {
            Outcome::Return([x0, ..]) => {
                let Some(x0) = x0 else {
                    return Err(format!("call {f:#x} returned without writing x0"));
                };
                if imm == 0 && (f == PSCI_CPU_ON_32 || f == PSCI_CPU_ON_64) && *x0 == 0 {
                    if before != Some(CpuPower::Off) {
                        return Err(format!(
                            "CPU_ON({target:#x}) succeeded although the target was {before:?}"
                        ));
                    }
                    let after = target_idx.and_then(|t| ctl.psci().state(t));
                    if after != Some(CpuPower::OnPending) {
                        return Err(format!("after CPU_ON the target is {after:?}"));
                    }
                }
            }
            Outcome::CpuOff => {
                if f != PSCI_CPU_OFF || caller_before != Some(CpuPower::On) {
                    return Err(format!(
                        "CpuOff for {f:#x} from a vCPU that was {caller_before:?}"
                    ));
                }
            }
            Outcome::Stop(_) => {}
        }
        // A vCPU that was turned on takes its mailbox (what its thread does).
        for t in 0..ncpu {
            if ctl.psci().state(t) == Some(CpuPower::OnPending) {
                let _ = ctl.park(t);
            }
        }
    }
    race(&ctl, &mem, ncpu)
}

/// Invariant 3: two threads CPU_ON the same `Off` target at once.
fn race(ctl: &VmControl, mem: &VecMemory, ncpu: usize) -> crate::Verdict {
    let Some(target) = (0..ncpu).find(|&t| ctl.psci().state(t) == Some(CpuPower::Off)) else {
        return Ok(());
    };
    let wins = std::thread::scope(|s| {
        let go = |caller: usize| {
            s.spawn(move || {
                let serial = Sink::none();
                let ctx = Ctx {
                    mem,
                    serial: &serial,
                    ctl,
                    vcpu: caller,
                    generation: 0,
                    debug_calls: false,
                };
                let x = [u64::from(PSCI_CPU_ON_64), target as u64, super::RAM_A, 0];
                let call = Call {
                    conduit: Conduit::Hvc,
                    imm: 0,
                    x,
                };
                matches!(dispatch(&ctx, &call), Outcome::Return([Some(0), ..]))
            })
        };
        let (a, b) = (go(0), go(0));
        usize::from(a.join().unwrap_or(false)) + usize::from(b.join().unwrap_or(false))
    });
    if wins > 1 {
        return Err(format!(
            "{wins} racing CPU_ONs for CPU {target} succeeded (HC-3)"
        ));
    }
    Ok(())
}

fn call(b: &mut Vec<u8>, x: [u64; 4], vcpu: u8) {
    for v in x {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&[vcpu, 0, 1, 0]);
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![rng.byte(), rng.byte()];
    for _ in 0..1 + rng.index(16) {
        let f = rng
            .pick(&[
                PSCI_VERSION,
                PSCI_CPU_ON_64,
                PSCI_CPU_ON_32,
                PSCI_CPU_OFF,
                PSCI_AFFINITY_INFO_64,
                PSCI_FEATURES,
                0xC600_4D03,
                0x8000_0001,
            ])
            .unwrap_or(0);
        let x = [
            u64::from(f),
            rng.below(5),
            super::RAM_A + 4 * rng.below(0x100),
            rng.next_u64(),
        ];
        call(&mut b, x, rng.byte());
    }
    b
}

fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    if buf.len() < 2 + CALL {
        return;
    }
    let c = 2 + CALL * rng.index((buf.len() - 2) / CALL);
    let reg = rng.index(4);
    let v = match reg {
        0 => u64::from(
            rng.pick(&[PSCI_CPU_ON_64, PSCI_CPU_OFF, 0xC400_0003 | 1 << 31])
                .unwrap_or(0),
        ),
        1 => rng
            .pick(&[0u64, 1, 3, 4, 0xff, 1 << 32, u64::MAX])
            .unwrap_or(0),
        2 => rng
            .pick(&[0u64, 1, super::RAM_A - 4, super::RAM_A + 2, u64::MAX - 3])
            .unwrap_or(0),
        _ => rng.next_u64(),
    };
    crate::mutate::put_le(buf, c + 8 * reg, 8, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(20);
        for _ in 0..1_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
