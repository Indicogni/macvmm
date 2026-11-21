// Tests for the hostile-guest model: the port must be the reference's fuzzer, draw for draw.
// Evidence, strongest first: a table recorded from the Rust fuzzer on the reference Mac (input
// length, FNV-1a of the bytes, mutation count, verdict) and a digest over 20,000 iterations; the
// chapter 25 captures (iteration numbers and messages, byte for byte); the lesson's numbers;
// the hand-built reproducer file; ports of the Rust unit tests; drift checks that re-read the
// Rust source. No vector file exists for the fuzzer (labs/vectors has none), so the recorded
// table stands in for one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Rng, generate, runInput, fuzz, failureLines, replayLines, seedInput, mutateTarget, mutateBytes, mutateDescriptor,
  minimise, nonZero, trimmedLength, threeBuffers, THREE_LEN, INPUT_LEN, DESC_OFF, IND_OFF,
  INTERESTING_BYTES, INTERESTING_U64, REGIONS, RAM_A, RAM_A_SIZE, RAM_B, RAM_B_SIZE, PLANTS,
  plantById, decodeShare, encodeShare, REFERENCE_SHARE, parseSeed, parseIter, decodeSpec,
  describeOffset, getLe, putLe, HANG_READS, inOneRegion, tableRows, flagNames, placeOf,
} from "./model.mjs";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const labJson = JSON.parse(readFileSync(new URL("./lab.json", import.meta.url), "utf8"));

function fnv(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The stdout lines of a capture (between `--- stdout ---` and `--- stderr ---`). */
function stdout(name) {
  const t = read(`course/captures/${name}.txt`);
  const a = t.indexOf("--- stdout ---\n");
  const b = t.indexOf("--- stderr ---");
  assert.ok(a >= 0 && b > a, `${name} has stdout`);
  return t.slice(a + 15, b).split("\n").filter((l) => l.length);
}

// Recorded from the reference's fuzz crate (Rng::derive, virtqueue::seed/mutate/run,
// mutate::bytes, exactly main.rs's loop) by a scratch program on the reference Mac:
// [seed, iteration, input length, FNV-1a 32 of the input, mutation rounds, verdict].
const RUST = [
  [1, 0, 5640, 0x1be1c8df, 3, "ok"], [1, 1, 5640, 0xd8edb3e3, 3, "ok"], [1, 2, 5639, 0x3b580b61, 6, "ok"],
  [1, 3, 5640, 0xcd94d776, 8, "ok"], [1, 4, 5640, 0x601c1da8, 4, "ok"], [1, 5, 5640, 0x2ff11e38, 7, "ok"],
  [1, 6, 5640, 0xb8a1b9f3, 3, "ok"], [1, 7, 5640, 0x57c467e7, 6, "ok"], [1, 8, 5640, 0x1cce041f, 0, "ok"],
  [1, 9, 5640, 0x0dac870e, 6, "ok"], [1, 10, 5640, 0x04358450, 1, "ok"], [1, 11, 5640, 0x4205a091, 1, "ok"],
  [1, 100, 5640, 0x804a9430, 0, "ok"], [1, 250, 5640, 0x70c200c7, 5, "ok"], [1, 1000, 5640, 0x4ff6bbb1, 8, "ok"],
  [1, 4096, 5640, 0xabbd4193, 0, "ok"], [1, 65535, 5640, 0xf41c7a9e, 4, "ok"], [1, 1000000, 5640, 0x83d0f916, 7, "ok"],
  [1, 23338941, 5640, 0xd7b82b0b, 8, "ok"], [1, 9007199254740991, 5640, 0xe8736f35, 8, "ok"],
  [2, 0, 5640, 0xbfc08dce, 3, "ok"], [2, 1, 5640, 0x156b7277, 4, "ok"], [2, 2, 5640, 0xfda68cab, 8, "ok"],
  [2, 3, 5626, 0xdb362443, 2, "ok"], [2, 4, 5640, 0x084109c2, 1, "ok"], [2, 5, 5635, 0xc8d01bbf, 8, "ok"],
  [2, 6, 5640, 0xcb58b57e, 2, "ok"], [2, 7, 5640, 0x0fa8bfec, 0, "ok"], [2, 8, 5640, 0xc3aafe13, 4, "ok"],
  [2, 9, 5640, 0x75b2d75b, 6, "ok"], [2, 10, 5640, 0xc069d8a6, 3, "ok"], [2, 11, 5640, 0x2fbe3b3a, 4, "ok"],
  [2, 100, 5640, 0x22a5a8c5, 3, "ok"], [2, 250, 5640, 0xf851d87d, 7, "ok"], [2, 1000, 5640, 0x13ef8e8c, 2, "ok"],
  [2, 4096, 5640, 0xc39b6401, 0, "ok"], [2, 65535, 5640, 0x1cdfa26b, 4, "ok"], [2, 1000000, 5640, 0x398bf3d9, 6, "ok"],
  [2, 23338941, 5640, 0xe6d9b4f3, 7, "ok"], [2, 9007199254740991, 5640, 0x964bbdfb, 0, "ok"],
  [3735928559, 0, 5640, 0xd80c43e9, 2, "ok"], [3735928559, 1, 5640, 0x70d616d3, 3, "ok"],
  [3735928559, 2, 5640, 0xdffcf3ef, 8, "ok"], [3735928559, 3, 5640, 0x65b9a1bd, 6, "ok"],
  [3735928559, 4, 5640, 0x81a90cf5, 1, "ok"], [3735928559, 5, 5640, 0x56bbbad7, 1, "ok"],
  [3735928559, 6, 5640, 0x76651f5f, 5, "ok"], [3735928559, 7, 5640, 0xe5637b69, 3, "ok"],
  [3735928559, 8, 5640, 0xee080def, 7, "ok"], [3735928559, 9, 5640, 0x443dfa41, 6, "ok"],
  [3735928559, 10, 5640, 0xe4a8d98f, 7, "ok"], [3735928559, 11, 5640, 0xa821abe6, 1, "ok"],
  [3735928559, 100, 5640, 0xfb664093, 7, "ok"], [3735928559, 250, 5640, 0x6228a4a5, 0, "ok"],
  [3735928559, 1000, 5640, 0x178ec0b3, 8, "ok"], [3735928559, 4096, 5640, 0x97b2e419, 6, "ok"],
  [3735928559, 65535, 5640, 0x97c8ab75, 3, "ok"], [3735928559, 1000000, 5640, 0x7e9f72fb, 1, "ok"],
  [3735928559, 23338941, 5640, 0x43c20360, 2, "ok"], [3735928559, 9007199254740991, 5640, 0x61232607, 3, "ok"],
];
// The same program: FNV-1a over the little-endian FNV of each input, iterations 0..20000 of
// seed 1, and how many passed the unmodified reference.
const RUST_DIGEST_20000 = 0x0aa386f2;
const RUST_FIRST_OUTPUT_SEED_0_AND_1 = 0x47e4ce4b896cdd1dn;

test("generation matches the table recorded from the Rust fuzzer", () => {
  for (const [seed, iter, len, hash, rounds, verdict] of RUST) {
    const g = generate(BigInt(seed), iter);
    assert.equal(g.input.length, len, `seed ${seed} iteration ${iter}: length`);
    assert.equal(fnv(g.input), hash, `seed ${seed} iteration ${iter}: bytes`);
    assert.equal(g.rounds, rounds, `seed ${seed} iteration ${iter}: rounds`);
    assert.equal(runInput(g.input, 0).ok ? "ok" : "fail", verdict);
  }
});

test("20,000 iterations of seed 1: same digest as Rust, and all pass the reference", () => {
  let agg = 0x811c9dc5;
  let oks = 0;
  for (let i = 0; i < 20000; i++) {
    const { input } = generate(1n, i);
    if (runInput(input, 0).ok) oks++;
    let h = fnv(input);
    for (let k = 0; k < 4; k++) {
      agg ^= h & 0xff;
      agg = Math.imul(agg, 0x01000193) >>> 0;
      h >>>= 8;
    }
  }
  assert.equal(agg >>> 0, RUST_DIGEST_20000);
  assert.equal(oks, 20000);
});

test("rng.rs unit test, ported, plus the recorded first output", () => {
  const take = (seed) => { const r = new Rng(seed); return Array.from({ length: 8 }, () => r.nextU64()); };
  assert.deepEqual(take(42n), take(42n));
  assert.ok(take(42n).every((x) => x !== 0n));
  assert.equal(new Rng(0n).nextU64(), new Rng(1n).nextU64());
  assert.equal(new Rng(1n).nextU64(), RUST_FIRST_OUTPUT_SEED_0_AND_1);
  assert.notEqual(Rng.derive(7n, 1n).nextU64(), Rng.derive(7n, 2n).nextU64());
  assert.equal(new Rng(5n).below(0), 0);
});

test("mutate.rs unit test, ported: mutators respect bounds", () => {
  const rng = new Rng(9n);
  const shape = { regions: [[0x1000n, 0x1000n], [0x4000n, 0x100n]], specials: [0x10n] };
  for (let k = 0; k < 10000; k++) {
    const b = Array.from({ length: 64 }, () => rng.byte());
    mutateBytes(rng, b, 80);
    assert.ok(b.length <= 80);
    assert.ok(b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255));
    const t = new Array(64).fill(0);
    mutateDescriptor(rng, t, 0, 4, shape);
    mutateDescriptor(rng, t, 60, 4, shape); // out of range: ignored
    assert.equal(t.length, 64);
  }
  assert.equal(getLe([1, 2], 0, 4), 0x0201n);
});

test("virtqueue.rs unit test, ported: seeds pass and mutants never throw", () => {
  const rng = new Rng(1n);
  for (let k = 0; k < 2000; k++) {
    const s = seedInput(rng);
    assert.equal(runInput(Uint8Array.from(s), 0).ok, true, "a well-formed ring must pass");
    const m = [...s];
    mutateTarget(rng, m);
    mutateBytes(rng, m, INPUT_LEN);
    for (let p = 0; p <= 5; p++) runInput(Uint8Array.from(m), p);
  }
  assert.equal(runInput(new Uint8Array(0), 0).ok, true);
});

// Each plant's capture: the FAILURE line and the iteration count line, byte for byte. The middle
// line (where the input was saved) is the browser's own.
const CAPTURED = [
  { plant: 1, capture: "25-break-checked-add" },
  { plant: 2, capture: "25-predict-hop" },
  { plant: 3, capture: "25-break-ring-index" },
];

test("plants 1-3 fail at the captured iteration with the captured message", () => {
  for (const { plant, capture } of CAPTURED) {
    const lines = stdout(capture);
    const r = fuzz(1n, plant, 0, 1000);
    assert.ok(r.failure, `plant ${plant} found`);
    const want = failureLines(1n, r.failure.iter, r.failure.message);
    assert.equal(lines[0], want[0], capture);
    assert.match(lines[1], /^fuzz virtqueue: input saved to /, capture);
    assert.equal(want[1], "fuzz virtqueue: input not saved (in the browser; the page URL keeps it)");
    assert.equal(lines[2], want[2], capture);
    assert.equal(r.failure.iter, labJson.found[`p${plant}`]);
  }
});

test("plant 4 (double fetch) reproduces the self-test's virtqueue line", () => {
  const lines = stdout("25-bughunt-selftest").map((l) => l.trim());
  const r = fuzz(1n, 4, 0, 1000);
  const want = failureLines(1n, r.failure.iter, r.failure.message)[0];
  assert.ok(lines.includes(want), want);
  assert.equal(r.failure.iter, labJson.found.p4);
  assert.equal(r.failure.invariant, 3);
  // The self-test's lines for plants 1-3 are the same as the single-plant captures.
  for (const p of [1, 2, 3]) {
    const f = fuzz(1n, p, 0, 1000).failure;
    assert.ok(lines.includes(failureLines(1n, f.iter, f.message)[0]), `self-test line for plant ${p}`);
  }
});

test("plant 5: iteration 23,338,941 replays the capture; the reference passes it", () => {
  const lines = stdout("25-predict-seq3");
  const iter = labJson.found.p5;
  assert.equal(iter, 23338941);
  const { input } = generate(1n, iter);
  const r = runInput(input, 5);
  assert.equal(r.ok, false);
  const want = failureLines(1n, iter, r.message);
  assert.equal(lines[0], want[0]);
  assert.equal(lines[2], want[2]);
  assert.equal(stdout("25-replay-saved")[0], `fuzz virtqueue: replay FAILED: ${r.message}`);
  assert.deepEqual(replayLines(r), stdout("25-replay-saved").slice(0, 1));
  assert.equal(runInput(input, 0).ok, true);
  // The lesson: 5,640 bytes, of which 162 are not zero.
  assert.equal(input.length, 5640);
  assert.equal(nonZero(input), 162);
  // Not proof that no earlier iteration fails (that is 23 million runs), but the start is clean.
  assert.equal(fuzz(1n, 5, 0, 3000).failure, null);
});

test("the hand-built three-buffer input is the shipped file and replays both captures", () => {
  const file = readFileSync(root + "crates/fuzz/planted/05-three-buffers.bin");
  const mine = threeBuffers();
  assert.equal(mine.length, THREE_LEN);
  assert.deepEqual([...mine], [...file]);
  assert.equal(file.length, 568);
  assert.equal(nonZero(mine), 17);
  const p5 = runInput(mine, 5, true);
  assert.equal(stdout("25-replay-seq3")[0], `fuzz virtqueue: replay FAILED: ${p5.message}`);
  assert.equal(stdout("25-replay-ref")[0], runInput(mine, 0).ok ? "fuzz virtqueue: replay OK" : "?");
  const reads = p5.pops.at(-1).reads;
  assert.deepEqual(reads.map((r) => [r.addr, r.len]), [[0x40008000n, 16], [0x40009000n, 16], [0x40008000n, 0x40000]]);
  assert.match(reads[2].verdict, /without a RAM check/);
});

test("the lesson quotes the model's numbers", () => {
  const md = read("course/chapters/XI/25-security.md");
  const f2 = fuzz(1n, 2, 0, 100).failure;
  assert.ok(md.includes(`Iteration ${f2.iter}, under a second`));
  const reads = /^(\d+) descriptor reads/.exec(f2.message)[1];
  assert.ok(md.includes(`${Number(reads).toLocaleString("en-US")} reads for a two-entry queue`));
  assert.ok(md.includes(`Iteration ${labJson.found.p5.toLocaleString("en-US")}, after 128 seconds`));
  assert.ok(md.includes("It is 5,640 bytes, of which 162 are not zero"));
  assert.ok(md.includes("568 bytes (the header, the avail entries and three descriptors), 17 of them not zero"));
  assert.ok(md.includes("readable `0x40008000+16`, writable `0x40009000+16`, writable `0x40008000+0x40000`"));
  assert.ok(md.includes(":::lab hostile-guest"));
  // The fuzz RAM table in the lesson.
  assert.ok(md.includes("0x4000_0000  region A, 256 KiB"));
  assert.ok(md.includes("0x4008_0000  region B, 64 KiB"));
});

test("drift: constants, message formats and plants re-read from the Rust source", () => {
  const mut = read("crates/fuzz/src/mutate.rs");
  const vq = read("crates/fuzz/src/targets/virtqueue.rs");
  const mod = read("crates/fuzz/src/targets/mod.rs");
  const main = read("crates/fuzz/src/main.rs");
  const ibytes = /INTERESTING_BYTES: \[u8; 16\] = \[([\s\S]*?)\];/.exec(mut)[1];
  const parsed = ibytes.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith("b'") ? s.charCodeAt(2) : Number(s.replaceAll("_", ""))));
  assert.deepEqual(parsed, INTERESTING_BYTES);
  assert.equal(INTERESTING_U64.length, 14);
  assert.match(mut, /INTERESTING_U64: \[u64; 14\]/);
  for (const v of ["0x7fff_ffff_ffff_ffff", "0x8000_0000_0000_0000", "0x1_0000_0000", "u64::MAX - 1"]) assert.ok(mut.includes(v));
  assert.match(mod, /pub const RAM_A_SIZE: u64 = 0x4_0000;/);
  assert.match(mod, /pub const RAM_B: u64 = RAM_BASE \+ 0x8_0000;/);
  assert.match(mod, /pub const RAM_B_SIZE: u64 = 0x1_0000;/);
  assert.equal(RAM_A, 0x4000_0000n);
  assert.deepEqual(REGIONS, [[RAM_A, RAM_A_SIZE], [RAM_B, RAM_B_SIZE]]);
  assert.equal(RAM_A_SIZE, 0x4_0000n);
  assert.equal(RAM_B, 0x4008_0000n);
  assert.match(vq, /pub const MAX_SIZE: usize = 256;/);
  assert.match(vq, /pub const IND_ENTRIES: usize = 64;/);
  assert.equal(DESC_OFF, 520);
  assert.equal(IND_OFF, 4616);
  assert.equal(INPUT_LEN, 5640);
  for (const s of [
    "descriptor reads for one pop of a size-{} queue (VQ-5 hop budget)",
    "read twice in one pop (double fetch, MEM-7)",
    "is not inside one RAM region (VQ-4)",
    "device wrote {:#x}+{} outside the writable buffers and the used ring \\",
    "used.idx is {used_idx} after {completed} completions",
    "let max_reads = 2 * usize::from(spec.size) + 1;",
    "0 => 64 << 10,",
    "let fill = vec![0xa5u8;",
  ]) assert.ok(vq.includes(s), s);
  assert.ok(main.includes("let mut rng = Rng::derive(o.seed, iters);"));
  assert.ok(main.includes("let rounds = rng.below(9);"));
  assert.ok(main.includes("\"fuzz {}: FAILURE at iteration {} (seed {}): {e}\""));
  for (const p of PLANTS.filter((x) => x.file)) {
    const path = `crates/fuzz/planted/${p.file}`;
    assert.ok(existsSync(root + path), path);
    assert.match(read(path), new RegExp(`PLANTED BUG ${p.n}\\b`));
  }
});

test("invariants named by each plant's failure", () => {
  const inv = Object.fromEntries([1, 2, 3, 4].map((p) => [p, fuzz(1n, p, 0, 1000).failure.invariant]));
  assert.deepEqual(inv, { 1: 4, 2: 2, 3: 5, 4: 3 });
  assert.equal(runInput(generate(1n, 23338941).input, 5).invariant, 4);
});

/** A size-2 queue (one chain), the given cap byte, descriptor 0 a `len`-byte buffer pointing at itself. */
function selfLoop(capByte, len) {
  const b = new Uint8Array(INPUT_LEN);
  b[0] = 1; b[2] = 1; b[4] = capByte;
  putLe(b, DESC_OFF, 8, 0x40008000n);
  putLe(b, DESC_OFF + 8, 4, len);
  putLe(b, DESC_OFF + 12, 2, 1);
  return b;
}

test("plant 2 loops: the same read counts as the Rust fuzzer, measured with --replay", () => {
  // Recorded on the reference Mac: plant 2 applied to a copy, each ring written to a file and run
  // with `fuzz virtqueue --replay FILE`. The last row did not finish in 60 s (a hang).
  const measured = [
    [2, 4, 262145], [2, 1, 1048577], [0, 1, 65537], [3, 4096, 1048577], [3, 64, 67108865],
  ];
  for (const [cap, len, reads] of measured) {
    const r = runInput(selfLoop(cap, len), 2, true);
    assert.equal(r.invariant, 2);
    assert.equal(r.message, `${reads} descriptor reads for one pop of a size-2 queue (VQ-5 hop budget)`);
    assert.equal(r.pops.at(-1).reads.total, reads, "the trace counts skipped loops too");
  }
  assert.ok(67108865 < HANG_READS);
});

test("failure lines follow main.rs: FAILURE, where the input went, the count; HANG in the watchdog's format", () => {
  assert.deepEqual(failureLines(1n, 7, "m"), [
    "fuzz virtqueue: FAILURE at iteration 7 (seed 1): m",
    "fuzz virtqueue: input not saved (in the browser; the page URL keeps it)",
    "fuzz virtqueue: 8 iterations, 1 failures",
  ]);
  assert.deepEqual(failureLines(1n, 9, "m", true), [
    "fuzz virtqueue: HANG at iteration 9 (> 2000 ms); input not saved (in the browser; the page URL keeps it)",
    "fuzz virtqueue: 9 iterations, 1 failures",
  ]);
});

test("a length aimed at a target says where the buffer really ends", () => {
  const rng = new Rng(3n);
  const shape = { regions: REGIONS, specials: [] };
  let exact = 0;
  let wrapped = 0;
  for (let k = 0; k < 20000; k++) {
    const t = new Array(16).fill(0);
    putLe(t, 0, 8, 0x40080000n); // region B, so a target in region A wraps the 32-bit length
    const notes = [];
    mutateDescriptor(rng, t, 0, 1, shape, notes);
    const m = /len = (0x[0-9a-f]+)(?:, so it ends at (0x[0-9a-f]+)| \(aimed at (0x[0-9a-f]+); the 32-bit length wraps, so it ends at (0x[0-9a-f]+)\))$/.exec(notes[0] ?? "");
    if (!m) continue;
    const len = BigInt(m[1]);
    const end = BigInt.asUintN(64, 0x40080000n + len - 1n);
    assert.equal(getLe(t, 8, 4), len);
    if (m[2]) { exact++; assert.equal(BigInt(m[2]), end); }
    else { wrapped++; assert.equal(BigInt(m[4]), end); assert.notEqual(BigInt(m[3]), end); }
  }
  assert.ok(exact > 0 && wrapped > 0, `both kinds seen (${exact}, ${wrapped})`);
});

test("plant 1: an address near 2^64 is refused at its first byte (chapter 25's prediction)", () => {
  const b = new Uint8Array(INPUT_LEN);
  b[0] = 0; b[2] = 1; // a size-1 queue, one chain
  putLe(b, DESC_OFF, 8, 0xffff_ffff_ffff_fff0n);
  putLe(b, DESC_OFF + 8, 4, 0x40000020);
  const r = runInput(b, 1, true);
  assert.equal(r.ok, true);
  assert.match(r.outcome, /BufferOutOfRam/);
  assert.equal(r.pops[0].reads[0].verdict, "refused: first or last byte not in RAM");
});

test("a walk with no hop budget and a 4 GiB cap is reported as a hang", () => {
  const b = selfLoop(3, 1);
  const r = runInput(b, 2);
  assert.equal(r.ok, false);
  assert.equal(r.hang, true);
  assert.equal(r.reads, 4294967297);
  assert.match(r.message, /^HANG: 4294967297 descriptor reads in one pop, over the reference fuzzer's 2 s watchdog$/);
  assert.match(replayLines(r)[0], /^\[lab\] replay: no verdict\. This pop walks 4,294,967,297 descriptors/);
  // With the hop budget the same ring is refused after N hops, and the target is satisfied.
  const ok = runInput(b, 0, true);
  assert.equal(ok.ok, true);
  assert.match(ok.outcome, /ChainTooLong/);
});

test("minimise: deterministic, same invariant, far fewer bytes", () => {
  const { input } = generate(1n, 23338941);
  const a = minimise(input, 5);
  const b = minimise(input, 5);
  assert.deepEqual([...a.bytes], [...b.bytes]);
  const r = runInput(a.bytes, 5);
  assert.equal(r.ok, false);
  assert.equal(r.invariant, 4);
  assert.ok(nonZero(a.bytes) < 30, `${nonZero(a.bytes)} bytes left`);
  assert.ok(trimmedLength(a.bytes) <= INPUT_LEN);
  assert.equal(runInput(a.bytes, 0).ok, true, "the shrunk input still passes the reference");
  const pass = minimise(generate(1n, 0).input, 0);
  assert.equal(pass.message, null);
});

test("share strings: reference, round trip, hostile input refused", () => {
  assert.equal(REFERENCE_SHARE, labJson.reference);
  assert.deepEqual(decodeShare("p2:1:7"), { plant: "p2", three: false, seed: 1n, iter: 7, shrunk: false });
  assert.deepEqual(decodeShare("p5:three:m"), { plant: "p5", three: true, seed: 1n, iter: null, shrunk: true });
  for (const s of ["p2:1:7", "ref:18446744073709551615:0", "p5:1:23338941:m", "p1:three", "p4:3735928559:9007199254740991"]) {
    assert.equal(encodeShare(decodeShare(s)), s);
  }
  for (const bad of [null, "", "p9:1:7", "p2:1", "p2:-1:7", "p2:1:7:x", "p2:18446744073709551616:0",
    "p2:1:9007199254740992", "p2:1:1_000", "p2:0x1:7", "P2:1:7", "p2:1:7:m:m", "p2:three:x",
    "x".repeat(65), "p2:1:7\n", "p2: 1:7", "__proto__:1:1", "constructor:three"]) {
    assert.equal(decodeShare(bad), null, String(bad));
  }
  assert.equal(parseSeed("18446744073709551615"), (1n << 64n) - 1n);
  assert.equal(parseSeed("18446744073709551616"), null);
  assert.equal(parseIter("23,338,941"), 23338941);
  assert.equal(parseIter("1e6"), null);
  assert.equal(plantById("toString"), null);
});

test("helpers: spec decode, offsets, flags, places", () => {
  const s = decodeSpec(threeBuffers());
  assert.equal(s.size, 4);
  assert.equal(s.perRound, 1);
  assert.equal(s.maxTotal, 1 << 20);
  assert.equal(s.rounds, 1);
  const packed = decodeSpec(Uint8Array.from([1, 2]));
  assert.equal(packed.used + 6n + 16n <= RAM_B + RAM_B_SIZE, true);
  assert.equal(packed.used % 4n, 0n);
  assert.equal(describeOffset(0), "queue size");
  assert.equal(describeOffset(521), "descriptor 0 addr");
  assert.equal(describeOffset(520 + 16 * 3 + 14), "descriptor 3 next");
  assert.equal(describeOffset(IND_OFF + 8), "indirect-table entry 0 len");
  assert.equal(describeOffset(9), "avail entry 0");
  assert.equal(flagNames(3), "NEXT|WRITE");
  assert.equal(flagNames(0), "-");
  assert.equal(placeOf(0x40040000n), "the hole");
  assert.equal(placeOf(0x40080000n), "region B");
  assert.equal(inOneRegion(0x4003fff0n, 0x10n), true);
  assert.equal(inOneRegion(0x4003fff0n, 0x11n), false);
  assert.equal(tableRows(threeBuffers()).length, 4);
});
