// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom): mount renders,
// presets load without running (predict first), Run fills the three views, the share hash is
// written and read back, hostile hashes and inputs are handled, and nothing is parsed as HTML.
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
    this.value = "";
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "value") this.value = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, extra = {}) { for (const fn of this.listeners[t] || []) fn({ type: t, ...extra }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "ansi-filter", id: "lab-ansi-filter-1", base: "", standalone: false, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const byTag = (root, tag) => root.findAll((e) => e.tagName === tag);
const button = (root, name) => byTag(root, "BUTTON").find((b) => b.textContent === name);
const readout = (root) => root.findAll((e) => e.className === "af__readout")[0].textContent;
const section = (root, n) => byTag(root, "SECTION")[n];

test("mount shows the first example, waits for Run, then fills three views and the hash", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  const ta = byTag(root, "TEXTAREA")[0];
  assert.equal(ta.value, "\\x1b[1;31mhi\\x1b[0m");
  assert.ok(section(root, 0).hidden, "views hidden before Run");
  assert.equal(hash(), null, "opening the lab does not write the URL");
  const pred = byTag(root, "INPUT").find((e) => e.attrs.id.endsWith("-predict"));
  pred.value = "\\x1b[1;31mhi\\x1b[0m";
  button(root, "Run").dispatch("click");
  assert.ok(!section(root, 0).hidden);
  assert.match(readout(root), /13 input bytes\. The safe policy keeps 13 bytes, removes 0 pieces/);
  assert.match(root.textContent, /Your prediction matches the safe output exactly\./);
  assert.match(section(root, 0).textContent, /SGR.*Select Graphic Rendition: bold, red foreground/);
  assert.equal(hash(), "bold-red");
  api.destroy();
});

test("a preset loads without running; Run shows drops with their rules", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  const sel = byTag(root, "SELECT")[0];
  sel.value = "hostile-tty";
  sel.dispatch("change");
  assert.ok(section(root, 1).hidden);
  button(root, "Run").dispatch("click");
  const safeText = section(root, 1).textContent;
  assert.match(safeText, /roughly the number of bytes removed: 160/);
  assert.match(safeText, /final byte 'n' \(device status report, a query\)/);
  assert.match(safeText, /raw C1 byte 0x9B \(8-bit CSI\)/);
  const strictOut = section(root, 2).findAll((e) => e.tagName === "PRE")[0];
  const visible = (n) => (n.className === "af__vh" ? "" : n instanceof FakeEl ? n._text + n.children.map(visible).join("") : n.textContent);
  assert.match(visible(strictOut), /\^\[\[6n/);
  assert.equal(hash(), "hostile-tty");
});

test("the 10 MB preset renders a capped view", async () => {
  const { ctx } = setup("osc-10mb");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  assert.match(readout(root), /10485773 input bytes\. The safe policy keeps 5 bytes/);
  assert.ok(section(root, 2).textContent.length < 25000, "strict view is capped");
  assert.match(section(root, 0).textContent, /\\x41\{10485760\}/);
});

test("custom input round-trips through the hash; bad input and hostile hashes are handled", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup();
  let root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  const ta = byTag(root, "TEXTAREA")[0];
  ta.value = "<img src=x onerror=alert(1)>\\x1b[6n";
  ta.dispatch("input");
  button(root, "Run").dispatch("click");
  // Was `assert.ok(env.hash().startsWith("t:"))` straight after Run: typed text used to be
  // written to the address on every Run. It now gets there only through "Copy link".
  assert.equal(env.hash(), null, "Run does not put typed text in the address");
  button(root, "Copy link").dispatch("click");
  assert.ok(env.hash().startsWith("t:"));
  assert.match(section(root, 0).textContent, /<img src=x onerror=alert\(1\)>/, "shown as text");
  const saved = env.hash();

  env = setup(saved);
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.equal(byTag(root, "TEXTAREA")[0].value, "<img src=x onerror=alert(1)>\\x1b[6n");
  assert.match(readout(root), /safe policy keeps 28 bytes/);

  env = setup("t:%ZZ");
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.equal(byTag(root, "TEXTAREA")[0].value, "\\x1b[1;31mhi\\x1b[0m");

  ta.value = "\\q";
  env = setup();
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  const ta2 = byTag(root, "TEXTAREA")[0];
  ta2.value = "ab\\q";
  button(root, "Run").dispatch("click");
  assert.match(root.textContent, /Cannot read the input at character 3: unknown escape \\q/);
  assert.equal(ta2.attrs["aria-invalid"], "true");
  assert.equal(env.hash(), null);
  button(root, "Reset").dispatch("click");
  assert.equal(ta2.value, "\\x1b[1;31mhi\\x1b[0m");
});

test("shipped lab code avoids forbidden constructs; CSS is scoped and token-only", () => {
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "https://", "<script", "onload=", "onclick=", "javascript:", "foreignObject", "fetch(", "localStorage"]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
    if (f !== "fallback.svg") assert.ok(!code.includes("http://"), `${f} contains http://`);
  }
  const view = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8");
  assert.match(view, /export function mount/);
  const svg = readFileSync(fileURLToPath(new URL("./fallback.svg", import.meta.url)), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{").slice(-2, -1)[0];
    if (!sel || !block.includes("{")) continue;
    for (const s of sel.replace(/@media[^{]*/, "").split(",")) {
      if (s.trim()) assert.ok(s.trim().startsWith('.lab[data-lab="ansi-filter"]'), `unscoped selector: ${s.trim()}`);
    }
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), "no hard-coded colors");
  assert.ok(!/transition|animation/.test(css), "nothing moves, so reduced motion needs no special case");
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const visuallyHidden = (root) => root.findAll((e) => e.className === "af__vh").map((e) => e.textContent).join("|");

test("accessibility: one live region, prediction verdict spoken first, removals spoken, rules linked", async () => {
  const { ctx, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(root.findAll((e) => e.attrs["aria-live"]).length, 0, "the lab adds no live region of its own");
  const sel = byTag(root, "SELECT")[0];
  sel.value = "osc-title";
  sel.dispatch("change");
  const pred = byTag(root, "INPUT").find((e) => e.attrs.id.endsWith("-predict"));
  pred.value = "ok";
  button(root, "Run").dispatch("click");
  await wait(350);
  assert.match(said.at(-1), /^Prediction correct\. 15 input bytes\./);
  assert.ok(!readout(root).startsWith("Prediction"), "the readout shows the summary; the verdict has its own paragraph");
  // The removed title is announced as removed, not read as if it were kept.
  assert.match(visuallyHidden(section(root, 1)), / removed: \| end removed\. /);
  const link = section(root, 1).findAll((e) => e.tagName === "A")[0];
  assert.equal(link.attrs.href, "#lab-ansi-filter-1-rule-1");
  const rule = section(root, 1).findAll((e) => e.attrs.id === "lab-ansi-filter-1-rule-1")[0];
  assert.ok(rule && rule.attrs.tabindex === "-1");
  let prevented = false;
  link.dispatch("click", { preventDefault: () => { prevented = true; } });
  assert.ok(prevented, "the footnote link does not overwrite the share hash");
  // Scroll boxes can be reached and are named.
  const boxes = root.findAll((e) => e.className === "af__scroll");
  assert.equal(boxes.length, 3);
  for (const b of boxes) assert.ok(b.attrs.tabindex === "0" && b.attrs.role === "region" && b.attrs["aria-label"], "scroll box focusable and named");
  // Strict explains its marks in text, not only in a title attribute.
  assert.equal(root.findAll((e) => e.attrs.title !== undefined).length, 0, "no title-only explanations");
  pred.value = "nope";
  button(root, "Run").dispatch("click");
  await wait(350);
  assert.match(said.at(-1), /^Prediction differs\. The safe policy wrote: ok\./);
  api.destroy();
});

test("strict lists why controls were made visible; replacements are spoken", async () => {
  const { ctx } = setup("strict-golden");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  const strict = section(root, 2);
  assert.match(strict.textContent, /shown in caret notation as \^\[/);
  assert.match(visuallyHidden(strict), /control: /);
  const env = setup("utf8");
  const r2 = new FakeEl("div");
  mount(r2, env.ctx).destroy();
  assert.match(visuallyHidden(section(r2, 1)), / replaced: \| with U\+FFFD: /);
  assert.match(section(r2, 1).textContent, /1 piece removed, 3 replaced by U\+FFFD/);
});

test("the readout and the share hash never go stale", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  button(root, "Run").dispatch("click");
  assert.equal(hash(), "bold-red");
  const ta = byTag(root, "TEXTAREA")[0];
  ta.value = "changed";
  ta.dispatch("input");
  assert.equal(readout(root), "Input changed: press Run.");
  assert.equal(hash(), null);
  button(root, "Run").dispatch("click");
  // Was `assert.ok(hash().startsWith("t:"))`: see the Copy link test below.
  assert.equal(hash(), null, "typed text is not written to the address by Run");
  const sel = byTag(root, "SELECT")[0];
  sel.value = "lone-9b";
  sel.dispatch("change");
  assert.equal(hash(), null, "loading a preset clears the old share state");
  assert.match(readout(root), /^Loaded: /);
});

test("the mid-sequence preset shows the control the terminal runs inside the sequence", async () => {
  const { ctx } = setup("mid-control");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  assert.match(section(root, 0).textContent, /Executed mid-sequence/);
  assert.match(section(root, 0).textContent, /red foreground/);
});

test("typed text reaches the address only through Copy link; a link with text still opens", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup();
  let root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  const ta = byTag(root, "TEXTAREA")[0];
  // Copy link before Run: nothing was run, so there is nothing to link to (and nothing is written).
  ta.value = "secret ZQXJ \\x1b[6n";
  ta.dispatch("input");
  button(root, "Copy link").dispatch("click");
  assert.equal(env.hash(), null);
  assert.match(readout(root), /Press Run first/);
  button(root, "Run").dispatch("click");
  assert.equal(env.hash(), null, "pasted text is not copied into the address");
  button(root, "Copy link").dispatch("click");
  assert.equal(env.hash(), "t:" + encodeURIComponent("secret ZQXJ \\x1b[6n"));
  // Running the same text again keeps the link that was asked for; new text clears it.
  button(root, "Run").dispatch("click");
  assert.ok(env.hash().startsWith("t:"));
  ta.value = "other";
  ta.dispatch("input");
  assert.equal(env.hash(), null);
  button(root, "Run").dispatch("click");
  assert.equal(env.hash(), null);
  // A preset is still reflected when it is run, and Copy link keeps it.
  const sel = byTag(root, "SELECT")[0];
  sel.value = "lone-9b";
  sel.dispatch("change");
  button(root, "Run").dispatch("click");
  assert.equal(env.hash(), "lone-9b");
  button(root, "Copy link").dispatch("click");
  assert.equal(env.hash(), "lone-9b");

  // A link that carries text: analysed on mount, the address left as it was.
  env = setup("t:hi%5Cx1b%5B6n");
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.equal(byTag(root, "TEXTAREA")[0].value, "hi\\x1b[6n");
  assert.match(readout(root), /safe policy keeps 2 bytes/);
  assert.equal(env.hash(), "t:hi%5Cx1b%5B6n");
});

test("a repeat count in a link is refused before it is expanded; the same text typed in still runs", async () => {
  const { mount } = await import("./view.mjs");
  // `#ansi-filter=t:%5Cx9b%7B16777215%7Dm`: 16 MiB of 0x9B, about 4 s of main thread on mount.
  for (const link of ["t:%5Cx9b%7B16777215%7Dm", "t:\\x9b{16777215}m", "t:a%5Cx41%7B65536%7D"]) {
    const env = setup(link);
    const root = new FakeEl("div");
    const t0 = performance.now();
    mount(root, env.ctx).destroy();
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${link}: mount took ${ms.toFixed(1)} ms`);
    assert.match(root.textContent, /input is longer than 65536 bytes\. This text came in a link/, link);
    assert.equal(byTag(root, "TEXTAREA")[0].attrs["aria-invalid"], "true");
  }
  // At the cap it runs; and the reader's own edit of a link's text is held to the typed limit.
  const env = setup("t:%5Cx41%7B65536%7D");
  const root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  assert.match(readout(root), /^65536 input bytes\./);
  const ta = byTag(root, "TEXTAREA")[0];
  ta.value = "\\x41{65537}";
  ta.dispatch("input");
  button(root, "Run").dispatch("click");
  assert.match(readout(root), /^65537 input bytes\./);
});
