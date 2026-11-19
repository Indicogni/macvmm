// main.swift: vz-mac, the Virtualization.framework companion to macvmm (PLAN M20, ADR-0008
// decision 2, course ch23 "macOS guests, the high road").
//
// Why this tool exists: macvmm is built on Hypervisor.framework (HVF), a *mechanism*: we own
// every device and every exit, and we get no Apple-only privileges. Virtualization.framework
// (VZ) is a *policy-rich, closed* VMM on top of the same hardware: Apple's machine definition,
// firmware, devices and a privileged XPC service (macos-guest.md §1.3). Some things only VZ can
// do (install macOS; run modern macOS guests); others only a low-level VMM can (custom devices,
// introspection, teaching). This tool makes the contrast runnable:
//
//   vz-mac linux    boot the same Image + initramfs macvmm boots       (LinuxBoot.swift)
//   vz-mac install  create a macOS VM bundle from an IPSW              (MacInstall.swift)
//   vz-mac boot     boot an installed bundle headless, optionally timed (MacBoot.swift)
//   vz-mac ecid     print the bundle's ECID (input to QEMU vmapple, M21) (ECID.swift)
//   vz-mac trim-aux strip VZ's 0x4000-byte aux-storage header for vmapple (Bundle.swift)
//
// Signing: exactly `com.apple.security.virtualization` (vz-mac.entitlements, threat model
// SIGN-1), ad hoc, hardened runtime (SIGN-3); `run.sh` builds, signs, verifies, then execs.
// No private entitlements, no system-security changes, no elevated privileges (AS9).
import Darwin
import Foundation

let usage = """
    usage:
      \(linuxUsage)
      \(installUsage)
      \(bootUsage)
      \(ecidUsage)
      \(trimAuxUsage)

    Messages from vz-mac go to stderr (prefixed `vz-mac:` or `VZ guest state:`); stdout carries
    only the guest console (filtered, threat model TTY-5) and the `ecid` result.
    Exit codes: 0 ok, 1 error, 2 usage, 3 guest error, 5 timeout, 130 interrupted.
    """

/// Run one subcommand. Returns `true` when a VM is now running and the process must keep
/// serving the main queue until a stop path calls `exit` (Runner.swift).
@MainActor
func dispatch(_ argv: [String]) async throws(VZMacError) -> Bool {
    guard let command = argv.first else { throw .usage(usage) }
    let rest = Array(argv.dropFirst())
    switch command {
    case "linux":
        return try runLinux(rest)
    case "install":
        try await runInstall(rest)
        return false
    case "boot":
        return try runBoot(rest)
    case "ecid":
        try runECID(rest)
        return false
    case "trim-aux":
        try runTrimAux(rest)
        return false
    case "help", "-h", "--help":
        print(usage)
        return false
    default:
        throw .usage("unknown command \(debugQuoted(command))\n\(usage)")
    }
}

// Files vz-mac creates are private (PATH-6); stdout is line-buffered so guest lines and our
// stderr lines interleave sensibly on a terminal.
umask(0o077)
setvbuf(stdout, nil, _IOLBF, 0)

Task { @MainActor in
    do throws(VZMacError) {
        if try await dispatch(Array(CommandLine.arguments.dropFirst())) { return }
        exit(ExitStatus.ok.rawValue)
    } catch {
        note(error.description)
        exit(error.status.rawValue)
    }
}
dispatchMain()
