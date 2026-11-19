// MacBoot.swift: `vz-mac boot`, boot an installed macOS bundle under VZ, headless.
//
// Why headless: the course's claim is only "VZ boots it" (PLAN M20 acceptance: `VZ guest
// state: running`, then `VZ guest state: stopped (requested)`), and a window would need an
// AppKit app, a second large surface. The graphics device is still configured (macOS expects
// one), it just has no view. `--seconds N` presses the virtual power button after N seconds
// (`requestStop`, which the guest may decline, e.g. at a "Shut down?" prompt) and force-stops
// after a grace period. Without `--seconds` the VM runs until the guest shuts down or Ctrl-C.
//
// SLA: VZ itself refuses a third concurrent macOS VM (`VZErrorVirtualMachineLimitExceeded`,
// macOS SLA §2B(iii) allows two; ADR-0008 decision 6), and Runner.swift explains that error.
import Foundation
@preconcurrency import Virtualization

let bootUsage = "vz-mac boot --bundle DIR [--seconds N] [--cpus N] [--mem SIZE] [--dry-run]"

/// How long a macOS guest gets to honour the stop request before it is force-stopped.
let requestStopGraceSeconds = 60.0

@MainActor
func runBoot(_ args: [String]) throws(VZMacError) -> Bool {
    let o = try parseOptions(
        args, valued: ["--bundle", "--seconds", "--cpus", "--mem"], switches: ["--dry-run"])
    let bundle = MacBundle(path: try o.required("--bundle"))
    let seconds = try o.value("--seconds").map { (s: String) throws(VZMacError) in
        try parseCount(s, name: "--seconds", range: 1...86_400)
    }
    let cpus = try o.value("--cpus").map { (s: String) throws(VZMacError) in
        try parseCount(s, name: "--cpus", range: 1...64)
    } ?? 4
    let memory = try o.value("--mem").map { (s: String) throws(VZMacError) in try parseSize(s) }
        ?? (4 << 30)
    try hostLimits(cpus: cpus, memory: memory)

    let loaded = try loadBundle(bundle)
    let config = try makeMacConfiguration(
        hardwareModel: loaded.hardwareModel, machineIdentifier: loaded.machineIdentifier,
        auxiliaryStorage: loaded.auxiliaryStorage, disk: loaded.diskURL, cpus: cpus, memory: memory)
    try validate(config)
    if o.has("--dry-run") {
        note("configuration valid: macOS bundle \(debugQuoted(bundle.path)), \(cpus) vCPUs, \(memory >> 20) MiB")
        return false
    }
    let runner = VMRunner(configuration: config, console: nil)
    retainForever(runner)
    runner.run(seconds: seconds, onTimeout: .requestStop(grace: requestStopGraceSeconds))
    return true
}
