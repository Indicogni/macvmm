// Tests for the trap-or-not model. Run: node --test 'course/site/**/*.test.mjs'
//
// The lab must reproduce chapter 01's table exactly (ten actions, their order, the three bucket
// names, the reference bucket and the ledger rows), so these tests read the lesson itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUCKETS,
  ITEMS,
  LEDGER,
  initialState,
  step,
  unsorted,
  inBucket,
  sortedCount,
  status,
  feedbackText,
  ledgerText,
  chaptersText,
  nextLinks,
  LINKS,
  encode,
  decode,
  referenceState,
} from "./model.mjs";

const LESSON = fileURLToPath(new URL("../../../../chapters/0/01-ffi.md", import.meta.url));
const lesson = readFileSync(LESSON, "utf8");

// Rows of the lesson's "| Guest action | Bucket | What stops it, who handles it, and why | Ledger row |" table.
function lessonTable() {
  const lines = lesson.split("\n");
  const start = lines.findIndex((l) => l.startsWith("| Guest action | Bucket |"));
  assert.ok(start >= 0, "lesson table header not found in 01-ffi.md");
  const rows = [];
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    rows.push({ action: cells[0], bucket: cells[1], why: cells[2], rows: cells[3] });
  }
  return rows;
}

test("lesson table: ten rows, same order, same buckets, same ledger rows", () => {
  const rows = lessonTable();
  assert.equal(rows.length, 10);
  assert.equal(ITEMS.length, 10);
  const byLesson = new Map(BUCKETS.map((b) => [b.lesson, b.id]));
  rows.forEach((row, i) => {
    const it = ITEMS[i];
    assert.equal(byLesson.get(row.bucket), it.answer, `row ${i + 1} (${row.action}) bucket`);
    const lessonRows = row.rows.split(",").map((s) => Number(s.trim()));
    assert.deepEqual(lessonRows, [...it.rows], `row ${i + 1} ledger rows`);
    if (it.insn) assert.ok(row.action.includes(`\`${it.insn}\``), `row ${i + 1} names ${it.insn}`);
    // Every chapter the lesson cites in this row, the lab cites too.
    const cited = [...row.why.matchAll(/chapter (\d\d)/g)].map((m) => m[1]);
    // (chapter 00 is a backward reference, not a "more in" pointer.)
    for (const c of cited.filter((c) => c !== "00")) assert.ok(it.chapters.includes(c), `row ${i + 1} cites chapter ${c}`);
  });
});

test("lesson table: each item's why is the lesson's reasoning, word for word", () => {
  const rows = lessonTable();
  rows.forEach((row, i) => {
    const it = ITEMS[i];
    // str-uart is shortened on purpose (journal question 1); its own test guards it.
    if (it.id === "str-uart") return;
    let w = row.why.replace(/ \(chapter \d\d\)/g, "").replace(/`/g, "");
    w = w[0].toUpperCase() + w.slice(1) + ".";
    assert.equal(it.why, w, `row ${i + 1} (${it.id}) why`);
  });
});

test("Next links: fixed paths that match course/chapters.json", () => {
  const course = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../chapters.json", import.meta.url)), "utf8"));
  const byId = new Map(course.chapters.map((c) => [c.id, c.url]));
  for (const [k, path] of Object.entries(LINKS)) {
    if (k === "os-basics") assert.equal(path, course.primers.find((p) => p.slug === "os-basics").url);
    else assert.equal(path, byId.get(k), `chapter ${k}`);
  }
  for (const it of ITEMS) {
    for (const c of it.chapters) assert.ok(LINKS[c], `${it.id}: no link for chapter ${c}`);
    for (const l of nextLinks(it)) assert.ok(l.path && !l.path.startsWith("/") && !l.path.includes(":"), l.path);
  }
  assert.deepEqual(nextLinks(ITEMS[5]), [{ text: "the os-basics primer", path: "primers/os-basics/" }]);
  assert.deepEqual(nextLinks(ITEMS[3]).map((l) => l.text), ["chapter 02", "chapter 03"]);
});

test("lesson table: definitions quoted in the action cell match the lab", () => {
  const rows = lessonTable();
  rows.forEach((row, i) => {
    const m = row.action.match(/"([^"]+)"/);
    if (m) assert.equal(m[1], ITEMS[i].def, `row ${i + 1} definition`);
  });
});

test("lesson text: the three bucket names and the ten plain-word actions", () => {
  for (const b of BUCKETS) {
    assert.ok(lesson.toLowerCase().includes(`**${b.label.toLowerCase()}**`), `bucket "${b.label}" in the lesson list`);
  }
  const para = lesson.split("\n").find((l) => l.startsWith("If the lab does not load"));
  assert.ok(para, "fallback paragraph");
  const list = para.slice(para.indexOf("The ten actions:") + "The ten actions:".length);
  const parts = list.split(";").map((s) => s.trim().replace(/\.$/, ""));
  assert.equal(parts.length, 10);
  parts.forEach((p, i) => {
    const plain = p.replace(/\s*\(`[^`]+`\)$/, "").replace(/`/g, "");
    assert.equal(plain.toLowerCase(), ITEMS[i].plain.toLowerCase(), `action ${i + 1} plain words`);
    const insn = p.match(/\(`([^`]+)`\)$/);
    assert.equal(insn ? insn[1] : null, ITEMS[i].insn, `action ${i + 1} instruction`);
  });
});

test("reference split: four reach our VMM, two stay in the kernel, four never leave", () => {
  const ref = referenceState();
  assert.equal(inBucket(ref, "vmm").length, 4);
  assert.equal(inBucket(ref, "kernel").length, 2);
  assert.equal(inBucket(ref, "guest").length, 4);
});

test("every cited ledger row has a name, and every item has its texts", () => {
  for (const it of ITEMS) {
    assert.ok(it.plain && it.def && it.why && it.stops && it.handles, it.id);
    for (const r of it.rows) assert.ok(LEDGER[r], `ledger row ${r}`);
  }
  assert.equal(ledgerText(ITEMS[2]), "Ledger rows 6 (interrupts from devices) and 7 (an alarm clock, to take turns and sleep)");
  assert.equal(ledgerText(ITEMS[0]), "Ledger row 2 (physical memory and its page tables)");
  assert.equal(chaptersText(ITEMS[1]), "More in chapters 05 and 07");
  assert.equal(chaptersText(ITEMS[5]), "");
});

test("the store-to-UART feedback leaves journal question 1 to the learner", () => {
  const it = ITEMS.find((x) => x.id === "str-uart");
  assert.ok(!/empty|left this one|RAM at some|unmapped/i.test(it.why + it.stops + it.handles + it.note));
  // Names the load card rather than "above": sorted cards may sit in different buckets.
  assert.ok(it.why.includes('"Load a value from RAM"'));
});

test("what stops it: one template; only hvc stops by its nature", () => {
  for (const it of ITEMS) {
    if (it.answer === "guest") {
      assert.match(it.stops, /^(Normally nothing|Nothing)/, it.id);
    } else if (it.id === "hvc") {
      assert.match(it.stops, /^The CPU, by design/, it.id);
    } else {
      assert.match(it.stops, /^The CPU, because /, it.id);
    }
  }
  // Answers that depend on the in-kernel interrupt controller say so.
  assert.match(ITEMS.find((x) => x.id === "str-gic").handles, /in-kernel interrupt controller/);
  assert.match(ITEMS.find((x) => x.id === "wfi").note, /in-kernel interrupt controller/);
  // hvc and smc name their caller: from an app they never leave the guest.
  for (const id of ["hvc", "smc"]) assert.match(ITEMS.find((x) => x.id === id).plain, /^The guest kernel /);
});

test("step: place, move, unplace, reveal, hide, reset", () => {
  let s = initialState();
  assert.equal(sortedCount(s), 0);
  assert.equal(unsorted(s).length, 10);
  s = step(s, { type: "place", item: "ldr-ram", bucket: "vmm" });
  assert.equal(status(s, "ldr-ram"), "different");
  s = step(s, { type: "place", item: "ldr-ram", bucket: "guest" });
  assert.equal(status(s, "ldr-ram"), "same");
  assert.deepEqual(inBucket(s, "guest").map((i) => i.id), ["ldr-ram"]);
  assert.equal(sortedCount(s), 1);
  s = step(s, { type: "unplace", item: "ldr-ram" });
  assert.equal(status(s, "ldr-ram"), "unsorted");
  s = step(s, { type: "reveal" });
  assert.equal(s.revealed, true);
  s = step(s, { type: "hide" });
  assert.equal(s.revealed, false);
  s = step(step(s, { type: "place", item: "wfi", bucket: "kernel" }), { type: "reset" });
  assert.deepEqual(s, initialState());
});

test("step: unknown actions, items and buckets leave the state untouched", () => {
  const s = initialState();
  for (const a of [
    null,
    42,
    {},
    { type: "explode" },
    { type: "place", item: "nope", bucket: "vmm" },
    { type: "place", item: "wfi", bucket: "hardware" },
    { type: "place", item: "__proto__", bucket: "vmm" },
    { type: "unplace", item: "wfi" },
    { type: "hide" },
  ]) {
    assert.equal(step(s, a), s);
  }
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.placed));
});

test("feedback text names the learner's choice and the reference", () => {
  let s = step(initialState(), { type: "place", item: "wfi", bucket: "vmm" });
  assert.match(feedbackText(s, "wfi"), /^Different\. You chose: Stops and reaches our VMM\. The reference: Stops, but the macOS kernel handles it\./);
  s = step(s, { type: "place", item: "wfi", bucket: "kernel" });
  assert.match(feedbackText(s, "wfi"), /^Same as the reference/);
  assert.match(feedbackText(s, "hvc"), /^Not sorted yet/);
  assert.equal(feedbackText(s, "nope"), "");
});

test("share state: round trip, initial state clears, reference string", () => {
  assert.equal(encode(initialState()), null);
  const ref = referenceState();
  assert.equal(encode(ref), "gvkvgggvvk!");
  assert.deepEqual(decode("gvkvgggvvk!"), ref);
  let s = step(initialState(), { type: "place", item: "smc", bucket: "kernel" });
  assert.equal(encode(s), "-------k--");
  assert.deepEqual(decode(encode(s)), s);
  assert.deepEqual(decode("----------!"), { placed: Array(10).fill(null), revealed: true });
});

test("share state: anything not exactly the format decodes to null", () => {
  for (const bad of [null, undefined, 7, "", "gvkvgggvv", "gvkvgggvvkk", "gvkvgggvvk!!", "GVKVGGGVVK", "gvkvgggvvx", "gvkvgggvvk?", "<script>", "-".repeat(10000)]) {
    assert.equal(decode(bad), null, String(bad).slice(0, 20));
  }
});

test("shipped files obey the lab contract (LABS.md sections 1, 4 and 7)", () => {
  const dir = new URL("./", import.meta.url);
  const view = readFileSync(new URL("view.mjs", dir), "utf8");
  assert.match(view, /export function mount\(/);
  for (const f of ["model.mjs", "view.mjs", "style.css", "lab.json"]) {
    const src = readFileSync(new URL(f, dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bad of ["eval(", "new Function", "innerHTML", "http://", "https://", "localStorage"]) {
      assert.ok(!src.includes(bad), `${f} contains ${bad}`);
    }
  }
  const css = readFileSync(new URL("style.css", dir), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const sel of css.split("}").map((r) => r.split("{")[0].trim()).filter((s) => s && !s.startsWith("@"))) {
    for (const part of sel.split(",")) assert.ok(part.trim().startsWith('.lab[data-lab="trap-or-not"]'), `unscoped selector: ${part.trim()}`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), "style.css hard-codes a color");
  const meta = JSON.parse(readFileSync(new URL("lab.json", dir), "utf8"));
  assert.ok(meta.title && meta.goal);
});
