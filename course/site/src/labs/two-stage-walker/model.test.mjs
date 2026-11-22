// Tests for the two-stage-walker model. Every number a lesson or capture quotes for this lab is
// checked here: chapter 05's hand walk, the va-alias, mmio-poke and ipa-poke captures
// (course/captures/05-*.txt), the page-tables primer's worked example and its 24 reads, and the
// page-granules primer's index split. Run: node --test 'course/site/**/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as M from "./model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../..");
const capture = (name) => readFileSync(path.join(repo, "course/captures", name), "utf8");

/** `esr=0x... ipa=0x...` from a capture's register dump. */
function exitLine(text) {
  const m = /esr=(0x[0-9a-f]+) ipa=(0x[0-9a-f]+)/.exec(text);
  assert.ok(m, "capture has an esr= ipa= line");
  return { esr: Number(m[1]), ipa: BigInt(m[2]) };
}

function run(state) {
  const world = M.buildWorld(state);
  return { world, r: M.translate(state, world) };
}

const base = () => M.initialState("toy");

test("geometry: start levels and table sizes", () => {
  const cases = [
    [4, 39, 1, 512], // the test guests' stage 1 (T0SZ = 25)
    [4, 48, 0, 512],
    [16, 48, 0, 2], // level 0 has 2 entries (page-granules primer)
    [16, 47, 1, 2048],
    [16, 36, 2, 2048], // chapter 05: a 36-bit IPA with 16 KiB pages needs only levels 2 and 3
    [4, 36, 1, 64],
    [16, 40, 1, 16],
    [4, 40, 0, 2],
  ];
  for (const [g, bits, start, entries] of cases) {
    const geo = M.geometry(g, bits);
    assert.equal(geo.startLevel, start, `${g}K/${bits}`);
    assert.equal(geo.levels[0].entries, entries, `${g}K/${bits}`);
    assert.equal(geo.levels.at(-1).level, 3);
  }
});

test("hex formatting matches the course's notation", () => {
  assert.equal(M.hex(0xb100000n), "0x0b10_0000");
  assert.equal(M.hex(0x10_0000_0000n), "0x10_0000_0000");
  assert.equal(M.hex(0x1_0080_3519n), "0x1_0080_3519");
  assert.equal(M.hex(0x0060_0000_0b00_0403n, 16), "0x0060_0000_0b00_0403");
  assert.equal(M.hexSmall(0x58), "0x58");
  assert.equal(M.hexSmall(0), "0");
  assert.equal(M.hexRaw(0xb000000n), "0xb000000");
});

test("parseHex accepts 0x and underscores and rejects junk", () => {
  assert.deepEqual(M.parseHex("0x0b10_0000"), { ok: true, value: 0xb100000n });
  assert.deepEqual(M.parseHex("B100000"), { ok: true, value: 0xb100000n });
  for (const bad of ["", "0x", "xyz", "0x1_0000_0000_0000_0000", "-1", "1.5", null]) assert.equal(M.parseHex(bad).ok, false, String(bad));
});

test("the test guests' tables match guests/common/mmu.rs and chapter 05's table", () => {
  const { world } = run(base());
  const mem = world.s1.mem;
  const at = (a) => M.readWord(mem, a);
  // Chapter 05, "Walk one by hand".
  assert.equal(at(0x4008_4000n), 0x0000_0000_4008_5003n);
  assert.equal(at(0x4008_52c0n), 0x0000_0000_4008_6003n);
  assert.equal(at(0x4008_6800n), 0x0060_0000_0b00_0403n);
  // "Now walk VA 0x0b10_1000 on paper": index 0x101, read at 0x4008_6808.
  assert.equal(at(0x4008_6808n), 0x0060_0000_0900_0403n);
  // The rest of mmu.rs: RAM and its code alias as 1 GiB blocks, the UART as a 2 MiB block,
  // the test device identity page.
  assert.equal(at(0x4008_4008n), 0x4000_0705n);
  assert.equal(at(0x4008_4010n), 0x4000_0705n);
  assert.equal(at(0x4008_5000n + 0x48n * 8n), 0x0060_0000_0900_0401n);
  assert.equal(at(0x4008_6000n), 0x0060_0000_0b00_0403n);
  assert.deepEqual(world.s1.notes, []);
});

test("TCR_EL1 and TTBR0_EL1 match the va-alias register dump", () => {
  const text = capture("05-va-alias.txt");
  const tcr = BigInt(/TCR_EL1=(0x[0-9a-f]+)/.exec(text)[1]);
  const ttbr = BigInt(/TTBR0_EL1=(0x[0-9a-f]+)/.exec(text)[1]);
  const { world } = run(base());
  assert.equal(world.s1.tcr, tcr);
  assert.equal(world.s1.root, ttbr);
});

test("va-alias: VA 0x0b10_0000 walks to IPA 0x0b00_0000 and exits exactly as captured", () => {
  const text = capture("05-va-alias.txt");
  const want = exitLine(text);
  const x8 = BigInt(/x8=(0x[0-9a-f]+)/.exec(text)[1]);
  const st = base();
  assert.equal(st.addr, x8);
  const { r } = run(st);
  assert.deepEqual(
    r.s1.steps.map((s) => [s.level, s.tableBase, s.index, s.descAddr]),
    [
      [1, 0x4008_4000n, 0, 0x4008_4000n],
      [2, 0x4008_5000n, 0x58, 0x4008_52c0n],
      [3, 0x4008_6000n, 0x100, 0x4008_6800n],
    ],
  );
  assert.equal(r.ipa, want.ipa);
  assert.equal(r.outcome.kind, "s2-fault");
  assert.equal(r.outcome.esr, want.esr);
  assert.equal(r.outcome.dfsc, 0x6);
  assert.equal(r.outcome.vmmLine, `esr=0x93890046 ipa=0xb000000`);
  assert.equal(r.outcome.hpfar, 0xb0000n);
  assert.equal(r.outcome.regs.find((g) => g.name === "FAR_EL2").value, "0x0b10_0000");
  assert.match(r.outcome.reaction.text, /unhandled MMIO write at 0xb000000 size 4/);
  // Three stage-1 reads, each after a two-level stage-2 walk of the table address, plus one
  // stage-2 read for the data: 3 + 3 x 2 + 1.
  assert.equal(r.reads, 10);
});

test("mmio-poke and ipa-poke (MMU off) reproduce their captures", () => {
  for (const [file, addr, dfsc] of [
    ["05-mmio-poke.txt", 0x0c00_0000n, 0x6],
    ["05-beyond-ipa.txt", 0x10_0000_0000n, 0x4],
  ]) {
    const want = exitLine(capture(file));
    const { r } = run({ ...base(), mode: "s2", addr });
    assert.equal(r.outcome.esr, want.esr, file);
    assert.equal(r.outcome.ipa, want.ipa, file);
    assert.equal(r.outcome.dfsc, dfsc, file);
    assert.equal(r.outcome.vmmLine, `esr=${M.hexRaw(want.esr)} ipa=${M.hexRaw(want.ipa)}`);
  }
  // The level-0 fault reads no table at all.
  const { r } = run({ ...base(), mode: "s2", addr: 0x10_0000_0000n });
  assert.equal(r.reads, 0);
  // With a 40-bit IPA space the same address is just an unmapped hole at the start level.
  const wide = run({ ...base(), mode: "s2", addr: 0x10_0000_0000n, ipaBits: 40 }).r;
  assert.equal(wide.outcome.fault.kind, "translation");
  assert.equal(wide.outcome.fault.level, 1);
});

test("RAM through the 1 GiB block reaches host memory with no exit", () => {
  const { r } = run({ ...base(), addr: 0x4000_1234n });
  assert.equal(r.s1.steps.length, 1);
  assert.equal(r.s1.steps[0].kind, "block");
  assert.equal(r.ipa, 0x4000_1234n);
  assert.equal(r.outcome.kind, "ok");
  assert.equal(r.pa, M.HOST_RAM + 0x1234n);
  assert.deepEqual(r.s2.steps.map((s) => s.level), [2, 3]);
});

test("the chapter's Predict: a RAM page at the UART swallows the store, no exit", () => {
  const { r } = run({ ...base(), addr: 0x0b10_1000n, uartRam: true });
  assert.equal(r.ipa, 0x0900_0000n);
  assert.equal(r.outcome.kind, "ok");
  assert.match(r.outcome.summary, /No exit/);
  assert.match(r.outcome.summary, /nothing is printed/);
});

test("an address the guest never mapped is the guest's own fault (ESR_EL1, no exit)", () => {
  const { r } = run({ ...base(), addr: 0x0c00_0000n });
  assert.equal(r.outcome.kind, "s1-fault");
  assert.equal(r.outcome.dfsc, 0x6);
  assert.equal(r.outcome.esr, 0x9600_0046); // EC 0x25, IL, WnR, translation fault level 2
  const out = run({ ...base(), addr: 0x80_0000_0000n }).r;
  assert.equal(out.outcome.dfsc, 0x4); // past the 39-bit range: level 0
  const hi = run({ ...base(), addr: 0xffff_0000_0000_0000n }).r;
  assert.equal(hi.outcome.dfsc, 0x4); // upper half, EPD1
});

test("page-tables primer: the worked example, its block variant and the 24 reads", () => {
  const w = run(M.initialState("worked")).r;
  assert.deepEqual(w.s1.steps.map((s) => s.index), [1, 2, 3, 4]);
  assert.deepEqual(w.s1.steps.map((s) => s.descAddr), [0x4010_0008n, 0x4010_1010n, 0x4010_2018n, 0x4010_3020n]);
  assert.deepEqual(w.s1.steps.map((s) => s.desc), [0x4010_1003n, 0x4010_2003n, 0x4010_3003n, 0x0060_0000_4123_4703n]);
  assert.equal(w.pa, 0x4123_4567n);
  assert.equal(w.reads, 4);
  const b = run(M.initialState("block")).r;
  assert.equal(b.s1.steps[2].desc, 0x0060_0000_4120_0701n);
  assert.equal(b.pa, 0x4120_4567n);
  // Four-level stage 1 over a four-level stage 2 (4 KiB, 40-bit IPA): (4 + 1) x (4 + 1) - 1.
  const both = run({ ...M.initialState("worked"), mode: "both", g2: 4, ipaBits: 40 }).r;
  assert.equal(both.outcome.kind, "ok");
  assert.equal(both.reads, 24);
});

test("page-granules primer: 0x4008_1234 splits differently under each granule", () => {
  const four = M.splitAddress(M.geometry(4, 48), 0x4008_1234n).parts;
  assert.deepEqual(four.map((p) => p.value), [0n, 1n, 0n, 0x81n, 0x234n]);
  const sixteen = M.splitAddress(M.geometry(16, 48), 0x4008_1234n).parts;
  assert.deepEqual(sixteen.map((p) => p.value), [0n, 0n, 0x20n, 0x20n, 0x1234n]);
  assert.deepEqual(sixteen.map((p) => [p.hi, p.lo]), [[47, 47], [46, 36], [35, 25], [24, 14], [13, 0]]);
});

test("a 16 KiB stage-2 page covers four 4 KiB guest pages", () => {
  const { world } = run(base());
  const c = M.coverage(world, 0x4000_5234n);
  assert.equal(c.base, 0x4000_4000n);
  assert.equal(c.guestPages, 4);
});

test("16 KiB stage 1: the UART alias cannot share the test device alias's page", () => {
  const { world, r } = run({ ...base(), g1: 16, addr: 0x0b10_1000n });
  assert.ok(world.s1.notes.some((n) => n.startsWith("UART alias")));
  assert.equal(r.ipa, 0x0b00_1000n);
});

test("edits: stage-2 permission and access flag faults", () => {
  const st = { ...base(), addr: 0x4000_1234n };
  const { r } = run(st);
  const leaf = r.s2.steps.at(-1);
  const ro = M.setField(leaf.desc, 6, 2, 1); // S2AP = 01, read-only
  const w = run(M.step(st, { type: "edit", stage: 2, addr: leaf.descAddr, value: ro })).r;
  assert.equal(w.outcome.kind, "s2-fault");
  assert.equal(w.outcome.dfsc, 0x0f);
  assert.equal(w.outcome.esr, 0x9389_004f);
  const rd = run(M.step({ ...st, access: { ...st.access, write: false } }, { type: "edit", stage: 2, addr: leaf.descAddr, value: ro })).r;
  assert.equal(rd.outcome.kind, "ok");
  const noAf = run(M.step(st, { type: "edit", stage: 2, addr: leaf.descAddr, value: leaf.desc & ~M.DESC.AF })).r;
  assert.equal(noAf.outcome.dfsc, 0x0b);
});

test("edits: stage-1 access flag, read-only and EL0 faults go to the guest", () => {
  const st = base();
  const leafAddr = 0x4008_6800n;
  const leaf = 0x0060_0000_0b00_0403n;
  const af = run(M.step(st, { type: "edit", stage: 1, addr: leafAddr, value: leaf & ~M.DESC.AF })).r;
  assert.equal(af.outcome.kind, "s1-fault");
  assert.equal(af.outcome.esr, 0x9600_004b);
  const ro = run(M.step(st, { type: "edit", stage: 1, addr: leafAddr, value: M.setField(leaf, 6, 2, 2) })).r;
  assert.equal(ro.outcome.esr, 0x9600_004f);
  const el0 = run({ ...st, access: { ...st.access, el: 0 } }).r;
  assert.equal(el0.outcome.esr, 0x9200_004f); // EC 0x24 from EL0, AP = 00 forbids EL0
  const apt = run(M.step(st, { type: "edit", stage: 1, addr: 0x4008_52c0n, value: 0x4008_6003n | M.DESC.APTABLE_NO_WRITE })).r;
  assert.equal(apt.outcome.dfsc, 0x0f);
  // An invalid level-1 entry: translation fault level 1.
  const inv = run(M.step(st, { type: "edit", stage: 1, addr: 0x4008_4000n, value: 0x4008_5002n })).r;
  assert.equal(inv.outcome.dfsc, 0x5);
  // A table address past IPS (36 bits): address size fault at level 1.
  const wide = run(M.step(st, { type: "edit", stage: 1, addr: 0x4008_4000n, value: (1n << 36n) | 3n })).r;
  assert.equal(wide.outcome.fault.kind, "address-size");
  assert.equal(wide.outcome.dfsc, 0x1);
});

test("a stage-1 table outside RAM is a stage-2 fault with S1PTW = 1", () => {
  const st = M.step(base(), { type: "edit", stage: 1, addr: 0x4008_4000n, value: 0x0c00_0000n | 3n });
  const { r } = run(st);
  assert.equal(r.outcome.kind, "s2-fault");
  assert.equal(r.outcome.s1ptw, true);
  assert.equal(r.outcome.esr, 0x9200_0086); // EC 0x24, IL, S1PTW, DFSC 0x6; ISV = 0, WnR = 0
  assert.equal(r.outcome.hpfar, 0xc0000n);
  assert.equal(r.outcome.vmmLine, null);
  // Bare metal: the same table is just zeroed memory, so the guest takes a translation fault.
  const bare = run({ ...st, mode: "s1" }).r;
  assert.equal(bare.outcome.kind, "s1-fault");
  assert.equal(bare.outcome.dfsc, 0x6);
});

test("cross-check with crates/vmm/tests/stage1_walk.rs (k4 three levels, k16 blocks)", () => {
  const world = (granule, bits, ips, mappings) => {
    const geo = M.geometry(granule, bits);
    const mem = new Map();
    const t = M.buildTables({ geo, root: 0x4000_0000n, mappings, mem });
    return { s1: { geo, root: t.root, mem, ipsBits: ips, mair: 0n } };
  };
  const a = { lo: M.DESC.AF, hi: 0n };
  const acc = { write: false, size: 4, rt: 0, el: 1 };
  const k4 = world(4, 39, 48, [
    { name: "p", va: 0x7f_ffff_f000n, oa: 0x4010_0000n, size: 0x1000n, attrs: a },
    { name: "g", va: 0x40_0000_0000n, oa: 0x8000_0000n, size: 1n << 30n, attrs: a },
    { name: "m", va: 0x00_4020_0000n, oa: 0x4020_0000n, size: 2n << 20n, attrs: a },
  ]);
  let r = M.walkStage1(k4, 0x7f_ffff_f123n, acc, false);
  assert.deepEqual([r.out, r.level], [0x4010_0123n, 3]);
  r = M.walkStage1(k4, 0x40_1234_5678n, acc, false);
  assert.deepEqual([r.out, r.level, r.size], [0x9234_5678n, 1, 1n << 30n]);
  r = M.walkStage1(k4, 0x00_402f_fff8n, acc, false);
  assert.deepEqual([r.out, r.level, r.size], [0x402f_fff8n, 2, 2n << 20n]);
  r = M.walkStage1(k4, 0x80_0000_0000n, acc, false);
  assert.deepEqual([r.ok, r.fault.kind, r.fault.level], [false, "translation", 0]);

  const k16 = world(16, 47, 48, [{ name: "b", va: 0x0000_1000_0200_0000n, oa: 0x4200_0000n, size: 32n << 20n, attrs: a }]);
  r = M.walkStage1(k16, 0x0000_1000_03ff_fff0n, acc, false);
  assert.deepEqual([r.out, r.level, r.size], [0x43ff_fff0n, 2, 32n << 20n]);
  const k16p = world(16, 48, 48, [{ name: "p", va: 0x0000_8765_4321_c000n, oa: 0x0a00_4000n, size: 0x4000n, attrs: a }]);
  r = M.walkStage1(k16p, 0x0000_8765_4321_c000n + 0x3fffn, acc, false);
  assert.deepEqual([r.out, r.level, r.size], [0x0a00_7fffn, 3, 16n << 10n]);
});

test("vectors exported from the reference, if present", (t) => {
  const file = path.join(repo, "course/site/labs/vectors/two-stage.json");
  if (!existsSync(file)) {
    t.skip("course/site/labs/vectors/two-stage.json does not exist yet; the capture and stage1_walk.rs cross-checks above stand in for it");
    return;
  }
  const doc = JSON.parse(readFileSync(file, "utf8"));
  for (const v of doc.vectors ?? []) {
    const { state, errors } = M.decodeHash(v.hash);
    assert.deepEqual(errors, [], v.name);
    const { r } = run(state);
    if (v.esr) assert.equal(M.hexRaw(r.outcome.esr), v.esr, v.name);
    if (v.ipa) assert.equal(M.hexRaw(r.ipa), v.ipa, v.name);
  }
});

test("share state round-trips, edits included", () => {
  let st = { ...base(), mode: "both", addr: 0x4000_1234n, g1: 16, g2: 4, ipaBits: 40, uartRam: true, access: { write: false, size: 8, rt: 30, el: 0 } };
  st = M.step(st, { type: "edit", stage: 1, addr: 0x4008_4000n, value: 0x1234n });
  const { state, errors } = M.decodeHash(M.encodeHash(st));
  assert.deepEqual(errors, []);
  for (const k of ["scenario", "mode", "addr", "g1", "g2", "ipaBits", "uartRam"]) assert.equal(state[k], st[k], k);
  assert.deepEqual(state.access, st.access);
  assert.deepEqual(state.edits, st.edits);
});

test("hostile share strings never throw and fall back to defaults", () => {
  const nasty = [
    "",
    ";;;",
    "sc=__proto__;m=constructor",
    "a=zz;g1=8;g2=16.0;ipa=31;acc=w3.99.2",
    "e=" + "1.8.1,".repeat(500),
    "e=1.7.1,2.fffffffffffff.1,3.8.1",
    "x".repeat(5000),
    "a=" + "f".repeat(17),
  ];
  for (const s of nasty) {
    const { state } = M.decodeHash(s);
    assert.ok(M.SCENARIOS[state.scenario]);
    assert.ok(state.edits.length <= M.MAX_EDITS);
    assert.doesNotThrow(() => run(state));
  }
  const d = M.decodeHash("a=zz;g1=8;ipa=31;acc=w3.99.2");
  assert.deepEqual(d.errors.sort(), ["a", "acc", "g1", "ipa"]);
});

test("random tables and addresses: walks stay bounded and never throw", () => {
  let seed = 0x2545f491n;
  const rnd = () => {
    seed ^= (seed << 13n) & M.mask(64);
    seed ^= seed >> 7n;
    seed ^= (seed << 17n) & M.mask(64);
    return seed & M.mask(64);
  };
  for (let i = 0; i < 300; i++) {
    let st = { ...base(), g1: i % 2 ? 4 : 16, g2: i % 3 ? 16 : 4, addr: i % 4 === 0 ? rnd() : rnd() & M.mask(39) };
    const world = M.buildWorld(st);
    for (const tbl of world.s1.tables.slice(0, 3)) {
      st = M.step(st, { type: "edit", stage: 1, addr: tbl + (rnd() % 16n) * 8n, value: rnd() });
    }
    const { r } = run(st);
    assert.ok(r.s1.steps.length <= 4);
    for (const s of r.s1.steps) if (s.nested) assert.ok(s.nested.steps.length <= 4);
    assert.ok(r.reads <= 24);
    assert.ok(["ok", "s1-fault", "s2-fault"].includes(r.outcome.kind));
  }
});

test("state transitions: prediction resets the cursor; reset restores defaults", () => {
  let st = base();
  st = M.step(st, { type: "predict", value: true });
  assert.equal(st.cursor, 0);
  st = M.step(st, { type: "next", total: 5 });
  assert.equal(st.cursor, 1);
  st = M.step(st, { type: "back", total: 5 });
  assert.equal(st.cursor, 0);
  st = M.step(st, { type: "access", value: { size: 3 } });
  assert.equal(st.access.size, 4, "invalid size ignored");
  const reset = M.step({ ...st, addr: 1n }, { type: "reset" });
  assert.equal(reset.addr, 0x0b10_0000n);
});

test("prediction check explains the expected index and address", () => {
  const { r } = run(base());
  const s = r.s1.steps[1];
  assert.deepEqual(M.checkGuess(s, { index: "0x58", addr: "0x4008_52c0" }), {
    index: { ok: true, expected: "0x58", parsed: true },
    addr: { ok: true, expected: "0x4008_52c0", parsed: true },
  });
  assert.equal(M.checkGuess(s, { index: "88", addr: "" }).index.ok, true);
  assert.equal(M.checkGuess(s, { index: "0x59", addr: "" }).index.ok, false);
  assert.match(M.indexHow(s, r.va), /bits \[29:21\]/);
});

// --- Review fixes -----------------------------------------------------------------------------

const at = (mode, addr, access = {}) => ({ ...base(), mode, addr, access: { write: true, size: 4, rt: 9, el: 1, ...access } });

test("GIC distributor 0x0800_0000: the abort is handled inside HVF, with no VMM line", () => {
  const { r } = run(at("s2", 0x0800_0000n));
  assert.equal(r.outcome.kind, "s2-fault");
  assert.equal(r.outcome.inHvf, true);
  assert.equal(r.outcome.vmmLine, null);
  assert.equal(r.outcome.esr, 0x93890046, "hardware still takes the abort to EL2");
  assert.match(r.outcome.summary, /^Stage-2 abort handled inside HVF \(in-kernel GIC\), no exit to the VMM/);
  assert.doesNotMatch(r.outcome.summary, /VM exit/);
  for (const a of [0x080a_0000n, 0x0802_0000n]) assert.equal(run(at("s2", a)).r.outcome.vmmLine, null);
});

test("device windows the reference fills: the line is the chapter-05 VMM's, not the reference's", () => {
  for (const a of [0x0900_0000n, 0x0901_0000n, 0x0a00_0000n]) {
    const o = run(at("s2", a)).r.outcome;
    assert.equal(o.vmmLineLabel, M.CH05_LINE);
    assert.match(o.reaction.text, /Your chapter-05 VMM, with no device model there yet, stops/);
    assert.doesNotMatch(o.reaction.text, /the reference stops/);
  }
  const td = run(at("s2", 0x0b00_0000n)).r.outcome;
  assert.equal(td.vmmLineLabel, M.REF_LINE);
  assert.match(td.reaction.text, /the reference stops/);
});

test("alignment: misaligned access to Device memory is a stage-1 alignment fault (DFSC 0x21)", () => {
  // MMU off: every data access is Device-nGnRnE.
  let o = run(at("s2", 0x0900_0001n)).r.outcome;
  assert.equal(o.kind, "s1-fault");
  assert.equal(o.dfsc, 0x21);
  assert.equal(o.esr, 0x96000061);
  assert.equal(o.regs[1].value, "0x0900_0001");
  // MMU on, a Device page (the test device alias).
  o = run(at("both", 0x0b10_0002n)).r.outcome;
  assert.equal(o.kind, "s1-fault");
  assert.equal(o.esr, 0x96000061);
  assert.equal(run(at("both", 0x0b10_0002n, { write: false })).r.outcome.esr, 0x96000021);
  // From EL0 the Device page's AP refuses the access first: a permission fault, not alignment.
  assert.equal(run(at("both", 0x0b10_0002n, { el: 0, write: false })).r.outcome.dfsc, 0x0f);
  // Bare metal too: the same check, no hypervisor involved.
  assert.equal(run(at("s1", 0x0b10_0002n)).r.outcome.dfsc, 0x21);
  // A byte access is always aligned; Normal memory accepts misaligned accesses.
  assert.equal(run(at("both", 0x0b10_0003n, { size: 1 })).r.outcome.kind, "s2-fault");
  assert.equal(run(at("both", 0x4000_1233n)).r.outcome.kind, "ok");
});

test("an access running into the next page is translated for that page too", () => {
  const { r } = run(at("both", 0x43ff_fffen));
  assert.equal(r.outcome.kind, "s2-fault");
  assert.equal(r.outcome.ipa, 0x4400_0000n);
  assert.equal(r.outcome.esr, 0x93890046, "same access size and register in the syndrome");
  assert.match(r.outcome.summary, /runs into the next 4 KiB page at 0x4400_0000/);
  const ok = run(at("both", 0x4000_0ffen)).r;
  assert.equal(ok.outcome.kind, "ok");
  assert.match(ok.outcome.summary, /It is mapped as well\./);
});

test("MMU off: an address at or above the PA size is a stage-1 address size fault, level 0", () => {
  const o = run(at("s2", 0xffff_0000_0000_0000n)).r.outcome;
  assert.equal(o.kind, "s1-fault");
  assert.equal(o.dfsc, 0x0);
  assert.equal(o.esr, 0x96000040);
  assert.match(o.summary, /HVF and our VMM never see it/);
  assert.equal(run(at("s2", 1n << BigInt(M.GUEST_PA_BITS))).r.outcome.kind, "s1-fault");
  // Next to 05-beyond-ipa: 1 << 36 is inside the PA size, so stage 2 still reports it.
  const b = run(at("s2", 0x10_0000_0000n)).r.outcome;
  assert.equal(b.kind, "s2-fault");
  assert.equal(b.esr, 0x93890044);
  assert.equal(b.hpfar, 0x1000_0000n);
  // HPFAR keeps only FIPA, bits [39:4].
  const big = run({ ...at("s2", (1n << 41n) + 0x5000n), ipaBits: 40 }).r.outcome;
  assert.equal(big.hpfar & ~(M.mask(40) & ~0xfn), 0n);
});

test("stage-2 XN decodes with its own table (FEAT_XNX)", () => {
  const xn = (v, stage) => M.decodeDescriptor((BigInt(v) << 53n) | 0x7ffn, { stage, level: 3, granule: 16 }).fields.at(-1).meaning;
  assert.equal(xn(0, 2), "executable at EL1 and EL0");
  assert.match(xn(1, 2), /^not executable at EL1/);
  assert.equal(xn(2, 2), "never executable");
  assert.match(xn(3, 2), /^not executable at EL0 .*never executable/);
  assert.equal(xn(3, 1), "never executable");
  assert.match(xn(2, 1), /UXN/);
});

test("a walk starts unrevealed; new addresses and modes restart it; predict off keeps the place", () => {
  let st = base();
  assert.equal(st.cursor, 0);
  st = M.step(st, { type: "all" });
  st = M.step(st, { type: "addr", value: 0x4000_1234n });
  assert.equal(st.cursor, 0);
  st = M.step(st, { type: "next", total: 4 });
  st = M.step(st, { type: "mode", value: "s2" });
  assert.equal(st.cursor, 0);
  st = M.step(st, { type: "next", total: 4, span: 2 });
  assert.equal(st.cursor, 2);
  st = M.step(st, { type: "predict", value: false });
  assert.equal(st.cursor, 2);
  st = M.step(st, { type: "next", total: 2 });
  assert.equal(st.cursor, 2, "never past the end");
  assert.equal(M.decodeHash("sc=toy").state.cursor, 0);
});

test("stepSpan pairs a nested stage-2 card with its stage-1 read in predict mode only", () => {
  const { r } = run(base());
  const tl = r.timeline;
  assert.deepEqual(tl.slice(0, 2), [{ ref: "s1n", i: 0 }, { ref: "s1", i: 0 }]);
  assert.equal(M.stepSpan(tl, 0, 1, false), 1);
  assert.equal(M.stepSpan(tl, 0, 1, true), 2);
  assert.equal(M.stepSpan(tl, 2, -1, true), 2);
  assert.equal(M.stepSpan(tl, 6, 1, true), 1, "the stage-2 data walk is one card");
  assert.match(M.stepAnnouncement(r, 0, 2), /^Step 2 of 8\. Stage 2 first: the address of the level-1 descriptor, 0x4008_4000, is an IPA.*Stage 1, level 1: index 0, read at 0x4008_4000, table descriptor, next table 0x4008_5000\.$/);
  assert.match(M.stepAnnouncement(r, 7, 8), /^Step 8 of 8\. Walk complete\. VM exit/);
  assert.match(M.stepAnnouncement(r, 2, 0), /^Back to the start/);
  // The nested wording is the same whether stage 2 succeeds or fails.
  const bad = run({ ...base(), edits: [] });
  assert.match(M.nestedText(bad.r.s1.steps[0]), /^Stage 2 first: the address of the level-1 descriptor, 0x4008_4000, is an IPA, so/);
});

test("embeds pick their start: page-tables primer in bare-metal mode, chapter 05 at va-alias", () => {
  assert.equal(M.startHashFor({ pathname: "/build-your-own/vmm/primers/page-tables/", standalone: false }), "sc=worked;m=s1");
  const g = M.startHashFor({ pathname: "/build-your-own/vmm/primers/page-granules/", standalone: false });
  const gs = M.decodeHash(g);
  assert.deepEqual(gs.errors, []);
  assert.equal(gs.state.mode, "both");
  assert.equal(run(gs.state).r.outcome.kind, "ok", "page-granules starts on a walk that succeeds");
  const pt = M.decodeHash(M.startHashFor({ pathname: "/build-your-own/vmm/primers/page-tables/" })).state;
  assert.equal(pt.scenario, "worked");
  assert.equal(pt.mode, "s1");
  assert.equal(M.startHashFor({ pathname: "/build-your-own/vmm/memory/address-space/", standalone: false }), null);
  assert.equal(M.startHashFor({ pathname: "/build-your-own/vmm/primers/page-tables/", standalone: true }), null);
});

test("the hash note names settings in plain words, never share-string keys", () => {
  assert.equal(M.hashErrorText([]), null);
  const t = M.hashErrorText(["sc", "m", "e", "e"]);
  assert.equal(t, "Some settings in the shared link were not understood and were reset to their defaults: tables, mode, table edits.");
  assert.doesNotMatch(M.hashErrorText(["zz"]), /zz/);
});
