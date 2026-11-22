// Tests for the toy-vmm model. Run: node --test 'course/site/**/*.test.mjs'
//
// The lesson (course/chapters/0/00-orientation.md) lists the toy guest and quotes counts from
// it; these tests parse that listing and pin every count, so the lab, lab.json and the lesson
// cannot drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lessonPath = join(here, "..", "..", "..", "..", "chapters", "0", "00-orientation.md");
const lesson = readFileSync(lessonPath, "utf8");
const labJson = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));

const end = (mode, opts) => M.runToEnd(M.createState(mode, opts));

/** The lesson's listing: rows {region, addr, text, mark}. */
function lessonListing() {
  const start = lesson.indexOf("addr  instruction");
  assert.ok(start > 0, "the lesson's listing was not found");
  const block = lesson.slice(start, lesson.indexOf("```", start));
  const rows = [];
  let region = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("--- toy kernel")) region = "kernel";
    else if (line.startsWith("--- toy app")) region = "app";
    // Fixed columns: address at 0, instruction from 6, mark at 28, note from 33.
    const m = /^([0-9A-F]{2}) {4}/.exec(line);
    if (m && region) {
      rows.push({ region, addr: parseInt(m[1], 16), text: line.slice(6, 28).replace(/\s+/g, " ").trim(), mark: line.slice(28, 33).trim() });
    }
  }
  return rows;
}

test("the guest image is the lesson's listing, line for line", () => {
  const ours = M.guestImage("A").map((r) => ({ region: r.region, addr: r.addr, text: r.text, mark: r.mark }));
  assert.deepEqual(ours, lessonListing());
});

test("mode G's guest differs only at kernel line 02, which is a hypercall", () => {
  const a = M.guestImage("A");
  const g = M.guestImage("G");
  const diff = g.filter((r, k) => r.text !== a[k].text);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].region, "kernel");
  assert.equal(diff[0].addr, 0x02);
  assert.equal(diff[0].text, "HCALL 0");
});

test("eleven instructions plus HCALL; GETMODE is sensitive but not privileged", () => {
  assert.deepEqual([...M.PRIVILEGED].sort(), ["CLI", "IRET", "SETBASE", "STI"]);
  assert.ok(!M.PRIVILEGED.has("GETMODE"));
});

test("mode A prints the reference 123 after 23 instructions, reaches its spin loop after 27, then spins to the budget", () => {
  const s = end("A");
  assert.equal(M.reference(), "123");
  assert.equal(s.console, "123");
  assert.equal(M.outputCompleteAt(M.createState("A")), 23);
  assert.equal(M.runSteps(M.createState("A"), 22).console, "12");
  assert.equal(M.runSteps(M.createState("A"), 23).console, "123");
  assert.equal(s.spinAt, 27);
  assert.equal(s.n.steps, M.BUDGET);
  assert.equal(s.n.native, 1000);
  assert.equal(M.interventions(s.n), 0);
});

test("mode B stops at the first privileged instruction, SETBASE, killed", () => {
  const s = end("B");
  assert.equal(s.halted.kind, "killed");
  assert.equal(s.n.steps, 0);
  assert.equal(s.trace.length, 1);
  assert.equal(s.trace[0].text, "SETBASE 0x20, 0x1F");
  assert.equal(s.trace[0].who, "host OS");
  assert.match(s.halted.text, /SIGILL/);
  assert.match(s.halted.text, /first problem in chapter 00's ledger/);
  assert.doesNotMatch(s.halted.text, /Ledger row/);
  assert.equal(s.console, "");
});

test("mode C interprets all 1,000 instructions and prints the reference", () => {
  const s = end("C");
  assert.equal(s.console, "123");
  assert.equal(s.n.interpret, 1000);
  assert.equal(s.n.native, 0);
  assert.ok(s.trace.every((r) => r.who === "VMM"));
});

test("mode D: 13 interventions (4 to start, then 3 per character), 987 run unseen", () => {
  const s = end("D");
  assert.equal(s.console, "123");
  assert.equal(s.n.trap, 13);
  assert.equal(M.interventions(s.n), 13);
  assert.equal(s.n.native, 987);
  // The four starting traps are kernel lines 00, 01, 02 and 08.
  const vmm = s.trace.filter((r) => r.who === "VMM");
  assert.deepEqual(vmm.slice(0, 4).map((r) => `${r.region} ${r.addr}`), ["kernel 0", "kernel 1", "kernel 2", "kernel 8"]);
  // Then SYSCALL, the store, IRET, three times.
  assert.deepEqual(
    vmm.slice(4).map((r) => r.text),
    ["SYSCALL", "ST r0, [0xF0]", "IRET r3", "SYSCALL", "ST r0, [0xF0]", "IRET r3", "SYSCALL", "ST r0, [0xF0]", "IRET r3"],
  );
});

test("mode D: shadowing in one line, the real base is the guest's 0x20 plus the VMM's 0x40", () => {
  let s = M.createState("D");
  while (!(s.v.mode === "user")) s = M.step(s);
  assert.equal(s.v.base, 0x20);
  assert.equal(s.cpu.base, 0x60);
  assert.equal(s.cpu.priv, "user");
});

test("mode E: SETBASE and STI trap, GETMODE runs natively and reads user, the guest panics with !", () => {
  const s = end("E");
  assert.equal(s.console, "!");
  assert.equal(s.panicked, true);
  assert.equal(M.interventions(s.n), 3);
  const t = s.trace;
  assert.equal(t[2].text, "GETMODE r1");
  assert.equal(t[2].who, "CPU");
  // The trap counter stays at two across GETMODE.
  const trapsBefore = (k) => t.slice(0, k).filter((r) => r.who === "VMM").length;
  assert.equal(trapsBefore(2), 2);
  assert.equal(trapsBefore(3), 2);
  assert.equal(t[5].text, "ST r0, [0xF0]");
  assert.equal(t[5].who, "VMM");
  assert.equal(s.spinAt, 6);
});

test("mode E with GETMODE made privileged behaves exactly as mode D", () => {
  const e = end("E", { getmodePrivileged: true });
  const d = end("D");
  assert.equal(e.console, d.console);
  assert.deepEqual(e.n, d.n);
});

test("mode F: three kernel blocks translated once each, GETMODE rewritten into a call, app code untranslated", () => {
  const s = end("F");
  assert.equal(s.console, "123");
  assert.equal(s.n.translate, 3);
  assert.equal(s.n.trap, 12);
  assert.equal(s.n.callout, 1);
  assert.equal(M.interventions(s.n), 16);
  assert.deepEqual(
    s.tcache.blocks.map((b) => [b.start, b.end, b.rewrites]),
    [
      [0x00, 0x03, 1],
      [0x07, 0x08, 0],
      [0x10, 0x11, 0],
    ],
  );
  const getmode = s.trace.find((r) => r.text === "GETMODE r1");
  assert.equal(getmode.who, "VMM");
  assert.equal(getmode.kind, "callout");
  assert.match(getmode.what, /call into the VMM/);
  assert.doesNotMatch(getmode.what, /into a trap/);
});

test("mode G: twelve traps and one hypercall, reference output", () => {
  const s = end("G");
  assert.equal(s.console, "123");
  assert.equal(s.n.trap, 12);
  assert.equal(s.n.hypercall, 1);
  assert.equal(s.trace[2].text, "HCALL 0");
  assert.equal(s.cpu.r[1] !== undefined, true);
});

test("the saved return address after HCALL and SYSCALL is the next instruction, as for Arm's hvc and svc", () => {
  const g = M.runSteps(M.createState("G"), 3);
  assert.equal(g.trace[2].text, "HCALL 0");
  assert.equal(g.lastTrap.saved, 0x03);
  assert.equal(g.cpu.pc, 0x03);
  // The first SYSCALL (app 03) saves app 04.
  let d = M.createState("D");
  while (!(d.lastTrap && /SYSCALL/.test(d.lastTrap.reason))) d = M.step(d);
  assert.equal(d.lastTrap.saved, 0x04);
  // A trapped privileged instruction saves the instruction itself, to be emulated.
  assert.equal(M.step(M.createState("D")).lastTrap.saved, 0x00);
});

test("mode H: 3 interventions by default (the three prints); the interrupt switch runs natively", () => {
  assert.equal(M.DEFAULT_OPTS.trapIE, false);
  const s = end("H");
  assert.equal(s.console, "123");
  assert.equal(M.interventions(s.n), 3);
  assert.equal(s.trace.find((r) => r.text === "GETMODE r1").who, "CPU");
  assert.equal(s.trace.find((r) => r.text.startsWith("SETBASE")).who, "CPU");
  const sti = s.trace.find((r) => r.text === "STI");
  assert.equal(sti.who, "CPU");
  assert.match(sti.what, /virtual interrupt mask/);
  assert.equal(s.cpu.ie, 1);
});

test("mode H: trapping base writes or the interrupt switch too adds one each; dropping the console empties it", () => {
  const b = end("H", { trapBase: true });
  assert.equal(b.console, "123");
  assert.equal(M.interventions(b.n), 4);
  const i = end("H", { trapIE: true });
  assert.equal(i.console, "123");
  assert.equal(M.interventions(i.n), 4);
  assert.match(i.trace.find((r) => r.text === "STI").what, /Real hardware is not asked to do this/);
  const c = end("H", { trapConsole: false });
  assert.equal(c.console, "");
  assert.equal(M.interventions(c.n), 0);
  assert.equal(M.interventions(end("H", { trapIE: true, trapConsole: false }).n), 1);
});

test("mode H without the console trap: the VMM mapped plain memory there, so stores persist and loads read them back", () => {
  const c = end("H", { trapConsole: false });
  // The last character stored at 0xF0 is "3" (0x33); the guest's own memory is untouched.
  assert.equal(c.v.consoleRam[0], 0x33);
  assert.match(c.trace.find((r) => r.text === "ST r0, [0xF0]").what, /mapped plain memory/);
  // A load from the console range reads the stored value back.
  const s0 = M.createState("H", { trapConsole: false });
  const mem = s0.mem.slice();
  mem[M.VMM_BASE + 0x10] = Object.freeze({ op: "ST", rs: 0, addr: 0xf0 });
  mem[M.VMM_BASE + 0x11] = Object.freeze({ op: "LD", rd: 2, addr: 0xf0 });
  let s = { ...s0, mem: Object.freeze(mem), cpu: Object.freeze({ ...s0.cpu, pc: 0x10, r: Object.freeze([65, 0, 0, 0]) }) };
  s = M.runSteps(s, 2);
  assert.equal(s.cpu.r[2], 65);
  assert.equal(s.console, "");
  assert.equal(M.interventions(s.n), 0);
});

test("modes D to G: a privileged instruction from the guest app is not carried out", () => {
  const s0 = M.createState("D");
  const mem = s0.mem.slice();
  mem[M.VMM_BASE + 0x20] = Object.freeze({ op: "STI" }); // app 00
  let s = { ...s0, mem: Object.freeze(mem) };
  while (!(s.v.mode === "user") && !M.isDone(s)) s = M.step(s);
  const ieBefore = s.v.ie;
  s = M.step(s);
  assert.equal(s.halted.kind, "fault");
  assert.match(s.halted.text, /reflects this to the guest kernel/);
  assert.equal(s.v.ie, ieBefore);
});

test("mode B: SYSCALL is not called privileged; HCALL is an illegal instruction", () => {
  const b0 = M.createState("B");
  const withAt0 = (op) => {
    const mem = b0.mem.slice();
    mem[M.VMM_BASE] = Object.freeze(op);
    return M.step({ ...b0, mem: Object.freeze(mem) });
  };
  const sys = withAt0({ op: "SYSCALL" });
  assert.match(sys.halted.text, /asks the host kernel/);
  assert.doesNotMatch(sys.halted.text, /privileged/);
  const hc = withAt0({ op: "HCALL", n: 0 });
  assert.equal(hc.halted.kind, "killed");
  assert.match(hc.halted.text, /there is none/);
  assert.doesNotMatch(hc.halted.text, /privileged/);
});

test("modes A, C, D (fixed), F, G and H print the reference; B and E do not", () => {
  for (const m of ["A", "C", "D", "F", "G", "H"]) assert.equal(M.summary(end(m)).matches, true, m);
  for (const m of ["B", "E"]) assert.equal(M.summary(end(m)).matches, false, m);
});

test("lab.json holds exactly the counts the model computes (the lesson quotes them from there)", () => {
  assert.deepEqual(labJson.counts, M.canonicalCounts());
  assert.equal(typeof labJson.title, "string");
  assert.equal(typeof labJson.goal, "string");
});

test("the lesson's quoted numbers agree with the model", () => {
  const c = M.canonicalCounts();
  assert.match(lesson, /prints `123`, the reference, after 23 instructions; after 27 the app reaches its spin loop/);
  assert.equal(c.referenceAt, 23);
  assert.equal(c.spinAt, 27);
  assert.match(lesson, /13 in all\. The other 987 run unseen/);
  assert.equal(c.modes.D.interventions, 13);
  assert.equal(c.modes.D.native, 987);
  assert.match(lesson, /the count stays at two/);
  assert.equal(c.modes.E.interventions, 3);
  assert.match(lesson, /The VMM chooses what traps: here, only the console range/);
  assert.equal(c.modes.H.interventions, 3);
  assert.equal(c.modes.H.traps, 3);
});

test("the toy cost model: 1 ns native, 1 µs per intervention", () => {
  assert.equal(M.toyTimeNs(end("D").n), 13_987);
  assert.equal(M.formatTime(13_987), "13.987 µs");
  assert.equal(M.formatTime(1_000_000), "1 ms");
  assert.equal(M.formatTime(0), "0 ns");
});

test("step never mutates its argument and is deterministic", () => {
  const s0 = M.createState("D");
  const snapshot = JSON.stringify(s0);
  const a = M.runSteps(s0, 50);
  const b = M.runSteps(s0, 50);
  assert.equal(JSON.stringify(s0), snapshot);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.cpu));
  // Stepping one at a time equals running in one go.
  let c = s0;
  for (let k = 0; k < 50; k++) c = M.step(c);
  assert.equal(JSON.stringify(c), JSON.stringify(a));
});

test("a finished run does not step further", () => {
  const s = end("B");
  assert.equal(M.step(s), s);
  assert.equal(M.runSteps(s, 10), s);
  const a = end("A");
  assert.equal(M.step(a), a);
});

test("share state round-trips exactly and rejects malformed or non-canonical strings", () => {
  const cases = ["A", "D@13", "E-", "E-p", "H-c", "H-ic", "H-bic@27", "H-", "C@1000", "F@999"];
  for (const str of cases) {
    const s = M.stateFromShare(str);
    assert.ok(s, str);
    assert.equal(M.formatShare(s), str);
  }
  // parseShare(formatShare(x)) gives back x's mode, options and position.
  for (const m of M.MODES) {
    for (const opts of [undefined, { getmodePrivileged: true }, { trapBase: true, trapIE: true, trapConsole: false }]) {
      const x = M.runSteps(M.createState(m, opts), 7);
      const p = M.parseShare(M.formatShare(x));
      assert.equal(p.mode, x.mode);
      assert.deepEqual(p.opts, x.opts);
      assert.equal(p.steps, x.n.steps);
    }
  }
  // A step count past where the run stops is clamped explicitly: mode B halts before its first
  // instruction completes, so "B@5" is the state "B" (the view then rewrites the hash).
  assert.equal(M.formatShare(M.stateFromShare("B@5")), "B");
  assert.equal(M.parseShare("D@99999"), null);
  assert.equal(M.parseShare("D@1000").steps, 1000);
  assert.equal(M.parseShare("E-@5000"), null);
  assert.equal(M.parseShare("D@1001"), null);
  const bad = [null, "", "Z", "a", "H-icc", "H-x", "D@", "D@-1", "E-p-p", "<img>", "H-ic@1@2", "x".repeat(40)];
  // Non-canonical forms: flags on modes without options, missing flag groups, wrong flag
  // order, flags of the wrong mode, leading zeros, an explicit @0.
  bad.push("A-bic", "D-p", "D-", "E", "H", "H-ci", "H-cb", "E-b", "H-p", "D@0027", "D@0", "B@05", "E-pp");
  for (const b of bad) assert.equal(M.parseShare(b), null, String(b));
  // Mode D always has GETMODE privileged, whatever the flags say.
  assert.equal(M.parseShare("D").opts.getmodePrivileged, true);
});

test("createState rejects an unknown mode", () => {
  assert.throws(() => M.createState("Z"), RangeError);
});

test("describe gives one plain-text summary", () => {
  assert.equal(
    M.describe(end("D")),
    "Mode D, trap-and-emulate: 1,000 guest instructions run, 987 natively by the CPU, 13 VMM interventions (13 traps). Console: 123 (matches bare metal). Toy-model time 13.987 µs.",
  );
});

test("fallback.svg shows the model's counts and is safe to inline", () => {
  const svg = readFileSync(join(here, "fallback.svg"), "utf8");
  assert.match(svg, /<title[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc[^>]*>[^<]+<\/desc>/);
  assert.doesNotMatch(svg, /<script|<foreignObject|\son[a-z]+=|href=|url\(/i);
  const c = M.canonicalCounts();
  for (const m of M.MODES) {
    const n = c.modes[m].interventions.toLocaleString("en-US");
    assert.ok(svg.includes(`Mode ${m}, ${M.MODE_INFO[m].name}: ${n} interventions`), `mode ${m} row`);
  }
});
