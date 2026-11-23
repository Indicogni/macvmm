# virtio-blk disk

A user attaches a raw image with `--disk FILE[,ro]`; Linux sees `/dev/vda`, and writes from the
guest land in the host file at the right offset. `,ro` makes the guest's writes fail.

## Sub-features

- `blk-write` guest writes 1 MiB of `macvmm\n` at offset 8 MiB of `/dev/vda`.
- `blk-read` guest reads the disk (`--test vda`).
- `blk-ro` `--disk F,ro`: the guest's write is refused (`--test vda-ro`), host image unchanged.
- `blk-lock` a second macvmm on the same image is refused while the first runs.

## How to get to it (user POV)

- `scripts/run-linux.sh --test vda-write --disk FILE` (also `vda`, `vda-ro`): initramfs cases
  in `scripts/initramfs/init` that load `virtio_blk` and act on `/dev/vda`.
- `macvmm run … --disk FILE` with any guest.

## Driving it with vmm-drive

Preconditions:

- Baseline preconditions hold; no session `disk-write`.
- A fresh zeroed scratch image: `mkdir -p .cache/verify/scratch && rm -f .cache/verify/scratch/disk.img && mkfile -n 64m .cache/verify/scratch/disk.img`.

- **Write from the guest.** Run `$D start disk-write -- scripts/run-linux.sh --test vda-write --disk .cache/verify/scratch/disk.img` and `$D wait disk-write 'macvmm-vda: write done' 90`.
- **Clean exit.** Run `$D wait-exit disk-write 30`. Prints `exit code 0` (the case powers off itself).
- **Host side effect.** Run `dd if=.cache/verify/scratch/disk.img bs=1048576 skip=8 count=1 2>/dev/null | head -c 21`. Prints `macvmm` three times. Then `dd if=.cache/verify/scratch/disk.img bs=1048576 count=1 2>/dev/null | tr -d '\0' | wc -c` prints `0` (nothing else was written).
- **Read-only.** Run `cp .cache/verify/scratch/disk.img .cache/verify/scratch/ro.img; shasum .cache/verify/scratch/ro.img`, then `$D start disk-ro -- scripts/run-linux.sh --test vda-ro --disk .cache/verify/scratch/ro.img,ro` and `$D wait disk-ro 'macvmm-vda-ro: write rejected' 90`. `shasum` afterwards matches the earlier one.
- **Lock.** While `disk-write`-style VM is still at a prompt (`scripts/run-linux.sh --disk IMG`), start a second with the same IMG. The second exits non-zero naming the lock.
- **Proof.** Save the `dd` output next to the evidence (`… > .cache/verify/disk-write/host-bytes.txt`), then `$D stop` each session and delete the scratch images.

## Gotchas

- `blk-write` was proven 2026-11-22 with exactly the commands above. `blk-ro` and `blk-lock` are not yet run through this skill.
- The `vda-*` cases power off by themselves. Wait for the marker, then `wait-exit`. Do not send `poweroff`.
- The plain `shell` case does not load `virtio_blk`, so `/dev/vda` is absent at `/ # ` until you run `modprobe virtio_blk`.
- Never point `--disk` at `.cache/macvmm/rootfs.img` or the FreeBSD image read-write. Clone first (`cp -c`).
- A `FAILED` marker (`macvmm-vda: FAILED write`) is a failure even when the exit code is 0.
