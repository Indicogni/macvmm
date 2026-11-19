# shellcheck shell=bash
# Shared helpers for macvmm scripts. Source it right after the SC-1 preamble:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   IFS=$'\n\t'
#   umask 077
#   . "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"
#
# Why: every script follows threat model SC-1 (strict mode, quoted expansions, no eval) and
# needs the same three facts: where the repository is, where cargo puts binaries, and where
# downloads are cached. Defining them once keeps the rules in one reviewed place.

set -euo pipefail
IFS=$'\n\t'
umask 077

# Name used in messages; scripts may override before sourcing.
SCRIPT_NAME="${SCRIPT_NAME:-$(basename -- "$0")}"
SCRIPT_NAME="${SCRIPT_NAME%.sh}"

die() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

info() {
  printf '%s: %s\n' "$SCRIPT_NAME" "$*"
}

warn() {
  printf '%s: warning: %s\n' "$SCRIPT_NAME" "$*" >&2
}

# The repository root (physical path), found from this file's location, not from $PWD.
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
export REPO_ROOT

# Cargo's target directory, as a physical absolute path. It may not exist yet.
target_dir() {
  local t="${CARGO_TARGET_DIR:-$REPO_ROOT/target}"
  case "$t" in
    /*) ;;
    *) t="$REPO_ROOT/$t" ;;
  esac
  mkdir -p -- "$t"
  (cd -- "$t" && pwd -P)
}

# Physical absolute path of an existing file (resolves symlinks in the directory part and,
# if the file itself is a symlink, refuses it).
physical_file() {
  local f="$1"
  [[ -e "$f" ]] || die "no such file: $f"
  [[ ! -L "$f" ]] || die "refusing symlink: $f"
  [[ -f "$f" ]] || die "not a regular file: $f"
  local dir
  dir="$(cd -- "$(dirname -- "$f")" && pwd -P)"
  printf '%s/%s\n' "$dir" "$(basename -- "$f")"
}

# Succeeds when $1 (a physical path) lies strictly inside the cargo target dir (SIGN-4).
inside_target_dir() {
  local p="$1" t
  t="$(target_dir)"
  [[ "$p" == "$t"/* ]]
}

# The download cache (SC-3): ${MACVMM_CACHE:-<repo>/.cache/macvmm}, created 0700. An existing
# directory must be a real directory (not a symlink), owned by us, not group/world-writable.
cache_dir() {
  local c="${MACVMM_CACHE:-$REPO_ROOT/.cache/macvmm}"
  # A relative MACVMM_CACHE is relative to the repo root, never the caller's cwd, so every
  # script (fetch.sh, run-linux.sh, tests) resolves the same directory (threat model S14).
  [[ "$c" == /* ]] || c="$REPO_ROOT/$c"
  if [[ -L "$c" ]]; then
    die "cache dir $c is a symlink; refusing (SC-3)"
  fi
  if [[ ! -e "$c" ]]; then
    # Parents get 0700 from `umask 077`; the cache dir itself gets it explicitly.
    mkdir -p -- "$(dirname -- "$c")"
    mkdir -m 700 -- "$c"
  fi
  [[ -d "$c" ]] || die "cache dir $c is not a directory (SC-3)"
  local owner mode
  owner="$(stat -f '%u' -- "$c")"
  mode="$(stat -f '%Lp' -- "$c")"
  [[ "$owner" == "$(id -u)" ]] || die "cache dir $c is owned by uid $owner, not $(id -u) (SC-3)"
  if (( (8#$mode & 8#022) != 0 )); then
    die "cache dir $c is group- or world-writable (mode $mode); run: chmod 700 '$c' (SC-3)"
  fi
  printf '%s\n' "$c"
}
