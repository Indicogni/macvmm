// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, answer, step through a
// chain, check the share hash, and check the static rules from LABS.md sections 4, 5 and 7.
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
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) };
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

globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => new FakeText(t), activeElement: null };

const { mount } = await import("./view.mjs");

function setup(initialHash = null) {
  let hash = initialHash;
  const el = new FakeNode("div");
  const ctx = {
    name: "boot-chain", id: "lab-boot-chain-1", base: "", standalone: false, reducedMotion: true,
    announce() {}, hash: { get: () => hash, set: (v) => { hash = v; } },
  };
  mount(el, ctx);
  const button = (label) => el.find((n) => n.tagName === "BUTTON" && n.textContent.startsWith(label));
  const live = el.find((n) => n.attrs["aria-live"] === "polite");
  const details = el.find((n) => n.className === "bc__details");
  return { el, button, live, details, hash: () => hash };
}

test("mount asks first, then reveals the step", async () => {
  const { el, button, live, details, hash } = setup();
  assert.match(live.textContent, /Step 1 of 7: .*Who owns the DTB now\?$/);
  assert.equal(details.hidden, true, "details hidden until the reader answers");
  assert.equal(button("Back").disabled, true);
  await button("macvmm (the VMM)").fire("click");
  assert.equal(details.hidden, false);
  assert.match(live.textContent, /Your answer is right/);
  assert.ok(el.find((n) => n.className === "bc__feedback").textContent.startsWith("Right"));
  await button("Next step").fire("click");
  assert.equal(hash(), "efi-bsd@2");
  assert.equal(details.hidden, true);
  await button("Show without guessing").fire("click");
  assert.match(live.textContent, /pc: 0x17c/);
});

test("the shared reference opens revealed, at the stale-key call", () => {
  const { el, live, details } = setup("efi-linux.f.kr@7");
  assert.equal(details.hidden, false);
  assert.match(live.textContent, /Step 7 of 9: .*stale key/);
  const whatIf = el.findAll((n) => n.className === "bc__edit bc__edit--whatif");
  assert.equal(whatIf.length, 1, "only U-Boot's own copy: bootefi copies ours, not U-Boot's");
  const inUse = el.findAll((n) => n.className === "bc__dtb bc__dtb--inuse");
  assert.equal(inUse.length, 1);
  assert.match(inUse[0].textContent, /the stub's copy/);
});

test("a bad hash falls back to the default", () => {
  const { live } = setup("efi-bsd@1;<script>");
  assert.match(live.textContent, /^Step 1 of 7/);
});

test("lane buttons jump; the last step lines up with direct boot", async () => {
  const { el, hash } = setup();
  const jumps = el.findAll((n) => n.className === "bc__jump");
  assert.equal(jumps.length, 7);
  await jumps[6].fire("click");
  assert.equal(hash(), "efi-bsd@7");
  const same = el.find((n) => n.className === "bc__item bc__item--here" && n.textContent.includes("Linux runs"));
  assert.ok(same, "direct lane marks the matching step");
  await el.findAll((n) => n.className === "bc__jump")[3].fire("click");
  assert.ok(el.find((n) => n.className === "bc__item bc__item--none"), "no matching direct step in the middle");
});

const inTree = (el, n) => !!el.find((x) => x === n);

test("keyboard focus survives a guess, a lane jump and Back", async () => {
  const { el, button } = setup();
  const answer = button("U-Boot");
  answer.focus();
  await answer.fire("click");
  assert.ok(inTree(el, globalThis.document.activeElement), "focus stays on a button in the lab after a guess");
  assert.equal(globalThis.document.activeElement, answer, "the picked answer keeps focus");
  assert.equal(answer.attrs["aria-pressed"], "true");
  assert.match(el.find((n) => n.className === "bc__why").textContent, /^Why: macvmm wrote the DTB/);

  const jump = el.findAll((n) => n.className === "bc__jump")[1];
  jump.focus();
  await jump.fire("click");
  assert.equal(globalThis.document.activeElement, jump, "the lane button keeps focus");
  assert.equal(jump.attrs["aria-current"], "step");
  assert.equal(el.findAll((n) => n.attrs["aria-current"] === "step" && n.className === "bc__jump").length, 1);

  const back = button("Back");
  back.focus();
  await back.fire("click");
  assert.equal(back.disabled, true);
  assert.equal(globalThis.document.activeElement, button("Next step"), "Back hands focus to Next when it disables itself");
});

test("the question comes before the lanes, and scrolling tables are reachable", () => {
  const { el } = setup();
  const order = [...el.walk()].map((n) => n.className);
  assert.ok(order.indexOf("bc__question") < order.indexOf("bc__lanes"));
  const scrolls = el.findAll((n) => n.className === "bc__scroll");
  assert.equal(scrolls.length, 2);
  for (const sc of scrolls) {
    assert.equal(sc.attrs.tabindex, "0");
    assert.equal(sc.attrs.role, "region");
    assert.ok(sc.attrs["aria-label"]);
  }
  assert.ok(el.findAll((n) => n.tagName === "H3").length === 0, "inner headings sit below the embedded lab's h3");
});

test("ids are derived from ctx.id", () => {
  const { el } = setup();
  for (const n of el.findAll((x) => x.id)) assert.ok(n.id.startsWith("lab-boot-chain-1"), n.id);
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
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="boot-chain"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), "no hard-coded colors");
  }
});
