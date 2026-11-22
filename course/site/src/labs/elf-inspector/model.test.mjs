// Tests for the elf-inspector model. Run: node --test course/site/src/labs/elf-inspector/*.test.mjs
//
// No exported vector file exists for ELF, so the model is pinned to:
//   - the elf primer's own dumps and tables (parsed from course/primers/elf.md, so they cannot drift apart);
//   - chapter 13's captures 13-hello-phdrs.txt, 13-hello-elf-plan.txt and 13-elf-phnum.txt;
//   - the hostile corpus of course/checkpoints/13/contract/elf_hostile.rs (ported case by case) and its fuzz test;
//   - the error messages and constants, re-read from crates/vmm/src/loader/{mod,elf}.rs and arch/layout.rs;
//   - the real hello guest, when it is built locally and is the same build as the captures.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  SAMPLES,
  MAX_PHNUM,
  PHDR_SIZE,
  EM_AARCH64,
  DTB_SLOT,
  RAM_BASE,
  hex,
  hexu,
  commas,
  detect,
  parseElf,
  loadAsKernel,
  errorText,
  macvmmLine,
  decodeHeader,
  decodePhdrs,
  decodeSections,
  analyze,
  buildSample,
  applyPatches,
  parsePatch,
  presetPatches,
  PRESETS,
  ramFor,
  ramContains,
  flagsText,
  encode,
  decode,
  step,
  initialState,
  CHECKS,
  RAM_SIZES_MIB,
  DEFAULT_RAM_MIB,
  layoutNote,
} from "./model.mjs";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (p) => readFileSync(repo + p, "utf8");
const RAM = ramFor(64);

/** Body lines of a ```fenced block that follows the line `marker` (exact) in `md`. */
function blockAfter(md, marker) {
  const lines = md.split("\n");
  let i = lines.findIndex((l) => l === marker);
  assert.ok(i >= 0, `marker ${marker} not found`);
  i = lines.findIndex((l, j) => j > i + 1 && l.startsWith("```"));
  const end = lines.findIndex((l, j) => j > i && l.startsWith("```"));
  return lines.slice(i + 1, end);
}

/** Bytes from xxd lines: "00000040: 0100 0000 ...  ascii". */
function xxdBytes(lines) {
  const out = [];
  let start = null;
  for (const l of lines) {
    const m = /^([0-9a-f]{8}): ((?:[0-9a-f]{2,4} ?)+)/.exec(l);
    if (!m) continue;
    if (start === null) start = parseInt(m[1], 16);
    const hexes = m[2].replace(/\s+/g, "");
    for (let i = 0; i < hexes.length; i += 2) out.push(parseInt(hexes.slice(i, i + 2), 16));
  }
  return { start, bytes: out };
}

// ------------------------------------------------------------------ the elf primer

const primer = read("course/primers/elf.md");

test("the primer sample's header bytes are the primer's xxd -l 64 dump", () => {
  const { start, bytes } = xxdBytes(blockAfter(primer, 'xxd -l 64 "$H"'));
  assert.equal(start, 0);
  assert.equal(bytes.length, 64);
  assert.deepEqual([...buildSample("primer").subarray(0, 64)], bytes);
});

test("the primer sample's first program header is the primer's 56-byte dump", () => {
  const { start, bytes } = xxdBytes(blockAfter(primer, 'xxd -s 64 -l 56 "$H"'));
  assert.equal(start, 64);
  assert.equal(bytes.length, 56);
  assert.deepEqual([...buildSample("primer").subarray(64, 120)], bytes);
});

test("decoded program headers match the primer's llvm-readobj table, row for row", () => {
  const rows = blockAfter(primer, '"$READOBJ" --elf-output-style=GNU --program-headers "$H"').filter((l) => /^\s+(LOAD|GNU_STACK)/.test(l));
  assert.equal(rows.length, 4);
  const { list } = decodePhdrs(buildSample("primer"));
  assert.equal(list.length, 4);
  rows.forEach((r, i) => {
    const m = /^\s+(\S+)\s+0x([0-9a-f]+) 0x([0-9a-f]+) 0x([0-9a-f]+) 0x([0-9a-f]+) 0x([0-9a-f]+) (.{3}) 0x([0-9a-f]+)$/.exec(r);
    assert.ok(m, r);
    const p = list[i];
    assert.equal(p.typeName, m[1]);
    assert.equal(p.offset, BigInt("0x" + m[2]));
    assert.equal(p.vaddr, BigInt("0x" + m[3]));
    assert.equal(p.paddr, BigInt("0x" + m[4]));
    assert.equal(p.filesz, BigInt("0x" + m[5]));
    assert.equal(p.memsz, BigInt("0x" + m[6]));
    assert.equal(flagsText(p.flags), m[7]);
    assert.equal(p.align, BigInt("0x" + m[8]));
  });
});

test("decoded header fields match the primer's field table", () => {
  const h = Object.fromEntries(decodeHeader(buildSample("primer")).map((f) => [f.name, f]));
  // | `0x18` | `e_entry` | 8 | `00 00 08 40 00 00 00 00` | ...
  let rows = 0;
  for (const m of primer.matchAll(/^\| `0x([0-9a-f]{2})` \| `(e_\w+)` \| (\d) \| `([0-9a-f ]+?)(?: \.\.\.)?` \|/gm)) {
    rows++;
    const f = h[m[2]];
    assert.ok(f, m[2]);
    assert.equal(f.off, parseInt(m[1], 16), m[2]);
    assert.equal(f.size, Number(m[3]), m[2]);
    if (m[4] !== "zeros") assert.ok(f.bytes.startsWith(m[4]), `${m[2]}: ${f.bytes} vs ${m[4]}`);
  }
  assert.equal(rows, 12);
  assert.equal(h.e_entry.value, 0x4008_0000n);
  assert.equal(h.e_shoff.value, 0xce040n);
  assert.equal(h.e_phnum.value, 4n);
  assert.equal(h.e_machine.value, BigInt(EM_AARCH64));
  assert.match(h.e_type.meaning, /^ET_EXEC: a fully linked executable/);
});

test("the primer's three sizes, its span sum and its Predict answer", () => {
  const a = analyze(buildSample("primer"), { sections: false });
  assert.ok(a.ok);
  for (const n of [a.sizes.file, a.sizes.flat, a.sizes.span]) assert.ok(primer.includes(commas(n)), `${commas(n)} in the primer`);
  assert.equal(a.sizes.file, 844_736n);
  assert.equal(a.sizes.flat, 11_610n);
  assert.equal(a.sizes.span, 535_936n);
  assert.equal(hexu(a.sizes.end), "0x4010_2d80");
  assert.ok(primer.includes("0x4010_2d80"));
  // Third program header at 0xb0, table end at 0x120 (the Predict box): the map's header row is the 64-byte
  // ELF header, then the table row runs from e_phoff to there.
  assert.equal(decodePhdrs(buildSample("primer")).list[2].off, 0xb0);
  assert.deepEqual([a.map.file[0].start, a.map.file[0].end, a.map.file[0].label], [0n, 0x40n, "ELF header"]);
  assert.deepEqual([a.map.file[1].start, a.map.file[1].end, a.map.file[1].kind], [0x40n, 0x120n, "headers"]);
  assert.equal(a.map.file.at(-1).end, 0xce3c0n);
  assert.ok(primer.includes("0xce3c0"));
});

test("the primer's self-check numbers: 32-bit big-endian, x86-64, the phoff wrap, the p_offset wrap", () => {
  const b = buildSample("primer");
  const ident = applyPatches(b, [{ off: 4, bytes: [1, 2] }]);
  assert.equal(errorText(parseElf(ident, RAM).error), "unsupported ELF EI_CLASS 0x1 (need ELF64 LE AArch64 ET_EXEC)");
  assert.equal(parseElf(applyPatches(b, [{ off: 0x12, bytes: [0x3e, 0] }]), RAM).error.field, "e_machine");
  const wrap = analyze(applyPatches(b, presetPatches("phoff", b)));
  assert.equal(wrap.error.kind, "ElfPhdrsOutOfFile");
  assert.equal(wrap.error.tableEnd, null); // 0xffff_ffff_ffff_ffc8 + 0x38 does not fit in 64 bits
  const off = parseElf(applyPatches(b, presetPatches("offset", b)), RAM);
  assert.deepEqual([off.error.kind, off.error.index, off.error.fileEnd], ["ElfSegmentOutOfFile", 0, null]);
  // Stripping (no sections) loads the same segments.
  const stripped = analyze(applyPatches(b, presetPatches("noshdr", b)));
  assert.deepEqual(stripped.plan, analyze(b).plan);
});

// ------------------------------------------------------------------ chapter 13's captures

/** stdout or stderr lines of a capture. */
function capture(name, stream) {
  const t = read(`course/captures/${name}`);
  const body = t.split(`--- ${stream} ---\n`)[1] ?? "";
  return body.split(/\n--- \w+ ---/)[0].split("\n").filter((l) => l.length);
}

test("the chapter 13 sample's program headers are 13-hello-phdrs.txt's", () => {
  const out = capture("13-hello-phdrs.txt", "stdout");
  const rows = [];
  for (let i = 0; i < out.length; i++) {
    const m = /^\s+(LOAD|STACK) off\s+0x([0-9a-f]+) vaddr 0x([0-9a-f]+) paddr 0x([0-9a-f]+) align 2\*\*(\d+)$/.exec(out[i]);
    if (!m) continue;
    const n = /filesz 0x([0-9a-f]+) memsz 0x([0-9a-f]+) flags (...)/.exec(out[i + 1]);
    rows.push({ type: m[1], offset: BigInt("0x" + m[2]), vaddr: BigInt("0x" + m[3]), paddr: BigInt("0x" + m[4]), filesz: BigInt("0x" + n[1]), memsz: BigInt("0x" + n[2]), flags: n[3] });
  }
  assert.equal(rows.length, 4);
  const { list } = decodePhdrs(buildSample("ch13"));
  rows.forEach((r, i) => {
    const p = list[i];
    assert.equal(p.typeName, r.type === "STACK" ? "GNU_STACK" : "LOAD");
    for (const k of ["offset", "vaddr", "paddr", "filesz", "memsz"]) assert.equal(p[k], r[k], `${i} ${k}`);
    const f = (p.flags & 4 ? "r" : "-") + (p.flags & 2 ? "w" : "-") + (p.flags & 1 ? "x" : "-");
    assert.equal(f, r.flags);
  });
});

test("the boot-plan lines are 13-hello-elf-plan.txt's, exactly", () => {
  const want = capture("13-hello-elf-plan.txt", "stdout").filter((l) => /^(ram|elf|entry) /.test(l));
  assert.equal(want.length, 5);
  assert.deepEqual(analyze(buildSample("ch13")).plan, want);
});

test("e_phnum = ffff gives 13-elf-phnum.txt's line; the reference hash is that patch", () => {
  const want = capture("13-elf-phnum.txt", "stderr");
  assert.deepEqual(want, ["macvmm: cannot load the guest: ELF has 65535 program headers (at most 64)"]);
  const st = decode("ch13~38:ffff");
  assert.deepEqual(st, { sample: "ch13", patches: [{ off: 0x38, bytes: [0xff, 0xff] }], ramMiB: 64, file: null });
  const a = analyze(applyPatches(buildSample("ch13"), st.patches));
  assert.equal(a.line, want[0]);
  assert.equal(a.exit, 2);
  assert.equal(a.checks.find((c) => c.status === "fail").id, "phdrs");
  assert.deepEqual(a.error.where, { off: 0x38, len: 2 });
  assert.equal(encode(st), "ch13~38:ffff");
  assert.deepEqual(presetPatches("phnum", buildSample("ch13")), st.patches);
});

test("the chapter 13 sample is the local hello build, when it is the same build", (t) => {
  const path = repo + "target/guests/aarch64-unknown-none/release/hello";
  if (!existsSync(path)) return t.skip("target/guests/.../hello is not built (scripts/build-guests.sh)");
  const real = readFileSync(path);
  const s = SAMPLES.find((x) => x.id === "ch13");
  const sha = createHash("sha256").update(real).digest("hex");
  if (sha !== s.sha256) return t.skip("the local hello is a different build from chapter 13's captures");
  assert.equal(real.length, s.length);
  const mine = buildSample("ch13");
  for (const [off, hx] of s.runs) assert.deepEqual([...mine.subarray(off, off + hx.length / 2)], [...real.subarray(off, off + hx.length / 2)]);
  const full = analyze(new Uint8Array(real));
  assert.deepEqual(full.plan, analyze(mine).plan);
  assert.deepEqual(full.sizes, analyze(mine).sizes);
  assert.deepEqual(
    full.sections.list.map((x) => x.name),
    ["", ".text", ".rodata", ".bss", ".debug_loc", ".debug_abbrev", ".debug_info", ".debug_aranges", ".debug_str", ".debug_line", ".debug_ranges", ".symtab", ".shstrtab", ".strtab"],
  );
  // The flat binary next to it is the size the model predicts.
  if (existsSync(path + ".bin")) assert.equal(BigInt(readFileSync(path + ".bin").length), full.sizes.flat);
});

test("the chapter 13 sample's sections: names, and which segment each loaded one is in", () => {
  const a = analyze(buildSample("ch13"));
  const by = Object.fromEntries(a.sections.list.map((s) => [s.name, s]));
  assert.equal(by[".text"].loadedIn, 0);
  assert.equal(by[".rodata"].loadedIn, 1);
  assert.equal(by[".bss"].loadedIn, 2);
  assert.equal(by[".bss"].typeName, "NOBITS");
  assert.equal(by[".debug_info"].loadedIn, null);
  assert.equal(by[".text"].flags, "AX");
});

// ------------------------------------------------------------------ the hostile corpus (elf_hostile.rs)

const LOAD = 0x4008_0000n;
const lph = (addr, offset, filesz, memsz, flags) => ({ type: 1, flags, offset, vaddr: addr, paddr: addr, filesz, memsz });

/** The checkpoint's builder: a valid minimal ELF with one RX segment (16 bytes of code, 0x100 of BSS). */
function valid() {
  const ident = new Array(16).fill(0);
  ident.splice(0, 7, 0x7f, 0x45, 0x4c, 0x46, 2, 1, 1);
  return { ident, eType: 2, machine: 183, version: 1, entry: LOAD, phoff: 64n, phentsize: 56, phnum: null, phs: [lph(LOAD, 0x100n, 16n, 0x110n, 5)], payload: Array.from({ length: 16 }, (_, i) => i + 1) };
}
function bytes(e) {
  const b = new Uint8Array(0x100 + e.payload.length);
  const dv = new DataView(b.buffer);
  b.set(e.ident, 0);
  dv.setUint16(16, e.eType, true);
  dv.setUint16(18, e.machine, true);
  dv.setUint32(20, e.version, true);
  dv.setBigUint64(24, BigInt.asUintN(64, e.entry), true);
  dv.setBigUint64(32, BigInt.asUintN(64, e.phoff), true);
  dv.setUint16(52, 64, true);
  dv.setUint16(54, e.phentsize, true);
  dv.setUint16(56, e.phnum ?? e.phs.length, true);
  e.phs.forEach((p, i) => {
    const o = 64 + i * 56;
    dv.setUint32(o, p.type, true);
    dv.setUint32(o + 4, p.flags, true);
    dv.setBigUint64(o + 8, BigInt.asUintN(64, p.offset), true);
    dv.setBigUint64(o + 16, BigInt.asUintN(64, p.vaddr), true);
    dv.setBigUint64(o + 24, BigInt.asUintN(64, p.paddr), true);
    dv.setBigUint64(o + 32, BigInt.asUintN(64, p.filesz), true);
    dv.setBigUint64(o + 40, BigInt.asUintN(64, p.memsz), true);
  });
  b.set(e.payload, 0x100);
  return b;
}
const err = (e) => {
  const r = parseElf(bytes(e), RAM);
  assert.equal(r.ok, false, "must be rejected");
  return r.error;
};
const U64 = (1n << 64n) - 1n;

test("hostile: truncated e_ident and header", () => {
  const b = bytes(valid());
  for (const n of [0, 1, 4, 15]) assert.ok(["ElfTruncated", "ElfUnsupported"].includes(parseElf(b.subarray(0, n), RAM).error.kind), n);
  assert.deepEqual(parseElf(b.subarray(0, 40), RAM).error.kind, "ElfTruncated");
  assert.equal(errorText(parseElf(b.subarray(0, 40), RAM).error), "ELF file too short for its header");
  assert.equal(errorText(parseElf(b.subarray(0, 15), RAM).error), "ELF file too short for its e_ident");
});

test("hostile: identification bytes, type, machine, version, phentsize", () => {
  const cases = [
    [(e) => (e.ident[1] = 0x58), "magic"],
    [(e) => (e.ident[4] = 1), "EI_CLASS"],
    [(e) => (e.ident[5] = 2), "EI_DATA"],
    [(e) => (e.ident[6] = 0), "EI_VERSION"],
    [(e) => (e.version = 2), "e_version"],
  ];
  for (const m of [0, 62, 40, 182, 184, 0xffff]) cases.push([(e) => (e.machine = m), "e_machine"]);
  for (const t of [0, 1, 3, 4, 0xfe00, 0xffff]) cases.push([(e) => (e.eType = t), "e_type"]);
  for (const s of [0, 32, 55, 57, 64, 0xffff]) cases.push([(e) => (e.phentsize = s), "e_phentsize"]);
  for (const [mut, field] of cases) {
    const e = valid();
    mut(e);
    const x = err(e);
    assert.equal(x.kind, "ElfUnsupported");
    assert.equal(x.field, field);
  }
});

test("hostile: e_phnum, e_phoff and the table's bounds", () => {
  for (const n of [65, 0xffff]) {
    const e = valid();
    e.phnum = n;
    assert.deepEqual([err(e).kind, err(e).phnum], ["ElfTooManyPhdrs", n]);
  }
  for (const off of [U64, U64 - 55n, U64 - 0x1000n, 1n << 63n]) {
    const e = valid();
    e.phoff = off;
    assert.equal(err(e).kind, "ElfPhdrsOutOfFile", hex(off));
  }
  const e = valid();
  e.phnum = 64;
  assert.equal(err(e).kind, "ElfPhdrsOutOfFile");
});

test("hostile: segment file range, filesz > memsz", () => {
  for (const mut of [(p) => (p.offset = 0x1_0000n), (p) => (p.offset = U64 - 4n), (p) => ((p.filesz = 0x10_0000n), (p.memsz = 0x10_0000n))]) {
    const e = valid();
    mut(e.phs[0]);
    assert.deepEqual([err(e).kind, err(e).index], ["ElfSegmentOutOfFile", 0]);
  }
  const e = valid();
  e.phs[0].memsz = 8n;
  assert.deepEqual([err(e).kind, err(e).index], ["ElfFileszGtMemsz", 0]);
});

test("hostile: outside RAM, over the device-tree slot, overlapping, vaddr != paddr", () => {
  const end = RAM.base + RAM.size;
  for (const [addr, memsz] of [[end, 16n], [end - 8n, 16n], [U64 - 8n, 16n], [0x1000n, 16n], [LOAD, U64]]) {
    const e = valid();
    Object.assign(e.phs[0], { vaddr: addr, paddr: addr, memsz });
    e.entry = addr;
    assert.equal(err(e).kind, "OutsideRam", `${hex(addr)}+${hex(memsz)}`);
  }
  for (const addr of [RAM_BASE, RAM_BASE + 0x7_fff8n]) {
    const e = valid();
    Object.assign(e.phs[0], { vaddr: addr, paddr: addr });
    e.entry = addr;
    assert.equal(err(e).kind, "OverlapsDtb", hex(addr));
  }
  const o = valid();
  o.phs.push(lph(LOAD + 0x100n, 0x100n, 16n, 16n, 4));
  assert.equal(errorText(err(o)), "ELF segment 1 overlaps ELF segment 0");
  const v = valid();
  v.phs[0].vaddr = 0xffff_0000_0000_0000n;
  assert.deepEqual([err(v).kind, err(v).index], ["ElfVaddrNotPaddr", 0]);
});

test("hostile: entry outside executable code, no loadable segment", () => {
  for (const entry of [0n, LOAD - 4n, LOAD + 0x110n, U64]) {
    const e = valid();
    e.entry = entry;
    assert.deepEqual([err(e).kind, err(e).entry], ["ElfEntryNotExecutable", entry]);
  }
  const r = valid();
  r.phs[0].flags = 4;
  assert.deepEqual([err(r).kind, err(r).entry], ["ElfEntryNotExecutable", LOAD]);
  const g = valid();
  g.phs[0].type = 0x6474_e551;
  assert.equal(err(g).kind, "ElfNoSegments");
  const z = valid();
  z.phs = [];
  assert.equal(err(z).kind, "ElfNoSegments");
});

test("not an ELF: arm64 Image, EFI zboot and raw bytes take plan()'s other arms", () => {
  const img = new Uint8Array(64);
  img.set([0x41, 0x52, 0x4d, 0x64], 56);
  const zboot = new Uint8Array(64);
  zboot.set([0x4d, 0x5a, 0, 0, 0x7a, 0x69, 0x6d, 0x67]);
  assert.equal(detect(img), "arm64-image");
  assert.equal(detect(zboot), "efi-zboot");
  assert.equal(detect(new Uint8Array([0, 0, 0, 0x14])), "raw");
  assert.equal(detect(new Uint8Array(0)), "raw");
  assert.equal(analyze(zboot).line, "macvmm: cannot load the guest: EFI zboot image; run scripts/fetch.sh linux (unwraps it) or pass the raw Image");
  assert.equal(analyze(new Uint8Array([0, 0, 0, 0x14])).line, "macvmm: cannot load the guest: --kernel is not an ELF file; load a flat binary with --raw F@ADDR");
  const a = analyze(img);
  assert.equal(a.line, null);
  assert.match(a.summary, /arm64 Image/);
  assert.equal(a.checks[0].status, "fail");
});

test("random corruption never throws, and anything accepted lies inside RAM", () => {
  const e = valid();
  e.phs.push(lph(LOAD + 0x1000n, 0x100n, 16n, 0x2000n, 6));
  const base = bytes(e);
  assert.ok(parseElf(base, RAM).ok);
  let x = 0x2545_f491_4f6c_dd1dn;
  const next = () => {
    x ^= x >> 12n;
    x ^= (x << 25n) & U64;
    x ^= x >> 27n;
    return (x * 0x2545_f491_4f6c_dd1dn) & U64;
  };
  let accepted = 0;
  for (let k = 0; k < 10_000; k++) {
    let b = new Uint8Array(base);
    const n = Number(next() % 8n) + 1;
    for (let j = 0; j < n; j++) b[Number(next() % BigInt(b.length))] = Number(next() & 0xffn);
    if (next() % 4n === 0n) b = b.subarray(0, Number(next() % BigInt(b.length)));
    const a = analyze(b);
    if (a.ok) {
      accepted++;
      for (const s of a.image.segments) assert.ok(ramContains(RAM, s.paddr, s.memsz));
    } else if (a.error.kind !== "ArmImage" && a.error.kind !== "NotAKernel" && a.error.kind !== "EfiZboot") {
      assert.equal(a.checks.filter((c) => c.status === "fail").length, 1);
    }
  }
  assert.ok(accepted > 0);
});

test("valid minimal ELF: one segment, BSS shown as zero-filled", () => {
  const a = analyze(bytes(valid()));
  assert.ok(a.ok);
  assert.equal(a.image.entry, LOAD);
  assert.deepEqual(a.map.memory.map((r) => r.kind), ["dtb", "copy", "zero"]);
  assert.equal(a.map.memory[2].end - a.map.memory[2].start, 0x100n);
  assert.ok(a.checks.every((c) => c.status === "pass"));
});

// ------------------------------------------------------------------ the Rust source, re-read

test("messages are the Display text of LoaderError in crates/vmm/src/loader/mod.rs", () => {
  const src = read("crates/vmm/src/loader/mod.rs");
  const disp = src.slice(src.indexOf("impl fmt::Display for LoaderError"));
  const samples = [
    { kind: "ElfTruncated", what: "header" },
    { kind: "ElfUnsupported", field: "e_machine", value: 62n },
    { kind: "ElfTooManyPhdrs", phnum: 65535 },
    { kind: "ElfPhdrsOutOfFile" },
    { kind: "ElfSegmentOutOfFile", index: 3 },
    { kind: "ElfFileszGtMemsz", index: 1 },
    { kind: "ElfVaddrNotPaddr", index: 0 },
    { kind: "ElfNoSegments" },
    { kind: "ElfEntryNotExecutable", entry: 0x1234n },
    { kind: "OutsideRam", what: "ELF segment 2", addr: 0x4008_2d60n, len: 1n << 40n },
    { kind: "Overlap", a: "ELF segment 1", b: "ELF segment 0" },
    { kind: "OverlapsDtb", what: "ELF segment 0" },
    { kind: "NotAKernel" },
    { kind: "EfiZboot" },
  ];
  for (const e of samples) {
    const start = disp.search(new RegExp(`\\n\\s{12}${e.kind}\\b`));
    assert.ok(start > 0, e.kind);
    const rest = disp.slice(start + 1);
    const next = rest.slice(1).search(/\n\s{12}[A-Z]\w+ *(\{|=>)/);
    const arm = rest.slice(0, next + 1);
    const lits = [...arm.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("");
    const fmt = lits.replace(/\\\\/g, "\\").replace(/\\\n\s*/g, "");
    const want = fmt
      .replace(/\{(\w+):#x\}/g, (_, k) => hex(e[k]))
      .replace(/\{(\w+)\}/g, (_, k) => String(e[k]))
      .replace("{}", String(MAX_PHNUM));
    assert.equal(errorText(e), want, e.kind);
  }
  assert.ok(read("crates/vmm/src/error.rs").includes('"cannot load the guest: {err}"'));
  assert.equal(macvmmLine({ kind: "ElfNoSegments" }), "macvmm: cannot load the guest: ELF has no loadable segment");
});

test("constants match crates/vmm/src/loader/elf.rs and arch/layout.rs", () => {
  const elf = read("crates/vmm/src/loader/elf.rs");
  const num = (name) => Number(new RegExp(`pub const ${name}: \\w+ = (\\d+);`).exec(elf)[1]);
  assert.equal(num("MAX_PHNUM"), MAX_PHNUM);
  assert.equal(num("PHDR_SIZE"), PHDR_SIZE);
  assert.equal(num("EM_AARCH64"), EM_AARCH64);
  assert.equal(num("EHDR_SIZE"), 64);
  const layout = read("crates/vmm/src/arch/layout.rs");
  assert.match(layout, /pub const DTB_MAX_TEST_GUEST: u64 = 512 << 10;/);
  assert.equal(DTB_SLOT, 512n << 10n);
  assert.match(layout, /pub const RAM_BASE: u64 = 0x4000_0000;/);
  // The rule order the port follows, as the Rust source checks it.
  const order = ["filesz > memsz", "checked_add(filesz)", "memsz == 0", "vaddr != paddr", "ram.contains", "reserved", "segments\n            .iter()"];
  let at = elf.indexOf("pub fn parse(");
  for (const o of order) {
    const i = elf.indexOf(o, at);
    assert.ok(i > at, o);
    at = i;
  }
});

// ------------------------------------------------------------------ checks list, presets, patches, hash, state

test("every preset breaks the rule it names (on both samples)", () => {
  const want = { ramend: "segments", class: "ident", endian: "ident", x86: "type", dyn: "type", phnum: "phdrs", phoff: "phdrs", nophdr: "any", filesz: "segments", offset: "segments", vaddr: "segments", dtb: "segments", overlap: "segments", memsz: "segments", entry: "entry", noshdr: null };
  assert.deepEqual(PRESETS.map((p) => p.id).sort(), Object.keys(want).sort());
  for (const id of ["primer", "ch13"]) {
    const b = buildSample(id);
    for (const p of PRESETS) {
      const a = analyze(applyPatches(b, presetPatches(p.id, b)));
      const failed = a.checks.find((c) => c.status === "fail");
      assert.equal(failed ? failed.id : null, want[p.id], `${id} ${p.id}`);
    }
  }
  assert.equal(presetPatches("overlap", bytes(valid())), null); // needs two PT_LOADs
  assert.equal(CHECKS.length, 9);
});

test("parsePatch accepts the course's notations and refuses the rest", () => {
  assert.deepEqual(parsePatch("0x38", "ff ff", 100), { ok: true, patch: { off: 0x38, bytes: [0xff, 0xff] } });
  assert.deepEqual(parsePatch("3_8", "FFFF", 100).patch, { off: 0x38, bytes: [0xff, 0xff] });
  for (const [o, h] of [["", "ff"], ["0x123456789", "ff"], ["zz", "ff"], ["4", ""], ["4", "f"], ["4", "<b>"], ["4", "00".repeat(17)]]) assert.equal(parsePatch(o, h, 100).ok, false, `${o} ${h}`);
  assert.match(parsePatch("63", "ff ff", 64).why, /past the end/);
});

test("share hash: round trips, refuses malformed or oversized input", () => {
  assert.equal(encode(initialState()), null);
  assert.equal(encode({ ...initialState(), file: { name: "x", size: 1 } }), null);
  const s = { sample: "primer", patches: [{ off: 4, bytes: [1] }, { off: 0x60, bytes: [0, 0, 1] }], ramMiB: 256, file: null };
  assert.equal(encode(s), "primer~4:01~60:000001@256");
  assert.deepEqual(decode(encode(s)), s);
  for (const bad of [null, "", "nope", "primer~", "primer~4:1", "primer@63", "primer~fffffff0:ff", "primer~4:" + "00".repeat(17), "<img src=x>", "primer" + "~4:01".repeat(17), "x".repeat(700)]) assert.equal(decode(bad), null, String(bad));
});

test("step: sample switch clears patches; file states; ram; reset", () => {
  let s = initialState();
  s = step(s, { type: "patch", patch: { off: 4, bytes: [1] } });
  assert.equal(s.patches.length, 1);
  s = step(s, { type: "sample", id: "ch13" });
  assert.deepEqual([s.sample, s.patches.length], ["ch13", 0]);
  assert.equal(step(s, { type: "sample", id: "bogus" }), s);
  s = step(s, { type: "file", name: "a".repeat(200), size: 10 });
  assert.equal(s.file.name.length, 80);
  assert.equal(step(s, { type: "ram", mib: 3 }), s);
  assert.equal(step(s, { type: "ram", mib: 16 }), s); // below macvmm's 64 MiB minimum
  assert.equal(step(s, { type: "ram", mib: 128 }).ramMiB, 128);
  for (let i = 0; i < 20; i++) s = step(s, { type: "patch", patch: { off: i, bytes: [0] } });
  assert.equal(s.patches.length, 16);
  assert.deepEqual(step(s, { type: "reset" }), initialState());
});

test("RAM sizes are only those macvmm accepts (layout.rs RAM_MIN, 2 MiB steps)", () => {
  const layout = read("crates/vmm/src/arch/layout.rs");
  const min = Number(/pub const RAM_MIN: u64 = (\d+) << 20;/.exec(layout)[1]);
  assert.equal(min, 64);
  for (const m of RAM_SIZES_MIB) assert.ok(m >= min && m % 2 === 0, `${m} MiB`);
  assert.equal(DEFAULT_RAM_MIB, 64);
  for (const bad of ["primer@1", "primer@16", "primer@63"]) assert.equal(decode(bad), null, bad);
});

test("a segment near the end of RAM: its BSS runs past 64 MiB, and fits in 128 MiB", () => {
  const b = buildSample("primer");
  const moved = applyPatches(b, presetPatches("ramend", b));
  const a = analyze(moved, { ramMiB: 64, sections: false });
  assert.equal(a.line, "macvmm: cannot load the guest: ELF segment 2 (0x80020 bytes at 0x43fff000) does not fit inside guest RAM");
  assert.equal(a.trace.map((t) => t.outcome).join(","), "loaded,loaded,rejected");
  assert.ok(analyze(moved, { ramMiB: 128, sections: false }).ok);
  assert.equal(analyze(b, { ramMiB: 64, sections: false }).exit, null); // accepted: the exit status is the guest's
});

test("only 64-bit little-endian ELF files are decoded past e_ident", () => {
  const b = buildSample("primer");
  // An ELF32 header: magic, class 1, data 1, then 32-bit fields (entry 0x40080000 at 0x18, e_phoff 0x34 at 0x1c).
  const e32 = new Uint8Array(0x100);
  e32.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0);
  new DataView(e32.buffer).setUint32(0x18, 0x40080000, true);
  new DataView(e32.buffer).setUint32(0x1c, 0x34, true);
  const h32 = decodeHeader(e32);
  assert.deepEqual(h32.map((f) => f.name), ["magic", "EI_CLASS", "EI_DATA", "EI_VERSION", "EI_OSABI", "EI_ABIVERSION", "EI_PAD"]);
  assert.match(layoutNote(e32), /32-bit/);
  assert.equal(decodePhdrs(e32).list.length, 0);
  const be = applyPatches(b, [{ off: 4, bytes: [1, 2] }]); // the primer's self-check: 7f 45 4c 46 01 02
  assert.equal(decodeHeader(be).length, 7);
  assert.match(layoutNote(applyPatches(b, [{ off: 5, bytes: [2] }])), /big-endian/);
  // Not ELF at all: only the magic row, no notes about phentsize or invented program headers.
  const img = new Uint8Array(0x100);
  img.set([0x41, 0x52, 0x4d, 0x64], 56);
  assert.deepEqual(decodeHeader(img).map((f) => f.name), ["magic"]);
  assert.deepEqual(decodePhdrs(img), { list: [], note: "" });
  assert.equal(layoutNote(b), null);
  assert.equal(decodeHeader(b).length, 20);
});

test("the map's table row sits where e_phoff puts it", () => {
  const b = bytes(valid());
  b.copyWithin(0x80, 64, 64 + 56); // move the one program header to 0x80 ...
  b.fill(0, 64, 0x80);
  new DataView(b.buffer).setBigUint64(32, 0x80n, true); // ... and point e_phoff at it
  const a = analyze(b);
  assert.ok(a.ok);
  assert.deepEqual(
    a.map.file.map((r) => [r.start, r.end, r.label]),
    [
      [0n, 0x40n, "ELF header"],
      [0x40n, 0x80n, "not loaded"],
      [0x80n, 0xb8n, "program-header table (1 × 56 bytes)"],
      [0xb8n, 0x100n, "not loaded"],
      [0x100n, 0x110n, "segment 0: copied"],
    ],
  );
});

test("decodeSections refuses tables that do not fit, and caps names", () => {
  const b = applyPatches(buildSample("ch13"), [{ off: 0x28, bytes: [0xf0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] }]);
  assert.match(decodeSections(b, null).note, /does not fit/);
  assert.match(decodeSections(applyPatches(b, [{ off: 0x3c, bytes: [0, 0] }]), null).note, /no section table/);
  assert.equal(decodePhdrs(new Uint8Array(10)).list.length, 0);
  const far = applyPatches(buildSample("ch13"), [{ off: 0x20, bytes: [0, 0, 0, 0, 1, 0, 0, 0] }]);
  assert.match(decodePhdrs(far).note, /outside the/);
});
