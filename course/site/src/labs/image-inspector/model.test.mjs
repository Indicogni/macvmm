// image-inspector model tests. No vector file exists for the loaders, so the model is checked
// against what the course actually observed and the Rust it mirrors:
//   - the presets' first 64 bytes against the captures 13-image-header.txt / 13-zboot-header.txt,
//     and every preset byte against the real files in .cache/macvmm when they are present;
//   - the messages against the captures 13-dry-run.txt, 13-image-size-max.txt, 13-bad-magic.txt,
//     13-zboot-refused.txt (exact lines);
//   - the Rust unit tests of loader/image.rs, loader/mod.rs, loader/initrd.rs and
//     xtask/tests/zboot.rs, re-expressed here;
//   - the message templates against the Rust source's string literals;
//   - the numbers chapter 13 and the arm64-boot-protocol and efi-zboot primers quote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as M from "./model.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../../..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const capture = (name) => read(`course/captures/${name}`);
const stdout = (name) => capture(name).split("--- stdout ---\n")[1].split("\n--- stderr ---")[0];
const stderr = (name) => capture(name).split("--- stderr ---\n")[1].trim();

const tryState = (id) => M.step(M.initialState(), { type: "try", id });
const run = (id) => M.analyze(tryState(id));

/** A synthetic Image like image.rs's test helper `header(text_offset, image_size, flags, len)`. */
function header(textOffset, imageSize, flags, len) {
  const b = new Uint8Array(len);
  const put = (off, v) => {
    for (let i = 0; i < 8; i++) b[off + i] = Number((BigInt(v) >> BigInt(8 * i)) & 0xffn);
  };
  put(8, textOffset);
  put(16, imageSize);
  put(24, flags);
  b.set([0x41, 0x52, 0x4d, 0x64], 56);
  return b;
}
const viewOf = (bytes, length = bytes.length) => M.makeView(BigInt(length), [{ off: 0, bytes }]);

/** A synthetic zboot file like xtask/tests/zboot.rs `zboot_file`, payload at 0x100. */
function zbootFile(payload, comp) {
  const b = new Uint8Array(0x100 + payload.length + 64);
  b.set([0x4d, 0x5a], 0);
  b.set([0x7a, 0x69, 0x6d, 0x67], 4);
  const le32 = (off, v) => {
    for (let i = 0; i < 4; i++) b[off + i] = (v >>> (8 * i)) & 0xff;
  };
  le32(8, 0x100);
  le32(12, payload.length);
  b.set(new TextEncoder().encode(comp), 24);
  b.set(payload, 0x100);
  b.fill(0xaa, 0x100 + payload.length);
  return { bytes: b, le32 };
}

test("preset headers are the captured bytes (13-image-header, 13-zboot-header)", () => {
  for (const [base, cap] of [
    ["image", "13-image-header.txt"],
    ["zboot", "13-zboot-header.txt"],
  ]) {
    const r = M.parseXxd(stdout(cap));
    assert.ok(!r.error, r.error);
    assert.equal(r.end, 64);
    const v = M.viewFor(M.step(M.initialState(), { type: "source", base }));
    const want = M.toHex(r.chunks.flatMap((c) => [...c.bytes]));
    const got = M.toHex(Array.from({ length: 64 }, (_, i) => v.byte(i)));
    assert.equal(got, want, `${base} preset vs ${cap}`);
  }
});

test("preset bytes and lengths match the real files when they are present", (t) => {
  for (const base of ["image", "zboot"]) {
    const b = M.BASES[base];
    const p = join(repo, b.file);
    if (!existsSync(p)) {
      t.skip(`${b.file} not present (run scripts/fetch.sh linux to check the presets against it)`);
      continue;
    }
    assert.equal(BigInt(statSync(p).size), b.length, `${b.file} length`);
    const fd = openSync(p, "r");
    try {
      for (const [off, hex] of b.chunks) {
        const buf = Buffer.alloc(hex.length / 2);
        readSync(fd, buf, 0, buf.length, off);
        assert.equal(buf.toString("hex"), hex, `${b.file} at ${M.hx(off)}`);
      }
    } finally {
      closeSync(fd);
    }
  }
});

test("Alpine with chapter 13's initrd reproduces the dry run's lines exactly (13-dry-run)", () => {
  const a = run("alpine");
  assert.equal(a.plan.stage, "ok");
  assert.equal(a.plan.exit, 0);
  const cap = stdout("13-dry-run.txt").split("\n");
  assert.equal(a.plan.lines.length, 6);
  for (const line of a.plan.lines) assert.ok(cap.includes(line), `not in 13-dry-run.txt: ${line}`);
  assert.equal(a.image.checks.length, 7);
  assert.ok(a.image.checks.every((c) => c.pass === true));
  assert.equal(M.encode(tryState("alpine")), null, "the default state clears the hash");
});

test("the Predict fork prints 13-image-size-max's message", () => {
  const a = run("huge");
  assert.equal(a.plan.message, stderr("13-image-size-max.txt"));
  assert.equal(a.plan.stage, "kernel");
  assert.equal(a.plan.kernel.step, "end");
  assert.equal(a.plan.kernel.wrapped, 0x401f_ffffn, "the wrap chapter 13 quotes");
  assert.ok(a.image.checks.every((c) => c.pass === true), "every header check passes");
  assert.equal(M.encode(tryState("huge")), "image.p10=ffffffffffffffff");
});

test("the bad-magic copy with --initrd prints 13-bad-magic's message", () => {
  const a = run("badmagic");
  assert.equal(a.plan.message, stderr("13-bad-magic.txt"));
  assert.equal(a.kind, "raw");
  assert.equal(a.image.first, 1, "as an Image, the magic check is the first to fail");
  const noRd = M.analyze(M.step(tryState("badmagic"), { type: "setInitrd", size: null }));
  assert.equal(noRd.plan.message, "macvmm: cannot load the guest: --kernel is not an ELF file; load a flat binary with --raw F@ADDR");
});

test("vmlinuz-virt prints 13-zboot-refused's message; with --initrd the initrd check comes first", () => {
  const a = run("zboot");
  assert.equal(a.plan.message, stderr("13-zboot-refused.txt"));
  assert.equal(a.kind, "zboot");
  const rd = M.analyze(M.step(tryState("zboot"), { type: "setInitrd", size: 9427196n }));
  assert.equal(rd.plan.message, "macvmm: cannot load the guest: --initrd needs an arm64 Image --kernel");
});

test("each doctored header fails at the check parse_header makes first", () => {
  const expect = {
    bigendian: ["endian", "arm64 Image is a big-endian kernel (flags bit 0)"],
    pages64k: ["page", "arm64 Image page-size field 3 (64 KiB pages) is not supported by Apple Silicon; use a 4K or 16K kernel"],
    zerosize: ["size", "arm64 Image has image_size 0 (a kernel older than 3.17), so its memory use is unknown"],
    unaligned: ["offset", "arm64 Image text_offset 0x80 is not 4 KiB-aligned"],
    longer: ["filelen", "arm64 Image file (0x22a0001 bytes) is longer than its image_size 0x22a0000"],
  };
  for (const [id, [check, msg]] of Object.entries(expect)) {
    const a = run(id);
    assert.equal(a.image.checks[a.image.first].id, check, id);
    assert.equal(a.plan.message, M.LOAD_PREFIX + msg, id);
    assert.equal(a.plan.exit, 2);
  }
  // 63 bytes still hold the magic (0x38..0x3b), so detect() says Image and parse_header itself
  // says too short.
  const short = run("short");
  assert.equal(short.kind, "image");
  assert.equal(short.image.first, 0);
  assert.equal(short.plan.message, M.LOAD_PREFIX + "arm64 Image is 63 bytes, shorter than its 64-byte header");
  // Below 60 bytes the magic is gone: detect() calls it raw before parse_header runs.
  const b = header(0, 0x1000, 0, 64);
  const a = M.planBoot(viewOf(b, 59), 512, null);
  assert.equal(a.kind, "raw");
  assert.equal(a.error, "--kernel is not an ELF file; load a flat binary with --raw F@ADDR");
});

test("order: big-endian is reported before a 64K page size, zero size before a bad text_offset", () => {
  const be64 = M.checkImage(viewOf(header(0, 0x1000, 0b111, 64)));
  assert.equal(be64.checks[be64.first].id, "endian");
  assert.equal(be64.checks[3].pass, false, "the page-size check would fail on its own too");
  const zo = M.checkImage(viewOf(header(0x80, 0, 0, 64)));
  assert.equal(zo.checks[zo.first].id, "size");
  // Reserved flag bits (4..63) are ignored, as image.rs documents.
  assert.equal(M.checkImage(viewOf(header(0, 0x1000, 0xfff0n | 0b1010n, 64))).error, null);
});

test("image.rs unit test: an Alpine-like header places at 2 MiB", () => {
  const b = header(0, 0x22a_0000, 0b1010, 4096);
  const p = M.planBoot(viewOf(b), 512, null);
  assert.equal(p.stage, "ok");
  assert.equal(p.image.header.pageSize, "K4");
  assert.equal(p.image.header.anywhere, true);
  assert.equal(p.kernel.load, 0x4020_0000n);
  assert.equal(p.kernel.end, 0x4020_0000n + 0x22a_0000n);
});

test("loader/mod.rs unit test: detect is total", () => {
  const v = (arr) => viewOf(Uint8Array.from(arr));
  assert.equal(M.detect(v([])), "raw");
  assert.equal(M.detect(v([0x7f, 0x45, 0x4c, 0x46, 0x02])), "elf");
  assert.equal(M.detect(v([0x4d, 0x5a, 0, 0, 0x7a, 0x69, 0x6d, 0x67])), "zboot");
  const img = new Uint8Array(64);
  img.set([0x41, 0x52, 0x4d, 0x64], 56);
  assert.equal(M.detect(viewOf(img)), "image");
  assert.equal(M.detect(viewOf(img.slice(0, 58))), "raw");
});

test("initrd.rs unit test: align_up and the 32 GiB window", () => {
  assert.equal(M.alignUp(0x424a_0000n, 2n << 20n), 0x4260_0000n);
  assert.equal(M.alignUp(0x4260_0000n, 2n << 20n), 0x4260_0000n);
  assert.equal(M.alignUp(M.U64_MAX, 2n << 20n), null);
  const ram = { base: M.RAM_BASE, size: BigInt(M.RAM_MAX_MIB) << 20n };
  // An initrd that pushes past the 1 GiB-aligned 32 GiB window.
  const r = M.placeInitrd(ram, 0x4020_0000n, 0x424a_0000n, 33n << 30n);
  assert.match(r.error, /^initrd 0x42600000\.\.0x[0-9a-f]+ and the kernel do not fit one 1 GiB-aligned 32 GiB window \(booting\.rst §4\); use less RAM or a smaller initrd$/);
  assert.equal(M.placeInitrd(ram, 0x4020_0000n, 0x424a_0000n, 30n << 30n).error, null);
});

test("the arm64-boot-protocol primer's predict: the initrd goes after image_size, not the file", () => {
  const b = header(0, 0x180_0000, 0b1010, 64);
  const p = M.planBoot(viewOf(b, 0x140_0000), 512, 4096n);
  assert.equal(p.stage, "ok");
  assert.equal(p.initrd.start, 0x41a0_0000n);
  const map = M.placementMap(p, 512, 0x140_0000n);
  const bss = map.segments.find((s) => s.id === "bss");
  assert.equal(bss.from, 0x4160_0000n, "the tempting wrong answer is where the BSS starts");
  assert.equal(bss.to, 0x41a0_0000n);
});

test("RAM size rules and messages follow layout.rs", () => {
  assert.equal(M.ramError(64), null);
  assert.equal(M.ramError(M.RAM_MAX_MIB), null);
  assert.equal(M.ramError(62), "RAM size 0x3e00000 is below the minimum 0x4000000 (64 MiB)");
  assert.equal(M.ramError(65), "RAM size 0x4100000 is not a multiple of 2 MiB");
  assert.equal(M.ramError(M.RAM_MAX_MIB + 2), "RAM size 0x3fc0200000 is above the maximum 0x3fc0000000 (255 GiB)");
  // 64 MiB is still enough for Alpine and chapter 13's initrd.
  const a = M.analyze({ ...tryState("alpine"), ramMiB: 64 });
  assert.equal(a.plan.stage, "ok");
  // 36 MiB of kernel plus 2 MiB of DTB slot does not fit in... nothing smaller is allowed, so
  // check the initrd running out instead: a 30 MiB initrd in 64 MiB.
  const b = M.analyze({ ...tryState("alpine"), ramMiB: 64, initrd: 30n << 20n });
  assert.equal(b.plan.message, "macvmm: cannot load the guest: initrd (0x1e00000 bytes at 0x42600000) does not fit inside guest RAM");
});

test("every message template's fixed text is in the Rust source", () => {
  const loader = read("crates/vmm/src/loader/mod.rs");
  const xtask = read("crates/xtask/src/zboot.rs");
  const layout = read("crates/vmm/src/arch/layout.rs");
  const inLoader = [
    "shorter than its 64-byte header",
    "arm64 Image magic ARM\\\\x64 missing at offset 56",
    "arm64 Image is a big-endian kernel (flags bit 0)",
    "(64 KiB pages) is not supported by Apple",
    "Silicon; use a 4K or 16K kernel",
    "arm64 Image has image_size 0 (a kernel older than 3.17), so its memory use is",
    "is not 4 KiB-aligned",
    "is longer than its image_size",
    "does not fit inside guest RAM",
    "and the kernel do not fit one 1 GiB-aligned 32 GiB",
    "window (booting.rst §4); use less RAM or a smaller initrd",
    "{what} needs an arm64 Image --kernel",
    "EFI zboot image; run scripts/fetch.sh linux (unwraps it) or pass the raw Image",
    "--kernel is not an ELF file; load a flat binary with --raw F@ADDR",
  ];
  for (const f of inLoader) assert.ok(loader.includes(f), `loader/mod.rs lacks: ${f}`);
  assert.ok(read("crates/vmm/src/error.rs").includes('"cannot load the guest: {err}"'), "the prefix after macvmm:");
  for (const f of [
    "not an EFI zboot image (no MZ / zimg magic)",
    "file too short for the zboot header",
    "lies outside the {file:#x}-byte file",
    "unsupported compression {c:?} (only gzip is supported)",
    "payload does not start with the gzip magic",
    "pub const MAX_OUTPUT: u64 = 256 << 20;",
    "pub const HEADER_LEN: usize = 56;",
  ]) {
    assert.ok(xtask.includes(f), `xtask/src/zboot.rs lacks: ${f}`);
  }
  for (const f of ["is below the minimum", "is above the maximum", "is not a multiple of 2 MiB", "pub const RAM_MIN: u64 = 64 << 20;", "pub const RAM_MAX_END: u64 = 0x40_0000_0000;"]) {
    assert.ok(layout.includes(f), `layout.rs lacks: ${f}`);
  }
  assert.ok(read("crates/vmm/src/loader/plan.rs").includes('format!("console=ttyAMA0 earlycon=pl011,{PL011_BASE:#010x}")'));
});

test("chapter 13's header table is what the model decodes for Alpine", () => {
  const md = read("course/chapters/VI/13-loaders.md");
  const row = (field) => md.split("\n").find((l) => l.startsWith("| `0x") && l.includes(field));
  const cell = (l) => l.split("|")[3].trim();
  const f = run("alpine").image.fields;
  assert.match(cell(row("text_offset")), /^`0`$/);
  assert.equal(f.textOffset, 0n);
  assert.equal(BigInt(cell(row("image_size")).replace(/[`_]/g, "")), f.imageSize);
  assert.match(cell(row("`flags`")), /^`0xa`/);
  assert.equal(f.flags, 0xan);
  assert.equal(cell(row("`res5`")), "`0x40`");
  assert.equal(f.res5, 0x40);
  assert.equal(cell(row("`code0`")), "`4d5a 40fa 27b4 5514`");
  assert.equal(f.code0, 0xfa405a4d);
  assert.equal(f.code1, 0x1455b427);
});

test("the efi-zboot primer's numbers: header, PE, gzip, file map", () => {
  const a = run("zboot");
  const z = a.zboot;
  assert.equal(z.fields.payloadOffset, 0xca78);
  assert.equal(z.fields.payloadSize, 0x9dfb4b);
  assert.equal(z.fields.payloadSize, 10353483);
  assert.equal(z.end, 0x9ec5c3n);
  assert.equal(z.fields.compression, "gzip");
  assert.equal(z.fields.linuxPeMagic, 0x818223cd);
  assert.equal(z.fields.eLfanew, 0x40);
  assert.equal(z.error, null);
  assert.equal(z.first, -1);
  assert.equal(z.undecided, -1);
  assert.equal(z.pe.machine, 0xaa64);
  assert.equal(z.pe.sections, 2);
  assert.equal(z.pe.optMagic, 0x20b);
  assert.equal(z.pe.entry, 0x1028);
  assert.equal(z.pe.subsystem, 10);
  assert.equal(z.pe.subsystemName, "EFI application");
  assert.deepEqual(
    z.pe.sectionTable.map((s) => [s.name, s.va, s.rawPtr, s.rawSize]),
    [
      [".text", 0x1000, 0x1000, 0x9ed000],
      [".data", 0x9ee000, 0x9ee000, 0x200],
    ],
  );
  assert.deepEqual(z.gzip.header, [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0x02, 0x03]);
  assert.equal(z.gzip.osName, "Unix");
  assert.equal(z.gzip.xflName, "maximum compression");
  assert.equal(z.gzip.isize, 36306944);
  // The primer's map: 0x0, 0x40, 0x1000, 0xca78, 0x9ec5c3, 0x9ee000, 0x9ee200.
  assert.deepEqual(
    a.zmap.map((m) => Number(m.from)).concat(Number(a.zmap.at(-1).to)),
    [0x0, 0x40, 0x1000, 0xca78, 0x9ec5c3, 0x9ee000, 0x9ee200],
  );
  assert.deepEqual(
    a.zmap.map((m) => m.id),
    ["hdr", "pehdr", "code", "payload", "stub", "data"],
  );
  // zboot.lds: all code (decompressor and EFI stub) comes before .gzdata; after it, .rodata.
  assert.equal(a.zmap[2].label, ".text: decompressor + EFI stub code");
  assert.equal(a.zmap[4].label, ".text: read-only data (the stub's strings and tables)");
  // The Image also carries a PE header (the EFI stub), at res5 = 0x40.
  const img = run("alpine").imagePe;
  assert.equal(img.signature, true);
  assert.equal(img.subsystem, 10);
});

test("the efi-zboot primer's predict: offset 0x1000 + size 0xffff_f800 wraps to 0x800 in 32 bits", () => {
  const a = run("zbootpast");
  const z = a.zboot;
  assert.equal(z.end, 0x1_0000_0800n);
  assert.equal(z.wrapped32, 0x800n);
  assert.equal(z.naive32Passes, true);
  assert.equal(z.error, "payload 0x1000+0xfffff800 lies outside the 0x9ee200-byte file");
  assert.equal(a.plan.message, stderr("13-zboot-refused.txt"), "the loader refuses it the same way");
  assert.equal(run("zbootzstd").zboot.error, 'unsupported compression "zstd" (only gzip is supported)');
});

test("xtask/tests/zboot.rs: truncated, past the end, 32-bit overflow, header offsets, zero size", () => {
  const payload = Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const good = zbootFile(payload, "gzip");
  const z = (bytes, len = bytes.length) => M.inspectZboot(viewOf(bytes, len));
  assert.equal(z(good.bytes).error, null);
  assert.equal(z(good.bytes, 40).error, "file too short for the zboot header");
  assert.match(z(good.bytes, 0x100 + payload.length - 1).error, /^payload 0x100\+0x14 lies outside the 0x113-byte file$/);
  const big = zbootFile(payload, "gzip");
  big.le32(8, 0xffffffff);
  big.le32(12, 0xffffffff);
  assert.match(z(big.bytes).error, /lies outside/);
  const inHdr = zbootFile(payload, "gzip");
  inHdr.le32(8, 8);
  assert.notEqual(z(inHdr.bytes).error, null);
  const zero = zbootFile(payload, "gzip");
  zero.le32(12, 0);
  assert.notEqual(z(zero.bytes).error, null);
  assert.equal(z(header(0, 64, 0, 64)).error, "not an EFI zboot image (no MZ / zimg magic)");
  const notGz = zbootFile(new Uint8Array(32), "gzip");
  assert.equal(z(notGz.bytes).error, "payload does not start with the gzip magic");
  // A compression name with no 0 byte in its 32 bytes.
  const unterminated = zbootFile(payload, "abcdefghijklmnopqrstuvwxyz012345");
  assert.equal(z(unterminated.bytes).error, 'unsupported compression "abcdefghijklmnopqrstuvwxyz012345" (only gzip is supported)');
  const ctrl = zbootFile(payload, "g\nz\u0001");
  assert.equal(z(ctrl.bytes).error, 'unsupported compression "g\\nz\\u{1}" (only gzip is supported)');
});

test("hostile PE fields are bounded: e_lfanew past the end, a huge section count", () => {
  const f = zbootFile(new Uint8Array(32), "gzip");
  f.le32(0x3c, 0xfffffff0);
  assert.match(M.inspectZboot(viewOf(f.bytes)).pe.error, /points past the end of the file/);
  const g = zbootFile(new Uint8Array(400), "gzip");
  g.le32(0x3c, 0x40);
  g.bytes.set([0x50, 0x45, 0, 0, 0x64, 0xaa, 0xff, 0xff], 0x40);
  const pe = M.inspectZboot(viewOf(g.bytes)).pe;
  assert.equal(pe.sections, 0xffff);
  assert.equal(pe.sectionsCapped, true);
  assert.ok(pe.sectionTable.length <= M.MAX_SECTIONS);
});

test("a dropped file needs only small windows: the PE header and the gzip ends", () => {
  const src = M.BASES.zboot;
  // The view reads the first 4 KiB; the preset knows only 0x180 of them, so pad with zeros (the
  // real bytes there are zboot code, which the readout never looks at).
  const head = new Uint8Array(M.READ_WINDOW);
  head.set(M.fromHex(src.chunks[0][1]));
  const v = M.makeView(src.length, [{ off: 0, bytes: head }]);
  assert.deepEqual(M.wantedRanges(v), [
    { off: 0xca78, len: 10 },
    { off: 0x9ec5bb, len: 8 },
  ]);
  // Once those are read, nothing more is wanted.
  const more = [{ off: 0, bytes: head }, ...M.BASES.zboot.chunks.slice(1).map(([off, hx]) => ({ off, bytes: M.fromHex(hx) }))];
  assert.deepEqual(M.wantedRanges(M.makeView(src.length, more)), []);
  // A hostile e_lfanew far into the file asks for one window of at most 4 KiB.
  const f = zbootFile(new Uint8Array(32), "gzip");
  f.le32(0x3c, 0x10_0000);
  const w = M.wantedRanges(M.makeView(0x20_0000n, [{ off: 0, bytes: f.bytes }]));
  assert.ok(w.length <= M.MAX_EXTRA_READS);
  for (const r of w) assert.ok(r.len <= M.READ_WINDOW);
  assert.deepEqual(w[0], { off: 0x10_0000, len: 24 + 240 + 40 * M.MAX_SECTIONS });
});

test("parseXxd: xxd and xxd -p, hardened against junk", () => {
  const r = M.parseXxd("$ xxd -l 8 f\n00000000: 4d5a 0000 7a69 6d67                      MZ..zimg\n");
  assert.deepEqual([...r.chunks[0].bytes], [0x4d, 0x5a, 0, 0, 0x7a, 0x69, 0x6d, 0x67]);
  const p = M.parseXxd("4d5a40fa\n27b45514\n");
  assert.equal(p.end, 8);
  assert.match(M.parseXxd("").error, /Paste/);
  assert.match(M.parseXxd("hello world").error, /No xxd rows/);
  assert.match(M.parseXxd("00000010: 4d5a\n00000000: 4d5a").error, /in order/);
  assert.match(M.parseXxd("00000000: 4d5").error ?? "no error", /No xxd rows|odd/);
  const many = Array.from({ length: 300 }, (_, i) => `${(i * 16).toString(16).padStart(8, "0")}: ${"0000 ".repeat(8).trim()}  ................`).join("\n");
  assert.match(M.parseXxd(many).error, /At most 4096 bytes/);
  assert.match(M.parseXxd("0".repeat(70 * 1024)).error, /more than 64 KiB/);
});

test("share state: every Try round-trips; the reference decodes; garbage is refused", () => {
  for (const t of M.TRIES) {
    const s = tryState(t.id);
    const enc = M.encode(s);
    const dec = enc === null ? M.initialState() : M.decode(enc);
    assert.ok(dec, `${t.id}: ${enc}`);
    assert.equal(M.encode(dec), enc, t.id);
    assert.equal(dec.tryId, t.id, `${t.id} is recognised from its hash`);
  }
  const ref = M.decode("image.p10=ffffffffffffffff");
  assert.equal(ref.tryId, "huge");
  assert.equal(M.analyze(ref).plan.message, stderr("13-image-size-max.txt"));
  const s = M.decode("zboot.m1024.i8fd8fc.l9ee201");
  assert.equal(s.ramMiB, 1024);
  assert.equal(s.initrd, 0x8fd8fcn);
  assert.equal(s.length, 0x9ee201n);
  for (const bad of ["", "image.", "elf", "image.p40=00", "image.p3f=0000", "image.m63", "image.x1", "<img src=x>", "image.pzz=00", "image." + "p0=00.".repeat(200)]) {
    assert.equal(M.decode(bad), null, bad);
  }
  // A dropped or pasted file never goes into the hash.
  assert.equal(M.encode({ ...M.initialState(), base: "file" }), null);
});

test("step: byte and field edits, normalised against the source", () => {
  let s = M.initialState();
  s = M.step(s, { type: "setByte", off: 0x38, value: 0x42 });
  assert.equal(M.encode(s), "image.p38=42");
  s = M.step(s, { type: "setByte", off: 0x38, value: 0x41 });
  assert.equal(M.encode(s), null, "putting the byte back removes the patch");
  s = M.step(s, { type: "setField", field: "image_size", value: M.U64_MAX });
  assert.equal(M.encode(s), "image.p10=ffffffffffffffff");
  assert.equal(M.step(s, { type: "setByte", off: 64, value: 0 }), s, "only the first 64 bytes");
  assert.equal(M.step(s, { type: "setByte", off: 0, value: 256 }), s);
  assert.equal(M.step(s, { type: "setRam", mib: 63 }), s);
  assert.equal(M.step(s, { type: "setInitrd", size: 0n }), s);
  const short = M.step(M.initialState(), { type: "setLength", value: 16n });
  assert.equal(M.step(short, { type: "setByte", off: 20, value: 1 }), short, "no patch past the end of the file");
  assert.equal(M.step(short, { type: "setLength", value: M.BASES.image.length }).length, null);
});

test("parseNumber accepts decimal and 0x hex up to 64 bits, nothing else", () => {
  assert.equal(M.parseNumber("36306944"), 36306944n);
  assert.equal(M.parseNumber("0x022a_0000"), 0x22a0000n);
  assert.equal(M.parseNumber("0xffffffffffffffff"), M.U64_MAX);
  for (const bad of ["", "0x", "0x1_0000_0000_0000_0000", "18446744073709551616", "1e3", "-1", "0b11", " 12 34 "]) {
    assert.equal(M.parseNumber(bad), null, bad);
  }
});

test("barLayout: widths sum to the bar, small pieces stay visible", () => {
  const segs = [
    { id: "dtb", from: 0n, to: 2n << 20n },
    { id: "free", from: 2n << 20n, to: 255n << 30n },
  ];
  const lay = M.barLayout(segs, 0n, 255n << 30n, 1000, 8);
  assert.equal(lay.reduce((n, s) => n + s.w, 0), 1000);
  assert.ok(lay[0].w >= 8);
  assert.equal(lay[1].x, lay[0].w);
});

test("summary lines name the outcome in plain words", () => {
  assert.match(M.summary(run("alpine")), /^arm64 Image: all 7 header checks pass\. Kernel at 0x40200000\.\.0x424a0000, initrd at 0x42600000\./);
  assert.match(M.summary(run("pages64k")), /^First failing check: Page size Apple Silicon has/);
  assert.match(M.summary(run("zboot")), /^EFI zboot wrapper: macvmm refuses it by name \(exit 2\); its header passes/);
  assert.match(M.summary(run("zbootpast")), /cargo xtask unzboot would stop: payload 0x1000\+0xfffff800/);
});

test("rustDebugStr matches Rust's {:?} for a str (checked against rustc output)", () => {
  // rustc: println!("{:?}", "a\u{80}b\u{200b}c \"\\\n\0\u{301}é\u{7f}\u{e000}\u{a0}\u{2028}\u{fffd}\u{ad}");
  const rust = String.raw`"a\u{80}b\u{200b}c \"\\\n\0\u{301}é\u{7f}\u{e000}\u{a0}\u{2028}` + "�" + String.raw`\u{ad}"`;
  assert.equal(M.rustDebugStr("a\u0080b​c \"\\\n\0́é\u007f  �­"), rust);
  assert.equal(M.rustDebugStr("zstd"), '"zstd"');
  // A crafted compression field c2 80 (U+0080) decodes as from_utf8_lossy would and is escaped.
  let z = M.step(M.initialState(), { type: "source", base: "zboot" });
  z = M.step(z, { type: "setByte", off: 24, value: 0xc2 });
  z = M.step(z, { type: "setByte", off: 25, value: 0x80 });
  assert.equal(M.analyze(z).zboot.error, String.raw`unsupported compression "\u{80}ip" (only gzip is supported)`);
});

test("ELF bytes with --initrd: the summary repeats the plan's refusal, never 'takes it'", () => {
  let s = M.initialState();
  [0x7f, 0x45, 0x4c, 0x46].forEach((v, off) => (s = M.step(s, { type: "setByte", off, value: v })));
  const a = M.analyze(s);
  assert.equal(a.kind, "elf");
  assert.equal(a.plan.message, "macvmm: cannot load the guest: --initrd needs an arm64 Image --kernel");
  assert.equal(M.summary(a), "An ELF file, but macvmm: cannot load the guest: --initrd needs an arm64 Image --kernel");
  assert.equal(a.checkFirst, -1);
  const b = M.analyze(M.step(s, { type: "setInitrd", size: null }));
  assert.match(M.summary(b), /^An ELF file: macvmm's ELF loader takes it/);
});

test("when detect() stops the loader, no Image check is marked as failing first", () => {
  const a = run("badmagic");
  assert.equal(a.plan.stage, "detect");
  assert.equal(a.image.first, 1, "on its own the magic check fails");
  assert.equal(a.checkFirst, -1, "but the readout marks nothing as the first failure");
  const marks = M.checkMarks(a.image.checks, a.checkFirst, true);
  assert.ok(marks.every((m) => m.cls !== "bad"));
  assert.equal(marks[1].word, "not run; on its own it would fail");
  assert.equal(marks[0].word, "not run; on its own it would pass");
  // A header failure still marks its check.
  const p = run("pages64k");
  assert.equal(p.checkFirst, 3);
  assert.equal(M.checkMarks(p.image.checks, p.checkFirst)[3].cls, "bad");
});

test("pasted rows: the file length is unknown until typed, and file=? until then", () => {
  const r = M.parseXxd(readFileSync(join(repo, "course/captures/13-image-header.txt"), "utf8"));
  const custom = { length: BigInt(r.end), chunks: r.chunks };
  let s = M.step(M.initialState(), { type: "source", base: "paste" }, custom);
  let a = M.analyze(s, custom);
  assert.equal(a.lengthKnown, false);
  const fl = a.image.checks.find((c) => c.id === "filelen");
  assert.equal(fl.pass, null);
  assert.match(fl.detail, /file length unknown/);
  assert.equal(a.image.undecided, 6);
  assert.equal(a.plan.stage, "ok");
  assert.match(a.plan.lines.find((l) => l.startsWith("header")), / file=\? /);
  assert.equal(a.wrongMap, null);
  // A length equal to the pasted bytes still counts as typed.
  s = M.step(s, { type: "setLength", value: 64n }, custom);
  a = M.analyze(s, custom);
  assert.equal(a.lengthKnown, true);
  assert.match(a.plan.lines.find((l) => l.startsWith("header")), / file=0x40 /);
  // Fewer than 64 bytes pasted with no length: the length check itself is open.
  const short = { length: 32n, chunks: [{ off: 0, bytes: r.chunks[0].bytes.slice(0, 16) }, { off: 16, bytes: r.chunks[1].bytes }] };
  const c = M.checkImage(M.makeView(short.length, short.chunks), { lengthKnown: false });
  assert.equal(c.checks[0].pass, null);
  assert.equal(c.first, -1);
  assert.equal(c.undecided, 0);
  assert.equal(c.header, null);
});

test("the BSS scenario reproduces the arm64-boot-protocol primer's predict", () => {
  const a = run("bss");
  assert.equal(a.plan.stage, "ok");
  assert.equal(a.plan.initrd.start, 0x41a0_0000n, "macvmm's plan: after image_size");
  assert.equal(a.wrongMap.start, 0x4160_0000n, "the tempting wrong answer: after the file");
  assert.equal(a.wrongMap.overlap, 4n << 20n, "the kernel would zero the first 4 MiB");
  assert.equal(run("alpine").wrongMap, null, "Alpine's file is exactly image_size long: no BSS to overlap");
});
