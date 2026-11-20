//! `smp-race`: PSCI CPU_ON, CPU_OFF and AFFINITY_INFO on a real 4-vCPU machine (course ch20,
//! PLAN M16; Arm DEN 0022 §5.1.3–5.1.5; architecture §8.1, §8.6; threat model HC-3).
//!
//! Run with `--cpus 4`. CPU 0 drives everything and is the only CPU that prints; the others
//! report through per-CPU cells in RAM (one writer each, plain stores: with the MMU off an
//! atomic read-modify-write would fault, guest `hostile.rs` module docs).
//!
//! 1. `cpu_on(1)` twice in a row: the first is SUCCESS (0); the second finds CPU 1 still
//!    starting (ON_PENDING, -5) or already running (ALREADY_ON, -4), never a second start.
//! 2. CPU 1, then CPU 2, each report `MPIDR_EL1` from their own core: `0x8000_0001`,
//!    `0x8000_0002` (the VMM writes `0x8000_0000 | i`, architecture §8.1).
//! 3. **The race:** CPUs 0, 1 and 2 call `CPU_ON(3)` at the same moment: exactly one
//!    SUCCESS; the other two get -4 or -5 (HC-3, the per-target mutex in `psci.rs`).
//! 4. CPU 3 reports its MPIDR, then calls CPU_OFF; CPU 0 polls AFFINITY_INFO(3) until it is
//!    OFF (1) and prints it.
//! 5. CPU_ON(3) again succeeds and CPU 3 comes back with the new context.
//! 6. Refusals: an MPIDR with no vCPU is -2 (INVALID_PARAMETERS), an entry outside RAM -9
//!    (INVALID_ADDRESS), AFFINITY_INFO at level 1 -2.
//!
//! Then `smp-race: done` and SYSTEM_OFF (exit 0). Any wrong answer prints `FAILED` and
//! exits through DEBUG_EXIT(1).
#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU64, Ordering};
use guest::println;
use guest::psci;
use guest::start::{cpu_index, secondary_entry_point, set_secondary_entry};

guest::entry!(main);

/// `UP[i]`: the MPIDR CPU `i` read, written by CPU `i` once it runs (0 = not yet).
static UP: [AtomicU64; 4] = [const { AtomicU64::new(0) }; 4];
/// `RACE[i]`: CPU `i`'s CPU_ON(3) result plus `RACE_DONE` (so 0 means "not yet").
static RACE: [AtomicU64; 4] = [const { AtomicU64::new(0) }; 4];
const RACE_DONE: u64 = 0x100;
/// Set by CPU 0: CPUs 1 and 2 start their CPU_ON(3) when it becomes 1.
static GO: AtomicU64 = AtomicU64::new(0);
/// Set by CPU 0: CPU 3 calls CPU_OFF when it becomes 1.
static OFF3: AtomicU64 = AtomicU64::new(0);
/// The context CPU 3 was last started with (written by CPU 3).
static CTX3: AtomicU64 = AtomicU64::new(0);

/// The context of the second start of CPU 3.
const AGAIN: u64 = 0x33;

fn mpidr() -> u64 {
    let m: u64;
    // SAFETY: reads an ID register; no memory access, no side effects.
    unsafe { core::arch::asm!("mrs {}, mpidr_el1", out(reg) m, options(nomem, nostack)) };
    m
}

/// Poll `cond` for up to two seconds of guest time.
fn within_2s(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = guest::cntvct() + 2 * guest::cntfrq();
    while guest::cntvct() < deadline {
        if cond() {
            return true;
        }
    }
    cond()
}

fn fail(what: &str) -> ! {
    println!("smp-race: FAILED: {what}");
    guest::hvc::debug_exit(1)
}

/// What every secondary runs, with its CPU_ON context (here: the CPU's own index, or `AGAIN`).
fn secondary(ctx: u64) {
    let i = cpu_index() as usize;
    match i {
        1 | 2 => {
            UP[i].store(mpidr(), Ordering::SeqCst);
            while GO.load(Ordering::SeqCst) == 0 {}
            let r = psci::cpu_on(3, secondary_entry_point(), 3);
            RACE[i].store((r as u64).wrapping_add(RACE_DONE), Ordering::SeqCst);
            psci::halt()
        }
        3 => {
            CTX3.store(ctx, Ordering::SeqCst);
            UP[3].store(mpidr(), Ordering::SeqCst);
            if ctx == AGAIN {
                psci::halt()
            }
            while OFF3.load(Ordering::SeqCst) == 0 {}
            // Returning makes `guest_secondary_main` call PSCI CPU_OFF.
        }
        _ => psci::halt(),
    }
}

fn wait_up(i: usize) -> u64 {
    if !within_2s(|| UP[i].load(Ordering::SeqCst) != 0) {
        fail("a started CPU never ran");
    }
    let m = UP[i].load(Ordering::SeqCst);
    println!("smp-race: cpu {i} up mpidr={m:#x}");
    if m != 0x8000_0000 | i as u64 {
        fail("wrong MPIDR");
    }
    m
}

fn main(_x0: u64) {
    set_secondary_entry(secondary);
    let entry = secondary_entry_point();
    println!("smp-race: cpu 0 mpidr={:#x} entry={entry:#x}", mpidr());
    for i in 1..4u64 {
        if psci::affinity_info(i, 0) != 1 {
            fail("a secondary is not OFF at boot");
        }
    }

    // 1. Two CPU_ONs in a row for CPU 1.
    let first = psci::cpu_on(1, entry, 1);
    let second = psci::cpu_on(1, entry, 1);
    println!("smp-race: cpu_on(1) first={first} second={second}");
    if first != 0 || !(second == -4 || second == -5) {
        fail("cpu_on(1)");
    }
    // 2. CPUs 1 and 2 up.
    wait_up(1);
    if psci::affinity_info(1, 0) != 0 {
        fail("affinity_info(1) is not ON while it runs");
    }
    if psci::cpu_on(2, entry, 2) != 0 {
        fail("cpu_on(2)");
    }
    wait_up(2);

    // 3. Three CPUs race CPU_ON(3).
    GO.store(1, Ordering::SeqCst);
    let r0 = psci::cpu_on(3, entry, 3);
    RACE[0].store((r0 as u64).wrapping_add(RACE_DONE), Ordering::SeqCst);
    if !within_2s(|| (0..3).all(|i| RACE[i].load(Ordering::SeqCst) != 0)) {
        fail("a racer never answered");
    }
    let results = [0usize, 1, 2].map(|i| RACE[i].load(Ordering::SeqCst).wrapping_sub(RACE_DONE) as i64);
    let wins = results.iter().filter(|&&r| r == 0).count();
    let refused = results.iter().filter(|&&r| r == -4 || r == -5).count();
    println!(
        "smp-race: cpu_on(3) race: cpu0={} cpu1={} cpu2={} successes={wins} refused={refused}",
        results[0], results[1], results[2]
    );
    if wins != 1 || refused != 2 {
        fail("the CPU_ON race did not have exactly one winner");
    }
    wait_up(3);

    // 4. CPU 3 turns itself off; AFFINITY_INFO(3) must reach OFF.
    OFF3.store(1, Ordering::SeqCst);
    if !within_2s(|| psci::affinity_info(3, 0) == 1) {
        fail("affinity_info(3) never became OFF");
    }
    println!("smp-race: cpu_off(3) affinity={}", psci::affinity_info(3, 0));

    // 5. And on again, with a new context.
    UP[3].store(0, Ordering::SeqCst);
    let again = psci::cpu_on(3, entry, AGAIN);
    if again != 0 || !within_2s(|| UP[3].load(Ordering::SeqCst) != 0) {
        fail("cpu_on(3) after cpu_off(3)");
    }
    println!(
        "smp-race: cpu 3 back on ctx={:#x} affinity={}",
        CTX3.load(Ordering::SeqCst),
        psci::affinity_info(3, 0)
    );

    // 6. Refusals.
    let no_cpu = psci::cpu_on(4, entry, 0);
    let bad_entry = psci::cpu_on(1, 0x1000, 0);
    let level1 = psci::affinity_info(1, 1);
    println!("smp-race: cpu_on(4)={no_cpu} bad_entry={bad_entry} affinity_level1={level1}");
    if no_cpu != -2 || bad_entry != -9 || level1 != -2 {
        fail("refusals");
    }
    println!("smp-race: done");
}
