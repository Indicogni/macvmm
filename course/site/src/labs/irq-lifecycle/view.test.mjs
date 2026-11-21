// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that buttons, radios and the scenario menu drive the model, that the share
// hash is written and read back, and that nothing is ever parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
    if (k === "hidden") this.hidden = true;
  }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  prepend(k) { this.children.unshift(k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

function setup(hash = null, { path = "/build-your-own/vmm/labs/irq-lifecycle/", standalone = true } = {}) {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  globalThis.window = { location: { href: "x" } };
  globalThis.location = { pathname: path };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "irq-lifecycle", id: "lab-irq-lifecycle-1", base: "", standalone, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const button = (root, text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
const readout = (root) => root.findAll((e) => e.className === "il-readout")[0].textContent;
const historyRows = (root) => root.findAll((e) => e.tagName === "TBODY")[0].children.filter((r) => r.children.length > 1);

test("cpu mode: the lesson's sequence through the buttons", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(hash(), null, "the default state clears the hash");
  assert.match(readout(root), /^Start: the CPU has IRQs masked/);
  assert.ok(button(root, "Handler returns, cause kept").disabled, "no handler is running yet");
  for (const b of ["Source raises", "Time passes", "CPU unmasks IRQs", "Handler returns, cause kept", "Handler clears the cause"]) {
    const el = button(root, b);
    assert.ok(el && !el.disabled, b);
    el.dispatch("click");
  }
  assert.equal(hash(), "cpu.rwukc");
  assert.equal(historyRows(root).length, 5);
  assert.match(readout(root), /level line: line drops, done/);
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "cpu.rwuk");
  button(root, "Reset").dispatch("click");
  assert.equal(hash(), null);
  api.destroy();
});

test("gic mode from the hash, then a scenario walked with Next step", async () => {
  const { ctx, hash } = setup("gic-l.rie");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.match(readout(root), /INTID 33 is pending, line high\. Taken again at once: a storm/);
  const current = root.findAll((e) => e.tagName === "LI" && e.className.includes("il-state--current"));
  assert.equal(current.length, 1);
  assert.match(current[0].textContent, /pending \(current\)/);
  assert.equal(root.findAll((e) => e.attrs["aria-current"]).length, 0, "current state said once, not twice");
  assert.equal(root.findAll((e) => e.attrs["aria-live"]).length, 0, "announcements go through ctx.announce only");

  const sel = root.findAll((e) => e.tagName === "SELECT")[0];
  sel.value = "never";
  sel.dispatch("change");
  assert.equal(hash(), "gic-l.rie", "browsing the scenario list loads nothing");
  button(root, "Load scenario").dispatch("click");
  assert.equal(hash(), "gic-l");
  const next = button(root, "Next step");
  for (let i = 0; i < 7; i++) next.dispatch("click");
  assert.equal(hash(), "gic-l.rieieie");
  assert.ok(next.disabled);
  assert.ok(root.textContent.includes("irq: 985326 irqs intid=33"), "the real run is quoted");
  assert.ok(root.textContent.includes("12-no-drain.txt"));

  const edge = root.findAll((e) => e.tagName === "INPUT" && e.attrs.value === "edge")[0];
  edge.checked = true;
  edge.dispatch("change");
  assert.equal(hash(), "gic-e.rieieie", "the steps survive a trigger switch");
  button(root, "Reset").dispatch("click");
  button(root, "Device raises the line").dispatch("click");
  button(root, "CPU reads IAR").dispatch("click");
  assert.match(readout(root), /INTID 33 is active, line high\. Active only: the IAR cleared pending/);

  const cpu = root.findAll((e) => e.tagName === "INPUT" && e.attrs.value === "cpu")[0];
  cpu.checked = true;
  cpu.dispatch("change");
  assert.equal(hash(), null);
});

test("a hostile hash is ignored", async () => {
  const { ctx } = setup("gic-l.<img src=x>");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.match(readout(root), /^Start: the CPU has IRQs masked/);
});

test("shipped lab code avoids the builder's forbidden strings", () => {
  for (const f of ["view.mjs", "model.mjs"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8")
      .replace(/\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://"]) assert.ok(!src.includes(bad), `${f}: ${bad}`);
  }
  const view = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8");
  assert.match(view, /export function mount/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8");
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const sel = rule.split("{")[0].trim();
    if (!sel || sel.startsWith("@media")) continue;
    for (const part of sel.replace(/^@media[^{]*\{/, "").split(",")) assert.match(part.trim(), /^\.lab\[data-lab="irq-lifecycle"\]/, part);
  }
  assert.ok(!/#[0-9a-f]{3,6}\b|rgb\(/i.test(css), "tokens only, no hard-coded colors");
});

test("action buttons survive renders, so focus stays on the pressed button", async () => {
  const { ctx, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const raise = button(root, "Source raises");
  raise.dispatch("click");
  assert.equal(button(root, "Source raises"), raise, "same element after a render");
  // A focused control that becomes disabled hands focus to the readout.
  const ro = root.findAll((e) => e.className === "il-readout")[0];
  let focusedReadout = false;
  ro.focus = () => { focusedReadout = true; };
  const reset = button(root, "Reset");
  globalThis.document.activeElement = reset;
  reset.dispatch("click");
  assert.ok(reset.disabled && focusedReadout);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(said.length >= 1);
});

test("chapter 12's embed opens in the GIC view; chapter 11's in the CPU view", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup(null, { path: "/build-your-own/vmm/interrupts/gicv3/", standalone: false });
  let root = new FakeEl("div");
  mount(root, env.ctx);
  assert.match(readout(root), /^Start: INTID 33 \(level-triggered\)/);
  assert.equal(env.hash(), null, "the page's own start state writes no hash");
  assert.ok(button(root, "CPU reads IAR"));
  const cpu = root.findAll((e) => e.tagName === "INPUT" && e.attrs.value === "cpu")[0];
  cpu.checked = true;
  cpu.dispatch("change");
  assert.equal(env.hash(), "cpu");
  env = setup(null, { path: "/build-your-own/vmm/interrupts/timer-irq/", standalone: false });
  root = new FakeEl("div");
  mount(root, env.ctx);
  assert.match(readout(root), /^Start: the CPU has IRQs masked/);
  assert.ok(!root.textContent.includes("IAR ("), "no IAR vocabulary in chapter 11's view");
});
