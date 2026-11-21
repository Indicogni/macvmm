// Tests for the gpa-translator model. Run: node --test course/site/src/labs/gpa-translator/
//
// The cases mirror the reference's unit tests in crates/vmm/src/memory/region.rs and address.rs
// (no exported vector file exists for guest memory; vectors cover ESR, FDT and virtqueue), the
// rows of chapter 04's lab fallback table, and the numbers chapter 04 quotes from the captures
// 04-raw-wrap.txt and 04-raw-edge.txt.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  U64_MAX,
  REGION_ALIGN,
  MAX_REGIONS,
  parseU64,
  hex,
  buildTable,
  locate,
  wrappingCheck,
  panickingCheck,
  spanCheck,
  rows,
  summary,
  segments,
  place,
  initialState,
  step,
  evaluate,
  encodeHash,
  decodeHash,
  ACCESS_PRESETS,
  TABLE_PRESETS,
  regionErrorText,
} from "./model.mjs";

const K16 = REGION_ALIGN;
const ram = () => buildTable([{ base: 0x4000_0000n, size: 0x400_0000n }], 36).spans;

test("parseU64 accepts the course's notations and refuses the rest", () => {
  assert.deepEqual(parseU64("0x4000_0000"), { ok: true, value: 0x4000_0000n });
  assert.deepEqual(parseU64("0xFFFF_FFFF_FFFF_FFFC"), { ok: true, value: U64_MAX - 3n });
  assert.deepEqual(parseU64(" 8 "), { ok: true, value: 8n });
  assert.deepEqual(parseU64("64M"), { ok: true, value: 64n << 20n });
  assert.deepEqual(parseU64("16KiB"), { ok: true, value: 16384n });
  assert.deepEqual(parseU64("0b101"), { ok: true, value: 5n });
  assert.equal(parseU64("0x1_0000_0000_0000_0000").ok, false); // 65 bits
  assert.equal(parseU64("").ok, false);
  assert.equal(parseU64("-1").ok, false);
  assert.equal(parseU64("1e3").ok, false);
  assert.equal(parseU64("0x").ok, false);
  assert.equal(parseU64("16777216T").ok, false); // 2^24 << 40 = 2^64
  assert.equal(parseU64("1".repeat(200)).ok, false);
  assert.equal(parseU64(null).ok, false);
});

test("hex formats like the lesson", () => {
  assert.equal(hex(4n), "0x4");
  assert.equal(hex(0x1000n), "0x1000");
  assert.equal(hex(0x4000_1008n), "0x4000_1008");
  assert.equal(hex(U64_MAX - 3n), "0xFFFF_FFFF_FFFF_FFFC");
  assert.equal(hex(0x10_0000_0000n), "0x10_0000_0000");
});

test("construction rules, as region.rs construction_rules", () => {
  const t = buildTable([{ base: 4n * K16, size: K16 }, { base: 0n, size: K16 }], 36);
  assert.ok(t.ok);
  assert.equal(t.spans[0].base, 0n);
  assert.equal(t.spans[1].end, 5n * K16);
  assert.equal(buildTable([], 36).error.kind, "Empty");
  assert.deepEqual(buildTable([{ base: 0n, size: K16 }], 31).error, { kind: "BadIpaBits", bits: 31 });
  assert.deepEqual(buildTable([{ base: 0n, size: K16 }], 53).error, { kind: "BadIpaBits", bits: 53 });
  const many = Array.from({ length: MAX_REGIONS + 1 }, (_, i) => ({ base: BigInt(i) * K16, size: K16 }));
  assert.deepEqual(buildTable(many, 36).error, { kind: "TooMany", count: MAX_REGIONS + 1 });
  assert.ok(buildTable(many.slice(0, MAX_REGIONS), 36).ok);
});

test("per-region rules and overlap, in the reference's order", () => {
  assert.deepEqual(buildTable([{ base: 0x4000_0000n, size: 0n }], 36).error, { kind: "ZeroSize", base: 0x4000_0000n });
  assert.equal(buildTable([{ base: 0x4000_1000n, size: K16 }], 36).error.kind, "Unaligned");
  assert.equal(buildTable([{ base: 0x4000_0000n, size: 0x1000n }], 36).error.kind, "Unaligned");
  assert.equal(buildTable([{ base: U64_MAX + 1n - K16, size: 2n * K16 }], 52).error.kind, "Overflow");
  assert.equal(buildTable([{ base: 1n << 36n, size: K16 }], 36).error.kind, "AboveIpaLimit");
  // Ending exactly at the limit is fine.
  assert.ok(buildTable([{ base: (1n << 36n) - K16, size: K16 }], 36).ok);
  const ov = buildTable([{ base: 0x4200_0000n, size: 0x400_0000n }, { base: 0x4000_0000n, size: 0x400_0000n }], 36);
  assert.deepEqual(ov.error, { kind: "Overlap", first: 0x4000_0000n, second: 0x4200_0000n });
  assert.equal(regionErrorText(ov.error), "regions at 0x4000_0000 and 0x4200_0000 overlap");
  // Adjacent is not overlapping.
  assert.ok(buildTable([{ base: 0n, size: K16 }, { base: K16, size: K16 }], 36).ok);
  // Every broken table preset is refused with the rule its label names.
  const want = { "bad-align": "Unaligned", "bad-zero": "ZeroSize", "bad-overlap": "Overlap", "bad-wrap": "Overflow", "bad-ipa": "AboveIpaLimit" };
  for (const p of TABLE_PRESETS) {
    const regions = p.regions.map(([b, s]) => ({ base: parseU64(b).value, size: parseU64(s).value }));
    const t = buildTable(regions, 36);
    if (want[p.id]) assert.equal(t.error.kind, want[p.id], p.id);
    else assert.ok(t.ok, p.id);
  }
});

test("locate edges, as region.rs locate_edges", () => {
  const spans = buildTable([{ base: K16, size: K16 }], 36).spans;
  assert.deepEqual([locate(spans, K16, K16).ok, locate(spans, K16, K16).offset], [true, 0n]);
  assert.equal(locate(spans, 2n * K16 - 1n, 1n).offset, K16 - 1n);
  assert.equal(locate(spans, 2n * K16 - 1n, 2n).ok, false);
  assert.equal(locate(spans, K16 - 1n, 1n).ok, false);
  assert.equal(locate(spans, 0n, 1n).ok, false);
  assert.equal(locate(spans, K16, 0n).ok, false);
  assert.deepEqual(locate(spans, U64_MAX, 1n).error, { kind: "Overflow", addr: U64_MAX, len: 1n });
  // checked_arithmetic: u64::MAX - 3 + 3 is fine (then out of bounds), + 8 overflows.
  assert.equal(locate(spans, U64_MAX - 3n, 3n).error.kind, "OutOfBounds");
  assert.equal(locate(spans, U64_MAX - 3n, 8n).error.kind, "Overflow");
});

test("one access, one region: adjacent regions are still two", () => {
  const spans = buildTable([{ base: 0x4000_0000n, size: K16 }, { base: 0x4000_4000n, size: K16 }], 36).spans;
  const r = locate(spans, 0x4000_3FFCn, 8n);
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, "OutOfBounds");
  assert.deepEqual([locate(spans, 0x4000_4000n, 8n).index, locate(spans, 0x4000_4000n, 8n).offset], [1, 0n]);
  // A hole between regions.
  const g = buildTable([{ base: 0x4000_0000n, size: 0x400_0000n }, { base: 0x8000_0000n, size: 0x400_0000n }], 36).spans;
  assert.equal(locate(g, 0x5000_0000n, 4n).ok, false);
  assert.equal(locate(g, 0x8000_0010n, 4n).index, 1);
});

test("the lesson's fallback table, row for row", () => {
  const spans = ram();
  const inside = rows(spans, 0x4000_1000n, 8n)[0];
  assert.deepEqual(
    [inside.mode, inside.addr, inside.len, inside.sum, inside.verdict, inside.host],
    ["checked", "0x4000_1000", "8", "0x4000_1008", "ok", "H + 0x1000"],
  );
  const [checked, wrapping, panicking] = rows(spans, U64_MAX - 3n, 8n);
  assert.deepEqual(
    [checked.mode, checked.addr, checked.len, checked.sum, checked.verdict, checked.host],
    ["checked", "0xFFFF_FFFF_FFFF_FFFC", "8", "overflow (None)", "fault", "none"],
  );
  assert.deepEqual(
    [wrapping.mode, wrapping.addr, wrapping.len, wrapping.sum, wrapping.verdict, wrapping.host],
    ["wrapping", "0xFFFF_FFFF_FFFF_FFFC", "8", "0x4 (wrapped)", '"ok"', "H - 0x4000_0004"],
  );
  assert.equal(wrapping.harmful, true);
  assert.equal(panicking.verdict, "VMM crashes");
});

test("the lesson's arithmetic for the opening puzzle", () => {
  const w = wrappingCheck(ram(), U64_MAX - 3n, 8n);
  assert.equal(w.sum, 4n);
  assert.equal(w.wrapped, true);
  assert.equal(w.pass, true);
  assert.equal(w.offset, 0xFFFF_FFFF_BFFF_FFFCn);
  assert.equal(w.delta, -0x4000_0004n);
  assert.equal(w.outside, true);
  assert.match(summary(ram(), U64_MAX - 3n, 8n, "wrapping"), /H - 0x4000_0004, 0x4000_0004 bytes below/);
});

test("chapter 04's raw-loader captures: wrap and edge", () => {
  // 04-raw-wrap.txt: 0x2d9a bytes at 0xfffffffffffffff0. The lesson: the sum wraps to 0x2d8a and
  // a wrapping check would copy to host_base - 0x4000_0010. The checked loader refuses it.
  const wrap = rows(ram(), 0xFFFF_FFFF_FFFF_FFF0n, 0x2D9An);
  assert.equal(wrap[0].verdict, "fault");
  assert.equal(wrap[1].sum, "0x2D8A (wrapped)");
  assert.equal(wrap[1].host, "H - 0x4000_0010");
  // 04-raw-edge.txt: 0x2d9a bytes at 0x43fffff0, which starts inside RAM and ends past it. Both
  // the checked and the wrapping comparison refuse it (no overflow is involved).
  const edge = rows(ram(), 0x43FF_FFF0n, 0x2D9An);
  assert.equal(edge[0].verdict, "fault");
  assert.equal(edge[1].verdict, "fault");
});

const CAP_DIR = fileURLToPath(new URL("../../../../captures/", import.meta.url));
const haveCaps = existsSync(CAP_DIR + "04-raw-wrap.txt") && existsSync(CAP_DIR + "04-raw-edge.txt");
test("the raw-loader captures say what the lab models", { skip: !haveCaps && "course/captures/04-raw-*.txt not found" }, () => {
  for (const [file, at] of [["04-raw-wrap.txt", "0xfffffffffffffff0"], ["04-raw-edge.txt", "0x43fffff0"]]) {
    const text = readFileSync(CAP_DIR + file, "utf8");
    assert.match(text, new RegExp(`0x2d9a bytes at ${at}\\) does not fit inside guest RAM`));
    assert.match(text, /--mem 64M/);
  }
});

test("zero length and the wrong fixes", () => {
  const spans = ram();
  const z = rows(spans, 0x4000_0000n, 0n);
  assert.equal(z[0].verdict, "fault");
  // The C check accepts an empty access: a broken contract, not a leak.
  assert.equal(z[1].verdict, "accepted (contract broken)");
  assert.equal(z[1].harm, "contract");
  assert.equal(z[1].harmful, false);
  assert.equal(z[3].verdict, "fault");
  const ze = rows(spans, 0x4400_0000n, 0n);
  assert.equal(ze[1].harm, "contract");
  assert.match(summary(spans, 0x4400_0000n, 0n, "wrapping"), /No bytes are touched.*0x4400_0000 is not in RAM/);
  const p = panickingCheck(spans, U64_MAX - 3n, 8n);
  assert.equal(p.panic, true);
  const ok = panickingCheck(spans, 0x4000_1000n, 8n);
  assert.equal(ok.panic, false);
  assert.equal(ok.delta, 0x1000n);
  assert.match(summary(spans, U64_MAX - 3n, 8n, "panicking"), /panics/);
  assert.match(summary(spans, U64_MAX - 3n, 8n, "checked"), /fault \(Overflow\)/);
  assert.match(summary(spans, 0x4000_1000n, 8n, "checked"), /host address H \+ 0x1000/);
});

test("why checked_add alone is not enough: the whole-RAM check lets a range cross regions", () => {
  const two = buildTable([{ base: 0x4000_0000n, size: K16 }, { base: 0x4000_4000n, size: K16 }], 36).spans;
  const [c, w, p, s] = rows(two, 0x4000_3FFCn, 8n);
  assert.deepEqual([c.verdict, w.verdict, p.verdict], ["fault", "fault", "fault"]); // per-region checks refuse it
  assert.equal(s.mode, "span");
  assert.equal(s.verdict, '"ok"');
  assert.equal(s.harm, "leak");
  assert.equal(s.host, "H0 + 0x3FFC");
  assert.match(summary(two, 0x4000_3FFCn, 8n, "span"), /from H0 \+ 0x3FFC up to H0 \+ 0x4004, which runs past the end of region 0/);
  // A hole between regions gets through too.
  const gap = buildTable([{ base: 0x4000_0000n, size: 0x400_0000n }, { base: 0x8000_0000n, size: 0x400_0000n }], 36).spans;
  assert.equal(spanCheck(gap, 0x6000_0000n, 8n).outside, true);
  // But it still refuses overflow and len 0.
  assert.equal(spanCheck(two, U64_MAX - 3n, 8n).pass, false);
  assert.equal(spanCheck(two, 0x4000_0000n, 0n).pass, false);
});

test("learner text names regions by the reader's row, and counts bytes in the singular for 1", () => {
  const t = buildTable([{ base: 0x8000_0000n, size: K16 }, { base: 0x4000_0000n, size: K16 }], 36).spans;
  assert.match(summary(t, 0x8000_0000n, 8n, "checked"), /region 0 at offset 0x0, host address H0\./);
  assert.match(summary(t, 0x4000_0000n, 1n, "checked"), /^Checked: 1 byte at .*region 1 .*H1\./);
  assert.match(summary(ram(), 0x4000_0000n, U64_MAX, "wrapping"), /from H up to H \+ 0xFFFF_FFFF_FFFF_FFFF, which runs past the end/);
  const w = wrappingCheck(ram(), U64_MAX - 3n, 8n);
  assert.equal(w.steps[0].warn, true);
});

test("checked never accepts what lies outside a region (exhaustive near the edges)", () => {
  const spans = buildTable([{ base: K16, size: K16 }, { base: 2n * K16, size: K16 }, { base: 5n * K16, size: K16 }], 36).spans;
  const inOne = (a, l) => l > 0n && spans.some((s) => a >= s.base && a + l <= s.end);
  const pts = [0n, 1n, K16 - 1n, K16, K16 + 1n, 2n * K16 - 1n, 2n * K16, 3n * K16 - 1n, 3n * K16, 5n * K16, 6n * K16 - 1n, U64_MAX - 8n, U64_MAX];
  const lens = [0n, 1n, 2n, 8n, K16 - 1n, K16, K16 + 1n, U64_MAX];
  for (const a of pts) {
    for (const l of lens) {
      const r = locate(spans, a, l);
      assert.equal(r.ok, a + l <= U64_MAX && inOne(a, l), `${hex(a)} ${hex(l)}`);
    }
  }
});

test("segments and place cover the whole address space", () => {
  const segs = segments(ram());
  assert.deepEqual(segs.map((s) => s.kind), ["gap", "region", "gap"]);
  assert.equal(segs[2].to, 1n << 64n);
  assert.deepEqual(place(segs, 0x4000_0000n), { seg: 1, frac: 0 });
  assert.equal(place(segs, 0x4200_0000n).frac, 0.5);
  assert.equal(place(segs, U64_MAX).seg, 2);
  const top = segments(buildTable([{ base: 0n, size: K16 }], 52).spans);
  assert.equal(top[0].kind, "region");
});

test("reducer: presets, regions, bounds", () => {
  let s = initialState();
  assert.equal(s.mode, "wrapping");
  s = step(s, { type: "setMode", mode: "bogus" });
  assert.equal(s.mode, "wrapping");
  s = step(s, { type: "accessPreset", id: "cross" });
  assert.equal(s.regions.length, 2);
  assert.equal(evaluate(s).result.checked.ok, false);
  s = step(s, { type: "addRegion" });
  assert.equal(s.regions.length, 3);
  assert.equal(s.regions[2].base, "0x4000_8000");
  assert.ok(evaluate(s).table.ok);
  s = step(s, { type: "removeRegion", index: 0 });
  assert.equal(s.regions.length, 2);
  for (let i = 0; i < 40; i++) s = step(s, { type: "addRegion" });
  assert.equal(s.regions.length, MAX_REGIONS);
  s = step(s, { type: "tablePreset", id: "ram64" });
  for (let i = 0; i < 3; i++) s = step(s, { type: "removeRegion", index: 0 });
  assert.equal(s.regions.length, 1);
  s = step(s, { type: "setRegion", index: 9, field: "base", value: "0" });
  assert.equal(s.regions.length, 1);
  s = step(s, { type: "setRegion", index: 0, field: "__proto__", value: "0" });
  assert.equal(s.regions[0].base, "0x4000_0000");
  const before = s;
  step(s, { type: "setAddr", value: "1" });
  assert.equal(before.addr, s.addr); // no mutation
  assert.equal(step(s, { type: "nope" }), s);
  const e = evaluate(step(s, { type: "setAddr", value: "zz" }));
  assert.ok(e.fieldErrors.addr);
  assert.equal(e.result, null);
  for (const p of ACCESS_PRESETS) {
    const r = evaluate(step(initialState(), { type: "accessPreset", id: p.id }));
    assert.ok(r.result, p.id);
  }
  assert.deepEqual(step(s, { type: "reset" }), initialState());
});

test("share state round-trips and rejects junk", () => {
  const s0 = step(step(initialState(), { type: "accessPreset", id: "cross" }), { type: "setMode", mode: "checked" });
  const h = encodeHash(s0);
  assert.equal(h, "c.40000000:4000,40004000:4000.40003ffc.8.36");
  const s1 = decodeHash(h);
  assert.equal(s1.mode, "checked");
  assert.deepEqual(evaluate(s1).result.rows, evaluate(s0).result.rows);
  assert.equal(encodeHash(initialState()), "w.40000000:4000000.fffffffffffffffc.8.36");
  const sp = step(step(initialState(), { type: "accessPreset", id: "cross" }), { type: "setMode", mode: "span" });
  assert.equal(encodeHash(sp), "s.40000000:4000,40004000:4000.40003ffc.8.36");
  assert.equal(decodeHash(encodeHash(sp)).mode, "span");
  for (const bad of [
    "",
    null,
    "x.1:1.1.1.36",
    "c.1:1.1.1",
    "c.1:1.<b>.1.36",
    "c..1.1.36",
    "c.1:1.11111111111111111.1.36",
    "c." + Array.from({ length: 17 }, () => "0:4000").join(",") + ".1.1.36",
    "c.1:1.1.1.36" + "0".repeat(2000),
    "c.1:1:1.1.1.36",
  ]) {
    assert.equal(decodeHash(bad), null, String(bad).slice(0, 40));
  }
  assert.equal(encodeHash(step(initialState(), { type: "setLen", value: "?" })), null);
});

test("shipped files obey the lab contract's banned strings", () => {
  const dir = new URL("./", import.meta.url);
  for (const f of ["model.mjs", "view.mjs"]) {
    const src = readFileSync(new URL(f, dir), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "setAttribute(\"style\"", "on" + "click="]) {
      assert.equal(src.includes(bad), false, `${f} contains ${bad}`);
    }
  }
  const view = readFileSync(new URL("view.mjs", dir), "utf8");
  assert.match(view, /export function mount/);
  const css = readFileSync(new URL("style.css", dir), "utf8");
  for (const line of css.split("\n")) {
    if (line.includes("{") && !line.trim().startsWith("@") && !line.trim().startsWith("/*")) {
      assert.match(line, /^\s*\.lab\[data-lab="gpa-translator"\]/, `unscoped: ${line}`);
    }
  }
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b|rgb\(|hsl\(/, "hard-coded color");
});
