#!/usr/bin/env bash
# Check (and, for the Rust toolchain only, complete) the development prerequisites.
#
#   scripts/setup.sh
#
# Required: Apple Silicon (arm64), macOS >= 15.0 (the in-kernel GICv3, decision D7), the Xcode
# command line tools (clang, codesign, otool), rustup. It adds the pinned toolchain's
# components and the bare-metal guest target idempotently. It never installs anything else:
# optional Homebrew tools are reported with the milestone that needs them and the install line.
# Ends with `setup: OK`. Safe to run repeatedly.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

TOOLCHAIN="$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$REPO_ROOT/rust-toolchain.toml")"
[[ -n "$TOOLCHAIN" ]] || die "cannot read the channel from rust-toolchain.toml"

# --- required --------------------------------------------------------------------------------
[[ "$(uname -s)" == "Darwin" ]] || die "macvmm needs macOS (found $(uname -s))"
[[ "$(uname -m)" == "arm64" ]] || die "macvmm needs Apple Silicon (arm64); found $(uname -m)"
info "host: arm64"

version="$(sw_vers -productVersion)"
major="${version%%.*}"
[[ "$major" =~ ^[0-9]+$ ]] || die "cannot parse macOS version '$version'"
(( major >= 15 )) || die "macOS $version is too old: macvmm needs 15.0 or later (hv_gic_create, decision D7)"
info "macOS: $version"

xcode-select -p >/dev/null 2>&1 || die "Xcode command line tools missing: run xcode-select --install"
for tool in clang codesign otool; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found: run xcode-select --install"
done
info "clang: $(clang --version | head -n 1)"

command -v rustup >/dev/null 2>&1 || die "rustup not found: install it from https://rustup.rs"
# Idempotent: rustup reports "up to date" when the item is already present.
(cd -- "$REPO_ROOT" && rustup toolchain install "$TOOLCHAIN" --profile minimal >/dev/null 2>&1) \
  || die "rustup could not install toolchain $TOOLCHAIN"
rustup component add --toolchain "$TOOLCHAIN" rustfmt clippy llvm-tools >/dev/null 2>&1 \
  || die "rustup could not add rustfmt/clippy/llvm-tools to $TOOLCHAIN"
rustup target add --toolchain "$TOOLCHAIN" aarch64-unknown-none >/dev/null 2>&1 \
  || die "rustup could not add the aarch64-unknown-none target to $TOOLCHAIN"
info "rust: $(cd -- "$REPO_ROOT" && rustc --version) with rustfmt, clippy, llvm-tools, aarch64-unknown-none"

# --- optional (never installed here) ---------------------------------------------------------
optional() { # name, milestone, why, install hint
  printf '%s: optional: %-10s missing (needed from %s: %s); install with: %s\n' \
    "$SCRIPT_NAME" "$1" "$2" "$3" "$4"
}
if command -v dtc >/dev/null 2>&1; then
  info "optional: dtc        present ($(command -v dtc))"
else
  optional dtc M7 "golden DTS comparison" "brew install dtc"
fi
e2fs="/opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4"
if command -v mkfs.ext4 >/dev/null 2>&1 || [[ -x "$e2fs" ]]; then
  info "optional: e2fsprogs  present"
else
  optional e2fsprogs M15 "ext4 root filesystem image" "brew install e2fsprogs"
fi
if command -v xz >/dev/null 2>&1; then
  xzv="$(xz --version | head -n 1)"
  # SC-8: refuse the backdoored releases (CVE-2024-3094).
  case "$xzv" in
    *" 5.6.0"*|*" 5.6.1"*) die "xz release with the CVE-2024-3094 backdoor: $xzv; brew upgrade xz" ;;
  esac
  info "optional: xz         present ($xzv)"
else
  optional xz M19 "FreeBSD .raw.xz image" "brew install xz"
fi
if command -v shellcheck >/dev/null 2>&1; then
  info "optional: shellcheck present ($(shellcheck --version | sed -n 's/^version: //p'))"
else
  optional shellcheck M0 "scripts/check.sh lint (mandatory in CI)" "brew install shellcheck"
fi

info "OK"
