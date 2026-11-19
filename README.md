# macvmm

A virtual machine monitor written from scratch in Rust on Apple's Hypervisor.framework, for
Apple Silicon Macs. It is a teaching codebase first (the course lives at
<https://indicogni.com/build-your-own/vmm/>) and is built to be productizable: hand-written FFI,
`unsafe` quarantined to two modules, every guest-controlled value treated as hostile.

Status: Gate G1 (milestone M10). The stock Alpine `linux-virt` 6.18 kernel boots with our
generated device tree and test initramfs to a busybox shell on the emulated PL011 and powers
off through PSCI. No disk yet (virtio is Phase 2). See `docs/PLAN.md` for the milestones and
`docs/architecture.md` for the design.

## Prerequisites

- An Apple Silicon Mac (M1 or later) running **macOS 15.0 or later**: the in-kernel GICv3
  (`hv_gic_create`) first shipped in macOS 15 (decision D7). A virtual machine will not do:
  Hypervisor.framework needs the physical CPU.
- Xcode command line tools (`xcode-select --install`): clang, `codesign`, `otool`.
- [rustup](https://rustup.rs). The toolchain is pinned in `rust-toolchain.toml` (Rust 1.99.0)
  and installed on first use.
- Optional, reported by `scripts/setup.sh` with the milestone that needs each: `dtc`, `xz`,
  `e2fsprogs`, `shellcheck` (all from Homebrew).

No `sudo` is needed, and nothing is installed outside the repository and rustup.

## Quickstart

<!-- ANCHOR: quickstart -->
```sh
git clone <this repository> macvmm && cd macvmm
scripts/setup.sh                 # checks the Mac, completes the Rust toolchain; ends "setup: OK"
scripts/doctor.sh                # a 20-line C probe: is the hypervisor usable at all?
cargo run -p macvmm -- doctor    # builds, signs and runs macvmm; ends "DOCTOR OK"
scripts/check.sh                 # the full quality gate; ends "CHECK OK"
scripts/fetch.sh linux           # Alpine's kernel + initramfs over HTTPS, sha256-pinned
scripts/run-linux.sh             # boots Linux to "/ # " on the PL011 (Ctrl-A x quits)
```

At the prompt, `uname -a` prints `Linux (none) 6.18.60-0-virt … aarch64 Linux`, and
`poweroff -f` ends macvmm with exit code 0 and your terminal restored. The same boot without
the wrapper:

```sh
cargo run -p macvmm -- run --kernel .cache/macvmm/Image-virt \
    --initrd .cache/macvmm/initramfs-test.img --mem 512M
scripts/test-e2e.sh guests linux # Gate G1: the bare-metal guests and the Linux suite
```
<!-- ANCHOR_END: quickstart -->

`cargo run` and `cargo test` go through `scripts/sign-and-run.sh` (configured in
`.cargo/config.toml`), which ad-hoc signs each binary before running it. Without that step
`hv_vm_create` fails with `HV_DENIED (0xfae94007)`.

## Signing

- `scripts/sign.sh BINARY` signs with `codesign -s - -o runtime --entitlements entitlements.plist`:
  an ad-hoc signature, the hardened runtime, and exactly one entitlement. It refuses files
  outside `target/` and verifies the result.
- The runner gives the entitlement only to binaries that link Hypervisor.framework (`macvmm` and
  the test binaries of `hvf`, `vmm` and `macvmm`); everything else, such as `xtask`, is signed
  without entitlements (threat model SIGN-4).
- `scripts/sign.sh --debug` omits the hardened runtime so a debugger can attach, and says so.
  `macvmm doctor` then reports `hardened runtime: no (debug signing)`.

### Why one entitlement

`entitlements.plist` contains only `com.apple.security.hypervisor`, and `scripts/sign.sh`,
`macvmm doctor` and `cargo xtask audit` each check that the whole set is exactly that
(threat model SIGN-1). Be clear about what this buys:

- The hypervisor entitlement is a **capability marker, not a security boundary.** Any local user
  can ad-hoc sign a binary with it. Compromising macvmm gives an attacker nothing the same user
  did not already have.
- **"No network entitlement" confines nothing on its own.** Outside the App Sandbox, a process
  without `com.apple.security.network.*` can still open sockets, files and child processes.
  Containment comes from a sandbox profile (milestone M22) and, later, from splitting device
  emulation into a separate unentitled process, never from the entitlement list.
- What the minimal set does do is keep the signature honest and reviewable, and keep out the
  entitlements that would weaken the process: `allow-jit`, `allow-unsigned-executable-memory`,
  `disable-library-validation`, `allow-dyld-environment-variables`, `get-task-allow`.
- The **hardened runtime** (`-o runtime`, a signing flag, not an entitlement) matters more: without
  it, dyld honours `DYLD_*` environment variables in the entitled process, so anything that can
  set the launch environment could inject code (threat model SIGN-3, verified on hardware).

## Downloads

`scripts/fetch.sh <set>` downloads guest artifacts listed in `scripts/fetch-manifest.txt`
over HTTPS only, checks each against a pinned sha256, and stores it in `.cache/macvmm/`
(`MACVMM_CACHE` overrides the location). Nothing downloaded is ever executed on the host.

## Repository layout

`crates/hvf` FFI and safe wrappers · `crates/vmm` the VMM library · `crates/macvmm` the CLI ·
`crates/xtask` repository tooling (anchor check, security audit) · `scripts/` setup, signing,
fetch, checks · `docs/` architecture, plan, ADRs, threat model · `course/` lesson sources.

## Licence

Not yet decided (decision D1 is provisional); `publish = false` until it is.
