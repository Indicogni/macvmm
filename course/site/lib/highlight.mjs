// Build-time syntax highlighter. Regex tokenizers for the handful of languages lessons use
// (DESIGN.md §3.1): Rust, C, shell, AArch64 assembly, TOML, DTS, JSON and plain text.
// No runtime highlighter ships to the browser.
//
// Output: one <span class="line"> per source line (so CSS counters can number lines without
// putting numbers into the copied text), with tokens as <span class="tok-k|s|c|n|f|t">:
//   k keyword  s string  c comment  n number  f function/label/key  t type/register/attribute
// Tokens that span lines (block comments, raw strings) are closed and reopened at each newline.

import { esc } from "./html.mjs";

const RUST_KW =
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while union";
const RUST_TY =
  "u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str String Vec Option Result Box Some None Ok Err";
const C_KW =
  "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while true false NULL";
const C_TY = "void char short int long float double signed unsigned bool size_t uint8_t uint16_t uint32_t uint64_t int32_t int64_t uintptr_t";
const SH_KW =
  "if then else elif fi for while until do done case esac in function return local export readonly set unset shift exit source trap select time";
const SH_BUILTIN = "echo printf cd pwd test read eval exec cargo git make codesign xcrun node npx npm curl shasum sha256sum mkdir rm cp mv cat grep sed awk";

const words = (s) => new Set(s.split(/\s+/));

/** Each rule: [class | null | function(match)->class, sticky regex]. First match wins. */
const LANGS = {
  rust: () => {
    const kw = words(RUST_KW), ty = words(RUST_TY);
    return [
      ["c", /\/\/[^\n]*/y],
      ["c", /\/\*[\s\S]*?\*\//y],
      ["s", /b?r(#*)"[\s\S]*?"\1/y],
      ["s", /b?"(?:\\[\s\S]|[^"\\])*"/y],
      ["s", /b?'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^'\\\n])'/y],
      ["t", /'[A-Za-z_][A-Za-z0-9_]*/y], // lifetime
      ["t", /#!?\[[^\]\n]*\]/y], // attribute
      ["n", /\b(?:0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[iu](?:8|16|32|64|128|size)|f32|f64)?\b/y],
      [(m) => (kw.has(m[0]) ? "k" : ty.has(m[0]) || /^[A-Z]/.test(m[0]) ? "t" : "f"), /[A-Za-z_][A-Za-z0-9_]*(?=\s*(?:!|::<|\())/y],
      [(m) => (kw.has(m[0]) ? "k" : ty.has(m[0]) || /^[A-Z][A-Za-z0-9]*$/.test(m[0]) ? "t" : /^[A-Z][A-Z0-9_]+$/.test(m[0]) ? "n" : null), /[A-Za-z_][A-Za-z0-9_]*/y],
    ];
  },
  c: () => {
    const kw = words(C_KW), ty = words(C_TY);
    return [
      ["c", /\/\/[^\n]*/y],
      ["c", /\/\*[\s\S]*?\*\//y],
      ["k", /#\s*[a-z]+/y],
      ["s", /"(?:\\[\s\S]|[^"\\\n])*"/y],
      ["s", /'(?:\\.|[^'\\\n])'/y],
      ["n", /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)[uUlL]*\b/y],
      [(m) => (kw.has(m[0]) ? "k" : ty.has(m[0]) ? "t" : "f"), /[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/y],
      [(m) => (kw.has(m[0]) ? "k" : ty.has(m[0]) || /_t$/.test(m[0]) ? "t" : /^[A-Z][A-Z0-9_]+$/.test(m[0]) ? "n" : null), /[A-Za-z_][A-Za-z0-9_]*/y],
    ];
  },
  shell: () => {
    const kw = words(SH_KW), bi = words(SH_BUILTIN);
    return [
      ["c", /(?<![^\s;|&(])#[^\n]*/y],
      ["s", /'[^']*'/y],
      ["s", /"(?:\\[\s\S]|[^"\\])*"/y],
      ["t", /\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9#?@*$!-])/y],
      ["n", /(?<![\w-])\d+(?![\w-])/y],
      [(m) => (kw.has(m[0]) ? "k" : bi.has(m[0]) ? "f" : null), /(?<![\w./-])[A-Za-z_][A-Za-z0-9_-]*(?![\w./-])/y],
    ];
  },
  asm: () => [
    ["c", /(?:\/\/|;|@)[^\n]*/y],
    ["c", /\/\*[\s\S]*?\*\//y],
    ["f", /^[ \t]*[A-Za-z_.$][\w.$]*:/my],
    ["k", /^[ \t]*\.[A-Za-z_][\w]*/my],
    ["k", /^[ \t]*[a-z][a-z0-9.]*(?=\s|$)/my],
    ["s", /"(?:\\.|[^"\\\n])*"/y],
    ["n", /#?-?(?:0x[0-9a-fA-F_]+|\d+)\b/y],
    ["t", /\b(?:[xw](?:[12]?\d|30)|sp|xzr|wzr|lr|fp|pc|[A-Z][A-Z0-9]*_EL[0-3]|[a-z]+_el[0-3]|daif\w*|nzcv)\b/y],
  ],
  toml: () => [
    ["c", /#[^\n]*/y],
    ["k", /^[ \t]*\[\[?[^\]\n]+\]\]?/my],
    ["f", /^[ \t]*[A-Za-z0-9_.-]+(?=\s*=)/my],
    ["s", /"""[\s\S]*?"""|'''[\s\S]*?'''/y],
    ["s", /"(?:\\.|[^"\\\n])*"|'[^'\n]*'/y],
    ["n", /\b(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?)\b/y],
    ["k", /\b(?:true|false)\b/y],
  ],
  dts: () => [
    ["c", /\/\/[^\n]*/y],
    ["c", /\/\*[\s\S]*?\*\//y],
    ["k", /\/[a-z-]+\//y],
    ["s", /"(?:\\.|[^"\\\n])*"/y],
    ["k", /&[A-Za-z_][\w]*/y],
    ["f", /[A-Za-z_][\w,.+-]*(?:@[0-9a-fA-F,]+)?(?=\s*\{)/y],
    ["t", /#?[A-Za-z_][\w,.+-]*(?=\s*[=;])/y],
    ["n", /\b(?:0x[0-9a-fA-F]+|\d+)\b/y],
  ],
  json: () => [
    ["f", /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
    ["s", /"(?:\\.|[^"\\\n])*"/y],
    ["n", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ["k", /\b(?:true|false|null)\b/y],
  ],
  text: () => [],
};

const ALIASES = {
  rust: "rust", rs: "rust",
  c: "c", h: "c",
  shell: "shell", sh: "shell", bash: "shell", zsh: "shell",
  asm: "asm", s: "asm", armasm: "asm", aarch64: "asm",
  toml: "toml",
  dts: "dts", dtsi: "dts",
  json: "json", jsonl: "json",
  text: "text", txt: "text", plain: "text", "": "text",
};

/** Normalise a fence/info-string language; returns null if unsupported. */
export function normalizeLang(lang) {
  const k = String(lang ?? "").trim().toLowerCase();
  return Object.hasOwn(ALIASES, k) ? ALIASES[k] : null;
}

/** Guess a language from a file extension (for :::code file=...). */
export function langForFile(path) {
  const base = path.split("/").pop();
  const ext = base.includes(".") ? base.split(".").pop() : "";
  if (ext === "S") return "asm";
  if (["sh", "bash"].includes(ext) || /^(setup|doctor|learner|checkpoint)$/.test(base)) return "shell";
  const n = normalizeLang(ext);
  return n && n !== "text" ? n : "text";
}

export const SUPPORTED_LANGS = Object.keys(LANGS);

/** Tokenize `code` in `lang` into [{cls, text}] covering every character. */
export function tokenize(code, lang) {
  const L = normalizeLang(lang);
  if (!L) throw new Error(`unsupported code language "${lang}" (supported: ${SUPPORTED_LANGS.join(", ")})`);
  const rules = LANGS[L]();
  const out = [];
  let plain = "";
  let i = 0;
  const flush = () => { if (plain) { out.push({ cls: null, text: plain }); plain = ""; } };
  outer: while (i < code.length) {
    for (const [cls, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (!m || m[0].length === 0) continue;
      const c = typeof cls === "function" ? cls(m) : cls;
      if (c) { flush(); out.push({ cls: c, text: m[0] }); }
      else plain += m[0];
      i += m[0].length;
      continue outer;
    }
    plain += code[i++];
  }
  flush();
  return out;
}

/**
 * Highlight `code` into HTML lines. `addLines` is a Set of 1-based line numbers rendered as
 * additions (diff-style "+" gutter and accent bar).
 */
export function highlight(code, lang, { addLines = new Set() } = {}) {
  const toks = tokenize(code.replace(/\n$/, ""), lang);
  const lines = [[]];
  for (const t of toks) {
    const parts = t.text.split("\n");
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines.at(-1).push(t.cls ? `<span class="tok-${t.cls}">${esc(p)}</span>` : esc(p));
    });
  }
  return lines
    .map((l, k) => `<span class="line${addLines.has(k + 1) ? " add" : ""}">${l.join("")}</span>`)
    .join("\n");
}
