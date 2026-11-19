# ADR-0005: virtio-mmio first, virtio-pci later

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** virtio 1.2 §4.1 (PCI) and §4.2 (MMIO), `docs/research/guest-boot.md` §1.4 and §3.3,
  `docs/research/macos-guest.md` W7/W8, ADR-0003

## Context

We need block, entropy and console devices, and network later, for Linux, FreeBSD, U-Boot and
EDK2. Virtio offers two transports on arm64:

- **MMIO** (§4.2): one register page per device, discovered from the DT, with one wired SPI per
  device and no MSI.
- **PCI** (§4.1): an ECAM host bridge, config-space emulation, BAR sizing and assignment,
  capability lists and MSI or MSI-X (on HVF, a GICv2m frame and `hv_gic_send_msi`). INTx needs
  swizzling.

## Decision

1. Implement **virtio-mmio version 2 (modern)** only. We offer `VIRTIO_F_VERSION_1` and refuse
   `FEATURES_OK` if the driver does not accept it. Legacy version 1 is not offered.
   - Linux accepts version 2, but `virtio_mmio` is a module in the Alpine kernel.
   - FreeBSD accepts versions 1 and 2.
   - U-Boot and EDK2 VirtioFdtDxe accept version 2.
2. Use 32 transport slots at `0x0a00_0000 + i·0x200` with SPI 16+i. Slots are assigned in a fixed
   order: `--disk` in CLI order, then `--rng`, then `--console`, then `--net`. Assignment is
   deterministic, so `/dev/vda` is always the first `--disk`.
3. **Devices are transport-agnostic.** `trait VirtioDevice` knows nothing about MMIO. The
   transport (`virtio/mmio.rs`) owns feature negotiation, the status state machine, queue
   configuration and the interrupt status. Later, `virtio/pci.rs` will implement the same
   contract and devices will not change. This is the seam to PCI.
4. PCI is deferred to a post-v1 milestone, together with the macOS track (S3) and EDK2 if EDK2
   prefers it. Its address windows are already reserved in `layout.rs`: ECAM `0x3f00_0000`,
   MMIO `0x1000_0000`, the v2m frame `0x0802_0000`, and INTx SPIs 3..6.

## Consequences

- The transport fits in about 400 lines and a host-testable state machine. The security-critical
  queue code (`virtio/queue.rs`, `virtio/chain.rs`) is shared by both transports.
- There is no hotplug and no MSI. One SPI per device is fine at our scale.
- The Linux test initramfs must `insmod virtio_mmio.ko` and the device modules (guest-boot.md §2.1).
- The macOS vmapple guest needs virtio-pci (vmapple virtio-blk). That work is planned (S3), not in v1.

## Alternatives considered

- **PCI first.** Rejected: it triples transport work before the first disk read, and none of
  our v1 guests need it.
- **Both at once.** Rejected: it splits focus. The trait seam makes adding PCI later cheap.
- **Legacy v1 too.** Rejected: more state, no guest of ours needs it, and the spec deprecates it.
