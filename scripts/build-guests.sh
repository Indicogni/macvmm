#!/usr/bin/env bash
# Build the bare-metal test guests (PLAN M3) and their flat binaries.
#
#   scripts/build-guests.sh
#
# 1. `cargo build --release` from *inside* guests/ (cargo reads guests/.cargo/config.toml, which
#    selects aarch64-unknown-none, relative to the cwd), into target/guests/.
# 2. `llvm-objcopy -O binary` each ELF into <name>.bin, for `--raw <name>.bin@0x40080000`. The
#    tool is rustup's (component llvm-tools, rust-toolchain.toml): no cross toolchain needed.
# Prints `built N guests`. Nothing is downloaded (cargo --locked --offline; no dependencies).
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "unknown option $arg" ;;
  esac
done

target="$(target_dir)/guests"
sysroot="$(cd -- "$REPO_ROOT/guests" && rustc --print sysroot)"
host="$(cd -- "$REPO_ROOT/guests" && rustc -vV | sed -n 's/^host: //p')"
objcopy="$sysroot/lib/rustlib/$host/bin/llvm-objcopy"
[[ -x "$objcopy" ]] || die "missing $objcopy: run 'rustup component add llvm-tools'"

(cd -- "$REPO_ROOT/guests" && cargo build --locked --offline --release --target-dir "$target")

out="$target/aarch64-unknown-none/release"
# The guest names are the [[bin]] names of guests/Cargo.toml.
names=()
while IFS= read -r name; do
  names+=("$name")
done < <(awk '/^\[\[bin\]\]/{b=1; next} b && /^name *=/{gsub(/"/, "", $3); print $3; b=0}' \
  "$REPO_ROOT/guests/Cargo.toml")
(( ${#names[@]} > 0 )) || die "no [[bin]] entries in guests/Cargo.toml"

for name in "${names[@]}"; do
  elf="$out/$name"
  [[ -f "$elf" ]] || die "cargo did not produce $elf"
  "$objcopy" -O binary -- "$elf" "$elf.bin"
  [[ -s "$elf.bin" ]] || die "empty flat binary $elf.bin"
done
printf 'built %s guests\n' "${#names[@]}"
