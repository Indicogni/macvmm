# vz-mac: the Virtualization.framework companion

`vz-mac` is a small Swift tool that runs virtual machines through Apple's
**Virtualization.framework (VZ)**, the high-level API, so that you can compare it with macvmm,
which is built on the low-level **Hypervisor.framework (HVF)**. It belongs to course chapter 23
("macOS guests, the high road") and PLAN milestone M20. The design record is ADR-0008.

| | macvmm | vz-mac |
|---|---|---|
| Framework | Hypervisor.framework: vCPUs and stage-2 memory, nothing else | Virtualization.framework: a complete Apple machine |
| Who defines the devices | us (`crates/vmm/src/devices`, `virtio/`) | Apple, inside a privileged XPC service |
| Entitlement | exactly `com.apple.security.hypervisor` | exactly `com.apple.security.virtualization` |
| Code that boots Linux | thousands of lines | `vz_linux_config` in `LinuxBoot.swift` (~20 lines) |
| Can install macOS | no | yes (`VZMacOSInstaller`) |

The full comparison and the component inventory are in `docs/macos/inventory.md`; what was
observed on the development machine is in `docs/macos/status.md`.

## Build and run

Requirements: an Apple silicon Mac on macOS 15 or later, and Xcode (for `swift`). No Swift
package dependencies, no developer certificate, no system-security change, and no `sudo`
(threat model AS9).

```sh
tools/vz-mac/run.sh help          # build, sign, run
tools/vz-mac/test.sh --host       # unit tests + entitlement checks (no guest booted)
tools/vz-mac/test.sh              # also boots our Linux test initramfs (needs scripts/fetch.sh linux)
```

`run.sh` runs `swift build -c release` (output in `target/vz-mac/`), copies the binary to
`target/vz-mac/signed/vz-mac`, signs the copy ad hoc with `vz-mac.entitlements` and the
hardened runtime, reads the signature back, and then runs it. Build messages go to stderr.

## Commands

```text
vz-mac linux --kernel K --initrd I --cmdline S [--mem 512M] [--cpus 2] [--seconds N] [--dry-run]
vz-mac install --bundle DIR (--ipsw F | --latest) [--disk-size 64G] [--cpus N] [--mem SIZE] [--dry-run]
vz-mac boot --bundle DIR [--seconds N] [--cpus N] [--mem SIZE] [--dry-run]
vz-mac ecid --bundle DIR
vz-mac trim-aux --bundle DIR --out F
```

- **`linux`** boots the same kernel and initramfs as macvmm through `VZLinuxBootLoader`:

  ```sh
  tools/vz-mac/run.sh linux --kernel .cache/macvmm/Image-virt \
      --initrd .cache/macvmm/initramfs-test.img --cmdline "console=hvc0 macvmm.test=boot"
  ```

  The guest console is **`hvc0`** (virtio-console), not `ttyAMA0`: VZ has no PL011, so the
  command line needs `console=hvc0`. The kernel must be an uncompressed arm64 `Image`; a
  compressed `vmlinuz` (EFI zboot) is refused with a pointer to `Image-virt`. `--dry-run`
  validates the configuration without booting. `--seconds N` force-stops a guest that has not
  powered off after N seconds (exit 5).
- **`install`** creates a new bundle directory and installs macOS into it. Prefer
  `--ipsw F`, a restore image you downloaded yourself. `--latest` asks VZ for the newest
  restore image this Mac supports and downloads it over HTTPS from Apple into
  `${MACVMM_CACHE}/ipsw/`, recording its size and sha256 on first use (DECISIONS D3).
  `--latest --dry-run` only prints which image that would be. An install downloads many GB and
  takes 20 to 40 minutes; it is never part of the tests.
- **`boot`** boots an installed bundle headless. `--seconds N` presses the virtual power
  button after N seconds, then force-stops after 60 more seconds if the guest ignores it.
- **`ecid`** prints `ECID=0x…`, the machine identifier's chip ID (input for QEMU's `vmapple`
  and milestone M21).
- **`trim-aux`** writes the bundle's `aux.img` without its first `0x4000` bytes of VZ metadata
  (the form QEMU's `vmapple` pflash expects).

A bundle holds `disk.img`, `aux.img`, `HardwareModel.bin`, `MachineIdentifier.bin` and
`bundle-info.txt`. Keep the files together: the hardware model, identifier and auxiliary
storage must be the ones the guest was installed with. VZ allows at most two macOS VMs at a time
(the macOS licence allows two virtual copies per Mac, §2B(iii)).

## Output and exit codes

stdout is the guest console only. Every message from `vz-mac` itself goes to stderr, prefixed
`vz-mac:` or `VZ guest state:`, so a guest cannot fake one on stdout. The console is filtered
with the threat model's `strict` policy (TTY-5): escape sequences and other control characters
are shown visibly (`^[`, `\x9b`) instead of reaching your terminal.

| Code | Meaning |
|---|---|
| 0 | the guest powered off, or the command finished |
| 1 | tool or Virtualization.framework error (for example, the entitlement is missing) |
| 2 | usage error: bad option, missing or non-regular file, invalid size |
| 3 | the VM stopped with an error |
| 5 | `--seconds` expired and the guest was force-stopped |
| 130 | interrupted (Ctrl-C or SIGTERM) |

## Security notes

- vz-mac has its own single entitlement; macvmm's `entitlements.plist` does not change.
  `cargo xtask audit` and `test.sh` (`vz_entitlements_exact`) check both.
- Disk and aux images written by a guest are untrusted. vz-mac never mounts or parses them; do
  not open them with `hdiutil attach` or Finder either (threat model SC-14).
- Nothing from an IPSW runs on the host. Apple's restore signatures are checked during install.
- No IPSW, AVPBooter or other Apple binary belongs in this repository.
