#!/usr/bin/env bash
# Run macvmm under an exec-time sandbox (PLAN M22, threat model SBX-1): the FALLBACK for a macOS
# release where `macvmm run --sandbox` (a mid-process `sandbox_init` with SBPL text, an
# undocumented mode) stops working.
#
#   scripts/sandbox-exec-fallback.sh [--read PATH]... [--write PATH]... -- MACVMM run ARGS...
#
#   --read PATH   an input macvmm opens read-only (--kernel, --initrd, --raw, --bios, --disk F,ro)
#   --write PATH  a file macvmm opens for writing (--disk F, --serial file:, --trace, --dtb-out)
#
# Do NOT pass --sandbox to macvmm here: a process that is already sandboxed cannot call
# sandbox_init again, so `--sandbox` would (correctly) exit 1.
#
# How it differs from --sandbox. `sandbox-exec -p PROFILE -D NAME=VALUE... CMD` applies the
# profile from exec onward, so it must also allow what macvmm does *before* its own lockdown:
# dyld loading the system libraries and the binary itself, and HostIo opening the user's files.
# Each user path is passed as a `-D` parameter and referenced as `(param "R0")`, never pasted
# into the profile text, so no path can change what the profile means. Path lookups also need
# `file-read-metadata` on the directories (and symlinks such as /var -> private/var) along each
# path, so the profile allows it on exactly those: every ancestor of the binary, of each --read
# and --write path, and of the working directory, both as given and as resolved. A stat of any
# other host path (~/.ssh/..., say) is denied, as under --sandbox. Everything else is the M22
# lockdown profile: no network, no process creation (beyond this one exec), no mach-lookup, no
# IOKit (HVF needs none: threat model §13). The two remaining differences from --sandbox are
# the read allowances dyld and HostIo need before macvmm runs (they last for the whole run) and
# the per-path allowances above (threat model SBX-1, RR10). The `sandbox-exec` tool is
# deprecated but still ships as /usr/bin/sandbox-exec on macOS 27.2.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

reads=()
writes=()
while (( $# > 0 )); do
  case "$1" in
    --read) reads+=("${2:?--read needs a path}"); shift 2 ;;
    --write) writes+=("${2:?--write needs a path}"); shift 2 ;;
    --) shift; break ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown option $1 (the macvmm command line goes after --)" ;;
  esac
done
(( $# >= 1 )) || die "usage: scripts/sandbox-exec-fallback.sh [--read P]... [--write P]... -- MACVMM run ..."
[[ -x /usr/bin/sandbox-exec ]] || die "/usr/bin/sandbox-exec is missing on this macOS"
for a in "$@"; do
  [[ "$a" != --sandbox* ]] || die "do not pass $a: this wrapper is the sandbox"
done

# Resolve to physical absolute paths: the kernel checks the real path of every file.
abs() {
  local p="$1" dir base
  dir="$(dirname -- "$p")"
  base="$(basename -- "$p")"
  [[ -d "$dir" ]] || die "no such directory: $dir"
  printf '%s/%s\n' "$(cd -- "$dir" && pwd -P)" "$base"
}
# The same path with only the directory part made absolute (symlinks kept: the path as macvmm
# will look it up).
logical() {
  local p="$1" dir
  dir="$(dirname -- "$p")"
  [[ -d "$dir" ]] || die "no such directory: $dir"
  printf '%s/%s\n' "$(cd -- "$dir" && pwd -L)" "$(basename -- "$p")"
}
given_bin="$(logical "$1")"
bin="$(physical_file "$1")"
shift

# Every path whose metadata a lookup may read (header comment), deduplicated.
meta=()
add_meta() {
  local p="$1" m
  while [[ -n "$p" ]]; do
    # Seen before: its ancestors were added with it.
    for m in "${meta[@]+"${meta[@]}"}"; do
      [[ "$m" != "$p" ]] || return 0
    done
    meta+=("$p")
    [[ "$p" != "/" ]] || break
    p="$(dirname -- "$p")"
  done
}
add_meta "$given_bin"
add_meta "$bin"
add_meta "$(pwd -L)"
add_meta "$(pwd -P)"

profile='(version 1)
(deny default)
(allow process-exec (literal (param "MACVMM")))
(allow file-read* (literal (param "MACVMM")))
;; dyld reads "/" itself at startup (measured: without it the process aborts, exit 134).
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share")
       (subpath "/private/var/db/dyld") (subpath "/Library/Apple")
       (subpath "/private/var/db/timezone") (literal "/dev/null") (literal "/dev/random")
       (literal "/dev/urandom"))
(allow sysctl-read)
(allow file-ioctl
       (ioctl-command TIOCSETA)
       (ioctl-command TIOCSETAW)
       (ioctl-command TIOCSETAF)
       (ioctl-command TIOCFLUSH))
(allow file-write-data (literal "/dev/null"))
'
params=(-D "MACVMM=$bin")
i=0
for p in "${reads[@]+"${reads[@]}"}"; do
  add_meta "$(logical "$p")"
  add_meta "$(abs "$p")"
  params+=(-D "R$i=$(abs "$p")")
  profile+="(allow file-read* (literal (param \"R$i\")))"$'\n'
  i=$((i + 1))
done
i=0
for p in "${writes[@]+"${writes[@]}"}"; do
  add_meta "$(logical "$p")"
  add_meta "$(abs "$p")"
  params+=(-D "W$i=$(abs "$p")")
  profile+="(allow file-read* file-write* (literal (param \"W$i\")))"$'\n'
  i=$((i + 1))
done
i=0
for p in "${meta[@]}"; do
  params+=(-D "M$i=$p")
  profile+="(allow file-read-metadata (literal (param \"M$i\")))"$'\n'
  i=$((i + 1))
done
profile+='(deny network*)
(deny process-fork)
'
exec /usr/bin/sandbox-exec -p "$profile" "${params[@]}" -- "$bin" "$@"
