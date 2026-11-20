---
title: virtio-blk: a root filesystem that persists
part: VII
chapter: VII.4
id: 18
runs: mac+browser
minutes: 330
prereqs: [17]
start_tag: ch-17
labs: [blk-request, durability-ladder]
command: scripts/checkpoint.sh 18
expect: CHECKPOINT 18 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** the virtio-blk request (header, data, status) and its types; the feature bits `RO`, `FLUSH` and `SEG_MAX`; bounds checks on every request; `IOERR` or `UNSUPP` versus a device reset; bounce buffers; durability as part of the device contract (write-back with FLUSH, write-through without); locking the image against a second virtual machine monitor (VMM).
- **Core, from earlier:** checked arithmetic and guest-memory copies (chapter 04); `--on-reset` and the reset call of PSCI, the Power State Coordination Interface (chapter 08); the test initramfs and its `macvmm.test=` cases (chapter 14); the virtio-mmio transport and `DEVICE_NEEDS_RESET` (chapter 15); descriptor chains, copy-then-validate and the used length (chapter 16); the worker thread and the `VirtioDevice` trait (chapter 17).
- **Primers (read first):** `block-storage` (sectors and raw images, ext4, `root=`, the page cache, `fsync` versus `F_FULLFSYNC`, `pread` and `pwrite`, advisory locks, APFS (Apple File System) clones).
- **Primers (review):** `linux-boot-sequence` (how the kernel finds its root filesystem, and kernel modules).
- **Pointers:** `man fsync` and `F_FULLFSYNC` on macOS (shown in the body); APFS clones with `cp -c`; kernel modules and squashfs (an Aside); Homebrew's `e2fsprogs`.
- **Forward definitions:** a second vCPU (virtual CPU) rewriting a request while the worker reads it (chapter 20); confining the VMM with the macOS sandbox (chapter 25). Each is defined at first use.
:::

Here is one line a Linux guest can type: `dd if=/dev/zero of=/dev/vda bs=4k count=1 conv=fsync`. It writes 4 KiB to its disk and then asks for proof that those bytes would survive a power cut. That proof is a request our virtual machine monitor (VMM) must answer, and we can answer it three ways: by asking macOS for `fcntl(F_FULLFSYNC)`, by asking for plain `fsync`, or by doing nothing and saying "done". All three pass every test in this chapter. One of them is telling the truth.

:::predict Run that line 100 times in a row, each write followed by its flush. Predict the time of the 100 for each version (`F_FULLFSYNC`, `fsync`, nothing), as rough ratios. Then: with the do-nothing version, you `kill -9` the VMM right after the guest's `dd` returns. Are the guest's bytes in the image file afterwards?
Write your guesses and one sentence of reasoning under `## Predict` in your journal. The section "What FLUSH promises" runs all three, and the second break kills the VMM.
:::

This chapter finishes row 8 of chapter 00's problem ledger, bulk I/O (input and output) at reasonable cost, for storage: chapters 15 to 17 built the rings, the doorbell and the worker, and here a disk goes behind them. By the end, Linux boots from an ext4 root filesystem on your virtual disk, reboots inside the same process, and finds its file still there.

:::objectives
- Implement virtio-blk (device ID 2) from section 5.2 of the virtio 1.2 specification: IN, OUT, FLUSH and GET_ID, offering `RO`, `FLUSH` and `SEG_MAX`.
- Bounds-check every request with checked arithmetic against the capacity, answer `IOERR` before touching the file, and move data through capped, zeroed bounce buffers.
- Back the device with a raw image through `pread` and `pwrite`, lock it against a second VMM, and give FLUSH real durability with `File::sync_all` (`F_FULLFSYNC` on macOS); measure what that costs.
- Diagnose an unchecked `sector * 512` from a failing hostile test, and explain why a FLUSH that does nothing fails no test.
- Boot Linux from an ext4 root on `/dev/vda` and show the data persists across an in-process reboot, with a clean `e2fsck` afterwards.
:::

**Before you start.** From the repository root, run `scripts/learner start 18`; it copies this chapter's journal to `learner/journal/18.md`. Read the `block-storage` primer first. You need Homebrew's [`e2fsprogs`](https://formulae.brew.sh/formula/e2fsprogs) (the primer installs it), the kernel and test initramfs from chapter 14, and, for the last section, `scripts/fetch.sh rootfs`.

**Where to run things.** The disk tools (`cargo xtask mkdisk` and `mkrootfs`) run at the repository root; everything else runs inside `learner/`, so that `cargo run` builds *your* VMM, with the kernel in `../.cache/macvmm/` and the disk images beside you. Our captures come from a workspace laid out the same way, holding the reference's code. At the repository root, make a 64 MiB test disk of known pseudo-random bytes:

:::term source=captures/18-mkdisk.txt

Then `cd learner` and note its hash:

:::term source=captures/18-host-sha.txt

## What a disk request must say

To use a disk, a driver must say *which* sectors, *which direction*, and *where in memory* the bytes go, and it must learn *whether it worked*. Chapter 16 gave us the shape: a [descriptor chain](/build-your-own/vmm/glossary/#descriptor-chain), readable buffers first, writable buffers after.

So a [virtio-blk request](/build-your-own/vmm/glossary/#virtio-blk-request) is a chain of three parts: a small header the device reads (what to do, and where on the disk), the data, and last one byte the device writes to say how it went. With the answer *inside* the request, the used ring tells the driver the request is finished and the byte tells it the outcome; no register to read afterwards.

That is the [**virtio-blk**](/build-your-own/vmm/glossary/#virtio-blk) device, device ID 2, with one queue named `requestq`. Section 5.2.6 of the virtio 1.2 specification calls the layout `struct virtio_blk_req`:

```text
OUT (write)
 readable by the device                        |  writable
+---------------------------+---------------+  |  +--------+
| le32 type | le32 reserved |               |  |  | status |
| le64 sector               | data: N bytes |  |  | 1 byte |
+---------------------------+---------------+  |  +--------+

IN and GET_ID (read)
 readable                      |  writable by the device
+---------------------------+  |  +---------------+--------+
| le32 type | le32 reserved |  |  |               | status |
| le64 sector               |  |  | data: N bytes | 1 byte |
+---------------------------+  |  +---------------+--------+
```

*One request, as one chain, in each direction; FLUSH carries no data. `le32` and `le64` are little-endian 32- and 64-bit integers, the byte order of every virtio field.*

The `sector` counts 512-byte units, whatever the disk's real block size (the primer's first table). The type says what to do, and the status says how it went:

| Type | Value | Data | Meaning |
|---|---|---|---|
| IN | 0 | writable | read `N` bytes from byte `sector × 512` |
| OUT | 1 | readable | write `N` bytes at byte `sector × 512` |
| FLUSH | 4 | none | make every completed write durable |
| GET_ID | 8 | writable | a 20-byte serial number |
| (anything else) | | | status `UNSUPP` (2) |

Status values: `OK` (0), [`IOERR`](/build-your-own/vmm/glossary/#ioerr) (1), the request was understood and failed, and [`UNSUPP`](/build-your-own/vmm/glossary/#unsupp) (2), the type is unknown. In the reference, as constants:

:::code anchor=blk_req_types file=crates/vmm/src/virtio/blk.rs

One rule from section 2.7.4 shapes the parser: a device must not assume how the parts are split across descriptors. So the reference reads all readable descriptors as one byte stream (header, then write data) and all writable ones as another (read data, then the status as the last byte).

## What the device tells the driver

The driver reads the disk's size from the configuration space (chapter 15). Our device fills 24 bytes of it:

| Offset | Field | Size | Our value |
|---|---|---|---|
| 0 | `capacity` | le64 | the disk's size in 512-byte sectors |
| 8 | `size_max` | le32 | 65536, but its feature bit is not offered, so drivers ignore it |
| 12 | `seg_max` | le32 | 126 |
| 16 | `geometry` | 4 bytes | zero (not offered) |
| 20 | `blk_size` | le32 | 512 |

The feature bits are named `VIRTIO_BLK_F_FLUSH` and so on in the specification; we drop the prefix. We offer `SEG_MAX` (at most 126 data buffers per request, QEMU's choice: a 128-entry indirect table minus the header and the status), `BLK_SIZE` (a preferred block size of 512), `FLUSH` (a write cache exists, and FLUSH requests are accepted), `RO` for a disk opened with `,ro`, `VERSION_1` (chapter 15), which every device offers, and `INDIRECT_DESC` (chapter 16), which blk is the first of our devices to offer. We do *not* offer `SIZE_MAX`: FreeBSD refuses a disk whose `size_max` is smaller than its own largest transfer, so 64 KiB is only our device's internal chunk size (next section).

Labels such as BLK-3 or VQ-9 in the comments of this chapter's code are the reference's own test and threat-model labels; ignore them.

:::code anchor=blk_device_features file=crates/vmm/src/virtio/blk.rs

Of the bits the driver accepts, only `FLUSH` changes the device's behaviour. Its meaning waits for the second half of this chapter:

:::code anchor=blk_ack_features file=crates/vmm/src/virtio/blk.rs

## Every field is hostile

Every field of a request comes from the guest, and a [hostile guest](/build-your-own/vmm/glossary/#hostile-guest) chooses them to hurt us. Chapter 16's walk already checked that every descriptor lies inside guest RAM, without loops, readable before writable. The device adds its own checks, in this order:

1. **There must be a status byte.** With no writable byte at all, there is nowhere to put any answer, so the chain breaks the protocol itself: [`DEVICE_NEEDS_RESET`](/build-your-own/vmm/glossary/#device-needs-reset), as for a broken ring.
2. **The header is 16 readable bytes, copied once** into a local `BlkHeader` ([copy-then-validate](/build-your-own/vmm/glossary/#copy-then-validate)). Fewer readable bytes: `IOERR`. Copied once, because a second vCPU (virtual CPU) of the same guest can rewrite memory in the middle of a request (chapter 20 adds it), and a check on one read and a use of another would see two different headers.
3. **At most 128 descriptors in all** (126 data buffers, the header, the status): `IOERR` beyond. A driver that splits the header across two descriptors gets one data buffer fewer.
4. **A known type, moving data one way only**: an unknown type is `UNSUPP`; an IN with readable data, an OUT with writable data, or a FLUSH with any data is `IOERR`.
5. **No writes to a read-only disk**: an OUT on a `,ro` disk is `IOERR`.
6. **The range must be inside the disk**: the length a whole number of sectors and at most about 8 MiB (126 × 64 KiB), `offset = sector × 512` and `offset + length` both without overflow, and the end at most the capacity. Else `IOERR`, and the file is never touched. The 8 MiB cap bounds how long one request holds the device, not memory. The driver is never told this number (there is no `size_max`), so an honest driver tuned for larger requests would also get `IOERR`; Linux, FreeBSD and U-Boot by default stay well below it.

Notice the split: a bad *request* gets a status and the queue carries on; a bad *chain*, with no place for a status, resets the device. Chapter 16's open question, `[writable header, readable data, readable status]`, never reaches blk, because the walk refuses it; rule 1 catches its cousin with no writable byte at all.

Rule 1 lives in `execute`, the only place that writes the status:

:::code anchor=blk_status_rule file=crates/vmm/src/virtio/blk.rs

Rules 2 and 3, in `parse`:

:::code anchor=blk_parse_header file=crates/vmm/src/virtio/blk.rs

Then the dispatch on the type, whose match guards are rule 4; rule 5 opens the OUT arm:

:::code anchor=blk_execute_io file=crates/vmm/src/virtio/blk.rs

and the rest, ending with the wrong-direction and unknown-type answers:

:::code anchor=blk_execute_rest file=crates/vmm/src/virtio/blk.rs

And rule 6, the check this chapter's first break removes:

:::code anchor=blk_bounds_check file=crates/vmm/src/virtio/blk.rs

In the `blk-request` lab, build a chain field by field and watch which rule fires:

:::lab blk-request

If the lab does not load: 512 bytes at sector 64 of a 64-sector (32 KiB) disk fails rule 6, because `64 × 512 + 512 = 33280 > 32768`: status `IOERR`, used length 1.

> **Security.** Two different addresses arrive in every request. The sector is an offset into the *image file*, which the guest already owns; the descriptor addresses point into *guest RAM*, which lives inside our process. A bad sector check corrupts data; a bad descriptor check lets an IN request copy disk bytes over the VMM's own memory. Journal question 2 asks you to work out both.

## Bytes through a bounce buffer

Data moves between the file and guest memory through a host buffer, a [**bounce buffer**](/build-your-own/vmm/glossary/#bounce-buffer), and three rules make it safe. It is at most 64 KiB, so a request for 8 MiB costs 64 KiB of memory. It is allocated fresh and **zeroed** for each piece, so a short read can never hand the guest bytes left over from another request or another disk. And a short read or an I/O error is `IOERR`, with the used length counting only the bytes really copied (chapter 16's rule). A `pread` may return fewer bytes than asked: at end of file, for instance if someone shrank the image after we opened it. So the backend's `read_full` retries until it has them all or learns why not.

:::code anchor=blk_data_path file=crates/vmm/src/virtio/blk.rs

The backend underneath is the primer's positional I/O: `pread` and `pwrite` take the offset as an argument, so threads share no file position. The device needs five methods from a disk (capacity, read-only, read at, write at, sync), each one standard-library call for a file:

:::code anchor=file_backend_read_at file=crates/vmm/src/backend/file.rs

## Your turn: build the device

The breaks below edit *your* device, so build it now. In your workspace, `learner/`:

1. `crates/vmm/src/virtio/blk.rs`: the request parser and the six rules in order, the bounce-buffer data paths, FLUSH through the backend (its meaning comes in the second half; for now call the backend's `sync`), and the features and configuration space above. GET_ID: `disk_serial(index)` returns `macvmm-disk<index>`, padded with zero bytes to 20, and the device writes min(20, data bytes) of it.
2. `crates/vmm/src/backend/file.rs`: a `BlockBackend` trait (capacity, read-only, read at, write at, sync), `read_full` and `write_full`, and a `DiskFile` that checks for a regular file, fixes the capacity and takes the lock (its section comes later; the tests here use in-memory disks).
3. Copy `crates/vmm/tests/virtio_blk_hostile.rs`, `blk_short_read.rs` and `blk_budget.rs` into `learner/crates/vmm/tests/` (chapter 16 already gave you `virtio_support/`). Their `use` lines name the items they test (such as `req`, `blk_status`, `disk_serial`, `read_full`); give yours the same names and paths.

The tests also import these constants. Give yours the same values:

| Constant | Value | Why |
|---|---|---|
| `BLK_QUEUE_SIZE` | 256 | the requestq's size |
| `SIZE_MAX` | 64 KiB | one bounce buffer, the chunk size; its feature bit is not offered |
| `SEG_MAX` | 126 | data buffers per request, QEMU's choice |
| `BLK_MAX_DATA` | `SEG_MAX × SIZE_MAX`, about 8 MiB | rule 6's cap |
| `BLK_CHAIN_MAX` | `2 × BLK_QUEUE_SIZE × u32::MAX`, about 2 TiB | the total cap passed to chapter 16's walk |
| `BLK_BATCH_BYTES` | `2 × BLK_MAX_DATA` | a batch of requests ends after this many data bytes, or after one sync |
| `BLK_CONFIG_LEN` | 24 | the configuration space in the table above |

One trap hides in `BLK_CHAIN_MAX`. Pass chapter 16's walk a total cap far above 8 MiB, so that an oversized but well-formed request reaches rule 6 and gets `IOERR`. If you pass `BLK_MAX_DATA`, the walk calls the chain too large, which means `DEVICE_NEEDS_RESET`, and one big request kills the disk.

The batch limits matter for `blk_budget`: the worker serves requests in batches and releases the device between them, so one batch never holds the device for long, even when every request is slow. Run the three suites from inside `learner/`; against the reference they print:

:::term source=captures/18-reference-tests.txt

The `blk_budget` line on standard error is information. The figure it checks is the time per batch ("max ... per batch", under 250 ms). The observer's worst wait is printed but not checked, because Rust's standard `Mutex` is not fair: the worker can take the lock again before a waiting thread does.

Stuck? `scripts/learner hint 18` climbs from a nudge to the reference file, and `scripts/learner lifeline MODULE` lends you a reference module (yours is kept as `.mine`) so you can move on.

## Breaking it on purpose

**Deliberate breakage 1: an unchecked `sector * 512`.** In your `bounds_check`, replace `checked_mul` and `checked_add` with `wrapping_mul` and `wrapping_add`, which is what C's `*` and `+` do on 64-bit unsigned numbers. Predict: which hostile tests fail, and how? Then run the device's host tests (no virtual machine needed):

:::term source=captures/18-break-wrap.txt

Read `sector_times_512_overflow_is_ioerr_not_a_wrap` first. It asks for sector `2^55`; `2^55 × 512 = 2^64` wraps to 0, so the check saw "offset 0, end 512" and the device answered `OK` (`left: 0`; the test wanted `IOERR`, 1) with sector 0's contents. A wrapped offset is a valid offset, only the wrong one.

In `sector_past_the_end_is_ioerr_and_never_reaches_the_disk`, the sector is `u64::MAX / 512`. Times 512 that is `2^64 − 512`, which fits; adding the length wrapped the *end* to 0, so `0 <= capacity` passed and the huge offset reached the test's in-memory disk. That is the `checked_add` half.

The third, `random_requests_match_the_model`, sends up to 10,000 random requests and compares each answer with a simple model of the disk. One random OUT used a sector near `u64::MAX`; both the offset and the end wrapped, our check let it through, and it reached the in-memory disk's `write_at`, whose own `off + buf.len()` overflowed (line 86 of the test file). The panic is in the test's code, but the bug is ours: the disk should never have seen that offset.

Now try the version a Rust programmer writes by habit, plain `sector * SECTOR_SIZE` and `offset + len`:

:::term source=captures/18-break-mul.txt

The same three tests fail again, but now every panic is inside our `bounds_check`: two with `attempt to multiply with overflow`, and the past-the-end one with `attempt to add with overflow`, because there the multiply fit and the end overflowed. `cargo test` builds with overflow checks on, as every debug build does, so the wrap became a panic. This workspace also turns the checks on for release builds (in `Cargo.toml`), so the shipped VMM would stop the same way instead of wrapping. Better than reading sector 0, but a crash the guest can trigger at will is still a bug. Answer journal question 1 now, while the break is fresh.

What you saw: three hostile tests fail, first with wrong data, then with a crash. The misconception: "the file system call will reject a bad offset". The tool that found it: the hostile host tests, which ask for the sectors nobody would.

## Linux reads your disk

**Step 4 of your build.** Wire the device into your VMM as chapter 17 wired rng. `--disk FILE[,ro]` (repeatable; the first disk becomes `/dev/vda`) opens the image with `DiskFile`, wraps it in a `Blk`, and gives it a virtio-mmio slot and a device tree node.

Then, from inside `learner/`, boot the test initramfs with its `vda` case, which hashes the whole disk from inside the guest:

:::term source=captures/18-vda-read.txt

Linux read all 131,072 sectors (64 MiB) through your rings and computed the hash `shasum` printed on the Mac. The `vda-write` case writes 1 MiB of the text `macvmm` at byte 8 MiB with `conv=fsync`, a FLUSH; look at those bytes on the host afterwards:

:::term source=captures/18-vda-write.txt

:::term source=captures/18-vda-write-xxd.txt

Now the same image with `,ro`. The device offers `RO`, and Linux marks the disk read-only (`ro=1`):

:::term source=captures/18-vda-ro.txt

Before this run, `shasum -a 256 disk.img` printed `61da37b8…e5ee`; after it, the same:

:::term source=captures/18-sha-after-ro.txt

## Booting the shell on your disk

The test cases run a script and power off. For your own commands, boot the `shell` case instead:

```sh
cargo run -q -p macvmm -- run --mem 512M --kernel ../.cache/macvmm/Image-virt --initrd ../.cache/macvmm/initramfs-test.img --disk disk.img --on-reset exit --timeout 100 --cmdline "console=ttyAMA0 panic=-1 quiet macvmm.test=shell"
```

At the `/ # ` prompt, load the drivers and give them a second to find the device: `modprobe virtio_mmio; modprobe virtio_blk; sleep 1`. The test cases load these modules for you; the shell does not. Leave with `poweroff -f` (chapter 14). `--timeout 100` stops the VMM after 100 seconds in any case, so anything you do beside it, such as the lock test below, must start before then.

The `vda-ro` case hid `dd`'s own message. At the shell on the same disk opened `,ro`, the refusal reads:

:::term source=captures/18-ro-dd.txt

`Operation not permitted` is Linux's block layer refusing the write itself, because the disk is marked read-only; an `IOERR` from our device would have reached `dd` as an I/O error. So this write never reached rule 5; the open question at the end asks what rule 5 should do when a driver ignores the bit.

> **Try it.** At the shell on your read-write disk, type `cat /sys/block/vda/serial; echo` (the `echo` ends the line, since the serial has no newline). Reading that file makes Linux send a GET_ID request. What does it print, and how many bytes of the 20 did your device write? Look for 12 visible characters; the device wrote all 20, the other 8 being zero padding, so the used length was 21 with the status byte.

:::term source=captures/18-get-id.txt

## One image, one VMM

Two VMMs writing one image means two guest caches, each sure it owns every block: corruption. So the backend takes an [image lock](/build-your-own/vmm/glossary/#image-lock) when it opens the file, with the primer's advisory `flock`: an exclusive lock for read-write, a shared one for `,ro` (several readers may share a disk, but never beside a writer). It also refuses anything that is not a regular file, such as `/dev/disk0`, your Mac's whole internal drive:

:::code anchor=file_backend_new file=crates/vmm/src/backend/file.rs

In one terminal, boot the shell on `disk.img` (the command from "Booting the shell on your disk"), and leave it at its prompt. In a second terminal, also inside `learner/`, start a second VMM on the same image:

:::term source=captures/18-locked.txt

Exit code 2, before any virtual machine exists. The lock belongs to the open file, so a crashed VMM never leaves an image locked.

:::stopping-point Good place to stop. Your device reads, writes and refuses correctly. The second half is about what "written" means, and needs about 2 hours.

## What FLUSH promises

When a guest's `OUT` completes, where are the bytes? In the Mac's page cache, where `pwrite` copied them; the macOS kernel writes them to the drive later. That is a [**write-back**](/build-your-own/vmm/glossary/#write-back) cache, and the `FLUSH` feature bit is how a device admits to one. The specification's deal (section 5.2.6) is that a write is stable once a later FLUSH has completed. A guest filesystem builds its safety on that deal: ext4 writes its journal, sends FLUSH, and only then writes the commit record that says the journal is valid.

So [FLUSH](/build-your-own/vmm/glossary/#flush) must not answer `OK` until the data would survive a power cut. If the driver did not accept `FLUSH`, it has no way to ask, so the device must be [**write-through**](/build-your-own/vmm/glossary/#write-through) instead: sync after every write, before answering. The reference's write path ends with exactly that when `writeback` (true only if the driver accepted `FLUSH`) is false:

:::code anchor=blk_write_path file=crates/vmm/src/virtio/blk.rs

Add that branch to your own write path now.

Now the opening Predict. We ran the flushed writes in three builds: the reference, a copy whose `DiskFile::sync` calls plain `fsync`, and a copy whose `DiskFile::sync` does nothing. In each, at the shell, after loading the drivers, we timed one 64 MiB write with a single flush at the end, then the 100 flushed 4 KiB writes:

```sh
time dd if=/dev/zero of=/dev/vda bs=1M count=64 conv=fsync
time sh -c 'for i in $(seq 1 100); do dd if=/dev/zero of=/dev/vda bs=4k count=1 seek=$i conv=fsync 2>/dev/null; done'
```

These runs overwrite `disk.img` with zeros. Time your own build and use our numbers for the others (the terminal's echo wraps the long line).

:::term source=captures/18-flush-full.txt

:::term source=captures/18-flush-fsync.txt

:::term source=captures/18-flush-noop.txt

The 100 flushed writes took 0.47 s with `F_FULLFSYNC`, 0.08 s with `fsync` and 0.04 s with nothing: about 4.7 ms per honest flush, six times `fsync` and more than ten times nothing (busybox's `time` rounds to 10 ms; your drive will differ). The single 64 MiB write cost about the same in all three: the price is per flush, not per byte.

Why is `fsync` so much cheaper? Read the manual on your Mac:

:::term source=captures/18-man-fsync.txt

On macOS, `fsync` sends the data to the drive, which may keep it in its own volatile cache; Linux's `fsync` also flushes that cache, which macOS keeps for `F_FULLFSYNC`. A guest's FLUSH means the Linux promise, so it needs `F_FULLFSYNC`. In Rust that is `File::sync_all`, and we checked the pinned standard library rather than trust a comment. To check it yourself, run `rustup component add rust-src` first (it only adds the standard library's source files), then the `grep` shown:

:::term source=captures/18-std-fullfsync.txt

`sync_all` calls this `fsync` method, and on Apple targets it is `fcntl(fd, F_FULLFSYNC)`. The reference's `DiskFile::sync` is one line, `self.file.sync_all()`, and FLUSH answers `OK` only after it returned `Ok`. Answer journal question 3 now.

The primer's `durability-ladder` lab follows a write through each cache, then kills the process or the power:

:::lab durability-ladder

If the lab does not load: a killed process loses nothing that reached the page cache; a power cut loses everything not yet on the drive's permanent storage, including what plain `fsync` left in the drive's cache.

**Deliberate breakage 2: FLUSH that does nothing (one you explain rather than see fail).** In `crates/vmm/src/backend/file.rs`, make `DiskFile::sync` return `Ok(())` without calling anything; leave the device's call to it alone. Predict: which test fails? Run the three host suites:

:::term source=captures/18-noop-tests.txt

Every test passes. The test `flush_calls_sync_once_and_reports_its_failure` counts `sync` calls on an in-memory disk: it proves the device asks, not that the backend keeps its promise. Now the opening's second question. Keep the break-2 build: this is the do-nothing FLUSH from the Predict. From inside `learner/`, make a fresh disk, so the 8 MiB mark starts random, and look at it:

```sh
(cd .. && cargo xtask mkdisk --size 64M --seed 1 --out learner/disk.img)
```

:::term source=captures/18-kill9-before.txt

In terminal 1, boot the shell on `disk.img`, and at the prompt type these two lines (the terminal's echo wraps the long one in the capture below):

```sh
modprobe virtio_mmio; modprobe virtio_blk; sleep 1
yes macvmm | head -c 1048576 > /tmp/p; dd if=/tmp/p of=/dev/vda bs=1M seek=8 count=1 conv=fsync
```

As soon as `dd` prints its summary, kill the VMM from terminal 2, inside `learner/`. `lsof -a -c macvmm -t disk.img` prints the process ID of the `macvmm` that holds the image, and nothing else that happens to have it open:

:::term source=captures/18-kill9.txt

:::term source=captures/18-kill9-kill.txt

:::term source=captures/18-kill9-after.txt

The bytes are in the file: `pwrite` had already handed them to the macOS kernel, which outlives our process. (The persistence run in the next section passes on this build too.)

What would show the bug? With the do-nothing FLUSH, the data may still sit in the Mac's page cache, so a host crash or a power loss loses it. Plain `fsync` is shown up only by a power cut while the data sits in the drive's own cache. Neither can be tested honestly on a laptop.

What you saw: nothing, except cheaper flushes. The misconception: "the guest's filesystem keeps the disk consistent, so the VMM can cache freely"; the filesystem is consistent only because FLUSH means durable. The tool that finds it: reading the contract (the specification and `man fsync`), not a test. Put it back.

## A root filesystem that persists

Everything so far ran from the initramfs, a filesystem in RAM. Now the disk becomes the guest's root filesystem, the one `/` lives on (the `linux-boot-sequence` primer). With an initramfs, its init program picks the root itself. Ours always mounts `/dev/vda` and switches to it with `switch_root`; the `root=/dev/vda` on the command line only records the convention a stock initramfs would read.

At the repository root, build an ext4 image of Alpine's minimal root filesystem in `learner/` with the course's builder, which uses `mkfs.ext4` from `e2fsprogs`:

:::term source=captures/18-mkrootfs.txt

File owners need root privileges, which the builder does not have. File modes it holds back on purpose, so that downloaded bytes never become executable programs on the Mac. It records both, and the guest applies them on its first boot (the "modes" and "ownership" lines below).

Back inside `learner/`, clone the image, so the run never writes the image you built. `cp -c` makes an APFS (Apple File System) clone, a copy-on-write copy that costs no space until one side changes (`man cp`). Chapter 22 uses the same trick for FreeBSD's disk.

:::term source=captures/18-clone.txt

Alpine's ext4 driver is a module, shipped in a separate image, `modloop-virt`; the run attaches it as a second, `,ro` disk, `/dev/vdb`, and the test initramfs loads ext4 from it before mounting `/dev/vda`.

> **Aside.** A kernel module is a piece of the kernel kept in a separate file and loaded at run time, so one kernel can serve many machines. `modloop-virt` is a squashfs image, a compressed read-only filesystem the kernel mounts directly ([squashfs documentation](https://docs.kernel.org/filesystems/squashfs.html)).

The `rootfs` case does the rest. Boot 1 writes 16 MiB of random bytes and their hash to `/persist.bin` and `/persist.sha` on the ext4 root, then reboots with a PSCI reset call; with the default `--on-reset reboot`, our VMM rebuilds the virtual machine inside the same process, over the same open disk (chapter 08). Boot 2 hashes the file again:

:::term source=captures/18-rootfs.txt

Two boots, one hash. The `guest reset` line comes from our VMM's own standard error, which no guest byte reaches, so the guest cannot fake the reboot. Last, check the filesystem from the Mac, read-only:

:::term source=captures/18-e2fsck.txt

> **Security.** Every byte of `root.img` was now chosen by the guest, and `e2fsck` is a host program parsing it. So `-n` opens it read-only, only the clone is checked, and nothing on the Mac mounts it. Chapter 25 confines our VMM itself with the macOS sandbox, a kernel-enforced list of what a process may touch.

We also ran this section on the break-2 build, the do-nothing FLUSH: it passes, and `e2fsck` is clean.

:::term source=captures/18-noop-rootfs.txt

Your build is complete once its write path has the write-through branch from "What FLUSH promises" and your VMM passes this run. Your journal has the Predict entry and questions 1 to 3 by now; question 4 is the open question at the end.

## Explain it back: a hostile chain

This closes Part VII's storage chapters, so here is a request you have not seen. In about 200 words, in your own notes (nothing checks them), say which checks fire, in what order, and what the device does. The disk was opened `,ro`. After chapter 16's walk, the device sees:

| Descriptor | Flags | Length | Contents |
|---|---|---|---|
| 0 | readable | 8 | `type = 1`, `reserved = 0` |
| 1 | readable | 520 | `sector = 0x0080_0000_0000_0000`, then 512 bytes of data |
| 2 | writable | 1 | the status byte |

Score yourself, one point each: every check named, in order, and where it stops; evidence from the chain (the values that decide each check); and a next step someone could test, such as a host test.

Our answer, to read after yours. The walk accepts the chain. Rule 1: descriptor 2 is a status byte. Rule 2: 528 readable bytes, so the header is copied once from two descriptors, as section 2.7.4 allows: OUT at sector `2^55`. Rules 3 and 4 pass. Rule 5 fires: `IOERR`, used length 1, file untouched. The sector is a decoy: on a read-write disk rule 6 refuses it (`2^55 × 512` overflows), and C's arithmetic would have overwritten sector 0.

## Checkpoint

Back at the repository root, run:

:::checkpoint

It runs the three host suites you copied in "Your turn: build the device", three runs on your Mac, and the journal check. `disk-vda` boots the `vda`, `vda-write` and `vda-ro` cases on a fresh random disk, with the host checking every hash; in `disk-lock`, a second VMM beside one holding the image must exit with code 2, read-write and `,ro`; `disk-rootfs` boots a clone of your `learner/rootfs.img` twice, then runs `e2fsck -fn`. Against an unmodified copy of the reference:

:::term source=captures/18-checkpoint.txt

What now works: every request is checked before the file or guest memory is touched; writes are durable when the guest asks, at the honest price; two VMMs cannot share one image; and Linux boots from an ext4 root on your disk and finds its data after a reboot. This is the course's first milestone, "It persists": an unmodified Linux on a VMM you wrote, with a disk that remembers.

The next chapter starts from this state (the reference at the end of chapter 18).

### What's next

A disk answers when asked. A network card does not get to choose: packets arrive whenever the other side sends them, and the guest may have posted no buffer to put them in. Chapter 19 builds virtio-net, with two queues and a backend that needs no networking entitlement at all.

### Open question

The `,ro` run never reached our device's read-only check, because Linux saw the `RO` bit and refused the write itself (`Operation not permitted`). A driver that ignores the bit will send the OUT anyway. Should the device refuse it with `IOERR`, or accept it with `OK` and drop the bytes? Defend your answer from the guest's point of view: what does it believe afterwards? This is journal question 4.

## Spec hunt

- virtio 1.2, section 5.2.6, "Device Operation": where does the specification define when a write is "stable", and what does that mean for a driver that did not accept `VIRTIO_BLK_F_FLUSH` although the device offered it?
- virtio 1.2, section 2.7.4, "Message Framing": why may a device not assume that the 16-byte header sits alone in the first descriptor, and which of our parser's choices does that force?
- `man fcntl` on your Mac, the entry for `F_FULLFSYNC`: what does it promise beyond `fsync`, on which file systems is it implemented, and which drives does the manual say have ignored it?
