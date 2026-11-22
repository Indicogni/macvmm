---
title: Two kernels, one Mac: what a virtual machine is
part: 0
chapter: 0.1
id: 00
runs: mac+browser
minutes: 210
prereqs: []
start_tag: none
labs: [toy-vmm, syscall-stepper]
command: scripts/checkpoint.sh 00
expect: CHECKPOINT 00 PASS
---

:::concepts
- **Core, taught here:** virtual machine, host, guest, virtual machine monitor (VMM), hypervisor; the problem ledger; emulation; trap-and-emulate; sensitive versus privileged instructions and Popek and Goldberg's condition; binary translation; paravirtualization; hardware assist (the idea); a second translation stage (the idea; chapter 05); emulated versus paravirtual devices (the idea; chapters 09 and 15).
- **Core, from earlier:** none; this is the first chapter.
- **Primers (read first):** `os-basics` (process, user and kernel mode, trap, privileged instruction, system call, page table, interrupt, firmware).
- **Pointers:** QEMU's translator; x86 and `POPF`; Popek and Goldberg's three properties; the timeline's systems; KVM.
- **Forward definitions:** VM exit and the exception levels EL0 to EL3 (chapter 02); Virtualization.framework (chapters 01 and 23); the doctor's lines about the IPA (intermediate physical address), EL2 and entitlements (chapter 01).
:::

Suppose you run Linux in a virtual machine app on your Mac. Linux believes it owns the processor, the memory and every device. So does macOS, underneath it. They cannot both be right, so one of them is being fooled.

There is an easy way to fool Linux: write a program that *pretends* to be a processor, reading Linux's instructions one at a time and doing what each says. It works, and it runs many times slower than the real chip. Yet the apps people use run Linux at nearly full speed. So the real puzzle is this: how does the fooling stay fast?

This chapter answers that by building the course's [**problem ledger**](/build-your-own/vmm/glossary/#problem-ledger): everything a kernel assumes it owns. Every later chapter closes one of its rows. You work each classic answer through on a toy machine, then check that your Mac is ready.

:::objectives
- Explain, with an example, what a virtual machine, host, guest, VMM and hypervisor are (including that most writing uses "hypervisor" for the last two), and give two reasons to want a virtual machine.
- Predict, for the thought experiment, at least three things that break, in your own words, then place each in a ledger row (coarse answers count; the rows you missed are part of the lesson, not a failure).
- Run the same toy guest in `toy-vmm` under interpretation, trap-and-emulate, binary translation, paravirtualization and hardware assist; record for each the VMM interventions per 1,000 guest instructions and whether the console output matches bare metal; explain every difference.
- State Popek and Goldberg's condition in one sentence, name the toy instruction set's sensitive but unprivileged instruction, and explain from it why a processor with such instructions needs binary translation or paravirtualization.
- Place the five strategies on a timeline with one real system each (QEMU, IBM VM/370, VMware, Xen, Intel VT-x or Arm's EL2), saying which problem each solved and what it cost.
- Run `scripts/setup.sh` and `scripts/doctor.sh` and say what `hv_vm_create: OK` means in this chapter's terms.
:::

**If a lab does not load.** The `toy-vmm` and `syscall-stepper` labs run in your browser. Without them, objective 3 still works on paper: trace each mode through the toy program listed below, and count which instructions the VMM handles. The primer's system-call diagram stands in for the stepper.

## Before you start

Get the code first. You need the Xcode command line tools (`xcode-select --install`) and [rustup](https://rustup.rs), which installs Rust. Then clone the repository and run its setup script, which checks your Mac and installs the exact Rust version the course uses:

```sh
git clone https://github.com/Indicogni/macvmm.git
cd macvmm
scripts/setup.sh
```

It ends with `setup: OK`. Now, from the repository root, run:

```sh
scripts/learner init
scripts/learner start 00
```

The first run compiles a helper, so it may be silent for a minute. `init` creates `learner/`, where your VMM grows from chapter 01 on; `start 00` copies this chapter's journal to `learner/journal/00.md`, "your journal" below, which never leaves your Mac. In a fresh clone:

:::term source=captures/00-learner-init.txt

"Level worked" means this chapter gives you everything; later chapters hand you less.

If you have a virtual machine app (UTM, Parallels Desktop or VMware Fusion), boot anything and open Activity Monitor: the whole guest computer is one or a few ordinary processes. Or see it with this course's program:

:::term source=captures/00-guest-is-a-process.txt

Linux waits at its prompt, `/ # `, and macOS sees one process, `macvmm`. Idle Linux costs macOS almost no processor time (0.0 %CPU); the six threads include one per virtual processor. Exit code 5 means macvmm stopped the guest itself, because our script asked for `--timeout 8` (8 seconds); Linux had not crashed. This is our run: you cannot repeat it yet, because it needs a Linux kernel the course downloads later. Your own VMM reaches this prompt in chapter 14.

## The words: guest, host, VMM, hypervisor

The illusion of a whole computer, made for an operating system that is not really in charge of one, is a [**virtual machine**](/build-your-own/vmm/glossary/#vm) (VM). The operating system inside it is the [**guest**](/build-your-own/vmm/glossary/#guest); the one that really runs the machine, macOS for us, is the [**host**](/build-your-own/vmm/glossary/#host). The program that keeps the illusion going, the `macvmm` process above, is the [**virtual machine monitor**](/build-your-own/vmm/glossary/#vmm) (VMM). People want virtual machines to isolate untrusted software, run another operating system without rebooting, pack many servers onto one machine, and crash a test kernel instead of their laptop.

One more word, with a warning. Most of the world uses [**hypervisor**](/build-your-own/vmm/glossary/#hypervisor) and VMM for the same thing: you will read "QEMU is a hypervisor" and "KVM is a hypervisor" (two programs that run virtual machines; Asides below place them), and both are fine.

This course must tell apart two pieces, so it uses the word narrowly. The **hypervisor** is the part that controls the processor's support for virtual machines, at a processor level more privileged than the kernel's (the level above kernel mode that the `os-basics` primer set aside; "Hardware assist" below says where it came from). On a Mac it is a part of macOS. The **VMM** is the program that builds the machine around the guest; on a Mac, ours. When you read that a program "is a hypervisor", translate it as "is a VMM, or a VMM plus its privileged part".

## A thought experiment: run a kernel as an app

A Linux kernel is a file of machine code, like any program. So copy it into an ordinary process's memory, mark that memory executable, and call its first instruction as if it were a function. What breaks?

Write at least three predictions under `## Predict` in your journal before you open the answer. If nothing comes, try these prompts:

- When a kernel starts, what does it set up before any app runs? Think: memory, a console, a disk.
- What does it need from the hardware while it runs? Think: a key press, a clock tick.
- What does it do that an app may not? Think of the `os-basics` primer's user and kernel modes.

:::predict A kernel runs as an ordinary app. What breaks? Write three guesses before you open this.
Coarse answers count: "it can't talk to the disk" is a full answer. Write each guess's row number next to it. A row you missed is not a failure; it is a need that is easy to miss.

| Row | The kernel assumes it owns... | As an app, it breaks because... | Closed in chapter |
|---|---|---|---|
| 1 | the processor's privileged state | user mode cannot run kernel-only instructions | 02, 06 |
| 2 | physical memory and its page tables | a process sees only its own addresses | 04, 05 |
| 3 | devices at fixed addresses | nothing answers there | 05, 07, 09 |
| 4 | a way to power off, reboot, or start other processors | there is no firmware to ask | 08, 20 |
| 5 | a description of the machine | it cannot discover the hardware | 10 |
| 6 | interrupts from devices | none reach a process | 11, 12 |
| 7 | an alarm clock, to take turns and sleep | no timer is wired to it | 11, 12 |
| 8 | cheap bulk input and output | every device access that needs a helper program costs a slow round trip | 03, 15 to 19 |
| 9 | several processors | a thread is not a processor | 20 |
| 10 | a boot chain that loads it | nothing loads it | 13, 14, 21 |

*The problem ledger. "Breaks" means: in an ordinary process, with no help.*
:::

This chapter explains rows 1 to 3, 6 and 7; row 4 needs [firmware](/build-your-own/vmm/glossary/#firmware), the program a processor runs first, and the rest wait for their chapters. Row 1 bites hardest, so we start there.

## Strategy 1: interpret every instruction

The easy answer from the opening: keep a software copy of the whole machine (registers, memory, a mode bit) and loop: fetch the guest's next instruction, decode it, and do what it says to the copy. That program is an [**emulator**](/build-your-own/vmm/glossary/#emulator). It is correct for any guest on any host, even an Arm guest on an Intel-based computer, and slow: tens of host instructions per guest instruction. QEMU, the best-known emulator, began this way.

Time to meet the toy machine:

- four registers, `r0` to `r3`, and a program counter (`pc`, the address of the next instruction);
- a mode bit: the primer's "user mode" or "kernel mode";
- a base-and-limit register: in user mode every address the program uses is added to the base, and an address past the limit traps; kernel mode uses addresses as they are. This is the toy's whole page table;
- an interrupt-enable bit, switched off by `CLI` and on by `STI`;
- 256 words of memory; the console sits at `0xF0` to `0xFF`, and a store to `0xF0` prints a character;
- ordinary instructions (`LI`, load a number; `ADD`; `LD`; `ST`; `JNZ`, jump if not zero); `SYSCALL`, an app asking its kernel (it enters kernel mode at address `0x10`, saving the return address in `r3`); the privileged `SETBASE`, `IRET r3` (back to user mode, at the address in `r3`), `CLI` and `STI`; `GETMODE`, which reads the current mode; and, in mode G only, `HCALL`, which asks the VMM directly.

Its guest is a toy kernel and app. Each line is marked P (privileged), S (sensitive but unprivileged: you will meet the word shortly), C (a console store) or T (traps by design: a system call):

```text
addr  instruction          mark  what it does (addresses in hex)
--- toy kernel, loaded at 0x00 ---
00    SETBASE 0x20, 0x1F    P    the app's memory: 32 words from 0x20
01    STI                   P    interrupts on
02    GETMODE r1            S    r1 = 1 in kernel mode, 0 in user mode
03    JNZ  r1, 07                kernel mode? skip the panic
04    LI   r0, '!'               panic: ...
05    ST   r0, [0xF0]       C    ...print "!"...
06    JNZ  r0, 06                ...and spin here forever
07    LI   r3, 0x00              the app starts at its address 0
08    IRET r3               P    enter the app, in user mode
10    ST   r0, [0xF0]       C    system-call handler: print r0
11    IRET r3               P    back to the app
--- toy app, at 0x20 (it sees it as 0x00) ---
00    LI   r0, '1'               the first character
01    LI   r1, -3                a counter that climbs to 0
02    LI   r2, 1
03    SYSCALL               T    ask the kernel to print r0
04    ADD  r0, r2                next character
05    ADD  r1, r2                count up
06    JNZ  r1, 03                not 0 yet? print again
07    JNZ  r2, 07                done: spin here (r2 is never 0)
```

The kernel never runs `CLI`. On bare metal (mode A) the console prints `123`, the reference, after 23 instructions; after 27 the app reaches its spin loop and stays there for the rest of the 1,000-instruction budget.

:::lab toy-vmm

Mode B is the thought experiment: in user mode with no VMM, the first instruction, `SETBASE`, is privileged, so the process dies (row 1). Mode C is the emulator: the VMM acts on all 1,000 instructions. The lab's timings use an invented cost model (1 ns per native instruction, 1 µs per VMM intervention); chapter 03 measures the real cost.

> **Aside.** Without the processor's help, QEMU is a cleverer emulator: it translates each block of guest instructions into host code once and reuses it ([Bellard, 2005](https://static.usenix.org/event/usenix05/tech/freenix/bellard.html)). With the help described under "Hardware assist", it becomes a VMM like ours.

## Strategy 2: deprivilege, trap, emulate, resume

Recall the system call from the `os-basics` primer: an app in user mode asks, the processor switches to kernel mode and jumps to the kernel's handler, and the kernel returns to the app. Step through it again:

:::lab syscall-stepper

Now apply that picture one level over. Run the guest *kernel* natively, but in user mode. Most of its instructions (adding, loading, branching) are harmless and run at full speed.

When it reaches for something only a kernel may do, the processor [traps](/build-your-own/vmm/glossary/#trap), as in the primer, but into the VMM, which in this classic design runs in kernel mode. (On a Mac that job is split between macOS and our program; chapter 01 shows how.) The VMM updates a *virtual* copy of the state the guest believed it changed (its mode, its base register) and resumes the guest after the instruction. This is [**trap-and-emulate**](/build-your-own/vmm/glossary/#trap-and-emulate): deprivilege, trap, emulate, resume.

Devices get the same treatment. In mode D the VMM gives the guest base `0x40` and limit `0xAF`, so the console range is past the limit and each console store traps; the VMM plays the console. Interrupts and the clock too: `CLI` and `STI` trap, so the VMM keeps a *virtual* interrupt-enable bit and delivers virtual interrupts, clock ticks included, only while it is on.

Memory is harder, because a real guest kernel writes its own page tables. The classic answer was [**shadow page tables**](/build-your-own/vmm/glossary/#shadow-page-table): a real set the VMM keeps, mapping the guest's addresses straight to host memory, kept in step by write-protecting the guest's own tables, so the guest's writes to them fault into the VMM. In the toy this is one addition: the guest's `SETBASE` traps, the VMM remembers the guest's base (`0x20`) as a virtual value, and when the guest enters its app it loads the real register with the guest's base plus its own (`0x60`).

:::predict In mode D, the toy guest runs 1,000 instructions. How many does the VMM execute on its behalf: (a) all 1,000, since it is running the guest; (b) about 1,000 plus some overhead; (c) a handful?
Write your guess and one sentence of reasoning under `## Predict` in your journal, below your ledger guesses, then follow mode D through the listing.

The answer is (c). The VMM acts only on what traps: the privileged instructions (`SETBASE`, `STI`, both `IRET`s), the console stores, and `GETMODE` (remember that one). It also acts on the app's system calls: the processor sends every trap to real kernel mode, which is now the VMM, so the VMM must pass each one on to the guest kernel. From the listing: four traps to start (lines 00, 01, 02 and 08), then three per character (`SYSCALL`, the store, `IRET`), 13 in all. The other 987 run unseen.

If you chose (a), you held this chapter's misconception, "a VMM emulates the processor": that is an emulator, mode C. If you chose (b): the VMM is not even running between traps.
:::

## When trapping is not enough

Mode D quietly cheated: it made `GETMODE` trap, which the toy's processor does not do. Nor did the mode-reading instructions of x86, the instruction set of the Intel and AMD processors in 1990s personal computers. The failure it hid: the guest kernel asks the processor "am I in kernel mode?"; the processor, really running it in user mode, answers "no"; nothing traps, so the VMM never gets the chance to lie; and the guest panics.

Now the names. An instruction is [**sensitive**](/build-your-own/vmm/glossary/#sensitive-instruction) if it reads or changes machine state the VMM must control, such as the current mode. It is [privileged](/build-your-own/vmm/glossary/#privileged-instruction) if it traps in user mode and runs normally in kernel mode. In 1974, Gerald Popek and Robert Goldberg proved when trap-and-emulate works: [**a processor can be virtualized this way if every sensitive instruction is privileged**](/build-your-own/vmm/glossary/#popek-and-goldberg-s-condition). The toy has one sensitive instruction that is not privileged: `GETMODE`.

**Deliberate breakage 1: mode E, the sneaky instruction.** Mode E is mode D with `GETMODE` behaving as the toy's processor really does.

:::predict In mode E, will the guest notice that it is not really in kernel mode?
Write your guess in your journal next to your mode D guess, then follow mode E one instruction at a time, counting traps, and stop at `GETMODE`.

It notices. `SETBASE` traps (one trap); `STI` traps (two). `GETMODE` is not privileged, so the processor runs it natively and writes 0, "user", into `r1`: the count stays at two, line 03 does not jump, and the kernel falls into its panic code. Its `!` (a third trap, for the console store) is the only output.

What you saw: `!` instead of `123`. The misconception this exposes: "if something goes wrong, the VMM gets told". The tool that finds it: step mode's "who executes it" column, where `GETMODE` shows the processor, not the VMM, and the trap counter does not move.
:::

The cure is to give the VMM a turn before `GETMODE` answers. Making it privileged (a toggle in the lab) is the fix Popek and Goldberg ask of processor designers; two more need no new processor.

> **Aside.** Popek and Goldberg ask three things of a VMM: *equivalence*, *resource control* and *efficiency*; mode C fails efficiency and mode E equivalence. x86 had seventeen sensitive unprivileged instructions ([Robin and Irvine, 2000](https://static.usenix.org/events/sec00/robin.html)). One, `POPF`, restores a saved word of flags, including the interrupt-enable bit (the toy's `CLI`/`STI` bit); in user mode it silently leaves that bit unchanged, so a deprivileged guest kernel that turns interrupts off this way believes it did, and no trap tells the VMM.

## Two ways around a broken instruction set

[**Binary translation**](/build-your-own/vmm/glossary/#binary-translation) scans each short run of guest code right before it executes and rewrites the sensitive instructions into calls into the VMM; the rest is copied and cached. VMware built its first product this way in 1999. In mode F the rewritten `GETMODE` reaches the VMM, which answers "kernel". The cost is the translator: a large, hard program, time to translate each new block, and memory for the cache.

The other way is to change the guest. [**Paravirtualization**](/build-your-own/vmm/glossary/#paravirtualization) edits the guest kernel's source so it asks the VMM directly, with a [**hypercall**](/build-your-own/vmm/glossary/#hypercall) (a deliberate call to the VMM, as a system call asks the kernel). Xen took this road in 2003.

In mode G the modified guest has `HCALL` at line 02 instead of `GETMODE`. The cost is the edit: a guest whose source you cannot change cannot run this way. The idea survives in power-off hypercalls (chapter 08) and devices designed for virtual machines (chapter 15).

## Hardware assist

The lasting fix came from the processor makers: a level *above* the kernel, whose software chooses what traps (on a Mac, macOS's part makes most of these choices for us; chapter 01). The guest kernel runs in a real kernel mode, so `GETMODE` answers "kernel" truthfully, and every operation the VMM asked to watch stops and hands over: [**hardware-assisted virtualization**](/build-your-own/vmm/glossary/#hardware-assisted-virtualization). Intel shipped its version, VT-x, in 2005.

Arm calls its privilege levels [exception levels](/build-your-own/vmm/glossary/#el0-el1-el2-el3), EL0 (apps) to EL3: a kernel runs at EL1, and the level that supervises kernels is EL2; chapter 02 meets them properly. EL2 has been defined in 64-bit Arm's instruction set architecture, the rulebook every Arm chip follows, since its first version, ARMv8-A. It is optional for chip makers; every Apple silicon chip has it.

It was not free: every stop is a round trip to the VMM, and with memory still shadowed, the first hardware-assisted VMMs were often *slower* than binary translation ([Adams and Agesen, 2006](https://doi.org/10.1145/1168857.1168860)). The fix for memory: the hardware translates addresses twice, through the guest's own tables, then through a [**second translation stage**](/build-your-own/vmm/glossary/#stage-1-stage-2) that the VMM owns, so the guest edits its tables with no traps and still reaches only the memory it was given. Chapter 05 builds ours.

Devices stay the VMM's job: an [**emulated device**](/build-your-own/vmm/glossary/#emulated-device) imitates real hardware register by register, so an unmodified driver works, at a trap per access (chapter 09); a [**paravirtual device**](/build-your-own/vmm/glossary/#paravirtual-device) is designed for virtual machines and needs far fewer (chapter 15).

Mode H gives the toy a third, more privileged mode. The VMM chooses what traps: here, only the console range. The guest sets its own base natively, and the VMM's second base register, applied after it, keeps the guest in its memory: the toy's second translation stage. Trap base writes too, and the output is the same, with more interventions. The interrupt switch needs no trap: the hardware keeps a virtual interrupt mask for the guest. Leave the console range unchosen and the VMM maps plain memory there: the prints never trap, so the VMM, the only thing that can reach your screen, never sees them, and the console stays empty.

All eight modes, now that you have predicted:

| Mode | Strategy | When the VMM acts | Output as in mode A? |
|---|---|---|---|
| A | bare metal | never: there is no VMM | it *is* the reference |
| B | a process, no VMM | never | no: killed at `SETBASE` |
| C | interpret | on every instruction | yes |
| D | trap-and-emulate | on each trap | yes (`GETMODE` made to trap) |
| E | trap-and-emulate, real `GETMODE` | on each trap | no: the guest panics |
| F | binary translation | on each trap and each new block | yes |
| G | paravirtualization | on each trap and each hypercall | yes |
| H | hardware assist | only on what the VMM chose to trap | yes |

> **Try it.** Ask macOS whether this processor offers the hardware-assisted level: run `sysctl kern.hv_support`. A `1` means yes. Ours:

:::term source=captures/00-hv-support.txt

The strategies on one screen:

```text
1960s  IBM CP-40, CP-67     trap-and-emulate on mainframes        (Creasy 1981)
1972   IBM VM/370           the same, as a product                (Creasy 1981)
1974   Popek and Goldberg   when trap-and-emulate works           (Popek and Goldberg 1974)
1999   VMware Workstation   binary translation on x86             (Bugnion et al. 2012)
2000   Robin and Irvine     x86 has 17 sensitive, unprivileged    (USENIX Security 2000)
2002   Denali               the word "paravirtualization"         (Whitaker et al. 2002)
2003   Xen                  paravirtualization of Linux           (Barham et al. 2003)
2005   QEMU paper           fast emulation by block translation   (Bellard 2005)
2005   Intel VT-x           a hardware level above the kernel     (Adams and Agesen 2006)
2006   AMD-V                the same, from AMD                    (Adams and Agesen 2006)
2007   AMD, then Intel      second translation stage, 2007-2008   (vendor manuals)
2010   ARMv7-A extensions   Arm's first virtualization level      (Arm, Cortex-A15 launch)
2011   ARMv8-A              EL2 in 64-bit Arm                     (Arm, ARMv8 launch)
```

*Each strategy arrived to fix the cost or the hole of the one before.*

That makes five strategies, each with one real system: emulation (QEMU), trap-and-emulate (IBM's mainframes, in the timeline's first rows, with VM/370 the product), binary translation (VMware), paravirtualization (Xen) and hardware assist (Intel VT-x, or Arm's EL2).

> **Aside.** You do not need to remember these names. On Linux, KVM, a part of the kernel, offers VT-x and EL2 to ordinary programs ([KVM documentation](https://docs.kernel.org/virt/kvm/index.html)): the job chapter 01 finds macOS doing.

## What is left for a VMM

The answer to the opening puzzle: the fooling stays fast because the real processor runs almost every guest instruction itself, and stops only for what the VMM asked to see.

Before reading on, write under Q3 in your journal what the VMM still did in mode H.

Running the guest's instructions is not on the list. The toy showed four jobs: set up the guest's memory (the second base register), answer its device accesses (the console), answer its requests (hypercalls such as mode G's `HCALL`, which a real guest uses to power off), and decide what each stop means. A real machine adds two: set the guest's first registers, and describe the machine to it. That list is the course.

The moment the guest stops and the VMM runs is a [**VM exit**](/build-your-own/vmm/glossary/#vm-exit) (chapter 02; never a process's exit code). The privileged level decides *what* stops the guest; the VMM decides *what to do* about it. On a Mac, who owns that level? Not us; chapter 01 says who. (Apple also ships a ready-made virtual machine library, Virtualization.framework; we leave it until chapter 23, and chapter 01 says why.)

> **Security.** Every job on that list handles values the guest chose, and a hostile guest sends whatever breaks the VMM. From chapter 03 on: check every guest-chosen number before you use it.

## Is this Mac ready?

From the repository root:

```sh
scripts/setup.sh
scripts/doctor.sh
```

`setup.sh` checks the tools this course needs and ends with `setup: OK`. Ours (your versions will differ):

:::term source=captures/00-setup.txt

`doctor.sh` builds a tiny probe program, attaches the one permission macOS requires before a program may create a virtual machine (an [entitlement](/build-your-own/vmm/glossary/#entitlement), carried in the program's signature; chapter 01 and its primer explain both), and asks macOS to create one. Three of its lines (max IPA, EL2 supported, entitlements) will mean nothing to you yet, as expected; check that the last line says `DOCTOR OK`. Chapter 01 explains the others.

:::term source=captures/00-doctor.txt

`hv_vm_create: OK` means this Mac has the hardware-assisted level, and macOS let this process use it to create a virtual machine. `EL2 supported` may say `no` on older Apple chips; that is normal and passes, because it asks a different question, answered in chapter 01. If doctor stops before `DOCTOR OK`, it prints a hint; the common cause is a Mac that is itself a virtual machine, such as some cloud Macs. `scripts/learner hint 00` gives more.

## Checkpoint

First check your journal: `## Predict` holds your ledger guesses with their rows and your mode D and E guesses, and Q1 to Q5 are answered (Q5 is the open question below). Then, from the repository root:

:::checkpoint

It runs `setup.sh` and `doctor.sh`, compares their lines (where Macs differ, any value passes), and checks that every journal heading has an answer. A pass prints the ideas a strong answer contains. Ours, with a filled journal:

:::term source=captures/00-checkpoint-learner.txt

Each result line is one of three kinds of check: `contract` lines test your own code (none yet), `run` lines are runs on your Mac, and the `journal` line is your journal. "5/5 serial markers" means all five expected lines were found in the script's output.

You can now name the parts of a virtual machine, you have the ledger, and this Mac can create one. Chapter 01 starts from here plus your `learner/` workspace.

### What's next

On a Mac, the privileged level that hardware assist added belongs to macOS, not to us. Chapter 01 draws the real stack, shows what that level hands to an ordinary program, and has your own Rust code ask it for a virtual machine: the same `hv_vm_create` the doctor called in C.

### Open question

A new processor adds one instruction that reads the current privilege level and does not trap. Which strategies still work unchanged, and what would you ask the processor's designers for?

## Spec hunt

- Popek and Goldberg, "Formal Requirements for Virtualizable Third Generation Architectures", 1974 ([doi:10.1145/361011.361073](https://doi.org/10.1145/361011.361073)), Theorem 1 and the definitions before it: how do they define a sensitive instruction, and which toy instructions fit?
- Robin and Irvine, USENIX Security 2000, the list of sensitive unprivileged instructions: which read state, like `GETMODE`, and which change it, like `POPF`?
- The Arm Architecture Reference Manual (document DDI 0487, free from Arm's developer site), the introduction to virtualization in part D: what can software at EL2 choose to trap?
