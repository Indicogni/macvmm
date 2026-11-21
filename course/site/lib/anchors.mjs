// Code anchors: the JS half of ADR-0006, mirroring crates/xtask/src/anchors.rs line for line.
//
// Lessons never paste code. They say `:::code anchor=NAME file=PATH` and the builder pulls the
// region between `// ANCHOR: NAME` and `// ANCHOR_END: NAME` out of the real source file, so a
// snippet cannot drift from the code it describes. `scripts/check-anchors` (Rust) and this module
// must agree on every rule, so a lesson that passes one passes the other:
//
//   - a marker is a whole line, after trimming, in the file's comment syntax (see syntaxFor);
//   - names match ^[a-z][a-z0-9_]*$;
//   - the body is the lines strictly between the markers, with every nested marker line
//     (ANCHOR or LEARNER, start or end) dropped, common leading indentation removed and
//     trailing whitespace trimmed;
//   - errors: unterminated, duplicate in one file, end without start, partial overlap, empty
//     region, more than MAX_REGION_LINES lines, invalid name. Markdown code fences are skipped
//     in HTML-syntax files.

export const MAX_REGION_LINES = 60;

/** Comment syntax for markers, from a repo-relative path; null when a file cannot carry markers. */
export function syntaxFor(path) {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : null;
  if (ext === null) return "hash"; // extensionless scripts
  if (["rs", "js", "mjs", "cjs", "ts", "swift", "m"].includes(ext)) return "slash";
  if (["c", "h", "S"].includes(ext)) return "slash-block";
  if (ext === "ld") return "linker";
  if (["sh", "bash", "toml", "py", "yml", "yaml", "txt"].includes(ext)) return "hash";
  if (["md", "html", "htm", "xml", "plist", "svg"].includes(ext)) return "html";
  return null;
}

const KEYWORDS = ["ANCHOR", "LEARNER"];

/** Parse one line as a marker: { keyword, end, name } or null. */
export function parseMarker(line, syntax) {
  const t = line.trim();
  let inner = null;
  const block = () => (t.startsWith("/*") && t.endsWith("*/") && t.length >= 4 ? t.slice(2, -2) : null);
  switch (syntax) {
    case "slash": inner = t.startsWith("//") ? t.slice(2) : null; break;
    case "slash-block": inner = t.startsWith("//") ? t.slice(2) : block(); break;
    case "hash": inner = t.startsWith("#") ? t.slice(1) : null; break;
    case "html": inner = t.startsWith("<!--") && t.endsWith("-->") && t.length >= 7 ? t.slice(4, -3) : null; break;
    case "linker": inner = t.startsWith("#") ? t.slice(1) : block(); break;
    default: return null;
  }
  if (inner === null) return null;
  inner = inner.trim();
  for (const keyword of KEYWORDS) {
    let end, rest;
    if (inner.startsWith(`${keyword}_END:`)) { end = true; rest = inner.slice(keyword.length + 5); }
    else if (inner.startsWith(`${keyword}:`)) { end = false; rest = inner.slice(keyword.length + 1); }
    else continue;
    const name = rest.trim();
    if (name === "" || /\s/.test(name)) return null;
    return { keyword, end, name };
  }
  return null;
}

export const validName = (n) => /^[a-z][a-z0-9_]*$/.test(n);

function dedent(lines) {
  const indents = lines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n).trimEnd());
}

/**
 * Scan one file. Returns { regions, problems }: regions are
 * { keyword, name, startLine, endLine, body: string[] } (1-based marker lines), problems are
 * { line, kind, name, message }.
 */
export function scan(text, syntax) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop(); // like Rust's str::lines
  const regions = [];
  const problems = [];
  const open = [];
  const seen = new Set();
  const isMarker = new Array(lines.length).fill(false);
  let fence = false;
  const problem = (line, kind, name, message) => problems.push({ line, kind, name, message });

  lines.forEach((raw, idx) => {
    const ln = idx + 1;
    if (syntax === "html" && raw.trimStart().startsWith("```")) { fence = !fence; return; }
    if (fence) return;
    const m = parseMarker(raw, syntax);
    if (!m) return;
    isMarker[idx] = true;
    if (!validName(m.name)) { problem(ln, "bad-name", m.name, `invalid anchor name "${m.name}"`); return; }
    if (!m.end) {
      const key = `${m.keyword}:${m.name}`;
      if (seen.has(key)) problem(ln, "duplicate", m.name, `anchor "${m.name}" is defined twice in this file`);
      seen.add(key);
      open.push({ keyword: m.keyword, name: m.name, line: ln });
      return;
    }
    let pos = -1;
    for (let i = open.length - 1; i >= 0; i--) if (open[i].keyword === m.keyword && open[i].name === m.name) { pos = i; break; }
    if (pos < 0) { problem(ln, "end-without-start", m.name, `end marker for "${m.name}" without a start`); return; }
    if (pos + 1 !== open.length) {
      problem(ln, "partial-overlap", m.name, `"${m.name}" closes while "${open[pos + 1].name}" (opened inside it) is still open`);
    }
    const [o] = open.splice(pos, 1);
    regions.push({ keyword: o.keyword, name: o.name, startLine: o.line, endLine: ln, body: [] });
  });
  for (const o of open) problem(o.line, "unterminated", o.name, `anchor "${o.name}" is never closed`);

  for (const r of regions) {
    const inner = [];
    for (let i = r.startLine; i < r.endLine - 1; i++) if (!isMarker[i]) inner.push(lines[i]);
    r.body = dedent(inner);
    if (r.body.every((l) => l.trim() === "")) problem(r.startLine, "empty", r.name, `anchor "${r.name}" encloses no code`);
    else if (r.keyword === "ANCHOR" && r.body.length > MAX_REGION_LINES) {
      problem(r.startLine, "too-long", r.name, `anchor "${r.name}" is ${r.body.length} lines (max ${MAX_REGION_LINES})`);
    }
  }
  regions.sort((a, b) => a.startLine - b.startLine);
  problems.sort((a, b) => a.line - b.line);
  return { regions, problems };
}

/**
 * Resolve one `:::code` reference. `read(path)` returns the file text or null. Returns
 * { body, startLine, endLine } or throws with a message naming the file and anchor.
 */
export function resolveAnchor(file, name, read) {
  if (file.includes("..") || file.startsWith("/")) throw new Error(`:::code file=${file}: must be a repo-relative path`);
  const syntax = syntaxFor(file);
  if (!syntax) throw new Error(`:::code file=${file}: this file type cannot carry anchors`);
  const text = read(file);
  if (text == null) throw new Error(`:::code file=${file}: referenced file does not exist`);
  const { regions, problems } = scan(text, syntax);
  if (problems.length) throw new Error(`${file}:${problems[0].line}: ${problems[0].message}`);
  const r = regions.find((x) => x.keyword === "ANCHOR" && x.name === name);
  if (!r) throw new Error(`:::code anchor=${name}: anchor not found in ${file}`);
  return { body: r.body.join("\n"), startLine: r.startLine + 1, endLine: r.endLine - 1 };
}
