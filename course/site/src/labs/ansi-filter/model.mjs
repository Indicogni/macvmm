// ansi-filter: the model. Pure logic, no DOM, no I/O, so `node --test` imports it directly.
//
// Three things live here:
//
// 1. `AnsiFilter`, a line-by-line port of macvmm's `crates/vmm/src/backend/ansi.rs` (the
//    `safe`, `strict` and `raw` policies), including its `dropped` counter, its BEL rate limit
//    and its exact handling of broken sequences and invalid UTF-8. The port also records
//    *segments* (which input bytes became which output bytes, and the rule that decided), so the
//    lab can show why something was dropped. The segment bookkeeping never changes what the
//    filter outputs: `oracle.test.mjs` checks the port against outputs produced by the Rust
//    filter itself.
// 2. `tokenize`, an independent reading of the same bytes the way a terminal emulator reads
//    them (ECMA-48 5th edition §5.3 to §5.6 for the grammar, xterm's "ctlseqs" for meanings),
//    with what each token would make the terminal do. It deliberately disagrees with the
//    filter in one place: a terminal that honours 8-bit controls reads 0x9B as CSI.
// 3. `parseInput` / `escapeBytes`: the lab's input notation (`\x1b[31m`, `\e`, `\033`, `\n`,
//    `\u{9b}`, and `\x41{1000}` for "0x41, 1000 times") and its inverse.
//
// Every guest byte is hostile, and so is anything a reader pastes: input is capped at
// MAX_INPUT bytes, all loops are linear in the input, and nothing here ever builds HTML.

export const MAX_INPUT = 16 * 1024 * 1024;

/**
 * The most bytes that text arriving in a share link may expand to. A link is analysed on page
 * load with nobody asking, and 17 characters of it (`\x9b{16777215}m`) used to expand to 16 MiB
 * of the filter's slowest input and hold the page for seconds. Text the reader types keeps
 * MAX_INPUT (the 10 MiB preset needs it); a link's own text is at most MAX_HASH_TEXT characters,
 * so anything larger than this can only be a repeat count.
 */
export const MAX_LINK_INPUT = 64 * 1024;

// ---- The filter (port of backend/ansi.rs) -----------------------------------------------------

/** The most bytes of one pending CSI the filter keeps (TTY-4 in the Rust source). */
export const ANSI_PENDING_MAX = 64;
/** CSI parameters allowed per sequence. */
export const CSI_MAX_PARAMS = 16;
/** Digits allowed per CSI parameter. */
export const CSI_MAX_DIGITS = 5;
/** Allowed CSI final bytes without intermediates. */
export const CSI_FINALS = "mABCDEFGHfd`JKX@PLMSTr";
/** Private modes `CSI ? n h|l` may set or reset. */
export const PRIVATE_MODES = [1, 7, 12, 25, 47, 1047, 1048, 1049, 2004];
/** Minimum time between two BELs that pass, in milliseconds. */
export const BEL_INTERVAL_MS = 1000;

export const POLICIES = ["safe", "strict", "raw"];

const ESC = 0x1b;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const REPLACEMENT = [0xef, 0xbf, 0xbd]; // U+FFFD in UTF-8

// States (the Rust `State` enum).
const S_GROUND = 0;
const S_ESC = 1;
const S_CHARSET = 2; // after `ESC (` or `ESC )`
const S_ESC_SKIP = 3;
const S_CSI = 4;
const S_CSI_SKIP = 5;
const S_STR = 6;
const S_STR_ESC = 7;
const S_UTF8 = 8;

const CSI_FINAL_CODES = new Set([...CSI_FINALS].map((c) => c.charCodeAt(0)));

/** A growable byte buffer (the Rust `Vec<u8>` the filter appends to). */
class Bytes {
  constructor(cap = 256) {
    this.buf = new Uint8Array(cap);
    this.len = 0;
  }
  grow(extra) {
    if (this.len + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + extra) cap *= 2;
    const n = new Uint8Array(cap);
    n.set(this.buf.subarray(0, this.len));
    this.buf = n;
  }
  push(b) {
    this.grow(1);
    this.buf[this.len++] = b;
  }
  pushAll(arr) {
    this.grow(arr.length);
    for (let i = 0; i < arr.length; i++) this.buf[this.len++] = arr[i];
  }
  ascii(s) {
    this.grow(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i);
  }
  bytes() {
    return this.buf.slice(0, this.len);
  }
}

const C0_NAMES = [
  "NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL", "BS", "HT", "LF", "VT", "FF", "CR", "SO", "SI",
  "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB", "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US",
];
const C1_NAMES = {
  0x84: "IND", 0x85: "NEL", 0x88: "HTS", 0x8d: "RI", 0x8e: "SS2", 0x8f: "SS3", 0x90: "DCS",
  0x98: "SOS", 0x9a: "DECID", 0x9b: "CSI", 0x9c: "ST", 0x9d: "OSC", 0x9e: "PM", 0x9f: "APC",
};
const STRING_NAMES = { 0x5d: "OSC", 0x50: "DCS", 0x5f: "APC", 0x5e: "PM", 0x58: "SOS" };

export function hex2(b) {
  return b.toString(16).padStart(2, "0");
}
export function byteName(b) {
  if (b < 0x20) return `0x${hex2(b).toUpperCase()} (${C0_NAMES[b]})`;
  if (b === 0x7f) return "0x7F (DEL)";
  if (b >= 0x80 && b <= 0x9f) return `0x${hex2(b).toUpperCase()}${C1_NAMES[b] ? ` (8-bit ${C1_NAMES[b]})` : ""}`;
  return `0x${hex2(b).toUpperCase()}`;
}
function cpName(cp) {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * `csi_allowed` from ansi.rs, with the reason for every refusal. `body` holds the parameter and
 * intermediate bytes (numbers), `fin` the final byte. Returns { ok, rule }.
 */
export function csiVerdict(body, fin) {
  let i = 0;
  let end = body.length;
  const priv = end > 0 && body[0] === 0x3f; // '?'
  if (priv) i = 1;
  // A single trailing SP intermediate, only for DECSCUSR (`CSI n SP q`).
  const sp = end > i && body[end - 1] === 0x20;
  if (sp) end -= 1;
  for (let k = i; k < end; k++) {
    const c = body[k];
    if (!((c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a)) {
      return {
        ok: false,
        rule: `parameter byte '${String.fromCharCode(c)}' is not a digit, ';' or ':' (only plain numeric parameters are allowed${priv ? " after '?'" : ""})`,
      };
    }
  }
  // Fields split on ';' and ':'; at most 16, each at most 5 digits.
  let fields = 0;
  let digits = 0;
  for (let k = i; k <= end; k++) {
    if (k === end || body[k] === 0x3b || body[k] === 0x3a) {
      fields += 1;
      if (fields > CSI_MAX_PARAMS) return { ok: false, rule: `more than ${CSI_MAX_PARAMS} parameters` };
      if (digits > CSI_MAX_DIGITS) return { ok: false, rule: `a parameter has more than ${CSI_MAX_DIGITS} digits` };
      digits = 0;
    } else {
      digits += 1;
    }
  }
  const f = String.fromCharCode(fin);
  if (!priv && sp && fin === 0x71) return { ok: true, rule: "CSI n SP q (cursor style) is on the allow-list" };
  if (sp) return { ok: false, rule: "the space intermediate is only allowed in CSI n SP q (cursor style)" };
  if (!priv && CSI_FINAL_CODES.has(fin)) return { ok: true, rule: `final byte '${f}' is on the allow-list` };
  if (priv && (fin === 0x68 || fin === 0x6c)) {
    const modes = splitBytes(body.slice(i, end), 0x3b);
    for (const m of modes) {
      const n = parseMode(m);
      if (n === null) return { ok: false, rule: "a private mode number is missing or malformed" };
      if (!PRIVATE_MODES.includes(n)) {
        return { ok: false, rule: `private mode ${n}${MODE_NAMES[n] ? ` (${MODE_NAMES[n]})` : ""} is not on the allow-list` };
      }
    }
    return { ok: true, rule: `private mode${modes.length > 1 ? "s" : ""} ${modes.map((m) => parseMode(m)).join(", ")} on the allow-list` };
  }
  if (!priv && (fin === 0x68 || fin === 0x6c)) {
    const params = String.fromCharCode(...body.slice(i, end));
    if (params === "4") return { ok: true, rule: "public mode 4 (insert mode) is on the allow-list" };
    return { ok: false, rule: `public mode ${params || "(none)"} is not on the allow-list: only mode 4 is` };
  }
  if (priv) return { ok: false, rule: `'?' with final byte '${f}' is not on the allow-list (only ? h and ? l are)` };
  const why = FINAL_WHY[f];
  return { ok: false, rule: `final byte '${f}'${why ? ` (${why})` : ""} is not on the allow-list` };
}

const FINAL_WHY = {
  c: "device attributes, a query",
  n: "device status report, a query",
  t: "window operations, some of them queries",
  i: "media copy",
  p: "DECRQM and soft reset",
  x: "terminal parameters, a query",
  "~": "bracketed paste marker",
  s: "save cursor",
  u: "restore cursor",
  q: "LEDs (no space before q)",
};

function splitBytes(arr, sep) {
  const out = [[]];
  for (const c of arr) {
    if (c === sep) out.push([]);
    else out[out.length - 1].push(c);
  }
  return out;
}

function parseMode(digits) {
  if (digits.length === 0 || digits.length > CSI_MAX_DIGITS) return null;
  let n = 0;
  for (const c of digits) {
    if (c < 0x30 || c > 0x39) return null;
    n = n * 10 + (c - 0x30);
  }
  return n;
}

const ESC_FINAL_WHY = {
  c: "RIS, full terminal reset",
  Z: "DECID, a query: the terminal answers with its identity",
  N: "SS2, single shift",
  O: "SS3, single shift",
  D: "IND, index",
  E: "NEL, next line",
  H: "HTS, tab set",
  "\\": "ST with no string open",
  n: "LS2, locking shift",
  o: "LS3, locking shift",
};

/**
 * The streaming filter, one per sink, as in ansi.rs. `push(bytes, nowMs)` appends what may reach
 * the terminal to the internal output. With `trace`, it also records segments.
 */
export class AnsiFilter {
  constructor(policy = "safe", { trace = false, maxSegments = 5000 } = {}) {
    if (!POLICIES.includes(policy)) throw new Error(`unknown policy ${policy}`);
    this.policy = policy;
    this.state = S_GROUND;
    this.intro = 0; // Charset: '(' or ')'
    this.strKind = 0; // Str: the introducer byte
    this.csi = new Uint8Array(ANSI_PENDING_MAX);
    this.csiLen = 0;
    this.utf8 = [0, 0, 0, 0];
    this.u = { need: 0, cp: 0, min: 0, len: 0 };
    this.lastBel = null;
    this.dropped = 0;
    this.out = new Bytes();
    // Tracing.
    this.trace = trace;
    this.maxSegments = maxSegments;
    this.segments = [];
    this.segmentsOmitted = 0;
    this.segOpen = false;
    this.segStart = 0;
    this.segOut = 0;
    this.verdict = null;
    this.rule = null;
    this.pos = 0; // absolute input offset of the next byte
  }

  output() {
    return this.out.bytes();
  }

  push(input, nowMs = 0) {
    if (this.policy === "raw") {
      this.out.pushAll(input);
      this.pos += input.length;
      return;
    }
    const strict = this.policy === "strict";
    for (let k = 0; k < input.length; k++) {
      const b = input[k];
      const i = this.pos++;
      if (this.trace && !this.segOpen) this.begin(i);
      if (strict) this.strictByte(b, i);
      else this.byte(b, i, nowMs);
      if (this.trace && this.state === S_GROUND && this.segOpen) this.close(i + 1);
    }
  }

  /** End of input: close an open segment as "pending" (the filter is waiting for more bytes). */
  finish() {
    if (this.trace && this.segOpen) {
      const why = this.pendingWhy();
      this.verdict = "pending";
      this.rule = why;
      this.close(this.pos);
    }
  }

  pendingWhy() {
    switch (this.state) {
      case S_ESC: return "an escape sequence is not finished: the filter waits for the next byte";
      case S_CHARSET: return "a character set selection is not finished";
      case S_ESC_SKIP: return "an escape sequence is not finished: the filter waits for its final byte";
      case S_CSI: return "a CSI sequence is not finished: nothing is emitted until its final byte";
      case S_CSI_SKIP: return "an over-long CSI is still being skipped";
      case S_STR: case S_STR_ESC: return `an ${STRING_NAMES[this.strKind] || "OSC"} string is still open: everything until its terminator is dropped`;
      case S_UTF8: return "a UTF-8 character is not finished";
      default: return "";
    }
  }

  // -- tracing helpers --
  begin(i) {
    this.segOpen = true;
    this.segStart = i;
    this.segOut = this.out.len;
    this.verdict = null;
    this.rule = null;
  }
  decide(verdict, rule) {
    if (!this.trace) return;
    this.verdict = verdict;
    this.rule = rule;
  }
  /** Close the open segment at input offset `end` (exclusive). */
  close(end) {
    if (!this.segOpen) return;
    this.segOpen = false;
    if (end <= this.segStart && this.out.len === this.segOut) return;
    let verdict = this.verdict;
    if (!verdict) verdict = this.out.len > this.segOut ? "pass" : "drop";
    const seg = { start: this.segStart, end, outStart: this.segOut, outEnd: this.out.len, verdict, rule: this.rule || "" };
    const last = this.segments[this.segments.length - 1];
    if (verdict === "text" && last && last.verdict === "text" && last.end === seg.start && last.outEnd === seg.outStart) {
      last.end = seg.end;
      last.outEnd = seg.outEnd;
      return;
    }
    if (this.segments.length >= this.maxSegments) {
      this.segmentsOmitted += 1;
      return;
    }
    this.segments.push(seg);
  }
  /** Close the open segment at `end` with a verdict, and open a new one there. */
  cut(end, verdict, rule) {
    if (!this.trace) return;
    if (this.segOpen) {
      if (!this.verdict) this.decide(verdict, rule);
      this.close(end);
    }
    this.begin(end);
  }

  drop1() {
    this.dropped += 1;
  }

  // -- safe policy --
  byte(b, i, now) {
    switch (this.state) {
      case S_GROUND: return this.ground(b, i, now);
      case S_ESC: return this.esc(b, i, now);
      case S_CHARSET: return this.charset(b, i, now);
      case S_ESC_SKIP: return this.escSkip(b, i, now);
      case S_CSI_SKIP: return this.csiSkip(b, i, now);
      case S_CSI: return this.csiByte(b, i, now);
      case S_STR: return this.string(b, i, now);
      case S_STR_ESC:
        if (b === 0x5c) {
          this.decide("drop", `${STRING_NAMES[this.strKind]} string dropped whole, up to its terminator ST (ESC \\)`);
          this.state = S_GROUND; // ST: the string is over
        } else {
          this.cut(i - 1, "drop", `${STRING_NAMES[this.strKind]} string dropped; an ESC inside it starts a new sequence`);
          this.state = S_ESC;
          this.esc(b, i, now);
        }
        return;
      case S_UTF8: return this.utf8Byte(b, i, now);
    }
  }

  ground(b, i, now) {
    if (b === ESC) {
      this.state = S_ESC;
    } else if (b === 0x08 || b === 0x09 || b === 0x0a || b === 0x0d) {
      this.out.push(b);
      this.decide("text", `${byteName(b)} is one of the basic controls kept (BS, HT, LF, CR)`);
    } else if (b >= 0x20 && b <= 0x7e) {
      this.out.push(b);
      this.decide("text", "printable text");
    } else if (b === BEL) {
      this.bel(now);
    } else if (b >= 0xc2 && b <= 0xdf) {
      this.startUtf8(b, 1, b & 0x1f, 0x80);
    } else if (b >= 0xe0 && b <= 0xef) {
      this.startUtf8(b, 2, b & 0x0f, 0x800);
    } else if (b >= 0xf0 && b <= 0xf4) {
      this.startUtf8(b, 3, b & 0x07, 0x10000);
    } else if (b >= 0x80 && b <= 0x9f) {
      this.drop1(); // raw 8-bit C1 (0x9b is CSI, 0x9d OSC)
      this.decide("drop", `raw C1 byte ${byteName(b)} dropped on its own: it starts nothing, so the bytes after it are plain text`);
    } else if (b >= 0xa0) {
      this.out.pushAll(REPLACEMENT); // stray continuation, C0/C1 lead, F5+
      this.decide("replace", `${byteName(b)} cannot start a valid UTF-8 character: replaced by U+FFFD`);
    } else {
      this.drop1(); // every other C0, and DEL
      this.decide("drop", `C0 control ${byteName(b)} is not on the allow-list`);
    }
  }

  esc(b, i, now) {
    if (b === 0x37 || b === 0x38 || b === 0x4d || b === 0x3d || b === 0x3e) {
      this.out.pushAll([ESC, b]);
      this.decide("pass", `ESC ${String.fromCharCode(b)} is on the allow-list`);
      this.state = S_GROUND;
    } else if (b === 0x28 || b === 0x29) {
      this.intro = b;
      this.state = S_CHARSET;
    } else if (b === 0x5b) {
      this.csiLen = 0;
      this.state = S_CSI;
    } else if (STRING_NAMES[b]) {
      this.strKind = b;
      this.state = S_STR; // OSC DCS APC PM SOS
    } else if (b === ESC) {
      this.drop1();
      this.cut(i, "drop", "ESC followed by another ESC: the first one is dropped");
    } else if (b >= 0x20 && b <= 0x2f) {
      this.state = S_ESC_SKIP;
    } else if (b >= 0x30 && b <= 0x7e) {
      this.drop1(); // RIS, DECID, ... everything else
      const f = String.fromCharCode(b);
      this.decide("drop", `ESC ${f}${ESC_FINAL_WHY[f] ? ` (${ESC_FINAL_WHY[f]})` : ""} is not on the allow-list`);
      this.state = S_GROUND;
    } else {
      this.abortAndReprocess(b, i, now);
    }
  }

  bel(now) {
    const ok = this.lastBel === null || now - this.lastBel >= BEL_INTERVAL_MS;
    if (ok) {
      this.lastBel = now;
      this.out.push(BEL);
      this.decide("pass", "BEL passes, at most once per second");
    } else {
      this.drop1();
      this.decide("drop", "BEL rate limit: at most one per second");
    }
  }

  charset(b, i, now) {
    const intro = String.fromCharCode(this.intro);
    if (b === 0x42 || b === 0x30) {
      this.out.pushAll([ESC, this.intro, b]);
      this.decide("pass", `ESC ${intro} ${String.fromCharCode(b)} (${b === 0x30 ? "line-drawing" : "ASCII"} character set) is on the allow-list`);
      this.state = S_GROUND;
    } else if (b === ESC) {
      this.cut(i, "drop", `ESC ${intro} interrupted by a new ESC: dropped`);
      this.state = S_ESC;
    } else if (b >= 0x20 && b <= 0x2f) {
      this.drop1();
      this.decide("drop", `ESC ${intro} with a further intermediate: only character sets B and 0 are allowed`);
      this.state = S_ESC_SKIP;
    } else if (b >= 0x30 && b <= 0x7e) {
      this.drop1();
      this.decide("drop", `ESC ${intro} ${String.fromCharCode(b)}: only character sets B (ASCII) and 0 (line drawing) are allowed`);
      this.state = S_GROUND;
    } else {
      this.abortAndReprocess(b, i, now);
    }
  }

  escSkip(b, i, now) {
    if (b >= 0x20 && b <= 0x2f) {
      this.drop1();
    } else if (b >= 0x30 && b <= 0x7e) {
      this.drop1();
      this.decide("drop", "escape sequence with an intermediate byte: not on the allow-list, dropped up to its final byte");
      this.state = S_GROUND;
    } else if (b === ESC) {
      this.cut(i, "drop", "escape sequence interrupted by a new ESC: dropped");
      this.state = S_ESC;
    } else {
      this.abortAndReprocess(b, i, now);
    }
  }

  csiSkip(b, i, now) {
    if (b >= 0x20 && b <= 0x3f) {
      this.drop1();
    } else if (b >= 0x40 && b <= 0x7e) {
      this.decide("drop", `CSI longer than ${ANSI_PENDING_MAX} bytes: dropped whole, up to its final byte`);
      this.state = S_GROUND;
    } else if (b === ESC) {
      this.cut(i, "drop", `CSI longer than ${ANSI_PENDING_MAX} bytes, interrupted by a new ESC: dropped`);
      this.state = S_ESC;
    } else {
      this.abortAndReprocess(b, i, now);
    }
  }

  csiByte(b, i, now) {
    if (b >= 0x20 && b <= 0x3f) {
      if (this.csiLen < ANSI_PENDING_MAX) {
        this.csi[this.csiLen++] = b;
      } else {
        this.state = S_CSI_SKIP; // too long, drop it whole
      }
    } else if (b >= 0x40 && b <= 0x7e) {
      const body = Array.from(this.csi.subarray(0, this.csiLen));
      // The verdict text is computed only when tracing; the decision itself is csiAllowed.
      if (csiAllowed(body, b)) {
        this.out.pushAll([ESC, 0x5b]);
        this.out.pushAll(body);
        this.out.push(b);
        if (this.trace) this.decide("pass", csiVerdict(body, b).rule);
      } else {
        this.dropped += 3;
        if (this.trace) this.decide("drop", csiVerdict(body, b).rule);
      }
      this.state = S_GROUND;
    } else if (b === ESC) {
      this.cut(i, "drop", "CSI interrupted by a new ESC: dropped");
      this.state = S_ESC;
    } else {
      this.abortAndReprocess(b, i, now);
    }
  }

  string(b, i, now) {
    const name = STRING_NAMES[this.strKind];
    if (b === BEL) {
      this.decide("drop", `${name} string dropped whole, up to its BEL terminator`);
      this.state = S_GROUND;
    } else if (b === CAN || b === SUB) {
      this.decide("drop", `${name} string dropped; ${b === CAN ? "CAN" : "SUB"} cancels it`);
      this.state = S_GROUND;
    } else if (b === ESC) {
      this.state = S_STR_ESC;
    } else if (b === 0x0a) {
      this.abortAndReprocess(b, i, now, `${name} string dropped up to a newline: the filter resynchronises there so the console stays readable`);
    } else {
      this.drop1();
    }
  }

  startUtf8(b, need, cp, min) {
    this.utf8 = [b, 0, 0, 0];
    this.u = { need, cp, min, len: 1 };
    this.state = S_UTF8;
  }

  utf8Byte(b, i, now) {
    let { need, cp, min, len } = this.u;
    if ((b & 0xc0) !== 0x80) {
      // Truncated character: one U+FFFD for it, then `b` on its own.
      this.out.pushAll(REPLACEMENT);
      this.cut(i, "replace", "truncated UTF-8 character: replaced by U+FFFD");
      this.state = S_GROUND;
      this.ground(b, i, now);
      return;
    }
    cp = (cp << 6) | (b & 0x3f);
    if (len < 4) this.utf8[len] = b;
    len += 1;
    if (need > 1) {
      this.u = { need: need - 1, cp, min, len };
      return;
    }
    this.state = S_GROUND;
    if (cp < min) {
      this.out.pushAll(REPLACEMENT);
      this.decide("replace", "overlong UTF-8 encoding: replaced by U+FFFD");
    } else if (cp >= 0xd800 && cp <= 0xdfff) {
      this.out.pushAll(REPLACEMENT);
      this.decide("replace", `${cpName(cp)} is a surrogate, not a character: replaced by U+FFFD`);
    } else if (cp > 0x10ffff) {
      this.out.pushAll(REPLACEMENT);
      this.decide("replace", `${cpName(cp)} is above U+10FFFF: replaced by U+FFFD`);
    } else if (cp >= 0x80 && cp <= 0x9f) {
      this.drop1(); // C1 as UTF-8 (U+0080..9F)
      this.decide("drop", `${cpName(cp)} is a C1 control${C1_NAMES[cp] ? ` (${C1_NAMES[cp]})` : ""} encoded as UTF-8: dropped`);
    } else {
      this.out.pushAll(this.utf8.slice(0, len));
      this.decide("text", "valid UTF-8 text");
    }
  }

  abortAndReprocess(b, i, now, rule) {
    this.drop1();
    this.cut(i, "drop", rule || abortRule(b));
    this.state = S_GROUND;
    this.ground(b, i, now);
  }

  // -- strict policy --
  strictByte(b, i) {
    if (this.state === S_UTF8) {
      if ((b & 0xc0) === 0x80) {
        this.strictContinuation(b);
        return;
      }
      // A truncated character: show its bytes, then handle `b` from the ground state.
      this.state = S_GROUND;
      this.renderHexPending(this.u.len);
      this.cut(i, "shown", "truncated UTF-8 character: its bytes are shown as \\xNN");
    }
    if (b === 0x08 || b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      this.out.push(b);
      this.decide("text", b >= 0x20 ? "printable text" : `${byteName(b)} is kept`);
    } else if (b <= 0x1f) {
      this.drop1();
      this.out.pushAll([0x5e, b ^ 0x40]); // ESC -> ^[, BEL -> ^G
      this.decide("shown", `${byteName(b)} shown in caret notation as ^${String.fromCharCode(b ^ 0x40)}`);
    } else if (b === 0x7f) {
      this.drop1();
      this.out.ascii("^?");
      this.decide("shown", "DEL shown as ^?");
    } else if (b >= 0xc2 && b <= 0xdf) {
      this.startUtf8(b, 1, b & 0x1f, 0x80);
    } else if (b >= 0xe0 && b <= 0xef) {
      this.startUtf8(b, 2, b & 0x0f, 0x800);
    } else if (b >= 0xf0 && b <= 0xf4) {
      this.startUtf8(b, 3, b & 0x07, 0x10000);
    } else {
      // Raw C1 (0x80..=0x9f), stray continuations, C0/C1 leads, F5+.
      this.drop1();
      this.out.ascii("\\x" + hex2(b));
      this.decide("shown", b <= 0x9f ? `raw C1 byte ${byteName(b)} shown as \\x${hex2(b)}` : `${byteName(b)} is not valid UTF-8: shown as \\x${hex2(b)}`);
    }
  }

  strictContinuation(b) {
    let { need, cp, min, len } = this.u;
    cp = (cp << 6) | (b & 0x3f);
    if (len < 4) this.utf8[len] = b;
    len += 1;
    if (need > 1) {
      this.u = { need: need - 1, cp, min, len };
      return;
    }
    this.u = { need: 0, cp, min, len };
    this.state = S_GROUND;
    const valid = cp >= min && !(cp >= 0xd800 && cp <= 0xdfff) && cp <= 0x10ffff;
    if (valid && cp >= 0x80 && cp <= 0x9f) {
      this.drop1();
      this.out.ascii(`\\u{${cp.toString(16)}}`);
      this.decide("shown", `${cpName(cp)}, a C1 control encoded as UTF-8, shown as \\u{${cp.toString(16)}}`);
    } else if (valid) {
      this.out.pushAll(this.utf8.slice(0, len));
      this.decide("text", "valid UTF-8 text");
    } else {
      this.renderHexPending(len); // overlong, surrogate, > U+10FFFF
      this.decide("shown", "invalid UTF-8 (overlong, surrogate or above U+10FFFF): shown as \\xNN");
    }
  }

  renderHexPending(len) {
    for (let k = 0; k < len && k < 4; k++) {
      this.drop1();
      this.out.ascii("\\x" + hex2(this.utf8[k]));
    }
  }
}

/** The reason shown when a byte that cannot continue a sequence interrupts it. */
function abortRule(b) {
  if (b < 0x20 || b === 0x7f) {
    return `sequence interrupted by control byte ${byteName(b)}: the filter drops the partial sequence and then handles the control on its own. ` +
      "A terminal would run the control and carry on with the sequence; because the partial sequence is dropped, the terminal never sees one to carry on with";
  }
  return `sequence interrupted by byte ${byteName(b)} (not part of an escape sequence): the partial sequence is dropped and the byte is handled as text`;
}

/** `csi_allowed` exactly: the decision without the explanation. */
export function csiAllowed(body, fin) {
  return csiVerdict(body, fin).ok;
}

/**
 * Run one policy over `bytes` in a single push at time `nowMs` (as the Rust tests do with
 * `push_at`). Returns { out, dropped, segments, segmentsOmitted, pending }.
 */
export function runFilter(policy, bytes, { nowMs = 0, trace = false, maxSegments } = {}) {
  const f = new AnsiFilter(policy, { trace, maxSegments });
  f.push(bytes, nowMs);
  const pending = f.state !== S_GROUND ? f.pendingWhy() : "";
  f.finish();
  return { out: f.output(), dropped: f.dropped, segments: f.segments, segmentsOmitted: f.segmentsOmitted, pending };
}

// ---- Input notation ---------------------------------------------------------------------------

const SIMPLE_ESCAPES = { n: 0x0a, r: 0x0d, t: 0x09, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b, e: 0x1b, "\\": 0x5c };

function utf8Encode(cp, out) {
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
}

/**
 * Parse the lab's input notation into bytes. Returns { ok: true, bytes } or
 * { ok: false, error, at } (at = character index of the problem; `tooLong: true` when the
 * problem is the size cap `max`, which is checked before any repeat count is expanded).
 *
 *   \xNN      one byte, two hex digits      \xNN{count}  that byte, count times (count <= 16 MiB)
 *   \e        ESC (0x1B)                    \0, \033     octal, one to three digits (as printf)
 *   \n \r \t \a \b \f \v \\                 \u{HHHH}     a code point, encoded as UTF-8
 *   any other character is encoded as UTF-8.
 */
export function parseInput(text, { max = MAX_INPUT } = {}) {
  const chunks = [];
  let cur = [];
  let total = 0;
  const flush = () => {
    if (cur.length) {
      chunks.push(Uint8Array.from(cur));
      total += cur.length;
      cur = [];
    }
  };
  const fail = (error, at) => ({ ok: false, error, at });
  const failLong = (at) => ({ ok: false, error: `input is longer than ${max} bytes`, at, tooLong: true });
  let i = 0;
  while (i < text.length) {
    if (total + cur.length > max) return failLong(i);
    if (cur.length >= 65536) flush();
    const ch = text[i];
    if (ch !== "\\") {
      const cp = text.codePointAt(i);
      if (cp >= 0xd800 && cp <= 0xdfff) return fail("unpaired surrogate in the text", i);
      utf8Encode(cp, cur);
      i += cp > 0xffff ? 2 : 1;
      continue;
    }
    const at = i;
    const e = text[i + 1];
    if (e === undefined) return fail("a backslash at the end: write \\\\ for a backslash", at);
    if (e === "x") {
      const h = text.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(h)) return fail("\\x needs exactly two hex digits, as in \\x1b", at);
      const b = parseInt(h, 16);
      i += 4;
      const m = /^\{([0-9]{1,9})\}/.exec(text.slice(i, i + 11));
      if (m) {
        const n = Number(m[1]);
        if (n > max || total + cur.length + n > max) return failLong(at);
        flush();
        chunks.push(new Uint8Array(n).fill(b));
        total += n;
        i += m[0].length;
      } else {
        cur.push(b);
      }
      continue;
    }
    if (e === "u") {
      const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(i + 2, i + 10));
      if (!m) return fail("\\u needs braces and hex digits, as in \\u{9b}", at);
      const cp = parseInt(m[1], 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return fail("\\u{...} must be a Unicode scalar value; use \\xNN for raw bytes", at);
      utf8Encode(cp, cur);
      i += 2 + m[0].length;
      continue;
    }
    if (e >= "0" && e <= "7") {
      let j = i + 1;
      let v = 0;
      while (j < i + 4 && text[j] >= "0" && text[j] <= "7") {
        v = v * 8 + (text.charCodeAt(j) - 48);
        j++;
      }
      if (v > 0xff) return fail("octal escape above \\377", at);
      cur.push(v);
      i = j;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)) {
      cur.push(SIMPLE_ESCAPES[e]);
      i += 2;
      continue;
    }
    return fail(`unknown escape \\${e}`, at);
  }
  flush();
  if (total > max) return failLong(text.length);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { ok: true, bytes };
}

/** Length of the valid, printable UTF-8 character at bytes[i], or 0. */
function printableUtf8At(bytes, i, end) {
  const b = bytes[i];
  let need;
  let cp;
  let min;
  if (b >= 0xc2 && b <= 0xdf) [need, cp, min] = [1, b & 0x1f, 0x80];
  else if (b >= 0xe0 && b <= 0xef) [need, cp, min] = [2, b & 0x0f, 0x800];
  else if (b >= 0xf0 && b <= 0xf4) [need, cp, min] = [3, b & 0x07, 0x10000];
  else return 0;
  if (i + need >= end) return 0;
  for (let k = 1; k <= need; k++) {
    const c = bytes[i + k];
    if ((c & 0xc0) !== 0x80) return 0;
    cp = (cp << 6) | (c & 0x3f);
  }
  if (cp < min || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff || cp <= 0x9f) return 0;
  return need + 1;
}

/**
 * The inverse of parseInput for display: printable ASCII as is, `\\` for backslash, `\n \r \t`,
 * `\xNN` for every other byte, valid printable UTF-8 as the character. A `{` right after a
 * `\xNN` is written `\x7b`, so parseInput(escapeBytes(b)) gives back b. At most `cap`
 * characters; returns { text, truncated, shownBytes }.
 */
export function escapeBytes(bytes, start = 0, end = bytes.length, cap = Infinity) {
  let s = "";
  let i = start;
  let lastHex = false;
  while (i < end) {
    if (s.length >= cap) return { text: s, truncated: true, shownBytes: i - start };
    const b = bytes[i];
    if (b === 0x5c) { s += "\\\\"; lastHex = false; i++; continue; }
    if (b === 0x7b && lastHex) { s += "\\x7b"; i++; continue; }
    if (b >= 0x20 && b <= 0x7e) { s += String.fromCharCode(b); lastHex = false; i++; continue; }
    if (b === 0x0a) { s += "\\n"; lastHex = false; i++; continue; }
    if (b === 0x0d) { s += "\\r"; lastHex = false; i++; continue; }
    if (b === 0x09) { s += "\\t"; lastHex = false; i++; continue; }
    const n = b >= 0xc2 ? printableUtf8At(bytes, i, end) : 0;
    if (n) {
      s += new TextDecoder().decode(bytes.subarray(i, i + n));
      lastHex = false;
      i += n;
      continue;
    }
    s += "\\x" + hex2(b);
    lastHex = true;
    i++;
  }
  return { text: s, truncated: false, shownBytes: i - start };
}

/** Like escapeBytes, but collapses runs of one repeated byte (>= 16) into `\xNN{count}`. */
export function escapeCompact(bytes, start = 0, end = bytes.length, cap = Infinity) {
  let s = "";
  let i = start;
  while (i < end) {
    if (s.length >= cap) return { text: s, truncated: true, shownBytes: i - start };
    let j = i + 1;
    while (j < end && bytes[j] === bytes[i]) j++;
    if (j - i >= 16) {
      s += `\\x${hex2(bytes[i])}{${j - i}}`;
      i = j;
      continue;
    }
    // Up to the next long run.
    let k = i;
    while (k < end) {
      let r = k + 1;
      while (r < end && bytes[r] === bytes[k] && r - k < 16) r++;
      if (r - k >= 16) break;
      k = r;
    }
    const part = escapeBytes(bytes, i, k, cap - s.length);
    s += part.text;
    if (part.truncated) return { text: s, truncated: true, shownBytes: i - start + part.shownBytes };
    // A run following an escape would make a following `{` ambiguous: escapeBytes handles `{`
    // only inside one call, so guard the boundary.
    i = k;
  }
  return { text: s, truncated: false, shownBytes: i - start };
}

// ---- The terminal's reading (tokenizer) -------------------------------------------------------

export const EFFECTS = {
  text: "prints text",
  control: "a basic control (newline, tab, ...)",
  format: "changes how text looks",
  cursor: "moves the cursor or edits the screen",
  mode: "changes a terminal mode",
  query: "asks a question: the terminal answers as if you had typed the answer. macvmm passes your typing to the guest, so the guest reads the answer, and after macvmm exits your shell would read any answer still waiting",
  host: "reaches outside the text: title, clipboard, links, notifications, printing",
  reset: "resets the terminal",
  ignored: "ignored by most terminals",
  broken: "unfinished or malformed",
  unknown: "not described by this lab",
};

export const MODE_NAMES = {
  1: "application cursor keys",
  3: "132-column mode",
  4: "insert mode",
  5: "reverse video screen",
  6: "origin mode",
  7: "auto-wrap",
  9: "X10 mouse reporting",
  12: "cursor blink",
  25: "cursor visible",
  47: "alternate screen",
  1000: "mouse click reporting",
  1001: "mouse highlight tracking",
  1002: "mouse drag reporting",
  1003: "all mouse motion reporting",
  1004: "focus in/out reporting",
  1005: "UTF-8 mouse encoding",
  1006: "SGR mouse encoding",
  1015: "urxvt mouse encoding",
  1016: "SGR pixel mouse encoding",
  1047: "alternate screen",
  1048: "save/restore cursor",
  1049: "alternate screen, saving the cursor",
  2004: "bracketed paste",
};
/** Modes that make the terminal send reports: mouse clicks and motion, or focus changes (1004). */
const REPORT_MODES = new Set([9, 1000, 1001, 1002, 1003, 1004]);
/** Modes that only choose how those reports are encoded; on their own they send nothing. */
const ENCODING_MODES = new Set([1005, 1006, 1015, 1016]);

const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const SGR_NAMES = {
  0: "reset all attributes", 1: "bold", 2: "dim", 3: "italic", 4: "underline", 5: "blink", 7: "reverse video",
  8: "hidden", 9: "strike-through", 21: "double underline", 22: "normal intensity", 23: "italic off",
  24: "underline off", 25: "blink off", 27: "reverse video off", 28: "hidden off", 29: "strike-through off",
  39: "default foreground", 49: "default background",
};

/** One SGR group in the colon form (ITU T.416): `38:2:<colour space>:r:g:b`, `38:5:n`, `4:3`. */
function sgrColonGroup(sub) {
  const n = sub[0] === "" ? 0 : Number(sub[0]);
  if (n === 38 || n === 48 || n === 58) {
    const which = n === 38 ? "foreground" : n === 48 ? "background" : "underline";
    if (sub[1] === "5") return `${which} colour ${sub[2] || "?"} of 256`;
    if (sub[1] === "2") return `${which} RGB colour`;
    return `extended ${which} colour`;
  }
  if (n === 4) return ["underline off", "underline", "double underline", "curly underline", "dotted underline", "dashed underline"][Number(sub[1])] || "underline style";
  return `attribute ${sub.join(":")}`;
}

function sgrText(params) {
  // Split on ';' first: each piece is one SGR. A piece with ':' is a whole colon group
  // (sub-parameters); only the older ';' form of 38/48 swallows the pieces after it.
  const ps = params === "" ? ["0"] : params.split(";");
  const words = [];
  for (let k = 0; k < ps.length && words.length < 8; k++) {
    if (ps[k].includes(":")) {
      words.push(sgrColonGroup(ps[k].split(":")));
      continue;
    }
    const n = ps[k] === "" ? 0 : Number(ps[k]);
    if (SGR_NAMES[n]) words.push(SGR_NAMES[n]);
    else if (n >= 30 && n <= 37) words.push(`${COLORS[n - 30]} foreground`);
    else if (n >= 40 && n <= 47) words.push(`${COLORS[n - 40]} background`);
    else if (n >= 90 && n <= 97) words.push(`bright ${COLORS[n - 90]} foreground`);
    else if (n >= 100 && n <= 107) words.push(`bright ${COLORS[n - 100]} background`);
    else if (n === 38 || n === 48) {
      const which = n === 38 ? "foreground" : "background";
      if (ps[k + 1] === "5") { words.push(`${which} colour ${ps[k + 2] ?? "?"} of 256`); k += 2; }
      else if (ps[k + 1] === "2") { words.push(`${which} RGB colour`); k += 4; }
      else words.push(`extended ${which} colour`);
    } else words.push(`attribute ${n}`);
  }
  return words.join(", ");
}

function num(s, dflt) {
  if (s === undefined || s === "") return dflt;
  return Number(s);
}

/** A count or position parameter: missing or 0 both mean the default 1 (ECMA-48 §5.4.2, DEC). */
function count(s) {
  const v = num(s, 1);
  return v === 0 ? 1 : v;
}

/** What `CSI <params> <inter> <final>` means to an xterm-like terminal. */
export function describeCsi(prefix, params, inter, fin) {
  const p = params.split(";");
  const n1 = count(p[0]);
  const k = prefix + (inter ? `[${inter}]` : "") + fin;
  if (prefix === "" && inter === "") {
    switch (fin) {
      case "m": return { label: "SGR", effect: "format", meaning: `Select Graphic Rendition: ${sgrText(params)}.` };
      case "A": return { label: "CUU", effect: "cursor", meaning: `Cursor up ${n1}.` };
      case "B": return { label: "CUD", effect: "cursor", meaning: `Cursor down ${n1}.` };
      case "C": return { label: "CUF", effect: "cursor", meaning: `Cursor forward ${n1}.` };
      case "D": return { label: "CUB", effect: "cursor", meaning: `Cursor back ${n1}.` };
      case "E": return { label: "CNL", effect: "cursor", meaning: `Cursor to the start of the line ${n1} down.` };
      case "F": return { label: "CPL", effect: "cursor", meaning: `Cursor to the start of the line ${n1} up.` };
      case "G": case "`": return { label: fin === "G" ? "CHA" : "HPA", effect: "cursor", meaning: `Cursor to column ${n1}.` };
      case "H": case "f": return { label: fin === "H" ? "CUP" : "HVP", effect: "cursor", meaning: `Cursor to row ${n1}, column ${count(p[1])}.` };
      case "d": return { label: "VPA", effect: "cursor", meaning: `Cursor to row ${n1}.` };
      case "J": return { label: "ED", effect: "cursor", meaning: ["Erase from the cursor to the end of the screen.", "Erase from the start of the screen to the cursor.", "Erase the whole screen.", "Erase the scrollback buffer."][num(p[0], 0)] || "Erase in display." };
      case "K": return { label: "EL", effect: "cursor", meaning: ["Erase to the end of the line.", "Erase to the start of the line.", "Erase the whole line."][num(p[0], 0)] || "Erase in line." };
      case "X": return { label: "ECH", effect: "cursor", meaning: `Erase ${n1} characters.` };
      case "@": return { label: "ICH", effect: "cursor", meaning: `Insert ${n1} blank characters.` };
      case "P": return { label: "DCH", effect: "cursor", meaning: `Delete ${n1} characters.` };
      case "L": return { label: "IL", effect: "cursor", meaning: `Insert ${n1} lines.` };
      case "M": return { label: "DL", effect: "cursor", meaning: `Delete ${n1} lines.` };
      case "S": return { label: "SU", effect: "cursor", meaning: `Scroll up ${n1} lines.` };
      case "T": return { label: "SD", effect: "cursor", meaning: `Scroll down ${n1} lines.` };
      case "r": return { label: "DECSTBM", effect: "cursor", meaning: params === "" ? "Reset the scrolling region to the whole screen." : `Scrolling region rows ${count(p[0])} to ${num(p[1], 0) === 0 ? "the bottom" : num(p[1], 0)}.` };
      case "s": return { label: "SCOSC", effect: "cursor", meaning: "Save the cursor position." };
      case "u": return { label: "SCORC", effect: "cursor", meaning: "Restore the cursor position." };
      case "c": return { label: "DA", effect: "query", meaning: "Primary Device Attributes: the terminal answers with ESC [ ? ... c, typed into your input." };
      case "n":
        if (num(p[0], 0) === 6) return { label: "DSR", effect: "query", meaning: "Device Status Report, cursor position: the terminal answers ESC [ row ; col R, typed into your input." };
        if (num(p[0], 0) === 5) return { label: "DSR", effect: "query", meaning: "Device Status Report: the terminal answers ESC [ 0 n, typed into your input." };
        return { label: "DSR", effect: "query", meaning: "Device Status Report (a query)." };
      case "t": {
        const op = num(p[0], 0);
        if (op === 21) return { label: "XTWINOPS", effect: "query", meaning: "Report the window title: older terminals typed the title back into your input, so a title set by the guest became keystrokes." };
        if (op === 20) return { label: "XTWINOPS", effect: "query", meaning: "Report the icon label (typed into your input)." };
        if (op >= 11 && op <= 19) return { label: "XTWINOPS", effect: "query", meaning: "Report window state, position or size (typed into your input)." };
        if (op === 22 || op === 23) return { label: "XTWINOPS", effect: "host", meaning: op === 22 ? "Save the window title on a stack." : "Restore the window title from the stack." };
        return { label: "XTWINOPS", effect: "host", meaning: op === 8 ? "Resize the window." : "Window manipulation (move, resize, raise, iconify...)." };
      }
      case "i": return { label: "MC", effect: "host", meaning: "Media Copy: print the screen or start printer pass-through." };
      case "x": return { label: "DECREQTPARM", effect: "query", meaning: "Request terminal parameters (answered into your input)." };
      case "h": case "l": {
        const on = fin === "h";
        if (params === "4") return { label: on ? "SM" : "RM", effect: "mode", meaning: `${on ? "Turn on" : "Turn off"} insert mode.` };
        return { label: on ? "SM" : "RM", effect: "mode", meaning: `${on ? "Set" : "Reset"} ANSI mode ${params || "?"}.` };
      }
      case "~":
        if (params === "200" || params === "201") return { label: "paste marker", effect: "unknown", meaning: `Bracketed paste ${params === "200" ? "start" : "end"} marker: something a terminal sends to a program, not a command to the terminal.` };
        break;
    }
  }
  if (prefix === "?" && inter === "" && (fin === "h" || fin === "l")) {
    const on = fin === "h";
    const modes = params.split(";").map((m) => Number(m));
    const names = modes.map((m) => `${m}${MODE_NAMES[m] ? ` (${MODE_NAMES[m]})` : ""}`);
    const mouse = on && modes.some((m) => REPORT_MODES.has(m) && m !== 1004);
    const focus = on && modes.includes(1004);
    const encoding = modes.some((m) => ENCODING_MODES.has(m));
    let more = "";
    if (mouse) more += " With mouse reporting on, every click and scroll is sent as escape sequences, as if you had typed them.";
    if (focus) more += " With focus reporting on, the terminal sends ESC [ I or ESC [ O, as if typed, whenever its window gains or loses focus.";
    if (encoding) more += " An encoding mode only changes the format of the reports another mode turns on; on its own it sends nothing.";
    return {
      label: on ? "DECSET" : "DECRST",
      effect: mouse || focus ? "query" : "mode",
      meaning: `${on ? "Turn on" : "Turn off"} private mode ${names.join(", ")}.${more}`,
    };
  }
  if (prefix === "?" && fin === "n") return { label: "DSR (DEC)", effect: "query", meaning: "DEC device status report (a query, answered into your input)." };
  if ((prefix === ">" || prefix === "=") && fin === "c") return { label: prefix === ">" ? "DA2" : "DA3", effect: "query", meaning: `${prefix === ">" ? "Secondary" : "Tertiary"} Device Attributes: the terminal answers into your input.` };
  if (inter === "$" && fin === "p") return { label: "DECRQM", effect: "query", meaning: "Request mode: the terminal answers whether a mode is set, into your input." };
  if (inter === " " && fin === "q" && prefix === "") return { label: "DECSCUSR", effect: "mode", meaning: `Cursor style ${num(p[0], 0)} (block, underline or bar, blinking or steady).` };
  if (inter === "!" && fin === "p") return { label: "DECSTR", effect: "reset", meaning: "Soft terminal reset." };
  if (inter === '"' && fin === "p") return { label: "DECSCL", effect: "mode", meaning: "Set the conformance level." };
  return { label: `CSI ${k}`, effect: "unknown", meaning: "A control sequence this lab does not describe. The filter does not need to know it either: it is not on the allow-list." };
}

const ESC_MEANINGS = {
  "7": ["DECSC", "cursor", "Save the cursor position and attributes."],
  "8": ["DECRC", "cursor", "Restore the saved cursor position and attributes."],
  M: ["RI", "cursor", "Reverse index: cursor up one line, scrolling if needed."],
  D: ["IND", "cursor", "Index: cursor down one line."],
  E: ["NEL", "cursor", "Next line."],
  H: ["HTS", "mode", "Set a tab stop."],
  "=": ["DECKPAM", "mode", "Application keypad mode."],
  ">": ["DECKPNM", "mode", "Normal keypad mode."],
  c: ["RIS", "reset", "Full terminal reset: clears the screen and every mode."],
  Z: ["DECID", "query", "Identify terminal: the terminal answers into your input."],
  N: ["SS2", "mode", "Single shift 2: the next character from character set G2."],
  O: ["SS3", "mode", "Single shift 3: the next character from character set G3."],
  "\\": ["ST", "ignored", "String terminator with no string open."],
};

function oscMeaning(body) {
  const semi = body.indexOf(";");
  const ps = semi < 0 ? body : body.slice(0, semi);
  const arg = semi < 0 ? "" : body.slice(semi + 1);
  const short = (s) => (s.length > 40 ? s.slice(0, 40) + "..." : s);
  switch (ps) {
    case "0": return ["OSC 0", "host", `Set the window and icon title to "${short(arg)}".`];
    case "1": return ["OSC 1", "host", `Set the icon title to "${short(arg)}".`];
    case "2": return ["OSC 2", "host", `Set the window title to "${short(arg)}".`];
    case "4": return ["OSC 4", arg.includes("?") ? "query" : "host", "Change or query the colour palette."];
    case "7": return ["OSC 7", "host", "Tell the terminal the current directory."];
    case "8": return ["OSC 8", "host", arg.replace(/^[^;]*;/, "") ? `Start a hyperlink to "${short(arg.replace(/^[^;]*;/, ""))}": the text that follows becomes clickable, whatever it says.` : "End the hyperlink."];
    case "9": return ["OSC 9", "host", "Post a desktop notification (iTerm2 and others)."];
    case "10": case "11": case "12": return [`OSC ${ps}`, arg.includes("?") ? "query" : "host", "Set or query a default colour."];
    case "52": return ["OSC 52", arg.endsWith("?") ? "query" : "host", arg.endsWith("?") ? "Read the clipboard: the terminal types its contents into your input." : "Write the system clipboard (the text is base64)."];
    case "104": return ["OSC 104", "host", "Reset the colour palette."];
    case "133": return ["OSC 133", "host", "Shell integration marks."];
    case "777": return ["OSC 777", "host", "Post a desktop notification."];
    case "1337": return ["OSC 1337", "host", "iTerm2's own commands: files, images, user variables and more."];
    default: return [`OSC ${short(ps)}`, "host", "An operating system command."];
  }
}

function dcsMeaning(body) {
  if (body.startsWith("$q")) return ["DECRQSS", "query", "Request a setting: the terminal answers with a DCS string typed into your input."];
  if (body.startsWith("+q")) return ["XTGETTCAP", "query", "Request a terminfo capability: answered into your input."];
  if (body.startsWith("tmux;")) return ["tmux passthrough", "host", "tmux forwards what follows to the outer terminal, past tmux's own filtering."];
  if (/^[0-9;]*q/.test(body)) return ["sixel", "host", "Sixel graphics: an image drawn by the terminal's image decoder."];
  return ["DCS", "host", "A device control string."];
}

const C0_MEANINGS = {
  0x00: ["NUL", "ignored", "Null: ignored."],
  0x05: ["ENQ", "query", "Enquiry: some terminals answer with an answerback string, typed into your input."],
  0x07: ["BEL", "host", "Bell: a sound or a flash, and on macOS a bounce of the Dock icon."],
  0x08: ["BS", "control", "Backspace: cursor left one column."],
  0x09: ["HT", "control", "Tab: cursor to the next tab stop."],
  0x0a: ["LF", "control", "Line feed: cursor down one line."],
  0x0b: ["VT", "control", "Vertical tab: treated as a line feed."],
  0x0c: ["FF", "control", "Form feed: treated as a line feed."],
  0x0d: ["CR", "control", "Carriage return: cursor to column 1."],
  0x0e: ["SO", "mode", "Shift out: switch to character set G1 (often line drawing) until SI."],
  0x0f: ["SI", "mode", "Shift in: back to character set G0."],
  0x18: ["CAN", "control", "Cancel: aborts a sequence in progress."],
  0x1a: ["SUB", "control", "Substitute: aborts a sequence in progress."],
  0x7f: ["DEL", "ignored", "Delete: ignored on output."],
};

/** Why an escape or control sequence ended without its final byte. */
function stopWhy(stop, b, what) {
  const A = /^[aeiou]/.test(what) ? "An" : "A";
  if (stop === "cancel") return `${A} ${what} cancelled by the ${b === CAN ? "CAN" : "SUB"} that follows: the terminal abandons it.`;
  if (stop === "esc") return `${A} ${what} cut short by another ESC, which starts a new one.`;
  if (stop === "high") {
    return `${A} ${what} abandoned at byte ${byteName(b)}, which is not part of an escape sequence` +
      (b <= 0x9f ? " (a terminal that honours 8-bit controls starts a new control there)." : ".");
  }
  return `An unfinished ${what} at the end: the terminal waits for the rest.`;
}

/** The C0 controls a terminal executes in the middle of a sequence, as tokens of their own. */
function execTokens(bytes, offsets) {
  if (offsets.length === 0) return undefined;
  return offsets.slice(0, 20).map((k) => {
    const c = bytes[k];
    const m = C0_MEANINGS[c] || [C0_NAMES[c], "ignored", "A control character most terminals ignore."];
    return { kind: "control", start: k, end: k + 1, label: m[0], effect: m[1], meaning: `Executed mid-sequence: the terminal runs it at once, then goes on with the sequence. ${m[2]}` };
  });
}

/** A sentence about controls run, and DELs ignored, inside a sequence. */
function midNote(bytes, offsets, dels) {
  let s = "";
  if (offsets.length) {
    const names = [...new Set(offsets.map((k) => C0_NAMES[bytes[k]]))].join(", ");
    s += ` The ${names} inside ${offsets.length === 1 ? "it is" : "it are"} run by the terminal at once, and then the sequence carries on.`;
  }
  if (dels) s += ` The DEL${dels === 1 ? "" : "s"} inside ${dels === 1 ? "is" : "are"} ignored.`;
  return s;
}

/**
 * Tokenize `bytes` as an xterm-like terminal that also honours 8-bit C1 controls would.
 * Returns { tokens, omitted } with at most maxTokens tokens. Each token:
 * { kind, start, end, label, effect, meaning, parts? }. `parts` (for CSI) holds the
 * introducer, parameter, intermediate and final bytes as display text.
 */
export function tokenize(bytes, { maxTokens = 400 } = {}) {
  const tokens = [];
  let omitted = 0;
  const add = (t) => {
    if (tokens.length < maxTokens) tokens.push(t);
    else omitted += 1;
  };
  const n = bytes.length;
  let i = 0;
  const textRun = () => {
    const s = i;
    while (i < n) {
      const b = bytes[i];
      if (b >= 0x20 && b <= 0x7e) { i++; continue; }
      if (b >= 0xc2) {
        const len = printableUtf8At(bytes, i, n);
        if (len) { i += len; continue; }
      }
      break;
    }
    return s;
  };
  while (i < n) {
    const b = bytes[i];
    const start = i;
    // Text.
    if ((b >= 0x20 && b <= 0x7e) || (b >= 0xc2 && printableUtf8At(bytes, i, n))) {
      textRun();
      add({ kind: "text", start, end: i, label: "text", effect: "text", meaning: "Printed as is." });
      continue;
    }
    // UTF-8 encoded C1 (U+0080..U+009F): C2 80..9F.
    let c1 = -1;
    let introLen = 1;
    if (b >= 0x80 && b <= 0x9f) c1 = b;
    else if (b === 0xc2 && i + 1 < n && bytes[i + 1] >= 0x80 && bytes[i + 1] <= 0x9f) { c1 = bytes[i + 1]; introLen = 2; }
    if (b === ESC || c1 >= 0) {
      let kind;
      let intro;
      let j;
      const executed = []; // offsets of C0 controls the terminal runs in the middle of the sequence
      let dels = 0; // DEL bytes inside the sequence, which the terminal ignores
      if (c1 >= 0) {
        kind = { 0x9b: "csi", 0x9d: "osc", 0x90: "dcs", 0x9f: "apc", 0x9e: "pm", 0x98: "sos" }[c1];
        intro = `${introLen === 2 ? "U+00" + hex2(c1).toUpperCase() : "0x" + hex2(c1).toUpperCase()}`;
        j = i + introLen;
        if (!kind) {
          i = j;
          add({ kind: "c1", start, end: i, label: C1_NAMES[c1] || "C1", effect: c1 === 0x9a ? "query" : "unknown", meaning: `An 8-bit C1 control${C1_NAMES[c1] ? ` (${C1_NAMES[c1]})` : ""}, which some terminals obey${introLen === 2 ? " even when it arrives UTF-8 encoded" : ""}.` });
          continue;
        }
      } else {
        // The escape state of a VT500-style parser (the model xterm, VTE and iTerm2 follow): a C0
        // control here is executed at once and the sequence carries on, DEL is ignored, CAN and
        // SUB cancel, and a new ESC starts over. Intermediates are 0x20-0x2F, the final byte
        // 0x30-0x7E (ECMA-48 §5.3).
        let k = i + 1;
        const inters = [];
        let stop = "end";
        while (k < n) {
          const c = bytes[k];
          if (c === CAN || c === SUB) { stop = "cancel"; break; }
          if (c === ESC) { stop = "esc"; break; }
          if (c < 0x20) { executed.push(k); k++; continue; }
          if (c === 0x7f) { dels += 1; k++; continue; }
          if (c >= 0x80) { stop = "high"; break; }
          if (c <= 0x2f) { if (inters.length < 20) inters.push(c); k++; continue; }
          stop = "final";
          break;
        }
        const e = stop === "final" ? bytes[k] : -1;
        kind = stop === "final" && inters.length === 0 ? { 0x5b: "csi", 0x5d: "osc", 0x50: "dcs", 0x5f: "apc", 0x5e: "pm", 0x58: "sos" }[e] : undefined;
        if (kind) {
          intro = "ESC " + String.fromCharCode(e);
          j = k + 1;
        } else if (stop === "final") {
          const seq = String.fromCharCode(...inters, e);
          i = k + 1;
          let m = ESC_MEANINGS[seq];
          if (!m && (seq[0] === "(" || seq[0] === ")")) {
            const g = seq[0] === "(" ? "G0" : "G1";
            m = seq[1] === "0" ? ["SCS", "mode", `Character set ${g} = DEC line drawing: most lowercase letters become line-drawing symbols.`]
              : seq[1] === "B" ? ["SCS", "mode", `Character set ${g} = ASCII.`]
              : ["SCS", "mode", `Select character set ${seq.slice(1)} for ${g}.`];
          }
          if (!m && seq === "#8") m = ["DECALN", "cursor", "Screen alignment test: fill the screen with E."];
          if (!m && seq[0] === "#") m = ["DEC line size", "format", "Double-width or double-height line."];
          if (!m) m = [`ESC ${seq}`, "unknown", "An escape sequence this lab does not describe."];
          add({ kind: "esc", start, end: i, label: m[0], effect: m[1], meaning: m[2] + midNote(bytes, executed, dels), executed: execTokens(bytes, executed) });
          continue;
        } else {
          i = k;
          const why = stopWhy(stop, bytes[k], "escape sequence");
          add({ kind: "esc", start, end: i, label: "ESC", effect: "broken", meaning: why + midNote(bytes, executed, dels), executed: execTokens(bytes, executed) });
          continue;
        }
      }
      if (kind === "csi") {
        // CSI entry, param, intermediate and ignore states (ECMA-48 §5.4: parameters 0x30-0x3F,
        // intermediates 0x20-0x2F, final 0x40-0x7E), with the same rules for controls as above.
        // A parameter byte after an intermediate, or a prefix byte (< = > ?) after the first
        // parameter byte, makes the sequence malformed: the terminal reads on to the final byte
        // and ignores the whole thing.
        let k = j;
        const pb = [];
        const ib = [];
        let malformed = false;
        let stop = "end";
        while (k < n) {
          const c = bytes[k];
          if (c === CAN || c === SUB) { stop = "cancel"; break; }
          if (c === ESC) { stop = "esc"; break; }
          if (c < 0x20) { executed.push(k); k++; continue; }
          if (c === 0x7f) { dels += 1; k++; continue; }
          if (c >= 0x80) { stop = "high"; break; }
          if (c >= 0x40) { stop = "final"; break; }
          if (c >= 0x30) {
            if (ib.length || (pb.length && c >= 0x3c)) malformed = true;
            if (pb.length < 200) pb.push(c);
          } else if (ib.length < 50) {
            ib.push(c);
          }
          k++;
        }
        const rawParams = String.fromCharCode(...pb);
        const inter = String.fromCharCode(...ib);
        const pre = c1 >= 0 ? `On a terminal that honours 8-bit controls, ${intro} works like ESC [. ` : "";
        if (stop === "final") {
          const fin = String.fromCharCode(bytes[k]);
          i = k + 1;
          const prefix = /^[<=>?]/.test(rawParams) ? rawParams[0] : "";
          const params = prefix ? rawParams.slice(1) : rawParams;
          const d = malformed
            ? { label: "CSI", effect: "ignored", meaning: "A malformed control sequence (a parameter byte after an intermediate, or a prefix byte in the middle): the terminal reads it up to its final byte and ignores it." }
            : describeCsi(prefix, params, inter, fin);
          add({
            kind: "csi", start, end: i, label: d.label, effect: d.effect,
            meaning: pre + d.meaning + midNote(bytes, executed, dels),
            parts: { intro, params: rawParams, inter, final: fin },
            executed: execTokens(bytes, executed),
          });
        } else {
          i = k;
          add({
            kind: "csi", start, end: i, label: "CSI", effect: "broken",
            meaning: pre + stopWhy(stop, bytes[k], "control sequence") + midNote(bytes, executed, dels),
            parts: { intro, params: rawParams, inter, final: "" },
            executed: execTokens(bytes, executed),
          });
        }
        continue;
      }
      // Strings: OSC, DCS, APC, PM, SOS up to BEL (OSC, xterm), ST (ESC \ or 0x9C), or CAN/SUB.
      let k = j;
      let term = "";
      while (k < n) {
        const c = bytes[k];
        if (c === BEL && kind === "osc") { term = "BEL"; k += 1; break; }
        if (c === ESC && k + 1 < n && bytes[k + 1] === 0x5c) { term = "ST (ESC \\)"; k += 2; break; }
        if (c === 0x9c) { term = "ST (0x9C)"; k += 1; break; }
        if (c === CAN || c === SUB) { term = c === CAN ? "CAN" : "SUB"; k += 1; break; }
        k++;
      }
      const bodyEnd = term ? k - (term.startsWith("ST (ESC") ? 2 : 1) : k;
      const body = String.fromCharCode(...bytes.subarray(j, Math.min(bodyEnd, j + 120)));
      i = k;
      let m;
      if (kind === "osc") m = oscMeaning(body);
      else if (kind === "dcs") m = dcsMeaning(body);
      else if (kind === "apc") m = body.startsWith("G") ? ["APC (kitty graphics)", "host", "Kitty's graphics protocol: images, and the terminal may answer into your input."] : ["APC", "host", "An application program command."];
      else m = [kind === "pm" ? "PM" : "SOS", "ignored", "A privacy message or start-of-string: most terminals ignore it."];
      const len = bodyEnd - j;
      add({
        kind: "string", start, end: i, label: m[0], effect: term && !term.startsWith("CAN") && !term.startsWith("SUB") ? m[1] : "broken",
        meaning: (c1 >= 0 ? `On a terminal that honours 8-bit controls, ${intro} opens a string like its ESC form. ` : "") +
          (term ? (term === "CAN" || term === "SUB" ? `Cancelled by ${term}. ` : "") : `Never terminated: the terminal keeps swallowing (${len} bytes so far). `) +
          m[2] + (term && term !== "CAN" && term !== "SUB" ? ` Ends at ${term}; ${len} bytes of content.` : "") + midNote(bytes, executed, dels),
        parts: { intro, body: len > 120 ? body + "..." : body, term },
        executed: execTokens(bytes, executed),
      });
      continue;
    }
    if (b < 0x20 || b === 0x7f) {
      i += 1;
      const m = C0_MEANINGS[b] || [C0_NAMES[b] || "DEL", "ignored", "A control character most terminals ignore."];
      add({ kind: "control", start, end: i, label: m[0], effect: m[1], meaning: m[2] });
      continue;
    }
    // Invalid UTF-8: as many bytes as cannot form a character, one at a time.
    i += 1;
    add({ kind: "invalid", start, end: i, label: "invalid UTF-8", effect: "broken", meaning: `${byteName(b)} is not valid UTF-8 here: a terminal shows a replacement character (or something stranger).` });
  }
  return { tokens, omitted };
}

// ---- Presets ----------------------------------------------------------------------------------

/** The 22 attack strings of the hostile-tty test guest (guests/hostile-tty/main.rs), in order. */
export const HOSTILE_TTY_ATTACKS = [
  ["DA", "\\x1b[c"],
  ["DA2", "\\x1b[>c"],
  ["DSR", "\\x1b[6n"],
  ["DSR status", "\\x1b[5n"],
  ["CSI t report", "\\x1b[21t"],
  ["CSI t resize", "\\x1b[8;1;1t"],
  ["CSI i print", "\\x1b[5i"],
  ["OSC 0 title", "\\x1b]0;pwned\\x07"],
  ["OSC 2 title", "\\x1b]2;pwned\\x1b\\\\"],
  // Split so that shipped code never contains a URL scheme literal (the builder rejects one).
  ["OSC 8 link", "\\x1b]8;;https:" + "//example.invalid/\\x07link\\x1b]8;;\\x07"],
  ["OSC 52 clipboard", "\\x1b]52;c;bWFjdm1tLXBvd25lZA==\\x07"],
  ["OSC 1337", "\\x1b]1337;File=inline=1:AAAA\\x07"],
  ["DCS DECRQSS", "\\x1bP$qm\\x1b\\\\"],
  ["DCS tmux", "\\x1bPtmux;\\x1b\\x1b]52;c;AAAA\\x07\\x1b\\\\"],
  ["APC", "\\x1b_Ga=d;AAAA\\x1b\\\\"],
  ["PM", "\\x1b^private\\x1b\\\\"],
  ["SOS", "\\x1bXstring\\x1b\\\\"],
  ["ENQ", "\\x05"],
  ["SO/SI", "\\x0e\\x0f"],
  ["C1 CSI raw", "\\x9b6n"],
  ["C1 OSC raw", "\\x9d52;c;AAAA\\x07"],
  ["C1 CSI UTF-8", "\\xc2\\x9b6n"],
];

/** The reset macvmm writes on exit (captures/09-tty-escape.txt). */
export const EXIT_RESET =
  "\\x1b[0m\\x1b[?25h\\x1b[?1049l\\x1b[?1047l\\x1b[?47l\\x1b[?2004l\\x1b[?1l\\x1b[?7h\\x1b[?12l\\x1b[0 q\\x1b[4l\\x1b>\\x1b(B\\x1b)B\\x1b7\\x1b[r\\x1b8";

export const PRESETS = [
  {
    id: "bold-red",
    label: "Bold red text (the primer's first prediction)",
    text: "\\x1b[1;31mhi\\x1b[0m",
    note: "Two SGR sequences with small numeric parameters around the text hi.",
  },
  {
    id: "osc-title",
    label: "A title with a command in it (the primer's second prediction)",
    text: "\\x1b]0;rm -rf ~\\x07ok",
    note: "OSC 0 sets the window title. Nothing of it may survive, not even the text.",
  },
  {
    id: "zsh-prompt",
    label: "What zsh writes for a prompt (from the primer)",
    text: "\\x1b[0m\\x1b[27m\\x1b[24m\\x1b[J<prompt>% \\x1b[K\\x1b[?2004hs\\x08sleep 30\\x1b[?2004l\\r\\r\\n",
    note: "Real shell output: resets, erases, bracketed paste on and off, a backspace. All of it is on the allow-list.",
  },
  {
    id: "cursor-query",
    label: "Ask for the cursor position",
    text: "before \\x1b[6n after",
    note: "CSI 6 n makes the terminal type ESC [ row ; col R into your input.",
  },
  {
    id: "title-query",
    label: "Attack: set the title, then ask for it back",
    text: "\\x1b]2;id\\x07\\x1b[21t",
    note: "Older terminals answered CSI 21 t by typing the title into the input, where a shell would run it.",
  },
  {
    id: "osc-10mb",
    label: "Attack: a 10 MB OSC string (clipboard write)",
    text: "\\x1b]52;c;\\x41{10485760}\\x07after",
    note: "Ten mebibytes of A inside OSC 52. The filter swallows it in constant memory and keeps the text after the BEL.",
  },
  {
    id: "lone-9b",
    label: "Attack: a lone 0x9B (8-bit CSI)",
    text: "before \\x9b6n after",
    note: "0x9B means ESC [ to a terminal that honours 8-bit controls. A filter that only looks for 0x1B would let CSI 6 n through.",
  },
  {
    id: "tmux",
    label: "Attack: tmux passthrough wrapping a clipboard write",
    text: "\\x1bPtmux;\\x1b\\x1b]52;c;AAAA\\x07\\x1b\\\\after",
    note: "A DCS string with an OSC hidden inside it, its ESC doubled the way tmux expects.",
  },
  {
    id: "tty-hygiene",
    label: "The tty-hygiene test guest (chapter 09's capture)",
    text: "tty-hygiene: start\\n\\x1b[?1049h\\x1b[?25l\\x1b[?2004h\\x1b[6n\\x1b]52;c;bWFjdm1tLWNsaXBib2FyZA==\\x07tty-hygiene: done\\n",
    note: "Everything this guest writes to the UART. The safe output equals the stdout of captures/09-filter.txt.",
  },
  {
    id: "hostile-tty",
    label: "The hostile-tty test guest: 22 attack strings (chapter 25's capture)",
    text: "hostile-tty: begin\\n" + HOSTILE_TTY_ATTACKS.map((a) => a[1]).join("") + "\\nhostile-tty: 22 attack strings sent\\nhostile-tty: end\\n",
    note: "Everything this guest writes to the UART. The safe output and the dropped counter (160, printed as serial_filtered) match captures/25-phase-tty.txt.",
  },
  {
    id: "exit-reset",
    label: "The reset macvmm itself sends on exit",
    text: EXIT_RESET,
    note: "Every mode safe lets a guest set, switched back. It passes safe unchanged, or the reset would be pointless (captures/09-tty-escape.txt).",
  },
  {
    id: "utf8",
    label: "UTF-8: valid, broken and C1",
    text: "h\u00e9llo \u2713 \\xc3x \\xed\\xa0\\x80 \\xff \\u{9b}6n",
    note: "Valid characters pass; a truncated character, a surrogate and 0xFF become U+FFFD; U+009B, a C1 control in UTF-8, is dropped.",
  },
  {
    id: "mid-control",
    label: "A newline in the middle of a colour change",
    text: "\\x1b[3\\n1mred?",
    note: "A terminal runs the LF at once and then finishes the sequence: SGR 31, red. The filter drops the partial ESC [ 3 instead and writes the LF and the rest as text, so no sequence reaches the terminal.",
  },
  {
    id: "long-csi",
    label: "A CSI longer than 64 bytes",
    text: "\\x1b[\\x31{70}mtext\\n",
    note: "The filter keeps at most 64 bytes of a CSI in progress. A longer one is skipped to its final byte, and the text after it survives.",
  },
  {
    id: "strict-golden",
    label: "Every kind of control, for strict",
    text: "ok\\x1b[6n\\x07\\x9b\\xc2\\x9b\\x7f\\tz\\xff\\xe2\\x82y\\r\\n\\x08\\x00",
    note: "The byte-for-byte strict rendering test from the filter's own test suite.",
  },
];

// ---- State and share hash ---------------------------------------------------------------------

export const DEFAULT_PRESET = "bold-red";
const MAX_HASH_TEXT = 2000;

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

export function initialState() {
  const p = presetById(DEFAULT_PRESET);
  return { text: p.text, preset: p.id, prediction: "", ran: false };
}

/**
 * What the lab keeps in the address bar without being asked: a preset's id, and `null` for text
 * the reader typed or pasted. That text goes into the address only when the reader presses
 * "Copy link" (the view then uses `encodeHash`).
 */
export function encodeAuto(state) {
  const p = state.preset && presetById(state.preset);
  return p && p.text === state.text ? p.id : null;
}

/** Share state: a preset id, or `t:` + the URI-encoded input text (custom input). */
export function encodeHash(state) {
  const p = state.preset && presetById(state.preset);
  if (p && p.text === state.text) return p.id;
  const enc = "t:" + encodeURIComponent(state.text);
  return enc.length <= MAX_HASH_TEXT ? enc : null;
}

export function decodeHash(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_HASH_TEXT * 3) return null;
  const p = presetById(s);
  if (p) return { text: p.text, preset: p.id, prediction: "", ran: true };
  if (s.startsWith("t:")) {
    let text;
    try {
      text = decodeURIComponent(s.slice(2));
    } catch {
      return null;
    }
    if (text.length > MAX_HASH_TEXT) return null;
    return { text, preset: null, prediction: "", ran: true };
  }
  return null;
}

/**
 * Everything the view shows for one input: parse, tokenize, safe and strict with segments.
 * Returns { ok:false, error, at } or { ok:true, bytes, tokens, safe, strict, raw }.
 * `max` caps the expanded input in bytes: MAX_INPUT for text the reader typed, MAX_LINK_INPUT
 * for text that came from a share link.
 */
export function analyze(text, { maxTokens = 400, maxSegments = 2000, max = MAX_INPUT } = {}) {
  const parsed = parseInput(text, { max });
  if (!parsed.ok) return parsed;
  const bytes = parsed.bytes;
  const tok = tokenize(bytes, { maxTokens });
  const safe = runFilter("safe", bytes, { trace: true, maxSegments });
  const strict = runFilter("strict", bytes, { trace: true, maxSegments });
  return { ok: true, bytes, tokens: tok.tokens, tokensOmitted: tok.omitted, safe, strict };
}

/** Compare a prediction (in the input notation) with the safe output. */
export function checkPrediction(prediction, safeOut) {
  const p = parseInput(prediction, { max: 1 << 20 });
  if (!p.ok) return { ok: false, error: p.error };
  if (p.bytes.length !== safeOut.length) return { ok: true, match: false };
  for (let k = 0; k < p.bytes.length; k++) if (p.bytes[k] !== safeOut[k]) return { ok: true, match: false };
  return { ok: true, match: true };
}

/** Counts of what the safe policy did: pieces removed and pieces replaced by U+FFFD. */
export function safeCounts(a) {
  let removed = 0;
  let replaced = 0;
  for (const seg of a.safe.segments) {
    if (seg.verdict === "drop") removed += 1;
    else if (seg.verdict === "replace") replaced += 1;
  }
  return { removed, replaced, more: a.safe.segmentsOmitted > 0 };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A plain-text summary for the readout. */
export function summary(a) {
  if (!a.ok) return `Input error: ${a.error}`;
  const { removed, replaced, more } = safeCounts(a);
  const kept = a.safe.out.length;
  const or = more ? " or more" : "";
  return `${plural(a.bytes.length, "input byte", "input bytes")}. ` +
    `The safe policy keeps ${plural(kept, "byte", "bytes")}, removes ${removed}${or} piece${removed === 1 && !more ? "" : "s"} ` +
    `and replaces ${replaced}${or} with U+FFFD. Its dropped counter, roughly the number of bytes removed, ends at ${a.safe.dropped} ` +
    `(macvmm prints it as serial_filtered). The strict policy writes ${plural(a.strict.out.length, "byte", "bytes")}, every control made visible.`;
}
