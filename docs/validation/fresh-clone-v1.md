# Fresh-clone validation, v1 (PLAN M23)

The v1 release gate: `scripts/fresh-clone-check.sh` builds and tests macvmm from a fresh copy
of the code and an **empty** download cache, the way a newcomer would. The output below is the
script's stdout and stderr, **verbatim and unedited** (each step's full log stayed in the run's
`logs/` directory, which the script names at the end).

- Command: `scripts/fresh-clone-check.sh --from-worktree --with-freebsd` (run 2026-11-19, base `$TMPDIR`).
  `--from-worktree` because nothing after the Phase 1 checkpoint commit is committed yet; once
  the lead commits, the same gate is `scripts/fresh-clone-check.sh --from-git <repo> --with-freebsd`.
- Machine: Apple M5 Pro, macOS 27.2.1, Rust 1.99.0, Apple clang 21, Swift 6.4,
  shellcheck 0.11.0, e2fsprogs 1.47.4, xz 5.8.4, dtc (Homebrew).
- No `--reuse-cache`, no `--steps`, `--fuzz-seconds` at its default of 60: the script refuses to
  print `FRESH CLONE OK` otherwise.

## Security checklist (threat model §10.2 M23)

- [x] **Empty cache (SC-2..5 end to end).** The cache is `<base>/cache`, created by the first
  `scripts/fetch.sh` of the run (the quickstart's `fetch.sh linux`); every artifact of the
  `linux`, `uboot`, `rootfs` and `freebsd` sets was downloaded over HTTPS, hashed and only then
  derived (step `fetch`).
- [x] **`git status --porcelain` empty afterwards** (step `git-status-clean`, after every e2e
  suite, the checkpoints, the learner smoke test, the fuzzers and the release build).
  The gate found one gap here: `guests/target/` (left by running `cargo build` inside
  `guests/` by hand) was not ignored; `.gitignore` now lists `/guests/target`.
- [x] **Every milestone Security checklist green or excepted.** Every Phase 1 and Phase 2
  milestone (M0-M22, M24, M27) reported pass with its checklist ticked; `docs/DECISIONS.md`
  records **no** approved exception, so there is none to list here. M13 was not dropped and
  M19 (FreeBSD) is in its full, not SHOULD-reduced, state: `freebsd_login` runs and passes.
- [x] **`scripts/check.sh --strict`** (shellcheck installed, a SKIP fails the run) and
  **`scripts/test-e2e.sh all`** (14 suites, including `hostile` and `hygiene`) green: steps
  `check-strict` and `e2e-all`.
- [x] **Flaws F19-F24 closed by passing tests**, all inside `check-strict`, `hvf-tests`,
  `teardown-tests` or `e2e-all`:
  F19 (NET-1..4, M24): `e2e_net` (`net_requires_peer`, `net_refuses_live_socket`, ...) and
  `crates/vmm/tests/unixgram.rs`; F20 (SINK-1, M6): `e2e_hygiene::sink_backpressure*` and
  `crates/vmm/tests/sink_queue.rs`; F21 (TTY-10, M6): `e2e_hygiene::stdin_escape_when_full`
  and `e2e_virtio::console_stdin_escape_when_full`; F22 (MEM-11, M2):
  `crates/hvf/tests/teardown.rs` (step `teardown-tests`, `--features hvf-tests,fault-injection`;
  the step fails unless the binary ran at least one test); F23 (FDT-4, M7): `e2e_guests::dtb_out_has_no_seeds` and
  `crates/vmm/tests/fdt_machine.rs`; F24 (SC-14, M15): `e2e_rootfs` (APFS clone,
  read-only `e2fsck`) and `crates/xtask/tests/image_audit.rs`.
- [x] **SIGN-3:** the shipped binary (`cargo build --release -p macvmm`, RR14) signed by
  `scripts/sign.sh` shows `flags=0x10002(adhoc,runtime)` in `codesign -dv`, and its entitlements
  are exactly `com.apple.security.hypervisor` (step `release-signature`, which compares the whole
  `plutil -p` dictionary and fails on any other key).
- [x] **Security tests:** the steps above plus `scripts/fuzz.sh all --seconds 60` (step `fuzz`:
  `fuzz OK: 22 target(s)`; 23 result lines, because the `cli` target also reports
  `cli (parse_run)`, the `macvmm run` parser; `0 failures` each).

## What the gate found and what was fixed before this run

1. `course/checkpoints/08/contract/smccc_dispatch.rs` no longer compiled against the reference:
   M18 and M21 added the `rom` and `watch` fields to `vcpu::exit::ExitEnv`, and the M27
   contract (a frozen copy of `crates/vmm/tests/smccc_dispatch.rs`) still built the struct
   without them, so `scripts/checkpoint.sh all --ref` ended `CHECKPOINTS: 12/13 FAIL`. Setting
   both to `None` in the contract (the first fix) would have made it unpassable for a learner at
   ch08, whose `ExitEnv` has neither field. `ExitEnv::new(mem, serial, ctl, bus)` (anchor
   `exit_env_new`, CURRICULUM ch08, architecture §6.4) now sets every later field to `None`, and
   the contract and the reference test build `ExitEnv { debug_calls, unhandled_mmio,
   ..ExitEnv::new(..) }`, which compiles whatever fields the struct has grown.
2. `guests/target/` was not gitignored (see above).
3. The README still described Gate G1; its quickstart now ends at the Linux shell and is the
   block this script executes literally (no placeholder `git clone` line inside the anchor).
4. Review of the first run: `crates/hvf/tests/teardown.rs` (F22) is compiled only with
   `fault-injection`, so step `hvf-tests` ran it as `running 0 tests` and nothing else ran it.
   The new step `teardown-tests` runs it (also added to `scripts/check.sh --hvf`), and both test
   steps now fail when a test binary they exist for reports 0 tests (`require_ran`). Step
   `release-signature` printed the entitlements without checking them; it now fails unless they
   are exactly `{"com.apple.security.hypervisor" => true}`.

## The run

```text
fresh-clone-check: base /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934
fresh-clone-check: cache /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934/cache

== get-code: worktree
  | copied 634 files
  | aeec036 fresh-clone-check snapshot of the worktree

== quickstart: the README block, literally
quickstart block (README.md, verbatim):
    scripts/setup.sh                 # checks the Mac, completes the Rust toolchain; ends "setup: OK"
    scripts/doctor.sh                # a 20-line C probe: is the hypervisor usable at all? "DOCTOR OK"
    cargo run -p macvmm -- doctor    # builds, signs and runs macvmm; ends "DOCTOR OK"
    scripts/fetch.sh linux           # Alpine's kernel + initramfs over HTTPS, sha256-pinned
    scripts/run-linux.sh             # boots Linux to "/ # " on the PL011 (Ctrl-A x quits)
reached "/ # " 8s after the start of this run
quickstart exit code 0 (the last command, run-linux.sh, exits 0 on poweroff)
  | macvmm-shell: 42
last lines of /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934/logs/02-quickstart.log:
  | [    0.115491] Run /init as init process
  | macvmm-initramfs: ready 6.18.60-0-virt
  | / # echo macvmm-shell: $((6*7))
  | macvmm-shell: 42
  | / # poweroff -f
  | [    1.462469] reboot: Power down

== setup: scripts/setup.sh
  | setup: macOS: 27.2.1
  | setup: clang: Apple clang version 21.0.0 (clang-2100.4.1.1)
  | setup: rust: rustc 1.99.0 (b940084d7 2026-09-28) with rustfmt, clippy, llvm-tools, aarch64-unknown-none
  | setup: optional: dtc        present (/opt/homebrew/bin/dtc)
  | setup: optional: e2fsprogs  present (1.47.4, /opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4)
  | setup: optional: xz         present (xz (XZ Utils) 5.8.4)
  | setup: optional: shellcheck present (0.11.0)
  | setup: OK

== doctor-sh: scripts/doctor.sh
  | doctor: hv_vm_create: OK
  | doctor: max IPA: 40 bits (default 36)
  | doctor: EL2 supported: yes
  | doctor: codesign entitlements: com.apple.security.hypervisor only
  | DOCTOR OK

== doctor-macvmm: cargo run --locked -p macvmm -- doctor
  | hv_vm_create: OK
  | max IPA: 40 bits (default 36)
  | EL2 supported: yes
  | max vCPUs: 64
  | in-kernel GICv3 (hv_gic_create): OK
  | page size: 16384
  | vm create/destroy x100: OK
  | DOCTOR OK

== check-strict: scripts/check.sh --strict
  | ok - a group-writable cache dir is refused
  | ok - a world-writable cache dir is refused
  | ok - a new cache dir is created 0700
  | ok - an unknown set fails
  | ok - curl is always called HTTPS-only with --tlsv1.2
  | TEST-FETCH OK: 62 cases
  | 
  | CHECK OK

== signing-tests: scripts/test-signing.sh
  | ok - sign_runtime_strips_dyld_env: codesign flags include runtime
  | ok - sign_runtime_strips_dyld_env: doctor reports hardened runtime: yes and DOCTOR OK
  | ok - sign_runtime_strips_dyld_env: DYLD_PRINT_LIBRARIES is ignored (0 dyld lines)
  | ok - sign_runtime_strips_dyld_env: a --debug copy reports no hardened runtime, as a warning
  | ok - sign_runtime_strips_dyld_env: a --debug copy honours DYLD_PRINT_LIBRARIES (705 lines), so the test can fail
  | ok - sign_no_entitlements_denied: doctor exits 1 with HV_DENIED and the sign-and-run.sh hint
  | TEST-SIGNING OK: 6 cases

== hvf-tests: hvf_tests
  | 
  | running 0 tests
  | 
  | test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  | 
  | require_ran: tests/smoke.rs ran 16 test(s)
  | require_ran: tests/hvf_memory.rs ran 7 test(s)
  | require_ran: tests/hvf_gic_live.rs ran 2 test(s)

== teardown-tests: teardown_tests
  | test run_refuses_reboot_after_failed_teardown ... ok
  | test teardown_failure_codes_probe ... ok
  | test teardown_rule_matches_pure_function ... ok
  | test unmap_failure_leaks_allocation ... ok
  | 
  | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
  | 
  | require_ran: tests/teardown.rs ran 6 test(s)

== fetch: scripts/fetch.sh linux uboot rootfs freebsd
  | fetch: cached Image-virt
  | fetch: built initramfs-test.img sha256=caef97fecea58e6ee29a2dda26fba750ad0e0da1df31f4f170b87f14fed204d4
  | fetch: OK u-boot-qemu-2026.04-r1.apk b87f1d7ab06549d123a0776f65ddd82a81ae91d9cc4b0aebf2ae811a17e1ccb0
  | fetch: OK u-boot.bin e0155e525781e6f781eb90a8dbd680c9ecb53b21081fffdc636c8a7da63f7f12
  | fetch: OK alpine-minirootfs-3.24.4-aarch64.tar.gz 4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
  | fetch: OK modloop-virt a726889467d1d4fefa4ba1ed710f28b9db1fbd019ca3eba2d4c6c65b33536343
  | fetch: OK FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz 36028829cbd5a74a050d9964cd5fd391c9d12edca1c3d520cbcce257e1d999c8
  | fetch: OK freebsd-15.1-ufs.raw d7a05077131d07a17c3fb2faf803ff34edf511ddbf796c35934d6d2afc44b959

== mkrootfs: cargo xtask mkrootfs --out /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934/cache/rootfs.img --size 256M
  | mkrootfs: OK /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934/cache/rootfs.img (268435456 bytes; 83 files, 96 dirs, 335 symlinks, 0 hard links; 181 modes applied in the guest; setid stripped: none; e2fsprogs 1.47.4)

== e2e-all: scripts/test-e2e.sh all
  | test avpbooter_never_copied ... avpbooter_never_copied: 30657 files scanned, 0 of AVPBooter's size (335096 bytes) hashed, none matches sha256 9cefbfa5e747…
  | ok
  | test hv_denied_probe ... ok
  | test vmapple_needs_the_feature ... ok
  | 
  | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.64s
  | 
  | test-e2e: e2e OK: firmware freebsd guests hostile hygiene irq linux net rootfs sandbox serial smp virtio vmapple

== vz-mac: tools/vz-mac/test.sh
  | macvmm-initramfs: ready 6.18.60-0-virt
  | VZ guest state: starting
  | VZ guest state: running
  | VZ guest state: stopped (guest)
  | vz-mac: guest powered off (exit 0)
  | PASS vz_linux_boot (exit 0, 0s)
  | 
  | VZ TESTS OK

== checkpoints-ref: scripts/checkpoint.sh all --ref
  | CHECKPOINT 11 PASS
  | [PASS] L1 contract  irq_lines (4 tests)
  | [PASS] L2 run       irq: 3/3 serial markers, exit 0 in 0.43s
  | [PASS] L2 run       timer: 7/7 serial markers, 1/1 trace markers, host cpu 1% < 10%, exit 0 in 1.09s
  | [PASS] L2 run       gic-live: HVF contract hvf_gic_live (2 tests) in 0.42s
  | [INFO] L3 journal   not checked (not a learner tree)
  | CHECKPOINT 12 PASS
  | CHECKPOINTS: 13/13 PASS

== learner-smoke: learner_smoke
  |   06 vcpu-state           -
  |   07 exit-loop            -
  |   08 traps-psci           -
  |   09 mmio-pl011           -
  |   10 device-tree          -
  |   11 timer-irq            -
  |   12 gicv3                -
  | learner: 1/13 checkpoints passed

== fuzz: scripts/fuzz.sh all --seconds 60
  | fuzz ansi: 74074125 iterations, 0 failures
  | fuzz cli: 60667239 iterations, 0 failures
  | fuzz cli (parse_run): 29231107 iterations, 0 failures
  | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 33 filtered out; finished in 60.00s
  | fuzz tar: 157178 iterations, 0 failures
  | fuzz cpio: 20949637 iterations, 0 failures
  | fuzz zboot: 363653139 iterations, 0 failures
  | fuzz: fuzz OK: 22 target(s), 60s each, seed 1

== release-signature: release_signature
  | Runtime Version=27.2.0
  | Sealed Resources=none
  | Internal requirements count=0 size=12
  | CodeDirectory v=20500 size=3015 flags=0x10002(adhoc,runtime) hashes=84+7 location=embedded
  | {
  |   "com.apple.security.hypervisor" => true
  | }
  | entitlements: com.apple.security.hypervisor only

== check-anchors: scripts/check-anchors
  | check-anchors: warning: scripts/sign-and-run.sh:23: anchor "sign_and_run" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Args.swift:14: anchor "vz_exit_codes" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Bundle.swift:78: anchor "vz_mac_platform" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Console.swift:50: anchor "vz_console_filter" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Files.swift:216: anchor "vz_trim_aux" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/LinuxBoot.swift:135: anchor "vz_linux_config" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/run.sh:36: anchor "vz_sign" is not referenced by any lesson
  | ANCHORS OK: 248 anchors, 0 lesson references, 248 warnings

== git-status-clean: git_status_clean
  | git status --porcelain: empty

STEP                 RESULT  SECONDS
-------------------- ------ --------
get-code             PASS          0
quickstart           PASS         11
setup                PASS          0
doctor-sh            PASS          0
doctor-macvmm        PASS          0
check-strict         PASS         71
signing-tests        PASS          1
hvf-tests            PASS         31
teardown-tests       PASS          1
fetch                PASS         32
mkrootfs             PASS          1
e2e-all              PASS        178
vz-mac               PASS         14
checkpoints-ref      PASS         18
learner-smoke        PASS          2
fuzz                 PASS       1383
release-signature    PASS          2
check-anchors        PASS          1
git-status-clean     PASS          0
total                           1746
time from start to "/ # ": 8s
logs: /private/var/folders/xx/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/T/macvmm-fresh-20261119-204934/logs
FRESH CLONE OK
```

Exit code of the script: `0`.
