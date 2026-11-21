// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, step through the
// round, check the share hash, the spoiler toggle, the calculator, and the static rules from
// LABS.md section 7.
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
  const el = new FakeNode("div");
  const ctx = {
    name: "timer-timeline", id: "lab-timer-timeline-1", base: "", standalone: false, reducedMotion: true,
    announce() {}, hash: { get: () => hash, set: (v) => { hash = v; } },
  };
  const handle = mount(el, ctx);
  const button = (text) => el.find((n) => n.tagName === "BUTTON" && n.textContent === text);
  const live = () => el.find((n) => n.className === "tt__summary").textContent;
  return { el, handle, button, live, getHash: () => hash };
}

test("mounts, steps through the round, writes the hash", async () => {
  const { el, button, live, getHash } = setup();
  assert.match(live(), /Before the round/);
  assert.equal(getHash(), null);
  // future columns are hidden as "?"
  assert.ok(el.findAll((n) => n.className.includes("tt__cell--future")).length > 0);
  for (let i = 0; i < 5; i++) await button("Step").fire("click");
  assert.equal(getHash(), "r-t-5");
  assert.match(live(), /Step 5 of 9, 212\.565 ms: exit 2 VTIMER_ACTIVATED/);
  for (let i = 0; i < 10; i++) await button("Step").fire("click");
  assert.match(live(), /Timer exits this round: 3/);
  assert.equal(button("Step").disabled, true);
  await button("Reset").fire("click");
  assert.equal(getHash(), null);
});

test("restores a shared state and hides exit 3's cause until revealed", async () => {
  const { el, live, getHash } = setup("r-t-8");
  assert.match(live(), /Step 8 of 9/);
  assert.doesNotMatch(el.textContent, /CANCELED|kick/);
  const reveal = el.find((n) => n.id === "lab-timer-timeline-1-reveal");
  reveal.checked = true;
  await reveal.fire("change");
  assert.equal(getHash(), "r-t-8-x");
  assert.match(el.textContent, /CANCELED/);
});

test("a bad hash falls back to the default; arrows move between steps", async () => {
  const { el, live, getHash } = setup("<script>");
  assert.match(live(), /Before the round/);
  const colBtn = el.find((n) => n.className === "tt__colbtn" && n.attrs["aria-current"] === "step");
  await colBtn.fire("keydown", { key: "End" });
  assert.equal(getHash(), "r-t-9");
  const cur = el.find((n) => n.className === "tt__colbtn" && n.attrs["aria-current"] === "step");
  await cur.fire("keydown", { key: "ArrowLeft" });
  assert.equal(getHash(), "r-t-8");
});

test("the offset switch and the calculator", async () => {
  const { el, getHash } = setup();
  const zero = el.find((n) => n.id === "lab-timer-timeline-1-offset-zero");
  zero.checked = true;
  await zero.fire("change");
  assert.equal(getHash(), "z-t-0");
  assert.match(el.textContent, /3,583,539,855,220/);
  const out = () => el.find((n) => n.className === "tt__calcout").textContent;
  assert.match(out(), /Sleep for 99\.998 ms/);
  const ist = () => el.find((n) => n.className === "tt__istatus").textContent;
  assert.match(ist(), /ISTATUS \(read-only, computed by the hardware\): 0/);
  const cval = el.find((n) => n.id === "lab-timer-timeline-1-c-cval");
  cval.value = "0x1_0000_0000_0000_0000";
  await cval.fire("input");
  assert.match(out(), /Not a 64-bit value/);
  cval.value = "0";
  await cval.fire("input");
  assert.match(out(), /Wake now: ISTATUS is already set/);
  assert.match(ist(), /computed by the hardware\): 1/);
});

test("focus moves off a button that becomes disabled; labels start with the visible text", async () => {
  const { el, button } = setup("r-t-1");
  const back = button("Step back");
  back.focus();
  await back.fire("click");
  assert.equal(back.disabled, true);
  assert.equal(globalThis.document.activeElement, button("Step"));
  const cols = el.findAll((n) => n.className === "tt__colbtn");
  assert.match(cols[0].attrs["aria-label"], /^start, /);
  assert.match(cols[1].attrs["aria-label"], /^step 1, about .* estimated$/);
  assert.match(cols[2].attrs["aria-label"], /^step 2, 107\.512 ms, from the trace$/);
  const play = el.find((n) => n.tagName === "BUTTON" && n.textContent === "Play");
  assert.equal(play.attrs["aria-pressed"], undefined);
});

test("stepping scrolls the current column into view without moving focus", async () => {
  const { el, button } = setup();
  const cols = el.findAll((n) => n.className === "tt__colbtn");
  const seen = [];
  cols.forEach((c, i) => { c.scrollIntoView = () => seen.push(i); });
  const step = button("Step");
  step.focus();
  await step.fire("click");
  await step.fire("click");
  assert.deepEqual(seen, [1, 2]);
  assert.equal(globalThis.document.activeElement, step);
});

test("the offset bug toggle shows the spin", async () => {
  const { el } = setup();
  const forget = el.find((n) => n.id === "lab-timer-timeline-1-c-forget");
  forget.checked = true;
  await forget.fire("change");
  const out = el.find((n) => n.className === "tt__calcout").textContent;
  assert.match(out, /offset used: 0/);
  assert.match(out, /spins in WFI exits/);
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
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "style=", ".style.", "localStorage"]) {
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
      assert.match(part.trim(), /^\.lab\[data-lab="timer-timeline"\]/, `scoped: ${part.trim()}`);
    }
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b|rgb\(/, "tokens only");
});
