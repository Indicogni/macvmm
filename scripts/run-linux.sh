#!/usr/bin/env bash
# Boot the pinned Alpine linux-virt kernel and the macvmm test initramfs to a busybox shell on
# the PL011, interactively (PLAN M10; course ch14).
#
#   scripts/run-linux.sh [--test CASE] [MACVMM-RUN-OPTIONS...]
#
# --test CASE   the `macvmm.test=` case of scripts/initramfs/init (default: shell)
# Every other option is passed to `macvmm run` after the defaults (`--mem 512M`), so a later
# `--mem 1G` wins and `--trace exits:FILE` or `--stats` adds (`--cmdline` is set here).
# Ctrl-A x quits, Ctrl-A t dumps the exit rings, Ctrl-A s prints stats; `poweroff -f` in the
# guest exits 0.
# Needs `scripts/fetch.sh linux` first (Image-virt, initramfs-test.img; nothing is fetched here).
# A relative MACVMM_CACHE is taken relative to the repo root, as the e2e tests take it.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

test_case=shell
pass=()
while (( $# > 0 )); do
  case "$1" in
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "$0"; exit 0 ;;
    --test)
      (( $# >= 2 )) || die "--test needs a case name"
      test_case="$2"
      shift 2 ;;
    *) pass+=("$1"); shift ;;
  esac
done
# The case becomes one word of the kernel command line: keep it to the init's own alphabet.
[[ "$test_case" =~ ^[A-Za-z0-9_-]+$ ]] || die "bad test case: $test_case"

# Resolve the cache from the repo root, then make it absolute, so the files checked below are
# the files macvmm opens (a relative path would otherwise be checked against the caller's cwd
# and opened against the repo root). Two steps: a failing cache_dir must stop the script, not
# hand `cd` an empty argument.
cd -- "$REPO_ROOT"
cache="$(cache_dir)"
cache="$(cd -- "$cache" && pwd -P)"
kernel="$cache/Image-virt"
initrd="$cache/initramfs-test.img"
for f in "$kernel" "$initrd"; do
  [[ -f "$f" && ! -L "$f" ]] || die "missing artifact $(basename -- "$f"): run scripts/fetch.sh linux"
done

cargo build --locked --quiet -p macvmm
bin="$(target_dir)/debug/macvmm"
"$REPO_ROOT/scripts/sign.sh" "$bin" >/dev/null

# ANCHOR: run_linux_exec
exec "$bin" run \
  --kernel "$kernel" \
  --initrd "$initrd" \
  --mem 512M \
  --cmdline "console=ttyAMA0 earlycon=pl011,0x09000000 macvmm.test=$test_case" \
  ${pass[@]+"${pass[@]}"}
# ANCHOR_END: run_linux_exec
