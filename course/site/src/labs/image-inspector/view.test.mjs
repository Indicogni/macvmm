// Smoke test for view.mjs with a tiny fake DOM (no dependencies): mount, load presets, edit a byte
// from the keyboard, read a "dropped" file through File.slice(), paste xxd rows, and check the share
// hash and the static rules from LABS.md sections 4, 5 and 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BASES, fromHex } from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));

class FakeText {
  constructor(t) {
    this.textContent = t;
  }
}
class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.tabIndex = 0;
    this.files = null;
    const cls = new Set();
    this._cls = cls;
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = v;
    if (k === "class") {
      this._cls.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) this._cls.add(c);
    }
    if (k === "tabindex") this.tabIndex = Number(v);
  }
  getAttribute(k) {
    return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  append(...kids) {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeText(k) : k;
      if (n instanceof FakeNode) n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  contains(n) {
    for (let p = n; p; p = p.parent) if (p === this) return true;
    return false;
  }
  closest(sel) {
    const cls = sel.replace(/^\./, "");
    for (let p = this; p; p = p.parent) if (p._cls.has(cls)) return p;
    return null;
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  *walk() {
    yield this;
    for (const c of this.children) if (c instanceof FakeNode) yield* c.walk();
  }
  find(pred) {
    for (const n of this.walk()) if (pred(n)) return n;
    return null;
  }
  findAll(pred) {
    return [...this.walk()].filter(pred);
  }
}

async function fire(target, type, extra = {}) {
  let prevented = false;
  const ev = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, relatedTarget: null, ...extra, type, target, preventDefault: () => (prevented = true) };
  for (let n = target; n; n = n.parent) for (const fn of n.listeners[type] || []) await fn(ev);
  return prevented;
}

globalThis.Element = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (_ns, t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
  activeElement: null,
};

const { mount } = await import("./view.mjs");

function setup(initialHash = null) {
  let hash = initialHash;
  const spoken = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "image-inspector",
    id: "lab-image-inspector-1",
    base: "",
    standalone: false,
    reducedMotion: true,
    announce: (t) => spoken.push(t),
    hash: { get: () => hash, set: (v) => (hash = v) },
  };
  const handle = mount(el, ctx);
  const q = (pred) => el.find(pred);
  const cell = (off) => q((n) => n.tagName === "BUTTON" && n.attrs["data-off"] === String(off));
  const summary = () => q((n) => n.id === "lab-image-inspector-1-summary").textContent;
  const select = (id) => q((n) => n.id === `lab-image-inspector-1-${id}`);
  return { el, ctx, q, cell, summary, select, spoken, handle, hash: () => hash };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("mount shows Alpine with the dry-run lines and no hash", () => {
  const { summary, hash, spoken, el, cell } = setup();
  assert.match(summary(), /^arm64 Image: all 7 header checks pass\. Kernel at 0x40200000\.\.0x424a0000, initrd at 0x42600000/);
  assert.equal(hash(), null);
  assert.deepEqual(spoken, []);
  assert.match(el.textContent, /kernel  0x40200000\.\.0x424a0000  kernel \(arm64 Image\) \(36306944 bytes\)/);
  assert.match(el.textContent, /entry   pc=0x40200000 x0=0x40000000 cpsr=0x3c5/);
  assert.equal(cell(0x38).textContent, "41");
  assert.match(cell(0x38).attrs["aria-label"], /offset 0x38, magic: 41/);
  assert.equal(el.findAll((n) => n.attrs["data-off"] !== undefined && n.tabIndex === 0).length, 1, "one cell in the tab order");
});

test("Try: the Predict fork prints the captured message and sets the reference hash", async () => {
  const { select, summary, hash, el, spoken } = setup();
  const t = select("try");
  t.value = "huge";
  await fire(t, "change");
  assert.equal(hash(), "image.p10=ffffffffffffffff");
  assert.match(el.textContent, /macvmm: cannot load the guest: kernel \(arm64 Image\) \(0xffffffffffffffff bytes at 0x40200000\) does not fit inside guest RAM/);
  assert.match(el.textContent, /would be 0x401fffff, inside RAM/);
  assert.equal(spoken.length, 1);
  assert.match(summary(), /^All 7 header checks pass, but the kernel does not fit\. macvmm: cannot load the guest/);
});

test("typing two hex digits on a cell edits the byte; the first failing check moves", async () => {
  const { cell, hash, summary, el } = setup();
  const c = cell(0x18);
  c.focus();
  await fire(c, "click");
  assert.equal(await fire(c, "keydown", { key: "0" }), true);
  assert.equal(cell(0x18).textContent, "0_");
  await fire(c, "keydown", { key: "e" });
  assert.equal(hash(), "image.p18=0e");
  assert.match(summary(), /^First failing check: Page size Apple Silicon has/);
  assert.ok(cell(0x18)._cls.has("ii__cell--patched"));
  assert.match(cell(0x18).attrs["aria-label"], /edited, was 0a/);
  assert.match(el.textContent, /fails first: the loader stops here/);
  // Escape cancels a half-typed byte.
  await fire(c, "keydown", { key: "1" });
  await fire(c, "keydown", { key: "Escape" });
  assert.equal(cell(0x18).textContent, "0e");
});

test("arrow keys rove the grid by one byte and by a row", async () => {
  const { cell } = setup();
  const c0 = cell(0);
  c0.focus();
  await fire(c0, "keydown", { key: "ArrowRight" });
  assert.equal(globalThis.document.activeElement, cell(1));
  await fire(cell(1), "keydown", { key: "ArrowDown" });
  assert.equal(globalThis.document.activeElement, cell(17));
  assert.equal(cell(17).tabIndex, 0);
  assert.equal(cell(0).tabIndex, -1);
  await fire(cell(17), "keydown", { key: "End" });
  assert.equal(globalThis.document.activeElement, cell(31));
});

test("the zboot preset shows the refusal, the PE fields and the primer's file map", async () => {
  const { select, el, summary } = setup("zboot");
  assert.match(summary(), /^EFI zboot wrapper: macvmm refuses it by name/);
  const text = el.textContent;
  assert.match(text, /EFI zboot image; run scripts\/fetch\.sh linux \(unwraps it\) or pass the raw Image/);
  assert.match(text, /0xaa64 \(ARM64\)/);
  assert.match(text, /10 \(EFI application\)/);
  assert.match(text, /0x22a0000 = 36306944 bytes/);
  assert.match(text, /0xca78\.\.0x9ec5c3 gzip payload/);
  const t = select("try");
  t.value = "zbootpast";
  await fire(t, "change");
  assert.match(el.textContent, /Added in 32 bits, the sum wraps to 0x800/);
  assert.match(el.textContent, /unzboot: payload 0x1000\+0xfffff800 lies outside the 0x9ee200-byte file/);
});

test("a dropped file is read in small slices, never whole, and never enters the hash", async () => {
  const { q, el, hash, summary } = setup("image.p38=42");
  const zb = BASES.zboot;
  const known = zb.chunks.map(([off, hx]) => ({ off, bytes: fromHex(hx) }));
  const slices = [];
  const file = {
    name: "<b>vmlinuz-virt</b>",
    size: Number(zb.length),
    slice(a, b) {
      slices.push([a, b]);
      return {
        async arrayBuffer() {
          const out = new Uint8Array(Math.max(0, Math.min(b, Number(zb.length)) - a));
          for (const c of known) for (let i = 0; i < c.bytes.length; i++) if (c.off + i >= a && c.off + i < b) out[c.off + i - a] = c.bytes[i];
          return out.buffer;
        },
      };
    },
  };
  const drop = q((n) => n._cls.has("ii__drop"));
  await fire(drop, "drop", { dataTransfer: { files: [file] } });
  await tick();
  assert.equal(hash(), null);
  assert.deepEqual(slices, [
    [0, 4096],
    [0xca78, 0xca78 + 10],
    [0x9ec5bb, 0x9ec5bb + 8],
  ]);
  for (const [a, b] of slices) assert.ok(b - a <= 4096);
  assert.match(summary(), /^EFI zboot wrapper/);
  assert.match(el.textContent, /<b>vmlinuz-virt<\/b>/, "the name is shown as text");
  assert.match(el.textContent, /4114 were read/);
});

test("pasted xxd rows are parsed; bad paste shows a message", async () => {
  const { q, summary, el, hash } = setup();
  const area = q((n) => n.tagName === "TEXTAREA");
  const form = area.parent;
  area.value = "junk";
  await fire(form, "submit");
  assert.equal(area.attrs["aria-invalid"], "true");
  assert.match(el.textContent, /No xxd rows found/);
  area.value = readFileSync(join(here, "../../../../captures/13-image-header.txt"), "utf8");
  await fire(form, "submit");
  assert.equal(hash(), null);
  // 64 pasted bytes and no length: the last check (file against image_size) is not decided,
  // and the dry-run line prints file=? instead of a length nobody gave.
  assert.match(summary(), /^arm64 Image: 6 of 7 header checks pass; the last needs the file length/);
  assert.match(el.textContent, /The file is no longer than image_size \(not decided\)/);
  assert.match(el.textContent, /file=\? page_size=K4/);
  assert.doesNotMatch(el.textContent, /file=0x40 /);
  // Typing the real length (even one equal to the 64 pasted bytes) decides it.
  const len = q((n) => n.id === "lab-image-inspector-1-len");
  len.value = "36306944";
  await fire(len.parent.parent, "submit");
  assert.match(summary(), /^arm64 Image: all 7 header checks pass/);
  assert.match(el.textContent, /file=0x22a0000 page_size=K4/);
  len.value = "64";
  await fire(len.parent.parent, "submit");
  assert.match(summary(), /^arm64 Image: all 7 header checks pass/);
  assert.match(el.textContent, /file=0x40 page_size=K4/);
});

test("a wrong magic marks no Image check as failing first: the sniff stops the loader", async () => {
  const { select, el } = setup();
  const t = select("try");
  t.value = "badmagic";
  await fire(t, "change");
  const text = el.textContent;
  assert.match(text, /--initrd needs an arm64 Image --kernel/);
  assert.match(text, /ELF, zboot or Image magic present \(fails first: the loader stops here\)/);
  assert.match(text, /magic is ARM\\x64 at offset 0x38 \(not run; on its own it would fail\)/);
  assert.equal(text.match(/fails first: the loader stops here/g).length, 1, "exactly one step fails first");
  // The step box comes before the check list.
  assert.ok(text.indexOf("magic-number sniff") < text.indexOf("Image header checks"));
});

test("modifier shortcuts on a byte never edit it (Cmd+C, Ctrl+A, Alt+Left)", async () => {
  const { cell, hash } = setup();
  const c = cell(0x10);
  c.focus();
  await fire(c, "click");
  assert.equal(await fire(c, "keydown", { key: "c", metaKey: true }), false);
  assert.equal(await fire(c, "keydown", { key: "a", ctrlKey: true }), false);
  assert.equal(await fire(c, "keydown", { key: "ArrowLeft", altKey: true }), false);
  assert.equal(cell(0x10).textContent, "00");
  assert.equal(hash(), null);
  assert.equal(globalThis.document.activeElement, cell(0x10));
  // Shift (an upper-case hex letter) still types.
  await fire(c, "keydown", { key: "C", shiftKey: true });
  assert.equal(cell(0x10).textContent, "c_");
});

test("leaving the grid cancels a half-typed byte", async () => {
  const { cell, q, spoken } = setup();
  const c = cell(0x10);
  c.focus();
  await fire(c, "keydown", { key: "4" });
  assert.equal(cell(0x10).textContent, "4_");
  // Moving inside the grid is not leaving it.
  await fire(c, "focusout", { relatedTarget: cell(0x11) });
  assert.equal(cell(0x10).textContent, "4_");
  const reset = q((n) => n.tagName === "BUTTON" && n.textContent === "Reset");
  await fire(c, "focusout", { relatedTarget: reset });
  assert.equal(cell(0x10).textContent, "00");
  await new Promise((r) => setTimeout(r, 350)); // announcements are throttled to one per 300 ms
  assert.equal(spoken.at(-1), "Byte edit cancelled.");
  await fire(c, "keydown", { key: "1" });
  assert.equal(cell(0x10).textContent, "1_", "the next digit starts a new byte");
});

test("the selected byte is aria-current, not a toggle button", async () => {
  const { cell } = setup();
  assert.equal(cell(0).attrs["aria-current"], "true");
  assert.equal(cell(0).attrs["aria-pressed"], undefined);
  await fire(cell(5), "click");
  assert.equal(cell(5).attrs["aria-current"], "true");
  assert.equal(cell(0).attrs["aria-current"], undefined);
});

test("overflow explanation uses the real load address and says where the wrapped end lands", async () => {
  const { select, el } = setup();
  const fv = select("fieldval");
  select("field").value = "text_offset";
  fv.value = "0x1000";
  await fire(fv.parent.parent.parent, "submit");
  select("field").value = "image_size";
  fv.value = "0xffffffffffffffff";
  await fire(fv.parent.parent.parent, "submit");
  assert.match(el.textContent, /0x40201000 \+ 0xffffffffffffffff does not fit in 64 bits/);
  assert.match(el.textContent, /would be 0x40200fff, inside RAM/);
  select("field").value = "text_offset";
  fv.value = "0";
  await fire(fv.parent.parent.parent, "submit");
  select("field").value = "image_size";
  fv.value = "0xffffffffc0000000";
  await fire(fv.parent.parent.parent, "submit");
  assert.match(el.textContent, /0x40200000 \+ 0xffffffffc0000000 does not fit/);
  assert.match(el.textContent, /would be 0x200000, below ram_end/);
});

test("the BSS scenario draws the tempting wrong plan with the primer's numbers", async () => {
  const { select, el } = setup();
  const t = select("try");
  t.value = "bss";
  await fire(t, "change");
  const text = el.textContent;
  assert.match(text, /initrd  0x41a00000\.\.0x422fd8fc/);
  assert.match(text, /The tempting wrong plan/);
  assert.match(text, /starts at 0x41600000, the file's last byte, instead of 0x41a00000\. Its first 0x400000 bytes \(4 MiB\)/);
});

test("error messages survive grid navigation and clear on the next good change", async () => {
  const { select, cell, el } = setup();
  const fv = select("fieldval");
  fv.value = "nope";
  await fire(fv.parent.parent.parent, "submit");
  assert.equal(fv.attrs["aria-invalid"], "true");
  await fire(cell(0), "keydown", { key: "ArrowRight" });
  assert.match(el.textContent, /Type a value: decimal/);
  const t = select("try");
  t.value = "huge";
  await fire(t, "change");
  assert.equal(fv.attrs["aria-invalid"], undefined);
  assert.doesNotMatch(el.textContent, /Type a value: decimal/);
});

test("the standalone page points at chapter 13, the primers and the glossary", () => {
  const el = new FakeNode("div");
  mount(el, { name: "image-inspector", id: "lab-image-inspector-1", base: "", standalone: true, reducedMotion: true, announce: () => {}, hash: { get: () => null, set: () => {} } });
  assert.match(el.textContent, /Concepts you'll need: the Image header table in chapter 13/);
  const hrefs = el.findAll((n) => n.tagName === "A").map((n) => n.attrs.href);
  for (const p of ["linux/loaders/", "primers/arm64-boot-protocol/", "primers/efi-zboot/", "glossary/#image-size"]) {
    assert.ok(hrefs.some((h) => h.endsWith(p)), p);
  }
  assert.doesNotMatch(setup().el.textContent, /Concepts you'll need/, "embedded: the lesson has its own box");
});

test("scroll boxes without focusable content take focus themselves", () => {
  const { el } = setup();
  const pre = el.find((n) => n.tagName === "PRE");
  assert.equal(pre.attrs.tabindex, "0");
  assert.equal(pre.attrs.role, "region");
  assert.ok(pre.attrs["aria-label"]);
  const svgBox = el.find((n) => n.tagName === "SVG").parent;
  assert.equal(svgBox.attrs.tabindex, "0");
  assert.equal(svgBox.attrs.role, "region");
});

test("settings: RAM, initrd, file length, field writes; bad input is refused with a message", async () => {
  const { select, hash, el, q } = setup();
  const rd = select("rd");
  rd.value = "";
  await fire(rd.parent.parent, "submit");
  assert.equal(hash(), "image.i0");
  rd.value = "abc";
  await fire(rd.parent.parent, "submit");
  assert.equal(rd.attrs["aria-invalid"], "true");
  const ram = select("ram");
  ram.value = "1024";
  await fire(ram, "change");
  assert.equal(hash(), "image.m1024.i0");
  const len = select("len");
  len.value = "0x22a0001";
  await fire(len.parent.parent, "submit");
  assert.match(el.textContent, /is longer than its image_size 0x22a0000/);
  const fv = select("fieldval");
  fv.value = "0x80";
  select("field").value = "text_offset";
  await fire(fv.parent.parent.parent, "submit");
  assert.match(hash(), /^image\.p8=80\./);
  const reset = q((n) => n.tagName === "BUTTON" && n.textContent === "Reset");
  await fire(reset, "click");
  assert.equal(hash(), null);
});

test("garbage hashes fall back to Alpine", () => {
  assert.match(setup("<img src=x>").summary(), /^arm64 Image: all 7/);
  assert.match(setup("image.p40=00").summary(), /^arm64 Image: all 7/);
});

test("ids are derived from ctx.id and every label points at a control", () => {
  const { el } = setup();
  for (const n of el.findAll((x) => x.id)) assert.ok(n.id.startsWith("lab-image-inspector-1"), n.id);
  for (const n of el.findAll((x) => x.attrs.for)) assert.ok(el.find((m) => m.id === n.attrs.for), `label for ${n.attrs.for}`);
});

test("shipped files obey the LABS.md static rules", () => {
  for (const f of readdirSync(here)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed type`);
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch(", "localStorage", "WebAssembly", "XMLHttpRequest", "importScripts"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.ok(!/\.style\b|"style"|style:/.test(src), `${f} sets inline styles`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = css.replace(/@media[^{]*\{/g, "");
  for (const rule of body.split("}")) {
    if (!rule.includes("{")) continue;
    const sel = rule.slice(0, rule.lastIndexOf("{")).trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="image-inspector"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b|rgb\(|hsl\(/.test(rule), "no hard-coded colors");
  }
  const json = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(json.title, "Image inspector");
  assert.ok(json.goal.length > 0);
});
