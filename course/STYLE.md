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
