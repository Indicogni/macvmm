// boot-timeline model tests (node --test). The four shipped traces are checked against what
// they claim to be (the sha256 of the real run's file and stdout, its --stats line), against
// chapter 14's quoted numbers and fingerprint table, and against the captures the lesson shows.
// Tables the model mirrors (memory map, record fields, stats kinds) are re-read from the Rust
// source, so a change there fails here instead of drifting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..", "..");
const read = (p) => readFileSync(join(REPO, p), "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const LESSON = read("course/chapters/VI/14-linux-boot.md");

const packs = Object.fromEntries(M.TRACE_IDS.map((id) => [id, JSON.parse(readFileSync(join(here, "traces", `${id}.json`), "utf8"))]));
const loaded = Object.fromEntries(M.TRACE_IDS.map((id) => {
  const L = M.loadPack(packs[id]);
  return [id, { L, A: M.analyze(L.records) }];
}));

/** The stdout section's JSON lines of a capture (course/STYLE.md appendix A format). */
function captureJsonl(name) {
  const t = read(`course/captures/${name}`);
  const out = t.split("--- stdout ---")[1].split("--- stderr ---")[0];
  return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
}

// --- the shipped traces are the real runs --------------------------------------------------------

for (const id of M.TRACE_IDS) {
  test(`${id}: the pack expands to the original trace file, byte for byte`, () => {
    const p = packs[id];
    const text = M.unpackToJsonl(p);
    assert.equal(Buffer.byteLength(text), p.meta.bytes);
    assert.equal(sha(text), p.meta.sha256);
    assert.equal(loaded[id].L.records.length, p.meta.records);
    assert.equal(loaded[id].L.errorCount, 0);
  });

  test(`${id}: the PL011 data-register writes rebuild the run's stdout exactly`, () => {
    const bytes = Buffer.from(loaded[id].L.records.filter((r) => r.kind === M.KIND_INDEX["uart-tx"]).map((r) => parseInt(r.value, 16) & 0xff));
    assert.equal(sha(bytes), packs[id].meta.stdoutSha256);
  });

  test(`${id}: the trace rebuilds the run's own --stats exit line`, () => {
    const line = packs[id].meta.stderr.find((l) => l.includes(" exits: ")).replace(/^macvmm: stats: /, "");
    assert.deepEqual(loaded[id].A.statsLines, [line]);
  });

  test(`${id}: provenance says where and when it was captured`, () => {
    const m = packs[id].meta;
    assert.match(m.captured, /Apple M5 Pro, macOS 27\.2\.1, .*commit [0-9a-f]{7}, 2026-11-20/);
    assert.match(m.command, /^macvmm run --kernel \.cache\/macvmm\/Image-virt .*--trace exits:boot\.jsonl:all$/);
    assert.equal(id === "healthy", m.change === null);
  });
}

// --- chapter 14's numbers ---------------------------------------------------------------------

test("healthy: the counts chapter 14 quotes", () => {
  const { A } = loaded.healthy;
  const dabt = A.records.filter((r) => r.ec === 0x24).length;
  const hvcSys = A.records.filter((r) => r.ec === 0x16 || r.ec === 0x18).length;
  assert.match(LESSON, /18 exits out of 32,829/);
  assert.equal(hvcSys, 18);
  assert.equal(A.count, 32829);
  assert.match(LESSON, /32,811 device accesses, none to the GIC/);
  assert.equal(dabt, 32811);
  assert.equal(A.kindCounts[M.KIND_INDEX.gic], 0);
  assert.match(LESSON, /`serial_written=12093` and `data abort 32811`: almost every exit is the console, about 2\.7 per byte/);
  assert.equal(A.console.bytes, 12093);
  assert.equal((A.count / A.console.bytes).toFixed(1), "2.7");
  assert.match(M.summary(A, "x"), /12,093 console bytes, 2\.7 exits per byte/);
});

test("healthy and breakage 3: --stats lines equal the lesson's captures", () => {
  const capLine = (name) => read(`course/captures/${name}`).split("\n").find((l) => l.includes("stats: vcpu0 exits:")).replace(/^macvmm: stats: /, "");
  assert.deepEqual(loaded.healthy.A.statsLines, [capLine("14-boot-log.txt")]);
  assert.deepEqual(loaded.noid.A.statsLines, [capLine("14-no-pl011-id.txt")]);
  assert.match(LESSON, /which says the kernel ran: 35,470 exits/);
  assert.equal(loaded.noid.A.count, 35470);
  const serial = (name) => Number(/serial_written=(\d+)/.exec(read(`course/captures/${name}`))[1]);
  assert.equal(loaded.healthy.A.console.bytes, serial("14-boot-log.txt"));
  assert.equal(loaded.noid.A.console.bytes, serial("14-no-pl011-id.txt"));
});

test("healthy: hypercalls and system-register traps are the captured sequence", () => {
  const cap = captureJsonl("14-trace-hvc-sysreg.txt");
  const mine = loaded.healthy.A.records.filter((r) => r.ec === 0x16 || r.ec === 0x18);
  assert.equal(cap.length, 18);
  assert.deepEqual(mine.map((r) => r.fn || r.sysreg), cap.map((c) => c.fn || c.sysreg));
  assert.deepEqual(mine.map((r) => r.pc), cap.map((c) => c.pc));
  assert.deepEqual(mine.map((r) => M.KINDS[r.kind].id), cap.map((c) => (c.action === "sysreg" ? "sysreg" : c.action)));
});

test("healthy: identification-register reads are the captured ones", () => {
  const cap = captureJsonl("14-id-reads.txt");
  const mine = loaded.healthy.A.records.filter((r) => r.kind === M.KIND_INDEX["uart-id"] || r.kind === M.KIND_INDEX["rtc-id"]);
  assert.deepEqual(mine.map((r) => [r.ipa, r.value]), cap.map((c) => [c.ipa, c.value]));
  assert.deepEqual(loaded.healthy.A.idReads, { pl011: 8, pl031: 8 });
  assert.match(LESSON, /the ID reads repeat/);
  assert.ok(loaded.noid.A.idReads.pl011 > 8, "breakage 3 repeats the PL011 ID reads");
});

test("breakage 2: the stray redistributor reads are the captured ones", () => {
  const cap = captureJsonl("14-wrong-gicr-trace.txt");
  const mine = loaded.gicr.A.records.filter((r) => r.kind === M.KIND_INDEX.gic);
  assert.deepEqual(mine.map((r) => [r.ipa, r.value, r.size, r.wnr]), cap.map((c) => [c.ipa, c.value, c.size, c.wnr]));
});

test("the fingerprint table of chapter 14, row for row", () => {
  const sec = LESSON.split("### Three fingerprints")[1].split("\n\n")[2];
  const rows = sec.split("\n").filter((l) => l.startsWith("|") && !/^\|[-|]+\|$/.test(l)).slice(1)
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  assert.equal(rows.length, 3);
  const ids = ["notimer", "gicr", "noid"];
  rows.forEach(([, stage, says, exit], i) => {
    const { A } = loaded[ids[i]];
    const fp = A.fingerprint;
    assert.equal(fp.stage, Number(stage.split(",")[0]), `${ids[i]} stage`);
    if (/no console/.test(stage)) { assert.ok(fp.noConsole); assert.match(fp.stageText, /but with no console/); }
    const phrases = [...says.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const words = says.replace(/`[^`]+`/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    for (const p of [...phrases, ...words]) assert.ok(fp.kernelSays.includes(p), `${ids[i]}: kernel says ${p}`);
    const status = Number(exit.split(",")[0]);
    assert.equal(packs[ids[i]].meta.exit, status, `${ids[i]} recorded exit status`);
    assert.ok(fp.ended.status.split(" ").includes(String(status)), `${ids[i]} inferred ${fp.ended.status}`);
    if (/timeout/.test(exit)) assert.equal(fp.ended.how, "canceled");
  });
  assert.equal(loaded.healthy.A.fingerprint.stage, 8);
  assert.deepEqual(loaded.healthy.A.fingerprint.missing, []);
  assert.deepEqual(loaded.healthy.A.fingerprint.kernelSays, []);
  assert.equal(loaded.healthy.A.fingerprint.ended.how, "off");
});

test("every line of chapter 14's log table is a milestone of its stage, seen in the healthy run", () => {
  const table = LESSON.split("| Line in the log | Stage |")[1].split("\n\n")[0];
  const rows = table.split("\n").filter((l) => l.startsWith("| `")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  assert.equal(rows.length, 14);
  const lines = loaded.healthy.A.console.lines.map((l) => l.text);
  for (const [cell, stageCell] of rows) {
    const text = cell.replace(/^`|`$/g, "").replace(/ \.\.\.$/, "");
    const m = M.MILESTONES.find((x) => x.re.test(text));
    assert.ok(m, `no milestone matches ${text}`);
    const want = /^\d/.test(stageCell) ? Number(stageCell.split(",")[0]) : null;
    assert.equal(m.stage, want, text);
    assert.ok(lines.some((l) => l.includes(text)), `healthy console has ${text}`);
  }
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(M.STAGES[n]);
});

test("stage names match the lesson's table", () => {
  for (const [n, name] of Object.entries(M.STAGES)) {
    if (n === "2") continue; // the table writes "2, first device-tree read" then plain "2"
    assert.match(LESSON, new RegExp(`\\| ${n}, ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|`), name);
  }
  assert.match(LESSON, /\| 2, first device-tree read \|/);
});

// --- the tables the model mirrors, re-read from the Rust source -------------------------------------

test("REGIONS and MAX_CPUS equal crates/vmm/src/arch/layout.rs", () => {
  const src = read("crates/vmm/src/arch/layout.rs");
  const consts = Object.fromEntries([...src.matchAll(/pub const ([A-Z0-9_]+): u64 = (0x[0-9a-fA-F_]+);/g)].map((m) => [m[1], Number(m[2].replace(/_/g, ""))]));
  const num = (s) => (s in consts ? consts[s] : Number(s.replace(/_/g, "")));
  const table = src.split("pub const VIRT_REGIONS")[1].split("];")[0];
  const regions = [...table.matchAll(/name: "([^"]+)",\s*base: ([A-Za-z0-9_]+),\s*size: ([A-Za-z0-9_]+),/g)].map((m) => [m[1], num(m[2]), num(m[3])]);
  assert.deepEqual(M.REGIONS.map((r) => [...r]), regions);
  assert.equal(M.MAX_CPUS, Number(/pub const MAX_CPUS: u32 = (\d+);/.exec(src)[1]));
  assert.equal(M.RAM_BASE, consts.RAM_BASE);
  assert.equal(M.VIRTIO_MMIO_STRIDE, consts.VIRTIO_MMIO_STRIDE);
  assert.equal(M.GIC_WINDOW[1], consts.PL011_BASE);
});

test("record fields, reasons and actions equal crates/vmm/src/trace.rs", () => {
  const src = read("crates/vmm/src/trace.rs");
  const body = src.split("pub fn write_json")[1].split("j.end();")[0];
  const keys = [...body.matchAll(/j\.(?:opt_)?(?:int|hex|str|bool)\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...M.FIELD_ORDER], keys);
  const names = (enumName) => {
    const impl = src.split(`impl ${enumName} {`)[1].split("pub const fn from_hv")[0].split("\n}\n")[0];
    return [...impl.matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1]);
  };
  assert.deepEqual([...M.REASONS], names("TraceReason"));
  assert.deepEqual([...M.ACTIONS], names("Action"));
});

test("the trace.rs golden lines parse, and re-serialize identically", () => {
  const src = read("crates/vmm/src/trace.rs");
  const golden = [...src.matchAll(/r#"(\{"t_ns"[^#]*\})"#/g)].map((m) => m[1]).filter((l) => !l.includes("\\u"));
  assert.ok(golden.length >= 3);
  for (const line of golden) {
    const p = M.parseTrace(line);
    assert.ok(p.ok, line);
    assert.equal(M.toJsonLine(JSON.parse(line)), line);
    assert.equal(M.recordLine(p.records[0]), line);
  }
});

test("--stats kinds equal crates/vmm/src/stats.rs", () => {
  const src = read("crates/vmm/src/stats.rs");
  const list = src.split("pub const KINDS: [&str; 10] = [")[1].split("];")[0];
  const kinds = [...list.matchAll(/"([a-z ]+)"/g)].map((m) => m[1]);
  const fake = (o) => M.statsKind({ reason: "exception", ec: null, ...o });
  assert.deepEqual(kinds, ["canceled", "vtimer", "wfx", "hvc", "smc", "sysreg", "instruction abort", "data abort", "brk", "unknown"]);
  assert.deepEqual(
    [M.statsKind({ reason: "canceled" }), M.statsKind({ reason: "vtimer" }), fake({ ec: 1 }), fake({ ec: 0x16 }), fake({ ec: 0x17 }), fake({ ec: 0x18 }), fake({ ec: 0x20 }), fake({ ec: 0x24 }), fake({ ec: 0x3c }), fake({ ec: 0x25 })],
    kinds,
  );
  // stats.rs's own format test: one HVC and one VTIMER.
  assert.equal(M.statsLine(0, { vtimer: 1, hvc: 1 }), "vcpu0 exits: vtimer 1, wfx 0, total 2: vtimer 1, hvc 1");
});

// --- classification -----------------------------------------------------------------------------

test("classify: by register, device and exit class", () => {
  const k = (o) => M.KINDS[M.validateRaw({ t_ns: 0, vcpu: 0, reason: "exception", ...o }).rec.kind].id;
  assert.equal(k({ ec: "0x24", ipa: "0x9000000", wnr: true }), "uart-tx");
  assert.equal(k({ ec: "0x24", ipa: "0x9000000", wnr: false }), "uart-rx");
  assert.equal(k({ ec: "0x24", ipa: "0x9000018", wnr: false }), "uart-fr");
  assert.equal(k({ ec: "0x24", ipa: "0x9000fe0" }), "uart-id");
  assert.equal(k({ ec: "0x24", ipa: "0x9000038", wnr: true }), "uart-reg");
  assert.equal(k({ ec: "0x24", ipa: "0x9010ffc" }), "rtc-id");
  assert.equal(k({ ec: "0x24", ipa: "0x9010000" }), "rtc");
  assert.equal(k({ ec: "0x24", ipa: "0x80cffe8" }), "gic");
  assert.equal(k({ ec: "0x24", ipa: "0x8030000" }), "gic");
  assert.equal(k({ ec: "0x24", ipa: "0xa000200" }), "virtio");
  assert.equal(k({ ec: "0x24", ipa: "0xb000008" }), "testdev");
  assert.equal(k({ ec: "0x24", ipa: "0x4000000" }), "flash");
  assert.equal(k({ ec: "0x24", ipa: "0xc000000" }), "mmio-other");
  assert.equal(k({ ec: "0x24", ipa: "0xffffffffffffffff" }), "mmio-other");
  assert.equal(k({ ec: "0x16", action: "psci", fn: "PSCI_CPU_ON" }), "psci");
  assert.equal(k({ ec: "0x17", action: "smccc", fn: "SMCCC_VERSION" }), "smccc");
  assert.equal(k({ ec: "0x16", imm: 0 }), "hvc");
  assert.equal(k({ ec: "0x18", sysreg: "OSLAR_EL1" }), "sysreg");
  assert.equal(k({ ec: "0x1" }), "wfx");
  assert.equal(k({ ec: "0x25", ipa: "0x9000000" }), "other");
  assert.equal(k({ reason: "vtimer" }), "vtimer");
  assert.equal(k({ reason: "canceled" }), "canceled");
  assert.equal(k({ reason: "unknown" }), "other");
});

// --- hostile input ------------------------------------------------------------------------------

test("parser: every bad record is refused with a reason and its line number", () => {
  const ok = '{"t_ns":5,"vcpu":0,"reason":"exception","ec":"0x24","ipa":"0x9000000","wnr":true,"size":1,"value":"0x41","action":"mmio"}';
  const bad = [
    ["not json", "{oops"],
    ["t float", '{"t_ns":1.5,"vcpu":0,"reason":"exception"}'],
    ["t negative", '{"t_ns":-1,"vcpu":0,"reason":"exception"}'],
    ["t huge", '{"t_ns":9007199254740993,"vcpu":0,"reason":"exception"}'],
    ["vcpu 64", '{"t_ns":0,"vcpu":64,"reason":"exception"}'],
    ["vcpu string", '{"t_ns":0,"vcpu":"0","reason":"exception"}'],
    ["reason", '{"t_ns":0,"vcpu":0,"reason":"<b>x</b>"}'],
    ["upper hex", '{"t_ns":0,"vcpu":0,"reason":"exception","ipa":"0x9000000A"}'],
    ["long hex", '{"t_ns":0,"vcpu":0,"reason":"exception","pc":"0x11112222333344445"}'],
    ["ec wide", '{"t_ns":0,"vcpu":0,"reason":"exception","ec":"0x40"}'],
    ["size", '{"t_ns":0,"vcpu":0,"reason":"exception","size":3}'],
    ["reg", '{"t_ns":0,"vcpu":0,"reason":"exception","reg":32}'],
    ["wnr", '{"t_ns":0,"vcpu":0,"reason":"exception","wnr":"yes"}'],
    ["markup name", '{"t_ns":0,"vcpu":0,"reason":"exception","sysreg":"<img src=x>"}'],
    ["escape name", '{"t_ns":0,"vcpu":0,"reason":"exception","fn":"A\\u001b[2J"}'],
    ["action", '{"t_ns":0,"vcpu":0,"reason":"exception","action":"rm -rf"}'],
    ["boot 0", '{"t_ns":0,"vcpu":0,"reason":"exception","boot":0}'],
    ["long line", `{"t_ns":0,"vcpu":0,"reason":"exception","x":"${"a".repeat(5000)}"}`],
  ];
  const text = [ok, ...bad.map((b) => b[1])].join("\n");
  const p = M.parseTrace(text);
  assert.ok(p.ok);
  assert.equal(p.records.length, 1);
  assert.equal(p.errorCount, bad.length);
  assert.equal(p.errors.length, Math.min(bad.length, M.LIMITS.maxErrors));
  assert.deepEqual(p.errors.map((e) => e.line), bad.slice(0, M.LIMITS.maxErrors).map((_, i) => i + 2));
  for (const e of p.errors) assert.equal(typeof e.message, "string");
});

test("parser: caps on size and record count", () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `{"t_ns":${i + 1},"vcpu":0,"reason":"canceled"}\n`).join("");
  const small = { ...M.LIMITS, maxBytes: 100, maxRecords: 3 };
  assert.equal(M.parseTrace(lines(3), small).ok, false, "over 100 bytes");
  const capped = M.parseTrace(lines(5), { ...small, maxBytes: 1000 });
  assert.ok(capped.ok && capped.tooMany);
  assert.equal(capped.records.length, 3);
  assert.equal(M.parseTrace("").ok, false);
  assert.equal(M.parseTrace(null).ok, false);
  assert.equal(M.parseTrace("hello\nworld\n").ok, false);
});

test("parser: capture headers and ring-dump indentation are skipped, CRLF is fine, order is restored", () => {
  const text = [
    "# scripts/capture-cmd 14: real output",
    "$ macvmm run ...",
    '  {"t_ns":30,"vcpu":0,"reason":"canceled","pc":"0x1"}\r',
    '{"t_ns":10,"vcpu":1,"reason":"exception","ec":"0x16","imm":0,"fn":"PSCI_CPU_ON","action":"psci"}\r',
    "",
    '{"t_ns":20,"vcpu":0,"reason":"vtimer"}',
    '{"t_ns":5,"action":"trace_truncated","max":200,"written":180}',
    '{"t_ns":1,"vcpu":0,"reason":"exception","ec":"0x1","boot":1}',
  ].join("\n");
  const p = M.parseTrace(text);
  assert.ok(p.ok);
  assert.equal(p.skipped, 2);
  assert.deepEqual(p.records.map((r) => [r.boot, r.t]), [[0, 10], [0, 20], [0, 30], [1, 1]]);
  assert.deepEqual(p.truncated, { t: 5, max: 200, written: 180 });
  assert.deepEqual(M.bootsOf(p.records), [0, 1]);
  const A0 = M.analyze(p.records, { truncated: p.truncated });
  assert.equal(A0.count, 3);
  assert.equal(A0.fingerprint.ended.how, "truncated");
  assert.deepEqual(A0.vcpus, [0, 1]);
  const A1 = M.analyze(p.records, { boot: 1 });
  assert.equal(A1.count, 1);
  assert.equal(A1.boot, 1);
});

test("console text: controls the guest writes are shown escaped, never passed through", () => {
  const bytes = [0x1b, 0x5b, 0x32, 0x4a, 0x41, 0x0d, 0x0a, 0x9b, 0x3c, 0x62, 0x3e, 0x09, 0x7f];
  const text = bytes.map((b, i) => JSON.stringify({ t_ns: i, vcpu: 0, reason: "exception", ec: "0x24", ipa: "0x9000000", wnr: true, size: 1, value: `0x${b.toString(16)}`, action: "mmio" })).join("\n");
  const A = M.analyze(M.parseTrace(text).records);
  assert.deepEqual(A.console.lines.map((l) => l.text), ["\\x1b[2JA", "\\x9b<b>\t\\x7f"]);
  assert.equal(A.console.lines[1].partial, true);
  assert.equal(A.console.bytes, bytes.length);
});

test("console text: long lines and many lines are capped", () => {
  const lim = { ...M.LIMITS, maxLineChars: 10, maxConsoleLines: 2 };
  const recs = [];
  const put = (b) => recs.push({ t_ns: recs.length, vcpu: 0, reason: "exception", ec: "0x24", ipa: "0x9000000", wnr: true, size: 1, value: `0x${b.toString(16)}`, action: "mmio" });
  for (let i = 0; i < 25; i++) put(0x61);
  put(0x0a); put(0x62); put(0x0a); put(0x63); put(0x0a);
  const A = M.analyze(M.parseTrace(recs.map((r) => JSON.stringify(r)).join("\n")).records, { limits: lim });
  assert.equal(A.console.lines[0].text, "a".repeat(10));
  assert.equal(A.console.lines[0].more, 15);
  assert.equal(A.console.lines.length, 2);
  assert.equal(A.console.dropped, 1);
});

test("pack: refuses lines that would not round-trip", () => {
  assert.throws(() => M.packTrace('{"vcpu":0,"t_ns":1,"reason":"canceled"}\n', { id: "x", meta: {} }), /round-trip/);
  assert.throws(() => M.unpackRaw({ format: M.FORMAT, shapes: [{}], values: [], rows: [1, 5, 0] }), /bad row/);
  assert.throws(() => M.unpackRaw({ format: "other" }), /not a boot-timeline/);
  const p = M.packTrace('{"t_ns":1,"vcpu":0,"reason":"canceled"}\n{"t_ns":4,"vcpu":0,"reason":"vtimer"}\n', { id: "x", meta: {} });
  assert.deepEqual(p.rows, [1, 0, 0, 3, 1, 0]);
});

// --- axis, zoom, bins ---------------------------------------------------------------------------

test("axis: long silences are squeezed, short ones are not; x and t are inverses", () => {
  const h = M.makeAxis(loaded.healthy.A);
  assert.equal(h.squeeze, false);
  assert.equal(h.segs.length, 1);
  const n = M.makeAxis(loaded.notimer.A);
  assert.equal(n.squeeze, true);
  assert.deepEqual(n.segs.map((s) => s.squeezed), [false, true]);
  assert.ok(Math.abs(n.segs[1].x1 - n.segs[1].x0 - M.BREAK_W) < 1e-12);
  assert.equal(M.validateRaw([1, 2]).error, "not a JSON object");
  const flat = M.makeAxis(loaded.notimer.A, { squeeze: false });
  assert.equal(flat.squeeze, false);
  for (const ax of [h, n, flat]) {
    for (const t of [0, 1e5, 3e7, 6.1e7, 5e9, ax.end]) {
      assert.ok(Math.abs(M.xToT(ax, M.tToX(ax, t)) - Math.min(t, ax.end)) < 2, `${t}`);
    }
  }
  const tk = M.ticks(n, { v0: 0, v1: 1 });
  assert.equal(tk[0].label, "0");
  assert.ok(tk.some((t) => t.squeezed && /squeezed: 9\.90 s/.test(t.label)));
});

test("zoom and pan stay inside the run", () => {
  let v = { v0: 0, v1: 1 };
  v = M.zoom(v, 0.5, 0.9);
  assert.ok(Math.abs(v.v1 - v.v0 - 0.5) < 1e-12);
  assert.ok(v.v0 >= 0 && v.v1 <= 1);
  v = M.pan(v, 10);
  assert.equal(v.v1, 1);
  for (let i = 0; i < 40; i++) v = M.zoom(v, 0.5);
  assert.ok(Math.abs(v.v1 - v.v0 - M.MIN_VIEW_W) < 1e-12);
  v = M.zoom(v, 1e9);
  assert.deepEqual(v, { v0: 0, v1: 1 });
  const ax = M.makeAxis(loaded.healthy.A);
  const r = M.reveal(ax, { v0: 0, v1: 0.1 }, 200e6);
  assert.ok(M.tToX(ax, 200e6) >= r.v0 && M.tToX(ax, 200e6) <= r.v1);
});

test("bins: every shown exit lands in exactly one bin of its lanes", () => {
  for (const id of M.TRACE_IDS) {
    const { A } = loaded[id];
    const ax = M.makeAxis(A);
    const b = M.bin(A, ax, { v0: 0, v1: 1 }, new Set());
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    assert.equal(sum(b.counts.get("vcpu0")), A.count, id);
    const mmio = A.records.filter((r) => M.KINDS[r.kind].lane).length;
    const dev = [...b.counts.entries()].filter(([k]) => !k.startsWith("vcpu")).reduce((s, [, a]) => s + sum(a), 0);
    assert.equal(dev, mmio, id);
    const hidden = M.bin(A, ax, { v0: 0, v1: 1 }, new Set(["m"]));
    assert.equal(sum(hidden.counts.get("vcpu0")), A.count - mmio, `${id} with MMIO hidden`);
    const rows = M.counters(A, b, new Set());
    assert.equal(rows.reduce((s, r) => s + r.count, 0), A.count);
    assert.equal(rows.reduce((s, r) => s + r.inView, 0), A.count);
  }
  assert.equal(M.level(0, 10), 0);
  assert.equal(M.level(10, 10), 5);
  assert.equal(M.level(1, 1000), 1);
});

test("bin details name the busiest kinds of a slice", () => {
  const { A } = loaded.healthy;
  const ax = M.makeAxis(A);
  const view = { v0: 0, v1: 1 };
  const b = M.bin(A, ax, view, new Set());
  const i = b.counts.get("vcpu0").indexOf(Math.max(...b.counts.get("vcpu0")));
  const d = M.binDetails(ax, view, b, i);
  assert.ok(d.total > 0 && d.t1 > d.t0);
  assert.equal(d.kinds[0].label, M.KINDS[M.KIND_INDEX["uart-fr"]].label);
});

// --- events and share state ---------------------------------------------------------------------

test("events: milestones, failures, silences and the end, in time order", () => {
  for (const id of M.TRACE_IDS) {
    const ev = loaded[id].A.events;
    for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t, `${id} ${i}`);
    assert.equal(ev[ev.length - 1].type, "end");
    assert.equal(ev.filter((e) => e.type === "first-exit").length, 1);
  }
  const h = loaded.healthy.A.events;
  assert.equal(h.filter((e) => e.type === "call").length, 16);
  assert.equal(h.filter((e) => e.type === "sysreg").length, 2);
  assert.ok(h.some((e) => e.type === "milestone" && e.stage === 8));
  assert.equal(h.find((e) => e.type === "end").title, "Last exit: power-off");
});

test("share state: round trip, default, and junk", () => {
  const s = { trace: "gicr", hidden: new Set(["m", "c"]), squeeze: false, boot: 0, window: [40_000_000, 125_000_000], event: 7 };
  const h = M.encodeHash(s);
  assert.equal(h, "gicr.hmc.r.w40000-125000.e7");
  assert.deepEqual(M.decodeHash(h), s);
  assert.equal(M.encodeHash({ trace: "healthy", hidden: new Set(), squeeze: true, boot: 0, window: null, event: null }), null);
  for (const junk of ["", "nope", "healthy.x", "healthy.hz", "healthy.w5-1", "healthy.e123456", "a".repeat(200), "healthy.<b>", "file.e1.."]) {
    assert.equal(M.decodeHash(junk), null, junk);
  }
  assert.deepEqual(M.decodeHash("file.b2"), { trace: "file", hidden: new Set(), squeeze: true, boot: 2, window: null, event: null });
});

test("the reference share state points at breakage 1's silence", () => {
  const labs = read("course/site/LABS.md");
  const row = labs.split("\n").find((l) => l.startsWith("| `boot-timeline` |"));
  assert.ok(row, "LABS.md has the boot-timeline row");
  const ref = /`(notimer\.e\d+)` is the reference/.exec(row)[1];
  const s = M.decodeHash(ref);
  const e = loaded.notimer.A.events[s.event];
  assert.equal(e.type, "gap");
  assert.match(e.title, /^No exit for 9\.90 s, then a canceled exit/);
  assert.equal(e.then.how, "cancel");
  assert.match(e.text, /end Kernel panic - not syncing: Unable to initialise architected timer/);
});

test("format helpers", () => {
  assert.equal(M.fmtTime(999), "999 ns");
  assert.equal(M.fmtTime(1500), "1.50 µs");
  assert.equal(M.fmtTime(46_051_875), "46.05 ms");
  assert.equal(M.fmtTime(9_903_342_000), "9.90 s");
  assert.equal(M.fmtTime(12_000_000_000), "12.0 s");
  assert.equal(M.fmtInt(32829), "32,829");
  assert.equal(M.fmtBytes(32 * 1024 * 1024), "32 MiB");
});

// --- review fixes: endings, windows, repeated lines ---------------------------------------------

test("SMP: a power-off followed by the kicked vCPUs' canceled exits is a power-off", () => {
  // 20-race-trace.txt: a real 4-vCPU run, exit 0, SYSTEM_OFF then canceled on vCPUs 2, 3 and 1.
  const p = M.parseTrace(read("course/captures/20-race-trace.txt"));
  assert.ok(p.ok);
  assert.equal(p.partial, null);
  const A = M.analyze(p.records, { partial: p.partial });
  assert.deepEqual(A.records.slice(-3).map((r) => r.reason), ["canceled", "canceled", "canceled"]);
  const end = A.fingerprint.ended;
  assert.equal(end.how, "off");
  assert.equal(end.status, "0");
  assert.match(end.text, /The other vCPUs were then kicked out of the guest \(3 canceled exits\)/);
  assert.equal(A.events[A.events.length - 1].title, "Last exit: power-off");
  // It was traced with psci,cancel only, and the lab says so instead of "no milestone".
  assert.ok(A.noMmio);
  assert.match(A.fingerprint.stageText, /recorded without mmio/);
});

test("endings: quiet time is measured from the last real exit, on any vCPU count", () => {
  const rec = (t, vcpu, extra = {}) => JSON.stringify({ t_ns: t, vcpu, reason: "exception", ec: "0x24", ipa: "0x9000018", wnr: false, size: 4, value: "0x90", action: "mmio", ...extra });
  const cancel = (t, vcpu) => JSON.stringify({ t_ns: t, vcpu, reason: "canceled" });
  const smpTimeout = [rec(1000, 0), rec(2000, 1), cancel(5_000_002_000, 1), cancel(5_000_003_000, 0)].join("\n");
  const e1 = M.analyze(M.parseTrace(smpTimeout).records).fingerprint.ended;
  assert.equal(e1.how, "canceled");
  assert.equal(e1.quiet, 5_000_001_000);
  assert.match(e1.text, /^After 5\.00 s with no exits at all, the run ended with canceled exits on 2 vCPUs: something outside the guest stopped it \(exit status 5 for --timeout, 130 for SIGINT, SIGTERM or Ctrl-A x\)\.$/);
  const reset = [rec(1000, 0), JSON.stringify({ t_ns: 2000, vcpu: 0, reason: "exception", ec: "0x16", imm: 0, fn: "PSCI_SYSTEM_RESET", action: "psci" }), cancel(3000, 1)].join("\n");
  assert.equal(M.analyze(M.parseTrace(reset).records).fingerprint.ended.how, "reset");
  const stop = [rec(1000, 0, { action: "stop", ipa: "0xc000000" }), cancel(3000, 1)].join("\n");
  const e3 = M.analyze(M.parseTrace(stop).records).fingerprint.ended;
  assert.equal(e3.how, "stop");
  assert.match(e3.text, /exit status 3: a fatal guest error, such as unhandled MMIO, an instruction abort or an exit the VMM does not handle/);
  const dbg = JSON.stringify({ t_ns: 9, vcpu: 0, reason: "exception", ec: "0x17", imm: 0, fn: "DEBUG_EXIT", action: "smccc" });
  const e4 = M.analyze(M.parseTrace(dbg).records).fingerprint.ended;
  assert.equal(e4.how, "debug-exit");
  assert.equal(e4.status, "0 or 6");
  // The status texts follow StopReason::exit_code in crates/vmm/src/control.rs.
  const codes = read("crates/vmm/src/control.rs").split("pub fn exit_code(&self) -> i32 {")[1].split("}")[0];
  assert.match(codes, /DebugExit\(0\) => 0/);
  assert.match(codes, /GuestFatal\(_\) => 3/);
  assert.match(codes, /Reset => 4/);
  assert.match(codes, /Timeout => 5/);
  assert.match(codes, /DebugExit\(_\) => 6/);
  assert.match(codes, /UserQuit => 130/);
});

test("ring dumps are windows: no missing milestones, no ending, repeats dropped", () => {
  const dump = read("course/captures/14-no-timer-usr1.txt");
  const p = M.parseTrace(dump);
  assert.equal(p.partial, "dump");
  assert.equal(p.records.length, 256);
  const A = M.analyze(p.records, { partial: p.partial });
  assert.deepEqual(A.fingerprint.missing, []);
  assert.equal(A.fingerprint.ended.how, "window");
  assert.match(A.fingerprint.stageText, /window of the last exits/);
  assert.equal(A.gaps.some((g) => g.after === -1), false, "no silence from t = 0 in a window");
  // Ctrl-A t pressed twice: the same records twice.
  const json = dump.split("\n").filter((l) => l.trim().startsWith("{")).join("\n");
  const twice = M.parseTrace(`${json}\n${json}`);
  assert.equal(twice.records.length, 256);
  assert.equal(twice.duplicates, 256);
  assert.equal(twice.partial, "duplicates");
  assert.equal(M.analyze(twice.records, { partial: twice.partial }).fingerprint.ended.how, "window");
});

test("repeated lines: the panic trailer is not a second failure, identical lines are one moment", () => {
  const n = loaded.notimer.A;
  assert.equal(n.failures.length, 2);
  assert.ok(n.milestones.some((m) => m.label === "End of the panic report"));
  const g = loaded.gicr.A;
  assert.equal(g.failures.filter((f) => f.labels.includes("panic")).length, 1);
  const titles = g.events.filter((e) => e.type === "failure").map((e) => e.title);
  assert.equal(new Set(titles).size, titles.length, "failure titles are distinct");
  assert.ok(titles.includes("Kernel reports: No redistributor present (again)"));
  const h = loaded.healthy.A;
  assert.equal(h.milestones.filter((m) => m.label === "Console on ttyAMA0").length, 1);
  assert.equal(h.milestones.filter((m) => m.stage === 6).length, 3);
  for (const id of M.TRACE_IDS) {
    const t = loaded[id].A.events.filter((e) => e.type === "milestone" || e.type === "failure").map((e) => e.title);
    assert.equal(new Set(t).size, t.length, `${id}: every console moment's title is distinct`);
  }
});

test("silences say what follows them, and milestones carry the kernel's own stamp", () => {
  const h = loaded.healthy.A;
  const g = h.topGaps[0];
  assert.equal(M.fmtTime(g.dur), "46.05 ms");
  assert.equal(g.then.how, "milestone");
  assert.match(g.then.text, /stage 7, initramfs unpacked/);
  assert.match(M.summary(h, "x"), /Longest silence: 46\.05 ms from 162\.64 ms, then stage 7, initramfs unpacked\./);
  assert.equal(loaded.notimer.A.topGaps[0].then.how, "cancel");
  const boot = h.events.find((e) => e.type === "milestone" && e.stage === 1);
  assert.equal(boot.stamp, "0.000000");
  assert.equal(M.kernelStamp("[   12.345678] x"), "12.345678");
  assert.equal(M.kernelStamp("macvmm-initramfs: ready"), null);
});

test("the canceled label names the no-GIC timer kick too", () => {
  assert.match(M.KINDS[M.KIND_INDEX.canceled].label, /no-GIC timer delivery/);
});
