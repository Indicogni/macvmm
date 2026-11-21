// two-stage-walker: the model. Pure logic, no DOM, no I/O, so `node --test` can import it.
//
// What it models (ARM ARM DDI 0487: D8.1 translation regimes and TCR fields, D8.2 the
// translation process, D8.3 VMSAv8-64 descriptor formats, D8.4 memory attributes; register
// fields from D19.2 TCR_EL1, MAIR_EL1, ESR_ELx, FAR_ELx, HPFAR_EL2):
//
// - Stage 1, the guest's EL1&0 regime, TTBR0 half only, with a 4 KiB or 16 KiB granule and a
//   T0SZ between 16 and 39 (the same range as crates/vmm/src/arch/stage1_walk.rs). The upper
//   half is treated as disabled (EPD1 = 1, as in the test guests' TCR_EL1), so an upper-half VA
//   takes a level-0 translation fault.
// - Stage 2, Hypervisor.framework's tables, with a 4 KiB or 16 KiB granule and a 36, 40 or
//   42-bit IPA space. The walk starts at the shallowest level that covers the IPA space; the
//   architecture also allows concatenating up to 16 tables at the start level, which this lab
//   does not do (a 36-bit IPA with 16 KiB pages starts at level 2 either way, as chapter 05 says).
// - Every stage-1 descriptor address is itself an IPA, so in "both stages" mode it is walked
//   through stage 2 before it is read (the page-tables primer's "Under the hood"). A stage-2
//   failure there is reported with S1PTW = 1.
// - Faults: translation, address size, access flag, permission; reported as the syndrome the
//   hardware would write: ESR_EL1/FAR_EL1 for a stage-1 fault (the guest handles it), and
//   ESR_EL2/FAR_EL2/HPFAR_EL2 for a stage-2 fault (a VM exit). The data-abort ISS layout is the
//   one crates/vmm decodes and course/captures/05-*.txt show.
//
// - Alignment: an access to Device memory (a stage-1 Device page, or any data access with the
//   MMU off, which the architecture treats as Device-nGnRnE) must be aligned to its size, or it
//   takes an alignment fault (DFSC 0x21) at stage 1, reported in ESR_EL1, before stage 2 is
//   consulted (ARM ARM B2.5.2 and D8.2). SCTLR_EL1.A = 0, as in the test guests, so Normal
//   memory accepts misaligned accesses; one that crosses into the next page is translated
//   twice, and a failure in the second page is reported for that page.
// - With the MMU off, an address with bits set at or above the physical address size takes a
//   stage-1 address size fault at level 0 (D8.2, stage 1 disabled), not a stage-2 fault.
//
// Simplifications, each named in the lab's notes: no TLB, no hardware access-flag or dirty
// updates, no PAN, no instruction fetches (loads and stores only), no FEAT_LPA/LPA2, stage-2
// host addresses (HVF's tables, the host pages behind guest RAM) are illustrative: HVF never
// shows them to a VMM. The physical address size the guest's CPU reports is fixed at
// GUEST_PA_BITS (illustrative, chosen to cover the largest IPA size the lab offers).
//
// All addresses and descriptors are BigInt. Guest-controlled numbers (anything typed or taken
// from the URL) are parsed with explicit bounds; the walks are loops over at most four levels.

const B = BigInt;
const ONE = 1n;

/** All-ones mask of `bits` bits, as a BigInt. */
export function mask(bits) {
  return (ONE << B(bits)) - ONE;
}

/** Bits [lo + n - 1 : lo] of `v`. */
export function field(v, lo, n) {
  return (v >> B(lo)) & mask(n);
}

/** `v` with bits [lo + n - 1 : lo] replaced by `x`. */
export function setField(v, lo, n, x) {
  const m = mask(n) << B(lo);
  return (v & ~m) | ((B(x) << B(lo)) & m);
}

const U64 = mask(64);

/** Own-property lookup, so a hostile key such as `__proto__` never matches. */
function own(obj, key) {
  return typeof key === "string" || typeof key === "number" ? Object.hasOwn(obj, key) : false;
}

// ---------------------------------------------------------------------------------------------
// Formatting and parsing

/**
 * Hex the way the course writes addresses: at least 8 digits, grouped by 4 from the right with
 * underscores (`0x0b10_0000`, `0x10_0000_0000`, `0x1_0080_3519`). `digits` forces a width
 * (16 for descriptors: `0x0060_0000_0b00_0403`).
 */
export function hex(v, digits = 8) {
  let s = B(v).toString(16);
  if (s.length < digits) s = s.padStart(digits, "0");
  const groups = [];
  for (let end = s.length; end > 0; end -= 4) groups.unshift(s.slice(Math.max(0, end - 4), end));
  return "0x" + groups.join("_");
}

/** Short hex for small values (indexes, DFSC): `0x58`, `0x6`, `0`. */
export function hexSmall(v) {
  const n = B(v);
  return n === 0n ? "0" : "0x" + n.toString(16);
}

/** Hex as the reference VMM prints it (no grouping, no padding): `0xb000000`. */
export function hexRaw(v) {
  return "0x" + B(v).toString(16);
}

/**
 * Parse a hex number typed by a reader: optional `0x`, underscores allowed, at most 16 digits.
 * Returns `{ ok: true, value }` or `{ ok: false, error }`. Never throws.
 */
export function parseHex(text) {
  if (typeof text !== "string") return { ok: false, error: "Type a hex number such as 0x0b10_0000." };
  let s = text.trim().toLowerCase().replace(/_/g, "");
  if (s.startsWith("0x")) s = s.slice(2);
  if (s.length === 0) return { ok: false, error: "Type a hex number such as 0x0b10_0000." };
  if (s.length > 16) return { ok: false, error: "That is wider than 64 bits." };
  if (!/^[0-9a-f]+$/.test(s)) return { ok: false, error: "Only hex digits 0-9 and a-f (with an optional 0x)." };
  return { ok: true, value: B("0x" + s) };
}

/** Parse an index guess: hex with 0x, or decimal without. */
export function parseIndex(text) {
  if (typeof text !== "string") return { ok: false };
  const s = text.trim().toLowerCase().replace(/_/g, "");
  if (/^0x[0-9a-f]{1,4}$/.test(s)) return { ok: true, value: Number.parseInt(s.slice(2), 16) };
  if (/^[0-9]{1,5}$/.test(s)) return { ok: true, value: Number.parseInt(s, 10) };
  return { ok: false };
}

// ---------------------------------------------------------------------------------------------
// Geometry: what a granule and an input size mean for the walk

/** The two granules Apple CPUs implement (page-granules primer). */
export const GRANULES = Object.freeze({
  4: Object.freeze({ kib: 4, shift: 12, stride: 9 }),
  16: Object.freeze({ kib: 16, shift: 14, stride: 11 }),
});

/**
 * Walk geometry for a granule (4 or 16 KiB) and an input size in bits. Returns the start level
 * and, per level, the lowest input bit it resolves and how many bits it takes (the start level
 * may take fewer than a full stride).
 */
export function geometry(granuleKiB, inBits) {
  const g = own(GRANULES, granuleKiB) ? GRANULES[granuleKiB] : undefined;
  if (!g) throw new RangeError("granule must be 4 or 16");
  const resolved = inBits - g.shift;
  const nLevels = Math.min(4, Math.max(1, Math.ceil(resolved / g.stride)));
  const startLevel = 4 - nLevels;
  const levels = [];
  for (let level = startLevel; level <= 3; level++) {
    const lo = g.shift + g.stride * (3 - level);
    const bits = Math.min(g.stride, inBits - lo);
    levels.push({ level, lo, bits, hi: lo + bits - 1, entries: 2 ** bits });
  }
  return { granule: granuleKiB, shift: g.shift, stride: g.stride, pageBytes: ONE << B(g.shift), inBits, startLevel, levels };
}

/** The geometry row for `level`, or undefined. */
export function levelInfo(geo, level) {
  return geo.levels.find((l) => l.level === level);
}

/** Whether a block descriptor is legal at `level` (D8.3, no LPA2): 4K at 1 and 2, 16K at 2. */
export function blockAllowed(granuleKiB, level) {
  return granuleKiB === 4 ? level === 1 || level === 2 : level === 2;
}

/** Bytes mapped by one leaf at `level`. */
export function leafSize(geo, level) {
  return ONE << B(levelInfo(geo, level).lo);
}

/** Human size: 4 KiB, 2 MiB, 1 GiB, 32 MiB. */
export function sizeText(bytes) {
  const n = B(bytes);
  const units = [["GiB", 30n], ["MiB", 20n], ["KiB", 10n]];
  for (const [u, s] of units) if (n >= ONE << s && n % (ONE << s) === 0n) return `${n >> s} ${u}`;
  return `${n} bytes`;
}

// ---------------------------------------------------------------------------------------------
// Descriptor bits (D8.3)

export const DESC = Object.freeze({
  VALID: 1n,
  TYPE: 2n, // 1 = table (levels 0-2) or page (level 3); 0 = block
  AF: 1n << 10n,
  XN: (1n << 53n) | (1n << 54n), // stage 1: PXN, UXN. Stage 2: XN[1:0].
  APTABLE_NO_WRITE: 1n << 62n, // APTable[1]
  APTABLE_NO_EL0: 1n << 61n, // APTable[0]
});

/** Stage-1 leaf attributes of the test guests (guests/common/mmu.rs): AttrIndx | SH | AF | XN. */
export const S1_NORMAL = Object.freeze({ lo: (1n << 2n) | (3n << 8n) | DESC.AF, hi: 0n }); // 0x704
export const S1_DEVICE = Object.freeze({ lo: (0n << 2n) | DESC.AF, hi: DESC.XN }); // 0x400 | XN
/** The page-tables primer's worked leaf: AF, SH = 11, AP = 00, AttrIndx 0, PXN and UXN. */
export const S1_WORKED = Object.freeze({ lo: 0x700n, hi: DESC.XN });
/** Stage-2 RAM: MemAttr 0b1111 (Normal write-back), S2AP = 11 (read/write), SH = 11, AF. */
export const S2_RAM = Object.freeze({ lo: (0xfn << 2n) | (3n << 6n) | (3n << 8n) | DESC.AF, hi: 0n });

/** The output (or next-table) address field of a descriptor, bits [47:shift]. */
export function descAddress(desc, shift) {
  return desc & (mask(48) & ~mask(shift));
}

const MAIR_NAMES = new Map([
  [0x00, "Device-nGnRnE"],
  [0x04, "Device-nGnRE"],
  [0x08, "Device-nGRE"],
  [0x0c, "Device-GRE"],
  [0x44, "Normal, non-cacheable"],
  [0xbb, "Normal, write-through"],
  [0xff, "Normal, write-back"],
]);

/** The memory type of MAIR byte `attr`. */
export function mairName(attr) {
  if (MAIR_NAMES.has(attr)) return MAIR_NAMES.get(attr);
  return (attr & 0xf0) === 0 ? "Device (other)" : "Normal (other)";
}

const S2_MEMATTR = new Map([
  [0x0, "Device-nGnRnE"],
  [0x1, "Device-nGnRE"],
  [0x2, "Device-nGRE"],
  [0x3, "Device-GRE"],
  [0x5, "Normal, non-cacheable"],
  [0xf, "Normal, write-back"],
]);

// Stage 1 (D8.4.2): bit 54 is UXN (EL0), bit 53 is PXN (EL1).
const S1_XN = ["executable at EL1 and EL0", "not executable at EL1 (PXN)", "not executable at EL0 (UXN)", "never executable"];
// Stage 2 (D8.4.3), XN[1:0] = bits [54:53] with FEAT_XNX. Without FEAT_XNX only bit 54 counts,
// and 1 means never executable.
const S2_XN = [
  "executable at EL1 and EL0",
  "not executable at EL1 (with FEAT_XNX; without it, only bit 54 counts: executable)",
  "never executable",
  "not executable at EL0 (with FEAT_XNX; without it, only bit 54 counts: never executable)",
];
const S1_AP = ["read/write at EL1, none at EL0", "read/write at EL1 and EL0", "read-only at EL1, none at EL0", "read-only at EL1 and EL0"];
const S2_AP = ["no access", "read-only", "write-only", "read/write"];

/**
 * Decode a descriptor for display. `stage` 1 or 2, `level` 0-3, `granule` 4 or 16, `mair` the
 * MAIR_EL1 value for stage-1 memory types. Returns `{ kind, addr, fields: [{name, bits, value, meaning}] }`.
 */
export function decodeDescriptor(desc, { stage, level, granule, mair = 0n }) {
  const shift = GRANULES[granule].shift;
  const d = B(desc);
  const fields = [];
  const kind = descKind(d, level, granule);
  const t = Number(field(d, 0, 2));
  fields.push({ name: "type", bits: "[1:0]", value: t.toString(2).padStart(2, "0"), meaning: kindText(kind) });
  if (kind === "invalid" || kind === "reserved") return { kind, addr: null, fields };
  const addr = descAddress(d, kind === "block" ? Number(levelShift(granule, level)) : shift);
  if (kind === "table") {
    fields.push({ name: "next table", bits: `[47:${shift}]`, value: hex(addr), meaning: "address of the next-level table" });
    if (stage === 1) {
      const apt = Number(field(d, 61, 2));
      fields.push({
        name: "APTable",
        bits: "[62:61]",
        value: apt.toString(2).padStart(2, "0"),
        meaning: apt === 0 ? "no extra limits below" : [apt & 2 ? "no writes below" : "", apt & 1 ? "no EL0 below" : ""].filter(Boolean).join(", "),
      });
    }
    return { kind, addr, fields };
  }
  if (stage === 1) {
    const idx = Number(field(d, 2, 3));
    const attr = Number(field(B(mair), idx * 8, 8));
    fields.push({ name: "AttrIndx", bits: "[4:2]", value: String(idx), meaning: `MAIR_EL1 byte ${idx} = ${hexSmall(attr)}: ${mairName(attr)}` });
    const ap = Number(field(d, 6, 2));
    fields.push({ name: "AP", bits: "[7:6]", value: ap.toString(2).padStart(2, "0"), meaning: S1_AP[ap] });
  } else {
    const ma = Number(field(d, 2, 4));
    fields.push({ name: "MemAttr", bits: "[5:2]", value: ma.toString(2).padStart(4, "0"), meaning: S2_MEMATTR.get(ma) ?? "other" });
    const ap = Number(field(d, 6, 2));
    fields.push({ name: "S2AP", bits: "[7:6]", value: ap.toString(2).padStart(2, "0"), meaning: S2_AP[ap] });
  }
  fields.push({ name: "SH", bits: "[9:8]", value: Number(field(d, 8, 2)).toString(2).padStart(2, "0"), meaning: Number(field(d, 8, 2)) === 3 ? "inner shareable" : "other" });
  const af = Number(field(d, 10, 1));
  fields.push({ name: "AF", bits: "[10]", value: String(af), meaning: af ? "accessed: no fault" : "first access faults (access flag fault)" });
  fields.push({ name: "output address", bits: kind === "block" ? `[47:${levelShift(granule, level)}]` : `[47:${shift}]`, value: hex(addr), meaning: kind === "block" ? "start of the block" : "start of the page" });
  const xn = Number(field(d, 53, 2));
  fields.push({
    name: stage === 1 ? "UXN, PXN" : "XN",
    bits: "[54:53]",
    value: xn.toString(2).padStart(2, "0"),
    meaning: stage === 1 ? S1_XN[xn] : S2_XN[xn],
  });
  return { kind, addr, fields };
}

function levelShift(granule, level) {
  const g = GRANULES[granule];
  return g.shift + g.stride * (3 - level);
}

/** What a descriptor is at `level`: invalid, table, block, page or reserved (D8.3). */
export function descKind(desc, level, granule) {
  const d = B(desc);
  if ((d & DESC.VALID) === 0n) return "invalid";
  const bit1 = (d & DESC.TYPE) !== 0n;
  if (level === 3) return bit1 ? "page" : "reserved";
  if (bit1) return "table";
  return blockAllowed(granule, level) ? "block" : "reserved";
}

function kindText(kind) {
  return {
    invalid: "invalid: the walk stops with a translation fault",
    table: "table: points at the next level",
    block: "block: maps a large aligned region",
    page: "page: maps one granule",
    reserved: "not allowed at this level: treated as invalid",
  }[kind];
}

// ---------------------------------------------------------------------------------------------
// Table builder: turns a list of mappings into tables in a sparse memory (Map addr -> u64)

/**
 * Build translation tables into `mem` (a Map from 8-byte-aligned address to BigInt word).
 *
 * `mappings`: `[{ va, oa, size, attrs: {lo, hi}, name }]`, processed in order. `policy`
 * "largest" uses blocks wherever the granule, alignment and size allow (what the test guests
 * do); "pages" uses only last-level pages. A mapping smaller than the granule, or not aligned
 * to it, is widened to whole pages, and a page another mapping already holds is left alone;
 * both are reported in `notes`, which is how the lab shows what a coarser granule costs.
 * Tables are allocated one granule apart from `allocBase`, the root first, in order of need,
 * which reproduces guests/common/mmu.rs exactly for the 4 KiB test-guest map.
 */
export function buildTables({ geo, root, mappings, policy = "largest", mem = new Map() }) {
  const notes = [];
  const page = geo.pageBytes;
  let next = root + page;
  const tables = [root];
  for (const m of mappings) {
    const va = B(m.va);
    const end0 = va + B(m.size);
    const vaDown = va & ~(page - ONE);
    const end = (end0 + page - ONE) & ~(page - ONE);
    const oa = B(m.oa) - (va - vaDown);
    if (vaDown !== va || end !== end0) {
      notes.push(`${m.name}: ${sizeText(m.size)} at ${hex(va)} is not whole ${sizeText(page)} pages, so it is widened to ${hex(vaDown)}..${hex(end)}.`);
    }
    if ((oa & (page - ONE)) !== 0n) {
      notes.push(
        `${m.name}: ${hex(va)} and its output ${hex(m.oa)} sit at different offsets inside a ${sizeText(page)} page, so this mapping cannot be expressed and is left out; ${hex(va)} reaches whatever its page already maps.`,
      );
      continue;
    }
    let cur = vaDown;
    let out = oa;
    let conflicts = 0;
    while (cur < end) {
      let leafLevel = 3;
      if (policy === "largest") {
        for (const l of geo.levels) {
          if (l.level === 3) break;
          const sz = ONE << B(l.lo);
          if (blockAllowed(geo.granule, l.level) && cur % sz === 0n && out % sz === 0n && end - cur >= sz) {
            leafLevel = l.level;
            break;
          }
        }
      }
      const sz = leafSize(geo, leafLevel);
      // Walk down, creating tables.
      let table = root;
      let ok = true;
      for (const l of geo.levels) {
        const idx = field(cur, l.lo, l.bits);
        const slot = table + idx * 8n;
        const d = mem.get(slot) ?? 0n;
        if (l.level === leafLevel) {
          if ((d & DESC.VALID) !== 0n) {
            ok = false;
          } else {
            const type = leafLevel === 3 ? 3n : 1n;
            mem.set(slot, out | B(m.attrs.lo) | B(m.attrs.hi) | type);
          }
          break;
        }
        if ((d & DESC.VALID) === 0n) {
          const t = next;
          next += page;
          tables.push(t);
          mem.set(slot, t | 3n);
          table = t;
        } else if (descKind(d, l.level, geo.granule) === "table") {
          table = descAddress(d, geo.shift);
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) conflicts++;
      cur += sz;
      out += sz;
    }
    if (conflicts > 0) {
      notes.push(`${m.name}: ${hex(vaDown)} is already mapped by an earlier entry at this granule, so it keeps that mapping.`);
    }
  }
  return { root, tables, notes, mem };
}

// ---------------------------------------------------------------------------------------------
// The machine: chapter 05's memory map (course/captures/05-dry-run.txt, 64 MiB of RAM)

/** Region kinds, as crates/vmm/src/arch/layout.rs names them. */
export const MEMORY_MAP = Object.freeze([
  { name: "flash0", base: 0x0000_0000n, size: 0x0400_0000n, kind: "Rom" },
  { name: "flash1", base: 0x0400_0000n, size: 0x0400_0000n, kind: "Rom" },
  { name: "gicd", base: 0x0800_0000n, size: 0x0001_0000n, kind: "GicDist" },
  { name: "gicv2-cpu", base: 0x0801_0000n, size: 0x0001_0000n, kind: "Reserved" },
  { name: "gic-v2m", base: 0x0802_0000n, size: 0x0001_0000n, kind: "GicMsi" },
  { name: "gic-its", base: 0x0808_0000n, size: 0x0002_0000n, kind: "Reserved" },
  { name: "gicr", base: 0x080a_0000n, size: 0x00f6_0000n, kind: "GicRedist" },
  { name: "pl011", base: 0x0900_0000n, size: 0x0000_1000n, kind: "Mmio" },
  { name: "pl031", base: 0x0901_0000n, size: 0x0000_1000n, kind: "Mmio" },
  { name: "fw-cfg", base: 0x0902_0000n, size: 0x0000_0018n, kind: "Reserved" },
  { name: "pl061", base: 0x0903_0000n, size: 0x0000_1000n, kind: "Reserved" },
  { name: "virtio-mmio", base: 0x0a00_0000n, size: 0x0000_4000n, kind: "Mmio" },
  { name: "testdev", base: 0x0b00_0000n, size: 0x0000_1000n, kind: "Mmio" },
  { name: "probe-hole", base: 0x0c00_0000n, size: 0x0200_0000n, kind: "Reserved" },
  { name: "pcie-mmio", base: 0x1000_0000n, size: 0x2eff_0000n, kind: "Reserved" },
  { name: "pcie-pio", base: 0x3eff_0000n, size: 0x0001_0000n, kind: "Reserved" },
  { name: "pcie-ecam", base: 0x3f00_0000n, size: 0x0100_0000n, kind: "Reserved" },
  { name: "ram", base: 0x4000_0000n, size: 0x0400_0000n, kind: "Ram" },
]);

export const RAM_BASE = 0x4000_0000n;
export const RAM_SIZE = 0x0400_0000n; // --mem 64M, as in every chapter-05 capture

/** The region holding `ipa`, or null. */
export function regionAt(ipa) {
  const a = B(ipa);
  return MEMORY_MAP.find((r) => a >= r.base && a < r.base + r.size) ?? null;
}

// Illustrative host addresses. HVF never tells a VMM where its stage-2 tables or the host pages
// behind guest RAM live; these values only make the arithmetic visible.
export const HOST_RAM = 0x2_8000_0000n;
export const HOST_UART_PAGE = 0x2_7fff_0000n;
export const HOST_TABLES = 0x1_0000_0000n;
/** Host physical address size used for stage-2 address-size checks (illustrative). */
export const HOST_PA_BITS = 40;
/**
 * The physical address size the guest's CPU reports (ID_AA64MMFR0_EL1.PARange), illustrative:
 * 42 bits, enough for the largest IPA size the lab offers. With the MMU off, an address at or
 * above 2^GUEST_PA_BITS takes a stage-1 address size fault before stage 2 sees it.
 */
export const GUEST_PA_BITS = 42;

// ---------------------------------------------------------------------------------------------
// Scenarios

/** The test guests' stage-1 map (guests/common/mmu.rs), in the order that file installs it. */
const TEST_GUEST_MAPPINGS = Object.freeze([
  { name: "RAM", va: 0x4000_0000n, oa: 0x4000_0000n, size: 1n << 30n, attrs: S1_NORMAL },
  { name: "RAM code alias", va: 0x8000_0000n, oa: 0x4000_0000n, size: 1n << 30n, attrs: S1_NORMAL },
  { name: "UART and RTC", va: 0x0900_0000n, oa: 0x0900_0000n, size: 2n << 20n, attrs: S1_DEVICE },
  { name: "test device", va: 0x0b00_0000n, oa: 0x0b00_0000n, size: 0x1000n, attrs: S1_DEVICE },
  { name: "test device alias", va: 0x0b10_0000n, oa: 0x0b00_0000n, size: 0x1000n, attrs: S1_DEVICE },
  { name: "UART alias", va: 0x0b10_1000n, oa: 0x0900_0000n, size: 0x1000n, attrs: S1_DEVICE },
]);

/** TCR_EL1 the test guests write (mmu.rs): T0SZ, IRGN0/ORGN0 = 01, SH0 = 11, TG0, EPD1, IPS. */
export function tcrValue({ t0sz, granule, ipsBits }) {
  const tg0 = granule === 4 ? 0n : 2n;
  const ips = { 32: 0n, 36: 1n, 40: 2n, 42: 3n, 44: 4n, 48: 5n }[ipsBits];
  return B(t0sz) | (1n << 8n) | (1n << 10n) | (3n << 12n) | (tg0 << 14n) | (1n << 23n) | (ips << 32n);
}

export const SCENARIOS = Object.freeze({
  toy: Object.freeze({
    label: "Test guest's tables (chapter 05)",
    about:
      "The three-level table every test guest builds in guests/common/mmu.rs: 39-bit addresses, so the walk starts at level 1. RAM is one 1 GiB block, the UART a 2 MiB block, the test device and two aliases single pages.",
    defaultMode: "both",
    t0sz: 25,
    ipsBits: 36,
    mair: 0xff00n, // attr0 Device-nGnRnE, attr1 Normal write-back
    root: { 4: 0x4008_4000n, 16: 0x4008_4000n },
    mappings: TEST_GUEST_MAPPINGS,
    defaultAddr: 0x0b10_0000n,
    examples: [
      { addr: 0x0b10_0000n, label: "0x0b10_0000: the test device's alias (the va-alias capture)" },
      { addr: 0x0b10_1000n, label: "0x0b10_1000: the UART's alias (walk it on paper first)" },
      { addr: 0x4000_1234n, label: "0x4000_1234: RAM, through a 1 GiB block" },
      { addr: 0x0900_0000n, label: "0x0900_0000: the UART, through a 2 MiB block" },
      { addr: 0x0b00_0000n, label: "0x0b00_0000: the test device, identity" },
      { addr: 0x8008_108cn, label: "0x8008_108c: RAM through the code alias" },
      { addr: 0x0c00_0000n, label: "0x0c00_0000: not in the guest's tables" },
      { addr: 0x80_0000_0000n, label: "0x80_0000_0000: past the 39-bit range" },
    ],
  }),
  worked: Object.freeze({
    label: "Worked example (page-tables primer)",
    about:
      "The page-tables primer's four-level walk, already filled in: 48-bit addresses, TTBR0_EL1 = 0x4010_0000, one 4 KiB page at 0x4123_4000.",
    defaultMode: "s1",
    t0sz: 16,
    ipsBits: 36,
    mair: 0x0044_04ffn,
    root: { 4: 0x4010_0000n, 16: 0x4010_0000n },
    mappings: Object.freeze([{ name: "the primer's page", va: 0x80_8060_4000n, oa: 0x4123_4000n, size: 0x1000n, attrs: S1_WORKED }]),
    defaultAddr: 0x80_8060_4567n,
    examples: [
      { addr: 0x80_8060_4567n, label: "0x80_8060_4567: the primer's load" },
      { addr: 0x80_8060_5567n, label: "0x80_8060_5567: the next page (not mapped)" },
    ],
  }),
  block: Object.freeze({
    label: "Worked example with a 2 MiB block",
    about: "The primer's variant: the level-2 entry is the block 0x0060_0000_4120_0701, so the walk stops one level early.",
    defaultMode: "s1",
    t0sz: 16,
    ipsBits: 36,
    mair: 0x0044_04ffn,
    root: { 4: 0x4010_0000n, 16: 0x4010_0000n },
    mappings: Object.freeze([{ name: "the primer's block", va: 0x80_8060_0000n, oa: 0x4120_0000n, size: 2n << 20n, attrs: S1_WORKED }]),
    defaultAddr: 0x80_8060_4567n,
    examples: [{ addr: 0x80_8060_4567n, label: "0x80_8060_4567: the primer's load" }],
  }),
});

export const MODES = Object.freeze({
  s1: "Bare metal: stage 1 only, no VM",
  both: "Guest MMU on: stage 1, then stage 2",
  s2: "Guest MMU off: VA = IPA, stage 2 only",
});

/** Examples for stage-2-only mode (MMU off), from the chapter 05 captures. */
export const S2_EXAMPLES = Object.freeze([
  { addr: 0x0c00_0000n, label: "0x0c00_0000: the probe hole (mmio-poke)" },
  { addr: 0x10_0000_0000n, label: "0x10_0000_0000: one past a 36-bit IPA space (ipa-poke)" },
  { addr: 0x0b00_0000n, label: "0x0b00_0000: the test device window" },
  { addr: 0x0900_0000n, label: "0x0900_0000: the UART" },
  { addr: 0x4008_0000n, label: "0x4008_0000: RAM, where the guest is loaded" },
  { addr: 0x0800_0000n, label: "0x0800_0000: the GIC distributor" },
]);

// ---------------------------------------------------------------------------------------------
// State

export const ACCESS_SIZES = Object.freeze([1, 2, 4, 8]);
export const IPA_SIZES = Object.freeze([36, 40, 42]);

/** The default state: chapter 05's va-alias store, `str w9, [x8]` with x8 = 0x0b10_0000. */
export function initialState(scenario = "toy") {
  const key = own(SCENARIOS, scenario) ? scenario : "toy";
  const sc = SCENARIOS[key];
  return {
    scenario: key,
    mode: sc.defaultMode,
    addr: sc.defaultAddr,
    g1: 4,
    g2: 16,
    ipaBits: 36,
    access: { write: true, size: 4, rt: 9, el: 1 },
    uartRam: false,
    edits: [], // [{ stage: 1 | 2, addr: BigInt, value: BigInt }]
    cursor: 0, // how many timeline entries are revealed: a walk starts unrevealed, one Step at a time
    predict: false,
    selected: null, // { stage, addr }
  };
}

/** Pure state transitions. Unknown actions return the state unchanged. */
export function step(state, action) {
  const s = state;
  switch (action.type) {
    case "scenario": {
      if (!own(SCENARIOS, action.value)) return s;
      return { ...initialState(action.value), g1: s.g1, g2: s.g2, ipaBits: s.ipaBits, access: s.access, predict: s.predict, cursor: 0 };
    }
    case "mode":
      if (!own(MODES, action.value)) return s;
      return { ...s, mode: action.value, cursor: 0, selected: null };
    case "addr":
      return { ...s, addr: B(action.value) & U64, cursor: 0 };
    case "g1":
      if (!own(GRANULES, action.value)) return s;
      return { ...s, g1: action.value, edits: s.edits.filter((e) => e.stage !== 1), selected: null, cursor: 0 };
    case "g2":
      if (!own(GRANULES, action.value)) return s;
      return { ...s, g2: action.value, edits: s.edits.filter((e) => e.stage !== 2), selected: null };
    case "ipaBits":
      if (!IPA_SIZES.includes(action.value)) return s;
      return { ...s, ipaBits: action.value, edits: s.edits.filter((e) => e.stage !== 2), selected: null };
    case "access": {
      const a = { ...s.access, ...action.value };
      if (!ACCESS_SIZES.includes(a.size) || !(a.rt >= 0 && a.rt <= 30) || !(a.el === 0 || a.el === 1)) return s;
      return { ...s, access: { write: !!a.write, size: a.size, rt: a.rt | 0, el: a.el } };
    }
    case "uartRam":
      return { ...s, uartRam: !!action.value, edits: s.edits.filter((e) => e.stage !== 2) };
    case "edit": {
      const stage = action.stage === 2 ? 2 : 1;
      const addr = B(action.addr) & ~7n & mask(48);
      const value = B(action.value) & U64;
      const edits = s.edits.filter((e) => !(e.stage === stage && e.addr === addr));
      if (edits.length >= MAX_EDITS) return s;
      edits.push({ stage, addr, value });
      return { ...s, edits };
    }
    case "revert":
      return { ...s, edits: [] };
    case "select":
      if (!action.value) return { ...s, selected: null };
      return {
        ...s,
        selected: { stage: action.value.stage === 2 ? 2 : 1, addr: B(action.value.addr) & ~7n & mask(48), level: [0, 1, 2, 3].includes(action.value.level) ? action.value.level : 3 },
      };
    case "predict":
      return { ...s, predict: !!action.value, cursor: action.value ? 0 : s.cursor };
    case "next": {
      const n = action.span === 2 ? 2 : 1;
      return { ...s, cursor: Math.min(action.total, Math.min(s.cursor, action.total) + n) };
    }
    case "back": {
      const n = action.span === 2 ? 2 : 1;
      return { ...s, cursor: Math.max(0, Math.min(s.cursor, action.total) - n) };
    }
    case "all":
      return { ...s, cursor: Number.MAX_SAFE_INTEGER };
    case "restart":
      return { ...s, cursor: 0 };
    case "reset":
      return initialState(s.scenario);
    default:
      return s;
  }
}

export const MAX_EDITS = 64;

// ---------------------------------------------------------------------------------------------
// World: the tables a state implies

/**
 * Build both stages' configuration and memories for `state`. Guest memory is keyed by IPA
 * (stage-1 tables live in guest RAM); host memory holds HVF's stage-2 tables. Unwritten words
 * read as zero, like fresh RAM.
 */
export function buildWorld(state) {
  const sc = own(SCENARIOS, state.scenario) ? SCENARIOS[state.scenario] : SCENARIOS.toy;
  const inBits1 = 64 - sc.t0sz;
  const geo1 = geometry(state.g1, inBits1);
  const guestMem = new Map();
  const s1 = buildTables({ geo: geo1, root: sc.root[state.g1], mappings: sc.mappings, policy: "largest", mem: guestMem });

  const geo2 = geometry(state.g2, state.ipaBits);
  const hostMem = new Map();
  const s2Maps = [{ name: "guest RAM", va: RAM_BASE, oa: HOST_RAM, size: RAM_SIZE, attrs: S2_RAM }];
  if (state.uartRam) s2Maps.push({ name: "RAM page at the UART", va: 0x0900_0000n, oa: HOST_UART_PAGE, size: 0x4000n, attrs: S2_RAM });
  const s2 = buildTables({ geo: geo2, root: HOST_TABLES, mappings: s2Maps, policy: "pages", mem: hostMem });

  for (const e of state.edits) (e.stage === 1 ? guestMem : hostMem).set(e.addr, e.value);

  return {
    scenario: sc,
    s1: { geo: geo1, root: s1.root, tables: s1.tables, notes: s1.notes, mem: guestMem, ipsBits: sc.ipsBits, mair: sc.mair, tcr: tcrValue({ t0sz: sc.t0sz, granule: state.g1, ipsBits: sc.ipsBits }) },
    s2: { geo: geo2, root: s2.root, tables: s2.tables, notes: s2.notes, mem: hostMem, paBits: HOST_PA_BITS },
  };
}

/** Read the 8-byte word at `addr` of `mem` (zero when never written). */
export function readWord(mem, addr) {
  return mem.get(B(addr)) ?? 0n;
}

// ---------------------------------------------------------------------------------------------
// Walks

export const FAULT_DFSC_BASE = Object.freeze({ "address-size": 0x00, translation: 0x04, "access-flag": 0x08, permission: 0x0c });

export const FAULT_NAMES = Object.freeze({
  "address-size": "address size fault",
  translation: "translation fault",
  "access-flag": "access flag fault",
  permission: "permission fault",
  alignment: "alignment fault",
});

/** The fault status code (DFSC) for a fault kind at `level` (ESR_ELx ISS[5:0], D17.2.40). */
export function dfscFor(kind, level) {
  return FAULT_DFSC_BASE[kind] + level;
}

/**
 * Stage-2 walk of `ipa` (HVF's tables). `access`: `{ write, tableWalk }`. Returns
 * `{ ok, out, level, size, desc, steps, fault, reads }`.
 */
export function walkStage2(world, ipa, access) {
  const { geo, root, mem, paBits } = world.s2;
  const res = { stage: 2, input: B(ipa), steps: [], reads: 0, ok: false, fault: null };
  if (B(ipa) >> B(geo.inBits) !== 0n) {
    res.fault = { kind: "translation", level: 0, why: `The IPA is wider than the VM's ${geo.inBits}-bit IPA space, so no table can hold it: the walk fails before reading anything.` };
    return res;
  }
  let table = root;
  for (const l of geo.levels) {
    const index = Number(field(B(ipa), l.lo, l.bits));
    const descAddr = table + B(index) * 8n;
    const desc = readWord(mem, descAddr);
    res.reads++;
    const kind = descKind(desc, l.level, geo.granule);
    const stepRec = { level: l.level, lo: l.lo, hi: l.hi, bits: l.bits, tableBase: table, index, descAddr, desc, kind };
    res.steps.push(stepRec);
    if (kind === "invalid" || kind === "reserved") {
      res.fault = { kind: "translation", level: l.level, why: kind === "invalid" ? `Stage-2 level ${l.level} entry ${hexSmall(index)} is invalid: nothing is mapped here.` : `Stage-2 level ${l.level} entry ${hexSmall(index)} uses a type this level does not allow.` };
      return res;
    }
    if (kind === "table") {
      const next = descAddress(desc, geo.shift);
      if (desc & (mask(48) & ~mask(paBits))) {
        res.fault = { kind: "address-size", level: l.level, why: "The next-table address is wider than the host's physical address size." };
        return res;
      }
      stepRec.next = next;
      table = next;
      continue;
    }
    // Leaf.
    const out = descAddress(desc, l.lo);
    if (desc & (mask(48) & ~mask(paBits))) {
      res.fault = { kind: "address-size", level: l.level, why: "The output address is wider than the host's physical address size." };
      return res;
    }
    if ((desc & DESC.AF) === 0n) {
      res.fault = { kind: "access-flag", level: l.level, why: "The stage-2 access flag is 0. HVF sets it on every page it maps; it is clear here only because you cleared it." };
      return res;
    }
    const s2ap = Number(field(desc, 6, 2));
    const write = !!access.write && !access.tableWalk;
    if ((write && !(s2ap & 2)) || (!write && !(s2ap & 1))) {
      res.fault = { kind: "permission", level: l.level, why: `S2AP = ${s2ap.toString(2).padStart(2, "0")} (${S2_AP[s2ap]}) forbids this ${write ? "write" : "read"}.` };
      return res;
    }
    const size = ONE << B(l.lo);
    res.ok = true;
    res.level = l.level;
    res.size = size;
    res.desc = desc;
    res.out = out | (B(ipa) & (size - ONE));
    stepRec.out = res.out;
    return res;
  }
  res.fault = { kind: "translation", level: 3, why: "No leaf found." };
  return res;
}

/**
 * Stage-1 walk of `va` (the guest's tables, TTBR0 half). In "both" mode each descriptor
 * address goes through `walkStage2` first. Returns `{ ok, out, level, size, desc, steps,
 * fault, reads }`; a stage-2 failure on a table read is `fault.s1ptw = true`.
 */
export function walkStage1(world, va, access, viaStage2) {
  const { geo, root, mem, ipsBits, mair } = world.s1;
  const res = { stage: 1, input: B(va), steps: [], reads: 0, ok: false, fault: null };
  const v = B(va);
  if (field(v, 55, 1) === 1n) {
    res.fault = { kind: "translation", level: 0, why: "Bit 55 is set, so this VA belongs to the upper half (TTBR1_EL1), and the guest disabled walks there (TCR_EL1.EPD1 = 1)." };
    return res;
  }
  if (v >> B(geo.inBits) !== 0n) {
    res.fault = { kind: "translation", level: 0, why: `The VA has bits set above bit ${geo.inBits - 1}; with T0SZ = ${64 - geo.inBits} the lower half is only ${geo.inBits} bits wide, so the walk fails before reading anything.` };
    return res;
  }
  let table = root & mask(48) & ~mask(levelInfo(geo, geo.startLevel).bits + 3);
  let noWrite = false;
  let noEl0 = false;
  for (const l of geo.levels) {
    const index = Number(field(v, l.lo, l.bits));
    const descAddr = table + B(index) * 8n;
    const stepRec = { level: l.level, lo: l.lo, hi: l.hi, bits: l.bits, tableBase: table, index, descAddr, desc: null, kind: "blocked" };
    res.steps.push(stepRec);
    if (viaStage2) {
      const nested = walkStage2(world, descAddr, { write: false, tableWalk: true });
      stepRec.nested = nested;
      res.reads += nested.reads;
      if (!nested.ok) {
        res.fault = { ...nested.fault, stage: 2, s1ptw: true, ipa: descAddr, level: nested.fault.level, why: `Before it can read the level-${l.level} descriptor, the hardware translates its address, IPA ${hex(descAddr)}, through stage 2, and that fails. ${nested.fault.why}` };
        return res;
      }
    }
    const desc = readWord(mem, descAddr);
    res.reads++;
    const kind = descKind(desc, l.level, geo.granule);
    stepRec.desc = desc;
    stepRec.kind = kind;
    if (kind === "invalid" || kind === "reserved") {
      res.fault = { kind: "translation", level: l.level, why: kind === "invalid" ? `Level ${l.level} entry ${hexSmall(index)} is invalid (bit 0 is 0).` : `Level ${l.level} entry ${hexSmall(index)} is a block where this granule allows none.` };
      return res;
    }
    if (kind === "table") {
      const next = descAddress(desc, geo.shift);
      if (desc & (mask(48) & ~mask(ipsBits))) {
        res.fault = { kind: "address-size", level: l.level, why: `The next-table address ${hex(next)} is wider than TCR_EL1.IPS allows (${ipsBits} bits).` };
        return res;
      }
      if (desc & DESC.APTABLE_NO_WRITE) noWrite = true;
      if (desc & DESC.APTABLE_NO_EL0) noEl0 = true;
      stepRec.next = next;
      table = next;
      continue;
    }
    const out = descAddress(desc, l.lo);
    if (desc & (mask(48) & ~mask(ipsBits))) {
      res.fault = { kind: "address-size", level: l.level, why: `The output address ${hex(out)} is wider than TCR_EL1.IPS allows (${ipsBits} bits).` };
      return res;
    }
    if ((desc & DESC.AF) === 0n) {
      res.fault = { kind: "access-flag", level: l.level, why: "The access flag is 0, so the first access faults and the kernel learns the page was used." };
      return res;
    }
    const ap = Number(field(desc, 6, 2));
    const readOnly = (ap & 2) !== 0 || noWrite;
    const el0ok = (ap & 1) !== 0 && !noEl0;
    if (access.el === 0 && !el0ok) {
      res.fault = { kind: "permission", level: l.level, why: noEl0 && (ap & 1) ? "A table above set APTable to forbid EL0." : `AP = ${ap.toString(2).padStart(2, "0")}: EL0 may not touch this page.` };
      return res;
    }
    if (access.write && readOnly) {
      res.fault = { kind: "permission", level: l.level, why: noWrite && !(ap & 2) ? "A table above set APTable to forbid writes." : `AP = ${ap.toString(2).padStart(2, "0")}: the page is read-only.` };
      return res;
    }
    const size = ONE << B(l.lo);
    res.ok = true;
    res.level = l.level;
    res.size = size;
    res.desc = desc;
    res.out = out | (v & (size - ONE));
    const attr = Number(field(B(mair), Number(field(desc, 2, 3)) * 8, 8));
    res.memType = mairName(attr);
    stepRec.out = res.out;
    return res;
  }
  res.fault = { kind: "translation", level: 3, why: "No leaf found." };
  return res;
}

// ---------------------------------------------------------------------------------------------
// Syndromes (ESR_ELx, D17.2.40) and the whole translation

/**
 * Encode a data-abort ESR. Fields are numbers; returns an unsigned 32-bit number.
 * EC[31:26] IL[25] ISV[24] SAS[23:22] SSE[21] SRT[20:16] SF[15] AR[14] FnV[10] EA[9] CM[8]
 * S1PTW[7] WnR[6] DFSC[5:0].
 */
export function encodeDataAbort({ ec, il = 1, isv = 0, sas = 0, sse = 0, srt = 0, sf = 0, ar = 0, fnv = 0, ea = 0, cm = 0, s1ptw = 0, wnr = 0, dfsc }) {
  return (
    (((ec & 0x3f) << 26) |
      ((il & 1) << 25) |
      ((isv & 1) << 24) |
      ((sas & 3) << 22) |
      ((sse & 1) << 21) |
      ((srt & 0x1f) << 16) |
      ((sf & 1) << 15) |
      ((ar & 1) << 14) |
      ((fnv & 1) << 10) |
      ((ea & 1) << 9) |
      ((cm & 1) << 8) |
      ((s1ptw & 1) << 7) |
      ((wnr & 1) << 6) |
      (dfsc & 0x3f)) >>>
    0
  );
}

/** The instruction an access stands for: `str w9, [x8]`, `ldrb w3, [x8]`, `ldr x0, [x8]`. */
export function accessInsn(access) {
  const op = access.write ? "str" : "ldr";
  const suffix = access.size === 1 ? "b" : access.size === 2 ? "h" : "";
  const reg = access.size === 8 ? "x" : "w";
  return `${op}${suffix} ${reg}${access.rt}, [x8]`;
}

const SAS = { 1: 0, 2: 1, 4: 2, 8: 3 };

/** Who prints the `esr=... ipa=...` line: the unmodified reference, or the reader's chapter-05 VMM. */
export const REF_LINE = "As the reference VMM prints it";
export const CH05_LINE = "As your chapter-05 VMM prints it (the finished reference has a device here and does not stop)";

/**
 * What the VMM does with a stage-2 translation fault at `ipa` (layout.rs region kinds; chapter
 * 05's policy). `inHvf` marks the in-kernel GIC windows, whose aborts HVF handles without an
 * exit; `lineBy` says whose output the `esr=... ipa=...` line stands for (null: no line).
 */
export function vmmReaction(ipa, access) {
  const r = regionAt(ipa);
  const dir = access.write ? "write" : "read";
  const unhandled = `unhandled MMIO ${dir} at ${hexRaw(ipa)} size ${access.size}`;
  if (!r) return { region: null, lineBy: REF_LINE, text: `No region of the map holds this IPA. The reference stops: "${unhandled}", exit code 3.` };
  switch (r.kind) {
    case "GicDist":
    case "GicRedist":
    case "GicMsi":
      return {
        region: r,
        inHvf: true,
        lineBy: null,
        text: `${r.name} is a window of HVF's in-kernel GIC (the interrupt controller, chapter 12). The hardware still takes the stage-2 abort to EL2, so the ESR_EL2 and HPFAR_EL2 values above are real, but HVF handles the access itself: no exit reaches our VMM and nothing is printed.`,
      };
    case "Rom":
      return { region: r, lineBy: REF_LINE, text: `${r.name} is flash, mapped read-only only when firmware is loaded (chapter 21). This run has none, so it is a hole: "${unhandled}", exit code 3.` };
    case "Ram":
      return { region: r, lineBy: REF_LINE, text: `${r.name} should be mapped; reaching here means a stage-2 entry was changed.` };
    case "Mmio":
      if (r.name === "testdev")
        return { region: r, lineBy: REF_LINE, text: `testdev is a device window the map reserves; in chapter 05 nothing is behind it, so the reference stops: "${unhandled}", exit code 3.` };
      return {
        region: r,
        lineBy: CH05_LINE,
        text: `${r.name} is a device window: every access exits to the VMM, whose device model plays the register (the finished reference already has one here; the UART is built in chapter 09). Your chapter-05 VMM, with no device model there yet, stops: "${unhandled}", exit code 3.`,
      };
    default:
      return { region: r, lineBy: REF_LINE, text: `${r.name} is a hole left on purpose and never populated: "${unhandled}", exit code 3.` };
  }
}

/**
 * Translate `state.addr` in `state.mode` with `world` (from `buildWorld`). Returns
 * `{ mode, va, s1, ipa, s2, pa, outcome, timeline, reads }`. `timeline` is the order the view
 * reveals things in: `{ ref: "s1n", i }` (stage 2 translating stage-1 table i's address),
 * `{ ref: "s1", i }`, `{ ref: "s2", i }`, then `{ ref: "end" }`.
 */
export function translate(state, world) {
  const access = state.access;
  const mode = state.mode;
  const addr = B(state.addr) & U64;
  const out = { mode, va: addr, s1: null, ipa: null, s2: null, pa: null, outcome: null, timeline: [], reads: 0 };

  if (mode === "s1" || mode === "both") {
    const s1 = walkStage1(world, addr, access, mode === "both");
    out.s1 = s1;
    out.reads += s1.reads;
    s1.steps.forEach((st, i) => {
      if (st.nested) out.timeline.push({ ref: "s1n", i });
      if (st.desc !== null) out.timeline.push({ ref: "s1", i });
    });
    if (!s1.ok) {
      out.outcome = s1.fault.s1ptw ? stage2Outcome(state, addr, s1.fault.ipa, s1.fault, true) : stage1Outcome(state, addr, s1.fault);
      out.timeline.push({ ref: "end" });
      return out;
    }
    out.ipa = s1.out;
    // Device memory must be aligned (SCTLR_EL1.A = 0 lets Normal memory be misaligned). The
    // check uses stage 1's memory type, so it comes before stage 2 is consulted.
    if (isDevice(s1.memType) && addr % B(access.size) !== 0n) {
      out.outcome = alignmentOutcome(state, addr, `${s1.memType} memory`);
      out.timeline.push({ ref: "end" });
      return out;
    }
    if (mode === "s1") {
      out.pa = s1.out;
      out.outcome = { kind: "ok", stage: 1, summary: `OK: VA ${hex(addr)} is PA ${hex(s1.out)} (${s1.memType}). ${s1.reads} memory reads for the walk.`, memType: s1.memType };
      out.timeline.push({ ref: "end" });
      return crossCheck(state, world, out);
    }
  } else {
    // MMU off: VA = IPA, but first the CPU checks the address fits its physical address size.
    if (addr >> B(GUEST_PA_BITS) !== 0n) {
      out.outcome = stage1Outcome(state, addr, {
        kind: "address-size",
        level: 0,
        why: `With the MMU off the address is used as a physical address, and it has bits set at or above bit ${GUEST_PA_BITS}, the physical address size this lab's CPU reports (ID_AA64MMFR0_EL1.PARange). Stage 2 never sees it.`,
      });
      out.timeline.push({ ref: "end" });
      return out;
    }
    if (addr % B(access.size) !== 0n) {
      out.outcome = alignmentOutcome(state, addr, "Device-nGnRnE memory (every data access is, while the MMU is off)");
      out.timeline.push({ ref: "end" });
      return out;
    }
    out.ipa = addr;
  }

  const s2 = walkStage2(world, out.ipa, { write: access.write, tableWalk: false });
  out.s2 = s2;
  out.reads += s2.reads;
  s2.steps.forEach((_, i) => out.timeline.push({ ref: "s2", i }));
  out.timeline.push({ ref: "end" });
  if (!s2.ok) {
    out.outcome = stage2Outcome(state, addr, out.ipa, s2.fault, false);
    return out;
  }
  out.pa = s2.out;
  const extra = s2.out >= HOST_UART_PAGE && s2.out < HOST_UART_PAGE + 0x4000n;
  const where = extra
    ? "a page of RAM that sits where the UART should be. No exit: the VMM never learns of the access, and nothing is printed (chapter 05's Predict)."
    : "guest RAM. No exit: the access completes in hardware.";
  const memType = out.s1 ? out.s1.memType : "Device-nGnRnE, since the MMU is off";
  out.outcome = {
    kind: "ok",
    stage: 2,
    memType,
    summary: `OK: ${mode === "both" ? `VA ${hex(addr)} is IPA ${hex(out.ipa)}, and ` : `IPA ${hex(out.ipa)} `}reaches host address ${hex(s2.out)} in ${where} ${out.reads} memory reads in all.`,
  };
  return crossCheck(state, world, out);
}

/** True for a Device memory type name (mairName / S2_MEMATTR spellings). */
function isDevice(memType) {
  return typeof memType === "string" && memType.startsWith("Device");
}

/**
 * An access that succeeded for its first byte but runs into the next page (only possible on
 * Normal memory, which may be misaligned) is translated again for that page. If the second page
 * fails, that failure is the outcome. Pages here are the smaller of the two granules.
 */
function crossCheck(state, world, out) {
  const size = B(state.access.size);
  const addr = out.va;
  const p1 = world.s1.geo.pageBytes;
  const p2 = world.s2.geo.pageBytes;
  const page = state.mode === "s1" ? p1 : state.mode === "s2" ? p2 : p1 < p2 ? p1 : p2;
  const next = (addr | (page - ONE)) + ONE;
  if (addr + size <= next || next > U64) return out;
  // `next` is page-aligned, so the second translation cannot cross again.
  const second = translate({ ...state, addr: next }, world);
  const lead = `This ${state.access.size}-byte access starts at ${hex(addr)} and runs into the next ${sizeText(page)} page at ${hex(next)}, so the CPU translates that page too.`;
  out.crosses = { next, page, second };
  if (second.outcome.kind === "ok") {
    out.outcome = { ...out.outcome, summary: `${out.outcome.summary} ${lead} It is mapped as well.` };
    return out;
  }
  // The fault belongs to the second page; FAR/HPFAR report its first byte (the architecture lets
  // an implementation report another byte of the access inside that page).
  const o = second.outcome;
  out.outcome = { ...o, summary: `${lead} That page fails. ${o.summary}`, crossed: true };
  return out;
}

/** A stage-1 alignment fault (DFSC 0x21): misaligned access to Device memory. */
function alignmentOutcome(state, va, what) {
  const a = state.access;
  const ec = a.el === 1 ? 0x25 : 0x24;
  const dfsc = 0x21;
  const esr = encodeDataAbort({ ec, il: 1, isv: 0, wnr: a.write ? 1 : 0, dfsc });
  const vm = state.mode !== "s1";
  return {
    kind: "s1-fault",
    stage: 1,
    fault: { kind: "alignment", level: null, why: `${hex(va)} is not a multiple of the access size, ${a.size} bytes, and the target is ${what}, which only accepts aligned accesses.` },
    dfsc,
    regs: [
      { name: "ESR_EL1", value: hex(esr), raw: esr, note: `EC ${hexSmall(ec)} (data abort from ${a.el === 1 ? "the same level, EL1" : "EL0"}), DFSC 0x21: alignment fault` },
      { name: "FAR_EL1", value: hex(va), note: "the faulting virtual address" },
    ],
    esr,
    summary: `Alignment fault: ${hex(va)} is not a multiple of ${a.size}, and the target is ${what}. The CPU raises it at stage 1, before stage 2 is consulted; the exception goes to the guest kernel at EL1 (VBAR_EL1)${vm ? ", and HVF and our VMM never see it" : ""}.`,
  };
}

function stage1Outcome(state, va, fault) {
  const a = state.access;
  const dfsc = dfscFor(fault.kind, fault.level);
  const ec = a.el === 1 ? 0x25 : 0x24;
  const esr = encodeDataAbort({ ec, il: 1, isv: 0, wnr: a.write ? 1 : 0, dfsc });
  const vm = state.mode !== "s1";
  const name = `${FAULT_NAMES[fault.kind]}, level ${fault.level}`;
  return {
    kind: "s1-fault",
    stage: 1,
    fault,
    dfsc,
    regs: [
      { name: "ESR_EL1", value: hex(esr), raw: esr, note: `EC ${hexSmall(ec)} (data abort from ${a.el === 1 ? "the same level, EL1" : "EL0"}), DFSC ${hexSmall(dfsc)}: ${name}` },
      { name: "FAR_EL1", value: hex(va), note: "the faulting virtual address" },
    ],
    esr,
    summary: `Stage 1 fails: ${name}. ${fault.why} The exception goes to the guest kernel at EL1 (VBAR_EL1); ${vm ? "HVF and our VMM never see it" : "there is no hypervisor"}.`,
  };
}

function stage2Outcome(state, va, ipa, fault, s1ptw) {
  const a = state.access;
  const dfsc = dfscFor(fault.kind, fault.level);
  const esr = s1ptw
    ? encodeDataAbort({ ec: 0x24, il: 1, isv: 0, s1ptw: 1, wnr: 0, dfsc })
    : encodeDataAbort({ ec: 0x24, il: 1, isv: 1, sas: SAS[a.size], srt: a.rt, sf: a.size === 8 ? 1 : 0, wnr: a.write ? 1 : 0, dfsc });
  // HPFAR_EL2.FIPA is bits [39:4] = IPA[47:12] without FEAT_LPA (D19.2).
  const hpfar = ((B(ipa) >> 12n) << 4n) & (mask(40) & ~0xfn);
  const name = `${FAULT_NAMES[fault.kind]}, level ${fault.level}`;
  const reaction = s1ptw
    ? { region: regionAt(ipa), lineBy: null, text: "S1PTW = 1: the IPA is the page of the guest's own table, not of the data. The guest pointed its page tables outside RAM; a VMM must not emulate a device access here." }
    : fault.kind === "translation"
      ? vmmReaction(ipa, a)
      : { region: regionAt(ipa), lineBy: REF_LINE, text: "The page is mapped, but its stage-2 entry forbids this access (you changed it). A VMM that write-protects RAM on purpose, for dirty tracking in chapter 26, sees exactly this exit." };
  const regs = [
    {
      name: "ESR_EL2",
      value: hex(esr),
      raw: esr,
      note: s1ptw
        ? `EC 0x24, ISV=0, S1PTW=1, DFSC ${hexSmall(dfsc)}: ${name} on a table read`
        : `EC 0x24 (data abort from a lower level), ISV=1, SAS=${SAS[a.size]}, SRT=${a.rt}, WnR=${a.write ? 1 : 0}, DFSC ${hexSmall(dfsc)}: ${name}`,
    },
    { name: "FAR_EL2", value: hex(va), note: state.mode === "both" ? "the guest's virtual address: meaningful only inside the guest" : "the virtual address (equal to the IPA: the MMU is off)" },
    { name: "HPFAR_EL2", value: hex(hpfar), note: `FIPA, bits [39:4] = IPA[47:12]: page ${hex(B(ipa) & ~0xfffn)}` },
  ];
  // Who sees the abort: HVF's in-kernel GIC windows never reach our VMM.
  const inHvf = !s1ptw && !!reaction.inHvf;
  const vmmLine = s1ptw || inHvf || !reaction.lineBy ? null : `esr=${hexRaw(esr)} ipa=${hexRaw(ipa)}`;
  return {
    kind: "s2-fault",
    stage: 2,
    s1ptw,
    inHvf,
    fault,
    dfsc,
    esr,
    ipa: B(ipa),
    hpfar,
    regs,
    vmmLine,
    vmmLineLabel: vmmLine ? reaction.lineBy : null,
    reaction,
    summary: inHvf
      ? `Stage-2 abort handled inside HVF (in-kernel GIC), no exit to the VMM: stage 2 has no entry here (${name}), so the hardware takes the abort to EL2, and HVF plays the GIC register itself.`
      : `VM exit: stage 2 fails, ${name}${s1ptw ? " while reading a stage-1 table" : ""}. ${fault.why}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Stepping: how far one Step or Back moves, and what to say about what it revealed

/**
 * How many timeline entries one Step (`dir` +1) or Back (-1) moves at `cursor`. In predict mode
 * a stage-2 translation of a table address (`s1n`) and the stage-1 read it serves are revealed
 * together, so the nested card cannot give away the descriptor address the reader is guessing.
 */
export function stepSpan(timeline, cursor, dir, predict) {
  if (!predict) return 1;
  const c = Math.max(0, Math.min(cursor, timeline.length));
  if (dir > 0) {
    const a = timeline[c];
    const b = timeline[c + 1];
    return a && a.ref === "s1n" && b && b.ref === "s1" && b.i === a.i ? 2 : 1;
  }
  const a = timeline[c - 2];
  const b = timeline[c - 1];
  return a && a.ref === "s1n" && b && b.ref === "s1" && b.i === a.i ? 2 : 1;
}

/** The wording of a nested (stage 2 for a stage-1 table read) card, shared by view and announcements. */
export function nestedText(stepRec) {
  const n = stepRec.nested;
  const lead = `Stage 2 first: the address of the level-${stepRec.level} descriptor, ${hex(stepRec.descAddr)}, is an IPA`;
  const path = n.steps.map((s) => `L${s.level}[${hexSmall(s.index)}]`).join(" then ");
  return n.ok
    ? `${lead}, so HVF's tables translate it (${path}) to host ${hex(n.out)}: ${n.reads} read${n.reads === 1 ? "" : "s"}.`
    : `${lead}, and HVF's tables do not map it (${path || "no table read"}): ${FAULT_NAMES[n.fault.kind]}, level ${n.fault.level}.`;
}

/** One line about a walk step, for the screen-reader announcement after Step or Back. */
export function stepLine(stage, stepRec) {
  const head = `Stage ${stage}, level ${stepRec.level}: index ${hexSmall(stepRec.index)}, read at ${hex(stepRec.descAddr)}`;
  if (stepRec.kind === "table") return `${head}, table descriptor, next table ${hex(stepRec.next ?? 0n)}.`;
  if (stepRec.kind === "block" || stepRec.kind === "page")
    return stepRec.out !== undefined ? `${head}, ${stepRec.kind} descriptor, output ${hex(stepRec.out)}.` : `${head}, ${stepRec.kind} descriptor, but the access is refused.`;
  return `${head}, ${stepRec.kind === "reserved" ? "a descriptor this level does not allow" : "invalid descriptor"}: the walk stops.`;
}

/** The announcement for timeline entry `t` of translation `r`. */
export function timelineText(r, t) {
  if (!t) return "";
  if (t.ref === "s1n") return nestedText(r.s1.steps[t.i]);
  if (t.ref === "s1") return stepLine(1, r.s1.steps[t.i]);
  if (t.ref === "s2") return stepLine(2, r.s2.steps[t.i]);
  return `Walk complete. ${r.outcome.summary}`;
}

/** What to announce after the cursor moved from `from` to `to`. */
export function stepAnnouncement(r, from, to) {
  const total = r.timeline.length;
  if (to <= 0) return `Back to the start: nothing read yet. Step 0 of ${total}.`;
  const parts = [];
  if (to > from) for (let k = from; k < to; k++) parts.push(timelineText(r, r.timeline[k]));
  else parts.push(`Back. Showing up to: ${timelineText(r, r.timeline[to - 1])}`);
  return `Step ${to} of ${total}. ${parts.join(" ")}`;
}

// ---------------------------------------------------------------------------------------------
// Where the lab starts: an embed's default, before any shared link

/**
 * The share string an embed starts from when the URL carries none. The page-tables primer
 * starts in bare-metal mode on its own worked example (its reader has not met stage 2 yet); the
 * page-granules primer starts on the test guest's tables with both stages on, at a RAM address
 * that succeeds, so the granule toggles show the index fields moving without a fault in the way.
 * Chapter 05 and the standalone page start at chapter 05's va-alias store.
 */
export function startHashFor({ pathname = "", standalone = false } = {}) {
  if (!standalone && typeof pathname === "string") {
    if (/\/primers\/page-tables\/?$/.test(pathname)) return "sc=worked;m=s1";
    if (/\/primers\/page-granules\/?$/.test(pathname)) return "sc=toy;m=both;a=40001234";
  }
  return null;
}

/** Plain names for the share-string keys, for the "not understood" note. */
const HASH_KEY_NAMES = Object.freeze({ sc: "tables", m: "mode", a: "address", g1: "stage-1 granule", g2: "stage-2 granule", ipa: "IPA size", acc: "access", e: "table edits", "too many edits": "table edits (too many)", "share string too long": "the whole link (too long)" });

/** The note shown when a shared link was partly malformed, without internal key names. */
export function hashErrorText(errors) {
  if (!errors || errors.length === 0) return null;
  const names = [...new Set(errors.map((k) => (own(HASH_KEY_NAMES, k) ? HASH_KEY_NAMES[k] : null)).filter(Boolean))];
  return names.length
    ? `Some settings in the shared link were not understood and were reset to their defaults: ${names.join(", ")}.`
    : "Some settings in the shared link were not understood and were reset to their defaults.";
}

// ---------------------------------------------------------------------------------------------
// Prediction (unscored): the reader guesses an index and a descriptor address before reveal

/**
 * Compare a reader's guesses with a walk step. `guess`: `{ index: string, addr: string }`;
 * empty strings are skipped. Returns `{ index: {ok, expected} | null, addr: ... }`.
 */
export function checkGuess(stepRec, guess) {
  const res = { index: null, addr: null };
  if (guess.index && guess.index.trim() !== "") {
    const p = parseIndex(guess.index);
    res.index = { ok: p.ok && p.value === stepRec.index, expected: hexSmall(stepRec.index), parsed: p.ok };
  }
  if (guess.addr && guess.addr.trim() !== "") {
    const p = parseHex(guess.addr);
    res.addr = { ok: p.ok && p.value === stepRec.descAddr, expected: hex(stepRec.descAddr), parsed: p.ok };
  }
  return res;
}

/** The one-line explanation of how a level's index comes out of the address. */
export function indexHow(stepRec, input) {
  const mask_ = (1 << stepRec.bits) - 1;
  return `bits [${stepRec.hi}:${stepRec.lo}] of ${hex(input)}: (${hexRaw(input)} >> ${stepRec.lo}) & ${hexSmall(mask_)} = ${hexSmall(stepRec.index)}; read at ${hex(stepRec.tableBase)} + ${hexSmall(stepRec.index)} x 8 = ${hex(stepRec.descAddr)}`;
}

/** The address split into fields, for the bit-range display. */
export function splitAddress(geo, input) {
  const v = B(input);
  const parts = geo.levels.map((l) => ({ label: `L${l.level}`, hi: l.hi, lo: l.lo, value: field(v, l.lo, l.bits) }));
  parts.push({ label: "offset", hi: geo.shift - 1, lo: 0, value: field(v, 0, geo.shift) });
  const top = v >> B(geo.inBits);
  return { parts, top, inBits: geo.inBits };
}

/**
 * Which guest 4 KiB pages one stage-2 page covers: the page-granules primer's point that a
 * stage-2 fault on a 16 KiB page hits four guest pages at once.
 */
export function coverage(world, ipa) {
  const page = world.s2.geo.pageBytes;
  const base = B(ipa) & ~(page - ONE);
  const g1 = world.s1.geo.pageBytes;
  return { base, end: base + page, guestPages: page >= g1 ? Number(page / g1) : 1, s1Page: g1, s2Page: page };
}

// ---------------------------------------------------------------------------------------------
// Share state: `#two-stage-walker=sc=toy;m=both;a=b100000;...`

const HASH_MAX = 4096;

/** Encode the shareable part of `state` (not the cursor or selection). */
export function encodeHash(state) {
  const a = state.access;
  const parts = [
    `sc=${state.scenario}`,
    `m=${state.mode}`,
    `a=${state.addr.toString(16)}`,
    `g1=${state.g1}`,
    `g2=${state.g2}`,
    `ipa=${state.ipaBits}`,
    `acc=${a.write ? "w" : "r"}${a.size}.${a.rt}.${a.el}`,
  ];
  if (state.uartRam) parts.push("ur=1");
  if (state.predict) parts.push("p=1");
  if (state.edits.length) parts.push(`e=${state.edits.map((e) => `${e.stage}.${e.addr.toString(16)}.${e.value.toString(16)}`).join(",")}`);
  return parts.join(";");
}

/**
 * Decode a share string into a state. Hostile input is expected (it comes from a URL): every
 * field is checked, unknown keys are ignored, a malformed field keeps its default, and the
 * result lists what was ignored in `errors`.
 */
export function decodeHash(str) {
  const errors = [];
  if (typeof str !== "string" || str.length === 0) return { state: initialState(), errors };
  if (str.length > HASH_MAX) return { state: initialState(), errors: ["share string too long"] };
  const kv = new Map();
  for (const part of str.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    kv.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const scenario = own(SCENARIOS, kv.get("sc")) ? kv.get("sc") : "toy";
  if (kv.has("sc") && scenario !== kv.get("sc")) errors.push("sc");
  let s = initialState(scenario);
  const hex64 = (t) => (typeof t === "string" && /^[0-9a-f]{1,16}$/.test(t) ? B("0x" + t) : null);
  if (kv.has("m")) own(MODES, kv.get("m")) ? (s = { ...s, mode: kv.get("m") }) : errors.push("m");
  if (kv.has("a")) {
    const v = hex64(kv.get("a"));
    v !== null ? (s = { ...s, addr: v }) : errors.push("a");
  }
  for (const [k, list] of [["g1", [4, 16]], ["g2", [4, 16]], ["ipa", IPA_SIZES]]) {
    if (!kv.has(k)) continue;
    const n = Number.parseInt(kv.get(k), 10);
    if (list.includes(n) && String(n) === kv.get(k)) s = { ...s, [k === "ipa" ? "ipaBits" : k]: n };
    else errors.push(k);
  }
  if (kv.has("acc")) {
    const m = /^([rw])([1248])\.([0-9]{1,2})\.([01])$/.exec(kv.get("acc"));
    if (m && Number(m[3]) <= 30) s = { ...s, access: { write: m[1] === "w", size: Number(m[2]), rt: Number(m[3]), el: Number(m[4]) } };
    else errors.push("acc");
  }
  if (kv.get("ur") === "1") s = { ...s, uartRam: true };
  if (kv.get("p") === "1") s = { ...s, predict: true, cursor: 0 };
  if (kv.has("e")) {
    const edits = [];
    for (const item of kv.get("e").split(",")) {
      if (edits.length >= MAX_EDITS) {
        errors.push("too many edits");
        break;
      }
      const m = /^([12])\.([0-9a-f]{1,12})\.([0-9a-f]{1,16})$/.exec(item);
      if (!m) {
        errors.push("e");
        continue;
      }
      const addr = B("0x" + m[2]);
      if (addr % 8n !== 0n) {
        errors.push("e");
        continue;
      }
      const stage = Number(m[1]);
      const i = edits.findIndex((e) => e.stage === stage && e.addr === addr);
      if (i >= 0) edits.splice(i, 1);
      edits.push({ stage, addr, value: B("0x" + m[3]) });
    }
    s = { ...s, edits };
  }
  return { state: s, errors };
}
