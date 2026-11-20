---
title: Two stages, one map: holes in stage 2 on purpose
part: II
chapter: II.2
id: 05
runs: mac+browser
minutes: 210
prereqs: [04]
start_tag: ch-04
labs: [two-stage-walker]
command: scripts/checkpoint.sh 05
expect: CHECKPOINT 05 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** stage-2 translation and the IPA (intermediate physical address); the stage-2 hole; memory-mapped I/O (MMIO); data abort and the data fault status code (DFSC); why an exit reports an IPA; the IPA size; `layout.rs` and its invariants; the unhandled-MMIO policy.
- **Core, from earlier:** the IPA and the stage-2 mapping (chapter 02); the exit record and the call-versus-retry rule (chapter 02); test guests, the run loop, exit codes and the address size fault (chapter 03); `hv_vm_map`'s 16 KiB rule and the region table (chapter 04).
- **Primers (read first):** `page-tables` (the walk, descriptors, Device memory, the second lookup); `page-granules`.
- **Primers (review):** `os-basics` (virtual memory); `aarch64-reading` (loads, stores, bit fields); `reading-arm-specs` (RAZ/WI).
- **Pointers:** shadow page tables (chapter 00); port I/O (an Aside); dirty tracking (chapter 26); the QEMU `virt` board (chapter 21).
- **Forward definitions:** INTID; SPI (shared peripheral interrupt) and PPI (private peripheral interrupt); virtio slot; the GIC (Generic Interrupt Controller) distributor and redistributors (chapter 12); the bus (chapters 07 and 09); the device tree (chapter 10). Each is defined where it first appears.
:::

A guest wants to say "hi". On the machine it was written for, a [UART](/build-your-own/vmm/glossary/#uart) (universal asynchronous receiver-transmitter), the simplest serial port, sits at `0x0900_0000`: write a byte to its data register and it goes out to your terminal; read it and you get the next byte received (chapter 09 builds one). So the guest stores `h`, `i` and a newline to `0x0900_0000`, one 32-bit store each, then loads the same address back.

Your virtual machine monitor (VMM) has no UART yet. Suppose you make the address exist the quickest way: `hv_vm_map` an ordinary 16 KiB page of RAM there.

:::predict Does `hi` appear in your terminal, and what value does the guest's load read back?
Write your answer under `## Predict` in your journal, with one sentence of reasoning.
:::

This chapter finishes row 2 of chapter 00's problem ledger, memory, and opens row 3, devices. Both are answered by the same table: stage 2 maps what is there and, on purpose, leaves out what is not. Sitting A is on paper (1.5 hours); sitting B is at your Mac (2 hours).

:::objectives
- (Sitting A) Explain with the UART example why a device register cannot be RAM, so device windows are stage-2 holes.
- (Sitting A) Explain what stage 2 saves over shadow page tables, in two sentences.
- (Sitting A) Walk a guest virtual address through a three-level stage-1 table to an IPA, predicting each level's index first, then say whether stage 2 maps it.
- (Sitting B) Write `arch/layout.rs` as the single source of truth for the memory map and test its invariants. Compute the IPA size with `ipa_bits_needed`, and refuse a machine that needs more than the host's maximum.
- (Sitting B) Make a store to a never-populated hole produce a data-abort exit with its IPA, and stop cleanly with exit code 3.
:::

**Before you start.** From the repository root, run `scripts/learner start 05` to copy this chapter's journal to `learner/journal/05.md`. In sitting B, type each code block into your workspace, `learner/`, and run from inside it.

## Two lookups, two owners

The `page-tables` primer ended with this picture:

```text
  guest (untrusted)                          |  host: HVF and our VMM
                                             |
  VA --[stage 1: the guest's tables]--> IPA -|-[stage 2: HVF's tables]--> host memory
       written by the guest kernel           |  filled by our hv_vm_map calls
       a failure goes to the guest kernel    |  a failure becomes a VM exit for us
```

*Every guest memory access is translated twice, by two owners; the trust boundary runs between them.*

Inside a virtual machine (VM), a program uses a virtual address (VA). [Stage 1](/build-your-own/vmm/glossary/#stage-1-stage-2) is the guest kernel's own page tables, rooted at `TTBR0_EL1` and `TTBR1_EL1`. Its output is an [IPA](/build-your-own/vmm/glossary/#ipa) (intermediate physical address), the address the guest believes is physical. Stage 2 is a second set of tables, owned by Hypervisor.framework (HVF) and filled by our `hv_vm_map` calls; its output is real memory in our process.

Each stage has its own [granule](/build-your-own/vmm/glossary/#granule), the page size its tables use (chapter 04): arm64 Linux usually uses 4 KiB for stage 1; HVF's stage 2 uses the Mac's 16 KiB by default.

## The problem stage 2 solves

Why two walks? A guest kernel writes page-table descriptors thousands of times a second, without asking anyone. With a single stage, whatever the guest's tables output *is* the address the hardware uses, so those descriptors would hold real host addresses, which the guest must never choose.

The classic answer, from chapter 00, was [**shadow page tables**](/build-your-own/vmm/glossary/#shadow-page-table): the VMM keeps its own tables mapping guest VAs straight to host memory, and write-protects the guest's tables so every write to them traps: one VM exit each ([Adams and Agesen, ASPLOS 2006](https://doi.org/10.1145/1168857.1168860)).

Stage 2 removes the problem. The guest edits stage 1 with no traps; the VMM touches stage 2 only when the machine changes. On a miss the hardware walks both tables, up to 24 memory reads (the primer's "Under the hood"), but no exits; the TLB (translation lookaside buffer, the primer's translation cache) makes misses rare.

Journal question 3 asks for this in two sentences of your own; write it now.

## A device cannot be RAM

Back to the puzzle. The UART's data register is not storage: writing sends a byte, reading removes one from the input queue. RAM read twice gives the same value.

A kernel with its MMU (memory management unit, the hardware that walks the translation tables, both stages) on marks the UART page as a Device memory type (the primer's section on `MAIR_EL1`): Linux uses Device-nGnRE, our test guests the stricter Device-nGnRnE. With the MMU off, every data access is treated as Device anyway. But Device memory changes only *how* the CPU performs the access; *where* it goes is stage 2's decision, and if stage 2 says "RAM", the store lands in RAM.

We checked on a real Mac, with one page of RAM at `0x0900_0000` and a guest that does what the puzzle describes. `uart-ram`, and `va-alias` below, are throwaway experiment guests, not shipped in `guests/`; read their captures. These runs use the reference monitor from the repository root; `--stats` is its flag, not yours. `{guests}` stands for `target/guests/aarch64-unknown-none/release`:

:::term source=captures/05-uart-ram.txt

No `hi`. The load returned `0xa`, the last byte stored: the "UART" is a word of memory. And 71 exits, all `hvc` (debug output and power-off), none for the four accesses. A mapped address never stops the guest, so the VMM never learns of the store.

So we leave the device's addresses out of stage 2. Every access there fails stage 2, the CPU takes an exception to exception level 2 (EL2, where Apple's hypervisor runs), HVF forwards it to us as a VM exit, and our VMM plays the device. That gap is a [**stage-2 hole**](/build-your-own/vmm/glossary/#stage-2-hole), and talking to a device by loading and storing at its addresses is [**memory-mapped I/O**](/build-your-own/vmm/glossary/#mmio) (MMIO). The same guest on the finished reference, with chapter 09's UART behind the hole:

:::term source=captures/05-uart-device.txt

`hi` appears, the load returns 0 (nothing typed), and the stats show four data aborts, each an exit.

> **Aside.** x86 PCs also have *I/O ports*, a separate device address space ([Intel's Software Developer's Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), volume 1). Arm has none.

## What the exit tells us: an IPA

You have half met this exception in chapter 02. A failed instruction fetch is an [**instruction abort**](/build-your-own/vmm/glossary/#instruction-abort) (class `0x20` from the guest); a failed load or store is a [**data abort**](/build-your-own/vmm/glossary/#data-abort), class `0x24`. The low six bits of its ESR (Exception Syndrome Register) value are the [**DFSC**](/build-your-own/vmm/glossary/#dfsc) (Data Fault Status Code): which kind of fault it was.

Our VMM never reads the guest's page tables. When stage 2 fails, the hardware has already translated the VA through stage 1. It reports the IPA's page number in [`HPFAR_EL2`](/build-your-own/vmm/glossary/#hpfar-el2) (Hypervisor IPA Fault Address Register) and the VA in `FAR_EL2` (Fault Address Register). The page offset is the same in both, so the IPA can be rebuilt from `HPFAR_EL2` plus the low 12 bits of `FAR_EL2`; HVF hands us the result in the exit record.

Chapter 02's exit record carries both: the VA (its FAR field) and the IPA. We use only the IPA. The VA means something only inside the guest's current address space; the same VA can point to a different IPA a moment later. The IPA belongs to our map.

With the MMU off, as in every guest so far, VA and IPA are equal. This guest turns the MMU on with the tables in `guests/common/mmu.rs` and stores to VA `0x0b10_0000`, which those tables send to IPA `0x0b00_0000`. That is a window our map reserves for a test device, which a later chapter adds; today nothing is behind it, so it is a hole:

:::term source=captures/05-va-alias.txt

The VMM printed the IPA, `0xb000000`. The VA shows up only in `x8=0x000000000b100000`, the base register of the faulting `str w9, [x8]` (the word at the PC, `0xb9000109`). The VMM sees IPAs, not guest virtual addresses.

How do we know stage 2 failed and not stage 1? A stage-1 fault is the guest kernel's own page fault, delivered through `VBAR_EL1` to the guest (chapter 02's routing); that is why `ESR_EL1` stays zero here. Only a stage-2 failure reaches EL2 and us, so an exit's DFSC describes the stage-2 walk.

`DFSC=0x6` needs a table. For a data abort the ARM ARM (Arm Architecture Reference Manual) defines, among others:

| DFSC | Meaning |
|---|---|
| `0x00` to `0x03` | [address size fault](/build-your-own/vmm/glossary/#address-size-fault), level 0 to 3: a table address or the final output address is wider than the configured output size |
| `0x04` to `0x07` | [**translation fault**](/build-your-own/vmm/glossary/#translation-fault), level 0 to 3: the walk found no valid entry at that level |
| `0x0d` to `0x0f` | permission fault, level 1 to 3: an entry exists but forbids this access |

*The level says where the walk failed. With the default 16 KiB granule, stage 2 here starts at level 2: a 36-bit IPA needs only levels 2 and 3. An input too large for the walk at all is reported at level 0, because no table was read.*

`0x6` is a translation fault at level 2: stage 2's first lookup found no entry, because we never mapped anything there. That is the signature of a hole.

## Walk one by hand

The `va-alias` store, as the hardware did it. First the geometry, from the dump: `TCR_EL1` is `0x1_0080_3519`. Its low six bits are `T0SZ = 0x19 = 25`, so addresses are 64 - 25 = 39 bits (the primer's `T0SZ` table), and `TG0` (bits 15 and 14) is 0, so pages are 4 KiB. That makes three levels, each taking 9 bits of the VA: bits 38 to 30 at level 1, 29 to 21 at level 2, 20 to 12 at level 3; the low 12 bits are the offset.

Compute the three indices of `0x0b10_0000` before reading the table (the primer's `printf` one-liner does it in the shell). `TTBR0_EL1` is `0x40084000`, as the dump shows; the other table addresses come from our build of that guest:

| Level | Table base | Index | Descriptor read at | Descriptor | Meaning |
|---|---|---|---|---|---|
| 1 | `0x4008_4000` | `0` | `0x4008_4000` | `0x0000_0000_4008_5003` | table at `0x4008_5000` |
| 2 | `0x4008_5000` | `0x58` | `0x4008_52c0` | `0x0000_0000_4008_6003` | table at `0x4008_6000` |
| 3 | `0x4008_6000` | `0x100` | `0x4008_6800` | `0x0060_0000_0b00_0403` | page at `0x0b00_0000`, Device memory |

*Three reads, each at the table base plus eight times the index; the last one is a leaf.*

The leaf's low bits `0x403` read, with the primer's section "What a descriptor says", as access flag set, `AttrIndx = 0` and "page"; bits 53 and 54 forbid execution. Our guest sets `MAIR_EL1` byte 0 to `0x00`, Device-nGnRnE, in `guests/common/mmu.rs`. So stage 1 says: IPA `0x0b00_0000`.

Now stage 2, with its own 16 KiB pages: is the page holding `0x0b00_0000` mapped? We mapped only RAM, from `0x4000_0000`. No: stage 2 fails, and the exit carries `0x0b00_0000`.

Now walk VA `0x0b10_1000` on paper. Which level-3 index, and at which address is its descriptor read? The descriptor there is `0x0060_0000_0900_0403`. Decode it: which IPA, which memory type, and does stage 2 map that IPA? (Check your walk: index `0x101`, read at `0x4008_6808`.)

The `two-stage-walker` lab is meant to walk a VA through both stages, each with its own granule. It is still being built:

:::lab two-stage-walker

Until it loads, redo the table on paper for `0x4000_1234` (level 1 index 1 holds a 1 GiB block covering all of RAM, so the walk stops there and the IPA equals the VA). Then stage 2: which 16 KiB page holds `0x0900_0000`, and which holds `0x4000_1234`? Is either mapped?

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 2 hours.

## One map, one file

If holes are deliberate, someone decides where they are: one file, `crates/vmm/src/arch/layout.rs`. Mappings, devices, checks and the device tree (chapter 10's description of the machine for the kernel) are all built from it, because two copies of an address would one day disagree.

We copy [QEMU's `virt` board](https://www.qemu.org/docs/master/system/arm/virt.html), QEMU's standard Arm machine, whose map stock firmware and kernels already know. The reference's `--dry-run` prints the whole board without creating a VM (run it from the repository root; your VMM does not have the flag):

:::term source=captures/05-dry-run.txt

Two rows are ours, not QEMU's: `testdev`, a window for a small test device we add later, and `probe-hole`, where QEMU puts a platform bus we never populate. `pl011` is the UART and `pl031` a clock; the other names are QEMU devices we do not build. Some rows carry an [**INTID**](/build-your-own/vmm/glossary/#intid), the number that will name the device's interrupt line (chapters 11 and 12).

Every region has a *kind*, which decides what the VMM does with an access there. In `learner/crates/vmm/src/arch/layout.rs`:

:::code anchor=layout_region_kind_enum file=crates/vmm/src/arch/layout.rs

Flash, the board's read-only firmware storage, is mapped only when you boot firmware with `--bios` (chapter 21). The [GIC](/build-your-own/vmm/glossary/#gic) (Generic Interrupt Controller) routes device interrupts to CPUs. It has a shared part, the [distributor](/build-your-own/vmm/glossary/#distributor), which decides where each device's interrupt goes, and one private part per CPU, a [redistributor](/build-your-own/vmm/glossary/#redistributor) (chapter 12): the `gicd` and `gicr` rows.

:::code anchor=layout_may_be_mapped file=crates/vmm/src/arch/layout.rs

`may_be_mapped` marks the kinds something other than a VMM exit may serve: RAM, flash with `--bios`, and the GIC windows HVF can claim. From chapter 12, HVF services the distributor and one redistributor frame per vCPU; the unused rest of `gicr` comes back to us and reads as zero. We do not enable the `gic-v2m` frame, so it is a hole today despite its kind.

Today only RAM is mapped; everything else is a hole that exits to us.

A row of the map, and its helpers:

:::code anchor=layout_region file=crates/vmm/src/arch/layout.rs

:::code anchor=layout_region_methods file=crates/vmm/src/arch/layout.rs

`unit_address` names the region's device-tree node, as in `pl011@9000000`; derived from `base`, it cannot disagree with it. The bases other modules need get names:

:::code anchor=layout_bases file=crates/vmm/src/arch/layout.rs

The table, sorted by base:

:::code anchor=layout_virt_table file=crates/vmm/src/arch/layout.rs

`Reserved` rows mark devices QEMU has and we do not. They stop us from ever placing one of our own devices there, and they let the VMM name the device a stray access was aimed at. RAM has no row; chapter 04's region table holds it. The sizes `--mem` accepts:

:::code anchor=layout_ram_limits file=crates/vmm/src/arch/layout.rs

2 MiB steps keep RAM whole 16 KiB pages and a Linux kernel 2 MiB-aligned; 255 GiB from 1 GiB ends at exactly `1 << 38`. A refused size says why (write `use std::fmt;` where the reference has `core::fmt`):

:::code anchor=layout_ram_size_error file=crates/vmm/src/arch/layout.rs

Test guests are linked 512 KiB into RAM, after the device tree's slot:

:::code anchor=layout_test_guest_base file=crates/vmm/src/arch/layout.rs

Finally the board, which owns the table (`profile` is optional). The methods below go in its `impl Layout` block:

:::code anchor=layout_struct file=crates/vmm/src/arch/layout.rs

`cargo build -p vmm` should compile now; the tests come after the next section.

## Slots and interrupt numbers

A [**virtio slot**](/build-your-own/vmm/glossary/#virtio-slot) is one of 32 MMIO windows for paravirtual devices, designed for virtual machines (chapter 15). QEMU wires slot *i* to [SPI](/build-your-own/vmm/glossary/#spi) (shared peripheral interrupt) `16 + i`, and SPIs are numbered from INTID 32, so slot *i* is INTID `48 + i`:

:::code anchor=layout_virtio_consts file=crates/vmm/src/arch/layout.rs

:::code anchor=layout_virtio_slot file=crates/vmm/src/arch/layout.rs

Slot 31 is at `0x0a00_3e00` with INTID 79. A slot is only `0x200` bytes: RAM comes in 16 KiB pieces because `hv_vm_map` maps it, but a hole is the *absence* of a mapping, so it can be any size. `find`, at the end of that block, names the region holding an IPA.

The UART and clock carry INTIDs 33 and 34. QEMU hands some lines out in blocks to devices we do not build; we reserve each block whole so nothing collides with it later:

:::code anchor=layout_intid_range file=crates/vmm/src/arch/layout.rs

:::code anchor=layout_intid_blocks file=crates/vmm/src/arch/layout.rs

Not every interrupt is shared. A [PPI](/build-your-own/vmm/glossary/#ppi) (private peripheral interrupt, INTIDs 16 to 31) belongs to one CPU, and each CPU's virtual timer uses 27 (chapter 11):

:::code anchor=layout_vtimer_intid file=crates/vmm/src/arch/layout.rs

The redistributor window holds one 128 KiB frame per vCPU, at most 64; `gicr_size` gives their total, and `ram_end` checks a `--mem` size:

:::code anchor=layout_gic_frames file=crates/vmm/src/arch/layout.rs

:::code anchor=layout_gicr_ram_end file=crates/vmm/src/arch/layout.rs

## The invariants, as tests

Write tests of what a correct map is, in `learner/crates/vmm/tests/layout_invariants.rs`; the checkpoint runs its own copy:

1. **No overlaps, no overflow**, with `checked_add`.
2. **Mapped regions are 16 KiB-aligned**, base and size, for every kind where `may_be_mapped()` is true.
3. **Everything ends at or below `1 << 40`**, the largest IPA size on our Apple M5 Pro (`create_vm` checks the real host).
4. **INTIDs are unique SPIs**, inside 32 to 1019, counting the region lines, the slot lines and every reserved block; the timer's INTID is a PPI.
5. **`virtio_slot(0) == Some((0x0a00_0000, 48))`**, `virtio_slot(31) == Some((0x0a00_3e00, 79))`, `virtio_slot(32) == None`.
6. **The GIC fits**: 64 KiB-aligned bases, as HVF's in-kernel GIC requires, and 64 redistributor frames end below the UART.
7. **RAM sizes** from 64 MiB to 255 GiB in 2 MiB steps are accepted, the rest refused.

## How many address bits: the IPA size

Chapter 01's doctor printed `max IPA: 40 bits (default 36)` on a Mac with far less than a terabyte of RAM. The 40 is how many address bits stage 2 accepts as input. A VM with an [IPA size](/build-your-own/vmm/glossary/#ipa-size) of *n* bits can address `[0, 2^n)`, and nothing above. HVF uses 36 bits (64 GiB) unless told otherwise. The function that picks ours:

:::code anchor=layout_min_ipa_bits file=crates/vmm/src/arch/layout.rs

:::code anchor=layout_ipa_bits file=crates/vmm/src/arch/layout.rs

Compute one before reading on. The default 512 MiB of RAM ends at `0x6000_0000`. What does `ipa_bits_needed(0x6000_0000)` return?

31 bits would do (`1 << 31` is `0x8000_0000`), yet the function returns 36: the loop starts at `MIN_IPA_BITS`, HVF's default, so a small machine gets the VM it would get with no setting. 255 GiB of RAM gives 38.

The answer reaches HVF through a configuration object, an `hv_vm_config_t`, a reference-counted Apple "OS object": we must drop our reference with `os_release` when done, or it leaks. Declare the calls from `hv_vm_config.h`, and the release:

:::code anchor=ffi_vm_config_ipa file=crates/hvf/src/ffi.rs

:::code anchor=ffi_os_release file=crates/hvf/src/ffi.rs

The reference wraps it in `OsObject` (`crates/hvf/src/host.rs`), the RAII (resource acquisition is initialization) pattern of chapter 01's `Vm`: it releases the object once, on drop:

:::code anchor=os_object file=crates/hvf/src/host.rs

The reference's VM builder sets the size only if asked:

:::code anchor=vm_config_ipa_size file=crates/hvf/src/vm.rs

Give your own `Vm::new` (chapter 01) an `ipa_bits: Option<u32>` parameter, add the lines above, and pass `config.as_ptr()` to `hv_vm_create` in place of the null pointer:

:::code anchor=vm_create_call file=crates/hvf/src/vm.rs

The host's limits come from two queries that need no VM:

:::code anchor=caps_ipa_probe file=crates/hvf/src/caps.rs

The VMM refuses a machine the host cannot hold before creating anything. These lines open the reference's `create_vm`; put them right before your `Vm::new(Some(bits))`:

:::code anchor=vm_ipa_check file=crates/vmm/src/vm.rs

`caps.max_ipa_bits` is the first query's answer (the reference's `hvf::Capabilities::probe()`); `ram_end` is `Layout::virt().ram_end(mem_size)?`. If your error enum has no `Config` variant, add one that maps to exit code 2, like chapter 03's usage errors. Compute `bits` once and pass it to your `GuestRam::new` too, in place of chapter 04's literal 36.

Here the largest legal machine needs 38 bits and the host allows 40, so you will not see the refusal. On a Mac with a smaller maximum, a large `--mem` should stop with exit code 2; we have no such host to check.

## When the guest touches a hole

Now the trap: a branch for class `0x24` in your run loop that decodes the syndrome, decides what lives at the IPA and applies a policy. This chapter reads three syndrome fields: WnR (bit 6, write not read), SAS (bits 23 and 22, the access size as `1 << SAS` bytes) and the DFSC. SAS is meaningful only when ISV (bit 24, "instruction syndrome valid") is 1, as it is here; chapter 07 handles ISV = 0. In `learner/crates/vmm/src/arch/esr.rs`, the bit-field helpers (`field` cuts `width` bits out of a value from bit `lo`; `bit` is the one-bit case):

:::code anchor=esr_field_helpers file=crates/vmm/src/arch/esr.rs

With them, the syndrome's class, its instruction-length bit, and the ISS (instruction specific syndrome) that holds everything else:

:::code anchor=esr_header_fields file=crates/vmm/src/arch/esr.rs

Then the whole decoded syndrome (chapter 07 keeps this shape), its size helper and the decoder:

:::code anchor=esr_data_abort_struct file=crates/vmm/src/arch/esr.rs

:::code anchor=esr_data_abort_size file=crates/vmm/src/arch/esr.rs

:::code anchor=esr_decode_data_abort file=crates/vmm/src/arch/esr.rs

Classification asks: RAM, a device on the bus, or which board region? The bus is the VMM's list of emulated devices by address window (chapters 07 and 09). The reference's classifier:

:::code anchor=mmio_ipa_class file=crates/vmm/src/vcpu/mmio.rs

:::code anchor=mmio_classify_ipa file=crates/vmm/src/vcpu/mmio.rs

You have no bus yet, so drop the `bus` parameter and the `Device` arm: check RAM with chapter 04's `check_range`, then ask `Layout::virt().find`. Keep the `Rom` arm: without firmware, flash is a hole.

Then the [unhandled-MMIO policy](/build-your-own/vmm/glossary/#unhandled-mmio-policy), from `--unhandled-mmio fatal|log`. Parse it into an enum `MmioPolicy` with unit variants `Fatal` and `Log`, deriving `Clone`, `Copy`, `Debug`, `Default`, `PartialEq` and `Eq`, with `Fatal` marked `#[default]`. `log` makes reads return zero and ignores writes, the convention Arm calls [RAZ/WI](/build-your-own/vmm/glossary/#raz-wi) (read as zero, writes ignored). The policy's answer, in `learner/crates/vmm/src/vcpu/exit.rs`:

:::code anchor=mmio_verdict file=crates/vmm/src/vcpu/exit.rs

:::code anchor=unhandled_mmio_policy file=crates/vmm/src/vcpu/exit.rs

For the reference's rate-limited `crate::guest_warn!`, write a plain `eprintln!`. To resume, the VMM must write the zero into the load's register and advance the PC, which a data abort leaves *at* the instruction; chapter 07 does both. For now, accept `--unhandled-mmio log`, but treat `RazWi` as a fatal stop with the message `log policy needs chapter 07`.

Now the branch, in your chapter 03 loop:

1. For class `0x24`, call `decode_data_abort` on the exit's `esr`; the IPA is the exit record's `ipa` field.
2. Read the guest's PC, as your trace does.
3. Classify the IPA. `Ram` never faults (it is mapped), so stop with a VMM-bug message; for every other class call `unhandled_mmio_policy`.
4. On `Fatal(msg)`, or for now `RazWi`, print `macvmm: guest fatal: ` and the message to standard error and exit with code 3, new: the guest broke the machine's rules.

From inside `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/mmio-poke.bin@0x40080000 --timeout 10
```

The reference's run:

:::term source=captures/05-poke-fatal.txt

Yours prints only the first line of standard error. The second reads: class `0x24`, `WnR=1` (a store), `SAS=2` (4 bytes), `DFSC=0x6` (a hole).

**Deliberate breakage 1: hard-code the IPA size.** In your VMM, pass `Some(31)` to `Vm::new` in place of `Some(bits)`, and leave `GuestRam` alone (our runs made the same change in the reference's `create_vm`).

:::predict Two runs of `mmio-poke`: with `--mem 64M`, and with `--mem 2G`. What happens in each?
Write both predictions before reading on.
:::

First 64 MiB:

:::term source=captures/05-ipa31-64m.txt

The same exit as above: 31 bits cover RAM ending at `0x4400_0000`. Now 2 GiB, which ends at `0xC000_0000`:

:::term source=captures/05-ipa31-2g.txt

What you saw: the guest never ran; `hv_vm_map` refused the RAM, exit code 1 (a host failure). The misconception: "the IPA size is a detail; smaller only wastes less". The tools: `ipa_bits_needed`, and the invariant "everything ends below the limit". Undo the edit.

Chapter 04's `RegionTable::new`, inside your `GuestRam`, could have caught this first: it refuses a region that ends above `1 << ipa_bits`. Pass it 31 too and it refuses before `hv_vm_map` is called, even for 64 MiB, because it accepts only widths 32 to 52.

> **Try it.** What if the address is outside the IPA space altogether? Predict the DFSC for a store to `1 << 36` in our 36-bit VM: translation or address size fault, and at which level? To run it, set `HOLE` in `guests/mmio-poke/main.rs` to `1 << 36` and run `scripts/build-guests.sh`; afterwards `git restore guests/` and rebuild. Our run used a renamed copy, `ipa-poke`. This is journal question 2.

:::term source=captures/05-beyond-ipa.txt

What to look for: `DFSC=0x4`, a translation fault at level 0, though our walk starts at level 2: an input outside the IPA size is never looked up. Chapter 03's address size fault was a different check: with the MMU off, the guest's address *is* stage 1's output, so being too wide was an output problem, taken at EL1. Here the address is too wide as an *input* to stage 2.

> **Security.** The guest chooses the IPA in every data-abort exit. Classify it against the map, never index anything with it. The default stops loudly, so probing is noticed; with `log` the guest decides how often a warning fires, so the reference rate-limits them.

> **Production note.** Real hypervisors also map RAM *read-only* on purpose (`hv_vm_protect`): the first write to each page exits once, telling the VMM which pages changed, for live migration and snapshots (chapter 26).

## Your turn

The checkpoint's tests compile against these public names in `vmm::arch::layout`, so spell them exactly:

- the table: `Region` (with `end`, `contains`, `unit_address`), `RegionKind` (with `may_be_mapped`), `VIRT_REGIONS`, `Layout` (with `virt`, `find`, `virtio_slot`, `gicr_size`, `ram_end`, `ipa_bits_needed`);
- addresses: `RAM_BASE`, `GICD_BASE`, `GICR_BASE`, `GICR_FRAME_SIZE`, `GICR_WINDOW_END`, `MAX_CPUS`, `VIRTIO_MMIO_SLOTS`, `VIRTIO_MMIO_STRIDE`, `TEST_GUEST_BASE`, `DTB_MAX_TEST_GUEST`;
- RAM: `RAM_MIN`, `RAM_MAX`, `RAM_DEFAULT`, `RAM_ALIGN`, `RAM_MAX_END`;
- interrupts: `PL011_INTID`, `PL031_INTID`, `VTIMER_INTID`, `RESERVED_INTIDS`, `PCIE_INTX_INTIDS`, `GIC_V2M_INTIDS` (an `IntidRange` has `name`, `first`, `last` and `contains`).

They also use chapter 04's `REGION_ALIGN`, `GuestAddress` and `RegionTable`. Then check:

1. `cargo test -p vmm` passes your layout tests, and `ipa_bits_needed(0x6000_0000)` is 36 for the reason above, not by luck.
2. The `mmio-poke` run, from inside `learner/`, ends with exit code 3 and the line `macvmm: guest fatal: unhandled MMIO write at 0xc000000 size 4 pc 0x4008…` (your PC may differ in the last digits).
3. Your journal has the Predict entry, written before you read its run.

Stuck? `scripts/learner hint 05` gives four hints, from a nudge to the reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

Its three result lines are, in order: the contract tests against your layout; `mmio-poke` on your Mac, which expects the guest's `storing` line, our stop message and exit code 3, and fails if `survived` appears; and the journal check:

:::term source=captures/05-checkpoint.txt

What now works: the board is one tested table, the IPA size follows from it, and a store to a hole stops cleanly with exit code 3.

The next chapter starts from this state (the reference at the end of chapter 05).

### What's next

Chapter 06 turns to the CPU: which registers must hold what before it runs someone else's code, and how does a register dump expose a fault the guest took inside itself?

### Open question

Our default stops at the first touch of a hole. The reference with `--unhandled-mmio log` (yours, after chapter 07):

:::term source=captures/05-poke-log.txt

The guest carried on and printed `survived`; only our warning knows. From the guest's point of view, what is the difference between "no device here" and "a device that ignores you"?

## Spec hunt

- ARM ARM (DDI 0487), register page **ESR_EL2**, data-abort field **DFSC**: which code means a permission fault at level 3?
- ARM ARM, register page **HPFAR_EL2**: which IPA bits does it hold, and for which faults is it valid?
- QEMU's `hw/arm/virt.c`, `base_memmap[]` and `a15irqmap[]`: which regions did we leave out or resize?
