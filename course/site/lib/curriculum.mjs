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
//
// Required versus linked primers. A chapter *requires* a primer when the chapter's "Primers (read
// first)" group names it, when it is the primer's "First required by" chapter, or when it appears
// in "Also used by" with no qualifier. It only *links* a primer when "Also used by" qualifies the
// chapter ("02 (one link)", "04 (seed)", "00 (doctor line)"; section 2.1 says such a chapter
// "does not require it") or when the primer is named elsewhere in the Concepts box (a pointer or
// a forward definition). Chapters carry `primers` (required) and `primers_linked`; primers carry
// `required_by` and `linked_from`, and `also_used_by` keeps the table's full list.

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

/**
 * Display titles for primers; the curriculum table only gives slugs and what they cover. Each
 * must equal the `title:` in course/primers/<slug>.md (test/curriculum.test.mjs checks this), so
 * the site's lists, the sidebar and the primer page itself all name a primer the same way.
 */
export const PRIMER_TITLES = {
  "os-basics": "OS basics: processes, memory, syscalls, interrupts",
  "codesign-entitlements": "Code signing and entitlements",
  smccc: "SMCCC: the calling convention for calls to a higher level",
  "page-tables": "Page tables: stage-1 translation",
  "page-granules": "Page granules: 4 KiB and 16 KiB",
  "primecell-ids": "PrimeCell peripheral IDs",
  "arm64-boot-protocol": "The arm64 boot protocol",
  elf: "ELF: the file the linker hands you",
  "cpio-initramfs": "cpio and the initramfs",
  "efi-zboot": "EFI zboot: the kernel that is also a program",
  "memory-ordering": "Memory ordering and barriers",
  "u-boot": "U-Boot: the firmware we run first",
  "aarch64-reading": "Reading AArch64: registers, instructions, byte order",
  "bare-metal-rust": "Bare-metal Rust: no_std, linker scripts, flat binaries",
  caches: "Caches and coherency",
  "reading-arm-specs": "Reading the ARM ARM and other primary specs",
  "host-concurrency": "Host concurrency: threads, locks, atomics",
  "unix-signals": "Unix signals: who decides how a program ends",
  "tty-termios": "TTYs, termios and escape sequences: who owns your keystrokes",
  "linux-boot-sequence": "The Linux boot sequence",
  "block-storage": "Block storage: disk images, ext4, durability",
  "unix-sockets": "Unix domain sockets: a wire between two programs, named by a file",
  uefi: "UEFI: the interface between firmware and an OS loader",
  "macos-sandbox": "The macOS sandbox, rlimits and other one-way doors",
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
      // The reading time sits in the paragraph under the table: "30-minute `os-basics`".
      const minuteMatch = text.match(new RegExp("(\\d+)-minute `" + s.replace(/[-]/g, "\\-") + "`"));
      if (!minuteMatch) fail(`primer ${s}: no "NN-minute \`${s}\`" reading time under the §2.1 table`);
      const firstId = (first.match(/\b\d\d\b/) || [null])[0];
      if (!firstId) fail(`primer ${s}: "First required by" names no chapter`);
      // "02 (one link), 05, 26": an id followed by a parenthesis is only linked, not required.
      const uses = [...also.matchAll(/\b(\d\d)\b(\s*\()?/g)].map((m) => ({ id: m[1], qualified: Boolean(m[2]) }));
      primers.push({
        slug: s,
        title: PRIMER_TITLES[s] || fail(`primer ${s} has no display title; add it to PRIMER_TITLES`),
        covers,
        first_required_by: firstId,
        also_used_by: uses.map((u) => u.id),
        required_by: [firstId, ...uses.filter((u) => !u.qualified).map((u) => u.id)],
        linked_from: uses.filter((u) => u.qualified).map((u) => u.id),
        minutes: Number(minuteMatch[1]),
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
        primers_linked: [],
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
  // Only §5 holds the part headings and chapter entries; other sections may quote them.
  const ch5 = section(lines, /^## 5\. /);
  const parts = [];
  for (const l of ch5) {
    const m = l.match(/^### Part ([0IVX]+): (.+)$/);
    if (!m) continue;
    if (parts.some((p) => p.id === m[1])) fail(`part ${m[1]} has two "### Part" headings`);
    parts.push({ id: m[1], title: m[2].trim(), slug: PART_SLUGS[m[1]], chapters: [] });
  }
  for (const p of parts) if (!p.slug) fail(`no URL slug for part ${p.id}; add it to PART_SLUGS`);
  parts.sort((a, b) => PART_ORDER.indexOf(a.id) - PART_ORDER.indexOf(b.id));

  const byId = new Map(chapters.map((c) => [c.id, c]));
  const primerBySlug = new Map(primers.map((p) => [p.slug, p]));
  const linkLab = (L, slug) => {
    if (!L.primers.includes(slug)) L.primers.push(slug);
    const P = primerBySlug.get(slug);
    if (!P.labs.includes(L.name)) P.labs.push(L.name);
  };
  const seen = new Set();
  for (let i = 0; i < ch5.length; i++) {
    const m = ch5[i].match(/^#### (\d\d) `([^`]+)`: (.+)$/);
    if (!m) continue;
    const ch = byId.get(m[1]);
    if (!ch) fail(`entry for unknown chapter ${m[1]}`);
    if (seen.has(ch.id)) fail(`chapter ${ch.id} has two entries in §5`);
    seen.add(ch.id);
    if (ch.slug !== m[2]) fail(`chapter ${m[1]}: overview slug "${ch.slug}" differs from entry slug "${m[2]}"`);
    let end = i + 1;
    while (end < ch5.length && !/^#{2,4} /.test(ch5[end])) end++;
    const entry = ch5.slice(i + 1, end);

    // "**Lab.** `a` ... `b` (in the `p` primer) ... ch06's `c` ... that the `q` primer also embeds."
    // Backticked words that are not lab names (instructions, flags) are skipped; a lab another
    // chapter owns ("ch06's `c`") is not this chapter's.
    const lab = bullet(entry, "Lab");
    if (lab === null) fail(`chapter ${ch.id} has no **Lab.** line`);
    if (!/^None\b/.test(lab)) {
      const firstName = (lab.match(/`([^`]+)`/) || [])[1];
      if (!firstName || !labs.has(firstName)) {
        fail(`chapter ${ch.id}: the **Lab.** line starts with "${firstName}", which is not in the §8 lab list`);
      }
    }
    let lastLab = null;
    const labRe = /(ch\d\d's )?`([a-z0-9]+(?:-[a-z0-9]+)*)`(\s*\(in the `([a-z0-9-]+)` primer\)|\s+primer also embeds)?/g;
    for (const lm of lab.matchAll(labRe)) {
      const [, borrowed, name, tail, inPrimer] = lm;
      if (tail && !inPrimer && primerSlugs.has(name) && lastLab) {
        linkLab(lastLab, name); // "... that the `uefi` primer also embeds"
        continue;
      }
      if (!labs.has(name) || borrowed) continue;
      if (!ch.labs.includes(name)) ch.labs.push(name);
      const L = labs.get(name);
      lastLab = L;
      if (!L.chapters.includes(ch.id)) L.chapters.push(ch.id);
      if (inPrimer) {
        if (!primerSlugs.has(inPrimer)) fail(`chapter ${ch.id}: lab ${name} is "in the ${inPrimer} primer", which §2.1 does not list`);
        linkLab(L, inPrimer);
      }
    }
    ch.runs = ch.labs.length ? "mac+browser" : "mac";

    const pre = bullet(entry, "Prereqs") || "";
    // Only the leading id list ("18 (stress uses the disk), 12.") names chapters; later prose may cite others.
    const lead = pre.split(/[.;]\s|[.;]$/)[0];
    ch.prereqs = [...lead.matchAll(/\b(\d\d)\b/g)].map((x) => x[1]).filter((x) => byId.has(x) && x !== ch.id);

    // The Concepts box is a bullet of "- *Group:* ..." sub-bullets. Primers named in the
    // "Primers (read first)" group are required; a primer named in any other group (a pointer,
    // a forward definition, "byte order, from `aarch64-reading`") is only linked.
    const concepts = bullet(entry, "Concepts you'll need") || "";
    for (const group of concepts.split(/(?=- \*[^*]+:\*)/)) {
      const required = /^- \*Primers\b/.test(group);
      for (const pm of group.matchAll(/`([a-z0-9-]+)`/g)) {
        if (!primerSlugs.has(pm[1])) continue;
        const list = required ? ch.primers : ch.primers_linked;
        if (!list.includes(pm[1])) list.push(pm[1]);
      }
    }
  }
  for (const id of byId.keys()) if (!seen.has(id)) fail(`chapter ${id} is in the §5 overview but has no "#### ${id}" entry`);
  for (const p of primers) {
    for (const id of p.required_by) {
      const c = byId.get(id);
      if (!c) fail(`primer ${p.slug} names chapter ${id}, which does not exist`);
      if (!c.primers.includes(p.slug)) c.primers.push(p.slug);
    }
    for (const id of p.linked_from) {
      const c = byId.get(id);
      if (!c) fail(`primer ${p.slug} names chapter ${id}, which does not exist`);
      if (!c.primers_linked.includes(p.slug)) c.primers_linked.push(p.slug);
    }
  }
  // Required wins: a primer one source links and another requires is required.
  for (const c of chapters) c.primers_linked = c.primers_linked.filter((s) => !c.primers.includes(s));
  for (const L of labs.values()) {
    if (L.chapters.length === 0) fail(`lab ${L.name} is in §8 but no chapter's **Lab.** line names it`);
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
