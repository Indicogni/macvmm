#!/usr/bin/env node
// The course site builder (DESIGN.md §10). Zero dependencies: Node built-ins only.
//
//   node course/site/build.mjs            build course/** into course/site/dist/
//   node course/site/build.mjs --check    build, then fail on broken internal links or #anchors,
//                                         missing assets, CSP violations or contrast regressions
//   node course/site/build.mjs --strict   also fail on warnings (a lab not built yet, ...)
//   node course/site/build.mjs --out DIR  write somewhere else (tests use a temp dir)
//
// Output layout mirrors the production URL tree, because the Cloudflare Worker serves static
// assets by request path (DESIGN.md §10.1):
//
//   dist/_headers                                  security headers, CSP 'self' only
//   dist/build-your-own/vmm/index.html             landing
//   dist/build-your-own/vmm/<part>/<chapter>/      lessons      .../primers/<slug>/   primers
//   dist/build-your-own/vmm/labs/<name>/           labs         .../glossary/ .../reference/
//   dist/build-your-own/vmm/assets/                hashed CSS/JS, labs under assets/labs.<hash>/
//   dist/build-your-own/vmm/404.html, sitemap.xml
//
// Every page is inert HTML plus external same-origin modules: no inline script, no inline style,
// no event-handler attributes (the CSP in `_headers` would block them, and checkCsp fails the
// build if one slips in).

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, copyFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join, relative, posix, resolve, basename, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { parseFrontMatter } from "./lib/frontmatter.mjs";
import { esc, fill, badges, minutesLabel, ICONS } from "./lib/html.mjs";
import { highlight, langForFile } from "./lib/highlight.mjs";
import { renderMarkdown, inline, blockLines } from "./lib/md.mjs";
import { resolveAnchor } from "./lib/anchors.mjs";
import { renderCapture, renderTrace } from "./lib/captures.mjs";
import { sanitizeSvg, svgMinWidth, svgMaxWidth, MINW_STEP, MINW_MAX, DIAGRAM_MAX } from "./lib/svg.mjs";
import { checkCsp, checkLinks, checkContrast, checkSize, checkInternalNotation, checkControlBorders } from "./lib/checks.mjs";

const SITE = dirname(fileURLToPath(import.meta.url));
const COURSE = join(SITE, "..");
const REPO = join(COURSE, "..");

/** The production Content-Security-Policy (DESIGN.md §7): same origin only, nothing inline. */
export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; " +
  "worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
  // Trusted Types with no policies: the browser itself refuses every HTML-string or script-URL
  // sink (innerHTML, insertAdjacentHTML, script.src, new Worker(url), ...). No page or lab uses one.
  "require-trusted-types-for 'script'; trusted-types 'none'";

const LAB_FILE_TYPES = /\.(mjs|js|css|json|svg)$/;

// ---------------------------------------------------------------------------------------------
// Small helpers

const read = (p) => readFileSync(p, "utf8");
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const textOnly = (html) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Drop internal status words from a curriculum title: "(SHOULD)", "STRETCH", "(post-v1)". */
export function displayTitle(t) {
  return String(t)
    .replace(/\s*\(([^()]*)\)/g, (m, inner) => {
      const kept = inner.split(",").map((x) => x.trim()).filter((x) => !/^(SHOULD|STRETCH|post-v1)$/i.test(x));
      return kept.length ? ` (${kept.join(", ")})` : "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** How every generated string names a chapter: by its two-digit id, as the prose does (STYLE.md). */
export const chapterLabel = (c) => `Chapter ${c.id}`;

/** chapters.json url/slug values become output paths and hrefs, so they must be plain. */
const SAFE_URL = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*\/$/;
const SAFE_SLUG = /^[a-z0-9-]+$/;
export function validateCourse(course) {
  const bad = [];
  for (const c of course.chapters) {
    if (!/^\d\d$/.test(String(c.id))) bad.push(`chapters.json: chapter id "${c.id}" is not two digits`);
    if (!SAFE_URL.test(c.url || "")) bad.push(`chapters.json: chapter ${c.id} url "${c.url}" is not a plain relative path ending in /`);
    if (c.file && (/(^|\/)\.\.(\/|$)/.test(c.file) || c.file.startsWith("/"))) bad.push(`chapters.json: chapter ${c.id} file "${c.file}" leaves the repository`);
  }
  for (const p of course.parts) if (!SAFE_SLUG.test(p.slug || "")) bad.push(`chapters.json: part ${p.id} slug "${p.slug}" is not plain`);
  for (const p of course.primers) {
    if (!SAFE_SLUG.test(p.slug || "")) bad.push(`chapters.json: primer slug "${p.slug}" is not plain`);
    if (!SAFE_URL.test(p.url || "")) bad.push(`chapters.json: primer ${p.slug} url "${p.url}" is not a plain relative path ending in /`);
    if (p.file && (/(^|\/)\.\.(\/|$)/.test(p.file) || p.file.startsWith("/"))) bad.push(`chapters.json: primer ${p.slug} file "${p.file}" leaves the repository`);
  }
  for (const l of course.labs) if (!SAFE_SLUG.test(l.name || "")) bad.push(`chapters.json: lab name "${l.name}" is not plain`);
  return bad;
}

/** A repo-relative path that stays inside the repository (no "..", not absolute). */
export function safeRepoPath(p) {
  return typeof p === "string" && p !== "" && !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split(/[\\/]/).includes("..");
}

/** Strip author notes from a chapters.json `covers` text: emphasis marks and planning asides. */
export function coversText(s) {
  return String(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s*\((?:[^()]*\b(?:not only|a surprise for|STYLE|CURRICULUM|PLAN|note:)[^()]*)\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const STATUS = {
  should: "Optional chapter",
  stretch: "Stretch goal",
  "post-v1": "Planned",
};

function humanLabName(name) {
  const caps = { esr: "ESR", gpa: "GPA", mmio: "MMIO", dtb: "DTB", pl011: "PL011", smp: "SMP", irq: "IRQ", vmm: "VMM", elf: "ELF", cpio: "cpio", smccc: "SMCCC", a64: "A64", rsp: "RSP", ansi: "ANSI", pstate: "PSTATE", repr: "repr", blk: "blk", vmapple: "vmapple" };
  const words = name.split("-").map((w) => caps[w] || w);
  const s = words.join(" ");
  return /^[a-z]/.test(words[0]) && !caps[name.split("-")[0]] ? s[0].toUpperCase() + s.slice(1) : s;
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function writeOut(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// ---------------------------------------------------------------------------------------------
// Content loading

/** Retrieval bank: course/retrieval/NN.md -> [{ q, a }] (STYLE.md A.6). */
export function parseRetrievalBank(text) {
  const items = [];
  let cur = null, field = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^## R\d+\s*$/.test(line)) { cur = { q: "", a: "" }; items.push(cur); field = null; continue; }
    if (!cur) continue;
    const m = line.match(/^(Q|A):\s*(.*)$/);
    if (m) { field = m[1].toLowerCase(); cur[field] = m[2]; continue; }
    if (field && line.trim() !== "") cur[field] += ` ${line.trim()}`;
  }
  return items.filter((x) => x.q && x.a);
}

/**
 * Choose warm-up sources for chapter `id` (STYLE.md A.6): banks N-1, N-3, N-7; a source with no
 * bank is replaced by the nearest earlier unused chapter; when every earlier bank is used, banks
 * are reused (with a different item). Returns [{ bank, offset }].
 */
export function retrievalSources(id, available, from) {
  const n = Number(id);
  const avail = [...available].map(Number).filter((c) => c < n).sort((a, b) => a - b);
  if (avail.length === 0) return [];
  const targets = from ? from.map(Number) : [n - 1, n - 3, n - 7];
  const used = [];
  for (const t of targets) {
    if (from) { if (avail.includes(t)) used.push(t); continue; }
    const unused = avail.filter((c) => !used.includes(c));
    let pick;
    if (avail.includes(t) && !used.includes(t)) pick = t;
    else if (unused.length) {
      const earlier = unused.filter((c) => c <= t);
      pick = earlier.length ? earlier.at(-1) : unused.reduce((best, c) => (Math.abs(c - t) < Math.abs(best - t) ? c : best));
    } else pick = used[used.length % Math.max(1, new Set(used).size)] ?? avail.at(-1);
    used.push(pick);
  }
  const seen = new Map();
  return used.map((b) => {
    const k = seen.get(b) || 0;
    seen.set(b, k + 1);
    return { bank: String(b).padStart(2, "0"), offset: k };
  });
}

/** Glossary: course/GLOSSARY.md -> [{ term, expansion, def, anchor, source }] sorted by term. */
export function parseGlossary(text) {
  const out = [];
  let source = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const h = line.match(/^## (Primers|Chapter (\d\d))\s*$/);
    if (h) { source = h[2] ? { kind: "chapter", id: h[2] } : { kind: "primers" }; continue; }
    if (!source) continue;
    const m = line.match(/^- \*\*(.+?)\*\*(?:\s*\(((?:[^()]|\([^()]*\))*)\))?:\s*(.+)$/);
    if (!m) continue;
    const [, term, expansion, def] = m;
    const anchor = glossaryAnchor(term);
    let src = source;
    const taught = def.match(/Taught in `([a-z0-9-]+)`\.?\s*$/);
    if (source.kind === "primers" && taught) src = { kind: "primer", slug: taught[1] };
    out.push({ term, expansion: expansion || null, def, anchor, source: src });
  }
  return out.sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));
}

export function glossaryAnchor(term) {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadLabs(problems, warnings) {
  const dir = join(SITE, "src", "labs");
  const labs = new Map();
  if (!existsSync(dir)) return labs;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name.startsWith(".") || !statSync(p).isDirectory()) continue;
    // The directory name becomes part of hrefs, ids and data-src attributes: keep it plain.
    if (name !== "_shared" && !SAFE_SLUG.test(name)) { problems.push(`src/labs/${name}: lab directory names must match ${SAFE_SLUG} (they become URLs and ids)`); continue; }
    const files = walkFiles(p).map((f) => relative(p, f).split("\\").join("/"));
    const shipped = files.filter((f) => !f.endsWith(".test.mjs"));
    for (const f of shipped) if (!LAB_FILE_TYPES.test(f)) problems.push(`src/labs/${name}/${f}: file type not allowed in a lab (LABS.md section 1)`);
    if (name === "_shared") { labs.set(name, { name, dir: p, files: shipped, shared: true }); continue; }
    const hasView = files.includes("view.mjs");
    if (hasView && !files.includes("model.mjs")) problems.push(`src/labs/${name}: view.mjs without model.mjs (LABS.md section 1)`);
    let meta = {};
    if (files.includes("lab.json")) {
      try { meta = JSON.parse(read(join(p, "lab.json"))); } catch (e) { problems.push(`src/labs/${name}/lab.json: ${e.message}`); }
    }
    for (const f of shipped.filter((x) => /\.(mjs|js)$/.test(x))) {
      const src = read(join(p, f));
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\'"`])\/\/.*$/gm, "$1");
      const bad = [
        [/\beval\s*\(/, "eval("], [/\bnew\s+Function\b/, "new Function"],
        // Absolute URLs could reach the network. Hosts under the reserved .invalid/.example/.test
        // names (RFC 2606) cannot resolve, so sample data such as an OSC 8 link may use them.
        [/https?:\/\/(?![a-z0-9.-]*\.(?:invalid|example|test)(?=[\/:"'`\s\\]|$))/i, "an absolute http(s):// URL"],
        // The CSP enforces Trusted Types with no policy, so every HTML-string sink throws in the
        // browser, even `innerHTML = ""`; fail the build first, with a clearer message.
        [/\.(?:innerHTML|outerHTML)\s*\+?=|\binsertAdjacentHTML\s*\(|\bcreateContextualFragment\s*\(|\.srcdoc\s*=/, "an HTML-string sink (innerHTML, outerHTML, insertAdjacentHTML, srcdoc; blocked by Trusted Types)"],
        [/\bnew\s+(?:Shared)?Worker\s*\(/, "new Worker(...) (blocked by Trusted Types; ask the lead first)"],
        [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, "a string timer"],
        [/\bdocument\.write\b/, "document.write"], [/\bWebAssembly\b/, "WebAssembly"], [/\bimportScripts\b/, "importScripts"],
        [/\bsetAttribute\s*\(\s*["']style["']/, "setAttribute('style', ...) (blocked by the CSP; use classes or el.style.prop)"],
        [/\bsetAttribute\s*\(\s*["']on[a-z]+["']/, "an on* attribute"],
      ];
      for (const [re, what] of bad) if (re.test(code)) problems.push(`src/labs/${name}/${f}: shipped lab code contains ${what} (LABS.md section 4)`);
    }
    if (hasView && !/export\s+(?:async\s+)?function\s+mount\b/.test(read(join(p, "view.mjs")))) {
      problems.push(`src/labs/${name}/view.mjs: no "export function mount" (LABS.md section 2)`);
    }
    if (files.includes("style.css")) {
      const css = read(join(p, "style.css")).replace(/\/\*[\s\S]*?\*\//g, "");
      problems.push(...checkControlBorders(css, `src/labs/${name}/style.css`));
      const scope = `.lab[data-lab="${name}"]`;
      for (const m of css.matchAll(/(^|})\s*([^{}@]+?)\s*\{/g)) {
        const sels = m[2].split(",").map((s) => s.trim()).filter(Boolean);
        for (const s of sels) if (!s.startsWith(scope) && !/^(from|to|\d+%)$/.test(s)) warnings.push(`src/labs/${name}/style.css: selector "${s}" is not scoped under ${scope}`);
      }
      if (/\bimport\b|url\(\s*["']?(?:https?:|\/\/)/.test(css)) problems.push(`src/labs/${name}/style.css: no @import or external url() (LABS.md section 4)`);
    }
    let fallback = null;
    if (files.includes("fallback.svg")) {
      try { sanitizeSvg(read(join(p, "fallback.svg")), "probe"); fallback = read(join(p, "fallback.svg")); }
      catch (e) { problems.push(`src/labs/${name}/fallback.svg: ${e.message}`); }
    }
    labs.set(name, {
      name, dir: p, files: shipped, built: hasView && files.includes("model.mjs"),
      title: typeof meta.title === "string" ? meta.title : humanLabName(name),
      goal: typeof meta.goal === "string" ? meta.goal : null,
      css: files.includes("style.css"), fallback,
    });
  }
  return labs;
}

// ---------------------------------------------------------------------------------------------
// The build

/** Written into every build tree, so a later build knows the directory is safe to replace. */
export const BUILD_MARKER = ".macvmm-site-build";

/** True when `dir` holds an earlier build (our marker, or the `_headers` + build-your-own/ shape). */
function looksLikeBuild(dir) {
  if (existsSync(join(dir, BUILD_MARKER))) return true;
  return existsSync(join(dir, "_headers")) && existsSync(join(dir, "build-your-own")) && statSync(join(dir, "build-your-own")).isDirectory();
}

/**
 * Resolve `--out` and decide whether the builder may delete and replace it. The output directory
 * is wiped on every successful build, so a typo such as `--out .` or `--out ~` must be refused,
 * not obeyed. Returns { finalOut, out } (out = the sibling staging tree) or throws.
 */
export function resolveOutDirs(requested, { cwd = process.cwd(), home = homedir(), repo = REPO } = {}) {
  let abs = resolve(cwd, requested || join(SITE, "dist"));
  while (abs.length > 1 && abs.endsWith(sep)) abs = abs.slice(0, -1);
  const parent = dirname(abs);
  if (abs === parent) throw new Error(`--out ${requested}: refusing to use the filesystem root as the output directory`);
  // Neither the directory itself nor anything that contains it may be one we must never wipe.
  const protectedDirs = [resolve(cwd), resolve(home), resolve(repo), resolve(SITE), resolve(COURSE)];
  for (const d of protectedDirs) {
    if (abs === d || d.startsWith(abs + sep)) throw new Error(`--out ${requested}: refusing to replace ${abs}, which is or contains ${d}`);
  }
  const out = join(parent, `${basename(abs)}.partial`);
  for (const [dir, what] of [[abs, "output"], [out, "staging"]]) {
    if (!existsSync(dir)) continue;
    if (!statSync(dir).isDirectory()) throw new Error(`--out ${requested}: the ${what} path ${dir} exists and is not a directory`);
    if (readdirSync(dir).length && !looksLikeBuild(dir) && !existsSync(join(dir, "BUILD-FAILED.txt"))) {
      throw new Error(`--out ${requested}: ${dir} is not empty and is not an earlier site build (no ${BUILD_MARKER}); refusing to delete it`);
    }
  }
  return { finalOut: abs, out };
}

export function build(opts = {}) {
  // Build into a sibling directory and move it over the real output only when the build passed,
  // so a failed build never leaves a complete-looking dist/ that someone could deploy.
  const { finalOut, out } = resolveOutDirs(opts.out);
  const strict = Boolean(opts.strict);
  const problems = [];
  const warnings = [];
  const log = opts.quiet ? () => {} : (s) => console.log(s);

  const course = JSON.parse(read(join(COURSE, "chapters.json")));
  problems.push(...validateCourse(course));
  const C = course.course;
  const BASE = C.base; // "/build-your-own/vmm/"
  const ORIGIN = C.origin;
  const year = String(opts.year || new Date().getUTCFullYear());
  const root = join(out, ...BASE.split("/").filter(Boolean));

  rmSync(out, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(out, BUILD_MARKER), "Generated by course/site/build.mjs. The builder deletes and replaces this directory on every build.\n");

  // ---- assets ------------------------------------------------------------------------------
  // min-width classes for wide inline SVGs (see svgClass below), generated so the CSS and the
  // builder can never disagree about which widths exist.
  let minw = "\n/* Generated by build.mjs: min-width steps for wide inline SVGs and max-width steps for narrow diagrams (DESIGN.md section 3.6). */\n";
  for (let w = MINW_STEP * 8; w <= MINW_MAX; w += MINW_STEP) minw += `.minw-${w}{min-width:${w}px}${w < DIAGRAM_MAX ? `svg.maxw-${w}{max-width:${w}px}` : ""}`;
  const css = minifyCss(read(join(SITE, "src", "assets", "course.css")) + minw) + "\n";
  const cssName = `assets/course.${hash(css)}.css`;
  const js = read(join(SITE, "src", "assets", "course.js"));
  const jsName = `assets/course.${hash(js)}.js`;
  const labsJs = read(join(SITE, "src", "assets", "labs.js")).replace('from "./course.js"', `from "./${posix.basename(jsName)}"`);
  const labsJsName = `assets/labs.${hash(labsJs)}.js`;
  writeOut(join(root, cssName), css);
  writeOut(join(root, jsName), js);
  writeOut(join(root, labsJsName), labsJs);
  problems.push(...checkContrast(css));

  const labs = loadLabs(problems, warnings);
  const labTreeHash = hash([...labs.values()].flatMap((l) => l.files.map((f) => `${l.name}/${f}\n${read(join(l.dir, f))}`)).join("\n"));
  const labsDir = `assets/labs.${labTreeHash}/`;
  for (const l of labs.values()) for (const f of l.files) {
    mkdirSync(dirname(join(root, labsDir, l.name, f)), { recursive: true });
    copyFileSync(join(l.dir, f), join(root, labsDir, l.name, f));
  }

  // ---- model -------------------------------------------------------------------------------
  const url = (p = "") => BASE + p;
  const chapters = course.chapters.map((ch) => {
    const path = join(REPO, ch.file);
    const exists = existsSync(path);
    let fm = null;
    if (exists) {
      try { fm = parseFrontMatter(read(path)); } catch (e) { problems.push(`${ch.file}: ${e.message}`); }
    }
    return { ...ch, exists: exists && fm !== null, fm, href: url(ch.url), display: displayTitle(ch.title) };
  });
  const byId = new Map(chapters.map((c) => [c.id, c]));
  const written = chapters.filter((c) => c.exists);
  const parts = course.parts.map((p) => ({ ...p, href: url(`${p.slug}/`), chapters: p.chapters.map((id) => byId.get(id)) }));
  const partOf = new Map(parts.flatMap((p) => p.chapters.map((c) => [c.id, p])));
  const primers = course.primers.map((p) => ({ ...p, href: url(p.url) }));
  const primerSlugs = new Set(primers.map((p) => p.slug));
  const labMeta = new Map(course.labs.map((l) => [l.name, l]));
  /** Not built, and every chapter that would embed it is still planned (no primer embeds it). */
  const labPlanned = (name) => {
    const m = labMeta.get(name);
    return Boolean(m) && !labs.get(name)?.built && !(m.primers || []).length && m.chapters.every((id) => !byId.get(id)?.exists);
  };
  const allLabNames = [...new Set([...course.labs.map((l) => l.name), ...[...labs.keys()].filter((n) => n !== "_shared")])];

  const banks = new Map();
  for (const f of existsSync(join(COURSE, "retrieval")) ? readdirSync(join(COURSE, "retrieval")) : []) {
    const m = f.match(/^(\d\d)\.md$/);
    if (m) banks.set(m[1], parseRetrievalBank(read(join(COURSE, "retrieval", f))));
  }
  const glossary = parseGlossary(read(join(COURSE, "GLOSSARY.md")));

  const fileCache = new Map();
  const repoRead = (p) => {
    if (!safeRepoPath(p)) throw new Error(`${p}: not a repository-relative path (no "..", not absolute)`);
    if (!fileCache.has(p)) {
      const f = join(REPO, p);
      fileCache.set(p, existsSync(f) && statSync(f).isFile() ? read(f) : null);
    }
    return fileCache.get(p);
  };

  // Reference tags (`start_tag: ch-01`) are shown only when the tag exists in this repository.
  const tagCache = new Map();
  const missingTags = new Set();
  const tagExists = (tag) => {
    if (!/^[A-Za-z0-9._-]+$/.test(tag)) return false;
    if (!tagCache.has(tag)) {
      let ok = false;
      try { execFileSync("git", ["-C", REPO, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { stdio: "ignore" }); ok = true; } catch { ok = false; }
      tagCache.set(tag, ok);
      if (!ok) missingTags.add(tag);
    }
    return tagCache.get(tag);
  };

  // ---- page chrome -------------------------------------------------------------------------
  const layout = read(join(SITE, "src", "templates", "layout.html"));
  const pages = [];

  // aria-current="page" only on the link to the page being rendered; the link to the section the
  // page belongs to gets aria-current="true" (styled the same), so a screen reader never calls the
  // course home "the current page" while a lesson is open.
  function topnav(section, here) {
    const items = [["course", "Course", url()], ["primers", "Primers", url("primers/")], ["labs", "Labs", url("labs/")], ["glossary", "Glossary", url("glossary/")], ["reference", "Reference", url("reference/")]];
    const wide = new Set(["primers", "glossary"]); // hidden from the header on a phone (footer and drawer keep them)
    return items.map(([k, label, href]) => `<li${wide.has(k) ? ' class="nav--wide"' : ""}><a href="${href}"${href === here ? ' aria-current="page"' : k === section ? ' aria-current="true"' : ""}>${label}</a></li>`).join("");
  }

  function page(path, { title, description, body, section = "course", bodyClass = "", labsUsed = [], noindex = false, skipLabel = "Skip to content", inSitemap = true, canonical = true }) {
    const labCss = [...new Set(labsUsed)].filter((n) => labs.get(n)?.built && labs.get(n).css)
      .map((n) => `<link rel="stylesheet" href="${url(`${labsDir}${n}/style.css`)}">\n`).join("");
    const needsLabJs = labsUsed.some((n) => labs.get(n)?.built);
    const html = fill(layout, {
      title: esc(title), ogTitle: esc(title), description: esc(description),
      canonicalLink: canonical ? `<link rel="canonical" href="${esc(ORIGIN + url(path))}">\n` : "",
      ogUrl: canonical ? `<meta property="og:url" content="${esc(ORIGIN + url(path))}">\n` : "",
      robots: noindex ? '<meta name="robots" content="noindex">\n' : "",
      css: url(cssName), js: url(jsName), headExtra: labCss,
      scriptsExtra: needsLabJs ? `<script type="module" src="${url(labsJsName)}"></script>\n` : "",
      bodyClass, skipLabel, base: url(), topnav: topnav(section, path.endsWith(".html") ? null : url(path)), body, year, email: esc(C.email), repo: esc(C.repo),
    }, "layout.html");
    const file = path.endsWith(".html") ? join(root, path) : join(root, path, "index.html");
    writeOut(file, html);
    problems.push(...checkCsp(html, "/" + relative(out, file)));
    problems.push(...checkInternalNotation(html, "/" + relative(out, file)));
    pages.push({ path, inSitemap: inSitemap && !noindex });
  }

  function coursenav(current, mode, openPart) {
    let h = "";
    if (mode === "primers") {
      h += `<p class="navgroup">Primers</p><ul>`;
      for (const p of primers) h += `<li><a href="${p.href}"${p.slug === current ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`;
      h += `</ul><p class="navgroup">Course</p><ul><li><a href="${url()}">All parts and chapters</a></li></ul>`;
      return h;
    }
    const curPart = current ? partOf.get(current) : null;
    const openId = openPart ?? curPart?.id;
    for (const p of parts) {
      const open = p.id === openId;
      h += `<details${open ? " open" : ""}><summary><span class="num">Part ${esc(p.id)}</span> ${esc(p.title)}</summary><ol>`;
      for (const c of p.chapters) {
        const cur = c.id === current ? ' aria-current="page"' : "";
        h += `<li><a href="${c.href}" data-chapter-link="${c.id}"${cur}><span class="num">${esc(c.id)}</span><span class="${c.exists ? "" : "planned"}">${esc(c.display)}${c.exists ? "" : " (planned)"}</span></a></li>`;
      }
      h += `</ol></details>`;
    }
    h += `<p class="navgroup">Also</p><ul><li><a href="${url("primers/")}">Primers</a></li><li><a href="${url("labs/")}">Labs</a></li><li><a href="${url("glossary/")}">Glossary</a></li></ul>`;
    return h;
  }

  function shell(mainHtml, { current, mode, openPart, onpage = [] }) {
    const nav = coursenav(current, mode, openPart);
    const op = onpage.length
      ? `<nav class="onpage" aria-label="On this page"><h2>On this page</h2><ol>${onpage.map((x) => `<li><a href="#${x.id}">${esc(x.text)}</a></li>`).join("")}</ol></nav>`
      : "";
    return (
      `<div class="shell${op ? " has-onpage" : ""}">` +
      `<details class="toc-drawer"><summary>Contents</summary><nav class="coursenav" aria-label="Course contents">${nav}</nav></details>` +
      `<div class="sidebar"><nav class="coursenav" aria-label="Course contents">${nav}</nav></div>` +
      mainHtml + op + `</div>`
    );
  }

  // ---- directive hooks ---------------------------------------------------------------------
  function codeHook({ anchor, file }) {
    if (!safeRepoPath(file)) throw new Error(`:::code file=${file}: must be a repository-relative path (no "..", not absolute)`);
    const r = resolveAnchor(file, anchor, repoRead);
    let n = r.startLine;
    // Line numbers are the real file's: the anchor body is contiguous apart from dropped nested
    // marker lines, so number from the source and skip marker lines.
    const srcLines = repoRead(file).replace(/\r\n/g, "\n").split("\n");
    const numbers = [];
    for (let i = r.startLine; i <= r.endLine && numbers.length < r.body.split("\n").length; i++) {
      if (/^\s*(?:\/\/|#|\/\*|<!--)\s*(?:ANCHOR|LEARNER)(?:_END)?:/.test(srcLines[i - 1] || "")) continue;
      numbers.push(i);
    }
    const lines = blockLines(highlight(r.body, langForFile(file))).replace(/<span class="line/g, () => `<span data-n="${numbers.shift() ?? n++}" class="line`);
    const gh = esc(file);
    return (
      `<figure class="code code--numbered" data-lang="${esc(langForFile(file))}">` +
      `<figcaption><span class="path" title="${gh}">${gh}</span><span class="range">${r.startLine === r.endLine ? `line ${r.startLine}` : `lines ${r.startLine}-${r.endLine}`}</span>` +
      `<button class="copy" type="button" aria-label="Copy code: ${gh}">Copy</button></figcaption>` +
      `<pre tabindex="0" data-scroll-label="Code: ${gh}"><code>${lines}</code></pre></figure>\n`
    );
  }

  function termHook({ source }) {
    if (!/^captures\/\d\d-[a-z0-9-]+(?:\.txt|\.trace\.jsonl)$/.test(source)) {
      throw new Error(`:::term source=${source}: must name captures/NN-name.txt or captures/NN-name.trace.jsonl`);
    }
    const p = join(COURSE, source);
    if (!existsSync(p)) throw new Error(`:::term source=${source}: no such capture`);
    if (source.endsWith(".trace.jsonl")) {
      const run = source.replace(/\.trace\.jsonl$/, ".txt");
      const runText = existsSync(join(COURSE, run)) ? read(join(COURSE, run)) : null;
      return renderTrace(read(p), `course/${source}`, runText ? `course/${run}` : null, runText) + "\n";
    }
    return renderCapture(read(p), `course/${source}`) + "\n";
  }

  function labShell(name, n, { standalone = false, headingLevel = 3, titleId = null } = {}) {
    const l = labs.get(name);
    const meta = labMeta.get(name);
    const id = `lab-${name}-${n}`;
    const title = l?.title || humanLabName(name);
    const tid = titleId || `${id}-title`;
    const goal = l?.goal ? `<p class="lab__goal">${esc(l.goal)}</p>` : "";
    const head = standalone
      ? `<header class="lab__head">${goal}${badges("browser")}</header>` // the page header already says "Lab"
      : `<header class="lab__head"><span class="tag">Lab</span><h${headingLevel} id="${tid}">${esc(title)}</h${headingLevel}>${goal}${badges("browser")}<a href="${url(`labs/${name}/`)}">Open full page<span class="visually-hidden">: ${esc(title)}</span></a></header>`;
    if (!l || !l.built) {
      // A lab whose chapters are all still planned (a post-v1 lab) only has its standalone page,
      // like a planned chapter: say so plainly, and do not warn, since no written page embeds it.
      if (standalone && labPlanned(name)) {
        const cs = meta.chapters.map((c) => byId.get(c)).filter(Boolean);
        const text = `This lab is planned${cs.length ? ` for ${cs.map((c) => `<a href="${c.href}">${chapterLabel(c)}</a>`).join(", ")}, which is not written yet` : ""}.`;
        return `<section class="lab lab--absent lab--planned" data-lab="${esc(name)}" aria-labelledby="${tid}">${head}<div class="lab__fallback"><p>${text}</p></div></section>\n`;
      }
      if (strict) problems.push(`lab "${name}" is not built yet (no src/labs/${name}/view.mjs)`);
      else warnings.push(`lab "${name}" is not built yet; rendering its placeholder`);
      const where = standalone && meta ? meta.chapters.map((c) => byId.get(c)).filter(Boolean) : [];
      const text = standalone
        ? `This lab is not built yet.${where.length ? ` ${where.map((c) => `<a href="${c.href}">${chapterLabel(c)}</a>`).join(", ")} describes what it shows, in text and captured runs.` : ""}`
        : "This lab is not built yet. The text that follows describes what it shows, so you can keep going without it.";
      return `<section class="lab lab--absent" data-lab="${esc(name)}" aria-labelledby="${tid}">${head}<div class="lab__fallback"><p>${text}</p></div></section>\n`;
    }
    const fallback = l.fallback ? scrollSvg(sanitizeSvg(l.fallback, `${id}-fb`), `${title}: static picture`) : `<p>Loading the lab. If nothing appears, your browser may have JavaScript turned off or the lab failed to load.</p>`;
    return (
      `<section class="lab" data-lab="${esc(name)}" data-id="${id}" data-src="${url(`${labsDir}${name}/`)}" data-standalone="${standalone}" aria-labelledby="${tid}">` +
      head +
      `<div class="lab__fallback">${fallback}</div>` +
      `<noscript><p>This lab needs JavaScript. Everything else on this page works without it.</p></noscript>` +
      `<div class="lab__root"></div></section>\n`
    );
  }

  function retrievalHook(ch, args) {
    const from = args.from ? args.from.split(",").map((s) => s.trim()).filter(Boolean) : null;
    if (from) for (const f of from) if (!banks.has(f)) throw new Error(`:::retrieval from=${args.from}: no bank course/retrieval/${f}.md`);
    const sources = retrievalSources(ch.id, banks.keys(), from);
    if (!sources.length) throw new Error(":::retrieval: no earlier retrieval bank to draw from");
    let h = `<div class="box box--retrieval"><p class="box__title">${ICONS.question}<span>Warm-up: three questions from earlier chapters</span></p>` +
      `<p class="box__lead">Answer each one in your head or on paper before you open its answer. They change on each visit.</p>` +
      `<ol class="retrieval" data-chapter="${ch.id}">`;
    for (const { bank, offset } of sources) {
      const items = banks.get(bank);
      const src = byId.get(bank);
      const pick = items.length ? offset % items.length : 0;
      h += `<li class="retrieval__slot" data-offset="${pick}">`;
      items.forEach((it, k) => {
        h += `<div class="retrieval__item"${k === pick ? "" : " hidden"}>` +
          `<p class="retrieval__from">From chapter ${esc(bank)}${src ? `: <a href="${src.href}">${esc(src.display)}</a>` : ""}</p>` +
          `<p>${inline(it.q)}</p><details><summary>Show answer</summary><p>${inline(it.a)}</p></details></div>`;
      });
      h += `</li>`;
    }
    return h + `</ol></div>\n`;
  }

  function checkpointHook(fm, id) {
    if (!fm.command || !fm.expect) throw new Error(":::checkpoint needs command: and expect: in the front matter");
    const runs = String(fm.runs || "mac");
    return (
      `<div class="checkpoint" id="checkpoint-box"><div class="checkpoint__head"><p class="box__title">${ICONS.check}<span>Checkpoint</span></p>${badges(runs.includes("mac") ? "mac" : "browser")}</div>` +
      // Chapter checkpoints run repo scripts; a primer's checkpoint is a one-liner that runs anywhere.
      (id ? `<p>Run this from the repository root:</p>` : "") +
      `<div class="cmdline"><pre data-scroll-label="Checkpoint command"><code><span class="cmd"><span class="prompt" aria-hidden="true">$ </span>${esc(fm.command)}</span></code></pre>` +
      `<button class="copy" type="button" data-copy="cmd" aria-label="Copy the checkpoint command">Copy</button></div>` +
      `<p>You should see, as the last line:</p><pre data-scroll-label="Expected output"><code>${esc(fm.expect)}</code></pre>` +
      (id ? `<p><label hidden><input type="checkbox" class="checkpoint-seen" data-chapter="${id}"> I saw this output (stored only in this browser)</label></p>` : "") +
      `</div>\n`
    );
  }

  function diagramHook({ src, alt }, n) {
    if (src.includes("..") || !src.endsWith(".svg")) throw new Error(`:::diagram src=${src}: must be a repo-relative .svg`);
    const text = repoRead(src);
    if (text == null) throw new Error(`:::diagram src=${src}: no such file`);
    let svg = sanitizeSvg(text, `fig-${n}`, { alt });
    const maxw = svgMaxWidth(svg);
    if (maxw) svg = /^<svg\b[^>]*\sclass="/.test(svg) ? svg.replace(/^(<svg\b[^>]*\sclass=")/, `$1maxw-${maxw} `) : svg.replace(/^<svg\b/, `<svg class="maxw-${maxw}"`);
    return `<figure class="diagram">${scrollSvg(svg, `Diagram: ${alt}`)}<figcaption>${esc(alt)}</figcaption></figure>\n`;
  }

  /**
   * Keep SVG text at 12px or more in the narrowest column (DESIGN.md section 3.6): a wide SVG gets
   * a min-width class inside a horizontally scrollable wrapper. course.js makes the wrapper a
   * focusable, named region only when it actually overflows.
   */
  function scrollSvg(svg, label) {
    const w = svgMinWidth(svg);
    if (!w) return svg;
    return `<div class="svg-scroll" data-scroll-label="${esc(label)}">${svg.replace(/^<svg\b/, `<svg class="minw-${w}"`).replace(/^<svg class="(minw-\d+)"([^>]*?)\sclass="([^"]*)"/, '<svg class="$1 $3"$2')}</div>`;
  }

  function render(body, bodyLine, file, extra) {
    let labN = 0, figN = 0;
    const hooks = {
      code: codeHook,
      term: termHook,
      lab: (name) => { extra.labsUsed.push(name); return labShell(name, ++labN); },
      diagram: (a) => diagramHook(a, ++figN),
      primerSlugs, primerUrl: (s) => url(`primers/${s}/`),
      ...extra.hooks,
    };
    const r = renderMarkdown(body, { file, startLine: bodyLine, hooks, ...extra.md });
    warnings.push(...r.warnings);
    return r;
  }

  // ---- lessons -----------------------------------------------------------------------------
  const order = written; // prev/next follows the written chapters in curriculum order
  for (const ch of chapters) {
    const part = partOf.get(ch.id);
    const statusBadge = STATUS[ch.status] ? `<span class="badge badge--status">${STATUS[ch.status]}</span>` : "";
    if (!ch.exists) {
      const main = `<main id="main" class="lesson"><header class="lesson__head"><p class="tag">${chapterLabel(ch)} · Part ${esc(part.id)}</p><h1>${esc(ch.display)}</h1>` +
        `<div class="meta-row">${badges(ch.runs)} ${statusBadge}</div></header><div class="prose"><p>This chapter is planned but not written yet. ` +
        `The chapters before it stand on their own; nothing earlier depends on it.</p><p><a href="${url()}">Back to all chapters</a></p></div></main>`;
      page(ch.url, { title: `${ch.id} ${ch.display} · ${C.short_title}`, description: `Planned chapter of ${C.title}.`, body: shell(main, { current: ch.id }), noindex: true, skipLabel: "Skip to lesson" });
      continue;
    }
    const { data: fm, body, bodyLine } = ch.fm;
    const file = ch.file;
    for (const [k, v] of [["title", ch.title], ["id", ch.id]]) if (String(fm[k]) !== String(v)) problems.push(`${file}: front matter ${k} "${fm[k]}" differs from chapters.json "${v}"`);
    const extra = {
      labsUsed: [],
      md: { minHeading: 2, maxHeading: 3, reservedIds: ["main", "live", "checkpoint-box"] },
      hooks: {
        retrieval: (a) => retrievalHook(ch, a),
        checkpoint: () => checkpointHook(fm, ch.id),
        conceptsHead: () => {
          const pre = (fm.prereqs || []).map((p) => byId.get(String(p).padStart(2, "0"))).filter(Boolean);
          const bits = [];
          if (pre.length) bits.push(`Chapters before this one: ${pre.map((c) => `chapter ${esc(c.id)}, <a href="${c.href}">${esc(c.display)}</a>`).join("; ")}.`);
          if (fm.start_tag && String(fm.start_tag) !== "none" && tagExists(String(fm.start_tag))) bits.push(`Reference starting point: <code>${esc(fm.start_tag)}</code>, the reference code as it stands at the end of the previous chapter.`);
          return bits.length ? `<p class="box__lead">${bits.join(" ")}</p>\n` : "";
        },
      },
    };
    let r;
    try { r = render(body, bodyLine, file, extra); } catch (e) { problems.push(e.message); continue; }
    const c = r.counts;
    const need = (cond, msg) => { if (!cond) problems.push(`${file}: ${msg}`); };
    need(c.objectives === 1, "needs exactly one :::objectives");
    need(c.checkpoint === 1, "needs exactly one :::checkpoint");
    need(c.concepts === 1 || c.prereqs === 1, "needs a :::concepts (or :::prereqs) box");
    need(ch.id === "00" || c.retrieval === 1, "needs :::retrieval (every chapter after 00)");
    need(Number(ch.id) < 2 || (c.predict || 0) >= 1, "needs at least one :::predict from Part I on");
    need(fm.command && fm.expect, "front matter needs command: and expect:");

    const idx = order.indexOf(ch);
    const prev = order[idx - 1], next = order[idx + 1];
    const pos = written.indexOf(ch) + 1;
    const labLinks = (fm.labs || []).map((n) => `<a href="${url(`labs/${n}/`)}">Lab: ${esc(labs.get(n)?.title || humanLabName(n))}</a>`).join(" · ");
    const predictTools = (c.predict || 0) >= 2 ? `<div class="predict-tools" hidden><button class="btn" type="button">Show all answers</button></div>` : "";
    const main =
      `<main id="main" class="lesson"><header class="lesson__head">` +
      `<p class="tag">${chapterLabel(ch)} · Part ${esc(part.id)}</p><h1>${esc(ch.display)}</h1>` +
      `<div class="meta-row">${badges(fm.runs || ch.runs)} <span>${ICONS.clock} ${esc(minutesLabel(Number(fm.minutes || ch.minutes)))}</span> ${statusBadge}${labLinks ? ` <span>${labLinks}</span>` : ""}</div>` +
      `<progress class="course-progress" max="${written.length}" value="${pos}" aria-labelledby="progress-label-${ch.id}">${pos} of ${written.length}</progress>` +
      `<p class="progress-label" id="progress-label-${ch.id}">Course progress: chapter ${esc(ch.id)} is ${pos} of the ${written.length} chapters written so far (numbering starts at 00)</p>` +
      `</header>${predictTools}<div class="prose">${r.html}</div>` +
      `<div class="lesson__done"><button class="btn mark-done" type="button" data-chapter="${ch.id}" aria-pressed="false" hidden>Chapter complete</button><span>Progress is stored only in this browser.</span></div>` +
      `<nav class="pager" aria-label="Previous and next chapter">` +
      (prev ? `<a class="prev" href="${prev.href}"><span class="dir">Previous</span>${esc(prev.id)} ${esc(prev.display)}</a>` : "") +
      (next ? `<a class="next" href="${next.href}"><span class="dir">Next</span>${esc(next.id)} ${esc(next.display)}</a>` : "") +
      `</nav></main>`;
    const desc = textOnly(inline(`Chapter ${ch.id} of ${C.title}: ${ch.display}.`));
    page(ch.url, {
      title: `${ch.id} ${ch.display} · ${C.short_title}`, description: desc,
      body: shell(main, { current: ch.id, onpage: r.headings.filter((h) => h.level === 2) }),
      labsUsed: extra.labsUsed, skipLabel: "Skip to lesson",
    });
  }

  // ---- part pages --------------------------------------------------------------------------
  const chapterRow = (c) =>
    `<li><a href="${c.href}" data-chapter-link="${c.id}"><span class="num">${esc(c.id)}</span><span class="title">${esc(c.display)}${c.exists ? "" : " (planned)"}</span>` +
    `<span class="meta-row">${badges(c.runs)} <span>${esc(minutesLabel(c.minutes))}</span>${STATUS[c.status] ? ` <span class="badge badge--status">${STATUS[c.status]}</span>` : ""}</span></a></li>`;
  for (const p of parts) {
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">Part ${esc(p.id)}</p><h1>${esc(p.title)}</h1></header>` +
      `<ol class="chapters">${p.chapters.map(chapterRow).join("")}</ol></main>`;
    page(`${p.slug}/`, { title: `Part ${p.id}: ${p.title} · ${C.short_title}`, description: `Part ${p.id} of ${C.title}: ${p.title}.`, body: shell(main, { openPart: p.id }) });
  }

  // ---- primers -----------------------------------------------------------------------------
  primers.forEach((p, k) => {
    const file = join(REPO, p.file);
    if (!existsSync(file)) { problems.push(`${p.file}: missing`); return; }
    let fmr;
    try { fmr = parseFrontMatter(read(file)); } catch (e) { problems.push(`${p.file}: ${e.message}`); return; }
    const { data: fm, body, bodyLine } = fmr;
    const extra = {
      labsUsed: [],
      md: { minHeading: 1, maxHeading: 4, h1As: 2, reservedIds: ["main", "live", "checkpoint-box"] },
      hooks: {
        checkpoint: () => checkpointHook(fm, null),
        prereqsHead: () => "",
      },
    };
    let r;
    try { r = render(body, bodyLine, p.file, extra); } catch (e) { problems.push(e.message); return; }
    if (r.counts.objectives !== 1) problems.push(`${p.file}: needs exactly one :::objectives`);
    if (r.counts.prereqs !== 1) problems.push(`${p.file}: needs exactly one :::prereqs`);
    if ((fm.command || fm.expect) && !r.counts.checkpoint) problems.push(`${p.file}: front matter has command:/expect: but the primer has no :::checkpoint, so they would be dropped`);
    // One source for "which chapters use this primer": chapters.json (CURRICULUM section 2.1).
    // The front matter keeps only required_by (checked to match); objectives live in the box.
    if (JSON.stringify((fm.required_by || []).map(String)) !== JSON.stringify([p.first_required_by])) problems.push(`${p.file}: front matter required_by ${JSON.stringify(fm.required_by)} differs from chapters.json first_required_by "${p.first_required_by}"`);
    for (const k of ["also_used_by", "objectives"]) if (k in fm) problems.push(`${p.file}: drop "${k}:" from the front matter; the page uses ${k === "objectives" ? "the :::objectives box" : "chapters.json"}`);
    const first = byId.get(p.first_required_by);
    const also = (p.also_used_by || []).filter((id) => id !== p.first_required_by).map((id) => byId.get(id)).filter((c) => c && c.exists);
    const prev = primers[k - 1], next = primers[k + 1];
    const main =
      `<main id="main" class="lesson"><header class="lesson__head"><p class="tag">Primer</p><h1>${esc(fm.title || p.title)}</h1>` +
      `<div class="meta-row">${badges(fm.runs || "browser")} <span>${ICONS.clock} ${esc(minutesLabel(Number(fm.minutes || p.minutes)))}</span></div>` +
      (first?.exists ? `<p class="progress-label">First needed in <a href="${first.href}">chapter ${esc(first.id)}</a>` +
        (also.length ? `; also used in ${also.map((c) => `<a href="${c.href}">chapter ${esc(c.id)}</a>`).join(", ")}` : "") + `</p>` : "") +
      `</header>${(r.counts.predict || 0) >= 2 ? `<div class="predict-tools" hidden><button class="btn" type="button">Show all answers</button></div>` : ""}` +
      `<div class="prose">${r.html}</div>` +
      `<nav class="pager" aria-label="Previous and next primer">` +
      (prev ? `<a class="prev" href="${prev.href}"><span class="dir">Previous primer</span>${esc(prev.title)}</a>` : "") +
      (next ? `<a class="next" href="${next.href}"><span class="dir">Next primer</span>${esc(next.title)}</a>` : "") +
      `</nav></main>`;
    page(p.url, {
      title: `${p.title} · Primer · ${C.short_title}`, description: textOnly(inline(`Primer: ${coversText(p.covers)}`)).slice(0, 300),
      body: shell(main, { current: p.slug, mode: "primers", onpage: r.headings.filter((h) => h.level === 2) }),
      section: "primers", labsUsed: extra.labsUsed,
    });
  });
  {
    const items = primers.map((p) => {
      const req = [byId.get(p.first_required_by)].filter((c) => c && c.exists);
      // The link is the title only (a short accessible name); .card--link stretches its hit area
      // over the whole card. covers is plain text here: a link inside would nest anchors.
      return `<li><div class="card card--link"><h2><a href="${p.href}">${esc(p.title)}</a></h2><p>${esc(textOnly(inline(coversText(p.covers))))}</p><p>${esc(minutesLabel(p.minutes))}${req.length ? ` · first needed in chapter ${req.map((c) => esc(c.id)).join(", ")}` : ""}</p></div></li>`;
    }).join("");
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">Primers</p><h1>Primers</h1>` +
      `<p class="lead">Short, standalone tutorials on the ideas the course uses but does not build: calling conventions, file formats, page tables, firmware. Each takes 15 to 30 minutes. A chapter names the primers it needs in its "Concepts you'll need" box.</p></header>` +
      `<ul class="grid3">${items}</ul></main>`;
    page("primers/", { title: `Primers · ${C.short_title}`, description: "Standalone primers for the VMM course.", body: `<div class="wrap">${main}</div>`, section: "primers" });
  }

  // ---- labs --------------------------------------------------------------------------------
  const labUsedIn = (name) => {
    const m = labMeta.get(name);
    const cs = (m?.chapters || []).map((id) => byId.get(id)).filter(Boolean);
    const ps = (m?.primers || []).map((s) => primers.find((p) => p.slug === s)).filter(Boolean);
    return [...cs.map((c) => `<a href="${c.href}">chapter ${esc(c.id)}</a>`), ...ps.map((p) => `<a href="${p.href}">the ${esc(p.slug)} primer</a>`)];
  };
  for (const name of allLabNames) {
    const l = labs.get(name);
    const title = l?.title || humanLabName(name);
    const used = labUsedIn(name);
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">Lab</p><h1 id="lab-title">${esc(title)}</h1>` +
      (used.length ? `<p>Used in ${used.join(", ")}.</p>` : "") + `</header>` +
      labShell(name, 1, { standalone: true, titleId: "lab-title" }) +
      `<p><a href="${url("labs/")}">All labs</a></p></main>`;
    page(`labs/${name}/`, { title: `${title} · Lab · ${C.short_title}`, description: l?.goal || `In-browser lab: ${title}.`, body: `<div class="wrap">${main}</div>`, section: "labs", labsUsed: [name], skipLabel: "Skip to the lab", noindex: !l?.built });
  }
  {
    const prio = { "v1-core": 0, "v1-optional": 1, "post-v1": 2 };
    const names = [...allLabNames].sort((a, b) => (prio[labMeta.get(a)?.priority] ?? 3) - (prio[labMeta.get(b)?.priority] ?? 3));
    const card = (name, hl = 2) => {
      const l = labs.get(name);
      const built = Boolean(l?.built);
      const used = labUsedIn(name).map(textOnly);
      const planned = labPlanned(name);
      const plannedFor = planned ? (labMeta.get(name).chapters || []).map((id) => byId.get(id)).filter(Boolean).map((c) => `chapter ${c.id}`) : [];
      return `<li><div class="card card--link${built ? "" : " card--muted"}"><h${hl}><a href="${url(`labs/${name}/`)}">${esc(l?.title || humanLabName(name))}</a></h${hl}>` +
        (l?.goal ? `<p>${esc(l.goal)}</p>` : "") +
        `<p>${built ? badges("browser") : `<span class="badge badge--plain">${planned ? "Planned" : "Not built yet"}</span>`}</p>` +
        (used.length ? `<p>Used in ${esc(used.join(", "))}</p>` : plannedFor.length ? `<p>For ${esc(plannedFor.join(", "))}, which is not written yet</p>` : "") + `</div></li>`;
    };
    const current = names.filter((n) => !labPlanned(n));
    const planned = names.filter((n) => labPlanned(n));
    const builtCount = current.filter((n) => labs.get(n)?.built).length;
    const countLine = builtCount === current.length
      ? `<p>${current.length} labs, each embedded in the chapter or primer that uses it.</p>`
      : `<p>${builtCount} of ${current.length} labs are built so far.</p>`;
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">Labs</p><h1>In-browser labs</h1>` +
      `<p class="lead">Decoders, walkers and visualizers that run in any browser, no Mac needed. Each one is also embedded in the chapter that uses it. A lab never replaces the native work: every checkpoint still runs on your Mac.</p>` +
      countLine + `</header><ul class="labs-grid">${current.map((n) => card(n)).join("")}</ul>` +
      (planned.length ? `<section class="section"><h2 id="planned">Planned with later chapters</h2><p>These labs belong to chapters that are not written yet.</p><ul class="labs-grid">${planned.map((n) => card(n, 3)).join("")}</ul></section>` : "") +
      `</main>`;
    page("labs/", { title: `Labs · ${C.short_title}`, description: "In-browser labs for the VMM course.", body: `<div class="wrap">${main}</div>`, section: "labs" });
  }

  // ---- glossary ----------------------------------------------------------------------------
  {
    const seen = new Set();
    const letters = new Map();
    for (const g of glossary) {
      if (seen.has(g.anchor)) { problems.push(`GLOSSARY.md: two terms share the anchor #${g.anchor}`); continue; }
      seen.add(g.anchor);
      const L = /^[a-z]/i.test(g.term) ? g.term[0].toUpperCase() : "#";
      if (!letters.has(L)) letters.set(L, []);
      letters.get(L).push(g);
    }
    const srcLink = (s) => {
      if (s.kind === "chapter") { const c = byId.get(s.id); return c ? `<a href="${c.href}">chapter ${esc(c.id)}</a>` : `chapter ${esc(s.id)}`; }
      if (s.kind === "primer") { const p = primers.find((x) => x.slug === s.slug); return p ? `<a href="${p.href}">the ${esc(p.slug)} primer</a>` : esc(s.slug); }
      return "a primer";
    };
    let body = `<ul class="glossary-letters" aria-label="Jump to letter">${[...letters.keys()].map((L) => `<li><a href="#letter-${L === "#" ? "sym" : L.toLowerCase()}">${esc(L)}</a></li>`).join("")}</ul>`;
    for (const [L, gs] of letters) {
      body += `<h2 id="letter-${L === "#" ? "sym" : L.toLowerCase()}">${esc(L)}</h2><dl class="glossary">`;
      for (const g of gs) {
        body += `<dt id="${esc(g.anchor)}">${inline(g.term)}${g.expansion ? ` <span class="exp">(${inline(g.expansion)})</span>` : ""}</dt>` +
          `<dd>${inline(g.def.replace(/\s*Taught in `[a-z0-9-]+`\.?\s*$/, ""))} <span class="src">Taught in ${srcLink(g.source)}.</span></dd>`;
      }
      body += `</dl>`;
    }
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">Reference</p><h1>Glossary</h1>` +
      `<p class="lead">Every term the course uses, in one plain line each, with the chapter or primer that teaches it.</p></header><div class="prose">${body}</div></main>`;
    page("glossary/", { title: `Glossary · ${C.short_title}`, description: "Glossary of virtualization and ARM64 terms used in the VMM course.", body: `<div class="wrap">${main}</div>`, section: "glossary" });
  }

  // ---- plain pages from src/pages/*.md (reference, about) -----------------------------------
  for (const f of existsSync(join(SITE, "src", "pages")) ? readdirSync(join(SITE, "src", "pages")).filter((x) => x.endsWith(".md")).sort() : []) {
    const rel = `course/site/src/pages/${f}`;
    let fmr;
    try { fmr = parseFrontMatter(read(join(SITE, "src", "pages", f))); } catch (e) { problems.push(`${rel}: ${e.message}`); continue; }
    const extra = { labsUsed: [], md: { minHeading: 2, maxHeading: 3, reservedIds: ["main", "live"] }, hooks: {} };
    let r;
    try { r = render(fmr.body, fmr.bodyLine, rel, extra); } catch (e) { problems.push(e.message); continue; }
    const slug = f.replace(/\.md$/, "");
    const main = `<main id="main" class="page"><header class="page__head"><p class="tag">${esc(fmr.data.tag || "Course")}</p><h1>${esc(fmr.data.title || slug)}</h1>` +
      (fmr.data.lead ? `<p class="lead">${inline(fmr.data.lead)}</p>` : "") + `</header><div class="prose">${r.html}</div></main>`;
    page(`${slug}/`, { title: `${fmr.data.title || slug} · ${C.short_title}`, description: textOnly(inline(fmr.data.lead || fmr.data.title || slug)), body: `<div class="wrap">${main}</div>`, section: slug, labsUsed: extra.labsUsed });
  }

  // ---- landing -----------------------------------------------------------------------------
  {
    const first = written[0];
    const builtLabs = allLabNames.filter((n) => labs.get(n)?.built).length;
    const continueData = esc(JSON.stringify(written.map((c) => ({ id: c.id, url: c.href, number: c.id, title: c.display }))));
    const curriculum = parts.map((p, k) =>
      `<details class="part"${k < 2 ? " open" : ""} data-desktop-open><summary><span class="part__num">Part ${esc(p.id)}</span><span class="part__title">${esc(p.title)}</span></summary>` +
      `<ol class="chapters">${p.chapters.map(chapterRow).join("")}</ol></details>`).join("");
    const body =
      `<main id="main"><div class="wrap">` +
      `<section class="hero"><p class="tag">Build · Rust · Apple Silicon</p><h1>Build a VMM from scratch.</h1>` +
      `<p class="lead">Write a virtual machine monitor in Rust on top of Apple's Hypervisor.framework, then boot Linux on it. No QEMU underneath: every exit, device and interrupt is code you wrote and can read.</p>` +
      `<div class="cta"><a class="btn btn--primary" href="${first.href}">Start: ${esc(first.id)} ${esc(first.display)}</a><a class="btn" href="${url("labs/")}">Try a lab (no Mac needed)</a></div>` +
      `<p class="continue" data-continue="${continueData}" hidden><a href="${first.href}">Continue</a></p>` +
      `<div class="meta-row">${badges("mac")} <span>${parts.length} parts · ${written.length} chapters written</span> ${badges("browser")} <span>${builtLabs} labs built · ${primers.length} primers</span></div></section>` +
      `<section class="section" aria-labelledby="build"><h2 id="build">What you'll build</h2><div class="tour">` +
      diagramHook({ src: "docs/diagrams/overview.svg", alt: "macvmm is one macOS process between the guest and Hypervisor.framework, and the guest's code runs directly on the CPU." }, 1) +
      diagramHook({ src: "docs/diagrams/exit-loop.svg", alt: "When the guest touches a device, the CPU stops it, and your code decodes why, emulates the device and runs the guest again." }, 2) +
      `</div><p class="tour__cta"><a class="btn" href="${url("how-it-works/")}">Take the visual tour</a></p></section>` +
      `<section class="section" aria-labelledby="need"><h2 id="need">What you need</h2><ul class="grid3">` +
      `<li><div class="card"><h3>${ICONS.chip} Needs a Mac</h3><p>A Mac with Apple Silicon (Apple M1 or later) on macOS 15 or later, with Xcode command-line tools and Rust, for the chapters that run your VMM. Tested only on macOS 27.2 on an M5 Pro; older ones are expected to work. The code is on <a href="${esc(C.repo)}">GitHub</a>, and chapter 00 shows how to get it.</p></div></li>` +
      `<li><div class="card"><h3>${ICONS.window} Runs in a browser</h3><p>Reading, the primers and the labs need only a browser. Labs run entirely on your machine; nothing is uploaded.</p></div></li>` +
      `<li><div class="card"><h3>${ICONS.pen} You should know</h3><p>Some Rust or C, what a process and a memory address are, and a terminal. No virtualization or ARM background needed: Part 0 starts from zero.</p></div></li>` +
      `</ul></section>` +
      `<section class="section" aria-labelledby="how"><h2 id="how">How it works</h2><ul class="grid3">` +
      `<li><div class="card"><h3>Real code</h3><p>Every block of reference VMM code, headed by its file path and line numbers, is pulled from the repository when the site is built, never pasted, so it cannot drift.</p></div></li>` +
      `<li><div class="card"><h3>Predict, then reveal</h3><p>Each chapter asks you to commit to a guess before it shows the answer, and breaks things on purpose so you see why they work.</p></div></li>` +
      `<li><div class="card"><h3>A test you run</h3><p>Every chapter ends with a checkpoint: one command and the exact output you should see. Every block labelled Terminal is a captured run, and its footer says where it came from.</p></div></li>` +
      `</ul></section>` +
      `<section class="section curriculum" aria-labelledby="curr"><h2 id="curr">Curriculum</h2>${curriculum}</section>` +
      `<section class="section honesty"><p><strong>Honesty note.</strong> The macOS-guest chapters are research chapters: they state what was and was not observed on a real Mac, and nothing more. Chapters marked "planned" are not written yet.</p></section>` +
      `</div></main>`;
    page("", { title: `${C.title} · indicogni`, description: "A course: write a hypervisor for Apple Silicon from scratch in Rust and boot Linux on it. Real Hypervisor.framework code on your Mac, plus labs in your browser.", body, bodyClass: "dotted" });
  }

  // ---- 404, sitemap, headers ---------------------------------------------------------------
  page("404.html", {
    title: `Page not found · ${C.short_title}`, description: "Page not found.", noindex: true, canonical: false,
    body: `<div class="wrap"><main id="main" class="page"><h1>Page not found</h1><p>There is no page at this address. It may have moved when the course was reorganised.</p>` +
      `<p><a href="${url()}">Go to the course home</a> or the <a href="${url("glossary/")}">glossary</a>.</p></main></div>`,
  });
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    pages.filter((p) => p.inSitemap && !p.path.endsWith(".html")).map((p) => `  <url><loc>${esc(ORIGIN + url(p.path))}</loc></url>\n`).join("") + `</urlset>\n`;
  writeOut(join(root, "sitemap.xml"), sitemap);
  writeOut(join(out, "_headers"), headersFile(BASE));

  // ---- checks ------------------------------------------------------------------------------
  const linkProblems = checkLinks(out, { origin: ORIGIN, base: BASE });
  const sizeProblems = checkSize(out);
  if (opts.check) problems.push(...linkProblems, ...sizeProblems);
  else warnings.push(...linkProblems, ...sizeProblems);
  if (missingTags.size) warnings.push(`start_tag not shown: no such git tag ${[...missingTags].sort().join(", ")} (the tags do not exist yet)`);
  if (strict) problems.push(...warnings.splice(0));

  // Publish atomically: only a build with no problems replaces the output directory. A failed
  // build stays in <out>.partial with a BUILD-FAILED marker, for inspection, never at <out>.
  let dest = out;
  if (problems.length === 0) {
    rmSync(finalOut, { recursive: true, force: true });
    renameSync(out, finalOut);
    dest = finalOut;
  } else {
    writeFileSync(join(out, "BUILD-FAILED.txt"), `This tree failed the site build and must not be deployed.\n\n${[...new Set(problems)].join("\n")}\n`);
  }
  const destRoot = join(dest, ...BASE.split("/").filter(Boolean));
  log(`Built ${pages.length} pages (${written.length} lessons, ${primers.length} primers, ${allLabNames.length} lab pages) into ${relative(process.cwd(), dest) || "."}`);
  return { out: dest, root: destRoot, pages, problems, warnings, labsDir, meta: `${written.length} chapters · Rust · needs an Apple Silicon Mac` };
}

/**
 * Shrink the hand-written stylesheet for shipping: drop comments, collapse whitespace, and remove
 * the spaces around { } ; , (DESIGN.md section 10 step 6 budgets the shipped file, not the
 * commented source). Safe for course.css because none of its string values contain those
 * characters; a test keeps that true.
 */
export function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/** The `_headers` file (Cloudflare static assets): security headers and caching. */
export function headersFile(base) {
  return [
    "/*",
    "  Strict-Transport-Security: max-age=31536000",
    `  Content-Security-Policy: ${CSP}`,
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Resource-Policy: same-origin",
    `${base}assets/*`,
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && (!args[outIdx + 1] || args[outIdx + 1].startsWith("--"))) { console.error("ERROR --out needs a directory"); process.exit(2); }
  let res;
  try {
    res = build({
    check: args.includes("--check"),
    strict: args.includes("--strict"),
    out: outIdx >= 0 ? args[outIdx + 1] : undefined,
    });
  } catch (e) {
    if (!/^--out /.test(e.message)) throw e;
    console.error(`ERROR ${e.message}`);
    process.exit(2);
  }
  const uniqueWarnings = [...new Set(res.warnings)];
  const labWarn = uniqueWarnings.filter((w) => /^lab ".*" is not built yet/.test(w));
  for (const w of uniqueWarnings.filter((x) => !labWarn.includes(x))) console.warn(`WARNING ${w}`);
  if (labWarn.length) console.warn(`WARNING ${labWarn.length} lab embed(s) render a "not built yet" placeholder (--strict makes this an error)`);
  const uniqueProblems = [...new Set(res.problems)];
  for (const p of uniqueProblems) console.error(`ERROR ${p}`);
  if (uniqueProblems.length) {
    console.error(`site build: ${uniqueProblems.length} error(s); the output was NOT updated (failed tree: ${relative(process.cwd(), res.out)})`);
    process.exit(1);
  }
  console.log(`Landing-card meta: "${res.meta}"`);
  console.log(args.includes("--check") ? "SITE CHECK OK" : "SITE BUILD OK");
}
