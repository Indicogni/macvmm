#!/usr/bin/env node
// Regenerates course/chapters.json from course/CURRICULUM.md. No dependencies.
//   node course/site/gen-chapters.mjs          write the file
//   node course/site/gen-chapters.mjs --check  exit 1 if the committed file is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chaptersDocument, serialize } from "./lib/curriculum.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const courseDir = join(here, "..");
const src = join(courseDir, "CURRICULUM.md");
const dst = join(courseDir, "chapters.json");

const out = serialize(chaptersDocument(readFileSync(src, "utf8")));
if (process.argv.includes("--check")) {
  const cur = existsSync(dst) ? readFileSync(dst, "utf8") : "";
  if (cur !== out) {
    console.error("course/chapters.json is stale: run node course/site/gen-chapters.mjs");
    process.exit(1);
  }
  console.log("course/chapters.json is up to date.");
} else {
  writeFileSync(dst, out);
  const d = JSON.parse(out);
  console.log(`Wrote course/chapters.json: ${d.parts.length} parts, ${d.chapters.length} chapters, ${d.primers.length} primers, ${d.labs.length} labs.`);
}
