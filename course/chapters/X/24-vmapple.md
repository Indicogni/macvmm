---
title: macOS guests, the low road: vmapple and AVPBooter (capstone, STRETCH)
part: X
chapter: X.2
id: 24
runs: mac+browser
minutes: 600
prereqs: [21, 23]
start_tag: ch-23
labs: [vmapple-map]
command: scripts/checkpoint.sh 24
expect: CHECKPOINT 24 PASS
---

:::retrieval from=21,12,05

:::concepts
- **Core, taught here:** the vmapple board, a second memory map beside `virt`; the unknown-MMIO logger as a measuring instrument; the device-access trace, summarised by counts only; observed, inferred and unknown; a controlled-variable experiment on an undocumented machine; "load from the host, never copy"; the design record.
- **Core, from earlier:** the exit trace, `--timeout` and `--stats` (chapters 03 and 11); the unhandled MMIO (memory-mapped I/O) policy (chapter 05); MMIO decode and ISV (instruction syndrome valid) (chapter 07); PSCI (power state coordination interface) and system reset (chapter 08); the in-kernel GICv3 and WFI (wait for interrupt) (chapter 12); firmware in a ROM, the ISV=0 path and architecture decision records (chapter 21); Virtualization.framework, its XPC helper and its entitlement, and a macOS bundle's machine identifier (chapter 23).
- **Primers (review):** `codesign-entitlements` (restricted entitlements); `smccc` (PSCI calls in a trace); `reading-arm-specs` (RAZ/WI).
- **Pointers:** QEMU's `hw/vmapple/` sources and vmapple documentation at `v10.0.0`; ParavirtualizedGraphics.framework; Apple's boot chain, in an Aside; the macOS software licence agreement, cited, never legal advice; the QEMU mailing-list patch series that reports the private CPU mode.
- **Forward definitions:** none. The few new names (cfg, bdif, pvpanic, ECID (exclusive chip ID), iBoot, the private CPU mode) are defined where they first appear.
:::

On your Mac, inside Virtualization.framework, sits a file of 335,096 bytes called `AVPBooter.vmapple2.bin`: [AVPBooter](/build-your-own/vmm/glossary/#avpbooter), the boot ROM (read-only memory) a macOS virtual machine runs first. Point the virtual machine monitor (VMM) you built at it, and within half a millisecond it makes 34 accesses to device registers we never built. Then, for the remaining twenty seconds, it makes no [VM exit](/build-your-own/vmm/glossary/#vm-exit) at all, while one of your CPU cores runs flat out.

Is the ROM waiting for us to answer something, or has it given up? And how would you find out without reading a single one of its instructions, which, as you will see, you may not do?

Every row of chapter 00's [problem ledger](/build-your-own/vmm/glossary/#problem-ledger) is closed for Linux and FreeBSD. This chapter goes beyond the ledger: real boot chains are stricter guests, and this one has no published contract at all. The deliverable is an honest trace and a design record, not a boot: macOS does not boot in macvmm, and nothing on this page says it does.

:::objectives
- (Sitting A) Summarise, citing QEMU's `hw/vmapple/` at `v10.0.0`, how QEMU's vmapple machine boots macOS on Hypervisor.framework: AVPBooter loaded from the host, its cfg, bdif, AES and graphics devices, and disks from a Virtualization.framework install.
- (Sitting A) Sort claims about the macOS boot chain into observed, inferred and unknown, and state the rule that keeps our tracing within the licence.
- (Sitting B) Build macvmm with `experimental-vmapple`, run AVPBooter, and summarise its device-access trace with counts only.
- (Sitting B) Predict, then measure, how many distinct addresses AVPBooter touches when unknown reads return 0 and when they return all ones, explain why neither trace is "right", and narrow the experiment to one register of the next device the trace asks for (cfg).
- (Sitting B) Diagnose from the trace and `--stats` whether stalled firmware is polling, waiting for an interrupt, or running without exits; then write a design record with stop criteria set in advance.
:::

**Before you start.** From the repository root, run `scripts/learner start 24 --level open`; a capstone has no scaffold, so this copies only the journal to `learner/journal/24.md`. Sitting A is reading (about 3 hours); sitting B is at your Mac (7 hours or more).

## Two roads to the same guest

Chapter 23 took the high road: Virtualization.framework (VZ) is built to boot macOS from a configuration you fill in (chapter 23's vz-mac does that, with an optional install), because Apple wrote the whole machine, including a helper process with a restricted [entitlement](/build-your-own/vmm/glossary/#entitlement), one only Apple's own code may hold. The low road is ours: an empty machine, every device by hand. The inventory you wrote at the end of chapter 23 is the list of what that road must supply; this chapter checks its first rows against a real trace.

Somebody has walked it: QEMU, the open-source machine emulator, has a board called **[vmapple](/build-your-own/vmm/glossary/#vmapple)** that boots macOS on Hypervisor.framework, shipped in QEMU 10.0 in 2025. Its documentation is blunt: "newer versions than 12.x are currently NOT supported on the guest side".

Its workflow has three steps. First, install macOS 12 with a VZ-based tool and take the machine's identity number, the [**ECID**](/build-your-own/vmm/glossary/#ecid): a 64-bit number held inside the bundle's [machine identifier](/build-your-own/vmm/glossary/#machine-identifier) from chapter 23. QEMU needs it because its board hands it to the ROM in the cfg block below. QEMU's documentation never says "ECID": it calls the same value `uuid`, passes it as `-M vmapple,uuid=`, and pulls it out of the machine identifier with its script `contrib/vmapple/uuid.sh`. vz-mac has a subcommand that prints it, `tools/vz-mac/run.sh ecid --bundle .cache/macvmm/macos-vm`, which works only if you installed macOS in chapter 23. Second, strip the first `0x4000` bytes of the bundle's [auxiliary storage](/build-your-own/vmm/glossary/#auxiliary-storage) image: VZ keeps 16 KiB of its own metadata at the front, which QEMU does not expect (vz-mac's `trim-aux` subcommand does this). Third, start QEMU with `-bios` pointing at `AVPBooter.vmapple2.bin`. Even QEMU needs Virtualization.framework to install macOS; only the later boots run on QEMU's own board.

QEMU is licensed under the GNU General Public License (GPL), so we read it for *facts* (addresses, sizes, field lists), never copying its code or prose. They come from `hw/vmapple/vmapple.c`, `cfg.c`, `bdif.c` and `docs/system/arm/vmapple.rst` at the tag [`v10.0.0`](https://gitlab.com/qemu-project/qemu/-/tree/v10.0.0/hw/vmapple), checked on 2026-11-20.

## What the machine is, according to QEMU

QEMU's board is a table of regions, like our `virt` map from chapter 05, and none of it is where `virt` puts things. GIC is the Generic Interrupt Controller; UART, the serial port (universal asynchronous receiver-transmitter); SPI, a shared peripheral interrupt; RTC, a real-time clock; GPIO, general-purpose input/output pins:

| Region | Base | Size | What it is |
|---|---|---|---|
| firmware | `0x0010_0000` | 1 MiB | AVPBooter |
| cfg | `0x0040_0000` | 64 KiB | configuration block |
| GIC distributor | `0x1000_0000` | 64 KiB | interrupt controller (chapter 12) |
| GIC redistributors | `0x1001_0000` | 4 MiB | one frame per CPU |
| PL011 UART | `0x2001_0000` | 64 KiB | serial console, SPI 1 |
| PL031 RTC | `0x2005_0000` | 4 KiB | clock, SPI 2 |
| PL061 GPIO | `0x2006_0000` | 4 KiB | power button, SPI 5 |
| [pvpanic](/build-your-own/vmm/glossary/#pvpanic) | `0x2007_0000` | 2 bytes | written by a panicking guest |
| bdif | `0x3000_0000` | 2 MiB | "backdoor" disk interface |
| apple-gfx, IOSurface mapper | `0x3020_0000`, `0x3021_0000` | 64 KiB each | graphics bridged to the host (an IOSurface is a macOS shared graphics buffer) |
| AES engine | `0x3022_0000`, `0x3023_0000` | 16 KiB each | AES (Advanced Encryption Standard) cryptography |
| PCIe ECAM, MMIO window | `0x4000_0000`, `0x5000_0000` | 256 MiB, about 512 MiB | [PCI Express](/build-your-own/vmm/glossary/#pcie) (PCIe): [ECAM](/build-your-own/vmm/glossary/#ecam) (Enhanced Configuration Access Mechanism, chapter 23's configuration window), then devices |
| RAM | `0x7000_0000` | as configured | |

*QEMU's vmapple map at v10.0.0. Notice `0x4000_0000`: RAM on our `virt` board, PCI Express configuration space here.*

So vmapple is a second board with its own map, not a variant of `virt`. The CPU side is familiar (chapters 08 and 20): PSCI over `hvc`, secondaries powered off. QEMU passes no device tree; that a later stage builds one for the kernel is inferred from how physical Macs boot, not shown.

The work is in the devices. **[cfg](/build-your-own/vmm/glossary/#cfg-block)** is a page the booter reads to learn about its machine: a version (2), the CPU count, the ECID, the RAM size, two "run the installer" flags, a random seed, network addresses, a serial `"1234"`, a model `"VM0001"`, a chip name `"Apple M1 (Virtual)"`, and fields QEMU's own source names `unk1` to `unk10`: its authors did not know every field either.

**[bdif](/build-your-own/vmm/glossary/#bdif)** (backdoor block interface) is how the booter reads disks before any driver exists. The guest writes, to a command register, the guest-physical address of a three-entry descriptor: where the sector number is, where to put the data, where to write a status byte. The device copies 512-byte sectors of the root or auxiliary disk into guest memory; QEMU's version only reads.

> **Security.** In bdif the guest controls three addresses, a sector number and a length, all in memory a second virtual CPU (vCPU) can rewrite while the device works: chapter 16's virtqueue lesson with no ring around it. Copy the descriptor once, check every address with `checked_add`, cap the length, and write nothing until all of it checks out.

The rest arrives once a kernel runs: the AES engine, which the guest asks to encrypt or decrypt buffers (its built-in keys are Apple's; QEMU uses placeholders), PCI Express with virtio devices, and `apple-gfx`, which hands two register windows to [ParavirtualizedGraphics.framework](https://developer.apple.com/documentation/paravirtualizedgraphics), Apple's library that draws a guest's display on the host with Metal, Apple's programming interface for the graphics processor (GPU).

:::lab vmapple-map

If the lab does not load, here is what it shows when it opens: the map above with each row tagged by its column (defined in the next section) and by what backs it, from QEMU's sources and the first probe of sitting B. The lab keeps sitting B's second run hidden until you ask for it.

```text
row                    column                    seen in the reference runs    source of the row
avpbooter 0x100000     observed                  first exit at pc=0x103478     QEMU vmapple.c, our run
cfg       0x400000     observed                  33 accesses, all unmodelled   QEMU vmapple.c, cfg.c, our run
gicd/gicr 0x10000000   observed (accepted)       hv_gic_create accepts them    QEMU vmapple.c, our run
pl011     0x20010000   inferred                  no access seen                QEMU vmapple.c
pvpanic   0x20070000   observed                  1 access                      QEMU vmapple.c, our run
bdif      0x30000000   inferred                  no access seen                QEMU vmapple.c, bdif.c
pcie, aes, apple-gfx   unknown                   never reached                 QEMU vmapple.c
```

## Observed, inferred, unknown

From here on every sentence you write about this machine goes into one of [three columns](/build-your-own/vmm/glossary/#observed-inferred-unknown). **Observed**: you ran it on your Mac and have the output. **Inferred**: it follows from observations plus a public source you can name. **Unknown**: nobody has shown it, or the only way to show it is closed to you. The skill is refusing to let a plausible sentence drift from the third column into the first.

> **Aside.** Apple's [Platform Security Guide](https://support.apple.com/guide/security/welcome/web) describes how a physical Apple-silicon Mac boots: a boot ROM, then [**iBoot**](/build-your-own/vmm/glossary/#iboot) (Apple's boot loader, the stages after the boot ROM), then the [**kernelcache**](/build-your-own/vmm/glossary/#kernelcache) (the macOS kernel linked with its drivers), each checking the next one's signature. The guide is about hardware and never mentions AVPBooter: use it to *generate hypotheses*, and keep them inferred or unknown until a trace of yours moves them.

Here are the first claims, sorted:

| Claim | Column | Why |
|---|---|---|
| `AVPBooter.vmapple2.bin` is 335,096 bytes | observed | `ls -l` |
| the CPU starts at its first byte, at exception level 1 (EL1), with the memory management unit (MMU) off | inferred | QEMU's board does this; our first exit lies inside the ROM |
| its first device access is to cfg | observed, on our board | the first probe below |
| it reads disks through bdif | inferred | QEMU documents it; sitting B tests whether our runs reach it |
| later stages are iBoot-family loaders that load a kernelcache | unknown | physical Macs suggest it; nothing here shows it |
| a modern macOS guest needs a [private CPU mode](/build-your-own/vmm/glossary/#private-cpu-mode) (a CPU setting only Apple's own helper process may switch on) | observed in part, inferred in part | refused to us: observed by sitting B's probe; needed by guests: inferred from a named QEMU patch series, sitting B |

## The line you do not cross

AVPBooter is Apple software, licensed to you with macOS. Read the licence at `/System/Library/CoreServices/Setup Assistant.app/Contents/Resources/en.lproj/OSXSoftwareLicense.rtf`; nothing here is legal advice. Section 2B(iii) permits up to two additional copies of macOS in virtual machines on each Apple computer you own or control that already runs it, for listed purposes. Section 2K says Apple boot ROM code and firmware may not be copied, modified or redistributed. Section 2N forbids copying, decompiling, reverse engineering or disassembling the software.

A VMM cannot avoid *observing* the code it runs: every exit shows a program counter (PC), an address, a size and a value. So macvmm draws its line:

- **Loaded in place.** The ROM is read from the system path at run time; no code path writes it to a file.
- **Only device accesses, in two instruments.** The logger prints the [device-access trace](/build-your-own/vmm/glossary/#device-access-trace): each access to an address with no device, as `(pc, ipa, size, direction, value)`, at most 256 per boot (the IPA, intermediate physical address, is chapter 05's guest-physical address). The optional exit trace (`--trace exits:FILE`) has one line per exit with the same fields, capped only by file size; it is your private file under `.cache/`.
- **No disassembly** or decompilation of the ROM's instructions.
- **No memory dumps.** Once the ROM has copied itself or its data into guest RAM, a dump of that RAM is a copy of the ROM by another route.
- **Not published:** the per-access lines, the values written, guesses about what the code is for. This page shows counts and how runs ended; your trace stays in your workspace.

The two-copy limit becomes code too, as sitting B shows. Limiting concurrent runs to two is our conservative reading of section 2B(iii), not legal advice.

Before you stop, set yourself the sitting's exercise. Read, at tag `v10.0.0`, the memory map in `hw/vmapple/vmapple.c`, the field list in `hw/vmapple/cfg.c` and `docs/system/arm/vmapple.rst`. Start a draft of your design record (Your turn, at the end of the page) with five claims of your own about the machine, each with its column and its source. The Spec hunt's first item is a good sixth.

:::stopping-point Good place to stop. Sitting B needs your Mac, about 7 hours, and a terminal in the repository.

## Building the board

The vmapple board is behind a cargo feature, `experimental-vmapple`, off by default; a default build refuses it before creating anything:

:::term source=captures/24-default-refuses.txt

Exit code 2 is a usage error; no virtual machine was created.

Now ask a feature build for the boot plan; `cargo run` builds it, and `--dry-run` creates no virtual machine. This replaces `target/debug/macvmm`: run a plain `cargo build -q -p macvmm` before returning to other chapters.

```sh
cargo run -q -p macvmm --features experimental-vmapple -- run --machine vmapple --bios /System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin --mem 4G --unhandled-mmio log --dry-run
```

:::term source=captures/24-dry-run.txt

Besides RAM, four rows have a model behind them: the ROM, the GIC distributor, the first 128 KiB redistributor frame and the PL011. Everything else goes to the [unknown-MMIO logger](/build-your-own/vmm/glossary/#unknown-mmio-logger). `--bios` defaults to the system path:

:::code anchor=avpbooter_path file=crates/vmm/src/loader/firmware.rs

The map follows QEMU's up to bdif; the graphics, AES and PCI Express rows are left out, so an access there is logged as a bare address. A `Reserved` row only names an address for the logger ("cfg"). The comments on `ROM_BASE` and `BDIF_BASE` state as fact what our claims table keeps inferred and unknown; read them as QEMU's documentation, not our observation:

:::code anchor=vmapple_layout file=crates/vmm/src/machine/vmapple/layout.rs

The CPU starts like a real core leaving reset: PC at the ROM's first byte, argument registers zero (no device tree), and PSTATE `0x3c5`, EL1h with everything masked, as in chapter 02:

:::code anchor=vmapple_reset_state file=crates/vmm/src/machine/vmapple/mod.rs

And the two-copy rule: before any Hypervisor.framework call, the run takes one of two lock files, `0.lock` and `1.lock`, in a directory under your home directory. Each is held with `flock`, an advisory lock the kernel drops when the file closes, so a crashed macvmm never keeps its slot. First the function checks the directory: it must be yours, mode `0700`, and not a symbolic link, so nobody else can take your slots. Then it tries each slot in turn:

:::code anchor=vmapple_slot_loop file=crates/vmm/src/backend/hostio.rs

The lock counts only macvmm's vmapple runs, not VZ machines beside them.

## Every unknown access, written down

On `virt`, an access to no device is a guest bug, and the default [unhandled-MMIO policy](/build-your-own/vmm/glossary/#unhandled-mmio-policy) stops at the first one with exit code 3. A ROM written for another board *will* touch devices we lack, and the question is "which ones, in what order?". So the logger answers each the way an empty bus would, [RAZ/WI](/build-your-own/vmm/glossary/#raz-wi) (read as zero, writes ignored), and records it.

Where does that answer come from? A board needs to see accesses no device claims, and some exits, before the generic run loop decides what to do with them. So each machine profile may install a [**watcher**](/build-your-own/vmm/glossary/#watcher): a hook called before each exit is handled and for each unclaimed access, which may take over the decision. `virt` installs none; vmapple installs one. Chapter 07's MMIO path offers an unclaimed access to the watcher first, then to the policy:

:::code anchor=mmio_unclaimed file=crates/vmm/src/vcpu/mmio.rs

`RazWi` writes 0 into the destination register for a read. Remember that line; the experiment below changes it. The logger itself pushes one entry, prints one line, and turns into a stop at the cap:

:::code anchor=unknown_mmio_logger file=crates/vmm/src/machine/vmapple/unknown.rs

Why a cap? A ROM polling a register we lack spins forever, and every spin is an access: the guest decides how often, the VMM decides how much it writes down. The watcher adds three rules: print the first exit, stop on any hypercall macvmm has no designed answer for, and stop on an ISV=0 access:

:::code anchor=vmapple_watch file=crates/vmm/src/machine/vmapple/mod.rs

> **Under the hood.** Chapter 21 handled an ISV=0 access by fetching and decoding the faulting instruction, even from flash. Here the board deliberately leaves that ROM-fetch path off: decoding AVPBooter's instructions is disassembly, which the licence section above rules out. Injecting an abort is out too: the ROM would never see one under VZ, so it would turn the rest of the trace into a record of *our* behaviour. So the board counts the access and stops.

## The first probe

Now run it for twenty seconds, with the logger, an exit trace under `.cache/` (which git ignores) and the statistics:

```sh
mkdir -p .cache/vmapple
cargo run -q -p macvmm --features experimental-vmapple -- run --machine vmapple --bios /System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin --mem 4G --unhandled-mmio log --trace exits:.cache/vmapple/avp.jsonl --timeout 20 --stats
```

Your terminal also shows one `vmapple: unknown MMIO #n` line per logged access; our capture removed them:

:::term source=captures/24-first-probe.txt

Your times will differ; the first-exit PC, the 34 accesses and their split by region should match if your AVPBooter is also 335,096 bytes. The first exit, at `pc=0x103478` inside the ROM window, is a 4-byte store (`WnR=1`, a write, and `SAS=2`, 4 bytes: chapter 07's syndrome fields) to an address with no stage-2 mapping (`DFSC=0x7`, the fault status code for a translation fault: neither RAM nor a device sits behind cfg). It is the first of 34 accesses to no device, 33 in cfg and 1 in pvpanic; no hypercall or ISV=0 stop; `--timeout` ended it, exit code 5. `--stats` adds the strangest line: 19.0 of the 20 seconds spent *executing guest instructions*, none in WFI.

## Reading a stall

Three `jq` commands (`jq` ships with recent macOS) turn the trace into numbers you can publish. The kinds of exit:

:::term source=captures/24-kinds-zero.txt

How many distinct IPAs the ROM touched:

:::term source=captures/24-ipas-zero.txt

And when, in milliseconds, with the exits of the last 10 ms:

:::term source=captures/24-timing-zero.txt

Fourteen addresses, 34 accesses, all between 0.19 ms and 0.49 ms; then nothing until `--timeout` cancelled the vCPU at 20,004 ms (the one exit in the last 10 ms). A stalled guest can look three ways:

| Shape | Exits near the end | `exec` time | WFI time | Example |
|---|---|---|---|---|
| polling a device | many, at the same IPA | high | low | a driver spinning on a status bit |
| waiting for an interrupt | none (in-kernel WFI, chapter 12) | low | high | chapter 12's timer guest sleeping: `exec 0.000 s, wfi 1.048 s` |
| running without exits | none, or very few | high | low or none | chapter 12's no-drain run (a million interrupts, 164 exits, `exec` up from 0.000 s to 0.396 s); this run, `exec` 19.0 s of 20 |

*Three stalls, three fingerprints. Only the first is visibly "waiting for a device".*

On this board a loop polling a register we lack would hit the logger's 256-entry cap and stop with its summary: a capped run, not a timeout, is the polling fingerprint here. Polling something that never exits, such as an in-kernel GIC register, lands in the third row.

Back to the question from the top of the page: waiting, or given up? **Observed**: after its last device access, at 0.49 ms, the ROM ran for the rest of the 20 seconds (19.0 s of it executing guest instructions, by `--stats`) without one exit or WFI. **Inferred**: it touches only things that never exit to us: its ROM and RAM, the in-kernel GIC, the generic timer and the system registers Hypervisor.framework handles itself (chapter 12). **Unknown**: which of those it touches and why; a GIC or timer poll and a deliberate halt look the same from here.

> **Try it.** One of the 34 accesses went to pvpanic. Read QEMU's `docs/specs/pvpanic.rst` (tag `v10.0.0`): what does a guest mean by writing there? Which column does "AVPBooter gave up" belong in, and what experiment would move it? Answer at the end of your Q1 answer in your journal.

## Breaking it on purpose: what an unknown register says

Our logger's 0 is not neutral. To the ROM, a register that reads 0 *says* something: a status bit clear, a count of zero, a version that does not exist. On an undocumented machine, the experiment is to change one [controlled variable](/build-your-own/vmm/glossary/#controlled-variable), keep everything else fixed, and compare traces.

**Deliberate breakage 1: unknown reads return all ones.** Copy the tree outside the repository and make the trace directory the copy lacks:

```sh
rsync -a --exclude target --exclude .cache --exclude .git ./ ../vmapple-ones/
cd ../vmapple-ones && mkdir -p .cache/vmapple
```

Then make one edit, in the copy only:

1. Open `crates/vmm/src/vcpu/mmio.rs` and find the `MmioVerdict::RazWi` arm shown above, with its `regs.set_x(access.reg, 0)` for reads.
2. Immediately before that call, compute all ones of the access size. `unclaimed.size` is the size in bytes (a `u8`): for 8 bytes the answer is `u64::MAX`; otherwise it is `(1 << 8*size) - 1`, computed in `u64`.
3. Pass that value to `regs.set_x` instead of `0`.

The trace's `value` field still records 0 for reads; ignore it here. Rerun the first probe's command in the copy; its first build starts from nothing and takes a few minutes.

:::predict With every unknown read returning all ones (`0xff` for a byte, `0xffff_ffff` for a word) instead of 0, will AVPBooter touch more distinct addresses than the 14 it touched with zeros, fewer, or the same, before the run stops making progress or ends? Will it reach any row it did not reach before, and how will the run end: a timeout, the logger's cap, a stop, a reset?
Write a number and a sentence of reasoning under `## Predict` in your journal. "I cannot know" is allowed, if you say which outcome would surprise you.
:::

:::term source=captures/24-all-ones.txt

Then, still in the copy where the new trace is, the same two summaries:

:::term source=captures/24-kinds-ones.txt

:::term source=captures/24-ipas-ones.txt

One changed value, a different machine. Each boot made 63 logged accesses, 60 in cfg, 1 in pvpanic and, for the first time, 2 in bdif; across the whole trace they hit 16 distinct addresses. Then two hypercalls: [PSCI](/build-your-own/vmm/glossary/#psci) `PSCI_VERSION`, then `SYSTEM_RESET`. macvmm answers a [system reset](/build-your-own/vmm/glossary/#system-reset) by rebuilding the machine, so all of it repeated 11 times (693 = 11 x 63) until chapter 08's cap on resets stopped it with exit code 3. Each rebuilt machine starts with a fresh logger, so the 256-entry cap never filled: 63 per boot, 693 in the file. `--stats` describes only the last boot, which lasted under a millisecond, so its times round to 0.000 and its percentage is noise.

Zero gave a silent spin after 14 addresses; all ones gave a path into bdif and then a reset, every time. The all-ones run never stalled: it ended in a reset storm, and that is itself an observation.

The misconception it exposes: "the run that gets further is the right one". All ones handed the ROM a different wrong machine; neither value is what VZ's cfg holds, so both traces describe *our* machine as much as Apple's ROM. The tool: a controlled variable and a counts-only summary, recorded as observed, never as "the fix".

A global change shows that the answers matter, not which one. The finer experiment changes one register. In the copy's `RazWi` arm, pass `regs.set_x` a candidate value when `unclaimed.ipa` equals one cfg address from your own trace, and 0 for every other address. To separate hypotheses about it (a flag, a count, a version), run once per candidate value (0, all ones, cfg's version 2) and compare the counts. We have not run it, so we show no results.

Return to the repository with `cd -` (or `cd` to your repository's path). Keep `../vmapple-ones` for Your turn, and delete it when you are done.

## The CPU mode you cannot have

Suppose you modelled every device: would a current macOS boot? A patch series posted to QEMU's mailing list, and not merged, reports that recent macOS guests need a private "Apple ISA" CPU mode (ISA, instruction set architecture), switched on by a Hypervisor.framework function no header declares: Mohamed Mediouni's "[RFC PATCH v7 0/7] vmapple: making it work on the latest macOS host releases", March 2026, whose [patch 7/7, "hvf: do not merge: enable private ISA"](https://patchew.org/QEMU/20260324204855.29759-1-mohamed@unpredictable.fr/20260324204855.29759-8-mohamed@unpredictable.fr) calls that function with the value 3 and swaps the public entitlement for a private one. We have not been able to check that a guest needs the mode; we can check whether we may have it. The probe in `tools/hv-denied-probe/`, signed like macvmm, asks for the mode once, finding that function by name at run time with `dlsym`, the C call that looks up a symbol in the loaded libraries:

:::code anchor=hv_denied_probe file=tools/hv-denied-probe/probe.c

```sh
tools/hv-denied-probe/run.sh
```

:::term source=captures/24-hv-denied.txt

**Observed**: the configuration call returned 0, then the virtual machine was refused, `HV_DENIED`, the correct answer on a normally configured Mac. Read that 0 with care: the function's signature and the value 3 are guesses taken from the patch, so a 0 does not prove the mode was set. The solid observation is the pair: `hv_vm_create` succeeds without the call (every macvmm run in this course) and returns `HV_DENIED` with it. Also observed: VZ's helper process for each virtual machine (chapter 23's [XPC service](/build-your-own/vmm/glossary/#xpc-service)) carries `com.apple.private.hypervisor`, one of the restricted entitlements no ad-hoc signature can carry (the `codesign-entitlements` primer):

```sh
XPC=/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc
codesign -d --entitlements - "$XPC" 2>&1 | grep -A1 private.hypervisor
```

:::term source=captures/24-vz-helper-entitlement.txt

**Inferred**, from our two observations plus that patch, which asks for exactly this entitlement: the entitlement unlocks the mode, and the mode is what is refused to us. Testing that patch means switching off macOS's system protections; this course never asks you to.

> **Production note.** This is why VZ is the product and vmapple is research: VZ's helper has the private mode, the graphics bridge and the keys, and Apple can change any of them. A tempting belief is "if QEMU can do it, it is a few days of porting". But QEMU's own cfg block has fields named `unk1` to `unk10`, the keys are Apple's, and the CPU mode is refused to us: each device is an investigation, and an honest progress report is part of the engineering.

## Never copied

Before you write anything up, check that no file in your tree is AVPBooter. Only files of exactly the ROM's size are hashed, so it is fast:

```sh
AVP=/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin
find . -type f -size "$(stat -f %z "$AVP")c" -not -path './.git/*' -exec shasum -a 256 {} + | grep -c "$(shasum -a 256 "$AVP" | cut -c1-64)"
```

:::term source=captures/24-never-copied.txt

Zero matches; `grep -c` exits 1 when it counts nothing, so exit 1 is the good answer.

## Your turn

This is the capstone; there is no scaffolding. In your workspace:

1. **Your own trace.** Run the first probe and the summaries. Record your AVPBooter's size (`stat -f %z "$AVP"`) and the first 16 hex digits of its sha256 (`shasum -a 256 "$AVP" | cut -c1-16`), never the file.
2. **The controlled experiment.** Run zero and all ones, changing nothing else. The all-ones edit lives in `../vmapple-ones`; run the zero case in the repository.
3. **The design record.** Write `learner/docs/macos/design.md` with the sections *Question*, *Setup* (Mac, macOS build, ROM size and hash prefix, commit), *Observed*, *Inferred* (with sources), *Unknown*, *Experiments run*, *Next experiment*, *Stop criteria*. Then write `learner/docs/adr/0002-avpbooter-tracing.md`, an architecture decision record titled "How far we trace AVPBooter". As in chapter 21, an ADR is a short record of one decision, its context and its consequences ([Michael Nygard's original post](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)).
4. **The next device, planned.** The trace asks for cfg. From QEMU's field list, write which fields you would fill and with what. If you installed macOS in chapter 23, take the ECID from `tools/vz-mac/run.sh ecid --bundle .cache/macvmm/macos-vm`; no bundle? Write the fields with a placeholder ECID and say so in *Setup*. Then run one per-register experiment, editing `../vmapple-ones`, and record what changed. Building the whole device is optional: the reference stops at the unmodelled cfg block, and nobody knows whether a filled one gets further.

Stuck? A capstone has no hint ladder. The lab's fallback table and the "What now works" list below show how far the reference got.

## Checkpoint

The default build must refuse `--machine vmapple` (exit code 2), and no file in your tree or caches may have AVPBooter's sha256. A feature build, made in `target/vmapple-feature` so `target/debug/macvmm` is untouched, runs the first probe for 20 seconds: the first exit must be inside the ROM and the unknown-MMIO summary must appear (the reference's milestone). Per-access lines and the trace stay in the run's scratch directory. Last, the private-mode probe must get `HV_DENIED`. The first run compiles for a few minutes.

:::checkpoint

:::term source=captures/24-checkpoint.txt

The end-to-end tests also check exit code 3 under the default `fatal` policy and a refused third concurrent run. Default build:

```sh
cargo test -q -p macvmm --features hvf-tests --test e2e_vmapple -- --test-threads=1
```

:::term source=captures/24-e2e-default.txt

With the feature:

```sh
cargo test -q -p macvmm --features hvf-tests,experimental-vmapple --test e2e_vmapple -- --test-threads=1
```

:::term source=captures/24-e2e-feature.txt

The checkpoint checks that your journal answers every question; check your design record against Your turn yourself. Nothing checks for "macOS booted", because it did not.

What now works:

- macvmm runs Apple's boot ROM, read in place, on a second board, and records every access to a device it lacks;
- you can tell polling, waiting and running stalls apart from `--stats` and the trace;
- you can change one variable on an undocumented machine and report the result as observed, inferred and unknown;
- you know the three gates on the low road: undocumented devices, a CPU mode reserved for Apple, and a licence that forbids reading the code.

The next chapter starts from the reference at the end of chapter 24.

### What's next

Part XI turns the VMM into something you could hand to someone else. Chapter 25 writes the threat model of everything you built, fuzzes the queue code that reads guest data (the discipline bdif's guest-controlled addresses demanded above), turns a hostile guest loose on your VMM, and confines the process with a sandbox.

### Open question

After the first five devices, what would convince you to stop and write "not feasible in the time we have"? Set the criteria now, before spending the time, and say what each would look like in a trace.

## Spec hunt

- QEMU `hw/vmapple/bdif.c` at tag `v10.0.0`: which register offset does the guest write to start a read, what length must the first descriptor entry have, and what is the largest request QEMU accepts?
- The macOS software licence agreement on your Mac, sections 2K and 2N: which sentence makes "load from the host, never copy" a requirement rather than good manners?
