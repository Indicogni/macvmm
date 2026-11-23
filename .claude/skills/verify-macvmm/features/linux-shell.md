# Linux shell boot

A user boots the pinned Alpine `linux-virt` kernel with the macvmm test initramfs directly (no
firmware), gets a busybox `/ # ` prompt on the PL011 serial console, runs commands, and powers
off, which ends macvmm with exit code 0 and leaves the terminal working.

## Sub-features

- `shell-boot` boots Image + initramfs + generated DTB to `/ # `.
- `shell-io` serial input reaches the guest and output comes back.
- `shell-poweroff` guest `poweroff -f` → PSCI SYSTEM_OFF → macvmm exit 0.
- `shell-cargo` the same boot via `cargo run -p macvmm -- run --kernel … --initrd …`.

## How to get to it (user POV)

- `scripts/run-linux.sh` (README quickstart).
- `cargo run -p macvmm -- run --kernel .cache/macvmm/Image-virt --initrd .cache/macvmm/initramfs-test.img --mem 512M`.
  Without `macvmm.test=shell` on the cmdline the init runs no case and does not drop to a shell
  (see Gotchas).

## Driving it with vmm-drive

Preconditions:

- Baseline preconditions hold; no session `linux-shell`.

- **Boot.** Run `$D start linux-shell -- scripts/run-linux.sh` then `$D wait linux-shell '/ # ' 120`. Prints `saw: / # `.
- **Check the session.** Run `$D doctor linux-shell`. Shows `state: running`, a `macvmm pids` entry, `signed: yes`.
- **Type into the guest.** Run `$D send linux-shell 'echo macvmm-shell: $((6*7))'` and `$D wait linux-shell 'macvmm-shell: 42' 20`. The guest's shell did the arithmetic.
- **Identify the kernel.** Run `$D send linux-shell 'uname -a'` and `$D wait linux-shell 'Linux (none)' 20`. The transcript has `Linux (none) 6.18.60-0-virt … aarch64 Linux`.
- **Snapshot.** Run `$D capture linux-shell`. `screen.txt` shows both commands and outputs.
- **Power off.** Run `$D send linux-shell 'poweroff -f'` and `$D wait-exit linux-shell 30`. Prints `exit code 0`.
- **Proof.** Run `$D stop linux-shell` and `cat .cache/verify/linux-shell/events.log`. The log shows start → saw `/ # ` → send → saw `macvmm-shell: 42` → … → `exit: 0` → stop. All five evidence files remain.

## Gotchas

- `wait … aarch64` matches the boot log before you type anything. Wait for `Linux (none)`.
- `cargo run … run --kernel … --initrd …` with the default cmdline gets no `macvmm.test=shell`.
  For a shell via `cargo run`, add `--cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=shell"`.
- `poweroff` without `-f` goes through busybox init and may not reach SYSTEM_OFF. Use `poweroff -f`.
- `run-linux.sh` rebuilds quietly; the prompt can take tens of seconds after a code change.
