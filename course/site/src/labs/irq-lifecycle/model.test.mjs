// Tests for the irq-lifecycle model. Run: node --test course/site/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  INTID, SPURIOUS, MAX_ACTIONS, CPU_KINDS, PRESETS,
  initialCpuWorld, stepCpuWorld, cpuPending,
  initialGic, stepGic, gicStateName, gicSignalling,
  initialState, replay, step, canDo, summary, encode, decode, startState, shareString,
  GIC_START_PAGES, IN_HANDLER_CELL,
  cpuFallbackText, gicFallbackText,
} from "./model.mjs";

const repo = (p) => fileURLToPath(new URL(`../../../../../${p}`, import.meta.url));

/** The ```text block that follows `:::lab irq-lifecycle` in a lesson. */
function lessonFallback(path) {
  const src = readFileSync(repo(path), "utf8");
  const at = src.indexOf(":::lab irq-lifecycle");
  assert.ok(at >= 0, `${path} embeds the lab`);
  const m = /```text\n([\s\S]*?)\n```/.exec(src.slice(at));
  assert.ok(m, `${path} has a text fallback after the lab`);
  return m[1].split("\n").map((l) => l.trimEnd()).join("\n");
}

test("chapter 11's fallback table is the model's output, character for character", () => {
  assert.equal(cpuFallbackText(), lessonFallback("course/chapters/V/11-timer-irq.md"));
});

test("chapter 12's fallback table is the model's output, character for character", () => {
  assert.equal(gicFallbackText(), lessonFallback("course/chapters/V/12-gicv3.md"));
});

test("both chapters list the lab in their front matter", () => {
  for (const p of ["course/chapters/V/11-timer-irq.md", "course/chapters/V/12-gicv3.md"]) {
    const fm = readFileSync(repo(p), "utf8").split("\n---")[0];
    assert.match(fm, /^labs: \[.*\birq-lifecycle\b.*\]$/m, p);
  }
});

test("level line: pending survives the mask, storms until the cause is cleared", () => {
  let w = initialCpuWorld("level");
  assert.equal(w.masked, true);
  ({ world: w } = stepCpuWorld(w, "raise"));
  for (let i = 0; i < 5; i++) assert.equal(stepCpuWorld(w, "wait").cell, "still pending");
  let out = stepCpuWorld(w, "unmask");
  assert.equal(out.cell, "handler runs");
  w = out.world;
  for (let i = 0; i < 3; i++) {
    out = stepCpuWorld(w, "return");
    assert.equal(out.cell, "runs again at once");
    w = out.world;
  }
  assert.equal(w.runs, 4);
  out = stepCpuWorld(w, "clear");
  assert.equal(out.cell, "line drops, done");
  assert.equal(cpuPending(out.world), false);
  assert.equal(out.world.inHandler, false);
});

test("unlatched edge is lost while masked, taken at once when unmasked", () => {
  let w = initialCpuWorld("edge");
  let out = stepCpuWorld(w, "raise");
  assert.equal(out.cell, "pulse, gone");
  assert.equal(out.world.lost, 1);
  out = stepCpuWorld(out.world, "unmask");
  assert.equal(out.cell, "nothing happens");
  out = stepCpuWorld(out.world, "raise");
  assert.equal(out.cell, "pulse, handler runs");
  assert.equal(stepCpuWorld(out.world, "return").cell, "returns, nothing pending");
});

test("latched edge keeps one event, merges a second", () => {
  let { world: w } = stepCpuWorld(initialCpuWorld("latched"), "raise");
  const out = stepCpuWorld(w, "raise");
  assert.equal(out.cell, "latch already set");
  assert.equal(out.world.merged, 1);
  w = stepCpuWorld(out.world, "unmask").world;
  assert.equal(w.runs, 1);
  w = stepCpuWorld(w, "clear").world;
  assert.equal(w.latch, false);
});

test("cpu mode refuses actions that apply nowhere", () => {
  const s = initialState("cpu");
  assert.equal(canDo(s, "k"), false, "no handler is running yet");
  assert.equal(canDo(s, "c"), false);
  assert.equal(step(s, { type: "do", key: "k" }), s);
  assert.equal(canDo(s, "r"), true);
  assert.equal(canDo(s, "i"), false, "gic letters are not cpu actions");
});

test("GIC level line: the five steps of one keystroke", () => {
  let g = initialGic("level");
  const states = [];
  for (const a of ["raise", "iar", "lower", "eoi"]) {
    const out = stepGic(g, a);
    g = out.gic;
    states.push(gicStateName(g));
    if (a === "iar") assert.equal(out.result, INTID);
  }
  assert.deepEqual(states, ["pending", "active and pending", "active", "inactive"]);
  assert.equal(gicSignalling(g), false);
});

test("GIC level line never lowered: pending again after every EOI", () => {
  const { gic, rows } = replay({ mode: "gic", trigger: "level", actions: "rieieie" });
  assert.equal(gic.acks, 3);
  assert.equal(gic.eois, 3);
  assert.deepEqual(rows.filter((r) => r.key === "e").map((r) => r.note), Array(3).fill("taken again at once: a storm"));
  assert.equal(gicStateName(gic), "pending");
  assert.equal(gicSignalling(gic), true);
});

test("GIC: dropped before the IAR gives 1023 and nothing to EOI", () => {
  const { gic, rows } = replay({ mode: "gic", trigger: "level", actions: "rdie" });
  assert.equal(rows[2].result, SPURIOUS);
  assert.equal(rows[2].step, "CPU reads IAR (returns 1023)");
  assert.match(rows[2].note, /without an EOI/);
  assert.match(rows[3].note, /nothing is active/);
  assert.equal(gicStateName(gic), "inactive");
  assert.equal(gic.acks, 0);
});

test("GIC: a second IAR while active returns 1023", () => {
  const { rows } = replay({ mode: "gic", trigger: "level", actions: "rii" });
  assert.equal(rows[2].result, SPURIOUS);
  assert.match(rows[2].note, /already active/);
});

test("GIC edge: the acknowledge clears pending; a second edge during the handler is kept", () => {
  let r = replay({ mode: "gic", trigger: "edge", actions: "ri" });
  assert.equal(gicStateName(r.gic), "active");
  assert.equal(r.gic.line, true);
  r = replay({ mode: "gic", trigger: "edge", actions: "ridre" });
  assert.equal(gicStateName(r.gic), "pending");
  assert.equal(r.rows[4].note, "taken again: the second edge was kept");
  r = replay({ mode: "gic", trigger: "edge", actions: "rr" });
  assert.equal(r.rows[1].step, "line already high");
});

test("GIC level: a new byte during the handler is pending again, not a storm", () => {
  const { gic, rows } = replay({ mode: "gic", trigger: "level", actions: "ridre" });
  assert.deepEqual(rows.map((r) => r.state), ["pending", "active and pending", "active", "active and pending", "pending"]);
  assert.equal(rows[4].note, "pending again: a new byte arrived during the handler");
  assert.equal(gicSignalling(gic), true);
  // The next acknowledge starts a fresh handler: never lowering it then is a storm again.
  const r2 = replay({ mode: "gic", trigger: "level", actions: "ridreie" });
  assert.equal(r2.rows[6].note, "taken again at once: a storm");
  // Lowering before the IAR does not count as lowered during the handler.
  const r3 = replay({ mode: "gic", trigger: "level", actions: "rdrie" });
  assert.equal(r3.rows[4].note, "taken again at once: a storm");
});

test("GIC edge with the line held high: the note says the IAR cleared pending", () => {
  const { rows } = replay({ mode: "gic", trigger: "edge", actions: "ri" });
  assert.equal(rows[1].state, "active");
  assert.equal(rows[1].note, "active only: the IAR cleared pending");
});

test("cpu: mask inside a handler is shown, not applied, and wait is labelled from every world", () => {
  const { worlds, rows } = replay({ mode: "cpu", trigger: "level", actions: "urkmwuc" });
  // u r k m: the level and latched worlds are in their handlers, the edge world is not.
  assert.deepEqual(rows[3].cells, [IN_HANDLER_CELL, "masked", IN_HANDLER_CELL]);
  assert.equal(rows[4].step, "time passes", "not every CPU is masked");
  assert.equal(replay({ mode: "cpu", trigger: "level", actions: "rww" }).rows[1].step, "CPU masked, waits");
  assert.ok(worlds.every((w) => !w.inHandler));
  // Every world in its handler: a mask change applies nowhere and is refused.
  const allIn = { mode: "cpu", trigger: "level", actions: "ur" };
  assert.equal(replay(allIn).worlds.filter((w) => w.inHandler).length, 3);
  assert.equal(canDo(allIn, "m"), false);
  assert.equal(canDo(allIn, "u"), false);
});

test("start state: chapter 12's embed opens in the GIC view, everything else in chapter 11's", () => {
  const chapters = JSON.parse(readFileSync(repo("course/chapters.json"), "utf8"));
  const list = Array.isArray(chapters) ? chapters : chapters.chapters;
  const ch12 = list.find((c) => c.id === "12");
  const ch11 = list.find((c) => c.id === "11");
  assert.deepEqual(GIC_START_PAGES, [ch12.url]);
  assert.ok(ch12.labs.includes("irq-lifecycle") && ch11.labs.includes("irq-lifecycle"));
  const base = "/build-your-own/vmm/";
  assert.deepEqual(startState({ path: `${base}${ch12.url}` }), initialState("gic", "level"));
  assert.deepEqual(startState({ path: `${base}${ch12.url}index.html` }), initialState("gic", "level"));
  assert.deepEqual(startState({ path: `${base}${ch11.url}` }), initialState("cpu"));
  assert.deepEqual(startState({ standalone: true, path: `${base}${ch12.url}` }), initialState("cpu"));
  assert.deepEqual(startState({ path: `${base}${ch11.url}`, options: { mode: "gic" } }), initialState("gic", "level"));
  assert.deepEqual(startState({ options: { mode: "<x>" } }), initialState("cpu"));
  const g0 = initialState("gic", "level");
  assert.equal(shareString(g0, g0), null);
  assert.equal(shareString(initialState("cpu"), g0), "cpu");
  assert.deepEqual(decode(shareString(initialState("cpu"), g0)), initialState("cpu"));
  assert.equal(shareString(initialState("cpu"), initialState("cpu")), null);
  assert.equal(shareString(g0, initialState("cpu")), "gic-l");
});

test("presets replay cleanly, and their quotes are in the real captures", () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(!ids.has(p.id), `unique preset id ${p.id}`);
    ids.add(p.id);
    const s = step(initialState(), { type: "preset", id: p.id });
    assert.equal(s.actions, p.actions);
    assert.equal(replay(s).refused, -1, p.id);
    assert.deepEqual(decode(encode(s) ?? "cpu"), s, `round trip ${p.id}`);
    if (p.real) {
      const path = repo(`course/captures/${p.real.capture}`);
      assert.ok(existsSync(path), path);
      assert.ok(readFileSync(path, "utf8").includes(p.real.quote), `${p.real.capture} contains "${p.real.quote}"`);
    }
  }
  assert.ok(PRESETS.some((p) => p.mode === "cpu") && PRESETS.some((p) => p.mode === "gic"));
});

test("share state: strict decode, default clears the hash", () => {
  assert.equal(encode(initialState("cpu")), null);
  assert.equal(encode(initialState("gic")), "gic-l");
  assert.equal(encode({ mode: "gic", trigger: "level", actions: "rie" }), "gic-l.rie");
  assert.deepEqual(decode("gic-l.rie"), { mode: "gic", trigger: "level", actions: "rie" });
  assert.deepEqual(decode("gic-e"), { mode: "gic", trigger: "edge", actions: "" });
  assert.deepEqual(decode("cpu.rwukc"), { mode: "cpu", trigger: "level", actions: "rwukc" });
  for (const bad of [null, undefined, 5, "", "cpu.", "gic", "gic-x.r", "cpu.rx", "gic-l.rk", "cpu.k", "CPU.r",
    "cpu.r ", "gic-l.<script>", `gic-l.${"r".repeat(MAX_ACTIONS + 1)}`, "cpu.r#x"]) {
    assert.equal(decode(bad), null, String(bad));
  }
});

test("history is capped", () => {
  let s = initialState("gic");
  for (let i = 0; i < MAX_ACTIONS + 10; i++) s = step(s, { type: "do", key: i % 2 ? "i" : "e" });
  assert.equal(s.actions.length, MAX_ACTIONS);
  assert.equal(canDo(s, "r"), false);
});

test("step: undo, reset, mode and trigger switches", () => {
  let s = step(initialState("cpu"), { type: "do", key: "r" });
  assert.equal(step(s, { type: "undo" }).actions, "");
  assert.equal(step(s, { type: "reset" }).actions, "");
  const g = step(s, { type: "mode", mode: "gic" });
  assert.deepEqual(g, { mode: "gic", trigger: "level", actions: "" });
  const e = step(step(g, { type: "do", key: "r" }), { type: "trigger", trigger: "edge" });
  assert.deepEqual(e, { mode: "gic", trigger: "edge", actions: "r" }, "a trigger switch keeps the steps");
  for (const acts of ["ride", "rieieie", "ridrei", "rdi"]) {
    for (const t of ["level", "edge"]) assert.equal(replay({ mode: "gic", trigger: t, actions: acts }).refused, -1, `${acts} under ${t}`);
  }
  assert.equal(step(s, { type: "mode", mode: "bogus" }), s);
  assert.equal(step(s, { type: "trigger", trigger: "edge" }), s, "trigger only in gic mode");
  assert.equal(step(s, { type: "preset", id: "nope" }), s);
  assert.equal(step(s, null), s);
});

test("summary is plain text and names every source", () => {
  const t = summary({ mode: "cpu", trigger: "level", actions: "rr" });
  for (const k of CPU_KINDS) assert.ok(t.includes(k.label), k.label);
  assert.match(t, /2 events lost/);
  assert.match(t, /1 event merged/);
  const g = summary({ mode: "gic", trigger: "level", actions: "rie" });
  assert.match(g, /INTID 33 is pending, line high\. Taken again at once: a storm\. The GIC is signalling/);
  assert.match(summary(initialState("gic")), /^Start: INTID 33 \(level-triggered\) is inactive/);
});

test("model has no DOM or network dependencies", () => {
  const src = readFileSync(fileURLToPath(new URL("./model.mjs", import.meta.url)), "utf8");
  for (const bad of ["document.", "window.", "fetch(", "eval(", "new Function", "innerHTML", "http://", "https://"]) {
    assert.ok(!src.includes(bad), bad);
  }
});
