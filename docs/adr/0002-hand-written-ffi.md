# ADR-0002: Hand-written FFI to Hypervisor.framework

- **Status:** Accepted
- **Date:** 2026-11-18
- **Related:** `CLAUDE.md`, `docs/research/hvf-api.md` §1, `spikes/hvf-hello/src/ffi.rs`, ADR-0001

## Context

Crates already wrap HVF on arm64, for example `applevisor` and `hvf`. Using one would save a few
hundred lines. But the FFI boundary is itself a lesson (CURRICULUM ch01), and these crates' type
widths, availability and safety contracts are not under our control. The spike found several
traps that a generic wrapper could get silently wrong:

- `hv_sys_reg_t` is `u16`.
- `hv_gic_redistributor_reg_t` is `u32`, while the other GIC register enums are `u16`.
- `hv_vcpu_t` is `u64` on arm64.
- `hv_vcpu_set_simd_fp_reg` takes a 16-byte vector by value in `v0`.

## Decision

1. `crates/hvf/src/ffi.rs` declares every function, type and constant **by reading the SDK
   headers** at `$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/`.
   Never write these from memory. Declarations use edition-2024 `unsafe extern "C" { ... }` with
   `#[link(name = "Hypervisor", kind = "framework")]`.
2. **The baseline is macOS 15.0**, the first release with `hv_gic_*`. Every statically linked
   symbol must be `API_AVAILABLE(macos(<=15.0))`. Newer optional APIs are resolved at run time
   with `dlsym` in `crates/hvf/src/optional.rs` and return `Option`:
   - `hv_vm_config_set_ipa_granule` (26.0)
   - `hv_vcpu_get_wait_for_interrupt_time` (27.0)
   - `hv_vcpu_set_serror` (27.0)
   - `hv_vcpu_invalidate_tlb` (27.0)

   A missing symbol degrades a feature. It is never a load failure.
3. **ABI conformance is tested mechanically.** `scripts/check-ffi.sh` compiles
   `crates/hvf/abi/abi_dump.c` with clang against the real headers. That program prints
   `NAME=value` for every constant we declare, plus `sizeof` and `offsetof` for `hv_vcpu_exit_t`.
   The script runs `cargo run -p hvf --example abi_dump`, which prints the same lines from Rust,
   and fails on any diff. `scripts/check.sh` runs it.
4. The by-value SIMD argument goes through the inline-asm trampoline in `crates/hvf/src/simd.rs`.
   It loads `v0` and uses `clobber_abi("C")`, as verified in the spike. A unit test round-trips a
   Q register (`hvf-tests`).
5. **The safe wrappers encode HVF's rules in types:**
   - `Vm` is a singleton, and `Drop` calls `hv_vm_destroy`.
   - `Vcpu<'vm>` is `!Send` and `!Sync` (a `PhantomData<*const ()>`) and borrows the `Vm`. That
     makes the "owning thread only" rule and the "destroy vCPUs before the VM" rule compile-time
     facts.
   - `VcpuHandle` is `Copy + Send + Sync` and only permits `hv_vcpus_exit`.
   - `Vm::map` is an `unsafe fn`, because the caller must guarantee that the host range outlives
     the mapping. Only `vmm::memory::host` calls it.
   - `Gic` is created with `Vm` before any `Vcpu` can exist (`VmBuilder::with_gic`).
6. **Private or unheadered symbols are not used.** Examples: `__hv_vm_config_set_isa` and
   `__hv_vcpu_config_set_fgt_enabled`. Any future use needs its own ADR (see
   `docs/research/macos-guest.md` §1.4) and must live behind a cargo feature that is off by default.
7. Every `unsafe` block carries a `// SAFETY:` comment.
   `clippy::undocumented_unsafe_blocks = "deny"` is set for the `hvf` crate.

## Consequences

- About 600–900 lines of FFI and wrappers that we own and teach.
- macOS header changes are caught by `check-ffi.sh`. Learners repeat the same check in ch01.
- Wrappers stay thin. Policy belongs to `vmm`. For example, `hvf` does not decide PC-advance
  rules; it only reports exits.

## Alternatives considered

- **`applevisor`/`hvf` crates.** Rejected: they hide the lesson, add an external dependency to the
  security-critical boundary, and their availability gating may not match ours.
- **`bindgen`.** Rejected: it needs libclang at build time and cannot express the by-value SIMD
  ABI. Its output also mirrors the C names and loses the type-level rules from item 5. We still
  use clang, but only as the **oracle** in `check-ffi.sh`, never as a code generator.
- **Weak linking.** Rejected: `#[linkage = "extern_weak"]` is unstable. `dlsym` gives the same
  result on stable Rust.
