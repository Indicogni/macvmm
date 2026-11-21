// Smoke test for view.mjs with a tiny fake DOM and a fetch that reads this lab's own files (no
// dependencies): mount, switch traces, keyboard, filters, a dropped file, the share hash, and
// the static rules of LABS.md sections 4, 5 and 7.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sanitizeSvg } from "../../../lib/svg.mjs";

const here = dirname(fileURLToPath(import.meta.url));

class FakeText { constructor(t) { this.textContent = String(t); } }
class FakeNode {
  constructor(tag, ns = null) {
    this.tagName = tag.toUpperCase();
    this.ns = ns;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.files = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); if (k === "value") this.value = String(v); if (k === "disabled") this.disabled = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? new FakeText(k) : k); }
  replaceChildren(...kids) { this.children = []; this._text = ""; this.append(...kids); }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  async fire(type, extra = {}) { for (const fn of this.listeners[type] || []) await fn({ type, preventDefault() {}, ...extra }); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeNode) yield* c.walk(); }
  find(pred) { for (const n of this.walk()) if (pred(n)) return n; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
  cls() { return (this.attrs.class || "").split(/\s+/); }
}

globalThis.document = {
  createElement: (t) => new FakeNode(t),
  createElementNS: (ns, t) => new FakeNode(t, ns),
  createTextNode: (t) => new FakeText(t),
};
globalThis.fetch = async (url) => {
  const p = fileURLToPath(url);
  return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(p, "utf8")) };
};

const { mount } = await import("./view.mjs");
const settle = () => new Promise((r) => setTimeout(r, 0));

async function setup(initialHash = null) {
  let hash = initialHash;
  const said = [];
  const el = new FakeNode("div");
  const ctx = {
    name: "boot-timeline", id: "lab-boot-timeline-1", base: new URL("./", import.meta.url).href,
    standalone: false, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => hash, set: (v) => { hash = v; } },
  };
  const pending = mount(el, ctx);
  // Nothing is in the page until the first render is done (so no live region speaks on load).
  assert.equal(el.children.length, 0);
  const api = await pending;
  const byId = (suffix) => el.find((n) => n.id === `lab-boot-timeline-1-${suffix}`);
  const byClass = (c) => el.find((n) => n.cls().includes(c));
  const button = (text) => el.find((n) => n.tagName === "BUTTON" && n.textContent === text);
  return { el, ctx, api, said, hash: () => hash, byId, byClass, button };
}

test("mounts on the healthy reference boot, with the lesson's numbers and no hash", async () => {
  const t = await setup();
  const readout = t.byClass("bt__readout");
  assert.match(readout.textContent, /^Healthy boot \(the reference\): 32,829 exits in 218\.69 ms\./);
  assert.match(readout.textContent, /12,093 console bytes, 2\.7 exits per byte/);
  assert.match(readout.textContent, /Last stage reached: 8, user space\./);
  assert.equal(readout.attrs["aria-live"], "polite");
  assert.deepEqual(t.said, [], "nothing is announced on load");
  assert.equal(t.hash(), null);
  assert.ok(t.el.findAll((n) => n.cls().includes("bt__bin")).length > 50, "density cells drawn");
  assert.equal(t.el.findAll((n) => n.cls().includes("bt__ev")).length, 44);
  assert.match(t.byClass("bt__try").textContent, /46 ms silence/);
  assert.match(t.byClass("bt__intro").textContent, /no GIC lane because the in-kernel interrupt controller/);
  assert.match(t.byClass("bt__prov").textContent, /Apple M5 Pro, macOS 27\.2\.1/);
  assert.match(t.byClass("bt__prov").textContent, /Your numbers will differ/);
  assert.match(t.byClass("bt__stats").textContent, /vcpu0 exits: vtimer 0, wfx 0, total 32829: hvc 16, sysreg 2, data abort 32811/);
  const labels = t.el.findAll((n) => n.cls().includes("bt__lanelabel")).map((n) => n.textContent);
  assert.deepEqual(labels, ["vCPU 0", "PL011 UART", "PL031 RTC", "Console lines"]);
  assert.ok(typeof t.api.destroy === "function");
});

test("switching to breakage 1 shows its fingerprint and a healthy-boot comparison column", async () => {
  const t = await setup();
  const sel = t.byId("trace");
  sel.value = "notimer";
  await sel.fire("change");
  await settle();
  assert.match(t.byClass("bt__readout").textContent, /Last stage reached: 4, time\./);
  assert.equal(t.hash(), "notimer");
  const fp = t.el.find((n) => n.tagName === "TABLE" && n.textContent.includes("Failure fingerprint")).textContent;
  assert.match(fp, /Unable to initialise architected timer/);
  assert.match(fp, /Recorded exit status5/);
  const heads = t.el.findAll((n) => n.tagName === "TH" && n.attrs.scope === "col").map((n) => n.textContent);
  assert.ok(heads.includes("Healthy boot"));
  assert.ok(t.el.find((n) => n.cls().includes("bt__squeeze")), "the 9.90 s silence is squeezed");
  assert.ok(!t.said.some((s) => /Breakage 1/.test(s)), "the summary has one channel: the readout's live region");
});

test("the reference link opens breakage 1's silence, selected", async () => {
  const t = await setup("notimer.e25");
  const d = t.byClass("bt__detail").textContent;
  assert.match(d, /No exit for 9\.90 s, then a canceled exit/);
  assert.match(d, /Followed by: a canceled exit \(the VMM stopped the run\)\. Silence that ends in a kick/);
  assert.match(d, /end Kernel panic - not syncing: Unable to initialise architected timer/);
  assert.ok(t.el.find((n) => n.textContent === "▼ selected"));
  assert.equal(t.hash(), "notimer.e25");
  const cur = t.el.find((n) => n.attrs["aria-current"] === "true");
  assert.match(cur.textContent, /No exit for 9\.90 s/);
});

test("keyboard: cursor, zoom, whole run, moments, escape", async () => {
  const t = await setup();
  const sc = t.byClass("bt__scroll");
  assert.equal(sc.attrs.tabindex, "0");
  assert.equal(sc.attrs.role, "slider");
  assert.equal(sc.attrs["aria-valuemin"], "0");
  assert.equal(sc.attrs["aria-valuemax"], "239");
  const keys = t.el.find((n) => n.id === sc.attrs["aria-describedby"]);
  assert.match(keys.textContent, /0 shows the whole run/);
  assert.match(keys.textContent, /Escape clears the cursor/);
  assert.doesNotMatch(keys.textContent, /Darker cells/, "the legend is not read on every focus");
  await sc.fire("keydown", { key: "ArrowRight" });
  assert.match(t.byClass("bt__cursor").textContent, /^Cursor at /);
  assert.match(sc.attrs["aria-valuetext"], /^Cursor at /);
  assert.equal(sc.attrs["aria-valuenow"], "120");
  await sc.fire("keydown", { key: "PageDown" });
  assert.equal(sc.attrs["aria-valuenow"], "130");
  assert.ok(!t.said.some((s) => /^Cursor at /.test(s)), "the cursor speaks through the slider, not announce");
  await sc.fire("keydown", { key: "+" });
  assert.match(t.hash(), /^healthy\.w\d+-\d+$/);
  await sc.fire("keydown", { key: "0" });
  assert.equal(t.hash(), null);
  await sc.fire("keydown", { key: "]" });
  assert.match(t.hash(), /\.e\d+$/);
  assert.ok(t.el.find((n) => n.attrs["aria-current"] === "true"));
  await sc.fire("keydown", { key: "Escape" });
  assert.equal(t.hash(), null);
  assert.equal(t.el.find((n) => n.attrs["aria-current"] === "true"), null);
});

test("zoom buttons are never disabled, so the focused one keeps focus", async () => {
  const t = await setup();
  const whole = t.button("Whole run");
  const zin = t.button("Zoom in (+)");
  assert.equal(whole.disabled, false);
  assert.equal(whole.attrs["aria-disabled"], "true");
  await zin.fire("click");
  assert.match(t.hash(), /^healthy\.w/);
  assert.equal(whole.attrs["aria-disabled"], undefined);
  await whole.fire("click");
  assert.equal(t.hash(), null);
  assert.equal(whole.disabled, false, "the focused button stays enabled");
  assert.equal(whole.attrs["aria-disabled"], "true");
  await whole.fire("click");
  assert.equal(t.hash(), null, "an aria-disabled button does nothing");
  for (let i = 0; i < 20; i++) await zin.fire("click");
  assert.equal(zin.disabled, false);
  assert.equal(zin.attrs["aria-disabled"], "true");
});

test("a milestone's details give the kernel's stamp and when our UART got it", async () => {
  const t = await setup();
  const ev = t.el.findAll((n) => n.cls().includes("bt__ev"));
  const boot = ev.find((b) => /Stage 1, entry: Booting Linux/.test(b.textContent));
  await boot.fire("click");
  assert.match(t.byClass("bt__detail").textContent, /The kernel stamped this line \[0\.000000\] seconds; 1\.80 ms on the axis is when our UART received its first byte/);
});

test("a file dropped anywhere on the lab is read there; destroy removes the listeners", async () => {
  const t = await setup();
  assert.equal(t.el.listeners.dragover.length, 1);
  const line = '{"t_ns":3000,"vcpu":0,"reason":"exception","ec":"0x16","pc":"0x40080104","imm":0,"fn":"PSCI_SYSTEM_OFF","action":"psci"}';
  await t.el.fire("drop", { dataTransfer: { files: [{ name: "d.jsonl", size: line.length, text: async () => line }] } });
  await settle();
  assert.match(t.byClass("bt__readout").textContent, /^Your trace \(d\.jsonl\): 1 exit in/);
  assert.match(t.byClass("bt__readout").textContent, /recorded without mmio/);
  t.api.destroy();
  assert.equal(t.el.listeners.dragover.length, 0);
  assert.equal(t.el.listeners.drop.length, 0);
});

test("a moment button keeps its element across renders (focus is not lost)", async () => {
  const t = await setup();
  const before = t.el.findAll((n) => n.cls().includes("bt__ev"));
  await before[10].fire("click");
  const after = t.el.findAll((n) => n.cls().includes("bt__ev"));
  assert.equal(after[10], before[10]);
  assert.equal(after[10].attrs["aria-current"], "true");
  assert.match(t.hash(), /\.e10$/);
});

test("hiding MMIO exits updates counters and the hash", async () => {
  const t = await setup();
  const cb = t.byId("g-m");
  cb.checked = false;
  await cb.fire("change");
  assert.equal(t.hash(), "healthy.hm");
  assert.ok(t.el.find((n) => n.tagName === "TH" && /\(hidden\)$/.test(n.textContent)));
  const sq = t.byId("squeeze");
  sq.checked = false;
  await sq.fire("change");
  assert.equal(t.hash(), "healthy.hm.r");
});

test("a dropped file is parsed locally, with its bad lines reported", async () => {
  const t = await setup();
  const lines = [
    "# a header line",
    '{"t_ns":1000,"vcpu":0,"reason":"exception","ec":"0x24","pc":"0x40080010","ipa":"0x9000000","wnr":true,"size":4,"reg":2,"value":"0x48","action":"mmio"}',
    '{"t_ns":2000,"vcpu":0,"reason":"exception","sysreg":"<script>"}',
    '{"t_ns":3000,"vcpu":0,"reason":"exception","ec":"0x16","pc":"0x40080104","imm":0,"fn":"PSCI_SYSTEM_OFF","action":"psci"}',
  ].join("\n");
  const input = t.byId("file");
  input.files = [{ name: "my<run>.jsonl", size: lines.length, text: async () => lines }];
  await input.fire("change");
  await settle();
  assert.match(t.byClass("bt__readout").textContent, /^Your trace \(my_run_\.jsonl\): 2 exits/);
  assert.match(t.byClass("bt__prov").textContent, /2 exits read, 1 other lines skipped, 1 bad records skipped/);
  assert.match(t.byClass("bt__prov").textContent, /Line 3: sysreg is not a plain name/);
  assert.equal(t.hash(), "file");
  const opt = t.el.find((n) => n.tagName === "OPTION" && n.value === "file");
  assert.equal(opt.disabled, false);
});

test("an oversized or empty file is refused with a message", async () => {
  const t = await setup();
  const input = t.byId("file");
  input.files = [{ name: "big.jsonl", size: 64 * 1024 * 1024, text: async () => "" }];
  await input.fire("change");
  assert.match(t.byClass("bt__status").textContent, /64 MiB; this lab reads at most 32 MiB/);
  assert.match(t.byClass("bt__status").textContent, /exits:boot\.jsonl:mmio,psci,cancel/);
  assert.ok(t.byClass("bt__status").cls().includes("bt__status--warn"));
  assert.deepEqual(t.said, [], "the status line is the only channel for file notes");
  input.files = [{ name: "x.txt", size: 5, text: async () => "hello" }];
  await input.fire("change");
  assert.match(t.byClass("bt__status").textContent, /does not look like a macvmm exit trace/);
  assert.match(t.byClass("bt__readout").textContent, /^Healthy boot/);
});

test("a link made with a file says so and falls back to the reference", async () => {
  const t = await setup("file.e3");
  assert.match(t.byClass("bt__status").textContent, /made with a trace file/);
  assert.ok(!t.byClass("bt__status").cls().includes("bt__status--warn"), "an information note is not in the warning colour");
  assert.match(t.byClass("bt__readout").textContent, /^Healthy boot/);
});

test("junk in the hash is ignored", async () => {
  const t = await setup("healthy.<img>");
  assert.match(t.byClass("bt__readout").textContent, /^Healthy boot/);
});

// --- static rules ---------------------------------------------------------------------------------

test("shipped files obey the lab contract", () => {
  const files = readdirSync(here, { recursive: true }).map(String).filter((f) => !f.endsWith(".test.mjs") && !readdirSync(here, { withFileTypes: true }).some((d) => d.isDirectory() && d.name === f));
  for (const f of files) assert.match(f, /\.(mjs|js|css|json|svg)$/, f);
  for (const f of files.filter((x) => /\.(mjs|js)$/.test(x))) {
    const code = readFileSync(join(here, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
    assert.doesNotMatch(code, /\beval\s*\(|new\s+Function|innerHTML|https?:\/\/|document\.write|WebAssembly|setAttribute\(\s*["']style|set(?:Timeout|Interval)\s*\(\s*["'`]/, f);
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export async function mount\b/);
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/(^|})\s*([^{}@]+?)\s*\{/g)) {
    for (const sel of m[2].split(",").map((x) => x.trim()).filter(Boolean)) assert.ok(sel.startsWith('.lab[data-lab="boot-timeline"]'), sel);
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b|rgb\(|transition|animation/);
  const meta = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(meta.title, "Boot timeline");
  assert.ok(sanitizeSvg(readFileSync(join(here, "fallback.svg"), "utf8"), "t"));
});
