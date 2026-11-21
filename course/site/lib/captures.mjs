// Terminal captures: course/captures/NN-name.txt -> the terminal-output block of DESIGN.md §3.2.
//
// A capture is a real run recorded by scripts/capture-cmd or scripts/capture.sh (STYLE.md A.8):
//
//   # scripts/capture-cmd 02: real output, Apple M5 Pro, macOS 27.2.1, commit dad6c99, 2026-11-20.
//   # <note lines: what differs from the reference>
//   # Regenerate with scripts/capture-cmd (course/STYLE.md appendix A); never edit by hand.
//   $ cargo run -q -p macvmm -- first-exit
//   exit: 0
//   --- stdout ---
//   ...
//   --- stderr ---
//   ...
//
// Rule (DESIGN.md §9): ALL leading `#` lines are provenance, never transcript. The first becomes
// the `captured:` footer, note lines are shown under it (each one separately; an indented block
// stays verbatim), and the "Regenerate with" line (an instruction to authors) is dropped.
// Line ends: "\r\n" and a trailing literal `\x0d` (how the capture tool writes a guest's
// carriage return) both end a line. Other `\xNN` escapes the tool
// wrote for control bytes stay visible, styled as escapes. Everything is HTML-escaped: a capture
// holds guest output, and guest output is hostile input.

import { esc } from "./html.mjs";

/**
 * Split a capture into { provenance: string, notes: Note[], lines: string[] }, where a Note is
 * { text } (one prose line) or { pre: true, text } (an indented block kept verbatim).
 *
 * Header rules (DESIGN.md §9):
 *   - the first `#` line is the provenance; only it may wrap, and only while it has not ended in
 *     sentence punctuation (the older capture.sh header ends its first line mid-sentence);
 *   - every later line is its own note and is never joined to another: a note that starts in
 *     lower case ("v.dtb is ...", "count=1: ...") is still a separate sentence;
 *   - lines indented after the `#` (`#   set -euo pipefail`) are a verbatim script or listing:
 *     consecutive ones form one block, kept exactly, never joined or re-flowed.
 */
export function parseCapture(text) {
  const all = String(text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (all.at(-1) === "") all.pop();
  let i = 0;
  const header = [];
  while (i < all.length && all[i].startsWith("#")) header.push(all[i++]);
  if (header.length === 0) throw new Error("capture has no `# ` provenance line (STYLE.md A.8)");
  const lines = all.slice(i).map((l) => l.replace(/(?:\\x0d)+$/i, "").replace(/\r$/, ""));

  const tidy = (h) => h
    .replace(/\s*Regenerate with\b.*$/, "") // author instruction, not provenance
    .replace(/\bcourse\/checkpoints\/(\d+)/g, "checkpoint $1")
    .trim();
  let prov = header[0].replace(/^#\s?/, "");
  let k = 1;
  while (k < header.length && !/[.:;!?]\s*$/.test(prov) && /^#\s?[a-z]/.test(header[k]) && !/^#\s{2,}/.test(header[k])) {
    prov += ` ${header[k].replace(/^#\s?/, "")}`;
    k++;
  }
  const provenance = tidy(prov).replace(/^scripts\/capture(?:-cmd|\.sh)\s+\d+:\s*/, "").replace(/\.$/, "");
  if (provenance === "") throw new Error("capture provenance is empty");

  const notes = [];
  for (; k < header.length; k++) {
    const raw = header[k];
    if (/^#\s{2,}\S/.test(raw)) {
      const block = [];
      while (k < header.length && /^#\s{2,}\S/.test(header[k])) block.push(header[k++].slice(1));
      k--;
      const indent = Math.min(...block.map((b) => b.length - b.trimStart().length));
      notes.push({ pre: true, text: block.map((b) => b.slice(indent)).join("\n") });
      continue;
    }
    const t = tidy(raw.replace(/^#\s?/, ""));
    if (t !== "") notes.push({ text: t });
  }
  return { provenance, notes, lines };
}

/** Escape a transcript line and mark tool-written `\xNN` escapes. */
function renderText(s) {
  return esc(s).replace(/\\x[0-9a-fA-F]{2}/g, (m) => `<span class="ctl">${m}</span>`);
}

/**
 * Classify transcript lines: `$ cmd` (what the learner types), `exit: N`, section markers, and
 * output. Empty stdout/stderr sections are dropped, and so are the blank separator lines the
 * capture tool writes before a section marker or a command (the program never printed them).
 */
export function classify(lines) {
  const out = [];
  const dropBlankTail = () => { while (out.length && out.at(-1).kind === "out" && out.at(-1).text.trim() === "") out.pop(); };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const sec = l.match(/^--- (stdout|stderr) ---$/);
    if (sec) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "" ) j++;
      const nextIsSection = j >= lines.length || /^--- (stdout|stderr) ---$/.test(lines[j]) || /^\$ /.test(lines[j]);
      if (nextIsSection) { i = j - 1; continue; }
      dropBlankTail();
      out.push({ kind: "sec", text: sec[1] });
      continue;
    }
    if (/^\$ /.test(l)) { dropBlankTail(); out.push({ kind: "cmd", text: l.slice(2) }); }
    else if (/^exit: /.test(l)) out.push({ kind: "exit", text: l });
    else out.push({ kind: "out", text: l });
  }
  dropBlankTail();
  return out;
}

/** Render a parsed capture as the terminal figure. `source` is shown in the footer. */
export function renderCapture(text, source) {
  const cap = parseCapture(text);
  const rows = classify(cap.lines).map((r) => {
    switch (r.kind) {
      case "cmd": return `<span class="cmd"><span class="prompt" aria-hidden="true">$ </span>${renderText(r.text)}</span>`;
      case "exit": return `<span class="meta">${renderText(r.text)}</span>`;
      case "sec": return `<span class="meta sec">--- ${r.text} ---</span>`;
      default: return `<span class="out">${renderText(r.text)}</span>`;
    }
  });
  const hasCmd = rows.some((r) => r.startsWith('<span class="cmd">'));
  const notes = cap.notes
    .map((n) => (n.pre ? `<li class="term__script"><pre tabindex="0" data-scroll-label="Capture script"><code>${renderText(n.text)}</code></pre></li>` : `<li>${renderText(n.text)}</li>`))
    .join("");
  return (
    `<figure class="term">` +
    `<figcaption><span class="term__label">Terminal</span>` +
    (/\breal (?:output|hardware)\b/i.test(cap.provenance) ? `<span class="term__real">Real output</span>` : "") +
    (hasCmd ? `<button class="copy" type="button" data-copy="cmd" aria-label="Copy the command">Copy</button>` : "") +
    `</figcaption>` +
    `<pre data-scroll-label="Terminal output"><code>${rows.join("")}</code></pre>` +
    `<footer class="term__foot"><span>captured: ${renderText(cap.provenance)}</span>` +
    (notes ? `<ul class="term__notes">${notes}</ul>` : "") +
    `<span class="term__src">${esc(source)}</span></footer>` +
    `</figure>`
  );
}

/**
 * Render a trace file (`NN-name.trace.jsonl`, one JSON record per exit) written by a captured
 * run. It has no header of its own: its provenance is the run's capture, `runSource`.
 */
export function renderTrace(text, source, runSource, runText) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  let prov = "";
  if (runText) {
    try { prov = parseCapture(runText).provenance; } catch { prov = ""; }
  }
  return (
    `<figure class="term term--trace"><figcaption><span class="term__label">Trace file</span><span>JSON lines, one record per exit</span></figcaption>` +
    `<pre data-scroll-label="Trace file"><code>${lines.map((l) => `<span class="out">${renderText(l)}</span>`).join("")}</code></pre>` +
    `<footer class="term__foot">` +
    (runSource ? `<span>written by the captured run ${esc(runSource)}${prov ? `; captured: ${renderText(prov)}` : ""}</span>` : "") +
    `<span class="term__src">${esc(source)}</span></footer></figure>`
  );
}
