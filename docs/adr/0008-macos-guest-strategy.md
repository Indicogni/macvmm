# ADR-0008: macOS guests: a Virtualization.framework companion (S0) and an AVPBooter experiment (S1), never private entitlements

- **Status:** Accepted (decision 5, the IPSW download exception, was approved by the lead on
  2026-11-18 as `docs/DECISIONS.md` D3)
- **Date:** 2026-11-18
- **Related:** `docs/research/macos-guest.md` (the feasibility study), `CLAUDE.md` goal 1 and
  security rules, ADR-0002 item 6, ADR-0003 item 4, CURRICULUM ch23–24, `docs/PLAN.md` M20–M21

## Context

A macOS guest is the project's stretch goal. The research established, with evidence tags:

- QEMU's `vmapple` machine proves that a third-party VMM *can* boot macOS on Apple Silicon, but
  only for **macOS 12 guests on M1–M3 hosts**, and its `apple-gfx-mmio` path broke on macOS 15.4
  hosts `[V-src, R]`.
- On this dev machine (M5 Pro, macOS 27.2), the private Apple-ISA mode that modern guests need
  (`__hv_vm_config_set_isa(cfg, 3)`) makes `hv_vm_create` return **`HV_DENIED`** under our only
  entitlement, `com.apple.security.hypervisor` `[V-local]`. Using it would require the private
  `com.apple.private.hypervisor` entitlement, SIP off and AMFI bypassed.
- The M5 Pro lacks FEAT_SSBS, so even macOS 12 probably needs an unheadered fine-grained-trap
  workaround `[V-local + R]`.
- Installing macOS requires Virtualization.framework (VZ): personalization, the `.ipsw` restore
  flow and the auxiliary storage are only reachable through `VZMacOSInstaller` `[V-src]`.
- The macOS SLA allows at most two macOS VMs per Mac for listed purposes, forbids redistribution
  of Apple software, and forbids reverse engineering (§2B(iii), §2N) `[V-src]`.
- QEMU's vmapple code is GPL-2.0-or-later. Facts (register offsets, struct layouts) may be used;
  code and prose may not be copied into this project.

`CLAUDE.md` says: investigate honestly, ship a well-researched design plus achievable increments,
and never claim a macOS boot that was not observed.

## Decision

1. **Claims policy.** No document, lesson, commit message or test name may say that macvmm boots
   macOS unless a captured transcript shows a macOS login or shell under macvmm. Progress is
   reported only as `observed X; blocked at Y` lines in `docs/macos/status.md`, each linked to a
   trace or transcript.
2. **S0 (ships in v1, M20): a separate Swift companion tool, `tools/vz-mac/`.**
   - It is a SwiftPM package outside the Cargo workspace, signed ad-hoc with **only**
     `com.apple.security.virtualization` (`tools/vz-mac/vz-mac.entitlements`). The `macvmm` binary
     keeps exactly one entitlement, `com.apple.security.hypervisor`.
   - Commands: `linux` (boots the same `Image-virt` + test initramfs that macvmm boots, through
     `VZLinuxBootLoader`, console `hvc0`), `install`, `boot`, `ecid` and `trim-aux` (macos-guest.md §6 S0).
   - Its lesson is the contrast: VZ is a policy-rich, closed VMM with private entitlements; HVF is
     a mechanism where we own every device and every exit.
3. **S1 (experimental, M21): the `vmapple` machine profile behind the cargo feature
   `experimental-vmapple`, off by default.**
   - Layout and CPU bring-up follow architecture §5.2: AVPBooter at IPA `0x0010_0000`, RAM at
     `0x7000_0000`, GIC at `0x1000_0000`/`0x1001_0000` (accepted by `hv_gic_create` `[V-local]`),
     PL011 at `0x2001_0000`, EL1 entry, PSCI over HVC, no DTB, secondaries off.
   - AVPBooter is **read at run time, read-only,** from
     `/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/AVPBooter.vmapple2.bin`
     into a host allocation. It is never copied into the repo, the cache, test fixtures, release
     artefacts or the course site.
   - Everything not modelled goes to a RAZ/WI `UnknownMmio` logger with a hard cap, after which
     the VM stops with a summary.
   - **Exit criterion and the whole claim:** "AVPBooter executes in macvmm, and we observe its
     first device accesses." Nothing more.
   - M21 is **blocked** until the lead records a written decision on how far tracing of Apple
     firmware may go under SLA §2N (risk R10; `docs/adr/0009-avpbooter-tracing-scope.md`, PLAN D4).
     Until then the default is: traces are used only to check our implementation of
     QEMU-documented devices, raw traces of Apple firmware are never published, and nothing is
     ever disassembled.
4. **Prohibited, permanently unless a new ADR reverses it:**
   - the `com.apple.private.*` entitlements, SIP or AMFI changes, and instructions telling
     learners to make them;
   - unheadered HVF symbols (`__hv_vm_config_set_isa`, `__hv_vcpu_config_set_fgt_enabled`, …),
     except in a stand-alone probe that demonstrates `HV_DENIED` (`tools/hv-denied-probe/`, M21);
     any use inside macvmm needs its own ADR and a default-off feature (ADR-0002 item 6);
   - disassembling or decompiling Apple binaries;
   - copying GPL QEMU code or prose. Each vmapple device module records the provenance of its
     facts (QEMU docs or source at a pinned commit, Apple headers) in its `//!` comment.
5. **IPSW download exception (Accepted by the lead as `docs/DECISIONS.md` D3: opt-in only, never
   run by default tests, size and sha256 printed and recorded).** Apple rotates
   restore-image URLs, so `vz-mac install --latest` cannot use a pre-pinned sha256 manifest. The
   tool records the sha256 of every IPSW on first download (trust-on-first-use) under
   `${MACVMM_CACHE}/ipsw/`, relies on Apple's own signature checks during restore, and never runs
   anything from the IPSW on the host. A user-supplied `--ipsw F` is preferred and documented
   first. This is the only exception to the "sha256-pinned downloads" rule in `CLAUDE.md`.
6. **SLA guard.** The vmapple profile takes one of two lock files,
   `$HOME/.cache/macvmm/vmapple-slots/{0,1}.lock` (one directory per user, independent of the
   working directory and of `MACVMM_CACHE`; M21 review fix), with `File::try_lock`, and refuses to
   start a third instance. The guard is advisory and per user: a `0700` directory cannot see
   another user's VMs, and HVF, unlike VZ, enforces no limit itself. The VZ tool relies on VZ's own
   two-VM limit.
7. **Reusable work is scheduled by the guests that need it, not by macOS.** The ISV=0 decoder
   (M17) ships because firmware needs it. PCIe/virtio-pci (W7/W8), CPU-feature masking (W15) and
   the cfg/bdif/pvpanic devices (S2) stay post-v1 research with no boot promise.

## Consequences

- v1 ships a macOS *lesson* and two observable increments, not a macOS VM. The capstone (ch24) is
  graded on the trace and the design record, which matches the curriculum.
- Learners need nothing beyond a stock Mac: no SIP changes, no private entitlements, no Apple
  binaries in the repo. The only Apple artefact used at run time is already on their machine.
- The Swift tool adds a second language to the repo, confined to `tools/vz-mac/`.
- If Apple documents a public macOS-guest CPU mode in a future release, this ADR is revisited (S7
  in the study).

## Alternatives considered

| Option | Why not |
|---|---|
| Pursue S2–S6 (cfg, bdif, AES, PCIe, XHCI, ParavirtualizedGraphics) now | 3–5 person-months with low confidence on M4/M5 hosts and private-API churn (macos-guest.md §6 effort table); scope creep risk R7 |
| Use the private entitlement with SIP off "for research" | Violates the brief's minimal-entitlement rule and weakens learners' machines; not shippable |
| Write the VZ companion in Rust over the ObjC runtime | Teaches ObjC-runtime FFI rather than VZ; Swift is the idiomatic, short path for a tool whose point is the contrast |
| Drop macOS entirely | The brief asks for an honest investigation; the HV_DENIED evidence and the VZ contrast are valuable lessons |
