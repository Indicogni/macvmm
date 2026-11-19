//! `psci-probe`: the SMCCC and PSCI answers a guest gets from macvmm, then a reboot (course
//! ch08, PLAN M5; architecture §8.6, §14.5).
//!
//! Each line prints the value and `ok` or `FAILED` against architecture §8.6:
//! - PSCI_VERSION and SMCCC_VERSION → `0x10001` (1.1);
//! - PSCI_FEATURES(CPU_ON) → 0, PSCI_FEATURES(`0x8400_0099`) → -1 (no such function);
//! - a SiP call (`0x8200_0000`, OEN 2) → -1: not ours, never silent (HC-1);
//! - AFFINITY_INFO(0, 0) → 0 (this CPU is on); CPU_ON(MPIDR 1) on a 1-CPU machine → -2.
//!
//! Then the reboot: on boot 0 it prints `psci-probe: boot 0` and calls SYSTEM_RESET. Under
//! the default `--on-reset reboot` macvmm rebuilds the whole machine from the same input
//! bytes and DEBUG_BOOT_COUNT says 1, so the guest prints `psci-probe: boot 1` and powers off
//! (exit 0). Under `--on-reset exit` the process ends with exit code 4 after boot 0.
#![no_std]
#![no_main]

use guest::hvc::boot_count;
use guest::println;
use guest::psci;

guest::entry!(main);

fn check(what: &str, got: i64, want: i64) {
    let verdict = if got == want { "ok" } else { "FAILED" };
    println!("psci-probe: {what}={got} {verdict}");
}

fn main(_x0: u64) {
    let v = psci::version();
    println!(
        "psci-probe: version={v:#x} {}",
        if v == 0x10001 { "ok" } else { "FAILED" }
    );
    let s = psci::smccc_version();
    println!(
        "psci-probe: smccc_version={s:#x} {}",
        if s == 0x10001 { "ok" } else { "FAILED" }
    );
    check("features(CPU_ON)", psci::features(psci::CPU_ON), 0);
    check("features(0x84000099)", psci::features(0x8400_0099), -1);
    check("sip(0x82000000)", psci::call(0x8200_0000, 0, 0, 0), -1);
    check("affinity_info(0,0)", psci::affinity_info(0, 0), 0);
    check("cpu_on(1)", psci::cpu_on(1, 0x4008_0000, 0), -2);
    check("migrate_info_type", psci::migrate_info_type(), 2);

    match boot_count() {
        0 => {
            println!("psci-probe: boot 0");
            psci::reset()
        }
        n => {
            println!("psci-probe: boot {n}");
            psci::power_off()
        }
    }
}
