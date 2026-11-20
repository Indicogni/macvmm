---
title: U-Boot: the firmware we run first
slug: u-boot
kind: primer
minutes: 20
required_by: [21]
also_used_by: [22]
labs: [boot-chain]
runs: mac+browser
command: strings .cache/macvmm/u-boot.bin | grep -m1 '^bootcmd='
expect: bootcmd=bootflow scan -lb
objectives:
- Read the first 48 bytes of `u-boot.bin` and explain why a flat binary with no file header can run from address `0x0` with `PC = 0`.
- List, in order, what U-Boot does between its first instruction and the `=>` prompt, and match each step to a line of its boot banner.
- Read, set and run environment variables (`printenv`, `setenv`, `run`, `bootcmd`, `bootdelay`), and say where `saveenv` writes and why that matters to a VMM.
- Use `virtio scan`, `virtio info`, `bdinfo` and `fdt` to check what U-Boot believes about the machine, and trace each belief back to the DTB.
- Contrast `booti` and `bootefi` by who sets up the kernel's entry state and how the DTB is handed over, and say which one FreeBSD's `loader.efi` needs.
---

# What does a 1.4 MB file with no header do at address zero?

Ask macOS what U-Boot is, and it guesses wrong:

```text
.cache/macvmm/u-boot.bin: PCX ver. 2.5 image data bounding box [8223, 54531] - [0, 0], 254 planes each of 20-bit uncompressed
```

It is not a picture. It has no ELF header, no Mach-O header, no PE header: nothing that says
where it wants to be loaded or where it starts. Yet put those 1,453,944 bytes in the virtual
machine's **flash** (non-volatile memory, like the chip that holds a PC's firmware; the VM maps it
at address `0x0`), set the **PC** (program counter: the address of the next instruction the CPU
will run) to zero, and a second later it prints a banner, counts down from 2, searches for an
operating system, and finally asks you a question: `=>`. How does a headerless blob know where RAM
is, which disks exist, and how to start an OS it has never heard of? And why does QEMU, running
this same file on Apple's hypervisor, crash before it prints a single byte?

:::prereqs
- The [`uefi`](/build-your-own/vmm/primers/uefi/) primer. Assumed: an **EFI application** is a program that runs on top of firmware and calls it through a table of functions; the firmware hands it the DTB through the **configuration table** (a list of "here is a well-known data structure" pointers); the application calls `ExitBootServices` when it takes the machine over.
- The [`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/) primer. Assumed: a Linux kernel starts with the DTB's address in register `x0`, the MMU and caches off.
- Chapter 07. Assumed: when a guest touches a device address (**MMIO**, memory-mapped I/O), the CPU stops the guest and reports to the VMM what the access was; the **ISV** bit says whether that report is complete.
- Chapter 10. Assumed: the **DTB** (Device Tree Blob) is a data file the VMM writes into guest RAM describing the machine's hardware, and each node's `compatible` string names the driver it needs.
- The [`smccc`](/build-your-own/vmm/primers/smccc/) primer, for one paragraph: **PSCI** is the standard set of "power off / reset / start a CPU" requests a guest makes with the `hvc` instruction.
:::

:::objectives
- Explain why a flat binary can run from `0x0` with `PC = 0`.
- Match each line of U-Boot's banner to what it is doing.
- Read, set and run environment variables, and say where `saveenv` writes.
- Check U-Boot's view of the machine with `virtio`, `bdinfo` and `fdt`.
- Contrast `booti` and `bootefi`.
:::

## Get the binary and look at byte zero

The project pins U-Boot 2026.04 for the `qemu_arm64` board, taken from Alpine's package and
checked by sha256 (chapter 13's Aside explains the pinning). From the repository root:

```sh
scripts/fetch.sh uboot
```

If the script reports `PENDING u-boot.bin`, the extraction step (`cargo xtask extract-apk`) has
not landed yet; take the file out of the verified package by hand. An Alpine package is a gzip'd
tar archive, so `tar` reads it:

```sh
mkdir -p .cache/macvmm/uboot-apk
tar -xzf .cache/macvmm/u-boot-qemu-2026.04-r1.apk -C .cache/macvmm/uboot-apk usr/share/u-boot/qemu_arm64/u-boot.bin
cp .cache/macvmm/uboot-apk/usr/share/u-boot/qemu_arm64/u-boot.bin .cache/macvmm/u-boot.bin
shasum -a 256 .cache/macvmm/u-boot.bin
```

```text
e0155e525781e6f781eb90a8dbd680c9ecb53b21081fffdc636c8a7da63f7f12  .cache/macvmm/u-boot.bin
```

The hash must match exactly; it is the one in `scripts/fetch-manifest.txt`. Now the first 48
bytes:

```sh
xxd -l 48 .cache/macvmm/u-boot.bin
```

```text
00000000: 0a00 0014 1f20 03d5 0000 0000 0000 0000  ..... ..........
00000010: 782f 1600 0000 0000 4052 1300 0000 0000  x/......@R......
00000020: 6856 1400 0000 0000 5300 0014 a0fe ff10  hV......S.......
```

Byte zero is code. Every arm64 instruction is one 4-byte word, so decode the first one step by
step ([`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/) covers byte order):

1. **Reverse the bytes.** `xxd` shows `0a 00 00 14` in file order. arm64 is little-endian, so the
   first byte is the *lowest* one: the word is `0x1400000A`.
2. **Write it in binary:** `0001 0100 0000 0000 0000 0000 0000 1010`.
3. **Split it.** The top six bits, `000101`, are the opcode for `B`, an unconditional branch (a
   jump). The low 26 bits, `00 0000 0000 0000 0000 0000 1010`, are the offset: 10.
4. **Scale it.** The offset counts instructions, not bytes, and each instruction is 4 bytes:
   10 × 4 = 40 bytes, `0x28`.
5. **Add it to the branch's own address.** A branch offset is *relative to the branch
   instruction itself*, not to the start of the file. This branch sits at `0x0`, so it lands at
   `0x0 + 0x28 = 0x28`, skipping the 36 bytes between the end of the branch (`0x4`) and `0x28`.

U-Boot's source calls the code at `0x28` `reset`: the real entry point. (The first byte, `0x0A`,
is also why `file` was fooled: PCX images start with that byte.)

What does it jump over? U-Boot's arm64 entry file (`arch/arm/cpu/armv8/start.S`) puts four
64-bit values right after the branch, aligned to 8 bytes, with a `nop` (`0xD503201F`) as padding:

| Offset | Value | Name in `start.S` | Meaning |
|---|---|---|---|
| `0x08` | `0x0` | `_TEXT_BASE` | the address this build was linked to run at |
| `0x10` | `0x162F78` | `_end_ofs` | image size: 1,453,944 bytes, the file size |
| `0x18` | `0x135240` | `_bss_start_ofs` | where zero-initialised data starts |
| `0x20` | `0x145668` | `_bss_end_ofs` | where it ends |

Two terms in that table. **Linked to run at** means this: when the program was built, the linker
fixed the address of every function and variable, and wrote some of those addresses into the code
as plain numbers. The program only works if it sits at the address the linker assumed. **bss** is
the area for variables that start as zero: the file does not store those zeros, it only records
where the area begins and ends, and the program clears it at start-up. The size and bss fields
exist so U-Boot's own code knows how much of itself to copy and what to clear.

`_TEXT_BASE = 0` is the answer to the first half of the puzzle. Nobody has to tell U-Boot where
it starts, because this build was made for one machine: QEMU's `virt` board, whose flash sits at
address `0x0` and whose CPU starts at `PC = 0`. The binary is a **flat binary**, an exact image
of memory from its first byte, like the one [`bare-metal-rust`](/build-your-own/vmm/primers/bare-metal-rust/) produced with `objcopy`. The deal
between the machine and the firmware is the **QEMU-`virt` firmware boot protocol**: firmware in
flash at `0x0`, the PC at zero, and the Device Tree at the start of RAM, `0x4000_0000`. Chapter
21 implements it in macvmm; here we only need to know that it exists, and that the header is the
contract, not the file.

## What a firmware program must do before it can help you

The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer gave a two-sentence definition: firmware is the program the CPU runs
first; it sets up the machine, then loads and starts the kernel. U-Boot ("Das U-Boot", the
Universal Boot Loader) is a firmware of that kind, widely used on Arm boards. Running before any
OS means starting with almost nothing: the MMU is off, no stack has been set up (its first
instructions point the stack pointer at a small scratch area), and the program is sitting in
flash, which it can read and execute but not write.

From that starting point, U-Boot works through a fixed list. We can watch it, because each step
prints a line. Here is the start of a real boot on QEMU (how to run it yourself follows in the
next section), trimmed of blank lines and of two lines that say this machine has no USB
controller and no network card:

```text
U-Boot 2026.04 (Apr 21 2026 - 09:17:42 +0000)
DRAM:  512 MiB
using memory 0x5e65a000-0x5f69a000 for malloc()
Core:  51 devices, 14 uclasses, devicetree: board
Flash: 64 MiB
Loading Environment from Flash... *** Warning - bad CRC, using default environment
In:    serial,usbkbd
Out:   serial,vidconsole
Err:   serial,vidconsole
Hit any key to stop autoboot: 2
```

Line by line, in the order printed:

1. `U-Boot 2026.04 (...)`: the version and build date. Nothing has happened yet.
2. `DRAM: 512 MiB`: **learn the machine.** U-Boot reads the DTB the machine placed at the start
   of RAM, and the RAM size comes from its `/memory` node. There is no probing of RAM by trial
   and error; the DTB is believed.
3. `using memory ... for malloc()`: **move into RAM.** Flash is read-only, so U-Boot copies itself
   to the top of RAM and continues there. This line shows the heap (the area `malloc()` hands out)
   it set up just below its new home.
4. `Core: 51 devices, 14 uclasses, devicetree: board`: **bind drivers.** `devicetree: board`
   means "the board handed me a Device Tree" (rather than one built into U-Boot). The counts come
   from U-Boot's **driver model**: for each DTB node, it looks for a driver whose `compatible`
   string matches (`arm,pl011` for the UART, `virtio,mmio` for each virtio slot, `cfi-flash`,
   `arm,psci-1.0`), the same matching you met in chapter 10. A **uclass** is a category of device
   (serial, block, ethernet...). The exact numbers do not matter; they change if the DTB changes.
5. `Flash: 64 MiB`: the flash driver found the flash chip the DTB describes.
6. `Loading Environment from Flash...`: **load the environment**, U-Boot's saved settings
   (next section). The warning is normal on a fresh machine.
7. `In:`, `Out:`, `Err:`: **pick the console.** These are U-Boot's standard input, output and
   error, as in a Unix program. Input may come from the serial port or a USB keyboard (`usbkbd`);
   output goes to the serial port and to a screen (`vidconsole`) if one exists. Here only `serial`
   is real, so everything goes through the UART.
8. `Hit any key to stop autoboot: 2`: **count down, then boot** whatever the environment says,
   unless you press a key.

> **Under the hood.** "Copies itself to the top of RAM" hides a neat trick. The build is linked
> at `0x0`, so the absolute addresses inside it are wrong once it moves. The image therefore
> carries a list of every place that holds such an address (the relocation table); after copying,
> U-Boot walks the list and adds the distance it moved to each one. Code that copes with being
> moved like this is called **position-independent**. `bdinfo` later reports the new home as
> `relocaddr = 0x5f69a000`.

Here is where everything ends up in a 512 MiB machine. Every address is in guest memory. The rows
marked **VMM** are fixed by the machine map and the DTB, so in chapter 21 macvmm decides them; the
rows marked **U-Boot** are U-Boot's own choices.

```text
VMM     0x0000_0000  flash bank 0: u-boot.bin, run in place until relocation (read + execute)
VMM     0x0900_0000  PL011 UART: the console
VMM     0x0a00_0000  virtio-mmio slots: the disk
VMM     0x4000_0000  start of RAM: the machine's DTB          (fdt_addr)
U-Boot  0x4040_0000  where U-Boot will load a kernel          (kernel_addr_r)
U-Boot  0x4400_0000  where U-Boot will load an initramfs      (ramdisk_addr_r)
U-Boot  0x5e55_9d80  U-Boot's working copy of the DTB         (fdtcontroladdr)
U-Boot  0x5f69_a000  U-Boot itself, after relocation          (relocaddr), up to 0x6000_0000
```

*Caption: notice that U-Boot moves itself and the DTB to the top of RAM, leaving the bottom free
for the OS it is about to load.*

> **Production note.** On a real Arm board, U-Boot is rarely the first code to run. A boot ROM in
> the chip runs first, often loads a small "SPL" stage of U-Boot to set up DRAM, then Trusted
> Firmware-A at EL3 (the CPU's most privileged level), which provides PSCI, and only then U-Boot
> proper. In our VM the VMM plays
> the boot ROM (it fills RAM and flash before the first instruction) and EL3 (it answers PSCI
> calls), so U-Boot starts straight from flash.

## Meet the prompt

> **Optional hands-on.** The rest of this primer shows real transcripts, so you can read it
> without running anything. Following along in QEMU adds about 20 minutes.

macvmm cannot run firmware until chapter 21, so for this primer we borrow a reference machine.
**QEMU** is another VMM, open source and much larger than ours; its `virt` board is the machine
model macvmm copies, address for address, which is why the same `u-boot.bin` runs on both. QEMU can
also run a guest without any hypervisor: its software CPU emulator, TCG, reads and carries out
every guest instruction itself, slowly but faithfully. Install it with Homebrew
(`brew install qemu`); this is the only place in the course it is needed. Make a blank 16 MiB
disk, then boot:

```sh
dd if=/dev/zero of=.cache/macvmm/blank.img bs=1m count=16
qemu-system-aarch64 -M virt -accel tcg -cpu cortex-a72 -m 512M -nographic -nic none -bios .cache/macvmm/u-boot.bin -drive if=none,file=.cache/macvmm/blank.img,format=raw,id=d0 -device virtio-blk-device,drive=d0
```

The flags, one by one: `-M virt` picks the `virt` board; `-accel tcg` uses the software emulator;
`-cpu cortex-a72` emulates a common Arm core; `-m 512M` gives 512 MiB of RAM; `-nographic` sends
the serial console to your terminal instead of a window; `-nic none` leaves out the network card;
`-bios` puts the file in flash at `0x0`; `-drive` names the disk file and `-device
virtio-blk-device` attaches it as a virtio-mmio disk, the same transport macvmm uses. Press Enter during the countdown and you get the prompt, `=>`. Leave
with `poweroff`, or press Ctrl-A then X. Three harmless lines appear before the banner
(`Bloblist at 0 not found` twice, and `alloc space exhausted ptr 400 limit 0`): they come from a hand-off
area for earlier boot stages that this machine does not have.

> **Predict.** You leave the keyboard alone. The countdown reaches 0, and the disk is blank. Step
> 8 said U-Boot then boots "whatever the environment says", and U-Boot is a program that wants to
> stay useful. It could hang, reset and try again forever, or do something else. Which would you
> design, and why?

It goes looking for an OS everywhere it knows, finds nothing bootable, and drops to the prompt
anyway. We will read that search in a moment. First, the commands that show what U-Boot believes
about our machine. `version` names the build:

```text
=> version
U-Boot 2026.04 (Apr 21 2026 - 09:17:42 +0000)

gcc (Alpine 15.2.0) 15.2.0
GNU ld (GNU Binutils) 2.45.1
```

`md` (memory display) reads guest memory. The start of RAM holds the DTB, and its first four bytes
are the DTB magic number from the Devicetree Specification §5.2, big-endian `0xd00dfeed`:

```text
=> md.b 0x40000000 8
40000000: d0 0d fe ed 00 10 00 00                          ........
=> fdt addr 0x40000000
Working FDT set to 40000000
=> fdt header
magic:			0xd00dfeed
totalsize:		0x100000 (1048576)
```

`bdinfo` (board info) summarises the rest; an excerpt:

```text
DRAM bank   = 0x0000000000000000
-> start    = 0x0000000040000000
-> size     = 0x0000000020000000
flashstart  = 0x0000000000000000
flashsize   = 0x0000000004000000
relocaddr   = 0x000000005f69a000
fdt_blob    = 0x000000005e559d80
serial addr = 0x0000000009000000
```

Every one of those numbers came from the DTB: RAM at `0x4000_0000` for `0x2000_0000` bytes
(512 MiB), 64 MiB of flash at zero, the UART at `0x0900_0000`. Under macvmm, these lines are a
read-back of the DTB that our `fdt` module generated. If one is wrong, U-Boot has not misbehaved;
we lied to it.

Disks are not scanned at boot until something asks. `virtio scan` asks the virtio uclass to probe
every `virtio,mmio` node; it prints nothing on success. `virtio info` then lists what it found:

```text
=> virtio scan
=> virtio info
Device 0: QEMU VirtIO Block Device
            Type: Hard Disk
            Capacity: 16.0 MB = 0.0 GB (32768 x 512)
```

32,768 sectors of 512 bytes is our 16 MiB file. U-Boot read that capacity from the device's
configuration space, which chapter 17 implements for macvmm's virtio-blk. The "QEMU" in the name
comes from the device's vendor ID, so under macvmm that word depends on what our device reports.

## The environment: variables that are programs

U-Boot keeps a set of `name=value` strings called the **environment**. Some are settings, some are
addresses, and some are small programs. `printenv` shows them:

```text
=> printenv bootcmd bootdelay boot_targets
bootcmd=bootflow scan -lb
bootdelay=2
boot_targets=qfw usb scsi virtio nvme dhcp
=> printenv fdt_addr kernel_addr_r ramdisk_addr_r
fdt_addr=0x40000000
kernel_addr_r=0x40400000
ramdisk_addr_r=0x44000000
```

`bootdelay` is the countdown in seconds. `bootcmd` is the command line that runs when the
countdown ends: the whole "what to do if nobody is watching" policy is one variable. The `_r`
addresses are agreed places in RAM for loading things, so that commands and scripts do not each
invent their own. You can make and run your own variables; `$name` expands one, and `run` executes
a variable's value as commands:

```text
=> setenv greeting hello
=> echo $greeting from U-Boot
hello from U-Boot
=> setenv twice "echo one; echo two"
=> run twice
one
two
```

Where did the defaults come from? They are compiled into the binary, which is why our front-matter
check finds `bootcmd=bootflow scan -lb` with `strings`. At boot U-Boot first tries to load a
saved environment from a reserved area of flash, checking it with a CRC. Our flash has never been
written, so the CRC fails and the banner says `bad CRC, using default environment`. That warning
is normal on a fresh machine. `saveenv` writes the current environment to that flash area:

```text
=> saveenv
Saving Environment to Flash... Un-Protected 2 sectors
Erasing Flash...
.. done
Erased 2 sectors
Writing to Flash... done
Protected 2 sectors
OK
```

Erasing and writing flash is not a plain memory store: the CPU writes command bytes to the flash
chip (the CFI command set, the common "talk to a flash chip" protocol) and polls its status. QEMU
emulates that chip. macvmm's first flash, in chapter 21, ignores guest writes, and it may not
describe the flash in the DTB at all; which of those paths the chapter took, and what U-Boot says
about it, is recorded in `docs/compat/uboot.md` and is one of the chapter's journal questions.

> **Security.** Everything U-Boot keeps in the environment, and anything it writes to flash, is
> guest-controlled. A guest that could make its writes persist in the VMM's copy of the firmware
> file could change `bootcmd` for every later boot, or corrupt the firmware for the next VM that
> uses the file. macvmm therefore maps flash read-and-execute only, keeps it out of `GuestMemory`
> (so not even a virtio device can write to it), and never writes guest data back to `u-boot.bin`,
> whichever flash path chapter 21 takes (threat model in `docs/security/`).

## Standard boot: how U-Boot finds an OS by itself

`bootcmd` is `bootflow scan -lb`: scan for **bootflows**, list them (`-l`), boot the first that
works (`-b`). U-Boot's **standard boot** has three words worth learning. A **bootdev** is a device
that might hold an OS: a disk, the network, or QEMU's **fw-cfg** (firmware configuration), a
QEMU-only device through which the host can hand the guest a kernel file (U-Boot's driver for it
is called `qfw`). A **bootmeth** is a
way of finding an OS on a bootdev, such as "look for an EFI application at the UEFI default path"
or "look for a boot script". A **bootflow** is a hit: this method, on this device, found this
file. `boot_targets` sets the order in which bootdevs are tried.

```text
=> bootdev list
Seq  Probed  Status  Uclass    Name
---  ------  ------  --------  ------------------
  0   [   ]      OK  qfw       fw-cfg@9020000.bootdev
  1   [ + ]      OK  virtio    virtio-blk#31.bootdev
---  ------  ------  --------  ------------------
(2 bootdevs)
```

`[ + ]` under `Probed` means the driver has already talked to the device; the `virtio scan` above
did that for the disk. Before any scan, it reads `[   ]`.

Here is the autoboot you predicted, with nobody at the keyboard and a blank disk. Escape sequences
and some lines (the scan's opening line, the table's header and footer, and three EFI warnings)
are removed:

```text
Scanning global bootmeth 'efi_mgr':
  0  efi_mgr      ready   (none)       0  <NULL>
** Booting bootflow '<NULL>' with efi_mgr
Loading Boot0000 'virtio 0' failed
EFI boot manager: Cannot load any image
Boot failed (err=-14)
Scanning bootdev 'fw-cfg@9020000.bootdev':
fatal: no kernel available
scanning bus for devices...
Scanning bootdev 'virtio-blk#31.bootdev':
No more bootdevs
(1 bootflow, 1 valid)
=>
```

The escape sequences we removed, `ESC 7 ESC [r ESC [999;999H ESC [6n ESC 8`, are U-Boot's UEFI
console asking your terminal how big it is: the "query" kind of escape sequence that
[`tty-termios`](/build-your-own/vmm/primers/tty-termios/) warned about, here harmless.

Read the log as a search. First, the **EFI boot manager** (`efi_mgr`), the part of U-Boot's UEFI
implementation that keeps a list of saved boot options, tries its options. It has made one for
the virtio disk, `Boot0000 'virtio 0'`, finds nothing to load there, and gives up; `err=-14` is
just U-Boot's generic "could not load" error code. Next, QEMU's `fw-cfg` has no kernel to offer
(macvmm has no `fw-cfg` at all, so that line will not appear). Last, the virtio disk is probed
(`scanning bus for devices...`) and holds no partition with anything bootable. Out of places to
look, U-Boot gives up politely and shows the prompt.

On chapter 22's FreeBSD disk, the same scan finds an **ESP** (EFI system partition, the small FAT
partition where UEFI looks for boot programs) holding `\EFI\BOOT\BOOTAA64.EFI`, the default path
the `uefi` primer described, and boots it with no typing at all.

> **Aside.** Older U-Boot builds, and many tutorials, use `distro_bootcmd`: a chain of
> environment scripts (`bootcmd_virtio0`, `scan_dev_for_boot_part`...) that did the same search
> in the shell language. Standard boot replaced it with C code and the `bootflow` command. If a
> guide tells you to `run distro_bootcmd`, it predates this build.

## Two ways to start a kernel: `booti` and `bootefi`

Once a kernel is in RAM, U-Boot can start it in two ways, and the difference is who sets up the
kernel's entry state.

`booti <kernel> [<initrd>:<size>] <fdt>` starts a raw arm64 Linux `Image`. U-Boot itself plays
the boot loader of the `arm64-boot-protocol` primer, which means doing by hand everything the
kernel's entry contract demands: it checks the Image header's magic number, moves the kernel to an
address that is a multiple of 2 MiB if needed (the kernel requires that), writes the initrd
location into the DTB's `/chosen` node (the node that carries boot-time settings rather than
hardware), puts the DTB address in register `x0`, zeroes `x1` to `x3`, turns its MMU and caches
off, and jumps.
The binary even carries a ready-made line for it, which `strings` finds:
`booti ${kernel_addr_r} ${ramdisk_addr_r}:${filesize} ${fdtcontroladdr}`.

`bootefi <image> [<fdt>]` starts an EFI application, through U-Boot's implementation of the UEFI
interface. The `uefi` primer explained what happens on the other side: a System Table, the DTB in
the configuration table, `ExitBootServices`. FreeBSD's `loader.efi` and Alpine's `vmlinuz-virt`
(an EFI zboot wrapper, a compressed kernel packaged as a PE/COFF file, the Windows-born executable
format UEFI uses) are EFI applications, so they need `bootefi`; `booti` would refuse them,
because they are not raw Images. Here U-Boot does *not* set up the kernel's entry state: it only
puts the DTB in the configuration table. For Linux, the **EFI stub** (a small EFI program built
into the front of the kernel file) takes the DTB from that table, calls `ExitBootServices`, and
itself puts the DTB address in `x0` when it jumps into the kernel. U-Boot carries a tiny EFI application of its own, so you can see
the interface work without any disk:

```text
=> bootefi hello
Booting <NULL>
Hello, world!
Running on UEFI 2.11
Firmware vendor: Das U-Boot
Firmware revision: 20260400
Have device tree
Load options: <none>
```

(Three warnings about EFI variables, a TPM and an RNG come first; this machine has none of those,
and the hello program does not need them.) `Have device tree` is the line to notice: the
application looked in the configuration table and found the DTB that U-Boot put there, which is a
descendant of the one the VMM wrote at `0x4000_0000`.

That word "descendant" is why `fdtcontroladdr` (`0x5e559d80`) differs from `fdt_addr`
(`0x40000000`). U-Boot works on its own copy, and both `booti` and `bootefi` may edit that copy
(adding `/chosen` entries, reserving memory U-Boot still uses) before the OS sees it. In firmware
boot, the DTB the kernel reads is not quite ours.

U-Boot's last job is the one `os-basics` mentioned: power. `poweroff` and `reset` at the prompt
are PSCI calls, made with `hvc` because our DTB's `/psci` node says `method = "hvc"`. U-Boot is a
guest; it asks, and the VMM decides. Chapter 21's checkpoint checks for exactly that: `reset`
prints `resetting ...`, and when macvmm is run with `--on-reset exit` it exits with status 4 (by
default, `--on-reset reboot`, it restarts the VM instead).

## A stricter guest

> **Try it (optional).** If you have QEMU, swap `-accel tcg -cpu cortex-a72` for
> `-accel hvf -cpu host`, so that QEMU runs the guest on the same Hypervisor.framework we use,
> with guest instructions running directly on the real CPU. Predict first: the opening puzzle
> promised a crash. Will it come before or after the banner, and who will report it, U-Boot or
> QEMU? Then run it, and run `echo $?` afterwards.

On this machine (QEMU 11.1.2, macOS 27.2), it prints nothing from U-Boot at all:

```text
Assertion failed: (isv), function hvf_handle_exception, file hvf.c, line 2447.
```

and the exit status is 134. A shell reports "killed by signal N" as 128 + N, and signal 6 is
SIGABRT: QEMU's own `assert` failed and aborted it ([`unix-signals`](/build-your-own/vmm/primers/unix-signals/) has the details). The same file
booted happily under the software emulator.

Recall chapter 07. Under a hypervisor, a guest load or store to a device address cannot complete
on its own: the CPU stops the guest (an **MMIO exit**) and hands the VMM a report, the
*syndrome*, saying which register, how many bytes, and read or write. The VMM performs the access
and resumes the guest. The **ISV** bit ("instruction syndrome valid") says whether that report is
filled in. For some instructions the hardware leaves it empty and ISV is 0. The typical example
is a pair access such as `ldp x0, x1, [x2]` (load two registers at once): the report has room for
only one register number. Instructions that also update their address register, such as
`str w0, [x1], #4` (store, then add 4 to `x1`), are another. QEMU's HVF backend assumes it never
meets such an access to a device. U-Boot makes one, early. The software emulator never noticed,
because it decodes every instruction itself. Chapter 21 covers these forms in detail.

That resolves the second puzzle, and it is the headline of chapter 21: firmware is a stricter
guest than Linux. It touches devices in ways a Linux kernel does not, so it reaches paths in the
VMM that Linux never takes. In chapter 21 you will find the exact instruction with a trace and
write the ISV=0 decoder that QEMU's HVF backend lacks here.

## The puzzle, solved

How does a headerless blob know where it is, what the machine holds and how to start an OS? It
knows where it is because it was built for one machine, whose firmware protocol fixes flash at
`0x0` and `PC = 0`. It learns everything else from the DTB at the start of RAM, binding drivers by
`compatible`, and it finds an OS by searching bootdevs in the order `boot_targets` gives, then
starting it with `booti` or, through its UEFI implementation, `bootefi`. Everything it believes
about the machine, macvmm told it.

## Lab

:::lab boot-chain

In the `boot-chain` lab you step through two boots side by side: direct boot (macvmm loads the
kernel and DTB, `PC` = kernel entry) and firmware boot (macvmm loads U-Boot and the DTB, `PC = 0`,
then U-Boot, `bootefi`, `loader.efi` or the Linux EFI stub, kernel). At each step the lab asks who
loaded what, at which address, and who owns the DTB now; you click the owner and see the copy and
its edits appear. The `uefi` primer embeds the same lab for its part of the chain.

## Self-check

Commit to an answer before you reveal it.

:::predict The countdown ended, nothing booted, and you want U-Boot to run `bootefi hello` by itself on every boot. What do you change, and why might it still not stick on macvmm?
`setenv bootcmd 'bootefi hello'`, then `saveenv` to store it in flash; at the next boot the CRC
check passes and the saved `bootcmd` runs. On macvmm (as this page said, its first flash ignores
guest writes) nothing is stored, so the next boot gets the compiled-in default,
`bootflow scan -lb`, again. Exactly what U-Boot prints on the way depends on which flash path
chapter 21 took (recorded in `docs/compat/uboot.md`): with a flash node in the DTB it reports
`bad CRC` again; with no flash node it never looks in flash at all.
:::

:::predict `printenv fdtcontroladdr` says `5e559d80`, but the VMM wrote the DTB at `0x4000_0000`. Is U-Boot ignoring our DTB?
No. U-Boot relocated itself to the top of RAM and took a copy of the DTB with it; `fdt_blob` in
`bdinfo` shows the same address. `md.b 0x40000000 8` still shows `d0 0d fe ed`: our original is
untouched. Edits U-Boot makes before booting an OS go to its copy, which is what the OS receives.
:::

:::predict You forget the `virtio,mmio` node for the disk slot in the DTB, though the device itself works. What does `virtio info` show?
No block device. U-Boot's driver model binds drivers to DTB nodes by `compatible`; with no node,
no virtio-mmio driver is bound for that slot, so `virtio scan` never reads its registers. The
device exists only if the DTB promises it, exactly as for Linux in chapter 10.
:::

:::predict The word at offset `0x28` of `u-boot.bin` is `0x14000053`. What is it, and where does it go?
Its top six bits are `000101`, so it is `B`. The 26-bit offset is `0x53` = 83 instructions, 332
bytes or `0x14C`. The offset is relative to the branch itself, so it goes from `0x28` to
`0x28 + 0x14C = 0x174`. Offset `0x28` is `reset`, the target of the very first branch at
offset 0, so this is the first thing U-Boot's real entry code does.
:::

:::predict Alpine's `vmlinuz-virt` is on a disk U-Boot can read. Which command starts it, `booti` or `bootefi`, and who puts the DTB address in `x0` for the kernel?
`bootefi`: the file is an EFI zboot wrapper, a PE/COFF application, not a raw Image, so `booti`
rejects it. U-Boot only installs the DTB in the configuration table; the Linux EFI stub inside the
file takes it from there, calls `ExitBootServices`, and puts the DTB address in `x0` when it
enters the decompressed kernel.
:::

:::predict U-Boot boots under QEMU's software emulator but aborts QEMU under `-accel hvf`. Why can the emulator not hit the same problem?
The software emulator decodes every guest instruction itself, so it always knows the register,
size and direction of a device access. Under a hypervisor the instruction runs on the real CPU,
and the VMM learns about a device access only from the exit's syndrome; when ISV is 0 that
syndrome is incomplete, and the VMM must fetch and decode the instruction itself, or fail.
:::

## Where this shows up in macvmm

- [Chapter 21, firmware](/build-your-own/vmm/firmware/firmware/) (requires this primer): flash
  bank 0 at `0x0` holding `u-boot.bin` (`crates/vmm/src/devices/flash.rs`), the QEMU-`virt`
  firmware boot protocol (`crates/vmm/src/loader/firmware.rs`, addresses from
  `crates/vmm/src/arch/layout.rs`), and the ISV=0 path that U-Boot needs. Its checkpoint drives
  the prompt with `version`, `virtio scan; virtio info`, `poweroff` and `reset`.
- [Chapter 22, freebsd](/build-your-own/vmm/firmware/freebsd/): standard boot finds
  `\EFI\BOOT\BOOTAA64.EFI` on a virtio-blk disk and starts FreeBSD's `loader.efi` with `bootefi`.
- [Chapter 10, device-tree](/build-your-own/vmm/devices/device-tree/): every line of `bdinfo` and
  every driver U-Boot binds comes from the DTB built there.
- [Chapter 08, traps-psci](/build-your-own/vmm/cpu/traps-psci/): U-Boot's `poweroff` and `reset`
  arrive as PSCI `SYSTEM_OFF` and `SYSTEM_RESET` over `hvc`.

## Going further

- U-Boot documentation, *Standard Boot* (`doc/develop/bootstd/overview.rst`): bootdevs,
  bootmeths, bootflows and the `boot_targets` order; and *QEMU Arm* (`doc/board/emulation/qemu-arm.rst`),
  the board this binary was built for. Both at https://docs.u-boot.org.
- U-Boot documentation, *Environment Variables* (`doc/usage/environment.rst`) and the command
  pages for `bootefi` and `booti` (`doc/usage/cmd/`).
- QEMU documentation, *'virt' generic virtual platform* (`docs/system/arm/virt.rst`): the
  firmware boot protocol (flash at `0x0`, DTB at the start of RAM) that macvmm reproduces.
- Linux, `Documentation/arch/arm64/booting.rst` §4 (the state `booti` must establish), and Arm's
  *Embedded Base Boot Requirements* (EBBR) for the UEFI subset that `bootefi` provides.

## Checkpoint

- **What you can do now.** Explain why `u-boot.bin` runs from `0x0` with no header, read its
  banner, use the environment, check U-Boot's view of the machine, and choose between `booti` and
  `bootefi`. Verify the pinned binary and its default boot policy:
  `strings .cache/macvmm/u-boot.bin | grep -m1 '^bootcmd='` prints `bootcmd=bootflow scan -lb`,
  and `shasum -a 256 .cache/macvmm/u-boot.bin` prints the hash shown above. There is no code
  state to carry forward.
- **What's next.** Chapter 21 makes macvmm the machine U-Boot runs on: flash at zero, the DTB at
  the start of RAM, `PC = 0`. The first boot will stop where QEMU's HVF backend stopped, at an
  access with no syndrome, and you will write the decoder that gets past it.
- **One open question.** U-Boot edits the DTB before the OS sees it. If our DTB and U-Boot's
  edits disagree, say about which memory is reserved, which should the OS believe, and how would
  you find out which one it did believe?
