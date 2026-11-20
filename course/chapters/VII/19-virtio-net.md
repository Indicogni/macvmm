---
title: virtio-net without a networking entitlement
part: VII
chapter: VII.5
id: 19
runs: mac+browser
minutes: 360
prereqs: [18]
start_tag: ch-18
labs: [frame-dissector]
command: scripts/checkpoint.sh 19
expect: CHECKPOINT 19 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** virtio-net and its two queues; the 12-byte `virtio_net_hdr`; frame-size caps; drop-and-count; the `NetBackend` trait; `Companion` threads; the `unixgram` backend and its checks; why "no network entitlement" is not containment.
- **Core, from earlier:** the test initramfs and `Ctrl-A x` (chapters 09 and 14); the second quit signal (chapter 09); `QueueNotify` and `DEVICE_NEEDS_RESET` (chapter 15); `into_validated` and copy-then-validate (chapter 16); the worker thread and `--stats` (chapters 11 and 17); counted failure (chapter 18); rate-limited warnings (chapter 08).
- **Primers (read first):** `unix-sockets` (datagram sockets, socket files and their permissions, stale sockets, `ENOBUFS`, checking a sender); `codesign-entitlements` (its "going deeper" section on restricted entitlements).
- **Pointers:** Ethernet, ARP (Address Resolution Protocol), IPv4 and ICMP (body text and an Aside); network offloads (an Aside); `vmnet.framework` (a link); the macOS `sample` tool and `nc` (a sentence at first use).
- **Forward definitions:** the macOS sandbox and the startup umask (chapter 25); several vCPUs sharing one device (chapter 20).
:::

Two Linux guests on one Mac, with no network anywhere: no Wi-Fi, no cable, no network permission for the program that runs them. The first pings the second five times, gets five answers, then sends it 32 MiB, and both print the same sha256. Along the way, the second guest's virtual machine monitor (VMM) threw away six frames its guest asked it to send, counted them, and carried on. Is that a bug? And where did the packets that *did* arrive travel?

This chapter finishes row 8 of chapter 00's problem ledger, bulk I/O at reasonable cost, with the fourth virtio device: a network card. By the end, two of your virtual machines (VMs) talk Ethernet through two socket files, and you can say which frames were lost and why.

:::objectives
- Implement virtio-net: the 12-byte header with `flags` and `gso_type` checked, `F_MAC`, transmit chains capped at 12 + 1514 bytes, and a receive path that drops and counts instead of blocking.
- Design a `NetBackend` trait and implement `--net unixgram:LOCAL,peer=REMOTE[,mac=..]` over Unix datagram sockets in a private directory, so two VMs talk with no entitlement and no root.
- Predict, then observe, what a guest does with frames framed by a 10-byte header instead of 12.
- Diagnose, from a `sample` of a hung VMM, why a device that waits for its guest deadlocks it.
- Explain why `vmnet.framework` is not on the default path, and why "no network entitlement" is not containment.
:::

**Before you start.** From the repository root, run `scripts/learner start 19`; it copies this chapter's journal to `learner/journal/19.md`. You need `.cache/macvmm/Image-virt` and `.cache/macvmm/initramfs-test.img` from chapter 14. Two sittings of about 3 hours: the device and its host-only tests, up to the "Good place to stop" marker; then the wire, the runs and the break, at your Mac.

## A network card is two queues

A network card moves packets between the operating system and a wire, each as an [**Ethernet frame**](/build-your-own/vmm/glossary/#ethernet-frame): a 14-byte header (destination address, sender address, and a two-byte type saying what follows, such as IPv4, Internet Protocol version 4) and up to 1500 bytes of payload, so at most 1514 bytes (a real wire adds a 4-byte checksum, which never crosses virtio). Each address is a [**MAC address**](/build-your-own/vmm/glossary/#mac-address) (media access control address), six bytes such as `02:6d:76:00:00:01`, one per network interface card (NIC). A leading `02` marks a locally administered address, which no manufacturer owns. To send to `10.0.0.2`, a guest first needs that address's MAC, so it broadcasts an [ARP](/build-your-own/vmm/glossary/#arp) request (Address Resolution Protocol), "who has 10.0.0.2?", to `ff:ff:ff:ff:ff:ff`, and the owner replies with its MAC.

> **Aside.** Inside a frame sit more headers. An IPv4 header carries addresses like `10.0.0.2`; an ICMP message (Internet Control Message Protocol) is what `ping` sends. ARP is [RFC 826](https://www.rfc-editor.org/rfc/rfc826).

A virtio network card, [**virtio-net**](/build-your-own/vmm/glossary/#virtio-net) (device ID 1, virtio 1.2 section 5.1), does this job through two [virtqueues](/build-your-own/vmm/glossary/#virtqueue). Queue 1, the **transmit queue**, works like virtio-console's: the guest posts a chain holding one frame and rings the [doorbell](/build-your-own/vmm/glossary/#doorbell). Queue 0, the **receive queue**, works like virtio-rng's: the guest posts empty, device-writable buffers *ahead of time*, and the device fills one whenever a frame arrives.

We offer two feature bits: `VERSION_1`, and `F_MAC` (bit 5): the 6-byte configuration space holds the card's MAC. Every other feature stays off. (In code comments, a number such as 5.1.2 is a virtio 1.2 section.)

:::code anchor=net_caps file=crates/vmm/src/virtio/net.rs

## Twelve bytes in front of every frame

Every buffer, in both directions, starts with a [`struct virtio_net_hdr`](/build-your-own/vmm/glossary/#virtio-net-hdr) (virtio 1.2 section 5.1.6). With `VERSION_1` it is always 12 bytes, little-endian:

| Offset | Field | With no offload negotiated |
|---|---|---|
| 0 | `flags` (1 byte) | the driver must send 0 |
| 1 | `gso_type` (1 byte) | the driver must send 0, "no segmentation" |
| 2 | `hdr_len` (2) | ignored |
| 4 | `gso_size` (2) | ignored |
| 6 | `csum_start` (2) | ignored |
| 8 | `csum_offset` (2) | ignored |
| 10 | `num_buffers` (2) | on transmit the driver writes 0; on receive the device writes 1 |

The last field has a history: before virtio 1.0, a device without "mergeable receive buffers" (an offload, in the Aside below) used a 10-byte header with no `num_buffers`. On transmit we check `flags` and `gso_type`, because a non-zero value would ask us to do work to the frame; `num_buffers` means nothing to a device on transmit, so we do not look.

:::code anchor=net_header_ok file=crates/vmm/src/virtio/net.rs

It is handed a slice of a copy, never guest memory; the transmit section shows why. Here is an ARP request from VM A, the first virtual machine in this chapter's runs, as the device sees it:

```text
offset  bytes                            field
0       00                               flags: 0
1       00                               gso_type: 0, no segmentation
2       00 00 00 00 00 00                hdr_len, gso_size, csum_start: unused
8       00 00                            csum_offset: unused
10      00 00                            num_buffers: 0 on transmit
12      ff ff ff ff ff ff                Ethernet destination: broadcast
18      02 6d 76 00 00 01                Ethernet source: VM A's MAC
24      08 06                            EtherType 0x0806: ARP
26      00 01 08 00 06 04 00 01          ARP: Ethernet, IPv4, sizes 6 and 4, request
34      02 6d 76 00 00 01 0a 00 00 01    sender MAC, sender IP 10.0.0.1
44      00 00 00 00 00 00 0a 00 00 02    target MAC unknown, target IP 10.0.0.2
```

:::lab frame-dissector

> **Aside.** The ignored fields exist for [**offloads**](/build-your-own/vmm/glossary/#offload), work the guest hands to the device. *Checksum offload*: the guest leaves a TCP (Transmission Control Protocol) or UDP (User Datagram Protocol) checksum blank, and `csum_start` and `csum_offset` say where the device must store it. *Segmentation offload*: the guest hands over one packet of up to 64 KiB, and `gso_type` and `gso_size` say how to cut it into frames. *Mergeable receive buffers*: one received packet may fill several buffers, and `num_buffers` says how many. Each makes the device faster and makes it trust more guest-written numbers.

:::predict Suppose the device strips a 10-byte header from every transmitted frame, as an old device would, while the guest's driver writes 12. VM A pings VM B. Does B's guest see (a) valid packets, (b) corrupted packets it complains about, or (c) nothing at all? What do the first 14 bytes B reads look like for the ARP broadcast above?
Write your guess and one sentence of reasoning under `## Predict` in your journal. The section "Two bytes off" runs it.
:::

## Transmit: copy once, check the copy, never punish the guest

A frame to send arrives like every virtio request: the guest writes a chain, rings `QueueNotify`, and the device's [worker thread](/build-your-own/vmm/glossary/#device-worker-thread) from chapter 17 processes the transmit queue. In `learner/crates/vmm/src/virtio/net.rs`, the heart of `process_tx`, once per chain:

:::code anchor=net_tx_loop file=crates/vmm/src/virtio/net.rs

Every chain goes back on the used ring with length 0: a transmit chain gives the device nothing to write. A dropped frame is a counter and a rate-limited warning, never an error. Only a broken *ring* (a loop, an index jump, a buffer outside RAM) reaches a `?` and puts the device into [`DEVICE_NEEDS_RESET`](/build-your-own/vmm/glossary/#device-needs-reset). A bad frame vanishes, as on Ethernet, and TCP resends it.

So `into_validated` gets `u64::MAX` as its cap, unlike chapter 16's tight limits: an over-long frame is a dropped packet, not a broken ring. The length rule lives in `tx_one`, checked before anything is allocated; the hop budget still bounds the walk:

:::code anchor=net_tx_shape file=crates/vmm/src/virtio/net.rs

A chain with a device-writable descriptor is refused, and the total must lie between 26 (header plus a bare Ethernet header) and 1526 (header plus 1514). Then one copy:

:::code anchor=net_tx_copy file=crates/vmm/src/virtio/net.rs

The bytes are copied out of guest memory once, into `pkt`, and the header is checked on the copy: chapter 16's [copy-then-validate](/build-your-own/vmm/glossary/#copy-then-validate), since the running guest could rewrite the header between a check and a send. The backend gets the frame without its header.

> **Security.** The guest controls every descriptor's address and length and all 12 header bytes. It does not control how much we allocate (at most 1526 bytes), how often we read each byte (once), or whether a bad packet stops the device (never). Without the cap, guest lengths would size a host allocation.

## Receive: frames arrive whenever they like

Transmit starts when the guest rings. A received frame arrives at any moment, into a buffer the guest must have posted in advance. So where does it wait if no buffer is posted?

Before the device sees it, a frame waits in the host socket's receive buffer, inside the macOS kernel. Once the device has it, it goes into a posted buffer at once or is dropped. A real NIC with an empty receive ring does the same (Linux counts `rx_missed_errors`). We call it [**drop-and-count**](/build-your-own/vmm/glossary/#drop-and-count): discard, bump a counter, let the guest's protocols recover. Waiting instead is this chapter's deliberate break.

:::code anchor=net_rx_drops file=crates/vmm/src/virtio/net.rs

A datagram outside 14 to 1514 bytes is not a frame (`rx_dropped_len`). A device not set up, in `DEVICE_NEEDS_RESET`, or with an empty receive queue has no buffer (`rx_dropped_no_buffer`). Otherwise there is a posted chain:

:::code anchor=net_rx_deliver file=crates/vmm/src/virtio/net.rs

A chain that is readable, or too small for 12 + the frame, goes back unused with length 0 (`rx_dropped_small`). Otherwise the device writes a header of zeros except `num_buffers = 1`, then the frame, and reports exactly the bytes written. Every counter shows up in `--stats`:

:::code anchor=net_counters file=crates/vmm/src/virtio/net.rs

## The seam: `NetBackend`

The device needs two things from the host, "send this frame" and "give me the next frame": a trait, [`NetBackend`](/build-your-own/vmm/glossary/#netbackend), in `learner/crates/vmm/src/net/backend.rs`:

:::code anchor=net_backend_trait file=crates/vmm/src/net/backend.rs

The contract is in the timings. `send` runs on the worker *with the device mutex held*, so it gives up after 10 ms and the frame is dropped and counted. `recv` returns within 100 ms even if nothing arrives; `is_quiet` says whether its error means "nothing for the guest" (a timeout, or a datagram already dropped and counted). The host tests use an in-memory `MockBackend`.

## A thread that never waits for the guest

Who calls `receive`? Not a vCPU: its thread runs the guest. Not the worker: nobody rings a doorbell for an incoming frame. So each NIC gets one more thread, its [RX thread](/build-your-own/vmm/glossary/#rx-thread) (RX for receive, TX for transmit), running `spawn_rx`'s loop:

:::code anchor=net_rx_loop file=crates/vmm/src/virtio/net.rs

`recv` gives up after 100 ms, so the thread checks its stop flag ten times a second, and it holds the device mutex for one frame at a time. If the mutex is poisoned (chapter 15), the loop leaves without touching the device. If this thread panics, a guard created at its top stops the whole VM: Rust runs a value's `Drop` while a panic unwinds, and `std::thread::panicking()` tells the guard why.

:::code anchor=net_rx_panic_guard file=crates/vmm/src/virtio/net.rs

The receive buffer, `RX_BUFFER`, is 2048 bytes. `recv` truncates a longer datagram, but it is still longer than any frame, so it is dropped as `rx_dropped_len`:

:::code anchor=net_rx_buffer file=crates/vmm/src/virtio/net.rs

Chapter 17's worker gains one small trait, [`Companion`](/build-your-own/vmm/glossary/#companion): another thread of the same device. As the worker's companion, the RX thread is stopped and joined with it before guest memory is freed, and its counters print with the worker's:

:::code anchor=worker_companion file=crates/vmm/src/virtio/worker.rs

:::code anchor=net_rx_attach file=crates/vmm/src/machine/virt.rs

The rest is chapter 15's `VirtioDevice` trait. The configuration space holds the MAC and ignores writes. A doorbell on queue 0 only means "I posted buffers", which `receive` finds when the next frame arrives, so it does nothing:

:::code anchor=net_process_queue file=crates/vmm/src/virtio/net.rs

Check the first sitting's work with the reference's host-only suite and its helper directory:

```sh
cp -Rn crates/vmm/tests/virtio_support crates/vmm/tests/virtio_net_hostile.rs learner/crates/vmm/tests/
cd learner && cargo test -q -p vmm --test virtio_net_hostile
```

Its 18 tests cover every rule above, with the names in item 1 of "Your turn". Expect `test result: ok. 18 passed`.

:::stopping-point Good place to stop. Your device passes its host tests; sitting B gives it a wire and needs your Mac.

## A wire made of two socket files

A Unix datagram socket keeps message boundaries (the `unix-sockets` primer), so one datagram is one Ethernet frame. Each VM binds its own socket file and sends to the other's:

```text
guest A | macvmm A             host: dir $T, mode 0700            macvmm B    | guest B
        |                                                                     |
eth0 -->| virtio-net (A) --send_to--> b.sock --recv--> virtio-net (B) --------|--> eth0
eth0 <--| virtio-net (A) <--recv-- a.sock <--send_to-- virtio-net (B) --------|--- eth0
        |  A binds a.sock                                B binds b.sock       |
```

*Each VMM receives on the socket it bound and sends to its peer's. The bars are the trust boundaries between guest and VMM; nothing leaves the Mac.*

The [unixgram backend](/build-your-own/vmm/glossary/#unixgram-backend)'s option is `--net unixgram:LOCAL,peer=REMOTE[,mac=XX:XX:XX:XX:XX:XX]`, parsed by `parse_net` in `learner/crates/macvmm/src/cli.rs`. Without `mac=`, the card gets `02:6d:76` plus three random bytes. Name the peer: a NIC that accepted whoever wrote first would be a gift to every program on the Mac. (An opt-in `,learn` locks onto the first sender instead; it is weaker, and we do not use it.)

:::code anchor=cli_net_peer file=crates/macvmm/src/cli.rs

Before binding, the VMM runs the primer's checks in `learner/crates/vmm/src/backend/hostio.rs` (create it if you have none). The directory must be a real directory you own that nobody else can write to:

:::code anchor=hostio_net_dir file=crates/vmm/src/backend/hostio.rs

Something already at `LOCAL` is inspected without following symlinks and replaced only if it is a socket, yours, and **stale**: left behind by a VM that died, with nobody bound to it.

:::code anchor=hostio_net_stale file=crates/vmm/src/backend/hostio.rs

The stale test is a datagram `connect`: it succeeds on a live socket and fails with `ECONNREFUSED` on a stale one.

:::code anchor=unixgram_probe file=crates/vmm/src/net/unixgram.rs

Binding raises both socket buffers to 1 MiB. The receive buffer is where frames queue while the RX thread is busy; the macOS default, 4096 bytes, holds two frames. When it is full, the peer's `send_to` fails and the *peer* counts a `tx_dropped`. `setsockopt` is an unsafe raw call, so `set_socket_buffers` lives in the `hvf` crate (chapter 01):

:::code anchor=unixgram_bind file=crates/vmm/src/net/unixgram.rs

The reference sets a umask (file-creation mask) of `077` at startup, so `bind` creates the socket `srwx------`, owner only, as the primer computed. Chapter 25 adds that umask to yours; until then, the `0700` directory from `mktemp -d` keeps other users out.

A full peer fails with `ENOBUFS` at once, ignoring the write timeout, so `send` retries with short sleeps for at most 10 ms, then drops:

:::code anchor=unixgram_send file=crates/vmm/src/net/unixgram.rs

One more check, on every datagram. As the primer showed, on macOS even a `connect`ed datagram socket receives from any sender that can write to its path, and ours is not connected: every frame is a `send_to(peer)`, because the peer may not exist yet or may restart. So the source check is the only filter; `recv` counts failures as `rx_dropped_foreign`:

:::code anchor=unixgram_recv file=crates/vmm/src/net/unixgram.rs

:::code anchor=unixgram_peer_fixed file=crates/vmm/src/net/unixgram.rs

The comparison is byte for byte, against a list, `accept`. On macOS `$TMPDIR` lives under `/var`, a symlink to `/private/var`, so one socket has two spellings. `open_unixgram` resolves *our* `peer=` path's directory once and accepts either. A *received* path is never resolved, or a sender could bind a symlink that resolves to the peer.

:::code anchor=hostio_peer_spellings file=crates/vmm/src/backend/hostio.rs

## Two VMs, one conversation

The test initramfs has two cases for this chapter. `net-b` brings up `eth0` (Linux's name for its first network interface) as `10.0.0.2`; "up" means the driver is in use and posting receive buffers. It listens on TCP port 5000 with `nc` (netcat, which pipes bytes over one TCP connection) and prints the sha256 of what it receives. `net-a` comes up as `10.0.0.1`, pings B, then sends 32 MiB of random bytes:

:::code anchor=initramfs_net_a file=scripts/initramfs/init

From the repository root these run the reference; for yours, run them inside `learner/` with `../.cache`. In terminal 1, make a private directory and start B:

```sh
T=$(mktemp -d); echo "$T"
cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --stats --net "unixgram:$T/b.sock,peer=$T/a.sock,mac=02:6d:76:00:00:02" --cmdline "console=ttyAMA0 quiet macvmm.test=net-b"
```

When it prints `listening`, set `T` in terminal 2 to the path terminal 1 printed and start A:

```sh
cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --stats --net "unixgram:$T/a.sock,peer=$T/b.sock,mac=02:6d:76:00:00:01" --cmdline "console=ttyAMA0 quiet macvmm.test=net-a"
```

(`Ctrl-A x` quits B if A never connects.) VM A:

:::term source=captures/19-net-a.txt

VM B:

:::term source=captures/19-net-b.txt

Ping 5/5 and equal hashes (yours will differ: the bytes are random). A's `tx_packets=23192` equals B's `rx_packets`, bytes too: no frame lost between the sockets.

Now the opening puzzle: B's `tx_dropped=6`, and six `Send` warnings. `send_to` fails when nothing is bound at the peer path: before A starts and after A powers off. Frames in those windows are dropped and counted (a rerun of ours dropped 3). Not a bug but the contract: a network may lose frames, and the protocols above it are built for that.

## Two bytes off

Back to the Predict. We changed `split_at(HDR_LEN)` to `split_at(10)` in `tx_one` in a copy of the tree, ran it as VM A, and ran the unmodified reference as VM B:

:::term source=captures/19-legacy-hdr-a.txt

:::term source=captures/19-legacy-hdr-b.txt

B's VMM delivered all 20 of A's frames into B's buffers; B's guest answered none. Here is A's ARP broadcast as B's guest reads it, after the two leftover header bytes (`num_buffers`, written as 0):

| Bytes B reads | Sent as | Read as |
|---|---|---|
| 0 to 5 | `ff ff ff ff ff ff` (broadcast) | `00 00 ff ff ff ff`: a destination that is not B |
| 6 to 11 | `02 6d 76 00 00 01` (A's MAC) | `ff ff 02 6d 76 00`: a "source" that is no NIC |
| 12 to 13 | `08 06` (ARP) | `00 01`: below `0x0600`, so read as an 802.3 length rather than a type; the frame was already discarded for its destination |

The answer is (c), nothing: a frame addressed to somebody else, which a network stack discards without a word. B's two transmitted frames, 70 bytes each, are the size of the IPv6 (Internet Protocol version 6) router solicitation Linux sends when an interface comes up; its seven `Send` drops are the before-A and after-A windows again. Framing is a contract between driver and device, even with no network.

## Breaking it on purpose

**Deliberate breakage 1: wait for a buffer instead of dropping the frame.** In `Net::receive`, replace the `let Some(chain) = a.rx.pop(mem)? else { … }` block by a loop that pops, sleeps 1 ms if the ring is empty, and tries again. It looks kinder. Predict what happens when frames arrive while the guest has posted no buffers; write your guess under `## Q1`.

For "no buffers" on demand, VM B's shell loads the driver but never brings `eth0` up, and this driver posts receive buffers only when it comes up. Meanwhile VM A runs `net-a`, sending ARP requests to B for about 20 seconds. First, the reference:

:::term source=captures/19-iface-down.txt

B's VMM dropped 13 frames (`rx_dropped_no_buffer=13`), and the guest's own `rx_packets` says 0. Only ten warnings appear because warnings are rate-limited (chapter 08); the counter is the truth. Now with the break:

:::term source=captures/19-block-rx.txt

The guest printed `0` and began to power off, then nothing: no `Power down`, no stats. `--timeout 20` and a first SIGTERM did nothing; only the second quit signal (chapter 09) ended it. To see why, we hung it again and ran the macOS `sample` tool, which records where each thread of a process is waiting (`man sample`), filtered:

:::term source=captures/19-block-rx-sample.txt

Read the words inside the mangled names; the numbers are lengths. `virtio-net-rx-0` sleeps inside `Net::receive`, waiting for a buffer while *holding the device mutex*. `vcpu0` is in `VirtioMmio::reset`, waiting for that mutex: power-off wrote 0 to `Status`, and a reset takes the device lock. The main thread waits in `join` for the vCPU.

The RX thread waits for the guest, whose only vCPU waits for the RX thread. `--timeout` kicks a vCPU out of the guest, but this one is stuck in our code. With `eth0` down the guest touched no register of this device until power-off; any access that takes the device lock, such as a transmit `QueueNotify`, would stall the same way.

To run it yourself, make the edit in `learner/` and build it. In terminal 1, inside `learner/`, with your main run's `T`:

```sh
(sleep 2; echo 'modprobe virtio_mmio; modprobe virtio_net; sleep 8; cat /sys/class/net/eth0/statistics/rx_packets; poweroff -f') | cargo run -q -p macvmm -- run --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --timeout 20 --stats --net "unixgram:$T/b.sock,peer=$T/a.sock,mac=02:6d:76:00:00:02" --cmdline "console=ttyAMA0 quiet"
```

Within three seconds, start A as before (late, and B exits normally with `rx_dropped_no_buffer=0`). When A has exited, in a third terminal run `B=$(pgrep -f "macvmm run .*$T/b.sock")`, `sample "$B" 1`, and `kill "$B"` twice. Undo the edit.

The misconception this exposes: "waiting is safer than dropping". Here the waiting device froze the guest. The rule: a device never waits for its guest, and every host-side wait has a timeout.

## What "no entitlement" buys, and what it does not

`macvmm` is signed ad hoc with one [entitlement](/build-your-own/vmm/glossary/#entitlement), `com.apple.security.hypervisor`. Apple's library for putting VMs on real networks, [`vmnet.framework`](https://developer.apple.com/documentation/vmnet), needs root or `com.apple.vm.networking`, a restricted entitlement that gets an ad-hoc signed program killed at launch (the `codesign-entitlements` primer). Unix datagram sockets need neither: to macOS they are files, guarded by owner and mode. That also limits `unixgram:` to other programs on this Mac: no internet, no DHCP server (Dynamic Host Configuration Protocol; our guests set addresses by hand), no other machine.

[**Containment**](/build-your-own/vmm/glossary/#containment) means limiting what a program can do after an attacker has taken it over. "No network entitlement" describes what `macvmm` asked for, not what it can do: any macOS process may open internet connections without one, so a guest that took over our VMM could too. The repository's audit (`cargo run -p xtask -- audit`) allows networking code in `crates/vmm` only in the `net` module and a short allow-list: a rule for reviewers, not a run-time barrier. The barrier is chapter 25's sandbox, rules the kernel enforces.

> **Try it.** Run B as in the main run, plus `--timeout 20`. Three seconds later, start a third VM, C, with A's command but `LOCAL` set to `$T/c.sock`. B never named `c.sock`, so C's ping should fail; check B's `rx_dropped_foreign`.

:::term source=captures/19-foreign-c.txt

:::term source=captures/19-foreign.txt

C printed `FAILED ping 0/5`; B dropped all 17 of its frames (`rx_dropped_foreign=17`). (C's three `Send` drops came after B exited; B's eight went to `a.sock`, where nothing is bound.) Any program running as you can write to your socket file; this check keeps it off your guest's wire.

## Your turn

In `learner/`, build what this page showed, with the names the contract tests use:

1. `crates/vmm/src/virtio/net.rs`: `Net` (`new(mac, backend)`, `receive` returning `RxOutcome`: `Delivered`, `NoBuffer`, `ChainUnusable`, `BadLength`; `stats`; `spawn_rx`), `HDR_LEN`, `NET_QUEUE_SIZE` (256), `NET_CONFIG_LEN`, `RX_QUEUE`, `TX_QUEUE`, `F_MAC`, `RX_BUFFER`; `DEVICE_ID_NET = 1` in `virtio/mod.rs`; `Companion` in `virtio/worker.rs`.
2. `net/backend.rs` (`NetBackend`) and `net/unixgram.rs`: `UnixgramBackend` (`bind`, `local`, `peer`, `rx_dropped_foreign`, `send`, `recv`), `PeerSpec`, `probe`, `SOCKET_BUFFER`. The tests also cover `learn`: lock onto the first absolute sender path, once.
3. `set_socket_buffers` in `hvf::host`, with a `// SAFETY:` comment.
4. In `backend/hostio.rs`: `check_socket_dir`, `open_unixgram` with the `accept` spellings, and the `InputError` variants `NetDir`, `NetNotSocket`, `NetLiveSocket`.
5. In `vmm::config`: `NetSpec` (`local`, `peer`, `mac`), `NetPeer` (`Path` or `Learn`), and `VmConfig::validate`, refusing a NIC that is its own peer or two NICs with one `LOCAL`.
6. `--net` in `cli.rs`, and `attach_net_rx` in the machine.

Your journal has a Predict entry and four questions: Q1 and Q2 with the break's captures and `sample` in front of you, Q3 after the last section, Q4 the open question below. Stuck? `scripts/learner hint 19`.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the contract tests (the 18 from sitting A and 12 in `crates/vmm/tests/unixgram.rs`), the runs on your Mac, and the journal check. For a failing test's full output, copy `crates/vmm/tests/unixgram.rs` into `learner/crates/vmm/tests/` and run `cargo test -q -p vmm --test virtio_net_hostile --test unixgram` inside `learner/`. On the reference:

:::term source=captures/19-reference-tests.txt

The whole checkpoint, on the reference:

:::term source=captures/19-checkpoint.txt

Besides the two-VM run, it checks that a regular file at `LOCAL` is refused with exit code 2 and left untouched (the trailing `NET-4` is the reference's own label for that rule), and that the bare-metal virtio probe finds device 1 in slot 0 (its warnings are narrow-read tests, as in chapter 15):

:::term source=captures/19-bind-refuses-file.txt

:::term source=captures/19-virtio-probe.txt

What now works:

- a virtio network card that copies, checks and caps every transmitted frame and drops and counts instead of waiting;
- a `unixgram` backend joining two VMs with no entitlement and no root, accepting datagrams only from the peer;
- two guests moving 32 MiB with matching hashes, `--stats` accounting for every lost frame.

The next chapter starts from this state: the reference at the end of chapter 19, tag `ch-19`.

### What's next

Every device in Part VII now has its own threads, each taking the device lock for one request at a time, beside one vCPU. Chapter 20 gives the guest many CPUs, and today's deadlock becomes one of several ways their threads can wait for each other.

### Open question

Our virtio-net is slow by design: at most 1514 bytes per frame, each copied out of guest memory and through a socket, with no offloads. If you could add one offload first (checksum offload, segmentation offload, or mergeable receive buffers), which would buy the most speed for the 32 MiB transfer, and what new guest-written field would your device then have to parse and distrust?

## Spec hunt

- virtio 1.2, section 5.1.6 "Device Operation", and its legacy-interface note on the header: when is `struct virtio_net_hdr` 10 bytes long, and which feature bit decides it for a legacy device?
- virtio 1.2, sections 5.1.6.3.2 "Device Requirements: Setting Up Receive Buffers" and 5.1.6.4.1 "Device Requirements: Processing of Incoming Packets": into how many descriptors may one packet go when `VIRTIO_NET_F_MRG_RXBUF` was not negotiated, and what must the device then write into `num_buffers`?
