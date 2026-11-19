#!/usr/bin/env bash
# The cargo runner (.cargo/config.toml): sign the binary cargo built, then exec it.
#
#   scripts/sign-and-run.sh BINARY [ARGS...]
#
# Why a runner: Hypervisor.framework refuses `hv_vm_create` (HV_DENIED) unless the process is
# signed with com.apple.security.hypervisor, and cargo produces a fresh, linker-signed binary on
# every build. Signing in the runner makes `cargo run` and `cargo test` just work.
#
# It signs and execs a PRIVATE copy, $(target_dir)/run-bin/<pid>/<name>, never the file cargo
# wrote: another `cargo build` in the same tree can relink that path between our codesign and
# our exec, and the relinked file carries only the linker's signature (no entitlement), which
# made concurrent runs fail with HV_DENIED. The copy keeps this script's pid across `exec`, so
# the next invocation removes the directories of pids that are gone.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

(( $# >= 1 )) || die "usage: scripts/sign-and-run.sh BINARY [ARGS...]"

# ANCHOR: sign_and_run
bin="$(physical_file "$1")"
shift
# SIGN-4: only binaries cargo built under the target dir are ever signed or run.
inside_target_dir "$bin" || die "refusing $bin: not under $(target_dir) (SIGN-4)"

# A private copy that no cargo build writes to; stale copies of exited runs are removed.
runs="$(target_dir)/run-bin"
mkdir -p -- "$runs"
for d in "$runs"/*; do
  pid="$(basename -- "$d")"
  [[ -d "$d" && "$pid" =~ ^[0-9]+$ && "$pid" != "$$" ]] || continue
  kill -0 "$pid" 2>/dev/null || rm -rf -- "$d"
done
priv="$runs/$$"
rm -rf -- "$priv"
mkdir -p -- "$priv"
copy="$priv/$(basename -- "$bin")"
cp -- "$bin" "$copy.tmp"
mv -f -- "$copy.tmp" "$copy"

# The hypervisor entitlement goes only onto binaries that need HVF: the ones that link
# Hypervisor.framework (macvmm and the test binaries of hvf, vmm and macvmm). Everything else
# (xtask, its tests) is signed ad-hoc without entitlements. sign.sh reads the signature back.
if /usr/bin/otool -L "$copy" | grep -q '/Hypervisor.framework/'; then
  "$REPO_ROOT/scripts/sign.sh" "$copy"
else
  "$REPO_ROOT/scripts/sign.sh" --no-entitlements "$copy"
fi
exec "$copy" "$@"
# ANCHOR_END: sign_and_run
