//! Per-vCPU exit counters (architecture §16 "Stats"; course ch03, ch12).
//!
//! **Why count exits.** Every exit is a round trip guest → XNU → VMM → guest (exit-bench
//! measures a few microseconds each), so *how many* exits of *which* kind a workload makes is
//! the first performance question a VMM author asks, and the ch12 check that an idle guest
//! costs under 10 % of a host CPU is answered from these numbers. M4 keeps only the counters;
//! M8 adds `--stats`, `hv_vcpu_get_exec_time`, the WFI time and the host CPU time.
//!
//! Counters are owned by the vCPU thread (no atomics, no lock) and saturate instead of
//! wrapping. The summary contains only numbers and static names (LOG-5).
//!
//! **M8: `--stats`.** When a vCPU thread ends it files a [`VcpuStats`]: its exit counts, its
//! guest run time (`hv_vcpu_get_exec_time`) and its time in in-kernel WFI
//! (`hv_vcpu_get_wait_for_interrupt_time`, macOS 27+, GIC only). `Machine::run` adds the boot's
//! wall time and the process's host CPU time over the same span (`getrusage`, through
//! `hvf::host::process_cpu_time`) into a [`BootStats`], whose [`BootStats::report`] lines the
//! CLI prints after the verdict as `macvmm: stats: …`. Two numbers are the point of ch11/ch12:
//! the VTIMER and WFx exit counts (printed even when zero), which the `--irqchip none` timer
//! guest drives to ≥ 10 each and the in-kernel GIC drives to 0, and the host CPU percentage,
//! which shows that an idle guest under the in-kernel GIC costs almost nothing.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::esr::{self, Exit};
use core::fmt::Write as _;
use std::time::Duration;

/// The exit kinds counted, in [`Exit`] order.
pub const KINDS: [&str; 10] = [
    "canceled",
    "vtimer",
    "wfx",
    "hvc",
    "smc",
    "sysreg",
    "instruction abort",
    "data abort",
    "brk",
    "unknown",
];

const fn kind_index(e: &Exit) -> usize {
    match e {
        Exit::Canceled => 0,
        Exit::VtimerActivated => 1,
        Exit::Wfx { .. } => 2,
        Exit::Hvc { .. } => 3,
        Exit::Smc { .. } => 4,
        Exit::SysReg(_) => 5,
        Exit::InstructionAbort { .. } => 6,
        Exit::DataAbort(_) => 7,
        Exit::Brk { .. } => 8,
        Exit::Unknown { .. } => 9,
    }
}

/// One vCPU's exit counts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitStats {
    pub total: u64,
    pub by_kind: [u64; KINDS.len()],
    /// Indexed by `ESR_EL2.EC` (6 bits), for `EXCEPTION` exits.
    pub by_ec: [u64; 64],
}

impl Default for ExitStats {
    fn default() -> ExitStats {
        ExitStats {
            total: 0,
            by_kind: [0; KINDS.len()],
            by_ec: [0; 64],
        }
    }
}

impl ExitStats {
    pub fn new() -> ExitStats {
        ExitStats::default()
    }

    /// Count one exit. `exception` says whether `esr` is meaningful (an `EXCEPTION` exit).
    pub fn record(&mut self, exit: &Exit, esr: u64, exception: bool) {
        self.total = self.total.saturating_add(1);
        if let Some(c) = self.by_kind.get_mut(kind_index(exit)) {
            *c = c.saturating_add(1);
        }
        if exception && let Some(c) = self.by_ec.get_mut(usize::from(esr::esr_ec(esr))) {
            *c = c.saturating_add(1);
        }
    }

    /// The count for kind `name` (one of [`KINDS`]).
    pub fn kind(&self, name: &str) -> u64 {
        KINDS
            .iter()
            .position(|k| *k == name)
            .and_then(|i| self.by_kind.get(i))
            .copied()
            .unwrap_or(0)
    }

    /// `total N: hvc 12, data abort 3` (non-zero kinds only).
    pub fn summary(&self) -> String {
        let mut s = format!("total {}", self.total);
        let mut sep = ": ";
        for (name, n) in KINDS.iter().zip(self.by_kind.iter()) {
            if *n > 0 {
                let _ = write!(s, "{sep}{name} {n}");
                sep = ", ";
            }
        }
        s
    }
}

/// One vCPU's numbers at the end of a boot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VcpuStats {
    pub index: usize,
    pub exits: ExitStats,
    /// Guest run time (`hv_vcpu_get_exec_time`), converted to ns; `None` if unreadable.
    pub exec_ns: Option<u64>,
    /// Time in in-kernel WFI, ns; `None` before macOS 27 or without a GIC.
    pub wfi_ns: Option<u64>,
}

/// One boot's numbers (module docs).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BootStats {
    pub vcpus: Vec<VcpuStats>,
    /// Wall time from the first vCPU spawn to the last join.
    pub wall: Duration,
    /// Process CPU time (user + system, every thread) over the same span.
    pub host_cpu: Option<Duration>,
}

/// `1.234 s` with millisecond precision.
fn secs(d: Duration) -> String {
    format!("{}.{:03} s", d.as_secs(), d.subsec_millis())
}

fn ns(v: Option<u64>) -> String {
    v.map_or_else(|| "n/a".to_owned(), |n| secs(Duration::from_nanos(n)))
}

impl BootStats {
    /// Host CPU time as a whole percentage of wall time (rounded up, so "0 %" means really
    /// idle), or `None` without a CPU time or with a zero wall time.
    pub fn host_cpu_percent(&self) -> Option<u64> {
        let cpu = self.host_cpu?.as_nanos();
        let wall = self.wall.as_nanos();
        if wall == 0 {
            return None;
        }
        let pct = cpu.saturating_mul(100).div_ceil(wall);
        Some(u64::try_from(pct).unwrap_or(u64::MAX))
    }

    // ANCHOR: stats_report
    /// The `--stats` lines (without the `macvmm: stats: ` prefix), numbers and static names
    /// only (LOG-5):
    /// ```text
    /// vcpu0 exits: vtimer 0, wfx 0, total 41: hvc 38, data abort 3
    /// vcpu0 time: exec 0.006 s, wfi 1.010 s
    /// host cpu 0.012 s over 1.031 s wall (2%)
    /// ```
    pub fn report(&self) -> Vec<String> {
        let mut out = Vec::new();
        for v in &self.vcpus {
            out.push(format!(
                "vcpu{} exits: vtimer {}, wfx {}, {}",
                v.index,
                v.exits.kind("vtimer"),
                v.exits.kind("wfx"),
                v.exits.summary()
            ));
            out.push(format!(
                "vcpu{} time: exec {}, wfi {}",
                v.index,
                ns(v.exec_ns),
                ns(v.wfi_ns)
            ));
        }
        out.push(match (self.host_cpu, self.host_cpu_percent()) {
            (Some(cpu), Some(p)) => format!(
                "host cpu {} over {} wall ({p}%)",
                secs(cpu),
                secs(self.wall)
            ),
            _ => format!("host cpu n/a over {} wall", secs(self.wall)),
        });
        out
    }
    // ANCHOR_END: stats_report
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;

    /// PLAN M8 host acceptance `stats::tests::format`.
    #[test]
    fn format() {
        let mut exits = ExitStats::new();
        exits.record(&Exit::decode(0x5a00_0000), 0x5a00_0000, true);
        exits.record(&Exit::VtimerActivated, 0, false);
        let b = BootStats {
            vcpus: vec![VcpuStats {
                index: 0,
                exits,
                exec_ns: Some(6_000_000),
                wfi_ns: None,
            }],
            wall: Duration::from_millis(1031),
            host_cpu: Some(Duration::from_micros(12_500)),
        };
        assert_eq!(
            b.report(),
            vec![
                "vcpu0 exits: vtimer 1, wfx 0, total 2: vtimer 1, hvc 1".to_owned(),
                "vcpu0 time: exec 0.006 s, wfi n/a".to_owned(),
                "host cpu 0.012 s over 1.031 s wall (2%)".to_owned(),
            ]
        );
        assert_eq!(b.host_cpu_percent(), Some(2));
        let none = BootStats::default();
        assert_eq!(none.host_cpu_percent(), None);
        assert_eq!(
            none.report(),
            vec!["host cpu n/a over 0.000 s wall".to_owned()]
        );
        let busy = BootStats {
            host_cpu: Some(Duration::from_secs(u64::MAX)),
            wall: Duration::from_nanos(1),
            ..BootStats::default()
        };
        assert!(busy.host_cpu_percent().unwrap() > 100);
    }

    #[test]
    fn counts_by_kind_and_ec() {
        let mut s = ExitStats::new();
        s.record(&Exit::decode(0x5a00_0000), 0x5a00_0000, true);
        s.record(&Exit::decode(0x5a00_0000), 0x5a00_0000, true);
        s.record(&Exit::decode(0x9381_0046), 0x9381_0046, true);
        s.record(&Exit::Canceled, 0, false);
        assert_eq!(s.total, 4);
        assert_eq!(s.kind("hvc"), 2);
        assert_eq!(s.kind("data abort"), 1);
        assert_eq!(s.kind("nope"), 0);
        assert_eq!(s.by_ec[0x16], 2);
        assert_eq!(s.by_ec[0], 0, "canceled has no EC");
        assert_eq!(s.summary(), "total 4: canceled 1, hvc 2, data abort 1");
        s.total = u64::MAX;
        s.record(&Exit::Canceled, 0, false);
        assert_eq!(s.total, u64::MAX);
    }
}
