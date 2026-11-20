#!/usr/bin/env bash
# Offline tests for scripts/fetch.sh (threat model SC-2, SC-3, SC-5, SC-10).
#
#   scripts/test-fetch.sh
#
# Each case runs fetch.sh against a temporary manifest and a temporary cache, with a stub `curl`
# first on PATH that serves files from a temporary directory and fails unless it is called with
# the mandatory HTTPS-only flags. Nothing touches the network or the real cache. Stub `xz`
# and `df` (M19) let the write-sparse derive run offline, over its cap, or on a "full" disk.
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

FETCH="$REPO_ROOT/scripts/fetch.sh"
T="$(mktemp -d "${TMPDIR:-/tmp}/macvmm-test-fetch.XXXXXX")"
trap 'rm -rf -- "${T:?}"' EXIT

mkdir -p -- "$T/bin" "$T/srv" "$T/nocargo"
printf 'hello macvmm\n' > "$T/srv/good.bin"
printf 'other bytes\n' > "$T/srv/other.bin"
GOOD="$(shasum -a 256 -- "$T/srv/good.bin")"; GOOD="${GOOD%% *}"
OTHER="$(shasum -a 256 -- "$T/srv/other.bin")"; OTHER="${OTHER%% *}"

# Stub curl: requires the SC-2 flags, serves $T/srv/<basename of URL>, logs every call.
cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$T/curl.log"
args=" \$* "
for need in " --proto =https " " --proto-redir =https " " --tlsv1.2 " " -fSL " " --max-filesize "; do
  [[ "\$args" == *"\$need"* ]] || { echo "stub curl: missing flag \$need" >&2; exit 99; }
done
out="" url=""
while (( \$# > 0 )); do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    https://*) url="\$1"; shift ;;
    *) shift ;;
  esac
done
src="$T/srv/\${url##*/}"
[[ -f "\$src" ]] || { echo "stub curl: 404 \$url" >&2; exit 22; }
cp -- "\$src" "\$out"
EOF
chmod 700 "$T/bin/curl"

# Stub xz (M19 write-sparse): logs its arguments; `--version` reports $(<xz.version) and
# liblzma $(<xz.libversion) (both default 5.8.4); when $T/xz.bytes exists, prints $(<xz.zeros)
# zero bytes then $(<xz.bytes) 'A's and exits 0; otherwise fails like xz on a file that is not
# xz. (Files, not environment variables: xtask runs xz with an environment of only PATH.)
cat > "$T/bin/xz" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$T/xz.log"
if [[ "\$1" == "--version" ]]; then printf 'xz (XZ Utils) %s\nliblzma %s\n' "\$(cat "$T/xz.version" 2>/dev/null || echo 5.8.4)" "\$(cat "$T/xz.libversion" 2>/dev/null || echo 5.8.4)"; exit 0; fi
[[ "\$1" == "-dc" && "\$2" == "--" ]] || { echo "stub xz: unexpected arguments \$*" >&2; exit 98; }
if [[ ! -f "$T/xz.bytes" ]]; then echo "xz: \$3: File format not recognized" >&2; exit 1; fi
z="\$(cat "$T/xz.zeros")"
if (( z > 0 )); then head -c "\$z" /dev/zero; fi  # macOS head refuses -c 0
yes A | tr -d '\n' | head -c "\$(cat "$T/xz.bytes")" || true
STUB
chmod 700 "$T/bin/xz"

# Stub df (M19 free-space check): reports DF_STUB_KIB available when set, else the real df.
cat > "$T/bin/df" <<STUB
#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${DF_STUB_KIB:-}" ]]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
  printf 'stub 999999999 1 %s 1%% /\n' "\$DF_STUB_KIB"
  exit 0
fi
exec /bin/df "\$@"
STUB
chmod 700 "$T/bin/df"

# Stub cargo for the "never run xtask on an unverified input" case: records and fails.
cat > "$T/nocargo/cargo" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$T/cargo.log"
exit 1
EOF
chmod 700 "$T/nocargo/cargo"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok - %s\n' "$1"; }
not_ok() { fail=$((fail + 1)); printf 'not ok - %s\n%s\n' "$1" "$2" >&2; }

# run NAME MANIFEST_TEXT ARGS... : writes the manifest, runs fetch.sh, sets $out and $rc.
run() {
  local manifest="$T/manifest.txt"
  printf '%s\n' "$1" > "$manifest"
  shift
  rc=0
  out="$(PATH="$T/bin:$PATH" MACVMM_CACHE="${CACHE_OVERRIDE:-$T/cache}" "$FETCH" --manifest "$manifest" "$@" 2>&1)" || rc=$?
}

# expect DESCRIPTION WANT_RC SUBSTRING
expect() {
  if [[ "$rc" == "$2" && "$out" == *"$3"* ]]; then
    ok "$1"
  else
    not_ok "$1" "  want rc=$2 and output containing '$3'; got rc=$rc, output:
$out"
  fi
}

U="https://example.invalid/files"

# 1. comments skipped, download verified, cached, corruption refetched.
run "# a comment line
   # indented comment
t good.bin $GOOD $U/good.bin  # trailing comment" t
expect "comment lines are skipped and a good file installs" 0 "fetch: OK good.bin $GOOD"
run "t good.bin $GOOD $U/good.bin" t
expect "second run reports cached" 0 "fetch: cached good.bin"
printf 'X' | dd of="$T/cache/good.bin" bs=1 seek=0 count=1 conv=notrunc 2>/dev/null
run "t good.bin $GOOD $U/good.bin" t
expect "a corrupted cached file is refetched" 0 "fetch: hash mismatch, refetching good.bin"
[[ "$out" == *"fetch: OK good.bin"* ]] && ok "refetched file verifies" || not_ok "refetched file verifies" "$out"

# 2. manifest validation, each reported with its line number.
run "# header
t good.bin $GOOD" t
expect "a missing field is rejected with its line number" 1 "manifest line 2: expected"
run "t good.bin $GOOD http://example.invalid/good.bin" t
expect "an http:// URL is rejected" 1 "manifest line 1: URL 'http://example.invalid/good.bin' is not https://"
run "t good.bin $GOOD file:///etc/passwd" t
expect "a file:// URL is rejected" 1 "is not https://"
run "t good.bin $GOOD $U/good.bin http://mirror.invalid/good.bin" t
expect "an http:// mirror is rejected" 1 "is not https://"
run "t good.bin ${GOOD:0:63} $U/good.bin" t
expect "a 63-character sha256 is rejected" 1 "manifest line 1: sha256"
upper="$(printf '%s' "$GOOD" | tr 'a-f' 'A-F')"
run "t good.bin $upper $U/good.bin" t
expect "an uppercase sha256 is rejected" 1 "64 lowercase hex"
run "t .. $GOOD $U/good.bin" t
expect "the name .. is rejected" 1 "invalid name '..'"
run "t . $GOOD $U/good.bin" t
expect "the name . is rejected" 1 "invalid name '.'"
run "t sub/good.bin $GOOD $U/good.bin" t
expect "a name containing / is rejected" 1 "invalid name 'sub/good.bin'"
run "t bad\$name $GOOD $U/good.bin" t
expect "a name with a shell metacharacter is rejected" 1 "invalid name"
run "t good.bin $GOOD $U/good.bin
t good.bin $GOOD $U/good.bin" t
expect "a duplicate name is rejected" 1 "manifest line 2: duplicate name"

# 3. TOFU.
run "t tofu.bin TOFU $U/good.bin" t
expect "a TOFU entry is refused without --pin" 1 "fetch: REFUSED tofu.bin"
cp -- "$T/manifest.txt" "$T/manifest.before"
run "t tofu.bin TOFU $U/good.bin" --pin tofu.bin
expect "--pin prints the sha256 and exits 1" 1 "fetch: sha256 $GOOD tofu.bin"
cmp -s -- "$T/manifest.txt" "$T/manifest.before" && ok "--pin never edits the manifest" || not_ok "--pin never edits the manifest" "manifest changed"
[[ ! -e "$T/cache/tofu.bin" && ! -e "$T/cache/tofu.bin.part" ]] && ok "--pin leaves nothing in the cache" || not_ok "--pin leaves nothing in the cache" "$(ls -la "$T/cache")"

# 4. hash mismatch on download.
run "t other.bin $GOOD $U/other.bin" t
expect "a downloaded hash mismatch fails" 1 "fetch: hash mismatch for other.bin: expected $GOOD, got $OTHER"
[[ ! -e "$T/cache/other.bin.part" && ! -e "$T/cache/other.bin" ]] && ok "the mismatching .part is deleted" || not_ok "the mismatching .part is deleted" "$(ls -la "$T/cache")"

# 5. mirrors: the first URL 404s, the mirror serves. The cached copy from case 1 is removed
#    first, otherwise fetch.sh would verify the cache and never download at all.
rm -f -- "$T/cache/good.bin"
before="$(wc -l < "$T/curl.log")"; before=$((before + 0))
run "t good.bin $GOOD $U/missing.bin $U/good.bin" t
expect "a failing primary URL falls back to the mirror and verifies" 0 "fetch: OK good.bin $GOOD"
tried="$(tail -n "+$((before + 1))" -- "$T/curl.log" | sed -e 's/.* //' | tr '\n' ' ')"
[[ "$tried" == "$U/missing.bin $U/good.bin " ]] \
  && ok "the primary URL is tried first, then the mirror" \
  || not_ok "the primary URL is tried first, then the mirror" "curl was called for: $tried"

# 6. derive: a kind xtask does not implement yet is PENDING (real `cargo xtask derive`).
run "t good.bin $GOOD $U/good.bin
t derived.bin $GOOD derive:no-such-kind:good.bin" t
expect "an unimplemented derive kind is PENDING, not a failure" 0 "fetch: PENDING derived.bin (needs cargo xtask no-such-kind, M?)"

# 6a. M19: derive:write-sparse runs `xz -dc` (the stub below) into a sparse file, capped (SC-6).
run "t good.bin $GOOD $U/good.bin
t derived.bin $GOOD derive:write-sparse:good.bin" t
expect "write-sparse of a stream xz rejects fails" 1 "fetch: FAILED derived.bin (cargo xtask derive write-sparse exited 1)"
[[ ! -e "$T/cache/derived.bin" && ! -e "$T/cache/derived.bin.part" ]] && ok "a failed write-sparse leaves nothing in the cache" || not_ok "a failed write-sparse leaves nothing in the cache" "$(ls -la "$T/cache")"
head -c 4096 /dev/zero > "$T/a.bin"; printf 'AAAA' >> "$T/a.bin"
SP_HASH="$(shasum -a 256 -- "$T/a.bin")"; SP_HASH="${SP_HASH%% *}"
xz_stub() { printf '%s' "$1" > "$T/xz.zeros"; printf '%s' "$2" > "$T/xz.bytes"; }
xz_stub 4096 4
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "write-sparse turns the xz stream into the pinned raw" 0 "fetch: OK sparse.raw $SP_HASH"
# SC-6: a stream over the cap. 2 MiB of non-zero bytes against a 1 MiB cap.
xz_stub 0 2097152
export MACVMM_SPARSE_CAP=1048576
run "t good.bin $GOOD $U/good.bin
t big.raw $GOOD derive:write-sparse:good.bin" t
expect "an xz stream over the cap fails the derive" 1 "fetch: FAILED big.raw (cargo xtask derive write-sparse exited 1)"
[[ "$out" == *"larger than the 1048576-byte cap"* ]] && ok "the cap is named in the error" || not_ok "the cap is named in the error" "$out"
[[ ! -e "$T/cache/big.raw" && ! -e "$T/cache/big.raw.part" ]] && ok "an over-cap derived file is deleted" || not_ok "an over-cap derived file is deleted" "$(ls -la "$T/cache")"
# The cached raw is re-verified, not re-derived.
xz_stub 4096 4
rm -f -- "$T/xz.log"
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "the derived sparse raw is cached on the second run" 0 "fetch: cached sparse.raw"
# A cap above 16 GiB in the environment is ignored, not an error, and the derive really runs
# under it (the cached raw is removed first). That the value can only *lower* the cap is
# proven by the unit test cap_env_can_only_lower_the_cap (crates/xtask/src/sparse.rs): a
# stream over 16 GiB is too large for this script.
rm -f -- "$T/cache/sparse.raw" "$T/xz.log"
export MACVMM_SPARSE_CAP=99999999999999
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "a cap above 16 GiB is ignored and the derive succeeds" 0 "fetch: OK sparse.raw $SP_HASH"
grep -q -- "-dc" "$T/xz.log" 2>/dev/null && ok "the derive ran xz under the oversized cap" || not_ok "the derive ran xz under the oversized cap" "$(cat "$T/xz.log" 2>/dev/null)"
unset MACVMM_SPARSE_CAP
# The free-space check runs before xz (the stub df reports 1 GiB free).
rm -f -- "$T/cache/sparse.raw" "$T/xz.log"
export DF_STUB_KIB=1048576
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "write-sparse needs 8 GiB free" 1 "fetch: FAILED sparse.raw (needs at least 8 GiB free"
[[ ! -e "$T/xz.log" ]] && ok "xz never runs when the disk is too full" || not_ok "xz never runs when the disk is too full" "$(cat "$T/xz.log")"
unset DF_STUB_KIB
# SC-8: a backdoored xz release (CVE-2024-3094) is refused before it decompresses anything.
rm -f -- "$T/xz.log"
printf '5.6.1' > "$T/xz.version"
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "xz 5.6.1 is refused" 1 "xz 5.6.1 is a CVE-2024-3094 backdoored release"
grep -q -- "-dc" "$T/xz.log" && not_ok "a refused xz never decompresses" "$(cat "$T/xz.log")" || ok "a refused xz never decompresses"
rm -f -- "$T/xz.version"
# The backdoor lives in liblzma: a clean xz program reporting a 5.6.1 liblzma is refused too.
rm -f -- "$T/xz.log"
printf '5.6.1' > "$T/xz.libversion"
run "t good.bin $GOOD $U/good.bin
t sparse.raw $SP_HASH derive:write-sparse:good.bin" t
expect "a 5.6.1 liblzma is refused" 1 "liblzma 5.6.1 is a CVE-2024-3094 backdoored release"
grep -q -- "-dc" "$T/xz.log" && not_ok "a refused liblzma never decompresses" "$(cat "$T/xz.log")" || ok "a refused liblzma never decompresses"
rm -f -- "$T/xz.libversion"
rm -f -- "$T/xz.zeros" "$T/xz.bytes"

# 6b. M9: the unzboot derive kind is real. A synthetic EFI zboot (zboot-header.S layout: MZ,
#     zimg, payload offset 0x40 and size, "gzip") around a gzip of a fake arm64 Image.
printf 'IMG' > "$T/img.bin"
dd if=/dev/zero bs=1 count=53 2>/dev/null >> "$T/img.bin"
printf 'ARM\x64' >> "$T/img.bin"
dd if=/dev/zero bs=1 count=4000 2>/dev/null >> "$T/img.bin"
IMG_HASH="$(shasum -a 256 -- "$T/img.bin")"; IMG_HASH="${IMG_HASH%% *}"
/usr/bin/gzip -9 -c -n < "$T/img.bin" > "$T/img.gz"
gzlen="$(wc -c < "$T/img.gz")"; gzlen=$((gzlen + 0))
le32() { printf "\\$(printf '%03o' $(( $1 & 255 )))\\$(printf '%03o' $(( ($1 >> 8) & 255 )))\\$(printf '%03o' $(( ($1 >> 16) & 255 )))\\$(printf '%03o' $(( ($1 >> 24) & 255 )))"; }
{
  printf 'MZ\0\0zimg'
  le32 64
  le32 "$gzlen"
  dd if=/dev/zero bs=1 count=8 2>/dev/null
  printf 'gzip'
  dd if=/dev/zero bs=1 count=36 2>/dev/null
  cat -- "$T/img.gz"
} > "$T/srv/vmlinuz.bin"
ZB="$(shasum -a 256 -- "$T/srv/vmlinuz.bin")"; ZB="${ZB%% *}"
run "t vmlinuz.bin $ZB $U/vmlinuz.bin
t Image.bin $IMG_HASH derive:unzboot:vmlinuz.bin" t
expect "derive:unzboot unwraps a verified zboot and pins the Image" 0 "fetch: OK Image.bin $IMG_HASH"
run "t vmlinuz.bin $ZB $U/vmlinuz.bin
t Image.bin $IMG_HASH derive:unzboot:vmlinuz.bin" t
expect "a derived artifact is cached on the second run" 0 "fetch: cached Image.bin"
run "t good.bin $GOOD $U/good.bin
t derived.bin $GOOD derive:unzboot:good.bin" t
expect "unzboot of a non-zboot input fails" 1 "fetch: FAILED derived.bin (cargo xtask derive unzboot exited 1)"
[[ ! -e "$T/cache/derived.bin" && ! -e "$T/cache/derived.bin.part" ]] && ok "a failed derive leaves nothing in the cache" || not_ok "a failed derive leaves nothing in the cache" "$(ls -la "$T/cache")"
run "t derived.bin $GOOD derive:unzboot:later.bin
t later.bin $GOOD $U/good.bin" t
expect "a derive input must be an earlier entry" 1 "derive input 'later.bin' is not an earlier manifest entry"
for bad_arg in ../etc/passwd a/../../b /abs/path --deps -x ./a 'a\b' 'a$b' 'a;b'; do
  run "t good.bin $GOOD $U/good.bin
t derived.bin $GOOD derive:extract-apk:good.bin:$bad_arg" t
  expect "a derive argument '$bad_arg' is rejected" 1 "manifest line 2: derive argument"
done
run "t good.bin $GOOD $U/good.bin
t derived.bin $GOOD derive:extract-apk:good.bin:usr/share/u-boot/qemu_arm64/u-boot.bin" t
# M18: extract-apk is implemented; good.bin is no gzip package, so the derive itself fails (the
# argument passed the manifest checks and reached xtask).
expect "a relative derive argument reaches extract-apk (M18), which refuses a non-apk" 1 "fetch: FAILED derived.bin (cargo xtask derive extract-apk exited 1)"

# 7. SC-5: an input whose hash mismatches never reaches xtask.
rm -f -- "$T/cargo.log"
rc=0
printf '%s\n' "t other.bin $GOOD $U/other.bin" "t derived.bin $GOOD derive:unzboot:other.bin" > "$T/manifest.txt"
out="$(PATH="$T/nocargo:$T/bin:$PATH" MACVMM_CACHE="$T/cache" "$FETCH" --manifest "$T/manifest.txt" t 2>&1)" || rc=$?
expect "a derive whose input failed verification fails" 1 "input other.bin was not verified"
[[ ! -e "$T/cargo.log" ]] && ok "xtask is never run on an unverified input" || not_ok "xtask is never run on an unverified input" "$(cat "$T/cargo.log")"

# 8. SC-3: cache directory checks.
mkdir -p -- "$T/realcache"
ln -s -- "$T/realcache" "$T/linkcache"
CACHE_OVERRIDE="$T/linkcache" run "t good.bin $GOOD $U/good.bin" t
expect "a symlinked cache dir is refused" 1 "is a symlink"
mkdir -p -- "$T/gwcache" && chmod 770 "$T/gwcache"
CACHE_OVERRIDE="$T/gwcache" run "t good.bin $GOOD $U/good.bin" t
expect "a group-writable cache dir is refused" 1 "group- or world-writable"
chmod 707 "$T/gwcache"
CACHE_OVERRIDE="$T/gwcache" run "t good.bin $GOOD $U/good.bin" t
expect "a world-writable cache dir is refused" 1 "group- or world-writable"
CACHE_OVERRIDE="$T/fresh/nested" run "t good.bin $GOOD $U/good.bin" t
mode="$(stat -f '%Lp' -- "$T/fresh/nested" 2>/dev/null || echo none)"
[[ "$rc" == 0 && "$mode" == 700 ]] && ok "a new cache dir is created 0700" || not_ok "a new cache dir is created 0700" "rc=$rc mode=$mode"

# 9. unknown set.
run "t good.bin $GOOD $U/good.bin" nosuchset
expect "an unknown set fails" 1 "fetch: unknown set nosuchset"

# 10. every stub curl call carried the HTTPS-only flags (the stub also exits 99 otherwise).
#     Every line of the log (all cases above) must carry the flags, not just one of them.
if [[ -s "$T/curl.log" ]] \
    && ! grep -v -- "--proto =https --proto-redir =https --tlsv1.2" "$T/curl.log" | grep -q .; then
  ok "curl is always called HTTPS-only with --tlsv1.2"
else
  not_ok "curl is always called HTTPS-only with --tlsv1.2" "$(cat "$T/curl.log")"
fi

if (( fail > 0 )); then
  printf 'TEST-FETCH FAILED: %s of %s cases\n' "$fail" "$((pass + fail))" >&2
  exit 1
fi
printf 'TEST-FETCH OK: %s cases\n' "$pass"
