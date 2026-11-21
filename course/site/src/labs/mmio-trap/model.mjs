// mmio-trap model: a step-by-step emulator of chapter 07's MMIO path. A tiny arm64 interpreter
// runs a few real guest instructions; a load or store outside RAM becomes a data-abort exit,
// and the VMM side then does exactly what chapter 07's handler does, using only the syndrome:
// exit record -> decode (ISV, SAS, SSE, SRT, SF, WnR) -> classify and route on the bus ->
// device effect -> PC + 4.
//
// Pure ES module: no DOM, no globals, no I/O. The view (view.mjs) only renders frames.
//
// Faithfulness. The listings of the `probe`, `sign`, `xzr`, `isv0` and `hole` programs are the
// real instructions of guests/mmio-probe, guests/isv0-probe and guests/mmio-poke, disassembled
// at the addresses the course's captures show (the encoder below re-derives every word, and
// model.test.mjs checks it). Running them reproduces course/captures/07-mmio-probe.trace.jsonl
// record for record (t_ns left out), 07-xzr-as-register.txt, 07-isv0-stop.txt,
// 07-isv0-guess.txt (its first check), 05-poke-log.txt and 07-no-advance-trace.txt.
// Messages use the reference's wording (crates/vmm/src/vcpu/mmio.rs, exit.rs, devices/).
//
// Hardening: every input is a string the reader typed or pasted into the URL. The parser
// accepts a small, explicit grammar with length caps; numbers are range-checked BigInts; the
// timeline is capped; nothing is evaluated.

// ---- constants: the machine (crates/vmm/src/arch/layout.rs) ----------------------------------

export const M64 = (1n << 64n) - 1n;
export const M32 = 0xffff_ffffn;
export const RAM_BASE = 0x4000_0000n;
export const RAM_SIZE = 64n << 20n; // --mem 64M, as every chapter 07 command uses
export const TESTDEV_BASE = 0x0b00_0000n;
export const TESTDEV_SIZE = 0x1000n; // 512 registers of 8 bytes
export const TESTDEV_REGS = 512;
export const UART_BASE = 0x0900_0000n;
export const UART_SIZE = 0x1000n;
export const UART_FR_RESET = 0x90n; // TXFE | RXFE: transmit empty, nothing received
export const PROBE_HOLE_BASE = 0x0c00_0000n;
export const MAX_FRAMES = 4000;
export const MAX_LINE = 80;
export const MAX_EDITS = 24;
export const NO_ADVANCE_REPEATS = 3;
export const NO_ADVANCE_OBSERVED = "324,719"; // captures/07-no-advance-trace.txt, 2 s run
/** The VM's IPA size: the reference picks 36 bits for --mem 64M (chapter 05, ipa_bits_needed). */
export const IPA_BITS = 36n;
/** The physical address size the guest sees (ID_AA64MMFR0_EL1.PARange = 2 on our Mac,
 *  crates/hvf/src/caps.rs). With the MMU off, a wider address faults inside the guest. */
export const GUEST_PA_BITS = 40n;
/** guest_warn! lets the first BURST messages of a call site through, then every EVERY-th
 *  (crates/vmm/src/log.rs, RateLimit). */
export const WARN_BURST = 10;
export const WARN_EVERY = 1000;

/** The `virt` board's regions below RAM (layout.rs VIRT_REGIONS), for naming a hole. */
export const BOARD_REGIONS = [
  { name: "flash0", base: 0x0000_0000n, size: 0x0400_0000n },
  { name: "flash1", base: 0x0400_0000n, size: 0x0400_0000n },
  { name: "gicd", base: 0x0800_0000n, size: 0x0001_0000n },
  { name: "gicv2-cpu", base: 0x0801_0000n, size: 0x0001_0000n },
  { name: "gic-v2m", base: 0x0802_0000n, size: 0x0001_0000n },
  { name: "gic-its", base: 0x0808_0000n, size: 0x0002_0000n },
  { name: "gicr", base: 0x080a_0000n, size: 0x00f6_0000n },
  { name: "pl011", base: 0x0900_0000n, size: 0x1000n },
  { name: "pl031", base: 0x0901_0000n, size: 0x1000n },
  { name: "fw-cfg", base: 0x0902_0000n, size: 0x18n },
  { name: "pl061", base: 0x0903_0000n, size: 0x1000n },
  { name: "virtio-mmio", base: 0x0a00_0000n, size: 0x4000n },
  { name: "testdev", base: 0x0b00_0000n, size: 0x1000n },
  { name: "probe-hole", base: 0x0c00_0000n, size: 0x0200_0000n },
  { name: "pcie-mmio", base: 0x1000_0000n, size: 0x2eff_0000n },
  { name: "pcie-pio", base: 0x3eff_0000n, size: 0x0001_0000n },
  { name: "pcie-ecam", base: 0x3f00_0000n, size: 0x0100_0000n },
];

// ---- small helpers ---------------------------------------------------------------------------

/** `0x`-prefixed lowercase hex, no padding (the trace's style). */
export function hex(v) {
  return "0x" + BigInt.asUintN(64, BigInt(v)).toString(16);
}
/** Hex padded to 16 digits with an underscore in the middle, for the register table. */
export function hex64(v) {
  const s = BigInt.asUintN(64, BigInt(v)).toString(16).padStart(16, "0");
  return `0x${s.slice(0, 8)}_${s.slice(8)}`;
}
function sizeMask(bytes) {
  return (1n << BigInt(bytes * 8)) - 1n;
}
const SAS_OF = { 1: 0, 2: 1, 4: 2, 8: 3 };

/** Chapter 07's sign_extend: SSE extends from the access size, SF picks a w or x result. */
export function signExtend(v, size, sse, sf) {
  let x = v & sizeMask(size);
  if (sse) {
    const top = 1n << BigInt(size * 8 - 1);
    if (x & top) x = (x | ~sizeMask(size)) & M64;
  }
  return sf ? x : x & M32;
}

// ---- ESR_EL2 for a data abort (ARM ARM DDI 0487, ESR_EL2, ISS encoding for a Data Abort) -----

export const EC_DABT_LOWER = 0x24;
export const DFSC_HOLE = 0x6; // translation fault, level 2: what our holes showed on a real Mac
export const DFSC_BEYOND_IPA = 0x4; // translation fault, level 0: captures/05-beyond-ipa.txt
export const EC_DABT_CUR = 0x25; // a data abort taken at the guest's own level, EL1

/** Fields -> ESR (bits 31:0). Fields as in course/site/labs/vectors/esr.json. */
export function encodeDataAbortEsr(f) {
  let v = (EC_DABT_LOWER << 26) | (1 << 25);
  if (f.isv) v |= 1 << 24;
  v |= ((f.sas ?? 0) & 3) << 22;
  if (f.sse) v |= 1 << 21;
  v |= ((f.srt ?? 0) & 31) << 16;
  if (f.sf) v |= 1 << 15;
  if (f.ar) v |= 1 << 14;
  if (f.fnv) v |= 1 << 10;
  if (f.s1ptw) v |= 1 << 7;
  if (f.wnr) v |= 1 << 6;
  v |= (f.dfsc ?? 0) & 0x3f;
  return v >>> 0;
}

/** ESR -> data-abort fields, masking every field to its width whether or not ISV is set. */
export function decodeDataAbort(esrIn) {
  const esr = Number(BigInt.asUintN(32, BigInt(esrIn)));
  return {
    ec: (esr >>> 26) & 0x3f,
    il: (esr >>> 25) & 1,
    isv: Boolean((esr >>> 24) & 1),
    sas: (esr >>> 22) & 3,
    sse: Boolean((esr >>> 21) & 1),
    srt: (esr >>> 16) & 31,
    sf: Boolean((esr >>> 15) & 1),
    ar: Boolean((esr >>> 14) & 1),
    fnv: Boolean((esr >>> 10) & 1),
    s1ptw: Boolean((esr >>> 7) & 1),
    wnr: Boolean((esr >>> 6) & 1),
    dfsc: esr & 0x3f,
  };
}

/** The reference's fsc_name (crates/vmm/src/arch/esr.rs), range for range. */
export function fscName(f) {
  if (f >= 0x00 && f <= 0x03) return "address size fault";
  if (f >= 0x04 && f <= 0x07) return "translation fault";
  if (f >= 0x08 && f <= 0x0b) return "access flag fault";
  if (f >= 0x0c && f <= 0x0f) return "permission fault";
  if (f === 0x10) return "synchronous external abort";
  if (f === 0x11) return "synchronous tag check fault";
  if (f >= 0x14 && f <= 0x17) return "synchronous external abort on a table walk";
  if (f === 0x21) return "alignment fault";
  if (f === 0x30) return "TLB conflict abort";
  return null;
}

/** The reference's `Display` for a DataAbort (crates/vmm/src/arch/esr.rs). */
export function displayDataAbort(d) {
  const b = (x) => (x ? 1 : 0);
  let s = `ISV=${b(d.isv)} SAS=${d.sas} (${1 << d.sas} bytes) SSE=${b(d.sse)} SRT=${d.srt} SF=${b(d.sf)} ` +
    `AR=${b(d.ar)} FnV=${b(d.fnv)} S1PTW=${b(d.s1ptw)} WnR=${b(d.wnr)} DFSC=0x${d.dfsc.toString(16)}`;
  const n = fscName(d.dfsc);
  if (n) s += ` (${n})`;
  return s;
}

// ---- parser: a small, explicit arm64 subset ---------------------------------------------------

const LS = {
  // mnemonic: [load, size (null = from register width), signed, allowed widths]
  str: [false, null, false, "wx"],
  strb: [false, 1, false, "w"],
  strh: [false, 2, false, "w"],
  ldr: [true, null, false, "wx"],
  ldrb: [true, 1, false, "w"],
  ldrh: [true, 2, false, "w"],
  ldrsb: [true, 1, true, "wx"],
  ldrsh: [true, 2, true, "wx"],
  ldrsw: [true, 4, true, "x"],
};

const NUM = String.raw`#?\s*-?\s*(?:0x[0-9a-f_]+|\d+)`;

function parseNum(tok, what) {
  const t = tok.replace(/^#/, "").replace(/\s+/g, "").replace(/_/g, "");
  const m = /^(-?)(0x[0-9a-f]{1,16}|\d{1,20})$/.exec(t);
  if (!m) throw new Error(`${what}: "${tok}" is not a number the lab understands`);
  let v = BigInt(m[2]);
  if (v > M64) throw new Error(`${what}: ${tok} does not fit in 64 bits`);
  if (m[1]) v = -v;
  return v;
}

/** A data register: w0..w30, x0..x30, wzr, xzr (n = 31). */
function parseReg(tok, { allowSp = false } = {}) {
  if (tok === "xzr") return { n: 31, x: true, zr: true };
  if (tok === "wzr") return { n: 31, x: false, zr: true };
  if (tok === "sp") {
    if (allowSp) return { n: 31, x: true, sp: true };
    throw new Error("sp cannot be used here");
  }
  const m = /^([wx])(\d{1,2})$/.exec(tok);
  if (!m || Number(m[2]) > 30) throw new Error(`"${tok}" is not a register (w0-w30, x0-x30, wzr, xzr)`);
  return { n: Number(m[2]), x: m[1] === "x" };
}

/** A base register: x0..x30 or sp. */
function parseBase(tok) {
  if (tok === "sp") return { n: 31, x: true, sp: true };
  const m = /^x(\d{1,2})$/.exec(tok);
  if (!m || Number(m[1]) > 30) throw new Error(`the address register must be x0-x30 or sp, not "${tok}"`);
  return { n: Number(m[1]), x: true };
}

const ADDR_RE = new RegExp(String.raw`^\[\s*(\w+)\s*(?:,\s*(${NUM}))?\s*\]\s*(!)?\s*(?:,\s*(${NUM}))?$`);

function parseAddr(s) {
  const m = ADDR_RE.exec(s);
  if (!m) throw new Error(`"${s}" is not an address the lab understands, e.g. [x9], [x0, #0x18], [x1, #8]! or [x1], #8`);
  const base = parseBase(m[1]);
  const inner = m[2] !== undefined ? parseNum(m[2], "offset") : null;
  const post = m[4] !== undefined ? parseNum(m[4], "offset") : null;
  if (m[3] && inner === null) throw new Error("a pre-index form needs an offset: [x1, #8]!");
  if (post !== null && (inner !== null || m[3])) throw new Error("use either [xN, #off]! or [xN], #off, not both");
  if (post !== null) return { base, mode: "post", imm: post };
  if (m[3]) return { base, mode: "pre", imm: inner };
  return { base, mode: "off", imm: inner ?? 0n };
}

/**
 * Parse one line of the lab's assembly. Returns {ok: true, insn} or {ok: false, error}.
 * Never throws for any string.
 */
export function parseLine(text, funcs = {}) {
  try {
    if (typeof text !== "string") throw new Error("not text");
    if (text.length > MAX_LINE) throw new Error(`a line is at most ${MAX_LINE} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error("control characters are not allowed");
    const s = text.split(/;|\/\//)[0].trim().toLowerCase().replace(/\s+/g, " ");
    if (s === "") throw new Error("empty line");
    return { ok: true, insn: parseInsn(s, funcs) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function splitOperands(rest) {
  // Split on commas outside brackets.
  const out = [];
  let depth = 0, cur = "";
  for (const ch of rest) {
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function parseInsn(s, funcs) {
  const sp = s.indexOf(" ");
  const mn = sp < 0 ? s : s.slice(0, sp);
  const rest = sp < 0 ? "" : s.slice(sp + 1);
  if (mn === "nop") {
    if (rest) throw new Error("nop takes no operands");
    return { op: "nop" };
  }
  if (mn === "bl") {
    if (!Object.prototype.hasOwnProperty.call(funcs, rest)) {
      const names = Object.keys(funcs);
      throw new Error(names.length ? `this program can only call ${names.join(" or ")}` : "this program calls no functions");
    }
    return { op: "bl", target: rest };
  }
  if (mn === "mov" || mn === "movk") {
    const ops = splitOperands(rest);
    const rd = parseReg(ops[0] ?? "");
    if (mn === "movk") {
      if (ops.length < 2 || ops.length > 3) throw new Error("movk takes a register, #imm16 and an optional lsl #shift");
      if (rd.zr) throw new Error("movk into the zero register does nothing");
      const imm = parseNum(ops[1], "movk value");
      if (imm < 0n || imm > 0xffffn) throw new Error("movk takes a 16-bit value (0 to 0xffff)");
      let shift = 0;
      if (ops[2] !== undefined) {
        const m = /^lsl\s*#?\s*(\d{1,2})$/.exec(ops[2]);
        if (!m) throw new Error('the shift is written "lsl #16"');
        shift = Number(m[1]);
      }
      const ok = rd.x ? [0, 16, 32, 48] : [0, 16];
      if (!ok.includes(shift)) throw new Error(`the shift must be ${ok.join(", ")}`);
      return { op: "movk", rd, imm, shift };
    }
    if (ops.length !== 2) throw new Error("mov takes two operands");
    if (ops[1].startsWith("#") || /^-?\d|^-?0x/.test(ops[1])) {
      const imm = parseNum(ops[1], "mov value");
      const lo = rd.x ? -(1n << 63n) : -(1n << 31n);
      const hi = rd.x ? M64 : M32;
      if (imm < lo || imm > hi) throw new Error(`the value does not fit in a ${rd.x ? 64 : 32}-bit register`);
      const movi = { op: "movi", rd, imm: imm & (rd.x ? M64 : M32) };
      if (encode(movi) === null) throw new Error("one mov cannot build this value: use mov plus movk, as the probe does");
      return movi;
    }
    const rm = parseReg(ops[1], { allowSp: true });
    if (rm.sp && !rd.x) throw new Error("copy sp into an x register");
    if (!rm.sp && rm.x !== rd.x) throw new Error("both registers must be the same width (w and w, or x and x)");
    if (rd.zr) throw new Error("a mov into the zero register does nothing");
    return { op: "movr", rd, rm };
  }
  if (Object.prototype.hasOwnProperty.call(LS, mn)) {
    const [load, fixed, signed, widths] = LS[mn];
    const ops = splitOperands(rest);
    if (ops.length < 2) throw new Error(`${mn} takes a register and an address`);
    const rt = parseReg(ops[0]);
    if (!widths.includes(rt.x ? "x" : "w")) throw new Error(`${mn} needs a${widths === "x" ? "n x" : " w"} register`);
    const a = parseAddr(ops.slice(1).join(", "));
    const size = fixed ?? (rt.x ? 8 : 4);
    if (load && a.mode !== "off" && !rt.zr && !a.base.sp && a.base.n === rt.n) {
      throw new Error("Arm leaves a load that writes back into its own data register unpredictable");
    }
    if (!load && a.mode !== "off" && !rt.zr && !a.base.sp && a.base.n === rt.n) {
      throw new Error("Arm leaves a store that writes back into its own data register unpredictable");
    }
    let unscaled = false;
    if (a.mode === "off") {
      const scaledOk = a.imm >= 0n && a.imm % BigInt(size) === 0n && a.imm / BigInt(size) <= 4095n;
      if (!scaledOk) {
        if (a.imm < -256n || a.imm > 255n) throw new Error(`offset ${a.imm} cannot be encoded: use a multiple of ${size} up to ${4095 * size}, or -256 to 255`);
        unscaled = true;
      }
    } else if (a.imm < -256n || a.imm > 255n) {
      throw new Error("a writeback offset must be -256 to 255");
    }
    return { op: "ls", mn, load, size, signed, rt, base: a.base, mode: a.mode, imm: a.imm, unscaled };
  }
  if (mn === "stp" || mn === "ldp" || mn === "ldpsw") {
    const ops = splitOperands(rest);
    if (ops.length < 3) throw new Error(`${mn} takes two registers and an address`);
    const rt = parseReg(ops[0]);
    const rt2 = parseReg(ops[1]);
    if (rt.x !== rt2.x) throw new Error("both registers of a pair have the same width");
    if (mn === "ldpsw" && !rt.x) throw new Error("ldpsw loads into x registers");
    const a = parseAddr(ops.slice(2).join(", "));
    const load = mn !== "stp";
    if (load && rt.n === rt2.n) throw new Error("Arm leaves a pair load into the same register twice unpredictable");
    if (a.mode !== "off" && !a.base.sp && ((!rt.zr && a.base.n === rt.n) || (!rt2.zr && a.base.n === rt2.n))) {
      throw new Error("Arm leaves a writeback into a data register of the pair unpredictable");
    }
    const size = mn === "ldpsw" ? 4 : rt.x ? 8 : 4;
    if (a.imm % BigInt(size) !== 0n || a.imm / BigInt(size) < -64n || a.imm / BigInt(size) > 63n) {
      throw new Error(`a pair offset is a multiple of ${size} from ${-64 * size} to ${63 * size}`);
    }
    return { op: "pair", mn, load, size, signed: mn === "ldpsw", rt, rt2, base: a.base, mode: a.mode, imm: a.imm };
  }
  throw new Error(`"${mn}" is not one of the instructions this lab runs (mov, movk, nop, bl, ldr/str and their b/h/sb/sh/sw forms, ldp/stp/ldpsw)`);
}

// ---- encoder (so the ISV = 0 stop can print the instruction word) -----------------------------

function chunks(v, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number((v >> BigInt(16 * i)) & 0xffffn));
  return out;
}

/** ARM ARM "DecodeBitMasks", inverted: the N:immr:imms encoding of a bitmask immediate, or null. */
function encodeBitmask(v, width) {
  const all = width === 64 ? M64 : M32;
  if (v === 0n || v === all) return null;
  for (let size = 2; size <= width; size *= 2) {
    const m = (1n << BigInt(size)) - 1n;
    const elt = v & m;
    let rep = 0n;
    for (let i = 0; i < width; i += size) rep |= elt << BigInt(i);
    if (rep !== v) continue;
    // elt must be a rotation of a contiguous run of ones.
    for (let r = 0; r < size; r++) {
      // rotate elt left by r (within size) and see if it is 0..01..1
      const rot = ((elt << BigInt(r)) | (elt >> BigInt(size - r))) & m;
      if (rot !== 0n && (rot & (rot + 1n)) === 0n) {
        const ones = rot.toString(2).length;
        if (ones === size) return null;
        const immr = r; // v = ROR(ones, r), since ROL(v, r) = ones
        const nbit = size === 64 ? 1 : 0;
        const imms = ((~(size * 2 - 1) & 0x3f) | (ones - 1)) & 0x3f;
        return { n: nbit, immr, imms };
      }
    }
    return null;
  }
  return null;
}

/** The 32-bit word for a parsed instruction at `pc`, or null if one instruction cannot do it. */
export function encode(insn, pc = 0n, funcs = {}) {
  const r = (reg) => reg.n & 31;
  switch (insn.op) {
    case "nop": return 0xd503201f;
    case "bl": {
      const f = funcs[insn.target];
      if (!f) return null;
      const off = (BigInt(f.addr) - BigInt(pc)) >> 2n;
      return (0x94000000 | Number(BigInt.asUintN(26, off))) >>> 0;
    }
    case "movi": {
      const w = insn.rd.x ? 64 : 32;
      const n = w / 16;
      const sf = insn.rd.x ? 0x80000000 : 0;
      const z = chunks(insn.imm, n);
      const nz = z.filter((c) => c !== 0).length;
      if (nz <= 1) {
        const hw = Math.max(0, z.findIndex((c) => c !== 0));
        return (sf | 0x52800000 | (hw << 21) | (z[hw] << 5) | r(insn.rd)) >>> 0;
      }
      const inv = ~insn.imm & (insn.rd.x ? M64 : M32);
      const zi = chunks(inv, n);
      if (zi.filter((c) => c !== 0).length <= 1) {
        const hw = Math.max(0, zi.findIndex((c) => c !== 0));
        return (sf | 0x12800000 | (hw << 21) | (zi[hw] << 5) | r(insn.rd)) >>> 0;
      }
      const bm = encodeBitmask(insn.imm, w);
      if (bm) {
        // ORR Rd, ZR, #imm
        return (sf | 0x32000000 | (bm.n << 22) | (bm.immr << 16) | (bm.imms << 10) | (31 << 5) | r(insn.rd)) >>> 0;
      }
      return null; // an assembler would need mov + movk
    }
    case "movr":
      if (insn.rm.sp) return (0x910003e0 | r(insn.rd)) >>> 0; // add Xd, sp, #0
      return ((insn.rd.x ? 0xaa0003e0 : 0x2a0003e0) | (r(insn.rm) << 16) | r(insn.rd)) >>> 0; // orr Rd, zr, Rm
    case "movk":
      return ((insn.rd.x ? 0xf2800000 : 0x72800000) | ((insn.shift / 16) << 21) | (Number(insn.imm) << 5) | r(insn.rd)) >>> 0;
    case "ls": {
      const size = SAS_OF[insn.size];
      let opc = insn.load ? 1 : 0;
      if (insn.signed) opc = insn.rt.x ? 2 : 3;
      const head = (size << 30) | (opc << 22) | (r(insn.base) << 5) | r(insn.rt);
      if (insn.mode === "off" && !insn.unscaled) {
        return (0x39000000 | head | (Number(insn.imm / BigInt(insn.size)) << 10)) >>> 0;
      }
      const idx = insn.mode === "post" ? 1 : insn.mode === "pre" ? 3 : 0;
      return (0x38000000 | head | (Number(BigInt.asUintN(9, insn.imm)) << 12) | (idx << 10)) >>> 0;
    }
    case "pair": {
      const opc = insn.signed ? 1 : insn.rt.x ? 2 : 0;
      const mode = insn.mode === "post" ? 1 : insn.mode === "off" ? 2 : 3;
      const imm7 = Number(BigInt.asUintN(7, insn.imm / BigInt(insn.size)));
      return ((opc << 30) | 0x28000000 | (mode << 23) | ((insn.load ? 1 : 0) << 22) | (imm7 << 15) |
        (r(insn.rt2) << 10) | (r(insn.base) << 5) | r(insn.rt)) >>> 0;
    }
    default: return null;
  }
}

// ---- programs --------------------------------------------------------------------------------

const PROBE_FUNCS = { check: { addr: 0x40081040n, kind: "probe-check" } };

// [pc, word from the disassembly, text, call details for a bl]
const PROBE_LINES = [
  [0x400810dc, 0x52800b48, "mov w8, #0x5a"],
  [0x400810e0, 0x52a16014, "mov w20, #0xb000000"],
  [0x400810e4, 0x39000288, "strb w8, [x20]"],
  [0x400810f0, 0x39400283, "ldrb w3, [x20]"],
  [0x400810fc, 0x52800b44, "mov w4, #0x5a"],
  [0x40081104, 0x97ffffcf, "bl check", { name: "strb/ldrb" }],
  [0x40081108, 0x5297dde8, "mov w8, #0xbeef"],
  [0x4008110c, 0x79000288, "strh w8, [x20]"],
  [0x40081118, 0x79400283, "ldrh w3, [x20]"],
  [0x40081124, 0x5297dde4, "mov w4, #0xbeef"],
  [0x40081128, 0x97ffffc6, "bl check", { name: "strh/ldrh" }],
  [0x4008112c, 0x5297dde8, "mov w8, #0xbeef"],
  [0x40081130, 0x5297dde4, "mov w4, #0xbeef"],
  [0x4008113c, 0x72bbd5a8, "movk w8, #0xdead, lsl #16"],
  [0x40081140, 0xb9000288, "str w8, [x20]"],
  [0x40081144, 0xb9400283, "ldr w3, [x20]"],
  [0x40081150, 0x72bbd5a4, "movk w4, #0xdead, lsl #16"],
  [0x40081154, 0x97ffffbb, "bl check", { name: "str w/ldr w" }],
  [0x40081158, 0xd299bde4, "mov x4, #0xcdef"],
  [0x40081164, 0xf2b13564, "movk x4, #0x89ab, lsl #16"],
  [0x40081170, 0xf2c8ace4, "movk x4, #0x4567, lsl #32"],
  [0x40081174, 0xf2e02464, "movk x4, #0x123, lsl #48"],
  [0x40081178, 0xf9000284, "str x4, [x20]"],
  [0x4008117c, 0xf9400283, "ldr x3, [x20]"],
  [0x40081180, 0x97ffffb0, "bl check", { name: "str x/ldr x" }],
  [0x40081184, 0xd29bc849, "mov x9, #0xde42"],
  [0x40081188, 0x52800108, "mov w8, #0x8"],
  [0x4008118c, 0x92800014, "mov x20, #-0x1"],
  [0x40081190, 0xf2b35789, "movk x9, #0x9abc, lsl #16"],
  [0x40081194, 0x72a16008, "movk w8, #0xb00, lsl #16"],
  [0x40081198, 0xf9000114, "str x20, [x8]"],
  [0x4008119c, 0xf2cacf09, "movk x9, #0x5678, lsl #32"],
  [0x400811a8, 0xf2e24689, "movk x9, #0x1234, lsl #48"],
  [0x400811ac, 0x39000109, "strb w9, [x8]"],
  [0x400811b4, 0xf9400103, "ldr x3, [x8]"],
  [0x400811bc, 0x928017a4, "mov x4, #-0xbe"],
  [0x400811c0, 0x97ffffa0, "bl check", { name: "write masked to 1 byte" }],
  [0x400811c4, 0x52800208, "mov w8, #0x10"],
  [0x400811d0, 0x72a16008, "movk w8, #0xb00, lsl #16"],
  [0x400811d4, 0xf9000114, "str x20, [x8]"],
  [0x400811dc, 0xf900011f, "str xzr, [x8]"],
  [0x400811e4, 0xaa1f03e4, "mov x4, xzr"],
  [0x400811e8, 0xf9400103, "ldr x3, [x8]"],
  [0x400811ec, 0x97ffff95, "bl check", { name: "str xzr stores 0" }],
  [0x400811f0, 0x52800309, "mov w9, #0x18"],
  [0x400811f4, 0x52822228, "mov w8, #0x1111"],
  [0x40081200, 0x72a16009, "movk w9, #0xb00, lsl #16"],
  [0x40081204, 0xf9000128, "str x8, [x9]"],
  [0x40081208, 0x910003e4, "mov x4, sp"],
  [0x4008120c, 0xf940013f, "ldr xzr, [x9]"],
  [0x40081218, 0x910003e3, "mov x3, sp"],
  [0x4008121c, 0x97ffff89, "bl check", { name: "ldr xzr discarded (sp kept)" }],
  [0x40081220, 0x52800409, "mov w9, #0x20"],
  [0x40081224, 0x52801008, "mov w8, #0x80"],
  [0x40081230, 0x72a16009, "movk w9, #0xb00, lsl #16"],
  [0x40081234, 0x39000128, "strb w8, [x9]"],
  [0x40081238, 0x39c00123, "ldrsb w3, [x9]"],
  [0x40081244, 0x12800fe4, "mov w4, #-0x80"],
  [0x40081248, 0x97ffff7e, "bl check", { name: "ldrsb w sign-extends to 32" }],
  [0x4008124c, 0x52800509, "mov w9, #0x28"],
  [0x40081250, 0x52900028, "mov w8, #0x8001"],
  [0x4008125c, 0x72a16009, "movk w9, #0xb00, lsl #16"],
  [0x40081260, 0x79000128, "strh w8, [x9]"],
  [0x40081264, 0x79800123, "ldrsh x3, [x9]"],
  [0x40081270, 0x928fffc4, "mov x4, #-0x7fff"],
  [0x40081274, 0x97ffff73, "bl check", { name: "ldrsh x sign-extends to 64" }],
  [0x40081278, 0x52800609, "mov w9, #0x30"],
  [0x4008127c, 0x52b00008, "mov w8, #-0x80000000"],
  [0x40081288, 0x72a16009, "movk w9, #0xb00, lsl #16"],
  [0x4008128c, 0xb9000128, "str w8, [x9]"],
  [0x40081290, 0xb9800123, "ldrsw x3, [x9]"],
  [0x4008129c, 0xb26183e4, "mov x4, #-0x80000000"],
  [0x400812a0, 0x97ffff68, "bl check", { name: "ldrsw x sign-extends to 64" }],
];

const probeSlice = (from, to) => PROBE_LINES.filter(([pc]) => pc >= from && pc <= to);

// Stack pointer for the mmio-probe programs: not in any capture, so illustrative.
const PROBE_SP = 0x40098f50n;

// isv0-probe registers at its first stp, from captures/07-isv0-stop.txt's dump.
const ISV0_DUMP = [
  0x0n, 0x40083abcn, 0x0n, 0x0n, 0x0n, 0x0n, 0x0n, 0x0n,
  0xb000000n, 0x1111222233334444n, 0x5555666677778888n, 0x30001185n,
  0xff00n, 0x0n, 0x0n, 0x0n, 0x0n, 0x0n, 0x40083abcn, 0x0n,
  0x0n, 0x0n, 0x1111222233334444n, 0x5555666677778888n, 0xb000000n, 0x0n, 0x0n, 0x0n,
  0x0n, 0x0n, 0x400811f8n,
];

/** The programs. `board`: which devices are on the bus at the start. */
export const PROGRAMS = {
  sign: {
    title: "Sign extension (mmio-probe checks 8 to 10)",
    summary: "The probe stores 0x80, 0x8001 and 0x8000_0000 to the test device, then loads each back with a sign-extending load. These are the last six records of chapter 07's trace; the fourth is the ldrsh x3 the lesson asks you to trace on paper.",
    guest: "mmio-probe",
    source: "guests/mmio-probe, disassembled; addresses as in the chapter 07 capture",
    board: { testdev: true, uart: false },
    mmu: "off",
    sp: PROBE_SP,
    regs: {},
    funcs: PROBE_FUNCS,
    lines: probeSlice(0x40081220, 0x400812a0),
  },
  xzr: {
    title: "Register 31 is xzr (mmio-probe checks 6 and 7)",
    summary: "str xzr must store zero and ldr xzr must throw the value away. In Hypervisor.framework's numbering, register 31 is the PC, so a VMM that passes SRT = 31 through unchanged reads or writes the PC instead. To watch that happen, open Machine, policy and deliberate breakages below and tick breakage 2.",
    guest: "mmio-probe",
    source: "guests/mmio-probe, disassembled; addresses as in the chapter 07 capture",
    board: { testdev: true, uart: false },
    mmu: "off",
    sp: PROBE_SP,
    regs: { 20: M64 }, // left by check 5 (mov x20, #-0x1)
    funcs: PROBE_FUNCS,
    lines: probeSlice(0x400811c4, 0x4008121c),
  },
  probe: {
    title: "The whole mmio-probe run (22 exits)",
    summary: "All ten checks of chapter 07's probe: four sizes, write masking, xzr both ways and three sign extensions. Run it to the end and compare the trace with the lesson's capture.",
    guest: "mmio-probe",
    source: "guests/mmio-probe, disassembled; addresses as in the chapter 07 capture",
    board: { testdev: true, uart: false },
    mmu: "off",
    sp: PROBE_SP,
    regs: {},
    funcs: PROBE_FUNCS,
    lines: PROBE_LINES,
    total: { prefix: "mmio-probe", of: 10 },
  },
  isv0: {
    title: "A blank note: stp (isv0-probe)",
    summary: "stp stores two registers, so the syndrome has no room to describe it: ISV = 0. Chapter 07's VMM stops and prints the instruction word. To see what guessing does instead, open Machine, policy and deliberate breakages below and tick breakage 3.",
    guest: "isv0-probe",
    source: "guests/isv0-probe, disassembled; starting registers from the chapter 07 capture's dump",
    board: { testdev: true, uart: false },
    mmu: "identity",
    sp: 0x40098f70n,
    regs: Object.fromEntries(ISV0_DUMP.map((v, i) => [i, v])),
    funcs: { check: { addr: 0x40081098n, kind: "isv0-check" } },
    console: ["isv0-probe: mmu on"],
    lines: [
      [0x400811f8, 0xd2888896, "mov x22, #0x4444"],
      [0x400811fc, 0xd2911117, "mov x23, #0x8888"],
      [0x40081204, 0xf2a66676, "movk x22, #0x3333, lsl #16"],
      [0x40081208, 0xf2aeeef7, "movk x23, #0x7777, lsl #16"],
      [0x4008120c, 0x52a16008, "mov w8, #0xb000000"],
      [0x40081210, 0xf2c44456, "movk x22, #0x2222, lsl #32"],
      [0x40081214, 0xf2ccccd7, "movk x23, #0x6666, lsl #32"],
      [0x40081218, 0x52a16018, "mov w24, #0xb000000"],
      [0x4008121c, 0xf2e22236, "movk x22, #0x1111, lsl #48"],
      [0x40081220, 0xf2eaaab7, "movk x23, #0x5555, lsl #48"],
      [0x4008122c, 0xaa1603e9, "mov x9, x22"],
      [0x40081230, 0xaa1703ea, "mov x10, x23"],
      [0x40081234, 0xa9002909, "stp x9, x10, [x8]"],
      [0x40081240, 0x52800108, "mov w8, #0x8"],
      [0x40081244, 0xf9400309, "ldr x9, [x24]"],
      [0x40081258, 0x72a16008, "movk w8, #0xb00, lsl #16"],
      [0x4008125c, 0xf940010a, "ldr x10, [x8]"],
      [0x4008126c, 0x97ffff8b, "bl check", { name: "stp x", got: [9, 10], want: [22, 23] }],
    ],
  },
  hole: {
    title: "A store to a hole (mmio-poke, chapter 05)",
    summary: "mmio-poke stores 0x4d to 0x0c00_0000, where nothing lives. No device claims it, so chapter 05's unhandled-MMIO policy decides: stop the VM (fatal, the default) or ignore the store and carry on (log).",
    guest: "mmio-poke",
    source: "guests/mmio-poke, disassembled; addresses as in the chapter 05 capture",
    board: { testdev: false, uart: false },
    mmu: "off",
    sp: 0x40098fe0n,
    regs: {},
    funcs: { print_fmt: { addr: 0x40081110n, kind: "print", text: "mmio-poke: survived" } },
    console: ["mmio-poke: storing 0x4d to 0xc000000"],
    lines: [
      [0x40081074, 0x52a18008, "mov w8, #0xc000000"],
      [0x40081078, 0x528009a9, "mov w9, #0x4d"],
      [0x40081088, 0xb9000109, "str w9, [x8]"],
      [0x4008108c, 0x94000021, "bl print_fmt"],
    ],
  },
  straddle: {
    title: "An access that runs past a device's end",
    summary: "A guest that has turned its MMU on and mapped the test device as ordinary memory may make an unaligned access. A 4-byte load at 0x0b00_0ffc fits in the device's 4 KiB window; an 8-byte load there runs 4 bytes past its end. The bus refuses it rather than hand the device an offset outside its window.",
    guest: null,
    source: "a short made-up program (its addresses are illustrative)",
    board: { testdev: true, uart: false },
    mmu: "normal",
    sp: 0x40098fe0n,
    regs: {},
    funcs: {},
    lines: [
      [0x40080000, null, "mov w0, #0xffc"],
      [0x40080004, null, "movk w0, #0xb00, lsl #16"],
      [0x40080008, null, "ldr w3, [x0]"],
      [0x4008000c, null, "ldr x3, [x0]"],
    ],
  },
  uart: {
    title: "A character on a UART (a preview of chapter 09)",
    summary: "The same path with a different device: a store to the UART's data register prints a character, and a load from its flag register (offset 0x18) reads 0x90, meaning nothing to send and nothing received. Chapter 07's bus has only the test device; chapter 09 adds this UART, the PL011.",
    guest: null,
    source: "a short made-up program (its addresses are illustrative)",
    board: { testdev: false, uart: true },
    mmu: "off",
    sp: 0x40098fe0n,
    regs: {},
    funcs: {},
    lines: [
      [0x40080000, null, "mov w0, #0x9000000"],
      [0x40080004, null, "mov w1, #0x48"],
      [0x40080008, null, "str w1, [x0]"],
      [0x4008000c, null, "mov w1, #0x69"],
      [0x40080010, null, "str w1, [x0]"],
      [0x40080014, null, "ldr w2, [x0, #0x18]"],
    ],
  },
};
export const PROGRAM_IDS = ["sign", "xzr", "probe", "isv0", "hole", "straddle", "uart"];
export const DEFAULT_PROGRAM = "sign";

// ---- configuration and share state -----------------------------------------------------------

/** Option flags, one letter each in the share string. */
export const FLAGS = {
  t: "testdev", // --testdev: the test device is on the bus
  u: "uart", // the UART (chapter 09) is on the bus
  l: "log", // --unhandled-mmio log instead of fatal
  n: "noAdvance", // breakage 1: forget the PC advance
  z: "xzrAsReg", // breakage 2: register 31 passed through (it is HV_REG_PC)
  g: "guess", // breakage 3: emulate ISV = 0 by guessing
};
const FLAG_ORDER = "tulnzg";

export function defaultOptions(programId) {
  const p = PROGRAMS[programId];
  return { testdev: p.board.testdev, uart: p.board.uart, log: false, noAdvance: false, xzrAsReg: false, guess: false };
}

/** {program, step, options, edits} -> "sign.4.t" (edits as "~<index>=<url-encoded text>"). */
export function encodeShare(s) {
  let flags = "";
  for (const ch of FLAG_ORDER) if (s.options[FLAGS[ch]]) flags += ch;
  let out = `${s.program}.${s.step}.${flags || "-"}`;
  const idx = Object.keys(s.edits || {}).map(Number).sort((a, b) => a - b);
  for (const i of idx) out += `~${i}=${encodeURIComponent(s.edits[i]).replace(/~/g, "%7E").replace(/\./g, "%2E")}`;
  return out;
}

/** The inverse of encodeShare; returns null for anything malformed. Never throws. */
export function decodeShare(str) {
  try {
    if (typeof str !== "string" || str.length === 0 || str.length > 3000) return null;
    const parts = str.split("~");
    const m = /^([a-z0-9]{1,16})\.(\d{1,5})\.([a-z]{1,6}|-)$/.exec(parts[0]);
    if (!m || !PROGRAM_IDS.includes(m[1])) return null;
    const program = m[1];
    const step = Number(m[2]);
    const options = { testdev: false, uart: false, log: false, noAdvance: false, xzrAsReg: false, guess: false };
    if (m[3] !== "-") {
      for (const ch of m[3]) {
        if (!Object.prototype.hasOwnProperty.call(FLAGS, ch) || options[FLAGS[ch]]) return null;
        options[FLAGS[ch]] = true;
      }
    }
    const edits = {};
    const nLines = PROGRAMS[program].lines.length;
    if (parts.length - 1 > MAX_EDITS) return null;
    for (const e of parts.slice(1)) {
      const em = /^(\d{1,3})=(.{1,400})$/.exec(e);
      if (!em) return null;
      const i = Number(em[1]);
      if (i >= nLines || Object.prototype.hasOwnProperty.call(edits, i)) return null;
      const text = decodeURIComponent(em[2]);
      if (text.length > MAX_LINE) return null;
      edits[i] = text;
    }
    return { program, step, options, edits };
  } catch {
    return null;
  }
}

/**
 * Build the program the timeline runs: the preset's lines with the reader's edits applied.
 * Returns {lines: [{pc, text, word, insn, error, call, edited}], errors: [{index, error}]}.
 */
export function buildProgram(programId, edits = {}) {
  const p = PROGRAMS[programId];
  const lines = [];
  const errors = [];
  p.lines.forEach(([pc, word, text, call], i) => {
    const edited = Object.prototype.hasOwnProperty.call(edits, i) && edits[i] !== text;
    const src = edited ? edits[i] : text;
    const parsed = parseLine(src, p.funcs);
    const pcb = BigInt(pc);
    let w = null;
    if (parsed.ok) w = edited || word === null ? encode(parsed.insn, pcb, p.funcs) : word;
    lines.push({
      pc: pcb, text: src, word: w, insn: parsed.ok ? parsed.insn : null,
      error: parsed.ok ? null : parsed.error, call: call ?? null, edited,
    });
    if (!parsed.ok) errors.push({ index: i, error: parsed.error });
  });
  return { lines, errors };
}

// ---- the machine: frames ---------------------------------------------------------------------

function inRam(a, size) {
  return a >= RAM_BASE && a + BigInt(size) <= RAM_BASE + RAM_SIZE;
}
function touchesRam(a, size) {
  return a + BigInt(size) > RAM_BASE && a < RAM_BASE + RAM_SIZE;
}

/** The devices on the bus for these options: [{name, base, size}]. */
export function busEntries(options) {
  const out = [];
  if (options.uart) out.push({ name: "pl011", base: UART_BASE, size: UART_SIZE });
  if (options.testdev) out.push({ name: "testdev", base: TESTDEV_BASE, size: TESTDEV_SIZE });
  return out;
}

/** classify_ipa: RAM, then the bus, then the board map (for a name). */
export function classifyIpa(ipa, options) {
  if (inRam(ipa, 1)) return { kind: "ram" };
  for (const e of busEntries(options)) {
    if (ipa >= e.base && ipa < e.base + e.size) return { kind: "device", name: e.name, offset: ipa - e.base, entry: e };
  }
  const r = BOARD_REGIONS.find((x) => ipa >= x.base && ipa < x.base + x.size);
  return { kind: "unmapped", region: r ? r.name : null };
}

/** The memory-map pane's rows for these options. */
export function memoryMap(options) {
  const rows = [
    { name: "pl011", label: "UART (PL011)", base: UART_BASE, size: UART_SIZE, state: options.uart ? "device" : "hole" },
    { name: "testdev", label: "test device", base: TESTDEV_BASE, size: TESTDEV_SIZE, state: options.testdev ? "device" : "hole" },
    { name: "probe-hole", label: "probe hole", base: PROBE_HOLE_BASE, size: 0x0200_0000n, state: "hole" },
    { name: "ram", label: "RAM (64 MiB)", base: RAM_BASE, size: RAM_SIZE, state: "ram" },
  ];
  return rows;
}

function cloneState(s) {
  return {
    regs: s.regs.slice(), sp: s.sp, pc: s.pc,
    testdev: new Map(s.testdev), ram: new Map(s.ram), uart: s.uart,
    console: s.console.slice(), stderr: s.stderr.slice(), trace: s.trace.slice(),
    exits: s.exits, oks: s.oks, checks: s.checks, warns: { ...s.warns },
  };
}

function readReg(st, reg) {
  if (reg.zr) return 0n;
  if (reg.sp) return st.sp;
  const v = st.regs[reg.n];
  return reg.x ? v : v & M32;
}
function writeReg(st, reg, v, changed) {
  if (reg.zr) return;
  st.regs[reg.n] = reg.x ? v & M64 : v & M32; // a w write clears the upper 32 bits
  changed.add(reg.n);
}

function ramRead(st, a, size) {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(st.ram.get(a + BigInt(i)) ?? 0);
  return v;
}
function ramWrite(st, a, size, v) {
  for (let i = 0; i < size; i++) st.ram.set(a + BigInt(i), Number((v >> BigInt(8 * i)) & 0xffn));
}

// The test device (crates/vmm/src/devices/testdev.rs): 512 slots of 8 bytes.
function testdevLocate(offset, size) {
  if (offset % BigInt(size) !== 0n) return null;
  const index = offset / 8n;
  if (index >= BigInt(TESTDEV_REGS)) return null;
  return { index: Number(index), shift: (offset % 8n) * 8n };
}
function testdevRead(st, offset, size, warn) {
  const loc = testdevLocate(offset, size);
  if (!loc) {
    warn("testdev-read", `testdev: ${size}-byte read at offset ${hex(offset)} is misaligned or outside the window (read as zero)`);
    return { value: 0n, text: `The test device refuses a misaligned read and returns 0.` };
  }
  const reg = st.testdev.get(loc.index) ?? 0n;
  const value = (reg >> loc.shift) & sizeMask(size);
  return { value, text: `The test device returns slot ${loc.index}${loc.shift ? ` (bytes from ${loc.shift / 8n})` : ""}: ${hex(value)}.` };
}
function testdevWrite(st, offset, size, value, warn) {
  const loc = testdevLocate(offset, size);
  if (!loc) {
    warn("testdev-write", `testdev: ${size}-byte write at offset ${hex(offset)} is misaligned or outside the window (ignored)`);
    return `The test device ignores a misaligned write.`;
  }
  const lanes = sizeMask(size) << loc.shift;
  const old = st.testdev.get(loc.index) ?? 0n;
  const nv = ((old & ~lanes) | ((value & sizeMask(size)) << loc.shift)) & M64;
  st.testdev.set(loc.index, nv);
  return `The test device stores ${hex(value)} into slot ${loc.index}${loc.shift ? ` at byte ${loc.shift / 8n}` : ""}; the slot now holds ${hex(nv)}.`;
}

// A minimal UART: the data register (offset 0) and the flag register (0x18). Chapter 09's PL011
// has the rest.
export function uartChar(b) {
  const c = Number(b & 0xffn);
  if (c >= 0x20 && c < 0x7f) return String.fromCharCode(c);
  if (c === 0x0a) return "\n";
  return `\\x${c.toString(16).padStart(2, "0")}`; // shown, never interpreted
}
function uartRead(st, offset) {
  if (offset === 0x18n) return { value: UART_FR_RESET, text: "The UART's flag register reads 0x90: bit 7 (transmit FIFO empty) and bit 4 (receive FIFO empty)." };
  if (offset === 0n) return { value: 0n, text: "The UART's data register has nothing received, so it reads 0." };
  return { value: 0n, text: `Offset ${hex(offset)} is a register this lab's UART does not model; it reads 0 (chapter 09 builds them all).` };
}
function uartWrite(st, offset, value) {
  if (offset === 0n) {
    const ch = uartChar(value);
    st.uart += ch;
    return `The UART's data register sends the low byte, ${hex(value & 0xffn)}: "${ch}" appears on the virtual terminal.`;
  }
  return `Offset ${hex(offset)} is a register this lab's UART does not model; the write is ignored (chapter 09 builds them all).`;
}

/** One trace record, keys in the reference's order (t_ns left out). */
export function traceRecord(r) {
  const parts = [`"vcpu":0`, `"reason":"exception"`, `"ec":"0x24"`, `"pc":"${hex(r.pc)}"`, `"ipa":"${hex(r.ipa)}"`];
  if (r.wnr !== undefined) parts.push(`"wnr":${r.wnr}`);
  if (r.size !== undefined) parts.push(`"size":${r.size}`);
  if (r.reg !== undefined) parts.push(`"reg":${r.reg}`);
  if (r.value !== undefined) parts.push(`"value":"${hex(r.value)}"`);
  parts.push(`"action":"${r.action}"`);
  parts.push(`"isv":${r.isv}`);
  return `{${parts.join(",")}}`;
}

/** How the guest's instruction accesses memory: [{addr, size}] and the writeback, if any. */
function accessOf(insn, st) {
  const base = readReg(st, insn.base);
  const addr = insn.mode === "post" ? base : (base + insn.imm) & M64;
  const wb = insn.mode === "off" ? null : (base + insn.imm) & M64;
  const total = insn.op === "pair" ? insn.size * 2 : insn.size;
  return { addr, total, wb };
}

/** The syndrome the hardware writes for a trapped access by this instruction. */
export function esrFor(insn, dfsc = DFSC_HOLE) {
  if (insn.op === "ls" && insn.mode === "off") {
    return encodeDataAbortEsr({
      isv: true, sas: SAS_OF[insn.size], sse: insn.signed, srt: insn.rt.n, sf: insn.rt.x,
      wnr: !insn.load, dfsc,
    });
  }
  // A pair, or a writeback form: the note has no room, so ISV = 0 and bits 23:14 are RES0
  // (zero on the Mac we captured).
  return encodeDataAbortEsr({ isv: false, wnr: !insn.load, dfsc });
}

/** ESR_EL1 for a data abort the guest takes itself (EC 0x25). ISV is shown as 0: whether a
 *  fault taken to EL1 fills in the instruction syndrome is up to the CPU. */
export function guestEsr(wnr, dfsc) {
  return ((EC_DABT_CUR << 26) | (1 << 25) | (wnr ? 1 << 6 : 0) | (dfsc & 0x3f)) >>> 0;
}

// The isv0 guest's own stage-1 tables (guests/common/mmu.rs): 4 KiB granule, T0SZ = 25 (39-bit
// VAs, walk from level 1). Everything else is invalid. `device`: mapped Device-nGnRnE.
const ID_MAP = [
  { va: 0x4000_0000n, size: 1n << 30n, ipa: 0x4000_0000n, device: false }, // RAM, level-1 block
  { va: 0x8000_0000n, size: 1n << 30n, ipa: 0x4000_0000n, device: false }, // CODE_ALIAS -> RAM
  { va: 0x0900_0000n, size: 0x20_0000n, ipa: 0x0900_0000n, device: true }, // PL011, PL031
  { va: 0x0b00_0000n, size: 0x1000n, ipa: 0x0b00_0000n, device: true }, // testdev
  { va: 0x0b10_0000n, size: 0x1000n, ipa: 0x0b00_0000n, device: true }, // TESTDEV_ALIAS
  { va: 0x0b10_1000n, size: 0x1000n, ipa: 0x0900_0000n, device: true }, // UART_ALIAS
];

/** The level at which the isv0 guest's walk finds an invalid entry for `va` (< 2^39). */
function idMapFaultLevel(va) {
  const i1 = (va >> 30n) & 511n;
  if (i1 !== 0n) return 1; // only entries 0 (a table), 1 and 2 (blocks) are valid
  const i2 = (va >> 21n) & 511n;
  if (i2 !== 0x58n) return 2; // 0x48 (the UART block) is mapped, 0x58 is a table
  return 3;
}

/**
 * Where a guest virtual address goes before stage 2. Returns {ipa, device} or a guest-side
 * fault {fault: "size" | "translation", dfsc (null if the lab does not know it), why}, or
 * {unmodelled: why}.
 */
export function stage1(mmu, va, total) {
  const end = va + BigInt(total);
  if (mmu === "identity") {
    const e = ID_MAP.find((x) => va >= x.va && va < x.va + x.size);
    if (!e) {
      if (va >= 1n << 39n) {
        return { fault: "translation", dfsc: null, why: "is past the 39-bit virtual address range its page tables cover" };
      }
      return { fault: "translation", dfsc: 0x4 + idMapFaultLevel(va), why: "is not in its page tables" };
    }
    if (end > e.va + e.size) return { unmodelled: "This access runs off the end of a page the guest maps into the next one. The lab does not model that case." };
    return { ipa: e.ipa + (va - e.va), device: e.device };
  }
  if (va >= 1n << GUEST_PA_BITS) {
    return { fault: "size", dfsc: 0x0, why: `is wider than the ${GUEST_PA_BITS}-bit physical addresses the guest's CPU reports` };
  }
  // MMU off: every data access is treated as Device-nGnRnE, so alignment is checked everywhere.
  return { ipa: va, device: mmu === "off" };
}

const PHASES = ["exit", "decode", "dispatch", "effect", "resume"];
export const PHASE_LABELS = {
  exit: "Exit",
  decode: "Decode the syndrome",
  dispatch: "Find the device",
  effect: "Do the access",
  resume: "Advance the PC",
};
export { PHASES };

function insnWordText(line) {
  return line.word === null ? "not readable" : `0x${line.word.toString(16).padStart(8, "0")}`;
}

/**
 * Run the program and return every frame. frames[0] is "nothing has run yet". Each later frame
 * is one Step. Deterministic; capped at MAX_FRAMES.
 */
export function timeline(programId, options, edits = {}) {
  const p = PROGRAMS[programId];
  if (!p) throw new Error("unknown program");
  const prog = buildProgram(programId, edits);
  const regs = new Array(31).fill(0n);
  for (const [k, v] of Object.entries(p.regs)) regs[Number(k)] = BigInt(v) & M64;
  let st = {
    regs, sp: p.sp, pc: prog.lines[0].pc, testdev: new Map(), ram: new Map(), uart: "",
    console: (p.console || []).slice(), stderr: [], trace: [], exits: 0, oks: 0, checks: 0, warns: {},
  };
  const frames = [];
  let skipped = 0;
  const push = (f) => {
    const g = { ...f };
    if (skipped > 0 && g.detail) {
      g.detail = `(First, ${skipped === 1 ? "one instruction" : `${skipped} instructions`} the listing leaves out run; they touch no memory.) ${g.detail}`;
      skipped = 0;
    }
    frames.push({ ...cloneState(st), ...g, changed: g.changed ? [...g.changed] : [] });
  };
  const lineAt = (pc) => prog.lines.findIndex((l) => l.pc === pc);
  const endPc = prog.lines[prog.lines.length - 1].pc + 4n;

  push({ phase: "ready", line: 0, title: "Ready", detail: "Nothing has run yet. Loads and stores to RAM run on the CPU with no exit. One to an address stage 2 leaves unmapped stops the guest: the VMM reads the hardware's note, plays the device, and moves the PC on. Press Step and watch the Exit and VMM pane.", halted: null });
  if (prog.errors.length) {
    const e = prog.errors[0];
    frames[0].halted = { code: null, text: `Line ${e.index + 1} does not parse: ${e.error}. Fix it or revert it to run.` };
    return { frames, program: prog };
  }

  let lastExitPc = null;
  let repeats = 0;
  const halt = (fields, code, text) => push({ ...fields, halted: { code, text } });

  const firstPc = prog.lines[0].pc;
  while (frames.length < MAX_FRAMES) {
    let li = lineAt(st.pc);
    if (li < 0 && st.pc % 4n === 0n && st.pc > firstPc && st.pc < endPc) {
      // Instructions the listing leaves out (nop, adr, string lengths): they touch neither
      // memory nor the registers this lab shows, so run past them to the next listed line.
      li = prog.lines.findIndex((l) => l.pc > st.pc);
      skipped = Number((prog.lines[li].pc - st.pc) / 4n);
      st.pc = prog.lines[li].pc;
    }
    if (li < 0) {
      if (st.pc === endPc) {
        if (p.total) {
          st.console.push(`${p.total.prefix}: ${st.oks}/${p.total.of} ok`);
          halt({ phase: "end", line: -1, title: "End", detail: `The probe prints its total and powers off. macvmm exits with code 0.` }, 0, `The guest finished: ${st.oks}/${p.total.of} checks passed. Exit code 0.`);
        } else {
          halt({ phase: "end", line: -1, title: "End", detail: "This excerpt of the program ends here." }, null, "End of this excerpt.");
        }
      } else if (st.pc % 4n !== 0n) {
        const pcHex = hex(st.pc);
        if (p.guest) {
          st.console.push(`guest exception: kind=4 (sync, EL1h) esr=0x8a000000 ec=0x22 elr=${pcHex} far=${pcHex}`);
          st.stderr.push("macvmm: guest exit code 228");
        }
        halt({ phase: "guest-fault", line: -1, title: "The guest faults",
          detail: `The guest's PC is ${pcHex}, which is not a multiple of 4. Fetching from it raises a PC alignment fault (EC 0x22), taken by the guest's own exception handler at EL1: no exit reaches our VMM. ${p.guest ? `${p.guest}'s handler prints it and exits with failure, which macvmm reports as exit code 6.` : ""}` },
        6, `The guest jumped to ${pcHex} and took a PC alignment fault. Exit code 6.`);
      } else {
        halt({ phase: "guest-fault", line: -1, title: "Off the listing",
          detail: `The guest's PC is now ${hex(st.pc)}, outside this program. The lab cannot follow it there.` },
        null, `The guest jumped to ${hex(st.pc)}, outside this program.`);
      }
      break;
    }
    const line = prog.lines[li];
    const insn = line.insn;
    const changed = new Set();

    // ---- instructions that never leave the CPU ----
    if (insn.op === "nop") {
      st.pc += 4n;
      push({ phase: "cpu", line: li, title: "On the CPU", detail: "nop does nothing; the CPU moves on. No exit.", halted: null });
      continue;
    }
    if (insn.op === "movi" || insn.op === "movr" || insn.op === "movk") {
      let v;
      if (insn.op === "movi") v = insn.imm;
      else if (insn.op === "movr") v = readReg(st, insn.rm);
      else {
        const sh = BigInt(insn.shift);
        v = (readReg(st, { ...insn.rd, x: true }) & ~(0xffffn << sh)) | (insn.imm << sh);
      }
      writeReg(st, insn.rd, v, changed);
      st.pc += 4n;
      const name = `${insn.rd.x ? "x" : "w"}${insn.rd.n}`;
      push({ phase: "cpu", line: li, changed, title: "On the CPU",
        detail: `${line.text} runs at full speed on the CPU: ${name} = ${hex(readReg(st, insn.rd))}. Only registers change, so there is no exit.`, halted: null });
      continue;
    }
    if (insn.op === "bl") {
      const f = p.funcs[insn.target];
      let detail;
      if (f.kind === "probe-check") {
        const got = st.regs[3], want = st.regs[4];
        const name = line.call?.name ?? "check";
        st.checks++;
        if (got === want) { st.oks++; st.console.push(`mmio-probe: ${name} ok`); }
        else st.console.push(`mmio-probe: FAILED: ${name}: got ${hex(got)}, want ${hex(want)}`);
        detail = `The probe's check function compares x3 (got) with x4 (want) and prints a line. It is ordinary code; its printing uses chapter 03's debug call, which this lab does not show.`;
      } else if (f.kind === "isv0-check") {
        const got = line.call.got.map((n) => st.regs[n]);
        const want = line.call.want.map((n) => st.regs[n]);
        const fmt = (a) => `[${a.map((v) => v.toString(16)).join(", ")}]`;
        st.checks++;
        if (got.every((v, i) => v === want[i])) { st.oks++; st.console.push(`isv0-probe: ${line.call.name} ok`); }
        else st.console.push(`isv0-probe: FAILED: ${line.call.name}: got ${fmt(got)}, want ${fmt(want)}`);
        detail = `The probe's check function compares what it read back (x9, x10) with what it stored (x22, x23) and prints a line.`;
      } else {
        st.console.push(f.text);
        detail = `The guest prints a line. That is ordinary code plus chapter 03's debug call, which this lab does not show.`;
      }
      st.pc += 4n;
      push({ phase: "cpu", line: li, title: "Ordinary code", detail, halted: null });
      continue;
    }

    // ---- loads and stores ----
    const acc = accessOf(insn, st);
    const elem = insn.size;
    const dir = insn.load ? "load" : "store";
    // A data abort the guest takes itself, at EL1: no exit reaches the VMM. A real guest's
    // vector table prints it and exits with failure (guests/common/exceptions.rs: 0xE0 + kind).
    const guestFault = (title, why, dfsc, short) => {
      const known = dfsc !== null;
      if (p.guest) {
        if (known) st.console.push(`guest exception: kind=4 (sync, EL1h) esr=${hex(guestEsr(!insn.load, dfsc))} ec=0x25 elr=${hex(st.pc)} far=${hex(acc.addr)}`);
        st.stderr.push("macvmm: guest exit code 228");
      }
      const tail = p.guest
        ? ` ${p.guest}'s handler prints it${known ? " (the ESR shown assumes ISV = 0; whether a fault taken at EL1 fills in the instruction syndrome is up to the CPU)" : " (with a fault level this lab does not reconstruct)"} and exits with failure, which macvmm reports as exit code 6.`
        : " What happens next is up to a real guest's exception handler; this made-up program has none.";
      halt({ phase: "guest-fault", line: li, title, detail: `${why} The guest takes a data abort at its own level (EC 0x25${known ? `, DFSC 0x${dfsc.toString(16)}, ${fscName(dfsc)}` : ""}), at EL1, before stage 2 is consulted: no exit reaches our VMM.${tail}` },
      p.guest ? 6 : null, `${short} The guest takes its own fault at EL1. No exit.${p.guest ? " Exit code 6." : ""}`);
    };
    if (p.mmu === "off" && acc.addr % BigInt(elem) !== 0n) {
      guestFault("The guest faults",
        `${hex(acc.addr)} is not a multiple of ${elem}. With the MMU off, every data access is treated as device memory, and an unaligned one raises an alignment fault.`,
        0x21, `Unaligned ${elem}-byte ${dir} at ${hex(acc.addr)}.`);
      break;
    }
    const s1 = stage1(p.mmu, acc.addr, acc.total);
    if (s1.unmodelled) {
      halt({ phase: "guest-fault", line: li, title: "Not modelled", detail: s1.unmodelled }, null, "This access is not modelled here.");
      break;
    }
    if (s1.fault === "size") {
      guestFault("The guest faults",
        `${hex(acc.addr)} ${s1.why} (ID_AA64MMFR0_EL1.PARange). With the MMU off the address is used as a physical address, so it is too wide to be one: an address size fault, as in chapter 03's stack that wrapped below zero.`,
        s1.dfsc, `${hex(acc.addr)} is too wide to be a physical address.`);
      break;
    }
    if (s1.fault === "translation") {
      guestFault("The guest faults",
        `The guest's MMU is on, and ${hex(acc.addr)} ${s1.why} (guests/common/mmu.rs): a stage-1 translation fault.`,
        s1.dfsc, `${hex(acc.addr)} is not mapped by the guest's own page tables.`);
      break;
    }
    if (s1.device && p.mmu !== "off" && acc.addr % BigInt(elem) !== 0n) {
      guestFault("The guest faults",
        `${hex(acc.addr)} is not a multiple of ${elem}, and the guest maps this page as device memory, where an unaligned access raises an alignment fault.`,
        0x21, `Unaligned ${elem}-byte ${dir} at ${hex(acc.addr)}.`);
      break;
    }
    const ipa = s1.ipa;
    const viaAlias = ipa !== acc.addr;
    if (inRam(ipa, acc.total)) {
      const desc = doRamAccess(st, insn, acc, ipa, changed);
      st.pc += 4n;
      push({ phase: "cpu", line: li, changed, title: "RAM: no exit",
        detail: `${hex(acc.addr)}${viaAlias ? ` (IPA ${hex(ipa)} through the guest's page tables)` : ""} is RAM, which stage 2 maps, so the CPU does the access itself in a nanosecond or so. ${desc} No exit.`, halted: null });
      continue;
    }
    if (touchesRam(ipa, acc.total)) {
      halt({ phase: "guest-fault", line: li, title: "Not modelled", detail: "This access is partly in RAM and partly outside it. The lab does not model that case." },
        null, "An access that is half in RAM is not modelled here.");
      break;
    }

    // It traps. Phase 1: the exit. An IPA past the VM's IPA space is never looked up: stage 2
    // reports a level 0 translation fault (captures/05-beyond-ipa.txt). Inside it, our holes
    // showed level 2.
    const beyondIpa = ipa >= 1n << IPA_BITS;
    const esr = esrFor(insn, beyondIpa ? DFSC_BEYOND_IPA : DFSC_HOLE);
    const exitInfo = {
      reason: "exception", ec: EC_DABT_LOWER, esr, pc: st.pc, ipa, far: acc.addr,
      hpfar: (ipa >> 12n) << 4n, word: line.word,
    };
    if (lastExitPc === st.pc) repeats++; else { repeats = 1; lastExitPc = st.pc; }
    st.exits++;
    push({ phase: "exit", line: li, exit: exitInfo, title: PHASE_LABELS.exit,
      detail: `The guest runs ${line.text}. ${viaAlias ? `Its page tables send ${hex(acc.addr)} to IPA ${hex(ipa)}, which` : `${hex(ipa)}`} is not RAM, so stage 2 has no mapping for it: the CPU stops the guest and hv_vcpu_run returns an exit.${beyondIpa ? ` The IPA is past the VM's ${IPA_BITS}-bit IPA space, so stage 2 never looks it up: DFSC 0x4, a translation fault at level 0 (chapter 05).` : ""} The saved PC still points at the ${insn.load ? "load" : "store"}.`, halted: null });

    // Phase 2: decode, from the syndrome alone.
    const da = decodeDataAbort(esr);
    const display = `data abort (EC 0x24): ${displayDataAbort(da)}`;
    const rec = { pc: st.pc, ipa, isv: da.isv };
    let access;
    if (da.isv) {
      access = { size: 1 << da.sas, sse: da.sse, srt: da.srt, sf: da.sf, write: da.wnr };
    } else if (options.guess) {
      access = { size: 8, sse: false, srt: da.srt, sf: true, write: da.wnr, guessed: true };
    } else {
      access = null;
    }
    push({ phase: "decode", line: li, exit: exitInfo, decode: { ...da, display, access }, title: PHASE_LABELS.decode,
      detail: da.isv
        ? `ISV = 1, so the note is valid: a ${access.write ? "store" : "load"} of ${access.size} byte${access.size > 1 ? "s" : ""} ${access.write ? "from" : "into"} register ${access.srt}${access.srt === 31 ? " (31 means xzr)" : ""}, a ${access.sf ? "64-bit x" : "32-bit w"} register${!access.write ? (access.sse ? ", sign-extended" : ", zero-extended") : ""}. We never look at the instruction.`
        : options.guess
          ? `ISV = 0: bits 23 to 14 are RES0 and mean nothing. Breakage 3 guesses anyway: 8 bytes, a 64-bit register, register ${da.srt} because that is what the SRT bits happen to hold.`
          : `ISV = 0: the note is blank. SAS, SSE, SRT and SF are RES0 and must not be used. Chapter 07's rule: stop, and print the instruction word for a human.`,
      halted: null });

    if (!access) {
      rec.action = "stop";
      st.trace.push(traceRecord(rec));
      st.stderr.push(
        `macvmm: guest fatal: data abort with ISV=0 at IPA ${hex(ipa)} pc ${hex(st.pc)}: the syndrome does not describe this access; not emulated`,
        `vcpu0: ${display}`,
        `  esr=${hex(esr)} ipa=${hex(ipa)}`,
        `  insn at pc: ${insnWordText(line)}`,
      );
      halt({ phase: "stop", line: li, exit: exitInfo, decode: { ...da, display, access }, title: "Stop",
        detail: `The VM stops with exit code 3. The message names ISV = 0, the IPA and the PC, and the dump ends with the instruction word, ${insnWordText(line)}, which a human can decode (${line.text}). No guess.` },
      3, `ISV = 0 at ${hex(ipa)}: the VM stops with exit code 3 and prints the instruction word.`);
      break;
    }

    // Build the access (from_data_abort): a store reads its register now.
    rec.wnr = access.write;
    rec.size = access.size;
    rec.reg = access.srt;
    let storeValue = null;
    let regNote = "";
    if (access.write) {
      let raw;
      if (access.srt === 31) {
        if (options.xzrAsReg) { raw = st.pc; regNote = ` Breakage 2: register 31 went to hv_vcpu_get_reg unchanged, and in Hypervisor.framework's numbering 31 is HV_REG_PC, so we read the PC, ${hex(st.pc)}.`; }
        else { raw = 0n; regNote = " Register 31 is xzr, which reads as zero."; }
      } else raw = st.regs[access.srt];
      storeValue = raw & sizeMask(access.size);
    }

    // Phase 3: classify and route.
    const cls = classifyIpa(ipa, options);
    let routed;
    if (cls.kind === "device") {
      const end = cls.entry.base + cls.entry.size;
      routed = ipa + BigInt(access.size) <= end ? { ok: true } : { ok: false, why: "straddle" };
    } else routed = { ok: false, why: "unmapped" };
    const where = cls.kind === "device"
      ? `the bus says ${cls.name}, offset ${hex(cls.offset)}`
      : `no device on the bus claims it${cls.region ? ` (the board map calls this region ${cls.region}, but nothing is registered there)` : beyondIpa ? ` (it is past the VM's ${IPA_BITS}-bit IPA space)` : ""}`;
    push({ phase: "dispatch", line: li, exit: exitInfo, decode: { ...da, display, access }, dispatch: { ...cls, entry: undefined, routed }, title: PHASE_LABELS.dispatch,
      detail: `classify_ipa asks our own map, never the fault code: ${hex(ipa)} is not RAM, and ${where}.` +
        (routed.ok ? "" : routed.why === "straddle"
          ? ` But the ${access.size}-byte access ends at ${hex(ipa + BigInt(access.size))}, past the window's end at ${hex(cls.entry.base + cls.entry.size)}: the bus refuses it (Straddle), and the unhandled-MMIO policy decides.`
          : " The unhandled-MMIO policy decides.") + regNote,
      halted: null });

    // Phase 4: the effect.
    let effectText;
    let value;
    if (routed.ok) {
      const warn = (site, m) => guestWarn(st, site, m);
      if (access.write) {
        effectText = cls.name === "testdev"
          ? testdevWrite(st, cls.offset, access.size, storeValue, warn)
          : uartWrite(st, cls.offset, storeValue);
        effectText = `We write ${hex(storeValue)} (masked to ${access.size} byte${access.size > 1 ? "s" : ""}). ` + effectText;
        value = storeValue;
      } else {
        const r = cls.name === "testdev" ? testdevRead(st, cls.offset, access.size, warn) : uartRead(st, cls.offset);
        value = signExtend(r.value, access.size, access.sse, access.sf);
        const ext = access.sse ? `Sign-extended from ${access.size * 8} bits` : "Zero-extended";
        effectText = `${r.text} ${ext} into a ${access.sf ? "64" : "32"}-bit register: ${hex(value)}.`;
        effectText += writeLoad(st, access.srt, value, options, changed);
      }
      rec.value = value;
      rec.action = "mmio";
    } else {
      const rw = access.write ? "write" : "read";
      const what = `unhandled MMIO ${rw} at ${hex(ipa)} size ${access.size} pc ${hex(st.pc)}`;
      if (!options.log) {
        rec.action = "stop";
        st.trace.push(traceRecord(rec));
        st.stderr.push(`macvmm: guest fatal: ${what}`, `vcpu0: ${display}`, `  esr=${hex(esr)} ipa=${hex(ipa)}`, `  insn at pc: ${insnWordText(line)}`);
        halt({ phase: "stop", line: li, exit: exitInfo, decode: { ...da, display, access }, dispatch: { ...cls, entry: undefined, routed }, title: "Stop",
          detail: `The policy is fatal (the default): the VM stops with exit code 3 and the message "${what}". Try the log policy to ignore the access instead.` },
        3, `Unhandled MMIO: the VM stops with exit code 3.`);
        break;
      }
      guestWarn(st, "unhandled", `${what} (ignored: --unhandled-mmio log)`);
      if (access.write) { effectText = "The log policy ignores the store and warns (rate-limited, because the guest decides how often this happens)."; value = storeValue; }
      else { effectText = "The log policy makes the load read as zero and warns."; value = 0n; effectText += writeLoad(st, access.srt, 0n, options, changed); }
      rec.value = access.write ? storeValue : 0n;
      rec.action = "mmio";
    }
    push({ phase: "effect", line: li, changed, exit: exitInfo, decode: { ...da, display, access }, dispatch: { ...cls, entry: undefined, routed }, title: PHASE_LABELS.effect, detail: effectText, halted: null });

    // Phase 5: resume. The trace record is written after the handler returns.
    st.trace.push(traceRecord(rec));
    const before = st.pc;
    if (!options.noAdvance) {
      st.pc = (st.pc + 4n) & M64;
      push({ phase: "resume", line: li, exit: exitInfo, title: PHASE_LABELS.resume,
        detail: before === exitInfo.pc
          ? `A data abort is a fault, so the saved PC points at the access itself. We add 4 (every arm64 instruction is 4 bytes) and resume at ${hex(st.pc)}.`
          : `We add 4 to the PC, which is now ${hex(before)} because breakage 2 wrote the loaded value into it: the guest resumes at ${hex(st.pc)}.`,
        halted: null });
    } else {
      push({ phase: "resume", line: li, exit: exitInfo, title: "Resume without advancing",
        detail: `Breakage 1: we resume without adding 4. The saved PC of a data abort is the access itself, so the guest runs ${line.text} again.`, halted: null });
      if (repeats >= NO_ADVANCE_REPEATS) {
        halt({ phase: "loop", line: li, title: "Forever",
          detail: `The same exit, with the same record, ${repeats} times so far. It never ends: in our run of mmio-probe on a Mac this exit repeated ${NO_ADVANCE_OBSERVED} times in two seconds, until --timeout stopped the VM (exit code 5).` },
        5, `The same exit forever. Our real run repeated it ${NO_ADVANCE_OBSERVED} times in two seconds.`);
        break;
      }
    }
  }
  if (frames.length >= MAX_FRAMES && !frames[frames.length - 1].halted) {
    frames[frames.length - 1].halted = { code: null, text: "The lab stopped after too many steps." };
  }
  return { frames, program: prog };
}

function writeLoad(st, srt, value, options, changed) {
  if (srt === 31) {
    if (options.xzrAsReg) {
      st.pc = value & M64;
      return ` Breakage 2: register 31 went to hv_vcpu_set_reg unchanged, and 31 is HV_REG_PC: the PC is now ${hex(value)}.`;
    }
    return " Register 31 is xzr: the value is thrown away.";
  }
  st.regs[srt] = value & M64;
  changed.add(srt);
  return ` We write it to x${srt}.`;
}

/** guest_warn!: rate-limited per call site, with emit_guest's "suppressed" wording. */
function guestWarn(st, site, m) {
  const n = (st.warns[site] ?? 0) + 1;
  st.warns[site] = n;
  const sup = warnAdmit(n);
  if (sup === null) return;
  st.stderr.push(`macvmm: warn: [vcpu0] guest: ${m}${sup ? ` (${sup} similar messages suppressed)` : ""}`);
}

function doRamAccess(st, insn, acc, ipa, changed) {
  const e = insn.size;
  if (insn.op === "ls") {
    if (insn.load) {
      const v = signExtend(ramRead(st, ipa, e), e, insn.signed, insn.rt.x);
      writeReg(st, insn.rt, v, changed);
    } else ramWrite(st, ipa, e, readReg(st, insn.rt) & sizeMask(e));
  } else {
    const a2 = ipa + BigInt(e);
    if (insn.load) {
      const v1 = signExtend(ramRead(st, ipa, e), e, insn.signed, insn.rt.x);
      const v2 = signExtend(ramRead(st, a2, e), e, insn.signed, insn.rt2.x);
      writeReg(st, insn.rt, v1, changed);
      writeReg(st, insn.rt2, v2, changed);
    } else {
      ramWrite(st, ipa, e, readReg(st, insn.rt) & sizeMask(e));
      ramWrite(st, a2, e, readReg(st, insn.rt2) & sizeMask(e));
    }
  }
  if (acc.wb !== null) {
    if (insn.base.sp) st.sp = acc.wb;
    else { st.regs[insn.base.n] = acc.wb; changed.add(insn.base.n); }
  }
  return insn.load ? "The loaded value goes straight into the register." : "The value goes straight into memory.";
}

/** The registers a program uses (for the register table), in order. */
export function registersUsed(prog) {
  const set = new Set();
  const add = (r) => { if (r && !r.zr && !r.sp) set.add(r.n); };
  for (const l of prog.lines) {
    const i = l.insn;
    if (!i) continue;
    add(i.rd); add(i.rm); add(i.rt); add(i.rt2); add(i.base);
    if (l.call?.got) for (const n of [...l.call.got, ...l.call.want]) set.add(n);
    if (i.op === "bl" && !l.call?.got) { set.add(3); set.add(4); }
  }
  return [...set].sort((a, b) => a - b);
}

/** RateLimit::decide for the n-th message (1-based): suppressed count if printed, else null. */
export function warnAdmit(n) {
  if (n <= 0) return null;
  if (n <= WARN_BURST) return 0;
  if (n % WARN_EVERY !== 0) return null;
  const prev = n === WARN_EVERY ? WARN_BURST : n - WARN_EVERY;
  return n - prev - 1;
}

/** One-line summary of a frame, for the live region. */
export function summarize(frame, step, total) {
  const head = `Step ${step} of ${total}.`;
  if (frame.halted) return `${head} ${frame.halted.text}`;
  return `${head} ${frame.title}. ${frame.detail}`;
}
