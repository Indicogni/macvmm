// elf-inspector model: pure logic, no DOM, no I/O.
//
// Three jobs:
//   1. decode an ELF file's header and program headers for display (lenient: shows whatever bytes are there);
//   2. run macvmm's ELF loader checks on it (strict: a port of `elf::parse` in crates/vmm/src/loader/elf.rs and
//      of the ELF arm of `plan()` in crates/vmm/src/loader/plan.rs, same rules, same order, same messages);
//   3. describe what a loader does with an accepted file: the file-to-memory map, the three sizes from the elf
//      primer, and the lines macvmm's `--dry-run` prints for it.
//
// The file is hostile input. Every read is bounds-checked, every 64-bit sum is computed as a BigInt and compared
// against 2^64 (the Rust code's checked_add / checked_mul), every count that sizes a loop is capped, and nothing
// read from the file is ever treated as markup by the view (it only receives plain strings and numbers).

import { SAMPLES } from "./samples.mjs";

export { SAMPLES };

export const MAX_FILE = 16 * 1024 * 1024; // the largest file the lab reads
export const RAM_BASE = 0x4000_0000n; // the machine's RAM base (QEMU virt layout, crates/vmm/src/arch/layout.rs)
export const DTB_SLOT = 512n * 1024n; // DTB_MAX_TEST_GUEST: the slot plan() reserves first for an ELF boot
// Only sizes macvmm accepts: at least RAM_MIN (64 MiB) and a multiple of 2 MiB (crates/vmm/src/arch/layout.rs,
// `ram_end`). 64 MiB is what chapter 13's captures use.
export const RAM_SIZES_MIB = [64, 128, 256, 512, 1024];
export const DEFAULT_RAM_MIB = 64;
export const EHDR_SIZE = 64;
export const PHDR_SIZE = 56;
export const SHDR_SIZE = 64;
export const MAX_PHNUM = 64;
export const EM_AARCH64 = 183;
export const ET_EXEC = 2;
export const PT_LOAD = 1;
export const PF_X = 1;
export const MAX_PATCHES = 16;
export const MAX_PATCH_BYTES = 16;
const MAX_SECTIONS_SHOWN = 256;
const U64_LIMIT = 1n << 64n;

// ---------------------------------------------------------------- small helpers

/** Lower-case hex with 0x, like Rust's {:#x}. Accepts number or BigInt. */
export function hex(v) {
  return "0x" + BigInt(v).toString(16);
}

/** Hex with an underscore every four digits, as the course writes addresses in prose (0x4008_0000). */
export function hexu(v) {
  const s = BigInt(v).toString(16);
  const parts = [];
  for (let end = s.length; end > 0; end -= 4) parts.unshift(s.slice(Math.max(0, end - 4), end));
  return "0x" + parts.join("_");
}

/** Zero-padded hex without 0x, `w` digits. */
export function hexPad(v, w) {
  return BigInt(v).toString(16).padStart(w, "0");
}

/** A byte count with thousands separators, the way the primer writes file sizes. */
export function commas(n) {
  return BigInt(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function bytesHex(b, off, len) {
  const out = [];
  for (let i = 0; i < len; i++) out.push(hexPad(b[off + i], 2));
  return out.join(" ");
}

/** Read an n-byte little-endian unsigned integer at `off`, or null when it does not fit in `b`. */
export function readLE(b, off, n) {
  if (typeof off === "bigint") {
    if (off < 0n || off > BigInt(b.length)) return null;
    off = Number(off);
  }
  if (!Number.isSafeInteger(off) || off < 0 || off + n > b.length) return null;
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]);
  return v;
}

/** u64 checked_add: null on overflow (the Rust code's `None`). */
export function checkedAdd(a, c) {
  const s = a + c;
  return s >= U64_LIMIT ? null : s;
}

function checkedMul(a, c) {
  const s = a * c;
  return s >= U64_LIMIT ? null : s;
}

function satAdd(a, c) {
  const s = a + c;
  return s >= U64_LIMIT ? U64_LIMIT - 1n : s;
}

/** `overlaps` in crates/vmm/src/loader/mod.rs: half-open ranges, ends saturate. */
export function overlaps(a, alen, c, clen) {
  return a < satAdd(c, clen) && c < satAdd(a, alen);
}

/** `RamRange::contains`: a non-empty range entirely inside RAM, with checked ends. */
export function ramContains(ram, addr, len) {
  const end = checkedAdd(addr, len);
  const ramEnd = checkedAdd(ram.base, ram.size);
  if (end === null || ramEnd === null) return false;
  return len > 0n && addr >= ram.base && end <= ramEnd;
}

export function ramFor(mib) {
  return { base: RAM_BASE, size: BigInt(mib) << 20n };
}

// ---------------------------------------------------------------- what the file looks like (detect)

/** `detect` in crates/vmm/src/loader/mod.rs, in the same order. */
export function detect(b) {
  const at = (off, s) => s.every((c, i) => b[off + i] === c);
  if (b.length >= 4 && at(0, [0x7f, 0x45, 0x4c, 0x46])) return "elf";
  if (b.length >= 8 && at(0, [0x4d, 0x5a]) && at(4, [0x7a, 0x69, 0x6d, 0x67])) return "efi-zboot";
  if (b.length >= 60 && at(56, [0x41, 0x52, 0x4d, 0x64])) return "arm64-image";
  return "raw";
}

// ---------------------------------------------------------------- errors, as macvmm prints them

/** The `Display` text of each LoaderError variant the ELF path can return. */
export function errorText(e) {
  switch (e.kind) {
    case "ElfTruncated":
      return `ELF file too short for its ${e.what}`;
    case "ElfUnsupported":
      return `unsupported ELF ${e.field} ${hex(e.value)} (need ELF64 LE AArch64 ET_EXEC)`;
    case "ElfTooManyPhdrs":
      return `ELF has ${e.phnum} program headers (at most ${MAX_PHNUM})`;
    case "ElfPhdrsOutOfFile":
      return "ELF program-header table lies outside the file";
    case "ElfSegmentOutOfFile":
      return `ELF segment ${e.index}: file bytes lie outside the file`;
    case "ElfFileszGtMemsz":
      return `ELF segment ${e.index}: p_filesz > p_memsz`;
    case "ElfVaddrNotPaddr":
      return `ELF segment ${e.index}: p_vaddr != p_paddr (the guest starts with the MMU off)`;
    case "ElfNoSegments":
      return "ELF has no loadable segment";
    case "ElfEntryNotExecutable":
      return `ELF entry ${hex(e.entry)} is not inside an executable segment`;
    case "OutsideRam":
      return `${e.what} (${hex(e.len)} bytes at ${hex(e.addr)}) does not fit inside guest RAM`;
    case "Overlap":
      return `${e.a} overlaps ${e.b}`;
    case "OverlapsDtb":
      return `${e.what} overlaps the device-tree slot at the start of RAM`;
    case "NotAKernel":
      return "--kernel is not an ELF file; load a flat binary with --raw F@ADDR";
    case "EfiZboot":
      return "EFI zboot image; run scripts/fetch.sh linux (unwraps it) or pass the raw Image";
    default:
      return "unknown error";
  }
}

/** The line macvmm writes to stderr before exiting with status 2. */
export function macvmmLine(e) {
  return `macvmm: cannot load the guest: ${errorText(e)}`;
}

// ---------------------------------------------------------------- the checks, in macvmm's order

/**
 * The loader's checks as rows, in the order macvmm makes them. `primer` is the number of the matching check in
 * the elf primer's list ("A loader's checks"), which puts the length check first; macvmm reads the 16 identification
 * bytes before it checks for the full 64, which is just as safe because each read is bounds-checked.
 */
export const CHECKS = [
  { id: "magic", primer: 2, title: "Starts with the ELF magic", detail: "7f 45 4c 46. Without it macvmm does not treat the file as ELF at all." },
  { id: "ident-len", primer: 1, title: "Holds the 16 identification bytes", detail: "e_ident must be readable before anything else." },
  { id: "ident", primer: 2, title: "64-bit, little-endian, version 1", detail: "EI_CLASS 2, EI_DATA 1, EI_VERSION 1." },
  { id: "header-len", primer: 1, title: "Holds the whole 64-byte header", detail: "Every later header read stays inside the file." },
  { id: "type", primer: 3, title: "An AArch64 executable", detail: "e_type 2 (ET_EXEC), e_machine 183 (EM_AARCH64), e_version 1." },
  { id: "phdrs", primer: 4, title: "The program-header table fits", detail: "e_phentsize 56, e_phnum at most 64, and e_phoff + e_phnum × 56 inside the file, with checked arithmetic." },
  { id: "segments", primer: 5, title: "Every PT_LOAD segment is sane", detail: "p_filesz ≤ p_memsz; its file bytes inside the file; p_vaddr = p_paddr; inside guest RAM; clear of the device-tree slot; clear of every other segment." },
  { id: "any", primer: 5, title: "At least one loadable segment", detail: "A file with nothing to load is refused." },
  { id: "entry", primer: 6, title: "The entry point is in executable code", detail: "e_entry lies inside a loaded segment whose flags include X." },
];

function stageOf(e) {
  switch (e.kind) {
    case "NotAKernel":
    case "EfiZboot":
    case "ArmImage":
      return "magic";
    case "ElfTruncated":
      return e.what === "e_ident" ? "ident-len" : e.what === "header" ? "header-len" : "phdrs";
    case "ElfUnsupported":
      if (e.field === "magic") return "magic";
      if (e.field.startsWith("EI_")) return "ident";
      if (e.field === "e_phentsize") return "phdrs";
      return "type";
    case "ElfTooManyPhdrs":
    case "ElfPhdrsOutOfFile":
      return "phdrs";
    case "ElfNoSegments":
      return "any";
    case "ElfEntryNotExecutable":
      return "entry";
    default:
      return "segments";
  }
}

// ---------------------------------------------------------------- the loader (a port of elf::parse)

function unsupported(field, value, off, len) {
  return { kind: "ElfUnsupported", field, value: BigInt(value), where: { off, len } };
}

/**
 * `validate_header` and `parse` from crates/vmm/src/loader/elf.rs. Returns
 * `{ ok: true, image: { entry, segments }, trace }` or `{ ok: false, error, trace }`. `error.where` is the byte
 * range that made the check fail (for the hex view); `trace` says what happened to each program header that the
 * loader looked at, in order.
 */
export function parseElf(b, ram, reserved = [{ addr: ram.base, len: DTB_SLOT < ram.size ? DTB_SLOT : ram.size }]) {
  const trace = [];
  const fail = (error) => ({ ok: false, error, trace });
  if (b.length < 16) return fail({ kind: "ElfTruncated", what: "e_ident", where: { off: 0, len: b.length } });
  if (!(b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)) return fail(unsupported("magic", 0, 0, 4));
  if (b[4] !== 2) return fail(unsupported("EI_CLASS", b[4], 4, 1));
  if (b[5] !== 1) return fail(unsupported("EI_DATA", b[5], 5, 1));
  if (b[6] !== 1) return fail(unsupported("EI_VERSION", b[6], 6, 1));
  if (b.length < EHDR_SIZE) return fail({ kind: "ElfTruncated", what: "header", where: { off: 0, len: b.length } });
  const eType = readLE(b, 16, 2);
  if (eType !== BigInt(ET_EXEC)) return fail(unsupported("e_type", eType, 16, 2));
  const machine = readLE(b, 18, 2);
  if (machine !== BigInt(EM_AARCH64)) return fail(unsupported("e_machine", machine, 18, 2));
  const eVersion = readLE(b, 20, 4);
  if (eVersion !== 1n) return fail(unsupported("e_version", eVersion, 20, 4));
  const entry = readLE(b, 24, 8);
  const phoff = readLE(b, 32, 8);
  const phentsize = readLE(b, 54, 2);
  if (phentsize !== BigInt(PHDR_SIZE)) return fail(unsupported("e_phentsize", phentsize, 54, 2));
  const phnum = Number(readLE(b, 56, 2));
  if (phnum > MAX_PHNUM) return fail({ kind: "ElfTooManyPhdrs", phnum, where: { off: 56, len: 2 } });
  const fileLen = BigInt(b.length);
  const n = checkedMul(BigInt(phnum), BigInt(PHDR_SIZE));
  const tableEnd = n === null ? null : checkedAdd(phoff, n);
  if (tableEnd === null || tableEnd > fileLen) {
    return fail({ kind: "ElfPhdrsOutOfFile", tableEnd, where: { off: 32, len: 8 } });
  }

  const segments = [];
  for (let index = 0; index < phnum; index++) {
    const off = Number(phoff) + index * PHDR_SIZE; // inside the file: tableEnd <= len, so this is small
    const pType = Number(readLE(b, off, 4));
    if (pType !== PT_LOAD) {
      trace.push({ index, outcome: "skipped", why: `${phTypeName(pType)} is not PT_LOAD; a loader skips it` });
      continue;
    }
    const flags = Number(readLE(b, off + 4, 4));
    const offset = readLE(b, off + 8, 8);
    const vaddr = readLE(b, off + 16, 8);
    const paddr = readLE(b, off + 24, 8);
    const filesz = readLE(b, off + 32, 8);
    const memsz = readLE(b, off + 40, 8);
    const at = (d, len) => ({ off: off + d, len });
    const bad = (error) => {
      trace.push({ index, outcome: "rejected", why: errorText(error) });
      return fail(error);
    };
    if (filesz > memsz) return bad({ kind: "ElfFileszGtMemsz", index, where: at(32, 16) });
    const fileEnd = checkedAdd(offset, filesz);
    if (fileEnd === null || fileEnd > fileLen) {
      return bad({ kind: "ElfSegmentOutOfFile", index, fileEnd, where: at(8, 8) });
    }
    if (memsz === 0n) {
      trace.push({ index, outcome: "skipped", why: "p_memsz is 0: it occupies no memory" });
      continue;
    }
    if (vaddr !== paddr) return bad({ kind: "ElfVaddrNotPaddr", index, where: at(16, 16) });
    const what = `ELF segment ${index}`;
    if (!ramContains(ram, paddr, memsz)) return bad({ kind: "OutsideRam", what, addr: paddr, len: memsz, where: at(24, 8) });
    if (reserved.some((r) => overlaps(paddr, memsz, r.addr, r.len))) return bad({ kind: "OverlapsDtb", what, where: at(24, 8) });
    const other = segments.find((s) => overlaps(paddr, memsz, s.paddr, s.memsz));
    if (other) return bad({ kind: "Overlap", a: what, b: `ELF segment ${other.index}`, where: at(24, 8) });
    segments.push({ index, paddr, offset, filesz, memsz, flags, exec: (flags & PF_X) !== 0 });
    trace.push({ index, outcome: "loaded" });
  }
  if (segments.length === 0) return fail({ kind: "ElfNoSegments", where: { off: 56, len: 2 } });
  const entryOk = segments.some((s) => s.exec && entry >= s.paddr && entry - s.paddr < s.memsz);
  if (!entryOk) return fail({ kind: "ElfEntryNotExecutable", entry, where: { off: 24, len: 8 } });
  return { ok: true, image: { entry, segments }, trace };
}

/**
 * What `macvmm run --kernel FILE` does with these bytes: `detect`, then the ELF loader. An arm64 Image is handed to
 * a different loader (the image-inspector lab), so it is reported as such, not as an error.
 */
export function loadAsKernel(b, ram) {
  const kind = detect(b);
  if (kind === "efi-zboot") return { kind, ok: false, error: { kind: "EfiZboot", where: { off: 0, len: 8 } }, trace: [] };
  if (kind === "raw") return { kind, ok: false, error: { kind: "NotAKernel", where: { off: 0, len: Math.min(4, b.length) } }, trace: [] };
  if (kind === "arm64-image") return { kind, ok: false, error: { kind: "ArmImage", where: { off: 56, len: 4 } }, trace: [] };
  return { kind, ...parseElf(b, ram) };
}

// ---------------------------------------------------------------- decoding for display (lenient)

const OSABI = { 0: "System V (SYSV)", 3: "Linux", 9: "FreeBSD", 97: "Arm" };
const MACHINES = { 0: "none", 3: "Intel 80386", 40: "32-bit Arm", 62: "x86-64", 183: "AArch64", 243: "RISC-V" };
const TYPES = { 0: "ET_NONE: no file type", 1: "ET_REL: an object file, not yet linked", 2: "ET_EXEC: a fully linked executable whose addresses the linker has already fixed", 3: "ET_DYN: a position-independent executable or shared library", 4: "ET_CORE: a core dump" };
const PH_TYPES = { 0: "NULL", 1: "LOAD", 2: "DYNAMIC", 3: "INTERP", 4: "NOTE", 5: "SHLIB", 6: "PHDR", 7: "TLS", 0x6474e550: "GNU_EH_FRAME", 0x6474e551: "GNU_STACK", 0x6474e552: "GNU_RELRO", 0x6474e553: "GNU_PROPERTY" };
const SH_TYPES = { 0: "NULL", 1: "PROGBITS", 2: "SYMTAB", 3: "STRTAB", 4: "RELA", 5: "HASH", 6: "DYNAMIC", 7: "NOTE", 8: "NOBITS", 9: "REL", 11: "DYNSYM", 14: "INIT_ARRAY", 15: "FINI_ARRAY" };

export function phTypeName(t) {
  return PH_TYPES[t] ?? `type ${hex(t)}`;
}

/** Program-header flags the way llvm-readobj prints them: "R E", "R  ", "RW ". */
export function flagsText(f) {
  return (f & 4 ? "R" : " ") + (f & 2 ? "W" : " ") + (f & 1 ? "E" : " ");
}

/** Flags in words, for screen readers and the summary. */
export function flagsWords(f) {
  const w = [];
  if (f & 4) w.push("read");
  if (f & 2) w.push("write");
  if (f & 1) w.push("execute");
  return w.length ? w.join(", ") : "no access";
}

function field(b, off, size, name, meaning) {
  if (off + size > b.length) return { off, size, name, present: false, bytes: "", value: null, meaning: "past the end of the file" };
  const value = readLE(b, off, size);
  return { off, size, name, present: true, bytes: bytesHex(b, off, size), value, meaning: meaning(value) };
}

/**
 * Whether the bytes say "64-bit little-endian ELF": the magic, EI_CLASS 2 and EI_DATA 1. Only then does the ELF64
 * little-endian layout (the one macvmm reads) apply to the rest of the header and to the program headers; a 32-bit
 * or big-endian file puts its fields at other offsets or in the other byte order.
 */
export function isElf64Le(b) {
  return detect(b) === "elf" && b.length > 5 && b[4] === 2 && b[5] === 1;
}

/** Why the fields after e_ident are not decoded, or null when they are. */
export function layoutNote(b) {
  if (detect(b) !== "elf") return "Not decoded: without the ELF magic the rest of these bytes are not an ELF header.";
  if (b.length <= 5) return "Not decoded: the file ends inside e_ident.";
  if (b[4] === 1) return "Not decoded: a 32-bit ELF file (EI_CLASS 1) uses a different, smaller header layout, so the 64-bit offsets below would point at the wrong bytes.";
  if (b[4] !== 2) return `Not decoded: EI_CLASS ${b[4]} is neither 32-bit nor 64-bit, so there is no layout to read the rest with.`;
  if (b[5] === 2) return "Not decoded: a big-endian ELF file (EI_DATA 2) stores every multi-byte field in the other byte order, so reading it little-endian would show wrong values.";
  if (b[5] !== 1) return `Not decoded: EI_DATA ${b[5]} is neither little- nor big-endian, so no byte order applies.`;
  return null;
}

/**
 * The ELF header's fields (gABI chapter 4, "ELF Header"), each with its bytes and a plain meaning. Without the
 * magic only the 4 magic bytes are shown; with it, the 16 e_ident bytes; the fields after e_ident only when
 * `isElf64Le` (see `layoutNote` for why not).
 */
export function decodeHeader(b) {
  const one = (off, name, m) => field(b, off, 1, name, m);
  const out = [];
  out.push(field(b, 0, 4, "magic", () => (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46 ? "0x7f then the letters E, L, F" : "not the ELF magic")));
  if (detect(b) !== "elf") return out;
  out.push(one(4, "EI_CLASS", (v) => (v === 2n ? "ELFCLASS64: 64-bit addresses and sizes" : v === 1n ? "ELFCLASS32: 32-bit, a different header layout" : "invalid class")));
  out.push(one(5, "EI_DATA", (v) => (v === 1n ? "ELFDATA2LSB: little-endian" : v === 2n ? "ELFDATA2MSB: big-endian" : "invalid byte order")));
  out.push(one(6, "EI_VERSION", (v) => (v === 1n ? "EV_CURRENT, the only version there has ever been" : "not version 1")));
  out.push(one(7, "EI_OSABI", (v) => OSABI[Number(v)] ?? `OS/ABI ${v}`));
  out.push(one(8, "EI_ABIVERSION", (v) => String(v)));
  out.push(field(b, 9, 7, "EI_PAD", () => "reserved padding"));
  if (!isElf64Le(b)) return out;
  out.push(field(b, 16, 2, "e_type", (v) => TYPES[Number(v)] ?? `type ${hex(v)}`));
  out.push(field(b, 18, 2, "e_machine", (v) => `${v}, ${MACHINES[Number(v)] ?? "another machine"}${v === 183n ? " (EM_AARCH64)" : ""}`));
  out.push(field(b, 20, 4, "e_version", (v) => String(v)));
  out.push(field(b, 24, 8, "e_entry", (v) => `${hexu(v)}, the first instruction`));
  out.push(field(b, 32, 8, "e_phoff", (v) => `program-header table at byte ${v}`));
  out.push(field(b, 40, 8, "e_shoff", (v) => `section-header table at ${hex(v)} (a loader never reads it)`));
  out.push(field(b, 48, 4, "e_flags", (v) => (v === 0n ? "no processor-specific flags" : hex(v))));
  out.push(field(b, 52, 2, "e_ehsize", (v) => `${v}, the size of this header`));
  out.push(field(b, 54, 2, "e_phentsize", (v) => `${v}, the size of one program header`));
  out.push(field(b, 56, 2, "e_phnum", (v) => `${v} program header${v === 1n ? "" : "s"}`));
  out.push(field(b, 58, 2, "e_shentsize", (v) => `${v}, the size of one section header`));
  out.push(field(b, 60, 2, "e_shnum", (v) => `${v} section header${v === 1n ? "" : "s"}`));
  out.push(field(b, 62, 2, "e_shstrndx", (v) => `section ${v} holds the section names`));
  return out;
}

export const PHDR_FIELDS = [
  { d: 0, size: 4, name: "p_type" },
  { d: 4, size: 4, name: "p_flags" },
  { d: 8, size: 8, name: "p_offset" },
  { d: 16, size: 8, name: "p_vaddr" },
  { d: 24, size: 8, name: "p_paddr" },
  { d: 32, size: 8, name: "p_filesz" },
  { d: 40, size: 8, name: "p_memsz" },
  { d: 48, size: 8, name: "p_align" },
];

/**
 * The program headers a reader can see: entries at e_phoff + i × 56 that lie wholly inside the file, at most 64
 * of them (macvmm's cap), even if the header is otherwise broken. `note` explains anything left out.
 */
export function decodePhdrs(b) {
  if (!isElf64Le(b)) return { list: [], note: detect(b) === "elf" ? "Not decoded: only a 64-bit little-endian ELF file has the program-header layout shown here." : "" };
  if (b.length < EHDR_SIZE) return { list: [], note: "The file is shorter than an ELF header, so there is no program-header table to show." };
  const phoff = readLE(b, 32, 8);
  const phnum = Number(readLE(b, 56, 2));
  const phentsize = Number(readLE(b, 54, 2));
  const list = [];
  const notes = [];
  const shown = Math.min(phnum, MAX_PHNUM);
  if (phnum > MAX_PHNUM) notes.push(`e_phnum says ${phnum}; only the first ${MAX_PHNUM} places are shown.`);
  for (let i = 0; i < shown; i++) {
    const off = phoff + BigInt(i * PHDR_SIZE);
    if (off + BigInt(PHDR_SIZE) > BigInt(b.length)) {
      notes.push(i === 0 ? `The table would start at ${hex(phoff)}, outside the ${commas(b.length)}-byte file.` : `Entries ${i} and later would lie past the end of the file.`);
      break;
    }
    const o = Number(off);
    const v = (d, n) => readLE(b, o + d, n);
    const type = Number(v(0, 4));
    const flags = Number(v(4, 4));
    list.push({
      index: i,
      off: o,
      type,
      typeName: phTypeName(type),
      flags,
      offset: v(8, 8),
      vaddr: v(16, 8),
      paddr: v(24, 8),
      filesz: v(32, 8),
      memsz: v(40, 8),
      align: v(48, 8),
      fields: PHDR_FIELDS.map((f) => ({ name: f.name, off: o + f.d, size: f.size, bytes: bytesHex(b, o + f.d, f.size), value: v(f.d, f.size) })),
    });
  }
  if (phentsize !== PHDR_SIZE && list.length) notes.unshift(`e_phentsize is ${phentsize}, not 56; the entries below are read 56 bytes apart, the only size macvmm accepts.`);
  return { list, note: notes.join(" ") };
}

/** One printable name from a string table: at most 64 characters, NUL-terminated, non-ASCII shown as escapes. */
function cString(b, start, limit) {
  let s = "";
  for (let i = start; i < limit && i < b.length && s.length < 64; i++) {
    const c = b[i];
    if (c === 0) return s;
    s += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : `\\x${hexPad(c, 2)}`;
  }
  return s;
}

/**
 * The section-header table, for the "two views of one file" comparison. The loader never reads it; this does, with
 * the same care: entry size 64, at most 256 entries shown, table and names inside the file.
 */
export function decodeSections(b, image) {
  if (b.length < EHDR_SIZE) return { list: [], note: "No header, so no section table." };
  const shoff = readLE(b, 40, 8);
  const shentsize = Number(readLE(b, 58, 2));
  const shnum = Number(readLE(b, 60, 2));
  const shstrndx = Number(readLE(b, 62, 2));
  if (shnum === 0) return { list: [], note: "e_shnum is 0: this file has no section table. It loads the same way, because a loader never reads one." };
  if (shentsize !== SHDR_SIZE) return { list: [], note: `e_shentsize is ${shentsize}, not 64, so the section table is not shown.` };
  const count = Math.min(shnum, MAX_SECTIONS_SHOWN);
  const end = checkedAdd(shoff, BigInt(count * SHDR_SIZE));
  if (end === null || end > BigInt(b.length)) return { list: [], note: `The section table (at ${hex(shoff)}) does not fit in the file.` };
  const base = Number(shoff);
  const sh = (i, d, n) => readLE(b, base + i * SHDR_SIZE + d, n);
  let strStart = -1;
  let strEnd = -1;
  if (shstrndx < count) {
    const o = sh(shstrndx, 24, 8);
    const sz = sh(shstrndx, 32, 8);
    const e = checkedAdd(o, sz);
    if (e !== null && e <= BigInt(b.length)) {
      strStart = Number(o);
      strEnd = Number(e);
    }
  }
  const segs = image ? image.segments : [];
  const list = [];
  for (let i = 0; i < count; i++) {
    const nameOff = sh(i, 0, 4);
    const type = Number(sh(i, 4, 4));
    const flags = sh(i, 8, 8);
    const addr = sh(i, 16, 8);
    const offset = sh(i, 24, 8);
    const size = sh(i, 32, 8);
    let name = "";
    if (strStart >= 0 && nameOff < BigInt(strEnd - strStart)) name = cString(b, strStart + Number(nameOff), strEnd);
    const alloc = (flags & 2n) !== 0n;
    let loadedIn = null;
    if (alloc && size > 0n) {
      const s = segs.find((g) => addr >= g.paddr && satAdd(addr, size) <= g.paddr + g.memsz);
      if (s) loadedIn = s.index;
    }
    list.push({
      index: i,
      off: base + i * SHDR_SIZE,
      name,
      type,
      typeName: SH_TYPES[type] ?? hex(type),
      flags: (flags & 1n ? "W" : "") + (alloc ? "A" : "") + (flags & 4n ? "X" : ""),
      addr,
      offset,
      size,
      loadedIn,
    });
  }
  const note = shnum > count ? `e_shnum says ${shnum}; the first ${count} are shown.` : "";
  return { list, note };
}

// ---------------------------------------------------------------- what an accepted file becomes

/**
 * The elf primer's three sizes: the file, the flat binary `objcopy -O binary` writes (from the lowest address that
 * has file bytes to the end of the highest, gaps zero-filled), and the memory the running guest spans (first
 * segment's address to the end of the last, including the BSS).
 */
export function threeSizes(fileLen, image) {
  const withBytes = image.segments.filter((s) => s.filesz > 0n);
  let flat = 0n;
  if (withBytes.length) {
    const lo = withBytes.reduce((m, s) => (s.paddr < m ? s.paddr : m), withBytes[0].paddr);
    const hi = withBytes.reduce((m, s) => (s.paddr + s.filesz > m ? s.paddr + s.filesz : m), 0n);
    flat = hi - lo;
  }
  const start = image.segments.reduce((m, s) => (s.paddr < m ? s.paddr : m), image.segments[0].paddr);
  const end = image.segments.reduce((m, s) => (s.paddr + s.memsz > m ? s.paddr + s.memsz : m), 0n);
  return { file: BigInt(fileLen), flat, span: end - start, start, end };
}

/** The lines of `macvmm run --dry-run` that depend on the ELF (crates/vmm/src/loader/plan.rs, `impl Display`). */
export function planLines(image, ram) {
  const pad = (s) => s.padEnd(8, " ");
  const lines = [`${pad("ram")}${hex(ram.base)}..${hex(ram.base + ram.size)}  ${ram.size >> 20n} MiB`];
  for (const s of image.segments) {
    lines.push(`${pad("elf")}${hex(s.paddr)}..${hex(s.paddr + s.memsz)}  ELF segment ${s.index} (${s.memsz} bytes)`);
  }
  lines.push(`${pad("entry")}pc=${hex(image.entry)} x0=${hex(ram.base)} cpsr=0x3c5`);
  return lines;
}

/**
 * The file-to-memory picture, as two lists of rows. File rows cover the whole file in order: the 64-byte ELF header,
 * the program-header table where e_phoff puts it (`table` = {start, end}), each loaded segment's bytes, and what is
 * left behind. Pieces may overlap (a segment that starts at offset 0 also contains the headers); each is shown.
 * Memory rows cover the device-tree slot and each segment, split into the copied part and the zero-filled part.
 */
export function fileMemoryMap(fileLen, table, image, sections, ram = ramFor(DEFAULT_RAM_MIB)) {
  const len = BigInt(fileLen);
  const order = (a, c) => (a.start < c.start ? -1 : a.start > c.start ? 1 : a.rank - c.rank);
  const pieces = [{ start: 0n, end: BigInt(EHDR_SIZE), kind: "headers", label: "ELF header", rank: 0 }];
  const tStart = BigInt(table.start);
  const tEnd = BigInt(table.end);
  if (tEnd > tStart) pieces.push({ start: tStart, end: tEnd, kind: "headers", label: `program-header table (${(tEnd - tStart) / BigInt(PHDR_SIZE)} × 56 bytes)`, rank: 1 });
  for (const s of image.segments) {
    if (s.filesz > 0n) pieces.push({ start: s.offset, end: s.offset + s.filesz, kind: "copy", seg: s.index, label: `segment ${s.index}: copied`, rank: 2 });
  }
  pieces.sort(order);
  const file = [];
  let at = 0n;
  const names = (a, z) =>
    (sections || [])
      .filter((x) => x.type !== 0 && x.type !== 8 && x.size > 0n && x.offset < z && x.offset + x.size > a && x.loadedIn === null)
      .map((x) => x.name || `section ${x.index}`);
  const leftover = (a, z) => {
    if (z <= a) return;
    const n = names(a, z);
    file.push({ start: a, end: z, kind: "left", label: n.length ? `not loaded: ${n.slice(0, 6).join(", ")}${n.length > 6 ? ", ..." : ""}` : "not loaded" });
  };
  for (const p of pieces) {
    if (p.start > at) leftover(at, p.start);
    const { rank, ...row } = p;
    file.push(row);
    if (p.end > at) at = p.end;
  }
  leftover(at, len);
  const memory = [];
  const slot = DTB_SLOT < ram.size ? DTB_SLOT : ram.size;
  memory.push({ start: ram.base, end: ram.base + slot, kind: "dtb", label: "device-tree slot (reserved first)" });
  const segs = [...image.segments].sort((a, c) => (a.paddr < c.paddr ? -1 : 1));
  let mat = ram.base + slot;
  for (const s of segs) {
    if (s.paddr > mat) memory.push({ start: mat, end: s.paddr, kind: "gap", label: "not written by the loader" });
    if (s.paddr + s.memsz > mat) mat = s.paddr + s.memsz;
    const perm = flagsText(s.flags).replace(/ /g, "").replace("E", "X");
    if (s.filesz > 0n) memory.push({ start: s.paddr, end: s.paddr + s.filesz, kind: "copy", seg: s.index, label: `segment ${s.index} ${perm}: ${commas(s.filesz)} bytes from the file` });
    if (s.memsz > s.filesz) memory.push({ start: s.paddr + s.filesz, end: s.paddr + s.memsz, kind: "zero", seg: s.index, label: `segment ${s.index} ${perm}: ${commas(s.memsz - s.filesz)} bytes zero-filled, none in the file` });
  }
  return { file, memory };
}

// ---------------------------------------------------------------- one call for the view

/**
 * Everything the view shows for one file. `opts.sections` false skips the section table (a sample whose section
 * bytes were not kept).
 */
export function analyze(b, opts = {}) {
  const ram = ramFor(opts.ramMiB ?? DEFAULT_RAM_MIB);
  const result = loadAsKernel(b, ram);
  const header = decodeHeader(b);
  const phdrs = decodePhdrs(b);
  const stage = result.ok ? null : stageOf(result.error);
  const stageIdx = stage === null ? CHECKS.length : CHECKS.findIndex((c) => c.id === stage);
  const checks = CHECKS.map((c, i) => ({ ...c, status: i < stageIdx ? "pass" : i === stageIdx ? "fail" : "not reached" }));
  const phoff = b.length >= EHDR_SIZE ? readLE(b, 32, 8) : 0n;
  const image = result.ok ? result.image : null;
  const sections = opts.sections === false ? { list: [], note: "", skipped: true } : result.kind === "elf" ? decodeSections(b, image) : { list: [], note: "" };
  const out = {
    kind: result.kind,
    ok: result.ok,
    error: result.ok ? null : result.error,
    message: result.ok || result.error.kind === "ArmImage" ? null : errorText(result.error),
    line: result.ok || result.error.kind === "ArmImage" ? null : macvmmLine(result.error),
    exit: result.ok ? null : result.error.kind === "ArmImage" ? null : 2, // an accepted file's exit status is the guest's business
    layoutNote: layoutNote(b),
    trace: result.trace,
    checks,
    header,
    phdrs,
    sections,
    image,
    ram,
    fileLen: b.length,
  };
  if (image) {
    out.sizes = threeSizes(b.length, image);
    out.plan = planLines(image, ram);
    // The loader accepted the file, so the table lies inside it: e_phoff + e_phnum × 56 <= file length.
    const tableLen = BigInt(Number(readLE(b, 56, 2)) * PHDR_SIZE);
    out.map = fileMemoryMap(b.length, { start: phoff, end: phoff + tableLen }, image, sections.list, ram);
  }
  out.summary = summarize(out);
  return out;
}

/** The one-paragraph readout. */
export function summarize(a) {
  if (a.ok) {
    const n = a.image.segments.length;
    return `Loads: ${n} segment${n === 1 ? "" : "s"} placed in guest RAM, entry ${hexu(a.image.entry)}. Every check passes. File ${commas(a.sizes.file)} bytes, flat binary ${commas(a.sizes.flat)} bytes, ${commas(a.sizes.span)} bytes of guest RAM.`;
  }
  if (a.error.kind === "ArmImage") return "Not an ELF file: this is an arm64 Image (ARM\\x64 at offset 56). macvmm hands it to its Image loader instead; the image-inspector lab decodes that header.";
  const failed = a.checks.find((c) => c.status === "fail");
  return `Refused at check "${failed.title}": ${a.message}. macvmm exits with status 2 and copies nothing.`;
}

// ---------------------------------------------------------------- samples, patches and presets

/** Rebuild a sample's bytes from its runs; everything outside the runs is zero. */
export function buildSample(id) {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) return null;
  const b = new Uint8Array(s.length);
  for (const [off, hx] of s.runs) {
    for (let i = 0; i < hx.length; i += 2) b[off + i / 2] = parseInt(hx.slice(i, i + 2), 16);
  }
  return b;
}

/**
 * Parse "offset" and "bytes" text from the patch form. Offset: hex, `0x` and `_` allowed, at most 8 digits. Bytes:
 * hex pairs, spaces allowed, 1 to 16 bytes. Returns { ok, patch } or { ok: false, field, why }, where `field` is
 * "off", "bytes" or "both" (the two together run past the end of the file).
 */
export function parsePatch(offText, bytesText, fileLen) {
  const o = String(offText ?? "").trim().toLowerCase().replace(/_/g, "").replace(/^0x/, "");
  if (!/^[0-9a-f]{1,8}$/.test(o)) return { ok: false, field: "off", why: "The offset must be a hex number of at most 8 digits, like 38 or 0x38." };
  const h = String(bytesText ?? "").toLowerCase().replace(/\s+/g, "").replace(/^0x/, "");
  if (!/^([0-9a-f]{2}){1,16}$/.test(h)) return { ok: false, field: "bytes", why: "The bytes must be 1 to 16 pairs of hex digits, like ff ff." };
  const off = parseInt(o, 16);
  const bytes = h.match(/../g).map((x) => parseInt(x, 16));
  if (off + bytes.length > fileLen) return { ok: false, field: "both", why: `That patch ends at ${hex(off + bytes.length)}, past the end of the ${commas(fileLen)}-byte file. Patches overwrite bytes; they never grow the file.` };
  return { ok: true, patch: { off, bytes } };
}

/** A patched copy of `base` (patches applied in order). Patches past the end are ignored. */
export function applyPatches(base, patches) {
  const b = new Uint8Array(base);
  for (const p of patches) {
    if (p.off + p.bytes.length > b.length) continue;
    p.bytes.forEach((v, i) => (b[p.off + i] = v));
  }
  return b;
}

function le(v, n) {
  const out = [];
  let x = BigInt(v);
  for (let i = 0; i < n; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

/**
 * "Break one rule" presets. Each builds its patches from the file in hand (so it works on both samples and on a
 * dropped file with the same layout) and says which check should catch it. `need` names the program header it
 * needs; a preset that cannot apply returns null.
 */
export const PRESETS = [
  { id: "class", label: "32-bit class byte (EI_CLASS = 1)", build: () => [{ off: 4, bytes: [1] }] },
  { id: "endian", label: "Big-endian (EI_DATA = 2)", build: () => [{ off: 5, bytes: [2] }] },
  { id: "x86", label: "Machine x86-64 (e_machine = 62)", build: () => [{ off: 0x12, bytes: [0x3e, 0] }] },
  { id: "dyn", label: "Position-independent (e_type = ET_DYN)", build: () => [{ off: 0x10, bytes: [3, 0] }] },
  { id: "phnum", label: "e_phnum = 65535 (chapter 13's Try it)", build: () => [{ off: 0x38, bytes: [0xff, 0xff] }] },
  { id: "phoff", label: "e_phoff that wraps to 0 (primer self-check)", build: () => [{ off: 0x20, bytes: le(0xffff_ffff_ffff_ffc8n, 8) }, { off: 0x38, bytes: [1, 0] }] },
  { id: "nophdr", label: "No program headers (e_phnum = 0)", build: () => [{ off: 0x38, bytes: [0, 0] }] },
  {
    id: "filesz",
    label: "Segment 0: one byte of p_filesz raised",
    build: (b) => (loadPh(b, 0) ? [{ off: loadPh(b, 0).off + 34, bytes: [(b[loadPh(b, 0).off + 34] + 1) & 0xff] }] : null),
  },
  { id: "offset", label: "Segment 0: p_offset 0xffff_ffff_ffff_f000 (wraps)", build: (b) => (loadPh(b, 0) ? [{ off: loadPh(b, 0).off + 8, bytes: le(0xffff_ffff_ffff_f000n, 8) }] : null) },
  { id: "vaddr", label: "Segment 0: p_vaddr differs from p_paddr", build: (b) => (loadPh(b, 0) ? [{ off: loadPh(b, 0).off + 23, bytes: [0xff] }] : null) },
  {
    id: "dtb",
    label: "Segment 0 moved onto the device-tree slot",
    build: (b) => (loadPh(b, 0) ? [{ off: loadPh(b, 0).off + 16, bytes: le(RAM_BASE, 8) }, { off: loadPh(b, 0).off + 24, bytes: le(RAM_BASE, 8) }] : null),
  },
  {
    id: "overlap",
    label: "Segment 1 moved on top of segment 0",
    build: (b) => {
      const a = loadPh(b, 0);
      const c = loadPh(b, 1);
      if (!a || !c) return null;
      return [{ off: c.off + 16, bytes: le(a.paddr, 8) }, { off: c.off + 24, bytes: le(a.paddr, 8) }];
    },
  },
  {
    id: "ramend",
    label: "Last segment moved 4 KiB before the end of 64 MiB (then try a larger RAM size)",
    build: (b) => {
      const c = lastLoadPh(b);
      if (!c) return null;
      const at = RAM_BASE + (64n << 20n) - 0x1000n;
      return [{ off: c.off + 16, bytes: le(at, 8) }, { off: c.off + 24, bytes: le(at, 8) }];
    },
  },
  { id: "memsz", label: "Last segment: p_memsz = 2^40 (the elf primer's Security note)", build: (b) => (lastLoadPh(b) ? [{ off: lastLoadPh(b).off + 40, bytes: le(1n << 40n, 8) }] : null) },
  {
    id: "entry",
    label: "Entry point moved into the read-only data",
    build: (b) => {
      const c = loadPh(b, 1);
      return c ? [{ off: 0x18, bytes: le(c.paddr, 8) }] : null;
    },
  },
  { id: "noshdr", label: "Section table removed (e_shnum = 0): still loads", build: () => [{ off: 0x3c, bytes: [0, 0] }] },
];

/** The k-th PT_LOAD program header of `b` (0-based), from the decoded table, or null. */
function loadPh(b, k) {
  const loads = decodePhdrs(b).list.filter((p) => p.type === PT_LOAD);
  return loads[k] ?? null;
}

function lastLoadPh(b) {
  const loads = decodePhdrs(b).list.filter((p) => p.type === PT_LOAD);
  return loads.length ? loads[loads.length - 1] : null;
}

/** The patches for preset `id` on `b`, or null if it does not apply. */
export function presetPatches(id, b) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p || b.length < EHDR_SIZE) return null;
  const patches = p.build(b);
  if (!patches || patches.some((q) => q.off + q.bytes.length > b.length)) return null;
  return patches;
}

// ---------------------------------------------------------------- state and the share hash

export function initialState() {
  return { sample: "primer", patches: [], ramMiB: DEFAULT_RAM_MIB, file: null };
}

/**
 * Share state: `<sample>[~<offset hex>:<bytes hex>]...[@<RAM MiB>]`, e.g. `ch13~38:ffff` (chapter 13's Try it).
 * A dropped file is never put in the link (it stays on the reader's machine), so file states encode to null, as
 * does the default.
 */
export function encode(s) {
  if (s.file) return null;
  if (s.sample === "primer" && s.patches.length === 0 && s.ramMiB === DEFAULT_RAM_MIB) return null;
  let out = s.sample;
  for (const p of s.patches) out += `~${p.off.toString(16)}:${p.bytes.map((v) => hexPad(v, 2)).join("")}`;
  if (s.ramMiB !== DEFAULT_RAM_MIB) out += `@${s.ramMiB}`;
  return out;
}

/** Parse a share string. Anything malformed gives null (the view then starts from the default). */
export function decode(str) {
  if (typeof str !== "string" || str.length > 600) return null;
  const m = /^([a-z0-9]+)((?:~[0-9a-f]{1,8}:(?:[0-9a-f]{2}){1,16})*)(?:@(\d{1,5}))?$/.exec(str);
  if (!m) return null;
  const sample = SAMPLES.find((x) => x.id === m[1]);
  if (!sample) return null;
  const ramMiB = m[3] === undefined ? DEFAULT_RAM_MIB : Number(m[3]);
  if (!RAM_SIZES_MIB.includes(ramMiB)) return null;
  const patches = [];
  for (const part of m[2].split("~").slice(1)) {
    const [o, h] = part.split(":");
    const off = parseInt(o, 16);
    const bytes = h.match(/../g).map((x) => parseInt(x, 16));
    if (off + bytes.length > sample.length) return null;
    patches.push({ off, bytes });
  }
  if (patches.length > MAX_PATCHES) return null;
  return { sample: sample.id, patches, ramMiB, file: null };
}

/**
 * State transitions. Actions: {type: "sample", id} | {type: "file", name, size} | {type: "patch", patch} |
 * {type: "unpatch", index} | {type: "clear"} | {type: "preset", patches} | {type: "ram", mib} | {type: "reset"}.
 */
export function step(s, a) {
  switch (a.type) {
    case "sample":
      return SAMPLES.some((x) => x.id === a.id) ? { ...s, sample: a.id, file: null, patches: [] } : s;
    case "file":
      return { ...s, file: { name: String(a.name).slice(0, 80), size: a.size }, patches: [] };
    case "patch":
      return s.patches.length >= MAX_PATCHES ? s : { ...s, patches: [...s.patches, a.patch] };
    case "unpatch":
      return { ...s, patches: s.patches.filter((_, i) => i !== a.index) };
    case "clear":
      return { ...s, patches: [] };
    case "preset":
      return { ...s, patches: a.patches.slice(0, MAX_PATCHES) };
    case "ram":
      return RAM_SIZES_MIB.includes(a.mib) ? { ...s, ramMiB: a.mib } : s;
    case "reset":
      return initialState();
    default:
      return s;
  }
}
