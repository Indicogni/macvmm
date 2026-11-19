// MacInstall.swift: `vz-mac install`, create a bundle and install macOS into it with VZ.
//
// Why only VZ can do this step: installing macOS means restoring a signed IPSW onto a disk and
// personalizing the boot objects for this VM's ECID through Apple's signing server; the restore
// protocol and the auxiliary-storage layout are reachable only through `VZMacOSInstaller`
// (macos-guest.md §2). That is why every third-party macOS-guest effort, QEMU's `vmapple`
// included, installs with VZ first and boots the result elsewhere (§3.4).
//
// Steps (`VZMacOSInstaller.h`, `VZMacOSRestoreImage.h`, `VZMacAuxiliaryStorage.h`):
//   1. load the restore image (`--ipsw F`, preferred) or fetch the latest one (`--latest`, the
//      DECISIONS D3 trust-on-first-use download, IPSW.swift);
//   2. take `mostFeaturefulSupportedConfiguration`: hardware model plus minimum CPUs and memory;
//   3. create the bundle (Bundle.swift): a new 0700 directory, `HardwareModel.bin`, a fresh
//      `MachineIdentifier.bin` (a new ECID), an empty `aux.img`, a sparse raw `disk.img`;
//   4. run `VZMacOSInstaller` and report its progress; record build and IPSW hash.
// Multi-GB and 20–40 minutes: manual and optional (PLAN M20), never run by `test.sh`.
import Foundation
@preconcurrency import Virtualization

let installUsage =
    "vz-mac install --bundle DIR (--ipsw F | --latest) [--disk-size 64G] [--cpus N] [--mem SIZE] [--dry-run]"

/// Smallest and default main-disk sizes. A macOS 27 install needs roughly 30 GB.
let minDiskBytes: UInt64 = 32 << 30
let defaultDiskBytes: UInt64 = 64 << 30

/// Carries a VZ completion result across the continuation. VZ objects are not `Sendable`;
/// each result is handed over exactly once and then used only on the main actor.
struct Handoff<T>: @unchecked Sendable {
    let value: T
}

/// `VZMacOSRestoreImage` loading, as async calls (the completion runs on an arbitrary thread).
func loadRestoreImage(file: String) async throws(VZMacError) -> VZMacOSRestoreImage {
    let r = await withCheckedContinuation { (cont: CheckedContinuation<Handoff<Result<VZMacOSRestoreImage, any Error>>, Never>) in
        VZMacOSRestoreImage.load(from: URL(fileURLWithPath: file)) { cont.resume(returning: Handoff(value: $0)) }
    }
    switch r.value {
    case .success(let image): return image
    case .failure(let e): throw .failure("cannot load restore image \(debugQuoted(file)): \(describe(e))")
    }
}

func fetchLatestRestoreImage() async throws(VZMacError) -> VZMacOSRestoreImage {
    let r = await withCheckedContinuation { (cont: CheckedContinuation<Handoff<Result<VZMacOSRestoreImage, any Error>>, Never>) in
        VZMacOSRestoreImage.fetchLatestSupported { cont.resume(returning: Handoff(value: $0)) }
    }
    switch r.value {
    case .success(let image): return image
    case .failure(let e): throw .failure("cannot fetch the latest restore image: \(describe(e))")
    }
}

func versionText(_ v: OperatingSystemVersion) -> String {
    "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}

@MainActor
func runInstall(_ args: [String]) async throws(VZMacError) {
    let o = try parseOptions(
        args, valued: ["--bundle", "--ipsw", "--disk-size", "--cpus", "--mem"],
        switches: ["--latest", "--dry-run"])
    let bundle = MacBundle(path: try o.required("--bundle"))
    let ipswArg = o.value("--ipsw")
    guard (ipswArg != nil) != o.has("--latest") else {
        throw .usage("give exactly one of --ipsw F or --latest\nusage: \(installUsage)")
    }
    let diskSize = try o.value("--disk-size").map { (s: String) throws(VZMacError) in try parseSize(s) }
        ?? defaultDiskBytes
    guard diskSize >= minDiskBytes, diskSize <= maxDiskBytes else {
        throw .usage("--disk-size must be between \(minDiskBytes >> 30)G and \(maxDiskBytes >> 30)G")
    }
    let cpuArg = try o.value("--cpus").map { (s: String) throws(VZMacError) in
        try parseCount(s, name: "--cpus", range: 1...64)
    }
    let memArg = try o.value("--mem").map { (s: String) throws(VZMacError) in try parseSize(s) }
    let dryRun = o.has("--dry-run")

    // 1. The restore image.
    var ipswPath: String
    var ipswSHA = "unknown"
    var ipswSize: UInt64 = 0
    var image: VZMacOSRestoreImage
    if let ipswArg {
        _ = try checkInput(ipswArg, follow: .follow, cap: maxIPSWBytes)
        ipswPath = ipswArg
        image = try await loadRestoreImage(file: ipswPath)
    } else {
        let remote = try await fetchLatestRestoreImage()
        note("latest supported restore image: macOS \(versionText(remote.operatingSystemVersion)) build \(debugQuoted(remote.buildVersion)) at \(debugQuoted(remote.url.absoluteString))")
        guard isAllowedIPSWURL(remote.url) else {
            throw .failure("restore image URL is not HTTPS on an Apple host; refusing")
        }
        if dryRun {
            describeRequirements(remote)
            note("dry run: nothing downloaded, no bundle created")
            return
        }
        (ipswPath, ipswSHA, ipswSize) = try await fetchLatestIPSW(remote)
        image = try await loadRestoreImage(file: ipswPath)
    }
    note("restore image: macOS \(versionText(image.operatingSystemVersion)) build \(debugQuoted(image.buildVersion))")

    // 2. What this host can run from it.
    guard let req = describeRequirements(image) else {
        throw .failure("this restore image supports no hardware model on this host")
    }
    let cpus = cpuArg ?? max(req.minimumSupportedCPUCount, 4)
    let memory = memArg ?? max(req.minimumSupportedMemorySize, 4 << 30)
    try hostLimits(cpus: cpus, memory: memory)
    guard cpus >= req.minimumSupportedCPUCount, memory >= req.minimumSupportedMemorySize else {
        throw .usage("this restore image needs at least \(req.minimumSupportedCPUCount) CPUs and \(req.minimumSupportedMemorySize >> 20)M")
    }
    if dryRun {
        note("dry run: no bundle created")
        return
    }
    if ipswArg != nil {
        note("hashing \(debugQuoted(ipswPath)) (recorded in bundle-info.txt)")
        (ipswSHA, ipswSize) = try sha256File(ipswPath, follow: .follow, cap: maxIPSWBytes)
        note("IPSW size \(ipswSize) sha256 \(ipswSHA)")
    }

    // 3. The bundle.
    try createPrivateDirectory(bundle.path)
    try writeNewFile(bundle.hardwareModel, req.hardwareModel.dataRepresentation)
    let identifier = VZMacMachineIdentifier()
    try writeNewFile(bundle.machineIdentifier, identifier.dataRepresentation)
    let aux: VZMacAuxiliaryStorage
    do {
        aux = try VZMacAuxiliaryStorage(
            creatingStorageAt: URL(fileURLWithPath: bundle.aux), hardwareModel: req.hardwareModel,
            options: [])
    } catch {
        throw .failure("cannot create \(debugQuoted(bundle.aux)): \(describe(error))")
    }
    try createSparseFile(bundle.disk, size: diskSize)
    if let ecid = try? parseECID(identifier.dataRepresentation) {
        note("new machine identifier: \(formatECID(ecid))")
    }

    // 4. Install.
    let config = try makeMacConfiguration(
        hardwareModel: req.hardwareModel, machineIdentifier: identifier, auxiliaryStorage: aux,
        disk: URL(fileURLWithPath: bundle.disk), cpus: cpus, memory: memory)
    try validate(config)
    let vm = VZVirtualMachine(configuration: config)
    let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: ipswPath))
    note("installing (this takes 20-40 minutes)")
    // A dispatch timer, not `Timer.scheduledTimer`: main.swift serves the main queue with
    // `dispatchMain()`, which never runs the main RunLoop, so a RunLoop timer would never fire.
    let progress = Handoff(value: installer.progress)
    let ticker = DispatchSource.makeTimerSource(queue: .main)
    ticker.schedule(deadline: .now() + 10, repeating: 10)
    ticker.setEventHandler {
        note(String(format: "install %.0f%%", progress.value.fractionCompleted * 100))
    }
    ticker.resume()
    let r = await withCheckedContinuation { (cont: CheckedContinuation<Handoff<Result<Void, any Error>>, Never>) in
        installer.install { cont.resume(returning: Handoff(value: $0)) }
    }
    ticker.cancel()
    if case .failure(let e) = r.value {
        throw .failure("install failed: \(describe(e)); remove \(debugQuoted(bundle.path)) before retrying")
    }
    let info = """
        # vz-mac bundle (PLAN M20). Keep every file together; see tools/vz-mac/README.md.
        build \(image.buildVersion)
        macos \(versionText(image.operatingSystemVersion))
        ipsw-size \(ipswSize)
        ipsw-sha256 \(ipswSHA)
        cpus \(cpus)
        memory \(memory)

        """
    try writeNewFile(bundle.info, Data(info.utf8))
    note("install complete: macOS build \(debugQuoted(image.buildVersion)) in \(debugQuoted(bundle.path))")
}

/// Print and return the most featureful configuration this host supports for `image`.
@discardableResult
func describeRequirements(_ image: VZMacOSRestoreImage) -> VZMacOSConfigurationRequirements? {
    guard let req = image.mostFeaturefulSupportedConfiguration, req.hardwareModel.isSupported else {
        note("no hardware model in this restore image is supported on this host")
        return nil
    }
    note("requirements: at least \(req.minimumSupportedCPUCount) CPUs and \(req.minimumSupportedMemorySize >> 20) MiB")
    return req
}
