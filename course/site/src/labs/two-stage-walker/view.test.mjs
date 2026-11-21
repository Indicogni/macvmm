// Smoke test for view.mjs with a tiny fake DOM (Node built-ins only, no jsdom). It mounts the
// lab, drives every control the way a reader would, and checks the readout against chapter 05's
// numbers, the share hash round trip, the editor, and that no inline handler attribute is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

class Node_ { constructor(){ this.parent=null; this.children=[]; } }
class Text_ extends Node_ { constructor(t){ super(); this.data=String(t); } get textContent(){return this.data;} }
class El extends Node_ {
  constructor(tag){ super(); this.tagName=tag.toUpperCase(); this.attrs=new Map(); this.listeners={}; this.value=""; this.checked=false; this.disabled=false; this.hidden=false; }
  set className(v){this.attrs.set("class",v);} get className(){return this.attrs.get("class")??"";}
  setAttribute(k,v){ if(k.startsWith("on")) throw new Error("inline handler attr "+k); this.attrs.set(k,String(v)); if(k==="value") this.value=String(v); if(k==="hidden") this.hidden=true; if(k==="disabled") this.disabled=true; if(k==="selected") this.selected=true;}
  getAttribute(k){ return this.attrs.has(k)?this.attrs.get(k):null; } removeAttribute(k){this.attrs.delete(k);}
  set id(v){this.attrs.set("id",v);} get id(){return this.attrs.get("id");}
  get textContent(){ return this.children.map(c=>c.textContent).join(""); }
  set textContent(v){ this.children=[]; if(v!=="") this.append(String(v)); }
  append(...cs){ for(const c of cs){ const n = typeof c==="string"? new Text_(c): c; if(n.parent) n.parent.children=n.parent.children.filter(x=>x!==n); n.parent=this; this.children.push(n);} if(this.tagName==="SELECT") this._syncSel(); }
  _syncSel(){ const s=this.children.find(o=>o.selected)||this.children[0]; if(s) this.value=s.getAttribute("value"); }
  replaceChildren(...cs){ for(const c of this.children) c.parent=null; this.children=[]; this.append(...cs); }
  addEventListener(t,f){ (this.listeners[t] ||= []).push(f); }
  dispatch(t, extra={}){ const ev={type:t, key:extra.key, target:this, currentTarget:this, preventDefault(){}, ...extra}; let n=this; while(n){ ev.currentTarget=n; for(const f of (n.listeners?.[t]??[])) f(ev); n=n.parent; } }
  click(){ if(!this.disabled) this.dispatch("click"); }
  focus(){ globalThis.document.activeElement=this; }
  contains(n){ while(n){ if(n===this) return true; n=n.parent;} return false; }
  closest(sel){ let n=this; while(n){ if(n.tagName===sel.toUpperCase()) return n; n=n.parent;} return null; }
  *walk(){ for(const c of this.children){ if(c instanceof El){ yield c; yield* c.walk(); } } }
  matches(sel){ let m;
    if((m=/^\[data-fkey=["'](.*)["']\]$/.exec(sel))) return this.getAttribute("data-fkey")===m[1];
    if((m=/^#(.*)$/.exec(sel))) return this.id===m[1];
    return this.tagName===sel.toUpperCase(); }
  querySelector(sel){ for(const e of this.walk()) if(e.matches(sel)) return e; return null; }
  querySelectorAll(sel){ return [...this.walk()].filter(e=>e.matches(sel)); }
}
globalThis.document = { createElement:(t)=>new El(t), createTextNode:(t)=>new Text_(t), activeElement:null };
globalThis.CSS = { escape:(s)=>s };
globalThis.window = { isSecureContext:false, location:{href:"x"} };



const { mount } = await import("./view.mjs");

function setup(hash = null) {
  const said = [];
  const box = { hash };
  const el = new El("div");
  const ctx = { name: "two-stage-walker", id: "lab-tsw-1", base: "./", standalone: true, reducedMotion: true, announce: (t) => said.push(t), hash: { get: () => box.hash, set: (s) => (box.hash = s) } };
  const inst = mount(el, ctx);
  const all = () => [...el.walk()];
  const button = (t) => all().find((e) => e.tagName === "BUTTON" && e.textContent === t);
  const summary = () => all().find((e) => e.className === "tsw__summary").textContent;
  const sel = (id, v) => {
    const s = el.querySelector("#lab-tsw-1-" + id);
    s.value = v;
    s.dispatch("change");
  };
  return { el, inst, said, box, all, button, summary, sel };
}

const showAll = (t) => t.button("Show all").click();
// The view throttles announcements to one per 300 ms; wait for the trailing one.
const settle = () => new Promise((r) => setTimeout(r, 320));

test("first render starts at step 0 with a Start here line; Show all gives the captured exit", () => {
  const t = setup();
  assert.match(t.el.textContent, /Start here: press Step/);
  assert.equal(t.summary(), "The result appears here when the walk is complete.");
  assert.ok(t.el.textContent.includes("What you are looking at"));
  showAll(t);
  assert.match(t.summary(), /translation fault, level 2/);
  const text = t.el.textContent;
  assert.ok(text.includes("As the reference VMM prints it: esr=0x93890046 ipa=0xb000000"));
  assert.ok(text.includes("0x000b_0000"), "HPFAR_EL2");
  assert.ok(text.includes("0x4008_52c0"), "level-2 descriptor address");
  const link = t.all().find((e) => e.tagName === "A" && e.getAttribute("href").includes("esr-decoder"));
  assert.equal(link.getAttribute("href"), "/build-your-own/vmm/labs/esr-decoder/#esr-decoder=0x93890046");
  t.inst.destroy();
});

test("Step announces each card with its step count; the summary node is not a live region", async () => {
  const t = setup();
  const sum = t.all().find((e) => e.className === "tsw__summary");
  assert.equal(sum.getAttribute("aria-live"), null);
  await settle();
  t.button("Step").click();
  await settle();
  assert.match(t.said.at(-1), /^Step 1 of 8\. Stage 2 first: the address of the level-1 descriptor, 0x4008_4000, is an IPA/);
  t.button("Step").click();
  await settle();
  assert.match(t.said.at(-1), /Step 2 of 8\. Stage 1, level 1: index 0, read at 0x4008_4000, table descriptor, next table 0x4008_5000\./);
  t.button("Back").click();
  await settle();
  assert.match(t.said.at(-1), /^Step 1 of 8\. Back\./);
  t.inst.destroy();
});

test("Step keeps focus at the end of the walk (aria-disabled, not disabled)", async () => {
  const t = setup();
  const step = t.button("Step");
  step.focus();
  for (let i = 0; i < 10; i++) step.click();
  assert.equal(step.getAttribute("aria-disabled"), "true");
  assert.equal(step.disabled, false);
  assert.equal(globalThis.document.activeElement, step);
  await settle();
  assert.match(t.said.at(-1), /^Step 8 of 8\. Walk complete\. VM exit/);
  const back = t.button("Back");
  assert.equal(back.getAttribute("aria-disabled"), null);
  t.inst.destroy();
});

test("controls drive the model: MMU off, examples, granules, scenarios", () => {
  const t = setup();
  t.sel("mode", "s2");
  const a = t.el.querySelector("#lab-tsw-1-addr");
  a.value = "0x10_0000_0000";
  t.button("Walk").click();
  showAll(t);
  assert.match(t.summary(), /level 0/);
  assert.ok(t.el.textContent.includes("esr=0x93890044 ipa=0x1000000000"));
  a.value = "nope";
  t.button("Walk").click();
  assert.equal(a.getAttribute("aria-invalid"), "true");
  t.sel("mode", "both");
  t.sel("examples", "0x4000_1234");
  showAll(t);
  assert.match(t.summary(), /No exit/);
  t.sel("g1", "16");
  t.sel("g2", "4");
  t.sel("ipa", "40");
  showAll(t);
  assert.match(t.summary(), /No exit/);
  t.sel("scenario", "worked");
  showAll(t);
  assert.match(t.summary(), /PA 0x4123_4567/);
  t.inst.destroy();
});

test("the GIC distributor preset says HVF handles it: no exit, no VMM line", () => {
  const t = setup();
  t.sel("mode", "s2");
  t.sel("examples", "0x0800_0000");
  showAll(t);
  const text = t.el.textContent;
  assert.ok(text.includes("Stage-2 abort handled inside HVF: no VM exit"));
  assert.ok(!text.includes("Stage-2 fault: VM exit"));
  assert.ok(!text.includes("esr=0x93890046 ipa=0x8000000"));
  t.sel("examples", "0x0900_0000");
  showAll(t);
  assert.ok(t.el.textContent.includes("As your chapter-05 VMM prints it"));
  assert.ok(t.el.textContent.includes("Your chapter-05 VMM, with no device model there yet, stops"));
  t.inst.destroy();
});

test("predict mode reveals the stage-2 card with its stage-1 read, so it gives nothing away", async () => {
  const t = setup();
  const p = t.el.querySelector("#lab-tsw-1-predict");
  p.checked = true;
  p.dispatch("change");
  assert.match(t.el.textContent, /Predict: stage 1, level 1/);
  const gi = t.el.querySelector("#lab-tsw-1-guess-idx");
  gi.value = "0";
  t.button("Check").click();
  assert.ok(t.el.textContent.includes("Index 0: matches."));
  await settle();
  t.button("Step").click(); // stage 2 for the table address and the level-1 read, together
  await settle();
  assert.match(t.said.at(-1), /^Step 2 of 8\. Stage 2 first: .* Stage 1, level 1: index 0/);
  assert.match(t.el.textContent, /Predict: stage 1, level 2/);
  t.button("Back").click();
  await settle();
  assert.match(t.said.at(-1), /Back to the start/);
  t.button("Show all").click();
  assert.match(t.summary(), /translation fault, level 2/);
  t.inst.destroy();
});

test("editing a descriptor changes the walk; Undo keeps focus; Escape closes the editor", async () => {
  const t = setup();
  showAll(t);
  const row = t.all().find((e) => e.getAttribute("data-fkey") === "row-1-40086800");
  row.click();
  assert.ok(t.el.querySelector("[data-fkey='editor-first']"));
  t.el.querySelector("[data-fkey='editor-af']").click();
  assert.match(t.summary(), /access flag fault, level 3/);
  await settle();
  assert.match(t.said.at(-1), /access flag fault, level 3/);
  const undo = t.el.querySelector("[data-fkey='editor-undo']");
  undo.focus();
  undo.click();
  assert.match(t.summary(), /translation fault, level 2/);
  const undo2 = t.el.querySelector("[data-fkey='editor-undo']");
  assert.equal(undo2.getAttribute("aria-disabled"), "true");
  assert.equal(globalThis.document.activeElement, undo2, "focus restored to the rebuilt Undo button");
  const hexIn = t.el.querySelector("#lab-tsw-1-desc-hex");
  hexIn.value = "zz";
  t.el.querySelector("[data-fkey='editor-apply']").click();
  assert.equal(t.el.querySelector("#lab-tsw-1-desc-hex").getAttribute("aria-invalid"), "true");
  assert.equal(hexIn.getAttribute("aria-describedby"), "lab-tsw-1-desc-hex-err");
  t.el.querySelector("[data-fkey='editor-af']").dispatch("keydown", { key: "Escape" });
  assert.equal(t.el.querySelector("[data-fkey='editor-first']"), null);
  t.inst.destroy();
});

test("share state is written, and a shared link restores it; a bad link names settings, not keys", () => {
  const t = setup();
  const u = t.el.querySelector("#lab-tsw-1-uart");
  u.checked = true;
  u.dispatch("change");
  t.sel("examples", "0x0b10_1000");
  showAll(t);
  assert.match(t.summary(), /nothing is printed/);
  t.button("Share state").click();
  assert.equal(t.box.hash, "sc=toy;m=both;a=b101000;g1=4;g2=16;ipa=36;acc=w4.9.1;ur=1");
  t.inst.destroy();
  const t2 = setup("sc=toy;m=both;a=b101000;g1=4;g2=16;ipa=36;acc=w4.9.1;ur=1");
  showAll(t2);
  assert.match(t2.summary(), /nothing is printed/);
  t2.inst.destroy();
  const t3 = setup("sc=__proto__;a=zz");
  const note = t3.all().find((e) => e.className === "tsw__note").textContent;
  assert.equal(note, "Some settings in the shared link were not understood and were reset to their defaults: tables, address.");
  showAll(t3);
  assert.match(t3.summary(), /translation fault, level 2/);
  t3.inst.destroy();
});

test("an embed in the page-tables primer starts in bare-metal mode on the worked example", () => {
  globalThis.window.location = { href: "x", pathname: "/build-your-own/vmm/primers/page-tables/" };
  try {
    const said = [];
    const el = new El("div");
    const ctx = { name: "two-stage-walker", id: "lab-tsw-1", base: "./", standalone: false, reducedMotion: false, announce: (x) => said.push(x), hash: { get: () => null, set() {} } };
    const inst = mount(el, ctx);
    assert.equal(el.querySelector("#lab-tsw-1-mode").value, "s1");
    assert.equal(el.querySelector("#lab-tsw-1-scenario").value, "worked");
    inst.destroy();
  } finally {
    globalThis.window.location = { href: "x" };
  }
});

test("map buttons, Auto, Reset, invalid register", () => {
  const t = setup();
  const hole = t.all().find((e) => e.getAttribute("data-fkey") === "map-probe-hole");
  assert.equal(hole.getAttribute("aria-pressed"), null);
  assert.match(hole.textContent, /32 MiB, hole/);
  hole.click();
  t.sel("mode", "s2");
  showAll(t);
  assert.ok(t.el.textContent.includes("esr=0x93890046 ipa=0xc000000"));
  const hit = t.all().find((e) => e.getAttribute("data-fkey") === "map-probe-hole");
  assert.equal(hit.getAttribute("aria-current"), "true");
  assert.match(hit.getAttribute("aria-label"), /the IPA is here/);
  t.button("Auto").click();
  t.button("Pause").click();
  t.button("Reset").click();
  showAll(t);
  assert.match(t.summary(), /translation fault, level 2/);
  t.sel("rt", "99");
  assert.equal(t.el.querySelector("#lab-tsw-1-rt").getAttribute("aria-invalid"), "true");
  assert.ok(t.el.textContent.includes("Use a register number from 0 to 30."));
  t.inst.destroy();
});

test("shipped code avoids innerHTML, eval and remote URLs", () => {
  for (const f of ["view.mjs", "model.mjs", "style.css", "fallback.svg", "lab.json"]) {
    const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /innerHTML\s*=|eval\(|new Function|https?:\/\//, f);
  }
});
