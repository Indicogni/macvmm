---
title: Split virtqueues: shared memory with an adversary
part: VII
chapter: VII.2
id: 16
runs: mac+browser
minutes: 390
prereqs: [15]
start_tag: ch-15
labs: [virtqueue-visualizer, litmus]
command: scripts/checkpoint.sh 16
expect: CHECKPOINT 16 PASS
---

:::retrieval from=15,04,13

:::concepts
- **Core, taught here:** the split virtqueue: descriptor table, available ring and used ring, with their sizes and alignment; free-running `u16` indices and wrapping subtraction; descriptor chains, indirect descriptors and the readable-before-writable rule; the hop budget; TOCTOU (time of check to time of use) and copy-then-validate; `GuestMemoryOrdered`, with its two ordered accesses and one full fence; `DEVICE_NEEDS_RESET` on any queue error; the exact `used.len`.
- **Core, from earlier:** copy-only guest memory, `read_obj`, `checked_add` and `check_range` (chapter 04); the virtio-mmio transport, its queue registers, `QueueNotify`, `DRIVER_OK`, `DEVICE_NEEDS_RESET`, the `VirtioDevice` trait and the inline doorbell path with its budget of N requests per call (chapter 15); the guest as an adversary and bounding work (chapters 03 and 04); property-based testing (chapter 13).
- **Primers (read first):** `memory-ordering` (store buffers, acquire and release as a pair, why a store followed by a load needs a full fence, the lost-wakeup race, and the table of pairs between macvmm and the Linux driver).
- **Primers (review):** `host-concurrency` (threads, atomics and `Ordering`).
- **Pointers:** packed rings and `VIRTIO_F_EVENT_IDX` (an Aside); rust-vmm's `virtio-queue` crate (a Production note); the virtio 1.2 specification, Linux's `virtio_ring.c` and a Xen double-fetch advisory (linked sentences).
- **Forward definitions:** the device worker thread (chapter 17); the virtio-blk request layout (chapter 18); a second guest vCPU writing while we read (chapter 20). Each is defined at first use.
:::

Here are sixteen bytes a guest wrote into its own RAM: a [descriptor](/build-your-own/vmm/glossary/#descriptor), the record a virtio driver uses to describe one buffer. Its address is `0x4000_8000`, inside RAM. Its length is 8, small and non-zero. Its flags say "another descriptor follows", and its `next` field says which one: 0. It is descriptor 0. Every field passes every check you could write for a single field. Now your virtual machine monitor (VMM) walks the chain to find the request's buffers.

:::predict Walk this descriptor with your chain walker, with its loop guard (the hop budget, below) commented out. Panic, error, or hang?
Write your answer and one sentence of reasoning under `## Predict` in your journal. The section on the hop budget shows our run on the reference, and Your turn has you repeat it on your own walker.
:::

This chapter continues row 8 of the problem ledger, bulk I/O at reasonable cost. Chapter 15 built the doorbell and the registers that tell us where the rings are; here we build the rings, and make them safe against a guest that writes them while we read. Sitting A (about 3.5 hours) is the layout and the chain walk; sitting B (about 3 hours) is ordering and the time-of-check bug, with two of the chapter's three deliberate breaks.

:::objectives
- (Sitting A) Lay out a split virtqueue (descriptor table, available ring, used ring) with the alignments and sizes of the virtio 1.2 split-ring table, compute each size with `checked_mul` and `checked_add`, and refuse a ring that is unaligned or not inside one RAM region.
- (Sitting A) Explain why there are two rings plus a table (completions can be out of order; each location has one writer) and why the `u16` indices are free-running; compute pending entries across the wrap at 65535.
- (Sitting A) Implement a descriptor-chain walker that copies each descriptor exactly once with `read_obj`, validates only the copy, enforces a hop budget of N, `next < N`, `addr + len` in RAM, readable before writable, indirect-table rules and a total per device, and puts the device into `DEVICE_NEEDS_RESET` on any error, never panicking.
- (Sitting A) Bound the work in both directions: at most N hops per chain, and at most N chains per call into the device.
- (Sitting B) Use exactly two ordered accesses, an acquire load of `avail.idx` and a release store of `used.idx`, plus a `SeqCst` fence before reading `avail.flags`, and name what each one pairs with in the Linux driver.
- (Sitting B) Diagnose a double fetch with a test that rewrites a descriptor after its first read, and predict which tests catch it and which cannot.
:::

**Before you start.** Run `scripts/learner start 16` from the repository root; it copies this chapter's journal to `learner/journal/16.md`. You are in the spec stage: the lesson shows the reference, and you write the code from the rules, checking it against the tests. Everything here is pure Rust over guest memory, so every test runs on the host. Read the `memory-ordering` primer before sitting B.

The reference's comments tag each rule with an identifier from macvmm's threat model in `docs/security/` (VQ- for virtqueue rules, MEM- for guest-memory rules) or from its design notes in `docs/`; you can read the code without them. Section signs in the comments point into the virtio 1.2 specification.

## Three tables in guest RAM

Chapter 15 left us with three guest addresses (`QueueDesc`, `QueueDriver`, `QueueDevice`), a queue size N, and a doorbell. What must live at those addresses? Work it out from what the two sides need to say.

The driver has to describe buffers: where each one is, how long, and whether the device reads it or writes it. A disk read, for example, needs a small header the device reads ("read sector 2048") and a buffer the device fills. So there is a table of buffer descriptions, the [**descriptor table**](/build-your-own/vmm/glossary/#descriptor-table): N descriptors of 16 bytes each.

The driver also has to say "these requests are ready, in this order". That list is the **available ring**, and only the driver writes it. The device has to say "this request is done, and I wrote this many bytes". That is the **used ring**, and only the device writes it.

Why not one list? Because a disk may finish request 5 before request 2, so completions come back in their own order. And because a location with one writer needs no lock: the driver never writes the used ring and we never write the available ring. Together the three parts are a split [virtqueue](/build-your-own/vmm/glossary/#virtqueue).

```text
          guest RAM (both sides read all three)
 +-----------------------+   +--------------------------+   +-----------------------------+
 | descriptor table      |   | available ring           |   | used ring                   |
 | N x {addr, len,       |   | flags, idx,              |   | flags, idx,                 |
 |      flags, next}     |   | ring[N] = head indices   |   | ring[N] = {id, len}         |
 +-----------------------+   +--------------------------+   +-----------------------------+
   written by the driver       written by the driver          written by the device (us)
```

*Each part has exactly one writer. A head is the index of a request's first descriptor. The trust boundary runs through every byte: the guest can change all of it at any time.*

The virtio 1.2 specification (section 2.7, "Split Virtqueues") fixes each part's alignment and size:

| Part | Alignment | Size in bytes, queue size N |
|---|---|---|
| descriptor table | 16 | 16 × N |
| [available ring](/build-your-own/vmm/glossary/#available-ring) | 2 | 6 + 2 × N |
| [used ring](/build-your-own/vmm/glossary/#used-ring) | 4 | 6 + 8 × N |

The 6 bytes are a 16-bit `flags`, a 16-bit `idx`, and a trailing 16-bit field used only by a feature we do not offer. Chapter 15's transport calls `validate` at `DRIVER_OK`; here is its full story. Every size is computed with checked arithmetic, and every ring must lie inside one RAM region, so a ring can never overlap device registers or run off the end of RAM:

:::code anchor=queue_validate_rings file=crates/vmm/src/virtio/queue.rs

> **Aside.** Virtio 1.1 added a second layout, the **packed** virtqueue, which merges the three parts into one ring of descriptors to touch fewer cache lines. And the optional `VIRTIO_F_EVENT_IDX` feature replaces the "no interrupt, please" flag with an index, using the 16-bit fields at the end of each ring. Both are faster and both add parsing a hostile guest can aim at, so macvmm offers neither. The specification describes them in sections 2.8 and 2.7.7 ([virtio 1.2](https://docs.oasis-open.org/virtio/virtio/v1.2/virtio-v1.2.html)).

## Indices that never wrap at N

The driver puts the index of each request's first descriptor, its **head**, into `ring[avail.idx % N]` and then adds 1 to `avail.idx`. The device keeps its own counter, `next_avail`, of how many it has taken. The surprise is that neither counter is reduced modulo N: both count up forever and wrap only at 65536, because they are `u16`. Each is a [free-running index](/build-your-own/vmm/glossary/#free-running-index).

Why not keep `idx` in `0..N`? Then a full ring and an empty ring look the same: both sides at the same slot. With free-running counters the difference says it directly, 0 for empty, N for full, with no wasted slot and no extra flag.

Wrapping subtraction gives the right count across the wrap for any N. With N = 8, say `next_avail` is `0xFFFE` and the driver adds 4: `avail.idx` is now `0x0002`, and `0x0002 - 0xFFFE` in `u16` is 4. The slot, `idx % N`, also stays in step across the wrap, but only because N divides 65536: the slots are `0xFFFE % 8 = 6`, then 7, 0 and 1. With N = 6, slot `65535 % 6 = 3` would be followed by `0 % 6 = 0`, skipping two slots. That is why chapter 15 accepted only a power of two as the queue size, as section 2.7 of the specification requires.

Our side keeps its positions in `Wrapping<u16>`, Rust's integer type whose `+` and `-` wrap by design. The block ends with `at`, the helper behind every ring address: `base + head + elem × i` (the ring's address, the offset of its array, the entry size, the slot), computed with checked arithmetic and failing with `Overflow`:

:::code anchor=queue_struct file=crates/vmm/src/virtio/queue.rs

Taking the next request is `pop`. It loads `avail.idx` once (sitting B explains why that load is special), refuses a jump of more than N, which no honest driver can produce with N slots, copies the head index out of the ring once, and checks it against N:

:::code anchor=queue_pop_avail file=crates/vmm/src/virtio/queue.rs

The tests build rings with small helpers from `crates/vmm/tests/virtio_support/mod.rs`. `Ring` plays the driver, writing a table and rings into a `VecMemory`; `d(addr, len, flags, next)` makes a descriptor; `BUF` is a buffer address inside RAM. `pop_validated` is `pop` followed by `into_validated` (below) with a byte cap, and `K64` is 64 KiB. `set_positions` starts our counters somewhere other than 0. The wrap test is a positive case, the kind that is easy to forget: with N = 4, both counters start at 65533 and four requests cross the boundary.

:::code anchor=hostile_index_wrap file=crates/vmm/tests/virtqueue_hostile.rs

## Descriptors and chains

Each descriptor is 16 little-endian bytes, copied out in one piece. The flags are named from the device's side: `WRITE` means the device writes this buffer, otherwise the device only reads it.

:::code anchor=chain_descriptor file=crates/vmm/src/virtio/chain.rs

One request is a [descriptor chain](/build-your-own/vmm/glossary/#descriptor-chain): the head named in the available ring, then each `next` while `NEXT` is set. Every buffer the device reads comes before every buffer it writes, so a device can read the whole request before it writes any reply. A virtio-blk read, which chapter 18 builds, is a 16-byte header (readable), the data buffer (writable) and a one-byte status (writable).

The walker is an iterator that yields `Result<Descriptor, QueueError>`. Its state is the table being walked, the next index, and a budget:

:::code anchor=chain_struct file=crates/vmm/src/virtio/chain.rs

Reading a descriptor checks the index against the table, computes the address with checked arithmetic, and copies the 16 bytes once with `read_obj` from chapter 04. From then on, every check and every use reads the local copy:

:::code anchor=chain_read_desc file=crates/vmm/src/virtio/chain.rs

One step of the walk is where the rules live. In order: spend one hop of the budget; copy the descriptor; if it points to an indirect table (a second descriptor table for one request, two sections down), switch to it; refuse a zero length; refuse `addr + len` that overflows; refuse a buffer not entirely inside one RAM region (never [MMIO](/build-your-own/vmm/glossary/#mmio), the memory-mapped I/O addresses where devices live, never straddling the end of RAM); and check `next` before following it:

:::code anchor=chain_next_descriptor file=crates/vmm/src/virtio/chain.rs

The `Iterator` impl adds one rule: after the first error it yields nothing more, so a broken chain is never half used.

:::code anchor=chain_iterator file=crates/vmm/src/virtio/chain.rs

Finally, `into_validated` walks the whole chain as one request, splits it by direction, refuses a readable descriptor after a writable one, and caps each direction's total at a limit the device chooses, summed with `checked_add`:

:::code anchor=chain_into_validated file=crates/vmm/src/virtio/chain.rs

In the visualizer, add a request of two or three descriptors and process it, then switch on hostile mode and try a loop in `next`, an address outside RAM and an index wrap:

:::lab virtqueue-visualizer

If the lab does not load, here is a sketch of the lab's state for the opening puzzle's queue, with the device's verdict (a drawing, not program output; the real run is in the next section):

```text
DESC  [0: addr=0x40008000 len=8 flags=NEXT next=0] [1..7: unused]      N = 8
AVAIL idx=1  ring=[0]        device next_avail=0  ->  1 pending, head 0
walk  hop 1: desc 0 (budget 8 -> 7) ... hop 8: desc 0 (budget 1 -> 0)
      hop 9: budget exhausted  ->  ChainTooLong { budget: 8 }  ->  DEVICE_NEEDS_RESET
```

## The hop budget

Back to the opening puzzle. How do you stop a walk that loops? The textbook answer is a visited set: remember every descriptor you have seen. But that costs an allocation and bookkeeping on every hop, against loops of whatever shape the guest picks: a self-loop, a 2-cycle, a 5-cycle hidden after three good descriptors.

There is a cheaper fact. A legal chain uses each descriptor at most once, so it can never have more than N of them. A walk that wants hop N + 1 must have revisited something. So we count: a [hop budget](/build-your-own/vmm/glossary/#hop-budget) of N per chain. No allocation, one counter: the work is bounded by N, which chapter 15 capped at `QueueNumMax`.

Here is the opening puzzle as a test, in `crates/vmm/tests/walk_self_loop.rs`. It builds the ring with the helpers above (N = 8, descriptor 0 with `NEXT` set and `next = 0`, `avail.idx = 1`), pops the request, and walks it with the bare iterator, counting descriptors:

:::code anchor=walk_self_loop file=crates/vmm/tests/walk_self_loop.rs

Run it against the reference, from the repository root:

```sh
cargo test -q -p vmm --test walk_self_loop -- --nocapture
```

:::term source=captures/16-self-loop-budget.txt

**Deliberate breakage 1: comment out the hop budget.** In `step`, comment out the statement at the top of the loop that subtracts one from `self.budget`, then run the same test. Check your Predict entry first. You will do this to your own walker in Your turn; here is our run on the reference, stopped after five seconds as Ctrl-C would:

:::term source=captures/16-self-loop-no-budget.txt

No panic, no error, no output: a hang. The test thread spins at full speed reading the same 16 bytes forever. What you saw: one 16-byte write by the guest pins a host thread, with no memory bug anywhere. The misconception it exposes: "if every field is valid, the chain is valid". Validity is also about the shape of the walk. The tool that finds it: a bound on work, here the budget, and tests that build loops on purpose.

The hostile suite's own `self_loop` case tells a subtler story. It walks through `into_validated` with a 64 KiB cap, and without the budget it fails differently:

:::term source=captures/16-self-loop-cap.txt

`TooLarge` with a total of 65544 bytes, which is 8,193 hops of 8 bytes. The byte cap stopped the walk by accident: 8,193 hops where the budget would have stopped at hop 9, about 900 times more work. It worked only because zero-length descriptors are refused, so each hop adds at least one byte. The virtio-net device of chapter 19 passes no byte cap (it checks frame sizes itself), so for it the budget is the only guard. Keep defences that do not depend on each other.

## Indirect descriptors

A request with 64 buffers would fill most of a small ring. With `VIRTIO_F_INDIRECT_DESC` negotiated, one descriptor with the `INDIRECT` flag can point at a separate table of descriptors in guest RAM, and the whole request takes one ring slot. An [indirect descriptor](/build-your-own/vmm/glossary/#indirect-descriptor) is another table the guest controls, so it gets the same treatment and a few rules of its own: only if negotiated, never nested, never combined with `NEXT`, a length that is a whole number of descriptors and at most N of them, the table inside RAM, and a fresh hop budget of `len / 16`, the table's own size:

:::code anchor=chain_indirect file=crates/vmm/src/virtio/chain.rs

## When the guest breaks the rules

Every refusal so far is a `QueueError`. Almost every variant is something the guest did; the last two, `Broken` and `NotReady`, are bookkeeping states (the queue already failed, or was never set up):

:::code anchor=queue_error file=crates/vmm/src/virtio/mod.rs

What do we do with one? Not panic, and not stop the virtual machine: a guest that hands us a bad chain has hurt only its own device. For an error in the ring itself, such as a jump in `avail.idx` or a head out of range, `pop` also latches the queue broken. For any error, in the ring or in a chain, the device's `process_queue` returns it, and chapter 15's inline path hands it to `report_error`, which sets `DEVICE_NEEDS_RESET` and raises a configuration interrupt. From then on the transport ignores the doorbell until the driver writes 0 to `Status`.

Work is bounded in the other direction too. As chapter 15 showed, the inline path gives each `process_queue` call a budget of at most N chains and makes at most four such calls per doorbell, so one doorbell can never keep us busy for as long as the guest likes. From chapter 17, the device worker thread gives each call the same budget.

> **Security.** The descriptor table, both rings and every buffer are guest memory, and the guest can rewrite any byte of them at any moment, including while we walk them. The walker is the one place where guest descriptors become buffers our device will touch, so every check lives there, on the copy, for every device at once. A device model receives a [`ValidatedChain`](/build-your-own/vmm/glossary/#validatedchain) and never parses a ring.

The suite in `crates/vmm/tests/virtqueue_hostile.rs` builds each hostile shape on purpose (loops, out-of-range indices, `len = u32::MAX`, buffers in MMIO, every indirect abuse, unaligned rings), and each must return a named error, never panic. One more test, `queue_pop_model`, generates 10,000 random rings from a fixed seed and compares our walker's verdict on each with a second, deliberately plain implementation of the same rules: chapter 13's property-based testing, turned into a comparison of two implementations.

:::stopping-point Good place to stop. Sitting B needs the memory-ordering primer and about 3 hours.

## Two CPUs, one ring, no lock

The driver runs on a guest virtual CPU (vCPU). Our walker runs on a host thread: today the vCPU thread that took the `QueueNotify` exit, while that vCPU waits, and from chapter 17 a [device worker thread](/build-your-own/vmm/glossary/#device-worker-thread), the host thread that owns a device and processes its queues while the vCPUs keep running. From then on two CPUs share the ring with no lock, on a weakly ordered machine: as the `memory-ordering` primer showed, another core may see our writes in a different order from the one we made them in.

The primer also showed that one ordered index can protect a whole ring of plain copies. The split ring needs exactly two:

- an **acquire load of `avail.idx`**, so that the head index, descriptors and buffers we copy afterwards are what the driver wrote before it published the index;
- a **release store of `used.idx`**, so that the used element and every byte we wrote into the guest's buffers are visible before the driver can see the new index.

Those two accessors, plus the fence you meet below, are the whole of [GuestMemoryOrdered](/build-your-own/vmm/glossary/#guestmemoryordered). It has been in your copied `memory/mod.rs` since chapter 04; this is its explanation. It is a separate trait on top of chapter 04's contract, so that contract stays minimal and everything else in the ring stays a plain copy:

:::code anchor=guest_memory_ordered_trait file=crates/vmm/src/memory/mod.rs

On real guest RAM, each accessor is one atomic 16-bit access:

:::code anchor=guest_ram_ordered file=crates/vmm/src/memory/host.rs

> **Under the hood.** `AtomicU16::from_ptr` makes an atomic out of a pointer into guest RAM for the length of one access. Rust's memory model only describes Rust code; the guest is a C kernel on another core. As the primer argued, the pairing is made in Arm terms instead: our `LDAPRH` (a load-acquire, in Arm's slightly weaker RCpc, release-consistent processor-consistent, form) and `STLRH` (store-release) against the guest's DMB (data memory barrier) instructions, on coherent memory. Neither orders our store before a later load, which is why the third operation below is a separate fence.

Writing a completion uses the release store. The element `{id, len}` is one 8-byte copy, then the index:

:::code anchor=queue_add_used file=crates/vmm/src/virtio/queue.rs

`len` must be the number of bytes the device actually wrote, never the buffer's size. The driver trusts it: report 200 for a 150-byte answer and the guest takes 50 bytes of whatever was in that memory as data. The specification forbids over-reporting and allows under-reporting (section 2.7.8 and its device requirements); we report the exact count. A device writes its reply with `ValidatedChain::write_writable`, which fills the writable buffers in order and returns that count, ready for `add_used`:

:::code anchor=chain_write_writable file=crates/vmm/src/virtio/chain.rs

The third ordered operation is the one the primer built its opening puzzle around. After publishing `used.idx`, we read `avail.flags` to see whether the driver wants an interrupt: a store followed by a load to a different address, which release and acquire do not order. The driver does the mirror image, and if both loads see old values we stay silent while the driver sleeps on a finished request: the lost wakeup. A `fence(SeqCst)` on our side pairs with Linux's `virtio_mb()` on theirs:

:::code anchor=queue_should_interrupt file=crates/vmm/src/virtio/queue.rs

| macvmm (device) | pairs with, in Linux's `virtio_ring.c` | protects |
|---|---|---|
| acquire load of `avail.idx` | `virtio_wmb()` before the driver stores `avail.idx` | the request the driver wrote |
| release store of `used.idx` | `virtio_rmb()` after the driver loads `used.idx` | the used element and the data we wrote |
| `fence(SeqCst)` before loading `avail.flags` | `virtio_mb()` between clearing `NO_INTERRUPT` and re-reading `used.idx` | no lost wakeup |

How do you test an ordering? Not by racing threads on this Mac and hoping. `VecMemory`, the test double from chapter 04, logs every access with its address, length, direction, whether it was ordered, and every fence. The test then checks the order structurally:

:::code anchor=hostile_release_order file=crates/vmm/tests/virtqueue_hostile.rs

**Deliberate breakage 2 (watch, do not run: it needs chapter 17's virtio-rng device): drop the release.** In `add_used`, replace `write_u16_release` with a plain `write_u16`. We ran Linux's own virtio-rng driver against a build with this change; it reads 1 MiB of random numbers through the queue, and chapter 17 builds the device.

:::predict Will a real Linux guest notice the missing release?
Commit to yes or no in your journal (question 4 asks about this run), then compare with the two runs below.
:::

:::term source=captures/16-no-release-linux.txt

Check your prediction: it worked. Only the access log notices:

:::term source=captures/16-no-release-log.txt

What you saw: a guest that ran correctly on a broken queue. The misconception it exposes: "it works, so the ordering is right". We can explain this bug, but we cannot make it happen on demand: the window is narrow, and an x86 PC never reorders two stores in hardware, so there this bug cannot happen at all. The tool that finds it: the rules plus a structural check. The primer's `litmus` program runs this bug's shape between two threads (its `mp` test), and on this Mac it also counts zero reordered outcomes for the broken version: the bug is real, but it rarely or never shows up.

:::lab litmus

## The guest writes while we read

Here is a bug that passes every test of sitting A. A device validates a descriptor, then, when it needs the length again, reads `len` from guest memory a second time. On still memory both reads agree. But a guest can have a second vCPU (chapter 20 gives it one) or write while our worker thread walks (chapter 17). It sets `len = 16`, waits until our check passes, and sets `len` to a value that runs past the end of RAM. We checked one value and used another.

That is a [TOCTOU](/build-your-own/vmm/glossary/#toctou) bug, time of check to time of use: the name chapter 04 parked for this chapter, and whose register-level twin you met in chapter 15 when the queue registers froze at `DRIVER_OK`. Reading the same guest value twice like this is a [double fetch](/build-your-own/vmm/glossary/#double-fetch). It is a real attack class: Xen security advisory [XSA-155](https://xenbits.xen.org/xsa/advisory-155.html) (2015) fixed double fetches in Xen's paravirtualized back-end drivers, which share rings with their guests much as virtio does.

The defence is the rule you have been following all chapter: [copy-then-validate](/build-your-own/vmm/glossary/#copy-then-validate). Copy each descriptor once, check the copy, use only the copy. A later rewrite changes guest memory, never our copy.

To test it, the guest has to change memory at the worst moment, every time. `VecMemory` has a mutation hook for that: after a chosen number of reads, it overwrites some bytes, as a racing vCPU would.

:::code anchor=vec_memory_mutation file=crates/vmm/src/memory/vec_mem.rs

The first test in `virtqueue_toctou.rs` rewrites descriptor 0 right after our first read of it, turning it into a huge buffer inside MMIO whose `next` points back at itself. The walker must act on its first copy, and the log must show each descriptor read exactly once:

:::code anchor=toctou_descriptor_rewritten file=crates/vmm/tests/virtqueue_toctou.rs

The same file also races for real. A second thread flips `len` between 16 and 1 MiB (past the end of the test's RAM) for one second, while three walkers take turns, a third of a second each: a hand-written walker with a deliberate double fetch; the real walker with a device on top that re-reads `len` from guest memory after receiving the validated chain; and the real walker alone. In the reference run shown at the checkpoint, the hand-written walker was caught handing out an out-of-RAM buffer 15,934 times in 291,639 walks.

The re-reading device was caught 4,730 times: a correct walker cannot protect a device that goes back to guest memory, so copy-then-validate binds device code too. The real walker was never caught. Of its walks, 62,925 read `len = 16` and accepted it, and 75,572 read the 1 MiB value on their single read and correctly refused it with `BufferOutOfRam`.

**Deliberate breakage 3: re-read `len` after validation.** At the end of `step`, instead of returning the copy `d`, return it with `len` replaced by a fresh `read_u32` of the descriptor's `len` field (`table + 16 × index + 8`).

:::predict How many of the 62 hostile-ring tests fail, and how many of the 9 TOCTOU tests?
Write your two numbers in your journal (question 3 asks about this run) before you look at ours.
:::

:::term source=captures/16-reread-len.txt

Check your prediction. All 62 hostile tests pass: their memory never changes after setup, so the second read agrees with the first. Four TOCTOU tests fail. In two, the walker used the rewritten `len = u32::MAX`, and only the 64 KiB cap refused it. In the race, the real walker handed out `len: 1048576`, a buffer running past the end of RAM.

The `ChainTooLong` failure is subtler. The mutation hook fires after a fixed number of reads, and our extra read counted as one, so the rewrite that turns descriptor 1 into a loop landed before the walker copied descriptor 1 instead of after. The walker then followed the rewritten `next` until the budget stopped it. In some runs the race fails earlier, on its access-log sample, which found a lone 4-byte read of `len`: the double fetch itself.

:::term source=captures/16-reread-len-log.txt

What you saw: a bug invisible to every test on still memory. The misconception it exposes: "validating a descriptor once makes it safe" (only if you use the copy you validated). The tool that finds it: the mutation hook and the access log, which make the guest strike at the worst moment and count the reads.

> **Production note.** rust-vmm's `virtio-queue` crate, used by Cloud Hypervisor among others, walks chains the same way: descriptors copied out once, and a hop counter it calls a TTL (time to live) instead of a visited set.

## Your turn

In `learner/crates/vmm/src/virtio/`, extend your chapter 15 `queue.rs` (the alignment checks in `validate`, then `pop`, `add_used`, `should_interrupt` and `set_positions`) and write `chain.rs` (`Descriptor`, the walker, `into_validated` and `ValidatedChain::write_writable`). `GuestMemoryOrdered`, and `VecMemory`'s access log and mutation hook, have been in your copy since chapter 04; read them now against the explanations above.

The tests you copy compile only against the names they import. The shared helpers import these:

:::code anchor=virtio_support_imports file=crates/vmm/tests/virtio_support/mod.rs

The TOCTOU suite also drives chapter 15's transport, so it imports `VirtioMmio` and the test interrupt line:

:::code anchor=toctou_imports file=crates/vmm/tests/virtqueue_toctou.rs

Beyond those names, the suites call: on `Queue`, `new`, `set_size`, `set_desc_table`, `set_avail_ring`, `set_used_ring`, `set_ready`, `set_indirect`, `set_positions(next_avail, next_used)`, `next_avail`, `validate`, `pop`, `add_used(mem, head, written)`, `should_interrupt` and `is_broken`; on the chain `pop` returns, iteration and `into_validated(max_total)`; on `ValidatedChain`, the public fields `head`, `readable`, `writable`, `readable_len` and `writable_len`, and `write_writable(mem, data)`; on `Descriptor`, `to_le_bytes`, and copying one out with `read_obj` (so it implements chapter 04's `FromLeBytes`); and every `QueueError` variant shown above, compared by value. Then:

1. Copy `crates/vmm/tests/virtqueue_hostile.rs`, `virtqueue_toctou.rs`, `walk_self_loop.rs`, the `virtio_support/` directory and `data/virtqueue_vectors.json` into `learner/crates/vmm/tests/`, and from inside `learner/` run `cargo test -q -p vmm --test virtqueue_hostile --test virtqueue_toctou`.
2. From inside `learner/`, run `cargo test -q -p vmm --test walk_self_loop -- --nocapture`. Then comment out your hop budget, run it again (stop it with Ctrl-C), restore the budget, and finish your Predict entry.

Stuck? `scripts/learner hint 16` gives four hints, from a nudge to the exact reference file.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the two suites from step 1 against the code in `learner/`: the hostile ring (every shape listed above, the wrap at 65535, the exact `used.len`, the ordering check in the access log and the 10,000-ring comparison) and the TOCTOU tests (the mutation hook and the one-second race). Then it checks that your journal answers every question. There is no run on a guest yet: the queue's first guest run is chapter 17's virtio-rng device. Against the reference it looks like this:

:::term source=captures/16-checkpoint.txt

The checkpoint keeps the suites' own notes to itself. Your step 1 run prints them on stderr; here they are from the same command run on the reference, from the repository root:

:::term source=captures/16-reference-tests.txt

Your counts on the `racing_len_flip` line will differ from run to run; the `queue_pop_model` line will not, because its seed is fixed.

What now works:

- your VMM finds three rings in guest RAM, checks their alignment and placement, and serves requests across the index wrap;
- it walks descriptor chains, direct and indirect, refusing every hostile shape with a named error and putting the device into `DEVICE_NEEDS_RESET`, never panicking or hanging;
- it reads each descriptor once and never trusts guest memory after a check;
- it publishes completions with a release store, an exact `used.len` and a full fence before deciding on an interrupt.

The next chapter starts from this state (the reference at the end of chapter 16).

### What's next

Chapter 17 puts a real device behind the queue: virtio-rng, on its own worker thread, woken by the doorbell. Then you will measure what a queue buys: how many exits it takes to move 4 KiB through a virtio console compared with the PL011, which costs at least one exit for every byte.

### Open question

A virtio-blk request is normally `[readable header, writable data, writable status]`. A hostile guest sends `[writable header, readable data, readable status]`. What does your device do, and what would a naive one do?

## Spec hunt

- Virtio 1.2, section 2.7.4, "Message Framing", with its requirement subsections 2.7.4.1 and 2.7.4.2: where does the specification require device-writable descriptors to come after device-readable ones? Is that a rule for the driver or for the device, and what does 2.7.4.1 tell the device not to assume? Why does macvmm enforce the rule anyway?
- Virtio 1.2, section 2.7.8, "The Virtqueue Used Ring": what exactly must `len` count, and what does the specification allow a driver to do with a `len` it does not trust?
- Linux, `drivers/virtio/virtio_ring.c` ([source](https://github.com/torvalds/linux/blob/master/drivers/virtio/virtio_ring.c)), functions `virtqueue_add_split` and `virtqueue_get_buf_ctx_split`: find the `virtio_wmb()` and `virtio_rmb()` calls. Which of our two ordered accesses pairs with each?
