---
title: Guest memory: the only safe access is a copy
part: II
chapter: II.1
id: 04
runs: mac+browser
minutes: 210
prereqs: [03]
start_tag: ch-03
labs: [gpa-translator]
command: scripts/checkpoint.sh 04
expect: CHECKPOINT 04 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** guest RAM as host memory lent to the guest; the region table and its construction rules; `GuestAddress`; checked arithmetic (`checked_add`) and wrapping overflow as an attack; the `GuestMemory` contract (`read`, `write`, `check_range`, the little-endian helpers, `read_obj`), one region per access; copy-only access, and why there is no `get_slice` (what a `&[u8]` promises the compiler); volatile element copies versus `copy_nonoverlapping`, and what volatile does not give; the memory-hash debug call.
- **Core, from earlier:** `hv_vm_allocate`, `hv_vm_map`, the IPA (intermediate physical address) and the 16 KiB host page (chapter 02); the run loop, the debug calls and the `--raw` loader (chapter 03).
- **Primers (read first):** `page-granules` (what a granule is; why the stage 2 of HVF, Hypervisor.framework, uses 16 KiB on a Mac by default while a guest may use 4 KiB).
- **Primers (review):** `bare-metal-rust` (the MMU, memory management unit, in one paragraph); `aarch64-reading` (byte order; registers and the zero register; AAPCS64, who puts arguments where; reading a disassembly); `host-concurrency` (its section "Rust refuses to compile the race": what a Rust reference promises, and what a data race is).
- **Pointers:** the caches primer, from an optional Under the hood; the memory-ordering primer, for ordering between threads (required from chapter 16); rust-vmm's `vm-memory` crate, in a Production note.
- **Forward definitions:** DMA, direct memory access (chapter 15); TOCTOU, time of check to time of use (chapter 16); the ordered accessors of `GuestMemoryOrdered` (chapter 16); flash and `RomRegion` (chapter 21); the IPA size (chapter 05). Each is defined at first use.
:::

A guest hands your virtual machine monitor (VMM) two numbers, "hash the 8 bytes at `0xFFFF_FFFF_FFFF_FFFC` for me", and your VMM checks them the obvious way, in 64-bit unsigned arithmetic as C would: is `addr` at or above the start of guest RAM, and is `addr + len` at or below its end? RAM is `0x4000_0000` to `0x4400_0000`. Work it out on paper before reading on: does the check say yes or no, and if yes, which bytes would you hash?

The answer is yes, and the bytes are not in guest RAM at all. This chapter explains why, and builds the one component that every device, loader and debug call in the rest of the course uses to touch the guest's memory, so that this mistake can be made in exactly one place and is not made there. It closes half of row 2 of chapter 00's problem ledger, memory: our VMM owns the guest's RAM and every access to it. The other half, translation, is chapter 05.

:::objectives
- Allocate guest RAM with `hv_vm_allocate` and map it with `hv_vm_map` in 16 KiB pieces, and explain from the Predict run why 16 KiB: with HVF's default granule, `hv_vm_map` refuses anything smaller, stage-2 permissions come per 16 KiB, and the guest's own page size is a separate matter.
- Implement the `GuestMemory` contract: `read`, `write` and `check_range`, with the little-endian helpers and `read_obj` on top, where `checked_add` and a one-region rule refuse every out-of-range or overflowing access, and every copy is made of volatile element accesses.
- Explain, with the generated machine code as evidence, why guest RAM is read only with volatile copies: any ordinary read, through a slice or a raw pointer, lets the optimiser assume nobody else writes, and a `&[u8]` makes that promise for its whole lifetime, which is why the contract has no `get_slice`.
- Explain with one concrete overflow attack why a VMM never forms a host pointer from a guest address without a checked range test, and predict what each wrong fix (wrapping, panicking) does.
:::

**Before you start.** From the repository root, run `scripts/learner start 04`. It copies this chapter's journal and the five files of the memory module (`learner/crates/vmm/src/memory/`) into your workspace. The files are complete except for three holes marked `// LEARNER:`, each a `todo!()`: the bounds checks this chapter is about. You write those; the rest you read along with the lesson, and then "Putting it to work" wires the module into your chapter 03 code, one numbered step at a time.

## Guest RAM is your memory, lent out

In chapter 02 you gave a guest one 16 KiB page holding three instructions. Chapter 03's guests got more, but the idea did not change: our VMM allocates ordinary host memory, then asks Hypervisor.framework (HVF) to make it appear in the guest at a guest-physical address, an [IPA](/build-your-own/vmm/glossary/#ipa) (intermediate physical address). From then on there is one set of bytes with two names:

```text
        guest (EL1)                    |              our VMM (a macOS process)
                                       |
  str x1, [x0]   x0 = 0x4100_0000      |    ram.read(GuestAddress(0x4100_0000), &mut buf)
        |                              |               |
        | translated by stage 2 (HVF)  |               | looked up in our region table
        v                              |               v
  IPA 0x4100_0000 ---------------> host bytes at host_base + 0x0100_0000
                                       |
                 trust boundary: every number on the left is the guest's choice
```

*One allocation, reached from both sides. The guest's store and our read land on the same bytes.*

That picture has two consequences, and they are this chapter. First, every address that arrives from the left, in a register, in a request, in a file the guest wrote, is a number an adversary chose, and we turn it into a host pointer. Second, the guest can change those bytes at any time, including while we are reading them.

Before either, one question about the mapping itself. Chapter 02 always mapped a whole 16 KiB. What if a guest only needs 4 KiB?

:::predict Chapter 02's `first-exit` maps 16 KiB at `0x4000_0000`. Change it to ask `hv_vm_map` for 4 KiB at the 4 KiB-aligned address `0x4000_1000`. Will the call succeed, fail with an error, or succeed but quietly round the size or the address?
Write your answer and one sentence of reasoning under `## Predict` in your journal, then make the experiment below and run it.
:::

The experiment is two edits in your workspace, `learner/`. It is its own git repository, so commit your chapter 03 work first if you have not; afterwards `git diff` shows exactly what you changed and `git restore crates/` undoes it.

1. In `crates/macvmm/src/first_exit.rs`, the `OwnedMapping::new` call: the address becomes `RAM_BASE + 0x1000`, the length `0x1000`.
2. In `crates/hvf/src/vm.rs`, `OwnedMapping::new`: keep allocating a whole 16 KiB host page (`hv_vm_allocate` refuses anything else), but pass the caller's 4 KiB length to `hv_vm_map`.

Then, from inside `learner/`, run `cargo run -q -p macvmm -- first-exit`. Our run, on a real Mac:

:::term source=captures/04-map-4k.txt

An error, `HV_BAD_ARGUMENT`, and nothing mapped. No rounding happens behind your back, which is the kind of failure you want: loud and early.

**Why 16 KiB.** Apple silicon Macs use 16 KiB memory pages, and HVF's [stage-2](/build-your-own/vmm/glossary/#stage-1-stage-2) table, the one that maps guest memory to ours, uses the same page size by default, so mappings and their permissions come in 16 KiB pieces. The guest's own page tables are separate and may use 4 KiB pages. The `page-granules` primer calls such a page size a [granule](/build-your-own/vmm/glossary/#granule), "the page size a translation table uses". The [host page](/build-your-own/vmm/glossary/#host-page) size is a fact we read at run time rather than hard-code:

:::code anchor=host_page_size file=crates/hvf/src/caps.rs

"By default" matters: macOS 26 added `hv_vm_config_set_ipa_granule`, which opts one virtual machine (VM) into a 4 KiB stage-2 granule, and then 4 KiB maps at 4 KiB-aligned addresses succeed. We keep the 16 KiB default, as the `page-granules` primer explains; our captures all use it, because `first-exit` creates its VM without a configuration.

> **Try it.** The SDK (software development kit) header `hv_vm.h` documents `hv_vm_map`'s guest address as "page aligned" and its size as "a multiple of the page size" (and asks the same alignment of the host address, which `hv_vm_allocate` always hands out page-aligned). Which of your two changes does HVF object to? Make them one at a time, with the same edit-run-restore routine: a whole 16 KiB page at `0x4000_1000` (only the address change of edit 1), then 4 KiB at `0x4000_0000` (only the length change of edit 1, plus edit 2).

:::term source=captures/04-map-ipa-4k.txt

:::term source=captures/04-map-len-4k.txt

Both fail the same way: the guest address and the size are each held to the page size on their own. So HVF works in whole host pages, while a Linux guest will happily work in 4 KiB pages inside them: two translations, two owners, two granules. Chapter 05 draws both stages.

## The region table: rules for the shape of RAM

Guest RAM may come in more than one piece, a **region**: a base IPA and a size. Our VMM keeps the pieces in a [region table](/build-your-own/vmm/glossary/#region-table), and the table is pure arithmetic, with no pointers and no HVF, so it can be tested on any computer. Its constants:

:::code anchor=region_consts file=crates/vmm/src/memory/region.rs

One more input needs a sentence first. A VM's guest-physical address space has a fixed size, set when the VM is created, given as a number of address bits, `ipa_bits`: with 36 bits the guest can reach IPAs below 2 to the 36th, 64 GiB. A region that ends above that limit could never be mapped. Chapter 05 explains how to choose the number (it is the [IPA size](/build-your-own/vmm/glossary/#ipa-size)); today 36 is enough, HVF's default when a VM is created without a configuration, as yours was.

The constructor has one rule per failure it has to prevent. First the rules for the table and for each region on its own; read the module comment beside it in your copy of `region.rs`, which gives the reason for each:

:::code anchor=region_table_per_region file=crates/vmm/src/memory/region.rs

Then one rule across regions:

:::code anchor=region_table_overlap file=crates/vmm/src/memory/region.rs

The cheap rules first: an empty table, too many regions, an `ipa_bits` outside what HVF supports, and a zero-size region are each refused before any arithmetic. Then four rules deserve a sentence. *Alignment* is the Predict, caught here with a clear error instead of `HV_BAD_ARGUMENT` from deep inside setup. *No `base + size` overflow*: a region near the top of the address space whose end wraps to a small number would appear to contain low memory. *Below the IPA limit*: as above. *No overlap*: one guest-physical byte must have exactly one host home.

## One block per region

Why not a `Vec<u8>` for guest RAM? HVF maps only whole host pages that start on a page boundary, and a `Vec` promises neither. `hv_vm_allocate` is the call made for this: its header calls the result "anonymous memory suitable to be mapped as guest memory", it hands back page-aligned memory of a size that must be a page multiple, and it must be given back with `hv_vm_deallocate`. Chapter 02's `Allocation` was a stand-in for this wrapper; here is the real one, which checks the size before asking:

:::code anchor=host_allocate file=crates/hvf/src/host.rs

The reference keeps each piece of [guest RAM](/build-your-own/vmm/glossary/#guest-ram) in a `Block`: one such allocation, the IPA where it will appear, and a small state machine that remembers whether it is mapped. This is `memory/host.rs`, the only file of the `vmm` crate allowed to contain `unsafe`:

:::code anchor=guest_ram_block_struct file=crates/vmm/src/memory/host.rs

:::code anchor=guest_ram_block_new file=crates/vmm/src/memory/host.rs

Mapping is chapter 02's `vm.map` call with one addition: the block records that it is mapped, because memory the guest can still reach must never be freed (if an unmap fails, the block is leaked on purpose; the comment at the top of `host.rs` gives the whole teardown rule):

:::code anchor=guest_ram_block_map file=crates/vmm/src/memory/host.rs

`GuestRam` is a region table plus one block per region. Building one validates the table first, so a bad layout allocates nothing:

:::code anchor=guest_ram_new file=crates/vmm/src/memory/host.rs

## A guest address is a number the guest chose

Guest addresses get a type of their own, so that a guest-physical address cannot be passed where a host pointer or a guest-virtual address was meant:

:::code anchor=guest_address_type file=crates/vmm/src/memory/address.rs

Now back to the opening puzzle. In 64-bit arithmetic, `0xFFFF_FFFF_FFFF_FFFC + 8` is `0x1_0000_0000_0000_0004`, which needs 65 bits. That event is an [integer overflow](/build-your-own/vmm/glossary/#integer-overflow), and Rust offers three answers for the missing bit: with overflow checks off (its default for release builds) the sum silently **wraps** to `0x4`; with them on, the program panics; and `checked_add` returns `None`, an ordinary value you must handle. Only the third, [checked arithmetic](/build-your-own/vmm/glossary/#checked-arithmetic), is safe.

With the wrapped sum, `addr >= 0x4000_0000` holds and `0x4 <= 0x4400_0000` holds, so the check passes. The offset into RAM is `addr - 0x4000_0000 = 0xFFFF_FFFF_BFFF_FFFC`, and `host_base + offset` wraps around to `host_base - 0x4000_0004`: a pointer about 1 GiB *below* our allocation, into whatever the host keeps there. If the address is in range, is the access safe? Not when "in range" was computed with a sum that wrapped.

Try both versions in the lab: a region table, an address and a length, with an overflow mode that does the arithmetic the wrapping way.

:::lab gpa-translator

If the lab does not load, here is what it shows for the opening puzzle (one region, `0x4000_0000` to `0x4400_0000`, host base written `H`):

```text
mode       addr                    len   addr + len               verdict   host address
checked    0x4000_1000             8     0x4000_1008              ok        H + 0x1000
checked    0xFFFF_FFFF_FFFF_FFFC   8     overflow (None)          fault     none
wrapping   0xFFFF_FFFF_FFFF_FFFC   8     0x4 (wrapped)            "ok"      H - 0x4000_0004
```

The reference's loader for `--raw` already does this right; you met its placement check in chapter 03:

:::code anchor=raw_check_placement file=crates/vmm/src/loader/raw.rs

:::code anchor=loader_ram_range file=crates/vmm/src/loader/mod.rs

We checked on a real Mac what it says to chapter 03's `hello` guest placed 16 bytes below the top of the address space:

:::term source=captures/04-raw-wrap.txt

`0xffff_ffff_ffff_fff0 + 0x2d9a` wraps to `0x2d8a`; a wrapping check would have let the loader copy 11 KiB of guest image to `host_base - 0x4000_0010`, 1 GiB and 16 bytes below our allocation. The same check refuses the ordinary mistake too, an image that starts inside RAM and ends past it:

:::term source=captures/04-raw-edge.txt

Write the safe version yourself: the first `LEARNER` hole is the body of `GuestAddress::checked_add`. Then compare:

:::code anchor=guest_address_checked_add file=crates/vmm/src/memory/address.rs

## One access, one region

Why `checked_add` alone is not enough: two regions that sit next to each other in the guest's address space are two separate host allocations, so a copy that starts in one and ends in the other would run off the end of the first. The rule is that the whole range `[addr, addr + len)` must lie inside **one** region. A zero-length range is refused too: otherwise a zero-length access at any address, even far outside RAM, would succeed, and "`check_range` says yes" could no longer mean "this address is in RAM". Refusing it keeps `read` succeeding exactly when `check_range` is true, as the trait's comment promises. Refusals carry the numbers, for the log:

:::code anchor=memory_error file=crates/vmm/src/memory/mod.rs

The second `LEARNER` hole is `RegionTable::locate`, the function that decides. Write it from the rules above (overflow first, then zero length, then "the last region whose base is at or below `addr`", then the end). Then run the contract tests: from the repository root, `scripts/checkpoint.sh 04`. Its first line, `contract`, is the 37 hostile contract tests, which live with the checkpoint, not in your crate; `cargo test -p vmm` runs only your crate's own unit tests. The later lines fail until "Putting it to work" is done, and that is expected for now. Then compare:

:::code anchor=guest_ram_bounds_check file=crates/vmm/src/memory/region.rs

> **Security.** The attacker controls `addr` and `len`, and both arrive from many directions: the memory-hash call's registers later in this chapter, descriptors in shared memory from chapter 16, headers of files the guest wrote. What breaks without `checked_add` is the host: a read leaks host memory to the guest, a write corrupts it. That is why the reference checks twice: `locate` decides, and the code that forms the pointer (`Block::ptr`, below) checks the block length again, so a bug in one cannot become an out-of-bounds pointer.

:::stopping-point Good place to stop. The second sitting is about how to touch the bytes once an access is in bounds, then wires the module into your VMM.

## The only safe access is a copy

Once an access is in bounds, how should we touch the bytes? The convenient answer is a slice: `fn get_slice(&self, addr, len) -> &[u8]`, then read whatever you like. The contract forbids it, and here is why.

A shared reference `&[u8]` tells the compiler: while this reference lives, nobody changes these bytes. Unlike C's `const uint8_t *`, which only stops *you* writing, a Rust `&[u8]` promises that *nobody* writes (outside an `UnsafeCell`, a simplification we keep; the `host-concurrency` primer has the rule). The compiler is allowed to rely on such promises. Here are three functions that wait for the guest to set a flag byte, trying at most `limit` times. The first reads through a slice:

:::code anchor=hoist_slice file=course/examples/04-hoist.rs

The second has no reference at all: a raw pointer, read with an ordinary load:

:::code anchor=hoist_raw file=course/examples/04-hoist.rs

The third reads through a raw pointer with a load the compiler must perform every time, exactly as written: a [**volatile**](/build-your-own/vmm/glossary/#volatile-access) load:

:::code anchor=hoist_volatile file=course/examples/04-hoist.rs

Compiled with optimisations, as a release build would be. Arguments arrive in registers (the `aarch64-reading` primer's section on AAPCS64, the Arm procedure call standard): `wait_slice` gets the slice's pointer in `x0`, its length in `x1` and `limit` in `w2`; the other two get the pointer in `x0` and `limit` in `w1`. A `w` register is the 32-bit half of an `x` register, and `wzr` reads as zero.

:::term source=captures/04-hoist-asm.txt

Look for a loop. `wait_volatile` has one: the block at `LBB2_2` loads the byte (`ldrb`, load register byte), and if it is still zero (`cbnz`, compare and branch if not zero), counts and goes round again. `wait_slice` has none. It loads the byte *once*, and `csel` (conditional select) returns `limit` if the byte was zero, else 0: since the byte "cannot change", the compiler worked out every try's answer from the first.

`wait_raw` has no loop either, and no reference was involved. What lets the optimiser hoist the load out of the loop is the ordinary, non-volatile read: if another thread could write the byte meanwhile, the program would contain a data race, which Rust's rules say never happens, so the compiler may assume nobody else writes. Only a volatile (or an atomic) access forbids that assumption. The slice adds a stronger promise on top, "unchanged for the whole lifetime of the reference", which no code could keep for guest RAM; that is why the contract has no `get_slice`. If the guest sets the flag a microsecond later, neither `wait_slice` nor `wait_raw` sees it. The compiler did nothing wrong; we lied to it. (The `cbz x1` line in `wait_slice` is `flag[0]`'s bounds check: an empty slice panics.)

**Honest about today.** This is not a bug you can trigger yet: there is one vCPU, and it is stopped while we handle its exit, so nothing changes guest RAM while we look at it. It becomes real with device threads (Part VII) and several vCPUs (chapter 20). We set the rule now because retrofitting it later means rewriting every device. Its name, for later: a value that changes between the moment you check it and the moment you use it is a **TOCTOU** bug (time of check to time of use), and chapter 16 makes one happen on purpose.

**What volatile does and does not give you.** A volatile access makes the compiler perform every access, in program order relative to other volatile accesses, never assuming the value is unchanged, and at its size for an aligned scalar such as `u8` or `u64` on arm64 (Rust's documentation calls exact load sizes target-dependent). It gives *no* atomicity across elements (an 8-byte copy the guest writes into halfway can mix old and new bytes) and *no* ordering with other threads or the guest (that is what the memory-ordering primer and chapter 16 are for). In C you may have heard volatile means thread-safe. It does not, in C or in Rust.

Rust's own documentation goes further: on ordinary Rust memory, volatile does not make a race defined; volatile accesses behave like non-atomic ones there. Our argument is that guest RAM is not ordinary Rust memory. It comes from `hv_vm_allocate`, outside any Rust allocation; no reference into it ever exists; and it is changed by an agent outside the program, the guest, which is the memory-mapped I/O case the documentation allows for volatile. rust-vmm makes the same argument. So our copies are volatile, and we validate the copy, never the original.

Why not `ptr::copy_nonoverlapping`, Rust's `memcpy`? Because it is an ordinary copy, with the same assumption as `wait_raw`: nobody else writes. The optimiser may then re-read the guest's bytes later instead of using the copy, the mirror image of the hoisted read above, and a check made on the copy would no longer cover the bytes used. The reference copies element by element, each one volatile. `read_volatile` on a `u64` needs an 8-aligned address, so the head is copied byte by byte until the pointer is aligned, then the middle in `u64`s (fewer, wider accesses are faster), then the tail byte by byte:

:::code anchor=guest_ram_volatile_read file=crates/vmm/src/memory/host.rs

`volatile_write`, beside it in `host.rs`, is its mirror image. This rule, that our VMM reaches guest RAM only by copying into and out of its own buffers, is [**copy-only access**](/build-your-own/vmm/glossary/#copy-only-access).

The third `LEARNER` hole is the last line of defence before those copies: `Block::ptr`, which turns a checked offset into a pointer, and checks once more against the block's real length:

:::code anchor=guest_ram_block_ptr file=crates/vmm/src/memory/host.rs

## The contract

Everything so far fits behind three methods and a few helpers. This is the `GuestMemory` trait, frozen: its signatures do not change for the rest of the course, so later chapters and the lifelines can rely on them. It is exactly what your checkpoint uses:

:::code anchor=guest_memory_trait file=crates/vmm/src/memory/mod.rs

[GuestMemory](/build-your-own/vmm/glossary/#guestmemory) is a trait rather than `GuestRam`'s own methods for two real needs. The checkpoint's contract tests run on any computer, without HVF, against `VecMemory`, a host test double backed by `Vec`s that uses the same region table. And if you get stuck later, `scripts/learner lifeline` can lend you the reference's module, which only works if both sides agree on these exact signatures.

There is a reason beyond tidiness to route every access through it. Real devices read and write RAM by themselves, without the CPU, which is called [DMA](/build-your-own/vmm/glossary/#dma) (direct memory access); our emulated devices will do the same through this API, which is why every device in this course touches guest memory only through `GuestMemory`. Chapter 15 builds on it.

The helpers are little-endian because the guest is (the `aarch64-reading` primer's byte-order section): `write_u32(a, 0xdead_beef)` stores the bytes `ef be ad de`. `read_obj` reads a whole structure in *one* copy, then decodes it; chapter 16 relies on that to read a guest's request once and only once:

:::code anchor=from_le_bytes file=crates/vmm/src/memory/mod.rs

:::code anchor=read_obj_from file=crates/vmm/src/memory/mod.rs

`GuestRam` implements the trait in a few lines, because the work is done by `locate`, `Block::ptr` and the volatile copies:

:::code anchor=guest_ram_host_ptr file=crates/vmm/src/memory/host.rs

:::code anchor=guest_ram_access file=crates/vmm/src/memory/host.rs

`VecMemory` resolves every access through the very same `locate`, so a test that passes against it has exercised your bounds logic:

:::code anchor=vec_memory_access file=crates/vmm/src/memory/vec_mem.rs

Two more items are in your copied files and in the contract tests, and you only need to read them today. `GuestMemoryOrdered` adds two 16-bit accessors with ordering guarantees, which chapter 16 explains. `RomRegion` holds firmware in flash, the memory a real board keeps its firmware in, which survives power-off and which the guest may read but not write; it is deliberately *not* reachable through `GuestMemory`, and chapter 21 uses it.

> **Production note.** rust-vmm's `vm-memory` crate, used by Firecracker and Cloud Hypervisor, reaches guest memory through volatile accessors and bounds-checked copies; even its `get_slice` returns a `VolatileSlice`, a pointer and length with volatile accessors, never a `&[u8]`. Ours is smaller and single-purpose, so every line of it fits in this chapter.

## Putting it to work

Four steps connect the module to your chapter 03 VMM, each in a file of `learner/`.

**Step 1: declare the module.** In `crates/vmm/src/lib.rs`, add `pub mod memory;`. Your crate starts with `#![deny(unsafe_code)]`; `memory/host.rs` opens with `#![allow(unsafe_code)]`, which lifts that for this one file (a `deny` can be lifted this way, a `forbid` could not), so every pointer into guest RAM lives in a single file you can audit.

**Step 2: give the module what it uses.** The copied files use a few names from the rest of the reference crate: an `Error` type with a `Result` alias (`crate::error`), a `warn!` logging macro, a `lock` helper for mutexes (`crate::sync`), and, from your `hvf` crate, `host::allocate`, `host::deallocate`, `host::leaked_bytes` and `Allocation::leak`. `cargo build -p vmm` names each one your workspace lacks; small versions are enough today, and the reference's are in the same paths for comparison. One more, the `InsnRom` trait used at the bottom of `host.rs`, belongs to chapter 06: delete that `impl` block for now.

**Step 3: make guest RAM a `GuestRam`.** Where your `run` command made chapter 03's `OwnedMapping` for `--mem` bytes, build a `GuestRam` with one region, `(GuestAddress(0x4000_0000), mem_bytes)`, and `ipa_bits` 36, then call its `map` method with your `Vm`. The reference wraps it in an `Arc` (a reference-counted pointer that several threads can share), because the vCPU thread and, later, device threads all need it:

:::code anchor=machine_guest_ram file=crates/vmm/src/machine/mod.rs

The `--raw` loader now writes through the contract, after the placement check you saw refuse the wrapped address:

:::code anchor=loader_load_raw file=crates/vmm/src/loader/plan.rs

**Step 4: answer the memory-hash call.** The run loop's debug calls gain a third one, function number `0xC600_4D03`, next to chapter 03's two. The guest passes an address in `x1` and a length in `x2`; the VMM answers `x0 = 0` and `x1` = a hash of those bytes, computed with FNV-1a (the Fowler–Noll–Vo hash, a simple 64-bit checksum), or `x0 = -2` ("invalid parameters") for a bad range. The new arm of the reference's `match`:

:::code anchor=smccc_memhash_arm file=crates/vmm/src/smccc.rs

And the function it calls:

:::code anchor=smccc_memhash file=crates/vmm/src/smccc.rs

The length cap (`MAX_MEMHASH_LEN`, 1 GiB) bounds the work, and the stop check, which asks every 64 MiB whether the VM is shutting down (for example because `--timeout` fired), means even a capped hash cannot delay the stop. If your chapter 03 VMM ends the process at the deadline instead of setting a stop flag, the cap alone is enough for now; `fnv1a` and the FNV constants are in the reference's `smccc.rs`.

Note what `--mem` is: the user's choice of how much host memory the guest may have. The guest cannot change it.

The guest side, `guests/memtest`, writes eight patterns over a 16 MiB window and reads them back, asks the VMM for the hash of the same window, then asks for a hash of a range whose end overflows:

:::code anchor=memtest_main file=guests/memtest/main.rs

Run it from inside `learner/`. If `memtest.bin` is missing, run `scripts/build-guests.sh` again from the repository root.

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/memtest.bin@0x40080000 --timeout 10; echo "exit status $?"
```

We checked this on a real Mac; the reference prints:

:::term source=captures/04-memtest-run.txt

"memhash ok" means the bytes the guest wrote are the bytes our VMM read, through two different paths; "rejects overflow ok" means `checked_add` did its job.

**Deliberate breakage 1: replace `checked_add` with `+` in `locate`.** In your `region.rs`, make the end of the range `let end = a + len;`. Predict: which contract tests fail, and what does the `memtest` guest do to your VMM? The repository builds with overflow checks on, in debug and in release. From the repository root, run `scripts/checkpoint.sh 04`:

:::term source=captures/04-break-plus.txt

What you saw: every overflow case is now a panic, and the worst line is in the middle. The `memtest` guest asked for a hash of a range whose end overflows, and the guest *crashed your VMM* (`a vCPU thread panicked`, exit 1). The misconception it exposes: "Rust panics on overflow, so it is safe." A panic a guest can trigger at will is a denial of service. Each line of the checkpoint names its stage after the level tag: `contract` (the contract tests), `run` (the runs on your Mac) and `journal`.

With overflow checks off, Rust's release default, the same edit fails differently. Run it with the two settings turned off for this one command:

:::term source=captures/04-break-wrap.txt

Read the failures as "the test asserted that `check_range` refuses the attack, and it did not": `check_range` now says *yes* to `addr = u64::MAX - 3, len = 8`. Yet `memtest` passes. The read itself was still refused, but as `OutOfBounds` by `Block::ptr`'s second check, not as `Overflow` by `locate`, so the guest saw its `-2` and was satisfied. A guest-level test cannot tell the two apart; the hostile contract tests, 37 cases that must each come back as the right value and never a panic, can. Undo the edit.

> **Under the hood.** Optional, and safe to skip. Our VMM and the guest look at the same RAM through different settings: the guest has not turned on its MMU (memory management unit, the part of the CPU that applies page tables; the `bare-metal-rust` primer, and chapter 06 shows the switch), so its data accesses are treated as Device (uncached) memory, while macOS maps ours as normal cacheable memory. They agreed in every test; why that is not automatic is the subject of the caches primer before chapter 13.

## Your turn

Before the checkpoint, check:

1. The three `LEARNER` holes are filled, and the `contract` line of `scripts/checkpoint.sh 04` (from the repository root) passes. `cargo test -p vmm` in `learner/` should pass too, but it runs only your crate's own tests.
2. The `memtest` run above prints all ten lines and `exit status 0`.
3. Your journal has the Predict entry, written before the run, and an answer to each question; question 1 is arithmetic, so do it on paper first.

Stuck? `scripts/learner hint 04` gives four hints, from a nudge to the exact reference function.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the 37 contract tests (hostile accesses against `VecMemory` and your region table, each of which must be refused without a panic, plus the little-endian round trips), runs `memtest` against your VMM, runs the same hostile cases on real `hv_vm_allocate` memory, checks your journal, and ends with `CHECKPOINT 04 PASS`. Against an unmodified copy of the reference it looks like this:

:::term source=captures/04-checkpoint.txt

What now works:

- guest RAM is a validated table of 16 KiB-aligned regions, allocated and mapped through HVF;
- every access to it, from the loader, the debug calls and, later, every device, is a bounds-checked copy that refuses overflow, zero length and region-crossing ranges without panicking;
- you can show with machine code why ordinary reads of guest RAM, and a `&[u8]` above all, make promises you cannot keep, and say what volatile gives and what it does not.

The next chapter starts from this state (the reference at the end of chapter 04).

### What's next

Chapter 05 asks what lives at the addresses that are *not* RAM. The answer is a device, and a device register cannot be a page of memory, so the guest's memory map gets holes on purpose, and a guest access to one becomes a [VM exit](/build-your-own/vmm/glossary/#vm-exit) (the guest stops and our virtual machine monitor runs) with an address we can decode.

### Open question

`--mem` decides how much host memory the guest can use, and it is the user's choice, not the guest's. Which guest actions could exhaust the host's resources without touching RAM?

## Spec hunt

- The SDK header `hv_vm.h`, the comment above `hv_vm_map`: it says "page aligned" and "a multiple of the page size". Which page size does it mean? (Hint: the VM's stage-2 granule, 16 KiB by default; `hv_vm_config.h` shows how to change it.) How did your Predict run answer what the header leaves unsaid?
- The Rust standard library documentation for `core::ptr::read_volatile`: what does it say about concurrent access from several threads, and for which kind of memory does it say volatile is meant? Does guest RAM from `hv_vm_allocate` fit that description?
- The Rust Reference, the section on integer overflow in the chapter on operator expressions: when does an overflowing `+` panic, when does it wrap, and which setting in our `Cargo.toml` changes that?
