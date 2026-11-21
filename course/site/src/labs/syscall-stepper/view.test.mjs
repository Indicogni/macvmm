// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that Step/Back/scenario changes drive the model, that the share hash is written
// and read back, and that no untrusted string is ever parsed as HTML.
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
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? textNode(k) : k); }
  prepend(k) { this.children.unshift(k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  focus() { globalThis.document.activeElement = this; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}
function textNode(s) { return { textContent: s }; }

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  globalThis.window = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }, location: { href: "x" } };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "syscall-stepper", id: "lab-syscall-stepper-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const buttons = (root) => Object.fromEntries(root.findAll((e) => e.tagName === "BUTTON").map((b) => [b.textContent, b]));
const readout = (root) => root.findAll((e) => e.className === "ss-readout")[0].textContent;
const flush = () => new Promise((r) => setTimeout(r, 350));

test("mount renders, steps through svc, writes the share hash", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.match(readout(root), /^Step 0 of 13\. user mode \(EL0\), PC 0x1000/);
  assert.equal(hash(), null, "a fresh mount leaves the page's hash alone");
  assert.equal(root.findAll((e) => "aria-live" in e.attrs).length, 0, "one announcement channel: ctx.announce");
  const b = buttons(root);
  b.Step.dispatch("click");
  b.Step.dispatch("click");
  assert.match(readout(root), /kernel mode \(EL1\), PC 0x8400\. Saved return address: 0x1008\. Reason: system call: svc #0x80/);
  assert.equal(hash(), "svc-2");
  b.Back.dispatch("click");
  assert.equal(hash(), "svc-1");
  b["Run to end"].dispatch("click");
  assert.ok(b.Step.disabled);
  assert.match(readout(root), /final loop/);
  b.Reset.dispatch("click");
  assert.equal(hash(), null, "the default svc-0 clears the hash");
  api.destroy();
});

test("share hash restores a step; hostile hash falls back to the start", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup("null-999-arm");
  let root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.match(readout(root), /signal 11/);
  assert.match(readout(root), /139/);
  assert.equal(env.hash(), "null-12-arm");
  assert.ok(root.classList.contains("ss-show-arm"));

  env = setup("<script>alert(1)</script>");
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.equal(env.hash(), null, "a hostile hash is cleared");
});

test("prediction scoring shows in the panel", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  const boxes = root.findAll((e) => e.tagName === "INPUT" && e.attrs.id?.includes("-pred-"));
  assert.equal(boxes.length, 4);
  const pcBox = boxes.find((x) => x.attrs.id.endsWith("-pc"));
  pcBox.checked = true;
  pcBox.dispatch("change");
  buttons(root).Step.dispatch("click");
  assert.match(root.textContent, /Your prediction: 4 of 4 labels right\./);
});

test("each step is announced once, with the why, the changes and the score", async () => {
  const { ctx, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  const b = buttons(root);
  b.Step.dispatch("click");
  b.Step.dispatch("click"); // the svc
  await flush();
  assert.equal(said.length, 1, "throttled: the latest text wins");
  assert.match(said[0], /svc #0x80.*save the old mode.*record the reason/);
  assert.match(said[0], /Changed: mode, PC, saved return address, reason\./);
  assert.match(said[0], /Your prediction: 0 of 4 right\./);
  api.destroy();
});

test("turning prediction off hides scoring", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  const box = root.findAll((e) => e.attrs.id === `${ctx.id}-predict`)[0];
  assert.ok(box.checked, "predicting is on by default");
  box.checked = false;
  box.dispatch("change");
  assert.ok(root.classList.contains("ss-no-predict"));
  buttons(root).Step.dispatch("click");
  assert.doesNotMatch(root.textContent, /Your prediction/);
  api.destroy();
});

test("keyboard focus survives a button being disabled", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  const b = buttons(root);
  b.Step.focus();
  for (let i = 0; i < 20; i++) if (!b.Step.disabled) b.Step.dispatch("click");
  assert.ok(b.Step.disabled);
  assert.equal(document.activeElement, b.Reset, "Step at the end hands focus to Reset");
  b.Back.focus();
  for (let i = 0; i < 20; i++) if (!b.Back.disabled) b.Back.dispatch("click");
  assert.equal(document.activeElement, b.Step, "Back at step 0 hands focus to Step");
  b["Run to end"].focus();
  b["Run to end"].dispatch("click");
  assert.equal(document.activeElement, b.Reset);
  assert.ok(!document.activeElement.disabled);
  api.destroy();
});

test("code listings keep list semantics and the reader sees left-over values explained", async () => {
  const { ctx } = setup("svc-12");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  const lists = root.findAll((e) => e.tagName === "OL");
  assert.equal(lists.length, 2);
  for (const l of lists) assert.equal(l.attrs.role, "list");
  const note = root.findAll((e) => /left over|still show the last exception/.test(e._text))[0];
  assert.ok(note && !note.hidden, "after eret the left-over note is shown");
  assert.match(root.textContent, /cmp  x16, #20/);
});

test("shipped lab code avoids forbidden constructs", () => {
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "https://", "<script", "onload=", "onclick=", "javascript:", "foreignObject"]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
    if (f !== "fallback.svg") assert.ok(!code.includes("http://"), `${f} contains http://`);
  }
  const svg = readFileSync(fileURLToPath(new URL("./fallback.svg", import.meta.url)), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{")[0].trim();
    if (!sel || sel.startsWith("@media") || !block.includes("{")) continue;
    for (const s of sel.replace(/@media[^{]*/, "").split(",")) {
      if (s.trim()) assert.ok(s.trim().startsWith('.lab[data-lab="syscall-stepper"]'), `unscoped selector: ${s.trim()}`);
    }
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), "no hard-coded colors");
});
