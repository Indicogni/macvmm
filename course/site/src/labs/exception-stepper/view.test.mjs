// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, click through a run,
// and check the share hash and the static rules from LABS.md section 7.
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
    this.hidden = false;
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
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; if (k === "value") this.value = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? new FakeText(k) : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async fire(type) { for (const fn of this.listeners[type] || []) await fn({ type }); }
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
  const el = new FakeNode("div");
  const ctx = {
    name: "exception-stepper", id: "lab-exception-stepper-1", base: "", standalone: false, reducedMotion: true,
    announce() {}, hash: { get: () => hash, set: (v) => { hash = v; } },
  };
  mount(el, ctx);
  const button = (label) => el.find((n) => n.tagName === "BUTTON" && n.textContent.startsWith(label));
  const live = el.find((n) => n.attrs["aria-live"] === "polite");
  return { el, ctx, button, live, hash: () => hash };
}

test("mount renders the svc run and ERET", async () => {
  const { el, button, live, hash } = setup();
  assert.match(live.textContent, /svc #0 at 0x1000/);
  assert.equal(button("ERET").disabled, true);
  await button("Step").fire("click");
  assert.match(live.textContent, /PC is now 0x8400/);
  assert.equal(hash(), "s0-csvc-r1-m0-p1-n0");
  assert.equal(globalThis.document.activeElement, button("ERET"));
  const badges = el.findAll((n) => n.className === "es__badge");
  assert.equal(badges.length, 5);
  await button("ERET").fire("click");
  assert.match(live.textContent, /back to EL0 at 0x1004/);
});

test("mount restores shared state from the hash", () => {
  const { el, live } = setup("s1-chvc-r1-m0-p1-n1");
  assert.match(live.textContent, /taken to EL2/);
  assert.ok(el.find((n) => n.className === "es__reg" && n.textContent.includes("ESR_EL2")));
});

test("ids are derived from ctx.id", () => {
  const { el } = setup();
  for (const n of el.findAll((x) => x.id)) assert.ok(n.id.startsWith("lab-exception-stepper-1"), n.id);
});

test("shipped files obey the LABS.md static rules", () => {
  for (const f of readdirSync(here)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed type`);
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch("]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    // the selector is the text before the rule's last "{" (an "@media ... {" prefix is dropped)
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="exception-stepper"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), "no hard-coded colors");
  }
});

test("masked IRQ: Step moves focus to the mask checkbox, unticking takes the IRQ", async () => {
  const { el, button, live } = setup("s1-cirq-r1-m1-p0-n0");
  const mask = el.find((n) => n.tagName === "INPUT" && n.id.endsWith("-mask"));
  await button("Step").fire("click");
  assert.equal(button("Step").disabled, true);
  assert.equal(globalThis.document.activeElement, mask);
  assert.match(live.textContent, /waits/);
  mask.checked = false;
  await mask.fire("change");
  assert.match(live.textContent, /taken to EL1/);
  assert.equal(button("ERET").disabled, false);
});

test("table scroller is focusable and named; corner header is not blank", () => {
  const { el } = setup();
  const wrap = el.find((n) => n.className === "es__scroll");
  assert.equal(wrap.attrs.tabindex, "0");
  assert.equal(wrap.attrs.role, "region");
  assert.ok(wrap.attrs["aria-label"]);
  const firstTh = el.find((n) => n.tagName === "TH");
  assert.equal(firstTh.textContent, "register");
});

test("share message does not overwrite the summary", async () => {
  const { el, ctx, button, live } = setup();
  ctx.announce = undefined;
  const before = live.textContent;
  await button("Copy link").fire("click");
  assert.equal(live.textContent, before);
  assert.ok(el.find((n) => n.attrs.role === "status").textContent.length > 0);
});
