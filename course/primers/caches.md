---
title: Caches and coherency
slug: caches
kind: primer
minutes: 20
runs: mac+browser
required_by: [13]
also_used_by: [04, 27]
labs: [cache-views]
objectives:
- Explain what a cache line is and why a core keeps separate instruction and data caches
- Define Point of Unification and Point of Coherency, and say which observers meet at each
- Choose between clean, invalidate, and clean-and-invalidate for a given stale-data problem
- Decode CTR_EL0.IDC and CTR_EL0.DIC and state what code-patching steps they make necessary
- Explain what booting.rst means by "cleaned to PoC" and what macvmm observed on Apple Silicon
command: ./stale maintain
expect: 0 of 1000 calls ran the old instruction
---

# Why did the CPU run the old instruction?

Here is a 24-line C program that acts as a tiny JIT: like the engine inside a web browser, it
writes machine code into memory while it runs, then calls that memory as a function. It writes
the instruction "return 1", runs it a hundred times, overwrites it with "return 2", and calls it
once more. It repeats that 1,000 times and counts how often the CPU ran the instruction that was
no longer there. On an Apple M5 Pro the answer is **1000 of 1000**. Every single time, the
processor executed code that we had already replaced, while a plain load from the same address
returned the new bytes.

That is not a bug in the program, and not a bug in the CPU. It is a cache doing exactly what the
architecture allows. A VMM meets this rule three times:

- when a guest starts with its **MMU** off (chapter 04). The MMU is the part of the CPU that
  translates the addresses a program uses into physical RAM addresses (the [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer);
  "off" means addresses are used as physical addresses, untranslated;
- when we copy a Linux kernel into guest RAM and the boot protocol insists it be "cleaned to PoC"
  (chapter 13);
- when a debugger plants a breakpoint instruction in guest code (chapter 27).

By the end of this primer you will be able to say, for each of those, what could go stale, who
has to fix it, and what we measured on real hardware.

:::objectives
- Explain what a cache line is and why a core keeps separate instruction and data caches.
- Define Point of Unification and Point of Coherency, and say which observers meet at each.
- Choose between clean, invalidate, and clean-and-invalidate for a given stale-data problem.
- Decode `CTR_EL0.IDC` and `CTR_EL0.DIC` and state what code-patching steps they make necessary.
- Explain what `booting.rst` means by "cleaned to PoC" and what macvmm observed on Apple Silicon.
:::

:::prereqs
- The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer: what a kernel, a process and the MMU are.
- The [`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/) primer: exception levels, system registers and the `mrs`
  instruction.
- Helpful but not required: the [`page-tables`](/build-your-own/vmm/primers/page-tables/) primer, for the one section on memory
  attributes (`MAIR_EL1`).
- A Mac with the Xcode command-line tools (`cc`) for the experiments; the lab runs in any browser.
:::

## Run the puzzle yourself

One function is the star: `sys_icache_invalidate(addr, len)` tells the CPU to throw away any
copy of the instructions in that range that it has kept for itself, so the next call fetches the
current bytes. The program calls it once after writing the first version, and, only when you pass
an argument, once more after patching.

Three other macOS details you can take on trust: `MAP_JIT` asks for a page that may hold
generated code, and `pthread_jit_write_protect_np` flips that page between "writable" and
"executable" (macOS never lets it be both at once for a thread). The two hex constants are the A64
encodings of `mov w0, #1` and `mov w0, #2` (put 1 or 2 in the return-value register); `0xd65f03c0`
is `ret`. The 100-call loop exists only to make the CPU keep a copy of the old instruction, which
is the copy that will go stale.

`stale.c`

```c
#include <libkern/OSCacheControl.h>
#include <pthread.h>
#include <stdio.h>
#include <sys/mman.h>

int main(int argc, char **argv) {
    int maintain = argc > 1;                      /* any argument: do the maintenance */
    unsigned *code = mmap(0, 16384, PROT_READ | PROT_WRITE | PROT_EXEC,
                          MAP_PRIVATE | MAP_ANON | MAP_JIT, -1, 0);
    int (*fn)(void) = (int (*)(void))code, stale = 0;
    for (int trial = 0; trial < 1000; trial++) {
        pthread_jit_write_protect_np(0);          /* page: writable */
        code[0] = 0x52800020; code[1] = 0xd65f03c0;   /* mov w0, #1 ; ret */
        pthread_jit_write_protect_np(1);          /* page: executable */
        sys_icache_invalidate(code, 8);
        for (int i = 0; i < 100; i++) fn();       /* run it until it is "hot" */
        pthread_jit_write_protect_np(0);
        code[0] = 0x52800040;                     /* patch to mov w0, #2 */
        pthread_jit_write_protect_np(1);
        if (maintain) sys_icache_invalidate(code, 8);
        if (fn() != 2) stale++;
    }
    printf("%d of 1000 calls ran the old instruction\n", stale);
}
```

Build it and run it twice, once without an argument and once with one:

```sh
clang -O2 -Wall -o stale stale.c
./stale
./stale maintain
```

```text
1000 of 1000 calls ran the old instruction
0 of 1000 calls ran the old instruction
```

This is the output on an M5 Pro under macOS 27.2, the same on three runs in a row. Other Apple
Silicon chips should behave the same way, but the first number is the one to check on yours. The
whole difference between the two lines is one call, `sys_icache_invalidate`. To see why it
matters, we need to know what the CPU keeps besides memory.

## A cache is a copy, kept close

A core can start a new instruction every fraction of a nanosecond. A trip to DRAM takes on the
order of a hundred nanoseconds. (Both figures are rough and vary by chip; the ratio is the point.)
If every load waited for DRAM, the core would spend nearly all its time waiting. So each core keeps
small, fast memories next to it that hold **copies** of recently used memory. Such a memory is a
**cache**.

A cache does not copy single bytes. It copies aligned blocks, because a program that touches one
byte usually touches its neighbours next. One block is a **cache line**. macOS reports the sizes:

```sh
sysctl hw.cachelinesize hw.l1icachesize hw.l1dcachesize hw.l2cachesize
```

```text
hw.cachelinesize: 128
hw.l1icachesize: 131072
hw.l1dcachesize: 65536
hw.l2cachesize: 8388608
```

Your numbers depend on the chip. Caches come in levels: level 1 (L1) is the smallest and closest
to the core, level 2 (L2) is bigger and a little further away. Notice that there are two L1
caches. A core reads memory for two different reasons: to **fetch instructions** (the bytes it is
about to execute) and to **load data** (what an `ldr` instruction asks for). The I-cache serves
fetches (128 KiB here) and the D-cache serves loads and stores (64 KiB). They are separate because
both streams run at the same time, from different places, and two smaller caches serve two
streams faster than one shared cache. Behind them sits a larger L2 shared by a **cluster** (a
group of cores built side by side on the chip), and on most systems a further cache in front of
DRAM.

Think of RAM as a library and a cache as the photocopies on your desk. Reading your photocopy is
fast. Scribbling on it is fast too, but the library's page does not change until you take your copy
back. And if someone updates the library's page, your photocopy is now out of date and nothing on
your desk tells you so.

This primer needs one word for "anyone with a desk": an **observer** is anything that reads or
writes memory. A core's instruction side is one observer and its data side another; other cores
are observers; so is a **DMA** engine (a device, such as a disk controller, that copies to and
from RAM by itself, without a core doing the loads and stores); and so is a guest.

Where the library picture breaks: for ordinary data, the hardware *does* tell you. The cores'
data caches talk to each other (a **coherence protocol**), so a write by one core invalidates or
updates the other cores' copies automatically. That is why multithreaded programs never flush
caches by hand. The interesting cases are the observers the protocol does not cover.

```text
  core 0            core 1              (VMM thread runs on some core too)
 [ I$ ][ D$ ]      [ I$ ][ D$ ]
     \   /             \   /
   [ L2, shared by the cluster ]
              |
   [ system-level cache ]
              |
            DRAM  <-- other observers: GPU, DMA engines, a guest with caching off
```

*A simplified hierarchy (`$` is old shorthand for "cache"). Two levels in it will get names in a
moment.*

> **Aside.** The CPU's own description, read through Hypervisor.framework below, gives 64 bytes as
> the smallest line size, while `sysctl` says 128. They answer different questions: `CTR_EL0`
> reports the smallest line in the hierarchy, which is the safe step size for maintenance loops;
> `hw.cachelinesize` is what macOS tells programs to align data to. Code that walks memory line by
> line must use the smaller number, or it will skip lines.

## Where the hardware stops helping

Two kinds of observer fall outside the coherence protocol, and both matter to a VMM.

The first is the **instruction side**. On Arm, a store goes into the data cache. The instruction
fetcher reads from the I-cache, which the architecture does not require to notice that store. That
is our puzzle: the patched bytes sat in the data side, visible to any load, while the I-cache still
held the old line, so `fn()` ran `mov w0, #1`.

The second is any access that **bypasses the cache**. Memory has attributes, chosen per page, and
one of them is whether the page may be cached at all.

- **Normal** memory is ordinary RAM. It may be cached, usually **Write-Back**: writes stay in the
  cache until the line is **evicted** (pushed out to make room for another line), and only then
  reach RAM. The core may also read Normal memory **speculatively**, that is, before the program
  asks, because it guesses the program soon will, and it may read it more than once. That is
  harmless, because reading RAM has no side effects. Normal memory can also be marked
  **Non-cacheable**.
- **Device** memory is for device registers. It is never cached and never read speculatively, and
  in its strictest forms (such as Device-nGnRnE, used for device registers) every access happens
  exactly once, in order, as the program issued it. Reading the PL011 UART's data register removes
  a byte from its receive queue. A cache that read it twice, or kept an old copy, would lose
  keystrokes.

Who picks the attribute? Recall the exception levels from `aarch64-reading`:

- **EL0**: applications.
- **EL1**: an operating system kernel, including a guest's kernel.
- **EL2**: the hypervisor (inside macOS, Hypervisor.framework's part).

A kernel at EL1 picks the attribute for each page in its own page tables, which the architecture
calls **stage 1**. Under virtualization there is a second set, **stage 2**, owned by the
hypervisor, which turns guest-physical addresses into host-physical ones; chapter 04 builds that
idea. For this primer, stage 1 is "the guest OS's own page tables".

The fact that matters: a kernel that has not yet turned its MMU on has no page tables, so there is
no attribute to read. The architecture then fixes one: every **data** access is treated as Device
memory, so a freshly started guest's loads and stores do not go through a cache at all.
Instruction fetches are a little different (Normal memory, cached only if the kernel enabled the
I-cache).

> **Under the hood (optional).** The control bits live in `SCTLR_EL1`: `M = 0` turns stage-1
> translation off, `C = 0` makes data accesses to Normal memory non-cacheable, and `I` controls
> instruction caching. With `M = 0` the ARM ARM specifies Device-nGnRnE for data accesses (DDI
> 0487, chapter D8, "The effects of disabling address translation"). With the MMU on, the kernel's
> page-table entries choose from a menu of attributes held in `MAIR_EL1` (the `page-tables` primer).

Now put a VMM in the picture. Our host process reads and writes guest RAM through an ordinary,
cacheable mapping. The freshly started guest's stores go to RAM around the cache. Two observers,
one byte of RAM, two different routes to it:

```text
   guest (MMU off, Device)                 host VMM (cacheable mapping)
   ---------------------- trust boundary ------------------------------
   store 0xAB ---around the caches?---> RAM holds 0xAB
                                        VMM's D-cache line still holds 0x00
                                        VMM load ---hits the old line?---> reads 0x00 ?
```

*The hypothesis, not an observation: what the architecture allows if the guest's write goes
around the cache and the VMM's read comes from it.*

Whether that worry is real depends on where those two routes meet. The next two sections give the
vocabulary for that; the experiment near the end answers whether it happens on this Mac.

## Two meeting points: PoU and PoC

The ARM ARM names the meeting points instead of the cache levels, because the levels differ from
chip to chip while the guarantees do not.

The **Point of Unification** (PoU) of a core is the first point at which that core's instruction
cache, data cache and page-table walker (the hardware that reads page tables for the MMU; not
needed here) are guaranteed to see the same copy of a location. If you wrote code through the
data side, it has to reach the PoU before the instruction side can pick it up.

The **Point of Coherency** (PoC) is the point at which **all** observers that can access memory
are guaranteed to see the same copy, whatever memory type or cacheability attribute they use. Cores,
DMA engines, and an observer with its caches off all meet here. In the diagram above, the PoU is
typically the shared L2 and the PoC the system-level cache or DRAM, but those are typical
placements, not rules.

A worked example. A core's data side writes a byte; for now it sits in that core's L1 D-cache.

- Once the line reaches the **PoU**, that core's instruction side can fetch the new byte.
- Once it reaches the **PoC**, an observer that does not use caches at all (a DMA engine, a guest
  with its MMU off) can read the new byte from memory.

A third name appears in instructions. A **shareability domain** is a set of observers that the
architecture promises to keep in step for a given operation; the **Inner Shareable** domain is,
for us, every CPU core in the machine. **PoU Inner Shareable** is then the point where the I and D
sides of *all* those cores agree, which is what an instruction ending in `ISH` aims at.

## Clean, invalidate, and the code-patching recipe

There are two things you can do to a cached copy, and the names are worth getting exactly right.
A line is **dirty** when the cache holds writes that have not yet reached memory further out.

- **Clean** writes a dirty line out toward the meeting point, and keeps the copy. Use it when
  *your* writes must become visible to someone further out.
- **Invalidate** throws the copy away, without writing it back. Use it when *someone else's*
  writes must become visible to you. It is the dangerous one: invalidating a dirty line silently
  loses the data in it.
- **Clean and invalidate** does both, in that order, and is the safe choice when you are unsure.

Arm exposes these as instructions that take a virtual address in a register and act on the whole
line around it. The names are built from letters: `DC` data cache, `IC` instruction cache, `C`
clean, `I` invalidate, `CI` both, `VA` by virtual address, and a final `C` or `U` for "to the PoC"
or "to the PoU".

| Instruction | Read as | Up to |
|---|---|---|
| `DC CVAC` | data cache, clean by VA | PoC |
| `DC CVAU` | data cache, clean by VA | PoU |
| `DC IVAC` | data cache, invalidate by VA | PoC |
| `DC CIVAC` | data cache, clean and invalidate by VA | PoC |
| `IC IVAU` | instruction cache, invalidate by VA | PoU |

Why are barriers needed as well? A CPU is allowed to reorder and defer its own work for speed: a
maintenance instruction can be issued and still be in progress while later instructions run. A
**barrier** is an explicit "wait here". Two kinds matter: `DSB ISH` waits until earlier stores and
maintenance are complete across the Inner Shareable domain, and `ISB` discards any instructions this
core has already fetched, so the next fetch goes back to the I-cache. (Barriers get their own
primer, [`memory-ordering`](/build-your-own/vmm/primers/memory-ordering/), before chapter 16; these two meanings are all we need.)

The architecture's recipe for running code you have just written is below. `Xn` is a register
holding an address inside the patched range. The first four lines are repeated once per cache
line, with `Xn` advanced by the line size each time, and the final `ISB` is issued once at the end
(real code runs all the `DC`s, one `DSB`, then all the `IC`s, as `sys_icache_invalidate` does below):

```text
DC  CVAU, Xn    ; push the new bytes from the D-cache to the PoU
DSB ISH         ; wait for that
IC  IVAU, Xn    ; drop the stale copy from every I-cache
DSB ISH         ; wait for that
ISB             ; refetch on this core
```

Two bits in a register let a CPU say "you may skip a step", which brings us to that register.

## CTR_EL0: the CPU says what it needs

`CTR_EL0` (Cache Type Register) is a **system register**: one of the CPU's built-in configuration
and identity registers, read with the `mrs` instruction ("move to register from system") rather
than with a load. It describes the caches to software. The fields that matter here:

| Field | Bits | What it tells you |
|---|---|---|
| `DIC` | 29 | 1: you may skip `IC IVAU`. 0: you must invalidate the I-cache. |
| `IDC` | 28 | 1: you may skip `DC CVAU`. 0: you must clean the D-cache to PoU. |
| `DminLine` | 19:16 | a number *n*: the smallest data line is 2^*n* words of 4 bytes |
| `L1Ip` | 15:14 | how the L1 I-cache finds a line; `0b11` is PIPT (below) |
| `IminLine` | 3:0 | a number *n*: the smallest instruction line is 2^*n* words of 4 bytes |

Let us read it. The name ends in `_EL0`, and the architecture does allow user programs to read
it, unless the kernel sets a trap (`SCTLR_EL1.UCT = 0`). A **trap** means the CPU refuses the
instruction and hands control to the kernel instead. Deliberate failure ahead:

`ctr.c`

```c
#include <stdio.h>
#include <stdint.h>
int main(void) {
    uint64_t v;
    __asm__ volatile("mrs %0, ctr_el0" : "=r"(v));
    printf("CTR_EL0 = %#llx\n", (unsigned long long)v);
}
```

```sh
clang -o ctr ctr.c
./ctr
echo $?
```

```text
132
```

Before the `132`, your shell prints a line saying an illegal instruction killed the program (the
wording differs between zsh and bash). When a signal kills a process, the shell reports its exit
status as 128 plus the signal number; 132 is 128 + 4, and signal 4 is `SIGILL`, "illegal
instruction". macOS traps user-mode reads of `CTR_EL0` and turns the trap into that signal; we
infer it leaves `UCT` clear, and the effect is what we measured. That is why
`sys_icache_invalidate` exists: the kernel and libc know the cache geometry so that your program
does not have to.

A guest kernel at EL1 *can* read `CTR_EL0`, and Hypervisor.framework reports the value it will
see through `hv_vcpu_config_get_feature_reg`. The project's spike printed, on this machine:

```text
    feature CTR_EL0            = 0x000000099444c004 [HV_SUCCESS]
    feature CLIDR_EL1          = 0x0000000080000023 [HV_SUCCESS]
```

Decode the low 32 bits, `0x9444c004`. Each hex digit is exactly four bits, so write them out from
the top (bit 31) down:

| Hex digit | `9` | `4` | `4` | `4` | `c` | `0` | `0` | `4` |
|---|---|---|---|---|---|---|---|---|
| Bits | 31..28 | 27..24 | 23..20 | 19..16 | 15..12 | 11..8 | 7..4 | 3..0 |
| Binary | `1001` | `0100` | `0100` | `0100` | `1100` | `0000` | `0000` | `0100` |
| Fields | 31 = 1 (always), 30 = 0, **DIC = 0**, **IDC = 1** | (other) | (other) | **DminLine = 4** | **L1Ip = `0b11`** | | | **IminLine = 4** |

So `DIC = 0` and `IDC = 1`. `DminLine = 4` means 2^4 = 16 words of 4 bytes = 64 bytes, and
`IminLine = 4` is also 64 bytes. (Digits 2 and 3 hold fields about write granules that we do not
need, and the bits above 31 concern memory tagging.)

`L1Ip = 0b11`, **PIPT** (physically indexed, physically tagged), means the I-cache finds a line by
its *physical* address. That matters when two different virtual addresses map the same physical
memory, as the host's view and the guest's view of guest RAM do: with PIPT, both reach the same
cache line. Experiment 2 relies on that.

Now the puzzle resolves. `IDC = 1`: once a store is in the D-cache, the instruction side can reach
it without a clean, so `DC CVAU` can be skipped. `DIC = 0`: the I-cache may still hold the old
line, so `IC IVAU` **is** necessary. Our program skipped it, and the hot I-cache line won 1,000
times out of 1,000. You can watch `sys_icache_invalidate` follow exactly this reasoning with the
debugger (addresses differ on every boot; lines elided with `...`):

```sh
lldb -b -o "b main" -o run -o "disassemble -n sys_icache_invalidate" ./stale
```

```text
libsystem_platform.dylib`sys_icache_invalidate:
    ...
    0x1964f303c <+28>:  dsb    ish
    ...
    0x1964f3048 <+40>:  ic     ivau, x9
    0x1964f304c <+44>:  add    x9, x9, #0x40
    ...
    0x1964f306c <+76>:  dsb    ish
    0x1964f3070 <+80>:  isb
    0x1964f3074 <+84>:  ret
```

Read it line by line (`+28` is the offset in bytes from the start of the function):

- `+28 dsb ish`: wait until our earlier stores, the new instruction bytes, are complete and
  visible. This barrier stays even though the clean is gone.
- `+40 ic ivau, x9`: invalidate the I-cache line containing the address in register `x9`.
- `+44 add x9, x9, #0x40`: move `x9` on by 0x40 = 64 bytes, one line (`IminLine`); the elided
  lines branch back to `+40` until the range is covered.
- `+76 dsb ish`: wait until every invalidation is complete on every core.
- `+80 isb`: discard what this core already fetched. `+84 ret` returns.

There is no `DC CVAU` anywhere. So with `IDC = 1` the recipe becomes: `DSB ISH` (make the stores
visible), then `IC IVAU` once per line, then `DSB ISH` and `ISB`. Only the clean is dropped, never
the first barrier: without it the invalidation could overtake the stores it is meant to follow.

> **Under the hood (optional): `CLIDR_EL1`.** The Cache Level ID Register describes the levels.
> Its low bits, `0x23`, say level 1 has separate I and D caches and level 2 is unified. Three
> fields give the level at which each meeting point is reached: LoUIS (Level of Unification, Inner
> Shareable, bits 23:21), LoC (Level of Coherence, 26:24) and LoUU (Level of Unification,
> Uniprocessor, 29:27). All three are **0** here. The ARM ARM defines a LoC of 0 to mean that no
> level of cache needs cleaning or invalidating to reach the PoC, and likewise for the PoU fields.
> That is what the register *says*, read from a single value. The inference we draw from it, with
> less confidence: as far as this **vCPU** (the virtual CPU that Hypervisor.framework gives a
> guest) reports, data caches never stand between a core and the PoC. We cannot tell whether that
> is the hardware's truth or a value HVF chose to report. It predicts experiment 1 below.

> **Try it.** In `stale.c`, change the warm-up loop from `i < 100` to `i < 0` and run `./stale`
> without an argument. On the M5 Pro it prints `0 of 1000`. Then try `i < 1`: back to `1000 of
> 1000`. With no warm-up, the old instruction was never fetched after the first
> `sys_icache_invalidate`, so the I-cache had no stale line to serve. A stale copy needs a copy
> first. This is why the chapter 27 test puts its breakpoint on an instruction that has been running
> in a loop.

## What booting.rst means by "cleaned to PoC"

Some terms first. The **kernel Image** is the Linux kernel as one flat file of machine code, ready
to be copied into RAM and jumped to. The **loader** is whatever copies it there and starts it:
normally a bootloader such as U-Boot, and in a VMM, the VMM. The **boot protocol** is the contract
between them, the state the kernel may assume when its first instruction runs.

Linux's arm64 boot protocol (`Documentation/arch/arm64/booting.rst`, section 4, "Call the kernel
image") lists that state. Under "Caches, MMUs" it says the MMU must be off, the instruction cache
"may be on or off, and must not hold any stale entries corresponding to the loaded kernel image",
and "the address range corresponding to the loaded kernel image must be cleaned to the PoC". (Why
MMU off? The kernel has not built its page tables yet, and it is the one that builds them; the
[`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/) primer covers the rest.)

You can now read those sentences. The kernel starts with the MMU off, so its data accesses are
Device and go to memory around the caches, and its instruction fetches may be non-cacheable too.
The hazard, step by step:

```text
loader writes Image  -> bytes sit dirty in the loader's D-cache, RAM still holds old bytes
kernel starts, MMU off -> its reads go straight to RAM, around the caches
kernel reads RAM     -> gets the old bytes, not the Image
```

The kernel then runs some correct code and some garbage, and crashes in a place far from the cause.
"Cleaned to PoC" means: push the loader's writes to the one point where even an uncached observer
agrees. "No stale entries" in the I-cache is the same instruction-side hazard as our puzzle.

In a VMM, the loader is us. In chapter 13 our host process copies the Image into guest RAM through
its cacheable mapping, then starts a vCPU with the MMU off. So the question is concrete: must
macvmm clean the Image to PoC, and how would a user-space process even do that?

## The two experiments, and what we observed

The course does not answer cache questions by assumption. It answers them with an experiment on
the real machine, and records which answer was seen. Both experiments belong to later chapters;
here you need only their question and their result, and you can come back to the details when you
reach those chapters.

**Experiment 1: MMU-off guest writes, cacheable VMM reads.** This is chapter 04's `memtest`, a
tiny bare-metal guest program (no operating system; it runs directly on the vCPU). It runs with the
MMU and caches off, writes 8 patterns over 16 MiB, then asks the VMM to hash the same window
through its cacheable mapping and compares that hash with its own. It asks through a **hypercall**:
the guest asking the VMM for a service, the way a program makes a system call to its kernel. If any
of the VMM's reads had hit an old cache line, the hashes would differ. The guest also executes code
that the host copied in, so the other direction is tested too. With your signed build (chapter 01;
`macvmm` below stands for it, and chapter 04 shows how the learner's version is run):

```sh
macvmm run --mem 64M --raw target/guests/aarch64-unknown-none/release/memtest.bin@0x40080000 --timeout 10
```

The flags: give the guest 64 MiB of RAM; copy the raw file `memtest.bin` into guest RAM at
guest-physical address `0x4008_0000` and start there; stop after 10 seconds if the guest has not
finished.

```text
memtest: pattern 1 ok
memtest: pattern 2 ok
memtest: pattern 3 ok
memtest: pattern 4 ok
memtest: pattern 5 ok
memtest: pattern 6 ok
memtest: pattern 7 ok
memtest: pattern 8 ok
memtest: memhash ok
memtest: memhash rejects overflow ok
```

`memhash ok` is the line that answers our question: the VMM's hash of the window, read through
its cache, matched what the uncached guest wrote. (The last line is a security check on the
hypercall, not part of this experiment.)

> **Result of experiment 1.** **Observed** (exit status 0), on this machine, recorded in
> `docs/research/guest-boot.md`: MMU-off guest writes are visible to the VMM without cache
> maintenance, and host writes are visible to the MMU-off guest. So in chapter 13, macvmm copies
> the Image and does no explicit clean, and says why in a comment that cites this evidence.

> **Under the hood (optional, skippable).** We know *that* the two views agree, not exactly *why*.
> Under virtualization a guest's memory attribute (from stage 1, or the MMU-off default) is
> combined with the hypervisor's stage-2 attribute, and normally the stricter one wins, so stage 2
> alone cannot make a Device access cacheable. Arm has an optional feature, FEAT_S2FWB, that lets
> stage 2 force write-back caching, and a control bit, `HCR_EL2.DC`, that makes MMU-off guest data
> accesses cacheable. Candidate explanations: Hypervisor.framework uses one of those two, or
> Apple's memory system keeps uncached accesses coherent with the caches. The `CLIDR_EL1` value
> (LoC = 0) fits the last one, but HVF does not document its stage-2 settings, so this stays
> unknown. The safe conclusion is narrow: on Apple Silicon with HVF, measured. A port to other
> hardware must measure again.

**Experiment 2: a breakpoint written into hot guest code.** In chapter 27, macvmm gets a **GDB
stub**: a small server inside the VMM that lets the GDB debugger inspect and control the guest.
To plant a software breakpoint it writes a `BRK` instruction (the Arm instruction that stops
execution and reports a breakpoint) into guest RAM through the host mapping, while the guest may
have the old instruction in its I-cache. This is our puzzle, across the guest/host boundary. The
planned test (`brk_icache`, in a milestone after the first release) puts a breakpoint on an
instruction executed 1,000 times in a loop and requires a hit on the next iteration in 100 runs out
of 100. What we expect, and why: `DIC = 0` makes I-cache invalidation architecturally required,
and `stale.c` showed this machine really serves stale instructions. So the plan is to call
`sys_icache_invalidate` on the host address of the patched bytes. Because the I-cache is PIPT
and `IC IVAU` acts on every core in the Inner Shareable domain, invalidating by the *host* virtual
address should reach the line the guest's vCPU cached.

> **Status of experiment 2.** **Not yet observed.** The plan is to call `sys_icache_invalidate`
> after writing the breakpoint; the test will decide, and its result goes in
> `docs/research/hvf-api.md`. Until then, treat this as a reasoned prediction.

> **Security.** In chapter 27 the breakpoint address and length arrive in a message from the
> debugger, which is hostile input. Translate and bounds-check them through `GuestMemory` (the
> checked guest-RAM interface built in chapter 04) before you form a host pointer for the write
> *or* for the cache maintenance: a maintenance call on an unchecked range is still an access to
> host memory the guest's debugger chose.

> **Production note (optional).** KVM, Linux's built-in hypervisor, cannot rely on one chip's
> behaviour, so it does maintenance whenever it maps a page for a guest: it cleans the data cache
> to PoC unless the CPU has FEAT_S2FWB, and invalidates the I-cache for executable pages unless
> `CTR_EL0.DIC` is 1 (see `arch/arm64/kvm/mmu.c` in Linux). macvmm targets one platform and
> replaces those general rules with measurements on it.

## Self-check

Commit to an answer before you open each one.

:::predict Two host threads share a counter in ordinary (Normal, Write-Back) memory. Thread A writes it; thread B reads it on another core. Does either thread need cache maintenance instructions?
No. The data caches of the cores are kept coherent by hardware for Normal cacheable memory. (B may
still care about *when* A's write appears relative to A's other writes; that is a different topic,
ordering, covered in the `memory-ordering` primer, and not something cache maintenance fixes.)
:::

:::predict Why must the PL011 data register never be mapped as Normal cacheable memory?
Reading it has a side effect: it removes a byte from the receive queue. Normal memory may be read
speculatively, more than once, or served from an old cached copy, so bytes would be consumed
without the program asking or old bytes would be returned. Device memory is never cached or read
speculatively, and the strict Device-nGnRnE type used for registers makes each access happen once,
in order, as issued.
:::

:::predict Which observers are guaranteed to agree at the PoU, and which only at the PoC? Where must a JIT's new code get to, and where must a kernel image get to before an MMU-off kernel reads it?
At the PoU, one core's instruction side, data side and page-table walker agree (at PoU Inner
Shareable, those of all cores). At the PoC, every observer agrees, including DMA engines and
observers with caches off. A JIT's code must reach the PoU, because only the I side needs it; a
kernel image must reach the PoC, because an MMU-off kernel reads memory without caches.
:::

:::predict You need another observer's recent writes to become visible to you, and your cache might hold an old copy of the line. Do you clean or invalidate? And what goes wrong if you invalidate a line you yourself had modified?
Invalidate, because the problem is your stale copy, not your writes. Invalidating a dirty line
discards your own modifications without writing them back, so they are lost; if you might have
written the line, use clean-and-invalidate.
:::

:::predict A JIT runs on a CPU whose CTR_EL0 has IDC = 1 and DIC = 0. After writing new instructions, which of DC CVAU and IC IVAU must it execute?
Only `IC IVAU`, but the barriers stay: `DSB ISH` first (so the new bytes are visible before the
invalidation), then `IC IVAU` per line, then `DSB ISH` and `ISB`. `IDC = 1` lets you skip the
D-side clean to PoU, and nothing else; `DIC = 0` means the I-cache can hold stale lines and must
be invalidated. That is exactly what `sys_icache_invalidate` does on the M5 Pro.
:::

:::predict A different, hypothetical CPU reports CTR_EL0 low word 0x8444c004. What are DIC and IDC, how long is the smallest instruction line, and what must a JIT do?
The top digit `8` is `1000`: bit 31 = 1, bit 30 = 0, `DIC` (bit 29) = 0, `IDC` (bit 28) = 0.
`IminLine` (low digit) is 4, so 64-byte lines. With both 0, the JIT needs the full recipe: `DC
CVAU` per line, `DSB ISH`, `IC IVAU` per line, `DSB ISH`, `ISB`. (A top digit of `b` = `1011`
would set both bits; then neither `DC CVAU` nor `IC IVAU` is required, though a `DSB ISH` and an
`ISB` still are.)
:::

:::predict A loader copies a kernel into RAM through a cacheable mapping, does not clean to PoC, and starts the kernel with the MMU off. What might the kernel read, and why might the crash appear far from the cause?
The kernel's MMU-off reads go to RAM around the caches. For lines still dirty in the loader's cache
above the PoC, RAM holds the old contents, not the image, so that is what the kernel reads. It runs
some correct code and some garbage, so it fails wherever it first touches a stale line, which says
nothing about the missing clean. On Apple Silicon under HVF, experiment 1 showed this does not
happen; the architecture permits it elsewhere.
:::

:::predict In stale.c, with the warm-up loop removed, every call returns 2 even without maintenance. Why does that not prove the maintenance is unnecessary?
Without a warm-up, the old instruction was never fetched after the last invalidate, so the I-cache
held no copy to go stale. The hazard needs a cached old copy. A test that never creates one passes
for the wrong reason, which is why chapter 27's test breaks on a hot instruction.
:::

## Lab

:::lab cache-views

`cache-views` (built later, embedded here and in chapter 13) shows two observers of one guest RAM
window: the VMM through a cacheable mapping and the guest with its MMU off, plus a toy cache with a
few lines you can see. You write from either side, then toggle clean and invalidate on individual
lines and watch who reads stale data. Its goal is the table in your head: which operation fixes
which direction, and which one can lose a write.

## Where this shows up in macvmm

- **Chapter 04, Guest memory** (`/build-your-own/vmm/memory/guest-memory/`): `memtest` and its
  optional Under the hood callout, which links here. Experiment 1 is its test.
- **Chapter 06, vCPU state** (`/build-your-own/vmm/cpu/vcpu-state/`): reset sets
  `SCTLR_EL1.M = 0` and `C = 0`, the state this primer explains.
- **Chapter 13, Loading kernels** (`/build-your-own/vmm/linux/loaders/`, requires this primer):
  the Image loader in `crates/vmm/src/loader/` copies the kernel and, on the evidence above, does
  no clean to PoC. Read the `arm64-boot-protocol` primer for the rest of `booting.rst`.
- **Chapter 27, Debugging and performance** (`/build-your-own/vmm/production/debug-perf/`): the
  GDB stub writes `BRK` into guest code; experiment 2 decides its I-cache maintenance.
- Related primers: `page-tables` (memory attributes and `MAIR_EL1`), `memory-ordering` (barriers).

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487): chapter B2,
  "The AArch64 Application Level Memory Model" (caches, and "Concurrent modification and execution
  of instructions"); chapter D7, "The AArch64 System Level Memory Model" (cache maintenance and the
  definitions of PoC and PoU); chapter D8 (the effects of disabling address translation); and the
  `CTR_EL0`, `CLIDR_EL1` and `SCTLR_EL1` register descriptions. Section numbers shift between
  issues, so search by these titles.
- Linux, `Documentation/arch/arm64/booting.rst`, section 4, "Call the kernel image".
- Arm, *Cortex-A Series Programmer's Guide for ARMv8-A* (DEN0024A), chapter 11, "Caches": a gentle
  walk through the same ideas with pictures.
- `man 3 sys_icache_invalidate` on your Mac (the page also covers `sys_dcache_flush`).

## Checkpoint

You can now explain the puzzle: the store reached the data side, `CTR_EL0.DIC = 0` left a stale
line on the instruction side, and `IC IVAU` plus barriers, through `sys_icache_invalidate`, removed
it. Verify it with the program from the start of this primer:

```sh
./stale maintain
```

```text
0 of 1000 calls ran the old instruction
```

**What's next.** Chapter 13 copies a real Linux kernel into guest RAM and starts it with the MMU
off. You know why `booting.rst` asks for a clean to PoC, and why macvmm, on measured evidence,
does not issue one.

**One open question.** Experiment 1 passed on every run we tried. How many passing runs would it
take to convince you that a cache hazard is absent, rather than rare? A hint for thinking about
it: passing runs are absence of evidence, not evidence of absence. Races that depend on timing can
need conditions a quiet test never creates, such as other cores evicting lines under heavy load,
or a much larger window than 16 MiB. Ask what a run under load, or a test designed to make the
hazard likely (like `stale.c`'s warm-up), would add, and why the architecture's permission is the
real reason macvmm records this as "measured on one platform" rather than "safe".
