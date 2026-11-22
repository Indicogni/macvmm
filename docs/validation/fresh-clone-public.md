# Fresh-clone validation of the public repository

`scripts/fresh-clone-check.sh` builds and tests macvmm the way a newcomer would: from a fresh
clone and an **empty** download cache. This is the run against the public repository. The output
below is the script's stdout and stderr, verbatim except for one substitution: the directory the
run was given with `--dir` is written `<dir>`.

- Command: `scripts/fresh-clone-check.sh --from-git https://github.com/Indicogni/macvmm.git --with-freebsd --dir <dir>`,
  run 2026-11-22 (UTC) at commit `2504125`.
- Machine: Apple M5 Pro, macOS 27.2.1. This is the only machine the project has been run on
  (decision D23).
- No `--reuse-cache`, no `--steps`, `--fuzz-seconds` at its default of 60: the script refuses to
  print `FRESH CLONE OK` otherwise.
- Result: 19 of 19 steps pass, `FRESH CLONE OK`, exit code `0`.

## What this run changed

The first run against the public repository failed one step, `checkpoints-ref`: 8 of the 26
course checkpoints (13, 14, 17 to 22) could not find the kernel or firmware. The gate kept its
empty cache beside the fresh copy and pointed scripts at it with `MACVMM_CACHE`; the checkpoints
run the commands the lessons print, which name `.cache/macvmm/` literally. A learner, who uses
the default location, was never affected. The gate now puts its empty cache at the default
location inside the fresh copy, so it exercises exactly the paths a learner types.

[`fresh-clone-v1.md`](fresh-clone-v1.md) is the earlier record, from 2026-11-19, before the
course and its checkpoints existed.

## The run

```text
fresh-clone-check: base <dir>/macvmm-fresh-20261121-214804
fresh-clone-check: cache <dir>/macvmm-fresh-20261121-214804/src/.cache/macvmm

== get-code: git https://github.com/Indicogni/macvmm.git
  | 2504125 fresh-clone check: put the empty cache where a newcomer's downloads go

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
last lines of <dir>/macvmm-fresh-20261121-214804/logs/02-quickstart.log:
  | [    0.119665] Run /init as init process
  | macvmm-initramfs: ready 6.18.60-0-virt
  | / # echo macvmm-shell: $((6*7))
  | macvmm-shell: 42
  | / # poweroff -f
  | [    1.370938] reboot: Power down

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
  | test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
  | 
  | require_ran: tests/teardown.rs ran 6 test(s)

== fetch: scripts/fetch.sh linux uboot rootfs freebsd
  | fetch: cached Image-virt
  | fetch: built initramfs-test.img sha256=c455cb7b222cf5978d10d40ddc6edc379185496d06085dc4df382a60bfcf3ab8
  | fetch: OK u-boot-qemu-2026.04-r1.apk b87f1d7ab06549d123a0776f65ddd82a81ae91d9cc4b0aebf2ae811a17e1ccb0
  | fetch: OK u-boot.bin e0155e525781e6f781eb90a8dbd680c9ecb53b21081fffdc636c8a7da63f7f12
  | fetch: OK alpine-minirootfs-3.24.4-aarch64.tar.gz 4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de
  | fetch: OK modloop-virt a726889467d1d4fefa4ba1ed710f28b9db1fbd019ca3eba2d4c6c65b33536343
  | fetch: OK FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz 36028829cbd5a74a050d9964cd5fd391c9d12edca1c3d520cbcce257e1d999c8
  | fetch: OK freebsd-15.1-ufs.raw d7a05077131d07a17c3fb2faf803ff34edf511ddbf796c35934d6d2afc44b959

== mkrootfs: cargo xtask mkrootfs --out <dir>/macvmm-fresh-20261121-214804/src/.cache/macvmm/rootfs.img --size 256M
  | mkrootfs: OK <dir>/macvmm-fresh-20261121-214804/src/.cache/macvmm/rootfs.img (268435456 bytes; 83 files, 96 dirs, 335 symlinks, 0 hard links; 181 modes applied in the guest; setid stripped: none; e2fsprogs 1.47.4)

== e2e-all: scripts/test-e2e.sh all
  | test avpbooter_never_copied ... avpbooter_never_copied: 32168 files scanned, 0 of AVPBooter's size (335096 bytes) hashed, none matches sha256 9cefbfa5e747…
  | ok
  | test hv_denied_probe ... ok
  | test vmapple_needs_the_feature ... ok
  | 
  | test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.63s
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
  | [PASS] runs on your Mac phase-vq-blk: 7/7 serial markers, exit 0 in 0.52s
  | [PASS] runs on your Mac phase-toctou: 10/10 serial markers, exit 0 in 24.88s
  | [PASS] runs on your Mac phase-tty: 4/4 serial markers, exit 0 in 0.04s
  | [PASS] runs on your Mac phase-reset: 3/3 serial markers, exit 3 in 0.03s
  | [PASS] runs on your Mac phase-flood: 1/1 serial markers, exit 0 in 7.26s
  | [INFO] journal          not checked (not a learner tree)
  | CHECKPOINT 25 PASS
  | CHECKPOINTS: 26/26 PASS

== learner-smoke: learner_smoke
  |   19 virtio-net           -
  |   20 smp                  -
  |   21 firmware             -
  |   22 freebsd              -
  |   23 vz-macos             -
  |   24 vmapple              -
  |   25 security             -
  | learner: 1/26 checkpoints passed

== fuzz: scripts/fuzz.sh all --seconds 60
  | fuzz ansi: 75316493 iterations, 0 failures
  | fuzz cli: 66732202 iterations, 0 failures
  | fuzz cli (parse_run): 33143908 iterations, 0 failures
  | test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 34 filtered out; finished in 60.00s
  | fuzz tar: 158311 iterations, 0 failures
  | fuzz cpio: 24509864 iterations, 0 failures
  | fuzz zboot: 374825053 iterations, 0 failures
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
  | check-anchors: warning: scripts/initramfs/init:488: anchor "initramfs_smp_stress" is not referenced by any lesson
  | check-anchors: warning: scripts/initramfs/init:538: anchor "initramfs_dispatch" is not referenced by any lesson
  | check-anchors: warning: scripts/run-linux.sh:52: anchor "run_linux_exec" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Args.swift:14: anchor "vz_exit_codes" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Bundle.swift:78: anchor "vz_mac_platform" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/Sources/vz-mac/Files.swift:216: anchor "vz_trim_aux" is not referenced by any lesson
  | check-anchors: warning: tools/vz-mac/run.sh:36: anchor "vz_sign" is not referenced by any lesson
  | ANCHORS OK: 645 anchors, 529 lesson references, 146 warnings

== git-status-clean: git_status_clean
  | git status --porcelain: empty

STEP                 RESULT  SECONDS
-------------------- ------ --------
get-code             PASS          1
quickstart           PASS          9
setup                PASS          0
doctor-sh            PASS          0
doctor-macvmm        PASS          0
check-strict         PASS         83
signing-tests        PASS          1
hvf-tests            PASS         31
teardown-tests       PASS          2
fetch                PASS         38
mkrootfs             PASS          0
e2e-all              PASS        181
vz-mac               PASS         16
checkpoints-ref      PASS        197
learner-smoke        PASS          1
fuzz                 PASS       1385
release-signature    PASS          2
check-anchors        PASS          1
git-status-clean     PASS          0
total                           1948
time from start to "/ # ": 8s
logs: <dir>/macvmm-fresh-20261121-214804/logs
FRESH CLONE OK
```

Exit code of the script: `0`.
