---
title: The Device Tree: the VMM's promise to the guest
part: IV
chapter: IV.2
id: 10
runs: mac+browser
minutes: 270
prereqs: [09]
start_tag: ch-09
labs: [dtb-explorer]
command: scripts/checkpoint.sh 10
expect: CHECKPOINT 10 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** why Arm platform devices cannot be probed; the Device Tree (nodes, properties, unit addresses, `compatible`, `reg`, `#address-cells` and `#size-cells`, cells, `/chosen`, phandles); the flattened format (FDT): header, reservation map, structure tokens, deduplicated strings, alignment, the 2 MiB cap, big-endian; driver binding by `compatible`; the DTB as a promise generated from the device table; fresh seeds; handing it over in `x0`.
- **Core, from earlier:** `layout.rs`, the single memory map (chapter 05); the unhandled-MMIO (memory-mapped I/O) policy, `--unhandled-mmio fatal|log` (chapter 05); `MPIDR_EL1`, the register dump and last exits (chapters 06 and 07); PSCI (power state coordination interface) calls over `hvc` (chapter 08); the PL011, the PL031, their PrimeCell identification registers and the `Bus` (chapter 09).
- **Primers (read first):** `arm64-boot-protocol` (what a kernel expects in `x0` and where the DTB goes in RAM); `reading-arm-specs` (finding the header layout in chapter 5 of the Devicetree Specification).
- **Pointers:** PCI enumeration and ACPI (an Aside: why a PC can probe); the kernel command line; fixed clocks and the clock binding; `dtc` as a checking tool; the Devicetree Specification v0.4, chapter 5. For the curious: the AArch64 reading primer (byte order) and the Linux boot sequence primer (how a node becomes a driver).
- **Forward definitions:** interrupt properties and the interrupt controller node (chapter 12); the `--irqchip none` mode (chapter 11); the initramfs range and the kernel command line in `/chosen` (chapter 13); kernel address randomization (chapter 14). Each is defined in a sentence where it first appears.
:::

Move one device. In `layout.rs`, move the PL011 serial port from `0x0900_0000` to `0x0904_0000`, rebuild the virtual machine monitor (VMM), and run two test guests that have not been rebuilt. One dies on its first write to the serial port. The other reports the new address, correctly, without ever having been told. Which one, and where did it learn the address?

This chapter closes row 5 of chapter 00's problem ledger, a description of the machine: a kernel assumes somebody hands it one. Sitting A finds out why and reads a real description byte by byte (about 2 hours: one VMM run, then `dtc`, `grep` and `xxd`). Sitting B builds the writer and the machine's tree, hands it to the guest and breaks it (about 2.5 hours).

:::objectives
- (Sitting A) Explain, with the moved-PL011 runs as evidence, why a general kernel cannot hardcode device addresses and why Arm platform devices cannot be probed.
- (Sitting A) Predict the byte length of a `reg` property from the parent's `#address-cells` and `#size-cells`, then check it in a hex dump of the reference's blob (and of yours, in sitting B).
- (Sitting A) Decode a flattened device tree header by hand (magic, `totalsize`, the three block offsets, version 17, last compatible version 16) and diagnose a corrupted strings offset from what `dtc` reports.
- (Sitting B) Implement a dependency-free writer that emits the header, an 8-byte-aligned reservation map, structure tokens and a deduplicated strings block, all big-endian, and refuses a property after a child, an unbalanced end, a name with a NUL and a blob over 2 MiB.
- (Sitting B) Generate `/memory`, `/cpus`, `/psci` (`method = "hvc"`), `/timer`, the PL011 with its fixed clock, the PL031 and `/chosen` from `layout.rs`, fill the seeds from host randomness, and pass the blob's address in `x0`.
:::

**Before you start.** From the repository root, run `scripts/learner start 10`; it copies this chapter's journal to `learner/journal/10.md`. Sitting A runs the reference from the repository root, where `$G` stands for `target/guests/aarch64-unknown-none/release`. Sitting B is your code, in `learner/`, where you set `G=../target/guests/aarch64-unknown-none/release` as in chapter 09.

## Move one device, break one guest

We ran the opening experiment on the reference. It took two edits in `layout.rs`: `PL011_BASE` to `0x0904_0000`, and `GICR_WINDOW_END`, which the reference defines as `PL011_BASE` (the interrupt controller's window ends where the serial port begins), pinned at `0x0900_0000` so that window does not grow over the PL031. First `dtb-reader`, a test guest that prints what it finds in the machine description it was handed:

:::term source=captures/10-moved-dtb-reader.txt

It reports the serial port at its new address, `pl011@9040000`, which it can only have learned from that description. (It prints through chapter 03's debug hypercall, not through the UART, the universal asynchronous receiver-transmitter, so this run shows it *finding* the device, not driving it.) Now `uart-echo`, chapter 09's guest, which writes to the UART:

:::term source=captures/10-moved-uart-echo.txt

Exit code 3, an unhandled memory-mapped I/O (MMIO) write at `0x900002c`: offset `0x2c` of the *old* address, the PL011's line-control register, the first thing `uart-echo` configures. The register dump from chapter 06 shows the address in `x8`. Nothing answers there any more, so chapter 05's policy stopped the guest. Here is why it wrote there:

:::code anchor=guest_uart_base file=guests/common/uart.rs

`uart-echo` was compiled with the address baked in. That is fine for a test guest built for one board. A kernel that ships to thousands of different boards cannot do it: it would need one build per board, and every board maker who moved a device would need a new kernel.

## Why a kernel cannot look for itself

A tempting way out: let the kernel read every address in the first 4 GiB until something looks like a UART. The first obstacle: an address with no device behind it does not politely answer "nothing here". On real hardware the access can fault or hang the bus, and in our VMM it is the unhandled access you saw above, fatal by default.

The second: even a device that *can* identify itself only does so once you know where to ask. The PrimeCell identification registers of chapter 09 sit at offsets `0xFE0` to `0xFFC` *of the device*. To [probe](/build-your-own/vmm/glossary/#probe) hardware means to find it by asking for it, and the devices on an Arm board's on-chip bus give you nobody to ask.

> **Aside.** A PC can probe, because PCI (Peripheral Component Interconnect, the expansion bus) was designed for it: every PCI device answers at a fixed configuration address with its vendor and device number (PCI enumeration). What PCI cannot find, the firmware describes in ACPI tables (Advanced Configuration and Power Interface, [specification](https://uefi.org/specifications) at the UEFI Forum). Arm servers use ACPI too; embedded Arm boards and our VMM use a device tree.

So someone who knows the machine has to describe it. On a physical board that is the firmware; in a virtual machine it is us. The description is a [**Device Tree**](/build-your-own/vmm/glossary/#device-tree) (DT), and the binary blob a kernel receives is a [**DTB**](/build-your-own/vmm/glossary/#dtb) (device tree blob). The `arm64-boot-protocol` primer gave its address: register `x0`, at the kernel's first instruction. For Linux on arm64 this is not optional configuration: the DTB is its only map of the machine, so a wrong tree is a wrong machine. That answers the opening: `dtb-reader` learned the new address from the DTB, and `uart-echo`, which never looks, died at the old one.

## A tree of nodes and properties

Let us look at one. `--dtb-out` writes the blob a run handed its guest to a file. We add `--irqchip none`, a mode chapter 11 introduces that leaves out the interrupt controller, so the tree matches what you build in this chapter (chapter 12 adds the rest):

:::term source=captures/10-dtb-out-run.txt

The [**dtc**](/build-your-own/vmm/glossary/#dtc) (device tree compiler) turns a blob back into text, its source form ([DTS](/build-your-own/vmm/glossary/#dts), device tree source). Install it with `brew install dtc` (we assume [Homebrew](https://brew.sh); without it, the checkpoint reports its `dtc` step as INFO, and you can follow the hex dumps here instead). It is an independent checker, written by other people, that knows nothing about our VMM; the [dtc repository](https://git.kernel.org/pub/scm/utils/dtc/dtc.git) documents it.

:::term source=captures/10-dtc-dts.txt

Read it as a filesystem. Each [**node**](/build-your-own/vmm/glossary/#device-tree-node) is a directory, `/` is the root, and the nodes are named `name@unit-address`, where the [unit address](/build-your-own/vmm/glossary/#unit-address) repeats the device's first address. Each [**property**](/build-your-own/vmm/glossary/#device-tree-property) is a named value, like a small file. The picture breaks quickly: a node cannot hold data except in properties, and the order of things inside the blob matters, as sitting B shows.

The values are counted in [**cells**](/build-your-own/vmm/glossary/#cell): 32-bit numbers, stored [big-endian](/build-your-own/vmm/glossary/#big-endian), most significant byte first (the opposite of the little-endian order of the AArch64 reading primer). `<0x00 0x9000000 0x00 0x1000>` is four cells.

What a kernel learns from each node:

| Node | Properties that matter | What the kernel learns |
|---|---|---|
| `/` | `compatible = "linux,dummy-virt"`, `model`, `#address-cells = <2>`, `#size-cells = <2>`, `dma-coherent` | a generic virtual board, and its name; how its children write addresses; devices see memory as the CPU does |
| `/chosen` | `stdout-path`, `rng-seed`, `kaslr-seed` | where to print first, and random seeds; settings, not a device |
| `/memory@40000000` | `device_type = "memory"`, `reg` | where RAM is and how much (64 MiB here) |
| `/cpus/cpu@0` | `device_type = "cpu"`, `reg = <0x00>`, `enable-method = "psci"` | one CPU, identity 0, started through PSCI |
| `/psci` | `method = "hvc"` | PSCI calls go through `hvc`, chapter 08's path |
| `/timer` | `compatible = "arm,armv8-timer"`, `always-on` | the CPU has Arm's generic timer (chapter 11), and it keeps counting in low-power states |
| `/apb-pclk` | `clock-frequency`, `#clock-cells = <0>`, `phandle = <0x02>` | a fixed 24 MHz clock others can point to |
| `/pl011@9000000`, `/pl031@9010000` | `compatible`, `reg`, `clocks` | which device, where, and which clock feeds it |

*Every row is a promise: something answers at that address, behaving like that.*

Two root properties promise things about the whole board. `linux,dummy-virt` is what Linux matches for a generic virtual machine with nothing board-specific to set up. `dma-coherent` says devices that read and write RAM themselves (direct memory access, chapter 15) see what the CPU's caches see, so no cache flushing is needed; true here, because guest RAM is ordinary host memory.

[**`compatible`**](/build-your-own/vmm/glossary/#compatible) names the device, most specific first: `"arm,pl011"` (exactly this UART), then `"arm,primecell"` (the family whose identification registers chapter 09 built). What each property of a device means is set by its [**binding document**](/build-your-own/vmm/glossary/#binding-document), one short schema per kind of device in the Linux source tree. And `compatible` is how a kernel picks a driver: each driver lists the strings it handles, and the kernel attaches a driver to every node that matches, [**driver binding**](/build-your-own/vmm/glossary/#driver-binding) (a different use of the word). For PrimeCells the bus code also reads the identification registers at `0xFE0` before it trusts the match; the Linux boot sequence primer walks the whole path.

[**`reg`**](/build-your-own/vmm/glossary/#reg) lists (address, size) pairs. How many cells is each address? That is not in `reg`. It is in the *parent's* [`#address-cells` and `#size-cells`](/build-your-own/vmm/glossary/#address-cells-size-cells): the root says 2 and 2, so the PL011's `reg` is one range of four cells, address `0x0_0900_0000`, size `0x1000`. `/cpus` says 1 and 0, so `cpu@0`'s `reg` is one cell and no size.

[**`/chosen`**](/build-your-own/vmm/glossary/#chosen) describes no device: it carries settings for the operating system, here its console, and in chapter 13 the kernel command line, [`bootargs`](/build-your-own/vmm/glossary/#bootargs) (the kernel's [admin guide](https://docs.kernel.org/admin-guide/kernel-parameters.html) lists its parameters, such as `console=` and `root=`).

A [**phandle**](/build-your-own/vmm/glossary/#phandle) is a number a node is given so other nodes can point at it. The clock's `#clock-cells = <0>` says a reference to it is one cell, the phandle alone, so the PL011's `clocks = <0x02 0x02>` is two references to `/apb-pclk`, one for each of its two `clock-names`. The PL011 needs that clock because its driver asks for its rate, and Linux's PrimeCell bus will not attach a driver to a device whose `apb_pclk` (the clock of the APB, Arm's Advanced Peripheral Bus) is missing; the [fixed-clock binding](https://www.kernel.org/doc/Documentation/devicetree/bindings/clock/fixed-clock.yaml) describes the node. Linux also says a driver "probes" a device when it attaches to a node it was told about; that is driver binding, not discovery.

`rng-seed` and `kaslr-seed` are random numbers: the first for the guest's random-number generator, the second for kernel address space layout randomization (KASLR, chapter 14). `--dtb-out` writes zeros in their place, so a saved file never records a real boot's secrets.

Open the explorer and load the same tree, or your own `--dtb-out` file (it is parsed in your browser, never uploaded). Click a node to see its bytes:

:::lab dtb-explorer

If the lab does not load, the next two sections do the same by hand.

## Counting the bytes of one `reg`

How long is the PL011's `reg` property, in bytes? Work it out from the table before you look: one range, the root's 2 address cells plus 2 size cells, 4 bytes per cell. Then find the node in the blob. The name appears twice, once in `/chosen`'s `stdout-path` and once as the node itself:

:::term source=captures/10-grep-offset.txt

Dump from 4 bytes before the second hit:

:::term source=captures/10-pl011-hex.txt

Read it in 32-bit big-endian words. `00000001` is a token meaning "a node begins", followed by its name, a NUL and zero padding to a multiple of 4. `00000003` means "a property": then its length (`0x18`, 24 bytes: `"arm,pl011\0arm,primecell\0"`), then the offset of its *name* in a separate table, then the value. The second property, its token at `0x348`, is `reg`: length `0x10`, 16 bytes, and the four cells `00000000 09000000 00000000 00001000`. Journal question 1 asks what the length would be with one cell each.

## The blob: header, structure, strings

That separate table and those tokens are the **flattened device tree** format ([FDT](/build-your-own/vmm/glossary/#fdt)), in chapter 5 of the [Devicetree Specification](https://www.devicetree.org/specifications/) (v0.4). The whole file has four parts:

```text
 offset 0x000  header, 40 bytes           ten big-endian u32 fields
 offset 0x028  memory reservation map     (address, size) u64 pairs, ends with (0, 0); 8-aligned
 offset 0x038  structure block            tokens: BEGIN_NODE name, PROP len nameoff value,
                                          END_NODE, ..., END; everything padded to 4
 offset 0x424  strings block              property names, each once, NUL-terminated
 offset 0x4f7  end (totalsize)
```

*Offsets from our blob; the header tells a reader where each part starts.*

The header, in the first 40 bytes:

:::term source=captures/10-header-hex.txt

| Bytes | Field | Ours | Meaning |
|---|---|---|---|
| 0 to 3 | `magic` | `d00dfeed` | "this is a DTB" |
| 4 to 7 | `totalsize` | `0x4f7` | 1271 bytes in all |
| 8 to 11 | `off_dt_struct` | `0x38` | where the structure block starts |
| 12 to 15 | `off_dt_strings` | `0x424` | where the strings block starts |
| 16 to 19 | `off_mem_rsvmap` | `0x28` | where the reservation map starts |
| 20 to 23 | `version` | `0x11` = 17 | the format we write |
| 24 to 27 | `last_comp_version` | `0x10` = 16 | the oldest version a reader may be and still understand us |
| 28 to 31 | `boot_cpuid_phys` | 0 | the `reg` of the CPU that boots |
| 32 to 35 | `size_dt_strings` | `0xd3` | strings block length |
| 36 to 39 | `size_dt_struct` | `0x3ec` | structure block length |

The dump goes on past the header. The 16 zero bytes from `0x28` to `0x37` are the reservation map's `(0, 0)` terminator, and the `00000001` at `0x38` is the root node beginning, with an empty name.

The [**memory reservation map**](/build-your-own/vmm/glossary/#memory-reservation-map) lists RAM a kernel must not use. Ours holds only that terminator, because Linux reserves the DTB itself. The [**structure block**](/build-your-own/vmm/glossary/#structure-block) is the tree, written depth first as tokens.

The [**strings block**](/build-your-own/vmm/glossary/#strings-block) holds property names, each stored once: our tree has seven `compatible` properties and one `compatible` string. That `nameoff` in every property points into it.

What if a header field is wrong? Change one byte of `off_dt_strings`, from `0x24` to `0x25`, in a copy. Offset 15 is the least significant byte of `off_dt_strings` (bytes 12 to 15, big-endian):

```sh
cp v.dtb bad.dtb
printf '\x25' | dd of=bad.dtb bs=1 seek=15 conv=notrunc
dtc -I dtb -O dts bad.dtb
```

:::term source=captures/10-strings-plus-one.txt

The offset plus the strings size now runs past `totalsize`, and `dtc` checks that. One too low instead (`0x23`) stays inside the blob, so that check passes. `dtc` still refuses it, for "Duplicate property name"; forced with `-f`, it prints what a less careful reader would believe:

:::term source=captures/10-strings-minus-one.txt

Every name is read one byte early. Most become the empty string, and the first gains a tab: byte `0x423` is the last byte of the `FDT_END` token, `0x09`. Values intact, names gone. These steps leave `v.dtb` and `bad.dtb` in the repository root; `rm v.dtb bad.dtb` when you are done.

> **Security.** Our VMM never parses a DTB it did not build itself moments before, so it has no parser to attack; the reference keeps its reader for tests and the fuzzer only, and its audit fails the build if anything else uses it. A program that *reads* a DTB from a file or a guest is parsing hostile input: every offset and size checked against `totalsize` and the buffer with overflow-checked additions, every `nameoff` inside the strings block, names ending in a NUL, caps on depth and token count, and the boot protocol's size limit (a DTB "must not exceed 2 megabytes"). Journal question 3 asks you to list the checks.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 2.5 hours.

## A writer that refuses bad trees

The writer lives in `learner/crates/vmm/src/fdt/writer.rs` and uses no crate: the format is the lesson. It streams: you open a node, add its properties, open and close children, close it, and `finish` lays out the blob. The constants come from the specification and the boot protocol's cap:

:::code anchor=fdt_consts file=crates/vmm/src/fdt/writer.rs

Each refusal is one variant of an error type, a rule the caller broke:

:::code anchor=fdt_error file=crates/vmm/src/fdt/writer.rs

Give it a `Display` impl with one message per variant. The writer itself is two growing buffers, the name-to-offset map, the reservations and a stack of open nodes:

:::code anchor=fdt_writer_struct file=crates/vmm/src/fdt/writer.rs

The size the blob *would* have if finished now, counting the `END_NODE` tokens still owed, is checked after every append, so a runaway caller fails early:

:::code anchor=fdt_writer_new file=crates/vmm/src/fdt/writer.rs

Opening a node writes the token and the padded name. The first node must be the root, named `""`. Every other name is checked: a NUL would end it early, a `/` would make it a path, and other characters must be in the specification's table:

:::code anchor=fdt_check_node_name file=crates/vmm/src/fdt/writer.rs

`pad4` appends zero bytes until the length is a multiple of 4; `check_prop_name` is the same idea for property names, at most 31 characters. Then `begin_node`:

:::code anchor=fdt_begin_node file=crates/vmm/src/fdt/writer.rs

`begin_node` returns a `NodeId` that is not `Clone`, and `end_node` takes it back, so closing the wrong node is an error where it happens:

:::code anchor=fdt_end_node file=crates/vmm/src/fdt/writer.rs

Property names go into the strings block once. The map from name to offset is the whole deduplication:

:::code anchor=fdt_strings_dedup file=crates/vmm/src/fdt/writer.rs

A property must come before its node's first child. Readers such as libfdt and Linux stop collecting a node's properties at its first child, so a late property would silently vanish; the specification (section 5.4.2) forbids it. The writer makes it `PropAfterChild`:

:::code anchor=fdt_prop file=crates/vmm/src/fdt/writer.rs

Then it checks the exact size the property would add, before touching the buffers, and appends it:

:::code anchor=fdt_prop_size file=crates/vmm/src/fdt/writer.rs

Typed helpers turn values into big-endian bytes: `prop_u32` writes one cell, `prop_cells` an array of cells, `prop_strs` a list of strings, each NUL-terminated:

:::code anchor=fdt_prop_u32 file=crates/vmm/src/fdt/writer.rs

:::code anchor=fdt_prop_cells file=crates/vmm/src/fdt/writer.rs

:::code anchor=fdt_prop_strs file=crates/vmm/src/fdt/writer.rs

Four more are yours, each a few lines on top of these, taking `&mut self` and returning `Result<(), FdtError>`: `prop_null(name)`, a property with an empty value; `prop_u64(name, v)`, two cells, high first; `prop_str(name, s)`, a one-item `prop_strs`; and `add_mem_reserve(addr, size)`, which records one reservation, refuses more than `MAX_MEM_RESERVE` (64) with `TooManyReservations`, and runs the size check.

`finish` computes the offsets with `checked_add` and refuses anything over 2 MiB. The header is 40 bytes and each reservation entry 16, so the map and the structure block land 8-aligned with no padding:

:::code anchor=fdt_finish_layout file=crates/vmm/src/fdt/writer.rs

Then it writes the ten header fields big-endian, the reservation map with its `(0, 0)` terminator, the structure block and the strings block:

:::code anchor=fdt_finish_header file=crates/vmm/src/fdt/writer.rs

These names are frozen: the checkpoint's contract tests call them exactly as given. That means `FdtWriter` with `new`, `begin_node`, `end_node`, `prop_bytes`, the typed helpers, `add_mem_reserve` and `finish`; `NodeId`; the constants above in `vmm::fdt::writer`; and `FdtError` with at least the variants the tests match, `PropAfterChild`, `UnbalancedEnd`, `Unfinished`, `InvalidNodeName`, `InvalidPropName`, `StringHasNul` and `TooLarge { size, max }`.

**The reader the tests use.** The tests also read your blobs back through a reader, and feed that reader malformed blobs, each of which must be an error, never a panic. The reader is test equipment, not this chapter's subject, so copy the reference's, from `learner/`:

```sh
cp ../crates/vmm/src/fdt/reader.rs crates/vmm/src/fdt/
```

It imports your writer's constants by the names above. Declare it as the reference does, compiled only for tests and for the `test-util` feature the checkpoint builds your crate with:

:::code anchor=fdt_mod file=crates/vmm/src/fdt/mod.rs

Re-export from `machine` only what your `machine.rs` defines. The reader shares our assumptions, since the same people wrote it; `dtc` is the independent check.

> **Production note.** Production VMMs in Rust usually take the format from a shared crate (`vm-fdt`, in the rust-vmm family), and QEMU uses libfdt, the C library that ships with `dtc`. We write our own because the format *is* the lesson.

## The machine, from one table

`learner/crates/vmm/src/fdt/machine.rs` turns the board into calls. Its rule: every address comes from `layout.rs`, the table chapter 05 built, so the tree and the devices on the bus cannot disagree about *where*. What changes from boot to boot arrives as one `MachineDesc`:

:::code anchor=fdt_machine_desc file=crates/vmm/src/fdt/machine.rs

The seeds must be fresh host randomness on every boot, 64 bytes for `rng-seed` and 8 for `kaslr-seed`: Linux mixes the first into its random pool, and uses the second to choose where in memory the kernel runs. The reference calls the Mac's `getentropy` (chapter 17 shows the wrapper); in your workspace, reading 72 bytes from `/dev/urandom` with `std::fs::File` is enough. `dtb-reader` checks that both are nonzero, so zeros fail the checkpoint.

Two small helpers: `bad` wraps a message as `InvalidMachine`, and `row` finds the layout row that starts at an address, so a node's name and its `reg` come from the same row:

:::code anchor=fdt_machine_row file=crates/vmm/src/fdt/machine.rs

A `reg` pair with two cells per number:

:::code anchor=fdt_machine_reg64 file=crates/vmm/src/fdt/machine.rs

RAM is one bank, as big as `--mem`:

:::code anchor=fdt_machine_memory file=crates/vmm/src/fdt/machine.rs

The PL011 and the PL031 are both PrimeCells, so one function writes either from its layout row: name and unit address, `compatible`, `reg`, then the clock. The `with_gic` lines add an `interrupts` property, which says which interrupt line the device raises; that needs the interrupt controller node of chapter 12, so leave them out for now:

:::code anchor=fdt_machine_primecell file=crates/vmm/src/fdt/machine.rs

The clock both point at, with its phandle:

:::code anchor=fdt_machine_apb_pclk file=crates/vmm/src/fdt/machine.rs

`/chosen` checks `bootargs` before writing it: Linux keeps at most 2,047 bytes plus the NUL and would cut a longer line silently, so the reference refuses it. The `initrd` lines are chapter 13's:

:::code anchor=fdt_machine_chosen file=crates/vmm/src/fdt/machine.rs

The entry point checks the description first:

:::code anchor=fdt_build_dtb_with file=crates/vmm/src/fdt/machine.rs

Then the root ties it together in the order `dtc` printed. Skip the `with_gic` branches until chapter 12, and leave out `slots` and the `virtio_slot` loop until chapter 15, where virtio devices arrive. `cpus`, `psci` and `timer` are the next section's; give each an empty body that returns `Ok(())` for now, so this builds:

:::code anchor=fdt_machine_root file=crates/vmm/src/fdt/machine.rs

## Your turn: three nodes

Three nodes are yours to write, with the `dtc` listing above as their specification:

1. `/cpus`, with `#address-cells = <1>`, `#size-cells = <0>`, and one `cpu@N` per vCPU with `device_type = "cpu"`, `compatible = "arm,arm-v8"`, `enable-method = "psci"` and a `reg`. That `reg` is the vCPU's affinity: its `MPIDR_EL1` (the Multiprocessor Affinity Register, chapter 06) with bit 31 and the other non-affinity bits cleared, keeping Aff3 in bits 39 to 32 and Aff2 to Aff0 in bits 23 to 0. So vCPU 0, whose `MPIDR_EL1` is `0x8000_0000`, has `reg = <0x0>` and is `cpu@0`; the unit address is that number in hex.
2. `/psci`, with the three `compatible` strings and `method = "hvc"`, so the guest's power calls take chapter 08's path.
3. `/timer`, with its two `compatible` strings and the empty property `always-on`.

Stuck? `scripts/learner hint 10` gives four hints, from a nudge to the exact reference file.

## Handing it over in `x0`

The blob goes at `0x4000_0000`, 8-byte aligned as the boot protocol requires. Chapter 03 reserved that slot: the first 512 KiB of RAM, up to `0x4008_0000` where test guests are linked (chapter 13 widens it to 2 MiB for Linux):

:::code anchor=plan_dtb_slot file=crates/vmm/src/loader/plan.rs

The plan sets `x0` to the slot's address. Each boot then builds a fresh tree and sizes the slot to it (`set_dtb_len` refuses a tree bigger than the slot):

:::code anchor=machine_device_tree file=crates/vmm/src/machine/mod.rs

Skip for now: `bootargs` and `initrd` (chapter 13), `virtio_populated` (chapter 15), and `with_gic` (chapter 11's `--irqchip`; yours is false). `generation` counts guest reboots (chapter 08's `SYSTEM_RESET`): every boot gets a new tree, and only the first writes the file. In your VMM, write the tree into guest memory at `0x4000_0000` before the vCPU starts.

The file gets a copy with both seeds zeroed. The reference walks the blob's tokens and zeroes those two values in place; the step for one property:

:::code anchor=fdt_redact_prop file=crates/vmm/src/fdt/machine.rs

Simpler, and the same bytes: build the tree again from a clone of the `MachineDesc` with zero seeds. Add `--dtb-out FILE` in `learner/crates/macvmm/src/cli.rs`. Create the file with mode `0600` and refuse to follow a symlink, or a link planted at that path could make your VMM overwrite a file you own. The reference's `open_output` in `crates/vmm/src/backend/hostio.rs` also checks owner and link count; chapter 25 explains why.

And the boot vCPU starts with the slot's address in `x0`, and `x1` to `x3` zero, as the boot protocol requires:

:::code anchor=boot_params_x0 file=crates/vmm/src/machine/mod.rs

Since chapter 03 your VMM has put `0x4000_0000` in `x0`, an address with nothing behind it; chapter 03 promised a device tree would live there. Now one does. From `learner/`:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/dtb-reader.bin@0x40080000 --timeout 10
```

:::term source=captures/10-dtb-reader-run.txt

We captured it on the reference; yours prints the same ten lines. `magic ok` is the evidence: the guest found `0xd00dfeed` at `x0`.

## One cell fewer

The tree is data. So is a number inside it that says how to read the other numbers.

**Deliberate breakage 1: one address cell on the root.** In `build_dtb_with` in your `machine.rs`, write `1` instead of `2` for the root's `#address-cells`, and nothing else.

:::predict Will `dtb-reader` still print the same memory size?
Write your guess and one sentence of reasoning under `## Predict` in your journal, then rebuild and run it.
:::

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/dtb-reader.bin@0x40080000 --dtb-out c.dtb --timeout 10
```

We captured it on the reference, which needs `--irqchip none` to leave out the interrupt controller your VMM does not have yet; yours needs no flag:

:::term source=captures/10-cells-dtb-reader.txt

The same `reg=0x40000000+0x4000000`. If you predicted that, you were right for the wrong reason. Here is how `dtb-reader` reads memory:

:::code anchor=dtb_reader_memory file=guests/dtb-reader/main.rs

It never reads `#address-cells`: it assumes two cells and two cells, exactly as `uart-echo` assumed `0x0900_0000`. A reader that shares your assumption cannot catch your bug. `dtc` reads the counts:

:::term source=captures/10-cells-dtc.txt

One range is now 1 + 2 = 3 cells, 12 bytes, and 16 is not a multiple of 12. And a real kernel? You cannot run this until chapter 13 fetches one; we booted the Linux kernel of chapter 14 on the reference with this one edit:

:::term source=captures/10-cells-linux-run.txt

From outside, a kernel that has panicked looks like a guest still running: it stops in a loop, and `--timeout` ended it with exit 5. Its log:

:::term source=captures/10-cells-linux-log.txt

`Machine model: macvmm-virt` is Linux reading the root's `model`. Then it took one cell, `0x0`, as the address and the next two, `0x40000000` and `0x0`, as a size of `0x4000_0000_0000_0000` bytes, about 4.6 exabytes. "Doesn't fit in the linear mapping" means the kernel's own map of RAM is too small for that much; it faulted soon after. The early console worked because its address came from the command line our VMM passes Linux (`earlycon=pl011,0x09000000`), not from the tree. The checkpoint catches it through `dtc`:

:::term source=captures/10-checkpoint-cells.txt

What you saw: a guest that printed the right numbers, and a kernel that died on the same blob. The misconception it exposes: "the values did not change, so the guest sees the same machine"; the cell counts are structure, and the DTB is parsed, not read. The tool that found it: an independent reader, `dtc`, which shares none of our assumptions. Change the `1` back.

## Move the PL011 on your VMM

Now compare `dtc -I dtb -O dts` of your own `--dtb-out` blob with the listing in sitting A. Then repeat the opening experiment: move `PL011_BASE` in your `layout.rs` to `0x0904_0000` (if your `GICR_WINDOW_END` is defined as `PL011_BASE`, pin it at `0x0900_0000` as we did), run `dtb-reader` and `uart-echo`, compare with the opening's captures, and move it back.

> **Try it.** What does a guest do with a node for a device the bus does not have? We added a second node, `pl031@9050000`, to the reference's tree, left the bus alone, and booted Linux. With the default policy the virtual machine stopped on the first access, a read at `0x9050fe0`: the PrimeCell bus code reads the identification registers before it picks a driver. With `--unhandled-mmio log`, those reads returned zero and Linux still reached its shell. Journal question 2 starts here.

:::term source=captures/10-phantom-fatal.txt

:::term source=captures/10-phantom-log.txt

:::term source=captures/10-phantom-log-grep.txt

`amba` is Linux's name for the PrimeCell bus. With the IDs reading zero it could not identify the device, so it parked it as "deferred" (the last line) and never bound a driver. In the fatal run, the trace lines before the stop are the real PL031 answering the same reads at `0x9010fe0` to `0x9010ffc` with `0x31 0x10 0x14 0x00` and `0x0d 0xf0 0x05 0xb1`: the identification registers you built in chapter 09. This is an early answer to chapter 09's open question about identification registers that read zero; chapter 14 answers it in full.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (header and alignment, one strings entry for two `compatible` properties, the ordering, balance, name and size errors, a round trip through the reader you copied, and that reader refusing malformed blobs). Then it runs `dtb-reader` on your VMM, expecting the ten lines above, and `hello`, expecting `x0=0x40000000`; if `dtc` is installed, it checks that your `--dtb-out` blob decompiles with no warning (otherwise INFO). It also checks that every journal heading has an answer. On the reference:

:::term source=captures/10-checkpoint.txt

What now works:

- your VMM writes a flattened device tree from scratch, and refuses the trees the format forbids;
- the tree describes RAM, the CPUs, PSCI, the timer, the PL011, the PL031 and `/chosen`, all from `layout.rs`, with fresh seeds, and `dtc` accepts it without a warning;
- the guest finds the tree through `x0 = 0x40000000`, and a guest that reads it learns where `layout.rs` put each device.

The next chapter starts from this state (the reference at the end of chapter 10).

### What's next

`/timer` promises a timer, and nothing in our machine can interrupt the guest yet. Chapter 11 asks how a kernel gets the CPU back from a program that never yields, builds a bare interrupt with no controller, and counts what one exit to the VMM per tick costs.

### Open question

The DTB and the device models come from one `layout.rs`, so the opening experiment moved the device and its description together. Which class of bug does that remove, and which class does it not: could the one-cell break of this chapter happen anyway, and what about a node whose `compatible` names a device our model does not behave like?

## Spec hunt

- Devicetree Specification v0.4, chapter 5, section 5.2 ("Header"): which header fields must a reader check before it trusts any offset, and what does `last_comp_version` promise a reader of version 16?
- Devicetree Specification v0.4, section 2.3.5 (`#address-cells` and `#size-cells`): whose counts apply to a node's `reg`, and what default does a reader assume when a parent leaves them out?
- Linux `Documentation/arch/arm64/booting.rst`, section "Setup the device tree": what alignment, size and placement rules does a DTB obey, and why does the 2 MiB block around it matter?
