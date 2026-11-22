#!/usr/bin/env bash
# The v1 release gate (PLAN M23; threat model §10.2 M23): build and test macvmm the way a
# newcomer would, from a fresh copy of the code and an EMPTY download cache.
#
#   scripts/fresh-clone-check.sh --from-worktree [--with-freebsd]
#   scripts/fresh-clone-check.sh --from-git URL|PATH [--with-freebsd]
#
# Iteration only (any of these makes the run unable to print FRESH CLONE OK):
#   --reuse-cache       use ${MACVMM_CACHE:-<repo>/.cache/macvmm} instead of an empty cache
#   --steps a,b,...     run only the named steps (names as in the table)
#   --fuzz-seconds N    seconds per fuzz target (the gate is 60)
# Other options:
#   --dir PARENT        where macvmm-fresh-<ts>/ is created (default: $TMPDIR)
#
# Layout: <PARENT>/macvmm-fresh-<ts>/{src,logs}; the cache is src/.cache/macvmm. `src` is the copy: `git clone --no-local`
# for --from-git; for --from-worktree, the files `git ls-files -co --exclude-standard` lists
# (tracked plus untracked-but-not-ignored), committed into a throwaway repository so step
# `git-status-clean` can ask git whether the run left stray files outside .gitignore.
# Every step's full output is in logs/NN-<step>.log; this script prints each step's last lines.
#
# Order: the README quickstart runs first, right after the copy, so it meets the empty cache
# exactly as a newcomer does and "time to / #" is the newcomer's time. Then setup, doctor,
# check --strict, the HVF tests, fetch of every set, mkrootfs, all e2e suites, vz-mac, the
# checkpoints, a learner smoke test, the fuzzers, the release binary's signature (SIGN-3),
# check-anchors and finally `git status --porcelain`. A failed step does not stop the run.
# Prints a table (step, PASS/FAIL/SKIP, seconds) and `FRESH CLONE OK` only if nothing FAILed
# or was SKIPped (the only SKIP PLAN M23 allows, freebsd without --with-freebsd, still keeps the
# OK line away: freebsd_login is a normal test, not #[ignore]d).
# Nothing downloaded is executed (SC-4): fetching is scripts/fetch.sh's job, unchanged.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

mode=""
from_git=""
with_freebsd=0
reuse_cache=0
only_steps=""
fuzz_seconds=60
parent="${TMPDIR:-/tmp}"
while (( $# > 0 )); do
  case "$1" in
    -h|--help) sed -n '2,/^[^#]/{/^#/p;}' "$0"; exit 0 ;;
    --from-worktree) mode=worktree; shift ;;
    --from-git)
      (( $# >= 2 )) || die "--from-git needs a URL or path"
      mode=git; from_git="$2"; shift 2 ;;
    --with-freebsd) with_freebsd=1; shift ;;
    --reuse-cache) reuse_cache=1; shift ;;
    --steps)
      (( $# >= 2 )) || die "--steps needs a comma-separated list"
      [[ "$2" =~ ^[a-z0-9,-]+$ ]] || die "bad --steps list: $2"
      only_steps=",$2,"; shift 2 ;;
    --fuzz-seconds)
      (( $# >= 2 )) || die "--fuzz-seconds needs a number"
      [[ "$2" =~ ^[0-9]{1,5}$ ]] || die "bad --fuzz-seconds: $2"
      fuzz_seconds="$2"; shift 2 ;;
    --dir)
      (( $# >= 2 )) || die "--dir needs a directory"
      parent="$2"; shift 2 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [[ -z "$mode" ]]; then
  # The default after the lead commits: clone this repository's HEAD. With uncommitted work
  # that would silently test old code, so say so instead.
  if [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    mode=git; from_git="$REPO_ROOT"
  else
    die "the working tree has uncommitted changes: pass --from-worktree (or --from-git URL)"
  fi
fi

[[ -d "$parent" ]] || die "no such directory: $parent"
parent="$(cd -- "$parent" && pwd -P)"
ts="$(date +%Y%m%d-%H%M%S)"
base="$parent/macvmm-fresh-$ts"
[[ ! -e "$base" ]] || die "$base already exists"
src="$base/src"
logs="$base/logs"
mkdir -m 700 -- "$base"
mkdir -- "$logs"

if (( reuse_cache )); then
  cache="$(cache_dir)"
else
  # The default location inside the fresh copy, which is where a newcomer's downloads go and
  # where the lessons' and checkpoints' commands look (`.cache/macvmm/Image-virt`). It does not
  # exist in a clone (.cache is gitignored), so it is empty until the first scripts/fetch.sh
  # creates it 0700 (SC-3). A cache anywhere else would pass every script that honours
  # MACVMM_CACHE and fail every command a learner types as written.
  cache="$src/.cache/macvmm"
fi

# The children see only what a newcomer's shell would: no inherited target dir, no skip switch.
unset CARGO_TARGET_DIR MACVMM_E2E_ALLOW_SKIP
export MACVMM_CACHE="$cache"

start=$SECONDS
names=()
results=()
durations=()
n=0
prompt_at=""

record() { names+=("$1"); results+=("$2"); durations+=("$3"); }
# `$*` joins with IFS's first character, a newline here (SC-1), so join with spaces explicitly.
join() { local IFS=' '; printf '%s' "$*"; }

wanted() { [[ -z "$only_steps" || "$only_steps" == *",$1,"* ]]; }

# step NAME CMD...: run CMD in the copy with output to logs/NN-NAME.log; record the verdict.
step() {
  local name="$1" log t0 rc lines
  shift
  wanted "$name" || return 0
  n=$((n + 1))
  log="$logs/$(printf '%02d' "$n")-$name.log"
  printf '\n== %s: %s\n' "$name" "$(join "$@")"
  t0=$SECONDS
  # errexit is off inside anything on the left of `||`, so a function step would run on past
  # its first failure; instead turn it off here and back on inside the subshell.
  set +e
  (set -e; cd -- "$src"; "$@") </dev/null >"$log" 2>&1
  rc=$?
  set -e
  lines=8
  (( rc == 0 )) || lines=40
  tail -n "$lines" -- "$log" | sed 's/^/  | /'
  if (( rc == 0 )); then
    record "$name" PASS $((SECONDS - t0))
  else
    printf '  exit %s (full log: %s)\n' "$rc" "$log"
    record "$name" FAIL $((SECONDS - t0))
  fi
}

skip_step() {
  wanted "$1" || return 0
  printf '\n== %s: SKIP (%s)\n' "$1" "$2"
  record "$1" SKIP 0
}

info "base $base"
info "cache $cache$( (( reuse_cache )) && printf ' (reused: iteration only)')"

# ---- 1. get the code --------------------------------------------------------------------
copy_worktree() {
  local list="$base/files.lst" f
  # NUL-separated so any file name survives; tracked files deleted in the worktree are dropped.
  (cd -- "$REPO_ROOT" && git ls-files -z -co --exclude-standard) \
    | while IFS= read -r -d '' f; do
        if [[ -f "$REPO_ROOT/$f" || -L "$REPO_ROOT/$f" ]]; then printf '%s\0' "$f"; fi
      done >"$list"
  mkdir -- "$src"
  (cd -- "$REPO_ROOT" && tar --null -T "$list" -cf -) | (cd -- "$src" && tar -xpf -)
  printf 'copied %s files\n' "$(tr -cd '\0' <"$list" | wc -c | tr -d ' ')"
  # A throwaway repository, so `git status --porcelain` means the same as in a real clone.
  git -C "$src" init -q
  git -C "$src" add -A
  git -C "$src" -c user.name=fresh-clone-check -c user.email=fresh-clone-check@invalid \
    -c commit.gpgsign=false commit -q -m "fresh-clone-check snapshot of the worktree"
  git -C "$src" log --oneline -1
}

t0=$SECONDS
n=$((n + 1))
printf '\n== get-code: %s\n' "$mode${from_git:+ $from_git}"
rc=0
if [[ "$mode" == git ]]; then
  git clone -q --no-local -- "$from_git" "$src" >"$logs/01-get-code.log" 2>&1 || rc=$?
  [[ -d "$src" ]] && git -C "$src" log --oneline -1 >>"$logs/01-get-code.log" 2>&1
else
  copy_worktree >"$logs/01-get-code.log" 2>&1 || rc=$?
fi
sed 's/^/  | /' "$logs/01-get-code.log"
if (( rc != 0 )); then
  record get-code FAIL $((SECONDS - t0))
  die "could not get the code (exit $rc); nothing else can run"
fi
record get-code PASS $((SECONDS - t0))

# ---- 2. the README quickstart, literally -----------------------------------------------
# The fenced sh lines between <!-- ANCHOR: quickstart --> and <!-- ANCHOR_END: quickstart -->,
# run by bash -euo pipefail in the copy's root. Its last command boots Linux to the busybox
# prompt; this driver then types exactly what e2e_linux.rs `linux_shell` types.
quickstart() {
  local block="$base/quickstart.sh" fifo="$base/quickstart.fifo" log qpid rc=0 deadline
  awk '/<!-- ANCHOR: quickstart -->/{a=1; next}
       /<!-- ANCHOR_END: quickstart -->/{a=0}
       a && /^```/{f=!f; next}
       a && f' "$src/README.md" >"$block"
  [[ -s "$block" ]] || { printf 'no quickstart block in README.md\n'; return 1; }
  printf 'quickstart block (README.md, verbatim):\n'
  sed 's/^/    /' "$block"
  n=$((n + 1))
  log="$logs/$(printf '%02d' "$n")-quickstart.log"
  mkfifo -m 600 -- "$fifo" || return 1
  # Its own process group (set -m), so a hung run can be killed with everything it started.
  set -m
  (cd -- "$src" && exec bash -euo pipefail "$block") <"$fifo" >"$log" 2>&1 &
  qpid=$!
  set +m
  exec 3>"$fifo"
  wait_log() { # PATTERN SECONDS
    local until=$((SECONDS + $2))
    while (( SECONDS < until )); do
      grep -qF -- "$1" "$log" && return 0
      kill -0 "$qpid" 2>/dev/null || { grep -qF -- "$1" "$log"; return; }
      sleep 1
    done
    return 1
  }
  if wait_log '/ # ' 3600; then
    prompt_at=$((SECONDS - start))
    printf 'reached "/ # " %ss after the start of this run\n' "$prompt_at"
    # The exact bytes linux_shell sends (crates/macvmm/tests/e2e_linux.rs).
    # shellcheck disable=SC2016
    printf 'echo macvmm-shell: $((6*7))\n' >&3
    if wait_log 'macvmm-shell: 42' 30; then
      printf 'poweroff -f\n' >&3
      wait_log 'reboot: Power down' 30 || rc=1
    else
      rc=1
    fi
  else
    rc=1
  fi
  deadline=$((SECONDS + 60))
  while kill -0 "$qpid" 2>/dev/null && (( SECONDS < deadline )); do sleep 1; done
  if kill -0 "$qpid" 2>/dev/null; then
    printf 'quickstart still running: killing it\n'
    kill -TERM -- "-$qpid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$qpid" 2>/dev/null || true
    rc=1
  fi
  local qrc=0
  wait "$qpid" || qrc=$?
  exec 3>&-
  rm -f -- "$fifo"
  printf 'quickstart exit code %s (the last command, run-linux.sh, exits 0 on poweroff)\n' "$qrc"
  (( qrc == 0 )) || rc=1
  grep -F 'macvmm-shell: 42' "$log" | sed 's/^/  | /' || rc=1
  printf 'last lines of %s:\n' "$log"
  tail -n 6 -- "$log" | sed 's/^/  | /'
  return "$rc"
}

if wanted quickstart; then
  printf '\n== quickstart: the README block, literally\n'
  t0=$SECONDS
  if quickstart; then
    record quickstart PASS $((SECONDS - t0))
  else
    record quickstart FAIL $((SECONDS - t0))
  fi
fi

# ---- 3-4. setup, doctors, the quality gate ----------------------------------------------
step setup scripts/setup.sh
step doctor-sh scripts/doctor.sh
step doctor-macvmm cargo run --locked -p macvmm -- doctor
step check-strict scripts/check.sh --strict
# What `scripts/check.sh --hvf` adds besides the e2e suites (those run below, once).
step signing-tests scripts/test-signing.sh
# A test binary whose `#![cfg(feature = ...)]` is not met compiles to nothing and still ends
# `test result: ok. 0 passed`, so a step that exists for named test binaries checks that each
# of them ran at least one test (the output is saved to <base>/<file> and parsed here).
require_ran() {
  local out="$1" t n
  shift
  for t in "$@"; do
    n="$(awk -v want="tests/$t.rs" '
      $1 == "Running" && $2 == want { hit = 1; next }
      hit && $1 == "running" { print $2; exit }' "$out")"
    if [[ ! "$n" =~ ^[0-9]+$ ]]; then
      printf 'require_ran: test binary tests/%s.rs did not run\n' "$t"
      return 1
    fi
    if (( n == 0 )); then
      printf 'require_ran: tests/%s.rs ran 0 tests (its cfg features are not enabled)\n' "$t"
      return 1
    fi
    printf 'require_ran: tests/%s.rs ran %s test(s)\n' "$t" "$n"
  done
}

hvf_tests() {
  local out="$base/hvf-tests.txt"
  cargo test --locked -p hvf -p vmm --features hvf/hvf-tests,vmm/hvf-tests -- --test-threads=1 \
    2>&1 | tee -- "$out"
  require_ran "$out" smoke hvf_memory hvf_gic_live
}
step hvf-tests hvf_tests

# F22 (threat model MEM-11, PLAN M2 rev 1.2): fail-closed teardown. teardown.rs is compiled only
# with `fault-injection`, which no other step enables (the hvf-tests step runs it as 0 tests).
teardown_tests() {
  local out="$base/teardown-tests.txt"
  cargo test --locked -p hvf --features hvf-tests,fault-injection --test teardown \
    -- --test-threads=1 2>&1 | tee -- "$out"
  require_ran "$out" teardown
}
step teardown-tests teardown_tests

# ---- 5. artifacts into the (empty) cache -----------------------------------------------
sets=(linux uboot rootfs)
(( with_freebsd )) && sets+=(freebsd)
step fetch scripts/fetch.sh "${sets[@]}"
step mkrootfs cargo xtask mkrootfs --out "$cache/rootfs.img" --size 256M

# ---- 6. every e2e suite, vz-mac, checkpoints, learner smoke ----------------------------
if (( with_freebsd )); then
  step e2e-all scripts/test-e2e.sh all
else
  # Every suite but freebsd, whose freebsd_login needs the FreeBSD image (--with-freebsd).
  e2e_suites=()
  while IFS= read -r f; do
    s="$(basename -- "$f" .rs)"; s="${s#e2e_}"
    [[ "$s" == freebsd ]] || e2e_suites+=("$s")
  done < <(find "$src/crates/macvmm/tests" -maxdepth 1 -name 'e2e_*.rs' -type f | sort)
  step e2e-all scripts/test-e2e.sh "${e2e_suites[@]}"
  skip_step e2e-freebsd "needs --with-freebsd"
fi
step vz-mac tools/vz-mac/test.sh
step checkpoints-ref scripts/checkpoint.sh all --ref

learner_smoke() {
  scripts/learner init
  scripts/learner start 00
  # Stand in for the learner's reflection: one line under every journal heading (L3 checks
  # presence only, never content).
  local j=learner/journal/00.md
  [[ -f "$j" ]] || { printf 'learner start 00 did not create %s\n' "$j"; return 1; }
  awk '{print} /^## /{print ""; print "(fresh-clone-check smoke test answer)"}' "$j" >"$j.new"
  mv -- "$j.new" "$j"
  scripts/checkpoint.sh 00
  scripts/learner status
}
step learner-smoke learner_smoke

# ---- security tests: fuzzers, the shipped binary's signature ---------------------------
step fuzz scripts/fuzz.sh all --seconds "$fuzz_seconds"

release_signature() {
  # RR14: the shipped binary is built with -p macvmm (no vmm/test-util by unification).
  cargo build --locked --release -p macvmm
  local bin
  bin="$(cd -- target/release && pwd -P)/macvmm"
  scripts/sign.sh "$bin"
  codesign -dv -- "$bin" 2>&1 | tee "$base/codesign.txt"
  # SIGN-3: the hardened runtime flag, e.g. `CodeDirectory v=20500 size=... flags=0x10002(adhoc,runtime)`.
  grep -E '^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)' -- "$base/codesign.txt"
  # SIGN-1: the entitlements are exactly {com.apple.security.hypervisor: true}, nothing more
  # (no network.client, no get-task-allow), compared as the whole `plutil -p` dictionary.
  local ents want
  ents="$(codesign -d --entitlements - --xml -- "$bin" 2>/dev/null | plutil -p -)"
  want=$'{\n  "com.apple.security.hypervisor" => true\n}'
  printf '%s\n' "$ents"
  if [[ "$ents" != "$want" ]]; then
    printf 'release-signature: entitlements are not exactly com.apple.security.hypervisor\n'
    return 1
  fi
  printf 'entitlements: com.apple.security.hypervisor only\n'
}
step release-signature release_signature

# ---- 9. anchors, 8. no stray files ------------------------------------------------------
step check-anchors scripts/check-anchors

git_status_clean() {
  local out
  out="$(git status --porcelain --untracked-files=all)"
  if [[ -n "$out" ]]; then
    printf 'stray files outside .gitignore:\n%s\n' "$out"
    return 1
  fi
  printf 'git status --porcelain: empty\n'
}
step git-status-clean git_status_clean

# ---- 10-11. the table and the verdict -------------------------------------------------
total=$((SECONDS - start))
printf '\n%-20s %-6s %8s\n' STEP RESULT SECONDS
printf '%-20s %-6s %8s\n' -------------------- ------ --------
fails=0
skips=0
for i in "${!names[@]}"; do
  printf '%-20s %-6s %8s\n' "${names[$i]}" "${results[$i]}" "${durations[$i]}"
  case "${results[$i]}" in
    FAIL) fails=$((fails + 1)) ;;
    SKIP) skips=$((skips + 1)) ;;
  esac
done
printf '%-20s %-6s %8s\n' total "" "$total"
if [[ -n "$prompt_at" ]]; then
  printf 'time from start to "/ # ": %ss\n' "$prompt_at"
else
  printf 'time from start to "/ # ": not reached\n'
fi
printf 'logs: %s\n' "$logs"

why=()
(( fails == 0 )) || why+=("$fails step(s) FAILED")
(( skips == 0 )) || why+=("$skips step(s) SKIPPED")
(( reuse_cache == 0 )) || why+=("--reuse-cache")
[[ -z "$only_steps" ]] || why+=("--steps")
(( fuzz_seconds >= 60 )) || why+=("--fuzz-seconds $fuzz_seconds < 60")
if (( ${#why[@]} == 0 )); then
  printf 'FRESH CLONE OK\n'
  exit 0
fi
printf 'FRESH CLONE NOT OK: %s\n' "$(IFS=';'; printf '%s' "${why[*]}" | sed 's/;/; /g')"
exit 1
