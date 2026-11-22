// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that the share hash is read and written, that the byte-change form and a
// dropped file drive the model, and that nothing is ever parsed as HTML. It also scans the
// shipped files for what LABS.md section 7 forbids.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { REFERENCE, presetBytes, newcEntry, concat } from "./model.mjs";

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
      add(c) { this.toggle(c, true); },
      remove(c) { this.toggle(c, false); },
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
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { globalThis.__focused = this; }
  scrollIntoView(opts) { globalThis.__scrolled = opts; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  async dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) await fn({ type: t, preventDefault() {}, ...ev }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  set outerHTML(_) { throw new Error("outerHTML must not be used"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

async function setup(hash = null) {
  globalThis.__focused = null;
  globalThis.document = { createElement: (t) => new FakeEl(t), get activeElement() { return globalThis.__focused; } };
  globalThis.window = { location: { href: "x" } };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "cpio-inspector", id: "lab-cpio-inspector-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const find = (pred) => root.findAll(pred)[0];
  const btn = (text) => find((e) => e.tagName === "BUTTON" && e.textContent === text);
  const byId = (suffix) => find((e) => e.attrs.id === `lab-cpio-inspector-1-${suffix}`);
  const readout = () => find((e) => e.className === "ci-readout").textContent;
  return { root, handle, ctx, said, btn, byId, readout, find, hash: () => stored };
}

const visibleText = (el) => (el.hidden ? "" : el._text + (el.children || []).map((c) => (c instanceof FakeEl ? visibleText(c) : c.textContent)).join(""));

test("mounts on the default sample, asks first, and says nothing until the reader acts", async () => {
  const s = await setup();
  assert.equal(s.hash(), null);
  assert.equal(s.readout(), "1,024 bytes. The kernel's answer is hidden until you press Reveal.", "nothing the kernel worked out, not even the member count");
  const shown = visibleText(s.root);
  assert.match(shown, /Which init does the kernel pick/);
  assert.doesNotMatch(shown, /Run \/init as init process/);
  assert.match(shown, /-rwxr-xr-x {3}1 root {5}wheel {10}21 /, "the host tool's view is the setup, so it stays visible");
  assert.match(shown, /Try this/);
  assert.equal(s.said.length, 0, "no announcement at mount");
  await s.btn("Reveal").dispatch("click");
  assert.match(s.readout(), /\/init comes from member 2, entry 1/);
  assert.equal(globalThis.__focused.className, "ci-readout");
  const after = visibleText(s.root);
  assert.match(after, /c_namesize/);
  assert.match(after, /Run \/init as init process/);
  assert.match(after, /asks for \/bin\/sh, which is not in this rootfs/);
  assert.match(after, /overlay sample shows the real case/);
  assert.equal(s.said.length, 0, "focus on the readout reads it; announcing it too would say it twice");
  assert.match(after, /2 entries \(plus 2 TRAILER!!! markers\)/);
  assert.equal(typeof s.handle.destroy, "function");
});

test("the readout is not a second live region; scroll boxes are named and focusable", async () => {
  const s = await setup();
  assert.equal(s.find((e) => e.className === "ci-readout").attrs["aria-live"], undefined);
  const boxes = s.root.findAll((e) => e.className === "ci-scroll");
  assert.ok(boxes.length >= 4);
  for (const b of boxes) {
    assert.equal(b.attrs.tabindex, "0");
    assert.equal(b.attrs.role, "region");
    assert.match(b.attrs["aria-label"], /scrolls sideways/);
  }
  const dump = s.find((e) => (e.className || "").includes("ci-scroll--dump"));
  assert.equal(dump.attrs.tabindex, "0", "a keyboard can scroll the dump");
  assert.match(dump.attrs["aria-label"], /Hex dump \(visual; the table above has the same facts\)/);
  assert.equal(dump.children[0].attrs["aria-hidden"], "true", "the dump itself is skipped by screen readers");
  const zone = s.find((e) => e.className === "dz-zone");
  const kids = zone.children.map((c) => c.className);
  assert.ok(kids.indexOf("dz-input") < kids.indexOf("dz-choose"), "the file input comes before its label");
});

test("ids are derived from ctx.id, and every input has a label", async () => {
  const s = await setup();
  const ids = s.root.findAll((e) => e.attrs.id).map((e) => e.attrs.id);
  assert.ok(ids.every((x) => x.startsWith("lab-cpio-inspector-1")), ids.join(","));
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const input of s.root.findAll((e) => e.tagName === "INPUT" || e.tagName === "SELECT")) {
    const label = s.root.findAll((e) => e.tagName === "LABEL" && e.attrs.for === input.attrs.id);
    assert.equal(label.length, 1, `label for ${input.attrs.id}`);
  }
});

test("selecting an entry writes the share state; the reference reads back", async () => {
  const s = await setup();
  const [first, second] = s.root.findAll((e) => e.tagName === "BUTTON" && e.textContent === "init");
  await second.dispatch("click");
  assert.equal(s.hash(), REFERENCE);
  // Updated in place: the same button is still in the table, now current.
  const again = s.root.findAll((e) => e.tagName === "BUTTON" && e.textContent === "init");
  assert.equal(again[1], second);
  assert.equal(second.attrs["aria-current"], "true");
  assert.equal(first.attrs["aria-current"], undefined);
  assert.equal(s.root.findAll((e) => e.attrs["aria-pressed"] !== undefined).length, 0);
  // Buttons far from the detail move focus to its heading.
  await s.btn("Show its first entry").dispatch("click");
  assert.equal(globalThis.__focused.attrs.id, "lab-cpio-inspector-1-detail");
  assert.equal(globalThis.__scrolled.behavior, "auto", "reduced motion: no smooth scroll");
  const t = await setup(REFERENCE);
  const pressed = t.root.findAll((e) => e.tagName === "BUTTON" && e.attrs["aria-current"] === "true");
  assert.equal(pressed.length, 1);
  assert.match(t.root.textContent, /Member 2, entry 1: init, file, 22 bytes\. Replaces \/init from member 1, entry 1\./);
});

test("the byte form breaks a copy: byte 5 = '8' gives no cpio magic", async () => {
  const s = await setup();
  s.byId("off").value = "5";
  s.byId("byte").value = "'8'";
  const form = s.find((e) => e.tagName === "FORM");
  assert.equal(s.btn("Change byte").attrs.type, "submit", "Enter in either box applies the change");
  await form.dispatch("submit");
  assert.match(s.readout(), /Unpacking stops with "no cpio magic"/);
  assert.match(s.root.textContent, /Initramfs unpacking failed: no cpio magic/);
  assert.equal(s.hash(), "both~5=38@1.1");
  await s.btn("Undo changes").dispatch("click");
  assert.equal(s.hash(), null);
  s.byId("off").value = "99999";
  await form.dispatch("submit");
  assert.match(s.byId("msg").textContent, /The offset must be a number from 0 to 1023/);
  assert.equal(s.byId("off").attrs["aria-invalid"], "true");
  assert.equal(s.byId("off").attrs["aria-describedby"], "lab-cpio-inspector-1-msg");
  s.byId("off").value = "5";
  await form.dispatch("submit");
  assert.equal(s.byId("off").attrs["aria-invalid"], undefined);
  assert.equal(s.byId("msg").textContent, "");
});

test("switching samples and Reset", async () => {
  const s = await setup();
  const sel = s.byId("preset");
  sel.value = "overlay";
  await sel.dispatch("change");
  assert.match(s.readout(), /2 members \(gzip; raw newc\)/);
  assert.equal(s.hash(), "overlay@1.1");
  await s.btn("Reset").dispatch("click");
  assert.equal(s.hash(), null);
});

test("a dropped file is analysed locally and never put in the hash", async () => {
  const s = await setup("tiny");
  const input = s.byId("file");
  const bytes = presetBytes("overlay");
  input.files = [{ name: "<b>initramfs</b>.img", size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) }];
  await input.dispatch("change");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(s.readout(), /2 members \(gzip; raw newc\)/);
  assert.equal(s.hash(), null);
  assert.ok(s.root.textContent.includes("<b>initramfs</b>.img"), "the name is shown as text");
  const big = { name: "huge", size: 64 * 1024 * 1024, arrayBuffer: async () => { throw new Error("must not be read"); } };
  input.files = [big];
  await input.dispatch("change");
  assert.match(s.root.textContent, /the lab reads at most/);
});

test("an ELF file points at the elf-inspector lab", async () => {
  const s = await setup();
  const input = s.byId("file");
  const elf = new TextEncoder().encode("\x7fELF\x02\x01\x01 not really");
  input.files = [{ name: "hello", size: elf.length, arrayBuffer: async () => elf.buffer.slice(0) }];
  await input.dispatch("change");
  await new Promise((r) => setTimeout(r, 0));
  const link = s.find((e) => e.tagName === "A" && e.textContent === "elf-inspector");
  assert.ok(link);
  assert.equal(link.attrs.href, "/build-your-own/vmm/labs/elf-inspector/");
  assert.match(s.root.textContent, /invalid magic at start of compressed archive/);
});

test("shipped files avoid what LABS.md section 7 forbids", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f} is a shippable type`);
    if (!f.endsWith(".mjs")) continue;
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
    for (const bad of ["eval(", "new Function", "innerHTML", "outerHTML", "insertAdjacentHTML", "http://", "https://", "fetch(", "XMLHttpRequest", "WebAssembly", "localStorage"]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
  }
  const view = readFileSync(new URL("view.mjs", import.meta.url), "utf8");
  assert.match(view, /export function mount\(/);
});

test("Undo changes moves focus to the Offset box before it disables itself", async () => {
  const s = await setup("tiny");
  const form = s.find((e) => e.tagName === "FORM");
  await form.dispatch("submit");
  const undo = s.btn("Undo changes");
  assert.equal(undo.disabled, false);
  undo.focus();
  await undo.dispatch("click");
  assert.equal(undo.disabled, true);
  assert.equal(globalThis.__focused, s.byId("off"), "focus stays in the form, not on <body>");
});

test("the odc and bad samples are not called newc; trailer rows have no mode", async () => {
  const s = await setup("odc");
  assert.match(s.readout(), /1 member \(uncompressed, magic 070707, which is odc, not newc\)/);
  assert.doesNotMatch(visibleText(s.root), /raw newc/);
  const b = await setup("bad");
  assert.match(b.readout(), /magic 070708, not newc/);
  const t = await setup("tiny");
  const cells = t.root.findAll((e) => e.tagName === "TD" && e.attrs["data-label"] === "mode").map((e) => e.textContent);
  assert.deepEqual(cells, ["-rwxr-xr-x", "(none)"]);
});

// ---- Hostile files: the whole path from the file input to the drawn page ----

const gzip = (b) => new Uint8Array(zlib.gzipSync(Buffer.from(b)));
async function drop(s, bytes, name = "hostile.img") {
  const input = s.byId("file");
  input.files = [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }];
  const t = performance.now();
  await input.dispatch("change");
  await new Promise((r) => setTimeout(r, 0)); // the file is read asynchronously
  await new Promise((r) => setTimeout(r, 0)); // and a large one is analysed on the next turn
  return performance.now() - t;
}

test("100,000 empty gzip members: the page is drawn at once, with the member limit in words", async () => {
  const trailer = newcEntry({ name: "TRAILER!!!", nlink: 1 });
  const bytes = concat(gzip(trailer), ...Array(100_000).fill(gzip(new Uint8Array(0))));
  const s = await setup();
  const ms = await drop(s, bytes);
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
  assert.match(s.readout(), /More than 1,024 members \(archives and compressed streams, one after another\): the lab stops here\./);
  assert.match(s.root.textContent, /824 more parts of the buffer \(members and runs of zero bytes\) not listed: the list shows the first 200\./);
  assert.match(s.root.textContent, /Showing the first 32 of 1,024 members\./);
  assert.equal(s.root.findAll((e) => e.tagName === "CAPTION" && /^Member \d+ \(/.test(e.textContent)).length, 32);
  assert.match(s.root.textContent, /More than 1,024 gzip members: the lab does not follow a host tool that far\./);
});

test("a directory tree 2,000 deep: refused at level 65 with the depth limit in words", async () => {
  const parts = [];
  let p = "a";
  while (p.length + 2 < 4080) { parts.push(newcEntry({ name: p, mode: 0o040755 })); p += "/a"; }
  for (let i = 0; i < 2000; i++) parts.push(newcEntry({ name: `${p}/f`, mode: 0o100644 }));
  const bytes = gzip(concat(...parts, newcEntry({ name: "TRAILER!!!", nlink: 1 })));
  assert.ok(bytes.length < 300 * 1024, `${bytes.length} bytes`);
  const s = await setup();
  const ms = await drop(s, bytes);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  assert.match(s.readout(), /Member 1, entry 65: its path is more than 64 directories deep, deeper than this lab follows\. The lab stops here/);
  assert.match(s.root.textContent, /the lab stops here/);
  assert.match(s.root.textContent, /Incomplete: the lab could not follow the whole buffer\./);
});

test("an entry and a zero run, 20,000 times over: the strip and the tables stay small", async () => {
  const one = concat(newcEntry({ name: "f", mode: 0o100644 }), new Uint8Array(4));
  const bytes = concat(...Array(20_000).fill(one));
  const s = await setup();
  const ms = await drop(s, bytes);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
  const segs = s.root.findAll((e) => e.tagName === "LI" && /ci-seg/.test(e.className));
  assert.equal(segs.length, 200);
  assert.match(s.root.textContent, /19,801 more parts of the buffer/);
  assert.match(s.root.textContent, /Showing the first 400 of 20,000 entries in this member\./);
});
