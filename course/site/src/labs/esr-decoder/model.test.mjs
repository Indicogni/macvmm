// Tests for the ESR decoder lab's model. Run: node --test course/site/
//
// The model must agree with macvmm's decoder (crates/vmm/src/arch/esr.rs) on every shared
// vector, print exactly what the reference printed in the real captures, never throw, and
// reproduce the numbers chapter 07 and the reading-arm-specs primer quote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "./model.mjs";
import { SYSREG_NAMES } from "./sysregs.mjs";
import { CARDS } from "./cards.mjs";
import { slugify } from "../../../lib/html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "..", "..");
const courseDir = join(siteDir, "..");
const repoDir = join(courseDir, "..");
const vectorsPath = join(siteDir, "labs", "vectors", "esr.json");
const capturesDir = join(courseDir, "captures");

// ---------------------------------------------------------------------------------------------
// The shared vectors

const KEYS = {
  Hvc: ["imm"], Smc: ["imm"], Brk: ["imm"], Wfx: ["ti"],
  SysReg: ["op0", "op1", "crn", "crm", "op2", "rt", "read"],
  DataAbort: ["isv", "sas", "sse", "srt", "sf", "ar", "fnv", "s1ptw", "wnr", "dfsc"],
  InstructionAbort: ["ifsc", "s1ptw"],
};

test("every vector in labs/vectors/esr.json decodes as macvmm decodes it", { skip: existsSync(vectorsPath) ? false : "labs/vectors/esr.json not exported yet (cargo xtask export-vectors)" }, () => {
  const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8"));
  assert.ok(vectors.length >= 50, "expected the full vector set");
  for (const v of vectors) {
    const esr = BigInt(v.esr);
    const got = M.fromHv(v.reason, esr);
    assert.equal(got.kind, v.exit, `${v.name}: kind`);
    if (v.exit === "Unknown") {
      assert.equal(got.ec, v.fields.ec, `${v.name}: ec`);
      assert.equal(got.esr, BigInt(v.fields.esr), `${v.name}: esr kept`);
    } else if (KEYS[v.exit]) {
      for (const k of KEYS[v.exit]) assert.equal(got[k], v.fields[k], `${v.name}: ${k}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The real dumps: `vcpu0: <Display>` followed by `  esr=0x...`

function captureDisplays() {
  const pairs = [];
  for (const f of readdirSync(capturesDir)) {
    const lines = readFileSync(join(capturesDir, f), "utf8").split(/\r?\n/);
    for (let i = 0; i + 1 < lines.length; i++) {
      const d = /^vcpu\d+: (.*)$/.exec(lines[i]);
      const e = /^ {2}esr=(0x[0-9a-f]+) /.exec(lines[i + 1]);
      if (d && e) pairs.push({ file: f, display: d[1], esr: BigInt(e[1]) });
    }
  }
  return pairs;
}

test("the lab prints what macvmm printed in every captured dump", () => {
  const pairs = captureDisplays();
  assert.ok(pairs.length >= 10, `expected at least 10 captured dumps, found ${pairs.length}`);
  for (const p of pairs) assert.equal(M.exitDisplay(M.decode(p.esr)), p.display, `${p.file} esr=${M.hex(p.esr)}`);
});

test("Display strings from esr.rs's own unit tests", () => {
  const cases = [
    [0x93810046n, "data abort (EC 0x24): ISV=1 SAS=2 (4 bytes) SSE=0 SRT=1 SF=0 AR=0 FnV=0 S1PTW=0 WnR=1 DFSC=0x6 (translation fault)"],
    [0x82000006n, "instruction abort (EC 0x20): IFSC=0x6 S1PTW=0 (translation fault)"],
    [0x6230e499n, "sysreg (EC 0x18): MRS S3_3_C9_C12_0 rt=4 (PMCR_EL0)"],
    [0x02000000n, "unknown (EC 0x00, ESR 0x2000000): unknown reason"],
    [0xf2000007n, "brk (EC 0x3c): imm=0x7"],
    [0x5a000001n, "hvc (EC 0x16): imm=0x1"],
    [0x07e00000n, "wfx (EC 0x01): WFI"],
  ];
  for (const [esr, s] of cases) assert.equal(M.exitDisplay(M.decode(esr)), s);
  assert.equal(M.exitDisplay(M.fromHv("canceled", 0x5a000000n)), "canceled (hv_vcpus_exit)");
  assert.equal(M.esrEc(M.MASK64), 0x3f);
  assert.equal(M.esrIss(M.MASK64), 0x01ffffff);
  assert.ok(M.esrIl(0x5a000000n));
});

// ---------------------------------------------------------------------------------------------
// Totality: the decoder, layout, readout and step never throw

function* xorshift(n) {
  let x = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < n; i++) {
    x ^= (x << 13n) & M.MASK64;
    x ^= x >> 7n;
    x ^= (x << 17n) & M.MASK64;
    yield x;
  }
}

test("total for 50,000 random 64-bit syndromes (and every EC)", () => {
  const values = [...xorshift(50000)];
  for (let ec = 0; ec < 64; ec++) values.push(BigInt(ec) << 26n, (BigInt(ec) << 26n) | 0x1ffffffn);
  for (const esr of values) {
    for (const reason of M.REASONS) {
      const v = M.view({ esr, reason, text: "", error: null });
      assert.equal(typeof v.summary, "string");
      assert.ok(!/[\x00-\x1f\x7f]/.test(v.display), "no control characters in the display");
    }
    const fields = M.layout(esr);
    // The fields cover bits 31..0 exactly once, most significant first, values in range.
    let next = 31;
    for (const f of fields) {
      assert.equal(f.hi, next, `contiguous at ${M.hex(esr)}`);
      assert.ok(f.lo <= f.hi);
      assert.ok(f.value >= 0 && f.value < 2 ** (f.hi - f.lo + 1));
      next = f.lo - 1;
    }
    assert.equal(next, -1);
    const d = M.decode(esr);
    if (d.kind === "DataAbort") assert.ok(d.sas <= 3 && d.srt <= 31 && d.dfsc <= 63);
  }
});

// ---------------------------------------------------------------------------------------------
// Parsing

test("parseEsr accepts the forms readers type and rejects the rest with a message", () => {
  const ok = [
    ["0x93890046", 0x93890046n], ["0X9389_0046", 0x93890046n], ["93890046", 0x93890046n],
    ["  0x9389 0046 ", 0x93890046n], ["0x0", 0n], ["0", 0n], ["0xffffffffffffffff", M.MASK64],
    ["0x0000000096000044", 0x96000044n], ["0xffff_ff1f_9381_3b46", 0xffffff1f93813b46n],
  ];
  for (const [s, v] of ok) assert.deepEqual(M.parseEsr(s), { ok: true, value: v }, s);
  const bad = ["", "   ", "0x", "0x_", "0xg", "-1", "1.5", "0x1_0000_0000_0000_0000", "x".repeat(65), null, 42];
  for (const s of bad) {
    const r = M.parseEsr(s);
    assert.equal(r.ok, false, String(s));
    assert.equal(typeof r.error, "string");
  }
});

// ---------------------------------------------------------------------------------------------
// The numbers the lessons quote

test("chapter 07: the story's store 0x93820046 and chapter 05's stop 0x93890046", () => {
  const story = M.decode(0x93820046n);
  assert.deepEqual(
    { kind: story.kind, isv: story.isv, sas: story.sas, sse: story.sse, srt: story.srt, sf: story.sf, wnr: story.wnr, dfsc: story.dfsc },
    { kind: "DataAbort", isv: true, sas: 2, sse: false, srt: 2, sf: false, wnr: true, dfsc: 6 },
  );
  // Only bits 20 to 16 differ: SRT 9.
  assert.equal(0x93820046n ^ 0x93890046n, 0x000b0000n);
  assert.equal(M.decode(0x93890046n).srt, 9);
  assert.equal(
    M.summary(M.decode(0x93890046n), 0x93890046n),
    "Data abort from a lower EL (EC 0x24). Write of 4 bytes from w9. Translation fault, level 2 (DFSC 0b000110).",
  );
  // The paper fallback's second value: ISV = 0, WnR = 1, DFSC 0x6.
  const blank = M.decode(0x92000046n);
  assert.equal(blank.kind, "DataAbort");
  assert.equal(blank.isv, false);
  assert.equal(blank.wnr, true);
  assert.equal(blank.dfsc, 6);
  assert.match(M.summary(blank, 0x92000046n), /ISV = 0/);
});

test("chapter 07: toggle ISV, change SAS, set SRT to 31", () => {
  let s = M.initialState(null);
  assert.equal(s.esr, 0x93890046n);
  s = M.step(s, { type: "toggle", bit: 24 });
  assert.equal(s.esr, 0x92890046n);
  assert.equal(M.decode(s.esr).isv, false);
  const srtField = M.layout(s.esr).find((f) => f.key === "srt");
  assert.equal(srtField.used, false, "SRT carries nothing with ISV = 0");
  s = M.step(s, { type: "toggle", bit: 24 });
  s = M.step(s, { type: "field", lo: 22, width: 2, value: 3 });
  assert.equal(M.decode(s.esr).sas, 3);
  s = M.step(s, { type: "field", lo: 16, width: 5, value: 31 });
  const d = M.decode(s.esr);
  assert.equal(d.srt, 31);
  assert.match(M.summary(d, s.esr), /Write of 8 bytes from wzr \(register 31 is the zero register here, never sp\)/);
  // Out-of-range values are masked to the field, like the Rust field helpers.
  s = M.step(s, { type: "field", lo: 16, width: 5, value: 99 });
  assert.equal(M.decode(s.esr).srt, 99 & 31);
});

test("primer: 0x93c18046 is an 8-byte store of x1, translation fault", () => {
  const d = M.decode(0x93c18046n);
  assert.equal(M.esrEc(0x93c18046n), 0x24);
  assert.deepEqual([d.isv, d.sas, d.srt, d.sf, d.wnr, d.dfsc], [true, 3, 1, true, true, 6]);
  assert.equal(M.summary(d, 0x93c18046n), "Data abort from a lower EL (EC 0x24). Write of 8 bytes from x1. Translation fault, level 2 (DFSC 0b000110).");
});

test("chapter 02: 0x5a000000 is EC 0x16, IL 1, ISS 0", () => {
  assert.equal(M.esrEc(0x5a000000n), 0x16);
  assert.equal(M.esrIl(0x5a000000n), true);
  assert.equal(M.esrIss(0x5a000000n), 0);
  assert.deepEqual(M.decode(0x5a000000n), { kind: "Hvc", imm: 0 });
});

test("loads: sign extension and register width read naturally", () => {
  assert.equal(M.summary(M.decode(0x93620006n), 0x93620006n), "Data abort from a lower EL (EC 0x24). Read of 2 bytes into w2, sign-extended to 32 bits. Translation fault, level 2 (DFSC 0b000110).");
  assert.match(M.summary(M.decode(0x93874006n), 0x93874006n), /Read of 4 bytes into w7\. A load-acquire\./);
  assert.match(M.summary(M.decode(0x93ca8085n), 0x93ca8085n), /S1PTW = 1/);
  assert.match(M.summary(M.decode(0x93890406n), 0x93890406n), /FnV = 1/);
  assert.equal(M.fscText(0x21), "Alignment fault (DFSC 0b100001)");
  assert.equal(M.fscText(0x0f), "Permission fault, level 3 (DFSC 0b001111)");
  assert.match(M.fscText(0x3e), /does not name/);
});

test("same-EL classes keep the abort layout but decode as Unknown", () => {
  const v = M.view({ esr: 0x96000021n, reason: "exception", text: "", error: null });
  assert.equal(v.exit.kind, "Unknown");
  assert.equal(v.layoutName, "data abort");
  assert.match(v.summary, /ESR_EL1/);
  assert.equal(v.fields.find((f) => f.key === "dfsc").meaning, "Alignment fault (DFSC 0b100001)");
});

test("bits above 31 are reported and ignored", () => {
  const v = M.view({ esr: 0xffffff1f93813b46n, reason: "exception", text: "", error: null });
  assert.equal(v.exit.kind, "DataAbort");
  assert.equal(v.exit.srt, 1);
  assert.match(v.high, /^Bits 63 to 32 are 0xffffff1f \(so ISS2, bits 55 to 32, is 0xffff1f\)/);
  assert.equal(M.esrIss2(0xffffffffffffffffn), 0xffffff, "ISS2 is 24 bits, as the primer says");
  assert.equal(M.view({ esr: 0x93810046n, reason: "exception" }).high, null);
});

// ---------------------------------------------------------------------------------------------
// State, hash, presets

test("share state round-trips and hostile hashes are ignored", () => {
  for (const reason of M.REASONS) {
    const s = { ...M.initialState(null), esr: 0x93c08047n, reason };
    const back = M.initialState(M.encodeHash(s));
    assert.equal(back.esr, s.esr);
    assert.equal(back.reason, reason);
  }
  assert.equal(M.encodeHash({ esr: 0x93890046n, reason: "exception" }), "0x93890046");
  assert.equal(M.initialState("0x93C08045").esr, 0x93c08045n, "DESIGN's example form");
  for (const h of [null, "", "garbage", "evil:0x1", "<script>", "0x" + "f".repeat(17), "exception:" + "1".repeat(200)]) {
    assert.equal(M.initialState(h).esr, M.DEFAULT_ESR, String(h));
  }
});

test("step ignores malformed actions and keeps typed text on a parse error", () => {
  const s0 = M.initialState(null);
  for (const a of [null, {}, { type: "nope" }, { type: "toggle", bit: 64 }, { type: "field", lo: 60, width: 8, value: 1 }, { type: "preset", id: "x" }, { type: "reason", reason: "x" }, { type: "set", esr: 5 }]) {
    const s = M.step(s0, a);
    assert.equal(s.esr, s0.esr, JSON.stringify(a));
  }
  const bad = M.step(s0, { type: "input", text: "0x93zz" });
  assert.equal(bad.esr, s0.esr);
  assert.equal(bad.text, "0x93zz");
  assert.match(bad.error, /"z" is not a hex digit/);
  const good = M.step(bad, { type: "input", text: "0x5a00_0000" });
  assert.equal(good.esr, 0x5a000000n);
  assert.equal(good.error, null);
  assert.equal(M.step(good, { type: "reset" }).esr, M.DEFAULT_ESR);
});

test("every preset was seen on real hardware, and its source says where", () => {
  const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8"));
  const vectorEsrs = new Set(vectors.map((v) => BigInt(v.esr)));
  const ids = new Set();
  for (const p of M.PRESETS) {
    assert.ok(!ids.has(p.id), `duplicate preset ${p.id}`);
    ids.add(p.id);
    if (p.source.startsWith("captures/")) {
      const text = readFileSync(join(courseDir, p.source), "utf8");
      assert.ok(text.includes(M.hex(p.esr)), `${p.source} contains ${M.hex(p.esr)}`);
    } else {
      assert.equal(p.source, "vectors/esr.json");
      assert.ok(vectorEsrs.has(p.esr), `${M.hex(p.esr)} is a vector`);
    }
  }
  // DESIGN section 8.1's preset list: data abort to the UART, instruction abort, HVC #0, WFI, sysreg trap, SMC.
  const kinds = new Set(M.PRESETS.map((p) => M.decode(p.esr).kind));
  for (const k of ["DataAbort", "InstructionAbort", "Hvc", "Wfx", "SysReg", "Smc"]) assert.ok(kinds.has(k), k);
});

// ---------------------------------------------------------------------------------------------
// Cross-checks against the repository

test("sysregs.mjs matches the two name tables in crates/hvf/src/regs.rs", { skip: existsSync(join(repoDir, "crates/hvf/src/regs.rs")) ? false : "crates/hvf/src/regs.rs not present" }, () => {
  const src = readFileSync(join(repoDir, "crates/hvf/src/regs.rs"), "utf8");
  const want = {};
  for (const m of src.matchAll(/^\s*([A-Z][A-Z0-9_]*) = \((\d+), (\d+), (\d+), (\d+), (\d+)\),/gm)) {
    const key = m.slice(2, 7).join(",");
    if (!(key in want)) want[key] = m[1]; // SysReg::name() returns the first match
  }
  assert.ok(Object.keys(want).length > 100);
  assert.deepEqual({ ...SYSREG_NAMES }, want);
});

test("ec_name and fsc_name match esr.rs", () => {
  const src = readFileSync(join(repoDir, "crates/vmm/src/arch/esr.rs"), "utf8");
  const ecBlock = src.slice(src.indexOf("pub const fn ec_name"), src.indexOf("// ANCHOR_END: esr_ec_name"));
  let rows = 0;
  for (const m of ecBlock.matchAll(/^\s*(0x[0-9a-f]{2})(?: \| (0x[0-9a-f]{2}))? => "([^"]+)",/gm)) {
    for (const code of [m[1], m[2]].filter(Boolean)) {
      assert.equal(M.ecName(Number(code)), m[3], code);
      rows++;
    }
  }
  assert.equal(rows, 24);
  for (let ec = 0; ec < 64; ec++) if (M.ecName(ec) !== null) assert.ok(ecBlock.includes(`"${M.ecName(ec)}"`));
  const fscBlock = src.slice(src.indexOf("pub const fn fsc_name"), src.indexOf("impl fmt::Display for DataAbort"));
  for (const m of fscBlock.matchAll(/^\s*(0x[0-9a-f]{2})(?:\.\.=(0x[0-9a-f]{2}))? => "([^"]+)",/gm)) {
    const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
    for (let c = lo; c <= hi; c++) assert.equal(M.fscName(c), m[3], `fsc ${c}`);
  }
});

test("chapter links point at headings that exist", () => {
  const exits = [
    M.decode(0x93890046n), M.decode(0x92000046n), M.decode(0x5a000000n), M.decode(0x5e000000n),
    M.decode(0x6230e499n), M.decode(0x07e00000n), M.decode(0x82000006n), M.fromHv("canceled", 0n), M.fromHv("vtimer", 0n),
  ];
  const chapters = JSON.parse(readFileSync(join(courseDir, "chapters.json"), "utf8")).chapters;
  const byUrl = new Map(chapters.map((c) => [`/build-your-own/vmm/${c.url}`, c]));
  for (const exit of exits) {
    for (const { href } of M.vmmAction(exit).links) {
      const [path, frag] = href.split("#");
      const ch = byUrl.get(path);
      assert.ok(ch, `no chapter at ${path}`);
      if (frag) {
        const md = readFileSync(join(repoDir, ch.file), "utf8");
        const slugs = [...md.matchAll(/^## (.*)$/gm)].map((m) => slugify(m[1]));
        assert.ok(slugs.includes(frag), `${path} has no heading #${frag}`);
      }
    }
  }
});

test("learner-visible text has no internal IDs", () => {
  const texts = [];
  const values = [...M.PRESETS.map((p) => p.esr), ...xorshift(2000)];
  for (const esr of values) {
    for (const reason of M.REASONS) {
      const v = M.view({ esr, reason, text: "", error: null });
      texts.push(v.summary, v.vmm.does, v.vmm.pc, v.vmm.note ?? "", ...v.vmm.links.map((l) => l.text), ...v.fields.map((f) => f.meaning + f.note), v.high ?? "");
    }
  }
  texts.push(...M.PRESETS.map((p) => p.label), ...M.PRESETS.map((p) => p.note ?? ""));
  for (const c of CARDS) texts.push(c.question, c.where, c.answer);
  const lab = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  texts.push(lab.title, lab.goal);
  for (const t of texts) {
    assert.doesNotMatch(t, /\b[MKR]\d{1,2}\b|PLAN|CURRICULUM|§|MMIO-\d|LOG-\d|HC-\d|\[[UVH]\]/, t);
  }
});

test("spec-hunt cards are well formed; syndrome cards decode to what they claim", () => {
  assert.ok(CARDS.length >= 6);
  const ids = new Set();
  for (const c of CARDS) {
    assert.ok(c.id && !ids.has(c.id));
    ids.add(c.id);
    for (const k of ["question", "where", "answer"]) assert.ok(typeof c[k] === "string" && c[k].length > 10, `${c.id}.${k}`);
    if (c.esr !== undefined) {
      assert.equal(typeof c.esr, "bigint");
      if (c.expect) for (const [k, v] of Object.entries(c.expect)) assert.equal(M.decode(c.esr)[k], v, `${c.id}: ${k}`);
    }
  }
  // The three questions the primer promises.
  const qs = CARDS.map((c) => c.question).join("\n");
  assert.match(qs, /SCTLR_EL1\.A/);
  assert.match(qs, /0b100001/);
  assert.match(qs, /DRIVER_OK/);
});

// ---------------------------------------------------------------------------------------------
// What the VMM does: it must match the reference, crates/vmm/src/vcpu/exit.rs and vcpu/mmio.rs

const exitRs = join(repoDir, "crates/vmm/src/vcpu/exit.rs");

test("every match arm the panel shows is copied from exit.rs", { skip: existsSync(exitRs) ? false : "exit.rs not present" }, () => {
  const norm = (t) => t.replace(/^\s*\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
  const src = norm(readFileSync(exitRs, "utf8"));
  const exits = [
    M.decode(0x93890046n), M.decode(0x5a000000n), M.decode(0x5e000003n), M.decode(0x6230e499n),
    M.decode(0x07e00000n), M.decode(0x82000006n), M.fromHv("canceled", 0n), M.fromHv("vtimer", 0n),
  ];
  for (const exit of exits) {
    for (const arm of M.vmmAction(exit).arm.split("\n// ...\n")) {
      assert.ok(src.includes(norm(arm)), `${exit.kind}: arm not found in exit.rs:\n${arm}`);
    }
  }
});

test("ISV = 1: the panel says the IPA decides, and chapter 05's stop was fatal", () => {
  const a = M.vmmAction(M.decode(0x93890046n));
  assert.match(a.does, /If a device lives there/);
  assert.match(a.does, /--unhandled-mmio policy decides: fatal by default, as in chapter 05's stop/);
  assert.match(a.does, /inside RAM is a VMM bug/);
  assert.match(a.pc, /if the policy is fatal, or the IPA is RAM, the VM stops/);
  assert.match(a.note, /chapter 21/);
  const p = M.PRESETS.find((x) => x.id === "ch05-stop");
  assert.match(p.note, /0xc000000/);
  assert.match(p.note, /exit code 3/);
  const cap = readFileSync(join(capturesDir, "05-poke-fatal.txt"), "utf8");
  assert.match(cap, /^exit: 3$/m);
  assert.match(cap, /guest fatal: unhandled MMIO write at 0xc000000 size 4/);
});

test("ISV = 0: chapter 07 stops, the reference emulates or injects an abort", () => {
  const a = M.vmmAction(M.decode(0x92000046n));
  assert.match(a.does, /Chapter 07's VMM stops/);
  assert.match(a.does, /synchronous external abort/);
  assert.match(a.pc, /^Chapter 07's VMM: nothing, the VM stops\. The reference \(chapter 21\): adds 4/);
  assert.ok(a.links.some((l) => l.href.includes("/firmware/firmware/#where-the-note-runs-out")));
});

test("S1PTW = 1: no instruction sentence, and ISV = 1 with it is flagged as impossible", () => {
  const s = M.summary(M.decode(0x93ca8085n), 0x93ca8085n);
  assert.doesNotMatch(s, /Write of|Read of/);
  assert.match(s, /The note describes the walk, not an instruction/);
  assert.match(s, /Real hardware never sets ISV = 1 with S1PTW = 1/);
  const s0 = M.summary(M.decode(0x920a8085n & ~(1n << 24n)), 0x920a8085n);
  assert.doesNotMatch(s0, /Real hardware never/);
  // SAS = 3 with SF = 0 is flagged; with SF = 1 it is not.
  assert.match(M.summary(M.decode(0x93c90046n), 0x93c90046n), /No A64 instruction produces this/);
  assert.doesNotMatch(M.summary(M.decode(0x93c18046n), 0x93c18046n), /No A64 instruction/);
});

test("IL is fixed at 1, not a length, where the ARM ARM's IL description says so", () => {
  const il = (esr) => M.layout(esr).find((f) => f.key === "il").meaning;
  const fixed = /^1: fixed at 1 for this class \(the ARM ARM's IL description\), not an instruction length$/;
  assert.equal(il(0x93890046n), "32-bit instruction", "data abort, ISV = 1");
  assert.match(il(0x92000046n), fixed, "data abort, ISV = 0");
  assert.match(il(0x82000006n), fixed, "instruction abort");
  assert.match(il(0xbe000000n), fixed, "SError");
  assert.match(il(0x02000000n), fixed, "EC 0x00, unknown reason");
  assert.match(il(0xc2000000n), fixed, "EC 0x30, breakpoint");
  for (let ec = 0x30; ec <= 0x35; ec++) assert.match(il(BigInt(ec) << 26n | (1n << 25n)), fixed, `EC ${ec}`);
  assert.equal(il(0xf2000000n), "32-bit instruction", "BRK keeps its normal meaning");
  assert.equal(il(0x5a000000n), "32-bit instruction", "HVC");
  assert.match(il(0x80000006n), /^0: .*not an instruction length$/, "instruction abort with IL clear");
  for (const t of [il(0x92000046n), il(0x80000006n)]) assert.doesNotMatch(t, /RES1/);
});

test("setField and the field action are total: NaN, Infinity and BigInt values", () => {
  const s0 = M.initialState(null);
  for (const value of [Infinity, -Infinity, NaN, "x", undefined, null, {}]) {
    const s = M.step(s0, { type: "field", lo: 0, width: 6, value });
    assert.equal(M.field(s.esr, 0, 6), 0, String(value));
  }
  assert.equal(M.setField(0n, 0, 64, (1n << 60n) + 1n), (1n << 60n) + 1n, "a BigInt is exact past 2^53");
  assert.equal(M.step(s0, { type: "field", lo: 32, width: 32, value: 0xffffffffn }).esr >> 32n, 0xffffffffn);
});

test("sign extension that no instruction can produce is flagged", () => {
  const flag = /only a load narrower than its register sign-extends \(ldrsb, ldrsh, ldrsw\)/;
  assert.match(M.summary(M.decode(0x93a00006n), 0x93a00006n), flag, "SAS 2, SSE 1, SF 0");
  assert.match(M.summary(M.decode(0x93e08006n), 0x93e08006n), flag, "SAS 3, SSE 1, SF 1");
  assert.doesNotMatch(M.summary(M.decode(0x93a08006n), 0x93a08006n), flag, "ldrsw x0: SAS 2, SSE 1, SF 1");
  assert.doesNotMatch(M.summary(M.decode(0x93620006n), 0x93620006n), flag, "ldrsh w2");
  assert.doesNotMatch(M.summary(M.decode(0x93a00046n), 0x93a00046n), flag, "SSE on a store is ignored");
});

test("S1PTW: a hole only for a translation fault", () => {
  assert.match(M.summary(M.decode(0x930000c6n), 0x930000c6n), /walk hit a hole/);
  const perm = M.summary(M.decode(0x930000cfn), 0x930000cfn);
  assert.doesNotMatch(perm, /hole/);
  assert.match(perm, /walk was refused by stage 2 \(see the fault code\)/);
  assert.doesNotMatch(M.vmmAction(M.decode(0x920000cfn)).does, /hole/);
  assert.match(M.summary(M.decode(0x82000086n), 0x82000086n), /walk hit a hole, not the fetch/);
  assert.match(M.summary(M.decode(0x8200008bn), 0x8200008bn), /refused by stage 2/);
});

test("FnV: RES0 except for a synchronous external abort, and never the source of the IPA", () => {
  const fnv = (esr) => M.layout(esr).find((f) => f.key === "fnv").meaning;
  assert.match(fnv(0x93890046n), /^0: RES0 for this fault code/);
  assert.match(fnv(0x93890046n), /HPFAR_EL2/);
  assert.match(fnv(0x93890010n), /^0: FAR_EL2 holds the faulting virtual address\. The IPA the VMM uses comes from the exit's physical_address/);
  assert.match(fnv(0x93890410n), /^1: FAR_EL2 does not hold/);
  assert.match(M.summary(M.decode(0x93890406n), 0x93890406n), /FnV = 1, but FnV is RES0 for this fault code/);
  assert.match(M.summary(M.decode(0x93890410n), 0x93890410n), /FnV = 1: FAR_EL2 .* is not valid/);
});

test("a non-exception exit reason greys every row", () => {
  for (const reason of ["canceled", "vtimer", "unknown"]) {
    const v = M.view({ esr: 0x93890046n, reason, text: "", error: null });
    assert.ok(v.fields.every((f) => !f.used && /exit reason/.test(f.meaning)), reason);
  }
  assert.ok(M.view({ esr: 0x93890046n, reason: "exception", text: "", error: null }).fields.some((f) => f.used));
  assert.match(M.summary(M.fromHv("vtimer", 0n), 0n), /interrupt controller Hypervisor\.framework emulates/);
});

test("parseFieldValue: hex by default, 0b binary, masked values say so", () => {
  assert.deepEqual(M.parseFieldValue("0x16", 6, "EC"), { ok: true, value: 0x16, masked: false, message: "" });
  assert.equal(M.parseFieldValue("16", 6, "EC").value, 0x16, "bare digits are hex, as in the course");
  assert.equal(M.parseFieldValue("0b10110", 6, "EC").value, 0x16);
  assert.equal(M.parseFieldValue(" 0x1_f ", 5, "SRT").value, 31);
  const m = M.parseFieldValue("4", 2, "SAS");
  assert.equal(m.ok, true);
  assert.equal(m.value, 0);
  assert.equal(m.masked, true);
  assert.equal(m.message, "SAS is 2 bits: 0x0 to 0x3. 0x4 was masked to 0x0 (only its low 2 bits fit).");
  for (const bad of ["", "0x", "-1", "0xg", "0b2", "1.5", "x".repeat(41), null]) {
    const r = M.parseFieldValue(bad, 6, "EC");
    assert.equal(r.ok, false, String(bad));
    assert.equal(typeof r.error, "string");
  }
  assert.equal(M.parseFieldValue("1", 0).ok, false);
});

test("register numbers take decimal: chapter 07's \"set SRT to 31\" gives the zero register", () => {
  const srt = M.layout(0x93890046n).find((f) => f.key === "srt");
  assert.equal(srt.radix, 10);
  assert.equal(M.layout(0x93890046n).find((f) => f.key === "dfsc").radix, 16);
  assert.equal(M.layout(0x6230e499n).find((f) => f.key === "rt").radix, 10);
  const p = M.parseFieldValue("31", 5, "SRT", srt.radix);
  assert.deepEqual(p, { ok: true, value: 31, masked: false, message: "" });
  const s = M.step(M.initialState(null), { type: "field", lo: 16, width: 5, value: p.value });
  assert.match(M.summary(M.decode(s.esr), s.esr), /Write of 4 bytes from wzr \(register 31 is the zero register here, never sp\)/);
  assert.equal(M.parseFieldValue("0x1f", 5, "SRT", 10).value, 31, "0x still means hex");
  assert.equal(M.parseFieldValue("0b11111", 5, "SRT", 10).value, 31);
  assert.equal(M.fieldText(31, 10), "31");
  assert.equal(M.fieldText(31, 16), "0x1f");
  const big = M.parseFieldValue("40", 5, "SRT", 10);
  assert.equal(big.message, "SRT is 5 bits: 0 to 31. 40 was masked to 8 (only its low 5 bits fit).");
  assert.equal(M.parseFieldValue("1f", 5, "SRT", 10).ok, false);
  assert.match(M.parseFieldValue("1f", 5, "SRT", 10).error, /not a decimal digit/);
  // A hex field still reads bare digits as hex, and hints when decimal was likely meant.
  const ec = M.parseFieldValue("36", 6, "EC");
  assert.equal(ec.value, 0x36);
  assert.equal(ec.masked, false);
  const hint = M.parseFieldValue("31", 5, "imm", 16);
  assert.equal(hint.value, 0x11);
  assert.match(hint.message, /for decimal 31, type 0x1f\.$/);
});

test("the SCTLR_EL1.A card agrees with chapter 06", () => {
  const c = CARDS.find((x) => x.id === "sctlr-a");
  assert.doesNotMatch(c.answer, /trips it/);
  assert.match(c.answer, /even with A = 0/);
});
