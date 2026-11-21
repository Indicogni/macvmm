// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders the lesson's ARP request, that the controls drive the model, that the grid's
// roving tabindex follows the arrow keys, that the share hash is written and read back, and that
// nothing is ever parsed as HTML. Also static checks of the LABS.md contract for shipped files.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REFERENCE, LEGACY_RUN, preset, formatHexLines } from "./model.mjs";

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
    this.focused = false;
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
    this.attrs[k] = String(v);
    if (k === "value") this.value = v;
    if (k === "hidden") this.hidden = true;
  }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, extra = {}) { for (const fn of this.listeners[t] || []) fn({ type: t, preventDefault() {}, ...extra }); }
  focus() { this.focused = true; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

async function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  globalThis.window = { location: { href: "x" } };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "frame-dissector", id: "lab-frame-dissector-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const byId = (suffix) => root.findAll((e) => e.attrs.id === `${ctx.id}-${suffix}`)[0];
  const byClass = (c) => root.findAll((e) => e.classList.contains(c))[0];
  const btn = (text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  const cells = () => root.findAll((e) => e.attrs.role === "gridcell");
  return { root, ctx, said, handle, byId, byClass, btn, cells, hash: () => stored };
}

test("mounts on the lesson's ARP request with an empty hash", async () => {
  const t = await setup();
  assert.equal(t.hash(), null);
  assert.equal(t.byId("hex").value, formatHexLines(preset("arp").bytes));
  assert.equal(t.cells().length, 54);
  assert.match(t.byClass("fd-readout").textContent, /ARP request: who has 10\.0\.0\.2\? Tell 10\.0\.0\.1\./);
  assert.match(t.root.textContent, /VM B's guest/);
  assert.ok(t.byClass("fd-shift").hidden, "the Two bytes off panel waits for strip 10");
  // Exactly one cell in the tab order (roving tabindex).
  assert.equal(t.cells().filter((c) => c.attrs.tabindex === "0").length, 1);
  t.handle.destroy();
});

test("strip 10 shows the lesson's table and the capture's numbers, and writes the reference hash", async () => {
  const t = await setup();
  const strip = t.byId("strip");
  strip.value = "10";
  strip.dispatch("change");
  assert.equal(t.hash(), REFERENCE);
  const shift = t.byClass("fd-shift");
  assert.ok(!shift.hidden);
  assert.match(shift.textContent, /00 00 ff ff ff ff/);
  assert.match(shift.textContent, /ff ff 02 6d 76 00/);
  assert.ok(shift.textContent.includes(LEGACY_RUN.text));
  assert.match(t.root.textContent, /discards it without a word/);
  t.handle.destroy();
});

test("reads a shared hash, edits bytes, refuses bad hex, fixes checksums", async () => {
  const t = await setup("p=ping");
  assert.equal(t.byId("preset").value, "ping");
  const hexIn = t.byId("hex");
  const before = hexIn.value;
  hexIn.value = "zz";
  hexIn.dispatch("input");
  assert.equal(t.byClass("fd-msg").hidden, true, "typing alone applies nothing until a pause or change");
  hexIn.dispatch("change");
  assert.match(t.byClass("fd-msg").textContent, /Not applied/);
  assert.equal(hexIn.attrs["aria-invalid"], "true");
  assert.match(hexIn.attrs["aria-describedby"], new RegExp(`${t.ctx.id}-msg`));
  assert.equal(t.hash(), "p=ping");
  // Change the destination IP's last byte to 3: the IPv4 checksum breaks.
  const bytes = before.split(/\s+/);
  bytes[12 + 14 + 19] = "03";
  hexIn.value = bytes.join(" ");
  hexIn.dispatch("change");
  assert.equal(hexIn.attrs["aria-invalid"], undefined);
  assert.match(t.hash(), /^b=/);
  assert.match(t.root.textContent, /header checksum is wrong/);
  t.btn("Fix checksums").dispatch("click");
  assert.match(t.root.textContent, /10\.0\.0\.3 is not its address/);
  t.btn("Reset").dispatch("click");
  assert.equal(t.hash(), null);
  t.handle.destroy();
});

test("arrow keys move the roving tabindex and select the field under the byte", async () => {
  const t = await setup();
  const grid = t.root.findAll((e) => e.attrs.role === "grid")[0];
  grid.dispatch("keydown", { key: "ArrowDown" }); // byte 16: Ethernet destination
  let cells = t.cells();
  assert.equal(cells[16].attrs.tabindex, "0");
  assert.ok(cells[16].focused);
  assert.match(t.byClass("fd-detail").textContent, /Ethernet: destination MAC/);
  grid.dispatch("keydown", { key: "End" });
  cells = t.cells();
  assert.equal(cells[31].attrs.tabindex, "0");
  grid.dispatch("keydown", { key: "End", ctrlKey: true });
  assert.equal(t.cells()[53].attrs.tabindex, "0");
  assert.match(t.byClass("fd-detail").textContent, /ARP: target IP/);
  t.handle.destroy();
});

test("direction RX disables the strip control; a bad hash falls back to the default", async () => {
  const t = await setup("p=arp;h=99");
  assert.equal(t.byId("preset").value, "arp");
  const dir = t.byId("dir");
  dir.value = "rx";
  dir.dispatch("change");
  assert.ok(t.byId("strip").disabled);
  assert.equal(t.hash(), "p=arp;d=rx");
  t.handle.destroy();
});

// ---- static contract checks (LABS.md sections 1, 4, 5) --------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const shipped = readdirSync(here).filter((f) => !f.endsWith(".test.mjs"));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("only allowed file types ship, and the required ones exist", () => {
  for (const f of shipped) assert.match(f, /\.(mjs|js|css|json|svg)$/, f);
  for (const f of ["model.mjs", "view.mjs"]) assert.ok(shipped.includes(f), f);
});

test("shipped code avoids the forbidden strings; the model is pure", () => {
  for (const f of shipped.filter((f) => /\.(mjs|js)$/.test(f))) {
    const src = stripComments(readFileSync(join(here, f), "utf8"));
    for (const bad of ["eval(", "new Function", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "http://", "https://", "fetch(", "WebAssembly", "setAttribute(\"style\"", "javascript:", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.doesNotMatch(src, /setTimeout\(\s*["'`]/, `${f}: string timer`);
    assert.doesNotMatch(src, /setAttribute\(\s*["']on/, `${f}: handler attribute`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /^export function mount\(/m);
  assert.doesNotMatch(stripComments(readFileSync(join(here, "model.mjs"), "utf8")), /\b(document|window|navigator|location|globalThis)\b/);
});

test("every CSS rule is scoped to this lab and uses tokens, not literal colors", () => {
  const css = stripComments(readFileSync(join(here, "style.css"), "utf8"));
  const selectors = [...css.matchAll(/([^{}@]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !/^(media|supports)\b/.test(s));
  for (const group of selectors) {
    for (const sel of group.split(",")) assert.match(sel.trim(), /^\.lab\[data-lab="frame-dissector"\]/, sel.trim());
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
});

test("the hex box waits for a pause, then applies once without speaking the error twice", async () => {
  const t = await setup();
  const hexIn = t.byId("hex");
  hexIn.value = hexIn.value + " 0";
  hexIn.dispatch("input");
  await new Promise((r) => setTimeout(r, 700));
  assert.match(t.byClass("fd-msg").textContent, /odd number/);
  assert.equal(t.byClass("fd-msg").attrs.role, "status");
  assert.equal(t.said.filter((x) => /Not applied/.test(x)).length, 0, "role=status speaks it; ctx.announce does not repeat it");
  t.handle.destroy();
});

test("one announcement channel; readout after the visualization; headings follow the shell", async () => {
  const t = await setup();
  const readout = t.byClass("fd-readout");
  assert.equal(readout.attrs["aria-live"], undefined);
  const wrap = t.byClass("fd-wrap");
  const order = wrap.children.map((c) => c.className);
  assert.ok(order.indexOf("fd-main") < order.indexOf("fd-readout"), order.join(","));
  assert.ok(order.indexOf("fd-controls") < order.indexOf("fd-main"));
  // Standalone: the shell's title is h1, so panel headings are h2.
  assert.ok(t.root.findAll((e) => e.tagName === "H2").length >= 3);
  assert.equal(t.root.findAll((e) => e.tagName === "H3").length, 0);
  t.handle.destroy();
});

test("scrolling tables can take focus and are named regions", async () => {
  const t = await setup();
  const regions = t.root.findAll((e) => e.classList.contains("fd-scroll") && e.attrs.role === "region");
  assert.equal(regions.length, 2);
  for (const r of regions) {
    assert.equal(r.attrs.tabindex, "0");
    const cap = t.root.findAll((e) => e.attrs.id === r.attrs["aria-labelledby"])[0];
    assert.ok(cap && cap.tagName === "CAPTION");
  }
  t.handle.destroy();
});

test("choosing an offset in the table keeps the rows (and focus) in place", async () => {
  const t = await setup();
  const rowsBefore = t.byClass("fd-table").findAll((e) => e.tagName === "TR").slice(1);
  const btn = t.root.findAll((e) => e.tagName === "BUTTON" && e.attrs["aria-label"] === "Select EtherType at offset 24")[0];
  btn.dispatch("click");
  const rowsAfter = t.byClass("fd-table").findAll((e) => e.tagName === "TR").slice(1);
  assert.deepEqual(rowsAfter, rowsBefore);
  assert.ok(!t.cells()[24].focused, "focus stays in the table");
  assert.ok(rowsAfter.filter((r) => r.classList.contains("fd-current")).length === 1);
  assert.match(t.byClass("fd-detail").textContent, /EtherType/);
  // Only one grid cell claims aria-selected.
  assert.equal(t.cells().filter((c) => c.attrs["aria-selected"] === "true").length, 1);
  t.handle.destroy();
});

test("the strip option waits in a closed disclosure, opened by a shared h=10 state", async () => {
  let t = await setup();
  const box = t.byClass("fd-later");
  assert.equal(box.tagName, "DETAILS");
  assert.ok(!box.open);
  assert.ok(box.findAll((e) => e.attrs.id === `${t.ctx.id}-strip`).length === 1);
  t.handle.destroy();
  t = await setup(REFERENCE);
  assert.ok(t.byClass("fd-later").open);
  t.handle.destroy();
});

test("a Try this list gives a first path; Page Down moves 8 rows", async () => {
  const t = await setup(null);
  assert.match(t.byClass("fd-try").textContent, /byte 24/);
  const grid = t.root.findAll((e) => e.attrs.role === "grid")[0];
  grid.dispatch("keydown", { key: "PageDown" });
  assert.equal(t.cells()[53].attrs.tabindex, "0", "clamped to the last byte of 54");
  grid.dispatch("keydown", { key: "PageUp" });
  assert.equal(t.cells()[0].attrs.tabindex, "0");
  t.handle.destroy();
});
