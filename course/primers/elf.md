---
title: ELF: the file the linker hands you
slug: elf
kind: primer
minutes: 20
required_by: [13]
also_used_by: [03, 27]
labs: [elf-inspector]
runs: mac+browser
command: head -c 4 target/guests/aarch64-unknown-none/release/hello | xxd
expect: 00000000: 7f45 4c46                                .ELF
objectives:
- Identify an ELF file from its first 16 bytes and decode the class, byte order and machine fields of its ELF header.
- Find the program-header table from the ELF header alone, and decode one 56-byte program header by hand from a hex dump.
- Explain the difference between `p_filesz` and `p_memsz`, and say what a loader does with the bytes in between.
- Explain why a loader reads program headers (segments) and ignores section headers.
- List the checks a loader must make before trusting an ELF file's numbers, and say which arithmetic must be overflow-checked.
---

# Three sizes for one program

Three words first. A **compiler** turns each source file into an *object file* of machine code. A
**linker** joins those object files into one finished program file and decides the memory address
each piece of the program will live at. A **loader** is whatever later copies that program file
into memory and jumps to its first instruction. On your Mac the operating system is the loader for
every app you start. In this course the program is a **guest**: a small program (later, a whole
operating system) that runs inside our virtual machine. macvmm is its loader, and **guest RAM** is
the memory macvmm gives that virtual machine.

Build the test guests (`scripts/build-guests.sh`) and look at `hello`, the tiny guest from chapter
03 that prints a greeting and powers off. The ELF file the linker wrote is 844,736 bytes. The
**flat binary** made from it by `objcopy` (a tool that copies just the program's bytes out of an
ELF file) is 11,610 bytes. That is the file you loaded with macvmm's `--raw` flag ("load these
bytes as they are") in chapter 03. Yet when the guest runs, it uses 535,936 bytes of guest RAM.
That is three different sizes for one program, and the largest is not the one that runs. Which of
these numbers does a loader need, and where does it find them? By the end of this primer you will
read all three out of the file by hand, from a hex dump.

:::objectives
- Recognise an ELF file and decode its header's class, byte order and machine.
- Find and decode a program header by hand.
- Explain `p_filesz` versus `p_memsz` and the zero-filled gap.
- Explain why loaders use segments, not sections.
- List a loader's validity checks and the sums that must be checked for overflow.
:::

:::prereqs
- The [`bare-metal-rust`](/build-your-own/vmm/primers/bare-metal-rust/) primer: sections, the linker script and the flat binary made by
  `objcopy`.
- Chapter 03, where you built the `hello` guest and loaded its flat binary with `--raw`.
- Reading hex and little-endian numbers, from the byte-order section of the
  [`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/) primer.
:::

## Why a program file needs a header at all

In chapter 03 the guest was a **flat binary**: raw bytes with nothing else, the exact bytes of
memory starting at the first instruction. That works because we agreed out of band, on the command
line, where to put it (`@0x40080000`) and where to start (the first byte). A flat binary cannot say
either thing itself. It also cannot say "and after these bytes, reserve 512 KiB of zeroed memory for
my stacks" (a **stack** is the scratch memory a running function uses for its local variables),
because it has no room for any sentence at all. It is only the bytes.

A real program file needs to carry a little description next to the bytes: which pieces of the
file go to which addresses, how much memory each piece needs, which ones are code, and where
execution begins. The usual format for that description is the **Executable and Linkable Format**,
**ELF**. It arrived with Unix System V Release 4 around 1989, and during the 1990s it became the
format used by almost every Unix-like system. Linux, FreeBSD and the bare-metal Rust
target we use all produce ELF. The Linux kernel's own build produces an ELF file called `vmlinux`
before it is flattened into the `Image` we boot in chapter 14.

Your Mac does not use ELF for its own programs. It uses a different format, Mach-O, so the tools
macOS ships for inspecting binaries mostly speak Mach-O. You can see both formats side by side with
`file`:

```sh
file target/guests/aarch64-unknown-none/release/hello
file /bin/ls
```

```
target/guests/aarch64-unknown-none/release/hello: ELF 64-bit LSB executable, ARM aarch64, version 1 (SYSV), statically linked, with debug_info, not stripped
/bin/ls:                                          Mach-O universal binary with 3 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64e:Mach-O 64-bit executable arm64e] [arm64e.x1:Mach-O 64-bit executable arm64e.x1]
```

(Further `/bin/ls (for architecture ...)` lines follow; the list of architectures can differ on
your macOS version.) Every word of the first line is something the ELF header says, and we are about
to find each one in the bytes.

> **Aside.** Mach-O, ELF and Windows' PE/COFF solve the same problem with different layouts. Our
> guests are ELF because the `aarch64-unknown-none` target's linker (`rust-lld`) emits ELF. The
> [`efi-zboot`](/build-your-own/vmm/primers/efi-zboot/) primer meets PE/COFF, because UEFI applications use it.

## The tools: `xxd` and `llvm-readobj`

We will read the file twice: once raw, with `xxd` (a hex dumper that ships with macOS), and once
decoded, with `llvm-readobj` (an ELF-aware reader). macOS has no `readelf`, but our pinned toolchain
installs LLVM's tools through the `llvm-tools` component (see `rust-toolchain.toml`). From the repo
root, set two shell variables:

```sh
READOBJ="$(rustc --print sysroot)/lib/rustlib/aarch64-apple-darwin/bin/llvm-readobj"
H=target/guests/aarch64-unknown-none/release/hello
```

The flag `--elf-output-style=GNU` makes `llvm-readobj` print the same layout as the classic GNU
`readelf`, which is what most documentation on the web shows. Your numbers below will differ
slightly from ours if `guests/` has changed since we wrote this (sizes and offsets move as code is
added); the field names, the magic bytes and the overall shape will not.

## The first 64 bytes: the ELF header

Every ELF file starts with a fixed-size **ELF header**: 64 bytes for 64-bit ELF. Here they are:

```sh
xxd -l 64 "$H"
```

```
00000000: 7f45 4c46 0201 0100 0000 0000 0000 0000  .ELF............
00000010: 0200 b700 0100 0000 0000 0840 0000 0000  ...........@....
00000020: 4000 0000 0000 0000 40e0 0c00 0000 0000  @.......@.......
00000030: 0000 0000 4000 3800 0400 4000 0e00 0c00  ....@.8...@.....
```

How to read `xxd` output: each line shows 16 bytes of the file. The first column is the offset of
the line's first byte, in hexadecimal (base 16; this primer writes hex numbers with a `0x` prefix,
so `00000010` is offset `0x10` = 16). Then come the 16 bytes as two-digit hex values, grouped in
pairs for readability only: `7f45` is the two bytes `7f` and `45`. The last column shows each byte
as an ASCII character where it is a printable one, and a `.` where it is not. That is why `ELF`
appears at the right of the first line.

The first 16 bytes are called `e_ident` ("identification"), and they are designed to be read before
you know anything else about the file, one byte at a time:

| Offset | Bytes | Field | Meaning |
|---|---|---|---|
| 0 to 3 | `7f 45 4c 46` | magic | `0x7f` then the ASCII letters `E`, `L`, `F` |
| 4 | `02` | `EI_CLASS` | `ELFCLASS64`: 64-bit addresses and sizes (`01` would be 32-bit) |
| 5 | `01` | `EI_DATA` | `ELFDATA2LSB`: little-endian (`02` would be big-endian) |
| 6 | `01` | `EI_VERSION` | `EV_CURRENT`, the only version there has ever been |
| 7 | `00` | `EI_OSABI` | System V (printed `SYSV`), the "no particular OS" value |
| 8 | `00` | `EI_ABIVERSION` | 0 |
| 9 to 15 | zeros | `EI_PAD` | reserved padding |

An **ABI** (application binary interface) is a set of rules about how compiled programs look at
the byte level. The written specification for ELF is called the **gABI**, the *generic* System V
ABI. This primer cites its chapters, and "Going further" says where to find it.

The order matters. Byte 4 tells you how big every later address field is, and byte 5 tells you how to
read every later multi-byte number. Until you have read those two bytes, the rest of the file is
noise.

From offset 16 on, the fields are multi-byte integers stored **little-endian**: the least
significant byte comes first, so you read the bytes in reverse order to get the number. The two
bytes `b7 00` are the number `0x00b7`. Here is the hardest one, `e_entry`, the eight bytes at
`0x18`, worked in full:

```
bytes as stored, offset 0x18 to 0x1f:   00 00 08 40 00 00 00 00
reversed (most significant first):      00 00 00 00 40 08 00 00
as one number:                          0x0000_0000_4008_0000 = 0x4008_0000
```

(The underscores only group digits, as Rust allows.) With that rule, here is the rest of the header
(the offsets are those of the 64-bit layout, gABI chapter 4, "ELF Header"):

| Offset | Field | Size | Bytes | Value |
|---|---|---|---|---|
| `0x10` | `e_type` | 2 | `02 00` | 2, `ET_EXEC`: a fully linked executable whose addresses the linker has already fixed |
| `0x12` | `e_machine` | 2 | `b7 00` | `0xb7` = 183, `EM_AARCH64` |
| `0x14` | `e_version` | 4 | `01 00 00 00` | 1 |
| `0x18` | `e_entry` | 8 | `00 00 08 40 00 00 00 00` | `0x4008_0000`, the first instruction |
| `0x20` | `e_phoff` | 8 | `40 00 ...` | 64: the program-header table starts at byte 64 |
| `0x28` | `e_shoff` | 8 | `40 e0 0c 00 ...` | `0xce040`: the section-header table |
| `0x30` | `e_flags` | 4 | zeros | no processor-specific flags |
| `0x34` | `e_ehsize` | 2 | `40 00` | 64, the size of this header |
| `0x36` | `e_phentsize` | 2 | `38 00` | 56, the size of one program header |
| `0x38` | `e_phnum` | 2 | `04 00` | 4 program headers |
| `0x3a` | `e_shentsize` | 2 | `40 00` | 64, the size of one section header |
| `0x3c` | `e_shnum` | 2 | `0e 00` | 14 section headers |
| `0x3e` | `e_shstrndx` | 2 | `0c 00` | section 12 holds the section names |

Now check your decoding against the tool:

```sh
"$READOBJ" --elf-output-style=GNU --file-headers "$H"
```

```
ELF Header:
  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00
  Class:                             ELF64
  Data:                              2's complement, little endian
  Type:                              EXEC (Executable file)
  Machine:                           AArch64
  Entry point address:               0x40080000
  Start of program headers:          64 (bytes into file)
  Size of program headers:           56 (bytes)
  Number of program headers:         4
```

(We trimmed the output to the lines we decoded; yours has a few more, including the section-header
fields.) The `e_entry` value is the "where to start" that a flat binary could not carry. It is
`0x4008_0000` because the linker script in `guests/common/link.ld` placed `_start` there, as you saw
in [`bare-metal-rust`](/build-your-own/vmm/primers/bare-metal-rust/).

> **Predict.** The header gives `e_phoff = 64`, `e_phentsize = 56` and `e_phnum = 4`. At which byte
> offset does the third program header start, and at which byte does the whole table end?

Program header *i* (counting from 0) starts at `e_phoff + i × e_phentsize`. The third one is index
2, at 64 + 2 × 56 = 176 = `0xb0`. The table ends at 64 + 4 × 56 = 288 = `0x120`. Keep that formula
in mind: in the Security section below it becomes the first thing a loader must check.

## Program headers: the loader's to-do list

Each **program header** describes one **segment**: a run of bytes from the file, plus the memory it
should occupy. A loader's whole job is to walk this table and act on every entry of type `PT_LOAD`
("loadable segment"). In 64-bit ELF each entry is 56 bytes (gABI chapter 5, "Program Header"):

| Offset in entry | Field | Size | What it says |
|---|---|---|---|
| 0 | `p_type` | 4 | kind of segment; 1 is `PT_LOAD` |
| 4 | `p_flags` | 4 | permissions: bit 0 = X (execute), bit 1 = W (write), bit 2 = R (read) |
| 8 | `p_offset` | 8 | where the segment's bytes start in the file |
| 16 | `p_vaddr` | 8 | the virtual address it should appear at (see "Which address" below) |
| 24 | `p_paddr` | 8 | the physical address, for systems where that differs |
| 32 | `p_filesz` | 8 | how many bytes to copy from the file |
| 40 | `p_memsz` | 8 | how many bytes of memory the segment occupies |
| 48 | `p_align` | 8 | the alignment `p_offset` and `p_vaddr` agree on |

`p_align` exists for operating systems that map a file into memory page by page instead of copying
it: they need the file offset and the address to line up on the same page boundary. A loader that
copies bytes, like ours, can ignore it.

Let's decode the first one by hand. It starts at offset 64 (`0x40`):

```sh
xxd -s 64 -l 56 "$H"
```

```
00000040: 0100 0000 0500 0000 0000 0100 0000 0000  ................
00000050: 0000 0840 0000 0000 0000 0840 0000 0000  ...@.......@....
00000060: f029 0000 0000 0000 f029 0000 0000 0000  .).......)......
00000070: 0000 0100 0000 0000                      ........
```

Reading four bytes, four bytes, then eight at a time, all little-endian: `p_type` = 1 (`PT_LOAD`);
`p_flags` = 5 = R + X (readable, executable: code); `p_offset` = `0x10000`; `p_vaddr` and `p_paddr`
both `0x4008_0000`; `p_filesz` and `p_memsz` both `0x29f0`; `p_align` = `0x10000`. In words: "copy
`0x29f0` bytes from file offset `0x10000` to address `0x4008_0000`, and make them executable."

The tool agrees, and shows all four entries at once:

```sh
"$READOBJ" --elf-output-style=GNU --program-headers "$H"
```

```
Program Headers:
  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align
  LOAD           0x010000 0x0000000040080000 0x0000000040080000 0x0029f0 0x0029f0 R E 0x10000
  LOAD           0x0129f0 0x00000000400829f0 0x00000000400829f0 0x00036a 0x00036a R   0x10000
  LOAD           0x012d60 0x0000000040082d60 0x0000000040082d60 0x000000 0x080020 RW  0x10000
  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 0x000000 RW  0x0
```

(The full output also prints an "Elf file type" preamble and a "Section to Segment mapping" table,
which we come back to in a moment.) Three loadable segments: code, read-only data, and a segment
with no file bytes at all, explained in the next section. The permissions follow a simple safety
rule: code may run but not be written, and data may be written but not run. A bug or an attack
that writes into memory then cannot change the program's instructions, or plant new ones and
jump to them. macvmm's loader uses the flags only to check the entry point (see the checks below).
Enforcing them is the job of the **MMU** (memory management unit, the hardware that translates
addresses and enforces permissions), which the guest controls itself.
`GNU_STACK` is not loadable: it is a note to an operating system's loader
about whether the stack may be executable, and a bare-metal loader ignores it, as it ignores every
type other than `PT_LOAD`.

Here is the file and the memory it becomes, side by side:

```
 file (844,736 bytes)                        guest RAM
 +-------------------+ 0x0
 | ELF header        |
 | program headers   |
 | (padding)         |
 +-------------------+ 0x10000  ---copy--->  0x4008_0000  +----------------------+
 | code   0x29f0     |                                   | code    R X          |
 +-------------------+ 0x129f0  ---copy--->  0x4008_29f0  +----------------------+
 | rodata 0x36a      |                                   | rodata  R            |
 +-------------------+ 0x12d60  (0 bytes)    0x4008_2d60  +----------------------+
 | debug info,       |                                   | BSS     RW           |
 | symbols, section  |          ---zero--->              | 0x80020 bytes,       |
 | headers ...       |                                   | none of them in file |
 +-------------------+ 0xce3c0               0x4010_2d80  +----------------------+
```
*Only the program headers' ranges travel from file to memory; the rest of the file stays behind.*

## `filesz` versus `memsz`: the zeros the file never stores

The third segment says `FileSiz 0x000000` and `MemSiz 0x080020`: take zero bytes from the file,
yet occupy `0x80020` bytes (about 512 KiB) of memory. This is the **BSS** (the traditional name for
a program's memory that must start out as zero, met in `bare-metal-rust`). Our guest's BSS holds its eight 64 KiB stacks (`0x80000`) plus
32 bytes of zero-initialised statics. Storing half a megabyte of zeros in the file would be a waste,
so ELF lets a segment be bigger in memory than in the file.

The rule (gABI chapter 5): `p_filesz` must not exceed `p_memsz`. The loader copies `p_filesz` bytes
from the file to the start of the segment, then fills the remaining `p_memsz − p_filesz` bytes with
zeros. Usually, a segment holding `.data` followed by `.bss` has both a non-zero `filesz` and a
larger `memsz`; ours happens to have no `.data`, so the BSS segment is all zeros.

> **Under the hood.** In chapter 03 our guest's `_start` zeroed the BSS itself, because a flat
> binary loader cannot know the BSS exists. An ELF loader is told, so it can zero the memory before
> the guest runs. macvmm's loader does, and the guest's own zeroing then costs a little time and
> is harmless. Keeping both means the same guest works whichever way it was loaded.

Now the opening puzzle resolves. The **ELF file** is 844,736 bytes because it carries debug
information and symbols that are never loaded. The **flat binary** is 11,610 bytes: the code plus
the read-only data, `0x29f0 + 0x36a = 0x2d5a` = 11,610, and nothing else. You can confirm that
`objcopy` made it by copying those bytes out of the file and nothing more:

```sh
cmp <(tail -c +65537 "$H" | head -c 11610) "$H.bin" && echo same
```

```
same
```

(`tail -c +65537` starts at byte 65,537 counting from 1, which is file offset `0x10000`.) The
**running guest** starts at the first segment's address and ends where the last segment ends, and
the end of a segment is its start address plus its `p_memsz`:

```
end   = 0x4008_2d60 + 0x8_0020 = 0x4010_2d80     (BSS start + BSS memsz)
span  = 0x4010_2d80 − 0x4008_0000 = 0x8_2d80 = 535,936 bytes
```

That range includes the BSS. The number a loader needs is the last one, and only the program headers can
give it to you: the file size is too big, and the flat binary too small.

> **Try it.** Run `stat -f %z "$H.bin"` and compare it with the sum of the first two `FileSiz`
> values on your build. Then add `MemSiz` of the BSS segment to its `VirtAddr` and check that the
> result is where the guest's memory ends.

## Sections versus segments: two views of one file

You may have seen `.text`, `.rodata`, `.bss` in `bare-metal-rust`. Those are **sections**, and they
are a second, separate table in the same file, at `e_shoff`:

```sh
"$READOBJ" --elf-output-style=GNU --section-headers "$H" | head -n 9
```

```
There are 14 section headers, starting at offset 0xce040:

Section Headers:
  [Nr] Name              Type            Address          Off    Size   ES Flg Lk Inf Al
  [ 0]                   NULL            0000000000000000 000000 000000 00      0   0  0
  [ 1] .text             PROGBITS        0000000040080000 010000 0029f0 00  AX  0   0 2048
  [ 2] .rodata           PROGBITS        00000000400829f0 0129f0 00036a 00  AM  0   0 16
  [ 3] .bss              NOBITS          0000000040082d60 012d60 080020 00  WA  0   0 16
  [ 4] .debug_loc        PROGBITS        0000000000000000 012d60 006159 00      0   0  1
```

The two tables answer different people's questions. Sections are the **linker's** view: named,
fine-grained pieces (code, constants, debug info, the symbol table), which the linker shuffles and
merges. Segments are the **loader's** view: a few coarse runs of bytes with addresses and
permissions, usually several sections packed into each. That is the "Linkable" and the
"Executable" in the format's name.

```
 linker's view (sections)         loader's view (segments)
 .text    ---------------------->  LOAD #0  R X
 .rodata  ---------------------->  LOAD #1  R
 .bss  (NOBITS, no file bytes) ->  LOAD #2  RW   (filesz 0)
 .debug_*, .symtab, .strtab        not loaded
```
*Sections are for building, segments for running; a loader needs only the right-hand column.*

A loader must use the program headers, never the section headers. Section headers are optional in
an executable (the gABI lets `e_shnum` be 0, and the program still runs), and they describe things,
like debug info, that are not meant for memory at all. The debug sections, the symbol table and the
section-header table itself lie outside every `PT_LOAD` segment, so no loaded byte comes from them.
The `NOBITS` type on `.bss` is the section
table's way of saying "takes space in memory, none in the file", the same fact that `filesz <
memsz` states in the segment table.

## Which address: `p_vaddr` or `p_paddr`?

Each segment has two addresses. A **physical address** names a real location in RAM. A **virtual
address** is one the program uses that the MMU translates to a physical address, so that each
program can have its own view of memory. `p_vaddr` is where the program expects to *see* the bytes
through its MMU; `p_paddr` is where they physically go, on systems where that is meaningful (gABI
calls it "reserved for systems where physical addressing is relevant"). In our guest they are
equal, because the guest starts with its MMU off, and with no translation every address it uses
is a physical address of guest RAM.

A Linux `vmlinux` is the counterexample: its `p_vaddr` values are high kernel virtual addresses such
as `0xffff8000...`, usable only after the kernel has turned on its own MMU. That is one reason we
boot Linux from the flat `Image`, with its own header ([`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/)), rather than from
`vmlinux`. For our guests macvmm takes the simple, strict line: it requires `p_vaddr == p_paddr`
and loads at that address.

## A loader's checks: the ELF file is hostile input

Everything you decoded above is a number someone else wrote. In macvmm the ELF comes from a file on
disk that the user pointed at, and the project brief (`CLAUDE.md`) says to treat every such header
as hostile: a crafted ELF is a classic way to attack a loader. Here is what can go wrong, field by
field, in the order a careful loader checks it:

1. **The file is long enough.** At least 64 bytes before reading the header; otherwise every later
   read runs off the end.
2. **`e_ident`.** Magic `7f 'E' 'L' 'F'`, class 64, data little-endian, `EI_VERSION` 1. A 32-bit
   file has a different header layout, and reading it with the 64-bit offsets produces garbage.
3. **`e_type`, `e_machine` and `e_version`.** `ET_EXEC`, `EM_AARCH64` (183), and the 4-byte
   `e_version` at `0x14` equal to 1. An x86 executable is a valid ELF, and would run as nonsense
   instructions.
4. **The program-header table fits.** `e_phentsize` must be 56; `e_phnum` must be small (macvmm caps
   it at 64); and `e_phoff + e_phnum × 56` must not exceed the file length. Both the multiply and the
   add are done with checked arithmetic, because a huge `e_phoff` can wrap a 64-bit sum around to a
   small number that looks fine. A 64-bit integer holds at most `0xffff_ffff_ffff_ffff`; add 1 and
   the result does not fit, so the hardware keeps only the low 64 bits, which are 0. Rust's
   `checked_add` and `checked_mul` return `None` instead of a wrapped result.
5. **For each `PT_LOAD`:** `p_filesz ≤ p_memsz`; `p_offset + p_filesz` (checked) is within the file;
   `p_vaddr == p_paddr`; and `p_paddr + p_memsz` (checked) lies inside guest RAM and does not overlap
   anything reserved or another segment. The loader must know the guest's memory map because it is
   not the only thing writing guest RAM: macvmm also places the **DTB** there (the device tree blob,
   the description of the virtual hardware we hand the guest, built in a later chapter). A segment
   allowed to cover the DTB's slot would silently overwrite it, or be overwritten by it.
6. **The entry point.** `e_entry` must land inside a loaded, executable segment.

> **Security.** The attacker controls every byte of the file, so every offset, length and count
> above. A program header with `p_offset = 0xffff_ffff_ffff_f000` and `p_filesz = 0x2000` makes
> `p_offset + p_filesz` wrap to `0x1000` in unchecked 64-bit arithmetic: a bounds check written as
> `offset + size <= file_len` then passes, and the copy reads far outside the file. A `p_memsz` of
> 2⁴⁰ with a small `p_filesz` costs nothing in the file but asks us to zero a terabyte. Validate
> every sum with overflow checks and every range against the RAM map before copying a single byte,
> and route the copy through macvmm's guest-memory API (built in chapter 04), whose every read and
> write checks that the address range lies inside guest RAM.

> **Production note.** A general-purpose loader, like the one in the Linux kernel's `execve`, also
> handles `ET_DYN` (position-independent executables loaded at a chosen base), `PT_INTERP` (a dynamic
> linker to start first) and `PT_TLS`. Our guests are statically linked at fixed addresses, so
> macvmm accepts only `ET_EXEC` and rejects anything it does not need: every feature a loader
> supports is a feature an attacker can aim at.

## Self-check

Commit to an answer before you reveal it.

:::predict A file starts with the bytes `7f 45 4c 46 01 02 01 00`. What do you know about it, and should macvmm's loader accept it?
It is an ELF file (the magic), 32-bit (`EI_CLASS` = 1) and big-endian (`EI_DATA` = 2). Reject it at
the class byte: a 32-bit file has a different header layout, and our guests are 64-bit
little-endian.
:::

:::predict The 2 bytes at offset `0x12` of an ELF file are `3e 00`. (Hint: `EM_X86_64` is 62; `man 5 elf` lists the others.) What machine is it for, and why does it matter to a loader that only copies bytes?
`0x003e` = 62 is `EM_X86_64`. The loader would happily copy the bytes, and the guest vCPU would
then try to run x86 code as Arm instructions. Checking `e_machine == 183` turns that into a clear
error instead of a mysterious exception.
:::

:::predict Decode these 56 bytes of a program header: `01 00 00 00 06 00 00 00`, then `p_offset = 0x2000`, `p_vaddr = p_paddr = 0x4009_0000`, `p_filesz = 0x100`, `p_memsz = 0x1100`, `p_align = 0x10000`. What does the loader do?
`PT_LOAD` with flags 6 = R + W (read-write data). Copy `0x100` bytes from file offset `0x2000` to
`0x4009_0000`, then write `0x1000` zero bytes from `0x4009_0100` to `0x4009_10ff`. Before that,
check that `0x2000 + 0x100` is within the file and `0x4009_0000 + 0x1100` lies in guest RAM.
:::

:::predict Someone runs `llvm-strip --strip-all` on `hello`, which removes the debug sections and the symbol table. Does the guest still load and run the same way? Why?
Yes. A loader reads only the ELF header and the program headers, and stripping removes only
sections that no `PT_LOAD` segment covers, so the loaded bytes are untouched. Only debuggers and tools that read sections (and symbols) lose anything; that
is why chapter 27 uses the unstripped file.
:::

:::predict A crafted ELF has `e_phoff = 0xffff_ffff_ffff_ffc8` and `e_phnum = 1`, in a 4 KiB file. An unchecked loader computes the table's end as `e_phoff + 56`. What does it get, and what goes wrong?
`0xffff_ffff_ffff_ffc8 + 0x38 = 0x1_0000_0000_0000_0000`, which wraps to 0 in 64 bits. Zero is
less than 4096, so the bounds check passes and the loader reads its program header from an offset
far past the end of the file. With `checked_add` the sum returns `None` and the file is rejected.
:::

:::predict Why does the flat binary `hello.bin` contain no bytes for the BSS, and what had to compensate in chapter 03?
`objcopy -O binary` writes only the bytes that come from the file, and the BSS segment has
`p_filesz = 0`. Nothing tells a flat-binary loader that the BSS exists, so the guest's `_start`
had to zero `__bss_start` to `__bss_end` itself before running any Rust code.
:::

## Lab

:::lab elf-inspector

In the `elf-inspector` lab you drop an ELF file onto the page (it is parsed locally in your
browser; nothing is uploaded) and see its ELF header and program headers decoded, with each field
highlighted in a hex view so you can check your own decoding. The lab draws the file-to-memory
picture from this primer for whatever you drop, runs the loader checks from the Security section
and names the first one that fails. Try it on `hello`, then on a copy where you have patched one
byte (the class, the machine, or a `p_filesz`).

## Where this shows up in macvmm

- [Chapter 03, test-guests](/build-your-own/vmm/bare-machine/test-guests/): the linker writes `hello`
  as an ELF, and `scripts/build-guests.sh` flattens it with `llvm-objcopy -O binary` so the raw
  loader can use it. The chapter links here once, for the forward definition of ELF.
- [Chapter 13, loaders](/build-your-own/vmm/linux/loaders/) (requires this primer): you write the
  ELF64 loader in `crates/vmm/src/loader/elf.rs`, with the checks of this primer, a corpus of
  hostile files (truncated `e_ident`, ELFCLASS32, `e_machine ≠ 183`, `e_phnum = 65535`,
  `p_filesz > p_memsz`, a segment over the DTB slot), and `--kernel` auto-detecting ELF versus an
  arm64 Image.
- [Chapter 27, debug-perf](/build-your-own/vmm/production/debug-perf/): the debugger sets a
  breakpoint on `guest_main` in the `hello` ELF (our guests have no `main`; `_start` calls
  `guest_main`), which works because the symbol table and debug sections that a loader ignores are
  still in the file.

## Going further

- *System V Application Binary Interface*, generic ABI ("gABI"), chapter 4, "Object Files" (the ELF
  header, `e_ident`, sections) and chapter 5, "Program Loading and Dynamic Linking" (program headers,
  `PT_LOAD`, `p_filesz` versus `p_memsz`). The 64-bit field layout is the one used throughout.
- Arm, *ELF for the Arm 64-bit Architecture (AArch64)* (document IHI 0056, "aaelf64"), the
  processor supplement: `EM_AARCH64` = 183, and Arm's relocation types and flags.
- `man 5 elf` from the Linux man-pages project (readable online at man7.org): every field and
  constant name in one page, with the C struct definitions.
- Linux, `Documentation/arch/arm64/booting.rst`, to see why the kernel boots from the `Image`, with
  its own 64-byte header, rather than from the ELF `vmlinux`.

## Checkpoint

- **What you can do now.** Run `head -c 4 target/guests/aarch64-unknown-none/release/hello | xxd`
  and see `00000000: 7f45 4c46                                .ELF`. Decode an ELF header and a
  program header from a hex dump, explain the zero-filled gap between `p_filesz` and `p_memsz`, and
  list the checks a loader makes before trusting any of it.
- **What's next.** Chapter 13 turns this primer into code: a loader that reads program headers,
  rejects hostile ones with named errors, and copies segments into guest RAM. It then meets a second
  format, the arm64 Image, whose header is simpler and every bit as untrustworthy.
- **One open question.** Our loader refuses two `PT_LOAD` segments that overlap in memory. A real
  linker never produces that, so why bother refusing it? What could a malicious file achieve if a
  later segment were allowed to overwrite an earlier one? (Hint: think about which segment holds the
  code, and which bytes the checks above actually inspected.)
