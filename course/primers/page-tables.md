---
title: Page tables: stage-1 translation
slug: page-tables
kind: primer
minutes: 30
required_by: [05]
objectives:
- Split a 64-bit virtual address into its level indices and page offset for a 4 KiB or 16 KiB granule, by hand or with shell arithmetic.
- Walk a virtual address through a three- or four-level table by hand, naming every descriptor read and the physical address it produces.
- Decode a stage-1 descriptor: valid, table versus block versus page, output address, AttrIndx, AP, SH, AF, PXN and UXN.
- Say which of TTBR0_EL1 and TTBR1_EL1 translates a given address, and compute the virtual address size from TCR_EL1.T0SZ.
- Explain what changes when SCTLR_EL1.M turns the MMU on, and why the code that does it must be identity-mapped.
- Explain why a device register must be Device memory and not Normal memory, and decode a MAIR_EL1 byte.
labs: [two-stage-walker]
---

# Same address, two values

Here is a twelve-line C program that asks a question you might not have thought to ask. It
forks, the child changes a global variable, and then both processes print the variable's address
and its value.

`same.c`

```c
#include <stdio.h>
#include <unistd.h>
#include <sys/wait.h>

int counter = 1;

int main(void) {
    if (fork() == 0) {          /* child */
        counter = 2;
        printf("child:  &counter = %p, counter = %d\n", (void *)&counter, counter);
        return 0;
    }
    wait(NULL);                 /* parent: let the child print first */
    printf("parent: &counter = %p, counter = %d\n", (void *)&counter, counter);
    return 0;
}
```

> **Predict.** Will the two lines print the same address? If they do, how can they print different values?

```sh
cc -O0 -o same same.c
./same
```

On an M5 Pro running macOS 27.2 this printed:

```text
child:  &counter = 0x102450000, counter = 2
parent: &counter = 0x102450000, counter = 1
```

The address differs from run to run (macOS places programs at a random offset each time it starts
them), but within one run the two lines always agree: same address, different values. One
address cannot hold two numbers. So `0x102450000` is not an address in RAM at all. It is a name
that each process looks up somewhere, and the two lookups give different answers.

That lookup is the subject of this primer. Chapter 05 builds a virtual machine whose guest does
these lookups with its own tables, and then has the hardware look up the answer a *second* time
in tables we control. You cannot follow the second lookup until the first one is in your fingers.

:::objectives
- Split a virtual address into level indices and a page offset for a 4 KiB or 16 KiB granule.
- Walk an address through a three- or four-level table by hand.
- Decode a stage-1 descriptor's fields.
- Pick TTBR0_EL1 or TTBR1_EL1 for an address, and compute the address size from T0SZ.
- Explain what turning the MMU on changes, and why that code must be identity-mapped.
- Explain why a device register is Device memory, and decode a MAIR_EL1 byte.
:::

:::prereqs
- `os-basics`: what a kernel, a process, a virtual address and a page are.
- `aarch64-reading`: hexadecimal, bit numbering, and what a register and an exception level are.
  You do not need to read assembly fluently; the one fragment below is explained line by line, and
  no self-check question depends on it.
:::

**Two ideas to carry from the start.** First, `[hi:lo]` means "bits `hi` down to `lo`, inclusive":
bits `[11:0]` are the low twelve bits of a number, and bit 0 is the least significant. Second, this
primer is about the translation a kernel sets up for its own programs. Arm calls that **stage 1**.
Inside a virtual machine there is a second translation underneath it, **stage 2**, owned by the
hypervisor; the last section introduces it, and until then you can ignore it.

## A table that is too big to exist

The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer drew a page table as a lookup:
cut the address into a **page number** and an **offset** within the page, look the page number up
to find a physical page, and glue the offset back on. The address a program uses is a **virtual
address** (VA); the address the memory chips see is a **physical address** (PA). The hardware unit
that does the lookup on every load, store and instruction fetch is the **memory management unit**
(MMU).

Try to build that lookup as one flat array and it falls over. AArch64 lets a program use up to 48
bits of address (52 with optional extensions, which this course does not use). With 4 KiB pages the low 12 bits are the offset, which leaves 36 bits of page
number: 2^36 entries of 8 bytes each is 512 GiB of table, per process. Your Mac does not have 512
GiB of RAM, and almost all of that table would say "nothing here".

The fix is the same one a filing cabinet uses. Instead of one enormous list, split the page
number into pieces and use each piece to pick a drawer, then a folder, then a sheet. A drawer
that holds nothing needs no folders inside it. The cabinet analogy breaks in one useful place:
every drawer, folder and sheet here is the same size, exactly one page, so a table at any level
can live in any free page of RAM.

With a 4 KiB page and 8-byte entries, one page holds 512 entries, and 512 is 2^9. So each piece of
the page number is 9 bits wide, and 36 bits of page number make four pieces:

```text
 63      48 47     39 38     30 29     21 20     12 11          0
+----------+---------+---------+---------+---------+-------------+
| all 0 or |  L0 idx |  L1 idx |  L2 idx |  L3 idx | page offset |
|  all 1   |  9 bits |  9 bits |  9 bits |  9 bits |   12 bits   |
+----------+---------+---------+---------+---------+-------------+
```

*A 48-bit VA with a 4 KiB granule: four 9-bit indices, one per level, then the offset.*

Each piece indexes one **level** of the tree; Arm numbers them level 0 (the root) to level 3 (the
leaves). The page size a set of tables uses is its **granule**, which the
[`page-granules`](/build-your-own/vmm/primers/page-granules/) primer covers: 4 KiB, 16 KiB or 64
KiB. Change the granule and the arithmetic changes with it. A 16 KiB table holds 2,048 entries,
so each index is 11 bits and the offset is 14 bits.

> **Try it.** Your Mac uses the 16 KiB granule for your programs. Confirm the page size and the
> number of address bits a process gets:
>
> ```sh
> pagesize
> sysctl machdep.virtual_address_size
> ```
>
> On the reference machine this prints `16384` and `machdep.virtual_address_size: 47`. Now
> 14 + 11 + 11 + 11 = 47: a 47-bit address with a 16 KiB granule fits in exactly three levels, so
> each lookup reads three table entries, not four. The levels keep their numbers from the leaf
> up: level 3 is always the last, so with fewer address bits the walk simply starts at a higher
> level number, here level 1 (a full 48 bits would add a level 0 holding just bit 47). Split your own `&counter` (paste your address
> over `0x102450000`):
>
> ```sh
> va=0x102450000
> printf "L1=%d L2=%d L3=%d offset=0x%x\n" $(( (va >> 36) & 0x7ff )) $(( (va >> 25) & 0x7ff )) $(( (va >> 14) & 0x7ff )) $(( va & 0x3fff ))
> ```
>
> For `0x102450000` this prints `L1=0 L2=129 L3=276 offset=0x0`. The offset is zero because the
> linker put `counter` at the very start of its page; try `&main` instead and look for a
> non-zero offset.

## Walking the tree by hand

The hardware's lookup is called a **translation table walk**. It needs one more fact before it
can start: where the root table is. That address lives in a system register, a register that
controls the CPU rather than holding program data. For the lower half of the address space the
register is `TTBR0_EL1`, the **Translation Table Base Register 0**. The `_EL1` suffix names an
**exception level**, Arm's word for a privilege level: **EL0** runs applications, **EL1** runs the
kernel, and **EL2** runs a hypervisor, the program that hosts virtual machines (more in
[`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/)). `TTBR0_EL1` belongs to the
kernel's level.

Every entry the walk reads is an 8-byte **descriptor**. The walk repeats the same three steps at
each level:

1. Take this level's index from the VA and read the descriptor at `table_base + index * 8`.
2. If the descriptor is invalid, stop with a fault.
3. If it points to a next-level table, make that the new `table_base` and go down one level.
   If it maps memory, stop: the output address plus the remaining low VA bits is the PA.

Let us walk a real one. A guest kernel with a 4 KiB granule and 48-bit addresses loads from VA
`0x0000_0080_8060_4567`. First split it:

```sh
va=0x0000008080604567
printf "L0=%d L1=%d L2=%d L3=%d offset=0x%x\n" $(( (va >> 39) & 0x1ff )) $(( (va >> 30) & 0x1ff )) $(( (va >> 21) & 0x1ff )) $(( (va >> 12) & 0x1ff )) $(( va & 0xfff ))
```

```text
L0=1 L1=2 L2=3 L3=4 offset=0x567
```

Suppose `TTBR0_EL1` holds `0x4010_0000` and the kernel has filled in these four descriptors. Every
table fills exactly one 4 KiB page and starts on a page boundary, so a table's address always ends
in twelve zero bits. That frees a descriptor's low twelve bits for flags: read a table descriptor
like `0x4010_1003` as "address `0x4010_1000`, flags `0x003`", where `0x3` (binary `11`) means
"valid, and it points to a table". For now take the values on trust; the next section decodes
every bit, including the `0x703` and `0x0060...` of the last row.

| Level | Table base | Index | Descriptor read at | Descriptor value | Meaning |
|---|---|---|---|---|---|
| 0 | `0x4010_0000` | 1 | `0x4010_0008` | `0x0000_0000_4010_1003` | table at `0x4010_1000` |
| 1 | `0x4010_1000` | 2 | `0x4010_1010` | `0x0000_0000_4010_2003` | table at `0x4010_2000` |
| 2 | `0x4010_2000` | 3 | `0x4010_2018` | `0x0000_0000_4010_3003` | table at `0x4010_3000` |
| 3 | `0x4010_3000` | 4 | `0x4010_3020` | `0x0060_0000_4123_4703` | page at `0x4123_4000` |

*Four reads, each at the previous level's table plus eight times this level's index.*

The level 3 descriptor maps a 4 KiB page at `0x4123_4000`. Glue the offset back on and the load
reads physical address `0x4123_4567`. That is the whole algorithm. Notice that the walk read four
descriptors from memory before it could perform the one load the program asked for. Hold on to
that cost; it comes back twice.

Now the puzzle resolves. Each process has its own tree, and the kernel writes that process's root
into `TTBR0_EL1` whenever it switches to it. After `fork`, parent and child have the same VA
`0x102450000`, but different roots, so their level 3 descriptors point at different physical
pages. (The kernel shares the page until one of them writes, then copies it, which is why the
child's store did not reach the parent.)

## What a descriptor says

A descriptor is a 64-bit word of bit fields. Bit 0 says whether it is **valid**. Bit 1 says what
kind it is, and the answer depends on the level:

| Bits `[1:0]` | Levels 0 to 2 | Level 3 |
|---|---|---|
| `x0` | invalid: fault | invalid: fault |
| `11` | **table**: points to the next level | **page**: maps one granule |
| `01` | **block**: maps a large region (levels 1 and 2) | reserved: treated as invalid |

A **block** descriptor stops the walk early. At level 2 with a 4 KiB granule it maps 2 MiB in one
entry, and at level 1 it maps 1 GiB; the bits the skipped levels would have indexed become part
of the offset. If our level 2 entry above had been the block `0x0060_0000_4120_0701` instead, the
walk would stop there. The offset is now everything level 3 would have indexed plus the old page
offset: 9 + 12 = 21 bits, and 2^21 = 2 MiB = 512 × 4 KiB, which is why a level 2 block is 2 MiB.
The mask for 21 bits is `0x1f_ffff`, so the PA is `0x4120_0000 + (va & 0x1f_ffff) = 0x4120_4567`.
Level 0 never holds a block in the 48-bit configurations this course uses: one entry there would
cover 512 GiB, and the architecture does not allow a block that large.

A table descriptor carries the next table's address in bits `[47:12]` for a 4 KiB granule
(`[47:14]` for 16 KiB, whose tables are 16 KiB-aligned). A block or page descriptor (together
called **leaf** descriptors) carries the **output address** in the same bits, and wraps it in
attributes that say what the access may do. Here is our level 3 descriptor taken apart:

```text
 0x0060_0000_4123_4703
   |         |       |
   |         |       +-- 0x703 = AF(10)=1  SH(9:8)=11  AP(7:6)=00  AttrIndx(4:2)=0  type(1:0)=11
   |         +---------- output address [47:12] = 0x4123_4000
   +-------------------- bit 54 UXN=1, bit 53 PXN=1
```

*Low bits say how the memory behaves; high bits say who may execute it.*

- **AttrIndx** (bits 4:2) picks the memory type, from a table we meet in the attributes section.
- **AP** (bits 7:6), access permissions: `00` read-write for EL1 and nothing for EL0; `01`
  read-write for both; `10` read-only for EL1; `11` read-only for both.
- **SH** (bits 9:8), shareability: which other CPU cores the hardware must keep in agreement
  about this memory's cached contents. `11` ("Inner Shareable") means all the cores of one
  machine, the usual choice for RAM. You will not need the other values.
- **AF** (bit 10), the access flag. If it is 0, the first access faults so the kernel can learn
  that the page was used (useful for deciding which pages to move out to disk when RAM runs low).
- **PXN** and **UXN** (bits 53 and 54) forbid instruction fetches at EL1 and EL0. Our page is
  kernel data, so neither may execute it.

Table descriptors can also restrict everything below them through their top bits (`PXNTable`
and `UXNTable` forbid execution, `APTable` removes write or EL0 access), which is how a kernel
makes a whole subtree non-executable with one write. Our example tables leave those bits at 0.

> **Security.** Every value in this section is written by the guest kernel, and from chapter 21 on
> our VMM walks the guest's tables itself to find the instruction that faulted. A hostile guest
> chooses every descriptor: a table address outside RAM, one pointing into a device window, an
> output address past the end of memory, a `T0SZ` no real kernel would use. The walker reads every
> descriptor through bounds-checked `GuestMemory`, treats a bad one as a fault for the *guest*,
> and stops after the architecture's maximum number of levels. A tree cannot loop in hardware
> because each step goes down a level; a careless software walker that follows pointers without
> counting levels can.

## Two halves, and how big each one is

Look again at the top of the address split: bits `[63:48]` must be **all 0 or all 1**. AArch64
gives each EL1 address space two trees. Addresses whose top bits are all 0 are translated through
`TTBR0_EL1`; addresses whose top bits are all 1 go through `TTBR1_EL1`. An address that passes
this test is called **canonical**; anything else faults without a walk. One exception: when
`TCR_EL1`'s Top Byte Ignore bit (`TBI0` or `TBI1`) is set, bits `[63:56]` are left out of the
check and the walk, so software can keep a tag in the top byte of a pointer. Linux sets it for user
programs, and it is how tagged pointers (HWASan, memory tagging, Apple's pointer authentication)
coexist with translation.

```text
0xFFFF_FFFF_FFFF_FFFF  +------------------+
                       |  TTBR1 region    |  kernel: shared by every process
0xFFFF_0000_0000_0000  +------------------+
                       |   (fault: not    |
                       |   canonical)     |
0x0000_FFFF_FFFF_FFFF  +------------------+
                       |  TTBR0 region    |  one process: switched on every context switch
0x0000_0000_0000_0000  +------------------+
```

*Two roots, two halves: the kernel's half stays put while the process half changes.*

That is why Linux kernel addresses start with `0xffff` and user addresses with `0x0000`, and why
the macOS pointer in our puzzle, `0x1_0245_0000`, is a lower-half address. A context switch
changes only `TTBR0_EL1`; the kernel's half never moves.

How many bits each half has, and which granule it uses, is set in `TCR_EL1`, the **Translation
Control Register**. Only `T0SZ` matters right now; the table is reference for later (the lab and
chapter 21's walker read the other fields), so skim it and come back:

| Field | Bits | Meaning |
|---|---|---|
| `T0SZ` | `[5:0]` | lower half is `64 - T0SZ` bits: `16` gives 48 bits, `17` gives 47, `25` gives 39 |
| `TG0` | `[15:14]` | lower-half granule: `00` 4 KiB, `10` 16 KiB, `01` 64 KiB |
| `T1SZ`, `TG1` | `[21:16]`, `[31:30]` | the same for the upper half; **`TG1` uses different codes**: `10` 4 KiB, `01` 16 KiB, `11` 64 KiB |
| `IPS` | `[34:32]` | how many bits of output address the walk may produce: `001` 36 bits, `010` 40 bits, `101` 48 bits |

The `TG0`/`TG1` mismatch is not a typo in this table; it is a real trap in the architecture, and
every walker gets it wrong once.

The address size also decides how many levels the walk has. With a 4 KiB granule, 48 bits need
four levels (9 + 9 + 9 + 9 + 12), but 39 bits (`T0SZ = 25`) need only three, starting at level 1.
That three-level shape is a real Linux configuration, and it is the shape of the toy table the
lab starts you on. The 16 KiB, 47-bit layout of your Mac's own processes is three levels too.

> **Aside.** The `IPS` field is named for the **intermediate physical address** (IPA) because in
> a virtual machine the "physical" address that stage 1 produces is not physical at all. Arm
> named the field for the general case. Keep that thought; it is the whole of the last section.

## Caching the walk, and changing the tree

Four memory reads for every load would make a CPU four times slower. So the MMU remembers recent
answers in a small cache called the **translation lookaside buffer** (TLB), and most accesses
never walk at all. The cost is a duty: when the kernel changes a descriptor, the TLB may still
hold the old answer. Three instructions do the cleanup:

- `TLBI` (TLB invalidate) throws away cached translations, for one address or for all of them.
- `DSB` (data synchronization barrier) waits until earlier memory writes and TLB maintenance have
  finished everywhere they need to.
- `ISB` (instruction synchronization barrier) makes the CPU discard instructions it has already
  fetched ahead, so the ones after it run with the new state.

The order is: write the new descriptor, `DSB` (so the walker can see the write), `TLBI`, `DSB`
(wait for the invalidation to finish), `ISB`. Leave out the first `DSB` and the old translation can
be refetched from the old descriptor right after it was invalidated. The
[`memory-ordering`](/build-your-own/vmm/primers/memory-ordering/) primer explains barriers
properly. TLB entries are also tagged with an **address space identifier** (ASID), a small number
the kernel gives each process, so switching processes does not have to throw the TLB away. The
ASID is held in the top bits of `TTBR0_EL1` or `TTBR1_EL1` (`TCR_EL1.A1` picks which; Linux uses
`TTBR1_EL1`), and is 8 or 16 bits wide depending on `TCR_EL1.AS`.

## Turning the MMU on

None of this happens until software asks for it. At reset, translation is **off**: bit 0 of
`SCTLR_EL1` (the **System Control Register**, field `M`) is 0. With the MMU off, stage 1 does no
walk at all. Every VA is used as the PA unchanged, nothing is checked for permission, and every
data access is treated as the strictest kind of Device memory (the next section explains what
that means; instruction fetches are treated as Normal memory). One visible consequence: an
unaligned load or store to Device memory always takes an alignment fault, so with the MMU off an
unaligned access faults even though alignment checking (`SCTLR_EL1.A`) is off.

Linux's boot protocol (`Documentation/arch/arm64/booting.rst`) requires the kernel to be entered
with the MMU off, and so do our own test guests in chapter 03. The kernel turns it on itself, in a
sequence like this one.

Fragment (illustrative arm64 assembly, not part of macvmm; `x0` to `x2` already hold the values).
You need three mnemonics: `msr` writes a system register from a general register, `mrs` reads one,
and `orr` is bitwise OR. Text after `//` is a comment. The self-check does not depend on reading
this.

```asm
    msr   mair_el1, x0        // the memory-type palette (next section)
    msr   tcr_el1, x1         // sizes and granules
    msr   ttbr0_el1, x2       // root of the lower-half tree
    tlbi  vmalle1             // forget any stale translations
    dsb   nsh
    isb                       // the register writes take effect here
    mrs   x3, sctlr_el1
    orr   x3, x3, #1          // M = 1: stage-1 translation on
    msr   sctlr_el1, x3
    isb                       // the very next fetch is translated
```

The surprising line is the last `isb`. The instruction after it is fetched through the new
tables, at the same PC (program counter, the address of the next instruction) as before. If the tables do not map that VA to the PA where the code
actually sits, the CPU fetches garbage or faults, and nothing can recover, because the fault
handler is not mapped either. So the page that turns the MMU on must be **identity-mapped**:
VA equal to PA. Kernels build a small identity map for exactly these few instructions, jump to
their real high address in the `TTBR1` half, and then discard it.

## Memory attributes: why a device is not RAM

You may have assumed a store is a store. It is not, and the reason is the most important idea in
this primer for chapter 05.

First, a word about caches. RAM is slow next to the CPU, so each core keeps small, fast copies of
recently used memory in **caches**. The ones closest to a core are its **inner** caches; the bigger
shared ones further out are **outer**. A **write-back** cache holds a store and writes it to RAM
later, which saves trips but means RAM can be briefly out of date.

To a CPU, ordinary RAM is forgiving. Reading it twice gives the same answer, and reading it has no
side effects. So the CPU is allowed to read RAM *speculatively* (before the program is sure it
needs the value, because it guessed which way a branch will go), keep copies in its caches, merge two small stores into one larger one, and
reorder accesses to different addresses. This is **Normal** memory, and all of those liberties
are what make it fast.

A device register breaks every one of those assumptions. Reading a UART's data register removes a
byte from its receive queue; reading it twice loses a byte. (A UART is the simplest serial port:
a store to its data register sends a byte, a load returns the next byte received; chapter 09
builds one.) Writing it sends a byte; merging two writes sends one byte instead of two. A
speculative read would consume input the program never asked for. So memory-mapped device
registers are **Device** memory, which forbids speculative reads and caching outright and
restricts the rest through three letters:

- **G**, gathering: may several accesses be merged into one? `nG` forbids it.
- **R**, reordering: may accesses to the same device be reordered? `nR` forbids it.
- **E**, early write acknowledgement: may a buffer on the way say "done" before the device has
  the write? `nE` forbids it.

The four Device types run from strictest, `Device-nGnRnE`, through `nGnRE` and `nGRE`, to the
loosest, `Device-GRE`. Linux maps most device registers as `Device-nGnRE`.

Descriptors do not spell these types out; there is no room. Instead, `MAIR_EL1` (the **Memory
Attribute Indirection Register**) holds a palette of eight one-byte memory types, `Attr0` to
`Attr7`, and each leaf descriptor's 3-bit `AttrIndx` picks one. The bytes you will meet:

| `MAIR_EL1` byte | Memory type |
|---|---|
| `0x00` | Device-nGnRnE |
| `0x04` | Device-nGnRE |
| `0x0C` | Device-GRE |
| `0x44` | Normal, non-cacheable |
| `0xFF` | Normal, write-back cacheable (inner and outer) |

For a Device type the high four bits are `0000` and bits `[3:2]` select nGnRnE, nGnRE, nGRE or
GRE; for Normal memory the high four bits say how the outer caches treat it and the low four how
the inner caches do (`0x4` non-cacheable, `0xF` write-back). Suppose a kernel writes
`MAIR_EL1 = 0x0000_0000_0044_04FF`. Each byte is one palette entry, counting from the right:

| Byte (bits) | `[7:0]` | `[15:8]` | `[23:16]` | `[31:24]` to `[63:56]` |
|---|---|---|---|---|
| Entry | `Attr0` | `Attr1` | `Attr2` | `Attr3` to `Attr7` |
| Value | `0xFF` | `0x04` | `0x44` | `0x00` (unused) |
| Meaning | cacheable RAM | Device-nGnRE | non-cacheable RAM | — |

Our walked descriptor ended in `0x703`, binary `0111_0000_0011`; bits `[4:2]` are `000`, so
`AttrIndx = 0` and it is cacheable RAM. A UART page needs `Attr1`, so `AttrIndx = 1`: bits `[4:2]`
become `001`, which sets bit 2 (value `0x4`), and `0x703 | 0x4 = 0x707`. The descriptor would look
like `0x0060_0000_0900_0707`. The word **cacheability** names this choice of
whether, and how, the caches may hold copies; the
[`caches`](/build-your-own/vmm/primers/caches/) primer (before chapter 13) covers what that means
when two observers see the same RAM through different attributes.

The connection to a virtual machine: a guest kernel marks its UART as Device memory so that each
load and store in its driver reaches the UART exactly once, in order. In chapter 05 we leave the
UART's address unmapped on *our* side, so each of those accesses stops the guest and lands in our
VMM, where software plays the device. Map ordinary RAM there instead and the stores land silently
in memory, and nobody ever prints them.

## The second lookup

Two words first. The **guest** is the operating system running inside our virtual machine. A **VM
exit** is the moment the hardware stops running the guest and hands control back to our VMM
(the host program that runs the VM), along with a record of why.

Everything above happens inside a guest exactly as it does on bare metal: the guest kernel
writes its own `TTBR0_EL1`, `TCR_EL1` and `MAIR_EL1`, builds its own tables, and turns on its own
MMU. Hypervisor.framework (HVF) does not intercept any of it. What changes is what the output of
the walk means. Inside a VM, the "physical" address the guest's tables produce is an **IPA**
(intermediate physical address), and
the hardware translates it a second time through tables that HVF owns and our VMM fills with
`hv_vm_map`. The guest's walk is **stage 1**; HVF's is **stage 2**.

```text
   guest (untrusted)                       |   host (HVF + our VMM)
                                           |
   VA --[stage 1: guest's tables]--> IPA --|--[stage 2: HVF's tables]--> host PA
        TTBR0/1_EL1, TCR_EL1, MAIR_EL1     |       filled by hv_vm_map
        faults go to the guest kernel      |       faults become VM exits for us
```

*Two walks, two owners: the trust boundary runs between them.*

That split decides who hears about a fault. When the guest's own walk fails (an invalid
descriptor, a missing access flag, a write to a read-only page), the CPU takes the exception at
EL1, inside the guest. The guest kernel's handler reads the reason from `ESR_EL1` (the
**Exception Syndrome Register**) and the faulting VA from `FAR_EL1` (the **Fault Address
Register**), maps the page or kills the process, and our VMM never knows it happened. Only when
stage 2 fails does the exception go to EL2, where HVF turns it into a VM exit. HVF hands us the
faulting IPA in the exit record's `physical_address` field (the hardware records it in an EL2
register, `HPFAR_EL2`, and HVF copies it out), so chapter 05 learns which address the guest
touched without ever reading the guest's tables.

> **Under the hood (optional).** Each descriptor address in a stage-1 walk is itself an IPA, so the hardware
> must translate it through stage 2 before reading it. A four-level stage-1 walk over a four-level
> stage 2 can therefore take (4 + 1) × (4 + 1) - 1 = 24 memory reads for one guest load: five
> stage-2 walks of four reads each (four descriptor fetches and the final data address), plus the
> four stage-1 descriptors. The TLB caches the combined VA to host PA answer, which is what makes
> this affordable. If stage 2 fails while fetching a *descriptor*, the syndrome says so with the
> `S1PTW` bit ("stage 1 page table walk"), which chapter 21's walker has to respect.

## Lab

:::lab two-stage-walker

In the [`two-stage-walker`](/build-your-own/vmm/labs/two-stage-walker/) lab (stage-1 mode) you
start from the worked example above, already filled in, then a three-level toy table (4 KiB
granule, 39-bit addresses). For each level you predict the index and the descriptor address
before the lab reveals them, then follow the arrow to the next table. You flip a descriptor's
valid bit, its access flag and its `AP` bits and watch the walk fail at a named level with the
fault the hardware would report. A granule toggle switches stage 1 between 4 KiB and 16 KiB so
you can see the index widths change. Chapter 05 then turns on stage 2 in the same lab, with its
own granule set separately.

## Self-check

Commit to an answer before you open each one.

:::predict With a 4 KiB granule and 48-bit addresses, what are the four indices and the offset of VA `0x0000_0000_4020_3004`?
L0 = 0, L1 = 1, L2 = 1, L3 = 3, offset = `0x004`. Write the address as a sum of place values: `0x4020_3004 = 0x4000_0000 + 0x20_0000 + 0x3000 + 0x4`. `0x4000_0000` is 2^30, so L1 = 1 and nothing reaches bit 39 (L0 = 0). `0x20_0000` is 2^21, so L2 = 1. `0x3000` is 3 × 2^12, so L3 = 3. `0x4` is the offset. Check it with the shell arithmetic from the walking section.
:::

:::predict A level 2 descriptor's low two bits are `01`, with a 4 KiB granule. How much memory does it map, and how many more descriptors does the walk read?
It is a block descriptor: it maps 2 MiB, and the walk reads no more descriptors. The VA bits `[20:0]` that level 3 would have indexed become the offset within the block. The same bits at level 3 would be reserved and fault as invalid.
:::

:::predict `TCR_EL1.T0SZ` is 25. How many bits does the lower half have, and at which level does a 4 KiB walk start?
64 - 25 = 39 bits. 39 = 12 + 9 + 9 + 9, so the walk needs three levels and starts at level 1. An address whose bits `[63:39]` are neither all 0 nor all 1 is not canonical: it is outside both halves and faults without a walk (bits `[63:56]` excepted when Top Byte Ignore is on).
:::

:::predict A guest kernel maps its UART with `AttrIndx` pointing at a `MAIR_EL1` byte of `0xFF`. What could go wrong, even before any VMM gets involved?
`0xFF` is Normal, write-back cacheable memory. The CPU may then read the data register speculatively (losing received bytes), hold stores in its cache or merge them (so bytes reach the device late, merged, or never), and reorder them. A device register needs a Device type such as `0x04` (Device-nGnRE) so every access happens exactly once, in program order.
:::

:::predict A guest process touches a page its kernel has not mapped yet. Does our VMM see a VM exit?
No. The guest's stage-1 walk finds an invalid descriptor, so the CPU raises a translation fault at EL1, inside the guest. The guest kernel handles it with `ESR_EL1` and `FAR_EL1`. Our VMM only hears about faults in stage 2, the tables HVF owns.
:::

:::predict Why must the code that sets `SCTLR_EL1.M` be identity-mapped?
Because the instruction after the final `ISB` is fetched through the new tables at the unchanged PC. If that VA does not translate to the PA where the code already sits, the CPU fetches the wrong bytes or faults with no mapped handler to run.
:::

## Where this shows up in macvmm

- **[05 `address-space`](/build-your-own/vmm/memory/address-space/)** opens by redrawing this
  primer's last diagram, then explains why stage 2 exists (without it, every guest page-table
  write would have to trap) and why device windows are stage-2 holes left on purpose. The machine
  layout lives in `crates/vmm/src/arch/layout.rs`.
- **[06 `vcpu-state`](/build-your-own/vmm/cpu/vcpu-state/)** sets `SCTLR_EL1` at reset with
  `M = 0`, so a fresh guest runs with VA equal to IPA, exactly the MMU-off rules above.
- **[21 `firmware`](/build-your-own/vmm/firmware/firmware/)** writes a bounded stage-1 walker
  (`crates/vmm/src/arch/stage1_walk.rs`) to find the instruction behind an exit the hardware could
  not decode: 4 KiB and 16 KiB granules, both `TTBR` halves, blocks and pages, and every hostile
  descriptor treated as a guest fault.
- **[27 `debug-perf`](/build-your-own/vmm/production/debug-perf/)** reuses that walker so a
  debugger can read guest memory by virtual address.

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487), chapter D8
  "The AArch64 Virtual Memory System Architecture" (chapter D5 in issues before J.a), in
  particular "Translation table descriptor formats"; the register pages for `TCR_EL1`,
  `TTBR0_EL1`, `MAIR_EL1` and `SCTLR_EL1`; and Part B, "Memory types and attributes", for Device
  memory and its G, R and E attributes. The
  [`reading-arm-specs`](/build-your-own/vmm/primers/reading-arm-specs/) primer shows how to find
  your way around it.
- Arm, *Learn the architecture: AArch64 memory management* (document 101811) and *Learn the
  architecture: AArch64 memory attributes and properties* (document 102376): the gentlest
  official walk-through of this primer's two halves.
- Linux, `Documentation/arch/arm64/memory.rst` (the kernel's real virtual memory layouts for each
  granule and address size) and `Documentation/arch/arm64/booting.rst` (why the kernel is entered
  with the MMU off).

## Checkpoint

You can now take any arm64 virtual address apart and follow it to memory. To verify, run the
split from the walking section and compare:

```sh
va=0x0000008080604567
printf "L0=%d L1=%d L2=%d L3=%d offset=0x%x\n" $(( (va >> 39) & 0x1ff )) $(( (va >> 30) & 0x1ff )) $(( (va >> 21) & 0x1ff )) $(( (va >> 12) & 0x1ff )) $(( va & 0xfff ))
```

```text
L0=1 L1=2 L2=3 L3=4 offset=0x567
```

Then, without looking, rebuild the four-row walk table from `TTBR0_EL1 = 0x4010_0000` and
explain why the result is `0x4123_4567`. If you can, you are ready for chapter 05.

**What's next.** Chapter 05 gives the guest's IPAs a second, hardware-walked lookup that we
control, and then deliberately leaves holes in it. You will find out why a hole is the most
useful thing a VMM can put at a device's address.

**One open question (a teaser for chapter 05).** The guest writes its own page tables into RAM
we gave it, and we never read them. If the hardware had no stage 2, the guest's tables would have
to produce real host addresses, so the VMM could not let the guest write them directly. Hint: think
about making every page-table page read-only and trapping each write. What would the VMM then have
to do on every one of those traps?
