// Post-build checks (DESIGN.md §10 step 7). Each returns a list of problem strings; the builder
// fails when any list is non-empty.
//
//   checkCsp       no inline <script>, no inline styles, no on*= handlers, no javascript: URLs,
//                  no resource loaded from another origin (outbound <a> links are fine)
//   checkLinks     every internal href/src resolves to an emitted file, and every #fragment to an id
//   checkContrast  the colour tokens in course.css keep WCAG AA in both schemes
//   checkSize      pages stay small enough to read on a slow phone

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, posix } from "node:path";

// Attributes may be separated by whitespace or "/" (the HTML parser accepts `<rect/onclick=x>`).
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[\s/]+[^\s=>"'\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)[\s/]*>/g;
const ATTR = /([^\s=>"'\/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** Every start tag in `html` as { name, attrs: Map }. Text content never matches (it is escaped). */
export function tags(html) {
  const out = [];
  const src = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of src.matchAll(TAG)) {
    const attrs = new Map();
    for (const a of m[2].matchAll(ATTR)) attrs.set(a[1].toLowerCase(), (a[3] ?? a[4] ?? a[5] ?? "").replace(/&amp;/g, "&"));
    out.push({ name: m[1].toLowerCase(), attrs });
  }
  return out;
}

const RESOURCE = { script: "src", link: "href", img: "src", source: "src", video: "src", audio: "src", iframe: "src", embed: "src", object: "data", track: "src", input: "src" };
const isForeign = (v) => /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(v.trim()) && !/^data:/i.test(v.trim());
/** Every URL an element loads besides its RESOURCE attribute: srcset lists, poster, SVG href. */
function extraUrls(t) {
  const urls = [];
  for (const k of ["srcset", "imagesrcset"]) if (t.attrs.has(k)) for (const c of t.attrs.get(k).split(",")) { const u = c.trim().split(/\s+/)[0]; if (u) urls.push([k, u]); }
  if (t.attrs.has("poster")) urls.push(["poster", t.attrs.get("poster")]);
  if (["image", "use", "feimage"].includes(t.name)) for (const k of ["href", "xlink:href"]) if (t.attrs.has(k)) urls.push([k, t.attrs.get(k)]);
  return urls;
}

export function checkCsp(html, page = "page") {
  const problems = [];
  const p = (msg) => problems.push(`${page}: ${msg}`);
  if (/<style\b/i.test(html.replace(/<!--[\s\S]*?-->/g, ""))) p("inline <style> element");
  for (const t of tags(html)) {
    for (const [k, v] of t.attrs) {
      if (/^on[a-z]+$/.test(k)) p(`inline event handler ${k}= on <${t.name}>`);
      if (k === "style") p(`inline style= attribute on <${t.name}>`);
      if (/^\s*javascript:/i.test(v.replace(/&#x0*6a;?|&#0*106;?/gi, "j").replace(/[\t\n\r]/g, ""))) p(`javascript: URL in ${k}= on <${t.name}>`);
    }
    if (t.name === "script") {
      const type = t.attrs.get("type") || "";
      if (!t.attrs.has("src") && type !== "application/json") p("inline <script> (no src)");
    }
    if (["iframe", "embed", "object", "frame"].includes(t.name)) p(`<${t.name}> is not allowed`);
    const ra = RESOURCE[t.name];
    if (ra && t.attrs.has(ra)) {
      const v = t.attrs.get(ra);
      const rel = t.attrs.get("rel") || "";
      const isNav = t.name === "link" && /\b(canonical|alternate)\b/.test(rel);
      if (!isNav && /^(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(v) && !v.startsWith("data:")) p(`<${t.name}> loads ${v} from another origin`);
      if (v.startsWith("data:")) p(`<${t.name}> uses a data: URL (the CSP's img-src has no data:)`);
    }
    for (const [k, v] of extraUrls(t)) {
      if (isForeign(v)) p(`<${t.name} ${k}> loads ${v} from another origin`);
      if (/^\s*data:/i.test(v)) p(`<${t.name} ${k}> uses a data: URL`);
    }
    if (t.name === "meta" && t.attrs.has("http-equiv")) {
      const he = t.attrs.get("http-equiv").toLowerCase();
      if (he === "refresh") p("<meta http-equiv=refresh> is not allowed (an unchecked navigation)");
      if (he === "content-security-policy") p("<meta http-equiv=content-security-policy>: the CSP lives in _headers only");
    }
    if (t.name === "a" && /^http:\/\//i.test(t.attrs.get("href") || "")) p(`insecure http:// link ${t.attrs.get("href")}`);
  }
  return problems;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Check internal links across the built tree. `dist` is the asset root (holding
 * build-your-own/vmm/...), `origin` the production origin whose absolute URLs count as internal.
 */
export function checkLinks(dist, { origin = "https://indicogni.com", base = "/build-your-own/vmm/" } = {}) {
  const problems = [];
  const files = walk(dist);
  const pages = files.filter((f) => f.endsWith(".html"));
  const idCache = new Map();
  const idsOf = (file) => {
    if (!idCache.has(file)) {
      const ids = new Set();
      for (const t of tags(readFileSync(file, "utf8"))) if (t.attrs.has("id")) ids.add(t.attrs.get("id"));
      idCache.set(file, ids);
    }
    return idCache.get(file);
  };
  const toFile = (urlPath) => {
    let p = decodeURIComponent(urlPath);
    if (p.endsWith("/")) p += "index.html";
    const f = join(dist, p);
    return existsSync(f) && statSync(f).isFile() ? f : null;
  };
  for (const page of pages) {
    const rel = "/" + page.slice(dist.length + 1).split("\\").join("/");
    const pageUrl = rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel;
    const html = readFileSync(page, "utf8");
    for (const t of tags(html)) {
      for (const attr of ["href", "src"]) {
        if (!t.attrs.has(attr)) continue;
        let v = t.attrs.get(attr);
        if (v.startsWith(origin + "/")) v = v.slice(origin.length);
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(v)) continue; // external, mailto:
        if (v.startsWith("/") && !v.startsWith(base) && v !== base.slice(0, -1)) continue; // the root site's pages
        const [pathPart, frag] = v.split("#");
        const clean = pathPart.split("?")[0];
        let resolved = posix.resolve(posix.dirname(pageUrl + "x"), clean);
        if ((clean.endsWith("/") || clean === "" || clean.endsWith("/.") || clean.endsWith("/..")) && !resolved.endsWith("/")) resolved += "/";
        const target = pathPart === "" ? page : toFile(resolved);
        const where = `${rel}: <${t.name} ${attr}="${t.attrs.get(attr)}">`;
        if (!target) { problems.push(`${where}: no such file`); continue; }
        if (frag && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(frag))) problems.push(`${where}: no element with id "${frag}"`);
      }
    }
  }
  return problems;
}

// --- contrast -------------------------------------------------------------------------------

function lum(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two #rrggbb colours. */
export function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/** Pull `--name:#hex` tokens out of a CSS block. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) out[m[1]] = m[2];
  return out;
}

export const CONTRAST_PAIRS = [
  ["ink", "paper", 4.5], ["muted", "paper", 4.5], ["muted", "card", 4.5], ["ink", "card", 4.5],
  ["accent", "paper", 4.5], ["accent", "card", 4.5], ["accent", "accent-tint", 4.5], ["on-accent", "accent", 4.5],
  ["code-ink", "code-bg", 4.5], ["code-muted", "code-bg", 4.5],
  ["tok-kw", "code-bg", 4.5], ["tok-str", "code-bg", 4.5], ["tok-num", "code-bg", 4.5], ["tok-fn", "code-bg", 4.5],
  ["tok-com", "code-bg", 4.5], ["tok-ty", "code-bg", 4.5],
  ["ok", "paper", 4.5], ["warn", "paper", 4.5], ["danger", "paper", 4.5],
  // Non-text contrast (WCAG 1.4.11, 3:1): the only visible edge of a control, the progress bar's
  // fill against its track, badge outlines.
  ["control", "paper", 3], ["control", "card", 3], ["control", "accent-tint", 3],
  ["accent", "rule", 3], ["muted", "card", 3],
];

const DARK_ROOT = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/;

/**
 * The site's theme as two maps of `--name` to value: `light` from every top-level :root block
 * (colours, then fonts), `dark` the same with the prefers-color-scheme block laid over it.
 * `hasDark` is false when that block is missing.
 */
export function themeTokens(css) {
  const top = css.replace(/@media[^{]*\{\s*:root\s*\{[^}]*\}\s*\}/g, "");
  const light = {};
  for (const m of top.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const t of m[1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) light[t[1]] = t[2];
  }
  const darkBlock = (css.match(DARK_ROOT) || [])[1];
  const dark = { ...light };
  for (const t of (darkBlock || "").matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) dark[t[1]] = t[2];
  return { light, dark, hasDark: Boolean(darkBlock) };
}

/** Check the light tokens (first :root block) and the dark ones (the prefers-color-scheme block). */
export function checkContrast(css) {
  const problems = [];
  const light = tokensIn((css.match(/:root\s*\{([^}]*)\}/) || [])[1] || "");
  const darkBlock = (css.match(DARK_ROOT) || [])[1];
  if (!darkBlock) problems.push("course.css: no dark-mode :root block");
  const dark = { ...light, ...tokensIn(darkBlock || "") };
  for (const [scheme, t] of [["light", light], ["dark", dark]]) {
    for (const [fg, bg, min] of CONTRAST_PAIRS) {
      if (!t[fg] || !t[bg]) { problems.push(`course.css (${scheme}): token --${!t[fg] ? fg : bg} missing`); continue; }
      const r = contrast(t[fg], t[bg]);
      if (r < min) problems.push(`course.css (${scheme}): --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  return problems;
}

/**
 * Author notation must never reach a learner (STYLE.md; the same vocabulary scripts/check-lessons
 * rejects in chapters): planning document names, milestone and risk IDs, sections of the project's
 * internal documents, evidence tags. Checked on rendered text outside <pre>, <code> and inline
 * SVG, so a quoted command or a file name stays possible. External specs cited by section
 * ("UEFI 2.10 §7", "virtio 1.2 §5.2.3") are fine.
 */
export const NOTATION = [
  [/\bPLAN\b/, "PLAN (an internal planning document)"],
  [/\bCURRICULUM\b/, "CURRICULUM (an internal planning document)"],
  [/(?<!\bApple |\bM\d{1,2} (?:to|and|or|through) |\b(?:an|the) Apple M\d )\bM\d{1,2}\b(?! (?:Pro|Max|Ultra)\b)(?! (?:to|and|or|through) M\d)/, "a milestone ID such as M12 (for a chip write \"Apple M1\")"],
  [/\b(?:K\d{1,3}|R\d{2,3}|RR\d{1,3})\b/, "a risk or threat-model ID"],
  [/\b(?:architecture|threat model|PLAN|DECISIONS|hvf-api\.md|guest-boot\.md) §/i, "a section of an internal document"],
  [/\[(?:U|V|H)\]/, "an evidence tag such as [U] outside code"],
  [/\bspike (?:results?|findings?) #?\d/i, "an internal spike reference"],
  [/\b(?:the |our )?project's (?:first |early |own )?spikes?\b/i, "an internal spike reference (write \"an early experiment on this Mac\")"],
];

/**
 * Notation that hides inside code spans, so it is matched on the HTML before code is removed:
 * an evidence tag alone in a code span, and a section sign right after a code span naming an
 * internal document (`docs/security/threat-model.md` §13).
 */
export const CODE_NOTATION = [
  [/<code\b[^>]*>\s*\[(?:U|V|H)\]\s*<\/code>/, "an evidence tag such as [U] in a code span"],
  [/<code\b[^>]*>[^<]*(?:\.md|\bdocs\/[^<]*)<\/code>(?:\s|&nbsp;|&#160;)*§/, "a section of an internal document (a .md or docs/ file followed by §)"],
];

export function checkInternalNotation(html, page = "page") {
  const main = (html.match(/<main\b[\s\S]*<\/main>/) || [html])[0];
  const out = [];
  const noPre = main.replace(/<pre\b[\s\S]*?<\/pre>/g, " ").replace(/<svg\b[\s\S]*?<\/svg>/g, " ");
  for (const [re, what] of CODE_NOTATION) {
    for (const m of noPre.matchAll(new RegExp(re.source, "g"))) out.push(`${page}: ${what}: "${m[0].replace(/<[^>]+>/g, "").slice(0, 80)}"`);
  }
  const text = main
    .replace(/<pre\b[\s\S]*?<\/pre>/g, " ")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/g, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
  for (const [re, what] of NOTATION) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) out.push(`${page}: ${what}: "...${text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30).trim()}..."`);
  }
  return out;
}

/** The shipped course stylesheet budget (DESIGN.md section 10 step 6). */
export const CSS_BUDGET = 25 * 1024;

export function checkSize(dist, { maxBytes = 400 * 1024, maxCss = CSS_BUDGET } = {}) {
  const files = walk(dist);
  const pages = files
    .filter((f) => f.endsWith(".html"))
    .filter((f) => statSync(f).size > maxBytes)
    .map((f) => `${f.slice(dist.length)}: ${Math.round(statSync(f).size / 1024)} KB (limit ${maxBytes / 1024} KB)`);
  const css = files
    .filter((f) => /[\\/]assets[\\/]course\.[0-9a-f]+\.css$/.test(f))
    .filter((f) => statSync(f).size > maxCss)
    .map((f) => `${f.slice(dist.length)}: ${(statSync(f).size / 1024).toFixed(1)} KB shipped, over the ${maxCss / 1024} KB stylesheet budget (DESIGN.md section 10 step 6)`);
  return [...pages, ...css];
}

/**
 * Lab stylesheets: a text input, select or textarea whose only edge is a border must use
 * --control (3:1), not the decorative --rule (about 1.3:1), or it fails WCAG 1.4.11.
 */
const CONTROL_SEL = /(^|[\s>+~,(])(?:input|select|textarea)\b/;
export function checkControlBorders(css, file = "style.css") {
  const out = [];
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(",").map((x) => x.trim().replace(/^\.lab\[data-lab="[^"]+"\]/, ""));
    const hit = sels.find((x) => CONTROL_SEL.test(x) && !/\[type=["']?(?:checkbox|radio|range|color|file|button|submit)/.test(x));
    if (hit && /border(?:-[a-z]+)?\s*:[^;]*var\(--rule\)/.test(m[2])) out.push(`${file}: "${m[1].trim()}" draws a form control's edge with --rule; use --control (3:1, WCAG 1.4.11)`);
  }
  return out;
}
