#!/usr/bin/env bash
# PLAN M16 "Security tests": run the host test `psci_smp` 100 times under --release and stop at
# the first failing run (threat model HC-3, HC-4).
#
#   scripts/test-psci-smp-loop.sh [RUNS]     RUNS defaults to 100
#
# Why a loop: the races in crates/vmm/tests/psci_smp.rs (8 threads at one CPU_ON target, the
# target taking its mailbox mid-race) only show a locking bug when the interleaving is unlucky.
# One run in debug, as scripts/check.sh does, gives few chances; 100 optimized runs give many.
# Host-only: no Hypervisor.framework, no signing, nothing downloaded.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

runs="${1:-100}"
[[ "$runs" =~ ^[1-9][0-9]{0,4}$ ]] || die "usage: scripts/test-psci-smp-loop.sh [RUNS] (1..99999)"

cd -- "$REPO_ROOT"
info "building psci_smp (release)"
cargo test --locked --release -p vmm --test psci_smp --no-run
log="$(mktemp -t psci-smp-loop)"
trap 'rm -f -- "$log"' EXIT
for ((i = 1; i <= runs; i++)); do
  if ! cargo test --locked --release -p vmm --test psci_smp >"$log" 2>&1; then
    cat -- "$log" >&2
    die "run $i of $runs FAILED"
  fi
done
info "$(grep -E '^test result:' -- "$log" | tail -n 1)"
info "psci_smp: $runs of $runs release runs passed"
