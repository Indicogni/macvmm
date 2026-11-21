---
title: Unix signals: who decides how a program ends
slug: unix-signals
kind: primer
minutes: 15
required_by: [09]
labs: []
runs: mac
command: zsh -c 'sleep 30 & kill -TERM $!; wait $!; echo $?'
expect: 143
---

# Why does macvmm say 130 when you sent it 15?

Start `sleep` in the background, send it SIGTERM, and ask how it ended:

```sh
zsh -c 'sleep 30 & kill -TERM $!; wait $!; echo $?'
```

```text
143
```

macvmm is the virtual machine monitor this course builds: an ordinary Mac program that runs a
guest operating system. From chapter 09 on it owns your terminal while the guest runs. Send *it*
the same SIGTERM and the answer is `130`, with `user quit` on stderr and your terminal restored.
Same signal, different number, and macvmm got to tidy up before it went. Stranger still: run
that `sleep` again but send SIGINT (`kill -INT`) instead, and the command takes the full 30
seconds and prints `0`, as if nothing was sent at all.

So there are three numbers to explain: **143** (in "The shell's arithmetic"), **130** (later in
that section) and **0** (in "Choosing a disposition"). After that you build the small, slightly
odd mechanism macvmm uses so that a signal never catches it off guard.

:::objectives
- Say what a signal is, the default action of the signals macvmm meets, and which two no program can catch.
- Predict the exit status `128 + n`, and tell death by signal apart from a chosen exit status.
- Predict which thread runs a signal handler, and check it with a short C program.
- Explain async-signal safety, and why a handler saves `errno`.
- Build the self-pipe trick, and trace it through macvmm's signal thread.
:::

:::prereqs
The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer (processes, the kernel, exit statuses and `$?`) and the [`host-concurrency`](/build-your-own/vmm/primers/host-concurrency/)
primer (threads, file descriptors, pipes). You need a Mac with Terminal and `clang` (from the
Xcode command line tools); nothing else to install.
:::

## A tap on the shoulder from the kernel

Most of what a program learns about the world, it asks for: it calls `read` and waits for bytes.
Some news cannot wait to be asked for. The user wants the program to stop. The program touched
memory that does not exist. A child process it started has ended. The terminal it was talking
to has been closed. For these, the kernel interrupts the program, wherever it is, and tells it.

That interruption is called a **signal**: a small number the kernel delivers to a process, not
in reply to anything the process asked. Each number has a name. The ones this course meets are:

| Signal | Number on macOS | Usually sent by | Default action |
|---|---|---|---|
| SIGHUP | 1 | the kernel, when a terminal closes | terminate |
| SIGINT | 2 | the terminal, when you press Ctrl-C | terminate |
| SIGKILL | 9 | `kill -9` | terminate (cannot be caught) |
| SIGSEGV | 11 | the kernel, when a program touches an address it has no memory at | terminate and dump core |
| SIGTERM | 15 | `kill` with no option; shutdown | terminate |
| SIGSTOP | 17 | `kill -STOP` | stop (cannot be caught) |
| SIGCHLD | 20 | the kernel, when a child ends | ignore |
| SIGUSR1 | 30 | whoever you like | terminate |

"Dump core" means the kernel may also save a snapshot of the dying process's memory, a **core
file**, for a debugger to examine later; macOS has this switched off by default, so in practice
it just terminates. SIGSTOP and SIGCHLD are here for contrast: SIGSTOP is the second signal that
cannot be caught (below), and SIGCHLD shows that not every default is "terminate". macvmm itself
handles only SIGINT, SIGTERM, SIGHUP and SIGUSR1.

Ask your own Mac for the numbers; they differ between systems (SIGUSR1 is 10 on Linux):

```sh
kill -l USR1
kill -l TERM
```

```text
30
15
```

The last column is the **default action**: what happens if the program has said nothing about
that signal. For most signals the default is to end the process on the spot, with no cleanup, no
flushing of output buffers, no last words. A program can instead ask for one of two other
**dispositions**: ignore the signal, or run a function of its own, called a **signal handler**,
when the signal arrives. Installing a handler is called **catching** the signal.

Two signals refuse all of this. SIGKILL always ends the process and SIGSTOP always freezes it;
the kernel does not let a program catch, ignore or block either one. They are the operator's
guarantee that any process can be stopped, however buggy or hostile.

SIGUSR1 (and its twin SIGUSR2) mean nothing to the kernel at all. They exist so that programs can
define their own meaning. Remember that one; macvmm gives it a job.

> **Aside.** `kill` is a terrible name for a program that sends any signal, including ones that
> mean "please print your status". It dates from when ending a process was the only thing you
> could ask for. The system call behind it, `kill(2)`, kept the name too.

## The shell's arithmetic: 128 + n

First, the shell notation in these one-liners. `&` starts a command in the background, and `$!`
is the process id (pid) of the last background job, so `kill -TERM $!` signals that `sleep`.
`wait $!` waits for it to end, and `echo $?` prints how it ended. Inside a script, `$$` is the
script's own pid. The outer `zsh -c '…'` just runs the line in a fresh zsh, so it behaves the
same whatever shell you typed it into.

When a process ends, its parent (the process that started it) collects a **wait status** by
calling `waitpid(2)`, the system call that waits for a child to end. The status carries
one of two stories: "it called `exit` with this code", or "it was ended by this signal". The
parent can tell which with the macros `WIFEXITED` and `WIFSIGNALED`, and read the code or the
signal number with `WEXITSTATUS` and `WTERMSIG`.

The shell has to squeeze both stories into one number, `$?`. POSIX's rule (XCU §2.8.2, "Exit
Status for Commands") is that a command killed by a signal reports a status greater than 128,
and every common shell uses exactly **128 + the signal number**. Check it:

```sh
zsh -c 'sleep 30 & kill -USR1 $!; wait $!; echo $?'
zsh -c 'sleep 30 & kill -KILL $!; wait $!; echo $?'
```

```text
158
137
```

158 is 128 + 30 (SIGUSR1) and 137 is 128 + 9 (SIGKILL). The opening 143 is 128 + 15 (SIGTERM),
and the 130 you see after pressing Ctrl-C on a foreground `sleep` is 128 + 2 (SIGINT). The
`os-basics` primer's segmentation fault, 139, is 128 + 11.

Now the twist. The shell's `$?` cannot tell "killed by SIGINT" from "chose to exit with 130":

```sh
zsh -c "sh -c 'kill -INT \$\$'; echo \$?"
zsh -c "sh -c 'exit 130'; echo \$?"
```

```text
130
130
```

Each line starts a small `sh` script inside zsh; the `\$` is only there so that zsh passes a
literal `$` through to `sh` instead of expanding it itself. The first `sh` sends SIGINT to its
own pid (`$$`) and dies of it. The second calls `exit(130)`. The shell
prints the same number for both; only the parent's `waitpid` status knows the difference. That
is the first part of the opening puzzle solved. macvmm *catches* SIGTERM, restores your
terminal, and then calls `exit(130)`. It picks 130 on purpose: it is what scripts and humans
already read as "the user interrupted this", and macvmm uses it for every user quit, whether it
came from Ctrl-C, SIGTERM, SIGHUP or the Ctrl-A x key. Its own error codes stay below 128 so
they can never be mistaken for a signal.

:::predict A shell runs a program that dies of SIGHUP. What is `$?`?
129: 128 + 1. On a terminal that closes, every program still attached to it typically sees that
number, which is why it is worth recognising.
:::

## Choosing a disposition

A shell script can change dispositions with `trap`. Catch SIGTERM, do something, and choose your
own exit status:

```sh
zsh -c "sh -c 'trap \"echo caught TERM; exit 7\" TERM; kill -TERM \$\$; echo after'; echo \$?"
```

```text
caught TERM
7
```

The handler ran instead of the default action, and the program decided how it ended; `after`
never printed because the handler called `exit`. An empty `trap` sets the disposition to
"ignore":

```sh
zsh -c "sh -c 'trap \"\" TERM; kill -TERM \$\$; echo survived'; echo \$?"
```

```text
survived
0
```

That explains the last number of the opening puzzle. Here it is side by side with the SIGTERM
version (the second line really does take 30 seconds):

```sh
zsh -c 'sleep 30 & kill -TERM $!; wait $!; echo $?'
zsh -c 'sleep 30 & kill -INT $!; wait $!; echo $?'
```

```text
143
0
```

A **non-interactive** shell, one running a script or a `-c` command rather than reading what
you type, starts background jobs (`&`) with SIGINT and SIGQUIT set to "ignore". That way,
pressing Ctrl-C at the terminal interrupts the foreground command and not every job running
behind it (POSIX XCU §2.11, "Signals and Error Handling"). To run `sleep`, the shell first
copies itself (`fork`) and then the copy calls `exec`, which replaces the program running in
that process with a new one while keeping the same process. An ignored disposition survives
`exec`, so `sleep` inherits it, shrugs off your `kill -INT`, sleeps the full 30 seconds and
exits 0. A *handler* cannot survive `exec`, because the new program's code replaces the
function it pointed at; the kernel resets caught signals to their default action.

In C (and in Rust, through the `libc` crate) the call that sets a disposition is `sigaction(2)`.
You fill a `struct sigaction` with the handler's address, a set of signals to block while it
runs, and some flags, then hand it to the kernel. The older `signal(3)` does the same in one line
but with less control; macvmm uses `sigaction`.

> **Under the hood (optional).** Rust programs are not born with default dispositions
> everywhere. SIGPIPE is the signal the kernel sends when a program writes to a pipe whose
> reading end has been closed; its default is to terminate. Before `main` runs, Rust's standard
> library sets it to "ignore", so the write just fails with the error code `EPIPE` instead
> (macvmm relies on this: a dead stdout becomes an error it can handle). Rust also catches
> SIGSEGV and its cousin SIGBUS, so that a thread that runs off the end of its stack prints
> "thread has overflowed its stack" rather than dying silently.

## Which thread hears it?

A process with one thread has one place for a handler to run. macvmm has many threads: one per
**vCPU** (a virtual processor; each of these threads runs the guest's code for one of the
guest's CPUs), one that reads your keyboard, and a few that do device work in the background.
When a signal arrives for the *process*, which of them is interrupted?

POSIX (XSH §2.4.1, "Signal Generation and Delivery") gives three rules:

1. A signal caused by a thread's own action, such as SIGSEGV from that thread's bad memory
   access, goes to **that thread**. These are **synchronous** signals: they happen at a known
   instruction, because of it.
2. A signal sent to one particular thread with `pthread_kill(2)` goes to that thread. Programs
   use this when one thread needs to interrupt another specific thread.
3. A signal sent to the whole process, with `kill(2)`, from the terminal or from another
   program, goes to **exactly one thread that does not block it**, and which one is unspecified.
   These are **asynchronous** signals: they come from outside, at no particular instruction.

"Block" is the last piece of vocabulary. Each thread has a **signal mask**: a set of signals it
refuses for now. A blocked signal is not lost; it stays **pending** until some thread unblocks
it. You change your own thread's mask with `pthread_sigmask(2)`, and a new thread starts with a
copy of its creator's mask.

Let's watch rule 3 on your Mac. The handler prints the name of the thread it interrupts. The
name lives in a `_Thread_local` variable: every thread gets its own copy, so the worker can set
its copy to `"worker"` while `main`'s stays `"main"`. `pause()` simply sleeps until a signal
handler has run, so the worker does nothing but wait to be interrupted.

`who.c` (part 1 of 2):

```c
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

static _Thread_local const char *me = "main";

static void on_usr1(int sig) {
    (void)sig;
    write(1, me, strlen(me));   /* write(2) is async-signal-safe */
    write(1, "\n", 1);
}

static void *worker(void *arg) {
    (void)arg;
    me = "worker";
    for (;;) pause();
}
```

`who.c` (part 2 of 2, appended to the same file): `main` starts a worker, optionally blocks
SIGUSR1 in itself, then sends SIGUSR1 to its own process three times.

```c
int main(int argc, char **argv) {
    (void)argv;
    struct sigaction sa = { .sa_handler = on_usr1 };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGUSR1, &sa, NULL);  /* catch SIGUSR1 */
    pthread_t t;
    pthread_create(&t, NULL, worker, NULL);
    if (argc > 1) {             /* "./who block": main refuses SIGUSR1 */
        sigset_t s;
        sigemptyset(&s);
        sigaddset(&s, SIGUSR1);
        pthread_sigmask(SIG_BLOCK, &s, NULL);
    }
    for (int i = 0; i < 3; i++) {
        sleep(1);
        kill(getpid(), SIGUSR1);  /* to the process, not a thread */
    }
    sleep(1);
    return 0;
}
```

:::predict Which name does `./who` print? And `./who block`?
Without blocking, either thread may get the signal; on this macOS version the kernel chose `main` every time. With `block`, `main` has SIGUSR1 blocked, so the worker is the only candidate and gets every one.
:::

```sh
clang -Wall -o who who.c
./who
```

```text
main
main
main
```

```sh
./who block
```

```text
worker
worker
worker
```

On this macOS version, with both threads willing, the kernel chose `main` every time. That is an
observation, not a promise: POSIX says "one thread", and your program must be correct whichever
one it is. Once `main` blocks SIGUSR1, the worker is the only candidate, and it gets every one.

> **Try it.** Move the `pthread_sigmask` block above `pthread_create` and run `./who block`
> again. Nothing prints at all (we checked on macOS 27): the worker inherited the blocked mask,
> so no thread will take SIGUSR1 and the signals stay pending until the program exits. This is the standard way to
> keep a signal off every thread: block it in `main` before spawning anything.

## A handler can interrupt anything

Here is the uncomfortable truth about handlers. The kernel stops the chosen thread between two
instructions, any two, and runs your function on that thread's stack. The interrupted code might
be halfway through `malloc`, the function that hands out memory. `malloc` takes a **lock** (a
flag that says "I am using this; everyone else wait") so that two threads cannot edit its list
of free memory at once, and that list may be half updated. Or the interrupted code might be
inside `printf`, holding the lock on `stdout`'s buffer.

Suppose your handler calls `printf`, or Rust's `println!` (which locks stdout and may allocate).
The handler now waits for a lock that its own thread holds, and that thread cannot release it
until the handler returns. Two parties each waiting for the other forever is a **deadlock**;
here it happens with only one thread. Or the function does not lock at
all and walks a data structure that is half rewritten. Either way the bug appears once in ten
thousand runs, at the worst moment.

The way out is a short list. POSIX names the functions that are safe to call from a handler,
because they are written to be re-entered at any instant: they take no locks and touch no shared
state that a half-finished call could leave inconsistent. Such a function is
**async-signal-safe**. The full list is in POSIX.1-2017 XSH §2.4.3, "Signal Actions". `man 2
sigaction` on your Mac prints an older, shorter version of it (plus a few macOS extras such as
`strlcpy`); every function in the left column below is on both.

| Async-signal-safe (on the list) | Not safe (not on the list) |
|---|---|
| `write`, `read` | `printf`, `fprintf`, `puts` |
| `_exit` (end the process now) | `exit` (it runs `atexit` handlers and flushes stdio) |
| `kill`, `raise`, `sigaction` | `malloc`, `free` |
| `tcsetattr` (change terminal settings) | `pthread_mutex_lock` (take a lock) |

`exit` is the polite way to end: first it runs the cleanup functions the program registered with
`atexit` and flushes buffered `printf` output, all of which may take locks. `_exit` skips all of
that and ends the process immediately, which is why only `_exit` is safe in a handler.

Rust adds its own entries to the "not safe" column: anything that allocates (`String`, `Vec`,
`format!`), anything that locks (`println!`, `Mutex`), and panicking. In practice a Rust signal
handler may touch atomics and call a few `libc` functions, nothing else.

There is one more trap, and it is subtle. Many system calls report failure by setting the
thread-local variable `errno`. Picture the interrupted code: `read` has failed and set `errno` to
`EAGAIN`, and the very next instruction would read it. The signal lands in between, and your
handler calls `write`, which succeeds or fails and may overwrite `errno`. The interrupted code
resumes and reads the wrong error. So a careful handler **saves `errno` on entry and restores it
on exit**.

> **Security.** A signal can come from any process running as you, at any time, as often as it
> likes. Treat it like guest input: the handler must stay correct if a signal arrives during
> startup, during shutdown, twice in a row, or a thousand times a second. A handler that only
> writes one byte to a non-blocking pipe has almost nothing to get wrong.

## The self-pipe trick

So a handler can do almost nothing. But macvmm, on SIGTERM, has a lot to do: tell every vCPU to
stop, wait for device workers, drain output, put the terminal back to normal, print a message.
(While a guest runs, macvmm puts your terminal in **raw mode**: every key goes straight to the
program, no echo, no Ctrl-C. The [`tty-termios`](/build-your-own/vmm/primers/tty-termios/) primer explains it; here you only need to know
that it must be undone before macvmm exits.)
How do you do a lot of work in response to an event during which you may do almost nothing?

You postpone it. The handler writes one byte, the signal number, into a pipe that the program
created for itself. An ordinary thread sits in a blocking `read` on the other end of that pipe.
When the byte arrives, that thread wakes up as if it had received any other message, and it runs
with no restrictions: it can lock, allocate and print. The signal has become an ordinary event.
This is the **self-pipe trick**, named and popularised by D. J. Bernstein.

The diagram shows the hand-off. Notice that the only work inside the handler is a single `write`.

:::diagram src=docs/diagrams/self-pipe.svg alt="The self-pipe pattern: the handler only writes a byte"

*The handler only writes; everything that could deadlock happens on the signal thread.*

Here it is in C. First the handler: one byte, `errno` preserved.

`selfpipe.c` (part 1 of 2):

```c
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <unistd.h>

static int wfd = -1;

static void on_signal(int sig) {
    int saved = errno;          /* the code we interrupted may need it */
    unsigned char b = (unsigned char)sig;
    (void)write(wfd, &b, 1);    /* one byte; never blocks */
    errno = saved;
}
```

Then the setup and the waiting side. `pipe(p)` creates the pipe and fills in two file
descriptors: `p[0]` is the **read end** and `p[1]` the **write end**; bytes written to `p[1]`
come out of `p[0]`. A `read` on an empty pipe normally **blocks** (sleeps until a byte arrives),
and that is exactly what we want on the reading side.

The write end, though, is made **non-blocking** with `fcntl(... O_NONBLOCK)`. A pipe holds only
a few kilobytes; if it were ever full, a normal `write` would sleep until someone read from it,
and sleeping inside a handler can hang the program forever. A non-blocking `write` fails at once
instead, and the handler ignores the failure: a full pipe already has bytes the reader has not
yet seen, so the reader is going to wake up anyway.

`SA_RESTART` handles a side effect. When a signal interrupts a slow system call such as `read`,
the call can give up and return -1 with `errno` set to `EINTR` ("interrupted system call").
`SA_RESTART` asks the kernel to resume the call instead. The `while (read(...) != 1) { }` loop is
a second line of defence: if `read` returns anything other than one byte, it simply tries again.

`selfpipe.c` (part 2 of 2, appended to the same file):

```c
int main(void) {
    int p[2];
    pipe(p);
    fcntl(p[1], F_SETFL, O_NONBLOCK);
    wfd = p[1];
    struct sigaction sa = { .sa_handler = on_signal, .sa_flags = SA_RESTART };
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    printf("pid %d: waiting\n", getpid());
    fflush(stdout);
    unsigned char b;
    while (read(p[0], &b, 1) != 1) { }
    printf("got signal %d; cleaning up\n", b);   /* ordinary code: anything goes */
    return 130;
}
```

Run it in the background, send it SIGTERM after a second, and collect its status:

```sh
clang -Wall -o selfpipe selfpipe.c
zsh -c './selfpipe & p=$!; sleep 1; kill -TERM $p; wait $p; echo "exit $?"'
```

```text
pid 30131: waiting
got signal 15; cleaning up
exit 130
```

The pid will differ. Compare with the opening: the same SIGTERM that made `sleep` report 143 now
produces a cleanup message and the exit status we chose. You have reproduced macvmm's behaviour in
thirty lines.

Notice also what the handler does *not* care about: which thread runs it. Whether the kernel
interrupts `main`, a worker or anything else, the byte lands in the same pipe and the same
reading thread wakes. The self-pipe trick makes rule 3's "unspecified" harmless.

> **Production note.** Linux has `signalfd(2)`, which delivers signals as reads from a file
> descriptor with no handler at all; macOS does not. macOS has `kqueue(2)` with `EVFILT_SIGNAL`,
> which reports signals as kqueue events (you still set the disposition to ignore or block it).
> Another common design blocks the signals in every thread and has one thread call `sigwait(2)`.
> macvmm uses the self-pipe because it is portable, needs no masks to be set before every thread
> is spawned, and is easy to read in a lesson.

## How macvmm uses all this

A quick reminder of the setting: macvmm runs a **virtual machine** (VM), a pretend computer
whose processors, memory and devices macvmm provides, and inside it a **guest** operating
system such as Linux (the course introduction tells the full story). Every so often the guest
does something macvmm must handle, such as touching a device; each such hand-over is a **VM
exit**, and macvmm keeps a short log of recent ones for debugging.

macvmm routes four signals through one self-pipe, and gives each a meaning:

| Signal | Where it comes from in practice | What macvmm does |
|---|---|---|
| SIGINT | `kill -INT`, or Ctrl-C when stdin is not a raw-mode terminal | quit the VM, exit 130 |
| SIGTERM | `kill`, a test harness, a supervisor | quit the VM, exit 130 |
| SIGHUP | the terminal window closed | quit the VM, exit 130 |
| SIGUSR1 | `kill -USR1 <pid>`, when you want to know what the VM is doing | print the recent VM exits, keep running |

Two details are worth noticing. First, in raw mode the terminal no longer turns Ctrl-C into
SIGINT. (That translation is done by the kernel's terminal layer, the **line discipline**,
which raw mode switches off.) Ctrl-C then reaches the *guest* as the byte 0x03, and you quit
macvmm by typing Ctrl-A and then x instead; the `tty-termios` primer has that story. SIGINT still
matters, because a script, a CI job or `kill` can send it.

Second, a quit is a request, not a guarantee. On the first quit signal, the signal thread asks
the VM to stop and goes back to its `read`. Normally the VM stops, the terminal is restored and
macvmm exits 130. But the VM might fail to stop, through a bug or a thread stuck writing to a
terminal that has gone away. So if a **second** quit signal arrives first, the signal thread:

1. restores the terminal, using only calls that take no locks;
2. writes a short message with a plain `write`;
3. leaves with `_exit(130)`, skipping `atexit` handlers and stdio flushing, because a stuck
   thread might be holding exactly those locks.

So you are never left with a raw terminal and a VM that only SIGKILL can stop.

> **Aside: recovering a terminal.** SIGKILL is the one case no program can clean up after. If a
> program dies that way while the terminal is in raw mode, typing may show nothing and Enter may
> do nothing. Type `stty sane` blind and press **Ctrl-J**. `stty sane` resets the terminal
> settings to sensible defaults. Ctrl-J sends the newline character directly, whereas Enter
> sends a carriage return, which only counts as "end of line" when the setting that translates it
> (one of those raw mode turned off) is on.

The code lives in two places. The handler, the pipe and the `sigaction` calls are in the `hvf`
crate's host module (`crates/hvf/src/host.rs`, `SignalPipe`), because that is where the project
allows `unsafe`. The thread that reads the pipe and decides what each signal means is in
`crates/macvmm/src/signals.rs`, which contains no `unsafe` at all. Chapter 09 walks through both.

## Self-check

Commit to an answer before you reveal it.

:::predict A program has no handlers. `kill -HUP` ends it. What does the shell print for `$?`, and what would `waitpid`'s `WIFSIGNALED` say?
`129`, which is 128 + 1. `WIFSIGNALED` is true and `WTERMSIG` is 1: the process died of the
signal and never called `exit`.
:::

:::predict macvmm is running a guest. You send it `kill -TERM`. What does `$?` show, and does `WIFSIGNALED` agree with the shell's guess?
`130`, and no: `WIFEXITED` is true with exit status 130. macvmm caught SIGTERM, cleaned up and
chose 130 as its "user quit" code. `$?` cannot tell the two stories apart; the wait status can.
:::

:::predict You run `kill -9` on macvmm while it has the terminal in raw mode. What is `$?`, and what state is your terminal in?
`137` (128 + 9). SIGKILL cannot be caught, so no handler ran, no cleanup ran, and the terminal
may still be in raw mode: what you type does not appear, and Enter may not work. The
"Recovering a terminal" note above says how to repair it.
:::

:::predict A process has a vCPU thread, a stdin thread and a signal thread, and none of them blocks SIGTERM. You send SIGTERM to the process. Which thread runs the handler? Which thread does the cleanup?
Any one of them may run the handler: POSIX leaves the choice to the kernel for a process-directed
signal. It does not matter, because the handler only writes a byte to the pipe. The cleanup
always happens on the signal thread, which is the one reading the pipe.
:::

:::predict A thread dereferences a bad pointer and gets SIGSEGV. Can the kernel deliver that signal to a different thread?
No. A signal caused by a thread's own instruction is synchronous and goes to that thread (XSH
§2.4.1), because only that thread can do anything sensible about it.
:::

:::predict A colleague "improves" the handler to call `eprintln!("got signal {sig}")` before writing to the pipe. Tests pass. What can go wrong, and when?
`eprintln!` locks stderr and formats with machinery that may allocate; neither is
async-signal-safe. If the signal interrupts a thread that is inside a stderr write or inside the
allocator, the handler can deadlock on a lock its own thread holds, or corrupt state. It shows up
rarely, typically under load, which is exactly when someone presses Ctrl-C.
:::

## Where this shows up in macvmm

- [Chapter 09, mmio-pl011](/build-your-own/vmm/devices/mmio-pl011/) (requires this primer):
  `hvf::host::SignalPipe` and `crates/macvmm/src/signals.rs` are built here, together with the
  `AtomicBool` stop flag in `control.rs` that the signal thread's quit request sets and every
  vCPU loop reads. Its checkpoint sends SIGTERM to a running guest and expects
  `[stderr] user quit` and exit **130**.
- [Chapter 14, linux-boot](/build-your-own/vmm/linux/linux-boot/): SIGUSR1 (and Ctrl-A t) dump
  the ring of recent VM exits while Linux keeps running, and the `linux_sigint` test sends SIGINT
  at the shell prompt and expects exit 130 within 2 seconds.
- [Chapter 26, snapshots](/build-your-own/vmm/production/snapshots/): pausing a VM to save it uses
  the same "ask every thread to stop, then wait" path a quit signal does.

## Going further

- POSIX.1-2017 (The Open Group Base Specifications, Issue 7), XSH §2.4 "Signal Concepts":
  §2.4.1 "Signal Generation and Delivery" (pending, blocked, which thread), §2.4.2 "Realtime
  Signal Generation and Delivery", and §2.4.3 "Signal Actions" (default actions and the full
  list of async-signal-safe functions). XCU §2.8.2 "Exit Status for Commands" for the "greater
  than 128" rule.
- On your Mac: `man 2 sigaction`, `man 2 kill`, `man 3 signal` (the table of default actions
  with macOS numbers), `man 2 sigprocmask`, `man 2 pthread_sigmask`, `man 2 waitpid` (the
  `WIFSIGNALED` family) and `man 2 kqueue` (`EVFILT_SIGNAL`).
- D. J. Bernstein's description of the self-pipe trick, and the "Signals" chapter (20 to 22) of
  Michael Kerrisk, *The Linux Programming Interface*, which covers handlers, masks, reentrancy
  and `errno` in depth (Linux-specific parts are clearly marked).

## Checkpoint

:::checkpoint

- **What you can do now.** Run
  `zsh -c 'sleep 30 & kill -TERM $!; wait $!; echo $?'` and see `143`, and say why it is 143.
  You can predict the exit status for any signal, tell a death by signal from a chosen exit status,
  say which thread a signal goes to, and build a handler that does only safe work. `who.c` and
  `selfpipe.c` run on your Mac.
- **What's next.** Chapter 09 gives macvmm its first real device, a UART wired to your keyboard
  and screen. That means raw mode, a second thread, and a promise that your terminal comes back
  intact however the VM ends. The self-pipe you built here is how SIGTERM keeps that promise.
- **One open question.** macvmm's real handler (in `crates/hvf/src/host.rs`) works like
  `selfpipe.c`: if the pipe is full, its `write` fails and that signal's byte is dropped, on the
  grounds that the reader will wake up anyway. But the reader acts on the byte's *value*, the
  signal number. Suppose someone floods macvmm with SIGUSR1 until the pipe is full of SIGUSR1
  bytes, and then a SIGTERM arrives. Which byte is dropped, what does the signal thread end up
  doing, and what would the user see? (Hint: the reader eventually drains the SIGUSR1 bytes and
  waits again; does a second `kill -TERM` get through? How might you design the pipe so that
  each kind of signal can never be crowded out by another?)
