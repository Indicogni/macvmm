// pl011-poke model: the reference PL011 UART (crates/vmm/src/devices/pl011.rs) as a pure state
// machine, plus the host's input queue (backend/serial.rs SerialInput) and the interrupt line.
//
// No DOM, no globals, no I/O: node --test imports this file, and the view only renders what it
// returns. Every rule here mirrors a line of the Rust device, so the lab and the chapter agree:
//   - DR write: transmit the low byte, latch RIS.TX. DR read: pop the RX FIFO (0 when empty),
//     then refill it from the host queue.
//   - FR is computed on every read: TXFE always 1, RXFE when the FIFO is empty, RXFF when it
//     holds `depth` bytes (32 with LCR_H.FEN set, else 1).
//   - RIS = latched bits (only TX) | RX|RT while the FIFO is non-empty. MIS = RIS & IMSC.
//     ICR clears latched bits only. The line is (MIS != 0), recomputed after every access.
//   - 8-, 16- and 32-bit accesses at a 4-byte-aligned offset reach a register; 64-bit and
//     misaligned accesses, and offsets with no register, read as zero and ignore writes.
//   - The host queue holds at most 4 KiB and never blocks: bytes beyond that are dropped.
// The lesson's walk (REFERENCE) reproduces course/captures/09-poke.txt line for line.

export const WINDOW = 0x1000;
export const FIFO_DEPTH = 32;
export const HOST_CAP = 4096;

export const REG = Object.freeze({
  DR: 0x000, RSR: 0x004, FR: 0x018, ILPR: 0x020, IBRD: 0x024, FBRD: 0x028, LCR_H: 0x02c,
  CR: 0x030, IFLS: 0x034, IMSC: 0x038, RIS: 0x03c, MIS: 0x040, ICR: 0x044, DMACR: 0x048,
});
export const ID_BASE = 0xfe0;
export const ID_BYTES = Object.freeze([0x11, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1]);

export const FR_BITS = Object.freeze([
  { mask: 0x08, name: "BUSY", meaning: "still shifting a byte out (ours: never)" },
  { mask: 0x10, name: "RXFE", meaning: "receive FIFO empty" },
  { mask: 0x20, name: "TXFF", meaning: "transmit FIFO full" },
  { mask: 0x40, name: "RXFF", meaning: "receive FIFO full" },
  { mask: 0x80, name: "TXFE", meaning: "transmit FIFO empty (ours: always)" },
]);
export const INT = Object.freeze({ RX: 0x10, TX: 0x20, RT: 0x40, ALL: 0x7ff });
export const INT_BITS = Object.freeze([
  { mask: INT.RX, name: "RX", meaning: "received data waits" },
  { mask: INT.TX, name: "TX", meaning: "a byte was sent" },
  { mask: INT.RT, name: "RT", meaning: "receive timeout (ours: whenever data waits)" },
]);
/** The mask bits the model stores but never raises: the modem and error interrupts. */
export const OTHER_INT_BITS = Object.freeze([
  { mask: 0x001, name: "RI", meaning: "ring indicator (modem)" },
  { mask: 0x002, name: "CTS", meaning: "clear to send (modem)" },
  { mask: 0x004, name: "DCD", meaning: "data carrier detect (modem)" },
  { mask: 0x008, name: "DSR", meaning: "data set ready (modem)" },
  { mask: 0x080, name: "FE", meaning: "framing error" },
  { mask: 0x100, name: "PE", meaning: "parity error" },
  { mask: 0x200, name: "BE", meaning: "break error" },
  { mask: 0x400, name: "OE", meaning: "overrun error" },
]);
const LIVE_INT = INT.RX | INT.TX | INT.RT;
export const LCR_H_FEN = 0x10;
export const CR_RESET = 0x300;
export const IFLS_RESET = 0x12;

/** Register list for the view: name, offset, what the model does with it. */
export const REGISTERS = Object.freeze([
  { name: "DR", off: REG.DR, rw: "rw", note: "write: send the low byte; read: pop the RX FIFO (0 when empty)" },
  { name: "RSR", off: REG.RSR, rw: "rw", note: "reads 0 (no line errors ever happen); writes do nothing" },
  { name: "FR", off: REG.FR, rw: "r", note: "computed from the FIFO on every read; read-only" },
  { name: "ILPR", off: REG.ILPR, rw: "rw", note: "stored; unused" },
  { name: "IBRD", off: REG.IBRD, rw: "rw", note: "stored and read back" },
  { name: "FBRD", off: REG.FBRD, rw: "rw", note: "stored and read back" },
  { name: "LCR_H", off: REG.LCR_H, rw: "rw", note: "stored; bit 4, FEN, selects a 32-byte FIFO, else a 1-byte one" },
  { name: "CR", off: REG.CR, rw: "rw", note: "stored (reset 0x300)" },
  { name: "IFLS", off: REG.IFLS, rw: "rw", note: "stored (reset 0x12)" },
  { name: "IMSC", off: REG.IMSC, rw: "rw", note: "the interrupt mask" },
  { name: "RIS", off: REG.RIS, rw: "r", note: "raw interrupt status; read-only" },
  { name: "MIS", off: REG.MIS, rw: "r", note: "RIS & IMSC; read-only" },
  { name: "ICR", off: REG.ICR, rw: "w", note: "write 1s to clear latched bits; reads 0" },
  { name: "DMACR", off: REG.DMACR, rw: "rw", note: "stored; there is no DMA" },
  ...ID_BYTES.map((b, i) => ({
    name: `ID${i}`, off: ID_BASE + 4 * i, rw: "r",
    note: `identification byte ${hex(b, 2)}; read-only`,
  })),
]);

const NAME_BY_OFF = new Map(REGISTERS.map((r) => [r.off, r.name]));
export const SIZES = Object.freeze([1, 2, 4, 8]);

// ---- formatting helpers ------------------------------------------------------------------

/** Lower-case hex with a 0x prefix, padded to at least `digits` digits. */
export function hex(v, digits = 2) {
  return "0x" + (v >>> 0).toString(16).padStart(digits, "0");
}

/** The register name at `off`, or the offset itself. */
export function regName(off) {
  return NAME_BY_OFF.get(off) ?? hex(off, 3);
}

/** Names of the set bits of `v` from `table`, e.g. "TXFE RXFE"; "none" when no bit is set. */
export function bitNames(v, table) {
  const names = table.filter((b) => (v & b.mask) !== 0).map((b) => b.name);
  return names.length ? names.join(" ") : "none";
}

function printable(b) {
  return b >= 0x20 && b < 0x7f;
}

/** Bytes as a quoted string, with non-printing bytes as \xNN (and \n, \r, \t, \", \\). */
export function quoteBytes(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0x0a) s += "\\n";
    else if (b === 0x0d) s += "\\r";
    else if (b === 0x09) s += "\\t";
    else if (b === 0x22) s += "\\\"";
    else if (b === 0x5c) s += "\\\\";
    else if (printable(b)) s += String.fromCharCode(b);
    else s += "\\x" + b.toString(16).padStart(2, "0");
  }
  return `"${s}"`;
}

function charOf(b) {
  return printable(b) && b !== 0x27 ? `'${String.fromCharCode(b)}'` : null;
}

// ---- the device --------------------------------------------------------------------------

/** A UART in its reset state, with an empty host queue and nothing transmitted. */
export function reset() {
  return {
    ilpr: 0, ibrd: 0, fbrd: 0, lcr_h: 0, cr: CR_RESET, ifls: IFLS_RESET, imsc: 0, dmacr: 0,
    latched: 0,
    rx: [],            // the device's receive FIFO
    host: [],          // SerialInput: bytes the host typed that the FIFO had no room for yet
    hostDropped: 0,    // bytes the full host queue refused
    tx: [],            // bytes the guest transmitted (the real sink filters them first)
    line: false,       // the interrupt line's level
    transitions: [],   // every change of the line, like the tests' TestIrq
    warnings: 0,       // accesses that named no register
  };
}

function clone(s) {
  return { ...s, rx: s.rx.slice(), host: s.host.slice(), tx: s.tx.slice(), transitions: s.transitions.slice() };
}

export function depth(s) {
  return (s.lcr_h & LCR_H_FEN) !== 0 ? FIFO_DEPTH : 1;
}

export function fr(s) {
  let v = 0x80; // TXFE: transmission is instant
  if (s.rx.length === 0) v |= 0x10;
  if (s.rx.length >= depth(s)) v |= 0x40;
  return v;
}

export function ris(s) {
  const rx = s.rx.length === 0 ? 0 : INT.RX | INT.RT;
  return (s.latched | rx) & INT.ALL;
}

export function mis(s) {
  return ris(s) & s.imsc;
}

function refill(s) {
  while (s.rx.length < depth(s) && s.host.length > 0) s.rx.push(s.host.shift());
}

function updateIrq(s) {
  const level = mis(s) !== 0;
  if (level !== s.line) s.transitions.push(level);
  s.line = level;
}

/** The register an access names: 4-byte aligned, at most 32 bits wide, inside the window. */
export function regOffset(off, size) {
  return off % 4 === 0 && size !== 8 && off < WINDOW ? off : null;
}

/** True when a guest access of `size` bytes at `off` reaches a register (else it is RAZ/WI). */
export function reaches(off, size) {
  const reg = regOffset(off, size);
  return reg !== null && NAME_BY_OFF.has(reg);
}

/** The name part of a step label, plus the width/RAZ-WI tag, e.g. ["0xff0", " (64-bit, no register)"]. */
function accessParts(a) {
  const tags = [];
  if (a.size !== 4) tags.push(`${8 * a.size}-bit`);
  const hit = reaches(a.off, a.size);
  if (!hit) tags.push("no register");
  return { name: hit ? regName(a.off) : hex(a.off, 3), tag: tags.length ? ` (${tags.join(", ")})` : "", hit };
}

/** The value part of a write label: "'h' (0x68)", "0x1234 (sends '4', 0x34)", "0x10 (RX)". */
function writeValueText(a, hit) {
  const v = (a.val & sizeMask(a.size)) >>> 0;
  if (hit && a.off === REG.DR) {
    const ch = charOf(v & 0xff);
    if (v <= 0xff) return ch ? `${ch} (${hex(v)})` : hex(v);
    return `${hex(v)} (sends ${ch ? `${ch}, ` : ""}${hex(v & 0xff)})`;
  }
  if (hit && a.off === REG.IMSC) {
    const names = [bitNames(v, INT_BITS), bitNames(v, OTHER_INT_BITS)].filter((n) => n !== "none");
    return `${hex(v)} (${names.length ? names.join(" ") : "none"})`;
  }
  return hex(v);
}

/** A step's label without running it (for steps not yet applied). */
export function describeAction(a) {
  if (a.op === "h") return `host types ${quoteBytes(a.bytes)}`;
  const p = accessParts(a);
  return a.op === "r" ? `read ${p.name}${p.tag}` : `write ${p.name} = ${writeValueText(a, p.hit)}${p.tag}`;
}

function readReg(s, off) {
  switch (off) {
    case REG.DR: {
      const v = s.rx.length ? s.rx.shift() : 0;
      refill(s);
      return v;
    }
    case REG.RSR: return 0;
    case REG.FR: return fr(s);
    case REG.ILPR: return s.ilpr;
    case REG.IBRD: return s.ibrd;
    case REG.FBRD: return s.fbrd;
    case REG.LCR_H: return s.lcr_h;
    case REG.CR: return s.cr;
    case REG.IFLS: return s.ifls;
    case REG.IMSC: return s.imsc;
    case REG.RIS: return ris(s);
    case REG.MIS: return mis(s);
    case REG.ICR: return 0;
    case REG.DMACR: return s.dmacr;
    default:
      if (off >= ID_BASE && off <= 0xffc) return ID_BYTES[(off - ID_BASE) / 4];
      return null;
  }
}

function writeReg(s, off, v) {
  switch (off) {
    case REG.DR: s.tx.push(v & 0xff); s.latched |= INT.TX; break;
    case REG.RSR: break;
    case REG.ILPR: s.ilpr = v & 0xff; break;
    case REG.IBRD: s.ibrd = v & 0xffff; break;
    case REG.FBRD: s.fbrd = v & 0x3f; break;
    case REG.LCR_H: s.lcr_h = v & 0xff; refill(s); break;
    case REG.CR: s.cr = v & 0xffff; break;
    case REG.IFLS: s.ifls = v & 0x3f; break;
    case REG.IMSC: s.imsc = v & INT.ALL; break;
    case REG.ICR: s.latched &= ~v; break;
    case REG.DMACR: s.dmacr = v & 0x7; break;
    case REG.FR: case REG.RIS: case REG.MIS: break; // read-only
    default:
      if (off >= ID_BASE && off <= 0xffc) break; // read-only
      return false;
  }
  return true;
}

function sizeMask(size) {
  return size >= 4 ? 0xffffffff : (1 << (8 * size)) - 1;
}

// ---- actions -----------------------------------------------------------------------------
// {op: "w", off, size, val}  a guest store (val is 32 bits; a 64-bit store is ignored anyway)
// {op: "r", off, size}       a guest load
// {op: "h", bytes}           the host types bytes (they go through the host queue)

export const MAX_ACTIONS = 256;
export const MAX_PUSH = 64;

/** Check an action's shape and ranges; returns an error string or null. Hostile input safe. */
export function validateAction(a) {
  if (!a || typeof a !== "object") return "not an action";
  if (a.op === "h") {
    if (!Array.isArray(a.bytes) || a.bytes.length === 0) return "type at least one byte";
    if (a.bytes.length > MAX_PUSH) return `at most ${MAX_PUSH} bytes per push`;
    if (!a.bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) return "bytes must be 0 to 255";
    return null;
  }
  if (a.op !== "w" && a.op !== "r") return "unknown operation";
  if (!SIZES.includes(a.size)) return "size must be 1, 2, 4 or 8 bytes";
  if (!Number.isInteger(a.off) || a.off < 0 || a.off >= WINDOW) return "offset must be 0x000 to 0xfff";
  if (a.off + a.size > WINDOW) return "the access runs past the end of the 4 KiB window; the bus rejects it before the device sees it";
  if (a.op === "w" && (!Number.isInteger(a.val) || a.val < 0 || a.val > 0xffffffff)) return "value must fit in 32 bits";
  return null;
}

/**
 * Apply one action. Returns {state, read, label, effect} where `read` is the value a load
 * returned (or null), `label` is the step name used in the capture, and `effect` explains
 * what happened in plain words. Throws on an invalid action (validate first).
 */
export function apply(state, a) {
  const err = validateAction(a);
  if (err) throw new Error(err);
  const s = clone(state);
  const effect = [];
  let read = null;
  let label;
  if (a.op === "h") {
    const room = Math.max(0, HOST_CAP - s.host.length);
    const take = a.bytes.slice(0, room);
    const dropped = a.bytes.length - take.length;
    s.host.push(...take);
    s.hostDropped += dropped;
    const before = s.rx.length;
    refill(s);
    const moved = s.rx.length - before;
    updateIrq(s);
    label = `host types ${quoteBytes(a.bytes)}`;
    effect.push(`${take.length} byte${take.length === 1 ? "" : "s"} joined the host queue, and the device moved ${moved} into its receive FIFO (room for ${depth(s)}${depth(s) === 1 ? ", because LCR_H.FEN is clear" : ""}).`);
    if (s.host.length) effect.push(`${s.host.length} byte${s.host.length === 1 ? " waits" : "s wait"} in the host queue until a DR read makes room.`);
    if (dropped) effect.push(`The host queue is full (4 KiB): ${dropped} byte${dropped === 1 ? " was" : "s were"} dropped and counted, never blocking the host.`);
  } else {
    const reg = regOffset(a.off, a.size);
    const parts = accessParts(a);
    const name = parts.name;
    if (a.op === "r") {
      const emptyBefore = s.rx.length === 0;
      const popped = s.rx.length ? s.rx[0] : null;
      const hostBefore = s.host.length;
      const v = reg === null ? null : readReg(s, reg);
      updateIrq(s);
      read = v === null ? 0 : (v & sizeMask(a.size)) >>> 0;
      label = `read ${name}${a.off === REG.DR && parts.hit && emptyBefore ? " (FIFO empty)" : ""}${parts.tag}`;
      if (v === null) {
        s.warnings++;
        effect.push(noRegister(a, "read", "reads as zero"));
      } else if (reg === REG.DR) {
        if (popped === null) effect.push("The FIFO was empty, so DR reads 0. That is why a driver checks FR.RXFE before it reads DR.");
        else {
          effect.push(`Reading DR removed ${describeByte(popped)} from the FIFO: a read with a side effect.`);
          if (hostBefore > s.host.length) effect.push(`The device refilled the FIFO from the host queue (${describeByte(s.rx[s.rx.length - 1])} moved in).`);
          else if (s.rx.length === 0) effect.push("The FIFO is now empty: RXFE is 1 again, and RX and RT leave RIS.");
        }
      } else if (reg === REG.FR || reg === REG.RIS || reg === REG.MIS) {
        effect.push(`${name} is computed when it is read: ${hex(v)} (${bitNames(v, reg === REG.FR ? FR_BITS : INT_BITS)}). Reading it changes nothing.`);
      } else {
        effect.push(`${name} reads ${hex(read)}. Reading it changes nothing.`);
      }
    } else {
      const v = (a.val & sizeMask(a.size)) >>> 0;
      const latchedBefore = s.latched;
      const ok = reg !== null && writeReg(s, reg, v);
      updateIrq(s);
      label = `write ${name} = ${writeValueText(a, parts.hit)}${parts.tag}`;
      if (!ok) {
        s.warnings++;
        effect.push(noRegister(a, "write", "is ignored"));
      } else if (reg === REG.DR) {
        effect.push(`The guest sent ${describeByte(v & 0xff)} to the terminal. Sending is instant here, so TX latches in RIS and stays until the guest writes 1 to ICR bit 5.`);
        if (v > 0xff) effect.push("Only the low 8 bits are data; the rest are ignored.");
      } else if (reg === REG.ICR) {
        const cleared = latchedBefore & v;
        effect.push(cleared ? `ICR cleared the latched ${bitNames(cleared, INT_BITS)} bit.` : "ICR had no latched bit to clear.");
        if (s.rx.length && (v & (INT.RX | INT.RT))) effect.push("RX and RT stay set: their condition, data in the FIFO, still holds. Only reading DR changes that.");
      } else if (reg === REG.IMSC) {
        const live = bitNames(s.imsc, INT_BITS);
        const through = live === "none" ? "nothing" : live;
        if (s.imsc & ~LIVE_INT) {
          effect.push(`IMSC now holds ${hex(s.imsc)}, and reads back that way. Of its bits, only RX, TX and RT can ever be raised in this model (the modem and error bits, ${bitNames(s.imsc, OTHER_INT_BITS)}, never fire), so the mask lets through ${through}. MIS is RIS & IMSC = ${hex(mis(s))}.`);
        } else {
          effect.push(`The mask now lets through ${through}. MIS is RIS & IMSC = ${hex(mis(s))}.`);
        }
      } else if (reg === REG.LCR_H) {
        effect.push(`FEN is ${(s.lcr_h & LCR_H_FEN) ? "set: the receive FIFO holds 32 bytes" : "clear: the receive FIFO holds 1 byte"}.`);
        if (s.rx.length > depth(s)) effect.push("Bytes already in the FIFO stay until they are read; FR shows RXFF.");
      } else if (reg === REG.FR || reg === REG.RIS || reg === REG.MIS || (reg >= ID_BASE)) {
        effect.push(`${name} is read-only; the write changes nothing.`);
      } else if (reg === REG.RSR) {
        effect.push("RSR clears the line-error flags, which are always clear here.");
      } else {
        effect.push(`${name} stores ${hex(readReg(clone(s), reg))}. It has no other effect in our model.`);
      }
    }
  }
  const prev = state;
  if (s.line !== prev.line) effect.push(s.line ? `The interrupt line went high: MIS = ${hex(mis(s))} is non-zero.` : "The interrupt line went low: MIS is 0.");
  return { state: s, read, label, effect: effect.join(" ") };
}

function describeByte(b) {
  const c = charOf(b);
  return c ? `${c} (${hex(b)})` : hex(b);
}

function noRegister(a, verb, outcome) {
  let why;
  if (a.size === 8) why = "a 64-bit access is wider than any register";
  else if (a.off % 4 !== 0) why = "the offset is not 4-byte aligned";
  else why = `no register lives at ${hex(a.off, 3)}`;
  return `The ${verb} ${outcome}: ${why}. The VMM logs a rate-limited warning and the guest carries on.`;
}

/** A status line in the capture's format. */
export function status(s) {
  return `FR=${hex(fr(s))} RIS=${hex(ris(s))} MIS=${hex(mis(s))} line=${s.line ? "high" : "low"}`;
}

/** Replay a list of actions from reset. Rows[0] is the reset row; row i is after action i-1. */
export function replay(actions) {
  let s = reset();
  const rows = [{ label: "reset", read: null, status: status(s), state: s, effect: "The device after reset: both FIFOs empty, every interrupt masked." }];
  for (const a of actions) {
    const r = apply(s, a);
    s = r.state;
    rows.push({ label: r.label, read: r.read, status: status(s), state: s, effect: r.effect });
  }
  return rows;
}

/** The rows as the capture prints them (step padded to 29, read to 8). */
export function formatTable(rows) {
  const lines = [`${"step".padEnd(29)}${"read".padEnd(8)}status after the step`];
  for (const r of rows) lines.push(`${r.label.padEnd(29)}${(r.read === null ? "" : hex(r.read)).padEnd(8)}${r.status}`);
  const last = rows[rows.length - 1].state;
  lines.push(`sent to the terminal: ${quoteBytes(last.tx)}`);
  return lines.join("\n");
}

// ---- the lesson's walk and the share state -------------------------------------------------

/** The walk in course/captures/09-poke.txt. */
export const REFERENCE = Object.freeze([
  { op: "w", off: REG.DR, size: 4, val: 0x68 },
  { op: "w", off: REG.IMSC, size: 4, val: 0x10 },
  { op: "h", bytes: [0x6f, 0x6b] },
  { op: "w", off: REG.ICR, size: 4, val: 0x70 },
  { op: "r", off: REG.DR, size: 4 },
  { op: "r", off: REG.DR, size: 4 },
  { op: "r", off: REG.DR, size: 4 },
]);

export const MAX_HASH = 4096;

function encodeAction(a) {
  const sz = a.size === 4 ? "" : `.${a.size}`;
  if (a.op === "h") return "h" + a.bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  if (a.op === "r") return `r${a.off.toString(16)}${sz}`;
  return `w${a.off.toString(16)}.${a.val.toString(16)}${sz}`;
}

function decodeAction(tok) {
  let m = /^h((?:[0-9a-f]{2}){1,64})$/.exec(tok);
  if (m) {
    const bytes = [];
    for (let i = 0; i < m[1].length; i += 2) bytes.push(parseInt(m[1].slice(i, i + 2), 16));
    return { op: "h", bytes };
  }
  m = /^r([0-9a-f]{1,3})(?:\.([1248]))?$/.exec(tok);
  if (m) return { op: "r", off: parseInt(m[1], 16), size: m[2] ? Number(m[2]) : 4 };
  m = /^w([0-9a-f]{1,3})\.([0-9a-f]{1,8})(?:\.([1248]))?$/.exec(tok);
  if (m) return { op: "w", off: parseInt(m[1], 16), val: parseInt(m[2], 16), size: m[3] ? Number(m[3]) : 4 };
  return null;
}

/**
 * Share state: the actions joined by "_", then "~N" when only the first N are applied.
 * The finished lesson walk is "w0.68_w38.10_h6f6b_w44.70_r0_r0_r0".
 */
export function encodeShare({ actions, cursor }) {
  const body = actions.map(encodeAction).join("_");
  return cursor < actions.length ? `${body}~${cursor}` : body;
}

/** Parse a share string; null for anything malformed, too long or out of range. */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length > MAX_HASH) return null;
  const m = /^([0-9a-z._]*)(?:~(\d{1,3}))?$/.exec(str);
  if (!m) return null;
  const toks = m[1] === "" ? [] : m[1].split("_");
  if (toks.length > MAX_ACTIONS) return null;
  const actions = [];
  for (const t of toks) {
    const a = decodeAction(t);
    if (!a || validateAction(a)) return null;
    actions.push(a);
  }
  const cursor = m[2] === undefined ? actions.length : Number(m[2]);
  if (cursor > actions.length) return null;
  return { actions, cursor };
}

// ---- parsing what the reader types -------------------------------------------------------

/** Parse a hex (0x...) or decimal number typed by the reader; null if it is not one. */
export function parseNumber(text, max = 0xffffffff) {
  const t = String(text).trim().toLowerCase().replace(/_/g, "");
  let v;
  if (/^0x[0-9a-f]{1,8}$/.test(t)) v = parseInt(t.slice(2), 16);
  else if (/^[0-9]{1,10}$/.test(t)) v = Number(t);
  else return null;
  return Number.isSafeInteger(v) && v <= max ? v : null;
}

/** The bytes a host push of `text` sends (UTF-8), or an error. */
export function textToBytes(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  if (bytes.length === 0) return { error: "type something first" };
  if (bytes.length > MAX_PUSH) return { error: `at most ${MAX_PUSH} bytes per push` };
  return { bytes };
}

// ---- prediction --------------------------------------------------------------------------

/** Score a prediction of the interrupt line after the next step ("high", "low" or null). */
export function scoreLine(guess, actualHigh) {
  if (guess !== "high" && guess !== "low") return null;
  return { right: (guess === "high") === actualHigh, guess, actual: actualHigh ? "high" : "low" };
}
