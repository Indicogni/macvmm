// node --test course/site/src/labs/a64-encoder/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Reference words: assembled with Apple clang 21.0.0 (`clang -c -target arm64-apple-macos`) and
// disassembled with `xcrun llvm-objdump -d` on the reference Mac (2026-11-20). Each row is
// [address, word, what llvm-objdump printed (symbol suffix `<...>` and `; =` comment removed)].
// `dump` from the model must match the third column exactly.
const LLVM = [
  [0x0, 0xd2800540, "mov x0, #0x2a"],
  [0x4, 0xd4000002, "hvc #0"],
  [0x8, 0x14000000, "b 0x8"],
  [0xc, 0xd2a00540, "mov x0, #0x2a0000"],
  [0x10, 0xd40000e2, "hvc #0x7"],
  [0x14, 0xd4000003, "smc #0"],
  [0x18, 0xd4000001, "svc #0"],
  [0x1c, 0xd41fffe1, "svc #0xffff"],
  [0x20, 0xd2a12001, "mov x1, #0x9000000"],
  [0x24, 0x52800822, "mov w2, #0x41"],
  [0x28, 0xd2fffffe, "mov x30, #-0x1000000000000"],
  [0x2c, 0x52a24685, "mov w5, #0x12340000"],
  [0x30, 0xf2d7dde3, "movk x3, #0xbeef, lsl #32"],
  [0x34, 0x72800027, "movk w7, #0x1"],
  [0x38, 0x92800000, "mov x0, #-0x1"],
  [0x3c, 0x12a000a9, "mov w9, #-0x50001"],
  [0x40, 0xd280003f, "mov xzr, #0x1"],
  [0x44, 0x17ffffef, "b 0x0"],
  [0x48, 0x97ffffee, "bl 0x0"],
  [0x4c, 0x14000003, "b 0x58"],
  [0x50, 0x94000002, "bl 0x58"],
  [0x58, 0xd4200000, "brk #0"],
  [0x5c, 0xd4207d00, "brk #0x3e8"],
  [0x6c, 0x97fffff7, "bl 0x48"],
  [0x70, 0x17ffffff, "b 0x6c"],
  [0x74, 0x15ffffff, "b 0x8000070"],
  [0x78, 0x16000000, "b 0xfffffffff8000078"],
  [0x7c, 0x94000001, "bl 0x80"],
  // Second file: alias edge cases.
  [0x0, 0xd2a00000, "movz x0, #0x0, lsl #16"],
  [0x4, 0x52800000, "mov w0, #0x0"],
  [0x8, 0xd2800000, "mov x0, #0x0"],
  [0xc, 0x129fffe0, "movn w0, #0xffff"],
  [0x10, 0x12bfffe0, "movn w0, #0xffff, lsl #16"],
  [0x14, 0x92a00000, "movn x0, #0x0, lsl #16"],
  [0x18, 0x92ffffe0, "mov x0, #0xffffffffffff"],
  [0x1c, 0xf2800000, "movk x0, #0x0"],
  [0x20, 0x52b00003, "mov w3, #-0x80000000"],
  [0x24, 0xd2f00004, "mov x4, #-0x8000000000000000"],
];

// Words llvm-objdump printed as <unknown> (unallocated encodings).
const LLVM_UNKNOWN = [0x52c00000, 0x32800000, 0xd4000000, 0xd4000004, 0xd4200001];

test("decode matches llvm-objdump for every reference word", () => {
  for (const [addr, word, text] of LLVM) {
    const d = M.decode(word, BigInt(addr));
    assert.equal(d.known, true, `${M.hex32(word)} should decode`);
    assert.equal(d.dump, text, `${M.hex32(word)} at 0x${addr.toString(16)}`);
  }
});

test("unallocated encodings are rejected, not guessed", () => {
  for (const w of LLVM_UNKNOWN) {
    const d = M.decode(w);
    assert.equal(d.known, false, M.hex32(w));
    assert.ok(!d.name, `${M.hex32(w)} must not be given a name`);
  }
});

test("encode is the inverse of decode for every reference word", () => {
  for (const [, word] of LLVM) {
    const d = M.decode(word);
    const e = M.encode(d.op, d.operands);
    assert.equal(e.ok, true);
    assert.equal(e.word, word, `${M.hex32(word)} -> ${d.asm} -> ${M.hex32(e.word)}`);
  }
});

test("chapter 02's three words, exactly as the lesson gives them", () => {
  assert.equal(M.encode("movz", { sf: 1, rd: 0, imm16: 0x2a, hw: 0 }).word, 0xd2800540);
  assert.equal(M.encode("hvc", { imm16: 0 }).word, 0xd4000002);
  assert.equal(M.encode("b", { offset: 0 }).word, 0x14000000);
  assert.equal(M.decode(0xd2800540).asm, "movz x0, #0x2a");
  assert.equal(M.decode(0xd4000002).asm, "hvc #0");
  assert.equal(M.decode(0x14000000).asm, "b .");
  assert.deepEqual(M.leBytes(0xd2800540), ["40", "05", "80", "d2"]);
  assert.deepEqual(M.PROGRAM.map((p) => p.word), [0xd2800540, 0xd4000002, 0x14000000]);
});

test("chapter 02 Try it words match the captured run (02-try-lsl-imm.txt)", () => {
  // CODE changed to 0xD2A0_0540 (movz x0, #0x2a, lsl #16) and 0xD400_00E2 (hvc #7).
  assert.equal(M.encode("movz", { sf: 1, rd: 0, imm16: 0x2a, hw: 1 }).word, 0xd2a00540);
  assert.equal(M.encode("hvc", { imm16: 7 }).word, 0xd40000e2);
  assert.equal(M.decode(0xd2a00540).asm, "movz x0, #0x2a, lsl #16");
  assert.equal(M.decode(0xd40000e2).asm, "hvc #7");
  // The run printed x0=0x2a0000 and imm=0x7.
  assert.match(M.decode(0xd2a00540).meaning, /0x2a0000/);
  assert.match(M.decode(0xd40000e2).meaning, /imm=0x7/);
  const cap = join(here, "../../../../captures/02-try-lsl-imm.txt");
  if (!existsSync(cap)) return; // capture lives in the repo; skip if the tree is partial
  const text = readFileSync(cap, "utf8");
  assert.match(text, /x0=0x2a0000/);
  assert.match(text, /imm=0x7/);
});

test("primer words and puzzles", () => {
  assert.equal(M.decode(0xd4000003).op, "smc");
  assert.equal(M.decode(0xd4000001).op, "svc");
  const bl = M.decode(0x97fffff7, 0x6cn);
  assert.equal(bl.op, "bl");
  assert.equal(bl.operands.offset, -36);
  assert.equal(bl.asm, "bl .-0x24");
  assert.equal(bl.dump, "bl 0x48");
  const x1 = M.decode(0xd2800541);
  assert.equal(x1.asm, "movz x1, #0x2a");
  assert.equal(M.decode(0xd2a12001).asm, "movz x1, #0x900, lsl #16");
  assert.equal(M.decode(0x52800822).asm, "movz w2, #0x41");
  // The b at address 8 prints as "b 0x8" (primer Predict).
  assert.equal(M.decode(0x14000000, 8n).dump, "b 0x8");
  for (const p of M.PRESETS) assert.ok(M.decode(p.word).known, p.id);
});

test("other primer table words get a name but no field diagram", () => {
  const names = { 0xd65f03c0: "ret", 0xd69f03e0: "eret", 0xd503207f: "wfi", 0x00000000: "udf",
    0xd53be040: "mrs", 0xd518c000: "msr", 0xb9400022: "ldr/str family", 0xb9000422: "ldr/str family" };
  for (const [w, n] of Object.entries(names)) {
    const d = M.decode(Number(w));
    assert.equal(d.known, false);
    assert.equal(d.name, n, M.hex32(Number(w)));
  }
  assert.equal(M.decode(0xa9bf7bfd).known, false); // stp: not named, honest "not decoded"
  assert.ok(M.decode(0xa9bf7bfd).reason.length > 0);
});

test("operand validation names the field at fault", () => {
  assert.equal(M.encode("movz", { sf: 1, rd: 32, imm16: 0, hw: 0 }).field, "rd");
  assert.equal(M.encode("movz", { sf: 1, rd: 0, imm16: 0x10000, hw: 0 }).field, "imm16");
  assert.equal(M.encode("movz", { sf: 0, rd: 0, imm16: 1, hw: 2 }).field, "hw");
  assert.equal(M.encode("movz", { sf: 1, rd: -1, imm16: 0, hw: 0 }).field, "rd");
  assert.equal(M.encode("hvc", { imm16: -1 }).field, "imm16");
  assert.equal(M.encode("b", { offset: 2 }).field, "offset");
  assert.equal(M.encode("b", { offset: 2 ** 27 }).field, "offset");
  assert.equal(M.encode("b", { offset: 2 ** 27 - 4 }).word, 0x15ffffff);
  assert.equal(M.encode("b", { offset: -(2 ** 27) }).word, 0x16000000);
  assert.equal(M.encode("nope", {}).ok, false);
});

test("hostile text input is rejected cleanly", () => {
  assert.deepEqual(M.parseWord("0xD400_0002"), { ok: true, value: 0xd4000002 });
  assert.deepEqual(M.parseWord(" d4000003 "), { ok: true, value: 0xd4000003 });
  assert.deepEqual(M.parseWord("00000000d4000003"), { ok: true, value: 0xd4000003 });
  for (const bad of ["", "0x", "g1", "123456789", "-1", "0x1.5", "x".repeat(1000), null, 42]) {
    assert.equal(M.parseWord(bad).ok, false, String(bad).slice(0, 20));
  }
  assert.deepEqual(M.parseNumber("-0x24"), { ok: true, value: -36 });
  assert.deepEqual(M.parseNumber("42"), { ok: true, value: 42 });
  for (const bad of ["", "4 2", "0x", "1e9", "9".repeat(30), "--1", "0b101"]) {
    assert.equal(M.parseNumber(bad).ok, false, bad);
  }
  assert.equal(M.parseAddress("0x40000008").value, 0x40000008n);
  assert.equal(M.parseAddress("1".repeat(17)).ok, false);
  assert.equal(M.parseAddress("").ok, false);
});

test("state machine: encode inputs, bit toggles and fixed bits", () => {
  let s = M.initialState();
  assert.equal(s.word, 0xd2800540);
  s = M.step(s, { type: "input", name: "rd", text: "1" });
  assert.equal(s.word, 0xd2800541);
  assert.deepEqual(M.changedBits(s).flatMap((c, i) => (c ? [i] : [])), [0]);
  s = M.step(s, { type: "input", name: "imm16", text: "zz" });
  assert.equal(s.word, 0xd2800541, "an invalid input keeps the last good word");
  assert.equal(s.error.field, "imm16");
  s = M.step(s, { type: "input", name: "imm16", text: "0x2a" });
  assert.equal(s.error, null);
  // Toggle bit 21 (hw low bit): lsl #16.
  s = M.step(s, { type: "toggle", bit: 21 });
  assert.equal(s.word, 0xd2a00541);
  assert.equal(s.inputs.hw, "1");
  // A fixed bit is refused with a note, word unchanged.
  const t = M.step(s, { type: "toggle", bit: 25 });
  assert.equal(t.word, s.word);
  assert.match(t.note, /fixed/);
  // opc bits: 10 -> 11 turns movz into movk.
  s = M.step(s, { type: "toggle", bit: 29 });
  assert.equal(s.op, "movk");
  // 11 -> 01 is unallocated: refused.
  const u = M.step(s, { type: "toggle", bit: 30 });
  assert.equal(u.word, s.word);
  assert.match(u.note, /unallocated/);
  // Switch x -> w with hw = 2 clamps to 1 instead of getting stuck.
  s = M.step(M.step(M.initialState(), { type: "input", name: "hw", text: "2" }), { type: "input", name: "sf", text: "0" });
  assert.equal(s.error, null);
  assert.equal(s.inputs.hw, "1");
  // Changing op within a family keeps the operands; across families resets them.
  s = M.step(M.initialState(), { type: "op", op: "movk" });
  assert.equal(s.word, 0xf2800540);
  s = M.step(s, { type: "op", op: "hvc" });
  assert.equal(s.word, 0xd4000002);
  s = M.step(s, { type: "op", op: "smc" });
  assert.equal(s.word, 0xd4000003);
  s = M.step(s, { type: "toggle", bit: 0 }); // LL 11 -> 10: hvc
  assert.equal(s.op, "hvc");
  s = M.step(s, { type: "op", op: "bl" });
  s = M.step(s, { type: "input", name: "offset", text: "-36" });
  assert.equal(s.word, 0x97fffff7);
});

test("state machine: decode mode, reveal and presets", () => {
  let s = M.step(M.initialState(), { type: "preset", id: "puzzle-bl" });
  assert.equal(s.mode, "decode");
  assert.equal(s.revealed, false);
  assert.match(M.summary(s), /Tell me/);
  assert.doesNotMatch(M.summary(s), /bl/);
  s = M.step(s, { type: "reveal" });
  assert.match(M.summary(s), /bl \.-0x24/);
  s = M.step(s, { type: "hex", text: "d4000003" });
  assert.equal(s.revealed, false, "a new word hides the answer again");
  s = M.step(s, { type: "hex", text: "nope" });
  assert.equal(s.word, 0xd4000003);
  assert.equal(s.error.field, "hex");
  s = M.step(s, { type: "hex", text: "d4000003" });
  s = M.step(s, { type: "toggle", bit: 0 });
  assert.equal(s.word, 0xd4000002);
  s = M.step(s, { type: "mode", mode: "encode" });
  assert.equal(s.op, "hvc");
  s = M.step(s, { type: "mode", mode: "decode" });
  s = M.step(s, { type: "hex", text: "a9bf7bfd" });
  s = M.step(s, { type: "mode", mode: "encode" });
  assert.equal(s.word, 0xd2800540);
  assert.ok(s.note);
  assert.deepEqual(M.step(s, { type: "bogus" }), s);
  assert.deepEqual(M.step(s, { type: "toggle", bit: 32 }), s);
});

test("four bytes pasted in memory order are read little-endian, and the lab says so", () => {
  // The aarch64-reading primer's opening puzzle: objdump -s shows `40 05 80 d2`.
  assert.deepEqual(M.parseWord("40 05 80 d2"), { ok: true, value: 0xd2800540, bytes: true });
  // The bare-metal-rust primer's first word, as xxd prints it.
  assert.deepEqual(M.parseWord("ff 43 00 d1"), { ok: true, value: 0xd10043ff, bytes: true });
  // The same word typed as a number, in either spelling, is the number.
  assert.deepEqual(M.parseWord("d10043ff"), { ok: true, value: 0xd10043ff });
  assert.deepEqual(M.parseWord("0xd100_43ff"), { ok: true, value: 0xd10043ff });
  // Other spacing is not a byte list.
  assert.equal(M.parseWord("d4 00 00 0").bytes, undefined);
  assert.equal(M.parseWord("d400 0002").bytes, undefined);
  let s = M.step(M.step(M.initialState(), { type: "mode", mode: "decode" }), { type: "hex", text: "40 05 80 d2" });
  assert.equal(s.word, 0xd2800540);
  assert.match(s.note, /memory order/);
  assert.match(s.note, /0xD2800540/);
  s = M.step(s, { type: "hex", text: "02 00 00 d4" });
  assert.equal(s.word, 0xd4000002);
  s = M.step(s, { type: "hex", text: "d4000002" });
  assert.equal(s.note, null);
});

test("sub sp, sp, #0x10 is outside the three families and the lab says so", () => {
  const d = M.decode(0xd10043ff);
  assert.equal(d.known, false);
  assert.match(d.reason, /objdump -d/);
  assert.doesNotMatch(d.reason, /llvm-objdump/);
});

test("the bl puzzle sits in RAM, so its target is the start of RAM", () => {
  const s = M.step(M.initialState(), { type: "preset", id: "puzzle-bl" });
  assert.equal(s.pc, 0x40000024n);
  const d = M.decode(s.word, s.pc);
  assert.equal(d.asm, "bl .-0x24");
  assert.equal(d.dump, "bl 0x40000000");
  assert.match(d.dumpNote, /depends on where/);
  // A preset without its own address goes back to the default.
  assert.equal(M.step(s, { type: "preset", id: "ch02-movz" }).pc, M.DEFAULT_PC);
  assert.equal(M.decode(0x14000000, M.step(s, { type: "preset", id: "ch02-b" }).pc).dump, "b 0x40000008");
});

test("dumpNote explains alias spellings and stays quiet when they agree", () => {
  assert.match(M.decode(0xd2800540).dumpNote, /mov is another spelling of movz/);
  assert.equal(M.decode(0xd4000002).dumpNote, null);
  assert.match(M.decode(0xd40000e2).dumpNote, /hex/);
  assert.match(M.decode(0xd4000002).meaning, /EL2/);
  assert.match(M.decode(0xd4000002).meaning, /Hypervisor\.framework/);
});

test("share state round-trips and rejects junk", () => {
  let s = M.step(M.initialState(), { type: "preset", id: "try-lsl" });
  assert.equal(M.toShare(s), "e:d2a00540");
  assert.equal(M.fromShare("e:d2a00540").word, 0xd2a00540);
  assert.equal(M.fromShare("e:d2a00540").op, "movz");
  s = M.step(M.step(M.initialState(), { type: "preset", id: "puzzle-bl" }), { type: "pc", text: "0x6c" });
  assert.equal(M.toShare(s), "d:97fffff7@6c");
  const r = M.fromShare("d:97fffff7@6c");
  assert.equal(r.mode, "decode");
  assert.equal(r.revealed, false);
  assert.equal(r.pc, 0x6cn);
  // An unknown word shared in encode mode opens in decode mode instead.
  assert.equal(M.fromShare("e:a9bf7bfd").mode, "decode");
  for (const junk of [null, "", "x", "e:123", "e:d2800540@", "e:zzzzzzzz", "d:d2800540@12345678123456789", "e:d2800540".repeat(10)]) {
    assert.deepEqual(M.fromShare(junk), M.initialState(), String(junk));
  }
});

test("shipped lab files follow the CSP rules in LABS.md section 7", () => {
  for (const f of ["model.mjs", "view.mjs"]) {
    const src = readFileSync(join(here, f), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "setTimeout(\"", "fetch("]) {
      assert.ok(!code.includes(bad), `${f} contains ${bad}`);
    }
  }
  assert.match(readFileSync(join(here, "view.mjs"), "utf8"), /export function mount/);
  const css = readFileSync(join(here, "style.css"), "utf8");
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").split("}")) {
    if (!rule.includes("{")) continue;
    // Drop an enclosing "@media (...) {" so the selector inside it is checked too.
    const sel = rule.slice(0, rule.lastIndexOf("{")).replace(/^[\s\S]*@media[^{]*\{/, "").trim();
    for (const part of sel.split(",")) {
      const p = part.trim();
      if (p) assert.ok(p.startsWith('.lab[data-lab="a64-encoder"]'), `unscoped selector: ${p}`);
    }
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "style.css must use site tokens, not hard-coded colors");
  const svg = readFileSync(join(here, "fallback.svg"), "utf8");
  assert.match(svg, /<title>/);
  assert.match(svg, /<desc>/);
  const svgBody = svg.replace(' xmlns="http://www.w3.org/2000/svg"', "");
  assert.doesNotMatch(svgBody, /<script|foreignObject|\son[a-z]+=|href=|https?:|\sid=/i);
});
