---
title: Rings and a doorbell: the virtio-mmio transport
part: VII
chapter: VII.1
id: 15
runs: mac+browser
minutes: 270
prereqs: [14]
start_tag: ch-14
labs: [virtio-status, virtqueue-visualizer]
command: scripts/checkpoint.sh 15
expect: CHECKPOINT 15 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** why virtio exists (one driver for every hypervisor, and far fewer exits), before any register; DMA (direct memory access), a device reading and writing RAM by itself (bus mastering); the doorbell (`QueueNotify`) and the used-buffer interrupt; the virtio-mmio version 2 transport, each register derived from a question; the device status state machine and feature negotiation; `DEVICE_NEEDS_RESET`; empty slots.
- **Core, from earlier:** exit cost (chapters 03 and 14); paravirtual devices (chapter 00); `GuestMemory` and `check_range` (chapter 04); the virtio slots (chapter 05); `MmioDevice` and RAZ/WI (chapter 09); the device tree (chapter 10); level-triggered lines (chapter 11) and `TestIrq` (chapter 09).
- **Primers (review):** `reading-arm-specs` (its section on MUST and SHOULD in the virtio specification); `host-concurrency` (locks and lost updates, for the interrupt's mutex).
- **Pointers:** emulated NVMe (Non-Volatile Memory Express) and AHCI (Advanced Host Controller Interface) disk controllers, which have rings in real hardware (an Aside); the virtio 1.2 specification, section 4.2.2; virtio over PCI (a Production note).
- **Forward definitions:** virtqueue, the ring the driver and device share (chapter 16 lays it out); descriptor, one entry of that ring (chapter 16); the device worker thread (chapter 17); TOCTOU, time of check to time of use (chapter 16). Each is defined in a sentence where it first appears.
:::

Chapter 14 had you measure the cost of console text: between 2.4 and 2.7 virtual machine (VM) exits for every byte (2.4 for the shell's output, 2.7 for the boot log). Take the boot log: its 12,093 bytes left our PL011 serial port at a cost of about 32,800 memory-mapped I/O (MMIO) exits ([VM exits](/build-your-own/vmm/glossary/#vm-exit) caused by device register accesses). Now imagine that machinery behind a disk, where a 4 KiB block is a small request and a 64 MiB file an ordinary one. How could any design do better, while the guest still has to tell us what to write?

:::predict A guest writes one 4 KiB block. Estimate the VM exits for (a) a disk built like our PL011, one register access per byte, (b) an emulated NVMe (Non-Volatile Memory Express) controller, the interface of most modern SSDs (solid-state drives), whose driver also writes requests into a queue in RAM and pokes one register, and (c) a virtio disk. Is (b) about the same as (c)?
Write your three numbers and one sentence of reasoning under `## Predict` in your journal (its prompt repeats this question). Coarse answers are fine. Sitting A measures the PL011's cost per byte, which gives (a), and measures (c) on a real Mac; (b) we can only estimate. The answer comes in "Why a standard: virtio" below, after the measurements.
:::

This chapter works on row 8 of the problem ledger, bulk I/O at a reasonable cost: by its end the transport that every fast device of this course uses is in place, and chapters 16 to 19 build the devices behind it.

:::objectives
- (Sitting A) From the measured cost of a PL011 byte and of one exit, explain why per-byte I/O is unaffordable, and derive the alternative: the data stays in guest RAM, the device reads and writes it there (DMA), one exit says "look now" (a doorbell) and one interrupt says "done".
- (Sitting A) Compare virtio honestly with an emulated NVMe controller, which also uses rings and doorbells, and say what virtio's design for virtual machines adds.
- (Sitting B) Derive each virtio-mmio register from a question the ring raises, and implement them as an `MmioDevice`, with every access width answered.
- (Sitting B) Enforce the status state machine (bits in order, features checked, queues frozen, a bad ring answered with `DEVICE_NEEDS_RESET`), and drive the interrupt as a level line.
- (Sitting B) Serve 32 slots, the empty ones answering DeviceID 0 on the bus while absent from the device tree, and verify it with `virtio-probe`.
:::

**Before you start.** From the repository root, run `scripts/learner start 15`, which copies this chapter's journal to `learner/journal/15.md`. Sitting A runs the finished reference from the repository root; sitting B is code in `learner/crates/vmm/src/virtio/`: `mod.rs`, `queue.rs`, `interrupt.rs`, `null.rs` and `mmio.rs`, in an order given at its start.

## What one byte costs

Here is chapter 14's measurement on a plain boot, every MMIO exit recorded by chapter 07's trace. `scripts/run-linux.sh` runs from the repository root, so give it absolute paths:

```sh
mkdir -p /tmp/ch15
scripts/run-linux.sh --test boot --stats --trace exits:/tmp/ch15/boot.jsonl:mmio
```

:::term source=captures/15-pl011-boot.txt

Skip to the stats: `serial_written=12093`, and `data abort 32811`, the stage-2 faults that MMIO accesses become (chapter 07). Which registers took them? Count the trace by address and direction:

:::term source=captures/15-pl011-count.txt

Two lines carry nearly everything: 12,093 writes to `0x9000000`, the PL011's data register, one per byte; and 20,490 reads of `0x9000018`, its flag register, which Linux polls before (and, in earlycon, after) each byte. Counting every PL011 line, that is 32,795 exits for 12,093 bytes, about 2.7 per byte: higher than the 2.4 of chapter 14's shell output, because so much of the boot log goes through earlycon.

Chapter 03 measured one bare HVC (hypervisor call) round trip at about 1.4 µs, and an MMIO exit costs more (decode, bus lookup, device lock), so take 1.4 µs as a floor. A 4 KiB block at 2.7 exits per byte is about 11,000 exits, at least 15 ms of entering and leaving the guest. A 64 MiB file is about 180 million exits: at least four minutes, for a copy your Mac's own disk does in a fraction of a second. Faster exits cannot close that gap; only fewer exits can.

## Leave the data where it is

When the guest writes a block, the data is already in its RAM: the guest put it there. And our VMM (virtual machine monitor) can already read guest RAM safely, through chapter 04's `GuestMemory`. So why push the bytes through a register one at a time?

Here is the design that follows. The guest writes a short *description* of the request into its own RAM: "4096 bytes at address `0x4410_0000`, write them to sector 8" (a disk counts in 512-byte sectors). It then touches one register, once, meaning "look now": one exit. Our device reads the description, copies the 4096 bytes straight out of guest RAM, does the write, puts a "done" note back into RAM, and raises an interrupt; with chapter 12's in-kernel GIC (Generic Interrupt Controller), raising it costs no exit.

Real hardware works the same way: a disk controller reads and writes main memory by itself, which is called [**bus mastering**](/build-your-own/vmm/glossary/#bus-mastering), or [**DMA**](/build-your-own/vmm/glossary/#dma) (direct memory access), the forward definition chapter 04 promised. The register that says "look now" is a [**doorbell**](/build-your-own/vmm/glossary/#doorbell), and the interrupt that says "done" is a [**used-buffer notification**](/build-your-own/vmm/glossary/#used-buffer-notification): virtio calls a buffer the device has finished with "used". Our device "does DMA" by copying through `GuestMemory`. In the picture, EL1 (exception level 1) is the level the guest kernel runs at.

```text
 guest kernel (EL1)              guest RAM                    our VMM (host)
 -----------                     ---------                    --------------
 1. write the data       --->    [ data: 4096 bytes ]
 2. write a description  --->    [ ring: addr, len  ]
 3. store to the doorbell ------------ one VM exit ------->   4. read the ring
                                 [ data ] <--- copy (DMA) --- 5. do the I/O
                                 [ ring: done, len  ] <------ 6. write "done"
 8. take the interrupt   <------------ level line -------    7. raise the line
```

*Only step 3 is an exit; on virtio-mmio the guest's interrupt handler adds two register accesses (sitting B), however many bytes moved.*

The description lives in a [**virtqueue**](/build-your-own/vmm/glossary/#virtqueue): a ring of fixed-size slots in guest RAM, reused in a circle, so the guest can queue many requests behind one doorbell (chapter 16 lays it out). The visualizer, like the specification, calls one such description a [**descriptor**](/build-your-own/vmm/glossary/#descriptor). Try its ten-minute toy: one descriptor, one doorbell, one "done".

:::lab virtqueue-visualizer

## Why a standard: virtio

Early hypervisors each invented their own ring format, which cost guests one disk driver per hypervisor. [**virtio**](/build-your-own/vmm/glossary/#virtio) is the agreement that ended this: a standard, maintained by the OASIS consortium (Organization for the Advancement of Structured Information Standards), for [paravirtual devices](/build-your-own/vmm/glossary/#paravirtual-device), designed for virtual machines rather than copied from hardware. The same Linux, FreeBSD and U-Boot drivers work on QEMU, Firecracker, crosvm and, by the end of this part, your VMM. (U-Boot is a bootloader; the [U-Boot primer](/build-your-own/vmm/primers/u-boot/) introduces it.)

Virtio has two layers. The *device* layer says what a disk or an entropy source (a source of random numbers) means (chapters 17 to 19). The *transport* says how a driver finds a device, configures it and rings its doorbell. This chapter builds the transport called [**virtio-mmio**](/build-your-own/vmm/glossary/#virtio-mmio): one MMIO window per device, which on our board are chapter 05's 32 slots of `0x200` bytes from `0x0a00_0000`.

Is this not what a real NVMe drive does? Partly. NVMe, and the older AHCI (Advanced Host Controller Interface) behind SATA (Serial AT Attachment) disks, are hardware disk controllers that already use rings in RAM, DMA and doorbell registers. A VMM can emulate one, and guests then use their stock drivers.

> **Aside.** The NVMe base specification, at [nvmexpress.org](https://nvmexpress.org/specifications/), describes NVMe's submission and completion queues and their doorbells; its Doorbell Buffer Config command, added in NVMe 1.3, is the shadow-doorbell mechanism mentioned below.

Back to your prediction. We have no NVMe controller in macvmm, so we have not been able to check (b). What we can measure is (c). The finished reference (its virtio disk is chapter 18; your VMM has no `--disk` yet) booted Linux, which read a whole 64 MiB image of zeros:

```sh
dd if=/dev/zero of=/tmp/ch15/disk64.img bs=1m count=64
scripts/run-linux.sh --test vda --stats --disk /tmp/ch15/disk64.img --trace exits:/tmp/ch15/vda.jsonl:mmio
```

:::term source=captures/15-vda-read.txt

Now count only the exits at slot 0, `0x0a00_0000` to `0x0a00_01ff`:

:::term source=captures/15-vda-count.txt

That is 85 exits for 64 MiB; the PL011 design would have needed about 180 million. Most lines are one-time setup. The steady state is 20 writes to `0x050`, the doorbell, and 12 reads of `0x060` with 12 writes to `0x064`, the interrupt's "what happened?" and "handled". The run's other 33,000-odd exits are the PL011 console again.

So a lone 4 KiB block costs about 3 exits (a doorbell, then two accesses in the interrupt handler), and in bulk well under one per block, because each request carries many blocks (up to 126 buffers in one chain, chapter 16) and Linux queues several requests behind one doorbell.

Now (b) against (c): both are thousands of times below (a). An emulated NVMe controller needs a submission doorbell per batch, a completion-queue head write to release the completions it consumed, and, depending on the driver, register writes to mask and unmask interrupts; we expect a few exits per batch, but have not measured it, and NVMe 1.3's shadow doorbells let a driver skip most of them. The difference is where each started. Virtio was designed for virtual machines: no data and no request description ever passes through a register, notification suppression ("do not notify me", through flags in RAM, chapter 16) is in its base ring format, one driver per device class works on every hypervisor, and there are no hardware quirks to copy. And the standard says what a device does with a misbehaving driver (it sets `DEVICE_NEEDS_RESET`, later in this chapter), where an emulated controller must copy whatever the real hardware happened to do.

That is the misconception to drop: virtio is not a protocol on a wire. It is a contract about shared memory, and the registers only find the rings and signal.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 3 hours.

## Every register answers a question

A virtqueue is really three areas in RAM: the descriptions, the driver's list of new ones, and the device's list of finished ones (chapter 16), so one queue needs three addresses. A device can have several queues (a console has one per direction), so the driver must say which queue it is configuring. Devices also differ in optional abilities, such as whether a disk is read-only or whether the ring may batch notifications; virtio calls each one a feature bit, and driver and device must agree on the set (more below). Features are a bit set larger than one register (64 bits in every device of this course, more in the specification), so they go 32 bits at a time, through a selector register; a selector beyond 1 reads 0 here.

Sitting B builds five files in `learner/crates/vmm/src/virtio/`, and this order compiles at every step:

1. `mod.rs`: the device IDs, feature and status constants, and the `VirtioDevice` trait.
2. `queue.rs`: one queue's registers (described in "Queue registers, and when they freeze").
3. `interrupt.rs`: `VirtioInterrupt`, the line plus `InterruptStatus` (described in "The doorbell, and 'done'").
4. `null.rs`: the empty device.
5. `mmio.rs`: the transport itself.

If you would rather follow the text in reading order, stub `Queue` and `VirtioInterrupt` as empty structs when the trait first needs them, and fill them in when their sections arrive.

Each question then gets a 32-bit register at a fixed offset from the slot's base:

| The driver needs to ask or say | Register (offset) |
|---|---|
| Is this a virtio device at all, and which transport version? | `MagicValue` (`0x000`) = `0x74726976`, `Version` (`0x004`) = 2 |
| Which device is it? | `DeviceID` (`0x008`): 2 disk, 4 entropy, 0 nobody home; `VendorID` (`0x00c`), who made it (ours reads "MMVM") |
| Which optional features do you offer, and which do I take? | `DeviceFeatures` (`0x010`) and `DriverFeatures` (`0x020`), with selectors `DeviceFeaturesSel` (`0x014`) and `DriverFeaturesSel` (`0x024`) |
| Which queue am I configuring, and how big may it be? | `QueueSel` (`0x030`), `QueueNumMax` (`0x034`), `QueueNum` (`0x038`) |
| Where are its three areas? | `QueueDesc`, `QueueDriver`, `QueueDevice`, each a low and high half (`0x080` to `0x0a4`) |
| This queue is ready | `QueueReady` (`0x044`) |
| Look now! | `QueueNotify` (`0x050`), the doorbell |
| What happened? I handled it | `InterruptStatus` (`0x060`), `InterruptACK` (`0x064`) |
| Where am I in setting up, and have you given up on me? | `Status` (`0x070`) |
| The device's own settings (a disk's size) | the [configuration space](/build-your-own/vmm/glossary/#configuration-space) (config space for short) from `0x100`, and `ConfigGeneration` (`0x0fc`) |
| Shared-memory regions and per-queue reset | `SHMSel`, `SHMLen`, `SHMBase` (`0x0ac` to `0x0bc`) and `QueueReset` (`0x0c0`): features we never offer. `SHMLen` and `SHMBase` read all-ones, meaning "no such region"; `QueueReset` reads 0 |

`MagicValue` is the four characters `virt` read as a little-endian 32-bit number: `v` is `0x76`, the lowest byte. The constants, in `learner/crates/vmm/src/virtio/mmio.rs`:

:::code anchor=virtio_mmio_registers file=crates/vmm/src/virtio/mmio.rs

The authority is the [virtio 1.2 specification](https://docs.oasis-open.org/virtio/virtio/v1.2/cs01/virtio-v1.2-cs01.html) (free from OASIS), section 4.2.2, "MMIO Device Register Layout". Read it with the `reading-arm-specs` primer's habit: a sentence with MUST binds the driver or the device. In the reference's comments, a section sign followed by a number is a section of that specification; the other tags in its comments refer to the reference's own design documents, and you need none of them here.

## Is anybody there? The empty slot

QEMU's board lists all 32 virtio-mmio transports in its device tree, populated or not. We list only populated slots, but a guest that scans the fixed addresses (as our probe does) must still get a defined answer rather than an unhandled-MMIO fault. The specification defines an empty transport: valid `MagicValue` and `Version`, **DeviceID 0**, and "the driver MUST ignore a device with DeviceID 0x0".

Every slot holds a device model behind a trait, with two implementations within two chapters (the empty one now, the entropy device in chapter 17). In `learner/crates/vmm/src/virtio/mod.rs`, declare every method with exactly these signatures, because the contract tests' mock device implements all of them (stub `Queue` and `VirtioInterrupt` now if you have not written them yet):

:::code anchor=virtio_device_trait file=crates/vmm/src/virtio/mod.rs

Some names arrive later. `Queue` is this chapter's register file for one queue (below). `VirtioInterrupt` is the interrupt line plus `InterruptStatus` (the last section). `VirtioError` is "why a device refused"; any enum will do today. `GuestMemoryOrdered` has been in your files since chapter 04 (chapter 16 explains it). `QueueProgress` is an enum with `Drained` and `MoreWork`, for chapter 17. Today your devices give `read_config`, `write_config` and `process_queue` trivial bodies.

The device IDs, and the empty device in `learner/crates/vmm/src/virtio/null.rs`, which can never activate:

:::code anchor=virtio_ids file=crates/vmm/src/virtio/mod.rs

:::code anchor=virtio_null_device file=crates/vmm/src/virtio/null.rs

The machine puts a transport in all 32 slots, in `learner/crates/vmm/src/machine/virt.rs`; chapter 17 replaces this with a version that also builds devices:

:::code anchor=virtio_register_empty file=crates/vmm/src/machine/virt.rs

`insert_transport` wraps the transport in `Arc<Mutex<…>>` and calls chapter 09's `Bus::insert` with the slot's base and its `0x200`-byte window. `virtio_populated` returns the slots the command line filled; your VMM has no device options yet, so it returns none and the check always passes today. `register_virtio_with` is the version chapter 17 adds.

Only populated slots appear in the device tree. Each node gives the window, the level-high (level-triggered, chapter 11) SPI (shared peripheral interrupt) `16 + i`, which is INTID `48 + i` (chapter 05), and `dma-coherent`: the device's memory accesses see the same data as the CPU caches, so the guest needs no [cache maintenance](/build-your-own/vmm/primers/caches/) around DMA. In `learner/crates/vmm/src/fdt/machine.rs`:

:::code anchor=fdt_machine_virtio_slot file=crates/vmm/src/fdt/machine.rs

## One transport per slot

The transport is the `MmioDevice` the bus sees for a slot. It owns the registers and the status machine; the device behind it owns its queues once activated, and never touches a register:

:::code anchor=virtio_mmio_struct file=crates/vmm/src/virtio/mmio.rs

The `notifier` field belongs to chapter 17's worker thread; here it is always `None`.

What the tests call, and where it must be public:

- `vmm::virtio::VirtioMmio` and `vmm::virtio::VirtioInterrupt` (re-exported from `mmio.rs` and `interrupt.rs`), and the modules `vmm::virtio::features` and `vmm::virtio::status`.
- `vmm::virtio::mmio::{MAGIC_VALUE, VENDOR_ID, reg}`, the constants shown above; and chapter 09's `vmm::irq::TestIrq`.
- `VirtioMmio::new(device: Arc<Mutex<dyn VirtioDevice>>, interrupt: Arc<VirtioInterrupt>, mem: Option<Arc<dyn GuestMemoryOrdered>>) -> Result<VirtioMmio, &'static str>`. Memory is an `Option` because a device that never activates needs none. A refusal is a bug in our VMM, never the guest's doing, so a fixed message is enough. It refuses a device that does not offer `VIRTIO_F_VERSION_1`, offers any feature in `NEVER_OFFERED` (below), has a queue size that is not a power of two from 1 to 32768, or has a config space that does not fit in the window (more than `0x100` bytes). That last check bounds every later config access.
- `VirtioMmio::empty()` for an empty slot; `queue(i)`, an `Option<&Queue>`; and `config_changed()`, which bumps `ConfigGeneration` and raises a configuration interrupt.
- `VirtioInterrupt::new(line: Arc<dyn IrqLine>)`, with the methods the transport and devices call: `signal_used` (bit 0), `signal_config` (bit 1), `ack(bits)`, `set_needs_reset` and `needs_reset`.

One more case needs a rule. If a device's code panics while it holds its mutex, Rust marks the mutex **poisoned** (the `host-concurrency` primer's note on poisoning), because the data inside may be half-updated. The transport then treats the slot as dead: `is_dead()` asks the mutex whether it is poisoned, `live_device()` locks the device or returns `None` for a dead one, and every access to a dead slot is RAZ/WI with a rate-limited warning from `dead_device_warning()`. A dead slot is a bug in our VMM, and the guest cannot revive it.

Section 4.2.2 says the driver MUST use only aligned 32-bit accesses to the control registers. A driver that does not is broken or hostile, and chapter 09's rule applies: answer every access, RAZ/WI ([read as zero, write ignored](/build-your-own/vmm/glossary/#raz-wi)) plus a rate-limited warning. Config space holds device-defined fields of different widths, so there our device takes 1, 2, 4 or 8 bytes, each checked against the device's config length:

:::code anchor=virtio_mmio_access file=crates/vmm/src/virtio/mmio.rs

Reads, with the empty slot handled first:

:::code anchor=virtio_read_reg file=crates/vmm/src/virtio/mmio.rs

And writes, which an empty slot ignores. Each case hands off to a method the following sections build; two rules live here directly: `QueueReady` takes only 0 or 1, and `InterruptACK` keeps only the two defined bits (`INT_MASK`, bits 0 and 1):

:::code anchor=virtio_write_reg file=crates/vmm/src/virtio/mmio.rs

The probe guest scans all 32 slots, tries wrong-sized reads (1, 2 and 8 bytes) of `MagicValue`, and counts the device tree's `virtio_mmio` nodes. Chapter 13's loader runs its ELF (Executable and Linkable Format) file directly. From inside `learner/`, with `G` set as in chapter 09:

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --kernel $G/virtio-probe --timeout 10
```

The reference's run, recorded by the checkpoint:

:::term source=captures/15-probe-empty.txt

All 32 slots say `virt`, version 2, device 0; the device tree lists none; every wrong-sized read came back zero (the rate limit keeps the log to ten warnings).

## The handshake is a state machine

What does it take to bring a device up? We gave the reference chapter 17's entropy device (`--rng`) in slot 0 and traced the probe's handshake. This run uses the reference, because your VMM has no `--rng` yet, so it starts from the repository root, with its own `G` (the directory from sitting A may be gone after a reboot, hence the `mkdir`):

```sh
cd ..
mkdir -p /tmp/ch15
G=target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --mem 64M --rng --kernel $G/virtio-probe --timeout 10 --trace exits:/tmp/ch15/rng.jsonl:mmio
grep -o '"ipa":"0xa0000[^}]*' /tmp/ch15/rng.jsonl | cut -d, -f1,2,5
```

:::term source=captures/15-probe-rng.txt

:::term source=captures/15-handshake-trace.txt

The trace drops leading zeros, so slot 0's `Status` register, `0x0a00_0070`, appears as `0xa000070`. The three reads at `0xa000000` returning `0x0`, after the magic and version, are the wrong-sized reads, answered RAZ.

Read the `Status` writes (`0xa000070`, `"wnr":true`): `0`, `1`, `3`, `0xb`, `0xf`. Each step adds one bit to the [**device status**](/build-your-own/vmm/glossary/#device-status), and each bit is a promise:

:::code anchor=virtio_status_bits file=crates/vmm/src/virtio/mod.rs

The bit values are not in step order: `FEATURES_OK` (8) was added to the specification after `DRIVER_OK` (4), so the driver sets 8 before 4.

| Status | Bit added | Meaning |
|---|---|---|
| `0x0` | (none) | reset the device |
| `0x1` | ACKNOWLEDGE | "I have seen a virtio device" |
| `0x3` | DRIVER | "and I have a driver for it" |
| `0xb` | FEATURES_OK | "these are the features I will use"; the device may refuse |
| `0xf` | DRIVER_OK | "the queues are set up, start working" |
| `+0x80` | FAILED | "I gave up on this device"; accepted at any step and latched until `Status` is written 0 |

Between `0x3` and `0xb`, the probe set `DeviceFeaturesSel` to 1, read `0x1` (bit 32 of the whole set), and accepted exactly that. Between `0xb` and `0xf` it configured queue 0: `QueueNumMax` said 64, the probe chose 16, wrote three ring addresses as halves, and set `QueueReady`. Then one doorbell (`0xa000050`), one `InterruptStatus` read of `0x1` (a used buffer) and one `InterruptACK`.

Step through the handshake in the lab, then try its "driver misbehaves" presets:

:::lab virtio-status

The device enforces that order, because each step commits it to something. Bits only accumulate; `FAILED` is allowed at any time, and writing 0 is the one way back. `STATUS_STEPS` is the list of the four legal values, `[0x1, 0x3, 0xb, 0xf]`, in order: the steps of the table above.

:::code anchor=virtio_status_machine file=crates/vmm/src/virtio/mmio.rs

`DRIVER` implying `ACKNOWLEDGE` is a compatibility rule: U-Boot resets a device and then writes `DRIVER` alone, QEMU accepts that, and `ACKNOWLEDGE` gates nothing in the device.

## Features: the device has the last word

This exchange is [**feature negotiation**](/build-your-own/vmm/glossary/#feature-negotiation). Why must the device be able to refuse? Features change what the queues and the config space look like, so both sides must agree *before* any queue is set up. And the driver may accept a bit the device never offered, by mistake or on purpose. `FEATURES_OK` is the device's one chance to say no before it is committed.

The one bit every device must offer is `VIRTIO_F_VERSION_1`, bit 32: "I follow virtio 1.0 or later". The older *legacy* virtio had a different register layout, served by transport version 1, which we do not implement. `NEVER_OFFERED` lists features whose ring formats or mechanisms our devices do not implement; `VirtioMmio::new` refuses a device that offers one, so no driver can ever negotiate them:

:::code anchor=virtio_features file=crates/vmm/src/virtio/mod.rs

The driver's choice is collected half by half, and only while `DRIVER` is set and `FEATURES_OK` is not:

:::code anchor=virtio_driver_features file=crates/vmm/src/virtio/mmio.rs

At the `FEATURES_OK` write, everything accepted must have been offered, `VERSION_1` included, or the bit does not latch; section 3.1.1 tells the driver to read `Status` back (the probe's `0xb` read) and give up if it is clear:

:::code anchor=virtio_features_ok file=crates/vmm/src/virtio/mmio.rs

## Queue registers, and when they freeze

Queue registers act on the queue `QueueSel` names; a selector beyond the last queue reads 0 and ignores writes. `QueueNum` must be a power of two from 1 to `QueueNumMax`, because chapter 16's ring arithmetic depends on it. Once a queue is ready, or `DRIVER_OK` is set, its registers are frozen:

:::code anchor=virtio_queue_writable file=crates/vmm/src/virtio/mmio.rs

One exception: the `QueueReady` register stays writable while the others are frozen, so a driver can write 0 to it before `DRIVER_OK` and unfreeze the queue. Only `DRIVER_OK` freezes `QueueReady` itself:

:::code anchor=virtio_ready_freeze file=crates/vmm/src/virtio/mmio.rs

A ring address arrives as two 32-bit halves, in either order, possibly twice. Each write replaces one half and keeps the other; never build the address by adding, which would mix a stale half into the new value:

:::code anchor=virtio_ring_addr file=crates/vmm/src/virtio/mmio.rs

Your `Queue` this chapter is a register file, in `learner/crates/vmm/src/virtio/queue.rs`: `new(max_size)`, getters (`size`, `ready`, `desc_table`, `avail_ring`, `used_ring`), setters, and `size_ok`. It also needs `validate`, called at `DRIVER_OK`, which for now checks one rule: each ring lies entirely inside one RAM region (chapter 04's `check_range`), with lengths `16·N`, `6 + 2·N` and `6 + 8·N` bytes for a queue of size `N` (chapter 16 derives them and adds the remaining checks).

## DRIVER_OK: the device commits

`DRIVER_OK` is where the device starts trusting the ring addresses, so this is where they are checked, once, before anything uses them. A bad ring neither panics nor is ignored. The device sets [`DEVICE_NEEDS_RESET`](/build-your-own/vmm/glossary/#device-needs-reset) (64 in `Status`), raises a configuration interrupt (bit 1 of `InterruptStatus`), and refuses all work until the driver writes 0. (This is not the "dead" slot of a poisoned mutex: a device that needs reset recovers when the driver resets it.)

:::code anchor=virtio_driver_ok file=crates/vmm/src/virtio/mmio.rs

The interrupt side latches the flag and raises the line in one step, under the lock that guards `InterruptStatus`:

:::code anchor=virtio_needs_reset file=crates/vmm/src/virtio/interrupt.rs

> **Security.** The guest chooses every value written to this window: unoffered feature bits, a `QueueSel` of four billion, a ring at the top of the address space. None of it may crash the VMM or make a device use unchecked memory. The state machine is that boundary: it decides when values are accepted, checked, and frozen.

Writing 0 to `Status` resets the device. The transport locks the device first, which matters from chapter 17 on, when a [**device worker thread**](/build-your-own/vmm/glossary/#device-worker-thread) (a host thread that does one device's queue work) may be mid-request: the lock makes it finish before the queues are dropped.

:::code anchor=virtio_reset file=crates/vmm/src/virtio/mmio.rs

## The doorbell, and "done"

A `QueueNotify` write carries a queue index. It counts only for a healthy, activated device and an existing ready queue; anything else is a warning:

:::code anchor=virtio_notify file=crates/vmm/src/virtio/mmio.rs

With no worker thread, the transport calls the device's `process_queue` on the vCPU (virtual CPU) thread that took the exit, at most `INLINE_BATCHES` (4) times, so a guest cannot keep its own vCPU busy forever. Any error becomes `DEVICE_NEEDS_RESET`:

:::code anchor=virtio_process_inline file=crates/vmm/src/virtio/mmio.rs

:::code anchor=virtio_report_error file=crates/vmm/src/virtio/mmio.rs

The other direction is `InterruptStatus`: bit 0 for "used buffers added", bit 1 for "configuration changed" (including `DEVICE_NEEDS_RESET`). The driver reads it, handles the causes, and writes the bits it handled to `InterruptACK`. The line is [level-triggered](/build-your-own/vmm/glossary/#level-triggered) (chapter 11): high exactly while `InterruptStatus` is not zero, so an interrupt cannot be lost while the guest has interrupts masked. In `learner/crates/vmm/src/virtio/interrupt.rs`:

:::code anchor=virtio_interrupt_level file=crates/vmm/src/virtio/interrupt.rs

> **Under the hood.** Why one mutex for the bits and the line? From chapter 17 on, a worker thread sets bit 0 while a vCPU writes `InterruptACK`. As separate steps, the vCPU could compute "now zero" and lower the line right after the worker raised it; the guest would sleep forever on a ring with work in it.

One more register guards config space. A disk's capacity is 64 bits, read as two 32-bit halves, and the device may change it between the reads. [`ConfigGeneration`](/build-your-own/vmm/glossary/#configgeneration) is a counter the device bumps on every change; the driver reads it before and after the fields and retries if it moved. Linux did exactly that in our 64 MiB run:

:::term source=captures/15-linux-handshake.txt

Find `0xa0000fc` (generation `0x0`), then the capacity at `0xa000100` and `0xa000104` (`0x20000` sectors, 64 MiB), then `0xa0000fc` again. Journal question 3 asks what race that pattern closes.

> **Production note.** Most VMMs offer virtio over PCI (Peripheral Component Interconnect), where the guest enumerates a bus and interrupts are memory writes (message-signalled interrupts). Firecracker was built on virtio-mmio alone, and still uses it by default, choosing it to keep a whole PCI emulation, and its attack surface, out of the VMM.

## Breaking it on purpose

**Deliberate breakage 1: accept queue writes after `DRIVER_OK`.** In `selected_writable`, delete `frozen ||` (and the `frozen` line), so only a ready queue is frozen; in `selected_writable_ready`, delete the early return after `DRIVER_OK`. Predict: does anything fail, and what could a guest now do? Your `learner/` is its own git repository, so do it there: from the repository root, commit your working transport first (`git -C learner add crates && git -C learner commit -m 'ch15 works'`), make the edit, run `scripts/checkpoint.sh 15`, then undo the edit with `git -C learner checkout -- crates`. The capture below was made on a separate copy of the reference, hence the `--impl <tree>`:

:::term source=captures/15-break-frozen.txt

One contract test fails: after `DRIVER_OK`, the guest made queue 1 ready and resized it. The probe passes, since it never writes a queue after `DRIVER_OK`. Our device copied the queues at `DRIVER_OK`, so nothing crashed; but a VMM that read ring addresses from its registers at notify time would now walk rings no `validate` ever saw: the guest's half of a TOCTOU problem (time of check to time of use), chapter 16's subject.

What you saw: one failing state test, a passing probe, no crash. The misconception it exposes: "a register is only data; the device can sort it out later". A state machine is a security boundary. The tool that finds it: a contract test that drives the transport through `MmioDevice::read` and `write` exactly as a trapped vCPU access would.

## Your turn

Before the checkpoint, check:

1. Your `virtio/{mod.rs, mmio.rs, null.rs, interrupt.rs, queue.rs}` build, and the machine puts a transport in all 32 slots.
2. `virtio-probe`, run from inside `learner/`, prints the four lines of the empty-slot run above.
3. Your journal has the Predict entry, written before you read sitting A's measurements.

Stuck? `scripts/learner hint 15` gives four hints, from a nudge to the exact reference function.

> **Try it.** Take the test's mock device, which offers `VERSION_1` and device bit 0, accept bit 29 (`VIRTIO_F_EVENT_IDX`) as well, write `0xb` to `Status` and read it back. Predict the value first. Then accept only bit 29, without `VERSION_1`: does the answer change? Start from the test `features_ok_requires_version_1` in `course/checkpoints/15/contract/virtio_mmio_state.rs`, whose helper `negotiate(lo, hi)` drives the whole sequence and returns `Status` read back.

## Checkpoint

From the repository root, run:

:::checkpoint

It runs 24 contract tests, which drive your transport through `MmioDevice` with a mock device, guest memory in a vector and a `TestIrq` (every rule of sitting B, from status order to `InterruptACK` lowering the line), then `virtio-probe`, expecting the four lines of the empty-slot run and exit code 0. On the reference:

:::term source=captures/15-checkpoint.txt

What now works: 32 virtio-mmio windows; a transport that negotiates features, validates rings once at `DRIVER_OK` and fails safe; a doorbell that reaches a device; and an interrupt that is a level. The next chapter starts from this state (the reference at the end of chapter 15).

### What's next

Our transport knows where the rings are, and no device of ours reads them yet. Chapter 16 lays out the split virtqueue (a descriptor table, an available ring and a used ring) and walks it as a hostile guest would rather we did not: a guest can rewrite a descriptor while we read it, point a chain at itself, or claim four gigabytes.

### Open question

The driver writes `QueueDescLow` and `QueueDescHigh`, a guest-physical address, into two registers. What must you check before you activate the queue, and what can the guest still change after you have checked it?

## Spec hunt

- Virtio 1.2, section 4.2.2, "MMIO Device Register Layout", and its driver requirements in 4.2.2.2: which registers are read-only and which write-only, and whose obligation is it not to read a write-only one?
- Virtio 1.2, section 2.1.2, "Device Requirements: Device Status Field": is setting `DEVICE_NEEDS_RESET` a MUST or a SHOULD, and what MUST the device send the driver if `DRIVER_OK` is set?
- Virtio 1.2, section 3.1.1, "Driver Requirements: Device Initialization": in which step does the driver read `FEATURES_OK` back, and what must it do if the bit is clear?
