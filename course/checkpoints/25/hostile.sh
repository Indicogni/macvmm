#!/usr/bin/env bash
# Checkpoint 25, the hostile-guest phases that need more than an exit code and markers.
#
#   course/checkpoints/25/hostile.sh PHASE MACVMM GUEST OUT
#
# PHASE is tty, flood, blk or toctou; MACVMM the signed binary under test ({macvmm}); GUEST the
# hostile guest's ELF ({guest}); OUT the run's private directory ({out}). Each phase runs the
# VMM once, copies its stdout and stderr through (so the harness matches its markers), prints
# what it checked on lines starting `check:`, and exits with the VMM's own exit code, or 1 if a
# check failed. Every file it writes is under OUT.
#
#   tty     none of the terminal attack strings reaches stdout (the guest sends 22 of them)
#   flood   4 MiB of guest output into `--serial file:F,max=1M` leaves exactly 1 MiB in F
#   blk     the read-only disk image is byte-identical after the virtio-blk attacks
#   toctou  as blk, and every guest MMIO access in the exit trace is inside the virtio window
set -euo pipefail
IFS=$'\n\t'
umask 077

fail() { printf 'check: FAILED: %s\n' "$*"; exit 1; }

(( $# == 4 )) || fail "usage: hostile.sh tty|flood|blk|toctou MACVMM GUEST OUT"
phase="$1"
macvmm="$2"
guest="$3"
out="$4"
[[ -x "$macvmm" && -f "$guest" && -d "$out" ]] || fail "bad arguments"

# Run the VMM; keep both streams in files (stdout is binary-checked below) and echo them.
vm() {
  rc=0
  "$macvmm" "$@" > "$out/stdout.bin" 2> "$out/stderr.txt" || rc=$?
  cat -- "$out/stdout.bin"
  cat -- "$out/stderr.txt" >&2
}

# A 64 MiB disk image with a non-zero pattern, and its hash.
make_disk() {
  /usr/bin/perl -e 'my $b = join(q(), map { chr($_ % 251) } 0 .. 65535); print $b x 1024' \
    > "$out/disk.img"
  before="$(shasum -a 256 < "$out/disk.img")"
}
check_disk() {
  after="$(shasum -a 256 < "$out/disk.img")"
  [[ "$before" == "$after" ]] || fail "the read-only disk image changed"
  echo "check: read-only disk image unchanged"
}

case "$phase" in
  tty)
    vm run --mem 64M --stats --kernel "$guest" --timeout 10
    # ESC ] (OSC), ESC P (DCS), ESC [ c and ESC [ 6 n (terminal queries), ESC _, ESC ^, ESC X
    # (APC, PM, SOS), the 8-bit CSI byte 0x9b, and ENQ: each would let the guest change, query
    # or spoof the host terminal. The count is over raw bytes, so a C1 byte in either its raw or
    # its UTF-8 form is seen.
    n="$(/usr/bin/perl -0777 -ne 'my $n = 0; for my $s ("\e]", "\eP", "\e[c", "\e[6n", "\e_", "\e^", "\eX", "\x9b", "\x05") { $n += () = /\Q$s\E/g } print $n' \
      < "$out/stdout.bin")"
    echo "check: forbidden sequences in stdout: $n"
    [[ "$n" == 0 ]] || fail "a terminal attack string reached stdout"
    ;;
  flood)
    vm run --mem 64M --serial "file:$out/f,max=1M" --kernel "$guest" --timeout 60
    size="$(stat -f %z "$out/f")"
    echo "check: serial file holds $size bytes"
    [[ "$size" == 1048576 ]] || fail "the capped serial file is not exactly 1 MiB"
    ;;
  blk)
    make_disk
    vm run --mem 64M --disk "$out/disk.img,ro" --kernel "$guest" --timeout 30
    check_disk
    ;;
  toctou)
    make_disk
    vm run --cpus 2 --mem 64M --rng --disk "$out/disk.img,ro" --stats \
      --trace "exits:$out/t.jsonl:mmio" --kernel "$guest" --timeout 60
    check_disk
    total="$(grep -c '"ipa":"0x' "$out/t.jsonl" || true)"
    inside="$(grep -cE '"ipa":"0xa00[0-3][0-9a-f]{3}"' "$out/t.jsonl" || true)"
    echo "check: MMIO exits traced: $total, outside the virtio window: $((total - inside))"
    (( total > 0 )) || fail "no MMIO traced"
    (( total == inside )) || fail "a guest MMIO access outside the virtio window"
    ;;
  *) fail "unknown phase $phase" ;;
esac
exit "$rc"
