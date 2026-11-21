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
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? textNode(k) : k); }
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
function textNode(s) { return { textContent: s }; }

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  globalThis.window = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }, location: { href: "x" } };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "mmio-trap", id: "lab-mmio-trap-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const buttons = (root) => Object.fromEntries(root.findAll((e) => e.tagName === "BUTTON").map((b) => [b.textContent, b]));
const stepText = (root) => root.findAll((e) => e.attrs["aria-label"] === "This step")[0].textContent;
const off = (b) => b.attrs["aria-disabled"] === "true";
const byLabel = (root, label) => root.findAll((e) => e.attrs["aria-label"] === label)[0];

test("mount renders the default program, steps through an exit, writes the share hash only after use", async () => {
  const { ctx, hash, said } = setup("#the-blank-note-on-your-mac".slice(1));
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.match(stepText(root), /^Step 0 of \d+: Ready/);
  assert.match(stepText(root), /watch the Exit and VMM pane/);
  // Mounting leaves a plain section anchor alone.
  assert.equal(hash(), "the-blank-note-on-your-mac");
  // Live regions: none of our own, so each step is announced once, through ctx.announce.
  assert.equal(root.findAll((e) => e.attrs["aria-live"]).length, 0);
  const b = buttons(root);
  assert.ok(off(b.Back));
  assert.equal(b.Back.disabled, false, "unavailable buttons stay focusable");
  for (let i = 0; i < 4; i++) b.Step.dispatch("click");
  assert.match(stepText(root), /Step 4 of \d+: Exit/);
  assert.equal(hash(), "sign.4.t");
  b.Step.dispatch("click");
  assert.match(stepText(root), /ISV = 1/);
  b.Back.dispatch("click");
  assert.equal(hash(), "sign.4.t");
  b["Run to end"].dispatch("click");
  assert.ok(off(b.Step) && off(b["Run to end"]) && off(b.Play));
  assert.equal(b.Step.disabled, false);
  const endHash = hash();
  b.Step.dispatch("click"); // a no-op, not an error
  assert.equal(hash(), endHash);
  assert.match(byLabel(root, "Exit trace").textContent, /"reg":3,"value":"0xffffffffffff8001"/);
  assert.match(byLabel(root, "Guest output").textContent, /ldrsh x sign-extends to 64 ok/);
  b.Reset.dispatch("click");
  assert.equal(hash(), "sign.0.t");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(said.length, 1, "debounced: one announcement for the burst of clicks");
  assert.match(said[0], /^Step 0 of \d+\. Ready/);
  // Every sideways-scrolling wrapper can take focus and has a name.
  const scrollers = root.findAll((e) => e.className === "mt-scroll");
  assert.ok(scrollers.length >= 6);
  for (const sc of scrollers) assert.ok(sc.attrs.tabindex === "0" && sc.attrs.role === "region" && sc.attrs["aria-label"], sc.attrs["aria-label"]);
  api.destroy();
});

test("a shared hash restores program, options and step; hostile hashes fall back", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup("isv0.9999.tg");
  let root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.match(byLabel(root, "Guest output").textContent, /FAILED: stp x: got \[0, 0\]/);
  assert.match(env.hash(), /^isv0\.\d+\.tg$/);

  env = setup("hole.99.l");
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.match(byLabel(root, "VMM messages").textContent, /ignored: --unhandled-mmio log/);

  for (const bad of ["<script>alert(1)</script>", "sign.0.t~0=%3Cimg%20src%3Dx%3E", "sign.1.zzz"]) {
    env = setup(bad);
    root = new FakeEl("div");
    mount(root, env.ctx).destroy();
    assert.match(stepText(root), /^Step 0 of \d+: Ready/, bad); // the sign program, at step 0 (text only: FakeEl throws on innerHTML)
    assert.equal(env.hash(), bad, "nothing is written until the reader acts");
  }
});

test("editing a line re-runs the program; a bad edit is refused with a message", async () => {
  const { ctx, hash, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const input = root.findAll((e) => e.tagName === "INPUT" && e.attrs.type === "text")[0];
  const lineSel = root.findAll((e) => e.tagName === "SELECT" && e.attrs.id?.endsWith("-line"))[0];
  const b = buttons(root);
  lineSel.value = "3";
  lineSel.dispatch("change");
  assert.equal(input.value, "strb w8, [x9]");
  input.value = "frobnicate x1";
  b.Apply.dispatch("click");
  assert.match(root.textContent, /Not applied:/);
  input.value = "strb w8, [x9], #1";
  b.Apply.dispatch("click");
  assert.match(hash(), /^sign\.0\.t~3=/);
  b["Run to end"].dispatch("click");
  assert.match(byLabel(root, "VMM messages").textContent, /insn at pc: 0x38001528/);
  b["Revert all lines"].dispatch("click");
  assert.equal(hash(), "sign.0.t");
  assert.ok(off(b["Revert all lines"]));
  await new Promise((r) => setTimeout(r, 350));
  assert.match(said[said.length - 1], /All lines reverted/);
});

test("changing program resets options to that program's machine", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const sel = root.findAll((e) => e.tagName === "SELECT" && e.attrs.id?.endsWith("-program"))[0];
  sel.value = "uart";
  sel.dispatch("change");
  assert.equal(hash(), "uart.0.u");
  buttons(root)["Run to end"].dispatch("click");
  assert.equal(byLabel(root, "Virtual terminal").textContent, "Hi");
});

test("shipped lab code avoids forbidden constructs", () => {
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "https://", "<script", "onload=", "onclick=", "javascript:", "foreignObject", "fetch(", "WebAssembly", "localStorage"]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
    if (f !== "fallback.svg") assert.ok(!code.includes("http://"), `${f} contains http://`);
  }
  const view = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8");
  assert.match(view, /export function mount\(/);
  const svg = readFileSync(fileURLToPath(new URL("./fallback.svg", import.meta.url)), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{").slice(-2, -1)[0]?.trim();
    if (!sel || sel.startsWith("@media")) continue;
    for (const s of sel.split(",")) {
      if (s.trim()) assert.ok(s.trim().startsWith('.lab[data-lab="mmio-trap"]'), `unscoped selector: ${s.trim()}`);
    }
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), "no hard-coded colors");
});
