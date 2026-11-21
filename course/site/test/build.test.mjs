// End-to-end: build the whole site into a temp dir, then check what a browser would get. Every
// page must be CSP-clean (no inline script/style/handlers, nothing from another origin), every
// internal link and #fragment must resolve, and the pages DESIGN.md section 1 promises exist.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, displayTitle, retrievalSources, parseGlossary, glossaryAnchor, parseRetrievalBank, CSP, headersFile, validateCourse, safeRepoPath, coversText, chapterLabel } from "../build.mjs";
import { checkCsp, checkContrast, contrast, checkInternalNotation } from "../lib/checks.mjs";
import { sanitizeSvg, svgMinWidth, MIN_TEXT_PX, NARROWEST } from "../lib/svg.mjs";
import { DIAGRAMS, renderDiagram } from "../tools/diagrams.mjs";
import { parseHeaders, headersFor, resolvePath } from "../serve.mjs";

let base, out, res, root;
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

before(() => {
  base = mkdtempSync(join(tmpdir(), "vmm-site-"));
  res = build({ out: base, check: true, quiet: true, year: 2026 });
  out = res.out; // base itself, or base.partial when a lab author's problem failed the build
  root = res.root;
});
after(() => { rmSync(base, { recursive: true, force: true }); rmSync(`${base}.partial`, { recursive: true, force: true }); });

test("the build has no errors outside lab sources (lab authors own those)", () => {
  const ours = res.problems.filter((p) => !p.startsWith("src/labs/"));
  assert.deepEqual(ours, []);
  const labs = res.problems.filter((p) => p.startsWith("src/labs/"));
  if (labs.length) console.log(`note: ${labs.length} lab-contract problem(s) reported to lab authors:\n  ${labs.join("\n  ")}`);
});

test("every page exists: landing, parts, lessons, primers, labs, glossary, reference, 404, sitemap", () => {
  const course = JSON.parse(readFileSync(new URL("../../chapters.json", import.meta.url), "utf8"));
  const must = ["index.html", "404.html", "sitemap.xml", "glossary/index.html", "reference/index.html", "about/index.html", "labs/index.html", "primers/index.html"];
  for (const p of course.parts) must.push(`${p.slug}/index.html`);
  for (const c of course.chapters) must.push(`${c.url}index.html`);
  for (const p of course.primers) must.push(`${p.url}index.html`);
  for (const l of course.labs) must.push(`labs/${l.name}/index.html`);
  for (const m of must) assert.ok(existsSync(join(root, m)), m);
  assert.ok(existsSync(join(out, "_headers")));
});

test("CSP: no page has inline script, inline style, handlers, or foreign resources", () => {
  const pages = walk(out).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length > 100);
  for (const f of pages) {
    const html = readFileSync(f, "utf8");
    assert.deepEqual(checkCsp(html, f), []);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${f}: inline <script>`);
    assert.ok(!/\sstyle\s*=/i.test(html.replace(/<pre[\s\S]*?<\/pre>/g, "")), `${f}: style attribute`);
    assert.ok(!/<style\b/i.test(html), `${f}: <style>`);
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html.replace(/>[^<]*</g, "><")), `${f}: event handler attribute`);
  }
});

test("the CSP itself is 'self'-only and shipped in _headers", () => {
  assert.match(CSP, /default-src 'self'/);
  assert.match(CSP, /script-src 'self';/);
  assert.match(CSP, /style-src 'self';/);
  assert.ok(!/unsafe-inline|unsafe-eval|wasm-unsafe-eval|https?:/.test(CSP));
  const h = readFileSync(join(out, "_headers"), "utf8");
  assert.equal(h, headersFile("/build-your-own/vmm/"));
  assert.ok(h.includes(`Content-Security-Policy: ${CSP}`));
});

test("checkCsp catches what it must", () => {
  const bad = ['<script>x()</script>', '<p onclick="x()">', '<rect/onclick="alert(1)"/>', '<img src="data:image/png;base64,AAAA" alt="">', '<p style="color:red">', "<style>p{}</style>", '<script src="https://cdn.example/x.js"></script>',
    '<link rel="stylesheet" href="//fonts.example/css">', '<a href="javascript:alert(1)">', '<img src="http://e.org/a.png" alt="">', '<iframe src="/x"></iframe>'];
  for (const b of bad) assert.ok(checkCsp(b).length > 0, b);
  for (const ok of ['<script type="module" src="/a.js"></script>', '<a href="https://e.org/">e</a>', '<link rel="canonical" href="https://indicogni.com/x/">', "<p>onclick=1 style=2</p>"]) {
    assert.deepEqual(checkCsp(ok), [], ok);
  }
});

test("internal links and fragments resolve (the --check run had no link problems)", () => {
  assert.ok(!res.problems.some((p) => /no such file|no element with id/.test(p)), res.problems.join("\n"));
});

test("lesson pages carry the DESIGN section 2.2 blocks and landmarks", () => {
  const html = readFileSync(join(root, "bare-machine/first-exit/index.html"), "utf8");
  for (const needle of ['<a class="skip" href="#main">', '<main id="main"', 'aria-label="Course contents"', 'aria-label="Previous and next chapter"',
    "box--objectives", "box--concepts", "box--retrieval", 'class="checkpoint"', "<details class=\"predict\"", 'class="term"', "captured: real output",
    'class="code code--numbered"', 'section class="lab', 'lang="en"', "<h1>"]) {
    assert.ok(html.includes(needle), needle);
  }
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, "exactly one h1");
  const text = html.replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ");
  assert.ok(!/\bSHOULD\b|STRETCH|post-v1|(?<!Apple )\bM\d{1,2}\b|PLAN §|CURRICULUM/.test(text), "no internal notation outside code");
});

test("a failed build never replaces the output: it stays in <out>.partial with a marker", () => {
  if (res.problems.length === 0) {
    assert.equal(out, base);
    assert.ok(!existsSync(`${base}.partial`));
    assert.ok(!existsSync(join(out, "BUILD-FAILED.txt")));
  } else {
    assert.equal(out, `${base}.partial`);
    assert.ok(existsSync(join(out, "BUILD-FAILED.txt")));
  }
});

test("chapters are named by their two-digit id everywhere the site generates a name", () => {
  const ch02 = readFileSync(join(root, "bare-machine/first-exit/index.html"), "utf8");
  assert.match(ch02, /<p class="tag">Chapter 02 · Part I<\/p>/);
  assert.match(ch02, /<title>02 /);
  assert.match(ch02, /Course progress: chapter 02 is 3 of the \d+ chapters written so far/, "progress label names the chapter by its id");
  assert.ok(!/this is chapter \d+ of/.test(ch02), "no 1-based chapter number in the progress label");
  assert.ok(!/Chapter I\.\d|chapter [0IVX]+\.\d/.test(ch02.replace(/<pre[\s\S]*?<\/pre>/g, "")), "no display numbers like I.1 in generated text");
  const smccc = readFileSync(join(root, "primers/smccc/index.html"), "utf8");
  assert.match(smccc, /First needed in <a href="[^"]+">chapter 03<\/a>; also used in <a href="[^"]+">chapter 08<\/a>, <a href="[^"]+">chapter 20<\/a><\/p>/);
  const ch03 = readFileSync(join(root, "bare-machine/test-guests/index.html"), "utf8");
  assert.match(ch03, /From chapter \d\d: /);
  assert.equal(chapterLabel({ id: "07" }), "Chapter 07");
});

test("part pages open their part but mark no chapter as the current page", () => {
  const html = readFileSync(join(root, "memory/index.html"), "utf8");
  const nav = html.match(/<div class="sidebar">[\s\S]*?<\/nav><\/div>/)[0];
  assert.ok(!nav.includes('aria-current="page"'), "no chapter is current on a part page");
  assert.match(nav, /<details open><summary><span class="num">Part II</);
});

test("404 has no canonical URL; lessons do", () => {
  const nf = readFileSync(join(root, "404.html"), "utf8");
  assert.ok(!/rel="canonical"|og:url/.test(nf));
  assert.match(readFileSync(join(root, "bare-machine/first-exit/index.html"), "utf8"), /<link rel="canonical" href="https:\/\/indicogni\.com\/build-your-own\/vmm\/bare-machine\/first-exit\/">/);
});

test("landmarks and names: callouts are notes, the progress bar is named, index cards are h2", () => {
  const ch = readFileSync(join(root, "cpu/exit-loop/index.html"), "utf8");
  assert.ok(!ch.includes("<aside"), "no complementary landmarks inside a lesson");
  assert.match(ch, /<div class="callout callout--\w+" role="note">/);
  assert.match(ch, /<progress class="course-progress"[^>]* aria-labelledby="(progress-label-\d\d)"[\s\S]*id="\1"/);
  assert.ok(!/class="table-wrap" tabindex/.test(ch), "tables are not tab stops until they overflow");
  for (const page of ["labs/index.html", "primers/index.html"]) {
    const h = readFileSync(join(root, page), "utf8");
    const mainHtml = h.match(/<main[\s\S]*<\/main>/)[0];
    const firstH2 = mainHtml.indexOf("<h2");
    assert.ok(!/<h3/.test(firstH2 < 0 ? mainHtml : mainHtml.slice(0, firstH2)), `${page}: no h3 straight after the h1`);
    // The link is the card's title only, so its accessible name is short; CSS stretches its hit area.
    assert.match(h, /<div class="card card--link[^"]*"><h2><a href="[^"]+">[^<]+<\/a><\/h2>/);
    assert.ok(!/<a class="card/.test(h), `${page}: no whole-card <a>`);
  }
});

test("primers: diagrams are SVG, not Mermaid source; front-matter checkpoints are rendered", () => {
  const course = JSON.parse(readFileSync(new URL("../../chapters.json", import.meta.url), "utf8"));
  for (const p of course.primers) {
    const h = readFileSync(join(root, `${p.url}index.html`), "utf8");
    assert.ok(!/Mermaid|sequenceDiagram|flowchart (?:TD|LR)/.test(h), `${p.slug}: Mermaid source on the page`);
  }
  const smccc = readFileSync(join(root, "primers/smccc/index.html"), "utf8");
  assert.match(smccc, /<figure class="diagram"><div class="svg-scroll" data-scroll-label="[^"]+"><svg class="minw-\d+[^"]*"/);
  assert.match(smccc, /<div class="checkpoint" id="checkpoint-box">/);
  assert.ok(!/Run this from the repository root/.test(smccc));
});

test("the pre-rendered diagrams are up to date with tools/diagrams.mjs and pass the sanitizer", () => {
  const dir = new URL("../../../docs/diagrams/", import.meta.url);
  for (const name of Object.keys(DIAGRAMS)) {
    const svg = renderDiagram(name);
    assert.equal(readFileSync(new URL(`${name}.svg`, dir), "utf8"), svg, `${name}.svg is stale: run node course/site/tools/diagrams.mjs`);
    assert.doesNotThrow(() => sanitizeSvg(svg, "t"), name);
    assert.ok(/<desc>[^<]{80,}<\/desc>/.test(svg), `${name}: <desc> is a full text version`);
  }
});

test("wide SVGs keep text at 12px or more in the narrowest column", () => {
  const svg = (vw, fs) => `<svg viewBox="0 0 ${vw} 100"><text font-size="${fs}">x</text></svg>`;
  assert.equal(svgMinWidth(svg(300, 14)), 0);
  const w = svgMinWidth(svg(720, 9));
  assert.ok(w * 9 / 720 >= MIN_TEXT_PX && w % 40 === 0, String(w));
  for (const f of walk(root).filter((x) => x.endsWith(".html"))) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(/<svg\b[^>]*role="img"[\s\S]*?<\/svg>/g)) {
      const s = m[0];
      const vb = s.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+)/);
      const sizes = [...s.matchAll(/font-size="([\d.]+)"/g)].map((x) => Number(x[1]));
      if (!vb || !sizes.length) continue;
      const minw = Number((s.match(/class="[^"]*minw-(\d+)/) || [0, NARROWEST])[1]);
      const px = Math.min(...sizes) * Math.max(minw, NARROWEST) / Number(vb[1]);
      assert.ok(px >= MIN_TEXT_PX - 0.01 || minw === 1600, `${f}: text renders at ${px.toFixed(1)}px`);
    }
  }
});

test("internal notation is refused in rendered text, outside code", () => {
  const page = (t) => `<main><p>${t}</p></main>`;
  for (const bad of ["until PLAN M22 runs", "see architecture §14.2", "the CURRICULUM says", "risk K11", "an [U] claim", "spike results #5"]) {
    assert.ok(checkInternalNotation(page(bad)).length > 0, bad);
  }
  for (const ok of ["an Apple M5 Pro", "Apple M1 to M3 report 24 MHz", "UEFI 2.10 §7", "<code>PLAN</code>", "virtio 1.2 §5.2.3"]) {
    assert.deepEqual(checkInternalNotation(page(ok)), [], ok);
  }
});

test("chapters.json values that become paths are validated", () => {
  const good = { chapters: [{ id: "02", url: "a/b/", file: "course/x.md" }], parts: [{ id: "I", slug: "a" }], primers: [{ slug: "elf", url: "primers/elf/", file: "course/primers/elf.md" }], labs: [{ name: "esr-decoder" }] };
  assert.deepEqual(validateCourse(good), []);
  const bad = structuredClone(good);
  bad.chapters[0].url = "../../etc/";
  bad.parts[0].slug = "a/../b";
  bad.primers[0].file = "../secret.md";
  assert.equal(validateCourse(bad).length, 3);
  assert.ok(safeRepoPath("crates/vmm/src/lib.rs"));
  for (const p of ["../x", "/etc/passwd", "a/../../b", ""]) assert.ok(!safeRepoPath(p), p);
});

test("primer covers text reaches pages without author notes", () => {
  assert.equal(coversText("the syscall **at the hardware level** (with a worked example, not only one picture); a register (a surprise for x86-trained readers)."), "the syscall at the hardware level; a register.");
  const html = readFileSync(join(root, "primers/index.html"), "utf8");
  assert.ok(!/\[V\]|\[H\]|\(new\)|v2&#39;s Appendix|\bch\d\d\b/.test(html));
});

test("an absent lab renders a no-JS placeholder; a lesson keeps its own text fallback", () => {
  const all = walk(root).filter((f) => f.endsWith(".html")).map((f) => readFileSync(f, "utf8"));
  const absent = all.find((h) => h.includes("lab--absent"));
  if (absent) assert.match(absent, /This lab is not built yet|This lab is planned/);
});

test("labs: built labs are copied under a hashed directory, tests are not shipped", () => {
  const dir = join(root, res.labsDir);
  if (!existsSync(dir)) return;
  const files = walk(dir);
  assert.ok(!files.some((f) => f.endsWith(".test.mjs")));
  assert.ok(files.every((f) => /\.(mjs|js|css|json|svg)$/.test(f)));
});

test("helpers: display titles, retrieval sources, glossary anchors, banks", () => {
  assert.equal(displayTitle("FreeBSD through U-Boot EFI (SHOULD)"), "FreeBSD through U-Boot EFI");
  assert.equal(displayTitle("vmapple and AVPBooter (capstone, STRETCH)"), "vmapple and AVPBooter (capstone)");
  assert.equal(displayTitle("Snapshots (post-v1)"), "Snapshots");
  // STYLE A.6: chapter 02 draws from 01, then 00, then 01 again (a different item).
  assert.deepEqual(retrievalSources("02", ["00", "01", "02"]), [{ bank: "01", offset: 0 }, { bank: "00", offset: 0 }, { bank: "01", offset: 1 }]);
  assert.deepEqual(retrievalSources("10", ["00", "02", "03", "07", "09"]).map((s) => s.bank), ["09", "07", "03"]);
  assert.deepEqual(retrievalSources("16", ["15", "04", "13"], ["15", "04", "13"]).map((s) => s.bank), ["15", "04", "13"]);
  assert.equal(glossaryAnchor("CPSR / PSTATE"), "cpsr-pstate");
  assert.equal(glossaryAnchor("VM exit"), "vm-exit");
  const g = parseGlossary("## Primers\n\n- **ESR** (Exception Syndrome Register): Why. Taught in `os-basics`.\n## Chapter 02\n- **VM exit**: The moment.\n");
  assert.deepEqual(g.map((x) => [x.term, x.expansion, x.anchor, x.source.kind]), [["ESR", "Exception Syndrome Register", "esr", "primer"], ["VM exit", null, "vm-exit", "chapter"]]);
  assert.deepEqual(parseRetrievalBank("# R\n\n## R1\nQ: one\nmore\nA: two\n"), [{ q: "one more", a: "two" }]);
});

test("every glossary link in the lessons resolves to a glossary entry", () => {
  const g = readFileSync(join(root, "glossary/index.html"), "utf8");
  const ids = new Set([...g.matchAll(/<dt id="([^"]+)"/g)].map((m) => m[1]));
  assert.ok(ids.size > 300);
  for (const f of walk(root).filter((x) => x.endsWith(".html"))) {
    for (const m of readFileSync(f, "utf8").matchAll(/href="\/build-your-own\/vmm\/glossary\/#([^"]+)"/g)) assert.ok(ids.has(m[1]), `${f}: #${m[1]}`);
  }
});

test("contrast tokens meet WCAG AA in both schemes", () => {
  const css = readFileSync(new URL("../src/assets/course.css", import.meta.url), "utf8");
  assert.deepEqual(checkContrast(css), []);
  assert.ok(contrast("#A33F00", "#FBF8F1") > 6);
  assert.deepEqual(checkContrast(css.replace("--muted:#5B616B", "--muted:#C0C0C0")).length > 0, true);
});

test("svg sanitizer refuses scripts, handlers, styles and external references", () => {
  const ok = '<svg viewBox="0 0 10 10"><title>T</title><desc>D</desc><rect width="1" height="1"/></svg>';
  assert.match(sanitizeSvg(ok, "x"), /role="img" aria-labelledby="x-t x-d"/);
  for (const bad of [
    ok.replace("<rect", "<script>alert(1)</script><rect"), ok.replace("<rect", '<rect onload="x()"'), ok.replace("<rect", "<style>r{}</style><rect"),
    ok.replace("<rect", '<rect style="fill:red"'), ok.replace("<rect", '<image href="https://e.org/a.png"/><rect'), ok.replace("<rect", "<foreignObject/><rect"),
    ok.replace("<title>T</title>", ""),
    ok.replace("<rect", '<rect/onclick="alert(1)"'), ok.replace("<rect", '<a href="&#x6A;avascript:x"/><rect'),
    ok.replace("<rect", '<a href="&#106;avascript:x"/><rect'), ok.replace("<rect", '<image href="//e.org/a.png"/><rect'),
  ]) assert.throws(() => sanitizeSvg(bad, "x"), undefined, bad);
});

test("serve.mjs: headers, index resolution, redirects, 404s and no path escape", () => {
  const rules = parseHeaders(readFileSync(join(out, "_headers"), "utf8"));
  assert.equal(headersFor(rules, "/build-your-own/vmm/")["Content-Security-Policy"], CSP);
  assert.match(headersFor(rules, "/build-your-own/vmm/assets/x.css")["Cache-Control"], /immutable/);
  assert.equal(resolvePath(out, "/build-your-own/vmm/").file, join(root, "index.html"));
  assert.deepEqual(resolvePath(out, "/build-your-own/vmm/labs"), { status: 308, location: "/build-your-own/vmm/labs/" });
  // Never an off-site (protocol-relative) redirect, however the path is spelled.
  for (const u of ["//build-your-own", "/%2F%2Fevil.example/../build-your-own/vmm", "///build-your-own/vmm"]) {
    const r = resolvePath(out, u);
    if (r.location) assert.ok(r.location.startsWith("/") && !r.location.startsWith("//"), `${u} -> ${r.location}`);
  }
  assert.equal(resolvePath(out, "/build-your-own/vmm/nope/").file, join(root, "404.html"));
  assert.equal(resolvePath(out, "/build-your-own/vmm/../../../../etc/passwd").status !== 200, true);
  assert.equal(resolvePath(out, "/_headers").file, undefined);
});

test("integration: every built lab is live in every lesson that embeds it, has its page and is on the index", () => {
  const course = JSON.parse(readFileSync(new URL("../../chapters.json", import.meta.url), "utf8"));
  const repo = new URL("../../../", import.meta.url);
  const srcLabs = new URL("../src/labs/", import.meta.url);
  const built = readdirSync(srcLabs).filter((n) => n !== "_shared" && existsSync(new URL(`${n}/view.mjs`, srcLabs)));
  const index = readFileSync(join(root, "labs/index.html"), "utf8");
  const mainGrid = index.split('id="planned"')[0];
  for (const name of built) {
    // The standalone page mounts the real lab, never the placeholder.
    const page = readFileSync(join(root, `labs/${name}/index.html`), "utf8");
    assert.match(page, new RegExp(`<section class="lab" data-lab="${name}" data-id="lab-${name}-1" data-src="[^"]+/${name}/" data-standalone="true"`), name);
    assert.ok(!page.includes("lab--absent"), `${name}: standalone page shows the placeholder`);
    // Its assets are where data-src points.
    for (const f of ["view.mjs", "model.mjs"]) assert.ok(existsSync(join(root, res.labsDir, name, f)), `${name}/${f} not shipped`);
    if (existsSync(new URL(`${name}/style.css`, srcLabs))) assert.ok(page.includes(`${res.labsDir}${name}/style.css`), `${name}: style.css not linked`);
    // Listed with the current labs, not with the planned ones.
    assert.ok(mainGrid.includes(`href="/build-your-own/vmm/labs/${name}/"`), `${name}: missing from the labs index`);
  }
  assert.match(mainGrid, new RegExp(`<p>${built.length} labs, each embedded`));
  // Every :::lab line in a written lesson or primer renders that lab live, once per line.
  let embeds = 0;
  for (const doc of [...course.chapters, ...course.primers]) {
    const file = new URL(doc.file, repo);
    if (!existsSync(file)) continue;
    const md = readFileSync(file, "utf8");
    const names = [...md.matchAll(/^:::lab ([a-z0-9-]+)\s*$/gm)].map((m) => m[1]);
    if (!names.length) continue;
    const html = readFileSync(join(root, `${doc.url}index.html`), "utf8");
    assert.ok(!html.includes("lab--absent"), `${doc.file}: renders a lab placeholder`);
    for (const name of new Set(names)) {
      assert.ok(built.includes(name), `${doc.file}: embeds "${name}", which has no src/labs/${name}/view.mjs`);
      const live = html.match(new RegExp(`<section class="lab" data-lab="${name}" data-id="lab-${name}-\\d+" data-src="[^"]+" data-standalone="false"`, "g")) || [];
      assert.equal(live.length, names.filter((n) => n === name).length, `${doc.file}: ${name}`);
      embeds += live.length;
    }
  }
  assert.ok(embeds >= built.length, `only ${embeds} live embeds for ${built.length} labs`);
  // Labs whose chapters are all planned get a page that says so, and no "not built" warning.
  for (const l of course.labs.filter((l) => !built.includes(l.name))) {
    const page = readFileSync(join(root, `labs/${l.name}/index.html`), "utf8");
    if (l.chapters.every((id) => !existsSync(new URL(course.chapters.find((c) => c.id === id)?.file ?? "x", repo))) && !l.primers.length) {
      assert.match(page, /This lab is planned/);
      assert.ok(!res.warnings.some((w) => w.startsWith(`lab "${l.name}"`)), l.name);
    }
  }
});
