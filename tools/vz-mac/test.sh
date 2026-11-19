#!/usr/bin/env bash
# The M20 acceptance for vz-mac (PLAN M20; the shell-only e2e suite `vz`, PLAN §0.3).
#
#   tools/vz-mac/test.sh           every step
#   tools/vz-mac/test.sh --host    steps 1-4 only: no fetched artifact needed, no guest booted
#
# 1. swift test: host-only unit and hostile-input tests (no VM, no entitlement).
# 2. vz_entitlements_exact: build and sign through run.sh; `codesign -d --entitlements -` on
#    vz-mac lists exactly com.apple.security.virtualization, and macvmm's entitlements.plist
#    still lists exactly com.apple.security.hypervisor (threat model SIGN-1, §10.2 M20).
# 3. vz_breaks_without_entitlement: the same binary signed with no entitlement is refused by
#    Virtualization.framework at configuration time (course ch23 "Breaks").
# 4. vz_linux_dry_run: the entitled binary's Linux configuration validates. The kernel is a
#    synthetic 64-byte arm64 Image header in a temporary directory; nothing is booted.
# 5. vz_linux_boot: `vz-mac linux --kernel .cache/macvmm/Image-virt --initrd
#    .cache/macvmm/initramfs-test.img --cmdline "console=hvc0 macvmm.test=boot"` prints
#    `macvmm-initramfs: ready` on stdout, `VZ guest state: stopped (guest)` on stderr (a line
#    only vz-mac prints, AS10), and exits 0. A missing artifact fails the test
#    (`missing artifact X: run scripts/fetch.sh linux`) unless MACVMM_E2E_ALLOW_SKIP=1.
# Never run here: `vz-mac install` and `vz-mac boot` (multi-GB IPSW; manual, PLAN M20).
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck disable=SC2034  # read by scripts/lib/common.sh (sourced via run.sh)
SCRIPT_NAME="vz-mac/test"
# shellcheck source=tools/vz-mac/run.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/run.sh"

host_only=0
for arg in "$@"; do
  case "$arg" in
    --host) host_only=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

T="$(mktemp -d "${TMPDIR:-/tmp}/vz-mac-test.XXXXXX")"
cleanup() { rm -rf -- "${T:?}"; }
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

step "1. swift test (host-only)"
(cd -- "$HERE" && swift test --scratch-path "$SCRATCH" >"$T/swift-test.log" 2>&1) || {
  grep -Ev '^objc\[[0-9]+\]: Class ' -- "$T/swift-test.log" | tail -n 60 >&2
  die "swift test failed"
}
grep -E '^.{0,4}Test run with [0-9]+ tests? .*passed' -- "$T/swift-test.log" | sed -e 's/^[^T]*//'
pass "swift_test"

step "2. vz_entitlements_exact"
bin="$(build_and_sign)"
printf 'binary: %s\n' "$bin"
codesign -d --entitlements - --xml -- "$bin" 2>/dev/null | plist_keys | sed -e 's/^/entitlement: /'
codesign -dv -- "$bin" 2>&1 | grep -E '^CodeDirectory' || true
check_signature "$bin"
[[ "$(plist_keys < "$REPO_ROOT/entitlements.plist")" == "com.apple.security.hypervisor" ]] \
  || die "macvmm's entitlements.plist changed: it must hold exactly com.apple.security.hypervisor"
pass "vz_entitlements_exact"

# A synthetic kernel header (never booted): 64 bytes with ARM\x64 at offset 0x38.
head -c 56 /dev/zero >"$T/Image"
printf 'ARM\x64' >>"$T/Image"
head -c 4 /dev/zero >>"$T/Image"
head -c 512 /dev/zero >"$T/initrd"

step "3. vz_breaks_without_entitlement"
noent="$T/vz-mac-noent"
cp -- "$bin" "$noent"
codesign -s - -f -o runtime -i vz-mac -- "$noent" 2>/dev/null || die "codesign failed"
[[ -z "$(codesign -d --entitlements - --xml -- "$noent" 2>/dev/null | plist_keys)" ]] \
  || die "the no-entitlement copy still has entitlements"
rc=0
"$noent" linux --kernel "$T/Image" --initrd "$T/initrd" --cmdline "console=hvc0" --dry-run \
  </dev/null >"$T/noent.out" 2>"$T/noent.err" || rc=$?
cat -- "$T/noent.err"
(( rc == 1 )) || die "expected exit 1 without the entitlement, got $rc"
grep -q 'com.apple.security.virtualization' -- "$T/noent.err" \
  || die "expected VZ's missing-entitlement message"
pass "vz_breaks_without_entitlement (exit $rc)"

step "4. vz_linux_dry_run"
rc=0
"$bin" linux --kernel "$T/Image" --initrd "$T/initrd" --cmdline "console=hvc0" --dry-run \
  </dev/null >"$T/dry.out" 2>"$T/dry.err" || rc=$?
cat -- "$T/dry.err"
(( rc == 0 )) || die "dry run failed with exit $rc"
grep -q '^vz-mac: configuration valid: linux' -- "$T/dry.err" || die "no 'configuration valid' line"
pass "vz_linux_dry_run"

if (( host_only )); then
  printf '\nVZ HOST TESTS OK (the boot test needs scripts/fetch.sh linux; run without --host)\n'
  exit 0
fi

step "5. vz_linux_boot"
cache="$(cache_dir)"
kernel="$cache/Image-virt"
initrd="$cache/initramfs-test.img"
for f in "$kernel" "$initrd"; do
  if [[ ! -f "$f" ]]; then
    if [[ "${MACVMM_E2E_ALLOW_SKIP:-0}" == "1" ]]; then
      printf 'SKIP vz_linux_boot: missing artifact %s (MACVMM_E2E_ALLOW_SKIP=1)\n' "$(basename -- "$f")"
      printf '\nVZ TESTS OK (boot skipped)\n'
      exit 0
    fi
    die "missing artifact $(basename -- "$f"): run scripts/fetch.sh linux"
  fi
done
rc=0
start="$(date +%s)"
MACVMM_CACHE="$cache" "$bin" linux --kernel "$kernel" --initrd "$initrd" \
  --cmdline "console=hvc0 macvmm.test=boot" --seconds 60 \
  </dev/null >"$T/boot.out" 2>"$T/boot.err" || rc=$?
wall=$(( $(date +%s) - start ))
grep -E 'macvmm-initramfs: ' -- "$T/boot.out" || true
cat -- "$T/boot.err"
grep -q 'macvmm-initramfs: ready' -- "$T/boot.out" || {
  tail -n 40 -- "$T/boot.out" >&2
  die "no 'macvmm-initramfs: ready' on stdout"
}
grep -qx 'VZ guest state: stopped (guest)' -- "$T/boot.err" || die "the guest did not power itself off"
(( rc == 0 )) || die "expected exit 0, got $rc"
pass "vz_linux_boot (exit $rc, ${wall}s)"

printf '\nVZ TESTS OK\n'
