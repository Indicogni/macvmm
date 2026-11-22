#!/usr/bin/env bash
# The ABI oracle (ADR-0002 item 3, PLAN M1): do crates/hvf/src/ffi.rs and the SDK headers agree?
#
#   scripts/check-ffi.sh            full check (scripts/check.sh runs this)
#   scripts/check-ffi.sh --subset   only "everything Rust declares matches the headers"; for
#                                   course checkpoints where a learner has declared a few items
#
# How:
#   1. clang compiles crates/hvf/abi/abi_dump.c against the real headers with
#      -mmacosx-version-min=15.0 -Werror=unguarded-availability-new, so naming a function newer
#      than the macOS 15.0 baseline in its static list is a compile error. Its output is what the
#      compiler says each constant, type size/alignment, field offset and function is.
#   2. `cargo run -p hvf --example abi_dump` prints the same lines from the Rust declarations.
#   3. The two (sorted) outputs must be identical.
#   4. Completeness: every `pub const`, `pub type`, `pub struct` and `pub fn` in ffi.rs must appear
#      in the Rust output, so a new declaration cannot skip the comparison.
#   5. Each optional (dlsym) function must exist in the SDK with exactly the availability that
#      crates/hvf/src/optional.rs claims: compiling a reference at that release is clean, one
#      release earlier is an availability error.
# Nothing here downloads or runs anything but our own two programs.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

subset=0
for arg in "$@"; do
  case "$arg" in
    --subset) subset=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

cd -- "$REPO_ROOT"
command -v xcrun >/dev/null 2>&1 || die "xcrun not found: install the Xcode command line tools"
sdk="$(xcrun --show-sdk-path)" || die "xcrun --show-sdk-path failed"
[[ -d "$sdk/System/Library/Frameworks/Hypervisor.framework/Headers" ]] \
  || die "no Hypervisor.framework headers under $sdk"

# The oracle compares ffi.rs with the headers it was written from: the macOS 27 SDK. An older SDK
# lacks the newest constants and types (hv_tlbi_op_t, for one), so abi_dump.c cannot compile
# against it. That says nothing about ffi.rs, so it is a skip, not a failure: exit 77, which
# scripts/check.sh counts as a SKIP (and --strict turns into a failure). macvmm itself still
# builds and runs on such a Mac: the newer functions are looked up at run time (optional.rs).
readonly OLDEST_ORACLE_SDK=27
# Read from the SDK directory we will compile against, so the answer is about that SDK even when
# SDKROOT points somewhere `xcrun --show-sdk-version` cannot look up.
sdk_version="$(plutil -extract Version raw -o - -- "$sdk/SDKSettings.json")" \
  || die "cannot read the SDK version from $sdk/SDKSettings.json"
sdk_major="${sdk_version%%.*}"
[[ "$sdk_major" =~ ^[0-9]+$ ]] || die "unexpected SDK version '$sdk_version'"
if (( sdk_major < OLDEST_ORACLE_SDK )); then
  printf 'check-ffi: the macOS %s SDK is older than %s, the SDK ffi.rs is checked against; not run\n' \
    "$sdk_version" "$OLDEST_ORACLE_SDK" >&2
  exit 77
fi

tmp="$(mktemp -d)"
trap 'rm -rf -- "${tmp:?}"' EXIT

# ANCHOR: check_ffi_compare
# 1. The compiler's view.
xcrun clang -target arm64-apple-macos15.0 -isysroot "$sdk" \
  -std=c11 -Wall -Wextra -Werror -Wunguarded-availability-new \
  -o "$tmp/abi_dump" -- crates/hvf/abi/abi_dump.c \
  || die "abi_dump.c does not compile against the SDK (a renamed item, or a static function newer than macOS 15.0?)"
"$tmp/abi_dump" | LC_ALL=C sort > "$tmp/c.txt"

# 2. The Rust declarations' view.
cargo run --locked --quiet -p hvf --example abi_dump | LC_ALL=C sort > "$tmp/rust.txt"

# 3. Compare.
if (( subset )); then
  missing="$(LC_ALL=C comm -23 -- "$tmp/rust.txt" "$tmp/c.txt")"
  if [[ -n "$missing" ]]; then
    printf '%s\n' "$missing" >&2
    die "FFI MISMATCH: the lines above (from Rust) are not what the SDK headers say"
  fi
elif ! diff -u -- "$tmp/c.txt" "$tmp/rust.txt" > "$tmp/diff.txt"; then
  cat -- "$tmp/diff.txt" >&2
  die "FFI MISMATCH: '-' lines are the SDK headers (clang), '+' lines are ffi.rs (Rust)"
fi
# ANCHOR_END: check_ffi_compare

# 4. Completeness of the Rust dump against ffi.rs itself.
if (( ! subset )); then
  ffi=crates/hvf/src/ffi.rs
  unlisted=0
  check_listed() { # <kind-prefix> <name> [<suffix>]
    if ! grep -qxF -- "$1$2${3:-}" "$tmp/rust.txt" && ! grep -qF -- "$1$2${3:-}=" "$tmp/rust.txt"; then
      warn "$ffi declares $2, but examples/abi_dump.rs does not print it"
      unlisted=$((unlisted + 1))
    fi
  }
  while IFS= read -r name; do check_listed 'const ' "$name"; done \
    < <(sed -n 's/^pub const \([A-Za-z0-9_]*\):.*/\1/p' "$ffi")
  while IFS= read -r name; do check_listed 'size ' "$name"; done \
    < <(sed -n 's/^pub type \([A-Za-z0-9_]*\) .*/\1/p; s/^pub struct \([A-Za-z0-9_]*\)[ (].*/\1/p' "$ffi")
  while IFS= read -r name; do check_listed 'fn ' "$name"; done \
    < <(sed -n 's/^ *pub fn \([a-z0-9_]*\)(.*/\1/p' "$ffi")
  (( unlisted == 0 )) || die "$unlisted declaration(s) escape the comparison"
fi

# 5. Optional symbols: present in the SDK, with exactly the claimed availability.
release_before() { # 15.2 -> 15.1, 27.0 -> 26.9, and 26.0 -> 15.7 (macOS went from 15 to 26)
  local major="${1%%.*}" minor="${1#*.}"
  if (( minor > 0 )); then
    printf '%s.%s\n' "$major" "$((minor - 1))"
  elif (( major == 26 )); then
    printf '15.7\n'
  else
    printf '%s.9\n' "$((major - 1))"
  fi
}
optional_count=0
while IFS= read -r since; do
  names=()
  while IFS= read -r n; do names+=("$n"); done \
    < <(sed -n "s/^optional \([a-z0-9_]*\) since=${since//./\\.}\$/\1/p" "$tmp/rust.txt")
  {
    printf '#include <Hypervisor/Hypervisor.h>\nint main(void) {\n'
    for n in "${names[@]}"; do printf '  (void)sizeof(&%s);\n' "$n"; done
    printf '  return 0;\n}\n'
  } > "$tmp/opt.c"
  xcrun clang -target "arm64-apple-macos$since" -isysroot "$sdk" -Werror=unguarded-availability-new \
    -fsyntax-only -- "$tmp/opt.c" 2> "$tmp/opt.err" \
    || { cat -- "$tmp/opt.err" >&2; die "optional symbols claimed for macOS $since are not available there"; }
  before="$(release_before "$since")"
  xcrun clang -target "arm64-apple-macos$before" -isysroot "$sdk" -Wunguarded-availability-new \
    -fsyntax-only -- "$tmp/opt.c" 2> "$tmp/opt.err" || true
  for n in "${names[@]}"; do
    grep -qF -- "'$n' is only available on macOS $since or newer" "$tmp/opt.err" \
      || die "$n: the SDK does not say 'introduced in macOS $since' (optional.rs claims it)"
    optional_count=$((optional_count + 1))
  done
done < <(sed -n 's/^optional [a-z0-9_]* since=\([0-9.]*\)$/\1/p' "$tmp/rust.txt" | sort -u)

n_const="$(grep -c '^const ' -- "$tmp/rust.txt" || true)"
n_layout="$(grep -cE '^(size|offset) ' -- "$tmp/rust.txt" || true)"
n_fn="$(grep -c '^fn ' -- "$tmp/rust.txt" || true)"
printf 'FFI OK: %s functions linked at the macOS 15.0 baseline, %s optional (dlsym) with matching availability\n' \
  "$n_fn" "$optional_count"
printf 'FFI OK: %s constants, %s layouts match the SDK headers\n' "$n_const" "$n_layout"
