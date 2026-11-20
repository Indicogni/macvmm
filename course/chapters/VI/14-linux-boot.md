---
title: Booting Linux to a shell
part: VI
chapter: VI.2
id: 14
runs: mac+browser
minutes: 300
prereqs: [13]
start_tag: ch-13
labs: [boot-log-annotator, boot-timeline]
command: scripts/checkpoint.sh 14
expect: CHECKPOINT 14 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** reading a boot log as evidence, back to the node or device behind each line; the failure fingerprint; the exit ring on demand (`Ctrl-A t`, SIGUSR1) and combined trace categories; what a PL011 console byte costs in virtual machine (VM) exits.
- **Core, from earlier:** the exit trace and `--stats` (chapters 03 and 11), the exit ring (07), PSCI (power state coordination interface) and `--on-reset` (08), the PL011 and the stop control `VmControl` (09), the device tree (10), the timer and the in-kernel interrupt controller (11, 12), the boot plan and the test initramfs (13).
- **Primers (read first):** `linux-boot-sequence` (the eight stages from entry to `/init`, and the milestone line each one prints); `primecell-ids` (the eight bytes at `0xFE0` and how Linux matches on them; chapter 09's parked question resolves here).
- **Primers (review):** `unix-signals` (SIGUSR1, SIGINT, exit status `128 + n`, the self-pipe); `tty-termios` (why `Ctrl-A t` reaches us and not the guest); `cpio-initramfs` (where `/init` comes from); `host-concurrency` (`Arc` and `Mutex`).
- **Pointers:** the kernel's `panic=` command-line parameter (an Aside); BusyBox, the one program behind every command in the test shell (a linked sentence).
- **Forward definitions:** virtio (chapter 15); a disk for the guest (chapter 18); several virtual CPUs (vCPUs, chapter 20). Each is defined in a sentence where it first appears.
:::

Here is a real run of your virtual machine monitor (VMM), with one line of its PL011 code changed and the usual [earlycon](/build-your-own/vmm/glossary/#earlycon) (the kernel's printing-by-address before any driver exists) left off the command line. The guest is a stock Linux kernel. It ran for about a tenth of a second, made 82 VM exits, including a clean power-off, and our VMM exited with status 0. It printed nothing at all:

:::term source=captures/14-no-pl011-id-silent.txt

The kernel was fine. One small part of our machine lied to it, and Linux reacted quietly. By the end of this chapter you will have booted Alpine's Linux kernel to a shell, broken it three ways, and reproduced this run and named the lie from the outside alone. With it, rows 1 to 7 and 10 of the problem ledger hold for one CPU under a stock kernel (privileged state, memory, devices, power control, a machine description, interrupts, an alarm clock, a boot chain). Row 8, cheap bulk input and output, gets a number you measure yourself.

:::objectives
- Boot the pinned Alpine `linux-virt` 6.18.60 kernel to a shell prompt, run a command, and power off cleanly.
- Diagnose three injected boot failures from their symptoms alone: a missing `/timer` node, a wrong redistributor base in the device tree, and PL011 identification registers that read zero.
- Map 20 lines of a real boot log to the device or device-tree node responsible for each.
- Add the exit-ring dump on `Ctrl-A t` and SIGUSR1, and trace filters that combine categories.
- Measure how many VM exits 64 KiB of PL011 console output costs, the number chapter 15 starts from.
:::

**Before you start.** From the repository root, run `scripts/learner start 14`; it copies this chapter's journal to `learner/journal/14.md`. Chapter 13's `scripts/fetch.sh linux` left `Image-virt` and `initramfs-test.img` in `.cache/macvmm/`. The only new code is two debugging aids.

## Boot it

The `--cmdline` below is the [kernel command line](/build-your-own/vmm/glossary/#kernel-command-line) our device tree hands Linux in `/chosen`. Its last word, `macvmm.test=boot`, is read by the test initramfs's own `/init` script, which picks what to do once Linux has started it. Run it from inside `learner/`, where the cache is one level up:

```sh
cd learner
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=boot" --timeout 30 --stats
```

From the root, the same command with `.cache/macvmm/` runs the reference; from `learner/` it runs yours. Use the second; our captures come from the first, for comparison:

:::term source=captures/14-boot-log.txt

About 180 lines in 0.17 seconds, exit status 0. The last two lines before the statistics are what the course has been heading for: `Run /init as init process`, then `macvmm-initramfs: ready 6.18.60-0-virt`, printed by a guest user-space program through the driver Linux chose for our UART (universal asynchronous receiver-transmitter), the PL011.

The `/init` script is shell, run by [BusyBox](https://busybox.net/about.html), one program that provides `sh`, `echo`, `poweroff` and about 300 other commands. Its dispatch starts with this chapter's cases: `boot` powers off at once, `shell` gives you a prompt, `panic` crashes the kernel on purpose, `timer-latency` times a hundred short sleeps:

:::code anchor=initramfs_dispatch_linux file=scripts/initramfs/init

From the root, `scripts/run-linux.sh --test CASE` builds, signs and runs the reference with these same defaults.

## Reading the log as evidence

Linux prints its [boot log](/build-your-own/vmm/glossary/#boot-log) in stages, each depending on the one before; the `linux-boot-sequence` primer names the eight stages and the milestone line of each. Here are 14 lines of the run above, each traced to the part of *our* machine that caused it. Keep beside it the device tree our VMM generated for that run, dumped with chapter 10's `--dtb-out`:

:::term source=captures/14-dts.txt

`rng-seed` and `kaslr-seed` are zeros only in the dump; the guest received fresh random bytes (chapter 10). `kaslr-seed` is meant for [KASLR](/build-your-own/vmm/glossary/#kaslr) (kernel address space layout randomisation), which moves the kernel's code to a random virtual address so an attacker cannot guess where its functions live. Our runs do not show it at work: every trace on this page has the same kernel `pc` values, such as `0xffff800080041338`.

| Line in the log | Stage | Caused by, in our machine |
|---|---|---|
| `Booting Linux on physical CPU 0x0000000000 [0x610f0000]` | 1, entry | our entry state (chapter 13); `0x0` is the CPU's affinity (`MPIDR_EL1`, chapter 06) |
| `Machine model: macvmm-virt` | 2, first device-tree read | the root node's `model` (chapter 10) |
| `earlycon: pl11 at MMIO 0x0000000009000000 (options '')` | 2 | `earlycon=` in `bootargs`, then byte stores to the PL011 (chapter 09) |
| `psci: PSCIv1.1 detected in firmware.` | 2 | `/psci` says `method = "hvc"`; our answer to `PSCI_VERSION` (chapter 08) |
| `Kernel command line: console=ttyAMA0 ...` | 2 | `/chosen` `bootargs` (chapter 10) |
| `GICv3: CPU0: found redistributor 0 region 0:0x00000000080a0000` | 3, interrupts | the second `reg` pair of `/intc@8000000` (chapter 12) |
| `arch_timer: cp15 timer running at 24.00MHz (virt).` | 4, time | the `/timer` node and the counter frequency Hypervisor.framework sets (chapter 11); `cp15` is a 32-bit-era name for system registers |
| `smp: Brought up 1 node, 1 CPU` | 5, first process | the single `cpu@0` node; chapter 20 adds more vCPUs, so the guest can run on several host cores at once |
| `9000000.pl011: ttyAMA0 at MMIO 0x9000000 (irq = 13, base_baud = 0) is a PL011 rev1` | 6, drivers bind | `/pl011@9000000`, its clocks and its identification registers (chapters 09 and 10) |
| `printk: console [ttyAMA0] enabled` | 6 | `console=ttyAMA0` on the command line, now that the driver exists |
| `rtc-pl031 9010000.pl031: registered as rtc0` | 6 | `/pl031@9010000` and its identification registers (chapter 09) |
| `Freeing initrd memory: 9204K` | 7, initramfs | `linux,initrd-start` and `-end` in `/chosen` (chapter 13) |
| `Run /init as init process` | 8, user space | the initramfs's `/init` |
| `reboot: Power down` | after `/init` | PSCI `SYSTEM_OFF`, which ends `macvmm` with status 0 (chapter 08) |

*Every line names something we built. The `irq = 13` is Linux's own interrupt number, not INTID 33 of the GIC (Generic Interrupt Controller).*

Notice what is missing: lines about hardware Linux went looking for. On Arm, nearly everything comes from the device tree. Linux probes only to confirm what the tree claims, and never searches the address space for devices the tree did not mention (it does ask firmware, over HVC (hypervisor call), about optional services, as you will see next). So a wrong node produces a wrong line, or no line. Your journal's second question asks you to extend the table to 20 lines; the annotator does the matching for any log you paste into it, yours included:

:::lab boot-log-annotator

## What Linux used that our test guests never did

Linux uses corners of the machine no test guest touched. Two filters on the exit trace show them.

`--trace` takes one **[trace category](/build-your-own/vmm/glossary/#trace-category)** after the file name, a kind of exit to keep: `hvc` since chapter 03, `mmio` since chapter 07, `sysreg` and `psci` since chapter 08, and `all` since chapter 11. `psci` keeps PSCI calls only, whichever conduit (HVC, or SMC, the secure monitor call) carried them. This chapter adds `cancel`, for the `CANCELED` exits that a timeout or a stop kick causes, and lets a comma-separated list keep the exits of any of them. Here the trace keeps only hypercalls and trapped system registers:

:::term source=captures/14-trace-hvc-sysreg.txt

That is everything Linux said to our VMM that was not device access: 18 exits out of 32,829. Linux asks for the PSCI version, whether a Trusted OS needs migrating (`PSCI_MIGRATE_INFO_TYPE`; the log line `Trusted OS migration not required`), which PSCI calls exist (`PSCI_FEATURES`), the version of the SMCCC (SMC calling convention, `SMCCC_VERSION`), and which firmware workarounds exist (`SMCCC_ARCH_FEATURES`). It probes a random-number source (`TRNG_VERSION`) and which hypervisor it is talking to (`VENDOR_HYP_CALL_UID`); we answer both "not supported". It touches two debug registers and finally calls `PSCI_SYSTEM_OFF`. No `ICC_` register appears, because the in-kernel GIC handles the CPU interface's `ICC_` registers itself (chapter 12); with `--irqchip none` you would see them here.

To change the filter, make the category a set of bits and parse the list into it. `parse` returns `None` for an unknown name or an empty list, so a typo is an error rather than an empty trace. In `learner/crates/vmm/src/trace.rs`, where chapter 03 parsed a single name:

:::code anchor=trace_cats_parse file=crates/vmm/src/trace.rs

The filter itself is a single predicate over a record. `all` sets every bit, so it selects everything:

:::code anchor=trace_cats_selects file=crates/vmm/src/trace.rs

The second filter keeps memory-mapped I/O (MMIO) exits. First, does Linux ever touch the interrupt controller through us? Count every MMIO exit, then those anywhere in the GIC's window, `0x0800_0000` to `0x08FF_FFFF`:

:::term source=captures/14-gic-mmio.txt

32,811 device accesses, none to the GIC, and the boot's `--stats` said `vtimer 0`: Hypervisor.framework handles the GIC and the timer without asking us (chapter 12). Now grep for the last 256 bytes of the PL011 and PL031 windows, where the identification registers live:

:::term source=captures/14-id-reads.txt

Chapter 09's parked question, answered by Linux. Before binding a driver to an `"arm,primecell"` node, Linux's AMBA bus code (AMBA, the Advanced Microcontroller Bus Architecture, is Arm's family of on-chip buses) reads the eight identification registers at `0xFE0` to `0xFFC` and assembles them, as the `primecell-ids` primer describes.

`0x11 0x10 0x14 0x00` is the peripheral ID `0x00141011`: part `0x011`, designer `0x41` (Arm), revision 1, hence "PL011 rev1" in the log. `0x0d 0xf0 0x05 0xb1` is the cell ID `0xB105F00D`. No test guest of ours read those addresses; deliberate breakage 3 tests your chapter 09 guess.

> **Security.** Every value in these traces came from the guest. A record holds only numbers and names from our own static tables, never guest-chosen text, so a trace, a stats line or a ring dump is safe to print on your terminal even with a hostile guest.

## What a console byte costs

The boot's `--stats` said `serial_written=12093` and `data abort 32811`: almost every exit is the console, about 2.7 per byte printed. Each byte costs a flag-register read to see if there is room, the store to the data register, and often another read, each a round trip to our VMM.

To measure it, boot the `shell` case with `--stats` twice, from inside `learner/`. The `--timeout` gives you time to type; make it longer if you are slow:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=shell" --timeout 20 --stats
```

In the first run type only `poweroff -f`. In the second, first type `yes macvmm | head -c 65536`, which prints 64 KiB of `macvmm` lines. Compare `serial_written` and `data abort` on the stats lines. Our two runs, of the same command from the root against the reference:

:::term source=captures/14-console-baseline.txt

:::term source=captures/14-console-64k.txt

Subtract: 87,041 − 12,111 = 74,930 more bytes written, for 210,986 − 32,913 = 178,073 more exits. The bytes are the 64 KiB, a carriage return the guest's tty layer adds before each of its 9,362 newlines, and 32 bytes of echoed command and prompt. That is about 2.4 exits per byte, against 2.7 in the boot. The difference is the driver: earlycon, which prints much of the boot log, reads the flag register before and after every byte (three exits), while the full PL011 driver needs fewer.

The host spent 0.53 s more processor time. At chapter 03's 1.4 microseconds per exit, 178,000 exits are a quarter of a second of round trips alone; the rest is our own work per exit (decoding, the device lock, filtering, the terminal write). Write the number down; chapter 15 starts from it.

## Shell, panic and SIGINT

The `shell` case starts an interactive BusyBox shell on the console. Type a command, and every keystroke travels from your terminal through the PL011's receive interrupt into the guest:

:::term source=captures/14-shell-session.txt

`macvmm-shell: 42` means input, the interrupt, the shell and output all work.

A [kernel panic](/build-your-own/vmm/glossary/#kernel-panic) is the kernel's last resort: it prints why it cannot continue, then spins forever, which our VMM cannot tell apart from a busy kernel. So the checkpoint boots with `panic=-1`, which makes the kernel reboot at once after a panic, and with chapter 08's `--on-reset exit`, which turns that reboot (a PSCI `SYSTEM_RESET`) into exit status 4. A test then sees a panic as a number instead of a timeout:

:::term source=captures/14-panic-reset.txt

> **Aside.** `panic=N` is a kernel command-line parameter: after a panic, wait N seconds and reboot; a negative N reboots at once ([`Documentation/admin-guide/kernel-parameters.txt`](https://www.kernel.org/doc/html/latest/admin-guide/kernel-parameters.html)).

Two more behaviours the checkpoint checks. SIGINT stops the VM at once with status 130, `128 + 2`. At a prompt, raw mode makes your Ctrl-C a byte for the guest's shell, not a signal; you quit with `Ctrl-A x`, and SIGINT comes from `kill -INT` or a script:

:::term source=captures/14-sigint-quit.txt

And `timer-latency` asks for a hundred 10 ms sleeps; each one needs the virtual timer to fire and the interrupt controller to wake the vCPU:

:::term source=captures/14-timer-usleep.txt

1.07 s for a requested 1.00 s, shell overhead included: the timer and the GIC deliver promptly. The checkpoint accepts 1.00 to 1.99 s.

:::stopping-point Good place to stop. The next half breaks the machine three ways and adds the dump that diagnoses them.

## The exit ring, on demand

Chapter 07 gave every vCPU a ring of its last 256 exits, and a fatal stop printed the last 32 of them. That covers only failures our VMM *notices*; a panicked kernel spins quietly, and the run loop sees nothing. We need a **[ring dump](/build-your-own/vmm/glossary/#ring-dump)**: every running vCPU's ring, printed on request while the guest keeps running.

The requests come from chapter 09's stdin and signal threads, which live for the whole process. But each boot, and each reboot, builds a fresh machine with a fresh stop control, chapter 09's `VmControl`. The threads need a stable meeting point that each boot plugs into while it runs: `HostCtl`, new in `learner/crates/vmm/src/hostctl.rs`. A quit stops whatever boot is attached, and a quit between two boots stops the next one at once:

:::code anchor=hostctl_attach file=crates/vmm/src/hostctl.rs

Three edits wire it in:

1. Add `hostctl: Arc<HostCtl>` (made with `Arc::new(HostCtl::new())`) to the struct that holds your host side. In the reference that is `HostIo` (`crates/vmm/src/backend/hostio.rs`); give the machine a clone of the `Arc`.
2. At the start of `Machine::run` in `learner/crates/vmm/src/machine/mod.rs`, which chapter 08's reboot loop calls once per boot, write `let attached = self.hostctl.attach(&ctl);` before the vCPUs start. The guard detaches when `run` returns.
3. Make `Ctrl-A x` and the signal thread's quit arms call `hostctl.request_quit()` instead of `ctl.request_stop`. In the reference, `HostIo::request_quit` does that.

Beside the attached boot, `HostCtl` keeps a list of rings, one per running vCPU:

:::code anchor=hostctl_inner file=crates/vmm/src/hostctl.rs

The list holds a [`Weak`](/build-your-own/vmm/glossary/#weak) (chapter 09's non-owning `Arc`, made here by `Arc::downgrade`) to each `ExitRing`, so the registry never keeps a ring alive: once the vCPU drops its own `Arc`, `upgrade()` returns `None` and the dump skips that ring. A dump that wins the race holds a ring only until its text is built, and `Arc` guarantees it never reads a freed one. The `host-concurrency` primer reviews `Arc` and `Mutex`:

:::code anchor=hostctl_dump_rings file=crates/vmm/src/hostctl.rs

In chapter 07 your `VcpuLog` held the ring by value; make the field `ring: Arc<ExitRing>`, so the registry can hold a second, weak pointer to it. The vCPU thread reaches `HostCtl` through `obs.host`, an `Option<&HostCtl>` that `Machine::run` fills in (`None` in tests). In `learner/crates/vmm/src/vcpu/manager.rs`, each vCPU thread registers its ring once it is set up and allowed to run, and removes it when its run loop returns:

:::code anchor=vcpu_register_ring file=crates/vmm/src/vcpu/manager.rs

:::code anchor=vcpu_unregister_ring file=crates/vmm/src/vcpu/manager.rs

The text itself is built next to the records, in `learner/crates/vmm/src/trace.rs`. Each ring is locked only for the copy inside `ExitRing::last`, never while formatting or writing, so a slow terminal cannot stall the guest:

:::code anchor=trace_ring_dump_fn file=crates/vmm/src/trace.rs

From the keyboard: add a `t` arm, `Command::DumpRing`, to chapter 09's escape parser in `learner/crates/macvmm/src/term.rs` (the `tty-termios` primer explains why raw mode hands us `Ctrl-A` as byte `0x01`):

:::code anchor=stdin_escape_parser file=crates/macvmm/src/term.rs

Chapter 09 showed the stdin loop and the signal thread with their dump arms already in, and let you skip those arms because `HostCtl` did not exist yet. If you skipped them, add them now; if you stubbed them, point them at `host.hostctl.dump_rings()`. In the stdin loop, the arm prints the dump on standard error:

:::code anchor=stdin_loop file=crates/macvmm/src/term.rs

From another terminal: SIGUSR1, through chapter 09's self-pipe and signal thread. In `learner/crates/macvmm/src/signals.rs`, `SIGUSR1` must be in the installed list, with its `Ok(SIGUSR1)` arm:

:::code anchor=signal_thread file=crates/macvmm/src/signals.rs

You will need this in the first break.

## Breaking it on purpose

Three one-line edits to your `learner/` tree, each undone before the next; Linux is unchanged. After each edit, boot the `boot` case from inside `learner/` (`cargo run` rebuilds first):

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=boot" --timeout 10
```

### A missing timer

**Deliberate breakage 1: no `/timer` node.** In `learner/crates/vmm/src/fdt/machine.rs`, delete the call that writes it, the line `timer(&mut w, with_gic)?;`. The node you removed is this one:

:::code anchor=fdt_machine_timer file=crates/vmm/src/fdt/machine.rs

:::predict What is the last line of serial output, and what exit status does `macvmm` return?
Write your guess under `## Predict` in your journal before you look. A common guess is "no error at all: the output stops where the timer is set up". Another is "a clean message about the timer".
:::

:::term source=captures/14-no-timer.txt

We checked this on a real Mac, and the second guess is the closer one: `timer_probe: no matching timers found`, then `Kernel panic - not syncing: Unable to initialise architected timer.`, from stage 4, `time_init`. Linux cannot run without a clock, and says so.

But look at the bottom: exit status 5, from `--timeout`. Our VMM never learned that its guest had died. Ask the ring what the vCPU was doing. In a second run, we sent SIGUSR1 three seconds after the start (the capture's header records when):

:::term source=captures/14-no-timer-usr1.txt

The last 256 exits are the panic message, one byte at a time: a flag-register read (`0x9000018`), a data-register write (`0x9000000`), another read. The last record is stamped 36 ms after the start; the dump came at 3 s. For almost three seconds the vCPU ran without an exit, spinning in the panic loop. Press `Ctrl-A t` twice in your own run and watch the newest `t_ns` stay put.

What you saw: a named panic, then a hang our VMM could not see. The misconception it exposes: "if the guest dies, the VMM will know". The tool that finds it: the ring dump on demand, whose timestamps tell "stuck in a loop" from "busy".

### A misplaced redistributor

**Deliberate breakage 2: a wrong redistributor base.** In `gic()` in `learner/crates/vmm/src/fdt/machine.rs`, change the second `reg` pair from `GICR_BASE` to `GICR_BASE + 0x20000`, one whole redistributor higher: each redistributor is 128 KiB (two 64 KiB frames, chapter 12). The real GIC is unchanged; only the device tree now points Linux at the wrong place:

:::code anchor=fdt_machine_gic file=crates/vmm/src/fdt/machine.rs

:::predict Does Linux notice, and does our VMM stop it with an unhandled-MMIO error?
Write your guess on paper; nothing checks it.
:::

:::term source=captures/14-wrong-gicr.txt

Stage 3 fails loudly: `GICv3: No redistributor present`, a `WARNING` with a call trace, then an Oops in `gic_poke_irq` and a panic. Our VMM printed nothing until the timeout. Why no unhandled-MMIO stop? The trace says:

:::term source=captures/14-wrong-gicr-trace.txt

Linux read offset `0xFFE8` of the redistributor it was told about: the register `GICR_PIDR2`, whose architecture-revision field must say "GICv3" or "GICv4". Hypervisor.framework claims only the redistributors of the vCPUs that exist, 128 KiB for our one vCPU. Our VMM maps the rest of the window, up to the PL011, as a [read-as-zero, writes-ignored](/build-your-own/vmm/glossary/#raz-wi) region, so a stray access gets zeros instead of a fatal stop. The healthy boot counted no GIC exits because Linux never strays there; this time it did. The region is registered in `learner/crates/vmm/src/machine/virt.rs`:

:::code anchor=gicr_unused_razwi file=crates/vmm/src/machine/virt.rs

So the answer was a polite `0x0`, and Linux concluded no redistributor was there.

An **[Oops](/build-your-own/vmm/glossary/#oops)** is Linux's report of a fault inside the kernel itself; here it was fatal. Read it with chapter 02's tools. The ESR (exception syndrome register) is `0x96000044`: EC (exception class) `0x25`, a data abort taken at the current exception level (EL1); the Oops prints it as `DABT`. So it went to the guest's own vector table, not to us.

The address is exact, too. To enable a per-CPU interrupt, `gic_poke_irq` writes to the redistributor's second 64 KiB frame plus `GICR_ISENABLER0` (`0x100`). With no redistributor found, its base is 0: 0 + `0x10000` + `0x100` = `0x10100`. The ISS (instruction specific syndrome) bits agree: `WnR = 1` (write-not-read: a write), and `FSC = 0x04` (fault status code: a translation fault at level 0), an address nothing maps.

What you saw: a loud failure at the GIC stage, and silence from the VMM. The misconception: "a wrong address gives an unhandled-MMIO error". The tool: a trace filtered to `mmio`, grepped for the window.

### A mute UART

**Deliberate breakage 3: identification registers that read zero.** In `learner/crates/vmm/src/devices/pl011.rs`, set `ID_BYTES` to `[0; 8]`, and add `--stats` to the boot command.

:::predict Using your chapter 09 guess: what happens to the console?
Write your guess in your journal under Q3, where you will check it.
:::

:::term source=captures/14-no-pl011-id.txt

Exit status 0, and `reboot: Power down`. But there is no `ttyAMA0 at MMIO` line, Linux warns `unable to open an initial console`, and the line `macvmm-initramfs: ready` never appears. The AMBA bus read zeros where `0x00141011` and the cell ID `0xB105F00D` should be, so it could not identify the device and kept deferring it (try the trace: the ID reads repeat). No driver bound, and no `ttyAMA0` was created.

Why do the kernel's own lines still appear? earlycon writes to the PL011 by address, and Linux retires it only when a real console (`ttyAMA0`) registers, which never happened, so the kernel kept printing through it.

`/init` writes to `/dev/console`, which needs that real console (the `linux-boot-sequence` primer), so its output had nowhere to go. Remove `earlycon` from the command line, and you have the opening run: a kernel that boots, powers off, and says nothing.

What you saw: a "successful" boot with a missing line. The misconception: "if Linux boots, the devices are correct". The tool: the stage table, which says which milestone line is missing, and the `--stats` line, which says the kernel ran: 35,470 exits.

### Three fingerprints

What a broken part looks like from outside (its last stage, what the kernel says, how our VMM exits) is its **[failure fingerprint](/build-your-own/vmm/glossary/#failure-fingerprint)**:

| Broken part | Last stage reached | Kernel says | `macvmm` exit |
|---|---|---|---|
| `/timer` node | 4, time | `Unable to initialise architected timer`, panic | 5, timeout |
| redistributor base | 3, interrupts | `No redistributor present`, Oops, panic | 5, timeout |
| PL011 identification registers | 8, but with no console | `unable to open an initial console` | 0 |

None of the three produced a diagnostic from our VMM: at most a timeout. Breakage 3 is the dangerous one: Linux tolerated a broken device and reported success, so booting is where testing starts, not where it ends. A timeline of a run's trace shows where its exits cluster and stop; try your three broken runs:

:::lab boot-timeline

## Your turn

Before the checkpoint:

1. Boot the `shell` case with the `cargo run` line from the console measurement. At the prompt, press `Ctrl-A` then `t`; from a second terminal, run `kill -USR1 $(pgrep -n macvmm)` and compare.
2. Rerun the boot with `--trace exits:boot.jsonl:psci` and check that only PSCI calls remain.
3. Repeat the 64 KiB measurement on your own build and write both numbers in your journal.
4. Extend the log table to 20 lines in journal question 2.

> **Try it.** In `primecell()` in `learner/crates/vmm/src/fdt/machine.rs`, which writes both the PL011 and the PL031 nodes, skip the `interrupts` property for the PL011 only (when `region.base` is `PL011_BASE`), and boot the `shell` case. Before you run it, predict which of output and input still work, then look at whether the prompt appears and whether it answers your typing.

Stuck? `scripts/learner hint 14` gives four hints, from a nudge to the exact reference file.

## Checkpoint

:::checkpoint

The checkpoint first runs three host-only tests: two on your comma-list parse (a union of names; unknown or empty refused) and one on a ring registry that never keeps a ring alive. Then it boots Linux six ways on your Mac and checks:

- (a) `macvmm.test=boot` prints eight of the table's milestone lines plus `macvmm-initramfs: ready`, in order, from `Booting Linux on physical CPU` to `reboot: Power down`, with no `Kernel panic`, `unhandled MMIO` or `unknown SMCCC`, and exits 0; its trace, filtered to `hvc,sysreg`, holds `PSCI_VERSION` and `PSCI_SYSTEM_OFF` and no data abort, which proves the filter dropped the MMIO exits;
- (b) `shell` answers `macvmm-shell: 42` and powers off with 0;
- (c) `panic` exits 4;
- (d) SIGINT at the prompt exits 130;
- (e) `timer-latency` reports a time from 1.00 to 1.99 s;
- (f) SIGUSR1 and then `Ctrl-A t` at the prompt each print a 256-exit dump on standard error, and the shell still answers.

Then it checks your journal. This is the checkpoint on our Mac, run against the reference:

:::term source=captures/14-checkpoint.txt

What now works:

- a stock Linux kernel boots on your VMM to a shell, takes your typing, and powers off, panics or quits with distinct exit statuses;
- you can trace any line of its boot log to the node or device that caused it;
- you can tell a missing timer, a misplaced redistributor and a mute UART apart from their fingerprints;
- you can dump a running guest's last 256 exits, and filter a trace;
- you know what a console byte costs: between 2.4 and 2.7 exits.

This is the end of the core path. The next chapter starts from this state (the reference at the end of chapter 14).

### What's next

178,000 exits for 64 KiB of text; a disk read through registers like the PL011's would cost as many. Chapter 15 builds **virtio**, a standard way for guest and VMM to share rings of buffers in guest memory, so a whole request costs one exit instead of one per byte; chapter 18 uses it for a disk, a file on your Mac that the guest sees as a block device.

### Open question

Linux booted. List three things a useful VM must do that this one cannot, and defend the order you would build them in: what would you build first, and why that one?

## Spec hunt

- GICv3 and GICv4 architecture specification (Arm IHI 0069), register **GICR_PIDR2**: which field did Linux read at offset `0xFFE8` in breakage 2, and which values mean "a GICv3 or GICv4 redistributor is here"?
- PrimeCell UART (PL011) Technical Reference Manual (Arm DDI 0183), registers **UARTPeriphID0-3** and **UARTPCellID0-3**: which bits of the eight bytes give the part number, the designer and the revision that Linux printed as "PL011 rev1"?
- Linux device-tree binding `Documentation/devicetree/bindings/timer/arm,arch_timer.yaml`: which properties are required, and in which order are the four timer interrupts listed?
