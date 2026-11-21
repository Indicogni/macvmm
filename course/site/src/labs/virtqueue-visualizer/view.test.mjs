// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders both modes, that buttons, selects and checkboxes drive the model, that the share
// hash is written and read back, that refusals are explained, and that nothing is parsed as HTML.
// It also checks the shipped files against the builder's rules (course/site/LABS.md sections 1, 4, 7).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
    this._value = "";
    const self = this;
    this.classList = {
      add: (c) => { if (!self.className.split(" ").includes(c)) self.className = `${self.className} ${c}`.trim(); },
      remove: (c) => { self.className = self.className.split(" ").filter((x) => x !== c).join(" "); },
    };
  }
  removeAttribute(k) { delete this.attrs[k]; }
  get value() {
    if (this.tagName === "SELECT" && this._value === "") {
      const first = this.children.find((c) => c.tagName === "OPTION");
      return first ? first.attrs.value : "";
    }
    return this._value;
  }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value" && this.tagName !== "OPTION") this._value = v;
    if (k === "hidden") this.hidden = true;
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
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  globalThis.window = { location: { href: "x" } };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "virtqueue-visualizer", id: "lab-virtqueue-visualizer-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const visible = (e, root) => {
  // An element is visible if neither it nor an ancestor is hidden.
  const path = [];
  const find = (node) => {
    if (node === e) return true;
    for (const c of node.children || []) if (c instanceof FakeEl && find(c)) { path.push(c); return true; }
    return false;
  };
  find(root);
  return !e.hidden && path.every((p) => !p.hidden);
};
const button = (root, text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
const byId = (root, id) => root.findAll((e) => e.attrs.id === id)[0];
const readout = (root) => root.findAll((e) => e.className === "vq-readout")[0].textContent;
const refusal = (root) => root.findAll((e) => e.className === "vq-refusal")[0].textContent;
const checks = (root) => root.findAll((e) => e.tagName === "LI" && /vq-check-|vq-gap/.test(e.className)).map((e) => e.textContent);

test("the toy: eight Next steps, three exits, then Next is disabled", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(hash(), null, "the default state clears the hash");
  const next = button(root, "Next step");
  assert.ok(visible(next, root));
  assert.ok(!visible(button(root, "Device: process one"), root), "ring controls hidden in the toy");
  for (let i = 0; i < 8; i++) next.dispatch("click");
  assert.equal(hash(), "toy.8");
  assert.match(readout(root), /Exits so far: 3\.$/);
  assert.equal(next.attrs["aria-disabled"], "true", "unavailable, but still focusable");
  assert.ok(!next.disabled);
  assert.ok(root.textContent.includes("3 exits for 4096 bytes"));
  next.dispatch("click");
  assert.match(refusal(root), /The toy is finished/, "pressing it says why");
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "toy.7");
  api.destroy();
});

test("ring mode through the buttons: a disk read, doorbell, process, reclaim", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const ring = byId(root, "lab-virtqueue-visualizer-1-mode-ring");
  ring.checked = true;
  ring.dispatch("change");
  assert.equal(hash(), "ring-n8-s0-c10000");
  const proc = button(root, "Device: process one");
  assert.equal(proc.attrs["aria-disabled"], "true", "nothing to process yet");
  assert.ok(!proc.disabled, "never disabled: it keeps focus and explains itself");
  assert.match(root.textContent, /Try next: Driver: add request/);
  button(root, "Driver: add request").dispatch("click");
  button(root, "Driver: ring the doorbell").dispatch("click");
  button(root, "Device: process one").dispatch("click");
  assert.match(readout(root), /reported used\.len = 513/);
  assert.ok(checks(root).some((t) => t.includes("release store of used.idx")));
  button(root, "Driver: reclaim used").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:qr10.w200.w1_n_p_u");
  assert.match(readout(root), /Exits: 3\.$/);
});

test("a refused action is explained, not silently dropped", async () => {
  const { ctx, hash } = setup("ring-n8-s0-c10000");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, "Device: process one").dispatch("click");
  assert.match(refusal(root), /No doorbell yet/);
  assert.equal(hash(), "ring-n8-s0-c10000");
});

test("the opening-puzzle scenario, then the hop budget removed", async () => {
  const { ctx, hash } = setup("ring-n8-s0-c10000");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, "Driver: add request").dispatch("click");
  const preset = byId(root, "lab-virtqueue-visualizer-1-preset");
  preset.value = "puzzle";
  preset.dispatch("change");
  assert.equal(hash(), "ring-n8-s0-c10000:qr10.w200.w1", "choosing only previews");
  button(root, "Load scenario").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:hloop_n");
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:qr10.w200.w1", "Undo brings the ring back");
  preset.value = "puzzle";
  button(root, "Load scenario").dispatch("click");
  button(root, "Device: process one").dispatch("click");
  const list = checks(root);
  assert.ok(list.some((t) => t.includes("hop 8: descriptor 0 (budget 1 → 0)")));
  assert.ok(list.some((t) => t.includes("hop 9: budget exhausted")));
  assert.match(readout(root), /virtqueue: ChainTooLong \{ budget: 8 \}/);
  const nb = byId(root, "lab-virtqueue-visualizer-1-nobudget");
  nb.checked = true;
  nb.dispatch("change");
  assert.equal(hash(), "ring-n8-s0-c10000-nobudget:hloop_n_p");
  assert.match(readout(root), /TooLarge \{ total: 65544, max: 65536 \} at hop 8,193/);
  assert.ok(checks(root).some((t) => t.includes("more hops like these")));
});

test("hostile mode and a custom chain from the controls; mount from a hash", async () => {
  const { ctx, hash } = setup("ring-n8-s0-c10000");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const hostileBox = root.findAll((e) => e.className === "vq-hostile")[0];
  assert.ok(hostileBox.hidden, "hostile controls start hidden");
  const chk = byId(root, "lab-virtqueue-visualizer-1-hostile");
  chk.checked = true;
  chk.dispatch("change");
  assert.ok(!hostileBox.hidden);
  const hsel = root.findAll((e) => e.tagName === "SELECT" && e.attrs.id === "lab-virtqueue-visualizer-1-hostile-kind")[0];
  hsel.value = "mmio";
  hsel.dispatch("change");
  button(root, "Hostile driver: publish it").dispatch("click");
  button(root, "Driver: ring the doorbell").dispatch("click");
  button(root, "Device: process one").dispatch("click");
  assert.match(readout(root), /BufferOutOfRam \{ addr: 150994944, len: 4 \}/);
  button(root, "Driver: reset the device").dispatch("click");
  const shape = byId(root, "lab-virtqueue-visualizer-1-shape");
  shape.value = "custom";
  shape.dispatch("change");
  byId(root, "lab-virtqueue-visualizer-1-c1-kind").value = "";
  byId(root, "lab-virtqueue-visualizer-1-c0-len").value = "40";
  byId(root, "lab-virtqueue-visualizer-1-c0-len").dispatch("input");
  button(root, "Driver: add request").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:hmmio_n_p_z_qr28");

  const again = setup("ring-n8-s0-c10000-reread:hflip_n_p");
  const root2 = new FakeEl("div");
  mount(root2, again.ctx);
  assert.match(readout(root2), /TooLarge \{ total: 4294967295, max: 65536 \}/);
  assert.equal(again.hash(), "ring-n8-s0-c10000-reread:hflip_n_p");
  const bad = setup("ring-n8-s0-c10000:<img>");
  const root3 = new FakeEl("div");
  mount(root3, bad.ctx);
  assert.equal(bad.hash(), null, "a malformed hash falls back to the default");
});

test("shipped files follow the builder's rules", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const shipped = readdirSync(dir).filter((f) => !f.endsWith(".test.mjs"));
  for (const f of shipped) assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed file type`);
  for (const f of shipped.filter((x) => x.endsWith(".mjs"))) {
    const code = readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const banned of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch(", "localStorage", "document.body", "document.querySelector"]) {
      assert.ok(!code.includes(banned), `${f} contains ${banned}`);
    }
  }
  assert.match(readFileSync(dir + "view.mjs", "utf8"), /export function mount\(/);
  const css = readFileSync(dir + "style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    const sel = rule.split("{")[0].trim();
    if (!sel || sel.startsWith("@media")) continue;
    for (const part of sel.replace(/^@media[^{]*\{/, "").split(",")) {
      assert.ok(part.trim().startsWith('.lab[data-lab="virtqueue-visualizer"]'), `unscoped selector: ${part.trim()}`);
    }
    assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,6}\b|rgb\(|hsl\(/, "colors come from the site's tokens");
  }
  const svg = readFileSync(dir + "fallback.svg", "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  assert.doesNotMatch(svg, /<script|<style|\sstyle=|\son[a-z]+=|foreignObject|href=/i);
});

test("settings that start a fresh ring can be undone; Reset too", async () => {
  const { ctx, hash } = setup("ring-n8-s0-c10000:qr10.w200.w1_n");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const n = byId(root, "lab-virtqueue-visualizer-1-n");
  n.value = "4";
  n.dispatch("change");
  n.value = "2";
  n.dispatch("change");
  assert.equal(hash(), "ring-n2-s0-c10000");
  button(root, "Undo").dispatch("click");
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:qr10.w200.w1_n");
  button(root, "Reset").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000");
  const reset = button(root, "Reset");
  assert.equal(reset.attrs["aria-disabled"], "true");
  button(root, "Undo").dispatch("click");
  assert.equal(hash(), "ring-n8-s0-c10000:qr10.w200.w1_n");
});

test("mount leaves the address bar alone unless it must correct a shared link", async () => {
  const a = setup(null);
  const { mount } = await import("./view.mjs");
  let writes = 0;
  const set = a.ctx.hash.set;
  a.ctx.hash.set = (v) => { writes += 1; set(v); };
  mount(new FakeEl("div"), a.ctx);
  assert.equal(writes, 0, "an untouched lab writes no hash (a heading anchor survives)");
  const b = setup("ring-n8-s0-c10000:qr10.w200.w1_p_p");
  mount(new FakeEl("div"), b.ctx);
  assert.equal(b.hash(), "ring-n8-s0-c10000:qr10.w200.w1", "cut to the allowed prefix");
});

test("toy announcements say what the step did; ring cells written last are named", async () => {
  const { ctx, said } = setup("toy.2");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  button(root, "Next step").dispatch("click");
  await new Promise((r) => setTimeout(r, 350));
  assert.match(said.at(-1), /^Step 3 of 8: .*first VM exit/);
  const r2 = new FakeEl("div");
  mount(r2, setup("ring-n8-s0-c10000:qr10.w200.w1").ctx);
  const cells = r2.findAll((e) => e.tagName === "TD" && /vq-cell--changed/.test(e.className));
  assert.ok(cells.length >= 1);
  for (const c of cells) assert.match(c.textContent, /\(just written\)/);
  assert.equal(r2.findAll((e) => e.tagName === "H4").length, 0, "lab headings are h3 under the shell's h2");
  const group = r2.findAll((e) => e.attrs.role === "group")[0];
  assert.ok(!group.findAll((e) => e.tagName === "BUTTON").some((b) => b.textContent === "Next step"), "Next step is not in History");
});
