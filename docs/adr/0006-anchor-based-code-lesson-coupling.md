# ADR-0006: Lessons embed real code through anchors

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** `CLAUDE.md` "Code ↔ lesson coupling", `course/site/DESIGN.md` §§ on `:::code`, `course/CURRICULUM.md` §3.6

## Context

The course quotes the reference implementation constantly. Code pasted by hand drifts silently
as soon as the implementation changes. We need lessons to show the *current, tested* code, and
the build to fail when a referenced snippet disappears.

## Decision

1. **Source markers.** A region is delimited by a line containing `ANCHOR: <name>` and a later line
   containing `ANCHOR_END: <name>`, both in the same file. Use the file's comment syntax:
   - `// ANCHOR: name` in Rust, C, JS and Swift
   - `# ANCHOR: name` in shell, TOML, Python and linker scripts
   - `<!-- ANCHOR: name -->` in Markdown and HTML

   Names match `^[a-z][a-z0-9_]*$`. Prefix them with the module, for example `esr_decode_data_abort`
   or `queue_pop_avail` (snake_case, as in DESIGN.md's `fdt_begin_node`). Names are unique
   **within a file** and *should* be unique repo-wide. Anchors may nest, but may not overlap
   partially.
2. **Lesson reference:** `:::code anchor=<name> file=<repo-relative path>`. Extraction:
   - takes the lines strictly between the markers;
   - drops any nested marker lines;
   - removes common leading indentation;
   - records the path and the first and last line numbers for the "view source" link.
3. **Checking.** `scripts/check-anchors` is a thin wrapper around `cargo xtask check-anchors`.
   It fails on:
   - a referenced file or anchor that does not exist;
   - an unterminated or duplicate anchor;
   - an `ANCHOR_END` without a start;
   - an empty region;
   - an anchor region longer than 60 lines (lessons must quote small pieces).

   It warns, without failing, on anchors that no lesson references. The site builder implements the
   same rules in JS (`course/site/lib/anchors.mjs`). `crates/xtask/tests/anchors.rs` is the test
   corpus both implementations must agree on, exported as `course/site/labs/vectors/anchors.json`.
4. **Ownership.** Anchors are part of the public surface of the code:
   - Renaming or deleting one requires updating the lessons in the same change.
   - `scripts/check.sh` runs `check-anchors`. The same tool also validates the
     `// LEARNER: <hole>` … `// LEARNER_END: <hole>` markers that scaffold generation uses (M27).
   - Each milestone in `docs/PLAN.md` lists the anchors it must create, so lesson authors can
     write in parallel.
5. **Never paste code into lessons by hand.** Anything that needs to be shown must be anchored.
   Captured terminal output is the one exception. It comes from `scripts/capture.sh` on real
   hardware, and is never hand-edited.

## Consequences

- Lessons can't silently drift from the code, though prose explaining an anchor can still go
  stale. Lesson review covers that.
- Some code layout choices are driven by teachability: small functions, one idea per anchor.
  This is acceptable and intended.
- Marker comments are visible in the source. They are short, and readers of a teaching codebase
  benefit from seeing where the lessons attach.

## Alternatives considered

- **Line ranges (`file.rs#L10-L40`).** Rejected: they break on any edit above the range.
- **mdBook `{{#include file:anchor}}` directly.** We use the same marker syntax deliberately, so
  mdBook-literate tools work, but our site builder is custom (DESIGN.md).
- **Doc-tests as the source.** Rejected: most snippets are not standalone examples.
