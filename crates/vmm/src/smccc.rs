//! SMCCC dispatch: what an `hvc #0` (or `smc #0`) from the guest means (architecture §8.6,
//! threat model HC-1, HC-2).
//!
//! **The calling convention** (Arm DEN 0028, SMC Calling Convention, §2): the function ID is
//! in `W0`, arguments in `x1..x3`, results in `x0..x3`. Bits [31] (fast call), [30] (SMC64)
//! and [29:24] (owning entity, OEN) of the ID say who serves the call. We only look at `W0`,
//! the low 32 bits, as the convention says; the upper half of `x0` is ignored. Dispatch is a
//! total function over any `x0` (HC-1): an unknown ID returns `NOT_SUPPORTED` (-1) with a
//! rate-limited `guest_warn!` (LOG-1), never silence and never a panic. Only `x0..x3` are ever
//! written, and only as each call defines.
//!
//! **The table** (architecture §8.6) is complete from M5: SMCCC_VERSION and
//! SMCCC_ARCH_FEATURES (DEN 0028 §7), the PSCI 1.1 calls an OS needs (Arm DEN 0022 §5: VERSION,
//! CPU_SUSPEND, CPU_OFF, CPU_ON, AFFINITY_INFO, MIGRATE_INFO_TYPE, SYSTEM_OFF, SYSTEM_RESET,
//! PSCI_FEATURES), and the macvmm debug calls. The PSCI state those calls act on lives in
//! `psci.rs`. **SMC32 calls take 32-bit arguments** (DEN 0028 §3.1: "the upper 32 bits of each
//! register are ignored"), so `CPU_ON` through `0x8400_0003` uses `W1..W3`, while the SMC64 ID
//! `0xC400_0003` uses `X1..X3`.
//!
//! **Known probes, answered -1 on purpose (M10).** A stock Linux 6.18 boot asks two questions
//! this VMM deliberately says "no" to (observed in the exit trace, docs/research/hvf-api.md
//! §19): `TRNG_VERSION` (Arm DEN 0098 §2.1; `smccc_probe_trng` in
//! `drivers/firmware/smccc/smccc.c`), and the vendor-hypervisor `Call UID` query (DEN 0028
//! §6.2, `0x8600_FF01`; Linux's `kvm_init_hyp_services` and `arm_smccc_hypervisor_has_uuid`).
//! `NOT_SUPPORTED` is the specified answer for both: there is no TRNG (the guest seeds itself
//! from the DTB `rng-seed`, FDT-3) and no vendor hypervisor service. They are listed in
//! [`PROBES`] with the reason, answered without the `unknown SMCCC` warning (which is kept for
//! IDs nobody expected, so a new probe in a future kernel is still noticed), and named in the
//! trace. They are *not* `implemented`: PSCI_FEATURES and SMCCC_ARCH_FEATURES still say -1.
//!
//! **Debug calls are test-guest only** (HC-2): when `debug_calls` is false (Image, `--bios`,
//! vmapple boots) they answer `NOT_SUPPORTED` like any unknown ID, so a real OS never sees the
//! extra surface. `DEBUG_MEMHASH` caps `len` at [`MAX_MEMHASH_LEN`] and checks the stop flag
//! every [`MEMHASH_STOP_CHUNK`] bytes, so a guest cannot pin a vCPU thread for long.
//! `DEBUG_PUTC` goes through the sink's `AnsiFilter` (TTY-1).

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::backend::serial::Sink;
use crate::control::{StopReason, VmControl};
use crate::memory::{GuestAddress, GuestMemory};
use crate::psci::PsciError;

// **Why `0xC600_4Dxx` and not `0xC600_0001..4`** (architecture §8.6 originally). Measured on
// this machine (M3, docs/research/hvf-api.md §15): Hypervisor.framework itself answers
// `hvc #0` with W0 in `0xC600_0000..=0xC600_001F` *without exiting to the VMM* (it returns
// `x0 = 0xffff_ffff`); every other vendor-hypervisor ID we probed exits normally. The debug
// calls therefore live at `0xC600_4D01..4` (`0x4D` = 'M'), well clear of that block.

/// macvmm DEBUG_PUTC(x1 = byte).
pub const DEBUG_PUTC: u32 = 0xC600_4D01;
/// macvmm DEBUG_EXIT(x1 = code).
pub const DEBUG_EXIT: u32 = 0xC600_4D02;
/// macvmm DEBUG_MEMHASH(x1 = ipa, x2 = len) → x0 = 0, x1 = FNV-1a-64, or x0 = -2.
pub const DEBUG_MEMHASH: u32 = 0xC600_4D03;
/// macvmm DEBUG_BOOT_COUNT → x0 = 0, x1 = boot generation.
pub const DEBUG_BOOT_COUNT: u32 = 0xC600_4D04;
/// SMCCC_VERSION (DEN 0028 §7.2): returns the implemented SMCCC version.
pub const SMCCC_VERSION: u32 = 0x8000_0000;
/// SMCCC_ARCH_FEATURES(fn) (DEN 0028 §7.3): 0 if `fn` is implemented.
pub const SMCCC_ARCH_FEATURES: u32 = 0x8000_0001;
/// PSCI_VERSION (DEN 0022 §5.1.1).
pub const PSCI_VERSION: u32 = 0x8400_0000;
/// CPU_SUSPEND (DEN 0022 §5.1.2), SMC32 and SMC64.
pub const PSCI_CPU_SUSPEND_32: u32 = 0x8400_0001;
pub const PSCI_CPU_SUSPEND_64: u32 = 0xC400_0001;
/// CPU_OFF (DEN 0022 §5.1.3).
pub const PSCI_CPU_OFF: u32 = 0x8400_0002;
/// CPU_ON(target, entry, ctx) (DEN 0022 §5.1.4), SMC32 and SMC64.
pub const PSCI_CPU_ON_32: u32 = 0x8400_0003;
pub const PSCI_CPU_ON_64: u32 = 0xC400_0003;
/// AFFINITY_INFO(target, level) (DEN 0022 §5.1.5), SMC32 and SMC64.
pub const PSCI_AFFINITY_INFO_32: u32 = 0x8400_0004;
pub const PSCI_AFFINITY_INFO_64: u32 = 0xC400_0004;
/// MIGRATE_INFO_TYPE (DEN 0022 §5.1.7).
pub const PSCI_MIGRATE_INFO_TYPE: u32 = 0x8400_0006;
/// PSCI SYSTEM_OFF (SMC32 fast call, DEN 0022 §5.1.9).
pub const PSCI_SYSTEM_OFF: u32 = 0x8400_0008;
/// PSCI SYSTEM_RESET (SMC32 fast call, DEN 0022 §5.1.10).
pub const PSCI_SYSTEM_RESET: u32 = 0x8400_0009;
/// PSCI_FEATURES(fn) (DEN 0022 §5.1.14).
pub const PSCI_FEATURES: u32 = 0x8400_000A;

/// TRNG_VERSION (Arm DEN 0098 "True Random Number Generator Firmware Interface" §2.1).
pub const TRNG_VERSION: u32 = 0x8400_0050;
/// The vendor-specific hypervisor service's `Call UID` query (DEN 0028 §6.2: OEN 6, function
/// `0xFF01`; Linux `ARM_SMCCC_VENDOR_HYP_CALL_UID_FUNC_ID`).
pub const VENDOR_HYP_CALL_UID: u32 = 0x8600_FF01;

/// SMCCC 1.1 and PSCI 1.1: major in bits 30:16, minor in 15:0.
pub const VERSION_1_1: u64 = 0x0001_0001;
/// MIGRATE_INFO_TYPE 2: "Trusted OS is either not present or does not require migration".
pub const MIGRATE_NO_TRUSTED_OS: u64 = 2;

/// SMCCC / PSCI `SUCCESS`.
pub const SUCCESS: u64 = 0;
/// SMCCC `NOT_SUPPORTED` (-1) as the register value.
pub const NOT_SUPPORTED: u64 = u64::MAX;
/// SMCCC / PSCI `INVALID_PARAMETERS` (-2) as the register value.
pub const INVALID_PARAMETERS: u64 = u64::MAX - 1;
/// PSCI `DENIED` (-3) as the register value.
pub const DENIED: u64 = u64::MAX - 2;

/// Every function this table serves, with its trace name: the PSCI_FEATURES and
/// `function_name` source of truth. `debug` marks the HC-2 calls.
const FUNCTIONS: &[(u32, &str, bool)] = &[
    (SMCCC_VERSION, "SMCCC_VERSION", false),
    (SMCCC_ARCH_FEATURES, "SMCCC_ARCH_FEATURES", false),
    (PSCI_VERSION, "PSCI_VERSION", false),
    (PSCI_CPU_SUSPEND_32, "PSCI_CPU_SUSPEND", false),
    (PSCI_CPU_SUSPEND_64, "PSCI_CPU_SUSPEND", false),
    (PSCI_CPU_OFF, "PSCI_CPU_OFF", false),
    (PSCI_CPU_ON_32, "PSCI_CPU_ON", false),
    (PSCI_CPU_ON_64, "PSCI_CPU_ON", false),
    (PSCI_AFFINITY_INFO_32, "PSCI_AFFINITY_INFO", false),
    (PSCI_AFFINITY_INFO_64, "PSCI_AFFINITY_INFO", false),
    (PSCI_MIGRATE_INFO_TYPE, "PSCI_MIGRATE_INFO_TYPE", false),
    (PSCI_SYSTEM_OFF, "PSCI_SYSTEM_OFF", false),
    (PSCI_SYSTEM_RESET, "PSCI_SYSTEM_RESET", false),
    (PSCI_FEATURES, "PSCI_FEATURES", false),
    (DEBUG_PUTC, "DEBUG_PUTC", true),
    (DEBUG_EXIT, "DEBUG_EXIT", true),
    (DEBUG_MEMHASH, "DEBUG_MEMHASH", true),
    (DEBUG_BOOT_COUNT, "DEBUG_BOOT_COUNT", true),
];

// ANCHOR: smccc_known_probes
/// Calls a real guest is known to make that we answer `NOT_SUPPORTED` on purpose (module
/// docs): `(id, trace name, why)`. No warning is logged for these (threat model §10.2 M10: no
/// `unknown SMCCC` warnings during a Linux boot), and PSCI_FEATURES does not advertise them.
pub const PROBES: &[(u32, &str, &str)] = &[
    (
        TRNG_VERSION,
        "TRNG_VERSION",
        "no firmware TRNG; the guest seeds its RNG from the DTB rng-seed (FDT-3)",
    ),
    (
        VENDOR_HYP_CALL_UID,
        "VENDOR_HYP_CALL_UID",
        "no vendor hypervisor services (not KVM, not Gunyah); -1 is not a known UUID",
    ),
];
// ANCHOR_END: smccc_known_probes

/// True if `fid` is one of the [`PROBES`].
fn is_known_probe(fid: u32) -> bool {
    PROBES.iter().any(|&(id, _, _)| id == fid)
}

/// The most bytes one DEBUG_MEMHASH may hash (HC-2, architecture §21.5).
pub const MAX_MEMHASH_LEN: u64 = 1 << 30;
/// DEBUG_MEMHASH checks the stop flag after every this many bytes.
pub const MEMHASH_STOP_CHUNK: u64 = 64 << 20;
/// The bounce buffer DEBUG_MEMHASH copies guest bytes through (on the stack).
const MEMHASH_BOUNCE: usize = 64 * 1024;

/// FNV-1a-64 parameters (Fowler–Noll–Vo, the 64-bit offset basis and prime).
pub const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// How the guest made the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Conduit {
    /// `hvc #imm`: the hardware has already advanced the PC (spike finding 5).
    Hvc,
    /// `smc #imm`: the PC still points at the SMC (spike finding 6); the caller adds 4.
    Smc,
}

/// One call: the conduit, its immediate and `x0..x3` at the trap.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Call {
    pub conduit: Conduit,
    pub imm: u16,
    pub x: [u64; 4],
}

/// What to do after a call.
#[derive(Debug)]
pub enum Outcome {
    /// Write each `Some` into `x0..x3` and resume the guest.
    Return([Option<u64>; 4]),
    /// Stop the VM.
    Stop(StopReason),
    /// PSCI CPU_OFF succeeded: the calling vCPU is now `Off` and parks until a CPU_ON (or the
    /// stop). Nothing is written back: CPU_OFF never returns on success (DEN 0022 §5.1.3).
    CpuOff,
}

/// What the dispatcher may touch: guest RAM (read-only use), the serial sink, the VM's stop
/// flag and PSCI state, the calling vCPU, and two facts about this boot.
pub struct Ctx<'a> {
    pub mem: &'a dyn GuestMemory,
    pub serial: &'a Sink,
    pub ctl: &'a VmControl,
    /// The index of the calling vCPU (for CPU_OFF).
    pub vcpu: usize,
    /// The in-process boot generation (0 on the first boot).
    pub generation: u64,
    /// HC-2: the debug calls answer (test guests only).
    pub debug_calls: bool,
}

fn ret(x0: u64) -> Outcome {
    Outcome::Return([Some(x0), None, None, None])
}

/// `W0`: the function ID is the low 32 bits of `x0` (DEN 0028 §2).
fn function_id(x0: u64) -> u32 {
    let [b0, b1, b2, b3, ..] = x0.to_le_bytes();
    u32::from_le_bytes([b0, b1, b2, b3])
}

/// The three arguments as the call sees them: `x1..x3`, truncated to `W1..W3` for an SMC32
/// call (bit 30 of the ID clear; DEN 0028 §3.1).
fn args(fid: u32, x: [u64; 4]) -> [u64; 3] {
    let [_, x1, x2, x3] = x;
    if fid & (1 << 30) == 0 {
        [x1, x2, x3].map(|v| v & 0xffff_ffff)
    } else {
        [x1, x2, x3]
    }
}

fn psci_err(e: PsciError) -> Outcome {
    ret(e.reg())
}

/// True if `fid` is a function this table serves for this boot (PSCI_FEATURES).
fn implemented(ctx: &Ctx<'_>, fid: u32) -> bool {
    FUNCTIONS
        .iter()
        .any(|&(id, _, debug)| id == fid && (!debug || ctx.debug_calls))
}

/// An entry point CPU_ON may start a vCPU at: 4-byte aligned and inside RAM (HC-3). ROM
/// (`--bios`, M18) joins this check when it exists.
fn entry_valid(ctx: &Ctx<'_>, entry: u64) -> bool {
    entry.is_multiple_of(4) && ctx.mem.check_range(GuestAddress(entry), 4)
}

// ANCHOR: smccc_dispatch
/// Dispatch one SMCCC call (module docs, architecture §8.6). Total over every input (HC-1).
pub fn dispatch(ctx: &Ctx<'_>, call: &Call) -> Outcome {
    if call.imm != 0 {
        crate::guest_warn!(
            "hvc/smc with immediate {:#x} is not SMCCC; returning -1",
            call.imm
        );
        return ret(NOT_SUPPORTED);
    }
    let [x0, ..] = call.x;
    let fid = function_id(x0);
    let [a1, a2, a3] = args(fid, call.x);
    let psci = ctx.ctl.psci();
    match fid {
        SMCCC_VERSION | PSCI_VERSION => ret(VERSION_1_1),
        // Only SMCCC_VERSION is advertised: no ARCH_WORKAROUND_1/2/3 (the host handles them).
        SMCCC_ARCH_FEATURES => ret(if function_id(a1) == SMCCC_VERSION {
            SUCCESS
        } else {
            NOT_SUPPORTED
        }),
        PSCI_CPU_SUSPEND_32 | PSCI_CPU_SUSPEND_64 => ret(SUCCESS), // standby: wake at once
        PSCI_CPU_OFF => {
            if psci.cpu_off(ctx.vcpu) {
                Outcome::CpuOff
            } else {
                ret(DENIED)
            }
        }
        PSCI_CPU_ON_32 | PSCI_CPU_ON_64 => match psci.cpu_on(a1, a2, a3, entry_valid(ctx, a2)) {
            Ok(_) => ret(SUCCESS),
            Err(e) => psci_err(e),
        },
        PSCI_AFFINITY_INFO_32 | PSCI_AFFINITY_INFO_64 => match psci.affinity_info(a1, a2) {
            Ok(state) => ret(state.affinity_info()),
            Err(e) => psci_err(e),
        },
        PSCI_MIGRATE_INFO_TYPE => ret(MIGRATE_NO_TRUSTED_OS),
        PSCI_SYSTEM_OFF => Outcome::Stop(StopReason::PowerOff),
        PSCI_SYSTEM_RESET => Outcome::Stop(StopReason::Reset),
        PSCI_FEATURES => ret(if implemented(ctx, function_id(a1)) {
            SUCCESS
        } else {
            NOT_SUPPORTED
        }),
        DEBUG_PUTC | DEBUG_EXIT | DEBUG_MEMHASH | DEBUG_BOOT_COUNT if ctx.debug_calls => {
            debug_call(ctx, fid, call.x)
        }
        _ if is_known_probe(fid) => ret(NOT_SUPPORTED),
        _ => {
            crate::guest_warn!("unknown SMCCC function {fid:#x}; returning -1");
            ret(NOT_SUPPORTED)
        }
    }
}
// ANCHOR_END: smccc_dispatch

// ANCHOR: smccc_debug_calls
/// The macvmm debug calls (HC-2; only reached when `ctx.debug_calls`). They are SMC64 calls,
/// so they read the full `x1..x2`.
fn debug_call(ctx: &Ctx<'_>, fid: u32, x: [u64; 4]) -> Outcome {
    let [_, x1, x2, _] = x;
    match fid {
        DEBUG_PUTC => {
            let [byte, ..] = x1.to_le_bytes(); // the low byte; the rest of x1 is ignored
            ctx.serial.write_guest(&[byte]);
            ret(0)
        }
        // A code that does not fit in 32 bits saturates, so it can never read as 0 (success).
        DEBUG_EXIT => Outcome::Stop(StopReason::DebugExit(u32::try_from(x1).unwrap_or(u32::MAX))),
        DEBUG_MEMHASH => match memhash(ctx.mem, x1, x2, ctx.ctl) {
            Some(h) => Outcome::Return([Some(0), Some(h), None, None]),
            None => ret(INVALID_PARAMETERS),
        },
        DEBUG_BOOT_COUNT => Outcome::Return([Some(0), Some(ctx.generation), None, None]),
        _ => ret(NOT_SUPPORTED),
    }
}
// ANCHOR_END: smccc_debug_calls

/// The static name of the SMCCC function in `x0`, for the exit trace's `fn` field (M4;
/// TTY-8: a name from this table or [`PROBES`], never guest data). `None` for any other ID.
pub fn function_name(x0: u64) -> Option<&'static str> {
    let fid = function_id(x0);
    FUNCTIONS
        .iter()
        .map(|&(id, name, _)| (id, name))
        .chain(PROBES.iter().map(|&(id, name, _)| (id, name)))
        .find(|&(id, _)| id == fid)
        .map(|(_, name)| name)
}

/// True if `x0` names a PSCI function: OEN 4, "standard secure service" calls `0x8400_0000..
/// 0x8400_001F` (SMC32) and `0xC400_0000..0xC400_001F` (SMC64) (Arm DEN 0022 PSCI 1.1, §5.1;
/// DEN 0028 §6.2). The trace tags these `action: "psci"`.
pub fn is_psci(x0: u64) -> bool {
    matches!(function_id(x0) & !0x4000_001f, 0x8400_0000)
}

/// FNV-1a-64 of guest RAM `[ipa, ipa + len)`, or `None` if the range is empty, longer than
/// [`MAX_MEMHASH_LEN`], overflows, or is not entirely in one RAM region (`checked_add`
/// inside `check_range`, MEM-2). Also `None` if the VM is stopping mid-hash.
pub fn memhash(mem: &dyn GuestMemory, ipa: u64, len: u64, ctl: &VmControl) -> Option<u64> {
    if len > MAX_MEMHASH_LEN || !mem.check_range(GuestAddress(ipa), len) {
        return None;
    }
    let mut buf = [0u8; MEMHASH_BOUNCE];
    let mut h = FNV_OFFSET;
    let (mut addr, mut left, mut since_check) = (ipa, len, 0u64);
    while left > 0 {
        let n = usize::try_from(left).map_or(MEMHASH_BOUNCE, |l| l.min(MEMHASH_BOUNCE));
        let chunk = buf.get_mut(..n)?;
        mem.read(GuestAddress(addr), chunk).ok()?;
        h = chunk
            .iter()
            .fold(h, |h, &b| (h ^ u64::from(b)).wrapping_mul(FNV_PRIME));
        let n64 = u64::try_from(n).ok()?;
        (addr, left) = (addr.checked_add(n64)?, left.saturating_sub(n64));
        since_check = since_check.saturating_add(n64);
        if since_check >= MEMHASH_STOP_CHUNK {
            since_check = 0;
            if ctl.is_stopping() {
                return None;
            }
        }
    }
    Some(h)
}

/// FNV-1a-64 of a host buffer (tests and the course's reference).
pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(FNV_PRIME)
    })
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::backend::ansi::FilterPolicy;
    use crate::memory::VecMemory;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    const BASE: u64 = 0x4000_0000;

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            crate::sync::lock(&self.0).extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    struct Env {
        mem: VecMemory,
        sink: Sink,
        out: Buf,
        ctl: VmControl,
    }

    fn env() -> Env {
        let out = Buf::default();
        Env {
            mem: VecMemory::new(&[(GuestAddress(BASE), 1 << 20)]).unwrap(),
            sink: Sink::new("test", Box::new(out.clone()), FilterPolicy::Safe),
            out,
            ctl: VmControl::new(),
        }
    }

    fn call(e: &Env, debug: bool, x: [u64; 4]) -> Outcome {
        let ctx = Ctx {
            mem: &e.mem,
            serial: &e.sink,
            ctl: &e.ctl,
            vcpu: 0,
            generation: 3,
            debug_calls: debug,
        };
        dispatch(
            &ctx,
            &Call {
                conduit: Conduit::Hvc,
                imm: 0,
                x,
            },
        )
    }

    fn x0(o: &Outcome) -> u64 {
        match o {
            Outcome::Return([Some(v), ..]) => *v,
            other => panic!("expected a return, got {other:?}"),
        }
    }

    #[test]
    fn putc_goes_through_the_filter() {
        let e = env();
        for b in b"hi\x1b[6n!\n" {
            assert_eq!(x0(&call(&e, true, [0xC600_4D01, u64::from(*b), 0, 0])), 0);
        }
        assert_eq!(&*crate::sync::lock(&e.out.0), b"hi!\n");
    }

    #[test]
    fn debug_calls_are_off_unless_enabled() {
        let e = env();
        for id in [DEBUG_PUTC, DEBUG_EXIT, DEBUG_MEMHASH, DEBUG_BOOT_COUNT] {
            assert_eq!(
                x0(&call(&e, false, [u64::from(id), 65, 0, 0])),
                NOT_SUPPORTED
            );
        }
        assert!(crate::sync::lock(&e.out.0).is_empty());
    }

    #[test]
    fn exit_codes_and_psci() {
        let e = env();
        assert!(matches!(
            call(&e, true, [0xC600_4D02, 0, 0, 0]),
            Outcome::Stop(StopReason::DebugExit(0))
        ));
        assert!(matches!(
            call(&e, true, [0xC600_4D02, 1 << 32, 0, 0]),
            Outcome::Stop(StopReason::DebugExit(u32::MAX))
        ));
        assert!(matches!(
            call(&e, false, [0x8400_0008, 0, 0, 0]),
            Outcome::Stop(StopReason::PowerOff)
        ));
        assert!(matches!(
            call(&e, false, [0x8400_0009, 0, 0, 0]),
            Outcome::Stop(StopReason::Reset)
        ));
        // Upper half of x0 ignored (W0).
        assert!(matches!(
            call(&e, false, [0xdead_beef_8400_0008, 0, 0, 0]),
            Outcome::Stop(StopReason::PowerOff)
        ));
        match call(&e, true, [0xC600_4D04, 0, 0, 0]) {
            Outcome::Return(r) => assert_eq!(r, [Some(0), Some(3), None, None]),
            o => panic!("{o:?}"),
        }
    }

    #[test]
    fn unknown_ids_and_immediates_return_minus_one() {
        let e = env();
        for x in [0u64, 0xC600_00FF, 0x8000_0002, u64::MAX, 0x8400_0012] {
            assert_eq!(x0(&call(&e, true, [x, 0, 0, 0])), NOT_SUPPORTED, "{x:#x}");
        }
        let ctx = Ctx {
            mem: &e.mem,
            serial: &e.sink,
            ctl: &e.ctl,
            vcpu: 0,
            generation: 0,
            debug_calls: true,
        };
        let o = dispatch(
            &ctx,
            &Call {
                conduit: Conduit::Smc,
                imm: 1,
                x: [0x8400_0008, 0, 0, 0],
            },
        );
        assert_eq!(x0(&o), NOT_SUPPORTED);
    }

    /// M10: the probes a Linux 6.18 boot makes are -1, not advertised, and named.
    #[test]
    fn known_probes_are_minus_one_and_named() {
        let e = env();
        for &(id, name, why) in PROBES {
            assert_eq!(
                x0(&call(&e, false, [u64::from(id), 0, 0, 0])),
                NOT_SUPPORTED
            );
            assert_eq!(
                x0(&call(
                    &e,
                    false,
                    [u64::from(PSCI_FEATURES), u64::from(id), 0, 0]
                )),
                NOT_SUPPORTED,
                "{name} is not advertised"
            );
            assert_eq!(function_name(u64::from(id)), Some(name));
            assert!(!is_psci(u64::from(id)), "{name}");
            assert!(!why.is_empty());
        }
        assert_eq!(function_name(0x8600_FF02), None, "only the listed IDs");
    }

    #[test]
    fn memhash_matches_and_rejects() {
        let e = env();
        let data: Vec<u8> = (0..5000u32).map(|i| (i * 7) as u8).collect();
        e.mem.write(GuestAddress(BASE + 100), &data).unwrap();
        match call(&e, true, [0xC600_4D03, BASE + 100, 5000, 0]) {
            Outcome::Return(r) => assert_eq!(r, [Some(0), Some(fnv1a(&data)), None, None]),
            o => panic!("{o:?}"),
        }
        assert_eq!(fnv1a(b""), FNV_OFFSET);
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c); // published FNV-1a-64 test vector
        for (ipa, len) in [
            (0xFFFF_FFFF_FFFF_FFF0, 0x20), // end overflows (memtest step 3)
            (BASE, 0),
            (BASE, (1 << 20) + 1),
            (BASE - 1, 2),
            (BASE, MAX_MEMHASH_LEN + 1),
            (0, 16),
        ] {
            assert_eq!(
                x0(&call(&e, true, [0xC600_4D03, ipa, len, 0])),
                INVALID_PARAMETERS
            );
        }
    }
}
