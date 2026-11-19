#!/usr/bin/env bash
# On-machine signing tests (threat model SIGN-1, SIGN-3; PLAN M0 "Security tests"). Needs a Mac
# where HVF works; `scripts/check.sh --hvf` runs it after the HVF probe passed.
#
#   scripts/test-signing.sh
#
# Cases:
# - sign_runtime_strips_dyld_env: a default `sign.sh` signature has the hardened-runtime flag,
#   `macvmm doctor` reports it and passes, and dyld ignores DYLD_PRINT_LIBRARIES (0 lines). The
#   same binary signed `--debug` prints a non-zero count, which proves the test can fail.
# - sign_no_entitlements_denied: without the entitlement, `doctor` exits 1 with HV_DENIED and
#   the hint naming scripts/sign-and-run.sh.
#
# Each case signs its own copy of target/debug/macvmm in a temporary directory under the target
# dir (sign.sh refuses anything else), so a concurrent `cargo run` cannot re-sign it under us.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

cd -- "$REPO_ROOT"
SIGN="$REPO_ROOT/scripts/sign.sh"
TARGET="$(target_dir)"
cargo build --locked --quiet -p macvmm
BUILT="$TARGET/debug/macvmm"
[[ -f "$BUILT" ]] || die "cargo build did not produce $BUILT"

W="$(mktemp -d "$TARGET/test-signing.XXXXXX")"
trap 'rm -rf -- "${W:?}"' EXIT

pass=0
fail=0
# verdict DESCRIPTION OK(0|1) DETAIL
verdict() {
  if [[ "$2" == 0 ]]; then
    pass=$((pass + 1)); printf 'ok - %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'not ok - %s\n%s\n' "$1" "$3" >&2
  fi
}

# copy_signed NAME [sign.sh flags...]: copy the built binary to $W/NAME/macvmm and sign it.
copy_signed() {
  local name="$1"
  shift
  mkdir -p -- "$W/$name"
  cp -- "$BUILT" "$W/$name/macvmm"
  "$SIGN" "$@" "$W/$name/macvmm" 2>/dev/null
  printf '%s\n' "$W/$name/macvmm"
}

# dyld_lines BINARY: how many output lines mention dyld when DYLD_PRINT_LIBRARIES is set.
dyld_lines() {
  local n
  n="$(DYLD_PRINT_LIBRARIES=1 "$1" doctor 2>&1 | grep -c dyld || true)"
  printf '%s\n' "${n:-0}"
}

# --- sign_runtime_strips_dyld_env ------------------------------------------------------------
bin="$(copy_signed runtime)"
flags="$(codesign -dv -- "$bin" 2>&1 | grep -E '^CodeDirectory ' || true)"
r=0; [[ "$flags" =~ flags=0x[0-9a-f]+\([^\)]*runtime ]] || r=1
verdict "sign_runtime_strips_dyld_env: codesign flags include runtime" "$r" "$flags"

rc=0
out="$("$bin" doctor 2>&1)" || rc=$?
r=0; [[ "$rc" == 0 && "$out" == *"hardened runtime: yes"* && "$out" == *"DOCTOR OK"* ]] || r=1
verdict "sign_runtime_strips_dyld_env: doctor reports hardened runtime: yes and DOCTOR OK" "$r" \
  "rc=$rc
$out"

n="$(dyld_lines "$bin")"
r=0; [[ "$n" == 0 ]] || r=1
verdict "sign_runtime_strips_dyld_env: DYLD_PRINT_LIBRARIES is ignored (0 dyld lines)" "$r" \
  "got $n dyld lines"

dbg="$(copy_signed debug --debug)"
rc=0
out="$("$dbg" doctor 2>&1)" || rc=$?
r=0; [[ "$rc" == 0 && "$out" == *"hardened runtime: no (debug signing)"* ]] || r=1
verdict "sign_runtime_strips_dyld_env: a --debug copy reports no hardened runtime, as a warning" "$r" \
  "rc=$rc
$out"

n_dbg="$(dyld_lines "$dbg")"
r=0; [[ "$n_dbg" -gt 0 ]] || r=1
verdict "sign_runtime_strips_dyld_env: a --debug copy honours DYLD_PRINT_LIBRARIES ($n_dbg lines), so the test can fail" \
  "$r" "got $n_dbg dyld lines"

# --- sign_no_entitlements_denied -------------------------------------------------------------
noent="$(copy_signed noent --no-entitlements)"
rc=0
errout="$("$noent" doctor 2>&1 >/dev/null)" || rc=$?
r=0
[[ "$rc" == 1 && "$errout" == *"HV_DENIED (0xfae94007)"* && "$errout" == *"scripts/sign-and-run.sh"* ]] || r=1
verdict "sign_no_entitlements_denied: doctor exits 1 with HV_DENIED and the sign-and-run.sh hint" "$r" \
  "rc=$rc
$errout"

if (( fail > 0 )); then
  printf 'TEST-SIGNING FAILED: %s of %s cases\n' "$fail" "$((pass + fail))" >&2
  exit 1
fi
printf 'TEST-SIGNING OK: %s cases\n' "$pass"
