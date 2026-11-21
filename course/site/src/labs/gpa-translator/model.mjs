// gpa-translator: the pure model (no DOM, no I/O). Chapter 04, "Guest memory".
//
// It mirrors the reference's region table and bounds check in crates/vmm/src/memory/region.rs
// (RegionTable::new and RegionTable::locate) and GuestAddress::checked_add in address.rs, with
// u64 arithmetic done in BigInt so 0xFFFF_FFFF_FFFF_FFFC + 8 is computed exactly. Next to the
// checked version it models the wrong ones the lesson names: a wrapping sum (C, or Rust's plain
// `+` when overflow checks are off, its default for release builds), a panicking sum (plain `+`
// with overflow checks on: Rust's default in debug builds, and this repository's setting in
// release too), and a check that uses checked_add but tests the range against RAM as a whole
// instead of against one region (why checked_add alone is not enough).
//
// Every value here comes from a text box or a shared URL, so it is parsed strictly: bounded
// length, bounded value (u64), bounded table size. Errors are values, never exceptions.

export const U64_MAX = (1n << 64n) - 1n;
const TWO64 = 1n << 64n;
const TWO63 = 1n << 63n;

/** Alignment of every region base and size: the default 16 KiB stage-2 granule (REGION_ALIGN). */
export const REGION_ALIGN = 16n * 1024n;
/** The most regions one table may hold (MAX_REGIONS). */
export const MAX_REGIONS = 16;
/** Accepted IPA widths (MIN_IPA_BITS..=MAX_IPA_BITS). */
export const MIN_IPA_BITS = 32;
export const MAX_IPA_BITS = 52;
/** HVF's default IPA width when a VM is created without a configuration. */
export const DEFAULT_IPA_BITS = 36;

/** Longest number text we accept (a u64 in binary with separators fits easily). */
const MAX_INPUT_CHARS = 96;
/** Longest share-state string we parse. */
export const MAX_HASH_CHARS = 1024;

// ---------------------------------------------------------------------------------------------
// Numbers: parse and format
// ---------------------------------------------------------------------------------------------

const SUFFIX = { k: 10n, m: 20n, g: 30n, t: 40n };

/**
 * Parse a u64 typed by the reader: `0x4000_0000`, `1073741824`, `0b1010`, or a size such as
 * `64M` / `16K` / `1G` (binary units). Underscores are separators. Returns
 * `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function parseU64(text) {
  if (typeof text !== "string") return { ok: false, error: "not text" };
  const raw = text.trim();
  if (raw.length === 0) return { ok: false, error: "empty" };
  if (raw.length > MAX_INPUT_CHARS) return { ok: false, error: "too long" };
  let s = raw.replace(/_/g, "").toLowerCase();
  let shift = 0n;
  const last = s.slice(-1);
  const isHex = s.startsWith("0x");
  if (!isHex && Object.hasOwn(SUFFIX, last)) {
    shift = SUFFIX[last];
    s = s.slice(0, -1);
  } else if (!isHex && (s.endsWith("kib") || s.endsWith("mib") || s.endsWith("gib") || s.endsWith("tib"))) {
    shift = SUFFIX[s.slice(-3, -2)];
    s = s.slice(0, -3);
  }
  let value;
  if (/^0x[0-9a-f]+$/.test(s)) value = BigInt(s);
  else if (/^0b[01]+$/.test(s)) value = BigInt(s);
  else if (/^[0-9]+$/.test(s)) value = BigInt(s);
  else return { ok: false, error: "not a number (use hex like 0x4000_0000, decimal, or 64M)" };
  value <<= shift;
  if (value > U64_MAX) return { ok: false, error: "larger than 64 bits" };
  return { ok: true, value };
}

/**
 * Format a BigInt as the course writes addresses: `0x4000_1000`, upper-case digits, an
 * underscore every four digits from the right, no padding (`0x4`, `0x1000`).
 */
export function hex(v) {
  if (v < 0n) return "-" + hex(-v);
  const digits = v.toString(16).toUpperCase();
  if (digits.length <= 4) return "0x" + digits;
  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.unshift(digits.slice(Math.max(0, end - 4), end));
  }
  return "0x" + groups.join("_");
}

/** A length in the units a reader thinks in: `8`, `0x2D9A`, `64 MiB`. */
export function lenText(v) {
  if (v < 16n) return v.toString();
  return hex(v);
}

/** A size in binary units when exact (`64 MiB`, `16 KiB`), else hex. */
export function sizeText(v) {
  const units = [
    [40n, "TiB"],
    [30n, "GiB"],
    [20n, "MiB"],
    [10n, "KiB"],
  ];
  for (const [sh, name] of units) {
    const unit = 1n << sh;
    if (v >= unit && v % unit === 0n) return `${v / unit} ${name}`;
  }
  return hex(v);
}

// ---------------------------------------------------------------------------------------------
// The region table (RegionTable::new)
// ---------------------------------------------------------------------------------------------

/**
 * Validate `regions` (`[{ base, size }]` as BigInt, any order) for a VM with `ipaBits` of IPA
 * space, with the reference's rules in the reference's order. Returns
 * `{ ok: true, spans: [{ base, size, end, index }] }` sorted by base (`index` is the reader's
 * row number), or `{ ok: false, error: { kind, ...numbers }, message }`.
 */
export function buildTable(regions, ipaBits) {
  const fail = (error) => ({ ok: false, error, message: regionErrorText(error) });
  if (!Array.isArray(regions) || regions.length === 0) return fail({ kind: "Empty" });
  if (regions.length > MAX_REGIONS) return fail({ kind: "TooMany", count: regions.length });
  if (!Number.isInteger(ipaBits) || ipaBits < MIN_IPA_BITS || ipaBits > MAX_IPA_BITS) {
    return fail({ kind: "BadIpaBits", bits: ipaBits });
  }
  const limit = 1n << BigInt(ipaBits);
  const spans = [];
  for (let i = 0; i < regions.length; i++) {
    const { base, size } = regions[i];
    if (typeof base !== "bigint" || typeof size !== "bigint" || base < 0n || size < 0n || base > U64_MAX || size > U64_MAX) {
      return fail({ kind: "Invalid", row: i });
    }
    if (size === 0n) return fail({ kind: "ZeroSize", base });
    if (base % REGION_ALIGN !== 0n || size % REGION_ALIGN !== 0n) {
      return fail({ kind: "Unaligned", base, size });
    }
    const end = base + size;
    if (end > U64_MAX) return fail({ kind: "Overflow", base, size });
    if (end > limit) return fail({ kind: "AboveIpaLimit", base, size, ipaBits });
    spans.push({ base, size, end, row: i });
  }
  // Stable sort by base, as Rust's sort_by_key.
  spans.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.row - b.row));
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1];
    const b = spans[i];
    if (b.base < a.end) return fail({ kind: "Overlap", first: a.base, second: b.base });
  }
  return { ok: true, spans: spans.map((s, index) => ({ ...s, index })) };
}

/** The reference's RegionError Display text, in course notation. */
export function regionErrorText(e) {
  switch (e.kind) {
    case "Empty":
      return "no memory regions";
    case "TooMany":
      return `${e.count} memory regions (at most ${MAX_REGIONS})`;
    case "BadIpaBits":
      return `IPA width ${e.bits} bits is outside ${MIN_IPA_BITS}..=${MAX_IPA_BITS}`;
    case "Invalid":
      return `region ${e.row} has a base or size that is not a 64-bit number`;
    case "ZeroSize":
      return `region at ${hex(e.base)} has size 0`;
    case "Unaligned":
      return `region ${hex(e.base)}+${hex(e.size)} is not ${hex(REGION_ALIGN)}-aligned (16 KiB)`;
    case "Overflow":
      return `region ${hex(e.base)}+${hex(e.size)} overflows the address space`;
    case "AboveIpaLimit":
      return `region ${hex(e.base)}+${hex(e.size)} does not fit in a ${e.ipaBits}-bit IPA space`;
    case "Overlap":
      return `regions at ${hex(e.first)} and ${hex(e.second)} overlap`;
    default:
      return "invalid region table";
  }
}

/** Which construction rule a RegionError breaks, and why the rule exists (for the readout). */
export function regionErrorWhy(e) {
  switch (e.kind) {
    case "Empty":
      return "A VM with no RAM has nothing to run.";
    case "TooMany":
      return "A named cap keeps every lookup and the table itself bounded.";
    case "BadIpaBits":
      return "The architecture allows 32- to 52-bit guest-physical spaces; the reference refuses anything outside that range (HVF on your Mac allows less: `macvmm doctor` prints the maximum).";
    case "Invalid":
      return "Every base and size must be a number from 0 to 2^64 - 1.";
    case "ZeroSize":
      return "A region of size 0 has no meaningful end.";
    case "Unaligned":
      return "hv_vm_map works in whole 16 KiB host pages; this rule catches it before HVF answers HV_BAD_ARGUMENT.";
    case "Overflow":
      return "base + size wraps, so the region would appear to contain low memory.";
    case "AboveIpaLimit":
      return "An IPA the VM cannot address can never be mapped.";
    case "Overlap":
      return "One guest-physical byte must have exactly one host home.";
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------------------------
// One access (RegionTable::locate), and the two wrong versions
// ---------------------------------------------------------------------------------------------

/**
 * The symbolic host base of the region at sorted position `index`. The lesson writes `H` when
 * there is one region; otherwise it is named after the reader's row (`H0`, `H1`), so learner
 * text always matches the "region N" labels in the form, whatever order the rows were typed in.
 */
export function hostName(spans, index) {
  return spans.length === 1 ? "H" : `H${spans[index].row}`;
}

/** "region N", numbered as the reader's rows are. */
export function regionName(span) {
  return `region ${span.row}`;
}

/** `H + 0x1000`, `H - 0x4000_0004`, from a signed delta (BigInt). */
export function hostExpr(name, delta) {
  if (delta === 0n) return name;
  return delta < 0n ? `${name} - ${hex(-delta)}` : `${name} + ${hex(delta)}`;
}

/** The last span whose base is <= addr (Rust's partition_point(..) - 1), or -1. */
function lastAtOrBelow(spans, addr) {
  let idx = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].base <= addr) idx = i;
    else break;
  }
  return idx;
}

/**
 * The reference's check, step by step. `addr` and `len` are BigInt u64s. Returns
 * `{ ok, error?, index?, offset?, steps: [{ check, detail, pass }] }`, where `error` is
 * `{ kind: "Overflow" | "OutOfBounds", addr, len }` exactly like MemoryError.
 */
export function locate(spans, addr, len) {
  const steps = [];
  const sum = addr + len;
  if (sum > U64_MAX) {
    steps.push({
      check: "addr.checked_add(len)",
      detail: `${hex(addr)} + ${lenText(len)} needs 65 bits: None`,
      pass: false,
    });
    return { ok: false, error: { kind: "Overflow", addr, len }, steps };
  }
  steps.push({ check: "addr.checked_add(len)", detail: `Some(${hex(sum)})`, pass: true });
  const oob = { kind: "OutOfBounds", addr, len };
  if (len === 0n) {
    steps.push({ check: "len > 0", detail: "len is 0: an empty access is refused", pass: false });
    return { ok: false, error: oob, steps };
  }
  steps.push({ check: "len > 0", detail: `len is ${lenText(len)}`, pass: true });
  const index = lastAtOrBelow(spans, addr);
  if (index < 0) {
    steps.push({
      check: "a region starts at or below addr",
      detail: `no region starts at or below ${hex(addr)}`,
      pass: false,
    });
    return { ok: false, error: oob, steps };
  }
  const span = spans[index];
  steps.push({
    check: "a region starts at or below addr",
    detail: `${regionName(span)}: ${hex(span.base)}..${hex(span.end)}`,
    pass: true,
  });
  if (sum > span.end) {
    const where = addr >= span.end ? "starts past its end" : "runs past its end";
    steps.push({
      check: "addr + len <= region end",
      detail: `${hex(sum)} > ${hex(span.end)}: the access ${where}`,
      pass: false,
    });
    return { ok: false, error: oob, steps };
  }
  steps.push({
    check: "addr + len <= region end",
    detail: `${hex(sum)} <= ${hex(span.end)}`,
    pass: true,
  });
  return { ok: true, index, offset: addr - span.base, steps };
}

/** MemoryError's Display text. */
export function memoryErrorText(e) {
  if (e.kind === "Overflow") return `${hex(e.len)} bytes at ${hex(e.addr)} overflow the address space`;
  return `${hex(e.len)} bytes at ${hex(e.addr)} are not inside one RAM region`;
}

/**
 * The check as C would write it, in wrapping 64-bit arithmetic, tried against each region in
 * table order: `addr >= base && addr + len <= end`. If it passes, the VMM forms
 * `host_base + (addr - base)`, also wrapping. Returns
 * `{ pass, sum, wrapped, index?, delta?, outside?, steps }` where `delta` is the signed distance
 * of the formed pointer from that region's host base, and `outside` says whether
 * `[delta, delta + len)` leaves the host allocation `[0, size)`.
 */
export function wrappingCheck(spans, addr, len) {
  const full = addr + len;
  const sum = full & U64_MAX;
  const wrapped = full > U64_MAX;
  const steps = [
    {
      check: "addr + len (wrapping)",
      detail: wrapped ? `${hex(addr)} + ${lenText(len)} wraps to ${hex(sum)}: the 65th bit was dropped` : hex(sum),
      pass: true,
      // Not a failure (nothing refuses here), but not fine either: the view badges it "wrapped!".
      warn: wrapped,
    },
  ];
  for (const span of spans) {
    if (addr >= span.base && sum <= span.end) {
      steps.push({
        check: `addr >= base && addr + len <= end (${regionName(span)})`,
        detail: `${hex(addr)} >= ${hex(span.base)} and ${hex(sum)} <= ${hex(span.end)}`,
        pass: true,
      });
      const offset = (addr - span.base) & U64_MAX;
      // host_base + offset in 64-bit wrapping arithmetic is host_base plus offset read as a
      // signed (two's complement) number.
      const delta = offset >= TWO63 ? offset - TWO64 : offset;
      const outside = delta < 0n || delta + len > span.size;
      steps.push({
        check: "host_base + (addr - base) (wrapping)",
        detail: `offset ${hex(offset)}, pointer ${hostExpr(hostName(spans, span.index), delta)}`,
        pass: !outside,
      });
      return { pass: true, sum, wrapped, index: span.index, offset, delta, outside, steps };
    }
  }
  steps.push({
    check: "addr >= base && addr + len <= end",
    detail: "false for every region",
    pass: false,
  });
  return { pass: false, sum, wrapped, steps };
}

/**
 * Plain `+` with overflow checks on (Rust's default in debug builds, and this repository's
 * setting in release too): it panics on overflow. Otherwise it is the same comparison as the C
 * check. Because that comparison is made against each region on its own, it already refuses a
 * range that crosses from one region into the next; the only thing it still gets wrong once the
 * sum cannot wrap is len 0, which it accepts.
 */
export function panickingCheck(spans, addr, len) {
  if (addr + len > U64_MAX) {
    return {
      panic: true,
      steps: [
        {
          check: "addr + len (overflow checks on)",
          detail: "panic: attempt to add with overflow",
          pass: false,
        },
      ],
    };
  }
  const w = wrappingCheck(spans, addr, len);
  return { panic: false, ...w };
}

/**
 * A check that does the arithmetic right (checked_add, len > 0) but tests the range against RAM
 * as a whole: `lowest base <= addr && addr + len <= highest end`. It then forms the pointer from
 * the region that `addr` starts in. A range that crosses into the next region, or one that sits
 * in a hole between regions, passes, and the pointer runs past the end of one host allocation:
 * the lesson's "why checked_add alone is not enough". Same result shape as wrappingCheck.
 */
export function spanCheck(spans, addr, len) {
  const steps = [];
  const sum = addr + len;
  if (sum > U64_MAX) {
    steps.push({ check: "addr.checked_add(len)", detail: `${hex(addr)} + ${lenText(len)} needs 65 bits: None`, pass: false });
    return { pass: false, sum: null, wrapped: false, steps };
  }
  steps.push({ check: "addr.checked_add(len)", detail: `Some(${hex(sum)})`, pass: true });
  if (len === 0n) {
    steps.push({ check: "len > 0", detail: "len is 0: an empty access is refused", pass: false });
    return { pass: false, sum, wrapped: false, steps };
  }
  steps.push({ check: "len > 0", detail: `len is ${lenText(len)}`, pass: true });
  const lo = spans[0].base;
  const hi = spans[spans.length - 1].end; // sorted and non-overlapping: the last end is the highest
  const check = "lowest base <= addr && addr + len <= highest end";
  if (addr < lo || sum > hi) {
    steps.push({ check, detail: `RAM as a whole is ${hex(lo)}..${hex(hi)}; ${hex(addr)}..${hex(sum)} is not inside it`, pass: false });
    return { pass: false, sum, wrapped: false, steps };
  }
  steps.push({ check, detail: `${hex(lo)} <= ${hex(addr)} and ${hex(sum)} <= ${hex(hi)}`, pass: true });
  const index = lastAtOrBelow(spans, addr);
  const span = spans[index];
  const delta = addr - span.base;
  const outside = delta + len > span.size;
  steps.push({
    check: `host_base + (addr - base) (${regionName(span)})`,
    detail: outside
      ? `pointer ${hostExpr(hostName(spans, index), delta)}, but ${regionName(span)}'s allocation ends at ${hostExpr(hostName(spans, index), span.size)}`
      : `pointer ${hostExpr(hostName(spans, index), delta)}`,
    pass: !outside,
  });
  return { pass: true, sum, wrapped: false, index, offset: delta, delta, outside, steps };
}

// ---------------------------------------------------------------------------------------------
// The result rows (the lesson's fallback table)
// ---------------------------------------------------------------------------------------------

/**
 * What a wrong version does with an access the checked version is the judge of:
 * "crash" (the VMM panics), "leak" (a pointer is formed and the access leaves that region's host
 * allocation: a read leaks host memory, a write corrupts it), "contract" (accepted, no byte
 * outside the allocation is touched, but the checked version refuses it: len 0), or "none".
 */
export function harmOf(r, c) {
  if (r.panic) return "crash";
  if (!r.pass) return "none";
  if (r.outside) return "leak";
  if (!c.ok) return "contract";
  return "none";
}

const VERDICT = { crash: "VMM crashes", leak: '"ok"', contract: "accepted (contract broken)" };

/**
 * One row per mode, in the columns of the lesson's fallback table:
 * `mode, addr, len, sum, verdict, host`, each a string, plus `harm` (see harmOf) and `harmful`
 * (true only for a real out-of-allocation pointer, the lesson's dashed row).
 */
export function rows(spans, addr, len) {
  const out = [];
  const c = locate(spans, addr, len);
  out.push({
    mode: "checked",
    addr: hex(addr),
    len: lenText(len),
    sum: c.error && c.error.kind === "Overflow" ? "overflow (None)" : hex(addr + len),
    verdict: c.ok ? "ok" : "fault",
    host: c.ok ? hostExpr(hostName(spans, c.index), c.offset) : "none",
    harm: "none",
    harmful: false,
  });
  const wrong = (mode, r, sum) => {
    const harm = harmOf(r, c);
    out.push({
      mode,
      addr: hex(addr),
      len: lenText(len),
      sum,
      verdict: VERDICT[harm] || (r.pass ? "ok" : "fault"),
      host: !r.panic && r.pass ? hostExpr(hostName(spans, r.index), r.delta) : "none",
      harm,
      harmful: harm === "leak",
    });
  };
  const w = wrappingCheck(spans, addr, len);
  wrong("wrapping", w, w.wrapped ? `${hex(w.sum)} (wrapped)` : hex(w.sum));
  const p = panickingCheck(spans, addr, len);
  wrong("panicking", p, p.panic ? "panic" : hex(addr + len));
  const sp = spanCheck(spans, addr, len);
  wrong("span", sp, addr + len > U64_MAX ? "overflow (None)" : hex(addr + len));
  return out;
}

function plural(len) {
  return `${lenText(len)} byte${len === 1n ? "" : "s"}`;
}

/** The sentence for a wrong version's result; `label` names it, `sumNote` explains a pass. */
function wrongSummary(spans, addr, len, label, r, c, sumNote) {
  const head = `${label}: ${plural(len)} at ${hex(addr)}`;
  const harm = harmOf(r, c);
  if (harm === "crash") {
    return `${head}: addr + len overflows and the VMM panics. The guest cannot read host memory, but it can kill the VMM whenever it likes.`;
  }
  if (!r.pass) return `${head}: the check fails, fault.`;
  const span = spans[r.index];
  const name = hostName(spans, r.index);
  const ptr = hostExpr(name, r.delta);
  if (harm === "leak") {
    let where;
    if (r.delta < 0n) {
      where = `would touch ${ptr}, ${hex(-r.delta)} bytes below the start of ${regionName(span)}'s host allocation`;
    } else {
      const runs = r.delta >= span.size ? "which starts past" : "which runs past";
      where = `would copy the bytes from ${ptr} up to ${hostExpr(name, r.delta + len)}, ${runs} the end of ${regionName(span)}'s host allocation (${hostExpr(name, span.size)})`;
    }
    return `${head}: the check passes${sumNote}, and the VMM ${where}. A read would leak host memory to the guest; a write would corrupt it.`;
  }
  if (harm === "contract") {
    const inRam = spans.some((s) => addr >= s.base && addr < s.end);
    const tail = inRam
      ? "this address happens to be in RAM, but the same empty access one past the end of a region passes too"
      : `here it says yes although ${hex(addr)} is not in RAM`;
    return `${head}: the check passes and forms ${ptr}. No bytes are touched, so nothing leaks, but the checked version refuses every empty access so that "check_range says yes" always means "this address is in RAM"; ${tail}.`;
  }
  return `${head}: ok, ${ptr}. Both versions agree here.`;
}

/**
 * The plain-text summary for the readout (and the screen reader) for the selected mode.
 */
export function summary(spans, addr, len, mode) {
  const c = locate(spans, addr, len);
  if (mode === "wrapping") {
    const w = wrappingCheck(spans, addr, len);
    return wrongSummary(spans, addr, len, "Wrapping", w, c, w.wrapped ? ` because the sum wrapped to ${hex(w.sum)}` : "");
  }
  if (mode === "panicking") {
    return wrongSummary(spans, addr, len, "Panicking", panickingCheck(spans, addr, len), c, "");
  }
  if (mode === "span") {
    return wrongSummary(spans, addr, len, "Whole RAM", spanCheck(spans, addr, len), c, " because the range only has to fit inside RAM as a whole, not inside one region");
  }
  const head = `Checked: ${plural(len)} at ${hex(addr)}`;
  if (c.ok) {
    return `${head}: ok, ${regionName(spans[c.index])} at offset ${hex(c.offset)}, host address ${hostExpr(hostName(spans, c.index), c.offset)}.`;
  }
  const failed = c.steps.find((s) => !s.pass);
  return `${head}: fault (${c.error.kind}). ${failed.check} fails: ${failed.detail}.`;
}

// ---------------------------------------------------------------------------------------------
// Address strip: where things sit, for the picture
// ---------------------------------------------------------------------------------------------

/**
 * Split the IPA space into display segments: a gap, each region, gaps between them, a gap to
 * the top. Returns `[{ kind: "gap" | "region", from, to, index? }]` with `to` exclusive
 * (`to` may be 2^64 for the last gap).
 */
export function segments(spans) {
  const segs = [];
  let cur = 0n;
  for (const s of spans) {
    if (s.base > cur) segs.push({ kind: "gap", from: cur, to: s.base });
    segs.push({ kind: "region", from: s.base, to: s.end, index: s.index, row: s.row });
    cur = s.end;
  }
  if (cur < TWO64) segs.push({ kind: "gap", from: cur, to: TWO64 });
  return segs;
}

/** Which segment holds `x`, and how far into it (0..1, a Number for drawing). */
export function place(segs, x) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (x >= s.from && x < s.to) {
      const span = s.to - s.from;
      // Scale to 1/10000ths in BigInt, then to Number: exact enough for a picture.
      const frac = Number(((x - s.from) * 10000n) / span) / 10000;
      return { seg: i, frac };
    }
  }
  return { seg: segs.length - 1, frac: 1 };
}

// ---------------------------------------------------------------------------------------------
// State, presets, reducer
// ---------------------------------------------------------------------------------------------

export const MODES = ["checked", "wrapping", "panicking", "span"];

/** Region-table presets. Text, as the reader would type it. */
export const TABLE_PRESETS = [
  { id: "ram64", label: "64 MiB of RAM at 0x4000_0000 (this chapter's guest)", regions: [["0x4000_0000", "64M"]] },
  { id: "two", label: "Two adjacent regions", regions: [["0x4000_0000", "16K"], ["0x4000_4000", "16K"]] },
  { id: "gap", label: "Two regions with a hole between them", regions: [["0x4000_0000", "64M"], ["0x8000_0000", "64M"]] },
  { id: "bad-align", label: "Broken: a 4 KiB region (unaligned)", regions: [["0x4000_1000", "4K"]] },
  { id: "bad-zero", label: "Broken: a region of size 0", regions: [["0x4000_0000", "0"]] },
  { id: "bad-overlap", label: "Broken: two regions overlap", regions: [["0x4000_0000", "64M"], ["0x4200_0000", "64M"]] },
  { id: "bad-wrap", label: "Broken: base + size wraps", regions: [["0xFFFF_FFFF_FFFF_C000", "32K"]] },
  { id: "bad-ipa", label: "Broken: region above the 36-bit IPA limit", regions: [["0x10_0000_0000", "16K"]] },
];

/** Access presets. `table` names the table preset they are meant for. */
export const ACCESS_PRESETS = [
  { id: "inside", label: "8 bytes inside RAM", addr: "0x4000_1000", len: "8", table: "ram64" },
  { id: "puzzle", label: "The opening puzzle: 8 bytes at 0xFFFF_FFFF_FFFF_FFFC", addr: "0xFFFF_FFFF_FFFF_FFFC", len: "8", table: "ram64" },
  { id: "last", label: "The last byte of RAM", addr: "0x43FF_FFFF", len: "1", table: "ram64" },
  { id: "past", label: "One byte past the end", addr: "0x43FF_FFFF", len: "2", table: "ram64" },
  { id: "below", label: "Just below RAM", addr: "0x3FFF_FFFF", len: "1", table: "ram64" },
  { id: "zero", label: "Zero length", addr: "0x4000_0000", len: "0", table: "ram64" },
  { id: "zero-end", label: "Zero length, one past the end of RAM", addr: "0x4400_0000", len: "0", table: "ram64" },
  { id: "raw-wrap", label: "Chapter 03's hello guest (0x2D9A bytes) at 0xFFFF_FFFF_FFFF_FFF0", addr: "0xFFFF_FFFF_FFFF_FFF0", len: "0x2D9A", table: "ram64" },
  { id: "raw-edge", label: "The same guest at 0x43FF_FFF0, ending past RAM", addr: "0x43FF_FFF0", len: "0x2D9A", table: "ram64" },
  { id: "cross", label: "8 bytes across two adjacent regions (compare Checked with Whole RAM)", addr: "0x4000_3FFC", len: "8", table: "two" },
  { id: "hole", label: "8 bytes in the hole between two regions", addr: "0x6000_0000", len: "8", table: "gap" },
];

export function initialState() {
  return {
    regions: TABLE_PRESETS[0].regions.map(([base, size]) => ({ base, size })),
    ipaBits: String(DEFAULT_IPA_BITS),
    addr: "0xFFFF_FFFF_FFFF_FFFC",
    len: "8",
    mode: "wrapping",
  };
}

/** next = step(state, action). Never mutates `state`. Unknown actions return `state`. */
export function step(state, action) {
  switch (action.type) {
    case "reset":
      return initialState();
    case "setMode":
      return MODES.includes(action.mode) ? { ...state, mode: action.mode } : state;
    case "setAddr":
      return { ...state, addr: String(action.value).slice(0, MAX_INPUT_CHARS) };
    case "setLen":
      return { ...state, len: String(action.value).slice(0, MAX_INPUT_CHARS) };
    case "setIpaBits":
      return { ...state, ipaBits: String(action.value).slice(0, 4) };
    case "setRegion": {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.regions.length) return state;
      if (action.field !== "base" && action.field !== "size") return state;
      const regions = state.regions.map((r, i) =>
        i === action.index ? { ...r, [action.field]: String(action.value).slice(0, MAX_INPUT_CHARS) } : r,
      );
      return { ...state, regions };
    }
    case "addRegion": {
      if (state.regions.length >= MAX_REGIONS) return state;
      // Propose the next aligned 16 KiB after the highest valid end, so the table stays valid.
      let next = 0x4000_0000n;
      for (const r of state.regions) {
        const b = parseU64(r.base);
        const s = parseU64(r.size);
        if (b.ok && s.ok && b.value + s.value > next && b.value + s.value <= U64_MAX) next = b.value + s.value;
      }
      const base = ((next + REGION_ALIGN - 1n) / REGION_ALIGN) * REGION_ALIGN;
      return { ...state, regions: [...state.regions, { base: hex(base), size: "16K" }] };
    }
    case "removeRegion": {
      if (state.regions.length <= 1) return state;
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.regions.length) return state;
      return { ...state, regions: state.regions.filter((_, i) => i !== action.index) };
    }
    case "tablePreset": {
      const p = TABLE_PRESETS.find((t) => t.id === action.id);
      if (!p) return state;
      return { ...state, regions: p.regions.map(([base, size]) => ({ base, size })) };
    }
    case "accessPreset": {
      const p = ACCESS_PRESETS.find((a) => a.id === action.id);
      if (!p) return state;
      const t = TABLE_PRESETS.find((x) => x.id === p.table);
      return {
        ...state,
        regions: t.regions.map(([base, size]) => ({ base, size })),
        ipaBits: String(DEFAULT_IPA_BITS),
        addr: p.addr,
        len: p.len,
      };
    }
    default:
      return state;
  }
}

/**
 * Everything the view draws, derived from `state`. Input errors are reported per field.
 * `{ fieldErrors, table, addr, len, result }`; `result` is null until the table and the access
 * are both valid.
 */
export function evaluate(state) {
  const fieldErrors = {};
  const regions = [];
  state.regions.forEach((r, i) => {
    const b = parseU64(r.base);
    const s = parseU64(r.size);
    if (!b.ok) fieldErrors[`base${i}`] = b.error;
    if (!s.ok) fieldErrors[`size${i}`] = s.error;
    regions.push({ base: b.ok ? b.value : null, size: s.ok ? s.value : null });
  });
  const bitsText = String(state.ipaBits).trim();
  const ipaBits = /^[0-9]{1,3}$/.test(bitsText) ? Number(bitsText) : NaN;
  if (Number.isNaN(ipaBits)) fieldErrors.ipaBits = "a whole number of bits";
  const a = parseU64(state.addr);
  const l = parseU64(state.len);
  if (!a.ok) fieldErrors.addr = a.error;
  if (!l.ok) fieldErrors.len = l.error;

  let table = null;
  const regionFieldsOk = regions.every((r) => r.base !== null && r.size !== null);
  if (regionFieldsOk && !Number.isNaN(ipaBits)) table = buildTable(regions, ipaBits);

  let result = null;
  if (table && table.ok && a.ok && l.ok) {
    const spans = table.spans;
    result = {
      rows: rows(spans, a.value, l.value),
      checked: locate(spans, a.value, l.value),
      wrapping: wrappingCheck(spans, a.value, l.value),
      panicking: panickingCheck(spans, a.value, l.value),
      span: spanCheck(spans, a.value, l.value),
      summary: summary(spans, a.value, l.value, state.mode),
      segments: segments(spans),
    };
  }
  return {
    fieldErrors,
    table,
    addr: a.ok ? a.value : null,
    len: l.ok ? l.value : null,
    result,
  };
}

// ---------------------------------------------------------------------------------------------
// Share state: `w.40000000:4000000.fffffffffffffffc.8.36`
// mode letter (c, w, p, s for whole RAM) . regions (base:size, comma separated, hex) . addr hex . len hex . ipa bits
// ---------------------------------------------------------------------------------------------

const MODE_LETTER = { checked: "c", wrapping: "w", panicking: "p", span: "s" };

/** Encode `state` for the URL, or null if any field is not a valid number yet. */
export function encodeHash(state) {
  const parts = [];
  for (const r of state.regions) {
    const b = parseU64(r.base);
    const s = parseU64(r.size);
    if (!b.ok || !s.ok) return null;
    parts.push(`${b.value.toString(16)}:${s.value.toString(16)}`);
  }
  const a = parseU64(state.addr);
  const l = parseU64(state.len);
  const bits = String(state.ipaBits).trim();
  if (!a.ok || !l.ok || !/^[0-9]{1,2}$/.test(bits)) return null;
  return [MODE_LETTER[state.mode] || "c", parts.join(","), a.value.toString(16), l.value.toString(16), bits].join(".");
}

/** Decode a share string into a state, or null if it is malformed in any way. */
export function decodeHash(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > MAX_HASH_CHARS) return null;
  if (!/^[cwps]\.[0-9a-f:,]+\.[0-9a-f]{1,16}\.[0-9a-f]{1,16}\.[0-9]{1,2}$/i.test(str)) return null;
  const [m, regs, addr, len, bits] = str.split(".");
  const mode = Object.keys(MODE_LETTER).find((k) => MODE_LETTER[k] === m.toLowerCase());
  const pairs = regs.split(",");
  if (pairs.length === 0 || pairs.length > MAX_REGIONS) return null;
  const regions = [];
  for (const p of pairs) {
    const mt = /^([0-9a-f]{1,16}):([0-9a-f]{1,16})$/i.exec(p);
    if (!mt) return null;
    regions.push({ base: hex(BigInt("0x" + mt[1])), size: hex(BigInt("0x" + mt[2])) });
  }
  return {
    regions,
    ipaBits: bits,
    addr: hex(BigInt("0x" + addr)),
    len: lenText(BigInt("0x" + len)),
    mode,
  };
}
