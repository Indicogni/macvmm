# ADR-0001: Rust (edition 2024) for the VMM

- **Status:** Accepted
- **Date:** 2026-11-18
- **Deciders:** project lead (brief), VMM architect
- **Related:** `CLAUDE.md` "Key decisions", ADR-0002, `docs/architecture.md` §4

## Context

macvmm is a Virtual Machine Monitor whose main job is to parse data that a hostile guest controls:
MMIO values, virtqueue descriptors, guest physical addresses and lengths. It also parses kernel,
ELF, DTB and disk images from files. It must:

1. be memory safe on all of these paths, because a bug in the VMM is a guest-to-host escape;
2. call a C API (Hypervisor.framework) with no overhead;
3. be readable as teaching material;
4. be able to grow into a product, following the rust-vmm, Firecracker, crosvm and cloud-hypervisor lineage.

## Decision

- Write the VMM in **Rust, edition 2024**. Use a Cargo workspace and pin the toolchain in
  `rust-toolchain.toml`: channel `1.99.0` with components `rustfmt`, `clippy` and `llvm-tools`,
  and target `aarch64-unknown-none`.
- Write the bare-metal test guests in Rust too (`guests/`, `no_std`, `aarch64-unknown-none`,
  linked with `rust-lld`). One language covers both sides of the trap.
- `#![forbid(unsafe_code)]` is the default for every crate. The only exceptions are the `hvf`
  crate and `crates/vmm/src/memory/host.rs`. `scripts/check-unsafe` enforces this
  (architecture §4).
- Default dependencies are std plus `libc`, and `libc` is used only inside `crates/hvf`. Each
  extra crate needs a line in `docs/dependencies.md`.
- Host tooling (fetch post-processing, cpio writing, anchor checking) is a Rust `xtask` crate. It
  does not use Python, so the repo needs only one toolchain and the tools get the same tests and
  hostile-input discipline as the VMM.

## Consequences

- Memory-safety bugs can only live in the two quarantined places. Reviewers know where to look.
- FFI is zero-cost, but some C ABI corners need workarounds. Example: stable Rust cannot pass
  `simd_uchar16` by value, so we use an inline-asm trampoline (ADR-0002).
- Learners need Rust fluency. The course provides an appendix (CURRICULUM.md ch01 prereqs).
- No `regex`, `serde`, `clap` or `log` crates. We write small, purpose-built versions: an argv
  parser, a JSONL writer, log macros, and marker matching for tests. Every one of these is short
  and is itself teaching material.

## Alternatives considered

| Option | Why not |
|---|---|
| C | No memory safety on hostile-input paths. QEMU's CVE history is the cautionary tale. |
| Swift | First-class on macOS, but weaker control over layout and unsafe. Little VMM prior art. It loses the rust-vmm lineage. Swift is still used for the **separate** Virtualization.framework companion tool (`tools/vz-mac/`, macOS stage S0), because VZ is an ObjC/Swift API. |
| Zig / C++ | Smaller ecosystem for VMMs, and the same productization story is weaker. |
| Python tooling scripts | Would add a second language and the system Python 3.9 version constraints. The research spike's Python snippets are reimplemented in `crates/xtask`. |

## Evidence

- `spikes/hvf-hello` is a hand-written Rust FFI spike. It drove every HVF experiment on the
  M5 Pro (RESULTS.md, 25 findings).
- Rust 1.99, `aarch64-unknown-none` and `llvm-tools` are installed on the dev machine (checked 2026-11-18).
