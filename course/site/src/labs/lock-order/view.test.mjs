// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders, that the Step / swap / spurious / search buttons drive the model, that the
// share hash is written and read back, and that nothing is ever parsed as HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

class FakeEl {
  constructor(tag, ns = null) {
    this.tagName = ns ? tag : tag.toUpperCase();
    this.ns = ns;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = "";
    this._class = "";
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
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === "value") this.value = v;
    if (k === "hidden") this.hidden = true;
    if (k === "class") this._class = v;
  }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? textNode(k) : k); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  focus() { globalThis.document.activeElement = this; }
  prepend(k) { this.children.unshift(k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t) { for (const fn of this.listeners[t] || []) fn({ type: t }); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}
function textNode(s) { return { textContent: s }; }

function setup(hash = null) {
  globalThis.document = {
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t, ns),
    activeElement: null,
  };
  globalThis.window = { localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }, location: { href: "x" } };
  const said = [];
  let stored = hash;
  const ctx = {
    name: "lock-order", id: "lab-lock-order-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  return { ctx, said, hash: () => stored };
}

const buttons = (root) => Object.fromEntries(root.findAll((e) => e.tagName === "BUTTON").map((b) => [b.textContent, b]));
const readout = (root) => root.findAll((e) => e.className === "lo-readout")[0].textContent;
/** Clicks a button the way a keyboard user does: focus it, then activate it. */
function press(btn) { btn.focus(); btn.dispatch("click"); }
const select = (root) => root.findAll((e) => e.tagName === "SELECT")[0];

test("mount renders the deadlock scenario and steps into the cycle", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(hash(), "deadlock.00.");
  assert.match(readout(root), /Step 0\. vCPU thread: ready; stdin thread: ready\./);
  for (const who of ["vCPU thread", "stdin thread", "vCPU thread", "stdin thread"]) buttons(root)[`Step ${who}`].dispatch("click");
  assert.equal(hash(), "deadlock.00.1212");
  assert.match(readout(root), /Deadlock\. vCPU thread waits for input, held by stdin thread; stdin thread waits for device, held by vCPU thread\./);
  const b = buttons(root);
  assert.ok(b["Step vCPU thread"].disabled);
  assert.ok(b["Step stdin thread"].disabled);
  // The graph draws four edges, two of them dashed waits, all four in the cycle.
  const lines = root.findAll((e) => e.tagName === "line");
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((l) => l.attrs.class.includes("lo-edge--cycle")).length, 4);
  assert.equal(lines.filter((l) => l.attrs.class.includes("lo-edge--wait")).length, 2);
  assert.ok(root.findAll((e) => e.tagName === "text").some((t) => t.textContent === "cycle"));
  b["Undo step"].dispatch("click");
  assert.equal(hash(), "deadlock.00.121");
  api.destroy();
});

test("swapping the stdin thread's order restarts, and every schedule then finishes", async () => {
  const { ctx, hash } = setup("deadlock.00.12");
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  buttons(root)["Swap stdin thread's lock order"].dispatch("click");
  assert.equal(hash(), "deadlock.01.");
  buttons(root)["Try every schedule"].dispatch("click");
  assert.match(root.textContent, /Checked every schedule: 28 reachable states\. No schedule deadlocks/);
});

test("search finds the shortest deadlock and Show me replays it", async () => {
  const { ctx, hash } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  buttons(root)["Try every schedule"].dispatch("click");
  assert.match(root.textContent, /It can deadlock\. Shortest way \(4 steps\): vCPU thread, stdin thread, vCPU thread, stdin thread\./);
  buttons(root)["Show me that schedule"].dispatch("click");
  assert.equal(hash(), "deadlock.00.1212");
});

test("condvar mode: early notify is lost, spurious wake-up runs early", async () => {
  const { ctx, hash } = setup("lost.00.1111122");
  const { mount } = await import("./view.mjs");
  let root = new FakeEl("div");
  mount(root, ctx).destroy();
  assert.match(readout(root), /Asleep forever\. secondary vCPU sleeps on the condvar and nobody is left to ring the bell: the only notify came before anyone was waiting/);
  assert.match(root.textContent, /Notifies that found nobody waiting \(lost\): 1\./);

  const env = setup("lost.00.22");
  root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  buttons(root)["Spurious wake-up"].dispatch("click");
  buttons(root)["Step secondary vCPU"].dispatch("click");
  buttons(root)["Step secondary vCPU"].dispatch("click");
  assert.equal(env.hash(), "lost.00.22w222");
  assert.match(readout(root), /secondary vCPU ran before powered_on was true/);
  assert.equal(hash(), "lost.00.1111122");
});

test("scenario select switches and resets; hostile hashes fall back to the start", async () => {
  const { mount } = await import("./view.mjs");
  let env = setup("deadlock.00.1212");
  let root = new FakeEl("div");
  mount(root, env.ctx).destroy();
  const sel = select(root);
  sel.value = "park";
  sel.dispatch("change");
  assert.equal(env.hash(), "park.00.");
  assert.ok(buttons(root)["Spurious wake-up"]);
  sel.value = "<img src=x>";
  sel.dispatch("change");
  assert.equal(env.hash(), "park.00.");

  for (const bad of ["<script>alert(1)</script>", "deadlock.00.9", "constructor.00."]) {
    env = setup(bad);
    root = new FakeEl("div");
    mount(root, env.ctx).destroy();
    assert.equal(env.hash(), "deadlock.00.");
  }
});

test("shipped lab code avoids forbidden constructs", () => {
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json", "fallback.svg"]) {
    const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "https://", "<script", "onload=", "onclick=", "javascript:", "foreignObject", "setTimeout(\"", "style="]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
    if (f !== "fallback.svg") assert.ok(!code.includes("http://"), `${f} contains http://`);
  }
  const svg = readFileSync(fileURLToPath(new URL("./fallback.svg", import.meta.url)), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  const css = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of css.split("}")) {
    const sel = block.split("{").slice(-2, -1)[0];
    if (!sel || !block.includes("{")) continue;
    for (const one of sel.split(",")) {
      const t = one.trim();
      if (t) assert.ok(t.startsWith('.lab[data-lab="lock-order"]'), `unscoped selector: ${t}`);
    }
  }
  assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(css), "no hard-coded colors");
});

test("keyboard focus survives every re-render", async () => {
  const { ctx } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  mount(root, ctx).destroy();
  // The pressed Step button is rebuilt; focus moves to its replacement.
  press(buttons(root)["Step vCPU thread"]);
  assert.equal(document.activeElement, buttons(root)["Step vCPU thread"]);
  assert.equal(document.activeElement.getAttribute("data-focus"), "step-0");
  // Swap restarts the run; focus stays on the (new) swap button.
  press(buttons(root)["Swap stdin thread's lock order"]);
  assert.equal(document.activeElement, buttons(root)["Swap stdin thread's lock order"]);
  // Back to the deadlock order and into the cycle: when the pressed Step button becomes disabled
  // focus goes to the next thread that can still step, and at the end to the outcome banner.
  press(buttons(root)["Swap stdin thread's lock order"]);
  for (const who of ["vCPU thread", "stdin thread", "vCPU thread"]) press(buttons(root)[`Step ${who}`]);
  assert.equal(document.activeElement, buttons(root)["Step stdin thread"], "vCPU asleep: focus moves on");
  press(buttons(root)["Step stdin thread"]);
  assert.match(document.activeElement.className, /lo-banner/);
  assert.equal(document.activeElement.getAttribute("tabindex"), "-1");
  // Undo of the only step disables Undo; focus lands on a Step button, Reset is never disabled.
  press(buttons(root)["Reset"]);
  assert.equal(document.activeElement, buttons(root)["Reset"]);
  assert.equal(buttons(root)["Reset"].disabled, false);
  press(buttons(root)["Step vCPU thread"]);
  press(buttons(root)["Undo step"]);
  assert.equal(document.activeElement, buttons(root)["Step vCPU thread"]);
});

test("changes are announced once, briefly, and the readout is not a second live region", async () => {
  const { ctx, said } = setup();
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const api = mount(root, ctx);
  assert.equal(root.findAll((e) => "aria-live" in e.attrs).length, 0);
  const svg = root.findAll((e) => e.tagName === "svg")[0];
  assert.equal(svg.attrs["aria-labelledby"], "lab-lock-order-1-graph-title");
  assert.equal(root.findAll((e) => e.tagName === "desc").length, 0);
  for (const who of ["vCPU thread", "stdin thread", "vCPU thread", "stdin thread"]) press(buttons(root)[`Step ${who}`]);
  await new Promise((r) => setTimeout(r, 350));
  api.destroy();
  assert.equal(said.length, 1, "throttled: one announcement for a burst of steps");
  assert.match(said[0], /^stdin thread: .*\. Deadlock\. vCPU thread waits for input/);
  assert.match(root.textContent, /Fix it: press Swap on the stdin thread/);
  assert.match(root.textContent, /Challenge: get each thread to take its first lock/);
  assert.ok(!root.textContent.includes("→"), "no arrow glyphs for screen readers to mangle");
});
