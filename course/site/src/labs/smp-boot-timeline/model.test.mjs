// Tests for the smp-boot-timeline model. The scripted scenarios must reproduce chapter 20's
// captures exactly (trace records, console lines, Linux log lines, stats lines), the paper
// exercise must give the lesson's nine answers, and the PSCI port must follow
// crates/vmm/src/psci.rs (its constants are re-read from the Rust source so they cannot drift).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AFFINITY_MASK, CODE, GICR_BASE, GICR_STRIDE, RACE_TRACE, REG_TRACE, RACE_ENTRY, SCENARIOS,
  SCENARIO_IDS, MAX_ACTIONS, MAX_CPUS, DEFAULT_SCENARIO, scenarioLabel, mpidr, gicrFrame, linuxHwid, linuxRegion, makeMachine, apply,
  indexOf, entryCheck, lookups, runScenario, runFree, paperAnswers, encodeAct, decodeAct,
  initialState, step, encodeHash, decodeHash, snapshots, summary, eventSentence, quickMoves,
  linuxErrno, parseU64, hx, hxu, vcpuLines,
} from "./model.mjs";

const root = new URL("../../../../../", import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), "utf8");

/** The stdout and stderr sections of a capture file. */
function capture(name) {
  const text = read(`course/captures/${name}`);
  const out = text.split("--- stdout ---\n")[1].split("\n--- stderr ---")[0];
  const err = text.split("--- stderr ---\n")[1] || "";
  const lines = (s) => s.split("\n").filter((l) => l.length > 0);
  return { stdout: lines(out), stderr: lines(err) };
}

function traceRecords(name) {
  return capture(name).stdout.map((l) => JSON.parse(l));
}

test("mpidr ports arch::regs::mpidr: vCPU 17 is 0x8000_0101, vCPU 63 is 0x8000_030f", () => {
  assert.equal(mpidr(0), 0x8000_0000n);
  assert.equal(mpidr(3), 0x8000_0003n);
  assert.equal(mpidr(17), 0x8000_0101n);
  assert.equal(mpidr(63), 0x8000_030fn);
  const rs = read("crates/vmm/src/arch/regs.rs");
  assert.match(rs, /\(1 << 31\) \| \(\(\(i \/ 16\) & 0xff\) << 8\) \| \(i % 16\)/);
});

test("constants match psci.rs, smccc.rs and the layout", () => {
  const psci = read("crates/vmm/src/psci.rs");
  assert.match(psci, /pub const AFFINITY_MASK: u64 = 0xff_00ff_ffff;/);
  for (const [k, v] of Object.entries(CODE)) {
    assert.match(psci, new RegExp(`pub const ${k}: i64 = ${v};`), `${k} = ${v}`);
  }
  assert.equal(AFFINITY_MASK, 0xff_00ff_ffffn);
  const smccc = read("crates/vmm/src/smccc.rs");
  assert.match(smccc, /entry\.is_multiple_of\(4\) && ctx\.mem\.check_range\(GuestAddress\(entry\), 4\)/);
  // The order of the checks in cpu_on: index_of, then entry_valid, then the state.
  const on = psci.slice(psci.indexOf("pub fn cpu_on("), psci.indexOf("// ANCHOR_END: psci_cpu_on_fn"));
  const iIdx = on.indexOf("self.index_of(target)?"), iEntry = on.indexOf("if !entry_valid"), iState = on.indexOf("match s.power");
  assert.ok(iIdx > 0 && iIdx < iEntry && iEntry < iState, "index_of, then entry_valid, then the state");
  // The redistributor frames the chapter's Linux log reports.
  assert.equal(GICR_BASE, 0x080a_0000n);
  assert.equal(GICR_STRIDE, 128n * 1024n);
  const log = capture("20-linux-smp-log.txt").stdout;
  for (let i = 0; i < 4; i++) {
    assert.ok(log.some((l) => l.includes(`CPU${i}: found redistributor ${i} region 0:${linuxRegion(gicrFrame(i))}`)), `frame ${i}`);
    if (i > 0) assert.ok(log.some((l) => l.includes(`Booted secondary processor ${linuxHwid(mpidr(i) & AFFINITY_MASK)}`)));
  }
  // power_on: PC, x0 = context, x1..x3 = 0, CPSR EL1H_MASKED (0x3c5).
  const vm = read("crates/vmm/src/vcpu/mod.rs");
  assert.match(vm, /\(0u8, on\.ctx\), \(1, 0\), \(2, 0\), \(3, 0\)/);
  assert.match(read("crates/vmm/src/arch/regs.rs"), /assert_eq!\(pstate::EL1H_MASKED, 0x3c5\)/);
});

test("the race scenario reproduces 20-race-trace.txt record for record", () => {
  const recs = traceRecords("20-race-trace.txt");
  assert.equal(recs.length, RACE_TRACE.length);
  recs.forEach((r, i) => {
    const mine = RACE_TRACE[i];
    for (const k of ["t_ns", "vcpu", "reason", "pc"]) assert.equal(mine[k], r[k], `record ${i + 1} ${k}`);
    assert.equal(mine.fn, r.fn, `record ${i + 1} fn`);
  });
  // Every record is used once, in order, by a step whose actions match it.
  const snaps = runScenario("race");
  const used = snaps.flatMap((s) => s.trace);
  assert.deepEqual(used, RACE_TRACE);
  for (const s of snaps.slice(1)) {
    const calls = s.events.filter((e) => e.kind === "call" && !e.hidden);
    const exc = s.trace.filter((r) => r.reason === "exception");
    assert.deepEqual(calls.map((e) => [e.lane, e.fn]), exc.map((r) => [r.vcpu, r.fn]), `step ${s.step}`);
    const canceled = s.trace.filter((r) => r.reason === "canceled").map((r) => r.vcpu).sort();
    if (canceled.length) assert.deepEqual([...s.m.stopped.canceled].sort(), canceled);
  }
});

test("the race scenario prints exactly 20-smp-race.txt's console and secondaries' stats", () => {
  const cap = capture("20-smp-race.txt");
  const snaps = runScenario("race");
  assert.deepEqual(snaps.flatMap((s) => s.console), cap.stdout);
  assert.equal(cap.stdout[0], `smp-race: cpu 0 mpidr=0x80000000 entry=${hx(RACE_ENTRY)}`);
  const end = snaps[snaps.length - 1];
  for (const line of end.stderr) assert.ok(cap.stderr.includes(line), line);
  for (const i of [1, 2, 3]) {
    const v = end.m.vcpus[i];
    assert.deepEqual(v.exits, { hvc: 1, canceled: 1 });
    assert.ok(cap.stderr.includes(`macvmm: stats: vcpu${i} exits: vtimer 0, wfx 0, total ${v.exits.hvc + v.exits.canceled}: canceled ${v.exits.canceled}, hvc ${v.exits.hvc}`));
  }
  // The lesson's reading of the trace lines.
  const lesson = read("course/chapters/VIII/20-smp.md");
  assert.match(lesson, /line 8 is its restart with context `0x33`/);
  assert.equal(end.m.vcpus[3].regs.x[0], 0x33n);
});

test("the paper exercise gives the lesson's nine answers", () => {
  const lesson = read("course/chapters/VIII/20-smp.md");
  const block = lesson.slice(lesson.indexOf(":::predict What does each of the nine calls return?"));
  const answerLine = block.split("\n")[1];
  const quoted = [...answerLine.matchAll(/(\d): (-?\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(quoted.length, 9);
  const mine = paperAnswers();
  quoted.forEach(([n, v]) => assert.equal(mine[n - 1], v, `call ${n}`));
  // The nine calls are the lesson's list, in order.
  const list = lesson.slice(lesson.indexOf("Now work the table on paper."), lesson.indexOf(":::predict What does each"));
  const items = [...list.matchAll(/^\d\. (.*)$/gm)].map((m) => m[1].replace(/`/g, ""));
  assert.equal(items.length, 9);
  SCENARIOS.paper.steps.forEach((s, i) => assert.equal(s.text.replace(/`/g, ""), items[i], `item ${i + 1}`));
  assert.match(list, /with entry `0x4008_0000` unless one is given/);
});

test("Linux on 4 CPUs: log lines quoted verbatim, in order, and every lookup agrees", () => {
  const log = capture("20-linux-smp-log.txt").stdout;
  const snaps = runScenario("linux");
  const mine = snaps.flatMap((s) => s.log);
  let at = -1;
  for (const l of mine) {
    const i = log.indexOf(l);
    assert.ok(i > at, `in order: ${l}`);
    at = i;
  }
  const end = snaps[snaps.length - 1].m;
  assert.ok(lookups(end).every((r) => r.ok));
  assert.deepEqual(end.vcpus.map((v) => v.seen), [0, 1, 2, 3].map(mpidr));
  assert.equal(end.vcpus.filter((v) => v.power === "on").length, 4);
});

test("breakage 1: CPU_ON(1) is INVALID_PARAMETERS, Linux says -22, vCPU 1 never runs", () => {
  const log = capture("20-dup-mpidr-log.txt").stdout;
  const run = capture("20-dup-mpidr-run.txt").stderr;
  const snaps = runScenario("dup");
  for (const l of snaps.flatMap((s) => s.log)) assert.ok(log.includes(l), l);
  for (const l of snaps.flatMap((s) => s.stderr)) assert.ok(run.includes(l), l);
  assert.equal(snaps[3].vars.on1, CODE.INVALID_PARAMETERS);
  assert.equal(linuxErrno(snaps[3].vars.on1), -22);
  assert.ok(log.includes(`[    0.007045] psci: failed to boot CPU1 (${linuxErrno(CODE.INVALID_PARAMETERS)})`));
  const end = snaps[snaps.length - 1].m;
  assert.deepEqual(end.vcpus[1].exits, { hvc: 0, canceled: 0 });
  const lk = lookups(end);
  assert.equal(lk[1].ok, false);
  assert.match(lk[1].problems.join(" "), /power table says 0x0, like 1 other row/);
});

test("breakage 2: CPU_ON succeeds, vCPU 1 reads 0x80000000, then asks for a reset", () => {
  const recs = traceRecords("20-mpidr-mismatch-trace.txt");
  assert.equal(recs.length, REG_TRACE.length);
  recs.forEach((r, i) => {
    for (const k of ["t_ns", "vcpu", "reason", "pc"]) assert.equal(REG_TRACE[i][k], r[k]);
    assert.equal(REG_TRACE[i].fn, r.fn);
  });
  const snaps = runScenario("reg");
  assert.deepEqual(snaps.flatMap((s) => s.trace), REG_TRACE);
  const on = snaps[3].events[0];
  assert.equal(on.code, CODE.SUCCESS);
  const rd = snaps[4].events[1];
  assert.equal(rd.value, 0x8000_0000n);
  assert.equal(rd.mismatch, true);
  const end = snaps[snaps.length - 1].m;
  assert.deepEqual(end.vcpus[1].exits, { hvc: 1, canceled: 0 });
  assert.deepEqual(end.vcpus[0].exits.canceled, 1);
  const run = read("course/captures/20-mpidr-mismatch-run.txt");
  assert.match(run, /vcpu1 exits: vtimer 0, wfx 0, total 1: hvc 1/);
  assert.match(run, /vcpu0 exits: vtimer 0, wfx 0, total \d+: canceled 1,/);
  for (const l of snaps.flatMap((s) => s.stderr)) assert.ok(run.includes(l), l);
  for (const l of snaps.flatMap((s) => s.log)) assert.ok(read("course/captures/20-mpidr-mismatch-log.txt").includes(l), l);
});

test("CPU_ON racing: exactly one of any number of callers wins", () => {
  let m = makeMachine(8);
  // Start CPUs 1..7, then everybody races CPU_ON for CPU 7 after it turned itself off.
  for (let i = 1; i < 8; i++) {
    m = apply(m, { t: "on", from: 0, target: BigInt(i), entry: 0x4008_0000n, ctx: 0n }).m;
    m = apply(m, { t: "take", cpu: i }).m;
  }
  m = apply(m, { t: "off", from: 7 }).m;
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const r = apply(m, { t: "on", from: i, target: 7n, entry: 0x4008_0000n, ctx: BigInt(i) });
    m = r.m;
    codes.push(r.ev.code);
  }
  assert.equal(codes.filter((c) => c === 0).length, 1);
  assert.ok(codes.slice(1).every((c) => c === CODE.ON_PENDING));
  m = apply(m, { t: "take", cpu: 7 }).m;
  assert.equal(m.vcpus[7].regs.x[0], 0n); // the winner's context
  assert.equal(apply(m, { t: "on", from: 1, target: 7n, entry: 0x4008_0000n, ctx: 0n }).ev.code, CODE.ALREADY_ON);
});

test("refusals and their reasons", () => {
  const m = makeMachine(4);
  const on = (target, entry) => apply(m, { t: "on", from: 0, target, entry, ctx: 0n }).ev;
  assert.equal(on(0x10n, 0x4008_0000n).code, -2);
  assert.match(on(0x10n, 0x4008_0000n).why, /Aff0 = 16; our layout puts at most 16 CPUs in a cluster, so Aff0 only goes up to 15/);
  assert.match(on(0x8000_0002n, 0x4008_0000n).why, /bit 31/);
  assert.equal(on(0x100_0000_0000n, 0x4008_0000n).code, -2);
  assert.equal(on(2n, 0x4008_0002n).code, -9);
  assert.equal(on(2n, 0x3fff_fffcn).code, -9);
  assert.equal(on(2n, 0x43ff_fffcn).code, 0); // the last word of 64 MiB
  assert.equal(on(2n, 0x4400_0000n).code, -9);
  assert.equal(on(2n, 0xffff_ffff_ffff_fffcn).code, -9);
  assert.equal(on(0n, 0x4008_0000n).code, CODE.ALREADY_ON);
  assert.equal(entryCheck(m, null).ok, true);
  assert.equal(indexOf(m, 3n).index, 3);
  // A CPU that is not running cannot call; nothing to take; CPU_OFF only when on.
  assert.match(apply(m, { t: "on", from: 1, target: 2n, entry: 0x4008_0000n, ctx: 0n }).error, /not running/);
  assert.match(apply(m, { t: "take", cpu: 1 }).error, /no request/);
  assert.match(apply(m, { t: "off", from: 2 }).error, /not running/);
  assert.match(apply(m, { t: "frob" }).error, /unknown/);
  // vCPU 17 on an 18-CPU machine.
  const big = makeMachine(18);
  assert.equal(indexOf(big, 0x101n).index, 17);
  assert.equal(indexOf(big, 0x11n).index, null);
});

test("the stop kicks running vCPUs and wakes parked ones", () => {
  let m = makeMachine(4);
  m = apply(m, { t: "on", from: 0, target: 1n, entry: 0x4008_0000n, ctx: 0n }).m;
  m = apply(m, { t: "take", cpu: 1 }).m;
  m = apply(m, { t: "on", from: 0, target: 2n, entry: 0x4008_0000n, ctx: 0n }).m; // pending, never taken
  const r = apply(m, { t: "sysoff", from: 0 });
  assert.deepEqual(r.m.stopped.canceled, [1]);
  assert.deepEqual(r.m.stopped.woken, [2, 3]);
  assert.match(r.ev.why, /one canceled exit each/);
  assert.match(apply(r.m, { t: "read", cpu: 0 }).error, /stopped/);
});

test("share strings round-trip and hostile ones fall back", () => {
  assert.equal(encodeHash(initialState()), null);
  for (const s of ["race@5", "paper@4!", "linux@9", "dup@2", "reg@5", "free.c4.ok", "free.c18.reg.on0-101-40080000-0_tk17_rd17"]) {
    assert.equal(encodeHash(decodeHash(s)), s, s);
  }
  assert.equal(decodeHash("race@999").step, SCENARIOS.race.steps.length);
  assert.equal(decodeHash("paper@3!").reveal, true);
  assert.equal(decodeHash("race@3!").reveal, false);
  for (const bad of ["", "x", "race@-1", "free.c1.ok", "free.c99.ok", "free.c4.bad", "free.c4.ok.<script>", "a".repeat(5000), null, 42]) {
    assert.deepEqual(decodeHash(bad), initialState(), String(bad).slice(0, 20));
  }
  // Illegal actions cut the replay; unknown tokens stop it.
  assert.equal(encodeHash(decodeHash("free.c4.ok.tk1_rd0")), "free.c4.ok");
  assert.equal(encodeHash(decodeHash("free.c4.ok.rd0_zz_rd0")), "free.c4.ok.rd0");
  const long = "free.c4.ok." + Array(100).fill("rd0").join("_");
  assert.equal(decodeHash(long).free.acts.length, MAX_ACTIONS);
  for (const a of [{ t: "on", from: 3, target: 0x8000_0002n, entry: 0xffff_ffff_ffff_ffffn, ctx: 0x33n }, { t: "ai", from: 0, target: 1n, level: 1n }, { t: "take", cpu: 2 }, { t: "reset", from: 1 }]) {
    assert.deepEqual(decodeAct(encodeAct(a)), a);
  }
  assert.equal(decodeAct("on0-11111111111111111-0-0"), null);
});

test("the reducer: steps, scenarios, the sandbox", () => {
  let s = initialState();
  s = step(s, { type: "next" });
  s = step(s, { type: "next" });
  assert.equal(s.step, 2);
  s = step(s, { type: "goto", step: 500 });
  assert.equal(s.step, SCENARIOS[DEFAULT_SCENARIO].steps.length);
  s = step(s, { type: "scenario", sc: "free" });
  assert.equal(s.step, 0);
  let r = step(s, { type: "freeAct", act: { t: "take", cpu: 1 } });
  assert.match(r.error, /no request/);
  assert.equal(r.free.acts.length, 0);
  s = step(s, { type: "freeAct", act: { t: "on", from: 0, target: 1n, entry: 0x4008_0000n, ctx: 7n } });
  s = step(s, { type: "freeAct", act: { t: "take", cpu: 1 } });
  assert.equal(encodeHash(s), "free.c4.ok.on0-1-40080000-7_tk1");
  const snaps = snapshots(s);
  assert.equal(snaps[2].m.vcpus[1].regs.x[0], 7n);
  assert.match(summary(s, snaps), /Step 2 of 2: vCPU 1's thread takes its mailbox\./);
  assert.ok(quickMoves(snaps[2].m).some((q) => q.label === "vCPU 1 calls CPU_OFF"));
  s = step(s, { type: "prev" });
  assert.equal(s.free.acts.length, 1);
  s = step(s, { type: "freeConfig", cpus: 18, brk: "reg" });
  assert.deepEqual(s.free, { cpus: 18, brk: "reg", acts: [] });
  s = step(s, { type: "freeConfig", cpus: 500 });
  assert.equal(s.free.cpus, 64);
  assert.equal(step(s, { type: "scenario", sc: "nope" }).sc, "free");
  for (const id of SCENARIO_IDS) assert.ok(id === "free" || SCENARIOS[id]);
});

test("readout text carries no internal identifiers", () => {
  const texts = [];
  for (const id of SCENARIO_IDS.filter((x) => x !== "free")) {
    const snaps = runScenario(id);
    for (let k = 0; k < snaps.length; k++) {
      texts.push(summary({ sc: id, step: k }, snaps), snaps[k].note || "", ...snaps[k].events.map(eventSentence));
    }
  }
  for (const t of texts) assert.doesNotMatch(t, /\bM\d+\b|PLAN|§|HC-\d|CURRICULUM|undefined|NaN/, t);
});

test("number helpers", () => {
  assert.equal(hxu(0x4008_0000n), "0x4008_0000");
  assert.equal(hxu(0x1000n), "0x1000");
  assert.equal(hx(-4), "0xfffffffffffffffc");
  assert.deepEqual(parseU64("0x4008_0000"), { ok: true, value: 0x4008_0000n });
  assert.deepEqual(parseU64("101"), { ok: true, value: 0x101n });
  assert.equal(parseU64("0x1_0000_0000_0000_0000").ok, false);
  assert.equal(parseU64("zz").ok, false);
  assert.equal(parseU64("").ok, false);
  assert.equal(parseU64("1".repeat(40)).ok, false);
});

test("free mode replays stop at the first impossible action", () => {
  const { applied } = runFree({ cpus: 2, brk: "ok", acts: [{ t: "read", cpu: 0 }, { t: "off", from: 1 }, { t: "read", cpu: 0 }] });
  assert.equal(applied.length, 1);
});

test("the sandbox allows as many vCPUs as arch::layout::MAX_CPUS: vCPU 63 is 0x30f, frame 0x080a_0000 + 63 x 128 KiB", () => {
  const layout = read("crates/vmm/src/arch/layout.rs");
  const m = /pub const MAX_CPUS: u32 = (\d+);/.exec(layout);
  assert.ok(m, "layout.rs declares MAX_CPUS");
  assert.equal(MAX_CPUS, Number(m[1]));
  const s = decodeHash(`free.c${MAX_CPUS}.ok`);
  assert.equal(s.free.cpus, MAX_CPUS);
  const big = makeMachine(MAX_CPUS);
  assert.equal(indexOf(big, 0x30fn).index, 63);
  assert.equal(gicrFrame(63), 0x080a_0000n + 63n * 128n * 1024n);
  assert.equal(indexOf(big, 0x200n).index, 32); // Aff1 = 2
  assert.throws(() => makeMachine(MAX_CPUS + 1));
});

test("SYSTEM_RESET: exit code 4 only with --on-reset exit; the sandbox says the default reboots", () => {
  const reg = runScenario("reg");
  const last = reg[reg.length - 1].events[0];
  assert.match(last.why, /--on-reset exit, as in this run: exit code 4/);
  const free = decodeHash("free.c2.ok.rs0");
  const ev = snapshots(free)[1].events[0];
  assert.match(ev.why, /default, reboot, rebuilds the machine/);
  assert.doesNotMatch(ev.why, /as in this run/);
  const cli = read("crates/macvmm/src/cli.rs");
  assert.match(cli, /--on-reset ACTION +reboot \(default/);
});

test("CPU_OFF of the last vCPU that is on: the run loop's warning and the idle VM", () => {
  const s = decodeHash("free.c2.ok.of0");
  assert.equal(s.free.acts.length, 1);
  const snap = snapshots(s)[1];
  assert.equal(snap.events[0].allOff, true);
  assert.match(snap.events[0].why, /idles until it is stopped \(--timeout or Ctrl-C\)/);
  assert.deepEqual(snap.stderr, ["macvmm: warn: [vcpu0] guest: vcpu0: CPU_OFF: every vCPU is now off; the VM idles until it is stopped"]);
  assert.match(read("crates/vmm/src/vcpu/run_loop.rs"), /CPU_OFF: every vCPU is now off; the VM idles until it is stopped/);
  // A pending vCPU is not off (psci::all_off): no warning.
  const p = snapshots(decodeHash("free.c2.ok.on0-1-40080000-0_of0"))[2];
  assert.equal(p.events[0].allOff, undefined);
  assert.deepEqual(p.stderr, []);
});

test("breakage 1: vCPU 0's row is flagged too, since another row claims 0x0", () => {
  const lk = lookups(makeMachine(2, "dup"));
  assert.equal(lk[0].ok, false);
  assert.match(lk[0].problems.join(" "), /1 other row of the power table also claims 0x0; the lookup \(index_of\) takes the first, this one/);
});

test("the default scenario is the simple one, and the select runs from simple to hard", () => {
  assert.equal(DEFAULT_SCENARIO, "linux");
  assert.equal(initialState().sc, "linux");
  assert.equal(encodeHash(decodeHash("linux@0")), null);
  assert.equal(encodeHash(decodeHash("race@0")), "race@0");
  assert.deepEqual([...SCENARIO_IDS], ["linux", "race", "paper", "dup", "reg", "free"]);
  for (const id of SCENARIO_IDS) assert.ok(scenarioLabel(id).length > 0);
  assert.match(summary(initialState(), snapshots(initialState())), /Press Step to start\./);
});

test("learner-visible text uses the lesson's words, not code spellings", () => {
  const texts = [];
  for (const id of SCENARIO_IDS.filter((x) => x !== "free")) {
    for (const s of runScenario(id)) {
      texts.push(...s.events.map(eventSentence), s.note || "");
      for (const v of s.m.vcpus) texts.push(...vcpuLines(v).map((l) => l.join(" ")));
    }
  }
  for (const t of texts) assert.doesNotMatch(t, /OnPending|secondary_entry/, t);
});
