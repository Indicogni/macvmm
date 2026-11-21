// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that Step/Back, the scenario picker and the driver form drive the model, that
// the share hash is written and read back, and that nothing is ever parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preset, replay, formatTrace } from "./model.mjs";

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

async function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  globalThis.window = { location: { href: "x" } };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "virtio-status", id: "lab-virtio-status-1", base: "", standalone: true, reducedMotion: true,
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

test("mounts on the probe's handshake and steps to the captured trace", async () => {
  const t = await setup();
  assert.equal(t.hash(), null, "the default state clears the hash");
  assert.ok(t.btn("Back").disabled);
  assert.match(t.byClass("vs-next").textContent, /Next step \(1 of 33\): read MagicValue/);
  const n = preset("probe").actions.length;
  for (let i = 0; i < n; i++) t.btn("Step").dispatch("click");
  assert.equal(t.hash(), "probe");
  assert.ok(t.btn("Step").disabled);
  assert.equal(t.byClass("vs-plain").textContent, formatTrace(replay("probe", preset("probe").actions)));
  assert.match(t.byClass("vs-readout").textContent, /Status 0xf/);
  t.btn("Back").dispatch("click");
  assert.equal(t.hash(), "probe~32");
  t.handle.destroy();
});

test("a shared misbehaving state restores, with its warning shown", async () => {
  const p = preset("outside-ram");
  const k = p.actions.findIndex((a) => a.op === "w" && a.off === 0x70 && a.val === 0xf) + 1;
  assert.equal(k, 25);
  const t = await setup(`outside-ram~${k}`);
  assert.equal(t.byId("preset").value, "outside-ram");
  // Step 25 is the DRIVER_OK write: the ring check fails.
  assert.match(t.byClass("vs-readout").textContent, /DEVICE_NEEDS_RESET/);
  const warn = t.byClass("vs-warn");
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /queue 0 refused at DRIVER_OK: virtqueue: RingOutOfRam \{ ring: Used/);
  assert.match(t.byClass("vs-flags").textContent, /DEVICE_NEEDS_RESET/);
  t.btn("Run to end").dispatch("click");
  assert.equal(t.hash(), "outside-ram");
  assert.equal(p.actions.length, 33);
});

test("hostile hashes fall back to the default without throwing", async () => {
  for (const h of ["rng:<img src=x>", "probe~999", "zzz", "rng:" + "r0_".repeat(300)]) {
    const t = await setup(h);
    assert.equal(t.byId("preset").value, "probe");
  }
});

test("the predict select scores a write and is hidden before a read", async () => {
  const t = await setup("skip-features~8");
  // Next step (9) is "write Status = 0x7": out of order, so the device ignores it.
  assert.match(t.byClass("vs-next").textContent, /write Status = 0x7/);
  const field = t.byId("guess");
  assert.ok(field);
  field.value = "takes";
  field.dispatch("change");
  t.btn("Step").dispatch("click");
  assert.match(t.byClass("vs-score").textContent, /You predicted the device takes it; it did not take it/);
  assert.match(t.byClass("vs-warn").textContent, /Status 7 after 3 ignored: bits out of order/);
});

test("the driver form adds steps, and the scenario picker loads a preset", async () => {
  const t = await setup();
  t.btn("Reset (no steps)").dispatch("click");
  t.byId("reg").value = "112"; // Status, 0x070
  t.byId("val").value = "0x2";
  t.btn("Write").dispatch("click");
  assert.equal(t.hash(), "probe:w70.2");
  assert.match(t.byClass("vs-readout").textContent, /DRIVER implies ACKNOWLEDGE/);
  t.byId("val").value = "nope";
  t.btn("Write").dispatch("click");
  assert.match(t.byClass("vs-msg").textContent, /Not applied/);
  assert.equal(t.btn("Device changes its config").disabled, true, "the entropy device has no config to change");
  t.btn("Device changes its config").dispatch("click");
  assert.equal(t.hash(), "probe:w70.2");
  t.byId("reg").value = "config";
  t.byId("reg").dispatch("change");
  t.byId("off").value = "0x10c";
  t.btn("Read").dispatch("click");
  assert.match(t.byClass("vs-warn").textContent, /outside the 0-byte config space/);
  const sel = t.byId("preset");
  sel.value = "linux";
  sel.dispatch("change");
  assert.equal(t.hash(), "linux~0");
  assert.match(t.root.textContent, /disk \(64 MiB image\)/);
});

test("shipped view code avoids innerHTML, eval and absolute URLs", () => {
  const src = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8")
    + readFileSync(fileURLToPath(new URL("./model.mjs", import.meta.url)), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /innerHTML|\beval\s*\(|new\s+Function|https?:\/\//);
});

test("one announcement per step, with the device's warning in it; no live region on the readout", async () => {
  const t = await setup("skip-features~8");
  const readout = t.byClass("vs-readout");
  assert.equal(readout.attrs["aria-live"], undefined);
  t.said.length = 0;
  t.btn("Step").dispatch("click");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(t.said.length, 1);
  assert.match(t.said[0], /macvmm logs a warning: virtio-mmio: Status 7 after 3 ignored/);
  t.handle.destroy();
});

test("focus moves off a button that disables itself", async () => {
  const t = await setup();
  const run = t.btn("Run to end");
  run.focus();
  run.dispatch("click");
  assert.equal(document.activeElement, t.btn("Back"));
  const back = t.btn("Back");
  t.btn("Restart scenario").dispatch("click");
  t.btn("Step").dispatch("click");
  back.focus();
  back.dispatch("click");
  assert.equal(document.activeElement, t.btn("Step"));
  t.handle.destroy();
});

test("first screen: Status reads (reset), the ladder marks the current step, bit headers carry names", async () => {
  const t = await setup();
  assert.match(t.byClass("vs-readout").textContent, /Status 0x0 \(reset\),/);
  const rungs = t.root.findAll((e) => e.classList.contains("vs-rung"));
  assert.equal(rungs.filter((r) => r.attrs["aria-current"] === "step").length, 1);
  assert.match(rungs[2].textContent, /^not yet/);
  assert.ok(t.root.findAll((e) => e.attrs.title !== undefined).length === 0, "no meaning hides in a title tooltip");
  assert.match(t.root.findAll((e) => e.tagName === "TABLE" && e.classList.contains("vs-bits"))[0].textContent, /3FEAT OK FEATURES_OK/);
});

test("predicting a refusal at a DRIVER_OK that latches then refuses the ring explains both", async () => {
  const t = await setup("outside-ram~24");
  t.byId("guess").value = "ignores";
  t.byId("guess").dispatch("change");
  t.btn("Step").dispatch("click");
  assert.match(t.byClass("vs-score").textContent, /It took the write \(DRIVER_OK is set\), then refused the ring: DEVICE_NEEDS_RESET/);
  t.handle.destroy();
});
