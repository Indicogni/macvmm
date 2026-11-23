# macvmm verification map

This directory is the maintained source for verifying what a macvmm user sees. Read this index,
then use the matching feature file as the recipe. `D=.claude/skills/verify-macvmm/scripts/vmm-drive`
throughout; run everything from the repo root.

## Baseline preconditions

- `cargo run -q -p macvmm -- doctor` ends `DOCTOR OK`.
- `.cache/macvmm/` holds `Image-virt` and `initramfs-test.img` (`scripts/fetch.sh linux`);
  U-Boot recipes also need `u-boot.bin` (`scripts/fetch.sh uboot`).
- `$D list` shows no session with the NAME you are about to use.
- Scratch disks live in `.cache/verify/scratch/`, never in `.cache/macvmm/`.

## Driving conventions

- One VM per session NAME; `$D start NAME -- <launch>` then `$D wait` for the ready string.
- Wait on strings only the step just taken can print (`Linux (none)` not `aarch64`).
- Treat every command as literal; keep the quoting.
- End every recipe with the user's own exit (`poweroff -f`, U-Boot `poweroff`, or `Ctrl-A x`)
  and `$D wait-exit`, then `$D stop NAME`.

## Proof and skip reporting

- Proof = `.cache/verify/NAME/{cmd.txt,events.log,transcript.log,screen.txt,exit-code}` plus any
  host-side side effect the recipe names (disk bytes, files).
- Record the feature ID and the entry point (`run-linux.sh` vs `cargo run … run`) you used.
- A missing artifact or unmet precondition is a reported failure with the command that showed it,
  not a pass via another path.

## Feature entry contract

Each feature file has an H1, one paragraph, then exactly: `Sub-features`,
`How to get to it (user POV)`, `Driving it with vmm-drive` (starts with `Preconditions:`;
labeled bullets pairing action, exact command, observable result), `Gotchas`.

## Features

- [Linux shell boot](./linux-shell.md): direct kernel boot to `/ # `, typing into the guest, clean poweroff. **Proven with this skill 2026-11-22.**
- [Console controls](./console-controls.md): `Ctrl-A x / s / t`, exit codes, `--serial file:`.
- [virtio-blk disk](./virtio-blk-disk.md): `--disk` read/write/ro, checked on the host image.
- [U-Boot firmware](./uboot-firmware.md): `--bios` to the `=> ` prompt, disk enumeration, poweroff.
- [SMP vCPUs](./smp.md): `--cpus N` brings up N CPUs through PSCI.
- [Doctor and dry-run](./doctor-dry-run.md): host check and boot plan without a VM.
