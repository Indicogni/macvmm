// Tests for the mmio-trap model. Run: node --test 'course/site/**/*.test.mjs'
// The lab must reproduce chapter 07's captures exactly, so most tests read the capture files.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PROGRAMS, PROGRAM_IDS, DEFAULT_PROGRAM, parseLine, encode, encodeDataAbortEsr, decodeDataAbort,
  displayDataAbort, esrFor, signExtend, timeline, defaultOptions, encodeShare, decodeShare,
  buildProgram, classifyIpa, registersUsed, MAX_FRAMES, MAX_LINE, PROBE_HOLE_BASE, fscName, warnAdmit,
  stage1,
} from "./model.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CAPTURES = here("../../../../captures/");
const VECTORS = here("../../../labs/vectors/esr.json");

/** A capture's stdout and stderr sections, as arrays of lines. */
function capture(name) {
  const text = readFileSync(CAPTURES + name, "utf8");
  const out = /--- stdout ---\n([\s\S]*?)\n--- stderr ---\n?([\s\S]*)$/.exec(text);
  const lines = (s) => s.split("\n").filter((l) => l !== "");
  return { text, stdout: out ? lines(out[1]) : [], stderr: out ? lines(out[2]) : [], exit: Number(/^exit: (\d+)$/m.exec(text)?.[1]) };
}
const noTns = (l) => l.replace(/"t_ns":\d+,/, "");
const run = (id, o = {}, e = {}) => timeline(id, { ...defaultOptions(id), ...o }, e).frames;
const last = (frames) => frames[frames.length - 1];

test("the encoder re-derives every disassembled word in the listings", () => {
  let n = 0;
  for (const id of PROGRAM_IDS) {
    const p = PROGRAMS[id];
    for (const [pc, word, text] of p.lines) {
      const r = parseLine(text, p.funcs);
      assert.ok(r.ok, `${id}: ${text}: ${r.error}`);
      const w = encode(r.insn, BigInt(pc), p.funcs);
      if (word !== null) {
        assert.equal(w, word, `${id} ${pc.toString(16)} ${text}`);
        n++;
      } else {
        assert.notEqual(w, null, `${id}: ${text} must be one instruction`);
      }
    }
  }
  assert.ok(n >= 90, `checked ${n} words`);
});

test("data-abort ESR encode/decode agree with the course's ESR vectors", (t) => {
  if (!existsSync(VECTORS)) {
    t.skip(`vector file missing: ${VECTORS}`);
    return;
  }
  const { vectors } = JSON.parse(readFileSync(VECTORS, "utf8"));
  let n = 0;
  for (const v of vectors) {
    if (v.exit !== "DataAbort" || v.reason !== "exception") continue;
    const big = BigInt(v.esr);
    const d = decodeDataAbort(big);
    for (const k of Object.keys(v.fields)) assert.equal(d[k], v.fields[k], `${v.name}: ${k}`);
    // Vectors that set bits the decoder ignores (above 31, EA, CM, VNCR, SET) only test decode.
    if ((big & ~0xfffff4ffn) === 0n) assert.equal(encodeDataAbortEsr(v.fields), Number(big), v.name);
    n++;
  }
  assert.ok(n >= 20, `checked ${n} data-abort vectors`);
});

test("the syndrome the lab writes for an instruction matches the named ESR vectors", (t) => {
  if (!existsSync(VECTORS)) {
    t.skip(`vector file missing: ${VECTORS}`);
    return;
  }
  const { vectors } = JSON.parse(readFileSync(VECTORS, "utf8"));
  const byName = Object.fromEntries(vectors.map((v) => [v.name, Number(BigInt(v.esr))]));
  const cases = {
    "str w1, [x0] to the PL011 hole": "str w1, [x0]",
    "ldr w3, [x0, #0x18] (PL011 FR)": "ldr w3, [x0, #0x18]",
    "stp to MMIO: ISV=0": "stp x9, x10, [x8]",
    "str x1 to the PL011": "str x1, [x0]",
    "strb wzr (SRT=31 is XZR)": "strb wzr, [x0]",
    "str xzr (SRT=31 is XZR)": "str xzr, [x0]",
    "ldr xzr (load discarded)": "ldr xzr, [x0]",
    "ldrsb w1": "ldrsb w1, [x0]",
    "ldrsb x1": "ldrsb x1, [x0]",
    "ldrsh w2": "ldrsh w2, [x0]",
    "ldrsh x2": "ldrsh x2, [x0]",
    "ldrsw x3": "ldrsw x3, [x0]",
    "ldrb w4": "ldrb w4, [x0]",
    "ldrh w5": "ldrh w5, [x0]",
    "ldr x6": "ldr x6, [x0]",
    "ISV=0 load (ldp/exclusive/atomic/SIMD)": "ldp x1, x2, [x0]",
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(name in byName, `vector "${name}" exists`);
    const r = parseLine(text);
    assert.ok(r.ok, text);
    assert.equal(esrFor(r.insn), byName[name], name);
  }
});

test("the whole mmio-probe run reproduces the chapter 07 capture and trace", () => {
  const f = last(run("probe"));
  const cap = capture("07-mmio-probe.txt");
  assert.deepEqual(f.console, cap.stdout);
  assert.equal(f.halted.code, cap.exit);
  const trace = readFileSync(CAPTURES + "07-mmio-probe.trace.jsonl", "utf8").trim().split("\n").map(noTns);
  assert.equal(trace.length, 22);
  assert.deepEqual(f.trace, trace);
  assert.equal(f.exits, 22);
});

test("the sign preset is the trace's last six records; its fourth exit is the lesson's paper exercise", () => {
  const frames = run(DEFAULT_PROGRAM);
  const trace = readFileSync(CAPTURES + "07-mmio-probe.trace.jsonl", "utf8").trim().split("\n").map(noTns);
  assert.deepEqual(last(frames).trace, trace.slice(16));
  // Record 20: ldrsh x3 at 0x40081264, offset 0x28, sign-extended, then PC + 4.
  const i = frames.findIndex((x) => x.phase === "exit" && x.exit.pc === 0x40081264n);
  const [exit, decode, dispatch, effect, resume] = frames.slice(i, i + 5);
  assert.equal(exit.exit.ipa, 0xb000028n);
  assert.equal(exit.exit.esr, 0x93638006);
  assert.equal(exit.exit.hpfar, 0xb0000n);
  assert.deepEqual(
    { sas: decode.decode.sas, sse: decode.decode.sse, srt: decode.decode.srt, sf: decode.decode.sf, wnr: decode.decode.wnr, isv: decode.decode.isv },
    { sas: 1, sse: true, srt: 3, sf: true, wnr: false, isv: true },
  );
  assert.equal(dispatch.dispatch.name, "testdev");
  assert.equal(dispatch.dispatch.offset, 0x28n);
  assert.equal(effect.regs[3], 0xffffffffffff8001n);
  assert.deepEqual(effect.changed, [3]);
  assert.equal(resume.pc, 0x40081268n);
  assert.equal(resume.trace.at(-1), trace[19]);
  assert.equal(last(frames).console.length, 3);
});

test("breakage 2 (register 31 passed through) reproduces captures/07-xzr-as-register.txt", () => {
  const cap = capture("07-xzr-as-register.txt");
  const f = last(run("probe", { xzrAsReg: true }));
  assert.deepEqual(f.console, cap.stdout);
  assert.deepEqual(f.stderr, cap.stderr);
  assert.equal(f.halted.code, cap.exit);
  // The short preset shows the same two moments.
  const g = run("xzr", { xzrAsReg: true });
  assert.ok(last(g).trace.some((r) => r.includes('"reg":31,"value":"0x400811dc"')));
  assert.equal(last(g).halted.code, 6);
  // Without the breakage, both checks pass.
  assert.deepEqual(last(run("xzr")).console, ["mmio-probe: str xzr stores 0 ok", "mmio-probe: ldr xzr discarded (sp kept) ok"]);
});

test("ISV = 0 stops with the capture's message, dump lines and ring record", () => {
  const cap = capture("07-isv0-stop.txt");
  const frames = run("isv0");
  const f = last(frames);
  assert.equal(f.halted.code, cap.exit);
  for (const line of f.stderr) assert.ok(cap.stderr.includes(line), `capture has: ${line}`);
  assert.equal(f.stderr.length, 4);
  assert.equal(f.stderr[0], cap.stderr[0]);
  const ring = cap.stderr.filter((l) => l.startsWith("  {")).map((l) => noTns(l.trim()));
  assert.equal(f.trace.at(-1), ring.at(-1));
  assert.deepEqual(f.console, cap.stdout);
  // The registers at the stp match the capture's dump (x8, x9, x10, x22, x23, x24).
  const atStp = frames.find((x) => x.phase === "exit");
  assert.equal(atStp.regs[8], 0xb000000n);
  assert.equal(atStp.regs[9], 0x1111222233334444n);
  assert.equal(atStp.regs[10], 0x5555666677778888n);
  assert.equal(atStp.regs[24], 0xb000000n);
});

test("breakage 3 (guessing on ISV = 0) gives the capture's first wrong result", () => {
  const cap = capture("07-isv0-guess.txt");
  const f = last(run("isv0", { guess: true }));
  assert.deepEqual(f.console, cap.stdout.slice(0, 2));
});

test("the hole store: fatal by default, and the log policy reproduces 05-poke-log.txt", () => {
  const fatal = last(run("hole"));
  assert.equal(fatal.halted.code, 3);
  assert.equal(fatal.stderr[0], "macvmm: guest fatal: unhandled MMIO write at 0xc000000 size 4 pc 0x40081088");
  assert.ok(fatal.stderr.includes("  esr=0x93890046 ipa=0xc000000")); // chapter 05's esr
  assert.ok(fatal.stderr.includes("  insn at pc: 0xb9000109"));
  const fatalCap = capture("05-poke-fatal.txt");
  assert.equal(fatal.halted.code, fatalCap.exit);
  assert.deepEqual(fatal.console, fatalCap.stdout);
  assert.deepEqual(fatal.stderr.slice(0, 3), fatalCap.stderr.slice(0, 3));
  const cap = capture("05-poke-log.txt");
  const log = last(run("hole", { log: true }));
  assert.deepEqual(log.console, cap.stdout);
  assert.deepEqual(log.stderr, cap.stderr);
  // The unmapped example uses the probe hole, not the test device's window.
  assert.equal(log.trace[0].includes('"ipa":"0xc000000"'), true);
  assert.equal(classifyIpa(PROBE_HOLE_BASE, defaultOptions("probe")).kind, "unmapped");
});

test("breakage 1 (no PC advance) repeats the capture's first record, then stops", () => {
  const cap = capture("07-no-advance-trace.txt").stdout.slice(0, 3).map(noTns);
  const f = last(run("probe", { noAdvance: true }));
  assert.deepEqual(f.trace, cap);
  assert.equal(f.halted.code, 5);
  assert.match(f.detail, /324,719/);
});

test("a straddling access goes to the unhandled-MMIO policy with the reference's message", () => {
  const f = last(run("straddle"));
  assert.equal(f.stderr[0], "macvmm: guest fatal: unhandled MMIO read at 0xb000ffc size 8 pc 0x4008000c");
  const logged = last(run("straddle", { log: true }));
  assert.equal(logged.halted.code, null);
  assert.equal(logged.regs[3], 0n);
  assert.match(logged.stderr[0], /ignored: --unhandled-mmio log/);
});

test("the UART preview prints characters and reads FR = 0x90; without the UART it is a hole", () => {
  const f = last(run("uart"));
  assert.equal(f.uart, "Hi");
  assert.equal(f.regs[2], 0x90n);
  const off = last(run("uart", { uart: false }));
  assert.equal(off.stderr[0], "macvmm: guest fatal: unhandled MMIO write at 0x9000000 size 4 pc 0x40080008");
});

test("RAM accesses never exit, and an unaligned device access faults in the guest", () => {
  // Point the sign preset's base at RAM: no exits at all.
  const frames = run("sign", {}, { 2: "movk w9, #0x4000, lsl #16" });
  assert.equal(last(frames).exits, 2 * 2); // the other two pairs still go to the device
  const ram = frames.filter((x) => x.phase === "cpu" && /is RAM/.test(x.detail));
  assert.equal(ram.length, 2);
  assert.equal(ram[1].regs[3], 0xffffff80n); // sign extension done by the CPU itself
  // An odd address with the MMU off: alignment fault, no exit.
  const odd = last(run("sign", {}, { 0: "mov w9, #0x21", 3: "strh w8, [x9]" }));
  assert.equal(odd.exits, 0);
  assert.equal(odd.halted.code, 6);
  assert.match(odd.detail, /alignment fault/);
  // The guest's own handler reports it, as for the PC alignment fault in 07-xzr-as-register.
  assert.equal(odd.console[odd.console.length - 1], "guest exception: kind=4 (sync, EL1h) esr=0x96000061 ec=0x25 elr=0x40081234 far=0xb000021");
  assert.deepEqual(odd.stderr, ["macvmm: guest exit code 228"]);
  // A made-up program has no handler: no exit code is claimed.
  const madeUp = last(run("uart", {}, { 5: "ldr w2, [x0, #0x19]" }));
  assert.equal(madeUp.exits, 2);
  assert.equal(madeUp.halted.code, null);
  assert.deepEqual(madeUp.console, []);
  assert.match(madeUp.detail, /up to a real guest's exception handler/);
});

test("register 31: str xzr stores 0 and ldr xzr changes nothing", () => {
  const frames = run("xzr");
  const strXzr = frames.find((x) => x.phase === "effect" && x.exit.pc === 0x400811dcn);
  assert.equal(strXzr.testdev.get(2), 0n);
  const ldrXzr = frames.find((x) => x.phase === "effect" && x.exit.pc === 0x4008120cn);
  assert.deepEqual(ldrXzr.changed, []);
});

test("sign extension follows SSE and SF", () => {
  assert.equal(signExtend(0x80n, 1, true, false), 0xffffff80n);
  assert.equal(signExtend(0x8001n, 2, true, true), 0xffffffffffff8001n);
  assert.equal(signExtend(0x80000000n, 4, true, true), 0xffffffff80000000n);
  assert.equal(signExtend(0x8001n, 2, false, true), 0x8001n);
  assert.equal(signExtend(0x1ff80n, 1, false, false), 0x80n);
});

test("displayDataAbort matches the reference's Display", () => {
  assert.equal(displayDataAbort(decodeDataAbort(0x92000046)),
    "ISV=0 SAS=0 (1 bytes) SSE=0 SRT=0 SF=0 AR=0 FnV=0 S1PTW=0 WnR=1 DFSC=0x6 (translation fault)");
  // fsc_name in crates/vmm/src/arch/esr.rs, range for range.
  const ranges = [
    [0x00, 0x03, "address size fault"], [0x04, 0x07, "translation fault"], [0x08, 0x0b, "access flag fault"],
    [0x0c, 0x0f, "permission fault"], [0x10, 0x10, "synchronous external abort"],
    [0x11, 0x11, "synchronous tag check fault"], [0x14, 0x17, "synchronous external abort on a table walk"],
    [0x21, 0x21, "alignment fault"], [0x30, 0x30, "TLB conflict abort"],
  ];
  const named = new Set();
  for (const [lo, hi, name] of ranges) {
    for (let f = lo; f <= hi; f++) {
      assert.equal(fscName(f), name, `0x${f.toString(16)}`);
      named.add(f);
      assert.ok(displayDataAbort(decodeDataAbort(0x92000000 | f)).endsWith(` (${name})`));
    }
  }
  for (let f = 0; f < 64; f++) if (!named.has(f)) assert.equal(fscName(f), null, `0x${f.toString(16)}`);
  assert.ok(displayDataAbort(decodeDataAbort(0x92000012)).endsWith("DFSC=0x12"));
});

test("a store past the 36-bit IPA space reproduces captures/05-beyond-ipa.txt", () => {
  const cap = capture("05-beyond-ipa.txt");
  const f = last(run("hole", {}, { 0: "mov x8, #0x1000000000" }));
  assert.equal(f.halted.code, cap.exit);
  assert.deepEqual(f.stderr.slice(0, 3), cap.stderr.slice(0, 3)); // DFSC=0x4, esr=0x93890044
  assert.equal(f.stderr[3], cap.stderr.find((l) => l.startsWith("  insn at pc:")));
  const ring = cap.stderr.filter((l) => l.startsWith("  {")).map((l) => noTns(l.trim()));
  assert.equal(f.trace[f.trace.length - 1], ring[ring.length - 1]);
  // Just inside the IPA space it is an ordinary hole again.
  assert.match(last(run("hole", {}, { 0: "mov x8, #0xff0000000" })).stderr[2], /esr=0x93890046/);
});

test("an address too wide to be physical faults in the guest, with no exit", () => {
  for (const mov of ["mov x8, #0xffff000000000000", "mov x8, #-8", "mov x8, #0x10000000000"]) {
    const f = last(run("hole", {}, { 0: mov }));
    assert.equal(f.exits, 0, mov);
    assert.equal(f.trace.length, 0, mov);
    assert.equal(f.halted.code, 6, mov);
    assert.match(f.console[f.console.length - 1], /^guest exception: kind=4 \(sync, EL1h\) esr=0x96000040 ec=0x25 elr=0x40081088 far=0x/);
    assert.deepEqual(f.stderr, ["macvmm: guest exit code 228"]);
    assert.match(f.detail, /address size fault/);
  }
  assert.equal(stage1("off", 1n << 40n, 4).fault, "size");
  assert.equal(stage1("off", (1n << 40n) - 4n, 4).ipa, (1n << 40n) - 4n);
});

test("with isv0-probe's MMU on, the lab follows its page tables", () => {
  // TESTDEV_ALIAS: the VA differs from the IPA, and FAR_EL2 keeps the VA.
  const alias = run("isv0", {}, { 4: "mov w8, #0xb100000" });
  const exit = alias.find((x) => x.phase === "exit");
  assert.equal(exit.exit.far, 0xb100000n);
  assert.equal(exit.exit.ipa, 0xb000000n);
  // An address its tables leave out: a stage-1 translation fault at level 2, inside the guest.
  const f = last(run("isv0", {}, { 4: "mov w8, #0xc000000" }));
  assert.equal(f.exits, 0);
  assert.equal(f.halted.code, 6);
  assert.equal(f.console[f.console.length - 1], "guest exception: kind=4 (sync, EL1h) esr=0x96000046 ec=0x25 elr=0x40081234 far=0xc000000");
  assert.equal(stage1("identity", 0xb001000n, 8).dfsc, 0x7); // the testdev's level-3 table
  assert.equal(stage1("identity", 0xc0000000n, 8).dfsc, 0x5); // level-1 entry 3 is invalid
});

test("guest warnings are rate-limited like the reference's guest_warn!", () => {
  // RateLimit::decide (crates/vmm/src/log.rs): the first 10, then every 1000th with a count.
  for (let n = 1; n <= 10; n++) assert.equal(warnAdmit(n), 0);
  assert.equal(warnAdmit(11), null);
  assert.equal(warnAdmit(999), null);
  assert.equal(warnAdmit(1000), 989);
  assert.equal(warnAdmit(2000), 999);
  assert.equal(warnAdmit(0), null);
});

test("the parser rejects what it cannot run, and never throws", () => {
  const bad = [
    "", "ldr", "ldr x31, [x0]", "ldr x0, [xzr]", "strb x1, [x0]", "ldrsw w1, [x0]", "ldr x0, [x1, #0x103]",
    "ldr x0, [x1, #0x8000]", "ldr x1, [x1], #8", "ldp x1, x1, [x0]", "stp x1, w2, [x0]", "stp x1, x2, [x0, #12]",
    "mov w1, #0x100000000", "movk w1, #1, lsl #32", "movk x1, #0x10000", "eval(1)", "add x0, x1, x2",
    "bl somewhere", "ldr x0, [x1, #8]!, #8", "mov x1, sp, sp", "x".repeat(MAX_LINE + 1), "ldr x0,\u0000[x1]",
    "mov w0, #0x12345678", "mov x0, #0x123456789", "ldp xzr, xzr, [x1]", "ldp wzr, wzr, [x1, #8]",
  ];
  for (const s of bad) {
    const r = parseLine(s, { check: { addr: 0n } });
    assert.equal(r.ok, false, `should reject: ${JSON.stringify(s)}`);
    assert.equal(typeof r.error, "string");
  }
  // Fuzz: random strings over the grammar's alphabet never throw.
  const alphabet = "ldrstpbhwx0123456789[], #!-zrspmovk;";
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i++) {
    let s = "";
    const n = Math.floor(rnd() * 30);
    for (let j = 0; j < n; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = parseLine(s, {});
    assert.equal(typeof r.ok, "boolean");
  }
  for (const v of [null, undefined, 3, {}, []]) assert.equal(parseLine(v).ok, false);
  assert.match(parseLine("mov w0, #0x12345678").error, /one mov cannot build this value: use mov plus movk/);
  assert.equal(parseLine("mov x0, #0xff00ff00ff00ff00").ok, true); // a bitmask immediate (ORR)
});

test("the parser accepts the forms the lab teaches", () => {
  const good = {
    "ldr w3, [x0, #0x18]": "ls", "str x1, [x0], #8": "ls", "ldr x0, [x1, #8]!": "ls", "ldur x0, [x1]": null,
    "ldr x0, [x1, #-8]": "ls", "stp x9, x10, [x8]": "pair", "ldpsw x1, x2, [x0, #8]": "pair", "mov x4, sp": "movr",
    "MOV W8, #0x8001": "movi", "nop": "nop", "strh w8, [x9] ; comment": "ls",
  };
  for (const [s, op] of Object.entries(good)) {
    const r = parseLine(s);
    if (op === null) assert.equal(r.ok, false, s);
    else assert.equal(r.ok && r.insn.op, op, `${s}: ${r.error}`);
  }
  // Writeback forms trap with ISV = 0.
  assert.equal(decodeDataAbort(esrFor(parseLine("str x1, [x0], #8").insn)).isv, false);
  assert.equal(decodeDataAbort(esrFor(parseLine("ldr x1, [x0, #-8]").insn)).isv, true);
});

test("an edited writeback store stops like the stp (ISV = 0), and a parse error halts at step 0", () => {
  const f = last(run("sign", {}, { 3: "strb w8, [x9], #1" }));
  assert.equal(f.halted.code, 3);
  assert.match(f.stderr[0], /ISV=0/);
  assert.equal(f.stderr[3], "  insn at pc: 0x38001528");
  const bad = run("sign", {}, { 1: "frobnicate" });
  assert.equal(bad.length, 1);
  assert.match(bad[0].halted.text, /Line 2 does not parse/);
});

test("share state round-trips and rejects junk", () => {
  const s = { program: "sign", step: 12, options: { ...defaultOptions("sign"), log: true, guess: true }, edits: { 3: "strb w8, [x9], #1", 0: "mov w9, #0x21.~" } };
  const enc = encodeShare(s);
  assert.match(enc, /^sign\.12\.tlg~0=/);
  assert.deepEqual(decodeShare(enc), s);
  assert.equal(encodeShare({ program: "sign", step: 0, options: defaultOptions("sign"), edits: {} }), "sign.0.t");
  assert.equal(encodeShare({ program: "hole", step: 3, options: defaultOptions("hole"), edits: {} }), "hole.3.-");
  const junk = [
    null, "", "nope.0.t", "sign", "sign.x.t", "sign.0.tt", "sign.0.q", "sign.0.t~99=nop", "sign.0.t~0=%E0%A4%A",
    "sign.0.t~0=" + "a".repeat(200), "sign.0.t~0=nop~0=nop", "sign.999999.t", "a".repeat(4000),
    "sign.0.t" + "~0=nop".repeat(30), "__proto__.0.t", "constructor.0.-",
  ];
  for (const j of junk) assert.equal(decodeShare(j), null, String(j).slice(0, 40));
});

test("every preset runs to a halt within the frame cap, under every option combination", () => {
  for (const id of PROGRAM_IDS) {
    for (let mask = 0; mask < 64; mask++) {
      const o = { testdev: !!(mask & 1), uart: !!(mask & 2), log: !!(mask & 4), noAdvance: !!(mask & 8), xzrAsReg: !!(mask & 16), guess: !!(mask & 32) };
      const frames = timeline(id, o).frames;
      assert.ok(frames.length < MAX_FRAMES, `${id} ${mask}`);
      assert.ok(last(frames).halted, `${id} ${mask} halts`);
      for (const f of frames) for (const l of [...f.console, ...f.stderr, f.uart]) {
        // eslint-disable-next-line no-control-regex
        assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(l), "no control characters reach the page");
      }
    }
  }
});

test("registersUsed lists the program's registers", () => {
  assert.deepEqual(registersUsed(buildProgram("sign")), [3, 4, 8, 9]);
  assert.deepEqual(registersUsed(buildProgram("isv0")), [8, 9, 10, 22, 23, 24]);
});

test("learner-visible text carries no internal IDs", () => {
  const text = JSON.stringify(Object.values(PROGRAMS).map((p) => [p.title, p.summary, p.source]));
  assert.doesNotMatch(text, /\b[MKRL]\d{1,2}\b|§|PLAN|CURRICULUM|MMIO-\d|\[[UVH]\]/);
  const src = readFileSync(here("./model.mjs"), "utf8") + readFileSync(here("./view.mjs"), "utf8");
  // Strings in shipped code (not comments) must not carry them either.
  const strings = src.match(/"[^"\n]*"|`[^`]*`/g).join("\n");
  assert.doesNotMatch(strings, /\bM\d{1,2}\b|§|PLAN |CURRICULUM|MMIO-\d/);
});
