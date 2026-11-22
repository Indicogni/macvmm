// Smoke test for the linker-map view on a minimal fake DOM (no browser, no dependencies).
// It checks that mount renders the primer's numbers, that the controls drive the model, that
// the share hash is read and written, and that the view never uses innerHTML.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.focused = false;
    this._text = "";
  }
  get firstChild() {
    return this.children[0] || null;
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  removeChild(n) {
    this.children.splice(this.children.indexOf(n), 1);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type, extra = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {}, ...extra });
  }
  focus() {
    this.focused = true;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(_v) {
    throw new Error("innerHTML must not be used");
  }
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof Node) yield* c.walk();
  }
}
class Text {
  constructor(t) {
    this.textContent = t;
  }
}

globalThis.document = {
  createElement: (t) => new Node(t),
  createTextNode: (t) => new Text(t),
};

const { mount } = await import("./view.mjs");

function setup(hash = null) {
  const el = new Node("div");
  const said = [];
  let h = hash;
  const ctx = {
    name: "linker-map",
    id: "lab-linker-map-1",
    base: "/assets/labs/linker-map/",
    standalone: false,
    reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => h, set: (v) => (h = v) },
  };
  const api = mount(el, ctx);
  const all = () => [...el.walk()];
  const byId = (s) => all().find((n) => n.attrs.id === `lab-linker-map-1-${s}`);
  const button = (label) => all().find((n) => n.tagName === "button" && (n.attrs["aria-label"] === label || n.textContent === label));
  const summary = () => all().find((n) => n.className === "lm__summary").textContent;
  const text = () => el.textContent;
  return { el, api, all, byId, button, summary, text, said, hash: () => h };
}

test("mounts with the primer's program: 68 bytes, _start first", () => {
  const v = setup();
  assert.match(v.summary(), /Flat binary 68 bytes from 0x4008_0000; 3 PT_LOAD headers; first byte is _start/);
  assert.match(v.text(), /0000000040084060 B __stack_top/);
  assert.match(v.text(), /16,416 \(more than FileSize\)/);
  assert.match(v.text(), /ff 43|ff/);
  assert.equal(v.hash(), null);
  v.api.destroy();
});

test("moving .rodata up breaks the entry and writes the hash", () => {
  const v = setup();
  const up = v.button("Move .rodata up");
  up.dispatch("click");
  assert.match(v.summary(), /first byte is GREETING/);
  assert.match(v.text(), /ldnp d8, d25/);
  assert.equal(v.hash(), "p:bare;o:r-t-d-b;s:40080000;k:4000;l:40080000");
  // Focus stays on the moved section's buttons (Up is now disabled, so Down gets it).
  assert.equal(v.button("Move .rodata down").focused, true);
  v.api.destroy();
});

test("the .far checkbox gives the 1,048,577-byte file", () => {
  const v = setup();
  const box = v.byId("far");
  box.checked = true;
  box.dispatch("change");
  assert.match(v.summary(), /Flat binary 1,048,577 bytes/);
  assert.match(v.text(), /bytes of zeros \(gap, written out as zeros\)/);
  v.api.destroy();
});

test("bad input shows an error and keeps the last good layout", () => {
  const v = setup();
  const start = v.byId("start");
  start.value = "0x40081000";
  start.dispatch("change");
  assert.match(v.text(), /multiple of 0x1_0000/);
  assert.equal(start.attrs["aria-invalid"], "true");
  assert.match(v.summary(), /68 bytes from 0x4008_0000/);
  v.api.destroy();
});

test("a share hash restores the guest preset; junk falls back", () => {
  const v = setup("p:guest");
  assert.match(v.summary(), /Flat binary 11,866 bytes/);
  assert.match(v.text(), /0000000040082e60 b hello::COUNTER \(\.0\)/);
  v.api.destroy();
  const w = setup("<img src=x>");
  assert.match(w.summary(), /68 bytes/);
  w.api.destroy();
});

test("one change gives exactly one announcement, and the readout is not a live region", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const v = setup();
    const live = v.all().filter((n) => n.attrs["aria-live"] || ["status", "alert"].includes(n.attrs.role));
    // Only the share note ("Link copied.") and the link-failure alert remain live.
    assert.deepEqual(live.map((n) => n.className).sort(), ["lm__fail", "lm__note"]);
    v.button("Move .rodata up").dispatch("click");
    mock.timers.tick(400);
    assert.equal(v.said.length, 1);
    assert.match(v.said[0], /^\.rodata moved to position 1 of 4, before \.text\. Flat binary 68 bytes/);
    v.api.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("an input error is announced once, with the reason", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const v = setup();
    const start = v.byId("start");
    start.value = "0x40080100";
    start.dispatch("change");
    mock.timers.tick(400);
    assert.equal(v.said.length, 1);
    assert.match(v.said[0], /^Start address not changed: Use a hex address that is a multiple of 0x1_0000 \(64 KiB\): /);
    assert.equal(v.byId("start-err").attrs.role, undefined);
    v.api.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("the guest preset starts with _start and has no warning about the first bytes", () => {
  const v = setup("p:guest");
  assert.match(v.summary(), /3 PT_LOAD headers; first byte is _start/);
  assert.match(v.text(), /Works: The first bytes are _start/);
  assert.doesNotMatch(v.text(), /Breaks:/);
  assert.match(v.text(), /EXTERN\(_start\)/);
  v.api.destroy();
});

test("drag and drop reorders", () => {
  const v = setup();
  const items = v.all().filter((n) => n.tagName === "li");
  const bss = items.find((n) => n.attrs["data-sec"] === "bss");
  const text = items.find((n) => n.attrs["data-sec"] === "text");
  bss.dispatch("dragstart", { dataTransfer: { setData() {} } });
  text.dispatch("drop");
  assert.match(v.hash(), /o:b-t-r-d/);
  v.api.destroy();
});

test("shipped lab code avoids forbidden constructs", () => {
  for (const f of ["view.mjs", "model.mjs"]) {
    const src = readFileSync(join(here, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /innerHTML\s*=|eval\(|new Function|https?:\/\//, f);
  }
  const css = readFileSync(join(here, "style.css"), "utf8");
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    const sel = rule.split("{")[0].trim();
    if (!sel || sel.startsWith("@media") || sel === "") continue;
    for (const s of sel.split(",")) {
      const t = s.replace(/^@media[^{]*/, "").trim();
      if (t) assert.ok(t.startsWith('.lab[data-lab="linker-map"]'), `unscoped selector: ${t}`);
    }
  }
  const svg = readFileSync(join(here, "fallback.svg"), "utf8");
  assert.match(svg, /<title/);
  assert.match(svg, /<desc/);
  assert.doesNotMatch(svg, /<script|on[a-z]+=|foreignObject|href=/);
});

test("a link naming an Object.prototype key as the preset mounts the default instead of throwing", () => {
  // `#linker-map=p:constructor`: PRESETS["constructor"] is truthy, so the old check let it through
  // and mount threw on `p.id`.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
    const v = setup(`p:${key}`);
    assert.match(v.summary(), /68 bytes/, key);
    v.api.destroy();
    const w = setup(`p:guest;o:${key}-${key}-${key}-${key}`);
    assert.match(w.summary(), /Flat binary 11,866 bytes/, key);
    w.api.destroy();
  }
});
