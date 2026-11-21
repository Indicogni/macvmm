// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that Step/Back and the poke forms drive the model, that the share hash is
// written and read back, and that nothing is ever parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REFERENCE, replay, formatTable } from "./model.mjs";

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
    this.value = "";
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(" ").filter(Boolean));
        if (on) set.add(c); else set.delete(c);
        self.className = [...set].join(" ");
      },
      contains(c) { return self.className.split(" ").includes(c); },
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
    if (k === "hidden") this.hidden = true;
  }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t, preventDefault() { this.defaultPrevented = true; } }); }
  focus() { globalThis.document.activeElement = this; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

async function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  globalThis.window = { location: { href: "x" } };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "pl011-poke", id: "lab-pl011-poke-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const btn = (text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  const byId = (suffix) => root.findAll((e) => e.attrs.id === `${ctx.id}-${suffix}`)[0];
  const byClass = (c) => root.findAll((e) => e.classList.contains(c))[0];
  const forms = root.findAll((e) => e.tagName === "FORM");
  return { root, ctx, said, handle, btn, byId, byClass, forms, hash: () => stored };
}

test("mounts on the lesson's walk and steps to the capture's table", async () => {
  const t = await setup();
  assert.equal(t.hash(), null, "an untouched lab writes no hash");
  assert.ok(t.btn("Back").disabled);
  assert.match(t.byClass("pp-next").textContent, /write DR = 'h' \(0x68\)/);
  for (let i = 0; i < REFERENCE.length; i++) t.btn("Step").dispatch("click");
  assert.equal(t.hash(), "w0.68_w38.10_h6f6b_w44.70_r0_r0_r0");
  assert.ok(t.btn("Step").disabled);
  assert.equal(t.byClass("pp-plain").textContent, formatTable(replay(REFERENCE)));
  assert.match(t.byClass("pp-term").textContent, /"h"/);
  t.btn("Back").dispatch("click");
  assert.equal(t.hash(), "w0.68_w38.10_h6f6b_w44.70_r0_r0_r0~6");
  t.handle.destroy();
});

test("a prediction is scored on Step", async () => {
  const t = await setup("w0.68_w38.10_h6f6b_w44.70_r0_r0_r0~2");
  const sel = t.byId("guess");
  sel.value = "high";
  sel.dispatch("change");
  t.btn("Step").dispatch("click"); // host types "ok": the line goes high
  assert.match(t.byClass("pp-score").textContent, /after step 3: right/);
  assert.match(t.byClass("pp-line").textContent, /HIGH/);
  t.handle.destroy();
});

test("Run to end scores the next step; Back says the guess was not scored", async () => {
  const t = await setup("w0.68_w38.10_h6f6b_w44.70_r0_r0_r0~2");
  const sel = t.byId("guess");
  sel.value = "low";
  sel.dispatch("change");
  t.btn("Run to end").dispatch("click");
  assert.match(t.byClass("pp-score").textContent, /low after step 3; the line is high/);
  t.btn("Back").dispatch("click");
  sel.value = "high";
  sel.dispatch("change");
  t.btn("Back").dispatch("click");
  assert.match(t.byClass("pp-msg").textContent, /not scored/);
  t.handle.destroy();
});

test("one announce channel, a marked current row, keyed bit tables", async () => {
  const t = await setup();
  assert.equal(t.byClass("pp-readout").attrs["aria-live"], undefined);
  t.btn("Step").dispatch("click");
  const current = t.root.findAll((e) => e.tagName === "TR" && e.attrs["aria-current"] === "step");
  assert.equal(current.length, 1);
  assert.match(current[0].textContent, /\(current\)/);
  const keys = t.root.findAll((e) => e.classList.contains("pp-key"));
  assert.equal(keys.length, 2);
  assert.match(keys[0].textContent, /RXFEreceive FIFO empty/);
  assert.ok(t.root.findAll((e) => e.attrs.title !== undefined).length === 0, "no meaning hidden in title");
  t.handle.destroy();
});

test("focus moves off a button that becomes disabled", async () => {
  const t = await setup("w0.68~0");
  const step = t.btn("Step");
  step.focus();
  step.dispatch("click");
  assert.ok(step.disabled);
  assert.equal(globalThis.document.activeElement, t.btn("Back"));
  t.btn("Back").dispatch("click");
  assert.equal(globalThis.document.activeElement, step);
  t.handle.destroy();
});

test("Enter submits the forms; a 32-byte FIFO lists one summary for its empty slots", async () => {
  const t = await setup("~0");
  assert.equal(t.forms.length, 2);
  t.byId("reg").value = "44"; // LCR_H (0x02c)
  t.byId("val").value = "0x10";
  t.forms[0].dispatch("submit");
  assert.equal(t.hash(), "w2c.10");
  t.byId("text").value = "abc";
  t.forms[1].dispatch("submit");
  assert.equal(t.hash(), "w2c.10_h616263");
  const fifo = t.root.findAll((e) => e.tagName === "OL")[0];
  assert.equal(fifo.children.length, 4);
  assert.match(fifo.children[3].textContent, /29 empty slots/);
  t.handle.destroy();
});

test("poking replaces the rest of the walk and updates the hash", async () => {
  const t = await setup();
  t.byId("val").value = "0x41";
  t.forms[0].dispatch("submit");
  assert.equal(t.hash(), "w0.41");
  assert.match(t.byClass("pp-msg").textContent, /7 remaining steps/);
  t.byId("text").value = "hi";
  t.forms[1].dispatch("submit");
  t.btn("Press Enter (0x0d)").dispatch("click");
  assert.equal(t.hash(), "w0.41_h6869_h0d");
  t.byId("reg").value = "24"; // FR (0x018)
  t.btn("Read").dispatch("click");
  assert.equal(t.hash(), "w0.41_h6869_h0d_r18");
  assert.match(t.byClass("pp-readout").textContent, /read FR returned 0xc0/);
  t.byId("val").value = "nope";
  t.forms[0].dispatch("submit");
  assert.match(t.byClass("pp-msg").textContent, /Not applied/);
  assert.equal(t.hash(), "w0.41_h6869_h0d_r18");
  t.byId("reg").value = "other";
  t.byId("off").value = "0xffe";
  t.btn("Read").dispatch("click");
  assert.match(t.byClass("pp-msg").textContent, /past the end/);
  t.btn("Clear all steps").dispatch("click");
  assert.equal(t.hash(), "~0");
  t.btn("Load the lesson's walk").dispatch("click");
  assert.equal(t.hash(), null);
  t.handle.destroy();
});

test("a hostile hash falls back to the lesson's walk", async () => {
  const t = await setup("<img src=x onerror=alert(1)>");
  assert.equal(t.hash(), null);
  assert.match(t.byClass("pp-next").textContent, /1 of 7/);
  t.handle.destroy();
});

test("shipped lab code avoids the builder's banned strings", () => {
  for (const f of ["view.mjs", "model.mjs"]) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
});
