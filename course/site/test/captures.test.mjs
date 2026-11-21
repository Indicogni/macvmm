// Terminal captures: the provenance header rule, line ends, and escaping of guest output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCapture, classify, renderCapture, renderTrace } from "../lib/captures.mjs";

const CAP = `# scripts/capture-cmd 02: real output, Apple M5 Pro, macOS 27.2.1, commit dad6c99, 2026-11-20.
# Deliberate breakage: one edit.
# Regenerate with scripts/capture-cmd (course/STYLE.md appendix A); never edit by hand.
$ cargo run -q -p macvmm -- first-exit
exit: 0
--- stdout ---
first-exit: pc=0x40000008

--- stderr ---
`;

test("all leading # lines are provenance, never transcript", () => {
  const c = parseCapture(CAP);
  assert.equal(c.provenance, "real output, Apple M5 Pro, macOS 27.2.1, commit dad6c99, 2026-11-20");
  assert.deepEqual(c.notes, [{ text: "Deliberate breakage: one edit." }]);
  assert.ok(!c.lines.some((l) => l.startsWith("#")));
  const html = renderCapture(CAP, "course/captures/02-x.txt");
  assert.ok(!html.includes("Regenerate"), "author instructions are dropped");
  assert.match(html, /captured: real output, Apple M5 Pro/);
  assert.match(html, /<li>Deliberate breakage: one edit.<\/li>/);
});

test("a wrapped capture.sh header joins its continuation and loses internal references", () => {
  const c = parseCapture('# scripts/capture.sh 00: run "doctor" of course/checkpoints/00, captured from the reference\n# on real hardware. Regenerate with scripts/capture.sh 00; never edit by hand (CURRICULUM §3.6).\n$ x\n');
  assert.equal(c.provenance, 'run "doctor" of checkpoint 00, captured from the reference on real hardware');
  assert.deepEqual(c.notes, []);
});

const CAPDIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "captures");
const real = (name) => readFileSync(join(CAPDIR, name), "utf8");

test("a note that starts in lower case stays a separate note, not part of the provenance", () => {
  const c = parseCapture(real("10-dtc-dts.txt"));
  assert.match(c.provenance, /^real output, Apple M5 Pro, macOS [\d.]+, commit [0-9a-f]+, \d{4}-\d\d-\d\d$/);
  assert.deepEqual(c.notes, [{ text: "v.dtb is the file the run in 10-dtb-out-run wrote." }]);
  const html = renderCapture(real("10-dtc-dts.txt"), "s");
  assert.match(html, /<span>captured: real output[^<]*\d<\/span>/);
  assert.match(html, /<li>v\.dtb is the file/);
});

test("a typed command line and the note after it are not glued together", () => {
  const c = parseCapture(real("17-hvc0-4k.txt"));
  assert.equal(c.notes.length, 2);
  assert.match(c.notes[0].text, /poweroff -f$/);
  assert.equal(c.notes[1].text, "count=1: one 4096-byte write to /dev/hvc0.");
});

test("an indented header block is one verbatim script, and the note after it stays separate", () => {
  const c = parseCapture(real("00-guest-is-a-process.txt"));
  const script = c.notes.find((n) => n.pre);
  assert.ok(script, "the script is a pre block");
  assert.equal(c.notes.filter((n) => n.pre).length, 1);
  const sl = script.text.split("\n");
  assert.equal(sl[0], "set -euo pipefail");
  assert.equal(sl.at(-1), 'rm -f -- "$log"');
  assert.ok(sl.length >= 10);
  assert.match(c.notes.at(-1).text, /^ps -M prints a header line/);
  const html = renderCapture(real("00-guest-is-a-process.txt"), "s");
  assert.match(html, /<li class="term__script"><pre tabindex="0" data-scroll-label="Capture script"><code>set -euo pipefail\nlog=/);
  assert.match(html, /rm -f -- &quot;\$log&quot;<\/code><\/pre><\/li><li>ps -M prints/);
});

test("a capture without a header is an error", () => {
  assert.throws(() => parseCapture("$ ls\n"), /provenance/);
});

test("\\r\\n and a trailing literal \\x0d end a line; other escapes stay visible", () => {
  const c = parseCapture("# p\r\n$ boot\r\nBooting Linux\\x0d\nmenu\\x08\\x08 x\n");
  assert.deepEqual(c.lines, ["$ boot", "Booting Linux", "menu\\x08\\x08 x"]);
  const html = renderCapture("# p\n$ boot\nmenu\\x1b[0m\n", "s");
  assert.match(html, /<span class="ctl">\\x1b<\/span>\[0m/);
});

test("lines are classified; empty sections are dropped", () => {
  const rows = classify(["$ cmd", "exit: 0", "--- stdout ---", "out", "", "--- stderr ---"]);
  assert.deepEqual(rows.map((r) => r.kind), ["cmd", "exit", "sec", "out"]);
});

test("guest output is escaped: a capture can never inject markup", () => {
  const evil = '# p\n$ run\n<script>alert(1)</script><img src=x onerror="alert(2)">&amp;\n';
  const html = renderCapture(evil, 'cap"<x>');
  assert.ok(!/<script>|<img/i.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;&amp;amp;/);
  assert.match(html, /cap&quot;&lt;x&gt;/);
  const t = renderTrace('{"a":"<b>"}\n', "t", null, null);
  assert.ok(!t.includes("<b>"));
});

test("the prompt is not part of the copied command", () => {
  const html = renderCapture(CAP, "s");
  assert.match(html, /<span class="cmd"><span class="prompt" aria-hidden="true">\$ <\/span>cargo run/);
  assert.match(html, /data-copy="cmd"/);
});

test("every real capture parses and renders", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "captures");
  const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
  assert.ok(files.length > 100);
  for (const f of files) {
    const html = renderCapture(readFileSync(join(dir, f), "utf8"), f);
    assert.ok(!html.includes("Regenerate with"), f);
    assert.ok(!/CURRICULUM|§/.test(html.match(/<footer[\s\S]*<\/footer>/)[0]), `${f}: internal reference in the footer`);
  }
});
