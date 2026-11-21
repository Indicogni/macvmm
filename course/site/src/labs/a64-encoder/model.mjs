// a64-encoder: pure model (no DOM, no I/O). The view imports this; so do the node tests.
//
// What this teaches: every A64 instruction is one 32-bit word, and some ranges of its bits
// ("fields") are fixed and say which instruction it is, while others carry a register number or a
// constant. The lab covers the three instruction families of chapter 02's guest program, with the
// field layouts from the Arm Architecture Reference Manual (DDI 0487), section C6.2:
//
//   move wide  (MOVZ, MOVK, MOVN)   sf | opc | 100101 | hw | imm16 | Rd
//   exception  (SVC, HVC, SMC, BRK) 11010100 | opc | imm16 | 000 | LL
//   branch     (B, BL)              op | 00101 | imm26
//
// Encoding is shift-and-OR, decoding is shift-and-mask. Words the lab reads may come from a
// pasted string or a share link, so every parser here is strict: it rejects anything that is not
// a well-formed number in range and returns an explicit error instead of guessing.

/** Mask a JS number to an unsigned 32-bit value. */
const u32 = (n) => n >>> 0;

/** Extract bits hi..lo (inclusive) of a 32-bit word. */
export function bits(word, hi, lo) {
  const width = hi - lo + 1;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  return u32((u32(word) >>> lo) & mask);
}

/** Place `value` into bits hi..lo. `value` must already fit. */
function put(value, hi, lo) {
  const width = hi - lo + 1;
  const mask = width >= 32 ? 0xffffffff : (1 << width) - 1;
  return u32((value & mask) << lo);
}

/** "0xD2800540": upper-case, 8 digits, as the lesson prints words. */
export function hex32(word) {
  return "0x" + u32(word).toString(16).toUpperCase().padStart(8, "0");
}

/** Bits of a field as a binary string, most significant first. */
export function binary(value, width) {
  return u32(value).toString(2).padStart(width, "0");
}

/** The four bytes of `word` in memory order (little-endian), as two-digit lower-case hex. */
export function leBytes(word) {
  const w = u32(word);
  return [w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff].map((b) =>
    b.toString(16).padStart(2, "0"),
  );
}

/** Sign-extend the low `width` bits of `value`. */
function signExtend(value, width) {
  const sign = 2 ** (width - 1);
  return value >= sign ? value - 2 ** width : value;
}

// ---------------------------------------------------------------------------------------------
// Parsing (hostile input: pasted text, share links)

const MAX_INPUT = 64;

/**
 * Parse a 32-bit instruction word typed or pasted by the reader. Accepts an optional `0x` and
 * underscores as separators (`0xd400_0002`). One to eight hex digits.
 *
 * Exactly four space-separated two-digit groups (`40 05 80 d2`) are read as BYTES IN MEMORY
 * ORDER, the way `xxd` and `objdump -s` print them: A64 is little-endian, so the first byte is
 * the least significant and the word is 0xd2800540. The result then carries `bytes: true` so the
 * caller can say what happened. Reading them as one big-endian number instead would silently
 * decode the wrong word, which is exactly the mistake this lab exists to prevent.
 */
export function parseWord(text) {
  if (typeof text !== "string") return { ok: false, error: "Type a hex number such as d4000002." };
  if (text.length > MAX_INPUT) return { ok: false, error: "That is too long for a 32-bit word." };
  const byteList = /^\s*([0-9a-fA-F]{2})\s+([0-9a-fA-F]{2})\s+([0-9a-fA-F]{2})\s+([0-9a-fA-F]{2})\s*$/.exec(text);
  if (byteList) {
    const [b0, b1, b2, b3] = byteList.slice(1).map((x) => parseInt(x, 16));
    return { ok: true, value: u32(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)), bytes: true };
  }
  let s = text.trim().replace(/[_\s]/g, "");
  if (/^0x/i.test(s)) s = s.slice(2);
  if (s.length === 0) return { ok: false, error: "Type a hex number such as d4000002." };
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    return { ok: false, error: "Only hex digits 0 to 9 and a to f, with an optional 0x." };
  }
  s = s.replace(/^0+(?=.)/, "");
  if (s.length > 8) return { ok: false, error: "A64 instructions are 32 bits: at most 8 hex digits." };
  return { ok: true, value: u32(parseInt(s, 16)) };
}

/**
 * Parse a field value: decimal (`42`, `-36`) or hex (`0x2a`, `-0x24`), underscores allowed.
 * Returns a JS integer (safe range only) or an error. Range checks are the caller's job.
 */
export function parseNumber(text) {
  if (typeof text !== "string") return { ok: false, error: "Type a number." };
  if (text.length > MAX_INPUT) return { ok: false, error: "That number is too long." };
  let s = text.trim().replace(/_/g, "");
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  let n;
  if (/^0x[0-9a-fA-F]+$/i.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^[0-9]+$/.test(s)) n = parseInt(s, 10);
  else return { ok: false, error: "Type a decimal number (42) or hex with 0x (0x2a)." };
  if (!Number.isSafeInteger(n)) return { ok: false, error: "That number is too large." };
  return { ok: true, value: neg ? -n : n };
}

/** Parse a 64-bit address (for branch targets). Hex with or without 0x, up to 16 digits. */
export function parseAddress(text) {
  if (typeof text !== "string" || text.length > MAX_INPUT) {
    return { ok: false, error: "Type an address such as 0x40000000." };
  }
  let s = text.trim().replace(/_/g, "");
  if (/^0x/i.test(s)) s = s.slice(2);
  if (!/^[0-9a-fA-F]{1,16}$/.test(s.replace(/^0+(?=.)/, "")) || s.length === 0) {
    return { ok: false, error: "An address is up to 16 hex digits, such as 0x40000000." };
  }
  return { ok: true, value: BigInt("0x" + s) };
}

/** "0x40000008", lower-case, no padding (how disassemblers print branch targets). */
export function hexAddr(big) {
  return "0x" + BigInt.asUintN(64, big).toString(16);
}

// ---------------------------------------------------------------------------------------------
// Instruction families and field layouts (ARM ARM C6.2)

/**
 * Each field: `name` (short, as the ARM ARM spells it), `hi`/`lo` bit range, `fixed` (the bits
 * that identify the family, never an operand) and `label` (plain words for the reader).
 */
export const FAMILIES = {
  movewide: {
    title: "Move wide (MOVZ, MOVK, MOVN)",
    fields: [
      { name: "sf", hi: 31, lo: 31, label: "size: 1 = 64-bit x register, 0 = 32-bit w register" },
      { name: "opc", hi: 30, lo: 29, label: "flavour: 10 = movz, 11 = movk, 00 = movn" },
      { name: "100101", hi: 28, lo: 23, fixed: 0b100101, label: "fixed: says \"move wide\"" },
      { name: "hw", hi: 22, lo: 21, label: "shift the constant left by hw x 16 bits" },
      { name: "imm16", hi: 20, lo: 5, label: "the 16-bit constant" },
      { name: "Rd", hi: 4, lo: 0, label: "destination register number" },
    ],
  },
  exception: {
    title: "Exception-generating calls (SVC, HVC, SMC, BRK)",
    fields: [
      { name: "11010100", hi: 31, lo: 24, fixed: 0b11010100, label: "fixed: says \"exception call\"" },
      { name: "opc", hi: 23, lo: 21, label: "000 = a call (svc, hvc, smc), 001 = brk" },
      { name: "imm16", hi: 20, lo: 5, label: "a free number the receiver can read" },
      { name: "000", hi: 4, lo: 2, fixed: 0b000, label: "fixed: always 000 here" },
      { name: "LL", hi: 1, lo: 0, label: "which call: 01 = svc, 10 = hvc, 11 = smc" },
    ],
  },
  branch: {
    title: "Unconditional branch (B, BL)",
    fields: [
      { name: "op", hi: 31, lo: 31, label: "0 = b, 1 = bl (also saves the return address in x30)" },
      { name: "00101", hi: 30, lo: 26, fixed: 0b00101, label: "fixed: says \"branch, immediate\"" },
      { name: "imm26", hi: 25, lo: 0, label: "signed offset, counted in instructions (x 4 bytes)" },
    ],
  },
};

/** The instructions the encoder offers, in menu order. */
export const OPS = {
  movz: { family: "movewide", opc: 0b10, label: "movz: put a constant in a register" },
  movk: { family: "movewide", opc: 0b11, label: "movk: replace 16 bits, keep the rest" },
  movn: { family: "movewide", opc: 0b00, label: "movn: put the inverted constant" },
  svc: { family: "exception", opc: 0b000, ll: 0b01, label: "svc: call the kernel" },
  hvc: { family: "exception", opc: 0b000, ll: 0b10, label: "hvc: call the hypervisor" },
  smc: { family: "exception", opc: 0b000, ll: 0b11, label: "smc: call the secure firmware" },
  brk: { family: "exception", opc: 0b001, ll: 0b00, label: "brk: breakpoint for a debugger" },
  b: { family: "branch", op: 0, label: "b: branch" },
  bl: { family: "branch", op: 1, label: "bl: branch and link (a function call)" },
};

export const OP_NAMES = Object.keys(OPS);

/** Default operands per family: the chapter 02 values. */
export function defaultOperands(op) {
  const fam = OPS[op]?.family;
  if (fam === "movewide") return { sf: 1, rd: 0, imm16: 0x2a, hw: 0 };
  if (fam === "exception") return { imm16: 0 };
  return { offset: 0 };
}

// ---------------------------------------------------------------------------------------------
// Encoding

const BRANCH_MIN = -(2 ** 27);
const BRANCH_MAX = 2 ** 27 - 4;

/**
 * Validate operands for `op`. Returns `{ ok: true }` or `{ ok: false, field, error }` naming the
 * operand at fault, so the view can mark the right input.
 */
export function checkOperands(op, o) {
  const spec = OPS[op];
  if (!spec) return { ok: false, field: "op", error: "Pick an instruction." };
  const isInt = (n) => Number.isInteger(n);
  if (spec.family === "movewide") {
    if (o.sf !== 0 && o.sf !== 1) return { ok: false, field: "sf", error: "Size is x (64-bit) or w (32-bit)." };
    if (!isInt(o.rd) || o.rd < 0 || o.rd > 31) {
      return { ok: false, field: "rd", error: "A register number is 0 to 31 (5 bits)." };
    }
    if (!isInt(o.imm16) || o.imm16 < 0 || o.imm16 > 0xffff) {
      return { ok: false, field: "imm16", error: "The constant is 16 bits: 0 to 0xffff (65535)." };
    }
    if (!isInt(o.hw) || o.hw < 0 || o.hw > 3) return { ok: false, field: "hw", error: "Shift is 0, 16, 32 or 48." };
    if (o.sf === 0 && o.hw > 1) {
      return { ok: false, field: "hw", error: "A 32-bit w register has only 32 bits: shift 0 or 16." };
    }
    return { ok: true };
  }
  if (spec.family === "exception") {
    if (!isInt(o.imm16) || o.imm16 < 0 || o.imm16 > 0xffff) {
      return { ok: false, field: "imm16", error: "The immediate is 16 bits: 0 to 0xffff (65535)." };
    }
    return { ok: true };
  }
  if (!isInt(o.offset)) return { ok: false, field: "offset", error: "The offset is a whole number of bytes." };
  if (o.offset % 4 !== 0) {
    return { ok: false, field: "offset", error: "Instructions are 4 bytes, so the offset must be a multiple of 4." };
  }
  if (o.offset < BRANCH_MIN || o.offset > BRANCH_MAX) {
    return { ok: false, field: "offset", error: "26 bits of instructions reach -128 MiB to +128 MiB minus 4." };
  }
  return { ok: true };
}

/** Encode `op` with operands `o`. Returns `{ ok, word }` or the `checkOperands` error. */
export function encode(op, o) {
  const chk = checkOperands(op, o);
  if (!chk.ok) return chk;
  const spec = OPS[op];
  let w;
  if (spec.family === "movewide") {
    w = put(o.sf, 31, 31) | put(spec.opc, 30, 29) | put(0b100101, 28, 23) | put(o.hw, 22, 21) |
      put(o.imm16, 20, 5) | put(o.rd, 4, 0);
  } else if (spec.family === "exception") {
    w = put(0b11010100, 31, 24) | put(spec.opc, 23, 21) | put(o.imm16, 20, 5) | put(spec.ll, 1, 0);
  } else {
    const imm26 = u32(o.offset / 4) & 0x3ffffff;
    w = put(spec.op, 31, 31) | put(0b00101, 30, 26) | imm26;
  }
  return { ok: true, word: u32(w) };
}

// ---------------------------------------------------------------------------------------------
// Decoding

/** Immediates in the "assembly" spelling: small numbers in decimal, others in hex. */
function asmImm(n) {
  return n < 10 ? String(n) : "0x" + n.toString(16);
}

/** Immediates in llvm-objdump's spelling for exception calls: `#0`, otherwise hex. */
function dumpImm(n) {
  return n === 0 ? "0" : "0x" + n.toString(16);
}

function signedHex(big) {
  return big < 0n ? "-0x" + (-big).toString(16) : "0x" + big.toString(16);
}

function regName(sf, n) {
  if (n === 31) return sf ? "xzr" : "wzr";
  return (sf ? "x" : "w") + n;
}

/** Names for a few common words outside the three families, so the decoder can say what they are. */
const OTHERS = [
  { mask: 0xffffffff, match: 0xd503201f, name: "nop", meaning: "do nothing" },
  { mask: 0xffffffff, match: 0xd503207f, name: "wfi", meaning: "wait for interrupt: idle until something happens" },
  { mask: 0xffffffff, match: 0xd69f03e0, name: "eret", meaning: "return from an exception handler" },
  { mask: 0xfffffc1f, match: 0xd65f0000, name: "ret", meaning: "return: branch to the address in a register (x30 unless named)" },
  { mask: 0xfff00000, match: 0xd5300000, name: "mrs", meaning: "read a system register" },
  { mask: 0xfff00000, match: 0xd5100000, name: "msr", meaning: "write a system register" },
  { mask: 0xffe0001f, match: 0xd4400000, name: "hlt", meaning: "halt for an external debugger" },
  { mask: 0xffff0000, match: 0x00000000, name: "udf", meaning: "permanently undefined: a deliberate fault (all-zero memory decodes as this)" },
  { mask: 0x3b000000, match: 0x39000000, name: "ldr/str family", meaning: "a load or store with an unsigned offset (integer, SIMD or prefetch); chapter 07 emulates these from the exit's syndrome without reading the instruction" },
];

function fieldList(family, word) {
  return FAMILIES[family].fields.map((f) => {
    const width = f.hi - f.lo + 1;
    const value = bits(word, f.hi, f.lo);
    return { ...f, width, value, binary: binary(value, width) };
  });
}

/**
 * Decode a 32-bit word. `pc` (BigInt, optional) is the instruction's own address, used to print
 * a branch target the way a disassembler does.
 *
 * Returns, for the three families: `{ known: true, family, op, operands, fields, asm, dump,
 * meaning }`. `asm` is the plain assembly spelling (`movz x0, #0x2a`); `dump` is what
 * `objdump -d` (LLVM's, as shipped with Xcode) prints, preferred aliases included
 * (`mov x0, #0x2a`); `dumpNote` explains the difference when the two spellings differ. For
 * anything else: `{ known: false, name?, meaning?, reason }`.
 */
export function decode(word, pc = 0n) {
  const d = decodeRaw(word, pc);
  if (d.known) d.dumpNote = dumpNote(d);
  return d;
}

/** Why `objdump -d` spells this word differently from the plain assembly, or null if it does not. */
function dumpNote(d) {
  if (d.dump === d.asm) return null;
  if (d.family === "movewide" && d.dump.startsWith("mov ")) {
    return `objdump prints the preferred alias: mov is another spelling of ${d.op} here; the bits are the same.`;
  }
  if (d.family === "branch") {
    return "objdump prints the target address (this instruction's address plus the offset); the bits store only the distance, so the target depends on where the instruction sits.";
  }
  return "Same instruction: objdump only writes the number in hex.";
}

function decodeRaw(word, pc = 0n) {
  const w = u32(word);

  // Move wide: bits 28..23 = 100101.
  if (bits(w, 28, 23) === 0b100101) {
    const sf = bits(w, 31, 31);
    const opc = bits(w, 30, 29);
    const hw = bits(w, 22, 21);
    const imm16 = bits(w, 20, 5);
    const rd = bits(w, 4, 0);
    if (opc === 0b01) return { known: false, reason: "Move wide with opc = 01 is unallocated: no instruction has this encoding." };
    if (sf === 0 && hw > 1) return { known: false, reason: "A 32-bit move wide with hw = " + binary(hw, 2) + " is unallocated: a w register has no bits 32 to 63." };
    const op = opc === 0b10 ? "movz" : opc === 0b11 ? "movk" : "movn";
    const reg = regName(sf, rd);
    const shift = hw * 16;
    const shiftTxt = hw ? ", lsl #" + shift : "";
    const asm = `${op} ${reg}, #${asmImm(imm16)}${shiftTxt}`;
    const width = sf ? 64 : 32;
    const shifted = BigInt(imm16) << BigInt(shift);
    const mask = (1n << BigInt(width)) - 1n;
    let dump;
    let meaning;
    const where = rd === 31 ? `${reg}, which discards it (register 31 here means the zero register)` : reg;
    const upper = sf === 0 && rd !== 31 ? ` (writing w${rd} also clears the top 32 bits of x${rd})` : "";
    if (op === "movz") {
      const value = shifted;
      dump = imm16 === 0 && hw !== 0
        ? `movz ${reg}, #0x0${shiftTxt}`
        : `mov ${reg}, #${signedHex(BigInt.asIntN(width, value))}`;
      meaning = `Put 0x${value.toString(16)}${hw ? ` (0x${imm16.toString(16)} shifted left by ${shift})` : ""} in ${where}${upper}; every other bit becomes 0.`;
    } else if (op === "movn") {
      const value = ~shifted & mask;
      const alias = !(imm16 === 0 && hw !== 0) && !(sf === 0 && imm16 === 0xffff);
      dump = alias
        ? `mov ${reg}, #${signedHex(BigInt.asIntN(width, value))}`
        : `movn ${reg}, #0x${imm16.toString(16)}${shiftTxt}`;
      meaning = `Put NOT(0x${shifted.toString(16)}) = 0x${value.toString(16)} in ${where}${upper}: the constant with every bit flipped.`;
    } else {
      dump = `movk ${reg}, #0x${imm16.toString(16)}${shiftTxt}`;
      meaning = `Replace bits ${shift + 15} to ${shift} of ${where} with 0x${imm16.toString(16)} and keep all its other bits.`;
    }
    return {
      known: true, family: "movewide", op, operands: { sf, rd, imm16, hw },
      fields: fieldList("movewide", w), asm, dump, meaning,
    };
  }

  // Exception generation: bits 31..24 = 11010100.
  if (bits(w, 31, 24) === 0b11010100) {
    const opc = bits(w, 23, 21);
    const imm16 = bits(w, 20, 5);
    const op2 = bits(w, 4, 2);
    const ll = bits(w, 1, 0);
    let op = null;
    if (op2 === 0 && opc === 0b000 && ll !== 0) op = ["", "svc", "hvc", "smc"][ll];
    if (op2 === 0 && opc === 0b001 && ll === 0) op = "brk";
    if (op) {
      const asm = `${op} #${asmImm(imm16)}`;
      const dump = `${op} #${dumpImm(imm16)}`;
      const who = {
        svc: "Call the kernel (an app asking the operating system for a service).",
        hvc: "Call the hypervisor: the guest asks the level above it (EL2), and Hypervisor.framework hands the call to our VMM as a VM exit.",
        smc: "Call the secure monitor, the most privileged firmware on the chip.",
        brk: "Breakpoint: stop here and hand control to a debugger.",
      }[op];
      const imm = op === "brk"
        ? ` The number ${imm16} tells the debugger which breakpoint it was.`
        : ` The number ${imm16} is copied into the report the receiver gets${op === "hvc" ? ` (chapter 02 prints it as imm=0x${imm16.toString(16)})` : ""}.`;
      return {
        known: true, family: "exception", op, operands: { imm16 },
        fields: fieldList("exception", w), asm, dump, meaning: who + imm,
      };
    }
    const other = OTHERS.find((o) => (w & o.mask) >>> 0 === o.match);
    if (other) return { known: false, name: other.name, meaning: other.meaning, reason: "outside this lab's three diagrams" };
    return { known: false, reason: "Starts with 0xD4 like the exception calls, but this combination of opc, bits 4 to 2 and LL is not svc, hvc, smc or brk." };
  }

  // Unconditional branch, immediate: bits 30..26 = 00101.
  if (bits(w, 30, 26) === 0b00101) {
    const opBit = bits(w, 31, 31);
    const op = opBit ? "bl" : "b";
    const imm26 = bits(w, 25, 0);
    const insns = signExtend(imm26, 26);
    const offset = insns * 4;
    const rel = offset === 0 ? "." : offset > 0 ? `.+0x${offset.toString(16)}` : `.-0x${(-offset).toString(16)}`;
    const target = BigInt.asUintN(64, pc + BigInt(offset));
    const asm = `${op} ${rel}`;
    const dump = `${op} ${hexAddr(target)}`;
    const dir = offset === 0
      ? "to itself: an endless loop, the guest's way of parking (written b .)"
      : `${Math.abs(insns)} instruction${Math.abs(insns) === 1 ? "" : "s"} ${offset > 0 ? "forward" : "back"} (${offset > 0 ? "+" : "-"}${Math.abs(offset)} bytes)`;
    const link = opBit ? " Before jumping it saves pc + 4 in x30, so the code there can return with ret." : "";
    return {
      known: true, family: "branch", op, operands: { offset },
      fields: fieldList("branch", w), asm, dump,
      meaning: `Jump ${dir}. From ${hexAddr(pc)} that is ${hexAddr(target)}.${link}`,
      target,
    };
  }

  const other = OTHERS.find((o) => (w & o.mask) >>> 0 === o.match);
  if (other) return { known: false, name: other.name, meaning: other.meaning, reason: "outside this lab's three diagrams" };
  return { known: false, reason: "Not move wide, an exception call or a branch: this lab does not decode it. Try objdump -d (the aarch64-reading primer shows how)." };
}

/** Field labels with each field's own meaning for this word (for the readout table). */
export function fieldMeaning(d, f) {
  const v = f.value;
  if (f.fixed !== undefined) return "fixed bits that identify the family";
  if (d.family === "movewide") {
    if (f.name === "sf") return v ? "64-bit: x register" : "32-bit: w register";
    if (f.name === "opc") return { 0: "movn", 2: "movz", 3: "movk" }[v] ?? "unallocated";
    if (f.name === "hw") return `shift left by ${v * 16}`;
    if (f.name === "imm16") return `0x${v.toString(16)} = ${v}`;
    if (f.name === "Rd") return v === 31 ? "31: zero register" : `${d.operands.sf ? "x" : "w"}${v}`;
  }
  if (d.family === "exception") {
    if (f.name === "opc") return v === 0 ? "a call" : v === 1 ? "breakpoint" : "other";
    if (f.name === "imm16") return `0x${v.toString(16)} = ${v}`;
    if (f.name === "LL") return d.op;
  }
  if (d.family === "branch") {
    if (f.name === "op") return d.op;
    if (f.name === "imm26") {
      const n = d.operands.offset / 4;
      return `${n} instruction${Math.abs(n) === 1 ? "" : "s"} = ${d.operands.offset} bytes`;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Presets: words the lessons use (chapter 02, its Try it, and the aarch64-reading primer).
// `pc` (optional) is where the example sits, so a branch prints a target that makes sense in this
// machine (RAM starts at 0x4000_0000): the bl puzzle sits 9 instructions after the start of RAM,
// so its target is 0x40000000. A preset without `pc` uses DEFAULT_PC.

export const PRESETS = [
  { id: "ch02-movz", word: 0xd2800540, mode: "encode", label: "Chapter 02, word 1: movz x0, #0x2a" },
  { id: "ch02-hvc", word: 0xd4000002, mode: "encode", label: "Chapter 02, word 2: hvc #0" },
  { id: "ch02-b", word: 0x14000000, mode: "encode", label: "Chapter 02, word 3: b .", pc: 0x40000008n },
  { id: "try-lsl", word: 0xd2a00540, mode: "encode", label: "Shifted: movz x0, #0x2a, lsl #16" },
  { id: "try-hvc7", word: 0xd40000e2, mode: "encode", label: "hvc #7" },
  { id: "uart-x1", word: 0xd2a12001, mode: "encode", label: "Primer: put the UART address in x1" },
  { id: "uart-w2", word: 0x52800822, mode: "encode", label: "Primer: put 65 (ASCII A) in w2" },
  { id: "puzzle-smc", word: 0xd4000003, mode: "decode", label: "Puzzle: what is d4000003?" },
  { id: "puzzle-bl", word: 0x97fffff7, mode: "decode", label: "Puzzle: what is 97fffff7?", pc: 0x40000024n },
  { id: "puzzle-x1", word: 0xd2800541, mode: "decode", label: "Puzzle: what is d2800541?" },
];

/** Chapter 02's guest, in order, for the overview diagrams on the first screen. */
export const PROGRAM = [
  { addr: 0x40000000n, word: 0xd2800540, why: "leave a value we can read back afterwards" },
  { addr: 0x40000004n, word: 0xd4000002, why: "call the level above: our VM exit" },
  { addr: 0x40000008n, word: 0x14000000, why: "branch to itself, a safe place to park" },
];

// ---------------------------------------------------------------------------------------------
// State machine

export const DEFAULT_PC = 0x40000000n;

/**
 * State: one plain object.
 *  mode     "encode" (fields to word) or "decode" (word to fields)
 *  op       instruction picked in encode mode
 *  inputs   raw text of each operand input, so a half-typed value is not lost
 *  operands parsed operands of the last valid encode
 *  word     the current 32-bit word (encode: last valid; decode: last valid parse)
 *  prev     the word before the last change (to mark changed bits), or null
 *  hexText  raw text of the decode input
 *  pcText / pc   the instruction's own address (for branch targets)
 *  revealed decode mode: has the reader asked for the answer?
 *  error    `{ field, message }` or null
 *  note     one-off message (for example "that bit is fixed"), or null
 */
export function initialState() {
  const op = "movz";
  const operands = defaultOperands(op);
  return {
    mode: "encode",
    op,
    inputs: inputsFor(op, operands),
    operands,
    word: 0xd2800540,
    prev: null,
    hexText: "d2800540",
    pcText: "0x40000000",
    pc: DEFAULT_PC,
    revealed: false,
    error: null,
    note: null,
  };
}

/** Text for each operand input, from parsed operands. */
export function inputsFor(op, o) {
  const fam = OPS[op].family;
  if (fam === "movewide") {
    return { sf: String(o.sf), rd: String(o.rd), imm16: "0x" + o.imm16.toString(16), hw: String(o.hw) };
  }
  if (fam === "exception") return { imm16: String(o.imm16) };
  return { offset: String(o.offset) };
}

/** Parse one operand input. Selects (sf, hw) are plain integers; the rest go through parseNumber. */
function parseOperand(name, text) {
  if (name === "sf" || name === "hw") {
    const n = Number(text);
    return Number.isInteger(n) ? { ok: true, value: n } : { ok: false, error: "Pick a value." };
  }
  return parseNumber(text);
}

function withWord(state, word, extra = {}) {
  return { ...state, prev: state.word === word ? state.prev : state.word, word, error: null, note: null, ...extra };
}

/** Re-encode from `state.inputs`. Keeps the old word if an input is invalid, and reports why. */
function reencode(state) {
  const fam = OPS[state.op].family;
  const names = fam === "movewide" ? ["sf", "rd", "imm16", "hw"] : fam === "exception" ? ["imm16"] : ["offset"];
  const operands = {};
  for (const n of names) {
    const p = parseOperand(n, state.inputs[n] ?? "");
    if (!p.ok) return { ...state, error: { field: n, message: p.error }, note: null };
    operands[n] = p.value;
  }
  const e = encode(state.op, operands);
  if (!e.ok) return { ...state, error: { field: e.field, message: e.error }, note: null };
  return withWord(state, e.word, { operands, hexText: u32(e.word).toString(16).padStart(8, "0") });
}

/** Switch encode mode to show `word` (which must decode to a known family). */
function loadIntoEncoder(state, word) {
  const d = decode(word, state.pc);
  if (!d.known) return null;
  return withWord(state, word, {
    mode: "encode",
    op: d.op,
    operands: d.operands,
    inputs: inputsFor(d.op, d.operands),
    hexText: u32(word).toString(16).padStart(8, "0"),
  });
}

/**
 * The transition function. Actions:
 *  {type:"mode", mode}            {type:"op", op}
 *  {type:"input", name, text}     {type:"hex", text}       {type:"pc", text}
 *  {type:"toggle", bit}           {type:"reveal"}           {type:"preset", id}
 *  {type:"reset"}
 */
export function step(state, action) {
  switch (action.type) {
    case "reset":
      return initialState();

    case "mode": {
      if (action.mode !== "encode" && action.mode !== "decode") return state;
      if (action.mode === state.mode) return state;
      if (action.mode === "decode") {
        return { ...state, mode: "decode", hexText: u32(state.word).toString(16).padStart(8, "0"), revealed: true, error: null, note: null, prev: null };
      }
      // Back to encode: only possible if the current word belongs to a family the encoder knows.
      const loaded = loadIntoEncoder(state, state.word);
      if (loaded) return { ...loaded, prev: null };
      const fresh = initialState();
      return { ...fresh, pc: state.pc, pcText: state.pcText, note: "That word is not one the encoder builds, so it starts again from movz x0, #0x2a." };
    }

    case "op": {
      if (!OPS[action.op] || action.op === state.op) return state;
      const oldFam = OPS[state.op].family;
      const newFam = OPS[action.op].family;
      // Same family: keep the operands (movz -> movk keeps register and constant).
      const operands = oldFam === newFam && state.error === null ? state.operands : defaultOperands(action.op);
      const inputs = oldFam === newFam && state.error === null ? state.inputs : inputsFor(action.op, operands);
      return reencode({ ...state, op: action.op, operands, inputs });
    }

    case "input": {
      if (state.mode !== "encode") return state;
      const inputs = { ...state.inputs, [action.name]: String(action.text).slice(0, MAX_INPUT) };
      // A 32-bit register cannot shift by 32 or 48: clamp hw so switching x -> w is never stuck.
      if (action.name === "sf" && inputs.sf === "0" && Number(inputs.hw) > 1) inputs.hw = "1";
      return reencode({ ...state, inputs });
    }

    case "hex": {
      const text = String(action.text).slice(0, MAX_INPUT);
      const p = parseWord(text);
      if (!p.ok) return { ...state, hexText: text, error: { field: "hex", message: p.error }, note: null };
      const note = p.bytes
        ? `Those look like four bytes in memory order, as xxd or objdump -s prints them. A64 is little-endian (least significant byte first), so they are the word ${hex32(p.value)}.`
        : null;
      return withWord(state, p.value, { hexText: text, note, revealed: p.value === state.word ? state.revealed : false });
    }

    case "pc": {
      const text = String(action.text).slice(0, MAX_INPUT);
      const p = parseAddress(text);
      if (!p.ok) return { ...state, pcText: text, error: { field: "pc", message: p.error }, note: null };
      return { ...state, pcText: text, pc: p.value, error: null, note: null };
    }

    case "toggle": {
      const b = action.bit;
      if (!Number.isInteger(b) || b < 0 || b > 31) return state;
      const next = u32(state.word ^ (1 << b));
      if (state.mode === "decode") {
        return withWord(state, next, { hexText: next.toString(16).padStart(8, "0") });
      }
      const cur = decode(state.word, state.pc);
      const field = cur.known ? cur.fields.find((f) => b >= f.lo && b <= f.hi) : null;
      if (field && field.fixed !== undefined) {
        return { ...state, note: `Bit ${b} is one of the fixed bits that say "${FAMILIES[cur.family].title.split(" (")[0].toLowerCase()}". Flip it and the word means a different kind of instruction: try it in Decode mode.`, error: null };
      }
      const d = decode(next, state.pc);
      if (!d.known || d.family !== cur.family) {
        return { ...state, note: `Flipping bit ${b} gives ${hex32(next)}, which is ${d.known ? "a different instruction" : "not a valid instruction of this family"}. ${d.known ? "" : d.reason}`.trim(), error: null };
      }
      const loaded = loadIntoEncoder(state, next);
      return loaded;
    }

    case "reveal":
      return state.mode === "decode" ? { ...state, revealed: true } : state;

    case "preset": {
      const p = PRESETS.find((x) => x.id === action.id);
      if (!p) return state;
      const pc = p.pc ?? DEFAULT_PC;
      const placed = { ...state, pc, pcText: hexAddr(pc) };
      if (p.mode === "decode") {
        return withWord(placed, p.word, { mode: "decode", hexText: p.word.toString(16).padStart(8, "0"), revealed: false });
      }
      return loadIntoEncoder(placed, p.word) ?? state;
    }

    default:
      return state;
  }
}

/** Bits that differ between `state.prev` and `state.word` (array of 32 booleans, index = bit). */
export function changedBits(state) {
  const out = new Array(32).fill(false);
  if (state.prev === null || state.prev === undefined) return out;
  const x = u32(state.prev ^ state.word);
  for (let i = 0; i < 32; i++) out[i] = ((x >>> i) & 1) === 1;
  return out;
}

/** One plain-text sentence for the live region. */
export function summary(state) {
  const bytes = leBytes(state.word).join(" ");
  if (state.mode === "decode" && !state.revealed) {
    return `${hex32(state.word)}. Bytes in memory: ${bytes}. Decide what it is, then press Tell me.`;
  }
  const d = decode(state.word, state.pc);
  if (d.known) return `${hex32(state.word)}: ${d.asm}. ${d.meaning} Bytes in memory: ${bytes}.`;
  if (d.name) return `${hex32(state.word)}: ${d.name}, ${d.meaning}. Bytes in memory: ${bytes}.`;
  return `${hex32(state.word)}: ${d.reason} Bytes in memory: ${bytes}.`;
}

// ---------------------------------------------------------------------------------------------
// Share state: "<e|d>:<8 hex digits>[@<address>]", for example "d:97fffff7@6c".

export function toShare(state) {
  const m = state.mode === "decode" ? "d" : "e";
  const pc = state.pc === DEFAULT_PC ? "" : "@" + BigInt.asUintN(64, state.pc).toString(16);
  return `${m}:${u32(state.word).toString(16).padStart(8, "0")}${pc}`;
}

/** Restore from a share string. Anything malformed gives the initial state (never a throw). */
export function fromShare(str) {
  const base = initialState();
  if (typeof str !== "string" || str.length > 40) return base;
  const m = /^([ed]):([0-9a-fA-F]{8})(?:@([0-9a-fA-F]{1,16}))?$/.exec(str);
  if (!m) return base;
  const word = u32(parseInt(m[2], 16));
  let s = base;
  if (m[3]) {
    const pc = BigInt("0x" + m[3]);
    s = { ...s, pc, pcText: hexAddr(pc) };
  }
  if (m[1] === "e") {
    const loaded = loadIntoEncoder(s, word);
    if (loaded) return { ...loaded, prev: null };
  }
  return { ...s, mode: "decode", word, prev: null, hexText: word.toString(16).padStart(8, "0"), revealed: false };
}
