// Smoke test for view.mjs with a tiny fake DOM (no dependencies). It checks that mount() builds,
// that events reach the model, that the share hash is written, and that ids carry ctx.id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./view.mjs";

class Node {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.childNodes = [];
    this.attrs = new Map();
    this.listeners = new Map();
    this.parentNode = null;
    this.style = {};
    this.hidden = false;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this._text = "";
    const cls = new Set();
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c) || (this.attrs.get("class") ?? "").split(" ").includes(c),
      toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)),
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k) { this.attrs.delete(k); }
  appendChild(n) {
    n.parentNode = this;
    this.childNodes.push(n);
    if (n instanceof Node) this.children.push(n);
    return n;
  }
  append(...ns) { for (const n of ns) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n); }
  replaceChildren(...ns) { this.children = []; this.childNodes = []; this.append(...ns); }
  get textContent() { return this._text || this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(t) { this._text = String(t); this.children = []; this.childNodes = []; }
  addEventListener(type, fn) { (this.listeners.get(type) ?? this.listeners.set(type, []).get(type)).push(fn); }
  dispatch(type, ev = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, ...ev }); }
  focus() { this.ownerDocument.activeElement = this; this.dispatch("focus"); }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
}

function fakeDoc() {
  const doc = { activeElement: null };
  doc.createElement = (t) => new Node(doc, t);
  doc.createTextNode = (t) => ({ textContent: String(t), parentNode: null });
  return doc;
}

function setup(hash = null) {
  const doc = fakeDoc();
  const el = doc.createElement("div");
  const said = [];
  const hashes = [];
  const ctx = {
    name: "a64-encoder", id: "lab-a64-encoder-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => hash, set: (s) => hashes.push(s) },
  };
  const handle = mount(el, ctx);
  const all = [...el.walk()];
  const byId = (s) => all.find((n) => n.getAttribute("id") === `${ctx.id}-${s}`);
  const bits = all.filter((n) => n.classList.contains("a64__bit"));
  return { el, all, byId, bits, said, hashes, handle };
}

test("mount builds the first screen with all three layouts and 32 bit buttons", () => {
  const { el, all, bits, handle } = setup();
  const text = el.textContent;
  for (const s of ["movz x0, #0x2a", "hvc #0", "b .", "0xD2800540", "40 05 80 d2", "imm16", "imm26", "LL", "Rd"]) {
    assert.ok(text.includes(s), `first screen shows ${s}`);
  }
  assert.equal(bits.length, 32);
  assert.equal(bits.filter((b) => b.getAttribute("tabindex") === "0").length, 1, "roving tabindex");
  for (const n of all) {
    const id = n.getAttribute("id");
    if (id) assert.ok(id.startsWith("lab-a64-encoder-1-"), id);
    if (n.tagName === "BUTTON") assert.ok(n.textContent || n.getAttribute("aria-label"), "button has a name");
  }
  handle.destroy();
});

test("typing in a field re-encodes; the hash follows", async () => {
  const { el, byId, hashes, said, handle } = setup();
  const rd = byId("rd");
  rd.value = "1";
  rd.dispatch("input");
  assert.ok(el.textContent.includes("0xD2800541"));
  assert.equal(hashes.at(-1), "e:d2800541");
  await new Promise((r) => setTimeout(r, 350));
  assert.match(said.at(-1), /movz x1, #0x2a/);
  handle.destroy();
});

test("bit clicks and arrow keys work; fixed bits are refused", () => {
  const { el, bits, handle } = setup();
  const bit = (n) => bits[31 - n];
  bit(21).dispatch("click");
  assert.ok(el.textContent.includes("0xD2A00540"));
  bit(25).dispatch("click");
  assert.ok(el.textContent.includes("0xD2A00540"));
  assert.match(el.textContent, /fixed bits/);
  bit(5).focus();
  bits[0].parentNode.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(bit(6).getAttribute("tabindex"), "0");
  handle.destroy();
});

test("a shared puzzle opens unrevealed, then Tell me reveals it", () => {
  const { el, all, handle } = setup("d:97fffff7@6c");
  assert.ok(!el.textContent.includes("bl .-0x24"));
  const tell = all.find((n) => n.tagName === "BUTTON" && n.textContent === "Tell me");
  assert.equal(tell.getAttribute("aria-label"), "Tell me what this word is");
  tell.focus();
  tell.dispatch("click");
  assert.ok(el.textContent.includes("bl .-0x24"));
  assert.ok(el.textContent.includes("bl 0x48"));
  const active = el.ownerDocument.activeElement;
  assert.ok(active && active !== tell, "focus leaves the hidden button");
  assert.equal(active.textContent, "Readout");
  assert.equal(active.getAttribute("tabindex"), "-1");
  handle.destroy();
});

test("the example select stays on the chosen preset and clears when the word changes", () => {
  const { byId, handle } = setup();
  const sel = byId("preset");
  sel.value = "ch02-hvc";
  sel.dispatch("change");
  assert.equal(sel.value, "ch02-hvc", "not snapped back to the placeholder");
  sel.value = "try-lsl";
  sel.dispatch("change");
  assert.equal(sel.value, "try-lsl", "a second change (arrow key) applies the next example");
  const imm = byId("imm16");
  imm.value = "0x2b";
  imm.dispatch("input");
  assert.equal(sel.value, "");
  handle.destroy();
});

test("fixed bits are marked aria-disabled in Encode mode only; Take apart focuses the Bits heading", () => {
  const { el, all, bits, byId, handle } = setup();
  const bit = (n) => bits[31 - n];
  assert.equal(bit(25).getAttribute("aria-disabled"), "true");
  assert.match(bit(25).getAttribute("aria-label"), /cannot flip in Encode mode/);
  assert.equal(bit(5).getAttribute("aria-disabled"), null);
  byId("mode-d").dispatch("change");
  assert.equal(bit(25).getAttribute("aria-disabled"), null);
  const take = all.find((n) => n.getAttribute("aria-label") === "Take apart b .");
  take.dispatch("click");
  assert.equal(el.ownerDocument.activeElement.textContent, "Bits");
  assert.ok(el.textContent.includes("b 0x40000008"));
  assert.match(el.textContent, /the bits store only the distance/);
  handle.destroy();
});

test("pasting dump bytes decodes the little-endian word and explains it", () => {
  const { el, byId, handle } = setup();
  byId("mode-d").dispatch("change");
  const hex = byId("hex");
  hex.value = "ff 43 00 d1";
  hex.dispatch("input");
  assert.ok(el.textContent.includes("0xD10043FF"));
  assert.match(el.textContent, /bytes in memory order/);
  assert.match(el.textContent, /objdump -d/);
  assert.ok(!el.textContent.includes("llvm-objdump"));
  handle.destroy();
});

test("text scrollers with nothing focusable inside are focusable named regions", () => {
  const { all, handle } = setup();
  for (const n of all.filter((x) => x.classList.contains("a64__scroll"))) {
    const hasButton = [...n.walk()].some((x) => x !== n && x.tagName === "BUTTON");
    if (hasButton) continue;
    assert.equal(n.getAttribute("tabindex"), "0");
    assert.equal(n.getAttribute("role"), "region");
    assert.ok(n.getAttribute("aria-label"));
  }
  handle.destroy();
});
