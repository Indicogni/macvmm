# ADR-0004: Use HVF's in-kernel GICv3 (`hv_gic_create`)

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** `docs/research/hvf-api.md` §8–§10, `spikes/hvf-hello/RESULTS.md` findings 12–21 and 25, ADR-0003

## Context

On arm64, the guest needs an interrupt controller and timers. HVF offers two models.

**A. No GIC.** The VMM emulates the GICD/GICR MMIO and traps the `ICC_*` system registers. It
injects interrupts with `hv_vcpu_set_pending_interrupt`, and handles
`HV_EXIT_REASON_VTIMER_ACTIVATED`, WFI exits and timer unmasking. This is what QEMU's TCG-GIC
path with HVF does.

**B. In-kernel GICv3** (macOS 15+). On the M5 Pro the spike verified that:

- GICD, GICR and MSI-frame MMIO cause **no exits**, and neither do the ICC sysregs.
- The virtual timer is wired in the kernel to PPI 27. There are **zero** `VTIMER_ACTIVATED`
  exits, and WFI never exits.
- `hv_gic_set_spi` works from any thread and wakes a vCPU sitting in WFI.
- The QEMU-virt bases are accepted.
- `hv_gic_state_*` gives an opaque save blob (a binary plist, about 123 KiB).
- `hv_gic_reset` works.

## Decision

1. Use model B, and only model B. There is no user-space GIC.
2. Ordering, enforced by `hvf::VmBuilder::with_gic`:
   1. `hv_vm_create`
   2. GIC config with the distributor base `0x0800_0000` and the redistributor base `0x080A_0000`.
      Add an MSI frame at `0x0802_0000` with SPIs 80..143 **only when PCI is enabled** (future).
   3. `hv_gic_create`
   4. Then vCPUs.
3. vCPUs are created **sequentially, all at startup**. vCPU *i* writes
   `MPIDR_EL1 = (1<<31) | ((i/16)<<8) | (i%16)` immediately after `hv_vcpu_create`. Then it
   checks that `hv_gic_get_redistributor_base == 0x080A_0000 + i × redist_size`. This is needed
   because redistributor slots follow creation order, and the base query fails until MPIDR has
   been written. Both facts were verified.
4. Device interrupts go through `vmm::irq::IrqLine` (a frozen contract). The only production
   implementation is `GicSpi`, which calls `hv_gic_set_spi(intid, level)`. Devices never call
   HVF directly. All our device lines are **level**:
   - PL011: SPI 1, INTID 33
   - PL031: SPI 2, INTID 34
   - virtio-mmio slot *i*: SPI 16+i, INTID 48+i
5. Timers: the DTB `timer` node lists PPIs 13, 14, 11 and 10 (INTIDs 29, 30, 27 and 26), level.
   At startup the VMM asserts `hv_gic_get_intid(EL1_VIRTUAL_TIMER) == 27` and
   `(EL1_PHYSICAL_TIMER) == 30`, and fails loudly otherwise. Every vCPU gets the same
   `vtimer_offset`, captured once per boot before the first run, so the guest counter starts near 0.
6. `HV_EXIT_REASON_VTIMER_ACTIVATED` and EC `0x01` (WFI/WFE) are still handled **defensively**.
   We log a warning once, then:
   - VTIMER: unmask the vtimer.
   - WFI: advance the PC and yield.

   Neither should happen.
7. The interrupt controller state for snapshots is the `hv_gic_state` blob plus the per-vCPU ICC
   registers read with `hv_gic_get_icc_reg`. Restore must happen after the GIC and vCPUs are
   created and before the first run. The blob is tagged with the HVF framework version, and a
   restore under a different version is refused unless the user forces it.

## Consequences

- No GIC emulation code. The interrupt and timer chapters become *integration and investigation*
  chapters, not emulation chapters. **CURRICULUM.md ch12 objectives 2 and 3 describe model A and
  must be rewritten.** The lesson should show that zero timer or WFI exits occur and measure the
  latency (see risk below).
- IPIs (SGIs via `ICC_SGI1R_EL1`) are expected to be fully in-kernel. This is unverified until
  the SMP milestone (M16).
- There are no LPIs and no ITS (`GICD_TYPER.LPIS = 0`). MSIs for future PCI use the
  GICv2m-style frame and `hv_gic_send_msi`.
- `hv_vcpu_set_pending_interrupt` returns `HV_UNSUPPORTED`. We can only inject interrupts as SPIs,
  never as raw IRQ lines.
- **Risk: timer wake-up from in-kernel WFI is 2–4 ms late** (verified). Re-measure with Linux in
  M10 (`cyclictest`-style loop in the initramfs) and record the result in
  `docs/research/hvf-api.md`. There is no fallback to model A in v1.
- **Risk: Macs other than the M5 Pro are untested.** `macvmm doctor` must report whether
  `hv_gic_create` succeeds. If it fails on M1 or M2, the course needs a stated hardware floor.
- **Quirk:** a 32-bit read of GICR_TYPER returns 0. `guests/common/gic.rs` must use 64-bit reads,
  as Linux does.

## Alternatives considered

- **Model A (user-space GICv3 emulation).** Rejected: thousands of lines and an exit on every
  interrupt acknowledge, EOI and timer tick. It also duplicates what HVF already does well. It
  remains a possible capstone or fallback lesson if model B is missing on some hardware.
- **A GICv2 description.** Rejected: HVF exposes only the system-register interface (`ICC_SRE_EL1 = 0x7`).
