---
title: Memory ordering and barriers
slug: memory-ordering
kind: primer
minutes: 30
runs: mac+browser
required_by: [16]
also_used_by: [04, 17, 20]
lab: litmus
objectives:
- Predict which outcomes of a two-thread litmus test arm64 allows, and run one on your Mac to see an "impossible" result
- Name the four kinds of reordering and say which one x86 keeps and which ones arm64 adds
- Explain what an acquire load and a release store promise, and why each is useless without a partner
- Map Rust's Relaxed, Acquire, Release and SeqCst to the instructions they become on Apple Silicon
- Explain why a store followed by a load needs a full fence or SeqCst on both accesses, and show how its absence becomes the virtqueue lost-wakeup race
- Draw the chain of pairs that carries a guest's request from its ring to macvmm's device worker
command: ./litmus sb fence
expect: sb fence: 0 of 2000000 runs
---

# Who saw which write first?

Two threads share two integers, `x` and `y`, both zero. Thread A writes `x = 1` and then reads
`y`. Thread B writes `y = 1` and then reads `x`. Try every interleaving on paper. If A runs both
lines first, B then reads `x == 1`. If B runs first, A reads `y == 1`. If they alternate, both
writes happen before both reads and both read 1. There is no interleaving in which both threads
read 0, because whichever thread does its read last has already been preceded by the other
thread's write.

Your Mac disagrees. On the Apple M5 Pro this primer was written on, the program below finds
**both threads reading 0 in roughly half to two thirds of 2 million rounds**. You will run it
yourself in a few minutes.

Nothing is broken. The CPU is doing what the Arm architecture allows, and chapter 16 depends on
you knowing exactly what that is. There, macvmm shares a ring of requests with the guest's
driver, with no lock between them, on this CPU. One of the bugs you will learn to prevent has
exactly the shape of this puzzle, and when it bites, the guest hangs forever with no error.

:::objectives
- Predict which outcomes of a two-thread litmus test arm64 allows, and run one on your Mac to see an "impossible" result.
- Name the four kinds of reordering and say which one x86 keeps and which ones arm64 adds.
- Explain what an acquire load and a release store promise, and why each is useless without a partner.
- Map Rust's `Relaxed`, `Acquire`, `Release` and `SeqCst` to the instructions they become on Apple Silicon.
- Explain why a store followed by a load needs a full fence, or `SeqCst` on both accesses, and show how its absence becomes the virtqueue lost-wakeup race.
- Draw the chain of pairs that carries a guest's request from its ring to macvmm's device worker.
:::

:::prereqs
- [`host-concurrency`](/build-your-own/vmm/primers/host-concurrency/): threads, `thread::scope`, `Mutex`, `Condvar`, and atomics used as flags
  with `SeqCst`. This primer comes back to the other orderings it promised.
- [`aarch64-reading`](/build-your-own/vmm/primers/aarch64-reading/): what the registers `x0` and `w0` are, and how to read one line of assembly.
  We read about ten lines of compiler output here, and each instruction is explained, but the
  register names are not re-taught. The four facts you need are repeated where we use them.
- [`caches`](/build-your-own/vmm/primers/caches/) is useful background but not required: everything here happens with caches that are
  fully coherent (defined below).
- A Mac with `rustc`. Every program is one file built with `rustc --edition 2024`.
:::

## Run the puzzle yourself

An **atomic** is a shared variable whose loads and stores are indivisible (no thread ever sees
half a write) and which takes an **ordering** argument on every access, saying what that access
promises about the accesses around it. In Rust these are the `std::sync::atomic` types such as
`AtomicU32`. The weakest ordering is `Relaxed`, which means "indivisible, but **no ordering
promise** at all": the access may appear to other threads in any position relative to this
thread's other accesses. The stronger ones, `Acquire`, `Release` and `SeqCst`, are what this
primer is about.

A test this small, two threads and a handful of accesses with one outcome we ask about, is called
a **litmus test**. Ours runs each test two million times. A third thread acts as the referee:
it resets `x` and `y` to 0, then starts a round; the two workers each wait for the round, spin
a random few times so they collide at slightly different offsets, run their two accesses, and
report. The program takes two arguments: the test (`sb`, "store buffering", for the puzzle
above, and `mp` for one we meet later) and the ordering mode.

How to read the three parts:

- **Part 1** is plumbing. `X` and `Y` are the two shared variables. `ROUND` and `DONE` let the
  referee start each round and know when both workers have finished it. `Mode` carries the
  ordering chosen on the command line. `start` waits for the round and adds a random delay;
  `spin_loop()` is just a cheap "do nothing for a moment".
- **Part 2** is the whole experiment, and the only part you need to read closely.
- **Part 3** runs the rounds and counts the outcome we care about. `thread::scope` (from
  `host-concurrency`) starts the two workers and joins them at the end.

`litmus.rs` (part 1 of 3: shared state and the starting gun)

```rust
// litmus.rs: run a two-thread litmus test two million times and count one outcome.
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering, Ordering::*, fence};
use std::thread;

const N: usize = 2_000_000;
static X: AtomicU32 = AtomicU32::new(0);
static Y: AtomicU32 = AtomicU32::new(0);
static ROUND: AtomicUsize = AtomicUsize::new(0); // the referee starts round i
static DONE: AtomicUsize = AtomicUsize::new(0); // +1 per thread per finished round

#[derive(Clone, Copy)]
struct Mode {
    st: Ordering,
    ld: Ordering,
    full_fence: bool,
}

// Wait for round i, then spin a random 0..7 times so the threads meet at varied offsets.
fn start(i: usize, rng: &mut u32) {
    *rng ^= *rng << 13;
    *rng ^= *rng >> 17;
    *rng ^= *rng << 5;
    while ROUND.load(Relaxed) != i {}
    fence(Acquire);
    (0..*rng % 8).for_each(|_| std::hint::spin_loop());
}
```

For `sb`, each worker stores 1 to its own variable and loads the other's, with the orderings the
mode chooses and an optional fence between. A **fence** is an ordering point that is not
attached to any one access; we meet it properly later. For `mp`, `thread_b` returns one number
that encodes both of its reads: `flag * 10 + data`. So 11 means "flag up, data present" (fine),
0 means "flag not up yet" (fine), and **10 means "flag up, data missing"**, the bad outcome.

`litmus.rs` (part 2 of 3: the two threads)

```rust
fn thread_a(test: &str, m: Mode) -> u32 {
    if test == "sb" {
        X.store(1, m.st);
        if m.full_fence {
            fence(SeqCst);
        }
        Y.load(m.ld)
    } else {
        X.store(1, Relaxed); // mp: write the data...
        Y.store(1, m.st); // ...then raise the flag
        0
    }
}

fn thread_b(test: &str, m: Mode) -> u32 {
    if test == "sb" {
        Y.store(1, m.st);
        if m.full_fence {
            fence(SeqCst);
        }
        X.load(m.ld)
    } else {
        let flag = Y.load(m.ld); // mp: read the flag...
        flag * 10 + X.load(Relaxed) // ...then the data; 10 = "flag up, data missing"
    }
}
```

`litmus.rs` (part 3 of 3: the referee and the count)

```rust
fn worker(test: &str, m: Mode, b_side: bool) -> Vec<u32> {
    let (mut rng, mut seen) = (if b_side { 7 } else { 1 }, Vec::with_capacity(N));
    for i in 0..N {
        start(i, &mut rng);
        seen.push(if b_side { thread_b(test, m) } else { thread_a(test, m) });
        DONE.fetch_add(1, SeqCst);
    }
    seen
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (test, mode) = (args[1].as_str(), args[2].as_str()); // sb|mp  relaxed|acqrel|seqcst|fence
    let (st, ld) = match mode {
        "relaxed" => (Relaxed, Relaxed),
        "seqcst" => (SeqCst, SeqCst),
        _ => (Release, Acquire),
    };
    let m = Mode { st, ld, full_fence: mode == "fence" };
    let (a, b) = thread::scope(|s| {
        let ta = s.spawn(|| worker(test, m, false));
        let tb = s.spawn(|| worker(test, m, true));
        for i in 0..N {
            while DONE.load(SeqCst) != 2 * i {} // both threads finished round i - 1
            X.store(0, SeqCst);
            Y.store(0, SeqCst);
            ROUND.store(i, SeqCst);
        }
        (ta.join().unwrap(), tb.join().unwrap())
    });
    let hits = match test {
        "sb" => a.iter().zip(&b).filter(|&(&ra, &rb)| ra == 0 && rb == 0).count(),
        _ => b.iter().filter(|&&rb| rb == 10).count(),
    };
    println!("{test} {mode}: {hits} of {N} runs");
}
```

Put the three parts into one file in any scratch directory (it is not part of the macvmm repo),
then build it with optimisations on, since that is how real code runs:

```sh
rustc -O --edition 2024 litmus.rs
```

> **Predict.** With every access `Relaxed` (indivisible, but no ordering promise), how many of
> the two million rounds end with both threads reading 0? None, a handful, or a large fraction?

```sh
./litmus sb relaxed
```

```text
sb relaxed: 1031681 of 2000000 runs
```

On the M5 Pro, runs on one day gave about 1.39 million each time and runs on another day about
1.03 million. Your count will differ, and it depends on which cores the threads land on, but it
will not be zero. A large fraction of the time, both threads "went second". The rest of this
primer explains why, and how to forbid it.

## Two reorderers: the compiler and the core

Your source code has an order, called **program order**. Two different machines are allowed to
change it, as long as a single thread cannot tell.

The first is the compiler. Given `x = 1; r = y;`, with `x` and `y` different variables, it may
emit the load of `y` first: the thread running this code gets the same `r` and the same `x`
either way, so on its own it cannot tell the difference. Another thread, watching `x` and `y`
from outside, can.

The second is the core itself, and that is what our test caught. Memory moves between the cores
and their caches in fixed chunks called **cache lines** (128 bytes on Apple Silicon). A store is
slow: the core must own the line before it may change it, which can mean asking another core for
it. Rather than wait, the core puts the store into a small queue beside it, called the **store
buffer**, and moves on. The next instruction, our load of `y`, goes straight to the cache. The
store reaches the cache, and becomes visible to other cores, some time later.

```text
   core A                                   core B
   x = 1  --> [store buffer: x=1]           y = 1  --> [store buffer: y=1]
   r1 = y <-- cache: y is still 0           r2 = x <-- cache: x is still 0
                    \                              /
                     shared, coherent memory: x = 0, y = 0  (for a moment)
```

*Both stores are still queued when both loads read memory, so each thread sees the old value.*

Notice what did *not* go wrong. Core A always sees its own `x = 1` (a core reads its own store
buffer). And the caches are **coherent**: for any one location, all cores agree on a single
sequence of values it took, so no two cores ever hold different "current" values for `x`. Apple
Silicon's caches are coherent. What changed is the *order* in which one core's accesses to
*different* locations became visible to another core. The rules for which orders other threads
may observe make up the **memory model**. A CPU that allows many reorderings is called **weakly
ordered**, and arm64 is one.

An analogy, used once: a store buffer is an outbox tray. You drop the letter in the tray and get
on with reading your inbox; the letter leaves later. Where it breaks: Arm's outbox may also send
your letters in a different order from the one you wrote them in.

## Four reorderings, and which ones arm64 allows

Take any two memory accesses in program order, to *different* addresses, with nothing between them.
There are four pairs, and a memory model says which may appear swapped to another core. The table
compares arm64 with **x86-64**, the Intel and AMD processor family in most PCs and in Macs before
Apple Silicon, because much of the world's concurrent code was only ever tested there.

| First, then | x86-64 (TSO) | arm64 |
|---|---|---|
| store, then store | kept in order | may be reordered |
| load, then load | kept in order | may be reordered |
| load, then store | kept in order | may be reordered |
| store, then load | **may be reordered** (store buffer) | may be reordered |

x86-64's model is called **TSO** (total store order): it allows only the last row, the store
buffer. That is why the `sb` result shows up on an Intel Mac too, but why a whole class of bugs
built on the other three rows never shows on x86. Code that "has worked for years" on x86 can break
on its first day on arm64.

Two things restore order on arm64 without any special instruction. First, accesses to the *same*
address are never seen out of order; that is coherence again. Second, a **dependency** orders
things. The common one is an address dependency, where a later load's address is computed from
an earlier load's value:

```rust
let i = INDEX.load(Relaxed);   // first load
let v = table[i as usize];     // its address needs i, so it cannot run before the first load
```

The core cannot issue the second load until it knows `i`. Everything else needs an explicit
ordering instruction, which the next sections earn.

> **Aside.** Apple Silicon can run a core in a TSO mode, and Rosetta 2 turns it on for translated
> x86 processes so they keep the ordering they were written for. Native arm64 programs, `macvmm`
> and its guests included, run weakly ordered. Our measurements in this primer are all native.

## Message passing: the pattern every ring uses

The `sb` test is the store-then-load row. The pattern that matters most for virtio is a different
one. A writer fills in some data, then raises a flag. A reader waits for the flag, then reads the
data. This is **message passing**, and it is the `mp` test in our program: thread A writes `x`
(data) then `y` (flag); thread B reads `y` then `x`, and we count rounds where B returned 10,
flag up but data missing.

With `Relaxed`, two rows of the table can bite: A's two stores may become visible in the other
order, and B's two loads may run in the other order. Either one gives "flag up, data missing".

```sh
./litmus mp relaxed
```

```text
mp relaxed: 0 of 2000000 runs
```

**You will probably see 0 here, and that is the point.** This exact program printed 0 on the
M5 Pro in 20 runs out of 20. An earlier version of the harness, with a slightly different timing
loop, caught the bad outcome 4 times in 26 million rounds on the same machine. You cannot check
that number from here, so do not take the reordering on trust from our measurement: take it from
the table, which says arm64 allows both reorderings that produce it. The table is the rule; our
counts are only samples. A bug that shows up once in ten million tries passes every test you will
write and then corrupts one request in production. "My test passed" is not evidence that an
ordering is correct. Only the rules are.

The fix needs two halves. The writer's flag store must not become visible before the data, and
the reader's data load must not run before the flag load:

- A **release store** promises that every memory access before it, in program order, is visible
  to other cores before the store itself is. In Rust, `y.store(1, Release)`.
- An **acquire load** promises that every memory access after it, in program order, happens after
  the load. In Rust, `y.load(Acquire)`.

When an acquire load *reads the value written by* a release store, the two **synchronise**:
everything the writer did before its release is guaranteed visible to the reader after its
acquire. Rust and C++ call the resulting relation **happens-before**. As a timeline:

```text
 writer                              reader
 x = 42           (plain)
 y.store(1, Release) ------------->  y.load(Acquire) == 1
                                     x  -> guaranteed 42
```

*The arrow exists only because the acquire read the value the release wrote. If the reader's
load returns 0, there is no arrow and no promise about `x`, which is fine: the reader has not seen
the flag either.*

Our `acqrel` mode makes exactly those two accesses ordered and leaves the data accesses
`Relaxed`:

```sh
./litmus mp acqrel
```

```text
mp acqrel: 0 of 2000000 runs
```

This zero looks identical to the last one and means something different. The previous zero was
luck; this one is a guarantee, and it would hold on any arm64 machine. Output alone cannot tell
them apart; only the rules can.

The two halves are a **pair**. Take away the reader's half and see what breaks. The writer still
does `x = 42` then `y.store(1, Release)`, so the two stores do reach memory in order. But the
reader uses `y.load(Relaxed)` then reads `x`, and nothing stops its core from running the load of
`x` *first*, getting 0, and then the load of `y`, getting 1: flag up, data missing, with a
perfectly good release on the other side. The mirror case fails the same way: an acquire load
reading a flag that was stored `Relaxed` cannot stop the writer's stores from reaching memory in
the wrong order. Each half is useless alone. When you read ordered code, always ask "what does
this pair with?", and if you cannot point at the partner, one of them is missing.

One more consequence, which chapter 16 uses heavily. A single release store orders *every* earlier
write, however many there were, and a single acquire load orders *every* later read. The data does
not need to be atomic at all. That is why one ordered index can protect a whole ring of plain
memory.

## What the orderings compile to

Rust's orderings are promises in Rust's memory model. On a real CPU they become instructions, and
for the guest boundary later in this primer we will need to know which. Here is a tiny library
with one function per ordering:

`ord.rs`

```rust
// ord.rs: what each Rust ordering becomes on arm64.
use std::sync::atomic::{AtomicU16, Ordering::*, fence};

#[unsafe(no_mangle)]
pub fn load_relaxed(a: &AtomicU16) -> u16 { a.load(Relaxed) }
#[unsafe(no_mangle)]
pub fn load_acquire(a: &AtomicU16) -> u16 { a.load(Acquire) }
#[unsafe(no_mangle)]
pub fn load_seqcst(a: &AtomicU16) -> u16 { a.load(SeqCst) }
#[unsafe(no_mangle)]
pub fn store_release(a: &AtomicU16, v: u16) { a.store(v, Release) }
#[unsafe(no_mangle)]
pub fn store_seqcst(a: &AtomicU16, v: u16) { a.store(v, SeqCst) }
#[unsafe(no_mangle)]
pub fn fence_seqcst() { fence(SeqCst) }
#[unsafe(no_mangle)]
pub fn fence_acquire() { fence(Acquire) }
#[unsafe(no_mangle)]
pub fn fence_release() { fence(Release) }
```

The first command asks the compiler for its assembly output, `ord.s`, instead of a binary
(`#[unsafe(no_mangle)]` keeps our function names readable in it). The second keeps only the lines
we care about: function labels, and instructions starting with `ld`, `st`, `dmb` or `ret`.

```sh
rustc -O --edition 2024 --crate-type=lib --emit asm ord.rs
grep -E '^_[a-z_]+:|^\s+(ld|st|dmb|ret)' ord.s
```

```text
_fence_acquire:
	dmb	ishld
	ret
_fence_release:
	dmb	ish
	ret
_fence_seqcst:
	dmb	ish
	ret
_load_acquire:
	ldaprh	w0, [x0]
	ret
_load_relaxed:
	ldrh	w0, [x0]
	ret
_load_seqcst:
	ldarh	w0, [x0]
	ret
_store_release:
	stlrh	w1, [x0]
	ret
_store_seqcst:
	stlrh	w1, [x0]
	ret
```

How to read this listing, in four facts from `aarch64-reading`:

- A line ending in `:` is a label, the start of a function. macOS puts an underscore in front of
  every C-visible symbol name, so `load_relaxed` appears as `_load_relaxed`.
- `x0`, `x1` are 64-bit registers and `w0`, `w1` are their low 32 bits. On entry, the first
  argument (the address of our atomic) is in `x0` and the second (`v`) in `w1`; a return value
  goes back in `w0`.
- `[x0]` means "the memory at the address held in `x0`". Instructions starting `ld` load from
  memory into a register; `st` stores a register into memory.
- `ret` returns. The trailing `h` on `ldrh` and friends means a 16-bit ("halfword") access,
  because we used `AtomicU16`, the size of a virtio ring index.

So `ldrh w0, [x0]` reads: load 16 bits from the address in `x0` into `w0`. Reading the list:

- **`LDRH`**: a plain load. A `Relaxed` atomic is an ordinary load that cannot tear; the
  atomicity is free for an aligned access, and the ordering is none.
- **`STLR`** (store-release): the release store, in one instruction. Note that `store_seqcst`
  compiled to **the same `STLRH`** as `store_release`. On arm64 a `SeqCst` store costs nothing
  extra; all of `SeqCst`'s extra strength comes from the load side.
- **`LDAPR`** (load-acquire): the acquire load. Every recent Apple core has it.
- **`LDAR`**: the stronger load-acquire that `SeqCst` loads use. It keeps one promise `LDAPR`
  does not: an `LDAR` is never reordered before an earlier `STLR` by the same core. That one
  difference matters in the store-then-load section below.
- **`DMB`**, the **data memory barrier**: an instruction that orders memory accesses before it
  against accesses after it, without doing any access itself. `DMB ISH` orders all of them;
  `DMB ISHLD` orders earlier *loads* against everything later, which is all an acquire fence
  needs. `ISH` ("inner shareable") names which observers the barrier is about. For our purposes
  it means every core that can see this memory, which includes the Mac's own cores and the
  guest's virtual CPUs.

Arm has two more barriers that you will meet in guest code and in other primers, and it is worth
separating them from `DMB` once:

- **`DSB`**, the **data synchronization barrier**, does what `DMB` does and also *waits* until the
  earlier accesses have actually finished, along with earlier cache and address-translation
  maintenance (for example a `TLBI`, which tells the cores to forget cached page-table entries;
  the [`page-tables`](/build-your-own/vmm/primers/page-tables/) and `caches` primers explain these). It is used where "ordered" is not enough
  and "done" is required.
- **`ISB`**, the **instruction synchronization barrier**, is not about memory between cores at all.
  It makes the core discard instructions it has already fetched, so that a change to the core's
  own configuration (a write to a control register, for example one that turns address translation
  on) applies to every instruction after it.

macvmm's own Rust code never writes these instructions by hand. It writes `Ordering` values and
fences, and the compiler picks the instructions you have now seen.

> **Under the hood.** Arm's names for the two acquires are RCsc (`LDAR`, release consistency,
> sequentially consistent) and RCpc (`LDAPR`, processor consistent). `LDAPR` arrived with the
> `FEAT_LRCPC` extension, which your Mac reports: `sysctl hw.optional.arm.FEAT_LRCPC` prints
> `hw.optional.arm.FEAT_LRCPC: 1`. The ARM ARM states the rule in its memory model chapter: a
> Store-Release followed in program order by a Load-Acquire (`LDAR`) is observed in that order.
> `LDAPR` drops exactly that one requirement, which is why it can be cheaper, and why compilers
> use it for `Acquire` and save `LDAR` for `SeqCst`. The formal model is "other-multi-copy
> atomic": once a store is visible to any core other than its writer, it is visible to all of
> them. That property is why reasoning in pairs works on arm64.

## Store then load: why acquire and release are not enough

Back to the opening puzzle. Each thread does a store, then a load of a *different* location. In the
`acqrel` mode the store is a release and the load an acquire. Read the two promises again: a
release orders the accesses *before* it; an acquire orders the accesses *after* it. Neither says
anything about a release store followed by a later acquire load. The store can still sit in the
store buffer while the load runs. So Rust's model allows `r1 == 0 && r2 == 0` in `acqrel` mode, and
so does the architecture, because the acquire is an `LDAPR`.

```sh
./litmus sb acqrel
```

```text
sb acqrel: 0 of 2000000 runs
```

Here is the second zero that fools you. It does *not* mean the code is correct. In every run we
tried, the M5 Pro never showed the outcome with `STLR` followed by `LDAPR`; this core appears to
drain the store buffer before such a load, today. The architecture permits the reordering, a
future core may do it, and code that relies on today's timing is wrong.

What we need is **store-load ordering**: each thread's store must be ordered before its own later
load. Rust gives two ways to ask for it, and both must be used by *both* threads.

1. **Make all four accesses `SeqCst`.** Rust's model puts every `SeqCst` access into one single
   order that all threads agree on, consistent with each thread's program order, so the `sb`
   outcome is forbidden. On arm64 that is `STLR` then `LDAR`, with no barrier instruction: the
   rule from the Under the hood box, "an `LDAR` is never reordered before an earlier `STLR`", is
   exactly the store-load ordering we need.

   ```sh
   ./litmus sb seqcst
   ```

   ```text
   sb seqcst: 0 of 2000000 runs
   ```

2. **Put a `fence(SeqCst)` between the store and the load.** It compiles to `DMB ISH`, which
   keeps every earlier access, the store included, before every later one.

   ```sh
   ./litmus sb fence
   ```

   ```text
   sb fence: 0 of 2000000 runs
   ```

Why does a fence on both sides forbid "both read 0"? All `SeqCst` fences fall into one single
order. One of the two fences comes first in it; say it is A's. Then:

```text
 A:  x = 1 ; fence(SeqCst) ;            r1 = y
 B:                         y = 1 ; fence(SeqCst) ; r2 = x   -> must read 1
                    A's fence is before B's fence in the single order
```

*A's store is before A's fence, A's fence is before B's fence, and B's load is after B's fence.
So B's load must see `x = 1`. If B's fence were first instead, A's load would see `y = 1`. Either
way, at least one thread reads 1.*

You now have three zeros from `sb` (`acqrel`, `seqcst`, `fence`) that look identical. One is luck
and two are guarantees; only the rules say which.

Remember the puzzle from the top: both threads read 0 because each one's store was still queued
while its load ran. A release-acquire pair could not stop that, because it orders a store against
*earlier* accesses and a load against *later* ones, never a store against a later load. Hold on to
this shape, "I write mine, then I read yours, and so do you", because it is about to hang a
virtual machine.

Which of the two fixes does macvmm use? The fence, for a reason the section after next makes
clear: the other thread will be a guest kernel whose half is a `DMB` around plain accesses, not a
Rust `SeqCst` load. A `DMB` on each side is an argument that holds in Arm terms whatever language
each side was written in.

## The lost wakeup

First, the minimum you need about a **virtqueue**, which chapter 16 builds in full. A **guest** is
the operating system running inside our virtual machine; here it is Linux. Its disk **driver**
(guest code) wants to read and write the disk. macvmm plays the disk: it is the **device**, and
our code that services requests is the device side. They talk through a few small tables in the
guest's memory, which both can read and write, with no lock:

- The driver writes each request into a table and then advances a counter, `avail.idx`, to say
  "this many requests are available".
- The device, when it finishes a request, writes the result and advances a second counter,
  `used.idx`, to say "this many are done".

The driver learns about finished requests in one of two ways. It can **poll**: keep re-reading
`used.idx` in a loop, which is fast while busy but burns a CPU. Or it can go to sleep and be
woken by an **interrupt**, a signal the device (macvmm) injects into the guest that makes it
stop what it is doing and run the driver's handler. While polling, the driver does not want
interrupts, so it sets a flag, `VIRTQ_AVAIL_F_NO_INTERRUPT`, in a field called `avail.flags`.

Now the piece with the opening puzzle's shape. When the device finishes a request, it bumps
`used.idx`, then checks `avail.flags` to decide whether to interrupt. So the device does a store,
then a load:

```text
device (macvmm worker)                     driver (guest kernel)
  store used.idx = 6        (publish)        store avail.flags: clear NO_INTERRUPT  (wake me)
  load  avail.flags         (interrupt?)     load  used.idx                         (anything new?)
```

*Each side writes its own location and then reads the other's: the `sb` test, across the guest
boundary.*

The driver, about to stop polling and sleep, does the mirror image. It clears `NO_INTERRUPT`,
"please interrupt me from now on", then checks `used.idx` once more in case something completed
while it was still polling. If both loads return old values, which is exactly the `sb` outcome,
then the device sees "no interrupt wanted" and stays quiet, and the driver sees "nothing new" and
sleeps. The request is complete, and nobody will ever be told. That is the **lost-wakeup race**,
and its symptom is a guest that hangs on a disk read, sometimes, under load, with no error
anywhere.

The cure is the one you measured a moment ago: a full fence on both sides. Linux puts its half in
`virtqueue_enable_cb` in `drivers/virtio/virtio_ring.c`. That function first calls
`virtqueue_enable_cb_prepare`, which clears the flag, and then `virtqueue_poll`, which issues
`virtio_mb()` (a `DMB ISH` on arm64) before re-reading `used.idx`. macvmm puts its half between
the release store of `used.idx` and the load of `avail.flags`: a `fence(SeqCst)`. The release
store alone cannot do it, for the reason in the previous section. This fence is in macvmm's core
code from chapter 16, not an optional extra.

> **Security.** Ordering is a promise between cooperating sides, and a hostile guest does not
> cooperate. It can skip its barriers, or rewrite a request while we read it. Missing guest
> barriers can only make the guest's own requests garbage, and garbage is what our validation
> already expects. No ordering rule replaces copying each request once and checking the copy
> (chapter 16's TOCTOU rule: time-of-check to time-of-use, a bug where the value you checked is
> changed before you use it). Our barriers exist so that an *honest* guest is never stalled or fed
> stale data by us; our bounds checks exist so that a dishonest one cannot hurt us.

## The guest is the other thread

So far both threads were Rust. The guest is not. Each of the guest's CPUs is a **vCPU**, a virtual
CPU that macvmm runs as one host thread on one of the Mac's real cores. The guest kernel on it is
compiled from C and follows Linux's memory model. How can our `Acquire` pair with its barrier?

Rust's memory model only describes Rust code talking to Rust code; it has no rule for what a C
kernel in another address space does. So we drop down to the level both sides share: the Arm
architecture. There, both sides are just cores executing instructions on the same coherent
memory: our `STLR`, `LDAPR` and `DMB` on one side, the guest's `DMB` on the other. The
architecture's rules connect them, which is why the previous section's table of instructions
matters. Rust's job is to emit an instruction at least as strong as we asked for, in the place we
asked for it; the pairing argument is made in Arm terms. (This is a simplification of how the
formal models compose, and it is the same argument every production VMM makes.)

Two consequences follow. Chapter 04 (guest memory, where macvmm first reads and writes the
guest's RAM) and chapter 16 depend on both:

1. `volatile` is not ordering. A **volatile** access tells the compiler it must perform every
   access exactly as written, never skipping, merging or caching it in a register; chapter 04
   uses them so the compiler never assumes guest memory is unchanged. Volatile gives no
   atomicity and no ordering against another core. Only the ordered accesses do.
2. Because one acquire load orders every later read and one release store orders every earlier
   write, everything else in the ring can be plain copies. macvmm needs exactly **two** ordered
   **accessors** (the functions through which it reads or writes guest memory): an acquire load
   of `avail.idx` and a release store of `used.idx`.

Here is the whole split ring as pairs. Linux's virtio barriers have short names: `virtio_wmb()`
is a write barrier (orders stores), `virtio_rmb()` a read barrier (orders loads), and
`virtio_mb()` a full barrier. Walk row 1 first. The driver writes a request into guest memory,
then `virtio_wmb()`, then stores the new `avail.idx`. Its barrier keeps the request's bytes ahead
of the index. On our side, the acquire load of `avail.idx` keeps every later read of the request
after the index. Together: if we see the new index, we see the request it announces.

| macvmm (device) | pairs with, in the Linux driver | protects |
|---|---|---|
| acquire load of `avail.idx` | `virtio_wmb()` before the driver stores `avail.idx` (`virtqueue_add_split`) | the request and buffer contents the driver wrote |
| release store of `used.idx` | `virtio_rmb()` after the driver loads `used.idx` (`virtqueue_get_buf_ctx_split`) | the results and data we wrote into the guest's buffers |
| `fence(SeqCst)` between `used.idx` store and `avail.flags` load | `virtio_mb()` between clearing `NO_INTERRUPT` and re-reading `used.idx` (`virtqueue_enable_cb` → `virtqueue_poll`) | no lost wakeup |
| the vCPU thread wakes the worker through a mutex and condvar | `virtio_mb()` before the driver writes `QueueNotify` (`virtqueue_kick_prepare_split`) | the doorbell is never "early" |

Notice that row 1 pairs an *acquire load* on our side with a *fence* on theirs. Pairs need not
match in flavour, because what a pair needs is only that each side keeps its own two accesses in
order. A release store's job is "earlier writes before this store"; a `DMB ISHST` (the arm64
`virtio_wmb()`, a barrier for stores only) placed right before a plain store gives exactly that
guarantee for that store, so our acquire can synchronise with it. Likewise `virtio_rmb()` is a
`DMB ISHLD`, which does an acquire's job for the load just before it. The virtio 1.2
specification states the driver's side of these rules as requirements; the sections are listed
under "Going further".

## The doorbell is a synchronisation point too

One row of that table has no index in it. After queuing a request, the driver rings the device's
**doorbell**: a write to a special device address that means "look at queue N now". On our
virtual hardware that address is a register called `QueueNotify`, and the address is not RAM: it
is **MMIO** (memory-mapped I/O), an address where a device lives. When the guest writes there,
the hardware stops the vCPU and hands control to macvmm, a **trap** (also called a vCPU exit).
The vCPU thread then hands the work to the device's worker thread, which reads the ring. Each link
must carry the order forward, or the worker may look at the ring and see nothing.

```text
 guest vCPU                   macvmm vCPU thread             macvmm worker thread
 write ring, avail.idx
 virtio_mb()  (DMB ISH)
 store QueueNotify ---trap--> handle the MMIO exit
                              lock mutex, mark queue
                              pending, condvar notify --->   wake, lock mutex, see pending
                              unlock                         acquire load avail.idx, walk ring
```

*Every arrow is a happens-before edge: a barrier, the trap, then a mutex released by one thread and
acquired by the other. The condvar (from `host-concurrency`) is what lets the worker sleep until
notified.*

The mutex is the part you can break by "optimising". A mutex unlock is a release and a lock is an
acquire, so the worker that wakes is guaranteed to read an `avail.idx` at least as new as the one
the driver published before it rang. Replace the mutex and condvar with a `Relaxed` "pending"
flag that the worker polls, and the worker's later load of `avail.idx` is no longer ordered after
its load of the flag (load then load, row two of the reordering table). It can see the flag, read
a stale index, find no work, clear the flag and go back to sleep. The guest's request waits
forever: a lost wakeup again, built from a different row of the same table.

> **Production note (optional).** Real VMMs often skip the trip through the vCPU thread. Linux
> KVM's `ioeventfd`, for example, lets the host kernel signal the device thread directly when the
> guest writes the doorbell. The chain is the same, with the kernel's own barriers as the middle
> links. Many also offer `VIRTIO_F_EVENT_IDX`, which replaces the `NO_INTERRUPT` flag with an index
> and needs the same store-load fence. macvmm v1 does not offer it; chapter 16 points at it.

## Lab

The interactive `litmus` lab, planned for this page and chapter 16, is not published yet. It will
simulate a weak memory model with visible store buffers so you can step the machine and list every
outcome the rules allow. Until it is, do the same exercise by hand with the program you built:

1. Run all eight combinations: `./litmus sb relaxed|acqrel|seqcst|fence` and
   `./litmus mp relaxed|acqrel|seqcst|fence`, three times each.
2. Write a table with one row per combination and two columns: what you measured, and what the
   rules say (allowed or forbidden). Use the four-reorderings table and the promises of release,
   acquire and `SeqCst` to fill in the second column, not the first.
3. Circle every row where you measured 0 but the rules say "allowed". Those are the zeros that
   would fool a test suite.
4. For each test, name the cheapest annotations that make the bad outcome forbidden.

## Self-check

Commit to an answer before you open each one.

:::predict A colleague says: "Our ring code uses Relaxed everywhere, and the stress test has passed ten million runs on an M-series Mac. It's fine." What do you reply?
The `mp` result in this primer: the bad outcome appeared about 4 times in 26 million rounds with
one harness and 0 times in 40 million with another, on the same machine. Passing tests show the
bug is rare under that load, not that it is absent. Correctness comes from the rules: every
message-passing pair needs a release on the publishing side and an acquire on the consuming side.
:::

:::predict Why does the `sb` test show its "impossible" outcome on x86 too, while the `mp` test cannot fail on x86 even with plain accesses (assuming the compiler keeps program order)?
x86's TSO keeps three of the four orderings and allows only a store followed by a later load to a
different address to be reordered, which is exactly the store buffer, and exactly `sb`. `mp` needs
store-store or load-load reordering, which TSO forbids and arm64 allows.
:::

:::predict The device in chapter 16 does a release store of used.idx and then reads avail.flags with an acquire load. Why is that not enough, and what does it take?
Release orders accesses *before* the store; acquire orders accesses *after* the load. Nothing
orders the store before the later load, so the load can read a stale `NO_INTERRUPT` while our
`used.idx` is still unseen by the driver. It takes store-load ordering on both sides. Between two
Rust threads, `SeqCst` on the store and the load (`STLR` then `LDAR`) or a `fence(SeqCst)`
(`DMB ISH`) would both do. Against the guest, whose half is the driver's `virtio_mb()` in
`virtqueue_poll`, macvmm uses the fence, so that both sides are `DMB`s and the argument holds in
Arm terms.
:::

Before the next question: a request is not one piece of memory. The driver describes each buffer
with a small record called a **descriptor** (address, length, flags) in a **descriptor table**,
and writes the request's first descriptor number into a slot of the available ring, a **ring
entry**. When finished, the device writes a **used element** (which request, how many bytes) into
the used ring.

:::predict Why does macvmm need only two ordered guest-memory accessors, when a request touches a descriptor table, a ring entry, several buffers and a used element?
A single acquire load of `avail.idx` orders every later read, so all the descriptor and buffer
copies that follow see what the driver wrote before its barrier. A single release store of
`used.idx` orders every earlier write, so the used element and the buffer data are visible before
the driver can see the new index. Everything in between can be a plain copy.
:::

:::predict Match each instruction to its job: DMB ISH, DSB ISH, ISB, STLR, LDAPR, LDAR.
`DMB ISH` orders earlier memory accesses before later ones, as seen by every core sharing the
memory. `DSB ISH` does that and waits for earlier accesses and maintenance (cache, TLB) to
complete. `ISB` makes the core refetch later instructions so earlier changes to its own
configuration apply to them. `STLR` is a store-release (and also what a `SeqCst` store becomes).
`LDAPR` is a load-acquire that may be reordered before an earlier `STLR`; `LDAR` is the `SeqCst`
load-acquire that may not.
:::

:::predict A contributor replaces the worker's mutex and condvar with an AtomicBool pending flag, set with Relaxed by the vCPU thread and polled with Relaxed by the worker. What can go wrong, and what is the smallest fix?
The worker's load of `avail.idx` can be ordered before its load of the flag, so it can see the
flag set yet read an old index, find nothing, clear the flag and sleep: a lost doorbell and a hung
request. The smallest ordering fix is a release store of the flag paired with an acquire load of
it, which rebuilds the happens-before edge; macvmm keeps the mutex and condvar because the worker
also needs to sleep without spinning.
:::

:::predict On paper, draw the chain that carries one disk request from the guest driver writing it to macvmm's worker reading it. Label every link with what orders it.
Driver writes the descriptors and ring entry, then `virtio_wmb()`, then stores `avail.idx`
(table row 1). `virtio_mb()`, then the store to `QueueNotify` (row 4). The store traps, and the
vCPU thread handles the exit. The vCPU thread locks the mutex, marks the queue pending, notifies
the condvar and unlocks (a release). The worker wakes and locks the mutex (an acquire), sees
pending, and does the acquire load of `avail.idx`, which pairs with the driver's `virtio_wmb()`
so its plain reads of the descriptors see what the driver wrote. Compare with the doorbell
diagram above. If any link in your drawing has no label, that is where a bug would go.
:::

## Where this shows up in macvmm

- **Chapter 04, Guest memory** (`/build-your-own/vmm/memory/guest-memory/`): one forward pointer
  here, from its explanation of what `volatile` does and does not give you. No ordered accessors
  exist yet.
- **Chapter 16, Split virtqueues** (`/build-your-own/vmm/virtio/virtqueues/`, requires this
  primer): the `GuestMemoryOrdered` trait in `crates/vmm/src/memory/` with its acquire load and
  release store, the `fence(SeqCst)` before `avail.flags` in `crates/vmm/src/virtio/queue.rs`, and
  a host test that checks the ordering through the test memory's access log. Its journal question 4
  asks you for this primer's pairing table.
- **Chapter 17, virtio-rng and virtio-console**
  (`/build-your-own/vmm/virtio/virtio-rng-console/`): the device worker thread and the doorbell
  chain drawn above.
- **Chapter 20, SMP** (`/build-your-own/vmm/smp/smp/`): with several vCPUs, the guest's own
  ordering assumptions between its CPUs pass through our devices, and vCPU threads hand work to
  each other.
- Related primers: `host-concurrency` (mutexes, condvars, atomics as flags), `caches` (`DSB` and
  `ISB` in cache maintenance), `page-tables` (`DSB` and `ISB` after `TLBI`).

## Going further

- Arm, *Arm Architecture Reference Manual for A-profile architecture* (DDI 0487): chapter B2, "The
  AArch64 Application Level Memory Model", section B2.3, "Definition of the Arm memory model"
  (observability, ordering, Load-Acquire and Store-Release, and the memory barrier subsections for
  `DMB`, `DSB` and `ISB`); and the instruction pages for `DMB`, `DSB`, `ISB`, `LDAR`, `LDAPR` and
  `STLR` in chapter C6. Section numbers shift between issues, so search by these titles.
- OASIS, *Virtual I/O Device (VIRTIO) Version 1.2*: §2.7.7, "Used Buffer Notification Suppression";
  §2.7.13, "Supplying Buffers to The Device" (the driver's barrier before updating `idx`, and before
  notifying); §2.7.14, "Receiving Used Buffers From The Device".
- Linux, `Documentation/memory-barriers.txt` (the pairing rule is in "SMP barrier pairing"), and
  `tools/memory-model/` for the formal model and its litmus tests; `drivers/virtio/virtio_ring.c`
  for the driver side of every row in the pairing table.
- Mara Bos, *Rust Atomics and Locks* (O'Reilly, 2023), chapter 3, "Memory Ordering", and chapter
  7, "Understanding the Processor", which disassembles atomics on arm64 and x86-64 as we did here.

## Checkpoint

You can now explain the puzzle: each thread's store waited in its store buffer while its load ran,
release and acquire do not order a store before a later load, and store-load ordering on both
sides (a `SeqCst` fence, or `SeqCst` on every access) does. Verify it with the program from the
start of this primer:

```sh
./litmus sb fence
```

```text
sb fence: 0 of 2000000 runs
```

This zero looks exactly like the zeros from `mp relaxed` and `sb acqrel`. The difference is not
in the output: this one is guaranteed by the rules, and those were granted by the timing of one
machine. Being able to say which is which is the skill this primer teaches.

**What's next.** Chapter 16 lays a split virtqueue out in guest memory and walks a hostile guest's
descriptor chains. You will write the two ordered accessors and the fence from this primer's
pairing table, and a test that proves they are in the right places.

**One open question.** Our `fence(SeqCst)` pairs with a barrier in the Linux driver. A different
guest operating system with a buggy driver leaves its half out. Whose requests hang, and is there
anything the device side could do about it without trusting the guest?
