// The port against the real filter. The digests below are SHA-256 hashes of what macvmm's own
// `AnsiFilter` (crates/vmm/src/backend/ansi.rs, commit dbbe149) produced for the inputs in
// corpus.test.mjs, one line per input:
//
//   <input hex> <safe output hex> <safe dropped()> <strict output hex> <strict dropped()>\n
//
// each input pushed once with `push_at(input, &mut out, now)` into a fresh filter. This test
// rebuilds the same lines from model.mjs (with segment tracing on and off) and compares hashes,
// so the lab cannot show an output the VMM would not produce.
//
// No vector file for the filter exists in course/site/labs/vectors/ yet. Until one does, the
// expected outputs were recorded with this throwaway program (a binary crate with
// `vmm = { path = "crates/vmm" }`), fed one hex input per line on stdin:
//
//   for line in stdin.lock().lines() {
//       let input = unhex(line?.trim());
//       let now = Instant::now();
//       for p in [FilterPolicy::Safe, FilterPolicy::Strict] {
//           let (mut f, mut o) = (AnsiFilter::new(p), Vec::new());
//           f.push_at(&input, &mut o, now);
//           // print hex(o) and f.dropped()
//       }
//   }
//
// If ansi.rs changes, the source-hash test below fails: rerun that program on
// `structuredInputs()` and `randomInputs(10000)`, update the digests and SOURCE_SHA256.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runFilter } from "./model.mjs";
import { structuredInputs, randomInputs } from "./corpus.test.mjs";

const STRUCTURED_SHA256 = "6880bcddb5de18eb1f1eda34cc79863b0b06ad37ff01a43c1e6238d8665d1335";
const RANDOM_SHA256 = "18b0a7d3a6ef45a6fc6fde7f7f9a796dbbaf1a1d02bdd09a8526a4a1edf0e785";
const SOURCE_SHA256 = "9c36da04fcba966b8a23d30cf9b58aeac94d8aab85d14d32112d19f00410c25c";

const hex = (b) => Buffer.from(b).toString("hex");

function digest(inputs, trace) {
  const h = createHash("sha256");
  for (const input of inputs) {
    const s = runFilter("safe", input, { trace });
    const t = runFilter("strict", input, { trace });
    h.update(`${hex(input)} ${hex(s.out)} ${s.dropped} ${hex(t.out)} ${t.dropped}\n`);
  }
  return h.digest("hex");
}

test("structured corpus: safe and strict match the Rust filter byte for byte, with the dropped counter", () => {
  const inputs = structuredInputs();
  assert.equal(digest(inputs, false), STRUCTURED_SHA256);
  assert.equal(digest(inputs, true), STRUCTURED_SHA256, "segment tracing changed the output");
});

test("10,000 random inputs (the Rust property-test generator and seed) match the Rust filter", () => {
  const inputs = randomInputs(10000);
  assert.equal(digest(inputs, false), RANDOM_SHA256);
});

test("the recorded outputs are for the current ansi.rs", (t) => {
  const src = fileURLToPath(new URL("../../../../../crates/vmm/src/backend/ansi.rs", import.meta.url));
  if (!existsSync(src)) {
    t.skip("crates/vmm/src/backend/ansi.rs not found (site built outside the repository)");
    return;
  }
  const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
  assert.equal(sha, SOURCE_SHA256, "ansi.rs changed: re-record the oracle digests (see the header of this file)");
});
