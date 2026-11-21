// Tests for the cpio-inspector model. Run: node --test course/site/
//
// 1. The primer's numbers: the test reads course/primers/cpio-initramfs.md and checks the lab
//    against its xxd dumps, its fold output, its five-region table, its listing lines and its
//    self-check answers, so the lab and the primer cannot drift apart.
// 2. The real tools on this machine: the presets are compared with archives /usr/bin/cpio
//    (bsdcpio) builds from the primer's own commands, and the host view with `cpio -itv`.
// 3. The real initramfs: .cache/macvmm/initramfs-test.img against the primer's measurements and
//    the boot capture (captures/14-boot.txt).
// 4. Every error string of init/initramfs.c the lab can reach, and hostile inputs.
// Tests that need a tool or a file this machine lacks skip with a message.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import {
  HEADER, nAlign, align4, parseField, decodeMode, sniff, unpack, gunzip, bootLog, initSource,
  rootfsRows, hostView, lsLine, regions, hexRows, previewText, newcEntry, concat, buildNewc,
  tinyCpio, MINI_ALPINE, PRESETS, presetBytes, REFERENCE, encodeShare, decodeShare, applyPatches,
  parseNumber, parseByte, summary, MAX_PATCHES, scriptInterp, memberLabel, displayText, displayName,
} from "./model.mjs";
import { inflateRaw, crc32 } from "./inflate.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PRIMER = here("../../../../primers/cpio-initramfs.md");
const CHAPTER = here("../../../../chapters/VI/13-loaders.md");
const BOOT = here("../../../../captures/14-boot.txt");
const PANIC = here("../../../../captures/13-bad-magic-raw.txt");
const LABS_MD = here("../../../LABS.md");
const REAL = here("../../../../../.cache/macvmm/initramfs-test.img");
const BASE = here("../../../../../.cache/macvmm/initramfs-virt");
const CPIO = "/usr/bin/cpio";

const primer = () => readFileSync(PRIMER, "utf8");
/** The body of the fenced block that follows the first line matching `after`. */
function blockAfter(md, after) {
  const i = md.indexOf(after);
  assert.ok(i >= 0, `primer has ${after}`);
  const start = md.indexOf("```text\n", i);
  const end = md.indexOf("\n```", start + 8);
  return md.slice(start + 8, end);
}
const xxd = (b, base, n) => {
  const rows = [];
  for (let o = 0; o < n; o += 16) {
    const chunk = [...b.subarray(base + o, base + Math.min(n, o + 16))];
    const hexs = [];
    for (let k = 0; k < chunk.length; k += 2) hexs.push(chunk.slice(k, k + 2).map((x) => x.toString(16).padStart(2, "0")).join(""));
    const ascii = chunk.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : ".")).join("");
    rows.push(`${(base + o).toString(16).padStart(8, "0")}: ${hexs.join(" ").padEnd(39, " ")}  ${ascii}`);
  }
  return rows.join("\n");
};
const both = () => presetBytes("both");

// ---------------------------------------------------------------------------------------------
// 1. The primer

test("tiny.cpio: the primer's xxd dumps and its 512-byte size", () => {
  const md = primer();
  const t = presetBytes("tiny");
  assert.equal(t.length, 512);
  assert.match(md, /^\s+512\s+<- printed by wc -c/m);
  assert.equal(xxd(t, 0, 16), blockAfter(md, "xxd -l 16 tiny.cpio"));
  assert.equal(xxd(t, 104, 40).replace(/ +$/gm, ""), blockAfter(md, "xxd -s 104 -l 40 tiny.cpio").replace(/ +$/gm, ""));
});

test("the fold output is the 13 fields, and the field table matches", () => {
  const md = primer();
  const fold = blockAfter(md, "head -c 110 tiny.cpio | tail -c 104 | fold -w 8").split("\n");
  const r = unpack(presetBytes("tiny"));
  const e = r.entries[0];
  assert.deepEqual(e.fields.map((f) => f.raw), fold);
  assert.deepEqual(e.fields.map((f) => f.name), ["c_ino", "c_mode", "c_uid", "c_gid", "c_nlink", "c_mtime", "c_filesize", "c_maj", "c_min", "c_rmaj", "c_rmin", "c_namesize", "c_chksum"]);
  for (const f of e.fields) assert.ok(md.includes(`\`${f.name}\``), `${f.name} named in the primer`);
  assert.equal(e.filesize, 21);
  assert.equal(e.namesize, 5);
});

test("c_mode decodes as the primer does (0x81ed, and the self-check's 0x41ed and 0xa1ff)", () => {
  const m = decodeMode(0x81ed);
  assert.equal(m.octal, "0100755");
  assert.equal(m.typeOctal, "0100000");
  assert.equal(m.typeName, "regular file");
  assert.equal(m.perms, "0755");
  assert.equal(m.rwx, "rwxr-xr-x");
  assert.equal(decodeMode(0x41ed).octal, "040755");
  assert.equal(decodeMode(0x41ed).type, "dir");
  assert.equal(decodeMode(0xa1ff).octal, "0120777");
  assert.equal(decodeMode(0xa1ff).type, "symlink");
  assert.equal(decodeMode(0o020600).type, "chr");
  assert.equal(decodeMode(0o104755).rwx, "rwsr-xr-x");
});

test("the five regions of the primer's padding table, and the next header at 140", () => {
  const md = primer();
  const e = unpack(presetBytes("tiny")).entries[0];
  const R = regions(e);
  const name = R.find((x) => x.kind === "name");
  const pads = R.filter((x) => x.kind === "pad");
  const data = R.find((x) => x.kind === "data");
  const row = (a, b, what) => assert.match(md, new RegExp(`\\| ${a} to ${b} \\|[^\\n]*\\| ${what}`), `primer row ${a} to ${b}`);
  assert.deepEqual([name.from, name.to - 1], [110, 114]); row(110, 114, "the name");
  assert.deepEqual([pads[0].from, pads[0].to - 1], [115, 115]); assert.match(md, /\| 115 \| `00` \| 1 byte of padding \|/);
  assert.deepEqual([data.from, data.to - 1], [116, 136]); row(116, 136, "the 21 data bytes");
  assert.deepEqual([pads[1].from, pads[1].to - 1], [137, 139]); row(137, 139, "3 bytes of padding");
  assert.equal(e.nextHeader, 140); assert.match(md, /\| 140 onward \|/);
  assert.equal(align4(115), 116); assert.equal(align4(137), 140); assert.equal(align4(116), 116);
  assert.equal(HEADER + nAlign(5), 116);
});

test("self-check: the trailer at 140 (c_namesize 0xb) ends at 264", () => {
  const md = primer();
  assert.match(md, /starts at offset 140\. Where does the next header start\?\nAt 264\./);
  const r = unpack(presetBytes("tiny"));
  const tr = r.entries[1];
  assert.equal(tr.kind, "trailer");
  assert.equal(tr.off, 140);
  assert.equal(tr.namesize, 0xb);
  assert.equal(tr.nextHeader, 264);
  assert.equal(tr.nameOff, 250);
});

test("both.cpio: bsdcpio's one line, the kernel's second init, two trailers", () => {
  const md = primer();
  const b = both();
  assert.equal(b.length, 1024);
  const host = hostView(b);
  const first = lsLine(host.items[0], { tzOffsetMin: -480, now: host.items[0].mtime });
  // The primer ran this on a Mac in UTC-8; with that offset the line is identical.
  assert.equal(host.items.length, 1);
  assert.ok(md.includes(first), `primer shows ${first}`);
  const tail = hostView(b.subarray(512));
  const second = lsLine(tail.items[0], { tzOffsetMin: -480, now: tail.items[0].mtime });
  assert.ok(blockAfter(md, "tail -c 512 both.cpio | cpio -itv").includes(second));
  const r = unpack(b);
  assert.equal(r.error, null);
  assert.equal(r.members.length, 2);
  assert.equal(r.members[1].start, 512);
  assert.equal(r.entries.filter((e) => e.kind === "trailer").length, 2);
  assert.match(blockAfter(md, "strings both.cpio | grep -c TRAILER"), /^2$/);
  const src = initSource(r);
  assert.equal(src.src.member, 1);
  assert.equal(src.size, 22);
  assert.equal(new TextDecoder().decode(src.data), "#!/bin/sh\necho second\n");
  assert.deepEqual(r.entries[0].overwrittenBy, { member: 1, index: 0 });
  assert.equal(r.entries[2].outcome.status, "replaced");
});

test("bad.cpio (byte 5 set to 8) predicts 'no cpio magic'; plain cpio -o predicts the -H newc hint", () => {
  const md = primer();
  const bad = presetBytes("bad");
  assert.equal(new TextDecoder().decode(bad.subarray(0, 6)), "070708");
  const r = unpack(bad);
  assert.equal(r.error.message, "no cpio magic");
  assert.ok(md.includes("`no cpio magic`"));
  assert.equal(bootLog(r).lines[1].text, "Initramfs unpacking failed: no cpio magic");
  const odc = presetBytes("odc");
  assert.equal(new TextDecoder().decode(odc.subarray(0, 6)), "070707");
  const o = unpack(odc);
  assert.equal(o.error.message, "incorrect cpio method used: use -H newc option");
  assert.ok(md.includes("`Initramfs unpacking failed: incorrect cpio method used: use -H newc option`"));
  assert.equal(bootLog(o).outcome, "panic");
  // The host tool reads odc happily: the two tools disagree here too.
  assert.equal(hostView(odc).items.length, 1);
});

test("self-check: an appended etc/motd member wins, Alpine's /init still runs", () => {
  const r = unpack(presetBytes("motd"));
  assert.equal(r.error, null);
  const rows = rootfsRows(r);
  const motd = rows.find((x) => x.path === "/etc/motd");
  assert.equal(motd.from.member, 1);
  assert.equal(initSource(r).src.member, 0);
  assert.equal(bootLog(r).outcome, "runs");
});

test("the overlay preset is initramfs-test.img in miniature; without padding it breaks", () => {
  const r = unpack(presetBytes("overlay"));
  assert.equal(r.error, null);
  assert.deepEqual(r.members.map((m) => m.kind), ["gzip", "newc"]);
  assert.equal(r.members[1].start % 4, 0);
  assert.equal(initSource(r).src.member, 1);
  assert.equal(bootLog(r).outcome, "runs");
  assert.equal(hostView(presetBytes("overlay")).items.length, MINI_ALPINE.length);
  const n = unpack(presetBytes("nopad"));
  assert.equal(n.members[0].end % 4, 3);
  assert.equal(n.error.message, "invalid magic at start of compressed archive");
  assert.equal(initSource(n).src.member, 0, "the kernel keeps what it unpacked before the error");
});

test("the boot log uses the captured lines verbatim", (t) => {
  if (!existsSync(BOOT) || !existsSync(PANIC)) { t.skip("captures missing"); return; }
  const boot = readFileSync(BOOT, "utf8");
  const panic = readFileSync(PANIC, "utf8");
  const ok = bootLog(unpack(presetBytes("overlay"))).lines;
  for (const l of ok.filter((x) => x.source === "captures/14-boot.txt")) {
    if (l.text.startsWith("Freeing")) continue; // its size depends on the file; checked below
    assert.ok(boot.includes(`] ${l.text}`), `14-boot.txt has ${l.text}`);
  }
  const none = bootLog(unpack(presetBytes("noinit"))).lines;
  for (const l of none.filter((x) => x.source === "captures/13-bad-magic-raw.txt")) assert.ok(panic.includes(`] ${l.text}\\x0d`), `13-bad-magic-raw.txt has ${l.text}`);
});

test("the chapter and the primer embed this lab", () => {
  assert.match(primer(), /^labs: \[cpio-inspector\]$/m);
  assert.match(primer(), /^:::lab cpio-inspector$/m);
  const ch = readFileSync(CHAPTER, "utf8");
  assert.match(ch, /^labs: \[.*cpio-inspector.*\]$/m);
  assert.match(ch, /^:::lab cpio-inspector$/m);
});

test("LABS.md lists the lab with its reference share state", () => {
  const md = readFileSync(LABS_MD, "utf8");
  const row = md.split("\n").find((l) => l.startsWith("| `cpio-inspector`"));
  assert.ok(row, "LABS.md has a cpio-inspector row");
  assert.ok(row.includes(`\`${REFERENCE}\``));
});

// ---------------------------------------------------------------------------------------------
// 2. The real tools

function haveCpio() {
  try { execFileSync(CPIO, ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("presets match archives bsdcpio builds from the primer's commands", (t) => {
  if (!haveCpio()) { t.skip(`${CPIO} not available`); return; }
  const dir = mkdtempSync(join(tmpdir(), "cpio-lab-"));
  try {
    mkdirSync(join(dir, "tree"));
    const build = (text, args) => {
      writeFileSync(join(dir, "tree", "init"), text);
      chmodSync(join(dir, "tree", "init"), 0o755);
      return new Uint8Array(execFileSync(CPIO, ["-o", ...args], { cwd: join(dir, "tree"), input: "init\n", stdio: ["pipe", "pipe", "ignore"] }));
    };
    // Inode, time and disk differ per machine: put the primer's values in, then compare.
    const normalise = (b) => {
      const out = b.slice();
      const put = (field, v) => out.set(new TextEncoder().encode(v), 6 + field * 8);
      put(0, "0162738e"); put(5, "6afeb8f4"); put(7, "00000001"); put(8, "00000010");
      return out;
    };
    const tiny = build("#!/bin/sh\necho hello\n", ["-H", "newc", "-R", "0:0"]);
    const second = build("#!/bin/sh\necho second\n", ["-H", "newc", "-R", "0:0"]);
    assert.deepEqual(normalise(tiny), presetBytes("tiny"));
    assert.deepEqual(concat(normalise(tiny), normalise(second)), both());
    const odc = build("#!/bin/sh\necho hello\n", []);
    assert.equal(new TextDecoder().decode(odc.subarray(0, 6)), "070707");
    assert.equal(unpack(odc).error.message, "incorrect cpio method used: use -H newc option");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hostView lists what cpio -itv lists, line for line", (t) => {
  if (!haveCpio()) { t.skip(`${CPIO} not available`); return; }
  for (const key of ["both", "tiny", "odc", "stock", "overlay", "motd", "noinit"]) {
    const b = presetBytes(key);
    const out = execFileSync(CPIO, ["-itv"], { input: Buffer.from(b), stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, TZ: "UTC" } }).toString();
    const want = out.split("\n").filter(Boolean);
    const h = hostView(b);
    const got = h.items.map((x) => lsLine(x, { tzOffsetMin: 0, now: Math.floor(Date.now() / 1000) }));
    assert.deepEqual(got, want, key);
  }
});

test("the gzip preset inflates to the miniature archive, and zlib agrees", () => {
  const gz = presetBytes("stock");
  const want = buildNewc(MINI_ALPINE);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(gz)), want);
  const g = gunzip(gz, 0, gz.length);
  assert.equal(g.error, undefined);
  assert.deepEqual(g.out, want);
  assert.equal(g.consumed, gz.length);
  assert.equal(g.crcOk, true);
});

// ---------------------------------------------------------------------------------------------
// 3. The real initramfs

test("initramfs-test.img: the primer's measurements and the boot capture", (t) => {
  if (!existsSync(REAL) || !existsSync(BASE)) { t.skip("run scripts/fetch.sh linux first (.cache/macvmm/initramfs-test.img)"); return; }
  const md = primer();
  const b = new Uint8Array(readFileSync(REAL));
  const base = readFileSync(BASE);
  const r = unpack(b);
  assert.equal(r.error, null);
  assert.deepEqual(r.members.map((m) => m.kind), ["gzip", "newc"]);
  const m0 = r.members[0];
  assert.equal(m0.end, base.length);
  const measured = blockAfter(md, 'f=.cache/macvmm/initramfs-virt').split("\n").map((s) => s.trim());
  assert.equal(String(m0.end), measured[0]);
  assert.equal(String(m0.data.length), measured[1]);
  assert.equal(String(m0.entries.filter((e) => e.kind !== "trailer").length), measured[2]);
  assert.equal(hostView(b).items.length, Number(measured[2]));
  const alpineInit = m0.entries.find((e) => e.name === "init");
  assert.ok(measured[3].includes(` ${alpineInit.filesize} `));
  assert.ok(alpineInit.overwrittenBy);
  assert.equal(m0.gzip.crcOk, true);
  const src = initSource(r);
  assert.equal(src.src.member, 1);
  assert.match(new TextDecoder().decode(src.data.subarray(0, 64)), /^#!\/bin\/sh\n/);
  const log = bootLog(r);
  assert.equal(log.outcome, "runs");
  const freeing = log.lines.find((l) => l.text.startsWith("Freeing initrd memory:"));
  if (existsSync(BOOT)) assert.ok(readFileSync(BOOT, "utf8").includes(`] ${freeing.text}`), freeing.text);
  assert.match(md, /9,404,792-byte Alpine initramfs is 2296\.09 pages and prints `9184K`/);
  assert.equal(Math.floor(base.length / 4096) * 4, 9184);
});

// ---------------------------------------------------------------------------------------------
// 4. Kernel behaviour, error by error

const reg = (name, data, extra = {}) => newcEntry({ name, mode: 0o100644, data, ...extra });
const tr = () => newcEntry({ name: "TRAILER!!!", nlink: 1 });
const gz = (b) => new Uint8Array(zlib.gzipSync(Buffer.from(b)));

test("broken padding: a non-zero byte off a 4-byte boundary after an entry", () => {
  const b = concat(reg("a", "x"), new Uint8Array([0]), new TextEncoder().encode("0707"));
  assert.equal(unpack(b).error.message, "broken padding");
});

test("zero bytes between members are skipped; a header must start on a multiple of 4", () => {
  const ok = concat(reg("a", "x"), tr(), new Uint8Array(8), reg("b", "y"), tr());
  const r = unpack(ok);
  assert.equal(r.error, null);
  assert.equal(r.members.length, 2);
  assert.ok(r.items.some((x) => x.type === "zeros" && x.end - x.start === 8));
  // After a trailer the kernel eats zeros; a header at an odd offset is "broken padding".
  const odd = concat(reg("a", "x"), tr(), new Uint8Array(3), reg("b", "y"));
  assert.equal(unpack(odd).error.message, "broken padding");
  // At the very start, a misaligned '0' goes to the decompressor test instead.
  const start = concat(new Uint8Array(1), reg("a", "x"));
  assert.equal(unpack(start).error.message, "invalid magic at start of compressed archive");
});

test("inside a compressed member: junk within, junk at the end, and a bad first header", () => {
  const within = gz(concat(reg("a", "x"), new TextEncoder().encode("XXXX")));
  assert.equal(unpack(within).error.message, "junk within compressed archive");
  const cut = reg("a", "hello");
  const atEnd = gz(cut.subarray(0, cut.length - 2));
  assert.equal(unpack(atEnd).error.message, "junk at the end of compressed archive");
  // A compressed first member is read straight into a header: garbage there is "no cpio magic".
  assert.equal(unpack(gz(new TextEncoder().encode("not cpio ".repeat(20)))).error.message, "no cpio magic");
  // Shorter than one header: the kernel waits for the rest, then finds the stream over.
  assert.equal(unpack(gz(new TextEncoder().encode("not cpio"))).error.message, "junk at the end of compressed archive");
  // A compressed second member starts in the Reset state: garbage there is "junk within".
  const second = concat(reg("a", "x"), tr(), gz(new TextEncoder().encode("hello")));
  assert.equal(unpack(second).error.message, "junk within compressed archive");
});

test("gzip failures: corrupt data, a cut-short stream, and a two-byte magic only", () => {
  const good = gz(concat(reg("a", "x".repeat(1000)), tr()));
  const corrupt = good.slice(); corrupt[12] ^= 0xff; corrupt[13] ^= 0xff;
  const c = unpack(corrupt);
  assert.ok(["uncompression error", "no cpio magic", "junk within compressed archive", "junk at the end of compressed archive"].includes(c.error.message), c.error.message);
  const short = good.subarray(0, 20);
  assert.equal(unpack(short).error.message, "read error");
  assert.equal(unpack(new Uint8Array([0x1f, 0x8b, 0x08])).error.message, "Not a gzip file");
  assert.equal(unpack(new Uint8Array([0x1f])).error.message, "invalid magic at start of compressed archive");
});

test("other compressors: the lab stops honestly instead of guessing", () => {
  const xz = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  const r = unpack(concat(reg("a", "x"), tr(), xz));
  assert.equal(r.error, null);
  assert.match(r.labStop, /xz-compressed/);
  assert.equal(bootLog(r).outcome, "unknown");
});

test("malformed archive: a name without its NUL", () => {
  const e = reg("init", "x");
  e[HEADER + 4] = 0x41; // overwrite the NUL
  const r = unpack(concat(e, tr()));
  assert.equal(r.error.message, "malformed archive");
  assert.equal(r.entries[0].kernelPrints, "initramfs name without nulterm: initA");
});

test("070702: the data checksum is checked; the bad file is still created", () => {
  const data = "abc";
  const sum = [...data].reduce((a, c) => a + c.charCodeAt(0), 0);
  const good = newcEntry({ magic: "070702", name: "f", mode: 0o100644, data, check: sum });
  assert.equal(unpack(concat(good, tr())).error, null);
  const bad = newcEntry({ magic: "070702", name: "f", mode: 0o100644, data, check: sum + 1 });
  const r = unpack(concat(bad, reg("g", "y"), tr()));
  assert.equal(r.error.message, "bad data checksum");
  assert.ok(rootfsRows(r).some((x) => x.path === "/f"));
  assert.ok(!rootfsRows(r).some((x) => x.path === "/g"), "the kernel stops after that entry");
});

test("a raw archive cut short gives no error message, only a partial file", () => {
  const e = reg("big", "x".repeat(100));
  const r = unpack(e.subarray(0, HEADER + 8 + 10));
  assert.equal(r.error, null);
  assert.equal(r.entries[0].outcome.status, "partial");
  const row = rootfsRows(r).find((x) => x.path === "/big");
  assert.equal(row.size, 100);
});

test("entries the kernel skips: bad name sizes, missing parents, data on a directory", () => {
  const zero = newcEntry({ name: "x", mode: 0o100644, data: "1" });
  zero.set(new TextEncoder().encode("00000000"), 6 + 11 * 8); // c_namesize = 0
  const r0 = unpack(concat(zero.subarray(0, HEADER), reg("ok", "1"), tr()));
  assert.equal(r0.entries[0].outcome.status, "ignored");
  const orphan = unpack(concat(reg("no/such/file", "1"), tr()));
  assert.equal(orphan.entries[0].outcome.status, "ignored");
  assert.match(orphan.entries[0].outcome.text, /does not exist/);
  const dirData = unpack(concat(newcEntry({ name: "d", mode: 0o040755, data: "zz" }), tr()));
  assert.equal(dirData.entries[0].outcome.status, "ignored");
  assert.equal(dirData.entries[0].name, null, "the kernel never reads its name");
});

test("clean_path: a later entry of another type replaces an earlier one; a full directory stays", () => {
  const r = unpack(concat(
    newcEntry({ name: "x", mode: 0o040755 }), newcEntry({ name: "x", mode: 0o120777, data: "y" }), tr(),
    newcEntry({ name: "d", mode: 0o040755 }), reg("d/f", "1"), reg("d", "file now"), tr(),
  ));
  assert.equal(rootfsRows(r).find((x) => x.path === "/x").type, "symlink");
  assert.equal(r.entries[1].outcome.status, "replaced");
  assert.equal(rootfsRows(r).find((x) => x.path === "/d").type, "dir");
  assert.equal(r.entries[5].outcome.status, "ignored");
});

test("hard links: the second name shares the first one's data, within one archive only", () => {
  const a = newcEntry({ name: "a", mode: 0o100644, nlink: 2, ino: 7 });
  const b = newcEntry({ name: "b", mode: 0o100644, nlink: 2, ino: 7, data: "shared" });
  const r = unpack(concat(a, b, tr()));
  assert.equal(r.entries[1].outcome.status, "linked");
  assert.equal(r.rootfs.nodes.get("/a"), r.rootfs.nodes.get("/b"));
  assert.equal(new TextDecoder().decode(r.rootfs.nodes.get("/a").inode.data), "shared");
  // A trailer in between frees the link table, so the second is a separate file.
  const r2 = unpack(concat(a, tr(), b, tr()));
  assert.notEqual(r2.rootfs.nodes.get("/a"), r2.rootfs.nodes.get("/b"));
});

test("symlinks are followed on the way to a name, with a hop limit", () => {
  const r = unpack(concat(
    newcEntry({ name: "real", mode: 0o040755 }), newcEntry({ name: "link", mode: 0o120777, data: "real" }),
    reg("link/f", "via the link"), newcEntry({ name: "l1", mode: 0o120777, data: "l2" }),
    newcEntry({ name: "l2", mode: 0o120777, data: "l1" }), reg("l1/x", "loop"), tr(),
  ));
  assert.ok(rootfsRows(r).some((x) => x.path === "/real/f"));
  assert.match(r.entries[5].outcome.text, /Too many symlinks/);
});

test("/init outcomes: script with interpreter, missing interpreter, not executable, ELF, symlink", () => {
  const sh = newcEntry({ name: "bin", mode: 0o040755 });
  const elf = newcEntry({ name: "bin/sh", mode: 0o100755, data: "\x7fELF..." });
  const init = (mode, data) => newcEntry({ name: "init", mode, data });
  assert.equal(bootLog(unpack(concat(sh, elf, init(0o100755, "#!/bin/sh\n"), tr()))).outcome, "runs");
  const noexec = bootLog(unpack(concat(init(0o100644, "#!/bin/sh\n"), tr())));
  assert.equal(noexec.lines.find((l) => l.text.startsWith("check access")).text, "check access for rdinit=/init failed: -13, ignoring");
  const plain = bootLog(unpack(concat(init(0o100755, "echo hi\n"), tr())));
  assert.ok(plain.lines.some((l) => l.text === "Failed to execute /init (error -8)"));
  const viaLink = unpack(concat(sh, elf, newcEntry({ name: "init", mode: 0o120777, data: "bin/sh" }), tr()));
  assert.equal(bootLog(viaLink).outcome, "runs");
  assert.equal(initSource(viaLink).viaSymlink, true);
  // /init fails but /bin/sh exists: the kernel falls back to it.
  const fb = bootLog(unpack(concat(sh, elf, init(0o100755, "#!/no/such\n"), tr())));
  assert.equal(fb.outcome, "fallback");
  assert.ok(fb.lines.some((l) => l.text === "Run /bin/sh as init process"));
});

test("the Freeing line counts whole pages only, and is absent below one page", () => {
  assert.ok(!bootLog(unpack(both())).lines.some((l) => l.text.startsWith("Freeing")));
  const big = concat(reg("f", "x".repeat(9000)), tr());
  const pages = Math.floor(big.length / 4096);
  assert.ok(bootLog(unpack(big)).lines.some((l) => l.text === `Freeing initrd memory: ${pages * 4}K`));
});

test("simple_strntoul: a 0x prefix is accepted, a non-hex character ends the number", () => {
  const f = (s) => parseField(new TextEncoder().encode(s), 0);
  assert.deepEqual([f("000081ed").value, f("000081ed").clean], [0x81ed, true]);
  assert.equal(f("0x0081ed").value, 0x81ed);
  assert.deepEqual([f("12zz5678").value, f("12zz5678").clean], [0x12, false]);
});

test("sniff points other formats at the sibling labs", () => {
  assert.equal(sniff(new TextEncoder().encode("\x7fELF")).lab, "elf-inspector");
  const img = new Uint8Array(64); img.set(new TextEncoder().encode("ARM\x64"), 0x38);
  assert.equal(sniff(img).lab, "image-inspector");
  const zb = new TextEncoder().encode("MZ\0\0zimg");
  assert.equal(sniff(zb).lab, "image-inspector");
  assert.equal(sniff(both()).kind, "newc");
  assert.equal(sniff(presetBytes("stock")).kind, "gzip");
});

// ---------------------------------------------------------------------------------------------
// Hostile input

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

test("inflate agrees with zlib on many inputs and levels", () => {
  const r = rng(1);
  for (let n = 0; n < 60; n++) {
    const len = Math.floor(r() * 5000);
    const src = new Uint8Array(len);
    const alphabet = 1 + Math.floor(r() * 255);
    for (let i = 0; i < len; i++) src[i] = Math.floor(r() * alphabet);
    const level = n % 10;
    const z = new Uint8Array(zlib.deflateRawSync(Buffer.from(src), { level, strategy: n % 3 === 0 ? zlib.constants.Z_HUFFMAN_ONLY : zlib.constants.Z_DEFAULT_STRATEGY }));
    const out = inflateRaw(concat(z, new Uint8Array([1, 2, 3])));
    assert.equal(out.end, true);
    assert.equal(out.consumed, z.length, "consumed counts exactly the stream");
    assert.deepEqual(out.out, src);
  }
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("inflate on garbage never throws and respects its output cap", () => {
  const r = rng(2);
  for (let n = 0; n < 300; n++) {
    const b = new Uint8Array(Math.floor(r() * 300));
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(r() * 256);
    const out = inflateRaw(b, 0, { maxOut: 4096 });
    assert.ok(out.out.length <= 4096);
  }
  const bomb = new Uint8Array(zlib.deflateRawSync(Buffer.alloc(1 << 20)));
  const capped = inflateRaw(bomb, 0, { maxOut: 65536 });
  assert.equal(capped.capped, true);
  assert.ok(capped.out.length <= 65536);
});

test("mutated archives never throw and always finish", () => {
  const r = rng(3);
  const seeds = PRESETS.map((p) => p.build());
  for (let n = 0; n < 600; n++) {
    const b = seeds[n % seeds.length].slice();
    const flips = 1 + Math.floor(r() * 6);
    for (let k = 0; k < flips; k++) b[Math.floor(r() * b.length)] = Math.floor(r() * 256);
    const cut = r() < 0.3 ? b.subarray(0, Math.floor(r() * b.length)) : b;
    const res = unpack(cut, { maxOut: 1 << 20 });
    bootLog(res); hostView(cut); summary(res, hostView(cut)); rootfsRows(res);
    for (const e of res.entries) hexRows(cut, e.off, e.off + 64, regions(e));
  }
});

// ---------------------------------------------------------------------------------------------
// Share state and small parsers

test("share state: the reference, the default, patches, and rejects", () => {
  assert.deepEqual(decodeShare(REFERENCE), { preset: "both", patches: [], select: { member: 1, index: 0 } });
  assert.equal(encodeShare({ preset: "both", patches: [], select: { member: 0, index: 0 } }), null);
  assert.equal(encodeShare({ preset: "both", patches: [], select: { member: 1, index: 0 } }), REFERENCE);
  const s = decodeShare("both~5=38@1.1");
  assert.deepEqual(applyPatches(both(), s.patches).bytes, presetBytes("bad"));
  assert.equal(encodeShare(s), "both~5=38@1.1");
  for (const bad of ["", "nope", "both@0.1", "both~zz=1", "both~5=388", `both${"~1=00".repeat(MAX_PATCHES + 1)}`, "x".repeat(500), 42, null]) {
    assert.equal(decodeShare(bad), null, String(bad).slice(0, 20));
  }
  assert.deepEqual(applyPatches(both(), [{ off: 5000, byte: 1 }]).applied, []);
});

test("number and byte boxes", () => {
  assert.equal(parseNumber("0x5"), 5);
  assert.equal(parseNumber("140"), 140);
  assert.equal(parseNumber("1_0"), 10);
  assert.equal(parseNumber("zz"), null);
  assert.equal(parseNumber("0x100000000"), null);
  assert.equal(parseByte("0x38"), 0x38);
  assert.equal(parseByte("'8'"), 0x38);
  assert.equal(parseByte("56"), 56);
  assert.equal(parseByte("256"), null);
});

test("preview text escapes control bytes and caps its length", () => {
  const p = previewText(new Uint8Array([0x41, 0x0a, 0x1b, 0x00]), 3);
  assert.equal(p.text, "A\n\\x1b");
  assert.equal(p.more, 1);
});

test("every preset parses, and the summary names where /init comes from", () => {
  for (const p of PRESETS) {
    const b = p.build();
    const res = unpack(b);
    assert.ok(summary(res, hostView(b)).length > 20, p.key);
  }
  assert.match(summary(unpack(both()), hostView(both())), /\/init comes from member 2, entry 1\. A host cpio tool lists 1 entry\./);
  assert.ok(tinyCpio().length === 512);
});

// ---------------------------------------------------------------------------------------------
// 5. Review fixes: kernel details the first version got wrong

test("a gzip member cut inside its trailer: the kernel reads past the buffer, so the lab cannot tell", () => {
  const g = gz(concat(reg("init", "#!/bin/sh\n", { mode: 0o100755 }), tr()));
  for (const cut of [1, 3, 8]) {
    const b = g.subarray(0, g.length - cut);
    const r = unpack(b);
    assert.equal(r.error, null, "no decompressor error: the kernel never reads the trailer");
    assert.equal(r.pastEnd, 0);
    const log = bootLog(r);
    assert.equal(log.outcome, "unknown");
    assert.equal(log.why, "pastEnd");
    assert.match(summary(r, hostView(b)), /reads past the end of the buffer/);
  }
  // A byte lost inside the deflate data is a decompressor error instead.
  const inside = unpack(g.subarray(0, 20));
  assert.equal(inside.error.message, "read error");
});

test("the primer's off-by-one self-check says what the lab shows", () => {
  const md = primer();
  const i = md.indexOf(":::predict A VMM writes linux,initrd-end");
  const ans = md.slice(i, md.indexOf(":::\n", i + 10));
  assert.match(ans, /no decompressor error/);
  assert.match(ans, /past the end/);
  assert.match(ans, /`read error`/);
});

test("#! without a trailing newline runs (the kernel's buffer is zero-filled); a 256-byte name does not", () => {
  const sh = newcEntry({ name: "bin", mode: 0o040755 });
  const elf = newcEntry({ name: "bin/sh", mode: 0o100755, data: "\x7fELF..." });
  const init = (data) => newcEntry({ name: "init", mode: 0o100755, data });
  assert.equal(bootLog(unpack(concat(sh, elf, init("#!/bin/sh"), tr()))).outcome, "runs");
  assert.equal(bootLog(unpack(concat(sh, elf, init("#! /bin/sh -e"), tr()))).outcome, "runs");
  assert.deepEqual(scriptInterp(new TextEncoder().encode("#!/bin/sh")), { err: 0, interp: "/bin/sh" });
  assert.equal(scriptInterp(new TextEncoder().encode("#!" + "a".repeat(300))).err, -8);
  assert.equal(scriptInterp(new TextEncoder().encode("#!" + "a".repeat(252) + " x")).err, 0, "the name ends at byte 254, inside the 255-byte window");
  assert.equal(scriptInterp(new TextEncoder().encode("#!" + "a".repeat(253) + " x")).err, -8, "the space is at byte 255, outside the window");
  assert.equal(scriptInterp(new TextEncoder().encode("#!   \n")).err, -8);
});

test("rewriting a hard-linked file keeps the inode: both names see the new data (O_TRUNC)", () => {
  const one = new TextEncoder().encode("one");
  const r = unpack(concat(
    newcEntry({ name: "a", mode: 0o100644, ino: 7, nlink: 2 }),
    newcEntry({ name: "b", mode: 0o100644, ino: 7, nlink: 2, data: one }), tr(),
    reg("a", "two"), tr(),
  ));
  const text = (p) => new TextDecoder().decode(r.rootfs.nodes.get(p).inode.data);
  assert.equal(text("/a"), "two");
  assert.equal(text("/b"), "two");
  assert.equal(r.entries[3].outcome.status, "replaced");
  assert.match(r.entries[3].outcome.text, /^Replaces \/a from member 1, entry 1\./);
});

test("the panic path matches the capture line for line", (t) => {
  if (!existsSync(PANIC)) { t.skip("capture missing"); return; }
  const cap = readFileSync(PANIC, "utf8").split("\n").map((l) => l.replace(/^\[[ 0-9.]+\] /, "").replace(/\\x0d$/, ""));
  const lines = bootLog(unpack(presetBytes("noinit"))).lines.filter((l) => l.source === "captures/13-bad-magic-raw.txt").map((l) => l.text);
  const at = cap.indexOf(lines[0]);
  assert.ok(at >= 0);
  assert.deepEqual(cap.slice(at, at + lines.length), lines);
});

test("c_mode keeps 16 bits, as the kernel's umode_t", () => {
  const b = (newcEntry({ name: "f", mode: 0o100755, data: "x" }));
  b.set(new TextEncoder().encode("000381ed"), 14);
  const e = unpack(concat(b, tr())).entries[0];
  assert.equal(e.mode, 0o100755);
  assert.equal(e.kind, "file");
  assert.match(e.notes[0], /low 16 bits/);
});

test("gzip MTIME at or above 2^31 reads as unsigned", () => {
  const g = gz(concat(reg("a", "x"), tr()));
  g.set([0, 0, 0, 0x90], 4);
  assert.equal(gunzip(g, 0, g.length).mtime, 0x90000000);
});

test("host view: damaged headers stop bsdcpio; hard links say 'link to'; gzip FEXTRA is skipped", (t) => {
  const two = concat(reg("p", "x"), reg("q", "yy"), tr());
  const zx = two.slice(); zx.set(new TextEncoder().encode("0x"), 6 + 8);
  const h1 = hostView(zx);
  assert.equal(h1.items.length, 0);
  assert.equal(h1.says, "cpio: (null)");
  assert.equal(unpack(zx).entries[0].name, "p", "the kernel's lenient parser reads the same header");
  const dbl = concat(two, two); dbl[116] = 0x5a;
  const h2 = hostView(dbl);
  assert.equal(h2.items.length, 1);
  assert.match(h2.says, /^cpio: Skipped \d+ bytes before finding valid header$/);
  const hl = concat(newcEntry({ name: "a", mode: 0o100644, ino: 9, nlink: 2 }), newcEntry({ name: "b", mode: 0o100644, ino: 9, nlink: 2, data: "one\n" }), tr());
  const items = hostView(hl).items;
  assert.equal(items[1].linkTo, "a");
  assert.match(lsLine(items[1]), / b link to a$/);
  // FEXTRA: the host skips it, the kernel does not (and fails).
  const plain = gz(two);
  const extra = concat(plain.subarray(0, 10), new Uint8Array([4, 0, 1, 2, 3, 4]), plain.subarray(10));
  extra[3] |= 0x04;
  assert.equal(hostView(extra).items.length, 2);
  assert.ok(unpack(extra).error, "the kernel reads the extra field as deflate data");
  if (!haveCpio()) { t.skip("no /usr/bin/cpio"); return; }
  const dir = mkdtempSync(join(tmpdir(), "ci-host-"));
  try {
    for (const [name, b, expect] of [["zx", zx, h1], ["dbl", dbl, h2]]) {
      writeFileSync(join(dir, name), b);
      let err = "";
      try { execFileSync(CPIO, ["-it"], { input: b, stdio: ["pipe", "pipe", "pipe"] }); } catch (x) { err = String(x.stderr); }
      assert.equal(err.trim(), expect.says, name);
    }
    let out = "";
    out = execFileSync(CPIO, ["-itv"], { input: hl, stdio: ["pipe", "pipe", "ignore"] }).toString();
    assert.match(out, / b link to a\n$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------------------------
// Review fixes: host-tool details checked against /usr/bin/cpio, kernel edge cases

const cpioRun = (b) => {
  try {
    const out = execFileSync(CPIO, ["-itv"], { input: Buffer.from(b), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TZ: "UTC" } }).toString();
    return { out, err: "" };
  } catch (x) { return { out: String(x.stdout), err: String(x.stderr).trim() }; }
};
const hostLines = (b) => { const h = hostView(b); return { lines: h.items.map((x) => lsLine(x, { tzOffsetMin: 0, now: Math.floor(Date.now() / 1000) })), says: h.says || "" }; };

test("host view matches bsdcpio: devices, hard-link countdown, linked dirs, gzip members, truncation", (t) => {
  const e = (o) => newcEntry(o);
  const cases = {
    devices: concat(e({ name: "dev/console", mode: 0o020600, rmaj: 5, rmin: 1 }), e({ name: "dev/sda", mode: 0o060660, rmaj: 8, rmin: 0 }), tr()),
    countdown: concat(e({ name: "a", mode: 0o100644, ino: 9, nlink: 2 }), e({ name: "b", mode: 0o100644, ino: 9, nlink: 2 }), e({ name: "c", mode: 0o100644, ino: 9, nlink: 2 }), tr()),
    dirs: concat(e({ name: "d1", mode: 0o040755, ino: 9, nlink: 2 }), e({ name: "d2", mode: 0o040755, ino: 9, nlink: 2 }), tr()),
    otherDisk: concat(e({ name: "a", mode: 0o100644, ino: 9, nlink: 2, maj: 1 }), e({ name: "b", mode: 0o100644, ino: 9, nlink: 2, maj: 2 }), tr()),
    gzipTwo: concat(gz(reg("x", "1")), gz(concat(reg("y", "2"), tr()))),
    gzipTrailerFirst: concat(gz(concat(reg("x", "1"), tr())), gz(concat(reg("y", "2"), tr()))),
    gzipPadded: concat(gz(reg("x", "1")), new Uint8Array(3), gz(concat(reg("y", "2"), tr()))),
    cutPad: reg("a", "123456789").subarray(0, 123),
    cutData: reg("a", "123456789").subarray(0, 115),
    noTrailer: reg("a", "1234"),
  };
  assert.deepEqual(hostLines(cases.devices).lines, [
    "crw-------   1 root     wheel         5,1 Jan  1  1970 dev/console",
    "brw-rw----   1 root     wheel         8,0 Jan  1  1970 dev/sda",
  ]);
  assert.deepEqual(hostLines(cases.countdown).lines.map((l) => l.slice(55)), ["a", "b link to a", "c"]);
  assert.match(hostLines(cases.dirs).lines[1], / d2 link to d1$/);
  assert.equal(hostView(cases.gzipTwo).items.length, 2);
  assert.equal(hostLines(cases.cutPad).says, "cpio: Truncated input file (needed 12 bytes, only 11 available): Unknown error: -1");
  assert.equal(hostLines(cases.noTrailer).says, "cpio: (null)");
  // The kernel creates the file from the cut archive and reports nothing.
  const k = unpack(cases.cutPad);
  assert.equal(k.error, null);
  assert.ok(rootfsRows(k).some((x) => x.path === "/a"));
  if (!haveCpio()) { t.skip(`${CPIO} not available`); return; }
  for (const [name, b] of Object.entries(cases)) {
    const real = cpioRun(b);
    const mine = hostLines(b);
    assert.deepEqual(mine.lines, real.out.split("\n").filter(Boolean), name);
    assert.equal(mine.says, real.err, name);
  }
});

test("an empty symlink target creates nothing (symlink() refuses it)", () => {
  const r = unpack(concat(reg("init", "x"), newcEntry({ name: "init", mode: 0o120777, data: "" }), newcEntry({ name: "l", mode: 0o120777, data: "" }), tr()));
  assert.equal(r.entries[1].outcome.status, "ignored");
  assert.match(r.entries[1].outcome.text, /^An empty link target: symlink\(\) refuses it, so nothing is created\. The earlier init/);
  assert.equal(r.entries[2].outcome.status, "ignored");
  const paths = rootfsRows(r).map((x) => x.path);
  assert.ok(!paths.includes("/l"));
  assert.ok(!paths.includes("/init"), "clean_path removed the file before symlink() failed");
});

test("exec_binprm: five nested #! scripts ending in ELF run, six do not", () => {
  const chain = (n) => {
    const parts = [newcEntry({ name: "s", mode: 0o040755 }), newcEntry({ name: "s/elf", mode: 0o100755, data: "\x7fELF" })];
    for (let k = 1; k <= n; k++) parts.push(newcEntry({ name: `s/${k}`, mode: 0o100755, data: `#!/s/${k === 1 ? "elf" : k - 1}\n` }));
    parts.push(newcEntry({ name: "init", mode: 0o120777, data: `s/${n}` }), tr());
    return bootLog(unpack(concat(...parts)));
  };
  assert.equal(chain(5).outcome, "runs");
  const six = chain(6);
  assert.notEqual(six.outcome, "runs");
  assert.ok(six.lines.some((l) => l.text === "Failed to execute /init (error -40)"));
});

test("load_script finds the newline with strnchr: a NUL before it means no newline", () => {
  assert.equal(scriptInterp(new TextEncoder().encode("#!/bin/sh\n")).interp, "/bin/sh");
  // NUL, then 300 non-space bytes, then a newline: the kernel sees no newline; the name still
  // ends at the NUL, so the interpreter is found.
  const d = new Uint8Array(320).fill(0x61);
  d.set(new TextEncoder().encode("#!/bin/sh"), 0); d[9] = 0; d[319] = 0x0a;
  assert.equal(scriptInterp(d).interp, "/bin/sh");
  // A 300-byte name with a NUL at 260 and a newline after it: too long (the newline is not seen).
  const long = new Uint8Array(300).fill(0x61);
  long.set([0x23, 0x21], 0); long[260] = 0; long[280] = 0x0a;
  assert.equal(scriptInterp(long).err, -8);
  // Without the NUL, indexOf would have found nothing either (newline past 256), so check the
  // case where the newline is inside 256 bytes but after a NUL: the no-newline path still finds a name.
  const nl = new TextEncoder().encode("#!/bin/sh\0 x\n");
  assert.equal(scriptInterp(nl).interp, "/bin/sh");
});

test("only a missing /init is tagged with the real capture; -13 follows from the source", () => {
  const none = bootLog(unpack(presetBytes("noinit"))).lines.find((l) => l.text.startsWith("check access"));
  assert.equal(none.source, "captures/13-bad-magic-raw.txt");
  const noexec = bootLog(unpack(concat(newcEntry({ name: "init", mode: 0o100644, data: "#!/bin/sh\n" }), tr()))).lines.find((l) => l.text.startsWith("check access"));
  assert.equal(noexec.text, "check access for rdinit=/init failed: -13, ignoring");
  assert.equal(noexec.source, "init/main.c");
});

test("member labels say newc only for a newc magic; summary counts trailers apart", () => {
  const odc = unpack(presetBytes("odc"));
  assert.equal(memberLabel(odc.members[0]), "uncompressed, magic 070707, which is odc, not newc");
  assert.equal(memberLabel(unpack(presetBytes("bad")).members[0]), "uncompressed, magic 070708, not newc");
  assert.equal(memberLabel(unpack(both()).members[0]), "raw newc");
  assert.match(summary(odc, hostView(presetBytes("odc"))), /^512 bytes, 1 member \(uncompressed, magic 070707, which is odc, not newc\), 0 entries\./);
  assert.match(summary(unpack(both())), /2 entries \(plus 2 TRAILER!!! markers\)/);
});

test("names with bidi overrides or invisible characters are shown escaped", () => {
  const name = "init\u202ehs.exe\u200b";
  const bytes = new TextEncoder().encode(name);
  assert.equal(displayText(bytes), "init\\u{202e}hs.exe\\u{200b}");
  const latin = String.fromCharCode(...bytes);
  assert.equal(displayName(latin), "init\\u{202e}hs.exe\\u{200b}");
  const r = unpack(concat(newcEntry({ name: latin, mode: 0o100644, data: "x" }), tr()));
  assert.equal(r.entries[0].nameDisplay, "init\\u{202e}hs.exe\\u{200b}");
});
