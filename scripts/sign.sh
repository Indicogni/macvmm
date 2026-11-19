#!/usr/bin/env bash
# Ad-hoc sign a binary under the cargo target dir with macvmm's signing contract.
#
#   scripts/sign.sh [--debug] [--no-entitlements] BINARY...
#
# Default (SIGN-1, SIGN-3): `codesign -s - -o runtime --entitlements entitlements.plist -f`.
#   The hardened runtime is on by default because without it dyld honours DYLD_* variables in
#   the entitled process (threat model §13, [V]: 705 vs 0 DYLD_PRINT_LIBRARIES lines), so
#   anything that can set the launch environment could inject code.
# --debug            omit the hardened runtime so lldb can attach (prints a warning) and mark
#                    the identifier `<name>.debug-signing`, which `macvmm doctor` recognizes.
# --no-entitlements  ad-hoc sign without any entitlement: for binaries that do not need HVF
#                    (SIGN-4) and for the negative test (HV_DENIED).
#
# Afterwards it reads the signature back and verifies the entitlement set is exactly what was
# asked for. Paths outside $CARGO_TARGET_DIR (default target/) are refused.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

HV_KEY="com.apple.security.hypervisor"
ENTITLEMENTS="$REPO_ROOT/entitlements.plist"

# `<key>` names in a plist text on stdin, one per line, XML comments removed.
plist_keys() {
  sed -e 's/<!--.*-->//g' | grep -o '<key>[^<]*</key>' | sed -e 's/<key>//' -e 's/<\/key>//' || true
}

debug=0
with_ents=1
bins=()
for arg in "$@"; do
  case "$arg" in
    --debug) debug=1 ;;
    --no-entitlements) with_ents=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    -*) die "unknown option $arg" ;;
    *) bins+=("$arg") ;;
  esac
done
(( ${#bins[@]} > 0 )) || die "usage: scripts/sign.sh [--debug] [--no-entitlements] BINARY..."

# SIGN-1: the plist we are about to apply holds exactly the hypervisor key.
if (( with_ents )); then
  [[ -f "$ENTITLEMENTS" ]] || die "missing $ENTITLEMENTS"
  keys="$(plist_keys < "$ENTITLEMENTS")"
  [[ "$keys" == "$HV_KEY" ]] || die "entitlements.plist must hold exactly $HV_KEY, found: ${keys:-nothing} (SIGN-1)"
fi
if (( debug )); then
  warn "debug signing: hardened runtime OFF, DYLD_* variables will be honoured (SIGN-3)"
fi

for bin in "${bins[@]}"; do
  path="$(physical_file "$bin")"
  inside_target_dir "$path" || die "refusing to sign $path: not under $(target_dir) (SIGN-4)"
  base="$(basename -- "$path")"
  args=(-s - -f)
  if (( debug )); then
    args+=(-i "$base.debug-signing")
  else
    args+=(-o runtime -i "$base")
  fi
  if (( with_ents )); then
    args+=(--entitlements "$ENTITLEMENTS")
  fi
  codesign "${args[@]}" -- "$path" 2>/dev/null || die "codesign failed for $path"

  # Read the signature back: the entitlement set must be exactly what we asked for.
  got="$(codesign -d --entitlements - --xml -- "$path" 2>/dev/null | plist_keys)"
  if (( with_ents )); then
    [[ "$got" == "$HV_KEY" ]] || die "$path: signed entitlements are '${got:-none}', expected $HV_KEY only"
  else
    [[ -z "$got" ]] || die "$path: expected no entitlements, found: $got"
  fi
  if (( ! debug )); then
    codesign -dv -- "$path" 2>&1 | grep -E '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime' >/dev/null \
      || die "$path: hardened runtime flag missing after signing (SIGN-3)"
  fi
done
