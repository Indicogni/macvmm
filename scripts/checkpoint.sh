#!/usr/bin/env bash
# Run a chapter checkpoint (PLAN M27; CURRICULUM §3.3).
#
#   scripts/checkpoint.sh NN                targets ./learner if it exists, else the reference
#   scripts/checkpoint.sh NN --ref          the reference (authors and CI use this)
#   scripts/checkpoint.sh NN --impl DIR     another implementation tree (harness self-tests)
#   scripts/checkpoint.sh all --ref         the "curriculum is not broken" gate
#   options: --keep (keep each run's {out} directory under target/checkpoint/NN/<key>/out/)
#
# L1 builds a throwaway crate under target/checkpoint/NN/<key>/ against the tree's crates/vmm and
# runs the chapter's contract tests (host only); L2 builds the tree's macvmm, signs it with
# scripts/sign.sh (only com.apple.security.hypervisor) and runs the test guests; L3 checks a
# learner's journal. Ends with `CHECKPOINT NN PASS` (exit 0) or `CHECKPOINT NN FAIL` (exit 1).
# Everything stays on this machine: nothing is uploaded, there is no telemetry.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

case "${1:-}" in
  -h|--help|'') sed -n '2,15p' "$0"; [[ -n "${1:-}" ]] && exit 0; exit 2 ;;
esac
cd -- "$REPO_ROOT"
exec cargo run --quiet --locked -p xtask -- checkpoint "$@"
