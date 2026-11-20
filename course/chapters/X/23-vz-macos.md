---
title: macOS guests, the high road: Virtualization.framework
part: X
chapter: X.1
id: 23
runs: mac
minutes: 180
prereqs: [14]
start_tag: ch-22
labs: []
command: scripts/checkpoint.sh 23
expect: CHECKPOINT 23 PASS
---

:::retrieval from=13,10,01

:::concepts
- **Core, taught here:** Virtualization.framework (VZ) as a machine Apple defines and you configure; `VZLinuxBootLoader`; where a VZ guest runs (an XPC service with private entitlements); the two entitlements compared; for macOS guests, restore images, the Mac platform identity, `VZMacOSBootLoader` and Apple-specific devices; the inventory of what a low-level VMM must provide.
- **Core, from earlier:** a guest as a host process, and paravirtual devices (chapter 00); VZ's place in the macOS stack and the hypervisor entitlement (chapter 01); exception levels (chapter 02); the memory map (chapter 05); memory-mapped I/O, MMIO (chapter 07); the PL011, `ttyAMA0` and the output filter (chapter 09); the device tree (chapter 10); the Generic Interrupt Controller, GIC (chapter 12); the loader and test initramfs (chapter 13); booting Linux to a shell (chapter 14).
- **Primers (read first):** `codesign-entitlements`, including its optional sections on [restricted entitlements](/build-your-own/vmm/primers/codesign-entitlements/#going-deeper-restricted-entitlements-and-provisioning-profiles) and [the hardened runtime](/build-your-own/vmm/primers/codesign-entitlements/#going-deeper-the-hardened-runtime-and-dyld). 
- **Primers (review):** `tty-termios` (escape sequences, and its section on why bytes from a guest are dangerous); `linux-boot-sequence` (kernel modules); `uefi` (only the name, for one table row).
- **Pointers:** Apple's Virtualization documentation and software development kit (SDK) headers; Apple's licence for macOS virtual machines (cited, not interpreted); Swift; PCI Express; XPC services.
- **Forward definitions:** virtio and its virtio-mmio transport (chapter 15), and virtio-console with its Linux name `hvc0`, and virtio-rng (chapter 17); virtio-blk, virtio's disk (chapter 18); AVPBooter, Apple's boot ROM for virtual Macs, and ParavirtualizedGraphics (chapter 24). Each is defined where it first appears.
:::

In chapter 14 your virtual machine monitor (VMM) booted Alpine's kernel with the command line `console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=boot`, and the test initramfs printed `macvmm-initramfs: ready`. Now give the same kernel file, the same initramfs file and that command line minus its `earlycon=` word to a different VMM: the one Apple ships inside macOS, Virtualization.framework. The `earlycon=` word goes because it names an address on *our* machine, the PL011 at `0x0900_0000`, which means nothing on a machine whose map you have not seen. Same Mac, same CPU, the same files. What appears on your terminal?

:::predict The kernel and the initramfs are byte for byte what your VMM booted in chapter 14, and the command line is `console=ttyAMA0 macvmm.test=boot`, chapter 14's without the early console. Under Virtualization.framework, will you see (a) the same boot log ending in `macvmm-initramfs: ready`, (b) a kernel panic, or (c) something else? If you think the command line needs a change, which change, and why?
Write your answer under `## Predict` in your journal now, before you read on. The section "Same kernel, another machine" runs it.
:::

Every row of the [problem ledger](/build-your-own/vmm/glossary/#problem-ledger) is closed (this chapter needs only chapter 14's), so this chapter sits beyond it. It makes explicit what the ledger left implicit: a machine is its whole contract of devices and firmware, and a kernel that boots on one meets a different contract on the next. Plan about 3 hours at your Mac. There is no Rust to write: you read and run a small tool, and write two short documents.

:::objectives
- Explain, with an example from your own runs, what Virtualization.framework (VZ) supplies that Hypervisor.framework (HVF) does not: a complete machine with Apple's memory map, devices and boot loader, and, for macOS guests, restore images, the Mac platform identity, `VZMacOSBootLoader` and paravirtual graphics.
- Build and run the provided Swift tool `tools/vz-mac/`, signed with exactly `com.apple.security.virtualization`; boot our Linux test initramfs under VZ, and predict, then explain from the output, which console it prints on.
- Compare the two programs' entitlements with `codesign`, find with `ps` which process runs a VZ guest, and state whose code a hostile guest attacks in each case.
- Inventory what a low-level VMM must provide to boot macOS, marking each piece documented or undocumented; chapter 24 starts from it.
:::

**Before you start.** From the repository root, run `scripts/learner start 23` to copy this chapter's journal to `learner/journal/23.md`. You also need Xcode, for the `swift` command (`swift --version` should print a version), and the kernel and initramfs from chapter 13 in `.cache/macvmm/`. If `swift` complains about the Xcode licence, open Xcode once and accept it there; no `sudo` is needed.

## Configured, not built

Chapter 01 placed two Apple frameworks side by side. With [HVF](/build-your-own/vmm/glossary/#hvf) you build the machine, as every Part so far did. With [VZ](/build-your-own/vmm/glossary/#vz) you *describe* the machine, and Apple builds and runs it: a boot loader, a platform, a CPU count, a memory size and a list of devices.

The tool in this chapter, vz-mac, is a small Swift program, because VZ has no C interface to call from Rust; you read and run it, not write it.

> **Aside.** Swift is Apple's language for its own frameworks; VZ is an Objective-C and Swift interface. If a line puzzles you, see [The Swift Programming Language](https://docs.swift.org/swift-book/): `let` is Rust's `let`, `var` is `let mut`, and `throws` marks a function that can fail, like a `Result`. Apple's reference for every class below is the [Virtualization documentation](https://developer.apple.com/documentation/virtualization).

Here is the whole machine definition for a Linux guest, from `tools/vz-mac/Sources/vz-mac/LinuxBoot.swift`:

:::code anchor=vz_linux_config file=tools/vz-mac/Sources/vz-mac/LinuxBoot.swift

`VZLinuxBootLoader` takes a kernel, an initramfs and a command line: chapter 13's loader and boot plan, and chapter 10's device tree, in three lines, because VZ writes its own device tree and places everything itself. `VZGenericPlatformConfiguration` is Apple's generic 64-bit Arm machine, with its memory map, interrupt controller and timer. The `serialPorts` line gives one serial port, a `VZVirtioConsoleDeviceSerialPortConfiguration`; there is no PL011 class to choose instead, and the next section's run shows what that means. The `entropyDevices` line adds a random-number source.

| Your VMM, and the chapter that built it | The line in VZ's configuration |
|---|---|
| guest RAM and the region table (04, 05) | `config.memorySize` |
| virtual CPUs (vCPUs), the exit loop, power calls (06 to 08) | `config.cpuCount` |
| the PL011 (09) | `config.serialPorts`: a serial port of another kind (next section) |
| the device tree (10) | generated inside VZ, never shown to you |
| the GIC and the timer (11, 12) | inside `VZGenericPlatformConfiguration` |
| the loader and the boot plan (13) | `VZLinuxBootLoader` |

*Every job on the left still exists under VZ. Apple's code does it, and you cannot read it.*

## Building and signing the tool

`tools/vz-mac/run.sh` does for vz-mac what the signing runner does for `macvmm`: it runs `swift build`, copies the binary to `target/vz-mac/signed/vz-mac`, signs the copy ad hoc with `tools/vz-mac/vz-mac.entitlements`, reads the signature back, and only then runs it. It also signs with the **hardened runtime** (`codesign -o runtime`), which among other things makes macOS ignore the `DYLD_*` environment variables that could inject code into the process.

Build and sign without running anything, sign `macvmm` in place, then compare the two signatures:

```sh
tools/vz-mac/run.sh --print-path
scripts/sign.sh target/debug/macvmm
codesign -d --entitlements - target/vz-mac/signed/vz-mac
codesign -d --entitlements - target/debug/macvmm
```

The first `run.sh` compiles vz-mac (a minute or so; build lines go to standard error), then, with `--print-path`, prints where the signed copy is, `target/vz-mac/signed/vz-mac` under your repository, and runs nothing. The second line matters because `cargo run` signs a private copy under `target/run-bin/`, so `target/debug/macvmm` carries only the linker's signature until you sign it in place.

:::term source=captures/23-codesign-vz.txt

:::term source=captures/23-codesign-macvmm.txt

Two programs, one self-granted [entitlement](/build-your-own/vmm/glossary/#entitlement) each. `com.apple.security.hypervisor` lets `macvmm` create a virtual machine (VM) and run vCPUs itself; `com.apple.security.virtualization` lets vz-mac ask VZ for a whole machine. In separate programs, a bug in one cannot borrow the other's right.

## Same kernel, another machine

Time for your Predict. Run chapter 14's command line, minus the `earlycon=` word:

```sh
tools/vz-mac/run.sh linux --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --cmdline "console=ttyAMA0 macvmm.test=boot"
```

:::term source=captures/23-vz-ttyama0.txt

We checked this on a real Mac: (c). Not one byte on standard output, yet `VZ guest state: stopped (guest)` and exit 0: the guest powered itself off, and the only code in this initramfs that does so is `/init`, after it prints `macvmm-initramfs: ready`. So the kernel booted, `/init` ran and printed, and nobody heard.

`ttyAMA0` is the name Linux gives a PL011, and this machine has no PL011. Its one serial port, the `VZVirtioConsoleDeviceSerialPortConfiguration` from the configuration, is a **virtio-console**. [Virtio](/build-your-own/vmm/glossary/#virtio) is the standard family of devices designed for virtual machines, which share memory with the VMM instead of trapping on every register (chapter 15 builds its transport), and virtio-console is its serial port; Linux calls the first one `hvc0` (chapter 17 adds one to your VMM). The random-number source was virtio-rng, virtio's random-number device (also chapter 17).

When the command line names a console, Linux enables only a console of that name. The virtio-console registered but was never switched on, so `/init`'s bytes went nowhere. Now name the console this machine has:

:::term source=captures/23-vz-linux.txt

The marker line: the same files boot to the end, so the first run did not panic either. Two lines deserve a second look:

- `rtc-pl031 20050000.pl031`. Chapter 14's run said `rtc-pl031 9010000.pl031`: the same real-time clock (RTC) design, at another address. Same kernel, different machine.
- The first line: 44 milliseconds in, not `0.000000`. Chapter 14 had an early boot console, `earlycon`, printing from the kernel's first line; this machine has none.

So when did `hvc0` start printing? Ask the guest, in the test initramfs's `shell` case, which stops at a `/ #` prompt:

```sh
tools/vz-mac/run.sh linux --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --cmdline "console=hvc0 macvmm.test=shell"
```

At the prompt, type `dmesg | grep -i -e console -e virtio`, then `poweroff -f`:

:::term source=captures/23-vz-console-dmesg.txt

(Times vary a little from run to run.) The kernel enabled `hvc0` only after finding the virtio devices. The earlier lines are still in the log buffer, since `dmesg` reads them back, but `hvc0` did not replay them. `ttyAMA0` did: in the `macvmm` shell run in the next section, with no early console, `printk: console [ttyAMA0] enabled` comes about 4 milliseconds in, yet the log on your terminal starts at `0.000000`. We have not checked why `hvc0` skipped it.

The misconception this retires is "the same PL011". The kernel is identical; the machine is not, and the command line is part of their contract.

From the repository root, this chapter's `cargo run` lines run the reference VMM. To use yours, run them inside `learner/` with `../.cache/macvmm/`. Two options, `--console` and `--serial none`, arrive in chapter 17; if you came straight from chapter 14, use the reference.

> **Try it.** Run the mirror image on a VMM of ours: `macvmm` with `console=hvc0` and no `--console` option (the option that adds a virtio-console), so it has no virtio-console. Predict before you look.

:::term source=captures/23-macvmm-hvc0.txt

Silence again, exit 0, for the same reason in reverse. Now add a virtio-console on standard output with `--console stdio`. Only one of `--serial` (where the PL011's output goes, chapter 09) and `--console` may own standard output, and `--serial` takes it by default, so send the PL011 nowhere with `--serial none`:

:::term source=captures/23-macvmm-hvc0-console.txt

Still silent, and this time the device is there. In Alpine's kernel the virtio-mmio transport, the code that finds virtio devices at fixed addresses as our VMM places them (chapter 15), is a loadable module (`scripts/initramfs/init` notes this; the `linux-boot-sequence` primer explains modules). The `boot` case never loads it, so no driver finds the console. Under VZ the console sits on a different bus, PCI Express (next section), whose driver is built in.

One more variant, for the spec hunt at the end: a VZ boot whose command line names no console at all.

:::term source=captures/23-vz-noconsole.txt

Silent again, exit 0. The spec hunt asks which console Linux picks when you name none.

## Looking inside Apple's machine

VZ never shows its device tree, but the guest can describe what it found. Boot the `shell` case again under VZ, and then under a VMM of ours:

```sh
tools/vz-mac/run.sh linux --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --cmdline "console=hvc0 macvmm.test=shell"
cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --mem 512M --cmdline "console=ttyAMA0 macvmm.test=shell" --timeout 300
```

At each `/ #` prompt, type the same lines. The `for` loop prints every Peripheral Component Interconnect (PCI) device the kernel found, with its vendor and device IDs:

```text
cat /proc/consoles
dmesg | head -n 3
cat /proc/iomem
for d in /sys/bus/pci/devices/*; do echo $d $(cat $d/vendor $d/device); done
poweroff -f
```

Leave with `poweroff -f`. Ctrl-C also works under vz-mac, which then exits 130; under `macvmm`, Ctrl-C goes to the guest, and `Ctrl-A` then `x` quits (chapter 09). The captures piped these lines in; if `macvmm` stops with exit 5 while you type, its `--timeout` ran out, so raise it. First VZ:

:::term source=captures/23-vz-shell.txt

Then your VMM:

:::term source=captures/23-macvmm-shell.txt

Where our VMM puts devices at fixed addresses, VZ puts its virtio devices on [**PCI Express**](/build-your-own/vmm/glossary/#pcie) (PCIe), the bus ordinary computers use for expansion cards. The operating system finds each device by reading its vendor and device IDs from a configuration space ([Linux PCI documentation](https://docs.kernel.org/PCI/pci.html)); the `PCI ECAM` range in VZ's `/proc/iomem` is that space, laid out by the Enhanced Configuration Access Mechanism (ECAM).

Under VZ the loop printed three devices. Vendor `0x106b` is Apple: the [**host bridge**](/build-your-own/vmm/glossary/#host-bridge), the device that connects the CPU to the PCI bus. Vendor `0x1af4` is the ID the virtio specification assigns to virtio devices (it is Red Hat's), and a modern virtio device's ID is `0x1040` plus its virtio type: `0x1043` is type 3, the console, and `0x1044` is type 4, the virtio-rng. Under our VMM the pattern matched no file, so `cat` complained about the literal `*`.

Put side by side:

| | our VMM | VZ's generic platform |
|---|---|---|
| console (`/proc/consoles`) | `ttyAMA0`, the PL011 | `hvc0`, a virtio-console |
| interrupt controller | GICD, the GIC's distributor, at `0x0800_0000` | GICD at `0x1000_0000` |
| RAM | from `0x4000_0000` | from `0x7000_0000` |
| RTC | PL031 at `0x0901_0000` | PL031 at `0x2005_0000` |
| other devices | none on a bus | a PCI host bridge, two virtio devices on PCI, and a PL061 (a general-purpose input/output controller) |
| firmware | none, the VMM enters the kernel | none: `efi: UEFI not found.` |
| CPU ID in the first log line | `0x610f0000` | `0x610f0000` |

The kernel copes because, as chapter 10 showed, it reads the machine from the device tree each VMM hands it. UEFI is the Unified Extensible Firmware Interface, the standard firmware the `uefi` primer describes; neither machine runs one here.

The last row is the interesting sameness. It is the [**main ID register**](/build-your-own/vmm/glossary/#midr) (MIDR), which names the CPU's maker and model.

A guest does not read the chip's own MIDR: HVF's header `hv_vcpu_types.h` lists `HV_SYS_REG_MIDR_EL1` among the registers a VMM may set, and `macvmm` never sets it, so `0x610f0000` is HVF's default. The Arm Architecture Reference Manual's description of `MIDR_EL1` gives the fields: bits [31:24] are the implementer, [23:20] the variant, [19:16] the architecture (`0xF`), [15:4] the part number and [3:0] the revision. So `0x610f0000` is implementer `0x61` (Apple) with part number 0, while Apple's real cores carry non-zero part numbers (Linux's `arch/arm64/include/asm/cputype.h` lists them).

Seeing HVF's default under VZ hints that VZ runs on HVF too; only a hint, since VZ could choose the same value. The next section has stronger evidence.

## Who runs the guest?

Under `macvmm`, the guest's vCPUs are threads of your own process (chapter 00). Look for vz-mac's guest the same way: start the `shell` boot again and, while it waits at its prompt, run this in a second terminal:

```sh
ps -axo pid,ppid,comm | grep -i -e virtualization -e vz-mac
```

Your process IDs will differ:

:::term source=captures/23-ps-xpc.txt

Two processes: vz-mac, and Apple's `com.apple.Virtualization.VirtualMachine`, whose parent is process 1, `launchd`, which starts macOS services. Other VM apps add one each; yours goes away when vz-mac stops.

It is an [**XPC service**](/build-your-own/vmm/glossary/#xpc-service): a helper program macOS starts on an app's behalf and talks to by messages ([XPC documentation](https://developer.apple.com/documentation/xpc)). vz-mac sent it a configuration; the service builds the machine, runs the vCPUs and emulates the devices. vz-mac never sees a VM exit, and VZ has no interface that would show one. What may that service do? Read its signature:

:::term source=captures/23-codesign-xpc.txt

About three dozen keys on our Mac (macOS 27.2.1); your list may differ. Among them is `com.apple.security.hypervisor`, the one `macvmm` holds: the service may use Hypervisor.framework, and with the CPU ID above that is good evidence it does. Many others are `com.apple.private.*` keys, including `com.apple.private.hypervisor`. These are **restricted** entitlements: macOS honours them only in code Apple has vouched for, never in an ad-hoc signature (the primer shows macOS killing such a program at launch).

In chapter 02's exception levels: guest kernels run at EL1; `macvmm`, vz-mac and Apple's service at EL0; the macOS kernel's hypervisor part at EL2. A guest reaches its devices by memory-mapped I/O (MMIO, chapter 07), loads and stores that trap to the VMM, and by virtio traffic in shared memory. Who parses what the guest sends:

```text
  guest kernel, EL1 (untrusted)     guest kernel, EL1 (untrusted)
     | sends MMIO and                  | sends virtio traffic
     | virtio traffic                  | over PCI; writes console bytes
 - - | - - - - - - trust boundary - - -| - - - - - - - - - - - - - - - - - -
     v                                 v
  macvmm, EL0, our process          VirtualMachine service, EL0      vz-mac, EL0,
  parses guest traffic:             Apple's process              <-- our process
    devices, exit loop              parses guest traffic:            sends a
  also holds:                         devices, exit loop             configuration
    device tree, loader             also holds:                      (XPC)
     |                                device tree, loader
     |                                 | console bytes ------------> filters them,
     |                                 |                             prints them
     | runs vCPUs                      | runs vCPUs
     v                                 v
  [ macOS kernel, EL2 part (chapter 02): one kernel under both columns     ]
```

*The machine moved out of your process. Notice who now parses the guest's device traffic, and the one stream that still reaches vz-mac.*

> **Security.** Under `macvmm`, a hostile guest attacks *our* device code, in a process with one entitlement; you can read, test and patch every line. Under VZ, it attacks *Apple's* device code, in a process with about three dozen entitlements, many restricted; Apple audits and patches it, and you can do neither. A trade, not a ranking.

## vz-mac's own surface: the console

vz-mac copies the guest's console bytes to your terminal, and some escape sequences make a terminal *answer*: `ESC [ 6 n` asks for the cursor position, and the terminal types its reply into its own input. vz-mac forwards what you type to the guest, so while it runs the reply goes to the guest; after it exits, your shell reads it (the `tty-termios` primer has worse examples). The VZ shell capture shows the guest's shell sending that query, which reached your terminal as the harmless text `^[[6n`. (`macvmm`'s default filter from chapter 09 drops queries silently, so its capture shows nothing there.) This filter, like chapter 09's in its strict mode, did that:

:::code anchor=vz_console_filter file=tools/vz-mac/Sources/vz-mac/Console.swift

Three parts carry the defence for single bytes:

- `case 0x00...0x1F`: every control byte but newline, carriage return, tab and backspace prints in [**caret notation**](/build-your-own/vmm/glossary/#caret-notation), `^` then the byte plus `0x40`. ESC (`0x1b`) becomes `^[`, so no escape sequence can start.
- `case 0x80...0x9F`: these are the 8-bit [**C1** controls](/build-your-own/vmm/glossary/#c1-control). Some terminals treat `0x9b` alone as the start of a sequence (CSI, the Control Sequence Introducer, the same as `ESC [`), so a raw one is printed as the text `\x9b`.
- The `expected != 0` branch: bytes `0xC2` to `0xF4` start a multi-byte UTF-8 character, continued by bytes `0x80` to `0xBF`. A character cut short becomes the replacement character, U+FFFD. A continuation byte with no lead takes the arms below: `0x80` to `0x9F` print as `\x..`, and `0xA0` to `0xBF` fall to `default`, U+FFFD.

A complete character is checked again, since a C1 control can be spelled in UTF-8: `C2 9B` is U+009B, CSI again.

:::code anchor=vz_console_utf8 file=tools/vz-mac/Sources/vz-mac/Console.swift

An overlong form (more bytes than the character needs), a value past U+10FFFF or a surrogate becomes U+FFFD; U+0080 to U+009F print as `\u{..}`; anything else passes unchanged.

:::stopping-point Good place to stop. Sitting B needs your Mac and about 1.5 hours (more if you install macOS).

## The high road to macOS

Why use VZ at all? For Linux, mostly you would not; your own VMM shows you everything. For a macOS guest, VZ is the only supported way. A macOS virtual machine starts from a [**restore image**](/build-your-own/vmm/glossary/#restore-image), Apple's installation file for macOS (ending in `.ipsw`), a `VZMacOSRestoreImage` to VZ; `VZMacOSInstaller` installs it onto a disk image. Ask VZ which restore image this Mac supports; it asks Apple's servers but downloads nothing:

```sh
tools/vz-mac/run.sh install --bundle .cache/macvmm/macos-vm --latest --dry-run
```

:::term source=captures/23-install-dry-run.txt

A macOS guest also has an identity. vz-mac keeps it in a [**bundle**](/build-your-own/vmm/glossary/#bundle), a directory holding the disk image, the auxiliary storage, the hardware model and the machine identifier, and builds the platform from the last three:

:::code anchor=vz_mac_identity file=tools/vz-mac/Sources/vz-mac/Bundle.swift

- The [**hardware model**](/build-your-own/vmm/glossary/#hardware-model): an opaque value naming the kind of virtual Mac the restore image was installed for.
- The [**machine identifier**](/build-your-own/vmm/glossary/#machine-identifier): an opaque value that gives this one VM its identity.
- The [**auxiliary storage**](/build-your-own/vmm/glossary/#auxiliary-storage): a file holding data the boot loader and the guest need, such as boot settings, laid out by the installer.

The SDK that ships with Xcode keeps VZ's headers in `$(xcrun --show-sdk-path)/System/Library/Frameworks/Virtualization.framework/Headers/`. There, `VZMacPlatformConfiguration.h` says that when a VM is loaded again, all three "must be restored to their original values". And `VZMacOSBootLoader` takes no kernel at all: it runs AVPBooter, Apple's boot ROM for virtual Macs, which loads and checks macOS's own boot files from the disk (chapter 24 runs it under your VMM). The devices complete the machine:

:::code anchor=vz_mac_devices file=tools/vz-mac/Sources/vz-mac/Bundle.swift

The disk is a standard virtio-blk device, virtio's disk (chapter 18). The display, keyboard and trackpad are `VZMac*` classes: Apple-specific. The display is [paravirtual](/build-your-own/vmm/glossary/#paravirtual-device) graphics, a device designed for VMs. Its host half is ParavirtualizedGraphics, a public macOS framework, but the protocol the guest speaks to it is not documented (chapter 24).

Installing is optional, and big. Ask Apple's server how big the restore image above is, without downloading it (`-I` sends a HEAD request, which returns only the headers):

```sh
curl -sSI https://updates.cdn-apple.com/2026FallFCS/c202a724-db7e-4d56-917b-110aa0226507/UniversalMac_27.2.1_26B131_Restore.ipsw | grep -i '^content-length'
```

Use the URL your dry run printed; it changes with each release.

:::term source=captures/23-ipsw-size.txt

About 26 GB. The disk image can grow to 64 GB, and the tool's README expects 20 to 40 minutes. If you have the space and time:

```sh
tools/vz-mac/run.sh install --bundle .cache/macvmm/macos-vm --latest
tools/vz-mac/run.sh boot --bundle .cache/macvmm/macos-vm --seconds 60
```

The tool is written to print `VZ guest state: running` and, after the virtual power button, `VZ guest state: stopped (requested)`. We did not install macOS, so there is no capture of a macOS boot here. `running` proves only that VZ started the machine: the reference's `docs/macos/status.md` records it even for a bundle with no macOS installed.

> **Aside.** Apple's software licence agreement for macOS addresses macOS in virtual machines; the reference's `docs/research/macos-guest.md` cites section 2B(iii). Read the version for your macOS at [apple.com/legal/sla](https://www.apple.com/legal/sla/); this course links it and does not interpret it. VZ enforces a limit of its own: its header `VZError.h` defines `VZErrorVirtualMachineLimitExceeded`, for when starting a VM "would exceed the system's limit on the number of simultaneously running virtual machines".

## Breaking it on purpose

**Deliberate breakage 1: run vz-mac without its entitlement.** Copy the signed tool to a scratch directory and re-sign the copy with the hardened runtime and no entitlement (`-i` keeps the identifier `vz-mac`; with no entitlements file, the copy carries none):

```sh
mkdir -p target/scratch
cp target/vz-mac/signed/vz-mac target/scratch/
codesign -s - -f -o runtime -i vz-mac target/scratch/vz-mac
target/scratch/vz-mac linux --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --cmdline "console=hvc0 macvmm.test=boot"
```

Chapter 01's `macvmm` got `HV_DENIED` from `hv_vm_create`. Predict: does VZ fail at the same moment, earlier, or later?

:::term source=captures/23-no-entitlement.txt

Earlier, and by name. vz-mac calls the configuration's `validate()` before starting the machine, and VZ refused there; vz-mac exits 1. What you saw: a clean, named refusal at run time. The misconception it exposes: "Apple's service holds all the rights, so my program needs none"; the framework checks *your* signature before it asks the service for anything. The tool that finds it: the error text and `codesign -d --entitlements -`.

## A weekend's work?

A common thought: "VZ is a wrapper around Hypervisor.framework; we could rewrite it in a weekend." Your runs say otherwise. Here are the device classes VZ offers, from the SDK headers:

:::term source=captures/23-vz-headers.txt

They fall into three groups:

- **Standard virtio**: the `VZVirtio*` classes, documented in a public specification.
- **Other public standards**: the Universal Serial Bus (USB) keyboard, pointing device and mass storage (`VZUSB*`), and the NVM Express (NVMe) disk controller; anyone can read their specifications.
- **Apple-specific**: the `VZMac*` graphics, keyboard and trackpad, and the Mac platform identity behind them.

"Apple implemented it" and "Apple defined it" are different questions; only the second leaves a low-level VMM with no specification. Under the configuration sits a whole machine, generated privately: a memory map, PCIe, a GIC, a device tree, and for macOS a boot ROM, an identity tied to Apple's installer and an undocumented graphics protocol. The misconception, corrected: VZ supplies a complete machine, firmware and devices, much of it undocumented.

> **Production note.** Low-level macOS guests do exist: QEMU's `vmapple` machine boots macOS on Hypervisor.framework by loading Apple's boot ROM from the host's Virtualization.framework and reimplementing Apple's devices from observation. Chapter 24 follows that road, as an investigation, not a promise.

## Your turn

1. Run `tools/vz-mac/test.sh` until it ends in `VZ TESTS OK`; the checkpoint below shows its five steps.
2. In your journal, write a comparison table of VZ and your VMM in your own words, six rows at least: who defines the devices, the console, the memory map, who runs the exit loop, the entitlement, what a hostile guest attacks.
3. Write your inventory in a file of your own, such as `learner/docs/macos/inventory.md`: one row per piece a low-level VMM must provide to boot macOS, with the VZ class or file that supplies it today, what you would build, and "documented" or "undocumented". Start from this chapter's three (the Mac platform identity, the boot ROM, the graphics device), add what the headers showed, then compare with the reference's `docs/macos/inventory.md`.

## Checkpoint

Back at the repository root, run:

:::checkpoint

The checkpoint runs vz-mac's acceptance test, `tools/vz-mac/test.sh`, then checks that every journal heading has an answer:

:::term source=captures/23-checkpoint.txt

The test's five steps, as the checkpoint ran them:

:::term source=captures/23-vz-acceptance.txt

Step 1 is 72 host-only tests (argument parsing, hostile inputs); step 2 checks vz-mac's signature and `macvmm`'s entitlements file; steps 3 and 5 repeat this chapter's runs (no entitlement, the Linux boot); step 4 validates the Linux configuration without booting (`--dry-run`).

What now works:

- you can run a VZ guest from the same kernel and initramfs as your VMM, and say why its console is `hvc0`;
- you can show, with `ps` and `codesign`, that a VZ guest runs in Apple's service, which holds restricted entitlements you cannot get;
- you have a comparison table and an inventory of what a macOS guest needs.

No Rust changed; chapter 24 starts from the reference at the end of chapter 23.

### What's next

Chapter 24 takes the low road: a VMM of ours loads Apple's boot ROM in place from the host's Virtualization.framework, runs it on a second board, and records every access to a device it lacks. Your inventory is its map; its honest answer may be "not yet".

### Open question

From your inventory, which three pieces will be hardest for a low-level VMM to provide, and is each one hard because it is complex or because it is undocumented?

## Spec hunt

- The SDK header `VZMacPlatformConfiguration.h`, the discussion above the class: what must be restored when a saved VM is loaded again, and what should differ between two VMs created from the same configuration?
- The virtio 1.2 specification, section 4.1.2 "PCI Device Discovery", with the device ID table in chapter 5: why is the console `0x1043`, and what PCI device ID would a virtio-blk disk have?
- Linux `Documentation/admin-guide/serial-console.rst`: what does the kernel use as its console when the command line names none? Our VZ run with no `console=` word was silent, not printed on `hvc0`; which console registered first (look for the `Console:` line in `course/captures/23-macvmm-shell.txt`, a log with no early console), and why did it win?
