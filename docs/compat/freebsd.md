# FreeBSD 15.1 on macvmm: compatibility record (PLAN M19)

**Status (2026-11-19): FreeBSD boots.** Stock FreeBSD 15.1-RELEASE (arm64, the project's UFS VM
image) boots through stock U-Boot 2026.04's UEFI to a root login and powers off cleanly;
`freebsd_login` passes (`scripts/test-e2e.sh freebsd`, section 6). Observed on the dev machine
(Apple M5 Pro, macOS 27.2). Course chapter 22 and the U-Boot primer point here; the firmware
half of the story (flash, the ROM instruction fetch, the virtio-mmio fix) is in
[`uboot.md`](uboot.md).

| Item | Value |
|---|---|
| Guest | FreeBSD 15.1-RELEASE `releng/15.1-n283562-96841ea08dcf` GENERIC arm64 |
| Image | `FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz`, 595 MiB, sha256 `36028829cbd5a74a050d9964cd5fd391c9d12edca1c3d520cbcce257e1d999c8` (pinned; agrees with the project's `CHECKSUM.SHA256`, checked 2026-11-19) |
| Derived raw | `freebsd-15.1-ufs.raw`: 6,476,576,256 bytes logical, about 3.4 GB allocated (sparse), sha256 `d7a05077131d07a17c3fb2faf803ff34edf511ddbf796c35934d6d2afc44b959` (TOFU, pinned at first build, equal to `xz -dc \| shasum -a 256`) |
| Firmware | U-Boot 2026.04 `qemu_arm64` (`u-boot.bin`, the M18 pin) |
| Fetch | `scripts/fetch.sh uboot freebsd` (about 25 s to derive the raw on the dev machine; needs Homebrew `xz`) |
| Command | `macvmm run --bios .cache/macvmm/u-boot.bin --disk $T/f.raw --mem 2G --cpus 2 --timeout 240 --on-reset exit`, where `$T/f.raw` is `cp -c .cache/macvmm/freebsd-15.1-ufs.raw $T/f.raw` (an APFS clone) |
| Time to `login:` | about 13 s, 10 s of it the loader menu's autoboot countdown; power-off at about 22 s |
| Changes to the VMM | one: virtio-blk no longer offers `VIRTIO_BLK_F_SIZE_MAX` (section 2) |

## 1. The boot chain, link by link

Nothing in the chain is modified or configured for macvmm. Each step was observed on the console
(the transcript in section 7):

1. **U-Boot** runs from flash bank 0, exactly as in M18, and its autoboot countdown (2 s) expires.
2. U-Boot's **bootflow scan** finds only the global `efi_mgr` bootmeth ready. With no EFI
   variables stored (`No EFI variables loaded`) it falls back to the removable-media path on the
   first block device, `virtio 0`: `\EFI\BOOT\BOOTAA64.EFI` on the image's EFI system partition
   (GPT partition 1, FAT).
3. That file is **FreeBSD's `loader.efi`** (`FreeBSD/arm64 EFI loader, Revision 3.0`). It sees
   U-Boot as its firmware (`EFI Firmware: Das U-Boot (rev 8230.1024)`, `EFI version: 2.110`), uses U-Boot's
   EFI console (`Console: efi,comconsole`), and reads the disk through U-Boot's EFI Block I/O
   protocol, which U-Boot implements on top of its own virtio-blk driver. It walks the partitions
   (`Trying ESP`, then `disk0p2`, `disk0p3`), finds UFS on `disk0p3`, reads `/boot/loader.conf`,
   draws its menu, waits 10 s, and loads `/boot/kernel/kernel`.
4. The loader passes the kernel **the device tree U-Boot got from macvmm**
   (`Using DTB provided by EFI at 0xbd600000`): U-Boot installs the DTB macvmm generated (x0 at
   reset, M18) as an EFI configuration table, so the FDT generator in `crates/vmm/src/fdt/` is
   what FreeBSD's `ofwbus` enumerates. `WARNING: Cannot find freebsd,dts-version property` is
   expected: that property exists only in FreeBSD's own DTS files, and the kernel continues.
5. The **kernel** attaches everything our machine model provides, from that DTB: `psci0` and
   `smccc0` (SMCCC 1.1, over HVC), `gic0` (GICv3: distributor at `0x0800_0000`, redistributors at
   `0x080a_0000`, HVF's in-kernel GIC), `generic_timer0` (24 MHz), `uart0` (PL011, console),
   `pl0310` (PL031 RTC: the wall clock is right), `virtio_mmio0`, and `vtblk0`. CPU 1 starts via
   PSCI CPU_ON (`FreeBSD/SMP: Multiprocessor System Detected: 2 CPUs`).
6. Root is `ufs:/dev/gpt/rootfs` on `vtbd0p3`. `rc` grows the partition to the disk (`vtbd0p3
   resized`, a no-op here), mounts, starts `devd`, `syslogd`, `cron`, and `getty` prints
   `login:` on `ttyu0`.
7. `shutdown -p now` ends in **EFI runtime `ResetSystem`**: the `PSCI_SYSTEM_OFF` call in the trace
   comes from pc `0xbf69a1b8`, inside the relocated U-Boot image at the top of RAM (just above its
   malloc area, `0xbe65a000-0xbf69a000`), where its EFI runtime services live, not from the
   kernel's own PSCI driver. U-Boot's EFI runtime implements `ResetSystem(EfiResetShutdown)` with
   PSCI SYSTEM_OFF over HVC, and macvmm exits 0.

## 2. The one blocker, and its fix: `size_max`

The first boot got all the way to the kernel and stopped at the root mount:

```text
virtio_mmio0: <VirtIO MMIO adapter> mem 0xa000000-0xa0001ff irq 6 on ofwbus0
vtblk0: <VirtIO Block Adapter> on virtio_mmio0
vtblk0: host requires unsupported maximum segment size feature
device_attach: vtblk0 attach returned 45
...
Trying to mount root from ufs:/dev/gpt/rootfs [rw,noatime]...
mountroot: waiting for device /dev/gpt/rootfs...
Mounting from ufs:/dev/gpt/rootfs failed with error 19.
...
mountroot>
```

No VMM diagnostic at all (no unhandled MMIO, no sysreg, no unknown SMCCC): the device worked,
the *driver* refused it. Error 45 is `EOPNOTSUPP`; error 19 is `ENODEV` (no disk, so no
`/dev/gpt/rootfs`).

**Root cause.** Up to M18 macvmm's virtio-blk offered `VIRTIO_BLK_F_SIZE_MAX` with
`size_max = 64 KiB` (one bounce buffer). FreeBSD's `vtblk_attach`
(`sys/dev/virtio/block/virtio_blk.c`) refuses a device whose `size_max` is smaller than the
kernel's `maxphys` (1 MiB on arm64): its `sglist(9)` code coalesces physically adjacent pages
into one segment, so it cannot promise to keep each segment under a limit, and it would rather
not attach than corrupt I/O. Linux and U-Boot honour a small `size_max`, which is why M14 and
M18 never saw this. QEMU does not offer the feature at all.

**Fix** (`crates/vmm/src/virtio/blk.rs`, module docs "Why `size_max` is not offered"):
`device_features` no longer includes `VIRTIO_BLK_F_SIZE_MAX`. The promise was never needed:
the data path moves bytes through 64 KiB zeroed bounce buffers chunk by chunk whatever the
segment size (BLK-6), so a 1 MiB segment costs the same memory as sixteen 64 KiB ones. The
request size stays capped at `BLK_MAX_DATA` (126 × 64 KiB of data, VQ-8), which is above what
any of our guests sends (Linux's default `max_sectors_kb` is a few MiB at most; FreeBSD's
`maxphys` is 1 MiB). That cap is no longer advertised, so a spec-compliant driver can exceed
it (item 3 below); the walk's own per-direction bound (`BLK_CHAIN_MAX`) was raised above
anything a chain can carry, so such a request is answered IOERR and never resets the device. The
config field still reads 64 KiB; without the feature bit a driver ignores it (virtio 1.2 §5.2.4).

The change is guarded three ways: `features_and_config_space` in
`crates/vmm/tests/virtio_blk_hostile.rs` asserts the bit is not offered; `freebsd_login`'s
marker file forbids the `host requires unsupported` line; and the Linux and U-Boot suites,
which use the same device, were re-run unchanged (section 6).

Ranked list of what else could go wrong next, for whoever extends this (none of it blocks the
login today):

1. **An `efi_mgr`-only boot depends on the removable-media path.** No EFI variables persist
   (flash writes are ignored, M18), so every boot is a first boot. Fine for a VM image; a guest
   that needs a `Boot####` entry would need the M18 CFI flash state machine and a writable
   variable store.
2. **No RNG at boot.** U-Boot reports `Missing RNG device for EFI_RNG_PROTOCOL` and FreeBSD
   warns `arc4random: WARNING: initial seeding bypassed`. `--rng` adds virtio-rng; whether U-Boot
   then offers `EFI_RNG_PROTOCOL` to the loader is untested.
3. **Requests above 126 × 64 KiB get IOERR, although a compliant driver may send them.**
   Without `VIRTIO_BLK_F_SIZE_MAX` the spec bounds only the segment count (`seg_max`), so this
   is a device-side limit the driver is not told about. Not seen with any guest; a driver
   tuned for huge requests (Linux after root raises `max_sectors_kb` past 8192) would see I/O
   errors for them. Every such request, however large, gets IOERR and the disk keeps working:
   `BLK_CHAIN_MAX` is set above anything the descriptor walk can produce, so the walk never
   fails with `TooLarge` and latches DEVICE_NEEDS_RESET (tested by
   `data_longer_than_126_times_64k_is_ioerr`, up to a 127 MiB chain). Two ways out if a guest
   needs it: raise `BLK_MAX_DATA` (no memory cost, bounce buffers are per chunk, but a longer
   device-mutex hold), or offer `SIZE_MAX` again with a value ≥ FreeBSD's `maxphys` (1 MiB),
   which makes `seg_max × size_max` a promise compliant drivers keep.
4. **The DSR query is dropped** (`resizewin: timeout reading from terminal`, about 1 s at login;
   section 4).

## 3. Exits observed (trace)

A run with `--trace exits:F:psci,hvc,sysreg` recorded 13 exits in the whole boot, all in the
kernel's first few milliseconds and at power-off:

| What | Count | Note |
|---|---|---|
| sysreg `MSR OSLAR_EL1` of 0 | 2 (one per vCPU) | unlocking the debug OS lock; one of the registers HVF forwards, handled by the sysreg policy (`crates/vmm/src/arch/sysreg.rs`) |
| `PSCI_CPU_ON` | 1 | vCPU 1 |
| `PSCI_VERSION`, `PSCI_FEATURES` ×2, `SMCCC_VERSION` ×2, `SMCCC_ARCH_FEATURES` ×4 | 9 | `psci0`/`smccc0` probing, and `SMCCC_ARCH_FEATURES` queries for firmware workarounds, from both vCPUs |
| `PSCI_SYSTEM_OFF` | 1 | from U-Boot's EFI runtime `ResetSystem` (section 1, step 7) |

No unknown SMCCC function, no unhandled MMIO, no ISV = 0 access outside U-Boot's known flash
`STP` (M18), and no VTIMER exits (the in-kernel GIC handles the timer; CLAUDE.md, "Interrupts"). U-Boot's own phase made no traced exit in these categories.

## 4. Terminal behaviour

- **U-Boot's EFI console follows every character with `ESC [?25h`** (show cursor) while the
  loader prints. Under the default `safe` serial policy these pass through (a cursor-visibility
  toggle is harmless), so the raw stdout of the loader phase is mostly escape sequences. The
  e2e test matches its markers against a copy with CSI sequences removed.
- **The terminal-size probe is dropped.** U-Boot's `efi_mgr` bootmeth probes with
  `ESC 7 ESC [r ESC [999;999H ESC [6n ESC 8` (as in M18 `uboot_autoboot_dsr`), and after login
  FreeBSD's `resizewin` does the same. `safe` drops the `ESC [6n` query (TTY-3), so nothing ever
  answers: U-Boot falls back to 80×25 at once, and `resizewin` prints
  `resizewin: timeout reading from terminal` after about 1 s. That second is the whole cost
  (risk R18).
- The PL011 console is `ttyu0` at 115200 8N1, and the RTC gives the right wall-clock time.

## 5. Image handling (SC-5, SC-6, SC-10)

- `scripts/fetch.sh freebsd` downloads the `.raw.xz` over HTTPS and verifies its sha256 before
  anything parses it (SC-5); the pin matches FreeBSD's `CHECKSUM.SHA256`.
- The raw is derived by `cargo xtask derive write-sparse` (`crates/xtask/src/sparse.rs`):
  `xz -dc --` with an environment of only `PATH`, after an `xz --version` check that refuses
  the CVE-2024-3094 releases 5.6.0 and 5.6.1 (SC-8). `fetch.sh` first requires 8 GiB free in the
  cache. The output is capped at 16 GiB: one byte more and `xz` is killed and the file deleted
  (SC-6). The output is created `O_EXCL|O_NOFOLLOW`, never through a symlink.
- All-zero 64 KiB blocks are skipped with `lseek`, so the file is sparse. Observed on APFS: a
  hole is kept only for a zero run longer than about 8 MiB (shorter gaps are allocated and
  zero-filled), which the image's free space easily is: 6.48 GB logical, about 3.4 GB on disk.
- The derived pin is **TOFU** (SC-10): the hash of the first build, recorded in
  `scripts/fetch-manifest.txt` on 2026-11-19 and cross-checked against `xz -dc | shasum`. It is
  a regression check (did `xz` or `write-sparse` change the bytes?), not a trust root: trust comes
  from the `.xz` pin.
- Every test boots its own `cp -c` APFS clone. The guest writes to its disk (`growfs`, logs,
  entropy), so booting the cached image directly would change it and break its pin.

## 6. Tests

| Test | What | Result (2026-11-19) |
|---|---|---|
| `scripts/test-e2e.sh freebsd` → `freebsd_login` | the PLAN M19 row: login, `uname -sr`, `shutdown -p now`, exit 0 | pass, about 22 s |
| `xtask/tests/sparse.rs` | 1 MiB mixed round trip, unaligned tail, all-zero input, a 32 MiB gap is a hole, symlink and existing output refused, over-cap output deleted | pass |
| `scripts/test-fetch.sh` | write-sparse via a stub `xz`: success and pin, failure leaves nothing, over the cap → deleted + non-zero exit, a cached raw is re-verified not re-derived, an oversized `MACVMM_SPARSE_CAP` is ignored and the derive still runs, 8 GiB free-space check, xz 5.6.1 and liblzma 5.6.1 refused (that the variable can only *lower* the cap is the unit test `cap_env_can_only_lower_the_cap` in `crates/xtask/src/sparse.rs`) | pass |
| `crates/vmm/tests/virtio_blk_hostile.rs` | `features_and_config_space`: `SIZE_MAX` not offered | pass |

## 7. The latest transcript

From `scripts/test-e2e.sh freebsd`'s configuration, captured with the same command and inputs,
2026-11-19. Escape sequences and carriage returns are removed; the loader's menu drawing is
elided (it is box-drawing characters and cursor moves).

```text
Bloblist at 0 not found (err=-2)
alloc space exhausted ptr 400 limit 0
Bloblist at 0 not found (err=-2)


U-Boot 2026.04 (Apr 21 2026 - 09:17:42 +0000)

DRAM:  2 GiB
using memory 0xbe65a000-0xbf69a000 for malloc()
Core:  15 devices, 9 uclasses, devicetree: board
Flash: 0 Bytes
Loading Environment from Flash... *** Warning - bad CRC, using default environment

In:    serial,usbkbd
Out:   serial,vidconsole
Err:   serial,vidconsole
No USB controllers found
Net:   No ethernet found.

Hit any key to stop autoboot: 2Hit any key to stop autoboot: 1Hit any key to stop autoboot: 0
Scanning for bootflows in all bootdevs
Seq  Method       State   Uclass    Part  Name                      Filename
---  -----------  ------  --------  ----  ------------------------  ----------------
Scanning global bootmeth 'efi_mgr':
No EFI variables loaded
Missing TPMv2 device for EFI_TCG_PROTOCOL
Missing RNG device for EFI_RNG_PROTOCOL
  0  efi_mgr      ready   (none)       0  <NULL>
** Booting bootflow '<NULL>' with efi_mgr
Booting: Label: virtio 0 Device path: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)
Consoles: EFI console
    Reading loader env vars from /efi/freebsd/loader.env
Setting currdev to disk0p1:
FreeBSD/arm64 EFI loader, Revision 3.0

   Command line arguments: loader.efi
   Image base: 0xbd460000
   EFI version: 2.110
   EFI Firmware: Das U-Boot (rev 8230.1024)
   Console: efi,comconsole (0)
   Load Path: /\EFI\BOOT\BOOTAA64.EFI
   Load Device: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)/HD(1,GPT,155e469a-665c-11f1-067b-ff9d86f8dced,0x22,0x10418)
   BootCurrent: 0000
   BootOrder: 0000[*]
   BootInfo Path: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)
Ignoring Boot0000: Only one DP found
Trying ESP: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)/HD(1,GPT,155e469a-665c-11f1-067b-ff9d86f8dced,0x22,0x10418)
Setting currdev to disk0p1:
|Trying: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)/HD(2,GPT,155e46ae-665c-11f1-1d08-61407e6af4da,0x1043a,0x200000)
Setting currdev to disk0p2:
/Trying: /VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,0000000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,8b00000000000000)/VenHw(e61d73b9-a384-4acc-aeab-82e828f3628b,17008b0000000000)/HD(3,GPT,155e46ae-665c-11f1-17a5-d14fff7c5968,0x21043a,0xa00000)
Setting currdev to disk0p3:
-\|/-\|/-\|/-\|/-\|/-\Loading /boot/defaults/loader.conf
Loading /boot/defaults/loader.conf
Loading /boot/device.hints
Loading /boot/loader.conf
|Loading /boot/loader.conf.local
[loader menu drawing elided: logo, "Welcome to FreeBSD", options 1-7]
Autoboot in 10 seconds. [Space] to pause ... Autoboot in 0 seconds. Loading kernel...
|/boot/kernel/kernel text=0x318 text=0xa7d088 /-\|/-text=0x284f00 \data=0x16c978 |data=0x0+0x2c2000 0x8+0x1625d0+0x8+0x18bc59/
Loading configured modules...
-can't find '/boot/entropy'
can't find '/etc/hostid'
Using DTB provided by EFI at 0xbd600000.
\Loading splash ok
Loading shutdown splash ok
---<<BOOT>>---
WARNING: Cannot find freebsd,dts-version property, cannot check DTB compliance
Copyright (c) 1992-2025 The FreeBSD Project.
Copyright (c) 1979, 1980, 1983, 1986, 1988, 1989, 1991, 1992, 1993, 1994
	The Regents of the University of California. All rights reserved.
FreeBSD is a registered trademark of The FreeBSD Foundation.
FreeBSD 15.1-RELEASE releng/15.1-n283562-96841ea08dcf GENERIC arm64
FreeBSD clang version 19.1.7 (https://github.com/llvm/llvm-project.git llvmorg-19.1.7-0-gcd708029e0b2)
VT: init without driver.
real memory  = 2147483648 (2048 MB)
avail memory = 2074775552 (1978 MB)
Starting CPU 1 (1)
FreeBSD/SMP: Multiprocessor System Detected: 2 CPUs
arc4random: WARNING: initial seeding bypassed the cryptographic random device because it was not yet seeded and the knob 'bypass_before_seeding' was enabled.
random: entropy device external interface
kbd0 at kbdmux0
ofwbus0: <Open Firmware Device Tree>
psci0: <ARM Power State Co-ordination Interface Driver> on ofwbus0
smccc0: <ARM SMCCC v1.1> on psci0
cpulist0: <Open Firmware CPU Group> on ofwbus0
cpu0: <Open Firmware CPU> on cpulist0
gic0: <ARM Generic Interrupt Controller v3.0> mem 0x8000000-0x800ffff,0x80a0000-0x80dffff on ofwbus0
generic_timer0: <ARMv8 Generic Timer> irq 0,1,2,3 on ofwbus0
Timecounter "ARM MPCore Timecounter" frequency 24000000 Hz quality 1000
Event timer "ARM MPCore Eventtimer" frequency 24000000 Hz quality 1000
smbios0: <System Management BIOS>
smbios0: Entry point: v3 (64-bit), Version: 3.7
uart0: <PrimeCell UART (PL011)> mem 0x9000000-0x9000fff irq 4 on ofwbus0
uart0: console (115200,n,8,1)
pl0310: <PL031 RTC> mem 0x9010000-0x9010fff irq 5 on ofwbus0
pl0310: registered as a time-of-day clock, resolution 1.000000s
virtio_mmio0: <VirtIO MMIO adapter> mem 0xa000000-0xa0001ff irq 6 on ofwbus0
vtblk0: <VirtIO Block Adapter> on virtio_mmio0
vtblk0: 6176MB (12649563 512 byte sectors)
armv8crypto0: <AES-CBC,AES-XTS,AES-GCM>
Timecounters tick every 1.000 msec
usb_needs_explore_all: no devclass
CPU  0: Apple Unknown CPU r0p0 (midr: 610f0000) affinity:  0
                   Cache Type = <IDC,64 byte CWG,64 byte ERG,64 byte D-cacheline,PIPT I-cache,64 byte I-cacheline,0x900000000>
 Instruction Set Attributes 0 = <TLBI-OSR,CondM-8.5,FHM,DP,SHA3,RDM,Atomic,CRC32,SHA2+SHA512,SHA1,AES+PMULL>
 Instruction Set Attributes 1 = <I8MM,EBF16,PredInv v8.9,SB,FRINTTS,GPI,RCPC-8.4,FCMA,JSCVT,Impl PAuth+FPAC+Combined,DCCVADP>
 Instruction Set Attributes 2 = <RPRES>
         Processor Features 0 = <CSV3,CSV2,PSTATE.DIT,RAS,GIC,AdvSIMD+HP,FP+HP,EL1,EL0>
         Processor Features 1 = <MTE_frac,CSV2 p2,SME2,BTI>
         Processor Features 2 = <>
      Memory Model Features 0 = <ExS,TGran4,TGran16,16bit ASID,1TB PA>
      Memory Model Features 1 = <AFP,XNX,SpecSEI,EPAN,LO,HPD+TTPBHA,8bit VMID>
      Memory Model Features 2 = <E0PD,TTL,IDS,AT,NV v8.4,32bit CCIDX,48bit VA,IESB,UAO,CnP>
      Memory Model Features 3 = <>
      Memory Model Features 4 = <>
             Debug Features 0 = <DoubleLock,2 CTX BKPTs,4 Watchpoints,6 Breakpoints,Debugv8>
             Debug Features 1 = <>
         Auxiliary Features 0 = <>
         Auxiliary Features 1 = <>
AArch32 Instruction Set Attributes 5 = <>
AArch32 Media and VFP Features 0 = <>
AArch32 Media and VFP Features 1 = <>
CPU  1: Apple Unknown CPU r0p0 (midr: 610f0000) affinity:  1
gic0: using for IPIs
Release APs...done
TCP_ratelimit: Is now initialized
Trying to mount root from ufs:/dev/gpt/rootfs [rw,noatime]...
random: randomdev_wait_until_seeded unblock wait
random: unblocking device.
Setting hostuuid: 1d899ca6-ece0-45ea-80f6-777c336922f6.
Setting hostid: 0x53fb7220.
Starting file system checks:
/dev/gpt/rootfs: FILE SYSTEM CLEAN; SKIPPING CHECKS
/dev/gpt/rootfs: clean, 699397 free (5 frags, 87424 blocks, 0.0% fragmentation)
/dev/gpt/efiboot0: FILESYSTEM CLEAN; SKIPPING CHECKS
Growing root partition to fill device
vtbd0 recovering is not needed
vtbd0p3 resized
growfs: requested size 5.0GB is equal to the current filesystem size 5.0GB
Mounting local filesystems:.
Setting up harvesting: RANDOMDEV,[CALLOUT],[UMA],[FS_ATIME],SWI,INTERRUPT,NET_NG,[NET_ETHER],NET_TUN,MOUSE,KEYBOARD,ATTACH,CACHED
Feeding entropy: .
ELF ldconfig path: /lib /usr/lib /usr/local/lib /usr/local/lib/compat/pkg /usr/local/lib/compat/pkg
Setting hostname: freebsd.
lo0: link state changed to UP
Starting Network: lo0.
lo0: flags=1008049<UP,LOOPBACK,RUNNING,MULTICAST,LOWER_UP> metric 0 mtu 16384
	options=680003<RXCSUM,TXCSUM,LINKSTATE,RXCSUM_IPV6,TXCSUM_IPV6>
	inet 127.0.0.1 netmask 0xff000000
	inet6 ::1 prefixlen 128
	inet6 fe80::1%lo0 prefixlen 64 scopeid 0x1
	groups: lo
	nd6 options=23<PERFORMNUD,ACCEPT_RTADV,AUTO_LINKLOCAL>
Starting devd.
route: message indicates error: File exists
add host 127.0.0.1: gateway lo0 fib 0: route already in table
route: message indicates error: File exists
add host ::1: gateway lo0 fib 0: route already in table
add net fe80::: gateway ::1
add net ff02::: gateway ::1
add net ::ffff:0.0.0.0: gateway ::1
add net ::0.0.0.0: gateway ::1
Clearing /tmp (X related).
Updating motd:.
Updating /var/run/os-release done.
Creating and/or trimming log files.
Starting syslogd.
Mounting late filesystems:.
Starting cron.
Starting background file system checks in 60 seconds.

Fri Nov 20 02:38:39 UTC 2026

FreeBSD/arm64 (freebsd) (ttyu0)

login: root
Nov 20 02:38:39 freebsd login[1057]: ROOT LOGIN (root) ON ttyu0
FreeBSD 15.1-RELEASE (GENERIC) releng/15.1-n283562-96841ea08dcf

Welcome to FreeBSD!

Release Notes, Errata: https://www.FreeBSD.org/releases/
Security Advisories:   https://www.FreeBSD.org/security/
FreeBSD Handbook:      https://www.FreeBSD.org/handbook/
FreeBSD FAQ:           https://www.FreeBSD.org/faq/
Questions List:        https://www.FreeBSD.org/lists/questions/
FreeBSD Forums:        https://forums.FreeBSD.org/

Documents installed with the system are in the /usr/local/share/doc/freebsd/
directory, or can be installed later with:  pkg install en-freebsd-doc
For other languages, replace "en" with a language code like de or fr.

Show the version of FreeBSD installed:  freebsd-version ; uname -a
Please include that output and any error messages when posting questions.
Introduction to manual pages:  man man
FreeBSD directory layout:      man hier

To change this login announcement, see motd(5).
resizewin: timeout reading from terminal
root@freebsd:~ # uname -sr
FreeBSD 15.1-RELEASE
root@freebsd:~ # shutdown -p now
Shutdown NOW!
shutdown: [pid 1062]
root@freebsd:~ #
*** FINAL System shutdown message from root@freebsd ***

System going down IMMEDIATELY



Nov 20 02:38:42 freebsd shutdown[1062]: power-down by root:
System shutdown time has arrived
Stopping cron.
Waiting for PIDS: 1000.
Stopping devd.
Waiting for PIDS: 537.
Writing entropy file: .
Writing early boot entropy file: .
.
Terminated
Nov 20 02:38:42 freebsd syslogd: exiting on signal 15
Waiting (max 60 seconds) for system process `vnlru' to stop... done
Waiting (max 60 seconds) for system process `syncer' to stop...
Syncing disks, vnodes remaining... 0 0 done
All buffers synced.
Uptime: 5s
```
