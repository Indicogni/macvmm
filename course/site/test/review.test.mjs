// Regression tests for the site review fixes: output-directory safety, aria-current, tab stops,
// lab link names, capture separators, the stylesheet budget, control borders, notation that
// hides in code spans, and the extra CSP resource checks. Run: node --test 'course/site/**/*.test.mjs'
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, resolveOutDirs, minifyCss, CSP, BUILD_MARKER } from "../build.mjs";
import { checkCsp, checkInternalNotation, checkControlBorders, checkSize, checkContrast, CSS_BUDGET } from "../lib/checks.mjs";
import { classify, renderCapture } from "../lib/captures.mjs";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(SITE, "..", "..");
let base, res, root;
const page = (p) => readFileSync(join(root, p), "utf8");

before(() => {
  base = mkdtempSync(join(tmpdir(), "vmm-review-"));
  res = build({ out: join(base, "site"), check: true, quiet: true, year: 2026 });
  root = res.root;
});
after(() => rmSync(base, { recursive: true, force: true }));

// ---- --out safety -------------------------------------------------------------------------
test("--out: a trailing slash stages in a sibling, never inside the target", () => {
  const t = mkdtempSync(join(tmpdir(), "vmm-out-"));
  try {
    const r = resolveOutDirs(join(t, "d2") + "/");
    assert.equal(r.finalOut, join(t, "d2"));
    assert.equal(r.out, join(t, "d2.partial"));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("--out: refuses the filesystem root, home, the cwd, the repository and their ancestors", () => {
  const t = mkdtempSync(join(tmpdir(), "vmm-out-"));
  try {
    for (const bad of ["/", homedir(), REPO, SITE, dirname(REPO)]) assert.throws(() => resolveOutDirs(bad), /refusing/, bad);
    assert.throws(() => resolveOutDirs(".", { cwd: t }), /refusing/);
    assert.throws(() => resolveOutDirs(t, { cwd: join(t, "sub") }), /refusing/, "an ancestor of the cwd");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("--out: refuses a non-empty directory that is not an earlier build; accepts one that is", () => {
  const t = mkdtempSync(join(tmpdir(), "vmm-out-"));
  try {
    mkdirSync(join(t, "notes"));
    writeFileSync(join(t, "notes", "keep.txt"), "mine");
    assert.throws(() => resolveOutDirs(join(t, "notes")), /not an earlier site build/);
    assert.ok(existsSync(join(t, "notes", "keep.txt")));
    mkdirSync(join(t, "old"));
    writeFileSync(join(t, "old", BUILD_MARKER), "");
    assert.doesNotThrow(() => resolveOutDirs(join(t, "old")));
    assert.doesNotThrow(() => resolveOutDirs(join(t, "new")), "a missing directory is fine");
    mkdirSync(join(t, "x.partial"));
    writeFileSync(join(t, "x.partial", "keep.txt"), "mine");
    assert.throws(() => resolveOutDirs(join(t, "x")), /x\.partial is not empty/, "the staging path is protected too");
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("every build tree carries the marker, so the next build may replace it", () => {
  assert.ok(existsSync(join(res.out, BUILD_MARKER)));
});

// ---- navigation and names -----------------------------------------------------------------
const topnav = (html) => html.match(/<nav aria-label="Site">[\s\S]*?<\/nav>/)[0];

test("header: aria-current=page only on the link to this page; its section gets aria-current=true", () => {
  const lesson = topnav(page("bare-machine/first-exit/index.html"));
  assert.match(lesson, /<a href="\/build-your-own\/vmm\/" aria-current="true">Course<\/a>/);
  assert.ok(!lesson.includes('aria-current="page"'));
  assert.match(topnav(page("index.html")), /<a href="\/build-your-own\/vmm\/" aria-current="page">Course<\/a>/);
  assert.match(topnav(page("labs/index.html")), /aria-current="page">Labs</);
  assert.match(topnav(page("labs/esr-decoder/index.html")), /aria-current="true">Labs</);
});

test("one-line anchors say 'line N', not 'lines N-N'", () => {
  for (const p of ["bare-machine/first-exit/index.html", "start/ffi/index.html"]) {
    const h = existsSync(join(root, p)) ? page(p) : "";
    for (const m of h.matchAll(/lines (\d+)-(\d+)/g)) assert.notEqual(m[1], m[2], `${p}: ${m[0]}`);
  }
});

test("terminal and checkpoint <pre> are not static tab stops; code blocks keep the no-JS fallback", () => {
  const h = page("bare-machine/first-exit/index.html");
  assert.ok(!/<figure class="term[^"]*">[\s\S]{0,400}?<pre tabindex/.test(h), "terminal pre has no static tabindex");
  assert.match(h, /<pre data-scroll-label="Terminal output">/);
  const cp = h.match(/<div class="checkpoint"[\s\S]*?<\/div>\n?<\/div>|<div class="checkpoint"[\s\S]*?I saw this output/)[0];
  assert.ok(!cp.includes("tabindex"), "checkpoint pre has no static tabindex");
  assert.match(cp, /Run this from the repository root:/);
  assert.match(h, /<figure class="code code--numbered"[\s\S]*?<pre tabindex="0" data-scroll-label="Code: [^"]+">/);
});

test("lab embeds name their target; the standalone page says 'Lab' once", () => {
  const h = page("bare-machine/first-exit/index.html");
  const links = [...h.matchAll(/>Open full page(<span class="visually-hidden">: [^<]+<\/span>)?<\/a>/g)];
  assert.ok(links.length > 0);
  for (const l of links) assert.ok(l[1], "every 'Open full page' link carries the lab title");
  const standalone = page("labs/esr-decoder/index.html");
  assert.equal((standalone.match(/<[a-z]+ class="tag">Lab</g) || []).length, 1);
});

test("index cards: covers text is plain (no nested anchors)", () => {
  const h = page("primers/index.html");
  for (const card of h.matchAll(/<div class="card card--link[^"]*">([\s\S]*?)<\/div><\/li>/g)) assert.equal((card[1].match(/<a /g) || []).length, 1);
});

test("primer header: first chapter and other uses come from chapters.json, written chapters only", () => {
  const course = JSON.parse(readFileSync(join(SITE, "..", "chapters.json"), "utf8"));
  const exists = new Set(course.chapters.filter((c) => existsSync(join(REPO, c.file))).map((c) => c.id));
  for (const p of course.primers) {
    const h = readFileSync(join(root, p.url, "index.html"), "utf8");
    const line = (h.match(/<p class="progress-label">First needed in[\s\S]*?<\/p>/) || [""])[0];
    for (const m of line.matchAll(/chapter (\d\d)</g)) assert.ok(exists.has(m[1]) && [p.first_required_by, ...p.also_used_by].includes(m[1]), `${p.slug}: chapter ${m[1]}`);
  }
});

// ---- captures -------------------------------------------------------------------------------
test("captures: the tool's blank line before --- stderr --- is not an output row", () => {
  const rows = classify(["$ run", "--- stdout ---", "macvmm exit code: 5", "", "--- stderr ---", "oops", ""]);
  assert.deepEqual(rows.map((r) => r.kind), ["cmd", "sec", "out", "sec", "out"]);
  const html = renderCapture(readFileSync(join(SITE, "..", "captures", "00-guest-is-a-process.txt"), "utf8"), "s");
  assert.ok(!/<span class="out"><\/span><span class="meta sec">/.test(html));
});

// ---- styles ---------------------------------------------------------------------------------
test("the shipped stylesheet fits its budget, and checkSize enforces it", () => {
  const t = mkdtempSync(join(tmpdir(), "vmm-css-"));
  try {
    mkdirSync(join(t, "assets"));
    writeFileSync(join(t, "assets", "course.0123456789.css"), "a{}".repeat(CSS_BUDGET));
    assert.match(checkSize(t).join("\n"), /stylesheet budget/);
  } finally { rmSync(t, { recursive: true, force: true }); }
  assert.deepEqual(res.problems.filter((p) => /stylesheet budget/.test(p)), []);
});

test("minifyCss is safe for course.css: no string value holds { } ; or ,", () => {
  const css = readFileSync(join(SITE, "src", "assets", "course.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const strings = css.match(/"[^"\n]*"/g) || [];
  for (const s of strings) if (!/^"[^"]*"$/.test(s) || /[{};]/.test(s)) assert.fail(`string ${s}`);
  assert.equal(minifyCss("a { color : red ; }\n/* x */ b ,\n c { content: \"x y\" }"), 'a{color : red}b,c{content: "x y"}');
});

test("form controls need a 3:1 edge: --control passes, --rule on an input fails", () => {
  const css = readFileSync(join(SITE, "src", "assets", "course.css"), "utf8");
  assert.deepEqual(checkContrast(css), []);
  assert.ok(checkContrast(css.replace("--control:#7A7F87", "--control:#E4DDCC")).some((p) => /--control on --paper/.test(p)));
  assert.equal(checkControlBorders('.lab[data-lab="x"] input[type="text"] { border: 1px solid var(--rule); }').length, 1);
  assert.equal(checkControlBorders('.lab[data-lab="x"] select,\n.lab[data-lab="x"] .y { border-color: var(--rule) }').length, 1);
  assert.equal(checkControlBorders('.lab[data-lab="x"] input[type="text"] { border: 1px solid var(--control); }').length, 0);
  assert.equal(checkControlBorders('.lab[data-lab="x"] .panel { border: 1px solid var(--rule); }').length, 0);
});

// ---- notation and CSP ----------------------------------------------------------------------
test("notation lint sees evidence tags and internal sections hidden in code spans", () => {
  const wrap = (s) => `<main>${s}</main>`;
  assert.equal(checkInternalNotation(wrap("<p>marked <code>[V]</code> here</p>")).length, 1);
  assert.equal(checkInternalNotation(wrap("<p>in <code>docs/security/threat-model.md</code> §13</p>")).length, 1);
  assert.equal(checkInternalNotation(wrap("<p>The project's first spike printed it.</p>")).length, 1);
  assert.equal(checkInternalNotation(wrap("<p>virtio 1.2 §5.2 and <code>x[V]y</code></p>")).length, 0);
});

test("checkCsp: srcset, poster, SVG href and meta refresh are checked too", () => {
  for (const bad of [
    '<img src="/a.png" srcset="/a.png 1x, https://e.org/b.png 2x">', '<video poster="https://e.org/p.png"></video>',
    '<svg><use href="https://e.org/s.svg#i"/></svg>', '<svg><image xlink:href="//e.org/x.png"/></svg>',
    '<meta http-equiv="refresh" content="0;url=https://e.org/">',
  ]) assert.ok(checkCsp(bad).length > 0, bad);
  assert.deepEqual(checkCsp('<img src="/a.png" srcset="/a.png 1x, /b.png 2x"><svg><use href="#i"/></svg>'), []);
});

test("the CSP enforces Trusted Types with no policy", () => {
  assert.match(CSP, /require-trusted-types-for 'script'; trusted-types 'none'/);
  assert.match(readFileSync(join(res.out, "_headers"), "utf8"), /trusted-types 'none'/);
});
