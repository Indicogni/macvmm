---
title: vCPU state: registers, PSTATE and reset
part: III
chapter: III.1
id: 06
runs: mac+browser
minutes: 120
prereqs: [05]
start_tag: ch-05
labs: [pstate-builder]
command: scripts/checkpoint.sh 06
expect: CHECKPOINT 06 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** PSTATE and SPSR (saved program status register) in full (`M[3:0]` with the stack-pointer select bit, the DAIF mask bits, the condition flags); `SCTLR_EL1` (its M, C, I and A bits); `MPIDR_EL1` and why bit 31 is set; alignment faults; the reset state of a CPU versus a system reset; the register dump as a diagnostic tool, and reading a first fault behind a second one.
- **Core, from earlier:** the exception model, the vector table and routing to EL1 versus EL2 (chapter 02); reading `0x3c5` with a field table (chapter 02); the run loop, `--raw`, `--timeout` and the address size fault (chapter 03); instruction aborts, data aborts, the fault status code and stage-2 holes (chapter 05).
- **Primers (read first):** `arm64-boot-protocol` (only the CPU state at entry: the registers, DAIF, the MMU (memory management unit) and the caches).
- **Primers (review):** `page-tables` (what turning the MMU on means).
- **Pointers:** two PSTATE flags we never use, PAN (privileged access never) and TCO (an Aside); the caches primer, before chapter 13.
- **Forward definitions:** the device tree address in `x0` (chapter 10); the virtual counter offset (chapter 11); the ring of last exits (chapter 07); a system reset requested through PSCI, the power state coordination interface (chapter 08); the interrupt controller's per-CPU part, the redistributor (chapter 12). Each is defined in a sentence where it first appears.
:::

Your test guest lives at `0x4008_0000`. It never jumps anywhere near address `0x200`. Yet in this chapter your virtual machine monitor (VMM) will stop it with "instruction abort at pc 0x200", and every word of that report will be true. Chapter 02's guest died the same way, and there we reasoned the cause out by hand; this time the VMM will print the evidence. First, an older question: what has to be true about a CPU before it starts running someone else's code correctly?

:::predict At the end of this chapter you run a guest called `self-fault`. It turns on alignment checking and then loads 8 bytes from an address that is not a multiple of 8. Will your VMM report (a) an alignment fault, or (b) something else?
Write your choice and one sentence of reasoning under `## Predict` in your journal. The section "A guest that faults inside itself" runs it.
:::

This chapter applies row 1 of the problem ledger, the CPU: chapter 02's exception model now explains a crash that happens inside the guest, where we cannot see it directly.

:::objectives
- Build PSTATE and SPSR values bit by bit (`M[3:0]`, DAIF, the stack-pointer select bit) and name the mode that `0x3c5`, `0x3c4` and `0x3c9` encode.
- Implement `Vcpu::create`, which writes `MPIDR_EL1`, and `Vcpu::reset(&BootParams)`, which sets the PC (program counter), `x0` to `x3`, CPSR, and `SCTLR_EL1` with the MMU (memory management unit) and caches off.
- Print a register dump when the guest stops on a fatal exit, and use it to find the *first* fault of a guest that faulted inside itself and then faulted again on its missing vector table.
:::

**Before you start.** Run `scripts/learner start 06`, which copies this chapter's journal to `learner/journal/06.md`. This chapter has no starter files: you create `vcpu/regs.rs` and `vcpu/dump.rs` yourself. The lesson shows the reference's code for most of the chapter and explains each piece; you write the PSTATE `Display`, the extra `SysReg`s and the fatal stop on your own. `scripts/learner hint 06` is there when you are stuck.

## What a CPU needs to know before it runs

You are handing a CPU to a stranger's program. Before reading on, list what you must decide first.

Most lists hold four things, each a register on Arm:

| Question | Register | Our answer for virtual CPU (vCPU) 0 |
|---|---|---|
| Which instruction runs first? | the PC | the guest's entry, `0x4008_0000` |
| At which level, on which stack, with what masked? | PSTATE (Hypervisor.framework, HVF, calls it `CPSR`) | `0x3c5`: EL1, its own stack, everything masked |
| Which CPU am I? | `MPIDR_EL1` | `0x8000_0000` |
| Is address translation on? Are the caches on? | `SCTLR_EL1` | both off |

Together these values are the CPU's [**reset state**](/build-your-own/vmm/glossary/#reset-state): the register values a CPU has when it is powered on or restarted. `Vcpu::reset` recreates it for a vCPU. Do not confuse it with a [**system reset**](/build-your-own/vmm/glossary/#system-reset), which a guest requests through PSCI, the power state coordination interface (chapter 08), and which leads to a reset state on every vCPU. Ours is always a cold start, as if from power-on.

## PSTATE, bit by bit

Chapter 02 read `0x3c5` from a table. Now you build such values yourself. PSTATE (processor state) is the CPU's current mode and flags. When an exception is taken, the CPU saves a snapshot of it in an SPSR (saved program status register), in this layout, and HVF shows the current value to us in the same layout under the name `CPSR` (current program status register):

```text
 31 30 29 28        9   8   7   6   5   4   3  2   1   0
+--+--+--+--+ ... +---+---+---+---+---+---+------+---+---+
| N| Z| C| V|     | D | A | I | F | 0 |nRW|  EL  | 0 |SP |
+--+--+--+--+ ... +---+---+---+---+---+---+------+---+---+
 condition flags   the DAIF masks          M[3:0]: mode
```

*PSTATE in SPSR layout. The low four bits, `M[3:0]`, say where the CPU runs; bits 9 to 6 say which exceptions it holds off.*

| Bits | Field | Meaning |
|---|---|---|
| 31 to 28 | N, Z, C, V | condition flags set by comparisons (negative, zero, carry, overflow) |
| 9 to 6 | D, A, I, F | 1 masks that kind of exception: hardware debug exceptions (D: breakpoints and watchpoints set in the debug registers, and single-step; the `brk` instruction is never masked), and three asynchronous ones: SError (system error, A), IRQ (interrupt request, I), FIQ (fast interrupt request, F) |
| 4 | nRW | 0 means 64-bit execution (AArch64); we never run 32-bit guests |
| 3 to 2 | EL | the exception level, 0 to 3 |
| 0 | SP | the stack-pointer select bit ([SPSel](/build-your-own/vmm/glossary/#spsel) in the Arm manual): 0 uses `SP_EL0`, 1 uses the current level's own stack pointer |

Build `0x3c5` from the fields, one step at a time:

1. Mask all four kinds: D, A, I and F are bits 9, 8, 7 and 6, so `0x200 + 0x100 + 0x80 + 0x40 = 0x3c0`.
2. Run at EL1: 1 shifted into bits 3 to 2 is `1 << 2 = 0x4`.
3. Use EL1's own stack pointer, `SP_EL1`: bit 0, `0x1`.

So `0x3c0 | 0x4 | 0x1 = 0x3c5`, written **EL1h** ("h" for handler stack). Change only step 3 and you get `0x3c4`, [**EL1t**](/build-your-own/vmm/glossary/#el1t) ("t" for thread): still EL1, but `sp` in the guest's code now means `SP_EL0`, the stack EL0 apps use. Put 2 in the EL field instead and you get `0x3c8 | 0x1 = 0x3c9`, EL2h, a level our guests are not offered (chapter 02's Aside); `hv_vcpu_run` refuses that state with `HV_ILLEGAL_GUEST_STATE` before the CPU sees it. You will run the `0x3c4` mistake later in this chapter.

Two facts make the guest's own view match ours. `mrs x0, daif` (`mrs` reads a system register into a general register; the `aarch64-reading` primer) reads the same bits 9 to 6, so a guest started with `0x3c5` reads `DAIF = 0x3c0`. And `mrs x0, CurrentEL` puts the level in bits 3 to 2, so EL1 reads `0x4`.

Toggle the bits yourself in the builder:

:::lab pstate-builder

If the lab does not load, three rows carry the idea:

```text
value    M[3:0]   mode   stack pointer   masked
0x3c5    0101     EL1h   SP_EL1          D A I F
0x3c4    0100     EL1t   SP_EL0          D A I F
0x3c9    1001     EL2h   SP_EL2          D A I F
```

Write the bit constants in your `learner/crates/vmm/src/arch/regs.rs`, checking each against the table above. The reference's:

:::code anchor=pstate_bits file=crates/vmm/src/arch/regs.rs

Decoding reads the table backwards; the dump uses this decoder to print `(EL1h, DAIF, nzcv)` after a CPSR value:

:::code anchor=pstate_decode file=crates/vmm/src/arch/regs.rs

The `Display` implementation below it prints `MODE, DAIF, NZCV`, each letter upper case when its bit is set: `0x3c5` prints `EL1h, DAIF, nzcv` and `0xf0000004` prints `EL1t, daif, NZCV`. Write your own; the contract tests check the mode names `EL0t`, `EL1t`, `EL1h`, `EL2h` and `AArch32` (bit 4 set) and three exact `Display` strings.

## Which CPU am I: `MPIDR_EL1`

An operating system tells its CPUs apart by one number each, [**`MPIDR_EL1`**](/build-your-own/vmm/glossary/#mpidr-el1), the Multiprocessor Affinity Register: a kernel says "start CPU 2" with it, and the interrupt controller routes by it. Our guests' start code reads it first thing, to pick a stack.

The low bits hold [**affinity**](/build-your-own/vmm/glossary/#affinity) fields, a CPU's address in a hierarchy: `Aff0` (bits 7 to 0) numbers CPUs within a cluster, `Aff1` (bits 15 to 8) numbers clusters (a cluster is a group of cores that share hardware such as a cache). Bit 31 is defined as always 1 by the architecture, which the Arm manual writes as [**RES1**](/build-your-own/vmm/glossary/#res0-res1) (reserved, reads as one). So vCPU 0 gets `0x8000_0000`: bit 31 set, every affinity field 0. The reference puts sixteen CPUs in each cluster, as QEMU's `virt` machine (the emulated board whose memory map ours copies) does, because the interrupt controller can address at most sixteen CPUs of one cluster in one message (chapter 12):

:::code anchor=mpidr_for_index file=crates/vmm/src/arch/regs.rs

## Translation and caches off: `SCTLR_EL1`

[**`SCTLR_EL1`**](/build-your-own/vmm/glossary/#sctlr-el1), the System Control Register for EL1, holds the switches a kernel flips as it brings itself up. Four of its bits matter now:

| Bit | Name | 1 means |
|---|---|---|
| 0 | M | the MMU translates the guest's addresses through its own page tables, stage 1 |
| 1 | A | alignment checking: an access to an address that is not a multiple of its size faults |
| 2 | C | data accesses may be cached |
| 12 | I | instruction fetches may be cached |

With `M = 0` and `C = 0`, translation and data caching are off, as a kernel expects at entry: it turns them on itself, in an order it controls. Why caches need that care is the [`caches` primer](/build-your-own/vmm/primers/caches/), before chapter 13. The `arm64-boot-protocol` primer shows where Linux writes this rule down; journal question 2 asks why.

An [**alignment fault**](/build-your-own/vmm/glossary/#alignment-fault) is the exception a load or store takes when its address is not a multiple of the access size and the CPU checks alignment: with `A = 1`, an 8-byte load from an address ending in `1` faults. While translation is off, a second rule applies as well: every data access is treated as an access to Device memory (the memory type for device registers), where unaligned accesses fault even with `A = 0` (we checked this on our Mac). `self-fault` sets `A = 1` anyway, so that its fault has a cause you can see in a register.

:::code anchor=sctlr_bits file=crates/vmm/src/arch/regs.rs

## System registers through HVF

`MPIDR_EL1` and `SCTLR_EL1` are system registers, read with `mrs` and written with `msr`. From outside, the VMM uses a second pair of calls. Declare them from `hv_vcpu.h` beside chapter 02's `hv_vcpu_get_reg`, with their id type `type hv_sys_reg_t = u16` (16 bits, unlike the 32-bit `hv_reg_t`):

:::code anchor=ffi_sys_reg_fns file=crates/hvf/src/ffi.rs

The safe wrappers in `crates/hvf/src/vcpu.rs` follow chapter 02's `get_reg` exactly:

:::code anchor=vcpu_sys_regs file=crates/hvf/src/vcpu.rs

A system register's id packs five small numbers that the Arm manual prints on each register's page: Op0, Op1, CRn, CRm and Op2 (chapter 08 decodes them from traps). The reference's `SysReg` type builds an id from them, and names the registers we use, such as `SysReg::MPIDR_EL1 = new(3, 0, 0, 0, 5)` and `SysReg::SCTLR_EL1 = new(3, 0, 1, 0, 0)`:

:::code anchor=sysreg_new file=crates/hvf/src/regs.rs

Check your packing against HVF's `hv_vcpu_types.h`: `HV_SYS_REG_MPIDR_EL1` is `0xc005` and `HV_SYS_REG_SCTLR_EL1` is `0xc080`.

## Reset, in one function

The library crate gets its own `Vcpu` now, in `learner/crates/vmm/src/vcpu/mod.rs`. It owns chapter 02's `hvf::Vcpu`, and with it the rule that only the creating thread may touch it, and adds which CPU it is and how to reset it. First the boot parameters, the bits to clear, and the MPIDR rule:

:::code anchor=boot_params file=crates/vmm/src/vcpu/mod.rs

`x[0]` will carry the address of the device tree, the machine description a kernel reads at boot (chapter 10); until then, keep passing `0x4000_0000`. Then the struct, and `hv`, which turns a failed HVF call into the library's error, naming the failed step. If your chapter 04 `Error` lacks them, add `Hv { op: &'static str, err: hvf::CallError }`, displayed as `op: err`, and `Internal(&'static str)` for a VMM bug. Leave out `nogic_kick`, `sysregs` and `nogic` here and below; chapters 08 and 11 add them:

:::code anchor=vmm_vcpu_struct file=crates/vmm/src/vcpu/mod.rs

Creating the vCPU writes its MPIDR once, because it never changes:

:::code anchor=vmm_vcpu_create file=crates/vmm/src/vcpu/mod.rs

Then `reset`. Through the API a fresh vCPU's `SCTLR_EL1` reads 0, yet our dumps show `0x30000180` plus whatever bits the guest set: its RES1 bits (7, 8, 28 and 29 on this CPU) read as 1 whatever you write, as we checked by writing 0 and reading it back from inside a guest. So clearing M, C and I equals writing 0; `reset` clears only those bits anyway: change only what you mean to change. Leave out `vtimer_offset` and its call (where the guest's clock starts); chapter 11 adds both.

:::code anchor=vcpu_reset file=crates/vmm/src/vcpu/mod.rs

Call `create`, then `reset`, on the vCPU's thread, where chapter 03 set the PC and CPSR directly. Give `Vcpu` a `regs_dump(&self)` that calls `RegDump::capture(&self.inner)` (the dump comes below); the loop calls that, since `inner` is private.

> **Production note.** A real CPU's reset state covers hundreds of registers. On Linux's KVM (Kernel-based Virtual Machine), initialising a vCPU resets the system, timer, debug and floating-point state and presents sanitised feature identification registers the VMM may adjust. With HVF we set only what our guests rely on.

## Checking the reset from inside

The `regcheck` guest checks the reset from the guest's side, with the instructions a kernel would use: `mrs` from `CurrentEL`, `MPIDR_EL1`, `SCTLR_EL1` and `DAIF`. From the repository root, build the guests (`scripts/build-guests.sh`, as in chapter 03), then `cd learner` and run:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/regcheck.bin@0x40080000 --timeout 10
```

Our run, of the reference from the repository root:

:::term source=captures/06-regcheck-run.txt

Each line is a row of the opening table, read from inside. The checkpoint accepts any value on the `x0` line.

Look again at the last line. Our guests' start code installs its own vector table in [`VBAR_EL1`](/build-your-own/vmm/glossary/#vbar) (vector base address register, chapter 02), and `regcheck` runs `svc #0x4d` on purpose: syndrome `0x5600004d` is class `0x15`, an `svc`, carrying `0x4d`. The guest caught it at EL1 and carried on. Did our VMM see it? The reference's `--stats` flag (yours gains it later) counts VM exits, the times the virtual machine (VM) handed control back to us. From the repository root:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw target/guests/aarch64-unknown-none/release/regcheck.bin@0x40080000 --timeout 10 --stats
```

:::term source=captures/06-regcheck-stats.txt

182 exits, every one an `hvc`: 181 debug calls, one per printed character, and one to stop. The `svc` never left the guest; remember that when you meet `self-fault`.

> **Try it.** Delete the line in your `Vcpu::create` that writes `MPIDR_EL1`, and run `regcheck` again. Predict its second line before you look.

Your VMM has no interrupt controller yet, so we ran a copy of the reference without one, which behaves like yours:

:::term source=captures/06-no-mpidr-nogic.txt

Nothing changed. So HVF keeps two values: the one the guest's `mrs` sees, which HVF fills in by itself, and its own copy, which we read and write with `hv_vcpu_get_sys_reg` and `hv_vcpu_set_sys_reg` and which reads 0 until we write it. We have not been able to check why HVF splits them; what matters is that HVF's other features use its own copy, as the finished reference, with chapter 12's interrupt controller, shows:

:::term source=captures/06-no-mpidr.txt

The VM never started. Before the first run, the reference asks HVF for this vCPU's **redistributor**, the per-CPU part of the interrupt controller (chapter 12). HVF refuses until the vCPU's affinity has been set by writing `MPIDR_EL1` (its header `hv_gic.h` says so), so without our write the lookup fails with `HV_BAD_ARGUMENT`. A missing write that no one-CPU test can see is the worst kind. Chapter 20 finds two places where the value itself must be right; journal question 3 asks you to find them first.

## Breaking the reset

**Deliberate breakage 1: start in EL1t.** Change the `cpsr` field of the `BootParams` your `run` command builds from `0x3c5` to `0x3c4`, rebuild, and run `regcheck` again. Predict: which of its six lines will change?

:::term source=captures/06-cpsr-3c4.txt

Only the sixth line, `vectors ok`, is missing: nothing the first five read depends on bit 0. Then the guest hung until `--timeout` stopped it (exit code 5). What you saw: a hang after five lines. The register dump explains it, in "When the handler faults on itself". Undo the change.

## The register dump

When a guest dies, its registers are our only witness. A [**register dump**](/build-your-own/vmm/glossary/#register-dump) is a snapshot of them, printed in the order a reader asks questions:

- *Where was it?* The PC and CPSR.
- *What was it computing?* `x0` to `x30` and both stack pointers.
- *Did it take an exception of its own first?* [`ELR_EL1`](/build-your-own/vmm/glossary/#elr) (exception link register: where that exception happened), `SPSR_EL1` (the PSTATE saved with it), [`ESR_EL1`](/build-your-own/vmm/glossary/#esr) (exception syndrome register: why) and [`FAR_EL1`](/build-your-own/vmm/glossary/#far) (fault address register: which data address).
- *Where would its handler be, and was translation on?* `VBAR_EL1`, `SCTLR_EL1`, and `TCR_EL1`, `TTBR0_EL1` and `TTBR1_EL1`, the guest's own page-table setup (0 while translation is off; chapter 21 reads them).

Write it in `learner/crates/vmm/src/vcpu/regs.rs`:

:::code anchor=regdump_struct file=crates/vmm/src/vcpu/regs.rs

The snapshot is taken once, on the vCPU's own thread, at the moment the guest is stopped for good:

:::code anchor=regdump_capture file=crates/vmm/src/vcpu/regs.rs

The dump must notice when the PC sits on a vector entry, so here is the whole table; chapter 02 used two of its entries:

```text
VBAR_EL1 + ...                      synchronous   IRQ     FIQ     SError
0x000  current level, using SP_EL0     0x000      0x080   0x100   0x180
0x200  current level, using SP_ELx     0x200      0x280   0x300   0x380
0x400  lower level, AArch64            0x400      0x480   0x500   0x580
0x600  lower level, AArch32            0x600      0x680   0x700   0x780
```

*The vector table: four groups of `0x200` bytes, by where the exception came from (`SP_ELx` is the current level's own stack pointer); in each, four `0x80`-byte entries, by kind. 16 × `0x80` = `0x800` bytes. Chapter 08 uses all of them.*

The checkpoint compares the formatter, in `learner/crates/vmm/src/vcpu/dump.rs`, byte for byte, so copy its layout exactly: general-purpose registers padded to 16 digits, four per line; named registers unpadded, so a marker can match a prefix such as `pc=0x200`; and a `note:` line when the PC is `VBAR_EL1` plus a multiple of `VECTOR_ENTRY` (`0x80`) below `VECTOR_TABLE_SIZE` (`0x800`). The contract tests check that `VBAR_EL1 + 0x80` gets the note and `VBAR_EL1 + 0x10` does not.

:::code anchor=regdump_format file=crates/vmm/src/vcpu/dump.rs

After `ESR_EL1` the dump names the exception class in words. `ec_suffix`, above the formatter, prints the class in hex, then its name if it has one. It calls `esr::esr_ec`, the helper from chapter 05's `esr_header_fields` (bits 31 to 26 of the syndrome).

:::code anchor=dump_ec_suffix file=crates/vmm/src/vcpu/dump.rs

The names live in `arch/esr.rs`. For now the rows `0x15`, `0x20`, `0x24` and `0x25` are enough, and the golden dump checks the `0x25` text exactly; a class without a row prints `(EC 0xNN)` alone.

:::code anchor=esr_ec_name file=crates/vmm/src/arch/esr.rs

Now wire it into your run loop, `learner/crates/vmm/src/vcpu/run_loop.rs`, beside chapter 05's class-`0x24` branch. So far exit code 3 means one thing: chapter 05's fatal stop for an unhandled memory-mapped I/O (MMIO) data abort. The `self-fault` run ends in an instruction abort, class `0x20`, which your loop does not stop on yet. When `esr_ec` of the exit's syndrome is `0x20`:

1. capture the dump with `regs_dump`, first;
2. print `macvmm: guest fatal: instruction abort at pc 0x…` to standard error;
3. print a line naming the vCPU and the exit, at least `vcpu0: instruction abort (EC 0x20)`;
4. print `format_regs` of the dump;
5. exit with code 3.

Do the same on chapter 05's `0x24` path: capture first, then its `guest fatal:` line, a `vcpu0:` line and the dump. The checkpoint matches the words `instruction abort` and checks exit code 3.

> **Security.** Every value in the dump comes from a possibly hostile guest and lands on your terminal. Print only numbers and fixed names, never guest bytes as text, so a guest cannot smuggle terminal control sequences through it.

## A guest that faults inside itself

Time for the Predict entry. The `self-fault` guest sets `SCTLR_EL1.A = 1`, writes 0 into `VBAR_EL1` (so it has no vector table), and loads 8 bytes from an address ending in `1`. Run it from inside `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/self-fault.bin@0x40080000 --timeout 10
```

:::term source=captures/06-self-fault-run.txt

No alignment fault in sight: an instruction abort at `pc 0x200`. There is the report from the top of the page: every word true, and the guest never jumped to `0x200`. The six links below show who did.

Yours will be shorter: the rest of the `vcpu0:` line (two fault fields chapter 07 decodes), the `esr=`/`ipa=` line (the IPA, intermediate physical address, from chapter 05), `insn at pc:` and `last exits:` (both chapter 07) can wait. The checkpoint matches the guest's own first line, then `guest fatal: instruction abort`, `pc=0x200`, `ELR_EL1=0x4008…` and `ESR_EL1=0x96…` (five markers), plus exit code 3; addresses may differ by a few bytes.

Six links connect the load to this report, each leaving register values behind:

1. With `SCTLR_EL1.A = 1`, the guest loads 8 bytes from `0x40082a51`, not a multiple of 8: an alignment fault.
2. That fault is routed to EL1, the guest's own level, so we see nothing yet. The CPU saves `ELR_EL1 = 0x40081094`, the faulting load's address (a fault retries, chapter 02), `ESR_EL1 = 0x96000021` and `FAR_EL1 = 0x40082a51`.
3. The CPU jumps to the guest's vector table entry for "current level, using `SP_EL1`, synchronous" (the second row of the vector table above): `VBAR_EL1 + 0x200`. `VBAR_EL1` is 0, so the PC becomes `0x200`.
4. Nothing is mapped at IPA `0x200` (chapter 05's map has flash there, and we loaded no firmware), so fetching the handler's first instruction fails in stage 2.
5. That instruction abort is routed to EL2, and HVF forwards it to us: PC `0x200`, syndrome `0x82000006` (class `0x20`, an instruction abort from a lower level; fault status `0x6`, a translation fault).
6. Our dump shows the second fault *and*, in `ELR_EL1` and `ESR_EL1`, the first one, as its `note:` line says.

The rule to keep: **when the PC is a synchronous vector entry (`0x000` or `0x200` from the current level, `0x400` or `0x600` from a lower one), `ELR_EL1` and `ESR_EL1` describe the exception the guest took before it got there; if `ELR_EL1` itself points into the vector table, the handler is faulting on itself and the original cause is gone.** An IRQ or FIQ entry writes only `ELR_EL1` and `SPSR_EL1`, leaving `ESR_EL1` stale; our `note:` line does not yet tell them apart, which matters once chapter 11 unmasks interrupts. Here `ELR_EL1` points at the guest's code, so it is the first fault. Decode it as in chapter 05:

| Field of `0x96000021` | Bits | Value | Meaning |
|---|---|---|---|
| EC, the exception class | 31 to 26 | `0x25` | data abort taken *without* a change of level: the guest's EL1 faulted and EL1 took it. Chapter 05's stage-2 hole gave `0x24`, "from a lower level" |
| IL | 25 | 1 | a 32-bit instruction |
| WnR | 6 | 0 | a read (a load) |
| DFSC | 5 to 0 | `0x21` | data fault status code: alignment fault |

`SPSR_EL1 = 0x800003c5` and `cpsr=0x824003c5` share their low bits: the guest faulted in EL1h and landed in EL1h. The `8` at the top is the N flag.

> **Aside.** The extra bits in `cpsr` (`0x02400000`) are set by the CPU itself on an exception to EL1: bit 22 is PAN (privileged access never, which stops a kernel touching app memory by accident) and bit 25 is TCO (tag check override, for memory tagging). Neither matters to our guests.

What you saw: an instruction abort at an address the guest never jumped to. The misconception: "every guest exception becomes a VM exit". The tool that found the first fault: the dump's `ELR_EL1` and `ESR_EL1`.

Exceptions routed to EL1 are handled by the guest's own vector table, as `regcheck`'s `svc` was. Only what is routed to EL2, and forwarded by HVF, reaches us.

## When the handler faults on itself

Back to breakage 1. We added a probe that is not part of the course: with CPSR still `0x3c4`, the loop prints the dump's register block when the timeout stops it.

:::term source=captures/06-cpsr-3c4-dump.txt

The PC is `VBAR_EL1 + 0x200`, a synchronous entry, so by the rule above look at `ELR_EL1`: `0x40080a04`, *inside the vector table itself*. The handler is faulting on itself:

1. In EL1t, `sp` means `SP_EL0`, so `_start`'s `mov sp, x10` set `SP_EL0`; the dump shows the guest's stack there (`sp_el0=0x40092f70`). `SP_EL1` kept its reset value, 0.
2. `regcheck` ran its `svc`. Taken from EL1t, it entered at `VBAR_EL1 + 0x000` (the first row of the vector table: current level, using `SP_EL0`). Taking an exception to EL1 always switches to `SP_EL1`.
3. The handler's first instruction, `sub sp, sp, #0x120`, subtracted 288 from 0, and the store after it wrote far above any memory: an [address size fault](/build-your-own/vmm/glossary/#address-size-fault), a data abort at EL1 (`ESR_EL1 = 0x96000040`, `FAR_EL1` equal to `sp_el1`).
4. That fault was taken from EL1h, so it entered at `VBAR_EL1 + 0x200`, where the dump caught it, and the same two instructions faulted again, and again, all inside the guest.

So `ELR_EL1` and `ESR_EL1` describe the latest fault, the `note:` line was wrong here, and the first cause, the `svc` on a bad stack, is gone from every register.

`sp_el1` moved 288 bytes per fault, from 0 down to `0xffffffed2081bf60` in the probe's three seconds: about 280 million faults, none routed to EL2. Giving `SP_EL1` a valid value at reset, with CPSR still `0x3c4`, makes the same run pass, which confirms the chain:

:::term source=captures/06-cpsr-3c4-sp-el1.txt

What you saw: a guest that hung after printing everything it could. The misconception it exposes: "bit 0 only picks a stack; if the program sets `sp`, nothing else depends on it". The tool that found it: the register dump, whose `sp_el1` and `ELR_EL1` named the cause.

## Your turn

Your workspace now needs, and the checkpoint tests:

1. In `arch/regs.rs`: `Pstate` (`el`, `sp_elx`, `aarch32`, `daif`, `mode_name` and the `MODE, DAIF, NZCV` `Display`), the `pstate` and `sctlr` constants, and `mpidr`.
2. `hv_sys_reg_t`, `hv_vcpu_get_sys_reg` and `hv_vcpu_set_sys_reg` declared and wrapped, and a `SysReg` for each register the dump reads.
3. `Vcpu::create` writing `MPIDR_EL1`, and `Vcpu::reset(&BootParams)` setting the PC, `x0` to `x3`, CPSR and `SCTLR_EL1`.
4. `RegDump` with `capture`, `ec_suffix` with the four `ec_name` rows, `format_regs`, and the class-`0x20` fatal stop: `guest fatal:` line, `vcpu0:` line, dump, exit code 3.
5. Your journal: the Predict entry, written before you ran `self-fault`, and the four questions.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (the dump's exact layout and the PSTATE decoder), runs `regcheck` and `self-fault` against your VMM and matches their output, and checks your journal. A finished chapter looks like this:

:::term source=captures/06-checkpoint.txt

What now works:

- your vCPU starts in a defined state (EL1h, everything masked, its own MPIDR, translation and caches off), and a guest can check it from inside;
- you can build and read any PSTATE value, and know which bit picks the stack;
- a dying guest prints a register dump, and you can tell our fault from the guest's first one, and know when that one is gone.

The next chapter starts from this state (the reference at the end of chapter 06).

### What's next

The dump told you *where* a guest died, but our loop still stops at the first exit it does not understand. Chapter 07 decodes every syndrome, emulates a guest's loads and stores to device addresses, and adds the ring of last exits you saw at the bottom of the `self-fault` run.

### Open question

Your dump is the only window into a crashed guest. Which five registers would you add to it, and what question does each one answer?

## Spec hunt

- The Arm Architecture Reference Manual (ARM ARM, DDI 0487), register page **SPSR_EL1, Saved Program Status Register (EL1)**: which `M[3:0]` values are legal for an exception taken to EL1, and why is there no "EL0h"?
- ARM ARM, register page **MPIDR_EL1, Multiprocessor Affinity Register**: what do the `U` and `MT` bits mean, and where does the fourth affinity field, `Aff3`, live?
- Linux `Documentation/arch/arm64/booting.rst`, section 4, "Call the kernel image": which registers and `SCTLR_EL1` bits must hold at entry, and which of them does your `reset` not set yet?
