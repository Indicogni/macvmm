# Course backlog (after Phase 3, chapters 00-25)

Triage of every chapter's `problems` and `open_issues`, the course-infra review, the per-Part
consistency passes and the final gate from the Phase 3 run. Duplicates are merged: the source
column lists every chapter that raised the item. Each item has one line.

Severity: **blocker** = must be fixed before the course is published; **should** = fix before or
soon after publishing; **nice** = polish.

State re-checked on 2026-11-20 against the working tree (`ls`, `grep`, `scripts/check-lessons`,
`scripts/check-anchors`). Items found already resolved are listed at the end, not in the backlog.

**Left out on purpose (being fixed now by other tracks):** checkpoint 20 (missing) and
checkpoint 24 (no `[hints]`); the harness's `L1 contract` / `L2 run` / `L3 journal` labels in
checkpoint output and captures (raised by 00-08, 12, 13, 17); internal IDs in comments of anchored
code (02, 03, 06, 15, 17, 19, 23, 24); the CURRICULUM drift on retrieval-bank file names
(`NN.toml` vs `NN.md`), the glossary source (CONCEPTS §4 vs GLOSSARY.md) and the VM/370 "five
strategies"; the verifier failures of chapters 03 (Device memory clause), 06 (IDs in
`vmm_vcpu_struct`) and 19 (word count, `0600` comments, IDs in shown code).

## 1. Site builder and labs (owner: course/site)

- **fixed** (was blocker) (02, final) · `build.mjs`, `md.mjs`, `svg.mjs`, `serve.mjs` do not exist, so nothing renders · implement the DESIGN §9 contract: `:::concepts`, `:::retrieval [from=]`, `:::stopping-point`, leaf-vs-container grammar, STYLE callout variants, glossary page from GLOSSARY.md, capture header as `captured:` footer. · **Done:** `course/site/build.mjs` (+ `lib/md.mjs`, `lib/anchors.mjs`, `lib/captures.mjs`, `lib/svg.mjs`, `lib/checks.mjs`, `serve.mjs`, templates, CSS, `course.js`, `labs.js`, `wrangler.jsonc`) builds 108 pages into `course/site/dist/`; `--check` fails on broken links/fragments, missing assets, CSP and contrast; `node --test course/site/` and the `--check` build run in `scripts/check.sh`. DESIGN §7, §9, §10 updated to the as-built rules.
- **fixed** (was blocker) (02, 09, 10, 11, 12) · DESIGN §9 says only the first `# ` line of a capture is provenance; STYLE A.8 and every capture use 3-5 `#` lines, so author notes would render as transcript · pick one rule (recommend: all leading `#` lines are header) and make DESIGN, STYLE and the renderer agree. · **Done:** all leading `#` lines are header in DESIGN §9, STYLE A.8 and `lib/captures.mjs`: the first is the `captured:` footer, notes are listed under it, wrapped header sentences are joined, "Regenerate with ..." is dropped; `test/captures.test.mjs` renders every real capture and checks no footer leaks `CURRICULUM`/`§`.
- **fixed** (was should) (final, 00-25) · Only `course/site/labs/vectors/` exists; no lab component is built · build the labs in CURRICULUM §8 order; each lesson already carries a text fallback except chapter 15 (see chapters). · **Done:** all 35 v1 labs are built under `course/site/src/labs/`; every `:::lab` line in chapters 00-25 and the primers mounts the real lab, each lab has `/labs/<name>/`, and the labs index lists the 35 (the two post-v1 labs, `snapshot-diff` and `rsp-decoder`, sit under "Planned with later chapters" with a page that says so, and no longer raise a "not built" warning). `test/build.test.mjs` ("integration: ...") checks all of it. Chapter 00 and the `memory-ordering` primer no longer say their labs are unpublished.
- **should** (01, 12, 19, 20, 24, 25) · No spec in LABS.md/DESIGN.md for `trap-or-not`, `irq-lifecycle`, `frame-dissector`, `smp-boot-timeline`, `vmapple-map`, `hostile-guest` · write specs from the lesson fallbacks (each chapter's open issue describes the intended steps). · **`vmapple-map` done:** spec in LABS.md's lab list (CURRICULUM ch24 **Lab** line plus the lesson's fallback, which the lab reproduces exactly). · **`smp-boot-timeline` built:** its spec is its row in LABS.md section 9.
- **should** (00) · `toy-vmm` counts in the lesson (13 / 3 / 3 interventions in modes D / E / H; mode H traps only the console range by default, since real hardware keeps a virtual interrupt mask instead of trapping the interrupt switch) come from the lesson's own listing · when building, run exactly that listing (kernel 0x00, handler 0x10, app 0x20, base 0x40/limit 0xAF) and confirm the mode D/E reading; then quote mode D from `lab.json`.
- **should** (01) · `trap-or-not` must use the lesson's 10 items and its bucket names, not CURRICULUM's "handled by hardware or HVF" · build to the lesson table.
- **fixed** (was should) (07) · DESIGN §8.3 `mmio-trap` example stores to 0x0b00_0000, which is the test device window chapter 07 introduces · use an unmapped hole such as 0x0c00_0000. · **Done:** DESIGN §8.3 now says 0x0c00_0000; the lab's unmapped example is mmio-poke's real store to 0x0c00_0000 (the `hole` program), and `model.test.mjs` checks it.
- **fixed** (was should) (09) · `pl011-poke` must reproduce capture `09-poke.txt` (reset, write DR, IMSC=0x10, host pushes `ok`, ICR=0x70, three DR reads) · built: the lab's default walk is that sequence, and `src/labs/pl011-poke/model.test.mjs` compares its table with the capture byte for byte.
- **should** (15, 17) · `virtqueue-visualizer` and `virtio-status` need the 10-minute toy mode and "driver misbehaves" presets; CURRICULUM's rng preset is in no spec · add both modes; decide on the rng preset or drop it from CURRICULUM. · **`virtqueue-visualizer` half done:** built with the toy mode (chapter 15's eight steps, 3 exits) and a hostile mode of 17 driver misbehaviours plus ten scenarios; its request menu includes an entropy (rng) request, a single 64-byte writable buffer. Review fixes: chapter 16's embed now opens on the full ring, and hostile mode has an "avail.idx moves backwards (an index wrap)" item, so chapter 16 line 131 ("add a request ... try a loop in `next`, an address outside RAM and an index wrap") works as written; if the chapter owner prefers, that sentence can also point at the "Indices crossing 65535" scenario for the honest wrap. `virtio-status` and the CURRICULUM rng-preset decision remain.
- **should** (07) · The `esr-decoder` fallback text is built from DESIGN §8.1's preset, not a capture · regenerate the fallback once the lab exists.
- **fixed** (was should) (12, 13, 14, 21) · Captures show a visible `\x0d` at the end of every Linux/U-Boot line · treat `\r\n` as a line end in the renderer (or in xtask `capture.rs`). · **Done:** in the renderer: `\r\n` and a trailing literal `\x0d` both end a line; other `\xNN` escapes stay visible, styled as escapes.
- **fixed** (was should) (18) · `blk_features_offer` contains the nested anchor `blk_device_features` · the renderer must strip nested `ANCHOR` / `ANCHOR_END` marker lines. · **Done:** `lib/anchors.mjs` mirrors `xtask/src/anchors.rs` (nested ANCHOR and LEARNER marker lines dropped, dedent, all error kinds); `test/anchors.test.mjs` carries the Rust corpus and resolves every `:::code` in the lessons. Line numbers shown are the source file's.
- **fixed** (was should) (infra verify) · `chapters.json` passes CURRICULUM "covers" text through unchanged, including `[V]`, `[H]`, `(new)`, "(v2's Appendix B, now required)" · strip author notes in `gen-chapters.mjs` or never render that field. · **Done:** `cleanCovers` in `lib/curriculum.mjs` (evidence tags with their parentheses, `(new)`, `(v2's ...)`, `chNN` to "chapter NN"); `chapters.json` regenerated. The site also strips `(SHOULD)`, `STRETCH`, `(post-v1)` from chapter titles and shows a status badge.
- **fixed** (was nice) (22) · `22-freebsd-boot.txt` and `22-loader-lsefi.txt` each have one very long line (boot menu with `\x08`) · wrap or truncate long capture lines. · **Done:** terminal blocks wrap (`pre-wrap`, `overflow-wrap: anywhere`); nothing is truncated.

## 2. Harness and learner tooling (owner: xtask, scripts/, checkpoints)

- **fixed** (was blocker) (02, 06, 08, 09, 10, 11, 13, 15, 16) · `scripts/learner start NN` at the default level errors for every chapter except 00 and 04: `start.rs:103-107` calls `list_files` on `course/scaffolds/NN/files`, which does not exist (read from the code, not run) · treat a missing scaffold directory as empty (copy the journal only), and add a test. · **Done:** run for real, `list_files` already returned an empty list for a missing directory, so `start 06` worked; the rule is now explicit (`start::scaffold_files`): no `files/` means journal only, and `start` prints "chapter NN has no scaffold files (only its journal); write the code from the lesson" (true on a repeat `start` too, and the count line says "1 file"/"N files"); only a *missing* `files/` means journal only, any other error reading it (permission denied, I/O) is reported with its path; a `manifest.toml` without generated `files/` (or a `files` that is not a directory) is reported as a course bug instead of a silent empty copy. Tests: `start_without_a_scaffold_copies_only_the_journal`, `start_with_a_manifest_but_no_files_is_a_course_bug`, `start_reports_an_unreadable_scaffold`, `plural_agrees_with_the_count`, `real_course_starts_every_chapter` (every chapter 00-25 at its default level against the real tree); also checked by hand with `scripts/learner init` + `start 00/06/04/21` in a throwaway `learner/`.
- **should** (06, 08, 09, 10, 11, 13, 16, 21) · CURRICULUM §4 puts 06-12 at the Completion stage, but only scaffolds 00 and 04 exist · add `// LEARNER:` regions and run `gen-scaffold` for 06-12; give 21's scaffold a `docs/adr/` directory.
- **fixed** (was should) (04) · `course/scaffolds/04/files/` lacks the new anchor comment lines (comment-only drift) · rerun `cargo xtask learner gen-scaffold 04`. · **Done:** no change needed: `gen-scaffold` drops `ANCHOR` lines by design (scaffold.rs), and `cargo xtask learner gen-scaffold 04 --check` reports `SCAFFOLD OK: 04: 5 files, 3 holes, current`.
- **should** (01) · Chapter 01 offers a fallback (move the HvError half into a completion scaffold) and `course/scaffolds/01` does not exist · create it if the lead picks that fallback (see word counts).
- **fixed** (was should) (00, 01, 02, 09, 10, 11, 12) · `scripts/capture.sh` writes the header "(PLAN M27; CURRICULUM §3.6)"; 57 captures carry `CURRICULUM §3.6` · reword the header to learner-safe provenance and re-capture. · **Done:** the generator (`checkpoint/run.rs`) now writes "never edit by hand (course/STYLE.md appendix A)", the same wording as `capture-cmd`; the 57 existing headers were updated to that exact line (header only, no output touched), so a re-capture produces the same header.
- **should** (01, 06, 11, 12) · Stale captures: `01-doctor*.txt` (old header), `06-regcheck.txt` / `06-self-fault.txt` (old load address), `11-timer-nogic.txt` (no `stats: rlimit` line), `12-irq.txt` / `12-timer.txt` (old header) · rerun `scripts/capture.sh 01 06 11 12` when relinking shared binaries is safe.
- **should** (02) · `02-try-lsl-imm.txt` and `02-checkpoint.txt` are not referenced by the lesson · delete the orphan or reference it.
- **fixed** (was should) (00) · `scripts/setup.sh` prints milestone IDs ("needed from M15") on Macs missing an optional tool · print chapter numbers instead. · **Done:** prints "needed from chapter 10/18/22" (dtc, e2fsprogs, xz) and "needed by course authors only" (shellcheck); the `SC-14`/`SC-3`/`SC-5`/`SC-10` tags were also dropped from learner-visible messages in `setup.sh`, `fetch.sh` and `lib/common.sh`; `scripts/learner --help` and `scripts/checkpoint.sh --help` no longer print "PLAN M27; CURRICULUM §…". Later sweep: the `(SC-2)` tag in the fetch manifest reject message, the `(PLAN M27)` in the `learner/.progress.toml` header (test: the header passes `lessons::notation_problems`), and the `M1`/`M3` milestone labels in the `check_gate` anchor of `scripts/check.sh` (now "the FFI oracle"/"the test guests") are gone too.
- **fixed** (was should) (04) · `checkpoints/04/checkpoint.toml` `[hints].spec` says "Threat model MEM-2, MEM-3, MEM-6", which `scripts/learner hint 04` prints · reword in learner terms; sweep all `[hints]` for IDs. · **Done:** already reworded; a sweep of every `[hints]` table found no internal IDs.
- **fixed** (was should) (13) · Learners copy `checkpoints/13/contract/bootplan.rs`, whose line 1 says "Checkpoint 13 contract (L1)" · reword contract-file headers learners copy (sweep all `contract/` files). · **Done:** header blocks of all contract files swept (45 files, comments only): no `(L1)`/`PLAN M27 L1`, `PLAN Mnn`, `CURRICULUM chNN`, `architecture §`, `PLAN §`, risk IDs (`R3`, `R9`, `F8`) or threat-model IDs in the headers; threat-model citations now point to `docs/security/threat-model.md`. Threat-model IDs further down in test bodies (e.g. `// --- MEM-2: overflow ---` section comments in `04/contract/memory_hostile.rs`) remain; the `checkpoint.toml` line-1 comments still say "CURRICULUM §5".
- **should** (infra verify) · `check-lessons` and the node primer tests do not catch plan IDs (M9) or `[U]`/`[V]`/`[H]` markers in primers, captures or checkpoint hints · extend the lint to those files.
- **should** (02, 06, 14) · `scripts/learner break` (CURRICULUM §3.7) and `course/breaks/` do not exist; lessons have learners edit by hand · implement it or remove it from CURRICULUM §3.7 and the ch14 breaks.
- **should** (23) · The harness can only build and run macvmm; chapter 23's test is `tools/vz-mac/test.sh` · add a run kind for a non-macvmm command (and, with the checkpoint 24 fix, a `features` key for `experimental-vmapple`).
- **should** (19) · Chapter 19's checkpoint needs two VMs at once (B listening before A starts) · confirm the new `checkpoints/19` really runs both, or add a multi-process step.
- **fixed** (was should) (00) · CURRICULUM §4.1 runs `scripts/learner init` after ch00, but the ch00 journal needs `learner/` · move init before ch00 in the journey, or have init copy `journal/00.md`. · **Done:** no change needed: CURRICULUM §4.1 row 2 and chapter 00 "Before you start" now run `learner init` then `learner start 00`.
- **should** (04, 05, 09, 12) · The learner's guest path (`{guests}` = `../target/guests/aarch64-unknown-none/release` from `learner/`) was never checked against a real learner tree · run the 03/04/09/12 commands from a fresh `learner/` and fix paths in one pass.
- **should** (22, 25) · STYLE appendix A rsync recipe uses `--exclude learner`, which also drops `crates/xtask/src/learner` · change to `--exclude /learner` and add a learner-tree copy variant for chapter 25's plants.
- **fixed** (was nice) (01) · `check-lessons` flags `ch20` inside the Rust book URL `ch20-01-unsafe-rust.html` (01-ffi.md:237) · skip URLs in the chNN rule. · **Done:** `lessons::strip_urls` blanks `http(s)://` targets before the style rules; test added in `tests/lessons.rs`. A `(...)` inside a URL (Wikipedia-style `..._(computing)`) stays part of it, and the blanking is one space per character so columns stay right after a non-ASCII URL.
- **nice** (06, 12, 16, 19) · The lint's word count (code spans stripped, tables in) differs from `wc -w` by 600-900 words; 06, 12 and 16 sit at 3,990-3,999 · state the metric in STYLE §8 so authors can check it.
- **nice** (18, 23) · Typed-session captures needed ad-hoc helpers (fifo typing, `kill -9`, `ps` during a run) kept in a scratchpad · add `capture-cmd --stdin` (and a kill/ps hook) so they can be regenerated.
- **nice** (02) · `check.sh` now lints every lesson, so one author's in-progress lesson fails the shared gate · note in the authoring kit: run `scripts/check-lessons NN` before handing over.

## 3. Chapters, by number (owner: chapter authors)

- **fixed** (was blocker; dates and DOIs re-checked 2026-11-21, and each timeline row cites its source) (00) · Timeline dates (CP-40/67, VM/370 1972, VMware 1999, Denali 2002, Xen 2003, VT-x 2005, AMD-V 2006, NPT/EPT, ARMv7 VE 2010, ARMv8 2011) and the Popek-Goldberg / Adams-Agesen DOIs were not checked against primary sources · check each and cite.
- **nice** (00) · Line 158 says the VMM delivers "clock ticks included" but the toy has no timer · add one clause that no interrupt arrives in this run.
- **nice** (00) · Mode F ("each new block") and mode G (HCALL's r1) cannot be traced exactly on paper · pin both down when the lab lands.
- **nice** (00) · The `checkpoint: implementation <tree>/learner` line and the word "threads" (line 59) are not explained · add a clause each.
- **should** (01) · The trap-or-not feedback row for the store to 0x0900_0000 gives away most of journal Q1 · shorten the row so the learner still writes the answer.
- **should** (01) · Which framework Parallels Desktop and VMware Fusion use is unverified (the lesson says so) · check vendor docs, then state it or drop it.
- **nice** (01) · Line 225 "the course also adds learner/crates/hvf/build.rs" reads as provided; line 209 declares modules before their files exist · say "add", and "it builds once all three files exist".
- **nice** (01) · The `vm_create_call` / `vm_destroy_unsafe` SAFETY comments name types the learner lacks (VmBuilder, OwnedMapping) · add chapter-01-sized anchors or one sentence of warning.
- **nice** (01) · Rustonomicon FFI chapter and Cargo book build-scripts chapter are named without links · add the links.
- **should** (02) · Line 202 hedges why a vCPU is tied to its thread; journal Q4 and its rubric state it as fact; the first use of "thread" (line 125) has no forward pointer · make both hedged (or both cited) and point to chapter 20 / host-concurrency.
- **nice** (02) · "volatile read" is undefined; `vcpu_regs` is shown before `reg_ids` defines `Reg`; the 16 KiB page forward definition omits "chapter 04 says why" · fix the three.
- **should** (04) · Contract tests use `GuestMemoryOrdered` (frozen at ch16) and `RomRegion`/`TeardownAction` (ch21) · lead decides: move those cases to checkpoints 16/21 or accept and update CURRICULUM's "no ordered accessors yet".
- **should** (04) · `course/examples/04-hoist.rs` (one `unsafe`, outside the workspace and the audit) is a new home for lesson code · lead confirms the directory or names another; make the audit cover it.
- **nice** (04) · If chapter 03's learner loader ends up unchecked, add a sentence pointing back to it from the wrapped-address demo.
- **should** (05) · Checkpoint 05's contract tests items the lesson barely shows (RESERVED_INTIDS, gicr_size, 64 KiB alignment, TEST_GUEST_BASE - RAM_BASE = DTB_MAX_TEST_GUEST) · teach them or trim the contract.
- **nice** (05) · "PC" (line 106) and "vCPU" (line 168) are not expanded on this page; the Your-turn answer sits in the same paragraph (line 140) · expand both; collapse the answer.
- **should** (06) · Line 286 still says `insn at pc:` waits for chapter 21; chapter 07 teaches it (verified present) · change to chapter 07.
- **nice** (06) · "every dump shows 0x30000180" but self-fault shows 0x30000182; VBAR_EL1 expanded only at line 227; "chapter 05's `esr_fields`" should be `esr_header_fields` · fix the three.
- **should** (07) · No anchor shows chapter 07's own behaviour (stop on ISV=0); `run_loop` / `exit_pc_rules` include arms from chapters 11, 20, 24; `Exit`'s `Display` is required by the contract but not shown · add chapter-07-sized anchors (`exit_display` etc.).
- **nice** (07) · Line 239's `insn at pc: not readable` lacks the reference suffix "(the pc does not translate to RAM)"; isv0-probe is not fully identity-mapped · note both.
- **should** (07, 08) · Chapter 07 depends on `esr_sysreg_access` / `esr_decode_sysreg` added by the chapter 08 author · freeze those names (they are now shared).
- **should** (08) · Checkpoint 08's contract tests the CPU_ON/CPU_OFF/AFFINITY_INFO state machine; learners pass via `learner lifeline vmm::psci` (flow not run) · move those tests to checkpoint 20 (being written now) or accept the lifeline explicitly.
- **nice** (08) · Capitalised "Under the hood" after a semicolon (line 185); CPU_ON/CPU_OFF/AFFINITY_INFO named before PSCI (line 256) · fix wording.
- **should** (09) · "declare hv_vcpus_exit as in chapter 01" (chapter 01 never does); `vm_control_register` not shown; the `is_stopping` check before each run is only implied · fix the reference, embed the anchor, state the check.
- **should** (03, 09) · Chapter 03 line ~290 says "chapter 20 builds stopping on it", but chapter 09 builds the kick · point chapter 03 at chapter 09.
- **nice** (09) · `TestIrq` "records every change" (it records level changes only); `lock()` / `kick()` in `kick_all_vcpus` unexplained; lint warns `lock-order` / `ansi-filter` have no `:::lab` · reword, add a sentence, confirm the primers embed those labs.
- **should** (09, 10, 14) · `HostIo` appears in `machine_device_tree` and chapter 14 calls it "chapter 09's HostIo", but chapter 09 never names it · introduce it in chapter 09 (or one clause in 10's skip list).
- **nice** (10) · Line 324 asks for a 0600, no-follow `--dtb-out` file without saying how in Rust · name `OpenOptionsExt::mode` + `custom_flags(libc::O_NOFOLLOW)`.
- **should** (11) · `ExitStats` (`log.stats`, `record`, `kind`, KINDS names) is never shown, though chapter 07 deferred it to 11; `crate::sync::lock` and the `nogic`/`nogic_kick` fields are not listed · add an anchor or a short spec.
- **nice** (12) · The redistributor-creation-order Aside rests on an old finding not re-run · re-run it and capture, or keep the hedge.
- **nice** (13) · The sha256-pinning Aside does not link `docs/security/threat-model.md`; sitting B is dense (raw 5,103 words) · add the link; consider trimming sitting B.
- **should** (14) · Objective 5 (exit cost of 64 KiB of console output) has no journal question or checkpoint check · add a journal Q-slot.
- **should** (14) · KASLR sentence says every trace shares pc 0xffff800080041338; only one does · say the captures share the unrandomised 0xffff8000_8xxx_xxxx base.
- **should** (14, all) · Ctrl-C at a guest prompt goes to the guest shell in raw mode, not to macvmm · sweep all chapters for "Ctrl-C quits the VM" wording.
- **nice** (14) · Cite chapter 09 for the `gicr-unused` RAZ/WI device; explain `exit: 1` from `grep -c` in `14-gic-mmio.txt`; expand DABT · fix the three.
- **fixed** (was blocker; both labs exist) (15, final) · Lines 83 and 260 send learners to `virtqueue-visualizer` and `virtio-status` with no paper fallback, and neither lab exists · add text fallbacks like chapters 00 and 10.
- **nice** (15) · Public-path list omits `Queue`, `QueueProgress`, `VirtioDevice`, `VirtioError`; Queue API list omits `max_size()`, `GuestAddress` returns, `Clone`, `Display`, `VirtioInterrupt::status()` · add them.
- **nice** (16) · `FromLeBytes` is called "chapter 04's" but chapter 04 never names it in prose · add a one-line gloss.
- **should** (14, 15, 17) · CURRICULUM's ch15 cites "one exit per PL011 byte"; chapter 17 measured two (flag read + data write) · use the measured number in 14, 15 and 17.
- **nice** (17) · Commands in "Bytes or buffers?" and "Exits per kilobyte" do not say "from the repository root"; objective "make it the Linux console hvc0" is never done (`console=hvc0`) · add the phrase; drop or do the objective.
- **should** (18) · Line 108 explains BLK-/VQ- labels only "in the comments", but `18-locked.txt` shows `BLK-8` in program output · say "comments and messages" (until the message is fixed, see section 5).
- **nice** (18) · `checkpoints/18/checkpoint.toml` comment says "Your turn step 4"; copying tests is now step 3 · fix the comment.
- **nice** (20) · Line 296 runs plain `sample macvmm 1`; the capture was filtered · give the grep, or tell learners to search for `3Bus` and `4sync4lock`.
- **should** (21) · Line 30 says the learner reproduces the exit-3 stop in sitting B, but their VMM already has the ISV=0 path by then · name the one-line revert or drop the claim.
- **should** (21) · Objective 1 says "five rarer families"; line 100 lists six · count them the same way.
- **should** (21) · Every U-Boot run prints `Bloblist at 0 not found (err=-2)` and `alloc space exhausted ptr 400 limit 0` and the lesson never says they are harmless · add a sentence.
- **nice** (21) · Four code blocks run 35-40 lines; `insn_decode_pair` cites "C6.2" before ARM ARM sections are explained; BADDR/RES0 undefined; ADR objective not checked; misconception "firmware is a black box" never stated · trim or annotate.
- **should** (22) · Breakage 2 says "chapter 14's cargo run line", which has no `--disk` and never exercises virtio-blk · say chapter 18's vda line for breakage 2.
- **nice** (22) · Expand SME2; link OSLAR_EL1 to chapter 08 · fix both.
- **should** (24) · ADR-0009 limits what may be published; the lesson publishes distinct IPA counts, per-boot access counts and PSCI names · lead confirms these are within D4.
- **nice** (24) · The "reset storm" guard is defined inline; no earlier chapter teaches it · move a definition to chapter 08 or 21.
- **should** (25) · Your turn item 4 has no recipe for copying the learner's tree; the `virtqueue_race_only` Try it never shows its command · add both command lines.
- **nice** (25) · MMU (line 280), CLI (line 72) and UNDEF (line 258) unexpanded; the sandbox self-test command uses repo paths, not `learner/` · expand; add the `../` note.

### Primers (owner: primer authors)

- **fixed** (was blocker) (infra verify) · `efi-zboot.md` lines 403, 405, 527, 562 name plan milestone "M9" (verified present) and are stale (`Image-virt` now exists) · rewrite in learner terms against the current `fetch.sh linux`.
- **fixed** (was blocker) (infra verify) · `macos-sandbox.md` teaches and uses `[H]`/`[V]`/`[U]` markers (9 hits), which the hard rules forbid in learner text · reword, or add an explicit STYLE exception.
- **fixed** (was blocker) (08) · `smccc.md` line 311 says "spike results #5 and #6" (verified present) · cite a capture instead.
- **should** (19) · `unix-sockets.md` "How chapter 19 spells it" says macvmm connects to PEER; the code uses `send_to(peer)` and never calls `connect` · correct the section.
- **should** (13) · `caches.md` says chapter 13's `image::load` has a comment citing the memtest evidence; it does not · add the comment (section 5) or reword the primer.
- **nice** (16) · `memory-ordering.md` cites `mp relaxed` seen 4 times in 26 M rounds with an earlier harness · re-run with the current harness or label it as earlier.
- **nice** (21) · `uefi.md` says U-Boot "may fix up" the DTB; no fixup was seen at the prompt · add the observation.

## 4. Curriculum, concepts and glossary (owner: lead)

- **should** (03, 04, 05, 06, 08) · CURRICULUM §5 entries contradict observed behaviour: 03 (debug IDs are 0xC600_4D01/02, hello ends via SYSTEM_OFF, exit-bench is 100k calls with no store loop, sp=0 gives an address size fault loop with no exit, `_start` is ~33 lines); 04 (DEBUG_MEMHASH 0xC600_4D03; Q3 park answered in 16 and 20); 05 (IPA break: translation fault level 0, HV_BAD_ARGUMENT at 2G); 06 (CPSR 0x3c4 hangs, 0x3c9 is HV_ILLEGAL_GUEST_STATE); 08 (worked example and L2 marker: MDCCSR_EL0, not PMCR_EL0) · update each entry to the lesson.
- **should** (10, 11, 12, 13, 14) · CURRICULUM §5: 10 (dtb-reader ignores `#address-cells`); 11 (1 ms LineKicker, guest-time cost, "RESULTS #12"); 12 (no measurable latency difference; break 3 gives silence, not another INTID; Q4 gives the answer); 13 (break O panics "VFS: Unable to mount root fs"; break M stops silently); 14 (predict fork: named `timer_probe` panic; marker `cp15 timer running`; no `learner break`) · update each entry.
- **should** (15, 17, 19, 20, 21, 22, 23, 24, 25) · CURRICULUM §5: 15/17 (one vs two exits per byte); 17 (trait is filled, not "extracted", incl. §3.4; TOCTOU break needs ch20); 19 (Q2 evidence unusable with busybox/`nc`; RX break is a deadlock on its own thread); 20 (deadlock defeats `--timeout`, not just "caught by watchdog"); 21 (IPA-recompute break caught only by host test `isv0_ipa_mismatch_aborts`; `saveenv` fails, not "appears to work"; learner ADR path); 22 (no pinned QEMU DTB in docs/compat; neither OS complains about the clock); 23 (`codesign -d --entitlements -`); 24 (objective 2 "implement the next device" is optional option A); 25 (bughunt 4/4, no minimiser, no DTB target, objective 2 narrowed to descriptor chains) · update each entry and record the 25 narrowing in DECISIONS.md.
- **should** (00, 01, 10, 12, 13, 14, 15, 17, 19, 21) · `socratic.md` Part B is stale: 00 (old trap-or-not chapter), 01 Q3 (now `hv_vm_destroy` in `Drop`), 10, 12, 13, 14 (same as CURRICULUM), 15 Q1 ("DTB lists all slots"), 17 Q4 (zero-length buffer: reference refuses), 19 C.2, 21 (`saveenv`) · rewrite those rows from the lessons' rubrics.
- **should** (09) · CURRICULUM checkpoint text says "IMSC/MIS/ICR semantics" but the reference PL011 keeps RX bits in RIS while the FIFO has data (unlike the TRM) · state the simplification.
- **should** (01, 03, 06, 14, 20, 23) · CONCEPTS.md lacks rows the lessons use: 01 (hv_return_t, RAII, two supervisors, type 1/2, XNU), 03 (CPACR_EL1/FP enable, wfe, address size fault), 06 (PAN/TCO pointer; redistributor, counter offset, DTB-in-x0 forward defs), 14 (`panic=`, BusyBox), 20 (`cpu_logical_map`, 16-CPU SGI TargetList limit, signal kicks in KVM VMMs), 23 (PCI Express, XPC) · add the rows.
- **should** (09, 10, 13, 16, 17, 18, 19, 25) · GLOSSARY.md `## Primers` has no entries for terms lessons want to link: raw mode, escape sequence, self-pipe, line discipline; big-endian/byte order; initramfs, EFI zboot, ELF, PoC, DTB, MMU; acquire/release, fence, lost wakeup, store buffer, happens-before, mutex, condition variable; sector, page cache, fsync, F_FULLFSYNC, advisory lock, APFS clone; datagram socket, stale socket; Seatbelt, SBPL, sandbox_init, rlimit, umask, O_CLOEXEC · add entries, then link from the lessons.
- **should** (11, 15) · Chapter-section glossary entries missing: "kick" (forward-defined in 11, belongs in `## Chapter 20`), "virtqueue" (forward-defined in 15, belongs in `## Chapter 16`) · add both.
- **nice** (05) · Glossary "address size fault" covers only the MMU-off case · widen to table/output addresses during a walk.
- **should** (06, 07, 14, 15) · `chapters.json` required primers differ from CURRICULUM: 06 `page-tables`, 07 `aarch64-reading`, 14 `cpio-initramfs`, 15 `reading-arm-specs` · decide per chapter and regenerate.
- **should** (00, 01, 03, 11, 23) · `start_tag` uses an interim convention (`none` for 00, previous chapter's tag elsewhere, even when the real prerequisite is older) · settle DESIGN open question 4 and apply.
- **should** (08) · The exit-code reference card (CURRICULUM §4.0) the lesson cites does not exist, nor does the end-of-Part-III explain-back artifact (§6.3) · create both or remove the references.
- **should** (21) · CURRICULUM §8 marks `boot-chain` optional, but journal Q4's prompt cites "the boot-chain table and lab" · drop "and lab" if it stays optional.

## 5. Code comments, program output and reference docs (owner: code owners)

- **should** (18) · `crates/vmm/src/backend/hostio.rs:194` prints "advisory flock on every --disk; BLK-8" to users (in `18-locked.txt`) · drop the ID from the message and re-capture.
- **should** (19) · macvmm messages print `(NET-1)` / `(NET-4)` (captures in chapter 19) · drop the IDs from user-facing messages.
- **should** (24) · The vmapple refusal prints "PLAN M21" (`24-default-refuses.txt`) and the dry run prints "HC-2" (`24-dry-run.txt`) · reword in `cli.rs` and `machine/vmapple/mod.rs`, re-capture.
- **should** (11) · `guests/common/timer.rs` `wait_for_interrupt` (`daifclr; wfi; daifset`) can lose a wake-up (observed once, ended by timeout) · use the standard pattern: WFI with IRQs masked, then unmask.
- **should** (21) · `devices/flash.rs` and `loader/firmware.rs` call U-Boot's store to flash a "stage-2 permission fault"; observed DFSC 0x7 (translation fault, level 3) · correct the comments and `docs/compat/uboot.md`.
- **should** (06) · `Vcpu::create` comment says the default MPIDR "reads 0"; observed 0x80000000 with `--irqchip none` · correct the comment.
- **should** (07) · `guests/mmio-probe/main.rs` says a VMM writing register 31 "dies on an instruction abort at 0x1111"; observed a PC alignment fault at 0x1115, exit 6 · correct the comment.
- **should** (13) · `loader/image.rs` `image::load` has no comment on why it does no cache clean (the caches primer says it does) · add the comment citing the memtest evidence.
- **should** (24) · `machine/vmapple/layout.rs` cites QEMU 9.2; vmapple shipped in 10.0 and the map was verified against v10.0.0 · pin one tag in code and research docs.
- **should** (08) · Under `--irqchip none`, `mrs MDCCSR_EL0` does not trap and PMCR_EL0 does (the reverse of the default) · record in docs/research and in `sysreg.rs` module docs.
- **should** (02) · `spikes/hvf-hello` RESULTS.md finding 22's raw output does not show the hvc at virtual EL2 · cite `course/captures/02-el2-hvc.txt`.
- **should** (23) · `docs/macos/status.md` still says the vz-mac test is blocked on missing artifacts (verified); `test.sh` now passes all five steps · add the new observation row.
- **nice** (03) · `guests/exit-bench` has no store loop; the lesson shows one as a captured Try it · add it with its expected marker file if CURRICULUM keeps the comparison.
- **nice** (05, 16) · Experiment guests/tests behind captures are not in the repo: `uart-ram`, `va-alias`, `ipa-poke` (05), the descriptor self-loop counter (16) · add under `guests/` / `virtqueue_hostile.rs` with anchors.
- **nice** (25) · The "verdict cache" plant used by the Predict fork is not in `crates/fuzz/planted/` · add as `05-*.patch` without wiring it into the self-test.
- **nice** (10) · `guests/dtb-reader` hardcodes 2/2 cells, so the CURRICULUM predict fork cannot happen · optional: honour the parent's cell counts.
- **nice** (13) · Bad-magic errors never name the missing magic ("--initrd needs an arm64 Image" / "not an ELF file") · add "no ARM\x64 magic at 0x38".
- **nice** (10) · `--irqchip none` is hidden from `macvmm run --help` but used from chapter 10 on · consider showing it with a teaching-mode note.
- **nice** (22) · No pinned QEMU `virt` DTB in docs/compat; the lesson uses its own captures · add one if wanted.
- **nice** (09, 20, 24, 25) · `cargo fmt --check` diffs in `guests/` (`hostile-smp`, `hostile-vq`, `smp-race`) and earlier in `virtio/net.rs:473` · run `cargo fmt` once parallel edits settle.

## 6. Chapters over 4,000 words (STYLE §8)

The lint (`scripts/check-lessons`, run 2026-11-20) flags 12 chapters; the 13th, chapter 19, was
flagged by its verifier on `wc -w` and no longer trips the lint. Every one already has a
`:::stopping-point`. Recommendation per chapter:

| Ch | Lint words | `wc -w` | Recommendation | Why |
|----|-----------:|--------:|----------------|-----|
| 01 ffi | 4,772 | 5,591 | **Trim** | Apply CURRICULUM's own fallback: move the HvError half into a completion scaffold (`course/scaffolds/01`); the first half (stack, trap-or-not) stands alone. |
| 03 test-guests | 4,232 | 5,285 | **Trim** | Only ~230 over; move the exit-bench store-loop and rate-limit detail into capture notes (being edited now for the verifier fix: fold this in). |
| 04 guest-memory | 4,699 | 5,371 | **Accept as two sittings** | Stopping point already splits region table / safe access; both halves feed one checkpoint. |
| 08 traps-psci | 5,022 | 5,926 | **Accept as two sittings** | CURRICULUM requires one chapter in two sittings; sysreg traps and PSCI/exit codes split cleanly at the stopping point. |
| 09 mmio-pl011 | 5,163 | 6,227 | **Split** | Longest Part-IV page; split at "Stopping from another thread": 09a PL011 + bus + output filtering, 09b input thread, raw mode, signals, stop flag, PL031. |
| 10 device-tree | 4,549 | 5,429 | **Trim** | Move the byte-by-hand blob section to the `dtb-explorer` lab fallback / appendix once the lab exists. |
| 15 virtio-mmio | 4,764 | 5,528 | **Accept as two sittings** | Trim the forward-look captures (`--rng`, `--disk`) to one sentence each. |
| 16 virtqueues | 4,760 | 5,435 | **Accept as two sittings** | Sitting A (ring layout, chains) / Sitting B (ordering, TOCTOU) are already marked. |
| 18 virtio-blk | 4,751 | 5,629 | **Accept as two sittings** | CURRICULUM budgets 5.5 h; FLUSH and persistence after the stopping point are a natural second sitting. |
| 19 virtio-net | (under) | 4,857 | **Trim** | Being fixed now; cut reference-only material (10-byte-header byte table, tx_dropped inference) so `wc -w` also drops. |
| 20 smp | 5,036 | 5,753 | **Split** | Two topics: bringing up secondaries (MPIDR, CPU_ON, parking) and concurrency hazards (kick, shared devices, lock-order break, 64 vCPUs). |
| 24 vmapple | 4,707 | 5,393 | **Accept as two sittings** | Optional capstone; trim the ADR-0009 publishing discussion once the lead confirms D4. |
| 25 security | 5,498 | 6,381 | **Split** | Longest page; fuzzing/hostile guests and the sandbox are separate skills: 25a threat model + fuzzing + bughunt, 25b hostile guest + sandbox. |

Also near the threshold by the lint's count, from the authors' reports: 06 (3,995) and 12 (3,999).

## Resolved since the run (dropped from the backlog)

- `course/checkpoints/13-19, 21-23, 25` now exist with `[hints]` and `[journal]` (raised by 13-25).
- `course/retrieval/00.md`-`25.md` all exist (raised by 07, 08, 10, 11, 13, 15-17, 19, 23).
- Chapter 25 `prereqs` mismatch: the lint no longer warns.
- `check-anchors` error on `vmapple_slot_loop` (13) and the transient `sandbox_confine_call` error (09): `ANCHORS OK: 645 anchors`.
- Missing `00-checkpoint-learner.txt` (18): `LESSONS OK: 26 lesson(s)`.
- `checkpoints/05` `[hints]` with "PLAN §1": no longer present.
