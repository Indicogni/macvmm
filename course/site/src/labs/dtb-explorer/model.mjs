// dtb-explorer model: a hardened flattened-device-tree (FDT) parser plus the interpreters the lab
// shows. Pure ES module: no DOM, no I/O, so `node --test` imports it and the browser shares it.
//
// What it mirrors, and why:
//   * `parse` follows `crates/vmm/src/fdt/reader.rs` check for check and in the same order, and
//     reports the same error values in the same text (the Rust `Debug` form, e.g.
//     `BadBlock("strings block")`), so the lab and the reference refuse the same blobs for the same
//     reason. Every read is bounds-checked against the buffer and `totalsize`, names must end in a
//     NUL inside their block, nesting depth and token count are capped. A malformed blob is an
//     error value, never an exception. Devicetree Specification v0.4, chapter 5.
//   * On top of the reference it records *where* every byte went (header field, reservation
//     entry, token, name, value, padding, string), so the view can colour the hex dump and link a
//     tree node to its bytes. That bookkeeping never changes what is accepted.
//   * `toDts` prints a tree the way `dtc -I dtb -O dts` does (dtc's `treesource.c` value
//     guessing), so the lab's text matches the lesson's captured listing byte for byte.
//   * `regInfo` applies the parent's `#address-cells` / `#size-cells` (spec section 2.3.5, defaults
//     2 and 1) to `reg`, and the node's and parent's counts to `ranges`, and words a length that does
//     not divide like dtc's `reg_format` check does.
// The input is hostile (a learner may drop any file): sizes are capped, nothing is ever rendered
// as HTML by this module, and no value from the blob is used as an index without a check.

// ---- Format constants (Devicetree Specification v0.4, section 5) ----
export const FDT_MAGIC = 0xd00dfeed;
export const FDT_BEGIN_NODE = 1;
export const FDT_END_NODE = 2;
export const FDT_PROP = 3;
export const FDT_NOP = 4;
export const FDT_END = 9;
export const FDT_HEADER_SIZE = 40;
export const FDT_RSV_ENTRY_SIZE = 16;
/** Linux booting.rst: the DTB "must not exceed 2 megabytes". */
export const FDT_MAX_SIZE = 2 * 1024 * 1024;
// Caps copied from reader.rs.
export const MAX_DEPTH = 64;
export const MAX_TOKENS = 1 << 19;
export const MAX_RESERVATIONS = 1024;
/** Largest file the lab will read at all (LABS.md section 4). Parsing then caps at 2 MiB. */
export const MAX_FILE = 16 * 1024 * 1024;
/** Most byte changes the learner may stack on a blob. */
export const MAX_PATCHES = 16;

export const TOKEN_NAMES = {
  [FDT_BEGIN_NODE]: "FDT_BEGIN_NODE",
  [FDT_END_NODE]: "FDT_END_NODE",
  [FDT_PROP]: "FDT_PROP",
  [FDT_NOP]: "FDT_NOP",
  [FDT_END]: "FDT_END",
};

export const HEADER_FIELDS = [
  { key: "magic", what: "\"this is a DTB\": must be 0xd00dfeed" },
  { key: "totalsize", what: "the whole blob's length in bytes" },
  { key: "off_dt_struct", what: "where the structure block starts" },
  { key: "off_dt_strings", what: "where the strings block starts" },
  { key: "off_mem_rsvmap", what: "where the memory reservation map starts" },
  { key: "version", what: "the format version this blob is written in" },
  { key: "last_comp_version", what: "the oldest version a reader may be and still understand it" },
  { key: "boot_cpuid_phys", what: "the reg of the CPU that boots" },
  { key: "size_dt_strings", what: "the strings block's length" },
  { key: "size_dt_struct", what: "the structure block's length" },
];

// ---- Errors: same variants and Display text as ReadError in reader.rs ----

/** Plain-English explanations, one per variant. */
const EXPLAIN = {
  TruncatedHeader: "The blob is shorter than the 40-byte header, so there is nothing to trust yet.",
  BadMagic: "The first four bytes are not d0 0d fe ed, so this is not a DTB (or not one in big-endian order).",
  BadTotalSize: "totalsize is below the 40-byte header, past the end of the bytes we have, or above the 2 MiB limit.",
  BadVersion: "version is below 16, or last_comp_version says a reader must understand something newer than 17.",
  BadBlock: "A block offset plus its size runs outside totalsize, starts inside the header, or is misaligned.",
  BadReservations: "The memory reservation map has no (0, 0) terminator inside the blob, or too many entries.",
  Truncated: "The structure block ends in the middle of a token.",
  UnterminatedName: "A node name has no NUL before the end of the structure block.",
  BadNameOffset: "A property's name offset points outside the strings block, or the name there has no NUL.",
  NotUtf8: "A name is not valid UTF-8.",
  BadToken: "A structure word is not one of the five tokens (1, 2, 3, 4, 9).",
  BadStructure: "The nodes do not nest properly: unbalanced, a property outside a node or after a child, or a second root.",
  TooComplex: "Deeper than 64 levels, or more tokens than the reader's cap.",
};

function err(code, arg, at) {
  let text;
  if (arg === undefined) text = code;
  else if (typeof arg === "string") text = `${code}(${JSON.stringify(arg)})`;
  else if (typeof arg === "number") text = `${code}(${arg})`;
  else text = `${code} { ${Object.entries(arg).map(([k, v]) => `${k}: ${v}`).join(", ")} }`;
  return { code, text, explain: EXPLAIN[code], at: at ?? null };
}

// ---- Small helpers ----

function be32(b, at) {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}
function be64(b, at) {
  return (BigInt(be32(b, at)) << 32n) | BigInt(be32(b, at + 4));
}
function align4(n) {
  return (n + 3) & ~3;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
function utf8(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** Index of the first NUL in b[from, limit), or -1. */
function nulIn(b, from, limit) {
  for (let i = from; i < limit; i++) if (b[i] === 0) return i;
  return -1;
}

/** Lower-case hex of a number or BigInt, with 0x. */
export function hex(n) {
  return `0x${n.toString(16)}`;
}

/** Course style: 0x0900_0000, 0x4000_0000, 0x1000 (groups of four only past four digits). */
export function hexGrouped(n) {
  let s = n.toString(16);
  if (s.length <= 4) return `0x${s}`;
  s = s.padStart(Math.ceil(s.length / 4) * 4, "0");
  return `0x${s.match(/.{4}/g).join("_")}`;
}

/** A size in bytes, in words: "4 KiB", "64 MiB", "4 EiB (about 4.6 EB)", "24 bytes". */
export function sizeWords(n) {
  const v = BigInt(n);
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  let k = 0;
  let q = v;
  while (k < units.length - 1 && q !== 0n && q % 1024n === 0n) {
    q /= 1024n;
    k += 1;
  }
  let out = k === 0 ? `${q} byte${q === 1n ? "" : "s"}` : `${q} ${units[k]}`;
  if (v >= 1n << 60n) {
    const eb = Number(v / 10n ** 15n) / 1000;
    out += ` (about ${eb.toFixed(1)} EB)`;
  }
  return out;
}

// ---- The parser ----

/**
 * Parse a blob. Never throws for any input bytes.
 *
 * Returns { ok, error, length, header, reservations, nodes, props, root, spans, warnings, blocks }:
 *   nodes[i] = { id, name, path, parent, depth, children[], props[], begin, nameEnd, end, closed }
 *   props[i] = { id, node, name, nameoff, tok, valOff, len, end, strOff, value (Uint8Array) }
 *   spans    = byte ranges { start, end, kind, label, node, prop, field } covering what was read
 * `begin`/`tok` are absolute offsets of the token; `end` is one past the last byte (padding included).
 */
export function parse(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(0);
  const r = {
    ok: false,
    error: null,
    length: b.length,
    header: null,
    reservations: [],
    nodes: [],
    props: [],
    root: null,
    spans: [],
    warnings: [],
    blocks: {},
  };
  const span = (start, end, kind, label, extra = {}) => {
    if (end > start) r.spans.push({ start, end, kind, label, node: -1, prop: -1, field: null, ...extra });
  };
  const fail = (e) => {
    r.error = e;
    finishSpans(r);
    return r;
  };

  // header() in reader.rs
  if (b.length < FDT_HEADER_SIZE) return fail(err("TruncatedHeader", undefined, 0));
  const h = {};
  HEADER_FIELDS.forEach((f, i) => {
    h[f.key] = be32(b, i * 4);
    span(i * 4, i * 4 + 4, "hdr", `header: ${f.key} = ${hex(h[f.key])}`, { field: f.key });
  });
  r.header = h;
  if (h.magic !== FDT_MAGIC) return fail(err("BadMagic", h.magic, 0));
  const total = h.totalsize;
  if (total < FDT_HEADER_SIZE || total > b.length || total > FDT_MAX_SIZE) {
    return fail(err("BadTotalSize", total, 4));
  }
  if (h.version < 16 || h.last_comp_version > 17) {
    return fail(err("BadVersion", { version: h.version, last_comp: h.last_comp_version }, 20));
  }
  if (h.off_mem_rsvmap % 8 !== 0) return fail(err("BadBlock", "reservation map alignment", 16));
  if (h.off_dt_struct % 4 !== 0 || h.size_dt_struct % 4 !== 0) {
    return fail(err("BadBlock", "structure block alignment", 8));
  }

  // block() in reader.rs. Offsets are u32, so the sums fit a JS number exactly.
  const block = (off, size, what, fieldAt) => {
    const end = off + size;
    if (off < FDT_HEADER_SIZE || end > total) return { e: err("BadBlock", what, fieldAt) };
    return { start: off, end };
  };
  const st = block(h.off_dt_struct, h.size_dt_struct, "structure block", 8);
  if (st.e) return fail(st.e);
  r.blocks.structure = { start: st.start, end: st.end };
  const sr = block(h.off_dt_strings, h.size_dt_strings, "strings block", 12);
  if (sr.e) return fail(sr.e);
  r.blocks.strings = { start: sr.start, end: sr.end };
  addStringSpans(r, b, sr.start, sr.end);

  // parse_reservations()
  {
    let pos = h.off_mem_rsvmap;
    if (pos < FDT_HEADER_SIZE) return fail(err("BadReservations", undefined, 16));
    const start = pos;
    for (;;) {
      const end = pos + FDT_RSV_ENTRY_SIZE;
      if (end > total) return fail(err("BadReservations", undefined, pos));
      const addr = be64(b, pos);
      const size = be64(b, pos + 8);
      if (addr === 0n && size === 0n) {
        span(pos, end, "rsv", "reservation map: (0, 0) terminator");
        r.blocks.rsvmap = { start, end };
        break;
      }
      if (r.reservations.length >= MAX_RESERVATIONS) return fail(err("BadReservations", undefined, pos));
      r.reservations.push({ addr, size, off: pos });
      span(pos, end, "rsv", `reservation: address ${hex(addr)}, size ${hex(size)}`);
      pos = end;
    }
  }

  // parse_structure(): positions are absolute; the block is [base, lim).
  const base = st.start;
  const lim = st.end;
  const sBase = sr.start;
  const sLim = sr.end;
  let pos = base;
  const stack = []; // node ids; has-child flag lives on the node
  const hasChild = new Map();
  let rootId = null;
  const read32 = (what) => {
    if (pos + 4 > lim) return { e: err("Truncated", what, pos) };
    const v = be32(b, pos);
    pos += 4;
    return { v };
  };
  for (let n = 0; n < MAX_TOKENS; n++) {
    const tokAt = pos;
    const t = read32("token");
    if (t.e) return fail(t.e);
    const tok = t.v;
    if (tok === FDT_BEGIN_NODE) {
      if (rootId !== null) return fail(err("BadStructure", "a second root node", tokAt));
      if (stack.length >= MAX_DEPTH) return fail(err("TooComplex", undefined, tokAt));
      const nul = nulIn(b, pos, lim);
      if (nul < 0) return fail(err("UnterminatedName", undefined, pos));
      const name = utf8(b.subarray(pos, nul));
      if (name === null) return fail(err("NotUtf8", undefined, pos));
      const nameStart = pos;
      pos = align4(nul + 1 - base) + base;
      const parent = stack.length ? stack[stack.length - 1] : -1;
      if (parent >= 0) hasChild.set(parent, true);
      else if (name !== "") return fail(err("BadStructure", "the root node has a name", tokAt));
      const id = r.nodes.length;
      const pnode = parent >= 0 ? r.nodes[parent] : null;
      const path = pnode === null ? "/" : pnode.path === "/" ? `/${name}` : `${pnode.path}/${name}`;
      r.nodes.push({
        id,
        name,
        path,
        parent,
        depth: stack.length,
        children: [],
        props: [],
        begin: tokAt,
        nameEnd: pos,
        end: null,
        closed: false,
      });
      if (pnode) pnode.children.push(id);
      const shown = name === "" ? "/ (root)" : name;
      span(tokAt, tokAt + 4, "tok", `FDT_BEGIN_NODE: ${shown}`, { node: id });
      span(nameStart, nul + 1, "name", `node name: "${name}" and its NUL`, { node: id });
      span(nul + 1, pos, "pad", "padding to a multiple of 4", { node: id });
      stack.push(id);
    } else if (tok === FDT_END_NODE) {
      if (!stack.length) return fail(err("BadStructure", "FDT_END_NODE without a node", tokAt));
      const id = stack.pop();
      const node = r.nodes[id];
      node.end = pos;
      node.closed = true;
      span(tokAt, pos, "tok", `FDT_END_NODE: ${node.name === "" ? "/ (root)" : node.name}`, { node: id });
      if (!stack.length) rootId = id;
    } else if (tok === FDT_PROP) {
      const l = read32("property length");
      if (l.e) return fail(l.e);
      const no = read32("property name offset");
      if (no.e) return fail(no.e);
      const len = l.v;
      const nameoff = no.v;
      const valOff = pos;
      if (valOff + len > lim) return fail(err("Truncated", "property value", valOff));
      const value = b.slice(valOff, valOff + len);
      pos = align4(valOff + len - base) + base;
      // cstr(strings, nameoff): a NUL inside the strings block.
      const at = sBase + nameoff;
      const nul = nameoff < sLim - sBase ? nulIn(b, at, sLim) : -1;
      if (nul < 0) return fail(err("BadNameOffset", nameoff, tokAt + 8));
      const name = utf8(b.subarray(at, nul));
      if (name === null) return fail(err("NotUtf8", undefined, at));
      if (!stack.length) return fail(err("BadStructure", "a property outside any node", tokAt));
      const owner = stack[stack.length - 1];
      if (hasChild.get(owner)) return fail(err("BadStructure", "a property after a child node", tokAt));
      const id = r.props.length;
      r.props.push({ id, node: owner, name, nameoff, tok: tokAt, valOff, len, end: pos, strOff: at, value });
      r.nodes[owner].props.push(id);
      const ex = { node: owner, prop: id };
      span(tokAt, tokAt + 4, "tok", `FDT_PROP: ${name}`, ex);
      span(tokAt + 4, tokAt + 8, "field", `length: ${len} byte${len === 1 ? "" : "s"}`, ex);
      span(tokAt + 8, tokAt + 12, "field", `name offset: ${hex(nameoff)} into the strings block ("${name}")`, ex);
      span(valOff, valOff + len, "val", `value of ${name}`, ex);
      span(valOff + len, pos, "pad", "padding to a multiple of 4", ex);
    } else if (tok === FDT_NOP) {
      span(tokAt, pos, "tok", "FDT_NOP: ignored");
    } else if (tok === FDT_END) {
      span(tokAt, pos, "tok", "FDT_END: the structure block's last token");
      if (stack.length) return fail(err("BadStructure", "FDT_END inside a node", tokAt));
      if (rootId === null) return fail(err("BadStructure", "no root node", tokAt));
      r.root = rootId;
      r.ok = true;
      if (pos < lim) span(pos, lim, "gap", "structure block bytes after FDT_END (never read)");
      lint(r);
      finishSpans(r);
      return r;
    } else {
      return fail(err("BadToken", tok, tokAt));
    }
  }
  return fail(err("TooComplex", undefined, pos));
}

function addStringSpans(r, b, start, end) {
  let p = start;
  while (p < end) {
    const nul = nulIn(b, p, end);
    const stop = nul < 0 ? end : nul + 1;
    const s = utf8(b.subarray(p, nul < 0 ? end : nul));
    const label =
      nul < 0
        ? "strings block: bytes with no NUL before the block ends"
        : `string at ${hex(p - start)}: "${s === null ? "(not UTF-8)" : s}"`;
    r.spans.push({ start: p, end: stop, kind: "str", label, node: -1, prop: -1, field: null, strRel: p - start });
    p = stop;
  }
}

/** Sort spans and label every byte nothing claimed (gaps, bytes past totalsize). */
function finishSpans(r) {
  r.spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const total = r.header && r.header.totalsize <= r.length ? r.header.totalsize : r.length;
  const covered = new Uint8Array(r.length);
  for (const s of r.spans) covered.fill(1, s.start, Math.min(s.end, r.length));
  const extra = [];
  let i = 0;
  while (i < r.length) {
    if (covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < r.length && !covered[j]) j++;
    const lo = i;
    const hi = j;
    const mid = Math.min(Math.max(total, lo), hi);
    if (mid > lo) {
      extra.push({ start: lo, end: mid, kind: "gap", label: r.error ? "not read: the parser stopped before here" : "not part of any block", node: -1, prop: -1, field: null });
    }
    if (hi > mid) extra.push({ start: mid, end: hi, kind: "gap", label: "past totalsize: not part of the blob", node: -1, prop: -1, field: null });
    i = j;
  }
  r.spans.push(...extra);
  r.spans.sort((a, b) => a.start - b.start || a.end - b.end);
  // Strings that overlap structure bytes are kept, but say so.
  const st = r.blocks.structure;
  const sr = r.blocks.strings;
  if (st && sr && sr.start < st.end && st.start < sr.end) {
    r.warnings.push({
      kind: "overlap",
      text: `The strings block (from ${hex(sr.start)}) overlaps the structure block (to ${hex(st.end)}); names are read from the wrong bytes.`,
    });
  }
}

/** Index from byte offset to the span that owns it (first claim wins, so structure beats strings). */
export function byteOwners(r) {
  const own = new Int32Array(r.length).fill(-1);
  r.spans.forEach((s, k) => {
    for (let i = s.start; i < Math.min(s.end, r.length); i++) if (own[i] < 0) own[i] = k;
  });
  return own;
}

// ---- Values, the way dtc prints them (treesource.c) ----

const isPrint = (c) => c >= 0x20 && c <= 0x7e;
const C_ESC = { 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r" };

/** dtc's guess_value_type: "empty", "string", "cells" or "bytes". */
export function guessType(v) {
  const len = v.length;
  if (len === 0) return "empty";
  let notString = 0;
  let nul = 0;
  for (const c of v) {
    if (!(isPrint(c) || c === 0 || C_ESC[c] !== undefined)) notString++;
    if (c === 0) nul++;
  }
  if (v[len - 1] === 0 && notString === 0 && nul <= len - nul) return "string";
  if (len % 4 === 0) return "cells";
  return "bytes";
}

function dtsString(v) {
  // write_propval_string
  let out = '"';
  const end = v.length - 1;
  let i = 0;
  while (i < end) {
    const c = v[i++];
    if (C_ESC[c] !== undefined) out += C_ESC[c];
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x22) out += '\\"';
    else if (c === 0) {
      out += '", ';
      while (v[i] === 0 && i < end) {
        out += '"", ';
        i++;
      }
      out += '"';
    } else if (isPrint(c)) out += String.fromCharCode(c);
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return `${out}"`;
}

/** Cells of a value (big-endian u32s), or null if its length is not a multiple of 4. */
export function cells(v) {
  if (v.length % 4) return null;
  const out = [];
  for (let i = 0; i < v.length; i += 4) out.push(be32(v, i));
  return out;
}

/** The value as dtc writes it after `=`, or "" for an empty property. */
export function formatValue(v) {
  const t = guessType(v);
  if (t === "empty") return "";
  if (t === "string") return dtsString(v);
  if (t === "cells") return `<${cells(v).map((c) => `0x${c.toString(16).padStart(2, "0")}`).join(" ")}>`;
  return `[${[...v].map((c) => c.toString(16).padStart(2, "0")).join(" ")}]`;
}

/** One property line as dtc writes it (without indentation). */
export function propLine(p) {
  return p.len === 0 ? `${p.name};` : `${p.name} = ${formatValue(p.value)};`;
}

/** The whole tree as `dtc -I dtb -O dts` prints it. Only for a blob that parsed. */
export function toDts(r) {
  if (!r.ok) return "";
  let out = "/dts-v1/;\n\n";
  for (const m of r.reservations) {
    out += `/memreserve/\t0x${m.addr.toString(16).padStart(16, "0")} 0x${m.size.toString(16).padStart(16, "0")};\n`;
  }
  const walk = (id, level) => {
    const n = r.nodes[id];
    const tab = "\t".repeat(level);
    out += `${tab}${n.name ? n.name : "/"} {\n`;
    for (const pid of n.props) out += `${tab}\t${propLine(r.props[pid])}\n`;
    for (const c of n.children) {
      out += "\n";
      walk(c, level + 1);
    }
    out += `${tab}};\n`;
  };
  walk(r.root, 0);
  return out;
}

// ---- reg and ranges ----

function propOf(r, nodeId, name) {
  if (nodeId < 0) return null;
  for (const pid of r.nodes[nodeId].props) if (r.props[pid].name === name) return r.props[pid];
  return null;
}

/** A node's own #address-cells / #size-cells, with where each came from (spec 2.3.5 defaults). */
export function cellCounts(r, nodeId) {
  const one = (name, dflt) => {
    const p = propOf(r, nodeId, name);
    if (!p) return { n: dflt, from: "default", bad: false };
    // Not one cell: dtc rejects the property (its length check), Linux's of_property_read_u32
    // would take the first cell. Neither is "the default", so the lab says so out loud (lint, view).
    if (p.len !== 4) return { n: dflt, from: "default", bad: true, badLen: p.len, badProp: p.id };
    return { n: be32(p.value, 0), from: r.nodes[nodeId].path, bad: false };
  };
  return { ac: one("#address-cells", 2), sc: one("#size-cells", 1) };
}

function joinCells(cs) {
  let v = 0n;
  for (const c of cs) v = (v << 32n) | BigInt(c);
  return v;
}

/**
 * Interpret a node's `reg` with its parent's counts. Returns null if the node has no `reg`.
 * { ac, sc, acFrom, scFrom, len, entry, ok, entries: [{addr, size}], loose: {addr, size}|null,
 *   message, dtcWarning, unit: {name, matches}|null }
 * `loose` is what a reader that skips the length check reads from the first (entry) bytes.
 */
export function regInfo(r, nodeId) {
  const p = propOf(r, nodeId, "reg");
  if (!p) return null;
  const node = r.nodes[nodeId];
  const cc = node.parent >= 0 ? cellCounts(r, node.parent) : { ac: { n: 2, from: "default", bad: false }, sc: { n: 1, from: "default", bad: false } };
  const out = decodeRanges(p.value, [cc.ac.n, cc.sc.n]);
  const info = {
    prop: p.id,
    ac: cc.ac.n,
    sc: cc.sc.n,
    acFrom: cc.ac.from,
    scFrom: cc.sc.from,
    acBad: !!cc.ac.bad,
    scBad: !!cc.sc.bad,
    len: p.len,
    entry: out.entry,
    ok: out.ok,
    tooWide: out.tooWide,
    entries: out.rows.map(([addr, size]) => ({ addr, size })),
    loose: out.loose ? { addr: out.loose[0], size: out.loose[1] } : null,
    message: "",
    dtcWarning: null,
    unit: null,
  };
  if (out.ok) {
    info.message = `${p.len} bytes = ${info.entries.length} range${info.entries.length === 1 ? "" : "s"} of ${out.entry} bytes (${cc.ac.n} address + ${cc.sc.n} size cells, 4 bytes each)`;
  } else if (out.tooWide) {
    // The length divides fine (dtc would not warn); the lab just will not show numbers this wide.
    info.message = `${p.len} bytes; a cell count of ${out.tooWide} is too large to interpret here`;
  } else {
    info.message =
      out.entry === 0
        ? `${p.len} bytes, but the parent says 0 address and 0 size cells: no range can be read`
        : `Mismatch: ${p.len} bytes is not a multiple of ${out.entry} (${cc.ac.n} address + ${cc.sc.n} size cells, 4 bytes each)`;
    // dtc's check_reg_format: warn when entrylen == 0 or len % entrylen != 0, nothing else.
    info.dtcWarning = `Warning (reg_format): ${node.path}:reg: property has invalid length (${p.len} bytes) (#address-cells == ${cc.ac.n}, #size-cells == ${cc.sc.n})`;
  }
  const at = node.name.indexOf("@");
  if (at >= 0) {
    const unitName = node.name.slice(at + 1);
    const first = info.entries[0] || info.loose;
    info.unit = { name: unitName, matches: first ? unitName === first.addr.toString(16) : null };
  }
  return info;
}

/**
 * Interpret `ranges`: (child address, parent address, size) triples with the node's own
 * #address-cells, the parent's #address-cells and the node's #size-cells. Null if absent.
 */
export function rangesInfo(r, nodeId) {
  const p = propOf(r, nodeId, "ranges");
  if (!p) return null;
  const node = r.nodes[nodeId];
  const own = cellCounts(r, nodeId);
  const par = node.parent >= 0 ? cellCounts(r, node.parent) : { ac: { n: 2 } };
  const widths = [own.ac.n, par.ac.n, own.sc.n];
  if (p.len === 0) {
    return { prop: p.id, widths, identity: true, ok: true, entries: [], message: "Empty ranges: child addresses are parent addresses (1:1)." };
  }
  const out = decodeRanges(p.value, widths);
  return {
    prop: p.id,
    widths,
    identity: false,
    ok: out.ok,
    tooWide: out.tooWide,
    entries: out.rows.map(([child, parent, size]) => ({ child, parent, size })),
    message: out.ok
      ? `${p.len} bytes = ${out.rows.length} triple${out.rows.length === 1 ? "" : "s"} of ${out.entry} bytes (child ${widths[0]} + parent ${widths[1]} + size ${widths[2]} cells)`
      : out.tooWide
        ? `${p.len} bytes; a cell count of ${out.tooWide} is too large to interpret here`
        : `Mismatch: ${p.len} bytes is not a multiple of ${out.entry} (child ${widths[0]} + parent ${widths[1]} + size ${widths[2]} cells, 4 bytes each)`,
  };
}

/**
 * Split a reg/ranges value into rows of `widths` cells. Two separate refusals: a length that does
 * not divide into entries (what dtc warns about), and counts too wide for the lab to show (`tooWide`
 * is then the offending count; the length itself may be fine).
 */
function decodeRanges(v, widths) {
  const cellCount = widths.reduce((a, w) => a + w, 0);
  const entry = cellCount * 4;
  const mismatch = entry === 0 || v.length % entry !== 0;
  // Counts come from the blob: refuse absurd ones instead of allocating for them.
  const wide = widths.find((w) => w > 4);
  if (wide !== undefined) return { entry, ok: false, tooWide: mismatch ? 0 : wide, rows: [], loose: null };
  const cs = cells(v.subarray(0, v.length - (v.length % 4))) || [];
  const take = (from) => {
    const row = [];
    let k = from;
    for (const w of widths) {
      row.push(joinCells(cs.slice(k, k + w)));
      k += w;
    }
    return row;
  };
  if (mismatch) {
    const loose = entry > 0 && cs.length >= cellCount ? take(0) : null;
    return { entry, ok: false, tooWide: 0, rows: [], loose };
  }
  const rows = [];
  for (let k = 0; k + cellCount <= cs.length; k += cellCount) rows.push(take(k));
  return { entry, ok: true, tooWide: 0, rows, loose: null };
}

// ---- Lints a careful reader adds (shown as warnings, never as parse errors) ----

function lint(r) {
  for (const n of r.nodes) {
    // One warning per duplicated name in a node, with a count (dtc reports each once).
    const seen = new Map(); // name -> { first prop id, count }
    for (const pid of n.props) {
      const p = r.props[pid];
      const s = seen.get(p.name);
      if (s) s.count++;
      else seen.set(p.name, { prop: pid, count: 1 });
    }
    for (const [name, s] of seen) {
      if (s.count < 2) continue;
      r.warnings.push({
        kind: "duplicate",
        node: n.id,
        prop: s.prop,
        text: `Property name "${name}" appears ${s.count} times in ${n.path}: dtc refuses this tree; macvmm's reader accepts it.`,
      });
    }
    const cc = cellCounts(r, n.id);
    for (const [name, c, dflt] of [["#address-cells", cc.ac, 2], ["#size-cells", cc.sc, 1]]) {
      if (!c.bad) continue;
      r.warnings.push({
        kind: "cells",
        node: n.id,
        prop: c.badProp,
        text: `${name} in ${n.path} is ${c.badLen} bytes, not one cell: dtc rejects it; this lab falls back to the default ${dflt}.`,
      });
    }
    const reg = regInfo(r, n.id);
    if (reg && !reg.ok && reg.dtcWarning) r.warnings.push({ kind: "reg", node: n.id, prop: reg.prop, text: reg.dtcWarning });
    if (reg && reg.unit && reg.unit.matches === false) {
      const first = reg.entries[0] || reg.loose;
      r.warnings.push({
        kind: "unit",
        node: n.id,
        prop: reg.prop,
        text: `${n.path}: the unit address says ${reg.unit.name} but reg starts at ${hex(first.addr)}.`,
      });
    }
  }
}

// ---- Selection: what a byte offset means, and which bytes go with it ----

/**
 * Describe the byte at `off`: { span, title, lines[], ranges: [{start, end, role}], node, prop }.
 * `role` is "primary" (the thing itself) or "related" (its node, its name string, its users...).
 */
export function describe(r, owners, off) {
  if (!(off >= 0 && off < r.length)) return null;
  const k = owners[off];
  if (k < 0) return null;
  const s = r.spans[k];
  const out = { span: s, title: s.label, lines: [], ranges: [{ start: s.start, end: s.end, role: "primary" }], node: s.node, prop: s.prop };
  const at = `bytes ${hex(s.start)} to ${hex(s.end - 1)}`;
  if (s.prop >= 0) {
    const p = r.props[s.prop];
    const n = r.nodes[p.node];
    out.title = `${n.path} : ${p.name}`;
    out.ranges = [
      { start: p.tok, end: p.end, role: "primary" },
      { start: p.strOff, end: p.strOff + new TextEncoder().encode(p.name).length + 1, role: "related" },
    ];
    out.lines.push(`Property token at ${hex(p.tok)}: FDT_PROP (3), length ${p.len}, name offset ${hex(p.nameoff)}, then the value and padding to ${hex(p.end)}.`);
    out.lines.push(`Its name lives in the strings block at ${hex(p.strOff)} (block start + ${hex(p.nameoff)}).`);
    out.lines.push(p.len === 0 ? `dtc: ${propLine(p)} (an empty property: its presence is the value)` : `dtc: ${propLine(p)}`);
    const reg = p.name === "reg" ? regInfo(r, p.node) : null;
    if (reg) out.lines.push(...regLines(reg));
    const rng = p.name === "ranges" ? rangesInfo(r, p.node) : null;
    if (rng) out.lines.push(rng.message);
    if (p.name === "#address-cells" || p.name === "#size-cells") {
      out.lines.push(`This count says how ${n.path}'s children write their reg, not how ${n.path} writes its own.`);
    }
    if (p.name === "interrupt-parent") {
      const cs = cells(p.value) || [];
      if (cs.length) out.lines.push(`Points at: ${phandleTarget(r, cs[0])}.`);
    }
    if (p.name === "clocks") out.lines.push(...clockLines(r, cells(p.value) || []));
    return out;
  }
  if (s.node >= 0) {
    const n = r.nodes[s.node];
    out.title = n.path;
    out.ranges = [
      { start: n.begin, end: n.nameEnd, role: "primary" },
      { start: n.begin, end: n.end ?? r.length, role: "related" },
    ];
    out.lines.push(
      n.closed
        ? `Node from ${hex(n.begin)} (FDT_BEGIN_NODE) to ${hex(n.end - 1)} (the end of its FDT_END_NODE): ${n.end - n.begin} bytes.`
        : `Node opened at ${hex(n.begin)} and never closed before the parser stopped.`,
    );
    out.lines.push(`${n.props.length} propert${n.props.length === 1 ? "y" : "ies"}, ${n.children.length} child node${n.children.length === 1 ? "" : "s"}.`);
    const reg = regInfo(r, n.id);
    if (reg) out.lines.push(...regLines(reg));
    return out;
  }
  if (s.kind === "hdr") {
    const f = HEADER_FIELDS.find((x) => x.key === s.field);
    out.title = `header: ${s.field}`;
    out.lines.push(`${at}: ${hex(r.header[s.field])} (${r.header[s.field]}), ${f.what}.`);
    const point = { off_dt_struct: "structure", off_dt_strings: "strings", off_mem_rsvmap: "rsvmap" }[s.field];
    const blk = point && r.blocks[point];
    if (blk) out.ranges.push({ start: blk.start, end: blk.end, role: "related" });
    if (s.field === "size_dt_strings" && r.blocks.strings) out.ranges.push({ ...r.blocks.strings, role: "related" });
    if (s.field === "size_dt_struct" && r.blocks.structure) out.ranges.push({ ...r.blocks.structure, role: "related" });
    return out;
  }
  if (s.kind === "str") {
    const users = r.props.filter((p) => p.strOff === s.start);
    out.title = s.label;
    out.lines.push(`${at}, in the strings block.`);
    out.lines.push(
      users.length
        ? `Named by ${users.length} propert${users.length === 1 ? "y" : "ies"}: each stores only this offset, so the name is written once.`
        : "No property's name offset points at the start of this string.",
    );
    for (const p of users) out.ranges.push({ start: p.tok + 8, end: p.tok + 12, role: "related" });
    return out;
  }
  out.lines.push(`${at}.`);
  return out;
}

function phandleNode(r, ph) {
  for (const p of r.props) {
    if ((p.name === "phandle" || p.name === "linux,phandle") && p.len === 4 && be32(p.value, 0) === ph) return p.node;
  }
  return -1;
}

function phandleTarget(r, ph) {
  const id = phandleNode(r, ph);
  return id >= 0 ? r.nodes[id].path : `${hex(ph)} (no node has this phandle)`;
}

/**
 * Walk `clocks` the way a clock binding says to: a phandle, then as many specifier cells as the
 * target's #clock-cells, then the next phandle. Stops with a note when that cannot be done.
 */
export function clockLines(r, cs) {
  const refs = [];
  let note = "";
  for (let i = 0; i < cs.length && refs.length < 64; ) {
    const target = phandleNode(r, cs[i]);
    if (target < 0) {
      note = `Cell ${i} is ${hex(cs[i])}, but no node has that phandle, so the rest cannot be split.`;
      break;
    }
    const cc = propOf(r, target, "#clock-cells");
    if (!cc || cc.len !== 4) {
      note = `${r.nodes[target].path} has no one-cell #clock-cells, so the rest cannot be split.`;
      break;
    }
    const n = be32(cc.value, 0);
    if (i + 1 + n > cs.length) {
      note = `${r.nodes[target].path} wants ${n} more cell${n === 1 ? "" : "s"}, but the property ends first.`;
      break;
    }
    const args = cs.slice(i + 1, i + 1 + n).map((c) => hex(c));
    refs.push(args.length ? `${r.nodes[target].path} with ${args.join(" ")}` : r.nodes[target].path);
    i += 1 + n;
  }
  const lines = [];
  if (refs.length) lines.push(`Points at: ${refs.join(", ")} (each reference is a phandle plus the target's #clock-cells cells).`);
  if (note) lines.push(note);
  return lines;
}

function regLines(reg) {
  const lines = [];
  const from = (x) => (x === "default" ? "the specification's default, the parent does not say" : `from ${x}`);
  lines.push(`reg read with #address-cells = ${reg.ac} (${from(reg.acFrom)}) and #size-cells = ${reg.sc} (${from(reg.scFrom)}).`);
  lines.push(reg.message + ".");
  for (const e of reg.entries) {
    lines.push(reg.sc === 0 ? `address ${hexGrouped(e.addr)}, no size` : `address ${hexGrouped(e.addr)}, size ${hexGrouped(e.size)} (${sizeWords(e.size)})`);
  }
  if (reg.loose) {
    lines.push(
      `A reader that skips the check takes the first ${reg.entry} bytes anyway: address ${hexGrouped(reg.loose.addr)}, size ${hexGrouped(reg.loose.size)} (${sizeWords(reg.loose.size)}).`,
    );
  }
  if (reg.unit && reg.unit.matches === false) lines.push(`The unit address @${reg.unit.name} does not match the first address.`);
  return lines;
}

// ---- Header checks, one row per field, in reader.rs order ----

/** Every header check, evaluated independently (the parser stops at the first failure). */
export function headerChecks(r) {
  if (!r.header) return [];
  const h = r.header;
  const total = h.totalsize;
  const inside = (off, size) => off >= FDT_HEADER_SIZE && off + size <= total;
  return [
    { field: "magic", pass: h.magic === FDT_MAGIC, why: "must be 0xd00dfeed" },
    { field: "totalsize", pass: total >= FDT_HEADER_SIZE && total <= r.length && total <= FDT_MAX_SIZE, why: `at least 40, at most the ${r.length} bytes we have, at most 2 MiB` },
    { field: "version", pass: h.version >= 16, why: "at least 16" },
    { field: "last_comp_version", pass: h.last_comp_version <= 17, why: "at most 17" },
    { field: "off_mem_rsvmap", pass: h.off_mem_rsvmap % 8 === 0 && h.off_mem_rsvmap >= FDT_HEADER_SIZE, why: "8-aligned, after the header" },
    { field: "off_dt_struct", pass: h.off_dt_struct % 4 === 0 && h.size_dt_struct % 4 === 0 && inside(h.off_dt_struct, h.size_dt_struct), why: "4-aligned; offset + size inside totalsize" },
    { field: "off_dt_strings", pass: inside(h.off_dt_strings, h.size_dt_strings), why: `offset + size = ${hex(h.off_dt_strings + h.size_dt_strings)}, must be at most totalsize ${hex(total)}` },
  ];
}

// ---- Input: hex text and SHA-256 ----

/**
 * Bytes from pasted text: plain hex ("d0 0d fe ed", "0xd00dfeed", with spaces, commas, colons or
 * underscores) or `xxd` output (offset column and ASCII column are dropped).
 * Returns { bytes } or { error }.
 */
export function parseHexText(text, maxBytes = FDT_MAX_SIZE) {
  if (typeof text !== "string") return { error: "Nothing to read." };
  if (text.length > maxBytes * 4 + 65536) return { error: `Too long: at most ${sizeWords(maxBytes)} of bytes.` };
  const lines = text.split(/\r?\n/);
  const xxd = lines.filter((l) => l.trim()).every((l) => /^\s*[0-9a-fA-F]{4,16}:\s/.test(l));
  let digits = "";
  for (const raw of lines) {
    let l = raw;
    if (xxd) {
      if (!l.trim()) continue;
      l = l.slice(l.indexOf(":") + 1);
      const ascii = l.search(/\S\s{2,}\S/); // xxd puts two spaces before the ASCII column
      if (ascii >= 0) l = l.slice(0, ascii + 1);
    }
    l = l.replace(/0x/gi, "").replace(/[\s,:_]/g, "");
    if (/[^0-9a-fA-F]/.test(l)) return { error: "Only hex digits, spaces, commas, colons, underscores and 0x are allowed." };
    digits += l;
    if (digits.length > maxBytes * 2) return { error: `Too long: at most ${sizeWords(maxBytes)} of bytes.` };
  }
  if (!digits.length) return { error: "No hex digits found." };
  if (digits.length % 2) return { error: `An odd number of hex digits (${digits.length}): every byte needs two.` };
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(digits.substr(i * 2, 2), 16);
  return { bytes };
}

/** Hex string to bytes (for the bundled samples, which are trusted and even-length). */
export function fromHex(s) {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of bytes, as lower-case hex (FIPS 180-4). Pure JS, so it also works without crypto.subtle. */
export function sha256(bytes) {
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  dv.setUint32(padded.length - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

// ---- Lab state, actions and the share-state hash ----
//
// state = { sample, patches: [[offset, value], ...], sel: offset|null, view: "both"|"tree"|"bytes",
//           custom: null | { name, bytes } }
// The hash is `<sample>[+<off>=<val>]...[@<sel>][.t|.b]`, hex without 0x (`v@310` is the reference:
// the PL011 node selected). A file or pasted bytes are never put in the link.

export const VIEWS = ["both", "tree", "bytes"];
export const DEFAULT_SAMPLE = "v";

export function initialState(sample = DEFAULT_SAMPLE) {
  return { sample, patches: [], sel: null, view: "both", custom: null };
}

/** The bytes a state shows: sample (or custom) bytes, then the sample's own patches, then the learner's. */
export function bytesFor(state, samples) {
  let base;
  let own = [];
  if (state.custom) base = state.custom.bytes;
  else {
    const s = samples.find((x) => x.id === state.sample);
    if (!s) return null;
    base = s.bytes;
    own = s.patches || [];
  }
  const out = base.slice();
  for (const [o, v] of [...own, ...state.patches]) if (o >= 0 && o < out.length) out[o] = v;
  return out;
}

/** Offsets changed relative to the unpatched source, with old and new values. */
export function changedBytes(state, samples) {
  const s = state.custom ? null : samples.find((x) => x.id === state.sample);
  const base = state.custom ? state.custom.bytes : s ? s.bytes : null;
  const now = bytesFor(state, samples);
  const out = new Map();
  if (!base || !now) return out;
  for (const [o] of [...((s && s.patches) || []), ...state.patches]) {
    if (o < base.length && base[o] !== now[o]) out.set(o, { from: base[o], to: now[o] });
  }
  return out;
}

export function step(state, action, samples) {
  switch (action.type) {
    case "sample": {
      if (!samples.some((x) => x.id === action.id)) return state;
      return { ...initialState(action.id), view: state.view };
    }
    case "custom":
      return { ...initialState(DEFAULT_SAMPLE), view: state.view, custom: { name: action.name, bytes: action.bytes } };
    case "select":
      return { ...state, sel: action.offset };
    case "view":
      return VIEWS.includes(action.view) ? { ...state, view: action.view } : state;
    case "patch": {
      const len = (bytesFor(state, samples) || []).length;
      const { offset, value } = action;
      if (!Number.isInteger(offset) || offset < 0 || offset >= len) return state;
      if (!Number.isInteger(value) || value < 0 || value > 255) return state;
      const rest = state.patches.filter(([o]) => o !== offset);
      if (rest.length >= MAX_PATCHES) return state;
      return { ...state, patches: [...rest, [offset, value]], sel: offset };
    }
    case "unpatch":
      return { ...state, patches: state.patches.filter(([o]) => o !== action.offset) };
    case "reset":
      return initialState();
    default:
      return state;
  }
}

/** The share string, or null for the default state or for a file the learner opened. */
export function encode(state) {
  if (state.custom) return null;
  let s = state.sample;
  for (const [o, v] of state.patches) s += `+${o.toString(16)}=${v.toString(16)}`;
  if (state.sel !== null) s += `@${state.sel.toString(16)}`;
  if (state.view === "tree") s += ".t";
  if (state.view === "bytes") s += ".b";
  return s === DEFAULT_SAMPLE ? null : s;
}

/** Parse a share string; null if it is malformed or names no sample. Hostile input: strict regex. */
export function decode(str, samples) {
  if (typeof str !== "string" || str.length > 400) return null;
  const m = /^([a-z0-9-]{1,40})((?:\+[0-9a-f]{1,6}=[0-9a-f]{1,2}){0,16})(?:@([0-9a-f]{1,6}))?(?:\.([tb]))?$/.exec(str);
  if (!m) return null;
  const s = samples.find((x) => x.id === m[1]);
  if (!s) return null;
  let st = initialState(s.id);
  for (const pm of m[2].matchAll(/\+([0-9a-f]+)=([0-9a-f]+)/g)) {
    const next = step(st, { type: "patch", offset: parseInt(pm[1], 16), value: parseInt(pm[2], 16) }, samples);
    if (next === st) return null;
    st = next;
  }
  const len = bytesFor(st, samples).length;
  st = { ...st, sel: null };
  if (m[3] !== undefined) {
    const off = parseInt(m[3], 16);
    if (off >= len) return null;
    st.sel = off;
  }
  if (m[4] === "t") st.view = "tree";
  if (m[4] === "b") st.view = "bytes";
  return st;
}

/** Turn the bundled samples (samples.mjs) into { id, label, bytes, patches, ... }. */
export function loadSamples(def) {
  const byId = new Map();
  const out = [];
  for (const s of def.samples) {
    let bytes;
    if (s.hex) bytes = fromHex(s.hex);
    else bytes = byId.get(s.base).bytes;
    const one = { ...s, bytes, patches: s.patches ? s.patches.map((p) => [p[0], p[2]]) : [] };
    byId.set(s.id, one);
    out.push(one);
  }
  return out;
}

/** One-line plain-text summary for the readout. */
export function summary(r, d, sampleLabel) {
  const head = r.ok
    ? `${sampleLabel}: ${r.length} bytes, parsed: ${r.nodes.length} nodes, ${r.props.length} properties${r.warnings.length ? `, ${r.warnings.length} warning${r.warnings.length === 1 ? "" : "s"}` : ""}.`
    : `${sampleLabel}: ${r.length} bytes, refused: ${r.error.text}.`;
  if (!d) return head;
  return `${head} Selected ${d.title}. ${d.lines[0] || ""}`.trim();
}
