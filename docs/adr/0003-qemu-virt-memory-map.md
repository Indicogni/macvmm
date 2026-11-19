# ADR-0003: The machine mirrors QEMU `virt`'s memory map

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** `CLAUDE.md`, `docs/research/guest-boot.md` §1.4 and §3, `docs/research/hvf-api.md` §5 and §9,
  `docs/architecture.md` §5 (the authoritative table)

## Context

Stock firmware hard-codes QEMU `virt` addresses:

- U-Boot `qemu_arm64` runs from flash at `0x0` and reads the DTB at `0x4000_0000`.
- EDK2 ArmVirtQemu reads `PcdDeviceTreeInitialBaseAddress = 0x4000_0000`.
- Stock kernels' earlycon examples and distro docs assume PL011 at `0x0900_0000`.

If our map differs, we have to patch firmware. We also need every *mapped* region to be
16 KiB-aligned, because HVF's default stage-2 granule is 16 KiB (verified).

## Decision

1. The `virt` profile uses QEMU `virt`'s low-memory addresses for every device we implement. The
   map is defined once, in `crates/vmm/src/arch/layout.rs`. The DTB generator, the bus builder,
   the loaders and the docs all read it from there. No other file may contain a device address
   literal. `scripts/check-unsafe` also greps for `0x0900_0000`-style literals outside
   `layout.rs` and tests.
2. The authoritative table is in `docs/architecture.md` §5 and `docs/PLAN.md`. A summary:
   - flash at `0x0` (2 × 64 MiB banks)
   - GICD at `0x0800_0000`
   - GICv2m frame `0x0802_0000`, reserved for PCI
   - GICR at `0x080A_0000`, `ncpus × 0x2_0000`
   - PL011 at `0x0900_0000` (SPI 1, INTID 33)
   - PL031 at `0x0901_0000` (SPI 2, INTID 34)
   - 32 virtio-mmio slots at `0x0a00_0000 + i·0x200` (SPI 16+i, INTID 48+i)
   - PCIe windows reserved at QEMU's addresses
   - RAM at `0x4000_0000`
3. **Deliberate differences from QEMU:**
   - Virtio-mmio interrupts are **level** (`<0 16+i 4>`), not edge. The device holds the line
     while `InterruptStatus != 0` (architecture §11.2).
   - Only populated virtio slots appear in the DTB. All 32 slots answer on the bus; empty ones
     read `DeviceID = 0`.
   - No fw_cfg device, no `flash@0` node until CFI emulation exists (ADR-0007), no ITS, no PMU
     node (the guest reads `PMUVer = 0`).
   - The GICR `reg` covers only `ncpus × redistributor_size`. Everything else in QEMU's 0xF6_0000
     window is RAZ/WI.
   - RAM ends at or below `0x40_0000_0000` (255 GiB max). Above that QEMU places high regions we
     do not use. The IPA size is the smallest value ≥ 36 bits that covers the layout, capped at
     `hv_vm_config_get_max_ipa_size` (40 on M5 Pro).
4. `layout.rs` exposes a `MachineProfile` enum, `Virt` (default) and `VmApple` (feature
   `experimental-vmapple`). The vmapple map conflicts with ours (its ECAM sits at `0x4000_0000`),
   so it is a second profile and not an edit to `virt`.

## Consequences

- U-Boot and EDK2 binaries from distro packages work unmodified (ADR-0007).
- Linux `earlycon=pl011,0x09000000` works, and so do QEMU-era tutorials.
- Every PL011, PL031 and virtio slot sits inside HVF's nominal 32 MiB redistributor window. This
  is harmless, verified: the kernel only claims the frames of vCPUs that exist.
- Changing an address is a one-line edit plus a regenerated golden DTB. Layout unit tests catch
  overlaps, misalignment and IPA overflow.

## Alternatives considered

- **Our own compact map.** Rejected: it breaks stock firmware.
- **The vmapple map for everything.** Rejected: Linux and FreeBSD tooling targets `virt`.
- **Edge-triggered virtio (QEMU parity).** Rejected for now. Level semantics cannot lose an
  interrupt when the device and the ACK race. Revisit only if a guest misbehaves; it is a
  one-constant change.
