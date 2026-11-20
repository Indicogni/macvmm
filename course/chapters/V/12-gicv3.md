---
title: Why an interrupt controller, and why in the kernel
part: V
chapter: V.2
id: 12
runs: mac+browser
minutes: 270
prereqs: [11]
start_tag: ch-11
labs: [irq-lifecycle]
command: scripts/checkpoint.sh 12
expect: CHECKPOINT 12 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** why many interrupt sources need a controller; the GIC (Generic Interrupt Controller) version 3: distributor, redistributors, CPU interface, INTIDs of three kinds, SGI (software-generated interrupt), PPI (private peripheral interrupt) and SPI (shared peripheral interrupt), the IAR (interrupt acknowledge register) and EOI (end of interrupt), affinity routing; the device tree interrupt binding; `GicSpi`; freezing `IrqLine`; the in-kernel GIC as a trade you measure.
- **Core, from earlier:** interrupts as state, level and edge lines, the virtual timer, WFI (wait for interrupt) and VTIMER exits, interrupt storms, `--stats` (chapter 11); INTIDs and the memory map (chapter 05); `MPIDR_EL1`, `mrs` and `msr` (chapter 06); the PL011's `IMSC` and `RIS`, `IrqLine`, `NullIrq`, `TestIrq`, the kick and the stdin thread (chapter 09); the device tree, phandles and `--dtb-out` (chapter 10).
- **Primers (read first):** `reading-arm-specs` (finding a register page in an Arm specification).
- **Primers (review):** `host-concurrency` (which thread calls into the framework, and why a device's `Mutex` is held while it does).
- **Pointers:** the GICv3 architecture specification, Arm document IHI 0069; redistributor frames follow vCPU (virtual CPU) creation order (an Aside); LPIs and message-signalled interrupts (an Aside).
- **Forward definitions:** none.
:::

At the end of chapter 11, ten 100 ms sleeps cost your virtual machine monitor (VMM) thirty exits: ten VTIMER exits, ten WFI (wait for interrupt) exits and ten kicks. That was one source. The UART (universal asynchronous receiver-transmitter, the serial port) wants to interrupt too, so do the clock chip and every disk, and the CPU has one IRQ (interrupt request) input. Who decides which source fired, which one goes first, and which CPU takes it? And does the VMM have to stand in the middle of every one of them?

:::predict Run chapter 11's ten 100 ms sleeps again, with Hypervisor.framework's interrupt controller in the kernel. How many VTIMER and WFI exits will `--stats` count: (a) ten of each, as in chapter 11; (b) about half; (c) zero? And will the wake-ups be more punctual, less, or the same?
Write your answers and one sentence of reasoning under `## Predict` in your journal.
:::

This chapter closes rows 6 and 7 of chapter 00's problem ledger, interrupts and time: devices and the timer interrupt a guest through a real controller, and an idle guest costs almost nothing. Sitting A is the controller on paper and in the browser (1.5 hours); sitting B is the build, the measurement and three breaks (3 hours).

:::objectives
- (Sitting A) List what a controller must do for many interrupt sources, and match each job to the distributor, a redistributor or the CPU interface of a GICv3.
- (Sitting A) Convert between device tree interrupt cells and INTIDs both ways (SPI *n* is INTID 32 + *n*, PPI *n* is 16 + *n*), and say why a timer interrupt is a PPI and a UART interrupt an SPI.
- (Sitting A) Trace one level-triggered interrupt through pending, active and inactive, and predict what happens if the device never lowers its line.
- (Sitting B) Create the in-kernel GIC after `hv_vm_create` and before any vCPU, at `0x0800_0000` and `0x080A_0000`, and check the framework's sizes and timer INTIDs at start-up.
- (Sitting B) Drive the PL011's interrupt as SPI 1 (INTID 33) through `IrqLine`, describe it in the device tree, and run a guest that takes three keystrokes as three interrupts.
- (Sitting B) Measure chapter 11's timer workload with the GIC in the kernel, and state what was gained and what was given up.
:::

**Before you start.** From the repository root, run `scripts/learner start 12` to copy this chapter's journal to `learner/journal/12.md`. In sitting B, type the code into `learner/` and run from inside it.

## One input, many sources

Design the box between many sources and one IRQ input: write down its jobs before you read on.

Most lists arrive at five. **Collect** many lines into one input, and let the handler ask *which* line it was. **Rank** them, so the disk does not wait behind a chatty keyboard. **Route** each to a CPU, once there are several. **Acknowledge and finish**: the handler says "I am on it" (so the interrupt is not delivered twice at once) and later "I am done" (so the next one can come).

The fifth job: keep some lines **private**. Every CPU has its own timer, and CPU 0's timer must never interrupt CPU 1.

That box is an [interrupt controller](/build-your-own/vmm/glossary/#interrupt-controller), and Arm's is the [GIC](/build-your-own/vmm/glossary/#gic) (Generic Interrupt Controller). We use GICv3: Hypervisor.framework emulates it, and QEMU's `virt` board offers it, so stock kernels already drive it.

## Every line has a number

Each line gets an [INTID](/build-your-own/vmm/glossary/#intid) (chapter 05: the number naming an interrupt line). The GIC splits the numbers by *who may receive* the interrupt:

| INTIDs | Kind | Belongs to | Examples on our board |
|---|---|---|---|
| 0 to 15 | [**SGI**](/build-your-own/vmm/glossary/#sgi) (software-generated interrupt) | one CPU; another CPU sends it by writing a register | a kernel waking another CPU (chapter 20) |
| 16 to 31 | [**PPI**](/build-your-own/vmm/glossary/#ppi) (private peripheral interrupt) | one CPU; a device inside that CPU | the virtual timer, 27; the physical timer, 30 |
| 32 to 1019 | [**SPI**](/build-your-own/vmm/glossary/#spi) (shared peripheral interrupt) | any CPU; a device outside the CPUs | PL011 (the UART) 33, PL031 (the real-time clock) 34, virtio devices (chapter 15) from 48 |
| 1023 | special | nobody | "nothing pending" |

*Private interrupts repeat on every CPU: each CPU has its own INTID 27. Shared ones exist once.*

Chapter 11's virtual timer is *inside* each CPU, so its line is a PPI; the UART sits outside every CPU, so its line is an SPI.

## Three parts: distributor, redistributors, CPU interface

The five jobs split across three blocks: shared things live in one place, private things once per CPU.

```text
 our VMM (devices)  |  macOS kernel: Hypervisor.framework's GICv3
                    |
 PL011 raises 33 -+ |  distributor (GICD)          redistributor 0 (GICR)       CPU interface 0
 PL031 raises 34 -+-+> one, for all SPIs: forwards> vCPU 0's SGIs, PPIs: signals> ICC_* registers: interrupts> vCPU 0
 virtio raises 48+ +|  enable, priority,            (its timer: 27)              (IAR, EOI, mask)
                    |  trigger, target CPU forwards> redistributor 1 ... signals ...................> vCPU 1
```

*Our devices only raise and lower lines; everything right of the bar runs in the kernel. Shared lines go through the distributor; private ones start in a redistributor.*

- The [**distributor**](/build-your-own/vmm/glossary/#distributor) (`GICD_*` registers) holds, per SPI, enable, priority (a lower number is more urgent), level or edge trigger, and target CPU.
- One [**redistributor**](/build-your-own/vmm/glossary/#redistributor) per CPU (`GICR_*`) holds the same for that CPU's SGIs and PPIs, and forwards to its CPU: two 64 KiB frames, 128 KiB per vCPU.
- The [**CPU interface**](/build-your-own/vmm/glossary/#cpu-interface), inside each CPU, is system registers (chapter 06's `mrs` and `msr`) named `ICC_*`: priority mask, acknowledge, end of interrupt.

The five jobs, each with its home:

| Job | Where | Registers |
|---|---|---|
| **Collect**, and tell the handler which line | CPU interface | `ICC_IAR1_EL1` returns the INTID |
| **Rank** | distributor (SPIs) or redistributor (SGIs, PPIs) holds each line's priority; the CPU interface holds the CPU's mask | `GICD_IPRIORITYR`, `GICR_IPRIORITYR`; `ICC_PMR_EL1` |
| **Route** to a CPU | distributor | `GICD_IROUTER`, one per SPI |
| **Acknowledge and finish** | CPU interface | `ICC_IAR1_EL1`, then `ICC_EOIR1_EL1` |
| Keep lines **private** | one redistributor per CPU | `GICR_*` |

Routing names CPUs as chapter 06 did, by `MPIDR_EL1`'s affinity fields: each SPI's `GICD_IROUTER` holds its target's affinity. That is [**affinity routing**](/build-your-own/vmm/glossary/#affinity-routing).

**Check yourself.** Without the table: which block holds the CPU's priority mask, which names INTID 33's target CPU, and which holds the timer's INTID 27 settings? Journal question 3 asks for these.

> **Aside.** Redistributor frames follow vCPU creation order, not `MPIDR_EL1`, so a guest finds its own frame by walking them and reading each `GICR_TYPER` (IHI 0069, the redistributor registers); our guests and Linux do this. Our VMM checks at every boot that vCPU *i*'s frame sits at the base plus *i* × 128 KiB.

## The life of one interrupt

Chapter 11 taught that an interrupt is *state*. The GIC keeps four per INTID: **inactive**, [**pending**](/build-your-own/vmm/glossary/#pending-interrupt) (asked, not taken), **active** (being handled), and **active and pending** (being handled, and asking again). Follow the UART's line through one keystroke:

1. A byte arrives, the PL011 raises its line, and INTID 33 becomes pending.
2. The distributor forwards it, through the target CPU's redistributor, to that CPU's interface. If it is more urgent than the CPU's priority mask (`ICC_PMR_EL1`) and the CPU has IRQs unmasked in PSTATE, the CPU takes an IRQ exception through its vector table.
3. The handler reads the [**IAR**](/build-your-own/vmm/glossary/#iar) (interrupt acknowledge register, `ICC_IAR1_EL1`; the `1` is the interrupt *group*: 0 for firmware, 1 for kernels). It returns 33 and the interrupt becomes active; the line is still high, so *active and pending*.
4. The handler removes the *cause*: it reads the byte from `DR`, the FIFO (first in, first out queue) empties, and the PL011 lowers its line.
   With the line low, the pending half goes away: the interrupt is only active.
5. The handler writes 33 to the [**EOI**](/build-your-own/vmm/glossary/#eoi) (end of interrupt) register, `ICC_EOIR1_EL1`. The interrupt becomes inactive.

Step 5 holds the rule this chapter's breaks turn on. A [level-triggered](/build-your-own/vmm/glossary/#level-triggered) interrupt stays pending while its line is high, so if the line is still high at EOI, the CPU takes it again at once. Step 4 is not the GIC's job; it is the device's and the handler's.

If the IAR has nothing to give (another CPU took it, or the line dropped), it returns 1023, a [**spurious interrupt**](/build-your-own/vmm/glossary/#spurious-interrupt), and the handler returns without an EOI.

The lab steps one level line and one edge line through these states. Try never lowering the level line:

:::lab irq-lifecycle

If the lab does not load, here is what the lab steps through, written out by hand (a simulation, not a capture):

```text
step                          line   state of INTID 33
byte arrives                  high   pending
CPU reads IAR (returns 33)    high   active and pending
handler reads DR (FIFO empty) low    active
handler writes EOI            low    inactive          one interrupt, done
--- same, but the device never lowers the line ---
CPU reads IAR (returns 33)    high   active and pending
handler writes EOI            high   pending           taken again at once: a storm
--- an edge-triggered line ---
rising edge                   high   pending
CPU reads IAR, line held high high   active            not active and pending
handler writes EOI            high   inactive          no re-delivery
```

An edge line latches one *event* instead: holding the line high afterwards changes nothing, so an edge cannot storm this way. The price: two edges before the acknowledge become one pending interrupt, so a handler must check how much work is waiting, not count interrupts.

## Telling the guest: the interrupt binding

A guest learns where the GIC lives and which INTID each device uses from the DTB (device tree blob) of chapter 10. The GIC node says `interrupt-controller`, gets a phandle, and declares `#interrupt-cells = <3>`. The root node's `interrupt-parent` points at that phandle, so every device uses the GIC. And each device lists its lines in `interrupts`, three cells per line, an [**interrupt specifier**](/build-your-own/vmm/glossary/#interrupt-specifier):

| Cell | Means | PL011 | Virtual timer |
|---|---|---|---|
| 1 | kind: 0 SPI, 1 PPI | 0 | 1 |
| 2 | number *within that kind* | 1 | 11 |
| 3 | trigger: 4 level-high, 1 rising edge | 4 | 4 |
| INTID | SPI *n* = 32 + *n*; PPI *n* = 16 + *n* | **33** | **27** |

*The second cell is not the INTID.*

Our VMM's device tree, decompiled by `dtc` (cells in hexadecimal). Find `interrupt-parent`, the `intc@8000000` node with its two `reg` ranges (distributor, then one redistributor), the timer's four PPIs and the PL011's `<0x00 0x01 0x04>`:

:::term source=captures/12-dtb-gic.txt

The timer's four PPIs, `0x0d 0x0e 0x0b 0x0a` (INTIDs 29, 30, 27, 26), are one timer per possible owner (secure firmware, the kernel's physical timer, the virtual timer, the hypervisor's), in the order Linux's [timer binding](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/Documentation/devicetree/bindings/timer/arm,arch_timer.yaml) fixes. Only the virtual one, 27, matters to us.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 3 hours.

## Declaring the GIC

Type each piece into `learner/` as you read: the `irq` run at the end of "Three keystrokes" needs all of them. List the SDK (software development kit) headers as in chapter 01:

```sh
ls "$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/"
```

Add the functions of `hv_gic_config.h`, `hv_gic.h` and `hv_gic_parameters.h` to `learner/crates/hvf/src/ffi.rs`. A configuration object holds the two bases; `hv_gic_create` reads it:

:::code anchor=ffi_gic_create file=crates/hvf/src/ffi.rs

The call devices need, and the geometry and INTID queries:

:::code anchor=ffi_gic_set_spi file=crates/hvf/src/ffi.rs

:::code anchor=ffi_gic_params file=crates/hvf/src/ffi.rs

:::code anchor=ffi_gic_intids file=crates/hvf/src/ffi.rs

Read the comment above `hv_gic_create` in `hv_gic.h`. The GIC must be created after the virtual machine (VM) and *before any vCPU*, "so that GIC CPU system resources can be allocated"; otherwise "an error is returned". A vCPU is born with its redistributor and CPU interface, so their GIC must exist first.

## Creating it in the only window that works

In `learner/crates/hvf/src/gic.rs`, the wrapper creates a configuration, sets the two bases and creates the GIC, checking each call with chapter 01's `check`:

:::code anchor=gic_create file=crates/hvf/src/gic.rs

Skip the `msi` branch (message-signalled interrupts, an Aside below); our board passes `None`. `generation` counts VMs, so a handle kept from before a reboot (chapter 08's `SYSTEM_RESET`) cannot touch the next VM's GIC; the builder supplies it.

`create` is `pub(crate)` on purpose: the only caller is the VM builder in `learner/crates/hvf/src/vm.rs`. The builder records the request:

:::code anchor=vm_builder_with_gic file=crates/hvf/src/vm.rs

and `create` makes the GIC right after `hv_vm_create`, before the `Vm` value exists:

:::code anchor=vm_builder_gic file=crates/hvf/src/vm.rs

A `Vcpu` borrows a `Vm`, so no vCPU can exist yet: the compiler checks the ordering rule. One crate up, in `learner/crates/vmm/src/vm.rs`, the machine asks for a GIC at the board's addresses:

:::code anchor=vm_create_with_gic file=crates/vmm/src/vm.rs

## Check what you assumed

Our layout, device tree and guests *assume* a 64 KiB distributor, 128 KiB per redistributor, an SPI range holding every wired line, and timers at 27 and 30. Those numbers are the framework's, so the VMM asks once per boot, before any vCPU exists, through queries on `Gic` in `hvf/src/gic.rs` (with `handle`, which the next section needs), gathered in `learner/crates/vmm/src/vm.rs`:

:::code anchor=gic_handle_queries file=crates/hvf/src/gic.rs

:::code anchor=gic_facts_query file=crates/vmm/src/vm.rs

Every SPI the board wires, listed from the layout:

:::code anchor=layout_spis file=crates/vmm/src/vm.rs

If a future macOS changes one, the VMM refuses to start, naming both values:

:::code anchor=gic_create_checks file=crates/vmm/src/vm.rs

`Machine::build` in `learner/crates/vmm/src/machine/mod.rs` runs it right after creating the VM:

:::code anchor=machine_gic_checks file=crates/vmm/src/machine/mod.rs

The checkpoint's on-Mac test makes the same queries, on our Mac:

:::term source=captures/12-gic-live.txt

As assumed. It also reads `ID_AA64PFR0_EL1`, the CPU feature register a kernel checks before touching `ICC_*` registers: its GIC field is 1 with the GIC, 0 without.

## A line, not a call

In chapter 09 the PL011 drove an `IrqLine`, and the machine passed `NullIrq`, connected to nothing. The `IrqLine` trait itself does not change: from here on it is frozen (chapter 09's word: later chapters use it exactly as given). What is new is a line that reaches the GIC.

Why a line object and not a direct call to `hv_gic_set_spi`? Three reasons. The PL011 stays testable on any machine with `TestIrq`. The device never learns its INTID: the machine picks 33 and checks it once. And the device stays in the `vmm` crate, which forbids `unsafe`: only `hvf` makes the foreign call.

An [`IrqLine`](/build-your-own/vmm/glossary/#irqline) connected to the GIC is a `GicSpi`, in `learner/crates/vmm/src/irq.rs`. It sends its level through a backend trait:

:::code anchor=spi_backend file=crates/vmm/src/irq.rs

The real backend is `GicHandle`, from `learner/crates/hvf/src/gic.rs`:

:::code anchor=gic_handle_set_spi file=crates/hvf/src/gic.rs

:::code anchor=gic_spi_set_level file=crates/vmm/src/irq.rs

`B` is the backend: the real `GicHandle` (a cheap copyable handle to the VM's GIC, from `Gic::handle`) by default, or a fake in contract tests. `failed.swap(true)` returns the old value, so only the first failure is logged.

Two threads move this line: the vCPU thread, and chapter 09's stdin thread when a byte arrives (`Pl011::input_ready`, with the PL011's `Mutex` held, so the level sent is the device's). The per-vCPU functions in `hv_gic.h` say "Must be called by the owning thread"; the header gives `hv_gic_set_spi` no such rule, and our `irq` run below shows it working, every keystroke reaching the GIC from the stdin thread.

`GicSpi::new` refuses an INTID that is not an SPI, or that falls in the block reserved for message-signalled interrupts:

:::code anchor=spi_limits_check file=crates/vmm/src/irq.rs

> **Aside.** INTIDs from 8192 up are LPIs (locality-specific peripheral interrupts): messages a PCI (Peripheral Component Interconnect) device writes to memory instead of wires. Our board keeps INTIDs 80 to 143 for such message-signalled interrupts, which is why `GicSpi` refuses them; see IHI 0069's LPI chapter.

The machine wires the lines once, in `learner/crates/vmm/src/machine/virt.rs`; `Machine::build` passes them to chapter 09's `register_platform`:

:::code anchor=pl011_irq_wiring file=crates/vmm/src/machine/virt.rs

The PL031's alarm gets SPI 2, INTID 34, the same way; find its `<0x00 0x02 0x04>` in the device tree above. Chapter 09's helper thread for the alarm now has a line that reaches a guest.

> **Security.** A hostile guest can make us call `hv_gic_set_spi` millions of times a second. So it never chooses an INTID: the machine fixes and checks it before the guest runs. And a failing call is logged once per line, never a crash or a log flood: a lost interrupt is the guest's problem, a crashed VMM is everyone's.

## Telling the guest, in code

In `learner/crates/vmm/src/fdt/machine.rs`, the three cells get names, from Linux's `arm-gic.h` binding header:

:::code anchor=fdt_interrupt_cells file=crates/vmm/src/fdt/machine.rs

One function owns the SPI offset, so no node can forget it:

:::code anchor=fdt_spi_cells file=crates/vmm/src/fdt/machine.rs

The GIC node, with the redistributor range sized for the number of vCPUs, and the timer node with its PPIs:

:::code anchor=fdt_machine_gic file=crates/vmm/src/fdt/machine.rs

:::code anchor=fdt_machine_timer file=crates/vmm/src/fdt/machine.rs

Now put back the `with_gic` lines you left out in chapter 10: the root node's `interrupt-parent` and the `gic` call, and each PrimeCell's `interrupts`:

:::code anchor=fdt_machine_root file=crates/vmm/src/fdt/machine.rs

:::code anchor=fdt_machine_primecell file=crates/vmm/src/fdt/machine.rs

## Three keystrokes, three interrupts

The `irq` test guest is given; you only read it. It finds its redistributor (by reading each frame's affinity in `GICR_TYPER`) and wakes it: after reset a redistributor assumes its CPU is powered down and delivers nothing until software clears its sleep bit, `GICR_WAKER.ProcessorSleep`. It opens its CPU interface with priority mask `0xff`, the least restrictive value (any priority more urgent than `0xff` gets through). Then it configures INTID 33:

:::code anchor=guest_gic_enable_spi file=guests/common/gic.rs

Its handler is sitting A's five steps; it drains `DR` *before* the EOI:

:::code anchor=guest_irq_handler file=guests/irq/main.rs

:::code anchor=guest_gic_ack_eoi file=guests/common/gic.rs

Build the guests if `irq.bin` is missing (`scripts/build-guests.sh` from the repository root). From inside `learner/`, run it; when `irq: ready` appears, type `a`, `b` and `c` within ten seconds (no Enter), or `--timeout` ends the run with exit code 5:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --raw "$G/irq.bin@0x40080000" --timeout 10 --stats
```

Our capture ran from the repository root with the keys piped in. In a terminal you will also see a first line, `macvmm: console attached; Ctrl-A x quits…`. Times will differ; counts should not.

:::term source=captures/12-irq-typed.txt

`pfr0.gic=1` is the feature field the on-Mac test read. Three interrupts, all INTID 33, none spurious, three bytes, and 162 exits. We traced every exit and counted each guest-physical address:

:::term source=captures/12-irq-exits.txt

The counts add to 161 MMIO (memory-mapped I/O) exits, all PL011 registers (`--stats` lists them as `data abort`, as in chapter 07), plus the power-off hypercall; most are the guest printing its own 75 characters. The guest also wrote dozens of GIC registers and read the IAR three times, and none of that exited: the kernel's GIC answered it.

## The measurement

Chapter 11's run, with no interrupt controller:

:::term source=captures/11-timer-nogic.txt

And the same ten sleeps, through the in-kernel GIC:

:::term source=captures/12-timer.txt

Check your Predict entry. The answer is (c): `vtimer 0, wfx 0`. All 391 exits are `hvc`: one debug hypercall per printed character (chapter 03), plus a PSCI (power state coordination interface) `SYSTEM_OFF` (chapter 08). Chapter 11 paid three exits per tick; we pay none, and 0.003 s of host CPU.

If you picked (a), you held a natural belief: that the VMM must see every interrupt. With the GIC in the kernel, the tick never reaches us.

Did we lose punctuality? Single runs vary (several of chapter 11's intervals above read 110 ms), so we ran each mode three times; the first three lines use the in-kernel GIC, the last three chapter 11's mode:

:::term source=captures/12-timer-repeat.txt

Most intervals woke 0 to 5 ms late in both modes; we could not see a difference on our Mac. What we gave up is *control*: the timer, the wake-up and the delivery happen where none of our code runs, so we cannot log a tick or tighten a wake-up. For a VMM whose job is to run kernels fast, that is a good trade.

> **Production note.** Linux's KVM (its kernel-based virtual machine module, chapter 00) makes the same choice: its GIC for Arm guests, the vGIC, lives in the host kernel, and Firecracker and crosvm both use it, paying the same price in visibility.

## Breaking it on purpose

Three breaks, each predicted first; undo each before the next.

**Deliberate breakage 1: never lower the line.** In `learner/crates/vmm/src/devices/pl011.rs`, change `Pl011::update_irq` to call `set_level(true)` when the masked status is non-zero, and do nothing otherwise. Predict: after you type `a`, how many interrupts will the guest count, and will it ever print its final line?

:::term source=captures/12-never-lower.txt

The guest printed `irq: ready`, then nothing. It made about 4.2 million exits in the seven seconds after the first key, a host core nearly saturated (69% averaged over the whole 10 s run). Every EOI found INTID 33 still high, so the handler ran again at once, reading `FR` (one exit) to find the FIFO empty. It counts without end, but the main loop, which would print once the count reached 3, never got to run.

What you saw: an [interrupt storm](/build-your-own/vmm/glossary/#interrupt-storm) with no progress.
The misconception: "an interrupt is a message, sent once". It is a level, and a level is state.
The tool: `--stats`, whose data-abort count exploded while the guest's output stood still.

For contrast, we broke the *guest* instead, PL011 back to normal: an `irq` handler that never reads `DR`, counts interrupts for one second, then masks the UART in `IMSC` and prints. It needs guest edits beyond this chapter, so read our run, with one key typed:

:::term source=captures/12-no-drain.txt

About a million interrupts for one byte, and only 164 exits: the handler touched only GIC registers, which never exit. The only VMM-side traces are the host CPU and vCPU exec time in `--stats` (0.941 s and 0.396 s, up from 0.001 s and 0.000 s in the normal run).

**Deliberate breakage 2: create the GIC at the wrong time.** Three edits. In `learner/crates/hvf/src/gic.rs`, change `pub(crate) fn create` to `pub fn create`. In `learner/crates/hvf/src/lib.rs`, add `pub use gic::create;` (`GicConfig` is already exported). Then in `learner/crates/macvmm/src/first_exit.rs`, chapter 02's `first-exit`, call `hvf::create` with a `GicConfig` holding the board's two bases and `msi: None`, and generation 0: once before `VmBuilder::new().create()` and once right after the vCPU is created, printing each `Result` with `{:?}`. Making it public removes the compiler's guarantee from earlier, which is why the experiment can break the rule; undo all three edits afterwards. Predict: errors, a crash, or a GIC without a vCPU interface?

:::term source=captures/12-gic-order.txt

Two different clean errors: `HV_NO_DEVICE` with no VM yet, `HV_BUSY` once a vCPU exists. The guest still runs, without a GIC. The GIC hands out a redistributor and a CPU interface as each vCPU is created, so it must come first.

What you saw: the API refusing, as its header promised.
The misconception: "the order in which you create objects does not matter".
The tool: reading the header comment, and a wrapper whose types make the wrong order impossible.

**Deliberate breakage 3: an SPI written as a PPI.** In `spi_cells`, write `GIC_PPI` instead of `GIC_SPI` as the first cell. The VMM still drives INTID 33. Rebuild and dump the tree with the `--dtb-out` and `dtc` commands from chapter 10 (check 3 of "Your turn" below). Predict: which INTID will a guest that believes the device tree listen on?

:::term source=captures/12-ppi-dtb.txt

`<0x01 0x01 0x04>` reads as PPI 1, that is INTID 17. The guest half needs guest edits beyond this chapter, so read our run: we changed the `irq` guest to do what such a guest would, enabling INTID 17 in its redistributor instead of SPI 33, and typed three keys:

:::term source=captures/12-ppi-guest.txt

Silence, then a timeout. The device raised INTID 33, which the guest never enabled; the guest enabled INTID 17, which nothing drives.

What you saw: a guest that waits forever with nothing wrong in either half on its own.
The misconception: "the kind cell is a label; the number alone names the line".
The tool: `--dtb-out` and `dtc`, reading the promise the VMM actually made, as chapter 10 taught.

## Your turn

Check that you typed every piece: `hvf/src/ffi.rs`; `hvf/src/gic.rs`; the GIC step in `hvf/src/vm.rs`; `GicFacts`, `layout_spis` and the checks in `vmm/src/vm.rs`, called from `Machine::build`; `vmm/src/irq.rs`; `platform_irqs`; and the device tree nodes with `with_gic` restored. Then, from inside `learner/` with `G` set as before, check:

1. The `irq` run prints `irq: 3 irqs intid=33 spurious=0 other=0 bytes=3` after you type three keys.
2. The timer guest's `--stats` line shows `vtimer 0, wfx 0`:

   ```sh
   cargo run -q -p macvmm -- run --mem 64M --raw "$G/timer.bin@0x40080000" --stats
   ```

3. Your device tree shows the PL011 with `<0x00 0x01 0x04>` and the timer with `interrupts = <0x01 0x0d 0x04 0x01 0x0e 0x04 0x01 0x0b 0x04 0x01 0x0a 0x04>`, PPIs 13, 14, 11 and 10 in hexadecimal (`dtc` is installed with `brew install dtc`, chapter 10):

   ```sh
   cargo run -q -p macvmm -- run --mem 64M --raw "$G/hello.bin@0x40080000" --dtb-out v.dtb --timeout 10
   dtc -I dtb -O dts v.dtb
   ```

4. Your journal has the Predict entry, written before your first timer run.

Stuck? `scripts/learner hint 12` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (`GicSpi` refuses wrong INTIDs; the PL011's line drops on drain and on mask), the `irq` guest with `a`, `b` and `c` typed 200 ms apart, the timer guest (no VTIMER or WFI exits, host CPU under 10%) and the on-Mac GIC test, then checks your journal. On our Mac, against the reference:

:::term source=captures/12-checkpoint.txt

The `irq` step compares against this run (`{guests}` is the guest directory, `{out}` the scratch folder); the `timer` step against the timer run in The measurement:

:::term source=captures/12-irq.txt

What now works: your VMM creates the GICv3 in the one window the API allows and refuses to boot if its geometry differs from what the guest is told; the PL011 interrupts a guest through INTID 33, described in the device tree; and the timer and idle cost zero exits, with the numbers to show it.

The next chapter starts from this state (the reference at the end of chapter 12).

### What's next

Rows 1 to 7 of the ledger now work for one CPU (row 4's `CPU_ON` waits for chapter 20). That is everything a Linux kernel needs from the machine; what it still needs is to be loaded. Chapter 13 opens row 10, the boot chain: your VMM becomes the kernel's loader.

### Open question

The `irq` run's `--stats` shows zero WFI exits and nearly four seconds of in-kernel WFI. In chapter 11 the vCPU slept on *our* condition variable, and we had to wake it. Who wakes a vCPU sleeping in WFI when a UART byte arrives now, and why does it no longer need a kick from us?

## Spec hunt

- GICv3 architecture specification (Arm IHI 0069), the section on **INTIDs** in the chapter "Distribution and routing of interrupts": which INTID ranges are reserved, and what are 1020 to 1023 used for besides 1023?
- IHI 0069, the register page for **ICC_EOIR1_EL1** (and `ICC_CTLR_EL1.EOImode`): what does an EOI write do in two steps (priority drop, then deactivation), and when would a kernel want them separated?
- The SDK header `hv_gic.h`, the comment on **hv_gic_set_spi**: what does a `level` of `false` do to an edge-triggered interrupt, and which INTIDs make it return `HV_BAD_ARGUMENT`?
