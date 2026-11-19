# macOS guest work: observed status

**Claims policy (ADR-0008 decision 1).** Nothing here says that macvmm, or vz-mac, boots macOS
unless a captured transcript shows a macOS login or shell. Progress is recorded only as
`observed X; blocked at Y` lines, each with its evidence. Machine for every entry below: Apple
M5 Pro, macOS 27.2.1 (build 26B131), Virtualization.framework `CFBundleVersion` 308.2.7, Swift
6.4.2.

## S0: vz-mac (PLAN M20)

| Date | Line | Evidence |
|---|---|---|
| 2026-11-18 | **observed** ad-hoc signing with only `com.apple.security.virtualization`, plus the hardened runtime (`flags=0x10002(adhoc,runtime)`), is **sufficient** for VZ: Linux configurations validate and a Linux guest boots and powers off. Risk R13 is closed for Linux guests. | `tools/vz-mac/test.sh` steps 2 and 4; the Linux boots below |
| 2026-11-18 | **observed** without the entitlement, VZ refuses at configuration time: `Invalid virtual machine configuration. The process doesn’t have the “com.apple.security.virtualization” entitlement. [VZErrorDomain 2]` (vz-mac exit 1). | `test.sh` step 3 (`vz_breaks_without_entitlement`) |
| 2026-11-18 | **observed** `vz-mac linux` boots Alpine's 6.18.60 `Image` (byte-identical to the pinned `Image-virt`, sha256 `a2cecb9b…`) with Alpine's `initramfs-virt` and `console=hvc0`: kernel log on `hvc0`, `Alpine Init 3.14.1-r0`, emergency shell; `poweroff -f` gives `VZ guest state: stopped (guest)` and exit 0. | manual run; facts in `inventory.md` §1 |
| 2026-11-18 | **observed** the full `test.sh` passes (`VZ TESTS OK`) with `MACVMM_CACHE` pointing at a scratch cache holding the real `Image-virt` and a **stand-in** `initramfs-test.img` (a 1.8 KB cpio with a static `/init` that prints `macvmm-initramfs: ready (stand-in init, not M9)` and calls `reboot(POWER_OFF)`). **blocked at** the real acceptance: M9's `initramfs-test.img` does not exist yet, so `test.sh` without the stand-in stops with `missing artifact Image-virt: run scripts/fetch.sh linux`. | hand-off report of M20 (W1) |
| 2026-11-18 | **observed** (review round 2) `test.sh` steps 1-4 pass on the real tree; step 5 still stops with `missing artifact Image-virt: run scripts/fetch.sh linux` (exit 1) because M9's `initramfs-test.img` and the decompressed `Image-virt` are not in `.cache/macvmm/`. With a scratch `MACVMM_CACHE` (`Image-virt` decompressed from the cached zboot `vmlinuz-virt`; a 1.4 KB stand-in `/init` that prints `macvmm-initramfs: ready (stand-in init, not M9)`, then the partial line `root@host:~# `, then powers off) `test.sh` passes (`VZ TESTS OK`), and TTY-7 holds: the combined output ends `root@host:~# ` / *newline* / `VZ guest state: stopped (guest)` / `vz-mac: guest powered off (exit 0)`. **blocked at** the real acceptance: M20 stays open until step 5 passes on M9's artifact. | review-fix hand-off of M20 |
| 2026-11-18 | **observed** VZLinuxBootLoader does **not** boot an EFI zboot `vmlinuz`: Alpine's `vmlinuz-virt` gives `VZErrorDomain 1` "The virtual machine failed to start" (a throwaway probe without vz-mac's header check). vz-mac now refuses such a kernel up front with exit 2 and points to `Image-virt`. | probe in the M20 hand-off |
| 2026-11-18 | **observed** `vz-mac install --latest --dry-run`: VZ reports macOS 27.2.1 build `26B131` at `https://updates.cdn-apple.com/2026FallFCS/…/UniversalMac_27.2.1_26B131_Restore.ipsw` (passes the HTTPS-on-an-Apple-host rule), requirements 2 CPUs and 4096 MiB. Nothing was downloaded. | manual run |
| 2026-11-18 | **observed** on a bundle made from that image's *metadata only* (hardware model, a fresh machine identifier, a new 33,570,816-byte `aux.img`, an empty sparse disk; **no macOS installed**): `vz-mac ecid` prints `ECID=0xca8d706a46fe7143` (above `Int64.max`; `plutil` shows the same integer), `trim-aux` writes exactly 32 MiB, `boot --dry-run` validates. | manual run |
| 2026-11-18 | **observed** `vz-mac boot --seconds 5` on that *uninstalled* bundle: `VZ guest state: running`, the power-button request is ignored, `stopped (forced)` after 60 s, exit 5. `running` therefore means only that VZ started the machine (AVPBooter), **not** that macOS booted. | manual run |
| 2026-11-18 | **observed** (review round 3) `scripts/check.sh` → `CHECK OK`; `scripts/fetch.sh linux` → `fetch: PENDING Image-virt (needs cargo xtask unzboot, M9)` (exit 0); `tools/vz-mac/test.sh` steps 1-4 `PASS`, step 5 `missing artifact Image-virt: run scripts/fetch.sh linux` (exit 1). M9 has not started (no `crates/vmm/src/loader/`, `crates/xtask/src/{zboot,cpio}.rs` or `scripts/initramfs/init`; M9 is wave W7, after M3-M8). Those files belong to M9, so M20 does not write them, and no stand-in run is counted. `initramfs-test.img` is correctly absent from `fetch-manifest.txt`: PLAN §0.4 says it is built from tracked sources, its hash printed and not pinned, and M9 adds that build step to `fetch.sh`. **blocked at** step 5 until M9 lands. | review-fix round 3 |
| — | **not done** (optional, manual, multi-GB): `vz-mac install` of a real IPSW and `vz-mac boot --bundle DIR --seconds 60` on an installed macOS. No macOS build number or installed-bundle ECID is recorded yet. | — |

## S1: AVPBooter in macvmm (PLAN M21)

Not started (blocked on ADR-0009, risk R10).

## Open points for the lead

- **ADR-0008 decision 5**: resolved. The ADR's status line now records the lead's approval as
  DECISIONS **D3**, which is why vz-mac implements `--latest` (opt-in, never in tests) instead of
  printing `blocked: ADR-0008 decision 5 not approved`.
- **M20 acceptance is blocked on M9**, not on vz-mac code: `.cache/macvmm/Image-virt` needs
  `cargo xtask unzboot` (`fetch.sh` prints `PENDING Image-virt (needs cargo xtask unzboot, M9)`)
  and `.cache/macvmm/initramfs-test.img` needs M9's `mkinitramfs` and `scripts/initramfs/init`.
  Re-run `scripts/fetch.sh linux && tools/vz-mac/test.sh` once M9 lands.
- **Anchors** `vz_linux_config` and `vz_mac_platform` exist; the ch23 lesson that embeds them is
  not authored yet (course authoring), so `check-anchors` warns that they are unreferenced.
