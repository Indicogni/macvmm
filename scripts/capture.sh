#!/usr/bin/env bash
# Record a checkpoint's real output from the reference on this Mac (course/STYLE.md appendix A).
#
#   scripts/capture.sh NN|all
#
# Runs `scripts/checkpoint.sh NN --ref` and writes one transcript per [[run]] to
# course/captures/NN-<run>.txt (the command, exit code, stdout and stderr, machine paths
# replaced by {out}, {guests} and <repo>) plus NN-<run>.trace.jsonl when the run writes a trace.
# Lessons quote these files and authors update course/checkpoints/NN/expected/* from them:
# golden files come from real hardware, never from editing by hand. Needs Apple Silicon.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

(( $# == 1 )) || die "usage: scripts/capture.sh NN|all"
case "$1" in
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
  all|[0-2][0-9]) ;;
  *) die "usage: scripts/capture.sh NN|all" ;;
esac
cd -- "$REPO_ROOT"
exec cargo run --quiet --locked -p xtask -- checkpoint "$1" --ref --capture
