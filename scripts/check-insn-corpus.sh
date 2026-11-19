#!/usr/bin/env bash
# Prove that the ISV=0 decoder corpus (crates/vmm/tests/data/insn_corpus.txt, PLAN M17) is
# honest: every <word> column is exactly what clang assembles the <assembly> column to. The
# host test `insn_decode` then checks the decoder against the hand-written <expected> column,
# so the chain "assembly -> word -> decode" is verified end to end without trusting our own
# encoder. Same method as spikes/hvf-hello/check-encodings.sh.
#
#   scripts/check-insn-corpus.sh        prints `OK: N instructions match clang`
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

corpus="$REPO_ROOT/crates/vmm/tests/data/insn_corpus.txt"
[[ -f "$corpus" ]] || die "missing corpus: $corpus"
command -v clang >/dev/null 2>&1 || die "clang not found (install the Xcode command line tools)"
xcrun --find llvm-objdump >/dev/null 2>&1 || die "llvm-objdump not found (xcrun --find llvm-objdump)"

work="$(mktemp -d)"
trap 'rm -rf -- "${work:?}"' EXIT

# Columns are separated by ' | '; comment lines start with '#'.
grep -v -e '^#' -e '^[[:space:]]*$' -- "$corpus" > "$work/lines.txt"
awk -F ' [|] ' 'NF != 3 { printf "malformed line %d: %s\n", NR, $0; bad = 1 } END { exit bad }' \
  "$work/lines.txt" >&2 || die "corpus lines must have exactly three ' | '-separated columns"
awk -F ' [|] ' '{ print $1 }' "$work/lines.txt" > "$work/ours.txt"
awk -F ' [|] ' '{ print $2 }' "$work/lines.txt" > "$work/prog.s"
grep -qvE '^[0-9a-f]{8}$' -- "$work/ours.txt" && die "every <word> must be 8 lowercase hex digits"

clang -c -target arm64-apple-macos -o "$work/prog.o" -- "$work/prog.s"
xcrun llvm-objdump -d "$work/prog.o" | awk '/^ *[0-9a-f]+: /{ print $2 }' > "$work/clang.txt"

if diff -u -- "$work/ours.txt" "$work/clang.txt" >&2; then
  printf 'OK: %s instructions match clang\n' "$(wc -l < "$work/ours.txt" | tr -d ' ')"
else
  paste -- "$work/ours.txt" "$work/clang.txt" "$work/prog.s" | awk -F '\t' '$1 != $2' >&2
  die "corpus words differ from clang's encodings"
fi
