// Tests for the lock-order model. The scenarios must behave as the `host-concurrency` primer
// says they do: deadlock.rs can deadlock (and, scheduled the way its barrier forces, always does),
// ordered.rs never can, the self-check's three-lock cycle exists and one swap removes it, park.rs
// survives early notifies and spurious wake-ups, and the loop-less wait sleeps forever after an
// early notify. The primer is parsed (deadlock.rs, ordered.rs, park.rs, lost.rs and the two
// self-checks the loop-less and three-lock scenarios come from) so the scripts cannot drift.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SCENARIOS, SCENARIO_IDS, REFERENCE, buildProgram, initialState, step, spurious, canStep,
  outcome, findCycle, describeCycle, explore, replay, parseSchedule, encodeShare, decodeShare,
  MAX_SCHEDULE,
} from "./model.mjs";

const primer = readFileSync(fileURLToPath(new URL("../../../../primers/host-concurrency.md", import.meta.url)), "utf8");
const lab = JSON.parse(readFileSync(fileURLToPath(new URL("./lab.json", import.meta.url)), "utf8"));

function run(id, schedule, swaps = []) {
  const p = buildProgram(id, swaps);
  const r = replay(p, parseSchedule(schedule, p.threads.length));
  assert.equal(r.actions.length, parseSchedule(schedule, p.threads.length).length, `whole schedule ${schedule} applies`);
  return { p, s: r.state, o: outcome(p, r.state) };
}

/** The Rust listing under a "`name.rs`" heading in the primer. */
function listing(name) {
  const i = primer.indexOf(`\`${name}\``);
  assert.ok(i >= 0, `${name} is in the primer`);
  const start = primer.indexOf("```rust", i);
  return primer.slice(start, primer.indexOf("```\n", start + 7));
}

test("lock scripts follow deadlock.rs and ordered.rs", () => {
  const dl = listing("deadlock.rs");
  assert.match(dl, /let _d = device\.lock\(\)\.unwrap\(\); \/\/ vCPU: device first[\s\S]*let _i = input\.lock\(\)\.unwrap\(\);[\s\S]*"vcpu got both"/);
  assert.match(dl, /let _i = input\.lock\(\)\.unwrap\(\); \/\/ stdin: input first[\s\S]*let _d = device\.lock\(\)\.unwrap\(\);[\s\S]*"stdin got both"/);
  assert.match(dl, /println!\("done"\)/);
  const ord = listing("ordered.rs");
  assert.match(ord, /stdin: device first too/);
  const p = buildProgram("deadlock");
  for (const [t, line] of [[0, "let _d = device.lock().unwrap();"], [1, "let _i = input.lock().unwrap();"]]) {
    assert.equal(p.threads[t].script[0].text, line);
    assert.ok(dl.includes(line));
  }
  assert.deepEqual(SCENARIOS.ordered.threads.map((t) => t.order), [["device", "input"], ["device", "input"]]);
});

test("condvar scripts follow park.rs: set under the lock, unlock, then notify", () => {
  const park = listing("park.rs");
  assert.match(park, /while !\*on \{/);
  assert.match(park, /\*powered_on\.lock\(\)\.unwrap\(\) = true; \/\/ change the state\.\.\./);
  assert.match(park, /wake\.notify_one\(\); \/\/ \.\.\.then ring the bell/);
  assert.match(park, /"secondary vCPU: powered on, running"/);
  assert.match(park, /"boot vCPU: start sent"/);
  const ops = buildProgram("park").threads[0].script.map((x) => x.op);
  assert.deepEqual(ops, ["lock", "set", "unlock", "notify", "print"]);
});

/** The answer text of the self-check whose question starts with `start`. */
function selfCheck(start) {
  const i = primer.indexOf(`:::predict ${start}`);
  assert.ok(i >= 0, `self-check "${start}" is in the primer`);
  return primer.slice(i, primer.indexOf("\n:::\n", i));
}

test("the three-lock scenario is the primer's self-check, and its fix is the self-check's rule", () => {
  const q = selfCheck("Thread 1 takes locks A then B.");
  assert.match(q, /Thread 1 takes locks A then B\. Thread 2 takes B then C\. Thread 3 takes C then A\./);
  assert.match(q, /Thread 3 then takes A before C/);
  assert.deepEqual(SCENARIOS.three.threads.map((t) => t.order), [["A", "B"], ["B", "C"], ["C", "A"]]);
  assert.deepEqual(SCENARIOS.three.locks, ["A", "B", "C"]);
  assert.deepEqual(buildProgram("three", [false, false, true]).threads[2].order, ["A", "C"]);
  assert.match(SCENARIOS.three.fix, /thread 3 so it takes A before C/);
});

test("the loop-less scenario is the self-check's single cv.wait, not the lost.rs listing", () => {
  const q = selfCheck("A thread does `let g = m.lock().unwrap(); let g = cv.wait(g).unwrap();` with no loop");
  assert.match(q, /A lost wake-up/);
  assert.match(q, /A spurious wake-up/);
  const sec = buildProgram("lost").threads[1].script;
  assert.deepEqual(sec.map((x) => x.op), ["lock", "wait", "print", "unlock"], "one wait, no check, no loop");
  assert.equal(sec.some((x) => /timeout/.test(x.text)), false);
  // lost.rs itself is a single thread that rings before it waits with a 2 s timeout; the lab
  // says so instead of pretending to be that listing.
  const lost = listing("lost.rs");
  assert.match(lost, /wake\.notify_one\(\);[\s\S]*wake\.wait_timeout\(guard, Duration::from_secs\(2\)\)/);
  assert.match(SCENARIOS.lost.summary, /self-check/);
  assert.match(SCENARIOS.lost.summary, /Unlike the primer's lost\.rs there is no timeout here/);
});

test("deadlock.rs scheduled like its barrier: deadlock after four steps, nothing printed", () => {
  const { p, s, o } = run("deadlock", "1212");
  assert.equal(o.kind, "deadlock");
  assert.deepEqual(s.output, []);
  assert.deepEqual(o.cycle.map((e) => [e.from, e.lock, e.to]), [[0, "input", 1], [1, "device", 0]]);
  assert.equal(
    describeCycle(p, o.cycle),
    "vCPU thread waits for input, held by stdin thread; stdin thread waits for device, held by vCPU thread. That is a cycle: none of them can ever move again.",
  );
  assert.equal(encodeShare({ scenario: "deadlock", swaps: [false, false], actions: parseSchedule("1212", 2) }), REFERENCE.deadlock);
});

test("one thread blocked is not yet a deadlock", () => {
  const { s, o } = run("deadlock", "121");
  assert.equal(o.kind, "running");
  assert.equal(s.threads[0].status, "lock");
  assert.equal(findCycle(buildProgram("deadlock"), s), null);
  assert.equal(canStep(buildProgram("deadlock"), s, 0), false);
  assert.throws(() => step(buildProgram("deadlock"), s, 0), /cannot step/);
});

test("a lucky schedule of deadlock.rs finishes and prints like the primer", () => {
  const { s, o } = run("deadlock", "1111122222");
  assert.equal(o.kind, "done");
  assert.deepEqual(s.output, ["vcpu got both", "stdin got both", "done"]);
});

test("unlock wakes a blocked thread, which then takes the lock", () => {
  const p = buildProgram("ordered");
  let s = replay(p, parseSchedule("12", 2)).state; // vCPU holds device, stdin asleep on it
  assert.equal(s.threads[1].status, "lock");
  s = replay(p, parseSchedule("121111", 2)).state;
  assert.equal(s.threads[0].status, "done");
  assert.equal(s.threads[1].status, "ready");
  s = step(p, s, 1);
  assert.equal(s.holder.device, 1);
});

test("exhaustive search: opposite orders can deadlock, one order never can", () => {
  const bad = explore(buildProgram("deadlock"));
  assert.ok(bad.complete);
  assert.deepEqual(bad.deadlock, ["1", "2", "1", "2"]);
  for (const prog of [buildProgram("ordered"), buildProgram("deadlock", [false, true]), buildProgram("deadlock", [true, false])]) {
    const r = explore(prog);
    assert.ok(r.complete);
    assert.equal(r.deadlock, null);
    assert.ok(r.done);
  }
  // Swapping both keeps the orders opposite (input first vs device first): still a deadlock.
  assert.ok(explore(buildProgram("deadlock", [true, true])).deadlock);
  assert.deepEqual(explore(buildProgram("ordered", [false, true])).deadlock, ["1", "2", "1", "2"]);
});

test("the self-check's three-lock cycle, and the increasing-order fix", () => {
  const r = explore(buildProgram("three"));
  assert.ok(r.deadlock);
  const { p, o } = run("three", r.deadlock.join(""));
  assert.equal(o.kind, "deadlock");
  assert.equal(o.cycle.length, 3);
  assert.match(describeCycle(p, o.cycle), /thread 1 waits for B, held by thread 2/);
  // Thread 3 takes A before C: every thread now takes locks in increasing order.
  const fixed = buildProgram("three", [false, false, true]);
  assert.deepEqual(fixed.threads[2].order, ["A", "C"]);
  assert.equal(explore(fixed).deadlock, null);
});

test("park.rs: no schedule, even with spurious wake-ups, runs early or sleeps forever", () => {
  const r = explore(buildProgram("park"), { spuriousWakeups: true });
  assert.ok(r.complete);
  assert.equal(r.violation, null);
  assert.equal(r.forever, null);
  assert.equal(r.deadlock, null);
  // An early notify is harmless: the loop sees powered_on already true and never waits.
  const { s, o } = run("park", "11111" + "2222");
  assert.equal(o.kind, "done");
  assert.equal(s.lostNotifies, 1);
  assert.deepEqual(s.output, ["boot vCPU: start sent", "secondary vCPU: powered on, running"]);
  // A spurious wake-up goes round the loop and waits again.
  const sp = run("park", "222w22");
  assert.equal(sp.s.threads[1].pc, 1, "wait returned to the while check");
  const again = step(sp.p, sp.s, 1);
  assert.equal(again.threads[1].pc, 2, "powered_on still false: back to wait");
  assert.equal(step(sp.p, again, 1).threads[1].status, "cv");
});

test("park.rs: both output orders are possible", () => {
  assert.deepEqual(run("park", "222" + "1111" + "222" + "1").s.output, ["secondary vCPU: powered on, running", "boot vCPU: start sent"]);
  assert.deepEqual(run("park", "222" + "11111" + "222").s.output, ["boot vCPU: start sent", "secondary vCPU: powered on, running"]);
});

test("wait without a loop: an early notify is lost and the waiter sleeps forever", () => {
  const { s, o } = run("lost", "1111122");
  assert.equal(o.kind, "forever");
  assert.equal(o.thread, 1);
  assert.equal(s.lostNotifies, 1);
  assert.deepEqual(s.output, ["boot vCPU: start sent"]);
  assert.equal(encodeShare({ scenario: "lost", swaps: [false, false], actions: parseSchedule("1111122", 2) }), REFERENCE.lostWakeup);
  const r = explore(buildProgram("lost"));
  assert.deepEqual(r.forever, ["1", "1", "1", "1", "1", "2", "2"]);
  assert.equal(r.violation, null, "without spurious wake-ups the loop-less version never runs early");
});

test("wait without a loop: a spurious wake-up runs the secondary before powered_on", () => {
  const { s, o } = run("lost", "22w222");
  assert.ok(o.violation);
  assert.equal(o.violation.text, "secondary vCPU ran before powered_on was true");
  assert.equal(s.flag, false);
  assert.equal(encodeShare({ scenario: "lost", swaps: [false, false], actions: parseSchedule("22w222", 2) }), REFERENCE.spurious);
  assert.deepEqual(explore(buildProgram("lost"), { spuriousWakeups: true }).violation, ["2", "2", "w2", "2", "2"]);
});

test("a woken waiter that finds the lock held sleeps on it, then retries", () => {
  const p = buildProgram("lost");
  // secondary: lock, wait; boot: lock (taken), then a spurious wake-up while boot holds the lock.
  let s = replay(p, parseSchedule("221w2", 2)).state;
  s = step(p, s, 1);
  assert.equal(s.threads[1].status, "lock");
  assert.equal(s.threads[1].woken, true);
  s = step(p, step(p, s, 0), 0); // boot sets the flag and unlocks
  assert.equal(s.threads[1].status, "ready");
  s = step(p, s, 1);
  assert.equal(s.holder.powered_on, 1);
  assert.equal(s.threads[1].pc, 2);
});

test("step and spurious never mutate their input", () => {
  const p = buildProgram("lost");
  const s0 = replay(p, parseSchedule("22", 2)).state;
  const snap = JSON.stringify(s0);
  step(p, s0, 0);
  spurious(p, s0, 1);
  assert.equal(JSON.stringify(s0), snap);
  assert.throws(() => spurious(p, initialState(p), 1), /not waiting/);
  assert.throws(() => step(p, s0, 5), /no thread/);
});

test("share strings round-trip and hostile ones are rejected or cut", () => {
  for (const ref of Object.values(REFERENCE)) {
    const d = decodeShare(ref);
    assert.ok(d, ref);
    assert.equal(encodeShare(d), ref);
  }
  assert.equal(decodeShare(null), null);
  assert.equal(decodeShare("nope.00.1"), null);
  assert.equal(decodeShare("deadlock.000.1"), null);
  assert.equal(decodeShare("deadlock.00.13"), null);
  assert.equal(decodeShare("deadlock.00.w"), null);
  assert.equal(decodeShare("__proto__.00."), null);
  assert.equal(decodeShare("deadlock.00." + "1".repeat(MAX_SCHEDULE * 2 + 1)), null);
  // Actions that are not allowed cut the schedule (thread 1 finishes after five steps).
  assert.equal(decodeShare("deadlock.00.1111111").actions.length, 5);
  assert.equal(encodeShare(decodeShare("deadlock.00.1212222")), REFERENCE.deadlock);
  // Swaps only mean something for lock scenarios.
  assert.deepEqual(decodeShare("park.11.").swaps, [false, false]);
  assert.deepEqual(decodeShare("deadlock.01.").swaps, [false, true]);
});

test("lab.json quotes the model's numbers", () => {
  assert.deepEqual(lab.reference, REFERENCE);
  for (const id of SCENARIO_IDS) {
    const r = explore(buildProgram(id), { spuriousWakeups: SCENARIOS[id].kind === "condvar" });
    assert.equal(lab.states[id], r.states, id);
  }
});
