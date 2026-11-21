---
title: Unix domain sockets: a wire between two programs, named by a file
slug: unix-sockets
kind: primer
minutes: 15
required_by: [19]
labs: []
runs: mac
command: sysctl -n net.local.dgram.maxdgram
expect: 2048
---

# Why does "Address already in use" appear when nothing is running?

Here is a program that binds a socket to a name, then exits. Run it once and it works. Run it a
second time, with nothing else running anywhere, and it fails with `Address already in use`.
There is a zero-byte file left behind whose permissions start with an `s`. What is that file, why
does it outlive the program that made it, and why is deleting it not as harmless as it looks?
This primer answers all three.

**Why this is here.** A **virtual machine** (VM) is a pretend computer that macvmm runs inside
one ordinary Mac program; the operating system running inside it is the **guest**. In chapter 19
we give each guest a virtual network card, and we want two guests on the same Mac to talk to
each other. A network card sends and receives **Ethernet frames**: self-contained packets made
of a 14-byte header (destination, source, type) and up to 1500 bytes of payload, so at most
1514 bytes. (On a real cable a 4-byte checksum follows; virtual cards leave it out.) So the job
is: carry 1514-byte chunks from one macvmm process to another, safely and without special
privileges. Unix domain sockets do exactly that, and this primer gathers what chapter 19 needs.

:::objectives
- Predict stream versus datagram reads after two sends.
- Read and set the permissions on a socket file.
- Tell a live socket from a stale one, and replace only our own.
- Explain why the sender of every datagram must be checked.
- Explain why no entitlement is needed, and why that is not containment.
:::

:::prereqs
- The [`os-basics`](/build-your-own/vmm/primers/os-basics/) primer: processes, files and the kernel.
- File permissions as `ls -l` shows them (`rwx` for owner, group and others); the primer recaps
  the parts it needs.
- A Mac with Rust installed (`rustc`); every program here is one file built with `rustc -O`.
:::

## A socket that outlives its program

Save this as `bindit.rs` in an empty directory. It binds a socket to the path you give it, holds it
for a number of seconds (zero by default), and exits without tidying up.

`bindit.rs`

```rust
use std::os::unix::net::UnixDatagram;
use std::{env, thread, time::Duration};

fn main() {
    let path = env::args().nth(1).expect("usage: bindit PATH [SECONDS]");
    let hold: u64 = env::args().nth(2).map_or(0, |s| s.parse().unwrap());
    match UnixDatagram::bind(&path) {
        Ok(_sock) => {
            println!("bound {path}; holding it for {hold} s");
            thread::sleep(Duration::from_secs(hold));
            println!("exiting without cleaning up");
        }
        Err(e) => println!("bind {path}: {e}"),
    }
}
```

```sh
rustc -O bindit.rs
./bindit a.sock
./bindit a.sock
ls -l a.sock
```

```text
bound a.sock; holding it for 0 s
exiting without cleaning up
bind a.sock: Address already in use (os error 48)
srwxr-xr-x@ 1 you  staff  0 Nov 19 00:47 a.sock
```

Your user name, group and date will differ, and the `@` (extended attributes) may be missing. The
first character, `s`, is the one that matters: this is not a regular file (`-`) or a directory
(`d`), it is a **socket file**. To understand why it lingers we need to know what a socket is.

## A two-way pipe with an address

The **kernel** is the core of the operating system: the one program that controls memory, files
and devices on behalf of every other program. A program asks it to do something with a **system
call** (syscall), a function call that crosses from the program into the kernel.

A **socket** is a kernel object that moves bytes between programs. Your program holds it as a file
descriptor (a small integer naming an open kernel object), and writes to it and reads from it with
system calls. The kernel copies the bytes from one process's memory into a buffer and from there
into the other process's memory. Nothing travels over a network card.

Sockets come in **families**. The internet families (IPv4, IPv6) name the other end with an
address and a port. The family we want, `AF_UNIX`, names it with a path in the filesystem; a
socket of that family is a **Unix domain socket**. Three calls name things:

- `bind` attaches *our* socket to a path, so others can find it.
- `sendto` sends one message to a path given with that message.
- `connect` names the other end once. For a stream socket it sets up a real connection. For a
  datagram socket (next section) there is no connection at all: `connect` only records a default
  peer, so later sends need no address.

Anyone who knows the path (and has permission, which we get to shortly) can reach a bound socket.

That is the whole secret of the zero-byte file. It holds no data; it is a name, a signpost the
kernel uses to find the socket. The macOS `unix(4)` manual page says it plainly: the file is not
removed when the socket is closed, and `unlink(2)` must be used to remove it. Our program exited,
the kernel destroyed the socket, and the signpost stayed. The second `bind` refused to create a
name that already exists. Failing syscalls report a number called **errno**, and each number has a
symbolic name: this one is `EADDRINUSE` (48 on macOS), which Rust prints as "Address already in
use (os error 48)".

> **Aside.** Linux also has an "abstract" namespace of socket names that never appear in the
> filesystem and vanish with the socket. macOS has none, which is one reason macvmm must handle
> leftover files carefully.

## Streams lose your boundaries; datagrams keep them

Unix domain sockets come in two flavours that matter here. A **stream socket** (`SOCK_STREAM`) is
a two-way pipe of bytes, like a TCP connection. A **datagram socket** (`SOCK_DGRAM`) carries
separate messages, each delivered whole or not at all. The difference sounds academic until you
watch it. The program below uses `pair()`, which wraps `socketpair(2)`: it makes two sockets
already joined to each other, with no file name at all, which is handy for experiments. Save this
as `boundaries.rs`:

`boundaries.rs`

```rust
use std::io::{Read, Write};
use std::os::unix::net::{UnixDatagram, UnixStream};

fn main() -> std::io::Result<()> {
    let mut buf = [0u8; 64];

    // A stream: a pipe of bytes in both directions.
    let (mut a, mut b) = UnixStream::pair()?;
    a.write_all(b"hello")?;
    a.write_all(b"world")?;
    let n = b.read(&mut buf)?;
    println!("stream read 1: {:?}", String::from_utf8_lossy(&buf[..n]));

    // Datagrams: each send is one message, delivered whole.
    let (c, d) = UnixDatagram::pair()?;
    c.send(b"hello")?;
    c.send(b"world")?;
    for i in 1..=2 {
        let n = d.recv(&mut buf)?;
        println!("dgram  recv {i}: {:?}", String::from_utf8_lossy(&buf[..n]));
    }
    Ok(())
}
```

:::predict Two writes of five bytes each, then one read with room for 64. What is the stream read *allowed* to return? And what must the two datagram receives return?
The stream read may return anything from 1 to 10 bytes (typically all ten, `helloworld`). The datagram receives must return `hello` and then `world`, one message each.
:::

```sh
rustc -O boundaries.rs
./boundaries
```

```text
stream read 1: "helloworld"
dgram  recv 1: "hello"
dgram  recv 2: "world"
```

The stream read typically returns all ten bytes, as here, but it is allowed to return fewer (just
`hello`, or even `hel`). A stream keeps the order of bytes but not where one write ended and the
next began. Those edges are called **message boundaries**. To send messages over a stream you must
add your own framing, such as a length prefix in front of each message. The datagram socket kept
the boundaries for free: one `send`, one `recv`, always.

This is why chapter 19 uses datagrams: one frame per datagram means the other VM receives exactly
the frames that were sent, with no framing code to write and get wrong.

There is a third type, `SOCK_SEQPACKET`, a connection that keeps message boundaries. Linux
supports it for `AF_UNIX`, but on this Mac creating one fails with `Protocol not supported`
(`EPROTONOSUPPORT`), so it is not an option for us.

## How big can one message be?

Datagrams have a price: the kernel sets a maximum size per message and a limit on how many bytes
may wait, unread, in the receiver's queue. On macOS both are visible with `sysctl`:

```sh
sysctl net.local.dgram.maxdgram net.local.dgram.recvspace
```

```text
net.local.dgram.maxdgram: 2048
net.local.dgram.recvspace: 4096
```

So one 1514-byte frame fits in a datagram, but a receive queue of 4096 bytes holds only two of
them. First the size limit, in `sizes.rs`:

`sizes.rs`

```rust
use std::os::unix::net::UnixDatagram;

fn main() -> std::io::Result<()> {
    let (tx, rx) = UnixDatagram::pair()?;
    for len in [1514, 2048, 2049] {
        match tx.send(&vec![0u8; len]) {
            Ok(n) => println!("send {len}: ok, {n} bytes"),
            Err(e) => println!("send {len}: {e}"),
        }
    }
    let mut small = [0u8; 100];
    let n = rx.recv(&mut small)?;
    println!("recv into 100-byte buffer: {n} bytes");
    let mut big = [0u8; 4096];
    let n = rx.recv(&mut big)?;
    println!("next recv: {n} bytes");
    Ok(())
}
```

```sh
rustc -O sizes.rs
./sizes
```

```text
send 1514: ok, 1514 bytes
send 2048: ok, 2048 bytes
send 2049: Message too long (os error 40)
recv into 100-byte buffer: 100 bytes
next recv: 2048 bytes
```

Two lessons. A datagram above 2048 bytes is refused with `EMSGSIZE` ("message too long"). A
datagram received into a buffer that is too small is **truncated**: the first 100 bytes arrive,
the other 1414 are thrown away, and the next `recv` returns the next datagram, not the rest of
this one.

Now the queue limit, in `queue.rs`. Normally a `send` to a full queue **blocks**: it waits until
the receiver makes room. In **non-blocking mode** a call that would have to wait fails at once
instead, which lets us see the limit. Nobody reads `_rx`, so the queue only fills:

`queue.rs`

```rust
use std::os::unix::net::UnixDatagram;

fn main() -> std::io::Result<()> {
    let (tx, _rx) = UnixDatagram::pair()?;
    tx.set_nonblocking(true)?; // fail at once instead of waiting
    let frame = [0u8; 1514];
    for i in 1..=4 {
        match tx.send(&frame) {
            Ok(n) => println!("frame {i}: ok, {n} bytes"),
            Err(e) => {
                println!("frame {i}: {e}");
                break;
            }
        }
    }
    Ok(())
}
```

```sh
rustc -O queue.rs
./queue
```

```text
frame 1: ok, 1514 bytes
frame 2: ok, 1514 bytes
frame 3: No buffer space available (os error 55)
```

The third frame fails with `ENOBUFS` ("no buffer space"). A guest sending a quick burst of frames
would hit this constantly. So macvmm does three things. It receives into a 2048-byte buffer (the
largest datagram that can exist, so nothing is ever truncated), and treats anything longer than
1514 bytes as hostile. And it raises both socket buffers to 1 MiB (a mebibyte, 1,048,576 bytes)
with `setsockopt`, the syscall that changes a socket's settings (options `SO_SNDBUF` and
`SO_RCVBUF`; the ceiling is `kern.ipc.maxsockbuf`, 8 MiB on this machine). A 1 MiB queue holds
hundreds of frames instead of two, so a burst can wait while the receiving thread catches up.

## The path is a file, so file permissions guard it

Because the socket's name is a file, the ordinary Unix permission bits decide who may use it. A
quick refresher: `ls -l` shows nine bits in three groups of three, read, write and execute (`rwx`)
for the owner, the group and everyone else ("others"). Written in octal, each group is one digit
(r = 4, w = 2, x = 1), so `0600` is `rw-------` and `0755` is `rwxr-xr-x`. On a directory, `x` is
called **search** permission: it lets you pass through the directory to reach the names inside.
To reach `/a/b/c.sock` you need search permission on `/`, `/a` and `/a/b`.

Two rules govern sockets. To `connect` or `sendto` a socket file, you need **write** permission on
it, in whichever group of three applies to you (owner, else group member, else others), and search
permission on every directory along the path. Watch the first rule bite our own user, with the
stale `a.sock` from before and a small client, `poke.rs`:

`poke.rs`

```rust
use std::os::unix::net::UnixDatagram;

fn main() {
    let path = std::env::args().nth(1).expect("usage: poke PATH");
    let me = UnixDatagram::unbound().unwrap();
    match me.connect(&path) {
        Ok(()) => println!("connect {path}: ok, someone is listening"),
        Err(e) => println!("connect {path}: {e}"),
    }
}
```

```sh
rustc -O poke.rs
chmod 000 a.sock
./poke a.sock
```

```text
connect a.sock: Permission denied (os error 13)
```

`EACCES` (13): even the owner is turned away once the write bit is gone. We leave `a.sock` at mode
000 and delete it in a moment. Deleting will work even so, because removing a name changes the
*directory*, not the file: `rm` needs write and search permission on the directory, and the
file's own bits do not matter.

Who decides the bits on a new socket file? `bind` has no mode argument, so the kernel starts from
all bits, `0777`, and removes the bits set in the process's **umask**, a per-process mask of
permissions never to grant. Starting from 777, removing bits is the same as subtracting digit by
digit:

```text
umask 022:   777 - 022 = 755   srwxr-xr-x   (others: r-x, cannot send)
umask 077:   777 - 077 = 700   srwx------   (only the owner)
```

With the common umask `022` others lack write, so they cannot send, but that is luck, not design.
Try `077`:

```sh
rm a.sock
(umask 077; ./bindit a.sock)
ls -l a.sock
```

```text
bound a.sock; holding it for 0 s
exiting without cleaning up
srwx------@ 1 you  staff  0 Nov 19 00:47 a.sock
```

The `x` bit means nothing on a socket, so this is owner-only, the same protection as `0600`. macvmm
sets `umask(0o077)` once at startup, before any thread exists, because the umask is process-wide:
changing it around one `bind` would race with other threads creating files.

The second line of defence is the directory. macvmm insists that the directory holding its sockets
is owned by you and writable by no one else, and recommends `0700`. Then no other user can reach the
socket at all, whatever its own bits say, and, more importantly, no other user can delete it,
rename it or plant a symlink in its place. `mktemp -d` creates exactly such a directory (mode
`0700`, with a random name) and prints its path.

One more limit is spelled out in `unix(4)`: the path lives in a fixed field, `sun_path`, of 104
bytes on macOS. Rust refuses a longer one with `path must be shorter than SUN_LEN`. macOS's
per-user `$TMPDIR` (under `/var/folders/...`) already uses about 50 of those bytes, so keep socket
names short.

## Stale sockets, and replacing only our own

Back to the puzzle's last question. A crashed VM leaves its socket file behind, and the next run
must replace it or fail with "Address already in use". Why not always delete whatever is at the
path? Because the path is user input, and whatever sits there might belong to someone else. Our
`poke` can tell the cases apart. Start a socket that stays alive for 60 seconds:

```sh
./bindit live.sock 60
```

Now open a **second** terminal window, `cd` into the same directory, and within those 60 seconds
run:

```sh
./poke live.sock
touch notes.txt
./poke notes.txt
./poke nothing.sock
```

```text
connect live.sock: ok, someone is listening
connect notes.txt: Socket operation on non-socket (os error 38)
connect nothing.sock: No such file or directory (os error 2)
```

After the first terminal prints `exiting without cleaning up`, run `./poke live.sock` again:

```text
connect live.sock: Connection refused (os error 61)
```

That last error, `ECONNREFUSED`, is the fingerprint of a **stale socket**: a socket file with no
socket behind it. A live socket accepts the `connect`; a stale one refuses it.

Two terms before the rule. `lstat` is the syscall that describes a path (type, owner, mode)
*without following a symbolic link* (a symlink, a small file that points at another path); plain
`stat` follows the link and describes its target. In Rust they are `symlink_metadata` and
`metadata`. And when macvmm refuses, it stops with **exit status** 2: the number a program hands
back to the shell when it ends (`echo $?` shows it), where 0 means success and macvmm uses 2 for
"bad configuration".

macvmm replaces the file at its socket path only when all four checks pass, in this order:

1. **`lstat` the path, without following symlinks.** Nothing there (`ENOENT`, like `nothing.sock`)
   means nothing to replace: just `bind`.
2. **It is a socket file.** A symlink, a regular file (like `notes.txt`) or anything else: refuse.
3. **It is owned by our user id (uid)**, the number the kernel uses to identify your account.
   Someone else's socket: refuse.
4. **A test `connect` fails with `ECONNREFUSED`** (stale, like `live.sock` after it exited). If the
   connect succeeds (live, like `live.sock` during its 60 seconds) or fails with anything else
   (such as `EACCES`, like our mode-000 `a.sock`): refuse.

Only then does it `unlink` the old file and `bind`. The type and owner checks come before the
`connect`, so `ECONNREFUSED` is consulted only for a socket file we own.

:::diagram src=docs/diagrams/socket-bind.svg alt="Binding a Unix socket path safely"

*Only a socket file that is ours and dead gets replaced; everything else is someone's data.*

> **Security.** The attacker controls the path's contents: anything that can write to the directory
> can put a symlink there. Suppose `a.sock` is a symlink to your `$SSH_AUTH_SOCK`, the socket of
> your SSH agent (the background program that holds your SSH keys and signs logins for you). A
> check with `stat` follows the link, sees "a socket, owned by you", and a careless VMM deletes the
> link's target or binds in its place. That is why check 1 uses `lstat`. A second danger remains,
> called **time-of-check to time-of-use** (TOCTOU): (1) we check the path and see our stale
> socket; (2) before our `unlink` runs, another process swaps a symlink in, and we act on
> something we never checked. Only a private directory guarantees that nobody else can act in that
> gap, which is why the directory rule is enforced, not advised.

## Who sent this datagram?

A datagram socket can be `connect`ed to one peer, which sets the default destination for `send`.
It is tempting to believe it also filters what arrives. On macOS it does not. Make a fresh private
directory and move into it:

```sh
cd "$(mktemp -d)"
pwd
```

Save `who.rs` there. It binds three named sockets, `a`, `b` and `other`, connects `a` to `b`, and
then has `b`, `other` and an **unnamed** socket (one never bound, so it has no path) each send one
datagram to `a`. `recv_from` returns each datagram together with its sender's address.

`who.rs`

```rust
use std::os::unix::net::UnixDatagram;

fn main() -> std::io::Result<()> {
    let dir = std::env::args().nth(1).expect("usage: who DIR");
    let a = UnixDatagram::bind(format!("{dir}/a.sock"))?;
    let b = UnixDatagram::bind(format!("{dir}/b.sock"))?;
    a.connect(format!("{dir}/b.sock"))?; // a's only peer is b... or is it?

    let other = UnixDatagram::bind(format!("{dir}/other.sock"))?;
    let anon = UnixDatagram::unbound()?;
    b.send_to(b"from b", format!("{dir}/a.sock"))?;
    other.send_to(b"from other", format!("{dir}/a.sock"))?;
    anon.send_to(b"from nobody", format!("{dir}/a.sock"))?;

    let mut buf = [0u8; 64];
    for _ in 0..3 {
        let (n, from) = a.recv_from(&mut buf)?;
        let text = String::from_utf8_lossy(&buf[..n]);
        println!("{text:12} source: {:?}", from.as_pathname());
    }
    Ok(())
}
```

```sh
rustc -O who.rs
./who .
```

```text
from b       source: Some("./b.sock")
from other   source: Some("./other.sock")
from nobody  source: None
```

All three arrived. A third socket got through, and so did the unnamed sender, which has no path to
report (`None`). POSIX says connecting a datagram socket limits which senders `recv` returns, and
Linux enforces this; macOS did not here, so we cannot rely on it. `recv_from` does tell us the
source path, though, and that is the defence.

`who.rs` leaves its three socket files behind, so a second `./who .` in the same directory fails
with `Address already in use (os error 48)`: the stale-socket lesson again. Run `rm *.sock` first,
or start in a fresh `mktemp -d` directory.

> **Security.** The attacker is any process able to write to the VM's socket file. If the VMM
> believed `connect` filtered senders, that process could inject Ethernet frames into the guest at
> any moment: forged packets such as fake answers to the guest's "which card owns this IP
> address?" questions (ARP), redirecting its traffic, or crafted packets aimed at bugs in the guest
> kernel's network code. So macvmm compares the source path of every datagram with the configured
> peer, and drops and counts mismatches, unnamed senders included. By default it never "learns" its peer
> from whoever writes first, because any process could win that race (an opt-in `learn` mode
> exists, and is weaker for exactly that reason).

## How chapter 19 spells it

Each VM gets one option, `--net unixgram:LOCAL,peer=PEER`. macvmm **binds** `LOCAL` (its own name,
where it receives), **sends** every frame to `PEER` (the other VM's `LOCAL`) with `send_to`, and accepts a
datagram only if its source path is `PEER`. It never calls `connect` on this socket: the peer may not
exist yet, or may restart and bind again. Before binding, it runs the four checks on
`LOCAL`. The two VMs' options mirror each other, and both paths should sit in one `mktemp -d`
directory.

## Why no entitlement is needed, and what that does not buy

macOS gates some powers behind **entitlements**: named permissions written into a program's code
signature, which the system checks before allowing certain actions (the [`codesign-entitlements`](/build-your-own/vmm/primers/codesign-entitlements/)
primer). macvmm is signed "ad hoc", by you rather than by an Apple-registered developer, and holds
only the hypervisor entitlement. Bridging a VM onto your real network through `vmnet.framework`
(Apple's VM networking library) needs either root (the all-powerful administrator account) or
`com.apple.vm.networking`, a restricted entitlement an ad-hoc signed program can never hold.

Unix domain sockets need neither. To the kernel they are files and file descriptors, guarded by the
same owner, mode and directory rules as any file you create, so the default `cargo run` path stays
unprivileged. The two VMs' "network" is a private wire: VM A's frames go into a datagram socket,
VM B's socket receives them, and nothing reaches your Mac's network interfaces.

Chapter 19 adds two cautions. First, **containment** means limiting what a program can do even if
an attacker takes it over. "No network entitlement" is a statement about what the VMM asked for,
not a limit: an ordinary process may open internet connections without any entitlement, so a
compromised VMM could too. Containing it is the job of chapter 25's sandbox (a set of
kernel-enforced rules a process cannot lift from inside). Second, the socket files are only as
private as their directory.

> **Production note (optional).** Real VMMs on Linux usually attach a guest's network card to a
> TAP device or vhost-net (kernel features that plug a VM into the host's real network), and on
> macOS to `vmnet.framework`. Those give a guest real network access and need privileges. QEMU has
> a datagram socket backend in the same spirit as ours (`-netdev dgram`). We take the Unix datagram
> path because it needs no privilege and every byte is visible to us.

## Self-check

Commit to an answer before you reveal it.

:::predict Two VMs are started with `--net unixgram:$T/a.sock,peer=$T/b.sock` (VM A) and `--net unixgram:$T/b.sock,peer=$T/a.sock` (VM B). Fill in the blanks: which path does each process bind, which does it send to, and what source path must each accept on every datagram it receives?
```text
VM A:  bind ________   send to ________   accept only source ________
VM B:  bind ________   send to ________   accept only source ________
```
VM A binds `$T/a.sock`, sends to `$T/b.sock`, and accepts only datagrams whose source is
`$T/b.sock`. VM B is the mirror image: binds `$T/b.sock`, sends to `$T/a.sock`, accepts only
source `$T/a.sock`. Each process binds its own name so the other can send to it and so the receiver
can check who sent each datagram. `$T` should be a directory only you can write to.
:::

:::predict A guest sends three 60-byte frames over a stream socket instead of datagrams, and the other side reads with a 2048-byte buffer. What can the first read return?
Anything from 1 to 180 bytes: possibly all three frames glued together, possibly part of one.
A stream keeps bytes in order but not message boundaries, so the receiver cannot tell where one
frame ends without framing that we would have to add. A datagram socket returns exactly one 60-byte
frame per `recv`.
:::

:::predict A socket file shows `srwxr-xr-x` and is owned by you. Can another user on the Mac send it a datagram? Would the answer change if the umask had been `002`?
No: sending needs write permission on the socket file, and "others" have only `r-x`. With umask
`002` the file would be 777 - 002 = 775, `srwxrwxr-x`, so members of your group could send. That
is why macvmm sets umask `077` and also requires a directory that no one else can write to.
:::

:::predict Under umask `027`, what mode does `bind` give a new socket file, and who besides you can send to it?
777 - 027 = 750, `srwxr-x---`. Nobody else can send: the group has `r-x` (no write) and others
have nothing.
:::

:::predict Your VMM finds a file at its socket path. A test `connect` returns `ECONNREFUSED`, but `lstat` says it is a symlink. What should it do, and why not follow the link?
Refuse and exit 2. The checks run in order, and a symlink fails check 2 (it is not a socket file)
before the `connect` result is ever consulted. A symlink could point at another program's socket,
such as the SSH agent's; following it with `stat` would make us judge, and perhaps delete, someone
else's file.
:::

:::predict VM A's socket is `connect`ed to VM B's path. A third process calls `sendto` on VM A's path with a forged packet. On macOS, does the datagram arrive, and how does macvmm know to drop it?
It arrives: a connected `AF_UNIX` datagram socket on macOS does not filter senders (the `who.rs`
experiment). `recv_from` reports the sender's path (or none for an unbound sender); macvmm compares
it with the configured peer path and drops and counts any mismatch.
:::

## Lab

This primer has no interactive lab. Its exercise is the first self-check question: the two-VM
socket table. Redraw it on paper from memory before you start chapter 19, then compare it with the
command lines that chapter's checkpoint runs.

## Where this shows up in macvmm

- [Chapter 19, virtio-net](/build-your-own/vmm/virtio/virtio-net/) (requires this primer): the
  `unixgram` network backend (`crates/vmm/src/net/unixgram.rs`) binds LOCAL and connects to
  `peer=`, receives into a 2048-byte buffer, raises the socket buffers to 1 MiB, checks the source
  of every datagram, and replaces an existing LOCAL only when it is our own stale socket. Its
  checkpoint runs two VMs over a socket pair and checks that `--net unixgram:<regular file>` is
  refused with exit 2.
- [Chapter 25, security](/build-your-own/vmm/production/security/): the startup `umask(0o077)`, and
  why "no network entitlement" is not containment.
- [Chapter 27, debug-perf](/build-your-own/vmm/production/debug-perf/): the GDB stub listens on a
  stream socket in a `0700` directory by default, so only you can attach a debugger that can read
  and write guest memory; loopback TCP is opt-in and token-gated, because any local process can
  connect to a TCP port.

## Checkpoint

:::checkpoint

- **What you can do now.** Confirm the datagram size limit that chapter 19 designs around:
  `sysctl -n net.local.dgram.maxdgram` prints `2048`. Predict stream and datagram reads, compute a
  socket file's mode from the umask, tell a live socket from a stale one by its `connect` error,
  and list the four checks (lstat without following links, is a socket, owned by our uid, connect
  gives `ECONNREFUSED`) before replacing one.
- **What's next.** Chapter 19 puts a virtio network card in the guest and connects its frames to
  these sockets. Two guests will ping each other and move 32 MiB through a wire that is, in the
  end, a pair of zero-byte files.
- **One open question (optional).** Our datagram wire drops frames when the receiver's queue is
  full, and the guest never finds out. Ethernet drops frames too. Which part of the guest notices
  the loss and recovers? Hint: `ping` merely reports lost replies, but a file transfer still
  arrives complete, because TCP, the protocol under it, numbers its bytes and resends what was not
  acknowledged. What would change if our wire silently reordered frames instead?

## Going further

- macOS `unix(4)` (`man 4 unix`): the `sockaddr_un` layout with its 104-byte `sun_path`, and the
  rule that a socket's file must be removed with `unlink(2)`.
- POSIX.1-2024 (IEEE Std 1003.1), System Interfaces: `bind()`, `connect()` (including the
  datagram case, where connecting sets the default destination and limits the remote sender for
  later receives, a rule macOS did not follow in our test), `recvfrom()` and `umask()`; and the
  `<sys/un.h>` header.
- Linux `unix(7)` man page: the same family on Linux, with the abstract namespace,
  `SOCK_SEQPACKET`, and the permission rules for connecting to a socket file.
- W. Richard Stevens, Bill Fenner and Andrew M. Rudoff, *UNIX Network Programming, Volume 1*,
  3rd edition, chapter 15, "Unix Domain Protocols".
