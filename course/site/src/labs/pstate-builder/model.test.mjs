// Tests for the pstate-builder model. Run: node --test 'course/site/**/*.test.mjs'
//
// The lab must say exactly what chapter 06 says, so these tests read the real sources:
//   - the lesson's text fallback (three rows) and its "build 0x3c5 from the fields" steps;
//   - the Rust reference's own unit tests in crates/vmm/src/arch/regs.rs (mode names and the
//     register dump's Display strings), so the JavaScript port cannot drift from the Rust;
//   - the captures quoted in OBSERVED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BITS,
  PRESETS,
  OBSERVED,
  DEFAULT_VALUE,
  MAX_INPUT,
  hex,
  m30,
  stackName,
  dumpModeName,
  dumpText,
  fallbackRow,
  buildSteps,
  guestReads,
  describe,
  summary,
  parseHex,
  initialState,
  step,
  encode,
  decode,
  decodePstate,
  changeText,
  shortSummary,
} from "./model.mjs";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const lesson = readFileSync(at("../../../../chapters/III/06-vcpu-state.md"), "utf8");
const regsRs = readFileSync(at("../../../../../crates/vmm/src/arch/regs.rs"), "utf8");
const capture = (name) => readFileSync(at(`../../../../captures/${name}`), "utf8");

// ---- the lesson -------------------------------------------------------------------------------

test("lab is embedded in chapter 06 and listed in its front matter", () => {
  assert.match(lesson, /^labs: \[pstate-builder\]$/m);
  assert.match(lesson, /^:::lab pstate-builder$/m);
});

test("the lesson's text fallback rows are reproduced exactly", () => {
  const i = lesson.indexOf(":::lab pstate-builder");
  const block = lesson.slice(i).match(/```text\n([\s\S]*?)```/);
  assert.ok(block, "fallback text block after :::lab not found");
  const lines = block[1].trimEnd().split("\n");
  assert.match(lines[0], /^value\s+M\[3:0\]\s+mode\s+stack pointer\s+masked$/);
  const rows = lines.slice(1);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const value = Number.parseInt(row.split(/\s+/)[0], 16);
    assert.equal(fallbackRow(value), row.trimEnd(), `row for ${hex(value)}`);
  }
});

test("the lesson's step-by-step build of 0x3c5", () => {
  assert.ok(lesson.includes("`0x200 + 0x100 + 0x80 + 0x40 = 0x3c0`"));
  assert.ok(lesson.includes("`0x3c0 | 0x4 | 0x1 = 0x3c5`"));
  const { terms, formula } = buildSteps(0x3c5);
  assert.deepEqual(
    terms.map((t) => [t.value, t.detail]),
    [
      [0x3c0, "0x200 + 0x100 + 0x80 + 0x40"],
      [0x4, "1 << 2"],
      [0x1, "bit 0"],
    ],
  );
  assert.equal(formula, "0x3c0 | 0x4 | 0x1 = 0x3c5");
  // "Change only step 3 and you get 0x3c4"; "put 2 in the EL field ... 0x3c9".
  let s = initialState();
  s = step(s, { type: "ownSp", on: false });
  assert.equal(s.value, 0x3c4);
  assert.equal(describe(s.value).mode, "EL1t");
  s = step(step(initialState(), { type: "level", el: 2 }), { type: "noop" });
  assert.equal(s.value, 0x3c9);
  assert.equal(describe(s.value).mode, "EL2h");
});

test("what the guest reads back matches the lesson (DAIF = 0x3c0, CurrentEL = 0x4)", () => {
  const reads = Object.fromEntries(guestReads(0x3c5).map((r) => [r.insn, r.value]));
  assert.equal(reads["mrs x0, daif"], 0x3c0);
  assert.equal(reads["mrs x0, CurrentEL"], 0x4);
  assert.equal(reads["mrs x0, nzcv"], 0);
  assert.equal(reads["mrs x0, SPSel"], 1);
  // The regcheck capture shows the same two values, read from inside the guest.
  const run = capture("06-regcheck-run.txt");
  assert.ok(run.includes("regcheck: CurrentEL=0x4"));
  assert.ok(run.includes("regcheck: DAIF=0x3c0"));
});

test("the lesson's Display examples", () => {
  assert.ok(lesson.includes("`0x3c5` prints `EL1h, DAIF, nzcv`"));
  assert.ok(lesson.includes("`0xf0000004` prints `EL1t, daif, NZCV`"));
  assert.equal(dumpText(0x3c5), "EL1h, DAIF, nzcv");
  assert.equal(dumpText(0xf0000004), "EL1t, daif, NZCV");
});

// ---- the Rust reference -----------------------------------------------------------------------

test("mode names and dump strings agree with the Rust unit tests in regs.rs", () => {
  const names = [...regsRs.matchAll(/Pstate\((0x[0-9a-f_]+|u64::MAX)\)\.mode_name\(\),\s*"([^"]+)"/g)];
  const shows = [...regsRs.matchAll(/Pstate\((0x[0-9a-f_]+)\)\.to_string\(\),\s*"([^"]+)"/g)];
  assert.ok(names.length >= 4, "expected mode_name assertions in regs.rs");
  assert.ok(shows.length >= 2, "expected to_string assertions in regs.rs");
  for (const [, lit, want] of names) {
    const v = lit === "u64::MAX" ? 0xffffffff : Number.parseInt(lit.replaceAll("_", ""), 16);
    assert.equal(dumpModeName(v), want, `mode_name(${lit})`);
  }
  for (const [, lit, want] of shows) {
    assert.equal(dumpText(Number.parseInt(lit.replaceAll("_", ""), 16)), want, `to_string(${lit})`);
  }
  // The boot constant itself.
  assert.match(regsRs, /EL1H_MASKED: u64 = DAIF \| \(1 << 2\) \| SP;/);
  assert.equal(DEFAULT_VALUE, 0x3c5);
});

test("every bit constant in regs.rs matches the bit bar", () => {
  const pstateMod = regsRs.slice(regsRs.indexOf("pub mod pstate {"), regsRs.indexOf("ANCHOR_END: pstate_bits"));
  const consts = Object.fromEntries([...pstateMod.matchAll(/pub const ([A-Z]+): u64 = 1 << (\d+);/g)].map((m) => [m[1], Number(m[2])]));
  for (const k of ["N", "Z", "C", "V", "D", "A", "I", "F"]) {
    const b = BITS.find((x) => x.bit === consts[k]);
    assert.equal(b.short, k, `bit ${consts[k]}`);
  }
  assert.equal(BITS.find((x) => x.bit === consts.NRW).short, "nRW");
  assert.equal(BITS.find((x) => x.bit === consts.SP).short, "SP");
});

// ---- captures ---------------------------------------------------------------------------------

test("observed outcomes quote the real captures", () => {
  for (const [v, o] of Object.entries(OBSERVED)) {
    const text = capture(o.capture);
    assert.ok(text.includes(`exit: ${o.exit}\n`), `${o.capture} exit ${o.exit}`);
    assert.ok(text.includes(o.lastLine), `${o.capture} contains "${o.lastLine}"`);
    assert.ok(o.text.includes(`exit code ${o.exit}`) || o.exit === 0, `${hex(Number(v))} text names its exit code`);
    if (Number(v) !== 0x3c5) assert.ok(text.includes(`to ${hex(Number(v))}`), `${o.capture} is the ${hex(Number(v))} run`);
  }
  // 0x3c4: exactly the five lines before "vectors ok".
  const c = capture("06-cpsr-3c4.txt");
  assert.equal((c.match(/^regcheck: /gm) || []).length, 5);
  assert.ok(!c.includes("vectors ok"));
  assert.equal(describe(0x3c4).observed.capture, "06-cpsr-3c4.txt");
  assert.equal(describe(0x3c1).observed, null);
  assert.match(describe(0x3c8).hvfNote, /not checked/);
  // EL3 is not "unchecked": Apple silicon has no EL3.
  for (const v of [0xc, 0xd, 0x3cd]) assert.match(describe(v).hvfNote, /EL3 does not exist on Apple silicon/);
});

test("no guest reads for states a guest never runs in", () => {
  // 0x3c9 was refused before the first instruction (06-cpsr-3c9.txt): nothing is read.
  const x = describe(0x3c9);
  assert.equal(x.ok, true);
  assert.deepEqual(x.reads, []);
  assert.match(x.readsNote, /HVF refused this state before the first instruction/);
  assert.match(describe(0x3cd).readsNote, /EL3 does not exist/);
  assert.match(describe(0x3c8).readsNote, /not offered EL2/);
  assert.deepEqual(describe(0x3c8).reads, []);
  // 0x3c4 ran (five lines), so its reads are shown.
  assert.equal(describe(0x3c4).reads.length, 4);
});

test("at EL0 only NZCV is readable", () => {
  for (const v of [0x0, 0x340, 0x60000000]) {
    const reads = Object.fromEntries(describe(v).reads.map((r) => [r.insn, r]));
    assert.equal(reads["mrs x0, nzcv"].value, (v & 0xf0000000) >>> 0);
    assert.equal(reads["mrs x0, CurrentEL"].value, null);
    assert.match(reads["mrs x0, CurrentEL"].note, /not readable at EL0/);
    assert.equal(reads["mrs x0, SPSel"].value, null);
    assert.equal(reads["mrs x0, daif"].value, null);
    assert.match(reads["mrs x0, daif"].note, /SCTLR_EL1\.UMA/);
  }
});

test("PAN and TCO decode as known bits, as in the lesson's fault-dump cpsr", () => {
  assert.ok(lesson.includes("cpsr=0x824003c5"));
  assert.ok(lesson.includes("bit 22 is PAN"));
  assert.ok(lesson.includes("bit 25 is TCO"));
  const x = describe(0x824003c5);
  assert.equal(x.ok, true);
  assert.equal(x.mode, "EL1h");
  assert.deepEqual(x.cpuBits, ["PAN", "TCO"]);
  assert.match(summary(0x824003c5), /PAN and TCO set/);
  const { terms } = buildSteps(0x824003c5);
  assert.ok(!terms.some((t) => t.what === "other bits"));
  assert.ok(terms.some((t) => t.value === 0x2400000 && /PAN and TCO/.test(t.what)));
  for (const b of [22, 25]) assert.ok(!/should be 0/.test(BITS.find((y) => y.bit === b).name));
  // A truly unmodelled bit is still an error, even next to PAN.
  assert.equal(describe(0x8003c5 | 0x400000).ok, false);
});

test("the two level bits are named by position, with place values", () => {
  const b3 = BITS.find((b) => b.bit === 3);
  const b2 = BITS.find((b) => b.bit === 2);
  assert.equal(b3.short, "M3");
  assert.equal(b2.short, "M2");
  assert.match(b3.name, /high bit \(value 2\)/);
  assert.match(b2.name, /low bit \(value 1\)/);
  assert.equal(BITS.find((b) => b.bit === 1).short, "res");
  assert.equal(BITS.find((b) => b.bit === 5).short, "res");
});

test("reserved EL0 stack bit and AArch32 values are not given AArch64 meanings", () => {
  for (const v of [0x1, 0x3c1]) {
    const t = buildSteps(v).terms.find((x) => x.detail === "bit 0");
    assert.match(t.what, /reserved: EL0 has no own stack/);
  }
  for (const v of [0x10, 0x14, 0x13]) {
    assert.equal(stackName(v), "n/a");
    assert.equal(describe(v).m30, "n/a");
    assert.match(fallbackRow(v), /^0x1[0-9a-f]\s+n\/a\s+AArch32\s+n\/a/);
    assert.match(describe(v).error, /^bit 4 \(nRW\) = 1: 32-bit AArch32 state/);
  }
});

test("announcements are short deltas without the dump letters", () => {
  assert.equal(changeText(0x3c5, 0x3c4), "bit 0 off: EL1t, sp means SP EL0, value 0x3c4");
  assert.equal(changeText(0x3c4, 0x3c5), "bit 0 on: EL1h, sp means SP EL1, value 0x3c5");
  assert.equal(changeText(0x3c5, 0x3c9), "2 bits changed: EL2h, sp means SP EL2, value 0x3c9");
  assert.match(shortSummary(0x10), /^bit 4 \(nRW\)/);
  for (let v = 0; v < 0x400; v += 13) assert.ok(!/nzcv|NZCV|DAIF|daif/.test(changeText(0x3c5, v)));
});

// ---- decoding ---------------------------------------------------------------------------------

test("all 32 bits are described once, 31 down to 0", () => {
  assert.equal(BITS.length, 32);
  BITS.forEach((b, i) => assert.equal(b.bit, 31 - i));
  for (const b of BITS) assert.ok(b.name.length > 0);
  assert.equal(BITS.filter((b) => b.modelled).length, 15);
});

test("stack names and M[3:0]", () => {
  assert.equal(stackName(0x0), "SP_EL0");
  assert.equal(stackName(0x4), "SP_EL0");
  assert.equal(stackName(0x5), "SP_EL1");
  assert.equal(stackName(0x9), "SP_EL2");
  assert.equal(stackName(0xd), "SP_EL3");
  assert.equal(m30(0x3c5), "0101");
  assert.equal(m30(0x3c9), "1001");
});

test("invalid states decode with an error, never a mode", () => {
  for (const [v, re] of [
    [0x10, /nRW.*AArch32/],
    [0x3c6, /reserved mode \(M\[1\]/],
    [0x3c1, /EL0 with M\[0\]/],
    [0x800000, /outside the fields/],
  ]) {
    const x = describe(v);
    assert.equal(x.ok, false);
    assert.equal(x.mode, null);
    assert.match(x.error, re);
    assert.deepEqual(x.reads, []);
    assert.match(summary(v), re);
  }
});

test("every valid AArch64 mode round-trips through the field actions", () => {
  for (let el = 0; el < 4; el++) {
    for (const own of el === 0 ? [false] : [false, true]) {
      let s = step(initialState(0), { type: "level", el });
      s = step(s, { type: "ownSp", on: own });
      const x = describe(s.value);
      assert.equal(x.ok, true);
      assert.equal(x.el, el);
      assert.equal(x.mode, el === 0 ? "EL0t" : `EL${el}${own ? "h" : "t"}`);
      assert.equal(decodePstate(s.value).mode, x.mode);
    }
  }
});

test("summary is one plain line", () => {
  assert.equal(summary(0x3c5), "0x3c5 is EL1h: EL1, sp means SP_EL1, masks D A I F, no flags set. The register dump prints EL1h, DAIF, nzcv.");
  assert.equal(summary(0x0), "0x0 is EL0t: EL0, sp means SP_EL0, masks nothing, no flags set. The register dump prints EL0t, daif, nzcv.");
  for (let v = 0; v < 0x400; v += 7) assert.ok(!summary(v).includes("\n"));
});

test("presets are all distinct, and each decodes the way its label says", () => {
  assert.equal(new Set(PRESETS.map((p) => p.value)).size, PRESETS.length);
  for (const p of PRESETS) {
    assert.ok(p.label.startsWith(`${hex(p.value)}:`), p.label);
    const x = describe(p.value);
    const m = p.label.match(/\((EL\d[ht])\)|: (EL\d[ht])/);
    if (m) assert.equal(x.mode, m[1] || m[2], p.label);
  }
  assert.equal(PRESETS[0].value, DEFAULT_VALUE);
});

// ---- state transitions ------------------------------------------------------------------------

test("toggle flips one bit and is its own inverse", () => {
  const s0 = initialState();
  for (let bit = 0; bit < 32; bit++) {
    const s1 = step(s0, { type: "toggle", bit });
    assert.equal(((s0.value ^ s1.value) >>> 0).toString(2).replaceAll("0", "").length, 1);
    assert.equal(step(s1, { type: "toggle", bit }).value, s0.value);
    assert.ok(s1.value >= 0 && s1.value <= 0xffffffff);
  }
});

test("EL0 clears the stack select, and own-SP is refused at EL0", () => {
  let s = step(initialState(), { type: "level", el: 0 });
  assert.equal(s.value, 0x3c0);
  const same = step(s, { type: "ownSp", on: true });
  assert.equal(same, s);
  // Leaving EL0 restores the stack bit that picking EL0 cleared: 0x3c5 -> EL0 -> EL1 is 0x3c5.
  assert.equal(step(s, { type: "level", el: 1 }).value, 0x3c5);
  // Not if the learner never had it set, or changed the stack choice in between.
  assert.equal(step(step(initialState(0x3c4), { type: "level", el: 0 }), { type: "level", el: 1 }).value, 0x3c4);
  const toggled = step(step(s, { type: "toggle", bit: 30 }), { type: "level", el: 1 });
  assert.equal(toggled.value & 1, 0);
  // Masks and flags at EL0 keep the memory.
  assert.equal(step(step(s, { type: "mask", key: "I", on: false }), { type: "level", el: 1 }).value, 0x345);
});

test("mask and flag actions set exactly their bit", () => {
  let s = initialState(0x5);
  s = step(s, { type: "mask", key: "I", on: true });
  assert.equal(s.value, 0x85);
  s = step(s, { type: "flag", key: "N", on: true });
  assert.equal(s.value, 0x80000085);
  s = step(s, { type: "flag", key: "N", on: false });
  assert.equal(s.value, 0x85);
});

test("bad actions return the same state object", () => {
  const s = initialState();
  for (const a of [
    null,
    {},
    { type: "toggle", bit: 32 },
    { type: "toggle", bit: -1 },
    { type: "toggle", bit: 1.5 },
    { type: "level", el: 4 },
    { type: "mask", key: "X", on: true },
    { type: "mask", key: "__proto__", on: true },
    { type: "flag", key: "toString", on: true },
    { type: "set", value: 2 ** 32 },
    { type: "set", value: -1 },
    { type: "set", value: "0x3c4" },
    { type: "mask", key: "D", on: true }, // already set: no change
    { type: "reset" }, // already the default
  ]) {
    assert.equal(step(s, a), s, JSON.stringify(a));
  }
  assert.equal(step(initialState(0x10), { type: "reset" }).value, DEFAULT_VALUE);
});

// ---- parsing and share state -----------------------------------------------------------------

test("parseHex accepts the forms the lesson writes", () => {
  for (const [txt, v] of [
    ["0x3c5", 0x3c5],
    ["3C5", 0x3c5],
    ["  0x3c4 ", 0x3c4],
    ["0xf000_0004", 0xf0000004],
    ["0X6000_0105", 0x60000105],
    ["0", 0],
    ["0xffffffff", 0xffffffff],
    ["0x000000003c5", 0x3c5], // leading zeros do not count toward the 8 digits
  ]) {
    const r = parseHex(txt);
    assert.equal(r.ok, true, txt);
    assert.equal(r.value, v, txt);
  }
});

test("parseHex rejects hostile or malformed input with a message", () => {
  for (const txt of ["", "0x", "   ", "0x1_", "_1", "1__2", "0x3g5", "-1", "1.5", "0x1ffffffff", "123456789", "x".repeat(MAX_INPUT + 1), "0x3c5<script>", "0x3c5\n0x1", "١٢٣"]) {
    const r = parseHex(txt);
    assert.equal(r.ok, false, JSON.stringify(txt));
    assert.equal(typeof r.error, "string");
  }
  for (const v of [null, undefined, 0x3c5, {}, []]) assert.equal(parseHex(v).ok, false);
  // A long run of digits is cut off by the length cap before any regex work.
  assert.match(parseHex("0".repeat(10000)).error, /too long/);
});

test("share state round-trips; the default clears the hash", () => {
  assert.equal(encode(initialState()), null);
  for (const v of [0x3c4, 0x3c9, 0, 0xf0000004, 0xffffffff]) {
    const s = initialState(v);
    const e = encode(s);
    assert.equal(e, hex(v));
    assert.equal(decode(e).value, v);
  }
  assert.equal(decode(null), null);
  assert.equal(decode("nonsense"), null);
  assert.equal(decode("0x1ffffffff"), null);
});
