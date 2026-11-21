// ESR decoder lab: the model. Pure logic, no DOM, so `node --test` can import it.
//
// It mirrors macvmm's own decoder, crates/vmm/src/arch/esr.rs (`Exit::decode`, `Exit::from_hv`
// and the `Display` impls), field for field and string for string, so the lab can be checked
// against the same vectors (course/site/labs/vectors/esr.json) and against the real dumps in
// course/captures. Source of the layouts: Arm Architecture Reference Manual (DDI 0487), register
// page "ESR_EL2, Exception Syndrome Register (EL2)", the EC table and the ISS encodings for a
// Data Abort, an Instruction Abort, HVC/SMC/SVC/BRK, WFI/WFE and MSR/MRS.
//
// The syndrome is 64 bits wide, so values are BigInt throughout. Like the Rust decoder, every
// function here is total: any 64-bit value (and any string typed into the box) gives an answer,
// never an exception.

import { SYSREG_NAMES } from "./sysregs.mjs";

export const MASK64 = (1n << 64n) - 1n;
const MAX_INPUT = 64; // characters; a 64-bit value with 0x and underscores fits easily

// ---------------------------------------------------------------------------------------------
// Bits and fields

/** `width` bits of `v` starting at bit `lo`, as a Number (width <= 32). */
export function field(v, lo, width) {
  return Number((BigInt.asUintN(64, v) >> BigInt(lo)) & ((1n << BigInt(width)) - 1n));
}

export function bit(v, n) {
  return field(v, n, 1) === 1;
}

/**
 * `v` with bits [lo, lo+width) replaced by `value` (masked to the width). `value` may be a
 * BigInt (exact at any width) or a Number (exact up to 2^53); NaN, Infinity and anything that is
 * not a number count as 0, so this never throws.
 */
export function setField(v, lo, width, value) {
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(lo);
  let big = 0n;
  if (typeof value === "bigint") big = value;
  else {
    const num = Number(value);
    big = BigInt(Number.isFinite(num) ? Math.trunc(num) : 0);
  }
  const n = BigInt.asUintN(width, big);
  return BigInt.asUintN(64, (BigInt.asUintN(64, v) & ~mask) | (n << BigInt(lo)));
}

export function toggleBit(v, n) {
  if (!Number.isInteger(n) || n < 0 || n > 63) return BigInt.asUintN(64, v);
  return BigInt.asUintN(64, v) ^ (1n << BigInt(n));
}

export const esrEc = (esr) => field(esr, 26, 6);
export const esrIl = (esr) => bit(esr, 25);
export const esrIss = (esr) => field(esr, 0, 25);
/**
 * ISS2, bits 55:32. Armv8.7 introduced it as bits 36:32 (FEAT_LS64); later editions of DDI 0487
 * widened it to 55:32, which is what the reading-arm-specs primer quotes. macvmm ignores it.
 */
export const esrIss2 = (esr) => field(esr, 32, 24);
/** Bits 63:32 as a BigInt: what the 32-bit bar does not show. */
export const esrHigh = (esr) => BigInt.asUintN(64, esr) >> 32n;

/** Rust's `{:#x}`: lowercase, no padding. */
export function hex(n) {
  return "0x" + BigInt.asUintN(64, BigInt(n)).toString(16);
}

/** `{:#04x}`: at least two digits. */
export function hex2(n) {
  return "0x" + n.toString(16).padStart(2, "0");
}

/** The value as 0x9389_0046 (or 0xffff_ff1f_9381_3b46 when bits 63:32 are set). */
export function hexGrouped(esr) {
  const v = BigInt.asUintN(64, esr);
  const digits = v.toString(16).padStart(v > 0xffffffffn ? 16 : 8, "0");
  return "0x" + digits.replace(/(.{4})(?=.)/g, "$1_");
}

export function bin(n, width) {
  return "0b" + n.toString(2).padStart(width, "0");
}

// ---------------------------------------------------------------------------------------------
// Parsing what the reader types

/**
 * Parse a syndrome typed by the reader: optional `0x`/`0X`, hex digits, underscores and spaces
 * as separators. Bare digits are read as hex, as every ESR in the course is written in hex.
 * Returns `{ ok: true, value }` or `{ ok: false, error }`; never throws.
 */
export function parseEsr(text) {
  if (typeof text !== "string") return { ok: false, error: "Type a value such as 0x93890046." };
  if (text.length > MAX_INPUT) return { ok: false, error: `That is longer than ${MAX_INPUT} characters; ESR_EL2 is 64 bits (16 hex digits).` };
  let s = text.trim();
  if (s === "") return { ok: false, error: "Type a value such as 0x93890046." };
  if (/^0x/i.test(s)) s = s.slice(2);
  s = s.replace(/[_\s]/g, "");
  if (s === "") return { ok: false, error: "No hex digits after 0x." };
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    const bad = s.match(/[^0-9a-fA-F]/)[0];
    return { ok: false, error: `"${bad}" is not a hex digit. Use 0-9 and a-f, with optional 0x and underscores.` };
  }
  s = s.replace(/^0+(?=.)/, "");
  if (s.length > 16) return { ok: false, error: "That needs more than 64 bits; ESR_EL2 is 64 bits (16 hex digits)." };
  return { ok: true, value: BigInt("0x" + s) };
}

/**
 * Parse what the reader typed into one field's box in the field table. `radix` is the field's
 * default base for bare digits: 10 for the fields macvmm's dump prints in decimal (register
 * numbers such as SRT and Rt, SAS, the system-register operands), so "set SRT to 31" means
 * register 31; 16 for the rest (EC, DFSC, imm16), which the course writes in hex. Either kind also
 * takes `0x` for hex and `0b` for binary. A value wider than the field is masked to it, as
 * `setField` and the Rust field helpers do, and `message` says so out loud (with a hint when bare
 * digits were probably meant as decimal). Returns `{ ok: true, value, masked, message }` or
 * `{ ok: false, error }`; never throws.
 */
export function parseFieldValue(text, width, name = "This field", radix = 16) {
  const w = Number(width);
  const dec = radix === 10;
  const how = dec ? `in decimal (31), or in hex with 0x` : `in hex (0x16)`;
  if (typeof text !== "string" || !Number.isInteger(w) || w < 1 || w > 32) return { ok: false, error: "Type a value in hex, such as 0x16." };
  if (text.length > 40) return { ok: false, error: "That is too long for one field." };
  let s = text.trim().replace(/[_\s]/g, "");
  let base = dec ? 10 : 16;
  let prefixed = false;
  if (/^0b/i.test(s)) { base = 2; s = s.slice(2); prefixed = true; }
  else if (/^0x/i.test(s)) { base = 16; s = s.slice(2); prefixed = true; }
  if (s === "") return { ok: false, error: `Type ${name} ${how}, or in binary with 0b.` };
  const digits = base === 2 ? /^[01]+$/ : base === 10 ? /^[0-9]+$/ : /^[0-9a-fA-F]+$/;
  if (!digits.test(s)) {
    const bad = s.match(base === 2 ? /[^01]/ : base === 10 ? /[^0-9]/ : /[^0-9a-fA-F]/)[0];
    const kind = base === 2 ? "binary" : base === 10 ? "decimal" : "hex";
    return { ok: false, error: `"${bad}" is not a ${kind} digit. Type ${name} ${how}, or in binary with 0b.` };
  }
  const raw = base === 2 ? BigInt("0b" + s) : base === 10 ? BigInt(s) : BigInt("0x" + s);
  const max = (1n << BigInt(w)) - 1n;
  const value = Number(raw & max);
  const masked = raw > max;
  let message = "";
  if (masked) {
    const range = dec ? `0 to ${max}` : `0x0 to ${hex(max)}`;
    const shown = (x) => (dec && !prefixed ? String(x) : hex(x));
    message = `${name} is ${w} bit${w > 1 ? "s" : ""}: ${range}. ${shown(raw)} was masked to ${shown(BigInt(value))} (only its low ${w} bit${w > 1 ? "s" : ""} fit).`;
    // Bare digits in a hex field that would fit if read as decimal: say how to type that.
    if (!dec && !prefixed && /^[0-9]+$/.test(s) && BigInt(s) <= max) {
      message += ` Bare digits are hex in this box; for decimal ${BigInt(s)}, type ${hex(BigInt(s))}.`;
    }
  }
  return { ok: true, value, masked, message };
}

/** The text a field's box shows: decimal for the decimal fields, hex for the rest. */
export function fieldText(value, radix = 16) {
  return radix === 10 ? String(value) : hex(value);
}

// ---------------------------------------------------------------------------------------------
// Exception classes (crates/vmm/src/arch/esr.rs, `pub mod ec` and `ec_name`)

export const EC = Object.freeze({
  UNKNOWN: 0x00,
  WFX: 0x01,
  SVC64: 0x15,
  HVC64: 0x16,
  SMC64: 0x17,
  SYSREG: 0x18,
  IABT_LOWER: 0x20,
  IABT_CUR: 0x21,
  DABT_LOWER: 0x24,
  DABT_CUR: 0x25,
  BRK64: 0x3c,
});

const EC_NAMES = new Map([
  [0x00, "unknown reason"],
  [0x01, "WFI/WFE"],
  [0x07, "SVE/SIMD/FP access"],
  [0x0e, "illegal execution state"],
  [0x15, "SVC (AArch64)"],
  [0x16, "HVC (AArch64)"],
  [0x17, "SMC (AArch64)"],
  [0x18, "MSR/MRS/system instruction"],
  [0x19, "SVE access"],
  [0x20, "instruction abort from a lower EL"],
  [0x21, "instruction abort, same EL"],
  [0x22, "PC alignment fault"],
  [0x24, "data abort from a lower EL"],
  [0x25, "data abort, same EL"],
  [0x26, "SP alignment fault"],
  [0x2c, "floating-point exception"],
  [0x2f, "SError"],
  [0x30, "breakpoint"],
  [0x31, "breakpoint"],
  [0x32, "software step"],
  [0x33, "software step"],
  [0x34, "watchpoint"],
  [0x35, "watchpoint"],
  [0x3c, "BRK (AArch64)"],
]);

/** macvmm's `ec_name`: a static name, or null for a class it does not name. */
export function ecName(ec) {
  return EC_NAMES.get(ec) ?? null;
}

/** macvmm's `fsc_name` (DFSC/IFSC, long-descriptor format). */
export function fscName(fsc) {
  if (fsc <= 0x03) return "address size fault";
  if (fsc <= 0x07) return "translation fault";
  if (fsc <= 0x0b) return "access flag fault";
  if (fsc <= 0x0f) return "permission fault";
  switch (fsc) {
    case 0x10: return "synchronous external abort";
    case 0x11: return "synchronous tag check fault";
    case 0x14: case 0x15: case 0x16: case 0x17: return "synchronous external abort on a table walk";
    case 0x21: return "alignment fault";
    case 0x30: return "TLB conflict abort";
    default: return null;
  }
}

/** The translation-table level a fault status code names, or null. */
export function fscLevel(fsc) {
  if (fsc <= 0x0f || (fsc >= 0x14 && fsc <= 0x17)) return fsc & 3;
  return null;
}

/** "Translation fault, level 2 (DFSC 0b000110)". */
export function fscText(fsc, label = "DFSC") {
  const name = fscName(fsc);
  if (!name) return `Fault status code ${bin(fsc, 6)} (${label}), which macvmm does not name; look it up in the ${label} table`;
  const lvl = fscLevel(fsc);
  const cap = name[0].toUpperCase() + name.slice(1);
  return `${cap}${lvl === null ? "" : `, level ${lvl}`} (${label} ${bin(fsc, 6)})`;
}

// ---------------------------------------------------------------------------------------------
// The decoder (Exit::decode / Exit::from_hv)

export function decodeDataAbort(esr) {
  return {
    isv: bit(esr, 24),
    sas: field(esr, 22, 2),
    sse: bit(esr, 21),
    srt: field(esr, 16, 5),
    sf: bit(esr, 15),
    ar: bit(esr, 14),
    fnv: bit(esr, 10),
    s1ptw: bit(esr, 7),
    wnr: bit(esr, 6),
    dfsc: field(esr, 0, 6),
  };
}

export function decodeSysreg(esr) {
  return {
    op0: field(esr, 20, 2),
    op1: field(esr, 14, 3),
    crn: field(esr, 10, 4),
    crm: field(esr, 1, 4),
    op2: field(esr, 17, 3),
    rt: field(esr, 5, 5),
    read: bit(esr, 0),
  };
}

/** `Exit::decode` for an EXCEPTION exit. Returns `{ kind, ...fields }`. */
export function decode(esr) {
  const v = BigInt.asUintN(64, esr);
  const imm = field(v, 0, 16);
  const ec = esrEc(v);
  switch (ec) {
    case EC.WFX: return { kind: "Wfx", ti: field(v, 0, 2) };
    case EC.HVC64: return { kind: "Hvc", imm };
    case EC.SMC64: return { kind: "Smc", imm };
    case EC.SYSREG: return { kind: "SysReg", ...decodeSysreg(v) };
    case EC.IABT_LOWER: return { kind: "InstructionAbort", ifsc: field(v, 0, 6), s1ptw: bit(v, 7) };
    case EC.DABT_LOWER: return { kind: "DataAbort", ...decodeDataAbort(v) };
    case EC.BRK64: return { kind: "Brk", imm };
    default: return { kind: "Unknown", ec, esr: v };
  }
}

/** The values `hv_vcpu_run` can report in `exit->reason`, as the lab names them. */
export const REASONS = Object.freeze(["exception", "canceled", "vtimer", "unknown"]);

/** `Exit::from_hv`: combine the exit reason with the syndrome. */
export function fromHv(reason, esr) {
  const v = BigInt.asUintN(64, esr);
  switch (reason) {
    case "canceled": return { kind: "Canceled" };
    case "vtimer": return { kind: "VtimerActivated" };
    case "exception": return decode(v);
    default: return { kind: "Unknown", ec: esrEc(v), esr: v };
  }
}

export function sizeBytes(sas) {
  return 1 << (sas & 3);
}

export function sysregName(s) {
  const key = `${s.op0},${s.op1},${s.crn},${s.crm},${s.op2}`;
  return SYSREG_NAMES[key] ?? null;
}

export function sysregGeneric(s) {
  return `S${s.op0}_${s.op1}_C${s.crn}_C${s.crm}_${s.op2}`;
}

// ---------------------------------------------------------------------------------------------
// What macvmm prints: the Display impls, byte for byte

const b = (x) => (x ? 1 : 0);

export function dataAbortDisplay(da) {
  let s = `ISV=${b(da.isv)} SAS=${da.sas} (${sizeBytes(da.sas)} bytes) SSE=${b(da.sse)} SRT=${da.srt} SF=${b(da.sf)} AR=${b(da.ar)} FnV=${b(da.fnv)} S1PTW=${b(da.s1ptw)} WnR=${b(da.wnr)} DFSC=${hex(da.dfsc)}`;
  const n = fscName(da.dfsc);
  if (n) s += ` (${n})`;
  return s;
}

/** `impl Display for Exit`: the line macvmm's dump prints after `vcpu0: `. */
export function exitDisplay(exit) {
  switch (exit.kind) {
    case "Canceled": return "canceled (hv_vcpus_exit)";
    case "VtimerActivated": return "vtimer activated";
    case "Wfx": return `wfx (EC 0x01): ${["WFI", "WFE", "WFIT", "WFET"][exit.ti & 3]}`;
    case "Hvc": return `hvc (EC 0x16): imm=${hex(exit.imm)}`;
    case "Smc": return `smc (EC 0x17): imm=${hex(exit.imm)}`;
    case "SysReg": {
      let s = `sysreg (EC 0x18): ${exit.read ? "MRS" : "MSR"} ${sysregGeneric(exit)} rt=${exit.rt}`;
      const n = sysregName(exit);
      if (n) s += ` (${n})`;
      return s;
    }
    case "InstructionAbort": {
      let s = `instruction abort (EC 0x20): IFSC=${hex(exit.ifsc)} S1PTW=${b(exit.s1ptw)}`;
      const n = fscName(exit.ifsc);
      if (n) s += ` (${n})`;
      return s;
    }
    case "DataAbort": return `data abort (EC 0x24): ${dataAbortDisplay(exit)}`;
    case "Brk": return `brk (EC 0x3c): imm=${hex(exit.imm)}`;
    default: {
      let s = `unknown (EC ${hex2(exit.ec)}, ESR ${hex(exit.esr)})`;
      const n = ecName(exit.ec);
      if (n) s += `: ${n}`;
      return s;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Field layout for the bit bar and the field table

/**
 * Which ISS layout the bar uses for this EC. Data and instruction aborts share a layout with
 * their same-EL twins (0x25, 0x21): the bits mean the same, only who sees them differs.
 */
export function issLayoutName(ec) {
  if (ec === EC.DABT_LOWER || ec === EC.DABT_CUR) return "data abort";
  if (ec === EC.IABT_LOWER || ec === EC.IABT_CUR) return "instruction abort";
  if (ec === EC.HVC64 || ec === EC.SMC64 || ec === EC.SVC64 || ec === EC.BRK64) return "immediate";
  if (ec === EC.WFX) return "WFI/WFE";
  if (ec === EC.SYSREG) return "MSR/MRS";
  return "raw";
}

/**
 * ECs for which the ARM ARM's ESR_ELx.IL description says the value 1 "is also used", so IL is
 * not an instruction length: unknown reason (EC 0x00), illegal execution state, instruction
 * aborts, PC and SP alignment, SError, and the debug exceptions other than BRK (breakpoint,
 * software step, watchpoint, 0x30 to 0x35). A data abort joins them when ISV = 0. The manual does
 * not call the bit RES1, so the lab does not either.
 */
const IL_FIXED = new Set([0x00, 0x0e, 0x20, 0x21, 0x22, 0x26, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35]);

export function ilMeaning(ec, isv, x) {
  const fixed = IL_FIXED.has(ec) || ((ec === EC.DABT_LOWER || ec === EC.DABT_CUR) && !isv);
  if (fixed) {
    return x
      ? "1: fixed at 1 for this class (the ARM ARM's IL description), not an instruction length"
      : "0: the ARM ARM's IL description fixes IL at 1 for this class, so real hardware reports 1; either way it is not an instruction length";
  }
  return x ? "32-bit instruction" : "16-bit instruction (AArch32 T32 only)";
}

/** Fields whose box takes decimal: the ones macvmm's dump prints in decimal (SRT=9, rt=4, S3_3_C9_C12_0). */
const DECIMAL_FIELDS = new Set(["sas", "srt", "rt", "rn", "op0", "op1", "op2", "crn", "crm", "ti"]);

/**
 * FnV in an abort's ISS. The ARM ARM defines it only for a synchronous external abort that is
 * not on a table walk (fault code 0x10); for every other code it is RES0. Either way FAR_EL2
 * holds the guest's virtual address: the IPA a VMM emulates against comes from HPFAR_EL2, which
 * Hypervisor.framework reports as the exit's physical_address (macvmm's dump prints it as ipa=).
 */
function fnvMeaning(x, fsc) {
  const ipa = "The IPA the VMM uses comes from the exit's physical_address (HPFAR_EL2, ipa= in the dump), not from FAR";
  if (fsc !== 0x10) return `${x}: RES0 for this fault code (FnV means something only for a synchronous external abort, code 0x10). ${ipa}`;
  return x
    ? `1: FAR_EL2 does not hold the faulting virtual address. ${ipa}`
    : `0: FAR_EL2 holds the faulting virtual address. ${ipa}`;
}

const reg = (n, sf) => (n === 31 ? (sf ? "xzr" : "wzr") : `${sf ? "x" : "w"}${n}`);

/**
 * The fields of the low 32 bits, most significant first: `{ key, name, hi, lo, value, meaning,
 * used, note }`. `used` is false for bits macvmm's decoder ignores. Covers bits 31..0 exactly
 * once (tested).
 */
export function layout(esr) {
  const v = BigInt.asUintN(64, esr);
  const ec = esrEc(v);
  const f = (key, name, hi, lo, meaning, used = true, note = "") => {
    const value = field(v, lo, hi - lo + 1);
    return { key, name, hi, lo, value, meaning: typeof meaning === "function" ? meaning(value) : meaning, used, note, radix: DECIMAL_FIELDS.has(key) ? 10 : 16 };
  };
  const out = [
    f("ec", "EC", 31, 26, (x) => `exception class ${hex2(x)}: ${ecName(x) ?? "not in macvmm's table of names"}`),
    f("il", "IL", 25, 25, (x) => ilMeaning(ec, bit(v, 24), x)),
  ];
  const kind = issLayoutName(ec);
  if (kind === "data abort") {
    const isv = bit(v, 24);
    const blank = isv ? "" : "ISV = 0: this bit carries no information (RES0) and must not be used";
    const sf = bit(v, 15);
    out.push(
      f("isv", "ISV", 24, 24, (x) => (x ? "bits 23 to 14 describe the access" : "no description of the access: size and register unknown")),
      f("sas", "SAS", 23, 22, (x) => `access size ${sizeBytes(x)} byte${x ? "s" : ""}`, isv, blank),
      f("sse", "SSE", 21, 21, (x) => (x ? "a load sign-extends" : "no sign extension"), isv, blank),
      f("srt", "SRT", 20, 16, (x) => `register ${x}: ${reg(x, sf)}${x === 31 ? " (the zero register, never sp)" : ""}`, isv, blank),
      f("sf", "SF", 15, 15, (x) => (x ? "64-bit x register" : "32-bit w register"), isv, blank),
      f("ar", "AR", 14, 14, (x) => (x ? "acquire/release (ldar, stlr)" : "plain load or store"), isv, blank),
      f("iss_13_11", "13:11", 13, 11, "other fields (VNCR, SET)", false),
      f("fnv", "FnV", 10, 10, (x) => fnvMeaning(x, field(v, 0, 6))),
      f("ea", "EA", 9, 9, "external abort type", false),
      f("cm", "CM", 8, 8, (x) => (x ? "a cache maintenance instruction, not a load or store" : "a load or store"), false, "Only chapter 21's ISV = 0 path looks at CM."),
      f("s1ptw", "S1PTW", 7, 7, (x) => (x ? "the fault hit the guest's own stage-1 table walk" : "the fault was on the access itself")),
      f("wnr", "WnR", 6, 6, (x) => (x ? "write (store)" : "read (load)")),
      f("dfsc", "DFSC", 5, 0, (x) => fscText(x, "DFSC")),
    );
  } else if (kind === "instruction abort") {
    out.push(
      f("iss_24_11", "24:11", 24, 11, "RES0, and the SET field", false),
      f("fnv", "FnV", 10, 10, (x) => fnvMeaning(x, field(v, 0, 6)), false),
      f("ea", "EA", 9, 9, "external abort type", false),
      f("iss_8", "8", 8, 8, "RES0", false),
      f("s1ptw", "S1PTW", 7, 7, (x) => (x ? "the fault hit the guest's own stage-1 table walk" : "the fault was on the fetch itself")),
      f("iss_6", "6", 6, 6, "RES0", false),
      f("ifsc", "IFSC", 5, 0, (x) => fscText(x, "IFSC")),
    );
  } else if (kind === "immediate") {
    out.push(
      f("iss_24_16", "24:16", 24, 16, "RES0; the immediate is only bits 15 to 0", false),
      f("imm16", "imm16", 15, 0, (x) => `the number in the instruction: #${hex(x)}`),
    );
  } else if (kind === "WFI/WFE") {
    out.push(
      f("iss_24_10", "24:10", 24, 10, "AArch32 condition fields and RES0", false),
      f("rn", "RN", 9, 5, (x) => `register holding the timeout (WFIT/WFET only): x${x}`, false),
      f("iss_4_3", "4:3", 4, 3, "RES0", false),
      f("rv", "RV", 2, 2, (x) => (x ? "RN is valid" : "RN is not valid"), false),
      f("ti", "TI", 1, 0, (x) => ["WFI", "WFE", "WFIT", "WFET"][x]),
    );
  } else if (kind === "MSR/MRS") {
    out.push(
      f("iss_24_22", "24:22", 24, 22, "RES0", false),
      f("op0", "Op0", 21, 20, (x) => `op0 = ${x}`),
      f("op2", "Op2", 19, 17, (x) => `op2 = ${x}`),
      f("op1", "Op1", 16, 14, (x) => `op1 = ${x}`),
      f("crn", "CRn", 13, 10, (x) => `CRn = ${x}`),
      f("rt", "Rt", 9, 5, (x) => `general-purpose register ${x === 31 ? "xzr" : "x" + x}`),
      f("crm", "CRm", 4, 1, (x) => `CRm = ${x}`),
      f("dir", "Direction", 0, 0, (x) => (x ? "1: read (MRS) into Rt" : "0: write (MSR) from Rt")),
    );
  } else {
    out.push(f("iss", "ISS", 24, 0, "the ISS, not split for this class", false));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Plain-language readout and "what the VMM does"

const EC_NOTES = new Map([
  [0x00, "An instruction the CPU could not execute (UNDEFINED, among others)."],
  [0x15, "An svc is a system call inside the guest: the guest's own kernel takes it at EL1, so it never reaches the VMM. You meet this one in a guest's ESR_EL1."],
  [0x21, "Taken at the level where it happened, so you meet it in a guest's ESR_EL1, not as an exit from a guest."],
  [0x25, "Taken at the level where it happened, so you meet it in a guest's ESR_EL1, not as an exit from a guest. The ISS still has the data-abort layout shown above."],
]);

/** How the readout names the in-kernel GIC for a reader who has not reached chapter 12. */
const GIC = "the in-kernel GIC (the interrupt controller Hypervisor.framework emulates for macvmm, chapter 12)";

/**
 * S1PTW = 1: "hole" (chapter 05's word for an unmapped stage-2 address) fits only a translation
 * fault; a permission or access-flag fault means the table was mapped but stage 2 refused the
 * walk's access.
 */
function walkSentence(fsc, notWhat) {
  return fscName(fsc) === "translation fault"
    ? `S1PTW = 1: the guest's own page-table walk hit a hole, ${notWhat}.`
    : `S1PTW = 1: the guest's own page-table walk was refused by stage 2 (see the fault code), ${notWhat}.`;
}

/** One or more plain sentences: the readout. */
export function summary(exit, esr) {
  const v = BigInt.asUintN(64, esr);
  switch (exit.kind) {
    case "Canceled": return "Canceled: not a guest exception. The VMM asked the vCPU to stop (hv_vcpus_exit), so there is no syndrome to read.";
    case "VtimerActivated": return `The virtual timer fired. There is no syndrome to read. With ${GIC} this exit never arrives; it matters only with --irqchip none, chapter 11's mode without that controller.`;
    case "DataAbort": {
      const da = exit;
      const parts = ["Data abort from a lower EL (EC 0x24)."];
      if (da.s1ptw) {
        // A fault on the guest's own stage-1 walk: WnR describes the walk's access (a hardware
        // descriptor update counts as a write), not the guest's instruction, and the ARM ARM
        // reports ISV = 0 for it.
        parts.push(`The note describes the walk, not an instruction: WnR = ${b(da.wnr)} is the walk's own ${da.wnr ? "write (a descriptor update)" : "read of a table entry"}.`);
        if (da.isv) parts.push("Real hardware never sets ISV = 1 with S1PTW = 1: a fault on a stage-1 table walk reports ISV = 0, so bits 23 to 14 say nothing here.");
      } else if (da.isv) {
        const n = sizeBytes(da.sas);
        const r = reg(da.srt, da.sf);
        const regText = da.srt === 31 ? `${r} (register 31 is the zero register here, never sp)` : r;
        if (da.wnr) parts.push(`Write of ${n} byte${n > 1 ? "s" : ""} from ${regText}.`);
        else parts.push(`Read of ${n} byte${n > 1 ? "s" : ""} into ${regText}${da.sse ? `, sign-extended to ${da.sf ? 64 : 32} bits` : ""}.`);
        if (da.ar) parts.push(da.wnr ? "A store-release." : "A load-acquire.");
        if (da.sas === 3 && !da.sf) parts.push("No A64 instruction produces this: an 8-byte access always uses an x register (SF = 1).");
        if (da.sse && !da.wnr && (da.sas === 3 || (da.sas === 2 && !da.sf))) parts.push("No A64 instruction produces this: only a load narrower than its register sign-extends (ldrsb, ldrsh, ldrsw).");
      } else {
        parts.push(`A ${da.wnr ? "write" : "read"}, but ISV = 0: the syndrome does not record the size or the register, so bits 23 to 14 carry nothing.`);
      }
      parts.push(fscText(da.dfsc, "DFSC") + ".");
      if (da.s1ptw) parts.push(walkSentence(da.dfsc, "not the access"));
      if (da.fnv) {
        parts.push(da.dfsc === 0x10
          ? "FnV = 1: FAR_EL2 (the guest's virtual address) is not valid. The VMM works from the exit's IPA (HPFAR_EL2), not FAR."
          : "FnV = 1, but FnV is RES0 for this fault code: it means something only for a synchronous external abort (code 0x10).");
      }
      return parts.join(" ");
    }
    case "InstructionAbort": {
      const parts = ["Instruction abort from a lower EL (EC 0x20): the guest tried to fetch its next instruction from an address stage 2 refused.", fscText(exit.ifsc, "IFSC") + "."];
      if (exit.s1ptw) parts.push(walkSentence(exit.ifsc, "not the fetch"));
      return parts.join(" ");
    }
    case "Hvc": return `HVC #${hex(exit.imm)} from AArch64 (EC 0x16): a hypervisor call, the guest asking the VMM for something on purpose.${exit.imm === 0 ? " PSCI and the other SMCCC calls use #0 and put the function number in x0." : ""}`;
    case "Smc": return `SMC #${hex(exit.imm)} from AArch64 (EC 0x17): a secure monitor call, trapped before it ran.${exit.imm === 0 ? " PSCI and the other SMCCC calls use #0 and put the function number in x0." : ""}`;
    case "SysReg": {
      const name = sysregName(exit);
      const g = sysregGeneric(exit);
      const r = exit.rt === 31 ? "xzr" : `x${exit.rt}`;
      const who = name ? `${name} (${g})` : `${g}, a register macvmm has no name for`;
      return exit.read
        ? `Trapped MRS (EC 0x18): the guest read ${who} into ${r}.`
        : `Trapped MSR (EC 0x18): the guest wrote ${r} to ${who}.`;
    }
    case "Wfx": return `${["WFI", "WFE", "WFIT", "WFET"][exit.ti & 3]} (EC 0x01): the guest has nothing to do and waits${exit.ti === 0 || exit.ti === 2 ? " for an interrupt" : " for an event"}.`;
    case "Brk": return `BRK #${hex(exit.imm)} (EC 0x3c): a breakpoint instruction.`;
    default: {
      const ec = exit.ec;
      const name = ecName(ec);
      const parts = [`EC ${hex2(ec)}: ${name ?? "a class macvmm's table does not name (look it up in the ARM ARM's EC table)"}.`];
      const note = EC_NOTES.get(ec);
      if (note) parts.push(note);
      parts.push("macvmm's decoder calls this Unknown, keeps the raw syndrome, and stops the VM with a dump.");
      return parts.join(" ");
    }
  }
}

const CH05 = "/build-your-own/vmm/memory/address-space/";
const CH07 = "/build-your-own/vmm/cpu/exit-loop/";
const CH08 = "/build-your-own/vmm/cpu/traps-psci/";
const CH11 = "/build-your-own/vmm/interrupts/timer-irq/";
const CH12 = "/build-your-own/vmm/interrupts/gicv3/";
const CH21 = "/build-your-own/vmm/firmware/firmware/";

/**
 * What macvmm's exit handler (crates/vmm/src/vcpu/exit.rs, `handle`) does with this exit:
 * `{ arm, note?, does, pc, links: [{ text, href }] }`. `arm` is the match arm (or arms) as Rust
 * source, copied from exit.rs; `// ...` separates two arms and stands for the arms between them.
 * model.test.mjs checks every arm against the file, so the two cannot drift apart.
 */
export function vmmAction(exit) {
  const pcTable = { text: "Chapter 07: the PC-advance table", href: CH07 + "#the-handler-and-the-pc-advance-table" };
  switch (exit.kind) {
    case "DataAbort": {
      let does;
      let pc;
      const n = sizeBytes(exit.sas);
      const bytes = `${n} byte${n > 1 ? "s" : ""}`;
      const where = "The syndrome alone cannot say what lives at the exit's IPA; macvmm asks its own map, never the fault code.";
      const ram = "A fault inside RAM is a VMM bug (RAM is always fully mapped) and stops the VM.";
      if (exit.s1ptw) {
        does = `S1PTW = 1: a guest page-table walk ${fscName(exit.dfsc) === "translation fault" ? "hit a hole" : "was refused by stage 2"}. That is not a device access, so the VM stops with the dump.`;
        pc = "Nothing: the VM stops.";
      } else if (exit.isv) {
        const emulate = exit.wnr
          ? `read ${reg(exit.srt, exit.sf)}${exit.srt === 31 ? " (reads as 0)" : ""}, mask it to ${bytes}, send the store to the device`
          : `ask the device for ${bytes}${exit.sse ? ", sign-extend it" : ""}, write it to ${reg(exit.srt, exit.sf)}${exit.srt === 31 ? " (discarded)" : ""}`;
        does = `${where} If a device lives there, emulate the access from the note: ${emulate}, and add 4 to the PC. If nothing lives there (or the access straddles a device's edge), the --unhandled-mmio policy decides: fatal by default, as in chapter 05's stop, or read-as-zero/write-ignored with --unhandled-mmio log. ${ram}`;
        pc = "The saved PC points at the load or store (a fault). If a device or the log policy handled it, the VMM adds 4; if the policy is fatal, or the IPA is RAM, the VM stops and the PC stays put.";
      } else {
        does = `ISV = 0: the note is blank. Chapter 07's VMM stops with the instruction word in the dump rather than guess. The reference (chapter 21) fetches and decodes the instruction itself: it emulates pairs and writeback forms and adds 4, skips prfm and cache maintenance (CM = 1) with just the add, and answers anything it refuses (SIMD, exclusives, atomics, a mismatch with the exit) by injecting a synchronous external abort into the guest. An empty IPA still goes to the --unhandled-mmio policy. ${ram}`;
        pc = "Chapter 07's VMM: nothing, the VM stops. The reference (chapter 21): adds 4 after emulating or skipping the instruction; an injected abort sets the PC to the guest's own exception vector instead.";
      }
      return {
        arm: "Exit::DataAbort(da) => {\n    let pc = regs.pc()?;\n    match mmio::handle(regs, env, raw, &da, pc, rec)? {\n        MmioOutcome::Done => Ok(ExitAction::Resume { advance_pc: true }),\n        MmioOutcome::Fatal(why) => fatal(regs, env, exit, raw, rec, why),\n        MmioOutcome::Abort { far, write } => {\n            inject_abort(regs, env, exit, raw, rec, far, write)\n        }\n    }\n}",
        note: "MmioOutcome::Abort and inject_abort arrive in chapter 21; chapter 07's handler has only Done and Fatal.",
        does,
        pc,
        links: [
          { text: "Chapter 07: the note the hardware leaves", href: CH07 + "#the-note-the-hardware-leaves" },
          exit.isv ? { text: "Chapter 07: emulating the access", href: CH07 + "#emulating-the-access" } : { text: "Chapter 07: when the note is blank", href: CH07 + "#when-the-note-is-blank-isv-0" },
          { text: "Chapter 05: when the guest touches a hole", href: CH05 + "#when-the-guest-touches-a-hole" },
          pcTable,
          ...(exit.isv ? [] : [{ text: "Chapter 21: where the note runs out", href: CH21 + "#where-the-note-runs-out" }]),
        ],
      };
    }
    case "Hvc":
    case "Smc": {
      const hvc = exit.kind === "Hvc";
      return {
        arm: hvc ? "Exit::Hvc { imm } => smccc_call(regs, env, Conduit::Hvc, imm, rec)," : "Exit::Smc { imm } => smccc_call(regs, env, Conduit::Smc, imm, rec),",
        does: "Hand the call to the SMCCC dispatcher, which reads the function number from x0 (PSCI, the debug calls) and writes the result back to x0.",
        pc: hvc ? "Leave it alone: hvc is a call, so the saved PC already points after it." : "The saved PC points at the smc (it was intercepted before it ran), so the VMM adds 4.",
        links: [pcTable, { text: "Chapter 08: two doors, hvc and smc", href: CH08 + "#two-doors-hvc-and-smc" }],
      };
    }
    case "SysReg":
      return {
        arm: "Exit::SysReg(access) => sysreg_trap(regs, env, exit, raw, &access, rec),",
        does: "Look the register up in the policy table: emulate it, answer read-as-zero/write-ignored with a written reason, or inject an UNDEFINED exception into the guest.",
        pc: "Adds 4 when it emulates; an injected UNDEF sets the PC to the guest's vector instead.",
        links: [{ text: "Chapter 08: decoding the trap", href: CH08 + "#decoding-the-trap-exception-class-0x18" }],
      };
    case "Wfx":
      return {
        arm: "Exit::Wfx { .. } if regs.nogic().is_some() => nogic_wfi(regs, env),\n// ...\nExit::Wfx { .. } => {\n    if !WFX_WARNED.swap(true, Ordering::Relaxed) {\n        crate::guest_warn!(\"WFx exit with the in-kernel GIC (unexpected); yielding\");\n    }\n    std::thread::yield_now();\n    Ok(ExitAction::Resume { advance_pc: true })\n}",
        does: `With ${GIC} this exit never arrives (Hypervisor.framework handles WFI itself); macvmm warns once and yields. With --irqchip none, chapter 11's mode without that controller, it sleeps until the timer deadline or a stop.`,
        pc: "Adds 4.",
        links: [{ text: "Chapter 11: the timer and a bare interrupt", href: CH11 }, { text: "Chapter 12: the interrupt controller", href: CH12 }],
      };
    case "Canceled":
      return {
        arm: "Exit::Canceled => Ok(ExitAction::Resume { advance_pc: false }),",
        does: "Re-check the stop flag: the kick may be ours (a timeout, a signal) or a stale one.",
        pc: "Leave it alone: the guest did nothing.",
        links: [pcTable],
      };
    case "VtimerActivated":
      return {
        arm: "Exit::VtimerActivated if regs.nogic().is_some() => {\n    if let Some(t) = regs.nogic() {\n        t.vtimer_activated();\n    }\n    Ok(ExitAction::Resume { advance_pc: false })\n}\n// ...\nExit::VtimerActivated => {\n    if !VTIMER_WARNED.swap(true, Ordering::Relaxed) {\n        crate::guest_warn!(\n            \"VTIMER_ACTIVATED with the in-kernel GIC (unexpected); unmasking\"\n        );\n    }\n    regs.unmask_vtimer()?;\n    Ok(ExitAction::Resume { advance_pc: false })\n}",
        does: `With --irqchip none (chapter 11's mode without an interrupt controller), raise the vCPU's interrupt line. With ${GIC} this never arrives; macvmm warns once and unmasks the timer.`,
        pc: "Leave it alone.",
        links: [{ text: "Chapter 11: the timer and a bare interrupt", href: CH11 }, { text: "Chapter 12: the interrupt controller", href: CH12 }],
      };
    default:
      return {
        arm: "Exit::InstructionAbort { .. } | Exit::Brk { .. } | Exit::Unknown { .. } => {\n    let why = fatal_reason(exit, raw, regs.pc()?);\n    fatal(regs, env, exit, raw, rec, why)\n}",
        does: "Stop the VM with the full register dump and the last exits (exit code 3). Nothing is emulated, and the raw syndrome is kept so a human can read it.",
        pc: "Nothing: the VM stops.",
        links: [{ text: "Chapter 07: one enum for every exit", href: CH07 + "#one-enum-for-every-exit" }],
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Presets: every value here was seen on real hardware (course/captures or the hardware spike
// behind the vectors); `source` says where.

export const PRESETS = Object.freeze([
  { id: "ch05-stop", label: "Data abort: store to an empty address (chapter 05's stop)", esr: 0x93890046n, source: "captures/05-poke-fatal.txt", note: "In that run nothing lived at the exit's IPA, 0xc000000, so the default --unhandled-mmio policy stopped the VM (exit code 3): the syndrome is a perfect note, but there was no device to give it to." },
  { id: "uart-write", label: "Data abort: str w1 to the UART", esr: 0x93810046n, source: "vectors/esr.json" },
  { id: "uart-read", label: "Data abort: ldr w3 from the UART's flag register", esr: 0x93830006n, source: "vectors/esr.json" },
  { id: "isv0", label: "Data abort with ISV = 0 (stp to a device)", esr: 0x92000046n, source: "captures/07-isv0-stop.txt" },
  { id: "ro-page", label: "Data abort: str x0, translation fault level 3", esr: 0x93c08047n, source: "vectors/esr.json" },
  { id: "iabt", label: "Instruction abort: fetch from an unmapped address", esr: 0x82000006n, source: "captures/06-self-fault.txt" },
  { id: "hvc0", label: "HVC #0 (chapter 02's first exit; PSCI calls look the same)", esr: 0x5a000000n, source: "captures/02-first-exit.txt" },
  { id: "wfi", label: "WFI", esr: 0x07e00000n, source: "vectors/esr.json" },
  { id: "sysreg", label: "Sysreg trap: mrs x4, pmcr_el0", esr: 0x6230e499n, source: "vectors/esr.json" },
  { id: "smc", label: "SMC #3", esr: 0x5e000003n, source: "vectors/esr.json" },
  { id: "guest-esr", label: "A guest's own ESR_EL1: alignment fault (EC 0x25)", esr: 0x96000021n, source: "captures/06-self-fault.txt" },
]);

export const DEFAULT_ESR = PRESETS[0].esr;

export function presetFor(esr) {
  const v = BigInt.asUintN(64, esr);
  return PRESETS.find((p) => p.esr === v) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Share state: `#esr-decoder=0x93890046`, or `vtimer:0x0` for a non-exception reason

export function encodeHash(state) {
  const h = hex(state.esr);
  return state.reason === "exception" ? h : `${state.reason}:${h}`;
}

/** Parse a share-state string. Anything malformed gives null (the lab then starts fresh). */
export function decodeHash(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > MAX_INPUT + 12) return null;
  let reason = "exception";
  let rest = str;
  const m = /^([a-z]+):(.*)$/.exec(str);
  if (m) {
    if (!REASONS.includes(m[1])) return null;
    reason = m[1];
    rest = m[2];
  }
  const p = parseEsr(rest);
  return p.ok ? { esr: p.value, reason } : null;
}

// ---------------------------------------------------------------------------------------------
// State machine: one plain object, `next = step(state, action)`

export function initialState(hashStr = null) {
  const h = decodeHash(hashStr);
  const esr = h ? h.esr : DEFAULT_ESR;
  return { esr, reason: h ? h.reason : "exception", text: hexGrouped(esr), error: null };
}

/**
 * Actions: `{type:"input", text}` (typing; the value changes only when it parses),
 * `{type:"toggle", bit}`, `{type:"field", lo, width, value}`, `{type:"preset", id}`,
 * `{type:"set", esr}`, `{type:"reason", reason}`, `{type:"reset"}`.
 */
export function step(state, action) {
  const withEsr = (esr) => ({ ...state, esr: BigInt.asUintN(64, esr), text: hexGrouped(esr), error: null });
  switch (action?.type) {
    case "input": {
      const p = parseEsr(action.text);
      return p.ok ? { ...state, esr: p.value, text: action.text, error: null } : { ...state, text: String(action.text ?? "").slice(0, MAX_INPUT * 2), error: p.error };
    }
    case "toggle": return withEsr(toggleBit(state.esr, action.bit));
    case "field": {
      // A Number value is exact up to 2^53; pass a BigInt for anything wider.
      const lo = Number(action.lo), w = Number(action.width);
      if (!Number.isInteger(lo) || !Number.isInteger(w) || w < 1 || lo < 0 || lo + w > 64) return state;
      return withEsr(setField(state.esr, lo, w, action.value));
    }
    case "preset": {
      const p = PRESETS.find((x) => x.id === action.id);
      return p ? { ...withEsr(p.esr), reason: "exception" } : state;
    }
    case "set": return typeof action.esr === "bigint" ? { ...withEsr(action.esr), reason: "exception" } : state;
    case "reason": return REASONS.includes(action.reason) ? { ...state, reason: action.reason } : state;
    case "reset": return initialState(null);
    default: return state;
  }
}

/** Everything the view renders, derived from the state. */
export function view(state) {
  const exit = fromHv(state.reason, state.esr);
  const high = esrHigh(state.esr);
  // For a non-exception exit reason nothing decodes the bits: grey every row and say so, rather
  // than print meanings as if they were read.
  const notDecoded = state.reason === "unknown"
    ? "Not decoded for this exit reason (macvmm keeps the raw syndrome for the dump)"
    : "Not used for this exit reason";
  const fields = state.reason === "exception"
    ? layout(state.esr)
    : layout(state.esr).map((f) => ({ ...f, used: false, meaning: notDecoded, note: "" }));
  return {
    exit,
    hex: hexGrouped(state.esr),
    fields,
    layoutName: issLayoutName(esrEc(state.esr)),
    summary: summary(exit, state.esr),
    display: exitDisplay(exit),
    vmm: vmmAction(exit),
    preset: presetFor(state.esr),
    high: high === 0n ? null : `Bits 63 to 32 are ${hex(high)} (so ISS2, bits 55 to 32, is ${hex(esrIss2(state.esr))}). macvmm ignores them, so they do not change the decode.`,
  };
}
