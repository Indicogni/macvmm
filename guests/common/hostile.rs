//! Helpers shared by the `hostile-*` guests: TEST-7, the hostile guest of threat model §9.4
//! (PLAN M11). Each hostile guest attacks the VMM from inside a real VM; the e2e suite
//! `hostile` checks that the VMM survives each phase with that phase's exit code.
//!
//! - [`XorShift`]: a deterministic PRNG (xorshift64*, as in the host tests), so a failing run
//!   can be replayed with the same seed;
//! - [`mmio_read`] / [`mmio_write`]: one access of exactly the given width, written in
//!   assembly so the trapped instruction (and the syndrome the VMM decodes) is the named one;
//! - [`install_fault_counter`]: a synchronous-exception hook that counts and steps over the
//!   exceptions an attack is *expected* to cause: UNDEF (EC 0x00, an injected or architectural
//!   UNDEFINED, or EC 0x18 for an unallocated ID register under FEAT_IDST), and data aborts at EL1 (EC 0x25: alignment faults on Device memory, the VMM's
//!   injected external aborts). Anything else is still reported and stops the VM.
//!
//! **Counters are plain load + store, never `fetch_add`.** With the MMU off every data access
//! is Device-nGnRnE, where an atomic read-modify-write faults (DFSC 0x35); one vCPU, so the
//! load/store pair is race-free (the `sysreg-probe` lesson).

use crate::exceptions::{ExceptionFrame, set_sync_hook};
use core::arch::asm;
use core::sync::atomic::{AtomicU64, Ordering};

/// xorshift64* (Vigna 2016).
pub struct XorShift(u64);

impl XorShift {
    pub const fn new(seed: u64) -> XorShift {
        XorShift(if seed == 0 { 1 } else { seed })
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
}

/// A counter safe to bump from an exception handler with the MMU off (module docs).
pub struct Counter(AtomicU64);

impl Counter {
    pub const fn new() -> Counter {
        Counter(AtomicU64::new(0))
    }
    pub fn bump(&self) {
        self.0.store(
            self.0.load(Ordering::SeqCst).wrapping_add(1),
            Ordering::SeqCst,
        );
    }
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

impl Default for Counter {
    fn default() -> Self {
        Counter::new()
    }
}

/// UNDEFs seen by [`install_fault_counter`]'s hook.
pub static UNDEFS: Counter = Counter::new();
/// Accesses the guest's own `CPACR_EL1` traps (FP EC 0x07, SVE EC 0x19, SME EC 0x1D): the
/// sweep touches `ZCR_EL1`, `SMCR_EL1` and friends with those units disabled (ARM ARM D19.2.31).
pub static FEATURE_TRAPS: Counter = Counter::new();
/// EL1 data aborts with DFSC 0x21 (alignment fault).
pub static ALIGNMENT_FAULTS: Counter = Counter::new();
/// Other EL1 data aborts (an injected external abort, DFSC 0x10, and the rest).
pub static DATA_ABORTS: Counter = Counter::new();

fn count_and_skip(f: &mut ExceptionFrame) -> bool {
    match f.ec() {
        // EC 0x18 at EL1: FEAT_IDST reports an access to an unallocated ID-space register
        // (op0 3, op1 0, CRn 0) as a trapped MRS instead of EC 0x00 (ARM ARM D17.2.37,
        // ESR_ELx EC 0b011000; measured on the M5 Pro in M11). Both are "UNDEFINED" here.
        0x00 | 0x18 => UNDEFS.bump(),
        0x07 | 0x19 | 0x1d => FEATURE_TRAPS.bump(),
        0x25 if f.esr & 0x3f == 0x21 => ALIGNMENT_FAULTS.bump(),
        0x25 => DATA_ABORTS.bump(),
        _ => return false, // unexpected: report and stop the VM
    }
    // A fault leaves ELR_EL1 at the faulting instruction (ARM ARM D1.10.1): step over it.
    f.elr += 4;
    true
}

/// Count and step over UNDEFs and EL1 data aborts (module docs).
pub fn install_fault_counter() {
    set_sync_hook(Some(count_and_skip));
}

/// One `width`-byte load (1, 2, 4 or 8; anything else is an 8-byte load) from `addr`.
pub fn mmio_read(addr: u64, width: u32) -> u64 {
    let v: u64;
    // SAFETY: the hostile guests only pass device windows, holes and RAM they own; the access
    // either traps to the VMM, faults into `count_and_skip`, or reads memory. No Rust object
    // lives at a device address.
    unsafe {
        match width {
            1 => asm!("ldrb {v:w}, [{a}]", v = out(reg) v, a = in(reg) addr, options(nostack)),
            2 => asm!("ldrh {v:w}, [{a}]", v = out(reg) v, a = in(reg) addr, options(nostack)),
            4 => asm!("ldr {v:w}, [{a}]", v = out(reg) v, a = in(reg) addr, options(nostack)),
            _ => asm!("ldr {v}, [{a}]", v = out(reg) v, a = in(reg) addr, options(nostack)),
        }
    }
    v
}

/// One `width`-byte store of the low bytes of `v` to `addr` (same widths as [`mmio_read`]).
pub fn mmio_write(addr: u64, width: u32, v: u64) {
    // SAFETY: as `mmio_read`; the targets are device windows, never this guest's code, stack
    // or data.
    unsafe {
        match width {
            1 => asm!("strb {v:w}, [{a}]", v = in(reg) v, a = in(reg) addr, options(nostack)),
            2 => asm!("strh {v:w}, [{a}]", v = in(reg) v, a = in(reg) addr, options(nostack)),
            4 => asm!("str {v:w}, [{a}]", v = in(reg) v, a = in(reg) addr, options(nostack)),
            _ => asm!("str {v}, [{a}]", v = in(reg) v, a = in(reg) addr, options(nostack)),
        }
    }
}

/// The virtio-mmio slots of the `virt` board (PLAN §1).
pub const VIRTIO_BASE: u64 = 0x0a00_0000;
pub const VIRTIO_STRIDE: u64 = 0x200;
pub const VIRTIO_SLOTS: u64 = 32;

/// A 32-bit virtio-mmio register write/read on slot `slot` (the only legal width, §4.2.2.1).
pub fn vreg_write(slot: u64, off: u64, v: u32) {
    mmio_write(VIRTIO_BASE + slot * VIRTIO_STRIDE + off, 4, u64::from(v));
}
pub fn vreg_read(slot: u64, off: u64) -> u32 {
    mmio_read(VIRTIO_BASE + slot * VIRTIO_STRIDE + off, 4) as u32
}
