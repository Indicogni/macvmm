// Tests for the cache-views model. Run: node --test course/site/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LINES,
  LINE_BYTES,
  CTR_EL0,
  dminLineBytes,
  lineAddress,
  initialState,
  apply,
  run,
  step,
  peek,
  loadScenario,
  SCENARIOS,
  encodeState,
  decodeState,
  decodeAction,
  encodeAction,
  parseByte,
  checkAction,
  MAX_ACTIONS,
} from "./model.mjs";

const last = (s) => s.log[s.log.length - 1];
const vw = (line, value) => ({ op: "write", who: "vmm", line, value });
const gw = (line, value) => ({ op: "write", who: "guest", line, value });
const vr = (line) => ({ op: "read", who: "vmm", line });
const gr = (line) => ({ op: "read", who: "guest", line });

test("line size comes from the real CTR_EL0 value: DminLine = 4, 64 bytes", () => {
  assert.equal(dminLineBytes(CTR_EL0), 64);
  assert.equal(LINE_BYTES, 64);
  // The primer's hypothetical 0x8444c004 has the same DminLine.
  assert.equal(dminLineBytes(0x8444c004n), 64);
  assert.equal(lineAddress(0), "0x4000_0000");
  assert.equal(lineAddress(3), "0x4000_00c0");
});

test("loader without clean: the MMU-off guest reads old RAM; clean fixes it", () => {
  let s = run("arch", "off", [vw(0, 0x4d), gr(0)]);
  assert.equal(last(s).kind, "stale");
  assert.equal(last(s).got, 0x00);
  assert.match(last(s).fix, /Clean/);
  s = apply(s, { op: "clean", line: 0 });
  assert.equal(s.ram[0].value, 0x4d);
  assert.equal(s.cache[0].dirty, false);
  s = apply(s, gr(0));
  assert.equal(last(s).kind, "ok");
  assert.equal(last(s).got, 0x4d);
});

test("guest writes 0xAB around the cache; the VMM's next read hits the old 0x00; invalidate fixes it", () => {
  let s = run("arch", "off", [vr(1), gw(1, 0xab), vr(1)]);
  assert.equal(last(s).kind, "stale");
  assert.equal(last(s).got, 0x00);
  assert.match(last(s).fix, /invalidate/i);
  // Clean does not help: the line is clean.
  s = apply(s, { op: "clean", line: 1 });
  s = apply(s, vr(1));
  assert.equal(last(s).kind, "stale");
  s = apply(s, { op: "inval", line: 1 });
  s = apply(s, vr(1));
  assert.equal(last(s).kind, "ok");
  assert.equal(last(s).got, 0xab);
});

test("invalidating a dirty line loses the write", () => {
  let s = run("arch", "off", [vw(2, 0x42), { op: "inval", line: 2 }]);
  assert.equal(last(s).kind, "lost");
  s = apply(s, gr(2));
  assert.equal(last(s).kind, "ok"); // nothing newer survives, so 0x00 is not stale any more
  assert.equal(last(s).got, 0x00);
});

test("clean and invalidate keeps the write", () => {
  let s = run("arch", "off", [vw(2, 0x42), { op: "cleaninval", line: 2 }, gr(2)]);
  assert.equal(last(s).got, 0x42);
  assert.equal(s.cache[2].valid, false);
  assert.ok(s.log.every((e) => e.kind !== "lost"));
});

test("both sides write: cleaning the older dirty line overwrites the guest's newer write", () => {
  const s = run("arch", "off", [vw(3, 0x11), gw(3, 0x22), { op: "clean", line: 3 }]);
  assert.equal(last(s).kind, "lost");
  assert.equal(s.ram[3].value, 0x11);
});

test("invalidating an older dirty copy is not a lost write when a newer one is in RAM", () => {
  const s = run("arch", "off", [vw(3, 0x11), gw(3, 0x22), { op: "inval", line: 3 }, vr(3)]);
  assert.ok(s.log.every((e) => e.kind !== "lost"));
  assert.equal(last(s).got, 0x22);
});

test("an eviction writes a dirty line back, so the bug can hide", () => {
  const s = run("arch", "off", [vw(0, 0x4d), { op: "evict", line: 0 }, gr(0)]);
  assert.equal(last(s).kind, "ok");
  assert.equal(last(s).got, 0x4d);
});

test("guest with MMU on, or the measured Apple Silicon behaviour: no stale reads in any scenario", () => {
  for (const [platform, guest] of [
    ["arch", "on"],
    ["apple", "off"],
    ["apple", "on"],
  ]) {
    for (const sc of SCENARIOS) {
      const reads = sc.steps.filter((a) => a.op === "read");
      const s = run(platform, guest, sc.steps.filter((a) => a.op !== "inval" && a.op !== "clean"));
      if (reads.length) assert.ok(s.log.every((e) => e.kind !== "stale"), `${platform}/${guest}/${sc.id}`);
    }
    const s = run(platform, guest, [vr(1), gw(1, 0xab), vr(1), vw(0, 0x4d), gr(0)]);
    assert.ok(s.log.every((e) => e.kind !== "stale"), `${platform}/${guest}`);
  }
});

test("invalidate still loses a dirty write even when the views are coherent", () => {
  const s = run("apple", "off", [vw(2, 0x42), { op: "inval", line: 2 }]);
  assert.equal(last(s).kind, "lost");
});

test("peek reports what each observer would read without changing state", () => {
  const s = run("arch", "off", [vw(0, 0x4d)]);
  assert.deepEqual(peek(s, "vmm", 0), { value: 0x4d, ver: 1, from: "cache", stale: false });
  assert.deepEqual(peek(s, "guest", 0), { value: 0, ver: 0, from: "ram", stale: true });
  assert.equal(s.cache[0].dirty, true);
});

test("scenarios: steps reproduce their teaching point", () => {
  const outcome = {};
  for (const sc of SCENARIOS) {
    let s = loadScenario(sc.id);
    assert.equal(s.pending.length, sc.steps.length);
    while (s.pending.length) s = step(s);
    outcome[sc.id] = s.log.map((e) => e.kind);
  }
  assert.deepEqual(outcome, {
    loader: ["ok", "ok", "stale"],
    "guest-writes": ["ok", "ok", "stale"],
    "invalidate-loses": ["ok", "lost", "ok"],
    "both-write": ["ok", "ok", "lost", "ok"],
    measured: ["ok", "ok", "ok"],
  });
});

test("state is not mutated by apply", () => {
  const s0 = initialState();
  const snapshot = JSON.stringify(s0);
  apply(s0, vw(0, 1));
  assert.equal(JSON.stringify(s0), snapshot);
});

test("invalid actions are rejected with an error event and no change", () => {
  for (const bad of [
    null,
    { op: "write", who: "vmm", line: 0, value: 256 },
    { op: "write", who: "vmm", line: 0, value: -1 },
    { op: "read", who: "dma", line: 0 },
    { op: "clean", line: LINES },
    { op: "clean", line: 1.5 },
    { op: "zap", line: 0 },
  ]) {
    assert.ok(checkAction(bad));
    const s = apply(initialState(), bad);
    assert.equal(last(s).kind, "error");
    assert.equal(s.actions.length, 0);
  }
});

test("share state round-trips, including a scenario part-way through", () => {
  let s = loadScenario("guest-writes");
  s = step(s);
  const str = encodeState(s);
  assert.equal(str, "arch.off.vr1.guest-writes~gw1-ab_vr1");
  const back = decodeState(str);
  assert.deepEqual(back.ram, s.ram);
  assert.deepEqual(back.cache, s.cache);
  assert.deepEqual(back.pending, s.pending);
  assert.equal(back.scenario, "guest-writes");
  assert.equal(encodeState(back), str);
  assert.equal(encodeState(run("apple", "on", [])), "apple.on.");
  assert.ok(decodeState("apple.on."));
  for (const a of [vw(3, 0x0f), gr(2), { op: "cleaninval", line: 1 }, { op: "evict", line: 0 }]) {
    assert.deepEqual(decodeAction(encodeAction(a)), a);
  }
});

test("hostile share strings are refused, never half-applied", () => {
  const bad = [
    "",
    "x".repeat(2000),
    "arch.off",
    "mips.off.",
    "arch.maybe.",
    "arch.off.vw4-00",
    "arch.off.vw0-0g",
    "arch.off.vw0-100",
    "arch.off.vr0__vr1",
    "arch.off.vr0.nope~vr1",
    "arch.off.vr0.loader",
    "arch.off.<img>",
    "arch.off." + Array(MAX_ACTIONS + 1).fill("vr0").join("_"),
    "arch.off.vr0.loader~vr0.extra",
    "__proto__.off.",
  ];
  for (const b of bad) assert.equal(decodeState(b), null, JSON.stringify(b.slice(0, 40)));
});

test("parseByte accepts course-style hex and rejects the rest", () => {
  assert.equal(parseByte("ab"), 0xab);
  assert.equal(parseByte("0xAB"), 0xab);
  assert.equal(parseByte(" 0x0_f "), 0x0f);
  assert.equal(parseByte("7"), 7);
  for (const b of ["", "0x", "100", "zz", "-1", "1e1"]) assert.equal(parseByte(b), null, b);
});

test("vectors: none exist for this lab (a toy model, not an export of Rust code)", (t) => {
  t.skip("cache-views models architecture rules, not a Rust module, so there is no vector file to cross-check");
});

test("long sessions: a share string either rebuilds the exact state or is withheld", () => {
  // The case that used to break: a write, a clean, then 64 more actions.
  let s = run("arch", "off", [vw(0, 0x77), { op: "clean", line: 0 }]);
  for (let i = 0; i < 64; i++) s = apply(s, gr(0));
  assert.equal(s.ram[0].value, 0x77);
  assert.equal(s.overflow, true);
  assert.equal(encodeState(s), null);
  // Up to the cap, every prefix round-trips exactly.
  const acts = [];
  for (let i = 0; i < 70; i++) {
    const k = i % 6;
    acts.push(k === 0 ? vw(i % 4, i & 0xff) : k === 1 ? gw((i + 1) % 4, i & 0xff) : k === 2 ? vr(i % 4) : k === 3 ? { op: "clean", line: i % 4 } : k === 4 ? gr(i % 4) : { op: "inval", line: i % 4 });
  }
  let t = initialState();
  for (const [n, a] of acts.entries()) {
    t = apply(t, a);
    const str = encodeState(t);
    if (n + 1 <= MAX_ACTIONS) {
      const back = decodeState(str);
      assert.deepEqual(back.ram, t.ram, `after ${n + 1}`);
      assert.deepEqual(back.cache, t.cache, `after ${n + 1}`);
      assert.equal(back.nextVer, t.nextVer);
    } else {
      assert.equal(str, null, `after ${n + 1}`);
    }
  }
  assert.equal(t.lastOp, acts[acts.length - 1].op);
});

test("measured mode words the guest's source as an outcome, not a cache hit", () => {
  const s = run("apple", "off", [vw(0, 0x4d), gr(0)]);
  assert.match(last(s).detail, /as measured/);
  assert.doesNotMatch(last(s).detail, /cache \(hit\)/);
  assert.match(run("arch", "on", [vw(0, 0x4d), gr(0)]).log[1].detail, /the shared cache/);
  assert.match(run("apple", "off", [vr(0), vr(0)]).log[1].detail, /its cache \(hit\)/);
});

test("guest-to-VMM fix says when to invalidate and that EL0 uses clean and invalidate", () => {
  const s = run("arch", "off", [vr(1), gw(1, 0xab), vr(1)]);
  assert.match(last(s).fix, /After the guest's write and before reading/);
  assert.match(last(s).fix, /DC CIVAC/);
});

test("fallback.svg passes the site's SVG sanitizer (no inline <style>)", async () => {
  const { readFileSync } = await import("node:fs");
  const { sanitizeSvg } = await import("../../../lib/svg.mjs");
  const svg = readFileSync(new URL("fallback.svg", import.meta.url), "utf8");
  assert.doesNotThrow(() => sanitizeSvg(svg, "x"));
  assert.ok(!/<style/i.test(svg));
});

test("shipped files follow the lab contract (LABS.md sections 1, 4, 5 and 7)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL(".", import.meta.url);
  const shipped = readdirSync(dir).filter((f) => !f.endsWith(".test.mjs"));
  for (const f of shipped) assert.match(f, /\.(mjs|css|json|svg)$/, f);
  const view = readFileSync(new URL("view.mjs", dir), "utf8");
  assert.match(view, /export function mount\(/);
  for (const f of shipped.filter((x) => x.endsWith(".mjs") || x.endsWith(".css"))) {
    const code = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "localStorage", "fetch("]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
  }
  const css = readFileSync(new URL("style.css", dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    const parts = rule.split("{");
    const sel = parts[parts.length - 2].trim();
    for (const s of sel.split(",")) assert.match(s.trim(), /^\.lab\[data-lab="cache-views"\]/, s);
    assert.ok(!/#[0-9a-f]{3,6}\b/i.test(rule), `hard-coded color in ${sel}`);
  }
  const svg = readFileSync(new URL("fallback.svg", dir), "utf8");
  assert.match(svg, /<title>/);
  assert.match(svg, /<desc>/);
  assert.ok(!/<script|\son[a-z]+=|foreignObject|href=/i.test(svg));
  const lab = JSON.parse(readFileSync(new URL("lab.json", dir), "utf8"));
  assert.equal(lab.title, "Cache views");
});
