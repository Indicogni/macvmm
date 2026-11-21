// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that the buttons, radios and scenario menu drive the model, that the share
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
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  focus() { globalThis.document.activeElement = this; }
  querySelectorAll(sel) {
    if (sel !== "button[data-token]") throw new Error(`fake DOM: unsupported selector ${sel}`);
    return this.findAll((e) => e.tagName === "BUTTON" && "data-token" in e.attrs);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
  }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  globalThis.window = { location: { href: "x" } };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "durability-ladder", id: "lab-durability-ladder-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const buttons = (root) => root.findAll((e) => e.tagName === "BUTTON");
const button = (root, text) => buttons(root).find((e) => e.textContent === text);
const buttonStarting = (root, text) => buttons(root).find((e) => e.textContent.startsWith(text));
const readout = (root) => root.findAll((e) => e.className === "dl-readout")[0].textContent;
const radio = (root, idSuffix) => root.findAll((e) => e.tagName === "INPUT" && e.attrs.id?.endsWith(idSuffix))[0];

test("walks the fsync with Next step, then a power cut under F_FULLFSYNC", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(hash(), null, "default state clears the hash");
  assert.match(readout(root), /Nothing written yet/);
  for (let i = 0; i < 8; i++) {
    const next = buttonStarting(root, "Next step");
    assert.equal(next.disabled, false, `step ${i + 1}`);
    next.dispatch("click");
  }
  assert.equal(hash(), "f.full.n8");
  assert.equal(buttonStarting(root, "Next step").disabled, true);
  button(root, "Power lost").dispatch("click");
  assert.equal(hash(), "f.full.n8_xp");
  assert.match(readout(root), /^Power lost\. Consistent, new version\./);
  assert.ok(root.findAll((e) => e.textContent === "wiped").length === 4, "four rungs wiped");
  for (const b of ["Guest kernel crashes", "Process killed (kill -9)", "macOS crashes", "Power lost"]) {
    assert.equal(button(root, b).disabled, true, `${b} disabled after a failure`);
  }
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "f.full.n8");
  api.destroy();
});

test("switching to plain fsync keeps the run and changes the verdict", async () => {
  const { ctx, hash } = setup("f.full.n8_xp");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const r = radio(root, "-sync-fsync");
  r.checked = true;
  r.dispatch("change");
  assert.equal(hash(), "f.fsync.n8_xp");
  assert.match(readout(root), /a promised write is lost/);
  const wt = radio(root, "-flush-w");
  wt.checked = true;
  wt.dispatch("change");
  assert.equal(hash(), "w.fsync.n6");
});

test("background writeback buttons and the reference scenario", async () => {
  const { ctx, hash } = setup("f.fsync.n8");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const toFlash = buttons(root).find((b) => b.attrs["aria-label"] === "drive writes it to flash: the commit record");
  assert.ok(toFlash);
  toFlash.dispatch("click");
  assert.equal(hash(), "f.fsync.n8_dc");
  button(root, "Power lost").dispatch("click");
  assert.equal(hash(), "f.fsync.n8_dc_xp");
  assert.match(readout(root), /Inconsistent: commit record without its journal entry/);
});

test("a scenario walks to its end with Next step, and the kill -9 one quotes the capture", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const sel = root.findAll((e) => e.tagName === "SELECT" && e.attrs.id.endsWith("-preset"))[0];
  sel.value = "noop-kill";
  sel.dispatch("change");
  assert.equal(hash(), "f.none");
  for (let i = 0; i < 9; i++) buttonStarting(root, "Next step").dispatch("click");
  assert.equal(hash(), "f.none.n8_xk");
  assert.match(root.textContent, /00800000: 6d61 6376 6d6d 0a6d 6163 766d 6d0a 6d61  macvmm\.macvmm\.ma/);
  assert.match(root.textContent, /From the capture 18-kill9-after\.txt\./);
});

test("prediction feedback after the failure", async () => {
  const { ctx } = setup("f.fsync.n8");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const sel = root.findAll((e) => e.tagName === "SELECT" && e.attrs.id.endsWith("-predict"))[0];
  sel.value = "ok";
  sel.dispatch("change");
  button(root, "Power lost").dispatch("click");
  assert.match(root.textContent, /You predicted: Consistent, new version\. Not this time/);
});

test("a hostile hash is ignored and the default is shown", async () => {
  const { ctx } = setup("f.full.n1_<img>");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.match(readout(root), /Nothing written yet/);
});

test("ids are derived from ctx.id and the view never touches innerHTML or inline styles", () => {
  const src = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n"); // code only, not comments
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\("style|\.style\b/);
  assert.doesNotMatch(src, /h\("[a-z0-9]+", \{[^}]*\bid: "/, "no fixed element ids");
  assert.doesNotMatch(src, /setAttribute\("id"/);
  assert.match(src, /export function mount/);
});

test("one announcement channel: no live region in the lab, short spoken text after a failure", async () => {
  const { ctx, said } = setup("f.full.n8");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.equal(root.findAll((e) => "aria-live" in e.attrs).length, 0, "the page's own live region is the only one");
  button(root, "Power lost").dispatch("click");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(said.length, 1);
  assert.equal(said[0], 'Power lost. Consistent, new version. Details in "What the guest finds".');
});

test("keyboard focus survives writeback buttons, failures and the last step", async () => {
  // A do-nothing FLUSH leaves the commit record in the host page cache, so macOS can write it back.
  const { ctx, hash } = setup("f.none.n8");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  buttons(root).find((b) => b.attrs["data-token"] === "hc").dispatch("click");
  assert.equal(hash(), "f.none.n8_hc");
  assert.equal(document.activeElement.attrs["data-token"], "dc", "focus moves to the drive's button for the same block");
  assert.ok(root.findAll((e) => e === document.activeElement).length === 1, "the focused button is in the DOM");
  document.activeElement.dispatch("click");
  assert.equal(hash(), "f.none.n8_hc_dc");
  // No follow-on, the button is gone and Next step is finished: the ladder heading takes focus.
  assert.equal(document.activeElement.textContent, "Where each block is");
  assert.equal(document.activeElement.attrs.tabindex, "-1");
  // A failure moves focus to the outcome box.
  button(root, "Power lost").dispatch("click");
  assert.equal(document.activeElement.className.split(" ")[0], "dl-outcome");
  assert.match(document.activeElement.textContent, /^What the guest finds/);
  // The last Next step hands focus to the prediction.
  const s3 = setup("f.full.n7");
  const root3 = new FakeEl("div");
  mount(root3, s3.ctx);
  buttonStarting(root3, "Next step").dispatch("click");
  assert.equal(document.activeElement.attrs.id, "lab-durability-ladder-1-predict");
});

test("measured costs only with FLUSH negotiated; write-through says why not", async () => {
  const { ctx } = setup("w.full");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.doesNotMatch(root.textContent, /Measured in chapter 18/);
  assert.match(root.textContent, /measured its costs with FLUSH negotiated/);
  assert.match(root.textContent, /The VMM syncs after each OUT with/);
});

test("the inode in place reads as rebuilt when the journal carried it", async () => {
  const { ctx } = setup("f.full.n8_xp");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.match(root.textContent, /inode in place: lost, rebuilt from the journal entry/);
});

test("the scroll boxes are named, focusable regions and the ladder lists five rungs", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const regions = root.findAll((e) => e.className === "dl-scroll");
  assert.equal(regions.length, 2);
  for (const r of regions) {
    assert.equal(r.attrs.tabindex, "0");
    assert.equal(r.attrs.role, "region");
    assert.match(r.attrs["aria-label"], /scrollable/);
  }
  const rungs = root.findAll((e) => e.tagName === "OL" && e.className === "dl-rungs")[0];
  const items = rungs.children.filter((c) => c.attrs["aria-hidden"] !== "true" && c.attrs.role !== "none");
  assert.equal(items.length, 5);
});
