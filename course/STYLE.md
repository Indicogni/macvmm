# macvmm Course Style Guide

Every lesson follows this guide. The goal: a reader who has never written a hypervisor finishes each chapter able to explain the idea to a friend and having a program that runs. Rigorous, but never cold.

## 1. Voice and person

- **We and you.** "We" is you and the reader building together ("we'll boot it"). "You" is the reader's hands ("you should see..."). "I" is rare, only for honest opinion ("I find this the least obvious part of the API").
- **Warm, direct, curious.** Write as a friend who has already fallen into every hole on this road. Admit confusion: "This name is terrible. Here's what it actually means."
- **Rigorous underneath.** Every claim is either true, or flagged as a simplification. Never hand-wave a mechanism; say "the details are in Chapter N" instead.
- **Humour is seasoning.** One dry joke per section at most, never at the reader's expense, never in place of an explanation.
- **Plain words.** Prefer "use" to "utilize", "start" to "instantiate". No "simply", "just", "obviously", "trivially". If it were obvious, they would not be reading.
- Present tense, active voice. No emojis.

## 2. Sentence rhythm

- Mix long and short. A long sentence that builds a mechanism, then a short one that lands it. Like this.
- Paragraphs: 2 to 5 sentences. One idea each. A one-sentence paragraph is allowed, as a drumbeat, not a habit.
- Lead with the point, then justify it.
- Questions are welcome when the reader would be asking them: "Why can't the guest just write to the disk directly?"
- Cut every sentence that exists only to announce the next one.

## 3. Opening a chapter

Open with a **concrete puzzle or failure**, never a definition. The reader should feel the itch before we scratch it.

Good openers: a program that crashes with a baffling error, a number that should be 1 but is 0, a guest that hangs with no output, a question ("Where does the keystroke go?").

Bad openers: "In this chapter we will learn about...", dictionary definitions, history lectures, a table of contents in prose.

Rules: the puzzle appears in the first 5 lines; it is reproducible by the reader when feasible; the chapter resolves it, and says so ("Remember the hang from the start? Here's the culprit.").

## 4. Introducing jargon: earn it

1. Show the **need** (a problem the reader has just felt).
2. Describe the thing in plain words.
3. **Only then** give the name, in bold on first use: "That hand-off is called a **VM exit**."
4. Use the term consistently afterwards. Never swap synonyms for variety.

Each term is defined once, where it is earned. Later chapters may add a one-clause reminder, not a re-definition. Acronyms are expanded on first use. Apple API names appear in `code font` and are introduced by what they do before how they are spelled.

## 5. Analogies policy

- **One strong analogy per concept**, introduced deliberately, used for a few sentences, then **dropped**.
- Always say **where it breaks**: "A VM exit is like a phone call to the front desk. Unlike a front desk, the hypervisor can also freeze the whole hotel while it thinks."
- No stacked metaphors, no analogy carried across chapters. Analogies are scaffolding; take them down once the building stands.
- If the real mechanism is simple enough, skip the analogy.

## 6. Code presentation

- **Small steps.** Never more than ~25 lines in a block. Build up: show the skeleton, then add one thing at a time, with the new lines obvious.
- **Always runnable.** Every code block either runs as shown or is explicitly marked as a fragment with the file it belongs to. Each step ends in a state that builds.
- **Say the command, then the expected output.** Every runnable step shows what the reader should see, in an output block, and what it means. If the output varies (addresses, timings), say which parts will differ.
- **Name the file** above each block (`Sources/macvmm/Boot.swift`).
- **Explain the surprising line, not every line.** Comments carry the why, not the what.
- **Show failure on purpose.** Sometimes break it first, so the fix is understood. Mark deliberate breakage clearly.
- Prefer real, small programs to snippets that cannot run. No pseudo-code unless labelled as such.
- Shell blocks: one command per line, no prompt characters.

## 7. Callouts vocabulary

Use exactly these, as blockquotes with the bold label. Do not invent new ones.

> **Predict.** Pause before running. Ask the reader to guess the output or behaviour; the answer follows in the next paragraph.

> **Try it.** An optional experiment: change a value, break something, observe. Always includes what to look for.

> **Aside.** Interesting but skippable: history, trivia, a naming story. Removing all Asides must leave the chapter whole.

> **Under the hood.** The honest, deeper mechanism behind something we simplified. Optional for first read, required for mastery.

> **Security.** A trust boundary, an attack the guest could attempt, or a rule from the project brief (never trust guest-controlled values; validate sizes, offsets, and addresses before use). Say what the attacker controls and what breaks.

> **Production note.** What real hypervisors do differently from our teaching version, and why we chose the simpler path.

Limits: at most one callout of each kind per section, and no more than ~5 callouts per chapter in total. Callouts never contain steps the reader must perform to continue (except Try it, which is optional by definition).

## 8. Length targets

- Chapter: **2,000 to 3,500 words** plus code (about 20 to 35 minutes reading, plus running time).
- Section: 300 to 700 words.
- One chapter, one main idea, one working artifact at the end.
- If a chapter wants to exceed 4,000 words, split it.

## 9. Headings

- `#` chapter title only, as a noun phrase or question that names the puzzle ("Why Did My Guest Stop?"), not "Introduction to X".
- `##` sections, `###` sparingly. Never deeper.
- Headings are sentence case, informative, and skimmable as a list: reading only the headings should tell the story.
- No numbering inside the chapter. Chapters are numbered by filename.

## 10. Diagrams

- Use a diagram when **space or time** is the point: memory layouts, who-talks-to-whom, ordering of events.
- Prefer small ASCII or Mermaid diagrams inline; one idea per diagram, 8 boxes at most.
- Every diagram has a one-line caption saying what to notice. Introduce it in prose before it appears; never let a diagram carry the explanation alone.
- Label arrows with verbs. Mark trust boundaries (guest vs host) wherever they appear.

## 11. Ending a chapter

Three parts, in this order, under the heading `## Checkpoint`:

1. **Checkpoint.** A short list: what now works, how to verify it (a command and expected output), and the git tag or file state the next chapter assumes.
2. **What's next.** Two or three sentences that create pull: name the new problem the next chapter solves, ideally one the reader has already glimpsed.
3. **One open question.** A single question we deliberately did not answer, which the reader can chew on. Not a quiz; a hook. ("We trusted the size the guest gave us. What if it lied?")

## 12. Before and after

**Topic: what is a VM exit.**

*Before (definition-first, jargon dumped):*

> A VM exit is a transition from guest mode to host mode that occurs when the guest executes a privileged or sensitive instruction or triggers an event configured to be intercepted by the hypervisor. The hypervisor then handles the exit reason and resumes the guest via a VM entry.

Problems: opens with the definition, three undefined terms, no reader, nothing to see or run.

*After (puzzle first, term earned, analogy dropped, rigor kept):*

> Our guest has printed nothing for ten seconds, and our host program is pegged at 0% CPU. Is the guest stuck, or are we? Look at the vCPU's run loop: it called "run" and never came back, so the guest is doing something. What happens when it needs something only we can give, like the keyboard? It stops. The processor freezes the guest mid-instruction and hands control back to our code, with a note saying why. That hand-off is a **VM exit**.
>
> Think of it as the guest picking up a phone to the front desk: it asks, waits, and carries on once we answer. Where the picture breaks: the guest doesn't choose to call. The hardware forces the call whenever the guest touches something we have fenced off, and the guest never knows it was paused.
>
> **Predict.** What does our run loop print when the guest writes to a device address that we have not mapped?

Note what changed: a felt problem, the name arriving late, one analogy with its seam shown, a reader in the room, and a question to answer by running code.

## 13. Final checklist (reviewer uses this)

- [ ] Opens with a puzzle or failure in the first 5 lines, and resolves it.
- [ ] Every term earned before named; defined once.
- [ ] At most one analogy per concept, with its limit stated.
- [ ] Every code block runs or is marked a fragment; expected output shown.
- [ ] Only the six callout labels; Security notes follow the project brief.
- [ ] Ends with Checkpoint, What's next, one open question.
- [ ] No banned words ("simply", "just", "obviously"); no emojis.

## Appendix A. The authoring kit: formats and commands

Everything here is checked by `scripts/check-lessons` unless it says otherwise. The exemplar that
follows every rule is `course/chapters/I/02-first-exit.md` with its companions
(`course/retrieval/02.md`, `course/journal/02.md`, `course/journal/02.rubric.md`, the
`course/captures/02-*.txt` files). When this appendix and the exemplar disagree, fix one of them.

### A.1 Commands

```sh
scripts/check-lessons 02          # one chapter by id (or: a lesson path; no argument: all lessons)
scripts/check-anchors             # every `:::code` reference and ANCHOR marker in the repo
cargo run -q -p xtask -- audit    # the security audit (forbidden advice, entitlements, unsafe)
scripts/capture.sh 02             # record the chapter's checkpoint runs (reference, real Mac)
scripts/capture-cmd [opts] course/captures/02-name.txt -- CMD ARGS...   # record any other run
```

`check-lessons` prints `LESSONS OK: …` or the errors; warnings (banned words, `chNN`, an acronym
not expanded near its first use, a lesson over 4,000 words) never fail it. Run all three checks
before you hand a chapter over.

**Capturing a run that needs a code change** (a deliberate break, a Try it variant): never edit
the reference. Copy the tree, edit the copy, and capture from it:

```sh
rsync -a --exclude target --exclude .cache --exclude .git ./ "$SCRATCH/ref02/"
# edit "$SCRATCH/ref02/crates/…", then:
scripts/capture-cmd --cwd "$SCRATCH/ref02" --timeout 10 \
  --show "cargo run -q -p macvmm -- first-exit" \
  --note "Deliberate breakage: <the exact edit, in one sentence>." \
  course/captures/02-no-hvc-hang.txt -- scripts/sign-and-run.sh target/debug/macvmm first-exit
```

Build the copy first (`cargo build -q -p macvmm` inside it). `--show` is the command as the learner
types it; every `--note` line says what differs from the reference, so the capture is honest about
what ran. `scripts/checkpoint.sh NN --impl "$SCRATCH/ref02"` runs a checkpoint against such a copy
without rebuilding the shared `target/` binaries that `--ref` relinks.

### A.2 What each chapter owns

| File | Format | Notes |
|---|---|---|
| `course/chapters/<part>/<NN-slug>.md` | A.3 | path from `course/chapters.json` |
| `course/retrieval/NN.md` | A.6 | 6 to 10 items about *this* chapter, used by later warm-ups |
| `course/journal/NN.md` | A.7 | copied to `learner/journal/NN.md` by `scripts/learner start NN` |
| `course/journal/NN.rubric.md` | A.7 | printed by the checkpoint after the journal passes |
| `course/captures/NN-*.txt` | A.8 | real runs only |
| the `## Chapter NN` section of `course/GLOSSARY.md` | A.9 | edit your own section only |
| `// ANCHOR:` markers in source files | `CLAUDE.md` | comment lines only; never change behaviour; 60 lines at most |

### A.3 Lesson layout

Blocks in this order (CURRICULUM section 7); headings are exact where shown:

```text
---                                   front matter (flat `key: value`; lists as [a, b])
title: <exactly the title in course/chapters.json>
part: I                               the part id from chapters.json
chapter: I.1                          the display number from chapters.json
id: 02
runs: mac+browser                     mac | browser | mac+browser
minutes: 330
prereqs: [01]
start_tag: ch-01                      the reference at the end of the previous chapter
labs: [exception-stepper, a64-encoder]
command: scripts/checkpoint.sh 02
expect: CHECKPOINT 02 PASS
---

:::retrieval                          the warm-up (A.6); omitted only in chapter 00

:::concepts                           "Concepts you'll need" (A.4)
...
:::

<opening puzzle: prose, first lines of the page, may hold a :::predict;
 one sentence names the ledger row this chapter closes (the word "ledger")>

:::objectives                         measurable verbs, never "understand"
- ...
:::

## <body sections, as many as the story needs>
   :::predict, :::code, :::term, :::lab, callouts, **Deliberate breakage N: …** paragraphs,
   one :::stopping-point between sittings, a "Your turn" section

## Checkpoint
:::checkpoint                         renders command and expect from the front matter
:::term source=captures/NN-....txt    the expected output, a real capture
What now works (a short list; it is the page's recap)
### What's next
### Open question                     the transfer journal question, ending with "?"

## Spec hunt                          2 or 3 list items: a primary source by section or
- ...?                                register name, and the question it answers
```

The page title is rendered from `title:`, so the body has no `#` heading; headings stop at `###`.
Program code appears only as `:::code anchor=NAME file=PATH` (both arguments); fences are for
shell commands (`sh`), output and ASCII diagrams (`text`). Every terminal output is a
`:::term source=captures/…` line, never pasted text. Raw HTML, including comments, is not allowed
(the renderer escapes it).

### A.4 The Concepts box

Five groups, as list items with these exact bold labels, in this order (write "none" for an empty
group):

```text
:::concepts
- **Core, taught here:** ...
- **Core, from earlier:** ... (chapter NN)
- **Primers (read first):** `slug` (what it gives you); `slug` (...)
- **Primers (review):** `slug` (...)             optional; at least one primer group
- **Pointers:** ... each becomes an Aside or a linked sentence in the body
- **Forward definitions:** ... each defined in a sentence where it first appears, with "chapter NN"
:::
```

A primer the chapter *requires* is its backticked slug, outside parentheses; it must exist in
`course/primers/`. A primer merely linked for the curious is named in plain words ("the ELF
primer"). Backticked words inside parentheses are descriptions, not primers.

### A.5 Predict, callouts, breaks and sittings

- **Predict** is always a block: `:::predict <the question>` on one line, the reveal as its body,
  closed by `:::`. Never a `> **Predict.**` blockquote.
- **Callouts** are STYLE section 7 blockquotes: `> **Try it.**`, `> **Aside.**`,
  `> **Under the hood.**`, `> **Security.**`, `> **Production note.**`. No other labels; at most about
  five per chapter. A callout holds prose only: a `:::code` or `:::term` it needs goes on its own
  line directly after the blockquote.
- **Deliberate breakage** (CURRICULUM section 3.7) is a paragraph starting
  `**Deliberate breakage N: <what to change>.**`, followed by the Predict prompt, the captured run,
  and the three-line debrief: what you saw, the misconception it exposes, the tool that finds it.
- **Two sittings**: one `:::stopping-point <label>` line between the halves.

### A.6 Retrieval banks

`course/retrieval/NN.md` holds 6 to 10 items that test *use* of chapter NN, not recall of names.
Later lessons' warm-ups draw from it.

```text
# Retrieval 02: <chapter title>

## R1
Q: A VM exit reports the syndrome `0x5a00002a`. Which instruction stopped the guest?
A: <the answer, with the reasoning a learner can check>
```

Items are `## R1`, `## R2`, … in order, each with one `Q:` line then one `A:` line (continuation
lines are allowed). In the lesson, `:::retrieval` renders three items: one each from the banks of
chapters N-1, N-3 and N-7; a source that does not exist is replaced by the nearest earlier
chapter not yet used (chapter 02 draws from 01, then 00, then 01 again). `:::retrieval from=01,00`
overrides the sources.

### A.7 Journal and rubric

`course/journal/NN.md` is the learner's template; follow `course/journal/02.md`:

```text
# Journal NN: <chapter title>

<!-- one comment saying how it is checked and that nothing is uploaded -->

## Predict                                 when checkpoint.toml says predict = true

> <the Predict fork, as a question>

<!-- Write your guess here BEFORE you run it, then what you saw. -->

## Q1

> *Observe (evidence: <where the evidence comes from>).* <one question>
...
## Qn

> *Transfer, the open question (evidence: ...).* <the lesson's open question>
```

Questions are ordered observe, mechanism, transfer; a park question says "Park, answered in
chapter NN". The count must equal `questions` in `course/checkpoints/NN/checkpoint.toml`. The
prompts are learner-facing: no author notation (A.10). `course/journal/NN.rubric.md` has the
same headings, `# Rubric NN: <chapter title>`, and under each a list of the *ideas* a strong
answer contains (from `course/reviews/socratic.md` Part B, corrected by CURRICULUM section 5),
never model prose.

### A.8 Captures

Names are `course/captures/NN-<words>.txt` (lowercase, digits, dashes), plus
`NN-<words>.trace.jsonl` for trace files; NN is the chapter that first shows it. Every `.txt`
starts with a `# ` provenance line, which both tools write:

```text
# scripts/capture-cmd 02: real output, Apple M5 Pro, macOS 27.2.1, commit dad6c99, 2026-11-20.
# <--note lines: what differs from the reference>
# Regenerate with scripts/capture-cmd (course/STYLE.md appendix A); never edit by hand.
$ <the command as the learner types it>
exit: 0                     or: exit: none (stopped by --timeout 10 s: still running)
--- stdout ---
--- stderr ---
```

`scripts/capture.sh NN` owns the files named after a checkpoint run (`NN-<run>.txt`, header
`# scripts/capture.sh NN: …`); `capture-cmd` refuses to overwrite them. Paths are replaced by
`<repo>`, `<tree>` and `~`, and a capture that would still contain your login name is refused.
In prose, say "we checked this on a real Mac" and show the capture; when nothing can be captured,
say "we have not been able to check this".

### A.9 The glossary

`course/GLOSSARY.md` has `# Glossary`, an introduction, `## Primers`, then `## Chapter 00` to
`## Chapter 27`. An entry is one line:

```text
- **VM exit**: The moment the guest stops and our VMM runs, because the guest did something HVF forwards to us.
- **ESR** (Exception Syndrome Register): The register that records *why* an exception happened.
```

The bold term is the anchor (`#vm-exit`; lowercase, other characters become `-`); the expansion
is for acronyms only; the definition is one sentence or two, ending with a full stop, using only
glossary words or everyday programming words. A term goes in the section of the chapter that
earns it (a term only forward-defined there goes where its full story is). Primer entries end
with "Taught in `slug`." Link a term's first use on a page as
`[VM exit](/build-your-own/vmm/glossary/#vm-exit)`; the lint checks every such link resolves.
The lint also uses the expansions: the first plain-text use of an acronym on a page should have
its expansion within a couple of lines.

### A.10 Learner-facing notation

Author notation never reaches a lesson, journal, rubric or retrieval bank. The lint fails on:

| Author form | Write instead |
|---|---|
| `[V]` | "we checked this on a real Mac", plus what ran (a capture) |
| `[U]` | the captured observation, or "we have not been able to check this" |
| `M4`, `K11`, `R12` (milestone and risk IDs) | nothing; say what the thing is |
| `L1`, `L2`, `L3` | "contract tests", "runs on your Mac", "journal" |
| `§`, "architecture §3", PLAN, CURRICULUM, review names | a learner page, a primer, or a spec section |
| `ch05` (a warning) | "chapter 05" |

"Apple M4" and "L1 cache" are fine. Code shown through `:::code` is the reference's own text and is
not checked; prefer anchors whose comments a learner can read.
