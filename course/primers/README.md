# Primers

A primer is a standalone tutorial of 20 to 30 minutes for one idea the course borrows from somewhere
else: an operating-system idea, a corner of the Arm architecture, a file format, a piece of Unix
or macOS, or a Rust technique. You read a primer **before** the chapter that first requires it.
Each chapter's "Concepts you'll need" box links the primers it needs, so you never have to work
out the order yourself.

All 24 primers together take about 11 hours. The ones on the path to a Linux shell (chapters 00
to 14) take about 8 hours. Words in **bold** inside a primer are in the
[glossary](/build-your-own/vmm/glossary/).

How to read the tables: **Min** is the reading time in minutes. **Required by** is the first
chapter that needs the primer. **Builds on** lists the primers it assumes you have read. **Lab**
is the in-browser lab it embeds, if it has one; every primer ends with a self-check either way.

## Virtualization and OS basics

| Primer | Min | Required by | Builds on | What it gives you | Lab |
|---|---|---|---|---|---|
| [OS basics: processes, memory, syscalls, interrupts](/build-your-own/vmm/primers/os-basics/) | 30 | [00](/build-your-own/vmm/start/orientation/) | none | Processes and exit codes, user versus kernel mode, virtual memory with a two-level page table, a system call traced through the hardware, interrupts, and what firmware is. | [`syscall-stepper`](/build-your-own/vmm/labs/syscall-stepper/) |
| [Block storage: disk images, ext4, durability](/build-your-own/vmm/primers/block-storage/) | 30 | [18](/build-your-own/vmm/virtio/virtio-blk/) | `os-basics`, `host-concurrency`, `linux-boot-sequence` | Sectors and raw images, ext4 in one picture, `root=`, the page cache, and why `fsync` is not `F_FULLFSYNC` on macOS. | [`durability-ladder`](/build-your-own/vmm/labs/durability-ladder/) |

## ARM64

| Primer | Min | Required by | Builds on | What it gives you | Lab |
|---|---|---|---|---|---|
| [Reading AArch64: registers, instructions, byte order](/build-your-own/vmm/primers/aarch64-reading/) | 30 | [02](/build-your-own/vmm/bare-machine/first-exit/) | `os-basics` | Registers (`x0` and `w0`, register 31), AAPCS64, system-register names, the 32-bit instruction word, reading a disassembly, little-endian versus big-endian. | [`a64-encoder`](/build-your-own/vmm/labs/a64-encoder/) |
| [SMCCC: the calling convention for calls to a higher level](/build-your-own/vmm/primers/smccc/) | 25 | [03](/build-your-own/vmm/bare-machine/test-guests/) | `os-basics`, `aarch64-reading` | How `hvc` and `smc` calls pass a function ID and arguments in registers, fast calls, and how PSCI's `SYSTEM_OFF` gets its number. | [`sysreg-smccc`](/build-your-own/vmm/labs/sysreg-smccc/) |
| [Page granules: 4 KiB and 16 KiB](/build-your-own/vmm/primers/page-granules/) | 20 | [04](/build-your-own/vmm/memory/guest-memory/) | `os-basics` | Why a 4 KiB guest runs on HVF's 16 KiB stage 2, and what the coarser stage 2 costs. | [`two-stage-walker`](/build-your-own/vmm/labs/two-stage-walker/) |
| [Page tables: stage-1 translation](/build-your-own/vmm/primers/page-tables/) | 30 | [05](/build-your-own/vmm/memory/address-space/) | `os-basics`, `aarch64-reading` | The guest's own translation: the address split, `TTBR`, `TCR`, levels and descriptors, MMU on and off, Normal versus Device memory and `MAIR_EL1`. | [`two-stage-walker`](/build-your-own/vmm/labs/two-stage-walker/) |
| [Reading the ARM ARM and other primary specs](/build-your-own/vmm/primers/reading-arm-specs/) | 30 | [07](/build-your-own/vmm/cpu/exit-loop/) | `aarch64-reading` | How to find and read a register page, the ESR syndrome tables and the pseudocode, the RAZ/WI and RES0 vocabulary, and virtio's MUST and SHOULD. | [`esr-decoder`](/build-your-own/vmm/labs/esr-decoder/) |
| [PrimeCell peripheral IDs](/build-your-own/vmm/primers/primecell-ids/) | 20 | [09](/build-your-own/vmm/devices/mmio-pl011/) | `aarch64-reading`, `reading-arm-specs` | The ID registers at `0xFE0` to `0xFFC` that Linux reads before it binds a driver to a PL011 or PL031. | none |
| [Caches and coherency](/build-your-own/vmm/primers/caches/) | 30 | [13](/build-your-own/vmm/linux/loaders/) | `os-basics`, `aarch64-reading` (`page-tables` helps) | Cache lines, data and instruction caches, PoC and PoU, clean versus invalidate, and the experiment showing what macvmm must do before an MMU-off guest runs. | [`cache-views`](/build-your-own/vmm/labs/cache-views/) |
| [Memory ordering and barriers](/build-your-own/vmm/primers/memory-ordering/) | 30 | [16](/build-your-own/vmm/virtio/virtqueues/) | `host-concurrency`, `aarch64-reading` (`caches` helps) | Weak memory on arm64, `Acquire`, `Release` and `SeqCst` as real instructions, fences, and the virtqueue lost-wakeup race. | [`litmus`](/build-your-own/vmm/labs/litmus/) |

## Boot and formats

| Primer | Min | Required by | Builds on | What it gives you | Lab |
|---|---|---|---|---|---|
| [The arm64 boot protocol](/build-your-own/vmm/primers/arm64-boot-protocol/) | 30 | [06](/build-your-own/vmm/cpu/vcpu-state/) | `aarch64-reading`, `page-tables` | What `booting.rst` requires at a kernel's first instruction: `x0` = DTB, DAIF masked, MMU off, "cleaned to the PoC", the Image header and where everything goes in RAM. | [`image-inspector`](/build-your-own/vmm/labs/image-inspector/) |
| [ELF: the file the linker hands you](/build-your-own/vmm/primers/elf/) | 25 | [13](/build-your-own/vmm/linux/loaders/) | `bare-metal-rust` | ELF64 headers and program headers, `filesz` versus `memsz`, and the checks a loader of hostile files must make. | [`elf-inspector`](/build-your-own/vmm/labs/elf-inspector/) |
| [cpio and the initramfs](/build-your-own/vmm/primers/cpio-initramfs/) | 25 | [13](/build-your-own/vmm/linux/loaders/) | `os-basics`, `aarch64-reading`, `arm64-boot-protocol` | The newc cpio format byte by byte, its padding rule, and why the kernel needs files before it has a disk. | [`cpio-inspector`](/build-your-own/vmm/labs/cpio-inspector/) |
| [EFI zboot: the kernel that is also a program](/build-your-own/vmm/primers/efi-zboot/) | 25 | [13](/build-your-own/vmm/linux/loaders/) | `os-basics`, `arm64-boot-protocol`, `elf` | Why Alpine's `vmlinuz-virt` is a compressed EFI application, the zboot header, gzip as a container, and the PE/COFF header in one page. | [`image-inspector`](/build-your-own/vmm/labs/image-inspector/) |
| [The Linux boot sequence](/build-your-own/vmm/primers/linux-boot-sequence/) | 30 | [14](/build-your-own/vmm/linux/linux-boot/) | `os-basics`, `arm64-boot-protocol`, `cpio-initramfs` | From the Image entry to `/init`, stage by stage, with the boot-log lines each stage prints. | [`boot-log-annotator`](/build-your-own/vmm/labs/boot-log-annotator/) |
| [UEFI: the interface between firmware and an OS loader](/build-your-own/vmm/primers/uefi/) | 30 | [21](/build-your-own/vmm/firmware/firmware/) | `os-basics`, `arm64-boot-protocol`, `efi-zboot` | UEFI as an interface: boot and runtime services, `ExitBootServices`, the configuration table that carries the DTB, and where U-Boot and EDK2 fit. | [`boot-chain`](/build-your-own/vmm/labs/boot-chain/) |
| [U-Boot: the firmware we run first](/build-your-own/vmm/primers/u-boot/) | 30 | [21](/build-your-own/vmm/firmware/firmware/) | `uefi`, `arm64-boot-protocol`, `smccc` | What U-Boot does on our machine, its prompt and environment, `bootflow` and `bootefi`, and how it hands Linux or FreeBSD the DTB. | [`boot-chain`](/build-your-own/vmm/labs/boot-chain/) |

## Host (Unix and macOS)

| Primer | Min | Required by | Builds on | What it gives you | Lab |
|---|---|---|---|---|---|
| [Code signing and entitlements](/build-your-own/vmm/primers/codesign-entitlements/) | 25 | [01](/build-your-own/vmm/start/ffi/) | none | Why an unsigned program gets `HV_DENIED`, ad-hoc signing with the one hypervisor entitlement, and (going deeper) AMFI, the hardened runtime and restricted entitlements. | none |
| [Unix signals: who decides how a program ends](/build-your-own/vmm/primers/unix-signals/) | 30 | [09](/build-your-own/vmm/devices/mmio-pl011/) | `os-basics`, `host-concurrency` | Default actions, exit status `128 + n`, async-signal safety, and the self-pipe trick macvmm uses for SIGINT, SIGTERM, SIGHUP and SIGUSR1. | none |
| [TTYs, termios and escape sequences: who owns your keystrokes](/build-your-own/vmm/primers/tty-termios/) | 25 | [09](/build-your-own/vmm/devices/mmio-pl011/) | `os-basics`, `unix-signals` | Canonical versus raw mode, how Ctrl-C becomes SIGINT, restoring the terminal, and why bytes from a guest can spoof the host terminal. | [`ansi-filter`](/build-your-own/vmm/labs/ansi-filter/) |
| [Unix domain sockets: a wire between two programs, named by a file](/build-your-own/vmm/primers/unix-sockets/) | 30 | [19](/build-your-own/vmm/virtio/virtio-net/) | `os-basics` | Stream versus datagram, socket-file permissions, stale sockets, and why no entitlement is needed to connect two VMs. | none |
| [The macOS sandbox, rlimits and other one-way doors](/build-your-own/vmm/primers/macos-sandbox/) | 30 | [25](/build-your-own/vmm/production/security/) | `os-basics`, `codesign-entitlements` | Seatbelt profiles, `(deny default)`, what macvmm locks down after start-up, `RLIMIT_CORE`, `umask` and `O_CLOEXEC`. | none |

## Rust

| Primer | Min | Required by | Builds on | What it gives you | Lab |
|---|---|---|---|---|---|
| [Bare-metal Rust: no_std, linker scripts, flat binaries](/build-your-own/vmm/primers/bare-metal-rust/) | 30 | [03](/build-your-own/vmm/bare-machine/test-guests/) | `aarch64-reading` | What `no_std` and `no_main` remove, target triples, sections, a linker script that puts `_start` at `0x4008_0000`, BSS and stack, and ELF to flat binary. | [`linker-map`](/build-your-own/vmm/labs/linker-map/) |
| [Host concurrency: threads, locks, atomics](/build-your-own/vmm/primers/host-concurrency/) | 30 | [09](/build-your-own/vmm/devices/mmio-pl011/) | `os-basics` | Threads and file descriptors, why HVF ties a vCPU to its thread, `Arc`, `Mutex`, `Condvar`, `thread::scope`, atomics as flags, and a fixed lock order. | [`lock-order`](/build-your-own/vmm/labs/lock-order/) |

## Reading order

If you prefer to read primers in one sitting rather than chapter by chapter, this order respects
every "builds on" link above:

1. Before chapter 00 to 05: `os-basics`, `codesign-entitlements`, `aarch64-reading`, `smccc`,
   `bare-metal-rust`, `page-granules`, `page-tables`.
2. Before chapters 06 to 09: `arm64-boot-protocol`, `reading-arm-specs`, then for chapter 09
   `host-concurrency`, `unix-signals`, `tty-termios` (in that order) and `primecell-ids`.
3. Before chapters 13 and 14: `caches`, `elf`, `cpio-initramfs`, `efi-zboot`, `linux-boot-sequence`.
4. Later: `memory-ordering` (16), `block-storage` (18), `unix-sockets` (19), `uefi` then `u-boot`
   (21), `macos-sandbox` (25).
