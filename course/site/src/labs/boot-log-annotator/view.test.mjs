// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It checks that
// mount() renders a sample, that the sample menu, stage strip, line selection, keyboard, filters
// and paste box drive the model, that the share hash is written and read back, and that nothing is
// ever parsed as HTML.
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
    this.focused = false;
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
    if (k === "disabled") this.disabled = true;
  }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === "string" ? { textContent: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, extra = {}) { for (const fn of this.listeners[t] || []) fn({ type: t, preventDefault() {}, ...extra }); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML must not be used"); }
  *walk() { yield this; for (const c of this.children) if (c instanceof FakeEl) yield* c.walk(); }
  findAll(pred) { return [...this.walk()].filter(pred); }
}

async function setup(hash = null) {
  globalThis.document = { createElement: (t) => new FakeEl(t) };
  let stored = hash;
  const said = [];
  const ctx = {
    name: "boot-log-annotator", id: "lab-boot-log-annotator-1", base: "", standalone: true, reducedMotion: true,
    announce: (t) => said.push(t),
    hash: { get: () => stored, set: (v) => { stored = v; } },
  };
  const { mount } = await import("./view.mjs");
  const root = new FakeEl("div");
  const handle = mount(root, ctx);
  const btn = (text) => root.findAll((e) => e.tagName === "BUTTON" && e.textContent === text)[0];
  const byId = (suffix) => root.findAll((e) => e.attrs.id === `${ctx.id}-${suffix}`)[0];
  const byClass = (c) => root.findAll((e) => e.classList.contains(c));
  const line = (n) => byId(`l${n}`);
  return { root, ctx, said, handle, btn, byId, byClass, line, hash: () => stored };
}

test("mounts on the healthy boot with a clean hash and all stages done", async () => {
  const t = await setup();
  assert.equal(t.hash(), null);
  assert.equal(t.byId("sample").value, "boot");
  const stages = t.byClass("bla-stage");
  assert.equal(stages.length, 8);
  assert.ok(stages.every((s) => s.classList.contains("bla-stage--done")));
  assert.match(t.byClass("bla-verdict")[0].textContent, /All eight stages completed/);
  assert.equal(t.byClass("bla-line").length, 183);
  // Opens on the first milestone, with the detail panel explaining it.
  assert.equal(t.line(1).getAttribute("aria-current"), "true");
  assert.equal(t.line(1).getAttribute("tabindex"), "0");
  assert.match(t.byClass("bla-detail")[0].textContent, /The first line start_kernel\(\) prints/);
  t.handle.destroy();
});

test("the reference hash opens the no-timer run on the probe line, and the panel names /timer", async () => {
  const t = await setup("no-timer.s.61");
  assert.equal(t.hash(), "no-timer.s.61");
  assert.equal(t.byId("sample").value, "no-timer");
  const detail = t.byClass("bla-detail")[0].textContent;
  assert.match(detail, /No timer in the device tree/);
  assert.match(detail, /Device-tree node \/timer/);
  assert.match(detail, /compatible = "arm,armv8-timer"/);
  assert.match(detail, /Chapter 11: Getting the CPU back/);
  const s4 = t.byClass("bla-stage")[3];
  assert.ok(s4.classList.contains("bla-stage--next"));
  assert.match(s4.getAttribute("aria-label"), /the next stage the boot was waiting for/);
  assert.match(t.byClass("bla-verdict")[0].textContent, /Stages 1 to 3 completed/);
  // A broken run: the header line naming the breakage, and the verdict, wait behind "Show the verdict".
  assert.ok(!/Deliberate breakage/.test(t.byClass("bla-prov")[0].textContent));
  assert.ok(!t.byClass("bla-prov")[0].textContent.includes("Regenerate"));
  const reveal = t.byClass("bla-reveal")[0];
  assert.equal(reveal.tagName, "DETAILS");
  assert.equal(reveal.children[0].tagName, "SUMMARY");
  assert.match(reveal.textContent, /Show the verdict/);
  assert.match(reveal.textContent, /What was changed: Deliberate breakage 1/);
  t.handle.destroy();
});

test("keyboard and clicks move the selection and write the hash; the filter skips housekeeping", async () => {
  const t = await setup("no-timer.s.61");
  t.line(61).dispatch("keydown", { key: "ArrowDown" });
  assert.equal(t.hash(), "no-timer.s.62");
  assert.ok(t.line(62).focused);
  t.line(62).dispatch("keydown", { key: "Home" });
  assert.equal(t.hash(), "no-timer.s.1");
  t.line(1).dispatch("keydown", { key: "End" });
  assert.equal(t.hash(), "no-timer.s.74");
  t.line(30).dispatch("click");
  assert.equal(t.hash(), "no-timer.s.30");
  const only = t.byId("only");
  only.checked = true;
  only.dispatch("change");
  assert.equal(t.hash(), "no-timer.s.a.30");
  assert.ok(t.byClass("bla-log")[0].classList.contains("bla-log--only"));
  // Lines 10 to 16 (NODE_DATA, the zones, "Early memory node ranges") are housekeeping, hidden by
  // the filter; Down from line 9 (NUMA, our machine) lands on line 17, the memory node.
  t.line(9).dispatch("keydown", { key: "ArrowDown" });
  assert.equal(t.hash(), "no-timer.s.a.17");
  assert.match(t.byClass("bla-detail")[0].textContent, /The memory node, as the kernel read it/);
  const kind = t.byId("c-k");
  kind.checked = true;
  kind.dispatch("change");
  assert.match(t.hash(), /^no-timer\.k\.a\./);
  assert.ok(t.byClass("bla-log")[0].classList.contains("bla-log--kind"));
  // A stage button jumps to its milestone.
  t.byClass("bla-stage")[2].dispatch("click");
  assert.match(t.hash(), /^no-timer\.k\.a\.58$/);
  assert.match(t.byClass("bla-detail")[0].textContent, /A CPU's redistributor was found/);
  t.handle.destroy();
});

test("pasting a log annotates it; the link never carries the text", async () => {
  const t = await setup();
  const sel = t.byId("sample");
  sel.value = "paste";
  sel.dispatch("change");
  assert.equal(t.hash(), "paste.s");
  // Picking "Your own log" shows the paste box but leaves focus on the menu (no change of context).
  assert.equal(t.byId("paste").focused, false);
  assert.equal(t.byClass("bla-paste")[0].hidden, false);
  assert.match(t.byClass("bla-verdict")[0].textContent, /Nothing reached the serial port/);
  t.byId("paste").value = "[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x610f0000]\n[    0.000000] Machine model: \u001b]0;pwned\u0007\n<b>bold</b>";
  t.btn("Annotate").dispatch("click");
  assert.equal(t.byClass("bla-line").length, 3);
  assert.equal(t.line(2).children.at(-1).textContent, "[    0.000000] Machine model: \\x1b]0;pwned\\x07");
  assert.equal(t.line(3).children.at(-1).textContent, "<b>bold</b>");
  assert.equal(t.hash(), "paste.s");
  assert.match(t.byClass("bla-verdict")[0].textContent, /2 control bytes are shown as escapes/);
  t.btn("Reset").dispatch("click");
  assert.equal(t.hash(), null);
  assert.equal(t.byId("sample").value, "boot");
  t.handle.destroy();
});

test("a shared paste link explains why the log is missing; hostile hashes fall back to the default", async () => {
  const t = await setup("paste.k.4");
  assert.match(t.byClass("bla-msg")[0].textContent, /links never carry the log itself/);
  assert.equal(t.hash(), "paste.k");
  t.handle.destroy();
  for (const bad of ["<img src=x onerror=alert(1)>", "boot.s.999999", "no-timer.q"]) {
    const u = await setup(bad);
    assert.equal(u.byId("sample").value, "boot");
    if (bad === "boot.s.999999") assert.equal(u.hash(), null);
    u.handle.destroy();
  }
});

test("the silent run renders an empty log and a verdict about earlycon", async () => {
  const t = await setup("silent.s");
  assert.equal(t.byClass("bla-line").length, 0);
  assert.match(t.byClass("bla-empty")[0].textContent, /showed nothing/);
  assert.match(t.byClass("bla-verdict")[0].textContent, /82 exits/);
  assert.ok(t.byClass("bla-stage").every((s) => s.disabled));
  t.handle.destroy();
});

test("the ESR line in the redistributor Oops links to the ESR decoder", async () => {
  const t = await setup("wrong-gicr.s");
  const esrLine = t.byClass("bla-line").find((b) => /ESR = 0x0000000096000044/.test(b.textContent));
  esrLine.dispatch("click");
  const a = t.root.findAll((e) => e.tagName === "A" && /ESR decoder/.test(e.textContent))[0];
  assert.equal(a.getAttribute("href"), "/build-your-own/vmm/labs/esr-decoder/#esr-decoder=0x96000044");
  t.handle.destroy();
});

test("one summary voice: no live regions in the lab, and a sample change is announced once", async () => {
  const t = await setup();
  const live = t.root.findAll((e) => e.attrs["aria-live"] || e.attrs.role === "status" || e.attrs.role === "alert");
  assert.deepEqual(live, []);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(t.said, [], "nothing is announced on page load");
  const sel = t.byId("sample");
  for (const v of ["no-timer", "wrong-gicr", "no-id", "boot"]) { sel.value = v; sel.dispatch("change"); }
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(t.said.length, 1, t.said.join(" | "));
  assert.match(t.said[0], /^A healthy boot \(chapter 14\), 183 lines\. All eight stages completed\.$/);
  t.handle.destroy();
});

test("a broken run hides its answer: neutral name, verdict collapsed, panel on the first milestone", async () => {
  const t = await setup("no-id.s");
  assert.equal(t.byId("sample").children.find((o) => o.value === "no-id").textContent, "Broken run 3");
  assert.equal(t.line(1).getAttribute("aria-current"), "true");
  assert.ok(!/ttyAMA0/.test(t.byClass("bla-detail")[0].textContent));
  const v = t.byClass("bla-verdict")[0];
  const outside = v.children.filter((c) => !(c.classList && c.classList.contains("bla-reveal"))).map((c) => c.textContent).join(" ");
  assert.ok(!/ttyAMA0|Suspect/.test(outside), outside);
  assert.match(t.byClass("bla-reveal")[0].textContent, /stage 6 \(Driver binding\) is incomplete/);
  t.handle.destroy();
});

test("the filter says what it keeps, the stages are introduced, and the line types have a legend", async () => {
  const t = await setup();
  const label = t.root.findAll((e) => e.tagName === "LABEL" && e.attrs.for === `${t.ctx.id}-only`)[0];
  assert.equal(label.textContent, "Key lines only");
  assert.match(t.root.textContent, /hides housekeeping, explained or not/);
  const intro = t.byClass("bla-intro")[0];
  assert.match(intro.textContent, /Linux boots in eight stages/);
  assert.equal(intro.children.find((c) => c.tagName === "A").getAttribute("href"), "/build-your-own/vmm/primers/linux-boot-sequence/");
  assert.match(t.byClass("bla-legend")[0].textContent, /our machine: a line about something our VMM provides/);
  t.handle.destroy();
});

test("the /chosen node says its seeds are zero only in the dump", async () => {
  const t = await setup();
  const crng = t.byClass("bla-line").find((b) => /random: crng init done/.test(b.textContent));
  crng.dispatch("click");
  assert.match(t.byClass("bla-detail")[0].textContent, /rng-seed and kaslr-seed are zeroed in dumps; the guest received random bytes \(chapter 10\)/);
  t.handle.destroy();
});

test("moving the selection touches only the lines that change", async () => {
  const t = await setup("no-timer.s.61");
  const lines = t.byClass("bla-line");
  let writes = 0;
  for (const b of lines) { const orig = b.setAttribute.bind(b); b.setAttribute = (k, v) => { writes++; orig(k, v); }; }
  t.line(61).dispatch("keydown", { key: "ArrowDown" });
  assert.ok(writes <= 4, `${writes} attribute writes for one move`);
  assert.equal(t.line(61).getAttribute("aria-current"), "false");
  assert.equal(t.line(61).getAttribute("tabindex"), "-1");
  assert.equal(t.line(62).getAttribute("aria-current"), "true");
  assert.equal(t.line(62).getAttribute("tabindex"), "0");
  t.handle.destroy();
});

test("Reset clears the file input so the same file can be opened again", async () => {
  const t = await setup();
  t.byId("file").value = "C:\\fakepath\\boot.txt";
  t.btn("Reset").dispatch("click");
  assert.equal(t.byId("file").value, "");
  t.handle.destroy();
});

test("shipped lab code avoids the builder's banned strings", () => {
  for (const f of ["view.mjs", "model.mjs", "samples.mjs"]) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "localStorage", "fetch("]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
});
