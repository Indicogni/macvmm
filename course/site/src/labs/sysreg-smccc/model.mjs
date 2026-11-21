// sysreg-smccc lab model: pure logic, no DOM, no I/O (course/site/LABS.md section 3).
//
// Two halves, both "a 32-bit number is a set of fields":
//
// 1. SMCCC function IDs (Arm DEN 0028, SMC Calling Convention, section 2 and table 6-1). The ID is
//    w0, the low 32 bits of x0: bit 31 fast call, bit 30 64-bit convention, bits 29:24 the owning
//    entity number (OEN), bits 23:16 must be zero in a fast call, bits 15:0 the function number.
//    The model also answers "what would macvmm do with this call?" by mirroring `smccc::dispatch`
//    in crates/vmm/src/smccc.rs row for row (model.test.mjs re-reads that file).
//
// 2. System-register moves. An `mrs`/`msr` instruction word (ARM ARM DDI 0487, C6.2 "MRS" and
//    "MSR (register)": 1101 0101 00 L 1 o0 op1 CRn CRm op2 Rt, with op0 = 2 + o0), or the EC 0x18
//    syndrome a trapped one leaves in ESR_EL2 (D17.2.40: Op0 21:20, Op2 19:17, Op1 16:14,
//    CRn 13:10, Rt 9:5, CRm 4:1, Direction 0). The five coordinates name the register; the policy
//    for it mirrors `sysreg::POLICY` and `sysreg::handle` in crates/vmm/src/arch/sysreg.rs.
//
// Everything here is total: any input string or number gets an answer or an explicit error value,
// never an exception. 32-bit words are JS numbers kept unsigned with `>>> 0`; x0 and x1 are BigInt
// because a guest may put any 64-bit value there.

import { SYSREG_NAMES, HV_ACCESSIBLE_COUNT } from "./sysregs.mjs";

// ---------------------------------------------------------------------------------------------
// Small helpers

const MASK32 = 0xffff_ffffn;
const MASK64 = 0xffff_ffff_ffff_ffffn;

/** "0x" + lowercase hex, zero-padded to `digits`. */
export function hex(v, digits = 8) {
  const s = (typeof v === "bigint" ? v : BigInt(v >>> 0)).toString(16);
  return "0x" + s.padStart(digits, "0");
}

/** Hex as Rust's `{:#x}` prints it: no padding, lowercase. */
export function rustHex(v) {
  return "0x" + (typeof v === "bigint" ? v : BigInt(v)).toString(16);
}

/** 0x8400_0008 style, the spelling the lessons use. */
export function groupedHex(v32) {
  const s = (v32 >>> 0).toString(16).toUpperCase().padStart(8, "0");
  return `0x${s.slice(0, 4)}_${s.slice(4)}`;
}

/**
 * Parse a hex number typed by a reader: optional 0x, underscores and spaces between digits,
 * at most `maxBits` bits. Returns {value: BigInt} or {error: string}. Never throws.
 */
export function parseHex(text, maxBits = 32) {
  if (typeof text !== "string") return { error: "Type a number in hex, such as 0x84000008." };
  if (text.length > 64) return { error: "That is too long for a register." };
  let s = text.trim().replace(/[_\s]/g, "");
  if (/^0x/i.test(s)) s = s.slice(2);
  if (s === "") return { error: "Type a number in hex, such as 0x84000008." };
  if (!/^[0-9a-fA-F]+$/.test(s)) return { error: "Only hex digits 0-9 and a-f, with an optional 0x." };
  const digits = s.replace(/^0+/, "");
  if (digits.length > maxBits / 4) return { error: `That needs more than ${maxBits} bits.` };
  return { value: BigInt("0x" + (digits || "0")) };
}

const bits = (w, lo, n) => (w >>> lo) & ((1 << n) - 1);

// ---------------------------------------------------------------------------------------------
// Part 1: SMCCC function IDs

/** DEN 0028 table 6-1: the owning entity numbers of fast calls. */
export function oenName(oen) {
  if (oen === 0) return "Arm architecture calls";
  if (oen === 1) return "CPU service calls";
  if (oen === 2) return "SiP (silicon provider) service calls";
  if (oen === 3) return "OEM (board maker) service calls";
  if (oen === 4) return "Standard secure service calls";
  if (oen === 5) return "Standard hypervisor service calls";
  if (oen === 6) return "Vendor-specific hypervisor service calls";
  if (oen === 7) return "Vendor-specific EL3 monitor calls";
  if (oen >= 8 && oen <= 47) return "Reserved for future use";
  if (oen === 48 || oen === 49) return "Trusted application calls";
  if (oen >= 50 && oen <= 63) return "Trusted OS calls";
  return "not an owner number";
}

/**
 * Yielding calls (bit 31 = 0) have no owner table: DEN 0028 splits their 31-bit space into
 * ranges instead (section 6, "Yielding calls"). Returns the range's name.
 */
export function yieldingRange(fid) {
  fid >>>= 0;
  if (fid >= 0x8000_0000) return null;
  if (fid <= 0x0100_ffff) return "reserved for existing APIs (0x0000_0000 to 0x0100_FFFF)";
  if (fid >= 0x0200_0000 && fid <= 0x1fff_ffff) return "Trusted OS yielding calls (0x0200_0000 to 0x1FFF_FFFF)";
  if (fid >= 0x2000_0000) return "reserved for future use (0x2000_0000 to 0x7FFF_FFFF)";
  return "reserved (0x0101_0000 to 0x01FF_FFFF, between the defined ranges)";
}

// The IDs macvmm's dispatcher knows (crates/vmm/src/smccc.rs: FUNCTIONS, then PROBES), with the
// names its trace prints. model.test.mjs checks this list against the Rust source.
export const SMCCC_VERSION = 0x8000_0000;
export const SMCCC_ARCH_FEATURES = 0x8000_0001;
export const PSCI_VERSION = 0x8400_0000;
export const PSCI_CPU_SUSPEND_32 = 0x8400_0001;
export const PSCI_CPU_SUSPEND_64 = 0xc400_0001;
export const PSCI_CPU_OFF = 0x8400_0002;
export const PSCI_CPU_ON_32 = 0x8400_0003;
export const PSCI_CPU_ON_64 = 0xc400_0003;
export const PSCI_AFFINITY_INFO_32 = 0x8400_0004;
export const PSCI_AFFINITY_INFO_64 = 0xc400_0004;
export const PSCI_MIGRATE_INFO_TYPE = 0x8400_0006;
export const PSCI_SYSTEM_OFF = 0x8400_0008;
export const PSCI_SYSTEM_RESET = 0x8400_0009;
export const PSCI_FEATURES = 0x8400_000a;
export const DEBUG_PUTC = 0xc600_4d01;
export const DEBUG_EXIT = 0xc600_4d02;
export const DEBUG_MEMHASH = 0xc600_4d03;
export const DEBUG_BOOT_COUNT = 0xc600_4d04;
export const TRNG_VERSION = 0x8400_0050;
export const VENDOR_HYP_CALL_UID = 0x8600_ff01;

/** [id, trace name, debug call?] in the order of smccc.rs FUNCTIONS. */
export const FUNCTIONS = Object.freeze([
  [SMCCC_VERSION, "SMCCC_VERSION", false],
  [SMCCC_ARCH_FEATURES, "SMCCC_ARCH_FEATURES", false],
  [PSCI_VERSION, "PSCI_VERSION", false],
  [PSCI_CPU_SUSPEND_32, "PSCI_CPU_SUSPEND", false],
  [PSCI_CPU_SUSPEND_64, "PSCI_CPU_SUSPEND", false],
  [PSCI_CPU_OFF, "PSCI_CPU_OFF", false],
  [PSCI_CPU_ON_32, "PSCI_CPU_ON", false],
  [PSCI_CPU_ON_64, "PSCI_CPU_ON", false],
  [PSCI_AFFINITY_INFO_32, "PSCI_AFFINITY_INFO", false],
  [PSCI_AFFINITY_INFO_64, "PSCI_AFFINITY_INFO", false],
  [PSCI_MIGRATE_INFO_TYPE, "PSCI_MIGRATE_INFO_TYPE", false],
  [PSCI_SYSTEM_OFF, "PSCI_SYSTEM_OFF", false],
  [PSCI_SYSTEM_RESET, "PSCI_SYSTEM_RESET", false],
  [PSCI_FEATURES, "PSCI_FEATURES", false],
  [DEBUG_PUTC, "DEBUG_PUTC", true],
  [DEBUG_EXIT, "DEBUG_EXIT", true],
  [DEBUG_MEMHASH, "DEBUG_MEMHASH", true],
  [DEBUG_BOOT_COUNT, "DEBUG_BOOT_COUNT", true],
]);

/** Calls a stock Linux boot makes that macvmm answers -1 on purpose, without a warning. */
export const PROBES = Object.freeze([
  [TRNG_VERSION, "TRNG_VERSION"],
  [VENDOR_HYP_CALL_UID, "VENDOR_HYP_CALL_UID"],
]);

/** Well-known IDs macvmm does not serve (it answers -1), named so a pasted trace value reads. */
export const OTHER_KNOWN = Object.freeze([
  [0x8000_8000, "SMCCC_ARCH_WORKAROUND_1", "a Spectre variant 2 mitigation a firmware may offer"],
  [0x8000_7fff, "SMCCC_ARCH_WORKAROUND_2", "a Spectre variant 4 mitigation a firmware may offer"],
  [0x8000_3fff, "SMCCC_ARCH_WORKAROUND_3", "a Spectre-BHB mitigation a firmware may offer"],
]);

/** Hypervisor.framework answers these itself, inside the macOS kernel (measured with hvc #0). */
export const HVF_BLOCK = Object.freeze({ lo: 0xc600_0000, hi: 0xc600_001f });

/** The name macvmm's trace prints for `fid` (`smccc::function_name`), or null. */
export function functionName(fid) {
  fid >>>= 0;
  for (const [id, name] of FUNCTIONS) if (id === fid) return name;
  for (const [id, name] of PROBES) if (id === fid) return name;
  return null;
}

/** True if `fid` is in the PSCI range (`smccc::is_psci`): 0x8400_0000..1F or 0xC400_0000..1F. */
export function isPsci(fid) {
  return ((fid >>> 0) & ~0x4000_001f) >>> 0 === 0x8400_0000;
}

/** The four fields of a function ID (plus the must-be-zero byte). */
export function fidFields(fid) {
  fid >>>= 0;
  return {
    fast: bits(fid, 31, 1) === 1,
    wide: bits(fid, 30, 1) === 1,
    oen: bits(fid, 24, 6),
    mbz: bits(fid, 16, 8),
    func: bits(fid, 0, 16),
  };
}

/** Build a function ID from its fields. Out-of-range fields are masked, never thrown. */
export function encodeFid({ fast, wide, oen, mbz = 0, func }) {
  return (
    ((fast ? 1 : 0) << 31) |
    ((wide ? 1 : 0) << 30) |
    ((oen & 0x3f) << 24) |
    ((mbz & 0xff) << 16) |
    (func & 0xffff)
  ) >>> 0;
}

/** Is `fid` a function macvmm serves for this kind of guest (the PSCI_FEATURES answer)? */
export function implemented(fid, debugCalls) {
  fid >>>= 0;
  return FUNCTIONS.some(([id, , debug]) => id === fid && (!debug || debugCalls));
}

/** Rule checks on a function ID: [{level: "error" | "note", text}]. */
export function fidFlags(fid) {
  const f = fidFields(fid);
  const out = [];
  if (!f.fast) {
    out.push({
      level: "note",
      text: "Bit 31 is 0: a yielding call. Every call in this course is a fast call, and macvmm answers a yielding call with -1.",
    });
  }
  if (f.fast && (f.mbz & 0xfe) !== 0) {
    out.push({
      level: "error",
      text: `Breaks the rules: bits 23 to 16 are ${hex(f.mbz, 2)}, but they must be zero in a fast call.`,
    });
  } else if (f.fast && f.mbz === 1) {
    out.push({
      level: "note",
      text: "Bit 16 is set. Newer SMCCC versions let a caller set it as a hint (no live SVE state); macvmm compares all 32 bits, so this ID gets -1.",
    });
  }
  if (f.fast && f.oen >= 8 && f.oen <= 47) {
    out.push({ level: "note", text: `Owner ${f.oen} is reserved: no service may use it yet.` });
  }
  if (functionName(fid) === null) {
    const flipped = (fid ^ 0x4000_0000) >>> 0;
    const other = functionName(flipped);
    if (other) {
      out.push({
        level: "note",
        text: `Only the ${f.wide ? "32" : "64"}-bit form ${groupedHex(flipped)} is ${other}; this ${f.wide ? "64" : "32"}-bit form is not defined.`,
      });
    }
  }
  return out;
}

/**
 * Decode x0 as an SMCCC function ID. `x0` is a BigInt (any 64-bit value). Returns the fields,
 * the name if known, and whether the upper half of x0 was ignored.
 */
export function decodeCall(x0) {
  const x = BigInt.asUintN(64, x0);
  const fid = Number(x & MASK32) >>> 0;
  const f = fidFields(fid);
  const known = functionName(fid);
  const other = OTHER_KNOWN.find(([id]) => id === fid);
  return {
    x0: x,
    fid,
    upperIgnored: x >> 32n !== 0n,
    ...f,
    // A yielding call's bits 29..24 are not an owner number; name its range instead.
    owner: f.fast ? oenName(f.oen) : yieldingRange(fid),
    name: known ?? (other ? other[1] : null),
    nameSource: known ? "macvmm" : other ? "elsewhere" : null,
    otherNote: other ? other[2] : null,
    psci: isPsci(fid),
    hvfBlock: fid >= HVF_BLOCK.lo && fid <= HVF_BLOCK.hi,
    flags: fidFlags(fid),
  };
}

/** A register value for the readout: -1, -2 and -3 are shown by name and number. */
export function regText(v) {
  const x = BigInt.asUintN(64, BigInt(v));
  if (x === MASK64) return "-1 (NOT_SUPPORTED, 0xffffffffffffffff)";
  if (x === MASK64 - 1n) return "-2 (INVALID_PARAMETERS)";
  if (x === MASK64 - 2n) return "-3 (DENIED)";
  return rustHex(x);
}

const PASSED_CONTROLS = { 0x08: "backspace", 0x09: "tab", 0x0a: "newline", 0x0d: "carriage return" };

/**
 * What happens to one DEBUG_PUTC byte on its way out through macvmm's default ("safe") output
 * filter, `AnsiFilter::ground` in crates/vmm/src/backend/ansi.rs: printable ASCII, backspace,
 * tab, newline and carriage return pass; BEL passes at most once a second; ESC starts an escape
 * sequence that passes only if allow-listed; 0xC2..0xF4 start a UTF-8 character; raw C1 bytes
 * (0x80..0x9F), other C0 bytes and DEL are dropped; any other byte becomes U+FFFD.
 */
export function putcByteText(b) {
  b &= 0xff;
  const h = hex(b, 2);
  if (b >= 0x20 && b < 0x7f) return `${h}, '${String.fromCharCode(b)}'`;
  if (PASSED_CONTROLS[b]) return `${h}, a ${PASSED_CONTROLS[b]} (passed through unchanged)`;
  if (b === 0x07) return `${h}, a bell (passed at most once a second)`;
  if (b === 0x1b) return `${h}, the escape byte (it starts an escape sequence, which reaches your terminal only if it is on the filter's short allow-list)`;
  if (b >= 0xc2 && b <= 0xf4) return `${h}, the first byte of a UTF-8 character (shown if the rest of the character follows, else replaced by U+FFFD)`;
  if (b >= 0x80 && b <= 0x9f) return `${h}, a raw C1 control byte or a UTF-8 continuation byte (dropped unless it continues a UTF-8 character)`;
  if (b >= 0x80) return `${h}, part of a UTF-8 character, or shown as U+FFFD (the replacement character) if it does not continue one`;
  return `${h}, a control byte (dropped by the output filter before it reaches your terminal)`;
}

/**
 * What macvmm does with this call: a mirror of `smccc::dispatch`.
 * call = {x0: BigInt, x1: BigInt, conduit: "hvc"|"smc", imm: number, guest: "test"|"os"}.
 * Returns {by: "hvf"|"macvmm", x0: BigInt|null, result: string, warn: string|null,
 *          stop: string|null, exitCode: string|null, pc: string, untested: string|null}.
 * `untested` is set when the ID is in HVF's private block but arrives by a path nobody measured.
 */
export function macvmmAnswer(call) {
  const d = decodeCall(call.x0);
  const fid = d.fid;
  const imm = (call.imm ?? 0) & 0xffff;
  const debugCalls = call.guest !== "os";
  const x1 = BigInt.asUintN(64, call.x1 ?? 0n);
  const a1 = d.wide ? x1 : x1 & MASK32; // SMC32 calls see only w1 (DEN 0028 section 3.1)
  const pc =
    call.conduit === "smc"
      ? "The PC still points at the smc, so macvmm adds 4 before resuming."
      : "The PC already points past the hvc, so macvmm resumes without touching it.";
  // The HVF block was measured only with `hvc #0`; over smc, or with another immediate, nobody
  // has looked. Say so instead of stating macvmm's answer as fact.
  const untested = d.hvfBlock && (call.conduit === "smc" || imm !== 0)
    ? `Hypervisor.framework answers this ID itself when it comes through hvc #0 (measured). It was measured only with hvc #0; ${call.conduit === "smc" ? "over smc" : "with another immediate"} this has not been tested, so this is what macvmm does if the call reaches it.`
    : null;
  const ret = (x0, result, extra = {}) => ({ by: "macvmm", x0, result, warn: null, stop: null, exitCode: null, pc, untested, ...extra });
  const NS = MASK64;

  if (call.conduit !== "smc" && imm === 0 && d.hvfBlock) {
    return {
      by: "hvf",
      x0: 0xffff_ffffn,
      result: "Hypervisor.framework answers this ID itself, inside the macOS kernel: the guest gets 0xffffffff in x0 and macvmm never sees an exit.",
      warn: null,
      stop: null,
      exitCode: null,
      pc: "There is no exit, so macvmm never touches the PC.",
      untested: null,
    };
  }
  if (imm !== 0) {
    return ret(NS, "An immediate other than 0 is not an SMCCC call, whatever is in x0.", {
      warn: `hvc/smc with immediate ${rustHex(imm)} is not SMCCC; returning -1`,
    });
  }
  switch (fid) {
    case SMCCC_VERSION:
      return ret(0x1_0001n, "SMCCC version 1.1: major 1 in bits 30 to 16, minor 1 in bits 15 to 0.");
    case PSCI_VERSION:
      return ret(0x1_0001n, "PSCI version 1.1: major 1 in bits 30 to 16, minor 1 in bits 15 to 0.");
    case SMCCC_ARCH_FEATURES: {
      const asked = Number(a1 & MASK32) >>> 0;
      return asked === SMCCC_VERSION
        ? ret(0n, `0: ${groupedHex(asked)} (SMCCC_VERSION) is implemented. It is the only function macvmm advertises here.`)
        : ret(NS, `-1: ${groupedHex(asked)}${functionName(asked) ? ` (${functionName(asked)})` : ""} is not advertised. macvmm offers no Spectre workarounds; the host handles them.`);
    }
    case PSCI_CPU_SUSPEND_32:
    case PSCI_CPU_SUSPEND_64:
      return ret(0n, "SUCCESS (0): a standby request, and the vCPU wakes at once.");
    case PSCI_CPU_OFF:
      return ret(null, "Turns the calling vCPU off; on success the call never returns (chapter 20 explains the CPU power table). Nothing is written back.");
    case PSCI_CPU_ON_32:
    case PSCI_CPU_ON_64:
      return ret(null, `The answer depends on x1 to x3 (target CPU, entry point, context) and the CPU power table: 0, -2 or another PSCI error. Chapter 20 validates every argument.${d.wide ? "" : " This is the 32-bit form, so only w1 to w3 count."}`);
    case PSCI_AFFINITY_INFO_32:
    case PSCI_AFFINITY_INFO_64:
      return ret(null, `The answer depends on x1 (which CPU), x2 (the lowest affinity level; macvmm accepts only 0, anything else gets -2) and the CPU power table: 0 for on, 1 for off, 2 for on-pending, or -2 for a bad argument (chapter 20).${d.wide ? "" : " This is the 32-bit form, so only w1 and w2 count."}`);
    case PSCI_MIGRATE_INFO_TYPE:
      return ret(2n, "2: no trusted OS is present that would need migrating.");
    case PSCI_SYSTEM_OFF:
      return ret(null, "Nothing is returned: the VM powers off.", { stop: "guest powered off", exitCode: "0" });
    case PSCI_SYSTEM_RESET:
      return ret(null, "Nothing is returned: the VM resets. With --on-reset reboot (the default) macvmm boots the guest again; with --on-reset exit it stops.", {
        stop: "guest requested a reset",
        exitCode: "4 with --on-reset exit",
      });
    case PSCI_FEATURES: {
      const asked = Number(a1 & MASK32) >>> 0;
      const nm = functionName(asked);
      const what = `${groupedHex(asked)}${nm ? ` (${nm})` : ""}`;
      return implemented(asked, debugCalls)
        ? ret(0n, `0: ${what} is implemented.`)
        : ret(NS, `-1: ${what} is not implemented${nm && !debugCalls ? " for this guest" : ""}.`);
    }
    default:
      break;
  }
  if (debugCalls) {
    if (fid === DEBUG_PUTC) {
      return ret(0n, `Sends the low byte of x1, ${putcByteText(Number(x1 & 0xffn))}, to the serial output.`);
    }
    if (fid === DEBUG_EXIT) {
      const code = x1 > 0xffff_ffffn ? 0xffff_ffffn : x1;
      return ret(null, `Nothing is returned: the VM stops with the guest's code ${code}.`, {
        stop: `guest exit code ${code}`,
        exitCode: code === 0n ? "0" : "6",
      });
    }
    if (fid === DEBUG_MEMHASH) {
      return ret(null, "Hashes x2 bytes of guest RAM from address x1: x0 = 0 and x1 = the hash, or -2 if the range is empty, longer than 1 GiB or outside RAM.");
    }
    if (fid === DEBUG_BOOT_COUNT) {
      return ret(0n, "0 in x0, and the boot generation (0 on the first boot) in x1.");
    }
  }
  if (PROBES.some(([id]) => id === fid)) {
    return ret(NS, "-1 on purpose, without a warning: a stock Linux boot asks this, and macvmm has no such service.");
  }
  const why = d.name && d.nameSource === "macvmm"
    ? "-1: debug calls answer only for macvmm's own test guests, so a real OS sees no extra surface."
    : "-1: an ID nobody expected. The answer is defined, and the VMM logs a rate-limited warning.";
  return ret(NS, why, { warn: `unknown SMCCC function ${rustHex(fid)}; returning -1` });
}

// ---------------------------------------------------------------------------------------------
// Part 2: system registers

/** `hv_sys_reg_t` packing (chapter 06's SysReg::new): op0<<14 | op1<<11 | CRn<<7 | CRm<<3 | op2. */
export function hvEnc({ op0, op1, crn, crm, op2 }) {
  return ((op0 & 3) << 14) | ((op1 & 7) << 11) | ((crn & 15) << 7) | ((crm & 15) << 3) | (op2 & 7);
}

const key = ({ op0, op1, crn, crm, op2 }) => `${op0},${op1},${crn},${crm},${op2}`;

/** The name macvmm prints (`sysreg::display_name`): a table name or S<op0>_<op1>_C<n>_C<m>_<op2>. */
export function displayName(c) {
  return SYSREG_NAMES[key(c)] ?? `S${c.op0}_${c.op1}_C${c.crn}_C${c.crm}_${c.op2}`;
}

/** True if the name came from a table (not the generic spelling). */
export function hasName(c) {
  return Object.prototype.hasOwnProperty.call(SYSREG_NAMES, key(c));
}

const BY_NAME = new Map(Object.entries(SYSREG_NAMES).map(([k, n]) => [n.toUpperCase(), k]));

/** All named registers, sorted, for a picker. */
export function registerNames() {
  return [...BY_NAME.keys()].map((n) => SYSREG_NAMES[BY_NAME.get(n)]).sort();
}

/** Look a register up by name or by S<op0>_<op1>_C<n>_C<m>_<op2>. Returns coordinates or null. */
export function lookupRegister(text) {
  if (typeof text !== "string" || text.length > 40) return null;
  const t = text.trim().toUpperCase();
  const k = BY_NAME.get(t);
  if (k) {
    const [op0, op1, crn, crm, op2] = k.split(",").map(Number);
    return { op0, op1, crn, crm, op2 };
  }
  const m = /^S([0-3])_([0-7])_C(\d{1,2})_C(\d{1,2})_([0-7])$/.exec(t);
  if (!m) return null;
  const [op0, op1, crn, crm, op2] = m.slice(1).map(Number);
  if (crn > 15 || crm > 15) return null;
  return { op0, op1, crn, crm, op2 };
}

/** Check a set of fields for an mrs/msr; returns {field, text} for the first bad one, or null. */
export function fieldProblem(f) {
  const ok = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!ok(f.op0, 3) || f.op0 < 2) return { field: "op0", text: "op0 must be 2 or 3 for an mrs or msr (0 and 1 are other system instructions)." };
  if (!ok(f.op1, 7)) return { field: "op1", text: "op1 is 3 bits: 0 to 7." };
  if (!ok(f.crn, 15)) return { field: "crn", text: "CRn is 4 bits: 0 to 15." };
  if (!ok(f.crm, 15)) return { field: "crm", text: "CRm is 4 bits: 0 to 15." };
  if (!ok(f.op2, 7)) return { field: "op2", text: "op2 is 3 bits: 0 to 7." };
  if (!ok(f.rt, 31)) return { field: "rt", text: "Rt is 5 bits: 0 to 31 (31 means xzr)." };
  return null;
}

/** Check a set of fields for an mrs/msr; returns an error string or null. */
export function fieldError(f) {
  const p = fieldProblem(f || {});
  return p ? p.text : null;
}

/** The instruction word of an mrs (read) or msr (write). Fields must pass fieldError. */
export function encodeInsn(f) {
  return (
    0xd510_0000 |
    ((f.read ? 1 : 0) << 21) |
    ((f.op0 & 1) << 19) |
    (f.op1 << 16) |
    (f.crn << 12) |
    (f.crm << 8) |
    (f.op2 << 5) |
    f.rt
  ) >>> 0;
}

/** The ESR_EL2 value a trap of this access carries: EC 0x18, IL 1, then the ISS. */
export function encodeSyndrome(f) {
  return (
    (0x18 << 26) |
    (1 << 25) |
    (f.op0 << 20) |
    (f.op2 << 17) |
    (f.op1 << 14) |
    (f.crn << 10) |
    (f.rt << 5) |
    (f.crm << 1) |
    (f.read ? 1 : 0)
  ) >>> 0;
}

/** `esr::decode_sysreg`: the fields of an EC 0x18 ISS (any ESR value; only the bits are read). */
export function decodeSyndromeFields(esr) {
  esr >>>= 0;
  return {
    op0: bits(esr, 20, 2),
    op2: bits(esr, 17, 3),
    op1: bits(esr, 14, 3),
    crn: bits(esr, 10, 4),
    rt: bits(esr, 5, 5),
    crm: bits(esr, 1, 4),
    read: bits(esr, 0, 1) === 1,
  };
}

/** Field layouts, high bit first, for the bit table in the view. */
export const INSN_LAYOUT = Object.freeze([
  { name: "fixed 1101010100", hi: 31, lo: 22 },
  { name: "L (1 = mrs)", hi: 21, lo: 21, field: "read" },
  { name: "1", hi: 20, lo: 20 },
  { name: "o0 (op0 = 2 + o0)", hi: 19, lo: 19, field: "op0" },
  { name: "op1", hi: 18, lo: 16, field: "op1" },
  { name: "CRn", hi: 15, lo: 12, field: "crn" },
  { name: "CRm", hi: 11, lo: 8, field: "crm" },
  { name: "op2", hi: 7, lo: 5, field: "op2" },
  { name: "Rt", hi: 4, lo: 0, field: "rt" },
]);

export const ESR_LAYOUT = Object.freeze([
  { name: "EC (0x18)", hi: 31, lo: 26 },
  { name: "IL", hi: 25, lo: 25 },
  { name: "RES0", hi: 24, lo: 22 },
  { name: "Op0", hi: 21, lo: 20, field: "op0" },
  { name: "Op2", hi: 19, lo: 17, field: "op2" },
  { name: "Op1", hi: 16, lo: 14, field: "op1" },
  { name: "CRn", hi: 13, lo: 10, field: "crn" },
  { name: "Rt", hi: 9, lo: 5, field: "rt" },
  { name: "CRm", hi: 4, lo: 1, field: "crm" },
  { name: "Direction (1 = read)", hi: 0, lo: 0, field: "read" },
]);

/** The rows of `sysreg::POLICY`, first match wins; model.test.mjs compares them with the Rust. */
export const POLICY = Object.freeze([
  { what: "OSLAR_EL1", op0: 2, op1: 0, crn: 1, crm: [0, 0], op2: [4, 4], policy: "OsLockAccess" },
  { what: "OSLSR_EL1", op0: 2, op1: 0, crn: 1, crm: [1, 1], op2: [4, 4], policy: "OsLockStatus" },
  { what: "OSDLR_EL1", op0: 2, op1: 0, crn: 1, crm: [3, 3], op2: [4, 4], policy: "OsDoubleLock" },
  { what: "DBG{B,W}{V,C}R<n>_EL1", op0: 2, op1: 0, crn: 0, crm: [0, 15], op2: [4, 7], policy: "RazWi" },
  { what: "MDCCINT_EL1", op0: 2, op1: 0, crn: 0, crm: [2, 2], op2: [0, 0], policy: "RazWi" },
  { what: "MDSCR_EL1", op0: 2, op1: 0, crn: 0, crm: [2, 2], op2: [2, 2], policy: "RazWi" },
  { what: "LOR (LORSA, LOREA, LORN, LORC)", op0: 3, op1: 0, crn: 10, crm: [4, 4], op2: [0, 3], policy: "RazWi" },
  { what: "LORID_EL1", op0: 3, op1: 0, crn: 10, crm: [4, 4], op2: [7, 7], policy: "RazRo" },
  { what: "PMU (PMCR_EL0 .. PMOVSSET_EL0)", op0: 3, op1: 3, crn: 9, crm: [12, 14], op2: [0, 7], policy: "Undef" },
  { what: "PMU (PMINTEN{SET,CLR}_EL1, PMMIR)", op0: 3, op1: 0, crn: 9, crm: [14, 14], op2: [0, 7], policy: "Undef" },
  { what: "PMU (PMEV*<n>_EL0, PMCCFILTR)", op0: 3, op1: 3, crn: 14, crm: [8, 15], op2: [0, 7], policy: "Undef" },
]);

const WHY = {
  OsLockAccess: "the debug OS lock, emulated per vCPU: an operating system sets it while it saves or restores debug registers, and Linux clears it early in boot",
  OsLockStatus: "the OS lock's status, emulated per vCPU",
  OsDoubleLock: "the OS double lock, a second bit kept per vCPU",
  RazWi: "read as zero, writes ignored: the register exists on every such CPU, and zero says nothing is set or enabled",
  RazRo: "read as zero, meaning zero limited-ordering regions; it is read-only, so a write is UNDEFINED",
  Undef: "the guest was told this hardware does not exist (PMUVer = 0: the ID register says there are no performance counters), so UNDEFINED is the honest answer",
};

/** The policy row for these coordinates, or null (then the policy is the default UNDEF). */
export function ruleFor(c) {
  return (
    POLICY.find(
      (r) => r.op0 === c.op0 && r.op1 === c.op1 && r.crn === c.crn && c.crm >= r.crm[0] && c.crm <= r.crm[1] && c.op2 >= r.op2[0] && c.op2 <= r.op2[1],
    ) ?? null
  );
}

/**
 * What macvmm does if this access reaches it: `sysreg::handle` with the cold-reset state
 * (OS lock set, double lock clear). Returns {policy, row, outcome: "read"|"written"|"undef",
 * value: BigInt|null, text}.
 */
export function policyOutcome(c, read) {
  const row = ruleFor(c);
  const policy = row ? row.policy : "Undef";
  const why = row ? WHY[policy] : "no row in the policy table, so it gets the default: never let an unknown register through";
  const undef = (extra) => ({
    policy,
    row: row ? row.what : null,
    outcome: "undef",
    value: null,
    text: `Inject UNDEF${extra}: macvmm writes ESR_EL1 = 0x02000000 (the guest's own syndrome register; EC 0 means "unknown reason"), sets ELR_EL1 to the instruction's address, and jumps to the guest's exception handler (VBAR_EL1 + 0x200, the slot for an exception from the guest's own kernel level). Why: ${why}.`,
  });
  const val = (v, t) => ({ policy, row: row ? row.what : null, outcome: "read", value: v, text: t });
  const wr = (t) => ({ policy, row: row ? row.what : null, outcome: "written", value: null, text: t });
  switch (policy) {
    case "OsLockAccess":
      return read ? undef(" (OSLAR_EL1 is write-only)") : wr(`Emulate: bit 0 of the value sets or clears the vCPU's OS lock, then the PC steps over the msr. Why: ${why}.`);
    case "OsLockStatus":
      return read ? val(0xan, `Emulate: reads 0xa (OS lock set, as after a cold reset) or 0x8 once the guest clears it; the PC steps over the mrs. Why: ${why}.`) : undef(" (OSLSR_EL1 is read-only)");
    case "OsDoubleLock":
      return read ? val(0n, `Emulate: reads bit 0, the double lock (0 after reset). Why: ${why}.`) : wr(`Emulate: bit 0 of the value sets or clears the double lock. Why: ${why}.`);
    case "RazWi":
      return read ? val(0n, `RAZ/WI: reads 0 and the PC steps over the mrs. Why: ${why}.`) : wr(`RAZ/WI: the write is ignored and the PC steps over the msr. Why: ${why}.`);
    case "RazRo":
      return read ? val(0n, `RAZ: reads 0 and the PC steps over the mrs. Why: ${why}.`) : undef(" (read-only register)");
    default:
      return undef("");
  }
}

// What reaches macvmm at all is HVF's choice, measured on an M5 Pro with macOS 27.2 (chapter 08's
// table and the module docs of crates/vmm/src/arch/sysreg.rs). "exit" = forwarded to macvmm;
// "hvf-undef" = HVF raises the UNDEF itself; "hvf" = HVF handles it; "hvf-zero" = HVF returns 0.
// null = not measured in that configuration.
const MEASURED = {
  "3,3,9,12,0": { r: ["hvf-undef", "exit"] }, // PMCR_EL0
  "3,0,10,4,7": { r: ["exit", "exit"], w: ["hvf-undef", null] }, // LORID_EL1
  "3,0,10,4,0": { r: ["exit", null], w: ["exit", null] }, // LORSA_EL1
  "3,0,10,4,1": { r: ["exit", null], w: ["exit", null] }, // LOREA_EL1
  "3,0,10,4,2": { r: ["exit", null], w: ["exit", null] }, // LORN_EL1
  "3,0,10,4,3": { r: ["exit", null], w: ["exit", null] }, // LORC_EL1
  "2,3,0,1,0": { r: ["exit", "hvf-zero"], w: ["hvf-undef", null] }, // MDCCSR_EL0
  "2,0,1,0,4": { r: ["hvf-undef", null], w: ["exit", "exit"] }, // OSLAR_EL1
  "2,0,1,1,4": { r: ["exit", "exit"], w: ["hvf-undef", null] }, // OSLSR_EL1
  "2,0,1,3,4": { r: ["exit", null], w: ["exit", null] }, // OSDLR_EL1
  "2,0,0,2,2": { r: ["hvf", null], w: ["hvf", null] }, // MDSCR_EL1
  "2,0,0,0,4": { r: ["hvf", null], w: ["hvf", null] }, // DBGBVR0_EL1
  "3,0,0,5,0": { r: ["hvf", null] }, // ID_AA64DFR0_EL1
  // The IMPLEMENTATION DEFINED space, probed as S3_<op1>_C15_C0_0 (the same 2x2 GIC matrix as PMCR_EL0).
  "3,0,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,1,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,3,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,4,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,5,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,6,15,0,0": { r: ["hvf-undef", "exit"] },
  "3,7,15,0,0": { r: ["hvf-undef", "exit"] },
  // Read by macvmm's test guests, which would see an exit in their traces: they run on the hardware.
  "3,3,14,0,0": { r: ["native", null] }, // CNTFRQ_EL0
  "3,3,14,0,2": { r: ["native", null] }, // CNTVCT_EL0
  "3,0,4,2,2": { r: ["native", null] }, // CurrentEL
  // GIC CPU interface: with the in-kernel GIC, HVF handles these (a Linux boot uses all of them).
  "3,0,4,6,0": { r: ["hvf", null], w: ["hvf", null] }, // ICC_PMR_EL1
  "3,0,12,12,0": { r: ["hvf", null] }, // ICC_IAR1_EL1
  "3,0,12,12,1": { w: ["hvf", null] }, // ICC_EOIR1_EL1
  "3,0,12,12,5": { r: ["hvf", null], w: ["hvf", null] }, // ICC_SRE_EL1
  "3,0,12,12,7": { r: ["hvf", null], w: ["hvf", null] }, // ICC_IGRPEN1_EL1
};

const REACH_TEXT = {
  exit: "reaches macvmm",
  "hvf-undef": "HVF raises the UNDEF itself; no exit",
  hvf: "HVF handles it itself; no exit",
  "hvf-zero": "HVF returns 0 itself; no exit",
  native: "the guest reads it on the hardware; no exit (macvmm's test guests read it)",
};

// The registers Hypervisor.framework keeps as guest state (`hv_vcpu_types.h`'s HV_SYS_REG_* list,
// `SysReg::HV_ACCESSIBLE` in crates/hvf/src/regs.rs): the first HV_ACCESSIBLE_COUNT entries of
// SYSREG_NAMES. model.test.mjs checks the split against the Rust source.
const HV_ACCESSIBLE = new Set(Object.keys(SYSREG_NAMES).slice(0, HV_ACCESSIBLE_COUNT));

/** True if HVF keeps this register as guest state (it can be read with hv_vcpu_get_sys_reg). */
export function hvAccessible(c) {
  return HV_ACCESSIBLE.has(key(c));
}

const isIdSpace = (c) => c.op0 === 3 && c.op1 === 0 && c.crn === 0 && c.crm <= 7;
const isEl2 = (c) => c.op0 === 3 && (c.op1 === 4 || c.op1 === 6);

/**
 * Whether this access reaches macvmm at all. Returns {kind, measured, def, nogic, exits, text}:
 * `def` and `nogic` are the measured outcome in the default configuration and with
 * --irqchip none (null when not measured); `exits` is "yes" (reaches macvmm by default),
 * "nogic" (only with --irqchip none), "no" (never, as far as anyone measured or the architecture
 * says) or "unknown"; `text` is the sentence the readout shows. In order:
 *  1. a measured register (chapter 08's table, docs/research/hvf-api.md);
 *  2. the PMU rows: HVF raised the UNDEF itself for every PMU register probed;
 *  3. an ID register: HVF answers reads itself (chapter 08); writes are UNDEFINED by the ARM ARM;
 *  4. an EL2 register: UNDEFINED at EL1, where macvmm's guests run;
 *  5. any other register HVF keeps as guest state: no exit (a whole Linux boot exits for only
 *     OSLAR_EL1 and OSDLR_EL1);
 *  6. everything else (the IMPLEMENTATION DEFINED space, unnamed encodings): not measured.
 */
export function reach(c, read) {
  const m = MEASURED[key(c)];
  const dir = read ? "r" : "w";
  const exitsOf = (d, n) => (d === "exit" ? "yes" : n === "exit" ? "nogic" : d ? "no" : "unknown");
  if (m && m[dir]) {
    const [d, n] = m[dir];
    const def = d ? REACH_TEXT[d] : null;
    const nogic = n ? REACH_TEXT[n] : null;
    return { kind: "measured", measured: true, def, nogic, exits: exitsOf(d, n), text: `Measured. Default configuration: ${def ?? "not measured"}. With --irqchip none: ${nogic ?? "not measured"}.` };
  }
  const row = ruleFor(c);
  if (row && row.what.startsWith("PMU")) {
    const def = REACH_TEXT["hvf-undef"];
    const nogic = "reaches macvmm (seen for every PMU register probed)";
    return { kind: "pmu", measured: true, def, nogic, exits: "nogic", text: `Measured for the PMU registers probed. Default configuration: ${def}. With --irqchip none: ${nogic}.` };
  }
  const no = (kind, text) => ({ kind, measured: false, def: null, nogic: null, exits: "no", text });
  if (isIdSpace(c)) {
    return read
      ? no("id", "No. This is an ID register (a read-only register that describes the CPU's features): HVF answers reads itself, so they never reach macvmm. ID_AA64DFR0_EL1 was probed: no exit.")
      : no("id", "No. ID registers are read-only: the ARM ARM makes an msr to one UNDEFINED, so the guest takes the exception itself. Not probed.");
  }
  if (isEl2(c) && hvAccessible(c)) {
    return no("el2", "No. This register belongs to EL2, the hypervisor's level. macvmm's guests run at EL1, where the ARM ARM makes this access UNDEFINED, so the guest takes the exception itself. HVF keeps it as guest state only for a VM started with EL2 enabled.");
  }
  if (hvAccessible(c)) {
    return no("guest-state", "No. HVF holds this register as guest state (it is in Hypervisor.framework's register list) and switches it in and out with the vCPU, so guest accesses run on the hardware or are handled inside HVF and do not exit. A whole Linux boot exits for only two system registers, OSLAR_EL1 and OSDLR_EL1.");
  }
  return { kind: "unknown", measured: false, def: null, nogic: null, exits: "unknown", text: "Not measured. Which of these registers trap is HVF's choice, so only an experiment (the trace's sysreg category) can tell." };
}

/** `mrs x0, PMCR_EL0` / `msr OSLAR_EL1, x9`; Rt 31 is xzr. */
export function asmText(f) {
  const r = f.rt === 31 ? "xzr" : `x${f.rt}`;
  const n = displayName(f);
  return f.read ? `mrs ${r}, ${n}` : `msr ${n}, ${r}`;
}

/** Exception-generating instructions (C4.1.65 / C6.2 SVC, HVC, SMC, BRK), for a helpful message. */
function exceptionInsn(w) {
  if (bits(w, 24, 8) !== 0xd4 || bits(w, 2, 3) !== 0) return null;
  const opc = bits(w, 21, 3);
  const ll = bits(w, 0, 2);
  const imm = bits(w, 5, 16);
  const name = opc === 0 ? [null, "svc", "hvc", "smc"][ll] : opc === 1 && ll === 0 ? "brk" : null;
  return name ? `${name} #${rustHex(imm)}` : null;
}

const EC_NAMES = { 0x00: "unknown reason", 0x01: "WFI or WFE", 0x15: "svc", 0x16: "hvc", 0x17: "smc", 0x20: "instruction abort from a lower level", 0x24: "data abort from a lower level", 0x3c: "brk" };

/**
 * Analyze a 32-bit word as an mrs/msr instruction or an EC 0x18 syndrome.
 * mode: "auto" (a word whose top six bits are 0x18 is a syndrome; anything else an instruction),
 * "insn" or "esr". Returns {as: "insn"|"esr", ok: bool, error?, fields?, ...derived}.
 */
export function analyzeWord(word, mode = "auto") {
  const w = word >>> 0;
  const as = mode === "insn" || mode === "esr" ? mode : bits(w, 26, 6) === 0x18 ? "esr" : "insn";
  const notes = [];
  let f;
  if (as === "esr") {
    const ec = bits(w, 26, 6);
    if (ec !== 0x18) {
      const name = EC_NAMES[ec];
      let error = `EC is ${hex(ec, 2)}${name ? ` (${name})` : ""}, not 0x18, so this is not a system-register trap.`;
      if (ec === 0x16 || ec === 0x17) error += ` Its immediate is ${rustHex(bits(w, 0, 16))}; the SMCCC half reads its x0.`;
      return { as, ok: false, word: w, error };
    }
    f = decodeSyndromeFields(w);
    if (bits(w, 25, 1) === 0) notes.push("IL is 0, which a trapped 32-bit mrs or msr never reports.");
    if (bits(w, 22, 3) !== 0) notes.push("Bits 24 to 22 are RES0 (reserved, zero) in this layout but are set here; the decoder ignores them.");
    if (f.op0 < 2) {
      return { as, ok: false, word: w, error: `Op0 is ${f.op0}: this syndrome is from a system instruction such as dc, ic, at or tlbi (Op0 1) or an msr-immediate (Op0 0), not from a register move.` };
    }
  } else {
    if (((w & 0xffd0_0000) >>> 0) !== 0xd510_0000) {
      const exc = exceptionInsn(w);
      if (exc) {
        const smccc = exc.startsWith("hvc") || exc.startsWith("smc");
        return { as, ok: false, word: w, error: `This is ${exc}, an exception-generating instruction, not an mrs or msr.${smccc ? " The SMCCC half explains what such a call carries." : ""}` };
      }
      if (bits(w, 22, 10) === 0x354) {
        const op0 = bits(w, 19, 2);
        const what = op0 === 1 ? "a sys or sysl instruction (dc, ic, at, tlbi and friends)" : "a hint, a barrier or an msr-immediate (op0 0)";
        return { as, ok: false, word: w, error: `This is ${what}, a system instruction but not a register move: an mrs or msr has bit 20 set (op0 2 or 3).` };
      }
      return { as, ok: false, word: w, error: "Not an mrs or msr: those words start 0xD51 to 0xD53 (bits 31 to 22 are 1101010100 and bit 20 is 1)." };
    }
    f = {
      read: bits(w, 21, 1) === 1,
      op0: 2 + bits(w, 19, 1),
      op1: bits(w, 16, 3),
      crn: bits(w, 12, 4),
      crm: bits(w, 8, 4),
      op2: bits(w, 5, 3),
      rt: bits(w, 0, 5),
    };
  }
  return { as, ok: true, word: w, notes, ...describe(f) };
}

/** Everything the readout shows about one access (fields must pass fieldError). */
export function describe(f) {
  const fields = { op0: f.op0, op1: f.op1, crn: f.crn, crm: f.crm, op2: f.op2, rt: f.rt, read: !!f.read };
  const policy = policyOutcome(fields, fields.read);
  const r = reach(fields, fields.read);
  // If the access never reaches macvmm, the policy is what macvmm *would* do, and no warning is printed.
  policy.hypothetical = r.exits === "no";
  return {
    fields,
    name: displayName(fields),
    named: hasName(fields),
    asm: asmText(fields),
    enc: hvEnc(fields),
    insn: encodeInsn(fields),
    esr: encodeSyndrome(fields),
    policy,
    reach: r,
    warn: policy.outcome === "undef" && !policy.hypothetical ? `${fields.read ? "MRS" : "MSR"} ${displayName(fields)} at pc <pc>: injecting UNDEF` : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Presets (the numbers the lessons and captures quote)

export const SMCCC_PRESETS = Object.freeze([
  { id: "off", label: "SYSTEM_OFF (0x8400_0008), the primer's puzzle", x0: 0x8400_0008n },
  { id: "putc", label: "DEBUG_PUTC (0xC600_4D01), chapter 03's first call", x0: 0xc600_4d01n, x1: 0x48n },
  { id: "version", label: "PSCI_VERSION (0x8400_0000)", x0: 0x8400_0000n },
  { id: "aff64", label: "0xC400_0004, the primer's self-check", x0: 0xc400_0004n },
  { id: "archfeat", label: "SMCCC_ARCH_FEATURES asking about SMCCC_VERSION", x0: 0x8000_0001n, x1: 0x8000_0000n },
  { id: "features", label: "PSCI_FEATURES asking about 0x8400_0099, an unknown PSCI ID", x0: 0x8400_000an, x1: 0x8400_0099n },
  { id: "sip", label: "0x8200_0000, a call for the chip maker's firmware (SiP)", x0: 0x8200_0000n },
  { id: "uid", label: "Call UID (0x8600_FF01), Linux asking \"are you KVM?\"", x0: 0x8600_ff01n, guest: "os" },
  { id: "hvf", label: "0xC600_0001, a number HVF keeps for itself", x0: 0xc600_0001n },
  { id: "upper", label: "x0 = 0xFFFF_FFFF_8400_0000 (upper half set)", x0: 0xffff_ffff_8400_0000n },
  { id: "smc", label: "SYSTEM_RESET through smc #0", x0: 0x8400_0009n, conduit: "smc" },
  { id: "hostile", label: "0xB07D_F10C, an arbitrary ID a hostile guest might send", x0: 0xb07d_f10cn },
  { id: "imm", label: "hvc #0x4d56, a call with the wrong immediate", x0: 0x8400_0000n, imm: 0x4d56 },
]);

export const SYSREG_PRESETS = Object.freeze([
  { id: "pmcr", label: "mrs x0, PMCR_EL0 (instruction word)", word: 0xd53b_9c00 },
  { id: "esr-pmcr", label: "0x6230E419: the PMCR_EL0 trap's syndrome", word: 0x6230_e419 },
  { id: "esr-lorid", label: "0x623E2AA9: LORID_EL1, read", word: 0x623e_2aa9 },
  { id: "esr-oslar", label: "0x62280520: chapter 08's hand-decoding exercise", word: 0x6228_0520 },
  { id: "esr-oslsr", label: "0x622806A3: OSLSR_EL1, read", word: 0x6228_06a3 },
  { id: "mdccsr", label: "mrs x8, MDCCSR_EL0 (instruction word)", word: 0xd533_0108 },
  { id: "oslar", label: "msr OSLAR_EL1, x9 (instruction word)", word: 0xd510_1089 },
  { id: "unnamed", label: "mrs x0, S3_0_C15_C0_0 (a register with no name)", word: 0xd538_f000 },
  { id: "isb", label: "isb (not a register move)", word: 0xd503_3fdf },
  { id: "hvc", label: "hvc #0 (not a register move)", word: 0xd400_0002 },
]);

// ---------------------------------------------------------------------------------------------
// State

/** The state a fresh lab starts in. */
export function initialState() {
  return {
    half: "smccc",
    sys: { word: 0xd53b_9c00, mode: "auto" },
    call: { x0: 0x8400_0008n, x1: 0n, conduit: "hvc", imm: 0, guest: "test" },
  };
}

const MODES = ["auto", "insn", "esr"];

/** next = step(state, action). Invalid actions return the same state object. */
export function step(state, a) {
  if (!a || typeof a !== "object") return state;
  const s = state;
  const withCall = (patch) => ({ ...s, call: { ...s.call, ...patch } });
  const withSys = (patch) => ({ ...s, sys: { ...s.sys, ...patch } });
  switch (a.type) {
    case "reset":
      return initialState();
    case "half":
      return a.half === "smccc" || a.half === "sysreg" ? (a.half === s.half ? s : { ...s, half: a.half }) : s;
    case "x0":
      return typeof a.value === "bigint" ? withCall({ x0: BigInt.asUintN(64, a.value) }) : s;
    case "x1":
      return typeof a.value === "bigint" ? withCall({ x1: BigInt.asUintN(64, a.value) }) : s;
    case "conduit":
      return a.value === "hvc" || a.value === "smc" ? withCall({ conduit: a.value }) : s;
    case "guest":
      return a.value === "test" || a.value === "os" ? withCall({ guest: a.value }) : s;
    case "imm":
      return Number.isInteger(a.value) && a.value >= 0 && a.value <= 0xffff ? withCall({ imm: a.value }) : s;
    case "fid": {
      // Change one field of w0; the upper half of x0 is kept.
      const f = fidFields(Number(s.call.x0 & MASK32));
      const v = a.value;
      if (a.field === "fast" || a.field === "wide") f[a.field] = !!v;
      else if (a.field === "oen" && Number.isInteger(v) && v >= 0 && v <= 63) f.oen = v;
      else if (a.field === "mbz" && Number.isInteger(v) && v >= 0 && v <= 0xff) f.mbz = v;
      else if (a.field === "func" && Number.isInteger(v) && v >= 0 && v <= 0xffff) f.func = v;
      else return s;
      return withCall({ x0: (s.call.x0 & ~MASK32 & MASK64) | BigInt(encodeFid(f)) });
    }
    case "bit": {
      if (!Number.isInteger(a.bit) || a.bit < 0 || a.bit > 31) return s;
      return withCall({ x0: s.call.x0 ^ (1n << BigInt(a.bit)) });
    }
    case "callPreset": {
      const p = SMCCC_PRESETS.find((q) => q.id === a.id);
      if (!p) return s;
      return { ...s, half: "smccc", call: { x0: p.x0, x1: p.x1 ?? 0n, conduit: p.conduit ?? "hvc", imm: p.imm ?? 0, guest: p.guest ?? "test" } };
    }
    case "word":
      return Number.isInteger(a.value) && a.value >= 0 && a.value <= 0xffff_ffff ? withSys({ word: a.value >>> 0 }) : s;
    case "mode":
      return MODES.includes(a.value) ? withSys({ mode: a.value }) : s;
    case "fields": {
      // Re-encode from fields, keeping the current interpretation (syndrome or instruction).
      if (fieldError(a.fields || {})) return s;
      const cur = analyzeWord(s.sys.word, s.sys.mode);
      const asEsr = cur.as === "esr";
      return withSys({ word: asEsr ? encodeSyndrome(a.fields) : encodeInsn(a.fields) });
    }
    case "sysPreset": {
      const p = SYSREG_PRESETS.find((q) => q.id === a.id);
      return p ? { ...s, half: "sysreg", sys: { word: p.word, mode: "auto" } } : s;
    }
    default:
      return s;
  }
}

// ---------------------------------------------------------------------------------------------
// Share state: `<half>_<mode><word>_<x0>[_smc][_i<imm>][_os][_a<x1>]`
// half: s (smccc) or r (registers); mode: a (auto), i (instruction), e (syndrome).
// Reference: `s_ad53b9c00_84000008` is the fresh lab.

const HASH_RE = /^([sr])_([aie])([0-9a-f]{8})_([0-9a-f]{1,16})((?:_(?:smc|os|i[0-9a-f]{1,4}|a[0-9a-f]{1,16}))*)$/;

export function encode(state) {
  const parts = [
    state.half === "sysreg" ? "r" : "s",
    { auto: "a", insn: "i", esr: "e" }[state.sys.mode] + (state.sys.word >>> 0).toString(16).padStart(8, "0"),
    state.call.x0.toString(16),
  ];
  if (state.call.conduit === "smc") parts.push("smc");
  if (state.call.imm) parts.push("i" + state.call.imm.toString(16));
  if (state.call.guest === "os") parts.push("os");
  if (state.call.x1) parts.push("a" + state.call.x1.toString(16));
  return parts.join("_");
}

/** Parse a share string strictly; anything unexpected gives null (the lab then starts fresh). */
export function decode(str) {
  if (typeof str !== "string" || str.length > 80) return null;
  const m = HASH_RE.exec(str);
  if (!m) return null;
  const s = initialState();
  s.half = m[1] === "r" ? "sysreg" : "smccc";
  s.sys = { word: parseInt(m[3], 16) >>> 0, mode: { a: "auto", i: "insn", e: "esr" }[m[2]] };
  s.call.x0 = BigInt("0x" + m[4]);
  const seen = new Set();
  for (const opt of m[5].split("_").filter(Boolean)) {
    const k = opt === "smc" || opt === "os" ? opt : opt[0];
    if (seen.has(k)) return null;
    seen.add(k);
    if (opt === "smc") s.call.conduit = "smc";
    else if (opt === "os") s.call.guest = "os";
    else if (k === "i") s.call.imm = parseInt(opt.slice(1), 16);
    else if (k === "a") s.call.x1 = BigInt("0x" + opt.slice(1));
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Readout text (one plain-text summary per half)

export function callSummary(call) {
  const d = decodeCall(call.x0);
  const ans = macvmmAnswer(call);
  const parts = [
    d.fast
      ? `${groupedHex(d.fid)}: fast call, ${d.wide ? "64" : "32"}-bit convention, owner ${d.oen} (${d.owner}), function ${rustHex(d.func)}.`
      : `${groupedHex(d.fid)}: yielding call, ${d.wide ? "64" : "32"}-bit convention, in the range ${d.owner}, function ${rustHex(d.func)}.`,
  ];
  if (d.name) parts.push(`Name: ${d.name}.`);
  else if (d.psci) parts.push("In the PSCI range, but not a function macvmm serves.");
  if (d.upperIgnored) parts.push("The upper half of x0 is ignored: only w0 is the function ID.");
  for (const fl of d.flags) if (fl.level === "error") parts.push(fl.text);
  if (ans.by === "hvf") parts.push("Answered inside HVF: x0 = 0xffffffff, no exit.");
  else if (ans.stop) parts.push(`macvmm stops the VM: ${ans.stop}.`);
  else if (ans.x0 !== null) parts.push(`macvmm answers x0 = ${regText(ans.x0)}.`);
  else parts.push("macvmm's answer depends on the arguments.");
  return parts.join(" ");
}

export function sysSummary(sys) {
  const a = analyzeWord(sys.word, sys.mode);
  if (!a.ok) return `${groupedHex(a.word)}: ${a.error}`;
  const f = a.fields;
  const src = a.as === "esr" ? "syndrome" : "instruction";
  const what = a.policy.outcome === "undef" ? "inject UNDEF" : a.policy.outcome === "read" ? `reads ${rustHex(a.policy.value)}` : "write emulated or ignored";
  const tail = a.reach.exits === "no" ? `It never reaches macvmm (${a.reach.kind === "id" ? "an ID register" : a.reach.kind === "el2" ? "an EL2 register" : "HVF handles it"}); if it did, macvmm would ${what}.` : `If it reaches macvmm: ${what}.`;
  return `${groupedHex(a.word)} (${src}): ${a.asm}. Coordinates (${f.op0}, ${f.op1}, ${f.crn}, ${f.crm}, ${f.op2}), ${a.named ? "" : "no name in macvmm's tables, "}hv_sys_reg_t ${rustHex(a.enc)}. ${tail}`;
}
