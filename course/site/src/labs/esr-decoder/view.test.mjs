// view.mjs under a tiny fake DOM (Node built-ins only, no jsdom). It checks the behaviour a
// reader relies on: a quiet mount, roving tabindex in the bit bar, one announcement per toggle
// (with the new value, and a note when the summary holds), focus kept when EC changes the layout,
// error state cleared when a box is rewritten, decimal register fields, the typing pause, the
// share hash, Reset, the non-exception rows, and the focusable code and table regions.
import { test } from "node:test";
import assert from "node:assert/strict";

const PROPS = ["id", "type", "value", "tabIndex", "hidden", "checked", "href", "spellcheck", "autocomplete", "autocapitalize", "inputMode", "maxLength"];

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this._text = "";
    this.className = "";
    for (const p of PROPS) this[p] = p === "tabIndex" ? -1 : p === "hidden" || p === "checked" ? false : "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.scrollLeft = 0;
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
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
  append(...kids) {
    for (const k of kids) {
      const node = typeof k === "string" ? { textContent: k, parentNode: null } : k;
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...kids) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...kids);
  }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  fire(t, extra = {}) {
    const ev = { type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const fn of this.listeners[t] || []) fn(ev);
    return ev;
  }
  focus() {
    const prev = globalThis.document.activeElement;
    if (prev === this) return;
    globalThis.document.activeElement = this;
    if (prev instanceof FakeEl) prev.fire("blur");
    this.fire("focus");
  }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n._root === true;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  set textContent(v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
  matches(sel) { return sel.startsWith(".") ? this.classList.contains(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
  querySelectorAll(sel) { return [...this.walk()].slice(1).filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(hash = null, path = "/build-your-own/vmm/cpu/exit-loop/") {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  globalThis.location = { pathname: path, href: "x" };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "esr-decoder", id: "lab-esr-decoder-1", base: "", standalone: false, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const root = new FakeEl("div");
  root._root = true;
  return { ctx, said, root, hash: () => stored };
}

async function mounted(hash, path) {
  const env = setup(hash, path);
  const { mount } = await import("./view.mjs");
  env.api = mount(env.root, env.ctx);
  return env;
}

const bits = (root) => root.findAll((e) => e.classList.contains("esr__bit"));
const bitBtn = (root, n) => bits(root).find((b) => b.dataset.bit === String(n));
const box = (root, key) => root.findAll((e) => e.tagName === "INPUT" && e.dataset.key === key)[0];
const summary = (root) => root.findAll((e) => e.classList.contains("esr__summary"))[0].textContent;
const byClass = (root, c) => root.findAll((e) => e.classList.contains(c))[0];
const syndromeBox = (root) => root.findAll((e) => e.classList.contains("esr__input"))[0];

test("mount is quiet: no announcement and no hash write", async () => {
  const { said, hash, root, api } = await mounted(null);
  await wait(900);
  assert.deepEqual(said, []);
  assert.equal(hash(), null);
  assert.match(summary(root), /^Data abort from a lower EL \(EC 0x24\)\. Write of 4 bytes from w9\./);
  // A chapter gets a link to the primer, not the cards.
  assert.equal(root.findAll((e) => e.classList.contains("esr__cards")).length, 0);
  assert.equal(root.findAll((e) => e.attrs["aria-live"]).length, 0, "everything goes through ctx.announce");
  api.destroy();
});

test("the primer page shows the spec-hunt cards", async () => {
  const { root, api } = await mounted(null, "/build-your-own/vmm/primers/reading-arm-specs/");
  assert.equal(root.findAll((e) => e.classList.contains("esr__cards")).length, 1);
  api.destroy();
});

test("bit bar: roving tabindex with arrows, Home and End; the value is in each name", async () => {
  const { root, api } = await mounted(null);
  const all = bits(root);
  assert.equal(all.length, 32);
  assert.deepEqual(all.map((b) => b.tabIndex).filter((t) => t === 0).length, 1);
  assert.equal(all[0].tabIndex, 0);
  const row = all[0].parentNode;
  all[0].focus();
  row.fire("keydown", { key: "ArrowRight" });
  assert.equal(document.activeElement, all[1]);
  assert.equal(all[1].tabIndex, 0);
  assert.equal(all[0].tabIndex, -1);
  row.fire("keydown", { key: "End" });
  assert.equal(document.activeElement.dataset.bit, "0");
  row.fire("keydown", { key: "Home" });
  assert.equal(document.activeElement.dataset.bit, "31");
  row.fire("keydown", { key: "ArrowLeft" });
  assert.equal(document.activeElement.dataset.bit, "31", "stops at the edge");
  assert.equal(bitBtn(root, 24).attrs["aria-label"], "Bit 24, ISV, value 1");
  assert.equal(bitBtn(root, 24).getAttribute("aria-pressed"), null, "no pressed state to decode");
  // Hover previews another bit; leaving the row restores the focused one.
  const info = byClass(root, "esr__focusinfo");
  bitBtn(root, 6).fire("mouseenter");
  assert.match(info.textContent, /^Bit 6: WnR/);
  row.fire("mouseleave");
  assert.match(info.textContent, /^Bit 31: EC/);
  syndromeBox(root).focus();
  bitBtn(root, 6).fire("mouseenter");
  row.fire("mouseleave");
  assert.equal(info.textContent, "", "no bit focused: the line clears");
  api.destroy();
});

test("a toggle announces once, with the new value; a toggle that changes nothing says so", async () => {
  const { root, said, hash, api } = await mounted(null);
  bitBtn(root, 24).fire("click");
  await wait(400);
  assert.equal(said.length, 1);
  assert.match(said[0], /^ISV is now 0\. Data abort from a lower EL/);
  assert.equal(hash(), "0x92890046");
  assert.equal(bitBtn(root, 24).attrs["aria-label"], "Bit 24, ISV, value 0");
  bitBtn(root, 9).fire("click");
  await wait(400);
  assert.equal(said[1], "EA is now 1. The summary does not change.");
  bitBtn(root, 22).fire("click");
  await wait(400);
  assert.match(said[2], /^Bit 22 is now 1; SAS is now 3\./);
  api.destroy();
});

test("chapter 07: typing 31 into SRT selects the zero register", async () => {
  const { root, api } = await mounted(null);
  const srt = box(root, "srt");
  assert.equal(srt.value, "9", "SRT shows decimal, like the dump's SRT=9");
  assert.match(srt.attrs["aria-label"], /in decimal$/);
  assert.match(box(root, "dfsc").attrs["aria-label"], /in hex$/);
  srt.focus();
  srt.value = "31";
  srt.fire("keydown", { key: "Enter" });
  assert.match(summary(root), /Write of 4 bytes from wzr \(register 31 is the zero register here, never sp\)/);
  assert.equal(box(root, "srt").value, "31");
  api.destroy();
});

test("changing EC rebuilds the table but keeps focus on the EC box", async () => {
  const { root, api } = await mounted(null);
  const ec = box(root, "ec");
  ec.focus();
  ec.value = "0x16";
  ec.fire("keydown", { key: "Enter" });
  const now = document.activeElement;
  assert.notEqual(now, ec, "the row was rebuilt");
  assert.equal(now.dataset.key, "ec");
  assert.ok(now.isConnected);
  assert.equal(now.value, "0x16");
  assert.ok(box(root, "imm16"), "the immediate layout");
  api.destroy();
});

test("a bad field entry is cleared when a later render rewrites the box", async () => {
  const { root, api } = await mounted(null);
  const srt = box(root, "srt");
  srt.focus();
  srt.value = "zz";
  srt.fire("keydown", { key: "Enter" });
  assert.equal(srt.attrs["aria-invalid"], "true");
  assert.match(byClass(root, "esr__fieldmsg").textContent, /not a decimal digit/);
  bitBtn(root, 6).focus();
  bitBtn(root, 6).fire("click");
  assert.equal(srt.attrs["aria-invalid"], "false");
  assert.equal(srt.value, "9");
  api.destroy();
});

test("typing in the syndrome box waits for a pause and writes the hash only on change", async () => {
  const { root, said, hash, api } = await mounted(null);
  const input = syndromeBox(root);
  input.focus();
  for (const t of ["0x9", "0x93", "0x5a000000"]) { input.value = t; input.fire("input"); await wait(100); }
  assert.equal(hash(), null, "no hash while typing");
  await wait(400);
  assert.deepEqual(said, [], "300 ms is not enough of a pause");
  await wait(500);
  assert.equal(said.length, 1);
  assert.match(said[0], /^HVC #0x0/);
  input.fire("change");
  assert.equal(hash(), "0x5a000000");
  // A value that does not parse: once the reader leaves the box, the stale state is said in words.
  input.value = "0xzz";
  input.fire("input");
  bitBtn(root, 0).focus();
  const stale = byClass(root, "esr__stale");
  assert.equal(stale.hidden, false);
  assert.match(stale.textContent, /still show the last valid value, 0x5a00_0000/);
  assert.equal(input.attrs["aria-invalid"], "true");
  api.destroy();
});

test("a non-exception reason greys every row; Reset clears the hash", async () => {
  const { root, hash, api } = await mounted("vtimer:0x93890046");
  const rows = root.findAll((e) => e.tagName === "TR" && e.parentNode?.tagName === "TBODY");
  assert.ok(rows.length > 5);
  assert.ok(rows.every((r) => r.className === "esr__row--unused"));
  assert.ok(root.findAll((e) => e.classList.contains("esr__meaning")).every((m) => m.textContent === "Not used for this exit reason"));
  assert.match(summary(root), /interrupt controller Hypervisor\.framework emulates/);
  const reset = root.findAll((e) => e.tagName === "BUTTON" && e.textContent === "Reset")[0];
  reset.fire("click");
  assert.equal(hash(), null);
  assert.match(summary(root), /Write of 4 bytes from w9/);
  api.destroy();
});

test("the code block and an overflowing table can take focus and have names", async () => {
  const { root, api } = await mounted(null);
  const pre = root.findAll((e) => e.tagName === "PRE")[0];
  assert.equal(pre.tabIndex, 0);
  assert.equal(pre.attrs["aria-label"], "Match arm from exit.rs");
  const wrap = byClass(root, "esr__tablewrap");
  assert.equal(wrap.getAttribute("tabindex"), null, "not focusable while it fits");
  wrap.scrollWidth = 600;
  wrap.clientWidth = 300;
  bitBtn(root, 9).fire("click");
  assert.equal(wrap.getAttribute("tabindex"), "0");
  assert.equal(wrap.getAttribute("role"), "region");
  assert.equal(wrap.getAttribute("aria-label"), "Fields table, scrolls sideways");
  api.destroy();
});
