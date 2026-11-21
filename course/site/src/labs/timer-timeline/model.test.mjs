// node --test course/site/src/labs/timer-timeline/
// The model against its sources: chapter 11's fallback, the reference's trace and --stats
// captures, the first-read captures, and the Rust rules and unit tests in crates/vmm/src/timer.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FREQ, ALARM_TICKS, CNTV_CTL, WFI_SLICE_NS, LINE_RECHECK_NS, PC_WFI, PC_AFTER_WFI, TRACE,
  STEP_LINES, LAST_STEP, FIRST_READ_TICKS, FIRST_READ_OFFSET_ZERO, timerAsserted, wfiWait,
  newLine, vtimerActivated, beforeEntry, irqPending, ticksToMs, ticksToNanos, nsToTicks,
  firstRead, buildRound, initialState, step, encodeHash, decodeHash, signalRows, notes, summary,
  parseU64, calc, calcPresets, wfiAnswer, ms, dec, exitLabel, readCtl, stepLine, ARM_LEAD_TICKS,
} from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const ON = CNTV_CTL.ENABLE;
const IST = CNTV_CTL.ISTATUS;

// --- the lesson ---------------------------------------------------------------------------------

test("the step lines are the lesson's fallback, line for line", () => {
  const md = read("course/chapters/V/11-timer-irq.md");
  const at = md.indexOf(":::lab timer-timeline");
  assert.ok(at > 0, "lesson embeds the lab");
  const open = md.indexOf("```text\n", at);
  const close = md.indexOf("\n```", open + 8);
  const block = md.slice(open + 8, close).split("\n");
  assert.deepEqual(block, [...STEP_LINES]);
  assert.equal(LAST_STEP, 9);
  assert.match(md, /adds `CNTFRQ \/ 10` \(2,400,000 ticks\)/);
  assert.match(md, /enters at `VBAR_EL1 \+ 0x280`/);
});

// --- captures -----------------------------------------------------------------------------------

function traceRows() {
  const txt = read("course/captures/11-trace-ticks.txt");
  return txt.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

test("the trace constants are the capture's second round", () => {
  const rows = traceRows();
  assert.equal(rows.length, 7);
  const [wfi, vt, cn, next] = rows.slice(3, 7);
  const same = (row, c) => {
    assert.equal(BigInt(row.t_ns), c.t_ns);
    assert.equal(row.reason, c.reason);
    assert.equal(BigInt(row.pc), c.pc);
    if (c.ec) assert.equal(row.ec, c.ec);
  };
  same(wfi, TRACE.wfi);
  same(vt, TRACE.vtimer);
  same(cn, TRACE.canceled);
  same(next, TRACE.nextWfi);
  assert.equal(BigInt(rows[0].pc), PC_WFI);
  assert.equal(BigInt(rows[1].pc), PC_AFTER_WFI);
});

test("three exits per round, ten rounds give the --stats line", () => {
  const txt = read("course/captures/11-timer-nogic.txt");
  const m = /exits: vtimer (\d+), wfx (\d+), total \d+: canceled (\d+)/.exec(txt);
  assert.ok(m, "stats line present");
  for (const timing of ["trace", "ideal"]) {
    const last = buildRound({ timing }).at(-1);
    assert.equal(10 * last.exits.vtimer, Number(m[1]));
    assert.equal(10 * last.exits.wfx, Number(m[2]));
    assert.equal(10 * last.exits.canceled, Number(m[3]));
  }
  assert.match(txt, /cntfrq=24000000/);
  assert.equal(FREQ, 24_000_000n);
  assert.match(txt, /stale=362066/);
});

test("the first CNTVCT read matches both captures", () => {
  const ref = /first cntvct=(\d+)/.exec(read("course/captures/11-first-cntvct.txt"));
  const zero = /first cntvct=(\d+)/.exec(read("course/captures/11-offset-zero.txt"));
  assert.equal(BigInt(ref[1]), FIRST_READ_TICKS);
  assert.equal(BigInt(zero[1]), FIRST_READ_OFFSET_ZERO);
  assert.equal(firstRead("ref"), FIRST_READ_TICKS);
  assert.equal(firstRead("zero"), FIRST_READ_OFFSET_ZERO);
});

// --- the Rust source ------------------------------------------------------------------------------

test("constants match crates/vmm/src/timer.rs", () => {
  const rs = read("crates/vmm/src/timer.rs");
  assert.match(rs, /pub const ENABLE: u64 = 1 << 0;/);
  assert.match(rs, /pub const IMASK: u64 = 1 << 1;/);
  assert.match(rs, /pub const ISTATUS: u64 = 1 << 2;/);
  assert.deepEqual([CNTV_CTL.ENABLE, CNTV_CTL.IMASK, CNTV_CTL.ISTATUS], [1n, 2n, 4n]);
  assert.match(rs, /NOGIC_WFI_SLICE: Duration = Duration::from_millis\(100\)/);
  assert.equal(WFI_SLICE_NS, 100_000_000n);
  assert.match(rs, /NOGIC_LINE_RECHECK: Duration = Duration::from_millis\(1\)/);
  assert.equal(LINE_RECHECK_NS, 1_000_000n);
  const host = read("crates/hvf/src/host.rs");
  assert.match(host, /fn ticks_to_nanos/);
});

test("timer_asserted", () => {
  assert.equal(timerAsserted(ON | IST), true);
  assert.equal(timerAsserted(ON), false);
  assert.equal(timerAsserted(IST), false);
  assert.equal(timerAsserted(ON | IST | CNTV_CTL.IMASK), false);
});

test("nogic_wfi_wait mirrors the Rust unit test", () => {
  const offset = 1_000_000n;
  const now = offset + 24_000_000n;
  const cnt = now - offset;
  const sleep = (r) => (r.kind === "sleep" ? r.ns : null);
  assert.equal(wfiWait(ON, cnt - 1n, offset, now).kind, "wake");
  assert.equal(wfiWait(ON, 0n, offset, now).kind, "wake");
  assert.equal(wfiWait(ON, cnt, offset, now).kind, "wake");
  assert.equal(wfiWait(ON | IST, cnt + 1_000_000n, offset, now).kind, "wake");
  assert.equal(sleep(wfiWait(ON, cnt + 240_000n, offset, now)), 10_000_000n);
  assert.equal(sleep(wfiWait(ON, cnt + 240_000_000n, offset, now)), WFI_SLICE_NS);
  assert.equal(sleep(wfiWait(ON, (1n << 64n) - 1n, offset, now)), WFI_SLICE_NS);
  for (const ctl of [0n, CNTV_CTL.IMASK, ON | CNTV_CTL.IMASK, ON | CNTV_CTL.IMASK | IST]) {
    assert.equal(sleep(wfiWait(ctl, cnt - 1n, offset, now)), WFI_SLICE_NS);
  }
  assert.equal(sleep(wfiWait(ON, cnt + 240_000n, offset, now, null)), WFI_SLICE_NS);
  // Every input ends in a bounded answer.
  const edges = [0n, 1n, cnt, (1n << 63n), (1n << 64n) - 1n];
  for (const ctl of [0n, ON, ON | IST, ON | CNTV_CTL.IMASK]) {
    for (const cval of edges) for (const off of edges) {
      const r = wfiWait(ctl, cval, off, now);
      if (r.kind === "sleep") assert.ok(r.ns <= WFI_SLICE_NS);
    }
  }
});

test("ticks_to_nanos with the 125/3 timebase", () => {
  assert.equal(ticksToNanos(24_000_000n), 1_000_000_000n);
  assert.equal(ticksToNanos(5n, { numer: 1n, denom: 0n }), 0n);
  assert.equal(ticksToNanos((1n << 64n) - 1n, { numer: 0xffffffffn, denom: 1n }), (1n << 64n) - 1n);
  assert.equal(nsToTicks(1_000_000_000n), 24_000_000n);
});

test("NoGicTimer's line follows the table (the Rust unit test)", () => {
  const firing = ON | IST;
  let t = newLine();
  let r = beforeEntry(t, false, 0n);
  assert.deepEqual(r.action, { unmask: false, assertIrq: false });
  t = vtimerActivated(r.timer);
  assert.ok(t.line && irqPending(t, firing));
  r = beforeEntry(t, true, firing);
  assert.deepEqual(r.action, { unmask: false, assertIrq: true });
  r = beforeEntry(r.timer, true, IST);
  assert.deepEqual(r.action, { unmask: true, assertIrq: false });
  assert.ok(!r.timer.line && !irqPending(r.timer, firing));
  for (const ctl of [firing | CNTV_CTL.IMASK, ON]) {
    const x = beforeEntry(vtimerActivated(r.timer), true, ctl);
    assert.ok(x.action.unmask);
    assert.ok(!x.timer.line);
  }
});

test("the guest's ticks_to_ms truncates and saturates", () => {
  assert.equal(ticksToMs(2_400_000n), 100n);
  assert.equal(ticksToMs(2_521_266n), 105n);
  assert.equal(ticksToMs((1n << 64n) - 1n), ((1n << 64n) - 1n) / FREQ);
  assert.equal(ticksToMs(5n, 0n), 0n);
});

// --- the round --------------------------------------------------------------------------------------

test("the round follows the fallback, derived from the rules", () => {
  const s = buildRound();
  assert.equal(s.length, 10);
  assert.deepEqual(s.map((x) => x.step), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // 1: armed, listening, at the wfi
  assert.equal(s[1].cval, s[1].start + ALARM_TICKS);
  assert.ok(s[1].enable && !s[1].istatus && !s[1].pstateI && s[1].pc === PC_WFI);
  // 2: WFI exit, the VMM sleeps until the deadline, a little under 100 ms (the arm came first)
  assert.equal(s[2].exit.reason, "WFI");
  assert.equal(s[2].exit.ec, "0x01");
  assert.equal(s[2].pc, PC_WFI);
  assert.equal(s[2].rule.result.kind, "sleep");
  assert.equal(s[2].rule.result.rule, "deadline");
  assert.equal(s[2].rule.result.left, ALARM_TICKS - ARM_LEAD_TICKS);
  assert.equal(s[2].rule.result.ns, 99_998_000n);
  assert.equal(wfiAnswer(s[2].rule.result).text, "Sleep for 99.998 ms");
  assert.equal(s[2].rule.irqPending, false);
  assert.equal(s[2].vmm, "sleeping");
  // 3: deadline: ISTATUS and the output rise, still no exit
  assert.ok(s[3].istatus && s[3].output && !s[3].exit && s[3].cntvct === s[3].cval);
  assert.equal(s[3].host, s[3].deadlineHost);
  // 4: wake, PC + 4, nothing to do before entry
  assert.equal(s[4].rule.result.kind, "wake");
  assert.equal(s[4].pc, PC_WFI + 4n);
  assert.deepEqual(s[4].rule.entry, { unmask: false, assertIrq: false });
  // 5: VTIMER: line up, framework mask on, PC unchanged
  assert.equal(s[5].exit.reason, "VTIMER_ACTIVATED");
  assert.ok(s[5].line && s[5].vmask && !s[5].pending && s[5].pc === PC_AFTER_WFI);
  // 6: still asserting: pending IRQ, no unmask
  assert.deepEqual(s[6].rule.entry, { unmask: false, assertIrq: true });
  assert.ok(s[6].pending && s[6].vmask && s[6].output);
  // 7: handler cleared ENABLE: output quiet, pending still set
  assert.ok(!s[7].enable && !s[7].output && s[7].pending && s[7].line);
  // 8: third exit, timer quiet: drop the line and unmask
  assert.equal(s[8].exit.reason, "CANCELED");
  assert.deepEqual(s[8].rule.entry, { unmask: true, assertIrq: false });
  assert.ok(!s[8].line && !s[8].vmask && !s[8].pending);
  // 9: masked again, next round armed
  assert.ok(s[9].pstateI && s[9].enable && s[9].pc === PC_WFI);
  assert.deepEqual(s[9].exits, { wfx: 1, vtimer: 1, canceled: 1 });
});

test("trace timing reproduces the captured times and a 105 ms interval", () => {
  const s = buildRound({ timing: "trace" });
  assert.equal(ms(s[2].tNs), "107.512 ms");
  assert.equal(ms(s[5].tNs), "212.565 ms");
  assert.equal(ms(s[8].tNs), "213.832 ms");
  assert.equal(ms(s[9].tNs), "214.042 ms"); // the arm, 2 µs before the next WFI exit
  assert.equal(s[9].interval, 105n);
  for (const i of [2, 5, 8]) assert.ok(s[i].traced, `step ${i} is traced`);
  for (const i of [0, 1, 3, 4, 6, 7, 9]) assert.ok(!s[i].traced, `step ${i} is estimated`);
  assert.match(notes(s[9], initialState()).join(" "), /214\.044 ms/);
  // the deadline is 100 ms after the arm; the VTIMER exit about 5 ms after that
  assert.equal(ms(s[3].tNs - s[1].tNs), "100.000 ms");
  const late = s[5].tNs - s[3].tNs;
  assert.ok(late > 5_000_000n && late < 5_100_000n);
});

test("ideal timing: 100 ms interval, the kick 1 ms later", () => {
  const s = buildRound({ timing: "ideal" });
  assert.equal(s[9].interval, 100n);
  assert.equal(s[5].t, s[3].t);
  assert.equal(s[8].tNs - s[5].tNs, LINE_RECHECK_NS);
  assert.equal(s[9].t, s[8].t);
  assert.ok(s.every((x) => !x.traced));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t >= s[i - 1].t, "time never runs backwards");
});

test("the offset changes what the guest sees, not when the VMM wakes", () => {
  const r = buildRound({ offset: "ref" });
  const z = buildRound({ offset: "zero" });
  for (let i = 0; i < r.length; i++) {
    assert.equal(r[i].host, z[i].host);
    assert.equal(r[i].deadlineHost, z[i].deadlineHost);
    assert.equal(r[i].interval, z[i].interval);
    assert.equal(z[i].cntvct - r[i].cntvct, r[i].offset);
  }
  assert.equal(z[0].offset, 0n);
});

// --- state, hash, text ----------------------------------------------------------------------------

test("steps clamp and the hash round-trips", () => {
  let s = initialState();
  assert.equal(encodeHash(s), null);
  s = step(s, { type: "prev" });
  assert.equal(s.step, 0);
  for (let i = 0; i < 20; i++) s = step(s, { type: "next" });
  assert.equal(s.step, 9);
  s = step(step(step(s, { type: "setOffset", offset: "zero" }), { type: "setTiming", timing: "ideal" }), { type: "setReveal", on: true });
  assert.equal(encodeHash(s), "z-i-9-x");
  assert.deepEqual(decodeHash("z-i-9-x"), s);
  assert.deepEqual(decodeHash("r-t-5"), initialState({ step: 5 }));
  for (const bad of ["", "r-t-10", "q-t-1", "r-t-1-y", "r-t-1-x-x", "r-t-01".repeat(5), null]) {
    assert.throws(() => decodeHash(bad));
  }
  assert.deepEqual(step(s, { type: "reset" }), initialState());
  assert.equal(step(s, { type: "goto", step: 99 }).step, 9);
});

test("exit 3 is not explained until revealed", () => {
  const s = buildRound();
  const hidden = initialState({ step: 8 });
  const shown = initialState({ step: 8, reveal: true });
  assert.equal(exitLabel(s[8].exit, false), "exit 3 (chapter 11, sitting B, explains this one)");
  assert.match(stepLine(8, false), /chapter 11, sitting B/);
  assert.equal(exitLabel(s[8].exit, true), "exit 3: CANCELED");
  const words = (st) => [...notes(s[8], st), ...notes(s[7], st), summary(s[8], st),
    ...signalRows(s, st.reveal).flatMap((r) => r.cells.map((c) => c.text))].join(" ");
  assert.doesNotMatch(words(hidden), /CANCELED|kick|stale/i);
  assert.match(words(shown), /CANCELED/);
  assert.match(words(shown), /stale=362066/);
});

test("every step has notes and a summary; rows carry text for every cell", () => {
  const s = buildRound();
  for (const x of s) {
    assert.ok(notes(x, initialState()).length > 0);
    assert.match(summary(x, initialState()), /ms/);
  }
  for (const row of signalRows(s, false)) {
    assert.equal(row.cells.length, 10);
    for (const c of row.cells) assert.equal(typeof c.text, "string");
  }
  assert.match(summary(s[9], initialState()), /Timer exits this round: 3/);
  assert.match(notes(s[9], initialState()).join(" "), /vtimer 10, wfx 10, canceled 10/);
  assert.match(notes(s[9], initialState()).join(" "), /one hvc exit per character/);
  // the summary never starts or ends a phrase with stray dots
  assert.match(summary(s[3], initialState()), /: about 100 ms of nothing, on both sides\. Timer/);
  for (const x of s) assert.doesNotMatch(summary(x, initialState()), /: \.|\.\.\./);
  // learner-facing text uses the lesson's sitting-A names first
  for (const x of s) {
    for (const t of notes(x, initialState())) {
      assert.doesNotMatch(t, /(^|[^(])\b(nogic_wfi_wait|before_entry)\b(?! in chapter 11)/, t);
    }
  }
});

test("parseU64 is hardened", () => {
  assert.deepEqual(parseU64("2,400,000"), { ok: true, value: 2_400_000n });
  assert.deepEqual(parseU64("0xffff_ffff_ffff_ffff"), { ok: true, value: (1n << 64n) - 1n });
  assert.deepEqual(parseU64(" 18446744073709551615 "), { ok: true, value: (1n << 64n) - 1n });
  for (const bad of ["", "18446744073709551616", "0x1_0000_0000_0000_0000", "-1", "1e9", "0x", "12a", "9".repeat(40), null]) {
    assert.equal(parseU64(bad).ok, false, String(bad));
  }
});

test("the calculator covers the Security note's cases", () => {
  const wfi = buildRound()[2];
  const P = Object.fromEntries(calcPresets(wfi).map((p) => [p.id, p]));
  const run = (p, opts) => calc(readCtl(p, p.cval, wfi).ctl, p.cval, wfi, opts);
  assert.equal(run(P.round).result.rule, "deadline");
  assert.equal(wfiAnswer(run(P.round).result).text, "Sleep for 99.998 ms");
  assert.equal(wfiAnswer(run(P.short).result).text, "Sleep for 10 ms");
  // CVAL = 0 with ENABLE: the hardware reports ISTATUS = 1, so the "met" branch decides
  assert.equal(readCtl(P.past, P.past.cval, wfi).istatus, true);
  assert.equal(run(P.past).result.rule, "met");
  // only a race (CTL read just before the count passed CVAL) reaches the "past" branch
  assert.equal(readCtl(P.race, P.race.cval, wfi).computed, true);
  assert.equal(readCtl(P.race, P.race.cval, wfi).istatus, false);
  assert.equal(run(P.race).result.rule, "past");
  assert.equal(run(P.far).result.rule, "slice");
  const max = run(P.max);
  assert.equal(max.overflow, true);
  assert.equal(max.result.rule, "overflow");
  assert.equal(wfiAnswer(max.result).text, "Sleep for 100 ms");
  assert.equal(run(P.off).result.rule, "off");
  // ISTATUS is computed: never 1 for a future CVAL unless forced as an inconsistent read
  assert.equal(readCtl(P.far, P.far.cval, wfi).istatus, false);
  assert.equal(readCtl({ ...P.far, istatus: "one" }, P.far.cval, wfi).istatus, true);
  assert.equal(readCtl(P.off, 0n, wfi).istatus, false);
  // forgetting the offset: with the reference offset the deadline looks long past
  const bug = run(P.round, { forgetOffset: true });
  assert.equal(bug.result.kind, "wake");
  assert.equal(bug.offset, 0n);
  const wz0 = buildRound({ offset: "zero" })[2];
  const Pz = Object.fromEntries(calcPresets(wz0).map((p) => [p.id, p]));
  const hidden = calc(readCtl(Pz.round, Pz.round.cval, wz0).ctl, Pz.round.cval, wz0, { forgetOffset: true });
  assert.equal(hidden.result.rule, "deadline", "with offset 0 the bug is invisible");
  // with offset 0, u64::MAX no longer overflows the add, but is still capped at one slice
  const wz = buildRound({ offset: "zero" })[2];
  const mz = calc(ON, (1n << 64n) - 1n, wz);
  assert.equal(mz.overflow, false);
  assert.equal(mz.result.rule, "slice");
  assert.equal(dec(1234567n), "1,234,567");
});
