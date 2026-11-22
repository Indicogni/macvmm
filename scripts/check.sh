#!/usr/bin/env bash
# The single quality gate (PLAN §0.1 item 1). Prints `CHECK OK` last, or fails.
#
#   scripts/check.sh            host checks (no HVF needed; what hosted CI runs)
#   scripts/check.sh --hvf      also the HVF tests and end-to-end suites on this Mac
#   scripts/check.sh --strict   every SKIP is a failure (the M23 fresh-clone gate)
#
# Order: fmt, clippy, tests, unsafe/security audit, FFI oracle, anchors, the lesson lint
# (course/STYLE.md appendix A), guest build; then the
# dependency allowlist (SC-11), `bash -n` and the SC-1 preamble on every script, shellcheck
# (TEST-2), and the offline fetch tests. Every cargo call uses --locked (SC-11).
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

hvf=0
strict=0
for arg in "$@"; do
  case "$arg" in
    --hvf) hvf=1 ;;
    --strict) strict=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

cd -- "$REPO_ROOT"
skips=0
step() { printf '\n== %s\n' "$*"; }
skip() {
  printf 'SKIP %s\n' "$*"
  skips=$((skips + 1))
  if (( strict )); then die "--strict: SKIP is a failure ($*)"; fi
}
# Run a script if it exists yet; otherwise SKIP (checks for future files pass vacuously).
# The second argument says what the missing script would have checked.
maybe() {
  local script="$1" what="$2"
  shift 2
  if [[ -x "$script" ]]; then
    # Exit status 77 is a script saying "I cannot run here" (check-ffi.sh on an SDK older than
    # the one ffi.rs is checked against): a SKIP, so --strict still refuses it.
    local rc=0
    "$script" "$@" || rc=$?
    if (( rc == 77 )); then
      skip "$script (cannot run on this machine; see the line above)"
    elif (( rc != 0 )); then
      return "$rc"
    fi
  else
    skip "$script (not yet created: $what)"
  fi
}

# ANCHOR: check_gate
step "cargo fmt";     cargo fmt --all --check
step "cargo clippy";  cargo clippy --locked --workspace --all-targets -- -D warnings
step "cargo test";    cargo test --locked --workspace
step "check-unsafe";  scripts/check-unsafe
step "check-ffi";     maybe scripts/check-ffi.sh "the FFI oracle"
step "check-anchors"; scripts/check-anchors
step "check-lessons"; scripts/check-lessons
step "build-guests";  maybe scripts/build-guests.sh "the test guests"
# ANCHOR_END: check_gate

# The course site (course/site/DESIGN.md section 10): renderer, lab-model and vector tests, then a
# full build that fails on broken internal links or #anchors, missing assets, CSP violations and
# contrast regressions. Node built-ins only; the output goes to the gitignored course/site/dist/.
step "course site"
if command -v node >/dev/null 2>&1 \
  && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  node --test 'course/site/**/*.test.mjs'
  node course/site/build.mjs --check
else
  skip "course site (needs Node 22 or later)"
fi

# M21: the experimental vmapple board is off by default, so the gate above never compiles it.
step "experimental-vmapple (M21)"
cargo clippy --locked -p vmm -p macvmm --all-targets --features experimental-vmapple -- -D warnings
cargo test --locked -p vmm -p macvmm --features experimental-vmapple --lib --bins

step "check-insn-corpus"; scripts/check-insn-corpus.sh

step "dependency allowlist"
cargo run --locked --quiet -p xtask -- audit --deps

# M22 (threat model FDT-1, RR14): neither a plain `cargo build` (the workspace default-members)
# nor `cargo build -p macvmm` may turn on `vmm/test-util` (the FDT reader, the test doubles)
# through feature unification with `crates/fuzz`.
step "shipped build has no vmm/test-util (FDT-1)"
for scope in default macvmm; do
  if [[ "$scope" == default ]]; then
    features="$(cargo tree --locked -e normal,features -i vmm)"
  else
    features="$(cargo tree --locked -p macvmm -e normal,features -i vmm)"
  fi
  [[ "$features" != *test-util* ]] \
    || die "the $scope build enables vmm/test-util (check default-members in Cargo.toml)"
done

step "scripts: syntax and SC-1 preamble"
shell_scripts=()
while IFS= read -r f; do
  first="$(head -n 1 -- "$f")"
  case "$first" in
    '#!/usr/bin/env bash'|'#!/bin/bash')
      bash -n -- "$f" || die "bash -n failed: $f"
      for need in 'set -euo pipefail' "IFS=\$'\\n\\t'" 'umask 077'; do
        grep -qF -- "$need" "$f" || die "$f lacks '$need' (SC-1)"
      done
      shell_scripts+=("$f") ;;
    '#!/bin/sh'*)
      sh -n -- "$f" || die "sh -n failed: $f"
      shell_scripts+=("$f") ;;
    *)
      if [[ "$f" == *.sh ]]; then
        grep -q '^# shellcheck shell=bash' -- "$f" || die "$f: no shebang (SC-1)"
        bash -n -- "$f" || die "bash -n failed: $f"
        shell_scripts+=("$f")
      fi ;;
  esac
done < <(find scripts -type f ! -name '*.c' ! -name '*.txt' | sort)
printf 'scripts OK: %s files\n' "${#shell_scripts[@]}"

step "shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning -x -- "${shell_scripts[@]}"
  printf 'shellcheck OK\n'
else
  skip "shellcheck (not installed)"
fi

step "test-fetch"
scripts/test-fetch.sh

if (( hvf )); then
  step "HVF availability"
  # Skip-and-pass only when the probe ran and hv_vm_create answered "no hypervisor here"
  # (HV_UNSUPPORTED 0xfae9400f, HV_NO_DEVICE 0xfae94006: a VM without nested virtualization).
  # Anything else fails the gate: a clang or codesign failure, a sign.sh refusal, failed
  # capability queries or hv_vm_destroy, and HV_DENIED (0xfae94007), which means our signing
  # is broken, not that the host lacks a hypervisor.
  probe_rc=0
  probe_out="$(scripts/doctor.sh 2>&1)" || probe_rc=$?
  if (( probe_rc != 0 )); then
    hv_code="$(printf '%s\n' "$probe_out" \
      | sed -n 's/^doctor: hv_vm_create: FAILED (\(0x[0-9a-f]\{8\}\))$/\1/p' | head -n 1)"
    case "$hv_code" in
      0xfae9400f|0xfae94006)
        if (( strict )); then die "--strict: HVF unavailable: hv_vm_create: FAILED ($hv_code)"; fi
        printf '%s\n' "$probe_out"
        printf '\nCHECK OK (HVF unavailable: hv_vm_create: FAILED (%s); HVF checks skipped)\n' "$hv_code"
        exit 0 ;;
      *)
        printf '%s\n' "$probe_out" >&2
        die "scripts/doctor.sh failed (exit $probe_rc${hv_code:+, hv_vm_create $hv_code}); not a host without HVF, so this is a failure" ;;
    esac
  fi
  printf '%s\n' "$probe_out"
  step "macvmm doctor"
  cargo run --locked --quiet -p macvmm -- doctor
  step "signing tests"
  scripts/test-signing.sh
  step "HVF tests"
  cargo test --locked -p hvf -p vmm --features hvf/hvf-tests,vmm/hvf-tests -- --test-threads=1
  # F22 (threat model MEM-11): teardown.rs compiles only with `fault-injection`, so the line
  # above runs it as 0 tests; this is the one place outside the M23 gate that runs it.
  step "HVF teardown tests (fault injection)"
  cargo test --locked -p hvf --features hvf-tests,fault-injection --test teardown -- --test-threads=1
  step "end-to-end"
  maybe scripts/test-e2e.sh M3 all
fi

printf '\n'
if (( skips > 0 )); then
  printf '%s check(s) skipped (see SKIP lines above; --strict makes them failures)\n' "$skips"
fi
printf 'CHECK OK\n'
