// repr-c-layout: the model. Pure logic, no DOM, no I/O, so `node --test` can import it.
//
// The lab answers one question from chapter 01: "where does each field of this struct live in
// memory, and does that match the C struct in the header?" To answer it honestly the model is a
// real (small) parser for the subset of Rust that FFI structs use, plus the layout rules:
//
//   * `#[repr(C)]` (the Rust Reference, "Type layout", section "The C Representation"): fields
//     stay in declaration order; each field starts at the next offset that is a multiple of its
//     alignment; the struct's alignment is the largest field alignment; its size is rounded up
//     to a multiple of that alignment. That is also what C does (C17 6.7.2.1 plus the platform
//     ABI; on Apple arm64 that is AAPCS64 with Apple's documented differences).
//   * Default representation (`repr(Rust)`): Rust promises no particular order. The model shows
//     one order Rust is *allowed* to pick (largest alignment first, which needs the least
//     padding) and says so; it never claims that is what a given compiler does.
//   * `packed`, `packed(N)`, `align(N)` and `transparent` follow the same Reference section,
//     including the combinations rustc rejects (a packed struct may not contain an align(N)
//     type at any depth, error E0588; conflicting packed hints are an error).
//   * "Promised" means the layout is fixed by a repr all the way down: a #[repr(C)] struct whose
//     field is a default-repr struct is not promised either, and #[repr(transparent)] is promised
//     when its one non-zero-sized field is.
//
// Target: aarch64-apple-darwin (the Mac this course runs on). Pointers and usize are 8 bytes;
// `c_char` is signed (Apple's arm64 ABI keeps `char` signed, unlike Linux on arm64); `c_long` is
// 8 bytes (LP64). The numbers in the tests were checked against rustc and clang on that target.
//
// Everything typed into the lab is treated as hostile input: sizes are capped, every sum is
// checked against a limit, recursion is bounded and cycles are reported, and errors are values.

export const LIMITS = Object.freeze({
  maxSource: 8192, // characters of Rust the reader may type
  maxTokens: 4096,
  maxStructs: 16,
  maxFields: 64, // per struct
  maxArrayLen: 1 << 20,
  maxSize: 2 ** 31, // bytes; any struct larger than this is rejected
  maxDepth: 12, // nesting of types (struct in struct in array ...)
  // Characters of share state accepted from the URL: the worst case for maxSource is 3 UTF-8
  // bytes per UTF-16 unit, base64 makes that 4/3 longer, plus the suffix (view name capped).
  maxShare: Math.ceil((8192 * 3) / 3) * 4 + 96,
  maxViewName: 64,
  byteMapBytes: 256, // the byte map draws at most this many bytes
});

// ---------------------------------------------------------------------------------------------
// Type tables

/** Primitive types on aarch64-apple-darwin: size, alignment, C spelling, optional note. */
const PRIMS = {
  u8: { size: 1, align: 1, c: "uint8_t", cls: "integer" },
  i8: { size: 1, align: 1, c: "int8_t", cls: "integer" },
  u16: { size: 2, align: 2, c: "uint16_t", cls: "integer" },
  i16: { size: 2, align: 2, c: "int16_t", cls: "integer" },
  u32: { size: 4, align: 4, c: "uint32_t", cls: "integer" },
  i32: { size: 4, align: 4, c: "int32_t", cls: "integer" },
  u64: { size: 8, align: 8, c: "uint64_t", cls: "integer" },
  i64: { size: 8, align: 8, c: "int64_t", cls: "integer" },
  u128: { size: 16, align: 16, c: "unsigned __int128", cls: "integer" },
  i128: { size: 16, align: 16, c: "__int128", cls: "integer" },
  usize: { size: 8, align: 8, c: "size_t", cls: "integer" },
  isize: { size: 8, align: 8, c: "intptr_t", cls: "integer" },
  f32: { size: 4, align: 4, c: "float", cls: "float" },
  f64: { size: 8, align: 8, c: "double", cls: "float" },
  bool: { size: 1, align: 1, c: "bool", cls: "bool" },
  char: {
    size: 4,
    align: 4,
    c: "uint32_t",
    cls: "integer",
    note: "Rust's `char` is not a C type (it must hold a valid Unicode scalar value); use `u32` across FFI.",
  },
};

/** Names a Rust FFI declaration may use for C types, mapped to the primitive they are. */
const RUST_ALIASES = {
  // core::ffi (also std::os::raw and libc) on aarch64-apple-darwin
  c_char: ["i8", "char"],
  c_schar: ["i8", "signed char"],
  c_uchar: ["u8", "unsigned char"],
  c_short: ["i16", "short"],
  c_ushort: ["u16", "unsigned short"],
  c_int: ["i32", "int"],
  c_uint: ["u32", "unsigned int"],
  c_long: ["i64", "long"],
  c_ulong: ["u64", "unsigned long"],
  c_longlong: ["i64", "long long"],
  c_ulonglong: ["u64", "unsigned long long"],
  c_float: ["f32", "float"],
  c_double: ["f64", "double"],
  size_t: ["usize", "size_t"],
  ssize_t: ["isize", "ssize_t"],
  // Hypervisor.framework types used in chapters 01 and 02 (the course's hvf::ffi declares them)
  hv_return_t: ["i32", "hv_return_t"],
  hv_vcpu_t: ["u64", "hv_vcpu_t"],
  hv_exit_reason_t: ["u32", "hv_exit_reason_t"],
  hv_exception_syndrome_t: ["u64", "hv_exception_syndrome_t"],
  hv_exception_address_t: ["u64", "hv_exception_address_t"],
  hv_ipa_t: ["u64", "hv_ipa_t"],
};

/** The C spellings the header excerpt uses. */
const C_TYPES = {
  uint8_t: "u8",
  int8_t: "i8",
  uint16_t: "u16",
  int16_t: "i16",
  uint32_t: "u32",
  int32_t: "i32",
  uint64_t: "u64",
  int64_t: "i64",
  int: "i32",
  char: "i8",
  float: "f32",
  double: "f64",
  bool: "bool",
  size_t: "usize",
  // Declared outside the excerpt: OS_ENUM(hv_exit_reason, uint32_t, ...) in hv_vcpu_types.h and
  // `typedef uint64_t hv_ipa_t;` in hv_vm_types.h.
  hv_exit_reason_t: "u32",
  hv_ipa_t: "u64",
};

// ---------------------------------------------------------------------------------------------
// The header excerpt: lines 61-86 of hv_vcpu_types.h in the macOS 27.2 SDK, verbatim.

export const HEADER_FILE = "Hypervisor.framework/Headers/hv_vcpu_types.h";
export const HEADER_TEXT = `/*!
 @abstract Type of a vcpu exception syndrome (Corresponds to ESR_ELx).
 */
typedef uint64_t hv_exception_syndrome_t;

/*!
 @abstract Type of a vcpu exception virtual address. (Corresponds to FAR_ELx).
 */
typedef uint64_t hv_exception_address_t;

/*!
 @abstract Contains details of a vcpu exception.
 */
typedef struct {
    hv_exception_syndrome_t syndrome;
    hv_exception_address_t virtual_address;
    hv_ipa_t physical_address;
} hv_vcpu_exit_exception_t;

/*!
 @abstract Contains information about an exit from the vcpu to the host.
 */
typedef struct {
    hv_exit_reason_t reason;
    hv_vcpu_exit_exception_t exception;
} hv_vcpu_exit_t;`;

export const HEADER_NOTES = [
  "hv_exit_reason_t is declared with OS_ENUM(hv_exit_reason, uint32_t, ...) earlier in the same file: a uint32_t.",
  "hv_ipa_t is `typedef uint64_t hv_ipa_t;` in hv_vm_types.h.",
];

// ---------------------------------------------------------------------------------------------
// Presets

const EXIT_SRC = `// The exit record, as chapter 02 declares it (hvf::ffi).
type hv_exit_reason_t = u32;
type hv_exception_syndrome_t = u64;
type hv_exception_address_t = u64;
type hv_ipa_t = u64;

#[repr(C)]
pub struct hv_vcpu_exit_exception_t {
    pub syndrome: hv_exception_syndrome_t,
    pub virtual_address: hv_exception_address_t,
    pub physical_address: hv_ipa_t,
}

#[repr(C)]
pub struct hv_vcpu_exit_t {
    pub reason: hv_exit_reason_t,
    pub exception: hv_vcpu_exit_exception_t,
}
`;

// Listed in teaching order (the lab's "Try this" list follows it): the header's own shape, the
// same bytes written flat, then the ways a declaration goes wrong, then what order costs.
export const PRESETS = [
  {
    id: "exit",
    label: "1. hv_vcpu_exit_t, as the header nests it",
    compare: "exit",
    source: EXIT_SRC,
  },
  {
    id: "flat",
    label: "2. hv_vcpu_exit_t, flattened to four fields",
    compare: "exit",
    source: `// Same bytes, no inner struct. Does it still match the header, field by field?
#[repr(C)]
struct Exit {
    reason: u32,
    syndrome: u64,
    virtual_address: u64,
    physical_address: u64,
}
`,
  },
  {
    id: "reordered",
    label: "3. Fields in a different order",
    compare: "exit",
    source: `// Same fields, reason moved to the end.
#[repr(C)]
struct Exit {
    syndrome: u64,
    virtual_address: u64,
    physical_address: u64,
    reason: u32,
}
`,
  },
  {
    id: "no-repr",
    label: "4. Forgot #[repr(C)]",
    compare: "exit",
    source: `// No repr attribute: Rust may put the fields in any order.
struct Exception {
    syndrome: u64,
    virtual_address: u64,
    physical_address: u64,
}

struct Exit {
    reason: u32,
    exception: Exception,
}
`,
  },
  {
    id: "wide-reason",
    label: "5. reason declared as u64",
    compare: "exit",
    source: `// The offsets line up, but is the reason the right size?
#[repr(C)]
struct Exit {
    reason: u64,
    syndrome: u64,
    virtual_address: u64,
    physical_address: u64,
}
`,
  },
  {
    id: "packed",
    label: "6. repr(C, packed)",
    compare: "exit",
    source: `// packed removes all padding. Smaller is not the same as correct.
#[repr(C, packed)]
struct Exit {
    reason: u32,
    syndrome: u64,
    virtual_address: u64,
    physical_address: u64,
}
`,
  },
  {
    id: "order",
    label: "7. Order costs bytes: u8, u64, u8",
    compare: "none",
    view: "Wasteful",
    source: `// In repr(C) the order you write is the order you get, padding included.
#[repr(C)]
struct Wasteful {
    a: u8,
    b: u64,
    c: u8,
}

#[repr(C)]
struct Tidy {
    b: u64,
    a: u8,
    c: u8,
}
`,
  },
];

/** The "Try this" steps shown above the presets: what to look at, and what to predict. */
export const TRY_THIS = [
  "Predict the size before you look. Then load preset 1: where are the 4 bytes of padding, and why there?",
  "Preset 2 writes the same bytes without the inner struct. Does it still line up with the header?",
  "Presets 3 and 4: which field would end up holding the syndrome, and why does a missing #[repr(C)] make every answer a guess?",
  "Presets 5 and 6: one is too wide, one is too tight. What would your code read?",
  "Preset 7: the same three fields in two orders. Count the padding in each.",
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

class LabError extends Error {
  constructor(message, line, col) {
    super(message);
    this.line = line;
    this.col = col;
  }
}

const PUNCT2 = new Set(["::", "->"]);
const PUNCT1 = new Set("#![]{}()<>,;:*&=.-+/|?@$%^~".split(""));

/**
 * Splits Rust (or the header's C) into tokens. Comments are dropped; nested block comments are
 * allowed as in Rust. Returns an array of {k, v, line, col}, kinds: id, num, str, life, p.
 */
export function tokenize(src) {
  if (typeof src !== "string") throw new LabError("source must be text", 1, 1);
  if (src.length > LIMITS.maxSource) {
    throw new LabError(`source is longer than ${LIMITS.maxSource} characters`, 1, 1);
  }
  const out = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const adv = (n) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };
  const push = (k, v, l, c) => {
    if (out.length >= LIMITS.maxTokens) throw new LabError("too much input for this lab", l, c);
    out.push({ k, v, line: l, col: c });
  };
  while (i < src.length) {
    const ch = src[i];
    const l = line;
    const c = col;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      adv(1);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") adv(1);
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      let depth = 0;
      do {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          adv(2);
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          adv(2);
        } else {
          adv(1);
        }
      } while (depth > 0 && i < src.length);
      if (depth > 0) throw new LabError("this /* comment is never closed", l, c);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      let word = src.slice(i, j);
      if (word === "r" && src[j] === "#" && /[A-Za-z_]/.test(src[j + 1] || "")) {
        let k = j + 1;
        while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k++;
        word = src.slice(j + 1, k);
        adv(k - i);
      } else {
        adv(j - i);
      }
      push("id", word, l, c);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      push("num", src.slice(i, j), l, c);
      adv(j - i);
      continue;
    }
    if (ch === '"') {
      adv(1);
      let s = "";
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") adv(1);
        s += src[i] ?? "";
        adv(1);
      }
      if (i >= src.length) throw new LabError("this string is never closed", l, c);
      adv(1);
      push("str", s, l, c);
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      if (j === i + 1 || src[j] === "'") throw new LabError("character literals are not supported here", l, c);
      push("life", src.slice(i + 1, j), l, c);
      adv(j - i);
      continue;
    }
    const two = src.slice(i, i + 2);
    if (PUNCT2.has(two)) {
      push("p", two, l, c);
      adv(2);
      continue;
    }
    if (PUNCT1.has(ch)) {
      push("p", ch, l, c);
      adv(1);
      continue;
    }
    throw new LabError(`unexpected character ${JSON.stringify(ch)}`, l, c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rust parser (the FFI subset)

class Cursor {
  constructor(toks) {
    this.t = toks;
    this.i = 0;
  }
  peek(o = 0) {
    return this.t[this.i + o] || null;
  }
  next() {
    const tok = this.t[this.i];
    if (!tok) throw this.err("unexpected end of input");
    this.i++;
    return tok;
  }
  at(k, v) {
    const tok = this.peek();
    return !!tok && tok.k === k && (v === undefined || tok.v === v);
  }
  eat(k, v) {
    if (this.at(k, v)) return this.next();
    return null;
  }
  expect(k, v, what) {
    const tok = this.peek();
    if (!tok || tok.k !== k || (v !== undefined && tok.v !== v)) {
      const found = tok ? `\`${tok.v}\`` : "the end of the input";
      throw this.err(`expected ${what || `\`${v}\``}, found ${found}`, tok);
    }
    return this.next();
  }
  err(msg, tok) {
    const at = tok || this.peek() || this.t[this.t.length - 1] || { line: 1, col: 1 };
    return new LabError(msg, at.line, at.col);
  }
  done() {
    return this.i >= this.t.length;
  }
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/** Skips one balanced group starting at an opening bracket. */
function skipGroup(cur) {
  const open = cur.next();
  const stack = [OPEN[open.v]];
  while (stack.length) {
    const tok = cur.next();
    if (tok.k !== "p") continue;
    if (OPEN[tok.v]) stack.push(OPEN[tok.v]);
    else if (tok.v === stack[stack.length - 1]) stack.pop();
    else if (tok.v === ")" || tok.v === "]" || tok.v === "}") throw cur.err(`unbalanced \`${tok.v}\``, tok);
  }
}

/**
 * Parses an integer literal. `suffixOk` is the one type suffix rustc accepts in this position:
 * "usize" for array lengths (they are usize), null for repr arguments (no suffix allowed).
 */
function parseNumber(tok, cur, suffixOk = null) {
  let s = tok.v.replace(/_/g, "");
  if (suffixOk && s.endsWith(suffixOk)) s = s.slice(0, -suffixOk.length);
  let n;
  if (/^0x[0-9a-fA-F]+$/.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^0b[01]+$/.test(s)) n = parseInt(s.slice(2), 2);
  else if (/^[0-9]+$/.test(s)) n = parseInt(s, 10);
  else if (/[ui](8|16|32|64|128|size)$/.test(s)) {
    throw cur.err(
      suffixOk ? `array lengths are usize: write \`${s.replace(/[ui](8|16|32|64|128|size)$/, "")}\` or add \`usize\`, not \`${tok.v}\`` : `write this number without a type suffix: \`${tok.v}\``,
      tok,
    );
  } else throw cur.err(`\`${tok.v}\` is not a number this lab understands`, tok);
  if (!Number.isSafeInteger(n)) throw cur.err(`\`${tok.v}\` is too large`, tok);
  return n;
}

/** Parses `#[...]` / `#![...]`; returns a repr description or null. */
function parseAttr(cur) {
  const hash = cur.expect("p", "#");
  const inner = !!cur.eat("p", "!");
  if (!cur.at("p", "[")) throw cur.err("expected `[` after `#`", hash);
  if (inner || !(cur.peek(1) && cur.peek(1).k === "id" && cur.peek(1).v === "repr")) {
    skipGroup(cur);
    return null;
  }
  cur.next(); // [
  cur.next(); // repr
  cur.expect("p", "(");
  const repr = { items: [], line: hash.line, col: hash.col };
  while (!cur.at("p", ")")) {
    const name = cur.expect("id", undefined, "a representation such as `C`");
    let arg = null;
    if (cur.eat("p", "(")) {
      arg = parseNumber(cur.expect("num", undefined, "a number"), cur);
      cur.expect("p", ")");
    }
    repr.items.push({ name: name.v, arg, tok: name });
    if (!cur.eat("p", ",")) break;
  }
  cur.expect("p", ")");
  cur.expect("p", "]");
  return repr;
}

function skipVisibility(cur) {
  if (cur.eat("id", "pub") && cur.at("p", "(")) skipGroup(cur);
}

/** Type grammar: pointers, references, arrays, paths with a few known generics, fn pointers, (). */
function parseType(cur, depth = 0) {
  if (depth > LIMITS.maxDepth) throw cur.err("type is nested too deeply");
  const tok = cur.peek();
  if (!tok) throw cur.err("expected a type");
  if (cur.eat("p", "*")) {
    const m = cur.eat("id", "const") || cur.eat("id", "mut");
    if (!m) throw cur.err("a raw pointer is `*const T` or `*mut T`");
    const to = parseType(cur, depth + 1);
    return { kind: "ptr", text: `*${m.v} ${to.text}`, to, tok };
  }
  if (cur.eat("p", "&")) {
    cur.eat("life");
    const m = cur.eat("id", "mut");
    const to = parseType(cur, depth + 1);
    return { kind: "ref", text: `&${m ? "mut " : ""}${to.text}`, to, tok };
  }
  if (cur.eat("p", "[")) {
    const elem = parseType(cur, depth + 1);
    if (!cur.eat("p", ";")) throw cur.err("slices `[T]` have no fixed size; write an array `[T; N]`");
    const lenTok = cur.expect("num", undefined, "an array length (a number)");
    const len = parseNumber(lenTok, cur, "usize");
    if (len > LIMITS.maxArrayLen) throw cur.err(`arrays longer than ${LIMITS.maxArrayLen} are not supported here`, lenTok);
    cur.expect("p", "]");
    return { kind: "array", text: `[${elem.text}; ${len}]`, elem, len, tok };
  }
  if (cur.at("p", "(")) {
    cur.next();
    if (!cur.eat("p", ")")) throw cur.err("tuples have no C layout; use a #[repr(C)] struct");
    return { kind: "unit", text: "()", tok };
  }
  if (cur.at("id", "unsafe") || cur.at("id", "extern") || cur.at("id", "fn")) {
    cur.eat("id", "unsafe");
    // `extern fn` with no ABI string is "C"; no `extern` at all is the Rust calling convention.
    let abi = "Rust";
    if (cur.eat("id", "extern")) {
      const s = cur.eat("str");
      abi = s ? s.v : "C";
    }
    cur.expect("id", "fn", "`fn`");
    if (!cur.at("p", "(")) throw cur.err("expected `(` after `fn`");
    skipGroup(cur);
    if (cur.eat("p", "->")) parseType(cur, depth + 1);
    return { kind: "fn", text: abi === "Rust" ? "fn(..)" : `extern "${abi}" fn(..)`, abi, tok };
  }
  if (tok.k !== "id") throw cur.err(`expected a type, found \`${tok.v}\``, tok);
  // Path: a::b::c, possibly with leading `::`; the last segment names the type.
  let name = cur.next().v;
  while (cur.eat("p", "::")) name = cur.expect("id", undefined, "a name after `::`").v;
  if (cur.eat("p", "<")) {
    const arg = parseType(cur, depth + 1);
    cur.expect("p", ">", "`>` (one type argument only)");
    return { kind: "generic", name, arg, text: `${name}<${arg.text}>`, tok };
  }
  return { kind: "named", name, text: name, tok };
}

/**
 * Parses a whole input into {structs: Map, aliases: Map, order: [names], warnings: []}.
 * Understands `struct` and `type` items; skips `use`, `const`, `static`, `impl`, `fn`, `extern`
 * blocks and `mod`, with a warning where it matters.
 */
export function parseRust(src) {
  const cur = new Cursor(tokenize(src));
  const structs = new Map();
  const aliases = new Map();
  const order = [];
  const warnings = [];
  let pendingRepr = null;
  while (!cur.done()) {
    if (cur.at("p", "#")) {
      const r = parseAttr(cur);
      if (r) pendingRepr = mergeRepr(pendingRepr, r);
      continue;
    }
    skipVisibility(cur);
    const kw = cur.next();
    if (kw.k === "id" && kw.v === "struct") {
      const def = parseStruct(cur, pendingRepr);
      if (structs.has(def.name) || aliases.has(def.name)) throw cur.err(`\`${def.name}\` is defined twice`, def.tok);
      if (structs.size >= LIMITS.maxStructs) throw cur.err(`more than ${LIMITS.maxStructs} structs`, def.tok);
      structs.set(def.name, def);
      order.push(def.name);
    } else if (kw.k === "id" && kw.v === "type") {
      const name = cur.expect("id", undefined, "a type name");
      if (cur.at("p", "<")) throw cur.err("generic type aliases are not supported here");
      cur.expect("p", "=");
      const ty = parseType(cur);
      cur.expect("p", ";");
      if (structs.has(name.v) || aliases.has(name.v)) throw cur.err(`\`${name.v}\` is defined twice`, name);
      aliases.set(name.v, { name: name.v, ty, tok: name });
    } else if (kw.k === "id" && ["use", "const", "static", "impl", "fn", "extern", "mod", "unsafe", "enum", "union", "trait"].includes(kw.v)) {
      if (kw.v === "enum" || kw.v === "union") {
        warnings.push({ message: `\`${kw.v}\` items are skipped: this lab lays out structs only.`, line: kw.line });
      } else if (["impl", "fn", "extern", "mod", "trait"].includes(kw.v)) {
        warnings.push({ message: `\`${kw.v}\` is skipped: only struct and type items affect layout.`, line: kw.line });
      }
      skipItem(cur);
    } else {
      throw cur.err(`expected \`struct\` or \`type\`, found \`${kw.v}\``, kw);
    }
    if (pendingRepr && !(kw.k === "id" && kw.v === "struct")) {
      warnings.push({ message: "a #[repr(...)] attribute only applies to the struct right after it.", line: pendingRepr.line });
    }
    pendingRepr = null;
  }
  if (pendingRepr) warnings.push({ message: "a #[repr(...)] attribute at the end applies to nothing.", line: pendingRepr.line });
  return { structs, aliases, order, warnings };
}

function mergeRepr(a, b) {
  if (!a) return b;
  return { items: [...a.items, ...b.items], line: a.line, col: a.col };
}

function skipItem(cur) {
  // Skip to a `;` or past one balanced `{...}` block at depth 0, whichever comes first.
  while (!cur.done()) {
    if (cur.at("p", ";")) {
      cur.next();
      return;
    }
    if (cur.at("p", "{")) {
      skipGroup(cur);
      cur.eat("p", ";");
      return;
    }
    if (cur.at("p", "(") || cur.at("p", "[")) {
      skipGroup(cur);
      continue;
    }
    cur.next();
  }
}

function parseStruct(cur, repr) {
  const nameTok = cur.expect("id", undefined, "a struct name");
  if (cur.at("p", "<")) throw cur.err("generic structs are not supported here", cur.peek());
  const fields = [];
  if (cur.eat("p", ";")) {
    return { name: nameTok.v, tok: nameTok, fields, repr: interpretRepr(repr, cur) };
  }
  if (cur.at("p", "(")) throw cur.err("tuple structs are not supported here; give the fields names", cur.peek());
  cur.expect("p", "{");
  while (!cur.at("p", "}")) {
    while (cur.at("p", "#")) {
      const r = parseAttr(cur);
      if (r) throw cur.err("#[repr] goes on the struct, not on a field");
    }
    skipVisibility(cur);
    const f = cur.expect("id", undefined, "a field name");
    cur.expect("p", ":");
    const ty = parseType(cur);
    if (fields.some((g) => g.name === f.v)) throw cur.err(`field \`${f.v}\` is declared twice`, f);
    if (fields.length >= LIMITS.maxFields) throw cur.err(`more than ${LIMITS.maxFields} fields`, f);
    fields.push({ name: f.v, ty, tok: f });
    if (!cur.eat("p", ",")) break;
  }
  cur.expect("p", "}");
  return { name: nameTok.v, tok: nameTok, fields, repr: interpretRepr(repr, cur) };
}

const POW2 = (n) => Number.isInteger(n) && n >= 1 && n <= 1 << 29 && (n & (n - 1)) === 0;

/** Turns repr items into {kind: "C"|"Rust"|"transparent", packed: N|null, align: N|null}. */
function interpretRepr(repr, cur) {
  const r = { kind: "Rust", packed: null, align: null, written: repr ? repr.items.map(reprText).join(", ") : "" };
  if (!repr) return r;
  for (const it of repr.items) {
    if (it.name === "C") r.kind = r.kind === "transparent" ? bad(it, "`C` and `transparent` cannot be combined") : "C";
    else if (it.name === "Rust") r.kind = r.kind === "Rust" ? "Rust" : bad(it, "`Rust` cannot be combined with another representation");
    else if (it.name === "transparent") r.kind = r.kind === "Rust" ? "transparent" : bad(it, "`transparent` cannot be combined with `C`");
    else if (it.name === "packed") {
      const n = it.arg === null ? 1 : it.arg;
      if (!POW2(n)) bad(it, "packed(N) needs a power of two");
      if (r.packed !== null && r.packed !== n) bad(it, "conflicting packed hints: write packed or packed(N) once");
      r.packed = n;
    } else if (it.name === "align") {
      if (it.arg === null) bad(it, "align needs a value, as in align(16)");
      if (!POW2(it.arg)) bad(it, "align(N) needs a power of two");
      r.align = Math.max(r.align || 1, it.arg);
    } else if (/^[ui](8|16|32|64|128|size)$/.test(it.name)) {
      bad(it, `repr(${it.name}) is for enums, not structs`);
    } else {
      bad(it, `unknown representation \`${it.name}\``);
    }
  }
  if (r.packed !== null && r.align !== null) bad(repr.items[0], "a struct cannot be both packed and align(N)");
  if (r.kind === "transparent" && (r.packed !== null || r.align !== null)) bad(repr.items[0], "`transparent` cannot be combined with packed or align");
  return r;
  function bad(it, msg) {
    throw cur.err(msg, it.tok);
  }
}

function reprText(it) {
  return it.arg === null ? it.name : `${it.name}(${it.arg})`;
}

// ---------------------------------------------------------------------------------------------
// C parser: just enough for the header excerpt (typedef T name; and typedef struct {...} name;)

export function parseCHeader(src) {
  const cur = new Cursor(tokenize(src));
  const structs = new Map();
  const aliases = new Map();
  const order = [];
  while (!cur.done()) {
    cur.expect("id", "typedef", "`typedef`");
    if (cur.eat("id", "struct")) {
      cur.eat("id"); // optional tag
      cur.expect("p", "{");
      const fields = [];
      while (!cur.at("p", "}")) {
        const t = cur.expect("id", undefined, "a C type");
        const f = cur.expect("id", undefined, "a field name");
        cur.expect("p", ";");
        fields.push({ name: f.v, ty: { kind: "named", name: t.v, text: t.v, tok: t }, tok: f });
      }
      cur.expect("p", "}");
      const name = cur.expect("id", undefined, "the typedef name");
      cur.expect("p", ";");
      structs.set(name.v, { name: name.v, tok: name, fields, repr: { kind: "C", packed: null, align: null, written: "C" }, isC: true });
      order.push(name.v);
    } else {
      const t = cur.expect("id", undefined, "a C type");
      const name = cur.expect("id", undefined, "the typedef name");
      cur.expect("p", ";");
      aliases.set(name.v, { name: name.v, ty: { kind: "named", name: t.v, text: t.v, tok: t }, tok: name });
    }
  }
  return { structs, aliases, order, warnings: [], lang: "c" };
}

// ---------------------------------------------------------------------------------------------
// Layout engine

const alignUp = (n, a) => Math.ceil(n / a) * a;

function checkSize(n, cur, what) {
  if (!Number.isSafeInteger(n) || n > LIMITS.maxSize) {
    throw new LabError(`${what} would be larger than ${LIMITS.maxSize} bytes, more than this lab handles`, cur.line, cur.col);
  }
  return n;
}

/**
 * Lays out every struct in a parsed program. Returns {layouts: Map<name, StructLayout>,
 * warnings}. Throws LabError for programs that have no layout (cycles, unknown types, ...).
 */
function layoutProgram(prog) {
  const isC = prog.lang === "c";
  const memo = new Map();
  const visiting = [];
  const warnings = [...prog.warnings];
  const warned = new Set();
  const warn = (message, line) => {
    const key = `${message}@${line}`;
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push({ message, line });
  };

  function resolveNamed(ty, depth) {
    const name = ty.name;
    if (prog.structs.has(name)) {
      const sl = layoutStruct(prog.structs.get(name), depth + 1);
      return { size: sl.size, align: sl.align, c: name, struct: sl, cls: "struct", promised: sl.promised, brokenBy: sl.brokenBy, alignBy: sl.alignBy };
    }
    if (prog.aliases.has(name)) {
      if (visiting.includes(`type ${name}`)) throw new LabError(`type alias \`${name}\` refers to itself`, ty.tok.line, ty.tok.col);
      visiting.push(`type ${name}`);
      try {
        const inner = layoutType(prog.aliases.get(name).ty, depth + 1);
        return { ...inner, c: name, aliasOf: inner, aliasName: name };
      } finally {
        visiting.pop();
      }
    }
    if (isC) {
      const p = C_TYPES[name];
      if (p) return { ...PRIMS[p], c: name, prim: p };
    } else {
      if (PRIMS[name]) {
        if (PRIMS[name].note) warn(PRIMS[name].note, ty.tok.line);
        return { ...PRIMS[name], prim: name };
      }
      const a = RUST_ALIASES[name];
      if (a) return { ...PRIMS[a[0]], c: a[1], prim: a[0] };
      if (name === "c_void") {
        throw new LabError("`c_void` has no size: use it only behind a pointer, as `*mut c_void`", ty.tok.line, ty.tok.col);
      }
      if (/^(uint|int)(8|16|32|64)_t$/.test(name)) {
        throw new LabError(`\`${name}\` is the C name; in Rust write \`${name.startsWith("u") ? "u" : "i"}${name.match(/\d+/)[0]}\``, ty.tok.line, ty.tok.col);
      }
    }
    throw new LabError(`unknown type \`${name}\` (define it in the box, or use a primitive such as u32)`, ty.tok.line, ty.tok.col);
  }

  function pointeeC(ty) {
    if (ty.kind === "named") {
      if (ty.name === "c_void") return "void";
      if (RUST_ALIASES[ty.name]) return RUST_ALIASES[ty.name][1];
      if (PRIMS[ty.name]) return PRIMS[ty.name].c;
      return ty.name;
    }
    if (ty.kind === "ptr" || ty.kind === "ref") return `${pointeeC(ty.to)} *`;
    return "void";
  }

  // A fn pointer C will call (or that Rust calls into C) needs the C calling convention.
  function fnAbi(ty) {
    if (!["C", "C-unwind", "system"].includes(ty.abi)) {
      warn(`\`${ty.abi === "Rust" ? "fn(...)" : `extern "${ty.abi}" fn(...)`}\` does not use the C calling convention: write \`extern "C" fn(...)\` for a pointer that crosses to C.`, ty.tok.line);
    }
  }

  function layoutType(ty, depth) {
    if (depth > LIMITS.maxDepth) throw new LabError("types are nested too deeply", ty.tok.line, ty.tok.col);
    switch (ty.kind) {
      case "named":
        return resolveNamed(ty, depth);
      case "ptr":
        return { size: 8, align: 8, c: `${pointeeC(ty.to)} *`, cls: "pointer" };
      case "ref":
        warn("A reference (`&T`) must never be null; C may pass NULL. Use a raw pointer or Option<&T> where NULL is possible.", ty.tok.line);
        return { size: 8, align: 8, c: `${pointeeC(ty.to)} *`, cls: "pointer" };
      case "fn":
        // A bare fn pointer, not inside Option (that case is below).
        warn("A fn pointer must never be null; C may pass NULL. Use Option<extern \"C\" fn(...)> where NULL is possible.", ty.tok.line);
        fnAbi(ty);
        return { size: 8, align: 8, c: "void (*)(/* ... */)", cls: "pointer" };
      case "unit":
        warn("`()` has size 0 and no C equivalent.", ty.tok.line);
        return { size: 0, align: 1, c: "/* () */", cls: "none" };
      case "array": {
        const e = layoutType(ty.elem, depth + 1);
        const size = checkSize(e.size * ty.len, ty.tok, "this array");
        return { size, align: e.align, c: e.c, cls: e.cls, array: { elem: e, len: ty.len }, promised: e.promised, brokenBy: e.brokenBy, alignBy: e.alignBy };
      }
      case "generic": {
        const a = ty.arg;
        if (ty.name === "Option" && (a.kind === "ref" || a.kind === "fn" || (a.kind === "generic" && a.arg && a.name === "NonNull"))) {
          if (a.kind === "fn") fnAbi(a);
          return { size: 8, align: 8, cls: "pointer", c: a.kind === "fn" ? "void (*)(/* ... */)" : `${pointeeC(a.kind === "generic" ? a.arg : a.to)} *` };
        }
        if (ty.name === "NonNull") return { size: 8, align: 8, c: `${pointeeC(a)} *`, cls: "pointer" };
        if (ty.name === "MaybeUninit" || ty.name === "ManuallyDrop") return layoutType(a, depth + 1);
        if (ty.name === "PhantomData") return { size: 0, align: 1, c: "/* PhantomData */", cls: "none" };
        if (ty.name === "Option") {
          throw new LabError(`\`${ty.text}\` has no C layout; only Option of a reference, a fn pointer or NonNull does`, ty.tok.line, ty.tok.col);
        }
        throw new LabError(`\`${ty.text}\` is not a type this lab knows`, ty.tok.line, ty.tok.col);
      }
      default:
        throw new LabError("unsupported type", ty.tok.line, ty.tok.col);
    }
  }

  function layoutStruct(def, depth) {
    if (memo.has(def.name)) return memo.get(def.name);
    const idx = visiting.indexOf(def.name);
    if (idx >= 0) {
      const chain = [...visiting.slice(idx).filter((v) => !v.startsWith("type ")), def.name].join(" -> ");
      throw new LabError(`\`${def.name}\` contains itself by value (${chain}), so its size would be infinite; use a pointer`, def.tok.line, def.tok.col);
    }
    if (depth > LIMITS.maxDepth) throw new LabError("structs are nested too deeply", def.tok.line, def.tok.col);
    visiting.push(def.name);
    let result;
    try {
      const fields = def.fields.map((f, i) => {
        const t = layoutType(f.ty, depth + 1);
        if (def.repr.kind !== "Rust" && t.promised === false) {
          warn(`\`${def.name}.${f.name}\` contains \`${t.brokenBy}\`, which is not #[repr(C)]: its inside layout is not promised, so neither is this struct's.`, f.tok.line);
        }
        if (def.repr.packed !== null && t.alignBy) {
          throw new LabError(
            `\`${def.name}\` is packed, so it cannot contain \`${t.alignBy}\`, which has #[repr(align)] (rustc rejects this with error E0588, even when the align type is nested deeper)`,
            f.tok.line,
            f.tok.col,
          );
        }
        return { index: i, name: f.name, rust: f.ty.text, c: t.c, size: t.size, align: t.align, type: t, line: f.tok.line };
      });
      result = placeFields(def, fields);
      // Promised: fixed by a repr all the way down (see the file header).
      let brokenBy = null;
      if (def.repr.kind === "Rust") brokenBy = def.name;
      else {
        const f = fields.find((g) => g.type.promised === false);
        if (f) brokenBy = f.type.brokenBy;
      }
      result.promised = brokenBy === null;
      result.brokenBy = brokenBy;
      const inner = fields.find((g) => g.type.alignBy);
      result.alignBy = def.repr.align !== null ? def.name : inner ? inner.type.alignBy : null;
    } finally {
      visiting.pop();
    }
    if (def.repr.kind === "C" && def.fields.length === 0 && !def.isC) {
      warn(`\`${def.name}\` has no fields: Rust gives it size 0, but an empty struct is not valid C.`, def.tok.line);
    }
    memo.set(def.name, result);
    return result;
  }

  function placeFields(def, fields) {
    const repr = def.repr;
    if (repr.kind === "transparent") {
      const nonZero = fields.filter((f) => f.size !== 0);
      if (nonZero.length !== 1) {
        throw new LabError("#[repr(transparent)] needs exactly one field with a non-zero size", def.tok.line, def.tok.col);
      }
    }
    // Field order: declaration order for C and transparent; one allowed order for Rust.
    let placed = fields.slice();
    if (repr.kind === "Rust") placed.sort((a, b) => b.align - a.align || a.index - b.index);
    let off = 0;
    let maxAlign = 1;
    const out = [];
    for (const f of placed) {
      const a = repr.packed !== null ? Math.min(f.align, repr.packed) : f.align;
      const start = alignUp(off, a);
      out.push({ ...f, offset: start, padBefore: start - off, effAlign: a });
      off = checkSize(start + f.size, def.tok, `\`${def.name}\``);
      maxAlign = Math.max(maxAlign, a);
    }
    let align = maxAlign;
    if (repr.align !== null) align = Math.max(align, repr.align);
    const size = checkSize(alignUp(off, align), def.tok, `\`${def.name}\``);
    const tailPad = size - off;
    const padding = out.reduce((s, f) => s + f.padBefore, 0) + tailPad;
    // What the same fields would cost in the least-padding order (largest alignment first).
    let best = null;
    if (repr.kind === "C" && repr.packed === null && !def.isC) {
      const sorted = fields.slice().sort((a, b) => b.align - a.align || a.index - b.index);
      let o = 0;
      for (const f of sorted) o = alignUp(o, f.align) + f.size;
      best = alignUp(o, align);
    }
    return {
      name: def.name,
      repr,
      fields: out,
      declOrder: fields.map((f) => f.name),
      reordered: out.some((f, i) => f.index !== i),
      size,
      align,
      tailPad,
      padding,
      bestSize: best,
      line: def.tok.line,
    };
  }

  const layouts = new Map();
  for (const name of prog.order) layouts.set(name, layoutStruct(prog.structs.get(name), 0));
  for (const [, a] of prog.aliases) layoutType(a.ty, 0); // report bad aliases even if unused
  return { layouts, warnings };
}

// ---------------------------------------------------------------------------------------------
// Flattening, byte map, comparison

/**
 * Flattens a struct layout to its leaf fields (primitives, pointers, arrays), with absolute
 * offsets. With `expand`, small arrays (up to 64 leaves) are split into one leaf per element
 * (`s[0]`, `s[1]`, ...), so `[u64; 3]` compares like three u64 fields.
 */
export function leaves(layout, opts = {}, base = 0, prefix = "") {
  const out = [];
  for (const f of layout.fields) pushLeaves(f.type, base + f.offset, prefix ? `${prefix}.${f.name}` : f.name, f.rust, opts, out);
  return out;
}

function leafCount(t) {
  if (t.struct) return t.struct.fields.reduce((s, f) => s + leafCount(f.type), 0);
  if (t.array) return t.array.len * leafCount(t.array.elem);
  return 1;
}

function pushLeaves(t, off, path, rust, opts, out) {
  if (t.struct) {
    out.push(...leaves(t.struct, opts, off, path));
  } else if (t.array && opts.expand && leafCount(t) <= 64) {
    const e = t.array.elem;
    for (let i = 0; i < t.array.len; i++) pushLeaves(e, off + i * e.size, `${path}[${i}]`, null, opts, out);
  } else {
    out.push({ path, offset: off, size: t.size, c: t.c, rust, cls: t.array ? "array" : t.cls || "none" });
  }
}

/**
 * Splits [0, size) into field and padding segments for drawing, capped at LIMITS.byteMapBytes.
 * Zero-sized fields take no bytes and are left out.
 */
export function byteMap(layout) {
  const ls = leaves(layout).filter((l) => l.size > 0).sort((a, b) => a.offset - b.offset);
  const segs = [];
  let at = 0;
  for (const l of ls) {
    if (l.offset > at) segs.push({ kind: "pad", offset: at, size: l.offset - at, label: "padding" });
    segs.push({ kind: "field", offset: l.offset, size: l.size, label: l.path });
    at = Math.max(at, l.offset + l.size);
  }
  if (layout.size > at) segs.push({ kind: "pad", offset: at, size: layout.size - at, label: "padding" });
  const cap = LIMITS.byteMapBytes;
  const shown = [];
  for (const s of segs) {
    if (s.offset >= cap) break;
    shown.push(s.offset + s.size > cap ? { ...s, size: cap - s.offset, cut: true } : s);
  }
  return { segments: shown, total: layout.size, truncated: layout.size > cap };
}

const CLS_TEXT = { integer: "an integer", float: "a floating-point number", pointer: "a pointer", bool: "a bool", array: "an array", none: "nothing" };
const leafKey = (path) => path.slice(path.lastIndexOf(".") + 1);

/**
 * What the header puts in bytes [start, end): its leaf names, "padding", or "past the end".
 * Used to say what a misplaced or mis-sized field would actually read.
 */
function describeRange(refLeaves, refSize, start, end) {
  const hit = refLeaves.filter((l) => l.offset < end && l.offset + l.size > start).sort((p, q) => p.offset - q.offset);
  const parts = [];
  let at = start;
  for (const l of hit) {
    if (l.offset > at && !parts.includes("padding")) parts.push("padding");
    parts.push(l.path);
    at = Math.max(at, l.offset + l.size);
  }
  if (Math.min(end, refSize) > at && !parts.includes("padding")) parts.push("padding");
  if (end > refSize) parts.push(`bytes past the end of the header's ${refSize}`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] || "nothing";
  return { text, padOnly: hit.length === 0 && end <= refSize };
}

/**
 * Compares the reader's struct with a reference struct (the header's), field by field.
 *
 * Leaves are paired by name first (the last part of the path, so `syndrome` pairs with
 * `exception.syndrome`), then any left over are paired in offset order. Each row gets a status:
 *   "ok"      same name, offset, size and kind of value (integer, float, pointer, bool);
 *   "renamed" same offset, size and kind, but a different name: the bytes line up, the meaning
 *             is the reader's to check;
 *   "bad"     anything else, with `why` (what differs) and `effect` (what the code would read).
 * Signedness is ignored: u32 against int32_t is the same bytes. `match` needs no "bad" row, the
 * same size and alignment, and a layout that is promised all the way down.
 */
export function compareLayouts(yours, ref) {
  const a = leaves(yours, { expand: true }).filter((l) => l.size > 0);
  const b = leaves(ref, { expand: true }).filter((l) => l.size > 0);
  const counts = new Map();
  for (const y of a) counts.set(leafKey(y.path), (counts.get(leafKey(y.path)) || 0) + 1);
  const used = new Set();
  const pairs = b.map((h) => {
    const k = leafKey(h.path);
    if (counts.get(k) !== 1) return { header: h, yours: null, byName: false };
    const y = a.find((x) => leafKey(x.path) === k);
    used.add(y);
    return { header: h, yours: y, byName: true };
  });
  const rest = a.filter((y) => !used.has(y)).sort((p, q) => p.offset - q.offset);
  for (const p of pairs) if (!p.yours && rest.length) p.yours = rest.shift();
  for (const y of rest) pairs.push({ header: null, yours: y, byName: false });

  const rows = pairs.map(({ yours: y, header: h, byName }) => {
    const row = { yours: y, header: h, byName, status: "bad", ok: false, why: "", effect: "" };
    if (!y) {
      row.why = "missing in yours";
      row.effect = "Your struct has nothing here, so this value never reaches your code.";
      return row;
    }
    if (!h) {
      const r = describeRange(b, ref.size, y.offset, y.offset + y.size);
      row.why = "the header has no field here";
      row.effect = `These bytes are ${r.text} in the header: the framework never writes a value for ${y.path}.`;
      return row;
    }
    const name = byName ? leafKey(y.path) : y.path;
    const whys = [];
    const effects = [];
    if (y.offset !== h.offset) {
      const r = describeRange(b, ref.size, y.offset, y.offset + y.size);
      const there = b.find((l) => l.offset === y.offset);
      const note = there ? `${there.path} is at ${y.offset}` : r.padOnly ? `that is padding in the header` : `the header has ${r.text} there`;
      whys.push(byName ? `${name} is at offset ${y.offset}; the header has it at ${h.offset} (${note})` : `${y.path} is at offset ${y.offset}; the header's ${h.path} is at ${h.offset}`);
      effects.push(`Reading ${y.path} gets the bytes the framework wrote for ${r.text}${r.padOnly ? ", whose contents are unspecified" : ""}.`);
    }
    if (y.size !== h.size) {
      whys.push(`size ${y.size}; the header has ${h.size}`);
      if (y.offset === h.offset && y.size > h.size) {
        const r = describeRange(b, ref.size, h.offset + h.size, y.offset + y.size);
        effects.push(
          `The framework writes only ${h.size} bytes here; the other ${y.size - h.size} bytes you read are ${r.text}${r.padOnly ? " with unspecified contents, so the value is garbage" : ", so the value is wrong"}.`,
        );
      } else if (y.offset === h.offset) {
        effects.push(`You read only ${y.size} of the ${h.size} bytes the framework writes, so the value is cut short.`);
      }
    }
    if (y.offset === h.offset && y.size === h.size && y.cls !== h.cls) {
      whys.push(`same place and size, but ${CLS_TEXT[y.cls] || y.cls}; the header has ${CLS_TEXT[h.cls] || h.cls}`);
      effects.push(`The bits are the same, but read as ${CLS_TEXT[y.cls] || y.cls} instead of ${CLS_TEXT[h.cls] || h.cls} they mean something else.`);
    }
    if (whys.length) {
      row.why = whys.join("; and ");
      row.effect = effects.join(" ");
    } else if (byName) {
      row.status = "ok";
      row.ok = true;
      row.why = "same name, place, size and kind of value";
    } else {
      row.status = "renamed";
      row.ok = true;
      row.why = "same place and size, different name: does it hold the same data?";
    }
    return row;
  });
  const sizeOk = yours.size === ref.size;
  const alignOk = yours.align === ref.align;
  const promised = yours.promised !== false;
  return {
    rows,
    sizeOk,
    alignOk,
    promised,
    brokenBy: yours.brokenBy || null,
    renamed: rows.filter((r) => r.status === "renamed").length,
    refSize: ref.size,
    refAlign: ref.align,
    match: promised && sizeOk && alignOk && rows.every((r) => r.status !== "bad"),
  };
}

// ---------------------------------------------------------------------------------------------
// C rendering of the reader's structs

/** Renders the reader's structs as the C a header would declare for them (dependency order). */
export function renderC(result, rootName) {
  const lines = [];
  const done = new Set();
  const arrSuffix = (t) => (t.array && !t.aliasName ? `[${t.array.len}]${arrSuffix(t.array.elem)}` : "");
  const decl = (c, name) => (c.includes("(*)") ? c.replace("(*)", `(*${name})`) : `${c}${c.endsWith("*") ? "" : " "}${name}`);
  // Walks a field type: emits the structs and typedefs it needs before the struct that uses it.
  const need = (t) => {
    if (!t) return;
    if (t.aliasName) {
      if (done.has(`type ${t.aliasName}`)) return;
      done.add(`type ${t.aliasName}`);
      need(t.aliasOf);
      // Names the platform headers already declare (stdint, Hypervisor.framework) need no typedef.
      if (!RUST_ALIASES[t.aliasName]) lines.push(`typedef ${decl(t.aliasOf.c, t.aliasName + arrSuffix(t.aliasOf))};`, "");
      return;
    }
    if (t.struct) emit(t.struct.name);
    if (t.array) need(t.array.elem);
  };
  const emit = (name) => {
    if (done.has(name)) return;
    done.add(name);
    const l = result.layouts.get(name);
    if (!l) return;
    for (const f of l.fields) need(f.type);
    if (l.repr.kind === "Rust") lines.push("/* No C equivalent: without #[repr(C)], Rust may reorder these fields. */");
    if (l.repr.kind === "transparent") lines.push("/* repr(transparent): the same layout as its one non-zero-sized field. */");
    if (l.repr.packed !== null && l.repr.packed > 1) lines.push(`#pragma pack(push, ${l.repr.packed})`);
    lines.push("typedef struct {");
    for (const f of l.declOrder.map((n) => l.fields.find((g) => g.name === n))) {
      lines.push(`    ${decl(f.c, f.name + arrSuffix(f.type))};`);
    }
    let attr = "";
    if (l.repr.packed === 1) attr = " __attribute__((packed))";
    else if (l.repr.align !== null) attr = ` __attribute__((aligned(${l.repr.align})))`;
    lines.push(`}${attr} ${name};`);
    if (l.repr.packed !== null && l.repr.packed > 1) lines.push("#pragma pack(pop)");
    lines.push("");
  };
  emit(rootName);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Top-level analysis

let headerCache = null;
/** The header's hv_vcpu_exit_t, laid out by the same engine from the verbatim excerpt. */
export function headerLayout() {
  if (!headerCache) {
    const prog = parseCHeader(HEADER_TEXT);
    const { layouts } = layoutProgram(prog);
    headerCache = layouts.get("hv_vcpu_exit_t");
  }
  return headerCache;
}

/** The struct to show by default: the last struct no other struct contains by value. */
function pickRoot(result) {
  const contained = new Set();
  for (const [, l] of result.layouts) {
    for (const f of l.fields) {
      const t = f.type.aliasOf && f.type.aliasOf.struct ? f.type.aliasOf : f.type;
      if (t.struct) contained.add(t.struct.name);
      if (t.array && t.array.elem.struct) contained.add(t.array.elem.struct.name);
    }
  }
  const names = [...result.layouts.keys()];
  const roots = names.filter((n) => !contained.has(n));
  return roots.length ? roots[roots.length - 1] : names[names.length - 1] || null;
}

/**
 * Analyses one input. Returns either
 *   {ok: true, names, root, layout, layouts, warnings, c, compare|null, bytes, summary}
 * or {ok: false, error: {message, line, col}}.
 * `opts.view` picks the struct to show; `opts.compare` is "exit" or "none".
 */
export function analyze(source, opts = {}) {
  let result;
  try {
    const prog = parseRust(source);
    if (prog.order.length === 0) {
      return { ok: false, error: { message: "type a struct, for example: #[repr(C)] struct S { a: u32, b: u64 }", line: 1, col: 1 } };
    }
    result = layoutProgram(prog);
  } catch (e) {
    if (e instanceof LabError) return { ok: false, error: { message: e.message, line: e.line, col: e.col } };
    throw e;
  }
  const names = [...result.layouts.keys()];
  const root = opts.view && result.layouts.has(opts.view) ? opts.view : pickRoot(result);
  const layout = result.layouts.get(root);
  const compare = opts.compare === "exit" ? compareLayouts(layout, headerLayout()) : null;
  const out = {
    ok: true,
    names,
    root,
    layout,
    layouts: result.layouts,
    warnings: result.warnings,
    c: renderC(result, root),
    compare,
    bytes: byteMap(layout),
  };
  out.summary = summarize(out);
  return out;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One plain sentence for the live region. */
export function summarize(a) {
  if (!a.ok) return `Error on line ${a.error.line}: ${a.error.message}`;
  const l = a.layout;
  const gaps = [];
  for (const f of l.fields) if (f.padBefore) gaps.push(`${f.padBefore} before ${f.name}`);
  if (l.tailPad) gaps.push(`${l.tailPad} at the end`);
  let s = `${l.name}: ${plural(l.size, "byte")}, align ${l.align}`;
  s += l.padding ? `, ${plural(l.padding, "byte")} of padding (${gaps.join(", ")}).` : ", no padding.";
  if (l.repr.kind === "Rust") s += " Not repr(C): Rust promises no order; shown is one order it may pick.";
  const c = a.compare;
  if (c) {
    if (!c.promised) {
      s += ` Does not match the header: nothing is promised, because ${c.brokenBy === l.name ? "it has" : `${c.brokenBy}, inside it, has`} no repr(C).`;
    } else if (c.match) {
      s += ` Matches the header's hv_vcpu_exit_t field by field: offsets ${c.rows.map((r) => r.yours.offset).join(", ")}`;
      s += c.renamed ? `; ${plural(c.renamed, "field")} under another name.` : ".";
    } else {
      const bad = c.rows.find((r) => r.status === "bad");
      if (bad) s += ` Does not match the header: ${bad.yours ? bad.yours.path : bad.header.path}: ${bad.why}.`;
      else s += ` Does not match the header: size ${l.size} and align ${l.align}; the header's are ${c.refSize} and ${c.refAlign}.`;
    }
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Lab state and share string

/** Initial state: the first preset. `custom` keeps the reader's own text while a preset shows. */
export function initialState() {
  return { ...presetState(PRESETS[0]), custom: null };
}

function presetState(p) {
  return { preset: p.id, source: p.source, compare: p.compare, view: p.view || null };
}

/** State transitions. `action` is {type, ...}. Returns a new state object. */
export function step(state, action) {
  switch (action.type) {
    case "preset": {
      const p = presetById(action.id);
      if (!p) return state;
      // Loading a preset never loses the reader's own struct: it is kept in `custom`.
      return { ...presetState(p), custom: state.preset ? state.custom : state.source };
    }
    case "custom": {
      // Back to "(your own struct)": restore the kept text, if there is any.
      if (state.custom === null || state.custom === undefined) return state.preset ? { ...state, preset: null } : state;
      return { preset: null, source: state.custom, compare: state.compare, view: null, custom: state.custom };
    }
    case "edit": {
      const source = String(action.source).slice(0, LIMITS.maxSource);
      const p = PRESETS.find((q) => q.source === source);
      return { ...state, source, preset: p ? p.id : null, custom: p ? state.custom : source };
    }
    case "compare":
      return { ...state, compare: action.value === "exit" ? "exit" : "none" };
    case "view":
      return { ...state, view: typeof action.name === "string" ? action.name : null };
    case "reset":
      return { ...initialState(), custom: state.preset ? state.custom : state.source };
    default:
      return state;
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s;
}

function b64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const VIEW_RE = new RegExp(`^[A-Za-z_][A-Za-z0-9_]{0,${LIMITS.maxViewName - 1}}$`);

/**
 * Share string: `p.<preset>` when the text is a preset unchanged, else `s.<base64url UTF-8>`;
 * then `.n` if comparison is off for a preset that compares (or `.x` if on for one that does not),
 * then `.v.<struct name>` when a struct other than the preset's default is shown. Returns null
 * when the string would be longer than decodeShare accepts, so the view can say so instead of
 * writing a link that will not load. The reader's kept text (`custom`) is never shared.
 */
export function encodeShare(state) {
  const p = state.preset ? presetById(state.preset) : null;
  let s = p ? `p.${p.id}` : `s.${b64urlEncode(new TextEncoder().encode(state.source))}`;
  const defCompare = p ? p.compare : "exit";
  if (state.compare !== defCompare) s += state.compare === "none" ? ".n" : ".x";
  const defView = p ? p.view || null : null;
  if (state.view && state.view !== defView && VIEW_RE.test(state.view)) s += `.v.${state.view}`;
  return s.length > LIMITS.maxShare ? null : s;
}

/** Parses a share string back into a state, or returns null if it is not one of ours. */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > LIMITS.maxShare) return null;
  const parts = str.split(".");
  let state;
  if (parts[0] === "p") {
    const p = presetById(parts[1]);
    if (!p) return null;
    state = { ...presetState(p), custom: null };
  } else if (parts[0] === "s") {
    const bytes = b64urlDecode(parts[1] || "");
    if (!bytes) return null;
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    if (source.length > LIMITS.maxSource) return null;
    const p = PRESETS.find((q) => q.source === source);
    state = p ? { ...presetState(p), custom: null } : { preset: null, source, compare: "exit", view: null, custom: null };
  } else {
    return null;
  }
  let i = 2;
  while (i < parts.length) {
    if (parts[i] === "n") state.compare = "none";
    else if (parts[i] === "x") state.compare = "exit";
    else if (parts[i] === "v" && VIEW_RE.test(parts[i + 1] || "")) {
      state.view = parts[i + 1];
      i++;
    } else return null;
    i++;
  }
  return state;
}
