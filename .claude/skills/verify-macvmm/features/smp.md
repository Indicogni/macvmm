# SMP vCPUs

`--cpus N` (1..64) gives the guest N vCPUs, each on its own host thread; vCPU 0 boots and Linux
starts the others through PSCI CPU_ON. The user sees N CPUs inside the guest.

## Sub-features

- `smp-online` `nproc` in the guest equals N.
- `smp-stats` `--stats` prints one `vcpuN exits:` line per vCPU at exit.
- `smp-reject` `--cpus 65` is a usage error (exit 2) before any VM exists.

## How to get to it (user POV)

- `scripts/run-linux.sh --cpus N` (any `macvmm run` flag passes through).

## Driving it with vmm-drive

Preconditions:

- Baseline preconditions hold; no session `smp`.

- **Boot 4 vCPUs.** Run `$D start smp -- scripts/run-linux.sh --cpus 4 --stats` and `$D wait smp '/ # ' 120`.
- **Count CPUs.** Run `$D send smp 'echo cpus=$(nproc)'` and `$D wait smp 'cpus=4' 20`.
- **Per-vCPU stats.** Run `$D send smp 'poweroff -f'`, `$D wait-exit smp 30` (exit 0), then `grep -a 'exits:' .cache/verify/smp/transcript.log`. Shows lines for vcpu0..vcpu3.
- **Reject 65.** Run `$D start smp-bad -- scripts/run-linux.sh --cpus 65` and `$D wait-exit smp-bad 120`. Prints `exit code 2`.
- **Proof.** `$D stop smp; $D stop smp-bad`. Keep both evidence dirs.

## Gotchas

- `smp-online` and `smp-stats` proven 2026-11-22 (`cpus=4`; `macvmm: stats: vcpu0 exits: …` through `vcpu3`). `smp-reject` is not yet run through this skill.
- `echo cpus=$(nproc)` puts the command's echo on screen too. The echoed text contains `$(nproc)`, not `cpus=4`, so the wait still matches only the guest's answer.
- Above what `macvmm doctor` reports as `max vCPUs`, the run is refused.
