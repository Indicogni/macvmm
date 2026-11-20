---
title: System registers, injection, hypercalls and PSCI
part: III
chapter: III.3
id: 08
runs: mac+browser
minutes: 270
prereqs: [07]
start_tag: ch-07
labs: [sysreg-smccc]
command: scripts/checkpoint.sh 08
expect: CHECKPOINT 08 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** the system-register trap and its syndrome (exception class `0x18`: Op0, Op1, CRn, CRm, Op2, Rt, direction); the policy table (emulate, RAZ/WI, inject UNDEF), with a reason per row; exception injection, done by hand, and choosing its entry in the vector table; dispatch of the SMC calling convention (SMCCC) over two conduits; the power state coordination interface (PSCI): `VERSION`, `FEATURES`, `SYSTEM_OFF` and `SYSTEM_RESET`; the exit-code table and `--on-reset`.
- **Core, from earlier:** the exception entry sequence, the vector table base and the call-versus-retry rule (chapter 02); the two supervisors, Hypervisor.framework (HVF) and our virtual machine monitor (VMM) (chapter 01); PSTATE modes, the 16-entry vector table, `ELR_EL1`, `ESR_EL1`, `SCTLR_EL1` and the reset state (chapter 06); the `Exit` enum, its `SysReg` variant, the PC-advance table and the exit trace (chapter 07).
- **Primers (read first):** `reading-arm-specs` (RAZ/WI, UNDEFINED and the register pages of the Arm Architecture Reference Manual).
- **Primers (review):** `smccc` (function-ID fields, fast and yielding calls, the two conduits); `os-basics` (what firmware is); `aarch64-reading` (`mrs`, `msr` and system-register names).
- **Pointers:** ID registers and feature discovery; the trap-control registers `HCR_EL2` and `MDCR_EL2`, which belong to HVF; the debug OS lock. Each is an Aside or a linked sentence below.
- **Forward definitions:** the interrupt controller and `--irqchip none` (chapters 11 and 12); the device tree's `method = "hvc"` (chapter 10); `CPU_ON` and the per-CPU power table (chapter 20).
:::

Your guest asks its CPU a question the CPU cannot answer: it reads a register for a hardware counter the CPU does not have. The read traps to your virtual machine monitor (VMM), and you must reply. You could hand back zero. Nothing crashes, the guest carries on, every test still runs. Or you could do what a real CPU does with a register it lacks, and raise an exception inside the guest.

:::predict Make the VMM answer 0 to every register read it would otherwise refuse with an exception, then run the `sysreg-probe` test guest. Will the guest notice?
Write your answer and one sentence of reasoning under `## Predict` in your journal. Sitting A runs it, as the first deliberate breakage.
:::

This chapter answers row 4 of chapter 00's problem ledger, a way to ask the platform to power off or reset (starting other CPUs waits for chapter 20), and finishes row 1, the CPU, by deciding what to do with every privileged register access that reaches us. Sitting A (about 2.5 hours) is system registers and injection; sitting B (about 2 hours) is hypercalls, PSCI (the power state coordination interface) and exit codes.

:::objectives
- (Sitting A) Decode an exception-class `0x18` syndrome into Op0, Op1, CRn, CRm, Op2, Rt and direction, and name the register (`OSLAR_EL1`, `PMCR_EL0`, or `S3_0_C15_C0_0` for one with no name).
- (Sitting A) Explain our half of trapping: Hypervisor.framework forwards only some accesses, so which registers trap is measured; then give each a policy (emulate the OS lock, RAZ/WI (read-as-zero, writes ignored) for debug registers, inject UNDEF for everything else) with a written reason.
- (Sitting A) Inject an UNDEFINED exception by doing by hand what the hardware does on exception entry, and compute the new PC from the 16-entry vector table.
- (Sitting B) Implement an SMCCC dispatcher with PSCI 1.1 `PSCI_VERSION`, `PSCI_FEATURES`, `SYSTEM_OFF` and `SYSTEM_RESET`, returning `NOT_SUPPORTED` (-1) for unknown IDs with a rate-limited warning, over both conduits with their different PC rules.
- (Sitting B) Map every way a virtual machine (VM) stops to `macvmm`'s exit code, including `--on-reset reboot` and `--on-reset exit`.
:::

**Before you start.** Run `scripts/learner start 08` from the repository root. It copies this chapter's journal to `learner/journal/08.md`. As in chapter 07, you write your own version in `learner/` against the contract tests: `arch/sysreg.rs`, `arch/inject.rs`, `smccc.rs` (the dispatcher, which answers `VERSION`, `FEATURES`, `SYSTEM_OFF` and `SYSTEM_RESET`) and `control.rs` under `crates/vmm/src/`, plus a system-register decoder in `arch/esr.rs` and new arms in `vcpu/exit.rs`. One file is borrowed, not written: `psci.rs`, the per-CPU power table that chapter 20 teaches. Sitting B starts by fetching it.

## What reaches us is an experiment

Which guest actions reach our VMM is decided by trap settings that we do not own: Hypervisor.framework (HVF) sets them, from its seat at exception level 2 (EL2), one level above the guest's kernel at EL1. So "which system registers trap?" is an experiment you run, not a fact you look up in the Arm Architecture Reference Manual (the ARM ARM).

> **Aside.** The settings live in two [trap-control registers](/build-your-own/vmm/glossary/#trap-control-register) at EL2: `HCR_EL2` (Hypervisor Configuration Register), which chooses the kinds of instruction that trap, and `MDCR_EL2` (Monitor Debug Configuration Register), the same for debug and performance-monitor registers. Each has a page in the ARM ARM (document DDI 0487); only HVF writes them.

The `sysreg-probe` test guest, new in this chapter, touches four kinds of [system register](/build-your-own/vmm/glossary/#sysreg) (the `mrs`/`msr` registers of the `aarch64-reading` primer). In order, it:

1. reads `PMCR_EL0`, the control register of a performance counter this CPU does not have, and expects exactly one exception (its first two lines of output);
2. reads `LORID_EL1`, a register that does exist, and expects no exception (the `lo=` and `lorid` lines);
3. reads `MDCCSR_EL0`, a debug status register, and expects one exception (the `mdccsr` lines);
4. sets and then clears the operating system's debug lock (the OS lock, explained below), and reads its status after each (the `oslsr` lines).

Its handler counts exceptions: `undef count=N ec=...` gives how many it took and the class of the last (0, "unknown reason", is an UNDEF; `0xffffffffffffffff` means none). `elr ok` means the guest's exception link register, `ELR_EL1` (chapter 06's dump), pointed at the `mrs`, as a real exception leaves it; "Rt untouched" means the `mrs` did not overwrite its destination register. With the exit trace's `sysreg` category on, the VMM writes one record per access that reaches it. From `learner/`, as in chapter 07:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw $G/sysreg-probe.bin@0x40080000 --trace exits:/tmp/s.jsonl:sysreg --timeout 10
cat /tmp/s.jsonl
```

Our captures, made from the root of a copy of the reference, say `target/guests/...` where you say `$G`. Here is the reference in the default configuration, the checkpoint's own run, with the trace printed after it:

:::term source=captures/08-sysreg-default.txt

Six records, four registers: `LORID_EL1`, `MDCCSR_EL0`, and the OS lock pair `OSLAR_EL1` and `OSLSR_EL1`. None is `PMCR_EL0`, although the probe's first line, `undef count=1 ec=0x0`, shows that its read of `PMCR_EL0` (step 1) took one exception. Now the same guest with the interrupt controller built into HVF switched off. An interrupt controller is the hardware that collects device interrupts and hands them to CPUs (chapter 12); HVF's runs in the macOS kernel, not in our process, and the flag `--irqchip none` runs without one (chapter 11). It is hidden: `--help` leaves it out, as it exists for teaching.

:::term source=captures/08-sysreg-nogic.txt

We checked both on a real Mac, and they disagree:

| Guest access | Default configuration | With `--irqchip none` |
|---|---|---|
| `mrs PMCR_EL0` (performance monitor control) | HVF raises the UNDEF itself; no exit | reaches us |
| `mrs LORID_EL1` | reaches us | reaches us |
| `mrs MDCCSR_EL0` (debug channel status) | reaches us | HVF returns 0 itself; no exit |
| `msr OSLAR_EL1`, `mrs OSLSR_EL1` (the OS lock, explained below) | reach us | reach us |

*Same guest, same CPU: what reaches the VMM depends on how HVF is configured.*

Nothing in the ARM ARM predicts the swap in the first and third rows; it is HVF's choice, and a future macOS may make another. So the reference keeps a policy for registers that do not reach us today, and the trace records every register that does.

In the `--irqchip none` run the probe prints `mdccsr FAILED`. It expected an exception for `MDCCSR_EL0`, but there HVF answers the read itself with 0, and our VMM never sees it. The FAILED line is the probe noticing HVF's choice, not a bug in our VMM.

## Why a guest reads registers it might not have

Kernels discover features by reading [ID registers](/build-your-own/vmm/glossary/#id-register): before using a performance counter, a kernel asks the CPU "do you have a performance counter?" by reading a register whose fields answer it. HVF answers ID-register reads itself, so we never see them; we only have to agree with what it said. If we answer every unknown read with zeros, the kernel believes whatever zero means. Real hardware raises an Undefined Instruction exception for a register it does not have, so [**UNDEF**](/build-your-own/vmm/glossary/#undef-undefined) is the honest answer.

> **Aside.** The ID registers are read-only registers such as `ID_AA64PFR0_EL1` (which floating-point and interrupt-controller features exist), `ID_AA64MMFR1_EL1` (memory-system features) and `ID_AA64DFR0_EL1` (debug features). Each field is a small number, and 0 usually means "not implemented"; their pages in the ARM ARM list every value.

`ID_AA64DFR0_EL1.PMUVer` (bits 11 to 8) gives the version of the [performance monitoring unit (PMU)](/build-your-own/vmm/glossary/#pmu), the CPU's performance counters. We added one line to a copy of the probe that prints the register before step 1:

:::term source=captures/08-pmuver.txt

`PMUVer=0`: not implemented. So `PMCR_EL0`, the PMU's control register, must be UNDEFINED: the guest was told there is no PMU.

`LORID_EL1` is the opposite case. The guest sees `ID_AA64MMFR1_EL1.LO = 1` (the probe's `lo=1`), which says the CPU has limited ordering regions (LOR), a memory-ordering feature no guest here uses. So that register exists and must not UNDEF. The reference reads it as zero, meaning "zero regions": a real answer, not a lie. The rule behind both: a policy must agree with what the ID registers told the guest.

## Decoding the trap: exception class `0x18`

A trapped `mrs` or `msr` arrives as exception class (EC) `0x18`. As for the data aborts of chapter 07, the hardware has already decoded the instruction and written a note in the instruction-specific syndrome (ISS), the low 25 bits of the exception syndrome register (ESR): which register, which general-purpose register, which direction. To see a raw syndrome, we added one print line to a copy of the reference's handler and ran the probe without the interrupt controller:

:::term source=captures/08-sysreg-esr.txt

Take the first one, `0x6230e419`, at the `mrs` of `PMCR_EL0`. The syndrome stores the fields out of name order (Op2 sits above Op1, CRm sits below Rt), so read them by bit position, then rearrange. IL is the instruction-length bit:

```text
 0x6230e419 >> 26 = 0x18 (EC: MSR, MRS or system instruction), bit 25 = 1 (IL: 32-bit instruction)
 ISS = 0x30e419:
   bits 21:20  Op0        = 3
   bits 19:17  Op2        = 0
   bits 16:14  Op1        = 3
   bits 13:10  CRn        = 9
   bits  9:5   Rt         = 0    (x0)
   bits  4:1   CRm        = 12
   bit   0     Direction  = 1    (1 = read, an mrs)
 (Op0, Op1, CRn, CRm, Op2) = (3, 3, 9, 12, 0)  ->  PMCR_EL0, read into x0
```

*The five coordinates are the register's name; Rt and Direction say what the instruction wanted.*

Each register's ARM ARM page lists these five numbers under "Accessing"; that is how you name one. A register no table names is printed in the spelling assemblers accept, `S<op0>_<op1>_C<n>_C<m>_<op2>`, for example `S3_0_C15_C0_0`. The trace's `sysreg_enc` (`0xdce0` here) packs the same five numbers as HVF's `hv_sys_reg_t` (chapter 06's `SysReg::new`): `Op0<<14 | Op1<<11 | CRn<<7 | CRm<<3 | Op2`. The decoded access, in `crates/vmm/src/arch/esr.rs`:

:::code anchor=esr_sysreg_access file=crates/vmm/src/arch/esr.rs

:::code anchor=esr_decode_sysreg file=crates/vmm/src/arch/esr.rs

Now decode the third syndrome of the capture, `0x62280520`, by hand: the five coordinates, the register, Rt and the direction. Check yourself against the answer, which follows the policy code in the next section.

## The policy table: our half

HVF decided what reaches us; what we do with it is ours: a [policy table](/build-your-own/vmm/glossary/#policy-table), with a written reason per row. Three answers cover it, in the `reading-arm-specs` primer's vocabulary:

- **Emulate** the debug [OS lock](/build-your-own/vmm/glossary/#os-lock), which an operating system sets while it saves or restores debug registers, so that an external debugger cannot interfere. It is set at power-on (cold reset) and Linux clears it early in boot, so a boot touches it whatever we do. We keep its bit per virtual CPU (vCPU): `OSLAR_EL1` writes it, `OSLSR_EL1` reads it, and `OSDLR_EL1`, the "double lock" used around power-down, is a second bit kept the same way.
- **[RAZ/WI](/build-your-own/vmm/glossary/#raz-wi)** (read-as-zero, writes ignored) for the breakpoint and watchpoint registers and two debug control registers, `MDCCINT_EL1` and `MDSCR_EL1`. Every Armv8 CPU has the two control registers and at least two breakpoints and two watchpoints; `ID_AA64DFR0_EL1` says how many (its BRPs and WRPs fields, 5 and 3 in the `PMUVer` capture above: six breakpoints, four watchpoints). UNDEF for those would contradict the ID registers; zero says "nothing set, nothing enabled". The reference's row is a simplification: it covers all 16 slots, including the ones this CPU does not advertise, and HVF answers these registers itself, so none has reached us. The LOR registers are RAZ/WI too (they exist, with zero regions), except `LORID_EL1`, which is read-only, so a write to it is UNDEF (`RazRo` in the code).
- **Inject UNDEF** for the PMU and for every register in no row. The default is never "let it through".

:::code anchor=sysreg_policy_table file=crates/vmm/src/arch/sysreg.rs

`MDCCSR_EL0` is in no row, so it gets the default UNDEF. That is a judgement call, not a rule: the debug channel belongs to the base debug architecture, so a real CPU would not raise an exception here, and KVM (Kernel-based Virtual Machine, Linux's hypervisor) reads it as zero. We keep the UNDEF because no guest we run touches the register and the probe uses it to test our injection in the default configuration; the reference's `sysreg.rs` records it as an open question.

Direction matters: `OSLAR_EL1` is write-only, so an `mrs` of it is UNDEFINED too. The whole decision is a pure function of the access and the vCPU's emulated lock, which is what lets the contract tests sweep all 65,536 encodings on your laptop with no VM at all:

:::code anchor=sysreg_handle file=crates/vmm/src/arch/sysreg.rs

The exercise: `0x62280520` is (2, 0, 1, 0, 4), Rt 9, direction 0, an `msr` writing `x9` to `OSLAR_EL1`.

## Injection: doing the hardware's job

HVF handed this exception to us, but the guest expects exactly what the hardware would have done. So our code does the hardware's job, the exception entry chapter 02's stepper showed, in five steps, in software: exception [**injection**](/build-your-own/vmm/glossary/#injection).

Where does the PC go? Chapter 06 drew all sixteen entries of the vector table at `VBAR_EL1` (the vector base address register) to read a dump; injection has to pick one, so here is the same table with each row's mode named. Each entry is 0x80 bytes (32 instructions), so the table is 2 KiB. The row is chosen by where the exception came from, the column by its kind, and the distance from `VBAR_EL1` is the entry's [vector offset](/build-your-own/vmm/glossary/#vector-offset):

```text
                                    synchronous  IRQ      FIQ      SError
                                    +0x000       +0x080   +0x100   +0x180
 current level, using SP_EL0 (EL1t) 0x000        0x080    0x100    0x180
 current level, using SP_EL1 (EL1h) 0x200        0x280    0x300    0x380
 lower level, AArch64 (from EL0)    0x400        0x480    0x500    0x580
 lower level, AArch32 (from EL0)    0x600        0x680    0x700    0x780
 (offsets from VBAR_EL1)
```

*Columns: synchronous, IRQ (interrupt request), FIQ (fast interrupt request), SError (system error). An injected UNDEF is synchronous, so it lands in the first column of one of the first three rows. We never run 32-bit code, so the last row is never ours.*

One real trap, with real numbers. In a copy of the reference, the probe's UNDEF handler prints what it found, and the VMM prints the registers it read and wrote. Run without the interrupt controller, so `PMCR_EL0` reaches our VMM:

:::term source=captures/08-inject-nogic.txt

Addresses moved (the `mrs` is at `0x400812e8` here, `0x400811ec` in the reference) because the copy has extra code. Before the trap the guest was at EL1h with a current program status register (CPSR) of `0x600003c5`, as the `inject:` line shows. The `0x6` on top is the Z and C condition flags; the low bits are chapter 06's EL1h, `0x3c5`.

The syndrome we decoded earlier (class `0x18`) is EL2's view of the trap, handed to us by HVF; the guest never sees it. A real CPU without the register would raise an Undefined Instruction exception at EL1, whose class is 0 ("unknown reason"), so that is what we write into the guest's own syndrome register, `ESR_EL1`. Our injection writes:

| Step | Register | Value | Why |
|---|---|---|---|
| 1 | `ELR_EL1` (exception link register: where to return) ← PC | `0x400812e8` | an UNDEF is a fault, so the saved PC points at the instruction |
| 2 | `SPSR_EL1` (saved program status register) ← CPSR | `0x600003c5` | the state to return to, flags and all |
| 3 | `ESR_EL1` ← EC << 26 \| IL << 25 \| ISS | `0x02000000` | EC 0, "unknown reason", IL 1 (a 32-bit instruction), ISS 0 |
| 4 | CPSR ← EL1h, interrupts masked | `0x604003c5` | flags kept, low bits `0x3c5`, plus [PAN](/build-your-own/vmm/glossary/#pan) (privileged access never, bit 22) |
| 5 | PC ← `VBAR_EL1` + `0x200` | `0x40080a00` | `VBAR_EL1` is `0x40080800` (from the handler's printout), plus `0x200`: synchronous, current EL with `SP_EL1` |

PAN (bit 22 of the CPSR, chapter 06's Aside) is set because exception entry sets it unless the guest's `SCTLR_EL1.SPAN` bit is 1; Under the hood, below, has the details.

The handler's printout matches steps 1 to 3 to the bit, and it printed at all, so step 5 reached the table. The handler then moves `ELR_EL1` past the `mrs` and returns: the guest decides whether to skip a faulting instruction, not us.

`vector_offset` picks the table's row from the mode bits of the CPSR (step 5's `0x200`) and refuses any mode our vCPUs never run; `entry_pstate` builds step 4's value:

:::code anchor=inject_vector_offset file=crates/vmm/src/arch/inject.rs

`sync_exception` computes steps 1 to 5 as pure data, with no vCPU in sight, which is how the contract tests check it:

:::code anchor=inject_sync_exception file=crates/vmm/src/arch/inject.rs

`undef` fills in step 3's syndrome: EC 0 and ISS 0.

:::code anchor=inject_undef file=crates/vmm/src/arch/inject.rs

`apply_injection` writes the result into the vCPU, and `inject_undef` is what the policy's UNDEF calls. It returns `advance_pc: false`, which is why the PC lands on the vector instead of being stepped past the `mrs`:

:::code anchor=exit_apply_injection file=crates/vmm/src/vcpu/exit.rs

Now the exit handler for class `0x18` can apply the policy's outcome. An emulated access steps over the trapped instruction, which has not executed (chapter 07's PC rule); an UNDEF calls `inject_undef`, which sends the PC to the guest's vector table instead:

:::code anchor=sysreg_trap file=crates/vmm/src/vcpu/exit.rs

> **Under the hood.** Step 4 is more than `0x3c5`. The ARM ARM's exception-entry pseudocode (`AArch64.TakeException`) keeps the N, Z, C and V flags, clears a few execution bits, and sets PAN unless `SCTLR_EL1.SPAN`, bit 23, is 1. Our vCPUs come up with `SCTLR_EL1 = 0x30000180` (only its RES1 bits, since chapter 06's reset clears M, C and I), whose SPAN is 0, so this guest enters its handler with PAN set: the handler read `PAN=0x400000`. The contract tests check both settings of SPAN.

Now the same instrumented copy in the default configuration, where HVF raises the UNDEF for `PMCR_EL0` itself, with no exit, and our VMM injects only for `MDCCSR_EL0`:

:::term source=captures/08-inject-gic.txt

The `PMCR_EL0` lines are identical: the same `ELR_EL1`, `SPSR_EL1`, `ESR_EL1` and PAN. Yet there is only one `inject:` line, for `MDCCSR_EL0`; HVF did the first one. The guest cannot tell whether HVF or our VMM raised its UNDEF: an injected exception must be built exactly as the hardware builds one. Building it faithfully is a separate question from deciding to raise it. For `MDCCSR_EL0` the decision is ours, not what silicon would do, which is why the reference records it as an open question.

**Deliberate breakage 1: answer 0 instead of UNDEF.** In your workspace, add a first arm to `sysreg::handle` that returns `SysRegOutcome::Read(0)` for any read whose policy is `Undef`; undo it afterwards. Check your Predict entry, then run the probe without the interrupt controller, so that `PMCR_EL0` reaches you, with the trace:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/sysreg-probe.bin@0x40080000 --irqchip none --trace exits:/tmp/z.jsonl:sysreg --timeout 10
cat /tmp/z.jsonl
```

:::term source=captures/08-zero-unknown.txt

Read it in three parts:

1. The probe's first line says `undef count=0`, then `FAILED`: no exception arrived, so no `ELR_EL1` was recorded (`elr=0x0`). Only this probe notices, because it was written to expect one.
2. `mdccsr FAILED` is the HVF effect seen earlier with `--irqchip none`, not the break.
3. The VMM reports nothing: exit code 0, no warning, no crash. Yet the trace's first record reads `PMCR_EL0`, `"value":"0x0"`, `"action":"sysreg"`: the guest was told there is no PMU, and now its control register answers. A kernel that trusted the value would carry on.

The checkpoint is less polite. We ran it against a copy of the reference with this one edit, in the default configuration:

:::term source=captures/08-zero-unknown-checkpoint.txt

The contract tests catch it (`pmu_is_undef`, and the sweep over unlisted encodings), though HVF never forwards `PMCR_EL0` here. The run fails too, because the checkpoint pins the reference's choice for `MDCCSR_EL0`.

What you saw: a run that "passes" while the guest is told something false.

The misconception: "no crash means no harm"; silence is a decision, and here a wrong one.

The tool that found it: the contract sweep and the trace's `"action"` field, not a guest that trusts the value; only a probe written to expect an exception notices.

Sitting A ends in a state that builds. In `learner/`, `cargo build -p vmm` succeeds and `cargo test -p vmm` passes your own tests. Then, from the repository root, `scripts/checkpoint.sh 08` reports each contract file by name on its first line: `inject` and `sysreg_policy` should pass, while `smccc_dispatch`, `psci_state` and the runs fail until sitting B is done.

:::stopping-point Good place to stop. Sitting B needs about 2 hours, your Mac and the `smccc` primer fresh in mind.

## A power button nobody wired

**Starting sitting B.** Two things first. If this is a new terminal, set `G` again, exactly as in sitting A, from `learner/`:

```sh
G=../target/guests/aarch64-unknown-none/release
```

Then borrow the CPU power table, from the repository root: `scripts/learner lifeline vmm::psci`. Your dispatcher calls into it for `CPU_ON`, `CPU_OFF` and `AFFINITY_INFO`, which chapter 20 teaches.

A kernel that wants to power off does not poke a power chip; it asks the platform: the firmware from the `os-basics` primer, which ran first and stays behind to answer a few requests such as "power off". Our machine has no firmware, so the VMM plays its part.

We could invent a power-controller device and write a driver for it into every guest, or answer the call real Arm firmware already answers, so stock kernels work unchanged. That standard is [**PSCI**](/build-your-own/vmm/glossary/#psci): a set of numbered calls to power off, reset, and start or stop CPUs. It is carried by [SMCCC](/build-your-own/vmm/glossary/#smccc), the calling convention named after SMC (secure monitor call) that you reviewed in the `smccc` primer.

Take `SYSTEM_OFF`, [function ID](/build-your-own/vmm/glossary/#function-id) `0x84000008`. Bit 31 is 1: a [**fast call**](/build-your-own/vmm/glossary/#fast-call), one that runs to completion without interruption (a yielding call may be paused and resumed; every call in this course is fast). Bit 30 is 0: the 32-bit convention. Bits 29 to 24 are the owning entity number (OEN), 4, "standard secure service", PSCI's home. The low 16 bits are the function number, 8.

The registers are the API: the function ID goes in `w0`, arguments in `x1` onwards (PSCI needs at most three, `x1` to `x3`, and only their low halves, `w1` to `w3`, for a 32-bit call such as this one), and results come back in `x0` to `x3`.

:::lab sysreg-smccc

If the lab does not load: it decodes an `mrs`/`msr` instruction word into the register's coordinates and name, and builds an SMCCC function ID from its four fields (fast or yielding, 32 or 64, owner, number) and back.

The IDs and return values we answer, in `crates/vmm/src/smccc.rs`:

:::code anchor=smccc_psci_ids file=crates/vmm/src/smccc.rs

## The dispatcher

A call arrives as an `Exit::Hvc` or `Exit::Smc` (chapter 07). Three small types describe it: which [conduit](/build-your-own/vmm/glossary/#conduit) it came through (`hvc` or `smc`, the two instructions that can make a call; the next section compares them), what the guest passed, and what to do next.

:::code anchor=smccc_call_types file=crates/vmm/src/smccc.rs

:::code anchor=smccc_function_id file=crates/vmm/src/smccc.rs

The dispatcher is one `match` that has an answer for every possible 64-bit input. The immediate is the number written after the instruction (the 0 in `hvc #0`), which the syndrome reports; an immediate other than 0 is not SMCCC. An ID nobody expected gets [`NOT_SUPPORTED`](/build-your-own/vmm/glossary/#not-supported) with a warning (rate-limited so a guest cannot flood your terminal). Two IDs a stock Linux boot asks about get a quiet "no", through `is_known_probe`: `TRNG_VERSION` (does the firmware offer a true random number generator, TRNG?) and `VENDOR_HYP_CALL_UID` (which hypervisor is this? UID is unique identifier). The `CPU_ON`, `CPU_OFF` and `AFFINITY_INFO` rows act on a per-CPU power table that chapter 20 explains.

:::code anchor=smccc_dispatch file=crates/vmm/src/smccc.rs

`SYSTEM_OFF` and `SYSTEM_RESET` return nothing: they stop the VM with a reason. From now on every test guest ends with `SYSTEM_OFF`, exit code 0.

## Two doors: `hvc` and `smc`

SMCCC has two conduits, and both reach us, by different routes. `hvc` (hypervisor call) is an exception call aimed at EL2 by design: it completes, the exception is taken, and the PC has already moved past it. `smc` would go to EL3, the firmware's level, which Apple's chips do not have, so HVF traps it before it runs and the PC still points at it. Chapter 02 showed the two PCs. So the dispatch result is written back the same way for both, and only an `smc` needs its PC advanced:

:::code anchor=exit_smccc_call file=crates/vmm/src/vcpu/exit.rs

Here is the reference `psci-probe`, which calls through `hvc #0`, with its first three trace records:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/psci-probe.bin@0x40080000 --on-reset exit --trace exits:/tmp/h.jsonl:psci --timeout 10
head -n 3 /tmp/h.jsonl
```

:::term source=captures/08-hvc-conduit.txt

In the trace, an `hvc` arrives as exception class `0x16`, an exit like any other. A [hypercall](/build-your-own/vmm/glossary/#hypercall) is not a special CPU mode; it is an ordinary exception-generating instruction plus an agreed meaning for the registers.

Each guest line is one call and the `x0` it got back:

- `version=0x10001`: major 1 in the top half, minor 1 in the bottom, so PSCI 1.1 (and SMCCC 1.1 on the next line).
- `features(CPU_ON)=0` and `features(0x84000099)=-1`: the second sets `w0 = 0x8400000A` (`PSCI_FEATURES`) and `w1 = 0x84000099`, a function that does not exist, and reads -1 back in `x0`.
- `sip(0x82000000)=-1`: a deliberate unknown ID in the silicon-provider range (owner 2). It is there to trigger the rate-limited warning, so the `unknown SMCCC function` line on standard error is expected.
- `affinity_info(0,0)=0` and `cpu_on(1)=-2`: CPU 0 is on, and -2 is `INVALID_PARAMETERS` because there is no CPU 1 yet (chapter 20).
- `migrate_info_type=2`: "no trusted OS to migrate". A trusted OS is a small separate operating system that some machines run in EL3's secure world; we have none.

> **Try it.** The test guests are shared by every chapter: they live in the repository's `guests/` directory, not in your `learner/` workspace. In `guests/common/hvc.rs`, inside the `asm!` call of `hvc_call` (the SMCCC helper), change the string `"hvc #0"` to `"smc #0"`; the other mentions of `hvc #0` in that file are comments. From the repository root, run `scripts/build-guests.sh`; then, back in `learner/`, run the same command as above. Compare the class and the PC of the first record with the run above before you read ours. Afterwards restore and rebuild, or every later run and checkpoint uses `smc`: `git restore guests/`, then `scripts/build-guests.sh`.

:::term source=captures/08-smc-conduit.txt

Same answers, class `0x17` instead of `0x16`, and the first call's PC is `0x40081378` instead of `0x4008137c`: four bytes earlier, *at* the `smc`. We accept both doors, but a guest learns which one to use from the device tree, a description of the machine that chapter 10 generates, where our PSCI node says `method = "hvc"`. Serving `smc` too is a policy choice, not an obligation.

## Stopping for a reason: exit codes

A stop's reason picks the [exit code](/build-your-own/vmm/glossary/#exit-code), so scripts can tell a power-off from a crash:

:::code anchor=stop_reason file=crates/vmm/src/control.rs

:::code anchor=exit_codes file=crates/vmm/src/control.rs

| Code | Cause | Introduced |
|---|---|---|
| 0 | the guest powered off (`DEBUG_EXIT(0)`, now also `SYSTEM_OFF`) | chapter 03 |
| 1 | an error in the VMM or from HVF, such as `HV_DENIED` | chapter 01 |
| 2 | a usage or configuration error, such as an unknown flag | chapter 03 |
| 3 | guest fatal: unhandled memory-mapped I/O (MMIO), an instruction abort, an exit we cannot handle, now a reset storm (below) | chapter 05 |
| 4 | the guest asked for a reset and `--on-reset exit` was given | this chapter |
| 5 | `--timeout` expired | chapter 03 |
| 6 | `DEBUG_EXIT` with a non-zero code, such as a guest panic | chapter 03 |
| 130 | you quit, for example with Ctrl-C | coming in chapter 09 |

*The same table is on the reference card.*

`SYSTEM_RESET` asks for a [system reset](/build-your-own/vmm/glossary/#system-reset): the whole machine restarts, not one CPU as in chapter 06's reset state. With `--on-reset reboot`, the default, the VMM rebuilds the machine from the same inputs and boots it again; with `--on-reset exit`, the process ends with code 4. The loop counts boots in `generation` and caps resets per short window, so a guest that resets forever ends with exit 3:

:::code anchor=reboot_loop file=crates/vmm/src/lib.rs

`psci-probe` prints `boot 0`, asks for a reset, and on its second boot powers off. Its RAM is fresh after a rebuild, so it asks the VMM which boot this is through `DEBUG_BOOT_COUNT`, a test-only debug hypercall of the same family as chapter 03's, and the answer is the loop's `generation`. The `hvc` run above used `--on-reset exit`, so it stopped after `boot 0` with code 4.

**Deliberate breakage 2: ignore `SYSTEM_OFF`.** In your workspace, make the dispatcher answer `PSCI_SYSTEM_OFF` with `ret(SUCCESS)` instead of stopping; undo it afterwards. Predict: what does a guest do after a power-off that returned? Then run:

```sh
cargo run -q -p macvmm -- run --mem 64M --raw $G/psci-probe.bin@0x40080000 --timeout 10
```

:::term source=captures/08-ignore-system-off.txt

The probe's output appears twice before the hang. Boot 0 asked for a reset, which still works, so the machine was rebuilt; boot 1 then asked to power off, got `SUCCESS` back, and is now parked. The process never exits on its own; `--timeout` ends it with code 5. Our guest's `power_off` falls into a loop of `wfi` (wait for interrupt) instructions, the only sane thing to do after a call that must not return.

What you saw: a hang after the last line.

The misconception: "the guest stops when it is done"; it stops only if both sides agree on how to say "done".

The tool that found it: the timeout and its exit code.

> **Security.** The guest chooses everything a call carries: `x0` to `x3`, the immediate, the conduit. Our dispatch answers every possible input (never a panic) and writes only `x0` to `x3`, as each call defines. The debug calls answer only test guests, meaning anything loaded with `--raw` or as an ELF file; a Linux kernel image or firmware gets `NOT_SUPPORTED`, like any unknown ID. `--no-debug-hvc` and `--debug-hvc` turn them off or on for every guest.

## Your turn

Check your workspace before the checkpoint:

1. Your decoder turns `0x6230e419` into `PMCR_EL0`, `x0`, read, and your policy injects UNDEF for it.
2. Your injection reproduces the table above for those numbers: `ELR_EL1`, `SPSR_EL1`, `ESR_EL1`, the new CPSR and the new PC.
3. Your dispatcher answers `PSCI_VERSION` with `0x10001`, `PSCI_FEATURES` of `0x84000099` with -1, and stops on `SYSTEM_OFF` and `SYSTEM_RESET`.
4. Chapter 07's `ExitEnv` now bundles guest memory, the serial output, the stop control (`ctl`, the `control.rs` value through which a handler asks the VMM to stop with a reason) and the device bus. From now on build it only through `ExitEnv::new`, so the contract tests keep compiling when chapters 21 and 24 add fields:

:::code anchor=exit_env_new file=crates/vmm/src/vcpu/exit.rs

The checkpoint's PSCI contracts also exercise the `CPU_ON` power table that chapter 20 teaches, which you borrowed at the start of sitting B with `scripts/learner lifeline vmm::psci`; the checkpoint passes marked as borrowed. Stuck? `scripts/learner hint 08` gives four hints, from a nudge to the exact reference file.

## Checkpoint

From the repository root, run:

:::checkpoint

It runs the contract tests (vector offsets, the registers after injection, the policy sweep, one case per SMCCC function and the PSCI state table), then three runs on your Mac: `sysreg-probe` with its trace (the first capture on this page), `psci-probe` rebooting once and powering off, and `psci-probe` with `--on-reset exit`; the runs check two exit codes, 0 and 4. It ends with `CHECKPOINT 08 PASS` once your journal has an answer under every heading. Here it is against an unmodified copy of the reference, where there is no learner journal to check:

:::term source=captures/08-checkpoint.txt

Its contract tests are the first line, the three runs the next three, and your journal the last. One of the three runs, `psci-probe` rebooting once and powering off, looks like this when you run it by hand:

:::term source=captures/08-psci-reboot.txt

What now works:

- every system-register access that reaches your VMM is decoded, named and answered by a policy with a written reason;
- your VMM can make the guest take an UNDEF built exactly as the hardware builds one;
- guests power off and reset through PSCI over either conduit, and every stop maps to one exit code.

The next chapter starts from this state (the reference at the end of chapter 08).

### What's next

Chapter 09 builds the first real devices: the PL011 serial port, a state machine behind registers whose reads have side effects, and a PL031 clock beside it; it also turns chapter 07's one-entry bus into a checked one. Test guests stop printing through a debug hypercall and talk to a UART (universal asynchronous receiver-transmitter), the way Linux will.

Before you start it, close Part III with an explain-back. Below is the exit trace of a guest you have not been told about, with only `macvmm`'s exit code; its own output was thrown away, and so were its one-byte `DEBUG_PUTC` print calls. In about 200 words, say what the guest was doing and why `macvmm` stopped it. Score yourself on three points: the mechanism is right, every claim cites a record or field from the trace, and you name one experiment that would test your explanation.

:::term source=captures/08-explain-back.txt

### Open question

Our `psci-probe` powered off because it knew `0x84000008` means "off", and we answered it. Why is PSCI a *standard*? What would Linux need if every VMM invented its own way to power off and start CPUs?

## Spec hunt

- ARM ARM, register page **ESR_EL2**, "ISS encoding for an exception from MSR, MRS, or System instruction execution in AArch64 state": which field would tell you the access was to `xzr`, and what must your emulation do then?
- ARM ARM, the **AArch64.TakeException()** pseudocode and the section on exception vectors: which PSTATE bits does exception entry change, which does it keep, and where does it choose among the four rows of the vector table?
- Arm DEN 0022, the **PSCI** specification, the sections on `SYSTEM_OFF` and `PSCI_FEATURES`: what may a caller assume about a `SYSTEM_OFF` that returns, and what must `PSCI_FEATURES` answer for a function that does not exist?
