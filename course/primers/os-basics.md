---
title: OS basics: processes, memory, syscalls, interrupts
slug: os-basics
kind: primer
minutes: 30
required_by: [00]
labs: [syscall-stepper]
runs: mac+browser
command: sh -c 'exit 5'; echo $?
expect: 5
---

# Who stopped my program?

Here is a tiny C program that stores the number 42 at address 0. Compile it on your Mac and
run it. The program dies, your shell prints a message and a strange number, and everything else on
the machine keeps running as if nothing happened. Your program never checked anything and never
called anyone. So who noticed the bad store, who stopped the program, and how did the shell find
out? By the end of this primer you can tell the whole story, one hardware step at a time.

`null.c` (anywhere, for example a scratch folder):

```c
int main(void) {
    volatile int *p = 0;
    *p = 42;
    return 0;
}
```

```sh
clang -O0 -o null null.c
./null
echo $?
```

Captured on an M5 Pro, macOS 27.2, in the default shell (zsh):

```text
zsh: segmentation fault  ./null
139
```

If your shell is bash, the first line reads `Segmentation fault: 11` instead; the `139` is the same.

:::objectives
- Read a process's exit status, and explain the 44 in `exit 300`.
- Name user and kernel mode, and their Arm names EL0 and EL1.
- Walk a system call through the hardware in four steps, and find the `svc` in macOS (with `lldb` on a Mac; browser-only readers can use the captured output below).
- Translate an address through a two-level page table by hand, and spot the page fault.
- Tell a repaired page fault from a fatal one, and count repaired faults.
- Say what an interrupt is, and what firmware and a kernel do at boot.
:::

:::prereqs
Some Rust or C, and the idea that a running program reads and writes memory at numbered
addresses. No knowledge of Arm, operating-system internals or virtualization is assumed. You need
a Mac with Xcode's command-line tools (`clang`, `lldb`) for the experiments; the lab runs in any
browser.
:::

## A process is a program with a fence around it

A program is a file. When you run it, the operating system's **kernel** (the one program that
manages the machine for everyone else) builds a **process** around it: a private range of
addresses to live in, a set of CPU registers, an identity number (the PID, short for process
ID), open files, and a record of who started it. A **register** is a tiny named storage slot
inside the CPU itself, holding one 64-bit number; the CPU computes on registers, and loads and
stores move values between registers and memory. Arm has 31 general-purpose ones, named `x0` to
`x30`. When the kernel pauses a process, it saves that process's register values, and restores
them when the process runs again. Your shell is a process too. When you type `./null`, the shell asks the
kernel to create a new process, then asks to be woken when that process ends.

When a process ends, the kernel hands its parent one small number: the
[**exit status**](/build-your-own/vmm/glossary/#exit-code) (the chapters call the one macvmm returns its *exit code*; it is the same number). Zero
means success; anything else means "something went wrong", and the program decides what each
value means. The shell keeps the last one in `$?`.

`five.c`:

```c
int main(void) {
    return 5;
}
```

```sh
clang -o five five.c
./five
echo $?
```

```text
5
```

The 139 from the opening puzzle is also an exit status, but the program never chose it. A
**signal** is a numbered notification the kernel delivers to a process, and some signals end the
process on the spot. Signal 11, named SIGSEGV, means "bad memory access". The shell's rule is
plain: when a process was killed by a signal, its exit status is **128 + the signal number**. So
139 is 128 + 11. (The later [`unix-signals`](/build-your-own/vmm/primers/unix-signals/) primer covers signals in depth; for now, remember that
someone other than the program decided how it ended.)

> **Try it.** Run `sh -c 'exit 300'` and then `echo $?`. You will see `44`, not `300`. The parent
> only receives the low 8 bits of the exit status, and 300 is `0x12C`, whose low byte is `0x2C`,
> which is 44. This is why `macvmm` keeps all its own exit statuses below 128.

One word of warning, because this course uses both: an exit status is what a *process* returns to
its shell. In chapter 00 you will meet a "VM exit", which is something else entirely. The two
never share the bare word "exit".

## Two modes: user and kernel

Why couldn't our program defend itself, or the machine defend itself against it? Because the
CPU itself refuses to trust it. Every modern CPU runs in one of at least two **privilege modes**.
In **user mode** a program may compute, load and store in its own memory, and branch. It may not
touch devices, change how addresses are translated, turn interrupts off (called **masking** them;
an interrupt is an outside event such as a key press, explained a few sections below), or stop
the CPU. In **kernel mode** all of that is allowed. Apps run in user mode; the kernel runs in kernel mode.

What happens when an app in user mode tries a forbidden instruction anyway? The CPU does not run
it. It stops the app on the spot and hands control to the kernel, which decides what to do. That
forced hand-over is a [**trap**](/build-your-own/vmm/glossary/#trap), and an instruction that
traps in user mode is a [**privileged instruction**](/build-your-own/vmm/glossary/#privileged-instruction).

Arm calls these modes **exception levels**:
[EL0](/build-your-own/vmm/glossary/#el0-el1-el2-el3) is user mode and EL1 is kernel mode. Arm has
two more above them, EL2 and EL3, with a higher number meaning more power. Only EL0 and EL1
matter in this primer, so you can set EL2 and EL3 aside for now; chapter 02 explains what they
are for, and why EL2 is the level this whole course revolves around. The toy machine in
chapter 00 uses exactly the two names "user mode" and "kernel mode", so you can read it with this
picture.

```text
        +-----------------------------+
        |  app A   |  app B  |  shell |   user mode (EL0): compute, own memory only
        +-----------------------------+
              | asks            ^ answers
              v                 |
        +-----------------------------+
        |           kernel            |   kernel mode (EL1): devices, page tables,
        +-----------------------------+   interrupts, every process's memory
                      |
                  hardware
```

*The fence runs between the two rows: an app can cross it only at doors the kernel built.*

## Asking the kernel: a system call, at the hardware level

If an app cannot touch the disk or the screen, how does `printf` print or `cat` read a file? It
asks the kernel. That request is a **system call**, and you may know it as a function: `write`,
`read`, `_exit`. Underneath the function, though, it is one special instruction. Let us find it.
The `_exit` function your C library calls when `main` returns is a few instructions long, and
the debugger `lldb` can show them. This command runs `five` in batch mode (`-b`), stops it at
`main` (`b main` sets a breakpoint) so that the system libraries are loaded, and prints the
machine instructions of `_exit`:

```sh
lldb -b -o 'b main' -o run -o 'disassemble -n _exit' ./five
```

The first time you run `lldb`, macOS may ask for permission to let it debug; allow it. (No Mac
at hand? Read the captured output below; the rest of the primer does not depend on running it.)
Among the output is this function, from `libsystem_kernel.dylib` (a *dylib* is a shared library
file, code that many programs load). You may see a second, similar copy; either one will do. The
addresses will differ on your Mac:

```text
libsystem_kernel.dylib`__exit:
    0x1914eb5d4 <+0>:  mov    x16, #0x1                 ; =1
    0x1914eb5d8 <+4>:  svc    #0x80
    0x1914eb5dc <+8>:  b.lo   0x1914eb5fc               ; <+40>
```

The first two instructions do the work. `mov x16, #0x1` puts the number 1 in register `x16`: on
macOS, that number tells the kernel *which* service you want (1 is exit). The exit status, 5, is
already in register `x0`: by an agreement all compiled code follows (the **calling
convention**), a function's first argument travels in `x0`. Then
[`svc`](/build-your-own/vmm/glossary/#svc) (supervisor call) knocks on the kernel's door. The
third line, `b.lo`, is a conditional branch to error-handling code for system calls that fail;
`exit` never comes back, so you can ignore it. Linux
on Arm does the same with different details: the service number goes in `x8`, and the
instruction is `svc #0`. The [`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/) primer teaches you to read lines like these.

Here is what the CPU does when it executes `svc` in user mode. Nothing in this list is software;
the hardware does all of it in one step.

1. **It switches mode.** The CPU moves from user mode to kernel mode, and it masks interrupts
   (holds outside events back for a moment) so the kernel's first instructions run undisturbed.
2. **It remembers the way back.** The address of the instruction *after* `svc` goes into a
   dedicated register, and the app's mode and flags go into a second one. A third register
   records *why* the CPU came: "an `svc`, with number `0x80`".
3. **It jumps to the kernel.** Long before any app ran, the kernel set up a table of handler
   addresses, one per kind of event, and told the CPU where the table lives by writing its address
   into a register. The CPU picks the entry for "a system call from user mode" and jumps there.
   That table is the [**exception vector table**](/build-your-own/vmm/glossary/#exception-vector-table).
4. **The kernel works, then returns.** It reads `x16` and `x0`, does the job, puts a result in a
   register, and executes a return-from-exception instruction (`eret`), which restores the saved
   mode and jumps to the saved address. The app carries on, now in user mode again.

Chapter 02 gives each of those registers its name and lets you watch them change.

```text
  app (user mode)                         kernel (kernel mode)
  ---------------                         --------------------
  mov x16, #1
  svc #0x80   ---- mode switch, save ---->  vector table entry
                   return address in          "syscall from user"
                   a register                       |
                                              handle the request
  next instr  <--- eret: restore mode, ----   eret
                   jump to saved address
```

*One instruction leaves user mode; one instruction comes back. Everything in between is the kernel.*

Arm's word for "anything that makes the CPU stop what it was doing and run a handler at the same
or a higher level" is an [**exception**](/build-your-own/vmm/glossary/#exception). A system call
is one kind. You are about to meet two more: faults and interrupts. (This has nothing to do with
exceptions in C++ or panics in Rust; the word is the same, the idea is not.)

> **Aside (skip it if you have never seen x86).** If you learned x86 first, step 2 may surprise
> you. On x86, delivering an interrupt or a fault *pushes* the return address onto a stack (a
> region of memory a program uses as last-in, first-out scratch space), and even an ordinary `call` pushes
> its return address. On Arm, an exception writes the return address into a register and writes
> nothing to memory at all; even an ordinary function call (`bl`) leaves its return address in a
> register (`x30`). If the kernel wants it on a stack, the kernel saves it there itself. (x86-64's
> `syscall` instruction also uses a register, `rcx`, so the contrast is sharpest for interrupts
> and faults.)

> **Under the hood (optional; safe to skip on a first read).** Step 3 simplified one thing. On
> AArch64 each table entry holds not an address but the handler's first few instructions, so the
> "table" is really a block of *code*. It has 16 slots of 128 bytes each, arranged as 4 groups
> (where the exception came from) of 4 kinds: synchronous (caused by the instruction, like
> `svc`), IRQ (an ordinary interrupt), and two rarer kinds that this course meets much later. The
> CPU jumps to a fixed offset from the table's base: an `svc`
> from an app at EL0 lands at base plus `0x400`, an interrupt from the same app at base plus
> `0x480`. A slot is usually a branch to the real handler.
> Chapter 08 draws all 16 slots, because there our VMM must pick one by hand.

> **Security.** A system call is where untrusted code hands values to trusted code. The kernel
> must assume every register the app filled is hostile: a pointer may point into kernel memory, a
> length may be enormous, a number may be out of range. Our VMM sits in the same seat for its
> whole life: every value a guest hands it (an address, a length, a device register write) is
> checked before use, as `CLAUDE.md` requires.

## Every address is a lie: virtual memory

The fence from the first section needs a mechanism. If every process stored straight into RAM,
any process could overwrite another's data, or the kernel's, just by picking the right address.
Instead, run two copies of the same program and both may store to the same address without
disturbing each other. How? Because the addresses a program uses are not the addresses of RAM
chips. Each process uses **virtual addresses**, and the CPU translates every one of them, on
every load, store and instruction fetch, into a **physical address**: a real location in RAM. A
process can only reach the RAM its translations lead to, so memory the kernel never maps for it
simply does not exist from its point of view. The part of the CPU that translates is the **MMU**
(memory management unit). The kernel tells it how by writing **page tables** in memory, then
writing the address of the top-level table into a CPU register that the MMU reads.

Translating byte by byte would need a table as large as memory itself, so memory is cut into
equal, aligned pieces called **pages**, and a page table maps each virtual page to a physical
page. The low bits of an address, the **offset**, pass through unchanged; only the page number is
looked up. Sizes in this course use binary units: 1 KiB is 1024 bytes (2^10, read "2 to the
power 10"), 1 MiB is 2^20 bytes and 1 GiB is 2^30. Your Mac's pages are 16 KiB:

```sh
pagesize
```

```text
16384
```

### A worked example: two levels

Why not one flat table? Count. A 48-bit virtual address with 4 KiB (2^12-byte) pages leaves
48 - 12 = 36 bits of page number, so there are 2^36 virtual pages. At 8 bytes per entry, a flat
table is 2^36 x 8 = 2^39 bytes, which is 512 GiB, per process. Nearly all of those entries would say
"nothing here". So the table is split into levels: a top-level table whose entries point to
smaller tables, and a whole unused region costs one "nothing here" entry at the top.

Let us translate by hand on a **toy** machine, small enough to hold in your head. (The sizes are
invented; the method is the real one.) Addresses are 16 bits, pages are 256 bytes, and an address
splits into three fields:

```text
  virtual address 0x2345 = 0010 0011 0100 0101
                           |--| |--| |-------|
                           L1   L2   offset
                           = 2  = 3  = 0x45
```

*The top four bits pick a level-1 entry, the next four a level-2 entry, the low eight pass through.*

Each hex digit is exactly four bits, so you can split a toy address by its digits: `0x2345` is
`2 | 3 | 45`. Four bits of index means each table has 2^4 = 16 entries. An entry is one number
written in memory: the physical address of the next table (or, at the last level, the physical
page number), plus a few flag bits, the most important being "valid".

The kernel has written these tables (only the entries that matter are shown; every other entry
is marked invalid):

```text
  level-1 table            level-2 table "B"
  index  entry             index  entry
  0x0    -> table A        0x3    -> physical page 0x7A
  0x2    -> table B        0x4    -> physical page 0x13
  (others: invalid)        (others: invalid)
```

Now walk four addresses, the way the MMU does:

- **`0x2345`**: L1 index 2 points to table B; B's index 3 says physical page `0x7A`; write the
  offset `0x45` after it (place the digits side by side, do not add). Physical address
  **`0x7A45`**.
- **`0x2445`**: L1 index 2, then B's index 4: page `0x13`, so **`0x1345`**. Neighbours in virtual
  memory need not be neighbours in RAM.
- **`0x2F10`**: L1 index 2, then B's index `0xF` is invalid. The walk stops: a fault.
- **`0x9000`**: L1 index 9 is invalid. The walk stops at the first level. One L1 entry covers
  every address below it (4 bits of L2 index plus 8 bits of offset, 2^12 = 4 KiB, here
  `0x9000` to `0x9FFF`), so no level-2 table exists for that whole 4 KiB region at all.

The last case is the saving. A 16-bit address with 256-byte (2^8) pages has 2^16 / 2^8 = 2^8 =
256 pages, so a flat table for this toy needs 256 entries always. Our two-level one uses 16
entries for level 1, plus 16 for each level-2 table that exists (A and B): 16 + 16 + 16 = 48 in
all. Real Arm tables work the same way with three or four levels; the [`page-tables`](/build-your-own/vmm/primers/page-tables/) primer
covers the real format before chapter 05.

Two more facts make the fence from the previous section real. Each process has its own page
tables, and when the kernel switches from one process to another, it points the MMU at the other
process's top-level table: same virtual address, different physical page. And each entry carries
permission bits, such as "writable" and "user may access", so the kernel's own memory can be
mapped in every process yet stay out of reach in user mode.

## Page faults are normal

What happens at `0x2F10`, where the walk found nothing? The MMU cannot finish the load or store,
so the CPU takes an exception, exactly as for `svc`: mode switch, return address and reason saved
in registers, jump through the vector table to the kernel. This exception is a **page fault**
(Arm calls it a [**data abort**](/build-your-own/vmm/glossary/#data-abort) when a load or store
faults, and an instruction abort when fetching the next instruction faults).

There is one difference from a system call, and it matters a great deal later. After `svc`, the
saved return address is the *next* instruction: the call is done. After a fault, the saved address
is the *faulting instruction itself*, so that once the kernel has fixed the cause, returning runs
that instruction again. A call continues; a fault retries.

Why would a kernel fix a fault instead of killing the program? Because kernels fault on purpose.
When you ask for 64 MiB, the kernel only *promises* it: it records the range and fills no page
table entries. The first touch of each page faults, the kernel finds a free physical page, fills
the entry, and returns; the store runs again and succeeds. This is called lazy allocation, and
your Mac does it all day.

`touch.c` reserves 64 MiB and then writes one byte into the first N pages. The reserving is
`mmap`, the system call that asks the kernel for a range of fresh virtual addresses: `PROT_READ |
PROT_WRITE` asks for readable, writable memory, and `MAP_ANON` means plain memory, not backed by
a file. `mmap` returns at once, before any physical page is assigned: that is the promise. In the
`printf`, `>> 20` shifts right by 20 bits, which divides by 2^20 to turn bytes into MiB.

```c
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc, char **argv) {
    long pages = argc > 1 ? atol(argv[1]) : 0;
    long size = getpagesize();                 /* 16384 on Apple Silicon */
    char *buf = mmap(NULL, 4096 * size, PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANON, -1, 0);
    if (buf == MAP_FAILED) { perror("mmap"); return 1; }
    for (long i = 0; i < pages && i < 4096; i++)
        buf[i * size] = 1;                     /* first touch of page i */
    printf("reserved %ld MiB, touched %ld pages\n", 4096 * size >> 20, pages);
    return 0;
}
```

:::predict `/usr/bin/time -l` reports how many page faults the kernel repaired without touching the disk, in a line called "page reclaims". Running `./touch 0` gives a baseline of a few hundred, the faults of the program starting up: its code, its stack and its libraries arrive the same lazy way. How many more will `./touch 1000` show?
About 1,000 more: one fault per page, on its first touch. The run below shows exactly 1,000.
:::

```sh
clang -O1 -Wall -o touch touch.c
/usr/bin/time -l ./touch 0 2>&1 | grep -E "touched|page reclaims"
/usr/bin/time -l ./touch 1000 2>&1 | grep -E "touched|page reclaims"
```

Captured on an M5 Pro, macOS 27.2 (the baseline may differ by a few on your Mac, and from run to
run):

```text
reserved 64 MiB, touched 0 pages
                 293  page reclaims
reserved 64 MiB, touched 1000 pages
                1293  page reclaims
```

Exactly 1,000 more: one fault per page, on its first touch, each repaired by the kernel and each
followed by a retried store your program never noticed. (`man 2 getrusage`
defines the counter: "page faults serviced without any I/O activity".)

So a page fault is a question to the kernel, "is something supposed to be here?", and there are
two answers. If the kernel's records say yes, it fills in the page and retries. If they say no,
the access was a bug or an attack, and the kernel ends the process.

## Interrupts: when the outside world knocks

System calls and faults are caused by the instruction the CPU is running, so they happen at a
predictable point. Some events have nothing to do with the current instruction: a key is pressed,
a disk finishes a read, a timer reaches zero. The device raises a signal on a wire into the CPU,
an **interrupt**. The CPU finishes the instruction in hand, then takes an exception through the
same vector table (a different slot), saving the address of the next instruction so the
interrupted program can carry on as if nothing happened.

That is the whole difference: a system call or a fault is *synchronous*, caused by the instruction
being run; an interrupt is *asynchronous*, caused by something outside it. The kernel can
temporarily mask interrupts, and the CPU masks them itself on every exception entry (step 1
earlier) until the kernel is ready.

Only kernel mode may mask interrupts: it is one of the privileged operations from the "Two modes"
section. (Strictly, Arm lets a kernel grant that power to user mode with a control bit, and real
kernels such as Linux and macOS never do.) That rule is how the kernel always gets the CPU back
from a program that loops forever: a timer interrupt fires, and the kernel runs whether the app
likes it or not. On a real board, a chip called the interrupt controller collects the wires from
all devices and tells the CPU which one fired; chapter 12 sets up our guest's, using the one
built into Hypervisor.framework.

## Before the kernel: firmware and boot

Someone had to write the vector table and the page tables before the first app ran. That someone
is the kernel, but someone also had to load the kernel. When the CPU powers on, its memory holds
nothing useful and the MMU is off (every address is used as a physical address, untranslated);
the CPU starts executing at a fixed address chosen by the chip's designers, where a small
read-only memory holds the first program. The program there is [**firmware**](/build-your-own/vmm/glossary/#firmware): the program the
CPU runs first. It sets up the hardware (memory, clocks), then loads and starts the kernel, and on
many Arm systems it stays behind to answer a few requests, such as power-off and reset.

```text
  power on
     |
     v
  firmware ---- sets up RAM and clocks, finds the kernel, loads it,
     |          passes a description of the hardware
     v
  kernel   ---- builds page tables, turns the MMU on, installs the vector
     |          table, starts the interrupt controller and timer, finds
     |          devices, mounts the root filesystem
     v
  first process (PID 1), in user mode ---- starts everything else
```

*Each stage prepares the machine for the next, then hands over; after the last arrow, the kernel only
runs when an exception brings it in.*

Three terms in the diagram: the "description of the hardware" tells the kernel what memory and
devices exist and where (chapter 10 builds one for our guest); the **root filesystem** is the
disk holding the programs and files the kernel starts from, and to **mount** it is to make its
files reachable; PID 1 is the first process, which starts all the others.

Your Mac follows this shape. Its firmware is Apple's own; these two commands just show that it
exists and who PID 1 is:

```sh
system_profiler SPHardwareDataType | grep -i firmware
ps -p 1 -o pid,comm
```

```text
      System Firmware Version: 20457.41.3
  PID COMM
    1 /sbin/launchd
```

Your firmware version will differ. Process 1 on macOS is `launchd`; on Linux it is usually called
`init`, and in chapter 14 it will be a tiny BusyBox `/init` inside our VM.

Read the caption under the diagram again, because it is the most useful sentence in this primer.
Once boot is done, a kernel is an event handler: it runs only when a system call, a fault or an
interrupt takes the CPU into it, and it returns as soon as it can. Keep that picture. In chapter
00 you will find that a virtual machine monitor is built the same way, one level up.

## The puzzle, solved

Remember `null.c`? Here is the full story of `*p = 42`, with nothing left out.

1. Address 0 is deliberately left unmapped: no page table entry leads from it to RAM, on macOS
   and Linux alike, so that a null pointer fails loudly. (macOS goes further: every 64-bit
   program's lowest 4 GiB is a reserved, inaccessible region named `__PAGEZERO`. If you are
   curious, `otool -l null` lists it with `vmsize 0x0000000100000000` and protections 0.)
2. The store to address 0 reaches the MMU, which finds no usable translation. The CPU takes a
   data abort: it switches to kernel mode, saves the address of the store and the reason in
   registers, and jumps to the vector table's "synchronous, from user mode" slot.
3. The kernel's fault handler asks its question, "is something supposed to be here?", and its
   records say no. Retrying would fault forever, so it does not return to the store.
4. Instead it ends the process with signal 11 (SIGSEGV, "segmentation violation").
5. The shell had made a system call that waits for its child to end; the kernel now completes
   that call and hands back the result. zsh prints `segmentation fault` and sets `$?` to
   128 + 11 = 139.

Nobody in the program noticed anything. The CPU noticed, and the kernel decided.

## Self-check

Commit to an answer before you reveal it.

:::predict A program runs `exit(258)`. What does `echo $?` print in the shell that started it, and why?
`2`. The parent receives only the low 8 bits of the exit status: 258 is `0x102`, whose low byte is
`0x02`. Values from 0 to 255 survive unchanged, and the shell itself uses 128 and above to report
death by a signal.
:::

:::predict After an app's `svc` is handled, the kernel returns to the instruction after it. After a page fault the kernel has repaired, it returns to the faulting instruction itself. Why the difference?
A call is finished once the kernel has handled it, so the app should continue after it. A fault
means the instruction could not complete; once the kernel has fixed the cause (filled in the page
table entry), the same instruction must run again so its load or store actually happens. "A call
continues; a fault retries."
:::

:::predict In the toy two-level table above, translate `0x0412` and `0x2310`. Table A's index 4 maps to physical page `0x50`; every other entry of A is invalid. (Hint: split by hex digits, as in `0x0412` = `0 | 4 | 12`.)
`0x0412`: L1 index 0 points to table A; A's index 4 gives page `0x50`; offset `0x12`; physical
address `0x5012`. `0x2310`: L1 index 2 points to table B; B's index 3 gives page `0x7A`; offset
`0x10`; physical address `0x7A10`.
:::

:::predict Where does the CPU find the address to jump to on an `svc`, and who put it there?
In the exception vector table, whose location the kernel wrote into a CPU register during boot,
before any app ran. The CPU picks the slot for "synchronous exception from user mode". (Bonus,
from the optional box: on AArch64 that slot is at base plus `0x400`.) The app has no say: it cannot choose where kernel mode starts running, which is
what makes the door safe.
:::

:::predict An app runs `while (1) {}`, never calling the kernel and never faulting. How does the kernel ever get the CPU back?
Through an interrupt. A hardware timer fires, and the CPU takes an asynchronous exception into the
kernel at the end of the current instruction, whatever the app is doing. The app cannot mask
interrupts, because masking them is a kernel-mode-only operation (unless the kernel grants it,
which real kernels never do).
:::

:::predict True or false: firmware is finished and gone once the kernel starts.
False in general. Firmware's main job (set up the hardware, load and start the kernel) is done,
but on many Arm systems it stays resident to answer a few requests from the kernel, such as
"power off" or "start another CPU". In our VM, the VMM answers those requests itself (chapter 08).
:::

## Lab

:::lab syscall-stepper

In the `syscall-stepper` lab you single-step a tiny app in user mode (EL0) up to its `svc`, then
take the exception. A state panel shows four labels: **mode**, **PC**, **saved return address**
and **reason**. Before each step, predict which of them will change; then step and check. You
follow the PC into the vector table's slot, through a short kernel handler that reads the reason,
then reads the request from `x16` and writes the result back in `x0`, and through the return to
the instruction after the `svc`. A second mode replaces the `svc` with a store to an unmapped page,
so you can watch the saved return address point *at* the faulting instruction instead. The lab
uses the same four labels (mode, PC, saved return address, reason) as chapter 02's
`exception-stepper`, so the two screens can be read side by side.

## Where this shows up in macvmm

- [Chapter 00, orientation](/build-your-own/vmm/start/orientation/) (requires this primer): the
  toy machine has the same user mode and kernel mode, and "run the guest kernel in user mode and
  trap" is this primer's privilege picture turned into a strategy.
- [Chapter 01, ffi](/build-your-own/vmm/start/ffi/): Hypervisor.framework calls are library
  functions, and the ones that matter, such as `hv_vcpu_run`, end in a system call into macOS; a
  failed call returns an error code you will learn to read.
- [Chapter 02, first-exit](/build-your-own/vmm/bare-machine/first-exit/): the syscall of this
  primer, with every register named, then the same mechanism one level up: a guest's `hvc`
  becomes our first VM exit.
- [Chapter 03, test-guests](/build-your-own/vmm/bare-machine/test-guests/): `macvmm` reports
  results through its own exit statuses (exit status 5 means a timeout), read with `echo $?`.
- [Chapter 05, address-space](/build-your-own/vmm/memory/address-space/): a second page table,
  owned by Hypervisor.framework, translates the guest's "physical" addresses; a fault there is how
  device accesses reach us (the guest-memory code under `crates/vmm/src/memory/`).
- [Chapter 08, traps-psci](/build-your-own/vmm/cpu/traps-psci/): we pick a vector-table slot
  ourselves to inject an exception into the guest, and we play firmware's role when the guest asks
  to power off.
- [Chapter 09, mmio-pl011](/build-your-own/vmm/devices/mmio-pl011/) and
  [chapter 11, timer-irq](/build-your-own/vmm/interrupts/timer-irq/): devices raise interrupts,
  and a timer interrupt is how the guest kernel gets its CPU back.

## Going further

- Remzi and Andrea Arpaci-Dusseau, *Operating Systems: Three Easy Pieces* (free online at
  ostep.org): chapter 6, "Mechanism: Limited Direct Execution" (user mode, kernel mode and the trap
  table), chapter 18, "Paging: Introduction", and chapter 20, "Paging: Smaller Tables" (multi-level
  tables, with more worked examples).
- Arm, *Learn the architecture: AArch64 Exception Model* (document 102412): exception levels,
  exception entry and return, and the vector table, in Arm's own gentle words.
- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487), chapter D1,
  "The AArch64 System Level Programmers' Model": the sections on exception entry, the preferred
  return address, and the exception vectors (the table of `VBAR_ELx` offsets). Section numbers
  move between issues, so search by title. The [`reading-arm-specs`](/build-your-own/vmm/primers/reading-arm-specs/) primer shows how to navigate it.
- On your Mac: `man 2 getrusage` (the page-fault counters), `man 2 wait` (how a parent collects an
  exit status), and Apple's *Platform Security Guide*, "Boot process for a Mac with Apple silicon",
  for the firmware stages before macOS.

## Checkpoint

:::checkpoint

- **What you can do now.** Run `sh -c 'exit 5'` followed by `echo $?` and see `5`. Explain who
  stopped `null.c` and where the 139 came from, translate an address through a two-level table by
  hand, and say which return address a call and a fault each save.
- **What's next.** Chapter 00 asks how macOS and Linux can both believe they own the same Mac. You
  now have every piece of the answer's vocabulary: privilege modes, traps, page tables, interrupts,
  and a kernel that is an event handler. The chapter adds one more level above the kernel.
- **One open question.** A kernel trusts its page tables because only kernel mode can change them.
  Now put a whole kernel inside a virtual machine (a pretend computer, run as a program on a
  real one; chapter 00 starts there), running its own page tables in what it believes
  is kernel mode. Who checks *its* addresses?
