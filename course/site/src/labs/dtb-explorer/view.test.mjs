// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, select through the tree,
// the hex dump and the hash, switch samples, change a byte, paste bytes, and check the static rules
// from LABS.md sections 4, 5 and 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import def from "./samples.mjs";

const here = dirname(fileURLToPath(import.meta.url));

class FakeText {
  constructor(t) {
    this.textContent = t;
  }
}
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.disabled = false;
    this.checked = false;
    this.hidden = false;
    this.value = "";
    const cls = new Set();
    this._cls = cls;
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
  }
  get parentNode() {
    return this.parent;
  }
  set className(v) {
    this._cls.clear();
    for (const c of String(v).split(/\s+/).filter(Boolean)) this._cls.add(c);
  }
  get className() {
    return [...this._cls].join(" ");
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = v;
    if (k === "value") this.value = v;
  }
  getAttribute(k) {
    return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeText(k) : k;
      if (n instanceof FakeNode) n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof FakeNode) yield* c.walk();
  }
  find(pred) {
    for (const n of this.walk()) if (pred(n)) return n;
    return null;
  }
  findAll(pred) {
    return [...this.walk()].filter(pred);
  }
}

async function fire(target, type, extra = {}) {
  let prevented = false;
  const ev = { type, target, key: extra.key, preventDefault: () => (prevented = true) };
  for (let n = target; n; n = n.parent) for (const fn of n.listeners[type] || []) await fn(ev);
  return prevented;
}

globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
  activeElement: null,
};

const { mount } = await import("./view.mjs");
const ID = "lab-dtb-explorer-1";

function setup(initialHash = null) {
  let hash = initialHash;
  const spoken = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "dtb-explorer",
    id: ID,
    base: "",
    standalone: false,
    reducedMotion: true,
    announce: (t) => spoken.push(t),
    hash: { get: () => hash, set: (v) => (hash = v) },
  };
  mount(el, ctx);
  const q = (pred) => el.find(pred);
  const readout = () => q((n) => n.id === `${ID}-summary`).textContent;
  const byte = (o) => q((n) => n.attrs["data-o"] === String(o));
  const item = (text) => q((n) => n.attrs.role === "treeitem" && n.children[0].textContent.endsWith(text));
  return { el, q, readout, byte, item, spoken, hash: () => hash };
}

test("mount: the chapter's tree, parsed, nothing selected, hash clear", () => {
  const { readout, hash, spoken, el } = setup();
  assert.match(readout(), /^The chapter's tree \(64 MiB, no interrupt controller\): 1271 bytes, parsed: 10 nodes, 33 properties\.$/);
  assert.equal(hash(), null);
  assert.deepEqual(spoken, []);
  const tabbable = el.findAll((n) => n.attrs.role === "treeitem" && n.attrs.tabindex === "0");
  assert.equal(tabbable.length, 1);
  assert.match(el.textContent, /sha256 f3ca93f5e05ddebda376a2000973fcf6d39370229e5ef49163e6b25029eee320/);
  assert.match(el.textContent, /pl011@9000000 \{\n\t\tcompatible = "arm,pl011", "arm,primecell";/);
});

test("the reference hash v@310 selects the PL011 node in tree and bytes", () => {
  const { readout, byte, item, el } = setup("v@310");
  assert.match(readout(), /Selected \/pl011@9000000\./);
  assert.equal(item("pl011@9000000").attrs["aria-selected"], "true");
  assert.ok(byte(0x310).classList.contains("is-sel"));
  assert.ok(byte(0x323).classList.contains("is-sel"));
  assert.ok(byte(0x348).classList.contains("is-rel"));
  assert.match(el.textContent, /address 0x0900_0000, size 0x1000 \(4 KiB\)/);
});

test("clicking a byte selects its property; the tree follows", async () => {
  const { byte, item, hash, readout, spoken } = setup();
  await fire(byte(0x350), "click");
  assert.equal(hash(), "v@350");
  assert.match(readout(), /Selected \/pl011@9000000 : reg\./);
  assert.equal(item("reg = <0x00 0x9000000 0x00 0x1000>;").attrs["aria-selected"], "true");
  assert.equal(spoken.length, 1);
});

test("tree keys: Down moves to the root's first property, Left goes back to the parent", async () => {
  const { item, hash } = setup();
  const root = item("/");
  await fire(root, "keydown", { key: "ArrowDown" });
  assert.equal(hash(), "v@40"); // FDT_PROP of compatible, right after the root's 8 bytes at 0x38
  const compat = item('compatible = "linux,dummy-virt";');
  assert.equal(compat.attrs.tabindex, "0");
  await fire(compat, "keydown", { key: "ArrowLeft" });
  assert.equal(hash(), "v@38");
  await fire(root, "keydown", { key: "ArrowLeft" });
  assert.equal(root.attrs["aria-expanded"], "false");
});

test("hex keys: Right jumps a whole region", async () => {
  const { q, hash } = setup("v@0");
  const hexBox = q((n) => n.attrs["aria-label"] === "Blob bytes in hex");
  await fire(hexBox, "keydown", { key: "ArrowRight" });
  assert.equal(hash(), "v@4"); // magic is 4 bytes, totalsize next
  await fire(hexBox, "keydown", { key: "ArrowDown" });
  assert.equal(hash(), "v@14");
});

test("the cells sample shows dtc's warnings and the misread memory", async () => {
  const { q, el, hash } = setup();
  const sel = q((n) => n.tagName === "SELECT");
  sel.value = "cells";
  await fire(sel, "change");
  assert.equal(hash(), "cells");
  for (const line of def.samples.find((s) => s.id === "cells").dtc) assert.ok(el.textContent.includes(line));
  assert.match(el.textContent, /if read anyway: 0x0 \+ 0x4000_0000_0000_0000 \(4 EiB \(about 4\.6 EB\)\)/);
});

test("changing byte 15 to 0x25 is refused like the reference; Undo restores it", async () => {
  const { q, el, hash, readout } = setup();
  const off = q((n) => n.id === `${ID}-poff`);
  const val = q((n) => n.id === `${ID}-pval`);
  const form = q((n) => n.tagName === "FORM");
  off.value = "f";
  val.value = "25";
  assert.equal(await fire(form, "submit"), true);
  assert.equal(hash(), "v+f=25@f");
  assert.match(readout(), /refused: BadBlock\("strings block"\)/);
  assert.match(el.textContent, /off_dt_strings.*fails/s);
  off.value = "zz";
  await fire(form, "submit");
  assert.equal(off.attrs["aria-invalid"], "true");
  const undo = q((n) => n.attrs["data-unpatch"] === "15");
  await fire(undo, "click");
  assert.equal(hash(), "v@f");
  assert.match(readout(), /parsed/);
});

test("pasted bytes are parsed locally and never put in the hash", async () => {
  const { q, hash, readout } = setup("v@310");
  const box = q((n) => n.tagName === "TEXTAREA");
  box.value = def.samples.find((s) => s.id === "empty-root").hex;
  const btn = q((n) => n.tagName === "BUTTON" && n.textContent === "Read these bytes");
  await fire(btn, "click");
  assert.equal(hash(), null);
  assert.match(readout(), /^pasted bytes: 72 bytes, parsed: 1 nodes, 0 properties\./);
  box.value = "xyz";
  await fire(btn, "click");
  assert.equal(box.attrs["aria-invalid"], "true");
});

test("a corrupt sample keeps the partial tree and points at the failing byte", async () => {
  const { q, el, readout } = setup("bad-nameoff");
  assert.match(readout(), /refused: BadNameOffset\(2147483647\)/);
  const go = q((n) => n.attrs["data-goto"] !== undefined && n.textContent === "Show the byte");
  assert.ok(go);
  await fire(go, "click");
  assert.match(el.textContent, /not closed/);
});

test("view switch hides a pane and lands in the hash", async () => {
  const { q, hash } = setup();
  const radio = q((n) => n.attrs.type === "radio" && n.value === "tree");
  radio.checked = true;
  await fire(radio, "change");
  assert.equal(hash(), "v.t");
  const bytesPane = q((n) => n.tagName === "SECTION" && n.attrs["aria-labelledby"] === `${ID}-hex-h`);
  assert.equal(bytesPane.hidden, true);
});

test("shipped files obey the LABS.md static rules", () => {
  for (const f of readdirSync(here)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed type`);
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch(", "localStorage", "XMLHttpRequest"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.ok(!/"style"|style:|\.style\b/.test(src), `${f} sets inline styles`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="dtb-explorer"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), "no hard-coded colors");
  }
  const svg = readFileSync(join(here, "fallback.svg"), "utf8");
  assert.match(svg, /<title[ >]/);
  assert.match(svg, /<desc[ >]/);
  assert.doesNotMatch(svg, /<script|\son\w+=|foreignObject|href=/i);
  const json = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(json.title, "DTB explorer");
  assert.ok(json.goal.length > 0);
});

// ---- Review fixes ----

test("one speech channel: the readout is not a live region; arrow keys speak only the selection", async () => {
  const { q, spoken } = setup("v@0");
  const out = q((n) => n.id === `${ID}-summary`);
  assert.equal(out.attrs["aria-live"], undefined);
  const hexBox = q((n) => n.attrs["aria-label"] === "Blob bytes in hex");
  assert.equal(hexBox.attrs.role, "listbox");
  await fire(hexBox, "keydown", { key: "ArrowRight" });
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^header: totalsize\. /);
  assert.doesNotMatch(spoken[0], /1271 bytes, parsed/);
  assert.equal(hexBox.attrs["aria-activedescendant"], `${ID}-b-4`);
  const active = q((n) => n.id === `${ID}-b-4`);
  assert.equal(active.attrs["aria-selected"], "true");
  assert.equal(active.attrs["aria-label"], "byte 0x4, header field, 00");
});

test("tree items are named by their own row", () => {
  const { item } = setup();
  const root = item("/");
  assert.equal(root.attrs["aria-labelledby"], root.children[0].id);
});

test("validation errors are spoken and focus the input to fix", async () => {
  const { q, spoken } = setup();
  const off = q((n) => n.id === `${ID}-poff`);
  const form = q((n) => n.tagName === "FORM");
  off.value = "zz";
  await fire(form, "submit");
  assert.match(spoken.at(-1), /^Not changed: the offset must be hex/);
  assert.equal(globalThis.document.activeElement, off);
  const file = q((n) => n.attrs.type === "file");
  assert.equal(file.attrs["aria-describedby"], `${ID}-file-err`);
});

test("the pager works with a selection and keeps its buttons", async () => {
  const { q, readout } = setup("v@310");
  const box = q((n) => n.tagName === "TEXTAREA");
  box.value = "00".repeat(9000); // three 4 KiB pages
  await fire(q((n) => n.tagName === "BUTTON" && n.textContent === "Read these bytes"), "click");
  const next = q((n) => n.tagName === "BUTTON" && n.textContent === "Next 4 KiB");
  const label = () => next.parent.children[1].textContent;
  assert.match(label(), /^Bytes 0x0 to 0xfff of 0x2328$/);
  // select a byte on page 0, then page forward: the page must move and the button must survive
  await fire(q((n) => n.attrs["data-o"] === "16"), "click");
  next.focus();
  await fire(next, "click");
  assert.match(label(), /^Bytes 0x1000 to 0x1fff of 0x2328$/);
  assert.equal(q((n) => n.tagName === "BUTTON" && n.textContent === "Next 4 KiB"), next);
  assert.equal(globalThis.document.activeElement, next);
  assert.ok(q((n) => n.attrs["data-o"] === "4096").classList.contains("is-sel") || /0x1000/.test(readout()));
  await fire(next, "click");
  assert.match(label(), /^Bytes 0x2000 to 0x2327 of 0x2328$/);
  assert.equal(next.disabled, true);
  const prev = q((n) => n.tagName === "BUTTON" && n.textContent === "Previous 4 KiB");
  assert.equal(globalThis.document.activeElement, prev);
});

test("the reg note's hint shows only on the chapter's tree, and its button makes the change", async () => {
  const { q, hash, el } = setup();
  const btn = q((n) => n.attrs["data-try"] === "v+87=1@87");
  assert.ok(btn);
  assert.match(el.textContent, /cpu@0 is unchanged because \/cpus sets its own counts/);
  await fire(btn, "click");
  assert.equal(hash(), "v+87=1@87");
  assert.equal(q((n) => n.attrs["data-try"] === "v+87=1@87"), null);
  const cells = setup("cells");
  assert.match(cells.el.textContent, /This sample already made that change/);
  const dedup = setup("dedup");
  assert.equal(dedup.q((n) => n.attrs["data-try"] === "v+87=1@87"), null);
  assert.doesNotMatch(dedup.el.textContent, /Byte 0x87/);
});

test("try this: the steps load their views; sample text has no repo paths", async () => {
  const { q, hash, el } = setup();
  await fire(q((n) => n.attrs["data-try"] === "v@348"), "click");
  assert.equal(hash(), "v@348");
  await fire(q((n) => n.attrs["data-try"] === "cells"), "click");
  assert.equal(hash(), "cells");
  assert.doesNotMatch(el.textContent, /captures\/|labs\/vectors|reference's/);
  for (const s of def.samples) assert.doesNotMatch(`${s.about} ${s.source}`, /captures\/|labs\/vectors|\.json|\.txt|seeds zeroed|breakage 1/);
});

test("standalone: a line links back to chapter 10", () => {
  const el = new FakeNode("div");
  mount(el, {
    name: "dtb-explorer",
    id: ID,
    base: "https://example.test/build-your-own/vmm/assets/labs/dtb-explorer/",
    standalone: true,
    reducedMotion: true,
    announce: () => {},
    hash: { get: () => null, set: () => {} },
  });
  assert.ok(el.find((n) => n.tagName === "A" && n.attrs.href === "/build-your-own/vmm/devices/device-tree/"));
});

test("Copy link's message clears when the view changes", async () => {
  const { q } = setup();
  globalThis.navigator ??= {};
  const saved = globalThis.navigator.clipboard;
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async () => {} }, configurable: true });
  globalThis.location ??= { href: "x" };
  await fire(q((n) => n.tagName === "BUTTON" && n.textContent === "Copy link to this view"), "click");
  const msg = q((n) => n.attrs.role === "status");
  assert.equal(msg.textContent, "Link copied.");
  await fire(q((n) => n.attrs["data-o"] === "16"), "click");
  assert.equal(msg.textContent, "");
  Object.defineProperty(globalThis.navigator, "clipboard", { value: saved, configurable: true });
});

// A structure-words blob with a correct header (the same helper as in model.test.mjs).
function blobOf(structWords, strings = "") {
  const str = new TextEncoder().encode(strings);
  const total = 56 + structWords.length * 4 + str.length;
  const b = new Uint8Array(total);
  const dv = new DataView(b.buffer);
  [0xd00dfeed, total, 56, 56 + structWords.length * 4, 40, 17, 16, 0, str.length, structWords.length * 4].forEach((v, i) => dv.setUint32(i * 4, v));
  structWords.forEach((w, i) => dv.setUint32(56 + i * 4, w >>> 0));
  b.set(str, 56 + structWords.length * 4);
  return b;
}
async function openFile(view, bytes, name = "hostile.dtb") {
  const fileIn = view.q((n) => n.tagName === "INPUT" && n.attrs.type === "file");
  fileIn.files = [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  const t = performance.now();
  await fire(fileIn, "change");
  return performance.now() - t;
}

test("a file whose properties all name one huge string is refused at once, in the lab's own words", async () => {
  const words = [1, 0];
  for (let i = 0; i < 80000; i++) words.push(3, 0, 0);
  words.push(2, 9);
  const view = setup();
  const ms = await openFile(view, blobOf(words, `${"a".repeat(999_999)}\0`));
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.match(view.readout(), /refused: LabLimit\("property name longer than 256 bytes"\)/);
  const verdict = view.el.textContent;
  assert.match(verdict, /name here is longer than 256 bytes/);
  assert.match(verdict, /macvmm's reader has no such limit/);
  assert.doesNotMatch(verdict, /macvmm's reader refuses it with the same error/);
});

test("a file with 40,000 reg nodes under a wide root opens quickly and the reg table is capped", async () => {
  const words = [1, 0];
  for (let i = 0; i < 80000; i++) words.push(3, 0, 0);
  for (let i = 0; i < 40000; i++) words.push(1, 0x61000000, 3, 0, 2, 2);
  words.push(2, 9);
  const view = setup();
  const ms = await openFile(view, blobOf(words, "x\0reg\0"));
  assert.ok(ms < 5000, `took ${ms.toFixed(0)} ms`);
  assert.match(view.readout(), /parsed: 40001 nodes, 120000 properties/);
  const rows = view.el.findAll((n) => n.tagName === "TR" && /dtx__(pass|fail)/.test(n.className || "") && n.children[0].tagName === "TH" && n.children[0].children[0].attrs["data-goto"] !== undefined);
  assert.equal(rows.length, 200);
  assert.match(view.el.textContent, /Only the first 200 rows are shown: 39800 more reg or ranges properties are not listed\./);
});

test("one reg with 100,000 entries is one short row, and the dtc text is cut", async () => {
  const n = 100000;
  const words = [1, 0, 3, 4, 0, 1, 3, 4, 15, 0, 1, 0x61000000, 3, n * 4, 27];
  for (let i = 0; i < n; i++) words.push(i);
  words.push(2, 2, 9);
  const view = setup();
  await openFile(view, blobOf(words, "#address-cells\0#size-cells\0reg\0"));
  assert.match(view.readout(), /parsed: 2 nodes, 3 properties/);
  assert.match(view.el.textContent, /0x0; 0x1; 0x2; 0x3; 0x4; 0x5; 0x6; 0x7; \.\.\. and 99992 more/);
  const pre = view.q((x) => x.tagName === "PRE");
  assert.ok(pre.textContent.length < 256 * 1024 + 200, `${pre.textContent.length} characters`);
  assert.match(pre.textContent, /more characters not shown: this box shows the first 262144\. \*\/\n$/);
});
