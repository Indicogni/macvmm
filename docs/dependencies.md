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
| `/usr/bin/sandbox-exec` (ships with macOS, deprecated) | `scripts/sandbox-exec-fallback.sh` (M22) | the exec-time fallback if macvmm's own sandbox (`sandbox_init`, on by default) stops working (threat model SBX-1) | absolute path; user paths passed as `-D` parameters, never pasted into the profile; adds `--no-sandbox` after `run` itself and refuses any sandbox flag in the wrapped command |
| `/usr/bin/true` | `macvmm run --sandbox-selftest` only (M22; the sandbox is on by default), via `posix_spawn` with an empty environment | the "spawn denied" probe of the sandbox self-test (SBX-3 item 4): it runs only **after** the lockdown, where the spawn must fail; if it succeeds macvmm exits 1 | the only process creation on the `run` path, behind a hidden flag (PROC-3 exception, threat model §5 S27) |
| `patch`, `shasum` (ship with macOS) | `scripts/bughunt-selftest.sh` (M22) | apply the planted-bug patches (TEST-4) to a scratch copy under `mktemp -d`, and prove the working tree's patched files are unchanged | never run on the working tree |

## `crates/fuzz` (M22)

The fuzz crate has **no third-party dependency**: it depends only on our own `vmm` (with the
`test-util` feature, for `VecMemory`, `TestIrq` and the FDT reader) and `xtask` (the archive
parsers), and brings its own xorshift PRNG and mutators. `macvmm` names it only as a
dev-dependency (the `cli_fuzz` unit test). The optional libFuzzer wrapper of threat model TEST-5
(`libfuzzer-sys`, nightly) is not part of the workspace and is not built by `scripts/check.sh`;
adding it needs a row here.

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
