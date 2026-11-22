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

Scope: ADR-0009 (= DECISIONS D4): AVPBooter is read in place from the system path, only its
first device accesses are logged, nothing is disassembled, and per-access logs are not
published. ROM tested: `AVPBooter.vmapple2.bin`, 335,096 bytes, sha256 `9cefbfa5e7478945…`
(the prefix only identifies the version; the file itself is never copied: TEST-11).

| Date | Line | Evidence |
|---|---|---|
| 2026-11-19 | **observed** AVPBooter executes in macvmm. `macvmm run --machine vmapple --bios <AVPBooter> --mem 4G --unhandled-mmio log --trace exits:$T/avp.jsonl --timeout 20` (feature build) prints `vmapple: first exit at pc=0x103478` (inside the ROM window `0x10_0000..0x20_0000`), then `vmapple: 34 unknown MMIO accesses logged` (33 in the `cfg` row, 1 in the `pvpanic` row), and ends with `macvmm: timeout: the guest was still running after --timeout 20s` (exit 5): no hypercall stop, and no exit after the last logged access. Re-observed 2026-11-19 after the review fixes (per-access lines now on stderr at the default level; ISV=0 refusals counted): the same first-exit PC, count and rows. | `e2e_vmapple::vmapple_first_probe` |
| 2026-11-19 | **blocked at** the `cfg` block (S2): macvmm does not model it, so every read of it returns 0 and every write is dropped. After its last logged access the ROM makes no further exit for the rest of the run. Whether it is waiting for a value S2 would provide is **unknown** (we do not inspect its code, ADR-0009). Next step: S2 fills `cfg` from QEMU-documented facts and the bundle's ECID, then the trace is repeated. | the run above |
| 2026-11-19 | **observed** with the default `--unhandled-mmio fatal`, the first unknown access is logged and stops the VM, exit 3. | `e2e_vmapple::vmapple_fatal_by_default` |
| 2026-11-19 | **observed** the SLA guard: with two vmapple instances running, a third exits 2 with `vmapple: all 2 macOS-VM slots … are in use`; the lock directory is `0700`. The slots are per user (`$HOME/.cache/macvmm/vmapple-slots`): with both held, a run from another directory with another `MACVMM_CACHE` is still refused. The guard is advisory (HVF enforces no limit of its own). | `e2e_vmapple::vmapple_third_instance_refused`, `e2e_vmapple::vmapple_slots_are_per_user` |
| 2026-11-19 | **observed** the default build refuses `--machine vmapple` with `built without experimental-vmapple` (exit 2). | `e2e_vmapple::vmapple_needs_the_feature` |
| 2026-11-19 | **observed** `tools/hv-denied-probe/run.sh` (signed like macvmm: only `com.apple.security.hypervisor`, hardened runtime): `hv_vm_config_set_isa(3): 0x00000000`, `hv_vm_create with private ISA 3: HV_DENIED (0xfae94007)`. | `e2e_vmapple::hv_denied_probe` |
| 2026-11-19 | **observed** no file in the repo (build outputs included; about 290,000 files) or in `.cache/` has AVPBooter's sha256. | `e2e_vmapple::avpbooter_never_copied` |

Status line: **observed** AVPBooter's first exit at `pc=0x103478` and 34 unknown device
accesses (cfg, pvpanic); **blocked at** the unmodelled `cfg` block (S2). macOS does not boot in
macvmm, and nothing here claims it does.

## Open points

- **M21 / S1** is done to its exit criterion (above). S2 (cfg, bdif, pvpanic, PL031/PL061 at
  the vmapple bases) is post-v1 research with no boot promise (ADR-0008 decision 7).

- **ADR-0008 decision 5**: resolved. The ADR's status line now records the lead's approval as
  DECISIONS **D3**, which is why vz-mac implements `--latest` (opt-in, never in tests) instead of
  printing `blocked: ADR-0008 decision 5 not approved`.
- **M20's dependency on M9** is resolved: `scripts/fetch.sh linux` now produces
  `.cache/macvmm/Image-virt` and `.cache/macvmm/initramfs-test.img`, which `tools/vz-mac/test.sh`
  needs.
- **Anchors**: chapter 23 is written and embeds `vz_linux_config`. `vz_mac_platform` is still not
  referenced by a lesson, so `check-anchors` warns about it.
