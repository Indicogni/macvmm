---
title: Reading the ARM ARM and other primary specs
slug: reading-arm-specs
kind: primer
minutes: 30
required_by: 07
also_used_by: [01, 02, 08, 09, 10, 12, 15]
objectives:
- Find any AArch64 system register's page in DDI 0487 by its title, and name the five parts of that page
- Decode an ESR_EL2 value by hand into EC, IL and the data-abort ISS fields, using the manual's tables
- Read a short piece of Arm pseudocode (bit slices, bit strings, X[], UInt, SignExtend) and say what it does
- Say what RES0, RES1, RAZ/WI, UNKNOWN, UNDEFINED and IMPLEMENTATION DEFINED oblige the hardware, the guest and our VMM to do
- Tell a virtio MUST from a SHOULD, and find the DTB header layout in chapter 5 of the Devicetree Specification
lab: esr-decoder
---

# What does 0x93810046 mean?

A virtual machine runs a **guest** operating system on a **vCPU**, a virtual CPU that our
program drives through Hypervisor.framework. The guest runs directly on the Mac's processor
until it does something the hardware will not let it do alone, such as touching an address where
we put no memory. Then the CPU stops the guest and returns control to our program, the VMM
(virtual machine monitor). That return is called an **exit**, and the CPU records the reason for
it in a *syndrome register*, `ESR_EL2`.

Here is one. A guest kernel writes one character to its serial port, the UART (the device that
sends text to a terminal). Like most devices, the UART is reached by ordinary loads and stores to a
fixed address. This is called **MMIO**, memory-mapped I/O. We put nothing at that address on
purpose, so the store causes an exit, and the only explanation we get is a number: `0x93810046`.
Somewhere inside that number are the answers we need to finish the store for the guest. Was it a
read or a write? How many bytes? Which of the guest's 31 registers held the character?

Apple's header says only that the number "Corresponds to ESR_ELx". Arm's manual, which says
everything else, is more than ten thousand pages long. This primer teaches you to get from that
number to its meaning in about two minutes, and to read the words the manual uses with the
precision it intends.

:::objectives
- Find any AArch64 system register's page in DDI 0487 by its title, and name the five parts of that page.
- Decode an `ESR_EL2` value by hand into EC, IL and the data-abort ISS fields, using the manual's tables.
- Read a short piece of Arm pseudocode (bit slices, bit strings, `X[]`, `UInt`, `SignExtend`) and say what it does.
- Say what RES0, RES1, RAZ/WI, UNKNOWN, UNDEFINED and IMPLEMENTATION DEFINED oblige the hardware, the guest and our VMM to do.
- Tell a virtio MUST from a SHOULD, and find the DTB header layout in chapter 5 of the Devicetree Specification.
:::

Before you start: you should have read the
[`aarch64-reading` primer](/build-your-own/vmm/primers/aarch64-reading/) and met the exception
syndrome in [chapter 02](/build-your-own/vmm/bare-machine/first-exit/), where we read its top six
bits once. Five things from that primer are used here without comment:

- **Exception levels.** Arm code runs at a privilege level: EL0 for apps, EL1 for a kernel, EL2
  for a hypervisor. The guest runs at EL0 and EL1, and from EL2's point of view those are "lower
  Exception levels". A register named `NAME_EL2` belongs to EL2, and `ELx` means "whichever
  level". (Section "System registers: MRS, MSR and the _ELn suffix".)
- **Register names.** `x0` to `x30` are the 64-bit general registers. `w0` to `w30` are the low
  32 bits of the same registers. `xzr` reads as zero, and writes to it are thrown away.
  (Section "Registers: thirty-one boxes and a zero".)
- **Loads and stores.** `str w1, [x0]` stores register `w1` to the address held in `x0`.
  `ldr` loads in the other direction. (Section "Loads and stores, slowly".)
- **Sizes.** A byte is 1 byte, a halfword 2, a word 4, a doubleword 8.
- **MRS and MSR.** `mrs` reads a system register into a general register, and `msr` writes one.

## Why we read the primary source

Blog posts, Stack Overflow answers and even other hypervisors' source code are secondary sources:
somebody's reading of the manual, frozen at one moment, often for one CPU. They are useful for
orientation and dangerous for detail. When our VMM decides whether a guest's store was 4 or 8
bytes, the only authority is the document the CPU designers wrote, because the guest kernel's
authors read that same document.

A specification that defines what every conforming implementation must do is called a **primary
spec**. For this course there are a handful, and it helps to know which question goes to which
one before you open any of them.

```
Question                                   Primary spec
-----------------------------------------  ----------------------------------------------
What does this CPU register / instruction  Arm Architecture Reference Manual for
mean? What happens on an exception?        A-profile, Arm DDI 0487 (the "ARM ARM")
How do interrupts reach a CPU?             GICv3/v4 Architecture Specification, IHI 0069
How does a kernel ask to power off?        PSCI, DEN 0022 (calls follow SMCCC, DEN 0028)
What do the UART's registers do?           PL011 Technical Reference Manual, DDI 0183
How do virtual disks talk to the guest?    Virtio 1.2 (OASIS)
How do we describe the machine to Linux?   Devicetree Specification v0.4
How must a kernel be started?              Linux Documentation/arch/arm64/booting.rst
```

*The table to keep beside you: each question has exactly one place where the answer is binding.*

You do not need these acronyms yet. Each one gets its own chapter. GICv3 is Arm's interrupt
controller. PSCI is the set of calls a kernel makes to start CPUs or power off. SMCCC is the
calling convention those calls use. The PL011 is Arm's standard UART. Virtio is a standard for
virtual devices. A DTB is a binary file that describes the hardware to the kernel.

Most of this primer is about the first row, because it is the biggest and the strangest. The last
section shows that the habits carry over to virtio and the Device Tree.

## How the ARM ARM is organised

The manual's full name is the *Arm Architecture Reference Manual for A-profile architecture*,
document number **DDI 0487**. Everyone calls it the **ARM ARM**. Arm releases a new **issue** of it
regularly, named by letters (`J.a`, `K.a`, `L.a`, and so on), and you download it as one PDF from
Arm's developer site.

**AArch64** is the 64-bit way of running an Arm CPU, and the only one our guests use. AArch32,
the older 32-bit way, has its own parts of the manual. **A-profile** is the family of Arm
architectures for application processors such as phones, laptops and servers. (R-profile and
M-profile, for real-time chips and microcontrollers, have their own manuals.)

The manual is split into lettered parts. You need two of them for this course, plus the Glossary.
The others are worth recognising so you can skip them with confidence.

```
Part A  Architecture introduction and overview      skim once
Part B  AArch64 application level (registers, memory model)
Part C  The AArch64 instruction set                 <- instruction pages (C6: A64 base instructions)
Part D  AArch64 system level                        <- exceptions (D1), virtual memory, timers,
                                                       and the system register descriptions
Parts E, F, G  AArch32 (32-bit Arm)                 skip: our guests are 64-bit
Part H  External debug                              skip
Part I  Memory-mapped components                    skip for now
Part J  Architectural pseudocode library            look up a function you met elsewhere
Part K  Appendixes (incl. the pseudocode definition, UNPREDICTABLE constraints)
Glossary                                            the exact meaning of RES0, UNKNOWN, ...
```

*Notice that we live mostly in C and D, and that the Glossary is where words get their legal meaning.*

There is a trap in citing it. Arm renumbers chapters in part D between issues: the chapter of
system register descriptions has changed number more than once. So "ESR_EL2 is D17.2.40" is true
in one issue and false in another. The page *titles* do not move. Every system register page is
headed with its name and long name, like **ESR_EL2, Exception Syndrome Register (EL2)**, and
searching the PDF for that string finds it in any issue.

That is the citation rule the macvmm source follows (it is written down at the top of
`crates/hvf/src/lib.rs`): cite a register by the title of its page, a table by its exact title,
an instruction by its mnemonic, and add the issue letter whenever you give a section number.

## Anatomy of a register page

Open the PDF, search for `ESR_EL2, Exception Syndrome Register (EL2)`, and you land on a page with
the same skeleton as every other system register page:

```
ESR_EL2, Exception Syndrome Register (EL2)
  Purpose              one paragraph: what the register is for
  Configurations       when it exists (for example "if EL2 is not implemented ...")
  Attributes           its size: a 64-bit register
  Field descriptions   a bit diagram, then one entry per field:
                         name, bit range, meaning, values, reset value,
                         and "When <condition>:" variants
  Accessing ESR_EL2    the MRS/MSR encoding (op0, op1, CRn, CRm, op2)
                         and pseudocode saying who may access it and what traps
```

*Read top to bottom only once; after that you jump straight to "Field descriptions".*

The last part says how software reaches the register. `MRS` reads a system register and `MSR`
writes one. The five numbers op0, op1, CRn, CRm and op2 are the register's address, and they are
built into the instruction word.

Bit diagrams in the manual follow one convention. The highest bit is on the left, and a range such
as [31:26] includes both ends, so it is six bits wide.

The bit diagram for `ESR_EL2` in a current issue looks like this:

```
 63      56 55              32 31     26 25 24                     0
+----------+------------------+---------+--+------------------------+
|   RES0   |       ISS2       |   EC    |IL|          ISS           |
+----------+------------------+---------+--+------------------------+
```

*The diagram you met in chapter 02, with its full width: EC chooses the kind of exception, and ISS
is a field whose layout depends on EC.*

IL says whether the trapped instruction was 32 bits long (1) or 16 bits long (0). For a 64-bit
guest it is always 1. ISS2 is extra detail for a few newer instructions. Ignore it for now.

The layout of ISS depends on EC, and that is the key to the whole page. The field **ISS**
(instruction specific syndrome) has no single meaning. The EC field's description is a long table
of exception classes, and for each class the page gives a separate sub-table titled "ISS encoding
for an exception from ...". This course needs three rows of the EC table first: `0x16` is an HVC
instruction (the guest calling the hypervisor, chapter 02), `0x18` is a trapped MSR, MRS or System
instruction (chapter 08), and `0x24` is a data abort from a lower Exception level. A data abort is
a load or store that failed. For EC `0x24`, you follow the link to
**ISS encoding for an exception from a Data Abort**, which lays out bits [24:0] like this
(abridged to the fields chapter 07 uses):

```
 24  23 22  21  20     16  15  14  ...  6   5       0
+---+-----+---+---------+---+---+-----+---+---------+
|ISV| SAS |SSE|   SRT   |SF |AR | ... |WnR|  DFSC   |
+---+-----+---+---------+---+---+-----+---+---------+
```

*Bit 24 (ISV) says whether the next ten bits are worth reading at all.*

| Field | Bits | Meaning |
|---|---|---|
| ISV | 24 | Instruction syndrome valid: 1 means SAS, SSE, SRT, SF and AR describe the access |
| SAS | 23:22 | Access size: `00` byte, `01` halfword (2), `10` word (4), `11` doubleword (8) |
| SSE | 21 | 1 if a load must be sign-extended into the register |
| SRT | 20:16 | Which register: 0 to 30 is `x0` to `x30`, 31 means `xzr` |
| SF | 15 | 1 if the register is 64-bit (`xN`), 0 if 32-bit (`wN`) |
| AR | 14 | Acquire/release: 1 for the ordering instructions `ldar` and `stlr` (see the memory-ordering primer) |
| WnR | 6 | Write not Read: 1 for a store, 0 for a load |
| DFSC | 5:0 | Data fault status code: which kind of fault. `0b000110` is a translation fault, meaning no memory is mapped at the address |

Now the opening number. `0x93810046` was observed in the project's first spike, when a test
guest ran `str w1, [x0]` with `x0` pointing at the UART's address, which we had deliberately left
unmapped. Your shell can do the bit slicing. To read the field at bits [23:22], shift the
number right by 22 so those bits land at the bottom, then AND it with `3` (binary `11`, two ones)
to keep only those two bits. Each field is a shift by its lowest bit and a mask of as many ones as
it is wide. In zsh or bash:

```
esr=0x93810046
printf '%#x\n' $(( (esr >> 26) & 0x3f ))
echo $(( (esr >> 24) & 1 )) $(( (esr >> 22) & 3 )) $(( (esr >> 16) & 0x1f )) $(( (esr >> 6) & 1 ))
```

You should see:

```
0x24
1 2 1 1
```

The first line is EC. The second line is ISV, SAS, SRT and WnR, in that order. Read it against the
tables. EC `0x24`: a data abort from a lower exception level, meaning the
guest. ISV 1: the hardware described the access for us. SAS 2: a word, 4 bytes. SRT 1: register
1. WnR 1: a store. That is `str w1, [...]`, recovered from a number, with no instruction decoding
on our side. Chapter 07 turns exactly this into Rust.

> **Predict.** Bit 24 is 0 for `ldp x0, x1, [x2]` (load a *pair* of registers) aimed at a device
> address. Why can't the hardware fill in SRT for that instruction?

There is only one SRT field, and a pair load writes two registers. Rather than describe half the
access, the hardware sets ISV to 0 and leaves the description out. Chapter 07 handles that case by
stopping with a clear error. A much later chapter (21) decodes such instructions itself.

## Pseudocode: the manual's precise half

Prose in the ARM ARM explains; **pseudocode** decides. Every instruction page in part C ends
with a block of it, in a small language Arm defines in the appendix titled *Arm Pseudocode
Definition*. Its library of shared functions (`SignExtend`, `HaveEL`, `AArch64.TakeException`, and
hundreds more) is part J. When the prose and the pseudocode seem to disagree, read the pseudocode
again, slowly; it is usually right.

You need about ten conventions to read it:

| Notation | Meaning |
|---|---|
| `'1'`, `'0110'`, `'x'` | Bit strings in single quotes; `x` in a pattern means "don't care" |
| `opc<0>`, `ESR<31:26>` | Bit slicing with angle brackets, high bit first |
| `a:b` | Concatenate two bit strings |
| `=` and `==` | Assignment and equality (as in C) |
| `bits(64)`, `integer`, `boolean` | Types: a 64-bit string, a mathematical integer (never overflows), true/false |
| `UInt(x)`, `SInt(x)` | A bit string read as an unsigned or two's-complement integer |
| `ZeroExtend(x, N)`, `SignExtend(x, N)` | Widen `x` to `N` bits with zeros, or with copies of its top bit |
| `X[t, 64]` | General register `t` as 64 bits; register 31 reads as zero here (the stack pointer has its own accessor, `SP[]`) |
| `PSTATE.EL`, `HCR_EL2.TGE` | A named field of a register, with a dot |
| Indentation | Blocks are marked by indentation, not braces |

Here is the core of the `LDRSH` (load register signed halfword, immediate) page, cut down to the
lines that matter to us. It is pseudocode and does not run. The real page also handles alignment
checks and *writeback* forms, which also add the offset to the base register.

Some names come from the instruction word. An instruction page splits the 32-bit word into
fields. `Rt` is the 5-bit number of the target register, `Rn` the number of the register holding
the base address, `imm12` a 12-bit constant offset, and `opc` a 2-bit field that picks the variant.

```
// Pseudocode, simplified from the LDRSH (immediate) page, unsigned-offset form.
// Decode: runs once per instruction encoding.
integer t = UInt(Rt);
integer n = UInt(Rn);
integer regsize = if opc<0> == '1' then 32 else 64;
bits(64) offset = LSL(ZeroExtend(imm12, 64), 1);    // the immediate counts halfwords

// Operation: runs each time the instruction executes.
address = (if n == 31 then SP[] else X[n, 64]) + offset;
data = Mem[address, 2, AccessType_GPR];              // read 2 bytes
X[t, regsize] = SignExtend(data, regsize);           // widen, copying the sign bit
```

Line by line: `t` and `n` are register numbers. `regsize` is 32 if bit 0 of `opc` is 1. This
looks backwards, but it is how the encoding was laid out: `opc` is `10` for `ldrsh x...` and
`11` for `ldrsh w...`. `LSL` is logical shift left, and shifting by 1 doubles the immediate,
because the offset counts 2-byte halfwords. Base register 31 here means the stack pointer, read
with `SP[]`, not `xzr`. `Mem[address, 2, ...]` reads 2 bytes. `AccessType_GPR` only labels the
access as a load into a general register, and you can ignore it. The last line widens the 16 bits
to `regsize` bits, copying the sign bit.

Put it next to the data-abort table and something pleasing appears. The access size (2 bytes) is
SAS. The `SignExtend` is SSE. `t` is SRT. `regsize == 64` is SF. When this load hits a device
address, the syndrome hands us the pseudocode's own variables. An ESR for `ldrsh w2, [...]` at a
device address is `0x93620006`. Write out its 32 bits in binary and cut them at the field
boundaries:

```
hex     9    3    6    2    0    0    0    6
bits    1001 0011 0110 0010 0000 0000 0000 0110

field   EC      IL  ISV  SAS  SSE  SRT    SF  AR  [13:7]   WnR  DFSC
bits    100100  1   1    01   1    00010  0   0   0000000  0    000110
```

*The same 32 bits, regrouped by field from bit 31 down to bit 0. EC `0b100100` is `0x24`, and
bits [13:7] hold fields chapter 07 does not use.*

ISV is 1. SAS is `01`, two bytes. SSE is 1, signed. SRT is `00010`, register 2. SF is 0, a 32-bit
register. WnR is 0, a load. So it is two bytes, signed, into `w2`. When our VMM emulates that
load, it must do the last line of the pseudocode itself, sign-extending to 32 bits. Forgetting that is a classic emulator bug, and
chapter 07's tests check for it.

## The words in small capitals

The manual prints some words in SMALL CAPITALS, and each one has a definition in the Glossary
that is stricter than its English meaning. "Unknown" in plain text means what it says;
UNKNOWN in small capitals is a contract. These are the ones you will meet from chapter 07 on.

Arm names each revision of the architecture by version: Armv8.0, then Armv8.1 up to Armv8.9, then
Armv9.0 and onward. Each version adds features, and a CPU's version says which of them it must
have.

**RES0 and RES1** (reserved, 0 or 1). A bit the architecture has not given a meaning yet, but
might in a later version. The rules cut both ways. Software reading it must not rely on it being
0 (or 1). Software writing it must write 0 (or 1), or write back the value it read. The reason is
in our own diagram: in older issues, all of `ESR_EL2` bits [63:32] were RES0. Then Armv8.7 started
using bits [36:32] as ISS2, and later versions widened ISS2 to [55:32]. A decoder that had asserted
"the top half is always zero" would have broken on newer CPUs, more than once. Our decoder ignores
reserved bits instead, and its test vectors deliberately set them to check that.

**RAZ, WI, RAZ/WI** (read-as-zero, writes ignored). Not "reserved for the future" but a
behaviour, here and now: reads return 0, writes have no effect. The manual uses it for features
that are absent or disabled. Our VMM borrows the term in chapter 08 as a policy for some debug
registers the guest pokes at: we answer reads with 0 and drop writes, on purpose, with a written
reason.

**UNKNOWN**. A value the architecture does not define: it may differ between CPUs, between runs,
or between two reads. Software must not use it. Many fields of `ESR_EL2` reset to an UNKNOWN value,
which is why a register dump taken before the first exception means nothing. The Glossary adds a
limit: an UNKNOWN value must not reveal information that the current privilege level could not
otherwise read. In a VMM, this matters whenever we supply a value. For example, the PL011 manual
lists bits of a device register as having no defined value, and our code chooses what the guest
reads there.

> **Security.** That limit binds us too. Suppose our device code builds a register's reply in a
> scratch variable or reused buffer that last held a host address, such as the pointer to our
> mapping of guest memory, and fills in only the defined bits. The leftover bits reach the guest.
> The guest controls when it reads, so it can collect them, and a host pointer leaks the host's
> address layout. The safe choice for UNKNOWN bits is always a fixed value, usually 0.

**UNDEFINED**. Describes an instruction or register access that the CPU does not accept; doing it
raises an *Undefined Instruction exception*. For example, `mrs` of a register the CPU does not
have is UNDEFINED, and the guest's kernel receives the exception. Beware a naming clash: that exception is reported
with EC `0x00`, whose name in the EC table is "Unknown reason". "Unknown reason" is only a label;
it has nothing to do with UNKNOWN. In chapter 08, when the guest reads a register we do not
emulate, we make it UNDEFINED. We *inject* the exception, meaning we make the guest's vCPU take it
as if the hardware had raised it. Real hardware without the register does the same, and a kernel
knows how to handle it.

**UNPREDICTABLE** and **CONSTRAINED UNPREDICTABLE**. UNKNOWN is about a *value*;
UNPREDICTABLE is about *behaviour*: do this and the architecture promises nothing about what
happens. Its constrained form lists the few outcomes a CPU may choose from, in an appendix.
A guest that does an UNPREDICTABLE thing gets no help from us, and it would get none from real
hardware either.

**IMPLEMENTATION DEFINED**. The architecture leaves the choice to whoever designs the chip, and
that designer must document what they chose. Two kinds matter to us. Whole register encodings
are reserved for implementation use (a guest probing one gets UNDEF from us, which chapter 08
explains). And most features are optional, each named `FEAT_` something in the manual, with ID
registers that say which ones a CPU has.

> **Try it.** macOS reports your CPU's optional features using the manual's own `FEAT_` names.
> FEAT_LSE (Large System Extensions) adds single-instruction atomic operations, and FEAT_SME
> (Scalable Matrix Extension) adds matrix arithmetic. Run
> `sysctl hw.optional.arm.FEAT_LSE hw.optional.arm.FEAT_SME`. On the M5 Pro this course was
> written on, it prints `hw.optional.arm.FEAT_LSE: 1` and `hw.optional.arm.FEAT_SME: 1`. A `1`
> means present and a `0` absent, and an M1 prints `0` for SME. Then search the ARM ARM for
> `FEAT_LSE` and find which instructions it adds.

## The same habits on Apple's headers

Hypervisor.framework is Apple's system library for running guest code on the Mac's CPU, and its
headers are the C declarations that describe it. Chapter 01 asks you to read them, and the skill is the same: find the
authoritative text and read every word. Apple's headers are short, so `grep` is enough. This is
also where the bridge from Apple's API to the ARM ARM is written down:

```
H="$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers"
grep "Corresponds to" "$H/hv_vcpu_types.h"
```

On macOS 27.2 with the current SDK, the first two lines are these (two more follow, about
interrupts):

```
 @abstract Type of a vcpu exception syndrome (Corresponds to ESR_ELx).
 @abstract Type of a vcpu exception virtual address. (Corresponds to FAR_ELx).
```

Apple documents the
syndrome only by naming the Arm register, so the ARM ARM page *is* the documentation of
`hv_exception_syndrome_t`.

## Beyond Arm: MUST, SHOULD and the DTB header

Two more specs gain the same careful reading later in the course.

The **virtio 1.2** specification (OASIS) defines virtual devices such as our disk. Its section 1.3,
"Terminology", says that the key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read
as RFC 2119 defines them. RFC 2119 is a one-page Internet standard that fixes the meaning of those
words. MUST is a requirement; break it and you do not conform. SHOULD is a
strong recommendation that a conforming implementation may ignore for a good, understood reason.
MAY is a free choice. The requirements are gathered in sections with predictable titles, such as
2.1.1 "Driver Requirements: Device Status Field" and 2.1.2 "Device Requirements: Device Status
Field". A *transport* is how the guest finds a device and talks to it, and the one we build,
where the device is a block of MMIO registers, is section 4.2, "Virtio Over MMIO".

Read those titles carefully, because they say *whom* each rule binds. The guest's virtio code is
the **driver**; our VMM is the **device**. A "Driver Requirements" MUST is a promise the guest
makes and may break, maliciously or by bug, so for us it is something to check, never something to
trust. A "Device Requirements" MUST is a promise we make. Chapter 15 lives by this split.

The **Devicetree Specification v0.4** says how we describe our machine to Linux, in a DTB, the
binary file that describes the hardware to the kernel. Chapter 5,
"Flattened Devicetree (DTB) Format", is the binary format our VMM writes. It uses "shall" and
"should" with the meanings section 1.1 gives them ("shall" is required, "should" is recommended).
Section 5.2 lists the header: ten 32-bit fields, starting with `magic`, which "shall contain the
value 0xd00dfeed". One sentence there catches nearly everyone: "All the header fields are 32-bit
integers, stored in big-endian format." *Endianness* is the order in which a multi-byte number's
bytes sit in memory. Big-endian puts the most significant byte first, so `0xd00dfeed` is stored as
the bytes `d0 0d fe ed`. Our Mac is little-endian and would store it as `ed fe 0d d0`, so every
field must have its bytes reversed on the way out. Section 5.4 then defines the structure block,
the part of the file that lists the devices as a stream of 32-bit *tokens* (`FDT_BEGIN_NODE` is
`0x1`, `FDT_END` is `0x9`). Chapter 10 builds a DTB from exactly these
sections.

> **Production note.** Linux and other large projects no longer type register layouts in by
> hand. Arm publishes a machine-readable form of the architecture, and Linux keeps a generated
> description of system register fields under `arch/arm64/tools/`. We type ours by hand, with
> the page title cited above each one, because writing them out is how you learn to read them,
> and we test them against syndromes observed on real hardware.

## Self-check

Commit to an answer before you reveal each one.

:::predict Where in DDI 0487 is the layout of the ISS for a trapped `mrs` or `msr`, and how do you find it in an issue you have never opened?
Search for the register page title `ESR_EL2, Exception Syndrome Register (EL2)`, open the EC field's
table, find EC `0x18` ("trapped MSR, MRS or System instruction execution in AArch64 state"), and
follow it to its "ISS encoding for an exception from MSR, MRS, or System instruction execution in
AArch64 state" table. Search by title, not by section number, because part D's numbering changes
between issues.
:::

:::predict Decode `0x93c18046` by hand: EC, ISV, size, register, direction.
EC = `0x93c18046 >> 26` = `0x24`, a data abort from the guest. ISV = 1. SAS = `11`, 8 bytes.
SRT = 1. SF = 1, a 64-bit register. WnR = 1, a store. So it is `str x1, [...]`: an 8-byte store
of `x1`. DFSC `0x06` says it was a translation fault: nothing was mapped at the address, which is
what we arranged for our devices. Check yourself with the `esr-decoder` lab.
:::

:::predict A field is marked RES0. The guest reads it and sees 1. Is the CPU broken?
Not necessarily. RES0 promises software only that it must not *rely* on reading 0; a later
architecture version may have given the bit a meaning, as Armv8.7 and later versions did for ESR
bits [55:32]. The
obligation is on the writer: write 0, or write back what was read.
:::

:::predict The guest reads a debug register that our VMM does not emulate. Compare answering RAZ/WI with injecting UNDEFINED.
RAZ/WI returns 0 and silently drops writes; the guest carries on believing whatever 0 means for
that register, which can be a quiet lie. UNDEFINED raises an Undefined Instruction exception (EC
`0x00`) in the guest, which is what hardware without the register does, so the kernel's own
"this CPU doesn't have that" path runs. Chapter 08 uses RAZ/WI only where a written reason says 0
is the honest answer, and UNDEF everywhere else.
:::

:::predict In the pseudocode `X[t, regsize] = SignExtend(data, regsize);`, which ESR fields tell an emulator the values of `regsize` and "sign-extend or not"?
SF gives `regsize` (1 means 64, 0 means 32) and SSE says whether to sign-extend. SAS gives the
width of `data`, and SRT gives `t`. If SRT is 31, `X[31]` is the zero register, so a load into it
is discarded and a store from it stores 0.
:::

:::predict A virtio section titled "Driver Requirements" says the driver MUST NOT do something. Our VMM is the device. Can we assume the guest never does it?
No. The rule binds the guest's driver, and a guest may be buggy or hostile. For us a driver MUST
is something to detect and handle safely (reject, mark the device as needing a reset, or stop the
VM), never a precondition our code depends on for memory safety.
:::

## Lab

The lab for this primer is the [`esr-decoder`](/build-your-own/vmm/labs/esr-decoder/). Paste a
syndrome and it splits it into EC, IL and the ISS fields, so you can check your hand decoding
against the same test vectors macvmm's own decoder is tested with.

It comes with a set of spec-hunt cards to do with the PDFs open. Each card asks a question ("What
does `SCTLR_EL1.A` do?", "What is DFSC `0b100001`?", "Who sets the DRIVER_OK status bit, the
driver or the device?"), and you answer with the document, the page or section title, and the
answer itself. Cards that involve a syndrome open the `esr-decoder` with the value filled in.

## Where this shows up in macvmm

- **[01 `ffi`](/build-your-own/vmm/start/ffi/)**: reading the SDK headers before writing FFI,
  the habit from "The same habits on Apple's headers".
- **[02 `first-exit`](/build-your-own/vmm/bare-machine/first-exit/)**: your first look at the
  ESR_EL2 page, to find EC `0x16` (HVC).
- **[07 `exit-loop`](/build-your-own/vmm/cpu/exit-loop/)** (requires this primer): the
  data-abort ISS table becomes the syndrome decoder in `crates/vmm/src/arch/esr.rs` and the MMIO
  path; the `LDRSH` sign-extension is in its tests.
- **[08 `traps-psci`](/build-your-own/vmm/cpu/traps-psci/)**: the sysreg ISS table, RAZ/WI as a
  policy, injecting UNDEFINED, and IMPLEMENTATION DEFINED register space.
- **[09 `mmio-pl011`](/build-your-own/vmm/devices/mmio-pl011/)**: reading the PL011 TRM's
  register tables, including its reserved bits.
- **[10 `device-tree`](/build-your-own/vmm/devices/device-tree/)**: chapter 5 of the
  Devicetree Specification, big-endian fields and all.
- **[12 `gicv3`](/build-your-own/vmm/interrupts/gicv3/)**: register pages in the GIC
  specification, which follow the same conventions.
- **[15 `virtio-mmio`](/build-your-own/vmm/virtio/virtio-mmio/)**: driver versus device MUSTs
  in virtio 1.2.

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture*, DDI 0487: the register
  page "ESR_EL2, Exception Syndrome Register (EL2)" and its table "ISS encoding for an exception
  from a Data Abort"; the appendix "Arm Pseudocode Definition"; and the Glossary entries for RES0,
  UNKNOWN, UNDEFINED and IMPLEMENTATION DEFINED.
- OASIS, *Virtual I/O Device (VIRTIO) Version 1.2*: section 1.3 "Terminology", section 2.1
  "Device Status Field", and section 4.2 "Virtio Over MMIO".
- devicetree.org, *Devicetree Specification v0.4*: section 1.1 (the meaning of shall, should and
  may) and chapter 5, "Flattened Devicetree (DTB) Format".
- Linux, `arch/arm64/include/asm/esr.h`: the same fields as named constants (`ESR_ELx_ISV_SHIFT`
  is 24, `ESR_ELx_EC_DABT_LOW` is `0x24`), a useful second check on your reading.

## Checkpoint

**What you can do now.** Given a syndrome and the manual, you can name the exception and the
access it describes. Verify it: run the three shell lines from "Anatomy of a register page" with
`esr=0x93830006` (observed when a test guest read the UART's flag register). You should get
`0x24` (EC) and `1 2 3 0` (ISV, SAS, SRT, WnR): a 4-byte load into `w3`. Nothing in the repository changes; the next
chapter assumes you can find the ESR_EL2 page and its data-abort table without help.

**What's next.** Chapter 07 takes the number from the opening of this primer and makes our VMM
act on it: decode the syndrome, perform the guest's load or store against a device, sign-extend
when SSE says so, and step the guest past the instruction. You already know where every bit comes
from.

**One open question.** The manual says an UNKNOWN value must not reveal anything the current
privilege level could not otherwise read. Hardware enforces that for itself. Who enforces it for
the registers our VMM writes into a guest, and how would you test that nobody forgot? Hint: start
from the Security callout in "The words in small capitals", and ask which code builds every value
the guest can read.
