// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom): the board is built
// once and updated in place (the focused select stays the same element), select changes settle
// into one move and one announcement, headings follow ctx.standalone, the feedback toggle keeps
// its label, Next pointers are real links, and Reset can be undone.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sib = this.parentNode.childNodes;
    return sib[sib.indexOf(this) + 1] ?? null;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
}
class FakeText extends FakeNode {
  constructor(t) { super(); this.data = String(t); }
  get textContent() { return this.data; }
}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.dataset = {};
  }
  get id() { return this.attrs.id ?? ""; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  _adopt(n) {
    const node = typeof n === "string" ? new FakeText(n) : n;
    if (node.parentNode) node.parentNode._remove(node);
    node.parentNode = this;
    return node;
  }
  _remove(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    if (globalThis.document.activeElement && n instanceof FakeEl && n.contains(globalThis.document.activeElement)) globalThis.document.activeElement = null;
    n.parentNode = null;
  }
  append(...kids) { for (const k of kids) this.childNodes.push(this._adopt(k)); }
  insertBefore(n, ref) {
    const node = this._adopt(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    globalThis.moves = (globalThis.moves || 0) + 1;
  }
  replaceChildren(...kids) {
    for (const c of [...this.childNodes]) this._remove(c);
    this.append(...kids);
  }
  set textContent(v) { this.replaceChildren(String(v)); }
  get textContent() { return super.textContent; }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  focus() { globalThis.document.activeElement = this; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, target) { for (const fn of this.listeners[t] || []) fn({ type: t, target: target ?? this }); }
  *walk() { yield this; for (const c of this.childNodes) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}
class FakeSelect extends FakeEl {}

function setup({ hash = null, standalone = false } = {}) {
  globalThis.document = {
    activeElement: null,
    createElement: (t) => (t === "select" ? new FakeSelect(t) : new FakeEl(t)),
    createTextNode: (t) => new FakeText(t),
  };
  globalThis.HTMLSelectElement = FakeSelect;
  globalThis.Element = FakeEl;
  globalThis.Node = FakeNode;
  globalThis.moves = 0;
  const said = [];
  let stored = hash;
  const ctx = {
    name: "trap-or-not",
    id: "lab-trap-or-not-1",
    base: "https://example.test/build-your-own/vmm/assets/labs/trap-or-not/",
    standalone,
    reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const el = new FakeEl("div");
  return { el, ctx, said, hash: () => stored };
}

const sel = (el, id) => el.findAll((n) => n.tagName === "SELECT" && n.dataset.item === id)[0];
const zoneOf = (el, node) => { for (let x = node; x; x = x.parentNode) if (x.dataset && "bucket" in x.dataset) return x.dataset.bucket; return undefined; };

test("select changes settle into one move and one announcement, and the select stays the same element", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { mount } = await import("./view.mjs");
    const { el, ctx, said, hash } = setup();
    mount(el, ctx);
    const s = sel(el, "ldr-ram");
    s.focus();
    globalThis.moves = 0;
    for (const v of ["vmm", "kernel", "guest"]) {
      s.value = v;
      el.dispatch("change", s);
      mock.timers.tick(100);
    }
    assert.equal(zoneOf(el, s), "", "not moved while still arrowing");
    mock.timers.tick(400);
    assert.equal(zoneOf(el, s), "guest");
    assert.equal(globalThis.moves, 1, "the card moved once");
    assert.equal(sel(el, "ldr-ram"), s, "same select element");
    assert.equal(document.activeElement, sel(el, "str-uart"), "focus moves on to the next unsorted card");
    assert.equal(hash(), "g---------");
    assert.equal(said.length, 1);
    assert.match(said[0], /^Load a value from RAM: moved to Never leaves the guest\. 1 of 10 sorted\. Next: Store a byte/);
  } finally {
    mock.timers.reset();
  }
});

test("after feedback, a move names the reference bucket for screen readers", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { mount } = await import("./view.mjs");
    const { el, ctx, said } = setup({ hash: "----------!" });
    mount(el, ctx);
    const s = sel(el, "wfi");
    s.value = "vmm";
    el.dispatch("change", s);
    mock.timers.tick(1000);
    assert.match(said.at(-1), /Different from the reference, which is: Stops, but the macOS kernel handles it\.$/);
    s.value = "kernel";
    el.dispatch("change", s);
    mock.timers.tick(1000);
    assert.match(said.at(-1), /Same as the reference\.$/);
  } finally {
    mock.timers.reset();
  }
});

test("headings, toggle label, empty-bucket text, links and the two feedback questions", async () => {
  const { mount } = await import("./view.mjs");
  for (const [standalone, tag] of [[true, "H2"], [false, "H4"]]) {
    const { el, ctx } = setup({ hash: "gvkvgggvvk!", standalone });
    mount(el, ctx);
    assert.equal(el.findAll((n) => n.className === "ton__zonehead").every((n) => n.tagName === tag), true);
  }
  const { el, ctx } = setup({ hash: "gvkvgggvvk!" });
  mount(el, ctx);
  const btn = el.findAll((n) => n.tagName === "BUTTON")[0];
  assert.equal(btn.textContent, "Show feedback");
  assert.equal(btn.attrs["aria-pressed"], "true");
  const empties = el.findAll((n) => n.className === "ton__empty");
  assert.ok(empties.some((n) => n.textContent.includes("pick this bucket in a card's Bucket menu")));
  const dts = el.findAll((n) => n.tagName === "DT").map((n) => n.textContent);
  assert.ok(dts.includes("What stops it") && dts.includes("Who handles it") && !dts.includes("Decided by"));
  // The two questions lead each card; Why is not repeated, and the extras sit behind <details>.
  const fb = el.findAll((n) => n.className === "ton__fb")[0];
  assert.deepEqual(fb.findAll((n) => n.tagName === "DT").slice(0, 2).map((n) => n.textContent), ["What stops it", "Who handles it"]);
  assert.ok(!dts.includes("Why"));
  assert.equal(el.findAll((n) => n.tagName === "DETAILS").length, 10);
  const hrefs = el.findAll((n) => n.tagName === "A").map((n) => n.attrs.href);
  assert.ok(hrefs.includes("https://example.test/build-your-own/vmm/primers/os-basics/"));
  assert.ok(hrefs.includes("https://example.test/build-your-own/vmm/bare-machine/test-guests/"));
});

test("reset can be undone from right after Reset, until the next change (no timer)", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { mount } = await import("./view.mjs");
    const { el, ctx, hash } = setup({ hash: "gvk-------" });
    mount(el, ctx);
    const buttons = el.findAll((n) => n.tagName === "BUTTON");
    const [, reset, undo] = buttons;
    assert.ok(undo.className.includes("ton__undo"), "Undo is the button right after Reset");
    assert.equal(undo.parentNode, reset.parentNode, "same control row");
    assert.equal(undo.hidden, true);
    reset.dispatch("click");
    assert.equal(hash(), null);
    assert.equal(undo.hidden, false);
    undo.dispatch("click");
    assert.equal(hash(), "gvk-------");
    assert.equal(zoneOf(el, sel(el, "wfi")), "kernel");
    assert.equal(undo.hidden, true);
    reset.dispatch("click");
    mock.timers.tick(60000);
    assert.equal(undo.hidden, false, "still offered after a minute");
    const s = sel(el, "ldr-ram");
    s.value = "guest";
    el.dispatch("change", s);
    mock.timers.tick(1000);
    assert.equal(undo.hidden, true, "gone after the next change");
    assert.equal(hash(), "g---------");
  } finally {
    mock.timers.reset();
  }
});

test("sorting from the pool hands focus to the next unsorted card", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { mount } = await import("./view.mjs");
    const { el, ctx, said } = setup({ hash: "--k-------" });
    mount(el, ctx);
    const s = sel(el, "str-uart");
    s.focus();
    s.value = "vmm";
    el.dispatch("change", s);
    mock.timers.tick(1000);
    assert.equal(document.activeElement, sel(el, "hvc"), "skips the sorted wfi card");
    assert.match(said.at(-1), /Next: The guest kernel calls the level above\.$/);
    // Re-sorting a card that is already in a bucket keeps focus on it.
    const w = sel(el, "wfi");
    w.focus();
    w.value = "guest";
    el.dispatch("change", w);
    mock.timers.tick(1000);
    assert.equal(document.activeElement, w);
    // The last unsorted card: nothing left, focus stays on the moved select.
    const { el: el2, ctx: ctx2 } = setup({ hash: "gvkvgggvv-" });
    mount(el2, ctx2);
    const last = sel(el2, "str-gic");
    last.focus();
    last.value = "kernel";
    el2.dispatch("change", last);
    mock.timers.tick(1000);
    assert.equal(document.activeElement, last);
  } finally {
    mock.timers.reset();
  }
});

test("before all ten are sorted, Show feedback shows progress and asks for a guess first", async () => {
  const { mount } = await import("./view.mjs");
  const { el, ctx } = setup({ hash: "gvk-------" });
  mount(el, ctx);
  const btn = el.findAll((n) => n.tagName === "BUTTON")[0];
  assert.equal(btn.textContent, "Show feedback (3 of 10 sorted)");
  const note = el.findAll((n) => n.className === "ton__sortfirst")[0];
  assert.equal(note.hidden, false);
  btn.dispatch("click");
  assert.equal(btn.attrs["aria-pressed"], "true", "still works");
  assert.equal(note.hidden, true);
});

test("only the card title is draggable, never the card around the select", async () => {
  const { mount } = await import("./view.mjs");
  const { el, ctx } = setup();
  mount(el, ctx);
  const draggable = el.findAll((n) => n.attrs.draggable === "true");
  assert.equal(draggable.length, 10);
  for (const d of draggable) {
    assert.equal(d.className, "ton__plain");
    assert.equal(d.findAll((n) => n.tagName === "SELECT").length, 0);
  }
  for (const s of el.findAll((n) => n.tagName === "SELECT")) {
    for (let x = s.parentNode; x; x = x.parentNode) assert.notEqual(x.attrs.draggable, "true");
  }
});

test("a hostile hash starts fresh", async () => {
  const { mount } = await import("./view.mjs");
  const { el, ctx } = setup({ hash: "<img src=x onerror=alert(1)>" });
  mount(el, ctx);
  assert.equal(el.findAll((n) => n.tagName === "SELECT").every((s) => s.value === ""), true);
});
