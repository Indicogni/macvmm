//! `UnknownMmio`: the capped, read-as-zero/write-ignored logger behind every vmapple address
//! that has no device (PLAN M21; ADR-0008 decision 3; threat model POST-6, TTY-8, LOG-1).
//!
//! **Why a logger, not a stop.** On the `virt` board an access to no device is a guest bug,
//! and the default `--unhandled-mmio fatal` stops at the first one. A boot ROM written for
//! another board is different: it *will* touch devices we have not built, and the question
//! this milestone answers is "which ones, in what order?". So with `--unhandled-mmio log`
//! each such access is answered the way an empty bus would (reads return 0, writes are
//! dropped), and one line records `(pc, ipa, size, direction, value)` plus the name of the
//! layout row the address fell in. That list is the S1 deliverable: the device-access trace
//! that PLAN D4 allows, and nothing more (no disassembly, ADR-0009). The lines go to stderr at
//! `warn`, the default level, so the summary's "N logged" is what the user actually sees; the
//! cap bounds them (LOG-1). They are the user's own trace of their own Mac: ADR-0009 item 5
//! keeps them out of the repo and the course, not off the terminal.
//!
//! **ISV = 0 accesses** the M17 decoder cannot emulate (for a PC in the ROM it cannot even fetch
//! the instruction: the ROM is not `GuestMemory`) are entries too ([`Dir::Undecoded`]), with
//! the size and value unknown, so the count and the per-row totals never silently miss one.
//! The vmapple watch then stops the VM rather than inject an abort into the ROM.
//!
//! **Why a hard cap** ([`UNKNOWN_MMIO_CAP`] = 256). A ROM that polls a status register we do
//! not implement spins forever, and every spin is an access. Without a cap that is an
//! unbounded log (LOG-1) and a run that never ends. After the 256th entry the logger answers
//! [`MmioVerdict::Fatal`] with one summary line, which stops the VM (exit code 3). Later
//! accesses (from the same exit burst, before the stop lands) are counted, never logged.
//!
//! **What is in a line.** Numbers and static region names only (TTY-8): nothing the guest
//! chooses becomes text, and `log::emit` escapes the line once more anyway. The logger keeps
//! its own lines in a `Vec` bounded by the cap, so tests and the end-of-run summary can read
//! them back.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::layout;
use crate::vcpu::exit::{MmioVerdict, UnclaimedAccess};
use std::sync::Mutex;

/// The most unknown accesses one boot logs before it stops (PLAN M21).
pub const UNKNOWN_MMIO_CAP: usize = 256;

/// The direction of a logged access, and what is known about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    /// A load, answered 0.
    Read,
    /// A store of this value (masked to the size), dropped.
    Write(u64),
    /// An ISV = 0 access that was not decoded: only `ESR.WnR` is known (`true`: a store).
    Undecoded { write: bool },
}

/// One logged access.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnknownAccess {
    pub pc: u64,
    pub ipa: u64,
    /// The access size in bytes; 0 for [`Dir::Undecoded`].
    pub size: u8,
    pub dir: Dir,
    /// The vmapple layout row the address lies in, if any ("bdif", "cfg", ...).
    pub region: Option<&'static str>,
}

impl UnknownAccess {
    fn line(&self, n: usize) -> String {
        let region = self.region.unwrap_or("no layout row");
        let (pc, ipa, size) = (self.pc, self.ipa, self.size);
        match self.dir {
            Dir::Write(v) => format!(
                "vmapple: unknown MMIO #{n}: pc={pc:#x} write ipa={ipa:#x} ({region}) size={size} value={v:#x}"
            ),
            Dir::Read => format!(
                "vmapple: unknown MMIO #{n}: pc={pc:#x} read ipa={ipa:#x} ({region}) size={size} -> 0"
            ),
            Dir::Undecoded { write } => format!(
                "vmapple: unknown MMIO #{n}: pc={pc:#x} {} ipa={ipa:#x} ({region}) ISV=0, not emulated",
                if write { "write" } else { "read" }
            ),
        }
    }
}

#[derive(Debug, Default)]
struct Inner {
    entries: Vec<UnknownAccess>,
    /// Accesses after the cap: counted, not logged.
    over_cap: u64,
    /// Every line this logger produced: the entries, then at most one summary.
    lines: Vec<String>,
    summarized: bool,
}

/// The logger (module docs). Shared by every vCPU of the boot; the lock is held only to push
/// one entry.
#[derive(Debug, Default)]
pub struct UnknownMmio {
    inner: Mutex<Inner>,
}

impl UnknownMmio {
    pub fn new() -> UnknownMmio {
        UnknownMmio::default()
    }

    // ANCHOR: unknown_mmio_logger
    /// Record `a` and say what the guest sees: RAZ/WI, or (from the cap on) a stop.
    pub fn record(&self, a: &UnclaimedAccess) -> MmioVerdict {
        let dir = match a.write {
            Some(v) => Dir::Write(v),
            None => Dir::Read,
        };
        self.push(a.pc, a.ipa, a.size, dir)
    }

    /// Record an ISV = 0 access that was not emulated (module docs). The caller stops the VM
    /// either way; the verdict only says whether this entry was the one that hit the cap.
    pub fn record_undecoded(&self, pc: u64, ipa: u64, write: bool) -> MmioVerdict {
        self.push(pc, ipa, 0, Dir::Undecoded { write })
    }

    fn push(&self, pc: u64, ipa: u64, size: u8, dir: Dir) -> MmioVerdict {
        let mut g = crate::sync::lock(&self.inner);
        if g.entries.len() >= UNKNOWN_MMIO_CAP {
            g.over_cap = g.over_cap.saturating_add(1);
            return MmioVerdict::Fatal(summary_line(g.entries.len(), true));
        }
        let entry = UnknownAccess {
            pc,
            ipa,
            size,
            dir,
            region: layout::vmapple().find(ipa).map(|r| r.name),
        };
        g.entries.push(entry);
        let n = g.entries.len();
        let line = entry.line(n);
        // `warn`, the default level: the summary below counts lines the user can see.
        crate::warn!("{line}");
        g.lines.push(line);
        if n < UNKNOWN_MMIO_CAP {
            return MmioVerdict::RazWi;
        }
        let summary = summary_line(n, true);
        emit_summary(&mut g, &summary);
        MmioVerdict::Fatal(summary)
    }
    // ANCHOR_END: unknown_mmio_logger

    /// The end-of-boot summary: emitted once (unless the cap already emitted it) and returned.
    pub fn finish(&self) -> String {
        let mut g = crate::sync::lock(&self.inner);
        let summary = summary_line(g.entries.len(), g.entries.len() >= UNKNOWN_MMIO_CAP);
        if !g.summarized {
            emit_summary(&mut g, &summary);
        }
        summary
    }

    /// The logged accesses, in order.
    pub fn entries(&self) -> Vec<UnknownAccess> {
        crate::sync::lock(&self.inner).entries.clone()
    }

    /// Every line produced so far (at most [`UNKNOWN_MMIO_CAP`] + 1).
    pub fn lines(&self) -> Vec<String> {
        crate::sync::lock(&self.inner).lines.clone()
    }

    /// Accesses that arrived after the cap.
    pub fn over_cap(&self) -> u64 {
        crate::sync::lock(&self.inner).over_cap
    }

    /// How many logged accesses fell in each layout row, in order of first appearance.
    pub fn by_region(&self) -> Vec<(&'static str, usize)> {
        let g = crate::sync::lock(&self.inner);
        let mut out: Vec<(&'static str, usize)> = Vec::new();
        for e in &g.entries {
            let name = e.region.unwrap_or("no layout row");
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some((_, c)) => *c = c.saturating_add(1),
                None => out.push((name, 1)),
            }
        }
        out
    }
}

fn summary_line(n: usize, capped: bool) -> String {
    if capped {
        format!("vmapple: {n} unknown MMIO accesses logged (the cap); stopping")
    } else {
        format!("vmapple: {n} unknown MMIO accesses logged")
    }
}

fn emit_summary(g: &mut Inner, summary: &str) {
    crate::warn!("{summary}");
    g.lines.push(summary.to_owned());
    g.summarized = true;
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;

    fn access(i: u64) -> UnclaimedAccess {
        UnclaimedAccess {
            pc: layout::ROM_BASE + 4 * (i % 64),
            ipa: layout::BDIF_BASE + 8 * i,
            size: 4,
            write: (i % 2 == 1).then_some(i),
        }
    }

    #[test]
    fn undecoded_accesses_are_counted() {
        let log = UnknownMmio::new();
        assert_eq!(
            log.record_undecoded(layout::ROM_BASE + 0x10, layout::CFG_BASE + 8, true),
            MmioVerdict::RazWi
        );
        assert_eq!(
            log.lines()[0],
            "vmapple: unknown MMIO #1: pc=0x100010 write ipa=0x400008 (cfg) ISV=0, not emulated"
        );
        assert_eq!(log.entries()[0].dir, Dir::Undecoded { write: true });
        assert_eq!(log.by_region(), vec![("cfg", 1)]);
        assert_eq!(log.finish(), "vmapple: 1 unknown MMIO accesses logged");
    }

    /// PLAN M21 security test `unknown_mmio_logger_cap`: 10,000 accesses give exactly 256
    /// logged lines plus one summary, and every access from the 256th on stops the VM.
    #[test]
    fn unknown_mmio_logger_cap() {
        let log = UnknownMmio::new();
        let mut razwi = 0;
        let mut fatal = 0;
        for i in 0..10_000 {
            match log.record(&access(i)) {
                MmioVerdict::RazWi => razwi += 1,
                MmioVerdict::Fatal(why) => {
                    assert!(why.contains("256 unknown MMIO accesses logged"), "{why}");
                    fatal += 1;
                }
            }
        }
        assert_eq!(razwi, UNKNOWN_MMIO_CAP - 1);
        assert_eq!(fatal, 10_000 - (UNKNOWN_MMIO_CAP - 1));
        assert_eq!(log.entries().len(), UNKNOWN_MMIO_CAP);
        assert_eq!(log.over_cap(), 10_000 - UNKNOWN_MMIO_CAP as u64);
        let lines = log.lines();
        assert_eq!(lines.len(), UNKNOWN_MMIO_CAP + 1);
        assert_eq!(
            lines
                .iter()
                .filter(|l| l.contains("accesses logged"))
                .count(),
            1
        );
        // `finish` after the cap does not add a second summary.
        assert!(log.finish().contains("256 unknown MMIO accesses logged"));
        assert_eq!(log.lines().len(), UNKNOWN_MMIO_CAP + 1);
    }

    #[test]
    fn lines_name_the_region_and_hold_only_numbers() {
        let log = UnknownMmio::new();
        assert_eq!(log.record(&access(1)), MmioVerdict::RazWi);
        let read = UnclaimedAccess {
            pc: layout::ROM_BASE,
            ipa: layout::CFG_BASE + 0x10,
            size: 8,
            write: None,
        };
        assert_eq!(log.record(&read), MmioVerdict::RazWi);
        let hole = UnclaimedAccess {
            ipa: 0x5000_0000,
            ..read
        };
        assert_eq!(log.record(&hole), MmioVerdict::RazWi);
        let lines = log.lines();
        assert_eq!(
            lines[0],
            "vmapple: unknown MMIO #1: pc=0x100004 write ipa=0x30000008 (bdif) size=4 value=0x1"
        );
        assert_eq!(
            lines[1],
            "vmapple: unknown MMIO #2: pc=0x100000 read ipa=0x400010 (cfg) size=8 -> 0"
        );
        assert!(lines[2].contains("(no layout row)"));
        for l in &lines {
            assert!(l.chars().all(|c| c.is_ascii_graphic() || c == ' '), "{l}");
        }
        assert_eq!(
            log.by_region(),
            vec![("bdif", 1), ("cfg", 1), ("no layout row", 1)]
        );
        // Below the cap the summary is emitted by `finish`, once.
        assert_eq!(log.finish(), "vmapple: 3 unknown MMIO accesses logged");
        log.finish();
        assert_eq!(log.lines().len(), 4);
    }
}
