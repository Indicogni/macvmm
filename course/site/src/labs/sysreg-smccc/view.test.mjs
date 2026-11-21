// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only). It checks that mount()
// renders both halves, that typing, the field builder, the bit grid, presets and Reset drive the
// model, that the share hash is written and read back, that bad input shows an error instead of
// changing state, and that the view never uses innerHTML or inline styles.
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
    this.dataset = {};
    this.parent = null;
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(" ").filter(Boolean));
        if (on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(" ");
      },
      contains: (c) => self.className.split(" ").includes(c),
    };
  }
  get id() { return this.attrs.id; }
  setAttribute(k, v) {
    if (k === "style") throw new Error("inline style attributes are not allowed");
    this.attrs[k] = String(v);
    if (k === "hidden") this.hidden = true;
    if (k === "value") this.value = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v);
  }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === "string" ? { textContent: k } : k;
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  closest(sel) {
    const cls = sel.replace(/^\./, "");
    for (let n = this; n; n = n.parent) if (n.classList && n.classList.contains(cls)) return n;
    return null;
  }
  focus() { globalThis.document.activeElement = this; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

// Fire an event on `target`, bubbling to every ancestor's listeners.
function fire(target, type, extra = {}) {
  const ev = { type, target, preventDefault() {}, ...extra };
  for (let n = target; n; n = n.parent) for (const fn of n.listeners?.[type] || []) fn(ev);
}

function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t), createTextNode: (s) => ({ textContent: s }), activeElement: null };
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
  globalThis.location = { href: "x" };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "sysreg-smccc", id: "lab-sysreg-smccc-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const byId = (root, suffix) => root.findAll((e) => e.attrs.id === `lab-sysreg-smccc-1-${suffix}`)[0];
const summary = (root) => byId(root, "summary").textContent;
const button = (root, text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
const type = (input, value) => { input.value = value; fire(input, "input"); fire(input, "change"); };

test("mount renders the SMCCC half with SYSTEM_OFF and the reference hash", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.match(summary(root), /^0x8400_0008: fast call, 32-bit convention, owner 4 \(Standard secure service calls\), function 0x8\. Name: PSCI_SYSTEM_OFF\./);
  assert.match(summary(root), /macvmm stops the VM: guest powered off\./);
  const bits = root.findAll((e) => e.classList.contains("ss__bit"));
  assert.equal(bits.length, 32);
  assert.equal(bits.filter((b) => b.attrs.tabindex === "0").length, 1, "one tab stop in the grid");
  assert.equal(byId(root, "x0").value, "0x84000008");
  api.destroy();
});

test("typing an ID, building one from fields and flipping bits all agree", async () => {
  const { ctx, hash, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  type(byId(root, "x0"), "0xC600_4D01");
  assert.match(summary(root), /Name: DEBUG_PUTC/);
  assert.equal(hash(), "s_ad53b9c00_c6004d01");
  assert.ok(said.length >= 1);
  // Builder: clear the 64-bit bit, the ID becomes 0x8600_4D01.
  const wide = byId(root, "wide");
  wide.checked = false;
  fire(wide, "change");
  assert.equal(hash(), "s_ad53b9c00_86004d01");
  // Grid: flip bit 30 back.
  const b30 = root.findAll((e) => e.dataset.bit === "30")[0];
  fire(b30, "click");
  assert.equal(hash(), "s_ad53b9c00_c6004d01");
  assert.equal(b30.attrs["aria-pressed"], "true");
  assert.equal(b30.attrs.tabindex, "0", "the clicked bit becomes the tab stop");
  // Arrow keys move the roving tab stop.
  const toolbar = root.findAll((e) => e.attrs.role === "toolbar")[0];
  fire(toolbar, "keydown", { key: "ArrowRight" });
  assert.equal(root.findAll((e) => e.dataset.bit === "29")[0].attrs.tabindex, "0");
  // A bad value shows an error and changes nothing.
  type(byId(root, "x0"), "0xZZ");
  assert.equal(byId(root, "x0-err").hidden, false);
  assert.equal(byId(root, "x0").attrs["aria-invalid"], "true");
  assert.equal(hash(), "s_ad53b9c00_c6004d01");
});

test("presets, conduit and the macvmm warning line", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const preset = byId(root, "call-preset");
  preset.value = "sip";
  fire(preset, "change");
  assert.equal(hash(), "s_ad53b9c00_82000000");
  const pre = root.findAll((e) => e.tagName === "CODE").map((c) => c.textContent);
  assert.ok(pre.includes("macvmm: warn: [vcpu0] guest: unknown SMCCC function 0x82000000; returning -1"));
  const conduit = byId(root, "conduit");
  conduit.value = "smc";
  fire(conduit, "change");
  assert.equal(hash(), "s_ad53b9c00_82000000_smc");
  assert.ok(root.textContent.includes("macvmm adds 4"));
});

test("the sysreg half: decode a syndrome, edit fields, look up a name", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const radio = byId(root, "half-sysreg");
  radio.checked = true;
  fire(radio, "change");
  assert.match(summary(root), /^0xD53B_9C00 \(instruction\): mrs x0, PMCR_EL0\./);
  type(byId(root, "word"), "0x62280520");
  assert.match(summary(root), /\(syndrome\): msr OSLAR_EL1, x9\. Coordinates \(2, 0, 1, 0, 4\)/);
  assert.equal(hash(), "r_a62280520_84000008");
  // Edit Rt: the word stays a syndrome.
  type(byId(root, "rt"), "3");
  assert.equal(hash(), "r_a62280460_84000008");
  // Look a register up by name.
  type(byId(root, "name"), "LORID_EL1");
  assert.match(summary(root), /LORID_EL1/);
  type(byId(root, "name"), "NOT_A_REG");
  assert.equal(byId(root, "name-err").hidden, false);
  // Not a register move.
  type(byId(root, "word"), "0xd4000002");
  assert.match(summary(root), /hvc #0x0/);
});

test("a shared hash reopens the state; a hostile hash is ignored; Reset clears it", async () => {
  const { mount } = await import("./view.mjs");
  {
    const { ctx } = setup("r_e62280520_84000009_smc_i4d56_os_ac4000003");
    const root = new FakeEl("div");
    mount(root, ctx);
    assert.match(summary(root), /msr OSLAR_EL1, x9/);
    assert.equal(byId(root, "imm").value, "0x4d56");
  }
  {
    const { ctx, hash, said } = setup("<script>alert(1)</script>");
    const root = new FakeEl("div");
    mount(root, ctx);
    assert.match(summary(root), /PSCI_SYSTEM_OFF/);
    fire(button(root, "Reset"), "click");
    assert.equal(hash(), null);
    assert.match(said.at(-1), /^Reset\./);
  }
});

test("one spoken channel: no live regions or alerts inside the lab; typing is quiet", async () => {
  const { ctx, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  assert.equal(root.findAll((e) => e.attrs["aria-live"] || e.attrs.role === "alert").length, 0);
  const x0 = byId(root, "x0");
  const before = said.length;
  for (const v of ["0", "0x", "0x8", "0x84", "0x840000", "0x84000008"]) { x0.value = v; fire(x0, "input"); }
  assert.equal(said.length, before, "input events never speak");
  x0.value = "0x"; fire(x0, "input");
  assert.equal(byId(root, "x0-err").hidden, true, "a bare 0x is unfinished, not an error");
  assert.equal(x0.attrs["aria-invalid"], undefined);
  x0.value = "0xZZ"; fire(x0, "input");
  assert.equal(x0.attrs["aria-invalid"], "true");
  assert.equal(said.length, before, "a bad value while typing is marked, not spoken");
  fire(x0, "change");
  assert.match(said.at(-1), /hex digits/, "a bad committed value is spoken once");
});

test("the Example select keeps the loaded example until a field changes", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const preset = byId(root, "call-preset");
  preset.value = "aff64";
  fire(preset, "change");
  assert.equal(preset.value, "aff64");
  const b0 = root.findAll((e) => e.dataset.bit === "0")[0];
  fire(b0, "click");
  assert.equal(preset.value, "");
});

test("the sysreg editor: disabled for a non-register word, errors tied to the offending box", async () => {
  const { ctx } = setup("r_ad53b9c00_84000008");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx);
  const coords = root.findAll((e) => e.classList.contains("ss__coords"))[0];
  assert.equal(coords.disabled, false);
  const sp = byId(root, "sys-preset");
  sp.value = "isb";
  fire(sp, "change");
  assert.equal(coords.disabled, true);
  assert.equal(byId(root, "name").value, "");
  sp.value = "pmcr";
  fire(sp, "change");
  assert.equal(coords.disabled, false);
  const crn = byId(root, "crn");
  assert.equal(crn.attrs["aria-describedby"], "lab-sysreg-smccc-1-fields-err");
  type(crn, "16");
  assert.equal(crn.attrs["aria-invalid"], "true");
  assert.equal(byId(root, "fields-err").hidden, false);
  type(crn, "9");
  assert.equal(crn.attrs["aria-invalid"], undefined);
  // TTBR0_EL1 never reaches macvmm: no warning line, the policy is shown as hypothetical.
  type(byId(root, "name"), "TTBR0_EL1");
  assert.ok(!root.findAll((e) => e.tagName === "CODE").some((c) => /injecting UNDEF/.test(c.textContent)));
  assert.match(root.textContent, /would do \(it never gets the chance\)/);
  assert.match(summary(root), /never reaches macvmm/);
});

test("view.mjs uses no innerHTML, eval, inline styles or remote URLs", () => {
  const src = readFileSync(fileURLToPath(new URL("./view.mjs", import.meta.url)), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["innerHTML", "eval(", "new Function", "http://", "https://", "style:", ".style", "localStorage"]) {
    assert.ok(!code.includes(bad), bad);
  }
  assert.match(src, /export function mount/);
  const model = readFileSync(fileURLToPath(new URL("./model.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const bad of ["innerHTML", "eval(", "new Function", "http://", "https://", "document", "window"]) assert.ok(!model.includes(bad), bad);
});
