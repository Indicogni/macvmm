---
title: How macvmm works
tag: Visual tour
lead: Five pictures of the VMM you build in this course, each with a few plain paragraphs. You need no virtualization or ARM background to read them.
---

A **virtual machine** is a computer made of software, running on your Mac. The program that
builds it and keeps it running is a **virtual machine monitor**, or **VMM**. macvmm is the VMM
this course builds, in Rust. The operating system that runs inside the virtual machine is the
**guest**. Your Mac and macOS are the **host**. [Chapter 00](/build-your-own/vmm/start/orientation/)
builds this picture slowly. This page shows it in five diagrams.

## The whole picture

:::diagram src=docs/diagrams/overview.svg alt="The four layers: the guest, the macvmm process, Hypervisor.framework with the macOS kernel, and the CPU."

Read it from the top. The guest is Linux, the U-Boot firmware that then boots FreeBSD, or one of
the small test programs in the repository. The guest believes it runs on QEMU's `virt` board, a
standard ARM board that stock kernels and firmware already support. macvmm copies that board's
layout, so they run unchanged.

Below the guest is macvmm, one ordinary macOS process built from three Rust crates. The command
line, `crates/macvmm`, reads your flags and sets up your terminal for the guest's serial console.
The VMM library, `crates/vmm`, does the real work: it runs one thread per virtual CPU, or
**vCPU**, and holds the device models, virtio, the loaders and the device tree. The **FFI**
bindings, `crates/hvf`, are the hand-written calls from Rust into Apple's C API. After it opens
its input files, the process locks itself in a macOS **sandbox**. From then on, a guest that takes
over macvmm still cannot open a new file or reach the network.

Below macvmm is **Hypervisor.framework**, or HVF, Apple's API for running virtual machines. It and
the macOS kernel map guest memory, run the vCPUs, and provide an interrupt controller, the
in-kernel **GIC**, and a timer. At the bottom is the Apple Silicon CPU. The guest's instructions run
on it directly, at full speed, with nothing translating them.
[Chapter 01](/build-your-own/vmm/start/ffi/) shows where each layer sits.

## The heart of a VMM: run, exit, emulate, resume

:::diagram src=docs/diagrams/exit-loop.svg alt="The exit loop: run the guest, take an exit, decode why, emulate, advance the PC, run again."

If the guest runs directly on the CPU, how does macvmm ever get a say? The CPU stops the guest
whenever it does something that only the VMM may handle. That stop is a **VM exit**:
`hv_vcpu_run`, the call that runs the guest, returns to macvmm. Each vCPU thread spends its life in
this loop.

Most exits are device accesses. The guest reads or writes an address where a device should be,
finds no memory there, and the CPU reports a **data abort**. The next diagram shows why there is no
memory. The other common exit is a **hypercall**: the guest runs the `hvc` instruction to ask the
VMM for a service on purpose, such as starting another CPU.

macvmm then reads the **syndrome** register, `ESR_EL2`. It says why the guest stopped: for a data
abort, which register, how many bytes, and whether it was a read or a write. A device model does
what the real hardware would do, or the **PSCI** code answers the hypercall. PSCI is ARM's standard
interface for turning CPUs on and off. macvmm moves the program counter past the instruction and
runs the guest again. [Chapter 07](/build-your-own/vmm/cpu/exit-loop/) builds this loop, and
[chapter 08](/build-your-own/vmm/cpu/traps-psci/) adds hypercalls and PSCI.

The numbers in the box are a real count. On 2026-11-22 on an Apple M5 Pro,
`scripts/run-linux.sh --cpus 4 --stats` booted Linux to a shell, then powered it off. The four
vCPUs took 35,271 exits, and the total was the same in each of 4 runs. Only the split between the
vCPUs changed. Linux printed 12,883 bytes to the serial console in that run, and each byte costs at
least one device register write, so at least one exit. There were no timer exits and no WFI exits. WFI, "wait
for interrupt", is the instruction an idle CPU runs. The in-kernel GIC handles both inside
Hypervisor.framework.

## The board the guest sees

:::diagram src=docs/diagrams/memory-map.svg alt="The guest-physical memory map: flash, the GIC, three trapped devices and RAM, with their base addresses."

A guest finds its devices by address. Every byte it reads or writes has a guest-physical
address, or **IPA**, and the board's memory map says what lives at each one. macvmm's map copies QEMU's
`virt` board. One file, `crates/vmm/src/arch/layout.rs`, is the single source of truth, and the
[reference card](/build-your-own/vmm/reference/) shows it.

What matters is what macvmm leaves out. RAM is mapped: macvmm asks Hypervisor.framework to enter
guest RAM in the CPU's second stage of address translation, **stage 2**, which turns each IPA into
an address in macvmm's own memory. The guest then reads and writes RAM with no exit at all. The UART, the clock and the virtio slots are deliberately
not mapped. An access there has nowhere to go, so the CPU stops the guest and macvmm's device model
answers. A device in macvmm is code that runs when an exit arrives.
[Chapter 05](/build-your-own/vmm/memory/address-space/) explains these holes.

Two regions behave differently. The GIC's addresses belong to Hypervisor.framework's in-kernel GIC,
which answers those accesses itself, again with no exit
([chapter 12](/build-your-own/vmm/interrupts/gicv3/)). Flash holds firmware, and macvmm maps it
only when you boot firmware with `--bios` ([chapter 21](/build-your-own/vmm/firmware/firmware/)).

## From `macvmm run` to a shell prompt

:::diagram src=docs/diagrams/boot-flow.svg alt="The boot sequence, from opening the input files to a shell prompt, with power-off and reboot."

macvmm first opens every file it needs, once: the kernel, the **initramfs** and any disk images.
The initramfs is a small archive that Linux unpacks as its first filesystem. Then macvmm enters its
sandbox, and from that point it cannot open a file by path at all.

Next it builds the machine. It creates the virtual machine and its GIC, maps RAM, adds the devices,
and writes a **device tree**, a small binary description of the board that tells Linux what lives
where. It copies the device tree, the kernel and the initramfs into guest RAM. Then it points vCPU 0
at the kernel's first instruction, with register `x0` holding the device tree's address. The
[arm64 boot protocol](/build-your-own/vmm/primers/arm64-boot-protocol/) primer lists the rest of
what Linux expects at that moment.
[Chapter 10](/build-your-own/vmm/devices/device-tree/) writes the device tree, and
[chapter 13](/build-your-own/vmm/linux/loaders/) loads the kernel.

Linux does the rest. It asks PSCI to start the other vCPUs with `CPU_ON`, finds its devices in the
device tree, and starts a shell. When you type `poweroff -f`, Linux calls PSCI `SYSTEM_OFF` and
macvmm exits with code 0. A reboot calls `SYSTEM_RESET` instead, and macvmm builds a fresh machine
from the bytes it already read. [Chapter 14](/build-your-own/vmm/linux/linux-boot/) boots Linux to
that shell.

## How a disk write travels

:::diagram src=docs/diagrams/virtio-request.svg alt="One virtio-blk write, from the Linux driver through the vCPU thread and the worker thread to the disk image, and the interrupt back."

An emulated disk controller would cost an exit for every register it touches. **Virtio** is a
family of devices designed for virtual machines instead. The driver and the device share
**virtqueues**: rings of descriptors in guest RAM, each one pointing at a buffer. Most of the work
then happens in shared memory, with no exits.
[Chapter 15](/build-your-own/vmm/virtio/virtio-mmio/) builds the transport.

To write to the disk, the Linux driver fills in descriptors for the request, then writes the
`QueueNotify` register. That one write is the only exit needed to start the request. The vCPU
thread wakes the disk's worker
thread and returns to the guest at once, so the guest keeps running while the disk works.

The worker treats everything in the ring as hostile. It walks the **descriptor chain**, checks
every address against RAM, and stops a chain that loops back on itself. Then it calls `pwrite` on
the disk image file, records the result in the **used ring**, and raises the device's interrupt
through the in-kernel GIC. The driver sees the used ring and completes the request.
[Chapter 16](/build-your-own/vmm/virtio/virtqueues/) builds the hardened virtqueue, and
[chapter 18](/build-your-own/vmm/virtio/virtio-blk/) the disk.

## Build it yourself

Everything inside the macvmm process on this page is code you write in the course.
[Chapter 00](/build-your-own/vmm/start/orientation/) begins from zero. The
[glossary](/build-your-own/vmm/glossary/) defines every bold term in one line.
