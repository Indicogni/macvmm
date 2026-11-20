// Unit tests for the small shared libraries: front matter, HTML helpers and the highlighter.
// Run: node --test course/site/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontMatter, FrontMatterError } from "../lib/frontmatter.mjs";
import { esc, slugify, fill, badges, minutesLabel } from "../lib/html.mjs";
import { tokenize, highlight, normalizeLang, langForFile, SUPPORTED_LANGS } from "../lib/highlight.mjs";

// ---- front matter -------------------------------------------------------------------------

test("front matter: scalars, lists, booleans, comments and body line", () => {
  const src = [
    "---",
    "title: Generate a DTB",
    "runs: mac+browser          # a comment",
    "prereqs: [2.4, 3.1]",
    "labs:",
    "- dtb-explorer",
    "- esr-decoder   # trailing comment",
    "expect: PASS dtb: 7 nodes",
    "draft: true",
    "quoted: \"a # b\"",
    "csharp: C# and #address-cells",
    "empty: []",
    "---",
    "Body",
  ].join("\n");
  const { data, body, bodyLine } = parseFrontMatter(src);
  assert.deepEqual(data, {
    title: "Generate a DTB",
    runs: "mac+browser",
    prereqs: ["2.4", "3.1"],
    labs: ["dtb-explorer", "esr-decoder"],
    expect: "PASS dtb: 7 nodes",
    draft: true,
    quoted: "a # b",
    csharp: "C# and #address-cells",
    empty: [],
  });
  assert.equal(body, "Body");
  assert.equal(bodyLine, 14);
});

test("front matter: quoted true stays a string; CRLF and BOM are accepted", () => {
  const { data, bodyLine } = parseFrontMatter("\uFEFF---\r\nflag: \"true\"\r\nn: 5\r\n---\r\nx");
  assert.deepEqual(data, { flag: "true", n: "5" });
  assert.equal(bodyLine, 5);
});

test("front matter: none at all", () => {
  assert.deepEqual(parseFrontMatter("# Title\n"), { data: {}, body: "# Title\n", bodyLine: 1 });
});

test("front matter: errors carry line numbers", () => {
  const bad = (s, re) => assert.throws(() => parseFrontMatter(s), (e) => e instanceof FrontMatterError && re.test(e.message));
  bad("---\ntitle: x\n", /never closed/);
  bad("---\n- orphan\n---\n", /line 2: list item without a key/);
  bad("---\na: 1\na: 2\n---\n", /line 3: duplicate key "a"/);
  bad("---\na: [1, 2\n---\n", /line 2: unterminated inline list/);
  bad("---\n  nested: x\n---\n", /line 2: cannot parse/);
  bad("---\na: 1\n- after scalar\n---\n", /line 3: list item without a key/);
});

// ---- html helpers -------------------------------------------------------------------------

test("esc escapes the five HTML metacharacters and tolerates null", () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(42), "42");
});

test("slugify makes stable fragment ids", () => {
  assert.equal(slugify("Two stages, one map"), "two-stages-one-map");
  assert.equal(slugify("The `ESR_EL2` *syndrome*"), "the-esrel2-syndrome");
  assert.equal(slugify("<b>A &amp; B</b>"), "a-b");
  assert.equal(slugify("!!!"), "section");
});

test("fill demands every slot and every value", () => {
  assert.equal(fill("<p>{{a}} {{b}} {{a}}</p>", { a: 1, b: "x" }), "<p>1 x 1</p>");
  assert.throws(() => fill("{{a}} {{b}}", { a: 1 }, "page"), /page: no value for slot \{\{b\}\}/);
  assert.throws(() => fill("{{a}}", { a: 1, c: 2 }), /value "c" given/);
});

test("badges carry text, not only color", () => {
  assert.match(badges("mac"), /Needs a Mac/);
  assert.doesNotMatch(badges("mac"), /Runs in browser/);
  assert.match(badges("browser"), /Runs in browser/);
  const both = badges("mac+browser");
  assert.match(both, /Needs a Mac/);
  assert.match(both, /Runs in browser/);
  assert.equal(badges("nonsense"), "");
});

test("minutesLabel", () => {
  assert.equal(minutesLabel(20), "~20 min");
  assert.equal(minutesLabel(89), "~89 min");
  assert.equal(minutesLabel(90), "~1.5 h");
  assert.equal(minutesLabel(240), "~4 h");
  assert.equal(minutesLabel(330), "~5.5 h");
  assert.equal(minutesLabel(null), "~15-30 min");
});

// ---- highlighter --------------------------------------------------------------------------

const SAMPLES = {
  rust: `/// Doc\nfn main() -> Result<(), HvError> {\n    let x: u64 = 0x4000_0000u64; // c\n    let s = r#"raw "q""#;\n    let c = '\\n';\n    fn f<'a>(v: &'a [u8]) {}\n    /* block\n       comment */\n    println!("{x}");\n}\n`,
  c: `#include <stdio.h>\nint main(void) { /* x */\n  printf("%d\\n", 0x10u); // y\n}\n`,
  shell: `# comment\necho "$HOME" '#lit' \${X} $? 42 # tail\nfor f in *.md; do cat "$f"; done\n`,
  asm: `_start:\n    movz x0, #0x4000, lsl #16 // c\n    mrs x1, CNTVCT_EL0\n    hvc #0\n`,
  toml: `[package]\nname = "macvmm" # c\nversion = 1\n`,
  dts: `/dts-v1/;\n/ { uart@9000000 { compatible = "arm,pl011"; reg = <0x0 0x9000000>; }; };\n`,
  json: `{"a": [1, -2.5e3, true, null], "b": "x"}\n`,
  text: `plain <text> & stuff\n`,
};

test("every supported language has a sample", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...SUPPORTED_LANGS].sort());
});

test("tokenize covers every character exactly once, in order", () => {
  for (const [lang, code] of Object.entries(SAMPLES)) {
    assert.equal(tokenize(code, lang).map((t) => t.text).join(""), code, lang);
  }
});

test("tokenize classifies the obvious tokens", () => {
  const cls = (code, lang, text) => tokenize(code, lang).find((t) => t.text === text)?.cls;
  assert.equal(cls("fn main() {}", "rust", "fn"), "k");
  assert.equal(cls("fn main() {}", "rust", "main"), "f");
  assert.equal(cls("let x: u64 = 7;", "rust", "u64"), "t");
  assert.equal(cls("let x = 0x4000_0000;", "rust", "0x4000_0000"), "n");
  assert.equal(cls("f<'a>(x)", "rust", "'a"), "t"); // a lifetime, not a char
  assert.equal(cls("let c = 'a';", "rust", "'a'"), "s");
  assert.equal(cls("echo hi # c", "shell", "# c"), "c");
  assert.equal(cls("echo a#b", "shell", "a#b"), undefined); // '#' inside a word is not a comment
  assert.equal(cls("    hvc #0", "asm", "    hvc"), "k");
  assert.equal(cls("mrs x1, CNTVCT_EL0", "asm", "CNTVCT_EL0"), "t");
});

test("highlight emits one line span per line and escapes HTML", () => {
  const html = highlight("/* a\nb */ x <y>\n", "c");
  const lines = html.split("\n");
  assert.equal(lines.length, 2);
  // A block comment that spans lines is closed and reopened, so each line is well formed.
  assert.equal(lines[0], '<span class="line"><span class="tok-c">/* a</span></span>');
  assert.match(lines[1], /^<span class="line"><span class="tok-c">b \*\/<\/span> x &lt;y&gt;<\/span>$/);
  const add = highlight("a\nb\n", "text", { addLines: new Set([2]) });
  assert.equal(add, '<span class="line">a</span>\n<span class="line add">b</span>');
});

test("languages: aliases, unknowns and file extensions", () => {
  assert.equal(normalizeLang("RS"), "rust");
  assert.equal(normalizeLang("zsh"), "shell");
  assert.equal(normalizeLang(""), "text");
  assert.equal(normalizeLang("cobol"), null);
  assert.throws(() => tokenize("x", "cobol"), /unsupported code language "cobol"/);
  assert.equal(langForFile("crates/vmm/src/fdt/builder.rs"), "rust");
  assert.equal(langForFile("guests/common/src/start.S"), "asm");
  assert.equal(langForFile("scripts/setup"), "shell");
  assert.equal(langForFile("scripts/check.sh"), "shell");
  assert.equal(langForFile("Makefile"), "text");
  assert.equal(langForFile("docs/x.md"), "text");
});
