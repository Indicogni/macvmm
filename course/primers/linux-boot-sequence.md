---
title: The Linux boot sequence
slug: linux-boot-sequence
kind: primer
minutes: 30
required_by: [14]
labs: [boot-log-annotator]
---

# Who printed the first line?

Here is a real boot of the Alpine Linux kernel this course uses, on QEMU's `virt` machine on an
Apple Silicon Mac. Its text comes out of a **UART**, a serial port: a simple channel that carries
text one byte at a time. Ours is a **PL011**, the serial-port chip our VMM emulates. The first line
the serial port shows is stamped `[    0.000000]`, the number of seconds since the kernel started.
Further down, the same log says the kernel's PL011 driver, the code that knows how to send bytes
through that chip, was only registered at `0.002325`. So the kernel printed text 2.3 milliseconds
before it had any code able to print. How?

Now a second puzzle, also real. Delete the `/timer` entry from the machine description the kernel
is given, and boot again. With one extra word on the kernel command line, the log ends with a clear
panic message. Without that word, the serial port shows **zero bytes**. Same kernel, same bug, same
machine. By the end of this primer you will be able to explain both, and you will be able to read a
boot log as a list of stages rather than a wall of text.

:::prereqs
- [`os-basics`](/build-your-own/vmm/primers/os-basics/): what a kernel, a process and a driver are
- [`arm64-boot-protocol`](/build-your-own/vmm/primers/arm64-boot-protocol/): the state our VMM hands to the kernel (`x0` = DTB, MMU off)
- Chapter 10: what a Device Tree node, `compatible` and `reg` are
- [`cpio-initramfs`](/build-your-own/vmm/primers/cpio-initramfs/): how an initramfs is packed
:::

:::objectives
- Name, in order, the eight stages Linux passes through from the Image entry point to `/init`, and give one boot-log line that proves each stage finished.
- Explain why a kernel that dies before its console driver registers prints nothing at all without `earlycon`, and what `earlycon` changes.
- Trace how a Device Tree node with a `compatible` string becomes a bound driver, and name the two ways the binding can still fail.
- Read the time stamps in a boot log and say why they are all `0.000000` until the timer is set up.
- Say what `/init` is, why its exit panics the kernel, and why Alpine keeps most drivers in modules and its `modloop`.
:::

> **Aside: vocabulary you need.** The prerequisites teach these properly; here is one line each so you
> can keep reading.
>
> - **Image**: the kernel's executable file, which our VMM copies into guest RAM.
> - **Device Tree (DT)**, **DTB**: a data structure describing the machine (where RAM is, which
>   devices exist and at what addresses). The DTB is its binary form, built by our VMM. Each device
>   is a **node**; its `compatible` property names what kind of device it is.
> - **Register**: a small, named storage slot. CPU registers such as `x0` hold values the CPU
>   works on; the **PC** (program counter) is the register holding the address of the next
>   instruction. Device registers are the device's control and data slots.
> - **MMIO** (memory-mapped I/O): device registers appear at physical memory addresses. A store to
>   the PL011's data-register address sends one byte out of the serial port.
> - **MMU**: the hardware that translates the *virtual* addresses programs use into *physical*
>   addresses in RAM, using tables in memory called **page tables**.
> - **Exception level (EL)**: Arm's name for a privilege level. EL0 runs user programs, EL1 runs
>   the kernel, EL2 runs a hypervisor. Registers named `..._EL1` belong to the kernel's level.
> - **Interrupt (IRQ)**: a device signalling the CPU to stop and handle it.
> - **vCPU** and **exit**: a virtual CPU our VMM runs; an exit is the moment it stops and hands
>   control back to the VMM (for example, to emulate an MMIO access).
> - **PID**: the number identifying a process. PID 1 is the first user process.
> - **initramfs**: a tiny filesystem packed into one file and loaded into RAM beside the kernel.

## Where the boot protocol leaves off

The `arm64-boot-protocol` primer ended at one instant: the vCPU starts at the first byte of the
kernel Image, with `x0` holding the DTB's address, the MMU off and interrupts masked. That is the
whole of the boot loader's job. Everything after it is the kernel's, and in chapter 14 the kernel's
only window to the outside world is the stream of text it writes to our PL011.

That stream is long. The capture this primer quotes has 231 lines before anything from user space
appears, and most of them are housekeeping you can ignore. A handful are milestones: each one
proves that a piece of our machine worked. If you know which lines are milestones, a hang stops
being "Linux is broken" and becomes "it got past the interrupt controller but never found a
timer", which points at one DTB node and one chapter.

All logs below come from the same pinned kernel, `6.18.60-0-virt`, booted under QEMU's `virt`
machine with Hypervisor.framework acceleration on the course's development Mac. QEMU is the
reference platform our memory map copies, so the stages and most lines match what macvmm prints
from chapter 14 on. Where they differ (the machine model's name, QEMU's PCI bus) we say so. The
time stamps will differ on your machine; the order will not.

## The journey in one picture

The kernel's boot path has three phases: a little assembly that makes C possible (stage 1), one
long C function, `start_kernel()`, that runs on the boot CPU alone (stages 2 to 4), and a first
process that finishes the job and hands over to user space (stages 5 to 8).

:::diagram src=docs/diagrams/linux-boot-stages.svg alt="The eight stages of a Linux boot, in order"

*Read it top to bottom: each stage depends on the one above, so a hang tells you which box never
finished. (Stages 6 and 7 overlap in time, as you will see; both must finish before stage 8.)*

The rest of this primer walks the boxes in order. Function names are from the Linux source
(`arch/arm64/kernel/head.S`, `init/main.c`, `arch/arm64/kernel/setup.c`), which you can read but
do not need to.

## Stage 1. Before C can run: head.S and the MMU

The kernel's C code is compiled to run at high virtual addresses, around `0xffff8000_8000_0000`.
At entry the MMU is off, so every address is physical, and the CPU is fetching from the physical
address where our VMM put the Image, `0x4020_0000`. Those two numbers disagree, and every absolute
pointer in the C code assumes the first one. So the first few hundred instructions are hand-written
assembly in `arch/arm64/kernel/head.S`, careful to use only **PC-relative addressing**: instead of
"jump to address X", the code says "jump 200 bytes ahead of where I am now", which works wherever
the code happens to sit.

That code does four things. It saves `x0` (the DTB pointer) somewhere safe. It checks which
exception level it entered at, and configures EL2 if it got one (ours is EL1, the kernel's own
level; the log later says `CPU: All CPU(s) started at EL1`). It builds a minimal set of page
tables. Then it sets `SCTLR_EL1.M`, the bit in a kernel control register that turns translation on,
and branches to `start_kernel()` at its real, high, virtual address.

The hard part is the instant of the switch. The instruction that sets the bit was fetched from a
physical address; the very next instruction is fetched through the MMU, so its address is now
treated as virtual. If the page tables did not map that address, the CPU would fetch garbage and
die mid-step. The fix is an **identity map**: page tables in which virtual address equals physical
address for the few pages of code around the switch, so the same instruction addresses mean the
same bytes before and after. Only once translation is on does the code jump to the high address.

None of this prints anything. If it fails, you see nothing, and the evidence is in our VMM instead:
the last exits in its trace, and the vCPU's PC and `ESR_EL1` (the register that records why the CPU
faulted) in its register dump. A PC still near `0x4020_0000` means the kernel died before the MMU
was on.

> **Under the hood (safe to skip on first read).** The kernel is entered with the MMU off, and
> with it the data cache, a fast copy of RAM inside the CPU. So the code runs from RAM itself, and
> `Documentation/arch/arm64/booting.rst` (the kernel's written contract with boot loaders) requires
> the loader to have *cleaned* the image to the Point of Coherency: written any cached copies back
> to RAM, so RAM really holds the bytes. In 6.18 most of the page-table work is not in `head.S`
> itself: it calls position-independent C in `arch/arm64/kernel/pi/` (`create_init_idmap()`,
> `early_map_kernel()`) to build the identity map and the kernel's mapping at its linked address.
> That address could be randomised for security, which is called KASLR; Alpine's `virt` config
> turns it off (`CONFIG_RANDOMIZE_BASE` is not set), and that is what the line
> `Kernel Offset: disabled` at the end of every panic in our logs reports.

## The log buffer, and why the first line waited

Here are the first lines of a normal boot, exactly as captured:

```text
[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x610f0000]
[    0.000000] Linux version 6.18.60-0-virt (buildozer@build-3-24-aarch64) ...
[    0.000000] random: crng init done
[    0.000000] Machine model: linux,dummy-virt
[    0.000000] efi: UEFI not found.
```

The first line is the first thing `start_kernel()` prints after `head.S` hands over, so it is
stage 1's milestone. Its two hex numbers only identify the CPU (which core this is, and who made
it: `0x61` is Apple); you can ignore them. The second line is the kernel's banner. Ignore `random`
and `efi` too. The point is that neither of the first two lines went to the UART when it was
printed. They went into memory.

`printk()`, the kernel's print function, writes every message into a ring buffer in RAM called the
**log buffer**. A separate step copies messages from the buffer to every registered **console**, a
driver that knows how to emit text on some device. At time zero there is no console: the PL011
driver is a driver like any other and is registered much later. When it finally registers, the
kernel replays the whole buffer to it:

```text
[    0.002325] Serial: AMBA PL011 UART driver
[    0.002672] 9000000.pl011: ttyAMA0 at MMIO 0x9000000 (irq = 13, base_baud = 0) is a PL011 rev1
[    0.002684] printk: console [ttyAMA0] enabled
```

That resolves the first puzzle. The line stamped `0.000000` was *written* at time zero and
*transmitted* at about `0.0027`, together with every other line queued behind it. The stamp records
when `printk` was called, not when the byte left the UART.

:::predict The kernel panics at `0.000000`, long before the console driver registers. What appears on the serial port?
Nothing. The panic message goes into the log buffer, the CPU stops, and no console ever exists to replay it.
:::

That is the second puzzle's silent run. The fix is a tiny, separate console that works
from the very first `printk`: **earlycon**. On the command line, `earlycon=pl011,0x9000000` tells
the kernel "there is a PL011 at this physical address; to print a byte, store it to the data
register at that address". That is plain MMIO, one store per byte. The real driver does much more:
it waits for the kernel's device machinery, uses interrupts to learn when the chip can take more
bytes, and asks for the chip's clock to set the speed. None of that exists yet, and earlycon needs
none of it. It is parsed in `setup_arch()`, right after the DT is first read:

```text
[    0.000000] Machine model: linux,dummy-virt
[    0.000000] earlycon: pl11 at MMIO 0x0000000009000000 (options '')
[    0.000000] printk: legacy bootconsole [pl11] enabled
```

When the real `ttyAMA0` console arrives, the kernel retires the boot console with
`printk: legacy bootconsole [pl11] disabled` (`pl11` is the kernel's own spelling). macvmm puts `earlycon=pl011,0x09000000` in
its default command line for exactly this reason, and chapter 09 lets the PL011 accept the 8-bit
stores earlycon uses.

Two more facts about the buffer pay off in chapter 14. First, each message carries a **log
level**, from 0 (emergency, most urgent) to 7 (debug); ordinary boot messages are level 6 (info).
The console shows a message only if its level number is *lower* than `loglevel=`. So with
`loglevel=3`, the level-6 boot messages are all hidden and the console stays silent on a healthy
boot, yet the buffer still holds every line. Second, `dmesg` is the user-space command that reads
the whole buffer back, so a shell can show you lines the console hid.

> **Try it (optional; needs the Image from chapter 13).** The messages live in the Image as format
> strings, each starting with its level as a digit. If you have done chapter 13, `cargo xtask
> unzboot` has left the uncompressed kernel at `.cache/macvmm/Image-virt`. On the Mac:
>
> ```sh
> strings -a .cache/macvmm/Image-virt | grep -E "(Run %s as init|Unpacking initramfs)"
> ```
>
> You should see `6Run %s as init process` and `6Unpacking initramfs...`. The leading `6` is the
> level, `KERN_INFO`. (Before it sits an invisible byte, `\001`, which means "a level follows";
> your terminal shows nothing for it.)

## Stage 2. Reading the machine: the Device Tree, flat then unflattened

`Machine model: linux,dummy-virt` is the kernel's first look at our DTB: the root node's `model`
property (macvmm's says `macvmm-virt`). That line is stage 2's milestone. The kernel reads the DT
in two forms, because at this moment it has no memory allocator: nothing that can hand out RAM for
new data structures, since it does not yet know where RAM is. So it first reads the DTB *as a
blob*, in place, with a handful of "flat" helper functions that walk the bytes. It needs only three
things that early: the `memory` node (where RAM is), `/chosen` (the command line and the initramfs
addresses), and whatever earlycon needs.

Once it knows where RAM is and has an allocator, `unflatten_device_tree()` converts the blob into a
tree of C structures, one `struct device_node` per node, with parent, child and property pointers.
This is **DT unflattening**, and it is why the kernel can later ask "give me every node compatible
with `arm,pl011`" cheaply. Some lines that come from the early read are only printed after this:
the summary of the `memory` node, `Early memory node ranges ... [mem
0x0000000040000000-0x000000005fffffff]` (512 MiB), is printed once the memory allocator is set up.

The unflattened tree is also what user space sees under `/sys/firmware/devicetree/base`. This is
from a shell on the reference machine after it booted (chapter 14 gives you the same shell on
macvmm; for now, read it as an illustration):

```text
~ # cat /sys/firmware/devicetree/base/pl011@9000000/compatible | tr "\0" " "; echo
arm,pl011 arm,primecell
```

Still inside `setup_arch()`, the kernel reads the `/psci` node and prints
`psci: PSCIv1.1 detected in firmware.` **PSCI** is Arm's standard interface for asking firmware to
start CPUs or power the machine off; the kernel calls it with an **HVC** instruction, a call from
the kernel up to the hypervisor, which is our VMM (chapter 08 handles it). After `setup_arch()`
returns, `start_kernel()` prints the command line
(`Kernel command line: console=ttyAMA0 earlycon=... panic=-1`), followed by about forty lines of
memory and scheduler setup that rarely matter to a VMM author.

## Stages 3 and 4. Interrupts, then time

Two pieces of hardware must work before almost anything else. Devices need a way to get the CPU's
attention: an **interrupt** is a device tapping the CPU on the shoulder, and the **interrupt
controller** (on Arm, the **GIC**) is the switchboard that routes those taps to the right CPU. And
the kernel needs a ticking clock: the **timer** tells it what time it is and taps it at regular
intervals, which is how the scheduler takes turns between programs. The timer's tap is itself an
interrupt, which is why the GIC comes first.

`init_IRQ()` walks the DT for an interrupt controller and starts its driver. These lines prove
chapter 12's GIC was found where the DTB said it was:

```text
[    0.000000] GICv3: 988 SPIs implemented
[    0.000000] GICv3: CPU0: found redistributor 0 region 0:0x00000000080a0000
```

SPIs are the interrupt lines shared by devices; the **redistributor** is the per-CPU part of the
GIC. The second line, naming CPU 0's redistributor at the address our DTB gave, is stage 3's
milestone.

Next, `time_init()`. On arm64 the clock is the architected **Generic Timer** (chapter 11), built
into every core, and the kernel finds it through the `/timer` node:

```text
[    0.000000] arch_timer: cp15 timer running at 24.00MHz (virt).
[    0.000000] clocksource: arch_sys_counter: mask: 0xffffffffffffff max_cycles: ...
[    0.000000] sched_clock: 56 bits at 24MHz, resolution 41ns, wraps every 4398046511097ns
[    0.000111] kfence: initialized - using 2097152 bytes for 255 objects ...
[    0.000158] Calibrating delay loop (skipped), value calculated using timer frequency.. 48.00 BogoMIPS (lpj=24000)
```

Three words need earning. A **clocksource** is the kernel's abstraction of "a counter I can read
to know what time it is"; `arch_sys_counter` is the Generic Timer's counter, a register named
`CNTVCT_EL0` that counts up 24 million times a second. `(virt)` means the kernel uses the
*virtual* timer, the one Hypervisor.framework gives each vCPU. With the in-kernel interrupt
controller that chapter 14 uses, Hypervisor.framework delivers its interrupt by itself; only with
`--irqchip none` does it tell our VMM, with the exit reason `HV_EXIT_REASON_VTIMER_ACTIVATED`
(chapter 11). **sched_clock** is the fast clock that `printk` stamps messages
with. Look at the stamps: every line up to and including the `sched_clock` line reads `0.000000`,
and the very next line reads `0.000111`. **Time stamps stay at zero until `sched_clock` is
registered (the third line above)**, because before that there is no clock to read them from.

The last line is the **delay loop**. Some drivers need "wait 10 microseconds" before the scheduler
can help, so the kernel needs to know how many loop iterations fill one tick: `lpj`, loops per
jiffy, where a **jiffy** is one timer tick (this kernel has `CONFIG_HZ=1000`, so 1 ms). Old kernels
measured it by spinning; arm64 computes it from the timer's frequency, 24,000,000 / 1000 = 24,000,
hence "skipped". BogoMIPS is a number derived from that with no meaning beyond it; ignore it. The
`arch_timer` line is stage 4's milestone.

Now the second puzzle has its culprit. With `/timer` removed and earlycon on, the captured log
ends like this:

```text
[    0.000000] clocksource: jiffies: mask: 0xffffffff max_cycles: 0xffffffff, ...
[    0.000000] timer_probe: no matching timers found
[    0.000000] Kernel panic - not syncing: Unable to initialise architected timer.
[    0.000000] CPU: 0 UID: 0 PID: 0 Comm: swapper/0 Not tainted 6.18.60-0-virt #1-Alpine ...
[    0.000000] Call trace:
...
[    0.000000]  time_init+0x54/0x94
[    0.000000]  start_kernel+0x598/0x758
```

The `jiffies` line is the kernel registering its fallback clocksource, a plain tick counter that
cannot tick yet without a timer. `timer_probe()` then found no `/timer` node and so started no
timer driver. The timer's rate is a variable that only that driver fills in, so it was still zero;
`time_init()` checks for exactly that and panics, before the console driver could exist. Without
earlycon that message never left RAM. Note `PID: 0`: we are still in the boot CPU's own context,
and no process exists yet.

## Stage 5. A first process, and initcalls

When `start_kernel()` has interrupts and time, it starts the scheduler and creates the first
**kernel thread** (a process that runs only kernel code), `kernel_init`, which will become PID 1.
That thread does the rest of the boot.

Why should a VMM author care? Because **initcalls are how every driver gets its turn**, and a hang
inside one shows up as the last line that started and never finished. An initcall is a function
that a piece of the kernel marks with a macro (a code label) such as `module_init()` or
`subsys_initcall()`, asking to be called once at boot. At build time, the linker collects the
addresses of all marked functions into tables, one per **level**, and the kernel calls the tables
in order. That ordering is how the kernel says "buses before the drivers that sit on them" without
a central list.

`kernel_init` runs them in two batches:

1. The `early` initcalls, via `do_pre_smp_initcalls()`.
2. It brings up the secondary CPUs: `smp: Bringing up secondary CPUs ...`, then
   `smp: Brought up ...`, each started through PSCI `CPU_ON` (chapter 20). That last line is
   stage 5's milestone.
3. `do_initcalls()` runs the remaining levels in order: `pure`, `core`, `postcore`, `arch`,
   `subsys`, `fs`, `rootfs`, `device`, `late` (each with a `_sync` variant run right after it).

The command-line option `initcall_debug` prints every call. The excerpt below is from a separate
boot with `initcall_debug` on, so its time stamps do not line up with the other logs here (the
extra printing slows everything down and shifts the moments):

```text
[    0.002637] calling  pl011_init+0x0/0xd0 @ 1
[    0.002640] initcall pl011_init+0x0/0xd0 returned 0 after 0 usecs
[    0.002649] calling  of_platform_default_populate_init+0x0/0x1e8 @ 1
[    0.003056] initcall of_platform_default_populate_init+0x0/0x1e8 returned 0 after 0 usecs
[    0.013144] calling  populate_rootfs+0x0/0xd0 @ 1
[    0.029352] calling  pl031_driver_init+0x0/0x6c @ 1
```

`@ 1` means PID 1, `kernel_init`, made the call. If a boot with `initcall_debug` stops on a
`calling` line with no matching `returned`, that initcall is where it hung. Most of the 231
boot lines are printed by some initcall announcing itself (`NET: Registered PF_INET protocol
family` is one).

## Stage 6. How a node finds its driver

In the excerpt, `pl011_init` registers the PL011 *driver*, the code.
`of_platform_default_populate_init` creates the *devices*: it walks the unflattened tree and makes
one kernel device object per node that describes hardware. So drivers and devices arrive
separately, in either order, and something must pair them.

Think of a matchmaker with two stacks of cards: job listings (devices) and applicants (drivers).
Whenever a new card arrives on either stack, the matchmaker checks it against every card on the
other stack. In the kernel's driver model the matchmaker is a **bus**. Every device and every
driver belongs to a bus type, and whenever either side is added, the bus runs its `match` function
over the other side's list.

The plain case is the **platform bus**, used for most DT devices. A DT driver carries an
`of_match_table`, a list of `compatible` strings it can drive. Match means "one of my node's
`compatible` strings is in your table", and the node's list is tried from most to least specific.
For example, QEMU's 32 `virtio_mmio` slots are nodes with `compatible = "virtio,mmio"`, and the
`virtio_mmio` driver's table contains that string, so the platform bus pairs them. On a match the
driver's `probe()` function runs: it maps the node's `reg` window (the device's MMIO addresses),
looks up its `interrupts`, checks the device, and finally announces itself. That whole sequence is
**driver binding by `compatible`**, and it is the paragraph chapter 10 points here for: the DTB is
read first by the kernel's flat helpers, then by the unflattener, and then over and over by drivers
during binding. (The GIC and the timer, which you met in stages 3 and 4, are the exception: they
are needed before the driver model exists, so the kernel finds their drivers through special
early tables instead of a bus.)

Binding can still fail in two ways, and both look like silence. No driver may match (the string is
misspelled, or the driver is a module nobody loaded). Or the driver matches and its `probe()`
*declines*, returning an error after reading the device and disliking what it found. The kernel
may log the failure at debug level or not at all.

The PL011 shows a twist. **AMBA** is Arm's standard for on-chip peripherals, and Arm's own
peripherals, called PrimeCells, carry ID registers that say what they are. The PL011's node says
`arm,pl011` *and* `arm,primecell`, and for nodes with the second string the kernel creates the
device on the **AMBA bus**, not the platform bus. **The AMBA bus does not match on `compatible`
at all: it reads the device's peripheral ID registers at offsets `0xFE0` to `0xFFC` and matches
those** (the [`primecell-ids`](/build-your-own/vmm/primers/primecell-ids/) primer has the details). So our emulated PL011 must answer those
reads correctly, or no driver binds. On the reference machine:

```text
~ # ls -l /sys/bus/amba/devices/9000000.pl011/driver
... /sys/bus/amba/devices/9000000.pl011/driver -> ../../../bus/amba/drivers/uart-pl011
~ # ls -l /sys/bus/amba/devices/9010000.pl031/driver
... /sys/bus/amba/devices/9010000.pl031/driver -> ../../../bus/amba/drivers/rtc-pl031
```

The milestone lines for this stage are the drivers' announcements: `ttyAMA0 at MMIO 0x9000000`
for the UART and `rtc-pl031 9010000.pl031: registered as rtc0` for the PL031 real-time clock.
Between them, `clocksource: Switched to clocksource arch_sys_counter` confirms that timekeeping
moved from the coarse tick counter to the Generic Timer.

> **Security.** Every byte of this log was chosen by the guest. In chapter 14 it flows from the
> PL011 to your terminal, and a hostile guest can print escape sequences instead of boot messages:
> special byte codes that can move your cursor, rewrite what your terminal shows, or change its
> settings (the [`tty-termios`](/build-your-own/vmm/primers/tty-termios/) primer). macvmm filters the stream on the host side before writing
> it out; never treat guest console output as trusted text, not even a boot log.

## Stages 7 and 8. The initramfs, and the hand-off to /init

The kernel cannot mount a disk yet: the disk's driver may not have loaded, and may not even be
in the kernel, so no disk device exists. So it starts with a filesystem that needs no driver: the
initramfs our VMM placed in RAM and announced in `/chosen`. The `populate_rootfs` initcall unpacks
that archive (its format is called cpio) into an in-memory filesystem, and by default does it in
the background while other initcalls continue. You can see the overlap:

```text
[    0.068891] Unpacking initramfs...
[    0.104959] rtc-pl031 9010000.pl031: registered as rtc0
[    0.158976] Freeing initrd memory: 9184K
[    0.165739] Freeing unused kernel memory: 2048K
[    0.165751] Run /init as init process
```

"Freeing initrd memory" (initrd is the older name for the same idea) means the archive was unpacked
and its RAM returned; it is stage 7's milestone. If our VMM had placed the initramfs on top of the
kernel's BSS (the memory the kernel zeroes at start for its uninitialised variables; the bug in the
`arm64-boot-protocol` primer), this is where you would see it, far from its cause: an error about a bad
archive, or a silent stall before `Unpacking initramfs...` (chapter 13's capture shows the stall).

Then the kernel frees the code it needed only for boot and executes `/init` from the new
filesystem, as PID 1, in **user space**: an ordinary program running at EL0. `Run /init as init
process` is stage 8's milestone and the last line the *kernel* prints on purpose. Everything after
it is a program. The path comes from `rdinit=`, which defaults to `/init`. If the initramfs has no
such file, the kernel tries to mount the disk named by `root=`. If that mount fails, it panics
with `VFS: Unable to mount root fs`. If the mount succeeds, it tries `/sbin/init`, `/etc/init`,
`/bin/init` and `/bin/sh` on that disk, and panics with `No working init found` if all fail.

PID 1 has one more rule: it must never exit. Every other process descends from it, and when a
process's parent dies, the orphan is handed to PID 1, which collects its exit status. Without PID 1
there is nobody to take that role, so the kernel refuses to continue. Alpine's stock initramfs makes
this vivid. Alpine is a small Linux distribution, and its `/init` is a shell script whose job is to
find Alpine's boot media; on our bare machine there is none, so the script gives up and exits:

```text
[    5.232693] Mounting boot media: failed.
[    5.232756] Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000000
```

That is why the course builds its own test initramfs in chapter 13. Its `/init` sets up `/proc`
and `/sys`, prints `macvmm-initramfs: ready`, and starts a shell as its *child*. The shell is
**BusyBox**, a single binary that acts as `sh`, `ls`, `mount`, `dmesg`, `modprobe` and hundreds of
other commands depending on the name it is invoked under (Alpine links those names to it with
`busybox --install -s`). When you see `/ # ` in chapter 14, you are talking to that shell, while
`/init` stays PID 1 and waits for it. When the shell exits, `/init` powers the machine off instead
of returning, which is why exiting the shell does not panic. `poweroff -f` asks the kernel to
issue PSCI `SYSTEM_OFF`, which ends as `reboot: Power down`.

## Modules, and Alpine's modloop

A **kernel module** is a separate file of driver code (a `.ko` file) that the kernel can link into
itself while it is running, when user space asks with the `modprobe` command. When the kernel is
built, each driver is either built in (`=y` in the build config) or built as a module (`=m`).

Not every driver is inside the Image, which is about 35 MiB. Alpine's `virt` kernel builds the
PL011, PL031, GIC and timer drivers in, because nothing can boot without them. Most others are
modules. The `virtio_mmio` driver is one of them: `CONFIG_VIRTIO_MMIO=m`. (Forward reference:
virtio is the family of virtual devices we build from chapter 15. Each slot has registers that
start with a magic value, a version and a `DeviceID` saying what kind of device sits there; 0
means an empty slot.)

How does `modprobe` know which module serves a DT node? Each module embeds **aliases** generated
from its match table, and a file called `modules.alias` collects them. From the pinned initramfs,
on the Mac:

```text
alias of:N*T*Cvirtio,mmioC* virtio_mmio
alias of:N*T*Cvirtio,mmio virtio_mmio
```

Decode the first one piece by piece. `of:` means "a Device Tree device". `N*` is the node's name,
`*` meaning "anything". `T*` is its device type, also anything. `C` introduces a `compatible`
string, here `virtio,mmio`, and the final `C*` allows more `compatible` strings after it. The
second line covers a node where `virtio,mmio` is the last string. The `*`s make it a pattern, like
a shell wildcard, so user space can match a device to a module before the module is in the
kernel. This is driver binding by `compatible`, done ahead of time.

When the reference machine's shell ran `modprobe virtio_mmio`, the module loaded. `/proc/modules`
listed it as `virtio_mmio 20480 0 - Live`: name, size in bytes, how many users it has (none), who
depends on it (`-`, nobody) and its state (`Live`, loaded and running). And yet none of QEMU's 32
`virtio_mmio` slots gained a driver. That is the second failure mode from earlier, in the wild: the
driver matched each node, read the slot's `DeviceID` register, found 0 (an empty slot) and
declined in `probe()`.

The initramfs carries only the modules needed to find a root filesystem; the rest, `ext4` among
them, ship in Alpine's **modloop**, a read-only image of the complete module tree, in the
compressed squashfs format, mounted at boot. In chapter 18 we attach the pinned `modloop-virt` as a
second, read-only virtio-blk disk so the guest can load `ext4` and mount its root on `/dev/vda`.

> **Aside.** The name is literal: the image is a filesystem that Alpine mounts through a *loop*
> device (a block device backed by a file) to reach its *modules*.

## The eight stages, mapped to lines

This is the table to keep open in chapter 14. It has the same eight stages as the picture, in the
same order. The last column is where in macvmm the evidence lives if the stage never finishes.

| # | Stage | Milestone line (6.18) | If it never appears, suspect |
|---|---|---|---|
| 1 | head.S, MMU on | `Booting Linux on physical CPU 0x...` | entry state, placement (ch06, ch13) |
| 2 | First DT read | `Machine model: ...` (with earlycon, then `earlycon: pl11 at MMIO ...`) | `x0`, the DTB header (ch10, ch13); for earlycon, the command line and PL011 8-bit stores (ch09) |
| 3 | Interrupt controller | `GICv3: CPU0: found redistributor 0 ...` | `/intc` node, GIC bases (ch12) |
| 4 | Timer and delay loop | `arch_timer: cp15 timer running at 24.00MHz (virt).` | `/timer` node (compatible, PPIs), `CNTFRQ_EL0` (ch11); vtimer exits only with `--irqchip none` |
| 5 | First process, other CPUs | `smp: Brought up ...` | PSCI `CPU_ON` (ch08, ch20) |
| 6 | Driver binding | `ttyAMA0 at MMIO 0x9000000`, `rtc-pl031 ... registered as rtc0` | `compatible`, `reg`, ID registers (ch09, ch10) |
| 7 | initramfs | `Freeing initrd memory: ...` | `/chosen` initrd addresses, BSS overlap (ch13) |
| 8 | User space | `Run /init as init process` | the initramfs's `/init` (ch13) |

Remember the catch from the log buffer section: without earlycon, lines from stages 1 to 5 reach
the serial port only once stage 6 has registered the `ttyAMA0` console.

## Lab

:::lab boot-log-annotator

The `boot-log-annotator` lab takes a pasted boot log, from the reference machine or later from
your own macvmm, and annotates it in the browser. Each line links to the chapter and the DTB node
that explains it, and a "stage" colouring mode paints every line with the stage of the table above
it belongs to, so the eight milestones stand out and the housekeeping fades. Paste a truncated log
(try the no-timer panic above) and the lab names the last stage that completed and the next one it
was waiting for. The log is parsed locally and never uploaded.

## Self-check

Commit to an answer before you reveal each one.

:::predict Your VMM boots with console=ttyAMA0 but no earlycon, and the serial port stays empty. The VMM's log shows the guest still running, not crashed. Name two stages the kernel could be stuck in, and one you can rule out.
Any stage before the `ttyAMA0` console registers in stage 6: for example stage 3 (the interrupt
controller), stage 4 (the timer) or stage 5 (an initcall that never returns). In a hang rather than
a panic, any of these fits. You can rule out stage 8, "past `Run /init`": the console registered
long before that, so the buffer would have been replayed. Add `earlycon=pl011,0x09000000` before
guessing further.
:::

:::predict A log shows thirty lines all stamped 0.000000 and then stops. What do the stamps alone tell you? (Hint: list what is printed before the timer: the banner, the first DT read, earlycon, the command line and memory setup, the GIC.)
That `sched_clock` was never registered, so the kernel stopped before finishing stage 4, the
timer. That narrows the hang to stages 1 to 4: the early DT read, the GIC, or the timer itself.
(Thirty lines is fewer than a full stage 2 prints, which hints at an early stop, but the stamps are
the solid evidence.)
:::

:::predict The PL011's node in your DTB says compatible = "arm,pl011", "arm,primecell", but your device answers zero at offsets 0xFE0 to 0xFFC. Where does binding fail, and what will the log lack?
The `arm,primecell` string puts the device on the AMBA bus, which matches on the peripheral ID
registers, not on the `compatible` string. With an ID of zero no AMBA driver matches, so
`ttyAMA0 at MMIO 0x9000000` and `printk: console [ttyAMA0] enabled` never appear. With earlycon on
you still see the early lines; without it you see nothing at all. This is one of chapter 14's three
injected failures.
:::

:::predict Your /init prints its marker and then exits with status 0. Why does the kernel panic, when nothing went wrong?
PID 1 must never exit: it is the ancestor of every process and adopts orphaned ones, and the kernel
has no one to hand that role to. The kernel reports `Attempted to kill init! exitcode=0x00000000`,
whatever the exit status. A test `/init` that is finished should power the machine off
(`poweroff -f`) instead of returning.
:::

:::predict modprobe virtio_mmio succeeds, /proc/modules lists it, but no /dev/vda disk appears. Name two causes, one on each side of the guest-host boundary.
Host side (our VMM builds both the DTB and the device): either the DTB has no node with
`compatible = "virtio,mmio"`, so there is nothing to match (check
`/sys/firmware/devicetree/base`), or the node matched but `probe()` declined because our slot
returned a wrong magic value, a wrong version, or a `DeviceID` of 0, which is exactly what QEMU's
empty slots do. Guest side: the transport bound and found a disk, but the disk's own driver,
`virtio_blk`, is also a module (`CONFIG_VIRTIO_BLK=m`) and nobody loaded it, so no `/dev/vda`
appears. Chapter 15 makes our slots answer correctly; chapter 18 loads `virtio_blk`.
:::

## Where this shows up in macvmm

- [Chapter 09, `mmio-pl011`](../../devices/mmio-pl011/): the PL011 that both earlycon and the
  `uart-pl011` driver write to, including the ID registers the AMBA bus matches on
  (`crates/vmm/src/devices/`).
- [Chapter 10, `device-tree`](../../devices/device-tree/): the nodes every stage above reads, and
  the default `bootargs` with `earlycon` (`crates/vmm/src/fdt/`).
- [Chapter 11, `timer-irq`](../../interrupts/timer-irq/) and
  [chapter 12, `gicv3`](../../interrupts/gicv3/): the two stages that must work before the console
  exists.
- [Chapter 13, `loaders`](../../linux/loaders/): the initramfs placement and `/chosen` that
  `populate_rootfs` depends on, and the test initramfs with its `/init`.
- [Chapter 14, `linux-boot`](../../linux/linux-boot/): the whole sequence on our own machine, its
  checkpoint markers (`Machine model: macvmm-virt` to `reboot: Power down`), and the three injected
  failures you diagnose with the table above.
- [Chapter 18, `virtio-blk`](../../virtio/virtio-blk/): `virtio_blk` and `ext4` as modules, and
  `modloop-virt` as a read-only second disk.
- [Chapter 22, `freebsd`](../../firmware/freebsd/): a different kernel with a different probe
  order, compared against this one.

## Going further

- Linux, `init/main.c` (`start_kernel()`, `kernel_init()`, `do_pre_smp_initcalls()`,
  `do_initcalls()`), `arch/arm64/kernel/head.S` and `arch/arm64/kernel/pi/`: the sequence above, in
  its own words. Read `start_kernel()` with the boot log beside it.
- Linux, `Documentation/admin-guide/kernel-parameters.txt` for `earlycon`, `console`, `loglevel`,
  `initcall_debug` and `rdinit`, and `Documentation/admin-guide/serial-console.rst`.
- Linux, `Documentation/driver-api/driver-model/` (`bus.rst`, `binding.rst`) and
  `Documentation/devicetree/usage-model.rst` §3, "Linux and the Device Tree", for how nodes
  become devices.
- Arm Architecture Reference Manual for A-profile (DDI 0487), the chapter "The Generic Timer in
  AArch64 state" (D11 in issue J.a; chapter numbers move between issues, so check the contents),
  for the counter behind `arch_sys_counter`.
- `man 8 modprobe` and `man 8 depmod` (depmod builds `modules.alias`), and Linux
  `scripts/mod/file2alias.c`, which generates the `of:` alias format from each driver's match table.

## Checkpoint

**Checkpoint.** You can now name the eight stages from `head.S` to `/init`, give the milestone
line for each, and say which part of the machine to suspect when a log stops after it. To verify:
answer the five self-check questions without peeking, then name the eight stages and their
milestone lines from memory and compare with the table. (If you have done chapter 13, also run the
Try it.) There is no code state to carry forward.

**What's next.** Chapter 14 boots this same kernel on the machine you built, with our generated
DTB. You will break it three ways on purpose (no `/timer`, a wrong redistributor base, a PL011
with blank ID registers) and, with the table above, name each failure from its last line alone.

**One open question.** Everything before the console registers goes into a buffer in guest RAM.
Our VMM can read guest RAM. Could macvmm recover a silent kernel's log buffer after the fact, with
no earlycon at all, and what would it need to know to find it? (A place to start: think about what
the kernel image contains that names its own variables and their addresses, and how you would turn
a kernel virtual address into a guest-physical one, given where the VMM loaded the Image.)
