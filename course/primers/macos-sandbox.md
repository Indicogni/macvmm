---
title: The macOS sandbox, rlimits and other one-way doors
slug: macos-sandbox
kind: primer
minutes: 25
required_by: [25]
labs: []
runs: mac
command: sandbox-exec -p '(version 1)(allow default)(deny file-read* (subpath "/private/etc"))' /bin/cat /etc/hosts 2>&1
expect: cat: /etc/hosts: Operation not permitted
---

# One call, and the file is gone

Here is a small C program that does three ordinary things twice: open `/etc/hosts`, create a
network socket, and start `/usr/bin/true`. Between the two rounds it makes one function call. The
first round succeeds. In the second, the same user, the same file with the same permissions, and
the same program get `Operation not permitted` for two of the three, while the socket is still
created without complaint. No one changed a file mode, and there is no way to undo that one call.
By the end of this primer you will know what the call did, why the socket slipped through, and
why macvmm makes exactly this kind of call before it runs a single guest instruction.

:::objectives
- Write a three-line SBPL profile, run a command under it with `sandbox-exec`, and find the kernel's denial message with `log show`.
- Predict, for a `(deny default)` profile applied with `sandbox_init`, which of `open`, `socket`, `connect`, `read` on an already-open fd, and `posix_spawn` succeed, and explain the rule ("checked when a resource is acquired") that decides it.
- Name the operation classes macvmm's lockdown denies (file, network, `process-exec`, `process-fork`, `mach-lookup`, `iokit-open`) and say in one sentence what a Mach service and an IOKit user client are.
- Say which parts of the macOS sandbox are documented, which are only written in a header, and which we checked on a real Mac.
- Use `setrlimit` to make "no core dumps" irreversible, compute a file's mode from `umask`, and show with a child process what `O_CLOEXEC` changes.
- Explain why macvmm's `run` path never calls `fork` or `exec`.
:::

:::prereqs
- The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer: processes, the kernel, and what a user's rights are.
- The [`codesign-entitlements`](/build-your-own/vmm/primers/codesign-entitlements/) primer: what an entitlement is, and why it is a permission,
  not a fence.
- A Mac with the Xcode command-line tools (`cc`). This primer never needs sudo.
:::

## The experiment

You need a Mac and a C compiler: `cc` comes with the Xcode command line tools
(`xcode-select --install` if `cc --version` fails). This experiment never needs sudo.

Make an empty scratch directory outside the macvmm repo and put this file in it. The first half
is a `probe` function that tries the three operations and prints what happened. Two names may be
new: `open` returns a **file descriptor** (fd), a small integer the kernel hands back as your
handle on an open file or socket; `posix_spawn` starts another program as a child process, here
`/usr/bin/true`, which does nothing and exits. You do not need to follow every line yet. Run it,
look at the output, and the sections after it explain each piece.

`lockdown.c` (part 1 of 2)

```c
#include <errno.h>
#include <fcntl.h>
#include <sandbox.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
extern char **environ;

static const char *say(int ok) { return ok ? "ok" : strerror(errno); }

static void probe(const char *when) {
    int fd = open("/etc/hosts", O_RDONLY | O_CLOEXEC);
    printf("%s open   -> %s\n", when, say(fd >= 0));
    int s = socket(AF_INET, SOCK_STREAM, 0);
    printf("%s socket -> %s\n", when, say(s >= 0));
    pid_t pid;
    char *argv[] = {"true", NULL};
    errno = posix_spawn(&pid, "/usr/bin/true", NULL, NULL, argv, environ);
    printf("%s spawn  -> %s\n", when, say(errno == 0));
    if (fd >= 0) close(fd);
    if (s >= 0) close(s);
}
```

The second half probes, makes the one call, and probes again. The string it passes is a tiny
program in its own right; we will read it in a moment.

`lockdown.c` (part 2 of 2, appended to the same file)

```c
int main(void) {
    probe("before:");
    char *err = NULL;
    if (sandbox_init("(version 1)(deny default)", 0, &err) != 0) {
        fprintf(stderr, "sandbox_init: %s\n", err);
        return 1;
    }
    probe("after: ");
    return 0;
}
```

```sh
cc -o lockdown lockdown.c
./lockdown
```

The compiler warns once, and we will come back to that warning because it matters:

```text
lockdown.c:29:9: warning: 'sandbox_init' is deprecated: first deprecated in macOS 10.8 - No longer supported [-Wdeprecated-declarations]
```

Then the program prints this (macOS 27.2.1, M5 Pro):

```text
before: open   -> ok
before: socket -> ok
before: spawn  -> ok
after:  open   -> Operation not permitted
after:  socket -> ok
after:  spawn  -> Operation not permitted
```

`Operation not permitted` is `EPERM`, the kernel's "you may not", as opposed to `EACCES`, the
"file permissions say no" you get from `chmod 000`. Something other than file permissions is
answering now.

## Why a VMM wants to tie its own hands

Recall from [`os-basics`](../os-basics/) that a process runs with its user's rights: anything
you can open, it can open. macvmm is such a process, and it spends its life parsing bytes chosen
by the **guest**, the operating system running inside the virtual machine: MMIO writes (the guest
storing to an address where it believes a device lives, which macvmm must interpret), virtqueue
descriptors (the guest's notes saying "my data for the disk is at this address, this long"), and
disk sectors. You will build each of these in later chapters; here it is enough that the guest
chooses all of them. We write that code carefully, in
Rust, with every length checked. If a bug still slips through and a hostile guest gains control
of the macvmm process, the attacker inherits everything you can do: read your SSH keys, open a
network connection, start a shell. The hypervisor entitlement (the signed permission slip that
lets macvmm use Hypervisor.framework at all) does not help; as
[`codesign-entitlements`](../codesign-entitlements/) showed, it marks "this program uses the
hypervisor" and confines nothing.

The way out is to notice that macvmm needs most of its powers only at the start. It opens the
kernel image, the disk images and the serial output file, creates the VM, and from then on it
reads and writes descriptors it already holds. If, at that moment, it could give up the right to
open anything new, a later compromise would be stuck with what was already open. Giving up rights
you no longer need is the **principle of least privilege**, and a kernel-enforced set of
restrictions that a process places on itself is a **sandbox**.

Picture moving into a rented house and, on the first evening, handing back every key. Rooms
whose doors you already opened stay open; every other door is locked for good. Where the picture
breaks: a landlord might give keys back, and the kernel never will. A sandbox only ever narrows.

## Seatbelt: a rule check inside the kernel

On macOS, the sandbox lives in the kernel. The macOS kernel is called **XNU**. At the points where
a system call acquires a resource (looking up a path, connecting a socket, starting a program,
asking for a system service), XNU stops and asks a **policy** whether to go on. The sandbox is
one such policy. When a sandboxed process reaches one of those points, the sandbox evaluates the
process's profile, the rule list it was given, and either lets the call continue or makes it fail
with `EPERM` and writes a report to the system log. Apple's internal name for this subsystem is
**Seatbelt**.

:::diagram src=docs/diagrams/sandbox-check.svg alt="How a sandbox check happens on a file open"

*Caption: the check sits inside the kernel, on the call that acquires the resource; the process
cannot skip it.*

Two properties make it useful to us. A profile applies to the process and is inherited by every
child it starts (`man 7 sandbox`: "New processes inherit the sandbox of their parent"). And it is
one-way: once a process is sandboxed, it cannot leave. On this machine, a second `sandbox_init`
call after a restrictive first one returned `-1` with `Operation not permitted`, as the SDK header
says it should.

> **Under the hood.** The "ask a policy" points are XNU's **Mandatory Access Control** (MAC)
> framework, inherited from the TrustedBSD project. The sandbox policy is a kernel extension
> (kext, a loadable piece of kernel code), `Sandbox.kext`, that registers itself on those hooks.
> The MAC framework is open source in XNU (`security/mac_framework.h`,
> `security/mac_policy.h`); `Sandbox.kext` is not. Everything we know about how it evaluates
> profiles comes from Apple's few man pages, the profiles Apple ships, and reverse engineering
> (Blazakis, below). Treat its internals as observed behaviour, not a contract.

## SBPL: a profile is a tiny Lisp program

The string we passed, `(version 1)(deny default)`, is written in the **Sandbox Profile Language**
(SBPL), a small Scheme-like language. A profile is a list of rules. Each rule is `allow` or `deny`,
an **operation** name, and optional **filters** that narrow which resources it covers:

```text
(version 1)
(allow default)
(deny file-read* (subpath "/private/etc"))
```

Line by line: the language version (always 1); the fallback for any operation no rule mentions;
and a rule denying every file-read operation on any path under `/private/etc`. An operation name
ending in `*` covers a family: `file-read*` includes `file-read-data` and `file-read-metadata`.
The filters you will meet most are `literal` (exactly this path), `subpath` (this directory and
everything under it), `regex`, and `(param "NAME")`, which takes a value from the command line.

`sandbox-exec` is a command-line tool that applies a profile to itself and then `exec`s (replaces
itself with) the command you name, so the command runs sandboxed from its first instruction. It
takes the profile as a string with `-p`, or from a file with `-f`. Apple marks it deprecated, but
it ships with macOS 27 and works; we come back to what "deprecated" means below.

One fact first. On macOS, `/etc` is not a real directory:

```sh
ls -ld /etc
```

```text
lrwxr-xr-x  1 root  wheel  11 … /etc -> private/etc
```

It is a symbolic link to `/private/etc`. Now try a `literal` rule on the path as you would type it:

```sh
sandbox-exec -p '(version 1)(allow default)(deny file-read* (literal "/etc/hosts"))' /bin/cat /etc/hosts
```

:::predict Does the sandbox match the string you typed, `/etc/hosts`, or the path the kernel ends up at? So: does `cat` print the file, or `Operation not permitted`?
It prints the file. The sandbox matches the path the kernel actually resolves, `/private/etc/hosts`, not the string you typed.
:::

So rules on `/etc/...`,
`/tmp/...` and `/var/...` must name the `/private/...` path. With `subpath "/private/etc"` the
denial lands:

```sh
sandbox-exec -p '(version 1)(allow default)(deny file-read* (subpath "/private/etc"))' /bin/cat /etc/hosts
```

```text
cat: /etc/hosts: Operation not permitted
```

Parameters let one profile file serve many paths. Save this as `ro.sb`, load it with `-f`, and
give the parameter a value with `-D NAME=value`:

```text
(version 1)
(allow default)
(deny file-write* (subpath (param "DIR")))
```

```sh
sandbox-exec -f ro.sb -D DIR="$PWD" /usr/bin/touch "$PWD/x.txt"
```

```text
touch: /…/x.txt: Operation not permitted
```

The path in the message is your scratch directory's full path. A mistake in a profile is caught
when the profile is compiled: `(deny defualt)` makes `sandbox_init` return `-1` with
`unbound variable: defualt at <input string>, line 1, column 18` (plus a short `Backtrace:`) in
`err`. The library also prints `sandbox initialization failed: …` with the same text to stderr by
itself, so if your program prints `err` too you will see the message twice; that is not your bug.

## The operation classes macvmm cares about

These are the operations that matter for a VMM. The names are the ones the kernel prints in its
denial messages on macOS 27.2.

| Operation | Checked when a process… | Seen on this machine as |
|---|---|---|
| `file-read*`, `file-write*` | resolves a path to open, stat or list it | `file-read-metadata /etc` |
| `file-write-create` | creates a new file | `file-write-create /…/new.txt` |
| `network-outbound` (in `network*`) | connects or sends to an address, IP or Unix-socket path | `network-outbound remote:*:443` |
| `process-fork`, `process-exec*` | creates a process, or replaces its program | `process-fork` (from `posix_spawn`) |
| `mach-lookup` | asks for a system service by name | `mach-lookup com.apple.TrustEvaluationAgent` |
| `iokit-open` | opens a connection to a kernel driver | `iokit-open-user-client <driver>` |
| `sysctl-read` | reads a kernel variable with `sysctl`, the kernel's read-only settings list (try `sysctl hw.ncpu`) | (macvmm allows it) |

The first four are familiar Unix ideas. The last two are macOS ideas, and they need a paragraph
each, because they are how a sandboxed program would reach the rest of the system.

**Mach services.** Much of macOS is not in the kernel but in **daemons**, background programs
that run all the time and do work for other programs: name lookup, certificate trust, logging,
system configuration. A program talks to a daemon by sending messages
through a **Mach port**, a kernel-managed message queue. To get a port in the first place it asks
`launchd`, the first process, for a service by its registered name, such as
`com.apple.TrustEvaluationAgent`. That request is a **mach-lookup**. Deny it and the program
cannot talk to any daemon. Try it with `curl`:

```sh
sandbox-exec -p '(version 1)(allow default)(deny mach-lookup)' /usr/bin/curl -sS -o /dev/null https://example.com
```

```text
curl: (60) SSL certificate problem: unable to get local issuer certificate
```

The network was allowed. What failed is certificate checking, which `curl` delegates to a
daemon it could no longer reach. (Name lookup goes through a daemon too, over a Unix socket: with
only `(deny network-outbound (literal "/private/var/run/mDNSResponder"))`, `curl` fails with
`Could not resolve host`.)

**IOKit user clients.** Drivers on macOS are written in **IOKit**, Apple's driver framework. A
program talks to a driver by opening a **user client**, a connection object the driver hands out.
`(deny iokit-open)` blocks that. One detail you will see in logs: the kernel reports the
operation as `iokit-open-user-client`, while the profile said `iokit-open`; the shorter name
still matches.

Why should a VMM care about these two? Because they are doors to code outside our process. Every
daemon or driver we can reach is more attack surface for someone who has taken over macvmm. The
good news, which we checked on a real Mac (macOS 27.2.1): VM creation, vCPU runs and VM
destruction under `sandbox-exec` with `(deny default)` needed **no** `mach-lookup` and **no**
`iokit-open`. Chapter 25 repeats that measurement with the reference VMM's own sandbox tests and
shows the captured runs. How Hypervisor.framework reaches the kernel is not documented; we only
know what it did not need.

## Watching the sandbox say no

Every denial is reported by the kernel to the **unified log**, the system-wide log that macOS
keeps for all processes. You need no `sudo` to read it. `--last 1m` looks back one minute, so run
`./lockdown` again first, then:

```sh
./lockdown
log show --last 1m --style compact --predicate 'eventMessage BEGINSWITH "Sandbox: lockdown"'
```

The `--predicate` is a filter: keep only messages whose text starts with `Sandbox: lockdown`,
because every denial line names the sandboxed program right after `Sandbox:`. This printed:

```text
2026-11-19 01:18:07.530 E  kernel[0:38319a] (Sandbox) Sandbox: lockdown(11522) deny(1) file-read-metadata /etc
2026-11-19 01:18:07.530 E  kernel[0:38319a] (Sandbox) Sandbox: lockdown(11522) deny(1) process-fork
```

Your timestamp, thread number and process ID will differ. Read the two lines against the puzzle.
`open("/etc/hosts")` died before it reached the file: to resolve the path, the kernel had to look
at the symbolic link `/etc`, and reading its metadata was already denied. `posix_spawn` was denied
as `process-fork`, the first thing it needs. And the socket is not mentioned at all.

The log is a reporting channel, not a ledger. The kernel folds repeats (`3 duplicate reports for
Sandbox: …`), and in our runs a launch sometimes logged nothing at all, even for a freshly
built binary. If your filter shows nothing, widen it to `--predicate 'sender == "Sandbox"'`: you
should see other programs' denials, which proves the reporting works and the line was just not
emitted. Use the log to discover which operation a program needs; use return values to test.

## Acquisition time: why the socket survived

The puzzle's last mystery is answered by one sentence in `man 7 sandbox`: "Restrictions are
generally enforced upon acquisition of operating system resources only." A fresh socket is like
an unplugged telephone: it has no address, nobody is on the other end, and nothing it can do
reaches outside the process yet. Rules are about *what* you may reach (this path, that address),
and an unconnected socket names nothing for a rule to match. The check comes when the socket is
pointed at something, by `connect`, `sendto` or `bind`. This program creates a socket and opens a
file *before* the lockdown, then uses both after it. The address `1.1.1.1` is a real public
server, but no packet is sent: the sandbox refuses `connect` before the network stack does
anything.

`held.c`

```c
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <sandbox.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

int main(void) {
    int early = open("/etc/hosts", O_RDONLY | O_CLOEXEC); /* before lockdown */
    int s = socket(AF_INET, SOCK_STREAM, 0);
    char *err = NULL;
    if (sandbox_init("(version 1)(deny default)", 0, &err) != 0) return 1;

    char buf[3] = {0};
    printf("read held fd -> %zd bytes \"%s\"\n", read(early, buf, 2), buf);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(443)};
    inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
    int c = connect(s, (struct sockaddr *)&a, sizeof a);
    printf("connect      -> %s\n", c == 0 ? "ok" : strerror(errno));
    return 0;
}
```

```sh
cc -Wno-deprecated-declarations -o held held.c
./held
```

```text
read held fd -> 2 bytes "##"
connect      -> Operation not permitted
```

The log line for the connect was `deny(1) network-outbound remote:*:443`. So the rule is: an fd
you already hold keeps working (`man 7 sandbox` says so explicitly for files opened for writing),
and anything that turns a *name* (a path, an address, a service name, a program) into a new
resource is checked. That is the whole design of macvmm's lockdown: open everything first, then
close the doors. Notice also that `printf` kept working under `(deny default)`, because standard
output was an fd the process already held.

> **Security.** The attacker we are guarding against controls the guest and, after a bug, the
> macvmm process. The sandbox cannot take away what is already open: the disk images, the serial
> file, guest RAM. It takes away everything else, which is the user's home directory, the
> network, other programs and system daemons. That is why `HostIo`, the macvmm module you will
> meet in Chapter 25 that does all of macvmm's file opening, opens every file before the lockdown,
> and why each fd is opened with the least access it needs (`,ro` disks read-only).

## `sandbox-exec` versus `sandbox_init`, and what is documented

The two tools apply the same kind of profile at different moments. `sandbox-exec` sandboxes a
program from `exec` onward, so the profile must allow everything the program's start-up needs:
the dynamic loader reading libraries, the program reading its own arguments' files. Try
`sandbox-exec -p '(version 1)(deny default)' /usr/bin/true`: it fails with
`execvp() of '/usr/bin/true' failed: Operation not permitted`, because even starting the program
is denied. `sandbox_init` is called by the program itself, after it has done its set-up, so the
profile can be far stricter. That is the pattern macvmm wants.

Now the warning from the start. Here is what is and is not promised. The right-hand column says
where each claim comes from: a header or man page Apple ships, or a check we ran on a real Mac.
Where a row says "macvmm's tests", the check comes from the reference VMM's own sandbox test
suite, which Chapter 25 walks through.

| Claim | Status |
|---|---|
| `sandbox_init` and `sandbox-exec` are deprecated; Apple points to App Sandbox | Read in the `sandbox.h` header and `man sandbox-exec` |
| `sandbox_init`'s `flags` "Must be `SANDBOX_NAMED`. All other values are reserved." | Read in the macOS 27.2 SDK's `sandbox.h` header |
| The named profiles (`kSBXProfileNoNetwork` …) must not be used with SDK 27.0 or later | Read in the SDK's `sandbox_init(3)` man page |
| Passing SBPL text with `flags = 0` works | Checked on a real Mac, macOS 27.2.1; undocumented, so it may break in any release |
| Held fds keep working; checks happen at acquisition | Documented in `sandbox(7)`, and checked on a real Mac for the cases above |
| There is no public SBPL reference | true; Apple's own profiles in `/System/Library/Sandbox/Profiles` (553 files here) are the best reading |
| HVF works under an exec-time `(deny default)` profile with no `mach-lookup` or `iokit-open` | Checked on a real Mac by macvmm's tests, macOS 27.2.1 |
| HVF keeps working after a *mid-process* `sandbox_init`, including the in-kernel GIC, 4 vCPUs created after it, a full reboot and disk I/O | Checked on a real Mac by macvmm's tests, macOS 27.2.1 (`macvmm run --sandbox`) |

This is why macvmm's sandbox is opt-in (`--sandbox`), fails closed (it exits if `sandbox_init`
returns an error, unless you ask for `--sandbox=best-effort`), and has a `sandbox-exec` wrapper as
its fallback.

> **Production note.** Shipping Mac apps use **App Sandbox**: an entitlement,
> `com.apple.security.app-sandbox`, which makes the system apply a fixed, documented profile and
> a per-app container directory at launch. It fits a GUI app with a bundle; it fits a CLI badly,
> because the CLI cannot open the paths you pass it without extra entitlements. Firecracker and
> crosvm go further than either and split device emulation into separate, more tightly confined
> processes, which is where macvmm would go next.

## The profile macvmm applies, in words

Chapter 25 builds `crates/macvmm/src/sandbox.rs`, which holds the profile as one string. Its
rules are:

- `(deny default)`, so anything not listed is refused;
- no path-based `file-read*` or `file-write*`, and no `file-write-create`, so held fds work and
  nothing new opens;
- `sysctl-read` allowed, for the few kernel variables the runtime reads;
- `network*`, `process-exec*` and `process-fork` denied;
- no `mach-lookup` and no `iokit-open`, unless the self-test proves one is needed, in which case
  the exact name and the reason are recorded.

It is applied after every file is open and before the first guest instruction. Some HVF calls
happen after that point (creating vCPU threads, and on an in-process reboot `hv_vm_create` again),
which is exactly why the self-test must exercise them.

## Smaller one-way doors: rlimits, umask, `O_CLOEXEC`

The sandbox has three small companions, each one call, each closing a specific leak.

**Resource limits.** The kernel keeps per-process **resource limits** (rlimits), each with a
*soft* value that is enforced and a *hard* ceiling. A process may lower either, and may raise the
soft value up to the hard one, but only root may raise the hard one. Look at yours:

```sh
launchctl limit core
launchctl limit maxfiles
```

```text
	core        0              unlimited      
	maxfiles    256            unlimited      
```

These are the defaults `launchd` gives new sessions (your shell may have changed its own). A soft
core limit of 0 means "no core dump", a file holding a crashed process's whole memory, which for
macvmm would be guest RAM. But the hard limit is `unlimited`, so `ulimit -c unlimited` in any
shell, or a wrapper script, turns core dumps back on. macvmm therefore sets
`RLIMIT_CORE` to `{0, 0}` at start-up. After that, raising it fails, which this fragment confirms:

```c
struct rlimit zero = {0, 0}, inf = {RLIM_INFINITY, RLIM_INFINITY};
setrlimit(RLIMIT_CORE, &zero);
setrlimit(RLIMIT_CORE, &inf);  /* -1, errno EPERM: "Operation not permitted" */
```

`RLIMIT_NOFILE` caps how many fds a process may hold. Right before the lockdown, macvmm lowers it to
the number in use plus 16, so a compromised process cannot hoard descriptors.

**The umask.** When a program creates a file it passes a mode, often `0666` (everyone may read
and write). The kernel clears the bits set in the process's **umask** first: the file's mode is
`mode & ~umask`. Modes are written in octal (the leading `0`), and each octal digit is three bits,
read, write, execute (`r=4`, `w=2`, `x=1`), for owner, group and others in turn. So `6` is `rw-`,
`4` is `r--`, `0` is `---`. Worked through with the common umask `022`:

```text
mode    0666 = 110 110 110   rw- rw- rw-
umask   0022 = 000 010 010
~umask       = 111 101 101   (flip every bit)
mode & ~umask= 110 100 100 = 0644   rw- r-- r--
```

The umask's `2`s removed the write bit for group and others, leaving the file readable by every
user on the Mac. macvmm's output files hold guest console text and, later, snapshots of guest RAM, so it calls
`umask(077)` once at start-up and every file it creates comes out `0600`. Doing it once matters:
the umask is per process, not per thread, so flipping it around one call would race with every
other thread creating files. You can see it from the shell, since `touch` creates files with
`0666` (the parentheses run each `umask` in a throwaway subshell):

```sh
(umask 022; touch before.txt); (umask 077; touch after.txt); /bin/ls -l before.txt after.txt
```

```text
-rw-------  1 you  staff  0 … after.txt
-rw-r--r--  1 you  staff  0 … before.txt
```

**`O_CLOEXEC`.** File descriptors survive `exec`: a program you start inherits your open files
unless each fd carries the close-on-exec flag. This program opens the same file twice, once
plain and once with `O_CLOEXEC`, then `exec`s a shell that checks whether fds 3 and 4 are open
(`exec 9<&N` fails if fd N is closed):

`cloexec.c`

```c
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(void) {
    int a = open("/etc/hosts", O_RDONLY);             /* survives exec */
    int b = open("/etc/hosts", O_RDONLY | O_CLOEXEC); /* closed by exec */
    printf("before exec: a=%d b=%d\n", a, b);
    fflush(stdout);
    execl("/bin/sh", "sh", "-c",
          "for n in 3 4; do if (exec 9<&$n) 2>/dev/null; then echo \"child: fd $n open\";"
          " else echo \"child: fd $n closed\"; fi; done",
          (char *)0);
    return 1; /* only reached if exec failed */
}
```

```sh
cc -o cloexec cloexec.c && ./cloexec
```

```text
before exec: a=3 b=4
child: fd 3 open
child: fd 4 closed
```

macvmm opens every fd with `O_CLOEXEC`, so if anything ever did start a child, it would not
inherit a read-write disk image.

## Why the run path never forks or execs

Better than closing fds on `exec` is never calling it. macvmm's `run` path starts no processes,
for three reasons. First, `fork` in a multi-threaded process copies only the calling thread; any
lock another thread held at that instant stays locked forever in the child. Concretely: thread B
is inside `malloc`, holding the memory allocator's lock, when thread A calls `fork`. The child
gets a copy of memory in which that lock is taken, but no copy of thread B to release it, so the
child's first `malloc` waits forever. That is why POSIX allows the child only
**async-signal-safe** calls, a short list of functions that take no such locks, until it
`exec`s. macvmm has a thread per vCPU, so `fork` there is a trap. Second, a child process is a fresh place for an attacker to run code with your rights,
outside whatever we confined. Third, the lockdown denies `process-fork` and `process-exec*`
anyway, so a run path that needed them would break under `--sandbox`. The only subcommand that
starts a child is `macvmm doctor`, a diagnostic command the course introduces early to check
that your build is set up and signed correctly. It runs `/usr/bin/codesign` by absolute path, with no
shell, and creates no VM.

## Self-check

Commit to an answer before you open each one. Assume macvmm's lockdown profile (previous
sections) is in force, applied with `sandbox_init` after set-up.

:::predict The disk image was opened read-write before the lockdown. The guest writes a sector, so macvmm calls `pwrite` on that fd. Allowed or denied? And `open("/etc/hosts", O_RDONLY)`?
`pwrite` is allowed: the fd was acquired before the lockdown, and the sandbox checks acquisition,
not every use of a held fd (`sandbox(7)`). `open("/etc/hosts")` is denied with `EPERM`; the log
reports it as `file-read-metadata /etc`, because resolving the symbolic link is already a denied
lookup.
:::

:::predict After lockdown, compromised code calls `socket(AF_INET, SOCK_STREAM, 0)` and then `connect` to a remote port. Which call fails?
`socket` succeeds: an unconnected socket acquires nothing outside the process. `connect` fails
with `EPERM`, logged as `network-outbound`. A test that reports "socket denied" must therefore
probe `connect` (or `sendto`), not `socket` alone.
:::

:::predict A profile says `(deny file-read* (literal "/tmp/secret"))`. `cat /tmp/secret` under `sandbox-exec` with that profile: does it print the file?
Yes, it prints. `/tmp` is a symbolic link to `/private/tmp`, and the sandbox matches the resolved
path. The rule must say `/private/tmp/secret`.
:::

:::predict Compromised code calls `posix_spawn("/bin/sh", …)`. What happens, and what operation name appears in the log?
It fails with `EPERM`, and the log shows `process-fork`: the spawn is refused at its first step,
creating a process. If that were allowed, `process-exec*` would be checked next, and it is denied
too.
:::

:::predict Your shell has `ulimit -c 0` (soft) but `unlimited` (hard). macvmm sets `RLIMIT_CORE` to `{0, 0}`. Later, compromised code calls `setrlimit(RLIMIT_CORE, {RLIM_INFINITY, RLIM_INFINITY})` and then crashes on purpose. Is there a core file?
No. Raising a hard limit needs root, so the `setrlimit` fails with `EPERM`, and with a limit of
0 the kernel writes no core. With only the soft limit at 0, the attacker could have raised it to
the hard limit and dumped guest RAM to `/cores`.
:::

:::predict With `umask(077)` in force, macvmm creates its serial log with mode `0644`. What mode does the file get? What would it get under the default umask `022`?
`0644 & ~077 = 0600`, readable and writable only by you. Under `022`: `0644 & ~022 = 0644`,
readable by every local user, which leaks guest console text.
:::

:::predict You put macvmm's exact lockdown profile in a file and run `sandbox-exec -f lockdown.sb macvmm run …` instead of letting macvmm call `sandbox_init` itself. Does the VM start?
No. `sandbox-exec` applies the profile before `exec`, so the profile is already in force while
macvmm starts up: the dynamic loader cannot read libraries and macvmm cannot open its kernel or
disk images, because path-based `file-read*` is denied. An exec-time profile must allow
everything start-up needs; `sandbox_init` after set-up can deny all of it.
:::

## Where this shows up in macvmm

- **Chapter 25, [`security`](../../production/security/)** (requires this primer): you set
  `RLIMIT_CORE = 0`, apply the lockdown with `--sandbox`, run `--sandbox-selftest` (probes for
  `open`, `connect` (or `sendto`) and spawn, not `socket`, which succeeds), and measure which
  operations the profile denies.
- **Chapter 09, [`mmio-pl011`](../../devices/mmio-pl011/)**: `--serial file:F` is opened with
  `O_CLOEXEC` and created `0600` under the start-up umask.
- **Chapter 18, [`virtio-blk`](../../virtio/virtio-blk/)**: disk images are opened before the
  lockdown, and every read, write and FLUSH goes through the held fd.
- **Chapter 19, [`virtio-net`](../../virtio/virtio-net/)**: the Unix datagram socket is created
  and bound during set-up; see the open question below.
- **Chapter 26, [`snapshots`](../../production/snapshots/)**: snapshot files hold all of guest
  RAM, so they are `0600`, and core dumps stay off for the same reason.

## Going further

- `man 7 sandbox`, `man 1 sandbox-exec`, and `sandbox_init(3)` and `sandbox.h` in the SDK
  (`$(xcrun --show-sdk-path)/usr/share/man/man3/sandbox_init.3`, `…/usr/include/sandbox.h`).
- Apple's own SBPL profiles, `/System/Library/Sandbox/Profiles/*.sb`; read `application.sb` to
  see operations and filters used at scale.
- Dionysus Blazakis, "The Apple Sandbox", Black Hat DC 2011: the classic reverse-engineering
  account of Seatbelt, SBPL compilation and the MAC hooks; XNU `security/mac_policy.h` for the
  hooks themselves.
- `man 2 setrlimit`, `man 2 umask`, `man 2 open` (`O_CLOEXEC`), and POSIX.1-2017 `fork()`,
  Rationale and Application Usage: a multi-threaded process's child may call only
  async-signal-safe functions before `exec`.

## Checkpoint

:::checkpoint

**What you can now do.** Run a command under a profile and find the denial:

```sh
sandbox-exec -p '(version 1)(allow default)(deny file-read* (subpath "/private/etc"))' /bin/cat /etc/hosts
```

You should see `cat: /etc/hosts: Operation not permitted`, and a matching
`deny(1) file-read-data /private/etc/hosts` line under `log show --last 1m --predicate
'eventMessage BEGINSWITH "Sandbox: cat"'`. The log line may be missing: the kernel folds
duplicates and sometimes emits nothing. The error message is the real test; to check that
denials are being logged at all, use `--predicate 'sender == "Sandbox"'`. You can
also predict, for any call, whether a `(deny default)` lockdown refuses it: acquiring by name is
checked, using what you hold is not. Delete your scratch directory; nothing in the macvmm repo
changed.

**What's next.** Chapter 25 puts this to work on a real VMM: a threat model, a fuzzer that finds
planted bugs, and then the lockdown itself, measured against SMP, a reboot and a disk FLUSH, so
that we know rather than hope that Hypervisor.framework keeps working inside the sandbox.

**One open question.** macvmm's network device sends each guest packet with `sendto` on a Unix
datagram socket it created and bound before the lockdown, addressed to a peer's socket *path*.
The profile denies `network*`. Is a `sendto` on a held socket "using what you hold" or "acquiring
by name"? The text above does not settle it, because the destination is a path given at
`sendto` time, not an already-connected peer. You can find out with a variant of `held.c`: before
`sandbox_init`, create two `AF_UNIX`, `SOCK_DGRAM` sockets and `bind` one to a path in your
scratch directory; after `sandbox_init("(version 1)(deny default)", …)`, `sendto` that path from
the other socket, then check the return value (and `errno`) and the log. Try a second variant
that `connect`s the sending socket before the lockdown and uses `send` after it. Comparing the two
tells you which design Chapter 19 needs.
