#!/usr/bin/env bash
# Download (or derive) pinned artifacts into the cache, verifying every byte by sha256.
#
#   scripts/fetch.sh [--manifest FILE] SET...     fetch every entry of each set
#   scripts/fetch.sh [--manifest FILE] --pin NAME print the sha256 of NAME for pinning; exit 1
#
# Rules (threat model SC-2..SC-5, PLAN §0.4):
# - HTTPS only, redirects included; never -k; a size cap on every transfer.
# - The file lands as <cache>/<name>.part, is hashed with `shasum -a 256`, compared exactly
#   (64 lowercase hex), and only then renamed. A mismatch deletes it and fails.
# - A cached file is re-hashed on every run; a bad one is deleted and fetched again.
# - Nothing downloaded is executed, sourced, chmod +x'ed, mounted or opened (SC-4).
# - Verify before parse (SC-5): `derive:` entries run `cargo xtask derive` only on inputs whose
#   hash matched in this run. A kind xtask does not implement yet exits 64 and is reported as
#   PENDING without failing the run.
# - TOFU entries are refused until pinned (SC-10).
# - The `linux` set ends by building initramfs-test.img from the verified initramfs-virt and
#   scripts/initramfs/init (PLAN M9; hash printed, not pinned).
# Works with macOS's /bin/bash 3.2 (no associative arrays).
set -euo pipefail
IFS=$'\n\t'
umask 077
# shellcheck source=scripts/lib/common.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"

MANIFEST="$REPO_ROOT/scripts/fetch-manifest.txt"
# Largest single download we accept: the FreeBSD .raw.xz is ~600 MB (guest-boot.md §5).
MAX_DOWNLOAD_BYTES=4294967296
EX_PENDING=64

usage() {
  printf 'usage: scripts/fetch.sh [--manifest FILE] SET...\n       scripts/fetch.sh [--manifest FILE] --pin NAME\n' >&2
  exit 2
}

pin=""
sets=()
while (( $# > 0 )); do
  case "$1" in
    --manifest) (( $# >= 2 )) || usage; MANIFEST="$2"; shift 2 ;;
    --pin) (( $# >= 2 )) || usage; pin="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) printf 'fetch: unknown option %s\n' "$1" >&2; usage ;;
    *) sets+=("$1"); shift ;;
  esac
done
if [[ -z "$pin" ]] && (( ${#sets[@]} == 0 )); then usage; fi
[[ -f "$MANIFEST" ]] || die "manifest $MANIFEST not found"

# ---------------------------------------------------------------------------------------------
# Parse and validate the whole manifest first: one bad line rejects the run (SC-2).
E_LINE=(); E_SET=(); E_NAME=(); E_HASH=(); E_SRC=(); E_MIRRORS=()
NAMES=$'\n'
bad=0
reject() { printf 'fetch: manifest line %s: %s\n' "$1" "$2" >&2; bad=1; }

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$1" != "." ]] && [[ "$1" != ".." ]]
}

lineno=0
while IFS= read -r raw || [[ -n "$raw" ]]; do
  lineno=$((lineno + 1))
  line="${raw%%#*}"
  # Split on spaces and tabs into fields.
  IFS=$' \t' read -r -a f <<< "$line" || true
  (( ${#f[@]} == 0 )) && continue
  if (( ${#f[@]} < 4 )); then reject "$lineno" "expected '<set> <name> <sha256|TOFU> <source>' (missing field)"; continue; fi
  set_="${f[0]}" name="${f[1]}" hash="${f[2]}" src="${f[3]}"
  [[ "$set_" =~ ^[a-z0-9-]+$ ]] || { reject "$lineno" "invalid set name '$set_'"; continue; }
  valid_name "$name" || { reject "$lineno" "invalid name '$name' (must match ^[A-Za-z0-9._-]+\$, not . or ..)"; continue; }
  if [[ "$hash" != "TOFU" ]] && ! [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
    reject "$lineno" "sha256 for '$name' must be 64 lowercase hex characters or TOFU"; continue
  fi
  case "$NAMES" in *$'\n'"$name"$'\n'*) reject "$lineno" "duplicate name '$name'"; continue ;; esac
  mirrors=""
  if [[ "$src" == derive:* ]]; then
    IFS=':' read -r -a d <<< "$src" || true
    if (( ${#d[@]} < 3 || ${#d[@]} > 4 )) || ! [[ "${d[1]}" =~ ^[a-z][a-z0-9-]*$ ]]; then
      reject "$lineno" "derive source must be derive:<kind>:<input>[:<arg>]"; continue
    fi
    # The optional <arg> (for example an archive member path) reaches `cargo xtask derive`
    # verbatim, so it gets the same whitelist treatment as every other field: a relative path of
    # safe characters, no `..` component, not starting with `/` or `-` (never an option).
    if (( ${#d[@]} == 4 )); then
      darg="${d[3]}"
      if ! [[ "$darg" =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] \
          || [[ "/$darg/" == *"/../"* || "/$darg/" == *"/./"* || "$darg" == *//* ]]; then
        reject "$lineno" "derive argument '$darg' must be a relative path of [A-Za-z0-9._/-] with no '.' or '..' component, not starting with '-'"; continue
      fi
    fi
    case "$NAMES" in
      *$'\n'"${d[2]}"$'\n'*) ;;
      *) reject "$lineno" "derive input '${d[2]}' is not an earlier manifest entry"; continue ;;
    esac
    (( ${#f[@]} == 4 )) || { reject "$lineno" "a derive entry takes no mirror URLs"; continue; }
  else
    ok=1
    # Index loop, not "${f[@]:3}": bash 3.2 joins array slices into one word when IFS lacks a space.
    for (( k = 3; k < ${#f[@]}; k++ )); do
      u="${f[$k]}"
      [[ "$u" == https://* ]] || { reject "$lineno" "URL '$u' is not https:// (SC-2)"; ok=0; break; }
      [[ "$u" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~%+/-]*)?$ ]] || { reject "$lineno" "URL '$u' has unexpected characters"; ok=0; break; }
      (( k > 3 )) && mirrors="$mirrors$u"$'\t'
    done
    (( ok )) || continue
  fi
  E_LINE+=("$lineno"); E_SET+=("$set_"); E_NAME+=("$name"); E_HASH+=("$hash"); E_SRC+=("$src"); E_MIRRORS+=("$mirrors")
  NAMES="$NAMES$name"$'\n'
done < "$MANIFEST"
(( bad == 0 )) || die "manifest $MANIFEST rejected"

CACHE="$(cache_dir)"

# ---------------------------------------------------------------------------------------------
sha256_of() {
  local out
  out="$(shasum -a 256 -- "$1")"
  printf '%s\n' "${out%% *}"
}

VERIFIED=$'\n'
is_verified() { case "$VERIFIED" in *$'\n'"$1"$'\n'*) return 0 ;; esac; return 1; }
mark_verified() { VERIFIED="$VERIFIED$1"$'\n'; }

# download URL... into $1 (a .part path). Tries each URL in turn. Never follows to http.
download() {
  local part="$1" u progress="--silent"
  shift
  # A progress bar on a terminal; silence in logs (errors still print: -S).
  [[ -t 2 ]] && progress="--progress-bar"
  for u in "$@"; do
    [[ -n "$u" ]] || continue
    rm -f -- "$part"
    if curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fSL --retry 3 --retry-all-errors \
        --max-filesize "$MAX_DOWNLOAD_BYTES" "$progress" -o "$part" "$u"; then
      return 0
    fi
    warn "download failed: $u"
  done
  rm -f -- "$part"
  return 1
}

# ANCHOR: fetch_verify
# Move $part to $dest only if its sha256 equals the pinned $want; otherwise delete it.
verify_and_install() {
  local part="$1" dest="$2" want="$3" name="$4" got
  got="$(sha256_of "$part")"
  if [[ "$got" != "$want" ]]; then
    rm -f -- "$part"
    printf 'fetch: hash mismatch for %s: expected %s, got %s\n' "$name" "$want" "$got" >&2
    return 1
  fi
  mv -f -- "$part" "$dest"
  printf 'fetch: OK %s %s\n' "$name" "$got"
}
# ANCHOR_END: fetch_verify

# Build a derive: entry's output into $part. Returns 0 (built), 64 (pending) or 1 (failed).
run_derive() {
  local i="$1" part="$2" kind input arg out rc
  IFS=':' read -r -a d <<< "${E_SRC[$i]}" || true
  kind="${d[1]}" input="${d[2]}" arg="${d[3]:-}"
  if ! is_verified "$input"; then
    printf 'fetch: FAILED %s (input %s was not verified in this run; fetch its set first, SC-5)\n' "${E_NAME[$i]}" "$input" >&2
    return 1
  fi
  rm -f -- "$part"
  rc=0
  out="$(cd -- "$REPO_ROOT" && cargo run --locked --quiet -p xtask -- derive -- "$kind" "$CACHE/$input" "$part" ${arg:+"$arg"})" || rc=$?
  if (( rc == EX_PENDING )); then
    rm -f -- "$part"
    local ms="${out#pending }"
    printf 'fetch: PENDING %s (needs cargo xtask %s, %s)\n' "${E_NAME[$i]}" "$kind" "${ms:-M?}"
    return "$EX_PENDING"
  fi
  if (( rc != 0 )) || [[ ! -f "$part" ]]; then
    rm -f -- "$part"
    printf 'fetch: FAILED %s (cargo xtask derive %s exited %s)\n' "${E_NAME[$i]}" "$kind" "$rc" >&2
    return 1
  fi
  return 0
}

# Produce entry $i into $part from its source (download or derive).
produce() {
  local i="$1" part="$2"
  if [[ "${E_SRC[$i]}" == derive:* ]]; then
    run_derive "$i" "$part"
  else
    local urls=("${E_SRC[$i]}")
    local m
    IFS=$'\t' read -r -a m <<< "${E_MIRRORS[$i]}" || true
    if (( ${#m[@]} > 0 )); then urls+=("${m[@]}"); fi
    download "$part" "${urls[@]}" || { printf 'fetch: FAILED %s (download)\n' "${E_NAME[$i]}" >&2; return 1; }
  fi
}

fetch_entry() {
  local i="$1"
  local name="${E_NAME[$i]}" want="${E_HASH[$i]}"
  local dest="$CACHE/$name" part="$CACHE/$name.part"
  if [[ "$want" == "TOFU" ]]; then
    printf 'fetch: REFUSED %s (TOFU hash: run scripts/fetch.sh --pin %s and paste the hash into the manifest, SC-10)\n' "$name" "$name" >&2
    return 1
  fi
  if [[ -L "$dest" ]]; then
    die "refusing symlink in cache: $dest"
  fi
  if [[ -f "$dest" ]]; then
    if [[ "$(sha256_of "$dest")" == "$want" ]]; then
      printf 'fetch: cached %s\n' "$name"
      mark_verified "$name"
      return 0
    fi
    printf 'fetch: hash mismatch, refetching %s\n' "$name"
    rm -f -- "$dest"
  fi
  local rc=0
  produce "$i" "$part" || rc=$?
  if (( rc == EX_PENDING )); then return 0; fi
  (( rc == 0 )) || return 1
  verify_and_install "$part" "$dest" "$want" "$name" || return 1
  mark_verified "$name"
}

# ---------------------------------------------------------------------------------------------
if [[ -n "$pin" ]]; then
  for i in "${!E_NAME[@]}"; do
    [[ "${E_NAME[$i]}" == "$pin" ]] || continue
    part="$CACHE/$pin.part"
    if [[ "${E_SRC[$i]}" == derive:* ]]; then
      # A derived pin needs its (pinned) input verified first.
      IFS=':' read -r -a d <<< "${E_SRC[$i]}" || true
      for j in "${!E_NAME[@]}"; do
        [[ "${E_NAME[$j]}" == "${d[2]}" ]] && { fetch_entry "$j" || die "input ${d[2]} failed"; }
      done
    fi
    rc=0
    produce "$i" "$part" || rc=$?
    (( rc == 0 )) || exit 1
    printf 'fetch: sha256 %s %s\n' "$(sha256_of "$part")" "$pin"
    rm -f -- "$part"
    printf 'fetch: paste this hash into %s (the manifest is never edited by this script)\n' "$(basename -- "$MANIFEST")" >&2
    exit 1
  done
  die "no manifest entry named '$pin'"
fi

# ANCHOR: fetch_build_initramfs
# The `linux` set also builds the test initramfs (PLAN M9): Alpine's verified initramfs-virt
# with our /init appended as an uncompressed cpio overlay (`cargo xtask mkinitramfs`). It is
# built from tracked sources, so its hash is printed, not pinned (PLAN §0.4). SC-5: it runs
# only on an initramfs-virt whose hash matched in this run.
build_initramfs() {
  local base="$CACHE/initramfs-virt" out="$CACHE/initramfs-test.img" part rc=0
  part="$out.part"
  if ! is_verified initramfs-virt; then
    printf 'fetch: FAILED initramfs-test.img (initramfs-virt was not verified in this run, SC-5)\n' >&2
    return 1
  fi
  rm -f -- "$part"
  (cd -- "$REPO_ROOT" && cargo run --locked --quiet -p xtask -- mkinitramfs \
      --base "$base" --init "$REPO_ROOT/scripts/initramfs/init" --out "$part") >/dev/null || rc=$?
  if (( rc != 0 )) || [[ ! -f "$part" ]]; then
    rm -f -- "$part"
    printf 'fetch: FAILED initramfs-test.img (cargo xtask mkinitramfs exited %s)\n' "$rc" >&2
    return 1
  fi
  mv -f -- "$part" "$out"
  printf 'fetch: built initramfs-test.img sha256=%s\n' "$(sha256_of "$out")"
}
# ANCHOR_END: fetch_build_initramfs

failed=0
for s in "${sets[@]}"; do
  found=0
  for i in "${!E_NAME[@]}"; do
    [[ "${E_SET[$i]}" == "$s" ]] || continue
    found=1
    fetch_entry "$i" || failed=1
  done
  (( found )) || { printf 'fetch: unknown set %s\n' "$s" >&2; failed=1; }
  if [[ "$s" == linux ]] && (( found )) && (( failed == 0 )); then
    build_initramfs || failed=1
  fi
done
exit "$failed"
