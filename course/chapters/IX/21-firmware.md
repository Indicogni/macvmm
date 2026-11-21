---
title: Firmware: a stricter guest (U-Boot, flash, ISV=0)
part: IX
chapter: IX.1
id: 21
runs: mac+browser
minutes: 480
prereqs: [18, 20]
start_tag: ch-20
labs: [boot-chain]
command: scripts/checkpoint.sh 21
expect: CHECKPOINT 21 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** emulating a load or store whose syndrome is blank (instruction syndrome valid, ISV = 0); a bounded stage-1 walker for 4 KiB and 16 KiB guest pages; the exit's intermediate physical address (IPA) as the only authority; injecting a synchronous external abort; the firmware boot protocol (firmware at `0x0`, the device tree blob (DTB) at the start of RAM); flash is not RAM.
- **Core, from earlier:** the exit trace and its `mmio` filter (chapter 03); stage 2, IPAs and the memory map (chapter 05); memory-mapped I/O (MMIO) decode from the syndrome and the ISV = 0 refusal (chapter 07); exception injection, the power state coordination interface (PSCI), `--on-reset` and the EL1t/EL1h stack-pointer choice (chapter 08); the DTB and its big-endian header (chapter 10); the boot plan and `--dry-run` (chapter 13); virtio-blk and `--disk` (chapter 18); one thread per vCPU (chapter 20).
- **Primers (read first):** `uefi` (boot and runtime services, EFI applications, the configuration table; you need it for the decision record); `u-boot` (the prompt, the environment, `bootefi`, `virtio scan`); `page-tables` (descriptors, levels, `TTBR0`/`TTBR1`, the TLB, turning the MMU on).
- **Primers (review):** `aarch64-reading` (`ldp`, `stp` and reading an instruction word); `caches` (cache maintenance by address); `efi-zboot` (a kernel packaged as an EFI application, which firmware can start and our direct boot refuses).
- **Pointers:** (Asides and links) Common Flash Interface (CFI) flash; EDK2 `ArmVirtQemu`; architecture decision records; exclusives, atomics, SIMD and `DC ZVA` in the Arm Architecture Reference Manual (ARM ARM).
- **Forward definitions:** FreeBSD's `loader.efi` (chapter 22), defined at first use.
:::

Here is U-Boot, the firmware real Arm boards run first, on our virtual machine monitor (VMM) with chapter 07's rule still in place: a data abort whose note is blank stops the VM. It prints nothing:

:::term source=captures/21-uboot-refused.txt

This is our run; you reproduce it in sitting B, once `--bios` exists (`scripts/fetch.sh uboot` fetches the firmware). The very first store stopped the machine: program counter (PC) `0x17c`, a write to `0x12c668`, ISV = 0. The dump could not even show the instruction: `insn at pc: not readable`. What lives at `0x12c668`, why can our VMM not read the instruction, and what should it do instead?

:::predict Find `0x12c668` on chapter 05's memory map. Once your VMM can decode the instruction behind a blank note, what happens to this store: (a) it changes U-Boot's own bytes, (b) it is dropped and U-Boot carries on, or (c) U-Boot gets an abort and stops?
Write your answer and one sentence of reasoning under `## Predict` in your journal before your first run. Sitting B runs it.
:::

Row 10 of the [problem ledger](/build-your-own/vmm/glossary/#problem-ledger), a boot chain, was closed in chapters 13 and 14 with our VMM as the bootloader; here a real firmware takes that job. Sitting A teaches the VMM to read the instruction behind a blank note; sitting B gives the firmware its flash and boots U-Boot to its prompt. Each takes about 4 hours.

:::objectives
- (Sitting A) Decode `ldp`, `stp`, `ldpsw` and the single-register loads and stores from the instruction word, and name what you refuse (exclusives, atomics, SIMD and floating-point, `DC ZVA` and five rarer families).
- (Sitting A) Translate a guest virtual address through the guest's own 4 KiB or 16 KiB page tables in at most four reads.
- (Sitting A) Emulate an ISV = 0 access on the exit's IPA, change registers only after every access succeeded, and answer any refusal with an injected synchronous external abort.
- (Sitting B) Write an architecture decision record choosing U-Boot or EDK2 as the first firmware, then compare it with the project's.
- (Sitting B) Map both flash banks read-and-execute outside guest memory (bank 0 holds an image of at most 64 MiB, bank 1 reads as zero), with guest writes trapped and ignored.
- (Sitting B) Start a guest by the firmware boot protocol and explain how it differs from direct boot.
:::

**Before you start.** Run `scripts/learner start 21`. This is an Open chapter: each part gives a brief and the tests that judge it. Write your version first, then compare with the reference's choices.

## Where the note runs out

Recall chapter 07: on a data abort the hardware writes a note into the syndrome, and with [ISV](/build-your-own/vmm/glossary/#isv) (instruction syndrome valid) set, the note gives one register, one size and one direction. That is enough to emulate the *access* without reading the instruction.

But `stp x0, x1, [x9]` moves two registers, and `ldr x1, [x0], #8` (load, then add 8 to `x0`) also changes its base register. The note has room for neither, so the hardware leaves ISV = 0. Linux reaches devices through accessors (`readl`, `writel`) built from plain single loads and stores; firmware is less careful.

Here are the words U-Boot ran, read straight from its file. `xxd -e` prints 4-byte little-endian words, one instruction each, so the word at `0x174 + 8 = 0x17c` is the third, `a9000520`:

:::term source=captures/21-uboot-insn.txt

The `aarch64-reading` primer showed how to read fields; for a pair the ARM ARM (Arm's architecture manual, DDI 0487) gives this layout:

| Bits | Field | Meaning | `0xa9000520` |
|---|---|---|---|
| 31:30 | opc | element size: `00` 4 bytes, `10` 8 bytes (`01` with L = 1 is `ldpsw`) | `10`: two 8-byte `x` registers |
| 29:27, 26, 25 | fixed, V, fixed | `101`, then V (1 would mean SIMD registers), then `0` | `101`, 0, 0 |
| 24:23 | mode | `00` non-temporal (`ldnp`/`stnp`, refused), `01` post-index, `10` offset, `11` pre-index | `10`: plain offset |
| 22 | L | 1 load, 0 store | 0: store |
| 21:15 | imm7 | signed offset, times the element size | 0 |
| 14:10, 9:5, 4:0 | Rt2, Rn, Rt | second register, base, first register | 1, 9, 0 |

So it is `stp x0, x1, [x9]`. Check all four words with clang's disassembler (`.inst` puts raw words into an object file):

:::term source=captures/21-uboot-disasm.txt

`adrp` and `add` set `x9` to `0x12c668`; the second pair stores `x2` and `x3` 16 bytes further on. An x86 VMM decodes every faulting instruction this way; on Arm, only when ISV is 0.

## The plan: five steps and one rule

First the rule: **the exit's IPA is the truth.** The [IPA](/build-your-own/vmm/glossary/#ipa) (intermediate physical address) the exit reports is where the guest really faulted; the instruction only tells us *what kind* of access it was. The steps:

1. Fetch the 4-byte word at the PC, through the guest's own page tables.
2. Decode it, or refuse it.
3. Read the operands. As a base register, number 31 is the stack pointer PSTATE selects (`SP_EL0` at EL1t, `SP_EL1` at EL1h, as in chapter 08's vector table), never `xzr`.
4. Check the decode against the exit (the address must translate to the exit's IPA, the direction must match [WnR](/build-your-own/vmm/glossary/#wnr), the access must stay inside the one stage-1 mapping, page or block, that faulted, and inside one device), then perform the accesses *on the exit's IPA*.
5. Only then change registers: the loaded values, then the base register, then PC + 4.

Anything refused becomes an abort in the guest, never an error in the VMM.

## Decoding: what to accept and what to refuse

**Brief.** A pure function from a `u32` to a decoded access or a named refusal, never a panic. Accept the pairs `ldp`, `stp`, `ldpsw` in their three writeback modes, and single-register loads and stores in five addressing forms, with byte, half-word and sign-extending variants:

| Form | Example | Address, and what happens to `x1` |
|---|---|---|
| unsigned offset | `ldr x0, [x1, #16]` | `x1` + imm12 × size (16 = 2 × 8); unchanged |
| unscaled | `ldur x0, [x1, #-3]` | `x1` + signed imm9, in bytes; unchanged |
| pre-index | `ldr x0, [x1, #8]!` | `x1` + 8; then `x1` = that address |
| post-index | `ldr x0, [x1], #8` | `x1`; then `x1` += 8 |
| register offset | `ldr x0, [x1, x2, lsl #3]` | `x1` + (`x2` << 3); unchanged |

Field layouts: the ARM ARM, "Loads and Stores" (C4.1). Refuse, each with a named reason: exclusives, atomics, load-acquire and store-release forms, SIMD and floating-point, `DC ZVA`, non-temporal pairs (`ldnp`), unprivileged (`ldtr`), pointer-authentication (`ldraa`) and memory-tagging (`stgp`) forms, and PC-relative literal loads. Cache maintenance by address (`DC CIVAC`, the `caches` primer) touches no device: when the syndrome's CM bit (bit 8, "cache maintenance") agrees, only advance the PC.

**Acceptance.** Vectors for every class, writeback mode and size, a list of words that must be refused, and 10,000 random words that must not panic. The vectors come from a corpus whose words clang assembled, so the test does not trust our own encoder:

:::term source=captures/21-insn-corpus.txt

**The reference's choice.** One function per class; here is the pair decoder:

:::code anchor=insn_decode_pair file=crates/vmm/src/arch/insn.rs

`decode_single`, in the same file, has the same shape. Note two refusals: `ldp x1, x1, [x0]` and `ldr x1, [x1, #8]!` (base written back and also loaded) have no single defined result in the ARM ARM, so emulating either would mean guessing.

> **Aside.** Why the main families are refused. Exclusives (`ldxr`/`stxr`) rely on the exclusive monitor, the hardware that remembers which address a `ldxr` reserved, which we do not model. Large System Extensions (LSE) atomics (`ldadd`, `cas`) are read-modify-write, which a device cannot promise. SIMD (single instruction, multiple data) and floating-point loads use registers we do not read. `DC ZVA` zeroes a whole block.

## Finding the instruction: a stage-1 walk

Step 1 hides a problem. Once a guest turns its memory management unit (MMU) on, its PC is a virtual address (VA). In case 16 of `isv0-probe`, the guest's tables map VA `0x8008_1828` to the same RAM as `0x4008_1828`; as a physical address, `0x8008_1828` is past the end of the 64 MiB of RAM. Hypervisor.framework has no "translate this address" call, so the VMM walks the guest's [stage 1](/build-your-own/vmm/glossary/#stage-1-stage-2) tables in software, as you did by hand in the `page-tables` primer. The guest picks 4 KiB or 16 KiB pages for itself, whatever our 16 KiB stage 2 uses.

A worked walk, with the probe's registers from the dump in deliberate breakage 1 below (chapter 07 printed the same): `TCR_EL1 = 0x100803519`, `TTBR0_EL1 = 0x40086000`. A debug line in a copy of the reference printed the entry the walker read:

:::term source=captures/21-walk-descriptor.txt

```text
TCR_EL1.T0SZ = 25  -> 64 - 25 = 39-bit addresses; TG0 = 0 -> 4 KiB pages
4 KiB pages: 12 offset bits + 9 bits per level -> 39 bits need levels 1, 2, 3
VA 0x80081828:  level-1 index = VA[38:30] = 2
  entry at 0x40086000 + 2*8 = 0x40086010 holds 0x40000705
  bits 1:0 = 01: a level-1 block, 1 GiB
  bits 47:30 = 1: output address 1 << 30 = 0x40000000
IPA = 0x40000000 | (VA & (1 GiB - 1)) = 0x40081828
```

*One read: a level-1 block ends the walk early; a 4 KiB page would take three. The low bits `0x705` are attributes: access flag, shareability, memory type.*

**Brief.** Translate a VA through the tables the guest's kernel (EL1) and its programs (EL0) share, set by `TCR_EL1` and `TTBR0_EL1`/`TTBR1_EL1`. VA bit 55 picks `TTBR0` (0, the lower half) or `TTBR1` (1, the upper half); `T0SZ` (and `T1SZ` for the upper half) from 16 to 39; 4 KiB and 16 KiB granules, blocks only where the architecture allows; MMU off means the identity. Refuse the rest: 64 KiB pages, 52-bit addresses, invalid descriptors, tables outside RAM. **Acceptance.** Host tests for each of those cases, both granules, block and page, three and four levels, and a table that points at itself.

**The reference's choice.** First, choose the half and the start table:

:::code anchor=stage1_walk_select file=crates/vmm/src/arch/stage1_walk.rs

`select_range` is the walk's first line: bit 55 picks the half, `TCR_EL1` gives its size and granule, and a VA whose top bits do not match is refused. `first_table_bits` drops the low `TTBR` bits that cannot be part of a table address. (Numbers like "D19.2" are ARM ARM sections.) Then the loop:

:::code anchor=stage1_walk_loop file=crates/vmm/src/arch/stage1_walk.rs

Each turn is one line of the worked walk: an index, one bounds-checked 8-byte read, then `step` decides: `Step::Next` (a table) or `Step::Done` (a block or page). Ours ended with `Done` at level 1; its `mapping_size` (1 GiB) travels with the IPA for step 4.

> **Security.** The tables are guest memory, so they are hostile input. A recursive walker could be sent round a cycle forever; this `for` loop ends after four reads, even when an entry points at its own table. Every descriptor goes through chapter 04's bounds-checked guest-memory API, so a table "in" a device or past RAM is a refusal, not a read.

## The exit's IPA is the truth

Why not translate the decoded address and use *that*? Our walk reads the tables in memory, after the fault; the hardware used its TLB, the cache of walks from the `page-tables` primer. In between, another vCPU (chapter 20) can rewrite the instruction or the tables. Even one vCPU can disagree with itself: if it edits a descriptor without the `TLBI` that drops the old translation, the hardware keeps using the stale one. The hardware checked permissions for the faulting access only. So the decoded address is only a cross-check, and every byte we emulate must fall inside the one stage-1 mapping (page or block) that faulted:

:::code anchor=isv0_plan_body file=crates/vmm/src/arch/insn.rs

Three checks come first: direction against WnR, the walked address against the exit's, then `within_mapping`. The access is built on `exit.ipa`, never on `map.ipa`. A pair's second element must translate to exactly the exit's IPA plus the element size, and both halves must lie in one device's window; otherwise a pair could straddle two devices and land its second half in a neighbour that never faulted:

:::code anchor=isv0_pair_body file=crates/vmm/src/arch/insn.rs

Then the accesses happen, in order, and the register updates come back as a value, not as side effects:

:::code anchor=isv0_execute_body file=crates/vmm/src/arch/insn.rs

## Saying no: a synchronous external abort

What should a guest see when we refuse? On a real board, when the memory system cannot complete an access, the CPU takes a data abort meaning "the outside world said no": a **synchronous external abort**, DFSC (data fault status code) `0x10`, exception class (EC) `0x25`, "taken at the level that caused it". The `0x24` in our own exits means "from a lower level": to the hypervisor the guest is always lower. The guest kernel handles it like any other fault. Chapter 08 taught you to inject an exception; this is one more kind:

:::code anchor=inject_data_abort_body file=crates/vmm/src/arch/inject.rs

The VM keeps running; a guest sending garbage pays with its own aborts.

## The run

The handler ties the five steps together. Steps 1 to 3:

:::code anchor=isv0_emulate_decode file=crates/vmm/src/vcpu/mmio.rs

`decode_at_pc` is steps 1 and 2: it walks the PC, fetches the word and decodes it. Its `Err` is an outcome already decided: an injected abort when either fails, or a skip for cache maintenance, which makes no access. `SpSel::from_pstate` is step 3's rule for register 31. Steps 4 and 5:

:::code anchor=isv0_emulate_commit file=crates/vmm/src/vcpu/mmio.rs

`translate` carries the vCPU's translation registers, so `emulate_isv0` can walk any VA without knowing about vCPUs. A refusal injects the abort; a failing device is still fatal, as in chapter 07.

**Deliberate breakage 1: keep chapter 07's refusal.** Run this in `learner/` now, before you write the decoder: your tree still has the stop `isv0-probe` met in chapter 07. Run `isv0-probe` and read the dump with this chapter's eyes. Ours, with the reference's ISV = 0 branch replaced by that stop:

:::term source=captures/21-isv0-refused.txt

The chapter 07 message and exit code 3, at the first `stp`. `TCR_EL1` and `TTBR0_EL1` are the worked walk's registers; `insn at pc: 0xa9002909` is `stp x9, x10, [x8]`. What you saw: an honest stop. The misconception: "an unsupported instruction crashes the VMM". The tool: the dump, which hands you the word to decode.

Now the finished path, with an exit trace (chapter 03's `--trace`, filtered to MMIO):

```sh
cargo run -q -p macvmm -- run --mem 64M --testdev --kernel target/guests/aarch64-unknown-none/release/isv0-probe --trace exits:isv0.jsonl:mmio --timeout 10
```

:::term source=captures/21-isv0-probe.txt

:::term source=captures/21-isv0-probe.trace.jsonl

Seventeen records say `"isv":false`: sixteen emulated, one `inject_abort` for the SIMD store `str q0`, which the guest checked (EC `0x25`, DFSC `0x10`). The record with `"pc":"0x80081828"` is the code alias, fetched through the walker.

**Deliberate breakage 2: trust the walk, not the exit.** Send the access to the address your walk computed instead of the exit's IPA: in the reference's `plan_isv0`, delete the `map.ipa != exit.ipa` comparison and build the first access on `map.ipa` (or do the same in yours). Predict: which of `isv0-probe`, `hostile-isv0` (fifteen accesses the VMM must refuse) and the host tests notice?

:::term source=captures/21-walk-ipa-probe.txt

:::term source=captures/21-walk-ipa-hostile.txt

:::term source=captures/21-walk-ipa-tests.txt

Both guests pass; only `isv0_ipa_mismatch_aborts` in `crates/vmm/tests/insn_decode.rs` fails. Its fake `translate` answers with a page the hardware never faulted on: decoded `184553480` is `0xb001008`, exit `184549384` is `0xb000008`, the next 4 KiB page, and the broken plan stored there. What you saw: a bug neither guest shows, because neither changes its tables or code after a fault; a second vCPU can, and so can one vCPU with a stale TLB. The misconception: "the walk and the exit agree". The tool: a host test that scripts the disagreement on demand.

:::stopping-point Good place to stop. Sitting B needs `u-boot.bin` (`scripts/fetch.sh uboot`) and about 4 hours.

## Decide first: which firmware?

Sitting B starts with a decision on paper. Two stock firmwares are built for QEMU's `virt` machine: U-Boot's `qemu_arm64` build, and [EDK2's `ArmVirtQemu`](https://github.com/tianocore/edk2/tree/master/ArmVirtPkg), the reference implementation of the Unified Extensible Firmware Interface (UEFI) from the `uefi` primer. Two facts: EDK2 keeps its UEFI variables in a second flash bank that it programs with flash commands (CFI, below), which our machine does not emulate; U-Boot runs with a default environment when it cannot save one, and its `bootefi` (the `u-boot` primer) can start an EFI loader. Write `learner/docs/adr/0001-first-firmware.md`: which one first, and why? Weigh what each demands of our machine, what each gives the next chapter (FreeBSD needs UEFI), and how you would test it.

> **Aside.** An architecture decision record (ADR) is a page per significant decision: context, decision, consequences, alternatives, in Michael Nygard's [short format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). This repository keeps its own in `docs/adr/`. The point is the *why*, so a later reader can tell whether the reasons still hold.

Then read `docs/adr/0007-firmware-path-for-freebsd.md`. Where did you weigh differently?

## Two ways to start a machine

Chapter 13's [direct boot](/build-your-own/vmm/glossary/#direct-boot) made the VMM a bootloader: kernel into RAM, PC at the kernel, `x0` = the DTB. A real board starts lower down: the CPU begins in flash, in the firmware, which finds the hardware, then loads an operating system. QEMU's `virt` fixes the details: firmware at `0x0`, `PC = 0`, the DTB at the start of RAM, where U-Boot looks for it. We also pass the DTB's address in `x0`, as Linux's `booting.rst` asks, and U-Boot saves it. That is the **firmware boot protocol**, and the reason chapter 05 copied QEMU's map: U-Boot was built for it, and runs here unmodified. Compare chapter 13's `entry   pc=0x40200000 x0=0x40000000 cpsr=0x3c5`:

:::term source=captures/21-dry-run.txt

RAM holds only the device tree; the 1,453,944-byte firmware sits in flash. The plan:

:::code anchor=bootplan_firmware_body file=crates/vmm/src/loader/plan.rs

We still write the DTB; the firmware decides what the operating system receives. Who loads what, and which DTB each stage sees (`loader.efi` is FreeBSD's EFI application that loads its kernel; chapter 22 runs the last row):

| Chain | Loaded by | Where it runs | The DTB it sees |
|---|---|---|---|
| direct boot: Linux | our VMM | RAM, `0x4020_0000` | ours, at `0x4000_0000` (`x0`) |
| firmware boot: U-Boot | our VMM | flash, `0x0` | ours, then its own copy near the top of RAM |
| U-Boot `booti`: Linux | U-Boot | RAM | the one at the address `booti` is given |
| U-Boot `bootefi`: `loader.efi`, then a kernel | U-Boot, then `loader.efi` | RAM | the one U-Boot puts in the UEFI configuration table |

The `boot-chain` lab at the end of the next three sections steps through these chains.

## Flash is not RAM

On a real board firmware lives in NOR flash. It reads like read-only memory (ROM), so the CPU executes straight from it ("in place"), but writing takes a command sequence (unlock, erase a whole sector, program); a plain store changes nothing. QEMU's `virt` has two 64 MiB flash banks: `flash0` at `0x0` and `flash1` at `0x0400_0000`, the dry run's first two map lines.

> **Aside.** The command set is the Common Flash Interface (CFI), JEDEC standard JESD68. QEMU emulates it; we do not, so our device tree has no `flash@0` node and U-Boot finds no flash chip. EDK2 needs it for its variable store.

**Brief.** One read-and-execute region over both banks: bank 0 holds the image (empty or over 64 MiB is refused), bank 1 reads as zero. Map it *outside* guest memory, so no device's direct memory access (DMA) can write firmware. A guest store there faults at stage 2; the data-abort handler finds a `Rom` region at that IPA, and the bus hands the access to a write-ignore flash device, which logs and drops it. **Acceptance.** Host tests for size 0 and 64 MiB plus one byte, zero padding, and writes ignored at every width.

**The reference's choice.** The size check comes first, so a bad image changes nothing; the rest of the window is then zeroed:

:::code anchor=firmware_load_rom_check file=crates/vmm/src/loader/firmware.rs

The wiring maps both banks and puts one flash device over each:

:::code anchor=machine_load_firmware_body file=crates/vmm/src/machine/mod.rs

The flash device's write handler, rate-limited because the guest picks the rate:

:::code anchor=flash_write_ignored_body file=crates/vmm/src/devices/flash.rs

Why map bank 1, empty as it is? U-Boot reads its saved settings, its environment, from `0x0400_0000` to check a checksum; with bank 1 unmapped, that read stopped the boot as unhandled MMIO (`docs/compat/uboot.md`).

## U-Boot at its prompt

Now the opening's puzzle. `0x12c668` is in flash bank 0, inside U-Boot's own image. Its very first instructions save the boot registers `x0` to `x3` into its own data, which still sits inside the image, because firmware runs in place until it has copied itself to RAM. So its first two exits are ISV = 0 pairs whose PC is in flash:

:::term source=captures/21-uboot-first-exits.txt

`"value":"0x40000000"` is `x0`: our DTB's address, saved. The PC's IPA, `0x17c`, is not RAM, so step 1 found nothing in guest memory. The reference adds one read-only path for this, beside guest memory rather than inside it:

:::code anchor=stage1_fetch_insn_rom_body file=crates/vmm/src/arch/stage1_walk.rs

:::code anchor=rom_read_u32 file=crates/vmm/src/memory/host.rs

The mapping itself is read and execute only:

:::code anchor=rom_map file=crates/vmm/src/memory/host.rs

Boot it yourself with an empty 16 MiB disk. At `Hit any key to stop autoboot: 2`, press Enter within 2 seconds, or U-Boot goes looking for an operating system. At the `=> ` prompt type `version`, then `virtio scan; virtio info`, then `poweroff` to leave (exit code 0). In our capture a script typed the keys:

```sh
truncate -s 16M disk.img
cargo run -q -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M --disk disk.img --on-reset exit
```

:::term source=captures/21-uboot-prompt.txt

On standard error, five ignored flash writes: the two pairs and one flag. `Flash: 0 Bytes`: no CFI chip in our device tree. Bank 1 reads as zeros, so the environment's checksum fails (`bad CRC`) and U-Boot uses its default environment. `virtio info` finds our disk (chapter 18's virtio-blk). Type `reset` instead of `poweroff`, and it goes through PSCI (power state coordination interface, chapter 08) and exits with code 4 under `--on-reset exit`:

:::term source=captures/21-uboot-reset.txt

One more look at the opening dump: `DFSC=0x7`, a translation fault, though the page is mapped read-only; a store there should be a permission fault, `0xf`. Our guess: Hypervisor.framework fills in stage-2 entries lazily, so a page nobody has touched has no entry yet. We tested it with a debug line printing every flash abort, and U-Boot's `md` (memory display) and `mw` (memory write; `.l` means 4-byte words):

:::term source=captures/21-flash-dfsc.txt

`0x2000000`, read first, gives a permission fault (`0xf`); `0x2100000`, never touched, a translation fault (`0x7`); `0xed4`, in the page U-Boot runs from, `0xf`. The evidence fits, but Hypervisor.framework's source is not public, so it stays a guess. Our VMM does not care: chapter 07's rule classifies the IPA with our own map, never with the fault code.

**Deliberate breakage 3: map flash read-write.** Make the flash mapping writable: `MemFlags::RWX` instead of `MemFlags::RX` in the reference's `RomRegion::map`, or the equivalent line in yours. It is tempting: then even chapter 07's VMM, with no decoder, reaches the prompt, because U-Boot's first stores no longer exit:

:::term source=captures/21-flash-rw-no-decoder.txt

Predict: does a value written to flash stay, does `saveenv` (save the environment) work, and does anything survive `reset`? Type `md.q 0x12c668 1` (the 8-byte word where U-Boot saved `x0`), `mw.l 0x4000000 0xdeadbeef` (bank 1's first word), `md.l 0x4000000 1`, `saveenv`, `reset`, Enter at the countdown, `md.l 0x4000000 1` and `poweroff`:

:::term source=captures/21-flash-rw.txt

The same keys on the reference:

:::term source=captures/21-flash-write.txt

With read-write flash, the firmware's own image changed (`0x12c668` now holds `0x40000000`), and `0xdeadbeef` reads back from bank 1. `saveenv` fails in both runs with `not on sector boundary`: with `Flash: 0 Bytes`, U-Boot has no table of flash sectors, so no address can be on a sector boundary. That is how "no flash chip" shows up (our reading of the behaviour; we have not checked U-Boot's source). After `reset` the value is gone: the VMM reloaded the image and zeroed the rest. What you saw: writes that seem to work, then nothing persists. The misconception: "read-write memory is flash". The tool: the flash device's log line, and `md` after a reset.

## Where did our DTB go?

We put the DTB at `0x4000_0000`. Ask U-Boot (no disk this time): type `bdinfo` (board information), `printenv fdtcontroladdr` (the DTB U-Boot itself uses), `fdt addr $fdtcontroladdr; fdt header` (select that tree, print its header) and `md.l 0x40000000 2`, then `poweroff`:

:::term source=captures/21-uboot-dtb.txt

U-Boot works from `0x5e6596e0`, near the top of RAM: it copied itself and the DTB there, out of the way of what it loads next. The copy's `totalsize`, 1687 bytes, matches our dry run. Our original is still at `0x40000000`: `md.l` prints `edfe0dd0`, the magic `d00dfeed` with its bytes reversed, because the DTB is big-endian (chapter 10) and `md.l` prints little-endian words; `97060000` is `totalsize`, `0x697`, the same way. Two copies now exist. Which one will an operating system receive, and who may change it on the way?

The lab steps through each chain of the table above and asks, at every step, who owns the DTB:

:::lab boot-chain

## Your turn

Before the checkpoint, in `learner/`: your ADR exists, your journal's Predict entry predates your first run, `cargo test -p vmm` passes, and the runs above behave as shown, with nothing on standard error saying `unhandled MMIO` or `not emulated`. Stuck? `scripts/learner hint 21` gives four hints.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (decoder, walker, flash fetch, boot plan, flash out of DMA's reach, injection), four runs on your Mac (`isv0-probe`; U-Boot with a disk, without one, and `reset`), and the journal check. Our run:

:::term source=captures/21-checkpoint.txt

What now works:

- your VMM emulates loads and stores the syndrome could not describe, reading the instruction through the guest's own tables, and answers everything else with an abort;
- the exit's IPA, not the instruction, decides where an access goes;
- firmware runs in place from flash the guest can read and execute but never change;
- stock U-Boot reaches its prompt, finds the disk, powers off and resets.

The next chapter starts from the reference at the end of chapter 21.

### What's next

U-Boot can start an EFI application from a disk. Chapter 22 hands it FreeBSD's, and finds out where a second operating system disagrees with our machine.

### Open question

In direct boot, the kernel reads the DTB we wrote. In firmware boot, U-Boot keeps its own copy, and an operating system started through UEFI may get yet another. Who owns the DTB in firmware boot, and what should our VMM assume if the firmware edits it?

## Spec hunt

- ARM ARM (DDI 0487), register page **ESR_EL2**, "ISS encoding for an exception from a Data Abort", field **ISV**: which instructions give ISV = 0, and which does our decoder still refuse?
- ARM ARM, chapter D8, "The AArch64 Virtual Memory System Architecture", the descriptor formats: at which levels may a 4 KiB granule use a block, and a 16 KiB one?
- U-Boot source, `board/emulation/qemu-arm/lowlevel_init.S`, the routine `save_boot_params`: which registers does it store, and into which section of the image?
