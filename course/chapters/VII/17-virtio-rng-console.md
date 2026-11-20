---
title: virtio-rng (worked) and virtio-console (faded)
part: VII
chapter: VII.3
id: 17
runs: mac
minutes: 270
prereqs: [16]
start_tag: ch-16
labs: []
command: scripts/checkpoint.sh 17
expect: CHECKPOINT 17 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** the device worker thread; the doorbell's happens-before chain; notify coalescing and the per-batch budget; virtio-rng and the exact used length; virtio-console and its two queues; exits per kilobyte.
- **Core, from earlier:** one exit's cost (chapter 03); the PL011 and its sinks (chapter 09); level-triggered interrupts and the GIC, the Generic Interrupt Controller (chapters 11 and 12); `--kernel` for ELF guests (chapter 13); the test initramfs (chapter 14); the virtio-mmio transport and the `VirtioDevice` trait (chapter 15); split virtqueues and copy-then-validate (chapter 16); chapter 04's parked question.
- **Primers (read first):** `memory-ordering` (acquire and release, happens-before, and its section on the doorbell as a synchronisation point).
- **Primers (review):** `host-concurrency` (a mutex, a condition variable, joining a thread); `tty-termios` (raw mode).
- **Pointers:** `getentropy` (an Aside); Linux's `hw_random` and `hvc` layers (linked); KVM's `ioeventfd` (a Production note).
- **Forward definitions:** virtio-blk (chapter 18); a network card's receive thread (chapter 19); a second vCPU (chapter 20); the macOS sandbox (chapter 25). Each is defined at first use.
:::

Here is one line to type at your guest's shell once your virtual machine monitor (VMM) has a random-number device: `dd if=/dev/hwrng bs=1M count=1 | wc -c`. It asks the device for one mebibyte (1 MiB, 1,048,576 bytes) of random bytes. When the guest's driver has new requests, it tells your VMM by ringing a doorbell, and a doorbell is one VM exit. So how many doorbells does a mebibyte cost?

:::predict In the guest, `dd if=/dev/hwrng bs=1M count=1 | wc -c` reads 1 MiB from your virtio-rng. Does the number of `QueueNotify` doorbells grow with the bytes read or with the buffers the driver posts? Write a number.
Write your guess and one sentence of reasoning under `## Predict` in your journal. The section "Bytes or buffers?" runs it and counts.
:::

Chapters 15 and 16 built the transport and the rings for row 8 of chapter 00's problem ledger, bulk I/O at reasonable cost, with no real device behind them. This chapter puts the first two devices there, moves their work onto a thread of their own, and measures what row 8 is about: exits per kilobyte.

:::objectives
- Implement virtio-rng (device ID 4) on a device worker thread woken through a mutex and a condition variable: fill only writable descriptors from `getentropy`, at most 64 KiB per request, report the exact used length, and raise the interrupt.
- Draw the doorbell's happens-before chain from the guest's barrier to the worker's acquire load of `avail.idx`, and predict what breaks when one link is removed.
- Give the `VirtioDevice` trait real bodies for virtio-rng, and implement virtio-console (device ID 3) against it from a specification and tests.
- Measure exits per 4 KiB for the PL011 and for virtio-console with `--stats`, and explain the ratio with chapter 03's cost per exit.
- Explain with an example why chapter 04's parked question is now real with one vCPU.
:::

**Before you start.** From the repository root, run `scripts/learner start 17`, which copies this chapter's journal to `learner/journal/17.md`. You need the kernel and test initramfs from chapter 14 in `.cache/macvmm/`.

## Where should the work happen?

In chapter 15 a `QueueNotify` write processed the queue right there, on the thread of the virtual CPU (vCPU) that wrote it. While it handles the exit, the guest CPU is frozen. For 64 KiB of random bytes, or a disk read in chapter 18, it is time the guest cannot run.

Real hardware does not work like that: a disk controller's own engine reads the rings while the CPU goes back to work. We copy the shape: each virtio device gets a host [thread](/build-your-own/vmm/glossary/#thread) of its own, and the vCPU only rings its bell. That thread is the [**device worker thread**](/build-your-own/vmm/glossary/#device-worker-thread), the worker for short.

The bell is a mutex and a condition variable, exactly the pair the `host-concurrency` primer built in `park.rs`. The vCPU side sets one bit per queue and wakes the worker. It never touches the device itself, so it never waits behind a long batch:

:::code anchor=worker_notify file=crates/vmm/src/virtio/worker.rs

The transport calls it from its `QueueNotify` handler, after the checks chapter 15 wrote (the device is live and the queue is ready). A slot without a worker still processes inline, which is what host tests use:

:::code anchor=virtio_notify file=crates/vmm/src/virtio/mmio.rs

## The worker's loop

The worker sleeps on the condition variable inside the primer's predicate loop: it checks the state (any pending bit?) before every wait, so a bell rung before it fell asleep is not lost. When it wakes it takes *all* pending bits at once and marks itself `busy`:

:::code anchor=worker_wait file=crates/vmm/src/virtio/worker.rs

Taking every bit turns ten doorbells that arrived while the worker was busy into one pass. That is [**notify coalescing**](/build-your-own/vmm/glossary/#notify-coalescing), and it is safe because a doorbell carries no data. It only says "look at the ring", and one look sees every buffer published before it. The virtio specification says as much: a driver may batch its notifications, so a device must not count on one per buffer.

Ignore `paused`, `pause()` and the `idle` wake-up in `finish_pass`: they let a test hold the worker at a batch boundary.

Then, for each pending queue, the worker locks the device, processes at most one batch, and unlocks:

:::code anchor=worker_loop file=crates/vmm/src/virtio/worker.rs

The short labels in these comments (letters, a dash and a number) are the reference's own test and threat-model labels; ignore them. Three details carry the design.

- **The budget** is the queue size: one call handles at most that many chains, so a guest that refills its ring as fast as we drain it cannot hold the device mutex forever. `MoreWork` puts the queue's bit back as pending, so the queue goes round again, through the stop check, and `stop` can still win.
- **An error is the guest's fault.** The device goes to [`DEVICE_NEEDS_RESET`](/build-your-own/vmm/glossary/#device-needs-reset) while the lock is still held, and the worker keeps running for the next driver. A device already in that state drops further doorbells until the driver resets it.
- **`NotActivated` is ignored**, because a driver that wrote `Status = 0` while a bell was pending did nothing wrong.

Stopping is the last piece. `stop` sets a flag, wakes the worker, and joins it; the worker finishes its current batch and leaves. The machine stops every worker before it frees guest RAM. The companion lines belong to chapter 19, where a network card's receive thread (its own host thread for incoming packets) has to stop with its worker:

:::code anchor=worker_stop file=crates/vmm/src/virtio/worker.rs

## The doorbell's happens-before chain

The worker is a second thread reading memory the guest wrote. By the `memory-ordering` primer's rule, it may trust what it reads only if a chain of happens-before edges leads from the guest's writes to its reads:

```text
 guest vCPU (EL1)          our vCPU thread                our worker thread
 ----------------          ---------------                -----------------
 write descriptors,
 avail ring, avail.idx
 dmb (barrier)
 str QueueNotify --trap--> handle the MMIO exit
                           lock state, set bit,
                           notify_one, unlock  ------->   wake, lock state,
                                                          take bits, unlock
                                                          lock device
                                                          acquire load avail.idx
                                                          walk, copy, fill
 take the interrupt <---- line raised <---------------   release store used.idx,
 read InterruptStatus                                     fence, should_interrupt?
```

*Every arrow is an edge: the guest's barrier, the trap itself, a mutex released by one thread and acquired by the next, then chapter 16's acquire and release pair on the ring indices.*

The guest runs at exception level 1 (EL1, the kernel's level); its doorbell is a store to a memory-mapped I/O (MMIO) address. What goes wrong without each link:

- **The barrier.** Without the `dmb`, the doorbell may become visible before the ring writes, and the worker on another core reads an unfinished ring.
- **The trap.** The guest's stores and our handler run on the same core, one after the other, as if one thread wrote the ring and then rang. This link cannot be removed.
- **The mutex.** Unlock is a release and lock an acquire, so the waking worker sees an `avail.idx` at least as new as the bell's. Replace it with a polled `Relaxed` flag and the primer's doorbell section shows a wake-up lost.
- **The acquire load.** The guest keeps publishing while the worker walks; the acquire load of `avail.idx` makes those later descriptors safe to read.

At the bottom, `should_interrupt` is chapter 16's check: has the driver set its no-interrupt flag for this batch?

**Deliberate breakage 1: forget to ring the bell.** In `notify`, keep `s.pending |= bit` but delete `self.shared.wake.notify_one()`. Predict: does the guest still get its random bytes, perhaps late?

:::term source=captures/17-break-no-bell.txt

Never: the driver waits for this request before ringing again, so no second bell comes to rescue it. The bit was set and nobody looked until `--timeout` ended the run.

`wfi 19.818 s` is time the vCPU spent asleep in WFI (wait for interrupt, chapter 11), not exits: the in-kernel GIC handles WFI without an exit to us (chapter 12), hence `wfx 0`. Our worker slept too, and host CPU stayed at 1%.

What you saw: a hang where everyone is idle. The misconception: "the state is set, so someone will notice"; a bell nobody rings is a lost wake-up. The tool: `--stats` (all sleep, no work) and the contract test that sends ten notifies and waits for every buffer. Put the line back.

## Chapter 04's question comes due

Chapter 04 asked when the guest could change memory *while* your VMM looks at it. Now: once `notify` returns, the guest runs while the worker walks its ring. A driver that rewrites a descriptor right after ringing races our worker, with one vCPU. This is why chapter 16 copies each descriptor once and validates only the copy. Chapter 20's second vCPU can do it from another core at full speed.

## virtio-rng, the smallest real device

A freshly booted guest has almost no randomness of its own, yet it needs unpredictable numbers from its first second, for every key it will generate. The device tree's `rng-seed` (chapter 10) hands Linux one seed at boot; a random-number device hands it a *source*, which Linux exposes as `/dev/hwrng` through its [`hw_random` layer](https://docs.kernel.org/admin-guide/hw_random.html).

The **virtio-rng** device is the smallest real virtio device: device ID 4, one queue (`requestq`), no feature bits of its own and no configuration space. The driver posts device-writable buffers; the device fills them with random bytes and returns each [descriptor chain](/build-your-own/vmm/glossary/#descriptor-chain) with the number of bytes it wrote. The specification allows fewer bytes than the buffer holds, but at least one.

> **Aside.** The bytes come from `getentropy`, the Mac's system call for the kernel's cryptographically secure pseudo-random number generator (CSPRNG). It needs no file descriptor, so it keeps working inside chapter 25's sandbox, and it refuses more than 256 bytes per call. See `man 2 getentropy`, or the [OpenBSD page](https://man.openbsd.org/getentropy.2) where it began.

So the VMM's one entropy source fills large buffers in 256-byte calls:

:::code anchor=entropy_fill file=crates/vmm/src/backend/entropy.rs

In chapter 15 you gave `read_config`, `write_config` and `process_queue` trivial bodies. Rng is the first device that needs real ones: ID 4, one queue of at most 64, only `VERSION_1`, a zero-length config space the transport refuses, and `activate` keeping the memory, queue and interrupt that `reset` drops:

:::code anchor=rng_device_impl file=crates/vmm/src/virtio/rng.rs

Now the device's whole job, one batch per call, which the worker invokes with the device locked:

:::code anchor=rng_process_queue file=crates/vmm/src/virtio/rng.rs

The budget is clamped to the driver's queue size. `pop` and `into_validated` are chapter 16's, with the writable total capped at 64 KiB.

A larger request is refused as `TooLarge`: `DEVICE_NEEDS_RESET`. Filling 64 KiB and reporting 65,536 would also be legal, and Linux never posts more than 64 bytes. The reference refuses so that every device has one limit, enforced in the shared validator before any byte moves.

Each request gets a fresh, zeroed buffer, so a short fill never leaks an earlier request's bytes. The used ring gets what chapter 16's `write_writable` returns: the count of bytes actually written into the writable descriptors, never the buffer's size.

After the batch, unless the driver set its no-interrupt flag, `signal_used` sets bit 0 of `InterruptStatus` and raises the slot's level-triggered line, which stays up until the guest writes `InterruptACK`.

> **Security.** The used length is the device's reply, and the driver acts on it. A driver posting readable and writable descriptors together would take its own readable bytes as random if we reported the whole chain. Linux's driver trusts `len` as the valid bytes in its 64-byte buffer, so a larger `len` would make it copy past that buffer (see the spec hunt).

**Deliberate breakage 2: report the buffer's length.** In `process_queue`, replace `written` in the `add_used` call with `u32::try_from(req.readable_len + req.writable_len).unwrap()`, the chain's whole length. Predict: does Linux notice? Run the contract tests first:

:::term source=captures/17-break-used-len-tests.txt

Two tests fail: a chain of 64 readable and 32 writable bytes came back with 96 instead of 32, and a readable-only chain claimed 16 random bytes that were the guest's own. Now Linux:

:::term source=captures/17-break-used-len-linux.txt

`read 1048576 bytes ok`: Linux posts writable-only buffers, so the lie never shows. What you saw: a broken device a real guest accepts. The misconception: "if the guest works, the device is right". The tool: contract tests with hostile shapes. Put `written` back.

## Wiring it in: `--rng` and a slot

The machine puts each device in a virtio slot with its transport, its interrupt line and its worker, and makes the worker the transport's doorbell target. The `Blk` and `Net` arms and the `nic` lines belong to chapters 18 and 19; skip them:

:::code anchor=virtio_slot_device file=crates/vmm/src/machine/virt.rs

`--rng` asks for one in the slot after any disks (chapter 18 adds them), which with no disk is slot 0 at `0x0a00_0000`, and the device tree lists it. Chapter 15 ran the bare-metal probe against 32 empty slots; the same ELF build, loaded with `--kernel` as before, now finds a device:

:::term source=captures/17-probe-rng.txt

Slot 0 answers device 4, the handshake reaches status `0xf`, and 32 random bytes came back through the worker. The warnings are the probe's deliberate reads of the wrong width (1, 2 and 8 bytes), refused as in chapter 15. Then Linux's driver, through the test initramfs's `rng` case:

:::term source=captures/17-linux-rng.txt

`hw_random=virtio_rng.0` means Linux bound its driver to our device. The 50,967 exits are the cost we count next.

## Bytes or buffers?

Time for the opening question. Boot with every MMIO exit traced and no `macvmm.test=` word, which gives chapter 14's shell case:

```sh
cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --mem 512M --rng --on-reset exit --timeout 30 --stats --trace exits:rng.jsonl:mmio --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 quiet"
```

At the `/ #` prompt, type this line; the modprobes are needed because the test initramfs loads drivers only for its named cases:

```sh
modprobe virtio_mmio; modprobe virtio-rng; sleep 1; dd if=/dev/hwrng bs=1M count=1 | wc -c; poweroff -f
```

:::term source=captures/17-hwrng-dd.txt

One mebibyte arrived, at 2.6 MB/s, and the run cost 51,684 exits. Count the doorbells, writes to `0x0a00_0050` (slot 0's base plus `QueueNotify`'s offset):

:::term source=captures/17-hwrng-notifies.txt

16,387. To see which of them are `dd`'s, we repeated the run with `count=0`, which loads the driver and registers the device but reads nothing:

:::term source=captures/17-hwrng-notifies-base.txt

Two doorbells came from the kernel's own reads, with no `dd` at all; that baseline run cost 2,498 exits. So `dd` rang about 16,385 times (the count varies by one or two from run to run), and 1,048,576 / 16,384 = 64: Linux's driver posts one 64-byte buffer at a time. Here are three consecutive slot-0 records from the middle of the run:

:::term source=captures/17-hwrng-trace.txt

The doorbell (`0xa000050`); 16 microseconds later the guest reads `InterruptStatus` (`0xa000060`) and acknowledges it (`0xa000064`) in its interrupt handler. Three exits per request, whatever the request holds: 16,385 × 3 = 49,155, and with the 2,498 of the baseline that makes 51,653, within a few dozen of the 51,684 we saw.

The rule: doorbells = bytes ÷ buffer size, and the driver picks the buffer size. Linux's virtio-rng always posts 64 bytes, so here the two lines run parallel, but the answer is buffers. The console runs below prove it: one doorbell per 2,048 bytes in one run, per 7 bytes in another.

:::stopping-point Good place to stop. The second half is the console you write yourself, then the measurement.

## virtio-console: your turn to build it

A **virtio-console** moves a whole buffer per doorbell, where the PL011 moved one byte per trapped access. Linux shows it as `/dev/hvc0`, through its [`hvc` console layer](https://github.com/torvalds/linux/blob/master/drivers/tty/hvc/hvc_console.c). That `hvc` stands for "hypervisor virtual console" and has nothing to do with chapter 02's `hvc` instruction.

Rng's guest starts every exchange: it posts an empty writable buffer and the device answers into it. Keyboard input starts on the host, at any moment, and the device cannot allocate guest memory; it can only write into buffers handed over beforehand. So input needs a queue of empty writable buffers posted in advance, which sit until bytes arrive. Output buffers are readable and posted only when there is text, so they get a second queue. A universal asynchronous receiver-transmitter (UART) such as the PL011 needs no queue: each byte is its own register access.

Your device, from virtio 1.2's console section:

| Item | Value | What it means for you |
|---|---|---|
| device ID | 3 | `device_id()` |
| queue 0, `receiveq` | host to guest, device-writable buffers | the guest posts empty buffers in advance; you fill them when the host has input |
| queue 1, `transmitq` | guest to host, device-readable buffers | you read them and hand the bytes to a sink |
| features | none of its own | offer only `VERSION_1`, exactly one port |
| config space | 12 bytes, all zero, read-only | ignore writes |

You offer none of the three console features, `SIZE` (the terminal's rows and columns), `MULTIPORT` (several consoles) and `EMERG_WRITE` (panic output without queues), so their config fields stay zero.

The rules, each checked by the reference's `virtio_console` suite:

1. **Transmit.** Validate each chain with a 64 KiB cap, copy its readable bytes once into a fresh buffer, hand them to the sink (which runs chapter 09's [output filter](/build-your-own/vmm/glossary/#output-filter), a file included), and return the chain with `len = 0`. The sink's writer thread calls `write`, never the worker.
2. **Transmit never blocks.** If the sink's queue is full, wait at most 10 ms per batch (the `FullWait` below), then drop and count the bytes.
3. **Receive, nothing to say.** With no input queued, pop nothing: a popped chain must go back, and an empty one reaches the guest as a zero-byte read, which a shell treats as end of file and quits. A console with no stdin bound never receives.
4. **Receive, input waiting.** Fill `min(writable length, queued bytes)` and report exactly that. Remove input only after the guest write succeeded, so no keystroke is lost.
5. **Receive, nothing writable** in a chain is a driver error: `DEVICE_NEEDS_RESET`.
6. **Budget and reset.** At most `budget` chains per call, clamped to the queue size, then `MoreWork`. Reset drops the queues but keeps queued input.
7. **Who rings for input?** The guest rings `QueueNotify 0` when it posts buffers; the host rings the same bell when stdin has bytes.

The last rule is new, a doorbell rung by the host, through a hook:

:::code anchor=console_input_hook file=crates/vmm/src/machine/virt.rs

Your checklist:

1. Write `learner/crates/vmm/src/virtio/console.rs`, implementing `VirtioDevice` with the queue table above.
2. Add `--console stdio|file:F` in `learner/crates/macvmm/src/cli.rs`, next to `--serial`, refusing two stdio sinks with exit code 2: only one can receive stdin.
3. The slot wiring is given: copy the `Console` arm, `connect_console_input` and the small `console_device` helper from the reference's `crates/vmm/src/machine/virt.rs`.
4. From inside `learner/`, test with `cargo test -q -p vmm --test virtio_console`.
5. Stuck? `scripts/learner hint 17` climbs from a nudge to the reference file.

The refusal from step 2, on the reference:

:::term source=captures/17-both-stdio.txt

Once your transmit side passes, compare it with the reference's:

:::code anchor=console_tx file=crates/vmm/src/virtio/console.rs

`write_guest_within` gives up when the shared `FullWait` budget runs out. The test initramfs's `console-tx` case runs `yes macvmm | head -c 65536` into `/dev/hvc0` in raw mode:

:::term source=captures/17-linux-console-tx.txt

`console_written=65536` and nothing dropped. The file must be byte-exact against the same bytes made on the host:

:::term source=captures/17-console-sha.txt

## Exits per kilobyte: PL011 against `hvc0`

Now the comparison this Part exists for. Use your own chapter 03 cost per exit; ours was 1.43 microseconds. Boot the shell four times:

```sh
cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --mem 512M --console file:hvc0.out --on-reset exit --timeout 30 --stats --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 quiet"
```

and type one line: it makes 4,096 bytes without newlines, opens the device as file descriptor 3 in raw mode, and writes them with one `dd`:

```sh
modprobe virtio_mmio; sleep 1; yes macvmm | tr -d '\n' | head -c 4096 >/tmp/4k; exec 3<>/dev/ttyAMA0; stty raw -echo <&3; dd if=/tmp/4k bs=4096 count=1 2>/dev/null >&3; poweroff -f
```

Only two words change: `ttyAMA0` (the PL011) or `hvc0`, and `count=1` or `count=0`, a baseline without the write. Raw mode (`tty-termios`) stops Linux's tty layer, its terminal code, from adding carriage returns, so exactly 4,096 bytes go out. Read `total` in each `exits:` line:

:::term source=captures/17-pl011-4k-base.txt

:::term source=captures/17-pl011-4k.txt

:::term source=captures/17-hvc0-4k-base.txt

:::term source=captures/17-hvc0-4k.txt

The baselines differ a little, since opening each device costs its own register accesses, so subtract each device's own:

| 4,096 bytes to | Baseline exits | With the write | Extra exits | At 1.43 microseconds each |
|---|---|---|---|---|
| PL011 (`ttyAMA0`) | 2,868 | 11,062 | 8,194 | about 11.7 ms |
| virtio-console (`hvc0`) | 2,849 | 2,853 | 4 | about 6 microseconds |

The PL011 cost two exits per byte. We repeated its two runs with `--trace` and counted:

:::term source=captures/17-pl011-4k-trace.txt

Exactly 4,096 more reads of its flag register (is there room?) and 4,096 more writes of its data register. The console cost four:

:::term source=captures/17-hvc0-4k-trace.txt

Two doorbells, because Linux's tty layer hands the driver at most 2,048 bytes per call, then one interrupt read and acknowledged. We observed no interrupt read in the 110 microseconds between the doorbells; the level-triggered line stays up until acknowledged, so one interrupt collected both used buffers.

The ratio is about 2,000: one `QueueNotify` bought 2,048 bytes, moved by memory copies that cost no exit. The console's code does *more* work per call (a chain walk, validation, a copy), yet wins because it needs far fewer exits.

> **Try it.** The `console-tx` run above cost 27,876 exits for 64 KiB, far more than four per 4 KiB. Repeat it with `--trace exits:tx.jsonl:mmio` and count the transmit doorbells (`QueueNotify` written with 1). Before you look: how many bytes per buffer?

:::term source=captures/17-console-tx-notifies.txt

9,363 doorbells: seven bytes each. `yes` put one line at a time into the pipe, `head` passed each read on as its own `write`, and each `write` became one buffer. Chapter 14 sent the same 64 KiB through the PL011 for 178,073 extra exits; `hvc0` took about 25,000 extra (27,876, less about 2,850 of boot), still 7 times fewer, and 2,000 times fewer with big buffers.

> **Production note.** Our doorbell costs a full exit and a trip through the vCPU thread. The Kernel-based Virtual Machine (KVM), Linux's built-in hypervisor, has `ioeventfd`, which signals the device thread straight from the host kernel, and `VIRTIO_F_EVENT_IDX` (chapter 16) skips unneeded notifications. The chain of edges is the same.

## A worker under attack

`hostile-vq` is a bare-metal test guest in `guests/`, built by `scripts/build-guests.sh` (chapter 03), that plays a malicious driver. For each attack it sets up a ring, plants one malformed chain, rings, checks for `DEVICE_NEEDS_RESET` and writes `Status = 0`; a last, well-formed request must still be served. From the repository root:

```sh
cargo run -q -p macvmm -- run --mem 64M --rng --kernel target/guests/aarch64-unknown-none/release/hostile-vq --timeout 30
```

:::term source=captures/17-hostile-vq-rng.txt

Each attack ended in `DEVICE_NEEDS_RESET` with a named reason, such as a loop caught by the hop budget, a zero-length buffer, a buffer past the end of RAM, or an indirect table the driver never negotiated (`IndirectNotNegotiated`). The device recovered each time and the VMM exited 0.

## Your turn

Before the checkpoint, check from inside `learner/`, with `G=../target/guests/aarch64-unknown-none/release` as in chapter 09:

1. `cargo run -q -p macvmm -- run --mem 64M --rng --kernel $G/virtio-probe --timeout 10` prints the probe's `rng 32 bytes nonzero` line.
2. The commands below print `read 1048576 bytes ok`, then two equal hashes.
3. Your journal has the Predict entry, written before the `dd` run, and question 1, from your own four `--stats` runs.

```sh
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --rng --on-reset exit --timeout 60 --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 quiet macvmm.test=rng"
cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --mem 512M --console file:hvc0.out --on-reset exit --timeout 60 --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 quiet macvmm.test=console-tx"
shasum -a 256 hvc0.out; yes macvmm | head -c 65536 | shasum -a 256
```

To run only the contract tests: `cargo test -q -p vmm --test virtio_rng --test virtio_worker --test worker_budget --test virtio_console`.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests, the four runs you have seen (the probe, `rng`, `console-tx` with its hash, the two stdio sinks refused) and the journal check:

:::term source=captures/17-checkpoint.txt

What now works:

- each virtio device has a worker thread that coalesces doorbells, works in bounded batches and stops cleanly;
- virtio-rng serves Linux's `/dev/hwrng` from the Mac's CSPRNG and reports exactly what it wrote;
- virtio-console carries `hvc0` both ways at four exits per 4 KiB instead of 8,194.

The next chapter starts from this state (the reference at the end of chapter 17).

### What's next

Random bytes and console text are forgiving. Chapter 18 builds virtio-blk, a disk with guest-chosen sector numbers, a file backend that can be slow, and a `FLUSH` that must survive a power cut. Today's worker keeps a slow disk from freezing the guest's CPU.

### Open question

The `hostile-vq` run shows what our device does with a zero-length writable buffer. The specification says the device places "one or more" random bytes into the buffer, and that a driver must not trust bytes beyond the used length. The guest posts a zero-length writable buffer to virtio-rng: what should the device do, and what should it report?

## Spec hunt

- Virtio 1.2 (OASIS, `virtio-v1.2-cs01`), section 5.4.6, "Device Operation" of the Entropy Device, and its requirements: may the device return fewer bytes than the buffer holds, and is there any bound on how few?
- Virtio 1.2, section 2.7.8, "The Virtqueue Used Ring", and its requirements on `len`: what must a device write before it updates `used.idx`, and what may a driver assume about bytes beyond `len`?
- Linux `drivers/char/hw_random/virtio-rng.c`: how large is the buffer the driver posts, how does it use the `len` the device returns, and does the buffer size match the doorbells you counted for one mebibyte?
