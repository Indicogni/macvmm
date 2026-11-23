# Console controls

The serial console on stdio is the user's whole interface: guest output is filtered for terminal
safety, `Ctrl-A` escapes let the user quit or inspect the VMM, and the console can instead go
to a file.

## Sub-features

- `console-quit` `Ctrl-A x` stops the VM: `macvmm: user quit`, exit 130.
- `console-stats` `Ctrl-A s` prints `macvmm: stats: serial_…` counters without stopping.
- `console-trace` `Ctrl-A t` dumps the per-vCPU exit ring.
- `console-file` `--serial file:FILE` writes guest output to FILE (mode 0600).
- `console-timeout` `--timeout SECS` stops the guest with exit 5.

## How to get to it (user POV)

- Keys typed at any running `macvmm run` with `--serial stdio` (the default).
- Flags on `macvmm run` / `scripts/run-linux.sh`.

## Driving it with vmm-drive

Preconditions:

- Baseline preconditions hold; no session `console`.

- **Boot.** Run `$D start console -- scripts/run-linux.sh` and `$D wait console '/ # ' 120`.
- **Stats.** Run `$D keys console C-a s` and `$D wait console 'macvmm: stats: serial_' 10`. The VM keeps running (`$D doctor console` says `state: running`).
- **Exit ring.** Run `$D keys console C-a t` then `$D capture console`. `screen.txt` shows the ring dump.
- **Quit.** Run `$D keys console C-a x` and `$D wait-exit console 20`. Prints `exit code 130`; the transcript has `macvmm: user quit`.
- **Serial to file.** Run `$D start console-file -- scripts/run-linux.sh --test boot --serial file:.cache/verify/console-file/serial.txt` and `$D wait-exit console-file 120`. Exit code 0. `.cache/verify/console-file/serial.txt` exists with mode `-rw-------` and contains the kernel boot log.
- **Timeout.** Run `$D start console-to -- scripts/run-linux.sh --timeout 5` and `$D wait-exit console-to 120`. Prints `exit code 5`.
- **Proof.** `$D stop` each session, then keep the `events.log`, `transcript.log` and `exit-code` of each.

## Gotchas

- Proven on U-Boot 2026-11-22: `C-a s` printed `macvmm: stats: serial_input_dropped=0 …`, `C-a x` gave exit 130. The Linux-shell variants and `console-file`/`console-timeout` have not yet been run through this skill.
- `--timeout` counts from VM start, and the first launch after a change also spends time in `cargo build`. Expect exit 5 even if the prompt never appears.
- `--serial file:` refuses an existing symlink, and the directory must exist (`$D start` creates `.cache/verify/NAME/` before the command runs).
- With `--serial file:` the console is not on stdio, so `Ctrl-A` keys go nowhere.
