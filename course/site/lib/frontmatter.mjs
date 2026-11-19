// Front-matter parser for lesson and primer Markdown. No YAML library on purpose: the format is a
// closed, flat subset (DESIGN.md §9), so a lesson cannot smuggle in structure the builder ignores.
//
//   ---
//   title: Generate a DTB
//   runs: mac+browser          # comment (needs whitespace before '#' and after it)
//   prereqs: [2.4, 3.1]         inline list
//   labs:                       block list
//   - dtb-explorer
//   expect: PASS dtb: 7 nodes   only the first ": " splits key from value
//   draft: true                 true/false become booleans; nothing else is coerced
//   ---
//
// Values stay strings unless they are `true`/`false` or a list. Numeric fields are validated by
// the caller, which knows which keys are numbers.

export class FrontMatterError extends Error {
  constructor(msg, line) {
    super(line ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

function stripComment(v) {
  // "a  # note" -> "a". A '#' with no space before it (e.g. "C#", "#address-cells") is kept.
  const m = v.match(/^(.*?)\s+#\s.*$/) || v.match(/^(.*?)\s+#$/);
  return (m ? m[1] : v).trim();
}

function unquote(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) return v.slice(1, -1);
  return v;
}

function scalar(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  return unquote(v);
}

/**
 * Split `text` into { data, body, bodyLine }. `bodyLine` is the 1-based line where the body starts,
 * so Markdown diagnostics can report real file lines. A file with no front matter returns data {}.
 */
export function parseFrontMatter(text) {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!src.startsWith("---\n")) return { data: {}, body: src, bodyLine: 1 };
  const lines = src.split("\n");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new FrontMatterError("front matter opened with --- but never closed", 1);
  const data = {};
  let listKey = null;
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const ln = i + 1;
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const item = raw.match(/^\s*-\s+(.*)$/);
    if (item) {
      if (!listKey) throw new FrontMatterError("list item without a key above it", ln);
      data[listKey].push(scalar(stripComment(item[1])));
      continue;
    }
    const kv = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!kv) throw new FrontMatterError(`cannot parse "${raw}" (expected "key: value")`, ln);
    const [, key, rest = ""] = kv;
    if (Object.hasOwn(data, key)) throw new FrontMatterError(`duplicate key "${key}"`, ln);
    const v = stripComment(rest);
    if (v === "") {
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    if (v.startsWith("[")) {
      if (!v.endsWith("]")) throw new FrontMatterError(`unterminated inline list for "${key}"`, ln);
      const inner = v.slice(1, -1).trim();
      data[key] = inner === "" ? [] : inner.split(",").map((s) => scalar(s.trim()));
    } else {
      data[key] = scalar(v);
    }
  }
  return { data, body: lines.slice(end + 1).join("\n"), bodyLine: end + 2 };
}
