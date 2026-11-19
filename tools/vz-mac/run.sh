#!/usr/bin/env bash
# Build, sign and run vz-mac (PLAN M20, ADR-0008 decision 2).
#
#   tools/vz-mac/run.sh <vz-mac arguments...>      e.g. tools/vz-mac/run.sh linux --kernel ...
#   tools/vz-mac/run.sh --print-path               build and sign only; print the binary path
#
# 1. `swift build -c release`, with SwiftPM's output under <repo>/target/vz-mac (gitignored, and
#    outside the scanned source trees). Build chatter goes to stderr so stdout stays the guest's.
# 2. Copy the binary to target/vz-mac/signed/vz-mac and ad-hoc sign the copy with exactly
#    vz-mac.entitlements and the hardened runtime (`-o runtime`), the same contract as macvmm's
#    scripts/sign.sh (threat model SIGN-1, SIGN-3) with the one VZ entitlement instead of the
#    hypervisor one. Both entitlements are public and self-grantable by ad-hoc signing; no
#    developer certificate, no private entitlement and no system-security change is involved
#    (AS9).
# 3. Read the signature back: the entitlement set must be exactly
#    com.apple.security.virtualization = true, and the runtime flag must be set.
# 4. exec the signed binary with MACVMM_CACHE defaulting to <repo>/.cache/macvmm (SC-3 checked).
set -euo pipefail
IFS=$'\n\t'
umask 077
SCRIPT_NAME="${SCRIPT_NAME:-vz-mac/run}"
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/lib/common.sh"

VZ_KEY="com.apple.security.virtualization"
HERE="$REPO_ROOT/tools/vz-mac"
ENTITLEMENTS="$HERE/vz-mac.entitlements"
SCRATCH="$(target_dir)/vz-mac"
SIGNED_DIR="$SCRATCH/signed"

# `<key>` names in a plist on stdin, one per line, XML comments removed (as scripts/sign.sh).
plist_keys() {
  sed -e 's/<!--.*-->//g' | grep -o '<key>[^<]*</key>' | sed -e 's/<key>//' -e 's/<\/key>//' || true
}

# ANCHOR: vz_sign
# vz_entitlements_exact: the signed entitlement set is exactly the VZ key, set to true.
check_signature() {
  local bin="$1" xml keys info
  xml="$(codesign -d --entitlements - --xml -- "$bin" 2>/dev/null || true)"
  keys="$(printf '%s' "$xml" | plist_keys)"
  [[ "$keys" == "$VZ_KEY" ]] \
    || die "$bin: signed entitlements are '${keys:-none}', expected exactly $VZ_KEY (SIGN-1)"
  [[ "$xml" == *"<key>$VZ_KEY</key><true/>"* ]] || die "$bin: $VZ_KEY is not <true/>"
  # Captured first: `codesign | grep -q` under pipefail fails when grep exits early (SIGPIPE).
  info="$(codesign -dv -- "$bin" 2>&1 || true)"
  printf '%s\n' "$info" | grep -Eq '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' \
    || die "$bin: hardened runtime flag missing (SIGN-3)"
}

build_and_sign() {
  [[ "$(plist_keys < "$ENTITLEMENTS")" == "$VZ_KEY" ]] \
    || die "$ENTITLEMENTS must hold exactly $VZ_KEY (SIGN-1)"
  (cd -- "$HERE" && swift build -c release --scratch-path "$SCRATCH" >&2) || die "swift build failed"
  local built="$SCRATCH/release/vz-mac"
  [[ -f "$built" && ! -L "$built" ]] || die "build produced no binary at $built"
  mkdir -p -- "$SIGNED_DIR"
  local bin="$SIGNED_DIR/vz-mac"
  cp -f -- "$built" "$bin"
  codesign -s - -f -o runtime -i vz-mac --entitlements "$ENTITLEMENTS" -- "$bin" 2>/dev/null \
    || die "codesign failed for $bin"
  check_signature "$bin"
  printf '%s\n' "$bin"
}
# ANCHOR_END: vz_sign

# test.sh sources this file for the functions above; only run when executed directly.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

bin="$(build_and_sign)"
if [[ "${1:-}" == "--print-path" ]]; then
  printf '%s\n' "$bin"
  exit 0
fi
MACVMM_CACHE="$(cache_dir)"
export MACVMM_CACHE
exec "$bin" "$@"
