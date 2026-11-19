# Novice review: CURRICULUM Parts 0-III and CONCEPTS

Reviewer persona: a competent programmer (some Rust and C, knows processes, pointers, a bit of
syscalls) who has never touched virtualization or ARM assembly. I read `course/CURRICULUM.md`
(sections 1 to 5, chapters 00 to 08) and `course/CONCEPTS.md` as if starting the course.

## 0. Scope caveat (read first)

Only the plan exists. `course/chapters/`, `course/primers/`, `course/STYLE.md` and
`course/site/DESIGN.md` are not in the tree, so I could not read a single lesson, a primer or a
lab. Everything below is a review of the plan as a promise to a learner. I flag where the plan
makes a promise I cannot check. Where I say "I would be lost", I mean: if the lesson is written
the way this plan describes it, with no extra repair, this is where I stall.

Severity key: **[B] blocker** (I stop or silently misunderstand), **[M] major** (I push on but with
a wrong or fuzzy model), **[m] minor** (friction).

---

## 1. Whole-course structure problems

**1.1 [B] The front matter is a document for authors, not a learner's way in.**
CURRICULUM opens with "Wiggins and McTighe", "enduring understandings", "split attention",
"expertise reversal", "ledger", "derivation chain". A novice who clicks the first page and sees
any of this will not know what to do next. The learner-facing entry point (what is the course, what
will I have at the end, what do I need to do tonight) is not described anywhere. Section 4 "Learner
journey" comes closest, but it is on line 464, after 460 lines of design theory, and it is itself
dense with unexplained terms (see 1.3).
Would help: a half-page "Start here" that says only: you will write a program that runs Linux in a
window of its own; you need an Apple Silicon Mac; do step 1 (setup), then read chapter 00.

**1.2 [B] The prerequisite load before the first real chapter is large and hidden.**
Section 4's table: step 1 setup, step 2 primer `os-basics` (30 min) plus ch00 (3 h), step 4
primer `codesign-entitlements` plus ch01 (4 h), step 5 primer `aarch64-reading` plus ch02 (4 h).
Nothing is built on my own until ch01 and no machine code runs until ch02, which is hour 8.5
by the table. That can work, but the plan never tells the learner "the first 8 hours are mostly
reading and browser toys, and that is intentional". A persona like me quits at hour 3 thinking I
have been mis-sold. Say so up front, and say why (the model has to exist before the code makes
sense).

**1.3 [M] Vocabulary is used in the plan's own prose before it is defined, even in the parts that
describe what the learner will see.** Examples of terms that appear on first mention with no gloss
and no link, in order of appearance:

- Section 1.1, G2: "raw syndrome", "where the PC must go next". Neither means anything to me yet.
- Section 1.2, understanding 2: "Stage-2 translation, the in-kernel GIC and the virtual timer",
  "HVF at EL2". Four undefined things in one sentence, and this is the course's second core idea.
- Section 1.4 table: "`TTBR`", "`ERET`", "`MSR`", "SIGILL" (row 1), "INTID" and "pending bit" (row 6),
  "doorbell" (row 8). The table is described as "the course spine" and "the learner's predictions
  become this ledger" but it is full of words the learner cannot yet have predicted.
- Section 1.5 step 3: "ESR, FAR" and "ELR, SPSR" appear with no expansion.
- Section 2: "AAPCS64", "`SMCCC`" (in the primer table), "PoC", "PoU".
Would help: every acronym expanded at first use per page, and a site-wide glossary that each term
links to. CONCEPTS.md has the right data (tier and where it is taught) but it is shaped as an
audit, not a glossary a learner can open.

**1.4 [M] "Exit", "VMM", "hypervisor", "host", "guest", "monitor": the word VMM is never motivated.**
Section 5 ch00 outline item 2 introduces "virtual machine monitor" and "hypervisor" and then says
"the two words are often used as synonyms in the wild; the lesson says so and keeps them apart."
Then ch01 says "our VMM is the hypervisor and runs at a privileged level" is a *misconception*
(it is an EL0 process, the privileged half is Apple's). So the course's own definition of
"hypervisor" is "the privileged part (HVF and the macOS kernel)", which is nonstandard and
contradicts how every web page I will read next uses the word. A novice googles "hypervisor", finds
"QEMU is a hypervisor", and concludes the course is wrong. Either say plainly that this course uses
the narrow definition and that most of the world does not, with one example of each use, or avoid the
word hypervisor except where needed.

**1.5 [M] Hour estimates are not credible for this persona.**
Ch00 is 3 h and covers 8 run modes in a toy, six historical systems, Popek and Goldberg, binary
translation, paravirtualization, hardware assist, and a doctor script. Ch02 is 4 h and covers
exception levels, six exception registers, PSTATE decoding, hand-encoded instructions, the
`exception-stepper` lab, a Rust FFI `vcpu.rs` and the first VM run. For someone who has never seen
ARM assembly, I would roughly double both. The plan itself notes lessons over 4,000 words fall back
(risk K11), but nothing protects against the cognitive load of the ch02 objective list (see 2.4).

**1.6 [m] The word "lesson" outline, then "Objectives", then "Concepts", then "Build", then
"Modules", then "PLAN", then "Checkpoint", then "Lab", then "Predict fork", ... is the authoring
template (section 7).** I only mention it because a learner who reads this file to "see what is
ahead" meets PLAN milestone IDs (M0, M4), "L1/L2/L3", "K11" and "risk K16" and has no idea what
they are. If this file is ever shown to learners, strip those. If it is not, say so at the top.

---

## 2. Chapter-by-chapter

### Ch00 `orientation`

**2.0.1 [M] "Load a Linux Image into an ordinary process and jump to it. What breaks?"
(ch00 item 3)**
I do not know what a "Linux Image" is (a file? a kernel binary?). I do not know what "jump to it"
means for an arbitrary file (`os-basics` is a prerequisite, but a process does not "jump" into data;
it would need to be mapped executable). I also have no way to make predictions about which
privileged things a kernel does if I have never read kernel code. The plan expects me to predict
"at least six things that break" (objective 2) and match them to ledger rows, but the ledger rows
(CPU state, memory, devices, power control, machine description, interrupts, timer, I/O cost, many
CPUs, boot chain) are exactly the answer key. A novice cannot generate these from nothing; they will
write "it crashes" and be told they were wrong.
Would help: give two or three scaffolded prompts ("what does the kernel need to do when it starts:
set up memory, talk to a disk, handle a key press...") and accept coarse answers; show the ledger as
"the things your guesses fall into", not "the things you should have guessed".

**2.0.2 [M] The opening puzzle is good, but the next paragraph jumps.**
"Linux believes it owns the CPU, the RAM and the devices; so does macOS. Both cannot be right. Who
is fooled, and how does the fooling stay fast?" I like this. But "stay fast" is not motivated: I
have not been told that an easy answer (a program that pretends, i.e. an emulator) exists and is
slow. Item 4 gives that, but the puzzle in item 1 should already name the tension.

**2.0.3 [M] "Sensitive", "privileged", "unprivileged mode" appear before "privilege levels" are
established.**
Item 5: "run the guest kernel natively in the unprivileged mode." Item 6 defines sensitive and
privileged and Popek-Goldberg in one dense paragraph, including "three properties: equivalence,
resource control, efficiency" and "seventeen (Robin and Irvine, 2000), such as `POPF`, which silently
drops the interrupt-flag change in user mode". For me: what is an "interrupt flag"? What is
`POPF`? (x86, which I have not been told is relevant.) The theorem is stated, the three properties
are named, but no example of why a missing trap breaks trap-and-emulate is given until the toy
lab. The reasoning leap: "the instruction runs, but does the wrong thing, and nobody told the VMM".
That needs one concrete sentence in prose: "the guest asks 'am I in kernel mode?', the CPU says
'no, you are in user mode', and the guest panics, because it believed it was in kernel mode."
(The Predict fork has this, good; it is item 6 that needs it.)

**2.0.4 [m] Real-world history (CP-40, VM/370, Denali, Xen, VT-x, AMD-V, EPT, NPT) all arrive
in about five sentences.** Eight acronyms and six company names in the strategies section. A
novice treats them as noise. The "one-screen timeline figure" will help, but the plan says each
system gets a date and a claim cited to a primary source; the learner needs only one or two to
anchor the idea. Consider dropping to "emulator (QEMU), VMware (binary translation), Xen
(paravirtualization), VT-x/EL2 (hardware assist)" and moving the rest to an aside.

**2.0.5 [M] "Hypervisor", "type 1 / type 2", "exit" and "EL2" are mentioned in ch00's Concepts
box as forward definitions, but ch00 step 8 already says "Arm Virtualization Extensions
(ARMv7-A) and EL2 in ARMv8-A" and step 5's "unprivileged mode".**
"EL2" is not defined until ch02. "ARMv7-A" and "ARMv8-A" are never explained either (what is "Arm
v8", is it a chip, an instruction set?). One sentence: "Arm numbers its privilege levels EL0 (user
programs) to EL3; more in ch02."

**2.0.6 [m] ch00's toy `GETMODE` mode E is the best idea in Part 0, but the plan does not say
that the toy's "user mode" and "kernel mode" are modelled on something the learner knows.** If
`os-basics` shows user versus kernel and a syscall, the toy should reuse exactly that picture.

**2.0.7 [M] Final step: "Run `scripts/setup.sh` and `scripts/doctor.sh` (provided). One sentence
per line here."** The checkpoint's expected output includes "doctor: max IPA: * bits (default *)" and
"EL2 supported: *". I get one sentence per line but the lines contain IPA, EL2, entitlements. I
have just been told "forward definitions: ... the doctor's IPA, EL2 and entitlement lines are
explained in ch01". Fine, but the *first thing a real Mac gives me* is output I do not understand,
and my first checkpoint passes on a `*` match. Accept it, but tell the learner: "you will not
understand these three lines yet; that is expected; they are for ch01".

**2.0.8 [m] "A learner who has at most 'run a VM in an app'" (ch00 intro)** is the right
assumption, but the plan never tells the learner they need to have used one. Add an optional
5-minute task: open any VM app, boot anything, look at Activity Monitor. That gives them something
to point at when the lesson says "the program that keeps the illusion".

### Ch01 `ffi`

**2.1.1 [B] The chapter combines two unrelated hard things: the macOS virtualization stack and
unsafe Rust FFI.**
ch01's objectives (5) and (6) require: write `extern "C"` declarations for seven functions that
match SDK headers; convert `hv_return_t` (a Mach error code, "`0xfae94000 | n`") into an enum;
write `// SAFETY:` comments; observe "one VM per process". That is a lot for 4 h for someone who has
never written FFI, and the learner at this point does not yet know what `hv_vm_map`, `hv_vcpu_run`,
`hv_vcpu_get_reg` do. They are asked to write declarations for functions whose meaning is not yet
explained (they are explained in ch02 and ch04). The plan's own fallback (risk K11) moves half of
section 7 to a "completion scaffold", which tells me the author already suspects overload.
Would help: ch01 FFI covers only `hv_vm_create`/`hv_vm_destroy` plus the error type. `hv_vcpu_*`
and `hv_vm_map` declarations arrive in the chapter that uses them (02 and 04).

**2.1.2 [M] "Type 1 / type 2" with Goldberg's 1973 definitions, then "the line blurs: KVM makes
Linux itself the hypervisor; macOS does the same with HVF".**
I cannot evaluate KVM; it has not been introduced. More importantly this is the second time in 20
minutes I am told a definition and told it does not quite apply. The pedagogical value of type 1/type
2 for someone building a VMM is small. The text says so ("the useful question is 'who owns the
privileged level'") and then spends a section on it. Consider moving the taxonomy to an aside and
keeping only the useful question.

**2.1.3 [M] The stack figure uses "EL0", "EL1", "EL2" before ch02 defines them.**
The Mermaid in ch01 has "guest apps, EL0", "guest kernel, EL1", "macOS kernel, EL2 part", "vGIC",
"vtimer". I have not been told what a level is (apart from the toy), what "vGIC" is, or what a
"vtimer" is. This is the single most important picture in the course ("every later chapter refers
to it"), and it is introduced with four undefined labels. The `[V]` and `[U]` evidence tags are
good practice but they are author notation; the learner needs plain "we checked this" /
"we infer this" wording.
Would help: add to the figure caption a legend: "EL0 = ordinary programs, EL1 = a kernel, EL2 = the
level that supervises kernels (you will meet it properly in chapter 2)".

**2.1.4 [M] "Whether *all* of XNU runs at EL2 is `[U]`" and "the macOS kernel, EL2 part".**
XNU is not introduced. A novice will not know what it is (the macOS kernel, Darwin). Also the
chapter draws "macOS kernel (EL2 part)" and "Hypervisor.framework (library)" as separate boxes.
What is a "library" versus "a kernel part"? That the framework is a user-space wrapper over a syscall
is exactly the Hypervisor.framework story, but it is only implied. One sentence: "Hypervisor.framework
is user-space code that makes system calls into the kernel."

**2.1.5 [M] The `trap-or-not` lab asks me to classify ten real ARM instructions into three
buckets before I have met any ARM.**
Objective (3) says "at least 8 correct". The items include `ldr`, `str`, `wfi`, `hvc`,
`mrs CNTVCT_EL0`, `svc`. The feedback defines each in one line, which is nice, but the learner is
classifying *before* learning what the buckets' justifications (ledger rows, deciding layer) mean
for these specific instructions. Without the ARM primer (`aarch64-reading` is required only from ch02),
this is a guess with a hint after. A learner who "gets 8 of 10" by guessing has learned nothing. Either
move the lab after the primer, or make it explicitly exploratory (no score, feedback only), or lower
the objective to "explain three of them".

**2.1.6 [M] The unsigned-doctor Predict fork assumes I know what a code signature, an
entitlement and the linker are.**
The fork: "(a) link error, (b) crash, (c) a clean error value at run time?" Tempting (a). I do not
know what "link error" would look like in this context. `codesign-entitlements` is a primer but is
read first; fine. But the *choice* (a)-(c) is meaningful only if I know what a linker does and what
a run-time check is. I am a C/Rust programmer, so I do, but the plan should state that.

**2.1.7 [m] `hv_return_t` is "a Mach error code, `0xfae94000 | n`".** "Mach" was never introduced
(it is the macOS kernel's microkernel layer). As a pointer it is fine; just say "the kernel's own
error numbering".

**2.1.8 [m] "RAII `Vm`; `Drop` calls `hv_vm_destroy`" and "one VM per process"** are explained as
Rust facts. For a Rust-light learner, the surprising thing is that the hypervisor has global
process state. Say "HVF allows exactly one VM per process; we model that with a value that
destroys itself when dropped".

**2.1.9 [M] "Virtualization.framework" is introduced as "Apple's ready-made machine, which we will
not use". The motivation for building from HVF instead is never given in terms the novice
cares about.** "Building the machine is the point" is the author's goal, not the learner's. A novice
wants to know: what can I do with HVF that VZ cannot? (Run non-macOS arm64 guests with custom
devices, firmware, and see exits.) Ch23 uses VZ for macOS guests; "why does a macOS guest need the
high road" is a hole worth previewing here.

### Ch02 `first-exit`

This is the heaviest chapter in Parts 0-III for a novice, and I expect most dropouts here.

**2.2.1 [B] The objectives list is a wall.**
Objective (1) alone: "Design, before it is revealed, the minimum state a kernel needs when an app
runs `svc #0` (who, why, where to return, in what mode), then map the design to `ELR_EL1`,
`SPSR_EL1`, `ESR_EL1`, `FAR_EL1` and `VBAR_EL1` plus the vector offset." I do not know what `svc`
is, what "EL1" is (beyond the toy), or what a vector or "vector offset" is. Objective (4): "decode
`0x3c5` field by field in `pstate-builder` mode (`M[3:0] = 0b0101`, EL1 using `SP_EL1`, "EL1h"; bit
4 = 0, AArch64; bits 6 to 9 = DAIF all masked, `0x3c0`)". "SP_EL1", "EL1h" and "DAIF" appear
cold. Five new registers, plus PSTATE, plus a hand-encoded instruction set, plus hex, plus an
unfamiliar memory model, plus the Hypervisor.framework's vCPU API, all in one 4-hour chapter.
Would help: split into 02a (exceptions and the syscall analogy, no Rust) and 02b (run your first
guest). Or keep one chapter but make section 1 purely the `exception-stepper` lab with nothing else.

**2.2.2 [M] "The design before it is revealed" is a good idea but only works if I know what a
syscall actually does at the hardware level.**
`os-basics` covers "syscall", but the ch02 derivation ("who, why, where to return, in what mode")
presupposes that I know a syscall switches mode and changes the PC to a kernel entry. The primer
needs to say that explicitly, including "the CPU saves the return address in a register, not on a
stack" (an Arm-specific fact that surprises x86-trained learners).

**2.2.3 [M] "hvc is the svc of EL1; a stage-2 fault is the page fault of EL1; HVF at EL2 owns the
vector".**
This analogy is the chapter's core and is excellent, but it hinges on three assumptions: I know what
a page fault is (primer), I know what "owns the vector" means (a vector is a table of handler
addresses, never defined in the primers list), and I accept that EL2 is "one level up" without
yet having seen the full ladder EL0..EL3. `VBAR`, "vector table", "vector offset (0x000, 0x200,
0x400)" are all named in the chapter's concepts but the primer `aarch64-reading` scope in section 2.1
does not include exception vectors. They are "taught here", which is OK, but the objective asks me to
derive them *before* they are taught.

**2.2.4 [M] Two things called "exception" and "exit".**
"A VM exit is an exception taken to EL2 and forwarded." Exception in the ARM sense includes
interrupts and system calls; in the Rust/C++ sense it is something else. "Exit" is overloaded:
process exit, "exit code 5", VM exit. The plan uses all three (exit status in ch03, "exit 3" in
ch05, "exit reason" in ch02). Define "VM exit" as the name for one particular moment and use "exit
code" or "status" for the process's.

**2.2.5 [M] "Preferred return address" and the PC-after-HVC surprise.**
The Predict fork is a strong idea. But "tempting: add 4" assumes I know that a PC points at the
next instruction to execute and that instructions are 4 bytes (primer). It also leads with a rule that
differs by exception class ("HVC: after; SMC: at; data abort: at"), without explaining that the
architecture does this on purpose. The one sentence that would make it click: "for a call, the caller
wants to continue after it; for a fault, the faulting instruction must be retried." That is in the
text as "ARM ARM's preferred return address, which differs by exception class", which is a citation,
not an explanation.

**2.2.6 [M] Hand-encoded instructions: `movz x0, #0x2a` = `0xD2800540`.**
The plan lets the learner encode three instructions in an `a64-encoder` lab *before* the reveal. I
cannot do that without a description of the encoding fields, and the lab is the only teacher
(primer `aarch64-reading` says "fixed 32-bit instruction words and their fields"). If the primer
covers `movz`, `hvc` and `b` fields, fine. If not, the lab is a guessing game. It must be explicit
that the lab shows the fields on the first screen.

**2.2.7 [M] "Map one 16 KiB host page of guest RAM at IPA `0x4000_0000`" (objective 4).**
Four undefined things in one clause: "16 KiB host page" (I know 4 KiB pages; the Mac uses 16 KiB; why
does that matter?), "guest RAM", "IPA", "map". The forward definitions are present ("IPA is the
address the guest believes is physical; HVF translates it to host memory; full story in ch05"), but
`0x4000_0000` is just a number: why this address? (QEMU `virt` convention; the course says in ch05 and
ch21.) A learner copy-types an address they cannot justify. One sentence: "we picked 1 GiB; ch05
says why."

**2.2.8 [M] Retiring the toy.**
The plan wants to "retire the toy in one short section" by listing four differences. I like the
honesty, but I will not remember the toy's details by then (the ch00 toy has eleven instructions, a
console, modes A to H). The mapping "toy user mode = EL0, toy kernel mode = EL1, toy hardware assist =
EL2" should be a table in ch02 with both names side by side, and the toy lab should render the same
state names as the ARM stepper so the mapping is visible.

**2.2.9 [m] "`hv_vcpu_run` is a syscall that returns when the guest takes an exception HVF
forwards."** Fine, but this sentence appears in both ch02's objectives and derivation step 3. Say it
once, in the lesson body, with a picture of the call stack (our thread blocked in the kernel, then
guest running, then back).

**2.2.10 [m] "HVF ties a vCPU to the thread that created it" appears as a surprising fact without a
reason.** Journal Q4 asks "what does that force on a multi-vCPU design?" and is parked to ch20. A
learner has no model to answer, and a "park" question with no scaffold is noise. Either supply the
reasoning (the vCPU's register state lives with the thread; migrating threads would need a state
transfer) or drop the question.

### Ch03 `test-guests`

**2.3.1 [M] Bare-metal Rust is a new world and gets one 25-minute primer.**
`no_std`, `no_main`, target triples, `rustup target add`, linker scripts, section layout, load vs run
address, BSS, objcopy, the panic handler, a `_start` in assembly: this is a week of material for
someone who has never done embedded work. The plan lists 15 minutes of reading plus the lesson's 3.5
hours. The risk is not that the content is wrong; it is that the learner conflates "my guest" (this
chapter) with "my VMM" (every other chapter). Two Rust programs, two targets, two kinds of
`main`. Give them different names consistently ("the guest" and "the monitor") and show the build
layout early.

**2.3.2 [M] The hypercall IDs "`x0 = 0xC600_0001`" look arbitrary.**
Objective 3: "recognise their IDs as SMCCC vendor-hypervisor fast calls". The `smccc` primer is
required first (20 min), but a learner at this point does not know why a fast call has the high bit
set and bits 29..24 equal `0x06`. The plan claims "the registers are the API" (ch08). I would like to
see, in ch03, the three lines that explain: "`0xC6000001` means: fast call (bit 31), 64-bit (bit 30),
vendor hypervisor (owner `0x06`), function 1. We could have used any number; this convention means a
real kernel would not confuse our call with its own".

**2.3.3 [m] "`--raw FILE@ADDR`", "`--timeout`", "exit 5" and "`--trace exits:...:hvc`".**
New CLI flags at a rate of three per chapter, and exit-code meanings (0,1,2,3,4,5,6,130) are
spread across chapters. Put the exit-code table in one place the learner can keep open; section 3.3
lists it but section 3.3 is in the author document.

**2.3.4 [M] "A HVC round trip costs about 1.0 to 1.6 µs... compare with a `str` to RAM (roughly
1,000×)."**
The jump: the number is real, but the Predict fork gives the spike's number "before any VMM work" as a
lower bound and then asks the learner to compute a ratio that "is the argument of Part VII". How does
the learner measure "a `str` to RAM"? The chapter does not say. In the guest, a store takes a
nanosecond or less; the learner needs the code and the reasoning (timer counter reads, 24 MHz
resolution, ~41 ns per tick, so a single store cannot be timed individually; loop a million). If the
plan ignores this, the "1,000×" will be a number the learner takes on faith.

**2.3.5 [m] "Breaks": delete BSS zeroing, "fresh RAM is zero-filled, which made the bug invisible"
is fine, but BSS has not been defined anywhere beyond the primer scope line.** Make sure the chapter
shows one concrete `static mut COUNTER: u32 = 0;` and how it ends up in `.bss`.

### Ch04 `guest-memory`

**2.4.1 [M] The chapter's key idea is gated behind Rust reference semantics.**
"A `&[u8]` into guest RAM promises Rust that nobody else mutates it, which a concurrent guest
breaks." For a C-leaning learner who has never been bitten by aliasing UB this is abstract. A concrete
demonstration helps: show the optimiser hoisting a read out of a loop because the slice cannot change.
Also: *today* there is only one vCPU, and it is stopped while we handle its exit (journal Q3 says
this). So the concurrent-guest threat is not currently real, and the chapter asks me to accept a
contract motivated by a threat I cannot reproduce. That is an honest tension; the plan should flag it
to the learner ("this is not a bug today; it will be one in Part VII").

**2.4.2 [M] "Volatile element copies versus `copy_nonoverlapping`": I do not know what volatile does,
and the difference is a subtle compiler-level one.**
The plan lists it as core. Nothing in Part 0-III prepares the learner for LLVM's notion of volatile
vs. a memcpy that assumes no concurrent mutation. Also, volatile does not provide atomicity or
ordering; a novice who reads "volatile" in C often takes it to mean thread-safe. The primer
`memory-ordering` arrives in ch16. Please state in ch04 what volatile does and does not give you.

**2.4.3 [M] `hv_vm_allocate`, "aligned to 16 KiB", "`hv_vm_map` rejects anything else".**
Journal Q4 asks "why 16 KiB?" with evidence "the Predict run", but the actual reason (Apple Silicon's
base page size in macOS is 16 KiB, and stage-2 permissions are per host page) is not available to
the learner from the run alone; it requires the `page-granules` primer plus the explanation that
stage 2's granule is HVF's. The primer is 15 minutes and lists "stage 1 belongs to the guest, stage 2
to HVF". OK, but the learner must *already* know what a granule is.

**2.4.4 [m] "`GuestAddress` newtype", "`VecMemory`" as a host test double, "frozen `GuestMemory`
contract of architecture §6.1".** The learner is told to implement a contract frozen elsewhere in a
file they might not have (`docs/architecture.md`). For lifeline reasons this is right; just make the
lesson self-contained (reproduce the trait in the lesson).

**2.4.5 [M] "Memory-ordering is seeded with one forward pointer" and "Coherence evidence... MMU-off
coherence ... Under the hood callout ... `[U]` until M3 captures it".**
This is the first place a cache shows up, and the plan says the *chapter* will contain a callout that
admits the course does not yet know the result. The learner will see: "`memtest` passes with the guest's
MMU off, so HVF makes the VMM's cacheable view and the guest's MMU-off view agree." I would have no
idea what an "MMU-off view" is (the guest's stage 1 is off; accesses are treated as Device or
non-cacheable). It must either be deferred to ch06 where the `caches` primer arrives, or be a
clearly labelled optional aside.

### Ch05 `address-space`

**2.5.1 [M] The chapter introduces stage 2 as the answer to a problem ("every guest page-table write
would have to trap") that I have not been taught.**
The chapter lists primers `page-tables` and `page-granules` as read-first, and the explanation of
shadow paging is one paragraph. For someone whose only picture of virtual memory is `os-basics`'s
"one picture", the rejected alternative (shadow page tables) is hard to follow: what does "copy the
guest's page tables into shadow tables" mean when I do not know what a page table looks like? I would
need the two-stage picture first (stage 1 then stage 2), then the problem. The curriculum's order
(problem, then rejected alternative, then solution) is right in principle, but the problem's setup
needs the page-table primer's content immediately before it, not 3 chapters earlier.

**2.5.2 [M] "Walk a guest VA through a stage-1 table by hand to an IPA, then say whether stage 2 maps
it, with independent granules" (objective 4).**
A learner who has never seen a four-level walk will struggle here. The `two-stage-walker` lab is
the right tool, but the *objective* states a hand computation. Rate this as the hardest single
objective in Parts 0 to III. Provide a pre-worked example and a three-level (not four) toy first.

**2.5.3 [M] "DFSC", "HPFAR_EL2", "ESR", "FAR", "translation fault vs address-size fault".**
Five unglossed ARM fault terms in the Concepts box for one chapter. HPFAR_EL2 (the register that holds
the faulting IPA) is a surprising thing: the data abort tells us an IPA, not a VA, and the *reason*
(the hardware has already translated through stage 1) is the actual idea. The text puts this in
journal Q1 as a question. I would want it in prose.

**2.5.4 [M] `layout.rs` as "single source of truth for the QEMU-`virt` map" and the checkpoint L1
values like `virtio_slot(31) == (0x0a00_3e00, 79)`, `ipa_bits_needed(0x6000_0000) == 36`.**
These are real tests, fine, but the lesson has not explained why a virtio slot has an INTID of
`48 + slot` (that is a QEMU `virt` convention), what an INTID is (forward definition to ch11/12), why
`0x0a00_0000` is the virtio base (QEMU's choice), or why `ipa_bits_needed(0x6000_0000) == 36` (it is
2 GiB beyond 0x4000_0000, so we need `log2(0x6000_0000) = 30.58`, round up to 31?). Wait: `0x6000_0000`
is 1.5 GiB, 31 bits suffice, yet the test says 36. Presumably the function has a minimum of 36 for
some reason (a floor of HVF's default). The reason for 36 is not stated anywhere I can read. A
learner who computes `log2(0x6000_0000)` will get 31 and distrust the checkpoint. **This is a real
confusion point**: either explain the 36 (default/minimum IPA size) or choose a test value that
exposes the reasoning.

**2.5.5 [M] "Predict fork: Map a RAM page at `0x0900_0000`... Does text appear? Tempting: yes."**
This depends on the learner knowing that PL011 lives at `0x0900_0000` and what "prints by storing to
the UART's data register" means. UART has not been introduced (the pointer says "UART basics: FIFO,
transmit/receive, baud divisors" lands in ch09). At ch05 the learner has no way to know why a write to
an address would print. It is explained inside the chapter ("reading PL011 `DR` pops a FIFO, writing
it transmits"), so it is not a gap, but it comes in the same section as the hole mechanics; consider a
two-sentence UART intro at first mention.

**2.5.6 [m] The doctor line "max IPA: 40 bits (default 36)" is "parked for ch05" (ch01 journal Q4).**
Good. But the answer ("a VM has a limit on its physical addresses because stage 2 has an input
size") is not obvious from anything in ch01 to 04. If the question is a "park", the plan should give
the learner a thread to hold ("what does the CPU do with an address it has not translated?").

### Ch06 `vcpu-state`

**2.6.1 [M] Part III opens with another list of bit-fields.**
"PSTATE and SPSR in full (`M[3:0]`, SPSel, DAIF); `SCTLR_EL1` (M, C, I, A); `MPIDR_EL1`; alignment
faults; the reset state; the register dump". For a learner with no ARM background this is a
reference table, not a concept. The question the chapter should lead with is: "what has to be true
about a CPU for it to start running someone else's code correctly?" Then pull the registers in as
answers to that question.

**2.6.2 [M] `MPIDR_EL1` is justified as "looks like trivia; find three later places". The motivating
reason is that the CPU's own number is how an OS tells its cores apart.** That deserves a sentence
here. A learner told "set `MPIDR_EL1` = `0x80000000`" has no idea why bit 31 is set (it is RES1 on
modern cores, or a "multiprocessor format" bit). It becomes a magic constant that the `regcheck` guest
prints back.

**2.6.3 [B] The self-fault checkpoint (`self-fault` expects "instruction abort at pc=0x200") will
confuse a learner thoroughly.**
The Predict fork asks: will the VMM report an alignment fault or something else? The expected answer:
an *instruction abort at `0x200`*, because the alignment fault went to the guest's own vector table (at
`VBAR_EL1 = 0`, offset `0x200`, which is unmapped), which then faults as an instruction fetch. For
me, this chain has 6 links (unaligned load with A=1, so alignment fault; goes to EL1, not us; the
vector address is `VBAR_EL1 + 0x200`; VBAR is zero; address 0x200 is not mapped; the fetch from it
aborts to EL2; HVF forwards it to us). I need each link as a numbered mini-trace, with the register
values after each link. The plan says "the dump shows it", but this is the first time the learner has
to read a *first* fault versus a *second* fault; that skill deserves its own half-page.

**2.6.4 [M] `caches` primer is required for a chapter whose objectives never mention caches.**
Ch06 concepts: "`caches` (why the kernel insists on the MMU and caches in a defined state)". Objectives
(1)-(3) concern PSTATE, reset, and a dump. The primer is 20 minutes of PoC/PoU/CTR_EL0 for a chapter
that uses none of those words. If the point is "SCTLR_EL1.M=0, C=0", a short paragraph does it. The
heavy `caches` primer should be moved to ch13, where "cleaned to PoC" matters, unless ch06's lesson
text actually needs it.

**2.6.5 [m] "Reset state": "What does a CPU look like at power-on?" is never contrasted with what a
warm VM start looks like.** The word "reset" is used for both a PSCI `SYSTEM_RESET` (ch08) and the
CPU's reset state. Clarify.

### Ch07 `exit-loop`

**2.7.1 [M] The chapter's jump from "exit enum" to "ISV, SAS, SSE, SRT, SF, WnR" is steep.**
Objective 2: "For a data abort with ISV=1, decode SAS, SSE, SRT, SF and WnR and emulate the access:
mask a write to its size, sign-extend a read, treat SRT=31 as XZR (never SP)". Six acronyms with
no expansions. For a learner, what matters is a story: "the guest executed `str w2, [x1]`; the
hardware wrote a note: this was a write (WnR), of 4 bytes (SAS), from register 2 (SRT), 32-bit
register (SF). That note is called the instruction syndrome (ISV says whether the note is valid)." I
would also need the contrast with x86, where the VMM must decode the instruction itself, to
appreciate why ISV matters. Lead with the story, then the table.

**2.7.2 [M] `reading-arm-specs` is required before ch07 for the first time (25 min).** This
is the first chapter that *needs* the ARM ARM, and it appears at hour ~25. The skill (read a
register page, ISS tables, "RAZ/WI", "UNKNOWN") is a precondition for the whole second half of the
course; I would introduce it at ch02, applied to `ESR_EL2` EC values, and then reuse it. As planned,
ch02 asks me to pick EC `0x16` out of an ESR with no spec-reading guidance beyond the lesson.

**2.7.3 [M] "ISV=0 for `ldp`" is a mystery to a novice.**
Journal Q3: "`ldp x0, x1, [mmio]` gives ISV=0 `[V]`. Why, and is it the guest's bug or ours?" The
answer needs: ISV is only set for single-register loads and stores (the hardware has one register
number field, SRT, which can name just one register); `ldp` names two. The plan names the reason only
in the Pointers: "exclusives, LSE atomics, SIMD loads and DC ZVA, which give ISV=0". The
*reasoning* is one sentence and deserves to be in the chapter body.

**2.7.4 [m] "the frozen `Exit` enum (architecture §6.4)" with eleven variants including `Wfx`, `Brk`,
`VtimerActivated`** shows up in the objectives. The learner cannot yet say what `Wfx` (a wait for
interrupt/event instruction) or `Brk` is. Fine as a list in the lesson, but the objective should not
require decoding them all in ch07 if they are not used until ch11 and ch27. Say which ones are
implemented now.

**2.7.5 [m] "The 1,000,000-ESR panic sweep" (PLAN column) is an excellent test, but "panic sweep" is
unexplained to a learner.** One line: "your decoder must not panic for any 64-bit input; the guest is
hostile".

**2.7.6 [M] Predict fork: "Comment out the PC advance after a data abort... Expected: (b), the same
exit forever".** Reasonable, but the reasoning requires understanding that a faulting instruction is
*retried* (preferred return address = the faulting instruction). That is only taught in ch02 as a
rule, and the learner may not have internalised "fault means retry". Link back.

### Ch08 `traps-psci`

**2.8.1 [B] Too many first-time ideas in one chapter.**
Objectives: sysreg trap decode (Op0, Op1, CRn, CRm, Op2, Rt), the policy table (emulate, RAZ/WI,
inject UNDEF), exception injection by hand (five registers plus vector arithmetic), SMCCC dispatcher,
PSCI four functions, HVC vs SMC conduits, exit-code mapping. That is at least four independent
concepts. The plan lists time as 3.5 h. For a learner who is only now getting comfortable with ESR it
is two chapters.

**2.8.2 [M] "HVF owns `HCR_EL2` and `MDCR_EL2` and forwards only some accesses, so which registers
trap is *measured*".**
Neither register is introduced (they are in a "pointer"). The key idea (a trap-control register
decides what leaves the guest, so "what does the guest do that reaches us?" is an experiment, not a
spec lookup) is subtle and genuinely good. It would help to state it as a principle, then name the
registers as the mechanism.

**2.8.3 [M] "Inject UNDEF" by hand: `ELR_EL1 <- PC`, `SPSR_EL1 <- CPSR`, `ESR_EL1 <- EC<<26|IL|ISS`,
`CPSR <- EL1h with DAIF`, `PC <- VBAR_EL1 + {0x000, 0x200, 0x400}` chosen by source mode.**
A learner needs a picture (the same exception entry as ch02 but performed by software). The jump:
why does *our* code do what the hardware normally does? Because HVF delivered the exception to us
instead of to the guest's EL1 vector, and the guest expects the architectural effect. The plan's
step 7 in section 1.5 says this ("inject the exception the real CPU would have raised, by doing by hand
what the hardware does in step 3"), but it is the single most conceptually dense sentence in Part III
and should be worked as an example with real numbers.
Also: vector offset "chosen by source mode" with three values `0x000, 0x200, 0x400` skips the fourth
group (lower EL AArch32 at 0x600) and the whole "synchronous / IRQ / FIQ / SError" dimension. The
learner will think the table has three entries. Draw the 16-entry table once.

**2.8.4 [M] "Return 0 for unknown sysreg or inject UNDEF" requires an idea of "what would real
hardware do for an unimplemented register".** Answer: it raises Undefined. Hence "UNDEF is the honest
answer". The plan's Predict fork says "the probe passes while being told a lie". Good insight; just
needs the learner to have the notion that a guest *probes* hardware to discover features (ID
registers). That was a pointer only. Explain in the chapter: "kernels ask the CPU 'do you have a
performance counter?' by reading a register; if we answer yes with zeros, the kernel believes it".

**2.8.5 [M] PSCI is introduced as "ask the platform for power and CPU control" (ledger row 4) but
"platform" is never defined, and "firmware" is mentioned in row 4 ("no firmware exists") before
anything says what firmware does.** A learner has `os-basics` "what a kernel does at boot", which
probably covers some of this, but *firmware* is not a listed primer topic until ch21 (`uefi`,
`u-boot`). Add a two-sentence "what firmware is" to `os-basics`.

**2.8.6 [m] "SMCCC `NOT_SUPPORTED (-1)`, rate-limited warning".** "Rate-limited" is fine to a
programmer. "Fast calls" and "yielded calls" (the lab asks for "fast or yielded" in the function ID)
are in the `smccc` primer scope; the plan should give one sentence on the distinction.

**2.8.7 [m] "From here on every test guest ends with `SYSTEM_OFF`, and the VMM exits 0."** Good.
But exit codes 0, 4, 5, 6, 130 are now five different meanings. A table in the lesson with each cause.

**2.8.8 [M] `AtomicBool` stop flag forward-defined as "a flag two threads may read and write
without a lock; the host-concurrency primer (before ch09) explains atomics".**
At ch08 the course has exactly one thread (the single vCPU) plus possibly a signal handler. Why is
there a stop flag shared between threads at all? The learner is told about a thing for which no need
has been shown. Defer to ch09 where the stdin thread appears, or show who writes the flag (the
Ctrl-C handler) now.

---

## 3. CONCEPTS.md

**3.1 [M] The register is excellent for authors and unreadable for a learner.** It is a table of 150
rows of `Concept | Tier | First used | Taught in | GAP`. A learner cannot tell from it what to read
when they hit a term. Turn it into the glossary with a one-line definition per row and a link to the
place it is taught. The data is already there.

**3.2 [M] Several concepts are classified "pointer" or "prereq" that the persona does not have.**
- *Page fault / virtual memory:* "prereq" or `os-basics`. A programmer who "knows processes and
  pointers" does not necessarily know page tables, TLBs or demand paging. The plan treats them as
  covered by `os-basics`'s "virtual memory and page faults in one picture". One picture is thin for a
  concept ch05 uses mathematically (multi-level walks, granules, descriptors).
- *Hex, two's complement, bit fields:* prereq, checked by the self-check, fine. But the course relies on
  bit-field reading far more heavily than a typical programmer practises (decode `0x3c5`, the ESR ISS,
  PSTATE, SMCCC IDs). A bit-field reading lab in the setup self-check would be worth more than the byte
  order question. (There is the `a64-encoder` lab; consider adding a standalone "bit fields" warm-up.)
- *Atomics:* "primer", first used in ch08 (a flag) and taught in ch09. The row's GAP says
  "Closed v3: ch08 box, Forward definitions", which means the learner sees `AtomicBool` and is told to
  wait a chapter. For a Rust-light learner that is a stumbling block; see 2.8.8.
- *"Virtual memory in one picture"* sits in `os-basics` (30 min), yet that primer also carries: process,
  exit status, privilege, syscall, interrupt, preemption, threads, file descriptors, kernel boot.
  Nine topics in 30 minutes is two primers.

**3.3 [M] "Mach error codes" (pointer), "AMFI", "SIP", "hardened runtime", "restricted entitlements
and provisioning profiles", "`DYLD_*` injection (SIGN-3)" are listed as all being covered by one
20-minute `codesign-entitlements` primer.** That is a lot of macOS security jargon with no pedagogic
connection to virtualization. The learner needs: "the kernel will not let an unsigned program use the
virtualization hardware; we sign ours ad hoc with one permission". Everything else is optional. Split
"need to know" from "going deeper".

**3.4 [m] A few rows say "core" but the learner does not implement them:** "Hardware-assisted
virtualization", "Type 1 vs type 2". They are understanding-level concepts, not code. The tiering rules
(core = learner implements) are violated; harmless, but it muddies what "core" promises.

**3.5 [m] "First used" is wrong for some rows relative to what I read.** E.g. "IPA size and
`hv_vm_config_set_ipa_size` ... first used 00 (doctor) ... GAP: parked in 00 by design". The ch01 text
also uses it, and the ch02 objective uses an IPA. The row for "Virtual devices; device emulation vs
paravirtual devices" says first used 00 and taught 00 (idea), 09, 15; that is a three-chapter
deferred concept with nothing to hold on to.

**3.6 [m] The register lists 'DMA / bus mastering' as core, first used 15. A novice who has never
heard of DMA (a device reading RAM by itself) needs it much earlier than 15 to understand why the
guest's memory must be mapped for devices at all.** I would mention it in ch04 (guest memory) as a
one-sentence forward note.

---

## 4. Cross-cutting issues, ranked

1. **[B] Chapter 02 is too heavy (and ch08 nearly so).** Split or sharply prune the objective list;
   put the syscall-to-exception derivation in a standalone lab-first section.
2. **[B] No learner-facing "start here"; the course starts with author-facing theory.** Add a one-page
   orientation with time, hardware, and what the first 8 hours are for.
3. **[B] Forward use of EL0/EL1/EL2, vGIC, vtimer in the ch01 stack figure.** Add a legend, or move the
   figure after ch02.
4. **[M] Acronym density.** Every chapter's objectives list reads like a spec index. Expand on first use per
   page; ship a glossary built from CONCEPTS.md.
5. **[M] "Hypervisor" is defined narrowly here and widely elsewhere.** Say so, once, explicitly.
6. **[M] Labs that precede their teaching (`trap-or-not` in ch01, `a64-encoder` in ch02,
   `two-stage-walker` hand walk in ch05).** Make them exploratory and unscored, or move them after the
   teaching.
7. **[M] Several "park" questions have no thread to hold** (ch01 Q4 max IPA; ch02 Q4 thread affinity;
   ch04 Q3 TOCTOU timing). A parked question needs a sentence of why it is interesting now.
8. **[M] Explicit unexplained numbers in checkpoints** (`ipa_bits_needed(0x6000_0000) == 36`,
   `MPIDR_EL1=0x80000000`, `virtio_slot(31) == (0x0a00_3e00, 79)`). Each constant should be traceable to a
   sentence that explains it.
9. **[M] Primer scope creep** (`os-basics` has nine topics; `codesign-entitlements` has six jargon
   items; `caches` required by a chapter that does not use it).
10. **[m] Evidence tags (`[V]`, `[U]`) and PLAN/risk IDs (K11, M4) in the curriculum.** Fine for authors;
   hide or translate for learners.

## 5. What worked (to keep)

- The opening puzzle in ch00 ("who is fooled, and how does the fooling stay fast?") and the
  thought experiment ("load a Linux Image into a process and jump to it").
- Deriving each strategy from the cost or hole of the previous one, in historical order.
- The `GETMODE` toy instruction: a concrete, runnable demonstration of Popek and Goldberg.
- "Syscall, then the same thing one level up" for the exception model; `hvc` as the `svc` of EL1.
- Predict forks with an explicit tempting wrong answer (PC after HVC, unsigned doctor, PC advance
  omitted, return 0 for unknown sysreg).
- Honesty tags: stating what was observed versus inferred versus unknown.
- The hostile-input thread (checked arithmetic, no `&[u8]` into guest RAM) starting early.
- Retiring the toy explicitly and saying where it was wrong.

## 6. Smallest set of changes that would most help me

1. Write the one-page "Start here".
2. Put a legend of EL0/EL1/EL2 under the ch01 figure; defer vGIC/vtimer labels.
3. Split ch02 into "exceptions" and "first VM run"; or cut its objectives to three.
4. Add the 6-link trace to ch06's `self-fault` and one worked trace to ch08's injection.
5. Explain `ipa_bits_needed(...) == 36` and the other magic constants.
6. Turn CONCEPTS.md into a learner glossary.
7. Move the `caches` primer from ch06 to ch13 unless ch06's text uses it.
8. Make `trap-or-not` and the `a64-encoder` pre-reveal exercises explicitly exploratory.
