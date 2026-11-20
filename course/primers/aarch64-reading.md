---
title: Reading AArch64: registers, instructions, byte order
slug: aarch64-reading
kind: primer
runs: mac+browser
minutes: 30
required_by: [02]
also_used_by: [03, 07, 08, 21]
labs: [a64-encoder]
objectives:
- Name the AArch64 general-purpose registers, say what x0 versus w0 holds, and decide whether register number 31 means xzr or sp in a given instruction field
- State the AAPCS64 roles of x0 to x7, x0 as the result, x29, x30 and x18 on Apple platforms
- Read a system-register name (NAME_ELn) and an mrs or msr instruction, and predict whether an app may run it
- Split a 32-bit A64 instruction word into its fields for movz, hvc and b, and read the dozen instructions in our traces
- Read a line of objdump or otool output, and read the same four bytes as a little-endian and a big-endian number
---

# What do these three numbers mean?

Chapter 02 hands you a program that is three numbers long: `0xD2800540`, `0xD4000002`, `0x14000000`. It claims the first one means "put 42 in register `x0`". Then you write the numbers to a file, dump the file, and the first one comes out as `40 05 80 d2`. Backwards. So which is it, and how can a number mean "put 42 in `x0`" at all?

By the end of this primer you can answer both questions by reading, not by trusting. Nothing here needs Hypervisor.framework; everything runs on your Mac with the tools Xcode installs.

:::objectives
- Name the general-purpose registers, say what `x0` versus `w0` holds, and decide whether register number 31 means `xzr` or `sp` in a given field.
- State the AAPCS64 roles of `x0` to `x7`, `x0` as the result, `x29`, `x30`, and `x18` on Apple platforms.
- Read a system-register name (`NAME_ELn`) and an `mrs`/`msr` instruction, and predict whether an app may run it.
- Split a 32-bit instruction word into its fields for `movz`, `hvc` and `b`, and read the dozen instructions in our traces.
- Read a line of `objdump` or `otool` output, and read four bytes as a little-endian and a big-endian number.
:::

:::prereqs
- The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer (privilege, the syscall at the hardware level).
- Hex and bit fields at the level of the entry self-check (refresher below).
- Xcode or the Command Line Tools (`clang`, `objdump`, `otool`, `xxd`, `od`). Check with `clang --version`.
:::

> **Refresher: hex and bit numbers.** One hex digit is exactly four bits: `0x2a` is `0010 1010`. Bits are numbered from the right, starting at 0, so in a 32-bit word bit 0 is the lowest and bit 31 the highest. "Bits 9 to 5" means the five bits with those numbers, read as one small binary number.

> **Words you will meet.** A **guest** is the program or operating system running inside our virtual machine. A **trap** is the hardware stopping the guest because it did something the hypervisor asked to be told about. Each trap hands control to our VMM as a **VM exit**, together with an **exit report** (a few registers saying what the guest tried to do). Chapter 02 shows all three for real; here they only explain why some instructions matter more to us than others.

## Reproduce the puzzle first

Make a scratch directory and save these three lines as `three.s`. It is the exact guest of chapter 02, written as **assembly** text (one instruction per line, in words) instead of numbers. In it, `.text` tells the assembler "what follows is code", `_start:` is a label (a name for this address), and `#` marks a constant.

File: `three.s`

```asm
.text
_start:
    movz x0, #0x2a
    hvc  #0
    b    .
```

Assemble it into an **object file** (the machine-code output of one source file, not yet a runnable program), then ask the disassembler, which turns numbers back into text, what it sees. On macOS object files use Apple's **Mach-O** format, which stores code in a named **section**, `__TEXT,__text`.

```sh
clang -c three.s -o three.o
objdump -d three.o
```

```text
three.o:	file format mach-o arm64

Disassembly of section __TEXT,__text:

0000000000000000 <ltmp0>:
       0: d2800540     	mov	x0, #0x2a               ; =42
       4: d4000002     	hvc	#0
       8: 14000000     	b	0x8 <ltmp0+0x8>
```

There are our three numbers in the second column. (The disassembler printed `movz` as `mov`; that renaming is explained under "Reading a disassembly" below.) Now look at the raw bytes of the same section, in the order they sit in the file:

```sh
objdump -s --section=__text three.o
```

```text
three.o:	file format mach-o arm64
Contents of section __TEXT,__text:
 0000 400580d2 020000d4 00000014           @...........
```

Same instructions, bytes reversed within each group of four. Keep that in mind; we come back to it at the end. First, the vocabulary needed to say what `mov x0, #0x2a` even does.

## Registers: thirty-one boxes and a zero

A CPU does its arithmetic on a handful of very fast storage slots inside the chip, not on memory. An instruction like "add these two numbers" names its inputs and output by slot number. These slots are **registers**.

AArch64, the 64-bit instruction set your Mac runs, has 31 general-purpose registers, numbered 0 to 30. Each holds 64 bits. You can name each one two ways:

- `x5` means all 64 bits of register 5.
- `w5` means the low 32 bits of the same register 5.

They are one box, not two. Reading `w5` ignores the top half. Writing `w5` sets the low half and **clears the top 32 bits to zero**; it never leaves stale bits up there (ARM ARM, DDI 0487, section B1.2.1, "Registers in AArch64 state").

```text
 63                     32 31                      0
+-------------------------+-------------------------+
|        upper half       |           w5            |
+-------------------------+-------------------------+
|<------------------------ x5 --------------------->|
```

*Notice: `w5` is a window onto `x5`; a write through the window zeroes the rest.*

Three more names matter on every page of this course:

- **`pc`**, the program counter: the address of the instruction being executed. It is *not* one of the 31; you cannot write `add pc, pc, #4`. Branch instructions change it, and every other instruction moves it on by 4.
- **`sp`**, the stack pointer. Also not one of the 31 general registers, it is its own register. The **stack** is a region of memory a program uses as scratch space, growing downwards; each function call carves out its own slice, a **stack frame**. (There is in fact a separate `sp` for each privilege level; the system-register section below introduces those levels.)
- **`xzr`** (and `wzr`), the zero register: reads as 0, and writes to it are thrown away. Useful more often than you would guess: `str xzr, [x1]` stores a zero without spending a register on it.

Two of the 31 have jobs by convention. `x30` is the **link register**, `lr`: a call instruction (`bl`, below) writes its return address there, which is the Arm way of remembering "where to come back to" (the `os-basics` primer flagged this: on Arm the return address lands in a register, not on the stack). `x29` is the **frame pointer**, `fp`, which marks the current function's stack frame.

## Register 31 has two meanings

Count the names: `x0` to `x30` is 31 registers, plus `sp`, plus `xzr`. Instructions store a register number in a 5-bit field, which has room for 32 values, 0 to 31. So numbers 0 to 30 are the general registers, and number 31 has to serve both `sp` and `xzr`.

Which one it means is decided by each instruction's definition, field by field; there is no rule you can apply without looking. A pattern that holds for the instructions in this course: in a load or store, the address register's 31 is `sp` and the data register's 31 is `xzr`; `add`/`sub` with a constant treat 31 as `sp`; most other arithmetic and logic (`orr`, `and`, ...) treat it as `xzr`. Let the assembler prove it. Save this as `r31.s`:

File: `r31.s`

```asm
.text
    str  xzr, [x1]
    ldr  x0, [sp]
    add  x0, sp, #0
    orr  x0, xzr, x1
```

```sh
clang -c r31.s -o r31.o
objdump -d r31.o
```

```text
r31.o:	file format mach-o arm64

Disassembly of section __TEXT,__text:

0000000000000000 <ltmp0>:
       0: f900003f     	str	xzr, [x1]
       4: f94003e0     	ldr	x0, [sp]
       8: 910003e0     	mov	x0, sp
       c: aa0103e0     	mov	x0, x1
```

In a load or store, bits 4 to 0 (called **Rt**, the data register) and bits 9 to 5 (called **Rn**, the base register) hold register numbers. In `f900003f` the low five bits are `11111`, 31, as Rt: the data is `xzr`. In `f94003e0`, bits 9 to 5 are `11111`, 31, as Rn: the base is `sp`. The same number, two meanings, decided by the field. "Rt" and "Rn" are only the names Arm gives to bit ranges; they do not decide the meaning by themselves. The last two lines show it: `add` and `orr` both keep a register in a field called Rn, but `add` reads 31 there as `sp` and `orr` reads it as `xzr`. The disassembler prints both as `mov` (more on that renaming below).

> **Security.** When a guest store traps (chapter 07), the exit report includes the number of the data register, in a field Arm calls SRT ("syndrome register transfer"), plus the access size. The guest chose that instruction. If your VMM treats register number 31 there as a real register (or as `sp`), a guest storing `xzr` makes you write whatever happens to sit in your array slot 31 to the device. In that field, 31 is always `xzr`: reads give 0, writes are discarded.

## Who puts what where: AAPCS64

Look at a C function after the compiler is done with it. Save `add.c`:

File: `add.c`

```c
long add3(long a, long b, long c) { return a + b + c; }
int  add32(int a, int b)          { return a + b; }
```

```sh
clang -O2 -c add.c -o add.o
otool -tv add.o
```

```text
add.o:
(__TEXT,__text) section
_add3:
0000000000000000	add	x8, x1, x0
0000000000000004	add	x0, x8, x2
0000000000000008	ret
_add32:
000000000000000c	add	w0, w1, w0
0000000000000010	ret
```

Nobody told `add3` where its arguments are, yet it reads `a` from `x0`, `b` from `x1`, `c` from `x2`, and leaves the answer in `x0`. The 32-bit `add32` does the same with `w0` and `w1`. The **caller** (the function making the call) and the **callee** (the function being called) agree because both follow a published rulebook: the **Procedure Call Standard for the Arm 64-bit Architecture**, **AAPCS64**. The hardware does not enforce any of it; it is a contract between pieces of software.

Two words before the table. A **scratch** register may be overwritten by any function you call, so the caller must not expect its value to survive a call. A **preserved** register must hold the same value after a call as before; a callee that wants to use one saves it first and restores it before returning.

| Registers | Role under AAPCS64 |
|---|---|
| `x0` to `x7` | The first eight integer or pointer arguments. `x0` carries the result back. Also scratch. (A result too wide for one register also uses `x1`; ignore that here.) |
| `x8` | Address where a large result should be written; otherwise scratch, which is why `add3` borrowed it. |
| `x9` to `x15` | Scratch. |
| `x16`, `x17` | Scratch, also used by small code stubs the linker inserts between functions. Safe to ignore in this course. |
| `x18` | Platform register. **Apple platforms reserve it; never use it.** |
| `x19` to `x28` | Preserved: a function that uses them must restore them before returning. |
| `x29`, `x30` | Frame pointer and link register. |

That table is all this course needs from AAPCS64. It matters to us for two reasons. First, chapter 02 reads `x0` after the guest stops and expects 42, because `x0` is where a value "comes back". Second, Arm's rulebook for calls from an OS into firmware or a hypervisor, the SMC Calling Convention (SMCCC), reuses exactly this layout for calls *between privilege levels*: function number in `x0`, arguments in `x1` onwards, result in `x0`. The `smccc` primer builds on this table.

## Every instruction is one 32-bit word

Here is the rule that makes AArch64 pleasant to read: **every A64 instruction is exactly 4 bytes**. No exceptions, no prefixes, no variable lengths (ARM ARM, chapter C4, "A64 Instruction Set Encoding"; the **ARM ARM** is Arm's *Architecture Reference Manual*, document DDI 0487, the official definition of every instruction and register). That is why the addresses in the disassembly go 0, 4, 8, and why "the next instruction" always means `pc + 4`. Chapter 02 leans on this when it asks where the PC points after the guest stops.

Inside each word, bit ranges are **fields**: some bits are fixed and say which instruction this is, others carry register numbers or constants. Decoding is **shift and mask**: shift the word right until the field sits at bit 0, then keep only the field's width of bits (in code, `(word >> 5) & 0xffff` extracts bits 20 to 5). Take our first word, `0xD2800540`, which ARM ARM section C6.2 lists under **MOVZ** ("move wide with zero"):

```text
 31  30 29  28        23  22 21  20                  5  4     0
+---+------+------------+------+---------------------+--------+
|sf | opc  |   100101   |  hw  |        imm16        |   Rd   |
+---+------+------------+------+---------------------+--------+
  1    10      100101      00     0000000000101010     00000
       \___________/
        fixed: MOVZ

as hex:  1101 0010 1000 0000 0000 0101 0100 0000
           D    2    8    0    0    5    4    0
```

*Notice: the constant 42 (`0x2a`) sits in the middle of the word, five bits up.*

- `sf = 1`: 64-bit (`x`, not `w`). A field: `0` would give `movz w0, ...`.
- `opc = 10` and `100101`: fixed bits. `100101` in bits 28 to 23 means "move wide" and `opc = 10` picks the MOVZ flavour, "zero the rest". (`opc = 11` would be `movk`.)
- `hw = 00`: shift the constant left by `hw × 16` = 0 bits.
- `imm16 = 0x2a`: the constant.
- `Rd = 0`: destination register 0, so `x0`.

Check it with arithmetic: `0x2a << 5 = 0x540`, and the fixed top bits give `0xD2800000`; together, `0xD2800540`. One instruction loads at most 16 bits, which is why you will see `movk` ("move wide, keep the other bits") follow a `movz` when a guest builds a full 64-bit constant.

The second word, `0xD4000002`, is **HVC**, "hypervisor call", the instruction a guest uses to ask the hypervisor for something:

```text
 31        24  23 21  20                5  4  2  1 0
+------------+------+-------------------+------+----+
|  11010100  | 000  |       imm16       | 000  | LL |
+------------+------+-------------------+------+----+
                         0x0000                  10
```

The two `LL` bits pick the call: `01` is `svc` (app to kernel), `10` is `hvc` (kernel to hypervisor), `11` is `smc` (to the secure monitor, the most privileged firmware on the chip). Three neighbouring calls, one bit pattern apart; the privilege levels they climb between are introduced in the system-register section below and in chapter 02. The `imm16` field is a free-form number the caller can set; the hardware copies it into the exit report the hypervisor receives, which is the `imm=0x0` you will print in chapter 02.

The third word, `0x14000000`, is **B**, an unconditional branch:

```text
 31  30     26  25                                  0
+---+---------+-------------------------------------+
| 0 |  00101  |                imm26                |
+---+---------+-------------------------------------+
                            0 (offset 0)
```

The target is *this instruction's own address* plus `imm26 × 4` (signed). The offset counts instructions, not bytes: every instruction is 4 bytes, so a byte offset would always end in two zero bits, and storing it divided by 4 buys two more bits of reach (±128 MiB). An offset of 0 means "branch to myself": the assembler spelling `b .` (dot is "here") is an infinite loop, our guest's way of parking. Setting bit 31 gives **BL**, branch with link, which also writes `pc + 4` into `x30`. `ret` is a branch to the address in `x30`.

> **Predict.** In the disassembly the branch prints as `b 0x8`, but the word says the offset is 0. Where did 8 come from?

The disassembler did the addition for you: offset 0 from the branch's own address, 8, is address 8. Disassemblers print *targets*, not raw offsets; when you decode by hand, remember to add the instruction's address.

## The dozen instructions in our traces

You do not need to know the instruction set. You need to read about a dozen instructions, because these are the ones that cause VM exits (traps into our VMM), appear in our guests, or show up in chapter 07's and chapter 21's decoders. Treat the table as a map: sign extension, the `!` writeback and the `mov` spelling are explained in the subsections after it. The word in the last column is what `clang` produced on the reference Mac (operands as shown).

| Instruction | Plain meaning | Example word |
|---|---|---|
| `movz x0, #0x2a` (printed `mov`) | Put a 16-bit constant in a register, zero the rest | `d2800540` |
| `ldr w2, [x1]` | Load 4 bytes from the address in `x1` into `w2` | `b9400022` |
| `str w2, [x1, #4]` | Store `w2` to address `x1 + 4` | `b9000422` |
| `ldrsh x3, [x1, #2]` | Load 2 bytes, sign-extend to 64 bits | `79800423` |
| `stp x29, x30, [sp, #-16]!` | Store a pair of registers | `a9bf7bfd` |
| `b .` / `bl` / `ret` | Branch; branch and save return in `x30`; return via `x30` | `14000000`, `d65f03c0` (`ret`) |
| `svc #0` / `hvc #0` / `smc #0` | Call the kernel / hypervisor / firmware | `d4000001`, `d4000002`, `d4000003` |
| `mrs x0, CNTVCT_EL0` | Read a system register | `d53be040` |
| `msr VBAR_EL1, x0` | Write a system register | `d518c000` |
| `wfi` | Wait for interrupt: idle until something happens | `d503207f` |
| `eret` | Return from an exception handler | `d69f03e0` |
| `brk #0` / `udf #0` | Breakpoint / permanently undefined (a deliberate fault) | `d4200000`, `00000000` |

Note the last row: the all-zeros word is `udf`, so a guest that runs off the end of its code into zeroed memory hits an undefined instruction. Chapter 02's "Try it" does exactly that.

### Loads and stores, slowly

Arm is a **load/store** architecture: arithmetic works only on registers, and only loads and stores touch memory. Chapter 07 is about trapping these, so read them carefully.

**Size is in the mnemonic and the register.** `ldrb`/`strb` move 1 byte, `ldrh`/`strh` 2 bytes, `ldr`/`str` with a `w` register 4 bytes, with an `x` register 8 bytes.

**Sign extension.** Loading 2 bytes into a 64-bit register leaves 48 bits to fill. `ldrh` fills them with zeros; `ldrsh` ("signed halfword") copies the top bit of the loaded value. Suppose memory holds the bytes `fe ff`. As a little-endian 16-bit value that is `0xfffe`, then:

```text
ldrh  -> 0x000000000000fffe   (65534)
ldrsh -> 0xfffffffffffffffe   (-2)
```

Same bytes, different register value. Chapter 07's emulator must reproduce this exactly, because the guest kernel trusts it.

**Offsets are scaled.** In `str w2, [x1, #4]` the word holds the offset field as 1, not 4: the hardware multiplies the 12-bit field (`imm12`, bits 21 to 10) by the access size, here 4 bytes. Split `b9000422` and see:

```text
 31 30  29   24  23 22  21              10  9     5  4     0
+------+-------+------+------------------+--------+--------+
| size | fixed | opc  |      imm12       |   Rn   |   Rt   |
+------+-------+------+------------------+--------+--------+
   10   111001    00    000000000001       00001    00010
  4 B           store   1 (x 4 = 4)        x1       w2
```

**Pairs.** `ldp`/`stp` move two registers at once, typically to save `x29` and `x30` on function entry. A trapped `ldp` is the instruction chapter 07 cannot emulate from the exit report alone: the report has room for only one register number, so for pair instructions the hardware marks it as not valid (a bit called ISV is 0) and tells you nothing about the registers. Chapter 21 decodes the instruction itself.

**Writeback.** Some forms also update the base register:

```text
stp x29, x30, [sp, #-16]!   pre-index:  sp = sp - 16, then store at sp
ldp x29, x30, [sp], #16     post-index: load at sp,   then sp = sp + 16
```

*Notice: the `!` means "use the new address, and keep it"; a trailing `, #16` means "use the old address, then add".* Chapter 21's decoder must apply this side effect itself.

## System registers: MRS, MSR and the _ELn suffix

Not everything the CPU knows fits in `x0` to `x30`. Configuration (where the exception table lives), identity (which core am I?), and clocks live in hundreds of **system registers**, each with a long capitalised name. You cannot use them in arithmetic; you copy them in and out with two instructions:

- `mrs x0, NAME` ("move to register from system"): read.
- `msr NAME, x0` ("move to system register"): write.

The suffix says who may touch it. Arm CPUs run code at numbered privilege levels called **exception levels**: EL0 for apps, EL1 for an OS kernel, EL2 for a hypervisor, EL3 for the secure monitor (chapter 02 tells the full story). The rule: a register named `_ELn` cannot be reached from any level below n. Being at level n or above is necessary, not always sufficient: a more privileged level can close access further, and a kernel can, for example, forbid apps to read some `_EL0` registers. So `VBAR_EL1` (Vector Base Address Register, where EL1's exception table lives) is kernel business, and `CNTVCT_EL0` (the virtual counter, a clock) is something an app may read.

Test that claim on your Mac. Save `sysreg.c`:

File: `sysreg.c`

```c
#include <stdio.h>
#include <stdint.h>

int main(void) {
    uint64_t ticks, freq, mpidr;
    __asm__ volatile("mrs %0, CNTVCT_EL0" : "=r"(ticks));
    __asm__ volatile("mrs %0, CNTFRQ_EL0" : "=r"(freq));
    printf("CNTVCT_EL0 = %llu\n", ticks);
    printf("CNTFRQ_EL0 = %llu Hz\n", freq);
    fflush(stdout);
    __asm__ volatile("mrs %0, MPIDR_EL1" : "=r"(mpidr));  /* EL1 only */
    printf("MPIDR_EL1  = %#llx\n", mpidr);
    return 0;
}
```

> **Predict.** Will the third `printf` run?

```sh
clang -O2 sysreg.c -o sysreg
./sysreg
echo "exit status: $?"
```

```text
CNTVCT_EL0 = 225383687722290
CNTFRQ_EL0 = 1000000000 Hz
zsh: illegal hardware instruction  ./sysreg
exit status: 132
```

The counter value differs every run. The frequency is what an M5 Pro reports, 1 GHz; Apple M1 to M3 report 24 MHz (`24000000`), so expect either. The two `_EL0` reads worked. Reading `MPIDR_EL1` (Multiprocessor Affinity Register, "which core am I", chapter 06) from EL0 raised an exception to the kernel, exactly the hardware path of the `os-basics` primer, and macOS answered by killing the process with SIGILL, signal 4; the shell reports 128 + 4 = 132 (the [`unix-signals`](/build-your-own/vmm/primers/unix-signals/) primer explains that arithmetic). Hold on to this picture: in chapter 08, the guest kernel is the one reaching for a register it may not have, and *we* decide what happens.

The instruction word names the register with five small fields, written `S<op0>_<op1>_C<CRn>_C<CRm>_<op2>`. Split `d53be040`:

```text
 31        22  21  20 19  18 16  15  12  11   8  7   5  4    0
+------------+---+------+------+------+------+------+------+
| 1101010100 | L | op0  | op1  | CRn  | CRm  | op2  |  Rt  |
+------------+---+------+------+------+------+------+------+
               1    11    011    1110   0000   010   00000
             read   3      3      14     0      2     x0
```

So `CNTVCT_EL0` is `S3_3_C14_C0_2`. The `L` bit is 1 for `mrs` (read) and 0 for `msr` (write): compare `d518c000`, the `msr` in the table, whose bit 21 is 0. Chapter 08 decodes these for real; for now, know that the name is a label for five numbers (ARM ARM, section C5.1, "The System instruction class encoding space", and the system register descriptions in Part D).

## Reading a disassembly

Put it together on a tiny guest that prints the letter A on a UART, a simple serial port that the guest drives by storing a byte to one address (in our machine, `0x0900_0000`; chapter 09 builds it). Here is the `objdump -d` of a four-instruction version:

```text
0000000000000000 <ltmp0>:
       0: d2a12001     	mov	x1, #0x9000000          ; =150994944
       4: 52800822     	mov	w2, #0x41               ; =65
       8: b9000022     	str	w2, [x1]
       c: 14000000     	b	0xc <ltmp0+0xc>
```

Read it column by column:

1. **Address** (`0`, `4`, ...): offset from the start of the section, in hex. Always steps of 4.
2. **Instruction word** (`d2a12001`): the number the CPU actually decodes.
3. **Mnemonic and operands** (`mov x1, #0x9000000`): destination first, then sources. `#` marks a constant, `[x1]` means "the memory at the address in `x1`".
4. **Comment** (`; =150994944`): the constant again in decimal, a courtesy.
5. **Label** (`<ltmp0>`): a name the assembler made up for the section start; ignore it.

The first word is a `movz` with `hw = 01`: `imm16` is `0x0900`, shifted left by 1 × 16 bits, giving `0x0900 << 16 = 0x0900_0000`. Now the meaning: put `0x0900_0000` in `x1`, put 65 (ASCII `A`) in `w2`, store those 4 bytes at the UART address, park. On real hardware that `str` would reach the device. In our VM, chapter 07 catches it.

One trap for the eye: the disassembler prints the **preferred alias**. `movz` prints as `mov` (with or without a shift); `add x0, sp, #0` printed as `mov x0, sp`; `orr x0, xzr, x1` as `mov x0, x1`. Three different instructions, one spelling. When the spelling and the word disagree, trust the word and the field diagram in ARM ARM section C6.2.

> **Aside.** `otool -tv` (Apple's tool) and `objdump -d` (LLVM's) disassemble the same bytes. `otool` shows your function names (`_add3`) but hides the words; `objdump -d` shows the words. Use whichever answers your question.

## Byte order: the puzzle, solved

A 32-bit number is four bytes, and memory is a row of single bytes. Somebody has to decide which byte of `0xD2800540` goes at the lowest address. **Little-endian** puts the least significant byte first: `40 05 80 d2`. **Big-endian** puts the most significant byte first: `d2 80 05 40`. That is the whole difference, and it is the answer to our opening puzzle: `objdump -s` showed bytes in memory order, `objdump -d` showed the 32-bit number they encode. Both were right.

Make it concrete with a four-byte file:

```sh
printf '\x40\x05\x80\xd2' > word.bin
od -A x -t x1 word.bin
od -A x -t x4 word.bin
```

```text
0000000    40  05  80  d2
0000004
0000000          d2800540
0000004
```

`-t x1` prints bytes in file order; `-t x4` reads them as 32-bit numbers in your Mac's byte order. Apple Silicon runs macOS little-endian (`sysctl hw.byteorder` prints `1234`, meaning "least significant first"). A64 instruction fetches are always little-endian, even on a CPU configured to load and store *data* big-endian (ARM ARM, chapter B2, "Endian support").

Byte order belongs to a **format**, not to a number. Your Mac shows both, side by side:

```sh
xxd -l 4 three.o
xxd -l 4 /bin/ls
```

```text
00000000: cffa edfe                                ....
00000000: cafe babe                                ....
```

`xxd` groups bytes in pairs, so read `cffa edfe` as the four bytes `cf fa ed fe`. A **magic number** is a fixed value at the start of a file that says what format it is. `three.o` is a plain Mach-O file whose magic number `0xfeedfacf` is stored little-endian, so it reads backwards. `/bin/ls` is a "universal" file, one file holding the program built for several CPU types, and that wrapper's header is defined as big-endian, so `0xcafebabe` reads forwards.

This matters twice in macvmm. Chapter 04 writes little-endian helpers for guest memory, because the guest stores numbers the way your Mac does. Chapter 10 builds a Device Tree blob, whose specification says every header field is big-endian, so the same helpers would produce garbage there.

## Lab

:::lab a64-encoder

The `a64-encoder` lab (used in chapter 02, sitting B, exploratory and unscored) shows the bit fields of `movz`, `hvc` and `b`, each field labelled, as in this primer. You type a register number or a constant, watch the bits move, and see the 32-bit word and its little-endian bytes update together. Then try the reverse: paste `d4000003` or `97fffff7` and say what it is before the lab tells you. Skipping it loses nothing; chapter 02 gives you the three words.

## Self-check

Commit to an answer before you open each one.

:::predict After `mov x5, #-1` (all 64 bits set), the CPU runs `add w5, w5, #1`. What is in `x5`?
`0`. The 32-bit add computes `0xffffffff + 1`, which wraps to `0x00000000` in 32 bits, and a write to `w5` clears the top 32 bits too. A common wrong answer is `0xffffffff00000000`: that would need the write to leave the upper half alone, which `w` writes never do.
:::

:::predict A trapped store reports "data register 31, 8 bytes". Which value was stored?
Zero: in the data-register field, 31 means `xzr`. The instruction was `str xzr, [...]`. It would mean `sp` only in a base-register field.
:::

:::predict A C function `long f(long a, long b, long c, long d)` is called with d = 7. Where is 7 on entry, and where must f leave its result?
`d` is the fourth argument, so it arrives in `x3`. The result goes back in `x0`. If f calls another function, it must assume every scratch register (`x0` to `x17` in the table) is overwritten, and preserve `x19` to `x28` if it uses them.
:::

:::predict Split `0xD4000001` into the HVC-family fields. What instruction is it, and what immediate does it carry?
Bits 31 to 24 are `0xD4`, bits 23 to 21 are 0, `imm16` (bits 20 to 5) is 0, and `LL` (bits 1 to 0) is `01`: `svc #0`, the app-to-kernel call. `10` would be `hvc`, `11` `smc`.
:::

:::predict An app runs `mrs x0, SCTLR_EL1`. What happens, and why?
The suffix says EL1: only the kernel (or higher) may access it. At EL0 the read raises an exception to the kernel, and macOS kills the app with SIGILL, exit status 132 from the shell, as `sysreg` showed for `MPIDR_EL1`.
:::

:::predict A file starts with the bytes `d0 0d fe ed`. What is the 32-bit value if the format is big-endian? If it is little-endian?
Big-endian: `0xd00dfeed` (this is the Device Tree magic number, which chapter 10 checks). Little-endian: `0xedfe0dd0`. The reversal, step by step: write the bytes in file order, `d0 0d fe ed`; little-endian means the first byte is the least significant, so read them from last to first, `ed fe 0d d0`, and join: `0xedfe0dd0`.
:::

:::predict Which register does `0xD2800541` write, and with what value?
Only the low five bits (`Rd`) changed from our first word: `00001`, so `x1`. Everything else is the same: `mov x1, #0x2a`.
:::

## Where this shows up in macvmm

- [Chapter 02, first-exit](/build-your-own/vmm/bare-machine/first-exit/): the three words of this primer, `x0` as the result, PC moving by 4, and `hvc`'s `imm16` in the exit report.
- [Chapter 03, test-guests](/build-your-own/vmm/bare-machine/test-guests/): a 15-line `_start` that sets `sp`, zeroes memory with `str xzr`, and calls `main` with `bl`; the debug hypercalls pass their arguments in `x0` and `x1` per the convention.
- [Chapter 04, guest-memory](/build-your-own/vmm/memory/guest-memory/): little-endian read and write helpers.
- [Chapter 07, exit-loop](/build-your-own/vmm/cpu/exit-loop/): load and store sizes, `ldrsh` sign extension, register 31 as `xzr`, and why `ldp` cannot be described by the hardware's report (`crates/vmm/src/arch/esr.rs` and the MMIO path).
- [Chapter 08, traps-psci](/build-your-own/vmm/cpu/traps-psci/): `mrs`/`msr` traps decoded into `S3_x_Cy_Cz_w` names; the [smccc primer](/build-your-own/vmm/primers/smccc/) reuses the AAPCS64 table.
- [Chapter 10, device-tree](/build-your-own/vmm/devices/device-tree/): a big-endian format built by a little-endian program.
- [Chapter 21, firmware](/build-your-own/vmm/firmware/firmware/): decoding `ldr`, `str`, `ldp`, `stp` and their writeback forms ourselves.

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487): B1.2 (registers in AArch64 state), chapter C4 (A64 instruction set encoding), C6.2 (per-instruction pages: MOVZ, HVC, B, LDR (immediate), LDP), C5.1 (the System instruction class encoding space) and Part D's AArch64 system register descriptions. The [`reading-arm-specs`](/build-your-own/vmm/primers/reading-arm-specs/) primer teaches you to navigate it.
- Arm, *Procedure Call Standard for the Arm 64-bit Architecture* (AAPCS64, IHI 0055), section 6.1.1 "General-purpose registers".
- Apple, *Writing ARM64 code for Apple platforms* (developer.apple.com documentation): where Apple departs from AAPCS64, including the reserved `x18`.
- `man otool`, `man od`, `man xxd`, and `objdump --help` on your Mac.

## Checkpoint

**What now works.** You can explain the opening puzzle in one sentence: `objdump -d` prints the 32-bit instruction word, `objdump -s` prints its bytes in memory order, and your Mac stores the least significant byte first. To verify, run `od -A x -t x4 word.bin` from the byte-order section and see `d2800540`, then decode it by hand into `sf=1, hw=0, imm16=0x2a, Rd=0`. Nothing in the repository changes in this primer.

**What's next.** Chapter 02 puts these three words into a virtual machine's memory, runs them, and catches the `hvc` as it leaves the guest. You already know what `x0` should hold when it does; the chapter shows who moved the PC, and why that differs between `hvc` and `smc`.

**One open question.** Every A64 instruction is exactly 4 bytes, so finding "the next instruction" is a matter of adding 4. On x86 an instruction can be anywhere from 1 to 15 bytes long. What would a hypervisor have to do to step over an instruction it trapped, if the hardware did not tell it the length? Guess now; chapter 07 answers it when it reads the exit report.
