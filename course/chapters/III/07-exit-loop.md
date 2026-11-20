---
title: The exit loop: decoding syndromes and emulating MMIO
part: III
chapter: III.2
id: 07
runs: mac+browser
minutes: 240
prereqs: [06]
start_tag: ch-06
labs: [esr-decoder, mmio-trap]
command: scripts/checkpoint.sh 07
expect: CHECKPOINT 07 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** decoding a memory-mapped I/O (MMIO) access from the syndrome alone; the frozen `Exit` enum and its decoder, which never panics; the PC-advance table (PC: program counter); register 31 as `xzr`; emulating the *access*, not the instruction; the test device and a one-entry bus; the trace's MMIO fields and the per-vCPU (virtual CPU) ring of exits.
- **Core, from earlier:** the exception class (EC), IL (instruction length), the ISS (instruction-specific syndrome) and the call-versus-retry rule (chapter 02); the run loop and exit trace (chapter 03); guest memory (chapter 04); stage-2 holes, data aborts, the DFSC (data fault status code), `classify_ipa` and the unhandled-MMIO policy (chapter 05); the register dump (chapter 06).
- **Primers (read first):** `reading-arm-specs` (a register page, the ESR's ISS tables, RES0); `aarch64-reading` (`w` and `x` registers, `xzr`, sign extension, `ldp`/`stp`, writeback forms).
- **Pointers:** the Arm Architecture Reference Manual (ARM ARM) page for `ESR_EL2`; other ISV = 0 instructions, an Aside; x86's version of this exit, an Aside.
- **Forward definitions:** the checked bus (chapter 09); `SysReg` (chapter 08); `Wfx` and `VtimerActivated` (chapter 11); `CpuOff` (chapter 20); the ISV = 0 decoder, the stage-1 walk and the `Abort` outcome (chapter 21); `Brk` (a post-v1 chapter). Each is defined at first use.
:::

At the end of chapter 05, a guest stored to an address where nothing lives, and the reference virtual machine monitor (VMM) stopped it with `unhandled MMIO write at 0xc000000 size 4` and a dump that said `SRT=9`. Its decision never looked at the guest's instruction (the `insn at pc:` line was read afterwards, for humans). So how did it know the store was 4 bytes wide, from register 9? And once we answer that store instead of stopping, what else must we do before the guest can carry on?

This chapter works on row 3 of chapter 00's problem ledger, devices at fixed physical addresses: chapter 05 left holes in stage 2, and now something answers in them; chapter 09 closes it. Sitting A decodes the hardware's note in the browser and host-only tests (about 1.5 hours); sitting B emulates the access on your Mac (about 2.5 hours).

:::predict In sitting B your VMM will emulate stores to a device. Suppose you comment out the line that moves the guest's PC (program counter, the address of the instruction it runs) past an emulated store. Will the guest (a) crash, (b) take the same exit forever, or (c) skip the store and carry on? Use your exit cost from chapter 03 (ours was about 1.4 µs): how many exits per second do you expect?
Write it under `## Predict` in your journal. Sitting B runs it as the first deliberate break.
:::

:::objectives
- (Sitting A) Decode any `ESR_EL2` value into the ten-variant `Exit` enum, with a decoder that never panics for any 64-bit input.
- (Sitting A) Decode a data-abort syndrome by hand into its six fields, and name a guest instruction that produces it.
- (Sitting B) Emulate a data abort with ISV = 1: mask a write, sign-extend a read, treat SRT = 31 as `xzr` (never `sp`), then advance the PC by 4.
- (Sitting B) For ISV = 0, stop with a fatal error that prints the instruction word, not a guess.
- (Sitting B) Fill the trace's MMIO fields, keep a ring of the last 256 exits per vCPU, and predict, then observe, what a missing PC advance does.
:::

**Before you start.** Run `scripts/learner start 07` from the repository root to copy this chapter's journal to `learner/journal/07.md`. Work in `learner/` and run from inside it. Each block's lead-in says whether to type it, check yours against it, or read it and write your own.

## The note the hardware leaves

The guest ran `str w2, [x1]`, and `x1` pointed at a hole, so the CPU took a [data abort](/build-your-own/vmm/glossary/#data-abort) to EL2 (exception level 2, where the hypervisor runs). Before handing us the exit, the hardware wrote a note in the syndrome: this was a write ([**WnR**](/build-your-own/vmm/glossary/#wnr), write not read), of 4 bytes ([**SAS**](/build-your-own/vmm/glossary/#sas), syndrome access size), from register 2 ([**SRT**](/build-your-own/vmm/glossary/#srt), syndrome register transfer), a 32-bit register ([**SF**](/build-your-own/vmm/glossary/#sf), sixty-four-bit flag, here 0); and for loads, whether to sign-extend the value ([**SSE**](/build-your-own/vmm/glossary/#sse), syndrome sign extend). One more bit, [**ISV**](/build-your-own/vmm/glossary/#isv) (instruction syndrome valid), says whether the note was written at all.

With that note, our VMM can do the store for the guest without looking at the instruction.

> **Aside.** x86 is less helpful. On Intel the matching exit (an EPT violation, EPT being extended page tables, or, for the MMIO pages of Linux's KVM, the Kernel-based Virtual Machine, an EPT misconfiguration; on AMD a nested page fault) gives the address and access type but not the register or size, so the VMM decodes the instruction itself. See the [Intel Software Developer's Manual](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html), volume 3.

The fields live in the ISS, the low 25 bits of the syndrome you split in chapter 02. `ESR_EL2` is 64 bits wide; we ignore the bits above 31, but the decoder must accept any value. Open the [ARM ARM](https://developer.arm.com/documentation/ddi0487/latest) (document DDI 0487) at the register page **ESR_EL2**, "ISS encoding for an exception from a Data Abort", as the `reading-arm-specs` primer showed you. The bits we use:

| Bits | Field | Meaning |
|---|---|---|
| 24 | ISV | 1: bits 23 to 14 describe the access |
| 23:22 | SAS | size: `1 << SAS` bytes (0 is 1 byte, 3 is 8 bytes) |
| 21 | SSE | a load must be sign-extended |
| 20:16 | SRT | the register loaded or stored; 31 means `xzr` |
| 15 | SF | 1: a 64-bit `x` register; 0: a 32-bit `w` register |
| 6 | WnR | 1: write (store); 0: read (load) |
| 5:0 | DFSC | data fault status code (chapter 05): `0x4` to `0x7` are translation faults at levels 0 to 3; our holes show `0x6`, level 2 |

The code also decodes AR (bit 14, acquire/release ordering), FnV (bit 10, fault address not valid) and S1PTW (bit 7, the fault hit the guest's own stage-1 page-table walk); only S1PTW matters today.

Put the story's values in and the syndrome falls out:

```text
 31     26 25 24 23 22 21 20    16 15        6 5     0
+---------+--+--+-----+--+--------+--+ ... +--+-------+
| 100100  | 1| 1| 10  | 0| 00010  | 0|     | 1| 000110|
+---------+--+--+-----+--+--------+--+ ... +--+-------+
  EC 0x24  IL ISV SAS=2 SSE SRT=2  SF       WnR DFSC 0x6
  = 0x93820046
```

*`str w2, [x1]` into a stage-2 hole: every field but the base register is in the note.*

Check it against chapter 05's stop, `esr=0x93890046`. Only bits 20 to 16 differ: SRT is 9, so the store came from `w9`. That dump's `insn at pc: 0xb9000109` is `str w9, [x8]`, and `x8` held `0xc000000`: note and instruction agree. That answers the opening question: the hardware wrote it down.

In the decoder, toggle ISV, change SAS, set SRT to 31.

:::lab esr-decoder

If the lab does not load, do the same on paper: decode `0x93890046` and `0x92000046` with the table above. Sitting A's host tests check both answers.

## When the note is blank: ISV = 0

The note has room for one register number and one size. `ldp x0, x1, [x2]` loads *two* registers, so it leaves ISV = 0. A writeback form (`ldr x0, [x1], #8`) has one data register, but it also changes its base register, and the note has no room to say so; it gives ISV = 0 too. So do other instructions the ARM ARM leaves out of the note (exclusives, atomics, vector loads). With ISV = 0, bits 23 to 14 are RES0 (the primer's word: reserved, with no meaning you may rely on): SAS, SSE, SRT and SF carry no information and must not be used.

> **Aside.** ISV = 0 also comes from exclusives (`ldxr`, `stxr`), atomics (`ldadd`, `cas`), SIMD (single instruction, multiple data) and floating-point loads and stores (`ldr q0`), and `DC ZVA`, which zeroes a block; the same ARM ARM page lists them. Chapter 21 emulates pairs and writeback forms and refuses the rest.

So what should our VMM do with ISV = 0? The tempting answer is to guess: 8 bytes, from the register in SRT. Sitting B's optional third break lets you see what the guess does. This chapter's rule: stop with a fatal error that prints the instruction word, as the reference's dump does. A human can decode the word; a guess hides the problem.

## One enum for every exit

From now on, every return from `hv_vcpu_run` becomes one value of a single enum. Its shape is frozen: later chapters and the contract tests use it exactly as shown, so new behaviour goes into handlers, never new variants.

Open `learner/crates/vmm/src/arch/esr.rs`; chapter 05's field helpers, `DataAbort` struct and `decode_data_abort` stay as they are. The file stays pure (no framework calls), so it runs in host-only tests. Type its top, which denies three Clippy lints, unchecked arithmetic, indexing and truncating casts, the usual ways to panic:

:::code anchor=esr_lints file=crates/vmm/src/arch/esr.rs

Type the enum. Each variant is named after what the guest did:

:::code anchor=exit_enum file=crates/vmm/src/arch/esr.rs

The decoder knows them all, so nothing is silently misread, though some wait several chapters for a handler:

| Variant | Exception class | Handled now? |
|---|---|---|
| `Canceled` | (our own stop, chapter 03's `--timeout`) | yes: re-check the stop flag |
| `Hvc`, `Smc` | `0x16`, `0x17` | yes: chapter 03's debug calls |
| `DataAbort` | `0x24` | yes: this chapter |
| `InstructionAbort`, `Unknown` | `0x20`, anything else | yes: a fatal stop with the dump |
| `SysReg` | `0x18`, a trapped system register access | stop until chapter 08 |
| `Wfx`, `VtimerActivated` | `0x01` ("wait for interrupt or event"), the timer | stop until chapter 11 |
| `Brk` | `0x3c`, a breakpoint instruction | stop (a debugger stub in a post-v1 chapter would handle it) |

*The variants not handled yet stop the virtual machine (VM) with a message naming them.*

Already in your file from chapter 05; check that your data-abort decoder masks every field to its width, ISV or not:

:::code anchor=esr_decode_data_abort file=crates/vmm/src/arch/esr.rs

A trapped system register has its own ISS layout, which chapter 08 explains. The `SysReg` variant needs it now; type it (`encoding` can wait for chapter 08):

:::code anchor=esr_sysreg_access file=crates/vmm/src/arch/esr.rs

:::code anchor=esr_decode_sysreg file=crates/vmm/src/arch/esr.rs

The decoder's arms name classes from a small `pub mod ec` of `u8` constants (`WFX = 0x01`, `HVC64 = 0x16`, `SMC64 = 0x17`, `SYSREG = 0x18`, `IABT_LOWER = 0x20`, `DABT_LOWER = 0x24`, `BRK64 = 0x3c`). Add it at the top of the file, and fill in chapter 06's `ec_name` rows for the same classes. Then type the decoder, and `from_hv`, which combines chapter 02's exit reason with the syndrome; your run loop now calls it instead of its own `match`:

:::code anchor=esr_decode file=crates/vmm/src/arch/esr.rs

Give `Exit` and `DataAbort` a one-line `Display`, such as `data abort (EC 0x24): ISV=1 SAS=2 (4 bytes) ...`; the contract tests check that it never prints a control character.

> **Security.** The syndrome describes a hostile guest, so a decoder panic would let any guest kill the VMM on purpose; the checkpoint feeds it a million random values. Hence the three lints, and an `Unknown` that keeps the raw syndrome.

Test it on the host before you stop, with `cargo test -p vmm esr` inside `learner/`. Start with `0x93820046`, the story's store, and `0x92000046`, which should give a `DataAbort` with ISV = 0, WnR = 1 and DFSC `0x6`.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 2.5 hours.

## Emulating the access

Notice that we never decode the instruction. The hardware did; we only perform the access it described, using the note plus the exit's IPA (intermediate physical address, chapter 05). A size is one of four widths, so it gets an enum, `AccessSize`, with a `mask()` for the low bytes. Create `learner/crates/vmm/src/bus.rs` (declare it with `pub mod bus;` in `lib.rs`) and type:

:::code anchor=access_size file=crates/vmm/src/bus.rs

`from_sas` uses only the low two bits, so every syndrome gives a size. Type the access, in `vcpu/mmio.rs`:

:::code anchor=mmio_access_struct file=crates/vmm/src/vcpu/mmio.rs

For a store, building it reads the source register at once. Two lines carry the rules: register 31 reads as zero, and the value is masked to the access size, so a `strb` sends only its low byte. Type:

:::code anchor=mmio_from_data_abort file=crates/vmm/src/vcpu/mmio.rs

Why special-case 31? In Hypervisor.framework's numbering, `hv_reg_t` 0 to 30 are `x0` to `x30` and **31 is `HV_REG_PC`**. Check the SDK (software development kit) header:

```sh
grep -n HV_REG_PC "$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/hv_vcpu_types.h"
```

An SRT passed through unchanged would reach the guest's PC. Make your `hvf` wrapper refuse 31 too, so that a slip that goes through `Reg::x` cannot reach the PC; type this:

:::code anchor=reg_x_xzr file=crates/hvf/src/regs.rs

Route your `Vcpu`'s accessors in `vcpu/mod.rs` through it. `x(31)` reads 0 and `set_x(31, _)` throws the value away, which is what makes `ldr xzr` safe. Type:

:::code anchor=vcpu_regs_xzr file=crates/vmm/src/vcpu/mod.rs

For a load, `ldrsh` of `0x8001` puts `0xffff8001` in a `w` register and `0xffffffffffff8001` in an `x` register, because writing a `w` register clears the upper 32 bits. Type:

:::code anchor=mmio_sign_extend file=crates/vmm/src/vcpu/mmio.rs

Give `MmioAccess` one more method, `load_result(v)`, which the handler below calls: one line that returns `sign_extend(v, self.size, self.sign_extend, self.sixty_four)`.

## A device that remembers

To test a decoder you want a device that cannot surprise you. The [**test device**](/build-your-own/vmm/glossary/#test-device) (`--testdev`) is 512 scratch registers of 8 bytes at `0x0b00_0000`: a read returns what was last written there, cut to the access size, so any wrong value is the decoder's fault.

A device answers `read(offset, size)` and `write(offset, size, value)`, the offset relative to its base. Type the trait into `bus.rs` exactly as shown; later chapters and the checkpoint use this signature:

:::code anchor=mmio_device_trait file=crates/vmm/src/bus.rs

`Send` lets a device move between threads (chapter 20). The device lives in `learner/crates/vmm/src/devices/testdev.rs` (declare it with `pub mod testdev;` in `devices/mod.rs`). `TestDev` holds `regs: Box<[u64; TESTDEV_REGS]>`, with `TESTDEV_REGS = 512` and a `new()` that zeroes them. `TESTDEV_SIZE` is `512 * 8`, and the base is `TESTDEV_BASE` from your `layout.rs`, the `testdev` row of chapter 05's table. Type its two methods:

:::code anchor=testdev_access file=crates/vmm/src/devices/testdev.rs

`locate` is your helper: it accepts an offset only if it is a multiple of the access size and inside the 4 KiB window, and returns the slot (`offset / 8`) and the bit shift inside it (`(offset % 8) * 8`). A misaligned access reads as zero and is reported, but only a few times, because the guest decides how often it happens.

## A bus with one entry

Our VMM finds the device through the [**bus**](/build-your-own/vmm/glossary/#mmio-bus), a table from address windows to devices. Today it has one entry, so the smallest bus that works will do; chapter 09 replaces its insides and keeps every name below. Add to `bus.rs`:

- `BusError`: `Unmapped { ipa }`, no window contains the address; `Straddle { ipa, size }`, the access runs past its window's end. Add `Bus(BusError)` to your crate's `Error`.
- `Bus`, a `Vec` of entries: a name (`&'static str`), a base, a size and the device as `Arc<Mutex<dyn MmioDevice>>`. The mutex is there because handlers get `&Bus`, yet a write changes the device; your chapter 04 `lock` helper takes it. Give it `new()`.
- `insert(name, base, size, dev) -> Result<(), BusError>`, which pushes and always returns `Ok` for now.
- `device_at(ipa) -> Option<(&'static str, u64)>`: the first entry with `base <= ipa < base + size` (end by `checked_add`), its name and the offset.
- `read(ipa, size) -> Result<u64, BusError>` and `write(ipa, size, value) -> Result<(), BusError>`: find the entry (none: `Unmapped`), refuse with `Straddle` if the access passes the end, lock the device, call it with the offset, and mask with `size.mask()`.

Read the reference's `read` and `write`, then write your own from the bullets (its `route` is the lookup plus the straddle check):

:::code anchor=bus_dispatch file=crates/vmm/src/bus.rs

Then wire the bus in, in three places.

First, give `classify_ipa` a `bus: &Bus` parameter and add the `Device { name, offset }` variant to `IpaClass`; ask the bus between the RAM check and the board map. Check yours against the reference's:

:::code anchor=mmio_classify_ipa file=crates/vmm/src/vcpu/mmio.rs

Second, the handlers receive the bus in `ExitEnv`, a struct of references every handler takes, in `vcpu/exit.rs`. If yours still take guest memory and the policy as separate arguments, bundle them now: `mem: &'a dyn GuestMemory`, `bus: &'a Bus`, `unhandled_mmio`, plus whatever your `hvc` handler uses.

Third, your run configuration (the reference's `VmConfig`) gets a `testdev: bool`, set by a new `--testdev` flag. Register the device only when it is set, so earlier guests still see a hole. Type:

:::code anchor=testdev_register file=crates/vmm/src/machine/virt.rs

Create the bus in your VM setup, call `register_devices` before the first vCPU runs, and put `&bus` in the `ExitEnv`.

## The handler and the PC-advance table

The handler fills trace fields that chapter 03's `ExitRecord` lacks: add `wnr`, `size`, `reg`, `value` and `isv` now, as `Option`s (`bool`, `u8`, `u8`, `u64`, `bool`), and an `Action::Mmio` variant. It returns an `MmioOutcome`: `Done`, or `Fatal(String)` with the reason.

The handler first checks S1PTW: a guest page-table walk that hit a hole is fatal. It asks our own map what lives at the IPA (`classify_ipa`), never the fault code, which says *how* stage 2 failed, not *what* is there. A stage-2 fault inside RAM means our own mapping is wrong (chapter 04 maps all of RAM), so it stops. Then it builds the access, sends it to the bus, and writes a load's result. Type it, except the `isv0` call:

:::code anchor=mmio_handle file=crates/vmm/src/vcpu/mmio.rs

The `isv0` call is chapter 21's decoder. Your `else` branch returns `MmioOutcome::Fatal` with the message `data abort with ISV=0 at IPA <ipa> pc <pc>: the syndrome does not describe this access; not emulated`.

The block stops after the success arm. The other arm, an unclaimed or straddling access, goes to chapter 05's unhandled-MMIO policy. Now replace chapter 05's `log policy needs chapter 07` stop: for a load, `set_x(reg, 0)`; for a store, nothing; then return `Done` so the PC advances. Check it from `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/mmio-poke.bin@0x40080000 --timeout 10 --unhandled-mmio log
```

You should see what chapter 05 showed from the reference:

:::term source=captures/05-poke-log.txt

**Print the instruction word.** The ISV = 0 stop promises the word, so add it to your dump: `mem.read_u32(GuestAddress(pc))`, chapter 04's helper, treating the PC as an IPA. That holds for every guest so far, and for this chapter's ISV = 0 guest, whose code is identity-mapped. Print `insn at pc: 0x` and eight hex digits (`{:#010x}`), or `insn at pc: not readable` if the read fails. Chapter 21 adds the stage-1 walk for code that is not identity-mapped.

Who moves the PC? Chapter 02's rule: an executed call continues; a fault or an intercepted instruction (like `smc`) retries. Per exit, that is the [**PC-advance table**](/build-your-own/vmm/glossary/#pc-advance-table):

| Exit | Saved PC points | The VMM, after handling it |
|---|---|---|
| `Hvc` | after the `hvc` | leaves the PC alone |
| `Smc` | at the `smc` (intercepted before it ran) | adds 4 |
| `DataAbort`, emulated | at the load or store (a fault) | adds 4 |
| `Canceled` | wherever the guest was | leaves it alone |
| a fatal stop | at the instruction | nothing: the VM stops |

The dispatcher in `learner/crates/vmm/src/vcpu/exit.rs` follows the table. Type its first arms, leaving out the `Abort` arm:

:::code anchor=exit_dispatch_head file=crates/vmm/src/vcpu/exit.rs

`Abort` tells the guest its access failed, as real hardware would; chapter 21 adds it, so your `DataAbort` arm has two cases. In yours, `Wfx`, `VtimerActivated` (chapter 11), `SysReg` (chapter 08), `InstructionAbort`, `Brk` and `Unknown` share one fatal arm.

The advance is one register write. Every AArch64 instruction is 4 bytes, as the IL bit from chapter 02 promises; the open question asks what if it did not:

:::code anchor=vcpu_advance_pc file=crates/vmm/src/vcpu/mod.rs

## Remembering the last 256 exits

A data-abort record gains seven fields: `ipa`, from the exit, and the handler's `wnr`, `size`, `reg`, `value` (the masked value written or the sign-extended value loaded), `action` (`"mmio"`, or `"stop"`) and `isv`. The keys come in this order, with no spaces: `t_ns`, `vcpu`, `reason`, `ec`, `pc`, `ipa`, `wnr`, `size`, `reg`, `value`, `action`, `isv`. Addresses and values are `"0x..."` strings; `size` and `reg` are plain numbers; `wnr` and `isv` are JSON (JavaScript Object Notation) booleans. A field that is `None` is left out, so a stopped ISV = 0 access has only `ipa`, `action` and `isv` (a stopped ISV = 1 one keeps `wnr`, `size`, `reg`).

A new filter, `--trace exits:FILE:mmio`, keeps only data-abort records; implement it beside chapter 03's `:hvc`.

A trace file only helps if you asked for it before the crash, so every vCPU also keeps an [**exit ring**](/build-your-own/vmm/glossary/#exit-ring) of its last 256 records. Type:

:::code anchor=exit_ring file=crates/vmm/src/trace.rs

A fatal stop prints the last 32. Here is chapter 03's run loop as the reference has it now:

:::code anchor=run_loop file=crates/vmm/src/vcpu/run_loop.rs

New: `log.ring.push(rec)` after the trace, and `g.last_exits` in the fatal arm, which attaches 32 records to the stop. Call your own `handle` where it calls `handle_watched` (a later hook), and leave out `log.stats` (chapter 11), `generation` and the `CpuOff` arm (chapter 20, where a vCPU powers itself off). Print the stop's records after the dump as `last exits: N (oldest first)`, then each record on its own line, indented two spaces; the checkpoint looks for `last exits:`.

Chapter 06's `self-fault` now ends with the ring: the `DEBUG_PUTC` calls that printed its message, then the fatal abort with `"action":"stop"`. Its PC, `0x200`, is not RAM, so its word is not readable:

:::term source=captures/07-self-fault.txt

## The run

`guests/mmio-probe` makes ten checks against the test device, each access in assembly so the note is exactly the one named: four sizes, write masking, `xzr` both ways, and three sign extensions. Run it from `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --testdev --raw $G/mmio-probe.bin@0x40080000 --trace exits:t.jsonl:mmio --timeout 10
```

Our capture is from the checkpoint harness (`{guests}` is that folder, `{out}` a scratch one):

:::term source=captures/07-mmio-probe.txt

One record per access; your `t_ns` and `pc` will differ slightly:

:::term source=captures/07-mmio-probe.trace.jsonl

Read two. The thirteenth, `"wnr":true,"size":8,"reg":31,"value":"0x0"`, is `str xzr`: an 8-byte store of zero. The twentieth, `"wnr":false,"size":2,"reg":3,"value":"0xffffffffffff8001"`, is `ldrsh x3`: two bytes, sign-extended. Each exit is a round trip through macOS, about 1.4 µs by chapter 03's measure, against under a nanosecond for a store to RAM; that is why Part VII's virtio devices share memory and exit once per batch.

Here are the guest's two `xzr` checks. The `ldr xzr` one compares the stack pointer before and after, to catch a VMM that maps 31 to `sp`. `store!` and `load!` are the probe's macros, each wrapping one `asm!` instruction; `in(reg)` lets the compiler pick the address register:

:::code anchor=mmio_probe_xzr file=guests/mmio-probe/main.rs

The emulator below steps through the same path: exit record, decode, device, PC.

:::lab mmio-trap

If the lab does not load, take the trace's twentieth record and write the steps on paper: the exit record, the decode (SAS, SSE, SRT, SF, WnR), the device read at offset `0x28`, the register value after sign extension, then PC + 4.

## The blank note, on your Mac

`guests/isv0-probe` belongs to chapter 21: it turns on its own stage-1 page tables (its MMU, memory management unit), then makes pair and writeback accesses to the test device. Chapter 21 needs the MMU to test aliases; for us it changes nothing except that the PC is a virtual address, identity-mapped here. Run it from `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --testdev --raw $G/isv0-probe.bin@0x40080000 --timeout 10
```

Our capture is from a copy of the reference with its chapter 21 decoder replaced by this chapter's stop:

:::term source=captures/07-isv0-stop.txt

Exit code 3; the reason names ISV = 0, the IPA and the PC. Ignore SAS, SRT and SF on the second line: with ISV = 0 they are RES0 and mean nothing. The word `0xa9002909` is `stp x9, x10, [x8]`, and `x9` and `x10` hold the two values to store. Everything a human needs, and no guess.

## Breaking it on purpose

Two breaks, each predicted first, and an optional third; undo each before the next. Our runs come from edited copies of the reference, so their commands say `target/guests/...`. From `learner/`, set `G` first:

```sh
G=../target/guests/aarch64-unknown-none/release
```

**Deliberate breakage 1: delete the PC advance.** In your dispatcher's data-abort arm, return `Resume { advance_pc: false }`. This is the page's Predict: check your journal, then run:

```sh
cargo run -q -p macvmm -- run --mem 64M --testdev --raw $G/mmio-probe.bin@0x40080000 --trace exits:t.jsonl:mmio --timeout 2
```

:::term source=captures/07-no-advance.txt

No output, then the timeout (exit code 5). Read the trace's ends and length:

```sh
head -n 3 t.jsonl; tail -n 1 t.jsonl; wc -l < t.jsonl
```

:::term source=captures/07-no-advance-trace.txt

The same `strb` exit, 324,719 times in two seconds, only `t_ns` growing: a data abort's saved PC is the faulting instruction (chapter 02's retry rule), so the guest retries forever.

What you saw: (b). The misconception: "the hardware moves the PC", true only for calls. The tool: the trace, where identical records with growing `t_ns` mean a loop. About 160,000 exits per second, not the 700,000 that 1.4 µs suggests; probably mostly the trace, since each record is a formatted file write. The trace is tens of megabytes: `rm t.jsonl`.

**Deliberate breakage 2: treat SRT = 31 as a real register.** In your `Reg::x`, change `n <= 30` to `n <= 31`, and in `from_data_abort` remove the `reg == 31` test. Predict which checks fail, and the first failure's "got" value. Run `mmio-probe` without the trace:

:::term source=captures/07-xzr-as-register.txt

`str xzr` stored `0x400811dc`, its own address: register 31 in `hv_reg_t` is the PC. Then `ldr xzr` loaded `0x1111` *into the PC*, we added 4, and the guest landed at `0x1115`. Its own handler reported a PC alignment fault (EC `0x22`; `kind=4` is its label for a synchronous exception at EL1), and it exited with failure, our exit code 6 (chapter 03).

What you saw: a zero turned into an address, then a jump. The misconception: "register 31 is a register". The tool: a probe in which each check isolates one field.

**Deliberate breakage 3 (optional): emulate ISV = 0 by guessing.** In your ISV = 0 `else` branch, build the access as if the note were valid: 8 bytes, a 64-bit register, whatever SRT holds. Rerun `isv0-probe` (a "stage-1 alias" is the device through a second virtual address). Predict: crash, or not?

:::term source=captures/07-isv0-guess.txt

Exit code 0 says nothing; read the lines. Ignore the last, the SIMD store (chapter 21). The other sixteen are all wrong. SRT read 0 on this Mac: with ISV = 0 the field is RES0, so whatever it holds means nothing, and here it happened to be 0. So stores wrote `x0`, and loads went to `x0`.

What you saw: silent corruption that only the guest's checks noticed. The misconception: "MMIO emulation means emulating instructions", or guessing them. The tool: this chapter's rule, stop and print the word. Undo the edit.

## Your turn

Before the checkpoint, check:

1. `cargo test -p vmm` passes in `learner/`, including your own test that `Exit::decode` returns something for `0`, `u64::MAX` and a few values in between.
2. The `mmio-probe` command from "The run" prints `mmio-probe: 10/10 ok`.
3. The `isv0-probe` command exits with code 3; standard error starts `macvmm: guest fatal: data abort with ISV=0`, and the dump includes an `insn at pc:` line.
4. Your journal has the Predict entry, written before breakage 1.

Stuck? `scripts/learner hint 07` gives four graded hints.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (about 70 syndromes with expected decodes, plus the million-value sweep), runs `mmio-probe` and checks its output and trace, re-runs `self-fault` looking for `last exits:`, and checks your journal. Ours ran against the reference, so its journal line says "not checked":

:::term source=captures/07-checkpoint.txt

What now works:

- every exit becomes one `Exit` value, from a pure decoder that cannot panic;
- a guest can load and store to a device at four sizes, with sign extension and `xzr`, and carry on;
- an access the hardware could not describe stops the VM with the instruction word;
- the trace records each access, and a fatal stop shows the exits that led to it.

The next chapter starts from this state (tag `ch-07`, the reference at the end of chapter 07).

### What's next

A guest kernel also touches system registers, and Hypervisor.framework forwards some of those accesses: chapter 08 decides what to answer, injects the exception real hardware would raise for a register we lack, and gives the guest a standard way to power off.

### Open question

After emulating a store, you advance the PC by 4. What does the IL bit tell you, and what would you do if it ever said the instruction was 16 bits long?

## Spec hunt

- ARM ARM (DDI 0487), register page **ESR_EL2**, "ISS encoding for an exception from a Data Abort": in which cases does the manual say ISV is 0, and which of them could a guest kernel reach by accident?
- The same page, the description of **IL**: for which exception classes is IL fixed at 1, and when can it be 0?
- The software development kit (SDK) header `hv_vcpu_types.h`, the `hv_reg_t` enumeration: which values follow `HV_REG_PC`, and which of them could a 5-bit SRT field never name? Why is 31, and only 31, the dangerous number?
