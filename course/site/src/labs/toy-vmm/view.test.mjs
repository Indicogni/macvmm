// Smoke test for the toy-vmm view on a minimal fake DOM (no browser, no dependencies).
// It checks that mount renders, that the controls drive the model, that the share hash is
// read and written, and that the view uses no innerHTML.
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
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this._text = "";
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(" ").filter(Boolean));
        if (on === undefined ? !set.has(c) : on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(" ");
      },
      contains(c) {
        return self.className.split(" ").includes(c);
      },
    };
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
  removeAttribute(k) {
    delete this.attrs[k];
  }
  focus() {
    globalThis.document.activeElement = this;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this });
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
    this.textWrites = (this.textWrites || 0) + 1;
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
  activeElement: null,
};

const { mount } = await import("./view.mjs");

function setup(hash = null, extra = {}) {
  const el = new Node("div");
  const said = [];
  let h = hash;
  const ctx = {
    name: "toy-vmm",
    id: "lab-toy-vmm-1",
    base: "/assets/labs/toy-vmm/",
    standalone: false,
    reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => h, set: (v) => (h = v) },
    ...extra,
  };
  const api = mount(el, ctx);
  const all = () => [...el.walk()];
  const button = (label) => all().find((n) => n.tagName === "button" && n.textContent === label);
  const summary = () => all().find((n) => n.className === "tv__summary").textContent;
  const radio = (m) => all().find((n) => n.attrs.id === `lab-toy-vmm-1-mode-${m}`);
  const choose = (m) => {
    radio(m).checked = true;
    radio(m).dispatch("change");
  };
  return { el, api, all, button, summary, said, hash: () => h, choose };
}

test("mounts with mode A selected and an empty run", () => {
  const v = setup();
  const radio = v.all().find((n) => n.attrs.id === "lab-toy-vmm-1-mode-A");
  assert.equal(radio.checked, true);
  assert.match(v.summary(), /^Mode A, bare metal: 0 guest instructions run/);
  assert.equal(v.hash(), null);
  v.api.destroy();
});

test("Run to 1,000 in mode D gives the lesson's counts and writes the hash", () => {
  const v = setup();
  const radio = v.all().find((n) => n.attrs.id === "lab-toy-vmm-1-mode-D");
  radio.checked = true;
  radio.dispatch("change");
  v.button("Run to 1,000").dispatch("click");
  assert.match(v.summary(), /987 natively by the CPU, 13 VMM interventions \(13 traps\)\. Console: 123 \(matches bare metal\)/);
  assert.equal(v.hash(), "D@1000");
  assert.equal(v.button("Step").disabled, true);
  v.api.destroy();
});

test("a share hash restores mode, options and position", () => {
  const v = setup("H-bic@1000");
  assert.match(v.summary(), /Mode H, hardware assist: 1,000 guest instructions run, 995 natively by the CPU, 5 VMM interventions/);
  const box = v.all().find((n) => n.attrs.id === "lab-toy-vmm-1-opt-trapBase");
  assert.equal(box.checked, true);
  v.api.destroy();
});

test("a malformed hash falls back to mode A", () => {
  const v = setup("<script>");
  assert.match(v.summary(), /^Mode A/);
  v.api.destroy();
});

test("Step in mode E shows GETMODE executed by the CPU", () => {
  const v = setup("E-");
  for (let k = 0; k < 3; k++) v.button("Step").dispatch("click");
  const rows = v.all().filter((n) => n.tagName === "tr" && n.className.startsWith("tv__who"));
  const last = rows[rows.length - 1];
  assert.match(last.textContent, /GETMODE r1CPU/);
  assert.equal(v.hash(), "E-@3");
  assert.ok(v.said.length > 0);
  v.api.destroy();
});

test("the option toggle in mode E restarts the run as mode D would", () => {
  const v = setup("E-");
  const box = v.all().find((n) => n.attrs.id === "lab-toy-vmm-1-opt-getmodePrivileged");
  box.checked = true;
  box.dispatch("change");
  v.button("Run to 1,000").dispatch("click");
  assert.match(v.summary(), /13 VMM interventions/);
  assert.equal(v.hash(), "E-p@1000");
  v.api.destroy();
});

test("shipped lab code avoids the strings the builder rejects", () => {
  for (const f of ["view.mjs", "model.mjs"]) {
    const src = readFileSync(join(here, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
});

test("every style.css selector is scoped to the lab", () => {
  const css = readFileSync(join(here, "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@"));
  for (const group of selectors) {
    for (const sel of group.split(",")) assert.ok(sel.trim().startsWith('.lab[data-lab="toy-vmm"]'), `unscoped: ${sel.trim()}`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "no hard-coded colors");
});

test("mode H by default traps only the console range: 3 interventions", () => {
  const v = setup("H-c");
  v.button("Run to 1,000").dispatch("click");
  assert.match(v.summary(), /997 natively by the CPU, 3 VMM interventions \(3 traps\)/);
  v.api.destroy();
});

test("when a run ends, focus moves from the disabled button to Reset", () => {
  const v = setup();
  v.choose("B");
  const stepBtn = v.button("Step");
  stepBtn.focus();
  stepBtn.dispatch("click");
  assert.equal(stepBtn.disabled, true);
  assert.equal(document.activeElement, v.button("Reset"));
  assert.match(v.said[v.said.length - 1] || "", /./);
  v.api.destroy();
});

test("Step announces the step's own explanation, then only what changed", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const v = setup("E-");
    for (let k = 0; k < 3; k++) {
      v.button("Step").dispatch("click");
      mock.timers.tick(400);
    }
    const last = v.said[v.said.length - 1];
    assert.match(last, /^kernel 02, GETMODE r1: CPU\. Runs natively: the CPU really is in user mode/);
    assert.doesNotMatch(last, /Toy-model time/);
    // Run to 1,000 gives the full summary and says how to run again.
    v.button("Run to 1,000").dispatch("click");
    mock.timers.tick(400);
    const fin = v.said[v.said.length - 1];
    assert.match(fin, /^Mode E, trap-and-emulate, real GETMODE: 1,000 guest instructions run/);
    assert.match(fin, /Run finished; press Reset to run again\.$/);
    v.api.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("the console is not a live region and is rewritten only when it changes", () => {
  const v = setup("D");
  const con = v.all().find((n) => n.attrs.id === "lab-toy-vmm-1-console");
  assert.equal(con.tagName, "pre");
  assert.equal(con.attrs["aria-live"], undefined);
  const writes = con.textWrites;
  v.button("Step").dispatch("click");
  v.button("Step").dispatch("click");
  assert.equal(con.textWrites, writes);
  v.button("Run to 1,000").dispatch("click");
  assert.equal(con.textContent, "123");
  v.api.destroy();
});

test("the answers table appears only after Show the answers", () => {
  const v = setup();
  const answersCaption = () => v.all().find((n) => n.tagName === "caption" && /Default options/.test(n.textContent));
  assert.equal(answersCaption(), undefined);
  const summ = v.all().find((n) => n.tagName === "summary" && /^Answers:/.test(n.textContent));
  assert.ok(summ);
  v.button("Show the answers").dispatch("click");
  assert.ok(answersCaption());
  v.api.destroy();
});

test("the listing is built once per mode, and the trace grows by appending", () => {
  const v = setup("D");
  const listing = () => v.all().find((n) => n.tagName === "caption" && /^Marks:/.test(n.textContent));
  const before = listing();
  const traceCaption = () => v.all().find((n) => n.tagName === "caption" && /so far|The last/.test(n.textContent));
  v.button("Step").dispatch("click");
  const cap = traceCaption();
  v.button("Step").dispatch("click");
  assert.equal(listing(), before);
  assert.equal(traceCaption(), cap);
  assert.equal(cap.textContent, "2 instructions so far.");
  const current = v.all().filter((n) => n.tagName === "tr" && n.attrs["aria-current"] === "step");
  assert.equal(current.length, 1);
  v.button("Run to 1,000").dispatch("click");
  const rows = v.all().filter((n) => n.tagName === "tr" && n.className.startsWith("tv__who"));
  assert.equal(rows.length, 40);
  v.choose("A");
  assert.notEqual(listing(), before);
  v.api.destroy();
});

test("Play disables itself when the run finishes, and the label is not a pressed toggle", () => {
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  try {
    const v = setup();
    v.choose("B");
    const play = v.button("Play");
    play.focus();
    play.dispatch("click");
    assert.equal(play.textContent, "Pause");
    assert.equal(play.attrs["aria-pressed"], undefined);
    mock.timers.tick(600);
    assert.equal(play.textContent, "Play");
    assert.equal(play.disabled, true);
    assert.equal(document.activeElement, v.button("Reset"));
    v.api.destroy();
  } finally {
    mock.timers.reset();
  }
});

test("the standalone page links to chapter 00; the embedded lab does not", () => {
  const link = (v) => v.all().find((n) => n.tagName === "a" && n.textContent === "chapter 00");
  const emb = setup();
  assert.equal(link(emb), undefined);
  emb.api.destroy();
  const st = setup(null, { standalone: true, base: "https://example.test/build-your-own/vmm/assets/labs/toy-vmm/" });
  assert.equal(link(st).attrs.href, "/build-your-own/vmm/start/orientation/");
  st.api.destroy();
});
