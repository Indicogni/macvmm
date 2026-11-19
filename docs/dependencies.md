# Dependencies

macvmm uses the Rust standard library and nothing else by default (CLAUDE.md "Minimal
dependencies"; ADR-0001, ADR-0002). Every third-party crate needs a row in the table below with
its justification, **and** its name in the allowlist block, which `cargo xtask audit` reads:

- `scripts/check-unsafe` fails if any `[dependencies]`, `[dev-dependencies]` or
  `[build-dependencies]` entry of a workspace or `guests/` manifest is missing from the
  allowlist (threat model SC-11). Path dependencies between our own crates are exempt.
- `cargo xtask audit --deps` (run by `scripts/check.sh`) checks every third-party package in
  `Cargo.lock`, the full transitive set for every platform.

No crate may be added for something that is itself a lesson topic: DTB generation, ELF loading,
virtqueues, GIC/PSCI, MMIO decoding.

| Crate | Used by | Why | Alternatives considered | Status |
|---|---|---|---|---|
| (none) | | | | |
| `libc` | `crates/hvf` only (`host.rs` shims) | `umask`, `setrlimit`/`getrlimit` (M3, PROC-4, PATH-6), `O_NONBLOCK` for opening inputs without blocking on a FIFO (PATH-2), later termios, signals, `getentropy`, `O_NOFOLLOW_ANY`, without hand-declaring each libSystem struct layout. The FFI to Hypervisor.framework stays hand-written (ADR-0002). | hand-written `extern "C"` declarations | **allowed from M3** (PLAN M3 rev 1.1) |

## Host programs the tooling runs (no crate)

| Program | Run by | Why | Guard |
|---|---|---|---|
| `/usr/bin/gzip -dc` (ships with macOS) | `cargo xtask unzboot` (M9), via `scripts/fetch.sh` | inflate the gzip payload of Alpine's EFI zboot `vmlinuz-virt`; writing an inflater is not a lesson topic and would add VMM-adjacent parser surface | absolute path, no shell, empty environment; only after the input's sha256 matched (SC-5); output capped at 256 MiB (SC-6); never run by the VMM (LDR-4) |

## Outside the Cargo workspace: `tools/vz-mac` (M20)

The Swift companion tool has **no SwiftPM package dependencies** (`Package.swift` lists none). It
links only Apple system frameworks that ship with macOS: Foundation, Virtualization (the subject
of the tool) and CryptoKit (sha256 of an IPSW for the DECISIONS D3 trust-on-first-use record).
Its tests use the Swift Testing library that ships with the toolchain. Adding a Swift package
needs a row here, like a crate.

## Allowlist

One crate name per line.

<!-- allowlist:begin -->
```text
libc
```
<!-- allowlist:end -->
