# VZ versus macvmm: the comparison and the component inventory

**Purpose.** The input to course chapters 23 and 24 and to PLAN M21. Part 1 compares the two
virtual machines that boot the *same* Linux kernel. Part 2 lists what a low-level VMM would
have to provide to boot macOS the way Virtualization.framework (VZ) does.

**Evidence tags** (as in `docs/research/macos-guest.md` §0): **[V-local]** observed on the
development machine (Apple M5 Pro, macOS 27.2.1 build 26B131, Virtualization.framework
`CFBundleVersion` 308.2.7, 2026-11-18) with `tools/vz-mac`; **[V-src]** from SDK headers or
QEMU sources; **[R]** reported elsewhere; **[U]** unverified.

How Part 1 was observed: `vz-mac linux` booted Alpine's 6.18.60 kernel (the extracted `Image`
is byte-identical to the pinned `Image-virt`, sha256 `a2cecb9b…`) with Alpine's own
`initramfs-virt` and `console=hvc0`; the commands `cat /proc/iomem`, `cat /proc/interrupts`,
`dmesg`, `ls /sys/bus/pci/devices` and `ls /proc/device-tree` were typed into its emergency
shell over `hvc0`. Raw transcripts are not committed; the facts are below.

## Part 1: the same kernel on two machines

### 1.1 Memory map

| Region | macvmm `virt` (architecture §5.1) | VZ generic platform [V-local] |
|---|---|---|
| Firmware / flash | `0x0000_0000` (with `--bios`) | none visible; VZ enters the kernel itself (`efi: UEFI not found`) |
| GIC distributor | `0x0800_0000` | `0x1000_0000` (GICD, 64 KiB) |
| GIC redistributors | `0x080A_0000`, 128 KiB per vCPU | `0x1001_0000`, 128 KiB per vCPU (`CPU1: found redistributor 1 region 0:0x10030000`) |
| UART | PL011 at `0x0900_0000` | **none** |
| RTC | PL031 at `0x0901_0000` | PL031 at `0x2005_0000` |
| GPIO | (reserved `0x0903_0000`) | PL061 at `0x2006_0000`, with a `gpio-keys` "GPIO Key Power" node |
| Device transport | virtio-mmio, 32 slots at `0x0a00_0000` | **PCIe**: ECAM `0x4000_0000`, 32-bit MMIO `0x5000_0000`, 64-bit MMIO from `0x1_0000_0000` |
| RAM | `0x4000_0000` | `0x7000_0000` (the same base as QEMU's `vmapple`, macos-guest.md §3.1) |
| DT root | `macvmm-virt` | node `hypervisor` with compatible `apple,virtualization-generic-platform`; no root `compatible` property |

### 1.2 Interrupts, timer, CPU

| Item | macvmm | VZ [V-local] |
|---|---|---|
| Interrupt controller | HVF in-kernel GICv3 (`hv_gic_create`, ADR-0004) | GICv3, 988 SPIs, no extended SPIs, `GICD_CTLR.DS=1`, no ITS seen |
| Timer | virtual timer PPI, INTID 27, via `HV_EXIT_REASON_VTIMER_ACTIVATED` | `arch_timer: cp15 timer running at 24.00MHz (virt)`, INTID 27 level |
| Device interrupts | level SPIs 16+i for virtio-mmio slot i | virtio-pci devices on INTID 69, 70 (level); PL031 on INTID 36 |
| Firmware interface | PSCI 1.1 over HVC (architecture §8.6) | `psci: PSCIv1.1 detected`, `method = "hvc"`, SMCCC 1.1 |
| CPU identity | host MIDR through HVF | `MIDR 0x610f0000` (implementer 0x61 Apple, part 0x000): a synthetic ID |
| CPU features | what HVF exposes (masking is post-v1 W15) | SME and SME2 visible to the guest, PAC with the IMP DEF algorithm, BTI |

### 1.3 Devices

| Function | macvmm | VZ [V-local] |
|---|---|---|
| Console | PL011 `ttyAMA0` (M6), optional virtio-console `hvc0` (M13) | virtio-console over PCI, `1af4:1043` (device ID 3), `hvc0` only |
| Entropy | virtio-rng over MMIO (M12) | virtio-rng over PCI, `1af4:1044` (device ID 4), when configured |
| Block | virtio-blk over MMIO (M14) | virtio-blk over PCI (`VZVirtioBlockDeviceConfiguration`) [V-src] |
| Host bridge | none (no PCI in v1) | Apple `106b:1a05`, class 0x0600 |
| Power button | none (PSCI SYSTEM_OFF from the guest only) | PL061 GPIO key: `VZVirtualMachine.requestStop` presses it |
| Kernel drivers needed | `VIRTIO_MMIO` (a **module** in Alpine's config, so the initramfs must load it) | `VIRTIO_PCI`, `PCI_HOST_GENERIC`, `VIRTIO_CONSOLE`: all built in (`config-6.18.60-0-virt`) |

### 1.4 Who does the work

| Step | macvmm (we write it) | VZ (Apple does it) |
|---|---|---|
| Create the VM, map RAM | `hvf` crate, `memory/` (M1, M2) | `VZVirtualMachine(configuration:)` |
| Load kernel and initrd, place the DTB | `loader/`, `fdt/` (M7, M9) | `VZLinuxBootLoader`; the DTB is generated inside VZ |
| Run vCPUs, handle exits | `vcpu/` run loop, one thread per vCPU (M3–M5) | the XPC service; the client never sees an exit |
| Emulate devices | `devices/`, `virtio/` | the XPC service |
| Console to the terminal | `AnsiFilter` (TTY-1) on PL011/virtio TX | raw bytes to a file handle; vz-mac adds a `strict` filter (TTY-5) |
| Signing | ad hoc, `com.apple.security.hypervisor`, hardened runtime | ad hoc, `com.apple.security.virtualization`, hardened runtime [V-local] |
| Process privilege inside Apple's code | none | the XPC service holds `com.apple.private.hypervisor` and other private entitlements (macos-guest.md §1.3) |

**Observed lesson** [V-local]: Alpine's emergency shell sends `ESC [ 6 n` (a cursor-position
query, which the TTY-3 allow-list drops) as soon as it starts, and `ls` colours its output with
SGR. Under vz-mac's `strict` filter both appear as visible text (`^[[6n`, `^[[1;34m`). Guest
consoles do emit terminal queries in normal operation, which is why TTY-1 filters every stream.

## Part 2: inventory for a low-level macOS VMM (input to M21)

What VZ supplies for a macOS guest, and what macvmm would need instead. Sources: VZ headers
**[V-src]**, `macos-guest.md` §1–§3 (QEMU `vmapple` facts), and `vz-mac boot --dry-run` on a
bundle built from the latest restore image's metadata **[V-local]**.

| # | Component | VZ API / where it lives | What a low-level VMM must provide | Documented? | macos-guest.md work item |
|---|---|---|---|---|---|
| 1 | Machine identity: hardware model | `VZMacHardwareModel` (opaque 132-byte blob [V-local]) | the platform version the guest expects, in the cfg region | no | W4 |
| 2 | Machine identity: ECID | `VZMacMachineIdentifier`: a plist `{ECID: UInt64}` [V-local]; values exceed `Int64.max` (one seen: `0xca8d706a46fe7143`) | the same ECID in the cfg region (`vz-mac ecid`) | no (opaque in the header) | W4 |
| 3 | Auxiliary storage (NVRAM, boot policy) | `VZMacAuxiliaryStorage`: a fresh one is 33,570,816 bytes = 32 MiB + a 0x4000-byte header [V-local] | a pflash/bdif view of the 32 MiB body (`vz-mac trim-aux`) | no | W5 |
| 4 | Boot ROM | `VZMacOSBootLoader` runs `AVPBooter.vmapple2.bin` from the framework's Resources | load it read-only from the system path at run time (D4, never copied) | no | W2 |
| 5 | Config region (cfg) | internal to VZ | the struct QEMU documents (ECID, run-installer flags, CPU count, …) | QEMU only | W4 |
| 6 | Boot-disk "backdoor" block interface (bdif) | internal | hostile-input-hardened block reads for AVPBooter | QEMU only | W5 |
| 7 | Interrupts | GICv3 at `0x1000_0000` / `0x1001_0000` (the same layout VZ's generic platform uses, §1.1) | HVF's in-kernel GIC accepts this layout [V-local, macos-guest.md §1.4] | yes (GIC spec) | W1 |
| 8 | RTC, GPIO power button, pvpanic | PL031, PL061 + `gpio-keys`, `MmioPvPanicDevice` | the same devices at the vmapple bases | partly (ARM TRMs, QEMU) | W6 |
| 9 | PCIe host bridge and virtio-pci | VZ's generic platform already uses PCIe for every virtio device (§1.3) | ECAM, BAR assignment, INTx, the virtio-pci modern transport | yes (PCIe, virtio 1.2 §4.1) | W7, W8 |
| 10 | Storage | `VZVirtioBlockDeviceConfiguration` (the main disk must be the first storage device) | vmapple's virtio-blk variant | QEMU only | W9 |
| 11 | AES engine | internal (`AppleAesEngine`) | FIFO, DMA, CBC/CTR/ECB | QEMU only | W10 |
| 12 | Keyboard and trackpad | `VZMacKeyboardConfiguration`, `VZMacTrackpadConfiguration` | XHCI plus USB HID | partly | W11 |
| 13 | Graphics | `VZMacGraphicsDeviceConfiguration` (ParavirtualizedGraphics) | the private, changing PG bridge | **no**, and it changed in macOS 27 (macos-guest.md §1.5) | W12 |
| 14 | Network | `VZNATNetworkDeviceAttachment` (no entitlement) or bridged (needs `com.apple.vm.networking`) | virtio-net plus a host backend | yes | W13 |
| 15 | CPU mode | the XPC service's private `com.apple.private.hypervisor` | the private Apple ISA mode: `HV_DENIED` to us [V-local] | no | W16 (blocked) |
| 16 | Installation and personalization | `VZMacOSInstaller` + Apple's signing server, keyed by ECID | **not possible**: install with VZ, boot elsewhere (QEMU's workflow) | no | — |

**The three hardest pieces** (ch23 journal question 4, the project's answer): the CPU mode (15)
is blocked by an entitlement, not by complexity; graphics (13) is hard because it is private and
moving; the AES engine and personalization chain (11, 16) are hard because they are
undocumented and tied to Apple's signing service. PCIe (9) is large but documented, and pays
for itself for EDK2 and FreeBSD.
