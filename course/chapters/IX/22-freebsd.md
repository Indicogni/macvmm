---
title: FreeBSD through U-Boot EFI (SHOULD)
part: IX
chapter: IX.2
id: 22
runs: mac
minutes: 360
prereqs: [21, 20]
start_tag: ch-21
labs: []
command: scripts/checkpoint.sh 22
expect: CHECKPOINT 22 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** compatibility of a virtual machine monitor (VMM) measured guest by guest; reading a boot transcript link by link to find which program spoke last; deciding "our machine or the guest?" from primary sources, with QEMU `virt` as the reference machine; an offered feature bit as a promise a driver may refuse; recording findings in a compatibility log.
- **Core, from earlier:** the firmware boot protocol, U-Boot and flash that ignores writes (chapter 21); one thread per virtual CPU (vCPU) and the power state coordination interface (PSCI) call `CPU_ON` (chapter 20); virtio-blk and the raw disk image (chapter 18); feature negotiation (chapter 15); the device tree blob (DTB) as the VMM's promise, `compatible` and the `apb_pclk` clock (chapter 10); the exit trace (chapter 03).
- **Primers (review):** `uefi` (boot and runtime services, the configuration table, the default path `\EFI\BOOT\BOOTAA64.EFI`); `u-boot` (standard boot, `bootefi`); `block-storage` (raw images, partitions as guest business, Apple File System clones with `cp -c`); `primecell-ids` (how Linux and FreeBSD bind a PrimeCell, and the `apb_pclk` clock); `linux-boot-sequence` (the early console and how a node finds its driver); `smccc` (Arm's call convention for hypervisor calls, and its feature queries).
- **Pointers:** the FreeBSD boot chain (`loader.efi`, `loader(8)`) and the Unix File System (UFS), an Aside; xz as a compression container, an Aside; EDK2 `ArmVirtQemu` as the second firmware, a Production note; pointer authentication, MTE and other CPU features FreeBSD probes, one sentence (no capture shows one matters).
- **Forward definitions:** none.
:::

One virtio-blk device, three drivers. U-Boot's virtio driver reads the FreeBSD image, and FreeBSD's loader reads its kernel through U-Boot. In a separate run, Linux's driver reads a whole disk image through the very same device code. Then FreeBSD's own kernel driver looks at the device and says this, and never gets further:

:::term source=captures/22-size-max-freebsd.txt

This is our VMM with one extra feature bit switched on, the way the reference shipped until the first time it booted FreeBSD. You will switch it on yourself in Deliberate breakage 2. Standard error holds no complaint from the VMM: chapter 21's five ignored flash writes, then the timeout we asked for. The device works for U-Boot's driver and for Linux's, not for FreeBSD's. Is our machine wrong, or is FreeBSD?

Chapter 18 told you how this story ends, in one sentence about the features it does not offer. Here you work out why, from primary sources, as if nobody had told you. The next guest's refusal will not come with a note.

:::predict Before we chase that one, a smaller version of the same question. Remove `apb_pclk` from the PL011 node of our device tree and boot Linux, then FreeBSD. Which operating system complains first, and what does each print?
Write your guess and one sentence of reasoning under `## Predict` in your journal. Deliberate breakage 1 runs both.
:::

This chapter re-tests row 10 of chapter 00's [problem ledger](/build-your-own/vmm/glossary/#problem-ledger), a boot chain, with a second operating system: chapters 13 and 14 closed the row with our VMM as the bootloader, chapter 21 with U-Boot, and here FreeBSD walks the whole chain, firmware, Unified Extensible Firmware Interface (UEFI), its own loader, its kernel, on our virtio disk with two CPUs. Like chapter 21, this is an Open chapter: a brief, the tests that judge it, then the reference's path for comparison. About 6 hours in one or two sittings, most of it reading transcripts; the natural break is after the first login.

:::objectives
- Boot the pinned FreeBSD 15.1-RELEASE arm64 image, verified by its checksum and used only through Apple File System (APFS) clones, through U-Boot's EFI path to `login:` with `--cpus 2`, and name what each link of the chain did.
- Diagnose a guest-specific failure by comparing what FreeBSD and Linux expect of our machine (the interrupt controller, the PL011's clocks, virtio-blk's features, the device tree against QEMU `virt`), using primary sources rather than which guest boots.
- Predict, then observe, how each guest reacts to a missing `apb_pclk`, and explain the difference from their binding rules.
- Record what you found in a compatibility log: how far the guest gets, the transcript and trace at any blocker, the root cause, and a ranked list of what could go wrong next.
:::

**Before you start.** From the repository root, run `scripts/learner start 22`; it copies this chapter's journal to `learner/journal/22.md`. Your VMM from chapter 21 boots U-Boot to its prompt; nothing new is required of it before the first run, which is the point. As in chapter 20, our captures ran the reference from the repository root, so their paths start at `.cache/`. Run your own VMM from inside `learner/` with the same `cargo run` lines, and prefix each `.cache/` path with `../`.

## The brief

**Brief.** Boot stock FreeBSD 15.1-RELEASE for 64-bit Arm on your VMM, through stock U-Boot, with two vCPUs and the image on virtio-blk. Fix whatever stops it in your VMM, not in the guest. Write `learner/docs/compat/freebsd.md` as you go.

**Acceptance.** At `login: ` type `root` (the image has no root password), run `uname -sr`, and see `FreeBSD 15.1-RELEASE`; `shutdown -p now` ends the run with exit code 0. On the way the console shows `U-Boot 2026.04`, `FreeBSD/arm64 EFI loader` and `FreeBSD 15.1-RELEASE`, and standard error never says `unhandled MMIO`, `unknown SMCCC`, `not emulated` or `guest fatal`.

This chapter is a SHOULD: the course promises Linux, and FreeBSD only if the evidence says so. The rule we hold ourselves to: never write "FreeBSD boots" unless the login test passed on a real Mac. For the reference, it did.

## A disk image you can trust, and throw away

You need Homebrew's `xz` (`brew install xz`; `scripts/setup.sh` checks its version) and about 4 GB of free space. FreeBSD publishes ready-made virtual-machine images. The project pins one by its SHA-256 hash, and the fetch script refuses anything else:

```sh
scripts/fetch.sh uboot freebsd
```

:::term source=captures/22-fetch.txt

Our run found everything cached and re-hashed it. A first run downloads about 600 MB, checks the hash, then unpacks it with `xz` into a raw disk of 6.5 GB, of which about 3.2 GB is real data. You can check the pin yourself. The hash of the download, then the project's pinned lines:

:::term source=captures/22-checksum.txt

The first value must equal the line for `FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz` in FreeBSD's own `CHECKSUM.SHA256`, published next to the image on download.freebsd.org. The second pin is for the unpacked file.

> **Aside.** [xz](/build-your-own/vmm/glossary/#xz) is a compression container, like the gzip inside chapter 13's zboot kernel, but denser and slower. The fetch script refuses `xz` 5.6.0 and 5.6.1, the two releases that shipped with a planted backdoor in 2024, and never runs anything it unpacked. See the `.xz` file format specification at [tukaani.org/xz](https://tukaani.org/xz/xz-file-format.txt).

The raw file is sparse: its long runs of zeros take no space. Never boot it directly. FreeBSD writes to its disk on every boot (logs, a random seed, a check that the root partition fills the disk), so the cached file would drift from its pin. Clone it instead, once per run, into `.cache/`, which git ignores. `cp -c` makes an APFS clone (the `block-storage` primer): instant, and it costs only the blocks the guest changes.

```sh
cp -c .cache/macvmm/freebsd-15.1-ufs.raw .cache/f.raw
cargo run -q -p macvmm -- run --bios .cache/macvmm/u-boot.bin --disk .cache/f.raw --mem 2G --cpus 2 --timeout 240 --on-reset exit
```

`--timeout 240` stops a run that hangs; with it, exit code 5 means the timer fired, not that FreeBSD failed. Drop it when you want to explore. Delete `.cache/f.raw` when you are done.

## The boot chain, link by link

Here is the reference, all the way to a login and back to the shell. A script typed the three commands; the capture's header says when. U-Boot's EFI text console follows every character it prints with an escape sequence that shows the cursor, so escape sequences are removed below. The one very long line in the middle is FreeBSD's boot menu, drawn with cursor moves.

:::term source=captures/22-freebsd-boot.txt

Read it as four programs taking turns, each handing the next what it needs. Only `macvmm` runs on the host; the other three run inside the guest:

```text
 host        |  guest
 macvmm      |  U-Boot (flash)        loader.efi (RAM)      FreeBSD kernel
 ------      |  --------------        ----------------      --------------
 DTB at RAM -|> copies the DTB,
 base, PC=0  |  finds the disk,
             |  runs BOOTAA64.EFI ->  reads UFS through
             |                        U-Boot's block I/O,
             |                        DTB from the EFI   ->  attaches drivers
             |                        config table           from the DTB
 <- PSCI SYSTEM_OFF <- U-Boot's EFI ResetSystem <-----------  shutdown -p now
```

*Each arrow is a hand-over; the last line runs right to left, back through U-Boot's code and across the line into the host.*

1. **U-Boot** starts from flash exactly as in chapter 21. Its countdown expires, and standard boot scans for something to run. The `efi_mgr` method finds no stored EFI boot entries (`No EFI variables loaded`: our flash forgets every write, so every boot is a first boot), and falls back to the default path the `uefi` primer described: `\EFI\BOOT\BOOTAA64.EFI` on the first disk's EFI system partition (ESP).
2. That file is **FreeBSD's [loader.efi](/build-your-own/vmm/glossary/#loader-efi)**. It reports its firmware as `Das U-Boot` and its EFI version as `2.110`, the specification's way of writing 2.11. It tries each partition (`disk0p1`, `disk0p2`, `disk0p3`), finds FreeBSD's file system on the third, reads its settings, waits ten seconds at its menu, and loads `/boot/kernel/kernel`.
3. `Using DTB provided by EFI at 0xbd600000`: the loader hands the kernel the device tree it found in the UEFI configuration table. U-Boot put it there: our DTB, copied and lightly edited by U-Boot (it fixes up the memory node and `/chosen`). That answers chapter 21's open question for this chain.
4. The **kernel** attaches what our tree describes, each on `ofwbus0`, FreeBSD's name for the device-tree bus: `psci0`; `gic0` (the interrupt controller) at our distributor and redistributor addresses; `generic_timer0` at 24 MHz; `uart0` on the PL011; `pl0310` on the real-time clock; `virtio_mmio0` and `vtblk0`. It starts CPU 1 (`Multiprocessor System Detected: 2 CPUs`) and mounts root from `/dev/gpt/rootfs`, the partition labelled `rootfs` in the disk's GUID partition table (GPT: the standard list of a disk's partitions, each named by a globally unique identifier). Then `getty`, the program that prints `login:` and waits for a user, runs on `ttyu0`, FreeBSD's name for its first serial port, here our PL011.
5. `shutdown -p now` powers off, and `macvmm` exits 0.

> **Aside.** FreeBSD's boot loader, `loader(8)`, is a small program with its own prompt and scripting; `loader.efi` is that program packaged to run under UEFI. It reads the kernel from a [UFS](/build-your-own/vmm/glossary/#ufs) (Unix File System) partition, FreeBSD's traditional file system. The manual pages `loader(8)` and `loader.efi(8)` at [man.freebsd.org](https://man.freebsd.org/cgi/man.cgi?query=loader.efi&sektion=8) describe both.

The kernel also prints the CPU's feature registers: `PAuth` (pointer authentication), `MTE_frac` (part of the memory tagging extension), `SME2`. A guest may probe such features and use them; in this boot none of them caused any trouble, so we leave them there.

> **Try it.** Stop at the loader's own prompt. Boot again, and while the menu counts down, press `3` (Escape to loader prompt). At `OK`, type `lsdev`, then `lsefi`, and press space to page through it. Look for the words `block io`: whose code does the loader call when it reads the disk? Afterwards, type `boot` to carry on, or press Ctrl-A x to quit (exit code 130, chapter 09).

:::term source=captures/22-loader-lsefi.txt

(Exit code 5: our `--timeout 40` stopped it at the prompt.) `lsefi` lists the handles U-Boot's UEFI layer offers: a text console, device paths, and `block io` on the whole disk and on each of its three partitions, the first of which also offers `simple fs` (a file system the firmware can read: the ESP). The unnamed GUID `8cf2f62c-…` beside each `block io` is UEFI's partition-information protocol; ignore it. The last handle is the loader itself, loaded from `\EFI\BOOT\BOOTAA64.EFI`. The loader never touches our virtio registers. It calls U-Boot, and U-Boot's own virtio driver does the work. Keep that list in mind for journal question 3.

**If yours stops.** Find the last line a program printed, then read standard error. Each forbidden message points back to a chapter:

- `unhandled MMIO` at an address: compare the address with your DTB and memory map (chapters 05, 07 and 10). Chapter 05's capture `05-poke-fatal` shows the message.
- `unknown SMCCC function`: your PSCI and call-convention dispatch (chapter 08, the `smccc` primer); chapter 08's probe captures show it.
- `not emulated`, or `guest fatal` with an instruction word: the decoder for syndromes without ISV (chapter 21, whose opening shows U-Boot refused this way).
- Silence after `Starting CPU 1`: `CPU_ON` and the per-vCPU thread (chapter 20). We have not been able to check what this looks like with FreeBSD.
- `vtblk0: host requires …` and a `mountroot>` prompt: your virtio-blk feature offer (chapter 18, and Deliberate breakage 2 below).

`scripts/learner hint 22` gives four hints, from a nudge to the reference's files, and `scripts/learner lifeline MODULE` borrows one reference module (for example `vmm::psci`, as in chapter 08).

:::stopping-point Good place to stop. The rest compares our machine with QEMU's, breaks it twice, reads the exit trace and writes the log.

## Is our machine right? Ask a second machine

Reaching `login:` shows that this guest found what it needed. It does not show that our machine is correct. Linux boots on it too, but as you will see, the two read different parts of the same device tree. When a guest disagrees with us, there are three primary sources, and a vote among guests is not one of them:

- the **specification** of the thing the guest read: the virtio specification for a device, the device-tree bindings for a node, the Arm manuals for a register;
- the **guest's own source**, for what it does with what it read;
- a [reference machine](/build-your-own/vmm/glossary/#reference-machine): QEMU's `virt`, whose memory map ours copies, a machine that FreeBSD and Linux both support as it comes.

So compare our tree with QEMU's. With QEMU installed, `qemu-system-aarch64 -machine virt,gic-version=3,dumpdtb=.cache/qemu.dtb -cpu max -smp 2 -m 2G` writes its DTB, and our `--dry-run --dtb-out .cache/ours.dtb` writes ours. If you do not have QEMU, use our captures. First the nodes:

:::term source=captures/22-dtb-nodes.txt

Every `<` line is a node only QEMU has: its flash (`flash@0`), a PCI Express host (`pcie@10000000`), QEMU's own configuration device (`fw-cfg@9020000`), a performance-monitor node (`pmu`), a general-purpose input/output (GPIO) controller with a power button, a platform bus for devices added on QEMU's command line (`platform-bus@c000000`), serial port `aliases`, and 31 more virtio slots. There is no `>` line: we describe nothing QEMU lacks. Then four properties side by side (each address and size in `reg` is two cells, as in chapter 10):

:::term source=captures/22-dtb-props.txt

The PL011 clocks agree. The virtio-mmio interrupt's last cell does not: QEMU says `1` (edge-triggered), we say `4` (level-high). The redistributor regions differ in size. Each vCPU needs 128 KiB of redistributor (chapter 12); ours sizes the region for the two we create (`0x40000`), while QEMU reserves room for 123 CPUs (`0xf60000`). FreeBSD's `gic0` line, `0x80a0000-0x80dffff`, shows it read our size. QEMU also names its CPU model, `arm,cortex-a57`, where we say only `arm,arm-v8`, an Armv8 CPU of no particular model.

Each difference is a hypothesis to test, not a bug. Ours declares level because our device drives a level line that stays high until the driver acknowledges (chapter 15); the tree tells the truth about our machine, which is its job:

:::code anchor=fdt_spi_cells file=crates/vmm/src/fdt/machine.rs

FreeBSD 15.1 booted with every one of these differences, and so does Linux. That is a measurement for two guests. Question 1 of your journal asks which of them might matter to a third.

## Breaking it on purpose

Two breaks, each a one-line change, each run against both guests. Commit your working VMM in `learner/` first (`git commit -am "boots FreeBSD"`), make the change there, and run both guests from `learner/`: FreeBSD with the `cargo run` line above, Linux with chapter 14's `cargo run` line (`scripts/run-linux.sh` always runs the reference, never your tree). Undo each change with `git checkout -- FILE` before the next. Our captures come from a copy of the reference with the same one-line change.

**Deliberate breakage 1: remove `apb_pclk` from the PL011 node.** Chapter 10 gave every PrimeCell node a fixed clock named `apb_pclk`. Here is the PL011's call; change its clock names to `&["uartclk"]`:

:::code anchor=fdt_machine_pl011_node file=crates/vmm/src/fdt/machine.rs

Check your Predict entry. First, Linux on the reference, to know what normal looks like:

:::term source=captures/22-linux-console.txt

Then Linux without the clock:

:::term source=captures/22-noapb-linux.txt

Then FreeBSD without the clock, filtered to the lines that matter:

:::term source=captures/22-noapb-freebsd.txt

Linux lost its console without a word about the clock or the PL011. The driver loaded (`Serial: AMBA PL011 UART driver`), but the device was never bound: no `ttyAMA0` line, and the [early console](/build-your-own/vmm/glossary/#earlycon) was never retired. When the kernel went to start the first program, it printed `Warning: unable to open an initial console.` The test program's own line, `macvmm-initramfs: ready`, never appeared.

The `primecell-ids` primer has the rule. Linux's AMBA bus (Arm's on-chip bus family) asks for a clock named `apb_pclk` before it reads a PrimeCell's ID registers, and without it never matches a driver. FreeBSD binds its PL011 driver by `compatible` and does not ask; it logged in as if nothing had changed.

What you saw: one OS silently loses its console, the other notices nothing. The misconception it exposes: "if one OS boots, the machine is correct". The tool that finds it: running every guest you claim to support, and diffing each boot log against a known-good one, because an absence never shows up as an error.

**Deliberate breakage 2: offer `VIRTIO_BLK_F_SIZE_MAX` again.** This is the opening puzzle, and it is history, not invention: the reference offered this feature until the first time it booted FreeBSD. Here is the device's offer today:

:::code anchor=blk_device_features file=crates/vmm/src/virtio/blk.rs

Add `| blk_features::SIZE_MAX` to the list. The feature bit promises that no single data segment (one data buffer of a request, one descriptor in chapter 18's terms) is larger than `size_max`, which our config space reports as 64 KiB, one bounce buffer (chapter 18).

:::predict You already know who refuses. So: does the virtio specification oblige FreeBSD to accept this device, and does it oblige us to offer the bit? And U-Boot and FreeBSD's loader read this disk through whose driver: will this change touch them?
Decide before reading on; your answer to journal question 2 builds on it.
:::

Our FreeBSD run is the opening's capture. Linux, same build, reading a disk through the same device:

:::term source=captures/22-size-max-linux.txt

Now diagnose it the way you would without being told. Who spoke last? Standard error holds nothing from the VMM but the flash writes and our timeout, so no exit went unhandled: whatever happened, happened inside the guest. The guest says `vtblk0: host requires unsupported maximum segment size feature`, then `attach returned 45`. FreeBSD's error 45 is `EOPNOTSUPP` (operation not supported), and the later error 19 is `ENODEV` (no such device): no disk, so no `/dev/gpt/rootfs`, so the [mountroot prompt](/build-your-own/vmm/glossary/#mountroot-prompt).

U-Boot and the loader both read fine. The loader's banner and the kernel banner in the opening capture prove the kernel came off this disk, through U-Boot's own virtio driver (the `block io` you saw in `lsefi`). Only FreeBSD's kernel driver reads our feature bits itself. Then the three sources:

- **The guest's source.** FreeBSD's `vtblk_attach`, in `sys/dev/virtio/block/virtio_blk.c`, refuses a device that offers [VIRTIO_BLK_F_SIZE_MAX](/build-your-own/vmm/glossary/#virtio-blk-f-size-max) with a `size_max` below the kernel's largest transfer, 1 MiB on arm64. Its comment says why: FreeBSD's scatter-gather lists (the lists of memory pieces that make up one transfer) merge physically adjacent pages into one segment, so it cannot promise to keep each segment small. It refuses rather than risk corrupting a transfer.
- **The specification.** Virtio 1.2, section 5.2.3, lists the feature as one a device may offer. Nothing obliges a device to offer it, and nothing obliges a driver to work with every device.
- **The reference machine.** QEMU's virtio-blk does not offer it.

So nobody broke a rule. Linux and U-Boot accept the small limit, which is why they worked, and the guest that refused was reasonable. Our device was the odd one out, making a promise it never needed: chapter 18's data path copies through 64 KiB buffers piece by piece whatever the segment size. Dropping the bit cost nothing, and that is the fix in the reference.

What you saw: one guest refuses a device the others drive. The misconception: "the device works, so the guest is wrong". The tool: the guest's own message, read against its source and the specification.

> **Security.** Dropping the feature moved a limit, it did not remove one. Without `SIZE_MAX`, a compliant driver may send a request larger than the 126 × 64 KiB our device accepts, and the driver is never told. Our device still enforces its own cap, answering such a request with an I/O error and staying usable, never trusting a length the guest wrote. Every limit you stop advertising must still be enforced on the device side.

## What the exits say

A transcript shows what the guest chose to print. The exit trace shows what it asked of our VMM. Run the login again with a trace of the power, hypervisor-call and system-register exits:

:::term source=captures/22-trace-run.txt

:::term source=captures/22-trace.txt

Thirteen exits of those three kinds in the whole boot, and every one has a reason. Each CPU unlocks the debug OS lock once (`OSLAR_EL1`, a system register Hypervisor.framework hands to us). The calls come in an order you might not expect: FreeBSD starts CPU 1 with an early `PSCI_CPU_ON`, before its `psci0` driver attaches and asks `PSCI_VERSION`. vCPU 1, on its own host thread (chapter 20), then makes one `SMCCC_ARCH_FEATURES` call of its own, the query a kernel uses to ask which optional calls exist (the `smccc` primer). Every call comes from the same `pc` because FreeBSD makes all of them through one helper, so they share one `hvc` instruction.

The last exit is the interesting one: `PSCI_SYSTEM_OFF` from `pc=0xbf69a1b8`. That is not a kernel address (FreeBSD's are the `0xffff…` ones). It is inside U-Boot, which copied itself to the top of RAM at start-up and, as UEFI requires, marked its runtime code in the memory map it handed over as off-limits to the operating system. FreeBSD powered off by calling UEFI's runtime service `ResetSystem`, and U-Boot's code, still resident after the operating system took over, made the PSCI call. Firmware is not finished when the kernel starts.

## Writing it down

A [compatibility log](/build-your-own/vmm/glossary/#compatibility-log) answers, for one guest version on one VMM version:

- **how far it gets**, in one line at the top, with the date and the Mac it was run on;
- **the boot chain**, link by link, as you read it above;
- **the latest transcript and trace**, and at any blocker, the last lines before it;
- **the root cause** of each blocker, with the primary source that decided it;
- **a ranked list of what could go wrong next**. The reference's has four: boot entries cannot persist, there is no random-number device at boot (`Missing RNG device for EFI_RNG_PROTOCOL`, and FreeBSD's `arc4random` warning), the device-side request cap from the Security note, and a terminal-size query that our serial filter drops (`resizewin: timeout reading from terminal`, a one-second wait at login).

That list is the model for yours; the reference keeps its own record in `docs/compat/freebsd.md`. Write it even when everything works. The next guest, or the next FreeBSD release, starts from your list.

> **Production note.** The other stock firmware for this machine is chapter 21's alternative, EDK2's `ArmVirtQemu`. As that chapter's decision weighed, it keeps its UEFI variables in the second flash bank, which must accept Common Flash Interface (CFI) write and erase commands (it may also want QEMU's configuration device); our flash ignores writes. The project's decision to start with U-Boot is `docs/adr/0007-firmware-path-for-freebsd.md`; booting FreeBSD through EDK2 is a stretch goal, documented and not required.

## Your turn

Before the checkpoint, check in `learner/`:

1. Your VMM boots FreeBSD from a fresh clone to `login: `, `uname -sr` prints `FreeBSD 15.1-RELEASE`, and `shutdown -p now` exits 0, with nothing on standard error but the flash writes.
2. Your journal has the Predict entry from before you ran breakage 1, and question 2 answered from the sources, not from which guest booted.
3. `learner/docs/compat/freebsd.md` exists, with every item from the list above, including the ranked list.

## Checkpoint

:::checkpoint

It builds your VMM, boots a fresh clone of the image in a private directory with the run line above, waits for `login: `, types `root`, `uname -sr` and `shutdown -p now`, and demands exit code 0. It removes U-Boot's escape sequences before it compares the console with its list of required lines, in order, and forbidden ones (`vtblk0: host requires unsupported`, `mountroot>`, `panic:` and the four standard-error messages from the brief). The reference's run:

:::term source=captures/22-freebsd-login.txt

What now works:

- a second operating system boots on your VMM through firmware, UEFI and its own loader, on two CPUs, to a login, and powers off cleanly;
- you can follow a boot through four programs and say which one spoke last when it stops;
- you decide "our machine or the guest?" from the specification, the guest's source and QEMU `virt`, not from which guest happens to boot;
- your compatibility log says exactly how far FreeBSD gets and what could break next.

The next chapter starts from this state (the reference at the end of chapter 22).

### What's next

Part X turns to macOS as a guest. Chapter 23 takes the high road first: Apple's own Virtualization.framework, which chapter 00 set aside, where Apple supplies the firmware and every device. You boot chapter 14's kernel and test initramfs on it, see a different machine's contract change the result, and list what a VMM like ours would have to provide before macOS would run on it.

### Open question

The checkpoint logs in, runs one command and powers off. It never writes a file and reads it back after a reboot, never sleeps for a measured time, never runs for an hour. What evidence would convince you that a FreeBSD boot is "working" and not merely "printing"?

## Spec hunt

- Virtio 1.2 specification, section 2.2 **Feature Bits** and section 5.2.3 (virtio-blk **Feature bits**): who decides which features a device offers, and what may a driver do with a device whose offer it cannot honour?
- UEFI specification 2.11, section 3.5.1.1 **Removable Media Boot Behavior**, and the runtime service **ResetSystem()**: why is FreeBSD's loader at `\EFI\BOOT\BOOTAA64.EFI`, and what did U-Boot do when FreeBSD asked it to power off?
- FreeBSD source, `sys/dev/virtio/block/virtio_blk.c`, function `vtblk_attach`, and Linux's `Documentation/devicetree/bindings/arm/primecell.yaml`: which properties and features does each guest require, and which does it ignore?
