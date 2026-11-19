//! Host test: SMCCC dispatch, one case per row of architecture §8.6 (PLAN M5 "Acceptance:
//! host"; threat model HC-1, HC-2).
//!
//! Plus: `hvc` with an immediate other than 0 is not SMCCC (-1); with `--no-debug-hvc` the
//! debug calls are -1 like any unknown ID; SMC32 calls see only `W1..W3`; and the HC-1
//! property: 10,000 random `x0..x3` through the real exit handler never panic and never touch
//! `x4` and above.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::Sink;
use vmm::bus::Bus;
use vmm::config::MmioPolicy;
use vmm::control::{StopReason, VmControl};
use vmm::error::Result;
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};
use vmm::smccc::{Call, Conduit, Ctx, Outcome, dispatch, fnv1a};
use vmm::trace::ExitRecord;
use vmm::vcpu::exit::{ExitAction, ExitEnv, VcpuRegs, handle};
use vmm::vcpu::regs::RegDump;

const RAM: u64 = 0x4000_0000;
const MINUS1: u64 = u64::MAX;
const MINUS2: u64 = u64::MAX - 1;

struct Env {
    mem: VecMemory,
    sink: Sink,
    ctl: VmControl,
}

fn env() -> Env {
    Env {
        mem: VecMemory::new(&[(GuestAddress(RAM), 1 << 20)]).unwrap(),
        sink: Sink::new("t", Box::new(std::io::sink()), FilterPolicy::Safe),
        ctl: VmControl::new(),
    }
}

fn call_with(e: &Env, debug: bool, conduit: Conduit, imm: u16, x: [u64; 4]) -> Outcome {
    let ctx = Ctx {
        mem: &e.mem,
        serial: &e.sink,
        ctl: &e.ctl,
        vcpu: 0,
        generation: 2,
        debug_calls: debug,
    };
    dispatch(&ctx, &Call { conduit, imm, x })
}

fn call(e: &Env, x: [u64; 4]) -> Outcome {
    call_with(e, true, Conduit::Hvc, 0, x)
}

/// `x0..x3` written back by a returning call.
fn regs(o: &Outcome) -> [Option<u64>; 4] {
    match o {
        Outcome::Return(r) => *r,
        other => panic!("expected a return, got {other:?}"),
    }
}

fn x0(o: &Outcome) -> u64 {
    regs(o)[0].unwrap()
}

#[test]
fn smccc_version_and_arch_features() {
    let e = env();
    assert_eq!(
        regs(&call(&e, [0x8000_0000, 0, 0, 0])),
        [Some(0x10001), None, None, None]
    );
    assert_eq!(x0(&call(&e, [0x8000_0001, 0x8000_0000, 0, 0])), 0);
    // ARCH_WORKAROUND_1/2/3 and everything else: -1.
    for f in [
        0x8000_8000u64,
        0x8000_7fff,
        0x8000_3fff,
        0x8000_0001,
        0x8400_0000,
    ] {
        assert_eq!(x0(&call(&e, [0x8000_0001, f, 0, 0])), MINUS1, "{f:#x}");
    }
}

#[test]
fn psci_version_suspend_migrate() {
    let e = env();
    assert_eq!(
        regs(&call(&e, [0x8400_0000, 0, 0, 0])),
        [Some(0x10001), None, None, None]
    );
    assert_eq!(x0(&call(&e, [0xC400_0001, 0, RAM, 0])), 0, "CPU_SUSPEND 64");
    assert_eq!(x0(&call(&e, [0x8400_0001, 0, RAM, 0])), 0, "CPU_SUSPEND 32");
    assert_eq!(
        x0(&call(&e, [0x8400_0006, 0, 0, 0])),
        2,
        "MIGRATE_INFO_TYPE"
    );
}

#[test]
fn cpu_on_and_affinity_info() {
    let e = env();
    for fid in [0xC400_0003u64, 0x8400_0003] {
        assert_eq!(x0(&call(&e, [fid, 1, RAM, 0])), MINUS2, "unknown MPIDR");
        assert_eq!(x0(&call(&e, [fid, 0, RAM, 0])), u64::MAX - 3, "ALREADY_ON");
    }
    // Entry outside RAM or misaligned: -9. The machine needs a second vCPU to get past -2/-4.
    let e2 = Env {
        ctl: VmControl::with_cpus(&[0x8000_0000, 0x8000_0001]),
        ..env()
    };
    assert_eq!(x0(&call(&e2, [0xC400_0003, 1, 0x1000, 0])), u64::MAX - 8);
    assert_eq!(x0(&call(&e2, [0xC400_0003, 1, RAM + 2, 0])), u64::MAX - 8);
    assert_eq!(
        x0(&call(&e2, [0xC400_0003, 1, RAM + (1 << 20), 0])),
        u64::MAX - 8
    );
    assert_eq!(
        x0(&call(&e2, [0xC400_0003, 1, RAM + 0x100, 9])),
        0,
        "SUCCESS"
    );
    assert_eq!(x0(&call(&e2, [0xC400_0004, 1, 0, 0])), 2, "ON_PENDING");
    assert_eq!(
        x0(&call(&e2, [0xC400_0003, 1, RAM, 0])),
        u64::MAX - 4,
        "ON_PENDING"
    );
    let on = e2.ctl.psci().take_power_on(1).unwrap();
    assert_eq!((on.entry, on.ctx), (RAM + 0x100, 9));
    // AFFINITY_INFO: 0 ON, 1 OFF; level > 0 is -2.
    for fid in [0xC400_0004u64, 0x8400_0004] {
        assert_eq!(x0(&call(&e, [fid, 0, 0, 0])), 0);
        assert_eq!(x0(&call(&e, [fid, 0, 1, 0])), MINUS2);
        assert_eq!(x0(&call(&e, [fid, 7, 0, 0])), MINUS2);
    }
    // SMC32 sees W1..W3: an MPIDR of 0 with garbage in the upper half is still vCPU 0.
    assert_eq!(x0(&call(&e, [0x8400_0004, 0xffff_ffff_0000_0000, 0, 0])), 0);
    assert_eq!(
        x0(&call(&e, [0xC400_0004, 0xffff_ffff_0000_0000, 0, 0])),
        MINUS2
    );
}

#[test]
fn cpu_off_system_off_reset() {
    let e = env();
    assert!(matches!(
        call(&e, [0x8400_0008, 0, 0, 0]),
        Outcome::Stop(StopReason::PowerOff)
    ));
    assert!(matches!(
        call(&e, [0x8400_0009, 0, 0, 0]),
        Outcome::Stop(StopReason::Reset)
    ));
    assert!(matches!(call(&e, [0x8400_0002, 0, 0, 0]), Outcome::CpuOff));
    assert_eq!(e.ctl.psci().affinity_info(0, 0).unwrap().affinity_info(), 1);
    // A second CPU_OFF from a vCPU that is already off is DENIED (-3), not a second park.
    assert_eq!(x0(&call(&e, [0x8400_0002, 0, 0, 0])), u64::MAX - 2);
}

#[test]
fn psci_features() {
    let e = env();
    let served = [
        0x8000_0000u64,
        0x8000_0001,
        0x8400_0000,
        0x8400_0001,
        0xC400_0001,
        0x8400_0002,
        0x8400_0003,
        0xC400_0003,
        0x8400_0004,
        0xC400_0004,
        0x8400_0006,
        0x8400_0008,
        0x8400_0009,
        0x8400_000A,
    ];
    for f in served {
        assert_eq!(x0(&call(&e, [0x8400_000A, f, 0, 0])), 0, "{f:#x}");
    }
    for f in [
        0x8400_0099u64,
        0x8400_0012,
        0xC400_0012,
        0x8400_000E,
        0x8200_0000,
    ] {
        assert_eq!(x0(&call(&e, [0x8400_000A, f, 0, 0])), MINUS1, "{f:#x}");
    }
    // The debug calls are "in the table" only when they answer (HC-2).
    assert_eq!(x0(&call(&e, [0x8400_000A, 0xC600_4D01, 0, 0])), 0);
    let off = call_with(&e, false, Conduit::Hvc, 0, [0x8400_000A, 0xC600_4D01, 0, 0]);
    assert_eq!(x0(&off), MINUS1);
}

#[test]
fn debug_calls() {
    let e = env();
    assert_eq!(x0(&call(&e, [0xC600_4D01, u64::from(b'x'), 0, 0])), 0);
    assert!(matches!(
        call(&e, [0xC600_4D02, 3, 0, 0]),
        Outcome::Stop(StopReason::DebugExit(3))
    ));
    e.mem.write(GuestAddress(RAM), b"abc").unwrap();
    assert_eq!(
        regs(&call(&e, [0xC600_4D03, RAM, 3, 0])),
        [Some(0), Some(fnv1a(b"abc")), None, None]
    );
    assert_eq!(x0(&call(&e, [0xC600_4D03, 0, 3, 0])), MINUS2);
    assert_eq!(
        regs(&call(&e, [0xC600_4D04, 0, 0, 0])),
        [Some(0), Some(2), None, None]
    );
    // --no-debug-hvc: every debug call is -1 and has no effect.
    for id in [0xC600_4D01u64, 0xC600_4D02, 0xC600_4D03, 0xC600_4D04] {
        let o = call_with(&e, false, Conduit::Hvc, 0, [id, 1, RAM, 3]);
        assert_eq!(regs(&o), [Some(MINUS1), None, None, None], "{id:#x}");
    }
}

#[test]
fn unknown_ids_and_nonzero_immediates() {
    let e = env();
    for x in [
        0u64,
        0x8200_0000,
        0xC600_0001,
        0x8400_0099,
        0x8400_0012,
        u64::MAX,
        0x8600_0000,
    ] {
        assert_eq!(
            regs(&call(&e, [x, 1, 2, 3])),
            [Some(MINUS1), None, None, None],
            "{x:#x}"
        );
    }
    for conduit in [Conduit::Hvc, Conduit::Smc] {
        for imm in [1u16, 0x4d, u16::MAX] {
            let o = call_with(&e, true, conduit, imm, [0x8400_0008, 0, 0, 0]);
            assert_eq!(regs(&o), [Some(MINUS1), None, None, None], "imm {imm:#x}");
        }
    }
}

/// A full register file, so the property test can see every register the handler touches.
struct Regs {
    x: [u64; 31],
    pc: u64,
    sets: Vec<u8>,
}

impl VcpuRegs for Regs {
    fn index(&self) -> usize {
        0
    }
    fn x(&self, n: u8) -> Result<u64> {
        Ok(self.x.get(usize::from(n)).copied().unwrap_or(0))
    }
    fn set_x(&mut self, n: u8, v: u64) -> Result<()> {
        self.sets.push(n);
        if let Some(slot) = self.x.get_mut(usize::from(n)) {
            *slot = v;
        }
        Ok(())
    }
    fn pc(&self) -> Result<u64> {
        Ok(self.pc)
    }
    fn cpsr(&self) -> Result<u64> {
        Ok(0x3c5)
    }
    fn unmask_vtimer(&mut self) -> Result<()> {
        Ok(())
    }
    fn dump(&self) -> Option<RegDump> {
        None
    }
}

/// HC-1: dispatch is total over `x0..x3`, and only `x0..x3` are ever written.
#[test]
fn random_calls_never_panic_and_leave_x4_up_alone() {
    let seed: u64 = std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x5eed_c0de_0bad_f00d);
    let mut s = seed.max(1);
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let known = [
        0x8000_0000u64,
        0x8000_0001,
        0x8400_0000,
        0x8400_0001,
        0xC400_0001,
        0x8400_0002,
        0x8400_0003,
        0xC400_0003,
        0x8400_0004,
        0xC400_0004,
        0x8400_0006,
        0x8400_0008,
        0x8400_0009,
        0x8400_000A,
        0xC600_4D01,
        0xC600_4D02,
        0xC600_4D03,
        0xC600_4D04,
    ];
    let mem = VecMemory::new(&[(GuestAddress(RAM), 1 << 20)]).unwrap();
    let sink = Sink::new("t", Box::new(std::io::sink()), FilterPolicy::Strict);
    let bus = Bus::new();
    for i in 0..10_000u32 {
        let ctl = VmControl::new();
        let env = ExitEnv {
            mem: &mem,
            serial: &sink,
            ctl: &ctl,
            bus: &bus,
            generation: 0,
            debug_calls: i % 2 == 0,
            unhandled_mmio: MmioPolicy::Fatal,
        };
        let mut r = Regs {
            x: [0; 31],
            pc: RAM,
            sets: Vec::new(),
        };
        for (n, v) in r.x.iter_mut().enumerate() {
            *v = 0xa5a5_0000 + n as u64;
        }
        let pick = next();
        r.x[0] = if pick % 2 == 0 {
            known[(pick >> 8) as usize % known.len()] | (next() & 0xffff_ffff_0000_0000)
        } else {
            next()
        };
        r.x[1] = next();
        r.x[2] = if pick % 3 == 0 {
            next() % (2 << 20)
        } else {
            next()
        };
        r.x[3] = next();
        let before = r.x;
        let esr = if pick % 5 == 0 {
            0x5e00_0000
        } else {
            0x5a00_0000
        } | (next() & 1);
        let raw = hvf::VcpuExit {
            reason: hvf::ExitReason::Exception,
            esr,
            far: 0,
            ipa: 0,
        };
        let exit = vmm::arch::esr::Exit::from_hv(raw.reason, raw.esr);
        let mut rec = ExitRecord::default();
        let a = handle(&mut r, &env, &exit, &raw, &mut rec);
        assert!(a.is_ok(), "seed {seed} iter {i}: {a:?}");
        assert!(
            r.sets.iter().all(|&n| n < 4),
            "seed {seed}: wrote {:?}",
            r.sets
        );
        assert_eq!(r.x[4..], before[4..], "seed {seed} iter {i}: x4+ changed");
        if matches!(a, Ok(ExitAction::Resume { .. })) {
            assert!(!r.sets.is_empty(), "a returning call writes x0");
        }
    }
}
