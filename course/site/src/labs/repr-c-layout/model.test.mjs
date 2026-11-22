// Tests for the repr-c-layout model. Run: node --test 'course/site/**/*.test.mjs'
//
// The expected numbers below were checked on aarch64-apple-darwin with rustc 1.99
// (size_of / align_of / offset_of!) and Apple clang 21 (sizeof / _Alignof / offsetof on the real
// <Hypervisor/Hypervisor.h>), so the lab and the compilers agree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  analyze,
  tokenize,
  parseRust,
  headerLayout,
  leaves,
  byteMap,
  renderC,
  PRESETS,
  HEADER_TEXT,
  LIMITS,
  initialState,
  step,
  encodeShare,
  decodeShare,
  summarize,
} from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..", "..");

const offs = (a) => a.layout.fields.map((f) => [f.name, f.offset]);
const ok = (src, opts) => {
  const a = analyze(src, opts);
  assert.equal(a.ok, true, a.ok ? "" : `${a.error.message} (line ${a.error.line})`);
  return a;
};

test("the header's hv_vcpu_exit_t: 32 bytes, offsets 0, 8, 16, 24 (clang agrees)", () => {
  const h = headerLayout();
  assert.equal(h.size, 32);
  assert.equal(h.align, 8);
  assert.deepEqual(
    leaves(h).map((l) => [l.path, l.offset, l.size]),
    [
      ["reason", 0, 4],
      ["exception.syndrome", 8, 8],
      ["exception.virtual_address", 16, 8],
      ["exception.physical_address", 24, 8],
    ],
  );
  assert.equal(h.fields[1].padBefore, 4);
});

test("the header excerpt is verbatim from the SDK, when the SDK is present", (t) => {
  let sdk;
  try {
    // Recorded path of the macOS SDK on the course machine; skip anywhere else.
    sdk = readFileSync(
      "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/System/Library/Frameworks/Hypervisor.framework/Headers/hv_vcpu_types.h",
      "utf8",
    );
  } catch {
    t.skip("macOS SDK not found; the excerpt cannot be re-checked here");
    return;
  }
  assert.ok(sdk.includes(HEADER_TEXT), "HEADER_TEXT must be a verbatim slice of hv_vcpu_types.h");
});

test("the reference crate's own declaration parses and matches the header", (t) => {
  let src;
  try {
    src = readFileSync(join(repo, "crates", "hvf", "src", "ffi.rs"), "utf8");
  } catch {
    t.skip("crates/hvf/src/ffi.rs not found");
    return;
  }
  const m = src.match(/\/\/ ANCHOR: ffi_vcpu_exit_t\n([\s\S]*?)\/\/ ANCHOR_END: ffi_vcpu_exit_t/);
  assert.ok(m, "anchor ffi_vcpu_exit_t exists");
  // The aliases live in another anchor; the lab knows the hv_* names as built-ins.
  const a = ok(m[1], { compare: "exit" });
  assert.equal(a.root, "hv_vcpu_exit_t");
  assert.equal(a.layout.size, 32);
  assert.equal(a.compare.match, true);
});

test("every preset parses; the numbers match rustc", () => {
  const want = {
    exit: { size: 32, match: true },
    flat: { size: 32, match: true },
    "no-repr": { size: 32, match: false },
    "wide-reason": { size: 32, match: false },
    reordered: { size: 32, match: false },
    packed: { size: 28, match: false },
    order: { size: 16, match: null },
  };
  for (const p of PRESETS) {
    const a = ok(p.source, { compare: p.compare });
    assert.equal(a.layout.size, want[p.id].size, p.id);
    assert.equal(a.compare ? a.compare.match : null, want[p.id].match, p.id);
  }
});

test("flattened exit: same leaves as the header, names aside", () => {
  const a = ok(PRESETS.find((p) => p.id === "flat").source, { compare: "exit" });
  assert.deepEqual(offs(a), [
    ["reason", 0],
    ["syndrome", 8],
    ["virtual_address", 16],
    ["physical_address", 24],
  ]);
  assert.match(a.summary, /Matches the header's hv_vcpu_exit_t field by field: offsets 0, 8, 16, 24\./);
});

test("wide reason: offsets agree but the size check catches it", () => {
  const a = ok(PRESETS.find((p) => p.id === "wide-reason").source, { compare: "exit" });
  const bad = a.compare.rows.filter((r) => !r.ok);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].why, "size 8; the header has 4");
});

test("packed exit: 28 bytes, align 1, offsets 0, 4, 12, 20 (rustc agrees)", () => {
  const a = ok(PRESETS.find((p) => p.id === "packed").source);
  assert.equal(a.layout.align, 1);
  assert.deepEqual(a.layout.fields.map((f) => f.offset), [0, 4, 12, 20]);
  assert.equal(a.layout.padding, 0);
});

test("reordered exit: reason at 24, 4 bytes of tail padding; fields pair by name, none matches", () => {
  const a = ok(PRESETS.find((p) => p.id === "reordered").source, { compare: "exit" });
  assert.equal(a.layout.fields[3].offset, 24);
  assert.equal(a.layout.tailPad, 4);
  // No row may look like a plain match: offset and size agreeing is not enough.
  assert.ok(a.compare.rows.every((r) => r.status === "bad" && r.byName), JSON.stringify(a.compare.rows.map((r) => r.status)));
  const syn = a.compare.rows.find((r) => r.header.path === "exception.syndrome");
  assert.equal(syn.yours.path, "syndrome");
  assert.equal(syn.why, "syndrome is at offset 0; the header has it at 8 (reason is at 0)");
  assert.match(syn.effect, /bytes the framework wrote for reason and padding/);
});

test("no repr(C): shows an allowed order, warns, never matches", () => {
  const a = ok(PRESETS.find((p) => p.id === "no-repr").source, { compare: "exit" });
  assert.equal(a.layout.repr.kind, "Rust");
  assert.equal(a.layout.reordered, true);
  assert.deepEqual(offs(a), [
    ["exception", 0],
    ["reason", 24],
  ]);
  assert.equal(a.compare.match, false);
  assert.match(a.summary, /Rust promises no order/);
  assert.match(renderC({ layouts: a.layouts }, a.root), /No C equivalent/);
});

test("order costs bytes: u8,u64,u8 is 24; u64,u8,u8 is 16 (rustc agrees)", () => {
  const src = PRESETS.find((p) => p.id === "order").source;
  const w = ok(src, { view: "Wasteful" });
  assert.equal(w.layout.size, 24);
  assert.equal(w.layout.padding, 14);
  assert.equal(w.layout.bestSize, 16);
  const t = ok(src, { view: "Tidy" });
  assert.equal(t.layout.size, 16);
  assert.equal(t.layout.padding, 6);
  // Default view: the last struct nobody contains.
  assert.equal(ok(src).root, "Tidy");
});

test("more layouts checked against rustc", () => {
  const cases = [
    ["#[repr(C, align(16))] struct A { a: u8 }", 16, 16, [0]],
    ["#[repr(C, packed(2))] struct P2 { a: u8, b: u32, c: u8 }", 8, 2, [0, 2, 6]],
    ["#[repr(C)] struct Arr { a: u8, b: [u16; 3], c: u32 }", 12, 4, [0, 2, 8]],
    ["#[repr(C)] struct Big { a: u8, b: u128 }", 32, 16, [0, 16]],
    ["#[repr(C)] struct E {}", 0, 1, []],
    [
      "use core::ffi::*;\n#[repr(C)] struct Ptrs { a: u8, p: *const u8, f: Option<extern \"C\" fn()>, c: c_char, l: c_long, b: bool }",
      48,
      8,
      [0, 8, 16, 24, 32, 40],
    ],
    ["#[repr(C, packed(2))] struct P2 { a: u8, b: u32, c: u8 }\n#[repr(C)] struct InP { a: u8, p: P2 }", 10, 2, [0, 2]],
  ];
  for (const [src, size, align, o] of cases) {
    const a = ok(src);
    assert.equal(a.layout.size, size, src);
    assert.equal(a.layout.align, align, src);
    assert.deepEqual(a.layout.fields.map((f) => f.offset), o, src);
  }
});

test("C rendering", () => {
  const a = ok(PRESETS[0].source);
  assert.equal(
    a.c,
    [
      "typedef struct {",
      "    hv_exception_syndrome_t syndrome;",
      "    hv_exception_address_t virtual_address;",
      "    hv_ipa_t physical_address;",
      "} hv_vcpu_exit_exception_t;",
      "",
      "typedef struct {",
      "    hv_exit_reason_t reason;",
      "    hv_vcpu_exit_exception_t exception;",
      "} hv_vcpu_exit_t;",
    ].join("\n"),
  );
  const p = ok("#[repr(C, packed(2))] struct P { a: u8, b: *mut c_void, c: [u32; 4] }");
  assert.equal(p.c, ["#pragma pack(push, 2)", "typedef struct {", "    uint8_t a;", "    void *b;", "    uint32_t c[4];", "} P;", "#pragma pack(pop)"].join("\n"));
});

test("byte map: fields and padding cover the struct exactly", () => {
  const a = ok(PRESETS[0].source);
  assert.deepEqual(
    a.bytes.segments.map((s) => [s.kind, s.offset, s.size]),
    [
      ["field", 0, 4],
      ["pad", 4, 4],
      ["field", 8, 8],
      ["field", 16, 8],
      ["field", 24, 8],
    ],
  );
  const big = byteMap(ok("#[repr(C)] struct B { a: [u8; 1000], b: u16 }").layout);
  assert.equal(big.truncated, true);
  assert.equal(big.segments.reduce((s, x) => s + x.size, 0), LIMITS.byteMapBytes);
});

test("comments, doc comments, attributes, visibility and paths are understood", () => {
  const a = ok(`//! crate doc
/// doc
#[derive(Clone, Copy, Debug)]
#[repr(C)]
pub(crate) struct S {
    /* block /* nested */ comment */
    #[doc = "x"] pub a: core::ffi::c_int,
    pub(super) b: std::os::raw::c_ulong,
    r#type: u8,
}
impl S { fn f(&self) -> u8 { 0 } }
const K: u32 = 3;`);
  assert.deepEqual(offs(a), [
    ["a", 0],
    ["b", 8],
    ["type", 16],
  ]);
  assert.equal(a.layout.size, 24);
  assert.ok(a.warnings.some((w) => /impl/.test(w.message)));
});

test("errors are values with a line number", () => {
  const cases = [
    ["struct A { a: Foo }", /unknown type `Foo`/],
    ["#[repr(C)] struct A { b: B }\n#[repr(C)] struct B { a: A }", /contains itself by value/],
    ["struct A { a: c_void }", /behind a pointer/],
    ["struct A { a: uint32_t }", /in Rust write `u32`/],
    ["#[repr(C, packed, align(8))] struct A { a: u8 }", /both packed and align/],
    ["#[repr(u8)] struct A { a: u8 }", /for enums/],
    ["#[repr(align(3))] struct A { a: u8 }", /power of two/],
    ["struct A(u32);", /tuple structs/],
    ["struct A { a: [u8] }", /no fixed size/],
    ["struct A { a: u8, a: u8 }", /declared twice/],
    ["struct A { a: (u8, u8) }", /tuples/],
    ["struct A { a: Vec<u8> }", /not a type this lab knows/],
    ["struct A { a: Option<u32> }", /no C layout/],
    ["#[repr(transparent)] struct A { a: u8, b: u8 }", /exactly one field/],
    ["/* open", /never closed/],
    ["struct A { a: u8 ", /expected `}`|unexpected end/],
    ["fn main() {}", /type a struct/],
    ["type X = Y;\ntype Y = X;\nstruct A { a: X }", /refers to itself/],
    ["struct A { a: [[u64; 1048576]; 1048576] }", /larger than/],
    ["struct A { a: u8 }\nstruct A { b: u8 }", /defined twice/],
  ];
  for (const [src, re] of cases) {
    const a = analyze(src);
    assert.equal(a.ok, false, src);
    assert.match(a.error.message, re, src);
    assert.ok(Number.isInteger(a.error.line) && a.error.line >= 1, src);
    assert.match(summarize(a), /^Error on line \d+: /);
  }
  assert.equal(analyze("#[repr(C)] struct B { a: A }\n#[repr(C)] struct A { b: B }").error.line, 1);
});

test("hostile input is capped", () => {
  assert.equal(analyze("x".repeat(LIMITS.maxSource + 1)).ok, false);
  const many = Array.from({ length: LIMITS.maxStructs + 1 }, (_, i) => `struct S${i};`).join("\n");
  assert.match(analyze(many).error.message, /more than 16 structs/);
  const fields = Array.from({ length: LIMITS.maxFields + 1 }, (_, i) => `f${i}: u8`).join(",");
  assert.match(analyze(`struct A { ${fields} }`).error.message, /more than 64 fields/);
  assert.match(analyze("struct A { a: [u8; 0x1_0000_0000] }").error.message, /arrays longer/);
  let deep = "u8";
  for (let i = 0; i < 40; i++) deep = `[${deep}; 1]`;
  assert.match(analyze(`struct A { a: ${deep} }`).error.message, /nested too deeply/);
  assert.throws(() => tokenize("struct A { a: u8 }".padEnd(LIMITS.maxSource + 5, " ")));
  // Non-string input never reaches the parser as code.
  assert.equal(analyze(null).ok, false);
});

test("warnings: references, char, non-repr(C) inner struct, empty C struct", () => {
  const a = ok("struct In { a: u8 }\n#[repr(C)] struct Out { r: &'static u8, c: char, i: In }\n#[repr(C)] struct E;", { view: "Out" });
  const msgs = a.warnings.map((w) => w.message).join("\n");
  assert.match(msgs, /must never be null/);
  assert.match(msgs, /not a C type/);
  assert.match(msgs, /not #\[repr\(C\)\]/);
  assert.match(msgs, /not valid C/);
  assert.deepEqual(a.names, ["In", "Out", "E"]);
});

test("parseRust keeps declaration order and aliases", () => {
  const p = parseRust("type R = u32;\nstruct B { r: R }\nstruct A { b: B }");
  assert.deepEqual(p.order, ["B", "A"]);
  assert.ok(p.aliases.has("R"));
});

test("state: presets, edits, compare, reset", () => {
  let s = initialState();
  assert.equal(s.preset, "exit");
  s = step(s, { type: "preset", id: "order" });
  assert.equal(s.compare, "none");
  s = step(s, { type: "edit", source: s.source + "\n" });
  assert.equal(s.preset, null);
  s = step(s, { type: "edit", source: PRESETS.find((p) => p.id === "order").source });
  assert.equal(s.preset, "order");
  s = step(s, { type: "compare", value: "exit" });
  assert.equal(s.compare, "exit");
  const r = step(s, { type: "reset" });
  assert.deepEqual({ ...r, custom: null }, initialState());
  assert.equal(r.custom, PRESETS.find((p) => p.id === "order").source + "\n", "reset keeps the reader's own text");
  assert.equal(step(s, { type: "nonsense" }), s);
  assert.equal(step(s, { type: "preset", id: "nope" }), s);
});

test("share string round-trips and rejects junk", () => {
  const s0 = initialState();
  assert.equal(encodeShare(s0), "p.exit");
  assert.deepEqual(decodeShare("p.exit"), s0);
  const s1 = { preset: null, source: "#[repr(C)]\nstruct Ü { a: u8 } // ünïcode", compare: "none", view: "Ü" };
  const enc = encodeShare(s1);
  assert.match(enc, /^s\.[A-Za-z0-9_-]+\.n$/); // a non-ASCII view name is not shared
  assert.deepEqual(decodeShare(enc), { ...s1, view: null, custom: null });
  const s2 = { ...step(initialState(), { type: "preset", id: "order" }), view: "Tidy", compare: "exit" };
  assert.equal(encodeShare(s2), "p.order.x.v.Tidy");
  assert.deepEqual(decodeShare(encodeShare(s2)), s2);
  // Wasteful is the order preset's default view, so it is not written out.
  assert.equal(encodeShare({ ...s2, view: "Wasteful" }), "p.order.x");
  assert.equal(decodeShare("p.order").view, "Wasteful");
  for (const junk of ["", "p.", "p.nope", "q.exit", "s.!!", "s.A", "p.exit.z", "p.exit.v.", "s." + "A".repeat(LIMITS.maxShare), null, 42]) {
    assert.equal(decodeShare(junk), null, String(junk).slice(0, 20));
  }
  // Invalid UTF-8 (a lone 0xFF byte) is rejected, not mangled.
  assert.equal(decodeShare("s._w"), null);
});

test("C rendering: user typedefs, nested arrays, fn pointers", () => {
  const a = ok("type Buf = [u8; 4];\ntype Id = u32;\n#[repr(C)] struct S { id: Id, b: Buf, m: [[u16; 2]; 3], cb: Option<extern \"C\" fn()> }");
  assert.equal(
    a.c,
    [
      "typedef uint32_t Id;",
      "",
      "typedef uint8_t Buf[4];",
      "",
      "typedef struct {",
      "    Id id;",
      "    Buf b;",
      "    uint16_t m[3][2];",
      "    void (*cb)(/* ... */);",
      "} S;",
    ].join("\n"),
  );
  assert.equal(a.layout.size, 32);
  assert.deepEqual(a.layout.fields.map((f) => f.offset), [0, 4, 8, 24]);
});

test("promised all the way down: a repr(C) struct holding a default-repr struct does not match", () => {
  for (const src of [
    "struct Ex { syndrome: u64, virtual_address: u64, physical_address: u64 }\n#[repr(C)] struct Exit { reason: u32, exception: Ex }",
    "struct Ex { syndrome: u64, virtual_address: u64, physical_address: u64 }\ntype E2 = Ex;\n#[repr(C)] struct Exit { reason: u32, exception: E2 }",
    "struct W { x: u64 }\n#[repr(C)] struct Exit { reason: u32, w: [W; 3] }",
  ]) {
    const a = ok(src, { compare: "exit" });
    assert.equal(a.layout.promised, false, src);
    assert.equal(a.compare.match, false, src);
    assert.match(a.summary, /nothing is promised, because \w+, inside it, has no repr\(C\)/, src);
  }
});

test("repr(transparent) is promised when its one field is", () => {
  const a = ok("#[repr(C)] struct E { reason: u32, syndrome: u64, virtual_address: u64, physical_address: u64 }\n#[repr(transparent)] struct W { e: E }", { compare: "exit" });
  assert.equal(a.root, "W");
  assert.equal(a.layout.promised, true);
  assert.equal(a.compare.match, true);
  assert.equal(a.compare.renamed, 0);
  const b = ok("struct E { reason: u32 }\n#[repr(transparent)] struct W { e: E }", { compare: "exit" });
  assert.equal(b.layout.promised, false);
});

test("kind of value is compared: float in place of an integer is a difference", () => {
  const a = ok("#[repr(C)] struct Exit { reason: f32, syndrome: f64, virtual_address: u64, physical_address: u64 }", { compare: "exit" });
  assert.equal(a.compare.match, false);
  assert.equal(a.compare.rows[0].why, "same place and size, but a floating-point number; the header has an integer");
  // Signedness is not a difference.
  assert.equal(ok("#[repr(C)] struct Exit { reason: i32, syndrome: i64, virtual_address: u64, physical_address: u64 }", { compare: "exit" }).compare.match, true);
});

test("arrays compare element by element; other names are flagged, not passed silently", () => {
  const a = ok("#[repr(C)] struct Exit { reason: u32, s: [u64; 3] }", { compare: "exit" });
  assert.equal(a.compare.match, true);
  assert.equal(a.compare.renamed, 3);
  assert.deepEqual(a.compare.rows.map((r) => [r.status, r.yours.path]), [["ok", "reason"], ["renamed", "s[0]"], ["renamed", "s[1]"], ["renamed", "s[2]"]]);
});

test("size mismatches explain what would be read", () => {
  const w = ok(PRESETS.find((p) => p.id === "wide-reason").source, { compare: "exit" });
  assert.match(w.compare.rows[0].effect, /writes only 4 bytes here; the other 4 bytes you read are padding with unspecified contents/);
  const p = ok(PRESETS.find((q) => q.id === "packed").source, { compare: "exit" });
  assert.match(p.compare.rows[1].effect, /wrote for padding and exception\.syndrome/);
  assert.equal(p.compare.refSize, 32);
});

test("rustc's rejections: packed holding align(N), conflicting packed hints, literal suffixes", () => {
  const cases = [
    ["#[repr(C, align(16))] struct In { a: u8 }\n#[repr(C, packed)] struct A { x: u8, i: In }", /E0588/],
    ["#[repr(C, align(16))] struct In { a: u8 }\n#[repr(C)] struct Mid { i: [In; 2] }\n#[repr(C, packed(2))] struct A { m: Mid }", /cannot contain `In`/],
    ["#[repr(packed)] #[repr(packed(4))] struct A { a: u8 }", /conflicting packed/],
    ["struct A { a: [u8; 4u8] }", /array lengths are usize/],
    ["#[repr(align(8u32))] struct A { a: u8 }", /without a type suffix/],
  ];
  for (const [src, re] of cases) {
    const a = analyze(src);
    assert.equal(a.ok, false, src);
    assert.match(a.error.message, re, src);
  }
  assert.equal(ok("struct A { a: [u8; 4usize] }").layout.size, 4);
  assert.equal(ok("#[repr(C, align(16))] struct In { a: u8 }\n#[repr(C, align(32))] struct A { i: In }").layout.size, 32);
});

test("fn pointers: warn when not Option (cannot be NULL) or not extern \"C\"", () => {
  const msgs = (src) => ok(src).warnings.map((w) => w.message).join("\n");
  assert.match(msgs("#[repr(C)] struct S { f: extern \"C\" fn() }"), /fn pointer must never be null/);
  assert.match(msgs("#[repr(C)] struct S { f: Option<fn()> }"), /does not use the C calling convention/);
  assert.equal(msgs("#[repr(C)] struct S { f: Option<unsafe extern \"C\" fn(u32) -> u32> }"), "");
});

test("preset and reset never lose the reader's own struct", () => {
  let s = step(initialState(), { type: "edit", source: "#[repr(C)] struct Mine { a: u8 }" });
  assert.equal(s.preset, null);
  s = step(s, { type: "preset", id: "flat" });
  s = step(s, { type: "preset", id: "packed" }); // arrowing through the list
  assert.equal(s.custom, "#[repr(C)] struct Mine { a: u8 }");
  s = step(s, { type: "custom" });
  assert.equal(s.source, "#[repr(C)] struct Mine { a: u8 }");
  assert.equal(s.preset, null);
});

test("share: worst-case non-ASCII source fits, too-long state is refused at encode time", () => {
  const src = `// ${"漢".repeat(LIMITS.maxSource - 3)}`;
  assert.equal(src.length, LIMITS.maxSource);
  const enc = encodeShare({ preset: null, source: src, compare: "exit", view: null });
  assert.ok(enc && enc.length <= LIMITS.maxShare);
  assert.equal(decodeShare(enc).source, src);
  assert.equal(encodeShare({ preset: null, source: src, compare: "none", view: "V".repeat(LIMITS.maxViewName + 1) }).includes(".v."), false);
});

test("the order preset opens on its wasteful struct", () => {
  const s = step(initialState(), { type: "preset", id: "order" });
  assert.equal(s.view, "Wasteful");
  const a = ok(s.source, { view: s.view, compare: s.compare });
  assert.equal(a.root, "Wasteful");
  assert.equal(a.layout.bestSize, 16);
});

// Regression: structs, fields and depth were each capped, but by-value nesting multiplies them.
// Each of these came from a share link (the fragment is analysed on mount, with nobody asking).
const nest = (levels, fan, leaf = "u8") =>
  Array.from({ length: levels }, (_, k) => `#[repr(C)] struct S${k} {${Array.from({ length: fan }, (_, i) => ` a${i}: ${k ? `S${k - 1}` : leaf},`).join("")} }`).join("\n");
const timed = (fn) => {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
};

test("nested structs: the flattened leaf count is capped before anything is expanded", () => {
  // (a) six 64-field structs: 64^6 leaves; analyze did not return in 20 s.
  // (b) nine 4-field structs (a 685-character link): 262,144 leaves, 2.36 million DOM nodes.
  // (c) ten 4-field structs (761 characters): `out.push(...leaves())` threw RangeError.
  for (const [levels, fan] of [
    [6, 64],
    [9, 4],
    [10, 4],
  ]) {
    const src = nest(levels, fan);
    assert.ok(src.length <= LIMITS.maxSource);
    for (const compare of ["none", "exit"]) {
      const [a, ms] = timed(() => analyze(src, { compare }));
      assert.equal(a.ok, false, `${levels}x${fan}`);
      assert.match(a.error.message, /more than 512 fields once the structs inside it are written out/);
      assert.ok(a.error.line >= 1);
      assert.ok(ms < 100, `${levels}x${fan} took ${ms.toFixed(1)} ms`);
    }
  }
  // The same through the share link, as the view's mount does it.
  const st = decodeShare(encodeShare(step(initialState(), { type: "edit", source: nest(10, 4) })));
  const [a, ms] = timed(() => analyze(st.source, { compare: st.compare, view: st.view }));
  assert.equal(a.ok, false);
  assert.ok(ms < 100);
});

test("zero-length arrays do not hide a nested product from the leaf cap or the expander", () => {
  // `[u8; 0]` fields are 0 leaves when arrays are expanded and 1 leaf each when they are not:
  // the cap has to count both ways. Before the fix this spent 64^k steps counting to zero.
  const src = `${nest(6, 64, "[u8; 0]")}\n#[repr(C)] struct T { x: [S5; 1] }`;
  const [a, ms] = timed(() => analyze(src, { compare: "exit", view: "T" }));
  assert.equal(a.ok, false);
  assert.match(a.error.message, /more than 512 fields/);
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
  // An array of a million empty elements expands to nothing, without counting to a million
  // (2^40 steps for the nested one, before the fix).
  const zst = "#[repr(C)] struct E { e: [u8; 0] }\n#[repr(C)] struct Z { a: [[E; 1048576]; 1048576], b: u64 }";
  const [z, zms] = timed(() => analyze(zst, { compare: "exit" }));
  assert.equal(z.ok, true);
  assert.deepEqual(leaves(z.layout, { expand: true }).map((l) => l.path), ["b"]);
  assert.ok(zms < 100, `${zms.toFixed(1)} ms`);
});

test("the leaf cap is exact, and ordinary nesting is unaffected", () => {
  // 8 x 64 = 512 leaves is allowed; one more is not.
  const at = "#[repr(C)] struct A {" + Array.from({ length: 64 }, (_, i) => `f${i}: u8,`).join("") + "}\n#[repr(C)] struct B { a0: A, a1: A, a2: A, a3: A, a4: A, a5: A, a6: A, a7: A }";
  const a = ok(at, { compare: "exit" });
  assert.equal(a.root, "B");
  assert.equal(leaves(a.layout).length, LIMITS.maxLeaves);
  assert.equal(a.layout.size, 512);
  assert.equal(analyze(at.replace("a7: A }", "a7: A, one_more: u8 }")).ok, false);
  // A long array of a big struct is one leaf, as before: it is not expanded.
  const arr = ok(`${at}\n#[repr(C)] struct C { all: [B; 1000], n: u32 }`);
  assert.deepEqual(leaves(arr.layout, { expand: true }).map((l) => [l.path, l.offset, l.size]), [
    ["all", 0, 512000],
    ["n", 512000, 4],
  ]);
  // Small arrays still expand element by element, through nested structs.
  const small = ok("#[repr(C)] struct P { x: u16, y: u16 }\n#[repr(C)] struct Q { ps: [P; 3], tail: [u64; 2] }");
  assert.deepEqual(leaves(small.layout, { expand: true }).map((l) => [l.path, l.offset]), [
    ["ps[0].x", 0],
    ["ps[0].y", 2],
    ["ps[1].x", 4],
    ["ps[1].y", 6],
    ["ps[2].x", 8],
    ["ps[2].y", 10],
    ["tail[0]", 16],
    ["tail[1]", 24],
  ]);
});

test("type names that are Object.prototype keys are ordinary unknown names", () => {
  // `PRIMS["constructor"]` is a function, so `a: constructor` used to be taken for a primitive
  // with no size (and reported as a struct "larger than 2147483648 bytes"), and `*mut toString`
  // printed `undefined *` in the C rendering.
  for (const w of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    assert.match(analyze(`#[repr(C)] struct A { a: ${w} }`).error.message, new RegExp(`^unknown type \`${w}\``), w);
    assert.match(analyze(`#[repr(C)] struct A { a: [${w}; 2] }`).error.message, /^unknown type/, w);
    const ptr = ok(`#[repr(C)] struct A { a: *mut ${w} }`);
    assert.equal(ptr.c, `typedef struct {\n    ${w} *a;\n} A;`, w);
    // A reader's own type of that name is theirs: laid out, and its typedef is written.
    const alias = ok(`type ${w} = u32; #[repr(C)] struct B { x: ${w} }`);
    assert.equal(alias.layout.size, 4, w);
    assert.match(alias.c, new RegExp(`^typedef uint32_t ${w};`), w);
    assert.equal(ok(`#[repr(C)] struct ${w} { a: u8 } #[repr(C)] struct B { x: ${w}, y: u16 }`).layout.size, 4, w);
    // In a skipped attribute group an identifier is never a bracket.
    assert.equal(ok(`#[derive(${w})] #[repr(C)] struct A { a: u8 }`).layout.size, 1, w);
  }
});
