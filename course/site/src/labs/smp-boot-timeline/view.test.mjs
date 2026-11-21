// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, step through the
// scenarios, check the share hash, the paper predictions, the sandbox, and the static rules
// from LABS.md section 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.disabled = false;
    this.checked = false;
    this.value = "";
    const cls = new Set();
    this.classList = {
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
    this._cls = cls;
  }
  set className(v) { this._cls.clear(); for (const c of v.split(/\s+/).filter(Boolean)) this._cls.add(c); }
  get className() { return [...this._cls].join(" "); }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? new FakeText(k) : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async fire(type, extra = {}) { for (const fn of this.listeners[type] || []) await fn({ type, ...extra }); }
  focus() { globalThis.document.activeElement = this; }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeNode) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
}
class FakeText { constructor(t) { this.textContent = t; } }

globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
  activeElement: null,
};

const { mount } = await import("./view.mjs");

function setup(initialHash = null) {
  let hash = initialHash;
  const said = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "smp-boot-timeline", id: "lab-smp-boot-timeline-1", base: "", standalone: false, reducedMotion: true,
    announce(t) { said.push(t); }, hash: { get: () => hash, set: (v) => { hash = v; } },
  };
  const handle = mount(el, ctx);
  const button = (text) => el.find((n) => n.tagName === "BUTTON" && n.textContent === text);
  const byId = (s) => el.find((n) => n.id === `lab-smp-boot-timeline-1-${s}`);
  const live = () => el.find((n) => n.className === "sbt__summary").textContent;
  return { el, handle, button, byId, live, said, getHash: () => hash };
}

test("mounts on Linux by default; the race steps and shows the capture's console lines", async () => {
  const first = setup();
  assert.match(first.live(), /Start: 4 vCPUs.*Press Step to start\./);
  assert.equal(first.byId("sc").value, "linux");
  assert.match(first.el.textContent, /Press Step to advance one step/);
  const { el, button, live, getHash } = setup("race@0");
  assert.match(live(), /Start: 4 vCPUs/);
  assert.ok(el.findAll((n) => n.className.includes("sbt__cell--future")).length > 0, "future rows hide their events");
  for (let i = 0; i < 5; i++) await button("Step").fire("click");
  assert.equal(getHash(), "race@5");
  assert.match(live(), /Step 5 of 19: vCPU 0 calls CPU_ON for CPU 1 again\. CPU_ON\(0x1, 0x4008_0078, 0x1\) → -4 ALREADY_ON\./);
  assert.match(el.textContent, /smp-race: cpu_on\(1\) first=0 second=-4/);
  assert.match(el.textContent, /528250/);
  assert.match(el.textContent, /Trace time \(ns\)/);
  await button("Reset").fire("click");
  assert.equal(getHash(), "race@0");
});

test("restores breakage 2 from the hash and flags the lookups", () => {
  const { el, live } = setup("reg@4");
  assert.match(live(), /Step 4 of 5/);
  assert.match(el.textContent, /MPIDR_EL1 = 0x80000000 \(wrong\)/);
  assert.match(el.textContent, /0x080c_0000, reports 0x0 \(likely; not checked\)/);
  assert.match(el.textContent, /NO: MPIDR_EL1 reads 0x80000000, the device tree says 0x1/);
  assert.match(el.textContent, /likely; not checked/);
});

test("paper: predictions get feedback, answers stay hidden until reached or revealed", async () => {
  const { el, button, byId, getHash } = setup("paper@0");
  const timeline = () => el.find((n) => n.tagName === "TBODY").textContent;
  assert.doesNotMatch(timeline(), /ON_PENDING|-5/);
  const pred = byId("pred");
  pred.value = "0";
  await pred.fire("change");
  await button("Step").fire("click");
  assert.match(el.textContent, /You predicted 0 SUCCESS: right\./);
  const reveal = byId("reveal");
  reveal.checked = true;
  await reveal.fire("change");
  assert.equal(getHash(), "paper@1!");
  assert.match(timeline(), /-5 ON_PENDING/);
});

test("sandbox: CPU_ON, take, a refused move, bad input, undo", async () => {
  const { el, button, byId, getHash, said } = setup();
  const sc = byId("sc");
  sc.value = "free";
  await sc.fire("change");
  assert.equal(getHash(), "free.c4.ok");
  byId("from").value = "0";
  byId("ctx").value = "0x33";
  await button("Call CPU_ON").fire("click");
  assert.equal(getHash(), "free.c4.ok.on0-1-40080000-33");
  await button("vCPU 1's thread takes its mailbox").fire("click");
  assert.match(el.textContent, /x0 = 0x33/);
  byId("target").value = "zz";
  await button("Call CPU_ON").fire("click");
  assert.match(el.textContent, /Target: not a hex number\./);
  assert.equal(getHash(), "free.c4.ok.on0-1-40080000-33_tk1");
  byId("target").value = "1";
  await button("Call CPU_ON").fire("click");
  assert.match(el.textContent, /ALREADY_ON/);
  await button("Undo last call").fire("click");
  assert.equal(getHash(), "free.c4.ok.on0-1-40080000-33_tk1");
  byId("cpus").value = "18";
  byId("brk").value = "dup";
  await button("Build this machine").fire("click");
  assert.equal(getHash(), "free.c18.dup");
  assert.match(el.textContent, /0x8000_0000/);
  assert.equal(said.length, 0);
});

test("a bad hash falls back; arrows move between steps", async () => {
  const { el, live, getHash } = setup("<script>");
  assert.match(live(), /Start/);
  const { button } = { button: (t) => el.find((n) => n.tagName === "BUTTON" && n.textContent === t) };
  await button("Step").fire("click");
  const cur = el.find((n) => n.className === "sbt__stepbtn" && n.attrs["aria-current"] === "step");
  await cur.fire("keydown", { key: "End" });
  assert.equal(getHash(), "linux@9");
  const last = el.find((n) => n.className === "sbt__stepbtn" && n.attrs["aria-current"] === "step");
  await last.fire("keydown", { key: "ArrowUp" });
  assert.equal(getHash(), "linux@8");
});

test("destroy empties the root", () => {
  const { el, handle } = setup();
  handle.destroy();
  assert.equal(el.children.length, 0);
});

test("shipped files follow the static rules", () => {
  for (const f of readdirSync(here)) {
    assert.match(f, /\.(mjs|css|json|svg)$/, `allowed file type: ${f}`);
    if (f.endsWith(".test.mjs") || !f.endsWith(".mjs")) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "style=", ".style.", "localStorage", "fetch("]) {
      assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
  }
  const view = readFileSync(join(here, "view.mjs"), "utf8");
  assert.match(view, /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8");
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const parts = rule.split("{");
    if (parts.length < 2) continue;
    const sel = parts[parts.length - 2].trim();
    for (const part of sel.split(",")) {
      assert.match(part.trim(), /^\.lab\[data-lab="smp-boot-timeline"\]/, `scoped: ${part.trim()}`);
    }
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b|rgb\(/, "tokens only");
});

const stepBtn = (el, k) => el.find((n) => n.className === "sbt__stepbtn" && n.textContent === String(k));

test("focus survives a step button, Step back at the start, and a quick move", async () => {
  const { el, button, byId } = setup("race@0");
  await stepBtn(el, 3).fire("click");
  assert.equal(document.activeElement, stepBtn(el, 3), "the rebuilt step button has focus");
  assert.equal(document.activeElement.attrs["aria-current"], "step");
  await stepBtn(el, 1).fire("click");
  await button("Step back").fire("click");
  assert.equal(document.activeElement, button("Step"), "focus moves to Step when Step back is disabled");
  const sc = byId("sc");
  sc.value = "free";
  await sc.fire("change");
  byId("from").value = "0";
  await button("Call CPU_ON").fire("click");
  await button("vCPU 1's thread takes its mailbox").fire("click");
  assert.equal(document.activeElement.tagName, "BUTTON");
  assert.equal(document.activeElement.attrs["data-move"], "rd0", "falls to the first quick move when the used one is gone");
  await button("vCPU 1 reads MPIDR_EL1").fire("click");
  assert.equal(document.activeElement.attrs["data-move"], "rd1", "the same move keeps focus");
});

test("sandbox steps: the latest is text, earlier ones undo back to themselves", async () => {
  const { el, getHash } = setup("free.c4.ok.on0-1-40080000-0_tk1_rd1");
  assert.equal(stepBtn(el, 3), null);
  assert.ok(el.find((n) => n.className === "sbt__stepnum" && n.textContent === "3"));
  const b1 = stepBtn(el, 1);
  assert.equal(b1.attrs["aria-label"], "Undo back to step 1");
  await b1.fire("click");
  assert.equal(getHash(), "free.c4.ok.on0-1-40080000-0");
  assert.equal(document.activeElement.textContent, "Call CPU_ON");
});

test("paper: the verdict is announced, Play is hidden; Play elsewhere has no aria-pressed", async () => {
  const { button, byId, live, el } = setup("paper@0");
  assert.equal(button("Play").hidden, true);
  const pred = byId("pred");
  pred.value = "-5";
  await pred.fire("change");
  await button("Step").fire("click");
  assert.match(live(), /^You predicted -5 ON_PENDING; the answer is 0 SUCCESS\. Step 1 of 9/);
  const race = setup("race@0");
  assert.equal(race.button("Play").hidden, false);
  assert.equal(race.button("Play").attrs["aria-pressed"], undefined);
  assert.ok(el.findAll((n) => n.attrs.role === "group" && n.attrs["aria-labelledby"]).length >= 4, "cards are groups, not regions");
  assert.equal(el.findAll((n) => n.tagName === "SECTION").length, 0);
});

test("sandbox: one channel for errors, tied to the input; every vCPU off; 64 vCPUs; reset text", async () => {
  const { el, button, byId, said } = setup("free.c2.ok");
  byId("target").value = "zz";
  await button("Call CPU_ON").fire("click");
  assert.equal(byId("target").attrs["aria-invalid"], "true");
  assert.equal(byId("target").attrs["aria-describedby"], "lab-smp-boot-timeline-1-err");
  byId("target").value = "1";
  await button("Call AFFINITY_INFO").fire("click");
  assert.equal(byId("target").attrs["aria-describedby"], undefined);
  assert.equal(said.length, 0);
  const off = setup("free.c2.ok.of0");
  assert.match(off.el.textContent, /Every vCPU is off, so no one can call CPU_ON/);
  assert.match(off.el.textContent, /CPU_OFF: every vCPU is now off; the VM idles until it is stopped/);
  const big = setup("free.c64.ok");
  assert.equal(big.byId("cpus").attrs.max, "64");
  assert.match(big.el.textContent, /vCPU 63/);
  const rs = setup("free.c2.ok.rs0");
  assert.match(rs.el.textContent, /the default, reboot, rebuilds the machine/);
});
