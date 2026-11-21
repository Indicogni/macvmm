// The course's Markdown renderer: a closed subset plus the `:::` directives of DESIGN.md §9.
//
// Why our own renderer (DESIGN.md §10): the directives (`:::predict`, `:::code anchor=`, ...) are
// most of the work anyway, a closed subset gives the same output for the same input forever, and
// escape-by-default is the right stance for a site with a strict Content-Security-Policy. Raw
// HTML in a lesson is never passed through: `<b>` renders as the text "<b>".
//
// Supported: ATX headings, paragraphs (hard break: two trailing spaces or a backslash), *em*,
// _em_, **strong**, `code`, links, images (local only, alt text required), <https://autolinks>,
// ordered/unordered lists (nested, loose or tight, with fences and paragraphs inside items),
// blockquotes, pipe tables, horizontal rules, fenced code, and the directives:
//
//   containers (closed by a bare `:::`):  objectives  prereqs  predict  callout  concepts
//   leaves (one line, no closer):         code  term  diagram  lab  checkpoint  retrieval
//                                         stopping-point
//
// Containers do not nest; leaves may sit inside a container; a directive inside a blockquote is
// not a directive. Leaves that need the repository (code, term, lab, ...) are rendered by hooks
// the caller passes in, so this module stays pure and testable. Errors throw MarkdownError with
// the source line.

import { esc, slugify, ICONS } from "./html.mjs";
import { highlight, normalizeLang } from "./highlight.mjs";

export class MarkdownError extends Error {
  constructor(msg, file, line) {
    super(`${file || "<markdown>"}${line ? `:${line}` : ""}: ${msg}`);
    this.line = line;
  }
}

const UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** Plain text from our own escaped HTML (for the "On this page" list, which escapes again). */
export const unescapeHtml = (s) => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => UNESC[m]);

export const CONTAINERS = new Set(["objectives", "prereqs", "predict", "callout", "concepts"]);
export const LEAVES = new Set(["code", "term", "diagram", "lab", "checkpoint", "retrieval", "stopping-point"]);
const CALLOUT_KINDS = new Set(["note", "why", "warn", "security", "mac"]);
/** The blockquote callout labels of STYLE.md section 7 (Predict is never a blockquote: :::predict). */
export const CALLOUT_LABELS = ["Security", "Under the hood", "Try it", "Aside", "Production note"];

/** Parse directive arguments: key=value, key="a b", and positional words. */
export function parseArgs(s) {
  const args = {};
  const words = [];
  const re = /\s*([A-Za-z_][\w-]*)=("([^"]*)"|\S*)|\s*(\S+)/gy;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0].trim() === "") break;
    if (m[1]) args[m[1]] = m[3] !== undefined ? m[3] : m[2];
    else words.push(m[4]);
  }
  return { args, words };
}

// ---------------------------------------------------------------------------------------------
// Inline

const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

/**
 * Validate a link target. Returns the URL or throws. Tabs and newlines are removed first, as the
 * browser's URL parser removes them (so `java\nscript:` cannot slip past the scheme test), and a
 * protocol-relative `//host` target is refused: write the scheme.
 */
export function checkUrl(url, kind = "link") {
  const u = url.trim().replace(/[\t\n\r]/g, "");
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) throw new Error(`${kind} URL scheme not allowed: ${u}`);
  if (/^[\\/]{2}/.test(u)) throw new Error(`${kind} URL "${u}" is protocol-relative; write https://`);
  return u;
}

function findClose(s, from, delim) {
  // Find a closing delimiter run not preceded by whitespace, skipping code spans.
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) { i = end + run.length - 1; continue; }
    }
    if (s.startsWith(delim, i) && i > from && !/\s/.test(s[i - 1])) {
      if (delim.length === 1 && s[i + 1] === delim) { i++; continue; } // part of ** run
      if (delim === "_" && /[A-Za-z0-9]/.test(s[i + 1] || "")) continue;
      return i;
    }
  }
  return -1;
}

function findBracket(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) { i = end + run.length - 1; continue; }
    }
    if (c === "[") depth++;
    else if (c === "]") { if (depth === 0) return i; depth--; }
  }
  return -1;
}

function findParen(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Render inline Markdown to HTML. `ctx` carries { links: [] } for reporting. */
export function inline(s, ctx = {}) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length && PUNCT.includes(s[i + 1])) { out += esc(s[i + 1]); i += 2; continue; }
    if (c === "\\" && s[i + 1] === "\n") { out += "<br>\n"; i += 2; continue; }
    if (c === "`") {
      const run = s.slice(i).match(/^`+/)[0];
      const end = s.indexOf(run, i + run.length);
      if (end < 0 || s[end + run.length] === "`") { out += esc(run); i += run.length; continue; }
      let code = s.slice(i + run.length, end);
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
      out += `<code>${esc(code)}</code>`;
      i = end + run.length;
      continue;
    }
    if ((c === "!" && s[i + 1] === "[") || c === "[") {
      const img = c === "!";
      const open = i + (img ? 1 : 0);
      const close = findBracket(s, open + 1);
      if (close > 0 && s[close + 1] === "(") {
        const pend = findParen(s, close + 2);
        if (pend > 0) {
          const text = s.slice(open + 1, close);
          let target = s.slice(close + 2, pend).trim();
          let title = null;
          const tm = target.match(/^(\S+)\s+"([^"]*)"$/);
          if (tm) { target = tm[1]; title = tm[2]; }
          if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
          if (img) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(target.replace(/[\t\n\r]/g, "")) || /^[\\/]{2}/.test(target)) throw new Error(`image must be a local file: ${target}`);
            if (text.trim() === "") throw new Error(`image ${target} has no alt text`);
            (ctx.images ||= []).push(target);
            out += `<img src="${esc(target)}" alt="${esc(text)}" loading="lazy">`;
          } else {
            const url = checkUrl(target, "link");
            (ctx.links ||= []).push(url);
            const ext = /^https?:/i.test(url);
            out += `<a href="${esc(url)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' rel="noopener noreferrer" class="ext"' : ""}>${inline(text, ctx)}</a>`;
          }
          i = pend + 1;
          continue;
        }
      }
    }
    if (c === "<") {
      const m = s.slice(i).match(/^<(https?:\/\/[^\s<>]+)>/);
      if (m) {
        (ctx.links ||= []).push(m[1]);
        out += `<a href="${esc(m[1])}" rel="noopener noreferrer" class="ext">${esc(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const dbl = s[i + 1] === c && c === "*";
      const delim = dbl ? "**" : c;
      const after = s[i + delim.length];
      const before = i > 0 ? s[i - 1] : " ";
      const canOpen = after !== undefined && !/\s/.test(after) && !(c === "_" && /[A-Za-z0-9]/.test(before));
      if (canOpen) {
        const close = findClose(s, i + delim.length, delim);
        if (close > 0) {
          const inner = s.slice(i + delim.length, close);
          out += dbl ? `<strong>${inline(inner, ctx)}</strong>` : `<em>${inline(inner, ctx)}</em>`;
          i = close + delim.length;
          continue;
        }
      }
    }
    out += esc(c);
    i++;
  }
  return out;
}

/**
 * Link backticked primer slugs that sit outside parentheses (STYLE.md A.4: a primer the chapter
 * requires is its backticked slug, outside parentheses). Works on Markdown source.
 */
export function linkPrimerSlugs(s, slugs, urlFor) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > 0) {
        const word = s.slice(i + 1, end);
        const prevIsLink = s[i - 1] === "[";
        out += depth === 0 && !prevIsLink && slugs.has(word) ? `[\`${word}\`](${urlFor(word)})` : s.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks

/** Each highlighted line is a display:block span, so the newline between spans must go. */
export const blockLines = (html) => html.replace(/<\/span>\n<span class="line/g, '</span><span class="line');

const RE = {
  fence: /^(\s{0,3})(`{3,}|~{3,})\s*([^`\s]*)\s*(.*)$/,
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/,
  bullet: /^(\s{0,3})([-*+])(\s+)(.*)$/,
  ordered: /^(\s{0,3})(\d{1,9})([.)])(\s+)(.*)$/,
  quote: /^\s{0,3}>\s?(.*)$/,
  directive: /^:::([a-z-]*)(?:\s+(.*))?$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
};

function isBlank(l) { return l.t.trim() === ""; }

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && t[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (c === "`") {
      const run = t.slice(i).match(/^`+/)[0];
      const end = t.indexOf(run, i + run.length);
      if (end > 0) { cur += t.slice(i, end + run.length); i = end + run.length - 1; continue; }
    }
    if (c === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Render a Markdown body.
 *
 * opts:
 *   file, startLine        for error messages
 *   headingShift           added to every heading level (primers: their `#` becomes h2 with -0, see below)
 *   minHeading, maxHeading allowed source levels (chapters: 2..3)
 *   h1As                   render a source `#` as this level (primers: 2)
 *   hooks                  { code(args), term(args), lab(name, args), retrieval(args), checkpoint(args),
 *                            diagram(args), conceptsHead(), primerSlugs: Set, primerUrl(slug) }
 * Returns { html, headings: [{level, id, text}], counts, labs, links, ids }.
 */
export function renderMarkdown(src, opts = {}) {
  const file = opts.file;
  const hooks = opts.hooks || {};
  const minH = opts.minHeading ?? 1;
  const maxH = opts.maxHeading ?? 4;
  const state = {
    headings: [],
    counts: {},
    labs: [],
    ctx: { links: [], images: [] },
    ids: new Set(opts.reservedIds || []),
    warnings: [],
  };
  const warn = (msg, line) => state.warnings.push(`${file || "<markdown>"}${line ? `:${line}` : ""}: ${msg}`);
  const fail = (msg, line) => { throw new MarkdownError(msg, file, line); };
  const uniqueId = (base) => {
    let id = base, n = 2;
    while (state.ids.has(id)) id = `${base}-${n++}`;
    state.ids.add(id);
    return id;
  };
  const inl = (s, ln) => {
    try { return inline(s, state.ctx); } catch (e) { return fail(e.message, ln); }
  };

  const start = opts.startLine || 1;
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n").map((t, k) => ({ t: t.replace(/\t/g, "    "), ln: start + k }));

  function startsBlock(l, inQuote) {
    const t = l.t;
    return RE.fence.test(t) || RE.heading.test(t) || RE.hr.test(t) || RE.bullet.test(t) || RE.ordered.test(t) ||
      RE.quote.test(t) || (!inQuote && RE.directive.test(t));
  }

  function codeBlock(body, lang, ln) {
    const info = lang.toLowerCase();
    let L = normalizeLang(info);
    let label = null;
    if (info === "mermaid") {
      fail("a ```mermaid fence would show diagram source, not a diagram (DESIGN.md section 3.6): pre-render it with node course/site/tools/diagrams.mjs and use :::diagram src=docs/diagrams/NAME.svg alt=\"...\"", ln);
    } else if (!L && ["xml", "html", "console", "plist", "diff"].includes(info)) L = "text";
    if (!L) fail(`unsupported code language "${lang}"`, ln);
    const shell = L === "shell";
    const html = blockLines(highlight(body, L));
    return (
      `<figure class="code code--fence" data-lang="${esc(L)}">` +
      (label || shell ? `<figcaption>${label ? `<span class="path">${esc(label)}</span>` : `<span class="path">Shell</span>`}` +
        (shell ? `<button class="copy" type="button" aria-label="Copy these commands">Copy</button>` : "") + `</figcaption>` : "") +
      `<pre tabindex="0" data-scroll-label="${shell ? "Shell commands" : "Code"}"><code>${html}</code></pre></figure>`
    );
  }

  function count(name) { state.counts[name] = (state.counts[name] || 0) + 1; }

  /** Parse lines[i..end) into HTML. `container` is the enclosing directive name or null. */
  function blocks(ls, container, inQuote) {
    let out = "";
    let i = 0;
    while (i < ls.length) {
      const l = ls[i];
      const t = l.t;
      if (isBlank(l)) { i++; continue; }

      // Fenced code
      let m = t.match(RE.fence);
      if (m) {
        const indent = m[1].length;
        const fence = m[2];
        const body = [];
        let j = i + 1;
        for (; j < ls.length; j++) {
          const c = ls[j].t;
          if (c.trimStart().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(c) && c.trim()[0] === fence[0]) break;
          body.push(c.slice(Math.min(indent, c.length - c.trimStart().length)));
        }
        if (j >= ls.length) fail("code fence is never closed", l.ln);
        out += codeBlock(body.join("\n"), m[3], l.ln);
        i = j + 1;
        continue;
      }

      // Directives
      if (!inQuote && (m = t.match(RE.directive))) {
        const name = m[1];
        const rest = (m[2] || "").trim();
        if (name === "") {
          fail(`":::" closes nothing${container ? "" : " (leaf directives such as :::lab take no closer)"}`, l.ln);
        }
        if (CONTAINERS.has(name)) {
          if (container) fail(`:::${name} opened inside :::${container} (containers do not nest)`, l.ln);
          let j = i + 1, fenced = false;
          const inner = [];
          for (; j < ls.length; j++) {
            const c = ls[j].t;
            if (RE.fence.test(c)) fenced = !fenced;
            if (!fenced && c === ":::") break;
            inner.push(ls[j]);
          }
          if (j >= ls.length) fail(`:::${name} is never closed`, l.ln);
          count(name);
          out += container_(name, rest, inner, l.ln);
          i = j + 1;
          continue;
        }
        if (LEAVES.has(name)) {
          count(name);
          out += leaf(name, rest, l.ln);
          i++;
          continue;
        }
        fail(`unknown directive :::${name}`, l.ln);
      }

      // Headings
      if ((m = t.match(RE.heading))) {
        const lvl = m[1].length;
        if (lvl < minH || lvl > maxH) fail(`heading level ${lvl} not allowed here (allowed: ${minH} to ${maxH})`, l.ln);
        if (container) fail(`heading inside :::${container}`, l.ln);
        const level = lvl === 1 && opts.h1As ? opts.h1As : lvl;
        const text = m[2];
        const id = uniqueId(slugify(text));
        const html = inl(text, l.ln);
        state.headings.push({ level, id, text: unescapeHtml(html.replace(/<[^>]+>/g, "")) });
        out += `<h${level} id="${id}">${html}<a class="h-anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a></h${level}>\n`;
        i++;
        continue;
      }

      if (RE.hr.test(t)) { out += "<hr>\n"; i++; continue; }

      // Tables
      if (t.trim().startsWith("|") && i + 1 < ls.length && RE.tableSep.test(ls[i + 1].t) && ls[i + 1].t.includes("-")) {
        const head = splitRow(t);
        const aligns = splitRow(ls[i + 1].t).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
        if (aligns.length !== head.length) fail(`table separator has ${aligns.length} cells, header has ${head.length}`, ls[i + 1].ln);
        let j = i + 2;
        const rows = [];
        while (j < ls.length && ls[j].t.trim().startsWith("|")) { rows.push({ cells: splitRow(ls[j].t), ln: ls[j].ln }); j++; }
        const cls = (k) => (aligns[k] ? ` class="al-${aligns[k]}"` : "");
        const tlabel = `Table: ${head.map((c) => unescapeHtml(inl(c, l.ln).replace(/<[^>]+>/g, ""))).filter(Boolean).join(", ")}`.slice(0, 120);
        let h = `<div class="table-wrap" data-scroll-label="${esc(tlabel)}"><table>\n<thead><tr>${head.map((c, k) => `<th scope="col"${cls(k)}>${inl(c, l.ln)}</th>`).join("")}</tr></thead>\n<tbody>\n`;
        for (const r of rows) {
          if (r.cells.length > head.length) fail(`table row has ${r.cells.length} cells, header has ${head.length}`, r.ln);
          const cells = head.map((_, k) => r.cells[k] ?? "");
          h += `<tr>${cells.map((c, k) => `<td${cls(k)}>${inl(c, r.ln)}</td>`).join("")}</tr>\n`;
        }
        out += h + "</tbody></table></div>\n";
        i = j;
        continue;
      }

      // Blockquotes and callouts
      if (RE.quote.test(t)) {
        const inner = [];
        let j = i;
        while (j < ls.length) {
          const qm = ls[j].t.match(RE.quote);
          if (qm) { inner.push({ t: qm[1], ln: ls[j].ln }); j++; continue; }
          if (!isBlank(ls[j]) && inner.length && !isBlank(inner.at(-1)) && !startsBlock(ls[j], true)) { inner.push(ls[j]); j++; continue; }
          break;
        }
        out += quote(inner, container);
        i = j;
        continue;
      }

      // Lists
      if (RE.bullet.test(t) || RE.ordered.test(t)) {
        const r = list(ls, i, container, inQuote);
        out += r.html;
        i = r.next;
        continue;
      }

      // Paragraph
      const para = [l];
      let j = i + 1;
      while (j < ls.length && !isBlank(ls[j]) && !startsBlock(ls[j], inQuote) &&
        !(ls[j].t.trim().startsWith("|") && j + 1 < ls.length && RE.tableSep.test(ls[j + 1].t))) {
        para.push(ls[j]);
        j++;
      }
      const text = para.map((p, k) => {
        const s = k === para.length - 1 ? p.t.trim() : p.t.replace(/^\s+/, "");
        return k < para.length - 1 && / {2,}$/.test(s) ? `${s.trimEnd()}\\` : s.trimEnd();
      });
      const html = inl(text.join("\n"), l.ln);
      out += `<p>${html}</p>\n`;
      i = j;
    }
    return out;
  }

  function list(ls, i, container, inQuote) {
    const first = ls[i].t;
    const ordered = RE.ordered.test(first);
    const markerOf = (t) => {
      const m = ordered ? t.match(RE.ordered) : t.match(RE.bullet);
      if (!m) return null;
      if (ordered) return { indent: m[1].length, num: Number(m[2]), delim: m[3], content: m[1].length + m[2].length + 1 + m[4].length, rest: m[5] };
      return { indent: m[1].length, delim: m[2], content: m[1].length + 1 + m[3].length, rest: m[4] };
    };
    const m0 = markerOf(first);
    const items = [];
    let loose = false;
    let j = i;
    while (j < ls.length) {
      const mk = markerOf(ls[j].t);
      if (!mk || mk.delim !== m0.delim || mk.indent > m0.indent + 1) break;
      const contentIndent = mk.content > mk.indent + 5 ? mk.indent + 2 : mk.content;
      const body = [{ t: mk.rest, ln: ls[j].ln }];
      let k = j + 1;
      let sawBlank = false;
      while (k < ls.length) {
        const l = ls[k];
        if (isBlank(l)) { body.push({ t: "", ln: l.ln }); sawBlank = true; k++; continue; }
        const ind = l.t.length - l.t.trimStart().length;
        if (ind >= contentIndent) { body.push({ t: l.t.slice(contentIndent), ln: l.ln }); sawBlank = false; k++; continue; }
        if (!sawBlank && !startsBlock(l, inQuote) && !isBlank(body.at(-1))) { body.push({ t: l.t.trim(), ln: l.ln }); k++; continue; }
        break;
      }
      // Trailing blank lines belong between items, not inside the item.
      let trail = 0;
      while (body.length > 1 && isBlank(body.at(-1))) { body.pop(); trail++; }
      if (body.some((b, n) => n > 0 && isBlank(b) && n < body.length - 1)) loose = true;
      items.push(body);
      j = k;
      if (trail && j < ls.length) {
        const next = markerOf(ls[j].t);
        if (next && next.delim === m0.delim && next.indent <= m0.indent + 1) loose = true;
        else { j -= trail; break; }
      }
    }
    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered && m0.num !== 1 ? ` start="${m0.num}"` : "";
    let html = `<${tag}${startAttr}>\n`;
    for (const body of items) {
      let inner = blocks(body, container, inQuote).trim();
      if (!loose) inner = inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
      html += `<li>${inner}</li>\n`;
    }
    html += `</${tag}>\n`;
    return { html, next: j };
  }

  function quote(inner, container) {
    const first = inner.find((x) => !isBlank(x));
    const lm = first && first.t.match(/^\*\*([^*]+?)\*\*\s*(.*)$/);
    if (!lm) return `<blockquote>\n${blocks(inner, container, true)}</blockquote>\n`;
    let label = lm[1].trim();
    let rest = lm[2];
    // "**Aside.**", "**Aside: why ...**", "**Under the hood**": the label is the bold run.
    label = label.replace(/[.:]$/, "");
    if (rest.startsWith(".") || rest.startsWith(":")) rest = rest.slice(1).trimStart();
    if (/^predict\b/i.test(label)) {
      fail(`"> **${label}**" blockquote: a prediction is a :::predict container (STYLE.md section 7), so the answer stays hidden until the reader opens it`, first.ln);
    }
    if (!CALLOUT_LABELS.some((L) => label.toLowerCase().startsWith(L.toLowerCase()))) {
      warn(`blockquote label "${label}" is not one of the STYLE.md section 7 callouts (${CALLOUT_LABELS.join(", ")}); it renders as a plain note`, first.ln);
    }
    const kind = /^security\b/i.test(label) ? "security" : /^under the hood\b/i.test(label) ? "why" : "note";
    const idx = inner.indexOf(first);
    const body = [...inner.slice(0, idx), { t: rest, ln: first.ln }, ...inner.slice(idx + 1)];
    count(`callout-${kind}`);
    return callout(kind, inl(label, first.ln), blocks(body, container, true));
  }

  function callout(kind, labelHtml, bodyHtml) {
    const icon = { security: ICONS.shield, why: ICONS.gear, warn: ICONS.aside, mac: ICONS.chip, note: ICONS.aside }[kind];
    return `<div class="callout callout--${kind}" role="note"><p class="callout__label">${icon}<span>${labelHtml}</span></p>\n${bodyHtml}</div>\n`;
  }

  function container_(name, rest, inner, ln) {
    switch (name) {
      case "objectives":
        return `<div class="box box--objectives"><p class="box__title">${ICONS.check}<span>Objectives: by the end you can</span></p>\n${blocks(inner, name, false)}</div>\n`;
      case "prereqs":
        return `<div class="box box--prereqs"><p class="box__title">${ICONS.box}<span>Before you start</span></p>\n${hooks.prereqsHead ? hooks.prereqsHead() : ""}${blocks(inner, name, false)}</div>\n`;
      case "concepts": {
        const linked = hooks.primerSlugs
          ? inner.map((x) => ({ ...x, t: linkPrimerSlugs(x.t, hooks.primerSlugs, hooks.primerUrl) }))
          : inner;
        return `<div class="box box--concepts"><p class="box__title">${ICONS.box}<span>Concepts you'll need</span></p>\n${hooks.conceptsHead ? hooks.conceptsHead() : ""}${blocks(linked, name, false)}</div>\n`;
      }
      case "predict": {
        if (!rest) fail(":::predict needs its question on the same line", ln);
        return `<details class="predict"><summary><span class="predict__label">${ICONS.question}Predict</span> <span class="predict__q">${inl(rest, ln)}</span> <span class="predict__reveal" aria-hidden="true"></span></summary>\n<div class="predict__answer">${blocks(inner, name, false)}</div></details>\n`;
      }
      case "callout": {
        const { args } = parseArgs(rest);
        const kind = args.kind || "note";
        if (!CALLOUT_KINDS.has(kind)) fail(`:::callout kind=${kind} (want one of ${[...CALLOUT_KINDS].join(", ")})`, ln);
        const title = args.title || { note: "Note", why: "Why it works this way", warn: "Careful", security: "Hostile input", mac: "On a Mac" }[kind];
        count(`callout-${kind}`);
        return callout(kind, inl(title, ln), blocks(inner, name, false));
      }
    }
    return fail(`unhandled container ${name}`, ln);
  }

  function leaf(name, rest, ln) {
    const { args, words } = parseArgs(rest);
    const call = (fn, ...a) => {
      if (!hooks[fn]) fail(`:::${name} is not available on this page`, ln);
      try { return hooks[fn](...a); } catch (e) { return fail(e.message, ln); }
    };
    switch (name) {
      case "code":
        if (!args.anchor || !args.file) fail(":::code needs both anchor= and file=", ln);
        return call("code", args);
      case "term":
        if (!args.source) fail(":::term needs source=", ln);
        return call("term", args);
      case "diagram":
        if (!args.src || !args.alt) fail(":::diagram needs src= and alt=", ln);
        return call("diagram", args);
      case "lab": {
        const lab = words[0];
        if (!lab || !/^[a-z][a-z0-9-]*$/.test(lab)) fail(":::lab needs a lab name", ln);
        state.labs.push(lab);
        return call("lab", lab, args);
      }
      case "checkpoint":
        return call("checkpoint", args);
      case "retrieval":
        return call("retrieval", args);
      case "stopping-point": {
        const label = rest || "Good place to stop.";
        return `<div class="stop"><p>${ICONS.pen}<span>${inl(label, ln)}</span></p></div>\n`;
      }
    }
    return fail(`unhandled directive ${name}`, ln);
  }

  const html = blocks(lines, null, false);
  return { html, headings: state.headings, counts: state.counts, labs: state.labs, links: state.ctx.links, images: state.ctx.images, ids: state.ids, warnings: state.warnings };
}
