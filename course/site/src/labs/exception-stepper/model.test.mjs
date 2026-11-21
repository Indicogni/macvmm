// node --test course/site/src/labs/exception-stepper/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  MACHINE, CAUSES, plan, initialState, step, rows, summary, notes, esrFields, makeEsr,
  dataAbortIss, vectorOffset, encodeHash, decodeHash, hex, hexPad, plainPstate,
} from "./model.mjs";
import { decodePstate, encodePstate, describePstate } from "./pstate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");
const vectorsPath = join(here, "..", "..", "..", "labs", "vectors", "esr.json");

const take = (s) => step(s, { type: "take" });
const eret = (s) => step(s, { type: "eret" });
const row = (s, key) => rows(s).find((r) => r.key === key);

// --- The lesson's paper fallback (chapter 02, "Watch an app call its kernel") ---------------

test("svc from EL0 reproduces the lesson fallback", () => {
  let s = initialState({ src: 0, cause: "svc" });
  assert.equal(s.cpu.pc, 0x1000);
  assert.equal(row(s, "mode").now, "EL0");
  for (const k of ["elr", "spsr", "esr", "far"]) assert.equal(row(s, k).now, "?");
  s = take(s);
  assert.equal(s.cpu.pc, 0x8400); // table + 0x400
  assert.equal(row(s, "pc").detail, "table + 0x400");
  assert.equal(row(s, "mode").now, "EL1");
  assert.equal(row(s, "elr").now, "0x1004"); // after the svc
  assert.equal(row(s, "spsr").now, "EL0 and its flags");
  assert.equal(row(s, "esr").now, "svc, number 0");
  assert.equal(row(s, "far").now, "?");
  assert.equal(row(s, "far").detail, "not a fault");
  assert.equal(s.regs[1].esr, 0x56000000);
  s = eret(s);
  assert.equal(s.cpu.pc, 0x1004);
  assert.equal(row(s, "mode").now, "EL0");
  assert.equal(s.cpu.pstate, MACHINE.appPstate);
});

test("data abort from EL0 reproduces the lesson fallback", () => {
  let s = take(initialState({ src: 0, cause: "dabt" }));
  assert.equal(s.cpu.pc, 0x8400);
  assert.equal(row(s, "mode").now, "EL1");
  assert.equal(row(s, "elr").now, "0x1000"); // the load itself
  assert.equal(row(s, "spsr").now, "EL0 and its flags");
  assert.match(row(s, "esr").now, /^data abort/);
  assert.equal(row(s, "far").now, hex(MACHINE.unmappedVa));
  assert.equal(row(s, "far").detail, "the address the load used");
  s = eret(s);
  assert.equal(s.cpu.pc, 0x1000);
  assert.ok(notes(s).some((n) => n.includes("faults again")));
});

test("machine constants are the ones the lesson quotes", () => {
  assert.equal(MACHINE.appPc, 0x1000);
  assert.equal(MACHINE.vbarEl1, 0x8000);
});

// --- Matches real captures ---------------------------------------------------------------

test("hvc from EL1 gives the syndrome captured by chapter 02's first run", () => {
  const p = plan({ src: 1, cause: "hvc" });
  assert.equal(p.target, 2);
  assert.equal(p.esr, 0x5a000000);
  assert.equal(p.elr, p.pc + 4);
  const cap = join(repo, "course", "captures", "02-first-exit.txt");
  if (!existsSync(cap)) return assert.ok(true, "capture missing; skipped");
  const text = readFileSync(cap, "utf8");
  const m = text.match(/syndrome=(0x[0-9a-f]+) ec=(0x[0-9a-f]+)/);
  assert.ok(m, "capture has a syndrome line");
  assert.equal(hex(p.esr), m[1]);
  assert.equal(hex(esrFields(p.esr).ec), m[2]);
  // pc=0x40000008 after an hvc at 0x40000004: the PC is already past the call.
  const pcm = text.match(/pc=(0x[0-9a-f]+)/);
  assert.equal(Number(pcm[1]) - 0x40000004, 4);
});

test("data abort at EL1 uses the same encoding shape as the captured self-fault ESR_EL1", () => {
  const p = plan({ src: 1, cause: "dabt" });
  assert.equal(p.target, 1);
  assert.equal(p.offset, 0x200); // the lesson: a synchronous exception at EL1 lands at VBAR_EL1 + 0x200
  assert.equal(p.esr, 0x96000007);
  // chapter 06 captured ESR_EL1=0x96000021: EC 0x25, IL 1, ISV 0; only the fault code differs.
  assert.equal(esrFields(0x96000021).ec, esrFields(p.esr).ec);
  assert.equal(esrFields(0x96000021).isv, false);
});

// --- Cross-check the ESR encoder/decoder with the Rust reference's vectors ----------------

test("esrFields agrees with course/site/labs/vectors/esr.json", (t) => {
  if (!existsSync(vectorsPath)) return t.skip("vectors/esr.json not exported yet");
  const doc = JSON.parse(readFileSync(vectorsPath, "utf8"));
  let checked = 0;
  for (const v of doc.vectors) {
    if (v.reason !== "exception") continue;
    // ESR_EL2 is 64 bits; bits 63..32 (ISS2 and friends) are not modelled by this lab.
    const esr = Number(BigInt(v.esr) & 0xffffffffn);
    const f = esrFields(esr);
    if (v.exit === "Hvc" || v.exit === "Smc") {
      assert.equal(f.imm16, v.fields.imm, v.name);
      assert.equal(f.ec, v.exit === "Hvc" ? 0x16 : 0x17, v.name);
      checked++;
    } else if (v.exit === "DataAbort") {
      for (const k of ["isv", "wnr", "dfsc"]) assert.equal(f[k], v.fields[k], `${v.name}: ${k}`);
      if (v.fields.isv) for (const k of ["sas", "sse", "srt", "sf", "ar"]) assert.equal(f[k], v.fields[k], `${v.name}: ${k}`);
      // and the encoder rebuilds the fields it models (ISV..AR, WnR, DFSC)
      const modelled = 0x01ffc000 | 0x40 | 0x3f;
      const want = v.fields.isv ? f.iss & modelled : f.iss & (0x40 | 0x3f);
      assert.equal(dataAbortIss(v.fields), want, `${v.name}: encoder`);
      checked++;
    } else if (v.fields && typeof v.fields.ec === "number") {
      assert.equal(f.ec, v.fields.ec, v.name);
      checked++;
    }
  }
  assert.ok(checked >= 5, `checked ${checked} vectors`);
  // the vector "svc #0x4d (EC 0x15, taken at EL1)" uses the same encoding as our svc #0
  assert.equal(makeEsr({ ec: 0x15, iss: 0x4d }), 0x5600004d);
  // "guest ESR_EL2 at vEL2: unknown reason" is our hvc-at-EL0 syndrome
  assert.equal(plan({ src: 0, cause: "hvc" }).esr, 0x2000000);
  assert.equal(hexPad(0x2000000, 8), "0x02000000");
  // "str x1 to the PL011" 0x93c18046 differs from our stage-2 load only in WnR (bit 6).
  assert.equal(plan({ src: 1, cause: "dabt2" }).esr, (0x93c18046 & ~0x40) >>> 0);
});

// --- The rule table ------------------------------------------------------------------------

test("vector offsets", () => {
  assert.equal(vectorOffset({ from: 0, to: 1, ownSp: false, async: false }), 0x400);
  assert.equal(vectorOffset({ from: 0, to: 1, ownSp: false, async: true }), 0x480);
  assert.equal(vectorOffset({ from: 1, to: 1, ownSp: true, async: false }), 0x200);
  assert.equal(vectorOffset({ from: 1, to: 1, ownSp: true, async: true }), 0x280);
  assert.equal(vectorOffset({ from: 1, to: 1, ownSp: false, async: false }), 0x000);
  assert.equal(vectorOffset({ from: 1, to: 2, ownSp: true, async: false }), 0x400);
  assert.throws(() => vectorOffset({ from: 2, to: 1, ownSp: true, async: false }));
});

test("every configuration: target, offset, return rule", () => {
  const expect = {
    "0 svc": [1, 0x400, 4], "1 svc": [1, 0x200, 4],
    "0 hvc": [1, 0x400, 0], "1 hvc": [2, 0x400, 4],
    "0 dabt": [1, 0x400, 0], "1 dabt": [1, 0x200, 0],
    "0 dabt2": [2, 0x400, 0], "1 dabt2": [2, 0x400, 0],
    "0 irq": [1, 0x480, 0], "1 irq": [1, 0x280, 0],
  };
  for (const src of [0, 1]) for (const cause of CAUSES) {
    const p = plan({ src, cause });
    const [target, offset, delta] = expect[`${src} ${cause}`];
    assert.equal(p.target, target, `${src} ${cause} target`);
    assert.equal(p.offset, offset, `${src} ${cause} offset`);
    assert.equal(p.elr - p.pc, delta, `${src} ${cause} return`);
    // entry masks DAIF and selects ELxh; the condition flags (the app's Z) carry over
    const flags = src === 0 ? 0x40000000 : 0;
    assert.equal(p.newPstate, ((target === 1 ? 0x3c5 : 0x3c9) | flags) >>> 0, `${src} ${cause} new PSTATE`);
    if (target === 1) assert.equal(p.vectorPc, MACHINE.vbarEl1 + offset);
    else assert.equal(p.vectorPc, `VBAR_EL2 + ${hex(offset)}`);
  }
});

test("IRQ routed to EL2 lands at VBAR_EL2 + 0x480, from either level", () => {
  for (const src of [0, 1]) {
    const p = plan({ src, cause: "irq", irqTo: 2 });
    assert.equal(p.target, 2);
    assert.equal(p.offset, 0x480);
    assert.equal(p.esr, undefined);
  }
});

test("masked IRQ at EL1 stays pending; the mask does not stop an IRQ aimed at EL2", () => {
  let s = take(initialState({ src: 1, cause: "irq", masked: true }));
  assert.equal(s.phase, "pending");
  assert.equal(s.cpu.pc, MACHINE.kernelPc);
  assert.equal(s.cpu.pstate, 0x85);
  assert.match(summary(s), /waits/);
  assert.equal(eret(s), s);
  s = take(initialState({ src: 1, cause: "irq", masked: true, irqTo: 2 }));
  assert.equal(s.phase, "taken");
  assert.equal(s.regs[2].spsr, 0x85);
});

test("an IRQ writes no syndrome and no fault address", () => {
  const s = take(initialState({ src: 0, cause: "irq" }));
  assert.equal(s.regs[1].esr, null);
  assert.equal(s.regs[1].far, null);
  assert.equal(row(s, "esr").now, "?");
  assert.match(row(s, "esr").detail, /^not written/);
  assert.equal(row(s, "elr").now, "0x1000");
});

test("registers persist: ERET does not clear them, and the other level's set is untouched", () => {
  let s = eret(take(initialState({ src: 1, cause: "hvc" })));
  assert.equal(s.cpu.pc, MACHINE.kernelPc + 4);
  assert.equal(s.cpu.pstate, MACHINE.kernelPstate);
  assert.equal(s.regs[2].esr, 0x5a000000);
  assert.deepEqual(s.regs[1], { elr: null, spsr: null, esr: null, far: null });
});

test("state transitions are guarded", () => {
  const s0 = initialState();
  assert.equal(eret(s0), s0, "no ERET before an exception");
  const s1 = take(s0);
  assert.equal(take(s1), s1, "one exception per run");
  const s2 = eret(s1);
  assert.equal(eret(s2), s2);
  assert.equal(step(s2, { type: "reset" }).phase, "before");
  assert.equal(step(s2, { type: "bogus" }), s2);
  assert.equal(step(s2, null), s2);
  assert.equal(step(s0, { type: "setSource", el: 2 }), s0, "EL2 is not a source here");
  assert.equal(step(s0, { type: "setCause", cause: "smc" }), s0);
});

test("changed markers follow the last step", () => {
  let s = initialState({ src: 0, cause: "svc" });
  assert.ok(rows(s).every((r) => r.changed === false));
  s = take(s);
  const changed = rows(s).filter((r) => r.changed).map((r) => r.key);
  assert.deepEqual(changed, ["mode", "pc", "elr", "spsr", "esr"]);
  s = eret(s);
  assert.deepEqual(rows(s).filter((r) => r.changed).map((r) => r.key), ["mode", "pc"]);
});

test("register names follow the receiving level", () => {
  assert.equal(row(initialState({ src: 0, cause: "svc" }), "elr").reg, "ELR_EL1");
  assert.equal(row(initialState({ src: 1, cause: "hvc" }), "esr").reg, "ESR_EL2");
  assert.equal(row(initialState({ src: 0, cause: "hvc" }), "esr").reg, "ESR_EL1");
});

// --- PSTATE helpers shared with pstate-builder ------------------------------------------------

test("PSTATE decode matches chapter 02's 0x3c5 field table", () => {
  const d = decodePstate(0x3c5);
  assert.equal(d.ok, true);
  assert.equal(d.mode, "EL1h");
  assert.deepEqual(d.daif, { D: true, A: true, I: true, F: true });
  assert.equal(encodePstate({ el: 1, ownSp: true, daif: { D: true, A: true, I: true, F: true } }), 0x3c5);
  assert.equal(decodePstate(0x3c4).mode, "EL1t");
  assert.equal(decodePstate(0x3c9).mode, "EL2h");
  assert.equal(describePstate(MACHINE.appPstate), "EL0t, flags Z, nothing masked");
  assert.equal(decodePstate(0x10).ok, false);
  assert.equal(decodePstate(0x1).ok, false);
  assert.equal(decodePstate(0x2).ok, false);
  assert.equal(decodePstate(0x400).ok, false);
  assert.equal(decodePstate(-1).ok, false);
  assert.throws(() => encodePstate({ el: 0, ownSp: true }));
  assert.throws(() => encodePstate({ el: 4 }));
});

// --- Share state -----------------------------------------------------------------------

test("hash round-trips every state and rejects junk", () => {
  for (const src of [0, 1]) for (const cause of CAUSES) for (const irqTo of [1, 2]) for (const masked of [false, true]) {
    let s = initialState({ src, cause, irqTo, masked, names: masked });
    for (let i = 0; i < 3; i++) {
      const back = decodeHash(encodeHash(s));
      assert.deepEqual(back, s, encodeHash(s));
      s = i === 0 ? take(s) : eret(s);
    }
  }
  assert.deepEqual(decodeHash(null), initialState());
  assert.deepEqual(decodeHash("s9-c<img>-p7"), initialState());
  assert.deepEqual(decodeHash("x".repeat(1000)), initialState());
  assert.equal(encodeHash(take(initialState({ src: 1, cause: "hvc" }))), "s1-chvc-r1-m0-p1-n0");
});

test("summary sentences are plain text", () => {
  let s = initialState();
  assert.equal(summary(s), "The app at EL0 is about to run svc #0 at 0x1000. Step to take the exception.");
  s = take(s);
  assert.equal(summary(s), "A synchronous exception, taken to EL1. PC is now 0x8400; saved return address 0x1004 (after the svc: a call continues).");
  s = eret(s);
  assert.equal(summary(s), "ERET: back to EL0 at 0x1004, the saved return address.");
});

// --- Review fixes ------------------------------------------------------------------------

test("exception entry keeps NZCV: svc from the app gives 0x400003c5, ERET restores 0x40000000", () => {
  let s = take(initialState({ src: 0, cause: "svc", names: true }));
  assert.equal(s.cpu.pstate, 0x400003c5);
  assert.equal(row(s, "mode").detail, "EL1h, flags Z, D A I F masked  (PSTATE 0x400003c5)");
  assert.ok(notes(s).some((n) => n.includes("carried over")));
  s = eret(s);
  assert.equal(s.cpu.pstate, 0x40000000);
});

test("names off: no Arm jargon or raw hex in details and notes", () => {
  const jargon = /PSTATE|VBAR|ESR|SPSR|HPFAR|hv_vcpu_run|syndrome|EL[0-2][ht]\b|D A I F|SP_EL|class 0x/;
  for (const src of [0, 1]) for (const cause of CAUSES) for (const irqTo of [1, 2]) for (const masked of [false, true]) {
    let s = initialState({ src, cause, irqTo, masked });
    for (let i = 0; i < 3; i++) {
      for (const r of rows(s)) {
        assert.doesNotMatch(r.detail, jargon, `${encodeHash(s)} ${r.key}: ${r.detail}`);
        assert.doesNotMatch(r.now, jargon, `${encodeHash(s)} ${r.key}: ${r.now}`);
      }
      for (const n of notes(s)) assert.doesNotMatch(n, jargon, `${encodeHash(s)}: ${n}`);
      assert.doesNotMatch(summary(s), jargon, encodeHash(s));
      s = i === 0 ? take(s) : eret(s);
    }
  }
  assert.equal(plainPstate(0x3c5), "EL1, interrupts and other exceptions switched off");
  assert.equal(plainPstate(0x85), "EL1, interrupts switched off");
  assert.equal(plainPstate(MACHINE.appPstate), "EL0, interrupts allowed, a result flag from earlier arithmetic set");
});

test("names on: ESR shown as 8 hex digits with a 2-digit class", () => {
  const s = take(initialState({ src: 0, cause: "hvc", names: true }));
  assert.equal(row(s, "esr").detail, "0x02000000: class 0x00 in bits 31..26 (unknown reason)");
  const t = take(initialState({ src: 1, cause: "hvc", names: true }));
  assert.ok(notes(t).some((n) => n.startsWith("Sitting B of this chapter") && n.includes("0x5a000000")));
});

test("an IRQ to EL2 does not claim a syndrome; synchronous causes do", () => {
  const irq = notes(take(initialState({ src: 0, cause: "irq", irqTo: 2, names: true })));
  assert.ok(irq.some((n) => n.includes("an interrupt brings no syndrome")));
  assert.ok(!irq.some((n) => n.includes("with the syndrome")));
  const hvc = notes(take(initialState({ src: 1, cause: "hvc", names: true })));
  assert.ok(hvc.some((n) => n.includes("with the syndrome")));
});

test("dabt2 explains that VA equals IPA here", () => {
  const n = notes(take(initialState({ src: 0, cause: "dabt2", names: true })));
  assert.ok(n.some((x) => x.includes("HPFAR_EL2") && x.includes("virtual address")));
});

test("unticking the mask while the IRQ is pending takes it at once", () => {
  let s = take(initialState({ src: 1, cause: "irq", masked: true }));
  assert.equal(s.phase, "pending");
  s = step(s, { type: "setMasked", on: false });
  assert.equal(s.phase, "taken");
  assert.equal(s.masked, false);
  assert.equal(s.cpu.pc, MACHINE.vbarEl1 + 0x280);
  assert.equal(s.regs[1].elr, MACHINE.kernelPc);
  assert.equal(s.regs[1].spsr, MACHINE.kernelPstate);
  assert.deepEqual(decodeHash(encodeHash(s)), s);
  // ticking it from "before" just reconfigures
  assert.equal(step(initialState({ src: 1, cause: "irq" }), { type: "setMasked", on: true }).phase, "before");
});

test("the mask applies only to an IRQ at EL1 (where its control is shown)", () => {
  const s = step(initialState({ src: 1, cause: "irq", masked: true }), { type: "setCause", cause: "svc" });
  assert.equal(s.masked, false);
  assert.equal(s.cpu.pstate, MACHINE.kernelPstate);
  assert.equal(decodeHash("s1-csvc-m1").cpu.pstate, MACHINE.kernelPstate);
  assert.equal(plan({ src: 1, cause: "svc", masked: true }).pstate, MACHINE.kernelPstate);
});

test("svc from EL1 explains the same-level vector; the rule is named", () => {
  const n = notes(take(initialState({ src: 1, cause: "svc" })));
  assert.ok(n.some((x) => x.startsWith("svc always goes to EL1")));
  assert.equal(n[0], "Call versus retry: this is a call, so return after it.");
  assert.equal(notes(take(initialState({ src: 0, cause: "dabt" })))[0], "Call versus retry: this is a fault, so retry it.");
  assert.match(notes(take(initialState({ src: 0, cause: "irq" })))[0], /resume where it stopped/);
});

test("ERET note says the saved registers persist", () => {
  const n = notes(eret(take(initialState())));
  assert.ok(n.some((x) => x.includes("keep their values")));
});
