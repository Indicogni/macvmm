// samples.mjs is generated from real captures. This test checks it has not drifted from them, and
// rewrites it when run with BLA_REGEN=1:
//
//   BLA_REGEN=1 node --test course/site/src/labs/boot-log-annotator/samples.test.mjs
//
// Each sample's `text` is the capture file byte for byte, header included, so the lab parses the
// same capture format the site renders (the model strips the header and keeps stdout, the exit
// status and the VMM's stderr lines).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CAPTURES = here("../../../../captures/");

export const SPEC = [
  {
    id: "boot",
    label: "A healthy boot (chapter 14)",
    about: "The reference VMM boots Alpine's kernel with the test initramfs and powers off. Every milestone is here.",
    source: "14-boot-log.txt",
  },
  {
    id: "no-timer",
    label: "Broken run 1",
    about: "The same boot command, with one deliberate change to our VMM. Which stage never finished? Read the stage strip, then open the verdict to check.",
    quiz: true,
    source: "14-no-timer.txt",
  },
  {
    id: "wrong-gicr",
    label: "Broken run 2",
    about: "The same boot command, with a different deliberate change. Find the first line that reports trouble, and the stage it belongs to.",
    quiz: true,
    source: "14-wrong-gicr.txt",
  },
  {
    id: "no-id",
    label: "Broken run 3",
    about: "Another deliberate change. This run powers off cleanly with exit status 0. Look for the milestone line that is missing.",
    quiz: true,
    source: "14-no-pl011-id.txt",
  },
  {
    id: "silent",
    label: "The silent run (chapter 14's opening)",
    about: "The run chapter 14 opens with: no earlycon on the command line, and the serial port shows nothing at all. What can the exit status and the VMM's statistics still tell you?",
    quiz: true,
    source: "14-no-pl011-id-silent.txt",
  },
  {
    id: "panic",
    label: "A panic on purpose, after /init",
    about: "The test initramfs crashes the kernel on request; panic=-1 turns the panic into a reset.",
    source: "14-panic-reset.txt",
  },
];

const DTS_SOURCE = "14-dts.txt";

export function buildSamples() {
  const samples = SPEC.map((s) => ({ ...s, source: `captures/${s.source}`, text: readFileSync(CAPTURES + s.source, "utf8") }));
  const dts = { source: `captures/${DTS_SOURCE}`, text: readFileSync(CAPTURES + DTS_SOURCE, "utf8") };
  return { samples, dts };
}

export function renderSamples(data) {
  return [
    "// Bundled boot logs for boot-log-annotator. Generated data: do not edit by hand.",
    "//",
    "// Each `text` is a capture file from course/captures, byte for byte (real runs of the reference",
    "// VMM on an Apple M5 Pro). `dts` is the device tree the healthy run was given, as dtc printed it.",
    "// samples.test.mjs checks these against the files and regenerates this module (BLA_REGEN=1).",
    `export default ${JSON.stringify(data, null, 1)};`,
    "",
  ].join("\n");
}

test("samples.mjs matches the captures it was generated from", async () => {
  const want = renderSamples(buildSamples());
  const path = here("./samples.mjs");
  if (process.env.BLA_REGEN === "1") writeFileSync(path, want);
  const have = readFileSync(path, "utf8");
  assert.equal(have, want, "samples.mjs is stale: rerun with BLA_REGEN=1");
  const mod = (await import("./samples.mjs")).default;
  assert.equal(mod.samples.length, SPEC.length);
  for (const s of mod.samples) assert.ok(s.text.startsWith("# "), `${s.id} keeps its provenance header`);
});
