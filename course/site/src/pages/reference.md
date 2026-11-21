---
title: Reference card
tag: Reference
lead: The facts you look up while you work: the machine's memory map, macvmm's exit statuses, and where to find every term and primer.
---

## The memory map

macvmm's board copies the memory map of QEMU's `virt` machine, so stock firmware and stock kernels
run on it unmodified. One file, `crates/vmm/src/arch/layout.rs`, is the single source of truth:
the device tree, the bus and the stage-2 mappings are all built from it. These are its base
addresses ([chapter 05](/build-your-own/vmm/memory/address-space/) explains each one):

:::code anchor=layout_bases file=crates/vmm/src/arch/layout.rs

And every region except RAM, with its kind and its interrupt where it has one:

:::code anchor=layout_virt_table file=crates/vmm/src/arch/layout.rs

## Exit statuses

When macvmm stops, the reason becomes the process's exit status, so a script can tell a clean
power-off from a timeout or a crash ([chapter 03](/build-your-own/vmm/bare-machine/test-guests/)
meets the first ones):

:::code anchor=exit_codes file=crates/vmm/src/control.rs

## Words, primers and labs

- The [glossary](/build-your-own/vmm/glossary/) defines every course term in one line and links
  the chapter or primer that teaches it.
- The [primers](/build-your-own/vmm/primers/) teach what the course uses but does not build:
  calling conventions, file formats, page tables, firmware.
- The [labs](/build-your-own/vmm/labs/) run in any browser and are also embedded in their
  chapters.

## Primary sources

- Arm Architecture Reference Manual for A-profile (DDI 0487): exception levels, `ESR_EL2`, stage-2
  translation. The [reading-arm-specs](/build-your-own/vmm/primers/reading-arm-specs/) primer
  shows how to find your way in it.
- Virtual I/O Device (virtio) Version 1.2, OASIS: the transport and the split virtqueue.
- Devicetree Specification, release 0.4: the flattened device tree format.
- Linux `Documentation/arch/arm64/booting.rst`: what a kernel expects when it starts; see the
  [arm64 boot protocol](/build-your-own/vmm/primers/arm64-boot-protocol/) primer.
- Apple's Hypervisor.framework headers, in your SDK under
  `System/Library/Frameworks/Hypervisor.framework/Headers/`.
