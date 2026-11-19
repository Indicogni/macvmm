# First-principles review: CURRICULUM, architecture, PLAN

- **Reviewer role:** first-principles thinker. For every Part I asked what the irreducible idea is,
  whether each mechanism is *derived from the problem it solves* or only *asserted*, where an
  abstraction appears before the learner has felt the need for it, and which foundations are
  missing.
- **Inputs read:** `CLAUDE.md`, `course/CURRICULUM.md` (all of it), `docs/architecture.md` §1, §6.1,
  §8, §9, §11, §14, §19, §20, `docs/PLAN.md` §2, M8, §3, `spikes/hvf-hello/RESULTS.md`,
  `docs/research/guest-boot.md` (cache row). Re-checked on 2026-11-18 against the architecture
  and PLAN revisions saved at 02:25–02:26. R4, R6, R7 and R12 were updated, and B1 is new.
- **Tags:** `[V]` verified on this machine (spike), `[U]` unverified, must be checked on hardware
  before a lesson relies on it.

---

## 0. Verdict in one paragraph

The curriculum is strong on *what* to build and on adversarial thinking. It is weaker on *why each
mechanism has to exist*. Three things cause this. (a) The course has no spine of problems. Chapters
are ordered by the machine's parts (memory, CPU, devices, interrupts), not by the chain of "this
breaks, so we need that". (b) The architectural foundations it leans on hardest (the exception
model, interrupts, page tables, memory ordering) are pushed into a 2-hour appendix, or assumed as
prerequisites. That contradicts `CLAUDE.md`'s audience rule. (c) Part V is derived from a machine
model that the spike showed does not exist with the in-kernel GIC. The fixes below are mostly
reordering and reframing. Only R1, R2 and R4 add material.

---

## 1. Ranked recommendations

### Blocking contradictions (fix before the chapter's contract freezes)

- **B1. ch04's `GuestMemory` objectives contradict the frozen contract and the chapter's own
  lesson.** CURRICULUM ch04 objective 2 lists `read_obj, write_obj, read_slice, write_slice,
  get_slice`. Architecture §6.1 (frozen at ch04) has `read`, `write`, `read_u16_acquire`,
  `write_u16_release` and `check_range`, and says "**no Rust reference (`&[u8]`, `&mut T`) to
  guest memory is ever created**". A `get_slice` returning `&[u8]` is exactly the reference that
  ch04 Q3 ("a Rust `&[u8]` into guest memory promises nobody else is mutating it. Is that promise
  true?") wants the learner to reject. From first principles the architecture is right: the
  irreducible idea of ch04 is *guest memory is shared with a concurrent writer, so the only safe
  primitive is a copy*. Fix: delete `get_slice` from ch04 and make "why there is no `get_slice`"
  the answer to Q3. Second problem in the same contract: the two ordered accessors are frozen at
  ch04 but their need appears only in ch16 (R6). Either (a) introduce them in ch04 with one
  explicit forward pointer ("two methods whose reason you will meet in ch16"), or (b) move them to
  an extension trait `GuestMemoryOrdered: GuestMemory` introduced in ch16. Option (b) is better
  for teaching and does not change the ch04 freeze. It is the lead's call, because it touches a
  frozen signature.
- **B2. ch12 is built on the no-GIC model.** See R3. Architecture §19 item 2 and PLAN D6 already
  flag it. The ch12 *misconception* text ("We forward one event and keep track of the mask") is
  also wrong under the in-kernel GIC and needs the same rewrite.

### Ranked list

Ranked by how much each one changes learner understanding per unit of authoring effort.
Effort: S is an edit to a chapter entry, M is a new section or lab, L is a new chapter or a reorder.

| Rank | Recommendation | Where | Effort |
|---|---|---|---|
| R1 | Add a **problem ledger** as the course spine: "run a kernel as a process" and list what breaks. Every later chapter closes one row. | ch00, then every chapter's opening | M |
| R2 | Promote the **exception model** to a core chapter, taught first at EL0→EL1 (the syscall the learner already knows) and then "the same thing one level up" at EL1→EL2 | new ch between 01 and 02, or ch02 part 1. Replaces Appendix B for this topic. | L |
| R3 | **Rebuild Part V as timer first, GIC second.** Feel the problem without a GIC (VTIMER exits, the mask dance, WFI exits), then bring in the in-kernel GIC as the solution and *measure* the exits disappear | ch11, ch12 | L |
| R4 | Make **exit cost** a measured number in ch03, and name it as the force behind every later design choice (in-kernel GIC, WFI in kernel, virtio, EVENT_IDX) | ch03, then referenced in ch11/12/15/17/27 | S |
| R5 | Derive MMIO trapping from stage 2: "device registers have side effects, so they cannot be RAM, so we leave a hole in stage 2 on purpose" | ch05, ch07 (move ch09's misconception here) | S |
| R6 | Teach **memory ordering and coherence** as a core concept before ch16, using the actual pairing: the guest driver's barriers and ours, including the v1 store-load fence before `avail.flags` | new primer, required by ch16; seed in ch04 | M |
| R7 | Open Part VII with the **ring + doorbell derivation** (compared honestly with emulated NVMe, not only PL011), then derive each virtio-mmio register from a question the ring raises | ch15 opening, ch15/16 order of presentation | M |
| R8 | Remove abstractions that arrive before their need, or name the need that justifies them | ch04 `GuestMemory` trait, ch06 boot registers, ch09 `Arc<Mutex<dyn>>`, ch15 `VirtioDevice` | S |
| R9 | Make TOCTOU *felt* where it is real (worker threads, SMP), not asserted where it is not (single-vCPU ch04) | ch04 → ch16 lab, ch20 | S |
| R10 | Teach **who sets the trap configuration** (HVF owns `HCR_EL2`/`MDCR_EL2`; we only see what it forwards). This grounds the ch00 sort lab and ch08's policy | ch00, ch08 | S |
| R11 | Derive the **DTB from the problem of hardcoded addresses** our own test guests have | ch10 opening | S |
| R12 | Separate the **two granules** (guest stage-1 4 KiB vs HVF stage-2 16 KiB default) explicitly | ch04, ch05 lab | S |
| R13 | Address cache coherency and I-cache maintenance by evidence, not silence (boot with MMU off; gdbstub breakpoints) | ch04/ch13 aside, ch27 | S |
| R14 | Fix the audience-contract conflict between CURRICULUM §2 and `CLAUDE.md` | CURRICULUM §2, `course/CONCEPTS.md` | S |

Details follow, in rank order.

---

## 2. Details

### R1. The problem ledger (the course spine)

**Problem.** Ch00 asks learners to *label* EL0/EL1/EL2 and *sort* guest actions into "trapped",
"handled by hardware" and "never leaves". Both are answers to a question that has not been asked
yet. The enduring understanding "a VMM is an event loop over exits" is stated, not derived. A
learner with no virtualization background cannot tell why *these* events trap and not others.

**Irreducible idea.** *A kernel is a program written on the assumption that it owns the machine.*
Virtualization means keeping that assumption true for the guest while it is false in reality.
Each thing the kernel assumes it owns is one row of work for the VMM.

**Fix.** Ch00 opens with a thought experiment, "load a Linux Image into a process and jump to it",
and the learner predicts what breaks. The answers become the ledger, which every chapter's opening
cites ("this chapter closes row 4"):

| # | The kernel assumes it owns... | Breaks in a process because... | Possible strategies | Our mechanism | Chapter |
|---|---|---|---|---|---|
| 1 | the privileged CPU state (EL1 registers, `ERET`, `MSR`) | EL0 cannot execute them; the process gets SIGILL | interpret everything (emulator); deprivilege and trap (needs the hardware to trap *every* sensitive instruction: Popek–Goldberg); rewrite the guest (paravirt) | the guest runs at a real EL1 that is owned by HVF at EL2 | 00, 02, 06 |
| 2 | physical memory (it writes `TTBR`, turns the MMU on) | the process only has VAs, and other processes own the rest of PA | shadow page tables (trap every page-table write); a second hardware translation stage | stage 2 | 04, 05 |
| 3 | devices at fixed physical addresses | there is nothing at `0x0900_0000` | emulate the access; paravirtual device | stage-2 holes, then MMIO emulation | 05, 07, 09 |
| 4 | a way to ask the platform for power and CPU control | no firmware exists | emulate firmware; standard call | PSCI over HVC | 08, 20 |
| 5 | a description of the machine | the kernel cannot probe Arm platform devices | hardcode; firmware tables | DTB | 10 |
| 6 | asynchronous attention from devices | no interrupt lines exist | poll; inject a pending bit; a virtual interrupt controller | in-kernel GICv3 | 11 |
| 7 | an alarm clock, to preempt and to sleep | no timer is wired to it | the VMM emulates ticks; virtualized per-CPU timer hardware | the virtual timer and counter offset | 12 |
| 8 | bulk I/O at reasonable cost | each register access is an exit (R4) | faster exits; fewer exits | virtio rings | 15–19 |
| 9 | several CPUs | one thread per process context | — | vCPU threads, PSCI CPU_ON | 20 |
| 10 | a boot chain | nothing loads it | VMM as bootloader; real firmware | direct boot, then U-Boot | 13, 21 |

The trap-or-not lab then becomes an *application* of the ledger ("which row does `str` to the UART
belong to, and which mechanism handles it?"), not a memory test. The feedback cites the ledger row.

This is also where the vocabulary `CLAUDE.md` requires gets *derived*: emulation vs virtualization
vs paravirtualization are the three strategies in the "strategies" column. Type 1 vs type 2 is
"who sits at EL2" (R2). Hardware-assisted virtualization is "the hardware makes row 1's
deprivilege-and-trap strategy complete".

### R2. The exception model as a core chapter, derived through the syscall

**Problem.** Ch02 has the learner compute `ESR >> 26` and read EC `0x16` before the course has said
what an exception is, why a syndrome register exists, or what "preferred return address" means.
The idea that "guest exceptions to EL1 never reach us" (needed for the ch00 lab) is taught in
ch06. Exception *injection* (ch08) is given as a register recipe (`ELR ← PC`, `SPSR ← CPSR`, ...)
with no reason why those registers. `CLAUDE.md` lists exception levels and ESR as **core**: they
need a full chapter derived from the problem. CURRICULUM puts them in Appendix B ("AArch64 in one
sitting", 2 h), which is optional.

**Irreducible idea.** *An exception is a controlled, one-way jump to more privileged code that
leaves behind enough state to (a) know why it happened and (b) resume.* Every register follows from
those two needs:

- resume needs *where* (`ELR`) and *in what mode* (`SPSR`), restored by `ERET`;
- "why" needs the class and details (`ESR`) and the address involved (`FAR`);
- "where to go" needs a table owned by the more privileged code (`VBAR` plus offset by source).

**Derivation chain for the chapter.**

1. Start with what learners know: a syscall. The process at EL0 runs `svc #0`, and the kernel at
   EL1 has to know who called it, why, and where to return. Have the learner *design* the minimum
   state, then reveal `ELR_EL1`, `SPSR_EL1`, `ESR_EL1` and `VBAR_EL1`.
2. Ask: what if the kernel itself must be supervised? Do the same thing one level up. `hvc` is the
   `svc` of EL1. A stage-2 fault is the page fault of EL1. Now `ESR_EL2` is no longer new.
3. Where is EL2 on a Mac? macOS's kernel and HVF. Our VMM is an EL0 process. `hv_vcpu_run` is
   "a syscall that returns when the guest takes an exception to EL2 that HVF decides to forward".
   This is the type-2 (hosted) picture, derived and not just labelled. Draw the path: guest EL1 →
   EL2 (HVF) → our thread returns from `hv_vcpu_run` → we act → `hv_vcpu_run` again.
4. Synchronous vs asynchronous: an instruction caused it (HVC, abort, sysreg) or something
   outside did (the timer, an IRQ, our own `hv_vcpus_exit` kick → `CANCELED`). This classifies
   every `Exit` variant before ch07 builds the enum.
5. Routing: which exceptions go to EL1 (the guest's own vector) and which go to EL2 depends on EL2
   configuration. That gives the misconception ch06 currently fixes ("every guest exception is a
   VM exit") as a *consequence*.
6. Payoff in ch08: injection is "do by hand what the hardware would have done when taking an
   exception to EL1", so the recipe is derived from step 1. The vector offset table (`0x000`,
   `0x200`, `0x400`) is "which source, which stack", which the learner already met.

Lab: extend `pstate-builder` into an "exception stepper": pick a source EL and a cause, and watch
ELR, SPSR, ESR and PC update, then `ERET` back. The ch02 PC-after-HVC observation (`[V]`: HVC
already advanced, SMC/abort/sysreg not) becomes "the *preferred return address* differs by
exception class", a rule from the ARM ARM, not trivia.

The spike also has a ready demonstration that "where the exception goes depends on who sits at
EL2" (`[V]` #22). With EL2 enabled for the guest, an `hvc` at virtual EL2 goes to the *guest's
own* `VBAR_EL2` vector, not to our VMM. Use it as the closing predict prompt: the same
instruction lands in a different place because the routing configuration changed, not the
instruction.

### R3. Part V: timer first, GIC second (and fix ch12's model)

**Problem 1, a wrong model.** Ch12 objectives 2 and 3 (handle `VTIMER_ACTIVATED`, make PPI 27
pending, unmask, block WFI on a condvar) describe the no-GIC model. The spike shows that with
`hv_gic_create` the vtimer is entirely in-kernel: zero `VTIMER_ACTIVATED` exits, and WFI never
exits (`[V]`, RESULTS #13). Architecture §19 item 2 and PLAN D6 already flag this. As written the
chapter would teach code that never runs.

**Problem 2, an order that hides the need.** CURRICULUM §1.3 orders "GIC before the timer". From
first principles the timer is the *problem* and the interrupt controller is part of the *answer*.
Taught GIC-first, the GIC is a large register API (distributor, redistributor, ICC sysregs,
priorities, routing) learned before the learner has one interrupt they care about.

**Why a guest needs a timer interrupt (derive it, do not assert it).** A kernel needs to get the
CPU *back*: to preempt a user loop, to wake a sleeping task, to time out I/O. A counter (a clock
you read) cannot do that, because nobody reads it while a user loop spins. An alarm that
*interrupts* can. Linux's boot hang at timer calibration (ch14 diagnosis 1) is this same fact seen
from the outside.

**Proposed Part V.**

- **ch11 `interrupts`: an interrupt is a pending bit, a mask and a vector.** No GIC. The learner
  observes the raw machinery on HVF without an interrupt controller:
  - a guest arms `CNTV_CVAL`; we get `VTIMER_ACTIVATED` *even with PSTATE.I masked*; HVF sets the
    vtimer mask itself; unmasking while `ISTATUS = 1` re-exits at once: **level semantics, observed**
    (`[V]`, RESULTS #12);
  - WFI exits with EC `0x01` (`[V]`, #10), so the VMM must sleep the thread and wake it: the
    condvar design, felt;
  - the IRQ is delivered with `hv_vcpu_set_pending_interrupt` (`[U]`: RESULTS #20 shows it is
    *unsupported once a GIC exists*, which implies it works without one; verify on hardware),
    taken through the guest's `VBAR_EL1 + 0x280` vector (current EL, SPx, IRQ).
  - Then count: exits per second for a 250 Hz guest tick, the cost per exit from R4, and the cost
    of a second source (the UART). Who masks what? Who acknowledges? What is the priority?
- **ch12 `gicv3`: why an interrupt controller, and why in the kernel.** The controller is derived
  as the answer to many sources, priorities, routing to CPUs, acknowledge/EOI and a per-CPU
  private line. Then `hv_gic_create`, and the learner *measures* VTIMER and WFI exits drop to zero
  and idle host CPU stay near 0% (this is the investigation that architecture §19.2 asks for).
  The measured 2–4 ms wake-up lateness (`[V]`, #25) becomes an honest trade-off in the lesson:
  fewer exits, and we give up control of wake-up latency.

This keeps "one new concept per chapter" and keeps the GIC-before-vCPU-creation rule, because the
no-GIC chapter uses a separate VM configuration. It also gives the snapshot chapter (ch26) a
concrete memory: "the timer mask is state", which the learner handled by hand in ch11.

**Derive level-triggering. Do not choose it by fiat.** ch11 Q1 and the `irq-lifecycle` lab
teach level vs edge, and the reference makes virtio-mmio lines level where QEMU uses edge
(ADR-0003, architecture §19 item 8). The first-principles reason is this. A level line is
*state* ("the device still needs attention"), so a signal raised while the guest is masked, or
in the middle of handling, cannot be lost. It is re-observed when the mask drops. An edge is an
*event*, and an event that arrives at the wrong moment needs extra latching to survive. The
ch11 no-GIC observation (unmasking with `ISTATUS = 1` re-exits immediately) is a level line the
learner has already watched. Point at it when ADR-0003's choice comes up in ch15.

Also derive the counter offset here, not just the formula: the guest expects a counter that starts
near zero and never goes backwards, including across pause and restore. The offset is how the
host's monotonic clock is turned into a per-VM clock. Ch12 Q1 points at this, so make it the
explanation and not only the question.

### R4. Make exit cost the quantitative backbone

**Problem.** "Exits are expensive" drives the in-kernel GIC (ADR-0004), WFI in the kernel, virtio,
`EVENT_IDX`, ch17's exits-per-KB comparison and ch27's "fewer exits" misconception. But the course
never gives the learner a number until ch27. Ch03 Q1 asks them to *estimate* without data.

**Fix.** In ch03, where learners first count exits, add a 20-line `guests/exit-bench` (N × `hvc`)
and have the learner compute ns per round trip with the host clock. Keep that number in the
learner's journal and quote it in ch11/12 ("a 250 Hz tick costs X% of a core in exits"), ch15
("a 4 KiB write through PL011 costs 4096 × X"), and ch27.

What the spike already shows `[V]` (RESULTS raw output, `basic` section): from `hv_vcpu_run`
entry to its return, for a guest that runs one to three instructions and then traps (HVC, MMIO
abort, sysreg), the time is **about 1.0–1.6 µs**. The first run of a vCPU is slower (10 µs), and
a pre-canceled run returns in about 2–3 µs (#19). These timings leave out the VMM's own handling
and any re-entry state transfer (`get_reg`/`set_reg`), so the full round trip in our VMM is
larger. The lesson can quote "about a microsecond, before we do any work" as the order of
magnitude to predict against, and `exit-bench` then measures the real per-exit cost including
handling. Capture it with `scripts/capture.sh`. Do not quote the spike number as the round-trip
cost.

To make the number mean something, compare it with the native cost of the same operation: an
`hvc` exit is roughly 1,000 times slower than the `str` to RAM it replaces. That ratio is the
whole argument of Part VII.

### R5. Derive MMIO trapping from stage 2 and from side effects

**Problem.** "Why must a VMM trap MMIO?" is answered in pieces in three places: ch05 (an unmapped
IPA gives a data abort), ch07 (emulate the access) and ch09's misconception ("a device is a state
machine; side effects on read matter"). The *reason* comes last.

**Irreducible idea.** A device register is not storage. Reading PL011 `DR` pops a FIFO. Writing it
transmits a byte. Plain RAM cannot express "something happens when you touch this", so the VMM must
see every access. The only way to see an access to a guest physical address is to make stage 2
fault on it. MMIO trapping is therefore not a separate mechanism. It is a **stage-2 hole left on
purpose**, plus a syndrome good enough (ISV=1) to emulate the access without decoding the
instruction.

**Fix.** Move the ch09 misconception's content into ch05's opening ("why can't the UART just be a
page of memory?"), with a predict prompt: "if we mapped a RAM page at `0x0900_0000`, what would the
guest's `printf` do?" (answer: the bytes land in RAM and nobody prints them). Mention dirty tracking
(`[V]`, #11) as a second use of the same hole-punching idea: stage-2 permissions are a general
"tell me when the guest touches this" tool, which is also how snapshots and live migration work.

Ch07 Q1 ("why does the hardware give us the register number at all?") then has a derived answer:
without ISV the VMM would need an instruction decoder and a stage-1 walker (M17), which is exactly
the cost the ISV=0 path pays.

### R6. Memory ordering and coherence, as a core concept before ch16

**Problem.** Ch16 objective 3 asserts "a release fence before the `used.idx` store", and the bug
hunt plants "a used-ring update without a fence". `CLAUDE.md` lists memory ordering/barriers as a
**primer**, but the curriculum has no primer slot for it and no chapter that teaches it. The
learner audience may never have seen a weakly ordered memory model.

**Irreducible idea.** *The guest and the VMM are two CPUs sharing memory with no lock.* A virtio
device is a lock-free producer/consumer protocol across a trust boundary. On a weakly ordered CPU
(arm64) a store to the data can become visible *after* a store to the index unless something orders
them. The ordering is a **pair**: the guest driver's barrier (Linux's `virtio_wmb` before it bumps
`avail.idx`) pairs with our acquire load of `avail.idx`. Our release before `used.idx` pairs with
the guest's read barrier. Each side's barrier is useless without the other's.

**Fix: a primer `course/primers/memory-ordering.md`, required by ch16:**

1. Message passing with a flag, two threads, on the host. Show it fail on arm64 with plain
   (non-atomic, `Relaxed`) accesses, or explain why it may be rare to observe. Do not promise a
   reproducible failure that was not observed.
2. Acquire/release in Rust (`AtomicU16::load(Acquire)` and `store(Release)`, `fence`), and what
   they compile to (`ldar`/`stlr`, `dmb ish`).
3. Shared memory with a *guest*: why a plain `GuestMemory::read` is not an ordered access, and
   how the reference does one. The architecture has now decided this (§6.1): `read_u16_acquire`
   and `write_u16_release` use `AtomicU16::from_ptr` inside the `unsafe` quarantine, and
   everything else is `copy_nonoverlapping`. The primer should show the exact pairing that
   justifies *only two* ordered accessors: one acquire load of `avail.idx` orders every later
   plain copy of descriptors and buffers, and one release store of `used.idx` orders every earlier
   plain write of used elements and buffer data. That is why the rest can stay plain copies.
   This links back to B1: the methods are frozen at ch04, and this is where their reason lives.
4. The pairing table for the split ring (virtio 1.2 §2.7.13, "Supplying Buffers to The Device", and
   §2.7.8 for the used ring).
5. **A store-load fence exists already in v1, without `EVENT_IDX`.** Architecture §11.2 item 9
   puts a `fence(SeqCst)` between the `used.idx` release store and the read of `avail.flags`
   (`NO_INTERRUPT`). Release/acquire cannot order a store before a *later load*, and without
   the full fence we can read a stale "no interrupt please" flag after the driver has re-enabled
   interrupts and gone to sleep. That is the lost-wakeup race, and both sides need a full barrier
   (Linux's `virtio_mb` in `virtqueue_enable_cb`). This is the deepest ordering idea in the
   course, and it appears in core code, so teach it in the primer and do not leave it to the
   `EVENT_IDX` extension. `EVENT_IDX` is not offered in v1 (§11.2), so ch16 objective 3 should
   say "extension, not in the reference" or the reference must grow it.
6. The doorbell is a synchronisation point too. The guest's barrier before the `QueueNotify`
   write (Linux `virtqueue_kick_prepare` uses `virtio_mb`), then the trap, then the vCPU thread
   wakes the worker through a mutex and condvar (architecture §14.1). Each link gives the
   happens-before that lets the worker see the ring. Draw the chain once, because a learner who
   swaps the condvar for a relaxed flag breaks it.

**Coherence (pointer level, plus one evidence step).** The learner should know why sharing works at
all: Apple Silicon cores are cache-coherent, and HVF maps guest RAM so that the VMM's view and the
guest's view are coherent. One case is not obvious, a guest with the MMU off (ch02–ch06, early
Linux). Its data accesses are Device or Non-cacheable at stage 1, while the VMM's accesses are
cacheable. `guest-boot.md` already marks this `[U]`. Make ch04's `memtest` plus `DEBUG_MEMHASH` the
explicit evidence ("this passes with the guest's MMU off, which tells us HVF combines the
attributes so the two views agree"), and record the result. Do not leave it as silent magic.

### R7. Part VII: the ring before the registers

**Problem.** Ch15 front-loads the full virtio-mmio register file, the device-status state machine
and feature negotiation before the learner has seen what is being negotiated *for*. The
`VirtioDevice` trait appears before any device. Ch15's misconception ("data never passes through
MMIO registers") is the irreducible idea, and it sits at the *end*.

**Derivation chain (to open ch15):**

1. *Felt need (R4):* Linux on PL011 writing 64 KiB = 65,536 exits. Measure it (it is possible from
   ch14 on).
2. *Idea:* put the data in RAM the guest already owns. Exit only to say "look now" (a doorbell),
   and interrupt only to say "done".
3. *Questions this raises → the registers that answer them:*
   - where is the shared structure? → `QueueDesc/Driver/Device`;
   - how big is it, and who decides? → `QueueNumMax` / `QueueNum`;
   - is it ready to use? → `QueueReady`;
   - "look now" → `QueueNotify`; "done" → `InterruptStatus` / `InterruptACK`;
   - is this even a virtio device, and which kind? → `MagicValue`, `Version`, `DeviceID`;
   - which optional behaviours do we both speak? → features, plus a step the *device* can refuse
     (`FEATURES_OK`). That is ch15 Q1, now answerable;
   - when is the driver done configuring? → `DRIVER_OK`, the status state machine.
4. *The structure itself* (ch16): why a descriptor table plus two rings rather than one ring
   (buffers complete out of order, and the two directions have two writers); why free-running
   `u16` indices (ch16 Q2: full and empty are distinguishable without a spare slot).

**Why virtqueues and not an emulated real device? Do not build a straw man.** Step 1 compares
virtio with the PL011, a programmed-I/O device. That comparison is unfair, because real
high-throughput devices (NVMe, AHCI, e1000) *also* keep descriptor rings in RAM and use DMA and
doorbells. QEMU emulates NVMe, and it works. The honest derivation has three parts:

1. *Shared rings plus a doorbell*: that idea comes from real hardware, and it is what removes
   the per-byte exits.
2. *Why a paravirtual device anyway:* a real device's programming model was designed for
   silicon, where register accesses are cheap. A driver for it touches several registers per
   request (an NVMe submission is a doorbell, but setup, interrupt masking and completion
   handling add more), and each touch is a 1 µs exit (R4). It also has quirks, errata and
   timing assumptions that the emulator must reproduce. Virtio's programming model is designed
   around *the exit as the expensive operation*: one notify per batch, notification suppression,
   and no register access on the data path.
3. *A standard:* one guest driver works on every hypervisor, and the spec says what a hostile or
   buggy driver can do (`NEEDS_RESET`), which is the security story of ch16.

Ask the learner to predict the exits per 4 KiB block write for "emulated NVMe" against
"virtio-blk" before they are told. That makes the trade a measured design choice, not a brand
preference.

Keep chapter IDs. Only the presentation order inside ch15 changes, plus a 10-minute "toy ring"
warm-up (one descriptor, one doorbell) in the `virtqueue-visualizer` lab before the real layout.
Why virtio *exists* (a standard so one guest driver works on every hypervisor) is a one-paragraph
pointer, and must come before any register.

### R8. Abstractions before their need

| Abstraction | Introduced | Need first felt | Recommendation |
|---|---|---|---|
| `GuestMemory` **trait** (vs a struct) | ch04 | lifelines (§3.5) and host test fakes; nothing in the lesson needs polymorphism | Keep it frozen, but say *why it is a trait* in one sentence (test doubles, lifelines). Build `GuestRam` first, then extract the trait. Show the ch03 raw-pointer loader's out-of-range write *before* the checked API exists. |
| `Vcpu::reset(BootParams)` with `booting.rst` registers (`x0` = DTB) | ch06 | ch10 (DTB) and ch13 (loader) | ch06 sets only what test guests need (PC, CPSR, MPIDR, SCTLR). Introduce `x0` = DTB in ch10, where `dtb-reader` reads it. Introduce the rest of `booting.rst` in ch13. |
| `MPIDR_EL1` affinity | ch06 | ch11 GIC routing and ch20 SMP | Fine to set in ch06, but the *meaning* ("the CPU's name, used by the GIC and PSCI") belongs to the first chapter that routes by it. Ch06 Q3 already points there. |
| `Bus` of `Arc<Mutex<dyn MmioDevice>>` | ch09 | the stdin thread in ch09 (real), and workers/SMP later | Start with a `match` on IPA for one device, generalize when PL031 arrives (the second device *is* the need). Justify `Mutex` with the stdin reader thread explicitly: it is a real second thread in ch09 (architecture §14.1). |
| `IrqLine` | ch11 | host-only tests of the PL011 level logic | Justify by testability ("the PL011's level rule must be testable without HVF"), not by future-proofing. |
| `VirtioDevice` trait | ch15 | ch17, the second device (console) | Introduce it in ch17 by extracting it from rng. This matches the "worked then faded" pattern already in §3.4. |
| Exit-trace JSONL schema | ch07 | ch07 checkpoint needs it, so it is felt | OK as is. |

### R9. TOCTOU: assert it where it is real

Ch04's misconception says a guest vCPU can change memory after we check it. In ch04 there is one
vCPU and every exit is handled on that vCPU's own thread *while it is stopped*, so the race cannot
happen yet. The learner will notice this (or worse, believe it is happening). It becomes real when
a virtio worker thread reads rings while the vCPU runs (architecture §14.1, from ch16) and with SMP
(ch20).

Fix: in ch04 make it a question ("when could the guest change this memory while we look at it?
Not yet. Write down when it will become possible."). In ch16 make it *felt*: the visualizer's
hostile mode flips a descriptor's `len` between our check and our use, and a host unit test with
a second thread does the same against a deliberately re-reading walker. Then "copy, validate, use"
is the derived fix.

### R10. Who decides what traps

The ch00 lab and ch08's sysreg policy imply that the VMM controls trapping. On HVF it does not.
HVF at EL2 owns the trap configuration (`HCR_EL2`, `MDCR_EL2`, the ID register values the guest
sees) and forwards only some exits (EC `0x18` for `PMCR_EL0` with EL2 off, `[V]` #9). The PMU
UNDEF with EL2 enabled is HVF's decision, not ours (`[V]` #22). State this in ch00 ("there are two
supervisors: HVF decides what leaves the guest, we decide what to do with what HVF forwards") and
in ch08 (the policy table is *our half*). It also explains why "which sysregs trap under HVF" is a
fact to measure (CURRICULUM K3), not to look up in the ARM ARM. The guest's view of CPU features
(the `ID_AA64*` registers, and risk R3 about `ID_AA64PFR0_EL1.GIC`) deserves a pointer here: the
guest discovers the CPU by reading registers that EL2 can sanitize.

### R11. Derive the DTB from our own hardcoding

Test guests from ch03 to ch09 hardcode `0x0900_0000` and the RAM base. That is the felt need: "a
general-purpose kernel cannot hardcode, and on Arm there is no bus to probe for platform devices
(unlike PCI enumeration or x86's firmware tables)". Open ch10 with "change `layout.rs` to move the
UART and watch `uart-echo` break, then make it read the address from the DTB". The ch10
misconception ("the DTB is configuration the guest may ignore") then follows directly.

### R12. Two granules, two owners

The spike shows the HVF stage-2 default granule is 16 KiB (4 KiB is optional on macOS 26+, `[V]`
#1–#2). The ch05 `two-stage-walker` lab uses a 4 KiB granule, which is what Linux uses at stage 1.
A learner will merge the two. Ch04 Q2 ("why 16 KiB and not 4 KiB?") hints at it but does not
resolve it. Say explicitly: stage 1 belongs to the guest and uses the guest's granule; stage 2
belongs to HVF and uses the host's (or the configured IPA) granule. They are independent, and the
lab should let each be set separately. The page-granules primer `CLAUDE.md` lists is the place.

Derive the 16 KiB constraint from its consequences, so it is not trivia (this answers ch04 Q2):

- `hv_vm_map` rejects any host VA, IPA or size that is not 16 KiB-aligned (`[V]` #1). Every
  region in `layout.rs`, including MMIO holes between RAM regions, must therefore respect 16 KiB.
- Stage-2 permissions work per 16 KiB page. Write-protect dirty tracking (`[V]` #11) marks 16
  KiB dirty when the guest writes one byte of a 4 KiB guest page. That is up to 4× write
  amplification for snapshots and migration (ch26), which is a cost the learner can predict.
- The rule applies only to *mapped* regions (RAM, and flash ROM, which is mapped read-only for
  reads). MMIO windows are unmapped holes, so they can be any size: a 4 KiB PL011 window costs
  nothing. This shows the R5 idea again: a device is the absence of a mapping.

The spike shows `HV_IPA_GRANULE_4KB` works on macOS 26+ (`[V]` #2). Say in one line why the
reference keeps the default (fewer stage-2 entries and TLB pressure, the host page size matches)
or record the decision in an ADR.

### R13. Caches: answer by evidence

Two concrete places where a cache question will come up and the course is currently silent:

1. **Boot with the MMU off** (`booting.rst` requires the image "cleaned to PoC"). Handled by the
   R6 evidence step. Record the result in `docs/research/guest-boot.md`.
2. **gdbstub software breakpoints (ch27 `Z0`)** write a `BRK` into guest memory while the guest's
   instruction cache may hold the old instruction. Whether the VMM must do I-cache maintenance
   (for example `sys_icache_invalidate` on its mapping), or whether the hardware's
   `CTR_EL0.DIC`/`IDC` behaviour and HVF make it unnecessary, is `[U]`. It is the kind of bug that
   passes 99 runs and fails the 100th. Add it to CURRICULUM K3 and test it in M26 with a
   breakpoint placed on an instruction that has just been executed in a loop.

### R14. The audience contract conflicts

- CURRICULUM §2 assumes "basic OS concepts (virtual memory, interrupts, system calls, what a kernel
  does at boot)". `CLAUDE.md` (which wins) assumes only "what a process and memory address are".
  So page tables, interrupts and syscalls must be primed or taught. R2 (via syscalls) and R3 (via
  the timer) cover interrupts and exceptions. Stage-1 page tables need a primer before ch05's
  hand-walk objective.
- Appendix B covers exception levels and system registers. `CLAUDE.md` tiers exception levels/ESR
  as **core**, so they need a chapter (R2), not an optional appendix.
- `course/CONCEPTS.md` does not exist yet. Several concepts above (memory ordering, page granules,
  the exception model, synchronous vs asynchronous exits, level vs edge) need entries with their
  tier before lessons are written.

---

## 3. Per-Part audit: irreducible idea, derived or asserted

| Part | Irreducible idea | Derived today? | Gap and fix |
|---|---|---|---|
| 0 Orientation, FFI | A kernel assumes it owns the machine; a VMM keeps that true by letting hardware run it and handling what the hardware refuses to do | **Asserted** (labels and buckets) | R1 ledger; R10 two supervisors. FFI chapter: fine. Its "why" (the boundary where Rust's guarantees end) is well posed. |
| I First exit, guests | An exit is an exception to EL2 that HVF hands back to our thread; a bare-metal program needs only a stack, BSS and an entry point | Partly. The guest-side minimalism is derived (ch03 misconception). The exit is not. | R2 before ch02; R4 measure exit cost in ch03. |
| II Memory | The guest's "physical" memory is a second translation we own; any hole in it is a trap; every address the guest hands us is hostile | Mostly derived for safety; **asserted** for stage 2 itself (no "why not shadow paging") | R5 side effects and holes; R12 granules; one paragraph on shadow paging as the rejected alternative, so stage 2 is a *solution*. |
| III CPU, exits, sysregs | Every exit carries a syndrome good enough to act on without decoding; injection is doing by hand what the hardware would do | ESR decode is well drilled. Injection is **asserted** as a recipe. | R2 makes injection derived. R10 for who decides what traps. |
| IV Devices, DTB | A device is a state machine behind side-effecting registers; the guest only knows what we promise | Device-as-state-machine: derived, but late (ch09). DTB: **asserted** ("only source of truth"). | Move to ch05 (R5); R11 for the DTB. |
| V Interrupts, time | A kernel needs to be interrupted to get the CPU back; an interrupt is state (pending, masked, active), not a call | The state view is good (ch11 misconception). The *need* is missing, and ch12 is built on a model the spike refuted. | R3 (reorder and rewrite). |
| VI Linux | Loading is a contract (placement, alignment, BSS); booting is the start of testing | Derived well. Ch13's misconception and ch14's failure diagnosis are good. | Only R8 (move the `booting.rst` registers here). |
| VII Virtio | Move data through shared memory and exit only to signal; shared memory with an adversary demands ordering, copy-then-validate and caps | The security half is derived well. The *motivation* and the ordering are **asserted**. | R4, R6, R7, R9. |
| VIII SMP | Every device becomes a concurrent data structure; the vCPU's thread affinity forces a thread per vCPU | Derived (ch20 misconception, ch02 Q3 seeds it). | Make sure ch20 recalls R6 (the guest's ordering assumptions become ours). |
| IX Firmware, FreeBSD | Firmware is a stricter guest; compatibility is measured guest by guest | Derived (Q1 "why add firmware at all"). | None. |
| X macOS | A machine is defined by its whole device and firmware contract, much of it undocumented | Derived and honest. | None. |
| XI Productization | Rust's safety does not reach logic, resource and TOCTOU bugs; state includes hidden device and timer state | Derived. | Ch26 can cite R3's "the timer mask is state". |

---

## 4. The minimal derivation chain (the "why" order of the whole course)

Each step is forced by the one before. A lesson that introduces a mechanism should be able to
point to the step that made it necessary.

1. **A kernel assumes it owns the CPU, memory, devices, interrupts and time.** (ch00, ledger)
2. **Interpreting it is slow, so let the real CPU run it** in a deprivileged mode, and make the
   hardware stop whenever it reaches for something it does not really own. (ch00)
3. **Stopping = taking an exception** to a more privileged level, leaving behind *why* (ESR, FAR)
   and *how to resume* (ELR, SPSR). On a Mac that level is HVF at EL2, which hands the exit to our
   EL0 thread. (R2, ch02)
4. **Every stop costs about X µs** (measured). Everything after this tries to have fewer of them.
   (R4, ch03)
5. **Memory:** the guest's physical addresses must be translated again, by hardware (stage 2),
   or every page-table write would have to stop. (ch04–05)
6. **Devices:** registers have side effects, so they cannot be RAM. Leave stage-2 holes so each
   access stops; the syndrome lets us emulate the *access*, not the instruction. (R5, ch05, ch07)
7. **Some stops are requests** (power off, CPU on): a standard call (SMCCC/PSCI) instead of
   pretending to be a power controller. **Some are things we do not virtualize**: inject the
   exception the real CPU would have raised. (ch08)
8. **A general kernel cannot hardcode the machine**, so we describe it (DTB), from the same
   source as the devices. (R11, ch09–10)
9. **A kernel must get the CPU back:** an alarm that interrupts (timer). An interrupt is a pending
   bit, a mask and a vector. With many sources, a controller. To avoid a stop per tick, put the
   controller and timer in the kernel (in-kernel GIC). (R3, ch11–12)
10. **Now Linux can boot**: placement contracts, then integration. (ch13–14)
11. **Per-access stops make bulk I/O too slow:** move the data into shared memory and stop only to
    ring a doorbell (virtio). (R7, ch15)
12. **Shared memory with a concurrent adversary** needs ordering (paired barriers), copy-then-
    validate (TOCTOU), and caps on everything. (R6, R9, ch16–19)
13. **More CPUs**: one thread per vCPU (thread affinity), and every device becomes concurrent.
    (ch20)
14. **Real boot chains and other OSes** are stricter guests. (ch21–24)
15. **Product concerns** (hardening, snapshots, debugging) follow from 3, 9 and 12: hidden state,
    hostile input, and the cost of stops. (ch25–27)

---

## 5. Facts to verify before the lessons rely on them

Add these to CURRICULUM K3:

- `hv_vcpu_set_pending_interrupt` delivers an IRQ to the guest's vector without a GIC, and how
  it interacts with the vtimer mask (R3). `[U]`
- An HVC round-trip time on the reference machine *including VMM handling*, captured, not
  estimated (R4). The spike's 1.0–1.6 µs run-to-exit is `[V]` and serves only as a lower bound.
  `[U]`
- The ordered-access design is now decided (architecture §6.1, `AtomicU16::from_ptr`). What is
  still to verify is a host test showing that `fence(SeqCst)` before `avail.flags` (§11.2 item 9)
  is present and covered by a test, plus a Linux virtio-rng/blk soak with interrupts suppressed
  and re-enabled, to catch lost wakeups (R6). `[U]`
- MMU-off guest writes are visible to the VMM without cache maintenance (R6, R13), with the evidence
  recorded in `guest-boot.md`. `[U]`
- Whether a `BRK` written by the VMM into guest code is fetched by the guest without I-cache
  maintenance (R13, ch27). `[U]`

---

## 6. Open risks of following this review

- **R3 changes chapter content and possibly the chapter IDs of ch11/ch12** (swap titles, keep IDs
  stable as §5 requires). The checkpoints `guests/irq` and `guests/timer` and PLAN M8 assume the
  GIC-first order. A no-GIC ch11 needs a new guest and a VM-config flag (for example
  `--machine virt-nogic` or an internal test mode). The lead must decide whether that flag is worth
  the CLI surface.
- **R2 adds about 3 h** to the core path, which is already about 54 h (K9). The offset is that
  Appendix B shrinks and ch06/ch08 get shorter because the mechanism is already taught.
- **R6's memory-ordering demonstration** may not reproduce a failure on Apple Silicon reliably.
  The primer must say what was observed, and fall back to litmus-test reasoning if nothing was.
