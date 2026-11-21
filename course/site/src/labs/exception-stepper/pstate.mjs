// PSTATE (and SPSR) encode/decode for the exception-stepper lab.
//
// Kept in its own module so chapter 06's `pstate-builder` lab can import the same code
// (`import { decodePstate } from "../exception-stepper/pstate.mjs"`): the two labs must name
// modes and mask bits identically. Pure: no DOM, no I/O.
//
// Layout (ARM ARM DDI 0487, "SPSR_EL1/SPSR_EL2" register pages; AArch64 view):
//   bits 31..28  N Z C V   condition flags
//   bit  9       D         debug exceptions masked
//   bit  8       A         SError masked
//   bit  7       I         IRQ masked
//   bit  6       F         FIQ masked
//   bit  4       M[4]      0 = AArch64 (1 would be AArch32; not used in this course)
//   bits 3..0    M[3:0]    level in bits 3..2, stack pointer choice in bit 0, bit 1 reserved (0)
// Only these fields are modelled; everything else must be zero, and decode reports it.

export const FLAG_BITS = Object.freeze({ N: 31, Z: 30, C: 29, V: 28 });
export const DAIF_BITS = Object.freeze({ D: 9, A: 8, I: 7, F: 6 });
const KNOWN_MASK = (0xf << 28) | (0xf << 6) | 0x1f;

/** Mode name: EL0t, EL1t, EL1h, EL2t, EL2h ("t" = SP_EL0, "h" = the level's own SP). */
export function modeName(el, ownSp) {
  if (el === 0) return "EL0t"; // EL0 has only SP_EL0
  return `EL${el}${ownSp ? "h" : "t"}`;
}

/**
 * Build a PSTATE value from fields. Throws RangeError on impossible input (EL0 with its "own"
 * stack pointer, levels outside 0..3), so a caller cannot build a reserved mode by accident.
 */
export function encodePstate({ el, ownSp = false, flags = {}, daif = {} }) {
  if (!Number.isInteger(el) || el < 0 || el > 3) throw new RangeError(`bad level ${el}`);
  if (el === 0 && ownSp) throw new RangeError("EL0 has no stack pointer of its own");
  let v = (el << 2) | (ownSp ? 1 : 0);
  for (const [k, bit] of Object.entries(FLAG_BITS)) if (flags[k]) v |= 1 << bit;
  for (const [k, bit] of Object.entries(DAIF_BITS)) if (daif[k]) v |= 1 << bit;
  return v >>> 0;
}

/**
 * Decode a 32-bit PSTATE/SPSR value. Never throws: returns `{ ok: false, error }` for values
 * this course does not use (AArch32, reserved M bits, bits outside the modelled fields).
 */
export function decodePstate(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    return { ok: false, error: "not a 32-bit value" };
  }
  const v = value >>> 0;
  const flags = {};
  for (const [k, bit] of Object.entries(FLAG_BITS)) flags[k] = ((v >>> bit) & 1) === 1;
  const daif = {};
  for (const [k, bit] of Object.entries(DAIF_BITS)) daif[k] = ((v >>> bit) & 1) === 1;
  const el = (v >>> 2) & 3;
  const ownSp = (v & 1) === 1;
  const base = { value: v, el, ownSp, flags, daif };
  if (v & 0x10) return { ...base, ok: false, error: "AArch32 state (M[4] = 1), not used here" };
  if (v & 0x2) return { ...base, ok: false, error: "reserved mode (M[1] = 1)" };
  if (el === 0 && ownSp) return { ...base, ok: false, error: "reserved mode (EL0 with M[0] = 1)" };
  if ((v & ~KNOWN_MASK) >>> 0 !== 0) {
    return { ...base, ok: false, error: "bits set outside the fields this lab models" };
  }
  return { ...base, ok: true, mode: modeName(el, ownSp) };
}

/** One-line description, e.g. "EL1h, D A I F masked" or "EL0t, flags Z, nothing masked". */
export function describePstate(value) {
  const d = decodePstate(value);
  if (!d.ok) return `0x${(value >>> 0).toString(16)} (${d.error})`;
  const set = Object.keys(FLAG_BITS).filter((k) => d.flags[k]);
  const masked = Object.keys(DAIF_BITS).filter((k) => d.daif[k]);
  const parts = [d.mode];
  if (set.length) parts.push(`flags ${set.join(" ")}`);
  parts.push(masked.length ? `${masked.join(" ")} masked` : "nothing masked");
  return parts.join(", ");
}
