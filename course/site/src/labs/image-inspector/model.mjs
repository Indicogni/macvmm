// image-inspector model: pure logic, no DOM, no I/O.
//
// What it mirrors (same rules, same order, same error text), so the lab says exactly what macvmm
// says:
//   - detect()        crates/vmm/src/loader/mod.rs   `detect` (the magic-number sniff)
//   - checkImage()    crates/vmm/src/loader/image.rs `parse_header`
//   - planBoot()      crates/vmm/src/loader/plan.rs  `plan` (Image path), image.rs `place`,
//                     initrd.rs `place` and `check_window`, and the dry-run lines of
//                     `impl Display for BootPlan`
//   - inspectZboot()  crates/xtask/src/zboot.rs      `parse` and the first check of `unwrap_with`
// plus a small PE/COFF reader for the fields the efi-zboot primer names (signature, machine,
// subsystem, sections) and the gzip member header and trailer (RFC 1952 section 2.3).
//
// A file is hostile input. The lab never holds the whole file: it reads at most a few KiB
// (the first 4 KiB, then at most four more windows of at most 4 KiB each that the headers point
// at), into a sparse view where every other byte is "not read". All 64-bit arithmetic is BigInt,
// so a value like 0xffff_ffff_ffff_ffff is exact and an overflow is detected, not wrapped.

import { BASES, TRIES } from "./presets.mjs";

// ---- constants (crates/vmm/src/arch/layout.rs, loader/image.rs, xtask/src/zboot.rs) ----

export const U64_MAX = (1n << 64n) - 1n;
export const RAM_BASE = 0x4000_0000n;
export const DTB_MAX = 2n << 20n;
export const LINUX_IMAGE_BASE = RAM_BASE + DTB_MAX;
export const LINUX_ALIGN = 2n << 20n;
export const LINUX_WINDOW_ALIGN = 1n << 30n;
export const LINUX_WINDOW_MAX = 32n << 30n;
export const RAM_MIN_MIB = 64;
export const RAM_MAX_MIB = Number((0x40_0000_0000n - RAM_BASE) >> 20n); // 255 GiB
export const RAM_DEFAULT_MIB = 512;
export const RAM_CHOICES_MIB = [64, 128, 256, 512, 1024, 2048, 4096, 16384, RAM_MAX_MIB];
export const IMAGE_HEADER_SIZE = 64;
export const TEXT_OFFSET_ALIGN = 4096n;
export const ZBOOT_HEADER_LEN = 56;
export const ZBOOT_MAX_OUTPUT = 256n << 20n;
export const CPSR = 0x3c5n;
export const DEFAULT_CMDLINE = "console=ttyAMA0 earlycon=pl011,0x09000000";
export const LOAD_PREFIX = "macvmm: cannot load the guest: ";

/** How many bytes one read may take, and how many extra windows a file may ask for. */
export const READ_WINDOW = 4096;
export const MAX_EXTRA_READS = 4;
/** At most this many PE sections are decoded (a hostile count is capped, not trusted). */
export const MAX_SECTIONS = 16;
/** The hex grid shows, and lets you edit, the first 64 bytes. */
export const GRID = 64;

const MAGIC_ELF = [0x7f, 0x45, 0x4c, 0x46];
const MAGIC_IMAGE = [0x41, 0x52, 0x4d, 0x64]; // "ARM\x64"
const MAGIC_MZ = [0x4d, 0x5a];
const MAGIC_ZIMG = [0x7a, 0x69, 0x6d, 0x67];
const MAGIC_PE = [0x50, 0x45, 0, 0];
const LINUX_PE_MAGIC = 0x818223cd;

// ---- formatting (Rust's {:#x} and {:?} where the messages use them) ----

/** Rust `{:#x}`: lower-case hex with 0x. */
export function hx(v) {
  return `0x${BigInt(v).toString(16)}`;
}

/** Hex with `_` every four digits, as the lessons write long numbers (0x4020_0000). */
export function hxu(v) {
  const s = BigInt(v).toString(16);
  return `0x${s.replace(/\B(?=([0-9a-f]{4})+$)/g, "_")}`;
}

/**
 * Rust `{:?}` of a String, as `ZbootError::Compression` prints the hostile compression name.
 * str's Debug calls `char::escape_debug_ext` with grapheme extenders escaped: `\0 \t \r \n \\ \"`
 * get their short escapes, and every grapheme extender or non-printable code point becomes
 * `\u{hex}`. Rust's `is_printable` treats the general categories Cc, Cf, Cs, Co, Cn, Zl, Zp and
 * Zs (except the space) as non-printable (`core/src/unicode/printable.py`). The JS engine's
 * Unicode tables may be a version older or newer than Rust's, so a code point assigned in only
 * one of them can differ; everything the lab's presets and tests use agrees.
 */
const RUST_ESCAPED = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}\p{Grapheme_Extend}]/u;
export function rustDebugStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c === 0) out += "\\0";
    else if (ch !== " " && RUST_ESCAPED.test(ch)) out += `\\u{${c.toString(16)}}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Bytes as lower-case hex pairs, no separator. */
export function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** A hex string (even length, [0-9a-f]) to bytes; throws on anything else. */
export function fromHex(s) {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ---- the sparse view ----

/**
 * A view of a file of `length` bytes (BigInt) of which only `chunks` ([{off, bytes}]) were read.
 * `patches` (offset -> byte) override bytes inside the file. `byte(off)` is a number, or
 * undefined when the offset is past the end of the file or was never read; `state(off)` says
 * which ("byte", "absent" or "unread").
 */
export function makeView(length, chunks, patches = {}) {
  const len = BigInt(length);
  const list = chunks.map((c) => ({ off: c.off, bytes: c.bytes }));
  const pmap = new Map();
  for (const [k, v] of Object.entries(patches)) {
    const off = Number(k);
    if (Number.isInteger(off) && off >= 0 && off < GRID && BigInt(off) < len) pmap.set(off, v & 0xff);
  }
  const raw = (off) => {
    for (const c of list) {
      if (off >= c.off && off < c.off + c.bytes.length) return c.bytes[off - c.off];
    }
    return undefined;
  };
  const inFile = (off) => Number.isSafeInteger(off) && off >= 0 && BigInt(off) < len;
  return {
    length: len,
    byte(off) {
      if (!inFile(off)) return undefined;
      if (pmap.has(off)) return pmap.get(off);
      return raw(off);
    },
    original(off) {
      return inFile(off) ? raw(off) : undefined;
    },
    patched(off) {
      return pmap.has(off);
    },
    state(off) {
      if (!inFile(off)) return "absent";
      return pmap.has(off) || raw(off) !== undefined ? "byte" : "unread";
    },
    chunks: list,
  };
}

function bytesAt(view, off, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const b = view.byte(off + i);
    if (b === undefined) return null;
    out.push(b);
  }
  return out;
}

function eq(view, off, magic) {
  const b = bytesAt(view, off, magic.length);
  return b !== null && b.every((x, i) => x === magic[i]);
}

export function le16(view, off) {
  const b = bytesAt(view, off, 2);
  return b && b[0] | (b[1] << 8);
}

export function le32(view, off) {
  const b = bytesAt(view, off, 4);
  return b && (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}

export function le64(view, off) {
  const b = bytesAt(view, off, 8);
  if (!b) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

// ---- detect (loader/mod.rs) ----

/** "elf", "zboot", "image" or "raw", tested in the loader's order. Total: any input gets an answer. */
export function detect(view) {
  if (eq(view, 0, MAGIC_ELF)) return "elf";
  if (eq(view, 0, MAGIC_MZ) && eq(view, 4, MAGIC_ZIMG)) return "zboot";
  if (eq(view, 56, MAGIC_IMAGE)) return "image";
  return "raw";
}

export const KIND_NAMES = {
  elf: "an ELF file",
  zboot: "an EFI zboot wrapper",
  image: "an arm64 Image",
  raw: "not a kernel macvmm recognises (no ELF, zboot or Image magic)",
};

// ---- the Image header (loader/image.rs) ----

/** Header field layout, for the hex grid and the field table. */
export const IMAGE_FIELDS = [
  { id: "code0", from: 0, to: 3, name: "code0", what: "an instruction (execution starts here)" },
  { id: "code1", from: 4, to: 7, name: "code1", what: "an instruction: a branch past the header" },
  { id: "text_offset", from: 8, to: 15, name: "text_offset", what: "how far above a 2 MiB-aligned base to load" },
  { id: "image_size", from: 16, to: 23, name: "image_size", what: "bytes the kernel needs, BSS included" },
  { id: "flags", from: 24, to: 31, name: "flags", what: "endianness, page size, placement" },
  { id: "reserved", from: 32, to: 55, name: "res2..res4", what: "reserved, ignored" },
  { id: "magic", from: 56, to: 59, name: "magic", what: "ARM\\x64" },
  { id: "res5", from: 60, to: 63, name: "res5", what: "PE header offset for UEFI, ignored by macvmm" },
];

export const ZBOOT_FIELDS = [
  { id: "mz", from: 0, to: 1, name: "MZ", what: "DOS magic: PE/COFF starts here" },
  { id: "unused", from: 2, to: 3, name: "unused", what: "not read by anyone" },
  { id: "zimg", from: 4, to: 7, name: "zimg", what: "image type: this is a zboot image" },
  { id: "payload_offset", from: 8, to: 11, name: "payload offset", what: "where the compressed kernel starts" },
  { id: "payload_size", from: 12, to: 15, name: "payload size", what: "how many bytes it takes" },
  { id: "reserved", from: 16, to: 23, name: "reserved", what: "0" },
  { id: "compression", from: 24, to: 55, name: "compression", what: "name of the compressor, NUL-terminated" },
  { id: "linux_pe_magic", from: 56, to: 59, name: "Linux PE magic", what: "0x818223cd (not ARM\\x64)" },
  { id: "e_lfanew", from: 60, to: 63, name: "e_lfanew", what: "file offset of the PE header" },
];

export function fieldAt(fields, off) {
  return fields.find((f) => off >= f.from && off <= f.to) || null;
}

const PAGE_SIZES = ["Unspecified", "K4", "K16"];
const PAGE_WORDS = ["unspecified", "4 KiB", "16 KiB", "64 KiB"];

/** The header's fields, decoded (null where the bytes are absent). */
export function imageFields(view) {
  const flags = le64(view, 24);
  const pageField = flags === null ? null : Number((flags >> 1n) & 3n);
  return {
    code0: le32(view, 0),
    code1: le32(view, 4),
    textOffset: le64(view, 8),
    imageSize: le64(view, 16),
    flags,
    bigEndian: flags === null ? null : (flags & 1n) !== 0n,
    pageField,
    pageWords: pageField === null ? null : PAGE_WORDS[pageField],
    anywhere: flags === null ? null : (flags & 8n) !== 0n,
    reservedFlags: flags === null ? null : flags >> 4n,
    magic: bytesAt(view, 56, 4),
    res5: le32(view, 60),
  };
}

/**
 * Every check `parse_header` makes, in its order. Each is evaluated on its own (pass true/false,
 * or null when the bytes it needs are absent); `first` is the index of the first failure, which
 * is the one macvmm reports, and `error` its message (the Display of the LoaderError).
 *
 * With `lengthKnown` false (pasted rows and no length typed), `view.length` is only a lower
 * bound: the file holds at least that many bytes. The two length checks then pass or fail only
 * when the bound decides them, and are null ("not decided") otherwise. `undecided` is the index
 * of a null check reached before any failure (-1 if none). If only the last check, the file
 * against image_size, is undecided, `header` is still given, so the placement can be shown.
 */
export function checkImage(view, { lengthKnown = true } = {}) {
  const len = view.length;
  const f = imageFields(view);
  const checks = [];
  const add = (id, label, pass, error, detail) => checks.push({ id, label, pass, error, detail });
  add(
    "length",
    "The file holds the whole 64-byte header",
    len >= 64n ? true : lengthKnown ? false : null,
    `arm64 Image is ${len} bytes, shorter than its 64-byte header`,
    lengthKnown ? `file length ${len} bytes` : `file length unknown; ${len} bytes pasted`,
  );
  add(
    "magic",
    "magic is ARM\\x64 at offset 0x38",
    eq(view, 56, MAGIC_IMAGE),
    "arm64 Image magic ARM\\x64 missing at offset 56",
    f.magic ? `bytes ${f.magic.map((b) => b.toString(16).padStart(2, "0")).join(" ")}` : "bytes not in the file",
  );
  add(
    "endian",
    "Little-endian kernel (flags bit 0 is 0)",
    f.flags === null ? null : !f.bigEndian,
    "arm64 Image is a big-endian kernel (flags bit 0)",
    f.flags === null ? "flags not in the file" : `bit 0 = ${f.bigEndian ? 1 : 0}`,
  );
  add(
    "page",
    "Page size Apple Silicon has (flags bits 2:1 are 0, 1 or 2)",
    f.flags === null ? null : f.pageField !== 3,
    `arm64 Image page-size field ${f.pageField} (64 KiB pages) is not supported by Apple Silicon; use a 4K or 16K kernel`,
    f.flags === null ? "flags not in the file" : `field ${f.pageField}: ${f.pageWords}`,
  );
  add(
    "size",
    "image_size is not 0",
    f.imageSize === null ? null : f.imageSize !== 0n,
    "arm64 Image has image_size 0 (a kernel older than 3.17), so its memory use is unknown",
    f.imageSize === null ? "image_size not in the file" : `image_size ${hx(f.imageSize)}`,
  );
  add(
    "offset",
    "text_offset is a multiple of 4 KiB",
    f.textOffset === null ? null : f.textOffset % TEXT_OFFSET_ALIGN === 0n,
    `arm64 Image text_offset ${f.textOffset === null ? "?" : hx(f.textOffset)} is not 4 KiB-aligned`,
    f.textOffset === null ? "text_offset not in the file" : `text_offset ${hx(f.textOffset)}`,
  );
  add(
    "filelen",
    "The file is no longer than image_size",
    f.imageSize === null ? null : len > f.imageSize ? false : lengthKnown ? true : null,
    `arm64 Image file (${hx(len)} bytes) is longer than its image_size ${f.imageSize === null ? "?" : hx(f.imageSize)}`,
    f.imageSize === null
      ? "image_size not in the file"
      : lengthKnown
        ? `file ${hx(len)}, image_size ${hx(f.imageSize)}`
        : `file length unknown (at least ${hx(len)}), image_size ${hx(f.imageSize)}`,
  );
  // parse_header stops at the first failure. With a known length, a check whose bytes are
  // absent can only be reached when the length check already failed, so null never decides the
  // outcome; with an unknown length, a null reached first leaves the outcome open.
  const stop = checks.findIndex((c) => c.pass !== true);
  const first = stop !== -1 && checks[stop].pass === false ? stop : -1;
  const undecided = stop !== -1 && checks[stop].pass === null ? stop : -1;
  const onlyFileLen = undecided === checks.length - 1;
  return {
    fields: f,
    checks,
    first,
    undecided,
    lengthKnown,
    error: first === -1 ? null : checks[first].error,
    header:
      first === -1 && (undecided === -1 || onlyFileLen)
        ? {
            textOffset: f.textOffset,
            imageSize: f.imageSize,
            flags: f.flags,
            pageSize: PAGE_SIZES[f.pageField],
            anywhere: f.anywhere,
          }
        : null,
  };
}

// ---- placement (image.rs place, initrd.rs place/check_window, mod.rs RamRange) ----

function contains(ram, addr, len) {
  const end = addr + len;
  const ramEnd = ram.base + ram.size;
  if (end > U64_MAX || ramEnd > U64_MAX) return false;
  return len > 0n && addr >= ram.base && end <= ramEnd;
}

function outsideRam(what, addr, len) {
  return `${what} (${hx(len)} bytes at ${hx(addr)}) does not fit inside guest RAM`;
}

/** image.rs `place`: the kernel at LINUX_IMAGE_BASE + text_offset, image_size bytes inside RAM. */
export function placeKernel(header, ram) {
  const what = "kernel (arm64 Image)";
  const load = LINUX_IMAGE_BASE + header.textOffset;
  if (load > U64_MAX) return { error: outsideRam(what, U64_MAX, header.imageSize), step: "load" };
  const end = load + header.imageSize;
  if (end > U64_MAX) return { error: outsideRam(what, load, header.imageSize), step: "end", load, wrapped: end & U64_MAX };
  if (!contains(ram, load, header.imageSize)) return { error: outsideRam(what, load, header.imageSize), step: "ram", load, end };
  return { error: null, load, end };
}

export function alignUp(x, align) {
  const v = x + (align - 1n);
  if (v > U64_MAX) return null;
  return v & ~(align - 1n);
}

/** initrd.rs `place` then `check_window`. */
export function placeInitrd(ram, kStart, kEnd, size) {
  if (size === 0n) return { error: "--initrd is empty" };
  const start = alignUp(kEnd, LINUX_ALIGN);
  if (start === null) return { error: outsideRam("initrd", kEnd, size) };
  const end = start + size;
  if (end > U64_MAX) return { error: outsideRam("initrd", start, size), start };
  if (size > ram.size || !contains(ram, start, size)) return { error: outsideRam("initrd", start, size), start, end };
  const low = kStart < start ? kStart : start;
  const base = low & ~(LINUX_WINDOW_ALIGN - 1n);
  const high = kEnd > end ? kEnd : end;
  if (high < base || high - base > LINUX_WINDOW_MAX) {
    return {
      error: `initrd ${hx(start)}..${hx(end)} and the kernel do not fit one 1 GiB-aligned 32 GiB window (booting.rst §4); use less RAM or a smaller initrd`,
      start,
      end,
    };
  }
  return { error: null, start, end };
}

/** `--mem` rules (layout.rs `ram_end`), in MiB. Returns an error message or null. */
export function ramError(mib) {
  if (!Number.isInteger(mib)) return "RAM size must be a whole number of MiB";
  const size = BigInt(mib) << 20n;
  if (mib < RAM_MIN_MIB) return `RAM size ${hx(size)} is below the minimum 0x4000000 (64 MiB)`;
  if (mib > RAM_MAX_MIB) return `RAM size ${hx(size)} is above the maximum ${hx(BigInt(RAM_MAX_MIB) << 20n)} (255 GiB)`;
  if (mib % 2 !== 0) return `RAM size ${hx(size)} is not a multiple of 2 MiB`;
  return null;
}

function pad8(s) {
  return s.padEnd(8, " ");
}

/**
 * plan.rs `plan` for `--kernel FILE [--initrd SIZE] --mem RAM`, as far as the kernel and the
 * initrd go (the device tree is built later by macvmm; this lab never claims its size).
 * Returns {kind, stage, error, message, exit, lines, kernel, initrd, image}.
 *   stage: where it stopped: "detect", "elf", "header", "undecided" (the header checks need
 *   bytes or a file length the lab does not have), "kernel", "initrd", or "ok". With
 *   `lengthKnown` false the plan may still reach "ok"; the header line then prints file=?.
 */
export function planBoot(view, ramMiB, initrdSize, { lengthKnown = true } = {}) {
  const kind = detect(view);
  const ram = { base: RAM_BASE, size: BigInt(ramMiB) << 20n };
  const out = { kind, stage: "detect", error: null, message: null, exit: null, lines: [], image: null, kernel: null, initrd: null };
  const fail = (stage, error) => Object.assign(out, { stage, error, message: LOAD_PREFIX + error, exit: 2 });
  const ramErr = ramError(ramMiB);
  if (ramErr) return fail("detect", ramErr);
  if (kind !== "image" && initrdSize !== null) return fail("detect", "--initrd needs an arm64 Image --kernel");
  if (kind === "elf") {
    out.stage = "elf";
    return out;
  }
  if (kind === "zboot") return fail("detect", "EFI zboot image; run scripts/fetch.sh linux (unwraps it) or pass the raw Image");
  if (kind === "raw") return fail("detect", "--kernel is not an ELF file; load a flat binary with --raw F@ADDR");
  const img = checkImage(view, { lengthKnown });
  out.image = img;
  if (img.error) return fail("header", img.error);
  if (!img.header) {
    out.stage = "undecided";
    return out;
  }
  const k = placeKernel(img.header, ram);
  out.kernel = k;
  if (k.error) return fail("kernel", k.error);
  // OverlapsDtb cannot happen here: the kernel starts at or above LINUX_IMAGE_BASE, the end of
  // the 2 MiB DTB slot.
  if (initrdSize !== null) {
    const r = placeInitrd(ram, k.load, k.end, initrdSize);
    out.initrd = r;
    if (r.error) return fail("initrd", r.error);
  }
  out.stage = "ok";
  out.exit = 0;
  const lines = [`${pad8("ram")}${hx(ram.base)}..${hx(ram.base + ram.size)}  ${ramMiB} MiB`];
  lines.push(`${pad8("kernel")}${hx(k.load)}..${hx(k.end)}  kernel (arm64 Image) (${img.header.imageSize} bytes)`);
  if (initrdSize !== null) lines.push(`${pad8("initrd")}${hx(out.initrd.start)}..${hx(out.initrd.end)}  initrd (${initrdSize} bytes)`);
  lines.push(
    `${pad8("header")}text_offset=${hx(img.header.textOffset)} image_size=${hx(img.header.imageSize)} file=${lengthKnown ? hx(view.length) : "?"} page_size=${img.header.pageSize}`,
  );
  lines.push(`${pad8("cmdline")}"${DEFAULT_CMDLINE}"`);
  lines.push(`${pad8("entry")}pc=${hx(k.load)} x0=${hx(RAM_BASE)} cpsr=${hx(CPSR)}`);
  out.lines = lines;
  return out;
}

/**
 * The placement map for the readout: RAM from its base, with the DTB slot, the kernel's file
 * bytes, the rest of image_size (BSS), the rounding gap, the initrd and the free rest. Every
 * segment is [from, to) in guest physical addresses. Only drawn for a plan that succeeded.
 */
export function placementMap(plan, ramMiB, fileLength) {
  if (plan.stage !== "ok") return null;
  const ramEnd = RAM_BASE + (BigInt(ramMiB) << 20n);
  const k = plan.kernel;
  const fileEnd = k.load + minBig(BigInt(fileLength), plan.image.header.imageSize);
  const segs = [];
  segs.push({ id: "dtb", from: RAM_BASE, to: LINUX_IMAGE_BASE, label: "DTB slot (x0 points here; the DTB is a few KiB)" });
  if (k.load > LINUX_IMAGE_BASE) segs.push({ id: "gap", from: LINUX_IMAGE_BASE, to: k.load, label: "text_offset gap" });
  segs.push({ id: "kfile", from: k.load, to: fileEnd, label: "kernel: the file's bytes (PC points here)" });
  if (k.end > fileEnd) segs.push({ id: "bss", from: fileEnd, to: k.end, label: "kernel: rest of image_size (BSS, zeroed by the kernel)" });
  let top = k.end;
  if (plan.initrd) {
    if (plan.initrd.start > k.end) segs.push({ id: "gap", from: k.end, to: plan.initrd.start, label: "gap (rounded up to 2 MiB)" });
    segs.push({ id: "initrd", from: plan.initrd.start, to: plan.initrd.end, label: "initramfs" });
    top = plan.initrd.end;
  }
  if (ramEnd > top) segs.push({ id: "free", from: top, to: ramEnd, label: "free RAM" });
  return { from: RAM_BASE, to: ramEnd, segments: segs };
}

/**
 * The tempting wrong plan the `arm64-boot-protocol` primer warns about: the initramfs placed
 * right after the file's last byte instead of after image_size. Drawn beside the real plan when
 * the kernel has BSS (image_size longer than the file) and an initrd is set; `overlap` is how
 * many initramfs bytes land inside the BSS, which the kernel zeroes early. Never what macvmm
 * does; the lab draws it so the overlap can be seen.
 */
export function wrongPlanMap(plan, ramMiB, fileLength) {
  if (plan.stage !== "ok" || !plan.initrd) return null;
  const k = plan.kernel;
  const fileEnd = k.load + minBig(BigInt(fileLength), plan.image.header.imageSize);
  if (k.end <= fileEnd) return null;
  const ramEnd = RAM_BASE + (BigInt(ramMiB) << 20n);
  const size = plan.initrd.end - plan.initrd.start;
  const start = fileEnd;
  const end = start + size; // start + size <= the real plan's end, which fits in RAM
  const overlapEnd = minBig(end, k.end);
  const segs = [];
  segs.push({ id: "dtb", from: RAM_BASE, to: LINUX_IMAGE_BASE, label: "DTB slot" });
  if (k.load > LINUX_IMAGE_BASE) segs.push({ id: "gap", from: LINUX_IMAGE_BASE, to: k.load, label: "text_offset gap" });
  segs.push({ id: "kfile", from: k.load, to: fileEnd, label: "kernel: the file's bytes" });
  segs.push({ id: "overlap", from: start, to: overlapEnd, label: "initramfs inside the kernel's BSS: zeroed by the kernel early" });
  if (end > k.end) segs.push({ id: "initrd", from: k.end, to: end, label: "rest of the initramfs (survives)" });
  else if (k.end > end) segs.push({ id: "bss", from: end, to: k.end, label: "rest of the BSS" });
  const top = end > k.end ? end : k.end;
  if (ramEnd > top) segs.push({ id: "free", from: top, to: ramEnd, label: "free RAM" });
  return { from: RAM_BASE, to: ramEnd, segments: segs, start, end, overlap: overlapEnd - start };
}

function minBig(a, b) {
  return a < b ? a : b;
}

/**
 * Lay segments [from, to) of a range out on a bar `width` units wide. Each non-empty segment
 * gets at least `min` units so a 2 MiB slot stays visible beside 255 GiB of free RAM; the rest
 * is shared in proportion. Returns [{...segment, x, w}] with integer x and w summing to width.
 */
export function barLayout(segments, from, to, width = 1000, min = 8) {
  const total = to - from;
  const segs = segments.filter((s) => s.to > s.from);
  if (total <= 0n || segs.length === 0) return [];
  const floor = Math.min(min, Math.floor(width / segs.length));
  const spare = width - floor * segs.length;
  const scale = 1_000_000n;
  let x = 0;
  const out = segs.map((s, i) => {
    const share = Number(((s.to - s.from) * scale) / total) / Number(scale);
    let w = floor + Math.floor(share * spare);
    if (i === segs.length - 1) w = width - x;
    const r = { ...s, x, w };
    x += w;
    return r;
  });
  return out;
}

// ---- zboot (xtask/src/zboot.rs) and PE/COFF ----

const MACHINES = { 0xaa64: "ARM64", 0x8664: "x86-64", 0x14c: "i386", 0x1c4: "ARMv7 Thumb-2", 0x5064: "RISC-V 64" };
const SUBSYSTEMS = { 10: "EFI application", 11: "EFI boot service driver", 12: "EFI runtime driver", 3: "Windows console" };
const GZ_OS = { 0: "FAT (MS-DOS)", 3: "Unix", 7: "Macintosh", 11: "NTFS", 255: "unknown" };
const GZ_XFL = { 0: "no hint", 2: "maximum compression", 4: "fastest" };

function asciiName(bytes) {
  let s = "";
  for (const b of bytes) {
    if (b === 0) break;
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  return s;
}

/** The PE header at `e` (a file offset): signature, machine, section count, subsystem, sections. */
export function parsePe(view, e) {
  if (e === null) return null;
  const pe = { offset: e, signature: null, machine: null, machineName: null, sections: null, optMagic: null, entry: null, subsystem: null, subsystemName: null, sectionTable: [], sectionsCapped: false, error: null };
  const sig = bytesAt(view, e, 4);
  if (sig === null) {
    pe.error = view.state(e) === "absent" ? `e_lfanew ${hx(e)} points past the end of the file` : "PE header not read";
    return pe;
  }
  pe.signature = sig.every((b, i) => b === MAGIC_PE[i]);
  if (!pe.signature) {
    pe.error = `no PE\\0\\0 signature at ${hx(e)}`;
    return pe;
  }
  pe.machine = le16(view, e + 4);
  pe.machineName = pe.machine === null ? null : MACHINES[pe.machine] || "unknown";
  pe.sections = le16(view, e + 6);
  const optSize = le16(view, e + 20);
  const opt = e + 24;
  pe.optMagic = le16(view, opt);
  pe.optKind = pe.optMagic === 0x20b ? "PE32+" : pe.optMagic === 0x10b ? "PE32" : pe.optMagic === null ? null : "unknown";
  pe.entry = le32(view, opt + 16);
  pe.subsystem = le16(view, opt + 68);
  pe.subsystemName = pe.subsystem === null ? null : SUBSYSTEMS[pe.subsystem] || "other";
  if (optSize !== null && pe.sections !== null) {
    const n = Math.min(pe.sections, MAX_SECTIONS);
    pe.sectionsCapped = pe.sections > MAX_SECTIONS;
    for (let i = 0; i < n; i++) {
      const s = opt + optSize + 40 * i;
      const name = bytesAt(view, s, 8);
      if (name === null) break;
      pe.sectionTable.push({
        name: asciiName(name),
        vsize: le32(view, s + 8),
        va: le32(view, s + 12),
        rawSize: le32(view, s + 16),
        rawPtr: le32(view, s + 20),
      });
    }
  }
  return pe;
}

/** The gzip member header at `off` and the trailer ending at `end` (RFC 1952 section 2.3). */
export function parseGzip(view, off, end) {
  const g = { header: bytesAt(view, off, 10), magic: null, method: null, flags: null, mtime: null, xfl: null, os: null, crc32: null, isize: null };
  if (g.header) {
    const b = g.header;
    g.magic = b[0] === 0x1f && b[1] === 0x8b;
    g.method = b[2];
    g.methodName = b[2] === 8 ? "DEFLATE" : "not DEFLATE";
    g.flags = b[3];
    g.mtime = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
    g.xfl = b[8];
    g.xflName = GZ_XFL[b[8]] || "unknown";
    g.os = b[9];
    g.osName = GZ_OS[b[9]] || "other";
  }
  if (end !== null && end >= 8) {
    g.crc32 = le32(view, end - 8);
    g.isize = le32(view, end - 4);
  }
  return g;
}

/**
 * xtask `parse`, then `unwrap_with`'s gzip-magic check. Like checkImage, every check is also
 * evaluated alone; `first`/`error` are what `cargo xtask unzboot` would stop with. Inflating is
 * not done here (no DEFLATE in the browser lab): those checks are marked "notRun".
 */
export function inspectZboot(view) {
  const len = view.length;
  const payloadOffset = le32(view, 8);
  const payloadSize = le32(view, 12);
  const comp = bytesAt(view, 24, 32);
  let compression = null;
  let compressionTerminated = null;
  if (comp) {
    const n = comp.indexOf(0);
    compressionTerminated = n !== -1;
    compression = new TextDecoder("utf-8").decode(new Uint8Array(n === -1 ? comp : comp.slice(0, n)));
  }
  const end = payloadOffset === null || payloadSize === null ? null : BigInt(payloadOffset) + BigInt(payloadSize);
  const wrapped32 = end === null ? null : end & 0xffff_ffffn;
  const payloadInFile = end === null ? null : payloadSize !== 0 && end <= len && payloadOffset >= ZBOOT_HEADER_LEN;
  const eLfanew = le32(view, 0x3c);
  const gz = payloadInFile ? parseGzip(view, payloadOffset, Number(end)) : null;
  const checks = [];
  const add = (id, label, pass, error, detail) => checks.push({ id, label, pass, error, detail });
  add("magic", "MZ at 0 and zimg at 4", eq(view, 0, MAGIC_MZ) && eq(view, 4, MAGIC_ZIMG), "not an EFI zboot image (no MZ / zimg magic)", "the bytes the loader's detect() tests");
  add("length", "The file holds the 56-byte zboot header", len >= BigInt(ZBOOT_HEADER_LEN), "file too short for the zboot header", `file length ${len} bytes`);
  add(
    "terminated",
    "The compression name ends with a 0 byte",
    compressionTerminated,
    `unsupported compression ${rustDebugStr(compression ?? "")} (only gzip is supported)`,
    compression === null ? "name not in the file" : `name ${rustDebugStr(compression)}`,
  );
  add(
    "payload",
    "Payload lies inside the file (64-bit checked sum)",
    payloadInFile,
    `payload ${hx(payloadOffset ?? 0)}+${hx(payloadSize ?? 0)} lies outside the ${hx(len)}-byte file`,
    end === null
      ? "offset and size not in the file"
      : `${hx(payloadOffset)} + ${hx(payloadSize)} = ${hx(end)}; the file ends at ${hx(len)}`,
  );
  add(
    "gzip",
    "Compression is gzip",
    compression === null ? null : compression === "gzip",
    `unsupported compression ${rustDebugStr(compression ?? "")} (only gzip is supported)`,
    compression === null ? "name not in the file" : `name ${rustDebugStr(compression)}`,
  );
  add(
    "gzmagic",
    "Payload starts with the gzip magic 1f 8b",
    gz && gz.header ? gz.magic : null,
    "payload does not start with the gzip magic",
    gz && gz.header ? `first bytes ${toHex(gz.header.slice(0, 2))}` : payloadInFile ? "payload bytes not read" : "no payload to look at",
  );
  // parse() order: magic, length, (read offset and size), terminated name, payload range, gzip
  // name; then unwrap_with: gzip magic. A null (bytes not read) stops the scan without a verdict.
  let first = -1;
  let undecided = -1;
  for (let i = 0; i < checks.length; i++) {
    if (checks[i].pass === false) {
      first = i;
      break;
    }
    if (checks[i].pass === null) {
      undecided = i;
      break;
    }
  }
  return {
    fields: { payloadOffset, payloadSize, compression, linuxPeMagic: le32(view, 0x38), eLfanew },
    linuxPeMagicOk: le32(view, 0x38) === LINUX_PE_MAGIC,
    end,
    wrapped32,
    naive32Passes: wrapped32 === null ? null : wrapped32 <= len,
    checks,
    first,
    undecided,
    error: first === -1 ? null : checks[first].error,
    gzip: gz,
    notRun: [
      `Inflate with a hard cap of ${ZBOOT_MAX_OUTPUT >> 20n} MiB (ISIZE is only a hint)`,
      "The inflated output has ARM\\x64 at 0x38",
      "The output's sha256 matches the pinned Image-virt",
    ],
    pe: parsePe(view, eLfanew),
  };
}

/**
 * The zboot file laid out end to end, as the efi-zboot primer draws it: boundaries from the PE
 * header, the sections and the payload, each interval named by what holds it.
 */
export function zbootMap(z, length) {
  const len = BigInt(length);
  const cuts = new Set([0n, len]);
  const add = (v) => {
    if (v !== null && v !== undefined && BigInt(v) >= 0n && BigInt(v) <= len) cuts.add(BigInt(v));
  };
  const pe = z.pe;
  if (z.fields.eLfanew !== null) add(z.fields.eLfanew);
  const secs = pe && pe.sectionTable ? pe.sectionTable.filter((s) => s.rawPtr !== null && s.rawSize !== null && s.rawSize > 0) : [];
  for (const s of secs) {
    add(s.rawPtr);
    add(BigInt(s.rawPtr) + BigInt(s.rawSize));
  }
  const payload = z.checks.find((c) => c.id === "payload").pass ? [BigInt(z.fields.payloadOffset), z.end] : null;
  if (payload) {
    add(payload[0]);
    add(payload[1]);
  }
  const sorted = [...cuts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const firstSec = secs.length ? BigInt(Math.min(...secs.map((s) => s.rawPtr))) : null;
  const out = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    let id;
    let label;
    const sec = secs.find((s) => from >= BigInt(s.rawPtr) && to <= BigInt(s.rawPtr) + BigInt(s.rawSize));
    if (payload && from >= payload[0] && to <= payload[1]) [id, label] = ["payload", "gzip payload (the Image, compressed)"];
    else if (z.fields.eLfanew !== null && from < BigInt(z.fields.eLfanew)) [id, label] = ["hdr", "DOS + zboot header"];
    else if (sec && payload && sec.name === ".text" && to <= payload[0]) [id, label] = ["code", ".text: decompressor + EFI stub code"];
    else if (sec && payload && sec.name === ".text" && from >= payload[1]) [id, label] = ["stub", ".text: read-only data (the stub's strings and tables)"];
    else if (sec) [id, label] = [sec.name === ".text" ? "code" : "data", sec.name || "unnamed section"];
    else if (firstSec !== null && from < firstSec && z.fields.eLfanew !== null && from >= BigInt(z.fields.eLfanew)) [id, label] = ["pehdr", "PE headers"];
    else [id, label] = ["free", "in no section"];
    out.push({ id, from, to, label });
  }
  return out;
}

// ---- reading a dropped file: which windows to read after the first 4 KiB ----

/**
 * After the first READ_WINDOW bytes, the extra windows ({off, len}, each at most READ_WINDOW
 * bytes, at most MAX_EXTRA_READS) whose bytes the readout needs: the PE header (res5 or
 * e_lfanew) and, for zboot, the gzip header and trailer. Anything already read is skipped.
 */
export function wantedRanges(view) {
  const len = view.length;
  const want = [];
  const need = (off, n) => {
    if (off < 0 || BigInt(off) >= len) return;
    const max = Number(minBig(BigInt(off + n), len)) - off;
    for (let i = 0; i < max; i++) {
      if (view.state(off + i) === "unread") {
        want.push({ off, len: Math.min(max, READ_WINDOW) });
        return;
      }
    }
  };
  const e = le32(view, 0x3c);
  if (eq(view, 0, MAGIC_MZ) && e !== null) need(e, 24 + 240 + 40 * MAX_SECTIONS);
  if (detect(view) === "zboot") {
    const z = inspectZboot(view);
    if (z.checks.find((c) => c.id === "payload").pass) {
      need(z.fields.payloadOffset, 10);
      need(Number(z.end) - 8, 8);
    }
  }
  return want.slice(0, MAX_EXTRA_READS);
}

// ---- pasted xxd output ----

export const PASTE_MAX_BYTES = 4096;
export const PASTE_MAX_CHARS = 64 * 1024;

/**
 * Parse `xxd` (or `xxd -p`) output. Lines that are not hex rows (a `$` command, a capture's
 * comments) are skipped. Returns {chunks, end} or {error}. Hardened: at most 64 KiB of text and
 * 4 KiB of bytes, offsets below 2^32, rows in order without overlap.
 */
export function parseXxd(text) {
  if (typeof text !== "string" || text.length === 0) return { error: "Paste the output of xxd -l 64 FILE." };
  if (text.length > PASTE_MAX_CHARS) return { error: `That is more than ${PASTE_MAX_CHARS / 1024} KiB of text; paste only the first rows.` };
  const chunks = [];
  let total = 0;
  let next = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    let m = /^([0-9a-fA-F]{1,8}):((?: [0-9a-fA-F]{2,4})+)(?:  .*)?$/.exec(line);
    let off;
    let hex;
    if (m) {
      off = parseInt(m[1], 16);
      hex = m[2].replace(/ /g, "");
    } else if ((m = /^([0-9a-fA-F]{2})+$/.exec(line.trim())) && line.trim().length <= 128) {
      off = next;
      hex = line.trim();
    } else continue;
    if (hex.length % 2 !== 0 || hex.length > 64 * 2) return { error: `Cannot read the row at ${hx(off)}: odd number of hex digits.` };
    if (off < next) return { error: `Rows must be in order: ${hx(off)} comes after ${hx(next)}.` };
    const bytes = fromHex(hex);
    total += bytes.length;
    if (total > PASTE_MAX_BYTES) return { error: `At most ${PASTE_MAX_BYTES} bytes can be pasted.` };
    chunks.push({ off, bytes });
    next = off + bytes.length;
  }
  if (chunks.length === 0) return { error: "No xxd rows found. A row looks like 00000000: 4d5a 40fa ..." };
  return { chunks, end: next };
}

// ---- state ----

/** The default state: the unwrapped Alpine kernel with chapter 13's initrd, 512 MiB of RAM. */
export function initialState() {
  return { base: "image", patches: {}, length: null, ramMiB: RAM_DEFAULT_MIB, initrd: BASES.image.initrd, tryId: "alpine" };
}

/** Bytes and length for a state. `custom` is the view's own data for a dropped or pasted file. */
export function sourceFor(state, custom) {
  if (state.base === "image" || state.base === "zboot") {
    const b = BASES[state.base];
    return { length: b.length, chunks: b.chunks.map(([off, hex]) => ({ off, bytes: fromHex(hex) })) };
  }
  return custom || { length: 0n, chunks: [] };
}

export function viewFor(state, custom) {
  const src = sourceFor(state, custom);
  return makeView(state.length ?? src.length, src.chunks, state.patches);
}

/** Pasted rows carry no file length; it is known once the reader types one. */
export function lengthIsKnown(state) {
  return !(state.base === "paste" && state.length === null);
}

/**
 * Which Image check the readout marks "fails first". -1 when the loader never ran parse_header
 * (detect() already stopped it, or sent the file to the ELF loader): the checks are then shown as
 * "not run", each with what it would say on its own, so the list never names a different first
 * failure than the message macvmm prints.
 */
export function imageCheckFirst(plan, image) {
  if (!image || plan.stage === "detect" || plan.stage === "elf") return -1;
  return image.first;
}

/**
 * How the readout marks each check: {mark, word, cls}. `first` is the failing check (-1 for
 * none); `notRun` means the loader never ran these checks at all.
 */
export function checkMarks(checks, first, notRun = false) {
  return checks.map((c, i) => {
    if (notRun) {
      if (c.pass === true) return { mark: "–", word: "not run; on its own it would pass", cls: "skip" };
      if (c.pass === false) return { mark: "–", word: "not run; on its own it would fail", cls: "skip" };
      return { mark: "–", word: "not run; not decided on its own either", cls: "skip" };
    }
    if (first === -1 || i < first) {
      if (c.pass === true) return { mark: "✓", word: "pass", cls: "ok" };
      if (c.pass === null) return { mark: "?", word: "not decided", cls: "skip" };
      return { mark: "×", word: "not reached; on its own it would fail", cls: "skip" };
    }
    if (i === first) return { mark: "!", word: "fails first: the loader stops here", cls: "bad" };
    if (c.pass === false) return { mark: "×", word: "not reached; on its own it would fail too", cls: "skip" };
    return { mark: "–", word: "not reached", cls: "skip" };
  });
}

/** Everything the view renders, computed once per state. */
export function analyze(state, custom) {
  const view = viewFor(state, custom);
  const kind = detect(view);
  const lengthKnown = lengthIsKnown(state);
  const plan = planBoot(view, state.ramMiB, state.initrd, { lengthKnown });
  const image = kind === "zboot" ? null : checkImage(view, { lengthKnown });
  const zboot = kind === "zboot" ? inspectZboot(view) : null;
  const imagePe = kind !== "zboot" && eq(view, 0, MAGIC_MZ) ? parsePe(view, le32(view, 0x3c)) : null;
  return {
    view,
    kind,
    fields: kind === "zboot" ? ZBOOT_FIELDS : IMAGE_FIELDS,
    plan,
    image,
    zboot,
    imagePe,
    lengthKnown,
    checkFirst: imageCheckFirst(plan, image),
    map: placementMap(plan, state.ramMiB, view.length),
    wrongMap: lengthKnown ? wrongPlanMap(plan, state.ramMiB, view.length) : null,
    zmap: zboot ? zbootMap(zboot, view.length) : null,
  };
}

function normalizePatches(patches, src, length) {
  const out = {};
  const base = makeView(length, src.chunks);
  for (const [k, v] of Object.entries(patches)) {
    const off = Number(k);
    if (!Number.isInteger(off) || off < 0 || off >= GRID || BigInt(off) >= BigInt(length)) continue;
    if (base.original(off) !== v) out[off] = v & 0xff;
  }
  return out;
}

/**
 * next = step(state, action, custom). Actions:
 *   {type: "try", id}                  load a Try preset
 *   {type: "source", base}             start over from "image", "zboot", "file" or "paste"
 *   {type: "setByte", off, value}      patch one byte of the first 64
 *   {type: "setField", field, value}   write a 64-bit Image field (text_offset, image_size, flags)
 *   {type: "clearPatches"}
 *   {type: "setLength", value}         BigInt, or null for the file's own length
 *   {type: "setRam", mib}
 *   {type: "setInitrd", size}          BigInt > 0, or null for no --initrd
 * An invalid action returns the state unchanged.
 */
export function step(state, action, custom) {
  const s = { ...state, patches: { ...state.patches } };
  const src = () => sourceFor(s, custom);
  const len = () => s.length ?? src().length;
  switch (action.type) {
    case "try": {
      const t = TRIES.find((x) => x.id === action.id);
      if (!t) return state;
      return { base: t.base, patches: { ...t.patches }, length: t.length ?? null, ramMiB: state.ramMiB, initrd: t.initrd !== undefined ? t.initrd : BASES[t.base].initrd, tryId: t.id };
    }
    case "source": {
      if (!["image", "zboot", "file", "paste"].includes(action.base)) return state;
      const initrd = BASES[action.base] ? BASES[action.base].initrd : null;
      return { base: action.base, patches: {}, length: null, ramMiB: state.ramMiB, initrd, tryId: action.base === "image" ? "alpine" : action.base === "zboot" ? "zboot" : null };
    }
    case "setByte": {
      const { off, value } = action;
      if (!Number.isInteger(off) || off < 0 || off >= GRID || !Number.isInteger(value) || value < 0 || value > 255) return state;
      if (BigInt(off) >= len()) return state;
      s.patches[off] = value;
      s.patches = normalizePatches(s.patches, src(), len());
      s.tryId = null;
      return s;
    }
    case "setField": {
      const at = { text_offset: 8, image_size: 16, flags: 24 }[action.field];
      if (at === undefined || typeof action.value !== "bigint" || action.value < 0n || action.value > U64_MAX) return state;
      for (let i = 0; i < 8; i++) {
        if (BigInt(at + i) < len()) s.patches[at + i] = Number((action.value >> BigInt(8 * i)) & 0xffn);
      }
      s.patches = normalizePatches(s.patches, src(), len());
      s.tryId = null;
      return s;
    }
    case "clearPatches":
      s.patches = {};
      s.tryId = null;
      return s;
    case "setLength": {
      const v = action.value;
      if (v !== null && (typeof v !== "bigint" || v < 0n || v > U64_MAX)) return state;
      // Pasted rows have no length of their own, so a typed length always counts (even one equal
      // to the pasted bytes); for the other sources, the file's own length means "no override".
      s.length = v !== null && v === src().length && s.base !== "paste" ? null : v;
      s.patches = normalizePatches(s.patches, src(), len());
      s.tryId = null;
      return s;
    }
    case "setRam":
      if (ramError(action.mib)) return state;
      s.ramMiB = action.mib;
      return s;
    case "setInitrd": {
      const v = action.size;
      if (v !== null && (typeof v !== "bigint" || v <= 0n || v > U64_MAX)) return state;
      s.initrd = v;
      return s;
    }
    default:
      return state;
  }
}

/** Parse a number the reader typed: decimal, or hex with 0x; `_` allowed; at most 64 bits. */
export function parseNumber(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/_/g, "").toLowerCase();
  if (t.length === 0 || t.length > 20) return null;
  let v;
  if (/^0x[0-9a-f]{1,16}$/.test(t)) v = BigInt(t);
  else if (/^[0-9]{1,20}$/.test(t)) v = BigInt(t);
  else return null;
  return v > U64_MAX ? null : v;
}

// ---- share state (#image-inspector=...) ----

/**
 * `<base>[.p<off>=<hex bytes>]...[.l<hex length>][.m<RAM MiB>][.i<hex initrd size>|.i0]`.
 * Only the two preset files can be shared; a dropped or pasted file never leaves the tab.
 * The default state encodes to null (the hash is cleared).
 */
export function encode(state) {
  if (state.base !== "image" && state.base !== "zboot") return null;
  const b = BASES[state.base];
  const length = state.length ?? b.length;
  const patches = normalizePatches(state.patches, sourceFor(state), length);
  const toks = [state.base];
  const offs = Object.keys(patches).map(Number).sort((a, b2) => a - b2);
  for (let i = 0; i < offs.length; ) {
    let j = i;
    while (j + 1 < offs.length && offs[j + 1] === offs[j] + 1) j++;
    toks.push(`p${offs[i].toString(16)}=${toHex(offs.slice(i, j + 1).map((o) => patches[o]))}`);
    i = j + 1;
  }
  if (state.length !== null && state.length !== b.length) toks.push(`l${state.length.toString(16)}`);
  if (state.ramMiB !== RAM_DEFAULT_MIB) toks.push(`m${state.ramMiB}`);
  if (state.initrd !== b.initrd) toks.push(state.initrd === null ? "i0" : `i${state.initrd.toString(16)}`);
  const s = toks.join(".");
  return s === "image" ? null : s;
}

export function decode(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 512) return null;
  const toks = str.split(".");
  const base = toks.shift();
  if (base !== "image" && base !== "zboot") return null;
  let s = step(initialState(), { type: "source", base });
  const patches = {};
  let length = null;
  for (const t of toks) {
    let m;
    if ((m = /^p([0-9a-f]{1,2})=((?:[0-9a-f]{2}){1,64})$/.exec(t))) {
      const off = parseInt(m[1], 16);
      const bytes = fromHex(m[2]);
      if (off + bytes.length > GRID) return null;
      bytes.forEach((v, i) => (patches[off + i] = v));
    } else if ((m = /^l([0-9a-f]{1,16})$/.exec(t))) {
      length = BigInt(`0x${m[1]}`);
    } else if ((m = /^m([0-9]{1,6})$/.exec(t))) {
      const mib = Number(m[1]);
      if (ramError(mib)) return null;
      s.ramMiB = mib;
    } else if ((m = /^i([0-9a-f]{1,16})$/.exec(t))) {
      const v = BigInt(`0x${m[1]}`);
      s.initrd = v === 0n ? null : v;
    } else return null;
  }
  s.length = length;
  s.patches = normalizePatches(patches, sourceFor(s), length ?? BASES[base].length);
  const match = TRIES.find((t) => encode({ ...s, tryId: null }) === encode({ ...step(s, { type: "try", id: t.id }), ramMiB: s.ramMiB }));
  s.tryId = match ? match.id : null;
  return s;
}

// ---- the one-line summary for the live region ----

export function summary(a) {
  const p = a.plan;
  if (a.kind === "zboot") {
    const z = a.zboot;
    const unz = z.error ? `cargo xtask unzboot would stop: ${z.error}` : z.undecided !== -1 ? "the unwrapper's checks need bytes this view did not read" : "its header passes the unwrapper's checks";
    return `EFI zboot wrapper: macvmm refuses it by name (exit 2); ${unz}.`;
  }
  if (a.kind === "elf" && p.message) return `An ELF file, but ${p.message}`;
  if (a.kind === "elf") return "An ELF file: macvmm's ELF loader takes it, not the Image parser. This lab inspects Images and zboot wrappers.";
  if (p.stage === "ok" && !a.lengthKnown) {
    const rd = p.initrd ? `, initrd at ${hx(p.initrd.start)}` : "";
    return `arm64 Image: 6 of 7 header checks pass; the last needs the file length. Kernel at ${hx(p.kernel.load)}..${hx(p.kernel.end)}${rd}. macvmm would start it if the file is no longer than image_size.`;
  }
  if (p.stage === "undecided") {
    const c = a.image.checks[a.image.undecided];
    return `Not decided: ${c.label} (${c.detail}). Set the file length to finish the checks.`;
  }
  if (p.stage === "ok") {
    const rd = p.initrd ? `, initrd at ${hx(p.initrd.start)}` : "";
    return `arm64 Image: all 7 header checks pass. Kernel at ${hx(p.kernel.load)}..${hx(p.kernel.end)}${rd}. macvmm would start it.`;
  }
  if (p.stage === "header") {
    const c = a.image.checks[a.image.first];
    return `First failing check: ${c.label}. ${p.message}`;
  }
  if (p.stage === "kernel") return `All 7 header checks pass, but the kernel does not fit. ${p.message}`;
  if (p.stage === "initrd") return `The kernel fits, the initrd does not. ${p.message}`;
  if (a.kind === "raw") return `No ARM\\x64 at 0x38, so not an Image. ${p.message}`;
  return `${p.message}`;
}

export { BASES, TRIES };
