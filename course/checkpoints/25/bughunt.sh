#!/usr/bin/env bash
# Checkpoint 25, the planted-bug runs: does YOUR fuzzer find bugs we know are there?
#
#   course/checkpoints/25/bughunt.sh REPO IMPL OUT PLANT SECONDS
#
# REPO is the course repository, IMPL the implementation tree being checked (./learner, or the
# reference itself), OUT the run's private {out} directory, PLANT 0..3, SECONDS the fuzzing
# budget. The checkpoint harness calls it once per plant (course/checkpoints/25/checkpoint.toml).
#
# The plants are the reference's patches in crates/fuzz/planted/. They are written against the
# reference's chain.rs and queue.rs, so they cannot be applied to a learner's own walker, whose
# lines differ. Instead the learner's fuzzer comes to the plant: a private copy of the
# reference's crates is made under OUT, IMPL's crates/fuzz replaces the reference's fuzzer in
# that copy, the plant is applied there, and the fuzzer is built against the planted reference
# `vmm` through the public API it already uses. Plant 0 applies nothing: it is the control,
# a fuzzer that reports a failure on correct code is wrong too.
#
# The fuzzer's interface (the lesson's Your turn): package `fuzz`, binary `fuzz`, invoked as
# `fuzz virtqueue --seconds S --seed 1`; a finding prints a line containing FAILURE or HANG and
# exits 1; a clean run exits 0. Nothing outside OUT is written; the working trees are only read.
# Prints one verdict line starting `bughunt:` and exits 0 when the verdict is the expected one.
set -euo pipefail
IFS=$'\n\t'
umask 077

die() { printf 'bughunt: %s\n' "$*"; exit 1; }

(( $# == 5 )) || die "usage: bughunt.sh REPO IMPL OUT PLANT SECONDS"
repo="$1"
impl="$2"
out="$3"
plant="$4"
seconds="$5"
[[ "$plant" =~ ^[0-3]$ ]] || die "PLANT must be 0..3"
if ! [[ "$seconds" =~ ^[0-9]+$ ]] || (( seconds == 0 )); then die "SECONDS must be a positive integer"; fi
[[ -d "$repo/crates/vmm" && -d "$repo/crates/fuzz/planted" ]] || die "$repo is not the course repository"
[[ -d "$out" ]] || die "$out does not exist"

case "$plant" in
  0) patch=""; what="control, nothing planted" ;;
  1) patch="01-chain-range-no-checked-add.patch"; what="missing checked_add" ;;
  2) patch="02-chain-no-hop-budget.patch"; what="missing hop budget" ;;
  3) patch="03-used-idx-off-by-one.patch"; what="ring-index off-by-one" ;;
esac

[[ -f "$impl/crates/fuzz/Cargo.toml" ]] \
  || die "no fuzzer to check: crates/fuzz/Cargo.toml does not exist in the implementation tree"

# The reference's crates and workspace files; then the implementation's fuzzer in place of ours.
tree="$out/tree"
mkdir -- "$tree"
cp -R -- "$repo/crates" "$tree/"
cp -- "$repo/Cargo.toml" "$repo/Cargo.lock" "$repo/rust-toolchain.toml" "$tree/"
rm -rf -- "${tree:?}/crates/fuzz"
cp -R -- "$impl/crates/fuzz" "$tree/crates/fuzz"
rm -rf -- "${tree:?}/crates/fuzz/planted" "${tree:?}/crates/fuzz/target"
if [[ -n "$patch" ]]; then
  patch -p1 --batch --forward --silent -d "$tree" < "$repo/crates/fuzz/planted/$patch" \
    || die "plant $plant ($patch) does not apply to the reference: a course bug, please report it"
fi

# Offline, and without --locked: a learner's fuzzer may depend on fewer crates than ours, which
# changes the copy's lock file (never the real one).
export CARGO_TARGET_DIR="$out/target"
log="$out/build.txt"
if ! (cd -- "$tree" && cargo build --release --offline --quiet -p fuzz) > "$log" 2>&1; then
  tail -n 20 -- "$log"
  die "plant $plant ($what): the fuzzer does not build against the reference"
fi

log="$out/fuzz.txt"
start=$SECONDS
rc=0
(cd -- "$tree" && "$CARGO_TARGET_DIR/release/fuzz" virtqueue --seconds "$seconds" --seed 1) \
  > "$log" 2>&1 || rc=$?
took=$((SECONDS - start))
finding="$(grep -E 'FAILURE|HANG' -- "$log" | head -n 1 || true)"

if (( plant == 0 )); then
  if (( rc == 0 )) && [[ -z "$finding" ]]; then
    printf 'bughunt: control: no finding in %ss on the unplanted reference (exit 0)\n' "$took"
    exit 0
  fi
  tail -n 5 -- "$log"
  die "control: the fuzzer reported a failure on the unplanted reference (exit $rc): a false positive"
fi
if (( rc == 1 )) && [[ -n "$finding" ]]; then
  printf 'bughunt: plant %s (%s) found after %ss\n' "$plant" "$what" "$took"
  printf '    %s\n' "$finding"
  exit 0
fi
tail -n 5 -- "$log"
die "plant $plant ($what) NOT found in ${took}s (exit $rc)"
