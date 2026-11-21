// The ADR-0006 anchor corpus, mirrored from crates/xtask/tests/anchors.rs: the JS resolver the
// builder uses must agree with `scripts/check-anchors` on every case. Plus a parity check against
// the real repository: every `:::code` reference in every lesson resolves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, syntaxFor, validName, resolveAnchor } from "../lib/anchors.mjs";

const kinds = (text, syntax = "slash") => scan(text, syntax).problems.map((p) => [p.kind, p.name]);

test("balanced anchor extracts a dedented body", () => {
  const { regions, problems } = scan("fn a() {}\n    // ANCHOR: two\n    let x = 1;\n        let y = 2;\n    // ANCHOR_END: two\n", "slash");
  assert.deepEqual(problems, []);
  assert.equal(regions.length, 1);
  assert.deepEqual([regions[0].startLine, regions[0].endLine], [2, 5]);
  assert.deepEqual(regions[0].body, ["let x = 1;", "    let y = 2;"]);
});

test("nested anchors drop inner marker lines", () => {
  const { regions, problems } = scan("// ANCHOR: outer\na\n// ANCHOR: inner\nb\n// ANCHOR_END: inner\nc\n// ANCHOR_END: outer\n", "slash");
  assert.deepEqual(problems, []);
  assert.deepEqual(regions.find((r) => r.name === "outer").body, ["a", "b", "c"]);
  assert.deepEqual(regions.find((r) => r.name === "inner").body, ["b"]);
});

test("errors: duplicate, unterminated, end without start, partial overlap", () => {
  assert.deepEqual(kinds("// ANCHOR: d\nx\n// ANCHOR_END: d\n// ANCHOR: d\ny\n// ANCHOR_END: d\n"), [["duplicate", "d"]]);
  assert.deepEqual(kinds("// ANCHOR: open\nx\n"), [["unterminated", "open"]]);
  assert.deepEqual(kinds("x\n// ANCHOR_END: ghost\n"), [["end-without-start", "ghost"]]);
  assert.deepEqual(kinds("// ANCHOR: a\n1\n// ANCHOR: b\n2\n// ANCHOR_END: a\n3\n// ANCHOR_END: b\n"), [["partial-overlap", "a"]]);
});

test("empty regions, including one holding only a nested region's markers", () => {
  assert.deepEqual(kinds("// ANCHOR: e\n\n   \n// ANCHOR_END: e\n"), [["empty", "e"]]);
  assert.deepEqual(kinds("// ANCHOR: o\n// ANCHOR: i\n// ANCHOR_END: i\n// ANCHOR_END: o\n"), [["empty", "o"], ["empty", "i"]]);
});

test("regions longer than sixty lines are errors", () => {
  const body = (n) => Array.from({ length: n }, (_, i) => `line${i}\n`).join("");
  assert.deepEqual(kinds(`// ANCHOR: long\n${body(61)}// ANCHOR_END: long\n`), [["too-long", "long"]]);
  assert.deepEqual(kinds(`// ANCHOR: ok\n${body(60)}// ANCHOR_END: ok\n`), []);
});

test("comment syntaxes per file type", () => {
  const cases = [
    ["a.sh", "#!/usr/bin/env bash\n# ANCHOR: sh_part\necho hi\n# ANCHOR_END: sh_part\n", "sh_part"],
    ["a.md", "<!-- ANCHOR: md_part -->\ntext\n<!-- ANCHOR_END: md_part -->\n", "md_part"],
    ["a.rs", "// ANCHOR: rs_part\nfn f() {}\n// ANCHOR_END: rs_part\n", "rs_part"],
  ];
  for (const [path, text, name] of cases) {
    const { regions, problems } = scan(text, syntaxFor(path));
    assert.deepEqual(problems, [], path);
    assert.deepEqual(regions.map((r) => r.name), [name]);
  }
  assert.equal(scan(cases[1][1], "slash").regions.length, 0, "the wrong syntax is not a marker");
  assert.equal(scan("/* ANCHOR: c_part */\nint x;\n/* ANCHOR_END: c_part */\n", syntaxFor("a.c")).regions.length, 1);
  assert.equal(syntaxFor("scripts/check-anchors"), "hash");
  assert.equal(syntaxFor("a.png"), null);
});

test("linker scripts accept # and /* */ but not //", () => {
  assert.equal(syntaxFor("guests/link.ld"), "linker");
  for (const [text, name] of [
    ["SECTIONS {\n# ANCHOR: ld_hash\n  . = 0x40080000;\n# ANCHOR_END: ld_hash\n}\n", "ld_hash"],
    ["SECTIONS {\n/* ANCHOR: ld_block */\n  .text : { *(.text*) }\n/* ANCHOR_END: ld_block */\n}\n", "ld_block"],
  ]) assert.deepEqual(scan(text, "linker").regions.map((r) => r.name), [name]);
  assert.equal(scan("// ANCHOR: ld_slash\nx\n// ANCHOR_END: ld_slash\n", "linker").regions.length, 0);
});

test("prose mentions and fenced markers are not markers", () => {
  const { regions, problems } = scan("Use `// ANCHOR: name` in Rust.\n```rust\n// ANCHOR: in_fence\n```\n<!-- ANCHOR: real -->\nx\n<!-- ANCHOR_END: real -->\n", "html");
  assert.deepEqual(problems, []);
  assert.equal(regions.length, 1);
});

test("names and LEARNER markers", () => {
  assert.equal(kinds("// ANCHOR: Bad-Name\nx\n// ANCHOR_END: Bad-Name\n").length, 2);
  assert.ok(validName("esr_decode_data_abort"));
  assert.ok(!validName("1abc") && !validName("") && !validName("a-b"));
  assert.deepEqual(kinds("// LEARNER: hole\nx\n// LEARNER_END: hole\n// LEARNER: open\n"), [["unterminated", "open"]]);
});

test("resolveAnchor: missing files and anchors fail; paths cannot escape the repo", () => {
  const files = { "a.rs": "// ANCHOR: present\nfn f() {}\n// ANCHOR_END: present\n" };
  const read = (p) => files[p] ?? null;
  assert.deepEqual(resolveAnchor("a.rs", "present", read), { body: "fn f() {}", startLine: 2, endLine: 2 });
  assert.throws(() => resolveAnchor("a.rs", "absent", read), /not found/);
  assert.throws(() => resolveAnchor("missing.rs", "present", read), /does not exist/);
  assert.throws(() => resolveAnchor("../etc/passwd", "x", read), /repo-relative/);
  assert.throws(() => resolveAnchor("/etc/passwd", "x", read), /repo-relative/);
});

test("every :::code reference in the real lessons resolves (parity with scripts/check-anchors)", () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  let count = 0;
  for (const f of walk(join(repo, "course", "chapters")).filter((x) => x.endsWith(".md"))) {
    let fence = false;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (line.trim().startsWith("```")) fence = !fence;
      if (fence || !line.trim().startsWith(":::code")) continue;
      const anchor = line.match(/anchor=(\S+)/)[1];
      const file = line.match(/file=(\S+)/)[1];
      const read = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p), "utf8") : null);
      assert.ok(resolveAnchor(file, anchor, read).body.length > 0, `${f}: ${anchor}`);
      count++;
    }
  }
  assert.ok(count > 100, `found ${count} references`);
});
