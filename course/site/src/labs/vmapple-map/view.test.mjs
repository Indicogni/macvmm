// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, switch evidence off,
// select a row, look up an address, check the share hash, and check the static rules from
// LABS.md sections 4, 5 and 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
  // A browser blurs a focused element when it (or an ancestor) leaves the document, even if
  // it is put back at once; this fake does the same, so lost focus shows up in the tests.
  _detachAll() {
    for (const c of this.children) {
      if (c instanceof FakeNode) {
        if (c.contains(document.activeElement)) document.activeElement = document.body;
        c.parent = null;
      }
    }
    this.children = [];
  }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeText(k) : k;
      if (n instanceof FakeNode) {
        if (n.parent) {
          if (n.contains(document.activeElement)) document.activeElement = document.body;
          n.parent.children = n.parent.children.filter((c) => c !== n);
        }
        n.parent = this;
      }
      this.children.push(n);
    }
  }
  replaceChildren(...kids) { this._detachAll(); this.append(...kids); }
  set textContent(v) { this._detachAll(); this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async fire(type, ev = {}) { for (const fn of this.listeners[type] || []) await fn({ type, ...ev }); }
  focus() { document.activeElement = this; }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeNode) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
}
class FakeText { constructor(t) { this.textContent = t; } }

const body = new FakeNode("body");
globalThis.document = {
  body, activeElement: body,
  createElement: (t) => new FakeNode(t), createTextNode: (t) => new FakeText(t),
};

const { mount } = await import("./view.mjs");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(initialHash = null) {
  let hash = initialHash;
  let sets = 0;
  const el = new FakeNode("div");
  body.replaceChildren(el);
  const ctx = {
    name: "vmapple-map", id: "lab-vmapple-map-1", base: "", standalone: false, reducedMotion: true,
    announce() {}, hash: { get: () => hash, set: (v) => { hash = v; sets += 1; } },
  };
  const handle = mount(el, ctx);
  const button = (label) => el.find((n) => n.tagName === "BUTTON" && n.textContent === label);
  const chip = (label) => el.find((n) => n.tagName === "BUTTON" && n.className.startsWith("vm__chip") && n.textContent === label);
  const box = (key) => el.find((n) => n.tagName === "INPUT" && n.id === `lab-vmapple-map-1-ev-${key}`);
  const label = (key) => el.find((n) => n.tagName === "LABEL" && n.attrs.for === `lab-vmapple-map-1-ev-${key}`);
  const live = el.find((n) => n.attrs["aria-live"] === "polite");
  const full = el.find((n) => n.className === "vm__summary");
  const pre = el.find((n) => n.tagName === "PRE");
  const addr = el.find((n) => n.tagName === "INPUT" && n.attrs.type === "text");
  return { el, handle, button, chip, box, label, live, full, pre, addr, hash: () => hash, sets: () => sets };
}

test("mounts with QEMU and the zero run on; the all-ones run is hidden until asked for", async () => {
  const { el, full, pre, box, label, button, hash } = setup();
  assert.ok(box("q").checked && box("z").checked && !box("o").checked);
  assert.equal(label("o").hidden, true);
  assert.match(full.textContent, /^cfg at 0x0040_0000: observed\. Seen in the reference runs: 33 accesses, all unmodelled\./);
  assert.match(pre.textContent, /bdif      0x30000000   inferred +no access seen/);
  const heads = el.findAll((n) => n.tagName === "H3").map((n) => n.textContent);
  assert.ok(heads.includes("Observed (5)") && heads.includes("Inferred (5)") && heads.includes("Unknown (6)"), heads.join("|"));
  assert.equal(el.findAll((n) => n.tagName === "TR").length, 17, "header plus 16 rows");
  assert.equal(hash(), null);
  // Nothing from the all-ones run is on the page yet.
  assert.doesNotMatch(el.textContent, /16 distinct|2 in bdif|63 accesses|SYSTEM_RESET|reached only with all ones|where bdif goes|reaches bdif/);
  assert.match(el.textContent, /All-ones run: unknown reads return all ones \(hidden\)/);
  // Reveal: the checkbox appears, switched on, and takes the focus the button had.
  const reveal = button("Show the all-ones run");
  reveal.focus();
  await reveal.fire("click");
  assert.equal(label("o").hidden, false);
  assert.ok(box("o").checked);
  assert.equal(document.activeElement, box("o"));
  assert.equal(reveal.hidden, true);
  assert.equal(hash(), "qzo");
  assert.match(pre.textContent, /bdif      0x30000000   observed \(all-ones only\)  reached only with all ones/);
  assert.match(el.textContent, /11 boots, 16 distinct addresses/);
});

test("pressing a row button keeps keyboard focus on that button", async () => {
  const { chip, live, full } = setup();
  const b = chip("pvpanic");
  b.focus();
  await b.fire("click");
  assert.equal(document.activeElement, b, "same button, still focused");
  assert.equal(b.attrs["aria-current"], "true");
  assert.equal(chip("cfg").attrs["aria-current"], undefined);
  assert.match(full.textContent, /^pvpanic at 0x2007_0000: observed/);
  assert.equal(live.textContent, "pvpanic: observed. Map: 5 observed, 5 inferred, 6 unknown.");
});

test("a chip that moves column when evidence changes keeps focus", async () => {
  const { chip, box } = setup("qzo@bdif");
  const b = chip("bdif");
  b.focus();
  box("o").checked = false;
  await box("o").fire("change"); // bdif moves from Observed to Inferred
  assert.equal(document.activeElement, b);
});

test("the table has no buttons: the chips are the only row selectors", () => {
  const { el } = setup();
  const table = el.find((n) => n.tagName === "TABLE");
  assert.equal(table.findAll((n) => n.tagName === "BUTTON").length, 0);
  const chips = el.findAll((n) => n.tagName === "BUTTON" && n.className.startsWith("vm__chip"));
  assert.equal(chips.length, 16);
  assert.ok(chips.every((c) => c.attrs["aria-pressed"] === undefined));
});

test("switching the all-ones run off moves bdif to inferred; the hash records it", async () => {
  const { el, chip, box, full, hash, button } = setup("qzo");
  box("o").checked = false;
  await box("o").fire("change");
  await chip("bdif").fire("click");
  assert.equal(hash(), "qz+@bdif");
  assert.match(full.textContent, /^bdif at 0x3000_0000: inferred\./);
  assert.match(el.textContent, /All-ones run: unknown reads return all ones \(switched off\)/);
  await button("Reset").fire("click");
  assert.equal(hash(), null);
  assert.ok(!box("o").checked);
});

test("switching QEMU's sources off hides QEMU's names, sizes and interrupts", async () => {
  const { el, box, full } = setup();
  box("q").checked = false;
  await box("q").fire("change");
  assert.match(full.textContent, /^unnamed, at 0x0040_0000: observed\./);
  const table = el.find((n) => n.tagName === "TABLE");
  assert.match(table.textContent, /QEMU's sources switched off/);
  for (const n of ["PL011 UART", "GIC distributor", "64 KiB", "SPI 1", "bdif"]) assert.ok(!table.textContent.includes(n), n);
  assert.match(el.textContent, /QEMU's board: switched off/);
});

test("the shared reference opens at bdif without the all-ones run, and leaks none of it", async () => {
  const { el, full, box, button } = setup("qz@bdif");
  assert.equal(box("o").checked, false);
  assert.match(full.textContent, /^bdif at 0x3000_0000: inferred/);
  assert.doesNotMatch(el.textContent, /reaches bdif|every other unknown read|all-ones only|reached only with all ones/);
  assert.match(el.textContent, /Any run of yours that logs an access in this row/);
  await button("Show the all-ones run").fire("click");
  assert.match(el.textContent, /A per-register cfg experiment that reaches bdif/);
});

test("a hostile hash opens the default", () => {
  const { full } = setup("<script>");
  assert.match(full.textContent, /^cfg at 0x0040_0000: observed/);
});

test("address lookup selects the row and explains both boards; speech waits for a pause; Escape clears it", async () => {
  const { el, addr, live, full, hash } = setup();
  for (const text of ["0", "0x", "0x09", "0x0900_0000"]) {
    addr.value = text;
    await addr.fire("input");
  }
  assert.equal(live.textContent, "", "nothing spoken while typing");
  assert.match(el.textContent, /Same address on virtpl011, offset 0x0/);
  assert.match(full.textContent, /Address 0x0900_0000: no row\.$/);
  await pause(450);
  assert.equal(live.textContent, "Address 0x0900_0000: no row. Still selected: cfg, observed. Map: 5 observed, 5 inferred, 6 unknown.");
  addr.value = "0x2007_0001";
  await addr.fire("input");
  assert.match(full.textContent, /^pvpanic at 0x2007_0000: observed\..*Address 0x2007_0001: pvpanic, offset 0x1\.$/);
  assert.equal(hash(), "qz~20070001", "the address carries the row; the reader's own choice is still cfg");
  addr.value = "nope";
  await addr.fire("input");
  assert.match(el.textContent, /Not an address: Only hex digits/);
  await addr.fire("keydown", { key: "Escape" });
  assert.equal(addr.value, "");
  assert.equal(hash(), null, "clearing the box returns to the reader's choice, cfg");
  assert.match(full.textContent, /^cfg at 0x0040_0000/);
  await pause(450);
});

test("destroy empties the root", () => {
  const { el, handle } = setup();
  handle.destroy();
  assert.equal(el.children.length, 0);
});

test("shipped files follow the CSP and styling rules", () => {
  for (const f of ["model.mjs", "view.mjs"]) {
    const src = readFileSync(join(here, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of [/eval\(/, /new Function/, /innerHTML/, /https?:\/\//, /document\.write/, /WebAssembly/, /setTimeout\(\s*["'`]/, /setAttribute\(\s*["'](?:style|on)/, /localStorage/, /fetch\(/]) {
      assert.doesNotMatch(src, bad, `${f}: ${bad}`);
    }
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount\(/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{")[0].trim();
    if (!sel || /^@(?:media|container)[^{]*$/.test(sel)) continue;
    for (const s of sel.replace(/^@(?:media|container)[^{]*\{/, "").split(",")) {
      assert.match(s.trim(), /^\.lab\[data-lab="vmapple-map"\]/, `unscoped selector: ${s.trim()}`);
    }
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/, "site tokens only");
  // Layout follows the lab's width, not the viewport's; nothing is faded (muted text keeps contrast).
  assert.match(css, /container-type: inline-size/);
  assert.doesNotMatch(css, /@media \(max-width/);
  assert.doesNotMatch(css, /opacity/);
});

test("evidence changes are announced as moves; the address box is described by a short hint", async () => {
  const { el, box, live, addr } = setup();
  box("z").checked = false;
  await box("z").fire("change");
  assert.match(live.textContent, /^Zero run off: firmware, cfg, GIC distributor, GIC redistributors, pvpanic moved to inferred\./);
  const hint = el.find((n) => n.id === addr.attrs["aria-describedby"]);
  assert.equal(hint.textContent, "Hex, for example 0x0040_0000. Escape clears.");
  const ths = el.findAll((n) => n.tagName === "TH" && n.attrs.scope === "col").map((n) => n.textContent);
  assert.ok(ths.includes("Evidence column") && !ths.includes("Column"), ths.join("|"));
});
