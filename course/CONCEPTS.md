# Concepts the course relies on

This is the concept register that `CLAUDE.md` ("Borrowed concepts get taught too") requires. It
lists every concept a lesson uses, with its tier, the chapter that first uses it, and the place
that teaches it. Lesson authors build each lesson's **Concepts you'll need** box from this file.
Reviewers use the GAP column to block a lesson that uses a concept before it is taught or linked.

Status: v1 audit (2026-11-18), against `course/CURRICULUM.md` v2 (section 5 chapter entries and
sections 2.1 and 2.2), `docs/architecture.md` v1.2 and `docs/DECISIONS.md`. No primer exists yet:
every row whose "Taught in" is `primers/<slug>.md` is a primer still to write. Primers marked
**(new)** were proposed in section 3 below.

**v3 closure (2026-11-18), against `course/CURRICULUM.md` v3.** Every GAP flag in section 1 is
closed: the GAP column now says `Closed v3:` and where, and "Taught in" names the new home. The
eleven new primers of section 3.2, plus `aarch64-reading` (v2's Appendix B, now required by 02
because `CLAUDE.md` assumes no Arm knowledge), are in CURRICULUM section 2.1, and every chapter's
**Concepts you'll need** box in CURRICULUM section 5 lists its core, primer, pointer and
forward-definition items. Part 0 was rebuilt: `trap-or-not` moved from ch00 to ch01, so its
first-use entries read 01; ch00 now uses only the toy machine (`toy-vmm`) and `os-basics`.
Sections 2 and 3 below are kept as the audit record. Lesson authors build boxes from CURRICULUM
section 5; when a lesson adds a concept, add its row here in the same change.

**v3.1 (2026-11-18), against `course/CURRICULUM.md` v3.1 and `course/reviews/novice.md`.** The
register was right for authors and unreadable for a learner (novice review 3.1). Section 4 was new:
the **learner glossary**, one plain line per term used in Parts 0 to III plus a link to where it is
taught. It has since moved to `course/GLOSSARY.md` (the site's glossary source, covering every
chapter), and section 4 now only points there. Rows changed in v3.1 say `v3.1:` in the GAP column: a new **core (idea)**
tier for concepts taught but not implemented (3.4), `caches` moved to ch13, `os-basics` trimmed
(threads, preemption and file descriptors to `host-concurrency`), the `AtomicBool` flag moved to
ch09, type 1 and type 2 demoted to a pointer, and new rows for the exception vector table,
firmware, bit fields and the "VM exit" versus "exit code" distinction.

**Phase 3 sync (2026-11-20), against the written lessons of chapters 00 to 25.** Rows whose GAP
column says `Phase 3:` were added or changed because a written lesson relies on a concept the
register did not list: forward definitions in ch03 (`MPIDR_EL1`, `CPACR_EL1`, `wfe`,
`CNTVCT_EL0`, the device tree, an address size fault) and ch06 (the redistributor, the virtual
counter offset, the DTB address in `x0`), and pointers in ch06 (PAN and TCO), ch14 (`panic=`,
BusyBox), ch20 (Linux's CPU numbering, the 16-CPU SGI limit, signal kicks in KVM-based VMMs) and
ch23 (PCI Express, XPC services). The learner glossary that section 4 used to hold now lives in
`course/GLOSSARY.md`.

## 0. How to read this file

**Tiers** (from `CLAUDE.md`):

- **core**: the learner implements it. It gets a full chapter, derived from the problem it solves.
- **core (idea)** (v3.1): taught in full and assessed by explanation or a lab, but there is no
  code to write (for example trap-and-emulate as a strategy, hardware-assisted virtualization).
  The learner should not expect to implement it.
- **primer**: used, not implemented. A standalone 15 to 30 minute tutorial in
  `course/primers/<slug>.md` (objectives, self-check, a lab if useful), read before the first
  chapter that needs it.
- **pointer**: an Aside in the lesson plus one authoritative link. The lesson must still say, in
  a sentence or two, what the thing is and why it matters here.
- **prereq**: assumed by `CLAUDE.md`'s audience contract and checked by the entry self-check
  (`/build-your-own/vmm/setup/`). Appendix A and B are remedial for these.

**Columns.** *First used* is the earliest chapter (two-digit ID from CURRICULUM section 5) whose
text, lab, checkpoint, journal or Predict fork relies on the concept. *Taught in* is a chapter ID,
`primers/<slug>.md`, `App. A`/`App. B`, or a link. *GAP* is empty when the concept is taught at or
before first use. Otherwise it says what is wrong:

- **GAP-ORDER**: taught, but after first use. Needs a forward definition at first use (one or two
  sentences plus "full story in NN") or the use must move.
- **GAP-NONE**: not taught or linked anywhere in the plan. Needs a primer, a pointer, or a
  core section in a chapter.
- **GAP-SCOPE**: a planned primer or chapter is the right home, but its scope in CURRICULUM 2.1
  does not mention this concept yet.
- **GAP-BOX**: taught in the right place, but the chapter's "Concepts you'll need" entry in
  CURRICULUM section 5 does not list it.

## 1. Concept table

### 1.1 Virtualization theory

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Virtual machine, VMM, hypervisor (the words; the course's narrow "hypervisor" and the world's wider one) | core (idea) | 00 | 00 | v3.1: ch00 says plainly that most writing uses the words as synonyms, with an example of each use. |
| The problem ledger: what a kernel assumes it owns | core (idea) | 00 | 00 (scaffolded prompts; shown as boxes for the learner's guesses) | |
| Emulation (interpretation) vs virtualization vs paravirtualization | core (idea) | 00 | 00 | |
| Trap-and-emulate (deprivilege, trap, emulate, resume) | core | 00 | 00 (derived), applied 02, 07 | |
| Sensitive vs privileged instructions; Popek and Goldberg's condition | core (idea) | 00 | 00 (concrete failure sentence first; three properties and x86 `POPF` in an Aside) | |
| Hardware-assisted virtualization (a more privileged level that traps for you) | core (idea) | 00 | 00 (idea, `toy-vmm` mode H), 02 (EL2 mechanism) | |
| "Two supervisors": HVF at EL2 decides what leaves the guest, our VMM decides what to do | core | 00 | 00, 08 | |
| Type 1 vs type 2 hypervisors | pointer | 01 | 01 Aside (Goldberg's definitions, why they blur); the useful question "who owns the privileged level" is core in 01 and exact in 02 ("who sits at EL2") | v3.1: demoted from core (novice review 2.1.2, 3.4). |
| VM exit (the word, and that it is an exception taken to EL2 and forwarded); never "exit" where a process exit code could be meant | core | 00 | 02 | v3.1: CURRICULUM section 2 rule (novice review 2.2.4). |
| Exit cost (about 1 µs or more, measured) | core | 03 | 03 | |
| Shadow page tables (the rejected alternative to stage 2) | pointer | 05 | 05 (one paragraph) + link | |
| Virtual devices; device emulation vs paravirtual devices | core | 00 | 00 (idea, with "ch09 builds an emulated one, ch15 the fast paravirtual kind"), 09, 15 | v3.1: the thread to hold is stated in ch00 (novice review 3.5). |
| Why virtio exists (one driver for every hypervisor; fewer exits) | core | 15 | 15 | |
| Nested virtualization / a guest with its own EL2 (`hv_vm_config_set_el2_enabled`, `VBAR_EL2`) | pointer | 02 (journal Q5) | 02 Aside + ARM ARM EL2 chapter, `hv_vm_config.h` | Closed v3: ch02 box, Pointers. |
| QEMU TCG (an emulator), x86 VT-x and the VMCS, KVM | pointer | 00 | 00 Asides + links | |
| Popular desktop VM apps as users know them (UTM, Parallels, VMware Fusion) and what layer they sit on | pointer | 00 | 00 (opening puzzle), 01 Aside (layers; `[U]` until vendor docs checked) | Closed v3: ch00 and ch01 boxes. |
| Live migration, dirty-page tracking | pointer | 05 (pointer), 26 | 05, 26 Asides | |
| Snapshot as complete state (hidden state in GIC, timer, in-flight I/O) | core | 26 | 26 | |

### 1.2 ARM64 (AArch64) architecture

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Privilege levels in general (user vs kernel); the same names in `toy-vmm` | primer | 00 | `primers/os-basics.md` | |
| Exception levels EL0 to EL3 | core | 00 (one sentence), 01 (stack figure legend) | 02 | v3.1: ch00 item 8 and the ch01 figure caption carry a one-line forward definition (novice review 2.0.5, 2.1.3). |
| Exception model: synchronous vs asynchronous, routing, `ELR`, `SPSR`, `ESR`, `FAR`, `VBAR` and vector offsets | core | 02 | 02 (applied 06, 07, 08) | |
| Exception vector table (a table of handler addresses at `VBAR_ELn`; 4 groups × 4 kinds) | primer then core | 02 | `primers/os-basics.md` (the idea), 02 (`VBAR_EL1`, one entry), 08 (all 16 entries drawn) | v3.1: new row (novice review 2.2.3, 2.8.3). |
| Preferred return address (PC after HVC vs SMC vs abort; "a call continues, a fault retries") | core | 02 | 02, linked back in 07 | v3.1: the reason is stated, not only cited (novice review 2.2.5, 2.7.6). |
| ESR layout: EC, IL, ISS | core | 02 | 02 (EC), 07 (data-abort ISS), 08 (sysreg ISS) | |
| PSTATE / CPSR / SPSR bits: `M[3:0]`, SPSel, DAIF (`0x3c5` = EL1h, DAIF masked) | core | 02 | 02 (`0x3c5` read from a field table that glosses SP_EL1, EL1h, DAIF), 06 (built) | v3.1: ch02 reads, ch06 builds (novice review 2.2.1). |
| General-purpose registers, `xN`/`wN`, `xzr` vs `sp` (register 31), `pc`, `lr` | primer | 02 | `primers/aarch64-reading.md` (was App. B) | |
| Procedure call standard (AAPCS64: `x0..x7` arguments, `x0` result) | primer | 02 (`x0`), 03 | `primers/aarch64-reading.md`; `primers/smccc.md` builds on it | Closed v3: primer scope (CURRICULUM 2.1). |
| System registers (`MRS`/`MSR`, `_ELn` suffix naming) | primer then core | 02 | `primers/aarch64-reading.md` (reading), 08 (encoding) | |
| `SCTLR_EL1` (M, C, I, A bits) | core | 06 | 06 | |
| `MPIDR_EL1` and affinity fields | core | 03 (`_start` picks a stack by it) | 03 (forward definition), 06 (value, why an OS needs it, bit 31 RES1), 20 (Aff0/Aff1, `/cpus`, redistributors) | v3.1: motivated in ch06 (novice review 2.6.2). Phase 3: ch03's `_start` reads it first, so a forward definition there. |
| `CPACR_EL1` and the floating-point enable (`FPEN`) | pointer | 03 (`_start`) | 03 (forward definition: the compiler uses FP registers, which trap until `FPEN` is set) | Phase 3: new row; the reference `_start` sets it. |
| PSTATE flags PAN (privileged access never) and TCO (tag check override) | pointer | 06 (the extra bits in a dumped `cpsr`) | 06 Aside; 08 (PAN set on exception entry in the injection worked example) | Phase 3: new row. |
| Linux's CPU numbering (`cpu_logical_map`, the `Booting Linux on physical CPU` line) | pointer | 20 | 20 Aside + `arch/arm64/kernel/smp.c` | Phase 3: new row. |
| GICv3 SGI targeting limit: 16 CPUs per cluster (`ICC_SGI1R_EL1.TargetList`) | pointer | 20 (MPIDR layout for vCPU 16 and up) | 20 (a linked sentence, IHI 0069) | Phase 3: new row. |
| ID registers and feature discovery (`ID_AA64*`, `PMUVer`) | pointer | 08 | 08 Aside + register pages in DDI 0487 | Closed v3: ch08 box, Pointers. |
| Trap-control registers owned by HVF (`HCR_EL2`, `MDCR_EL2`) | pointer | 08 | 08 (stated as a principle first: "what reaches us is measured"), Aside | |
| Debug OS lock (`OSLAR_EL1`, `OSLSR_EL1`) | pointer | 08 | 08 (emulated; needs one sentence on what it is) | |
| RAZ/WI, UNDEFINED, UNKNOWN, IMPLEMENTATION DEFINED (ARM ARM vocabulary) | primer | 08 | `primers/reading-arm-specs.md` (required by 07) | Closed v3: new primer. |
| A64 instruction encoding (fixed 32-bit words, fields) | primer | 02 | `primers/aarch64-reading.md` + `a64-encoder` lab | |
| A64 loads and stores: `ldr`/`str` sizes, `ldrsh` sign-extension, `ldp`/`stp`, writeback forms | primer then core | 07 | `primers/aarch64-reading.md` (reading), 07, 21 | |
| Exclusives, LSE atomics, SIMD loads, `DC ZVA` (what ISV=0 refuses) | pointer | 07 (`ldp` gives ISV=0) | 21 Aside + ARM ARM C6 | |
| MMIO decode from the syndrome (ISV, SAS, SSE, SRT, SF, WnR) | core | 07 | 07 (as a story, then the table; why `ldp` gives ISV=0 in the body); ISV=0 in 21 | v3.1 (novice review 2.7.1, 2.7.3). |
| Data abort vs instruction abort; DFSC (translation vs address-size fault); `HPFAR_EL2` | core | 03 (address size fault, in the stack break) | 03 (address size fault, forward definition: an address too wide to be physical, taken at the guest's own level), 05 (why the fault reports an IPA, in prose; acronyms expanded; `two-stage-walker` shows ESR/FAR/HPFAR), 07 | v3.1 (novice review 2.5.3). Phase 3: ch03 forward definition added. |
| Alignment faults (`SCTLR_EL1.A`); reading a first fault behind a second one | core | 06 | 06 (the six-link self-fault trace) | v3.1 (novice review 2.6.3). |
| Exception injection (doing by hand what the hardware does) | core | 08 | 08; data abort injection 21 | |
| Synchronous external abort | core | 21 | 21 | |
| Virtual memory (VA to PA, a page table as a lookup, page fault) | primer | 01 (`trap-or-not` has "a page fault inside the guest's own tables") | `primers/os-basics.md` (with a worked two-level example), `primers/page-tables.md` (05) | v3.1: "one picture" was too thin for ch05 (novice review 3.2). |
| Stage-1 translation: VA split, `TTBR0/1`, `TCR` (T0SZ, TG0), levels, descriptors, MMU on and off | primer | 05 | `primers/page-tables.md` | |
| Memory attributes: Normal vs Device memory, `MAIR_EL1`, cacheability | pointer | 04 (MMU-off coherence), 05 (why a device is not RAM) | `primers/page-tables.md` (one section), `primers/caches.md` | Closed v3: primer scopes. |
| Translation granules (4 KiB, 16 KiB, 64 KiB); stage 1 and stage 2 granules are independent | primer | 02 (maps "one 16 KiB host page") | `primers/page-granules.md` (required by 04, linked from 02; defines "granule" as the page size a translation table uses); 04 says why 16 KiB in prose | v3.1 (novice review 2.4.3). |
| Intermediate physical address (IPA) / guest physical address | core | 00 (doctor prints "max IPA"), 02 (`hv_vm_map` at IPA `0x4000_0000`) | 02 (forward definition), 05 | Closed v3: ch02 box, Forward definitions (and ch01 for the doctor line). |
| Stage-2 translation; holes as traps | core | 02 (`hv_vm_map` is a stage-2 mapping) | 02 (forward definition), 05 | Closed v3: ch02 box, Forward definitions. |
| IPA size and `hv_vm_config_set_ipa_size`; the 36-bit default and floor | core | 00 (doctor), 01 (journal Q4) | 05 (every checkpoint constant explained, including `ipa_bits_needed(0x6000_0000) == 36`) | Parked in 00 and 01 by design; v3.1: ch01 Q4 carries a thread to hold (novice review 2.5.4, 2.5.6). |
| Caches, cache lines, PoC/PoU, clean and invalidate, I-cache vs D-cache coherence (`CTR_EL0.DIC/IDC`) | primer | 13 ("cleaned to PoC"); 04 only in an optional, vocabulary-free callout | `primers/caches.md` (required by 13; linked from 04); ch06 has one paragraph on `SCTLR_EL1.M` and `C` | v3.1: moved from 06, whose text used none of it (novice review 2.6.4). |
| Weak memory ordering, barriers (`DMB`, `DSB`, `ISB`), acquire/release, store-load fences | primer | 04 (seed) | `primers/memory-ordering.md` (required by 16) | |
| Generic timer: `CNTVCT_EL0`, `CNTV_CVAL_EL0`, `CNTV_CTL_EL0`, `CNTFRQ`, counter offset | core | 01 (`mrs CNTVCT_EL0` in `trap-or-not`) | 01 (`trap-or-not` feedback, one line), 03 (`CNTVCT_EL0`, forward, `exit-bench`), 06 (the virtual counter offset, forward), 11 | Closed v3: the lab moved to ch01; its feedback defines it (ch01 box, Forward definitions). Phase 3: ch03 and ch06 forward definitions. |
| `WFI`/`WFE` (wait for interrupt or event) | core | 01 (`trap-or-not`) | 01 (`trap-or-not` feedback, one line), 03 (`wfe` parks extra CPUs in `_start`, forward), 11 | Closed v3: as above. Phase 3: ch03 forward definition. |
| Interrupts as state: pending, mask, vector; level vs edge | core | 09 (PL011 `RIS`/`MIS`/`IMSC`) | 09 (forward definition), 11 | Closed v3: ch09 box, Forward definitions. |
| GICv3: distributor, redistributor, CPU interface (`ICC_*`), INTIDs, SGI/PPI/SPI, IAR and EOI, affinity routing | core | 05 (`layout.rs` invariant "INTIDs unique within 32..=1019"; `virtio_slot(0) == (…, 48)`) | 05 (INTID forward definition), 06 (the redistributor, forward), 12 | Closed v3: ch05 box, Forward definitions. Phase 3: ch06 forward definition. |
| LPIs, the ITS and the MSI range | pointer | 12 (`GicSpi` refuses the MSI range) | 12 Aside + IHI 0069 LPI chapter | Closed v3: ch12 box, Pointers. |
| SMC Calling Convention (function IDs, owners, fast vs yielding, conduits) | primer | 03 | `primers/smccc.md` | |
| PSCI (`VERSION`, `FEATURES`, `SYSTEM_OFF`, `SYSTEM_RESET`, `CPU_ON`, `CPU_OFF`, `AFFINITY_INFO`) | core | 08 | 08, 20 | |
| Self-hosted debug: `BRK`, single step (`MDSCR_EL1.SS`, `SPSR.SS`), debug exceptions | core | 07 (`Brk` in the `Exit` enum), 27 | 27 | Closed v3: ch27 box lists it as core, taught here. |
| SME / streaming SVE state (saved or refused in snapshots) | pointer | 26 | 26 Aside + `hv_sme_config.h` | |
| Pointer authentication, MTE and other features the guest may probe | pointer | 22 (FreeBSD probing) | none | Optional: an Aside in 22 if a capture shows one matters. |

### 1.3 Devices and machine description

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Memory-mapped I/O (a register is an address with side effects) | core | 00 (`str` to the UART) | 05 (with a two-sentence UART intro at first mention), 07, 09 | v3.1 (novice review 2.5.5). |
| Port I/O vs MMIO (why arm64 only has MMIO) | pointer | 05 | 05 Aside (one sentence) | Closed v3: ch05 box, Pointers. |
| Device as a state machine; side-effecting reads | core | 09 | 09 | |
| UART basics: FIFO, transmit/receive, baud divisors, flow-control flags | pointer | 09 | 09 Aside + DDI 0183 | Closed v3: ch09 box, Pointers. |
| PL011 UART, PL031 RTC (TRMs) | core | 09 | 09 | |
| AMBA PrimeCell and Peripheral ID registers at `0xFE0` | primer | 09 | `primers/primecell-ids.md` | |
| Device Tree / FDT blob: header, structure block, strings, cells, `compatible`, `reg`, `#address-cells`, `/chosen`, phandles, `interrupt-parent`, 3-cell `interrupts` | core | 03 (the link address leaves room for it), 06 (the DTB address in `x0`), 10 | 03 and 06 (forward definitions), 10 (GIC parts in 12) | Phase 3: ch03 and ch06 forward definitions. |
| Driver binding by `compatible` (how a kernel picks a driver for a node) | primer | 10 (journal Q2 "who reads the DTB first") | 10 (one paragraph), `primers/linux-boot-sequence.md` | Closed v3: ch10 box and new primer. |
| Fixed clocks (`apb_pclk`) and the clock binding | pointer | 10 | 10 Aside + DT binding link | |
| Big-endian vs little-endian byte order | prereq | 04 (little-endian helpers) | entry self-check; `primers/aarch64-reading.md` (byte order) | Closed v3: self-check question and primer section. |
| `dtc` (device tree compiler) as a checking tool | pointer | 10 | 10 | |
| PCI enumeration and ACPI (why x86 can probe and Arm platform devices cannot) | pointer | 10 | 10 | |
| PCI Express (PCIe) and its configuration space (ECAM), as the bus VZ puts its virtio devices on | pointer | 23 | 23 (one section + Linux PCI documentation) | Phase 3: new row. |
| QEMU `virt` machine as the reference platform | pointer | 02 (RAM at `0x4000_0000`) | 02 (one sentence), 05 (constants explained), 21 | v3.1 (novice review 2.2.7, 2.5.4). |
| CFI flash (JEDEC JESD68) and why flash is not RAM | pointer | 21 | 21 | |
| DMA / bus mastering (a device reads and writes RAM itself) | core | 04 (one-sentence forward definition) | 15 (derivation) | v3.1: forward note in ch04 (novice review 3.6). |
| Emulated NVMe and AHCI (rings in real hardware) | pointer | 15 | 15 | |

### 1.4 Virtio

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| virtio-mmio v2 transport registers, status state machine, feature negotiation, `ConfigGeneration` | core | 05 (`virtio_slot` in `layout.rs`) | 05 (virtio-slot forward definition), 15 | Closed v3: ch05 box, Forward definitions. |
| Split virtqueues: descriptor table, available ring, used ring, free-running `u16` indices, indirect descriptors | core | 15 (toy ring) | 16 | |
| Doorbell (`QueueNotify`) and used-buffer interrupt | core | 15 | 15 | |
| TOCTOU and copy-then-validate | core | 04 (parked) | 04, 16 | |
| `VIRTIO_F_EVENT_IDX`, packed rings, vhost-user | pointer | 16 | 16, 27 | |
| virtio-rng, virtio-console, virtio-blk, virtio-net device semantics | core | 17 | 17, 18, 19 | |
| Device worker threads and the doorbell's happens-before chain | core | 17 | 17 | |

### 1.5 File formats and boot

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| What a kernel does at boot (in one picture) | primer | 00 | `primers/os-basics.md` | |
| What firmware is (the program the CPU runs first; loads the kernel; answers power requests) | primer | 00 (ledger row 4), 08 (PSCI "asks the platform") | `primers/os-basics.md` (two sentences); `primers/uefi.md` and `u-boot` (21) | v3.1: new row (novice review 2.8.5). |
| Bare-metal program: entry point, stack, BSS zeroing, `no_std`, `no_main`, panic handler | core | 03 | 03 | Closed v3: ch03 box lists it as core, taught here. |
| Linker scripts, sections (`.text`, `.rodata`, `.data`, `.bss`), load vs run address, flat binary via `objcopy` | primer | 03 | `primers/bare-metal-rust.md` (required by 03) | Closed v3: new primer. |
| Target triples and cross-compiling (`aarch64-unknown-none`, `rustup target add`) | pointer | 03 | `primers/bare-metal-rust.md` | Closed v3: primer scope. |
| ELF64: headers, program headers, `filesz` vs `memsz` | primer | 03 (the linker emits an ELF that `objcopy` flattens) | `primers/elf.md` (required by 13); 03 forward definition | Closed v3: ch03 box, Forward definitions. |
| arm64 Linux boot protocol (`Documentation/arch/arm64/booting.rst`): Image header, `text_offset`, placement, entry registers, MMU and cache state | primer | 06 (MMU and caches off) | `primers/arm64-boot-protocol.md` (required by 06) | Closed v3: CURRICULUM 2.1 says 06. |
| Kernel command line (`bootargs`, `console=`, `root=`, `panic=-1`) | pointer | 10 | 10 Aside + `kernel-parameters.rst`; 14 Aside (`panic=N`, why the checkpoint boots with `panic=-1`) | Closed v3: ch10 box, Pointers. Phase 3: ch14 `panic=` Aside. |
| initramfs and initrd; cpio newc | primer | 13 | `primers/cpio-initramfs.md` | |
| EFI zboot wrapper (`vmlinuz-virt`), PE/COFF header, gzip payload | primer | 13 | `primers/efi-zboot.md` | Closed v3: primer scope gains a UEFI and PE/COFF page. |
| gzip (RFC 1952) and xz as compression containers | pointer | 13 (gzip inside zboot), 22 (xz) | `primers/efi-zboot.md` (gzip); 22 Aside (xz) | |
| UEFI: boot services, runtime services, configuration tables (how the DTB reaches the OS), EFI applications | primer | 13 (zboot is an EFI application) | `primers/efi-zboot.md` (minimal, 13), `primers/uefi.md` (required by 21) | Closed v3: new primer. |
| U-Boot: role, prompt, environment, `bootefi`, `virtio scan` | primer | 21 | `primers/u-boot.md` | |
| QEMU-`virt` firmware boot protocol (firmware at `0x0`, DTB at RAM base, `PC = 0`) | core | 21 | 21 | |
| EDK2 / ArmVirtQemu | pointer | 21 | 21, 22 | |
| What Linux does from entry to `/init`: early console, DT unflattening, driver probing, clocksource, initcalls, initramfs unpacking, `/init`, BusyBox shell, `dmesg` | primer | 14 | `primers/linux-boot-sequence.md` (required by 14) | Closed v3: new primer. |
| BusyBox (one program providing `sh` and the test shell's commands) | pointer | 14 | 14 (a linked sentence); `primers/linux-boot-sequence.md` | Phase 3: new row. |
| Kernel modules and Alpine's `modloop` (a squashfs of modules) | pointer | 18 (`modloop-virt` read-only) | 18 Aside; `primers/linux-boot-sequence.md` | Closed v3: ch18 box. |
| Raw disk images, sectors (512 bytes), whole-disk filesystems | primer | 18 | `primers/block-storage.md` (required by 18) | Closed v3: new primer. |
| ext4 in one picture, mounting, `root=/dev/vda`, `e2fsck`, `mkfs` (e2fsprogs) | primer | 18 | `primers/block-storage.md` | Closed v3: new primer. |
| Page cache, `fsync` vs `F_FULLFSYNC`, durability | primer | 18 | `primers/block-storage.md`; 18 pointer (`man fsync`) | Closed v3: new primer. |
| APFS clones (`cp -c`, `clonefile`) | pointer | 18 | 18 Aside; `primers/block-storage.md` | Closed v3: ch18 box. |
| File locking (`flock`/`fcntl` advisory locks) | pointer | 18 (`disk image is locked`) | `primers/block-storage.md` | Closed v3: new primer. |
| FreeBSD boot chain (`loader.efi`, `loader(8)`), UFS | pointer | 22 | 22 | |
| sha256 pinning, HTTPS-only fetches, why downloads are never executed | pointer | 13 (`scripts/fetch.sh linux`) | 13 Aside + threat model (supply chain) | Closed v3: ch13 box, Pointers. |
| Ethernet, IPv4, ICMP headers; MAC addresses | pointer | 19 | 19 + `frame-dissector` lab | |
| Network offloads (checksum, TSO/GSO, mergeable RX buffers) | pointer | 19 | 19 Aside (two lines per offload) | Closed v3: ch19 box, Pointers. |
| GDB Remote Serial Protocol | pointer | 27 | 27 | |
| Binary plist (GIC state blob) | pointer | 26 | 26 (one sentence) | Closed v3: ch26 box. |

### 1.6 macOS host

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Hypervisor.framework (what it is, its API shape, what it does in the kernel) | core | 00 | 00 (role), 01 (API), 02 (run) | |
| Virtualization.framework (VZ) vs HVF | pointer then chapter | 00 (implicitly: "why not just use Apple's VM API?") | 00 (one sentence), 01 (placed in the stack), 23 | Closed v3: ch00 and ch01 boxes. |
| Code signing, ad-hoc signatures, entitlements, `com.apple.security.hypervisor` | primer | 00 | `primers/codesign-entitlements.md` (required by 01; its 10-minute "need to know" part) | v3.1: the primer is split into need to know and going deeper (novice review 3.3). |
| Hardened runtime (`-o runtime`) and why `DYLD_*` injection matters (SIGN-3) | primer (optional part) | 00 (the signing runner, run not read) | `primers/codesign-entitlements.md` ("going deeper"; needed from 25) | v3.1. |
| AMFI (who enforces signatures and entitlements at run time); restricted entitlements and provisioning profiles (`com.apple.vm.networking`) | primer (optional part) | 01 (`HV_DENIED` "checked by the kernel at call time"), 19 | `primers/codesign-entitlements.md` ("going deeper"; ch01 needs only "the kernel checks it at call time") | v3.1. |
| SIP (System Integrity Protection) | pointer | 00 | `primers/codesign-entitlements.md` ("going deeper": no SIP change, no sudo) | v3.1. |
| Mach error codes (`hv_return_t` values such as `0xfae94007`) | pointer | 01 | 01 ("the kernel's own error numbering" in the text; Mach and `mach/error.h` in an Aside) | v3.1 (novice review 2.1.7). |
| `mach_absolute_time`, the host timebase vs the 24 MHz guest counter | pointer | 03 (`t_ns`), 11 | 11 | |
| `getentropy` | pointer | 17 | 17 | |
| macOS sandbox (Seatbelt): `sandbox_init`, `sandbox-exec`, SBPL profiles, `mach-lookup`, `iokit-open` | primer | 25 | `primers/macos-sandbox.md` (required by 25) | Closed v3: new primer. |
| vmnet.framework | pointer | 19 | 19 | |
| XPC services (where a VZ guest runs, with private entitlements) | pointer | 23 | 23 (core sentence + `ps` capture; Apple XPC docs) | Phase 3: new row. |
| ParavirtualizedGraphics.framework, AVPBooter, the vmapple device set | pointer | 24 | 24 + QEMU `hw/vmapple` docs | |
| Apple's macOS boot chain for VMs (AVPBooter, iBoot stages, kernelcache) | pointer | 24 | 24 Aside (observed, inferred, unknown) | Closed v3: ch24 box. |
| IPSW restore images, `VZMacPlatformConfiguration`, auxiliary storage | pointer | 23 | 23 | |
| Apple's licence terms for macOS VMs | pointer | 23 | 23 (cited, not paraphrased) | |
| Swift (reading a small provided tool) | pointer | 23 | 23 Aside + Swift book | Closed v3: ch23 box. |
| `codesign -d --entitlements -`, `script`, `stty`, `dtc`, `lldb` as tools | pointer | 00 onwards | in the chapters that use them | |

### 1.7 Unix and operating-system concepts

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Process, address, virtual memory | prereq | 00 | entry self-check; `primers/os-basics.md` | |
| Hex, two's complement, bit fields (shift and mask) | prereq | 00 (toy), 02 (`0x3c5`, EC) | entry self-check (v3.1 bit-field warm-up item); practised in `a64-encoder`, `pstate-builder` | v3.1 (novice review 3.2). |
| System call at the hardware level (mode switch, vector, return address in a register on Arm), interrupt | primer | 00 | `primers/os-basics.md` | v3.1: primer scope (novice review 2.2.2). |
| Threads (a process can have many; per-thread state) | primer | 02 ("HVF ties a vCPU to the thread that created it") | 02 (forward definition, with the reason for the tie); `primers/host-concurrency.md` (09) | v3.1: moved out of `os-basics` (novice review 3.2). |
| Timer-driven preemption and scheduling | primer | 11 (objective 1: "to preempt a spinning loop") | `primers/host-concurrency.md` (09) | v3.1: moved from `os-basics`. |
| Process exit codes, `128 + signal` (exit 130) | primer | 03 (exit 5), 09 (exit 130) | `primers/os-basics.md` (exit status), `primers/unix-signals.md` (128 + n) | Closed v3: primer scopes. |
| Signals (SIGINT, SIGTERM, SIGUSR1), handlers, async-signal safety, the self-pipe trick | primer | 09 (`signals.rs`, `sigterm` e2e) | `primers/unix-signals.md` (required by 09) | Closed v3: new primer. |
| Kicking a vCPU with a signal in KVM-based VMMs (Firecracker, crosvm; `KVM_RUN`, `immediate_exit`) | pointer | 20 | 20 Production note + KVM API documentation | Phase 3: new row. |
| TTYs and ptys, termios canonical vs raw mode, echo, the line discipline turning Ctrl-C into SIGINT, `stty -g`, `script` | primer | 09 | `primers/tty-termios.md` (required by 09) | Closed v3: new primer. |
| Terminal escape sequences (ANSI/ECMA-48: CSI, OSC, DCS) and terminal injection by guest output | primer | 09 (filter guest output; `tty_escape` test) | `primers/tty-termios.md` (09), 25 (threat model) | Closed v3: new primer and ch09 forward definition. |
| File descriptors, `pread`/`pwrite`, `O_CLOEXEC`, `umask`, file modes (0600, 0700) | primer | 09 (`--serial file:F`), 18 | `primers/host-concurrency.md` (FDs, 09), `block-storage`, `unix-sockets`, `macos-sandbox` | v3.1: FDs moved from `os-basics`. |
| Unix domain sockets: datagram vs stream, filesystem path, permissions, stale sockets | primer | 19 | `primers/unix-sockets.md` (required by 19) | Closed v3: new primer. |
| Resource limits (`RLIMIT_CORE`, `RLIMIT_NOFILE`) and core dumps | pointer | 25 | `primers/macos-sandbox.md` | Closed v3: primer scope. |
| `fork`/`exec` and why the run path never uses them | pointer | 25 | `primers/macos-sandbox.md` | Closed v3: primer scope. |
| Deadlock and lock ordering | primer | 09 (architecture §14.2 lock order; journal Q3) | `primers/host-concurrency.md` (09), 20 (applied) | Closed v3: new primer. |

### 1.8 Rust and toolchain

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| Ownership, borrowing, `Result`, traits | prereq | 01 | entry self-check; App. A | |
| Slices as pointer plus length; trait objects (`dyn Trait`) as vtables | prereq | 04, 09 | App. A | |
| `unsafe` Rust (the five extra powers; invariants become yours) | core | 01 | 01 (+ App. A) | Closed v3: ch01 box lists it as core. |
| FFI: `extern "C"`, linking a framework (`build.rs`, `-framework Hypervisor`), C types (`uint64_t` → `u64`), out-pointers | core | 01 | 01 + Rustonomicon FFI link | Closed v3: ch01 box lists it as core. |
| `repr(C)` layout and padding | prereq then core | 01 | entry self-check; 01 (`repr-c-layout` lab) | |
| RAII and `Drop` (`Vm` destroys on drop); HVF's one VM per process as global process state | prereq | 01 | App. A; 01 (the surprise is HVF's global state, said in one sentence) | v3.1 (novice review 2.1.8). |
| Integer overflow, `checked_add`/`checked_mul`, wrapping arithmetic | prereq then core | 04 | entry self-check (two's complement); 04 | |
| Rust aliasing promises of `&[u8]`/`&mut`, and why shared guest memory breaks them | core | 04 | 04 (shown with an optimiser-hoisted read; "not a bug today" said); App. A (what a reference promises) | v3.1 (novice review 2.4.1). |
| Volatile accesses vs `copy_nonoverlapping`; what volatile does not give (atomicity, ordering, thread safety) | core | 04 | 04 | v3.1 (novice review 2.4.2). |
| Threads, `Arc`, `Mutex`, `Condvar`, `std::thread::scope`, channels | primer | 09 (`Arc<Mutex<dyn MmioDevice>>`, stdin thread) | `primers/host-concurrency.md` (required by 09) | Closed v3: new primer. |
| Atomics and `Ordering` (`Relaxed`, `Acquire`, `Release`, `SeqCst`) | primer | 09 (`control.rs` stop flag, architecture §14.5) | `primers/host-concurrency.md` (09), `primers/memory-ordering.md` (16) | v3.1: the flag moved from 08 to 09, where its writer (the Ctrl-C handler) exists (novice review 2.8.8). |
| Panics, panic hooks, `catch_unwind` boundaries (terminal restore, worker panic stops the VM) | pointer | 09 | 09 Aside | Closed v3: ch09 box, Pointers. |
| Cargo workspaces, features (`--features hvf-tests`, `experimental-vmapple`), lints (`forbid(unsafe_code)`), `cargo xtask` | pointer | 01 | App. A section; 01 pointer (Cargo book) | Closed v3: App. A scope and ch01 box. |
| Property-based and differential testing | pointer | 13 (10,000-case property test), 16 (differential test) | 13 Aside | Closed v3: ch13 box, Pointers. |
| Fuzzing: seeded PRNG, structure-aware mutation, corpus, minimisation | core | 25 | 25 | Closed v3: ch25 box lists it as core, taught here. |
| `cargo fuzz` / libFuzzer | pointer | 25 | 25 | |

### 1.9 Security and engineering practice

| Concept | Tier | First used | Taught in | GAP |
|---|---|---|---|---|
| The guest as an adversary; every guest value is hostile | core | 03 (journal Q3) | 04, 16, 25 | |
| Bounding work and resources (hop budgets, caps, rate limits) as a defence | core | 03 (journal Q3), 04 (Q5) | 16, 25 | |
| Threat modelling, STRIDE, trust boundaries | pointer | 25 | 25 + `docs/security/threat-model.md` | |
| Confused deputy | pointer | 25 (misconception) | 25 (one sentence) | Closed v3: ch25 box, Pointers. |
| MAC / HMAC-SHA256, authenticated file formats, per-user key files | pointer | 26 | 26 Aside + RFC 2104 | Closed v3: ch26 box, Pointers. |
| Architecture decision records (ADRs) | pointer | 21 (learner writes one) | 21 Aside (`docs/adr/`, Nygard) | Closed v3: ch21 box, Pointers. |
| Reading primary specs (ARM ARM structure, register pages, pseudocode, virtio MUST/SHOULD, DT spec) | primer | 01 (read the SDK headers), 07 (ARM ARM D17) | `primers/reading-arm-specs.md` (required by 07; linked from 01) | Closed v3: new primer. |
| The test pyramid; why hosted CI cannot run HVF | pointer | 27 | 27 | |

## 2. Gap summary (v1 audit record; all closed in v3)

Counts from the v1 audit of section 1: 40 GAP-NONE rows (5 of them minor), 16 GAP-ORDER, 13 GAP-SCOPE and 5
GAP-BOX; the UEFI row carries two flags. Most GAP-NONE rows close with an Aside and a link. The
ones that need real teaching group as follows.

**Concepts nothing teaches (need a new primer):**

1. Threads, `Arc`/`Mutex`/`Condvar`, atomics, deadlock and lock order: used from 09.
2. Linker scripts, sections, flat binaries, cross-compilation: used in 03.
3. Signals, exit codes, the self-pipe trick: used from 09.
4. TTYs, termios raw mode, escape sequences: used from 09.
5. Caches and coherency (PoC, I-cache, memory attributes): used in 04, 06, 13, 27.
6. UEFI: used in 13, 21; only a pointer in 22.
7. What Linux does from entry to `/init`, driver binding, modules: used in 10 (Q2), 14, 18.
8. Block storage: raw images, ext4, page cache, `fsync` vs `F_FULLFSYNC`, locks, APFS clones: 18.
9. Unix domain sockets: 19, 27.
10. The macOS sandbox, rlimits: 25.
11. Reading primary specs and ARM ARM vocabulary (RAZ/WI, UNDEFINED): 07, 08, 09.

**Concepts used before the chapter that teaches them (need a forward definition or a move):**

1. IPA and stage-2 mapping in 02 (taught 05).
2. 16 KiB granule in 02 (primer is required only from 04).
3. PSTATE bits (`0x3c5`) in 02 (taught 06).
4. INTIDs and the virtio slot table in 05's checkpoint (taught 12 and 15).
5. Interrupt status and mask registers in 09 (taught 11).
6. `WFI`, `CNTVCT_EL0` and guest page faults in ch00's `trap-or-not` lab (taught 11, 05).
7. ELF in 03 (primer at 13).
8. The arm64 boot protocol primer is required by 06, but CURRICULUM 2.1 says 13.
9. Atomics in 08 and 20 (memory-ordering primer at 16).
10. Lock ordering in 09 (taught 20).
11. Terminal injection in 09 (threat model in 25).
12. Virtualization.framework is named in 00's framing but taught in 23.

**Missing from a planned scope (extend, do not add):** threads, preemption and file descriptors
in `os-basics`; hardened runtime, AMFI, restricted entitlements and "no SIP change" in
`codesign-entitlements`; a minimal UEFI and PE section in `efi-zboot`; memory attributes in
`page-tables`; `Drop`, reference aliasing promises and Cargo features in Appendix A; AAPCS64 and
byte order in Appendix B; one byte-order question in the entry self-check; DMA named in ch15.

**Chapter boxes to correct in CURRICULUM section 5:** 01 (FFI and `unsafe` are core here), 03
(bare-metal entry is core here; add the `bare-metal-rust` primer), 25 (fuzzing is core here; add
`macos-sandbox`), 27 (breakpoints and single step are core here); plus the new primers in the
boxes of 03, 06, 07, 09, 14, 18, 19, 21 and 25.

**Pointers to add (Aside plus link, no primer):** nested virtualization (02), desktop VM apps (00),
ID registers (08), LPIs and the ITS (12), UART basics (09), kernel command line (10), Mach error
codes (01), Apple's VM boot chain (24), Swift (23), network offloads (19), APFS clones (18),
modules and modloop (18), sha256 pinning (13), ADRs (21), HMAC (26), panics and hooks (09),
property testing (13), confused deputy (25), binary plists (26).

## 3. Primers to write

The twelve primers in CURRICULUM 2.1 stay. This list adds eleven, and notes scope changes to
existing ones. "Required by" is the first chapter whose box must link it. Each primer is 15 to 30
minutes, with objectives and a self-check; labs follow `course/site/LABS.md`.

### 3.1 Existing primers (CURRICULUM 2.1), with scope changes

| Primer | Required by | Scope change from this audit | Suggested lab |
|---|---|---|---|
| `os-basics` | 00 | v3: add threads, timer-driven preemption, file descriptors. **v3.1: those three move to `host-concurrency`;** add the syscall at the hardware level, the exception vector table, a worked two-level page-table example, and what firmware is. | `syscall-stepper`: an app's `svc`, the kernel's handling, the return; reuse the `exception-stepper` engine at EL0 to EL1. |
| `codesign-entitlements` | 01 | Add hardened runtime and `DYLD_*`, AMFI, restricted entitlements and provisioning profiles, "no SIP change, no sudo". **v3.1: split into a 10-minute "need to know" part and an optional "going deeper" part holding all of these.** | None; self-check reads real `codesign -d` output. |
| `smccc` | 03 | None (relies on AAPCS64 in `aarch64-reading`). | Shares `sysreg-smccc` (function-ID builder). |
| `page-granules` | 04 (link from 02) | None; ch02 links it once. | `two-stage-walker` with granule toggles. |
| `page-tables` | 05 | Add Normal vs Device memory and `MAIR_EL1` in one section. | `two-stage-walker` (stage-1 mode). |
| `primecell-ids` | 09 | None. | None. |
| `arm64-boot-protocol` | **06** (was 13) | Mark which parts 06, 10 and 13 each need. | `image-inspector`. |
| `elf` | 13 (link from 03) | None. | `elf-inspector`: drop a binary, see headers and segments (could share `image-inspector`'s drop zone). |
| `cpio-initramfs` | 13 | None. | `cpio-inspector`: list newc entries and header fields. |
| `efi-zboot` | 13 | Add one page on UEFI applications and the PE/COFF header, pointing at `uefi`. | `image-inspector` zboot mode. |
| `memory-ordering` | 16 | Start from the atomics introduced by `host-concurrency`. | `litmus` (already planned). |
| `u-boot` | 21 | Assume `uefi`; do not re-teach it. | `boot-chain` (already planned). |

### 3.2 New primers

1. **`bare-metal-rust`** (required by 03).
   Scope: what `no_std` and `no_main` remove, target triples and `rustup target add`, the
   sections a linker produces, a linker script that places `_start` at `0x4008_0000`, BSS and
   stack, and turning the ELF into a flat binary. Ends with "nothing in the CPU gives you a stack".
   Lab: `linker-map`, an interactive version of ch03's static figure: drag sections, see load
   addresses, `filesz` vs `memsz`, and what the flat binary contains.

2. **`host-concurrency`** (required by 09; used by 11, 17, 20, 26).
   Scope (v3.1 adds what `os-basics` gave up): threads and per-thread state, timer-driven
   preemption, file descriptors; threads in Rust, `Arc`, `Mutex`, `Condvar` (including spurious wake-ups and the
   predicate loop), `thread::scope`, atomics as flags, deadlock and a fixed lock order. Says what
   the borrow checker proves about data races and what it leaves to you.
   Lab: `lock-order`, two threads and two locks you step by hand until they deadlock, then fix the
   order; plus a condvar "lost wake-up" mode.

3. **`unix-signals`** (required by 09; used by 14).
   Scope: what a signal is, default actions, exit status `128 + n`, why a handler may only do
   async-signal-safe work, and the self-pipe trick that turns a signal into an ordinary event on
   a thread. Covers SIGINT, SIGTERM and SIGUSR1 as macvmm uses them.
   Lab: none; a self-check that predicts the exit code and the thread that sees each signal.

4. **`tty-termios`** (required by 09; used by 14, 25).
   Scope: TTY, pty and `script`, canonical vs raw mode, echo, how the line discipline makes
   Ctrl-C into SIGINT, saving and restoring with `stty -g`. Then escape sequences (CSI, OSC) and
   why bytes from a guest can change, query or spoof the host terminal.
   Lab: `ansi-filter`, paste bytes and see how a terminal would act on them, and what the `safe`
   and `strict` policies of architecture §21.4 output (vectors exported from `backend/ansi.rs`).

5. **`caches`** (required by **13** since v3.1, was 06; linked from 04's optional Under the hood; used by 27).
   Scope: cache lines, data vs instruction caches, Point of Coherency and Point of Unification,
   clean and invalidate, cacheable vs Device memory, and what `booting.rst` means by "cleaned to
   PoC". Ends with the two evidence experiments of first-principles R13, and says which result
   was observed.
   Lab: `cache-views`, two observers (VMM cacheable mapping, guest with MMU off) and a toy cache;
   toggle clean and invalidate and see who reads stale data.

6. **`uefi`** (required by 21; linked from 13 and 22).
   Scope: UEFI as an interface, not a program: boot services vs runtime services, EFI
   applications as PE/COFF images, the system partition, configuration tables (how a DTB or ACPI
   reaches the OS), and where U-Boot's `bootefi` and EDK2 fit.
   Lab: extend `boot-chain` with a UEFI path (firmware, `loader.efi`, kernel, and who owns the
   DTB at each step).

7. **`linux-boot-sequence`** (required by 14; linked from 10 and 18).
   Scope: from the first instruction at the Image entry to `/init`: early console, MMU on, DT
   unflattening, driver binding by `compatible`, clocksource and delay calibration, initcalls,
   initramfs unpacking, `/init` and BusyBox; kernel modules and Alpine's `modloop`. Maps each stage
   to the boot-log lines learners will see.
   Lab: `boot-log-annotator` (already planned), with a "stage" colouring mode.

8. **`block-storage`** (required by 18; used by 22).
   Scope: sectors and raw images (vs qcow2), a filesystem on a whole disk, ext4 in one picture
   (superblock, journal), mounting and `root=`, the page cache, `fsync` vs `F_FULLFSYNC` on macOS,
   advisory file locks, APFS clones.
   Lab: `durability-ladder`, a write's path through guest cache, virtio FLUSH, host page cache and
   the drive, with "process killed" and "power lost" buttons showing what survives.

9. **`unix-sockets`** (required by 19; used by 27).
   Scope: Unix domain sockets, stream vs datagram (message boundaries), the filesystem path and
   its permissions, stale socket files and why macvmm replaces only a socket it owns, and why no
   entitlement is needed.
   Lab: none; a self-check with a two-VM socket diagram to fill in.

10. **`macos-sandbox`** (required by 25).
    Scope: Seatbelt and SBPL in brief, `sandbox-exec` vs `sandbox_init`, `(deny default)` and the
    operation classes macvmm denies (file, network, process-exec, `mach-lookup`, `iokit-open`),
    resource limits (`RLIMIT_CORE`, `RLIMIT_NOFILE`), `umask` and `O_CLOEXEC`. States which parts
    are undocumented (`[H]`) and what was observed.
    Lab: none; self-check predicts which syscalls the profile denies.

11. **`reading-arm-specs`** (required by 07; linked from 01 and 02).
    Scope: how the ARM ARM (DDI 0487) is organised, how to read a register page and its field
    tables, the ESR ISS tables, the pseudocode conventions, and the vocabulary RAZ/WI, RES0/RES1,
    UNDEFINED, UNKNOWN, IMPLEMENTATION DEFINED. A short section on virtio's MUST/SHOULD and the DT
    spec's chapter 5.
    Lab: a "spec hunt" self-check: given a question, find the section; answers link the
    `esr-decoder` lab.

### 3.3 Appendix and self-check changes (not primers)

- **Entry self-check:** add one byte-order question (read a little-endian and a big-endian
  `u32` from the same four bytes).
- **Appendix A:** add `Drop` and RAII, what `&T` and `&mut T` promise (aliasing), and Cargo
  workspaces, features and lints.
- **Appendix B:** add AAPCS64 argument and result registers, register 31 as `xzr` or `sp`, and a
  byte-order section.

## 4. Learner glossary (moved to `course/GLOSSARY.md`)

The learner glossary now lives in **`course/GLOSSARY.md`**, which the site renders at
`/build-your-own/vmm/glossary/` and which every lesson links a term's first use to (CURRICULUM
section 2). It was seeded from the table that used to stand here (v3.1, Parts 0 to III) and now
covers every chapter, with one section per chapter plus a Primers section. This section keeps no
copy, so there are not two lists to drift apart. Authors add a glossary entry to `GLOSSARY.md` in
the same change that first uses a term in a lesson; a term a lesson uses that is in neither the
glossary nor everyday programming blocks the lesson, as a GAP does above. Concept rows (tier,
first use, where taught) stay in section 1 of this file.
