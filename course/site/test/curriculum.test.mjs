// Tests for lib/curriculum.mjs against the real course/CURRICULUM.md, plus mutated copies of it
// for the failure paths. Run: node --test course/site/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseCurriculum, chaptersDocument, serialize, PRIMER_TITLES, PART_SLUGS } from "../lib/curriculum.mjs";
import { parseFrontMatter } from "../lib/frontmatter.mjs";

const courseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEXT = readFileSync(join(courseDir, "CURRICULUM.md"), "utf8");
const DATA = parseCurriculum(TEXT);

/** Replace exactly one occurrence, so a test notices when CURRICULUM.md changes under it. */
function mutate(from, to) {
  const n = TEXT.split(from).length - 1;
  assert.equal(n, 1, `expected exactly one ${JSON.stringify(from)} in CURRICULUM.md, found ${n}`);
  return TEXT.replace(from, to);
}

test("chapters.json is up to date with CURRICULUM.md", () => {
  const committed = readFileSync(join(courseDir, "chapters.json"), "utf8");
  assert.equal(committed, serialize(chaptersDocument(TEXT)), "run: node course/site/gen-chapters.mjs");
});

test("generation is deterministic", () => {
  assert.equal(serialize(chaptersDocument(TEXT)), serialize(chaptersDocument(TEXT)));
});

test("28 chapters, ids 00-27 in order, each in exactly one part", () => {
  assert.equal(DATA.chapters.length, 28);
  DATA.chapters.forEach((c, i) => assert.equal(c.id, String(i).padStart(2, "0")));
  const inParts = DATA.parts.flatMap((p) => p.chapters);
  assert.deepEqual(inParts, DATA.chapters.map((c) => c.id));
});

test("parts follow PART_SLUGS order and number their chapters from 1", () => {
  assert.deepEqual(DATA.parts.map((p) => p.id), Object.keys(PART_SLUGS).filter((k) => DATA.parts.some((p) => p.id === k)));
  assert.equal(DATA.parts.length, 12);
  for (const p of DATA.parts) {
    p.chapters.forEach((id, k) => {
      const c = DATA.chapters.find((x) => x.id === id);
      assert.equal(c.number, `${p.id}.${k + 1}`);
      assert.equal(c.url, `${p.slug}/${c.slug}/`);
      assert.equal(c.file, `course/chapters/${p.id}/${c.id}-${c.slug}.md`);
    });
  }
});

test("spot values match the overview table", () => {
  const ch = (id) => DATA.chapters.find((c) => c.id === id);
  assert.equal(ch("02").title, "An exception, one level up: your first VM exit");
  assert.equal(ch("02").minutes, 330);
  assert.deepEqual(ch("02").labs, ["exception-stepper", "a64-encoder"]);
  assert.deepEqual(ch("20").prereqs, ["18", "12"]);
  assert.deepEqual(ch("00").prereqs, []);
  assert.equal(ch("22").status, "should");
  assert.equal(ch("24").status, "stretch");
  assert.equal(ch("26").status, "post-v1");
  assert.equal(ch("17").runs, "mac"); // "None new"
  assert.equal(ch("07").runs, "mac+browser");
});

test("prereqs only point backwards", () => {
  for (const c of DATA.chapters) for (const p of c.prereqs) assert.ok(p < c.id, `${c.id} needs later chapter ${p}`);
});

test("primers: 24, all with a reading time and a display title", () => {
  assert.equal(DATA.primers.length, 24);
  for (const p of DATA.primers) {
    assert.equal(typeof p.minutes, "number", p.slug);
    assert.ok(p.minutes >= 15 && p.minutes <= 30, `${p.slug}: ${p.minutes} min`);
    assert.equal(p.title, PRIMER_TITLES[p.slug]);
  }
  assert.deepEqual(Object.keys(PRIMER_TITLES).sort(), DATA.primers.map((p) => p.slug).sort());
});

test("PRIMER_TITLES equal the title in each primer file", () => {
  const files = readdirSync(join(courseDir, "primers")).filter((f) => f.endsWith(".md") && f !== "README.md");
  assert.deepEqual(files.map((f) => f.replace(/\.md$/, "")).sort(), Object.keys(PRIMER_TITLES).sort());
  for (const f of files) {
    const { data } = parseFrontMatter(readFileSync(join(courseDir, "primers", f), "utf8"));
    assert.equal(data.title, PRIMER_TITLES[f.replace(/\.md$/, "")], f);
  }
});

test("a qualified 'Also used by' entry links a primer without requiring it", () => {
  const pg = DATA.primers.find((p) => p.slug === "page-granules");
  assert.deepEqual(pg.also_used_by, ["02", "05", "26"]);
  assert.deepEqual(pg.required_by, ["04", "05", "26"]);
  assert.deepEqual(pg.linked_from, ["02"]);
  const ch02 = DATA.chapters.find((c) => c.id === "02");
  assert.ok(ch02.primers.includes("aarch64-reading"));
  assert.ok(!ch02.primers.includes("page-granules"));
  assert.ok(ch02.primers_linked.includes("page-granules"));
  const ch00 = DATA.chapters.find((c) => c.id === "00");
  assert.deepEqual(ch00.primers, ["os-basics"]);
  assert.deepEqual(ch00.primers_linked, ["codesign-entitlements"]); // "00 (doctor line)"
});

test("only the 'Primers (read first)' group of a Concepts box makes a primer required", () => {
  const ch04 = DATA.chapters.find((c) => c.id === "04");
  assert.deepEqual(ch04.primers, ["page-granules"]);
  // `memory-ordering` is a forward pointer in ch04's box and "04 (seed)" in the table.
  assert.ok(ch04.primers_linked.includes("memory-ordering"));
  for (const c of DATA.chapters) {
    for (const s of c.primers_linked) assert.ok(!c.primers.includes(s), `${c.id}: ${s} both required and linked`);
  }
});

test("labs: tiers, owners and primer embeds", () => {
  const lab = (n) => DATA.labs.find((l) => l.name === n);
  assert.equal(lab("toy-vmm").priority, "v1-core");
  assert.equal(lab("repr-c-layout").priority, "v1-optional");
  assert.equal(lab("rsp-decoder").priority, "post-v1");
  assert.deepEqual(lab("virtqueue-visualizer").chapters, ["15", "16"]);
  assert.deepEqual(lab("linker-map").primers, ["bare-metal-rust"]); // "(in the `bare-metal-rust` primer)"
  assert.deepEqual(lab("boot-chain").primers, ["uefi"]); // "that the `uefi` primer also embeds"
  assert.ok(!DATA.chapters.find((c) => c.id === "02").labs.includes("pstate-builder")); // "ch06's `pstate-builder`"
  for (const l of DATA.labs) assert.ok(l.chapters.length > 0, l.name);
  for (const c of DATA.chapters) for (const n of c.labs) assert.ok(lab(n), `${c.id}: unknown lab ${n}`);
});

test("fails loudly when a primer loses its reading time", () => {
  assert.throws(() => parseCurriculum(mutate("15-minute `unix-sockets`", "15 minutes on `unix-sockets`")), /unix-sockets.*reading time/);
});

test("fails loudly on a Lab line that starts with an unknown lab", () => {
  assert.throws(() => parseCurriculum(mutate("- **Lab.** `boot-chain`:", "- **Lab.** `boot-chains`:")), /chapter 21.*boot-chains/);
});

test("fails loudly when a chapter entry is missing or misnamed", () => {
  assert.throws(() => parseCurriculum(mutate("#### 12 `gicv3`:", "#### 12 `gic`:")), /chapter 12: overview slug/);
  assert.throws(() => parseCurriculum(mutate("#### 12 `gicv3`:", "##### 12 `gicv3`:")), /chapter 12 .*no "#### 12" entry/);
});

test("fails loudly when a primer has no display title", () => {
  assert.throws(() => parseCurriculum(mutate("| `macos-sandbox` |", "| `macos-sandboxes` |")), /no "NN-minute|no display title/);
});
