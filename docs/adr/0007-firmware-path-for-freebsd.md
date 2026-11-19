# ADR-0007: FreeBSD boots through U-Boot `qemu_arm64` (EDK2 second)

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** `docs/research/guest-boot.md` §3, ADR-0003, CURRICULUM ch21–22, `docs/PLAN.md` M18–M19

## Context

FreeBSD/arm64 is the SHOULD target. Its arm64 kernel expects to be started by `loader.efi`,
which supplies the module metadata (`modulep`), the environment and the EFI memory map. Unlike
Linux, the FreeBSD kernel has no documented direct-boot protocol. So we need a UEFI environment.
There are two stock options, U-Boot's EFI implementation and EDK2 ArmVirtQemu. Both are built
for QEMU `virt` (ADR-0003).

## Decision

1. **Firmware path v1: U-Boot `qemu_arm64` 2026.04.**
   - Binary: Alpine `u-boot-qemu-2026.04-r1.apk`, member `usr/share/u-boot/qemu_arm64/u-boot.bin`.
   - Pins: the apk sha256 `b87f1d7a…` and the extracted file sha256 `e0155e52…`, both in
     `scripts/fetch-manifest.txt`.
   - `cargo xtask extract-apk` extracts the file with a hostile-input-safe tar reader.
2. **Boot flow:**
   1. `--bios u-boot.bin` copies the file into a 64 MiB host buffer.
   2. That buffer is mapped at IPA `0x0` as **READ|EXEC**, with no WRITE. Instruction fetch
      cannot be emulated, so the firmware must be in mapped memory.
   3. The vCPU starts at PC `0x0`, EL1h, DAIF masked, with x0 = DTB address.
   4. Our generated DTB is written at `0x4000_0000`. It is the **only** hardware description
      U-Boot receives, so it must be complete.
   5. U-Boot's EFI bootmeth starts `EFI/BOOT/BOOTAA64.EFI` from the virtio-blk ESP, then
      FreeBSD `loader.efi`, then the kernel.
3. **Flash writes.** A guest store to the flash region exits as a data abort. In v1 the
   `devices/flash.rs` stub treats it as write-ignored, with a rate-limited log. The DTB has **no
   `flash@0` node**, so U-Boot does not probe CFI and runs with its default environment.
   Whether U-Boot boots cleanly this way is unverified; M18 checks it first. If it does not, M18
   implements the minimal CFI-01 read-array/query/status state machine with romd
   (unmap-on-command, remap-on-read-array).
4. **Guest image:** `FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz`, sha256 `36028829…` from the
   official `CHECKSUM.SHA256`. It is decompressed on the host with `xz -dc` into
   `./.cache/macvmm/` (about 6 GiB) and attached as `--disk` (virtio-blk over virtio-mmio).
   `xz` is **not** part of stock macOS (verified: only Homebrew's `/opt/homebrew/bin/xz` exists on
   the dev machine, and stock `bsdtar` cannot read a raw `.xz` stream), so `setup.sh` reports it
   as an optional tool for M19. The output is piped through `cargo xtask write-sparse`, which seeks
   over all-zero 64 KiB blocks so that APFS stores the image sparsely.
   FreeBSD accepts virtio-mmio v2.
5. **EDK2 (ArmVirtQemu, Alpine `aavmf`) is the second firmware path.** It needs a **working CFI-01
   write and erase path** for its variable store in flash bank 1 at `0x0400_0000`. It may also
   need fw_cfg. It is planned after U-Boot works and is not part of the v1 gate.
6. The guest runs at EL1. Both FreeBSD and Linux then use the virtual timer (PPI 11 / INTID 27),
   which HVF handles in the kernel (ADR-0004).

## Consequences

- One firmware path also gives us generic EFI booting: Debian cloud images and other distros'
  GRUB-on-ESP. The "U-Boot to prompt" checkpoint (ch21) is independent of FreeBSD.
- The VMM must answer every PSCI and SMCCC query U-Boot makes: `PSCI_VERSION`, `PSCI_FEATURES`,
  `SMCCC_VERSION` and `SYSTEM_RESET`/`SYSTEM_OFF`. An unknown function returns
  `NOT_SUPPORTED`, with a warning.
- Firmware may emit ISV=0 data aborts (pair or writeback accesses to MMIO). The ISV=0 decoder
  (M17) is a prerequisite of M18.
- Alpine repo `.apk` files churn. The manifest supports mirror URLs, and the lead must decide
  where a pinned mirror copy lives.

## Alternatives considered

- **Direct kernel boot of FreeBSD.** Rejected: we would have to reimplement `loader.efi`'s
  metadata handoff, which is undocumented and moves between releases.
- **EDK2 first.** Rejected: it hard-requires CFI write emulation, and possibly fw_cfg, before the
  first prompt. U-Boot does not.
- **Writing our own minimal UEFI.** Rejected: far out of scope.
