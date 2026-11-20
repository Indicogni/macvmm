---
title: SMP: many vCPUs, many threads
part: VIII
chapter: VIII.1
id: 20
runs: mac+browser
minutes: 360
prereqs: [18, 12]
start_tag: ch-19
labs: [smp-boot-timeline]
command: scripts/checkpoint.sh 20
expect: CHECKPOINT 20 PASS
---

:::retrieval from=12,08,06

:::concepts
- **Core, taught here:** one host thread per virtual CPU (vCPU), every one created at startup in index order; a parked vCPU and its `CPU_ON` mailbox; the two properties of the kick that matter with many vCPUs, sticky and spurious; the power state coordination interface (PSCI) calls `CPU_ON`, `CPU_OFF` and `AFFINITY_INFO` with their return codes; the affinity fields of `MPIDR_EL1` (the multiprocessor affinity register, MPIDR for short) against the device tree's `/cpus` and the interrupt controller's redistributors; the lock order for bus, device and vCPU state, applied.
- **Core, from earlier:** `MPIDR_EL1`, its affinity fields `Aff0` and `Aff1`, and its bit 31 (chapter 06, whose park question this chapter answers); PSCI over the SMC (secure monitor call) calling convention and its two conduits (chapter 08); the stop flag, the kick (`hv_vcpus_exit`, first met in chapter 03) and each device behind its own `Mutex` (chapter 09); `/cpus` and `reg` (chapter 10); the redistributor and software-generated interrupts, SGIs (chapter 12); the virtqueue's state, the interrupt status and the disk worker (chapters 15 to 18).
- **Primers (read first):** `memory-ordering` (the lost wakeup, and a mutex as a release and an acquire); `host-concurrency` (threads, `Mutex`, condition variables, deadlock and a fixed lock order, the `sample` tool).
- **Primers (review):** `smccc` (function IDs, arguments in `x1` to `x3`, the result in `x0`); `arm64-boot-protocol` (the state a CPU starts in); `unix-signals` (SIGINT, and why a second one can end a stuck process).
- **Pointers:** how Linux numbers its CPUs from their MPIDRs (an Aside); the GICv3 limit of 16 CPUs per cluster for SGIs (a linked sentence); how KVM-based VMMs kick a vCPU (a Production note).
- **Forward definitions:** pausing every vCPU for a snapshot (chapter 26). Defined at first use.
:::

Every device on our bus sits behind its own `Mutex` (chapter 09). With one vCPU, that lock only ever kept the stdin thread out of the way. Now give the guest four CPUs, each on its own host thread, and run a stress test where all four read the disk and print to the serial console as fast as they can.

:::predict In a scratch copy, delete the lock around the devices on the bus and run that stress test. What happens: garbled console output, a crash, a hang, or something before any of those?
Write your choice and one sentence of reasoning under `## Predict` in your journal. Sitting B tries it.
:::

This chapter closes row 9 of chapter 00's problem ledger, several CPUs, and finishes row 4, asking the platform to start and stop them. Sitting A is the design and the power table, host-only code you can build and test without a guest (about 2.5 hours); sitting B runs it, breaks it three ways and scales it to 64 vCPUs, at your Mac (about 3.5 hours).

:::objectives
- (Sitting A) Explain why every vCPU is created at startup, on its own thread, in index order, and compute `MPIDR_EL1` for vCPU 17 (`0x8000_0101`), matching the device tree's `/cpus` `reg` and the redistributor Linux reports.
- (Sitting A) Walk PSCI `CPU_ON(target, entry, context)` through the per-CPU state machine and predict its answer in each case: `SUCCESS`, `ALREADY_ON`, `ON_PENDING`, `INVALID_PARAMETERS` or `INVALID_ADDRESS`; implement `CPU_OFF` and `AFFINITY_INFO`.
- (Sitting B) Stop a running vCPU from another thread with `hv_vcpus_exit`, and state what must hold before it runs the guest again.
- (Sitting B) Diagnose a lock-order deadlock with the stress test and `sample`, fix it, and state the lock order for bus, device and vCPU state.
- (Sitting B) Explain with an example how the guest's ordering assumptions between its CPUs now pass through our devices.
:::

**Before you start.** Run `scripts/learner start 20` from the repository root; it copies this chapter's journal to `learner/journal/20.md`. The stress test needs chapter 18's disk; make a 64 MiB test disk once, from the repository root, with `cargo xtask mkdisk --size 64M --seed 1 --out learner/disk.img`. What you will build is listed under "Your turn" at the end; each section says which item it specifies.

## One thread per vCPU, all of them at startup

A guest with four CPUs expects four things to happen at once, and our virtual machine monitor (VMM) must make that true. Linux on [**SMP**](/build-your-own/vmm/glossary/#smp) (symmetric multiprocessing) hardware runs a scheduler on every CPU, sends interrupts from one CPU to another, and takes it for granted that CPU 2 keeps running while CPU 1 waits for the disk.

Chapter 02 fixed how we can give it that. A vCPU belongs to the thread that created it, and `hv_vcpu_run` blocks that thread while the guest runs. So four vCPUs need four host threads, one each; there is no way to run two vCPUs from one thread at the same time. This answers the question chapter 02's journal parked.

When should those threads appear? The tempting answer is "when the guest asks for a CPU". It is wrong twice. First, Hypervisor.framework (HVF) hands out the interrupt controller's per-CPU [redistributor](/build-your-own/vmm/glossary/#redistributor) frames (chapter 12) in vCPU *creation* order: the k-th vCPU created gets frame k, and that frame's `GICR_TYPER` reports the affinity in that vCPU's MPIDR. Second, the header `hv_gic.h` says the controller's set of CPUs is final once a vCPU has run.

A guest that walks the frames, as chapter 12 showed Linux does, finds its own in any order. The order matters to *us*: we want frame *i* to belong to vCPU *i*, so the layout is the same on every boot, matches the log line `found redistributor 1 region 0:0x080c0000` you will see below, and can be checked. Spawning the threads in order is not enough, because threads race: thread 2 may create its vCPU before thread 1 does. So the VMM creates every vCPU before the first one runs, and spawns the next thread only after the previous one reports that its vCPU exists, a [rendezvous](/build-your-own/vmm/glossary/#rendezvous):

:::code anchor=vcpu_sequential_create file=crates/vmm/src/vcpu/manager.rs

Each thread checks the frame it got against the address our layout assigns to its index, `0x080A_0000 + index × 128 KiB`. That is our own invariant, not a promise of the device tree, which gives only the whole region; chapter 12 showed why the guest itself does not rely on it.

:::code anchor=vcpu_redistributor_check file=crates/vmm/src/vcpu/manager.rs

The [start gate](/build-your-own/vmm/glossary/#start-gate) keeps vCPU 0 out of the guest until the loop has finished. Only vCPU 0, the [**boot CPU**](/build-your-own/vmm/glossary/#boot-cpu), runs then. Every other vCPU is a [**secondary CPU**](/build-your-own/vmm/glossary/#secondary-cpu): powered off, its thread alive but waiting, until the guest asks for it.

Here is the misconception this chapter takes apart: "more vCPUs is more threads doing the same thing". The threads do run the same loop. But every device, every table and every flag that two of them can reach has now become a concurrent data structure.

## Three places that look up `MPIDR_EL1`

Chapter 06 gave vCPU 0 the identity `0x8000_0000` and left a question parked: where else is this number looked up? With more CPUs, the layout chapter 06 drew matters: the low byte, `Aff0`, numbers CPUs within a cluster, the next, `Aff1`, numbers clusters, and bit 31 always reads 1. For us a cluster is only a label in the number, not cores sharing a cache. Two more fields, Aff2 (bits 16 to 23) and Aff3 (bits 32 to 39), number larger groups; ours stay 0.

:::code anchor=mpidr_for_index file=crates/vmm/src/arch/regs.rs

Work one example by hand: vCPU 17 is cluster 17 / 16 = 1, CPU 17 % 16 = 1, so `0x8000_0101`. Sixteen per cluster is QEMU's choice too, because in Arm's Generic Interrupt Controller version 3 (GICv3) a software-generated interrupt can name at most 16 CPUs of one cluster in a single write (the `TargetList` field of `ICC_SGI1R_EL1` in Arm's [GICv3 specification](https://developer.arm.com/documentation/ihi0069/latest)).

The first place that looks the number up is the device tree. Each `cpu@…` node's `reg` is the affinity, without bit 31, and `enable-method = "psci"` tells Linux how to start it (Your turn, item 4):

:::code anchor=fdt_machine_cpus file=crates/vmm/src/fdt/machine.rs

The second is our power table. When Linux asks to start "CPU `0x101`", that is the number it took from `reg`, and the VMM must find which vCPU carries it. A target with any bit outside the affinity fields names no CPU, and neither does an affinity no vCPU was given:

:::code anchor=psci_index_of_fn file=crates/vmm/src/psci.rs

The third is the vCPU itself. Each CPU can read its own `MPIDR_EL1`: our test guests' start code uses it to pick a stack (chapter 06), Linux prints it as each secondary comes up, and the redistributor in the Generic Interrupt Controller (GIC) reports the same affinity. One function, `mpidr`, feeds all three; breakage 1 shows what happens when it does not.

> **Aside.** Linux keeps its own CPU numbers, 0 to N-1, and a table from each number to the hardware ID it read from the device tree (`cpu_logical_map`, filled in [`arch/arm64/kernel/smp.c`](https://elixir.bootlin.com/linux/v6.18/source/arch/arm64/kernel/smp.c)). The table is how "start CPU 2" becomes a `CPU_ON` target. The boot CPU fills its own row by reading `MPIDR_EL1`; that is the line `Booting Linux on physical CPU 0x0000000000` at the top of every boot log.

## How a secondary CPU starts

Linux, on the boot CPU, starts each secondary with one PSCI call, [**`CPU_ON`**](/build-your-own/vmm/glossary/#cpu-on), which chapter 08 left for now. It has three arguments: the target's affinity, the guest-physical address, an intermediate physical address (IPA, chapter 05), where the new CPU should begin, and a [**context ID**](/build-your-own/vmm/glossary/#context-id), a value the caller chooses. Step through it in the lab: the boot CPU calls, our VMM records the request, the secondary's thread wakes and starts at the entry point with the context in `x0`. If the lab offers a mismatched MPIDR, try it; deliberate breakage 2 makes the same mistake on a real Mac.

:::lab smp-boot-timeline

If the lab does not load, work the timeline below by hand, then read breakage 2. It is the real timeline from our test guest, `smp-race`: every PSCI call and every kick, as `--trace` recorded it.

:::term source=captures/20-race-trace.txt

Lines 1 and 2 are the two `CPU_ON(1)`s; line 3 is `CPU_ON(2)`; lines 4 to 6 are the three-way race for CPU 3, from vCPUs 0, 1 and 2; line 7 is CPU 3's `CPU_OFF`; line 8 is its restart with context `0x33`; lines 9 and 10 are two refusals (no CPU 4, an entry at `0x1000`). At the end come `SYSTEM_OFF` from vCPU 0 and one `canceled` exit for each secondary: the stop pulling them out of the guest.

A secondary starts in the state the arm64 boot protocol promises (the `arm64-boot-protocol` primer). The entry point and the context come from the request; the rest is the reset state of chapter 06:

:::code anchor=vcpu_power_on_fn file=crates/vmm/src/vcpu/mod.rs

## A power table, one lock per CPU

PSCI gives each CPU three states. Off; then **on pending** once a `CPU_ON` has been accepted; then on once the target's own thread has taken the request, when it is about to enter the guest. `CPU_OFF`, called by the CPU itself, takes it back to off:

```text
             CPU_ON(target) by another CPU          target's thread takes the request
   Off  ------------------------------------>  OnPending  ------------------------------>  On
    ^                                                                                       |
    +------------------------------ CPU_OFF, called by the CPU itself <---------------------+
```

*Only an off CPU can be started, and only a running CPU can turn itself off.*

Why "on pending" at all? Between the call that accepts the request and the moment the target's thread acts on it, there is a window. A second `CPU_ON` arriving in that window must not start the CPU twice, and until the target's own thread has accepted the request, the honest answer is "pending". Each answer has a code:

| Situation | `CPU_ON` returns |
|---|---|
| target off, entry point valid | `SUCCESS` (0) |
| target's thread has taken its request (running, or about to run) | [`ALREADY_ON`](/build-your-own/vmm/glossary/#on-pending-already-on) (-4) |
| request accepted, not yet taken | `ON_PENDING` (-5) |
| no CPU with that affinity | `INVALID_PARAMETERS` (-2) |
| entry point not 4-byte aligned, or outside RAM | `INVALID_ADDRESS` (-9) |

Each CPU's row holds its state and a [**mailbox**](/build-your-own/vmm/glossary/#cpu-on-mailbox), one slot for the accepted request, behind *its own* mutex, with a condition variable its thread waits on:

:::code anchor=psci_target_state file=crates/vmm/src/psci.rs

`CPU_ON` checks the state and changes it under the target's lock, so of any number of racing calls exactly one sees "off". It never creates a thread: it fills a mailbox and wakes a thread that has existed since startup.

:::code anchor=psci_cpu_on_fn file=crates/vmm/src/psci.rs

> **Security.** Every argument of `CPU_ON` is chosen by the guest: the target, the entry point and the context. The target must name a vCPU that exists, and the entry point must be 4-byte aligned and inside guest RAM, checked before any vCPU state changes. And because all threads exist from startup, a guest that sends a million `CPU_ON`s can only collect a million refusals; it cannot make the VMM spawn a thread or allocate anything.

:::code anchor=smccc_entry_valid_fn file=crates/vmm/src/smccc.rs

[**`AFFINITY_INFO`**](/build-your-own/vmm/glossary/#affinity-info) reads the state (0 on, 1 off, 2 on pending). It takes two arguments: the target's affinity and the lowest affinity level to report on. Level 0 asks about one CPU, level 1 about a whole cluster; we answer only level 0 and refuse the rest with `INVALID_PARAMETERS`, which PSCI allows. [**`CPU_OFF`**](/build-your-own/vmm/glossary/#cpu-off) is the only transition a CPU makes for itself:

:::code anchor=psci_affinity_cpu_off_fn file=crates/vmm/src/psci.rs

Notice what is not here: a lock around the whole table. The list of CPUs never changes after startup, so finding a target takes no lock, and calls for different CPUs never wait for each other.

Now work the table on paper. Four vCPUs, all three secondaries off; vCPU 0 makes these calls in order, with entry `0x4008_0000` unless one is given:

1. `CPU_ON(0x1)`.
2. `AFFINITY_INFO(0x1, 0)`, before vCPU 1's thread has woken.
3. `CPU_ON(0x1)` again, still before it has woken.
4. The same call, after vCPU 1's thread has taken its mailbox.
5. `CPU_ON(0x2)` with entry `0x4008_0002`.
6. `CPU_ON(0x10)`.
7. `CPU_ON(0x8000_0002)`.
8. vCPU 1 calls `CPU_OFF`; then `AFFINITY_INFO(0x1, 0)`.
9. `AFFINITY_INFO(0x1, 1)`.

:::predict What does each of the nine calls return?
1: 0, and CPU 1 is on pending. 2: 2. 3: -5. 4: -4. 5: -9, not 4-byte aligned. 6: -2: `0x10` is Aff0 = 16, and Aff0 only counts 0 to 15. 7: -2: bit 31 is outside the affinity fields, because `reg` never carries it. 8: 1. 9: -2, a level we do not implement.
:::

Before you stop, write Your turn items 3 (without `park` and `wake_all`, which sitting B specifies) and 4, and check that `cargo build -q -p vmm` succeeds from inside `learner/`. Both are host-only code, so this needs no guest.

:::stopping-point Good place to stop. Sitting B needs your Mac, your learner workspace and about 3.5 hours.

## Parking: waiting without running the guest

A secondary's thread must stay alive, because only it can run its vCPU, but it must not sit in `hv_vcpu_run`, because that would run guest code on a CPU that is off. So it waits on its row's condition variable. That is a [**parked vCPU**](/build-your-own/vmm/glossary/#parked-vcpu). Here is the thread's body, from creation to the rendezvous and the start gate (Your turn, item 1):

:::code anchor=vcpu_thread_create file=crates/vmm/src/vcpu/manager.rs

After a few lines that register the thread's exit log for debugging, a secondary parks until its `CPU_ON` arrives:

:::code anchor=vcpu_thread_park file=crates/vmm/src/vcpu/manager.rs

The wait is the lost-wakeup problem of the `memory-ordering` primer in host clothes. A waker that fills the mailbox, or a stop that sets the flag, could slip in between the parked thread's check and its sleep. The cure is the condition-variable pattern of the `host-concurrency` primer: check both under the mutex, and change or notify under the same mutex (Your turn, item 2).

:::code anchor=vcpu_park_wait file=crates/vmm/src/vcpu/wait.rs

:::code anchor=psci_park_wake file=crates/vmm/src/psci.rs

`CPU_ON`, above, notifies after releasing the lock. That is still safe, because the mailbox was filled under the lock: a waiter either sees it in its check or is already asleep in `wait`, and wakes. `wake_all` has nothing to change under the lock, because the stop flag lives elsewhere, so it notifies while holding each lock instead.

A vCPU that calls `CPU_OFF` later parks the same way. That is the `CpuOff` arm chapter 07 left out of the run loop, which you add now: it parks, then calls `power_on` with whatever the next `CPU_ON` brought.

## The first SMP run

Our test guest `smp-race` drives every case from vCPU 0: two `CPU_ON`s in a row for CPU 1, each secondary reporting the MPIDR it reads, three CPUs racing to start CPU 3, CPU 3 turning itself off and back on, and three requests that must be refused. The race, from the guest's side; vCPUs 1 and 2 spin on `GO` and call at the same moment as vCPU 0:

:::code anchor=smp_race_three_way file=guests/smp-race/main.rs

Run it from inside `learner/`, with `G` set as in chapter 09. Our captures ran from the repository root, so their paths start at `target/` and `.cache/`; from `learner/`, prefix them with `../`.

```sh
G=../target/guests/aarch64-unknown-none/release
cargo run -q -p macvmm -- run --cpus 4 --mem 64M --stats --kernel $G/smp-race --timeout 20
```

:::term source=captures/20-smp-race.txt

Read it line by line. The second `CPU_ON(1)` got -4: by then vCPU 1's thread had taken its mailbox. Either -4 or -5 is right, and which you see is host timing. In the race for CPU 3, vCPU 0 won and vCPUs 1 and 2 got -5, still pending. Each secondary reads the MPIDR the VMM gave it, and `cpu 3 back on ctx=0x33` is the context of the second start, read from CPU 3's own `x0`.

Then the refusals: no CPU 4 (-2), an entry at `0x1000`, outside RAM (-9), and `AFFINITY_INFO` at level 1, which we do not implement (-2). In the stats, each secondary has exactly one `canceled` exit. That is how they stopped.

## Stopping a running vCPU: the kick

`SYSTEM_OFF` came from vCPU 0. vCPUs 1 to 3 were inside `hv_vcpu_run` at that moment, running guest code on their own threads. A thread blocked in a framework call cannot read a flag. Something must reach into the framework from outside.

That is the [kick](/build-your-own/vmm/glossary/#kick) you built in chapter 09 for the stop, and chapter 11 reused for the no-controller timer: `hv_vcpus_exit`, which any thread may call, forces the listed vCPUs out of `hv_vcpu_run` with the exit reason `CANCELED`. With one vCPU that was all we needed to know. With many, two properties matter. A kick is **sticky**: as chapter 09's stop relied on, a kick sent to a vCPU that is not in the guest is kept, and its next run returns at once. And a kick can be **spurious**: a run may return `CANCELED` when nobody wants anything now. For example, a stop request kicks vCPU 2 while it is out of the guest handling a memory-mapped I/O (MMIO) access; the kick is kept, so its next run returns `CANCELED` at once, even if by then there is nothing left for it to do. So a `CANCELED` exit never means "stop"; it means "look at what was posted". Chapter 09's stop protocol already has that shape: `request_stop` posts the flag first and kicks every registered vCPU second. One case is new with many threads. A thread that registers its vCPU after the stop has begun is kicked on the spot, so it cannot miss it:

:::code anchor=vm_control_register file=crates/vmm/src/control.rs

What must be true before a kicked vCPU runs the guest again is journal question 2. A hint: no other thread ever touches a vCPU's registers. They post what they want, then kick, and the vCPU's own thread does the rest.

> **Production note.** Linux's kernel-based virtual machine (KVM) has no `hv_vcpus_exit`. VMMs built on it, such as Firecracker and crosvm, kick a vCPU thread with a signal (the `unix-signals` primer), which makes its `KVM_RUN` call return early; the `immediate_exit` field in the [KVM API documentation](https://docs.kernel.org/virt/kvm/api.html) closes the same race our sticky kick closes. The protocol is the same: post, then kick, then let the vCPU's own thread look. Chapter 26 will use the same kick to pause every vCPU at a safe point before saving a snapshot.

## Linux on four CPUs

Now the real guest, with the test initramfs's `smp` case, from inside `learner/`. The serial log goes to a file, so the stats are all the terminal shows:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --cpus 4 --mem 1G --stats --serial file:boot.txt --on-reset exit --timeout 60 --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test=smp"
```

:::term source=captures/20-linux-smp-run.txt

Every vCPU has hundreds to tens of thousands of `data abort` exits: MMIO, from every CPU. The serial log:

:::term source=captures/20-linux-smp-log.txt

Three `Booted secondary processor` lines, one for each `CPU_ON` that vCPU 0 made, and each secondary finding the redistributor at the next 128 KiB. Timer interrupts arrived on all four CPUs, and so did software-generated interrupts, which Linux calls [IPIs](/build-your-own/vmm/glossary/#ipi) (inter-processor interrupts). None of the IPIs cost an exit: apart from the one `canceled` exit of the stop, the stats show only `hvc`, `sysreg` and `data abort`. The in-kernel GIC delivered them.

## Predict, answered: every device is shared now

Back to the opening question. This is the edit, in a scratch copy: the bus stores `Arc<dyn MmioDevice>` instead of `Arc<Mutex<dyn MmioDevice>>`, and `read` and `write` call the device without `lock`. Your `learner/` is its own git repository, so a scratch copy can be your own tree: from the repository root, commit first with `git -C learner add crates && git -C learner commit -m 'ch20 works'`, make the edit, and undo it afterwards with `git -C learner checkout -- crates`. Build it:

:::term source=captures/20-nolock-build.txt

It never runs. Ignore the six errors from callers that still wrap devices in a `Mutex`; the last three are the lesson. A device is not `Sync`, so a `Bus` holding one cannot be shared by reference with the vCPU threads (the full message points at the call that spawns them). And an `Arc` gives only shared access, so `write(&mut self, …)` cannot be called through it.

In safe Rust, the data race on the PL011 is a compile error. If you predicted garbled output, that is what the same design in C could give you. So the concurrency bugs left to us are the ones the compiler cannot see: deadlocks, where two threads take locks in opposite orders, and logic races, where every access is locked but the steps interleave wrongly. The bus is built so that few remain:

:::code anchor=bus_dispatch file=crates/vmm/src/bus.rs

The table is fixed before any vCPU runs, so finding a device takes no lock. Each device has its own lock, held for one access. The lock order the whole VMM follows:

| Rule | Why |
|---|---|
| device lock, then the buffers behind the device (serial input, the disk file), then the virtio interrupt-status lock (chapter 15); never in reverse | one global order means no cycle, so no deadlock |
| a PSCI call holds one CPU's lock at a time, never with a device lock | power calls and MMIO never wait for each other |
| a vCPU's registers have no lock at all: only its own thread touches them | others post, then kick |
| no lock is held across `hv_vcpu_run`, or across a wait with no time limit (a condition-variable wait releases its mutex while it sleeps, so parking obeys this rule) | a kick cannot reach a thread blocked on a mutex |

The guest's own ordering now runs through these locks too. Follow one disk read that CPU 1 submits and CPU 3 completes:

1. Guest CPU 1 writes the descriptor and `avail.idx`, executes a barrier, then stores to `QueueNotify`. The barrier is the guest's own edge: its ring writes come before the doorbell.
2. That store exits on vCPU 1's host thread, which takes the device lock and hands the work to the disk worker under the worker's mutex. Releasing that mutex, and the worker taking it, is the edge from vCPU 1's thread to the worker.
3. The worker locks the device, reads `avail.idx` and the request, does the read, writes the used ring, then sets the interrupt status under its lock and raises the shared peripheral interrupt (SPI). That release is the edge out of the worker.
4. Guest CPU 3 takes the interrupt; its handler reads `InterruptStatus`, an MMIO read that exits on vCPU 3's thread and takes the same locks, which is the matching acquire. Then it reads `used.idx` and finds the completion.

Drop any link and the chain breaks: without the guest's barrier the worker may see the doorbell before the new `avail.idx` and find nothing to do; if the worker raised the interrupt before writing the used ring, CPU 3 could read the old `used.idx` and miss the completion. Journal question 3 asks you to place the critical section.

## Breaking it on purpose

Three breaks, each predicted first. Commit before each one and undo it with `git -C learner checkout -- crates` before the next, as in the Predict edit.

**Deliberate breakage 1: two vCPUs with one MPIDR.** In `learner/crates/vmm/src/vcpu/mod.rs`, make `mpidr_for` return `crate::arch::regs::mpidr(0)` for every index. The vCPU register and the power table both use it; the device tree does not. Boot Linux as in the last section, with `--cpus 2`. Predict `nproc`:

:::term source=captures/20-dup-mpidr-run.txt

:::term source=captures/20-dup-mpidr-log.txt

What you saw: one CPU. Linux called `CPU_ON` for the `reg` in the device tree, 1; our table had two rows for 0 and none for 1, so the answer was `INVALID_PARAMETERS`, which Linux reports as -22, its "invalid argument". vCPU 1's thread existed, parked, and never ran: zero exits. The misconception: "both CPUs run and share an ID"; PSCI and the kernel name a CPU by this number, so two CPUs with one name cannot both be addressed. The tool that finds it: the three lookups side by side, and the stats line of a vCPU that never ran.

**Deliberate breakage 2: only the register disagrees.** Undo that, and instead change one line in `Vcpu::create`: `let mpidr = mpidr_for(0);`. The table and the device tree are right; the CPU's own register lies, and so, most likely, does the redistributor HVF gave vCPU 1, which reports the affinity in that vCPU's MPIDR. Predict: one CPU again, or something else?

:::term source=captures/20-mpidr-mismatch-log.txt

:::term source=captures/20-mpidr-mismatch-trace.txt

What you saw: `CPU_ON` succeeded, the log stops at "Bringing up secondary CPUs", and a second later vCPU 1, not vCPU 0, asked for a reset, with nothing printed. vCPU 1 started with CPU 0's number in its own register, while Linux's table and our power table said 1. The misconception: "a wrong ID gives a clean error"; the error-free path was the worse one. The tool: a trace with `psci` records, which shows who made each call.

Exactly what broke first we have not checked; the CPU with the wrong name is the one that gave up. A hypothesis, if you want to dig: the third lookup is the redistributor walk, where the secondary searches for the frame matching its MPIDR, and CPU 0 already owns that frame. Add `sysreg` to the `--trace` filter and compare vCPU 1's last exits.

**Deliberate breakage 3: two locks in opposite orders.** Add a counter of MMIO accesses to the bus, a `Mutex<u64>`. In `read`, lock the counter, then the device; in `write`, lock the device, then the counter. Run the stress test, four workers reading the disk and printing for 30 seconds, with a `--timeout` of 20 seconds, shorter than the stress on purpose: the question is whether the timeout can end it. Predict: when does it end on its own? Then, from inside `learner/`:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --cpus 4 --mem 512M --disk disk.img,ro --stats --serial file:boot.txt --on-reset exit --timeout 20 --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test=smp-stress"
```

If it does not end by itself, open a second terminal and run `sample macvmm 1`. To end a stuck VMM, send it SIGINT twice from that terminal, with `pkill -INT -x macvmm`: the first asks for a stop, as `--timeout` did; the second exits the process at once, whatever its threads are doing.

:::term source=captures/20-lock-order-hang.txt

:::term source=captures/20-lock-order-log.txt

It never ended: not at its own 20-second timeout, and the capture tool killed it at 45 seconds. The guest's last lines are mid-stress. `sample` (the `host-concurrency` primer) on the stuck process, 10 seconds after its timeout:

:::term source=captures/20-lock-order-sample.txt

Read the frame under each `Bus` function. vCPU 0's lock helper is instantiated for `MmioDevice`, so it waits for a device; vCPU 3's is instantiated for `y`, Rust's short name for `u64`, so it waits for the counter. `sample` shows only what a thread waits for; what it holds you read from the code: `read` takes the counter first, `write` the device first. vCPUs 1 and 2 are gone: the timeout's kick reached them inside `hv_vcpu_run`, and they left.

The two in the cycle are blocked on a mutex, where no kick reaches. The first SIGINT asks for a stop they cannot see; the second ends the process:

:::term source=captures/20-lock-order-quit.txt

What you saw: a hang that even `--timeout` could not end. The misconception: "Rust prevents concurrency bugs"; it prevented the data race, not the deadlock. The tool: `sample` and the lock-order table. Fix it by taking the counter after releasing the device lock, or better, by making it an `AtomicU64`, which needs no lock at all.

## Scaling: 64 vCPUs, and not 65

The cap is 64 vCPUs, and at most what `hv_vm_get_max_vcpu_count` allows on your Mac (`macvmm doctor` prints it). Asking for more than 64 fails before any virtual machine exists:

:::term source=captures/20-cpus-65.txt

And 64, with 2 GiB of RAM:

:::term source=captures/20-cpus-64-log.txt

The last CPU is `0x30f`: cluster 3, CPU 15, exactly what `mpidr(63)` computes, and its redistributor is the 64th frame.

## Your turn

In your workspace, `learner/`, build what this page specified:

1. `crates/vmm/src/vcpu/manager.rs`: one thread per vCPU, created in index order with a rendezvous, a start gate, and the redistributor check.
2. `crates/vmm/src/vcpu/wait.rs`: `wait_for`, which checks the stop flag and the mailbox under the mutex.
3. `crates/vmm/src/psci.rs`: the per-target state and mailbox, `cpu_on` with its five answers, `cpu_off`, `affinity_info` (level 0 only), `park` and `wake_all`.
4. One `cpu@N` node per vCPU in `crates/vmm/src/fdt/machine.rs`.
5. `--cpus N`, refused with exit code 2 above 64, and refused when the machine is built above what your Mac allows.

Copy `crates/vmm/tests/psci_smp.rs` into `learner/crates/vmm/tests/` and run `cargo test -q -p vmm --test psci_smp` from inside `learner/`. Then, from inside `learner/`:

1. `smp-race` on `--cpus 4` prints the reference's lines, with -4 or -5 where the reference printed either.
2. Linux on `--cpus 4` prints `smp: Brought up 1 node, 4 CPUs` and `macvmm-smp: nproc=4`.
3. The stress test ends with `macvmm-smp: stress done`, and the log has no `rcu: INFO` and no `soft lockup` lines. Linux prints a read-copy-update (RCU) [stall warning](/build-your-own/vmm/glossary/#rcu-stall-warning-soft-lockup) (`rcu: INFO`) or a soft lockup warning when one CPU has made no progress for about 20 seconds; in a virtual machine, that usually means the VMM starved or blocked that vCPU's thread. Give it a `--timeout` well above the 30-second stress, not breakage 3's 20:

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --cpus 4 --mem 512M --disk disk.img,ro --stats --serial file:stress.txt --on-reset exit --timeout 90 --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 macvmm.test=smp-stress"
```

:::term source=captures/20-stress-run.txt

:::term source=captures/20-stress-log.txt

The first number is the workers' passes; the second is the count of `rcu: INFO` and `soft lockup` lines, which must be 0.

> **Try it.** Run the `smp-hotplug` case on `--cpus 4`. Linux takes each secondary offline (`CPU_OFF`, then polling `AFFINITY_INFO` until it reads 1) and online again, three rounds. Look for one `killed (polled … ms)` line per CPU per round; a wrong `AFFINITY_INFO` answer would print "may not have shut down cleanly" instead.

:::term source=captures/20-hotplug.txt

Stuck? `scripts/learner hint 20` gives hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, the command is:

:::checkpoint

The contract tests are `psci_smp.rs`, the file you copied: eight threads race `CPU_ON` at one target and exactly one wins, `CPU_OFF` then `CPU_ON` works with `AFFINITY_INFO` correct at each step, `mpidr(17)` is `0x8000_0101`, and the 4-CPU device tree matches its golden file (compared only when `dtc` is installed). The runs on your Mac are this page's: `smp-race` on 4 CPUs (`race`), Linux on 4 CPUs (`linux-4cpu`), three hotplug rounds whose 9 kills must all be confirmed by `AFFINITY_INFO` (`hotplug-3x`), the 30-second stress on a read-only disk of random bytes, which must come back unchanged (`stress-4cpu`), Linux on 64 CPUs (`linux-64cpu`), and `--cpus 65` refused with exit code 2 (`refuse-65`). The Linux runs need the files from `scripts/fetch.sh linux`; the whole checkpoint takes one to three minutes, most of it the 30-second stress and the 64-CPU boot. Against an unmodified copy of the reference:

:::term source=captures/20-checkpoint.txt

What now works:

- every vCPU has its own thread, created in index order at startup, with one MPIDR that the device tree, the power table and the redistributor agree on;
- the guest starts and stops CPUs through PSCI, and racing calls get exactly one winner;
- any thread can stop a running vCPU with a kick, and a stopped virtual machine ends, unless a lock-order bug has blocked a thread where no kick reaches;
- Linux runs on up to 64 CPUs, under a 30-second stress, with no stall warnings.

The next chapter starts from this state (the reference at the end of chapter 20).

### What's next

So far our guests were kernels we loaded ourselves. Chapter 21 runs real firmware, U-Boot, which expects flash memory at address 0 and touches devices in ways no kernel of ours did, including the instructions our MMIO decoder has so far refused.

### Open question

The `smp-race` line `cpu 3 back on ctx=0x33` shows that the caller's context arrived on CPU 3 unchanged. Why does `CPU_ON` take a context ID at all, and where does it land?

## Spec hunt

- Arm DEN 0022, the PSCI specification, section 5.1.4 on `CPU_ON`: which return codes may it give, and what does it say the new CPU finds in its first general-purpose register?
- Arm Architecture Reference Manual (DDI 0487), register page **MPIDR_EL1, Multiprocessor Affinity Register**: what do bits 24 (MT) and 30 (U) mean, and why does our VMM leave both at 0?
- The software development kit (SDK) header `hv_vcpu.h`: compare the comment on `hv_vcpus_exit` with the one on `hv_vcpu_run` above it. Which one says "Must be called by the owning thread", and what does the other promise for a vCPU that is not running? Then find the exit reason it produces in `hv_vcpu_types.h`.
