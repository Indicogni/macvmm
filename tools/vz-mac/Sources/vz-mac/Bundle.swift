// Bundle.swift: the on-disk macOS VM bundle, and the VZ macOS platform built from it.
//
// Why a bundle: a VZ macOS guest is not just a disk. Its identity is three more artefacts that
// must be preserved together and restored *exactly* for every later boot
// (`VZMacPlatformConfiguration.h`, `VZMacAuxiliaryStorage.h`):
//   - `HardwareModel.bin`: `VZMacHardwareModel.dataRepresentation`, the virtual Mac model the
//     restore image was installed for (opaque);
//   - `MachineIdentifier.bin`: `VZMacMachineIdentifier.dataRepresentation`, which carries the
//     ECID that boot objects are personalized for (see ECID.swift);
//   - `aux.img`: the auxiliary storage, NVRAM plus boot policy, laid out by the installer;
//   - `disk.img`: the raw, sparse main disk (VZ supports only RAW images, 512-byte multiple).
// vz-mac adds `bundle-info.txt` (build number, IPSW size and sha256: DECISIONS D3).
// Layout and names follow macos-guest.md §6 S0 item 2, so QEMU's vmapple workflow and M21 can
// use the same files (`trim-aux`, `ecid`).
//
// Trust: the bundle directory must be ours (0700-style checks, SC-3) and its files are opened
// without following symlinks. After the guest has run, `aux.img` and `disk.img` are
// guest-written, hence hostile to host parsers (SC-14): vz-mac only hands them to VZ or copies
// their bytes.
import Foundation
@preconcurrency import Virtualization

/// Paths inside a bundle directory.
struct MacBundle {
    let path: String

    var disk: String { path + "/disk.img" }
    var aux: String { path + "/aux.img" }
    var hardwareModel: String { path + "/HardwareModel.bin" }
    var machineIdentifier: String { path + "/MachineIdentifier.bin" }
    var info: String { path + "/bundle-info.txt" }

    init(path: String) {
        // Normalise a trailing slash so the derived names are stable in messages.
        var p = path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        self.path = p
    }
}

/// Caps on bundle files a later boot reads (bytes).
let maxAuxBytes: UInt64 = 4 << 30
let maxDiskBytes: UInt64 = 16 << 40

/// Everything needed to boot an installed bundle.
struct LoadedBundle {
    let hardwareModel: VZMacHardwareModel
    let machineIdentifier: VZMacMachineIdentifier
    let auxiliaryStorage: VZMacAuxiliaryStorage
    let diskURL: URL
}

/// Read and check a bundle for `boot` (and the checks `ecid`/`trim-aux` share).
func loadBundle(_ bundle: MacBundle) throws(VZMacError) -> LoadedBundle {
    try checkPrivateDirectory(bundle.path)
    let hw = try readSmallFile(bundle.hardwareModel, follow: .noFollow, cap: maxIdentifierBytes)
    guard let model = VZMacHardwareModel(dataRepresentation: hw) else {
        throw .failure("\(debugQuoted(bundle.hardwareModel)) is not a valid VZMacHardwareModel")
    }
    guard model.isSupported else {
        throw .failure("this host does not support the bundle's hardware model")
    }
    let mid = try readSmallFile(bundle.machineIdentifier, follow: .noFollow, cap: maxIdentifierBytes)
    guard let identifier = VZMacMachineIdentifier(dataRepresentation: mid) else {
        throw .failure("\(debugQuoted(bundle.machineIdentifier)) is not a valid VZMacMachineIdentifier")
    }
    _ = try checkInput(bundle.aux, follow: .noFollow, cap: maxAuxBytes)
    let diskInfo = try checkInput(bundle.disk, follow: .noFollow, cap: maxDiskBytes)
    guard diskInfo.size > 0, diskInfo.size % 512 == 0 else {
        throw .failure("\(debugQuoted(bundle.disk)) size is not a positive multiple of 512")
    }
    return LoadedBundle(
        hardwareModel: model, machineIdentifier: identifier,
        auxiliaryStorage: VZMacAuxiliaryStorage(url: URL(fileURLWithPath: bundle.aux)),
        diskURL: URL(fileURLWithPath: bundle.disk))
}

// ANCHOR: vz_mac_platform
/// The macOS platform: what makes this VM a "virtual Mac" rather than a generic arm64 machine.
/// Hardware model, machine identifier (ECID) and auxiliary storage must be the ones the guest
/// was installed with; `VZMacOSBootLoader` then runs Apple's AVPBooter ROM, which verifies and
/// loads the guest's own boot chain from disk (macos-guest.md §2). None of it is inspectable.
func makeMacConfiguration(
    hardwareModel: VZMacHardwareModel, machineIdentifier: VZMacMachineIdentifier,
    auxiliaryStorage: VZMacAuxiliaryStorage, disk: URL, cpus: Int, memory: UInt64
) throws(VZMacError) -> VZVirtualMachineConfiguration {
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = hardwareModel
    platform.machineIdentifier = machineIdentifier
    platform.auxiliaryStorage = auxiliaryStorage

    let config = VZVirtualMachineConfiguration()
    config.platform = platform
    config.bootLoader = VZMacOSBootLoader()
    config.cpuCount = cpus
    config.memorySize = memory

    // The main disk must be the first storage device (VZVirtualMachineConfiguration.h).
    let attachment: VZDiskImageStorageDeviceAttachment
    do {
        attachment = try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false)
    } catch {
        throw .failure("cannot attach \(debugQuoted(disk.path)): \(describe(error))")
    }
    config.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: attachment)]

    // Apple-specific devices: ParavirtualizedGraphics, a Mac keyboard and trackpad. They are
    // what a low-level VMM would have to reimplement (docs/macos/inventory.md). No network
    // device by default: the tool needs none, and NAT would add a surface for no lesson.
    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [
        VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)
    ]
    config.graphicsDevices = [graphics]
    config.keyboards = [VZMacKeyboardConfiguration()]
    config.pointingDevices = [VZMacTrackpadConfiguration()]
    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    return config
}
// ANCHOR_END: vz_mac_platform

/// Validate a configuration, mapping VZ's error to ours.
func validate(_ config: VZVirtualMachineConfiguration) throws(VZMacError) {
    do {
        try config.validate()
    } catch {
        throw .failure("configuration rejected by Virtualization.framework: \(describe(error))")
    }
}

/// Clamp a CPU count and memory size into what VZ allows on this host.
func hostLimits(cpus: Int, memory: UInt64) throws(VZMacError) {
    let minCPU = VZVirtualMachineConfiguration.minimumAllowedCPUCount
    let maxCPU = VZVirtualMachineConfiguration.maximumAllowedCPUCount
    guard (minCPU...maxCPU).contains(cpus) else {
        throw .usage("--cpus must be between \(minCPU) and \(maxCPU) on this host")
    }
    let minMem = VZVirtualMachineConfiguration.minimumAllowedMemorySize
    let maxMem = VZVirtualMachineConfiguration.maximumAllowedMemorySize
    guard (minMem...maxMem).contains(memory), memory % (1 << 20) == 0 else {
        throw .usage("--mem must be a multiple of 1M between \(minMem >> 20)M and \(maxMem >> 20)M")
    }
}

let trimAuxUsage = "vz-mac trim-aux --bundle DIR --out F"

/// The VZ metadata header QEMU's vmapple pflash must not see (macos-guest.md §3.4).
let auxHeaderBytes: UInt64 = 0x4000

@MainActor
func runTrimAux(_ args: [String]) throws(VZMacError) {
    let o = try parseOptions(args, valued: ["--bundle", "--out"], switches: [])
    let bundle = MacBundle(path: try o.required("--bundle"))
    let out = try o.required("--out")
    try checkPrivateDirectory(bundle.path)
    let n = try trimPrefix(input: bundle.aux, output: out, skip: auxHeaderBytes, cap: maxAuxBytes)
    note("wrote \(debugQuoted(out)): \(n) bytes (aux.img without its first 0x4000 bytes)")
}
