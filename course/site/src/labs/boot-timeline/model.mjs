// boot-timeline: the model. Pure logic, no DOM, no I/O at import time (course/site/LABS.md
// section 3), so `node --test` imports it and the browser imports the same file.
//
// What it does. macvmm's `--trace exits:FILE` writes one JSON object per VM exit (the record
// format is documented at the top of crates/vmm/src/trace.rs and in course/checkpoints/TRACE.md).
// This module parses such a file as hostile input, classifies every exit by what the guest
// touched (the memory map mirrors VIRT_REGIONS in crates/vmm/src/arch/layout.rs), rebuilds the
// console text from the PL011 data-register writes, finds the boot-log milestones of chapter 14's
// stage table, the long silences and the way the run ended, and lays it all out on a time axis
// that can zoom and squeeze long silences. The view only renders what these functions return.
//
// The four shipped traces are real runs (traces/*.json, packed losslessly by
// course/site/tools/pack-boot-trace.mjs; model.test.mjs re-expands them and checks the sha256 of
// the original file).

export const FORMAT = "macvmm-boot-timeline/1";

/** Caps for a dropped file (LABS.md section 4: hostile input, capped sizes). */
export const LIMITS = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxRecords: 250_000,
  maxLineLen: 4096,
  maxErrors: 20,
  maxConsoleLines: 20_000,
  maxLineChars: 300,
});

/** `MAX_CPUS` in crates/vmm/src/arch/layout.rs: the most vCPUs the virt board describes. */
export const MAX_CPUS = 64;

/** The shipped traces, in menu order. */
export const TRACE_IDS = ["healthy", "notimer", "gicr", "noid"];

// --- the machine's memory map (VIRT_REGIONS, crates/vmm/src/arch/layout.rs) -----------------

export const RAM_BASE = 0x4000_0000;
export const PL011_BASE = 0x0900_0000;
export const PL031_BASE = 0x0901_0000;
export const VIRTIO_MMIO_STRIDE = 0x200;
/** The GIC's window as chapter 14 greps for it: 0x0800_0000 to 0x08FF_FFFF. */
export const GIC_WINDOW = [0x0800_0000, 0x0900_0000];

export const REGIONS = Object.freeze([
  ["flash0", 0x0000_0000, 0x0400_0000],
  ["flash1", 0x0400_0000, 0x0400_0000],
  ["gicd", 0x0800_0000, 0x0001_0000],
  ["gicv2-cpu", 0x0801_0000, 0x0001_0000],
  ["gic-v2m", 0x0802_0000, 0x0001_0000],
  ["gic-its", 0x0808_0000, 0x0002_0000],
  ["gicr", 0x080A_0000, 0x00F6_0000],
  ["pl011", PL011_BASE, 0x1000],
  ["pl031", PL031_BASE, 0x1000],
  ["fw-cfg", 0x0902_0000, 0x18],
  ["pl061", 0x0903_0000, 0x1000],
  ["virtio-mmio", 0x0a00_0000, 0x4000],
  ["testdev", 0x0b00_0000, 0x1000],
  ["probe-hole", 0x0c00_0000, 0x0200_0000],
  ["pcie-mmio", 0x1000_0000, 0x2eff_0000],
  ["pcie-pio", 0x3eff_0000, 0x0001_0000],
  ["pcie-ecam", 0x3f00_0000, 0x0100_0000],
]);

// --- exit kinds ------------------------------------------------------------------------------

/** Filter groups (the "show exits" checkboxes), with their share-state letter. */
export const GROUPS = Object.freeze([
  ["m", "Data aborts (MMIO)"],
  ["h", "HVC and SMC calls"],
  ["s", "System registers"],
  ["w", "WFI and WFE"],
  ["t", "VTIMER"],
  ["c", "Canceled"],
  ["o", "Other"],
]);

/**
 * Every exit gets exactly one kind. `lane` is the device lane an MMIO kind is drawn in;
 * `glyph` marks rare exits on the vCPU lane (never colour alone, LABS.md section 5).
 */
export const KINDS = Object.freeze([
  { id: "uart-tx", group: "m", lane: "pl011", label: "PL011 data register write: one console byte" },
  { id: "uart-rx", group: "m", lane: "pl011", label: "PL011 data register read: one byte in" },
  { id: "uart-fr", group: "m", lane: "pl011", label: "PL011 flag register read" },
  { id: "uart-id", group: "m", lane: "pl011", label: "PL011 identification registers" },
  { id: "uart-reg", group: "m", lane: "pl011", label: "PL011, other registers" },
  { id: "rtc-id", group: "m", lane: "pl031", label: "PL031 identification registers" },
  { id: "rtc", group: "m", lane: "pl031", label: "PL031 clock, other registers" },
  { id: "gic", group: "m", lane: "gic", label: "GIC window (0x0800_0000 to 0x08FF_FFFF)" },
  { id: "virtio", group: "m", lane: "virtio", label: "virtio-mmio slots" },
  { id: "testdev", group: "m", lane: "testdev", label: "test device" },
  { id: "flash", group: "m", lane: "other", label: "flash" },
  { id: "mmio-other", group: "m", lane: "other", label: "other guest-physical addresses" },
  { id: "psci", group: "h", glyph: "P", label: "PSCI call" },
  { id: "smccc", group: "h", glyph: "S", label: "other SMCCC call" },
  { id: "hvc", group: "h", glyph: "H", label: "HVC or SMC with no SMCCC name" },
  { id: "sysreg", group: "s", glyph: "R", label: "trapped system register" },
  { id: "wfx", group: "w", glyph: "W", label: "WFI or WFE" },
  { id: "vtimer", group: "t", glyph: "T", label: "VTIMER activated" },
  { id: "canceled", group: "c", glyph: "C", label: "canceled (the VMM kicked the vCPU out: a stop, a timeout or quit, or the no-GIC timer delivery)" },
  { id: "other", group: "o", glyph: "?", label: "other exit" },
]);
export const KIND_INDEX = Object.freeze(Object.fromEntries(KINDS.map((k, i) => [k.id, i])));

/** Device lanes, in drawing order; a lane is drawn only when the trace touches it. */
export const DEVICE_LANES = Object.freeze([
  ["pl011", "PL011 UART"],
  ["pl031", "PL031 RTC"],
  ["gic", "GIC window"],
  ["virtio", "virtio-mmio"],
  ["testdev", "Test device"],
  ["other", "Other MMIO"],
]);

// --- the record format (crates/vmm/src/trace.rs) ----------------------------------------------

/** `write_json`'s field order. */
export const FIELD_ORDER = Object.freeze([
  "t_ns", "vcpu", "reason", "ec", "pc", "ipa", "wnr", "size", "reg", "value", "imm",
  "sysreg", "sysreg_enc", "fn", "action", "isv", "boot",
]);
const TRUNC_ORDER = ["t_ns", "action", "max", "written"];
export const REASONS = Object.freeze(["exception", "canceled", "vtimer", "unknown"]);
export const ACTIONS = Object.freeze([
  "mmio", "psci", "smccc", "sysreg", "inject_undef", "inject_abort", "skip", "stop",
]);
const HEX = /^0x[0-9a-f]{1,16}$/;
const NAME = /^[A-Za-z0-9_]{1,48}$/;

function isU(n, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(n) && n >= 0 && n <= max;
}

/**
 * Validate one parsed JSON value as a trace record. Returns `{ rec }`, `{ truncated }` or
 * `{ error }`. Unknown keys are ignored (a newer macvmm may add fields); every known key is
 * checked for type and range, and names must be plain identifiers, so nothing the view later
 * shows can carry markup or terminal escapes.
 */
export function validateRaw(o) {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return { error: "not a JSON object" };
  if (o.action === "trace_truncated") {
    if (!isU(o.t_ns)) return { error: "t_ns is not a whole number of nanoseconds" };
    return { truncated: { t: o.t_ns, max: isU(o.max) ? o.max : null, written: isU(o.written) ? o.written : null } };
  }
  if (!isU(o.t_ns)) return { error: "t_ns is not a whole number of nanoseconds" };
  if (!isU(o.vcpu, MAX_CPUS - 1)) return { error: `vcpu is not 0 to ${MAX_CPUS - 1}` };
  if (!REASONS.includes(o.reason)) return { error: "reason is not exception, canceled, vtimer or unknown" };
  for (const k of ["ec", "pc", "ipa", "value", "sysreg_enc"]) {
    if (o[k] !== undefined && !(typeof o[k] === "string" && HEX.test(o[k]))) return { error: `${k} is not a lower-case 0x hex string` };
  }
  const ec = o.ec === undefined ? null : parseInt(o.ec, 16);
  if (ec !== null && ec > 0x3f) return { error: "ec is wider than 6 bits" };
  for (const k of ["wnr", "isv"]) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") return { error: `${k} is not true or false` };
  }
  if (o.size !== undefined && ![1, 2, 4, 8].includes(o.size)) return { error: "size is not 1, 2, 4 or 8" };
  if (o.reg !== undefined && !isU(o.reg, 31)) return { error: "reg is not 0 to 31" };
  if (o.imm !== undefined && !isU(o.imm, 0xffff)) return { error: "imm is not 0 to 0xffff" };
  for (const k of ["sysreg", "fn"]) {
    if (o[k] !== undefined && !(typeof o[k] === "string" && NAME.test(o[k]))) return { error: `${k} is not a plain name` };
  }
  if (o.action !== undefined && !ACTIONS.includes(o.action)) return { error: "action is not one macvmm writes" };
  if (o.boot !== undefined && !(isU(o.boot) && o.boot >= 1)) return { error: "boot is not a whole number from 1" };
  const ipaN = o.ipa !== undefined && o.ipa.length <= 15 ? parseInt(o.ipa, 16) : null;
  const rec = {
    t: o.t_ns, vcpu: o.vcpu, reason: o.reason, ec,
    pc: o.pc ?? null, ipa: o.ipa ?? null, ipaN,
    wnr: o.wnr ?? null, size: o.size ?? null, reg: o.reg ?? null, value: o.value ?? null,
    imm: o.imm ?? null, sysreg: o.sysreg ?? null, sysregEnc: o.sysreg_enc ?? null,
    fn: o.fn ?? null, action: o.action ?? null, isv: o.isv ?? null, boot: o.boot ?? 0,
    kind: 0,
  };
  rec.kind = classify(rec);
  return { rec };
}

/** Which kind (index into KINDS) an exit is. */
export function classify(r) {
  if (r.reason === "canceled") return KIND_INDEX.canceled;
  if (r.reason === "vtimer") return KIND_INDEX.vtimer;
  if (r.reason !== "exception") return KIND_INDEX.other;
  if (r.action === "psci") return KIND_INDEX.psci;
  if (r.action === "smccc") return KIND_INDEX.smccc;
  switch (r.ec) {
    case 0x01: return KIND_INDEX.wfx;
    case 0x16: case 0x17: return KIND_INDEX.hvc;
    case 0x18: return KIND_INDEX.sysreg;
    case 0x24: return classifyAddress(r.ipaN, r.wnr === true);
    default: return KIND_INDEX.other;
  }
}

/** The region a guest-physical address falls in, or null. */
export function regionOf(addr) {
  if (addr === null || !Number.isFinite(addr)) return null;
  for (const [name, base, size] of REGIONS) if (addr >= base && addr < base + size) return name;
  return addr >= RAM_BASE ? "ram" : null;
}

function classifyAddress(ipa, write) {
  if (ipa === null) return KIND_INDEX["mmio-other"];
  if (ipa >= PL011_BASE && ipa < PL011_BASE + 0x1000) {
    const off = ipa - PL011_BASE;
    if (off === 0) return write ? KIND_INDEX["uart-tx"] : KIND_INDEX["uart-rx"];
    if (off === 0x18 && !write) return KIND_INDEX["uart-fr"];
    if (off >= 0xfe0) return KIND_INDEX["uart-id"];
    return KIND_INDEX["uart-reg"];
  }
  if (ipa >= PL031_BASE && ipa < PL031_BASE + 0x1000) {
    return ipa - PL031_BASE >= 0xfe0 ? KIND_INDEX["rtc-id"] : KIND_INDEX.rtc;
  }
  if (ipa >= GIC_WINDOW[0] && ipa < GIC_WINDOW[1]) return KIND_INDEX.gic;
  const region = regionOf(ipa);
  if (region === "virtio-mmio") return KIND_INDEX.virtio;
  if (region === "testdev") return KIND_INDEX.testdev;
  if (region === "flash0" || region === "flash1") return KIND_INDEX.flash;
  return KIND_INDEX["mmio-other"];
}

// --- parsing -----------------------------------------------------------------------------------

/** The header line of a ring dump (`Ctrl-A t`, SIGUSR1, or a fatal stop): `vcpu0: last 256 exits, oldest first:`. */
const RING_HEADER = /^vcpu\d+: last \d+ exits\b/;

/**
 * Parse a JSON Lines trace. Lines that do not start with `{` are skipped and counted (so a
 * capture with `#` header lines, or a ring dump, still loads); a bad record is reported with its
 * line number and skipped. Records are sorted by boot, then time (a stable sort: several vCPUs
 * share one writer, so neighbouring stamps can be out of order by a few microseconds).
 *
 * A ring dump holds only the last exits of each vCPU, not a whole run, and pressing `Ctrl-A t`
 * twice prints overlapping windows. So exact duplicate records are dropped, and the result's
 * `partial` says why the file is a window (a dump header was seen, or records repeated); the
 * analysis then does not read a start, missing milestones or an ending out of it.
 */
export function parseTrace(text, limits = LIMITS) {
  if (typeof text !== "string") return { ok: false, message: "No text to read." };
  if (text.length > limits.maxBytes) {
    return { ok: false, message: `The file is larger than ${fmtBytes(limits.maxBytes)}; this lab reads at most that much.` };
  }
  const raws = [];
  const errors = [];
  let errorCount = 0;
  let skipped = 0;
  let ringHeaders = 0;
  let tooMany = false;
  let lineNo = 0;
  let pos = 0;
  while (pos < text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).trim();
    pos = nl + 1;
    lineNo++;
    if (!line) continue;
    if (line[0] !== "{") { skipped++; if (RING_HEADER.test(line)) ringHeaders++; continue; }
    const bad = (message) => { errorCount++; if (errors.length < limits.maxErrors) errors.push({ line: lineNo, message }); };
    if (line.length > limits.maxLineLen) { bad(`longer than ${limits.maxLineLen} characters`); continue; }
    let obj;
    try { obj = JSON.parse(line); } catch { bad("not valid JSON"); continue; }
    if (raws.length >= limits.maxRecords) { tooMany = true; break; }
    raws.push({ obj, line: lineNo });
  }
  return ingest(raws, { errors, errorCount, skipped, ringHeaders, tooMany, limits });
}

function ingest(raws, { errors = [], errorCount = 0, skipped = 0, ringHeaders = 0, tooMany = false, limits = LIMITS } = {}) {
  const records = [];
  const seen = new Set();
  let duplicates = 0;
  let truncated = null;
  for (const { obj, line } of raws) {
    const v = validateRaw(obj);
    if (v.error) {
      errorCount++;
      if (errors.length < limits.maxErrors) errors.push({ line, message: v.error });
      continue;
    }
    if (v.truncated) { if (!truncated) truncated = v.truncated; continue; }
    const key = recordLine(v.rec);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    v.rec.line = line;
    records.push(v.rec);
  }
  errors.sort((a, b) => a.line - b.line);
  const order = records.map((r, i) => i);
  order.sort((a, b) => (records[a].boot - records[b].boot) || (records[a].t - records[b].t) || (a - b));
  const sorted = order.map((i) => records[i]);
  if (!sorted.length) {
    const why = errorCount ? `${errorCount} line${errorCount === 1 ? "" : "s"} could not be read as exit records` : "it holds no exit records";
    return { ok: false, message: `This does not look like a macvmm exit trace: ${why}.`, errors, errorCount, skipped };
  }
  const partial = ringHeaders ? "dump" : duplicates ? "duplicates" : null;
  return { ok: true, records: sorted, errors, errorCount, skipped, truncated, tooMany, duplicates, partial };
}

// --- packing (lossless; used by tools/pack-boot-trace.mjs and the shipped traces) ---------------

/** Serialize a raw record object in `write_json`'s field order, as macvmm writes the line. */
export function toJsonLine(o) {
  const order = o.action === "trace_truncated" ? TRUNC_ORDER : FIELD_ORDER;
  const parts = [];
  for (const k of order) if (o[k] !== undefined) parts.push(`${JSON.stringify(k)}:${JSON.stringify(o[k])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Pack a JSONL trace: distinct records-without-time-and-value ("shapes"), distinct values, and
 * one (time step, shape, value) triple per record. Refuses a trace that does not round-trip.
 */
export function packTrace(text, { id, meta }) {
  const lines = text.split("\n").filter((l) => l.length);
  const shapes = [], shapeIdx = new Map(), values = [], valueIdx = new Map(), rows = [];
  let prev = 0;
  for (const line of lines) {
    const o = JSON.parse(line);
    if (toJsonLine(o) !== line) throw new Error(`line does not round-trip: ${line.slice(0, 80)}`);
    const v = validateRaw(o);
    if (v.error) throw new Error(`${v.error}: ${line.slice(0, 80)}`);
    const { t_ns, value, ...rest } = o;
    const sk = JSON.stringify(rest);
    if (!shapeIdx.has(sk)) { shapeIdx.set(sk, shapes.length); shapes.push(rest); }
    let vi = 0;
    if (value !== undefined) {
      if (!valueIdx.has(value)) { valueIdx.set(value, values.length); values.push(value); }
      vi = valueIdx.get(value) + 1;
    }
    if (t_ns < prev) throw new Error("records are not in time order");
    rows.push(t_ns - prev, shapeIdx.get(sk), vi);
    prev = t_ns;
  }
  return { format: FORMAT, id, meta, shapes, values, rows };
}

/** Expand a pack back to raw record objects, validating its structure. */
export function unpackRaw(p, limits = LIMITS) {
  if (!p || typeof p !== "object" || p.format !== FORMAT) throw new Error("not a boot-timeline trace pack");
  const { shapes, values, rows } = p;
  if (!Array.isArray(shapes) || !Array.isArray(values) || !Array.isArray(rows)) throw new Error("pack: missing arrays");
  if (rows.length % 3 !== 0 || rows.length / 3 > limits.maxRecords) throw new Error("pack: bad row count");
  const out = [];
  let t = 0;
  for (let i = 0; i < rows.length; i += 3) {
    const dt = rows[i], s = rows[i + 1], v = rows[i + 2];
    if (!isU(dt) || !isU(s, shapes.length - 1) || !isU(v, values.length)) throw new Error(`pack: bad row ${i / 3}`);
    t += dt;
    if (!Number.isSafeInteger(t)) throw new Error("pack: time overflows");
    const shape = shapes[s];
    if (!shape || typeof shape !== "object") throw new Error("pack: bad shape");
    const o = { t_ns: t, ...shape };
    if (v) o.value = values[v - 1];
    out.push(o);
  }
  return out;
}

/** The pack as the JSONL text macvmm wrote (for the provenance check). */
export function unpackToJsonl(p) {
  return unpackRaw(p).map((o) => toJsonLine(o) + "\n").join("");
}

/** Load a pack into records, through the same validation as a dropped file. */
export function loadPack(p) {
  return ingest(unpackRaw(p).map((obj, i) => ({ obj, line: i + 1 })));
}

// --- boot-log milestones (chapter 14's stage table; the linux-boot-sequence primer) -------------

export const STAGES = Object.freeze({
  1: "entry", 2: "first device-tree read", 3: "interrupts", 4: "time",
  5: "first process", 6: "drivers bind", 7: "initramfs", 8: "user space",
});

/** The closing line of a panic report, `---[ end Kernel panic - not syncing: ... ]---`. */
const PANIC_END = /---\[ end Kernel panic/;

/** Lines that show a stage was reached. `need` marks the line a healthy boot must print. */
export const MILESTONES = Object.freeze([
  { re: /Booting Linux on physical CPU/, stage: 1, label: "Booting Linux", need: true },
  { re: /Machine model: /, stage: 2, label: "Machine model", need: true },
  { re: /earlycon: \S+ at MMIO/, stage: 2, label: "earlycon" },
  { re: /psci: PSCIv\d/, stage: 2, label: "PSCI detected" },
  { re: /Kernel command line: /, stage: 2, label: "Kernel command line" },
  { re: /GICv3: CPU\d+: found redistributor/, stage: 3, label: "GIC redistributor found", need: true },
  { re: /arch_timer: cp15 timer running at/, stage: 4, label: "Timer running", need: true },
  { re: /smp: Brought up/, stage: 5, label: "CPUs brought up", need: true },
  { re: /CPU\d+: Booted secondary processor/, stage: 5, label: "Secondary CPU booted" },
  { re: /ttyAMA0 at MMIO/, stage: 6, label: "PL011 driver bound (ttyAMA0)", need: true },
  { re: /printk: console \[ttyAMA0\] enabled/, stage: 6, label: "Console on ttyAMA0" },
  { re: /rtc-pl031 \S+: registered as rtc0/, stage: 6, label: "PL031 driver bound (rtc0)", need: true },
  { re: /Freeing initrd memory/, stage: 7, label: "initramfs unpacked", need: true },
  { re: /VFS: Mounted root/, stage: 8, label: "Root file system mounted" },
  { re: /Run \/init as init process/, stage: 8, label: "Run /init", need: true },
  { re: /macvmm-initramfs: ready/, stage: 8, label: "/init printed its ready line", need: true },
  { re: PANIC_END, stage: null, label: "End of the panic report" },
  { re: /reboot: Power down/, stage: null, label: "Power down" },
  { re: /reboot: Restarting system/, stage: null, label: "Restarting" },
]);

/** Lines that report a failure, with the stage the failure belongs to when it is known. */
export const FAILURES = Object.freeze([
  { re: /timer_probe: no matching timers found/, stage: 4, label: "no matching timers found" },
  { re: /Unable to initialise architected timer/, stage: 4, label: "Unable to initialise architected timer" },
  { re: /GICv3: No redistributor present/, stage: 3, label: "No redistributor present" },
  { re: /unable to open an initial console/, stage: 8, label: "unable to open an initial console" },
  { re: /\bWARNING: CPU: \d+/, stage: null, label: "WARNING" },
  { re: /Internal error: Oops/, stage: null, label: "Oops" },
  { re: /Kernel panic - not syncing/, stage: null, label: "panic" },
]);

// --- analysis ----------------------------------------------------------------------------------

/** The boot generations present (0 = the first boot; macvmm writes `boot` only from 1). */
export function bootsOf(records) {
  return [...new Set(records.map((r) => r.boot))].sort((a, b) => a - b);
}

/** Printable form of one console byte stream: \r dropped, tabs kept, other controls escaped. */
function consoleLines(recs, limits) {
  const lines = [];
  let cur = null;
  let dropped = 0;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.kind !== KIND_INDEX["uart-tx"] || r.value === null) continue;
    const b = parseInt(r.value.length > 4 ? r.value.slice(-2) : r.value, 16) & 0xff;
    if (b === 0x0d) continue;
    if (!cur) cur = { t0: r.t, t1: r.t, text: "", more: 0, rec: i, vcpu: r.vcpu };
    cur.t1 = r.t;
    if (b === 0x0a) {
      if (lines.length < limits.maxConsoleLines) lines.push(cur); else dropped++;
      cur = null;
      continue;
    }
    let ch;
    if (b === 0x09) ch = "\t";
    else if (b < 0x20 || b >= 0x7f) ch = `\\x${b.toString(16).padStart(2, "0")}`;
    else ch = String.fromCharCode(b);
    if (cur.text.length < limits.maxLineChars) cur.text += ch; else cur.more++;
  }
  if (cur) { cur.partial = true; if (lines.length < limits.maxConsoleLines) lines.push(cur); else dropped++; }
  return { lines, dropped };
}

const STATS_KINDS = ["canceled", "vtimer", "wfx", "hvc", "smc", "sysreg", "instruction abort", "data abort", "brk", "unknown"];

/** Which of macvmm's `--stats` kinds (crates/vmm/src/stats.rs, KINDS) an exit counts as. */
export function statsKind(r) {
  if (r.reason === "canceled") return "canceled";
  if (r.reason === "vtimer") return "vtimer";
  if (r.reason !== "exception") return "unknown";
  switch (r.ec) {
    case 0x01: return "wfx";
    case 0x16: return "hvc";
    case 0x17: return "smc";
    case 0x18: return "sysreg";
    case 0x20: return "instruction abort";
    case 0x24: return "data abort";
    case 0x3c: return "brk";
    default: return "unknown";
  }
}

/** The `vcpuN exits: ...` line `--stats` prints, rebuilt from the trace (BootStats::report). */
export function statsLine(vcpu, counts) {
  const total = STATS_KINDS.reduce((s, k) => s + (counts[k] || 0), 0);
  let s = `total ${total}`;
  let sep = ": ";
  for (const k of STATS_KINDS) if (counts[k]) { s += `${sep}${k} ${counts[k]}`; sep = ", "; }
  return `vcpu${vcpu} exits: vtimer ${counts.vtimer || 0}, wfx ${counts.wfx || 0}, ${s}`;
}

const MAX_LISTED_CALLS = 200;
const MAX_LISTED_CANCELS = 50;
const TOP_GAPS = 3;
const MIN_GAP_NS = 1_000_000;
/** A whole trace starts within milliseconds of the machine being built; later means a window. */
const LATE_START_NS = 1_000_000_000;

/**
 * Everything the view shows about one boot of a trace. `records` must be sorted (parseTrace
 * and loadPack sort them).
 */
export function analyze(allRecords, { boot = null, truncated = null, partial = null, limits = LIMITS } = {}) {
  const boots = bootsOf(allRecords);
  const b = boot !== null && boots.includes(boot) ? boot : boots[0];
  const recs = allRecords.filter((r) => r.boot === b);
  const n = recs.length;
  const tEnd = n ? recs[n - 1].t : 0;
  const kindCounts = new Array(KINDS.length).fill(0);
  const vcpuSet = new Set();
  const perVcpuStats = new Map();
  for (const r of recs) {
    kindCounts[r.kind]++;
    vcpuSet.add(r.vcpu);
    let c = perVcpuStats.get(r.vcpu);
    if (!c) { c = {}; perVcpuStats.set(r.vcpu, c); }
    const k = statsKind(r);
    c[k] = (c[k] || 0) + 1;
  }
  const vcpus = [...vcpuSet].sort((a, b2) => a - b2);
  const statsLines = vcpus.map((v) => statsLine(v, perVcpuStats.get(v)));

  // Console text, milestones and failures.
  const { lines, dropped } = consoleLines(recs, limits);
  const milestones = [], failures = [];
  lines.forEach((ln, i) => {
    const m = MILESTONES.find((x) => x.re.test(ln.text));
    // The kernel prints some lines twice with the same text (`printk: console [ttyAMA0]
    // enabled` goes to the boot console and then to ttyAMA0): one moment is enough. Lines with
    // the same label but different text (CPU1 and CPU2 booted) all stay.
    if (m && !milestones.some((x) => x.label === m.label && lines[x.line].text === ln.text)) {
      milestones.push({ ...strip(m), t: ln.t0, line: i, again: milestones.some((x) => x.label === m.label) });
    }
    // The panic report's closing line repeats its first line; it is a milestone, not a second
    // failure. One panic line can say two things ("Kernel panic - not syncing: Unable to
    // initialise architected timer."), so a line keeps every failure it matches.
    if (PANIC_END.test(ln.text)) return;
    const hits = FAILURES.filter((f) => f.re.test(ln.text));
    if (hits.length) {
      const stage = Math.max(0, ...hits.map((f) => f.stage || 0)) || null;
      const key = hits.map((f) => f.label).join(", ");
      failures.push({ label: hits[0].label, labels: hits.map((f) => f.label), stage, t: ln.t0, line: i, again: failures.some((f) => f.labels.join(", ") === key) });
    }
  });

  const window = partial || (n && recs[0].t >= LATE_START_NS ? "late" : null);

  // Silences: the start (machine built, t = 0) to the first exit, then every gap between exits.
  const gaps = [];
  if (n && !window) gaps.push({ t0: 0, t1: recs[0].t, after: -1, before: 0 });
  for (let i = 1; i < n; i++) {
    const d = recs[i].t - recs[i - 1].t;
    if (d >= MIN_GAP_NS) gaps.push({ t0: recs[i - 1].t, t1: recs[i].t, after: i - 1, before: i });
  }
  for (const g of gaps) {
    g.dur = g.t1 - g.t0;
    g.lastLine = lastLineBefore(lines, g.t0);
    g.then = whatFollows(recs, lines, milestones, g);
  }
  const topGaps = gaps.filter((g) => g.after >= 0).sort((x, y) => y.dur - x.dur).slice(0, TOP_GAPS);

  const idReads = { pl011: kindCounts[KIND_INDEX["uart-id"]], pl031: kindCounts[KIND_INDEX["rtc-id"]] };
  const A = {
    boot: b, boots, records: recs, count: n, tEnd, vcpus, kindCounts, statsLines,
    console: { lines, dropped, bytes: kindCounts[KIND_INDEX["uart-tx"]] },
    milestones, failures, gaps, topGaps, idReads, truncated, window,
    noMmio: n > 0 && groupCount(kindCounts, "m") === 0,
    lanes: lanesOf(vcpus, kindCounts),
  };
  A.fingerprint = fingerprint(A);
  A.events = buildEvents(A);
  return A;
}

function strip(m) { const { re, ...rest } = m; return rest; }

function groupCount(kindCounts, g) {
  return kindCounts.reduce((sum, c, i) => sum + (KINDS[i].group === g ? c : 0), 0);
}

/**
 * What ends a silence: a canceled exit (the VMM kicked the vCPU: the run was stopped from
 * outside), a milestone line that starts within 1 ms, or simply more exits. A long silence alone
 * is not a hang; a silence that ends in a kick is.
 */
function whatFollows(recs, lines, milestones, g) {
  const next = recs[g.before];
  if (!next) return { how: "end", text: "the end of the trace" };
  if (next.kind === KIND_INDEX.canceled) return { how: "cancel", text: "a canceled exit (the VMM stopped the run)" };
  const li = lines.findIndex((l) => l.t0 >= g.t1);
  if (li >= 0 && lines[li].t0 - g.t1 <= 1_000_000) {
    const m = milestones.find((x) => x.line === li);
    if (m) return { how: "milestone", line: li, text: m.stage ? `stage ${m.stage}, ${m.label}` : m.label };
    return { how: "line", line: li, text: "more console output" };
  }
  return { how: "exits", text: `more exits (${KINDS[next.kind].label})` };
}

function lastLineBefore(lines, t) {
  let lo = 0, hi = lines.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t0 <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function lanesOf(vcpus, kindCounts) {
  const lanes = vcpus.map((v) => ({ id: `vcpu${v}`, label: `vCPU ${v}`, type: "vcpu", vcpu: v }));
  const used = new Set(KINDS.map((k, i) => (kindCounts[i] && k.lane ? k.lane : null)));
  for (const [id, label] of DEVICE_LANES) if (id === "pl011" || used.has(id)) lanes.push({ id, label, type: "device" });
  lanes.push({ id: "console", label: "Console lines", type: "console" });
  return lanes;
}

/** Last stage reached, what the kernel said, how the run ended (chapter 14's fingerprint). */
export function fingerprint(A) {
  let stage = 0;
  for (const m of A.milestones) if (m.stage && m.stage > stage) stage = m.stage;
  for (const f of A.failures) if (f.stage && f.stage > stage) stage = f.stage;
  const seen = new Set(A.milestones.map((m) => m.label));
  // A window of the last exits has no beginning, so nothing can be called missing from it.
  const missing = A.window ? [] : MILESTONES.filter((m) => m.need && m.stage && m.stage <= stage && !seen.has(m.label)).map((m) => ({ stage: m.stage, label: m.label }));
  const noConsole = stage >= 6 && missing.some((m) => m.label.startsWith("PL011 driver bound"));
  const says = [];
  for (const f of A.failures) for (const l of f.labels) if (!says.includes(l)) says.push(l);
  let stageText;
  if (A.noMmio) stageText = "unknown: this trace has no data aborts (MMIO exits), so there is no console text to rebuild; it was probably recorded without mmio in its categories";
  else if (A.window) stageText = stage ? `${stage}, ${STAGES[stage]} (in this window of the last exits)` : "unknown: this is a window of the last exits, not a whole run";
  else stageText = stage ? `${stage}, ${STAGES[stage]}${noConsole ? ", but with no console" : ""}` : "none (no milestone line in the console output)";
  return {
    stage, stageName: stage ? STAGES[stage] : null, stageText,
    missing, noConsole, kernelSays: says, ended: howItEnded(A),
  };
}

/** Records that end a run on their own (StopReason in crates/vmm/src/control.rs). */
function terminal(r) {
  if (r.action === "psci" && r.fn === "PSCI_SYSTEM_OFF") return { how: "off", status: "0", text: "The guest called PSCI SYSTEM_OFF: a clean power-off, exit status 0." };
  if (r.action === "psci" && r.fn === "PSCI_SYSTEM_RESET") return { how: "reset", status: "4 with --on-reset exit", text: "The guest called PSCI SYSTEM_RESET: a reboot, or exit status 4 with --on-reset exit." };
  if (r.fn === "DEBUG_EXIT") return { how: "debug-exit", status: "0 or 6", text: "The guest made macvmm's DEBUG_EXIT call: exit status 0 for code 0, or 6 for any other code." };
  if (r.action === "stop") return { how: "stop", status: "3", text: "The VMM stopped on this exit, exit status 3: a fatal guest error, such as unhandled MMIO, an instruction abort or an exit the VMM does not handle." };
  return null;
}

/**
 * How the run ended. Every stop kicks the other running vCPUs out of the guest (request_stop in
 * crates/vmm/src/control.rs), so an SMP run ends with one canceled exit per secondary vCPU after
 * the record that really ended it. The trailing canceled exits are skipped to find that record.
 */
function howItEnded(A) {
  const r = A.records;
  if (!r.length) return { how: "empty", status: null, text: "The trace holds no exits for this boot." };
  if (A.truncated) return { how: "truncated", status: null, text: `The trace stops at its byte cap at ${fmtTime(A.truncated.t)}; the run went on without being recorded.` };
  if (A.window) {
    const why = ({
      dump: "This file holds a ring dump (Ctrl-A t or SIGUSR1), which keeps only the last 256 exits of each vCPU",
      duplicates: "Some records appear more than once, as when two ring dumps overlap (repeats were dropped)",
      late: `The first exit is at ${fmtTime(r[0].t)}, long after the machine was built`,
    })[A.window] || "This is not a whole run";
    return { how: "window", status: null, text: `${why}: it is a window of the last exits, not a whole run, so the start, the missing milestones and the ending cannot be read from it.` };
  }
  let k = r.length - 1;
  while (k >= 0 && r[k].reason === "canceled") k--;
  const cancels = r.length - 1 - k;
  const end = k >= 0 ? terminal(r[k]) : null;
  if (end) {
    if (cancels) {
      const v = new Set(r.slice(k + 1).map((x) => x.vcpu)).size;
      end.text += ` The other vCPU${v === 1 ? " was" : "s were"} then kicked out of the guest (${cancels} canceled exit${cancels === 1 ? "" : "s"}).`;
    }
    end.rec = k;
    return end;
  }
  if (cancels) {
    const quiet = r[r.length - 1].t - (k >= 0 ? r[k].t : 0);
    const v = new Set(r.slice(k + 1).map((x) => x.vcpu)).size;
    const on = v > 1 ? `canceled exits on ${v} vCPUs` : "a canceled exit";
    return { how: "canceled", status: "5 or 130", quiet, rec: r.length - 1, text: `After ${fmtTime(quiet)} with no exits at all, the run ended with ${on}: something outside the guest stopped it (exit status 5 for --timeout, 130 for SIGINT, SIGTERM or Ctrl-A x).` };
  }
  return { how: "cut", status: null, text: "The trace ends without a power-off, a reset or a stop record: the run may have been killed, or the file was cut." };
}

/** The kernel's own `[seconds]` stamp at the start of a console line, or null. */
export function kernelStamp(text) {
  const m = /^\[\s*(\d{1,6}\.\d{1,9})\]/.exec(text || "");
  return m ? m[1] : null;
}

/** Name of a call record, from its static fields only. */
function callName(r) {
  if (r.fn) return r.fn;
  if (r.sysreg) return r.sysreg;
  if (r.sysregEnc) return `system register ${r.sysregEnc}`;
  if (r.imm !== null) return `immediate ${r.imm}`;
  return KINDS[r.kind].label;
}

/** The notable moments, in time order. Titles are built from static text and checked names. */
function buildEvents(A) {
  const ev = [];
  const recs = A.records;
  const add = (e) => ev.push({ vcpu: null, rec: null, line: null, text: null, ...e });
  const callKinds = new Set([KIND_INDEX.psci, KIND_INDEX.smccc, KIND_INDEX.hvc]);
  const nCalls = recs.reduce((s, r) => s + (callKinds.has(r.kind) ? 1 : 0), 0);
  const nSys = A.kindCounts[KIND_INDEX.sysreg];
  const nCancel = A.kindCounts[KIND_INDEX.canceled];
  const seenKind = new Set(), seenName = new Set();
  let cancelIdx = 0;
  recs.forEach((r, i) => {
    const k = KINDS[r.kind];
    const isCall = callKinds.has(r.kind) || r.kind === KIND_INDEX.sysreg;
    if (isCall) {
      const many = callKinds.has(r.kind) ? nCalls > MAX_LISTED_CALLS : nSys > MAX_LISTED_CALLS;
      const name = callName(r);
      if (!many || !seenName.has(name)) {
        seenName.add(name);
        add({ t: r.t, type: r.kind === KIND_INDEX.sysreg ? "sysreg" : "call", title: `${r.kind === KIND_INDEX.sysreg ? "System register" : k.label}: ${name}${many ? " (first of several)" : ""}`, rec: i, vcpu: r.vcpu });
      }
    } else if (r.kind === KIND_INDEX.canceled) {
      if (nCancel <= MAX_LISTED_CANCELS || cancelIdx === 0 || cancelIdx === nCancel - 1) add({ t: r.t, type: "cancel", title: "Canceled exit", rec: i, vcpu: r.vcpu });
      cancelIdx++;
    } else if (!seenKind.has(r.kind)) {
      add({ t: r.t, type: "first", title: `First exit of its kind: ${k.label}`, rec: i, vcpu: r.vcpu });
    }
    if (r.action === "stop") add({ t: r.t, type: "stop", title: "The VMM stopped on this exit", rec: i, vcpu: r.vcpu });
    seenKind.add(r.kind);
  });
  if (recs.length) add({ t: recs[0].t, type: "first-exit", title: "First exit of the boot", rec: 0, vcpu: recs[0].vcpu });
  // A line printed twice (with different text) gets "(again)", so the list shows two lines, not a bug.
  for (const m of A.milestones) {
    const ln = A.console.lines[m.line];
    const title = (m.stage ? `Stage ${m.stage}, ${STAGES[m.stage]}: ${m.label}` : m.label) + (m.again ? " (again)" : "");
    add({ t: m.t, type: "milestone", stage: m.stage, title, line: m.line, text: ln.text, stamp: kernelStamp(ln.text), vcpu: ln.vcpu, rec: ln.rec });
  }
  for (const f of A.failures) {
    const ln = A.console.lines[f.line];
    add({ t: f.t, type: "failure", title: `Kernel reports: ${f.labels.join(", ")}${f.again ? " (again)" : ""}`, line: f.line, text: ln.text, stamp: kernelStamp(ln.text), vcpu: ln.vcpu, rec: ln.rec });
  }
  for (const g of A.topGaps) {
    add({ t: g.t0, t1: g.t1, type: "gap", title: `No exit for ${fmtTime(g.dur)}, then ${g.then.text}`, then: g.then, line: g.lastLine >= 0 ? g.lastLine : null, text: g.lastLine >= 0 ? A.console.lines[g.lastLine].text : null, rec: g.after });
  }
  if (recs.length) {
    const end = A.fingerprint.ended;
    const word = ({ off: "power-off", reset: "reset", "debug-exit": "debug exit", canceled: "stopped from outside", stop: "VMM stop", truncated: "trace cap", window: "end of the window", cut: "trace ends" })[end.how] || "end";
    add({ t: recs[recs.length - 1].t, type: "end", title: `Last exit: ${word}`, rec: recs.length - 1, vcpu: recs[recs.length - 1].vcpu });
  }
  if (A.truncated) add({ t: A.truncated.t, type: "truncated", title: "The trace's byte cap was reached here" });
  const rank = { "first-exit": 0, first: 1, call: 2, sysreg: 2, milestone: 3, failure: 4, gap: 5, cancel: 6, stop: 7, end: 8, truncated: 9 };
  ev.sort((a, b) => (a.t - b.t) || (rank[a.type] - rank[b.type]));
  return ev;
}

// --- the time axis -------------------------------------------------------------------------------

/** A silence is squeezed when it is at least this long, or at least half the run. */
export const SQUEEZE_NS = 1_000_000_000;
export const BREAK_W = 0.06;
const MAX_BREAKS = 4;

/**
 * The axis maps time (ns since the machine was built) to x in [0, 1]. With `squeeze`, each
 * very long silence is drawn as a fixed-width break, so a 60 ms boot followed by a 10 s hang is
 * readable; without it, x is proportional to time.
 */
export function makeAxis(A, { squeeze = true } = {}) {
  const end = Math.max(A.tEnd, 1);
  let breaks = [];
  if (squeeze) {
    breaks = A.gaps.filter((g) => g.dur >= SQUEEZE_NS || g.dur >= end / 2)
      .sort((a, b) => b.dur - a.dur).slice(0, MAX_BREAKS).sort((a, b) => a.t0 - b.t0);
  }
  const realTotal = end - breaks.reduce((s, g) => s + g.dur, 0);
  const realW = 1 - BREAK_W * breaks.length;
  const segs = [];
  let t = 0, x = 0;
  const pushReal = (t1) => {
    if (t1 <= t) return;
    const w = realTotal > 0 ? ((t1 - t) / realTotal) * realW : 0;
    segs.push({ t0: t, t1, x0: x, x1: x + w, squeezed: false });
    x += w; t = t1;
  };
  for (const g of breaks) {
    pushReal(g.t0);
    segs.push({ t0: g.t0, t1: g.t1, x0: x, x1: x + BREAK_W, squeezed: true });
    x += BREAK_W; t = g.t1;
  }
  pushReal(end);
  if (segs.length) segs[segs.length - 1].x1 = 1;
  return { end, segs, squeeze: breaks.length > 0 };
}

export function tToX(axis, t) {
  if (t <= 0) return 0;
  if (t >= axis.end) return 1;
  for (const s of axis.segs) {
    if (t <= s.t1) return s.t1 === s.t0 ? s.x0 : s.x0 + ((t - s.t0) / (s.t1 - s.t0)) * (s.x1 - s.x0);
  }
  return 1;
}

export function xToT(axis, x) {
  if (x <= 0) return 0;
  if (x >= 1) return axis.end;
  for (const s of axis.segs) {
    if (x <= s.x1) return s.x1 === s.x0 ? s.t0 : s.t0 + ((x - s.x0) / (s.x1 - s.x0)) * (s.t1 - s.t0);
  }
  return axis.end;
}

/** Smallest visible window, as a fraction of the axis. */
export const MIN_VIEW_W = 1 / 4096;

export function clampView(v) {
  let w = Math.min(1, Math.max(MIN_VIEW_W, v.v1 - v.v0));
  let v0 = Math.min(Math.max(0, v.v0), 1 - w);
  return { v0, v1: v0 + w };
}

/** Zoom by `factor` (< 1 zooms in) keeping x = `at` where it is on screen. */
export function zoom(view, factor, at = (view.v0 + view.v1) / 2) {
  const w = view.v1 - view.v0;
  const nw = Math.min(1, Math.max(MIN_VIEW_W, w * factor));
  const f = w > 0 ? (at - view.v0) / w : 0.5;
  return clampView({ v0: at - f * nw, v1: at - f * nw + nw });
}

export function pan(view, frac) {
  const w = view.v1 - view.v0;
  return clampView({ v0: view.v0 + frac * w, v1: view.v1 + frac * w });
}

/** A view that shows `t` (keeping the zoom when it already fits, else centring it). */
export function reveal(axis, view, t, t1 = t) {
  const x0 = tToX(axis, t), x1 = tToX(axis, t1);
  const w = view.v1 - view.v0;
  if (x0 >= view.v0 && x1 <= view.v1) return view;
  if (x1 - x0 > w * 0.9) return clampView({ v0: x0 - (x1 - x0) * 0.05, v1: x1 + (x1 - x0) * 0.05 });
  const c = (x0 + x1) / 2;
  return clampView({ v0: c - w / 2, v1: c + w / 2 });
}

const NICE = [1, 2, 5];

/** Tick marks for the visible window: nice time steps in the real segments, a label per break. */
export function ticks(axis, view, maxTicks = 6) {
  const out = [];
  const w = view.v1 - view.v0;
  for (const s of axis.segs) {
    const a = Math.max(s.x0, view.v0), b = Math.min(s.x1, view.v1);
    if (b <= a) continue;
    if (s.squeezed) { out.push({ x: (a + b) / 2, label: `squeezed: ${fmtTime(s.t1 - s.t0)}`, squeezed: true }); continue; }
    const ta = xToT(axis, a), tb = xToT(axis, b);
    const share = Math.max(1, Math.round(maxTicks * ((b - a) / w)));
    const span = tb - ta;
    if (span <= 0) continue;
    let step = 1;
    outer: for (let e = 0; e < 13; e++) {
      for (const m of NICE) { step = m * 10 ** e; if (span / step <= share) break outer; }
    }
    for (let t = Math.ceil(ta / step) * step; t <= tb; t += step) out.push({ x: tToX(axis, t), label: t === 0 ? "0" : fmtTime(t), t });
  }
  return out;
}

// --- binning -----------------------------------------------------------------------------------

export const N_BINS = 240;

/** Which group letters are hidden, as a Set. */
export function isShown(hidden, kind) { return !hidden.has(KINDS[kind].group); }

function firstAtOrAfter(recs, t) {
  let lo = 0, hi = recs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (recs[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Exit counts per lane and bin for the visible window, plus the rare-exit markers and the
 * console-lane markers. Lane ids are those of `A.lanes`.
 */
export function bin(A, axis, view, hidden, nBins = N_BINS) {
  const counts = new Map(A.lanes.filter((l) => l.type !== "console").map((l) => [l.id, new Array(nBins).fill(0)]));
  const kindsPerBin = Array.from({ length: nBins }, () => new Map());
  const markers = [];
  const w = view.v1 - view.v0;
  const tFrom = xToT(axis, view.v0), tTo = xToT(axis, view.v1);
  const recs = A.records;
  let max = 0;
  for (let i = firstAtOrAfter(recs, tFrom); i < recs.length && recs[i].t <= tTo; i++) {
    const r = recs[i];
    if (!isShown(hidden, r.kind)) continue;
    const x = tToX(axis, r.t);
    const b = Math.min(nBins - 1, Math.max(0, Math.floor(((x - view.v0) / w) * nBins)));
    const k = KINDS[r.kind];
    const vc = counts.get(`vcpu${r.vcpu}`);
    if (vc) { vc[b]++; if (vc[b] > max) max = vc[b]; }
    if (k.lane) { const dc = counts.get(k.lane); if (dc) { dc[b]++; if (dc[b] > max) max = dc[b]; } }
    const m = kindsPerBin[b];
    m.set(r.kind, (m.get(r.kind) || 0) + 1);
    if (k.glyph && markers.length < 400) markers.push({ x, kind: r.kind, glyph: k.glyph, vcpu: r.vcpu, rec: i });
  }
  const consoleMarks = [];
  for (const m of A.milestones) if (m.t >= tFrom && m.t <= tTo) consoleMarks.push({ x: tToX(axis, m.t), glyph: m.stage ? String(m.stage) : "•", type: "milestone", line: m.line });
  for (const f of A.failures) if (f.t >= tFrom && f.t <= tTo) consoleMarks.push({ x: tToX(axis, f.t), glyph: "!", type: "failure", line: f.line });
  return { nBins, counts, max, markers, consoleMarks, kindsPerBin, tFrom, tTo };
}

/** Density level 0..5 of a count, on a log scale against the window's busiest bin. */
export function level(count, max) {
  if (!count) return 0;
  if (max <= 1) return 5;
  return Math.max(1, Math.min(5, Math.ceil((Math.log2(count + 1) / Math.log2(max + 1)) * 5)));
}

/** What is in bin `i`: its time range and the exits it holds, busiest kinds first. */
export function binDetails(axis, view, binned, i) {
  const n = binned.nBins;
  const w = view.v1 - view.v0;
  const x0 = view.v0 + (i / n) * w, x1 = view.v0 + ((i + 1) / n) * w;
  const t0 = xToT(axis, x0), t1 = xToT(axis, x1);
  const kinds = [...binned.kindsPerBin[i].entries()].sort((a, b) => b[1] - a[1]);
  const total = kinds.reduce((s, [, c]) => s + c, 0);
  const squeezed = axis.segs.some((s) => s.squeezed && s.x0 < x1 && s.x1 > x0);
  return { t0, t1, total, kinds: kinds.map(([k, c]) => ({ kind: k, label: KINDS[k].label, count: c })), squeezed };
}

/** Counter rows for the kinds present: count, share, rate over the run and in the window. */
export function counters(A, binned, hidden) {
  const runS = A.tEnd / 1e9;
  const viewS = (binned.tTo - binned.tFrom) / 1e9;
  const inView = new Array(KINDS.length).fill(0);
  for (const m of binned.kindsPerBin) for (const [k, c] of m) inView[k] += c;
  const rows = [];
  KINDS.forEach((k, i) => {
    const c = A.kindCounts[i];
    if (!c) return;
    rows.push({
      kind: i, label: k.label, group: k.group, shown: !hidden.has(k.group), count: c,
      share: A.count ? c / A.count : 0,
      perSecond: runS > 0 ? c / runS : null,
      inView: inView[i], perSecondView: viewS > 0 && !hidden.has(k.group) ? inView[i] / viewS : null,
    });
  });
  return rows;
}

// --- text -----------------------------------------------------------------------------------------

export function fmtTime(ns) {
  if (!Number.isFinite(ns)) return "?";
  const a = Math.abs(ns);
  if (a < 1_000) return `${Math.round(ns)} ns`;
  if (a < 1_000_000) return `${(ns / 1_000).toFixed(a < 10_000 ? 2 : 1)} µs`;
  if (a < 1_000_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  return `${(ns / 1_000_000_000).toFixed(a < 10_000_000_000 ? 2 : 1)} s`;
}

export function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${n} bytes`;
}

export function fmtRate(perSecond) {
  if (perSecond === null || !Number.isFinite(perSecond)) return "-";
  if (perSecond >= 100) return fmtInt(perSecond);
  if (perSecond >= 1) return perSecond.toFixed(1);
  return perSecond.toFixed(2);
}

/** The one-paragraph readout. */
export function summary(A, title) {
  const fp = A.fingerprint;
  const parts = [];
  parts.push(`${title}: ${fmtInt(A.count)} exit${A.count === 1 ? "" : "s"} in ${fmtTime(A.tEnd)}${A.vcpus.length > 1 ? ` on ${A.vcpus.length} vCPUs` : ""}.`);
  if (A.console.bytes) parts.push(`${fmtInt(A.console.bytes)} console bytes, ${(A.count / A.console.bytes).toFixed(1)} exits per byte.`);
  parts.push(`Last stage reached: ${fp.stageText}.`);
  if (fp.kernelSays.length) parts.push(`The kernel says: ${fp.kernelSays.join(", ")}.`);
  if (fp.missing.length) parts.push(`Missing: ${fp.missing.map((m) => m.label).join("; ")}.`);
  const g = A.topGaps[0];
  if (g) parts.push(`Longest silence: ${fmtTime(g.dur)} from ${fmtTime(g.t0)}, then ${g.then.text}.`);
  parts.push(fp.ended.text);
  return parts.join(" ");
}

/** One exit record as macvmm wrote it (rebuilt from validated fields only). */
export function recordLine(r) {
  const o = { t_ns: r.t, vcpu: r.vcpu, reason: r.reason };
  if (r.ec !== null) o.ec = `0x${r.ec.toString(16)}`;
  const put = (k, v) => { if (v !== null && v !== undefined) o[k] = v; };
  put("pc", r.pc); put("ipa", r.ipa); put("wnr", r.wnr); put("size", r.size); put("reg", r.reg);
  put("value", r.value); put("imm", r.imm); put("sysreg", r.sysreg); put("sysreg_enc", r.sysregEnc);
  put("fn", r.fn); put("action", r.action); put("isv", r.isv);
  if (r.boot) o.boot = r.boot;
  return toJsonLine(o);
}

/** A plain sentence about one exit, for the details panel. */
export function describeRecord(r) {
  const k = KINDS[r.kind];
  const bits = [`vCPU ${r.vcpu} at ${fmtTime(r.t)}: ${k.label}`];
  if (r.ipa) bits.push(`${r.wnr ? "write to" : "read from"} ${r.ipa}${r.size ? `, ${r.size} byte${r.size === 1 ? "" : "s"}` : ""}${r.value ? `, value ${r.value}` : ""}${regionOf(r.ipaN) ? ` (${regionOf(r.ipaN)})` : ""}`);
  if (r.fn) bits.push(`function ${r.fn}`);
  if (r.sysreg || r.sysregEnc) bits.push(`register ${r.sysreg || r.sysregEnc}`);
  if (r.pc) bits.push(`guest PC ${r.pc}`);
  return bits.join("; ") + ".";
}

// --- share state (#boot-timeline=...) --------------------------------------------------------------

/**
 * `<trace>[.h<hidden groups>][.r][.b<boot>][.w<from µs>-<to µs>][.e<event>]`. `trace` is one
 * of TRACE_IDS or `file` (a dropped file is never in the link; the reader loads it again). The
 * default (healthy, everything shown, squeezed, whole run, nothing selected) is `null`.
 */
export function encodeHash(s) {
  let out = s.trace;
  const hidden = GROUPS.map(([g]) => g).filter((g) => s.hidden.has(g)).join("");
  if (hidden) out += `.h${hidden}`;
  if (!s.squeeze) out += ".r";
  if (s.boot) out += `.b${s.boot}`;
  if (s.window) out += `.w${Math.round(s.window[0] / 1000)}-${Math.round(s.window[1] / 1000)}`;
  if (s.event !== null && s.event !== undefined) out += `.e${s.event}`;
  return out === "healthy" ? null : out;
}

export function decodeHash(str) {
  if (typeof str !== "string" || str.length > 120) return null;
  const m = /^(healthy|notimer|gicr|noid|file)((?:\.[a-z][0-9a-z-]*)*)$/.exec(str);
  if (!m) return null;
  const s = { trace: m[1], hidden: new Set(), squeeze: true, boot: 0, window: null, event: null };
  for (const tok of m[2].split(".").slice(1)) {
    const c = tok[0], rest = tok.slice(1);
    if (c === "h" && /^[mhswtco]{1,7}$/.test(rest)) for (const g of rest) s.hidden.add(g);
    else if (c === "r" && rest === "") s.squeeze = false;
    else if (c === "b" && /^[0-9]{1,6}$/.test(rest)) s.boot = Number(rest);
    else if (c === "w" && /^[0-9]{1,12}-[0-9]{1,12}$/.test(rest)) {
      const [a, b] = rest.split("-").map(Number);
      if (!(b > a)) return null;
      s.window = [a * 1000, b * 1000];
    } else if (c === "e" && /^[0-9]{1,5}$/.test(rest)) s.event = Number(rest);
    else return null;
  }
  return s;
}
