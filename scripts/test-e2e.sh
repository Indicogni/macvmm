#!/usr/bin/env bash
# Run end-to-end suites on this Mac (PLAN §0.3).
#
#   scripts/test-e2e.sh SUITE...     e.g. scripts/test-e2e.sh guests
#   scripts/test-e2e.sh all          every crates/macvmm/tests/e2e_*.rs
#
# Each suite is `cargo test -p macvmm --features hvf-tests --test e2e_<suite> -- --test-threads=1`
# (one VM per process: the harness boots one child at a time). The harness signs the binary and
# builds the guests itself. Needs Apple Silicon with Hypervisor.framework; nothing is downloaded.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

(( $# >= 1 )) || die "usage: scripts/test-e2e.sh SUITE...|all"

tests_dir="$REPO_ROOT/crates/macvmm/tests"
suites=()
for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    all)
      while IFS= read -r f; do
        name="$(basename -- "$f" .rs)"
        suites+=("${name#e2e_}")
      done < <(find "$tests_dir" -maxdepth 1 -name 'e2e_*.rs' -type f | sort) ;;
    *)
      [[ "$arg" =~ ^[a-z0-9_]+$ ]] || die "bad suite name: $arg"
      [[ -f "$tests_dir/e2e_$arg.rs" ]] || die "no such suite: $arg (crates/macvmm/tests/e2e_$arg.rs)"
      suites+=("$arg") ;;
  esac
done
(( ${#suites[@]} > 0 )) || die "no e2e suites found"

cd -- "$REPO_ROOT"
# Every suite runs even after a failure, so the summary covers them all.
passed=()
failed=()
for suite in "${suites[@]}"; do
  info "suite $suite"
  if cargo test --locked -p macvmm --features hvf-tests --test "e2e_$suite" -- --test-threads=1 --nocapture; then
    passed+=("$suite")
  else
    failed+=("$suite")
  fi
done
# One summary line. `${a[*]}` joins with the first character of IFS, which is a newline here
# (SC-1 sets IFS=$'\n\t'), so join with spaces explicitly.
join() { local IFS=' '; printf '%s' "$*"; }
if (( ${#failed[@]} > 0 )); then
  die "e2e FAILED: $(join "${failed[@]}") (passed: $(join "${passed[@]+"${passed[@]}"}"))"
fi
info "e2e OK: $(join "${passed[@]}")"
