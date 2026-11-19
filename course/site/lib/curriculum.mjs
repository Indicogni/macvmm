// Parses course/CURRICULUM.md into the data model the site builder reads (course/chapters.json).
//
// CURRICULUM.md is the source of truth for chapter ids (00-27), slugs, parts, times, labs and
// primers. This module extracts them so the site never hand-copies that table: when the plan
// changes, `node course/site/gen-chapters.mjs` regenerates chapters.json and the build checks
// that the committed file is not stale.
//
// What is parsed (section numbers refer to CURRICULUM.md):
//   §5 "Overview" table            id, part, slug, title, stage, PLAN milestones, time
//   §5 "### Part X: Title"         part titles
//   §5 "#### NN `slug`: ..." entry the Lab, Prereqs and Concepts lines of each chapter
//   §2.1 Primers table             primer slugs, what they cover, which chapters need them
//   §8 "Labs, by priority"         the lab list and its priority tiers
// Anything the curriculum does not state (part URL slugs, primer display titles) is kept in the
// small tables below, in one place.

/** Short URL slugs per part. The curriculum names parts but does not give them URL slugs. */
export const PART_SLUGS = {
  "0": "start",
  I: "bare-machine",
  II: "memory",
  III: "cpu",
  IV: "devices",
  V: "interrupts",
  VI: "linux",
  VII: "virtio",
  VIII: "smp",
  IX: "firmware",
  X: "macos",
  XI: "production",
};

/** Display titles for primers; the curriculum table only gives slugs and what they cover. */
export const PRIMER_TITLES = {
  "os-basics": "OS basics: processes, memory, syscalls, interrupts",
  "codesign-entitlements": "Code signing and entitlements",
  smccc: "The SMC Calling Convention",
  "page-tables": "Page tables: stage-1 translation",
  "page-granules": "Page granules: 4 KiB and 16 KiB",
  "primecell-ids": "PrimeCell peripheral IDs",
  "arm64-boot-protocol": "The arm64 boot protocol",
  elf: "ELF64 in 20 minutes",
  "cpio-initramfs": "cpio and the initramfs",
  "efi-zboot": "EFI zboot kernels",
  "memory-ordering": "Memory ordering and barriers",
  "u-boot": "U-Boot",
  "aarch64-reading": "Reading AArch64: registers, instructions, byte order",
  "bare-metal-rust": "Bare-metal Rust: no_std, linker scripts, flat binaries",
  caches: "Caches and coherency",
  "reading-arm-specs": "Reading the ARM ARM and other primary specs",
  "host-concurrency": "Host concurrency: threads, locks, atomics",
  "unix-signals": "Unix signals and exit codes",
  "tty-termios": "TTYs, raw mode and escape sequences",
  "linux-boot-sequence": "What Linux does from entry to /init",
  "block-storage": "Block storage: disk images, ext4, durability",
  "unix-sockets": "Unix domain sockets",
  uefi: "UEFI in 25 minutes",
  "macos-sandbox": "The macOS sandbox and resource limits",
};

const PART_ORDER = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

function fail(msg) {
  throw new Error(`curriculum: ${msg}`);
}

/** Split a Markdown table row into trimmed cells. */
function cells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const unbacktick = (s) => s.replace(/^`|`$/g, "");

/** Return the lines of the section that starts at the heading matching `re`, up to the next heading of the same or higher level. */
function section(lines, re) {
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) fail(`section not found: ${re}`);
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Collect a "- **Label.** text" bullet including its indented continuation lines. */
function bullet(entryLines, label) {
  const i = entryLines.findIndex((l) => l.startsWith(`- **${label}.**`));
  if (i < 0) return null;
  const out = [entryLines[i].slice(`- **${label}.**`.length).trim()];
  for (let j = i + 1; j < entryLines.length && /^\s{2,}\S/.test(entryLines[j]); j++) out.push(entryLines[j].trim());
  return out.join(" ");
}

function hoursToMinutes(t) {
  const m = t.match(/([\d.]+)\s*h/);
  if (!m) fail(`cannot parse time "${t}"`);
  return Math.round(parseFloat(m[1]) * 60);
}

function chapterStatus(title) {
  if (/\bSTRETCH\b/.test(title)) return "stretch";
  if (/\bSHOULD\b/.test(title)) return "should";
  if (/post-v1/.test(title)) return "post-v1";
  return "core";
}

/**
 * Parse CURRICULUM.md text into { parts, chapters, primers, labs }.
 * Throws with a precise message when the document does not have the expected shape.
 */
export function parseCurriculum(text) {
  const lines = text.split("\n");

  // ---- §8 labs by priority -------------------------------------------------------------
  const labs = new Map();
  {
    const i = lines.findIndex((l) => l.startsWith("- **Labs, by priority.**"));
    if (i < 0) fail('"Labs, by priority" bullet not found in §8');
    let para = lines[i];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) para += " " + lines[j].trim();
    const tiers = [
      ["v1-core", /\*v1 core\*/],
      ["v1-optional", /\*v1 optional\*/],
      ["post-v1", /\*Post-v1:\*/],
    ];
    const marks = tiers.map(([k, re]) => [k, para.search(re)]).filter(([, p]) => p >= 0).sort((a, b) => a[1] - b[1]);
    marks.forEach(([tier, pos], n) => {
      const chunk = para.slice(pos, n + 1 < marks.length ? marks[n + 1][1] : undefined);
      for (const m of chunk.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`/g)) {
        if (!labs.has(m[1])) labs.set(m[1], { name: m[1], priority: tier, chapters: [], primers: [] });
      }
    });
    if (labs.size === 0) fail("no labs parsed from §8");
  }

  // ---- §2.1 primers ----------------------------------------------------------------------
  const primers = [];
  {
    const sec = section(lines, /^### 2\.1 Primers/);
    for (const l of sec) {
      if (!l.startsWith("| `")) continue;
      const [slug, covers, first, also] = cells(l);
      const s = unbacktick(slug);
      const minuteMatch = text.match(new RegExp("(\\d+)-minute `" + s.replace(/[-]/g, "\\-") + "`"));
      primers.push({
        slug: s,
        title: PRIMER_TITLES[s] || s,
        covers,
        first_required_by: (first.match(/\d\d/) || [null])[0],
        also_used_by: [...also.matchAll(/\b(\d\d)\b/g)].map((m) => m[1]),
        minutes: minuteMatch ? Number(minuteMatch[1]) : null,
        labs: [],
        file: `course/primers/${s}.md`,
        url: `primers/${s}/`,
      });
    }
    if (primers.length === 0) fail("no primers parsed from §2.1");
  }
  const primerSlugs = new Set(primers.map((p) => p.slug));

  // ---- §5 overview table -----------------------------------------------------------------
  const chapters = [];
  {
    const sec = section(lines, /^### Overview/);
    for (const l of sec) {
      if (!/^\| \d\d \|/.test(l)) continue;
      const [id, part, slug, title, stage, plan, time] = cells(l);
      chapters.push({
        id,
        part,
        number: null,
        slug: unbacktick(slug),
        title,
        status: chapterStatus(title),
        stage,
        plan,
        minutes: hoursToMinutes(time),
        runs: "mac",
        labs: [],
        primers: [],
        prereqs: [],
        file: `course/chapters/${part}/${id}-${unbacktick(slug)}.md`,
        url: null,
      });
    }
    if (chapters.length !== 28) fail(`expected 28 chapters in the §5 overview, found ${chapters.length}`);
    chapters.forEach((c, i) => {
      if (c.id !== String(i).padStart(2, "0")) fail(`chapter ids must run 00-27 in order; row ${i} is ${c.id}`);
    });
  }

  // ---- §5 part headings and per-chapter entries ------------------------------------------
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^### Part ([0IVX]+): (.+)$/);
    if (m) parts.push({ id: m[1], title: m[2].trim(), slug: PART_SLUGS[m[1]], chapters: [] });
  }
  for (const p of parts) if (!p.slug) fail(`no URL slug for part ${p.id}; add it to PART_SLUGS`);
  parts.sort((a, b) => PART_ORDER.indexOf(a.id) - PART_ORDER.indexOf(b.id));

  const byId = new Map(chapters.map((c) => [c.id, c]));
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#### (\d\d) `([^`]+)`: (.+)$/);
    if (!m) continue;
    const ch = byId.get(m[1]);
    if (!ch) fail(`entry for unknown chapter ${m[1]}`);
    if (ch.slug !== m[2]) fail(`chapter ${m[1]}: overview slug "${ch.slug}" differs from entry slug "${m[2]}"`);
    let end = i + 1;
    while (end < lines.length && !/^#{2,4} /.test(lines[end])) end++;
    const entry = lines.slice(i + 1, end);

    const lab = bullet(entry, "Lab") || "";
    for (const lm of lab.matchAll(/(ch\d\d's )?`([a-z0-9]+(?:-[a-z0-9]+)*)`(\s*\(in the `([a-z0-9-]+)` primer\))?/g)) {
      const [, borrowed, name, , inPrimer] = lm;
      if (!labs.has(name) || borrowed) continue;
      if (!ch.labs.includes(name)) ch.labs.push(name);
      const L = labs.get(name);
      if (!L.chapters.includes(ch.id)) L.chapters.push(ch.id);
      if (inPrimer && primerSlugs.has(inPrimer)) {
        if (!L.primers.includes(inPrimer)) L.primers.push(inPrimer);
        const P = primers.find((p) => p.slug === inPrimer);
        if (!P.labs.includes(name)) P.labs.push(name);
      }
    }
    ch.runs = ch.labs.length ? "mac+browser" : "mac";

    const pre = bullet(entry, "Prereqs") || "";
    // Only the leading id list ("18 (stress uses the disk), 12.") names chapters; later prose may cite others.
    const lead = pre.split(/[.;]\s|[.;]$/)[0];
    ch.prereqs = [...lead.matchAll(/\b(\d\d)\b/g)].map((x) => x[1]).filter((x) => byId.has(x) && x !== ch.id);

    const concepts = bullet(entry, "Concepts you'll need") || "";
    for (const pm of concepts.matchAll(/`([a-z0-9-]+)`/g)) {
      if (primerSlugs.has(pm[1]) && !ch.primers.includes(pm[1])) ch.primers.push(pm[1]);
    }
  }
  for (const p of primers) {
    for (const id of [p.first_required_by, ...p.also_used_by]) {
      const c = id && byId.get(id);
      if (c && !c.primers.includes(p.slug)) c.primers.push(p.slug);
    }
  }

  // ---- numbering and URLs ----------------------------------------------------------------
  for (const p of parts) {
    const mine = chapters.filter((c) => c.part === p.id);
    if (mine.length === 0) fail(`part ${p.id} has no chapters`);
    mine.forEach((c, k) => {
      c.number = `${p.id}.${k + 1}`;
      c.url = `${p.slug}/${c.slug}/`;
      p.chapters.push(c.id);
    });
  }
  for (const c of chapters) if (!c.url) fail(`chapter ${c.id} is in part ${c.part}, which has no "### Part" heading`);

  return {
    parts,
    chapters,
    primers,
    labs: [...labs.values()],
  };
}

/** Build the full chapters.json document (stable key order, so diffs stay readable). */
export function chaptersDocument(text) {
  const data = parseCurriculum(text);
  return {
    $comment:
      "GENERATED from course/CURRICULUM.md (§2.1, §5, §8) by course/site/gen-chapters.mjs. Do not edit by hand: edit CURRICULUM.md and regenerate.",
    course: {
      title: "Build a VMM from scratch on Apple Silicon",
      short_title: "Build a VMM",
      base: "/build-your-own/vmm/",
      origin: "https://indicogni.com",
      email: "feedback@indicogni.com",
    },
    ...data,
  };
}

export function serialize(doc) {
  return JSON.stringify(doc, null, 2) + "\n";
}
