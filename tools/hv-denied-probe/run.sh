#!/usr/bin/env bash
# Build, sign and run hv-denied-probe (PLAN M21; ADR-0008 decision 4, ADR-0009).
#
#   tools/hv-denied-probe/run.sh
#
# Prints `hv_vm_create with private ISA 3: HV_DENIED (0xfae94007)` on a normally configured Mac
# and exits 0 when it does. The probe is signed exactly like macvmm (scripts/sign.sh: only
# com.apple.security.hypervisor, hardened runtime), so the denial is about the private CPU mode,
# not a missing entitlement. HV_DENIED is the expected answer: the mode is reserved for Apple's
# own binaries (a com.apple.private.* entitlement). Do not change SIP or AMFI to "fix" it; macvmm
# never asks for that (ADR-0008 decision 4).
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../../scripts/lib/common.sh"

src="$REPO_ROOT/tools/hv-denied-probe/probe.c"
out="$(target_dir)/hv-denied-probe"
mkdir -p -- "$out"
bin="$out/hv-denied-probe"
xcrun clang -std=c11 -O1 -Wall -Wextra -Werror -framework Hypervisor -o "$bin" "$src"
"$REPO_ROOT/scripts/sign.sh" "$bin" >/dev/null
"$bin"
