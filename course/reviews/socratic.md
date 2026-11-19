# Socratic review of the macvmm curriculum

Reviewer role: Socratic thinker and teacher. Inputs: `course/CURRICULUM.md` (v1), `course/STYLE.md`, `CLAUDE.md`.

How to read this file. Part A critiques the current questions. Part B gives, for every chapter, a refined set
of questions. Each has an **expected reasoning path** (what a strong answer walks through, so the journal
rubric can check ideas, not prose) and a **common wrong answer** (the one to expect, and the nudge that
exposes it). Each chapter also has one **Predict experiment** the learner can run on their own Mac. Part C
lists the productive-failure moments, with the safety rails that keep them from becoming plain frustration.

Tags on questions: **[K]** kept from the curriculum, **[R]** rewritten, **[N]** new. Experiments are tagged
**[E]**. Anything that depends on observed HVF behaviour is marked **(verify, K3)**: the author runs it on
the reference machine first and fixes the expected result before the lesson ships. Nothing here should be
read as a claim about what HVF does until that run has happened.

---

## Part A. Critique of the questions in the curriculum

### What works

- The set has real range: mechanism ("why must the GIC exist before vCPUs?"), hostile-input
  ("why treat the kernel image as hostile?"), and design judgement ("return 0 or inject UNDEFINED?").
- Several are excellent and should survive almost untouched: ch04 Q3 (is the `&[u8]` promise true?), ch08 Q1
  (zero vs UNDEF, who is hurt), ch11 Q1 (level interrupt never lowered), ch16 Q1 and Q3, ch18 Q2 and Q3,
  ch20 Q1, ch24 Q1 (stalled vs waiting for a device), ch27 Q2.
- Each chapter pairs a question with a misconception. That is the right backbone: a good question is the
  one whose natural first answer *is* the misconception.

### What does not work, in order of severity

1. **Too few questions can be settled by evidence.** About two thirds are opinion or recall questions
   ("Why does Apple gate vmnet?", "Why mirror QEMU's layout?", "If you could ask Apple for one interface...").
   The journal is checked only for presence (CURRICULUM 3.3, L3), so an unanswerable question invites a
   confident-sounding paragraph and teaches nothing. Every refined question below names a source of
   evidence the learner has in hand: a trace, a register dump, a spec table, or a two-minute run.

2. **Some questions are not answerable from what the learner has seen.** Examples:
   - ch00 Q2 (why an entitlement?) and ch00 Q3 (page fault inside the guest's own tables) need stage-1
     translation, which the learner meets in ch05, and macOS security policy, which is never taught.
   - ch05 Q2 (why mirror QEMU `virt`?) is only answerable after firmware and Linux exist (ch14, ch21).
   - ch09 Q1 (ID registers at `0xFE0`) is answerable only after Linux has probed an AMBA device (ch14).
   - ch12 Q1 leans on snapshots (ch26). ch19 Q2 and ch23 Q2 lean on Apple policy the course does not cover.
   - ch06 Q1 says "we never got an exit". With `VBAR_EL1 = 0` and no vector table the guest *does* produce
     exits, just baffling ones (probably a stage-2 instruction abort at a tiny IPA such as `0x200`, **verify, K3**).
     The question's premise may be false. This is a good thing to turn into an experiment, not a premise.
   Fix: either move the question to the chapter where it becomes answerable, or turn it into a forward
   promise ("park this, answer in ch14").

3. **Some stems give the answer away.** ch07 Q3 ends with "On AArch64 it cannot be." ch13 Q1 ("the image
   is a file on *your* disk. Why treat it as hostile?") has a one-word answer (it might be corrupt or
   malicious) that fits every file ever. ch02 Q1 asks what happens "if the HVC did not trap", but under our
   configuration HVC always traps, so the hypothetical has no experiment behind it. The real, runnable
   version is: what happens if the `hvc` is *missing*?

4. **Sequencing inside a chapter is abstract-first.** The three questions are listed in conceptual order,
   and all three are "why" questions. A better order is concrete to abstract: Q1 asks the learner to
   *observe or compute* (what number is in this field?), Q2 to *explain the mechanism*, Q3 to *transfer
   or break it* (what if the guest were hostile, or the config different?). The refined sets follow this.

5. **No question requires the learner to run anything.** STYLE.md has Predict callouts, but CURRICULUM 1.3
   asks only for "at least one Predict" per chapter without saying that it should be a *fork in the road*:
   two plausible outcomes where the wrong one is the misconception. Refined Predict experiments below are
   written as forks, with a reason to guess wrong.

6. **Several questions bundle two or three questions** ("Why does X, and what does that imply for Y, and
   where else will it bite?"). A learner answers the easiest part. Split them, or make the extra parts
   follow-ups that appear only in the rubric.

7. **The rubric is not stated for most questions.** CURRICULUM 6.1 gives one example (ch16 Q1). Part B
   gives an expected path for every question so `course/journal/NN.md` can print "ideas a strong answer
   contains" for each.

8. **Misconception to question alignment is loose in a few chapters.** ch09's misconception ("a device is a
   state machine") is not tested by any of its questions. ch10's Q2 (strings block) is trivia compared with its
   misconception (the DTB is the only source of truth). ch25 Q3 ("which input worries you most") is an opinion
   with no standard to be wrong against. Refined sets target the misconception directly.

9. **STYLE.md tension.** Section 11 asks for exactly one open question at the end of a chapter, and CURRICULUM
   7 says it is one of the three Socratic questions. If it is Q1 of the refined set, it has been answered
   in the text. Rule proposed here: the closing open question is always the **transfer** question (the
   last in each set below, tagged "open-question candidate"), never the concrete one.

### Summary of changes proposed to CURRICULUM.md (for the lead)

- Raise the target from "three Socratic questions" to "three journal questions plus one Predict experiment",
  and say the experiment is a fork with the misconception as the tempting branch.
- Require each question to cite its evidence source (trace, dump, spec table, run).
- Add `scripts/learner break NAME` (Part C) as a first-class feature of the harness.
- Add a one-line "park it" marker for forward-looking questions.
- Allow 3 to 5 questions per chapter. Parts II and VII get 4 to 5 because their ideas are the security core
  (G3).

---

## Part B. Refined questions, chapter by chapter

Conventions: **Path** is the expected reasoning. **Wrong** is the common wrong answer and the nudge that
exposes it. "Open-question candidate" marks the question to use as the lesson's closing hook.

---

### 00 orientation

Critique: Q1 is excellent but abstract-first; Q2 and Q3 need ideas not yet taught. Reorder around the
trap-or-not lab, which is the learner's only concrete evidence.

**Q1 [N, concrete].** In the `trap-or-not` lab you sorted `ldr` from RAM and `str` to the UART into different
buckets. What is physically different about those two instructions that makes the hardware treat them
differently, though both are "a store to an address"?
- Path: both are memory accesses. The address in the first lands on RAM the VMM mapped (stage 2 has an
  entry), the second lands on an address with no mapping. The hardware does not know "device vs RAM". It
  only knows "mapped vs not mapped". A device is just a hole in the map that we choose to answer.
- Wrong: "The UART address is special hardware, so the CPU knows to trap." Nudge: the CPU has no idea what a
  UART is. Ask what the CPU can look up when it translates an address.

**Q2 [K, mechanism, rewritten].** The hardware runs guest instructions at native speed. List everything that is
*still* left for the VMM, using only your lab answers.
- Path: things that touch unmapped addresses (devices), sensitive instructions we chose to trap (`hvc`, some
  sysreg accesses), and set-up work: memory, initial registers, the machine description. The VMM is
  the machine's environment, not its CPU.
- Wrong: "It translates guest instructions." That is the misconception (emulation). Nudge: which of the
  10 lab items did *not* involve the VMM at all?

**Q3 [N, forward-looking, "park it"].** `scripts/doctor.sh` printed a max IPA size. Why might a VM have a limit
on the *physical* addresses it can use, when the host has plenty of memory?
- Path: guest physical addresses are an address space we define, translated by hardware tables with a fixed
  width. The limit is about table format, not RAM size. Park the full answer for ch05.
- Wrong: "It is the amount of RAM in the Mac." Nudge: the IPA space contains holes for devices at `0x0900_0000`.

**Q4 [K, open-question candidate].** Why does macOS require an entitlement for something any process could
already do by running arbitrary code?
- Path: running code is not the same as being allowed to program the CPU's virtualization state and map host
  memory into another address space. It is a capability on the host, not a language feature. Evidence: the
  entitlements plist in the repo lists exactly one right. Expected quality: names a capability, and says what
  could go wrong without the gate.
- Wrong: "To stop malware." Nudge: what specific thing could a hypervisor-capable process do that an
  ordinary one cannot?

**[E] Predict.** Run the doctor probe binary *unsigned* (`cargo build`, then run the raw binary directly, not via
the signing runner). Will you get (a) a link error, (b) a crash, (c) a clean error value? Which hv return
code? Answer: the call fails at runtime with an error return (expected: HV_DENIED, check the header). The
entitlement is checked by the kernel at call time, not by the linker. This also sets up ch01 objective (4).

---

### 01 ffi

Critique: Q1 (`u32` vs `u64`) is great and concrete. Q2 is speculation about Apple's motives. Q3 is too
abstract for a chapter that has just started.

**Q1 [K, concrete].** The header says `hv_vcpu_t` is `uint64_t`. You wrote `u32`. Which values still work, and
when would it first go wrong, silently?
- Path: on arm64 args go in 64-bit registers. A small `u32` handle passed in a register zero-extends fine, but
  an out-pointer write of 8 bytes into a 4-byte slot overruns the stack slot, and a returned value truncates.
  It "works" while the handle value is small. Silent corruption of the neighbouring variable.
- Wrong: "The compiler would reject it." Nudge: the compiler has never seen the C header.

**Q2 [R, mechanism].** What does the borrow checker see when you call `hv_vcpu_run(vcpu, ...)`, and what does it
*not* see?
- Path: it sees a raw integer and a function it must trust. It does not know the framework retains the exit
  struct pointer, that the vCPU must be used on one thread, or that the VM must outlive the vCPU. Those are
  our invariants, written as SAFETY comments and enforced by types (`Vm` owns `Vcpu`, `!Send`).
- Wrong: "Rust prevents use-after-free so it is fine." Nudge: free of *what*, and who frees it?

**Q3 [N, concrete].** After `Vm::new()` succeeds, what happens if you create a second `Vm` in the same process?
- Path: the framework allows one VM per process. This is a fact to observe, then reason about: it shapes the
  architecture (one VMM process per VM, no multi-VM test harness inside one process, tests spawn
  processes).
- Wrong: "You can make as many as you want; they are just objects." Nudge: run it.

**Q4 [K, open-question candidate].** What does unsafe Rust turn off? Name something it leaves on.
- Path: it allows five extra operations. Type checking, borrow checking of safe references, and bounds
  checks on safe indexing stay on. The invariants for the unsafe operations are on you.
- Wrong: "It turns off the borrow checker." Nudge: try to break a lifetime rule inside an `unsafe` block.

**[E] Predict.** Create two `Vm` values in one process, then drop the first. Does the second `hv_vm_create`
succeed? (a) yes (b) fails with an error (c) crashes. Then: after dropping both, does a third succeed?
Expected: second fails with a non-success `hv_return_t`; after drop, create works again (verify, K3).
Lesson: RAII is not decoration, `Drop` is what makes the next create work.

---

### 02 first-exit

Critique: Q1 is built on a hypothetical that cannot be run. Q2 is good but arrives too early to be settled.
The real chapter puzzle is the PC after the exit.

**Q1 [N, concrete].** Print the PC after the HVC exit. Is it the address of the `hvc`, or the one after? Then
print `x0`. What does the answer tell you about who advanced the PC?
- Path: for HVC the architecture records the preferred return address as the *next* instruction, so the VMM
  need not adjust. (verify against reference, K3, before the lesson says it.) Hence "add 4 to the PC after
  every exit" is wrong for this exit and will be wrong in the other direction for data aborts.
- Wrong: "PC still points at hvc, so I must add 4." Nudge: add 4 and see whether `b .` still saves you.

**Q2 [R, mechanism].** If the `hvc` were missing (three words become two: `movz`, `b .`), what do you
observe? Predict the exit count and the vCPU's behaviour.
- Path: `b .` spins forever. The run call never returns. No exit, nothing to decode. A hang with no signal.
  This is why the vCPU run loop needs an external way to stop (a kick, or a timeout), which ch12 and ch20
  formalise.
- Wrong: "The guest crashes with an error." Nudge: an infinite loop is a valid program.

**Q3 [N, safety net].** Remove the `b .` instead (keep `hvc`). The guest runs on into zeroed RAM. What is
the first thing that happens, and what do you see on the host?
- Path: the word `0x00000000` decodes as UDF, a guest exception to EL1. `VBAR_EL1` is zero, so the vector
  address is `0x200`-ish IPA, which is not mapped. We probably see an instruction abort exit (EC 0x20) at
  a tiny IPA, not a "bad instruction" (verify, K3). Lesson: guest exceptions are handled in the guest
  first; the host sees the *consequence*.
- Wrong: "We get an 'undefined instruction' exit." Nudge: which exception level takes UDF, and who owns
  that vector table?

**Q4 [K, open-question candidate].** HVF ties a vCPU to the thread that created it. What does that force on a
multi-vCPU design?
- Path: one thread per vCPU, each creating and running its own. Cross-thread work (stop, interrupt, read
  registers) needs an explicit mechanism, not a function call. Foreshadows ch20.
- Wrong: "A thread pool." Nudge: what would happen to a vCPU created on thread A and run on thread B?

**[E] Predict.** Change the `movz x0, #0x2a` to `movz x0, #0x2a, lsl #16`. Predict `x0` as a hex number,
then run. Then change `hvc #0` to `hvc #7` and predict which field of the syndrome changes (the low 16 bits
of ISS). Expected: `0x2a0000`; ISS imm16 becomes 7. This anchors "the syndrome is data, decode it".

---

### 03 test-guests

Critique: Q1 (print cost) is excellent: numeric, estimable. Q2 is fine. Q3 (trust direction) is vague.

**Q1 [K, concrete].** Time printing 4 KiB through the debug hypercall. Estimate first. What does your number
suggest about how real devices should accept data?
- Path: one exit per byte, each costing microseconds, so 4096 exits. Measure with the trace timestamps.
  Lesson: per-byte MMIO is a cost model, which sets up why virtio batches (ch17). Estimate before measuring.
- Wrong: "Nanoseconds, it is just a function call." Nudge: count the context switches in the trace.

**Q2 [K, mechanism].** Delete the stack-pointer setup from `_start`. What does `x30` hold, what does `sp`
hold, and what do you see?
- Path: `sp` is zero or whatever HVF left (we set nothing), so the first push faults at a low address that is
  not mapped. A data abort exit on an address near zero, from the guest's own `bl` prologue. Nothing in the
  CPU provides a stack.
- Wrong: "The CPU has a default stack." Nudge: where is the stack pointer *stored*?

**Q3 [R, transfer].** The guest's panic handler reports through a hypercall. If a hostile guest sends a
million bytes through the debug hypercall, what does the VMM do with them? Name a limit you would add.
- Path: the VMM writes unlimited host output; a stdout pipe that is full blocks the vCPU thread. Add a rate
  or size cap, or a drop policy. This is the first hostile-guest thought in the course.
- Wrong: "It is only a debug call, it is trusted." Nudge: who calls it?

**[E] Predict.** Build `guests/hello` with the BSS-zeroing loop deleted, and a `static mut COUNTER: u32 = 0`
that you print. Will it print 0? Expected: it may print 0 *by luck*, because RAM was fresh-zeroed by mmap.
Now make the VMM fill RAM with `0xA5` before loading and run again: garbage. Lesson: our zero was
a property of the host, not of the program. This is the misconception ("a bare-metal program needs an OS") made
concrete: we provide `_start`'s guarantees ourselves.

---

### 04 guest-memory

Critique: Strong chapter, and the three questions are good. Raise to 5 with the concrete overflow first.

**Q1 [N, concrete].** In the lab's overflow mode, `addr = 0xFFFF_FFFF_FFFF_FFFC, len = 8` passes the check
`addr + len <= region_end` in wrapping arithmetic. Compute the sum, then say which host address you would
have formed.
- Path: the sum wraps to 4, which is below `region_end`, so the check passes. Then the subtraction to get an
  offset into the mapping underflows into a huge number, giving a host pointer far outside the mapping.
- Wrong: "Rust panics on overflow." Nudge: in release builds it wraps, and in debug it panics, which is a
  denial of service for a guest-controlled value. Both are wrong.

**Q2 [K, mechanism].** The guest and the VMM share the same physical pages. Who can change them, and when?
What does that imply for "check, then use"?
- Path: any vCPU thread can write at any time, concurrently with us. A value validated at time t may differ
  at t+1. So read once into a local copy, validate the copy, use only the copy.
- Wrong: "Validate before use is enough." This is the misconception. Nudge: what is between the check and
  the use?

**Q3 [K, mechanism].** Is the promise of a Rust `&[u8]` into guest memory true? If not, what should
`get_slice` return?
- Path: `&[u8]` promises immutability to the compiler, which may then load twice and assume equal values;
  another thread mutating it is undefined behaviour. So return an owned copy, or a volatile-style
  wrapper that makes you copy field by field. Cite the `GuestMemory` design.
- Wrong: "It is fine as long as we do not mutate it ourselves." Nudge: the guest is a second thread of the
  same program, as far as Rust is concerned.

**Q4 [K, mechanism].** Why 16 KiB pages? Where else does the host page size come back?
- Path: Apple Silicon's native granule. `hv_vm_map` wants host-page-aligned addresses and sizes, so memory
  regions, flash, and later the snapshot file format all align to it. Evidence: try mapping a 4 KiB region.
- Wrong: "4 KiB is universal." Nudge: run the experiment below.

**Q5 [N, transfer, open-question candidate].** You cap guest RAM at the host's free memory. What *other* guest
actions can exhaust host resources without touching RAM?
- Path: faults to log, file descriptors, threads, a huge virtqueue size, an infinite loop. Foreshadows
  "resource exhaustion survives `forbid(unsafe_code)`" in ch25.
- Wrong: "None; memory is the only thing." Nudge: what resource does the debug hypercall use?

**[E] Predict.** Call your `hv_vm_map` with a 4096-byte region at an address that is only 4 KiB aligned.
Success, error, or silent misalignment? Expected: an error such as bad argument (verify, K3). Then try
`mmap`-allocating 4096 bytes and see if the pointer happens to be 16 KiB aligned. "Happens to be" is the lesson.

---

### 05 address-space

Critique: Q1 is good. Q2 is not answerable here. Q3 is clever; keep as the transfer question.

**Q1 [K, concrete].** Our VMM never reads the guest's page tables, yet the abort exit gives an address. Which
address is it (VA, IPA, PA), and where did it come from?
- Path: IPA: the output of stage 1 and the input of stage 2. The hardware wrote it into the exit info
  because stage 2 is the stage that faulted. The VA is also reported but it is meaningful only in the
  guest's address space.
- Wrong: "The address the guest used." Nudge: with the MMU off, are VA and IPA different? With it on?

**Q2 [R, concrete].** Pick an IPA beyond the machine's `ipa_size`. Predict whether touching it gives a data
abort, an address-size fault, or something else, and compare with the lab's fault output.
- Path: depends on the translation-fault vs address-size-fault classes in the ISS; read the ESR decoder lab.
  (verify, K3.) The point: "unmapped" has more than one failure mode, and the code in the ISS tells which.
- Wrong: "All bad addresses give the same fault." Nudge: decode DFSC.

**Q3 [K, transfer, open-question candidate].** From the guest's point of view, what is the difference between
"no device here" and "a device that ignores you"?
- Path: reads to nothing return whatever we choose (all ones is the convention) or a bus error; a device that
  ignores you can still be probed by its ID registers and then misbehave. Drivers decide "present" by
  reading. Our choice of answer for unmapped reads becomes part of the machine.
- Wrong: "No difference." Nudge: what would a driver do after reading all ones? After reading zero?

**Q4 [N, deferred].** Park it: why would we mirror QEMU's `virt` layout instead of inventing one? Revisit
in ch21. (Not for the journal here.)

**[E] Predict.** Run `guests/mmio-poke` with RAM base changed to `0x0` in `layout.rs` (and the linker script).
Does it boot? Expected: the guest's own accesses work (we define the map) but the first thing that
breaks is any later chapter's assumption (firmware at 0, the DTB convention). Easier version: store to
`0x0900_0000` and `0x0900_0004` and predict whether the two exits differ in the trace. Only the IPA differs.

---

### 06 vcpu-state

Critique: Q1's premise (no exit) is dubious, and Q3 is dull. Q1 becomes a proper experiment.

**Q1 [R, concrete].** Run `guests/self-fault`. You get no "alignment fault" exit. What do you get instead, and
where did the alignment fault go?
- Path: an alignment fault is a synchronous exception targeted at EL1, so the guest's own vector table
  handles it. With no table, the CPU jumps to `VBAR_EL1 + offset`, which is not mapped, and we get a *second*
  fault as an exit. The register dump's `ESR_EL1` and `ELR_EL1` hold the original cause. Read them to
  find the first fault, not the last. (verify, K3).
- Wrong: "The hardware sends all exceptions to us." That is the misconception. Nudge: which register would
  say where it went?

**Q2 [K, mechanism].** Why does Linux insist on MMU off at entry and caches in a defined state?
- Path: the kernel builds its own page tables and turns the MMU on at a known identity address; stale
  cache or translation state from the loader could return wrong data. `booting.rst` states the rules. Cite
  the section.
- Wrong: "For speed." Nudge: what could go wrong if the loader's cache lines are dirty?

**Q3 [K, forward-looking].** `MPIDR_EL1` looks like trivia. Which later component breaks if it is wrong?
- Path: PSCI `CPU_ON` takes an MPIDR value to name the target, the DTB `/cpus` nodes list `reg = <mpidr>`,
  and the GIC redistributor is found by affinity. A mismatch fails in three places. (Answerable by reading
  the DTB spec and GIC spec section; park the rest for ch20.)
- Wrong: "It is only an ID." Nudge: find three places that look the ID up.

**Q4 [N, transfer, open-question candidate].** Your register dump is the only window into a crashed guest. Which
five registers would you add, and what question does each answer?
- Path: examples: `ELR_EL1` (where it died), `ESR_EL1` (why), `FAR_EL1` (what address), `SP_EL1` (is the
  stack sane), `SCTLR_EL1` (is the MMU on). The learner defends choices with questions, not lists.
- Wrong: "Everything." Nudge: which of these answer "what do I do next?"

**[E] Predict.** Change CPSR from `0x3c5` to `0x3c4` (EL1t instead of EL1h) and run `regcheck`. Which printed
value changes? Expected: `CurrentEL` is still EL1; `SPSel` differs, which changes which `sp` register the
guest uses (SP_EL0 rather than SP_EL1). If your `_start` sets `sp` before reading, it works either way, a good
subtle lesson. Also try `0x3c9` (EL2h). Expected: probably an HVF error or an odd behaviour (verify, K3).

---

### 07 exit-loop

Critique: Q1 and Q2 are good; Q3's stem gives the answer. Add a PC-handling experiment.

**Q1 [N, concrete].** Here is a data-abort ESR from the trace: decode ISV, SAS, SRT and WnR by hand, then say
what the guest instruction was. (The learner uses the ESR lab vector.)
- Path: apply the field layout from the Arm ARM; ISV=1 means the hardware gave us SAS and SRT, so we know size
  and register without reading the instruction. Reconstruct "`strb w2, [x1]`".
- Wrong: "You have to fetch the instruction from guest memory and decode it." That is the misconception.

**Q2 [K, mechanism].** Why does the hardware give us the register number and size (ISV=1) at all? What would we
have to do without it?
- Path: to emulate MMIO we need size and register but the only other source is the instruction. Without ISV we would
  walk the guest page tables to fetch the instruction (it might not even be readable to us) and write a
  decoder for the whole load/store space. ISV=0 (`ldp`, writeback forms, some cases) is the part that
  needs that, and we refuse it.
- Wrong: "To make it faster." Nudge: what is the cost of the alternative?

**Q3 [R, mechanism].** `ldp x0, x1, [mmio_addr]` is a pair load to a device address. Why is ISV 0, and is it the
guest's bug or ours?
- Path: ISV is set only for single-register forms the architecture can describe. For a pair, there is no single
  SRT/SAS. Linux does not issue it on device memory because device memory attribute rules make it
  unpredictable. A guest that does it is buggy for device memory; our job is to fail clearly (print the
  instruction word) rather than guess. Evidence: Arm ARM ISS encoding for data aborts.
- Wrong: "We should add a decoder to handle `ldp`." Nudge: what else would you then have to support, and when
  do you stop?

**Q4 [K, transfer, open-question candidate].** After emulating a store you advance the PC by 4. Say what the IL
bit tells you, and what you would do if it said 16 bits.
- Path: IL indicates instruction length. In AArch64 all instructions are 4 bytes, so IL is 1 for 32-bit; in AArch32
  (not supported here) 16-bit are possible. We should *check* IL rather than assume. A cheap hostile-input
  check.
- Wrong: "It is always 4, so ignore it." Nudge: what do you do if hardware says otherwise?

**[E] Predict.** Comment out the PC advance after a data-abort exit. (a) crash, (b) infinite loop with the same
exit, (c) skip the store. Then predict the trace: how many exits per second, and what will each record
look like? Expected: (b), identical records, forever; `t_ns` increases. This is the best single experiment
in the chapter. Part C makes it a mandatory break.

---

### 08 traps-psci

Critique: Q1 is superb. Q2 is vague ("what would booting Linux look like without PSCI?"). Q3 has a
factual subtlety: SMC also traps under HVF, so the answer is about the conduit convention, not capability.

**Q1 [K, mechanism].** A guest reads a sysreg we do not emulate. Return 0, or inject UNDEFINED? Who does each
choice hurt?
- Path: returning 0 hides the gap and a driver may proceed with a lie (wrong feature detection, silent
  misbehaviour); UNDEF is honest and lets guests that probe optional registers fall back, but kills guests
  that assume the register exists. The right policy is per register: RAZ/WI for those whose absence is
  architecturally allowed (debug, PMU) and UNDEF for unknown. Write the reason next to each entry.
- Wrong: "Always return 0, so guests don't crash." Nudge: what would Linux conclude about a PMU that reads 0?

**Q2 [N, concrete].** Our dispatcher returns `NOT_SUPPORTED` (-1) for `PSCI_FEATURES` of an unknown function. In
the trace, find the register the result is returned in. Which register holds the function ID?
- Path: SMCCC: function ID in `w0`, args `x1-x3`, result in `x0` (and `x1-x3`). The VMM writes the result back
  into the vCPU registers; the guest reads them after the `hvc`. "The registers are the API".
- Wrong: "The return goes in `x30`." Nudge: how does C return a value on this ABI?

**Q3 [R, mechanism].** Boot a guest that calls `SYSTEM_OFF` through `smc #0` while our DTB says `method = "hvc"`.
What do you see, and what does that teach about "conduit"?
- Path: under HVF both instructions trap to us (EC 0x16 vs 0x17), so the VMM could serve both. The DTB `method`
  tells the *guest* which to use; our dispatcher must handle exactly the one we promised, and return an error
  or UNDEF for the other. (verify, K3: confirm what HVF delivers for SMC and the PC rule.) Doing both is a
  policy decision. Ties to enduring understanding 4.
- Wrong: "SMC is for real hardware so it won't trap." Nudge: look at the exit reason.

**Q4 [K, transfer, open-question candidate].** Why is PSCI a *standard*? What would Linux need if every VMM
invented its own way to power off and start CPUs?
- Path: a per-VMM driver or board file in the kernel for each; a standard lets one kernel boot anywhere by
  reading `/psci` in the DTB. A standard is also the contract the DTB promises.
- Wrong: "Because ARM said so." Nudge: count the VMMs.

**[E] Predict.** Make the sysreg handler return 0 for every unknown read, including `ID_AA64PFR0_EL1`-family
IDs, then run `sysreg-probe`. Will the guest notice? Expected: the probe "passes" reading zero for a
register that must not be zero for any real CPU; a guest that decodes features would conclude "no FP, no
GIC system registers". Contrast with the UNDEF version. (verify, K3: which registers trap at all.)

---

### 09 mmio-pl011

Critique: the chapter's misconception (state machine, side effects) is not tested. Q1 is deferred to
ch14. Q2 is good.

**Q1 [N, concrete].** Read `FR` twice in a row from your PL011 after writing one byte to `DR`. List what you
expect for TXFE, BUSY and RXFE on each read, and then what a *real* UART would show.
- Path: a real UART shows BUSY for the time it takes to shift the byte; we can return "not busy" because our
  transmit is instantaneous. A driver polls BUSY or TXFE, so a lie that is *consistent* (always idle) is
  fine, a lie that is inconsistent is not.
- Wrong: "Registers hold values." Misconception. Nudge: does a read of `FR` change anything?

**Q2 [N, state machine].** `ICR` is write-1-to-clear, `DR` read pops the RX FIFO, and `RIS` is a status that
persists. Draw the state machine for one received byte. Which operations are side-effectful reads?
- Path: byte arrives, RXFE clears, RIS.RXRIS sets, MIS depends on IMSC; reading `DR` pops, and the
  status falls when the FIFO empties (for level-style). A read of `DR` with no data returns what the
  datasheet specifies.
- Wrong: "Store the last value and return it." Nudge: read `DR` twice.

**Q3 [K, concurrency].** Two vCPUs write the UART at once. What does the lock protect, and what does it not?
- Path: it protects the device's internal state (FIFO, status bits) from torn updates. It does not order
  *whole sequences*: two guests' lines interleave at byte granularity; the guest kernel's own console lock
  protects its output. The VMM must not hold the device lock while blocking on host I/O.
- Wrong: "The lock makes the output come out in order." Nudge: what ordering would you want, and who knows
  about messages?

**Q4 [R, transfer, open-question candidate; replaces ID registers].** What happens to a guest that probes our UART
and reads zeros from the ID registers at `0xFE0`? (Park the full answer for ch14, record a guess now.)
- Path: PrimeCell devices are identified by those registers; a bus driver that matches on them will not
  bind, no device appears. Learners are asked to *write the guess* and check it in ch14 (spaced retrieval,
  CURRICULUM 6.2).
- Wrong: "Nothing; the guest just writes to DR." True for a raw-MMIO guest like ours, false for Linux.

**[E] Predict.** In `uart-echo`, make `FR` always return `RXFE = 1` (empty). Feed `ping\n` on stdin. Does the
guest print `pong` anyway? Expected: no; the guest's loop waits forever. Next, make `FR` always return `RXFE = 0`.
Expected: the guest reads garbage forever or a stale byte. Lesson: the status register is half of the data
path (see the Part C break "lying flag").

---

### 10 device-tree

Critique: Q1 and Q3 are good. Q2 (strings block) is trivia. The misconception is the real lesson, so
make a wrong DTB the experiment.

**Q1 [N, concrete].** With `#address-cells = <2>` and `#size-cells = <2>`, how many bytes long is the `reg`
property for the PL011 (one range)? What if the root says `<1>` and `<1>`?
- Path: each cell is 4 bytes, so `<2>,<2>` makes 16 bytes and `<1>,<1>` makes 8. The parent's cells govern, not the
  node's own. Evidence: run `--dtb-out` and look at the property length in the hex dump.
- Wrong: "A `reg` is always address then size, 8 bytes each." Nudge: where are the cell counts declared?

**Q2 [K, mechanism].** Who reads the DTB first, and what happens if it describes a device that the bus does
not have?
- Path: the kernel's early boot reads it (memory, `chosen`, `psci`, timer) before any device driver; a driver
  for the phantom device probes, reads our unmapped region (all-ones or a stage-2 fault), and either fails
  harmlessly or hangs or crashes. We choose the answer to unmapped reads (ch05), so the DTB and bus
  must agree.
- Wrong: "The kernel ignores things it cannot find." Nudge: what does `earlycon` do if its address is wrong?

**Q3 [K, transfer, open-question candidate].** DTB and device models come from one `layout.rs`. What class of bug
does that remove, and what class does it not?
- Path: removes address/size/interrupt-number disagreement between the two descriptions. Does not remove
  semantic disagreement (DTB says `compatible = "arm,pl011"` but the model implements different register
  behaviour), nor wrong `compatible` strings.
- Wrong: "All DTB bugs." Nudge: invent one.

**Q4 [R, replaces the strings-block question].** Your writer produces a blob with strings in a separate block.
Corrupt one byte of `off_dt_strings` in the header. Predict what the harness's independent reader reports
and what a *guest* would do. Which of these header fields would you check for a hostile DTB if the VMM were
*reading* one (ch21 firmware edits it)?
- Path: offsets and sizes are guest- or disk-controlled; check against `totalsize`, alignment, overflow.
  Same checks as ch04, applied to a different format.
- Wrong: "The strings block is only for saving space." Partial: also fine, but irrelevant to safety.

**[E] Predict.** Edit `machine.rs` so the PL011 node's `reg` has the address `0x0900_0000` but a size of `0x10`
and rerun `dtb-reader`. Then rewrite `/memory` `reg` to the wrong number of cells for its parent. Predict
the memory size `dtb-reader` prints. Expected: garbage or a parse error: the size is read from the wrong
offset. This is a controlled version of the "wrong DTB equals hang" lesson without Linux. `dtc -I dtb -O dts`
(if installed) shows the same blob decoded.

---

### 11 gicv3

Critique: Q1 and Q3 are good. Q2 is a recall question; make the failure visible.

**Q1 [K, concrete].** A level interrupt that the device never lowers: what does the guest see? Count.
- Path: the interrupt re-fires after every EOI, an interrupt storm; the guest makes no forward progress. The
  fault is the *device model's*: it must drop the line when the cause is cleared (reading `DR`, writing `ICR`).
  Evidence: count IRQs in the `irq` guest for one character.
- Wrong: "One interrupt per character." That is the edge-triggered mental model. Nudge: what makes a
  level line go low?

**Q2 [R, concrete, replaces the ordering question].** Create the GIC *after* the first vCPU. What happens? Then
move it before `hv_vm_create`. What happens?
- Path: ordering constraints come from the API: the GIC must exist after the VM and before any vCPU (read the
  header comment), because per-vCPU interrupt-controller state (redistributor) is created with the vCPU.
  (verify, K3.) Expected: an error return, not a mysterious hang.
- Wrong: "Order does not matter for objects." Nudge: what does a vCPU need from the GIC when it is created?

**Q3 [N, mechanism].** You inject an interrupt while the guest has `PSTATE.I` set (masked). When does the guest
run its handler? Where does the interrupt wait?
- Path: injection sets *pending* state in the GIC. Delivery depends on masks and priorities; the handler runs
  when the guest unmasks. This is the misconception check ("interrupts are state, not calls").
- Wrong: "At once, the handler runs." Nudge: what has the CPU been told about masking?

**Q4 [K, transfer, open-question candidate].** Why route device interrupts through an `IrqLine` instead of calling
HVF from devices?
- Path: devices stay testable on the host with no HVF (L1), are unaware of INTID numbering, and the same
  device works under a different interrupt controller. Also unsafe quarantine: only `hvf` has FFI.
- Wrong: "Style." Nudge: how would you test the PL011 on CI?

**[E] Predict.** In the `irq` guest, enable the RX interrupt but *do not* read `DR` in the handler. How many IRQs
does the guest report per typed character: 1, 3, or thousands? Expected: thousands until the guest masks
it or a watchdog stops (see Part C). Then change the DTB SPI cell from `1` to `0` (SPI vs PPI-type confusion)
and predict which INTID the guest sees. Expected: a different INTID (SPI n is INTID 32+n, PPI n is 16+n).

---

### 12 time

Critique: Q1 leans on ch26 (not seen). Q2 and Q3 are good. Turn Q2 into a measurement.

**Q1 [R, concrete; replaces snapshot reference].** `CNTVCT = mach_absolute_time() - vtimer_offset`. If we set the
offset to 0 and the guest reads `CNTVCT_EL0` at start, what value does it see? What would a guest that
started at boot see on real hardware?
- Path: with offset 0 the guest sees host uptime (days). A *virtual* counter with an offset lets the VMM present
  "time since this VM started" and later pause time (ch26 will need that). The guest should not learn the
  host's uptime. Park the snapshot half.
- Wrong: "The counter is the same as the host's, so there is no point." Nudge: what does it leak?

**Q2 [K, mechanism].** If WFI is implemented as "return immediately", what still works, and what is the cost?
- Path: everything is correct, because WFI is architecturally allowed to wake spuriously. The cost is a host
  core pinned at 100% for an idle guest. Measure with `top`.
- Wrong: "It breaks the guest." Nudge: read the Arm ARM definition of WFI.

**Q3 [N, mechanism].** The timer fired, the exit came, you made INTID 27 pending. The guest handles it but the
timer never fires again. What did you forget?
- Path: the vtimer is masked after the exit until we unmask it (`hv_vcpu_set_vtimer_mask(false)`); the guest
  must have reprogrammed `CVAL`/disabled `CTL` first. (verify, K3: the exact masking semantics with the
  in-kernel GIC.)
- Wrong: "The guest forgot to re-arm." Nudge: guest sets CVAL, but the line is still masked.

**Q4 [K, transfer, open-question candidate].** Who wakes a sleeping vCPU when a UART byte arrives?
- Path: the stdin reader thread: it sets the interrupt line and kicks the vCPU (`hv_vcpus_exit` or the wait
  primitive); the vCPU thread cannot wake itself. Foreshadows ch20.
- Wrong: "The guest wakes itself on interrupt." Nudge: the guest is asleep in *our* wait, not the CPU's.

**[E] Predict.** Run `guests/timer` with WFI as busy-return, and sample CPU with `ps -o %cpu -p $(pgrep macvmm)`.
Predict the percentage, then the percentage with a proper blocking wait. Expected: about 100% vs
about 0% (a few percent). Also predict whether the 95 to 150 ms interval check still passes in both
cases. It does; correctness and efficiency are different properties.

---

### 13 loaders

Critique: Q1 has a one-word answer. Q2 is the real material. Q3 is subtle and good.

**Q1 [R, concrete].** Your `Image` header at offset `0x10` is `image_size`. Patch it to `0xFFFF_FFFF_FFFF_FFFF`
with `printf ... | dd conv=notrunc`, and run. What should the loader do and what would a naive loader do?
- Path: a naive loader computes `base + image_size` and either overflows or allocates/zeroes a huge range.
  The right loader checks `checked_add` against RAM size and gives a named error. Evidence: the L1 corpus.
- Wrong: "The kernel would just not boot." Nudge: what does the *VMM* do before the kernel gets control?

**Q2 [K, mechanism].** What does `image_size` tell us that the file size does not?
- Path: the kernel's BSS and early page-table space are not in the file. Memory must be reserved for them or
  the initrd/DTB will be placed over memory the kernel clears. Hence the placement plan uses
  `image_size`, not file size.
- Wrong: "They are the same." Nudge: where does the kernel put its zero-initialised data?

**Q3 [K, mechanism].** What goes wrong if the initramfs overlaps the kernel's BSS?
- Path: the kernel zeroes BSS early, so the initrd is corrupted before unpacking, giving a "bad gzip/cpio"
  or a panic; the symptom is far from the cause. Our `BootPlan` makes overlap a testable error.
- Wrong: "The kernel reads the initrd first." Nudge: what does early boot do before anything else?

**Q4 [R, transfer, open-question candidate].** An ELF program header says `filesz = 4096, memsz = 2^40`. What is
the loader's rule, and which two numbers would you compare it with?
- Path: bound `memsz` and `filesz <= memsz` against the region of guest memory; zero the `memsz-filesz` tail
  within bounds. Same shape as ch04.
- Wrong: "Trust `memsz`, it is the loader's job to allocate." Nudge: whose RAM is it?

**[E] Predict.** Flip the first byte of the magic at offset `0x38` (`ARM\x64`) in a copy of the Image and run.
Does the VMM reject it, or does Linux fail to boot with no output? Expected: with your parser, a clear error;
without, a silent hang. (Run both: disable the check on a scratch branch.) Lesson: validation turns a
silent hang into an error message.

---

### 14 linux-boot

Critique: Q1 (nothing printed: first three checks) is the best diagnostic question in the course; keep. Q3 is
too vague.

**Q1 [K, diagnostic, concrete].** The kernel printed nothing. List the first three things you would check, and the
evidence each needs.
- Path: (1) Did the VMM reach the entry point at all (first exit in the trace, `pc`)? (2) Is the DTB at the
  address in `x0`, and does `earlycon` point at the PL011 address (dump with `--dtb-out`)? (3) Where is the
  PC *now* (last-N exits, register dump on Ctrl-C), and is it stuck in a loop or waiting on a timer/IRQ?
  Order by cost: trace and dump first, guesswork last.
- Wrong: "Rebuild the kernel with debug." Nudge: what do you have before touching the kernel?

**Q2 [N, mechanism].** Map five lines of your boot log to the DTB node or device that caused them (use the
annotator lab). Which line proves the GIC works? Which proves the timer?
- Path: e.g. "GICv3: ... redistributors" comes from the `/interrupt-controller` node; "arch_timer: cp15 timer"
  from `/timer`; "ttyAMA0 at MMIO 0x9000000" from PL011 and its ID registers (resolves the ch09 guess).
- Wrong: "The kernel prints what hardware it finds." Nudge: find where it *found* it.

**Q3 [K, mechanism].** Which parts of our machine did Linux use that your test guests never did?
- Path: ID registers, PrimeCell clock (`apb_pclk`), timer PPI, GIC redistributors, PSCI at boot, `/chosen`
  parsing, cache maintenance. Each is a thing the DTB promised.
- Wrong: "All the same." Nudge: grep the guests for `0xFE0`.

**Q4 [R, transfer, open-question candidate].** Linux booted. List three things a useful VM must do that this
one cannot. Rank by which you would build first and defend the order.
- Path: persistent storage, networking, more than one CPU, a clean shutdown/reboot. Order depends on use; the
  answer shows a justification, not a ranking.
- Wrong: "Nothing, it boots." Nudge: where did the file system live?

**[E] Predict.** Remove the `/timer` node from the DTB (flag, or edit in `machine.rs`), boot, and predict the
last line of the serial output. Then remove only the GIC `interrupts` property from the PL011. Expected:
the first hangs at the clocksource/calibration area with no further output; the second lets the console
work but input never arrives. (verify, K3; capture both in `captures/`.) The first is the injected failure
in objective 2.

---

### 15 virtio-mmio

Critique: Q1 and Q2 are strong. Q3 (empty slots in DTB) is a trick question with a good answer; keep. Raise
the transport/shared-memory misconception into a question.

**Q1 [N, concrete].** Read the `MagicValue`, `Version` and `DeviceID` from every slot using `virtio-probe` and
print them. What does the guest see in slots where we have no device?
- Path: magic and version are valid; `DeviceID = 0` means "no device here". The DTB lists all slots so the
  driver can find them by address without being told in advance which are populated.
- Wrong: "Empty slots would read all ones, like unmapped memory." Nudge: the spec defines a value.

**Q2 [K, mechanism].** Why does feature negotiation need a `FEATURES_OK` step that the *device* can refuse?
- Path: the driver writes which features it accepts, but only the device knows if the combination is
  unworkable; reading the status back after setting `FEATURES_OK` and seeing it cleared is the refusal. It
  avoids a half-configured device that silently misbehaves.
- Wrong: "Features are advertised, so any subset is fine." Nudge: could a driver accept a feature the device
  never offered?

**Q3 [K, mechanism].** `ConfigGeneration` exists for a race. Describe it.
- Path: device config space is read in several MMIO reads; the device may change it between them (e.g. a
  block device's capacity), so the driver reads generation, then the fields, then generation again and
  retries on mismatch. This is the guest's TOCTOU, built into the spec.
- Wrong: "Config never changes." Nudge: read the virtio 1.2 section on config generation.

**Q4 [N, transfer, open-question candidate].** The driver writes `QueueDescLow/High`, a guest physical address,
into a register. What check must you run *before* storing it, and what can go wrong after you store it?
- Path: validate alignment and that `desc + size*16` fits in guest memory (checked arithmetic); do not
  resolve to host pointer yet. The guest can still unmap, change, or reuse it (ch16's TOCTOU).
- Wrong: "Store it, check at first use." Nudge: first use might be far from the guilty write, and by then the
  state machine has moved.

**[E] Predict.** Write a guest that sets `QueueReady = 1` *before* the `FEATURES_OK` step and then notifies.
Does the device (a) accept it, (b) ignore it, (c) set `DEVICE_NEEDS_RESET`? Expected: per spec order, a
careful device rejects or ignores; your state machine decides. Predict, then check the spec's wording
on what a device must do on out-of-order writes.

---

### 16 virtqueues

Critique: the core of G3. Questions are good but sit at the end of a very long chapter. Add a concrete first
step and split. 5 questions.

**Q1 [N, concrete].** The available ring's `idx` is 0xFFFE, then the guest bumps it by 4. In `u16` arithmetic,
how many new entries do you see? How many if it jumped by 65535?
- Path: wrapping subtraction `new.wrapping_sub(old)` gives 4. A jump larger than the queue size is
  impossible for an honest driver, so it is a hostile or broken guest and the device must go to
  `NEEDS_RESET`. Cap it; do not loop 65535 times.
- Wrong: "`new - old` would be negative, so no entries." Nudge: what does `u16` do on overflow?

**Q2 [K, mechanism].** Why is `avail.idx` a free-running 16-bit counter rather than a ring index?
- Path: to distinguish full from empty without wasting a slot or an extra shared flag, and to let each side
  own one counter (writer owns `idx`, reader owns its private last-seen). Wrapping subtraction tells how
  many are pending.
- Wrong: "To save memory." Nudge: what would happen if idx were reduced modulo size and the ring is full vs empty?

**Q3 [K, security core].** The guest can rewrite a descriptor while we walk it. Which of our checks still hold
afterwards?
- Path: only checks made on the copy we then use. Index range and chain length on the *copy*; `addr+len` on the
  copy; direction flag on the copy; we then fetch the data region itself, which may also change under us, so
  copy it too or parse it once. Rubric (CURRICULUM 6.1): names copying before validating; notes checks are on
  the copy; mentions that ring indices can be re-read.
- Wrong: "All of them, we checked." Nudge: which of them read from guest memory twice?

**Q4 [K, mechanism, deep].** What exactly does the release fence order, and what bug appears without it on arm64
that you may never see on x86?
- Path: it orders our writes to the used ring *entry* before the `used.idx` update; the guest reads `idx`,
  then the entry. Without it, the guest may see the new index but stale entry. arm64 is weakly ordered; x86 is
  strongly (stores are not reordered with other stores), so the bug hides there. Also: the host CPU may reorder
  too, not just the compiler.
- Wrong: "It makes the write atomic." Nudge: atomic and ordered are different properties.

**Q5 [N, transfer, open-question candidate].** The same chain is valid when read as `[readable header,
writable data, writable status]`. A hostile guest sends `[writable header, readable data, readable status]`.
What does your blk device do, and what would a naive one do?
- Path: direction flags are guest-controlled data; the device must check them against the protocol before
  using any buffer. A naive device writes a status to a *readable* (maybe shared, maybe read-only) buffer.
- Wrong: "The driver always sends it right." Nudge: what driver?

**[E] Predict.** Using the `virtqueue-visualizer` in hostile mode (or a host-side test), create a descriptor
whose `next` points to itself, run your walker *with the loop cap commented out*, and predict: panic, error,
or hang. Expected: hang (a CPU-burning vCPU thread or device thread), the denial of service this chapter is
named for. Run under `timeout 5`. Part C makes this a mandatory break.

---

### 17 virtio-rng-console

Critique: Q1 and Q2 are good. Q3 is fine. Ensure the "exits per KB" measurement is the evidence for the
misconception.

**Q1 [N, concrete].** Write 4 KiB to the PL011 and 4 KiB to `/dev/hvc0`, with the exit trace on. Count exits
for each. What is the ratio, and what does one `QueueNotify` buy?
- Path: PL011: about one exit per byte plus status polling; virtio-console: a few exits per batch (notify
  + used interrupts). The cost is amortised over a batch. Compare with the ch03 estimate.
- Wrong: "virtio code is faster." The misconception. Nudge: what is the per-byte cost in *exits*?

**Q2 [K, mechanism].** The guest gave us a 1 MiB writable buffer. How much must we fill, and what do we report in
`used.len`?
- Path: we may fill any amount up to the buffer; `used.len` is what we actually wrote. A host `getentropy`
  call is capped at 256 bytes, so fill in loops. Never claim more than written (guest reads uninitialised
  memory it thinks is random) and never write beyond the descriptor length.
- Wrong: "Always report the buffer length." Nudge: what does a driver do with those bytes?

**Q3 [K, mechanism].** Why does a console want two queues when a UART needs none?
- Path: virtqueues are one-directional shared-memory channels (receive and transmit). A UART has a register
  to hold a byte; a queue holds many, so it needs one per direction.
- Wrong: "One queue can be bidirectional." Nudge: who owns the buffers in the descriptor?

**Q4 [N, hostile, open-question candidate].** The guest posts a writable buffer of length `0`. What does the
rng device do, and what is the right response in `used.len`?
- Path: zero-length is legal in some device types; fill nothing, return 0, do not hang waiting for more. Cheap
  corner-case drill for the hostile corpus.
- Wrong: "Return an error." Nudge: is an empty buffer an error in the spec?

**[E] Predict.** Use `dd if=/dev/hwrng bs=1M count=1 | wc -c` in the guest. How many bytes arrive, how many
queue notifications fire (count with the trace), and would a 4 KiB buffer change the total? Expected: 1 MiB;
exit count scales with buffers posted, not bytes.

---

### 18 virtio-blk

Critique: very strong set. Keep all three; add a concrete first.

**Q1 [N, concrete].** Compute for `sector = 0x1FFF_FFFF_FFFF_FFFF`: what is `sector * 512` in `u64`, and what
would a file `pread` do with it?
- Path: wraps, so a small offset is accessed, reading a *different* sector than requested, or a huge value
  (checked_mul rejects). In the unchecked case the guest could read the host file's own
  headers/other disks if the backend is a raw file you share. Return `IOERR`.
- Wrong: "pread would fail on a bad offset." Nudge: wrapped offsets are not bad, they are valid and wrong.

**Q2 [K, hostile].** What is the worst thing a guest can do to the *host* through virtio-blk if one bounds check
is missing?
- Path: read or write outside the disk image: other files if the backend isn't confined; read host memory if
  the *data buffer* address is unchecked; arbitrary host memory write via an `IN` request into a forged
  descriptor. Contrast: file offset (info leak / corruption of the image) vs memory address (host compromise).
- Wrong: "Corrupt its own disk, so only itself." Nudge: what else does the file offset reach?

**Q3 [K, mechanism].** Why does macOS `fsync` not mean what Linux `fsync` means, and which does a guest's `FLUSH`
need?
- Path: macOS `fsync` flushes to the drive but the drive may keep it in its volatile cache; `F_FULLFSYNC` asks
  the drive to flush too. A guest filesystem uses FLUSH as a durability barrier, so `F_FULLFSYNC` is the
  honest implementation. Cost: much slower. Document the trade.
- Wrong: "`fsync` is `fsync`." Nudge: read `man fsync` on this Mac.

**Q4 [K, design, open-question candidate].** Read-only disk: refuse writes (`IOERR`) or drop them? Defend from the
guest's view.
- Path: refuse: silently dropping makes the guest believe data is durable (violating FLUSH meaning). Better
  still: advertise `VIRTIO_BLK_F_RO` so a correct driver never tries.
- Wrong: "Drop them; it is simpler for the guest." Nudge: what does the guest believe afterwards?

**[E] Predict.** In the guest, time `dd if=/dev/zero of=/f bs=1M count=64 conv=fsync` with FLUSH mapped to
`fsync`, then `F_FULLFSYNC`. Predict the ratio. Expected: a clear gap, order of magnitude or less, depending on
the drive (verify, K3). Also: `kill -9` the VMM mid-write. Is the file lost? Honest note for the lesson: the
OS page cache survives a process kill, so only a power cut shows the difference; the experiment shows latency,
not corruption. Do not tell learners that `kill -9` reproduces the bug.

---

### 19 virtio-net

Critique: Q1 is excellent. Q2 and Q3 are speculative; ground them in observable behaviour.

**Q1 [K, concrete].** RX buffers are posted by the guest, but packets arrive whenever. Where does a packet
wait, and what do we do when there is no buffer?
- Path: in a host-side queue/socket buffer; when no guest buffer is available, drop and count (never block
  the vCPU or the TX path), as the physical NIC would drop. Backpressure from the guest should not stall
  the host thread that also runs the vCPU.
- Wrong: "Block until the guest posts one." Nudge: whose thread blocks, and can the guest unblock it?

**Q2 [R, concrete].** Blast 10,000 small datagrams at VM B from a loop on the host and count what `ip -s link`
reports in the guest. Where did the missing ones go, and which counter in your VMM says so?
- Path: some drops are in the socket buffer (kernel), some at the device (no RX buffers). Distinguish with your
  own counters. Real networks are lossy, and TCP copes.
- Wrong: "All 10,000 arrive; it is local." Nudge: look at the numbers.

**Q3 [R, mechanism].** Why doesn't `unixgram:` need any entitlement, and what is it *not* able to do?
- Path: it uses plain sockets on the host with filesystem permissions; no access to the real network. So no
  NAT or DHCP to the Internet; vmnet is the road to that and is gated. (Why Apple gates it: the host's
  network becomes reachable from a guest, a stronger capability. Treat as reasoned inference, not fact.)
- Wrong: "Because the sockets are local." Nudge: what do you lose?

**Q4 [K, transfer, open-question candidate].** Which feature (checksum offload, TSO, mergeable buffers) would you
add first for speed, and what new parsing risk does each bring?
- Path: each makes the guest pass bigger or partial packets, so the device must parse headers (lengths,
  offsets) from a hostile guest. Speed buys attack surface. Mergeable buffers: multiple descriptors per
  packet means a counted loop with a cap.
- Wrong: "No risk; it is optional." Nudge: who writes `csum_start`?

**[E] Predict.** Send a frame whose `virtio_net_hdr` is 10 bytes (old legacy size) instead of 12. Predict whether
the guest's IP stack sees a valid packet, a corrupted packet, or nothing. Expected: misaligned: every
field is off by two bytes. This is the misconception "a network device needs a network" inverted: framing
matters even without one.

---

### 20 smp

Critique: Q1 and Q2 are strong. Q3 is minor. Make the MPIDR-DTB mismatch an experiment.

**Q1 [K, mechanism].** How does another thread make a running vCPU stop, and what must be true before it
resumes?
- Path: `hv_vcpus_exit` kicks it out of `hv_vcpu_run`; then it must re-enter with state consistent (pending IRQ
  set, PC unchanged unless handled, no half-emulated instruction). The vCPU thread owns its registers;
  others must not touch them while it runs.
- Wrong: "Send a signal to the thread." Nudge: the thread is inside the framework, in guest mode.

**Q2 [K, concurrency].** Two vCPUs notify the same virtqueue at once. Which data is shared, and where must the
critical section begin and end?
- Path: the queue's private state (`last_avail`, the used index, the backend). Begin before reading `avail.idx`,
  end after publishing used and updating interrupt status. Not around the long backend I/O.
- Wrong: "Lock the whole device on every MMIO." Nudge: what does that do to throughput and to a blocking
  backend?

**Q3 [N, concrete].** Boot with `--cpus 2` but give both vCPUs the same MPIDR. What do you see in
`nproc`, `dmesg` and the PSCI return?
- Path: the second `CPU_ON` returns `ALREADY_ON` (or `INVALID_PARAMETERS` for an unknown MPIDR); one
  CPU runs; Linux says the CPU failed to come up. The DTB `reg` values, `MPIDR_EL1` and the GIC redistributor
  index must agree (ch06 Q3 is answered).
- Wrong: "Both CPUs run, they just have the same ID." Nudge: how would PSCI name each?

**Q4 [K, transfer, open-question candidate].** Why does `CPU_ON` take a context ID, and where does it land?
- Path: it is passed in `x0` of the new CPU so the entry code finds its per-CPU data without any shared
  memory protocol. A small piece of the "registers are the API" idea.
- Wrong: "It is the CPU number." Nudge: who chooses it?

**[E] Predict.** Run the `stress` script on 4 CPUs with the device lock removed from the PL011 (on a scratch
branch) and predict the symptom: lost/garbled characters, a crash, or a hang. Expected: interleaved
or lost output at least; with luck a data race that Rust prevents because the mutation is behind
`Mutex`; so first predict whether the code *compiles* without the lock. Lesson: in safe Rust the
race becomes a compile error; the failures left are logic races (ordering across two locks).

---

### 21 firmware

Critique: Q1 is good. Q2 (writes to flash) is excellent and concrete. Q3 is nice but needs the experiment.

**Q1 [K, concrete].** We can boot Linux directly. Name one thing firmware gives a guest that direct boot
does not.
- Path: a boot menu/loader, support for disks with partitions, EFI services for OSes (FreeBSD needs them),
  a generic kernel entry. Direct boot requires the host to know the kernel's format.
- Wrong: "Nothing, it is legacy." Nudge: what do other OSes expect?

**Q2 [K, mechanism].** The firmware runs from flash. What happens when it writes its environment there?
- Path: flash is read-only memory with writes trapped (stage-2 mapping read-only, so the write is an abort
  exit); real flash needs CFI commands to unlock, erase and program. If we do nothing, U-Boot prints an
  error or hangs; "no environment" is a valid answer (CURRICULUM objective 1).
- Wrong: "It writes and it works, it is memory." Nudge: look at the first abort in the trace.

**Q3 [K, mechanism, open-question candidate].** Who owns the DTB in firmware boot, and what if the firmware edits it?
- Path: we place it (start of RAM by QEMU `virt` convention); firmware may add `/chosen` or fix `/memory`;
  firmware passes its own copy to the OS, so ours must be treated as input (the same hostile-parser rules).
- Wrong: "The OS gets our DTB unchanged." Nudge: where does U-Boot's `bootefi` get its fdt?

**Q4 [N, concrete].** Boot U-Boot and run `fdt addr $fdtcontroladdr; fdt print /` (or `bdinfo`). Where
does it say our DTB is, and does it match what you placed?
- Path: confirm with evidence; mismatch means a boot-protocol mistake (registers or address). The learner
  reads U-Boot's view of *our* machine, a reversal of roles.
- Wrong: "It found it; that is enough." Nudge: compare addresses.

**[E] Predict.** Change the flash mapping from read-only to read-write (a one-line edit) and run U-Boot.
Predict: does `saveenv` work? Does anything else change? Expected: writes land in your RAM-backed region but
there is no flash command protocol, so the environment is not recognised after reboot (verify, K3). The
lesson: "read-write memory" is not "flash".

---

### 22 freebsd

Critique: Q1 is a very good judgement question. Q3 (what proves "working") is excellent. Keep all three, add
a concrete diff step.

**Q1 [K, judgement].** Linux boots, FreeBSD does not. Is our machine wrong, or is FreeBSD? How do you decide?
- Path: ask what the guest expected and where it read it (DTB property, UEFI table, register). Check the spec
  and QEMU `virt` as a reference. If QEMU boots it with the same DTB property set, ours is wrong; if the spec
  says optional, FreeBSD is demanding. Primary sources decide, not majority vote.
- Wrong: "FreeBSD is less mature." Nudge: what evidence?

**Q2 [N, concrete].** Dump the DTB QEMU `virt` produces (`-machine dumpdtb=` if you have QEMU) and diff it
with `--dtb-out`. Which three differences might matter to FreeBSD?
- Path: compare properties like `clocks`, `status`, `interrupt-parent`, GIC `compatible`. Evidence-based
  triage. (Optional if QEMU is not installed: use the pinned `docs/compat` captures.)
- Wrong: "No difference matters." Nudge: pick one and predict a symptom.

**Q3 [K, transfer, open-question candidate].** What evidence would convince you that a FreeBSD boot is "working"
and not merely "printing"?
- Path: login, a disk write, networking, timer, clean shutdown, SMP; each exercises a subset; define a
  test list before declaring success (R1 in the capstone rubric).
- Wrong: "I saw the banner." Nudge: what did the banner require of the machine?

**Q4 [K, mechanism].** What does UEFI give an OS that a DTB alone does not?
- Path: runtime services (variables, reset, time), a standard memory map, boot-device discovery, a loader
  protocol; a DTB only describes hardware.
- Wrong: "The same thing in a different format." Nudge: which is a table, which is a service?

**[E] Predict.** Remove `apb_pclk` from the PL011 node (or change its clock frequency) and predict if FreeBSD
or Linux is the first to complain, and what the log says. Expected: differs by OS (verify). The lesson is the
misconception: "one OS boots" does not mean "the machine is correct".

---

### 23 vz-macos

Critique: Q1 is a good provocation. Q2 and Q3 are fine but need a stated evidence source (the tool's
entitlements, `strings` on a framework header). Make the comparison concrete.

**Q1 [K, judgement].** Apple offers a working macOS VM in a few hundred lines of Swift. Why would anyone go the
low road?
- Path: control, transparency, learning, other guests, a different security model; honest answer includes
  "mostly you would not". Rubric: both sides present.
- Wrong: "VZ is limited." Nudge: name one thing macvmm can do that VZ cannot.

**Q2 [N, concrete].** Diff the entitlement plist of `tools/vz-mac` and of `macvmm` (`codesign -d --entitlements :-`).
What does each right allow, and which gives the guest a larger attack surface?
- Path: VZ's entitlement lets Apple's code define the machine and devices; ours allows raw HVF where *we*
  define every device. Attack surface for us = our device code; for VZ = Apple's code. Compare, do not
  rank blindly.
- Wrong: "VZ is safer, case closed." Nudge: who audits each, and who can patch?

**Q3 [K, mechanism].** Which of VZ's devices are standard (virtio) and which are Apple-specific?
- Path: list from the VZ configuration classes; virtio-blk/net/console/entropy are standard; graphics,
  keyboard/pointer, platform-specific devices are Apple's. Evidence: the class names.
- Wrong: "All virtio." Nudge: how does the guest get a display?

**Q4 [N, transfer, open-question candidate].** From the VZ inventory, write the list of pieces a low-level VMM
would have to provide. Which three do you expect to be hardest and why?
- Path: boot ROM, platform ID/auxiliary storage, Apple devices, GPU. Each hard thing is hard because it is
  undocumented, not because it is complex.
- Wrong: "The CPU stuff." Nudge: we already did that.

**[E] Predict.** Before running the VZ tool: how long until the install progress shows 1%? How big is the IPSW,
and how many GB will the disk image occupy on host? Check against `ls -ls`. Expected: multi-GB, sparse
file. (Optional step per CURRICULUM.) Also predict whether the tool boots if you remove its entitlement
(fails at runtime, as in ch00).

---

### 24 vmapple

Critique: Q1 is the best question in the capstone; keep. Q2 is important but not testable. Q3 is wish
fulfilment; turn it into a judgement about the *next device*.

**Q1 [K, diagnostic].** What separates "the firmware stopped making progress" from "the firmware is waiting
for a device we do not have"? How would the trace tell them apart?
- Path: look at the last exits: a polling loop on one IPA with the same value (waiting on a status
  bit) vs a PC in a tight loop without exits or in an exception handler (stuck). Evidence: the exit
  trace around the final records and the PC distribution.
- Wrong: "Both just look like a hang." Nudge: count exits on the last 10 ms.

**Q2 [N, concrete].** In your annotated trace, take the first unhandled access. Write three hypotheses of what
register it is, and for each the *cheapest experiment* that would separate them.
- Path: return a distinct value per hypothesis (0, all ones, a plausible ID) and see whether the next
  access changes (a controlled experiment, labelled observed vs inferred).
- Wrong: "Guess the right answer and implement." Nudge: how would you know if it was right?

**Q3 [K, judgement].** Where does reverse engineering end and redistribution begin, and how does "load from
the host, never copy" respect it?
- Path: we do not ship Apple's ROM; we read it from a licensed host install; research notes cite
  observations, not copied bytes. The learner states the rule and a case near the edge.
- Wrong: "If it is on my machine it is fine." Nudge: what does the repo contain?

**Q4 [R, transfer, open-question candidate].** After the first five devices, what would convince you to stop
and write "this is not feasible in the time we have"?
- Path: criteria set in advance: devices that need undocumented crypto, repeated unknown poll loops, no
  observable progress per day. Honest reporting is part of the engineering (misconception).
- Wrong: "Never stop." Nudge: what is the cost of continuing?

**[E] Predict.** Return all-ones for every unhandled read in AVPBooter's MMIO and predict the number of
distinct IPAs touched before the next hang, versus returning zero. Compare the two traces. This is an
experiment with "unknown" as a valid outcome. (Guarded behind the feature flag.)

---

### 25 security

Critique: Q1 is great. Q2 is great. Q3 is an opinion; rewrite as a ranking with evidence from the learner's
own fuzzer.

**Q1 [K, threat modelling].** An attacker fully compromises the VMM process. What can they do next, and which of
our decisions limit that?
- Path: everything the process can do: files readable by the user, network, other processes' ports; limits:
  minimal entitlements, no network entitlement, sandbox profile, no secrets, descriptors closed at start.
  The learner lists assets and the *specific* mechanism that guards each.
- Wrong: "They own the Mac." Nudge: what *specifically* does the sandbox profile deny?

**Q2 [K, mechanism].** Name a bug class that Rust's memory safety does not prevent in this VMM.
- Path: logic errors; resource exhaustion; infinite loops; TOCTOU on shared memory (our `forbid(unsafe_code)`
  does not cover guest-shared pages); confused deputy (the disk path the guest names). Pick one and show an
  instance in your code.
- Wrong: "None; Rust is memory safe." The misconception.

**Q3 [R, evidence].** After your fuzzer finds the three planted bugs, rank them by exploitability and justify
using *what the attacker controls and what breaks* (STYLE.md Security callout).
- Path: missing `checked_add` leads to out-of-bounds host access (worst); missing loop cap leads to DoS;
  off-by-one in a ring index leads to a read of stale entry/crash. Rank with reasoning, not feeling.
- Wrong: "The loop is worse, it hangs everything." Nudge: hang vs read/write of host memory.

**Q4 [N, transfer, open-question candidate].** Your fuzzer is structure-aware. What input shape does it never
generate, and what bug could hide there?
- Path: the generator's grammar encodes the author's assumptions; bugs live outside it. Add a
  random-byte mode, or mutate the mutator. A humility question.
- Wrong: "It generates everything." Nudge: what do all your seeds have in common?

**[E] Predict.** Plant one bug in the copy of `queue.rs` (drop the loop cap), run your fuzzer with a time limit,
and predict how long it takes to find it, for 10 s, 10 min, or never. Record the actual time. Then
plant a bug requiring a specific sequence of three descriptors and predict again. Expected: the second
takes far longer; the lesson is coverage and structure.

---

### 26 snapshots

Critique: Q1 is a very good judgement question. Q2 and Q3 are good. Make the vtimer offset bug an
experiment, since it is the misconception made visible.

**Q1 [K, consistency].** Is a snapshot taken while a virtio request is in flight consistent? With what, exactly?
- Path: with the *device model's* state, only if virtqueue indices, the used-ring and the backend I/O are
  saved at a quiesce point; otherwise the request is lost or replayed; options: wait for in-flight
  requests to complete before pausing, or save and re-issue. The guest cannot tell if we are
  consistent about FLUSH.
- Wrong: "RAM is saved so it is consistent." Nudge: where does the backend's pending I/O live?

**Q2 [N, concrete].** The `counter` guest is restored. It prints uptime. What number do you see if you did not
recompute `vtimer_offset`, and what if you did?
- Path: `CNTVCT` is host counter minus offset, so after a pause the host counter has advanced and the guest
  jumps forward by the pause duration (or the timer fires immediately); recomputing keeps guest time
  continuous. (verify, K3.)
- Wrong: "Time is part of RAM." Nudge: where is it computed from?

**Q3 [K, hostile].** Why can a snapshot file be an attack vector, and against whom?
- Path: it contains sizes, offsets, register state; a tampered file can overflow your parser (the VMM),
  or set the guest into states that the hardware or guest kernel cannot reach legitimately (against the
  guest's integrity), or a shared snapshot executes attacker-chosen RAM. Treat restore like ch13/16.
- Wrong: "I made the snapshot, so it is safe." Nudge: who else can write the file?

**Q4 [K, transfer, open-question candidate].** What extra state would live migration to a *different* Mac
need?
- Path: CPU feature differences (ID registers must match or be masked), host page size, timer frequency, GIC
  version, dirty-page tracking, network state. Anything we read from the host at start.
- Wrong: "Just copy memory." Nudge: what do `ID_AA64*` registers say?

**[E] Predict.** Snapshot `guests/counter` at a random point, `sleep 30`, then restore. Predict the uptime shown
after restoring: continues at old value, jumps by about 30 s, or resets. Expected: depends on the
offset policy; the intended behaviour is "continues". Also flip one byte in the file's checksum
region and predict the restore result (clean refusal, not a crash).

---

### 27 debug-perf

Critique: Q1 is an excellent security question. Q2 is a strong design question. Q3 is vague
("the last real bug you fixed").

**Q1 [K, security].** A debugger can read and write guest memory. Why is binding to `127.0.0.1` not the whole
security story?
- Path: any local process (and any other user on the machine, or a browser via a localhost request) can
  connect; there is no authentication in RSP; a debugger that writes memory can change what runs in
  the guest, and reading it exposes guest secrets. Mitigations: opt-in flag, Unix socket with permissions, a
  one-time token. The stub must also validate packet sizes and addresses (the same hostile rules).
- Wrong: "Localhost means only me." Nudge: which other processes run as you?

**Q2 [K, design].** Your profile says 60% of exits are one MMIO register. What are your options, and which change
the machine the guest sees?
- Path: make the handler faster (no machine change; small gain); batch or suppress notification (changes
  protocol use, e.g. event index); move to a paravirtual device (changes machine, DTB); cache register
  values (changes semantics, risky). Rank by exits removed.
- Wrong: "Optimise the handler." The misconception. Nudge: what is the cost of an *exit*, not the handler?

**Q3 [N, concrete].** Single-step three instructions in LLDB over the guest's `_start`. After each, what changed
in the registers, and how did the stub get control back after each step?
- Path: `MDSCR_EL1.SS` makes the CPU raise a debug exception after one instruction, trapped to the VMM
  (`hv_vcpu_set_trap_debug_exceptions`); the stub reports the stop; the PC advanced by one instruction.
- Wrong: "The stub emulates the instruction." Nudge: who executed it?

**Q4 [R, transfer, open-question candidate].** Pick the last bug you found in this course. Which layer of the
test pyramid would have caught it earliest, and what test would you now add?
- Path: map the bug to the cheapest layer that exposes it (the L1 contract for parsing, HVF run for sysregs);
  write the test. The learner supplies the bug (concrete, theirs).
- Wrong: "End-to-end boot." Nudge: what is the cost per run?

**[E] Predict.** Run the exit profiler on a Linux boot, and predict the top exit kind and top IPA before
looking. Then run it with `--console` on and predict how the histogram changes. Expected: PL011 `DR`/`FR` dominate
a serial boot; virtio notifies replace them with the console. Record guess vs result in the journal.

---

## Part C. Productive failure: moments where we deliberately let the VMM break

Principle. A failure is *productive* when (a) the learner has predicted first, so the surprise is
informative, (b) the tools to diagnose it already exist (trace, register dump, last-N exits), (c) the failure
is bounded in time and cannot damage the host, and (d) the debrief names the misconception. Do not stack
failures before the learner has the diagnostic tool; ch07's exit trace and ch06's register dump come before
the first hard failures for exactly that reason.

### C.1 Mechanics (proposal for the harness)

- `scripts/learner break NAME` applies a small, reversible patch to the learner's *own* tree (a git stash-style
  patch with a tag), not the reference. `scripts/learner unbreak` reverts it. Both print the symptom
  to look for, never the cause. The learner is always in git, so this is safe.
- Every break runs under a **watchdog** (`timeout`, default 10 s) so hangs end themselves and report "hung,
  as expected, here is what to dump".
- Each break asks first: "Predict: what will you see?" and records the guess in the journal.
- Time-box: 10 minutes to form a hypothesis, then a hint ladder (the same 1 to 4 as `learner hint`).
- STYLE.md fit: these are **Try it** callouts for the optional ones and the main-line step for the marked
  mandatory ones (STYLE.md 6, "show failure on purpose"; mark clearly).

### C.2 Catalogue

| Ch | Break (applied by `learner break`) | Symptom | What it teaches (misconception exposed) | Req |
|----|------------------------------------|---------|-----------------------------------------|-----|
| 00 | Run the doctor probe unsigned | Runtime denial from `hv_vm_create` | The gate is runtime, in the kernel, not the linker | Mandatory |
| 01 | Use `u32` for `hv_vcpu_t` in the FFI struct | Works for the first vCPU, then odd values/corruption (verify, K3) | Types are our promise at the FFI boundary | Optional |
| 01 | Create a second VM in-process | Error return | One VM per process shapes the architecture | Mandatory |
| 02 | Remove the `b .` safety net | Exit at tiny IPA: an instruction abort, not "undefined instruction" (verify, K3) | Guest exceptions are handled in the guest first | Mandatory |
| 02 | Remove the `hvc` | `hv_vcpu_run` never returns | A run call with no exit is a hang; we need a way to stop a vCPU | Mandatory |
| 03 | Remove BSS zeroing and fill RAM with `0xA5` | Static variable prints garbage | We provide the bare-metal runtime guarantees | Optional |
| 04 | `checked_add` replaced by `+` in `GuestMemory` | Wrapped address passes the check; the contract test panics or reads out of range | Bounds-checking requires overflow checking | Mandatory |
| 04 | Return `&[u8]` into guest memory while a second thread flips bytes | Check passes, use sees different value (TOCTOU) | Check-then-use on shared memory | Mandatory |
| 05 | Mis-set `ipa_size` below the layout's highest device | RAM mapping fails or the exit shows an address fault, not translation | The map has a width limit; a layout has a size | Optional |
| 06 | Skip writing `x0 = DTB` / wrong `CPSR` | Guest sees wrong `x0`, or runs at the wrong EL; `regcheck` fails with a clear diff | Reset state is a contract (`booting.rst`) | Optional |
| 06 | Run `self-fault` | Second-order fault exit; first fault is in `ESR_EL1` | Not every guest exception is an exit | Mandatory |
| 07 | Delete the PC advance after a data abort | Identical exit forever; the trace fills with the same record | The VMM, not the hardware, advances the PC on this class | Mandatory |
| 07 | Ignore SRT = 31 (`xzr`) | A store from `xzr` writes a garbage value (the host's `x31`/sp) | Register 31 means zero here and sp there | Mandatory |
| 07 | Emulate `ldp` by guessing | Works for one case, breaks for another | We emulate accesses, not instructions | Optional |
| 08 | Return 0 for all unknown sysregs | `sysreg-probe` passes while lying about CPU features | Policy per register; silence is a decision | Mandatory |
| 08 | Forget `SYSTEM_OFF` | Process never exits; watchdog reports hang | Guests need an agreed way to say "done" | Optional |
| 09 | `FR` always reports `RXFE = 1` or `TXFF = 1` | Guest spins forever (echo), or never sends | Status registers are half the data path | Mandatory |
| 10 | Change `#address-cells` on the root | `dtb-reader` prints garbage sizes | The DTB is parsed, not read; cell counts are structure | Mandatory |
| 10 | DTB lists a device the bus lacks | Guest touches unmapped IPA; our "unhandled MMIO" message | DTB and bus must agree (understanding 4) | Optional |
| 11 | Never lower the level line | Interrupt storm; count climbs; no progress | Level vs edge; the device owns the line | Mandatory |
| 11 | Create GIC after vCPU | API error | Ordering is part of the contract | Optional |
| 12 | WFI returns immediately | Host core at 100% for an idle guest (checkpoint's CPU rule trips) | Correct is not the same as efficient | Mandatory |
| 12 | Never clear the vtimer mask | Timer fires once and never again; guest hangs on sleep | Hardware mask state is ours to manage (verify, K3) | Mandatory |
| 13 | Place the initrd inside the kernel's BSS range | Boot gets far, then a bad-cpio/panic symptom far from the cause | `image_size`, not file size, defines the footprint | Mandatory |
| 14 | Remove the `/timer` node; remove the PL011 ID registers; wrong GIC redistributor base | Three distinct symptoms (in CURRICULUM objective 2) | "The DTB is a promise"; each symptom has a specific fingerprint | Mandatory |
| 15 | Accept queue writes after `DRIVER_OK` | The hostile test corrupts a live queue or the L1 test fails | State machines are security boundaries | Optional |
| 16 | Remove the loop cap and walk a self-looping chain | Device thread pegged, no return (under `timeout`) | Hostile guests can hang us without any memory bug | Mandatory |
| 16 | Re-read `desc.len` after validation | Differential/hostile test fails only with a racing writer | TOCTOU; validation applies to the copy | Mandatory |
| 16 | Remove the release fence | Probably invisible on this Mac in a test; shown instead through a litmus-test lab. Be honest in the lesson: we can *explain* but may not *reproduce* it | Weak memory is real, and absence of failure is not evidence | Optional (lab only) |
| 17 | Report `used.len = buffer length` regardless | Guest reads uninitialised bytes as entropy | The device must report what it did, not what was asked | Optional |
| 18 | Unchecked `sector * 512` | A wrapped offset reads the wrong sector, or the hostile test escapes the file | Overflow and confused deputy on the file | Mandatory |
| 18 | FLUSH as a no-op | Boot works; no visible failure under `kill -9` (explain why!) | Durability bugs hide until power loss; page cache survives process death | Optional (explain-back) |
| 19 | Block the vCPU thread when there is no RX buffer | Guest stalls whenever traffic arrives faster than it posts buffers | A device must never wait for the guest | Mandatory |
| 20 | Same `MPIDR_EL1` on two vCPUs / not matching DTB | `nproc` 1; `CPU_ON` error | A single identity must be consistent in three places | Mandatory |
| 20 | Hold two locks in opposite orders (scratch) | Hang under stress, with watchdog | Lock order is a design rule | Optional |
| 21 | Flash mapped read-write RAM | `saveenv` appears to work; fails after reboot | Memory is not flash | Optional |
| 22 | Alter `apb_pclk` | One OS complains, the other does not | Compatibility is measured guest by guest | Optional |
| 24 | Return all-ones vs zero for unknown reads | Different traces, neither is "right" | Experiments on unknown machines need controlled variables | Mandatory (observation log) |
| 25 | Planted bugs (already in the checkpoint) | Fuzzer finds or misses | Coverage needs structure; fuzzers have blind spots | Mandatory |
| 26 | Skip recomputing the vtimer offset on restore | Uptime jumps; timers fire at once or never | Hidden state, not RAM | Mandatory |
| 26 | Corrupt one byte of a snapshot | Clean refusal expected; panic is the bug | A snapshot file is hostile input | Mandatory |
| 27 | Bind the gdbstub to all interfaces | Another local terminal connects and reads memory (do on loopback only; the lesson asks them to *reason*, not do it remotely) | Localhost is a boundary, not a defence | Reasoning only |

### C.3 Design notes on the failures

1. **Sequencing.** Do not break things before the learner has ch06's register dump and ch07's trace.
   The first mandatory "no signal" failure (ch02 missing `hvc`) is deliberately benign: a hang with a
   watchdog message, and a lesson that an exit is the *only* signal.

2. **Prediction records.** The break prompt stores the guess in `journal/NN.md`. The L3 rubric then prints
   "You predicted X; the reference run shows Y." Calibration (how often I am right) is a learning outcome.

3. **Failures that cannot be reproduced.** Two items (ch16 fence, ch18 FLUSH) do not reliably fail on a
   laptop. Say so in the lesson. A course that claims the bug appears when it does not teaches the wrong
   lesson about evidence. Use a litmus-test lab (browser) for the fence; a latency measurement for FLUSH.

4. **Bug hunts (CURRICULUM 6.4).** The catalogue is also the source of faults for `scripts/bughunt.sh`:
   draw from *different* chapters than the Part just finished. Never reuse a mandatory break from the
   same chapter, since the learner has already seen it.

5. **Verify before shipping.** Every row whose symptom is hedged with "(verify, K3)" must be run on the
   reference first and its captured output stored under `course/captures/`. If observed behaviour
   differs from what this file predicts, the *lesson* follows the observation, and the question's Path is
   corrected.

6. **Debrief template.** After each break the lesson gives three lines: what you saw, which misconception it
   exposed (name it), and which tool found it. Then restore the fix and continue. This also trains the
   "diagnose from symptoms alone" skill assessed in the Part bug hunts.

7. **Load.** Roughly 20 mandatory breaks across 28 chapters. About 10 to 15 minutes each (inside the
   chapter time budgets, if the harness does the patching). Without `learner break`, learners will spend
   longer typing the breaks than learning from them. The harness work is what makes this affordable.
