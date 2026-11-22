// Consistency checks for course/primers/*.md against course/chapters.json (generated from
// CURRICULUM.md section 2.1) and the content model of DESIGN.md section 9.
// Run: node --test 'course/site/**/*.test.mjs'
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFrontMatter } from "../lib/frontmatter.mjs";

const courseDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COURSE = JSON.parse(readFileSync(join(courseDir, "chapters.json"), "utf8"));
const LABS = new Set(COURSE.labs.map((l) => l.name));
const CONTAINERS = new Set(["objectives", "prereqs", "predict", "callout", "concepts"]);
const LEAVES = new Set(["code", "term", "diagram", "lab", "checkpoint", "retrieval", "stopping-point"]);

const primers = COURSE.primers.map((meta) => {
  const text = readFileSync(join(courseDir, "primers", `${meta.slug}.md`), "utf8");
  return { meta, ...parseFrontMatter(text) };
});

test("every primer file is in chapters.json, and the other way round", () => {
  const files = readdirSync(join(courseDir, "primers")).filter((f) => f.endsWith(".md") && f !== "README.md");
  assert.deepEqual(files.map((f) => f.replace(/\.md$/, "")).sort(), COURSE.primers.map((p) => p.slug).sort());
});

for (const { meta, data, body, bodyLine } of primers) {
  test(`primer ${meta.slug}: front matter`, () => {
    assert.equal(data.slug, meta.slug);
    assert.equal(data.kind, "primer");
    assert.equal(data.title, meta.title);
    assert.equal(Number(data.minutes), meta.minutes, "minutes must match CURRICULUM section 2.1");
    assert.ok(!("lab" in data), "use `labs: [...]`, not `lab:`");
    assert.ok(Array.isArray(data.labs), "`labs` is a list (`labs: []` when there is none)");
    for (const l of data.labs) assert.ok(LABS.has(l), `unknown lab ${l}`);
    // chapters.json (CURRICULUM section 2.1) is the one source for which chapters use a primer,
    // and the :::objectives box is the one list of objectives: the front matter repeats neither.
    assert.deepEqual(data.required_by, [meta.first_required_by], "`required_by` is [the first chapter that needs it], as in CURRICULUM");
    for (const k of ["also_used_by", "objectives"]) assert.ok(!(k in data), `drop \`${k}:\` from the front matter (the page uses chapters.json and the :::objectives box)`);
    for (const l of meta.labs) assert.ok(data.labs.includes(l), `CURRICULUM puts lab ${l} in this primer`);
  });

  test(`primer ${meta.slug}: directives`, () => {
    const lines = body.split("\n");
    let open = null;
    let fence = false;
    const count = {};
    const embedded = [];
    lines.forEach((line, i) => {
      const where = `line ${bodyLine + i}`;
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      if (fence) return;
      const m = line.match(/^:::([a-z-]*)(?:\s+(.*))?$/);
      if (!m) return;
      const [, name, rest = ""] = m;
      if (name === "") {
        assert.ok(open, `${where}: ":::" closes nothing (leaf directives such as :::lab take no closer)`);
        open = null;
        return;
      }
      assert.ok(CONTAINERS.has(name) || LEAVES.has(name), `${where}: unknown directive :::${name}`);
      count[name] = (count[name] || 0) + 1;
      if (name === "lab") embedded.push(rest.trim().split(/\s+/)[0]);
      if (CONTAINERS.has(name)) {
        assert.equal(open, null, `${where}: :::${name} opened inside :::${open}`);
        open = name;
      }
    });
    assert.equal(open, null, `:::${open} is never closed`);
    assert.equal(count.objectives, 1, "exactly one :::objectives");
    assert.equal(count.prereqs, 1, "exactly one :::prereqs (the Prerequisites box)");
    assert.deepEqual([...new Set(embedded)].sort(), [...data.labs].sort(), "front matter `labs` and the :::lab directives agree");
  });

  test(`primer ${meta.slug}: says "exit status", not "exit code"`, () => {
    // os-basics names the chapters' word once, on purpose, to bridge the two.
    const hits = body.split("\n").filter((l) => /\bexit codes?\b/i.test(l) && !l.includes("*exit code*"));
    assert.deepEqual(hits, []);
  });
}
