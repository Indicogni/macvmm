// vmapple-map model tests. Every number the lab shows is checked against its source: the
// lesson (chapter 24's map table and fallback block), the reference's two layout files, and the
// chapter 24 captures. No labs/vectors file applies to this lab (it has no Rust unit tests to
// export: the map is data), so the Rust source and the captures are the oracle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const lesson = read("course/chapters/X/24-vmapple.md");
const cap = (name) => read(`course/captures/${name}`);
const stdout = (name) => cap(name).split("--- stdout ---\n")[1].split("\n--- stderr ---")[0];

// ---- the lesson -------------------------------------------------------------------------------
test("fallbackText reproduces the lesson's fallback block character for character (default evidence)", () => {
  const after = lesson.split(":::lab vmapple-map")[1];
  assert.ok(after, "the lesson embeds the lab");
  const block = /```text\n([\s\S]*?)\n```/.exec(after)[1];
  assert.equal(M.fallbackText("qz"), block);
  assert.equal(M.fallbackText(), block, "the block is what the lab opens with");
  // Sitting A shows this block: nothing in it may answer sitting B's Predict about the all-ones run.
  assert.doesNotMatch(block, /all ones|all-ones|our runs/);
});

test("no default-visible text leaks the hidden all-ones run's result", () => {
  for (const sel of M.REGION_IDS) {
    const hidden = M.nextText(sel, { ev: "qz", reveal: false });
    assert.doesNotMatch(hidden, /reaches bdif|all ones|all-ones|every other unknown read/, sel);
  }
  assert.equal(M.nextText("bdif", M.decodeHash("qz@bdif")), M.region("bdif").nextHidden);
  assert.equal(M.nextText("bdif", { ev: "qz", reveal: true }), M.region("bdif").next);
  assert.equal(M.nextText("bdif", { ev: "qzo", reveal: true }), M.region("bdif").next);
  assert.equal(M.nextText("cfg", { ev: "qz", reveal: false }), M.region("cfg").next);
});

test("every row of the lesson's map table is in the lab with the same base and size", () => {
  const table = lesson.split("| Region | Base | Size | What it is |")[1].split("\n\n")[0];
  const rows = table.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
  assert.equal(rows.length, 13);
  const toNum = (s) => Number(s.replace(/[`_]/g, ""));
  const byBase = new Map(M.REGIONS.map((r) => [r.base, r]));
  for (const row of rows) {
    const [, name, bases, size] = row.split("|").map((c) => c.trim());
    const list = bases.split(",").map((b) => toNum(b.trim()));
    const sizes = size.split(",")[0]; // "256 MiB, about 512 MiB" -> first, checked per base below
    for (const [i, b] of list.entries()) {
      const r = byBase.get(b);
      assert.ok(r, `${name}: base ${b.toString(16)} missing`);
      const want = size.includes(",") ? size.split(",")[i].trim() : sizes.replace(" each", "");
      assert.equal(r.sizeText, want.replace(" each", ""), `${name} size`);
    }
  }
  // Interrupts: the lesson names SPI 1, 2 and 5.
  assert.match(table, /PL011 UART \| `0x2001_0000` \| 64 KiB \| serial console, SPI 1/);
  assert.equal(M.region("pl011").spi, 1);
  assert.equal(M.region("pl031").spi, 2);
  assert.equal(M.region("pl061").spi, 5);
  assert.match(lesson, /at the tag \[`v10\.0\.0`\]/);
  assert.equal(M.QEMU_TAG, "v10.0.0");
});

test("the lesson's quoted numbers", () => {
  assert.match(lesson, /34 accesses to device registers/);
  assert.match(lesson, /33 in cfg and 1 in pvpanic/);
  assert.match(lesson, /Fourteen addresses, 34 accesses, all between 0\.19 ms and 0\.49 ms/);
  assert.match(lesson, /63 logged accesses, 60 in cfg, 1 in pvpanic and, for the first time, 2 in bdif; across the whole trace they hit 16 distinct addresses/);
  assert.match(lesson, /repeated 11 times \(693 = 11 x 63\)/);
  assert.equal(M.RUNS.z.accesses, 34);
  assert.equal(M.RUNS.z.distinct, 14);
  assert.equal(M.RUNS.o.accesses * M.RUNS.o.boots, 693);
  assert.equal(M.RUNS.o.distinct, 16);
  for (const k of ["z", "o"]) {
    const sum = Object.values(M.RUNS[k].perBoot).reduce((a, b) => a + b, 0);
    assert.equal(sum, M.RUNS[k].accesses, `${k}: per-region counts add up`);
  }
});

// ---- the reference's layout files -----------------------------------------------------------
function rustRegions(src, arrayName) {
  const consts = new Map();
  for (const m of src.matchAll(/pub const ([A-Z0-9_]+): (?:u64|u32) = (0x[0-9A-Fa-f_]+|\d+);/g)) {
    consts.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  const body = src.split(`pub const ${arrayName}: &[Region] = &[`)[1].split("];")[0];
  const val = (t) => (consts.has(t) ? consts.get(t) : Number(t.replace(/_/g, "")));
  return [...body.matchAll(/Region \{ name: "([^"]+)",\s*base: ([A-Za-z0-9_]+),\s*size: ([A-Za-z0-9_]+),\s*kind: (\w+)/g)]
    .map((m) => ({ name: m[1], base: val(m[2]), size: val(m[3]), kind: m[4] }));
}

test("rows macvmm maps match crates/vmm/src/machine/vmapple/layout.rs", () => {
  const src = read("crates/vmm/src/machine/vmapple/layout.rs");
  const rust = rustRegions(src, "VMAPPLE_REGIONS");
  assert.equal(rust.length, 9);
  for (const rr of rust) {
    const r = M.REGIONS.find((x) => x.inMacvmm === rr.name);
    assert.ok(r, `lab has no row for ${rr.name}`);
    assert.equal(r.base, rr.base, `${rr.name} base`);
    assert.equal(r.size, rr.size, `${rr.name} size`);
  }
  assert.match(src, /pub const RAM_BASE: u64 = 0x7000_0000;/);
  assert.equal(M.region("ram").base, 0x7000_0000);
  // Rows not in macvmm's map really are absent.
  for (const r of M.REGIONS.filter((x) => !x.inMacvmm)) assert.ok(!rust.some((rr) => rr.base === r.base), r.id);
});

test("the virt comparison matches crates/vmm/src/arch/layout.rs", () => {
  const src = read("crates/vmm/src/arch/layout.rs");
  const rust = rustRegions(src, "VIRT_REGIONS");
  assert.deepEqual(M.VIRT, rust.map(({ name, base, size }) => ({ name, base, size })));
  assert.match(src, /pub const RAM_BASE: u64 = 0x4000_0000;/);
  assert.match(src, /pub const RAM_MAX_END: u64 = 0x40_0000_0000;/);
});

test("what macvmm does at each row matches the dry run", () => {
  const out = stdout("24-dry-run.txt");
  const rows = [...out.matchAll(/^ {2}0x([0-9a-f]+)\.\.0x([0-9a-f]+) +(\S+) +(.+)$/gm)];
  assert.equal(rows.length, 10);
  for (const [, b, e, name, what] of rows) {
    const r = M.REGIONS.find((x) => x.inMacvmm === name);
    assert.ok(r, name);
    assert.equal(r.base, parseInt(b, 16), `${name} base`);
    if (name === "ram") {
      assert.equal(parseInt(e, 16) - r.base, M.RAM_SIZE_RUNS);
      assert.match(r.macvmm, /^RAM \(4 GiB/);
    } else {
      assert.equal(r.size, parseInt(e, 16) - r.base, `${name} size`);
    }
    if (what === "unknown-MMIO logger") assert.match(r.macvmm, /^unknown-MMIO logger/, name);
    if (what.startsWith("in-kernel GIC")) assert.match(r.macvmm, /^in-kernel GIC/, name);
    if (what === "rom") assert.match(r.macvmm, /ROM/);
    if (what === "pl011") assert.match(r.macvmm, /^PL011/);
  }
  assert.match(out, /rom {6}335096 bytes of --bios in a 1048576-byte read\+execute ROM/);
  assert.match(M.region("avpbooter").macvmm, /335,096 bytes in a 1,048,576-byte window/);
  assert.match(out, /one 128 KiB frame; the rest: unknown-MMIO logger/);
  assert.equal(M.GICR_FRAME, 128 * 1024);
});

// ---- the captures ---------------------------------------------------------------------------
test("the zero run's numbers come from its captures", () => {
  const out = stdout("24-first-probe.txt");
  assert.match(cap("24-first-probe.txt"), /^exit: 5$/m);
  assert.match(out, new RegExp(`first exit at pc=0x${M.FIRST_EXIT_PC.toString(16)}:`));
  assert.match(out, /vmapple: 34 unknown MMIO accesses logged/);
  for (const [rid, n] of Object.entries(M.RUNS.z.perBoot)) assert.match(out, new RegExp(`vmapple: {3}${n} in ${rid}\\n`));
  assert.equal(out.match(/ in [a-z0-9]+\n/g).length, Object.keys(M.RUNS.z.perBoot).length);
  assert.match(out, new RegExp(M.RUNS.z.exits.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /exec 19\.027 s, wfi 0\.000 s/);
  assert.match(out, /over 20\.004 s wall/);
  assert.match(M.RUNS.z.time, /exec 19\.027 s, wfi 0\.000 s, of 20\.004 s wall/);
  assert.match(out, /timeout: the guest was still running after --timeout 20s/);
  assert.match(M.RUNS.z.ended, /exit code 5/);
  assert.equal(stdout("24-ipas-zero.txt").trim(), String(M.RUNS.z.distinct));
  const kinds = stdout("24-kinds-zero.txt").trim().split("\n").map((l) => l.trim().split(/\s+/));
  assert.deepEqual(new Map(kinds.map(([n, k]) => [k, Number(n)])), new Map(M.RUNS.z.kinds));
  const t = JSON.parse(stdout("24-timing-zero.txt"));
  assert.equal(Math.round(t.first_ms * 100) / 100, 0.19);
  assert.equal(Math.round(t.last_mmio_ms * 100) / 100, 0.49);
  assert.equal(t.exits_in_last_10ms, 1);
  assert.match(M.RUNS.z.window, /between 0\.19 ms and 0\.49 ms; 1 exit in the last 10 ms/);
});

test("the all-ones run's numbers come from its captures", () => {
  const all = cap("24-all-ones.txt");
  const out = stdout("24-all-ones.txt");
  assert.match(all, /^exit: 3$/m);
  const boots = out.match(/vmapple: 63 unknown MMIO accesses logged/g).length;
  assert.equal(boots, M.RUNS.o.boots);
  assert.equal(out.match(new RegExp(`first exit at pc=0x${M.FIRST_EXIT_PC.toString(16)}:`, "g")).length, boots);
  for (const [rid, n] of Object.entries(M.RUNS.o.perBoot)) {
    assert.equal(out.match(new RegExp(`vmapple: {3}${n} in ${rid}\\n`, "g")).length, boots, rid);
  }
  assert.match(out, /reset storm: more than 10 resets within 10 s/);
  assert.match(M.RUNS.o.ended, /^reset storm: more than 10 resets within 10 s, exit code 3$/);
  assert.match(out, /total 65: hvc 2, data abort 63/);
  assert.match(out, /exec 0\.000 s, wfi 0\.000 s/);
  assert.equal(stdout("24-ipas-ones.txt").trim(), String(M.RUNS.o.distinct));
  const kinds = stdout("24-kinds-ones.txt").trim().split("\n").map((l) => l.trim().split(/\s+/));
  assert.deepEqual(new Map(kinds.map(([n, k]) => [k, Number(n)])), new Map(M.RUNS.o.kinds));
});

test("no per-access detail is published: no unknown-MMIO line, no value, only the first exit's pc", () => {
  const src = readFileSync(join(here, "model.mjs"), "utf8");
  assert.doesNotMatch(src, /unknown MMIO #/);
  const pcs = [...src.matchAll(/0x10[0-9a-f]{4}\b/gi)].map((m) => m[0].toLowerCase());
  assert.deepEqual([...new Set(pcs)].filter((p) => p !== "0x100000"), ["0x103478"]); // 0x100000 is the ROM base
  for (const name of ["24-first-probe.txt", "24-all-ones.txt"]) assert.doesNotMatch(stdout(name), /unknown MMIO #/);
});

// ---- columns and evidence -------------------------------------------------------------------
test("columns follow the evidence", () => {
  const tag = (id, ev) => M.classify(id, ev).tag;
  // Before the all-ones run, bdif rests on QEMU alone.
  assert.equal(tag("bdif", "qz"), "inferred");
  assert.equal(M.classify("bdif", "qz").seen, "no access seen");
  assert.equal(tag("bdif", "qo"), "observed");
  assert.equal(M.classify("bdif", "qo").seen, "2 accesses per boot");
  assert.equal(M.classify("cfg", "qo").seen, "60 accesses per boot, all unmodelled");
  // No run: nothing is observed.
  assert.deepEqual(M.inventory("q").counts, { observed: 0, inferred: 10, unknown: 6 });
  assert.deepEqual(M.inventory("").counts, { observed: 0, inferred: 0, unknown: 16 });
  assert.equal(M.classify("cfg", "").seen, "not run");
  assert.equal(M.classify("cfg", "").source, "none");
  // No QEMU: nothing can be inferred; observations stand but lose their names.
  for (const ev of ["z", "o", "zo"]) assert.equal(M.inventory(ev).counts.inferred, 0);
  assert.match(M.classify("cfg", "zo").why, /only an address with accesses: the name comes from QEMU/);
  // Each observed row says what it is without QEMU, by how it was observed.
  for (const id of ["gicd", "gicr"]) {
    assert.match(M.classify(id, "z").why, /only a base Hypervisor\.framework accepted/, id);
    assert.doesNotMatch(M.classify(id, "z").why, /with accesses/, id);
  }
  assert.match(M.classify("avpbooter", "z").why, /only the window the CPU started in/);
  // The firmware row rests on the MMU-off start, not on the PC alone.
  assert.match(M.classify("avpbooter", "qz").why, /with the MMU off/);
  assert.match(M.classify("avpbooter", "qz").why, /a program counter is a virtual address/);
  assert.match(stdout("24-dry-run.txt"), /entry {4}pc=0x100000 .*MMU off/);
  // "never reached" versus "no access seen" comes from QEMU's map: with QEMU off they read alike.
  assert.equal(M.classify("ecam", "z").seen, "no access seen");
  assert.equal(M.classify("ecam", "qz").seen, "never reached");
  assert.equal(M.classify("cfg", "zo").source, "our run");
  assert.equal(M.classify("pl011", "zo").column, "unknown");
  // Full evidence.
  assert.deepEqual(M.inventory("qzo").counts, { observed: 6, inferred: 4, unknown: 6 });
  assert.equal(tag("gicd", "qzo"), "observed (accepted)");
  // The later-stage devices never leave "unknown".
  for (const ev of ["", "q", "qz", "qo", "qzo", "zo"]) {
    for (const id of ["gfx", "iosurface", "aes1", "aes2", "ecam", "pcie-mmio"]) assert.equal(M.classify(id, ev).column, "unknown");
  }
  // Every fallback group agrees for every evidence set.
  for (const ev of ["", "q", "z", "o", "qz", "qo", "zo", "qzo"]) assert.equal(M.fallbackText(ev).split("\n").length, 8);
});

// ---- address lookup -------------------------------------------------------------------------
test("parseAddr is hardened", () => {
  assert.equal(M.parseAddr("0x0040_0000"), 0x400000n);
  assert.equal(M.parseAddr(" 4000 0000 "), 0x40000000n);
  assert.equal(M.parseAddr("0xFFFF_FFFF_FFFF_FFFF"), 0xffffffffffffffffn);
  assert.equal(M.parseAddr("0x" + "0".repeat(30) + "1"), 1n);
  assert.equal(M.parseAddr("1e3"), 0x1e3n, "always hex");
  // Separators only between digits, checked before they are removed.
  for (const bad of ["", "0x", "0x1g", "-1", "1.5", "0x1_0000_0000_0000_0000", "x".repeat(65), null, 12,
    "0x_1", "0x1_", "0 x 1", " _ 1 _ ", "_1", "1__"]) {
    assert.ok(M.parseAddr(bad).error, `rejects ${bad}`);
  }
});

test("lookup finds the row, what macvmm does and what virt has there", () => {
  let l = M.lookup(0x400010n);
  assert.equal(l.row.id, "cfg");
  assert.equal(l.offset, 0x10n);
  assert.match(l.macvmm, /records it as \(cfg\)/);
  assert.match(l.virt, /^flash0, offset 0x400010$/);
  l = M.lookup(0x1001_0000n);
  assert.match(l.macvmm, /^in-kernel GIC/);
  l = M.lookup(0x1003_0000n);
  assert.equal(l.row.id, "gicr");
  assert.match(l.macvmm, /past the first 128 KiB frame/);
  l = M.lookup(0x4000_0000n);
  assert.equal(l.row.id, "ecam");
  assert.match(l.virt, /^RAM/);
  l = M.lookup(0x0900_0000n);
  assert.equal(l.row, null);
  assert.match(l.macvmm, /\(no layout row\)/);
  assert.equal(l.virt, "pl011, offset 0x0");
  assert.equal(M.lookup(0x2007_0001n).row.id, "pvpanic");
  assert.equal(M.lookup(0x2007_0002n).row, null);
  assert.equal(M.lookup(0x1_6fff_ffffn).row.id, "ram");
  assert.equal(M.lookup(0x1_7000_0000n).row, null);
  assert.equal(M.lookup(0xffff_ffff_ffff_ffffn).row, null);
  assert.equal(M.hex(0x103478), "0x0010_3478");
  assert.equal(M.hex(0x1_7000_0000), "0x1_7000_0000");
});

// ---- state and share string -----------------------------------------------------------------
test("share string round-trips and the default clears the hash", () => {
  const s0 = M.initialState();
  assert.deepEqual(s0, { ev: "qz", sel: "cfg", pick: "cfg", addr: "", reveal: false });
  assert.equal(M.encodeHash(s0), null);
  let s = M.step(s0, { type: "select", id: "bdif" });
  assert.equal(M.encodeHash(s), "qz@bdif");
  assert.deepEqual(M.decodeHash("qz@bdif"), { ev: "qz", sel: "bdif", pick: "bdif", addr: "", reveal: false });
  s = M.step(s, { type: "addr", text: "0x3000_0004" });
  assert.equal(M.encodeHash(s), "qz@bdif~30000004");
  assert.deepEqual(M.decodeHash("qz@bdif~30000004"), { ev: "qz", sel: "bdif", pick: "bdif", addr: "0x3000_0004", reveal: false });
  s = M.step(M.step(M.step(s, { type: "toggle", key: "q" }), { type: "toggle", key: "z" }), { type: "addr", text: "" });
  assert.equal(M.encodeHash(s), "-@bdif");
  assert.deepEqual(M.decodeHash("-@bdif"), { ev: "", sel: "bdif", pick: "bdif", addr: "", reveal: false });
  assert.deepEqual(M.step(s, { type: "reset" }), s0);
  // Typing an address selects its row.
  assert.equal(M.step(s0, { type: "addr", text: "0x2007_0000" }).sel, "pvpanic");
  assert.equal(M.step(s0, { type: "addr", text: "zz" }).sel, "cfg");
});

test("the all-ones run starts hidden; revealing it is part of the shared state", () => {
  const s0 = M.initialState();
  const r = M.step(s0, { type: "reveal" });
  assert.deepEqual(r, { ev: "qzo", sel: "cfg", pick: "cfg", addr: "", reveal: true });
  assert.equal(M.encodeHash(r), "qzo");
  const off = M.step(r, { type: "toggle", key: "o" });
  assert.deepEqual(off, { ev: "qz", sel: "cfg", pick: "cfg", addr: "", reveal: true });
  assert.equal(M.encodeHash(off), "qz+");
  assert.deepEqual(M.decodeHash("qz+"), off);
  assert.equal(M.step(s0, { type: "toggle", key: "o" }).reveal, true, "switching it on reveals it");
  assert.equal(M.decodeHash("qzo@bdif").reveal, true);
});

test("every encodable state round-trips, and an empty evidence part means the default", () => {
  const addrs = ["", "0x3000_0004", "0xffff_ffff_ffff_ffff"];
  for (const ev of ["", "q", "z", "o", "qz", "qo", "zo", "qzo"]) {
    for (const reveal of [false, true]) {
      if (ev.includes("o") && !reveal) continue; // not a reachable state
      for (const pick of M.REGION_IDS) {
        for (const addr of addrs) {
          // A reachable state: the reader picked a row, then typed the address.
          const st = M.step({ ev, sel: pick, pick, addr: "", reveal }, { type: "addr", text: addr });
          const enc = M.encodeHash(st);
          const back = enc === null ? M.initialState() : M.decodeHash(enc);
          assert.deepEqual(back, { ...st, addr: addr && M.hex(M.parseAddr(addr)) }, `${enc}`);
        }
      }
    }
  }
  // A hand-edited or truncated link never opens with every source off.
  assert.deepEqual(M.decodeHash("@ram"), { ev: "qz", sel: "ram", pick: "ram", addr: "", reveal: false });
  assert.deepEqual(M.decodeHash("~400000"), { ev: "qz", sel: "cfg", pick: "cfg", addr: "0x0040_0000", reveal: false });
  assert.deepEqual(M.decodeHash("+"), { ev: "qz", sel: "cfg", pick: "cfg", addr: "", reveal: true });
  assert.equal(M.decodeHash("-").ev, "");
});

test("hostile share strings fall back to the default", () => {
  const d = M.initialState();
  for (const bad of ["", "oz", "qq", "q@nope", "q@BDIF", "q~", "q~xyz", "q~11111111111111111", "x".repeat(65), "q@cfg;alert(1)", "<img>", null, 7, "qzo@cfg@cfg", "q++", "+q"]) {
    const got = M.decodeHash(bad);
    if (bad === "q@nope") assert.deepEqual(got, { ev: "q", sel: "cfg", pick: "cfg", addr: "", reveal: false });
    else assert.deepEqual(got, d, String(bad));
  }
  assert.equal(M.step(d, { type: "toggle", key: "x" }), d);
  assert.equal(M.step(d, { type: "select", id: "__proto__" }), d);
  assert.equal(M.step(d, { type: "nope" }), d);
  assert.equal(M.step(d, { type: "addr", text: "1".repeat(200) }).addr.length, 64);
});

test("the readout names the row, its column and the evidence", () => {
  const s = M.summary({ ev: "qz", sel: "bdif", addr: "" });
  assert.equal(s, "bdif at 0x3000_0000: inferred. Seen in the reference runs: no access seen. Evidence on: QEMU's sources, the zero run. Whole map: 5 observed, 5 inferred, 6 unknown.");
  assert.equal(M.announcement({ ev: "qz", sel: "bdif", addr: "" }), "bdif: inferred. Map: 5 observed, 5 inferred, 6 unknown.");
  assert.match(M.summary({ ev: "qzo", sel: "cfg", addr: "0x0040_0010" }), /Address 0x0040_0010: cfg, offset 0x10\.$/);
  assert.match(M.summary({ ev: "qzo", sel: "cfg", addr: "0xg" }), /Address: Only hex digits/);
  // An address with no row leads the spoken sentence; the row still selected follows.
  assert.equal(M.announcement({ ev: "qz", sel: "cfg", pick: "cfg", addr: "0x0900_0000" }),
    "Address 0x0900_0000: no row. Still selected: cfg, observed. Map: 5 observed, 5 inferred, 6 unknown.");
});

test("typing an address one key at a time never leaves a prefix's row selected", () => {
  let s = M.step(M.initialState(), { type: "select", id: "pvpanic" });
  const seen = [];
  for (const ch of "0x1234_5678") {
    s = M.step(s, { type: "addr", text: s.addr + ch });
    seen.push(s.sel);
  }
  assert.ok(seen.includes("avpbooter"), "a prefix (0x123456) falls in the firmware row");
  assert.equal(s.sel, "pvpanic", "the full address has no row: back to the reader's choice");
  assert.equal(M.encodeHash(s), "qz@pvpanic~12345678");
  assert.deepEqual(M.decodeHash(M.encodeHash(s)), s);
  assert.match(M.announcement(s), /^Address 0x1234_5678: no row\. Still selected: pvpanic/);
  // Clearing the box restores the choice too.
  s = M.step(M.step(s, { type: "addr", text: "0x0040_0000" }), { type: "addr", text: "" });
  assert.equal(s.sel, "pvpanic");
  // A chip pressed while an address is typed becomes the choice.
  s = M.step(M.step(s, { type: "addr", text: "0x0900_0000" }), { type: "select", id: "ram" });
  assert.equal(s.sel, "ram");
  assert.equal(M.step(s, { type: "addr", text: "" }).sel, "ram");
});

test("with QEMU's sources off, the address box matches only rows something switched on shows", () => {
  for (const ev of ["z", ""]) {
    const s = M.step({ ...M.initialState(), ev }, { type: "addr", text: "0x3000_0000" });
    assert.equal(s.sel, "cfg", `${ev}: bdif is not known, so the selection stays`);
    const l = M.lookupFor(0x3000_0000n, ev);
    assert.equal(l.row, null);
    assert.equal(l.rowText, "no row known with this evidence");
    assert.doesNotMatch(l.macvmm, /bdif|records it as/);
    // A gap and an unseen row read the same.
    const gap = M.lookupFor(0x0900_0000n, ev);
    assert.equal(gap.rowText, l.rowText);
    assert.equal(gap.macvmm, l.macvmm);
    assert.match(M.summary(s), /Address 0x3000_0000: no row known with this evidence\.$/);
    assert.doesNotMatch(M.summary(s), /Address .*unnamed/);
  }
  // An observed row is still found, without its QEMU log label.
  const cfg = M.lookupFor(0x0040_0010n, "z");
  assert.equal(cfg.row.id, "cfg");
  assert.equal(cfg.rowText, "unnamed, at 0x0040_0000, offset 0x10");
  assert.doesNotMatch(cfg.macvmm, /\(cfg\)/);
  assert.equal(M.step({ ...M.initialState(), ev: "z", sel: "ram", pick: "ram" }, { type: "addr", text: "0x0040_0010" }).sel, "cfg");
  // Switching QEMU off with an unseen row's address typed falls back to the reader's choice.
  let s = M.step(M.step(M.initialState(), { type: "select", id: "ram" }), { type: "addr", text: "0x3000_0000" });
  assert.equal(s.sel, "bdif");
  s = M.step(s, { type: "toggle", key: "q" });
  assert.equal(s.sel, "ram");
  // QEMU on: unchanged lookup.
  assert.equal(M.lookupFor(0x3000_0000n, "qz").rowText, "bdif, offset 0x0");
});

test("an evidence change announces which rows moved", () => {
  const s0 = M.initialState();
  const off = M.step(s0, { type: "toggle", key: "z" });
  assert.equal(M.changeNote("qz", "q"), "Zero run off: firmware, cfg, GIC distributor, GIC redistributors, pvpanic moved to inferred.");
  assert.match(M.announcement(off, s0), /^Zero run off: firmware, .* moved to inferred\. cfg: inferred\. Map: 0 observed, 10 inferred, 6 unknown\.$/);
  assert.equal(M.changeNote("qz", "qzo"), "All-ones run on: bdif moved to observed.");
  assert.equal(M.changeNote("qzo", "qz"), "All-ones run off: bdif moved to inferred.");
  assert.equal(M.changeNote("qz", "z"), "QEMU's sources off: unnamed row 5, unnamed row 6, unnamed row 7, unnamed row 9, unnamed row 16 moved to unknown.");
  assert.match(M.changeNote("qzo", ""), /^QEMU's sources off, Zero run off, All-ones run off: (?:unnamed row \d+, ){4}unnamed row \d+ and 5 more moved to unknown\.$/);
  assert.equal(M.changeNote("qz", "qz"), "");
  assert.match(M.changeNote("z", "qz"), /moved to inferred/);
  // No QEMU name once QEMU's sources are off.
  for (const n of M.REGIONS.map((r) => r.name)) assert.ok(!M.changeNote("qz", "z").includes(n), n);
});

test("lab.json's reference decodes to a non-default state", () => {
  const meta = JSON.parse(readFileSync(join(here, "lab.json"), "utf8"));
  assert.equal(meta.reference, "qz@bdif");
  assert.notDeepEqual(M.decodeHash(meta.reference), M.initialState());
});

test("learner-visible text has no internal identifiers", () => {
  const texts = [];
  const walk = (v) => {
    if (typeof v === "string") texts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk([M.REGIONS, M.RUNS, M.SOURCES, JSON.parse(readFileSync(join(here, "lab.json"), "utf8")), M.runLines("z"), M.runLines("o")]);
  texts.push(M.fallbackText(), M.fallbackText("qzo"), ...["", "q", "zo"].flatMap((ev) => M.REGION_IDS.map((id) => M.classify(id, ev).why)));
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(?:M\d{1,2}|PLAN|ADR-?\d*|HC-\d|D\d|S[0-4]|TEST-\d+|R\d{1,2}|W\d{1,2})\b/, t);
    assert.doesNotMatch(t, /https?:/, t);
  }
});

// ---- review fixes ---------------------------------------------------------------------------
test("every fallback row keeps its columns apart, for all eight evidence sets", () => {
  for (const ev of ["", "q", "z", "o", "qz", "qo", "zo", "qzo"]) {
    const lines = M.fallbackText(ev).split("\n");
    const entries = M.FALLBACK_GROUPS.map((g) => M.groupEntry(g, ev));
    for (const [i, e] of entries.entries()) {
      const line = lines[i + 1];
      const at = [line.indexOf(e.tag, e.label.length), 0, 0];
      at[1] = line.indexOf(e.seen, at[0] + e.tag.length);
      at[2] = line.indexOf(e.source, at[1] + e.seen.length);
      assert.ok(at.every((x) => x > 0), `${ev}: ${line}`);
      assert.ok(at[0] >= e.label.length + 2 && at[1] >= at[0] + e.tag.length + 2 && at[2] >= at[1] + e.seen.length + 2, `${ev}: ${line}`);
      assert.equal(line, `${line.slice(0, at[2])}${e.source}`);
    }
    // Columns stay aligned: each column starts at the same place on every line.
    const starts = (k) => new Set(entries.map((e, i) => lines[i + 1].indexOf([e.tag, e.seen][k], k ? lines[i + 1].indexOf(e.tag, e.label.length) + e.tag.length : e.label.length)));
    assert.equal(starts(0).size, 1, ev);
    assert.equal(starts(1).size, 1, ev);
  }
  assert.match(M.fallbackText("qo"), /60 accesses per boot, all unmodelled {2,}QEMU vmapple\.c, cfg\.c, our run/);
  assert.match(M.fallbackText(), /^row {20}column {20}seen in the reference runs {4}source of the row\n/);
});

test("the PCIe MMIO window ends where QEMU's memmap ends, 64 KiB below RAM", () => {
  assert.equal(M.region("pcie-mmio").span, 0x1fff_0000);
  assert.equal(M.lookup(0x6ffe_ffffn).row.id, "pcie-mmio");
  assert.equal(M.lookup(0x6fff_0000n).row, null);
  assert.equal(M.lookup(0x6fff_ffffn).row, null);
  assert.match(M.lookup(0x6fff_0000n).macvmm, /\(no layout row\)/);
  assert.equal(M.lookup(0x7000_0000n).row.id, "ram");
});

test("addresses past the IPA space are not claimed as ordinary misses", () => {
  // Inside the 36-bit space: the logger, or exit code 3 on virt.
  let l = M.lookup(0xf_ffff_fff0n);
  assert.equal(l.reach, "map");
  assert.match(l.macvmm, /\(no layout row\)/);
  assert.match(l.virt, /^RAM, when --mem reaches it/);
  // 1 << 36: chapter 05 observed a level-0 translation fault exit (captures/05-beyond-ipa.txt).
  assert.match(cap("05-beyond-ipa.txt"), /DFSC=0x4 \(translation fault\)\n {2}esr=0x93890044 ipa=0x1000000000/);
  l = M.lookup(0x10_0000_0000n);
  assert.equal(l.reach, "beyond-ipa");
  assert.equal(l.row, null);
  assert.match(l.macvmm, /past the 36-bit IPA space/);
  assert.match(l.macvmm, /level-0 translation fault/);
  assert.match(l.macvmm, /address size fault inside the guest and never reaches the VMM/);
  assert.doesNotMatch(l.macvmm, /\(no layout row\)/);
  assert.match(l.virt, /^RAM, when --mem reaches it/, "virt RAM may reach 1 << 38 with a large --mem");
  l = M.lookup(0x40_0000_0000n);
  assert.match(l.virt, /^past virt's IPA space \(36 to 38 bits/);
  // Wider than any physical address: never an exit, so neither the logger nor exit code 3.
  // 52 bits is not the limit any more (FEAT_D128 allows 56): 1 << 52 may still exit.
  assert.equal(M.lookup(1n << 52n).reach, "beyond-ipa");
  assert.equal(M.lookup((1n << 56n) - 1n).reach, "beyond-ipa");
  for (const a of [1n << 56n, 0xffff_ffff_ffff_ffffn]) {
    l = M.lookup(a);
    assert.equal(l.reach, "never");
    for (const t of [l.macvmm, l.virt]) {
      assert.match(t, /^never reaches the VMM/);
      assert.match(t, /address size fault/);
      assert.doesNotMatch(t, /logger records|exit code 3/);
    }
  }
  assert.match(M.summary({ ev: "qz", sel: "cfg", addr: "0xffff_ffff_ffff_ffff" }), /no row; it never reaches the VMM\.$/);
  assert.match(M.summary({ ev: "qz", sel: "cfg", addr: "0x10_0000_0000" }), /no row, past the IPA space\.$/);
});

test("the observed explanations cite only the runs that are switched on", () => {
  const why = (id, ev) => M.classify(id, ev).why;
  assert.match(why("cfg", "qz"), /33 of its 34 accesses/);
  assert.doesNotMatch(why("cfg", "qz"), /all-ones/);
  assert.match(why("cfg", "qo"), /60 of its 63 accesses per boot/);
  assert.doesNotMatch(why("cfg", "qo"), /zero run|all but one/);
  assert.match(why("cfg", "qzo"), /33 of its 34.*60 of its 63/);
  assert.match(why("pvpanic", "qz"), /^Observed: the zero run made one access/);
  assert.match(why("pvpanic", "qo"), /^Observed: the all-ones run made one access per boot/);
  assert.match(why("pvpanic", "qzo"), /each run/);
  assert.doesNotMatch(why("bdif", "qo"), /zero run/);
  assert.match(why("bdif", "qzo"), /the zero run logged none/);
  assert.doesNotMatch(why("bdif", "q"), /zero run/);
  assert.match(why("bdif", "qz"), /The zero run made no access here\.$/);
  assert.match(why("pl011", "qzo"), /Neither run made an access here\.$/);
  assert.match(why("pl011", "q"), /No run is switched on/);
  assert.match(why("pl061", "qo"), /The all-ones run made no access here\.$/);
  // Each run's numbers match what the sentence derives from.
  for (const ev of ["", "q", "z", "o", "qz", "qo", "zo", "qzo"]) {
    for (const id of M.REGION_IDS) {
      const w = why(id, ev);
      if (!ev.includes("z")) assert.doesNotMatch(w, /zero run/, `${id} ${ev}`);
      if (!ev.includes("o")) assert.doesNotMatch(w, /all-ones|Neither run/, `${id} ${ev}`);
    }
  }
});

test("with QEMU's sources off, no QEMU name reaches the readout", () => {
  const names = M.REGIONS.map((r) => r.name);
  for (const ev of ["", "z", "o", "zo"]) {
    for (const sel of M.REGION_IDS) {
      for (const addr of ["", "0x0040_0010", "0x0900_0000", "0x1003_0000"]) {
        const st = { ev, sel, addr, reveal: true };
        for (const t of [M.summary(st), M.announcement(st)]) {
          for (const n of names) assert.ok(!t.includes(n), `${ev} ${sel} ${addr}: "${n}" in ${t}`);
        }
      }
    }
  }
  assert.equal(M.displayName("cfg", "z"), "unnamed, at 0x0040_0000");
  assert.equal(M.displayName("pl011", "z"), "unnamed row 5");
  assert.equal(M.classify("pl011", "z").known, false);
  assert.equal(M.classify("cfg", "z").known, true);
});

test("run cards are plain sentences built from the capture numbers", () => {
  const z = M.runLines("z").join("\n"), o = M.runLines("o").join("\n");
  assert.match(z, /^34 accesses .*33 in cfg, 1 in pvpanic$/m);
  assert.match(z, /^14 distinct addresses$/m);
  assert.match(z, /^35 VM exits: 34 device accesses and 1 when the time limit stopped the CPU$/m);
  assert.match(o, /^63 accesses per boot .*60 in cfg, 1 in pvpanic, 2 in bdif$/m);
  assert.match(o, /^11 boots, 16 distinct addresses/m);
  assert.match(o, /65 VM exits/);
  assert.match(stdout("24-all-ones.txt"), /total 65: hvc 2, data abort 63/);
  for (const t of [z, o]) assert.doesNotMatch(t, /\.txt|serial_written|canceled|exit code/);
});
