#!/usr/bin/env bash
# An interleaved bug hunt (PLAN M27; CURRICULUM §6.4).
#
#   scripts/bughunt.sh PART [--keep]          e.g. scripts/bughunt.sh iii
#
# Copies the reference into a new private directory under $TMPDIR, plants one fault from
# course/bughunts/PART/ (chosen at random), runs the checkpoint that must catch it against the
# copy and prints only the symptom. Your working tree is never touched: this script compares
# `git status --porcelain` before and after and fails if anything changed. --keep leaves the
# patched copy in $TMPDIR for you to debug. Exit 0: the checkpoint caught the fault.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

case "${1:-}" in
  -h|--help|'') sed -n '2,10p' "$0"; [[ -n "${1:-}" ]] && exit 0; exit 2 ;;
esac
cd -- "$REPO_ROOT"
before="$(git status --porcelain --untracked-files=all)"
rc=0
cargo run --quiet --locked -p xtask -- bughunt "$@" || rc=$?
after="$(git status --porcelain --untracked-files=all)"
[[ "$before" == "$after" ]] || die "the working tree changed during the bug hunt (a harness bug: please report it)"
info "working tree unchanged"
exit "$rc"
