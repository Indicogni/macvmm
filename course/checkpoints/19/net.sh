#!/usr/bin/env bash
# Checkpoint 19, the virtio-net runs that need a private socket directory or two VMs at once.
#
#   course/checkpoints/19/net.sh PHASE MACVMM REPO [GUEST]
#
# PHASE is two-vms, bind-file or probe; MACVMM the signed binary under test ({macvmm}); REPO the
# repository ({repo}, for the Linux artifacts in .cache/macvmm/); GUEST a bare-metal guest's ELF
# ({guest}). Socket paths must fit in 103 bytes, which a checkpoint's {out} under a long
# checkout path may not, so every phase works in a fresh `mktemp -d` directory (mode 0700, as
# the --net directory check requires) and removes it at the end. Each phase copies the VMM's
# stdout and stderr through (VM A's and VM B's with an `A: ` or `B: ` prefix), prints what it
# checked on lines starting `check:`, and exits with the VMM's own exit code, or 1 if a check
# failed.
#
#   two-vms    VM B (net-b) listens; VM A (net-a) pings it 5 times and sends it 32 MiB; both
#              exit 0 and print the same sha256
#   bind-file  a regular file at LOCAL is refused with exit code 2 and left unchanged
#   probe      the bare-metal virtio probe finds device 1 (network) in slot 0
set -euo pipefail
IFS=$'\n\t'
umask 077

fail() { printf 'check: FAILED: %s\n' "$*"; exit 1; }

(( $# >= 3 )) || fail "usage: net.sh two-vms|bind-file|probe MACVMM REPO [GUEST]"
phase="$1"
macvmm="$2"
repo="$3"
guest="${4:-}"
[[ -x "$macvmm" && -d "$repo" ]] || fail "bad arguments"

t="$(mktemp -d)"
pb=""
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  if [[ -n "$pb" ]]; then kill "$pb" 2>/dev/null || true; fi
  rm -rf -- "$t"
}
trap cleanup EXIT

# One Linux VM with a NIC: linux_vm CASE NETSPEC. Output goes to files named after CASE.
linux_vm() {
  "$macvmm" run --kernel "$repo/.cache/macvmm/Image-virt" \
    --initrd "$repo/.cache/macvmm/initramfs-test.img" --mem 512M --on-reset exit \
    --timeout 120 --stats --net "$2" \
    --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1 quiet macvmm.test=$1" \
    < /dev/null > "$t/$1.out" 2> "$t/$1.err"
}

# The guest's serial lines end in CR LF; the hash is the text after sha256= on MARKER's line.
sha_after() { tr -d '\r' < "$1" | sed -n "s/.*$2 sha256=//p" | head -n 1; }

case "$phase" in
  two-vms)
    [[ -f "$repo/.cache/macvmm/Image-virt" && -f "$repo/.cache/macvmm/initramfs-test.img" ]] \
      || fail "the Linux artifacts are missing: run scripts/fetch.sh linux"
    rb=0
    linux_vm net-b "unixgram:$t/b.sock,peer=$t/a.sock,mac=02:6d:76:00:00:02" &
    pb=$!
    # Wait (at most 60 s) for B to listen before A starts.
    for _ in $(seq 600); do
      grep -q 'macvmm-net: listening' "$t/net-b.out" 2>/dev/null && break
      kill -0 "$pb" 2>/dev/null || break
      sleep 0.1
    done
    ra=0
    if grep -q 'macvmm-net: listening' "$t/net-b.out" 2>/dev/null; then
      linux_vm net-a "unixgram:$t/a.sock,peer=$t/b.sock,mac=02:6d:76:00:00:01" || ra=$?
    else
      echo "check: VM B never printed listening"
      ra=1
    fi
    wait "$pb" || rb=$?
    pb=""
    sed 's/^/A: /' "$t/net-a.out" 2>/dev/null || true
    sed 's/^/A: /' "$t/net-a.err" >&2 2>/dev/null || true
    sed 's/^/B: /' "$t/net-b.out"
    sed 's/^/B: /' "$t/net-b.err" >&2
    echo "check: exit codes A=$ra B=$rb"
    sa="$(sha_after "$t/net-a.out" 'macvmm-net: sent 33554432 bytes' 2>/dev/null || true)"
    sb="$(sha_after "$t/net-b.out" 'macvmm-net: received 33554432 bytes')"
    [[ ${#sa} == 64 && "$sa" == "$sb" ]] || fail "the two sha256 values differ or are missing"
    echo "check: A sent and B received the same sha256"
    (( ra == 0 && rb == 0 )) || exit 1
    exit 0
    ;;
  bind-file)
    [[ -f "$guest" ]] || fail "bad guest"
    printf precious > "$t/x"
    rc=0
    "$macvmm" run --net "unixgram:$t/x,peer=$t/y" --kernel "$guest" --timeout 10 < /dev/null || rc=$?
    [[ "$(cat -- "$t/x")" == precious ]] || fail "the file at LOCAL was changed"
    echo "check: the file at LOCAL is unchanged"
    exit "$rc"
    ;;
  probe)
    [[ -f "$guest" ]] || fail "bad guest"
    rc=0
    "$macvmm" run --mem 64M --net "unixgram:$t/p.sock,peer=$t/q.sock" --kernel "$guest" \
      --timeout 10 < /dev/null || rc=$?
    exit "$rc"
    ;;
  *)
    fail "unknown phase $phase"
    ;;
esac
