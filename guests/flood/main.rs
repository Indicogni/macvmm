//! `flood`: print `flood: <n>` through the PL011 forever (PLAN M6, threat model SINK-1; reused
//! by TEST-7 phase 8 as `hostile-flood`).
//!
//! It is the guest side of the `sink_backpressure` test: with macvmm's stdout connected to a
//! pipe nobody reads, the sink's queue fills, the vCPU waits at most 10 ms per byte and then
//! drops it, and a SIGTERM must still end the VM (exit code 130) within a second. Without the
//! SINK-1 queue the vCPU would block in `write(2)` outside `hv_vcpu_run`, where the stop kick
//! cannot reach it.
#![no_std]
#![no_main]

use guest::{println, uart};

guest::entry!(main);

fn main(_x0: u64) {
    uart::enable_console();
    let mut n: u64 = 0;
    loop {
        println!("flood: {n}");
        n = n.wrapping_add(1);
    }
}
