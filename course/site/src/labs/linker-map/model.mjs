// linker-map: the pure model behind the lab (no DOM, no I/O).
//
// What it computes, from a program (a preset) and a linker script (the lab's state):
//   1. the address of every output section and symbol, as `llvm-nm -n -C` prints them;
//   2. the program headers (PT_LOAD) with `filesz` and `memsz`, as `llvm-readobj` prints them;
//   3. the exact bytes `llvm-objcopy -O binary` writes, including the relocated instructions;
//   4. what a raw loader (`--raw FILE@ADDR`) would leave in guest memory.
//
// It is a small, honest re-implementation of the parts of `rust-lld` the bare-metal-rust primer
// relies on, not a general linker. The rules below were checked against real `rust-lld` output
// for the primer's program in 18 layouts (model.test.mjs holds those outputs as vectors):
//   - output sections are placed in script order; each starts at the location counter rounded up
//     to its alignment (the largest input alignment, or the script's ALIGN()); `.bss` is NOLOAD;
//   - a new PT_LOAD starts whenever the permission flags change; a NOLOAD section followed by a
//     section with bytes in the same PT_LOAD costs file space (filesz covers it);
//   - each PT_LOAD's file offset is congruent to its address modulo 64 KiB (the arm64 maximum
//     page size), after the ELF and program headers;
//   - a script-only section like `.far : { BYTE(1) }` takes the previous section's flags minus
//     execute (read-only if it comes first);
//   - `objcopy -O binary` writes every section that has bytes (never a NOLOAD one), in address
//     order, from the lowest address to the highest end, and fills the holes with zeros;
//   - relocations: R_AARCH64_ADR_PREL_PG_HI21, ADD_ABS_LO12_NC, LDST32_ABS_LO12_NC and ABS64,
//     plus lld's relaxation of `adrp`+`add` into `nop`+`adr` when the target is within 1 MiB;
//   - the Cortex-A53 erratum 843419 patch (`--fix-cortex-a53-843419`, which cargo passes): an
//     `adrp` at page offset 0xff8 or 0xffc, then a load or store, then (two or three instructions
//     after the adrp) a load or store with an unsigned offset whose base is the adrp's register.
//     lld moves that last instruction into an 8-byte patch after the code (`<insn>; b back`),
//     names it `__CortexA53843419_<address>`, and puts a `b patch` in its place. This model
//     recognises only a single-register unsigned-offset load or store as the middle instruction,
//     which covers every instruction this program has.
// Arm Architecture Reference Manual (DDI 0487) C6.2 gives the ADR, ADRP, ADD, LDR, STR and B
// encodings; the ELF for the Arm 64-bit Architecture (AAELF64) document defines the relocations.
//
// Simplifications, stated so the lab never over-claims: the start address and `.far` address
// must be multiples of 64 KiB (so lld never puts the ELF headers inside a loaded segment), and
// sections must be placed in increasing address order (except a `.far` placed first).

export const U64_MAX = (1n << 64n) - 1n;
export const PAGE_64K = 0x10000n;
export const MAX_STACK = 0x4000_0000n; // 1 GiB: a sane cap for a lab input
export const NOP = 0xd503201f;

// ---------------------------------------------------------------------------------------------
// Number helpers (addresses are BigInt so 64-bit values never lose precision).

/** Parse a hex string ("0x4008_0000", "40080000") into a BigInt, or null if invalid. */
export function parseHex(text) {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/_/g, "").toLowerCase();
  if (t.startsWith("0x")) t = t.slice(2);
  if (t.length === 0 || t.length > 16 || !/^[0-9a-f]+$/.test(t)) return null;
  return BigInt("0x" + t);
}

/** Format a BigInt address as 0x plus lowercase hex, with an underscore every 4 digits. */
export function hex(v, { pad = 0, group = true } = {}) {
  let s = BigInt(v).toString(16).padStart(pad, "0");
  if (group && s.length > 4) {
    const parts = [];
    while (s.length > 4) {
      parts.unshift(s.slice(-4));
      s = s.slice(0, -4);
    }
    parts.unshift(s);
    s = parts.join("_");
  }
  return "0x" + s;
}

/** Plain hex as tools print it (no 0x, zero-padded to 16 digits by default). */
export function rawHex(v, pad = 16) {
  return BigInt(v).toString(16).padStart(pad, "0");
}

/** 1234567 -> "1,234,567". */
export function commas(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function alignUp(v, a) {
  const al = BigInt(a);
  if (al <= 1n) return v;
  return ((v + al - 1n) / al) * al;
}

function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => {
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  });
  return out;
}

export function readWord(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function writeWord(bytes, off, w) {
  bytes[off] = w & 0xff;
  bytes[off + 1] = (w >>> 8) & 0xff;
  bytes[off + 2] = (w >>> 16) & 0xff;
  bytes[off + 3] = (w >>> 24) & 0xff;
}

// ---------------------------------------------------------------------------------------------
// The programs. `bare` is the primer's program, byte for byte (its object file's section sizes,
// alignments, unrelocated instruction words and relocations, read with llvm-objdump -dr and
// llvm-readobj on the real `rustc` output). `guest` is chapter 03's `hello` with the `COUNTER`
// variant from captures/03-bss-nm.txt; only the sizes the capture proves are modelled.

// The 14 instructions of `_start` as rustc emitted them, before the linker fills in addresses.
const BARE_START_WORDS = [
  0xd10043ff, // sub  sp, sp, #0x10
  0x90000008, // adrp x8, GREETING (or WHERE)
  0x91000108, // add  x8, x8, :lo12:GREETING
  0xf90007e8, // str  x8, [sp, #0x8]
  0x910023e8, // add  x8, sp, #0x8
  0x90000008, // adrp x8, BOOTS
  0xb9400109, // ldr  w9, [x8, :lo12:BOOTS]
  0x11000529, // add  w9, w9, #0x1
  0xb9000109, // str  w9, [x8, :lo12:BOOTS]
  0x90000008, // adrp x8, COUNTER
  0xb9400109, // ldr  w9, [x8, :lo12:COUNTER]
  0x11000529, // add  w9, w9, #0x1
  0xb9000109, // str  w9, [x8, :lo12:COUNTER]
  0x17fffffd, // b    .-12 (the loop; no relocation, it stays inside _start)
];

function bareRelocs(first) {
  return [
    { off: 0x04, type: "ADR_PREL_PG_HI21", sym: first },
    { off: 0x08, type: "ADD_ABS_LO12_NC", sym: first },
    { off: 0x14, type: "ADR_PREL_PG_HI21", sym: "BOOTS" },
    { off: 0x18, type: "LDST32_ABS_LO12_NC", sym: "BOOTS" },
    { off: 0x20, type: "LDST32_ABS_LO12_NC", sym: "BOOTS" },
    { off: 0x24, type: "ADR_PREL_PG_HI21", sym: "COUNTER" },
    { off: 0x28, type: "LDST32_ABS_LO12_NC", sym: "COUNTER" },
    { off: 0x30, type: "LDST32_ABS_LO12_NC", sym: "COUNTER" },
  ];
}

function barePieces(where) {
  const rodata = [];
  if (where) {
    rodata.push({
      id: "WHERE", size: 8, align: 8, bytes: new Uint8Array(8),
      relocs: [{ off: 0, type: "ABS64", sym: "GREETING" }],
      syms: [{ id: "WHERE", off: 0, letter: "r", name: "bare::WHERE", key: "_RNvCs2IAovmNIQZv_4bare5WHERE" }],
    });
  }
  rodata.push({
    id: "GREETING", size: 6, align: 1, bytes: hexToBytes("68656c6c6f0a"),
    syms: [{ id: "GREETING", off: 0, letter: "r", name: "bare::GREETING", key: "_RNvCs2IAovmNIQZv_4bare8GREETING" }],
  });
  return {
    text: [{
      id: "_start", size: 56, align: 4, code: true, bytes: wordsToBytes(BARE_START_WORDS),
      relocs: bareRelocs(where ? "WHERE" : "GREETING"),
      syms: [{ id: "_start", off: 0, letter: "T", name: "_start", key: "_start" }],
    }],
    rodata,
    data: [{
      id: "BOOTS", size: 4, align: 4, bytes: hexToBytes("07000000"),
      syms: [{ id: "BOOTS", off: 0, letter: "d", name: "bare::BOOTS (.0)", key: "_RNvCs2IAovmNIQZv_4bare5BOOTS.0" }],
    }],
    bss: [{
      id: "COUNTER", size: 4, align: 4, bytes: null,
      syms: [{ id: "COUNTER", off: 0, letter: "b", name: "bare::COUNTER (.0)", key: "_RNvCs2IAovmNIQZv_4bare7COUNTER.0" }],
    }],
  };
}

// Sizes from chapter 03's `hello` with the COUNTER static (captures/03-bss-nm.txt), rebuilt from
// the same change on the reference Mac: the rebuild reproduces the capture exactly (BSS at
// 0x4008_2e60, `__bss_end` 0x4010_2e90, 11,866-byte hello.bin), and llvm-readobj on it gives
// .text = 10,976 bytes with AddressAlignment 2048 (the 2 KiB-aligned `.vectors` input section
// inside it: VBAR_EL1 bits [10:0] are RES0) and .rodata = 890 bytes, aligned to 16. The bytes
// themselves are not modelled, so both blocks are opaque.
function guestPieces() {
  return {
    text: [{
      id: "the code", size: 10976, align: 2048, code: false, bytes: null, opaque: true,
      syms: [
        { id: "_start", off: 0, letter: "T", name: "_start", key: "_start" },
        { id: "_secondary_start", off: 0x78, letter: "T", name: "_secondary_start", key: "_secondary_start" },
        { id: "guest_vectors", off: 0x800, letter: "T", name: "guest_vectors", key: "guest_vectors" },
      ],
    }],
    rodata: [{ id: "the constants", size: 890, align: 16, bytes: null, opaque: true, syms: [] }],
    data: [],
    bss: [{
      // COUNTER at the BSS start, BACKEND 0x20 above it, stacks at 0x30 (the capture's nm lines).
      id: "statics", size: 0x30, align: 16, bytes: null,
      syms: [
        { id: "COUNTER", off: 0, letter: "b", name: "hello::COUNTER (.0)", key: "_RNvCsieMabytS3dp_5hello7COUNTER.0" },
        { id: "BACKEND", off: 0x20, letter: "b", name: "guest::console::BACKEND (.0)", key: "_RNvNtCsd92i63ulmgm_5guest7console7BACKEND.0" },
      ],
    }],
  };
}

export const PRESETS = {
  bare: {
    id: "bare",
    title: "The primer's program (bare)",
    file: "bare.bin",
    start: 0x40080000n,
    stack: 0x4000n,
    stackLabel: "Stack size",
    canWhere: true,
    sectionNames: { text: ".text", rodata: ".rodata", data: ".data", bss: ".bss" },
    bssTail: "bare",
    source(where) {
      const lines = [
        'static GREETING: [u8; 6] = *b"hello\\n"; // .rodata',
        "static BOOTS: AtomicU32 = AtomicU32::new(7);  // .data",
        "static COUNTER: AtomicU32 = AtomicU32::new(0); // .bss",
      ];
      if (where) lines.push("static WHERE: &[u8; 6] = &GREETING;         // .rodata, holds an address");
      lines.push("_start: 14 instructions in .text.boot          // .text");
      return lines;
    },
  },
  guest: {
    id: "guest",
    title: "Chapter 03's hello guest, with COUNTER",
    file: "hello.bin",
    start: 0x40080000n,
    stack: 0x80000n,
    stackLabel: "Stacks (8 × 64 KiB)",
    canWhere: false,
    sectionNames: { text: ".text", rodata: ".rodata", data: ".data", bss: ".bss" },
    bssTail: "guest",
    source() {
      return [
        "_start, _secondary_start (+0x78), the vectors (+0x800), all code // .text, 10,976 bytes",
        "strings and other constants                                     // .rodata, 890 bytes",
        "static COUNTER: AtomicU32 = AtomicU32::new(0);                  // .bss",
        "static BACKEND: ... = Backend::Hvc (0);                         // .bss",
        "eight 64 KiB stacks                                             // .bss, not in the file",
        "no static starts non-zero, so .data is empty and the linker drops it",
      ];
    },
  },
};

const SECTION_FLAGS = { text: "RX", rodata: "R", data: "RW", bss: "RW" };

// ---------------------------------------------------------------------------------------------
// State.

/** The lab's state: one plain object. Addresses are BigInt. */
export function initialState(presetId = "bare") {
  const p = PRESETS[presetId] || PRESETS.bare;
  const pieces = p.id === "bare" ? barePieces(false) : guestPieces();
  const order = ["text", "rodata", "data", "bss"].filter((k) => pieces[k].length > 0);
  return {
    preset: p.id,
    order,
    start: p.start,
    stack: p.stack,
    far: false,
    farAddr: 0x40180000n,
    where: false,
    load: p.start,
    errors: {},
  };
}

/** Section ids the order may contain for a state (`far` only when enabled). */
function wantedSections(state) {
  const base = initialState(state.preset).order;
  return state.far ? [...base, "far"] : base;
}

const START_RULE = "Use a hex address that is a multiple of 0x1_0000 (64 KiB): the linker lines each loadable segment up with 64 KiB pages, the largest page size arm64 allows.";

function validStart(v) {
  return v !== null && v % PAGE_64K === 0n && v <= U64_MAX;
}

/** next = step(state, action). Never mutates `state`. Invalid input sets errors[field]. */
export function step(state, action) {
  const s = { ...state, order: [...state.order], errors: { ...state.errors } };
  switch (action.type) {
    case "reset":
      return initialState(s.preset);
    case "preset":
      return initialState(PRESETS[action.id] ? action.id : "bare");
    case "move": {
      const i = s.order.indexOf(action.section);
      const j = i + action.delta;
      if (i < 0 || j < 0 || j >= s.order.length) return state;
      [s.order[i], s.order[j]] = [s.order[j], s.order[i]];
      return s;
    }
    case "moveTo": {
      const i = s.order.indexOf(action.section);
      const j = Math.max(0, Math.min(s.order.length - 1, action.index | 0));
      if (i < 0 || i === j) return state;
      s.order.splice(i, 1);
      s.order.splice(j, 0, action.section);
      return s;
    }
    case "start": {
      const v = parseHex(action.text);
      if (!validStart(v)) {
        s.errors.start = START_RULE;
        return s;
      }
      delete s.errors.start;
      s.start = v;
      return s;
    }
    case "stack": {
      const v = parseHex(action.text);
      if (v === null || v % 16n !== 0n || v > MAX_STACK) {
        s.errors.stack = "Use a hex size that is a multiple of 16 (sp must stay 16-byte aligned), at most 0x4000_0000 (1 GiB).";
        return s;
      }
      delete s.errors.stack;
      s.stack = v;
      return s;
    }
    case "far": {
      s.far = !!action.on;
      if (s.far && !s.order.includes("far")) {
        const b = s.order.indexOf("bss");
        s.order.splice(b < 0 ? s.order.length : b, 0, "far"); // the primer's spot: before .bss
      }
      if (!s.far) s.order = s.order.filter((x) => x !== "far");
      return s;
    }
    case "farAddr": {
      const v = parseHex(action.text);
      if (!validStart(v)) {
        s.errors.farAddr = START_RULE;
        return s;
      }
      delete s.errors.farAddr;
      s.farAddr = v;
      return s;
    }
    case "where":
      if (!PRESETS[s.preset].canWhere) return state;
      s.where = !!action.on;
      return s;
    case "load": {
      const v = parseHex(action.text);
      if (v === null || v % 4n !== 0n) {
        s.errors.load = "Use a hex address that is a multiple of 4 (instructions are 4 bytes).";
        return s;
      }
      delete s.errors.load;
      s.load = v;
      return s;
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Share state: `p:bare;o:t-r-d-b;s:40080000;k:4000;f:40180000;w:1;l:40080000`.

const ORDER_CODE = { text: "t", rodata: "r", data: "d", bss: "b", far: "f" };
const CODE_ORDER = Object.fromEntries(Object.entries(ORDER_CODE).map(([k, v]) => [v, k]));

export function encodeHash(state) {
  const parts = [
    `p:${state.preset}`,
    `o:${state.order.map((x) => ORDER_CODE[x]).join("-")}`,
    `s:${rawHex(state.start, 1)}`,
    `k:${rawHex(state.stack, 1)}`,
  ];
  if (state.far) parts.push(`f:${rawHex(state.farAddr, 1)}`);
  if (state.where) parts.push("w:1");
  parts.push(`l:${rawHex(state.load, 1)}`);
  return parts.join(";");
}

/** Parse a share string. Anything malformed falls back to the preset's defaults. */
export function decodeHash(str) {
  if (typeof str !== "string" || str.length > 200) return initialState();
  const kv = {};
  for (const part of str.split(";")) {
    const m = /^([a-z]):([0-9a-zA-Z_-]{1,40})$/.exec(part);
    if (m) kv[m[1]] = m[2];
  }
  let s = initialState(PRESETS[kv.p] ? kv.p : "bare");
  if (kv.w === "1") s = step(s, { type: "where", on: true });
  if (kv.f) {
    s = step(s, { type: "far", on: true });
    s = step(s, { type: "farAddr", text: kv.f });
  }
  if (kv.s) s = step(s, { type: "start", text: kv.s });
  if (kv.k) s = step(s, { type: "stack", text: kv.k });
  if (kv.l) s = step(s, { type: "load", text: kv.l });
  if (kv.o) {
    const order = kv.o.split("-").map((c) => CODE_ORDER[c]);
    const want = wantedSections(s);
    const same = order.length === want.length && want.every((w) => order.includes(w));
    if (same) s = { ...s, order };
  }
  return { ...s, errors: {} };
}

// ---------------------------------------------------------------------------------------------
// The linker script the state stands for (shown in the lab, next to the program).

export function scriptText(state) {
  return state.preset === "guest" ? guestScript(state) : bareScript(state);
}

// The primer's link.ld, with the lab's order, start, stack and `.far`.
function bareScript(state) {
  const lines = ["ENTRY(_start)", "", "SECTIONS", "{", `  . = ${hex(state.start, { group: false })};`, ""];
  for (const id of state.order) {
    if (id === "far") lines.push(`  .far ${hex(state.farAddr, { group: false })} : { BYTE(1) }`);
    else if (id === "text") lines.push("  .text   : { KEEP(*(.text.boot)) *(.text .text.*) }");
    else if (id === "rodata") lines.push("  .rodata : { *(.rodata .rodata.*) }");
    else if (id === "data") lines.push("  .data   : { *(.data .data.*) }");
    else if (id === "bss") {
      lines.push(
        "  .bss (NOLOAD) : ALIGN(16) {",
        "    __bss_start = .;",
        "    *(.bss .bss.*)",
        "    . = ALIGN(16);",
        "    __bss_end = .;",
        `    . += ${hex(state.stack, { group: false })};`,
        "    __stack_top = .;",
        "  }",
      );
    }
  }
  lines.push("", "  /DISCARD/ : { *(.eh_frame*) *(.comment) }", "}");
  return lines.join("\n");
}

// guests/common/link.ld line for line (without its comments), with the lab's order, start,
// stack and `.far`. `.data` is printed right after `.rodata`: it is empty in this program, and
// rust-lld drops an empty output section without moving the location counter.
function guestScript(state) {
  const stack = state.stack === 0x80000n ? "8 * 0x10000" : hex(state.stack, { group: false });
  const lines = ["ENTRY(_start)", "EXTERN(_start)", "", "SECTIONS", "{",
    `  . = ${hex(state.start, { group: false })};`, "  __image_start = .;"];
  for (const id of state.order) {
    lines.push("");
    if (id === "far") lines.push(`  .far ${hex(state.farAddr, { group: false })} : { BYTE(1) }`);
    else if (id === "text") {
      lines.push("  .text : {", "    KEEP(*(.text.boot))", "    . = ALIGN(2048);", "    KEEP(*(.vectors))", "    *(.text .text.*)", "  }");
    } else if (id === "rodata") {
      lines.push("  .rodata : ALIGN(16) {", "    *(.rodata .rodata.*)", "  }", "",
        "  .data : ALIGN(16) {", "    *(.data .data.*)", "  }");
    } else if (id === "bss") {
      lines.push(
        "  .bss (NOLOAD) : ALIGN(16) {",
        "    __bss_start = .;",
        "    *(.bss .bss.*)",
        "    *(COMMON)",
        "    . = ALIGN(16);",
        "    __stacks_start = .;",
        `    . += ${stack};`,
        "    __stacks_end = .;",
        "    __bss_end = .;",
        "  }",
      );
    }
  }
  lines.push("", "  __image_end = .;", "", "  /DISCARD/ : {", "    *(.comment)", "    *(.note .note.*)",
    "    *(.eh_frame .eh_frame_hdr)", "  }", "}");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Relocations.

function signedFits(v, bits) {
  const lim = 1n << BigInt(bits - 1);
  return v >= -lim && v < lim;
}

function encAdrImm(word, imm) {
  // ADR/ADRP: immlo in bits [30:29], immhi in bits [23:5] (DDI 0487 C6.2.10, C6.2.11).
  const u = Number(BigInt.asUintN(21, imm));
  return ((word & 0x9f00001f) | ((u & 3) << 29) | (((u >>> 2) & 0x7ffff) << 5)) >>> 0;
}

function encImm12(word, imm12) {
  return ((word & ~(0xfff << 10)) | ((imm12 & 0xfff) << 10)) >>> 0;
}

/**
 * Apply a piece's relocations to a copy of its bytes. `addrOf(symId)` gives a symbol's final
 * address; `P` is the piece's address. Returns { bytes, notes, error }.
 */
export function relocate(piece, P, addrOf) {
  const bytes = new Uint8Array(piece.bytes);
  const relocs = piece.relocs || [];
  const notes = [];
  for (let i = 0; i < relocs.length; i++) {
    const r = relocs[i];
    const S = addrOf(r.sym);
    const place = P + BigInt(r.off);
    const w = readWord(bytes, r.off);
    if (r.type === "ADR_PREL_PG_HI21") {
      const next = relocs[i + 1];
      if (next && next.type === "ADD_ABS_LO12_NC" && next.off === r.off + 4 && next.sym === r.sym) {
        // lld relaxes adrp+add into nop+adr when the target is within +-1 MiB of the add.
        const d = S - (place + 4n);
        const rd = readWord(bytes, next.off) & 0x1f;
        if (signedFits(d, 21)) {
          writeWord(bytes, r.off, NOP);
          writeWord(bytes, next.off, encAdrImm((0x10000000 | rd) >>> 0, d));
          notes.push({ off: r.off, text: "adrp + add relaxed to nop + adr" });
          i++;
          continue;
        }
      }
      const pages = (S >> 12n) - (place >> 12n);
      if (!signedFits(pages, 21)) return { bytes, notes, error: `relocation out of range at ${hex(place)}` };
      writeWord(bytes, r.off, encAdrImm(w, pages));
    } else if (r.type === "ADD_ABS_LO12_NC") {
      writeWord(bytes, r.off, encImm12(w, Number(S & 0xfffn)));
    } else if (r.type === "LDST32_ABS_LO12_NC") {
      if ((S & 3n) !== 0n) return { bytes, notes, error: `misaligned 32-bit access to ${hex(S)}` };
      writeWord(bytes, r.off, encImm12(w, Number((S & 0xfffn) >> 2n)));
    } else if (r.type === "ABS64") {
      let v = S;
      for (let b = 0; b < 8; b++) {
        bytes[r.off + b] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
  }
  return { bytes, notes, error: null };
}

// ---------------------------------------------------------------------------------------------
// Cortex-A53 erratum 843419 (Arm's Cortex-A53 MPCore Software Developers Errata Notice; lld's
// AArch64ErrataFix.cpp is the implementation this follows).

const isAdrp = (w) => ((w & 0x9f000000) >>> 0) === 0x90000000;
// "Load/store register (unsigned immediate)": LDR/STR Rt, [Rn, #imm] (DDI 0487 C4.1.66).
const isLdStUnsignedImm = (w) => ((w & 0x3b000000) >>> 0) === 0x39000000;
const isBranch = (w) =>
  ((w & 0x7c000000) >>> 0) === 0x14000000 || // B, BL
  ((w & 0xff000010) >>> 0) === 0x54000000 || // B.cond
  ((w & 0x7e000000) >>> 0) === 0x34000000 || // CBZ, CBNZ
  ((w & 0x7e000000) >>> 0) === 0x36000000 || // TBZ, TBNZ
  ((w & 0xfe000000) >>> 0) === 0xd6000000; // BR, BLR, RET

/**
 * Offsets (into the code piece) of the instructions lld would move into an erratum patch, for
 * code placed at address `P`. Only the instruction kinds matter, so the unrelocated words do.
 */
export function erratumSites(bytes, P) {
  const sites = [];
  const n = bytes.length;
  for (let o = 0; o + 12 <= n; o += 4) {
    const pageOff = (P + BigInt(o)) & 0xfffn;
    if (pageOff !== 0xff8n && pageOff !== 0xffcn) continue;
    const i1 = readWord(bytes, o);
    if (!isAdrp(i1)) continue;
    const rn = i1 & 0x1f;
    const i2 = readWord(bytes, o + 4);
    if (!isLdStUnsignedImm(i2)) continue;
    const matches = (w) => isLdStUnsignedImm(w) && ((w >>> 5) & 0x1f) === rn;
    const i3 = readWord(bytes, o + 8);
    if (matches(i3)) sites.push(o + 8);
    else if (o + 16 <= n && !isBranch(i3) && matches(readWord(bytes, o + 12))) sites.push(o + 12);
  }
  return sites;
}

const encB = (from, to) => (0x14000000 | (Number(BigInt.asUintN(26, (to - from) >> 2n)))) >>> 0;

// ---------------------------------------------------------------------------------------------
// A tiny disassembler for exactly the instructions this lab shows (formats follow llvm-objdump).

function sext(v, bits) {
  const m = 1 << (bits - 1);
  return (v ^ m) - m;
}

export function disasm(word, addr) {
  const w = word >>> 0;
  const a = BigInt(addr);
  if (w === NOP) return "nop";
  if (w === 0xd10043ff) return "sub\tsp, sp, #0x10";
  if (w === 0xf90007e8) return "str\tx8, [sp, #0x8]";
  if (w === 0x910023e8) return "add\tx8, sp, #0x8";
  if (w === 0x11000529) return "add\tw9, w9, #0x1";
  if (((w & 0x9f000000) >>> 0) === 0x10000000 || ((w & 0x9f000000) >>> 0) === 0x90000000) {
    const imm = sext((((w >>> 5) & 0x7ffff) << 2) | ((w >>> 29) & 3), 21);
    const rd = w & 0x1f;
    if (w & 0x80000000) return `adrp\tx${rd}, ${hex(((a >> 12n) + BigInt(imm)) << 12n, { group: false })}`;
    return `adr\tx${rd}, ${hex(a + BigInt(imm), { group: false })}`;
  }
  if (((w & 0xffc00000) >>> 0) === 0x91000000) {
    return `add\tx${w & 0x1f}, x${(w >>> 5) & 0x1f}, #${hex((w >>> 10) & 0xfff, { group: false })}`;
  }
  if (((w & 0xffc00000) >>> 0) === 0xb9400000 || ((w & 0xffc00000) >>> 0) === 0xb9000000) {
    const op = w & 0x00400000 ? "ldr" : "str";
    const off = ((w >>> 10) & 0xfff) * 4;
    const base = `x${(w >>> 5) & 0x1f}`;
    return `${op}\tw${w & 0x1f}, [${base}${off ? `, #${hex(off, { group: false })}` : ""}]`;
  }
  if (((w & 0xfc000000) >>> 0) === 0x14000000) {
    return `b\t${hex(a + BigInt(sext(w & 0x3ffffff, 26) * 4), { group: false })}`;
  }
  if (((w & 0xffff0000) >>> 0) === 0) return `udf\t#${hex(w, { group: false })}`;
  // Known non-code words (decoded with llvm-objdump): the bytes "hell" of GREETING.
  if (w === 0x6c6c6568) return "ldnp\td8, d25, [x11, #-0x140]";
  return null;
}

// ---------------------------------------------------------------------------------------------
// The link.

function piecesFor(state) {
  return state.preset === "bare" ? barePieces(state.where) : guestPieces();
}

/**
 * Link the program with the state's script. Returns
 *   { ok, error, sections, symbols, phdrs, flat, code, notes }
 * or { ok: false, error } when the layout is impossible.
 */
export function link(state) {
  const p = PRESETS[state.preset];
  const pieces = piecesFor(state);
  const sections = [];
  const symbols = [];
  let loc = state.start;
  const fail = (error) => ({ ok: false, error });

  for (const id of state.order) {
    let sec;
    if (id === "far") {
      if (sections.length > 0 && state.farAddr < loc) {
        return fail(`.far at ${hex(state.farAddr)} would move the location counter backwards (it is already at ${hex(loc)}). This lab places sections in increasing address order: move .far first, or give it an address of at least ${hex(alignUp(loc, PAGE_64K))}.`);
      }
      loc = state.farAddr;
      const prev = sections[sections.length - 1];
      sec = { id, name: ".far", flags: prev ? prev.flags.replace("X", "") : "R", nobits: false, align: 1n, pieces: [{ id: ".far", size: 1, align: 1, bytes: Uint8Array.of(1), syms: [] }] };
    } else {
      const list = pieces[id];
      if (!list || list.length === 0) continue;
      const explicit = id === "bss" ? 16n : p.id === "guest" ? 16n : 1n;
      sec = { id, name: p.sectionNames[id], flags: SECTION_FLAGS[id], nobits: id === "bss", align: explicit, pieces: list };
    }
    const maxAlign = sec.pieces.reduce((m, x) => (BigInt(x.align) > m ? BigInt(x.align) : m), sec.align);
    const addr = alignUp(loc, maxAlign);
    let cur = addr;
    const placed = [];
    const symAt = (name, letterSec, key = name, idd = name) =>
      symbols.push({ id: idd, addr: cur, letter: letterSec, name, key });
    if (id === "bss") symAt("__bss_start", "B");
    for (const pc of sec.pieces) {
      cur = alignUp(cur, pc.align);
      // The erratum patches go right after the code they belong to, 8 bytes each.
      const patches = pc.code && pc.bytes ? erratumSites(pc.bytes, cur) : [];
      const size = pc.size + 8 * patches.length;
      placed.push({ ...pc, addr: cur, size, baseSize: pc.size, patches, section: id });
      for (const sy of pc.syms) symbols.push({ id: sy.id, addr: cur + BigInt(sy.off), letter: sy.letter, name: sy.name, key: sy.key });
      patches.forEach((o, k) => {
        const name = `__CortexA53843419_${rawHex(cur + BigInt(o), 1)}`;
        symbols.push({ id: name, addr: cur + BigInt(pc.size + 8 * k), letter: "t", name, key: name });
      });
      cur += BigInt(size);
    }
    if (id === "bss") {
      cur = alignUp(cur, 16n);
      if (p.bssTail === "bare") {
        symAt("__bss_end", "B");
        cur += state.stack;
        symAt("__stack_top", "B");
      } else {
        symAt("__stacks_start", "B");
        cur += state.stack;
        symAt("__stacks_end", "B");
        symAt("__bss_end", "B");
      }
    }
    if (cur > U64_MAX) return fail("The layout runs past the top of the 64-bit address space.");
    sections.push({ ...sec, addr, size: cur - addr, placed });
    loc = cur;
  }

  if (p.id === "guest" && sections.length > 0) {
    // `__image_start = .;` before the first section and `__image_end = .;` after the last:
    // llvm-nm gives each the letter of the section next to it (checked with rust-lld).
    const letterOf = (sec) => (sec.nobits ? "B" : sec.flags.includes("X") ? "T" : sec.flags.includes("W") ? "D" : "R");
    symbols.push({ id: "__image_start", addr: state.start, letter: letterOf(sections[0]), name: "__image_start", key: "__image_start" });
    symbols.push({ id: "__image_end", addr: loc, letter: letterOf(sections[sections.length - 1]), name: "__image_end", key: "__image_end" });
  }

  // Relocate code and data now that every address is known.
  const addrOf = (symId) => {
    const s = symbols.find((x) => x.id === symId);
    return s ? s.addr : 0n;
  };
  const notes = [];
  for (const sec of sections) {
    for (const pc of sec.placed) {
      if (!pc.bytes || !pc.relocs) continue;
      const r = relocate(pc, pc.addr, addrOf);
      if (r.error) return fail(`The linker would refuse this layout: ${r.error}.`);
      for (const n of r.notes) notes.push({ ...n, addr: pc.addr + BigInt(n.off) });
      if (pc.patches && pc.patches.length) {
        // Move each patched instruction to its patch, followed by a branch back, and put a
        // branch to the patch in its place.
        const out = new Uint8Array(pc.size);
        out.set(r.bytes);
        pc.patches.forEach((o, k) => {
          const v = pc.baseSize + 8 * k;
          const insn = readWord(r.bytes, o);
          writeWord(out, v, insn);
          writeWord(out, v + 4, encB(pc.addr + BigInt(v + 4), pc.addr + BigInt(o + 4)));
          writeWord(out, o, encB(pc.addr + BigInt(o), pc.addr + BigInt(v)));
          notes.push({
            erratum: true, addr: pc.addr + BigInt(o), patch: pc.addr + BigInt(v),
            text: `it moved "${disasm(insn, pc.addr + BigInt(v)).replace("\t", " ")}" from ${hex(pc.addr + BigInt(o), { group: false })} to a patch at ${hex(pc.addr + BigInt(v), { group: false })} (the __CortexA53843419 symbol), put a branch to the patch in its place, and ended the patch with a branch back`,
          });
        });
        pc.bytes = out;
      } else pc.bytes = r.bytes;
    }
  }

  // llvm-nm -n: by address, then by (mangled) name.
  symbols.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const phdrs = programHeaders(sections);
  const flat = flatBinary(sections);
  const code = [];
  for (const sec of sections) {
    for (const pc of sec.placed) {
      if (!pc.code || !pc.bytes) continue;
      for (let o = 0; o < pc.size; o += 4) {
        const at = pc.addr + BigInt(o);
        const w = readWord(pc.bytes, o);
        code.push({ addr: at, word: w, text: disasm(w, at) || "(not decoded)", sym: o === 0 ? pc.id : null });
      }
    }
  }
  return { ok: true, error: null, sections, symbols, phdrs, flat, code, notes };
}

/** PT_LOAD headers, with lld's rules (see the top of this file). */
export function programHeaders(sections) {
  const segs = [];
  for (const sec of sections) {
    const last = segs[segs.length - 1];
    if (!last || last.flags !== sec.flags) segs.push({ flags: sec.flags, secs: [sec] });
    else last.secs.push(sec);
  }
  const ehdr = 64n;
  const phent = 56n;
  let off = ehdr + phent * BigInt(segs.length + 1); // + PT_GNU_STACK
  return segs.map((sg) => {
    const vaddr = sg.secs[0].addr;
    const lastSec = sg.secs[sg.secs.length - 1];
    const memsz = lastSec.addr + lastSec.size - vaddr;
    let fileEnd = vaddr;
    for (const s of sg.secs) if (!s.nobits) fileEnd = s.addr + s.size;
    const filesz = fileEnd - vaddr;
    // Smallest offset >= off that is congruent to vaddr modulo 64 KiB.
    const want = vaddr % PAGE_64K;
    let o = off - (off % PAGE_64K) + want;
    if (o < off) o += PAGE_64K;
    off = o + filesz;
    const zeroFilled = sg.secs.filter((s) => s.nobits && s.addr + s.size <= fileEnd).map((s) => s.name);
    return {
      offset: o, vaddr, paddr: vaddr, filesz, memsz, flags: sg.flags,
      sections: sg.secs.map((s) => s.name), zeroFilled,
    };
  });
}

/**
 * What `llvm-objcopy -O binary` writes: chunks in address order, holes as zero gaps.
 * Never materializes the whole file (a stray section can make it a gigabyte).
 */
export function flatBinary(sections) {
  const items = [];
  for (const sec of sections) {
    if (sec.nobits) continue;
    for (const pc of sec.placed) items.push({ sec, pc });
  }
  if (items.length === 0) return { start: 0n, size: 0n, chunks: [] };
  items.sort((a, b) => (a.pc.addr < b.pc.addr ? -1 : a.pc.addr > b.pc.addr ? 1 : 0));
  const start = items[0].pc.addr;
  const chunks = [];
  let cur = start;
  for (const { sec, pc } of items) {
    if (pc.addr > cur) chunks.push(gapChunk(cur, pc.addr, start, sections));
    chunks.push({
      kind: sec.id, section: sec.name, label: pc.id, addr: pc.addr, off: pc.addr - start,
      size: BigInt(pc.size), bytes: pc.bytes || null,
    });
    cur = pc.addr + BigInt(pc.size);
  }
  return { start, size: cur - start, chunks };
}

function gapChunk(from, to, start, sections) {
  const bss = sections.find((s) => s.nobits && s.addr < to && s.addr + s.size > from);
  const big = to - from >= 16n;
  let label = "padding";
  if (bss) label = `${bss.name} written out as zeros`;
  else if (big) label = "gap, written out as zeros";
  return { kind: "gap", section: null, label, addr: from, off: from - start, size: to - from, bytes: null, bss: !!bss };
}

/** The byte at flat-file offset `off` (BigInt), or null when the preset does not carry bytes. */
export function flatByte(flat, off) {
  for (const c of flat.chunks) {
    if (off >= c.off && off < c.off + c.size) {
      if (c.kind === "gap") return 0;
      if (!c.bytes) return null;
      return c.bytes[Number(off - c.off)];
    }
  }
  return null;
}

/** The chunk that holds flat-file offset `off`. */
export function chunkAt(flat, off) {
  return flat.chunks.find((c) => off >= c.off && off < c.off + c.size) || null;
}

/**
 * Rows for an xxd-style dump. Runs of whole zero-gap rows collapse into one `skip` row.
 * At most `maxRows` rows are returned (then a `more` row).
 */
export function hexRows(flat, maxRows = 160) {
  const rows = [];
  const size = flat.size;
  let off = 0n;
  while (off < size) {
    if (rows.length >= maxRows) {
      rows.push({ type: "more", off, remaining: size - off });
      break;
    }
    const c = chunkAt(flat, off);
    if (c && c.kind === "gap") {
      const rowStart = off - (off % 16n);
      const gapEnd = c.off + c.size;
      const firstFull = alignUp(off, 16n);
      const lastFull = gapEnd - (gapEnd % 16n);
      if (rowStart === off && lastFull - firstFull >= 48n) {
        rows.push({ type: "skip", off: firstFull, size: lastFull - firstFull, label: c.label });
        off = lastFull;
        continue;
      }
    }
    if (c && c.kind !== "gap" && !c.bytes) {
      rows.push({ type: "opaque", off: c.off, size: c.size, label: `${c.section}: ${commas(c.size)} bytes (contents not shown for this program)` });
      off = c.off + c.size;
      continue;
    }
    const base = off - (off % 16n);
    const cells = [];
    for (let i = 0n; i < 16n; i++) {
      const o = base + i;
      if (o < off || o >= size) {
        cells.push(null);
        continue;
      }
      const ch = chunkAt(flat, o);
      if (ch && ch.kind !== "gap" && !ch.bytes) {
        cells.push(null);
        continue;
      }
      cells.push({ byte: flatByte(flat, o), kind: ch ? ch.kind : "gap", label: ch ? ch.label : "" });
    }
    rows.push({ type: "bytes", off: base, cells });
    off = base + 16n;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// After `--raw FILE@LOAD`: what the CPU and memory see.

export function rawLoad(state, res) {
  const p = PRESETS[state.preset];
  const out = [];
  if (!res.ok) return out;
  const flat = res.flat;
  const L = state.load;
  const shift = L - flat.start;
  const symAddr = (id) => (res.symbols.find((s) => s.id === id) || {}).addr;
  const start = symAddr("_start");
  out.push({
    status: "info",
    text: `The VMM copies ${commas(flat.size)} bytes of ${p.file} to ${hex(L)} and sets the PC to ${hex(L)}.`,
  });

  // 1. The first instruction.
  const first = chunkAt(flat, 0n);
  if (first && startsWithEntry(res)) {
    if (shift === 0n) out.push({ status: "ok", text: `The first bytes are _start, linked for ${hex(start)}: the CPU runs your entry code.` });
    else out.push({ status: "warn", text: `The first bytes are _start, but they were linked for ${hex(start)} and now sit at ${hex(L)} (moved by ${signedHex(shift)}). PC-relative code (adr, adrp) still works; every stored absolute address is wrong.` });
  } else if (first) {
    const w = [0n, 1n, 2n, 3n].map((i) => flatByte(flat, i));
    const word = w.every((b) => b !== null) ? (w[0] | (w[1] << 8) | (w[2] << 16) | (w[3] << 24)) >>> 0 : null;
    const what = first.kind === "gap" ? "zeros" : `${first.section} (${first.label})`;
    let text = `The first bytes are ${what}, not _start (which is ${commas(start - flat.start)} bytes into the file).`;
    if (word !== null) {
      const d = disasm(word, L);
      const ascii = asciiOf(w);
      text += ` The CPU fetches ${hex(word, { pad: 8, group: false })}${ascii ? ` (the text "${ascii}")` : ""} and executes it as ${d ? `"${d.replace("\t", " ")}"` : "an instruction this lab does not decode"}.`;
      if (d && d.startsWith("udf")) text += " UDF is permanently undefined: the guest takes an exception on its first instruction.";
      else if (d && d.startsWith("ldnp")) text += " x11 is zero when the VMM starts the vCPU (Hypervisor.framework creates it with zeroed registers), so it loads from 0xffff_ffff_ffff_fec0, far outside guest RAM: the first instruction faults.";
    }
    out.push({ status: "bad", text });
  }
  if (start !== undefined && (start < flat.start || start >= flat.start + flat.size)) {
    out.push({ status: "bad", text: `_start (${hex(start)}) is not inside the file at all.` });
  }

  // 2. Stored absolute addresses.
  if (state.where) {
    const where = symAddr("WHERE");
    const greeting = symAddr("GREETING");
    if (shift === 0n) out.push({ status: "ok", text: `WHERE holds ${hex(greeting)}, and GREETING really is there.` });
    else out.push({ status: "bad", text: `WHERE (now at ${hex(where + shift)}) still holds ${hex(greeting)}, but GREETING is now at ${hex(greeting + shift)}. Following the pointer reads the wrong memory.` });
  }

  // 3. The BSS.
  const bss = res.sections.find((s) => s.nobits);
  if (bss) {
    const inFile = bss.addr >= flat.start && bss.addr + bss.size <= flat.start + flat.size;
    if (inFile) {
      out.push({ status: "warn", text: `${bss.name} (${commas(bss.size)} bytes) sits between sections that have bytes, so objcopy wrote it out as zeros: the file grew by that much, and COUNTER happens to start at zero.` });
    } else {
      out.push({ status: "warn", text: `${bss.name} (${commas(bss.size)} bytes, ${hex(bss.addr + shift)} to ${hex(bss.addr + bss.size + shift)} after loading) is not in the file: it holds whatever RAM held before. _start must zero it.` });
    }
  }

  // 4. Size.
  if (flat.size > 0x100000n) {
    out.push({ status: "warn", text: `The flat binary is ${commas(flat.size)} bytes, mostly zeros that only keep later bytes at their offsets.` });
  }
  return out;
}

/** True when the flat binary's first byte is `_start` (decided from the symbols, not the chunks). */
export function startsWithEntry(res) {
  if (!res.ok || res.flat.size === 0n) return false;
  return res.symbols.some((s) => s.id === "_start" && s.addr === res.flat.start);
}

function signedHex(v) {
  return v < 0n ? `-${hex(-v)}` : `+${hex(v)}`;
}

function asciiOf(bytes) {
  if (bytes.some((b) => b === null)) return "";
  const printable = bytes.filter((b) => b >= 0x20 && b < 0x7f);
  if (printable.length < 3) return "";
  return bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "")).join("");
}

/** One plain-text sentence for the live region. */
export function summary(state, res) {
  if (!res.ok) return `Link failed: ${res.error}`;
  const f = res.flat;
  const first = chunkAt(f, 0n);
  const startOk = startsWithEntry(res);
  const nLoad = res.phdrs.length;
  return `Flat binary ${commas(f.size)} bytes from ${hex(f.start)}; ${nLoad} PT_LOAD headers; first byte is ${startOk ? "_start" : first ? (first.kind === "gap" ? "zeros" : first.label) : "nothing"}.`;
}

/** What to say after a section moves: ".rodata moved to position 1 of 4, before .text." */
export function moveText(state, section) {
  const names = PRESETS[state.preset].sectionNames;
  const nameOf = (id) => (id === "far" ? ".far" : names[id]);
  const i = state.order.indexOf(section);
  if (i < 0) return "";
  const n = state.order.length;
  const where = i === 0 ? `before ${nameOf(state.order[1])}` : `after ${nameOf(state.order[i - 1])}`;
  return `${nameOf(section)} moved to position ${i + 1} of ${n}, ${where}.`;
}
