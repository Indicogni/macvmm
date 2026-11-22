// Renderer tests: every Markdown construct and directive the course uses, escaping, and the
// negative cases that must be build errors (DESIGN.md §9-10). Run: node --test 'course/site/**/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, inline, parseArgs, linkPrimerSlugs, MarkdownError } from "../lib/md.mjs";

const stub = (tag) => (a) => `<x-${tag}>${JSON.stringify(a)}</x-${tag}>`;
const hooks = { code: stub("code"), term: stub("term"), lab: (n) => `<x-lab>${n}</x-lab>`, checkpoint: stub("cp"), retrieval: stub("ret"), diagram: stub("dia") };
const md = (s, o = {}) => renderMarkdown(s, { hooks, ...o });

test("inline: emphasis, strong, code, links", () => {
  assert.equal(inline("a *b* **c** `d`"), "a <em>b</em> <strong>c</strong> <code>d</code>");
  assert.equal(inline("[x](/a/) and [`y`](https://e.org/z)"), '<a href="/a/">x</a> and <a href="https://e.org/z" rel="noopener noreferrer" class="ext"><code>y</code></a>');
  assert.equal(inline("snake_case_name and a * b"), "snake_case_name and a * b");
  assert.equal(inline("_em_ here"), "<em>em</em> here");
  assert.equal(inline("`` a`b ``"), "<code>a`b</code>");
  assert.equal(inline("\\*not em\\*"), "*not em*");
  assert.equal(inline("<https://x.org/>"), '<a href="https://x.org/" rel="noopener noreferrer" class="ext">https://x.org/</a>');
});

test("inline: raw HTML is escaped, never passed through", () => {
  assert.equal(inline('<script>alert(1)</script> & "q"'), "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
  assert.equal(inline("<img src=x onerror=alert(1)>"), "&lt;img src=x onerror=alert(1)&gt;");
  assert.equal(inline("`<b>`"), "<code>&lt;b&gt;</code>");
});

test("inline: dangerous link schemes are refused", () => {
  assert.throws(() => inline("[x](javascript:alert(1))"), /scheme not allowed/);
  assert.throws(() => inline("[x](data:text/html,hi)"), /scheme not allowed/);
  assert.throws(() => inline("![](a.png)"), /no alt text/);
  assert.throws(() => inline("![a](https://e.org/a.png)"), /local file/);
  assert.equal(inline('[x](/a/ "A title")'), '<a href="/a/" title="A title">x</a>');
});

test("blocks: headings get ids and anchor links; levels are enforced", () => {
  const r = md("## Two stages, one map\n\n### Sub `x`\n", { minHeading: 2, maxHeading: 3 });
  assert.match(r.html, /<h2 id="two-stages-one-map">Two stages, one map<a class="h-anchor" href="#two-stages-one-map" aria-hidden="true" tabindex="-1">#<\/a><\/h2>/);
  assert.match(r.html, /<h3 id="sub-x">Sub <code>x<\/code>/);
  assert.deepEqual(r.headings.map((h) => [h.level, h.id]), [[2, "two-stages-one-map"], [3, "sub-x"]]);
  assert.throws(() => md("# Title\n", { minHeading: 2, maxHeading: 3 }), MarkdownError);
  assert.throws(() => md("#### Deep\n", { minHeading: 2, maxHeading: 3 }), /heading level 4/);
  assert.match(md("# Puzzle\n", { minHeading: 1, h1As: 2 }).html, /<h2 id="puzzle">/);
  assert.equal(md("## The loader's <checks>\n").headings[0].text, "The loader's <checks>");
  const dup = md("## A\n\n## A\n");
  assert.deepEqual(dup.headings.map((h) => h.id), ["a", "a-2"]);
});

test("blocks: paragraphs join wrapped lines; emphasis may span lines; hard breaks", () => {
  assert.equal(md("a *b\nc* d\n").html, "<p>a <em>b\nc</em> d</p>\n");
  assert.equal(md("one  \ntwo\n").html, "<p>one<br>\ntwo</p>\n");
});

test("blocks: lists, nesting, loose items with fences", () => {
  assert.equal(md("- a\n- b\n").html, "<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n");
  assert.equal(md("3. x\n4. y\n").html, '<ol start="3">\n<li>x</li>\n<li>y</li>\n</ol>\n');
  const nested = md("- a\n  - b\n- c\n").html;
  assert.match(nested, /<li>a\n<ul>\n<li>b<\/li>\n<\/ul><\/li>/);
  const loose = md("1. step one\n\n   ```sh\n   ls\n   ```\n\n2. step two\n").html;
  assert.match(loose, /<li><p>step one<\/p>\n<figure class="code code--fence" data-lang="shell">/);
  assert.match(loose, /<li><p>step two<\/p><\/li>/);
  assert.match(md("- item that\n  wraps\n").html, /<li>item that\nwraps<\/li>/);
});

test("blocks: tables with alignment and code containing pipes", () => {
  const r = md("| a | b |\n|---|--:|\n| `x|y` | 2 |\n").html;
  assert.match(r, /<th scope="col">a<\/th><th scope="col" class="al-right">b<\/th>/);
  assert.match(r, /<td><code>x\|y<\/code><\/td><td class="al-right">2<\/td>/);
  // No tab stop and no landmark by default: course.js adds both only when the table overflows.
  assert.match(r, /^<div class="table-wrap" data-scroll-label="Table: a, b"><table>/);
});

test("blocks: fenced code is highlighted and escaped; unknown languages fail", () => {
  const r = md("```sh\necho '<b>'\n```\n").html;
  assert.match(r, /data-lang="shell"/);
  assert.match(r, /&lt;b&gt;/);
  assert.ok(!r.includes("<b>"));
  assert.throws(() => md("```mermaid\ngraph TD\n```\n"), /mermaid fence would show diagram source.*:::diagram/);
  assert.throws(() => md("```cobol\nx\n```\n"), /unsupported code language/);
  assert.throws(() => md("```sh\nunclosed\n"), /never closed/);
});

test("callouts: STYLE section 7 labels map to variants", () => {
  const sec = md("> **Security.** The guest chose it.\n").html;
  assert.match(sec, /<div class="callout callout--security" role="note"><p class="callout__label">.*<span>Security<\/span><\/p>\n<p>The guest chose it.<\/p>/s);
  assert.match(md("> **Under the hood.** Deeper.\n").html, /callout--why/);
  for (const l of ["Try it", "Aside", "Production note", "Aside (skippable)"]) assert.match(md(`> **${l}.** x\n`).html, new RegExp(`callout--note.*<span>${l.replace(/[()]/g, "\\$&")}</span>`, "s"));
  assert.match(md("> plain quote\n").html, /^<blockquote>/);
  assert.match(md(":::callout kind=mac title=\"On your Mac\"\nSixteen KiB pages.\n:::\n").html, /callout--mac.*On your Mac/s);
  assert.throws(() => md(":::callout kind=nope\nx\n:::\n"), /kind=nope/);
  assert.ok(!sec.includes("<aside"), "a callout is not a complementary landmark");
});

test("a Predict blockquote is an error; unknown callout labels warn", () => {
  assert.throws(() => md("> **Predict.** Will it trap?\n"), /:::predict container/);
  assert.throws(() => md("> **Predict** Will it trap?\n"), /:::predict container/);
  const r = md("> **Result of experiment 1.** It worked.\n");
  assert.match(r.html, /callout--note/);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /"Result of experiment 1" is not one of the STYLE.md section 7 callouts/);
  assert.deepEqual(md("> **Aside: why.** x\n").warnings, []);
});

test("link targets: schemes hidden by newlines and protocol-relative links are refused", () => {
  assert.throws(() => md("[x](java\nscript:alert(1))\n"), /scheme not allowed/);
  assert.throws(() => inline("[x](java\tscript:alert(1))"), /scheme not allowed/); // inline() sees raw tabs
  assert.throws(() => md("[x](//evil.example/)\n"), /protocol-relative/);
  assert.throws(() => md("![a](//evil.example/x.png)\n"), /local file/);
  assert.match(md("[x](https://example.org/)\n").html, /href="https:\/\/example.org\/"/);
  assert.match(md("[x](../y/#z)\n").html, /href="..\/y\/#z"/);
});

test("a directive inside a blockquote is not a directive", () => {
  assert.match(md("> :::lab esr-decoder\n").html, /<blockquote>\n<p>:::lab esr-decoder<\/p>/);
});

test("directives: containers render, leaves call hooks, grammar is enforced", () => {
  const r = md(":::objectives\n- one\n:::\n\n:::predict Will it *trap*?\nYes.\n:::\n\n:::lab esr-decoder\n\n:::code anchor=a file=b.rs\n\n:::stopping-point Good place to stop.\n");
  assert.match(r.html, /box--objectives.*<li>one<\/li>/s);
  assert.match(r.html, /<details class="predict"><summary>.*<span class="predict__q">Will it <em>trap<\/em>\?<\/span>.*<div class="predict__answer"><p>Yes.<\/p>/s);
  assert.match(r.html, /<x-lab>esr-decoder<\/x-lab>/);
  assert.match(r.html, /<x-code>\{"anchor":"a","file":"b.rs"\}<\/x-code>/);
  assert.match(r.html, /<div class="stop"><p>/);
  assert.ok(!r.html.includes("<aside"));
  assert.deepEqual(r.labs, ["esr-decoder"]);
  assert.equal(r.counts.predict, 1);
  assert.throws(() => md(":::objectives\n- x\n"), /never closed/);
  assert.throws(() => md(":::objectives\n:::predict q\na\n:::\n:::\n"), /do not nest/);
  assert.throws(() => md(":::lab x\n:::\n"), /closes nothing/);
  assert.throws(() => md(":::wat\n"), /unknown directive/);
  assert.throws(() => md(":::code anchor=a\n"), /both anchor= and file=/);
  assert.throws(() => md(":::predict\nx\n:::\n"), /question/);
  assert.throws(() => renderMarkdown(":::term source=captures/x.txt\n", {}), /not available/);
  // A ":::" inside a fence inside a container does not close the container.
  assert.match(md(":::predict q\n```text\n:::\n```\n:::\n").html, /<div class="predict__answer"><figure/);
});

test("concepts box links backticked primer slugs outside parentheses only", () => {
  const slugs = new Set(["elf", "smccc"]);
  const out = linkPrimerSlugs("**Primers (read first):** `elf` (the `smccc` header); `smccc`", slugs, (s) => `/p/${s}/`);
  assert.equal(out, "**Primers (read first):** [`elf`](/p/elf/) (the `smccc` header); [`smccc`](/p/smccc/)");
  const r = md(":::concepts\n- **Primers (read first):** `elf` (x)\n:::\n", { hooks: { ...hooks, primerSlugs: slugs, primerUrl: (s) => `/p/${s}/`, conceptsHead: () => "<p>HEAD</p>" } });
  assert.match(r.html, /Concepts you&#39;ll need|Concepts you'll need/);
  assert.match(r.html, /<p>HEAD<\/p>/);
  assert.match(r.html, /<a href="\/p\/elf\/"><code>elf<\/code><\/a>/);
});

test("parseArgs: key=value, quoted values, positional words", () => {
  assert.deepEqual(parseArgs('anchor=x file="a b.rs" extra'), { args: { anchor: "x", file: "a b.rs" }, words: ["extra"] });
  assert.deepEqual(parseArgs("from=01,00"), { args: { from: "01,00" }, words: [] });
});

test("errors carry the file and line", () => {
  try {
    renderMarkdown("ok\n\n:::nope\n", { file: "f.md", startLine: 10, hooks });
    assert.fail("should throw");
  } catch (e) {
    assert.match(e.message, /^f\.md:12: unknown directive/);
  }
});
