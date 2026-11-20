---
title: Block storage: disk images, ext4, durability
slug: block-storage
kind: primer
minutes: 30
runs: mac+browser
required_by: [18]
also_used_by: [22]
labs: [durability-ladder]
command: xxd -s 1080 -l 2 -p disk.img
expect: 53ef
objectives:
- Convert between a filesystem block number, a 512-byte sector number and a byte offset in a raw disk image, and find a file's bytes in the image with `debugfs` and `xxd`.
- Explain why macvmm uses raw images rather than qcow2, and what a sparse file and an APFS clone (`cp -c`) add.
- Sketch ext4 on a whole disk (superblock at byte 1024, block groups, inodes, journal), create one with `mkfs.ext4` and check it with `e2fsck -fn`.
- Explain how `root=/dev/vda` turns a virtio disk into the guest's root filesystem.
- Trace a write through the guest page cache, the VMM, the host page cache and the drive's cache, say what survives a process kill and a power loss, and state what `fsync` and `F_FULLFSYNC` each guarantee on macOS.
- Choose `pread`/`pwrite` over `lseek` plus `read`/`write` for a multi-threaded device, and use an advisory lock (`flock`) to stop two VMMs opening one image.
---

# Where does "write succeeded" actually go?

Three words first, because the whole course uses them. The **host** is your Mac and macOS. The
[**guest**](/build-your-own/vmm/glossary/#guest) is the operating system running inside the virtual
machine, here Linux. The [**VMM**](/build-your-own/vmm/glossary/#vmm) (virtual machine monitor) is our program, macvmm: an ordinary macOS process that pretends to be the
guest's hardware, including its disk.

Here is a 24-line C program (listed in full [further down](#two-threads-one-file-pread-and-pwrite))
that writes 4 KiB to a file 200 times and, after each write, asks the operating system to make it
**durable**, meaning "still there after a power cut". It does that three ways: not at all, with the
`fsync` system call, and with `fcntl(fd, F_FULLFSYNC)`, a macOS-only variant. We define both
properly below. On an Apple M5 Pro with its internal SSD, a typical run printed this:

```text
none  200 writes in      0.8 ms (0.004 ms each)
fsync 200 writes in      7.6 ms (0.038 ms each)
full  200 writes in    642.9 ms (3.215 ms each)
```

Both calls have "sync" in their name. Both returned success every time. One is about eighty times
slower than the other. So which one is telling the truth about your data being safe, and what was
the fast one doing instead?

This matters to us more than to most programmers. In chapter 18 a Linux guest will send our VMM a
`FLUSH` request, meaning "everything I wrote so far must survive a power cut", and we will have to pick
one of these two calls. Pick the fast one and the guest's database is quietly unsafe; pick the slow
one and every guest `fsync` costs milliseconds. By the end of this primer you will know exactly
what each promises, and why macvmm pays for the slow one.

:::prereqs
- [`os-basics`](/build-your-own/vmm/primers/os-basics/): system calls and what the kernel does on your behalf
- [`host-concurrency`](/build-your-own/vmm/primers/host-concurrency/): file descriptors and threads
- [`linux-boot-sequence`](/build-your-own/vmm/primers/linux-boot-sequence/): how the kernel reaches `/init` (for the section on `root=`)
:::

:::objectives
- Convert between filesystem blocks, 512-byte sectors and byte offsets in a raw image.
- Explain raw versus qcow2, sparse files and APFS clones.
- Sketch ext4 on a whole disk; create one with `mkfs.ext4` and check it with `e2fsck -fn`.
- Explain how `root=/dev/vda` makes a virtio disk the root filesystem.
- Trace a write down the durability ladder and state what `fsync` and `F_FULLFSYNC` guarantee.
- Use `pread`/`pwrite` and an advisory `flock` lock correctly in a multi-threaded VMM.
:::

**Terms you will meet**, each defined in bold where it first appears: sector, block device, virtio,
raw image, sparse file, APFS, filesystem block, superblock, magic number, little-endian, inode,
metadata, journal, mount, kernel command line, initramfs, page cache, dirty page, `fsync`,
`F_FULLFSYNC`, file offset, `pread`/`pwrite`, advisory lock, copy-on-write, APFS clone. Numbers
written `0x...` are hexadecimal (base 16): `0x38` is 56, `0x438` is 1080.

You need Homebrew's `e2fsprogs` for the ext4 commands (the project needs it from chapter 18 on):

```sh
brew install e2fsprogs
export PATH="$(brew --prefix e2fsprogs)/sbin:$PATH"
```

Work in an empty scratch directory. Everything below runs there.

## A disk is a numbered array of sectors

Strip away the brand, the interface and the firmware, and a disk offers the operating system two
operations: "give me the bytes at position N" and "store these bytes at position N". Positions are
not counted in bytes but in fixed-size chunks, because the hardware moves whole chunks at a time.
That chunk is a **sector**, and for historical reasons the number everyone agrees on is 512 bytes.
A device that works this way, fixed-size chunks addressed by number, is a **block device**.

Modern drives often use bigger chunks internally. Ask your Mac about its own SSD:

```sh
diskutil info disk0 | grep "Device Block Size"
```

```text
   Device Block Size:         4096 Bytes
```

That does not contradict the 512: the drive's internal chunk and the unit software counts in are
separate choices. **Virtio** is a standard interface for virtual devices: the guest runs an ordinary
driver for it, and the VMM plays the device. The virtio block device (**virtio-blk**) we build in
chapter 18 always counts in 512-byte units, whatever the backing storage uses (virtio 1.2, §5.2.6: the sector number "indicates
the offset (multiplied by 512) where the read or write is to occur"). The device may advertise a
preferred block size as a hint, but the unit of addressing never changes.

Three overlapping words, kept apart:

| Word | Size here | Whose unit |
|---|---|---|
| sector | 512 B | the disk interface; every virtio-blk request |
| filesystem block | 4 KiB | ext4's allocation unit (set by `mkfs`, below) |
| page | 16 KiB on the Mac, often 4 KiB in a Linux guest | the kernel's unit of RAM, and of its file cache |

Now the key move. If a disk is an array of 512-byte sectors, then an ordinary file on the host can
*be* a disk: sector `s` lives at byte offset `s × 512`. Such a file, with no header and no metadata,
byte for byte what the guest would see on a real drive, is a **raw disk image**. Make one:

```sh
truncate -s 64m disk.img
ls -l disk.img
du -h disk.img
```

```text
-rw-r--r--  1 you  staff  67108864 Nov 19 00:35 disk.img
  0B	disk.img
```

Your user name, date and permission flags will differ. Look at the two sizes: the file is 64 MiB
long, yet it occupies zero bytes on disk. `truncate` set the length without writing anything, and
**APFS** (the Mac's filesystem) stores nothing for ranges never written; reading them returns zeros.
That is a **sparse file**, and it gives us pay-for-what-you-use storage for free: a 64 GiB guest
disk costs only what the guest actually writes.

> **Aside.** QEMU's own format, qcow2, solves the same problems inside the file. The file starts
> with a **magic number**, fixed bytes that identify a format (`QFI\xfb`), and behind it are lookup
> tables that map each guest offset to wherever that data happens to sit in the file, plus
> bookkeeping for snapshots. Every lookup table must stay consistent across crashes, and every one is
> parsed from a file a guest has written to. A raw image needs no table: guest sector `s` is at
> byte `s × 512`, one multiplication. That is why macvmm uses raw images, and lets APFS supply
> sparseness and cheap copies (the last section).

## A filesystem on a whole disk

A guest does not want sectors; it wants files with names. The code that turns one into the other
is a **filesystem**: a data structure laid out across the sectors, with a known starting point,
that says which sectors hold which file. Linux's everyday filesystem is ext4. Put one on the image:

```sh
mkfs.ext4 -q -b 4096 -L rootfs disk.img
du -h disk.img
```

```text
8.3M	disk.img
```

`mkfs` ("make filesystem") wrote 8.3 MiB of structures and left the rest sparse. `-b 4096` asks for
4 KiB filesystem **blocks**, the unit ext4 allocates in; one block is 8 sectors. (Without it,
`mke2fs` picks 1 KiB blocks for a filesystem this small.) We put ext4 directly on the image, with no
partition table in front of it: sector 0 of the disk is sector 0 of the filesystem. That is a
**whole-disk filesystem**, and it is what chapter 18 boots.

Here is ext4 as `dumpe2fs disk.img` reports it for this image, one row per region. With 4 KiB
blocks, block `b` starts at byte `b × 4096`:

```text
 fs block     starts at byte   holds
 0            0                bytes 0-1023: left free (for a boot loader)
              1024             bytes 1024-2047: superblock (still inside block 0)
 1            4096             group descriptors (where each group's bitmaps and table are)
 2-8          8192             reserved, so the descriptor table can grow if the disk does
 9            36864            block bitmap
 25           102400           inode bitmap
 41-1064      167936           inode table
 1065-16383   4362240          journal, directories, file data, free space
```

*Caption: notice that the superblock sits at byte 1024 whatever the block size; with 4 KiB blocks
that is inside block 0, which is why `dumpe2fs` says "Primary superblock at 0".*

- The **superblock** is the filesystem's front page: block size, block and inode counts, features,
  and a magic number, `0xEF53`, at offset `0x38` (56) inside it. It always starts at byte 1024,
  leaving the first 1024 bytes free for a **boot loader**, the small program some disks carry to
  start an operating system. Since 1024 + 56 = 1080:

  ```sh
  xxd -s 1080 -l 2 disk.img
  ```

  ```text
  00000438: 53ef                                     S.
  ```

  `xxd` prints the offset in hex (`0x438` = 1080), then the bytes. They are `53 ef`, not `ef 53`,
  because ext4 stores numbers **little-endian**: lowest byte first. So the two-byte number `0xEF53`
  is stored as `53` then `ef`.
- The disk is divided into **block groups** (one here; big disks have thousands). Each has a block
  bitmap and an inode bitmap (one bit per block or inode: free or used) and a slice of the inode
  table.
- An **inode** describes one file: size, owner, mode, timestamps, and where its data lives, as
  **extents** (runs of consecutive blocks). The name is not in the inode; a directory is a file that
  maps names to inode numbers. Inode 2 is always the root directory.
- The **journal** is a small log inside the filesystem (here 1024 blocks, inode 8). **Metadata** is
  data about files and the layout (inodes, directories, bitmaps), as opposed to file contents.
  Before ext4 changes its metadata in place, it writes the change to the journal, then a commit record, and only
  then updates the real location. After a crash, replaying committed log entries restores a
  consistent filesystem (every bitmap, inode and directory agreeing with the others) in seconds
  instead of a full scan.

The journal only works if writes reach stable storage *in the order ext4 asked*: the log entries
before the commit record, the commit record before the in-place update. Hold on to that sentence;
the durability section turns on it.

## From a file name to a sector number

macOS cannot **mount** ext4 (attach it to its own file tree, covered below), so we use `debugfs`,
an ordinary program, not kernel code, that reads and edits ext4 images directly. Copy a file into the image, then ask where it went:

```sh
printf 'hello from the host\n' > hello.txt
debugfs -w -R "write hello.txt hello.txt" disk.img
debugfs -R "stat /hello.txt" disk.img 2>/dev/null | grep -A1 EXTENTS
```

The first line is `debugfs` announcing its version:

```text
debugfs 1.47.4 (6-Mar-2025)
Allocated inode: 13
EXTENTS:
(0):2097
```

Logical block 0 of the file is filesystem block 2097. Now do the arithmetic a guest kernel does on
its way to the disk. Block to byte: 2097 × 4096 = 8,589,312. Byte to sector: 8,589,312 ÷ 512 =
16,776.

```sh
echo $((2097 * 4096 / 512))
xxd -s $((16776 * 512)) -l 20 disk.img
```

```text
16776
00831000: 6865 6c6c 6f20 6672 6f6d 2074 6865 2068  hello from the h
00831010: 6f73 740a                                ost.
```

`xxd` shows the offset in hex: `0x831000` is 8,589,312, the byte we computed.

If that disk were attached to a guest and a program ran `cat /hello.txt`, the guest's ext4 would
walk the root directory, find inode 13, read its extent, and its virtio driver would send our VMM a
request saying "read, sector 16776, 4096 bytes". Our VMM would read the image at byte
16776 × 512. That is the whole storage stack in one sentence.

Last, the filesystem checker. `e2fsck -f` forces a full check; `-n` opens the image read-only and
answers "no" to every repair, so it can only report:

```sh
e2fsck -fn disk.img
echo $?
```

```text
e2fsck 1.47.4 (6-Mar-2025)
Pass 1: Checking inodes, blocks, and sizes
Pass 2: Checking directory structure
Pass 3: Checking directory connectivity
Pass 4: Checking reference counts
Pass 5: Checking group summary information
rootfs: 13/16384 files (7.7% non-contiguous), 2098/16384 blocks
0
```

The summary line counts inodes in use (13 of 16384), the share of files not stored in one run, and
blocks in use. Exit status 0 means clean. Chapter 18 runs exactly this check after a guest has booted, written and
shut down, as evidence that our device did not corrupt anything. Never run it, or `debugfs -w`, on
an image a VM is using: two writers that do not know about each other is how filesystems die (the locking section below
shows how macvmm prevents that).

> **Security.** A disk image is guest-controlled data. Every byte of the superblock, every inode
> and every extent was written by the guest, which may be malicious. Asking the *host* kernel to
> mount such an image would hand a hostile data structure to the kernel, the code that runs with full
> control of the machine. macvmm never interprets the filesystem at all: it moves sectors. The only numbers it
> trusts are its own (the image's length), and every sector and length the guest sends is
> checked to lie inside the image, with checked arithmetic, before any file access (chapter 18).

## Mounting, and what `root=` means

Inside a Linux guest, attaching a filesystem's directory tree to a point in the existing tree is
**mounting**: `mount /dev/vda /mnt` makes the ext4 on the first virtio disk appear under `/mnt`.
Linux names virtio block devices `vda`, `vdb`, and so on, in the order it discovers them; a
partition on `vda` would be `vda1`. Our image has no partitions, so the filesystem is `/dev/vda`
itself.

The very first mount, of `/`, has no shell to type it. The **kernel command line**, a string of
settings the VMM hands the kernel at boot, names it instead: `root=/dev/vda` (plus `rw` to mount it
writable and, often, `rootwait` to wait until the disk has been found). An **initramfs** is a tiny
temporary root filesystem loaded into RAM together with the kernel. Without an initramfs, the kernel mounts that device as `/` and runs `/sbin/init` from
it. With an initramfs, as in macvmm's Alpine boots, the kernel runs `/init` from the initramfs
first; that script reads `root=` from `/proc/cmdline`, mounts the disk, and switches to it (the
`linux-boot-sequence` primer walks through this). Either way, `root=` is a request, and the guest
log line that answers it in chapter 18 is the kernel's `EXT4-fs (vda): mounted filesystem`.

FreeBSD (chapter 22) names devices differently and uses a partitioned image; our VMM does not
notice, because partitions, like filesystems, are guest business.

## The durability ladder

Back to the puzzle. One idea first: the **page cache** is a kernel's copy of file data in RAM.
Writes land there and return at memory speed; the kernel writes them back to the drive later. A
page that has been changed in RAM but not yet written back is a **dirty page**. That is the
0.004 ms "none" line in the puzzle. Both the guest kernel and macOS keep one.

Between a guest program's `write()` and the flash chips there are five rungs where a byte can
wait, each faster and more fragile than the one below it:

```text
 guest program   write()
      |
 [1] guest page cache        (guest RAM)              lost if the guest kernel crashes
      |  guest driver sends a virtio OUT (write) request
 ---- guest | host: the VMM trusts nothing above this line -------------------
 [2] request in flight in VMM (read from the queue, not yet passed to pwrite)
      |  pwrite() returns: the host kernel has copied the data
 [3] host page cache         (host RAM)               lost if macOS crashes or power fails
      |  fsync()
 [4] SSD's volatile cache    (drive RAM)              lost if power fails
      |  F_FULLFSYNC
 [5] flash                                            survives
```

*Caption: notice that each arrow is a different call, and only the last one reaches storage that
survives a power cut.*

A guest asks the device for work with typed requests: `IN` reads sectors, `OUT` writes them, and
`FLUSH` says "make every write I have had acknowledged durable". Rungs 1 and 2 are both in the VMM
process's memory (guest RAM is memory our process allocated); rung 3 belongs to macOS.

**`fsync`** pushes a file's dirty pages from the page cache to the drive. On macOS, that is all it
does. Read `man 2 fsync` on your Mac:

```text
     Note that while fsync() will flush all data from the host to the drive
     (i.e. the "permanent storage device"), the drive itself may not
     physically write the data to the platters for quite some time and it may
     be written in an out-of-order sequence.
```

The drive has its own RAM cache (rung 4), and it may reorder writes. **`F_FULLFSYNC`** does what
`fsync` does and then asks the drive to flush its cache; `man 2 fcntl` adds that it "acts as a
barrier", so everything previously `fsync`'d on that device is persistent when it returns. That
drive flush is the 3 ms in the puzzle. The fast line was not lying, exactly. It answered a
different question.

> **Under the hood** (skippable). Linux's `fsync`, on ext4 and XFS with default settings, *does* end with a
> drive cache flush, so a Linux programmer's `fsync` means roughly what macOS calls `F_FULLFSYNC`.
> That is why the guest's FLUSH needs the slow call. Inside the guest, ext4's journal commit asks
> its block layer for "flush everything before this, and make this record durable"; the block layer
> turns that into virtio-blk `FLUSH` requests. Virtio devices start with **feature negotiation**:
> the device advertises a list of capabilities as bits, and the driver uses only those offered.
> The guest sends `FLUSH` only if the device offered `VIRTIO_BLK_F_FLUSH` (feature bit 9, virtio
> 1.2 §5.2.3). A device that does not offer it is claiming it has no volatile cache at all, so the
> driver concludes that every completed write is already durable and never asks.

Now the payoff for the VMM. When our device completes a guest write, the guest believes it has left
its own RAM and reached the device. When it completes a `FLUSH`, the guest believes everything before it is on rung 5, and its
journal's ordering argument depends on that belief. So `FLUSH` must be `F_FULLFSYNC`. In Rust,
`File::sync_all` does exactly that on Apple platforms: in the Rust 1.99 standard library source
(`library/std/src/sys/fs/unix.rs`), `fsync` on `target_vendor = "apple"` calls
`fcntl(fd, F_FULLFSYNC)`, and `sync_data` does the same. You can check it yourself: open that file
under `$(rustc --print sysroot)/lib/rustlib/src/rust/` (install it with
`rustup component add rust-src`) and search for `F_FULLFSYNC`. Chapter 18 does exactly that
against the pinned toolchain rather than trusting memory.

Which failures does each rung survive? A guest kernel panic loses rung 1 only. Killing the VMM with
`kill -9` also kills the guest, because guest RAM is our process's memory: rung 1 and any request
still at rung 2 are gone. But everything already passed to `pwrite` survives, because rung 3 is
memory the macOS kernel owns, not our process, and the kernel writes it back regardless. A host
crash loses rung 3; only a power loss also loses rung 4.

Rungs 4 and 5 are also where ordering is decided. A drive cache may write back in any order, so
ext4's rule (log entries before the commit record) holds after a power cut only if each `FLUSH`
really emptied that cache. That is why the honest experiment in
chapter 18 measures latency, not corruption: you cannot pull the plug from a test script.

> **Production note.** macOS also offers `F_BARRIERFSYNC` (`man 2 fcntl`): it issues a write
> barrier so earlier data is persisted before later I/O, without waiting for the flush to finish.
> That is enough for ordering but not for "durable when this returns", which is what a virtio
> `FLUSH` completion promises. Some hypervisors offer a per-disk cache mode that lets the user trade
> safety for speed (QEMU's `cache=unsafe` ignores flushes entirely). macvmm keeps one honest mode.

## Two threads, one file: `pread` and `pwrite`

An open file has a current position, the **file offset**, that `read` and `write` use and advance.
To read sector 16776 the classic way you call `lseek` to move the offset, then `read`. That is two
system calls, and the offset is shared by every thread using the descriptor. If chapter 17's worker
threads serve two requests at once, thread A's `lseek` can be followed by thread B's, and A reads
B's sector.

**`pread`** and **`pwrite`** take the offset as an argument and leave the file offset alone: one
call, no shared state, safe from any number of threads. In Rust they are
`std::os::unix::fs::FileExt::read_at` and `write_at`, with `read_exact_at` and `write_all_at`
looping over **short transfers**: a call is allowed to move fewer bytes than you asked for, and
reports how many it did move. That is real here: `pread` at or past the end of the file returns 0
bytes, not an error, so a device that forgot to check the sector against the image size would hand
the guest a buffer of whatever was there before. The write side is worse: `pwrite` past the end
succeeds and grows the file, so an unchecked sector number lets the guest inflate a sparse image
until the host disk is full.

The program from the puzzle uses `pwrite` too; here it is so you can reproduce the opener. Its
first argument picks the mode: `none`, `fsync` or `full`.

*Listing: `synctime.c`*

```c
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "none";
    int fd = open("sync.dat", O_RDWR | O_CREAT | O_TRUNC, 0600);
    char block[4096];
    memset(block, 'x', sizeof block);
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < 200; i++) {
        pwrite(fd, block, sizeof block, (off_t)i * 4096);
        if (strcmp(mode, "fsync") == 0) fsync(fd);
        if (strcmp(mode, "full") == 0) fcntl(fd, F_FULLFSYNC);
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double ms = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6;
    printf("%-5s 200 writes in %8.1f ms (%.3f ms each)\n", mode, ms, ms / 200);
    close(fd);
    return 0;
}
```

```sh
cc -O2 -Wall -o synctime synctime.c
./synctime fsync
./synctime full
```

```text
fsync 200 writes in      5.8 ms (0.029 ms each)
full  200 writes in    638.8 ms (3.194 ms each)
```

Your numbers will differ with the drive and with whatever else is writing at the same moment. Over
several runs on the M5 Pro, `fsync` ranged from 0.03 to 0.1 ms per call and `F_FULLFSYNC` sat near
3.2 ms, with one run at 139 ms per call while other builds were busy on the same SSD. The ratio, not
the exact figure, is the lesson. (The program skips error checks to stay short; the VMM may not.)

## One image, one VMM: advisory locks

Start two VMMs on the same raw image and two guest kernels each believe they own the disk. Each
caches metadata, each writes, and within seconds the filesystem is garbage. Nothing in the file
system stops this; we must.

The tool is a file lock. `flock(fd, LOCK_EX | LOCK_NB)` asks the kernel for an exclusive lock on the
open file and, because of `LOCK_NB` ("non-blocking"), fails at once instead of waiting if another
process holds one (the error code is `EWOULDBLOCK`, "this would have to wait"). The kernel owns the
lock and drops it when the last descriptor sharing that open file closes, or the process dies, even
by `kill -9`, so there is no stale "lock file" to clean up. "Last descriptor" matters: copies made
by `dup` or inherited by a child process keep the lock alive. Rust opens files with `O_CLOEXEC` by
default, so a program macvmm launches does not inherit the descriptor and cannot keep the image
locked. macOS ships a command, `lockf`, that runs a program while holding a
`flock` lock, so you can watch two contenders:

```sh
lockf -k -t 0 disk.img sleep 3 &
sleep 0.5
lockf -k -t 0 disk.img echo got it
echo $?
```

```text
lockf: disk.img: already locked
75
```

The second attempt fails with exit status 75, the conventional code for "temporary failure, try
again"; run the last two lines again after three seconds and it prints `got it`. Keep the `-k`.
Without it, `lockf` *deletes the file* when the command finishes (`man lockf`, first paragraph):
a cheap lesson with a 64 MiB scratch file, an expensive one with a real root disk.

These locks are **advisory**: they bind only programs that ask. `dd` or `cat` ignore them and write
anyway. That is fine for our purpose, which is to stop a second macvmm, and it is all Unix offers.
Rust's `File::try_lock` is this exact call on Apple platforms (`flock` with `LOCK_EX | LOCK_NB`, in
the same 1.99 std source file), and chapter 18 turns its failure into the message
`disk image is locked` and exit status 2.

*Optional.* There is a second lock family, POSIX record locks through `fcntl(F_SETLK)`, which can lock byte
ranges. It carries a famous trap: the lock belongs to the process and the file, and closing *any*
descriptor for that file in the process releases it, even one opened by an unrelated library. For a
whole-image lock, `flock`'s "tied to this open file" rule is the one you want.

## Clones: a fresh disk for every run

Chapter 18's test boots a guest that writes to its root disk, and chapter 22 boots FreeBSD from an
image you do not want to download twice. Both want a pristine copy every run, without copying
gigabytes. APFS can do that: `cp -c` calls `clonefile(2)`, which creates a new file that "shares its
data blocks with the src file" (`man 2 clonefile`). Blocks are copied only when one side writes to
them, which is **copy-on-write**. To see that the clone costs almost nothing, watch the `Used`
column of `df -k` (the third, in KiB) before and after:

```sh
df -k . | tail -1
cp -c disk.img clone.img
df -k . | tail -1
cmp disk.img clone.img && echo identical
```

```text
/dev/disk3s5   971298980 202335000 743320756    22% 2443643 7433207560    0%   /System/Volumes/Data
/dev/disk3s5   971298980 202335008 743320748    22% 2443644 7433207480    0%   /System/Volumes/Data
identical
```

Your volume and numbers will differ. `Used` grew from 202335000 to 202335008, 8 KiB, for a file whose data is
8.3 MiB: only metadata was written. The clone is a separate file. The guest can scribble on it,
`e2fsck` can check it, and the original is untouched.

## Self-check

Commit to an answer before you open each one.

:::predict A guest's virtio-blk request says "read, sector 16776, 4096 bytes". At what byte offset in the raw image does macvmm read, and which ext4 block is that if the filesystem uses 4 KiB blocks?
Byte 16776 × 512 = 8,589,312. Divided by 4096 that is block 2097: the block that held
`hello.txt` in our image. The device never knows it was a file; it sees a sector and a length.
:::

:::predict A guest sends a FLUSH and macvmm answers it with plain `fsync()`. The VMM is then killed with `kill -9`. Is any acknowledged data lost? What if the Mac loses power instead?
After `kill -9`: no acknowledged data, because the device acknowledges a write only after `pwrite`
accepted it, and that data is in the host page cache, which belongs to macOS and is written back
regardless. (The guest itself dies with the VMM, and its own unsent dirty pages die with it, but
those were never acknowledged.) After a power loss: possibly, because `fsync` on macOS stops at the
drive, whose volatile cache may not have reached flash and may have reordered writes. The guest's
journal then finds a commit record without the entries it covers, or the reverse.
:::

:::predict Why would `root=/dev/vda1` fail to boot the image made in this primer, even though `/dev/vda` holds a perfectly good ext4?
The image has no partition table, so the kernel creates no `vda1`. The filesystem is the whole disk,
`/dev/vda`, and the kernel (or the initramfs `/init`) waits for a device that never appears.
:::

:::predict Two worker threads share one file descriptor for the image and serve requests with `lseek` then `read`. What goes wrong, and what is the fix?
The file offset is shared, so one thread's `lseek` can land between the other's `lseek` and `read`,
and a request returns another request's sector: silent corruption. Use `pread`/`pwrite` (Rust
`read_exact_at`/`write_all_at`), which take the offset as an argument and do not touch the shared
offset.
:::

:::predict A second macvmm is started on an image the first one already holds with `flock(LOCK_EX)`. Meanwhile you run `dd` into the same image. Which of the two is stopped by the lock?
Only the second macvmm, because it asks for the lock. `flock` locks are advisory, and `dd` never
asks. The lock protects against our own tool, not against every program on the Mac.
:::

:::predict `du -h` shows 8.3M for a 64 MiB image after `mkfs.ext4`. After `cp -c disk.img clone.img`, how much more free space does the volume lose, roughly? And after the guest writes 1 MiB to the clone?
Almost none at first (we saw 8 KiB of metadata), because the clone shares every data block. After the
guest writes 1 MiB, about 1 MiB more, because copy-on-write gives the clone its own copy of only the
blocks that changed.
:::

## Lab

:::lab durability-ladder

In the `durability-ladder` lab you follow one guest `write()` down the five rungs of the ladder:
guest page cache, a virtio `OUT` request, the host page cache, the drive's cache and flash. Send
`fsync` from the guest, choose whether the VMM answers `FLUSH` with `fsync` or `F_FULLFSYNC`, then
press "process killed" (VMM and guest both die: rungs 1 and 2 are lost) or "power lost" and watch
which bytes survive and whether the journal still
replays to a consistent state. Its goal is the table in your head: which failure reaches which rung,
and which call moves data past it.

## Where this shows up in macvmm

- [Chapter 18, virtio-blk](/build-your-own/vmm/virtio/virtio-blk/) (requires this primer): the
  device in `crates/vmm/src/virtio/blk.rs` and the raw-image backend in
  `crates/vmm/src/backend/file.rs`. Sectors become offsets with checked arithmetic, data moves
  with `pread`/`pwrite`, `FLUSH` becomes `File::sync_all` (that is, `F_FULLFSYNC`), and the image is
  locked with `try_lock`. Its test boots Alpine with `root=/dev/vda` from an APFS clone of an ext4
  image built by `mkfs.ext4`, and checks the result with `e2fsck -fn`.
- [Chapter 22, freebsd](/build-your-own/vmm/firmware/freebsd/): the FreeBSD release image is a raw,
  partitioned disk, used only through APFS clones.
- Related primers: `linux-boot-sequence` (what `/init` does with `root=`), `host-concurrency` (the
  worker threads that make `pread`/`pwrite` necessary).

## Checkpoint

**What you can do now.** Make a raw image, put ext4 on it, find a file's sectors, check the
filesystem, clone the image for free and lock it against a second user, and say what `fsync` and
`F_FULLFSYNC` each guarantee on macOS. Verify the image from this primer still has its superblock
magic:

```sh
xxd -s 1080 -l 2 -p disk.img
```

```text
53ef
```

**What's next.** Chapter 18 turns this file into a device a Linux guest can boot from. The new
problem is that every sector number and length now comes from the guest, and a single unchecked
multiplication lets it read bytes we never meant to give it.

**One open question.** We paid 3 ms per `FLUSH` so that a power cut cannot break the guest's
journal. Suppose the guest is a throwaway CI runner whose disk is a clone deleted after every run.
Is it still wrong to answer `FLUSH` with a no-op, and who should be allowed to decide?

## Going further

- OASIS, *Virtual I/O Device (VIRTIO) Version 1.2*, §5.2 "Block Device": feature bits (§5.2.3,
  including `VIRTIO_BLK_F_FLUSH`), the device configuration layout (§5.2.4) and device operation
  (§5.2.6: request types, the 512-byte sector unit, `FLUSH` semantics).
- Linux, `Documentation/filesystems/ext4/` (the "Overview" and "Global Structures" pages: the
  superblock at offset 1024, block groups, inodes and extents) and
  `Documentation/filesystems/ext4/journal.rst`; and `root=`, `rootwait`, `rw` in
  `Documentation/admin-guide/kernel-parameters.txt`.
- On your Mac: `man 2 fsync`, `man 2 fcntl` (`F_FULLFSYNC`, `F_BARRIERFSYNC`), `man 2 flock`,
  `man 1 lockf`, `man 2 clonefile`, `man 2 pread`.
- `e2fsprogs` manual pages: `mke2fs(8)`, `e2fsck(8)`, `debugfs(8)`, `dumpe2fs(8)`.
