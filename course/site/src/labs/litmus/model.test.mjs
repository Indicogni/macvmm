// Tests for the litmus model. Run with: node --test 'course/site/**/*.test.mjs'
//
// The primer (course/primers/memory-ordering.md) is the spec: its litmus.rs modes, its quoted
// counts and its claims about which zeros are luck are re-read from the Markdown here, so the
// lab cannot drift from the lesson. The virtqueue presets are checked against
// crates/vmm/src/virtio/queue.rs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TESTS, TEST_IDS, PRESETS, MEASURED, MACHINE_IDS, STORE_ORDS, LOAD_ORDS, FENCE_KINDS,
  buildProgram, initialState, enabledActions, apply, replay, explore, blockers, rulesVerdict,
  verdict, exerciseTable, encodeShare, decodeShare, validOrds, asmText, rustText, presetsOf,
  measurementsOf, describeAction, outcomeText, isFinal,
} from "./model.mjs";

const repo = (p) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const primer = readFileSync(repo("course/primers/memory-ordering.md"), "utf8");
const chapter16 = readFileSync(repo("course/chapters/VII/16-virtqueues.md"), "utf8");
const lab = JSON.parse(readFileSync(fileURLToPath(new URL("./lab.json", import.meta.url)), "utf8"));

test("every count the primer quotes is in MEASURED, and nothing else is", () => {
  const quoted = new Map();
  for (const m of primer.matchAll(/```text\n\s*(sb|mp) (relaxed|acqrel|seqcst|fence): (\d+) of (\d+) runs\n\s*```/g)) {
    const key = `${m[1]}.${m[2]}`;
    const prev = quoted.get(key);
    const val = { hits: Number(m[3]), of: Number(m[4]) };
    if (prev) assert.deepEqual(prev, val, `${key} quoted twice with different numbers`);
    quoted.set(key, val);
  }
  assert.equal(quoted.size, 6, "the primer quotes six of the eight combinations");
  assert.deepEqual([...quoted.keys()].sort(), Object.keys(MEASURED).sort());
  for (const [k, v] of quoted) {
    assert.equal(MEASURED[k].hits, v.hits, k);
    assert.equal(MEASURED[k].of, v.of, k);
  }
  // The front matter's expect line agrees too.
  assert.match(primer, /^expect: sb fence: 0 of 2000000 runs$/m);
  // The side notes the lab repeats are in the primer.
  assert.match(primer, /about 1\.39 million/);
  assert.match(primer, /20 runs out of 20/);
  assert.match(primer, /4 times in 26 million rounds/);
});

test("presets are exactly litmus.rs's modes", () => {
  // main(): the mode table.
  assert.match(primer, /"relaxed" => \(Relaxed, Relaxed\),/);
  assert.match(primer, /"seqcst" => \(SeqCst, SeqCst\),/);
  assert.match(primer, /_ => \(Release, Acquire\),/);
  assert.match(primer, /full_fence: mode == "fence"/);
  // thread_a / thread_b: sb uses st, optional fence, ld; mp ignores the fence.
  assert.match(primer, /X\.store\(1, m\.st\);\s*if m\.full_fence \{\s*fence\(SeqCst\);\s*\}\s*Y\.load\(m\.ld\)/);
  assert.match(primer, /Y\.store\(1, m\.st\);\s*if m\.full_fence \{\s*fence\(SeqCst\);\s*\}\s*X\.load\(m\.ld\)/);
  assert.match(primer, /X\.store\(1, Relaxed\); \/\/ mp: write the data\.\.\.\s*Y\.store\(1, m\.st\);/);
  assert.match(primer, /let flag = Y\.load\(m\.ld\);[^\n]*\n\s*flag \* 10 \+ X\.load\(Relaxed\)/);
  assert.match(primer, /const N: usize = 2_000_000;/);

  const modes = { relaxed: ["r", "r", false], acqrel: ["l", "a", false], seqcst: ["s", "s", false], fence: ["l", "a", true] };
  for (const [id, [st, ld, ff]] of Object.entries(modes)) {
    const sb = PRESETS.sb.find((p) => p.id === id);
    const f = ff ? "s" : "n";
    assert.deepEqual(sb.ords, [`${st}${f}${ld}`, `${st}${f}${ld}`], `sb ${id}`);
    const mp = PRESETS.mp.find((p) => p.id === id);
    assert.deepEqual(mp.ords, [`rn${st}`, `${ld}nr`], `mp ${id}`);
  }
});

test("the exercise table matches the primer: which zeros are luck", () => {
  const rows = Object.fromEntries(exerciseTable().map((r) => [`${r.test}.${r.mode}`, r]));
  const expect = {
    "sb.relaxed": [true, true, false],
    "sb.acqrel": [true, true, true],
    "sb.seqcst": [false, false, false],
    "sb.fence": [false, false, false],
    "mp.relaxed": [true, true, true],
    "mp.acqrel": [false, false, false],
    "mp.seqcst": [false, false, false],
    "mp.fence": [false, false, false],
  };
  for (const [k, [arm, rules, fools]] of Object.entries(expect)) {
    assert.equal(rows[k].armAllows, arm, `${k} arm64`);
    assert.equal(rows[k].rulesAllow, rules, `${k} rules`);
    assert.equal(rows[k].fools, fools, `${k} fools`);
  }
  // "You now have three zeros from sb (acqrel, seqcst, fence) ... One is luck and two are guarantees."
  assert.match(primer, /three zeros from `sb` \(`acqrel`, `seqcst`, `fence`\)/);
  const sbZeros = ["sb.acqrel", "sb.seqcst", "sb.fence"].map((k) => rows[k]);
  assert.equal(sbZeros.filter((r) => r.rulesAllow).length, 1);
  assert.equal(sbZeros.filter((r) => !r.rulesAllow).length, 2);
  // mp seqcst and mp fence are not quoted, so the table says so rather than invent a number.
  assert.equal(rows["mp.seqcst"].measured, null);
  assert.equal(rows["mp.fence"].measured, null);
});

test("verdicts for every preset on every machine", () => {
  // [arm64 allows, x86-64 allows, paper allows, rules forbid]
  const expect = {
    "sb.relaxed": [true, true, false, false],
    "sb.acqrel": [true, true, false, false],
    "sb.seqcst": [false, false, false, true],
    "sb.fence": [false, false, false, true],
    "mp.relaxed": [true, false, false, false],
    "mp.acqrel": [false, false, false, true],
    "mp.seqcst": [false, false, false, true],
    "mp.fence": [false, false, false, true],
    "lw.macvmm": [false, false, false, true],
    "lw.nofence": [true, true, false, false],
    "lw.acquire": [true, true, false, false],
    "lw.seqcst": [false, false, false, true],
    "used.macvmm": [false, false, false, true],
    "used.norelease": [true, false, false, false],
    "used.normb": [true, false, false, false],
  };
  for (const t of TEST_IDS) {
    for (const p of PRESETS[t]) {
      const prog = buildProgram(t, p.ords);
      const got = [...MACHINE_IDS.map((m) => explore(prog, m).badAllowed), rulesVerdict(prog).forbidden];
      assert.deepEqual(got, expect[`${t}.${p.id}`], `${t}.${p.id}`);
    }
  }
});

test("outcome sets: sb has the 'impossible' fourth outcome on arm64 and x86-64 only", () => {
  const prog = buildProgram("sb", ["rnr", "rnr"]);
  const keys = (m) => explore(prog, m).outcomes.map((o) => o.key);
  assert.deepEqual(keys("sc"), ["r1=0 r2=1", "r1=1 r2=0", "r1=1 r2=1"]);
  assert.deepEqual(keys("arm"), ["r1=0 r2=0", "r1=0 r2=1", "r1=1 r2=0", "r1=1 r2=1"]);
  assert.deepEqual(keys("tso"), keys("arm"));
  for (const m of MACHINE_IDS) assert.equal(explore(prog, m).outcomes.length, lab.outcomes["sb.relaxed"][m]);
  const mp = buildProgram("mp", ["rnr", "rnr"]);
  for (const m of MACHINE_IDS) assert.equal(explore(mp, m).outcomes.length, lab.outcomes["mp.relaxed"][m]);
  const bad = explore(mp, "arm").outcomes.find((o) => o.bad);
  assert.equal(outcomeText(mp, bad.regs), "flag = 1, data = 0");
});

test("every witness schedule replays to its outcome", () => {
  for (const t of TEST_IDS) {
    for (const p of PRESETS[t]) {
      const prog = buildProgram(t, p.ords);
      for (const m of MACHINE_IDS) {
        for (const o of explore(prog, m).outcomes) {
          const r = replay(prog, m, o.witness);
          assert.equal(r.stoppedAt, null);
          assert.ok(isFinal(r.state));
          assert.deepEqual(r.state.regs, o.regs, `${t}.${p.id} ${m} ${o.key}`);
        }
      }
    }
  }
});

function allOrds(test, t) {
  const ops = TESTS[test].threads[t].ops;
  const a = ops[0].op === "st" ? STORE_ORDS : LOAD_ORDS;
  const b = ops[1].op === "st" ? STORE_ORDS : LOAD_ORDS;
  const out = [];
  for (const x of a) for (const f of FENCE_KINDS) for (const y of b) out.push(x + f + y);
  return out;
}

test("soundness over every ordering combination: what the rules forbid, no machine produces", () => {
  let combos = 0, hardwareOnly = 0;
  for (const t of TEST_IDS) {
    for (const a of allOrds(t, 0)) {
      for (const b of allOrds(t, 1)) {
        const prog = buildProgram(t, [a, b]);
        const ex = Object.fromEntries(MACHINE_IDS.map((m) => [m, explore(prog, m)]));
        const rules = rulesVerdict(prog);
        combos++;
        assert.equal(ex.sc.badAllowed, false, `${t} ${a} ${b}: interleavings never give the bad outcome`);
        if (rules.forbidden) {
          assert.equal(ex.arm.badAllowed, false, `${t} ${a} ${b}: rules forbid but arm64 allows`);
          assert.equal(ex.tso.badAllowed, false, `${t} ${a} ${b}: rules forbid but x86-64 allows`);
        }
        // Every machine can produce every interleaving outcome.
        const scKeys = new Set(ex.sc.outcomes.map((o) => o.key));
        for (const m of ["arm", "tso"]) {
          const keys = new Set(ex[m].outcomes.map((o) => o.key));
          for (const k of scKeys) assert.ok(keys.has(k), `${t} ${a} ${b}: ${m} lacks ${k}`);
        }
        if (!rules.forbidden && !ex.arm.badAllowed) hardwareOnly++;
        if (ex.arm.states > 200) assert.fail(`${t} ${a} ${b}: ${ex.arm.states} states`);
      }
    }
  }
  assert.equal(combos, 4 * 36 * 36); // 3 orderings x 4 fences x 3 orderings per thread
  assert.ok(hardwareOnly > 0, "some combinations are safe on arm64 only by accident of the instructions");
});

test("the arm64 rules that the primer teaches, one by one", () => {
  // sb with Release store then SeqCst load: stlr then ldar, which arm64 orders, but Rust does not
  // promise it (both threads need SeqCst on both accesses, or a fence).
  const p = buildProgram("sb", ["lns", "lns"]);
  const v = verdict(p, "arm");
  assert.equal(v.machineAllows, false);
  assert.equal(v.rules.forbidden, false);
  assert.equal(v.kind, "hardware-only");
  assert.equal(explore(p, "tso").badAllowed, true, "x86-64 compiles both to mov, so the store buffer shows");
  // One thread fenced is not enough.
  assert.equal(explore(buildProgram("sb", ["rsr", "rnr"]), "arm").badAllowed, true);
  // An acquire fence between a store and a load does not order them.
  assert.equal(explore(buildProgram("sb", ["rar", "rar"]), "arm").badAllowed, true);
  // mp: a release without its acquire, and an acquire without its release, both fail on arm64.
  assert.equal(explore(buildProgram("mp", ["rnl", "rnr"]), "arm").badAllowed, true);
  assert.equal(explore(buildProgram("mp", ["rnr", "anr"]), "arm").badAllowed, true);
  // Fence pairs: release fence + acquire fence.
  const fp = buildProgram("mp", ["rlr", "rar"]);
  assert.equal(explore(fp, "arm").badAllowed, false);
  assert.equal(rulesVerdict(fp).forbidden, true);
});

test("blockers explain why a slot waits", () => {
  const p = buildProgram("sb", ["sns", "sns"]);
  let st = apply(p, "arm", initialState(p), "a0").state;
  assert.equal(st.status[0][0], "buffered");
  assert.deepEqual(blockers(p, "arm", st, 0, 2).map((b) => b.why), ["ldar never runs before an earlier stlr has reached memory"]);
  assert.ok(!enabledActions(p, "arm", st).some((a) => a.code === "a2"));
  st = apply(p, "arm", st, "A0").state;
  assert.ok(enabledActions(p, "arm", st).some((a) => a.code === "a2"));

  const q = buildProgram("sb", ["lna", "lna"]);
  const s2 = apply(q, "arm", initialState(q), "a0").state;
  assert.deepEqual(blockers(q, "arm", s2, 0, 2), [], "ldapr may run while the stlr waits in the buffer");
  assert.equal(describeAction(q, "arm", s2, "a2"), "Thread A: let r1 = Y.load(Acquire), reads 0 from memory");

  const t = buildProgram("sb", ["rsr", "rnr"]);
  const s3 = apply(t, "tso", initialState(t), "a0").state;
  assert.match(blockers(t, "tso", s3, 0, 1)[0].why, /mfence waits until the store buffer is empty/);

  // In-order machines: a later slot waits for program order.
  const s4 = initialState(t);
  assert.match(blockers(t, "sc", s4, 0, 2)[0].why, /program order/);
});

test("a load reads its own store buffer first; x86 drains first in, first out", () => {
  // mp writer on x86: two buffered stores drain in order only.
  const p = buildProgram("mp", ["rnr", "rnr"]);
  let st = apply(p, "tso", initialState(p), "a0").state;
  st = apply(p, "tso", st, "a2").state;
  assert.deepEqual(enabledActions(p, "tso", st).filter((a) => a.kind === "drain").map((a) => a.code), ["A0"]);
  const sa = replay(p, "arm", ["a0", "a2"]).state;
  assert.deepEqual(enabledActions(p, "arm", sa).filter((a) => a.kind === "drain").map((a) => a.code), ["A0", "A2"]);
  assert.equal(apply(p, "arm", sa, "zz").ok, false);
});

test("instruction names match what the primer's ord.rs listing shows", () => {
  const p = buildProgram("sb", ["lsa", "sns"]);
  const [a, b] = p.threads;
  assert.deepEqual(a.slots.map((s) => asmText("arm", s)), ["stlr", "dmb ish", "ldapr"]);
  assert.deepEqual([asmText("arm", b.slots[0]), asmText("arm", b.slots[2])], ["stlr", "ldar"]);
  assert.equal(asmText("arm", { op: "fence", kind: "a" }), "dmb ishld");
  assert.equal(asmText("arm", { op: "fence", kind: "l" }), "dmb ish");
  assert.equal(asmText("arm", { op: "ld", ord: "r" }), "ldr");
  for (const ins of ["dmb\tishld", "dmb\tish", "ldaprh", "ldrh", "ldarh", "stlrh"]) assert.ok(primer.includes(ins), ins);
  assert.equal(rustText(a.slots[0]), "X.store(1, Release)");
  assert.equal(rustText(a.slots[2]), "let r1 = Y.load(Acquire)");
  assert.equal(asmText("tso", b.slots[0]), "xchg");
});

test("virtqueue presets mirror macvmm's queue.rs and chapter 16", () => {
  const q = readFileSync(repo("crates/vmm/src/virtio/queue.rs"), "utf8");
  const should = q.slice(q.indexOf("ANCHOR: queue_should_interrupt"), q.indexOf("ANCHOR_END: queue_should_interrupt"));
  assert.ok(should.indexOf("fence_seq_cst()") < should.indexOf("read_obj::<u16>(self.avail_ring)"), "fence before the avail.flags read");
  assert.ok(!/read_u16_acquire/.test(should), "avail.flags is a plain read");
  const used = q.slice(q.indexOf("ANCHOR: queue_add_used"), q.indexOf("ANCHOR_END: queue_add_used"));
  assert.ok(used.indexOf("mem.write(") < used.indexOf("write_u16_release("), "element, then release store of used.idx");
  assert.deepEqual(PRESETS.lw.find((p) => p.id === "macvmm").ords[0], "lsr");
  assert.deepEqual(PRESETS.used.find((p) => p.id === "macvmm").ords[0], "rnl");
  // Chapter 16: "an x86 PC never reorders two stores in hardware, so there this bug cannot happen at all".
  assert.match(chapter16, /an x86 PC never reorders two stores in hardware/);
  const broken = buildProgram("used", PRESETS.used.find((p) => p.id === "norelease").ords);
  assert.equal(explore(broken, "tso").badAllowed, false);
  assert.equal(explore(broken, "arm").badAllowed, true);
  assert.match(chapter16, /^:::lab litmus$/m);
  assert.match(primer, /^:::lab litmus$/m);
});

test("measurements are only attached to the exact litmus.rs programs", () => {
  const mpAcq = buildProgram("mp", ["rnl", "anr"]);
  assert.deepEqual(presetsOf(mpAcq).map((p) => p.id), ["acqrel", "fence"]);
  const ms = measurementsOf(mpAcq);
  assert.equal(ms[0].m.hits, 0);
  assert.equal(ms[1].m, null, "mp fence is not quoted");
  assert.deepEqual(measurementsOf(buildProgram("sb", ["rnr", "lna"])), []);
  assert.deepEqual(measurementsOf(buildProgram("lw", ["lsr", "rsr"])), []);
});

test("share state: reference, round trip, default clears", () => {
  const d = decodeShare(lab.reference);
  assert.deepEqual(d, { test: "sb", machine: "arm", ords: ["rnr", "rnr"], schedule: ["a0", "b0", "a2", "b2"] });
  const st = replay(buildProgram(d.test, d.ords), d.machine, d.schedule).state;
  assert.deepEqual(st.regs, { r1: 0, r2: 0 });
  assert.deepEqual(st.buffers.map((b) => b.length), [1, 1], "both stores still queued");
  assert.equal(encodeShare(d), lab.reference);
  assert.equal(encodeShare({ test: "sb", machine: "arm", ords: ["rnr", "rnr"], schedule: [] }), null);
  assert.equal(encodeShare({ test: "used", machine: "tso", ords: ["rnr", "rar"], schedule: [] }), "used.tso.rnr.rar");
});

test("share state: hostile strings are refused or cut", () => {
  for (const bad of [null, 42, "", "<script>", "sb.arm.rnr", "xx.arm.rnr.rnr", "sb.ppc.rnr.rnr", "sb.arm.ana.rnr",
    "mp.arm.anr.rnr", "sb.arm.rnr.rnr.a9", "sb.arm.rnr.rnr.a0b0a2b2a0b0a2b2a0b0a2", "constructor.arm.rnr.rnr",
    "sb.arm.rnr.rnr." + "a0".repeat(40), "sb.arm.RNR.rnr"]) {
    assert.equal(decodeShare(bad), null, String(bad));
  }
  // A schedule step that is not allowed cuts the replay there.
  assert.deepEqual(decodeShare("sb.sc.rnr.rnr.a2a0").schedule, [], "sc runs in program order");
  assert.deepEqual(decodeShare("sb.arm.sns.sns.a0a2").schedule, ["a0"], "ldar waits for the stlr");
  assert.equal(validOrds("sb", 0, "lsa"), true);
  assert.equal(validOrds("mp", 1, "lnr"), false, "a load cannot be Release");
  assert.throws(() => buildProgram("toString", ["rnr", "rnr"]));
  assert.throws(() => buildProgram("sb", ["rnr"]));
});
