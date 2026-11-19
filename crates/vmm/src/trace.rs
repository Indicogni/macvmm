//! The exit trace: one [`ExitRecord`] per `hv_vcpu_run` return, kept in a per-vCPU ring of
//! the last 256 and, with `--trace exits:F`, written as JSON Lines (architecture §16; course
//! ch03 and ch07; threat model LOG-3, TTY-8).
//!
//! **Why trace exits.** A VMM is an event loop driven by exits; the trace *is* its execution
//! history. Learners diff traces against the reference (CURRICULUM §3.3), the fatal dump shows
//! the last 32 records, and `hello_trace_counts` checks one HVC record per printed byte.
//!
//! **Record format** (architecture §16, mirrored in `course/checkpoints/TRACE.md`). One JSON
//! object per line, written by hand in this field order, each field omitted when it does not
//! apply:
//!
//! | Field | JSON type | Meaning |
//! |---|---|---|
//! | `t_ns` | integer | nanoseconds since this boot's machine was built (mach ticks × timebase) |
//! | `vcpu` | integer | vCPU index |
//! | `reason` | string | `exception`, `canceled`, `vtimer` or `unknown` |
//! | `ec` | hex string | `ESR_EL2.EC` (exceptions) |
//! | `pc` | hex string | the PC as the exit reported it (after an HVC it is already past it) |
//! | `ipa` | hex string | faulting IPA (data and instruction aborts) |
//! | `wnr` | bool | data abort: a write |
//! | `size` | integer | data abort: bytes (1, 2, 4, 8) |
//! | `reg` | integer | data abort: SRT (31 = XZR) |
//! | `value` | hex string | MMIO: the masked value written, or the (sign-extended) value loaded into the register |
//! | `imm` | integer | HVC/SMC/BRK immediate |
//! | `sysreg` | string | trapped system register name, when `hvf` or `arch::sysreg` knows it |
//! | `sysreg_enc` | hex string | trapped system register: its `hv_sys_reg_t` encoding (`op0<<14 \| op1<<11 \| CRn<<7 \| CRm<<3 \| op2`), always present on EC 0x18, so an unnamed register is still identified |
//! | `fn` | string | SMCCC function name |
//! | `action` | string | `mmio`, `psci`, `smccc`, `sysreg`, `inject_undef`, `inject_abort`, `stop` |
//! | `isv` | bool | data abort: `true` when the syndrome described the access, `false` when the VMM decoded the instruction (ISV = 0, M17) |
//! | `boot` | integer | reboot generation, only when > 0 |
//!
//! 64-bit quantities are lowercase hex **strings** with `0x` and no leading zeros, because
//! JSON numbers lose precision above 2^53; small counts are integers.
//!
//! **Hostile-input rules.**
//! - **TTY-8:** every field is a number or a name from a static table; no guest byte ever
//!   reaches the trace. String fields still go through [`json_escape_into`], which escapes
//!   `"`, `\`, U+0000–U+001F, U+007F–U+009F, U+2028 and U+2029, so a future field that does
//!   carry guest data (the vmapple unknown-MMIO logger, M21) cannot break a line or put an
//!   escape sequence on a terminal that `cat`s the file.
//! - **LOG-3 (flaw F2):** a guest controls how many exits it makes (millions per second), so
//!   the file has a byte cap (`,max=SIZE`, default 1 GiB, [`DEFAULT_TRACE_MAX`]). A record
//!   that would cross the cap is replaced by one `{"action":"trace_truncated",…}` record;
//!   nothing is written after it, and one warning is logged. A write error does the same
//!   without the record. The per-vCPU ring is unaffected.
//!
//! **Filtering and dumps (M10).** A Linux boot makes tens of thousands of exits, almost all
//! of them MMIO to the PL011, so `--trace exits:F:sysreg,hvc` ([`TraceCats`]) keeps only the
//! classes being studied: that is how the EC 0x18 and SMCCC calls of a stock 6.18 boot were
//! collected for `docs/research/hvf-api.md`. The ring is always recorded, trace file or not;
//! [`dump_rings`] prints it on Ctrl-A t and SIGUSR1 while the guest keeps running, which is the
//! first tool to reach for when a kernel hangs silently (architecture §16, LOG-6).
//!
//! **Threads.** The JSONL writer is shared by every vCPU behind one mutex and buffered, so a
//! record costs a `format` into a reused `String` and a `memcpy`; the `write(2)` happens per
//! 64 KiB. The trace file is a regular file (PATH-3), never a pipe, so the write cannot block
//! indefinitely the way a stdout reader can (F20). The ring is per vCPU.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::esr::Exit;
use crate::sync::lock;
use core::fmt::Write as _;
use hvf::ExitReason;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Mutex;

/// The default `--trace` byte cap: 1 GiB (LOG-3; architecture §21.5).
pub const DEFAULT_TRACE_MAX: u64 = 1 << 30;
/// Records kept per vCPU for the fatal dump, Ctrl-A t and SIGUSR1 (architecture §16).
pub const RING_CAP: usize = 256;
/// Records the fatal dump prints (architecture §15).
pub const FATAL_LAST_EXITS: usize = 32;

/// The `reason` field: which `hv_exit_reason_t` the exit had.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TraceReason {
    #[default]
    Exception,
    Canceled,
    Vtimer,
    Unknown,
}

impl TraceReason {
    pub const fn name(self) -> &'static str {
        match self {
            TraceReason::Exception => "exception",
            TraceReason::Canceled => "canceled",
            TraceReason::Vtimer => "vtimer",
            TraceReason::Unknown => "unknown",
        }
    }

    pub const fn from_hv(r: ExitReason) -> TraceReason {
        match r {
            ExitReason::Exception => TraceReason::Exception,
            ExitReason::Canceled => TraceReason::Canceled,
            ExitReason::VtimerActivated => TraceReason::Vtimer,
            ExitReason::Unknown | ExitReason::Other(_) => TraceReason::Unknown,
        }
    }
}

/// The `action` field: what the VMM did about the exit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Mmio,
    Psci,
    Smccc,
    Sysreg,
    InjectUndef,
    InjectAbort,
    Stop,
}

impl Action {
    pub const fn name(self) -> &'static str {
        match self {
            Action::Mmio => "mmio",
            Action::Psci => "psci",
            Action::Smccc => "smccc",
            Action::Sysreg => "sysreg",
            Action::InjectUndef => "inject_undef",
            Action::InjectAbort => "inject_abort",
            Action::Stop => "stop",
        }
    }
}

// ANCHOR: trace_record
/// One exit, as the trace and the ring keep it (module docs table). Numbers and static
/// names only (TTY-8, LOG-5).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExitRecord {
    pub t_ns: u64,
    pub vcpu: u32,
    pub reason: TraceReason,
    pub ec: Option<u8>,
    pub pc: Option<u64>,
    pub ipa: Option<u64>,
    pub wnr: Option<bool>,
    pub size: Option<u8>,
    pub reg: Option<u8>,
    pub value: Option<u64>,
    pub imm: Option<u16>,
    pub sysreg: Option<&'static str>,
    /// The trapped register's `hv_sys_reg_t` encoding (EC 0x18): a number, so TTY-8 holds.
    pub sysreg_enc: Option<u16>,
    pub func: Option<&'static str>,
    pub action: Option<Action>,
    pub isv: Option<bool>,
    pub boot: Option<u64>,
}

impl ExitRecord {
    /// The fields known before the exit is handled. Handlers add `wnr`..`value`, `fn`,
    /// `sysreg`, `action`.
    pub fn new(
        t_ns: u64,
        vcpu: usize,
        generation: u64,
        raw: &hvf::VcpuExit,
        exit: &Exit,
        pc: Option<u64>,
    ) -> ExitRecord {
        let reason = TraceReason::from_hv(raw.reason);
        let exception = reason == TraceReason::Exception;
        let (imm, ipa) = match *exit {
            Exit::Hvc { imm } | Exit::Smc { imm } | Exit::Brk { imm } => (Some(imm), None),
            Exit::DataAbort(_) | Exit::InstructionAbort { .. } => (None, Some(raw.ipa)),
            _ => (None, None),
        };
        ExitRecord {
            t_ns,
            vcpu: u32::try_from(vcpu).unwrap_or(u32::MAX),
            reason,
            ec: exception.then_some(crate::arch::esr::esr_ec(raw.esr)),
            pc,
            ipa,
            imm,
            boot: (generation > 0).then_some(generation),
            ..ExitRecord::default()
        }
    }
}
// ANCHOR_END: trace_record

impl ExitRecord {
    /// Append this record as one JSON line (with the trailing `\n`) to `out`.
    pub fn write_json(&self, out: &mut String) {
        let mut j = Obj::new(out);
        j.int("t_ns", self.t_ns);
        j.int("vcpu", u64::from(self.vcpu));
        j.str("reason", self.reason.name());
        j.opt_hex("ec", self.ec.map(u64::from));
        j.opt_hex("pc", self.pc);
        j.opt_hex("ipa", self.ipa);
        j.opt_bool("wnr", self.wnr);
        j.opt_int("size", self.size.map(u64::from));
        j.opt_int("reg", self.reg.map(u64::from));
        j.opt_hex("value", self.value);
        j.opt_int("imm", self.imm.map(u64::from));
        j.opt_str("sysreg", self.sysreg);
        j.opt_hex("sysreg_enc", self.sysreg_enc.map(u64::from));
        j.opt_str("fn", self.func);
        j.opt_str("action", self.action.map(Action::name));
        j.opt_bool("isv", self.isv);
        j.opt_int("boot", self.boot);
        j.end();
    }

    /// This record as a JSON line without the newline (for the fatal dump).
    pub fn to_json(&self) -> String {
        let mut s = String::with_capacity(160);
        self.write_json(&mut s);
        s.pop();
        s
    }
}

/// A minimal JSON object writer: `{"k":v,...}` in call order.
struct Obj<'a> {
    out: &'a mut String,
    first: bool,
}

impl<'a> Obj<'a> {
    fn new(out: &'a mut String) -> Obj<'a> {
        out.push('{');
        Obj { out, first: true }
    }
    fn key(&mut self, k: &str) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        json_escape_into(self.out, k);
        self.out.push(':');
    }
    fn int(&mut self, k: &str, v: u64) {
        self.key(k);
        let _ = write!(self.out, "{v}");
    }
    fn hex(&mut self, k: &str, v: u64) {
        self.key(k);
        let _ = write!(self.out, "\"{v:#x}\"");
    }
    fn str(&mut self, k: &str, v: &str) {
        self.key(k);
        json_escape_into(self.out, v);
    }
    fn opt_int(&mut self, k: &str, v: Option<u64>) {
        if let Some(v) = v {
            self.int(k, v);
        }
    }
    fn opt_hex(&mut self, k: &str, v: Option<u64>) {
        if let Some(v) = v {
            self.hex(k, v);
        }
    }
    fn opt_bool(&mut self, k: &str, v: Option<bool>) {
        if let Some(v) = v {
            self.key(k);
            self.out.push_str(if v { "true" } else { "false" });
        }
    }
    fn opt_str(&mut self, k: &str, v: Option<&str>) {
        if let Some(v) = v {
            self.str(k, v);
        }
    }
    fn end(self) {
        self.out.push_str("}\n");
    }
}

// ANCHOR: trace_json_escape
/// Append `s` as a JSON string literal (with the quotes) to `out` (TTY-8). Escapes `"` and
/// `\`, every C0 control and DEL..U+009F (C1, which some terminals treat as CSI/OSC
/// introducers), and U+2028/U+2029 (line separators to JavaScript and some viewers), all as
/// `\uXXXX`. Everything else is copied: the result is valid JSON (RFC 8259 §7) and contains
/// no byte a terminal would interpret.
pub fn json_escape_into(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
// ANCHOR_END: trace_json_escape

/// `--trace` categories (architecture §13.1: `cats ⊆ mmio,hvc,sysreg,psci,cancel,all`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TraceCats(u8);

impl TraceCats {
    /// Data aborts (EC 0x24).
    pub const MMIO: TraceCats = TraceCats(1 << 0);
    /// HVC exits (EC 0x16), whatever the call.
    pub const HVC: TraceCats = TraceCats(1 << 1);
    /// Trapped system registers (EC 0x18).
    pub const SYSREG: TraceCats = TraceCats(1 << 2);
    /// PSCI calls over either conduit (`action` = `psci`).
    pub const PSCI: TraceCats = TraceCats(1 << 3);
    /// `CANCELED` exits (kicks).
    pub const CANCEL: TraceCats = TraceCats(1 << 4);
    /// Every exit, including the ones no other category names.
    pub const ALL: TraceCats = TraceCats(0xff);
    pub const NONE: TraceCats = TraceCats(0);

    /// Parse a comma-separated list of category names; `None` if any name is unknown or the
    /// list is empty.
    pub fn parse(s: &str) -> Option<TraceCats> {
        let mut c = TraceCats::NONE;
        for name in s.split(',') {
            c = c.union(match name {
                "mmio" => TraceCats::MMIO,
                "hvc" => TraceCats::HVC,
                "sysreg" => TraceCats::SYSREG,
                "psci" => TraceCats::PSCI,
                "cancel" => TraceCats::CANCEL,
                "all" => TraceCats::ALL,
                _ => return None,
            });
        }
        (c != TraceCats::NONE).then_some(c)
    }

    pub const fn union(self, o: TraceCats) -> TraceCats {
        TraceCats(self.0 | o.0)
    }

    const fn has(self, o: TraceCats) -> bool {
        self.0 & o.0 == o.0
    }

    /// Whether `rec` belongs to one of these categories.
    pub fn selects(self, rec: &ExitRecord) -> bool {
        use crate::arch::esr::ec;
        self.has(TraceCats::ALL)
            || (self.has(TraceCats::MMIO) && rec.ec == Some(ec::DABT_LOWER))
            || (self.has(TraceCats::HVC) && rec.ec == Some(ec::HVC64))
            || (self.has(TraceCats::SYSREG) && rec.ec == Some(ec::SYSREG))
            || (self.has(TraceCats::PSCI) && rec.action == Some(Action::Psci))
            || (self.has(TraceCats::CANCEL) && rec.reason == TraceReason::Canceled)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriterState {
    Writing,
    Truncated,
    Failed,
}

/// The JSONL file writer with its byte cap (module docs, LOG-3). Shared by the vCPUs through
/// [`Trace`].
pub struct TraceWriter {
    out: Box<dyn Write + Send>,
    cats: TraceCats,
    max: u64,
    written: u64,
    state: WriterState,
    line: String,
}

impl core::fmt::Debug for TraceWriter {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("TraceWriter")
            .field("cats", &self.cats)
            .field("max", &self.max)
            .field("written", &self.written)
            .field("state", &self.state)
            .finish_non_exhaustive()
    }
}

impl TraceWriter {
    /// A writer to `out` (already buffered by the caller) of the records `cats` selects, at
    /// most `max` bytes of records plus the one truncation record.
    pub fn new(out: Box<dyn Write + Send>, cats: TraceCats, max: u64) -> TraceWriter {
        TraceWriter {
            out,
            cats,
            max,
            written: 0,
            state: WriterState::Writing,
            line: String::with_capacity(256),
        }
    }

    /// Write `rec` if it is selected and fits under the cap (module docs).
    pub fn record(&mut self, rec: &ExitRecord) {
        if self.state != WriterState::Writing || !self.cats.selects(rec) {
            return;
        }
        self.line.clear();
        rec.write_json(&mut self.line);
        let len = u64::try_from(self.line.len()).unwrap_or(u64::MAX);
        let fits = self
            .written
            .checked_add(len)
            .is_some_and(|end| end <= self.max);
        if !fits {
            self.line.clear();
            let mut j = Obj::new(&mut self.line);
            j.int("t_ns", rec.t_ns);
            j.str("action", "trace_truncated");
            j.int("max", self.max);
            j.int("written", self.written);
            j.end();
            self.state = WriterState::Truncated;
            crate::warn!(
                "--trace: the byte cap of {} bytes is reached; no further records are written \
                 (raise it with ,max=SIZE)",
                self.max
            );
        }
        match self.out.write_all(self.line.as_bytes()) {
            Ok(()) if fits => self.written = self.written.saturating_add(len),
            Ok(()) => {}
            Err(e) => {
                self.state = WriterState::Failed;
                crate::warn!("--trace: write failed ({e}); no further records are written");
            }
        }
    }

    /// Push buffered records to the file (at stop).
    pub fn flush(&mut self) {
        if let Err(e) = self.out.flush()
            && self.state == WriterState::Writing
        {
            self.state = WriterState::Failed;
            crate::warn!("--trace: flush failed ({e})");
        }
    }

    /// Record bytes written (the truncation record not included).
    pub fn written(&self) -> u64 {
        self.written
    }

    /// True once the cap was reached.
    pub fn is_truncated(&self) -> bool {
        self.state == WriterState::Truncated
    }
}

impl Drop for TraceWriter {
    fn drop(&mut self) {
        let _ = self.out.flush();
    }
}

/// The shared JSONL trace of one VM (persists across reboots in `HostIo`, so the cap spans
/// them).
#[derive(Debug)]
pub struct Trace {
    writer: Mutex<TraceWriter>,
}

impl Trace {
    pub fn new(writer: TraceWriter) -> Trace {
        Trace {
            writer: Mutex::new(writer),
        }
    }

    /// Write `rec` if selected (module docs).
    pub fn record(&self, rec: &ExitRecord) {
        lock(&self.writer).record(rec);
    }

    pub fn flush(&self) {
        lock(&self.writer).flush();
    }

    /// Record bytes written so far.
    pub fn written(&self) -> u64 {
        lock(&self.writer).written()
    }
}

/// One vCPU's last [`RING_CAP`] exits (architecture §16). A `Mutex` so that Ctrl-A t and
/// SIGUSR1 (M6) can read it from another thread; in practice only its vCPU locks it.
#[derive(Debug, Default)]
pub struct ExitRing {
    inner: Mutex<VecDeque<ExitRecord>>,
}

impl ExitRing {
    pub fn new() -> ExitRing {
        ExitRing {
            inner: Mutex::new(VecDeque::with_capacity(RING_CAP)),
        }
    }

    /// Keep `rec`, dropping the oldest record when full.
    pub fn push(&self, rec: ExitRecord) {
        let mut q = lock(&self.inner);
        if q.len() >= RING_CAP {
            q.pop_front();
        }
        q.push_back(rec);
    }

    /// The last `n` records, oldest first.
    pub fn last(&self, n: usize) -> Vec<ExitRecord> {
        let q = lock(&self.inner);
        let skip = q.len().saturating_sub(n);
        q.iter().skip(skip).cloned().collect()
    }

    pub fn len(&self) -> usize {
        lock(&self.inner).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ANCHOR: trace_ring_dump
/// The text of a ring dump (Ctrl-A t, SIGUSR1; architecture §16, threat model LOG-6): one
/// header per vCPU, then that vCPU's last [`RING_CAP`] records as JSON, oldest first.
///
/// **Why it is safe to print on the user's terminal while the guest runs.** Each record holds
/// numbers and names from static tables only (TTY-8, LOG-5), so no guest byte can reach the
/// terminal this way. Each ring is locked only for the copy in [`ExitRing::last`], so the
/// vCPU that owns it is held up for at most 256 clones, never for the formatting or the write.
/// The caller (`HostCtl::dump_rings`) passes the rings of the vCPUs running right now; an
/// empty list says so instead of printing nothing.
pub fn dump_rings(rings: &[(usize, std::sync::Arc<ExitRing>)]) -> String {
    let mut out = String::new();
    if rings.is_empty() {
        out.push_str("no vCPU is running\n");
    }
    for (index, ring) in rings {
        let recs = ring.last(RING_CAP);
        let _ = writeln!(out, "vcpu{index}: last {} exits, oldest first:", recs.len());
        for r in recs {
            out.push_str("  ");
            r.write_json(&mut out); // ends the line itself
        }
    }
    out
}
// ANCHOR_END: trace_ring_dump

/// Nanoseconds since a boot's start, from `mach_absolute_time` and the timebase.
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    start: u64,
    timebase: Option<hvf::host::Timebase>,
}

impl Clock {
    /// A clock whose zero is the tick count `start`.
    pub fn new(start: u64) -> Clock {
        Clock {
            start,
            timebase: hvf::host::timebase(),
        }
    }

    /// Nanoseconds since the start (0 if the timebase is unknown).
    pub fn now_ns(&self) -> u64 {
        let ticks = hvf::host::mach_absolute_time().saturating_sub(self.start);
        self.timebase.map_or(0, |tb| tb.ticks_to_nanos(ticks))
    }
}

#[cfg(test)]
#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)] // tests: a panic fails it
mod tests {
    use super::*;
    use std::sync::Arc;

    fn raw(reason: ExitReason, esr: u64, ipa: u64) -> hvf::VcpuExit {
        hvf::VcpuExit {
            reason,
            esr,
            far: ipa,
            ipa,
        }
    }

    /// PLAN M4 `trace::tests::jsonl_golden`: exact strings for an MMIO record, an HVC record
    /// and a CANCELED record.
    #[test]
    fn jsonl_golden() {
        let esr = 0x9382_0046; // str w2, [x1]
        let r = raw(ExitReason::Exception, esr, 0x0900_0000);
        let exit = Exit::from_hv(r.reason, r.esr);
        let mut mmio = ExitRecord::new(1234, 0, 0, &r, &exit, Some(0x4008_0010));
        mmio.wnr = Some(true);
        mmio.size = Some(4);
        mmio.reg = Some(2);
        mmio.value = Some(0x48);
        mmio.action = Some(Action::Mmio);
        assert_eq!(
            mmio.to_json(),
            r#"{"t_ns":1234,"vcpu":0,"reason":"exception","ec":"0x24","pc":"0x40080010","ipa":"0x9000000","wnr":true,"size":4,"reg":2,"value":"0x48","action":"mmio"}"#
        );

        let r = raw(ExitReason::Exception, 0x5a00_0000, 0);
        let exit = Exit::from_hv(r.reason, r.esr);
        let mut hvc = ExitRecord::new(99, 1, 2, &r, &exit, Some(0x4008_0104));
        hvc.func = Some("DEBUG_PUTC");
        hvc.action = Some(Action::Smccc);
        let mut line = String::new();
        hvc.write_json(&mut line);
        assert_eq!(
            line,
            "{\"t_ns\":99,\"vcpu\":1,\"reason\":\"exception\",\"ec\":\"0x16\",\"pc\":\"0x40080104\",\
             \"imm\":0,\"fn\":\"DEBUG_PUTC\",\"action\":\"smccc\",\"boot\":2}\n"
        );

        let r = raw(ExitReason::Canceled, 0, 0);
        let exit = Exit::from_hv(r.reason, r.esr);
        let cancel = ExitRecord::new(0, 0, 0, &r, &exit, Some(0x4008_0000));
        assert_eq!(
            cancel.to_json(),
            r#"{"t_ns":0,"vcpu":0,"reason":"canceled","pc":"0x40080000"}"#
        );

        let r = raw(ExitReason::Exception, 0x9200_0046, 0x0b00_0008);
        let exit = Exit::from_hv(r.reason, r.esr);
        let mut isv0 = ExitRecord::new(7, 0, 0, &r, &exit, Some(0x4008_0200));
        isv0.isv = Some(false);
        isv0.action = Some(Action::Stop);
        assert_eq!(
            isv0.to_json(),
            r#"{"t_ns":7,"vcpu":0,"reason":"exception","ec":"0x24","pc":"0x40080200","ipa":"0xb000008","action":"stop","isv":false}"#
        );
    }

    /// PLAN M4 security test `trace_json_escape_golden` (TTY-8).
    #[test]
    fn trace_json_escape_golden() {
        let mut out = String::new();
        json_escape_into(
            &mut out,
            "a\u{1b}[2J\"q\\b\u{0}n\u{9b}c\u{2028}l\u{2029}\u{7f}é",
        );
        assert_eq!(
            out,
            "\"a\\u001b[2J\\\"q\\\\b\\u0000n\\u009bc\\u2028l\\u2029\\u007f\u{e9}\""
        );
        assert!(!out.chars().any(|c| c.is_control()));
        // A string field in a record goes through the escaper too.
        let rec = ExitRecord {
            sysreg: Some("X\u{7}\n"),
            sysreg_enc: Some(0xc527),
            ..ExitRecord::default()
        };
        assert_eq!(
            rec.to_json(),
            r#"{"t_ns":0,"vcpu":0,"reason":"exception","sysreg":"X\u0007\u000a","sysreg_enc":"0xc527"}"#
        );
    }

    #[test]
    fn categories() {
        assert_eq!(TraceCats::parse("mmio"), Some(TraceCats::MMIO));
        assert_eq!(
            TraceCats::parse("mmio,hvc"),
            Some(TraceCats::MMIO.union(TraceCats::HVC))
        );
        assert_eq!(TraceCats::parse("all"), Some(TraceCats::ALL));
        for bad in ["", "mmio,", "MMIO", "net", "mmio,,hvc"] {
            assert_eq!(TraceCats::parse(bad), None, "{bad:?}");
        }
        let dabt = ExitRecord {
            ec: Some(0x24),
            ..ExitRecord::default()
        };
        let hvc_psci = ExitRecord {
            ec: Some(0x16),
            action: Some(Action::Psci),
            ..ExitRecord::default()
        };
        let cancel = ExitRecord {
            reason: TraceReason::Canceled,
            ..ExitRecord::default()
        };
        let iabt = ExitRecord {
            ec: Some(0x20),
            ..ExitRecord::default()
        };
        let m = TraceCats::MMIO;
        assert!(m.selects(&dabt) && !m.selects(&hvc_psci) && !m.selects(&cancel));
        assert!(TraceCats::HVC.selects(&hvc_psci));
        assert!(TraceCats::PSCI.selects(&hvc_psci) && !TraceCats::PSCI.selects(&dabt));
        assert!(TraceCats::CANCEL.selects(&cancel));
        assert!(!TraceCats::SYSREG.selects(&iabt) && TraceCats::ALL.selects(&iabt));
    }

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn cap_writes_one_truncation_record() {
        let out = Shared::default();
        let mut w = TraceWriter::new(Box::new(out.clone()), TraceCats::ALL, 200);
        let rec = ExitRecord {
            pc: Some(0x4008_0000),
            ..ExitRecord::default()
        };
        crate::log::test_capture::start();
        for _ in 0..100 {
            w.record(&rec);
        }
        let warnings = crate::log::test_capture::finish();
        let text = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let last = lines.last().unwrap();
        assert!(last.contains("\"action\":\"trace_truncated\""), "{text}");
        assert!(last.contains("\"max\":200"), "{last}");
        let body: usize = lines[..lines.len() - 1].iter().map(|l| l.len() + 1).sum();
        assert!(body <= 200 && body as u64 == w.written(), "{body}");
        assert!(w.is_truncated());
        assert_eq!(warnings.len(), 1, "{warnings:?}");
    }

    #[test]
    fn write_error_stops_quietly() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut w = TraceWriter::new(Box::new(Broken), TraceCats::ALL, 1 << 20);
        crate::log::test_capture::start();
        for _ in 0..10 {
            w.record(&ExitRecord::default());
        }
        assert_eq!(crate::log::test_capture::finish().len(), 1);
        assert_eq!(w.written(), 0);
    }

    #[test]
    fn ring_dump_format() {
        assert_eq!(dump_rings(&[]), "no vCPU is running\n");
        let ring = Arc::new(ExitRing::new());
        for i in 0..300u64 {
            ring.push(ExitRecord {
                t_ns: i,
                ec: Some(0x18),
                sysreg: Some("OSLAR_EL1"),
                action: Some(Action::Sysreg),
                ..ExitRecord::default()
            });
        }
        let d = dump_rings(&[(0, Arc::clone(&ring)), (1, Arc::new(ExitRing::new()))]);
        let lines: Vec<&str> = d.lines().collect();
        assert_eq!(lines[0], "vcpu0: last 256 exits, oldest first:");
        assert!(lines[1].starts_with("  {\"t_ns\":44,"), "{}", lines[1]);
        assert!(lines[256].starts_with("  {\"t_ns\":299,"), "{}", lines[256]);
        assert_eq!(lines[257], "vcpu1: last 0 exits, oldest first:");
        assert_eq!(lines.len(), 258);
        // Numbers and static names only (TTY-8): nothing below 0x20 but the newlines.
        assert!(!d.bytes().any(|b| b < 0x20 && b != b'\n'));
    }

    #[test]
    fn ring_keeps_the_last_256() {
        let ring = ExitRing::new();
        assert!(ring.is_empty());
        for i in 0..300u64 {
            ring.push(ExitRecord {
                t_ns: i,
                ..ExitRecord::default()
            });
        }
        assert_eq!(ring.len(), RING_CAP);
        let last = ring.last(FATAL_LAST_EXITS);
        assert_eq!(last.len(), 32);
        assert_eq!((last[0].t_ns, last[31].t_ns), (268, 299));
        assert_eq!(ring.last(1000).len(), RING_CAP);
        let c = Clock::new(hvf::host::mach_absolute_time());
        let a = c.now_ns();
        assert!(c.now_ns() >= a);
    }
}
