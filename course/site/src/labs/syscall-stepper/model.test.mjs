// Tests for the syscall-stepper model. Run: node --test course/site/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  encodeSvcEsr, encodeDataAbortEsr, PAGE_FAULT_ESR, describeReason, encodeSpsr,
  initialState, step, stateAt, trace, changedFields, scorePrediction, panelValues,
  encodeShare, decodeShare, isDefaultShare, SCENARIO_IDS, VBAR, MAX_STEPS, KERNEL_CODE,
} from "./model.mjs";

const VECTORS = fileURLToPath(new URL("../../../labs/vectors/esr.json", import.meta.url));

test("ESR encoders reproduce the course's ESR vectors", (t) => {
  if (!existsSync(VECTORS)) {
    t.skip(`vector file missing: ${VECTORS}`);
    return;
  }
  const { vectors } = JSON.parse(readFileSync(VECTORS, "utf8"));
  let svc = 0, dabt = 0;
  // The encoder covers EC, IL and the ISS fields this lab uses. Vectors that set other bits
  // (ESR bits above 31, VNCR, SET, EA, CM) test a decoder's "ignore these" rule; skip them here.
  const COVERED = 0xfffff4ffn; // all of [31:0] except bits 13:11 (VNCR, SET), 9 (EA), 8 (CM)
  for (const v of vectors) {
    const big = BigInt(v.esr);
    if (big > 0xffffffffn || (big & ~COVERED & 0xffffffffn) !== 0n) continue;
    const esr = Number(big);
    if (v.fields?.ec === 0x15) {
      assert.equal(encodeSvcEsr(esr & 0xffff), esr >>> 0, v.name);
      svc++;
    } else if (v.exit === "DataAbort") {
      assert.equal(encodeDataAbortEsr(v.fields), esr >>> 0, v.name);
      dabt++;
    }
  }
  assert.ok(svc >= 1, "at least one svc vector checked");
  assert.ok(dabt >= 10, "data-abort vectors checked");
});

test("known ESR values", () => {
  assert.equal(encodeSvcEsr(0x80), 0x56000080);
  assert.equal(PAGE_FAULT_ESR, 0x92000047);
  assert.match(describeReason(0x56000080), /svc #0x80/);
  assert.match(describeReason(PAGE_FAULT_ESR), /page fault .*write, no page-table entry/);
  assert.equal(describeReason(null), "(none yet)");
  assert.equal(encodeSpsr({ el: 0 }), 0);
  assert.equal(encodeSpsr({ el: 1, daif: 0xf }), 0x3c5);
  assert.throws(() => encodeSvcEsr(0x10000), RangeError);
});

const pcs = (id) => trace(id).map((s) => s.pc);

test("svc: exact path, return to the instruction after svc", () => {
  const tr = trace("svc");
  assert.deepEqual(pcs("svc"), [
    0x1000, 0x1004, VBAR + 0x400, 0x9000, 0x9004, 0x9008, 0x900c, 0x9010, 0x9014, 0x9018, 0x901c, 0x1008, 0x100c, 0x100c,
  ]);
  assert.equal(tr.length - 1, 13, "13 steps from start to halt");
  const afterSvc = tr[2];
  assert.equal(afterSvc.el, 1);
  assert.equal(afterSvc.elr, 0x1008, "saved return address is the NEXT instruction");
  assert.equal(afterSvc.esr, 0x56000080);
  assert.equal(afterSvc.spsr, 0);
  assert.equal(afterSvc.daif, 0xf, "interrupts masked on entry");
  assert.equal(afterSvc.last.kind, "exception");
  assert.match(afterSvc.last.detail, /save the old mode.*record the reason \(svc #0x80\)/);
  // The kernel reads the request register: cmp x16, #20 sets Z, so b.ne falls through.
  assert.equal(tr[8].last.text, "cmp  x16, #20");
  assert.equal(tr[8].last.detail, "equal");
  assert.equal(tr[9].last.detail, "not taken");
  const afterEret = tr[11];
  assert.equal(afterEret.el, 0);
  assert.equal(afterEret.daif, 0);
  assert.equal(afterEret.elr, 0x1008, "ELR keeps its value after eret");
  assert.equal(afterEret.regs.x0, 42);
  const end = tr.at(-1);
  assert.equal(end.regs.x1, 42);
  assert.equal(end.halted.kind, "spin");
  assert.equal(end.regs.x9, 0x56000080);
  assert.equal(end.regs.x10, 0x15);
});

test("repaired page fault: saved address is the store itself, store retries", () => {
  const tr = trace("fault");
  assert.deepEqual(pcs("fault"), [
    0x1000, 0x1004, 0x1008, VBAR + 0x400, 0x9000, 0x9004, 0x9008, 0x900c, 0x9100, 0x9104, 0x9108, 0x910c,
    0x1008, 0x100c, 0x100c,
  ]);
  const afterFault = tr[3];
  assert.equal(afterFault.elr, 0x1008, "saved return address points AT the faulting store");
  assert.equal(afterFault.esr, 0x92000047);
  assert.equal(afterFault.far, 0x5000);
  assert.match(afterFault.last.detail, /save the old mode.*record the reason .*fault address 0x5000/);
  assert.deepEqual(afterFault.mem, {}, "the faulting store wrote nothing");
  const retried = tr[13];
  assert.equal(retried.mem["0x5000"], 42);
  assert.ok(retried.mapped.includes(0x5));
  assert.equal(tr.at(-1).halted.kind, "spin");
});

test("null store: kernel kills the process with status 139", () => {
  const tr = trace("null");
  assert.deepEqual(pcs("null"), [
    0x1000, 0x1004, 0x1008, VBAR + 0x400, 0x9000, 0x9004, 0x9008, 0x900c, 0x9100, 0x9104, 0x9108, 0x9200, 0x9200,
  ]);
  const end = tr.at(-1);
  assert.equal(end.halted.kind, "killed");
  assert.equal(end.halted.exitStatus, 139);
  assert.equal(end.far, 0);
  assert.equal(end.regs.x12, 0);
  assert.deepEqual(end.mem, {});
});

test("the kernel really dispatches on x16: another service number gets the error path", () => {
  let s = step(initialState("svc")); // mov x16, #20
  s = { ...s, regs: { ...s.regs, x16: 4 } }; // pretend the app asked for service 4
  while (!s.halted && s.steps < 20) s = step(s);
  assert.equal(s.regs.x0, 78, "unknown service answers ENOSYS");
  assert.equal(s.regs.x1, 78);
  assert.ok(KERNEL_CODE.some((i) => i.addr === 0x9300));
});

test("ISV=0 data-abort fields are range-checked", () => {
  assert.throws(() => encodeDataAbortEsr({ isv: false, srt: 99, dfsc: 7 }), RangeError);
  assert.throws(() => encodeDataAbortEsr({ isv: false, sas: 7, dfsc: 7 }), RangeError);
  assert.equal(encodeDataAbortEsr({ isv: false, sas: 3, srt: 31, dfsc: 7 }), 0x92df0007);
});

test("step is pure and halted states are fixed points", () => {
  const s0 = initialState("svc");
  const snapshot = JSON.stringify(s0);
  step(s0);
  assert.equal(JSON.stringify(s0), snapshot);
  const end = trace("svc").at(-1);
  assert.equal(step(end), end);
});

test("stateAt clamps and matches trace", () => {
  for (const id of SCENARIO_IDS) {
    const tr = trace(id);
    tr.forEach((s, i) => assert.deepEqual(stateAt(id, i), s));
    assert.deepEqual(stateAt(id, 999), tr.at(-1));
    assert.deepEqual(stateAt(id, -5), tr[0]);
    assert.deepEqual(stateAt(id, "junk"), tr[0]);
    assert.ok(tr.length <= MAX_STEPS);
  }
  assert.throws(() => initialState("nope"), RangeError);
  assert.throws(() => initialState("__proto__"), RangeError);
});

test("changedFields and scorePrediction", () => {
  const tr = trace("svc");
  assert.deepEqual(changedFields(tr[0], tr[1]), ["pc"]);
  assert.deepEqual(changedFields(tr[1], tr[2]), ["mode", "pc", "elr", "esr"]);
  assert.deepEqual(changedFields(tr[10], tr[11]), ["mode", "pc"], "eret changes mode and PC only");
  const sc = scorePrediction(["mode", "pc", "bogus"], ["mode", "pc", "elr", "esr"]);
  assert.equal(sc.right, 2);
  assert.equal(sc.total, 4);
  assert.deepEqual(panelValues(tr[0]), { mode: "user mode (EL0)", pc: "0x1000", elr: "(none yet)", esr: "(none yet)" });
});

test("share state round-trips and rejects hostile input", () => {
  assert.equal(encodeShare({ scenario: "svc", steps: 2, arm: true }), "svc-2-arm");
  assert.deepEqual(decodeShare("svc-2-arm"), { scenario: "svc", steps: 2, arm: true });
  assert.deepEqual(decodeShare("fault-999"), { scenario: "fault", steps: 14, arm: false });
  assert.equal(encodeShare({ scenario: "svc", steps: NaN }), "svc-0");
  assert.equal(encodeShare({ scenario: "svc", steps: Infinity }), `svc-${MAX_STEPS}`);
  assert.equal(encodeShare({ scenario: "svc", steps: 1e9 }), `svc-${MAX_STEPS}`);
  assert.ok(decodeShare(encodeShare({ scenario: "null", steps: 1e9, arm: true })));
  assert.ok(isDefaultShare({ scenario: "svc", steps: 0, arm: false }));
  assert.ok(!isDefaultShare({ scenario: "svc", steps: 0, arm: true }));
  assert.ok(!isDefaultShare({ scenario: "fault", steps: 0, arm: false }));
  for (const bad of [null, "", "svc", "svc-", "svc-1x", "<img>-1", "constructor-1", "svc-1-arm-arm", "x".repeat(100), 5]) {
    assert.equal(decodeShare(bad), null, String(bad));
  }
});

test("lab.json quotes the model's numbers", () => {
  const lab = JSON.parse(readFileSync(fileURLToPath(new URL("./lab.json", import.meta.url)), "utf8"));
  for (const id of SCENARIO_IDS) assert.equal(lab.steps[id], trace(id).length - 1, id);
  assert.equal(Number(lab.esr["svc #0x80"]), encodeSvcEsr(0x80));
  assert.equal(Number(lab.esr["write page fault from user mode"]), PAGE_FAULT_ESR);
});
