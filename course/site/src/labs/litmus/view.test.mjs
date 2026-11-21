// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that step buttons drive the model, that the outcome list and "Show me" work,
// that the share hash is written and read back, and that nothing is ever parsed as HTML.
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
    this.value = "";
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
    if (k === "hidden") this.hidden = true;
    if (k === "class") this.className = v;
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
  focus() { globalThis.document.activeElement = this; }
}

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t), activeElement: null };
  let stored = hash;
  const ctx = {
    name: "litmus", id: "lab-litmus-1", base: "", standalone: true, reducedMotion: true,
    announce: () => {},
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, hash: () => stored };
}

const buttons = (root) => root.findAll((e) => e.tagName === "BUTTON");
const button = (root, re) => {
  const b = buttons(root).find((x) => re.test(x.textContent));
  assert.ok(b, `no button matching ${re}`);
  return b;
};
const readout = (root) => root.findAll((e) => e.attrs["aria-live"] === "polite")[0].textContent;
const selectById = (root, suffix) => root.findAll((e) => e.tagName === "SELECT" && e.attrs.id === `lab-litmus-1-${suffix}`)[0];

test("default mount: sb on arm64, relaxed, hash cleared, four steps offered", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(hash(), null);
  assert.match(readout(root), /sb: store buffering .* on arm64 \(Apple Silicon\)\. 4 steps available\./);
  assert.match(root.textContent, /X\.store\(1, Relaxed\)/);
  assert.match(root.textContent, /str/);
  api.destroy();
});

test("stepping into the reference: both loads read 0 while both stores wait", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, /^Thread A: X\.store\(1, Relaxed\), X = 1 waits in the store buffer$/).dispatch("click");
  button(root, /^Thread B: Y\.store\(1, Relaxed\)/).dispatch("click");
  button(root, /^Thread A: let r1 = Y\.load\(Relaxed\), reads 0 from memory$/).dispatch("click");
  button(root, /^Thread B: let r2 = X\.load\(Relaxed\), reads 0 from memory$/).dispatch("click");
  assert.equal(hash(), "sb.arm.rnr.rnr.a0b0a2b2");
  button(root, /^Thread A's store buffer: X = 1 reaches memory$/).dispatch("click");
  button(root, /^Thread B's store buffer: Y = 1 reaches memory$/).dispatch("click");
  assert.match(root.textContent, /Finished with the bad outcome: r1 = 0, r2 = 0\. That is both threads read 0\./);
  assert.match(readout(root), /Finished with the bad outcome/);
  button(root, /^Undo step$/).dispatch("click");
  assert.equal(hash(), "sb.arm.rnr.rnr.a0b0a2b2A0");
});

test("a shared hash restores the run; listing outcomes shows the verdict and the measurement", async () => {
  const { ctx } = setup("sb.arm.lna.lna");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.equal(selectById(root, "preset").value, "acqrel");
  button(root, /^List every outcome$/).dispatch("click");
  const text = root.textContent;
  assert.match(text, /Every outcome arm64 \(Apple Silicon\) allows \(4, from \d+ reachable states\)/);
  assert.match(text, /arm64: the bad outcome is allowed\./);
  assert.match(text, /Measured on arm64 \(Apple M5 Pro\), \.\/litmus sb acqrel: 0 of 2,000,000 rounds\./);
  assert.match(text, /A zero that fools you\./);
  assert.match(readout(root), /4 outcomes allowed\. The bad outcome is allowed on arm64\./);
});

test("Show me replays the witness for the bad outcome", async () => {
  const { ctx, hash } = setup("mp.arm.rnr.rnr");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, /^List every outcome$/).dispatch("click");
  const show = buttons(root).find((b) => /flag = 1, data = 0/.test(b.attrs["aria-label"] || ""));
  assert.ok(show);
  show.dispatch("click");
  assert.match(hash(), /^mp\.arm\.rnr\.rnr\.[abAB0-2]+$/);
  assert.match(root.textContent, /Finished with the bad outcome: flag = 1, data = 0\. That is flag up, data missing\./);
  assert.ok(!/thread_b/.test(root.textContent));
  // Focus moved to the banner that states the result (the pressed button is gone).
  assert.match(document.activeElement.className, /lm-banner/);
  assert.equal(document.activeElement.attrs.tabindex, "-1");
});

test("changing machine, test, preset and one ordering restarts and updates the hash", async () => {
  const { ctx, hash } = setup("sb.arm.rnr.rnr.a0");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const machine = selectById(root, "machine");
  machine.value = "tso";
  machine.dispatch("change");
  assert.equal(hash(), "sb.tso.rnr.rnr");
  const t = selectById(root, "test");
  t.value = "used";
  t.dispatch("change");
  assert.equal(hash(), "used.tso.rnl.rar");
  const preset = selectById(root, "preset");
  preset.value = "norelease";
  preset.dispatch("change");
  assert.equal(hash(), "used.tso.rnr.rar");
  button(root, /^List every outcome$/).dispatch("click");
  assert.match(root.textContent, /x86-64: the bad outcome is impossible\./);
  assert.match(root.textContent, /x86-64 cannot produce it with these instructions, but both sides' rules \(Rust's for macvmm, Linux's for the driver/);
  // Edit the device's used.idx store back to Release through the per-access select.
  const o = selectById(root, "o02");
  o.value = "l";
  o.dispatch("change");
  assert.equal(hash(), "used.tso.rnl.rar");
  assert.match(readout(root), /macvmm worker \(device\) now: Relaxed, no fence, Release\. Run restarted\./);
  // Hostile select values are ignored.
  o.value = "<img>";
  o.dispatch("change");
  t.value = "constructor";
  t.dispatch("change");
  assert.equal(hash(), "used.tso.rnl.rar");
});

test("hardware-only verdict: stlr then ldar on arm64", async () => {
  const { ctx } = setup("sb.arm.lns.lns");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.match(root.textContent, /Custom \(edited below\)/);
  button(root, /^List every outcome$/).dispatch("click");
  assert.match(root.textContent, /correct only by accident of this hardware and how the compiler translates it/);
  button(root, /^Thread A: X\.store\(1, Release\)/).dispatch("click");
  assert.match(root.textContent, /Waits: ldar never runs before an earlier stlr has reached memory\./);
});

test("hostile hashes fall back to the default", async () => {
  const { mount } = await import("./view.mjs");
  for (const bad of ["<script>alert(1)</script>", "sb.arm.rnr.rnr.zz", "constructor.arm.rnr.rnr", "sb.arm.xxx.rnr"]) {
    const env = setup(bad);
    const root = new FakeEl("div");
    mount(root, env.ctx);
    assert.equal(env.hash(), null, bad);
  }
});

test("shipped lab code avoids forbidden constructs", () => {
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "https://", "<script", "onload=", "onclick=", "javascript:", "foreignObject", "setTimeout(\"", "style=", "fetch(", "localStorage"]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
    if (f !== "fallback.svg") assert.ok(!code.includes("http://"), `${f} contains http://`);
  }
  const svg = readFileSync(fileURLToPath(new URL("./fallback.svg", import.meta.url)), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{").slice(-2, -1)[0];
    if (!sel || !block.includes("{")) continue;
    for (const one of sel.split(",")) {
      const t = one.trim();
      if (t && !t.startsWith("@media")) assert.ok(t.startsWith('.lab[data-lab="litmus"]'), `unscoped selector: ${t}`);
    }
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), "no hard-coded colors");
});

test("keyboard focus stays in the step list after each step, then lands on the banner", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const steps = () => root.findAll((e) => e.attrs.class === "lm-steps")[0].children.filter((c) => c.tagName === "BUTTON");
  for (let i = 0; i < 6; i++) {
    const b = steps()[0];
    b.focus();
    b.dispatch("click");
    const now = steps();
    if (now.length) assert.ok(now.includes(document.activeElement), `step ${i}: focus left the step list`);
  }
  assert.equal(steps().length, 0);
  assert.match(document.activeElement.className, /lm-banner/);
  assert.match(document.activeElement.textContent, /^Finished/);
});

test("changing an ordering keeps the same select element (and so its focus)", async () => {
  const { ctx } = setup("sb.arm.rnr.rnr");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const o = selectById(root, "o01");
  o.focus();
  o.value = "s";
  o.dispatch("change");
  assert.equal(selectById(root, "o01"), o);
  assert.equal(document.activeElement, o);
  assert.equal(o.value, "s");
  // A preset change updates the existing selects' values.
  const preset = selectById(root, "preset");
  preset.value = "seqcst";
  preset.dispatch("change");
  assert.equal(selectById(root, "o00"), root.findAll((e) => e.attrs.id === "lab-litmus-1-o00")[0]);
  assert.equal(selectById(root, "o00").value, "s");
  assert.equal(selectById(root, "o01").value, "n");
});

test("picking mp fence keeps it selected even though it is the acqrel code", async () => {
  const { ctx } = setup("mp.arm.rnr.rnr");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const preset = selectById(root, "preset");
  preset.value = "fence";
  preset.dispatch("change");
  assert.equal(selectById(root, "preset").value, "fence");
  assert.match(readout(root), /mp fence/);
});

test("the paper model: no 'correct by accident', and the real machines' answers are shown", async () => {
  const { ctx } = setup("sb.sc.rnr.rnr");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.ok(!/compiles to/.test(root.textContent), "no instruction column on the paper model");
  assert.match(root.textContent, /The paper model has no instructions/);
  button(root, /^List every outcome$/).dispatch("click");
  const text = root.textContent;
  assert.match(text, /interleaving: the bad outcome is impossible on paper\./);
  assert.match(text, /Trying every interleaving on paper never gives it, but Rust's rules allow it/);
  assert.match(text, /arm64 produces it, and x86-64 produces it/);
  assert.match(text, /So this code is wrong\./);
  assert.ok(!/by accident/.test(text));
  assert.match(text, /These counts are for arm64, not Interleaving only/);
  assert.ok(!/A zero that fools you\. /.test(text));
});

test("x86-64 with sb acqrel: counts labelled arm64, no fooling-zero banner", async () => {
  const { ctx } = setup("sb.tso.lna.lna");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, /^List every outcome$/).dispatch("click");
  const text = root.textContent;
  assert.match(text, /x86-64: the bad outcome is allowed\./);
  assert.match(text, /Measured on arm64 \(Apple M5 Pro\)/);
  assert.match(text, /These counts are for arm64, not x86-64 \(TSO\)/);
  assert.ok(!/A zero that fools you\. /.test(text));
});

test("virtqueue tests: the rules verdict is cross-language", async () => {
  const { ctx } = setup("lw.arm.sns.rsr");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, /^List every outcome$/).dispatch("click");
  const text = root.textContent;
  assert.match(text, /Forbidden by both sides' rules \(Rust's for macvmm, Linux's for the driver, argued in Arm terms/);
  assert.ok(!/Forbidden by Rust's rules/.test(text));
});

test("program lines carry hidden separators; inner headings sit below the shell's", async () => {
  const embedded = setup();
  embedded.ctx.standalone = false;
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, embedded.ctx);
  const line = root.findAll((e) => e.tagName === "LI" && /lm-line/.test(e.className))[0];
  assert.equal(line.textContent, "ready: X.store(1, Relaxed), compiles to str");
  assert.ok(root.findAll((e) => e.tagName === "H4").length >= 4);
  assert.equal(root.findAll((e) => e.tagName === "H3").length, 0);
  const alone = setup();
  const r2 = new FakeEl("div");
  mount(r2, alone.ctx);
  assert.ok(r2.findAll((e) => e.tagName === "H2").length >= 4);
  // The scrolling exercise table and the log are reachable by keyboard.
  const region = root.findAll((e) => e.attrs.role === "region")[0];
  assert.equal(region.attrs.tabindex, "0");
  assert.match(region.attrs["aria-label"], /scrolls sideways/);
});
