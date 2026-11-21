// timer-timeline: the model. Pure logic, no DOM (course/site/LABS.md section 3).
//
// One round of chapter 11's test guest (`guests/timer-nogic`) in the `--irqchip none` teaching
// mode, on one host-time axis: the guest arms its alarm and runs WFI, the VMM sleeps until the
// alarm's host deadline, the VTIMER exit raises "our line", the before-entry rule turns it into
// a pending IRQ, the guest's handler silences the timer, and a third exit lets the VMM drop the
// line and unmask the vtimer.
//
// The sequence is not scripted by hand: `buildRound` runs the round through ports of the
// reference's rules in `crates/vmm/src/timer.rs` (`timer_asserted`, `nogic_wfi_wait`,
// `NoGicTimer::before_entry`), and the tests check the result against the chapter's fallback
// text, the reference's trace (`captures/11-trace-ticks.txt`), its `--stats` line
// (`captures/11-timer-nogic.txt`) and the two first-read captures (`11-first-cntvct.txt`,
// `11-offset-zero.txt`). Registers are u64, so all register arithmetic uses BigInt.

const U64_MAX = (1n << 64n) - 1n;
const MASK64 = U64_MAX;

/** CNTFRQ_EL0 as Hypervisor.framework presents it (captures/11-timer-nogic.txt). */
export const FREQ = 24_000_000n;
/** The guest's 100 ms alarm: CNTFRQ / 10 ticks. */
export const ALARM_TICKS = FREQ / 10n;
/** Apple silicon's host timebase, `mach_timebase_info` = 125/3 ns per tick. */
export const TIMEBASE = Object.freeze({ numer: 125n, denom: 3n });

/** `CNTV_CTL_EL0` bits (ARM ARM D19.11.15), as in `timer.rs`'s `cntv_ctl`. */
export const CNTV_CTL = Object.freeze({ ENABLE: 1n, IMASK: 2n, ISTATUS: 4n });

/** `NOGIC_WFI_SLICE`: the longest single WFI sleep, 100 ms. */
export const WFI_SLICE_NS = 100_000_000n;
/** `NOGIC_LINE_RECHECK`: the line kicker's delay, 1 ms. */
export const LINE_RECHECK_NS = 1_000_000n;

/** The guest's `wfi` and the instruction after it (captures/11-trace-ticks.txt). */
export const PC_WFI = 0x40081188n;
export const PC_AFTER_WFI = 0x4008118cn;

/**
 * The guest's first CNTVCT read, from the two captures: 133,166 ticks with the reference's
 * offset (the host count when the machine was built), 3,583,539,855,220 with the offset forced
 * to 0 (the Mac's own count). The lab uses one illustrative host count for both: the machine is
 * built at host tick HOST_AT_BUILD, and the guest's first read comes 133,166 ticks later.
 */
export const FIRST_READ_TICKS = 133_166n;
export const FIRST_READ_OFFSET_ZERO = 3_583_539_855_220n;
export const HOST_AT_BUILD = FIRST_READ_OFFSET_ZERO - FIRST_READ_TICKS;

/**
 * The second round of the reference's trace (captures/11-trace-ticks.txt), in nanoseconds
 * since the machine was built: its WFI exit, VTIMER exit, the kick's CANCELED exit, and the
 * next round's WFI exit.
 */
export const TRACE = Object.freeze({
  wfi: { t_ns: 107_512_291n, reason: "exception", ec: "0x1", pc: PC_WFI },
  vtimer: { t_ns: 212_565_000n, reason: "vtimer", pc: PC_AFTER_WFI },
  canceled: { t_ns: 213_832_875n, reason: "canceled", pc: PC_AFTER_WFI },
  nextWfi: { t_ns: 214_044_250n, reason: "exception", ec: "0x1", pc: PC_WFI },
});

/** The lesson's fallback, one line per step 1..9 (the model test checks it against the lesson). */
export const STEP_LINES = Object.freeze([
  "guest   arms CVAL = now + 2,400,000 ticks, ENABLE = 1; unmasks IRQs; runs WFI",
  "exit 1  WFI (class 0x01), PC at the wfi      -> VMM sleeps until CVAL + offset",
  "        ... about 100 ms of nothing, on both sides ...",
  "VMM     wakes, PC + 4, enters the guest",
  "exit 2  VTIMER_ACTIVATED, PC unchanged       -> VMM raises our line (vtimer stays masked)",
  "VMM     before entry: timer still asserts    -> pending IRQ for this run",
  "guest   takes the IRQ at VBAR_EL1 + 0x280, handler clears ENABLE, returns",
  "exit 3  (sitting B explains this one)        -> before entry: timer quiet: drop line, unmask",
  "guest   prints the interval, arms the next round",
]);

export const LAST_STEP = STEP_LINES.length; // steps 0..9; 0 is "before the round"

/** Where the lab says which sitting explains exit 3 (the lab is also published on its own). */
const SITTING_B = "chapter 11, sitting B";

/**
 * The trace does not record the guest arming its alarm. The lab puts the arm a few instructions
 * before the WFI exit: 48 ticks, 2 µs. (Putting it exactly at the exit would make the WFI sleep
 * exactly one slice, and hide that the deadline, not the slice, decided.)
 */
export const ARM_LEAD_TICKS = 48n;

/** Step `n`'s line from the fallback (whitespace collapsed), with exit 3 explained if revealed. */
export function stepLine(n, reveal) {
  if (n === 0) return "Before the round: the guest is running, its timer off.";
  const line = STEP_LINES[n - 1].replace(/\s+/g, " ").trim().replace(/^\.+\s*|\s*\.+$/g, "");
  if (n !== 8) return line;
  return reveal
    ? line.replace("(sitting B explains this one)", "CANCELED, the 1 ms kick")
    : line.replace("(sitting B explains this one)", `(${SITTING_B}, explains this one)`);
}

// --- ports of crates/vmm/src/timer.rs ----------------------------------------------------------

const u64 = (x) => BigInt.asUintN(64, x);

/** `timer_asserted`: enabled, not masked, condition met. */
export function timerAsserted(ctl) {
  return (ctl & CNTV_CTL.ENABLE) !== 0n && (ctl & CNTV_CTL.IMASK) === 0n && (ctl & CNTV_CTL.ISTATUS) !== 0n;
}

/** `guest_counter`: CNTVCT = host - offset, modulo 2^64. */
export function guestCounter(host, offset) {
  return u64(host - offset);
}

/** `Timebase::ticks_to_nanos` (u128 product, saturating to u64; denom 0 gives 0). */
export function ticksToNanos(ticks, tb = TIMEBASE) {
  if (tb.denom === 0n) return 0n;
  const n = (ticks * tb.numer) / tb.denom;
  return n > U64_MAX ? U64_MAX : n;
}

/**
 * `nogic_wfi_wait`. Returns `{ kind: "wake" }` or `{ kind: "sleep", ns }`, plus `rule`, the
 * branch that decided (for the readout), and `deadline`/`left` when they were computed.
 */
export function wfiWait(ctl, cval, offset, now, tb = TIMEBASE) {
  if ((ctl & CNTV_CTL.ENABLE) === 0n || (ctl & CNTV_CTL.IMASK) !== 0n) {
    return { kind: "sleep", ns: WFI_SLICE_NS, rule: "off" };
  }
  if ((ctl & CNTV_CTL.ISTATUS) !== 0n) return { kind: "wake", rule: "met" };
  const deadline = cval + offset;
  if (deadline > U64_MAX) return { kind: "sleep", ns: WFI_SLICE_NS, rule: "overflow" };
  const left = deadline - now;
  if (left <= 0n) return { kind: "wake", rule: "past", deadline };
  if (!tb) return { kind: "sleep", ns: WFI_SLICE_NS, rule: "no-timebase", deadline, left };
  const ns = ticksToNanos(left, tb);
  return ns > WFI_SLICE_NS
    ? { kind: "sleep", ns: WFI_SLICE_NS, rule: "slice", deadline, left }
    : { kind: "sleep", ns, rule: "deadline", deadline, left };
}

/** `NoGicTimer::new` as a plain object. */
export function newLine() {
  return { line: false };
}

/** `NoGicTimer::vtimer_activated`. */
export function vtimerActivated(t) {
  return { ...t, line: true };
}

/** `NoGicTimer::before_entry`: returns the new line state and the `EntryAction`. */
export function beforeEntry(t, masked, ctl) {
  let line = t.line;
  let unmask = false;
  if (masked && !timerAsserted(ctl)) {
    line = false;
    unmask = true;
  }
  return { timer: { line }, action: { unmask, assertIrq: line } };
}

/** `NoGicTimer::irq_pending`. */
export function irqPending(t, ctl) {
  return t.line && timerAsserted(ctl);
}

/** The guest's `ticks_to_ms` (guests/common/timer.rs): saturating, truncating. */
export function ticksToMs(ticks, freq = FREQ) {
  if (freq === 0n) return 0n;
  let p = ticks * 1000n;
  if (p > U64_MAX) p = U64_MAX;
  return p / freq;
}

// --- the round ---------------------------------------------------------------------------------

/** Nanoseconds since the machine was built to host ticks since then (inverse of the timebase). */
export function nsToTicks(ns) {
  return (ns * TIMEBASE.denom) / TIMEBASE.numer;
}

function offsetFor(mode) {
  return mode === "zero" ? 0n : HOST_AT_BUILD;
}

/** The guest's first CNTVCT read under an offset mode (matches the two captures). */
export function firstRead(mode) {
  return guestCounter(HOST_AT_BUILD + FIRST_READ_TICKS, offsetFor(mode));
}

/** The CTL value the hardware shows: ISTATUS is the condition, meaningful only while enabled. */
function liveCtl(ctlBits, cval, cntvct) {
  const base = ctlBits & (CNTV_CTL.ENABLE | CNTV_CTL.IMASK);
  if ((base & CNTV_CTL.ENABLE) !== 0n && cval !== null && cntvct >= cval) return base | CNTV_CTL.ISTATUS;
  return base;
}

/**
 * Run one round. `opts.offset` is "ref" (offset = host count at build) or "zero";
 * `opts.timing` is "trace" (the reference's measured times) or "ideal" (the host wakes us
 * exactly at the deadline; exits take no time; the kick still takes its 1 ms).
 * Returns 10 snapshots, steps 0..9, each the state *after* that step.
 */
export function buildRound(opts = {}) {
  const mode = opts.offset === "zero" ? "zero" : "ref";
  const timing = opts.timing === "ideal" ? "ideal" : "trace";
  const offset = offsetFor(mode);

  // Times in host ticks since the machine was built.
  // The trace does not record the arm: put it ARM_LEAD_TICKS before the WFI exit. Step 9 (the
  // next round's arm) is placed the same way before the next WFI exit.
  const tWfi = nsToTicks(TRACE.wfi.t_ns);
  const tArm = tWfi - ARM_LEAD_TICKS;
  const tDeadline = tArm + ALARM_TICKS;
  const T = timing === "trace"
    ? { arm: tArm, wfi: tWfi, deadline: tDeadline, wake: nsToTicks(TRACE.vtimer.t_ns),
        vtimer: nsToTicks(TRACE.vtimer.t_ns), kick: nsToTicks(TRACE.canceled.t_ns),
        next: nsToTicks(TRACE.nextWfi.t_ns) }
    : { arm: tArm, wfi: tWfi, deadline: tDeadline, wake: tDeadline, vtimer: tDeadline,
        kick: tDeadline + nsToTicks(LINE_RECHECK_NS),
        next: tDeadline + nsToTicks(LINE_RECHECK_NS) + ARM_LEAD_TICKS };
  const traced = timing === "trace";

  const host = (t) => HOST_AT_BUILD + t;
  const cnt = (t) => guestCounter(host(t), offset);

  // Mutable simulation state, copied into each snapshot.
  let ctlBits = 0n; // ENABLE | IMASK as the guest wrote them
  let cval = null; // last round's value is irrelevant while ENABLE = 0
  let pstateI = true; // the guest unmasks only around its WFI
  let vmask = false; // the framework's vtimer mask
  let timer = newLine();
  let pending = false; // the per-run pending IRQ
  let pc = null;
  let start = null; // the guest's `start` (CNTVCT at arming)
  let fired = null; // FIRED_AT
  let interval = null;
  const exits = { wfx: 0, vtimer: 0, canceled: 0 };
  const snaps = [];

  function snap(step, t, extra) {
    const c = cnt(t);
    const ctl = liveCtl(ctlBits, cval, c);
    snaps.push({
      step, t, tNs: ticksToNanos(t), traced: Boolean(extra.traced), host: host(t), offset, cntvct: c,
      cval, ctl, enable: (ctl & CNTV_CTL.ENABLE) !== 0n, istatus: (ctl & CNTV_CTL.ISTATUS) !== 0n,
      imask: (ctl & CNTV_CTL.IMASK) !== 0n,
      output: timerAsserted(ctl), pstateI, vmask, line: timer.line, pending, pc,
      exits: { ...exits }, start, fired, interval,
      guest: extra.guest, vmm: extra.vmm, exit: extra.exit || null, rule: extra.rule || null,
      deadlineHost: cval === null ? null : u64(cval + offset),
    });
  }

  // 0: before the round. The guest is running its loop with IRQs masked.
  pc = null;
  snap(0, T.arm, { guest: "running", vmm: "guest running" });

  // 1: arm, unmask, WFI.
  start = cnt(T.arm);
  cval = u64(start + ALARM_TICKS);
  ctlBits = CNTV_CTL.ENABLE;
  pstateI = false;
  pc = PC_WFI;
  snap(1, T.arm, { guest: "runs wfi", vmm: "guest running" });

  // 2: exit 1, WFI. No IRQ is pending, so the VMM asks the WFI sleep rule how long to sleep.
  exits.wfx += 1;
  {
    const ctl = liveCtl(ctlBits, cval, cnt(T.wfi));
    const pend = irqPending(timer, ctl);
    const w = wfiWait(ctl, cval, offset, host(T.wfi));
    snap(2, T.wfi, {
      traced, guest: "stopped at the wfi", vmm: pend ? "IRQ pending: resume" : "sleeping",
      exit: { n: 1, reason: "WFI", ec: "0x01", pc: PC_WFI },
      rule: { name: "nogic_wfi_wait", ctl, cval, offset, now: host(T.wfi), result: w, irqPending: pend },
    });
  }

  // 3: the deadline passes while our thread sleeps. ISTATUS rises; nothing exits.
  snap(3, T.deadline, { guest: "stopped at the wfi", vmm: "sleeping" });

  // 4: the VMM wakes, re-asks the rule (now it says wake), PC + 4, before entry, enter.
  {
    const ctl = liveCtl(ctlBits, cval, cnt(T.wake));
    const w = wfiWait(ctl, cval, offset, host(T.wake));
    pc = PC_AFTER_WFI;
    const be = beforeEntry(timer, vmask, ctl);
    timer = be.timer;
    if (be.action.unmask) vmask = false;
    pending = be.action.assertIrq;
    snap(4, T.wake, {
      guest: "running", vmm: "enters the guest",
      rule: { name: "nogic_wfi_wait", ctl, cval, offset, now: host(T.wake), result: w, entry: be.action },
    });
  }

  // 5: exit 2, VTIMER_ACTIVATED. The framework masks the vtimer; we raise our line.
  exits.vtimer += 1;
  pending = false; // the per-run pending IRQ is cleared when hv_vcpu_run returns
  vmask = true;
  timer = vtimerActivated(timer);
  snap(5, T.vtimer, {
    traced, guest: "stopped", vmm: "raises our line",
    exit: { n: 2, reason: "VTIMER_ACTIVATED", pc: PC_AFTER_WFI },
  });

  // 6: before entry: masked and still asserting, so keep the line and set the pending IRQ.
  {
    const ctl = liveCtl(ctlBits, cval, cnt(T.vtimer));
    const be = beforeEntry(timer, vmask, ctl);
    timer = be.timer;
    if (be.action.unmask) vmask = false;
    pending = be.action.assertIrq;
    snap(6, T.vtimer, {
      guest: "running", vmm: "enters with the IRQ pending",
      rule: { name: "before_entry", masked: true, ctl, entry: be.action },
    });
  }

  // 7: the guest takes the IRQ (pending and PSTATE.I clear), its handler records FIRED_AT and
  // clears ENABLE, then returns. The pending IRQ stays set for the rest of this run.
  if (!(pending && !pstateI)) throw new Error("model: the IRQ should be taken here");
  fired = cnt(T.vtimer);
  ctlBits = 0n;
  snap(7, T.vtimer, { guest: "IRQ handler, then returns", vmm: "guest running" });

  // 8: exit 3, the kick's CANCELED. Before entry the timer is quiet: drop the line, unmask.
  exits.canceled += 1;
  pending = false;
  {
    const ctl = liveCtl(ctlBits, cval, cnt(T.kick));
    const be = beforeEntry(timer, vmask, ctl);
    timer = be.timer;
    if (be.action.unmask) vmask = false;
    pending = be.action.assertIrq;
    snap(8, T.kick, {
      traced, guest: "stopped", vmm: "drops our line, unmasks the vtimer",
      exit: { n: 3, reason: "CANCELED", pc: PC_AFTER_WFI },
      rule: { name: "before_entry", masked: true, ctl, entry: be.action },
    });
  }

  // 9: the guest masks IRQs again, prints the interval and arms the next round, a few
  // instructions before the next WFI exit. Not traced: the trace records that exit, not the arm.
  pstateI = true;
  interval = ticksToMs(u64(fired - start));
  const tNextArm = T.next - ARM_LEAD_TICKS;
  const nextStart = cnt(tNextArm);
  cval = u64(nextStart + ALARM_TICKS);
  ctlBits = CNTV_CTL.ENABLE;
  pc = PC_WFI;
  snap(9, tNextArm, { guest: "prints, arms the next round", vmm: "guest running" });

  return snaps;
}

// --- lab state ---------------------------------------------------------------------------------

export function initialState(over = {}) {
  return { offset: "ref", timing: "trace", step: 0, reveal: false, ...over };
}

function clampStep(n) {
  return Math.max(0, Math.min(LAST_STEP, n | 0));
}

export function step(state, action) {
  switch (action.type) {
    case "next": return { ...state, step: clampStep(state.step + 1) };
    case "prev": return { ...state, step: clampStep(state.step - 1) };
    case "goto": return { ...state, step: clampStep(action.step) };
    case "reset": return initialState();
    case "setOffset": return { ...state, offset: action.offset === "zero" ? "zero" : "ref" };
    case "setTiming": return { ...state, timing: action.timing === "ideal" ? "ideal" : "trace" };
    case "setReveal": return { ...state, reveal: Boolean(action.on) };
    default: return state;
  }
}

/** Share state: `<r|z>-<t|i>-<step>[-x]`; the default (`r-t-0`) clears the hash. */
export function encodeHash(s) {
  const str = `${s.offset === "zero" ? "z" : "r"}-${s.timing === "ideal" ? "i" : "t"}-${s.step}${s.reveal ? "-x" : ""}`;
  return str === "r-t-0" ? null : str;
}

export function decodeHash(str) {
  if (typeof str !== "string" || str.length > 16) throw new Error("bad hash");
  const m = /^([rz])-([ti])-(\d)(-x)?$/.exec(str);
  if (!m) throw new Error("bad hash");
  const n = Number(m[3]);
  if (n > LAST_STEP) throw new Error("bad hash");
  return initialState({ offset: m[1] === "z" ? "zero" : "ref", timing: m[2] === "i" ? "ideal" : "trace", step: n, reveal: Boolean(m[4]) });
}

// --- formatting ----------------------------------------------------------------------------------

export function hex(v) {
  return "0x" + BigInt(v).toString(16);
}

/** 1234567n -> "1,234,567". */
export function dec(v) {
  return BigInt(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Nanoseconds -> "212.565 ms" (three decimals, truncated). */
export function ms(ns) {
  const us = BigInt(ns) / 1000n;
  return `${us / 1000n}.${String(us % 1000n).padStart(3, "0")} ms`;
}

export function exitLabel(exit, reveal) {
  if (!exit) return null;
  if (exit.n === 3 && !reveal) return `exit 3 (${SITTING_B}, explains this one)`;
  if (exit.reason === "WFI") return `exit ${exit.n}: WFI (class ${exit.ec})`;
  return `exit ${exit.n}: ${exit.reason}`;
}

function sleepText(r) {
  if (r.kind === "wake") return "Wake now";
  let msPart;
  if (r.ns % 1_000_000n === 0n) msPart = `${r.ns / 1_000_000n} ms`;
  else if (r.ns % 1000n === 0n) msPart = ms(r.ns);
  else msPart = `${dec(r.ns)} ns`;
  return `Sleep for ${msPart}`;
}

/** The answer of `wfiWait` in plain words, plus why. */
export function wfiAnswer(r) {
  const why = {
    off: "the timer is disabled or masked: no deadline, so sleep one slice (only a stop ends it)",
    met: "ISTATUS is already set: the count has reached CVAL",
    overflow: "CVAL + offset does not fit in 64 bits: sleep one slice, then look again",
    past: "the host count is already at or past CVAL + offset",
    "no-timebase": "no host timebase: sleep one slice",
    slice: "the deadline is more than one slice away: sleep one 100 ms slice, then look again",
    deadline: "the deadline is less than one 100 ms slice away, so sleep until it",
  }[r.rule];
  return { text: sleepText(r), why };
}

function onOff(b) {
  return b ? "1" : "0";
}

/**
 * The rows of the timeline table, one per signal, with one cell per step. A cell is
 * `{ text, high }` where `high` (true/false/null) drives the bar style; text always carries
 * the value, so color is never the only cue.
 */
export function signalRows(snaps, reveal) {
  const row = (key, label, fn) => ({ key, label, cells: snaps.map(fn) });
  return [
    row("guest", "Guest", (s) => ({ text: s.guest, high: null })),
    row("vmm", "VMM", (s) => ({ text: s.vmm, high: null })),
    row("exit", "Exit", (s) => (s.exit ? { text: exitLabel(s.exit, reveal), high: true } : { text: "none", high: null, muted: true })),
    row("cntvct", "CNTVCT (host − offset)", (s) => ({ text: dec(s.cntvct), high: null })),
    row("cval", "CVAL", (s) => ({ text: s.cval === null ? "(last round's)" : dec(s.cval), high: null })),
    row("enable", "ENABLE", (s) => ({ text: onOff(s.enable), high: s.enable })),
    row("istatus", "ISTATUS (count ≥ CVAL)", (s) => s.enable ? { text: onOff(s.istatus), high: s.istatus } : { text: "n/a, off", high: null }),
    row("output", "Timer output", (s) => ({ text: s.output ? "asserted" : "quiet", high: s.output })),
    row("imask", "IMASK (guest, at the timer)", (s) => ({ text: s.imask ? "1, masked" : "0", high: s.imask })),
    row("pstateI", "PSTATE.I (guest, at the CPU)", (s) => ({ text: s.pstateI ? "1, masked" : "0, listening", high: s.pstateI })),
    row("vmask", "vtimer mask (the framework)", (s) => ({ text: s.vmask ? "1, masked" : "0", high: s.vmask })),
    row("line", "Our line (VMM)", (s) => ({ text: s.line ? "up" : "down", high: s.line })),
    row("pending", "Pending IRQ (this run)", (s) => ({ text: onOff(s.pending), high: s.pending })),
  ];
}

/** Host-tick arithmetic for the readout at a snapshot. */
export function arithmetic(s) {
  const lines = [
    `host count ${dec(s.host)} − offset ${dec(s.offset)} = CNTVCT ${dec(s.cntvct)}`,
  ];
  if (s.cval !== null) {
    lines.push(`CVAL ${dec(s.cval)} + offset ${dec(s.offset)} = host deadline ${dec(s.deadlineHost)}`);
  }
  return lines;
}

/** The step's own notes (plain text). */
export function notes(s, state) {
  const reveal = state.reveal;
  const out = [];
  const traceNote = (what) => (state.timing === "trace"
    ? `${what} at ${ms(s.tNs)} in the reference's trace (second round).`
    : `${what} at ${ms(s.tNs)} (ideal timing).`);
  switch (s.step) {
    case 0:
      out.push("The guest is between rounds: its timer is off (ENABLE = 0) and it keeps IRQs masked.");
      out.push(state.offset === "zero"
        ? `Offset 0: the guest's counter is the Mac's own count. The captured first read was ${dec(FIRST_READ_OFFSET_ZERO)} ticks, about 41.5 hours of awake time.`
        : `Reference offset: the host count when the machine was built. The captured first read was ${dec(FIRST_READ_TICKS)} ticks, 5.5 ms after the offset was taken.`);
      out.push("The host count here is illustrative (one value that fits both captures); the arithmetic is exact.");
      out.push("Switch the offset and compare: CNTVCT and CVAL change, the host deadline does not. The VMM must add the offset back before it compares CVAL with the host's count; the calculator below shows what happens when it forgets.");
      break;
    case 1:
      out.push(`start = CNTVCT = ${dec(s.start)}; CVAL = start + ${dec(ALARM_TICKS)} (CNTFRQ / 10, 100 ms at 24 MHz).`);
      out.push("msr daifclr, #2 clears PSTATE.I just before the wfi. No exit: these are plain register writes.");
      if (state.timing === "trace") out.push(`The trace does not record the arm; the lab puts it ${dec(ARM_LEAD_TICKS)} ticks (2 µs) before the WFI exit, a few instructions earlier.`);
      break;
    case 2: {
      const r = s.rule;
      const a = wfiAnswer(r.result);
      out.push(traceNote("The WFI exit (exception class 0x01) arrives"));
      out.push(`PC stays at the wfi, ${hex(s.pc)}: the VMM adds 4 when it resumes.`);
      out.push(`No IRQ is pending, so the VMM asks the WFI sleep rule (you write it as nogic_wfi_wait in ${SITTING_B}): ${a.text}, because ${a.why}.`);
      if (r.result.left !== undefined) out.push(`Ticks left: host deadline − host now = ${dec(r.result.left)}, a little under 2,400,000 because the arm came 2 µs before this exit. Under one 100 ms slice, so the deadline decides.`);
      out.push("The host deadline is CVAL + offset; it is the same under either offset setting.");
      break;
    }
    case 3:
      out.push(`The count reaches CVAL at ${ms(s.tNs)}: ISTATUS = 1 and the timer asserts its output.`);
      out.push("Nothing happens yet: the vCPU is outside hv_vcpu_run, so no VTIMER exit can arrive. While our thread sleeps, the VMM is the alarm clock.");
      if (state.timing === "trace") out.push("In the trace the next exit comes about 5 ms after this deadline: the host woke our thread late. Your numbers will differ.");
      break;
    case 4: {
      const a = wfiAnswer(s.rule.result);
      out.push(`On waking the VMM asks the WFI sleep rule again: ${a.text}, because ${a.why}.`);
      out.push(`PC + 4 = ${hex(s.pc)}. Before entry: our line is down and the vtimer is not masked, so nothing to do.`);
      break;
    }
    case 5:
      out.push(traceNote("The VTIMER exit arrives"));
      out.push(`PC unchanged at ${hex(s.pc)}: an asynchronous exit points at the next instruction not yet run.`);
      out.push("The framework masked the vtimer itself; the VMM raises our line and leaves the mask alone.");
      break;
    case 6:
      out.push(`The before-entry rule (before_entry in ${SITTING_B}), with the vtimer masked and the timer still asserting: keep our line up, do not unmask, set the pending IRQ for this run.`);
      out.push("Unmasking now would make the vtimer exit again at once, because the level is still high.");
      break;
    case 7:
      out.push("Pending and PSTATE.I clear: the CPU takes the IRQ between two instructions, at VBAR_EL1 + 0x280.");
      out.push(`The handler records FIRED_AT = ${dec(s.fired)}, clears ENABLE (the timer goes quiet), and returns.`);
      out.push("No exit: a register write inside the guest. The pending IRQ the VMM set is still set for the rest of this run.");
      if (reveal) {
        out.push("So the CPU takes the same IRQ again, and again, at the same PC: the guest counts these as stale (stale=362066 over ten rounds in the reference run).");
      } else {
        out.push(`What that leftover pending IRQ does is the surprise in ${SITTING_B}.`);
      }
      break;
    case 8:
      if (reveal) {
        out.push(traceNote("The CANCELED exit arrives"));
        out.push("The line kicker forced it: while our line is up, a helper thread calls hv_vcpus_exit after 1 ms. Without it the guest would re-take the stale IRQ for the whole run.");
      } else {
        out.push(traceNote("A third exit arrives"));
        out.push(`Why it comes is explained in ${SITTING_B}. Tick "Show why exit 3 happens" to see it now.`);
      }
      out.push(`The before-entry rule (before_entry in ${SITTING_B}), with the vtimer masked and the timer quiet: drop our line, unmask the vtimer, no pending IRQ.`);
      break;
    case 9:
      out.push(`The guest masks IRQs again (msr daifset, #2) and prints its interval: (FIRED_AT − start) × 1000 / CNTFRQ = ${s.interval} ms.`);
      out.push("Printing costs one hvc exit per character, about 36 for a line like \"timer-nogic: interval 1 = 105 ms ok\". The lesson's trace capture filters those out, and so does this lab.");
      if (state.timing === "trace") {
        out.push("The trace does not record the guest's output; with these times this round would print 105 ms (the reference's ten intervals were 101 to 110 ms).");
        out.push(`This column is the arm, placed 2 µs before the next round's WFI exit, which the trace records at ${ms(TRACE.nextWfi.t_ns)}.`);
      }
      out.push(`Three timer exits this round. Ten rounds give 30: the reference's --stats line says vtimer 10, wfx 10, canceled 10 (its total also counts the printing exits).`);
      break;
  }
  return out;
}

/** The one-line summary for the live region. */
export function summary(s, state) {
  if (s.step === 0) return `Before the round, ${ms(s.tNs)}. Press Step to arm the timer.`;
  const n = s.exits.wfx + s.exits.vtimer + s.exits.canceled;
  const when = s.traced ? ms(s.tNs) : `about ${ms(s.tNs)}`;
  return `Step ${s.step} of ${LAST_STEP}, ${when}: ${stepLine(s.step, state.reveal)}. Timer exits this round: ${n}.`;
}

// --- the WFI deadline calculator -------------------------------------------------------------------

/**
 * Parse a guest-written u64: decimal (commas or underscores allowed) or 0x hex. Hardened: at
 * most 32 characters, digits only, value at most 2^64 - 1. Returns `{ ok, value }` or
 * `{ ok: false, error }`.
 */
export function parseU64(text) {
  if (typeof text !== "string") return { ok: false, error: "not text" };
  const t = text.trim();
  if (t === "") return { ok: false, error: "empty" };
  if (t.length > 32) return { ok: false, error: "too long" };
  let v;
  if (/^0[xX]/.test(t)) {
    const d = t.slice(2).replace(/_/g, "");
    if (!/^[0-9a-fA-F]{1,16}$/.test(d)) return { ok: false, error: "use 1 to 16 hex digits after 0x" };
    v = BigInt("0x" + d);
  } else {
    const d = t.replace(/[,_]/g, "");
    if (!/^[0-9]{1,20}$/.test(d)) return { ok: false, error: "use decimal digits, or 0x and hex digits" };
    v = BigInt(d);
  }
  if (v > U64_MAX) return { ok: false, error: "larger than 2^64 - 1" };
  return { ok: true, value: v & MASK64 };
}

/**
 * ISTATUS as the VMM reads it. The hardware computes it (read-only): with ENABLE = 1 it is 1
 * exactly when CNTVCT >= CVAL. "hw" uses that; "race" reads 0 although the count has reached
 * CVAL (CNTV_CTL read a moment before the count passed CVAL, the host clock read after);
 * "one" reads 1 regardless, an inconsistent value the VMM must still survive.
 */
export function readCtl({ enable, imask, istatus = "hw" }, cval, wfiSnap) {
  const computed = Boolean(enable) && wfiSnap.cntvct >= cval;
  const ist = istatus === "race" ? false : istatus === "one" ? true : computed;
  const ctl = (enable ? CNTV_CTL.ENABLE : 0n) | (imask ? CNTV_CTL.IMASK : 0n) | (ist ? CNTV_CTL.ISTATUS : 0n);
  return { ctl, computed, istatus: ist };
}

/** Presets for the calculator, relative to a round's WFI-exit snapshot. */
export function calcPresets(wfiSnap) {
  const p = (id, label, enable, cval, istatus = "hw") => ({ id, label, enable, imask: false, istatus, cval });
  return [
    p("round", "This round", true, wfiSnap.cval),
    p("short", "10 ms away", true, wfiSnap.cntvct + 240_000n),
    p("past", "Already past (CVAL = 0)", true, 0n),
    p("race", "Race: CTL read just before the deadline", true, wfiSnap.cntvct, "race"),
    p("far", "10 seconds away", true, wfiSnap.cntvct + 240_000_000n),
    p("max", "CVAL = 2^64 − 1", true, U64_MAX),
    p("off", "Timer disabled", false, wfiSnap.cval),
  ];
}

/**
 * The calculator: what the WFI sleep rule answers for (ctl, cval) at the round's WFI exit.
 * `opts.forgetOffset` models the bug the offset rule prevents: comparing CVAL (guest time)
 * with the host's count directly, as if the offset were 0.
 */
export function calc(ctl, cval, wfiSnap, opts = {}) {
  const offset = opts.forgetOffset ? 0n : wfiSnap.offset;
  const now = wfiSnap.host;
  const r = wfiWait(ctl, cval, offset, now);
  const sum = cval + offset;
  return {
    now, offset, result: r, answer: wfiAnswer(r),
    deadline: sum > U64_MAX ? null : sum,
    overflow: sum > U64_MAX,
    forgot: Boolean(opts.forgetOffset),
  };
}
