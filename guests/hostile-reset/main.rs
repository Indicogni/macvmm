//! `hostile-reset`: TEST-7 phase 7, a reset storm (threat model §9.4, HC-5; PLAN M11).
//!
//! Every boot prints its boot count and calls PSCI SYSTEM_RESET at once. Under the default
//! `--on-reset reboot`, each reset makes macvmm build a fresh machine (VM, GIC, RAM, devices),
//! which costs the host far more than it costs the guest. More than 10 resets within 10 s is
//! a reset storm: macvmm must stop with exit code 3 and say so on stderr, rather than let a
//! guest pin a host core rebuilding VMs forever.
#![no_std]
#![no_main]

use guest::hvc::boot_count;
use guest::{println, psci};

guest::entry!(main);

fn main(_x0: u64) {
    println!("hostile-reset: boot {}", boot_count());
    psci::reset()
}
