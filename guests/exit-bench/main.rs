//! `exit-bench`: what one guest → VMM → guest round trip costs (first-principles R4).
//!
//! A trap is the price of every emulated device access, so the course measures it rather than
//! quoting it. The guest makes 100,000 `hvc #0` calls with an SMCCC function ID nobody
//! implements (`0xC600_00FF`, in the macvmm vendor range), so the VMM does the least possible
//! work: decode the exit, dispatch, find nothing, return `NOT_SUPPORTED` (-1) in `x0`. The time
//! comes from the guest's own virtual counter (`CNTVCT_EL0`, `CNTFRQ_EL0` = 24 MHz on Apple
//! Silicon), read before and after, so it includes the world switch both ways plus our
//! handling (unlike the spike's 1.0–1.6 µs `hv_vcpu_run` figure, which is the host-side view).
#![no_std]
#![no_main]

use guest::println;

guest::entry!(main);

/// Calls made.
const N: u64 = 100_000;
/// An unimplemented function ID in the vendor-specific hypervisor range (SMCCC OEN 6).
const UNKNOWN_FN: u64 = 0xC600_00FF;

fn main(_x0: u64) {
    // ANCHOR: exit_bench_loop
    let t0 = guest::cntvct();
    let mut bad = 0u64;
    for _ in 0..N {
        let r = guest::hvc::hvc_call(UNKNOWN_FN, 0, 0, 0);
        if r[0] != u64::MAX {
            bad += 1; // the VMM must answer NOT_SUPPORTED (-1)
        }
    }
    let ticks = guest::cntvct().wrapping_sub(t0);
    // ANCHOR_END: exit_bench_loop
    if bad != 0 {
        println!("exit-bench: {bad} calls did not return NOT_SUPPORTED");
        guest::hvc::debug_exit(2);
    }
    let freq = guest::cntfrq().max(1);
    // ns per exit = ticks * 1e9 / freq / N, computed in u128 so nothing overflows.
    let ns = (u128::from(ticks) * 1_000_000_000) / (u128::from(freq) * u128::from(N));
    println!("exit-bench: {N} hvc in {ticks} ticks, {ns} ns/exit");
}
