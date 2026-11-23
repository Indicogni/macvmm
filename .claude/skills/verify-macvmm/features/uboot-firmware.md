# U-Boot firmware

A user boots stock U-Boot (`qemu_arm64`) from macvmm's emulated flash with `--bios`, stops
autoboot, uses the `=> ` prompt, sees virtio disks, and powers off. FreeBSD boots through this
path (U-Boot EFI → loader), which is long and covered by `scripts/test-e2e.sh freebsd`.

## Sub-features

- `uboot-prompt` reaches `=> ` after Enter at `Hit any key to stop autoboot`.
- `uboot-version` `version` prints `U-Boot 2026.04 …`.
- `uboot-disk` with `--disk`, `virtio info` lists the disk as `Device 0`.
- `uboot-poweroff` `poweroff` → exit 0.

## How to get to it (user POV)

- `cargo run -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M` (README "More guests").

## Driving it with vmm-drive

Preconditions:

- `.cache/macvmm/u-boot.bin` exists (`scripts/fetch.sh uboot`); no session `uboot`.

- **Boot to prompt.** Run `$D start uboot -- cargo run -q -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M`, `$D wait uboot 'Hit any key to stop autoboot' 60`, `$D send uboot ''`, `$D wait uboot '=> ' 20`.
- **Version.** Run `$D send uboot 'version'` and `$D wait uboot 'U-Boot 20' 10`. Transcript shows `U-Boot 2026.04 (Apr 21 2026 …)`.
- **Disk.** Relaunch with `--disk .cache/verify/scratch/disk.img` appended, reach the prompt, `$D send uboot 'virtio info'`, `$D wait uboot 'Device 0' 10`.
- **Power off.** Run `$D send uboot 'poweroff'` and `$D wait-exit uboot 20`. Prints `exit code 0`.
- **Proof.** `$D capture uboot` before poweroff, then `$D stop uboot`. Keep `transcript.log` and `exit-code`.

## Gotchas

- Proven 2026-11-22: prompt + `version` + `Ctrl-A x` (exit 130). `poweroff` and `virtio info` are not yet run through this skill. They come from `crates/macvmm/tests/e2e_firmware.rs`.
- Autoboot counts down 2 s. If `wait` for the banner is late, U-Boot tries to boot and the prompt comes later or not at all. Send Enter immediately after the banner.
- `wait uboot '=> '` succeeds on the first prompt. After more commands, wait for each command's own output, not `=> `.
