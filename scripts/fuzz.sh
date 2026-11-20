#!/usr/bin/env bash
# Run the dependency-free fuzzers (PLAN M22; threat model TEST-3, §9.3).
#
#   scripts/fuzz.sh all|TARGET... [--seconds S] [--seed N]     default 60 s per target, seed 1
#   scripts/fuzz.sh list
#
# The acceptance run is `scripts/fuzz.sh all --seconds 60`: every target must report
# `0 failures`. Weekly, and before a release, run `scripts/fuzz.sh all --seconds 3600` (one hour
# per target, about a day in all; it can be split across machines with different --seed values).
#
# Each target runs from a release build of `crates/fuzz` (overflow checks stay on: the workspace
# release profile). A failing input is saved under target/fuzz/crashes/ (0600) and replayed with
#   cargo run -p fuzz --release -- TARGET --replay FILE
# Every crash becomes a regression case in the matching crates/*/tests/*_hostile.rs (TEST-3).
#
# `cli` has two halves: the `vmm` grammar pieces in the fuzz crate, and the real `macvmm run`
# parser, which lives in the binary crate and is fuzzed by its unit test `cli_fuzz`
# (MACVMM_FUZZ_SECONDS / MACVMM_SEED); this script runs both.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

seconds=60
seed=1
targets=()
while (( $# > 0 )); do
  case "$1" in
    --seconds) seconds="${2:?--seconds needs a value}"; shift 2 ;;
    --seed) seed="${2:?--seed needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) targets+=("$1"); shift ;;
  esac
done
(( ${#targets[@]} > 0 )) || die "usage: scripts/fuzz.sh all|list|TARGET... [--seconds S] [--seed N]"
[[ "$seconds" =~ ^[0-9]+$ ]] && (( seconds > 0 )) || die "--seconds must be a positive integer"
[[ "$seed" =~ ^[0-9]+$ ]] || die "--seed must be a number"

cd -- "$REPO_ROOT"
cargo build --release --locked --quiet -p fuzz
fuzz="$(target_dir)/release/fuzz"
[[ -x "$fuzz" ]] || die "no fuzz binary at $fuzz"

if [[ "${targets[0]}" == "list" ]]; then
  exec "$fuzz" list
fi
if [[ "${targets[0]}" == "all" ]]; then
  targets=()
  while IFS= read -r t; do targets+=("$t"); done < <("$fuzz" list)
fi

failed=()
passed=0
for t in "${targets[@]}"; do
  [[ "$t" =~ ^[a-z0-9_]+$ ]] || die "bad target name: $t"
  if "$fuzz" "$t" --seconds "$seconds" --seed "$seed"; then
    passed=$((passed + 1))
  else
    failed+=("$t")
  fi
  if [[ "$t" == "cli" ]]; then
    # The real `macvmm run` parser (module docs above).
    if MACVMM_FUZZ_SECONDS="$seconds" MACVMM_SEED="$seed" \
      cargo test --release --locked --quiet -p macvmm --bin macvmm cli_fuzz -- --nocapture 2>&1 \
      | grep -E '^fuzz cli|test result'; then
      :
    else
      failed+=("cli(parse_run)")
    fi
  fi
done
join() { local IFS=' '; printf '%s' "$*"; }
if (( ${#failed[@]} > 0 )); then
  die "fuzz FAILED: $(join "${failed[@]}") ($passed passed)"
fi
info "fuzz OK: $passed target(s), ${seconds}s each, seed $seed"
