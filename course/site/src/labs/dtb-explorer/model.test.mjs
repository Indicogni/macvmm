// dtb-explorer model tests. The numbers come from the lesson's captures (chapter 10) and from the
// reference's FDT vectors, never from this file: if the reference or a capture changes, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./model.mjs";
import def from "./samples.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, "..", "..", "..");
const course = join(site, "..");
const SAMPLES = M.loadSamples(def);
const sample = (id) => SAMPLES.find((s) => s.id === id);
const parsed = (id) => M.parse(M.bytesFor(M.initialState(id), SAMPLES));

/** A capture's stdout (or stderr) section, per STYLE appendix A. */
function capture(name, section = "stdout") {
  const text = readFileSync(join(course, "captures", name), "utf8");
  const start = text.indexOf(`--- ${section} ---\n`);
  assert.ok(start >= 0, `${name} has a ${section} section`);
  const rest = text.slice(start + `--- ${section} ---\n`.length);
  const next = rest.indexOf("\n--- ");
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Bytes from an xxd capture (offset column and ASCII dropped), with the first offset. */
function xxdBytes(name) {
  const out = capture(name).trim();
  const first = parseInt(out.slice(0, out.indexOf(":")), 16);
  const r = M.parseHexText(out);
  assert.ok(r.bytes, `${name}: ${r.error}`);
  return { first, bytes: r.bytes };
}

// ---- The chapter's own blob ----

test("sample v is the --dtb-out file: sha256, length and the lesson's header table", () => {
  const s = sample("v");
  assert.equal(M.sha256(s.bytes), s.sha256);
  assert.equal(s.bytes.length, 1271); // "0x4f7 ... 1271 bytes in all"
  const r = parsed("v");
  assert.equal(r.ok, true, r.error && r.error.text);
  const h = r.header;
  assert.equal(h.magic, 0xd00dfeed);
  assert.equal(h.totalsize, 0x4f7);
  assert.equal(h.off_dt_struct, 0x38);
  assert.equal(h.off_dt_strings, 0x424);
  assert.equal(h.off_mem_rsvmap, 0x28);
  assert.equal(h.version, 17);
  assert.equal(h.last_comp_version, 16);
  assert.equal(h.boot_cpuid_phys, 0);
  assert.equal(h.size_dt_strings, 0xd3);
  assert.equal(h.size_dt_struct, 0x3ec);
  assert.deepEqual(r.reservations, []);
  assert.ok(M.headerChecks(r).every((c) => c.pass));
});

test("sample v matches the captured xxd dumps byte for byte", () => {
  const s = sample("v");
  for (const name of ["10-header-hex.txt", "10-pl011-hex.txt"]) {
    const { first, bytes } = xxdBytes(name);
    assert.deepEqual([...s.bytes.subarray(first, first + bytes.length)], [...bytes], name);
  }
});

test("pl011@9000000 sits where grep found it (189 and 788)", () => {
  const s = sample("v");
  const want = capture("10-grep-offset.txt").trim().split("\n").map((l) => Number(l.split(":")[0]));
  const needle = new TextEncoder().encode("pl011@9000000");
  const hits = [];
  for (let i = 0; i + needle.length <= s.bytes.length; i++) {
    if (needle.every((c, k) => s.bytes[i + k] === c)) hits.push(i);
  }
  assert.deepEqual(hits, want);
});

test("toDts reproduces the captured dtc listing exactly", () => {
  assert.equal(M.toDts(parsed("v")), capture("10-dtc-dts.txt"));
});

test("the PL011's reg: token at 0x348, 16 bytes, one range 0x0900_0000 + 0x1000", () => {
  const r = parsed("v");
  const node = r.nodes.find((n) => n.path === "/pl011@9000000");
  assert.equal(node.begin, 784);
  const reg = r.props.find((p) => p.node === node.id && p.name === "reg");
  assert.equal(reg.tok, 0x348);
  assert.equal(reg.len, 0x10);
  assert.equal(reg.nameoff, 0x65);
  const compat = r.props.find((p) => p.node === node.id && p.name === "compatible");
  assert.equal(compat.len, 0x18); // "arm,pl011\0arm,primecell\0"
  const info = M.regInfo(r, node.id);
  assert.equal(info.ok, true);
  assert.equal(info.ac, 2);
  assert.equal(info.sc, 2);
  assert.deepEqual(info.entries, [{ addr: 0x9000000n, size: 0x1000n }]);
  assert.equal(info.unit.matches, true);
  const cpu = M.regInfo(r, r.nodes.find((n) => n.path === "/cpus/cpu@0").id);
  assert.equal(cpu.ac, 1);
  assert.equal(cpu.sc, 0);
  assert.deepEqual(cpu.entries, [{ addr: 0n, size: 0n }]);
  const mem = M.regInfo(r, r.nodes.find((n) => n.path === "/memory@40000000").id);
  assert.deepEqual(mem.entries, [{ addr: 0x40000000n, size: 0x4000000n }]);
  assert.equal(M.sizeWords(mem.entries[0].size), "64 MiB");
});

test("seven compatible properties, one compatible string", () => {
  const r = parsed("v");
  const owners = M.byteOwners(r);
  const compat = r.props.filter((p) => p.name === "compatible");
  assert.equal(compat.length, 7);
  assert.ok(compat.every((p) => p.strOff === compat[0].strOff));
  const d = M.describe(r, owners, compat[0].strOff);
  assert.match(d.lines.join(" "), /Named by 7 properties/);
  assert.equal(d.ranges.filter((x) => x.role === "related").length, 7);
});

test("describe: a node selects its token and name, and its whole extent as related", () => {
  const r = parsed("v");
  const owners = M.byteOwners(r);
  const d = M.describe(r, owners, 0x310);
  assert.equal(d.title, "/pl011@9000000");
  assert.deepEqual(d.ranges[0], { start: 0x310, end: 0x324, role: "primary" });
  assert.equal(d.ranges[1].start, 0x310);
  assert.match(d.lines.join("\n"), /address 0x0900_0000, size 0x1000 \(4 KiB\)/);
  const hdr = M.describe(r, owners, 13);
  assert.equal(hdr.title, "header: off_dt_strings");
  assert.deepEqual(hdr.ranges[1], { start: 0x424, end: 0x4f7, role: "related" });
  const clocks = r.props.find((p) => p.name === "clocks");
  assert.match(M.describe(r, owners, clocks.tok).lines.join(" "), /Points at: \/apb-pclk, \/apb-pclk/);
});

test("every byte of sample v is owned by exactly the span that claims it", () => {
  const r = parsed("v");
  const owners = M.byteOwners(r);
  assert.ok(owners.every((k) => k >= 0));
  assert.ok(!r.spans.some((s) => s.kind === "gap"));
});

// ---- The lesson's breakages ----

test("cells: root #address-cells = 1 gives dtc's three reg_format warnings and Linux's 4.6 EB", () => {
  const r = parsed("cells");
  assert.equal(r.ok, true);
  const want = capture("10-cells-dtc.txt", "stderr")
    .split("\n")
    .filter((l) => l.includes("(reg_format)"))
    .map((l) => l.replace(/^\/dev\/null: /, ""));
  assert.equal(want.length, 3);
  assert.deepEqual(r.warnings.filter((w) => w.kind === "reg").map((w) => w.text), want);
  assert.deepEqual(sample("cells").dtc, want);
  const mem = M.regInfo(r, r.nodes.find((n) => n.path === "/memory@40000000").id);
  assert.equal(mem.ok, false);
  assert.equal(mem.entry, 12);
  // 10-cells-linux-log: address 0x0, size 0x4000_0000_0000_0000, about 4.6 exabytes.
  assert.deepEqual(mem.loose, { addr: 0n, size: 0x4000000000000000n });
  assert.equal(M.sizeWords(mem.loose.size), "4 EiB (about 4.6 EB)");
  assert.match(capture("10-cells-linux-log.txt"), /Memory doesn't fit in the linear mapping/);
});

test("strings-plus: refused like the reference (BadBlock) where dtc says the table runs past", () => {
  const r = parsed("strings-plus");
  assert.equal(r.ok, false);
  assert.equal(r.error.text, 'BadBlock("strings block")');
  assert.equal(r.header.off_dt_strings + r.header.size_dt_strings, 0x4f8);
  const check = M.headerChecks(r).find((c) => c.field === "off_dt_strings");
  assert.equal(check.pass, false);
  assert.equal(capture("10-strings-plus-one.txt", "stderr").trim(), sample("strings-plus").dtc[0]);
});

test("strings-minus: accepted by the reader, names read one byte early, like dtc -f", () => {
  const r = parsed("strings-minus");
  assert.equal(r.ok, true);
  const want = capture("10-strings-minus-one.txt");
  const got = M.toDts(r).split("\n").slice(0, 20).join("\n") + "\n";
  assert.equal(got, want);
  assert.equal(r.props[0].name, "\tcompatible"); // byte 0x423 is FDT_END's last byte, 0x09
  assert.ok(r.warnings.some((w) => w.kind === "duplicate"));
  assert.ok(r.warnings.some((w) => w.kind === "overlap"));
});

// ---- The reference's vectors ----

const VEC = join(site, "labs", "vectors", "fdt.json");

test("every FDT vector parses to the reference's nodes or error", { skip: existsSync(VEC) ? false : "labs/vectors/fdt.json not exported yet" }, () => {
  const vecs = JSON.parse(readFileSync(VEC, "utf8")).vectors;
  assert.ok(vecs.length >= 7);
  for (const v of vecs) {
    const r = M.parse(M.fromHex(v.dtb));
    if (v.error === null) {
      assert.equal(r.ok, true, `${v.name}: ${r.error && r.error.text}`);
      const nodes = r.nodes.map((n) => ({
        path: n.path,
        props: n.props.map((pid) => ({ name: r.props[pid].name, value: Buffer.from(r.props[pid].value).toString("hex") })),
      }));
      assert.deepEqual(nodes, v.nodes, v.name);
    } else {
      assert.equal(r.ok, false, v.name);
      assert.equal(r.error.text, v.error, v.name);
    }
  }
});

test("bundled vector samples are byte-identical to labs/vectors/fdt.json", { skip: existsSync(VEC) ? false : "labs/vectors/fdt.json not exported yet" }, () => {
  const vecs = Object.fromEntries(JSON.parse(readFileSync(VEC, "utf8")).vectors.map((v) => [v.name, v]));
  const copied = def.samples.filter((s) => s.vector);
  assert.ok(copied.length >= 5);
  for (const s of copied) assert.equal(s.hex, vecs[s.vector].dtb, s.id);
});

// ---- Hardening ----

/** A blob from structure words and a strings block, with a correct header. */
function blob(structWords, strings = "", opts = {}) {
  const st = new Uint8Array(structWords.length * 4);
  const dv = new DataView(st.buffer);
  structWords.forEach((w, i) => dv.setUint32(i * 4, w >>> 0));
  const str = new TextEncoder().encode(strings);
  const offStruct = 40 + 16;
  const offStr = offStruct + st.length;
  const total = offStr + str.length;
  const b = new Uint8Array(total);
  const h = new DataView(b.buffer);
  const fields = [0xd00dfeed, total, offStruct, offStr, 40, 17, 16, 0, str.length, st.length];
  fields.forEach((f, i) => h.setUint32(i * 4, (opts[i] ?? f) >>> 0));
  b.set(st, offStruct);
  b.set(str, offStr);
  return b;
}
const name4 = (s) => {
  // a node name with its NUL, padded, as words
  const e = new TextEncoder().encode(s);
  const n = new Uint8Array(Math.ceil((e.length + 1) / 4) * 4);
  n.set(e);
  const dv = new DataView(n.buffer);
  return Array.from({ length: n.length / 4 }, (_, i) => dv.getUint32(i * 4));
};

test("crafted blobs give the reference's error values", () => {
  const ok = M.parse(blob([1, 0, 2, 9]));
  assert.equal(ok.ok, true);
  assert.equal(M.toDts(ok), "/dts-v1/;\n\n/ {\n};\n");
  const cases = [
    [blob([1, 0, 2]), 'Truncated("token")'],
    [blob([1, 0, 2, 7]), "BadToken(7)"],
    [blob([1, 0, 1, ...name4("a"), 2, 3, 0, 0, 2, 9], "x\0"), 'BadStructure("a property after a child node")'],
    [blob([1, 0, 2, 1, 0, 2, 9]), 'BadStructure("a second root node")'],
    [blob([1, ...name4("r"), 2, 9]), 'BadStructure("the root node has a name")'],
    [blob([1, 0, 9]), 'BadStructure("FDT_END inside a node")'],
    [blob([2, 9]), 'BadStructure("FDT_END_NODE without a node")'],
    [blob([9]), 'BadStructure("no root node")'],
    [blob([3, 0, 0, 9], "x\0"), 'BadStructure("a property outside any node")'],
    [blob([1, 0, 3, 100, 0, 2, 9], "x\0"), 'Truncated("property value")'],
    [blob([1, 0, 3, 0, 1, 2, 9], "x"), "BadNameOffset(1)"],
    [blob([1, 0x61616161]), "UnterminatedName"],
    [blob([1, 0, ...Array(65).fill([1, ...name4("n")]).flat()]), "TooComplex"],
    [blob([1, 0, 2, 9], "", { 5: 15 }), "BadVersion { version: 15, last_comp: 16 }"],
    [blob([1, 0, 2, 9], "", { 1: 30 }), "BadTotalSize(30)"],
    [blob([1, 0, 2, 9], "", { 4: 44 }), 'BadBlock("reservation map alignment")'],
    [blob([1, 0, 2, 9], "", { 2: 58 }), 'BadBlock("structure block alignment")'],
    [blob([1, 0, 2, 9], "", { 4: 64 }), "BadReservations"],
    [new Uint8Array([0xd0, 0x0d, 0xfe, 0xed]), "TruncatedHeader"],
  ];
  for (const [b, want] of cases) {
    const r = M.parse(b);
    assert.equal(r.ok, false, want);
    assert.equal(r.error.text, want);
    assert.ok(r.error.explain.length > 10);
  }
  // A name with invalid UTF-8.
  const bad = blob([1, 0, 1, 0xff000000, 2, 2, 9]);
  assert.equal(M.parse(bad).error.text, "NotUtf8");
});

test("reg and ranges with defaults, zero cells and ranges triples", () => {
  // root: #address-cells=1 #size-cells=1, child bus with ranges <0x0 0x10000000 0x1000>, grandchild reg <0x100 0x10>
  const strs = "#address-cells\0#size-cells\0ranges\0reg\0";
  const AC = 0, SC = 15, RG = 27, RE = 34;
  const r = M.parse(
    blob(
      [
        1, 0,
        3, 4, AC, 1, 3, 4, SC, 1,
        1, ...name4("bus@10000000"),
        3, 4, AC, 1, 3, 4, SC, 1, 3, 12, RG, 0, 0x10000000, 0x1000,
        1, ...name4("dev@100"), 3, 8, RE, 0x100, 0x10, 2,
        1, ...name4("odd@0"), 3, 4, RE, 0, 2,
        2,
        1, ...name4("flat"), 3, 0, RG, 2,
        2, 9,
      ],
      strs,
    ),
  );
  assert.equal(r.ok, true, r.error && r.error.text);
  const id = (p) => r.nodes.find((n) => n.path === p).id;
  const rg = M.rangesInfo(r, id("/bus@10000000"));
  assert.equal(rg.ok, true);
  assert.deepEqual(rg.entries, [{ child: 0n, parent: 0x10000000n, size: 0x1000n }]);
  assert.equal(M.rangesInfo(r, id("/flat")).identity, true);
  const dev = M.regInfo(r, id("/bus@10000000/dev@100"));
  assert.deepEqual(dev.entries, [{ addr: 0x100n, size: 0x10n }]);
  const odd = M.regInfo(r, id("/bus@10000000/odd@0"));
  assert.equal(odd.ok, false);
  assert.equal(odd.loose, null);
  // dedup sample: no counts on the root, so the defaults (2, 1) apply and 16 bytes do not divide by 12.
  const d = parsed("dedup");
  const uart = M.regInfo(d, d.nodes.find((n) => n.name === "uart@1000").id);
  assert.equal(uart.acFrom, "default");
  assert.equal(uart.ok, false);
});

test("no input crashes the parser: every truncation and 3,000 seeded mutations", () => {
  const base = sample("v").bytes;
  const check = (b) => {
    const r = M.parse(b);
    assert.ok(r.ok || (r.error && typeof r.error.text === "string"));
    for (const s of r.spans) assert.ok(s.start >= 0 && s.end <= b.length && s.end > s.start);
    const owners = M.byteOwners(r);
    for (let i = 0; i < b.length; i += 97) M.describe(r, owners, i);
    if (r.ok) M.toDts(r);
  };
  for (let n = 0; n <= base.length; n += 7) check(base.subarray(0, n));
  let seed = 0x2545f491;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8);
  for (let i = 0; i < 3000; i++) {
    const b = base.slice();
    const k = 1 + (rnd() % 4);
    for (let j = 0; j < k; j++) b[rnd() % b.length] = rnd() & 0xff;
    check(b);
  }
  check(new Uint8Array(0));
  check("not bytes");
});

// ---- Input helpers ----

test("parseHexText: plain, 0x-prefixed, xxd, and refusals", () => {
  assert.deepEqual([...M.parseHexText("d0 0d fe ed").bytes], [0xd0, 0x0d, 0xfe, 0xed]);
  assert.deepEqual([...M.parseHexText("0xd00d_feed, 0x00").bytes], [0xd0, 0x0d, 0xfe, 0xed, 0]);
  const x = M.parseHexText("00000000: d00d feed 0000 04f7  ........\n00000008: 0000 0038 0000 0424  ...8...$\n");
  assert.deepEqual([...x.bytes], [0xd0, 0x0d, 0xfe, 0xed, 0, 0, 4, 0xf7, 0, 0, 0, 0x38, 0, 0, 4, 0x24]);
  assert.match(M.parseHexText("abc").error, /odd number/);
  assert.match(M.parseHexText("zz").error, /Only hex digits/);
  assert.match(M.parseHexText("  ").error, /No hex digits/);
  assert.match(M.parseHexText("00".repeat(9), 4).error, /Too long/);
});

test("sha256 matches FIPS 180-4 examples", () => {
  assert.equal(M.sha256(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(M.sha256(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const long = new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
  assert.equal(M.sha256(long), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("number words", () => {
  assert.equal(M.hexGrouped(0x9000000), "0x0900_0000");
  assert.equal(M.hexGrouped(0x1000), "0x1000");
  assert.equal(M.hexGrouped(0x4000000000000000n), "0x4000_0000_0000_0000");
  assert.equal(M.sizeWords(24), "24 bytes");
  assert.equal(M.sizeWords(1), "1 byte");
  assert.equal(M.sizeWords(0x1000), "4 KiB");
});

// ---- State and the share hash ----

test("share hash: default clears, the reference round-trips, junk is refused", () => {
  const s0 = M.initialState();
  assert.equal(M.encode(s0), null);
  const ref = M.decode("v@310", SAMPLES);
  assert.equal(ref.sel, 0x310);
  assert.equal(M.encode(ref), "v@310");
  let s = M.step(s0, { type: "sample", id: "cells" }, SAMPLES);
  s = M.step(s, { type: "patch", offset: 0x87, value: 2 }, SAMPLES);
  s = M.step(s, { type: "view", view: "bytes" }, SAMPLES);
  assert.equal(M.encode(s), "cells+87=2@87.b");
  assert.deepEqual(M.decode("cells+87=2@87.b", SAMPLES), s);
  assert.equal(M.parse(M.bytesFor(s, SAMPLES)).warnings.length, 0); // patched back to 2
  for (const junk of ["", "nope", "v@zz", "v@ffffff", "v+5000=1", "v+1=100", "<script>", "v@310.x", "v".repeat(500)]) {
    assert.equal(M.decode(junk, SAMPLES), null, junk);
  }
  assert.equal(M.decode(null, SAMPLES), null);
  const custom = M.step(s0, { type: "custom", name: "x.dtb", bytes: new Uint8Array(4) }, SAMPLES);
  assert.equal(M.encode(custom), null);
  assert.equal(M.bytesFor(custom, SAMPLES).length, 4);
});

test("patches: bounds, cap, undo, and what changed", () => {
  let s = M.initialState("strings-plus");
  assert.deepEqual([...M.changedBytes(s, SAMPLES)], [[15, { from: 0x24, to: 0x25 }]]);
  s = M.step(s, { type: "patch", offset: 15, value: 0x24 }, SAMPLES);
  assert.equal(M.parse(M.bytesFor(s, SAMPLES)).ok, true);
  assert.equal(M.changedBytes(s, SAMPLES).size, 0);
  assert.equal(M.step(s, { type: "patch", offset: 1271, value: 0 }, SAMPLES), s);
  assert.equal(M.step(s, { type: "patch", offset: 3, value: 256 }, SAMPLES), s);
  let t = M.initialState();
  for (let i = 0; i < M.MAX_PATCHES; i++) t = M.step(t, { type: "patch", offset: 100 + i, value: 0 }, SAMPLES);
  assert.equal(t.patches.length, M.MAX_PATCHES);
  assert.equal(M.step(t, { type: "patch", offset: 500, value: 0 }, SAMPLES), t);
  t = M.step(t, { type: "unpatch", offset: 100 }, SAMPLES);
  assert.equal(t.patches.length, M.MAX_PATCHES - 1);
});

test("summary is one plain line", () => {
  const r = parsed("v");
  const owners = M.byteOwners(r);
  const line = M.summary(r, M.describe(r, owners, 0x310), "The chapter's tree");
  assert.match(line, /^The chapter's tree: 1271 bytes, parsed: 10 nodes, 33 properties\. Selected \/pl011@9000000\./);
  assert.match(M.summary(parsed("bad-magic"), null, "x"), /refused: BadMagic\(3725459181\)/);
});

test("learner-visible sample text carries no internal IDs", () => {
  for (const s of def.samples) {
    for (const t of [s.label, s.about, ...(s.dtc || [])]) assert.doesNotMatch(t, /\b(M\d+|FDT-\d|PLAN|R\d+-)\b/, t);
  }
});

// ---- Review fixes: wording and edge cases a learner's own blob can hit ----

test("cells: only reg directly under the root changes; cpu@0 keeps /cpus's counts", () => {
  const r = parsed("cells");
  const id = (p) => r.nodes.find((n) => n.path === p).id;
  const cpu = M.regInfo(r, id("/cpus/cpu@0"));
  assert.equal(cpu.ok, true);
  assert.equal(cpu.ac, 1);
  assert.equal(cpu.sc, 0);
  assert.equal(cpu.acFrom, "/cpus");
  const bad = r.nodes.filter((n) => M.regInfo(r, n.id) && !M.regInfo(r, n.id).ok).map((n) => n.path);
  assert.deepEqual(bad, ["/memory@40000000", "/pl011@9000000", "/pl031@9010000"]);
  assert.match(sample("cells").about, /cpu@0 is unchanged/);
  assert.doesNotMatch(sample("cells").about, /every reg is now/);
});

test("dedup: the about text owns up to the 16-byte reg mismatch", () => {
  const r = parsed("dedup");
  assert.deepEqual(r.warnings.map((w) => w.text), [
    "Warning (reg_format): /uart@1000:reg: property has invalid length (16 bytes) (#address-cells == 2, #size-cells == 1)",
  ]);
  assert.match(sample("dedup").about, /16-byte reg/);
});

test("counts wider than 4 cells: refused for display, dtc's warning only when the length is wrong", () => {
  const strs = "#address-cells\0#size-cells\0reg\0";
  const AC = 0, SC = 15, RE = 27;
  const mk = (regWords) =>
    M.parse(blob([1, 0, 3, 4, AC, 6, 3, 4, SC, 2, 1, ...name4("d@0"), 3, regWords.length * 4, RE, ...regWords, 2, 2, 9], strs));
  const fine = mk(Array(8).fill(0)); // 32 bytes = one 6+2 entry: dtc is silent
  const info = M.regInfo(fine, 1);
  assert.equal(info.ok, false);
  assert.equal(info.tooWide, 6);
  assert.equal(info.dtcWarning, null);
  assert.match(info.message, /cell count of 6 is too large to interpret here/);
  assert.doesNotMatch(info.message, /Mismatch/);
  assert.equal(fine.warnings.filter((w) => w.kind === "reg").length, 0);
  const off = mk(Array(7).fill(0)); // 28 bytes: dtc warns
  assert.match(M.regInfo(off, 1).message, /^Mismatch: 28 bytes is not a multiple of 32/);
  assert.equal(off.warnings.filter((w) => w.kind === "reg").length, 1);
});

test("a #address-cells that is not one cell is reported, not silently defaulted", () => {
  const strs = "#address-cells\0reg\0";
  const r = M.parse(blob([1, 0, 3, 8, 0, 0, 1, 1, ...name4("d@0"), 3, 12, 15, 0, 0, 0, 2, 2, 9], strs));
  assert.equal(r.ok, true, r.error && r.error.text);
  const w = r.warnings.find((x) => x.kind === "cells");
  assert.equal(w.text, "#address-cells in / is 8 bytes, not one cell: dtc rejects it; this lab falls back to the default 2.");
  assert.equal(M.regInfo(r, 1).acBad, true);
});

test("duplicate names: one warning per name per node, with a count", () => {
  const r = parsed("strings-minus");
  const dups = r.warnings.filter((w) => w.kind === "duplicate");
  const keys = dups.map((w) => `${w.node}:${r.props[w.prop].name}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(dups.every((w) => /appears \d+ times in /.test(w.text)));
  assert.ok(dups.length < 16);
});

test("clocks are split by the target's #clock-cells", () => {
  // /clk has phandle 1 and #clock-cells = 1; /dev's clocks = <1 7 1 9>: two references with arguments.
  const strs = "phandle\0#clock-cells\0clocks\0";
  const PH = 0, CC = 8, CL = 21;
  const r = M.parse(
    blob([1, 0, 1, ...name4("clk"), 3, 4, PH, 1, 3, 4, CC, 1, 2, 1, ...name4("dev"), 3, 16, CL, 1, 7, 1, 9, 2, 2, 9], strs),
  );
  assert.equal(r.ok, true, r.error && r.error.text);
  assert.deepEqual(M.clockLines(r, [1, 7, 1, 9]), [
    "Points at: /clk with 0x7, /clk with 0x9 (each reference is a phandle plus the target's #clock-cells cells).",
  ]);
  assert.deepEqual(M.clockLines(r, [1, 7, 5]), [
    "Points at: /clk with 0x7 (each reference is a phandle plus the target's #clock-cells cells).",
    "Cell 2 is 0x5, but no node has that phandle, so the rest cannot be split.",
  ]);
  // The chapter's tree: #clock-cells = <0>, so clocks = <0x02 0x02> is two references to /apb-pclk.
  const v = parsed("v");
  const owners = M.byteOwners(v);
  const clocks = v.props.find((p) => p.name === "clocks");
  const d = M.describe(v, owners, clocks.tok);
  assert.ok(d.lines.some((l) => l.startsWith("Points at: /apb-pclk, /apb-pclk (")));
});

// ---- Hostile files: limits that keep a dropped file from freezing the tab ----

const timed = (fn) => {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
};

test("a name longer than MAX_NAME is refused with the lab's own error, before it is copied", () => {
  // 80,000 properties that all name one megabyte-long string: 1.96 MB that ran V8 out of heap
  // (each use was scanned, decoded and pasted into three labels).
  const words = [1, 0];
  for (let i = 0; i < 80000; i++) words.push(3, 0, 0);
  words.push(2, 9);
  const long = `${"a".repeat(1_000_000 - 1)}\0`;
  const big = blob(words, long);
  assert.ok(big.length < M.FDT_MAX_SIZE);
  const [r, ms] = timed(() => M.parse(big));
  assert.equal(r.ok, false);
  assert.equal(r.error.text, 'LabLimit("property name longer than 256 bytes")');
  assert.equal(r.error.lab, true);
  assert.match(r.error.explain, /longer than 256 bytes/);
  assert.match(r.error.explain, /macvmm's reader has no such limit/);
  assert.equal(r.error.at, r.blocks.strings.start, "points at the name");
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  assert.match(M.summary(r, null, "your file"), /refused: LabLimit/);
  // The same for a node name.
  const node = M.parse(blob([1, 0, 1, ...name4("n".repeat(M.MAX_NAME + 1)), 2, 2, 9]));
  assert.equal(node.error.text, 'LabLimit("node name longer than 256 bytes")');
  // Exactly MAX_NAME bytes is still a name, for a node and for a property.
  const edge = M.parse(blob([1, 0, 1, ...name4("n".repeat(M.MAX_NAME)), 3, 0, 0, 2, 2, 9], `${"p".repeat(M.MAX_NAME)}\0`));
  assert.equal(edge.ok, true, edge.error && edge.error.text);
  assert.equal(edge.nodes[1].name.length, M.MAX_NAME);
  assert.equal(edge.props[0].name.length, M.MAX_NAME);
  // No NUL before the block ends is still the reference's error when the block ends within
  // MAX_NAME bytes; past that the lab has stopped looking, and says so.
  assert.equal(M.parse(blob([1, 0, 3, 0, 0, 2, 9], "p".repeat(200))).error.text, "BadNameOffset(0)");
  assert.equal(M.parse(blob([1, 0, 3, 0, 0, 2, 9], "p".repeat(300))).error.text, 'LabLimit("property name longer than 256 bytes")');
  assert.equal(M.parse(blob([1, 0, 3, 0, 1, 2, 9], "x")).error.text, "BadNameOffset(1)");
  assert.equal(M.parse(blob([1, 0x61616161])).error.text, "UnterminatedName");
  // A bad name is refused the same way every time it is named (the per-offset cache keeps errors).
  const twice = blob([1, 0, 3, 0, 0, 3, 0, 0, 2, 9], "A\0");
  twice[twice.length - 2] = 0xff;
  assert.equal(M.parse(twice).error.text, "NotUtf8");
});

test("a wide parent with many children: cell counts are looked up, not searched for", () => {
  // 80,000 properties in the root and 40,000 children with reg: 1.92 MB, 13 to 14 s before the
  // per-node index (each child's reg walked all of the root's properties, twice).
  const words = [1, 0];
  for (let i = 0; i < 80000; i++) words.push(3, 0, 0);
  for (let i = 0; i < 40000; i++) words.push(1, ...name4("a"), 3, 0, 2, 2);
  words.push(2, 9);
  const big = blob(words, "x\0reg\0");
  assert.ok(big.length < M.FDT_MAX_SIZE);
  const [r, ms] = timed(() => M.parse(big));
  assert.equal(r.ok, true, r.error && r.error.text);
  assert.equal(r.nodes.length, 40001);
  assert.equal(r.props.length, 120000);
  assert.ok(ms < 3000, `parse took ${ms.toFixed(0)} ms`);
  const [, ms2] = timed(() => {
    for (const n of r.nodes) {
      M.regInfo(r, n.id);
      M.rangesInfo(r, n.id);
    }
  });
  assert.ok(ms2 < 3000, `reg/ranges for every node took ${ms2.toFixed(0)} ms`);
  assert.equal(M.regInfo(r, 1).len, 0);
  assert.deepEqual(M.cellCounts(r, 0), { ac: { n: 2, from: "default", bad: false }, sc: { n: 1, from: "default", bad: false } });
});

test("the property index keeps the first of duplicate names, like the walk it replaced", () => {
  // Two #address-cells in the root (1, then 2): the first is the one in force.
  const be = (n) => n >>> 0;
  const r = M.parse(blob([1, 0, 3, 4, 0, be(1), 3, 4, 0, be(2), 3, 4, 15, be(1), 1, ...name4("m@0"), 3, 8, 27, 0, 0x1000, 2, 2, 9], "#address-cells\0#size-cells\0reg\0"));
  assert.equal(r.ok, true, r.error && r.error.text);
  assert.equal(M.cellCounts(r, 0).ac.n, 1);
  const reg = M.regInfo(r, 1);
  assert.equal(reg.ac, 1);
  assert.deepEqual(reg.entries, [{ addr: 0n, size: 0x1000n }]);
  assert.equal(M.rangesInfo(r, 1), null);
});

test("a reg with hundreds of thousands of entries is described in a bounded number of lines", () => {
  const n = 100000;
  const words = [1, 0, 3, 4, 0, 1, 3, 4, 15, 0, 1, ...name4("a"), 3, n * 4, 27];
  for (let i = 0; i < n; i++) words.push(i);
  words.push(2, 2, 9);
  const r = M.parse(blob(words, "#address-cells\0#size-cells\0reg\0"));
  assert.equal(r.ok, true, r.error && r.error.text);
  const reg = M.regInfo(r, 1);
  assert.equal(reg.entries.length, n);
  const d = M.describe(r, M.byteOwners(r), r.props[reg.prop].tok);
  assert.ok(d.lines.length < M.MAX_RANGES_SHOWN + 12, `${d.lines.length} lines`);
  assert.ok(d.lines.includes(`... and ${n - M.MAX_RANGES_SHOWN} more ranges, not listed.`));
});
