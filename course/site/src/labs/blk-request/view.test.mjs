// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders the lesson's example, that presets, the editor and "Predict first" drive the
// model, that the share hash is written and read back, that ids derive from ctx.id, and that
// nothing is ever parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REFERENCE, PRESETS, run, defaultState, decodeShare } from "./model.mjs";

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
    if (k === "disabled") this.disabled = true;
  }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t }); }
  focus() { FakeEl.focused = this; }
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
    name: "blk-request", id: "lab-blk-request-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const btn = (text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  const byId = (suffix) => root.findAll((e) => e.attrs.id === `${ctx.id}-${suffix}`)[0];
  const byClass = (c) => root.findAll((e) => e.classList.contains(c))[0];
  return { root, ctx, said, handle, btn, byId, byClass, hash: () => stored };
}

test("mounts on the lesson's example: rule 6, IOERR, used length 1", async () => {
  const t = await setup();
  assert.equal(t.hash(), null, "the default clears the hash");
  const readout = t.byClass("br-readout").textContent;
  assert.match(readout, /64 × 512 \+ 512 = 33280 > 32768/);
  assert.match(t.byClass("br-outcome").textContent, /Status IOERR \(1\), used length 1/);
  const fires = t.root.findAll((e) => e.classList.contains("br-check-item--fail"));
  assert.equal(fires.length, 1);
  assert.match(fires[0].textContent, /FIRES: stops here.*Rule 6/);
  assert.equal(t.byClass("br-bytes").children.length, 16, "16 header bytes");
  assert.match(t.byClass("br-maptext").textContent, /sector 64, past the end/);
  t.handle.destroy();
});

test("every id is derived from ctx.id, and labels point at real controls", async () => {
  const t = await setup();
  const ids = t.root.findAll((e) => e.attrs.id).map((e) => e.attrs.id);
  assert.ok(ids.length > 10);
  for (const id of ids) assert.ok(id.startsWith("lab-blk-request-1-"), id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const l of t.root.findAll((e) => e.tagName === "LABEL" && e.attrs.for)) assert.ok(ids.includes(l.attrs.for), l.attrs.for);
  for (const s of t.root.findAll((e) => (e.tagName === "SELECT" || e.tagName === "INPUT") && !e.attrs["aria-label"])) {
    assert.ok(t.root.findAll((l) => l.tagName === "LABEL" && l.attrs.for === s.attrs.id).length === 1, `${s.attrs.id} has a label`);
  }
  for (const b of t.root.findAll((e) => e.tagName === "BUTTON")) assert.ok(b.textContent || b.attrs["aria-label"]);
});

test("presets load and write the share hash; the reference hash mounts", async () => {
  const t = await setup();
  const sel = t.byId("preset");
  sel.value = "get-id";
  sel.dispatch("change");
  assert.match(t.byClass("br-readout").textContent, /"macvmm-disk0" and 8 zero bytes/);
  assert.match(t.byClass("br-outcome").textContent, /used length 21/);
  assert.ok(decodeShare(t.hash()));
  for (const p of PRESETS) {
    sel.value = p.id;
    sel.dispatch("change");
    assert.equal(t.byClass("br-readout").textContent, run(p.state).summary, p.id);
  }
  const r = await setup(REFERENCE);
  assert.equal(r.hash(), REFERENCE);
  assert.match(r.byClass("br-readout").textContent, /A wrapped offset is a valid offset, only the wrong one/);
  assert.equal(r.byId("ar").value, "w");
  const junk = await setup("cap=64;<script>");
  assert.equal(junk.hash(), null, "a malformed hash falls back to the default");
});

test("the editor drives the model and refuses bad input", async () => {
  const t = await setup();
  const sector = t.byId("sector");
  sector.value = "63";
  sector.dispatch("change");
  assert.match(t.byClass("br-outcome").textContent, /Status OK \(0\), used length 513/);
  sector.value = "2^64";
  sector.dispatch("change");
  assert.match(t.byClass("br-msg").textContent, /Not changed: the sector is a 64-bit number/);
  assert.equal(t.byId("sector").value, "63", "the field shows the kept value again");
  const ar = t.byId("ar");
  sector.value = "2^55";
  sector.dispatch("change");
  ar.value = "p";
  ar.dispatch("change");
  assert.match(t.byClass("br-outcome").textContent, /The VMM panics/);
  ar.value = "c";
  ar.dispatch("change");
  // Add a readable descriptor at the end: the walk refuses readable after writable.
  t.btn("Add a readable descriptor").dispatch("click");
  assert.equal(t.byClass("br-chain").findAll((e) => e.tagName === "TR").length, 1 + 4);
  assert.match(t.byClass("br-readout").textContent, /ReadableAfterWritable/);
  assert.equal(FakeEl.focused, t.byId("d3-dir"), "focus moves to the new row");
  t.root.findAll((e) => e.attrs["aria-label"] === "Remove row 3")[0].dispatch("click");
  const len = t.byId("d1-len");
  len.value = "4294967296";
  len.dispatch("change");
  assert.match(t.byClass("br-msg").textContent, /Not changed/);
  const ro = t.byId("ro");
  t.byId("type").value = "1";
  t.byId("type").dispatch("change");
  assert.match(t.byClass("br-readout").textContent, /Rule 4 fires/, "OUT with writable data");
  ro.checked = true;
  ro.dispatch("change");
  assert.ok(t.hash().includes("ro=1"));
});

test("Predict first hides the answer until a guess is checked", async () => {
  const t = await setup();
  const box = t.byId("predict");
  box.checked = true;
  box.dispatch("change");
  assert.ok(t.byClass("br-results").hidden);
  assert.match(t.byClass("br-readout").textContent, /Answer hidden/);
  const reveal = t.btn("Show what the device does");
  assert.ok(reveal.disabled);
  const g = t.byId("guess");
  g.value = "ioerr";
  g.dispatch("change");
  assert.ok(!reveal.disabled);
  reveal.dispatch("click");
  assert.ok(!t.byClass("br-results").hidden);
  assert.match(t.byClass("br-score").textContent, /You predicted IOERR \(1\): right\./);
  assert.ok(t.hash().endsWith("p=1"));
  // Changing the request hides the answer again.
  const sector = t.byId("sector");
  sector.value = "3";
  sector.dispatch("change");
  assert.ok(t.byClass("br-results").hidden);
  assert.equal(t.byClass("br-score").textContent, "");
});

test("one announcement channel, and focus survives refusals and the reveal", async () => {
  const t = await setup();
  assert.equal(t.byClass("br-readout").attrs["aria-live"], undefined, "the readout is not its own live region");
  assert.equal(t.byClass("br-msg").attrs.role, undefined, "nor is the refusal message");
  // A bad row value resets only that field: the same control, still focused.
  const len = t.byId("d1-len");
  len.focus();
  len.value = "abc";
  len.dispatch("change");
  assert.match(t.byClass("br-msg").textContent, /Not changed/);
  assert.equal(t.byId("d1-len"), len, "the row was not rebuilt");
  assert.equal(len.value, "512");
  assert.equal(FakeEl.focused, len);
  const rep = t.byId("d1-n");
  rep.focus();
  rep.value = "0";
  rep.dispatch("change");
  assert.equal(t.byId("d1-n"), rep);
  assert.equal(rep.value, "1");
  assert.equal(FakeEl.focused, rep);
  // Predict first: after the reveal, focus lands on the score line next to the results.
  const box = t.byId("predict");
  box.checked = true;
  box.dispatch("change");
  t.byId("guess").value = "ioerr";
  t.byId("guess").dispatch("change");
  t.btn("Show what the device does").dispatch("click");
  assert.equal(FakeEl.focused, t.byClass("br-score"));
  assert.equal(t.byClass("br-score").attrs.tabindex, "-1");
  t.handle.destroy();
});

test("preset notes are announced; header bytes have spoken labels; Another number sticks", async () => {
  const t = await setup();
  const sel = t.byId("preset");
  sel.value = "mul-overflow";
  sel.dispatch("change");
  await new Promise((r) => setTimeout(r, 350));
  assert.match(t.said.at(-1), /^Once you reach Breaking it on purpose/);
  assert.match(t.said.at(-1), /Rule 6 fires/);
  const li = t.byClass("br-bytes").children[8];
  assert.match(li.children[0].textContent, /^byte 8, sector, 0x00$/);
  assert.equal(li.children[1].attrs["aria-hidden"], "true");
  assert.equal(li.children[2].attrs["aria-hidden"], "true");
  // Choosing "Another number..." reveals the field without moving focus, and a refusal elsewhere
  // does not snap the select back.
  const type = t.byId("type");
  type.focus();
  type.value = "other";
  type.dispatch("change");
  assert.equal(FakeEl.focused, type);
  const typen = t.byId("typen");
  assert.equal(t.root.findAll((e) => e.children.includes(typen))[0].hidden, false, "the number field shows");
  const sector = t.byId("sector");
  sector.value = "junk";
  sector.dispatch("change");
  assert.equal(type.value, "other");
  // Arithmetic outside "checked" offers the panic and backend predictions.
  t.byId("ar").value = "p";
  t.byId("ar").dispatch("change");
  const values = t.byId("guess").children.map((o) => o.value);
  assert.ok(values.includes("panic") && values.includes("backend"));
  t.handle.destroy();
});

test("embedded, the lab says this chapter", async () => {
  globalThis.document = { createElement: (tg) => new FakeEl(tg) };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const ctx = {
    name: "blk-request", id: "lab-blk-request-2", base: "", standalone: false, reducedMotion: false,
    announce: () => {}, hash: { get: () => REFERENCE, set: () => {} },
  };
  const handle = mount(root, ctx);
  const labels = root.findAll((e) => e.tagName === "LABEL").map((e) => e.textContent).join(" | ");
  assert.match(labels, /Requests from this chapter and its tests/);
  assert.ok(root.findAll((e) => e.classList.contains("br-later"))[0].open, "the reference uses wrapping, so the later group opens");
  handle.destroy();
});

test("shipped files obey the CSP rules", () => {
  for (const f of ["view.mjs", "model.mjs", "style.css", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function|innerHTML|https?:\/\/(?!www\.w3\.org\/2000\/svg)|WebAssembly|document\.write|setAttribute\(\s*["'](?:style|on)/, f);
  }
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    const parts = rule.split("{");
    if (parts.length < 2) continue;
    const sel = parts[parts.length - 2].trim();
    for (const s of sel.split(",")) assert.ok(s.trim().startsWith('.lab[data-lab="blk-request"]'), s);
  }
  assert.equal(defaultState().cap, 64n);
});
