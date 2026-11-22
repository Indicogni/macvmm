// Tests for the durability-ladder model. Run: node --test 'course/site/**/*.test.mjs'
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RUNGS, BLOCKS, SYNCS, FAILURES, MEASURED, MOVED_BY, MAX_ACTIONS, PRESETS, REFERENCE, VERDICTS,
  scriptFor, initialState, replay, step, canDo, summary, encode, decode, recover, ladder,
  failureTable, isToken, survivalLines, spoken,
} from "./model.mjs";

const repo = (p) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));
const read = (p) => readFileSync(repo(p), "utf8");
const PRIMER = "course/primers/block-storage.md";
const CH18 = "course/chapters/VII/18-virtio-blk.md";

const run = (hash) => {
  const s = decode(hash);
  assert.ok(s, `decodes ${hash}`);
  return replay(s);
};

// ---- the course text ---------------------------------------------------------------------

/** The primer's ASCII ladder: the ```text block after "## The durability ladder". */
function primerLadder() {
  const src = read(PRIMER);
  const at = src.indexOf("## The durability ladder");
  assert.ok(at >= 0);
  const m = /```text\n([\s\S]*?)\n```/.exec(src.slice(at));
  assert.ok(m, "the primer draws the ladder");
  return m[1].split("\n");
}

test("the five rungs are the primer's five rungs, in order", () => {
  const lines = primerLadder();
  const rungLines = lines.filter((l) => /^\s*\[\d\]/.test(l));
  assert.equal(rungLines.length, 5);
  const primerNames = ["guest page cache", "request in flight in VMM", "host page cache", "SSD's volatile cache", "flash"];
  rungLines.forEach((l, i) => {
    assert.match(l, new RegExp(`^\\s*\\[${i + 1}\\] ${primerNames[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), l);
    assert.equal(RUNGS[i].n, i + 1);
    // Our display names say the same thing (in the VMM / in VMM).
    assert.equal(RUNGS[i].name.toLowerCase().replace("in the vmm", "in vmm"), primerNames[i].toLowerCase());
  });
});

test("which failure wipes which rung matches the primer's ladder and its paragraph", () => {
  const lines = primerLadder().filter((l) => /^\s*\[\d\]/.test(l));
  // The ladder's margin notes: rung 1 lost on a guest crash, rung 3 on a macOS crash or power,
  // rung 4 on power only, rung 5 survives.
  assert.match(lines[0], /lost if the guest kernel crashes/);
  assert.match(lines[2], /lost if macOS crashes or power fails/);
  assert.match(lines[3], /lost if power fails/);
  assert.match(lines[4], /survives/);
  const byId = Object.fromEntries(FAILURES.map((f) => [f.id, f.loses]));
  assert.deepEqual(byId, { g: 1, k: 2, m: 3, p: 4 });
  const src = read(PRIMER);
  assert.match(src, /A guest kernel panic loses rung 1 only/);
  assert.match(src, /rung 1 and any request\s+still at rung 2 are gone/);
  assert.match(src, /A host\s+crash loses rung 3; only a power loss also loses rung 4/);
  // The table the lab draws.
  assert.deepEqual(failureTable().map((r) => r.cells.join(",")), [
    "lost,survives,survives,survives,survives",
    "lost,lost,survives,survives,survives",
    "lost,lost,lost,survives,survives",
    "lost,lost,lost,lost,survives",
  ]);
  assert.equal(MOVED_BY.length, 5);
});

test("the primer and chapter 18 embed the lab and list it in their front matter", () => {
  for (const p of [PRIMER, CH18]) {
    const src = read(p);
    const fm = src.split("\n---")[0];
    assert.match(fm, /^labs: \[.*\bdurability-ladder\b.*\]$/m, p);
    assert.match(src, /^:::lab durability-ladder$/m, p);
  }
});

test("chapter 18's lab fallback is what the model does", () => {
  const src = read(CH18);
  assert.match(src, /a killed process loses nothing that reached the page cache; a power cut loses everything not yet on the drive's permanent storage, including what plain `fsync` left in the drive's cache/);
  // "A killed process loses nothing that reached the page cache": in every sync mode.
  for (const s of ["full", "fsync", "none"]) assert.equal(run(`f.${s}.n8_xk`).outcome.verdict, "ok");
  // "Including what plain fsync left in the drive's cache".
  assert.equal(run("f.fsync.n8_xp").outcome.verdict, "lost");
  assert.equal(run("f.full.n8_xp").outcome.verdict, "ok");
});

test("measured costs are the captures' real lines", () => {
  for (const s of SYNCS) {
    const m = MEASURED[s.id];
    const cap = read(`course/captures/${m.capture}`);
    const reals = [...cap.matchAll(/^real\t0m (\d+\.\d+)s/gm)].map((x) => x[1]);
    assert.deepEqual(reals, [m.bulk, m.hundred], m.capture);
  }
  // Chapter 18 quotes the same numbers.
  assert.match(read(CH18), /took 0\.47 s with `F_FULLFSYNC`, 0\.08 s with `fsync` and 0\.04 s with nothing/);
});

test("the kill -9 preset quotes the real capture", () => {
  const p = PRESETS.find((x) => x.id === "noop-kill");
  const cap = read(`course/captures/${p.real.capture}`);
  assert.ok(cap.split("\n").includes(p.real.quote), "quote is a line of the capture");
  assert.match(read(CH18), /captures\/18-kill9-after\.txt/);
});

test("the VMM's sync is F_FULLFSYNC in the reference, and write-through syncs every OUT", () => {
  assert.match(read("crates/vmm/src/backend/file.rs"), /fn sync\(&self\) -> io::Result<\(\)> \{\s*self\.file\.sync_all\(\)/);
  const blk = read("crates/vmm/src/virtio/blk.rs");
  assert.match(blk, /if !self\.writeback \{\s*self\.sync\(\)/);
});

// ---- the script --------------------------------------------------------------------------

test("FLUSH offered: eight steps, OUT data and journal, FLUSH, OUT commit, FLUSH", () => {
  const ids = scriptFor(true).map((s) => s.id);
  assert.deepEqual(ids, ["write", "send1", "pwrite1", "flush1", "send2", "pwrite2", "flush2", "return"]);
  const r = run("f.full.n8");
  assert.deepEqual(r.world.levels, { d: 5, j: 5, c: 5, m: 1 });
  assert.equal(r.world.syncs, 2);
  assert.equal(r.world.acked, true);
  assert.equal(r.next, null);
});

test("write-through: six steps, one sync per OUT", () => {
  assert.deepEqual(scriptFor(false).map((s) => s.id), ["write", "send1", "pwrite1", "send2", "pwrite2", "return"]);
  const r = run("w.full.n6");
  assert.deepEqual(r.world.levels, { d: 5, j: 5, c: 5, m: 1 });
  assert.equal(r.world.syncs, 3);
});

test("where each block sits after each step, per sync mode", () => {
  const at = (hash) => { const l = run(hash).world.levels; return `${l.d}${l.j}${l.c}`; };
  assert.equal(at("f.full.n1"), "100");
  assert.equal(at("f.full.n2"), "220");
  assert.equal(at("f.full.n3"), "330");
  assert.equal(at("f.full.n4"), "550");
  assert.equal(at("f.fsync.n4"), "440");
  assert.equal(at("f.none.n4"), "330");
  assert.equal(at("f.full.n5"), "552");
  assert.equal(at("f.full.n6"), "553");
  assert.equal(at("f.fsync.n7"), "444");
  assert.equal(at("f.none.n8"), "333");
  // F_FULLFSYNC empties the drive cache too, not only this file's dirty pages.
  assert.equal(at("f.full.n3_hd_n1"), "550");
  assert.equal(ladder(run("f.fsync.n4").world)[4].join(""), "dj");
});

test("each preset ends where its story says", () => {
  const want = {
    "honest-power": "ok", "fsync-power": "lost", "fsync-reorder": "corrupt", "fsync-stale": "stale",
    "noop-kill": "ok", "noop-host": "corrupt", "kill-midway": "old", "write-through": "ok",
  };
  assert.deepEqual(PRESETS.map((p) => p.id).sort(), Object.keys(want).sort());
  for (const p of PRESETS) {
    const r = run(p.hash);
    assert.equal(r.refused, -1);
    assert.equal(r.outcome.verdict, want[p.id], p.id);
    assert.equal(encode(decode(p.hash)), p.hash, "canonical");
  }
  assert.equal(REFERENCE, "f.fsync.n8_dc_xp");
  assert.equal(run("f.full.n5_xk").world.acked, false);
});

test("refusals: background writeback needs the block on that rung; nothing after a failure", () => {
  const s = decode("f.fsync.n4");
  assert.equal(canDo(s, "hd"), false, "already in the drive cache");
  assert.equal(canDo(s, "dd"), true);
  assert.equal(canDo(s, "dc"), false, "commit record not written yet");
  assert.equal(canDo(decode("f.none.n3"), "hd"), true);
  assert.equal(canDo(decode("f.full.n8"), "n"), false, "script finished");
  const dead = decode("f.full.n2_xk");
  for (const t of ["n", "xp", "hd", "dd"]) assert.equal(canDo(dead, t), false);
  assert.equal(step(dead, { type: "do", token: "n" }), dead);
});

test("guest crash right after write(): no transaction exists yet", () => {
  const r = run("f.full.n1_xg");
  assert.equal(r.outcome.verdict, "old");
  assert.match(r.outcome.text, /^Nothing had reached the disk/);
  assert.doesNotMatch(r.outcome.text, /transaction/);
});

test("the inode in place is explained by the verdict, and the spoken text is short", () => {
  const line = (h) => { const r = run(h); return survivalLines(r.world, r.outcome).find((l) => l.id === "m").text; };
  assert.equal(line("f.full.n8_xp"), "inode in place: lost, rebuilt from the journal entry");
  assert.equal(line("f.fsync.n8_dj_dc_xp"), "inode in place: lost, rebuilt from the journal entry");
  assert.equal(line("f.fsync.n8_xp"), "inode in place: lost (the old one on disk is still valid)");
  assert.match(line(REFERENCE), /may overwrite the old one/);
  assert.equal(spoken(decode(REFERENCE)), 'Power lost. Inconsistent: commit record without its journal entry. Details in "What the guest finds".');
  assert.equal(spoken(decode("f.full.n2")), summary(decode("f.full.n2")));
  assert.match(run(REFERENCE).outcome.text, /detects the bad block and stops with an error/);
});

test("failure before anything was written", () => {
  const r = run("f.full.xp");
  assert.equal(r.outcome.verdict, "old");
  assert.match(r.outcome.text, /Nothing had been written yet/);
});

// ---- exhaustive: every schedule ----------------------------------------------------------

/** Every reachable terminal (failed) state for one config: depth-first over all tokens. */
function allEndings(flush, sync) {
  const tokens = ["n", "hd", "hj", "hc", "dd", "dj", "dc"];
  const out = [];
  const seen = new Set();
  const walk = (actions) => {
    const key = JSON.stringify(replay({ flush, sync, actions }).world);
    if (seen.has(key)) return;
    seen.add(key);
    for (const f of ["g", "k", "m", "p"]) {
      const st = { flush, sync, actions: [...actions, `x${f}`] };
      const r = replay(st);
      out.push({ st, r });
    }
    for (const t of tokens) {
      const st = { flush, sync, actions };
      if (canDo(st, t)) walk([...actions, t]);
    }
  };
  walk([]);
  return out;
}

test("F_FULLFSYNC: no schedule and no failure ever breaks the file system or loses a promised write", () => {
  for (const flush of [true, false]) {
    const ends = allEndings(flush, "full");
    assert.ok(ends.length >= 20, `${ends.length} endings`);
    for (const { st, r } of ends) assert.ok(["ok", "old"].includes(r.outcome.verdict), encode(st));
  }
});

test("a process kill or a guest crash never hurts, whatever the VMM's sync does", () => {
  for (const flush of [true, false]) {
    for (const sync of ["full", "fsync", "none"]) {
      for (const { st, r } of allEndings(flush, sync)) {
        if (["g", "k"].includes(r.world.failed)) assert.ok(["ok", "old"].includes(r.outcome.verdict), encode(st));
      }
    }
  }
});

test("plain fsync can lose a promised write and break the journal, but only on power loss", () => {
  for (const flush of [true, false]) {
    const ends = allEndings(flush, "fsync");
    const bad = ends.filter((e) => !["ok", "old"].includes(e.r.outcome.verdict));
    assert.ok(bad.some((e) => e.r.outcome.verdict === "lost"));
    assert.ok(bad.some((e) => e.r.outcome.verdict === "corrupt"));
    assert.ok(bad.some((e) => e.r.outcome.verdict === "stale"));
    for (const e of bad) assert.equal(e.r.world.failed, "p", encode(e.st));
  }
});

test("a do-nothing FLUSH is shown up by a macOS crash as well", () => {
  const ends = allEndings(true, "none");
  const bad = ends.filter((e) => !["ok", "old"].includes(e.r.outcome.verdict));
  assert.ok(bad.some((e) => e.r.world.failed === "m" && e.r.outcome.verdict === "lost"));
  assert.ok(bad.some((e) => e.r.world.failed === "m" && e.r.outcome.verdict === "corrupt"));
  for (const e of bad) assert.ok(["m", "p"].includes(e.r.world.failed));
});

test("recover() covers all five verdicts and each has a label", () => {
  const w = (levels, failed, acked) => ({ levels: { m: 1, ...levels }, failed, acked, step: 0, syncs: 0 });
  assert.equal(recover(w({ d: 5, j: 5, c: 5 }, "p", true)).verdict, "ok");
  assert.equal(recover(w({ d: 4, j: 4, c: 4 }, "p", true)).verdict, "lost");
  assert.equal(recover(w({ d: 4, j: 4, c: 2 }, "k", false)).verdict, "old");
  assert.equal(recover(w({ d: 4, j: 4, c: 5 }, "p", true)).verdict, "corrupt");
  assert.equal(recover(w({ d: 4, j: 5, c: 5 }, "p", true)).verdict, "stale");
  for (const v of ["ok", "old", "lost", "corrupt", "stale"]) assert.ok(VERDICTS[v].label);
  assert.equal(recover(w({ d: 5, j: 5, c: 5 }, "p", true)).survived.m, false, "the in-place inode never survives");
});

// ---- reducer and share state -------------------------------------------------------------

test("config change keeps the longest valid prefix", () => {
  const s = decode("f.full.n8_xp");
  const t = step(s, { type: "config", sync: "fsync" });
  assert.equal(encode(t), "f.fsync.n8_xp");
  assert.equal(replay(t).outcome.verdict, "lost");
  const wt = step(s, { type: "config", flush: false });
  assert.equal(encode(wt), "w.full.n6");
  // A drive writeback that is no longer possible cuts the run there.
  const u = step(decode("f.fsync.n4_dd"), { type: "config", sync: "full" });
  assert.equal(encode(u), "f.full.n4");
  assert.equal(step(s, { type: "config", sync: "bogus" }), s);
  assert.equal(step(s, { type: "config", sync: "full" }), s);
});

test("undo, reset and the action cap", () => {
  let s = initialState();
  assert.equal(step(s, { type: "undo" }), s);
  s = step(s, { type: "do", token: "n" });
  assert.equal(encode(s), "f.full.n1");
  assert.equal(encode(step(s, { type: "undo" })), null);
  assert.equal(encode(step(s, { type: "reset" })), null);
  assert.ok(MAX_ACTIONS >= 8 + 6 + 1);
});

test("encode/decode round-trip and the default clears the hash", () => {
  assert.equal(encode(initialState()), null);
  assert.equal(encode(initialState(false, "full")), "w.full");
  assert.equal(encode(initialState(true, "none")), "f.none");
  assert.deepEqual(decode("f.full"), initialState());
  for (const h of ["f.none.n3_hd_hj_n1", "w.fsync.n3_dd", "f.full.n1_n1"]) {
    const s = decode(h);
    assert.ok(s, h);
    assert.deepEqual(decode(encode(s)), s);
  }
  assert.equal(encode(decode("f.full.n1_n1")), "f.full.n2");
});

test("hostile share strings are refused", () => {
  const bad = [
    null, undefined, 42, "", "f", "f.", "f.full.", "x.full", "f.FULL", "f.full.n0", "f.full.n9",
    "f.full.n99", "f.full.zz", "f.full.n1__n1", "f.full.xp_n1", "f.full.hd", "f.full.n8_n1",
    "f.full.dc", "w.full.n7", "f.full.n1_<script>", "f.full.n1 ", " f.full", "f.full.n01",
    "f.full." + "n1_".repeat(70) + "n1", "f.full." + "a".repeat(300), "f.full.n8_xp_xk",
    "f.full.__proto__", "f.full.constructor",
  ];
  for (const h of bad) assert.equal(decode(h), null, String(h));
  assert.equal(isToken("xz"), false);
});

test("summary is plain text for each phase", () => {
  assert.match(summary(initialState()), /Nothing written yet\. The VMM answers FLUSH with F_FULLFSYNC\. Press Next step\./);
  assert.match(summary(decode("w.none")), /write-through/);
  assert.match(summary(decode("f.fsync.n4")), /^Step 4 of 8\. Guest kernel, then VMM FLUSH\. data block: rung 4, ssd's volatile cache; journal entry: rung 4/);
  assert.match(summary(decode("f.full.n8")), /fsync\(\) has returned\.$/);
  assert.match(summary(decode(REFERENCE)), /^Power lost\. Inconsistent: commit record without its journal entry\./);
  for (const p of PRESETS) assert.doesNotMatch(summary(decode(p.hash)), /undefined|NaN|\[object/);
});

test("learner-visible text carries no internal identifiers", () => {
  const texts = [
    ...RUNGS.flatMap((r) => [r.name, r.where]), ...BLOCKS.flatMap((b) => [b.name, b.long]),
    ...SYNCS.map((s) => s.label), ...FAILURES.flatMap((f) => [f.button, f.what]), ...MOVED_BY,
    ...PRESETS.flatMap((p) => [p.title, p.goal, p.real?.says ?? ""]),
    ...[true, false].flatMap((fl) => scriptFor(fl).flatMap((s) => [s.title, ...SYNCS.map((x) => s.text(x.id))])),
  ];
  for (const t of texts) {
    assert.doesNotMatch(t, /\bM\d+\b|§|PLAN|BLK-\d|\bR\d+\b|simply|just|obviously/, t);
  }
});
