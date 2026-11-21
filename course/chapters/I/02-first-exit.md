---
title: An exception, one level up: your first VM exit
part: I
chapter: I.1
id: 02
runs: mac+browser
minutes: 330
prereqs: [01]
start_tag: ch-01
labs: [exception-stepper, a64-encoder]
command: scripts/checkpoint.sh 02
expect: CHECKPOINT 02 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** exception levels EL0 to EL3 and who sits at EL2 on a Mac; the exception registers (`ELR`, `SPSR`, `ESR` with its EC, IL and ISS fields, `FAR`, `VBAR`) and the exception vector table; synchronous versus asynchronous exceptions; routing; the preferred return address (a call continues, a fault retries); the exit of a virtual machine (a VM exit) as an exception taken to EL2 and forwarded to us; reading the PSTATE value `0x3c5` with a field table (chapter 06 builds such values yourself).
- **Core, from earlier:** hardware assist and the toy machine (chapter 00); the macOS stack and its two supervisors (chapter 01); `HvError`, `check`, `Vm` and the foreign function interface (FFI) pattern (chapter 01).
- **Primers (read first):** `aarch64-reading` (registers, `x0` as the result register, 32-bit instruction words, the fields of `movz`, `hvc` and `b`, byte order); `os-basics` (a system call at the hardware level, the exception vector table).
- **Pointers:** nested virtualization (an Aside). For the curious: the page-granules, reading-specs and host-concurrency primers.
- **Forward definitions:** IPA (intermediate physical address); the stage-2 mapping; the 16 KiB host page; page-aligned memory from `hv_vm_allocate`; why RAM starts at `0x4000_0000`; thread; `SP_EL1`, EL1h and DAIF; data abort and instruction abort. Each is defined at first use.
:::

Here is a whole program, three instructions long: put 42 in register `x0`, call the level above with `hvc`, then loop forever. You will run it inside a virtual machine on your Mac. When the [guest](/build-your-own/vmm/glossary/#guest) reaches the `hvc`, the call that started it, `hv_vcpu_run`, returns to the virtual machine monitor (VMM) you are building, with a note. One number on it decides how every exit handler you write behaves: the guest's program counter (PC), the address of the instruction it will run next. Does it still point at the `hvc`, or has it moved past it?

:::predict The program starts at `0x4000_0000` (the underscore only separates digits, as in Rust; programs print `0x40000000`), so the `hvc` is at `0x40000004`. After the exit, will the guest's PC read `0x40000004` (at the `hvc`) or `0x40000008` (after it)?
Write your answer and one sentence of reasoning under `## Predict` in your journal. Sitting A gives you the rule that decides it; sitting B runs it.
:::

This chapter opens row 1 of chapter 00's problem ledger, the CPU: by its end, guest instructions run natively and stop where we asked. Sitting A is exceptions on paper and in the browser, no Mac needed (about 2 hours); sitting B is your first run, at your Mac (about 3.5 hours).

:::objectives
- (Sitting A) Before the registers are named, list what a kernel needs to know when an app runs `svc #0` (from where, why, where to return, in which mode); then match each item to `ELR_EL1`, `SPSR_EL1`, `ESR_EL1` or `FAR_EL1`, and say what `VBAR_EL1` is for.
- (Sitting A) Explain "the same thing, one level up": `hvc` is the `svc` of EL1, the software at EL2 owns the vector table there, and `hv_vcpu_run` returns when the guest takes an exception that Hypervisor.framework forwards.
- (Sitting A) For `svc`, `hvc`, a faulting load and a timer interrupt, say whether each is synchronous or asynchronous and where the saved PC points, using the call-versus-retry rule.
- (Sitting B) Declare the virtual CPU (vCPU) and mapping functions from the SDK (software development kit) headers, map one 16 KiB page of guest RAM at guest address `0x4000_0000`, place three given instruction words, set the PC and the PSTATE value the lesson explains field by field, and run.
- (Sitting B) Extract the exception class from the syndrome (`ESR >> 26`), identify `0x16` as an `hvc` from the Arm manual's table, and predict, then observe, the PC after the exit.
:::

**Before you start.** From the repository root, run `scripts/learner start 02`. It copies this chapter's journal to `learner/journal/02.md`, "your journal" below. In sitting B, type each code block into your workspace, `learner/`, and run your program from inside it; the repository root holds the finished reference, so a run there proves nothing about your code.

## Watch an app call its kernel

Open the stepper below, choose **source EL0, cause `svc`**, and step once. The app is running at EL0, Arm's name for the least privileged level, where ordinary programs live (chapter 01's stack). It executes [`svc`](/build-your-own/vmm/glossary/#svc) `#0`, the instruction an app uses to ask its kernel for a service (the `os-basics` primer).

Watch the PC jump somewhere new, the mode change, and three boxes, still unnamed, fill with values. Then press [**ERET**](/build-your-own/vmm/glossary/#eret) (exception return): the PC and mode snap back, the PC one instruction on; the boxes keep their values.

:::lab exception-stepper

If the lab does not load, here is what it shows, for `svc` and for the "data abort" cause used later (the app's code at `0x1000`, the kernel's table of handlers at `0x8000`):

```text
cause: svc #0 at 0x1000                before       after the step
  PC                                   0x1000       0x8400  (table + 0x400)
  mode                                 EL0          EL1
  saved return address                 ?            0x1004  (after the svc)
  saved mode                           ?            EL0 and its flags
  reason                               ?            svc, number 0
  fault address                        ?            ?       (not a fault)

cause: data abort, a load at 0x1000 from an address with nothing behind it
  PC                                   0x1000       0x8400  (table + 0x400)
  mode                                 EL0          EL1
  saved return address                 ?            0x1000  (the load itself)
  saved mode                           ?            EL0 and its flags
  reason                               ?            data abort
  fault address                        ?            the address the load used

ERET: PC = saved return address, mode = saved mode.
```

## What the kernel needs to know

You are the kernel, and an app has knocked. What must you find out? Write your list before reading on; it is journal question 2.

Most lists contain four things: *why* the app came, *where* to go back to, *what state* it was in (which level, which flags), and, if something went wrong, *which address* was involved. On Arm each answer has its own register, written by the hardware as it changes the mode. The suffix `_EL1` says the register belongs to EL1, the level that receives the exception:

| You need | Register | In the stepper |
|---|---|---|
| where to go back to | `ELR_EL1`, the **Exception Link Register**: the saved return address | "saved return address" |
| the state to go back to | `SPSR_EL1`, the **Saved Program Status Register**: the old mode and flags | "saved mode" |
| why it came | `ESR_EL1`, the **Exception Syndrome Register** | "reason" |
| which address, for faults only | `FAR_EL1`, the **Fault Address Register** | "fault address" |

The CPU's current mode and flags live in [**PSTATE**](/build-your-own/vmm/glossary/#cpsr-pstate) (processor state). `SPSR_EL1` is a snapshot of PSTATE taken at the exception, so `ERET` can restore it. Hypervisor.framework calls the same value `CPSR` (current program status register), an older Arm name.

## Where the CPU goes: the vector table

Long before any app ran, the kernel wrote the address of its [exception vector table](/build-your-own/vmm/glossary/#exception-vector-table) (the table of handler entry points from the `os-basics` primer) into `VBAR_EL1`, the **Vector Base Address Register**. The CPU picks an entry at an offset set by the kind of exception and where it came from: an `svc` from EL0 lands at `VBAR_EL1 + 0x400`, and a synchronous exception at EL1 itself lands at `VBAR_EL1 + 0x200`, when the kernel runs on its own stack pointer, as ours will (sitting B's PSTATE table). Chapter 06 draws all sixteen entries, and chapter 08 uses them.

## Calls continue, faults retry

Now the rule behind the opening puzzle. Recall from the `aarch64-reading` primer that the PC holds the address of the instruction being executed, and every Arm instruction is 4 bytes long. The saved return address cannot always be "the next instruction".

For a call, the caller wants to continue *after* it; for a fault, the faulting instruction must be *retried* once the cause is fixed.

So after an `svc`, `ELR_EL1` holds the address after the `svc`. After a load that faulted (say the page was not in memory yet), it holds the address of the load itself, so the kernel can bring the page in and run the load again. The Arm Architecture Reference Manual (the **ARM ARM**, Arm's rulebook) calls this saved value the [**preferred return address**](/build-your-own/vmm/glossary/#preferred-return-address), and defines it per kind of exception. The stepper's "data abort" cause shows the second case: a [data abort](/build-your-own/vmm/glossary/#data-abort) is Arm's name for a load or store that faulted.

A third case comes from outside the program: a timer or a device signals an **interrupt**. The saved address is the first instruction not yet run, so the program carries on unharmed.

## Reading the reason: the syndrome

`ESR` packs the reason, the [syndrome](/build-your-own/vmm/glossary/#syndrome), into 32 bits. Its top six bits, 31 to 26, are the **exception class** (EC): the kind of exception. Bit 25 is **IL**, the instruction length, 1 for a 32-bit instruction, which on 64-bit Arm is always. The low 25 bits are the **instruction-specific syndrome** (ISS), whose meaning depends on the class. For a call such as `svc` or `hvc`, the low 16 bits of the ISS hold the number written in the instruction.

```text
 31        26  25  24                                   0
+------------+----+--------------------------------------+
|     EC     | IL |                 ISS                  |
+------------+----+--------------------------------------+
  0x5a000000 = 0101 10 | 1 | 0 0000 ... 0000
               EC = 0b010110 = 0x16, IL = 1, ISS = 0
```

*The syndrome `0x5a000000` split into its fields: shift right by 26 to get EC.*

Which class is `0x16`? Open the ARM ARM (free from Arm's developer site, document DDI 0487) and search for the register page **ESR_EL2, Exception Syndrome Register (EL2)**. Find the field **EC** and its table of values. The row for `0b010110` reads "HVC instruction execution in AArch64 state". That is your first look at the primary source. Notice the page: `ESR_EL2`, not `ESR_EL1`. The next section says why.

## The same thing, one level up

Everything so far happened between an app at EL0 and a kernel at EL1. Arm stacks four [**exception levels**](/build-your-own/vmm/glossary/#el0-el1-el2-el3): EL0 for apps, EL1 for a kernel, **EL2** for the software that supervises kernels, and EL3 for firmware (which we never touch). Higher number, more power.

A guest kernel is an ordinary kernel at EL1, and it calls the level above the way an app does. `hvc` (hypervisor call) is the `svc` of EL1: an exception taken to EL2. A guest access to memory our VMM has not given it is the page fault of EL1, taken to EL2 instead of to the guest's own kernel (chapter 05 calls the gap it hits a stage-2 hole). And EL2 has its own copies of the registers: `ELR_EL2`, `SPSR_EL2`, `ESR_EL2`, `VBAR_EL2`.

Who sits at EL2 on a Mac? Not us: chapter 01's stack put the macOS kernel's virtualization part there. It owns `VBAR_EL2`, receives the `hvc`, and handles or forwards it. Our VMM runs the guest by calling `hv_vcpu_run` from one of its threads (a thread is an independent flow of execution inside a process), and that call runs one virtual CPU, a vCPU. When EL2 forwards an exception, the call returns, carrying the guest's `ESR_EL2` value as the "syndrome". That forwarded stop is a [**VM exit**](/build-your-own/vmm/glossary/#vm-exit), never to be confused with the exit code `macvmm` returns to the shell.

> **Aside.** EL2 can also be offered *to the guest*, so a guest can be a hypervisor itself: nested virtualization. The switch is `hv_vm_config_set_el2_enabled` in the SDK header `hv_vm_config.h`; the ARM ARM's chapter on the EL2 exception model describes what such a guest sees. This chapter's open question uses it.

## Two kinds, two destinations

Ask two independent questions of any exception. Was it *caused by the running instruction* (**synchronous**: `svc`, `hvc`, a fault), or by something outside it (**asynchronous**: a timer, an interrupt, or our VMM stopping the vCPU from another thread, which arrives with its own [exit reason](/build-your-own/vmm/glossary/#exit-reason), chapter 09)? And which level takes it: the guest's kernel at EL1, through its own vector table, or EL2, through Apple's? That choice is the exception's [**routing**](/build-your-own/vmm/glossary/#routing), and EL2's software configures it.

| Event, in the guest | Kind | Saved PC points | Taken at |
|---|---|---|---|
| `svc` from a guest app | synchronous | after the `svc` | EL1, the guest kernel |
| `hvc` from the guest kernel | synchronous | after the `hvc` | EL2, then maybe to us |
| a load the guest's own page tables cannot translate | synchronous | at the load | EL1, the guest kernel |
| a timer interrupt | asynchronous | the next instruction not yet run | depends on routing (chapters 11 and 12) |

*Most exceptions never leave the guest. Only those routed to EL2 can become VM exits.*

## Retiring the toy

Chapter 00's toy machine retires here, beside the real thing:

| Toy machine (chapter 00) | Arm, from now on | Where the toy was wrong |
|---|---|---|
| user mode | EL0 | |
| kernel mode | EL1 | |
| "hardware assist" mode | EL2 | on a Mac, the software at EL2 is Apple's, not ours |
| (none) | EL3, the firmware's level, unused by us | Arm has four levels; the toy had two or three |
| "trap" | an exception taken to a higher EL | the real trap leaves *why* (`ESR`) and *where to return* (`ELR`) in registers |

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 3.5 hours.

## `hv_vcpu_run` is a system call

One sentence carries all of sitting B: `hv_vcpu_run` is a system call; our thread enters the macOS kernel, the kernel runs the guest on this CPU core, and when the guest takes an exception that the kernel's EL2 part chooses to forward, the call returns to us with the reason.

```text
 our thread (EL0)           macOS kernel (EL1, EL2 part)       guest (EL1)
 ----------------           ----------------------------       -----------
 hv_vcpu_run(vcpu) ------->  load the guest's registers,
   (blocked)                 enter the guest ------------------> movz x0, #0x2a
                                                                 hvc #0
                             exception taken to EL2 <----------  (stops here)
                             forward it?  yes
 returns HV_SUCCESS <------  write the exit record
 read reason, syndrome
```

*While the guest runs, our thread waits inside the kernel.*

## Declaring the vCPU functions

A [**vCPU**](/build-your-own/vmm/glossary/#vcpu) is one guest CPU: a set of registers that Hypervisor.framework loads onto a real core when you call `hv_vcpu_run`. As chapter 01 did for `hv_vm_create`, open `hv_vcpu.h` and `hv_vcpu_types.h` and declare what we need in `learner/crates/hvf/src/ffi.rs`, checking each line against the header. First the plain types (keep those you have):

:::code anchor=ffi_basic_types file=crates/hvf/src/ffi.rs

The vCPU's types and the four exit reasons, whose values the checkpoint compares with the header:

:::code anchor=ffi_vcpu_types file=crates/hvf/src/ffi.rs

The five functions this chapter calls:

:::code anchor=ffi_vcpu_fns file=crates/hvf/src/ffi.rs

:::code anchor=ffi_vcpu_run file=crates/hvf/src/ffi.rs

The register numbers; we use `X0`, `PC` and `CPSR`:

:::code anchor=ffi_regs file=crates/hvf/src/ffi.rs

`hv_vcpu_create` has two out-pointers. The first receives the vCPU's id. The second receives a pointer to an exit record that the framework rewrites on every run; it is the `repr(C)` struct from chapter 01's layout lab:

:::code anchor=ffi_vcpu_exit_t file=crates/hvf/src/ffi.rs

It is 32 bytes: `reason` at offset 0, four bytes of padding, then the syndrome at 8, the guest's virtual fault address (its FAR) at 16, and the guest-physical address (an IPA, defined below) at 24. The checkpoint checks your layout.

## A vCPU that cleans up after itself

A [**thread**](/build-your-own/vmm/glossary/#thread) has its own registers, and the header says `hv_vcpu_create` makes a vCPU "for the current thread", whose other calls "must be called by the owning thread". It does not say why (likely the kernel keeps the vCPU's state with that thread). So the creating thread runs it. The wrapper in `learner/crates/hvf/src/vcpu.rs` makes this a compile-time fact: `Vcpu` is not `Send` (Rust's mark for types that may move to another thread), and the doc-comment test proves the compiler refuses:

:::code anchor=vcpu_not_send file=crates/hvf/src/vcpu.rs

Creating one wraps the call in chapter 01's `check`, which turns a return code into a `Result`:

:::code anchor=vcpu_create file=crates/hvf/src/vcpu.rs

Registers by name, and a `Drop` that destroys the vCPU on its own thread:

:::code anchor=vcpu_regs file=crates/hvf/src/vcpu.rs

:::code anchor=vcpu_drop file=crates/hvf/src/vcpu.rs

:::code anchor=reg_ids file=crates/hvf/src/regs.rs

> **Under the hood.** The kernel writes the exit record behind the compiler's back. `Vcpu::run` therefore copies it out with one volatile read right after each run and never holds a Rust reference into it, so the compiler cannot reuse a stale copy. That read is the only unusual line.

:::code anchor=vcpu_run file=crates/hvf/src/vcpu.rs

The copy becomes an owned value; an unknown reason is kept, never a panic:

:::code anchor=vcpu_exit_reason file=crates/hvf/src/vcpu.rs

:::code anchor=vcpu_exit_record file=crates/hvf/src/vcpu.rs

Declare the new modules in `crates/hvf/src/lib.rs` and re-export `Vcpu`, `VcpuExit`, `ExitReason`, `Reg`, `MemFlags` and `OwnedMapping`, as chapter 01 did for `Vm`.

## One page of guest memory

The guest's three instructions need a home: one page of our memory, shown to the guest at an address we choose. That guest address is an [**IPA**](/build-your-own/vmm/glossary/#ipa) (intermediate physical address): the address the guest believes is physical, which the hardware translates to our memory. `hv_vm_map` sets up that translation, a **stage-2 mapping**; chapter 05 tells the full story of both names. Declare it beside `hv_vm_create`, with `hv_vm_unmap`, the allocation pair and the permission bits:

:::code anchor=ffi_vm_map file=crates/hvf/src/ffi.rs

:::code anchor=ffi_vm_unmap file=crates/hvf/src/ffi.rs

:::code anchor=ffi_vm_allocate file=crates/hvf/src/ffi.rs

:::code anchor=ffi_mem_flags file=crates/hvf/src/ffi.rs

In `learner/crates/hvf/src/vm.rs`, the permissions get names and `Vm` gains a thin `unsafe` wrapper whose `# Safety` list says what a caller must promise:

:::code anchor=mem_flags file=crates/hvf/src/vm.rs

:::code anchor=vm_map file=crates/hvf/src/vm.rs

The memory comes from `hv_vm_allocate`, which chapter 04 opens up; read it as "give me 16 KiB the framework can map". Two names are not yours yet: `host_page_size()` (use `16 * 1024` today) and `Allocation`, a pointer and a length whose `Drop` calls `hv_vm_deallocate`. A struct with those two fields and that `Drop` is enough; chapter 04 builds the real one.

:::code anchor=host_allocate file=crates/hvf/src/host.rs

The reference wraps "allocate, then map" in one value that unmaps and frees itself when dropped, like chapter 01's `Vm`. Each `// SAFETY:` comment says why its `unsafe` call is sound.

:::code anchor=owned_mapping_struct file=crates/hvf/src/vm.rs

:::code anchor=owned_mapping_new file=crates/hvf/src/vm.rs

Writing checks the range first; `OutOfBounds` is a plain struct of the three numbers:

:::code anchor=owned_mapping_range file=crates/hvf/src/vm.rs

:::code anchor=owned_mapping_write file=crates/hvf/src/vm.rs

Dropping unmaps before freeing. If the unmap fails, the guest might still reach the memory, so it is never freed:

:::code anchor=owned_mapping_drop file=crates/hvf/src/vm.rs

Two numbers need a word. By default, mappings come in 16 KiB pieces, the Mac's host page size, aligned to 16 KiB (most PCs use 4 KiB; newer macOS lets a VM choose 4 KiB, see the page-granules primer). And `0x4000_0000` (1 GiB) is where RAM starts in the standard Arm virtual machine layout that stock kernels expect (chapter 05).

## Three instruction words

The guest program is three 32-bit words, read as the `aarch64-reading` primer taught:

| Guest address | Word | Instruction | Why it is there |
|---|---|---|---|
| `0x4000_0000` | `0xD2800540` | `movz x0, #0x2a` | leave a value we can read back afterwards |
| `0x4000_0004` | `0xD4000002` | `hvc #0` | call the level above: our VM exit |
| `0x4000_0008` | `0x14000000` | `b .` | branch to itself; a safe place to park if we ever resume |

The encoder lab shows `movz`, `hvc` and `b` with every bit field labelled. It is exploratory and unscored; skipping it costs nothing:

:::lab a64-encoder

From here on, code goes into `learner/crates/macvmm/src/first_exit.rs`. The words become bytes in guest memory order, little-endian (the primer's byte-order section):

:::code anchor=first_exit_code_bytes file=crates/macvmm/src/first_exit.rs

## The starting state: PC and PSTATE

A vCPU starts from whatever we write: here, the PC `0x4000_0000` and PSTATE `0x3c5`, which reads field by field like this (chapter 06 has you build such values):

| Bits of `0x3c5` | Value | Meaning |
|---|---|---|
| 3 to 0 (`M`) | `0b0101` | bits 3 and 2 give the level, `01` = EL1; bit 0 picks the stack pointer, 1 = EL1's own, `SP_EL1`. This mode is written **EL1h** ("h" for handler stack); `0b0100` would be EL1t, EL1 using EL0's stack pointer |
| 4 | 0 | 64-bit execution (AArch64) |
| 9 to 6 (`DAIF`) | `0b1111` | four mask bits for the kinds of asynchronous exception: debug, SError (system error), IRQ (interrupt request) and FIQ (fast interrupt request). All set, so nothing interrupts our three instructions |
| all other bits | 0 | |

Together, `0x3c0 | 0x5 = 0x3c5`. The constants:

:::code anchor=first_exit_consts file=crates/macvmm/src/first_exit.rs

Then steps 1 to 3: the VM, the mapping and the vCPU. `VmBuilder::new().create()` is the reference's way of creating chapter 01's `Vm`; call your own constructor instead:

:::code anchor=first_exit_setup file=crates/macvmm/src/first_exit.rs

## The first run

Step 4 runs the vCPU and decodes the exit by shifting and masking, as in sitting A's field figure; step 5 reads two registers:

:::code anchor=first_exit_decode file=crates/macvmm/src/first_exit.rs

`ec_name` names the few classes this chapter meets, and `run` turns the result into an exit status. `out` and `err` print one line to standard output and standard error, like `println!` and `eprintln!`:

:::code anchor=first_exit_entry file=crates/macvmm/src/first_exit.rs

Add the subcommand to your `main.rs` the way chapter 01 added `doctor`:

:::code anchor=main_first_exit file=crates/macvmm/src/main.rs

Run it from inside `learner/`, through the signing runner that `cargo run` uses (chapter 01):

```sh
cd learner
cargo run -q -p macvmm -- first-exit
```

Check your Predict entry, then compare with the reference's run:

:::term source=captures/02-first-run.txt

The syndrome is `0x5a000000`: EC `0x16`, an `hvc`, immediate 0. `x0=0x2a` proves the `movz` ran. And the PC is `0x40000008`: *after* the `hvc`. Nobody in our VMM moved it: the hardware saved the preferred return address, and for a call that is the next instruction. If you predicted "at the `hvc`, so add 4", you were in good company; had your VMM done it, the guest would skip its `b .` and run off the end.

That is not a universal rule, though.

> **Try it.** Change the second word from `0xD400_0002` (`hvc #0`) to `0xD400_0003` ([`smc`](/build-your-own/vmm/glossary/#smc) `#0`, a call meant for the firmware at EL3) and run again. Look at the class and the PC before you read our run.

:::term source=captures/02-smc.txt

We checked this on a real Mac: class `0x17` (SMC64), and the PC is still `0x40000004`, *at* the instruction. The rule holds: the `smc` never executed. Apple's chips have no EL3, and the software at EL2 intercepts (traps) every `smc` first. An intercepted instruction has not happened yet, so, like a fault, the saved PC points at it. Executed call: after. Fault or intercepted instruction: at. After an `smc`, the VMM must advance the PC itself. So look up the return rule for each class; never add 4 out of habit.

## Breaking it on purpose

Three deliberate breaks, each predicted first; undo each before the next.

**Deliberate breakage 1: delete the `hvc`.** Remove the middle word, leaving `movz` and `b .`, and change the array's length to 2. Predict: how many VM exits will you see? Run it, wait ten seconds, then press Ctrl-C. The capture tool stopped our run after ten seconds; `macvmm` has no timeout yet:

:::term source=captures/02-no-hvc-hang.txt

One line, then nothing. `b .` is a valid program that never needs the level above, so `hv_vcpu_run` never returns, and its thread can do nothing. What you saw: a hang. The misconception it exposes: "a broken guest produces an error". The tool that will find it: an external way to stop a vCPU, which chapter 03 adds as `--timeout` and chapter 09 as a kick from another thread.

**Deliberate breakage 2: delete the `b .` and run twice.** Restore the `hvc`, delete the third word instead (length 2 again), and wrap steps 4 and 5 (run, decode, then read and print the PC and `x0`) in a loop that runs twice. The second run starts at `0x40000008`, past our program, where the page holds zeros. Predict the second exit's class:

:::term source=captures/02-run-twice.txt

Not an "undefined instruction" exit: the second stop is class `0x20`, printed `IABT_LOWER`, an [instruction abort](/build-your-own/vmm/glossary/#instruction-abort) (the CPU could not fetch the instruction at the PC) from a level lower than EL2: the guest. It happened at `pc=0x200`. The word `0x00000000` is permanently undefined (`udf`), so the guest took an exception at its own level, EL1, through its own vector table; nobody set `VBAR_EL1`, so it is 0, and the CPU went to `0 + 0x200`, the entry from sitting A. Nothing is mapped there, so fetching the handler failed, and *that* reached us. The VMM often sees only the consequence (chapter 06). Ignore `imm=0x6` here: only for `svc`, `hvc` and `smc` do the low 16 bits hold the instruction's number; for an abort they describe the fault (nothing mapped), which chapter 05 decodes. The syndrome is data: decode it, never pattern-match it.

**Deliberate breakage 3: a vCPU id that is too narrow.** In your `ffi.rs`, declare `hv_vcpu_t` as `u32` (it is 32 bits on Intel Macs, so copied examples sometimes say so) and fix the casts the compiler asks for. Predict: compile error, crash, or nothing visible? To have something to see, our run passed the first of two adjacent `u32` slots, holding `0` and `0xdeadbeef`, as the id out-pointer, and printed both:

:::term source=captures/02-u32-vcpu-t.txt

The same three lines, yet `0xdeadbeef` is gone: the framework wrote the eight-byte id the header promises into a four-byte slot, and the extra bytes (zeros, as the id is 0) landed on the neighbour. In your program, that is whatever the compiler placed next. The checkpoint passes this break too (we ran it); only the header catches it.

> **Security.** The immediate in an `hvc`, the value in `x0`, every field of the syndrome: the guest chose them all. Today we only print them. From chapter 03 on, our VMM acts on them, and a hostile or merely buggy guest will send numbers nobody planned for. Treat every value a guest hands over as untrusted input: check its range before you use it to index, allocate or branch.

## Your turn

If you typed along (typing, not pasting, is where the questions come from), your workspace holds everything this page showed. Before the checkpoint, check:

1. `cargo run -q -p macvmm -- first-exit`, from inside `learner/`, prints the reference's three lines.
2. Your journal has the Predict entry, written before your first run, and question 3, answered during the first break.

Stuck? `scripts/learner hint 02` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (your exit-record layout and exit-reason values against the header), runs your `first-exit` and compares its output line by line, checks that every journal heading has an answer, and ends with `CHECKPOINT 02 PASS`. The run step expects these lines (it runs the binary directly, hence `macvmm first-exit`):

:::term source=captures/02-first-exit.txt

What now works:

- your crate declares the vCPU half of Hypervisor.framework, checked against the header (by the checkpoint for the exit record, by you for the rest);
- a guest runs three instructions natively on your Mac's CPU and stops on its `hvc`;
- you can split a syndrome into class, length and immediate, and know why the PC needs adjusting after an `smc` but not after an `hvc`.

The next chapter starts from this state (the reference at the end of chapter 02).

### What's next

Chapter 03 writes a real guest program in Rust, with no operating system under it, gives your VMM a loop that answers exit after exit and a timeout for the hang, and measures what one VM exit costs. The answer is why the second half of this course exists.

### Open question

One more experiment: the same three words, but with EL2 offered to the guest (the switch from the Aside) and the vCPU started at EL2. The `hvc` never reached us as an `hvc`:

:::term source=captures/02-el2-hvc.txt

Compare the exit we did get with the second exit of breakage 2. The guest's own `ESR_EL2` holds `0x5a000000`, the syndrome our VMM read in the first run, and its `ELR_EL2` holds `0x40000008`. What changed between the two runs: the instruction, or the routing?

## Spec hunt

- ARM ARM (DDI 0487), register page **ESR_EL2, Exception Syndrome Register (EL2)**, the EC field table: which other classes can a guest kernel cause that would reach EL2, and which of them have you now seen?
- ARM ARM, the section on the **preferred exception return address** in the exception model chapter for AArch64: where does the manual say an `hvc` returns after itself while a trapped `smc` returns to itself?
- The SDK header `hv_vcpu.h` (with `hv_vcpu_types.h`): which functions may be called from any thread, and which only by the vCPU's owning thread?
