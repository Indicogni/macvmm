---
title: Page granules: 4 KiB and 16 KiB
slug: page-granules
kind: primer
minutes: 15
required_by: [04]
labs: [two-stage-walker]
runs: mac+browser
command: pagesize
expect: 16384
---

# Why can a 4 KiB guest live in 16 KiB pages?

Open Terminal on your Mac and type `pagesize`. It prints `16384`: your Mac cuts memory into 16 KiB
pages. Two words before we go on: a **guest** is the operating system running inside our virtual
machine, and **Hypervisor.framework (HVF)** is Apple's API for running one. In chapter 02 you
gave the guest its first memory as "one 16 KiB host page", because that is the smallest piece HVF
hands out. Yet the Alpine Linux kernel we will boot in chapter 14
was built for 4 KiB pages, and it will happily ask for one 4 KiB page at a time. Who is right, the
Mac or the kernel? Both, and by the end of this primer you will be able to show why with a few
lines of arithmetic.

:::objectives
- Define a translation granule and list what it fixes.
- Split an address into page base, offset and table indexes for 4, 16 and 64 KiB granules.
- Name the owner of each translation stage and the register that picks its granule.
- Explain why a 4 KiB guest runs on a 16 KiB stage 2, and what the mismatch costs.
- Read the granule-support fields of `ID_AA64MMFR0_EL1`.
:::

:::prereqs
- The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer: virtual memory, pages and a page table, with its worked
  two-level example.
- Chapter 02, where the guest got its first memory as one 16 KiB host page.
- Shell arithmetic with hex numbers (`$(( ))` and `printf '%#x'`), which the primer shows as it
  goes.
:::

## Your Mac's page size, measured

A quick reminder from the
[`os-basics`](/build-your-own/vmm/primers/os-basics/) primer: an operating system does not track memory byte by byte. It cuts
memory into equal, aligned pieces called **pages**. Each program sees **virtual addresses**, and a
**page table** says, for each virtual page, which **physical page** (a real piece of RAM) backs
it. The low bits of an address, the **page offset**, pass through translation unchanged; only the
high bits, the page number, are looked up. With 4 KiB pages, for example:

```
virtual 0x0000_5234   = page 0x5,  offset 0x234
page table says:        virtual page 0x5 -> physical page 0x8_0042
physical 0x8004_2234  = page 0x8_0042, offset 0x234 (unchanged)
```

Three macOS commands report the size of those pieces:

```sh
pagesize
sysctl hw.pagesize
vm_stat | head -n 1
```

```
16384
hw.pagesize: 16384
Mach Virtual Memory Statistics: (page size of 16384 bytes)
```

16384 is 16 × 1024, written **16 KiB** (a KiB, "kibibyte", is 1024 bytes; we write KiB rather than
KB so nobody wonders whether a thousand was meant). In hexadecimal it is `0x4000`. Most PCs, and
most Linux kernels for Arm, use 4 KiB (`0x1000`) pages instead. Your output will match ours on any
Apple Silicon Mac.

A size like this comes with an alignment rule. A 16 KiB page always starts at a multiple of
`0x4000`, so its start address has its low 14 bits equal to zero (2¹⁴ = 16384). An address is
**16 KiB-aligned** when those 14 bits are zero; it is 4 KiB-aligned when its low 12 bits are zero.
Every 16 KiB-aligned address is also 4 KiB-aligned, but not the other way round.

## A granule is the page size a translation table uses

On Arm, the page size is not a property of the memory or of the chip. It is a setting of each
**translation table**, the hardware-readable form of a page table that the processor walks by
itself. The Arm architecture calls that setting the **translation granule**, or **granule** for
short: the page size a translation table uses. The architecture defines three: 4 KiB, 16 KiB and
64 KiB.

Why "walks"? A single flat table with one entry per page would be enormous: 48 bits of address
space in 4 KiB pages is 2³⁶ pages, and at 8 bytes per entry (enough to hold a 64-bit physical
address plus a few permission bits) that is 512 GiB of table per program. So Arm uses a tree
instead. The top bits of the address index a small first table, whose entry points at a second
table; the next bits index that one, and so on. Following the chain is called a **walk**, and each
table along it is one **level**. Arm numbers the levels from the top, starting at 0, so level 3
is the last one, the one that finally names the page. Here is a toy two-level walk:

```
address bits:  | index for level A | index for level B | page offset |
                        │                     │
   level A table ──entry──▶ level B table ──entry──▶ physical page, + offset
```

A real Arm walk is the same picture with up to four levels. The address size we use throughout
is 48 bits, because that is how many virtual-address bits Arm's common configurations translate
(256 TiB, far more than any machine needs); the top 16 bits of a 64-bit pointer are not looked
up. The [`page-tables`](/build-your-own/vmm/primers/page-tables/) primer walks a real tree entry by entry.

Choosing a granule fixes more than the page size, because Arm builds its tables out of pages too.
Each table occupies exactly one granule, and each entry in it is 8 bytes, so a 4 KiB table holds
4096 / 8 = 512 entries and needs 9 address bits to pick one (2⁹ = 512). The walk consumes the
address from the top, that many bits per level, until only the page offset is left over:

| | 4 KiB granule | 16 KiB granule | 64 KiB granule |
|---|---|---|---|
| Page offset bits | 12 | 14 | 16 |
| Entries per table (granule / 8 bytes) | 512 | 2048 | 8192 |
| Index bits per level | 9 | 11 | 13 |
| Levels for a 48-bit address | 4 (levels 0 to 3) | 4 (levels 0 to 3; level 0 has 2 entries) | 3 (levels 1 to 3) |

The levels row is just division. With 4 KiB, 48 − 12 = 36 bits remain above the offset, and
36 / 9 = 4 levels exactly. With 64 KiB, 48 − 16 = 32 bits, and three levels of 13 bits already cover
that (the first one uses only 6 of its bits), so the walk starts at level 1. With 16 KiB, 48 − 14 = 34 bits: three levels of 11 bits
take 33, leaving one bit for level 0, whose table therefore needs only 2 entries.

One more consequence, which the `page-tables` primer covers properly: an entry above the last
level may map a whole aligned chunk directly (a **block**) instead of pointing at another table.
A bigger granule means fewer levels and bigger chunks: one level-2 entry covers 2 MiB with
4 KiB pages but 32 MiB with 16 KiB pages.

### One address, two granules

Take the address `0x4008_1234` (Rust lets us write underscores in numbers for readability; the
shell does not, so we drop them there). With a 4 KiB granule, the offset is the low 12 bits and
the page base is the address with those bits cleared. With 16 KiB, it is 14 bits. In the shell,
`$(( ... ))` does 64-bit integer arithmetic (it works the same in zsh, the macOS default, and in
bash), `&` keeps the bits that are set in the mask and `~` flips every bit of the mask, so
`va & ~0x3fff` clears the low 14 bits:

```sh
va=0x40081234
printf '%#x\n' $(( va & 0xfff ))
printf '%#x\n' $(( va & ~0xfff ))
printf '%#x\n' $(( va & 0x3fff ))
printf '%#x\n' $(( va & ~0x3fff ))
```

```
0x234
0x40081000
0x1234
0x40080000
```

The same byte is offset `0x234` in the 4 KiB page at `0x4008_1000`, and offset `0x1234` in the
16 KiB page at `0x4008_0000`. Same address, two different pages, depending only on the granule.

The table indexes come from shifting and masking too. We write a bit range as **[hi:lo]**,
meaning "bits hi down to lo", counting from bit 0 at the right; so [11:0] is the low 12 bits.
With 4 KiB, levels 1, 2 and 3 use bits [38:30], [29:21] and [20:12] (9 bits each); with 16 KiB,
bits [46:36], [35:25] and [24:14] (11 bits each). To extract bits [29:21], shift the address
right by 21 (`>> 21` moves every bit 21 places down, dropping the low ones), then keep the low
9 bits with `& 0x1ff` (nine 1-bits):

```sh
printf '%#x %#x %#x\n' $(( (va >> 30) & 0x1ff )) $(( (va >> 21) & 0x1ff )) $(( (va >> 12) & 0x1ff ))
printf '%#x %#x %#x\n' $(( (va >> 36) & 0x7ff )) $(( (va >> 25) & 0x7ff )) $(( (va >> 14) & 0x7ff ))
```

```
0x1 0 0x81
0 0x20 0x20
```

(`printf '%#x'` prints zero as a bare `0`, without the `0x`.) You can check the 4 KiB line by eye:
`0x4000_0000` is exactly 1 GiB, which is 2³⁰, so it contributes 1 to the level-1 index and
nothing below; the rest, `0x8_1234`, is below 2²¹, so the level-2 index is 0, and
`0x8_1234 >> 12` is `0x81`. Here is the split as a picture.
Notice that the offset grows by two bits and every index field grows by two bits:

```
0x4008_1234 with a 4 KiB granule (level 0, bits [47:39], is 0 here)
  | L1 [38:30] = 0x1 | L2 [29:21] = 0x0 | L3 [20:12] = 0x81 | offset [11:0] = 0x234 |

0x4008_1234 with a 16 KiB granule (level 0, bit [47], is 0 here)
  | L1 [46:36] = 0x0 | L2 [35:25] = 0x20 | L3 [24:14] = 0x20 | offset [13:0] = 0x1234 |
```
*The granule decides where the cuts fall; the address itself never changes.*

## The CPU offers granules, software picks one

This section uses four pieces of Arm vocabulary; the
[`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/) primer covers them at length.

- **Exception levels** are the CPU's privilege levels, numbered EL0 to EL3, higher meaning more
  power: EL0 runs apps, **EL1** runs an OS kernel (for us, the guest kernel), **EL2** runs a
  hypervisor (for us, the macOS kernel), and EL3 runs firmware we never see.
- A **system register** is a named CPU configuration register, read and written with special
  instructions (`MRS`, `MSR`) rather than through memory. The suffix `_ELn` says the lowest level
  allowed to touch it: `TCR_EL1` is kernel business, `VTCR_EL2` hypervisor business.
- An **ID register** is a read-only system register that describes what the CPU can do.
- The **MMU** (memory management unit) is the hardware that walks translation tables on every
  memory access.

Which granules exist on a given chip is a hardware fact, published in an ID register. In
`ID_AA64MMFR0_EL1` ("AArch64 Memory Model Feature Register 0"), three 4-bit fields answer the
question: `TGran4` (bits [31:28]), `TGran64` (bits [27:24]) and `TGran16` (bits [23:20]).

Where does a real value come from? A guest reads this register with an `MRS` instruction; HVF
decides what it sees. We asked HVF directly with
`hv_vcpu_config_get_feature_reg(config, HV_FEATURE_REG_ID_AA64MMFR0_EL1, &value)` (declared in
`hv_vcpu_config.h`; chapter 02 shows how to call HVF from Rust). On our M5 Pro it reported
`0x000010000f100022`. Each hex digit is four bits, so count digits from the right, starting at
digit 0 for bits [3:0]: digit 5 (bits [23:20]) is
`1`, digit 6 (bits [27:24]) is `f`, digit 7 (bits [31:28]) is `0`. So `TGran4` is `0x0`, `TGran64`
is `0xf` and `TGran16` is `0x1`. Decoded with the register's field table (the callout below), that
reads: 4 KiB supported, 64 KiB **not** supported, 16 KiB supported. Apple's CPUs offer 4 KiB and
16 KiB, which is why this primer's title leaves 64 KiB out.

Software then picks, per table. A guest kernel at EL1 chooses its granule in `TCR_EL1` (the
Translation Control Register). Arm splits a 64-bit virtual address space into two halves: low
addresses (top bits all 0), conventionally used by programs, are translated through the table
whose address is in `TTBR0_EL1`, and high addresses (top bits all 1), conventionally used by the
kernel itself, through `TTBR1_EL1`. Each half can have its own granule, so `TCR_EL1` has two
fields: `TG0` for the low half and `TG1` for the high half. The kernel learns which values are
legal from `ID_AA64MMFR0_EL1` before turning its MMU on.

> **Under the hood.** Skip this on a first read; come back when you need to decode a real
> register. The two granule fields of `TCR_EL1` use different encodings, a classic trap.
> `TG0` (bits [15:14]) says `0b00` = 4 KiB, `0b01` = 64 KiB, `0b10` = 16 KiB. `TG1` (bits [31:30])
> says `0b01` = 16 KiB, `0b10` = 4 KiB, `0b11` = 64 KiB. The ID fields are equally uneven: a
> `TGran4` or `TGran64` of `0x0` means "supported" and `0xf` "not supported", while `TGran16` of
> `0x0` means "not supported" and `0x1` "supported". Larger values such as `TGran4` = `0x1` or
> `TGran16` = `0x2` also mean supported, plus 52-bit addresses (the `FEAT_LPA2` extension). There
> is no pattern to memorise; always decode from the register page, never from the field next door.

## Two stages, two owners, two granules

So far there has been one translation. Under a hypervisor there are two. Why? A guest kernel
believes it owns the machine's physical memory and will happily point its page tables at any
"physical" address it likes. The host cannot allow that, or the guest could read and overwrite
macOS. So the hardware adds a second translation that the guest cannot see or change, and the
host uses it to decide which real RAM, if any, each guest "physical" address reaches. The whole
point of this primer is that each of the two translations has its own granule.

The guest's own tables translate its virtual addresses to what it believes are physical
addresses. Chapter 02 named those: an **IPA** (intermediate physical address). That first
translation is **stage 1**, and it belongs to the guest: the guest writes the tables, picks the
granule in `TCR_EL1`, and turns its MMU on or off. A second translation, **stage 2**, takes each
IPA to a real host physical address. It belongs to HVF: the macOS kernel, running at EL2, builds
those tables on HVF's behalf. Our **VMM** (virtual machine monitor, the ordinary macOS program
we are writing, macvmm) never writes them itself; it asks with calls such as `hv_vm_map(host
pointer, IPA, size, permissions)`, meaning "let the guest reach this memory of mine at this IPA".
The stage-2 granule lives in a different register, `VTCR_EL2` (field `TG0`, same encoding as
`TCR_EL1.TG0`), which neither the guest nor our VMM can write directly. HVF sets it, by default
to 16 KiB; since macOS 26 a VMM can ask HVF for 4 KiB when it creates the VM (see the Production
note at the end of the next section).

```
   guest (EL1)                               |  host
                                             |
   VA ──stage 1──▶ IPA ──────────────────────┼──stage 2──▶ host physical address
        guest's tables,                      |   HVF's tables (EL2),
        guest's granule (TCR_EL1.TGn):       |   HVF's granule (VTCR_EL2.TG0):
        4 KiB for Alpine                     |   16 KiB by default
                                     trust boundary
```
*Each stage has its own tables, its own owner and its own granule; nothing forces them to match.
The vertical line is the **trust boundary**: everything left of it is controlled by the guest,
and the host must not trust it.*

The architecture allows the stages to differ, because each is controlled by its own register. The
guest never sees the stage-2 granule: as far as it knows, the IPA *is* physical memory. HVF never
reads the guest's stage-1 tables. Our VMM sits in the middle and almost always deals in IPAs
(chapter 05 tells this story in full; chapter 21 shows the rare case where we walk the guest's
stage-1 tables ourselves).

You can confirm the guest side for the kernel we boot. Alpine publishes the build configuration
of its `linux-virt` kernel, and ours (`config-6.18.60-0-virt`) contains `CONFIG_ARM64_4K_PAGES=y`:
a 4 KiB stage-1 granule, chosen when the kernel was compiled.

:::predict The Alpine guest maps one 4 KiB page of its own at IPA `0x4000_7000`, and HVF's stage 2 works in 16 KiB pages. Does the guest's 4 KiB page fit inside one stage-2 page, or does it straddle two?
It fits, always: a 4 KiB-aligned 4 KiB page can never cross a 16 KiB boundary, because every 16 KiB boundary is also a 4 KiB boundary.
:::

The guest's page covers `0x4000_7000` to `0x4000_7fff`. Clear the low 14 bits of
any address in that range and you get `0x4000_4000`, so all 4096 bytes lie in the one 16 KiB
stage-2 page at `0x4000_4000`. This is general: a 4 KiB-aligned range of 4 KiB can never cross a
16 KiB boundary, because every 16 KiB boundary is also a 4 KiB boundary. Each stage-2 page holds
exactly four guest pages, side by side:

```
 stage-2 page (HVF, 16 KiB) at IPA 0x4000_4000
 +-------------+-------------+-------------+-------------+
 | 0x4000_4000 | 0x4000_5000 | 0x4000_6000 | 0x4000_7000 |   four 4 KiB stage-1 targets
 +-------------+-------------+-------------+-------------+
```
*Four guest pages per host page; the guest may map them to any four virtual addresses it likes.*

That resolves the opening puzzle. The Mac and the kernel are talking about different tables. The
kernel's 4 KiB pages are a stage-1 matter between it and its own MMU, and HVF's 16 KiB pages are a
stage-2 matter between HVF and the real memory. A translation goes through both, and each one does
its own arithmetic.

## What a coarse stage 2 costs us

The reverse direction is where the rules bite. HVF can only map, unmap or change permissions in
whole stage-2 pages, so everything we ask of stage 2 comes in 16 KiB pieces.

1. **Mapped regions are 16 KiB-aligned.** Guest RAM and flash must start at a 16 KiB-aligned IPA,
   come from a 16 KiB-aligned host address, and be a multiple of 16 KiB long. Device windows are
   different: we leave them unmapped on purpose so that every access traps (chapter 05), so a
   UART at `0x0900_0000` and virtio slots every `0x200` bytes need no stage-2 alignment at all.
   An IPA range that we leave unmapped on purpose like this is called a **stage-2 hole**.
2. **Permissions are per 16 KiB.** We cannot make one guest 4 KiB page read-only at stage 2 while
   its three neighbours stay writable. Effective access is allowed only if both stages allow it,
   so the guest can still protect its own 4 KiB pages at stage 1; we cannot protect them from the
   outside at a finer grain.
3. **Change tracking is per 16 KiB.** A VMM sometimes needs to know which guest memory changed:
   to save a snapshot incrementally, or to copy a running VM to another machine (live
   migration), it re-copies only the changed pages. The usual trick, **dirty tracking**, is to
   remove write permission at stage 2; the guest's first write to each page then traps to the
   VMM (a **write fault**), which notes the page as dirty and restores write access. The
   bookkeeping can only be as fine as stage 2. Suppose the guest changes one byte in each of four
   of its 4 KiB pages, and those pages happen to lie in four different 16 KiB stage-2 pages. The
   guest touched 4 × 4 KiB = 16 KiB of its own pages, but we see four dirty stage-2 pages and
   must copy 4 × 16 KiB = 64 KiB: up to four times the work (chapter 26 measures it).

> **Security.** The guest controls every IPA it gives us, and nothing obliges it to respect our
> page size. A buffer that starts 8 bytes before a 16 KiB boundary crosses into the next stage-2
> page, which may belong to another region or to no region at all. Never assume a guest range lies
> within one page. Check every range against the VMM's list of mapped regions (each one a start
> IPA, a length and the host memory behind it), as chapter 04's `GuestMemory` type does, with
> overflow-checked arithmetic.

> **Production note.** Since macOS 26, a VMM can opt a VM into a 4 KiB stage-2 granule with
> `hv_vm_config_set_ipa_granule(config, HV_IPA_GRANULE_4KB)` (declared in `hv_vm_config.h`). We
> tried it on this machine: 4 KiB mappings at 4 KiB-aligned IPAs then succeed. macvmm keeps the
> default 16 KiB granule, because none of our guests needs a stage-2 hole or permission finer than
> 16 KiB, and a quarter as many stage-2 pages means a quarter as many entries for HVF to manage.

## Self-check

Commit to an answer before you reveal it.

:::predict The guest touches the byte at IPA `0x4000_5234`. Give its 4 KiB page base and offset, and its 16 KiB page base and offset.
4 KiB: page `0x4000_5000`, offset `0x234` (clear, then keep, the low 12 bits). 16 KiB: page
`0x4000_4000`, offset `0x1234` (the low 14 bits). Check it with `$(( 0x40005234 & ~0x3fff ))` and
friends.
:::

:::predict True or false: because macOS uses 16 KiB pages, a Linux guest on macvmm must be built with 16 KiB pages.
False. The kernel's page size is its stage-1 granule, chosen in its own `TCR_EL1`. HVF's 16 KiB is
the stage-2 granule. The stages are independent, and every 4 KiB-aligned guest page sits inside
exactly one 16 KiB stage-2 page. Alpine's kernel uses 4 KiB pages and boots in chapter 14.
:::

:::predict A guest writes `0b10` into `TCR_EL1.TG0`. Which granule did it choose? Which would the same value mean in `TG1`? (The encodings are in the Under the hood callout.)
In `TG0`, `0b10` means 16 KiB. In `TG1`, `0b10` means 4 KiB. The two fields use different
encodings, so always decode from the register page.
:::

:::predict A CPU reports `ID_AA64MMFR0_EL1 = 0x000010000f100022`. Which granules does it support?
Bits [31:28] (`TGran4`) are `0x0`: 4 KiB supported. Bits [27:24] (`TGran64`) are `0xf`: 64 KiB
not supported. Bits [23:20] (`TGran16`) are `0x1`: 16 KiB supported. This is the value HVF reports
to a guest on an M5 Pro.
:::

:::predict We want to make the guest's 4 KiB page at IPA `0x4000_6000` read-only at stage 2, and leave the rest of RAM writable. With HVF's default granule, what actually becomes read-only?
The whole 16 KiB stage-2 page `0x4000_4000` to `0x4000_7fff`, so three innocent neighbouring
guest pages become read-only as well. Stage-2 permissions come in whole stage-2 pages.
:::

:::predict Why can the PL011 UART sit at `0x0900_0000` and the virtio slots `0x200` bytes apart, when RAM must be 16 KiB-aligned?
Because devices are not mapped at stage 2 at all. They live in deliberate holes, so every access
exits to our VMM. The 16 KiB rule applies only to what we map, such as RAM and flash.
:::

## Lab

:::lab two-stage-walker

In the `two-stage-walker` lab you set the **stage-1 granule and the stage-2 granule separately**.
Type a guest virtual address, predict each level's index, then let the lab walk the guest's
tables to an IPA and HVF's tables to a host address. Flip the stage-1 granule between 4 KiB and
16 KiB and watch the index fields move while the stage-2 walk stays the same; then make a stage-2
entry invalid and see that one fault covers four guest pages. Chapter 05 uses the same lab with a
real memory map.

## Where this shows up in macvmm

- [Chapter 02, first-exit](/build-your-own/vmm/bare-machine/first-exit/): the first mapping is one
  16 KiB page at IPA `0x4000_0000`, the smallest piece the default stage 2 accepts.
- [Chapter 04, guest-memory](/build-your-own/vmm/memory/guest-memory/) (requires this primer):
  guest RAM is allocated and mapped in 16 KiB-aligned pieces, and the region constructor in the
  memory module (`crates/vmm/src/memory/`) rejects regions that are not 16 KiB-aligned. Its Predict
  asks what `hv_vm_map` does with a 4 KiB piece.
- [Chapter 05, address-space](/build-your-own/vmm/memory/address-space/): the two-stage picture in
  full, device windows as stage-2 holes, and the layout invariant "mapped regions 16 KiB-aligned"
  in `crates/vmm/src/arch/layout.rs`.
- [Chapter 21, firmware](/build-your-own/vmm/firmware/firmware/): our VMM walks the guest's
  stage-1 tables itself, so it must handle both 4 KiB and 16 KiB guest granules, independent of
  HVF's stage 2.
- [Chapter 26, snapshots](/build-your-own/vmm/production/snapshots/): dirty tracking at 16 KiB and
  the up-to-four-times cost for a 4 KiB guest.

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487), chapter D8,
  "The AArch64 Virtual Memory System Architecture" (numbering of issue K.a): translation granules,
  the table walk per granule, and stage 2. The register pages for `TCR_EL1`, `VTCR_EL2` and
  `ID_AA64MMFR0_EL1` carry the field encodings used above; look them up by name, since chapter
  numbers move between issues.
- Arm, *Learn the architecture: AArch64 memory management* (document 101811), the gentlest
  official introduction to granules, levels and blocks.
- Linux, `Documentation/arch/arm64/memory.rst` (the kernel's virtual layout for each page size)
  and `Documentation/arch/arm64/booting.rst` (the Image header's flags field, whose bits 1 to 2
  record the kernel's page size).
- Apple, `Hypervisor.framework/Headers/hv_vm_config.h` in the macOS SDK (`hv_ipa_granule_t` and
  `hv_vm_config_set_ipa_granule`), and `man 1 pagesize` and `man 3 getpagesize`.

## Checkpoint

:::checkpoint

- **What you can do now.** Run `pagesize` and see `16384`. Split any address into page base,
  offset and table indexes for 4, 16 or 64 KiB, and say which stage a granule belongs to and who
  chose it.
- **What's next.** Chapter 04 allocates the guest's RAM for real. You now know why every size and
  address in it is a multiple of `0x4000`, and you can predict what HVF says when we offer it less.
- **One open question.** Apple's CPUs do not offer the 64 KiB granule. Suppose someone hands you a
  Linux kernel built only for 64 KiB pages: is there anything a VMM could do to make it boot, or
  is this a wall no hypervisor can climb? A hint for your thinking: stage 1 is walked by the real
  MMU, so with HVF the guest's `TCR_EL1` must name a granule the hardware has. The way out is to
  stop using the real MMU for the guest at all, which is what full CPU emulators such as QEMU's
  TCG do, at a large speed cost.
