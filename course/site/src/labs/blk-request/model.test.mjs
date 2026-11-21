// Tests for the blk-request model. Three sources keep it honest:
//  1. crates/vmm/src/virtio/blk.rs (constants, request types, status values, feature bits,
//     the order of the checks), re-read here so a change in the Rust shows up as a failure;
//  2. chapter 18 (its lab fallback, its tables, the first breakage and the explain-back answer),
//     parsed where the lesson states a number;
//  3. crates/vmm/tests/virtio_blk_hostile.rs, whose cases are ported one by one (same disk of
//     64 sectors, same lengths, same expected status and used length).
// No vector file exists for virtio-blk (course/site/labs/vectors/ has esr, fdt and virtqueue),
// so the test says so instead of passing silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "./model.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../../../../../");
const BLK_RS = readFileSync(`${ROOT}crates/vmm/src/virtio/blk.rs`, "utf8");
const MOD_RS = readFileSync(`${ROOT}crates/vmm/src/virtio/mod.rs`, "utf8");
const FILE_RS = readFileSync(`${ROOT}crates/vmm/src/backend/file.rs`, "utf8");
const HOSTILE_RS = readFileSync(`${ROOT}crates/vmm/tests/virtio_blk_hostile.rs`, "utf8");
const LESSON = readFileSync(`${ROOT}course/chapters/VII/18-virtio-blk.md`, "utf8");

const { run, defaultState, cloneState, STATUS, REQ } = M;

/** A request like the host tests' `Dev::request`: header, optional data, status. */
function req(kind, sector, dataLen, patch = {}) {
  const s = { ...defaultState(), type: kind, sector: BigInt(sector), ...patch };
  const dir = kind === REQ.OUT;
  s.descs = [{ w: false, len: 16, n: 1 }];
  if (dataLen > 0) s.descs.push({ w: !dir, len: dataLen, n: 1 });
  s.descs.push({ w: true, len: 1, n: 1 });
  return s;
}
/** A chain like `Dev::submit`: [dir, len, repeat]. */
function chain(kind, sector, rows, patch = {}) {
  return { ...defaultState(), type: kind, sector: BigInt(sector), ...patch, descs: rows.map(([d, len, n = 1]) => ({ w: d === "w", len, n })) };
}
function answered(s, status, used) {
  const r = run(s);
  assert.equal(r.outcome.kind, "status", r.summary);
  assert.equal(r.outcome.status, status, r.summary);
  assert.equal(r.outcome.used, used, r.summary);
  return r;
}
const untouched = (r) => { assert.equal(r.disk.reads.length + r.disk.writes.length, 0, r.summary); };
const fired = (r) => r.checks.find((c) => c.verdict === "fail")?.id;

// ---- 1. the Rust source --------------------------------------------------------------------

test("constants match blk.rs and file.rs", () => {
  const num = (re, src = BLK_RS) => { const m = re.exec(src); assert.ok(m, String(re)); return m[1]; };
  assert.equal(Number(num(/pub const BLK_QUEUE_SIZE: u16 = (\d+);/)), M.BLK_QUEUE_SIZE);
  assert.equal(num(/pub const SIZE_MAX: u32 = ([\d *]+);/).replace(/\s/g, ""), "64*1024");
  assert.equal(M.SIZE_MAX, 64 * 1024);
  assert.equal(Number(num(/pub const SEG_MAX: u32 = (\d+);/)), M.SEG_MAX);
  assert.match(BLK_RS, /pub const BLK_MAX_DATA: u64 = SEG_MAX as u64 \* SIZE_MAX as u64;/);
  assert.equal(M.BLK_MAX_DATA, 126 * 65536);
  assert.equal(Number(num(/pub const BLK_HDR_LEN: u64 = (\d+);/)), M.BLK_HDR_LEN);
  assert.equal(Number(num(/pub const BLK_ID_BYTES: usize = (\d+);/)), M.BLK_ID_BYTES);
  assert.equal(Number(num(/pub const BLK_CONFIG_LEN: u32 = (\d+);/)), M.BLK_CONFIG_LEN);
  assert.equal(BigInt(num(/pub const SECTOR_SIZE: u64 = (\d+);/, FILE_RS)), M.SECTOR_SIZE);
});

test("request types, status values and feature bits match blk.rs and mod.rs", () => {
  const mod = (name) => { const m = new RegExp(`pub mod ${name} \\{([\\s\\S]*?)\\n\\}`).exec(BLK_RS); assert.ok(m, name); return m[1]; };
  const consts = (body) => Object.fromEntries([...body.matchAll(/pub const (\w+): \w+ = ([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const r = consts(mod("req"));
  assert.deepEqual(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])), { ...M.REQ });
  const st = consts(mod("blk_status"));
  assert.deepEqual(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, Number(v)])), { ...M.STATUS });
  const f = consts(mod("blk_features"));
  const bit = (v) => Number(/^1 << (\d+)$/.exec(v)[1]);
  const byName = Object.fromEntries(M.FEATURES.map((x) => [x.name, x.bit]));
  for (const n of ["SEG_MAX", "RO", "BLK_SIZE", "FLUSH"]) assert.equal(bit(f[n]), byName[n], n);
  assert.equal(bit(/pub const INDIRECT_DESC: u64 = (1 << \d+);/.exec(MOD_RS)[1]), byName.INDIRECT_DESC);
  assert.equal(bit(/pub const VERSION_1: u64 = (1 << \d+);/.exec(MOD_RS)[1]), byName.VERSION_1);
  // device_features: exactly these, RO only for ,ro; never SIZE_MAX or CONFIG_WCE.
  const df = /fn device_features[\s\S]*?\n {4}\}/.exec(BLK_RS)[0];
  for (const n of ["VERSION_1", "INDIRECT_DESC", "SEG_MAX", "BLK_SIZE", "FLUSH", "RO"]) assert.match(df, new RegExp(`::${n}\\b`), n);
  assert.doesNotMatch(df, /SIZE_MAX\b(?!.*SEG)|CONFIG_WCE/);
  assert.equal(M.offeredFeatures(false) & (1n << 5n), 0n);
  assert.notEqual(M.offeredFeatures(true) & (1n << 5n), 0n);
  assert.equal(M.offeredFeatures(false) & (1n << 1n), 0n, "SIZE_MAX is not offered");
});

test("the checks run in blk.rs's order", () => {
  // execute: status byte first; parse: header, then the segment count; parse_and_run: the type
  // match (IN, OUT with the read-only check first, FLUSH, GET_ID, wrong direction, unknown).
  const at = (needle) => { const i = BLK_RS.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at("let status_at = last_byte(&req.writable)") < at("self.parse_and_run(mem, req, data_in)"));
  assert.ok(at("if req.readable_len < BLK_HDR_LEN") < at("if descs > max.saturating_add(2)"));
  const io = at("req::OUT if data_in == 0 =>");
  assert.ok(io < at("if self.read_only {\n                    return Err(IOERR); // a read-only disk"));
  assert.ok(at("if self.read_only {\n                    return Err(IOERR); // a read-only disk") < at("let offset = self.bounds_check(hdr.sector, data_out)"));
  assert.ok(at("req::IN | req::OUT | req::FLUSH | req::GET_ID => Err(IOERR)") < at("_ => Err((blk_status::UNSUPP, 0))"));
  const bc = /fn bounds_check[\s\S]*?\n {4}\}/.exec(BLK_RS)[0];
  assert.ok(bc.indexOf("is_multiple_of(SECTOR_SIZE) || len > BLK_MAX_DATA") < bc.indexOf("checked_mul"));
  assert.ok(bc.indexOf("checked_mul") < bc.indexOf("checked_add"));
  assert.match(bc, /\(end <= self\.capacity_bytes\)\.then_some\(offset\)/);
});

test("the disk pattern and the serial are the host tests' own", () => {
  assert.match(HOSTILE_RS, /\.map\(\|i\| \(i \* 7 \+ i \/ 512\) as u8\)/);
  assert.match(HOSTILE_RS, /const SECTORS: usize = 64;/);
  for (const i of [0n, 1n, 511n, 512n, 1536n, 32767n]) assert.equal(M.diskByte(i), Number((i * 7n + i / 512n) % 256n));
  assert.match(BLK_RS, /format!\("macvmm-disk\{index\}"\)/);
  assert.deepEqual(M.diskSerial(0).slice(0, 12).map((b) => String.fromCharCode(b)).join(""), "macvmm-disk0");
  assert.deepEqual(M.diskSerial(0).slice(12), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(M.diskSerial(10).slice(0, 13).map((b) => String.fromCharCode(b)).join(""), "macvmm-disk10");
});

test("no virtio-blk vector file exists yet", (t) => {
  const p = `${ROOT}course/site/labs/vectors/blk.json`;
  if (!existsSync(p)) t.skip("labs/vectors/blk.json does not exist; the hostile host tests are ported below instead");
  else assert.fail("labs/vectors/blk.json now exists: add a test that runs every vector through the model");
});

// ---- 2. the lesson ---------------------------------------------------------------------------

test("reproduces the lesson's fallback exactly", () => {
  const line = LESSON.split("\n").find((l) => l.startsWith("If the lab does not load: 512 bytes at sector"));
  assert.ok(line, "fallback line");
  const m = /(\d+) bytes at sector (\d+) of a (\d+)-sector \((\d+) KiB\) disk fails rule (\d), because `(\d+) × 512 \+ (\d+) = (\d+) > (\d+)`: status `(\w+)`, used length (\d+)\./.exec(line);
  assert.ok(m, line);
  const [, len, sector, sectors, kib, rule, s2, len2, end, capB, status, used] = m;
  assert.equal(Number(sectors) * 512, Number(kib) * 1024);
  const st = defaultState();
  assert.equal(st.cap, BigInt(sectors));
  assert.equal(st.sector, BigInt(sector));
  assert.equal(st.descs[1].len, Number(len));
  const r = run(st);
  assert.equal(fired(r), `r${rule}`);
  assert.equal(r.outcome.status, STATUS[status]);
  assert.equal(r.outcome.used, Number(used));
  assert.equal(r.bounds.end, BigInt(end));
  assert.equal(r.capBytes, BigInt(capB));
  assert.equal(s2, sector);
  assert.equal(len2, len);
  assert.ok(r.summary.includes(`${sector} × 512 + ${len} = ${end} > ${capB}`), r.summary);
  assert.match(r.summary, /Status IOERR \(1\), used length 1\. The disk file is never touched\./);
  untouched(r);
});

test("the type and status tables and the configuration table", () => {
  for (const [name, value] of [["IN", 0], ["OUT", 1], ["FLUSH", 4], ["GET_ID", 8]]) {
    assert.match(LESSON, new RegExp(`\\| ${name} \\| ${value} \\|`));
    assert.equal(M.REQ[name], value);
  }
  assert.match(LESSON, /status `UNSUPP` \(2\)/);
  assert.match(LESSON, /`OK` \(0\), \[`IOERR`\]\([^)]*\) \(1\)/);
  const c = M.configBytes(64n);
  const le = (o, n) => c.slice(o, o + n).reduceRight((a, b) => a * 256 + b, 0);
  assert.equal(le(0, 8), 64);
  assert.match(LESSON, /\| 8 \| `size_max` \| le32 \| 65536/);
  assert.equal(le(8, 4), 65536);
  assert.match(LESSON, /\| 12 \| `seg_max` \| le32 \| 126 \|/);
  assert.equal(le(12, 4), 126);
  assert.equal(le(16, 4), 0);
  assert.match(LESSON, /\| 20 \| `blk_size` \| le32 \| 512 \|/);
  assert.equal(le(20, 4), 512);
  // The six rules, in the lesson's order and with the lesson's names.
  const rules = [...LESSON.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => [Number(m[1]), m[2]]);
  assert.deepEqual(rules.map((r) => r[0]), [1, 2, 3, 4, 5, 6]);
  assert.match(rules[0][1], /status byte/);
  assert.match(rules[2][1], /128 descriptors/);
});

test("deliberate breakage 1: wrapping arithmetic, as the lesson tells it", () => {
  // "It asks for sector 2^55; 2^55 × 512 = 2^64 wraps to 0, so the check saw offset 0, end 512
  // and the device answered OK ... with sector 0's contents."
  assert.match(LESSON, /It asks for sector `2\^55`; `2\^55 × 512 = 2\^64` wraps to 0, so the check saw "offset 0, end 512"/);
  const s = req(REQ.IN, 1n << 55n, 512, { ar: "w" });
  const r = answered(s, STATUS.OK, 513);
  assert.equal(r.bounds.offset, 0n);
  assert.equal(r.bounds.end, 512n);
  assert.deepEqual(r.disk.reads, [{ offset: 0n, len: 512 }]);
  for (let i = 0; i < 512; i++) assert.equal(M.writableByteAfter(s, r, i), M.diskByte(BigInt(i)));
  assert.match(r.summary, /A wrapped offset is a valid offset, only the wrong one/);
  // "the sector is u64::MAX / 512. Times 512 that is 2^64 − 512, which fits; adding the length
  // wrapped the end to 0, so 0 <= capacity passed and the huge offset reached the test's disk."
  assert.match(LESSON, /the sector is `u64::MAX \/ 512`\. Times 512 that is `2\^64 − 512`, which fits; adding the length wrapped the \*end\* to 0/);
  const r2 = run(req(REQ.IN, M.U64_MAX / 512n, 512, { ar: "w" }));
  assert.equal(r2.outcome.kind, "backend");
  assert.equal(r2.bounds.offset, M.U64 - 512n);
  assert.equal(r2.bounds.end, 0n);
  assert.deepEqual(r2.disk.reads, [{ offset: M.U64 - 512n, len: 512 }]);
  // The capture's panic shows that very offset: "range start index 18446744073709551104".
  const cap = readFileSync(`${ROOT}course/captures/18-break-wrap.txt`, "utf8");
  assert.match(cap, new RegExp(`range start index ${(M.U64 - 512n).toString()} out of range`));
});

test("deliberate breakage 1, plain arithmetic: two multiply panics and one add panic", () => {
  assert.match(LESSON, /two with `attempt to multiply with overflow`, and the past-the-end one with `attempt to add with overflow`/);
  const mul = run(req(REQ.IN, 1n << 55n, 512, { ar: "p" }));
  assert.equal(mul.outcome.kind, "panic");
  assert.equal(mul.bounds.panic, "attempt to multiply with overflow");
  const add = run(req(REQ.IN, M.U64_MAX / 512n, 512, { ar: "p" }));
  assert.equal(add.bounds.panic, "attempt to add with overflow");
  // The capture of the plain version names both messages.
  const cap = readFileSync(`${ROOT}course/captures/18-break-mul.txt`, "utf8");
  assert.match(cap, /attempt to multiply with overflow/);
  assert.match(cap, /attempt to add with overflow/);
  // In-range requests behave the same under every arithmetic.
  for (const ar of ["c", "w", "p"]) answered(req(REQ.IN, 3, 1024, { ar }), STATUS.OK, 1025);
});

test("the explain-back chain gives the lesson's answer", () => {
  // Descriptor 0 readable 8 (type 1, reserved 0); 1 readable 520 (sector 0x0080_0000_0000_0000,
  // then 512 bytes); 2 writable 1. The disk is ,ro.
  assert.match(LESSON, /\| 0 \| readable \| 8 \| `type = 1`, `reserved = 0` \|/);
  assert.match(LESSON, /\| 1 \| readable \| 520 \| `sector = 0x0080_0000_0000_0000`, then 512 bytes of data \|/);
  assert.match(LESSON, /\| 2 \| writable \| 1 \| the status byte \|/);
  const s = M.presetById("explain-back").state;
  assert.equal(s.sector, 0x0080_0000_0000_0000n);
  assert.equal(s.sector, 1n << 55n);
  const r = answered(s, STATUS.IOERR, 1);
  assert.equal(r.readableLen, 528, "528 readable bytes");
  assert.equal(r.headerFrom, 2, "the header comes from two descriptors");
  assert.equal(fired(r), "r5");
  for (const id of ["walk", "r1", "r2", "r3", "r4"]) assert.equal(r.checks.find((c) => c.id === id).verdict, "pass", id);
  untouched(r);
  // "on a read-write disk rule 6 refuses it ... and C's arithmetic would have overwritten sector 0."
  const rw = run({ ...cloneState(s), ro: false });
  assert.equal(fired(rw), "r6");
  assert.equal(rw.outcome.status, STATUS.IOERR);
  const c = run({ ...cloneState(s), ro: false, ar: "w" });
  assert.equal(c.outcome.status, STATUS.OK);
  assert.deepEqual(c.disk.writes, [{ offset: 0n, len: 512 }]);
});

test("GET_ID: 12 visible characters, 20 bytes written, used length 21", () => {
  assert.match(LESSON, /Look for 12 visible characters; the device wrote all 20, the other 8 being zero padding, so the used length was 21/);
  const s = req(REQ.GET_ID, 0, 20);
  const r = answered(s, STATUS.OK, 21);
  const got = Array.from({ length: 20 }, (_, i) => M.writableByteAfter(s, r, i));
  assert.equal(String.fromCharCode(...got.slice(0, 12)), "macvmm-disk0");
  assert.deepEqual(got.slice(12), new Array(8).fill(0));
  const cap = readFileSync(`${ROOT}course/captures/18-get-id.txt`, "utf8");
  assert.match(cap, /^macvmm-disk0/m);
});

// ---- 3. the hostile host tests, ported -------------------------------------------------------

test("hostile tests: the happy paths", () => {
  answered(req(REQ.IN, 3, 1024), STATUS.OK, 1025);
  const w = answered(req(REQ.OUT, 7, 512), STATUS.OK, 1);
  assert.deepEqual(w.disk.writes, [{ offset: 7n * 512n, len: 512 }]);
  assert.equal(w.disk.syncs, 0, "write-back: no sync on OUT");
  answered(req(REQ.IN, 0, 256 * 1024, { cap: 1024n }), STATUS.OK, 256 * 1024 + 1);
});

test("hostile tests: sector past the end, overflow, odd lengths", () => {
  for (const [sector, len] of [[64n, 512], [63n, 1024], [M.U64_MAX / 512n, 512]]) {
    untouched(answered(req(REQ.IN, sector, len), STATUS.IOERR, 1));
    untouched(answered(req(REQ.OUT, sector, len), STATUS.IOERR, 1));
  }
  answered(req(REQ.IN, 63, 512), STATUS.OK, 513);
  for (const sector of [1n << 55n, (1n << 55n) + 1n, M.U64_MAX]) {
    const s = req(REQ.IN, sector, 512);
    const r = answered(s, STATUS.IOERR, 1);
    untouched(r);
    for (let i = 0; i < 512; i++) assert.equal(M.writableByteAfter(s, r, i), M.GUEST_OLD_BYTE);
  }
  for (const len of [1, 100, 511, 513, 1000]) {
    untouched(answered(req(REQ.IN, 0, len), STATUS.IOERR, 1));
    untouched(answered(req(REQ.OUT, 0, len), STATUS.IOERR, 1));
  }
});

test("hostile tests: the status descriptor", () => {
  // Header and data both readable: nowhere to write a status.
  let r = run(chain(REQ.OUT, 0, [["r", 16], ["r", 512]]));
  assert.equal(r.outcome.kind, "reset");
  assert.equal(fired(r), "r1");
  untouched(r);
  assert.equal(run(chain(REQ.IN, 0, [["r", 16]])).outcome.kind, "reset");
  // Readable after writable: the walk refuses (ReadableAfterWritable).
  r = run(chain(REQ.IN, 0, [["r", 16], ["w", 512], ["r", 1]]));
  assert.equal(r.outcome.kind, "reset");
  assert.equal(fired(r), "walk");
  assert.match(r.checks[0].detail, /ReadableAfterWritable/);
  r = run(chain(REQ.FLUSH, 0, [["r", 16], ["r", 1]]));
  assert.equal(fired(r), "r1");
  assert.equal(r.disk.syncs, 0);
  // Zero-length status: the walk refuses (ZeroLength).
  r = run(chain(REQ.IN, 0, [["r", 16], ["w", 512], ["w", 0]]));
  assert.equal(fired(r), "walk");
  assert.match(r.checks[0].detail, /ZeroLength/);
  untouched(r);
  // A 16-byte status descriptor on FLUSH: 15 data bytes, IOERR, only the last byte written.
  const s = chain(REQ.FLUSH, 0, [["r", 16], ["w", 16]]);
  r = answered(s, STATUS.IOERR, 1);
  for (let i = 0; i < 15; i++) assert.equal(M.writableByteAfter(s, r, i), M.GUEST_OLD_BYTE);
  assert.equal(M.writableByteAfter(s, r, 15), STATUS.IOERR);
});

test("hostile tests: the header", () => {
  for (const n of [1, 8, 15]) untouched(answered(chain(REQ.IN, 0, [["r", n], ["w", 512], ["w", 1]]), STATUS.IOERR, 1));
  const r = answered(chain(REQ.IN, 0, [["w", 16], ["w", 512], ["w", 1]]), STATUS.IOERR, 1);
  assert.equal(fired(r), "r2");
  untouched(r);
  // Any layout: split header, data and status merged.
  const s = chain(REQ.IN, 2, [["r", 8], ["r", 8], ["w", 513]]);
  const sp = run(s);
  assert.equal(sp.outcome.used, 513);
  assert.equal(M.writableByteAfter(s, sp, 512), STATUS.OK);
  for (let i = 0; i < 512; i++) assert.equal(M.writableByteAfter(s, sp, i), M.diskByte(1024n + BigInt(i)));
  const out = answered(chain(REQ.OUT, 5, [["r", 16 + 512], ["w", 1]], { fill: 0x77 }), STATUS.OK, 1);
  assert.deepEqual(out.disk.writes, [{ offset: 5n * 512n, len: 512 }]);
});

test("hostile tests: direction, read-only, unknown types", () => {
  untouched(answered(chain(REQ.IN, 0, [["r", 16], ["r", 512], ["w", 1]]), STATUS.IOERR, 1));
  untouched(answered(chain(REQ.OUT, 0, [["r", 16], ["w", 512], ["w", 1]]), STATUS.IOERR, 1));
  const ro = { ro: true };
  const r = answered(req(REQ.OUT, 0, 512, ro), STATUS.IOERR, 1);
  assert.equal(fired(r), "r5");
  untouched(r);
  answered(req(REQ.IN, 0, 512, ro), STATUS.OK, 513);
  const f = answered(req(REQ.FLUSH, 0, 0, ro), STATUS.OK, 1);
  assert.equal(f.disk.syncs, 0, "FLUSH on a read-only disk does not sync");
  for (const kind of [2, 3, 5, 7, 11, 13, 0x8000_0000, M.U32_MAX]) untouched(answered(req(kind, 0, 512), STATUS.UNSUPP, 1));
});

test("hostile tests: GET_ID lengths and disk numbers", () => {
  answered(req(REQ.GET_ID, 0, 20), STATUS.OK, 21);
  const s8 = req(REQ.GET_ID, 0, 8);
  const r8 = answered(s8, STATUS.OK, 9);
  assert.equal(String.fromCharCode(...Array.from({ length: 8 }, (_, i) => M.writableByteAfter(s8, r8, i))), "macvmm-d");
  answered(req(REQ.GET_ID, 0, 512), STATUS.OK, 21);
  const s1 = req(REQ.GET_ID, 0, 20, { disk: 1, cap: 8n });
  const r1 = run(s1);
  assert.equal(String.fromCharCode(...Array.from({ length: 12 }, (_, i) => M.writableByteAfter(s1, r1, i))), "macvmm-disk1");
});

test("hostile tests: FLUSH, write-back and write-through", () => {
  const f = answered(req(REQ.FLUSH, 0, 0), STATUS.OK, 1);
  assert.equal(f.disk.syncs, 1);
  assert.equal(answered(req(REQ.OUT, 0, 512), STATUS.OK, 1).disk.syncs, 0);
  assert.equal(answered(req(REQ.OUT, 0, 512, { wb: false }), STATUS.OK, 1).disk.syncs, 1);
  // Write-through does not sync a refused write (the test's out-of-range OUT).
  assert.equal(run(req(REQ.OUT, 64, 512, { wb: false })).disk.syncs, 0);
});

test("hostile tests: segment and size caps", () => {
  const big = { cap: 1n << 15n };
  untouched(answered(chain(REQ.IN, 0, [["r", 16], ["w", 512 * 1024, 17], ["w", 1]], big), STATUS.IOERR, 1));
  answered(chain(REQ.IN, 0, [["r", 16], ["w", M.SIZE_MAX, M.SEG_MAX], ["w", 1]], big), STATUS.OK, M.BLK_MAX_DATA + 1);
  // Well over the cap is IOERR, never a reset: 40 and 254 buffers of 512 KiB.
  // 40 buffers (42 descriptors) reach rule 6's byte cap; 254 (256 descriptors) stop at rule 3.
  for (const [n, rule] of [[40, "r6"], [M.BLK_QUEUE_SIZE - 2, "r3"]]) {
    const r = answered(chain(REQ.IN, 0, [["r", 16], ["w", 512 * 1024, n], ["w", 1]], big), STATUS.IOERR, 1);
    assert.equal(fired(r), rule, `${n} buffers`);
    untouched(r);
  }
  // 127 one-sector buffers: rule 3. 126 of 256 bytes: fine.
  const r = answered(chain(REQ.IN, 0, [["r", 16], ["w", 512, 127], ["w", 1]]), STATUS.IOERR, 1);
  assert.equal(fired(r), "r3");
  answered(chain(REQ.IN, 0, [["r", 16], ["w", 256, 126], ["w", 1]]), STATUS.OK, 126 * 256 + 1);
  // More descriptors than the queue: the walk's hop budget.
  const long = run(chain(REQ.IN, 0, [["r", 16], ["w", 1, 256]]));
  assert.equal(fired(long), "walk");
  assert.equal(long.outcome.kind, "reset");
});

test("the hop budget is the direct table's; rule 3 counts every descriptor", () => {
  // chain.rs: budget = queue_size for the queue's own table, restarting at len / 16 inside an
  // indirect table. The lab models the direct table only, and says so.
  assert.match(readFileSync(`${ROOT}crates/vmm/src/virtio/chain.rs`, "utf8"), /self\.budget = entries; \/\/ the hop budget restarts/);
  const at = run(chain(REQ.IN, 0, [["r", 16], ["w", 1, 254], ["w", 1]])); // 256: inside the budget
  assert.equal(fired(at), "r3", "256 descriptors pass the walk and reach rule 3");
  assert.equal(at.outcome.status, STATUS.IOERR);
  assert.equal(at.outcome.used, 1);
  const over = run(chain(REQ.IN, 0, [["r", 16], ["w", 1, 255], ["w", 1]])); // 257
  assert.equal(fired(over), "walk");
  assert.equal(over.outcome.kind, "reset");
  const walk = over.checks.find((c) => c.id === "walk").detail;
  assert.match(walk, /in the queue's own table/);
  assert.match(walk, /a driver may choose a smaller queue/);
  assert.match(walk, /Through an indirect table the budget restarts, and such a chain would reach rule 3 instead/);
});

test("wrap notes name each wrap that happened", () => {
  const mul = M.boundsCheck(1n << 55n, 512, 32768n, "w");
  assert.ok(mul.mulWrapped && !mul.addWrapped);
  assert.match(mul.detail, /\(wrapped: the true offset is 2\^64, which does not fit in 64 bits\)/);
  const add = M.boundsCheck(M.U64_MAX / 512n, 512, 32768n, "w");
  assert.ok(!add.mulWrapped && add.addWrapped);
  assert.equal(add.end, 0n);
  assert.match(add.detail, /\(wrapped: the true end is 2\^64, which does not fit in 64 bits\)/);
  const both = M.boundsCheck(M.U64_MAX, 512, 32768n, "w");
  assert.ok(both.mulWrapped && both.addWrapped);
  assert.equal(both.offset, M.U64 - 512n);
  assert.equal(both.end, 0n);
  assert.match(both.detail, /wrapped twice: the true offset is 0x1ff_ffff_ffff_ffff_fe00 and the true end is 2\^73, neither fits in 64 bits/);
});

test("summaries: bounce buffers sized per chunk, chapter references, the backend note", () => {
  const r = run(req(REQ.IN, 3, 512));
  assert.match(r.summary, /copies 512 bytes from disk offset 1536 into the guest's buffers \(through fresh, zeroed bounce buffers of at most 64 KiB each, one per chunk\)/);
  const zero = run(req(REQ.IN, 3, 0));
  assert.equal(zero.outcome.used, 1);
  assert.doesNotMatch(zero.summary, /bounce/);
  assert.match(zero.summary, /has no data to copy/);
  const lesson = run(req(REQ.IN, M.U64_MAX / 512n, 512, { ar: "w" }));
  assert.match(lesson.summary, /this is the request of chapter 18's wrapping run/);
  assert.match(run(req(REQ.IN, M.U64_MAX / 512n, 512, { ar: "w" }), { embedded: true }).summary, /this chapter's wrapping run/);
  const other = run(req(REQ.IN, M.U64_MAX, 512, { ar: "w" }));
  assert.equal(other.outcome.kind, "backend");
  assert.match(other.summary, /in chapter 18's wrapping run, sector u64::MAX \/ 512 got this far/);
  assert.match(other.summary, /wrapped twice/);
});

test("every outcome can be predicted", () => {
  assert.deepEqual(M.predictionsFor({ ar: "c" }).map((p) => p.value), ["ok", "ioerr", "unsupp", "reset"]);
  for (const ar of ["w", "p"]) {
    const values = M.predictionsFor({ ar }).map((p) => p.value);
    for (const sector of [1n << 55n, M.U64_MAX / 512n, 3n, 64n]) {
      assert.ok(values.includes(M.outcomeKey(run(req(REQ.IN, sector, 512, { ar })))), `${ar} ${sector}`);
    }
  }
  for (const p of M.PRESETS) assert.ok(M.predictionsFor(p.state).some((c) => c.value === M.outcomeKey(run(p.state))), p.id);
});

test("every hostile test that names a case is ported or noted", () => {
  const names = [...HOSTILE_RS.matchAll(/#\[test\]\nfn (\w+)\(/g)].map((m) => m[1]);
  // Cases about the worker, the batch budget, the memory log or the real backend are outside a
  // one-request model; listed here so a new test is a conscious choice.
  const outside = new Set([
    "header_is_read_exactly_once", "reset_returns_to_write_through_until_features_are_acked_again",
    "a_batch_ends_after_one_sync", "a_batch_ends_after_blk_batch_bytes", "no_walkable_chain_reaches_the_walk_cap",
    "hostile_chains_are_needs_reset_and_the_vmm_keeps_running", "indirect_requests_work_when_negotiated",
    "capacity_rounds_down_to_whole_sectors", "random_requests_match_the_model",
    "flush_calls_sync_once_and_reports_its_failure", "write_back_when_flush_is_negotiated_leaves_durability_to_flush",
    "write_through_when_flush_is_not_negotiated", "features_and_config_space", "only_one_status_byte_is_written",
    "a_descriptor_larger_than_one_bounce_buffer_is_chunked",
  ]);
  const ported = new Set([
    "read_returns_the_disk_bytes_and_exact_len", "write_reaches_the_disk", "sector_past_the_end_is_ioerr_and_never_reaches_the_disk",
    "sector_times_512_overflow_is_ioerr_not_a_wrap", "length_not_a_multiple_of_512_is_ioerr", "missing_status_descriptor_is_needs_reset",
    "read_only_status_descriptor_is_refused", "zero_length_status_is_refused", "header_shorter_than_16_bytes_is_ioerr",
    "writable_header_is_ioerr", "split_header_and_merged_status_follow_any_layout", "wrong_data_direction_is_ioerr",
    "out_on_a_read_only_disk_is_ioerr", "unknown_type_is_unsupp", "get_id_writes_20_bytes_macvmm_disk0",
    "data_longer_than_126_times_64k_is_ioerr", "more_than_seg_max_segments_is_ioerr",
  ]);
  for (const n of names) assert.ok(ported.has(n) || outside.has(n), `new hostile test ${n}: port it or list it as outside the model`);
});

// ---- model properties, share strings, presets ------------------------------------------------

test("header bytes round-trip and are little-endian", () => {
  const s = { ...defaultState(), type: 0x01020304, reserved: 0xa0b0c0d0, sector: 0x1122334455667788n };
  const b = M.headerBytes(s);
  assert.deepEqual(b, [4, 3, 2, 1, 0xd0, 0xc0, 0xb0, 0xa0, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]);
  assert.deepEqual(M.decodeHeader(b), { type: 0x01020304, reserved: 0xa0b0c0d0, sector: 0x1122334455667788n });
  assert.throws(() => M.decodeHeader([1, 2, 3]));
});

test("capacity clamps like Blk::new", () => {
  assert.equal(M.capacityBytes(64n), 32768n);
  assert.equal(M.capacityBytes(M.U64_MAX), (M.U64_MAX / 512n) * 512n);
});

test("parsers refuse junk", () => {
  assert.equal(M.parseU64("2^55"), 1n << 55n);
  assert.equal(M.parseU64("0x0080_0000_0000_0000"), 1n << 55n);
  assert.equal(M.parseU64("18446744073709551615"), M.U64_MAX);
  for (const bad of ["", "18446744073709551616", "2^64", "0x1_0000_0000_0000_0000", "-1", "1e3", "abc", " 0x ", "9".repeat(41)]) {
    assert.equal(M.parseU64(bad), null, bad);
  }
  assert.equal(M.parseU32("4294967295"), M.U32_MAX);
  assert.equal(M.parseU32("4294967296"), null);
});

test("share strings: default, reference, round trips, hostile input", () => {
  assert.equal(M.encodeShare(defaultState()), "");
  const ref = M.decodeShare(M.REFERENCE);
  assert.ok(ref);
  assert.equal(M.encodeShare(ref), M.REFERENCE);
  assert.equal(ref.sector, 1n << 55n);
  assert.equal(ref.ar, "w");
  const lab = JSON.parse(readFileSync(here("./lab.json"), "utf8"));
  assert.equal(lab.reference, M.REFERENCE);
  for (const p of M.PRESETS) {
    const enc = M.encodeShare(p.state);
    if (enc === "") { assert.ok(M.sameState(p.state, defaultState())); continue; }
    const back = M.decodeShare(enc);
    assert.ok(back, `${p.id}: ${enc}`);
    assert.ok(M.sameState(back, p.state), p.id);
  }
  const bad = [
    null, "", "x", "cap=64", "cap=0;ro=0;wb=1;ar=c;t=0;s=40;c=r16,w512,w1", "cap=64;ro=2;wb=1;ar=c;t=0;s=40;c=r16",
    "cap=64;ro=0;wb=1;ar=q;t=0;s=40;c=r16", "cap=64;ro=0;wb=1;ar=c;t=100000000;s=40;c=r16",
    "cap=64;ro=0;wb=1;ar=c;t=0;s=10000000000000000;c=r16", "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=",
    "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r4294967296", "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16x0",
    "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16x301", "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r1x200,w1x200",
    "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16;cap=1", "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16;zz=1",
    `cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=${Array(17).fill("r1").join(",")}`, "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16;n=100",
    "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16;f=100", "a".repeat(601), "cap=64;ro=0;wb=1;ar=c;t=0;s=40;c=r16;<b>=1",
  ];
  for (const b of bad) assert.equal(M.decodeShare(b), null, String(b));
});

test("presets are valid, distinct, and every outcome kind is covered", () => {
  const ids = new Set();
  const kinds = new Set();
  for (const p of M.PRESETS) {
    assert.equal(M.validateState(p.state), null, p.id);
    assert.ok(!ids.has(p.id), p.id);
    ids.add(p.id);
    const r = run(p.state);
    kinds.add(M.outcomeKey(r));
    assert.ok(r.summary.length > 0);
    assert.doesNotMatch(r.summary + p.label, /\b(?:M\d{1,2}|PLAN|BLK-\d|VQ-\d|MEM-\d)\b/, "no internal labels in learner text");
  }
  for (const k of ["ok", "ioerr", "unsupp", "reset"]) assert.ok(kinds.has(k), k);
  assert.equal(M.PRESETS[0].id, "past-end");
  assert.ok(M.sameState(M.PRESETS[0].state, defaultState()), "the first preset is the default");
});

test("random requests never throw and keep the used-length rule", () => {
  let seed = 0x5eed;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const lens = [0, 1, 8, 15, 16, 20, 512, 513, 528, 1024, 65536, M.U32_MAX];
  for (let i = 0; i < 3000; i++) {
    const s = defaultState();
    s.cap = BigInt(1 + rnd(200));
    s.ro = rnd(2) === 1;
    s.wb = rnd(2) === 1;
    s.ar = ["c", "w", "p"][rnd(3)];
    s.type = [0, 1, 4, 8, 2, M.U32_MAX][rnd(6)];
    s.sector = [0n, 3n, 63n, 64n, 1n << 55n, M.U64_MAX / 512n, M.U64_MAX, BigInt(rnd(300))][rnd(8)];
    s.descs = Array.from({ length: 1 + rnd(5) }, () => ({ w: rnd(2) === 1, len: lens[rnd(lens.length)], n: 1 + (rnd(10) === 0 ? rnd(140) : 0) }));
    if (M.validateState(s)) continue;
    const r = run(s);
    const o = r.outcome;
    assert.ok(["status", "reset", "panic", "backend"].includes(o.kind));
    if (o.kind === "status") {
      assert.ok(o.used >= 1 && o.used <= r.writableLen, `${o.used} <= ${r.writableLen}`);
      if (o.status !== STATUS.OK) { assert.equal(o.used, 1); untouched(r); }
      if (s.ar === "c") {
        for (const a of [...r.disk.reads, ...r.disk.writes]) assert.ok(a.offset + BigInt(a.len) <= r.capBytes, "checked arithmetic never leaves the disk");
      }
    }
    if (s.ar === "c") assert.ok(o.kind === "status" || o.kind === "reset");
    assert.equal(M.decodeShare(M.encodeShare(s) || "x") === null ? M.sameState(s, defaultState()) : true, true);
    const back = M.encodeShare(s) ? M.decodeShare(M.encodeShare(s)) : defaultState();
    assert.ok(M.sameState(back, s));
  }
});
