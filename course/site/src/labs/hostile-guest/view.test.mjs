// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that the buttons drive the model, that the run loop stops at the captured
// failure, that the share hash is written and read back, and that nothing is parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    this.style = {};
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
  focus() { globalThis.document.activeElement = this; }
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

async function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "hostile-guest", id: "lab-hostile-guest-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const btn = (text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  const byId = (suffix) => root.findAll((e) => e.attrs.id === `${ctx.id}-${suffix}`)[0];
  const byClass = (c) => root.findAll((e) => e.classList.contains(c))[0];
  const change = (suffix, value) => { const e = byId(suffix); e.value = value; e.dispatch("change"); };
  return { root, ctx, said, handle, btn, byId, byClass, change, hash: () => stored };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("mounts quietly; stepping plant 2 fails at iteration 7 like the capture", async () => {
  const t = await setup();
  assert.equal(t.hash(), null);
  assert.ok(t.byClass("hg-insp").hidden);
  for (let i = 0; i < 8; i++) t.btn("One iteration").dispatch("click");
  assert.equal(t.hash(), "p2:1:7");
  assert.match(t.byClass("hg-term").textContent, /fuzz virtqueue: FAILURE at iteration 7 \(seed 1\): 2838 descriptor reads for one pop of a size-2 queue \(VQ-5 hop budget\)/);
  assert.match(t.byClass("hg-verdict").textContent, /FAILED, invariant 2/);
  assert.match(t.byClass("hg-insp").textContent, /Showing the first 64 of 2,838 steps of this walk; the rest go round the same loop/);
  assert.match(t.byClass("hg-readout").textContent, /Next: press Shrink it/);
  assert.match(t.byClass("hg-pop--last").textContent, /\(the failing pop\)$/);
  assert.equal(t.root.findAll((e) => e.attrs["aria-pressed"] !== undefined).length, 0, "Run is a plain button");
  for (const box of t.root.findAll((e) => e.classList.contains("hg-scroll"))) {
    assert.equal(box.attrs.tabindex, undefined, "no tab stop while the table fits");
    assert.equal(box.attrs.role, "region");
    assert.match(box.attrs["aria-label"], /scrolls sideways/);
  }
  assert.equal(t.byId("plant").attrs["aria-describedby"], `${t.ctx.id}-plantnote`);
  assert.match(t.byId("plantnote").textContent, /no longer counts hops/);
  t.handle.destroy();
});

test("the run loop stops at plant 3's captured failure", async () => {
  const t = await setup();
  t.change("plant", "p3");
  t.btn("Run the fuzzer").dispatch("click");
  for (let k = 0; k < 200 && t.hash() === null; k++) await wait(5);
  assert.equal(t.hash(), "p3:1:22");
  const term = t.byClass("hg-term").textContent;
  assert.match(term, /FAILURE at iteration 22 \(seed 1\): device wrote 0x40003014\+8 outside the writable buffers and the used ring \(used ring 0x40003000\+0x16; VQ-9\)/);
  assert.match(term, /fuzz virtqueue: 23 iterations, 1 failures/);
  assert.ok(!t.byClass("hg-stripbox").hidden, "the bad write is drawn");
  await wait(350); // announcements are throttled to one per 300 ms
  assert.ok(t.said.some((s) => /Failure at iteration 22/.test(s)));
  t.handle.destroy();
});

test("a shared link replays plant 5's iteration; switching plant replays it on the reference", async () => {
  const t = await setup("p5:1:23338941");
  assert.equal(t.byId("plant").value, "p5");
  assert.match(t.byClass("hg-verdict").textContent, /validated buffer 0x40003000\+0x80000000 is not inside one RAM region \(VQ-4\)/);
  assert.match(t.byClass("hg-insp").textContent, /accepted without a RAM check/);
  t.change("plant", "ref");
  assert.equal(t.hash(), "ref:1:23338941");
  assert.match(t.byClass("hg-verdict").textContent, /^Passed/);
  assert.match(t.byClass("hg-readout").textContent, /^No plant: the reference\. Replayed iteration 23,338,941: passes, /);
  t.change("plant", "p5");
  assert.match(t.byClass("hg-readout").textContent, /Replayed iteration 23,338,941: fails invariant 4: validated buffer/);
  t.handle.destroy();
});

test("three-buffer replay, shrink and reset", async () => {
  const t = await setup();
  t.change("plant", "p5");
  t.btn("Replay the hand-built three-buffer input").dispatch("click");
  assert.equal(t.hash(), "p5:three");
  assert.match(t.byClass("hg-term").textContent, /replay FAILED: validated buffer 0x40008000\+0x40000 is not inside one RAM region \(VQ-4\)/);
  t.byId("iter").value = "23,338,941";
  t.btn("Replay iteration").dispatch("click");
  assert.equal(t.hash(), "p5:1:23338941");
  t.btn("Shrink it").dispatch("click");
  assert.equal(t.hash(), "p5:1:23338941:m");
  assert.equal(document.activeElement?.textContent, "How it was shrunk", "focus moves off the disabled button");
  assert.match(t.byClass("hg-verdict").textContent, /FAILED, invariant 4/);
  t.btn("Reset").dispatch("click");
  assert.equal(t.hash(), null);
  assert.ok(t.byClass("hg-insp").hidden);
  t.handle.destroy();
});

test("bad seed and iteration text are refused with a note", async () => {
  const t = await setup();
  t.byId("seed").value = "-3";
  t.btn("One iteration").dispatch("click");
  assert.equal(t.hash(), null);
  assert.match(t.root.textContent, /The seed is a whole number/);
  assert.equal(t.byId("seed").attrs["aria-invalid"], "true");
  assert.equal(t.byId("seed").attrs["aria-describedby"], `${t.ctx.id}-fuzznote`);
  assert.equal(t.byId("fuzznote").attrs.role, undefined, "one voice: no second live region");
  assert.equal(document.activeElement, t.byId("seed"), "focus moves to the refused field");
  await wait(350);
  assert.ok(t.said.some((s) => /The seed is a whole number/.test(s)), "the error is announced");
  t.byId("seed").value = "2";
  t.byId("iter").value = "1e9";
  t.btn("Replay iteration").dispatch("click");
  assert.match(t.root.textContent, /The iteration is a whole number/);
  assert.equal(t.byId("seed").attrs["aria-invalid"], undefined, "a fixed seed is no longer marked");
  assert.equal(t.byId("iter").attrs["aria-invalid"], "true");
  assert.equal(document.activeElement, t.byId("iter"));
  t.handle.destroy();
});

test("changing the plant while fuzzing says it paused", async () => {
  const t = await setup();
  t.change("plant", "ref");
  t.btn("Run the fuzzer").dispatch("click");
  await wait(40);
  t.change("plant", "p1");
  assert.match(t.byClass("hg-readout").textContent, /^Plant 1: no checked_add\. Fuzzing paused\./);
  assert.match(t.byClass("hg-term").textContent, /\[lab\] fuzzing paused after/);
  assert.equal(t.btn("Run the fuzzer") !== undefined, true);
  t.handle.destroy();
});

test("a shrunk share of a passing input is shown unshrunk", async () => {
  const t = await setup("ref:1:0:m");
  assert.equal(t.hash(), "ref:1:0");
  assert.doesNotMatch(t.byClass("hg-insp").textContent, /shrunk/);
  t.handle.destroy();
});

test("a shrunk share prints the shrunk input's verdict, as the inspector shows", async () => {
  const t = await setup("p2:1:7:m");
  const verdict = t.byClass("hg-verdict").textContent.replace(/^FAILED, invariant 2: /, "");
  assert.match(t.byClass("hg-term").textContent, new RegExp(`replay FAILED: ${verdict.replace(/[()+.]/g, "\\$&")}`));
  t.handle.destroy();
});

test("a passing step prints a line; plant select follows the chapter", async () => {
  const t = await setup();
  t.change("plant", "ref");
  t.btn("One iteration").dispatch("click");
  assert.match(t.byClass("hg-term").textContent, /\[lab\] iteration 0 passed: /);
  const sel = t.byId("plant");
  assert.deepEqual(sel.children.filter((c) => c.tagName === "OPTION").map((o) => o.attrs.value), ["ref", "p2", "p5"]);
  const group = sel.children.find((c) => c.tagName === "OPTGROUP");
  assert.deepEqual(group.children.map((o) => o.attrs.value), ["p1", "p3", "p4"]);
  t.change("plant", "p1");
  assert.match(t.byId("plantnote").textContent, /Deliberate breakage 1/);
  t.change("plant", "p5");
  assert.match(t.byClass("hg-status").textContent, /keep this tab in front/i);
  t.handle.destroy();
});

test("a refused chain leaves invariants 3 to 5 not reached", async () => {
  const { runInput } = await import("./model.mjs");
  const bytes = new Uint8Array(600);
  bytes[0] = 1; bytes[2] = 1; // size 2, one chain
  bytes[520 + 12] = 4; // descriptor 0 INDIRECT without the feature: refused
  const r = runInput(bytes, 0);
  assert.equal(r.ok, true);
  assert.match(r.outcome, /^chain refused/);
  assert.equal(r.notReached, 3);
});

test("a hostile hash is ignored", async () => {
  const t = await setup("p2:1:7<img src=x>");
  assert.ok(t.byClass("hg-insp").hidden);
  t.handle.destroy();
});

test("shipped code follows the CSP rules", () => {
  for (const f of ["view.mjs", "model.mjs"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    for (const bad of ["innerHTML", "eval(", "new Function", "http://", "https://", "document.write", "WebAssembly", 'setAttribute("style"', "localStorage", "fetch("]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
  const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  for (const line of css.split("\n")) {
    const sel = line.trim();
    if (sel.startsWith(".") || sel.startsWith("#")) assert.ok(sel.startsWith('.lab[data-lab="hostile-guest"]'), sel);
  }
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(css), "no hard-coded colours");
});
