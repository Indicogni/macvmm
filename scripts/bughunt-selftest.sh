#!/usr/bin/env bash
# The planted-bug self-test of the fuzzers (PLAN M22; threat model TEST-4).
#
#   scripts/bughunt-selftest.sh [--minutes M] [--seed N] [--only K] [--allow-concurrent-edits]
#
# A fuzzer that never finds anything proves nothing: maybe the code is right, maybe the fuzzer
# is blind. So we plant four bugs we know are real, one at a time, in a SCRATCH COPY of the
# workspace, and require the matching fuzz target to find each within M minutes (default 10):
#
#   1 crates/fuzz/planted/01-chain-range-no-checked-add.patch  virtqueue       (VQ-4)
#   2 crates/fuzz/planted/02-chain-no-hop-budget.patch         virtqueue       (VQ-5)
#   3 crates/fuzz/planted/03-used-idx-off-by-one.patch         virtqueue       (VQ-9)
#   4 crates/fuzz/planted/04-desc-len-double-fetch.patch       virtqueue + virtqueue_race_only
#                                                                                   (MEM-7)
#
# Bug 4 is a double fetch of `desc.len` after validation. Two different checks must each find
# it: the access log of the plain `virtqueue` target (a descriptor read twice in one pop, found
# deterministically, no concurrency needed), and the hidden `virtqueue_race_only` variant, which
# has the racing thread but NO access-log checks, so it finds the bug only when the racer really
# swaps a length between the check and the second read (a buffer outside RAM, VQ-4). That
# second run is what proves the racer has teeth; with the log on, the log always wins first.
#
# The working tree is never touched: the copy lives under a private `mktemp -d`, and
# `git status --porcelain` is compared before and after (other agents editing the tree at the
# same time make that comparison meaningless; --allow-concurrent-edits then only checks that
# the files this script patches are byte-identical). Prints `bughunt: K/4 planted bugs found`;
# exit 0 only for 4/4.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

minutes=10
seed=1
only=""
concurrent=0
while (( $# > 0 )); do
  case "$1" in
    --minutes) minutes="${2:?--minutes needs a value}"; shift 2 ;;
    --seed) seed="${2:?--seed needs a value}"; shift 2 ;;
    --only) only="${2:?--only needs a value}"; shift 2 ;;
    --allow-concurrent-edits) concurrent=1; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$minutes" =~ ^[0-9]+$ ]] && (( minutes > 0 )) || die "--minutes must be a positive integer"
[[ "$seed" =~ ^[0-9]+$ ]] || die "--seed must be a number"
[[ -z "$only" || "$only" =~ ^[1-4]$ ]] || die "--only must be 1..4"

cd -- "$REPO_ROOT"
plants=(
  "1 01-chain-range-no-checked-add.patch virtqueue"
  "2 02-chain-no-hop-budget.patch virtqueue"
  "3 03-used-idx-off-by-one.patch virtqueue"
  "4 04-desc-len-double-fetch.patch virtqueue,virtqueue_race_only"
)
patched_files=(crates/vmm/src/virtio/chain.rs crates/vmm/src/virtio/queue.rs)

tree_state() { git status --porcelain --untracked-files=all; }
file_sums() { shasum -a 256 -- "${patched_files[@]}"; }
before="$(tree_state)"
sums_before="$(file_sums)"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/macvmm-bughunt.XXXXXX")"
trap 'rm -rf -- "${scratch:?}"' EXIT
tree="$scratch/tree"
mkdir -p -- "$tree"
# Only what the fuzz crate needs: the workspace manifest, lock file, toolchain pin and crates.
cp -R -- crates "$tree/"
cp -- Cargo.toml Cargo.lock rust-toolchain.toml "$tree/"
rm -rf -- "${tree:?}/crates/fuzz/planted"
mkdir -p -- "$scratch/pristine"
for f in "${patched_files[@]}"; do
  cp -- "$f" "$scratch/pristine/$(basename -- "$f")"
done
export CARGO_TARGET_DIR="$scratch/target"

found=0
total=0
for p in "${plants[@]}"; do
  IFS=' ' read -r n patch target_list <<<"$p"
  [[ -z "$only" || "$only" == "$n" ]] || continue
  total=$((total + 1))
  for f in "${patched_files[@]}"; do
    cp -- "$scratch/pristine/$(basename -- "$f")" "$tree/$f"
  done
  patch -p1 --batch --forward --silent -d "$tree" < "crates/fuzz/planted/$patch" \
    || die "planted bug $n ($patch) does not apply to the current sources: regenerate it"
  info "bug $n ($patch): building the fuzzer against the planted copy"
  (cd -- "$tree" && cargo build --release --locked --quiet -p fuzz) \
    || die "the planted copy does not build (bug $n)"
  # Every listed target must find the bug on its own (bug 4: the log and the racer).
  IFS=',' read -r -a bug_targets <<<"$target_list"
  hits=0
  for target in "${bug_targets[@]}"; do
    info "bug $n: fuzzing '$target' for up to $minutes min (seed $seed)"
    start=$SECONDS
    rc=0
    log="$scratch/log-$n-$target.txt"
    "$CARGO_TARGET_DIR/release/fuzz" "$target" --seconds "$((minutes * 60))" --seed "$seed" \
      > "$log" 2>&1 || rc=$?
    took=$((SECONDS - start))
    if (( rc == 1 )) && grep -Eq 'FAILURE|HANG' "$log"; then
      hits=$((hits + 1))
      info "bug $n FOUND by $target after ${took}s:"
      grep -E 'FAILURE|HANG' "$log" | head -n 1 | sed 's/^/    /'
    else
      warn "bug $n NOT found by $target in ${took}s (exit $rc):"
      tail -n 3 "$log" | sed 's/^/    /' >&2
    fi
  done
  if (( hits == ${#bug_targets[@]} )); then
    found=$((found + 1))
  fi
done

after="$(tree_state)"
sums_after="$(file_sums)"
[[ "$sums_before" == "$sums_after" ]] \
  || die "a file this script patches changed in the working tree (a harness bug: please report it)"
if [[ "$before" != "$after" ]]; then
  if (( concurrent )); then
    warn "git status changed during the run (concurrent edits); the patched files are unchanged"
  else
    die "the working tree changed during the self-test (git status --porcelain differs)"
  fi
else
  info "working tree unchanged (git status --porcelain identical)"
fi
printf 'bughunt: %s/%s planted bugs found\n' "$found" "$total"
(( found == total ))
