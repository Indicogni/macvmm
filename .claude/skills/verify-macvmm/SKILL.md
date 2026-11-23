---
name: verify-macvmm
description: Drive the real macvmm CLI on this Mac (boot Linux/U-Boot/FreeBSD guests on the serial console in an isolated tmux PTY, type into the guest, capture transcripts and exit codes) to prove a VMM change works the way a user sees it. Use after changing crates/hvf, crates/vmm, crates/macvmm, scripts/run-linux.sh or the initramfs, before claiming a guest boots or a device works.
---

# Verify macvmm by driving it

macvmm is a command-line VMM. A user runs `macvmm run …` (usually via `scripts/run-linux.sh` or
`cargo run -p macvmm -- …`) and talks to the guest over the PL011 serial console on the
terminal: boot log, a `/ # ` busybox prompt, `Ctrl-A x` to quit. Proof means: the real binary,
signed, booted a real guest, you typed what a user types, and you saw the guest's answer and
the VMM's exit code. `cargo test` alone is not that proof.

Secondary surfaces (not covered here): the course site (`course/site`, `npm run serve` in that
dir, Node 22+), the `scripts/learner` workflow, `tools/vz-mac`.

The helper is `.claude/skills/verify-macvmm/scripts/vmm-drive` (run from the repo root; below
it is written `D`). Set it once per shell: `D=.claude/skills/verify-macvmm/scripts/vmm-drive`.
`$D --help` lists every subcommand.

## Launch

Prerequisites (one-time, all already true on the dev Mac; check with Doctor):

- Apple Silicon, macOS ≥ 15, `tmux` on PATH (`brew install tmux`).
- `scripts/setup.sh` ends `setup: OK`.
- Guest artifacts in `.cache/macvmm/` (gitignored). Fetch what is missing:
  `scripts/fetch.sh linux` (Image-virt, initramfs-test.img), `scripts/fetch.sh uboot`
  (u-boot.bin), `scripts/fetch.sh freebsd` (~600 MB). Never hand-download.

There is no server. Each drive is one VM in its own tmux session on a private tmux server
(socket `macvmm-verify`, never the user's tmux). Building and signing happen inside the
launch command: `scripts/run-linux.sh` and `cargo run` both build and ad-hoc sign first
(`scripts/sign-and-run.sh` via `.cargo/config.toml`). An unsigned binary fails with
`HV_DENIED (0xfae94007)`.

```sh
D=.claude/skills/verify-macvmm/scripts/vmm-drive
$D start linux-shell -- scripts/run-linux.sh          # Linux, initramfs, busybox shell
$D wait  linux-shell '/ # ' 120                       # READY = the shell prompt
```

Ready means the guest prompt, not "process started": wait for `/ # ` (Linux shell),
`=> ` (U-Boot, after sending Enter at `Hit any key to stop autoboot`), or the case's
`macvmm-…:` marker line (initramfs test cases). First launch after a code change spends
time in `cargo build`; give `wait` 120 s.

Other launch shapes (any `macvmm run` flag passes through `run-linux.sh`):

```sh
$D start NAME -- scripts/run-linux.sh --cpus 4                       # SMP
$D start NAME -- scripts/run-linux.sh --test vda-write --disk F.img  # initramfs test case
$D start NAME -- cargo run -q -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M
```

Teardown: see Cleanup. Guest `poweroff -f` (Linux) / `poweroff` (U-Boot) is the user's clean
exit and should give exit code 0.

## Doctor

Run first, and whenever anything looks off:

```sh
cargo run -q -p macvmm -- doctor     # host: ends "DOCTOR OK", entitlement + hv_vm_create + GIC
$D doctor NAME                        # this session: alive?, running/exited N, macvmm pid,
                                      # binary built-at time, hypervisor entitlement, git HEAD
$D list                               # every session on the verification tmux server
```

Worth driving = `DOCTOR OK`, `$D doctor` says `alive: yes`, `state: running`, a macvmm pid
under the session, `signed: yes`, and the binary's build time is after your last edit. If the
build time is stale, the launch command did not rebuild: stop and relaunch.

## Drive

| Action | Command |
| --- | --- |
| type a line + Enter | `$D send NAME 'echo hi'` |
| press keys (no Enter) | `$D keys NAME C-a x` (quit), `C-a s` (stats), `C-a t` (exit ring) |
| wait for output | `$D wait NAME 'fixed text' [SECS]` (default 60; fails early if the VM exited) |
| wait for VM exit | `$D wait-exit NAME [SECS]` → prints `exit code N` |
| snapshot screen | `$D capture NAME` → writes `screen.txt` |

Stable handles: the prompts `/ # ` and `=> `, the `macvmm-<case>: …` lines printed by
`scripts/initramfs/init` (`macvmm.test=<case>` via `run-linux.sh --test <case>`), the VMM's own
stderr lines (`macvmm: user quit`, `macvmm: stats: …`), and exit codes from `macvmm run --help`:
0 guest powered off, 2 usage error, 3 unhandled MMIO (fatal policy), 4 reset with
`--on-reset exit`, 5 `--timeout`, 130 user quit (`Ctrl-A x`).

Wait for a string that only the step you just took can produce: `wait NAME aarch64` also
matches the boot log, `wait NAME 'Linux (none)'` matches only `uname -a`.

The feature map in `features/README.md` holds the per-feature recipes. Read it before driving.

## Evidence

Everything for session NAME lands in `.cache/verify/NAME/` (gitignored; override with
`VERIFY_OUT=dir`) and is kept after `stop`:

- `cmd.txt`: the exact command and cwd
- `transcript.log`: every byte the PTY printed (raw, includes `\r` and escapes; grep with `-a`)
- `events.log`: timestamped `start / send / keys / saw / exit / stop`, so the action sits next to the result
- `screen.txt`: the last `$D capture`
- `exit-code`: the launch command's exit status

Proof standards:

- Use the user's path: `scripts/run-linux.sh` or `cargo run -p macvmm -- run …`, typing into the
  serial console. Do not use the e2e test harness, `--debug-hvc` test guests or `--dry-run` as
  proof that a guest *boots*. `--dry-run` creates no VM and proves only the boot plan.
- Capture the action and the result: `events.log` + `transcript.log`, and a `capture` after the
  step that matters.
- Check side effects on the host, not only the console: disk bytes (`dd`/`cmp` on the image),
  files written by `--serial file:` / `--trace exits:FILE` / `--dtb-out`, and the exit code.
- Report the exit code you saw. Never claim a guest booted without its prompt or marker in
  `transcript.log`.

## Cleanup

```sh
$D stop NAME            # kills only session mv-NAME and the processes under it; keeps evidence
$D list                 # expect "no verification sessions"
pgrep -fl 'target/debug/macvmm run'   # read-only check; anything listed is NOT yours unless
                                      # $D doctor showed that pid. Never pkill by name.
```

Delete scratch disks you made (`rm .cache/verify/scratch/*.img`). Never delete or modify
`.cache/macvmm/*` (the pinned artifacts). Proof stays in `.cache/verify/NAME/`.

Run `stop` after every failed attempt too. A VM that is still running holds its `--disk` image
under `flock`, so the next launch with the same image is refused.

## Isolation

- VMs can run side by side: one session per NAME, so pick distinct NAMEs. Each `--disk` image
  is locked while in use, so give each VM its own copy (`cp -c` makes an APFS clone).
- Don't open the shared cached `rootfs.img` / FreeBSD image read-write from a verification run.
  Clone it into `.cache/verify/scratch/` first, as the e2e tests do.
- `--machine vmapple` allows at most two at a time per user (`~/.cache/macvmm/vmapple-slots`).
- Don't attach to or drive a macvmm you did not start (for example a user's
  interactive `run-linux.sh`).
