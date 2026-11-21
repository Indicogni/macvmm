---
title: Host concurrency: threads, locks, atomics
slug: host-concurrency
kind: primer
minutes: 30
required_by: [09]
labs: [lock-order]
runs: mac+browser
command: sh -c 'umask 077 && cd "$(mktemp -d)" && touch f && ls -l f | cut -c1-10'
expect: -rw-------
---

# Why did two million come out under one million?

Two threads each add 1 to the same counter, a million times. The answer should be 2,000,000.
Here is that program in C, and here is what it printed on an M5 Pro, five runs in a row. Not
only is the answer wrong; it is wrong by more than half, and wrong differently every time. Then
we write the same program in Rust, and Rust refuses to compile it. Later in this primer we write
a different broken program, one that freezes forever, and Rust compiles that one without a word.
By the end you will know why both things happen, and which of the two is your job.

`race.c` (anywhere, for example a scratch folder):

```c
#include <pthread.h>
#include <stdio.h>

long count = 0;

void *work(void *arg) {
    for (int i = 0; i < 1000000; i++)
        count = count + 1;
    return NULL;
}

int main(void) {
    pthread_t a, b;
    pthread_create(&a, NULL, work, NULL);
    pthread_create(&b, NULL, work, NULL);
    pthread_join(a, NULL);
    pthread_join(b, NULL);
    printf("%ld\n", count);
    return 0;
}
```

```sh
clang -O0 -o race race.c
for i in 1 2 3 4 5; do ./race; done
```

```text
972634
998510
998252
997140
998713
```

Your numbers will differ from these and from each other. That is the point.

Three things in that program are new. `pthread_create` starts a new thread running the function
`work`; `pthread_join` waits until that thread has finished. `-O0` tells the compiler not to
optimise, so the machine code does exactly what each line says (we come back to why that
matters). Below, we will name this bug a *data race* and see why the language calls it
*undefined behaviour*.

:::objectives
- Say what a thread owns and shares, and why a vCPU is tied to one.
- Explain and measure timer-driven preemption.
- Trace a lost update, and name the Rust errors that forbid it.
- Use `Mutex`, `Arc`, `thread::scope`, `Condvar`, channels and `AtomicBool`.
- Make a deadlock, spot it, and cure it with a lock order.
- Explain file descriptors, `pread`, `O_CLOEXEC`, `umask` and file modes.
:::

:::prereqs
The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer (process, kernel, system call, interrupt). Enough Rust to read closures,
`Result` and `unwrap`; ownership and borrowing as in Appendix A. A Mac with Xcode's command-line
tools and `rustc` for the experiments. Every Rust file here is a single file built with
`rustc --edition 2024`, no Cargo project needed. The lab runs in any browser.
:::

## A thread is a second pair of hands

So far, a running program in this course has been one flow of execution: one program counter
walking through instructions, one set of registers, one stack. A process can hold several of
these at once. Each one is a [**thread**](/build-your-own/vmm/glossary/#thread): an independent
flow of execution inside a process, with its own registers (including its own program counter
and stack pointer) and its own stack, sharing everything else the process has.

That split is the whole story of this primer, so here it is as a picture.

```text
 process (one PID)
 +-----------------------------------------------------------+
 |  shared: memory (globals, heap), open file descriptors,    |
 |          current directory, umask                          |
 |                                                            |
 |   thread A                 thread B                        |
 |   +----------------+       +----------------+              |
 |   | x0..x30, sp, pc|       | x0..x30, sp, pc|              |
 |   | its own stack  |       | its own stack  |              |
 |   +----------------+       +----------------+              |
 +-----------------------------------------------------------+
```

*Notice what is in the box at the top: both threads reach `count` because memory is shared.*

Reading the picture: a **PID** is the number the kernel gives a process. **Registers** are the
handful of tiny storage slots inside the CPU core that instructions actually compute on. On
arm64 (the CPU family in every Apple Silicon Mac) the general-purpose ones are called `x0` to
`x30`; `pc`, the **program counter**, holds the address of the next instruction, and `sp`, the
**stack pointer**, holds the address of the top of the thread's stack (the memory where a
function keeps its local variables). You need no more arm64 than that here. File descriptors and
the umask get their own section at the end.

The kernel schedules threads, not processes. On a Mac with 15 cores, 15 threads can run at the
same instant, and many more can take turns. In `race.c`, `pthread_create` asked the kernel for a
new thread starting at `work`, and `pthread_join` waited for it to finish.

Why does a hypervisor care? A **guest** is the operating system running inside our virtual
machine, and a **vCPU** (virtual CPU) is one of the CPUs that guest believes it has. On the
host, a vCPU is driven by an ordinary thread that calls `hv_vcpu_run`: the real core then runs
guest instructions until something needs our attention (a *VM exit*), and the call returns to
our code. Hypervisor.framework (HVF), Apple's API for this, hands out vCPUs per thread. The
header says it plainly: `hv_vcpu_create` "creates a vCPU instance for the current thread", and
nearly every other vCPU call, `hv_vcpu_run` included, "must be called by the owning thread". The
vCPU's register state is kept with that thread inside the kernel, and HVF offers no call to move
it. The thread that created a vCPU is its **owning thread**. So a VM with four vCPUs is, on the
host, at least four threads, and a lot of macvmm's design
follows from that one rule.

## Who takes the CPU away?

Before we look at the race, one question from `os-basics` needs a fuller answer. A thread that
spins in a loop never makes a system call and never faults. How does anybody else ever run on
that core?

The kernel programs a hardware timer before it lets a thread run. When the timer fires, it raises
an **interrupt** (a hardware signal that makes the core stop what it is doing and jump into the
kernel, whether or not the running code asked for it, unlike a *system call*, which is a program
deliberately asking the kernel for a service). The kernel's
**scheduler** (the part that decides who runs next) gets a chance to look around. If another
thread has been waiting, the scheduler saves the spinning thread's registers, loads the other's,
and returns into it. Taking the CPU from a thread that did not ask to give it up is
**preemption**; because a timer forces it, we call it **timer-driven preemption**. A thread that
gives the CPU up itself, by sleeping or blocking on a lock or a read, makes a *voluntary* switch
instead. The kernel counts both: macOS reports them as **voluntary** and **involuntary context
switches**, and the involuntary count is exactly the number of times a thread was preempted.

You can count these. `spin.rs` starts many threads that each burn one second of **wall-clock
time** (time as a clock on the wall measures it, not CPU time) without ever calling the kernel,
while the main thread tries to wake up every 250 ms. Two Rust pieces in it: `|| { ... }` is a
closure, an unnamed function that the new thread runs, and `thread::scope` is a way of starting
threads that we explain properly in the mutex section; for now, read `s.spawn` as "start a
thread".

`spin.rs`:

```rust
use std::thread;
use std::time::{Duration, Instant};

fn main() {
    let n: usize = std::env::args().nth(1).unwrap().parse().unwrap();
    thread::scope(|s| {
        for _ in 0..n {
            // Each thread spins for one second and never calls the kernel.
            s.spawn(|| {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(1) {}
            });
        }
        // The main thread still gets to run: it sleeps, wakes and prints.
        for i in 1..=3 {
            thread::sleep(Duration::from_millis(250));
            println!("main thread awake, tick {i}");
        }
    });
}
```

:::predict Run it with 60 spinning threads on a 15-core machine. Does the main thread still print its three ticks on time, or do the spinners starve it?
The ticks arrive on time. The kernel preempts the spinners, so the sleeping main thread still gets a core whenever it wakes. The capture below shows it.
:::

```sh
rustc --edition 2024 -O spin.rs
/usr/bin/time -l ./spin 60
```

The relevant lines, captured on an M5 Pro (15 cores):

```text
main thread awake, tick 1
main thread awake, tick 2
main thread awake, tick 3
        1.04 real        13.60 user         0.03 sys
                7474  involuntary context switches
```

The ticks arrive on time. `/usr/bin/time` reports three times: `real` is wall-clock time, `user`
is CPU time spent running our own code, summed over all cores, and `sys` is CPU time the kernel
spent working on our behalf (tiny here, because the spinners never call it). The 7474 is the
involuntary-switch counter from above: sixty threads that never yield were preempted thousands
of times in one second, and the sleeping main thread got its turn whenever it woke. User time
divided by real time, 13.60 / 1.04, says about 13 cores were busy for that second. Your counts
will differ; with `./spin 1` there are far fewer switches (about a hundred on the M5 Pro).

For us, preemption has two consequences. The good one: a guest that spins forever on a vCPU
thread cannot freeze the Mac, and chapter 11 plays the same trick on the guest with a virtual
timer. The bad one: the kernel can stop a thread *between any two instructions*, and it does not
ask what the thread was in the middle of.

## The race, one instruction at a time

That last sentence explains the puzzle. `count = count + 1` looks like one step, but at `-O0` the
compiler emits three instructions: load `count` from memory into a register, add 1 to the
register, store the register back. (You can see them yourself: `clang -O0 -S race.c` writes the
assembly to `race.s`; inside `_work` you will find `ldr x8, [x9, _count@PAGEOFF]`,
`add x8, x8, #1` and `str x8, [x9, _count@PAGEOFF]`.) In the trace below
`x8` is simply the register the compiler happened to pick. Each thread has its *own* copy of
`x8`, so two threads can do this:

```text
 thread A                    memory count    thread B
 load  x8 <- count (=41)         41
                                 41          load  x8 <- count (=41)
 add   x8 = 42                   41          add   x8 = 42
 store count <- 42               42
                                 42          store count <- 42
```

*Two increments happened; the counter moved by one. One update is lost.*

This does not even need preemption: on two cores, A and B run truly at the same time and their
loads and stores interleave in whatever order the memory system allows. The result depends on
timing, so it changes from run to run. Two threads accessing the same memory at the same time,
at least one of them writing, with nothing to order the accesses, is a **data race**. In C and in
Rust, a data race is not "a slightly wrong number": it is undefined behaviour, meaning the
language promises nothing at all about the program.

> **Try it.** Build `race.c` with `-O2` instead of `-O0` and run it five times. On the machine
> this primer was written on, it printed `2000000` every time. The race is hiding, not gone: the
> optimiser turned the loop into one large addition, so the window for losing an update became
> tiny, and the program is just as undefined as before. A race you cannot see is still a race,
> which is why we want a tool that rejects it before it runs.

## Rust refuses to compile the race

Here is the same program in Rust. `thread::scope` (more on it below) lets the two threads borrow
`count` from `main`.

`race.rs`:

```rust
use std::thread;

fn main() {
    let mut count: u64 = 0;
    thread::scope(|s| {
        s.spawn(|| for _ in 0..1_000_000 { count += 1; });
        s.spawn(|| for _ in 0..1_000_000 { count += 1; });
    });
    println!("{count}");
}
```

```sh
rustc --edition 2024 race.rs
```

```text
error[E0499]: cannot borrow `count` as mutable more than once at a time
```

The full message points at both closures. To change `count`, each closure needs permission to
write it, a *mutable borrow* (written `&mut`), and Rust's central rule is that a mutable borrow
is **exclusive**: while one piece of code may write a value, nothing else may touch it. That rule
was not invented for threads; it is the ownership rule from Appendix A. Applied across threads,
it means two threads can never both write the same plain memory.

The second half of the guarantee is a label the compiler puts on every type: is a value of this
type **allowed to cross threads**? Rust spells the label as two traits, `Send` and `Sync`, and
the details can wait for the Rustonomicon (see Going further). Most types have the label. `Rc`, a
pointer that counts how many copies of itself exist and frees the value when the count reaches
zero, does not: it updates that count with a plain load, add and store, so two threads cloning
the same `Rc` would be `race.c` all over again, a lost update on the count, and the value could
be freed while still in use. The compiler keeps it on its thread:

```rust
use std::rc::Rc;
use std::thread;

fn main() {
    let shared = Rc::new(5);
    let copy = Rc::clone(&shared);
    thread::spawn(move || println!("{copy}")).join().unwrap();
}
```

```text
error[E0277]: `Rc<i32>` cannot be sent between threads safely
```

(`E0499` and `E0277` are rustc's error codes; `rustc --explain E0499` prints a longer
explanation of each.) Together, the exclusive borrow plus the "allowed to cross threads" label
give the guarantee: **safe Rust has no data
races.** Keep the exact wording in mind. It is about simultaneous unsynchronised access to
memory, and nothing more. We will meet bugs it does not cover.

## A lock makes three steps one

To fix the counter, we need the load, add and store to happen as a unit that no other thread can
cut into. A **mutex** (from "mutual exclusion") is a lock that at most one thread holds at a time;
a thread that asks for a held mutex is put to sleep until it is released. Rust's `Mutex<T>` wraps
the data it protects, so you cannot reach the data without the lock.

`locked.rs`:

```rust
use std::sync::Mutex;
use std::thread;

fn main() {
    let count = Mutex::new(0u64);
    thread::scope(|s| {
        for _ in 0..2 {
            s.spawn(|| {
                for _ in 0..1_000_000 {
                    *count.lock().unwrap() += 1;
                }
            });
        }
    });
    println!("{}", count.into_inner().unwrap());
}
```

```sh
rustc --edition 2024 -O locked.rs
./locked
```

```text
2000000
```

Every run. Three details are worth slowing down for.

`lock()` returns a **guard**, a value that gives access to the data and releases the lock when it
is dropped. The `*` in `*count.lock().unwrap() += 1` reaches *through* the guard to the `u64`
inside, the way `*` follows a reference. Here the guard is a temporary, dropped at the end of the
statement, so each increment holds the lock briefly. The lock is released by scope, never by
remembering to call `unlock`. At the end, `into_inner` takes the value out of the mutex, which is
allowed because no thread can still be using it.

> **Aside: why `lock()` returns a `Result`.** If a thread panics while holding the guard, the
> mutex is marked **poisoned**, and later `lock()` calls return an error, since the data may be
> half-updated. `unwrap` turns that into a panic on the next thread too, which is usually what you
> want. You can ignore poisoning for the rest of this primer.

`thread::scope` creates threads that are guaranteed to finish before `scope` returns. That
guarantee is what lets them borrow `count` from `main`'s stack. Without a scope, `thread::spawn`
requires the closure to own everything it uses (Rust writes this requirement as `'static`: "valid
for as long as the program might need it"), because the thread could outlive the function. Then
you share data with **`Arc`** (atomic reference count): `Rc` done safely. Its clones all point at
one value on the *heap* (memory that outlives any single function call), freed when the last
clone drops, and its count is updated with atomic instructions (more on those below), so it is
allowed to cross threads where `Rc` is not.

`arc.rs`, the same counter with owned threads:

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let count = Arc::new(Mutex::new(0u64));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let count = Arc::clone(&count);
        handles.push(thread::spawn(move || {
            for _ in 0..1_000_000 {
                *count.lock().unwrap() += 1;
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("{} (strong count {})", count.lock().unwrap(), Arc::strong_count(&count));
}
```

```text
2000000 (strong count 1)
```

The strong count is 1 because the threads' clones were dropped when they finished. `join`
returns `Err` if the thread panicked, which is how a parent learns a worker died. You will meet
`Arc<Mutex<...>>` again in macvmm, wrapped around each emulated device, because a device is
reached from several threads that do not share a scope with it.

## Waiting without spinning

A worker thread often has nothing to do until another thread hands it a job. It could
**spin**, that is busy-wait: check a flag in a tight loop over and over, like `spin.rs` did. That
burns a whole core for nothing. We want the thread to *sleep* until the state it cares about
changes. (macvmm has exactly this case: a second vCPU that must wait until the first one says
"start". The example below borrows those names.)

A **condition variable** does that: a thread holding a mutex calls `wait`, which atomically
releases the mutex and puts the thread to sleep; another thread changes the protected state and
calls `notify_one` or `notify_all`; the sleeper wakes, re-takes the mutex, and carries on. Think
of it as a doorbell beside a locked room: you go in, see nobody has left you a parcel, and wait
outside for the bell. Where the picture breaks: the bell carries no message. It only says
"something may have changed; go and look", so you must look.

`park.rs`:

```rust
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::Duration;

fn main() {
    let powered_on = Mutex::new(false);
    let wake = Condvar::new();
    thread::scope(|s| {
        s.spawn(|| {
            let mut on = powered_on.lock().unwrap();
            while !*on {
                // Releases the lock while asleep, re-takes it on waking.
                on = wake.wait(on).unwrap();
            }
            println!("secondary vCPU: powered on, running");
        });
        thread::sleep(Duration::from_millis(100));
        *powered_on.lock().unwrap() = true; // change the state...
        wake.notify_one(); // ...then ring the bell
        println!("boot vCPU: start sent");
    });
}
```

```text
boot vCPU: start sent
secondary vCPU: powered on, running
```

The two lines can come out in either order (we saw both); what cannot happen is the secondary
running before `powered_on` is true.

The `while !*on` loop is the important line, and it is called the **predicate loop**. It is there
for two reasons. First, a waiter can wake when nobody notified it, a **spurious wake-up**; POSIX
allows it and Rust's documentation warns about it, so a woken thread must recheck the state.
Second, the state may already be true before the thread ever waits, and then there is nobody left
to ring the bell. Waiting without checking first gives the **lost wake-up**. The next program
shows it. It uses `wait_timeout`, which is `wait` with a deadline: it returns after the given
time even if nobody rang, and tells you whether it timed out.

`lost.rs` (deliberately broken):

```rust
use std::sync::{Condvar, Mutex};
use std::time::Duration;

fn main() {
    let lock = Mutex::new(());
    let wake = Condvar::new();
    wake.notify_one(); // the bell rings before anyone listens
    let guard = lock.lock().unwrap();
    let (_g, res) = wake.wait_timeout(guard, Duration::from_secs(2)).unwrap();
    println!("woke only because of the timeout: {}", res.timed_out());
}
```

```text
woke only because of the timeout: true
```

A notify with no waiter is not saved anywhere. Without the timeout this thread would sleep
forever. The rule: **the state lives in the mutex; the condvar is only the bell; always wait in a
loop on the state.** `Condvar::wait_while` writes the loop for you.

## Handing over messages: channels

Sometimes one thread does not need to share data with another, only to tell it something: "the
user pressed Ctrl-C", "the guest asked to reset". A **channel** is a queue with a sending end and a
receiving end. `std::sync::mpsc` (multiple producer, single consumer) gives you `channel()`,
returning a `Sender` you can clone into many threads and one `Receiver`. `recv()` sleeps until a
message arrives, and returns an error once every sender is gone, which doubles as a "nobody is
left to talk to you" signal. `recv_timeout` adds a deadline.

You could build a channel yourself from a mutex, a condvar and a queue (*Rust Atomics and
Locks*, chapter 5, does exactly that). std's version is a faster, mostly lock-free design, but
it gives the same contract. Prefer a channel whenever the relationship is "events flow one way".
macvmm has one **control thread**, the thread that decides when the VM stops, resets or pauses;
it sits in a receive loop, and every other thread that has news posts an event to it. You will
see a channel in the next example.

## Atomics as flags

A mutex is overkill for one boolean that one thread sets and others read in a hot loop. For that
there are **atomic** types: `AtomicBool`, `AtomicU64` and friends, whose loads, stores and
read-modify-write operations (such as `fetch_add`) are indivisible and never form a data race,
even through a shared `&` reference. The counter could have been an `AtomicU64` with `fetch_add`.

`stop.rs` combines a channel and a flag the way macvmm's shutdown does: one thread stands in for
"something told us to quit" (in macvmm, the thread that notices Ctrl-C) and sends a reason to the
control thread, which sets the stop flag; a stand-in vCPU loop checks the flag on every trip.

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn main() {
    let stopping = AtomicBool::new(false);
    let (tx, rx) = mpsc::channel::<&str>();
    thread::scope(|s| {
        s.spawn(|| {
            let mut loops = 0u64;
            while !stopping.load(Ordering::SeqCst) {
                loops += 1; // stand-in for one trip round the run loop
            }
            println!("vcpu: saw the flag after {loops} loops");
        });
        s.spawn(move || {
            thread::sleep(Duration::from_millis(50));
            tx.send("user quit").unwrap(); // stand-in for the Ctrl-C thread
        });
        let reason = rx.recv().unwrap(); // control thread blocks here
        println!("control: {reason}");
        stopping.store(true, Ordering::SeqCst);
    });
    println!("all threads joined");
}
```

```text
control: user quit
vcpu: saw the flag after 60729066 loops
all threads joined
```

The loop count differs every run (the next run printed 65295368).

Every atomic operation takes an **`Ordering`** argument, which says what *other* memory
accesses the atomic operation keeps in order around it. The rule for now: **use `SeqCst`**, the
strongest choice, which is right whenever a weaker one would be. macvmm's stop flag uses it too.
The [`memory-ordering`](/build-your-own/vmm/primers/memory-ordering/) primer (chapter 16) explains the weaker orderings and when they are safe.

> **Under the hood (optional).** The flag alone cannot stop a vCPU that is inside `hv_vcpu_run`,
> because that thread is running guest code, not our loop. So macvmm's stop sets the flag *and
> then* calls `hv_vcpus_exit`, which forces the listed vCPUs out of the guest at once (a *kick*);
> `hv_vcpu_run` returns with a "canceled" exit, and the loop sees the flag. A vCPU that checked
> the flag a moment before entering the guest still gets the kick, because the header promises
> that a vCPU not running when kicked returns at once from its next `hv_vcpu_run`. This is the
> condvar rule again in a new costume: set the state, then ring the bell. Chapters 09 and 20 build
> it for real.

## Deadlock, and the cure

Now the second broken program, the one Rust compiles happily. Two threads, two locks. A
stand-in vCPU thread holds the UART device and wants the input buffer; a stand-in stdin thread
holds the input buffer and wants the device. A **`Barrier`** is a meeting point:
`Barrier::new(2)` makes each thread that calls `wait()` sleep until two threads have arrived,
then lets both go. Here it makes sure each thread has its first lock before either asks for its
second, so the failure happens every time instead of once a week.

`deadlock.rs` (deliberately broken):

```rust
use std::sync::{Barrier, Mutex};
use std::thread;

fn main() {
    let device = Mutex::new("uart");
    let input = Mutex::new("bytes");
    let both_hold_one = Barrier::new(2);
    thread::scope(|s| {
        s.spawn(|| {
            let _d = device.lock().unwrap(); // vCPU: device first
            both_hold_one.wait();
            let _i = input.lock().unwrap();
            println!("vcpu got both");
        });
        s.spawn(|| {
            let _i = input.lock().unwrap(); // stdin: input first
            both_hold_one.wait();
            let _d = device.lock().unwrap();
            println!("stdin got both");
        });
    });
    println!("done");
}
```

What does it print, and how much CPU does it burn? Nothing, at 0% CPU, forever. Each thread sleeps waiting for a lock the other holds and will never
release. That is a **deadlock**: a cycle of threads, each waiting for the next. The macOS `sample`
tool shows it: for the given number of seconds it repeatedly stops the process and records, for
every thread, which function it is currently in (one record is a *sample*; each function in the
chain of calls is a *frame*). Run the program in one terminal, and in another:

```sh
sample deadlock 1
```

Trimmed to the interesting frames (thread numbers and sample counts will differ):

```text
    800 Thread_3630115   DispatchQueue_1: com.apple.main-thread  (serial)
    +   800 semaphore_wait_trap  (in libsystem_kernel.dylib) + 8
    800 Thread_3630118
    +   800 __psynch_mutexwait  (in libsystem_kernel.dylib) + 8
    800 Thread_3630119
        800 __psynch_mutexwait  (in libsystem_kernel.dylib) + 8
```

Both workers sit in `__psynch_mutexwait`, the kernel call behind a blocked mutex, and the main
thread waits for the scope to join them. Press Ctrl-C to end it.

Why did Rust not object? Because nothing here is a data race: every access to every value is
under its lock. Deadlock is about the *order* in which threads wait, and that is a property of
the whole program's timing, which the borrow checker does not look at.

The cure is a rule, not a type. A deadlock needs a cycle. If every thread takes locks in the same
global order, say "device, then input", a cycle cannot form: whoever holds the device can always
go on to get the input, because nobody holding the input is waiting for the device. Here is the
fixed program. Both threads now take `device` first. The barrier is gone too: its only job was to
force the bad timing, and with one order it would hang on its own (the first thread would wait
at the barrier while holding `device`, and the second could never get there).

`ordered.rs`:

```rust
use std::sync::Mutex;
use std::thread;

fn main() {
    let device = Mutex::new("uart");
    let input = Mutex::new("bytes");
    thread::scope(|s| {
        s.spawn(|| {
            let _d = device.lock().unwrap(); // vCPU: device first
            let _i = input.lock().unwrap(); // ...then input
            println!("vcpu got both");
        });
        s.spawn(|| {
            let _d = device.lock().unwrap(); // stdin: device first too
            let _i = input.lock().unwrap();
            println!("stdin got both");
        });
    });
    println!("done");
}
```

```text
vcpu got both
stdin got both
done
```

Either line may come first. macvmm writes its order down once (device lock, then the buffers
behind a device, then the interrupt lock, never in reverse) and adds rules of the same spirit:
never hold a lock across `hv_vcpu_run`, and never hold a device lock across blocking host I/O on
a vCPU thread. The one place macvmm accepts I/O under a device lock is the background worker that
reads and writes the guest's disk; chapter 17 explains why that wait is bounded. A lock held
while sleeping on something slow turns every other thread that wants it into a hostage.

> **Security.** In a VMM, "something slow" can be chosen by the guest. A guest that stops reading
> its serial console can fill our input buffer; if the thread reading your keyboard blocked on
> that full buffer while holding a lock, the guest would also block the key sequence that quits
> macvmm (Ctrl-A then x). So that thread never waits for the guest: when the buffer is full it
> drops guest-bound bytes and counts them. Any wait whose end the guest controls is an attack
> surface; bound it, or don't hold a lock across it.

## The other thing threads share: file descriptors (optional on first read)

This section is a short add-on: nothing above depends on it, and you can skip it until chapter
09 or the [`block-storage`](/build-your-own/vmm/primers/block-storage/) primer sends you back. It is here because the fd table is the second
big thing all threads of a process share, after memory.

Memory is not the only shared state. When a process opens a file, the kernel keeps the details
(which file, the access mode, the current position) in its own table and hands back a small
integer, a **file descriptor** (fd). Every later `read`, `write` or `close` names the file by that
number. The table belongs to the process, so every thread sees the same fds. Three are open
before `main` runs: 0 is standard input, 1 standard output, 2 standard error.

`lsof` ("list open files") shows them. In the shell, `$$` expands to the shell's own PID, so
this asks for fds 0 to 2 (`-d 0-2`) of your shell (`-p $$`), with `-a` meaning "both conditions
at once":

```sh
lsof -a -p $$ -d 0-2
```

The capture below was made from a script rather than an interactive shell, so it happens to show
`lsof`'s own fds; lsof inherited them from its parent, so they are the same three. In your
terminal the COMMAND column names your shell, and the PID and tty number differ:

```text
COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
lsof    99678 alice    0u   CHR   16,1      0t0 1043 /dev/ttys001
lsof    99678 alice    1u   CHR   16,1      0t0 1043 /dev/ttys001
lsof    99678 alice    2u   CHR   16,1      0t0 1043 /dev/ttys001
```

All three are the same terminal device (`/dev/ttys001`; `CHR` means a *character device*, one
that delivers a stream of bytes rather than a file you can seek in). The next file you open gets
the lowest free number, 3.

The shared table brings a concurrency trap. Each open file has a **file position**, the offset
where the next `read` starts; `read` uses it and moves it forward, and `lseek` sets it. That
position is shared by every thread using the fd. Disks are read in **sectors**, fixed-size
blocks (512 bytes is the classic size). If one thread calls `lseek` to sector 10 and another
seeks to sector 20 before the first reads, the first thread reads the wrong sector. **`pread`** and **`pwrite`** take the offset as an argument and leave the shared position
alone, so threads cannot disturb each other. Rust exposes them as `read_at` and `write_at`.

`fds.rs`:

```rust
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;

fn main() -> std::io::Result<()> {
    std::fs::write("disk.img", b"0123456789abcdef")?;
    let disk = File::open("disk.img")?;
    println!("stdin=0 stdout=1 stderr=2, disk.img={}", disk.as_raw_fd());
    let mut sector = [0u8; 4];
    // pread: the offset travels with the call, not in the shared file position.
    disk.read_at(&mut sector, 12)?;
    println!("bytes at offset 12: {}", String::from_utf8_lossy(&sector));
    Ok(())
}
```

```text
stdin=0 stdout=1 stderr=2, disk.img=3
bytes at offset 12: cdef
```

Three more fd facts, because macvmm's file handling leans on them:

- **`O_CLOEXEC`** is an `open` flag meaning "close this fd automatically on `exec`". `exec` is
  the system call that replaces the running program with another one (how a shell starts a
  command). Without the flag, the new program inherits every open fd, a guest's disk image
  included. Rust's standard library sets it on every fd it opens.
- **File modes** are the permission bits on a file: for the owner, the group and everyone else,
  may they read, write, execute? They are written in octal (base 8, hence the leading `0`), one
  digit per class, each digit a sum of read = 4, write = 2, execute = 1. So `0600` is owner 6 =
  4 + 2 (read and write), group 0, others 0. `0700` on a directory is owner 7 = 4 + 2 + 1, which
  for a directory means only the owner can list or enter it. macvmm creates its sockets and log
  files this way so that other users on the Mac cannot read or drive them.
- The **`umask`** is a per-process mask of permission bits to *remove* from every new file. A
  program asks for `0666` (read and write for all three classes); the usual umask `022` removes
  write (2) from group and others, digit by digit: 6 - 0 = 6, 6 - 2 = 4, 6 - 2 = 4, so the file
  gets `0644`. With `077`, it gets `0600`:

```sh
sh -c 'umask 077 && cd "$(mktemp -d)" && touch f && ls -l f | cut -c1-10'
```

```text
-rw-------
```

The umask is process-wide, shared by all threads, like the fd table. The `block-storage`,
[`unix-sockets`](/build-your-own/vmm/primers/unix-sockets/) and [`macos-sandbox`](/build-your-own/vmm/primers/macos-sandbox/) primers take these further.

## What the compiler proves, and what is left to you

Back to the opening. The C counter lost updates because two threads raced on plain memory, and
Rust refused that program because exclusive `&mut`, `Send` and `Sync` make data races impossible
in safe code. The deadlock compiled because it contains no data race: it is a wrong *order of
waiting*, and no type says anything about order.

| Bug | Caught by the compiler in safe Rust? | Your defence |
|---|---|---|
| Data race on plain memory | Yes (E0499, E0277 and friends) | Nothing to do |
| Lost update split across two lock sections | No | Do the whole read-modify-write under one guard |
| Lost wake-up, spurious wake-up | No | State in the mutex; wait in a predicate loop |
| Deadlock | No | One fixed lock order; no lock across blocking calls |
| Starvation, a thread blocked by a slow peer | No | Bound every wait; never wait on the guest under a lock |
| Wrong `Ordering` on atomics | No (it is safe, and wrong) | `SeqCst` until `memory-ordering` says otherwise |

The second row deserves a sentence: `let v = *m.lock().unwrap(); *m.lock().unwrap() = v + 1;`
compiles, has no data race, and loses updates exactly like `race.c`, because another thread can
run between the two guards. Safe Rust makes each access safe; making the *operation* atomic is
still your design.

> **Production note.** Large VMMs such as Firecracker and crosvm use the same toolkit you have
> met (threads, `Arc<Mutex<_>>`, channels, atomic flags, event fds) plus a documented lock order.
> Some go further and avoid locks on hot paths with per-thread ownership or lock-free queues.
> macvmm keeps one mutex per device and one written order: slower in theory, easy to reason
> about, and fast enough, because a VM exit costs far more than an uncontended lock.

## Self-check

:::predict Name two things each thread has to itself and two things all threads of a process share.
Each thread has its own registers (including `pc` and `sp`) and its own stack. All threads share
the process's memory (globals and heap) and its file-descriptor table (also the umask and the
current directory). HVF stores a vCPU's state with the creating thread's kernel-side state (like
its registers, a per-thread thing), which is why only that thread may run it.
:::

:::predict A thread runs `loop {}` and never calls the kernel. On a one-core machine, does any other thread ever run? What would `/usr/bin/time -l` show growing?
Yes. A hardware timer interrupts the core periodically, the kernel's scheduler runs, and it may
switch to another ready thread. That is timer-driven preemption, and it shows up as
"involuntary context switches".
:::

:::predict Two threads each run `let v = *m.lock().unwrap(); *m.lock().unwrap() = v + 1;` a million times on a shared `Mutex<u64>`. Does it compile? Is the final value 2,000,000?
It compiles: there is no data race, every access is under the lock. The final value can be lower,
because the read and the write are two separate critical sections and the other thread can update
the value in between. Hold one guard for the whole read-modify-write.
:::

:::predict A thread does `let g = m.lock().unwrap(); let g = cv.wait(g).unwrap();` with no loop, and another thread sets the state and calls `notify_one()`. Name two ways this goes wrong.
A lost wake-up: if the notify happened before the wait, nobody rings again and the waiter sleeps
forever. A spurious wake-up: the waiter can return from `wait` with the state unchanged and carry
on as if it had changed. Both are fixed by `while !state { g = cv.wait(g).unwrap(); }` or
`wait_while`.
:::

:::predict Thread 1 takes locks A then B. Thread 2 takes B then C. Thread 3 takes C then A. Can this deadlock? What single rule removes the risk?
Yes: 1 holds A wants B, 2 holds B wants C, 3 holds C wants A, a cycle. Number the locks and always
take them in increasing order (A, B, C). Thread 3 then takes A before C, and no cycle can form.
:::

:::predict Two threads share one fd for a disk image. Each wants to read a different 512-byte sector. Why is `read_at` (`pread`) safer than `seek` followed by `read`?
The fd's position is shared by all threads, so one thread's `seek` can be overwritten by the
other's before its `read`, and it reads the wrong sector. `pread` passes the offset in the call
and does not use or change the shared position.
:::

## Lab

:::lab lock-order

In the `lock-order` lab you are the scheduler. Two threads, each with a short script of
`lock` and `unlock` steps on two mutexes, sit side by side; you click which thread takes its next
step, and the lab shows who holds what and who is waiting. Step them into the deadlock, see the
wait-for cycle drawn, then reorder one thread's script and try to deadlock it again (you can't).
A second mode swaps the mutexes for a condvar: you choose when the notify happens, and the lab
shows how a wait without a predicate loop sleeps forever after a notify that came too early.

## Where this shows up in macvmm

- [Chapter 02, first-exit](/build-your-own/vmm/bare-machine/first-exit/): the first vCPU is
  created on, and must be run from, the thread that created it.
- [Chapter 09, mmio-pl011](/build-your-own/vmm/devices/mmio-pl011/) (requires this primer): the
  stdin reader thread, the devices behind `Arc<Mutex<dyn MmioDevice>>` on the bus
  (`crates/vmm/src/bus.rs`), the fixed order in which those locks are taken, the stdin thread that
  drops input rather than wait for the guest, the control thread's event channel, and
  the `AtomicBool` stop flag in `crates/vmm/src/control.rs`, set from the signal path and read by
  the vCPU loop.
- [Chapter 11, timer-irq](/build-your-own/vmm/interrupts/timer-irq/): preemption from the inside,
  and a vCPU that sleeps on a condvar when the guest executes `WFI`.
- [Chapter 17, virtio-rng-console](/build-your-own/vmm/virtio/virtio-rng-console/): device
  worker threads woken by a condvar, and joined at stop; the disk worker that does its I/O under
  the device lock, and why that wait is bounded.
- [Chapter 20, smp](/build-your-own/vmm/smp/smp/): one host thread per vCPU, secondary vCPUs
  parked on a condvar until the guest's `CPU_ON` call, `hv_vcpus_exit` kicks at stop, and
  the lock order applied across bus, device and vCPU state.
- [Chapter 26, snapshots](/build-your-own/vmm/production/snapshots/): pausing every thread at a
  safe point before saving state.

## Checkpoint

:::checkpoint

- **What you can do now.** Explain the lost update in `race.c` and why `race.rs` does not
  compile; get `2000000` from `locked.rs` every time; produce and diagnose the deadlock with
  `sample`, then fix it with an order. Confirm the fd facts with
  `sh -c 'umask 077 && cd "$(mktemp -d)" && touch f && ls -l f | cut -c1-10'`, which prints
  `-rw-------`.
- **What's next.** Chapter 09 gives macvmm its second real thread: a reader that turns your
  keystrokes into bytes for the guest's UART while a vCPU thread is in the middle of an MMIO
  access to the same device. You now have every tool it uses; the chapter is about choosing where
  each lock goes.
- **One open question.** Our stop flag works because every vCPU checks it between trips into the
  guest. What if a thread is blocked somewhere that never checks a flag, say in a `read` on a pipe
  nobody will ever write to? How would you wake it, and what does that suggest about which calls a
  VMM thread should be allowed to block in? (Hint: look again at when `recv` returns an error,
  and at what a deadline such as `recv_timeout` or `wait_timeout` buys you.)

## Going further

- Rust standard library documentation, module `std::sync` and the pages for `Mutex` (guards and
  poisoning), `Condvar` (spurious wake-ups, `wait_while`), `mpsc`, `atomic` and
  `std::thread::scope`; and the Rustonomicon chapter "Send and Sync".
- Mara Bos, *Rust Atomics and Locks* (O'Reilly, 2023), chapters 1 to 3: threads, locks and
  condition variables, then atomics and memory ordering, written for exactly this audience.
- IEEE Std 1003.1-2017 (POSIX), `pthread_cond_wait` (the rationale for spurious wake-ups and the
  predicate loop) and `pread`; on your Mac, `man 2 pread`, `man 2 open` (`O_CLOEXEC`),
  `man 2 umask`, `man 1 sample` and `man 8 lsof`.
- Hypervisor.framework, `hv_vcpu.h` in the macOS SDK: the "owning thread" rule on nearly every
  vCPU call, and `hv_vcpus_exit`, which takes a list of vCPUs and is meant to be called from
  another thread (if a vCPU is not running, its next `hv_vcpu_run` returns at once).
