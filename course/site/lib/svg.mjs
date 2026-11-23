// Inline-SVG sanitizer for diagrams (`:::diagram`) and lab fallbacks (`fallback.svg`).
//
// An inlined SVG is part of the page, so it must obey the page's Content-Security-Policy
// (DESIGN.md §7): no scripts, no event handlers, no inline styles, nothing loaded from elsewhere.
// Rather than silently strip, we refuse: an author fixes the file once and the build stays
// predictable. Accessibility (DESIGN.md §3.6): every inlined SVG needs a <title> and a <desc>;
// the builder wires them to aria-labelledby with page-unique ids.

const FORBIDDEN = [
  [/<script\b/i, "a <script> element"],
  [/<foreignObject\b/i, "a <foreignObject> element"],
  [/<style\b/i, "a <style> element (the CSP allows no inline styles; use classes and the site's CSS tokens)"],
  // HTML accepts "/" as well as whitespace before an attribute name (`<rect/onclick=...>`).
  [/[\s/]on[a-z]+\s*=/i, "an on* event-handler attribute"],
  [/[\s/]style\s*=/i, "a style= attribute (the CSP allows no inline styles)"],
  [/javascript:/i, "a javascript: URL"],
  [/<!ENTITY/i, "an XML entity declaration"],
  [/<iframe\b|<embed\b|<object\b/i, "an embedded document"],
  [/(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/|data:)/i, "an external or data: reference"],
  [/(?:href|src)\s*=\s*["']?[^"'>]*&#/i, "a character reference inside href/src (write the URL plainly)"],
  [/url\(\s*["']?\s*(?:https?:|\/\/|data:)/i, "an external url() reference"],
];

/**
 * Validate and prepare an SVG for inlining. `idPrefix` makes title/desc ids page-unique.
 * Returns the <svg>...</svg> markup with role="img" and aria-labelledby set. Throws on any
 * forbidden construct or a missing <title>/<desc>.
 */
export function sanitizeSvg(text, idPrefix, { alt } = {}) {
  let s = String(text).replace(/^﻿/, "");
  s = s.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  // Test the text as a browser would read it too: numeric character references decoded, so
  // `&#x6A;avascript:` cannot hide a javascript: URL. Both forms must pass.
  const decoded = decodeCharRefs(s);
  for (const [re, what] of FORBIDDEN) if (re.test(s) || re.test(decoded)) throw new Error(`SVG contains ${what}`);
  if (!/^<svg\b[^>]*>[\s\S]*<\/svg>$/.test(s)) throw new Error("not a single <svg> element");
  const title = s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/);
  let desc = s.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/);
  if (!title) throw new Error("SVG has no <title> (DESIGN.md §3.6)");
  if (!desc && !alt) throw new Error("SVG has no <desc> (DESIGN.md §3.6)");
  const tid = `${idPrefix}-t`, did = `${idPrefix}-d`;
  s = s.replace(/<title\b[^>]*>/, `<title id="${tid}">`);
  if (desc) s = s.replace(/<desc\b[^>]*>/, `<desc id="${did}">`);
  else s = s.replace(/(<\/title>)/, `$1<desc id="${did}">${escXml(alt)}</desc>`);
  s = s.replace(/^<svg\b([^>]*)>/, (m, attrs) => {
    const clean = attrs.replace(/\s(?:role|aria-labelledby|aria-label|width|height)\s*=\s*("[^"]*"|'[^']*')/g, "");
    return `<svg${clean} role="img" aria-labelledby="${tid} ${did}">`;
  });
  return s;
}

function decodeCharRefs(s) {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&(?:tab|newline);/gi, "");
}
const safeChar = (n) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

/** Min-width steps for wide inline SVGs (course.css gets `.minw-N` for each step). */
export const MINW_STEP = 40;
export const MINW_MAX = 1600;
/** The narrowest column an inline SVG sits in: a lab or prose column at a 360px viewport. */
export const NARROWEST = 290;
export const MIN_TEXT_PX = 12;

/**
 * The min-width (px, a MINW_STEP multiple) an SVG needs so its smallest text renders at 12px or
 * more, or 0 when it already does in the narrowest column.
 */
export function svgMinWidth(svg) {
  const m = viewBoxAndFont(svg);
  if (!m) return 0;
  const need = (MIN_TEXT_PX * m.vw) / m.minFont; // rendered width at which the smallest text is 12px
  if (need <= NARROWEST) return 0;
  return Math.min(MINW_MAX, Math.ceil(need / MINW_STEP) * MINW_STEP);
}

/** Diagram text renders no larger than body text (17px), however wide the column. */
export const MAX_TEXT_PX = 17;
/** The widest a diagram renders anyway: `.diagram svg { max-width: 44rem }` in course.css. */
export const DIAGRAM_MAX = 704;

/**
 * The max-width (px, a MINW_STEP multiple) at which an SVG's smallest text reaches 17px, or 0
 * when the diagram column's own 44rem cap comes first. A diagram drawn narrow, to fit a phone,
 * would otherwise be scaled up until its text is twice the size of the prose around it.
 */
export function svgMaxWidth(svg) {
  const m = viewBoxAndFont(svg);
  if (!m) return 0;
  const cap = Math.floor((MAX_TEXT_PX * m.vw) / m.minFont / MINW_STEP) * MINW_STEP;
  return cap >= DIAGRAM_MAX ? 0 : Math.max(cap, MINW_STEP * 8);
}

/** The viewBox width and the smallest font-size attribute (default 16, the browser's). */
function viewBoxAndFont(svg) {
  const vb = svg.match(/<svg\b[^>]*\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (!vb) return null;
  const sizes = [...svg.matchAll(/\sfont-size\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/gi)].map((m) => Number(m[1])).filter((n) => n > 0);
  return { vw: Number(vb[1]), minFont: sizes.length ? Math.min(...sizes) : 16 };
}

function escXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
