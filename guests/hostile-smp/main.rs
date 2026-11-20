//! `hostile-smp`: TEST-7 phases 4 and 5 (live TOCTOU) from several vCPUs at once (threat model
//! §9.4 TEST-7, §10.2 M16; PLAN M16 "Security tests"; HC-1, HC-3, HC-4, VQ-1..7, MEM-7).
//!
//! The phase is chosen by the machine the guest finds in its device tree:
//!
//! **Phase 4, SMCCC/PSCI garbage (`--cpus 4`, no virtio device).** CPU 0 starts CPUs 1..3
//! (CPU_ON must succeed for each). Then:
//! 1. every CPU makes 3000 random SMCCC calls at once: random `x0` (fully random, or inside
//!    the PSCI, SMCCC-arch and macvmm-vendor ranges), random arguments drawn from interesting
//!    values (bad MPIDRs, entry points outside RAM or misaligned, `u64::MAX`), plus `hvc` with a
//!    non-zero immediate and `smc #0`. The only calls left out are those that end the VM or
//!    the CPU on purpose (SYSTEM_OFF, SYSTEM_RESET, CPU_OFF, DEBUG_EXIT) and DEBUG_PUTC (it
//!    would print noise). A random CPU_ON must never succeed (its entry is never valid), and
//!    AFFINITY_INFO must answer 0, 1, 2 or -2;
//! 2. CPU 3 turns itself off, and CPUs 0, 1 and 2 storm `CPU_ON(3)` with a valid entry 20,000
//!    times each, interleaved with bad entries (-9) and bad MPIDRs (-2). CPU 3, each time it
//!    is started, counts the start and turns itself off again. When the storm is over the
//!    number of SUCCESS answers must equal the number of starts CPU 3 counted: one start per
//!    SUCCESS, never a double start (HC-3).
//!
//! **Phase 5, live TOCTOU (`--cpus 2` with `--rng` and/or `--disk`).** For each rng and blk
//! slot, for 10 s: CPU 1 rewrites the queue's descriptors (address, length, flags, next) and
//! avail-ring heads in a tight loop, with no exit at all, while CPU 0 keeps publishing
//! well-formed requests and ringing the doorbell, and re-handshakes the device whenever it
//! reports DEVICE_NEEDS_RESET. Every address CPU 1 writes is either inside the top 2 MiB of RAM
//! (the queue's own area: whatever the device writes there cannot hit this guest's code or
//! stacks) or deliberately invalid (MMIO, the GIC, the hole above RAM, straddling the end of
//! RAM, near `u64::MAX`). The VMM must read each descriptor once and validate the copy
//! (MEM-7): the only acceptable outcomes are a served request or NEEDS_RESET. Afterwards CPU 1
//! stops and one clean request must be served: the device recovered.
//!
//! **The device-side oracle (canary).** The guest's own MMIO accesses say nothing about where
//! the VMM's devices read or wrote. So before phase 5, CPU 0 fills a canary region with a known
//! pattern: up to 16 MiB of RAM just below the queue area, which no descriptor ever names
//! (every in-RAM address CPU 1 writes is inside the area, and every length that would leave it
//! runs off the end of RAM instead, which the VMM must refuse). It takes the VMM's own
//! DEBUG_MEMHASH of the region before the first round and after each one (the debug calls are
//! on for test guests): a device that validated one copy of a descriptor and then wrote through
//! a re-read, or mis-computed an address, and hit RAM outside the area changes the hash. Each
//! round prints `canary intact` or fails.
//!
//! The VMM must not stop on its own: the guest prints its counts, `hostile-smp: survived`, and
//! powers off (exit 0). Cross-CPU state is plain loads and stores (one writer per cell): with
//! the MMU off an atomic read-modify-write would fault (`guest/hostile.rs` module docs).
#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU64, Ordering};
use guest::fdt::Fdt;
use guest::hostile::{XorShift, install_fault_counter, vreg_read, vreg_write};
use guest::hvc::{DEBUG_EXIT, DEBUG_PUTC};
use guest::println;
use guest::psci;
use guest::start::{cpu_index, secondary_entry_point, set_secondary_entry};

guest::entry!(main);

const MAX_CPUS: usize = 4;
const SEQ: Ordering = Ordering::SeqCst;

// ---- Cross-CPU cells (one writer each) ------------------------------------------------------

/// Context words: the high byte says what a secondary does when CPU_ON starts it.
const CTX_RANDOM: u64 = 0x100;
const CTX_STORM_TARGET: u64 = 0x200;
const CTX_SCRIBBLE: u64 = 0x300;

/// `RANDOM_DONE[i]`: 1 + the number of unexpected answers CPU `i` saw in phase 4.1.
static RANDOM_DONE: [AtomicU64; MAX_CPUS] = [const { AtomicU64::new(0) }; MAX_CPUS];
/// Phase 4.2: CPU 0 sets it to start the storm.
static STORM_GO: AtomicU64 = AtomicU64::new(0);
/// `STORM_WINS[i]`: 1 + CPU `i`'s SUCCESS count in the storm (0 = not finished).
static STORM_WINS: [AtomicU64; MAX_CPUS] = [const { AtomicU64::new(0) }; MAX_CPUS];
/// `STORM_BAD[i]`: CPU `i`'s wrong answers in the storm.
static STORM_BAD: [AtomicU64; MAX_CPUS] = [const { AtomicU64::new(0) }; MAX_CPUS];
/// How many times CPU 3 was started by the storm (written by CPU 3 only).
static STARTS3: AtomicU64 = AtomicU64::new(0);

/// Phase 5: the scribbler's job. CPU 0 writes `TOCTOU_BASE`/`TOCTOU_QS`, then `TOCTOU_RUN =
/// round`; CPU 1 scribbles while `TOCTOU_RUN == round`, then sets `TOCTOU_ACK = round`.
static TOCTOU_BASE: AtomicU64 = AtomicU64::new(0);
static TOCTOU_END: AtomicU64 = AtomicU64::new(0);
static TOCTOU_QS: AtomicU64 = AtomicU64::new(0);
static TOCTOU_RUN: AtomicU64 = AtomicU64::new(0);
static TOCTOU_ACK: AtomicU64 = AtomicU64::new(0);
/// CPU 1's descriptor rewrites in the current round.
static SCRIBBLES: AtomicU64 = AtomicU64::new(0);

// ---- Helpers --------------------------------------------------------------------------------

/// Poll `cond` for up to `secs` seconds of guest time.
fn within(secs: u64, mut cond: impl FnMut() -> bool) -> bool {
    let deadline = guest::cntvct() + secs * guest::cntfrq();
    while guest::cntvct() < deadline {
        if cond() {
            return true;
        }
    }
    cond()
}

fn poke<T>(addr: u64, v: T) {
    // SAFETY: callers pass aligned addresses inside the top 2 MiB of RAM that this guest
    // reserved for the queue (`toctou_area`); no Rust object lives there.
    unsafe { core::ptr::write_volatile(addr as *mut T, v) }
}

fn peek<T: Copy>(addr: u64) -> T {
    // SAFETY: as `poke`.
    unsafe { core::ptr::read_volatile(addr as *const T) }
}

/// `hvc #imm` with a non-zero immediate: not SMCCC, the VMM must answer -1 (architecture §8.6).
fn hvc_imm(which: u64, x0: u64) -> i64 {
    let mut r = x0;
    // SAFETY: as `guest::hvc::hvc_call`: traps to the VMM, which may write x0..x3 and clobber
    // x4..x17.
    unsafe {
        match which % 3 {
            0 => core::arch::asm!("hvc #1", inout("x0") r, lateout("x1") _, lateout("x2") _,
                lateout("x3") _, lateout("x4") _, lateout("x5") _, lateout("x6") _,
                lateout("x7") _, lateout("x8") _, lateout("x9") _, lateout("x10") _,
                lateout("x11") _, lateout("x12") _, lateout("x13") _, lateout("x14") _,
                lateout("x15") _, lateout("x16") _, lateout("x17") _, options(nostack)),
            1 => core::arch::asm!("hvc #0x4d56", inout("x0") r, lateout("x1") _,
                lateout("x2") _, lateout("x3") _, lateout("x4") _, lateout("x5") _,
                lateout("x6") _, lateout("x7") _, lateout("x8") _, lateout("x9") _,
                lateout("x10") _, lateout("x11") _, lateout("x12") _, lateout("x13") _,
                lateout("x14") _, lateout("x15") _, lateout("x16") _, lateout("x17") _,
                options(nostack)),
            _ => core::arch::asm!("hvc #0xffff", inout("x0") r, lateout("x1") _,
                lateout("x2") _, lateout("x3") _, lateout("x4") _, lateout("x5") _,
                lateout("x6") _, lateout("x7") _, lateout("x8") _, lateout("x9") _,
                lateout("x10") _, lateout("x11") _, lateout("x12") _, lateout("x13") _,
                lateout("x14") _, lateout("x15") _, lateout("x16") _, lateout("x17") _,
                options(nostack)),
        }
    }
    r as i64
}

/// `smc #0` with PSCI_VERSION: the VMM accepts SMC as a second conduit (architecture §8.6). If
/// the framework did not trap it, it is UNDEFINED at EL1 and the fault counter steps over it.
fn smc_version() -> u64 {
    let mut r = psci::VERSION;
    // SAFETY: as `hvc_imm`.
    unsafe {
        core::arch::asm!("smc #0", inout("x0") r, lateout("x1") _, lateout("x2") _,
            lateout("x3") _, lateout("x4") _, lateout("x5") _, lateout("x6") _,
            lateout("x7") _, lateout("x8") _, lateout("x9") _, lateout("x10") _,
            lateout("x11") _, lateout("x12") _, lateout("x13") _, lateout("x14") _,
            lateout("x15") _, lateout("x16") _, lateout("x17") _, options(nostack));
    }
    r
}

// ---- Phase 4 ---------------------------------------------------------------------------------

/// The calls a random sweep must not make (by SMCCC function ID, the low 32 bits of x0): they
/// end the VM or the calling CPU on purpose, or print.
fn denied(fid: u32) -> bool {
    matches!(
        fid,
        0x8400_0002 | 0x8400_0008 | 0x8400_0009 | 0xC400_0008 | 0xC400_0009
    ) || u64::from(fid) == DEBUG_EXIT & 0xffff_ffff
        || u64::from(fid) == DEBUG_PUTC & 0xffff_ffff
}

/// An interesting argument: a bad MPIDR, an entry point outside RAM or misaligned, a level, or
/// noise.
fn arg(r: &mut XorShift, ram_end: u64) -> u64 {
    const PICKS: [u64; 12] = [
        0,
        1,
        3,
        4,
        0x100,
        0x8000_0001,
        0x1_0000_0000,
        0x1000,
        0x0900_0000,
        0x4008_0002,
        u64::MAX,
        0x7fff_ffff_ffff_ffff,
    ];
    match r.below(4) {
        0 => r.next(),
        1 => ram_end.wrapping_add(r.below(16)), // the hole just above RAM
        _ => PICKS[r.below(PICKS.len() as u64) as usize],
    }
}

/// Phase 4.1 on the calling CPU: 3000 random calls. Returns the number of wrong answers.
fn random_calls(seed: u64, ram_end: u64) -> u64 {
    let mut r = XorShift::new(seed);
    let mut bad = 0u64;
    for n in 0..3000u64 {
        if n % 97 == 0 {
            bad += u64::from(hvc_imm(r.next(), r.next()) != -1);
            continue;
        }
        if n % 211 == 0 {
            let v = smc_version();
            bad += u64::from(v != 0x10001 && v != psci::VERSION);
            continue;
        }
        let mut x0 = match r.below(8) {
            0 | 1 => r.next(),
            2 | 3 => 0x8400_0000 | r.below(0x20),
            4 | 5 => 0xC400_0000 | r.below(0x20),
            6 => 0xC600_4D00 | r.below(0x10),
            _ => [0x8000_0000, 0x8000_0001, 0x8200_0000, 0xC600_0000, 0x8600_0000]
                [r.below(5) as usize],
        };
        if denied(x0 as u32) {
            x0 = psci::VERSION;
        }
        let (a1, mut a2, a3) = (arg(&mut r, ram_end), arg(&mut r, ram_end), arg(&mut r, ram_end));
        if matches!(x0 as u32, 0x8400_0003 | 0xC400_0003) {
            // A CPU_ON entry that is never valid, even truncated to 32 bits (SMC32): outside
            // RAM or misaligned. A valid one could start an off CPU at random bytes.
            const BAD_ENTRY: [u64; 6] = [0, 0x1000, 0x0900_0000, 0x4008_0002, u64::MAX, 3];
            a2 = BAD_ENTRY[r.below(BAD_ENTRY.len() as u64) as usize];
        }
        let ret = guest::hvc::hvc_call(x0, a1, a2, a3)[0] as i64;
        match x0 as u32 {
            // CPU_ON with a random entry: never valid, so never SUCCESS (HC-3).
            0x8400_0003 | 0xC400_0003 => bad += u64::from(ret != -2 && ret != -9),
            // AFFINITY_INFO: a state or INVALID_PARAMETERS (HC-4).
            0x8400_0004 | 0xC400_0004 => bad += u64::from(!(-2..=2).contains(&ret) || ret == -1),
            _ => {}
        }
    }
    bad
}

/// Phase 4.2 on the calling CPU: the CPU_ON storm at CPU 3. Returns (successes, wrong answers).
fn storm(seed: u64) -> (u64, u64) {
    let entry = secondary_entry_point();
    let mut r = XorShift::new(seed);
    let (mut wins, mut bad) = (0u64, 0u64);
    for n in 0..20_000u64 {
        let ret = psci::cpu_on(3, entry, CTX_STORM_TARGET | 3);
        match ret {
            0 => wins += 1,
            -4 | -5 => {}
            _ => bad += 1,
        }
        if n % 16 == 0 {
            // Interleaved refusals, and AFFINITY_INFO while the target cycles.
            bad += u64::from(psci::cpu_on(3, 0x1000 + 4 * r.below(16), 0) != -9);
            bad += u64::from(psci::cpu_on(3, entry + 2, 0) != -9);
            bad += u64::from(psci::cpu_on(0x400 + r.below(256), entry, 0) != -2);
            bad += u64::from(!(0..=2).contains(&psci::affinity_info(3, 0)));
        }
    }
    (wins, bad)
}

fn phase4(ram_end: u64) -> u64 {
    let entry = secondary_entry_point();
    let mut bad = 0u64;
    for i in 1..4u64 {
        if psci::cpu_on(i, entry, CTX_RANDOM | i) != 0 {
            println!("hostile-smp: FAILED: cpu_on({i})");
            bad += 1;
        }
    }
    let mine = random_calls(0x5eed_0000, ram_end);
    RANDOM_DONE[0].store(1 + mine, SEQ);
    if !within(20, || (0..4).all(|i| RANDOM_DONE[i].load(SEQ) != 0)) {
        println!("hostile-smp: FAILED: a CPU never finished its random calls");
        return bad + 1;
    }
    let unexpected: u64 = (0..4).map(|i| RANDOM_DONE[i].load(SEQ) - 1).sum();
    println!("hostile-smp: phase 4: cpus=4 random calls=12000 unexpected={unexpected}");
    bad += unexpected;
    // CPU 3 returned from its random calls and called CPU_OFF.
    if !within(2, || psci::affinity_info(3, 0) == 1) {
        println!("hostile-smp: FAILED: cpu 3 did not turn off");
        return bad + 1;
    }
    STORM_GO.store(1, SEQ);
    let (w0, b0) = storm(0x5707_0000);
    STORM_WINS[0].store(1 + w0, SEQ);
    STORM_BAD[0].store(b0, SEQ);
    if !within(20, || (0..3).all(|i| STORM_WINS[i].load(SEQ) != 0)) {
        println!("hostile-smp: FAILED: a racer never finished the storm");
        return bad + 1;
    }
    let wins: u64 = (0..3).map(|i| STORM_WINS[i].load(SEQ) - 1).sum();
    let wrong: u64 = (0..3).map(|i| STORM_BAD[i].load(SEQ)).sum();
    // The last SUCCESS may still be starting: wait until CPU 3 counted it and is off again.
    let settled = within(5, || {
        STARTS3.load(SEQ) == wins && psci::affinity_info(3, 0) == 1
    });
    let starts = STARTS3.load(SEQ);
    println!(
        "hostile-smp: storm: cpu_on successes={wins} cpu 3 starts={starts} wrong answers={wrong}"
    );
    if !settled || wins == 0 || wrong != 0 {
        println!("hostile-smp: FAILED: storm");
        bad += 1;
    }
    bad
}

// ---- Phase 5: live TOCTOU --------------------------------------------------------------------

const STATUS: u64 = 0x070;
const QUEUE_NOTIFY: u64 = 0x050;
const INTERRUPT_ACK: u64 = 0x064;
const NEEDS_RESET: u32 = 64;
const DEVICE_ID_BLOCK: u32 = 2;
const DEVICE_ID_RNG: u32 = 4;
/// The queue size used for both devices (≤ every device's QueueNumMax).
const QS: u64 = 16;
const F_NEXT: u16 = 1;
const F_WRITE: u16 = 2;
/// The queue area's layout from its base (the top 2 MiB of RAM).
const AVAIL: u64 = 0x1000;
const USED: u64 = 0x2000;
const HDR: u64 = 0x3000;
const STAT: u64 = 0x3010;
const DATA: u64 = 0x4000;
const AREA_SIZE: u64 = 2 << 20;
/// The canary region's size: right below the queue area (module docs).
const CANARY_SIZE: u64 = 16 << 20;
/// The canary may not start below this: the guest image, its stacks and the DTB slot live in
/// the first few MiB of RAM (`guests/common/link.ld`).
const CANARY_FLOOR: u64 = 0x4100_0000;

fn desc(base: u64, i: u64, addr: u64, len: u32, flags: u16, next: u16) {
    let at = base + 16 * (i % QS);
    poke::<u64>(at, addr);
    poke::<u32>(at + 8, len);
    poke::<u16>(at + 12, flags);
    poke::<u16>(at + 14, next);
}

/// Handshake `slot` with queue 0 in the area at `base` (VERSION_1 only). Returns Status.
fn up(slot: u64, base: u64) -> u32 {
    for off in (0..DATA).step_by(8) {
        poke::<u64>(base + off, 0);
    }
    vreg_write(slot, STATUS, 0);
    vreg_write(slot, STATUS, 1);
    vreg_write(slot, STATUS, 3);
    vreg_write(slot, 0x024, 0);
    vreg_write(slot, 0x020, 0);
    vreg_write(slot, 0x024, 1);
    vreg_write(slot, 0x020, 1);
    vreg_write(slot, STATUS, 11);
    vreg_write(slot, 0x030, 0);
    vreg_write(slot, 0x038, QS as u32);
    for (lo, a) in [(0x080, base), (0x090, base + AVAIL), (0x0a0, base + USED)] {
        vreg_write(slot, lo, a as u32);
        vreg_write(slot, lo + 4, (a >> 32) as u32);
    }
    vreg_write(slot, 0x044, 1);
    vreg_write(slot, STATUS, 15);
    vreg_read(slot, STATUS)
}

/// A well-formed request at descriptor `k`: rng one writable 512-byte buffer; blk IN of
/// sector 0 (header, 512-byte data, status).
fn sane_request(base: u64, blk: bool, k: u64) {
    if blk {
        poke::<u32>(base + HDR, 0); // VIRTIO_BLK_T_IN
        poke::<u32>(base + HDR + 4, 0);
        poke::<u64>(base + HDR + 8, 0);
        poke::<u8>(base + STAT, 0xee);
        desc(base, k, base + HDR, 16, F_NEXT, ((k + 1) % QS) as u16);
        desc(base, k + 1, base + DATA, 512, F_WRITE | F_NEXT, ((k + 2) % QS) as u16);
        desc(base, k + 2, base + STAT, 1, F_WRITE, 0);
    } else {
        desc(base, k, base + DATA, 512, F_WRITE, 0);
    }
}

fn publish(slot: u64, base: u64, idx: u16, head: u16) {
    poke::<u16>(base + AVAIL + 4 + 2 * (u64::from(idx) % QS), head);
    // SAFETY: a barrier instruction; orders the entry before the index (virtio 1.2 §2.7.13).
    unsafe { core::arch::asm!("dmb ish", options(nostack, preserves_flags)) };
    poke::<u16>(base + AVAIL + 2, idx.wrapping_add(1));
    vreg_write(slot, QUEUE_NOTIFY, 0);
}

/// CPU 1's job (module docs): rewrite descriptors and heads until CPU 0 ends the round.
fn scribble(round: u64) {
    let base = TOCTOU_BASE.load(SEQ);
    let end = TOCTOU_END.load(SEQ);
    let qs = TOCTOU_QS.load(SEQ);
    let mut r = XorShift::new(0x70c70 + round);
    let mut n = 0u64;
    while TOCTOU_RUN.load(SEQ) == round {
        let addr = match r.below(10) {
            0 | 1 | 2 => base + DATA + 8 * r.below(0x1000),
            3 | 4 => base + 8 * r.below(AREA_SIZE / 8), // anywhere in the area, rings too
            5 => end - 8,                               // straddles the end of RAM
            6 => end,                                   // the hole above RAM
            7 => 0x0900_0000,                           // the PL011
            8 => 0x0800_0000,                           // the GIC distributor
            _ => u64::MAX - 7,
        };
        let len = match r.below(8) {
            0 => 0,
            1 => 1,
            2 => 512,
            3 => 4096,
            4 => 65537,
            5 => u32::MAX,
            _ => r.below(AREA_SIZE) as u32,
        };
        // Keep in-RAM writes inside the area: anything longer runs off the end of RAM, which
        // the VMM must refuse as a whole.
        let len = if addr >= base && addr < end && addr + u64::from(len) > end && r.below(2) == 0
        {
            (end - addr) as u32
        } else {
            len
        };
        let i = r.below(qs);
        desc(base, i, addr, len, r.below(8) as u16, r.below(qs + 4) as u16);
        if r.below(8) == 0 {
            poke::<u16>(base + AVAIL + 4 + 2 * r.below(qs), r.below(qs + 4) as u16);
        }
        n += 1;
    }
    SCRIBBLES.store(n, SEQ);
    TOCTOU_ACK.store(round, SEQ);
}

/// The canary region `[start, start + len)`: up to `CANARY_SIZE` bytes just below the queue
/// area, never below `CANARY_FLOOR`. `None` if RAM is too small for any.
fn canary_region(ram_end: u64) -> Option<(u64, u64)> {
    let area = (ram_end - AREA_SIZE) & !0xfff;
    let start = area.saturating_sub(CANARY_SIZE).max(CANARY_FLOOR);
    (start < area).then(|| (start, area - start))
}

/// Fill the canary with a pattern no device would produce by accident (never zero).
fn canary_fill(start: u64, len: u64) {
    let mut r = XorShift::new(0xca9a_7700);
    for off in (0..len).step_by(8) {
        poke::<u64>(start + off, r.next() | 1);
    }
}

/// The VMM's view of the canary (DEBUG_MEMHASH), or `None` if the call failed.
fn canary_hash(start: u64, len: u64) -> Option<u64> {
    guest::hvc::memhash(start, len).ok()
}

/// One live-TOCTOU round on `slot` (module docs). Returns the number of failed checks.
fn live_toctou(slot: u64, blk: bool, ram_end: u64, round: u64) -> u64 {
    let base = (ram_end - AREA_SIZE) & !0xfff;
    let name = if blk { "blk" } else { "rng" };
    if up(slot, base) != 15 {
        println!("hostile-smp: FAILED: {name} slot {slot} handshake");
        return 1;
    }
    TOCTOU_BASE.store(base, SEQ);
    TOCTOU_END.store(ram_end, SEQ);
    TOCTOU_QS.store(QS, SEQ);
    TOCTOU_RUN.store(round, SEQ);
    let mut r = XorShift::new(0xc0de + round);
    let (mut notifies, mut resets, mut served) = (0u64, 0u64, 0u64);
    let mut idx: u16 = 0;
    let deadline = guest::cntvct() + 10 * guest::cntfrq();
    while guest::cntvct() < deadline {
        let st = vreg_read(slot, STATUS);
        if st != 15 {
            // NEEDS_RESET (or anything else): count what was served, reset, handshake again.
            served += u64::from(peek::<u16>(base + USED + 2));
            resets += 1;
            vreg_write(slot, INTERRUPT_ACK, 3);
            if up(slot, base) & NEEDS_RESET != 0 {
                continue;
            }
            idx = 0;
            continue;
        }
        let k = r.below(QS - 2);
        sane_request(base, blk, k);
        publish(slot, base, idx, k as u16);
        idx = idx.wrapping_add(1);
        notifies += 1;
        // Give the worker a moment (about 50 µs), as a driver waiting for its request would.
        let t = guest::cntvct() + guest::cntfrq() / 20_000;
        while guest::cntvct() < t {}
    }
    served += u64::from(peek::<u16>(base + USED + 2));
    TOCTOU_RUN.store(0, SEQ);
    if !within(2, || TOCTOU_ACK.load(SEQ) == round) {
        println!("hostile-smp: FAILED: the scribbler did not stop");
        return 1;
    }
    // The device still works: one clean request on a fresh handshake.
    vreg_write(slot, INTERRUPT_ACK, 3);
    let recovered = up(slot, base) == 15 && {
        sane_request(base, blk, 0);
        publish(slot, base, 0, 0);
        let want_len = if blk { 513 } else { 512 };
        within(2, || peek::<u16>(base + USED + 2) == 1)
            && peek::<u32>(base + USED + 8) == want_len
            && (!blk || peek::<u8>(base + STAT) == 0)
            && vreg_read(slot, STATUS) == 15
    };
    vreg_write(slot, INTERRUPT_ACK, 3);
    vreg_write(slot, STATUS, 0);
    println!(
        "hostile-smp: live toctou {name} slot {slot}: notifies={notifies} served={served} \
         resets={resets} scribbles={} {}",
        SCRIBBLES.load(SEQ),
        if recovered { "recovered" } else { "FAILED to recover" }
    );
    u64::from(!recovered) + u64::from(notifies == 0)
}

// ---- Secondaries and main --------------------------------------------------------------------

fn secondary(ctx: u64) {
    let i = cpu_index();
    let ram_end = TOCTOU_END.load(SEQ);
    match ctx & !0xff {
        CTX_RANDOM => {
            let bad = random_calls(0x5eed_0000 + i, ram_end);
            RANDOM_DONE[i as usize].store(1 + bad, SEQ);
            if i == 3 {
                return; // CPU_OFF: the storm's target
            }
            while STORM_GO.load(SEQ) == 0 {}
            let (w, b) = storm(0x5707_0000 + i);
            STORM_BAD[i as usize].store(b, SEQ);
            STORM_WINS[i as usize].store(1 + w, SEQ);
            psci::halt()
        }
        CTX_STORM_TARGET => {
            // One writer (this CPU), started at most once at a time: load + store is exact.
            STARTS3.store(STARTS3.load(SEQ) + 1, SEQ);
            // Returning calls CPU_OFF, so the storm can start this CPU again.
        }
        CTX_SCRIBBLE => {
            let mut last = 0u64;
            loop {
                let round = TOCTOU_RUN.load(SEQ);
                if round != 0 && round != last {
                    scribble(round);
                    last = round;
                }
            }
        }
        _ => psci::halt(),
    }
}

/// The end of guest RAM from the DTB's `/memory@…` node (`reg = <base size>`, two cells each).
fn ram_end(fdt: &Fdt<'_>) -> Option<u64> {
    let mut name = "";
    fdt.children("/", "memory@", |n| name = n);
    let mut buf = [0u8; 64];
    let path_len = name.len().checked_add(1).filter(|&l| l <= buf.len())?;
    buf[0] = b'/';
    buf.get_mut(1..path_len)?.copy_from_slice(name.as_bytes());
    let path = core::str::from_utf8(buf.get(..path_len)?).ok()?;
    let reg = fdt.prop(path, "reg")?;
    if reg.len() != 16 {
        return None;
    }
    let cell = |i: usize| Some(u64::from_be_bytes(reg.get(i..i + 8)?.try_into().ok()?));
    cell(0)?.checked_add(cell(8)?)
}

fn main(x0: u64) {
    install_fault_counter();
    set_secondary_entry(secondary);
    // SAFETY: the VMM passes the DTB address in x0; its slot is mapped RAM, and `from_addr`
    // checks the header first.
    let Ok(fdt) = (unsafe { Fdt::from_addr(x0) }) else {
        println!("hostile-smp: FAILED: no device tree");
        return;
    };
    let Some(end) = ram_end(&fdt) else {
        println!("hostile-smp: FAILED: cannot read the RAM size from the DTB");
        return;
    };
    TOCTOU_END.store(end, SEQ);
    let cpus = fdt.children("/cpus", "cpu@", |_| {});
    let mut devices = [(0u64, 0u32); 4];
    let mut ndev = 0;
    for slot in 0..32 {
        let id = vreg_read(slot, 0x008);
        if (id == DEVICE_ID_RNG || id == DEVICE_ID_BLOCK) && ndev < devices.len() {
            devices[ndev] = (slot, id);
            ndev += 1;
        }
    }
    println!("hostile-smp: {cpus} cpus, {ndev} virtio devices, RAM ends at {end:#x}");
    let mut bad = 0u64;
    if ndev == 0 {
        if cpus < 4 {
            println!("hostile-smp: FAILED: phase 4 needs --cpus 4");
            return;
        }
        bad += phase4(end);
    } else {
        if cpus < 2 {
            println!("hostile-smp: FAILED: the live TOCTOU phase needs --cpus 2");
            return;
        }
        if psci::cpu_on(1, secondary_entry_point(), CTX_SCRIBBLE) != 0 {
            println!("hostile-smp: FAILED: cpu_on(1)");
            return;
        }
        let Some((c_start, c_len)) = canary_region(end) else {
            println!("hostile-smp: FAILED: RAM too small for the canary");
            return;
        };
        canary_fill(c_start, c_len);
        let Some(want) = canary_hash(c_start, c_len) else {
            println!("hostile-smp: FAILED: DEBUG_MEMHASH of the canary");
            return;
        };
        println!("hostile-smp: canary {c_start:#x}+{c_len:#x} hash {want:#x}");
        for (n, &(slot, id)) in devices[..ndev].iter().enumerate() {
            let blk = id == DEVICE_ID_BLOCK;
            bad += live_toctou(slot, blk, end, n as u64 + 1);
            let name = if blk { "blk" } else { "rng" };
            match canary_hash(c_start, c_len) {
                Some(h) if h == want => println!("hostile-smp: canary intact after {name}"),
                Some(h) => {
                    println!("hostile-smp: FAILED: canary changed after {name}: hash {h:#x}");
                    bad += 1;
                }
                None => {
                    println!("hostile-smp: FAILED: DEBUG_MEMHASH of the canary after {name}");
                    bad += 1;
                }
            }
        }
    }
    if bad == 0 {
        println!("hostile-smp: survived");
    } else {
        println!("hostile-smp: FAILED ({bad} failed checks)");
    }
}
