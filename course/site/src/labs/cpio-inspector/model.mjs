// cpio-inspector model: walk an initramfs buffer the way Linux does, and say what a host cpio
// tool would show instead. Pure ES module (no DOM, no I/O), so `node --test` imports it.
//
// What it ports, and from where (Linux 6.18):
//   - init/initramfs.c: unpack_to_rootfs (the member loop: raw newc at a 4-byte boundary, zero
//     bytes skipped, anything else handed to a decompressor), write_buffer/flush_buffer (what
//     happens between entries), do_header, do_name, do_copy, do_symlink, do_reset, clean_path,
//     maybe_link/find_link, N_ALIGN, and every error string the unpacker can return.
//   - lib/decompress.c: decompress_method (the two-byte magics).
//   - lib/decompress_inflate.c: __gunzip (10-byte header, only FNAME skipped, trailer not checked,
//     `*pos = next_in - zbuf + 8`).
//   - init/main.c: the rdinit access check, run_init_process, try_to_run_init_process and the
//     fallbacks, with the log lines they print.
//   - Documentation/driver-api/early-userspace/buffer-format.rst: the newc grammar.
// The host-tool view follows libarchive's bsdcpio (`cpio -itv`): one archive, stop at the first
// TRAILER!!!, and its `ls -l`-style listing line.
//
// Everything here treats the file as hostile: sizes are capped, every offset is checked before it
// is read, symlink resolution has a hop limit, and nothing is ever turned into code or HTML.
// Where the kernel itself has no limit (how many members, how deep a path, how much work the
// names take to resolve) the lab has its own, below, and stops with a sentence that says which.

import { inflateRaw, crc32 } from "./inflate.mjs";

export const HEADER = 110;
export const PATH_MAX = 4096;
export const MAX_INPUT = 16 * 1024 * 1024;
export const MAX_OUTPUT = 128 * 1024 * 1024;
export const MAX_ENTRIES = 100_000;
// Three more limits are the lab's own (the kernel has none of them). Each ends the walk with a
// `labStop` sentence that names the limit; none changes what a smaller archive unpacks to.
/** Members (raw newc runs and compressed streams) the lab follows. A real initramfs has one to
 * three; 100,000 empty gzip members took about a minute and 1.4 GB to walk and draw. */
export const MAX_MEMBERS = 1024;
/** Directories deep a name, a symlink target or a resolved path may be. Real trees are about a
 * dozen deep; the cost of resolving a name grows with the square of its depth. */
export const MAX_PATH_DEPTH = 64;
/** Path steps the whole unpack may spend resolving names (one per component looked up, more for
 * very long paths): deep trees and chains of symlinks multiply the work per entry. */
export const MAX_WALK = 2_000_000;
/** Path steps one name may take (after unpacking too, when the lab looks for /init). */
const MAX_WALK_ONE = 65_536;
export const MAX_PATCHES = 16;

export const S_IFMT = 0o170000;
export const TYPES = [
  { bits: 0o140000, key: "sock", name: "socket", ls: "s" },
  { bits: 0o120000, key: "symlink", name: "symbolic link", ls: "l" },
  { bits: 0o100000, key: "file", name: "regular file", ls: "-" },
  { bits: 0o060000, key: "blk", name: "block device", ls: "b" },
  { bits: 0o040000, key: "dir", name: "directory", ls: "d" },
  { bits: 0o020000, key: "chr", name: "character device", ls: "c" },
  { bits: 0o010000, key: "fifo", name: "FIFO (named pipe)", ls: "p" },
];

/** The 13 newc fields in header order (buffer-format.rst), with what each one means. */
export const FIELDS = [
  { name: "c_ino", meaning: "inode number" },
  { name: "c_mode", meaning: "file type and permissions" },
  { name: "c_uid", meaning: "owner (user ID)" },
  { name: "c_gid", meaning: "group ID" },
  { name: "c_nlink", meaning: "number of hard links" },
  { name: "c_mtime", meaning: "modification time, seconds since 1970" },
  { name: "c_filesize", meaning: "bytes of data" },
  { name: "c_maj", meaning: "major number of the disk the file came from" },
  { name: "c_min", meaning: "minor number of the disk the file came from" },
  { name: "c_rmaj", meaning: "device major (device files only)" },
  { name: "c_rmin", meaning: "device minor (device files only)" },
  { name: "c_namesize", meaning: "name length including its NUL" },
  { name: "c_chksum", meaning: "checksum (070702 only; zero for 070701)" },
];

// Two-byte magics from lib/decompress.c, in table order.
const COMPRESSED = [
  [0x1f, 0x8b, "gzip"], [0x1f, 0x9e, "gzip"], [0x42, 0x5a, "bzip2"], [0x5d, 0x00, "lzma"],
  [0xfd, 0x37, "xz"], [0x89, 0x4c, "lzo"], [0x02, 0x21, "lz4"], [0x28, 0xb5, "zstd"],
];

const ENOENT = -2, ENOEXEC = -8, EACCES = -13, ENOTDIR = -20, ELOOP = -40;

// ---------------------------------------------------------------------------------------------
// Small helpers

export const hex = (n, w = 0) => `0x${n.toString(16).padStart(w, "0")}`;
export const align4 = (n) => Math.ceil(n / 4) * 4;
/** N_ALIGN from init/initramfs.c: name bytes plus padding, so that 110 + N_ALIGN(n) is a multiple of 4. */
export const nAlign = (n) => (n + 1) - ((n + 1) % 4) + 2;

const isHex = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const hexVal = (c) => (c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x61 + 10);

/**
 * One 8-character field the way the kernel reads it: simple_strntoul(s, NULL, 16, 8), which
 * accepts a leading "0x" and stops at the first character that is not a hex digit. `clean` says
 * whether all 8 characters were hex digits, as a host tool would require.
 */
export function parseField(bytes, off) {
  let i = off;
  const end = off + 8;
  if (bytes[i] === 0x30 && (bytes[i + 1] | 0x20) === 0x78) i += 2;
  let v = 0;
  while (i < end && isHex(bytes[i])) { v = v * 16 + hexVal(bytes[i]); i++; }
  let clean = true;
  for (let k = off; k < end; k++) if (!isHex(bytes[k])) clean = false;
  return { value: v, raw: latin1(bytes, off, end), clean };
}

// In chunks, not one `s += char` per byte: that builds a rope with a node per character, about
// thirty times the bytes it stands for until something flattens it, and a file of long names
// (30,000 names of 4 KiB from a 200 KB gzip) ran the tab out of memory that way.
function latin1(bytes, from, to) {
  let s = "";
  for (let i = from; i < to; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 8192)));
  return s;
}

const UTF8 = new TextDecoder("utf-8");
/**
 * Text from a dropped file, made safe to show: C0/C1 control characters become \xNN, and the
 * invisible or direction-changing format characters (zero-width spaces and joiners, LRM/RLM,
 * the bidi embeddings, overrides and isolates, the BOM) become \u{NNNN}, so a hostile name such
 * as "init<U+202E>hs.exe" cannot display reversed. Never HTML.
 */
export function safeText(s) {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
}
/** A name for display: the bytes as UTF-8, through safeText. */
export function displayText(bytes) {
  return safeText(UTF8.decode(bytes));
}
/** The same for a name the model keeps as a byte string (one char per byte, as latin1 reads it). */
export function displayName(s) {
  return displayText(Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff));
}

export function typeOf(mode) {
  const t = mode & S_IFMT;
  return TYPES.find((x) => x.bits === t) || { bits: t, key: "other", name: "unknown type", ls: "?" };
}

/** `ls -l` permission string, setuid/setgid/sticky included. */
export function permString(mode) {
  const r = (b, c) => (mode & b ? c : "-");
  let s = r(0o400, "r") + r(0o200, "w") + r(0o100, "x") + r(0o40, "r") + r(0o20, "w") + r(0o10, "x") + r(0o4, "r") + r(0o2, "w") + r(0o1, "x");
  const a = s.split("");
  if (mode & 0o4000) a[2] = a[2] === "x" ? "s" : "S";
  if (mode & 0o2000) a[5] = a[5] === "x" ? "s" : "S";
  if (mode & 0o1000) a[8] = a[8] === "x" ? "t" : "T";
  return a.join("");
}

/** c_mode decoded: octal, type, permissions (primer: "Anatomy of a newc entry"). */
export function decodeMode(mode) {
  const t = typeOf(mode);
  return {
    octal: `0${(mode >>> 0).toString(8)}`,
    typeOctal: `0${t.bits.toString(8).padStart(6, "0")}`,
    type: t.key,
    typeName: t.name,
    perms: `0${(mode & 0o7777).toString(8).padStart(3, "0")}`,
    rwx: permString(mode),
    ls: t.ls + permString(mode),
  };
}

/** What kind of file this looks like, so the shared drop zone can point at the right lab. */
export function sniff(bytes) {
  const b = bytes;
  const at = (o, s) => o + s.length <= b.length && [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (at(0, "070701") || at(0, "070702")) return { kind: "newc", label: "a raw newc cpio archive" };
  if (at(0, "070707")) return { kind: "odc", label: "an odc cpio archive (the older format)" };
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return { kind: "gzip", label: "gzip-compressed data" };
  if (at(0, "\x7fELF")) return { kind: "elf", label: "an ELF file", lab: "elf-inspector" };
  if (at(0, "MZ") && at(4, "zimg")) return { kind: "zboot", label: "an EFI zboot kernel (a compressed Linux kernel in a PE wrapper)", lab: "image-inspector" };
  if (at(0x38, "ARM\x64")) return { kind: "image", label: "an arm64 Linux kernel Image", lab: "image-inspector" };
  for (const [m0, m1, name] of COMPRESSED) if (b.length >= 2 && b[0] === m0 && b[1] === m1) return { kind: name, label: `${name}-compressed data` };
  if (b.length && b[0] === 0) return { kind: "zeros", label: "data starting with zero bytes" };
  return { kind: "unknown", label: "not a format the kernel's unpacker knows" };
}

// ---------------------------------------------------------------------------------------------
// The rootfs: the in-memory filesystem the kernel unpacks into, as a map of canonical paths.

function parentOf(p) {
  if (p === "/") return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
const join = (dir, name) => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** Why a lookup hit one of the lab's limits, in words that finish "Member 1, entry 2: ...". */
const LIMIT_TEXT = {
  depth: `its path is more than ${MAX_PATH_DEPTH} directories deep, deeper than this lab follows`,
  walk: `resolving the names up to here has taken more than ${MAX_WALK.toLocaleString("en-US")} path steps (very deep directories, very long paths or long chains of symlinks), more than this lab spends`,
  one: "resolving this one name takes too many path steps (long paths behind chains of symlinks), more than this lab spends",
};
const pathDepth = (path) => {
  let n = 0;
  for (const c of path.split("/")) if (c !== "") n++;
  return n;
};

class Rootfs {
  constructor() {
    this.nodes = new Map();
    this.nodes.set("/", { type: "dir", mode: 0o040755, children: new Set(), src: null });
    // The lab's limits on lookups (see MAX_PATH_DEPTH and MAX_WALK). `metered` is true while the
    // archive is being unpacked: then the steps of every lookup add up in `work`. `limit` is the
    // first limit hit ("depth", "walk" or "one"); a lookup that hits one answers ENOENT and the
    // caller that cares (the unpacker, bootLog) reads `limit` afterwards.
    this.metered = false;
    this.work = 0;
    this.limit = null;
  }
  /** Path lookup from "/" (the unpacker runs with cwd "/"), following symlinks in every
   * component but the last unless `follow`. At most 40 symlinks, as Linux (MAXSYMLINKS).
   * The walk is bounded: a step costs 1 plus 1 per 512 characters of the path it looks up, a
   * name may take MAX_WALK_ONE steps, the unpack MAX_WALK in all, and no path may be more than
   * MAX_PATH_DEPTH directories deep. */
  resolve(path, follow) {
    let cur = "/";
    let depth = 0; // of `cur`
    let spent = 0;
    const over = (why) => {
      this.limit = this.limit || why;
      return { error: ENOENT, limit: this.limit };
    };
    // Spends `n` more steps; returns the limit that ran out, or null to go on.
    const spend = (n) => {
      spent += n;
      if (this.metered) {
        this.work += n;
        if (this.work > MAX_WALK) return "walk";
      }
      return spent > MAX_WALK_ONE ? "one" : null;
    };
    let out = this.metered ? this.limit : null; // an unpack that hit a limit looks up nothing more
    if (out || (out = spend(1 + (path.length >> 9)))) return over(out);
    let comps = path.split("/").filter((c) => c !== "");
    let hops = 0;
    if (comps.length === 0) return path === "" ? { error: ENOENT } : { self: true, path: "/", node: this.nodes.get("/") };
    if (comps.length > MAX_PATH_DEPTH) return over("depth");
    let at = 0; // comps[at] is the next component: no shift(), which moves the whole list
    while (at < comps.length) {
      const c = comps[at++];
      const last = at === comps.length;
      if (c === "." || c === "..") {
        if ((out = spend(1))) return over(out);
        if (c === ".." && cur !== "/") { cur = parentOf(cur); depth--; }
        if (last) return { self: true, path: cur, node: this.nodes.get(cur) };
        continue;
      }
      const p = join(cur, c);
      if ((out = spend(1 + (p.length >> 9)))) return over(out);
      const n = this.nodes.get(p);
      if (last && !follow) return { parent: cur, name: c, path: p, node: n || null };
      if (!n) return last ? { parent: cur, name: c, path: p, node: null } : { error: ENOENT };
      if (n.type === "symlink") {
        if (++hops > 40) return { error: ELOOP };
        if ((out = spend(1 + (n.target.length >> 9)))) return over(out);
        if (n.target.startsWith("/")) { cur = "/"; depth = 0; }
        const tc = n.target.split("/").filter((x) => x !== "");
        if (tc.length > MAX_PATH_DEPTH) return over("depth");
        comps = tc.concat(comps.slice(at));
        at = 0;
        if (comps.length === 0) return { self: true, path: cur, node: this.nodes.get(cur) };
        continue;
      }
      if (last) return { parent: cur, name: c, path: p, node: n };
      if (n.type !== "dir") return { error: ENOTDIR };
      cur = p;
      if (++depth > MAX_PATH_DEPTH) return over("depth");
    }
    return { self: true, path: cur, node: this.nodes.get(cur) };
  }
  put(path, node) {
    this.nodes.set(path, node);
    if (node.type === "dir") node.children = node.children || new Set();
    this.nodes.get(parentOf(path)).children.add(path);
  }
  remove(path) {
    const n = this.nodes.get(path);
    if (!n || path === "/") return false;
    if (n.type === "dir" && n.children.size) return false; // rmdir of a non-empty directory fails
    this.nodes.delete(path);
    this.nodes.get(parentOf(path)).children.delete(path);
    return true;
  }
}

const BUILTIN = { builtin: true };

/** The archive built into Alpine's kernel, unpacked first (primer: "How the kernel unpacks it"). */
function builtinRootfs() {
  const fs = new Rootfs();
  fs.put("/dev", { type: "dir", mode: 0o040755, src: BUILTIN });
  fs.put("/dev/console", { type: "chr", mode: 0o020600, rdev: [5, 1], src: BUILTIN });
  fs.put("/root", { type: "dir", mode: 0o040700, src: BUILTIN });
  return fs;
}

// ---------------------------------------------------------------------------------------------
// The unpacker

/**
 * Walk `bytes` (a Uint8Array) like init/initramfs.c. Returns:
 *   members  - [{ index, kind: "newc" | "gzip" | other compressor, start, end, entries, data?, gzip? }]
 *   items    - the buffer in order: members, zero runs, and where it stopped ({ type, start, end })
 *   entries  - every entry, in the order the kernel met it
 *   error    - { message, member, at, stream } : the text after "Initramfs unpacking failed: ", or null
 *   labStop  - why the lab could not follow the rest (a compressor it cannot run, or one of the
 *              lab's limits: MAX_OUTPUT, MAX_ENTRIES, MAX_MEMBERS, MAX_PATH_DEPTH, MAX_WALK), or null
 *   rootfs   - the resulting filesystem (Rootfs)
 *   length   - bytes.length
 */
export function unpack(bytes, opts = {}) {
  const maxOut = opts.maxOut ?? MAX_OUTPUT;
  const res = { members: [], items: [], entries: [], error: null, labStop: null, length: bytes.length, notes: [] };
  const fs = builtinRootfs();
  fs.metered = true; // until the walk below ends: see Rootfs.resolve
  res.rootfs = fs;
  let links = new Map(); // find_link's hash, freed at every TRAILER!!!
  let message = null;
  let state = "Start";
  let curRaw = null; // the raw member entries are being added to
  let curRawItem = null; // its row in res.items (kept here: finding it again is a scan per entry)
  let totalOut = 0;

  const setError = (msg, member, at, stream) => { if (!message) { message = msg; res.error = { message: msg, member, at, stream }; } };

  // ---- one entry: do_start .. do_header .. do_name/do_symlink .. do_copy .. do_skip ----------
  // `th` is this_header at `p`. Returns { consumed, complete, entry }.
  function parseEntry(buf, p, end, th, member, streamName) {
    const avail = end - p;
    if (res.entries.length >= MAX_ENTRIES) {
      res.labStop = res.labStop || `More than ${MAX_ENTRIES} entries: the lab stops here.`;
      return { consumed: avail, complete: false, stop: true };
    }
    if (avail < HEADER) {
      const e = { member: member.index, index: member.entries.length, off: p, th, stream: streamName, kind: "cut", truncated: true, outcome: { status: "partial", text: `Only ${avail} of the 110 header bytes are here; the kernel waits for more and nothing is created.` } };
      member.entries.push(e); res.entries.push(e);
      return { consumed: avail, complete: false, entry: e };
    }
    const magic = latin1(buf, p, p + 6);
    if (magic !== "070701" && magic !== "070702") {
      const msg = magic === "070707" ? "incorrect cpio method used: use -H newc option" : "no cpio magic";
      const e = { member: member.index, index: member.entries.length, off: p, th, stream: streamName, kind: "bad", magic, nameDisplay: null,
        outcome: { status: "error", text: `The header starts ${displayText(buf.subarray(p, p + 6))}, not 070701. The kernel stops here.` } };
      member.entries.push(e); res.entries.push(e);
      setError(msg, member.index, p, streamName);
      return { consumed: HEADER, complete: false, entry: e };
    }
    const fields = [];
    for (let i = 0; i < 13; i++) {
      const f = parseField(buf, p + 6 + i * 8);
      fields.push({ ...FIELDS[i], off: 6 + i * 8, ...f });
    }
    const v = fields.map((f) => f.value);
    const [ino, rawMode, uid, gid, nlink, mtime, filesize, maj, min, rmaj, rmin, namesize, chksum] = v;
    // The kernel keeps the mode in a umode_t (16 bits), so bits above 0xffff are dropped.
    const mode = rawMode & 0xffff;
    const e = {
      member: member.index, index: member.entries.length, off: p, th, stream: streamName, magic,
      fields, ino, mode, uid, gid, nlink, mtime, filesize, maj, min, rmaj, rmin, namesize, chksum,
      csum: magic === "070702",
      nameOff: p + HEADER, dataOff: p + HEADER + nAlign(namesize),
      nextHeader: p + align4(HEADER + nAlign(namesize) + filesize),
      kind: typeOf(mode).key, name: null, nameDisplay: null, outcome: null, overwrittenBy: null,
      dirty: fields.some((f) => !f.clean),
    };
    if (rawMode > 0xffff) e.notes = [`c_mode is ${hex(rawMode)}; the kernel keeps only the low 16 bits (a umode_t), so it uses ${decodeMode(mode).octal}.`];
    member.entries.push(e); res.entries.push(e);
    const skipTo = (status, text) => {
      e.outcome = e.outcome || { status, text };
      const want = e.nextHeader - p;
      if (want > avail) { e.truncated = true; return { consumed: avail, complete: false, entry: e }; }
      return { consumed: want, complete: true, entry: e };
    };
    if (namesize <= 0 || namesize > PATH_MAX) return skipTo("ignored", `c_namesize is ${namesize}; the kernel skips entries whose name size is 0 or above ${PATH_MAX}.`);
    const isLnk = (mode & S_IFMT) === 0o120000;
    const isReg = (mode & S_IFMT) === 0o100000;
    if (isLnk && filesize > PATH_MAX) return skipTo("ignored", `A symlink target of ${filesize} bytes is longer than ${PATH_MAX}; the kernel skips it.`);
    if (!isLnk && !isReg && filesize !== 0) return skipTo("ignored", `A ${typeOf(mode).name} with ${filesize} bytes of data: the kernel only reads the name of a regular file, a symlink or an entry with no data, so it skips this one without looking at its name.`);
    // Name (and, for a symlink, the target) must be present.
    const nameEnd = p + HEADER + nAlign(namesize);
    const collectEnd = isLnk ? nameEnd + filesize : nameEnd;
    if (collectEnd > end) {
      e.truncated = true;
      e.outcome = { status: "partial", text: "The archive ends inside this entry's name; the kernel waits for more and nothing is created." };
      return { consumed: avail, complete: false, entry: e };
    }
    if (buf[p + HEADER + namesize - 1] !== 0) {
      e.outcome = { status: "error", text: "The name is not NUL-terminated." };
      setError("malformed archive", member.index, p, streamName);
      e.kernelPrints = `initramfs ${isLnk ? "symlink" : "name"} without nulterm: ${displayText(buf.subarray(p + HEADER, p + HEADER + namesize))}`;
      return { consumed: collectEnd - p, complete: false, entry: e };
    }
    let nul = p + HEADER;
    while (buf[nul] !== 0) nul++;
    const nameBytes = buf.subarray(p + HEADER, nul);
    e.name = latin1(buf, p + HEADER, nul);
    e.nameDisplay = displayText(nameBytes);
    if (nul !== p + HEADER + namesize - 1) (e.notes ||= []).push(`The name contains a NUL before its end; the kernel uses only "${e.nameDisplay}".`);

    // One of the lab's own limits on names (MAX_PATH_DEPTH, MAX_WALK) was hit creating `e`:
    // stop here and say which, instead of walking on for seconds or minutes.
    const labLimit = () => {
      if (!fs.limit) return null;
      const why = LIMIT_TEXT[fs.limit];
      e.outcome = { status: "lab", text: `The lab stops at this entry: ${why}.` };
      res.labStop = res.labStop || `Member ${member.index + 1}, entry ${e.index + 1}: ${why}. The lab stops here; the kernel has no such limit and would carry on.`;
      return { consumed: avail, complete: false, stop: true, entry: e };
    };
    if (isLnk) {
      let t = nameEnd;
      while (t < nameEnd + filesize && buf[t] !== 0) t++;
      e.target = latin1(buf, nameEnd, t);
      e.targetDisplay = displayText(buf.subarray(nameEnd, t));
      e.kind = "symlink";
      doSymlink(e, member);
      return labLimit() || skipTo("created", "");
    }
    if (e.name === "TRAILER!!!") {
      e.kind = "trailer";
      links = new Map();
      member.trailers = (member.trailers || 0) + 1;
      if (member.kind === "newc") curRaw = null;
      return skipTo("trailer", "End of this archive. The kernel forgets its hard-link list and keeps reading the buffer.");
    }
    // Regular file: data must be there for the file to be complete.
    if (isReg) {
      const dataEnd = e.dataOff + filesize;
      const have = Math.max(0, Math.min(end, dataEnd) - e.dataOff);
      e.dataEnd = dataEnd;
      doName(e, buf, have);
      const stopped = labLimit();
      if (stopped) return stopped;
      if (dataEnd > end) {
        e.truncated = true;
        if (e.outcome.status === "created" || e.outcome.status === "replaced") e.outcome = { status: "partial", text: `Only ${have} of ${filesize} data bytes are here. The kernel has already set the file's size to ${filesize}, so the rest reads as zeros.` };
        return { consumed: avail, complete: false, entry: e };
      }
      if (e.csum && e.outcome.wrote) {
        let sum = 0;
        for (let i = e.dataOff; i < dataEnd; i++) sum = (sum + buf[i]) >>> 0;
        e.dataSum = sum;
        if (sum !== chksum) setError("bad data checksum", member.index, p, streamName);
      }
      return skipTo(e.outcome.status, e.outcome.text);
    }
    doName(e, buf, 0);
    return labLimit() || skipTo(e.outcome.status, e.outcome.text);
  }

  const ref = (src) => (src === BUILTIN ? "the kernel's built-in archive" : `member ${src.member + 1}, entry ${src.index + 1}`);
  function supersede(node, e) {
    if (node && node.src && node.src !== BUILTIN && !node.src.overwrittenBy) node.src.overwrittenBy = { member: e.member, index: e.index };
  }
  // clean_path(path, fmode): remove an existing entry of a different type (rmdir fails if it has children).
  function cleanPath(e, path, fmode) {
    const r = fs.resolve(path, false);
    if (!r.node || r.self) return;
    if (((r.node.mode ^ fmode) & S_IFMT) !== 0 || fmode === 0) {
      if (fs.remove(r.path)) { supersede(r.node, e); e.removed = ref(r.node.src); }
    }
  }
  // maybe_link: 0 = not a link, 1 = linked to an earlier name, -1 = link failed.
  function maybeLink(e) {
    if (e.nlink < 2) return 0;
    const key = `${e.ino}:${e.maj}:${e.min}:${e.mode & S_IFMT}`;
    const old = links.get(key);
    if (old === undefined) { links.set(key, e.name); return 0; }
    cleanPath(e, e.name, 0);
    const o = fs.resolve(old, false);
    const n = fs.resolve(e.name, false);
    if (!o.node || o.self || o.node.type === "dir" || n.error || n.self || n.node || !fs.nodes.has(n.parent)) return -1;
    fs.put(n.path, o.node);
    e.linkedTo = old;
    return 1;
  }
  function doName(e, buf, have) {
    const mode = e.mode;
    cleanPath(e, e.name, mode);
    const r0 = fs.resolve(e.name, false);
    const before = r0.node;
    const t = e.kind;
    if (t === "file") {
      const ml = maybeLink(e);
      if (ml < 0) { e.outcome = { status: "ignored", text: "A hard link the kernel could not make; the entry is skipped." }; return; }
      const r = fs.resolve(e.name, false);
      if (r.error || r.self || !fs.nodes.has(r.parent)) { e.outcome = { status: "ignored", text: missing(e, r) }; return; }
      if (r.node && r.node.type === "dir") { e.outcome = { status: "ignored", text: "A directory with contents is in the way, so the kernel cannot open a file here." }; return; }
      const data = buf.subarray(e.dataOff, e.dataOff + have);
      if (ml === 1) {
        if (e.filesize) r.node.inode = { data, size: e.filesize };
        e.outcome = { status: "linked", text: `A hard link to ${e.linkedTo}.`, wrote: true };
        return;
      }
      e.path = r.path;
      if (r.node && r.node.type === "file") {
        // open(O_WRONLY|O_CREAT|O_TRUNC) on an existing file keeps its inode: every hard link to
        // it sees the new contents, and fchown/fchmod then set the owner and mode.
        supersede(r.node, e);
        const old = r.node.src;
        Object.assign(r.node, { mode, uid: e.uid, gid: e.gid, inode: { data, size: e.filesize }, src: e });
        e.outcome = { status: "replaced", text: `Replaces ${r.path} from ${ref(old)}. The kernel empties the existing file (O_TRUNC) rather than making a new one, so any hard link to it sees the new contents too.`, wrote: true };
        return;
      }
      if (r.node) supersede(r.node, e);
      const replaced = r.node || before;
      fs.put(r.path, { type: "file", mode, uid: e.uid, gid: e.gid, inode: { data, size: e.filesize }, src: e });
      if (replaced) e.outcome = { status: "replaced", text: `Replaces ${r.path} from ${ref(replaced.src)}.`, wrote: true };
      else if (e.removed) e.outcome = { status: "replaced", text: `Replaces ${r.path} (of another type) from ${e.removed}.`, wrote: true };
      else e.outcome = { status: "created", text: "", wrote: true };
      return;
    }
    if (t === "dir") {
      const r = fs.resolve(e.name, false);
      if (r.error || (!r.self && !fs.nodes.has(r.parent))) { e.outcome = { status: "ignored", text: missing(e, r) }; return; }
      if (r.self || r.node) {
        const node = r.node;
        if (node && node.type === "dir") node.mode = (node.mode & S_IFMT) | (mode & 0o7777);
        e.outcome = { status: "updated", text: `${r.path} already exists${node && node.src ? ` (from ${ref(node.src)})` : ""}; the kernel only updates its owner and mode.` };
        return;
      }
      fs.put(r.path, { type: "dir", mode, uid: e.uid, gid: e.gid, src: e });
      e.path = r.path;
      e.outcome = e.removed ? { status: "replaced", text: `Replaces ${r.path} (of another type) from ${e.removed}.` } : { status: "created", text: "" };
      return;
    }
    if (t === "chr" || t === "blk" || t === "fifo" || t === "sock") {
      if (maybeLink(e) !== 0) { e.outcome = { status: e.linkedTo ? "linked" : "ignored", text: e.linkedTo ? `A hard link to ${e.linkedTo}.` : "A hard link the kernel could not make." }; return; }
      const r = fs.resolve(e.name, false);
      if (r.error || r.self || !fs.nodes.has(r.parent)) { e.outcome = { status: "ignored", text: missing(e, r) }; return; }
      if (r.node) { r.node.mode = (r.node.mode & S_IFMT) | (mode & 0o7777); e.outcome = { status: "updated", text: `${r.path} already exists (from ${ref(r.node.src)}); only its owner and mode change.` }; return; }
      fs.put(r.path, { type: t, mode, uid: e.uid, gid: e.gid, rdev: [e.rmaj, e.rmin], src: e });
      e.path = r.path;
      e.outcome = e.removed ? { status: "replaced", text: `Replaces ${r.path} (of another type) from ${e.removed}.` } : { status: "created", text: t === "chr" || t === "blk" ? `A device node for ${e.rmaj}:${e.rmin}.` : "" };
      return;
    }
    e.outcome = { status: "ignored", text: `File type ${decodeMode(mode).typeOctal} is not one the kernel creates.` };
  }
  function doSymlink(e) {
    // A target deeper than the lab follows is refused when the link is made, not each time a
    // later name walks through it.
    if (pathDepth(e.target) > MAX_PATH_DEPTH) { fs.limit = fs.limit || "depth"; return; }
    // do_symlink runs clean_path(name, 0) first, then init_symlink(target, name).
    cleanPath(e, e.name, 0);
    // symlink() refuses an empty target (ENOENT), so nothing is created; clean_path has
    // already removed whatever was at the name.
    if (e.target === "") {
      e.outcome = { status: "ignored", text: `An empty link target: symlink() refuses it, so nothing is created.${e.removed ? ` The earlier ${e.name} (from ${e.removed}) has already been removed.` : ""}` };
      return;
    }
    const r = fs.resolve(e.name, false);
    if (r.error || r.self || !fs.nodes.has(r.parent)) { e.outcome = { status: "ignored", text: missing(e, r) }; return; }
    if (r.node) { e.outcome = { status: "ignored", text: `${r.path} is a directory with contents, so the symlink cannot replace it.` }; return; }
    fs.put(r.path, { type: "symlink", mode: e.mode, target: e.target, src: e });
    e.path = r.path;
    e.outcome = e.removed
      ? { status: "replaced", text: `Points to ${e.targetDisplay}. Replaces ${r.path} from ${e.removed}.` }
      : { status: "created", text: `Points to ${e.targetDisplay}.` };
  }
  function missing(e, r) {
    if (r.error === ELOOP) return "Too many symlinks on the way to this name; the kernel skips it.";
    if (r.error === ENOTDIR) return "Part of the path is not a directory; the kernel skips it.";
    if (r.self) return "The name points at a directory itself; nothing is created.";
    if (e.name === "") return "The name is empty; nothing is created.";
    return `Its directory ${r.parent && r.parent !== "/" ? r.parent : parentOf("/" + e.name.replace(/^\/+/, ""))} does not exist yet, so the kernel cannot create it and skips it silently.`;
  }

  // ---- do_reset: eat zero bytes, then complain if a non-zero byte is not at a 4-byte boundary
  function reset(buf, p, end, th, member, streamName) {
    let q = p;
    while (q < end && buf[q] === 0) q++;
    if (q < end && ((th + (q - p)) & 3)) setError("broken padding", member.index, q, streamName);
    return q - p;
  }

  // ---- flush_buffer + write_buffer over a decompressed stream ---------------------------------
  function feedStream(D, member) {
    let j = 0;
    let th = 0; // this_header restarts at 0 for the decompressed stream
    const stream = `member${member.index}`;
    while (j < D.length && !message) {
      if (state === "Start") {
        const r = parseEntry(D, j, D.length, th, member, stream);
        j += r.consumed; th += r.consumed;
        if (!r.complete) { state = message ? "Error" : "Partial"; break; }
        state = "Reset";
        continue;
      }
      const z = reset(D, j, D.length, th, member, stream);
      j += z; th += z;
      if (message || j >= D.length) break;
      if (D[j] === 0x30) state = "Start";
      else setError("junk within compressed archive", member.index, j, stream);
    }
  }

  // The lab's cap on members, checked before each new one is started.
  const tooManyMembers = () => {
    if (res.members.length < MAX_MEMBERS) return false;
    res.labStop = res.labStop || `More than ${MAX_MEMBERS.toLocaleString("en-US")} members (archives and compressed streams, one after another): the lab stops here. The kernel has no such limit and would carry on.`;
    return true;
  };

  // ---- unpack_to_rootfs ------------------------------------------------------------------------
  const B = bytes;
  const len = B.length;
  let i = 0;
  let th = 0;
  while (!message && i < len && !res.labStop) {
    if (B[i] === 0x30 && (th & 3) === 0) {
      state = "Start";
      if (!curRaw) {
        if (tooManyMembers()) break;
        curRaw = { index: res.members.length, kind: "newc", start: i, end: i, entries: [] };
        res.members.push(curRaw);
        curRawItem = { type: "member", member: curRaw.index, start: i, end: i };
        res.items.push(curRawItem);
      }
      const m = curRaw;
      const item = curRawItem; // parseEntry clears curRaw at a TRAILER!!!
      const r = parseEntry(B, i, len, th, m, "input");
      i += r.consumed; th += r.consumed;
      m.end = i;
      item.end = i;
      if (!r.complete) break;
      state = "Reset";
      const z = reset(B, i, len, th, m, "input");
      if (z) res.items.push({ type: "zeros", start: i, end: i + z });
      i += z; th += z;
      continue;
    }
    if (B[i] === 0) {
      let q = i;
      while (q < len && B[q] === 0) q++;
      res.items.push({ type: "zeros", start: i, end: q });
      th += q - i; i = q;
      continue;
    }
    curRaw = null;
    const saved = th;
    th = 0;
    const name = len - i >= 2 ? (COMPRESSED.find(([a, b]) => B[i] === a && B[i + 1] === b) || [])[2] : undefined;
    if (!name) {
      const why = B[i] === 0x30 ? " (a cpio header that does not start on a 4-byte boundary)" : "";
      setError("invalid magic at start of compressed archive", null, i, "input");
      res.items.push({ type: "junk", start: i, end: len, why: `bytes ${hex(B[i], 2)} ${len - i >= 2 ? hex(B[i + 1], 2) : ""}${why}`.trim() });
      break;
    }
    if (tooManyMembers()) break;
    const member = { index: res.members.length, kind: name, start: i, end: i, entries: [] };
    res.members.push(member);
    res.items.push({ type: "member", member: member.index, start: i, end: i });
    if (name !== "gzip") {
      res.labStop = `Member ${member.index + 1} is ${name}-compressed. The kernel would decompress it and carry on after it; this lab can only look inside gzip, so it stops here.`;
      member.end = len;
      res.items[res.items.length - 1].end = len;
      break;
    }
    const g = gunzip(B, i, len, Math.max(0, maxOut - totalOut));
    member.gzip = g;
    member.data = g.out;
    totalOut += g.out.length;
    member.end = Math.min(len, i + g.consumed);
    res.items[res.items.length - 1].end = member.end;
    feedStream(g.out, member);
    if (g.capped) { res.labStop = res.labStop || `Member ${member.index + 1} decompresses to more than the lab's ${maxOut / 1048576} MiB limit, so the lab stops here.`; break; }
    // A lab limit inside the stream (entries, path depth, path steps) is not the kernel's "junk".
    if (res.labStop) break;
    if (g.error) setError(g.error, member.index, i, "input");
    if (!message && state !== "Reset") setError("junk at the end of compressed archive", member.index, member.end, "input");
    if (g.pastEnd) {
      res.pastEnd = member.index;
      res.notes.push(`Member ${member.index + 1}'s 8-byte gzip trailer is cut short. The kernel does not check: it steps 8 bytes past the compressed data, its count of bytes left wraps around to a huge number, and it carries on reading memory after the buffer.`);
    }
    th = saved + g.consumed;
    i += g.consumed;
  }
  if (res.error) res.items.push({ type: "stop", start: res.error.stream === "input" ? res.error.at : (res.members[res.error.member] || {}).start ?? 0, message: res.error.message });
  fs.metered = false; // later lookups (the /init checks) are bounded one by one, not in total
  return res;
}

/**
 * lib/decompress_inflate.c __gunzip, as the initramfs unpacker calls it (no fill function, the
 * whole buffer at once). Only the FNAME field is skipped; FEXTRA, FCOMMENT and FHCRC are not, and
 * the CRC-32 and size in the trailer are never checked. `consumed` is the kernel's `*pos`.
 */
export function gunzip(B, i, len, maxOut = MAX_OUTPUT, { host = false } = {}) {
  const empty = new Uint8Array(0);
  if (len - i < 10 || B[i] !== 0x1f || B[i + 1] !== 0x8b || B[i + 2] !== 0x08) return { out: empty, consumed: 0, error: "Not a gzip file", headerLen: 0 };
  const flags = B[i + 3];
  let p = i + 10;
  let fname = null;
  // A host tool (libarchive) skips every optional field; the kernel only skips FNAME.
  if (host && flags & 0x04) {
    if (p + 2 > len) return { out: empty, consumed: len - i, error: "header error", headerLen: p - i };
    p += 2 + (B[p] | (B[p + 1] << 8));
  }
  if (flags & 0x08) {
    const s = p;
    do {
      if (p >= len) return { out: empty, consumed: len - i, error: "header error", headerLen: p - i };
    } while (B[p++] !== 0);
    fname = displayText(B.subarray(s, p - 1));
  }
  if (host && flags & 0x10) { do { if (p >= len) return { out: empty, consumed: len - i, error: "header error", headerLen: p - i }; } while (B[p++] !== 0); }
  if (host && flags & 0x02) p += 2;
  if (p > len) return { out: empty, consumed: len - i, error: "header error", headerLen: p - i };
  const r = inflateRaw(B, p, { maxOut });
  const g = { out: r.out, headerLen: p - i, flags, fname, mtime: (B[i + 4] | (B[i + 5] << 8) | (B[i + 6] << 16) | (B[i + 7] << 24)) >>> 0 };
  g.unskipped = host ? [] : [flags & 0x04 && "FEXTRA", flags & 0x10 && "FCOMMENT", flags & 0x02 && "FHCRC"].filter(Boolean);
  if (r.error) {
    g.capped = !!r.capped;
    g.error = r.truncated ? "read error" : "uncompression error";
    g.why = r.error;
    g.consumed = len - i;
    return g;
  }
  g.consumed = (p - i) + r.consumed + 8;
  const t = p + r.consumed;
  if (t + 8 <= len) {
    g.crcStored = (B[t] | (B[t + 1] << 8) | (B[t + 2] << 16) | (B[t + 3] << 24)) >>> 0;
    g.isize = (B[t + 4] | (B[t + 5] << 8) | (B[t + 6] << 16) | (B[t + 7] << 24)) >>> 0;
    g.crc = crc32(r.out);
    g.crcOk = g.crc === g.crcStored && g.isize === (r.out.length >>> 0);
  } else {
    g.pastEnd = true;
    g.consumed = len - i;
  }
  return g;
}

// ---------------------------------------------------------------------------------------------
// What happens next: the /init check and the boot-log lines (init/main.c)

function inodeData(node) { return node.inode ? node.inode.data : new Uint8Array(0); }

/**
 * execve() as far as the lab can judge it: 0 on success, or a negative errno. `depth` counts the
 * #! scripts already followed. fs/exec.c exec_binprm loops `for (depth = 0;; depth++) { if
 * (depth > 5) return -ELOOP; ... }`, so a chain of five scripts ending in an ELF program still
 * runs and a sixth script fails (its comment says "4 levels", but the code allows five).
 */
function execCheck(fs, path, depth = 0) {
  if (depth > 5) return { err: ELOOP, why: "#! scripts nested more than five deep" };
  const r = fs.resolve(path, true);
  if (r.error) return { err: r.error, why: r.error === ELOOP ? `too many symlinks on the way to ${path}` : r.error === ENOTDIR ? `part of ${path} is not a directory` : `${path} does not exist` };
  if (!r.node) return { err: ENOENT, why: `${path} does not exist` };
  const n = r.node;
  if (n.type !== "file") return { err: EACCES, why: `${r.path} is a ${n.type === "dir" ? "directory" : "special file"}, not a program` };
  if (!(n.mode & 0o111)) return { err: EACCES, why: `${r.path} has no execute permission (${permString(n.mode)})` };
  const d = inodeData(n);
  if (d.length >= 4 && d[0] === 0x7f && d[1] === 0x45 && d[2] === 0x4c && d[3] === 0x46) return { err: 0, elf: true, path: r.path };
  if (d.length >= 2 && d[0] === 0x23 && d[1] === 0x21) {
    const sb = scriptInterp(d);
    if (sb.err) return { err: ENOEXEC, why: sb.why };
    const interp = sb.interp;
    const sub = execCheck(fs, interp, depth + 1);
    return { ...sub, script: true, interp, path: r.path, why: sub.err ? `its first line asks for ${interp}: ${sub.why}` : sub.why };
  }
  return { err: ENOEXEC, why: `${r.path} is neither a #! script nor an ELF program` };
}

/**
 * fs/binfmt_script.c load_script: the interpreter named on the #! line. The kernel reads the
 * first 256 bytes (BINPRM_BUF_SIZE) into a zero-filled buffer, so a short file ends in NULs.
 * It looks for the newline with strnchr(buf, 256, '\n'), which stops at the first NUL, so a NUL
 * before the newline counts as "no newline". Without one, the name must still end (space, tab or
 * NUL) before buf + 255; otherwise the line was too long and the answer is ENOEXEC.
 */
export function scriptInterp(d) {
  const buf = new Uint8Array(256);
  buf.set(d.subarray(0, 256));
  const end = 255;
  const st = (c) => c === 0x20 || c === 0x09;
  let iEnd = -1;
  for (let k = 0; k < 256 && buf[k] !== 0; k++) if (buf[k] === 0x0a) { iEnd = k; break; }
  if (iEnd < 0) {
    let k = 2;
    while (k < end && st(buf[k])) k++;
    if (k >= end) return { err: ENOEXEC, why: "a #! line of nothing but spaces" };
    let t = k;
    while (t < end && !st(buf[t]) && buf[t] !== 0) t++;
    if (t >= end) return { err: ENOEXEC, why: "a #! line longer than the 256 bytes the kernel reads" };
    iEnd = end;
  }
  let k = 2;
  while (k < iEnd && st(buf[k])) k++;
  if (k >= iEnd || buf[k] === 0) return { err: ENOEXEC, why: "a #! line with no interpreter name" };
  let e = k;
  while (e < iEnd && buf[e] !== 0 && !st(buf[e])) e++;
  return { err: 0, interp: latin1(buf, k, e) };
}

/** init_eaccess(MAY_EXEC) as root: the file must exist; a regular file needs an execute bit. */
function accessCheck(fs, path) {
  const r = fs.resolve(path, true);
  if (r.error) return r.error;
  if (!r.node) return ENOENT;
  if (r.node.type === "dir") return 0;
  return r.node.mode & 0o111 ? 0 : EACCES;
}

const CAPTURED = "captures/14-boot.txt";
const CAPTURED_PANIC = "captures/13-bad-magic-raw.txt";

/**
 * The kernel log lines this buffer leads to, from "Unpacking initramfs..." to the first program
 * (or the panic). Each line says whether it was seen in a real capture or follows from the source.
 */
export function bootLog(res) {
  const L = [];
  const add = (text, source, note) => L.push({ text, source, note });
  add("Unpacking initramfs...", CAPTURED);
  if (res.pastEnd != null) {
    add("...", "lab", `Member ${res.pastEnd + 1}'s gzip trailer is cut short. The kernel's count of bytes left wraps around and it reads on past the end of the buffer, so what happens next depends on whatever memory follows: an "invalid magic" error, a fault, or a long run of zeros skipped.`);
    return { lines: L, outcome: "unknown", why: "pastEnd" };
  }
  if (res.error) add(`Initramfs unpacking failed: ${res.error.message}`, "init/initramfs.c", "The kernel keeps whatever it unpacked before this point.");
  const pages = Math.floor(res.length / 4096);
  if (pages > 0) add(`Freeing initrd memory: ${pages * 4}K`, CAPTURED, "Whole 4 KiB pages only (macvmm starts the initramfs on a 2 MiB boundary).");
  if (res.labStop) {
    add("...", "lab", "The lab cannot follow the rest of the buffer, so it cannot say which /init the kernel finds.");
    return { lines: L, outcome: "unknown", why: "labStop" };
  }
  const fs = res.rootfs;
  // Dry run of every lookup below. Each is bounded (Rootfs.resolve); if one hits a bound, the
  // lab says so instead of printing a kernel line it cannot stand behind.
  fs.limit = null;
  accessCheck(fs, "/init");
  for (const p of ["/init", "/sbin/init", "/etc/init", "/bin/init", "/bin/sh"]) execCheck(fs, p);
  if (fs.limit) {
    add("...", "lab", `The lab cannot say which program the kernel runs: looking for it, ${LIMIT_TEXT[fs.limit]}.`);
    return { lines: L, outcome: "unknown", why: "labStop" };
  }
  const acc = accessCheck(fs, "/init");
  if (acc) {
    // The capture only shows -2 (no /init at all); any other code follows from the source.
    add(`check access for rdinit=/init failed: ${acc}, ignoring`, acc === ENOENT ? CAPTURED_PANIC : "init/main.c", acc === ENOENT ? "There is no /init in the rootfs." : "/init is there but not executable.");
    add("md: Skipping autodetection of RAID arrays. (raid=autodetect will force)", CAPTURED_PANIC, "prepare_namespace() prints this on its way to mounting a disk.");
    add("List of all partitions:", CAPTURED_PANIC);
    add("No filesystem could mount root, tried: ", CAPTURED_PANIC);
    add("", CAPTURED_PANIC, "An empty line: the list of filesystems tried is empty.");
    add('Kernel panic - not syncing: VFS: Unable to mount root fs on "" or unknown-block(0,0)', CAPTURED_PANIC, "No root= disk was given, so there is nothing to fall back to.");
    return { lines: L, outcome: "panic", init: null };
  }
  const tryRun = (path, first) => {
    add(`Run ${path} as init process`, first ? CAPTURED : "init/main.c");
    const r = execCheck(fs, path);
    return r;
  };
  const r = tryRun("/init", true);
  if (!r.err) return { lines: L, outcome: "runs", init: r, note: r.elf ? "An ELF program: the kernel loads it if it is a valid arm64 executable (the lab does not check that)." : null };
  add(`Failed to execute /init (error ${r.err})`, "init/main.c", r.why);
  for (const p of ["/sbin/init", "/etc/init", "/bin/init", "/bin/sh"]) {
    const x = tryRun(p, false);
    if (!x.err) return { lines: L, outcome: "fallback", init: x, failed: r };
    if (x.err !== ENOENT) add(`Starting init: ${p} exists but couldn't execute it (error ${x.err})`, "init/main.c", x.why);
  }
  add("Kernel panic - not syncing: No working init found.  Try passing init= option to kernel. See Linux Documentation/admin-guide/init.rst for guidance.", "init/main.c");
  return { lines: L, outcome: "noinit", failed: r };
}

/** Where /init comes from: the entry that wrote the file /init resolves to. */
export function initSource(res) {
  const r = res.rootfs.resolve("/init", true);
  if (!r.node || r.error) return null;
  const n = r.node;
  return { path: r.path, node: n, src: n.src, size: n.inode ? n.inode.size : 0, data: n.inode ? n.inode.data : null, viaSymlink: r.path !== "/init" };
}

/** The final rootfs as sorted rows for display. */
export function rootfsRows(res) {
  const rows = [];
  for (const [path, n] of res.rootfs.nodes) {
    if (path === "/") continue;
    rows.push({
      path, type: n.type, mode: n.mode, ls: decodeMode(n.mode).ls,
      size: n.type === "file" ? n.inode.size : n.type === "symlink" ? n.target.length : 0,
      target: n.type === "symlink" ? n.target : null, rdev: n.rdev || null,
      from: n.src === BUILTIN ? "built-in" : n.src ? { member: n.src.member, index: n.src.index } : null,
    });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The host tool's view: bsdcpio -itv (libarchive). One archive, then stop.

/**
 * bsdcpio's listing line: "%s%3d %-8s %-8s %8s %12s %s" (mode string, links, user, group, size,
 * date, name). For a character or block device the size column holds "major,minor" instead
 * (libarchive's cpio.c list_item_verbose).
 */
export function lsLine(x, opts = {}) {
  const now = opts.now ?? x.mtime;
  const tz = opts.tzOffsetMin ?? 0;
  const d = new Date((x.mtime + tz * 60) * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const day = String(d.getUTCDate()).padStart(2, " ");
  const recent = Math.abs(x.mtime - now) <= (365 / 2) * 86400;
  const date = recent
    ? `${mon} ${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
    : `${mon} ${day}  ${d.getUTCFullYear()}`;
  const user = x.uid === 0 ? "root" : String(x.uid);
  const group = x.gid === 0 ? "wheel" : String(x.gid);
  const name = x.kind === "symlink" && x.target != null ? `${x.nameDisplay} -> ${x.targetDisplay}` : x.linkTo != null ? `${x.nameDisplay} link to ${x.linkTo}` : x.nameDisplay;
  const t = typeOf(x.mode).key;
  const size = (t === "chr" || t === "blk") && x.rmaj != null ? `${x.rmaj},${x.rmin}` : String(x.size);
  return `${decodeMode(x.mode).ls} ${String(x.nlink).padStart(3, " ")} ${user.padEnd(8, " ")} ${group.padEnd(8, " ")} ${size.padStart(8, " ")} ${date.padStart(12, " ")} ${name}`;
}

/**
 * libarchive's record_hardlink, ported: an entry with nlink > 1 is keyed on its device and inode
 * (no check of its type, so directories link too). The first name is remembered with a count of
 * nlink - 1 names still to come; each later match becomes "link to <first>" and counts down, and
 * at zero the record is dropped, so a further name with the same inode lists plainly.
 */
function hardLinks() {
  const seen = new Map();
  return (x, dev) => {
    if (x.nlink <= 1) return;
    const key = `${dev}:${x.ino}`;
    const le = seen.get(key);
    if (le) {
      x.linkTo = le.name;
      if (--le.links <= 0) seen.delete(key);
      return;
    }
    seen.set(key, { name: x.nameDisplay, links: x.nlink - 1 });
  };
}

export function hostView(bytes) {
  let stream = bytes;
  let format = "";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // libarchive's gzip filter carries on into a gzip member that starts right where the last one
    // ended (no zero bytes skipped), so concatenated gzip files read as one stream.
    const outs = [];
    let off = 0;
    let total = 0;
    while (off + 2 <= bytes.length && bytes[off] === 0x1f && bytes[off + 1] === 0x8b && total < MAX_OUTPUT) {
      // The lab's member cap applies to this reading of the file too.
      if (outs.length >= MAX_MEMBERS) return { ok: false, lab: true, text: `More than ${MAX_MEMBERS.toLocaleString("en-US")} gzip members: the lab does not follow a host tool that far.` };
      const g = gunzip(bytes, off, bytes.length, MAX_OUTPUT - total, { host: true });
      outs.push(g.out);
      total += g.out.length;
      if (g.error || g.pastEnd || g.consumed <= 0) break;
      off += g.consumed;
    }
    if (total === 0) return { ok: false, text: "The host tool cannot decompress it." };
    stream = outs.length === 1 ? outs[0] : concat(...outs);
    format = outs.length > 1 ? `${outs.length} gzip members read as one stream, then ` : "gzip, then ";
  }
  const magic = latin1(stream, 0, Math.min(6, stream.length));
  const items = [];
  let p = 0;
  if (magic === "070701" || magic === "070702") {
    format += "newc";
    // libarchive insists on 110 hex characters after the magic. A header that fails is
    // "damaged": it scans on for the next good one, and bsdcpio stops at that warning.
    const good = (q) => {
      if (q + HEADER > stream.length) return false;
      const m = latin1(stream, q, q + 6);
      if (m !== "070701" && m !== "070702") return false;
      for (let k = q + 6; k < q + HEADER; k++) if (!isHex(stream[k])) return false;
      return true;
    };
    // libarchive's find_newc_header scan, step for step: it hops 1, 2 or 6 bytes depending on
    // the character at p + 5, so it can step over a good header. bsdcpio stops at its warning.
    const damaged = (q) => {
      let r = q;
      while (r + HEADER <= stream.length) {
        const c = stream[r + 5];
        if (c === 0x31 || c === 0x32) {
          if (good(r)) return { ok: true, format, items, stoppedAt: q, error: "a damaged header", says: `cpio: Skipped ${r - q} bytes before finding valid header` };
          r += 2;
        } else if (c === 0x30) r += 1;
        else r += 6;
      }
      return { ok: true, format, items, stoppedAt: q, error: "a damaged header", says: "cpio: (null)" };
    };
    const link = hardLinks();
    while (p + HEADER <= stream.length && items.length < MAX_ENTRIES) {
      if (!good(p)) return damaged(p);
      const f = [];
      for (let k = 0; k < 13; k++) f.push(parseField(stream, p + 6 + k * 8).value);
      const namesize = f[11], size = f[6];
      if (namesize < 1 || p + HEADER + namesize > stream.length) return damaged(p);
      let nul = p + HEADER;
      while (nul < p + HEADER + namesize - 1 && stream[nul] !== 0) nul++;
      const nameBytes = stream.subarray(p + HEADER, nul);
      const name = latin1(stream, p + HEADER, nul);
      if (name === "TRAILER!!!") return { ok: true, format, items, stoppedAt: p, trailer: true };
      const dataOff = p + align4(HEADER + namesize);
      const x = { ino: f[0], mode: f[1], uid: f[2], gid: f[3], nlink: f[4], mtime: f[5], size, rmaj: f[9], rmin: f[10], name, nameDisplay: displayText(nameBytes), kind: typeOf(f[1]).key };
      if (x.kind === "symlink") x.targetDisplay = displayText(stream.subarray(dataOff, Math.min(stream.length, dataOff + size)));
      x.target = x.targetDisplay;
      link(x, `${f[7]}:${f[8]}`); // newc's device is c_maj:c_min
      items.push(x);
      // bsdcpio lists the entry, then skips its data and padding; if the input ends first it
      // stops with this message (checked against /usr/bin/cpio, ": Unknown error: -1" included).
      const need = align4(size);
      if (dataOff + need > stream.length) {
        const have = Math.max(0, stream.length - dataOff);
        return { ok: true, format, items, stoppedAt: p, error: "truncated input", says: `cpio: Truncated input file (needed ${need} bytes, only ${have} available): Unknown error: -1` };
      }
      p = dataOff + need;
    }
    // Out of data (or only zeros left) before a trailer: bsdcpio prints its empty error.
    return { ok: true, format, items, stoppedAt: p, error: "the end of the data before a trailer", says: "cpio: (null)" };
  }
  if (magic === "070707") {
    // odc (POSIX.1 portable format): 76-byte header of octal fields, no padding.
    format += "odc";
    const link = hardLinks();
    const oct = (o, n) => { let v = 0; for (let k = 0; k < n; k++) { const c = stream[o + k]; if (c < 0x30 || c > 0x37) return NaN; v = v * 8 + (c - 0x30); } return v; };
    while (p + 76 <= stream.length && items.length < MAX_ENTRIES) {
      if (latin1(stream, p, p + 6) !== "070707") return { ok: true, format, items, stoppedAt: p, error: "a damaged header" };
      const mode = oct(p + 18, 6), uid = oct(p + 24, 6), gid = oct(p + 30, 6), nlink = oct(p + 36, 6);
      const mtime = oct(p + 48, 11), namesize = oct(p + 59, 6), size = oct(p + 65, 11);
      const dev = oct(p + 6, 6), ino = oct(p + 12, 6), rdev = oct(p + 42, 6);
      if ([dev, ino, mode, uid, gid, nlink, rdev, mtime, namesize, size].some(Number.isNaN) || namesize < 1 || p + 76 + namesize > stream.length) return { ok: true, format, items, stoppedAt: p, error: "a damaged header" };
      const nameBytes = stream.subarray(p + 76, p + 76 + namesize - 1);
      const name = latin1(nameBytes, 0, nameBytes.length);
      if (name === "TRAILER!!!") return { ok: true, format, items, stoppedAt: p, trailer: true };
      // odc stores one rdev number; macOS splits a dev_t as major = top 8 bits, minor = low 24.
      const x = { ino, mode, uid, gid, nlink, mtime, size, rmaj: rdev >>> 24, rmin: rdev & 0xffffff, name, nameDisplay: displayText(nameBytes), kind: typeOf(mode).key, target: null };
      link(x, String(dev));
      items.push(x);
      p += 76 + namesize + size;
    }
    return { ok: true, format, items, stoppedAt: p, error: "the end of the data before a trailer" };
  }
  return { ok: false, text: "The host tool does not recognise the format and lists nothing." };
}

// ---------------------------------------------------------------------------------------------
// Entry layout: the regions the primer's tables name, and a hex dump

/** The byte regions of one entry, offsets relative to its stream (primer: "Padding"). */
export function regions(e) {
  const R = [];
  if (e.kind === "cut") return R;
  if (e.kind === "bad") return [{ kind: "magic", from: e.off, to: e.off + 6, label: "magic (wrong)" }, { kind: "other", from: e.off + 6, to: e.off + HEADER, label: "rest of the header" }];
  R.push({ kind: "magic", from: e.off, to: e.off + 6, label: "magic" });
  for (let i = 0; i < 13; i++) R.push({ kind: "field", field: i, from: e.off + 6 + i * 8, to: e.off + 14 + i * 8, label: FIELDS[i].name });
  if (e.namesize > 0 && e.namesize <= PATH_MAX) {
    R.push({ kind: "name", from: e.nameOff, to: e.nameOff + e.namesize, label: "name and its NUL" });
    if (e.dataOff > e.nameOff + e.namesize) R.push({ kind: "pad", from: e.nameOff + e.namesize, to: e.dataOff, label: "padding" });
  } else if (e.dataOff > e.nameOff) {
    R.push({ kind: "name", from: e.nameOff, to: e.dataOff, label: "name (size out of range)" });
  }
  if (e.filesize > 0) R.push({ kind: "data", from: e.dataOff, to: e.dataOff + e.filesize, label: e.kind === "symlink" ? "link target" : "data" });
  const dEnd = e.dataOff + e.filesize;
  if (e.nextHeader > dEnd) R.push({ kind: "pad", from: dEnd, to: e.nextHeader, label: "padding" });
  return R;
}

/** Rows of 16 bytes from `from` to `to`, each byte tagged with its region kind. */
export function hexRows(buf, from, to, regs) {
  const rows = [];
  const end = Math.min(to, buf.length);
  let ri = 0;
  for (let row = from - (from % 16); row < end; row += 16) {
    const cells = [];
    for (let k = row; k < row + 16; k++) {
      if (k < from || k >= end) { cells.push(null); continue; }
      while (ri < regs.length && regs[ri].to <= k) ri++;
      const r = regs[ri] && regs[ri].from <= k ? regs[ri] : null;
      cells.push({ off: k, byte: buf[k], kind: r ? r.kind : "other", field: r ? r.field : undefined });
    }
    rows.push({ off: row, cells });
  }
  return rows;
}

/** Bytes as text for a preview: printable ASCII kept, newline kept, others as \xNN. */
export function previewText(data, max = 2048) {
  let s = "";
  const n = Math.min(data.length, max);
  for (let i = 0; i < n; i++) {
    const c = data[i];
    if (c === 0x0a || c === 0x09 || (c >= 0x20 && c < 0x7f)) s += String.fromCharCode(c);
    else s += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return { text: s, more: data.length - n };
}

// ---------------------------------------------------------------------------------------------
// Sample archives, built the way the primer builds them

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const h8 = (n) => (n >>> 0).toString(16).padStart(8, "0");

/** One newc entry: header, name + NUL padded so data starts on 4, data padded to 4. */
export function newcEntry(x) {
  const name = enc(x.name);
  const data = typeof x.data === "string" ? enc(x.data) : (x.data || new Uint8Array(0));
  const f = [x.ino ?? 0, x.mode ?? 0, x.uid ?? 0, x.gid ?? 0, x.nlink ?? 1, x.mtime ?? 0, data.length,
    x.maj ?? 0, x.min ?? 0, x.rmaj ?? 0, x.rmin ?? 0, name.length + 1, x.check ?? 0];
  const head = enc((x.magic ?? "070701") + f.map(h8).join(""));
  const nameEnd = align4(HEADER + name.length + 1);
  const total = align4(nameEnd + data.length);
  const out = new Uint8Array(total);
  out.set(head, 0); out.set(name, HEADER); out.set(data, nameEnd);
  return out;
}

export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const padTo = (b, block) => concat(b, new Uint8Array((block - (b.length % block)) % block));
const pad4 = (b) => padTo(b, 4);

/** bsdcpio's trailer: everything zero except c_nlink = 1 and c_namesize = 11. */
const TRAILER = () => newcEntry({ name: "TRAILER!!!", nlink: 1 });

// The primer's tiny.cpio header values (its fold output): ino, mtime and device as printed there.
const PRIMER = { ino: 0x0162738e, mtime: 0x6afeb8f4, maj: 1, min: 0x10, nlink: 1, mode: 0o100755 };

export function tinyCpio(text = "#!/bin/sh\necho hello\n") {
  return padTo(concat(newcEntry({ ...PRIMER, name: "init", data: text }), TRAILER()), 512);
}

/** odc (what plain `cpio -o` writes on macOS): octal fields, no padding, then a 512-byte block. */
function odcEntry(name, mode, data, extra = {}) {
  const o = (n, w) => n.toString(8).padStart(w, "0");
  const nb = enc(name);
  const db = enc(data);
  const head = enc("070707" + o(extra.dev ?? 0, 6) + o(extra.ino ?? 0, 6) + o(mode, 6) + o(0, 6) + o(0, 6) + o(extra.nlink ?? 1, 6) + o(0, 6) + o(extra.mtime ?? 0, 11) + o(nb.length + 1, 6) + o(db.length, 11));
  return concat(head, nb, new Uint8Array(1), db);
}

// A miniature Alpine initramfs-virt. The real one is 9,404,792 bytes of gzip holding 288 entries;
// this one keeps the shape (directories first, busybox, a symlink, Alpine's own /init).
export const MINI_ALPINE = [
  { name: "bin", mode: 0o040755, nlink: 2 },
  { name: "bin/busybox", mode: 0o100755, data: "\x7fELF (a stand-in: the real busybox is an arm64 program)\n" },
  { name: "bin/sh", mode: 0o120777, data: "busybox" },
  { name: "dev", mode: 0o040755, nlink: 2 },
  { name: "etc", mode: 0o040755, nlink: 2 },
  { name: "etc/motd", mode: 0o100644, data: "Welcome to Alpine!\n" },
  { name: "init", mode: 0o100755, data: "#!/bin/sh\n# Alpine's own /init (30,369 bytes in the real archive)\necho alpine init\n" },
];

export function buildNewc(list, { ino = 1 } = {}) {
  const parts = list.map((x, k) => newcEntry({ ino: ino + k, nlink: 1, ...x }));
  return concat(...parts, TRAILER());
}

// `gzip -n -9` of buildNewc(MINI_ALPINE), made once with the system gzip (model.test.mjs checks
// it inflates back to exactly that archive). 303 bytes: not a multiple of 4, which the
// `nopad` preset needs.
const MINI_ALPINE_GZ_B64 =
  "H4sIAAAAAAACA7WSPWvDMBCGNftXnMnQBFos1V9JtwwpFDKFQmfZvtQCWwqWmjZT/3r9EVPbtFQN5B2kE9LpeaU7GtOYMtqpnQOGGf1Z9/QyBX2QCEkIoUNme+fydyYbL/2lJTMdML3kTZ8S9VGzPzfbR5hz0IbL7E7IBzA5QoW8gPMhEBq4BF6VUQCHSr1WvFw4I89+M3C239t5rjPtFA8967y2S3rnI35w7TpleJzWKbw2E006ZUZdb/DA7p+Zb8lcDZheqUxGyAsWqSoRjIJ1cRASXWfsJf5fn4a2XsI+EFIYQmau1xXfmZ2N3GhQ7xK8Zh/mPr31oxUkJ4MahPzuXl6luTjiwsE0V8DbVGhyJu/4S+zCOiZ98LxbP203O9d1m/79Ao2HzRFgBAAA";

const b64 = (s) => {
  if (typeof atob === "function") return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(s, "base64"));
};

/** The overlay `cargo xtask mkinitramfs` appends: inode numbers from 1, mtime 0, owner root. */
export function xtaskOverlay(files) {
  const list = [];
  const dirs = new Set();
  for (const f of files) {
    const comps = f.name.split("/");
    for (let k = 1; k < comps.length; k++) {
      const d = comps.slice(0, k).join("/");
      if (!dirs.has(d)) { dirs.add(d); list.push({ name: d, mode: 0o040755, nlink: 2 }); }
    }
    list.push(f);
  }
  return buildNewc(list);
}

const OUR_INIT = "#!/bin/sh\n# our /init, appended after Alpine's archive\necho \"macvmm-initramfs: ready\"\n";

export const PRESETS = [
  { key: "both", label: "both.cpio: two archives glued with cat", build: () => concat(tinyCpio(), tinyCpio("#!/bin/sh\necho second\n")),
    about: "The primer's puzzle: tiny.cpio then second.cpio, each one 512-byte block, each with its own init.",
    question: "cpio -itv lists only the first init (21 bytes, echo hello). Which init does the kernel pick: the first or the second?",
    caveat: "The kernel picks /init from member 2. Its /init starts #!/bin/sh, and this tiny archive has no /bin/sh, so on its own the boot ends in a panic; the overlay sample shows the real case, appended to Alpine's archive, where busybox provides /bin/sh." },
  { key: "tiny", label: "tiny.cpio: one archive, one file", build: () => tinyCpio(),
    about: "The archive the primer takes apart byte by byte (its header values: inode, time and disk as printed there).",
    caveat: "The kernel finds this /init. Its /init starts #!/bin/sh, and this tiny archive has no /bin/sh, so on its own the boot ends in a panic; the overlay sample shows the real case, appended to Alpine's archive, where busybox provides /bin/sh." },
  { key: "bad", label: "bad.cpio: both.cpio with the magic broken", build: () => { const b = concat(tinyCpio(), tinyCpio("#!/bin/sh\necho second\n")); b[5] = 0x38; return b; },
    about: "The primer's experiment: byte 5 changed from 1 to 8, so the archive starts 070708.",
    question: "The archive now starts 070708. What does the kernel print, and does any /init run?" },
  { key: "odc", label: "plain cpio -o: the odc format", build: () => padTo(concat(odcEntry("init", 0o100755, "#!/bin/sh\necho hello\n", { ino: 1 }), odcEntry("TRAILER!!!", 0, "")), 512),
    about: "What macOS cpio writes without -H newc: magic 070707 and octal fields.",
    question: "The host tool lists this archive happily. What does the kernel print?" },
  { key: "stock", label: "A miniature Alpine initramfs (gzip)", build: () => b64(MINI_ALPINE_GZ_B64),
    about: "Shaped like Alpine's initramfs-virt: one gzip member holding directories, busybox (a stand-in), a symlink, etc/motd and Alpine's /init." },
  { key: "overlay", label: "Miniature Alpine plus our /init (like initramfs-test.img)", build: () => concat(pad4(b64(MINI_ALPINE_GZ_B64)), xtaskOverlay([{ name: "init", mode: 0o100755, data: OUR_INIT }])),
    about: "How macvmm builds initramfs-test.img: Alpine's archive, zero bytes up to a 4-byte boundary, then an uncompressed newc member whose /init replaces Alpine's. In the real file that /init is a small compiled program (an ELF file of about 22 KB); this sample uses a three-line shell script as a stand-in, so the lab calls it a #! script here and an ELF program there." },
  { key: "motd", label: "Miniature Alpine plus a new etc/motd", build: () => concat(pad4(b64(MINI_ALPINE_GZ_B64)), xtaskOverlay([{ name: "etc/motd", mode: 0o100644, data: "Hello from the appended member.\n" }])),
    about: "The primer's self-check: append a member that holds only etc/motd.",
    question: "Which /etc/motd does the guest see, and does Alpine's /init still run?" },
  { key: "nopad", label: "Overlay appended without padding", build: () => concat(b64(MINI_ALPINE_GZ_B64), xtaskOverlay([{ name: "init", mode: 0o100755, data: OUR_INIT }])),
    about: "The same overlay glued straight after the gzip member, which ends at an offset that is not a multiple of 4.",
    question: "The overlay is the same as in the sample before; only the zero padding is gone. Which /init runs now?" },
  { key: "noinit", label: "An archive with no init", build: () => buildNewc([{ name: "hello.txt", mode: 0o100644, data: "no init here\n" }]),
    about: "One file and no /init.",
    question: "What does the kernel do when the initramfs has no first program?" },
];
export const DEFAULT_PRESET = "both";

export function presetBytes(key) {
  const p = PRESETS.find((x) => x.key === key);
  return p ? p.build() : null;
}

// ---------------------------------------------------------------------------------------------
// Share state: <preset>[~<offset hex>=<byte hex>]...[@<member>.<entry>] (1-based)

export const REFERENCE = "both@2.1";

export function encodeShare(s) {
  if (!s || !s.preset) return null;
  let out = s.preset;
  for (const p of s.patches || []) out += `~${p.off.toString(16)}=${p.byte.toString(16).padStart(2, "0")}`;
  if (s.select) out += `@${s.select.member + 1}.${s.select.index + 1}`;
  if (out === `${DEFAULT_PRESET}@1.1` || out === DEFAULT_PRESET) return null;
  return out;
}

export function decodeShare(str) {
  if (typeof str !== "string" || str.length > 400) return null;
  const m = /^([a-z]+)((?:~[0-9a-f]{1,8}=[0-9a-f]{2})*)(?:@(\d{1,6})\.(\d{1,6}))?$/.exec(str);
  if (!m || !PRESETS.some((p) => p.key === m[1])) return null;
  const patches = [];
  for (const part of m[2].split("~").slice(1)) {
    const [o, b] = part.split("=");
    patches.push({ off: parseInt(o, 16), byte: parseInt(b, 16) });
  }
  if (patches.length > MAX_PATCHES) return null;
  const select = m[3] ? { member: Number(m[3]) - 1, index: Number(m[4]) - 1 } : null;
  if (select && (select.member < 0 || select.index < 0)) return null;
  return { preset: m[1], patches, select };
}

/** A copy of `bytes` with the patches applied; out-of-range patches are dropped and reported. */
export function applyPatches(bytes, patches) {
  const out = bytes.slice();
  const applied = [];
  for (const p of patches || []) {
    if (Number.isInteger(p.off) && p.off >= 0 && p.off < out.length && Number.isInteger(p.byte) && p.byte >= 0 && p.byte <= 255) {
      out[p.off] = p.byte;
      applied.push(p);
    }
  }
  return { bytes: out, applied };
}

/** Parse "0x1f", "31", "1f" (as hex if it has a-f) for the patch form. Returns null if bad. */
export function parseNumber(s, { max = 0xffffffff, hexDefault = false } = {}) {
  if (typeof s !== "string") return null;
  const t = s.trim().replace(/_/g, "");
  if (!t || t.length > 12) return null;
  let v;
  if (/^0x[0-9a-f]+$/i.test(t)) v = parseInt(t.slice(2), 16);
  else if (hexDefault && /^[0-9a-f]+$/i.test(t)) v = parseInt(t, 16);
  else if (/^[0-9]+$/.test(t)) v = parseInt(t, 10);
  else return null;
  return v <= max ? v : null;
}

/** Parse the byte box: a number (0x38, 56) or one quoted/plain character ('8' or 8 means 0x38 only when quoted). */
export function parseByte(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  const q = /^'(.)'$/.exec(t) || /^"(.)"$/.exec(t);
  if (q) { const c = q[1].charCodeAt(0); return c <= 255 ? c : null; }
  return parseNumber(t, { max: 255 });
}

// ---------------------------------------------------------------------------------------------
// One-line summary for the readout

const MAGIC_NAME = { "070707": "odc" };

/**
 * A member's format in words. An uncompressed member is "raw newc" only when its first header
 * really carries a newc magic; otherwise it says which magic the kernel found instead.
 */
export function memberLabel(m) {
  if (m.kind !== "newc") return m.kind;
  const first = m.entries[0];
  if (!first || first.kind === "cut") return "uncompressed, cut short";
  if (first.kind === "bad") {
    const known = Object.hasOwn(MAGIC_NAME, first.magic) ? MAGIC_NAME[first.magic] : null; // six bytes of the file
    return `uncompressed, magic ${safeText(first.magic)}${known ? `, which is ${known}` : ""}, not newc`;
  }
  return "raw newc";
}

/** "N entries (plus M TRAILER!!! markers)": the counts that match the Entries table. */
export function entryCount(res) {
  const files = res.entries.filter((e) => e.kind !== "trailer" && e.kind !== "cut" && e.kind !== "bad").length;
  const trailers = res.entries.filter((e) => e.kind === "trailer").length;
  let s = `${files} entr${files === 1 ? "y" : "ies"}`;
  if (trailers) s += ` (plus ${trailers} TRAILER!!! marker${trailers === 1 ? "" : "s"})`;
  return s;
}

export function summary(res, host) {
  const n = res.members.length;
  const kinds = res.members.map(memberLabel).join("; ");
  const parts = [`${res.length.toLocaleString("en-US")} bytes, ${n} member${n === 1 ? "" : "s"}${n ? ` (${kinds})` : ""}, ${entryCount(res)}.`];
  if (res.error) parts.push(`Unpacking stops with "${res.error.message}" (Linux logs "Initramfs unpacking failed"), but the boot goes on with what was unpacked before it.`);
  if (res.labStop) parts.push(res.labStop);
  else if (res.pastEnd != null) parts.push(`Member ${res.pastEnd + 1}'s gzip trailer is cut short, so the kernel reads past the end of the buffer and the result depends on the memory after it.`);
  else {
    const src = initSource(res);
    if (src && src.src && src.src !== BUILTIN) parts.push(`/init comes from member ${src.src.member + 1}, entry ${src.src.index + 1}.`);
    else parts.push("There is no /init in the rootfs.");
  }
  if (host) parts.push(host.ok ? `A host cpio tool lists ${host.items.length} entr${host.items.length === 1 ? "y" : "ies"}.` : host.lab ? host.text : "A host cpio tool lists nothing.");
  return parts.join(" ");
}
