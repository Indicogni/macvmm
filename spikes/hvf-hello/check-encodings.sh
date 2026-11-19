#!/usr/bin/env bash
# Cross-check the hand-rolled A64 encoder against clang's assembler: every word the spike
# emits must disassemble back to the same bytes when its mnemonic is assembled by clang.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --quiet
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
./target/release/hvf-hello dump | grep -v '^#' > "$work/listing.txt"
cut -d' ' -f2- "$work/listing.txt" > "$work/prog.s"
clang -c -target arm64-apple-macos "$work/prog.s" -o "$work/prog.o"
xcrun llvm-objdump -d "$work/prog.o" | awk '/^ *[0-9a-f]+: /{print $2}' > "$work/clang.txt"
cut -d' ' -f1 "$work/listing.txt" > "$work/ours.txt"
if diff -u "$work/ours.txt" "$work/clang.txt"; then
  echo "OK: $(wc -l < "$work/ours.txt" | tr -d ' ') instructions match clang's encoding"
else
  paste "$work/ours.txt" "$work/clang.txt" "$work/prog.s" | awk '$1!=$2' >&2
  exit 1
fi
