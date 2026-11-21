// Smoke test for the elf-inspector view with a tiny fake DOM (no dependencies): mount, change the file
// through each input path, and check the share hash and the static rules from LABS.md section 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
    this.checked = false;
    this.value = "";
    this.tabIndex = 0;
    this.type = "";
    this.name = "";
    const cls = new Set();
    this._cls = cls;
    this.classList = {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)),
      contains: (c) => cls.has(c),
    };
  }
  set className(v) {
    this._cls.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._cls.add(c);
  }
  get className() {
    return [...this._cls].join(" ");
  }
  get dataset() {
    const d = {};
    for (const [k, v] of Object.entries(this.attrs)) if (k.startsWith("data-")) d[k.slice(5)] = v;
    return d;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "id") this.id = v;
    if (k === "value") this.value = v;
    if (k === "type") this.type = v;
    if (k === "name") this.name = v;
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

/** Dispatch an event at `target`, bubbling to every ancestor's listeners. */
async function fire(target, type, extra = {}) {
  let prevented = false;
  const ev = { type, target, key: extra.key, preventDefault: () => (prevented = true) };
  for (let n = target; n; n = n.parent) for (const fn of n.listeners[type] || []) await fn(ev);
  return prevented;
}

globalThis.Element = FakeNode;
globalThis.HTMLInputElement = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createTextNode: (t) => new FakeText(t),
  activeElement: null,
};

FakeNode.prototype.querySelector = function (sel) {
  const m = /^\[data-key="([^"]*)"\]$/.exec(sel);
  return m ? this.find((n) => n.attrs["data-key"] === m[1]) : null;
};

const { mount } = await import("./view.mjs");
const { buildSample } = await import("./model.mjs");

function setup(initialHash = null) {
  let hash = initialHash;
  const spoken = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "elf-inspector",
    id: "lab-elf-inspector-1",
    base: "",
    standalone: false,
    reducedMotion: true,
    announce: (t) => spoken.push(t),
    hash: { get: () => hash, set: (v) => (hash = v) },
  };
  const handle = mount(el, ctx);
  const q = (pred) => el.find(pred);
  const byId = (id) => q((n) => n.id === `lab-elf-inspector-1-${id}`);
  const button = (text) => q((n) => n.tagName === "BUTTON" && n.textContent === text);
  const summary = () => byId("summary").textContent;
  return { el, ctx, q, byId, button, summary, spoken, handle, hash: () => hash };
}

test("mount shows the primer's hello loading, with its three sizes, and announces nothing", () => {
  const { summary, hash, spoken, el } = setup();
  assert.match(summary(), /^Loads: 3 segments placed in guest RAM, entry 0x4008_0000\. Every check passes\./);
  assert.match(summary(), /File 844,736 bytes, flat binary 11,610 bytes, 535,936 bytes of guest RAM\./);
  assert.equal(hash(), null);
  assert.deepEqual(spoken, []);
  assert.match(el.textContent, /elf {5}0x40080000\.\.0x400829f0 {2}ELF segment 0 \(10736 bytes\)/);
  assert.match(el.textContent, /section table is zeros/);
  // No invented exit status for an accepted file: the loader stops at the entry point.
  assert.match(el.textContent, /\(loader: accepted; the vCPU would start at 0x4008_0000\. What the guest then does is not modelled\.\)/);
  assert.doesNotMatch(el.textContent, /exit: 0/);
});

test("the unchanged chapter 13 sample at 64 MiB quotes 13-hello-elf.txt, and only then", async () => {
  const s = setup("ch13");
  assert.match(s.el.textContent, /chapter 13's capture\)\$ macvmm run --mem 64M --kernel hello --timeout 10\nexit: 0\nhello from guest, x0=0x40000000\nguest done/);
  const ram = s.byId("ram");
  ram.value = "128";
  await fire(ram, "change");
  assert.doesNotMatch(s.el.textContent, /exit: 0|hello from guest/);
});

test("the reference hash ch13~38:ffff shows chapter 13's refusal and highlights e_phnum", () => {
  const { summary, el, byId } = setup("ch13~38:ffff");
  assert.match(summary(), /^Refused at check "The program-header table fits": ELF has 65535 program headers \(at most 64\)\./);
  // 13-elf-phnum.txt's order: the exit status, then the stderr line.
  assert.match(el.textContent, /exit: 2\nmacvmm: cannot load the guest: ELF has 65535 program headers \(at most 64\)/);
  assert.match(el.textContent, /Dashed outline: the 2 bytes at 0x38/);
  assert.equal(byId("off").value, "38");
  assert.equal(byId("val").value, "ff ff");
  const errBytes = el.findAll((n) => n._cls.has("eli__byte--err"));
  assert.deepEqual(errBytes.map((n) => n.textContent), ["ff", "ff"]);
  assert.ok(errBytes.every((n) => n._cls.has("eli__byte--patched")));
});

test("a typed patch is applied, shared, announced, and removable", async () => {
  const { byId, q, summary, hash, spoken, button } = setup();
  byId("off").value = "0x4";
  byId("val").value = "01";
  const form = q((n) => n.tagName === "FORM" && n._cls.has("eli__patch"));
  assert.equal(await fire(form, "submit"), true);
  assert.match(summary(), /unsupported ELF EI_CLASS 0x1/);
  assert.equal(hash(), "primer~4:01");
  assert.equal(spoken.length, 1);
  await fire(q((n) => n.attrs["data-key"] === "rm-0"), "click");
  assert.equal(hash(), null);
  assert.match(summary(), /^Loads/);
  byId("off").value = "zz";
  await fire(form, "submit");
  assert.equal(byId("off").attrs["aria-invalid"], "true");
  assert.match(byId("patch-err").textContent, /hex number/);
  assert.ok(button("Remove all patches").disabled);
});

test("presets: every one applies on the default sample", async () => {
  const { byId, button, summary } = setup();
  const sel = byId("preset");
  sel.value = "memsz";
  await fire(button("Apply"), "click");
  assert.match(summary(), /ELF segment 2 \(0x10000000000 bytes at 0x40082d60\) does not fit inside guest RAM/);
  sel.value = "noshdr";
  await fire(button("Apply"), "click");
  assert.match(summary(), /^Loads/);
});

test("selecting a header field fills the patch form and highlights its bytes", async () => {
  const { q, byId, el } = setup();
  const f = q((n) => n.attrs["data-key"] === "h-56");
  await fire(f, "click");
  assert.equal(byId("off").value, "38");
  assert.equal(byId("val").value, "04 00");
  assert.equal(q((n) => n.attrs["data-key"] === "h-56").attrs["aria-pressed"], "true");
  assert.match(el.textContent, /Selected: e_phnum, 2 bytes at 0x38: 04 00\./);
  const sel = el.findAll((n) => n._cls.has("eli__byte--sel"));
  assert.deepEqual(sel.map((n) => n.textContent), ["04", "00"]);
});

test("a program header row expands to its fields", async () => {
  const { q, el } = setup();
  await fire(q((n) => n.attrs["data-key"] === "p-2"), "click");
  assert.match(el.textContent, /Program header 2, bytes 0xb0 to 0xe7/);
  assert.match(el.textContent, /p_memsz/);
  assert.equal(q((n) => n.attrs["data-key"] === "p-2").attrs["aria-expanded"], "true");
});

test("switching sample and RAM size; garbage hashes fall back to the default", async () => {
  const s = setup();
  const sample = s.byId("sample");
  sample.value = "ch13";
  await fire(sample, "change");
  assert.equal(s.hash(), "ch13");
  assert.match(s.el.textContent, /ELF segment 0 \(10792 bytes\)/);
  assert.match(s.el.textContent, /Show all 14 section headers/);
  const ram = s.byId("ram");
  assert.deepEqual(ram.children.map((o) => o.attrs.value), ["64", "128", "256", "512", "1024"]);
  ram.value = "256";
  await fire(ram, "change");
  assert.equal(s.hash(), "ch13@256");
  assert.match(s.el.textContent, /ram {5}0x40000000\.\.0x50000000 {2}256 MiB/);
  assert.equal(setup("ch13@16").hash(), "ch13@16"); // a size macvmm refuses is not decoded: the default is shown
  assert.match(setup("ch13@16").el.textContent, /ram {5}0x40000000\.\.0x44000000 {2}64 MiB/);
  assert.match(setup("<img src=x>").summary(), /^Loads/);
  assert.match(setup("ch13~ffffffff:00").summary(), /^Loads.*844,736/);
});

test("an opened file is analysed locally and never put in the hash; oversized files are refused unread", async () => {
  const s = setup("ch13~38:ffff");
  const input = s.byId("file");
  const b = buildSample("ch13");
  input.files = [{ name: "<b>hello</b>", size: b.length, arrayBuffer: async () => b.buffer.slice(0) }];
  await fire(input, "change");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.hash(), null);
  assert.match(s.summary(), /^Loads.*851,880/);
  assert.match(s.el.textContent, /Your file: <b>hello<\/b>, 851,880 bytes/);
  let read = false;
  input.files = [{ name: "big", size: 17 * 1024 * 1024, arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) }];
  await fire(input, "change");
  assert.equal(read, false);
  assert.match(s.el.textContent, /at most 16 MiB\. Nothing was read\./);
});

test("reset returns to the default and clears the hash", async () => {
  const { button, hash, summary } = setup("ch13~4:01@128");
  assert.match(summary(), /^Refused/);
  await fire(button("Reset"), "click");
  assert.equal(hash(), null);
  assert.match(summary(), /^Loads.*844,736/);
});

test("ids are derived from ctx.id and labels point at real controls", () => {
  const { el } = setup();
  for (const n of el.findAll((x) => x.id)) assert.ok(n.id.startsWith("lab-elf-inspector-1"), n.id);
  for (const n of el.findAll((x) => x.attrs.for)) assert.ok(el.find((m) => m.id === n.attrs.for), `label for ${n.attrs.for}`);
});

test("shipped files obey the LABS.md static rules", () => {
  for (const f of readdirSync(here)) {
    if (f.endsWith(".test.mjs")) continue;
    assert.match(f, /\.(mjs|js|css|json|svg)$/, `${f}: allowed type`);
    if (f.endsWith(".svg")) {
      const svg = readFileSync(join(here, f), "utf8");
      assert.match(svg, /<title[ >]/);
      assert.match(svg, /<desc[ >]/);
      assert.ok(!/<script|\son\w+=|foreignObject|href=/.test(svg), `${f}: no scripts, handlers or references`);
      continue;
    }
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(join(here, f), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "fetch(", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
    assert.ok(!/"style"|style:/.test(src), `${f} sets inline styles`);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.split("}")) {
    if (!rule.includes("{")) continue;
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="elf-inspector"]'), `unscoped selector: ${p}`);
    }
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(rule), "no hard-coded colors");
  }
  const json = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(json.title, "ELF inspector");
  assert.ok(json.goal.length > 0);
});

test("hex paging keeps focus on the buttons; the typed offset survives; a disabled button hands focus over", async () => {
  const { button, byId } = setup();
  const next = button("Next 256 bytes");
  const prev = button("Previous 256 bytes");
  next.focus();
  await fire(next, "click");
  assert.equal(globalThis.document.activeElement, next);
  assert.equal(button("Next 256 bytes"), next); // the same element, not a rebuilt one
  // Jump to one page before the end (the file is 0xce3c0 bytes), then press Next onto the last page.
  byId("go").value = "ce2b0";
  await fire(byId("go").parent, "submit");
  assert.equal(byId("go").value, "ce2b0");
  assert.equal(next.disabled, false);
  next.focus();
  await fire(next, "click");
  assert.ok(next.disabled);
  assert.equal(globalThis.document.activeElement, prev);
});


test("removing a patch moves focus to the next Remove button, then to the offset field, and says so", async () => {
  const { byId, q, spoken } = setup();
  const form = q((n) => n.tagName === "FORM" && n._cls.has("eli__patch"));
  for (const [o, v] of [["60", "00"], ["61", "00"]]) {
    byId("off").value = o;
    byId("val").value = v;
    await fire(form, "submit");
  }
  const rm = (i) => q((n) => n.attrs["data-key"] === `rm-${i}`);
  rm(1).focus();
  await fire(rm(1), "click");
  assert.equal(globalThis.document.activeElement, rm(0));
  await new Promise((r) => setTimeout(r, 350)); // announcements are throttled; the last one wins
  assert.match(spoken.at(-1), /^Patch removed\. Loads/);
  await fire(rm(0), "click");
  assert.equal(globalThis.document.activeElement, byId("off"));
});

test("field selection is announced; patch errors mark only the field that is wrong", async () => {
  const { q, byId, spoken, button } = setup();
  await new Promise((r) => setTimeout(r, 350));
  await fire(q((n) => n.attrs["data-key"] === "h-56"), "click");
  assert.equal(spoken.at(-1), "e_phnum, 2 bytes at 0x38: 04 00");
  const form = q((n) => n.tagName === "FORM" && n._cls.has("eli__patch"));
  byId("off").value = "38";
  byId("val").value = "zz";
  await fire(form, "submit");
  assert.equal(byId("val").attrs["aria-invalid"], "true");
  assert.equal(byId("off").attrs["aria-invalid"], undefined);
  assert.equal(byId("off").attrs["aria-describedby"], "lab-elf-inspector-1-patch-err");
  await fire(button("Reset"), "click");
  assert.equal(byId("val").attrs["aria-invalid"], undefined);
});

test("Apply: asks for a preset, then shows the prediction next to what happened", async () => {
  const { byId, button, spoken } = setup();
  await fire(button("Apply"), "click");
  assert.equal(byId("patch-err").textContent, "Choose a preset first.");
  byId("preset").value = "phnum";
  byId("predict").value = "segments";
  await new Promise((r) => setTimeout(r, 350));
  await fire(button("Apply"), "click");
  assert.equal(byId("patch-err").textContent, "");
  assert.match(spoken.at(-1), /^You predicted: Every PT_LOAD segment is sane\. What happened: caught by "The program-header table fits"\. Refused/);
});

test("the ordering note appears only when an identification check fails; flags have words for screen readers", async () => {
  const s = setup();
  assert.doesNotMatch(s.el.textContent, /lists the length check first/);
  assert.ok(s.q((n) => n._cls.has("eli__sr") && n.textContent === "read, execute"));
  const t = setup("primer~4:01");
  assert.match(t.el.textContent, /the elf primer lists the length check first/);
  assert.match(t.el.textContent, /Not decoded: a 32-bit ELF file/);
  assert.doesNotMatch(t.el.textContent, /primer check \d/);
});
