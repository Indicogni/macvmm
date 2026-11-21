// pstate-builder model: build and read PSTATE values in SPSR layout (chapter 06).
//
// Pure ES module: no DOM, no I/O at import time, so `node --test` imports it directly.
// The mode names and mask bits come from the exception-stepper lab's `pstate.mjs`, so the two labs
// can never disagree about what `0x3c5` means. This file adds what chapter 06 needs on top:
//   - one state object and a pure `step(state, action)`;
//   - a hardened hex parser for the value box and the share link;
//   - the register dump's own text (`EL1h, DAIF, nzcv`), a line-for-line port of
//     `impl Display for Pstate` in crates/vmm/src/arch/regs.rs;
//   - what the guest reads back (`mrs x0, daif`, `mrs x0, CurrentEL`, `mrs x0, nzcv`);
//   - the lesson's "build it from the fields" sum (`0x3c0 | 0x4 | 0x1 = 0x3c5`);
//   - what our VMM did with the three boot values chapter 06 actually ran (real captures).
//
// Layout: Arm Architecture Reference Manual (DDI 0487), the SPSR_EL1 register page, AArch64 view.

import { decodePstate, modeName, FLAG_BITS, DAIF_BITS } from "../exception-stepper/pstate.mjs";

export { decodePstate, modeName, FLAG_BITS, DAIF_BITS };

/** The boot value every guest in the course starts with: EL1h, D A I F masked. */
export const DEFAULT_VALUE = 0x3c5;

/** Longest text the hex parser looks at. Anything longer is rejected before any work is done. */
export const MAX_INPUT = 32;

export const NRW_BIT = 4;
export const SP_BIT = 0;
export const PAN_BIT = 22;
export const TCO_BIT = 25;
/**
 * PAN (bit 22) and TCO (bit 25) are real PSTATE fields (ARM ARM, SPSR_EL1), not reserved bits.
 * The CPU sets them itself on an exception to EL1 (chapter 06's Aside on `cpsr=0x824003c5`), so
 * this lab decodes them as known, harmless, non-mode bits rather than as an error.
 */
export const CPU_SET_MASK = ((1 << PAN_BIT) | (1 << TCO_BIT)) >>> 0;

const MASK_TEXT = Object.freeze({
  D: "debug exceptions (breakpoints, watchpoints, single-step; never brk)",
  A: "SError, the system error",
  I: "IRQ, the interrupt request",
  F: "FIQ, the fast interrupt request",
});
const FLAG_TEXT = Object.freeze({ N: "negative", Z: "zero", C: "carry", V: "overflow" });

/**
 * One entry per bit, 31 down to 0: what the lab draws in the bit bar.
 * `group` ties neighbouring bits to one field label; `modelled` is false for bits this lab
 * (and the course) never sets, which must be 0 for the value to decode.
 */
export const BITS = Object.freeze(
  Array.from({ length: 32 }, (_, i) => {
    const bit = 31 - i;
    for (const [k, b] of Object.entries(FLAG_BITS)) {
      if (b === bit) return Object.freeze({ bit, short: k, group: "flags", modelled: true, name: `${k}, the ${FLAG_TEXT[k]} flag` });
    }
    for (const [k, b] of Object.entries(DAIF_BITS)) {
      if (b === bit) return Object.freeze({ bit, short: k, group: "daif", modelled: true, name: `${k}, masks ${MASK_TEXT[k]}` });
    }
    if (bit === NRW_BIT) return Object.freeze({ bit, short: "nRW", group: "m", modelled: true, name: "nRW: 0 means 64-bit (AArch64), 1 means 32-bit (AArch32)" });
    // The level is one 2-bit number, so the two cells are named by position (M3, M2), never as
    // "EL1"/"EL0": binary 01 means EL1. Their accessible names carry the place value.
    if (bit === 3) return Object.freeze({ bit, short: "M3", group: "m", modelled: true, name: "exception level, high bit (value 2)" });
    if (bit === 2) return Object.freeze({ bit, short: "M2", group: "m", modelled: true, name: "exception level, low bit (value 1)" });
    if (bit === 1) return Object.freeze({ bit, short: "res", group: "m", modelled: true, name: "reserved, must be 0" });
    if (bit === SP_BIT) return Object.freeze({ bit, short: "SP", group: "m", modelled: true, name: "SP, the stack-pointer select: 1 uses the level's own stack pointer, 0 uses SP_EL0" });
    if (bit === PAN_BIT) return Object.freeze({ bit, short: "PAN", group: "other", modelled: true, name: "PAN, privileged access never: the CPU sets it on exception entry; harmless to our guests" });
    if (bit === TCO_BIT) return Object.freeze({ bit, short: "TCO", group: "other", modelled: true, name: "TCO, tag check override: the CPU sets it on exception entry; harmless to our guests" });
    if (bit === 5) return Object.freeze({ bit, short: "res", group: "other", modelled: false, name: "reserved, keep at 0" });
    return Object.freeze({ bit, short: "", group: "other", modelled: false, name: "not used in this course, keep at 0" });
  }),
);

/** Values worth trying, in the order the lesson meets them. */
export const PRESETS = Object.freeze([
  { value: 0x3c5, label: "0x3c5: the boot value (EL1h)" },
  { value: 0x3c4, label: "0x3c4: the EL1t mistake" },
  { value: 0x3c9, label: "0x3c9: EL2h, refused" },
  { value: 0x0, label: "0x0: an app (EL0t), nothing masked" },
  { value: 0xf0000004, label: "0xf0000004: EL1t, all four flags set" },
  { value: 0x60000105, label: "0x60000105: EL1h, only SError masked, Z and C set" },
  { value: 0x824003c5, label: "0x824003c5: EL1h from a fault dump, PAN and TCO set" },
  { value: 0x10, label: "0x10: bit 4 set (32-bit state)" },
]);

/**
 * What our VMM did when chapter 06 used each of these as the boot CPSR, with the `regcheck` guest.
 * Every line is quoted from a real capture in course/captures (the tests read the files).
 */
export const OBSERVED = Object.freeze({
  0x3c5: Object.freeze({
    capture: "06-regcheck-run.txt",
    exit: 0,
    text: "regcheck printed all six lines, ending with vectors ok, and exited with code 0.",
    lastLine: "regcheck: vectors ok (svc caught at EL1, esr=0x5600004d)",
  }),
  0x3c4: Object.freeze({
    capture: "06-cpsr-3c4.txt",
    exit: 5,
    text: "regcheck printed five lines, never vectors ok, then hung until --timeout stopped it (exit code 5). Its exception handler ran on SP_EL1, which nobody had set.",
    lastLine: "macvmm: timeout: the guest was still running after --timeout 10s",
  }),
  0x3c9: Object.freeze({
    capture: "06-cpsr-3c9.txt",
    exit: 1,
    text: "hv_vcpu_run refused the state before the guest ran a single instruction (exit code 1): our guests are not offered EL2.",
    lastLine: "macvmm: error: run vCPU: hv_vcpu_run: HV_ILLEGAL_GUEST_STATE (0xfae94004)",
  }),
});

// ---------------------------------------------------------------------------------------------
// Formatting helpers

/** `0x3c5`: lower-case hex, no padding, the way the lesson and the dump write PSTATE. */
export function hex(v) {
  return `0x${(v >>> 0).toString(16)}`;
}

/** Four binary digits of M[3:0], e.g. `0101`. */
export function m30(v) {
  return ((v >>> 0) & 0xf).toString(2).padStart(4, "0");
}

/** True when bit 4 (nRW) is set: the value is an AArch32 mode, so EL and SP fields do not apply. */
export function isAArch32(v) {
  return ((v >>> 0) & (1 << NRW_BIT)) !== 0;
}

/**
 * Decode with this lab's view of the shared decoder: PAN and TCO are known, non-mode bits, and the
 * AArch32 error names bit 4 the way the bit bar and the lesson do (nRW).
 */
export function decodeValue(value) {
  const v = value >>> 0;
  const d = decodePstate((v & ~CPU_SET_MASK) >>> 0);
  const out = { ...d, value: v };
  if (!d.ok && isAArch32(v)) out.error = "bit 4 (nRW) = 1: 32-bit AArch32 state, not used here";
  return out;
}

/** Which stack pointer `sp` means in this mode (`n/a` for AArch32, where M[4:0] is a mode number). */
export function stackName(v) {
  if (isAArch32(v)) return "n/a";
  const el = ((v >>> 0) >>> 2) & 3;
  return el !== 0 && (v & 1) === 1 ? `SP_EL${el}` : "SP_EL0";
}

/** Mode name exactly as `Pstate::mode_name` in crates/vmm/src/arch/regs.rs returns it. */
export function dumpModeName(value) {
  const v = value >>> 0;
  if (v & (1 << NRW_BIT)) return "AArch32";
  const el = (v >>> 2) & 3;
  const h = (v & 1) === 1;
  if (el === 0) return "EL0t";
  return `EL${el}${h ? "h" : "t"}`;
}

/** Upper case when the bit is set, lower case when clear (`DAIF`, `dAif`, `nZCv`). */
function letters(v, table) {
  return Object.entries(table)
    .map(([k, bit]) => (((v >>> bit) & 1) === 1 ? k : k.toLowerCase()))
    .join("");
}

/** The register dump's text for a CPSR value: `EL1h, DAIF, nzcv` (port of `impl Display for Pstate`). */
export function dumpText(value) {
  const v = value >>> 0;
  return `${dumpModeName(v)}, ${letters(v, DAIF_BITS)}, ${letters(v, FLAG_BITS)}`;
}

/** Masked exception letters in D A I F order, e.g. `["D", "A", "I", "F"]`. */
export function maskedLetters(value) {
  return Object.entries(DAIF_BITS)
    .filter(([, bit]) => (((value >>> 0) >>> bit) & 1) === 1)
    .map(([k]) => k);
}

/** Set flag letters in N Z C V order. */
export function setFlags(value) {
  return Object.entries(FLAG_BITS)
    .filter(([, bit]) => (((value >>> 0) >>> bit) & 1) === 1)
    .map(([k]) => k);
}

/** The lesson's text-fallback row: `0x3c5    0101     EL1h   SP_EL1          D A I F`. */
export function fallbackRow(value) {
  const v = value >>> 0;
  const masked = maskedLetters(v);
  const col = (text, width) => (text.length >= width ? `${text} ` : text.padEnd(width));
  return [col(hex(v), 9), col(isAArch32(v) ? "n/a" : m30(v), 9), col(dumpModeName(v), 7), col(stackName(v), 16), masked.length ? masked.join(" ") : "none"]
    .join("")
    .trimEnd();
}

/**
 * The lesson's "build it from the fields" sum. For 0x3c5:
 *   terms   [{what: "mask D A I F", value: 0x3c0, detail: "0x200 + 0x100 + 0x80 + 0x40"}, ...]
 *   formula "0x3c0 | 0x4 | 0x1 = 0x3c5"
 */
export function buildSteps(value) {
  const v = value >>> 0;
  const terms = [];
  const flagBits = setFlags(v).map((k) => (1 << FLAG_BITS[k]) >>> 0);
  if (flagBits.length) {
    terms.push({ what: `set flags ${setFlags(v).join(" ")}`, value: flagBits.reduce((a, b) => (a | b) >>> 0, 0), detail: flagBits.map(hex).join(" + ") });
  }
  const daifBits = maskedLetters(v).map((k) => 1 << DAIF_BITS[k]);
  if (daifBits.length) {
    terms.push({ what: `mask ${maskedLetters(v).join(" ")}`, value: daifBits.reduce((a, b) => a | b, 0), detail: daifBits.map(hex).join(" + ") });
  }
  const cpu = (v & CPU_SET_MASK) >>> 0;
  if (cpu) {
    const names = [[PAN_BIT, "PAN"], [TCO_BIT, "TCO"]].filter(([bit]) => (v >>> bit) & 1).map(([, n]) => n);
    const detail = names.length === 2 ? "0x400000 + 0x2000000" : names[0] === "TCO" ? "1 << 25" : "1 << 22";
    terms.push({ what: `${names.join(" and ")} (the CPU sets ${names.length === 2 ? "these" : "this"} on exception entry)`, value: cpu, detail });
  }
  if (v & (1 << NRW_BIT)) terms.push({ what: "32-bit state (nRW)", value: 0x10, detail: "1 << 4" });
  const el = (v >>> 2) & 3;
  if (el) terms.push({ what: `run at EL${el}`, value: el << 2, detail: `${el} << 2` });
  if (v & 2) terms.push({ what: "reserved bit 1", value: 2, detail: "1 << 1" });
  if (v & 1) {
    let what;
    if (isAArch32(v)) what = "bit 0 (part of the AArch32 mode number)";
    else if (el === 0) what = "M[0] = 1 at EL0 (reserved: EL0 has no own stack)";
    else what = `use ${stackName(v)}`;
    terms.push({ what, value: 1, detail: "bit 0" });
  }
  const known = terms.reduce((a, t) => (a | t.value) >>> 0, 0);
  const rest = (v & ~known) >>> 0;
  if (rest) terms.push({ what: "other bits", value: rest, detail: "bits this lab does not model" });
  const formula = terms.length === 0 ? "nothing set: 0x0" : terms.length === 1 ? `${terms[0].what}: ${hex(v)}` : `${terms.map((t) => hex(t.value)).join(" | ")} = ${hex(v)}`;
  return { terms, formula };
}

/**
 * What a guest running in this PSTATE would read back with `mrs`. Only bits of PSTATE that exist
 * as a readable register are shown (DAIF, CurrentEL, NZCV, SPSel). At EL0 only NZCV is readable:
 * CurrentEL and SPSel are UNDEFINED there, and DAIF traps unless SCTLR_EL1.UMA is set (ARM ARM,
 * the CurrentEL, SPSel and DAIF register pages). An unreadable row has `value: null`.
 * `describe()` decides whether a guest ever runs in this state (it never does at EL2 or EL3).
 */
export function guestReads(value) {
  const v = value >>> 0;
  if (((v >>> 2) & 3) === 0) {
    return [
      { insn: "mrs x0, daif", value: null, note: "traps to EL1 unless SCTLR_EL1.UMA is set" },
      { insn: "mrs x0, CurrentEL", value: null, note: "not readable at EL0 (undefined instruction)" },
      { insn: "mrs x0, nzcv", value: (v & 0xf0000000) >>> 0, note: "bits 31 to 28, in place" },
      { insn: "mrs x0, SPSel", value: null, note: "not readable at EL0 (undefined instruction)" },
    ];
  }
  return [
    { insn: "mrs x0, daif", value: v & 0x3c0, note: "bits 9 to 6, in place" },
    { insn: "mrs x0, CurrentEL", value: ((v >>> 2) & 3) << 2, note: "the level in bits 3 to 2" },
    { insn: "mrs x0, nzcv", value: (v & 0xf0000000) >>> 0, note: "bits 31 to 28, in place" },
    { insn: "mrs x0, SPSel", value: v & 1, note: "bit 0 alone" },
  ];
}

/** Everything the view shows for a value, in one object. */
export function describe(value) {
  const v = value >>> 0;
  const d = decodeValue(v);
  const el = (v >>> 2) & 3;
  const observed = OBSERVED[v] ?? null;
  const masked = maskedLetters(v);
  const flags = setFlags(v);
  const out = {
    value: v,
    hex: hex(v),
    ok: d.ok,
    error: d.ok ? null : d.error,
    mode: d.ok ? d.mode : null,
    m30: isAArch32(v) ? "n/a" : m30(v),
    el,
    stack: stackName(v),
    masked,
    unmasked: Object.keys(DAIF_BITS).filter((k) => !masked.includes(k)),
    flags,
    dump: dumpText(v),
    steps: buildSteps(v),
    reads: [],
    readsNote: null,
    cpuBits: [[PAN_BIT, "PAN"], [TCO_BIT, "TCO"]].filter(([b]) => (v >>> b) & 1).map(([, n]) => n),
    observed,
    hvfNote: null,
  };
  if (d.ok) {
    if (observed && observed.exit !== 0 && el >= 2) {
      out.readsNote = "No reads: HVF refused this state before the first instruction.";
    } else if (el === 3) {
      out.readsNote = "No reads: EL3 does not exist on Apple silicon, so no guest ever runs there.";
    } else if (el === 2) {
      out.readsNote = "No reads shown: our guests are not offered EL2, so a guest never runs at this level.";
    } else {
      out.reads = guestReads(v);
    }
  }
  if (d.ok && el === 3) {
    out.hvfNote = "EL3 does not exist on Apple silicon; no guest can run there.";
  } else if (d.ok && el === 2 && !observed) {
    out.hvfNote = "EL2 is above the level our guests are offered. The course ran only 0x3c9 of these, which hv_vcpu_run refused; we have not checked this value.";
  }
  return out;
}

/** One-line plain-text summary for the readout and the live region. */
export function summary(value) {
  const x = describe(value);
  const maskedText = x.masked.length ? `masks ${x.masked.join(" ")}` : "masks nothing";
  const flagText = x.flags.length ? `flags ${x.flags.join(" ")} set` : "no flags set";
  if (!x.ok) return `${x.hex}: ${x.error}. The register dump prints ${x.dump}.`;
  const cpuText = x.cpuBits.length ? `, ${x.cpuBits.join(" and ")} set` : "";
  return `${x.hex} is ${x.mode}: EL${x.el}, sp means ${x.stack}, ${maskedText}, ${flagText}${cpuText}. The register dump prints ${x.dump}.`;
}

/** Short spoken form: the mode (or the problem) and the value, without the dump's letter soup. */
export function shortSummary(value) {
  const x = describe(value);
  if (!x.ok) return `${x.error}, value ${x.hex}`;
  return `${x.mode}, sp means ${x.stack.replace("_", " ")}, value ${x.hex}`;
}

/**
 * What the live region says after a change: a short delta first, then the short summary.
 *   0x3c5 -> 0x3c4  "bit 0 off: EL1t, sp means SP EL0, value 0x3c4"
 */
export function changeText(prevValue, nextValue) {
  const diff = ((prevValue ^ nextValue) >>> 0);
  let head;
  if (diff === 0) head = "no change";
  else if ((diff & (diff - 1)) === 0) {
    const bit = 31 - Math.clz32(diff);
    head = `bit ${bit} ${((nextValue >>> bit) & 1) === 1 ? "on" : "off"}`;
  } else {
    let n = 0;
    for (let d = diff; d; d &= d - 1) n++;
    head = `${n} bits changed`;
  }
  return `${head}: ${shortSummary(nextValue)}`;
}

// ---------------------------------------------------------------------------------------------
// Parsing (value box and share link). Hostile input: bounded length, explicit errors.

/**
 * Parse a 32-bit hex value. Accepts an optional `0x`, underscores between digits and surrounding
 * spaces (`0x3c5`, `3C5`, `0xf000_0004`). Returns `{ ok: true, value }` or `{ ok: false, error }`.
 */
export function parseHex(input) {
  if (typeof input !== "string") return { ok: false, error: "type a hex number such as 0x3c5" };
  if (input.length > MAX_INPUT) return { ok: false, error: `too long (at most ${MAX_INPUT} characters)` };
  let s = input.trim();
  if (/^0x/i.test(s)) s = s.slice(2);
  if (s === "") return { ok: false, error: "type a hex number such as 0x3c5" };
  if (!/^[0-9a-f]+(_[0-9a-f]+)*$/i.test(s)) return { ok: false, error: "only hex digits 0-9 and a-f (underscores between digits are fine)" };
  const digits = s.replaceAll("_", "").replace(/^0+(?=.)/, "");
  if (digits.length > 8) return { ok: false, error: "PSTATE in SPSR layout is 32 bits: at most 8 hex digits" };
  return { ok: true, value: Number.parseInt(digits, 16) >>> 0 };
}

// ---------------------------------------------------------------------------------------------
// State

/**
 * `savedSp` remembers that picking EL0 cleared the stack-pointer bit, so picking EL1 or above
 * again turns it back on (0x3c5 -> EL0 -> EL1 returns to 0x3c5, not silently to 0x3c4).
 */
export function initialState(value = DEFAULT_VALUE, savedSp = false) {
  return Object.freeze({ value: value >>> 0, savedSp: !!savedSp });
}

function withBit(v, bit, on) {
  return (on ? v | (1 << bit) : v & ~(1 << bit)) >>> 0;
}

/**
 * Pure transition. Actions:
 *   {type: "set", value}            any 32-bit integer
 *   {type: "toggle", bit}           0..31
 *   {type: "level", el}             0..3 (EL0 also clears SP, since EL0 has no stack of its own)
 *   {type: "ownSp", on}             bit 0 (refused at EL0, where M[0] = 1 is reserved)
 *   {type: "mask", key, on}         key in D A I F
 *   {type: "flag", key, on}         key in N Z C V
 *   {type: "reset"}
 * Invalid actions return the same state object, so the view can tell "nothing changed".
 */
export function step(state, action) {
  const v = state.value >>> 0;
  let next = v;
  let savedSp = !!state.savedSp;
  switch (action && action.type) {
    case "set":
      if (!Number.isInteger(action.value) || action.value < 0 || action.value > 0xffffffff) return state;
      next = action.value >>> 0;
      savedSp = false;
      break;
    case "toggle":
      if (!Number.isInteger(action.bit) || action.bit < 0 || action.bit > 31) return state;
      next = (v ^ (1 << action.bit)) >>> 0;
      savedSp = false;
      break;
    case "level": {
      if (!Number.isInteger(action.el) || action.el < 0 || action.el > 3) return state;
      const from = (v >>> 2) & 3;
      next = ((v & ~0xc) | (action.el << 2)) >>> 0;
      if (action.el === 0) {
        if (from !== 0 && (v & 1) === 1) savedSp = true;
        next = withBit(next, SP_BIT, false);
      } else if (from === 0 && savedSp) {
        next = withBit(next, SP_BIT, true);
        savedSp = false;
      }
      break;
    }
    case "ownSp":
      if (action.on && ((v >>> 2) & 3) === 0) return state;
      next = withBit(v, SP_BIT, !!action.on);
      savedSp = false;
      break;
    case "mask":
      if (!Object.hasOwn(DAIF_BITS, action.key)) return state;
      next = withBit(v, DAIF_BITS[action.key], !!action.on);
      break;
    case "flag":
      if (!Object.hasOwn(FLAG_BITS, action.key)) return state;
      next = withBit(v, FLAG_BITS[action.key], !!action.on);
      break;
    case "reset":
      next = DEFAULT_VALUE;
      savedSp = false;
      break;
    default:
      return state;
  }
  return next === v && savedSp === !!state.savedSp ? state : initialState(next, savedSp);
}

// ---------------------------------------------------------------------------------------------
// Share state: `#pstate-builder=0x3c4`. The default value clears the hash.

export function encode(state) {
  return state.value === DEFAULT_VALUE ? null : hex(state.value);
}

export function decode(str) {
  if (str === null || str === undefined) return null;
  const r = parseHex(String(str));
  return r.ok ? initialState(r.value) : null;
}
