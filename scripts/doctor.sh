#!/usr/bin/env bash
# Toolchain-independent hypervisor check (course ch00): build a 20-line C probe with clang,
# sign it exactly like macvmm (scripts/sign.sh), run it, and verify the signature.
#
#   scripts/doctor.sh
#
# Prints the probe's lines, then `doctor: codesign entitlements: ...` and `DOCTOR OK`.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

out_dir="$(target_dir)/doctor"
mkdir -p -- "$out_dir"
probe="$out_dir/hvprobe"

clang -Wall -Wextra -Werror -O1 -mmacosx-version-min=15.0 -framework Hypervisor \
  -o "$probe" -- "$REPO_ROOT/scripts/doctor/hvprobe.c" \
  || die "clang failed: run scripts/setup.sh (needs the Xcode command line tools)"
"$REPO_ROOT/scripts/sign.sh" "$probe"

if ! "$probe"; then
  printf 'hint: 0xfae94007 is HV_DENIED (entitlement missing, see scripts/sign.sh);\n' >&2
  printf '      0xfae9400f HV_UNSUPPORTED or 0xfae94006 HV_NO_DEVICE means no usable hypervisor\n' >&2
  printf '      (for example inside a VM without nested virtualization)\n' >&2
  die "the hypervisor probe failed"
fi

keys="$(codesign -d --entitlements - --xml -- "$probe" 2>/dev/null \
  | grep -o '<key>[^<]*</key>' | sed -e 's/<key>//' -e 's/<\/key>//' || true)"
[[ "$keys" == "com.apple.security.hypervisor" ]] \
  || die "probe entitlements are '${keys:-none}', expected com.apple.security.hypervisor only"
printf 'doctor: codesign entitlements: com.apple.security.hypervisor only\n'
printf 'DOCTOR OK\n'
