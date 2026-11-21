# Lead decisions (answers to docs/PLAN.md §3)

Decided by the project lead on 2026-11-18. Items marked **(provisional — owner to confirm)** are
reasonable defaults the repository owner may override.

| # | Decision |
|---|---|
| D1 | Code: dual **MIT OR Apache-2.0** (Rust ecosystem norm, friendly to future productization). Course prose & diagrams: **CC BY 4.0**. **(provisional — owner to confirm)** |
| D2 | No third-party mirror. Pin exact *versioned* upstream URLs + sha256 in `scripts/fetch-manifest.txt`; on hash mismatch, fail loudly with instructions. Cache in `./.cache` (gitignored). |
| D3 | Allowed: IPSW download for the M20 companion uses Apple's HTTPS URL as returned by Virtualization.framework (`VZMacOSRestoreImage.fetchLatestSupported`), trust-on-first-use, size + sha256 printed and recorded. Opt-in only, never run by default tests. |
| D4 | M21 scope: load `AVPBooter.vmapple2.bin` **from the system path at runtime** (never copied into the repo or cache, never redistributed), and only log its first device accesses. No reverse-engineering writeups of Apple code beyond the device-access trace. |
| D5 | Keep M13 virtio-console as optional; do it after M14 if time allows. |
| D6 | Accept the architecture §19 corrections; update CLAUDE.md timer line (done) and the course text when authoring. |
| D7 | Hardware floor: Apple Silicon (M1 or later) on macOS 15+ (needs `hv_gic_create`). Document it; no fallback userspace GIC in v1. |
| D8 | Approved: `brew install e2fsprogs` (keg-only) as an *optional* tool checked by `scripts/setup.sh`; everything required for Gate G1 works without it. |
| D9 | Accept: checkpoint `expected/*` files use marker syntax, not regexes. |
| D10 | Accept: lifelines copy reference files. |
| D11 | Accept: `--net unixgram:LOCAL[,peer=REMOTE]`. |
| D12 | Accept default: split `GuestMemoryOrdered`; no `get_slice`. |
| D13 | Accept default: implement `--irqchip none` in M8 Part A (hidden teaching flag). |
| D14 | Accept: hardened runtime if the M0 probe shows HVF works under `-o runtime`. |
| D15 | Accept: `--sandbox` becomes default after M22 only if the self-test passes on SMP, reboot and blk. |
| D16 | Accept: CLAUDE.md wording updated (see Security rules). |

## Phase 1 execution decisions (2026-11-18)

| # | Decision |
|---|---|
| D19 | M2 accepted by the lead. Its own gates and on-machine tests pass; `check.sh` failed only on `backend/ansi.rs`, a leftover of an aborted M3 run that M3 now owns and must fix. |
| D20 | MEM-9: `vm.rs` teardown uses `Arc::try_unwrap` and *leaks* still-shared guest RAM (returning `Err(Internal)`) instead of a `debug_assert!` on `strong_count`. Accepted as stricter (works in release, never frees memory a thread may use). PLAN M2 text is superseded by this. |

## Owner decisions (2026-11-20)
| # | Decision |
|---|---|
| D21 | Resolves D15: `--sandbox` becomes the **default**, with `--no-sandbox` to opt out (for debugging). Before committing the switch, every e2e suite must pass with it on. Chapter 25 is updated to teach the default and the opt-out. |
| D22 | Confirms D1: code is MIT OR Apache-2.0; course text is CC BY 4.0. No longer provisional. |
| D23 | Confirms D7: the supported floor is macOS 15+ on Apple Silicon M1 or later. The landing page and README say only macOS 27.2 on an M5 Pro was tested, and older versions are expected to work. |
| D24 | Publishing: the site is built and checked locally. The Worker is deployed, and the card added to indicogni-site, only after the owner approves a local preview. |
