# Doctor and dry-run

Two commands a user runs before booting anything: `macvmm doctor` checks the Mac, the signing
and Hypervisor.framework. `macvmm run … --dry-run` prints the boot plan, memory map and
device-tree summary without creating a VM.

## Sub-features

- `doctor-ok` `macvmm doctor` ends `DOCTOR OK`, exit 0.
- `doctor-probe` `scripts/doctor.sh` (a 20-line C probe) ends `DOCTOR OK`.
- `dry-plan` `--dry-run` prints `macvmm boot plan (dry run, no VM created)`, the RAM/kernel/initrd
  placement, and the QEMU-`virt` memory map. Exit 0.
- `dtb-out` `--dtb-out FILE` writes the generated device tree (0600).

## How to get to it (user POV)

- `cargo run -p macvmm -- doctor`, `scripts/doctor.sh`.
- `cargo run -p macvmm -- run --kernel … --initrd … [--cpus N] --dry-run`.

## Driving it with vmm-drive

Short-lived commands. Still run them through `$D` so the output and exit code are recorded.

Preconditions:

- Baseline preconditions hold.

- **Doctor.** Run `$D start doctor -- cargo run -q -p macvmm -- doctor` and `$D wait-exit doctor 120`. Exit 0. The transcript contains `codesign entitlements: com.apple.security.hypervisor only`, `in-kernel GICv3 (hv_gic_create): OK`, `DOCTOR OK`.
- **Dry run.** Run `$D start dry -- cargo run -q -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --cpus 4 --dry-run` and `$D wait-exit dry 120`. Exit 0. The transcript has `kernel  0x40200000`, `pl011        Mmio intid 33` at `0x09000000`, and `4 vCPU(s), irqchip InKernelGicV3`.
- **DTB out.** Add `--dtb-out .cache/verify/dry/virt.dtb` to the dry run. The file exists with mode `-rw-------`, and `dtc -I dtb -O dts .cache/verify/dry/virt.dtb | grep -c 'cpu@'` prints `4` (needs `dtc`).
- **Proof.** `$D stop doctor; $D stop dry`.

## Gotchas

- Doctor and dry-run output were observed 2026-11-22 outside `$D`. The `$D` recipe and `dtb-out` are not yet run through this skill.
- `--dry-run` needs no entitlement and creates no VM. It never proves a boot. Use it for layout or DTB changes only.
- The dry-run memory map must agree with `crates/vmm/src/arch/layout.rs`. A mismatch there is a real bug, not a doc issue.
