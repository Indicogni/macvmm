// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, change the value through
// each of the three input paths, and check the share hash and the static rules from LABS.md section 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class FakeText {
  constructor(t) {
    this.textContent = t;
  }
}
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.tabIndex = 0;
    this.type = "";
    this.name = "";
    const cls = new Set();
    this._cls = cls;
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
  }
  set className(v) {
    this._cls.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._cls.add(c);
  }
  get className() {
    return [...this._cls].join(" ");
  }
  get dataset() {
    const d = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) d[k.slice(5)] = v;
    return d;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "id") this.id = v;
    if (k === "value") this.value = v;
    if (k === "type") this.type = v;
    if (k === "name") this.name = v;
    if (k === "tabindex") this.tabIndex = Number(v);
  }
  getAttribute(k) {
    return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeText(k) : k;
      if (n instanceof FakeNode) n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  contains(n) {
    for (let p = n; p; p = p.parent) if (p === this) return true;
    return false;
  }
  closest(sel) {
    const cls = sel.replace(/^\./, "");
    for (let p = this; p; p = p.parent) if (p._cls.has(cls)) return p;
    return null;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof FakeNode) yield* c.walk();
  }
  find(pred) {
    for (const n of this.walk()) if (pred(n)) return n;
    return null;
  }
  findAll(pred) {
    return [...this.walk()].filter(pred);
  }
}

/** Dispatch an event at `target`, bubbling to every ancestor's listeners. */
async function fire(target, type, extra = {}) {
  let prevented = false;
  const ev = { type, target, key: extra.key, preventDefault: () => (prevented = true) };
  for (let n = target; n; n = n.parent) for (const fn of n.listeners[type] || []) await fn(ev);
  return prevented;
}

globalThis.Element = FakeNode;
globalThis.HTMLInputElement = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
  activeElement: null,
};

const { mount } = await import("./view.mjs");

function setup(initialHash = null) {
  let hash = initialHash;
  const spoken = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "pstate-builder",
    id: "lab-pstate-builder-1",
    base: "",
    standalone: false,
    reducedMotion: true,
    announce: (t) => spoken.push(t),
    hash: { get: () => hash, set: (v) => (hash = v) },
  };
  const handle = mount(el, ctx);
  const q = (pred) => el.find(pred);
  const bit = (b) => q((n) => n.tagName === "BUTTON" && n.attrs["data-bit"] === String(b));
  const summary = () => q((n) => n.id === "lab-pstate-builder-1-summary").textContent;
  const input = q((n) => n.tagName === "INPUT" && n.attrs.type === "text");
  const form = q((n) => n.tagName === "FORM");
  return { el, ctx, q, bit, summary, input, form, spoken, handle, hash: () => hash };
}

test("mount renders 0x3c5 with no hash and announces nothing", () => {
  const { summary, hash, spoken, bit, input } = setup();
  assert.match(summary(), /^0x3c5 is EL1h/);
  assert.equal(hash(), null);
  assert.deepEqual(spoken, []);
  assert.equal(input.value, "0x3c5");
  assert.equal(bit(0).attrs["aria-pressed"], "true");
  assert.equal(bit(1).attrs["aria-pressed"], "false");
  assert.equal(bit(9).attrs["aria-pressed"], "true");
  // Exactly one bit is in the tab order.
  const tabbable = setup().el.findAll((n) => n.attrs["data-bit"] !== undefined && n.tabIndex === 0);
  assert.equal(tabbable.length, 1);
});

test("clicking bit 0 gives the EL1t mistake, with what we observed", async () => {
  const { bit, summary, hash, spoken, el } = setup();
  await fire(bit(0), "click");
  assert.match(summary(), /^0x3c4 is EL1t: EL1, sp means SP_EL0/);
  assert.equal(hash(), "0x3c4");
  assert.equal(spoken.length, 1);
  assert.match(el.textContent, /five lines, never vectors ok/);
  assert.match(el.textContent, /macvmm: timeout: the guest was still running after --timeout 10s/);
});

test("typing a value sets it; a bad value is refused with a message", async () => {
  const { input, form, summary, hash, el } = setup();
  input.value = "0x3c9";
  assert.equal(await fire(form, "submit"), true);
  assert.match(summary(), /^0x3c9 is EL2h/);
  assert.match(el.textContent, /HV_ILLEGAL_GUEST_STATE/);
  input.value = "0x1ffffffff";
  await fire(form, "submit");
  assert.equal(input.attrs["aria-invalid"], "true");
  assert.match(el.textContent, /Not set: PSTATE in SPSR layout is 32 bits/);
  assert.equal(hash(), "0x3c9");
});

test("field controls: level, stack select, masks, flags", async () => {
  const { q, summary, hash } = setup();
  const radio = (v) => q((n) => n.attrs.type === "radio" && n.value === v);
  const r0 = radio("0");
  r0.checked = true;
  await fire(r0, "change");
  assert.equal(hash(), "0x3c0");
  const sp = q((n) => n.attrs.type === "checkbox" && n.id === "lab-pstate-builder-1-sp");
  assert.equal(sp.disabled, true);
  const mI = q((n) => n.attrs["data-mask"] === "I");
  mI.checked = false;
  await fire(mI, "change");
  assert.equal(hash(), "0x340");
  const fZ = q((n) => n.attrs["data-flag"] === "Z");
  fZ.checked = true;
  await fire(fZ, "change");
  assert.equal(hash(), "0x40000340");
  assert.match(summary(), /EL0t: EL0, sp means SP_EL0, masks D A F, flags Z set/);
});

test("an unused bit shows the problem, never a mode", async () => {
  const { bit, summary, el } = setup();
  await fire(bit(23), "click");
  assert.match(summary(), /bits set outside the fields/);
  assert.match(bit(23).attrs["aria-label"], /set but should be 0/);
  assert.match(el.textContent, /not a mode we use/);
});

test("PAN is a known bit: still EL1h, with a note", async () => {
  const { bit, summary, el, spoken } = setup();
  await fire(bit(22), "click");
  assert.match(summary(), /^0x4003c5 is EL1h/);
  assert.ok(!/should be 0/.test(bit(22).attrs["aria-label"]));
  assert.match(el.textContent, /the CPU sets these on exception entry/);
  assert.equal(spoken[0], "bit 22 on: EL1h, sp means SP EL1, value 0x4003c5");
});

test("0x3c9 shows no guest reads; the bar is a toolbar", async () => {
  const { input, form, el, q } = setup();
  input.value = "0x3c9";
  await fire(form, "submit");
  assert.match(el.textContent, /No reads: HVF refused this state before the first instruction/);
  assert.ok(!/mrs x0, CurrentEL/.test(el.textContent));
  const bar = q((n) => n.attrs.role === "toolbar");
  assert.equal(bar.attrs["aria-orientation"], "horizontal");
  assert.match(el.textContent, /Try this/);
  assert.match(el.textContent, /10 = EL2/);
});

test("EL0 then EL1 restores the stack bit and says so", async () => {
  const { q, hash, spoken, el } = setup();
  const radio = (v) => q((n) => n.attrs.type === "radio" && n.value === v);
  await fire(radio("0"), "change");
  assert.equal(hash(), "0x3c0");
  assert.match(spoken.at(-1), /EL0 cleared the stack-pointer bit/);
  assert.match(el.textContent, /Picking EL1 or above turns it back on/);
  await new Promise((r) => setTimeout(r, 350));
  await fire(radio("1"), "change");
  assert.equal(hash(), null);
});

test("arrow keys rove focus in the bit bar", async () => {
  const { bit } = setup();
  const b0 = bit(0);
  b0.focus();
  assert.equal(await fire(b0, "keydown", { key: "ArrowLeft" }), true);
  assert.equal(globalThis.document.activeElement, bit(1));
  assert.equal(bit(1).tabIndex, 0);
  assert.equal(b0.tabIndex, -1);
  await fire(bit(1), "keydown", { key: "Home" });
  assert.equal(globalThis.document.activeElement, bit(31));
});

test("mount restores shared state; garbage hashes fall back to 0x3c5", () => {
  assert.match(setup("0xf0000004").summary(), /^0xf0000004 is EL1t.*flags N Z C V set/);
  assert.match(setup("<img src=x>").summary(), /^0x3c5 is EL1h/);
});

test("reset returns to 0x3c5 and clears the hash", async () => {
  const { q, bit, hash, summary } = setup("0x10");
  assert.match(summary(), /AArch32/);
  const reset = q((n) => n.tagName === "BUTTON" && n.textContent.startsWith("Reset"));
  await fire(reset, "click");
  assert.equal(hash(), null);
  assert.equal(bit(4).attrs["aria-pressed"], "false");
});

test("ids are derived from ctx.id", () => {
  const { el } = setup();
  for (const n of el.findAll((x) => x.id)) assert.ok(n.id.startsWith("lab-pstate-builder-1"), n.id);
  for (const n of el.findAll((x) => x.attrs.for)) assert.ok(el.find((m) => m.id === n.attrs.for), `label for ${n.attrs.for}`);
});

test("shipped files obey the LABS.md static rules", () => {
  for (const f of readdirSync(here)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed type`);
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch(", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.ok(!/"style"|style:/.test(src), `${f} sets inline styles`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="pstate-builder"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), "no hard-coded colors");
  }
  const json = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(json.title, "PSTATE builder");
  assert.ok(json.goal.length > 0);
});
