#!/usr/bin/env bash
# Build, ad-hoc sign with ONLY com.apple.security.hypervisor, and run the spike.
# Usage: ./run.sh            run every experiment, each in its own process
#        ./run.sh <args...>  run the binary once with these args (e.g. ./run.sh gicprobe 0x4000000000 40)
set -euo pipefail
cd "$(dirname "$0")"

cargo build --release --quiet
bin="./target/release/hvf-hello"
codesign -s - --entitlements entitlements.plist -f "$bin" 2>/dev/null
codesign -d --entitlements - "$bin" 2>/dev/null | grep -q 'com.apple.security.hypervisor' \
  || { echo "entitlement missing after signing" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  exec "$bin" "$@"
fi

echo "# $(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(sysctl -n machdep.cpu.brand_string), $(rustc --version)"
for args in "info" "basic" "gic" "gicprobe 0x080A0000" "gicprobe 0x4000000000 40" "smp" "el2" "align"; do
  echo
  # shellcheck disable=SC2086  # intentional word splitting of the argument list
  "$bin" $args
done
