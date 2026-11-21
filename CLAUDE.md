# macvmm — a VMM from scratch on Apple Silicon (shared project brief)

This file is the shared brief for every human and agent working in this repo. Read it before starting.

## Goal
1. A **pedagogic but productizable** Virtual Machine Monitor (VMM) written from scratch on top of
   Apple's **Hypervisor.framework** (HVF) on Apple Silicon (arm64). Target guests:
   - **Linux/arm64**: direct kernel boot (Image + initramfs + generated DTB), then virtio-blk rootfs, SMP. MUST work.
   - **FreeBSD/arm64**: boot through firmware (U-Boot `qemu_arm64` build, then later EDK2), virtio-blk disk image. SHOULD work.
   - **macOS guest**: stretch/capstone. Investigate honestly (QEMU `vmapple` machine is the existence proof;
     AVPBooter + paravirtualized Apple devices). Ship a well-researched design + whatever increments are achievable.
     Never claim it boots unless it was observed booting.
2. A complete **course** (tutorial) published on https://indicogni.com as one project
   (path: `/build-your-own/vmm/`). Learners need a physical Apple Silicon Mac for the native parts, but the
   site itself also has in-browser interactive labs (decoders, page-table walkers, virtqueue visualizers…).

## Dev machine facts (verified)
Apple M5 Pro, macOS 27.2, Xcode with Swift 6.4, Apple clang 21, Rust 1.99 via rustup (edition 2024).
SDK headers: `$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/`
(includes `hv_gic*.h` in-kernel GICv3, `hv_vm_config_*` IPA size + EL2, `hv_sme_config.h`).
**Always check the real headers rather than memory** when writing FFI.

## Key decisions (do not re-litigate without strong evidence)
- **Language: Rust**, Cargo workspace, edition 2024. Rationale: memory safety (the VMM parses hostile guest
  data), zero-cost FFI, the rust-vmm/Firecracker/crosvm lineage for future productization.
- **Hand-written FFI** to Hypervisor.framework (no `applevisor`/`hvf` crates). The FFI is part of the lesson.
- **Minimal dependencies.** std + `libc` is the default. Any extra crate needs a one-line justification in
  `docs/dependencies.md`. No dependency may be added for something that is itself a lesson topic
  (DTB generation, ELF loading, virtqueues, GIC/PSCI, MMIO decoding).
- **`unsafe` is quarantined** to the `hvf` FFI module and the guest-memory mapping module. Every `unsafe`
  block has a `// SAFETY:` comment. Everything else is `#![forbid(unsafe_code)]`.
- **Machine model mirrors QEMU `virt`'s memory map** so stock firmware (U-Boot qemu_arm64, EDK2 ArmVirtQemu)
  and stock kernels work unmodified. RAM at 0x4000_0000; flash at 0x0; GIC dist 0x0800_0000 (redist after it);
  PL011 0x0900_0000; PL031 RTC 0x0901_0000; virtio-mmio slots at 0x0a00_0000 (0x200 stride). The DTB
  is generated in Rust. Single source of truth for the map: `crates/vmm/src/arch/layout.rs` (or equivalent).
- **Interrupts**: use HVF's in-kernel GICv3 (`hv_gic_create`). With the in-kernel GIC the vtimer, WFI and GIC register accesses are handled inside HVF (verified: no VTIMER exits reach us); `HV_EXIT_REASON_VTIMER_ACTIVATED` matters only in the `--irqchip none` teaching mode.
  PSCI via HVC (SMCCC) for CPU_ON / SYSTEM_OFF / SYSTEM_RESET. One host thread per vCPU.
- **Code ↔ lesson coupling**: lessons embed real code via anchors `// ANCHOR: name` … `// ANCHOR_END: name`.
  `scripts/check-anchors` verifies every anchor a lesson references exists. Never paste code into lessons by hand.
- **Repo layout** (target):
  - `crates/hvf/` FFI + thin safe wrappers · `crates/vmm/` library (memory, vcpu, devices, virtio, loaders,
    fdt, arch) · `crates/macvmm/` CLI binary · `guests/` bare-metal Rust test guests (`aarch64-unknown-none`)
  - `scripts/` setup, fetch (sha256-pinned), sign, boot, e2e tests · `docs/` architecture, ADRs, threat model,
    diagrams (SVG + Mermaid sources) · `course/` lesson sources (Markdown) + `course/site/` static site builder
- **Signing**: binaries are ad-hoc codesigned with ONLY `com.apple.security.hypervisor`. `cargo run` must
  work via a runner script that signs first. No sudo required for the default path.

## Audience (assume this, always)
Learners have **never worked with virtualization in any form**: not as users of KVM/QEMU internals, not as
hypervisor developers, possibly not even beyond "I've run a VM in an app". They can program (some Rust or C)
and know what a process and memory address are. Do NOT assume knowledge of: what a VM/VMM/hypervisor is,
trap-and-emulate, Popek–Goldberg, type 1 vs type 2, emulation vs virtualization vs paravirtualization,
hardware-assisted virtualization, two-stage address translation, virtual devices, why virtio exists. Also do
not assume ARM64 knowledge (exception levels, system registers, assembly) — teach it or primer it.
Part 0 must build the mental model of virtualization from zero before any code beyond "hello hv_vm_create".

## Borrowed concepts get taught too
Every pre-existing concept the course relies on is tiered and listed in `course/CONCEPTS.md`:
**core** (learner implements it → full chapter, derived from the problem it solves: virtio/virtqueues, FDT,
GICv3, PSCI, stage-2, exception levels/ESR, MMIO decode), **primer** (used, not implemented → short standalone
tutorial in `course/primers/<slug>.md`, 15–30 min, objectives + self-check + lab if useful: SMCCC, ELF, cpio/
initramfs, EFI zboot, PrimeCell IDs, memory ordering/barriers, arm64 boot protocol, U-Boot, codesign/entitlements,
page granules), **pointer** (aside + authoritative link). Each lesson opens with a "Concepts you'll need" box
linking chapters/primers. Never use a concept before it is taught or linked.

## Security rules (non-negotiable)
- Treat every guest-controlled value (MMIO data, virtqueue descriptors, addresses, lengths, DTB/ELF/Image
  headers from disk) as hostile. All guest-physical accesses go through bounds-checked GuestMemory APIs;
  check overflow (`checked_add`), never trust lengths, cap descriptor-chain lengths, detect loops.
- Downloads: HTTPS only, sha256-pinned in a manifest, stored under `~/.cache/macvmm` or `./.cache`
  (gitignored), never executed on the host. Scripts are `set -euo pipefail`, quote everything.
- Minimal entitlements; no networking entitlement by default (this alone is NOT confinement — the self-applied sandbox is, and it is on by default; `--no-sandbox` opts out for debugging, D21). Guest output is filtered (AnsiFilter) on every sink, not only TTYs. Document the threat model in `docs/security/`.
- No secrets, no personal data, no telemetry.

## Quality bar
- `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test` (host-only unit tests need no HVF) must pass.
- HVF integration tests live behind `--features hvf-tests` or in `scripts/test-*.sh`, and are actually run on
  this machine before claiming success. Report real outputs; never claim a guest booted without seeing it.
- Every module has doc comments explaining the *why* (this is a teaching codebase): cite the ARM ARM, GIC spec,
  virtio 1.2 spec, Linux `Documentation/arch/arm64/booting.rst`, DTB spec by section where relevant.
- Don't commit to git; the lead will handle commits.
- Lead decisions on open questions: `docs/DECISIONS.md`. Execution plan: `docs/PLAN.md`; architecture: `docs/architecture.md`.
