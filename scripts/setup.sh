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
optional() { # name, when it is first needed (a chapter, in learner terms), why, install hint
  printf '%s: optional: %-10s missing (needed %s: %s); install with: %s\n' \
    "$SCRIPT_NAME" "$1" "$2" "$3" "$4"
}
if command -v dtc >/dev/null 2>&1; then
  info "optional: dtc        present ($(command -v dtc))"
else
  optional dtc "from chapter 10" "golden DTS comparison" "brew install dtc"
fi
# Chapter 18: `cargo xtask mkrootfs` runs mkfs.ext4, and the rootfs_fsck_clean test runs `e2fsck -fn`
# on a guest-written image, i.e. a host parser on hostile input (SC-14). e2fsprogs has had
# memory-safety CVEs (CVE-2019-5094, CVE-2022-1304, fixed in 1.46.6), so an e2fsprogs older
# than 1.47.0 is refused. Homebrew's formula is keg-only: look in its prefix, then PATH.
e2fs=""
for c in /opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4 /usr/local/opt/e2fsprogs/sbin/mkfs.ext4; do
  if [[ -x "$c" ]]; then e2fs="$c"; break; fi
done
if [[ -z "$e2fs" ]] && command -v mkfs.ext4 >/dev/null 2>&1; then e2fs="$(command -v mkfs.ext4)"; fi
if [[ -n "$e2fs" ]]; then
  e2v="$("$e2fs" -V 2>&1 | sed -n 's/^mke2fs \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
  if [[ -z "$e2v" ]]; then
    die "cannot read the e2fsprogs version from $e2fs -V"
  fi
  IFS=. read -r e2a e2b _ <<< "$e2v"
  if [[ ! "$e2a" =~ ^[0-9]+$ ]] || [[ ! "${e2b:-0}" =~ ^[0-9]+$ ]]; then
    die "cannot read the e2fsprogs version from $e2fs -V"
  fi
  if (( e2a < 1 || (e2a == 1 && ${e2b:-0} < 47) )); then
    die "e2fsprogs $e2v at $e2fs is older than 1.47.0 (e2fsck parses guest-written images); run: brew upgrade e2fsprogs"
  fi
  # The floor protects the parser of guest-written images, e2fsck, so the e2fsck beside this
  # mkfs.ext4 is checked too (the rootfs_fsck_clean test also checks the one it runs).
  e2fsck="$(dirname "$e2fs")/e2fsck"
  if [[ -x "$e2fsck" ]]; then
    ckv="$("$e2fsck" -V 2>&1 | sed -n 's/^e2fsck \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
    if [[ -z "$ckv" ]]; then
      die "cannot read the e2fsprogs version from $e2fsck -V"
    fi
    IFS=. read -r cka ckb _ <<< "$ckv"
    if [[ ! "$cka" =~ ^[0-9]+$ ]] || [[ ! "${ckb:-0}" =~ ^[0-9]+$ ]]; then
      die "cannot read the e2fsprogs version from $e2fsck -V"
    fi
    if (( cka < 1 || (cka == 1 && ${ckb:-0} < 47) )); then
      die "e2fsck $ckv at $e2fsck is older than 1.47.0 (it parses guest-written images); run: brew upgrade e2fsprogs"
    fi
  fi
  info "optional: e2fsprogs  present ($e2v, $e2fs)"
else
  optional e2fsprogs "from chapter 18" "ext4 root filesystem image (cargo xtask mkrootfs)" "brew install e2fsprogs"
fi
if command -v xz >/dev/null 2>&1; then
  xzout="$(xz --version)"
  xzv="$(printf '%s\n' "$xzout" | head -n 1)"
  # SC-8: refuse the backdoored releases (CVE-2024-3094), both as the xz program's version and
  # as the run-time liblzma version on the second line (the backdoor lives in liblzma).
  while IFS= read -r xzline; do
    case "$xzline" in
      "xz (XZ Utils) 5.6.0"|"xz (XZ Utils) 5.6.0 "*|"xz (XZ Utils) 5.6.1"|"xz (XZ Utils) 5.6.1 "*|\
      "liblzma 5.6.0"|"liblzma 5.6.0 "*|"liblzma 5.6.1"|"liblzma 5.6.1 "*)
        die "xz release with the CVE-2024-3094 backdoor: $xzline; brew upgrade xz" ;;
    esac
  done <<< "$xzout"
  info "optional: xz         present ($xzv)"
else
  optional xz "from chapter 22" "FreeBSD .raw.xz image" "brew install xz"
fi
if command -v shellcheck >/dev/null 2>&1; then
  info "optional: shellcheck present ($(shellcheck --version | sed -n 's/^version: //p'))"
else
  optional shellcheck "by course authors only" "scripts/check.sh lint (mandatory in CI)" "brew install shellcheck"
fi

info "OK"
