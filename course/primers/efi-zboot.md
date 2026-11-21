---
title: EFI zboot: the kernel that is also a program
slug: efi-zboot
kind: primer
minutes: 20
required_by: [13]
labs: [image-inspector]
runs: mac+browser
command: xxd -l 8 .cache/macvmm/vmlinuz-virt
expect: 00000000: 4d5a 0000 7a69 6d67                      MZ..zimg
---

# Why does `file` call our Linux kernel a Windows program?

A VMM has no disk driver and no boot loader in front of it. To start Linux, it must copy the
kernel's bytes into the guest's RAM itself and point the virtual CPU at them. The part of macvmm
that does this is the **loader**, which you write in chapter 13. This primer is about the file the
loader is given, and why it refuses the one Alpine ships.

You ran `scripts/fetch.sh linux`, and `.cache/macvmm/vmlinuz-virt` is now on your disk: Alpine's
own arm64 Linux kernel, hash-checked. "Hash-checked" means `fetch.sh` computed the file's sha256
and compared it with the value recorded for it in `scripts/fetch-manifest.txt`; a value recorded
ahead of time like that is called **pinned**. Ask macOS what the file is:

```sh
file .cache/macvmm/vmlinuz-virt
```

```
.cache/macvmm/vmlinuz-virt: PE32+ executable (EFI application) Aarch64 (stripped to external PDB), for MS Windows
```

A Linux kernel, described as an executable "for MS Windows". And when chapter 13's loader meets
this file, it refuses it with the error `EFI zboot image`. Neither tool is broken. By the end of
this primer you will know what this file really is, why Alpine builds it this way, and how to pull
the kernel we can boot out of it by hand, with `xxd`, `tail`, `head` and `gzip`.

:::prereqs
- You have run `scripts/fetch.sh linux` (chapter 0's setup), so `.cache/macvmm/` holds
  `vmlinuz-virt` and `config-6.18.60-0-virt`.
- [`os-basics`](/build-your-own/vmm/primers/os-basics/): what firmware is (the program the CPU runs first, which loads the OS), and what the
  MMU is.
- [`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/): the 64-byte Image header, `ARM\x64` at offset `0x38`, the DTB, and §3
  "no decompressor".
- [`elf`](/build-your-own/vmm/primers/elf/): why a program file needs a header that says where its pieces go.
:::

Two words from `arm64-boot-protocol` carry this whole primer, so here they are again:

- **Image**, with a capital I, is the arm64 kernel's own uncompressed file format: the bytes a VMM
  copies into guest RAM unchanged. Lowercase "image" is the generic word, as in "PE image" or "EFI
  image": any program file a loader puts in memory. Every Image is an image; most images are not
  Images.
- **`booting.rst`** is the Linux document `Documentation/arch/arm64/booting.rst`. It specifies the
  CPU state the kernel expects at its first instruction: `x0` holds the DTB's address, the MMU is
  off, and so on.

:::objectives
- Explain why Alpine ships a zboot wrapper and why macvmm refuses it.
- Decode the zboot header from a hex dump.
- Find the PE/COFF fields that make a file a UEFI application.
- Describe what a UEFI application receives and how a DTB reaches the OS.
- Unwrap the gzip payload by hand and check its sha256.
:::

## The kernel that cannot unpack itself

Start with a fact from the `arm64-boot-protocol` primer: an arm64 Linux kernel has **no
decompressor** (`booting.rst` §3). On older 32-bit Arm and on x86, the kernel file starts with a
small piece of code that unpacks the rest of the kernel into memory and jumps to it. The arm64
kernel never got one. Whoever loads it must hand it the uncompressed Image, about 36 MB for
Alpine's kernel, already in RAM.

That is fine for a VMM, which can read 36 MB from disk in a blink. It is less fine for a
distribution. Kernels are stored on small boot partitions (the little disk partition the firmware
reads at power-on), downloaded over the network by machines that boot without a disk ("netboot"),
and kept in several versions side by side. A gzip-compressed kernel is about a third of the size.
So somebody has to decompress it, and the question is who.

For years the answer was "the boot loader", the program the firmware starts so that it can find and
start the OS: GRUB or U-Boot would read `Image.gz`, inflate it, and start the result. That works
only if every boot loader knows every compression format the kernel might use. Linux 6.1 added a
different answer. Wrap the compressed kernel inside a small program whose only job is to
decompress it and start it. Make that program a kind that standard arm64 firmware (EDK2, or U-Boot
built with its UEFI support) knows how to run. The kind is a UEFI application, and the wrapper is
called **EFI zboot** (`CONFIG_EFI_ZBOOT`). Alpine's `linux-virt` kernel is built with it; its
config, which `fetch.sh` also downloaded, says so:

```sh
grep -E 'CONFIG_EFI_ZBOOT|CONFIG_KERNEL_GZIP' .cache/macvmm/config-6.18.60-0-virt
```

```
CONFIG_KERNEL_GZIP=y
CONFIG_EFI_ZBOOT=y
```

So `vmlinuz-virt` is a program, not a kernel. It expects to be run by firmware. Our VMM in chapter
13 is not firmware: it loads an Image and points the vCPU at it. That mismatch is the refusal you
saw. To see what we must do instead, we need two ideas the wrapper borrows: UEFI applications, and
the PE/COFF file format they use.

## One page on UEFI applications

Firmware on a PC or an Arm server has to do more than start one program. It must find disks,
read filesystems, show a menu, and then start an operating system it knows nothing about. In the
2000s the industry agreed on a common interface for this, so that one OS loader works on any
compliant machine. That interface is the **Unified Extensible Firmware Interface**, **UEFI**. It is
a specification of function tables and calling rules, not one particular program. Two firmware
programs implement it that this course uses: **EDK2**, the reference implementation, and
**U-Boot**, a firmware common on Arm boards (chapter 21 meets both).

A program that UEFI firmware can run is a **UEFI application**. The firmware loads it into memory,
then calls its **entry point**, the address of its first instruction, as an ordinary function with
two arguments (UEFI 2.10 §4.1). An arm64 CPU passes a function's first arguments in its numbered
registers: the first in `x0`, the second in `x1`, exactly as a compiled C function receives them
(§2.3.6):

```
x0 = ImageHandle    an opaque "this is you" token
x1 = SystemTable    a pointer to the EFI System Table (§4.3)
```

Everything the application can ask of the firmware hangs off that one pointer. Two tables matter
here:

- **Boot services** (§4.4, chapter 7): functions for loading an OS, such as allocate memory, read
  a file, start another image, get the memory map. They exist only until the OS says "I am taking
  over the machine now" by calling `ExitBootServices()` (§7.4). After that call they are gone, and
  the memory they used belongs to the OS.
- **Runtime services** (§4.5, chapter 8): the few functions that stay callable from the running
  OS, such as reading the clock, reading stored firmware settings ("variables", like the boot
  order) and resetting the machine.

The System Table also holds an array of **configuration tables** (§4.6): pairs of a GUID (a
128-bit number used as a unique name) and a pointer. This is how the firmware passes data
structures it built to the OS. On an Arm machine one of them is usually the **DTB** (Device Tree
Blob), the binary description of the hardware that the kernel reads to learn what devices exist
and where (introduced in `arm64-boot-protocol`), under the GUID
`b1b621d5-f19c-41a5-830b-d9152c69aae0`. Hold onto that: it is the UEFI road for the same DTB that
our VMM, following `booting.rst`, simply puts in `x0`.

Here is the whole firmware path for `vmlinuz-virt`, which is the path chapters 21 and 22 take:

```
 firmware (U-Boot's bootefi command, or EDK2)
   |  loads the PE image, calls entry(x0=ImageHandle, x1=SystemTable)
   v
 zboot code inside vmlinuz-virt (it contains the full EFI stub)
   |  allocates memory (boot services), inflates the gzip payload into an Image,
   |  finds the DTB in the configuration tables, calls ExitBootServices()
   v
 the Image's kernel entry, under booting.rst rules: x0 = DTB, MMU off
```

*Caption: three hand-overs, and only the last one follows `booting.rst`. Our VMM jumps straight to
that last line. "MMU off" means the kernel starts with address translation disabled, so every
address it uses is a raw physical address ([`page-tables`](/build-your-own/vmm/primers/page-tables/) explains translation).*

The middle box is where the work happens. The code that collects what the kernel needs from UEFI
(the DTB, the memory map, the initrd), leaves boot services, and enters the kernel under the
`booting.rst` rules is called the **EFI stub** (`drivers/firmware/efi/libstub/`). In the 6.18
kernel used here, zboot links the whole stub into the wrapper: after inflating, it runs the stub
itself and jumps to the Image's kernel entry. You can see the stub's messages in the wrapper's own
bytes, after the payload:

```sh
tail -c +$((0x9ec5c3 + 1)) .cache/macvmm/vmlinuz-virt | strings | grep -E 'DTB from|Exiting boot'
```

```
3ERROR: Ignoring DTB from command line.
6Using DTB from command line
6Using DTB from configuration table
6Exiting boot services...
```

(The leading `3` or `6` is a log level, not part of the text. Where `0x9ec5c3` comes from is shown two
sections down.) The unpacked Image carries a copy of the stub as well, but that copy runs only when
firmware starts a raw Image directly, or in the first zboot releases (6.1 to about 6.3), which
started the inflated Image through the boot services `LoadImage()` and `StartImage()`.
`drivers/firmware/efi/libstub/zboot.c` is the place to read for your kernel. The [`uefi`](/build-your-own/vmm/primers/uefi/) primer
(required by chapter 21) covers the rest of UEFI: the EFI system partition, protocols, and where
`bootefi` and EDK2 fit.

## The PE/COFF header, in the parts that matter

A UEFI application needs a file format that says, as an ELF header does, which bytes go where and
where execution starts. UEFI chose the format Windows uses, **PE/COFF** (Portable Executable,
built on the older Common Object File Format), with its 64-bit "PE32+" variant (UEFI §2.1.1). That
is the whole reason `file` says "for MS Windows": it recognises the format and guesses the most
common platform for it. ("Stripped to external PDB" only means the file carries no Windows debug
symbols.)

A PE file starts with a fossil. Its first two bytes are `MZ`, the signature of 1980s MS-DOS
programs, and the 32-bit value at offset `0x3c` (called `e_lfanew`) is the file offset of the real
header. A UEFI loader reads exactly those two things from the old DOS header and ignores the rest.
At `e_lfanew` it expects:

```
e_lfanew + 0    4 bytes   signature PE\0\0
e_lfanew + 4   20 bytes   COFF header: Machine (2 bytes) first, then the section count, ...
e_lfanew + 24   ...       "optional" header (not optional at all), Subsystem at its byte 68
```

So the optional header starts at `e_lfanew + 4 + 20 = e_lfanew + 24`, and the Subsystem field is
at `e_lfanew + 24 + 68 = e_lfanew + 92`.

> **Aside.** `MZ` are the initials of Mark Zbikowski, who designed the MS-DOS executable format in
> the early 1980s. Every Windows program and every UEFI application still starts with them, and so
> does every arm64 Linux kernel built with an EFI stub; the Try it box at the end of the gzip
> section shows you one.

Three fields decide whether a file is a UEFI application for our CPU (Microsoft *PE Format*,
"COFF File Header" and "Optional Header Windows-Specific Fields"):

| Where | Field | Value here | Meaning |
|---|---|---|---|
| `e_lfanew` + 0 | Signature | `PE\0\0` | "a PE header starts here" |
| `e_lfanew` + 4 | Machine | `0xaa64` | `IMAGE_FILE_MACHINE_ARM64` |
| `e_lfanew` + 92 (optional header + 68) | Subsystem | `10` | `IMAGE_SUBSYSTEM_EFI_APPLICATION` |

Look at the first two in `vmlinuz-virt`. Offset `0x3c` holds `0x40` (you will see it in the next
section), so the PE header is at `0x40`:

```sh
xxd -s 0x40 -l 8 .cache/macvmm/vmlinuz-virt
```

```
00000040: 5045 0000 64aa 0200                      PE..d...
```

`50 45 00 00` is `PE\0\0`. `64 aa` is the machine. PE stores numbers **little-endian**, lowest
byte first, so the two bytes `64 aa` mean `0xaa64`. The last two bytes, `02 00`, are the number of
sections: two. A **section** is a named region of the file that is loaded as one piece: `.text`
holds code, `.data` holds data. The Xcode command-line tools include an LLVM `objdump` that reads
PE/COFF, so you do not have to count to byte 92 by hand:

```sh
xcrun llvm-objdump -p .cache/macvmm/vmlinuz-virt | grep -E 'Magic|AddressOfEntryPoint|Subsystem '
xcrun llvm-objdump -h .cache/macvmm/vmlinuz-virt
```

```
Magic                   020b	(PE32+)
AddressOfEntryPoint     0000000000001028
Subsystem               0000000a	(EFI application)

.cache/macvmm/vmlinuz-virt:	file format coff-arm64

Sections:
Idx Name          Size     VMA              Type
  0 .text         009ed000 0000000000001000 TEXT
  1 .data         00000200 00000000009ee000 DATA
```

`0x20b` marks PE32+, and subsystem 10 is an EFI application (`coff-arm64` is objdump's way of
reporting the `0xaa64` machine). Both `AddressOfEntryPoint` and each section's **VMA** (virtual
memory address) are offsets from wherever the firmware places the image in memory, not absolute
addresses: `.text` lands `0x1000` bytes into the loaded image, and the firmware calls the code
`0x1028` bytes in. A `.text` section of about 10 MB is far too big for a small decompressor. The
compressed kernel is hiding inside it.

## Decoding the zboot header

PE leaves bytes `0x02` to `0x3b` unused, since only `MZ` and `e_lfanew` matter to a UEFI loader.
zboot puts its own small header in that gap (Linux `drivers/firmware/efi/libstub/zboot-header.S`).
That is how a tool can recognise a zboot file and find its payload without running any code.

First, how to read a line of `xxd` output:

```
00000010: 0000 0000 0000 0000 677a 6970 0000 0000  ........gzip....
^offset   ^16 bytes in hex, in pairs                ^the same 16 bytes as text
```

The first column is the file offset of the line's first byte, in hex. The middle shows 16 bytes,
two hex digits per byte, grouped in pairs only for readability (`677a` is the byte `67` followed by
the byte `7a`). The right column prints each byte as a character if it is printable ASCII, and `.`
otherwise. So `67 7a 69 70` at offset `0x18` shows up on the right as `gzip`.

To turn bytes into a little-endian number, reverse them: the bytes `78 ca 00 00` become `00 00 ca
78`, which is `0xca78`.

:::predict Before running the next command, which bytes would you look for to tell a zboot file from a plain PE program, and where would you expect the compressed data's position to be written?
Look for `zimg` at offset 4, right after `MZ`: a plain PE program has no such tag there. The compressed data's offset and size are the two little-endian numbers right after it, at offsets 8 and 12. The dump below confirms both.
:::

```sh
xxd -l 64 .cache/macvmm/vmlinuz-virt
```

```
00000000: 4d5a 0000 7a69 6d67 78ca 0000 4bfb 9d00  MZ..zimgx...K...
00000010: 0000 0000 0000 0000 677a 6970 0000 0000  ........gzip....
00000020: 0000 0000 0000 0000 0000 0000 0000 0000  ................
00000030: 0000 0000 0000 0000 cd23 8281 4000 0000  .........#..@...
```

On the first line, the right column already shows `MZ` and `zimg` as text; the numbers that follow
are not text, so they print as dots and stray letters. Decoded:

| Offset | Bytes | Field | Decoded |
|---:|---|---|---|
| `0x00` | `4d 5a 00 00` | DOS magic | ASCII `MZ` |
| `0x04` | `7a 69 6d 67` | image type | ASCII `zimg`: this is a zboot image |
| `0x08` | `78 ca 00 00` | payload offset | `0xca78` |
| `0x0c` | `4b fb 9d 00` | payload size | `0x9dfb4b` (10,353,483 bytes) |
| `0x10` | 8 zero bytes | reserved | 0 |
| `0x18` | `67 7a 69 70 00` | compression name | ASCII `gzip`, then a 0 byte that ends the string |
| `0x38` | `cd 23 82 81` | Linux PE magic | `0x818223cd` |
| `0x3c` | `40 00 00 00` | `e_lfanew` | PE header at `0x40` |

The answer to the Predict: `zimg` at offset 4 is the tell, and the payload's offset and size sit
right after it. That is exactly the test macvmm's loader makes (`MZ` plus `zimg`) before refusing
the file by name.

Offset and size are 32-bit fields, and whoever made the file chose them. Before using them, add
them in wide arithmetic that reports overflow (Rust's `checked_add` on `u64`) and compare the end
with the real file length. Added in 32-bit arithmetic, a huge size can **wrap around**: the true
sum does not fit in 32 bits, the top bit is dropped, and a small, innocent-looking end offset
comes out.

Compare offset `0x38` with the arm64 Image header from `arm64-boot-protocol`. A raw Image has
`ARM\x64` there; a zboot file has `0x818223cd`. There is no collision: PE itself ignores bytes
`0x02` to `0x3b`, so both formats are free to put their own magic at `0x38`, and a loader that
checks for `ARM\x64` will never mistake one for the other. Both keep the PE offset at `0x3c`,
because both must also be valid PE files for firmware.

Here is the file laid out end to end. The payload begins at `0xca78` and ends at
`0xca78 + 0x9dfb4b = 0x9ec5c3`, inside `.text`, which occupies file bytes `0x1000` to `0x9ee000`.
zboot's linker script (`drivers/firmware/efi/libstub/zboot.lds`) puts all the code first, the
decompressor and the whole EFI stub, and then read-only data, which starts with the payload and
goes on with the stub's strings and tables:

```
 0x0       0x40      0x1000                 0xca78                  0x9ec5c3         0x9ee000  0x9ee200
 | DOS+zboot| PE hdrs | decompressor+stub code|  gzip payload (Image)  | rodata (strings)  | .data |
 '----------'---------'-----------------------'------------------------'-------------------'-------'
```

*Caption: the kernel is a block of data in the middle of the wrapper's code section, located only
by the two numbers at `0x08` and `0x0c`.*

## gzip, the box inside the box

The payload is a **gzip member** (RFC 1952 §2.2): a 10-byte header, a stream of compressed data,
and an 8-byte trailer. gzip is a container: its header and trailer describe and protect the data,
and an algorithm called **DEFLATE** (RFC 1951) does the actual compressing. The trailer holds a
**CRC32** (a 32-bit checksum of the uncompressed data, which `gzip` checks to catch corruption)
and the uncompressed size.

Carve the payload out using the two numbers from the zboot header: offset `0xca78` and size
`0x9dfb4b`. In the commands below, `mktemp -d` makes a fresh scratch directory and `W` remembers
its path; `$((...))` is the shell's arithmetic, which accepts hex; `tail -c +N` outputs a file
from byte N onward, counting from 1 (hence the `+ 1`); `head -c N` keeps the first N bytes:

```sh
W=$(mktemp -d)
tail -c +$((0xca78 + 1)) .cache/macvmm/vmlinuz-virt | head -c $((0x9dfb4b)) > "$W/payload.gz"
xxd -l 10 "$W/payload.gz"
tail -c 4 "$W/payload.gz" | xxd
```

```
00000000: 1f8b 0800 0000 0000 0203                 ..........
00000000: 0000 2a02                                ..*.
```

The header (RFC 1952 §2.3.1) reads: `1f 8b` the gzip magic, `08` the method (DEFLATE), `00` no
flags (so no file name follows), four zero bytes of modification time (a reproducible build leaves
it blank), `02` "maximum compression", and `03` "made on Unix".

The trailer's last four bytes are **ISIZE**, the uncompressed size modulo 2³²: a 32-bit field
counts only up to 4 GiB, so for a larger output it wraps around and keeps just the remainder. Decode
it step by step. The bytes in file order are `00 00 2a 02`. Reversed, they are `02 2a 00 00`, so
the number is `0x022a0000`. In decimal that is 2·16⁶ + 2·16⁵ + 10·16⁴ = 33,554,432 + 2,097,152 +
655,360 = 36,306,944 bytes. Now inflate it:

```sh
gzip -dc "$W/payload.gz" > "$W/Image"
stat -f %z "$W/Image"
xxd -s 0x38 -l 4 "$W/Image"
shasum -a 256 "$W/Image"
```

```
36306944
00000038: 4152 4d64                                ARMd
a2cecb9b6fdbd83e87bd43c8040de67300d5b8dde1fc50c34714faa272888f17  /var/folders/.../Image
```

The path in the last line will differ on your machine. Everything else should match. The size
agrees with ISIZE. `41 52 4d 64` is `ARM\x64` (`xxd` prints the byte `0x64` as `d`): a raw arm64
Image. And the hash equals the one `scripts/fetch-manifest.txt` pins for `Image-virt`.

You have reproduced, by hand, what the course's `cargo xtask unzboot` tool does. That tool is built
with the chapter 13 loader, and `fetch.sh linux` runs it and
writes `.cache/macvmm/Image-virt` for you. If your `fetch.sh` instead prints
`PENDING Image-virt (needs cargo xtask unzboot, ...)`, your hand-carved file is the same bytes (the
hash proves it): `cp "$W/Image" .cache/macvmm/Image-virt`. Then remove the scratch copy with
`rm -r "$W"`.

> **Try it.** Before removing `$W`, run `xcrun llvm-objdump -p "$W/Image" | grep 'Subsystem '`.
> The unpacked Image also says `EFI application`: it carries its own copy of the EFI stub, the one
> firmware uses when it boots a raw Image directly (the zboot path above uses the wrapper's copy).
> This works because the Image's first instruction is chosen so that its encoding begins with the
> bytes `MZ`. Those bytes are a harmless arm64 instruction to a CPU and a DOS signature to a PE
> loader, so the same file is both a valid arm64 Image and a valid PE program. Then run
> `file "$W/Image"` and see which identity `file` prefers.

> **Under the hood.** The takeaway: the zboot header's payload size is the authoritative length of
> the payload; the gzip trailer is not. You can check that the size field covers the gzip member
> exactly:
>
> ```sh
> gzip -l "$W/payload.gz"
> ```
>
> ```
>   compressed uncompressed  ratio uncompressed_name
>     10353483     36306944  71.4% /var/folders/.../payload
> ```
>
> 10,353,483 is `0x9dfb4b`, the size field. (For compression methods other than gzip, the kernel's
> `Makefile.zboot` appends a 4-byte length that the field leaves out.) The "uncompressed" column is
> just ISIZE read back, and ISIZE is a hint, not a promise: it is written by whoever made the file,
> and nothing forces it to match what the DEFLATE stream actually produces.

## Why unwrap on the host, and not in the VMM

We now have two ways to boot this kernel. One is to be the firmware: implement enough of UEFI to
run the zboot program, which is what U-Boot's `bootefi` does in chapter 21. The other is to unwrap
it once, ahead of time, and give the VMM the raw Image it already knows how to load.

Two terms first. A **trust boundary** is the line between code you trust and data you do not; every
byte that crosses it must be checked. An **entitlement** is a permission macOS stamps into a
program's code signature; macvmm's binary carries `com.apple.security.hypervisor`, which lets it
create VMs ([`codesign-entitlements`](/build-your-own/vmm/primers/codesign-entitlements/) covers this). The program holding that permission is the most
valuable thing to attack on the host.

macvmm unwraps ahead of time for direct boot, and refuses the wrapper with a named error instead
of silently decompressing it. Three reasons:

1. **A decompressor in the VMM is attack surface**, meaning code that hostile input can reach.
   DEFLATE decoders are classic targets for crafted input. The VMM process holds the hypervisor
   entitlement and the guest's memory; it should parse as little as possible.
2. **Unwrapping is a one-time job.** The output never changes for a given input, so `fetch.sh`
   does it once, after the download's sha256 matched, and pins the result's sha256 too.
3. **The refusal teaches.** A loader that guesses what you meant hides the boot chain from you. A
   loader that says `EFI zboot image` sends you here.

> **Security.** A matching hash proves the file is the one the manifest names, not that the file
> is safe to parse; and the unwrapping code must stay correct for any file a future manifest might
> name. So treat it as hostile input anyway. The file's author controls the payload offset and size
> (add them with `checked_add` in 64 bits, and compare against the file length), the compression
> name (accept only `gzip`), and the DEFLATE stream (a few KB of crafted data can inflate to
> gigabytes, a **decompression bomb**: cap the output; macvmm's plan uses 256 MiB). Then check the
> output is an Image (`ARM\x64` at `0x38`) before anything else trusts it. Order matters: verify
> the hash before any tool parses the file, so an unexpected file is rejected before a parser bug
> can be reached.

## Lab

:::lab image-inspector

The `image-inspector` lab (introduced in `arm64-boot-protocol`) gains a zboot mode. Drop
`vmlinuz-virt` onto the page and it highlights `MZ`, `zimg`, the payload offset and size, the
compression name and `e_lfanew` in the hex view, decodes the PE signature, machine and subsystem,
and draws the file map from this primer. It then shows the gzip header and ISIZE of the payload and
explains why the VMM refuses the file. Everything is parsed locally in your browser; nothing is
uploaded. Try a doctored copy whose payload size runs past the end of the file, and see which check
fires.

## Self-check

Commit to an answer before you reveal each one.

:::predict When firmware starts a UEFI application on arm64, what is in x0 and x1, and how could the kernel later find a Device Tree the firmware built?
`x0` holds the image handle and `x1` points to the EFI System Table (UEFI §4.1). The DTB is in the
System Table's configuration tables, under the Device Tree GUID (§4.6). The EFI stub (in 6.18, the
copy linked into the zboot wrapper) finds it there, leaves boot services, and enters the kernel
with `x0` = DTB, as `booting.rst` requires.
:::

:::predict Why does file call vmlinuz-virt an executable "for MS Windows"?
Because it is a PE32+ file, the format Windows uses, and UEFI adopted that same format for its
applications. The subsystem field (10, EFI application) and the machine field (`0xaa64`) are the
truth; "for MS Windows" is `file` guessing the most common home of the format.
:::

:::predict A file starts with 4d 5a, and the four bytes at offset 0x38 are 41 52 4d 64. Is it a zboot wrapper, a raw Image, or neither?
A raw arm64 Image (`ARM\x64` at `0x38`), very likely with an EFI stub, since it also starts with
`MZ`. A zboot wrapper has `zimg` at offset 4 and `0x818223cd` at `0x38`. macvmm loads the first and
refuses the second.
:::

:::predict A zboot header says payload offset 0x1000 and payload size 0xffff_f800, and the file is 10 MB. What must an unwrapper do, and what goes wrong in a careless one?
Refuse it: `0x1000 + 0xffff_f800` is about 4 GiB, far beyond the file length. A careless unwrapper
that does the addition in 32-bit arithmetic gets `0x800` (the sum wraps around), which passes a
check like `offset + size <= len`, after which slicing reads garbage or panics. Use 64-bit
`checked_add` and compare with the real file length.
:::

:::predict The gzip trailer of a payload says ISIZE = 0x00001000. Can the unwrapper allocate 4 KiB and inflate into it?
No. ISIZE is the size modulo 2³² (it wraps at 4 GiB), written by whoever made the file. An honest
4 GiB + 4 KiB output has the same ISIZE, and a malicious file can put anything there. Treat it as a
hint: inflate with a hard output cap, then check the real size and the hash.
:::

:::predict Name two things that must be true before macvmm's fetch script runs gzip on vmlinuz-virt.
The download's sha256 must have matched the value pinned in `scripts/fetch-manifest.txt` (verify
before parse), and the zboot header must have checked out: `zimg` present, offset and size inside
the file with checked arithmetic, compression `gzip`. After inflating, the output must be under the
cap, carry `ARM\x64` at `0x38`, and match the pinned `Image-virt` hash.
:::

## Where this shows up in macvmm

- [Chapter 13, `loaders`](../../linux/loaders/): the loader's format detection recognises `MZ`
  plus `zimg` and refuses with `EFI zboot image`, a configuration error with exit status 2
  (`crates/vmm/src/loader/`); the `cargo xtask unzboot` tool does what you did by
  hand, with checked offsets and an output cap (`crates/xtask/`); `scripts/fetch-manifest.txt`
  pins both `vmlinuz-virt` and the derived `Image-virt`.
- [Chapter 14, `linux-boot`](../../linux/linux-boot/): boots `Image-virt`, the file you
  reproduced by hand.
- [Chapter 21, `firmware`](../../firmware/firmware/): U-Boot's `bootefi` runs a UEFI application,
  taking the full firmware path in the diagram above; the `uefi` primer is required there.
- [Chapter 22, `freebsd`](../../firmware/freebsd/): FreeBSD's loader is also a UEFI application,
  started the same way.

## Going further

- *Unified Extensible Firmware Interface Specification*, version 2.10 (uefi.org): §2.1.1 (UEFI
  images are PE32+), §2.3.6 (AArch64 calling convention), §4.1 to §4.6 (entry point, System
  Table, boot and runtime services tables, configuration tables), §7.4 (`LoadImage`, `StartImage`,
  `ExitBootServices`).
- Microsoft, *PE Format* (learn.microsoft.com, "PE Format"): the MS-DOS stub and `e_lfanew`, the
  COFF file header (`IMAGE_FILE_MACHINE_ARM64` = `0xaa64`) and the optional header's `Subsystem`
  (`IMAGE_SUBSYSTEM_EFI_APPLICATION` = 10).
- RFC 1952, *GZIP file format specification version 4.3*, §2.2 and §2.3 (member layout, header
  fields, CRC32 and ISIZE); RFC 1951 for DEFLATE itself.
- Linux, `drivers/firmware/efi/libstub/zboot-header.S`, `zboot.c` and `Makefile.zboot` (the
  header, the decompressor and its call into the shared stub code); `efi-stub-entry.c` and
  `arm64-stub.c` (the stub itself); `Documentation/arch/arm64/booting.rst` §3 (no decompressor)
  and §4 (the Image header that sits inside).

## Checkpoint

:::checkpoint

**Checkpoint.** You can now look at a kernel file and say what it is. Run
`xxd -l 8 .cache/macvmm/vmlinuz-virt` and see the line that ends in `MZ..zimg` (bytes
`4d5a 0000 7a69 6d67`). You can decode the zboot header, find the PE signature, machine and
subsystem, carve the gzip payload out by offset and size, inflate it, and confirm that the result
carries `ARM\x64` at `0x38` and the sha256 pinned for `Image-virt` (`a2cecb9b…8f17` is the same
`a2cecb9b6fdb…` value printed above, shortened to its first and last characters). There is no code
state to carry forward; chapter 13 assumes `.cache/macvmm/Image-virt` exists, either from
`scripts/fetch.sh linux` or from your hand carve.

**What's next.** Chapter 13 writes the loader that takes `Image-virt` from here: it parses the
64-byte Image header as hostile input, plans where the kernel, DTB and initramfs go, and refuses
the wrapper you now understand with a message that names it.

**One open question.** We unwrap the kernel on the host and pin the result's hash. A firmware boot
in chapter 21 runs the wrapper's own decompressor inside the guest instead. Which of the two puts
the decompressor's bugs on the right side of the trust boundary, and what does each one protect?
Hint: ask which process holds the hypervisor entitlement, and what a bug in the decompressor could
reach in each case.
