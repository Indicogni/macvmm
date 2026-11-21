// Tests for the sysreg-smccc lab's model. Run: node --test course/site/
//
// The model must reproduce the numbers the smccc primer and chapter 08 quote, print exactly what
// the reference printed in the real captures, agree with crates/vmm/src/smccc.rs,
// crates/vmm/src/arch/sysreg.rs, crates/hvf/src/regs.rs and the shared ESR vectors, and never
// throw on any input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "./model.mjs";
import { SYSREG_NAMES } from "./sysregs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const siteDir = join(here, "..", "..", "..");
const courseDir = join(siteDir, "..");
const repoDir = join(courseDir, "..");
const capturesDir = join(courseDir, "captures");
const vectorsPath = join(siteDir, "labs", "vectors", "esr.json");
const read = (p) => readFileSync(join(repoDir, p), "utf8");
const has = (p) => existsSync(join(repoDir, p));
const skipUnless = (p) => (has(p) ? false : `${p} not present`);

const call = (x0, extra = {}) => ({ x0: BigInt(x0), x1: 0n, conduit: "hvc", imm: 0, guest: "test", ...extra });

// ---------------------------------------------------------------------------------------------
// The smccc primer's numbers

test("primer: 0x8400_0008 decodes to fast=1 wide=0 owner=4 func=8, SYSTEM_OFF", () => {
  const d = M.decodeCall(0x8400_0008n);
  assert.deepEqual([d.fast, d.wide, d.oen, d.func], [true, false, 4, 8]);
  assert.equal(d.name, "PSCI_SYSTEM_OFF");
  assert.equal(d.owner, "Standard secure service calls");
  const a = M.macvmmAnswer(call(0x8400_0008));
  assert.equal(a.stop, "guest powered off");
  assert.equal(a.exitCode, "0");
});

test("primer: DEBUG_PUTC from its fields is 0xC6004D01 (the primer's checkpoint command)", () => {
  assert.equal(M.encodeFid({ fast: true, wide: true, oen: 6, func: 0x4d01 }), 0xc600_4d01);
  assert.equal(((1 << 31) | (1 << 30) | (6 << 24) | 0x4d01) >>> 0, 0xc600_4d01);
  assert.equal(M.groupedHex(0xc600_4d01), "0xC600_4D01");
  assert.equal(M.decodeCall(0xc600_4d01n).name, "DEBUG_PUTC");
});

test("primer self-checks: 0xC400_0004, 0x8000_0001 and x0 with its upper half set", () => {
  const d = M.decodeCall(0xc400_0004n);
  assert.deepEqual([d.fast, d.wide, d.oen, d.func, d.name], [true, true, 4, 4, "PSCI_AFFINITY_INFO"]);
  assert.equal(M.encodeFid({ fast: true, wide: false, oen: 0, func: 1 }), 0x8000_0001);
  assert.equal(M.decodeCall(0x8000_0001n).name, "SMCCC_ARCH_FEATURES");
  const u = M.decodeCall(0xffff_ffff_8400_0000n);
  assert.equal(u.name, "PSCI_VERSION");
  assert.ok(u.upperIgnored);
  assert.equal(M.macvmmAnswer(call(0xffff_ffff_8400_0000n)).x0, 0x1_0001n);
});

test("primer: owners 0, 4 and 6, and CPU_ON's two widths", () => {
  assert.equal(M.oenName(0), "Arm architecture calls");
  assert.equal(M.oenName(6), "Vendor-specific hypervisor service calls");
  assert.equal(M.decodeCall(0x8400_0003n).name, "PSCI_CPU_ON");
  assert.equal(M.decodeCall(0xc400_0003n).name, "PSCI_CPU_ON");
  for (let o = 0; o < 64; o++) assert.notEqual(M.oenName(o), "not an owner number");
});

test("primer: the vendor block HVF answers itself, and Call UID gets a quiet -1", () => {
  const h = M.macvmmAnswer(call(0xc600_0001));
  assert.equal(h.by, "hvf");
  assert.equal(h.x0, 0xffff_ffffn);
  assert.equal(M.macvmmAnswer(call(0xc600_001f)).by, "hvf");
  assert.equal(M.macvmmAnswer(call(0xc600_0020)).by, "macvmm");
  const uid = M.macvmmAnswer(call(0x8600_ff01, { guest: "os" }));
  assert.equal(uid.x0, 0xffff_ffff_ffff_ffffn);
  assert.equal(uid.warn, null);
  assert.equal(M.decodeCall(0x8600_ff01n).name, "VENDOR_HYP_CALL_UID");
});

test("rule checks: a fast call with bits 23..16 set is flagged; a yielding call is noted", () => {
  const bad = M.fidFlags(0xb07d_f10c);
  assert.ok(bad.some((f) => f.level === "error" && /bits 23 to 16 are 0x7d/.test(f.text)));
  assert.ok(M.fidFlags(0x0400_0008).some((f) => /yielding/.test(f.text)));
  assert.ok(M.fidFlags(0x8401_0008).some((f) => f.level === "note" && /Bit 16/.test(f.text)));
  assert.equal(M.fidFlags(0x8400_0008).length, 0);
  assert.ok(M.fidFlags(0xc400_0008).some((f) => /0x8400_0008 is PSCI_SYSTEM_OFF/.test(f.text)));
});

test("conduits: the PC rule differs for hvc and smc", () => {
  assert.match(M.macvmmAnswer(call(0x8400_0000)).pc, /past the hvc/);
  assert.match(M.macvmmAnswer(call(0x8400_0000, { conduit: "smc" })).pc, /adds 4/);
});

test("debug calls answer only for test guests; PSCI_FEATURES agrees", () => {
  assert.equal(M.macvmmAnswer(call(0xc600_4d01, { x1: 0x48n })).x0, 0n);
  const os = M.macvmmAnswer(call(0xc600_4d01, { guest: "os" }));
  assert.equal(os.warn, "unknown SMCCC function 0xc6004d01; returning -1");
  assert.equal(M.macvmmAnswer(call(0x8400_000a, { x1: 0xc600_4d01n })).x0, 0n);
  assert.equal(M.macvmmAnswer(call(0x8400_000a, { x1: 0xc600_4d01n, guest: "os" })).x0, 0xffff_ffff_ffff_ffffn);
  // A 32-bit call sees only w1: the upper half of x1 is ignored.
  assert.equal(M.macvmmAnswer(call(0x8400_000a, { x1: 0xdead_0000_8400_0000n })).x0, 0n);
  assert.equal(M.macvmmAnswer(call(0xc600_4d02, { x1: 3n })).exitCode, "6");
  assert.equal(M.macvmmAnswer(call(0xc600_4d02, { x1: 0n })).exitCode, "0");
});

// ---------------------------------------------------------------------------------------------
// The real captures

test("psci-probe's answers (captures/08-psci-probe.txt) come out of the model", () => {
  const text = readFileSync(join(capturesDir, "08-psci-probe.txt"), "utf8");
  const val = (re) => re.exec(text)[1];
  const reg = (v) => (v === "-1" ? 0xffff_ffff_ffff_ffffn : BigInt(v));
  assert.equal(M.macvmmAnswer(call(0x8400_0000)).x0, reg(val(/version=(0x[0-9a-f]+) ok/)));
  assert.equal(M.macvmmAnswer(call(0x8000_0000)).x0, reg(val(/smccc_version=(0x[0-9a-f]+) ok/)));
  for (const cpuOn of [0x8400_0003n, 0xc400_0003n]) {
    assert.equal(M.macvmmAnswer(call(0x8400_000a, { x1: cpuOn })).x0, reg(val(/features\(CPU_ON\)=(-?\d+) ok/)));
  }
  assert.equal(M.macvmmAnswer(call(0x8400_000a, { x1: 0x8400_0099n })).x0, reg(val(/features\(0x84000099\)=(-?\d+) ok/)));
  assert.equal(M.macvmmAnswer(call(0x8200_0000)).x0, reg(val(/sip\(0x82000000\)=(-?\d+) ok/)));
  assert.equal(M.macvmmAnswer(call(0x8400_0006)).x0, reg(val(/migrate_info_type=(\d+) ok/)));
});

test("every SMCCC warning in every capture is the model's warning, word for word", () => {
  let n = 0;
  for (const f of readdirSync(capturesDir)) {
    for (const line of readFileSync(join(capturesDir, f), "utf8").split(/\r?\n/)) {
      const u = /guest: (unknown SMCCC function (0x[0-9a-f]+); returning -1)/.exec(line);
      if (u) {
        const a = M.macvmmAnswer(call(BigInt(u[2])));
        assert.equal(a.warn, u[1], `${f}: ${line}`);
        n++;
      }
      const i = /guest: (hvc\/smc with immediate (0x[0-9a-f]+) is not SMCCC; returning -1)/.exec(line);
      if (i) {
        const a = M.macvmmAnswer(call(0x8400_0000, { imm: parseInt(i[2], 16) }));
        assert.equal(a.warn, i[1], `${f}: ${line}`);
        n++;
      }
    }
  }
  assert.ok(n >= 20, `expected many warnings in the captures, found ${n}`);
});

test("the trace's fn names (08-hvc-conduit, 08-smc-conduit) are the model's names", () => {
  for (const f of ["08-hvc-conduit.txt", "08-smc-conduit.txt"]) {
    const text = readFileSync(join(capturesDir, f), "utf8");
    const fns = [...text.matchAll(/"fn":"([A-Z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(fns, ["PSCI_VERSION", "PSCI_FEATURES", "PSCI_FEATURES"]);
    assert.ok(M.FUNCTIONS.some(([, n]) => n === "PSCI_VERSION"));
  }
  assert.ok(M.isPsci(0x8400_0000) && M.isPsci(0xc400_001f) && !M.isPsci(0x8400_0020) && !M.isPsci(0x8000_0000));
});

// The sysreg captures: the raw syndromes (08-sysreg-esr.txt, --irqchip none) and the default
// run's trace (08-sysreg-default.txt) share the probe's PCs.
function sysregCaptures() {
  const esrText = readFileSync(join(capturesDir, "08-sysreg-esr.txt"), "utf8");
  const traps = [...esrText.matchAll(/sysreg trap: esr=(0x[0-9a-f]+) pc=(0x[0-9a-f]+)/g)].map((m) => ({ esr: parseInt(m[1], 16), pc: m[2] }));
  const defText = readFileSync(join(capturesDir, "08-sysreg-default.txt"), "utf8");
  const trace = defText
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  return { esrText, traps, trace };
}

test("chapter 08: 0x6230e419 is (3, 3, 9, 12, 0), PMCR_EL0, read into x0, sysreg_enc 0xdce0", () => {
  const a = M.analyzeWord(0x6230_e419);
  assert.equal(a.as, "esr");
  assert.deepEqual(a.fields, { op0: 3, op1: 3, crn: 9, crm: 12, op2: 0, rt: 0, read: true });
  assert.equal(a.name, "PMCR_EL0");
  assert.equal(a.enc, 0xdce0);
  assert.equal(a.asm, "mrs x0, PMCR_EL0");
  assert.equal(a.policy.outcome, "undef");
  assert.equal(a.insn, 0xd53b_9c00);
});

test("chapter 08's exercise: 0x62280520 is (2, 0, 1, 0, 4), Rt 9, direction 0, msr OSLAR_EL1, x9", () => {
  const a = M.analyzeWord(0x6228_0520);
  assert.deepEqual(a.fields, { op0: 2, op1: 0, crn: 1, crm: 0, op2: 4, rt: 9, read: false });
  assert.equal(a.asm, "msr OSLAR_EL1, x9");
  assert.equal(a.policy.outcome, "written");
  assert.equal(M.analyzeWord(0xd510_1089).esr, 0x6228_0520);
});

test("every raw syndrome in 08-sysreg-esr.txt names the register the trace names, with the same enc", () => {
  const { esrText, traps, trace } = sysregCaptures();
  assert.equal(traps.length, 6);
  let matched = 0;
  for (const t of traps) {
    const a = M.analyzeWord(t.esr);
    assert.ok(a.ok);
    assert.equal(M.encodeSyndrome(a.fields), t.esr, "re-encodes to the same syndrome");
    const rec = trace.find((r) => r.pc === t.pc);
    if (rec) {
      assert.equal(a.name, rec.sysreg, t.pc);
      assert.equal(M.rustHex(a.enc), rec.sysreg_enc, t.pc);
      assert.equal(a.policy.outcome === "undef" ? "inject_undef" : "sysreg", rec.action, t.pc);
      if (rec.value !== undefined && a.fields.read && a.name !== "OSLSR_EL1") assert.equal(M.rustHex(a.policy.value), rec.value);
      matched++;
    }
  }
  assert.equal(matched, 5, "LORID_EL1, OSLAR_EL1 x2, OSLSR_EL1 x2 appear in both runs");
  // The one that reached us only without the GIC: its warning names it.
  const warn = /vcpu0: (MRS PMCR_EL0 at pc (0x[0-9a-f]+): injecting UNDEF)/.exec(esrText);
  const t = traps.find((x) => x.pc === warn[2]);
  assert.equal(M.analyzeWord(t.esr).warn.replace("<pc>", warn[2]), warn[1]);
});

test("the OS lock reads 0xa from cold reset, as the default trace shows; MDCCSR_EL0 warns like the capture", () => {
  const { trace } = sysregCaptures();
  const first = trace.find((r) => r.sysreg === "OSLSR_EL1");
  const lsr = M.describe({ op0: 2, op1: 0, crn: 1, crm: 1, op2: 4, rt: 0, read: true });
  assert.equal(first.value, M.rustHex(lsr.policy.value));
  const text = readFileSync(join(capturesDir, "08-sysreg-default.txt"), "utf8");
  const w = /vcpu0: (MRS MDCCSR_EL0 at pc (0x[0-9a-f]+): injecting UNDEF)/.exec(text);
  const md = M.describe({ ...M.lookupRegister("MDCCSR_EL0"), rt: 8, read: true });
  assert.equal(md.warn.replace("<pc>", w[2]), w[1]);
  assert.match(md.reach.nogic, /HVF returns 0/);
  assert.match(M.describe({ ...M.lookupRegister("PMCR_EL0"), rt: 0, read: true }).reach.def, /HVF raises the UNDEF/);
});

test("every SysReg vector in labs/vectors/esr.json decodes as macvmm decodes it", { skip: existsSync(vectorsPath) ? false : "labs/vectors/esr.json not exported yet" }, () => {
  const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8"));
  const sys = vectors.filter((v) => v.exit === "SysReg");
  assert.ok(sys.length >= 1);
  for (const v of sys) {
    const esr = Number(BigInt(v.esr) & 0xffff_ffffn);
    const f = M.decodeSyndromeFields(esr);
    for (const k of ["op0", "op1", "crn", "crm", "op2", "rt", "read"]) assert.equal(f[k], v.fields[k], `${v.name}: ${k}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Instruction words

test("every named register round-trips through the instruction word and the syndrome", () => {
  let n = 0;
  for (const name of M.registerNames()) {
    const c = M.lookupRegister(name);
    if (c.op0 < 2) continue; // not reachable by mrs/msr
    for (const readDir of [true, false]) {
      for (const rt of [0, 9, 31]) {
        const f = { ...c, rt, read: readDir };
        const w = M.encodeInsn(f);
        const a = M.analyzeWord(w);
        assert.equal(a.as, "insn");
        assert.deepEqual(a.fields, f, name);
        assert.equal(a.name, name);
        const e = M.analyzeWord(a.esr);
        assert.equal(e.as, "esr");
        assert.deepEqual(e.fields, f);
        n++;
      }
    }
  }
  assert.ok(n > 500);
});

test("known instruction words: mrs/msr spellings, xzr, and words that are not register moves", () => {
  assert.equal(M.analyzeWord(0xd53b_9c00).asm, "mrs x0, PMCR_EL0");
  assert.equal(M.analyzeWord(0xd533_0108).asm, "mrs x8, MDCCSR_EL0");
  assert.equal(M.analyzeWord(0xd538_f000).asm, "mrs x0, S3_0_C15_C0_0");
  assert.equal(M.analyzeWord(0xd538_f000).named, false);
  assert.equal(M.analyzeWord(0xd518_c01f).asm, "msr VBAR_EL1, xzr");
  assert.match(M.analyzeWord(0xd400_0002).error, /hvc #0x0/);
  assert.match(M.analyzeWord(0xd400_0001).error, /svc #0x0/);
  assert.match(M.analyzeWord(0xd503_3fdf).error, /hint, a barrier/);
  assert.match(M.analyzeWord(0xd508_751f).error, /sys or sysl/); // ic iallu: op0 = 1
  assert.match(M.analyzeWord(0x1234_5678).error, /Not an mrs or msr/);
  assert.match(M.analyzeWord(0x5a00_0000).error, /Not an mrs/); // auto reads it as an instruction
  assert.match(M.analyzeWord(0x5a00_0000, "esr").error, /hvc/);
  assert.match(M.analyzeWord(0xd53b_9c00, "esr").error, /not 0x18/);
});

test("register lookup by name and by the generic spelling", () => {
  assert.deepEqual(M.lookupRegister("pmcr_el0"), { op0: 3, op1: 3, crn: 9, crm: 12, op2: 0 });
  assert.deepEqual(M.lookupRegister("S3_0_C15_C0_0"), { op0: 3, op1: 0, crn: 15, crm: 0, op2: 0 });
  assert.equal(M.lookupRegister("S3_0_C16_C0_0"), null);
  assert.equal(M.lookupRegister("NOPE"), null);
  assert.equal(M.lookupRegister("x".repeat(100)), null);
  assert.equal(M.fieldError({ op0: 1, op1: 0, crn: 0, crm: 0, op2: 0, rt: 0 }) !== null, true);
  assert.equal(M.fieldError({ op0: 3, op1: 0, crn: 0, crm: 0, op2: 0, rt: 32 }) !== null, true);
  assert.equal(M.fieldError({ op0: 3, op1: 0, crn: 0, crm: 0, op2: 0, rt: 31 }), null);
});

test("policy outcomes follow sysreg::handle, including direction", () => {
  const out = (name, readDir) => M.policyOutcome(M.lookupRegister(name), readDir).outcome;
  assert.equal(out("OSLAR_EL1", true), "undef");
  assert.equal(out("OSLAR_EL1", false), "written");
  assert.equal(out("OSLSR_EL1", false), "undef");
  assert.equal(out("OSDLR_EL1", true), "read");
  assert.equal(out("LORID_EL1", true), "read");
  assert.equal(out("LORID_EL1", false), "undef");
  assert.equal(out("LORC_EL1", false), "written");
  assert.equal(out("MDSCR_EL1", true), "read");
  assert.equal(out("DBGWCR15_EL1", false), "written");
  assert.equal(out("PMUSERENR_EL0", true), "undef");
  assert.equal(out("MDCCSR_EL0", true), "undef");
  assert.equal(M.policyOutcome({ op0: 3, op1: 0, crn: 10, crm: 4, op2: 4 }, true).outcome, "undef"); // MPAMIDR, not LOR
});

// ---------------------------------------------------------------------------------------------
// Drift checks against the Rust sources

test("sysregs.mjs matches crates/hvf/src/regs.rs and sysreg.rs OBSERVED_NAMES", { skip: skipUnless("crates/hvf/src/regs.rs") }, () => {
  const want = {};
  for (const m of read("crates/hvf/src/regs.rs").matchAll(/^\s*([A-Z][A-Z0-9_]*) = \((\d+), (\d+), (\d+), (\d+), (\d+)\),/gm)) {
    const k = m.slice(2, 7).join(",");
    if (!(k in want)) want[k] = m[1];
  }
  const sys = read("crates/vmm/src/arch/sysreg.rs");
  const obs = sys.slice(sys.indexOf("pub const OBSERVED_NAMES"));
  let nObs = 0;
  for (const m of obs.slice(0, obs.indexOf("];")).matchAll(/\("([A-Z0-9_]+)", SysReg::new\((\d+), (\d+), (\d+), (\d+), (\d+)\)\)/g)) {
    const k = m.slice(2, 7).join(",");
    if (!(k in want)) want[k] = m[1];
    nObs++;
  }
  assert.ok(nObs >= 6 && Object.keys(want).length > 150);
  assert.deepEqual({ ...SYSREG_NAMES }, want);
});

test("POLICY matches sysreg.rs's table, row for row", { skip: skipUnless("crates/vmm/src/arch/sysreg.rs") }, () => {
  const src = read("crates/vmm/src/arch/sysreg.rs");
  const block = src.slice(src.indexOf("pub const POLICY: &[Rule] = &["), src.indexOf("// ANCHOR_END: sysreg_policy_table"));
  const rows = [];
  const re = /(one|span)\(\s*"([^"]+)",\s*\(([\d, ]+)\),\s*(?:\((\d+), (\d+)\),\s*\((\d+), (\d+)\),\s*)?Policy::(\w+),?\s*\)/g;
  for (const m of block.matchAll(re)) {
    const nums = m[3].split(",").map((x) => Number(x.trim()));
    if (m[1] === "one") rows.push({ what: m[2], op0: nums[0], op1: nums[1], crn: nums[2], crm: [nums[3], nums[3]], op2: [nums[4], nums[4]], policy: m[8] });
    else rows.push({ what: m[2], op0: nums[0], op1: nums[1], crn: nums[2], crm: [Number(m[4]), Number(m[5])], op2: [Number(m[6]), Number(m[7])], policy: m[8] });
  }
  assert.equal(rows.length, 11);
  assert.deepEqual(M.POLICY.map((r) => ({ ...r })), rows);
});

test("FUNCTIONS, PROBES and the dispatcher's arms match crates/vmm/src/smccc.rs", { skip: skipUnless("crates/vmm/src/smccc.rs") }, () => {
  const src = read("crates/vmm/src/smccc.rs");
  const consts = {};
  for (const m of src.matchAll(/pub const ([A-Z0-9_]+): u32 = (0x[0-9A-Fa-f_]+);/g)) consts[m[1]] = parseInt(m[2].replace(/_/g, ""), 16) >>> 0;
  const fnBlock = src.slice(src.indexOf("const FUNCTIONS"), src.indexOf("];", src.indexOf("const FUNCTIONS")));
  const fns = [...fnBlock.matchAll(/\(([A-Z0-9_]+), "([A-Z_0-9]+)", (true|false)\)/g)].map((m) => [consts[m[1]], m[2], m[3] === "true"]);
  assert.equal(fns.length, 18);
  assert.deepEqual(M.FUNCTIONS.map((r) => [...r]), fns);
  const prBlock = src.slice(src.indexOf("pub const PROBES"), src.indexOf("];", src.indexOf("pub const PROBES")));
  const probes = [...prBlock.matchAll(/\(\s*([A-Z0-9_]+),\s*"([A-Z_0-9]+)",/g)].map((m) => [consts[m[1]], m[2]]);
  assert.deepEqual(M.PROBES.map((r) => [...r]), probes);
  // The warning texts the model prints are the dispatcher's format strings.
  assert.ok(src.includes('"unknown SMCCC function {fid:#x}; returning -1"'));
  assert.ok(src.includes('"hvc/smc with immediate {:#x} is not SMCCC; returning -1"'));
  assert.ok(src.includes("pub const VERSION_1_1: u64 = 0x0001_0001;"));
  assert.ok(src.includes("pub const MIGRATE_NO_TRUSTED_OS: u64 = 2;"));
  assert.ok(/0xC600_0000\.\.=0xC600_001F/.test(src), "the HVF-answered block is still documented");
});

// ---------------------------------------------------------------------------------------------
// State, share hash, totality

test("share hash: reference string, round trips, and hostile strings rejected", () => {
  assert.equal(M.encode(M.initialState()), "s_ad53b9c00_84000008");
  assert.deepEqual(M.decode("s_ad53b9c00_84000008"), M.initialState());
  let s = M.initialState();
  s = M.step(s, { type: "callPreset", id: "smc" });
  s = M.step(s, { type: "imm", value: 0x4d56 });
  s = M.step(s, { type: "guest", value: "os" });
  s = M.step(s, { type: "x1", value: 0xc400_0003n });
  s = M.step(s, { type: "sysPreset", id: "esr-oslar" });
  s = M.step(s, { type: "mode", value: "esr" });
  const h = M.encode(s);
  assert.equal(h, "r_e62280520_84000009_smc_i4d56_os_ac4000003");
  assert.deepEqual(M.decode(h), s);
  for (const bad of [null, "", "x", "s_ad53b9c00", "s_ad53b9c00_84000008_smc_smc", "s_zd53b9c00_1", "s_ad53b9c00_12345678901234567", "s_ad53b9c00_1_i12345", "<img src=x>", "s_ad53b9c00_1_" + "a".repeat(90)]) {
    assert.equal(M.decode(bad), null, String(bad));
  }
});

test("step: builder fields, bit toggles and invalid actions", () => {
  let s = M.initialState();
  s = M.step(s, { type: "fid", field: "wide", value: true });
  assert.equal(s.call.x0, 0xc400_0008n);
  s = M.step(s, { type: "fid", field: "oen", value: 6 });
  s = M.step(s, { type: "fid", field: "func", value: 0x4d01 });
  assert.equal(s.call.x0, 0xc600_4d01n);
  s = M.step(s, { type: "bit", bit: 30 });
  assert.equal(s.call.x0, 0x8600_4d01n);
  const u = M.step(M.step(s, { type: "x0", value: 0xffff_ffff_0000_0000n }), { type: "fid", field: "fast", value: true });
  assert.equal(u.call.x0, 0xffff_ffff_8000_0000n, "the upper half of x0 is kept");
  for (const bad of [null, {}, { type: "bit", bit: 32 }, { type: "fid", field: "oen", value: 64 }, { type: "imm", value: 0x10000 }, { type: "word", value: -1 }, { type: "mode", value: "x" }, { type: "fields", fields: { op0: 0 } }, { type: "half", half: "x" }]) {
    assert.equal(M.step(s, bad), s);
  }
  let r = M.step(M.initialState(), { type: "sysPreset", id: "esr-pmcr" });
  r = M.step(r, { type: "fields", fields: { op0: 2, op1: 0, crn: 1, crm: 0, op2: 4, rt: 9, read: false } });
  assert.equal(r.sys.word, 0x6228_0520, "a syndrome stays a syndrome");
  r = M.step(M.initialState(), { type: "fields", fields: { op0: 2, op1: 0, crn: 1, crm: 0, op2: 4, rt: 9, read: false } });
  assert.equal(r.sys.word, 0xd510_1089, "an instruction stays an instruction");
});

test("parseHex accepts what readers type and rejects the rest", () => {
  assert.equal(M.parseHex("0x8400_0008").value, 0x8400_0008n);
  assert.equal(M.parseHex(" C600 4D01 ").value, 0xc600_4d01n);
  assert.equal(M.parseHex("0x0000000084000008").value, 0x8400_0008n);
  assert.equal(M.parseHex("0xffffffffffffffff", 64).value, 0xffff_ffff_ffff_ffffn);
  for (const bad of ["", "0x", "12g", "0x1_0000_0000", "-1", "0q1", "1.5", "x".repeat(100), undefined]) assert.ok(M.parseHex(bad).error, String(bad));
});

test("the model is total: random words, IDs and calls never throw", () => {
  let seed = 0x1234_5678;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0), seed);
  for (let i = 0; i < 20000; i++) {
    const w = rnd();
    for (const mode of ["auto", "insn", "esr"]) {
      const a = M.analyzeWord(w, mode);
      assert.ok(a.ok ? typeof a.asm === "string" : typeof a.error === "string");
    }
    const x0 = (BigInt(rnd()) << 32n) | BigInt(rnd());
    const c = { x0, x1: BigInt(rnd()), conduit: i & 1 ? "smc" : "hvc", imm: i % 7 === 0 ? rnd() & 0xffff : 0, guest: i & 2 ? "os" : "test" };
    const ans = M.macvmmAnswer(c);
    assert.ok(typeof ans.result === "string" && typeof ans.pc === "string");
    assert.equal(typeof M.callSummary(c), "string");
    assert.equal(typeof M.sysSummary({ word: w, mode: "auto" }), "string");
  }
});

test("every preset decodes without an error where it should", () => {
  for (const p of M.SYSREG_PRESETS) {
    const a = M.analyzeWord(p.word);
    assert.equal(a.ok, !["isb", "hvc"].includes(p.id), p.id);
  }
  for (const p of M.SMCCC_PRESETS) assert.equal(typeof M.callSummary({ ...M.initialState().call, ...p }), "string");
});

// ---------------------------------------------------------------------------------------------
// The lessons embed this lab

test("chapter 08 and the smccc primer embed the lab and describe it", () => {
  for (const p of ["course/chapters/III/08-traps-psci.md", "course/primers/smccc.md"]) {
    const md = read(p);
    assert.match(md, /^labs: \[[^\]]*sysreg-smccc[^\]]*\]$/m, p);
    assert.match(md, /^:::lab sysreg-smccc$/m, p);
  }
  assert.match(read("course/chapters/III/08-traps-psci.md"), /decodes an `mrs`\/`msr` instruction word into the register's coordinates and name/);
});

// ---------------------------------------------------------------------------------------------
// Review fixes: reach classes, yielding ranges, DEBUG_PUTC bytes, AFFINITY_INFO, HVF block paths

test("guest-state and ID registers are not reported as unmeasured, and never warn", () => {
  for (const [name, read] of [["MIDR_EL1", true], ["ID_AA64DFR0_EL1", true], ["TTBR0_EL1", false], ["SCTLR_EL1", false], ["VBAR_EL1", false], ["CNTV_CTL_EL0", true], ["ICC_IAR1_EL1", true], ["TTBR0_EL2", false]]) {
    const d = M.describe({ ...M.lookupRegister(name), rt: 0, read });
    assert.notEqual(d.reach.kind, "unknown", name);
    assert.ok(!/^Not measured/.test(d.reach.text), name);
    assert.equal(d.reach.exits, "no", name);
    assert.equal(d.warn, null, name);
    assert.equal(d.policy.hypothetical, true, name);
  }
  assert.equal(M.analyzeWord(0xd538_0000).reach.kind, "id"); // mrs x0, MIDR_EL1
  assert.equal(M.analyzeWord(0xd518_2000).reach.kind, "guest-state"); // msr TTBR0_EL1, x0
  assert.match(M.sysSummary({ word: 0xd518_2000, mode: "auto" }), /never reaches macvmm/);
  // Unlisted encodings stay unmeasured; the measured ones keep their warning.
  assert.equal(M.describe({ op0: 3, op1: 2, crn: 15, crm: 3, op2: 1, rt: 0, read: true }).reach.kind, "unknown");
  assert.equal(M.describe({ ...M.lookupRegister("MDCCSR_EL0"), rt: 8, read: true }).reach.exits, "yes");
  assert.equal(M.describe({ ...M.lookupRegister("PMCR_EL0"), rt: 0, read: true }).reach.exits, "nogic");
  assert.ok(M.describe({ ...M.lookupRegister("PMCR_EL0"), rt: 0, read: true }).warn);
});

test("HV_ACCESSIBLE_COUNT splits sysregs.mjs exactly where regs.rs's HV_ACCESSIBLE table ends", { skip: skipUnless("crates/hvf/src/regs.rs") }, () => {
  const src = read("crates/hvf/src/regs.rs");
  const block = src.slice(src.indexOf("sysregs!(HV_ACCESSIBLE"), src.indexOf("sysregs!(TRAP_ONLY"));
  const keys = [...block.matchAll(/^\s*[A-Z][A-Z0-9_]* = \((\d+), (\d+), (\d+), (\d+), (\d+)\),/gm)].map((m) => m.slice(1, 6).join(","));
  assert.equal(keys.length, 152);
  for (const k of keys) {
    const [op0, op1, crn, crm, op2] = k.split(",").map(Number);
    assert.ok(M.hvAccessible({ op0, op1, crn, crm, op2 }), k);
  }
  assert.ok(!M.hvAccessible(M.lookupRegister("PMCR_EL0")));
  assert.ok(!M.hvAccessible(M.lookupRegister("LORID_EL1")));
});

test("yielding calls name their DEN 0028 range, not a fast-call owner", () => {
  const d = M.decodeCall(0x0400_0008n);
  assert.equal(d.fast, false);
  assert.match(d.owner, /Trusted OS yielding calls/);
  assert.ok(!/Standard secure/.test(M.callSummary({ x0: 0x0400_0008n, x1: 0n, conduit: "hvc", imm: 0, guest: "test" })));
  assert.match(M.yieldingRange(0x0000_0001), /existing APIs/);
  assert.match(M.yieldingRange(0x2000_0000), /future use/);
  assert.equal(M.yieldingRange(0x8400_0008), null);
  assert.equal(M.decodeCall(0x8400_0008n).owner, "Standard secure service calls");
});

test("DEBUG_PUTC bytes follow the output filter's rules", () => {
  const r = (b) => M.macvmmAnswer({ x0: 0xc600_4d01n, x1: BigInt(b), conduit: "hvc", imm: 0, guest: "test" }).result;
  assert.match(r(0x48), /'H'/);
  for (const b of [0x08, 0x09, 0x0a, 0x0d]) assert.match(r(b), /passed through unchanged/, String(b));
  assert.match(r(0xc3), /first byte of a UTF-8 character/);
  assert.ok(!/control byte \(dropped/.test(r(0xc3)));
  assert.match(r(0x01), /dropped/);
  assert.match(r(0x7f), /dropped/);
});

test("AFFINITY_INFO mentions x2 and the 32-bit form", () => {
  const a32 = M.macvmmAnswer({ x0: 0x8400_0004n, x1: 0n, conduit: "hvc", imm: 0, guest: "test" }).result;
  assert.match(a32, /x2 \(the lowest affinity level; macvmm accepts only 0/);
  assert.match(a32, /w1 and w2/);
  assert.ok(!/w1 and w2/.test(M.macvmmAnswer({ x0: 0xc400_0004n, x1: 0n, conduit: "hvc", imm: 0, guest: "test" }).result));
});

test("HVF's private block over smc or another immediate is flagged as untested", () => {
  const hvc = M.macvmmAnswer({ x0: 0xc600_0001n, x1: 0n, conduit: "hvc", imm: 0, guest: "test" });
  assert.equal(hvc.by, "hvf");
  assert.equal(hvc.untested, null);
  for (const call of [{ conduit: "smc", imm: 0 }, { conduit: "hvc", imm: 5 }]) {
    const a = M.macvmmAnswer({ x0: 0xc600_0001n, x1: 0n, guest: "test", ...call });
    assert.equal(a.by, "macvmm");
    assert.match(a.untested, /measured only with hvc #0/);
  }
  assert.equal(M.macvmmAnswer({ x0: 0x8400_0008n, x1: 0n, conduit: "smc", imm: 0, guest: "test" }).untested, null);
});
