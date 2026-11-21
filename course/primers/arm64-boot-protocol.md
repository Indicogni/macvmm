---
title: The arm64 boot protocol
slug: arm64-boot-protocol
kind: primer
minutes: 25
required_by: [06]
labs: [image-inspector]
---

# What does a kernel expect on its first instruction?

Here is a boot plan that sounds perfectly reasonable. Put the Device Tree (a few KiB file that
describes the machine to the kernel; more on it below) at the start of guest RAM, `0x4000_0000`.
Copy the kernel file right after it, at `0x4000_1000`, so no space is wasted. Put the initramfs
(a small in-memory filesystem the kernel unpacks at boot) right after the kernel file's last
byte. Unmask interrupts (an interrupt is hardware tapping the CPU on the shoulder, for example
the timer saying "time's up") so the timer can tick from the start. Point the PC (the program
counter, the address of the next instruction) at the kernel and run.

That plan has four bugs, and none of them is a typo. Each one breaks a promise the kernel was
counting on before it ran a single instruction. By the end of this primer you will be able to
find all four, and you will know where the promises are written down.

:::prereqs
- Exception levels, PSTATE and the exception vector table ([chapter 02](../../bare-machine/first-exit/))
- [`aarch64-reading`](../aarch64-reading/): registers `x0` to `x30`, `pc`, system registers, byte order
- [`page-tables`](../page-tables/): what turning the MMU on and off means
:::

Three words from earlier chapters carry this whole primer, so here they are again. A
[**VMM**](/build-your-own/vmm/glossary/#vmm) (virtual machine monitor) is the program that builds
a pretend computer and runs a [**guest**](/build-your-own/vmm/glossary/#guest) operating system
inside it; ours is macvmm. A [**vCPU**](/build-your-own/vmm/glossary/#vcpu) is one virtual CPU of
that computer, whose registers the VMM can set before letting it run. **Guest RAM** is an ordinary
buffer in the VMM's process that the guest sees as its physical memory, starting at address
`0x4000_0000`. Apple's [**Hypervisor.framework**](/build-your-own/vmm/glossary/#hvf) (HVF) is the
library that lets macvmm do all of this.

:::objectives
- State the four entry conditions a primary CPU must meet (`x0` to `x3`, DAIF masked, EL1 or EL2, MMU off) and give the CPSR value that encodes EL1h with DAIF masked.
- Explain in two sentences, using the stale-byte example, why Linux wants the MMU off and the kernel image cleaned to the Point of Coherency at entry.
- Decode the 64-byte arm64 Image header from a hex dump, including the flags field.
- Compute where the kernel, DTB and initramfs go in RAM, and name the `booting.rst` rule behind each address.
- Say which part of this primer chapters 06, 10 and 13 each rely on.
:::

## Somebody has to start the kernel

A kernel cannot start itself. When it runs its first instruction, something else has already
been at work: memory exists, the kernel's bytes are sitting in it, and the CPU's registers hold
particular values. The kernel has no way to check most of this. It *assumes*.

Whatever software ran before the kernel and set the stage is called the **boot loader**. On a
physical Arm board that is usually firmware followed by a program like U-Boot. In macvmm, for
most of the course, the boot loader is *us*: the VMM writes the kernel into guest memory, sets
the vCPU's registers through Hypervisor.framework and starts it. This is called **direct kernel
boot**. In chapter 21 U-Boot takes the role back, and our VMM only starts the firmware.

The assumptions are not folklore. Linux writes them down in one short file,
`Documentation/arch/arm64/booting.rst`. It is a contract: the boot loader's half is a list of
"must"s, and the kernel's half is "then I will boot". We call it the **arm64 boot protocol**.
The document has four numbered sections, and we will cite them as `booting.rst` §1 to §4:

1. Setup and initialise RAM.
2. Setup the device tree.
3. Decompress the kernel image.
4. Call the kernel image (the header, placement and CPU state live here).

Section 3 is short and has a sting: the arm64 kernel has no decompressor of its own, so the boot
loader must hand over a raw, uncompressed `Image`. That is why chapter 13 unwraps Alpine's
compressed kernel on the host first.

## Which parts you need, and when

You are probably reading this before chapter 06, and you do not need all of it yet. This primer
is written to be read once, start to finish, but here is what each chapter leans on:

| Chapter | Needs | Sections of this primer |
|---|---|---|
| 06 `vcpu-state` | CPU mode, DAIF, MMU and caches off | "The CPU state at entry" |
| 10 `device-tree` | `x0` holds the DTB's address | "Four registers, one pointer" |
| 13 `loaders` | Everything: the Image header, placement, the full entry state | All of it |

If you are short on time before chapter 06, read the next two sections carefully and skim the
rest. Come back before chapter 13.

The whole hand-off fits in one picture. Notice that every arrow comes from the boot loader; the
kernel does nothing until the very last step.

:::diagram src=docs/diagrams/boot-handoff.svg alt="The boot hand-off: the VMM fills guest RAM, sets vCPU 0 registers, then runs it"

*The boot loader prepares memory and registers, then lets go. The trust boundary is the last
arrow: from there on, guest code runs.*

## The CPU state at entry

`booting.rst` §4 lists the CPU state under "Before jumping into the kernel". Three items matter
for chapter 06: the exception level, the interrupt masks, and the MMU and caches.

### Exception level and interrupt masks

The rule reads: "All forms of interrupts must be masked in PSTATE.DAIF (Debug, SError, IRQ and
FIQ). The CPU must be in non-secure state, either in EL2 (RECOMMENDED in order to have access to
the virtualisation extensions), or in EL1."

Why mask everything? Think about what an interrupt does (chapter 02): the CPU saves where it was
and jumps into the [**exception vector table**](/build-your-own/vmm/glossary/#exception-vector-table),
the kernel's table of "where to jump when an interrupt or fault happens". The table's address
lives in the register [`VBAR_EL1`](/build-your-own/vmm/glossary/#vbar). At entry, the kernel has
not yet written `VBAR_EL1`. It holds whatever the boot loader left there, quite possibly 0. An
interrupt in the first few microseconds would send the CPU into nowhere. Masking all four kinds
means nothing can interrupt the kernel until it has installed its own vector table and decides
to unmask.

Why EL1 or EL2 but never EL3 or EL0? An
[**exception level**](/build-your-own/vmm/glossary/#el0-el1-el2-el3) (EL) is Arm's name for a
privilege level, and there are four:

- **EL0** runs ordinary apps. It cannot run a kernel.
- **EL1** runs an operating system kernel.
- **EL2** runs a hypervisor, the layer that hosts virtual machines.
- **EL3** runs the most privileged firmware, the "secure monitor" that switches between the
  normal world and a separate secure world. "Non-secure state" in the rule means "the normal
  world", where ordinary operating systems live.

Linux prefers EL2 because then it can be a hypervisor itself (Linux's built-in hypervisor is
called KVM). On a Mac, macOS and Hypervisor.framework already occupy EL2 and never hand it to a
guest, so macvmm enters the kernel at **EL1**, which the contract allows.

Now the encoding (you met it in chapter 02). **PSTATE** is the CPU's live status: current level,
masks, condition flags. It is not a single register you can read; when the VMM sets or reads it
from outside, it uses its saved form, a 32-bit value Hypervisor.framework calls
[**`CPSR`**](/build-your-own/vmm/glossary/#cpsr-pstate). **DAIF** is just the name for its four
mask bits taken together. `M[3:0]` means "bits 3 down to 0 of the field M" (the mode).

The mode we want is EL1 using EL1's own stack pointer, `SP_EL1`, written
[**EL1h**](/build-your-own/vmm/glossary/#el1h) (`h` for "handler", the level's own stack;
`EL1t` would instead borrow EL0's stack pointer `SP_EL0`). Its code is `M[3:0] = 0b0101`: bits
3:2 say "EL1", bit 0 says "own stack". The four mask bits D, A, I, F are bits 9 to 6. Set them all
and you get `0x3c0`. Combine:

```
  bit:   9 8 7 6   5 4   3 2 1 0
         D A I F   - -   M[3:0]
         1 1 1 1   0 0   0 1 0 1    = 0x3c5   (EL1h, everything masked)

  D = debug exceptions   A = SError (asynchronous memory errors)
  I = IRQ (normal interrupts)   F = FIQ (fast interrupts)
  bits 5:4 = 0: bit 4 = 0 means AArch64 (64-bit) state; bit 5 is unused in AArch64
```

*Read right to left: the low nibble picks the level and stack, the four bits above bit 5 are the
masks. A mask bit set to 1 means "blocked".*

So the value we put in the vCPU's `CPSR` is **`0x3c5`**. You will see this number in every boot
plan from chapter 06 on.

### Why the MMU must be off

The rule: "The MMU must be off." Some background first. The **MMU** (memory management unit)
translates the addresses a program uses (*virtual* addresses) into the addresses where bytes
really sit in RAM (*physical* addresses), by looking them up in **page tables**, tables in memory
that the kernel builds. With the MMU off there is no lookup: the address a program uses *is* the
physical address.

On arm64, "off" means `SCTLR_EL1.M = 0` for an EL1 entry. The notation `REG.FIELD` means "field
FIELD of register REG": here, the `M` bit (bit 0) of the system control register `SCTLR_EL1`.

With the MMU off, every address the CPU uses is a physical address. That is the one view of memory
the boot loader and the kernel are guaranteed to share. If the boot loader had left translation
on, the kernel would be running inside page tables someone else built, at addresses it cannot
predict, with no description of how they were set up. Instead, Linux starts at physical
addresses, builds its own page tables in memory, and turns the MMU on itself, in an order it
controls. (The `page-tables` primer shows what "on" switches.)

### What "cleaned to the PoC" asks for

The caches rule is longer, and it uses two words you have not seen yet:

- "The instruction cache may be on or off, and must not hold any stale entries corresponding to
  the loaded kernel image."
- "The address range corresponding to the loaded kernel image must be cleaned to the PoC."

A **cache** is a small, fast memory next to the CPU that keeps recent copies of RAM. It works in
fixed-size chunks called **cache lines** (typically 64 bytes). There are separate caches for
data the program reads and writes (the **data cache**) and for instructions the CPU fetches (the
**instruction cache**). A *dirty* line is a cached copy that is newer than RAM; **cleaning** it
writes it back to RAM. When the cache runs out of room it **evicts** a line: it throws the line
out, writing it back to RAM first if it was dirty. The **Point of Coherency (PoC)** is the place
where every *observer* of memory (anything that reads it: every CPU, every device, the MMU
reading page tables) is guaranteed to see the same copy; in practice, main memory.

A tiny example shows the danger. The boot loader writes the byte `0x4d` to address `A`. The write
lands in a cache line, which is now dirty; RAM at `A` still holds the old byte, say `0x00`. Anyone
who reads RAM directly, without going through that cache, sees `0x00`.

The kernel is exactly such a reader, because of the MMU rule above: with the MMU off, the
architecture treats every data access as uncached (see "Under the hood" below), so the kernel's
own reads and writes go straight to RAM. Suppose the boot loader copied the kernel through its
cache and never cleaned it. Two things go wrong. The kernel reads RAM and finds old bytes,
because the new ones are still stuck in a cache line. Worse, some time later that dirty line is
evicted and overwrites whatever the kernel has written there since, perhaps a page table. The
symptom appears long after the cause. "Cleaned to the PoC" rules this out: RAM holds the truth
before the first instruction runs.

The instruction-cache rule is the same worry for code, with a different fix. The instruction
cache only ever *reads* copies, so it never holds newer bytes than RAM; its danger is an *older*
copy, an instruction cached from whatever used to sit at the kernel's address. Old copies are not
written back, they are thrown away (**invalidated**), which is why the rule says "must not hold
any stale entries" instead of "cleaned".

That is all chapter 06 needs. The [`caches`](/build-your-own/vmm/primers/caches/) primer, before chapter 13, explains cache lines,
clean versus invalidate and the PoC properly, and shows the experiment that settles what we must
do on Apple Silicon.

> **Under the hood.** "MMU off" does not only switch off translation. With stage 1 disabled, the
> architecture also fixes the memory type: data accesses are treated as Device-nGnRnE (no
> caching, no merging, no reordering), and instruction fetches are Normal memory whose
> cacheability follows `SCTLR_EL1.I`. This is why the kernel's early writes reach memory
> directly. The rules are in the ARM ARM (DDI 0487), chapter D8, "The effects of disabling
> address translation stages on VMSAv8-64 behavior".

How much of this does macvmm have to *do*? Very little, and that is a pleasant surprise. The
next two facts are forward references: you will see them proven later, so take them on trust for
now. A new HVF vCPU starts with `SCTLR_EL1.M = 0`, `C = 0` and `I = 0`, so translation and caching
are already off; in chapter 06 you will run a small test guest, `regcheck`, that prints
`SCTLR_EL1.M=0` to prove it. And this project observed that bytes the host writes into guest memory are visible to a guest running with its
MMU off, with no cache maintenance from us (the `memtest` evidence in the `caches` primer). So
for a VMM, the caches rule is satisfied by the platform, and we confirmed it rather than assumed
it.

> **Production note.** A firmware boot loader has the opposite problem. U-Boot runs with its own
> MMU and caches on, for speed, so before it jumps to Linux it must clean the kernel's range to
> the PoC, then turn its MMU and caches off. That is the cleanup a VMM gets for free from the
> vCPU's reset state, and the reason chapter 21 calls firmware "a stricter guest".

## Four registers, one pointer

The register rule is the shortest part of the contract:

```
x0 = physical address of device tree blob (dtb) in system RAM
x1 = 0   (reserved for future use)
x2 = 0   (reserved for future use)
x3 = 0   (reserved for future use)
```

*The primary CPU's general-purpose registers at entry (`booting.rst` §4).*

Two terms first. `x0` to `x3` are the first four of the 31 **general-purpose registers**
(`x0` to `x30`), the ordinary 64-bit registers that instructions compute with. The **primary
CPU** is the one CPU the boot loader starts; on a machine with several CPUs, all the others, the
**secondary CPUs**, stay parked until the running kernel asks for them.

The **device tree blob (DTB)** is a binary description of the machine: how much RAM there is and
where, how many CPUs, which devices sit at which addresses. Some of this a kernel can find out by
itself: buses such as PCI and USB can be *enumerated*, meaning the kernel asks each slot "who are
you?" and the device answers. But the RAM layout and devices wired at fixed addresses (like our
serial port at `0x0900_0000`) cannot answer anything, so firmware has to describe them. PCs and
Arm servers use firmware tables called ACPI for this; embedded Arm boards, and our VMM, use a DTB. Chapter 10
builds one from scratch. For now, one consequence: `x0` is the kernel's *only* map of the machine.
Without a valid pointer it does not know where its RAM is or where the console is, so it cannot
even complain visibly.

The three zeros are a promise about the future: Linux reserves them for later use. Today's
kernels check them anyway. `setup_arch()` in `arch/arm64/kernel/setup.c` prints
`WARNING: x1-x3 nonzero in violation of boot protocol` and carries on.

Secondary CPUs follow a different path, and you can skip this paragraph until chapter 08. They
stay outside the kernel until it asks for them, using the method the DTB names in each CPU's
entry (a property called `enable-method`). macvmm uses `"psci"`.
[**PSCI**](/build-your-own/vmm/glossary/#psci) is a standard set of firmware calls for powering
CPUs on and off; the kernel makes the call with [**`hvc`**](/build-your-own/vmm/glossary/#hvc),
the instruction a guest kernel uses to call the hypervisor. The kernel asks for `CPU_ON`, and the
VMM starts that vCPU at the address the kernel gave, with the same CPU state rules. That story
belongs to chapters 08 and 20 and the [`smccc`](../smccc/) primer.

## The Image header: 64 bytes that describe the kernel

From here on is chapter 13 material.

The kernel file a boot loader receives is called the **Image** (capital I, and usually a file
literally named `Image`). It is the kernel's raw machine code and data, not a disk image: it has
no filesystem inside. Its first 64 bytes are a header that tells the boot loader how to place it
(`booting.rst` §4).

Every multi-byte field is **little-endian**: the least significant byte comes first in the file.
So the four bytes `4d 5a 40 fa`, read as one 32-bit number, are `0xfa405a4d`: you write them in
reverse order. Two more words used in the table: `stext` is the label of the kernel's real first
line of code, and the [**BSS**](/build-your-own/vmm/glossary/#bss) is the part of a program's
memory for variables that start at zero; the file holds no bytes for it, and the kernel zeroes it
when it starts.

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| `0x00` | 4 | `code0` | An instruction. Execution starts here. |
| `0x04` | 4 | `code1` | An instruction: a branch to the real entry code (`stext`). |
| `0x08` | 8 | `text_offset` | How far above a 2 MiB-aligned base to load the Image. |
| `0x10` | 8 | `image_size` | Bytes the kernel needs from its start, *including* memory not in the file. |
| `0x18` | 8 | `flags` | Endianness, page size, placement policy. |
| `0x20` | 24 | `res2`..`res4` | Reserved, 0. |
| `0x38` | 4 | `magic` | `0x644d5241`, the bytes `ARM\x64`. |
| `0x3c` | 4 | `res5` | Offset of a PE header, used when booting through UEFI firmware (see below). |

*The arm64 Image header. The header is both data and code: the first two fields execute.*

Here are the first 64 bytes of the kernel we boot in chapter 14 (Alpine `linux-virt` 6.18.60,
unwrapped in chapter 13). You will be able to run this yourself once `Image-virt` exists:

```sh
xxd -l 64 .cache/macvmm/Image-virt
```

```
00000000: 4d5a 40fa 27b4 5514 0000 0000 0000 0000  MZ@.'.U.........
00000010: 0000 2a02 0000 0000 0a00 0000 0000 0000  ..*.............
00000020: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000030: 0000 0000 0000 0000 4152 4d64 4000 0000  ........ARMd@...
```

:::predict The magic is supposed to be `ARM\x64`, yet the text column says `ARMd`. Is this kernel broken?
It is not. `\x64` is the byte `0x64`, and `0x64` is the ASCII code for `d`. The magic is a pun:
"ARM64" spelled with three letters and one byte. Read as a little-endian 32-bit number, the bytes
`41 52 4d 64` are `0x644d5241`, exactly what the spec says.
:::

The first two bytes are a second surprise: `MZ` is the signature of a Windows executable (the
PE/COFF format, which UEFI firmware also uses for its programs). The kernel is built to be *two
things at once*. To a plain boot loader, `code0` is a harmless instruction and `code1` branches
to the kernel. To UEFI firmware, the file is a PE/COFF program, and `res5` (`0x40`) points at its
PE header.

We can check the "harmless instruction" claim. You do not need to read the assembly below; the
only point is that the first instruction has no effect that matters and the second is a jump.
These commands put the two words in a tiny object file and ask the Mac's disassembler what they
are (remember the byte reversal: `4d 5a 40 fa` is the word `0xfa405a4d`):

```sh
printf '.inst 0xfa405a4d\n.inst 0x1455b427\n' > hdr.s
clang -target aarch64-none-elf -c hdr.s -o hdr.o
xcrun llvm-objdump -d hdr.o
```

```
       0: fa405a4d     	ccmp	x18, #0x0, #0xd, pl
       4: 1455b427     	b	0x156d0a0 <.text+0x156d0a0>
```

*`ccmp` only writes the condition flags (four bits, NZCV, that comparison instructions set), and
nothing reads them before the kernel sets them again, so it has no effect that matters. The `b`
("branch") jumps over the rest of the header into the kernel. The [`efi-zboot`](../efi-zboot/)
primer tells the PE/COFF half of the story.*

Now the fields that steer placement. `xxd -e -g 8` prints the file as little-endian 8-byte words,
which saves you reversing bytes by hand. Only the hex columns change; the text column on the
right still shows the bytes in file order, so it looks the same as before:

```
00000000: 1455b427fa405a4d 0000000000000000  MZ@.'.U.........
00000010: 00000000022a0000 000000000000000a  ..*.............
00000020: 0000000000000000 0000000000000000  ................
00000030: 0000000000000000 00000040644d5241  ........ARMd@...
```

- `text_offset = 0`. Since Linux v5.8 it is always 0. Earlier kernels usually wrote `0x80000`
  here. Before v3.17, `image_size` is 0 and `booting.rst` says to assume a `text_offset` of
  `0x80000`.
- `image_size = 0x22a0000`, about 34.6 MiB. In general this is *larger* than the file, because
  the kernel's zero-initialised data (BSS) is not stored in it. For this particular kernel the file
  is exactly `0x22a0000` bytes (36,306,944): its build pads the file out to the full size. Do not
  rely on that; always reserve `image_size`.
- `flags = 0xa`, binary `1010`. Bits are numbered from the right, starting at 0, and "bits 2:1"
  means bits 2 down to 1 read as one small number:

  ```
    bit:   3   2 1   0
           1   0 1   0      = 0xa
           |   \_/   '-- bit 0 = 0: little-endian (1 would mean big-endian)
           |    '------- bits 2:1 = 01: 4 KiB pages (10 = 16 KiB, 11 = 64 KiB, 00 = unspecified)
           '------------ bit 3 = 1: placement anywhere
  ```

  "Placement anywhere" means the 2 MiB-aligned base may be anywhere in physical memory, as long
  as the whole `image_size` sits below 2^48 bytes (256 TiB, far more than any RAM). With bit 3 = 0
  the kernel would want to sit as close as possible to the bottom of RAM, because it could not
  use memory below itself.

> **Try it.** You do not need a kernel to practise reading a header. This rebuilds the same 64
> bytes from hex and reads two fields. The hex string is already in file order (byte by byte,
> exactly as the plain `xxd` dump showed it); `xxd -r -p` turns plain hex back into bytes and
> ignores the spaces, which are only there to group 8 bytes at a time:
>
> ```sh
> echo '4d5a40fa27b45514 0000000000000000 00002a0200000000 0a00000000000000 0000000000000000 0000000000000000 0000000000000000 41524d6440000000' | xxd -r -p > hdr.bin
> xxd -s 0x10 -l 8 -e -g 8 hdr.bin
> xxd -s 0x38 -l 4 hdr.bin
> ```
>
> You should see `00000010: 00000000022a0000` (the `image_size`) and `00000038: 4152 4d64`
> followed by `ARMd`. Now change `0a00000000000000` (the fourth group, offset `0x18`) to
> `0b00000000000000`, rebuild, and run `xxd -s 0x18 -l 8 -e -g 8 hdr.bin`. Look for
> `000000000000000b`, then answer the question below.

:::predict You changed the flags from 0xa to 0xb. Which flag did you set, and should a VMM accept the result?
`0xb` is binary `1011`: you set bit 0, which means "this kernel is big-endian". macvmm refuses it.
Our guests and our VMM are little-endian throughout, and a header that claims otherwise is either
the wrong kernel or a crafted file; chapter 13's parser rejects it with a named error (see the
Security note below).
:::

## Placement: where everything goes

`booting.rst` gives one rule per object. Here they are, each with the reason it exists. One
note on units: the spec writes "MB" and "GB", but it means binary units, MiB (2^20 bytes) and GiB
(2^30 bytes), which is what this primer writes.

**The kernel** "must be placed `text_offset` bytes from a 2MB aligned base address anywhere in
usable system RAM and called there", and "at least `image_size` bytes from the start of the image
must be free". The 2 MiB comes from page tables. A page table maps memory in chunks, and with
4 KiB pages one entry one level up the table (a "level-2 entry") can map a whole 2 MiB chunk,
called a **block**, in one go. The kernel maps itself in such blocks early on, and a block can
only start at a multiple of 2 MiB. The `image_size` rule protects the
BSS, which the kernel zeroes as one of its first acts. Anything you put there is erased.

**The DTB** "must be placed on an 8-byte boundary and must not exceed 2 megabytes" (§2). Also,
"since the dtb will be mapped cacheable using blocks of up to 2 megabytes in size, it must not be
placed within any 2M region which must be mapped with any specific attributes". In plain words:
each page-table entry also carries *attributes*, such as "cacheable" (the CPU may keep copies of
it in its caches) or "device" (never cache, every access goes straight through). The kernel maps
the whole 2 MiB block around the DTB as ordinary cacheable memory, so do not share that block
with anything that must not be cached, such as a device's registers.

**The initramfs** "must reside entirely within a 1 GB aligned physical memory window of up to
32 GB in size that fully covers the kernel Image as well." That is: there must be some stretch of
at most 32 GiB, starting at a multiple of 1 GiB, that contains both the kernel and the whole
initramfs. And of course the initramfs must not overlap the kernel's `image_size`.

Here is the plan macvmm uses (chapter 13 builds it as a testable `BootPlan`), with the Alpine
numbers:

```
0x4000_0000  +--------------------------+  RAM base, 2 MiB block #0
             | DTB (8-byte aligned,     |  x0 points here
             |      at most 2 MiB)      |
0x4020_0000  +--------------------------+  2 MiB-aligned base + text_offset (0)
             | Image file               |  PC points here
             | ...BSS (in image_size)   |
0x424a_0000  +--------------------------+  0x4020_0000 + image_size
             | gap (our 2 MiB rounding) |
0x4260_0000  +--------------------------+  align_up(kernel end, 2 MiB)
             | initramfs                |
             +--------------------------+
```

*The DTB owns the first 2 MiB block alone; the kernel starts at the next block boundary, and the
initramfs starts past the kernel's `image_size`, not past its file.*

Why put the kernel at `+2 MiB` rather than at the RAM base? The DTB needs a home, the kernel
needs a 2 MiB-aligned start, and the next aligned address after the DTB's block is
`0x4020_0000`. QEMU's `virt` machine also loads the kernel at RAM base + 2 MiB (it keeps its own
small boot stub in the first block and puts the DTB after the initrd), so kernel addresses match
when we compare traces. The DTB itself is a few KiB, far under its 2 MiB limit. The gap and the
initramfs rounding to 2 MiB are our choice, not the protocol's; they keep the numbers easy to
read (`0x4020_0000 + 0x22a_0000 = 0x424a_0000`, rounded up to the next multiple of `0x20_0000`
is `0x4260_0000`). The 1 GiB window holds without effort: RAM starts at `0x4000_0000`, itself 1 GiB-aligned.

> **Security.** Every number in the header comes from a file, and chapter 13 treats it as hostile.
> A crafted `image_size` of `0xFFFF_FFFF_FFFF_FFFF` makes `base + image_size` wrap around to a small
> address, and a naive overlap check passes. So every sum is a `checked_add`, every range must end
> inside RAM, `text_offset` must be aligned, the flags must say little-endian with a page size we
> support, and a file without the magic at `0x38` is refused with a named error before any byte
> reaches guest memory.

## The rest of the list

You can skip this section on a first read: none of it requires code from you, and nothing
later depends on memorising these names. `booting.rst` §4 continues with rules about timers,
coherency and system registers. They are real, but most of them concern registers at EL2 and
EL3, which Hypervisor.framework owns and our VMM cannot even write. In short:

- **Timers.** Every Arm CPU has a counter that ticks at a fixed rate. `CNTFRQ` must hold that
  rate (ticks per second), and `CNTVOFF`, the amount subtracted to give a guest its "virtual"
  counter, must be the same on every CPU, so all CPUs agree on the time. HVF sets the frequency; macvmm uses one virtual-timer offset for all vCPUs (chapter 11 reads
  the frequency rather than assuming it).
- **Coherency.** All CPUs must be in one coherency domain: a group of CPUs whose caches the
  hardware keeps consistent with each other automatically. vCPUs on one Mac are.
- **System registers.** Every writable system register at or below the entry level must have
  been initialised by a higher level, plus a long list of feature-specific settings about which
  instructions *trap* (stop and hand control to EL2): `HCR_EL2` for general hypervisor control,
  `ICC_SRE_EL2` for the interrupt controller (the GICv3, chapter 12), and so on. For an EL1 entry those registers live at
  EL2, which is HVF's job; the `docs/research/guest-boot.md` note marks which of these we have
  confirmed and which are still to be checked when Linux first boots in chapter 14.
- **All CPUs** must enter the kernel at the same exception level, with the same rules.

## The four bugs, found

Remember the plan from the start? Here is what it got wrong.

1. **Kernel at `0x4000_1000`.** Not 2 MiB-aligned. The kernel must start `text_offset` bytes
   above a 2 MiB-aligned base, so it moves to `0x4020_0000`, which also leaves the DTB its own
   2 MiB block.
2. **Initramfs after the file's last byte.** The kernel needs `image_size` bytes, which can reach
   past the file into BSS. The kernel zeroes its BSS early, wiping the start of the initramfs; the
   symptom shows up much later, when the kernel tries to unpack it.
3. **Interrupts unmasked.** DAIF must be fully masked. An early interrupt would jump to a vector
   table that does not exist yet.
4. **"Point the PC and run."** Nobody set `x0`. The kernel's only map of the machine is the DTB,
   and it was never told where the DTB is.

Notice that the first two are numbers you could check by reading the plan, while the last two are
about state the plan never mentioned at all. That is what a written protocol is for.

## Lab

:::lab image-inspector

The `image-inspector` lab lets you drop an Image file onto the page and see its header decoded:
each field with its offset, the flags split into endianness, page size and placement, and the
validity checks chapter 13's parser applies, in its order (the file holds the whole header,
magic, little-endian, supported page size, non-zero `image_size`, aligned `text_offset`, and the
file no longer than `image_size`). Choose a RAM size and it draws the placement map above for
that kernel. For a kernel with BSS (try the scenario with this page's numbers: `image_size`
`0x1800000`, file `0x1400000`), it also draws the tempting wrong plan, the initramfs right after
the file's last byte, and marks the part the BSS would wipe. The file is parsed locally in your
browser and never uploaded. Try it with a deliberately broken copy (patch `image_size` to all
`ff`): every header check passes, so see where placement stops, and why. The `efi-zboot` primer
adds a mode to the same lab that recognises a compressed wrapper and refuses it.

## Self-check

Commit to an answer before you reveal each one.

:::predict Your VMM starts the kernel with CPSR = 0x005. Which booting.rst rule does that break, and what could happen in the first few microseconds?
`0x005` is EL1h with D, A, I and F all *clear*: interrupts are unmasked, which breaks "all forms
of interrupts must be masked in PSTATE.DAIF". If an IRQ arrives before the kernel writes
`VBAR_EL1`, the CPU jumps into a vector table that does not exist yet, at a garbage address. That
is the whole answer. (The detail, from chapter 02's vector-table layout: an IRQ taken at the
current level while using `SP_EL1` goes to `VBAR_EL1 + 0x280`. With `VBAR_EL1 = 0` that is
address `0x280`, which in our map is not RAM.) The result is the same kind of second-order
fault you trace in chapter 06's `self-fault` exercise. The fix is `0x3c5`.
:::

:::predict An Image header says text_offset = 0, image_size = 0x1800000, and the file is 0x1400000 bytes. The kernel goes at 0x4020_0000. What is the lowest address where the initramfs may start under macvmm's plan, and what is the tempting wrong answer?
The kernel needs `0x4020_0000 + 0x1800000 = 0x41A0_0000`. That address is already a multiple of
2 MiB, so the initramfs may start at `0x41A0_0000`. The tempting answer is the end of the file,
`0x4160_0000`, which lies inside the kernel's BSS: the kernel would zero the first 4 MiB of the
initramfs.
:::

:::predict Why does booting.rst care which 2 MiB region the DTB sits in, when the DTB itself is only a few KiB?
Because the kernel maps the DTB as Normal, cacheable memory using blocks of up to 2 MiB. Anything
else in that block gets the same mapping. If the block also held something that must be mapped
differently (device registers, or memory with special attributes), the kernel's mapping would be
wrong for it. In macvmm the DTB has the first 2 MiB block of RAM to itself.
:::

:::predict A file begins with the bytes 4d 5a 00 00 7a 69 6d 67 and has no ARM\x64 at offset 0x38. Can macvmm boot it as an Image?
No. The key fact is the missing magic: without `ARM\x64` at `0x38` it is not an Image, so
macvmm refuses it, whatever else it is. (What it actually is goes beyond this primer.) It starts
with `MZ` like a real Image, but the next bytes spell `zimg`: it is an EFI zboot
wrapper, a small EFI program with a compressed kernel inside (Alpine's `vmlinuz-virt` looks
exactly like this). arm64 kernels have no decompressor (§3), so the VMM refuses it with a named
error, and chapter 13 unwraps it on the host first. The `efi-zboot` primer explains the format.
:::

:::predict Why must the kernel image be "cleaned to the PoC" at entry, and why does macvmm issue no cache maintenance of its own?
At entry the MMU is off, so the kernel's data accesses bypass the data cache and go to memory. If
the boot loader's copy of the kernel were still sitting in dirty cache lines, the kernel would read
stale bytes, and a later eviction could overwrite its own writes. Cleaning to the PoC puts the
truth in memory first. macvmm writes the image through Hypervisor.framework's mapping of guest
memory, and the project observed (the `memtest` evidence in the `caches` primer) that such writes
are visible to an MMU-off guest without maintenance.
:::

:::predict The VMM leaves x1 = 0xdead by mistake. Does Linux refuse to boot?
No. The registers are reserved, and today's Linux only warns: `setup_arch()` prints
`WARNING: x1-x3 nonzero in violation of boot protocol` and continues. It is still a bug in the
boot loader: a future kernel may give those registers a meaning.
:::

## Where this shows up in macvmm

- [Chapter 06, `vcpu-state`](../../cpu/vcpu-state/): `Vcpu::reset` sets the PC, `CPSR = 0x3c5`,
  `MPIDR_EL1` and `SCTLR_EL1` with the MMU and caches off (`crates/vmm/src/vcpu/`). Only the
  "CPU state at entry" rules apply yet.
- [Chapter 08, `traps-psci`](../../cpu/traps-psci/) and [chapter 20, `smp`](../../smp/smp/):
  PSCI `CPU_ON` starts secondary vCPUs under the same entry rules.
- [Chapter 10, `device-tree`](../../devices/device-tree/): the generated DTB goes to `0x4000_0000`
  and its address into `x0` (`crates/vmm/src/fdt/`).
- [Chapter 13, `loaders`](../../linux/loaders/): the Image header parser, the `BootPlan` with the
  placement rules above, `/chosen`'s initrd addresses and the full entry state
  (`crates/vmm/src/loader/`, addresses from `crates/vmm/src/arch/layout.rs`).
- [Chapter 14, `linux-boot`](../../linux/linux-boot/): the first real test of the whole contract.
- [Chapter 21, `firmware`](../../firmware/firmware/): U-Boot becomes the boot loader and must
  honour the protocol itself.

## Going further

- Linux, `Documentation/arch/arm64/booting.rst` (rendered at
  https://docs.kernel.org/arch/arm64/booting.html): §2 for the DTB, §3 for decompression, §4 for the
  header, placement and entry state. Short enough to read in full; do it before chapter 13.
- Arm Architecture Reference Manual for A-profile (DDI 0487): chapter D1, "The AArch64 System
  Level Programmers' Model" (PSTATE and exception entry); the `SCTLR_EL1` register description in
  part D; chapter D8, "The effects of disabling address translation stages on VMSAv8-64
  behavior". The [`reading-arm-specs`](/build-your-own/vmm/primers/reading-arm-specs/) primer shows how to navigate it.
- Devicetree Specification v0.4, chapter 5, "Flattened Devicetree (DTB) Format", for the blob
  `x0` points at.
- Arm DEN 0022, Power State Coordination Interface, §5.1.4 `CPU_ON`, for how secondary CPUs enter
  the kernel; and QEMU's `hw/arm/boot.c` (`load_aarch64_image`) for a second, independent boot
  loader that follows the same rules.

## Checkpoint

**Checkpoint.** You can now state the boot contract a VMM signs when it starts Linux: `x0` = DTB
and `x1` to `x3` zero, `CPSR = 0x3c5`, MMU off with the image cleaned to the PoC, the kernel at a
2 MiB-aligned base plus `text_offset` with `image_size` reserved, the DTB 8-byte aligned in its
own 2 MiB block, the initramfs past the kernel's `image_size`. To verify: answer the six
self-check questions without peeking, and run the Try it; it should print `00000010:
00000000022a0000` and `00000038: 4152 4d64`. There is no code state to carry forward.

**What's next.** Chapter 06 makes the CPU half of this contract real: you will write
`Vcpu::reset`, read `CPSR` and `SCTLR_EL1` back from a running guest, and watch a guest fault
inside itself because nothing was at its vector table, which is the reason DAIF starts masked.

**One open question.** `booting.rst` calls entering at EL2 "RECOMMENDED", and we enter at EL1.
What does a Linux guest lose by starting one level lower, and what would our VMM have to take on
to hand it EL2 instead?
