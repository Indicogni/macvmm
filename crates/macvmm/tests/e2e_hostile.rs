//! E2E suite `hostile` (threat model TEST-7, §9.4): bare-metal guests that attack the VMM from
//! inside a real VM. The VMM must survive each phase and end with that phase's exit code.
//!
//! ```text
//! scripts/test-e2e.sh hostile
//! # = cargo test -p macvmm --features hvf-tests --test e2e_hostile -- --test-threads=1
//! ```
//!
//! Phases arrive with the milestones that own them (PLAN §2.2 table): 1, 3, 6, 7 and 8 with
//! M11, 4 and 5 with M11/M12/M14/M16, and **phase 2 (ISV = 0 garbage) with M17**, below. Each
//! test asserts the exit code and a `[stderr]` marker only the VMM prints (AS10).
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::time::Duration;
use support::{expect, expect_code, guest, run};

const T10: Duration = Duration::from_secs(10);

/// TEST-7 phase 2 (M17, MMIO-4, MMIO-6): pairs across a device boundary (MMU off, and MMU on
/// with the second page mapped to the PL011) and SIMD loads/stores are all answered with
/// synchronous external aborts that the guest counts; nothing is half-written; exit 0.
#[test]
fn hostile_isv0() {
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--testdev",
            "--kernel",
            &guest("hostile-isv0"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("hostile_isv0", &o, 0);
    expect("hostile-isv0", &o);
}
