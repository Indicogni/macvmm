// LinuxBoot.swift: `vz-mac linux`, the same Linux Image and initramfs that macvmm boots, run by
// Virtualization.framework instead (PLAN M20, macos-guest.md §6 S0 item 4, course ch23).
//
// Why it exists: it is the control experiment for the whole course. macvmm needs thousands of
// lines (stage-2 memory, a vCPU loop, a GIC, a PL011, a DTB writer, virtio-mmio) to boot this
// kernel; VZ needs the ~20-line configuration in `vz_linux_config`. What VZ hides is exactly
// what macvmm teaches:
//   - VZ builds the device tree, places the kernel and initrd, and enters the kernel itself
//     (macvmm: loader/, fdt/, architecture §12, Linux `Documentation/arch/arm64/booting.rst`);
//   - its console is **virtio-console** (`hvc0`), not a PL011 (`ttyAMA0`): the machine differs
//     even when the kernel is identical, so the command line needs `console=hvc0`;
//   - VZ's devices are virtio over PCI with a private machine definition we cannot inspect.
//
// Input checks (user-supplied files, threat model PATH-1/2, LDR): kernel and initrd must be
// regular files under a size cap; the kernel must carry the arm64 Image magic, because
// `VZLinuxBootLoader` on Apple silicon boots an uncompressed arm64 `Image` (booting.rst §4,
// "Image header"); a compressed or EFI-zboot `vmlinuz` is refused with a pointer to the derived
// `Image-virt` (`scripts/fetch.sh linux`, PLAN M9). The command line is capped at the arm64
// `COMMAND_LINE_SIZE` (2048 bytes, `arch/arm64/include/uapi/asm/setup.h`) and must be printable.
import Foundation
@preconcurrency import Virtualization

/// arm64 Image header magic `ARM\x64`, little-endian at offset 0x38 (booting.rst §4).
let arm64ImageMagicOffset = 0x38
let arm64ImageMagic: [UInt8] = [0x41, 0x52, 0x4D, 0x64]

/// Caps on user-supplied boot inputs (bytes). Generous: Alpine's 6.18 Image is ~37 MiB and its
/// initramfs ~10 MiB; the caps only stop an accidental disk image or device.
let maxKernelBytes: UInt64 = 512 << 20
let maxInitrdBytes: UInt64 = 1 << 30
/// `COMMAND_LINE_SIZE` on arm64, including the terminating NUL.
let maxCmdlineBytes = 2047

/// What the first bytes of `--kernel` look like.
enum KernelKind: Equatable {
    /// An uncompressed arm64 Linux Image: bootable by VZLinuxBootLoader.
    case arm64Image
    /// A PE/COFF EFI zboot image (`MZ` + `zimg`), e.g. Alpine's `vmlinuz-virt`.
    case efiZboot
    /// A gzip stream (`1f 8b`), e.g. a `Image.gz`.
    case gzip
    /// Anything else, including a file shorter than the 64-byte header.
    case unknown
}

/// Classify a kernel file from its first 64 bytes. Pure and total: any input is accepted.
func classifyKernel(_ header: [UInt8]) -> KernelKind {
    if header.count >= 64,
        Array(header[arm64ImageMagicOffset..<arm64ImageMagicOffset + 4]) == arm64ImageMagic
    {
        return .arm64Image
    }
    if header.count >= 8, header[0] == 0x4D, header[1] == 0x5A,
        Array(header[4..<8]) == Array("zimg".utf8)
    {
        return .efiZboot
    }
    if header.count >= 2, header[0] == 0x1F, header[1] == 0x8B { return .gzip }
    return .unknown
}

/// Validate a kernel command line: at most `maxCmdlineBytes`, printable ASCII only (no NUL,
/// no newline, no escape: it is also echoed in our messages).
func checkCmdline(_ s: String) throws(VZMacError) {
    guard s.utf8.count <= maxCmdlineBytes else {
        throw .usage("--cmdline is \(s.utf8.count) bytes; the arm64 limit is \(maxCmdlineBytes)")
    }
    guard s.utf8.allSatisfy({ (0x20...0x7E).contains($0) }) else {
        throw .usage("--cmdline must be printable ASCII")
    }
}

/// Everything `vz-mac linux` was asked for, after validation.
struct LinuxRequest {
    var kernel: String
    var initrd: String
    var cmdline: String
    var memory: UInt64 = 512 << 20
    var cpus = 2
    var seconds: Int?
    var dryRun = false
}

let linuxUsage =
    "vz-mac linux --kernel K --initrd I --cmdline S [--mem 512M] [--cpus 2] [--seconds N] [--dry-run]"

func parseLinux(_ args: [String]) throws(VZMacError) -> LinuxRequest {
    let o = try parseOptions(
        args, valued: ["--kernel", "--initrd", "--cmdline", "--mem", "--cpus", "--seconds"],
        switches: ["--dry-run"])
    var r = LinuxRequest(
        kernel: try o.required("--kernel"), initrd: try o.required("--initrd"),
        cmdline: try o.required("--cmdline"))
    try checkCmdline(r.cmdline)
    if let m = o.value("--mem") { r.memory = try parseSize(m) }
    // VZ requires a multiple of 1 MiB (`VZVirtualMachineConfiguration.h`, memorySize).
    guard r.memory % (1 << 20) == 0 else { throw .usage("--mem must be a multiple of 1M") }
    if let c = o.value("--cpus") { r.cpus = try parseCount(c, name: "--cpus", range: 1...64) }
    if let s = o.value("--seconds") {
        r.seconds = try parseCount(s, name: "--seconds", range: 1...86_400)
    }
    r.dryRun = o.has("--dry-run")
    return r
}

/// Check the files and VZ's own limits; returns nothing, throws a usage error.
func checkLinuxInputs(_ r: LinuxRequest) throws(VZMacError) {
    let header = try readPrefix(r.kernel, count: 64, follow: .follow, cap: maxKernelBytes)
    switch classifyKernel(header) {
    case .arm64Image: break
    case .efiZboot:
        throw .usage(
            "\(debugQuoted(r.kernel)) is an EFI zboot (compressed) kernel; VZLinuxBootLoader needs an uncompressed arm64 Image: use .cache/macvmm/Image-virt (scripts/fetch.sh linux)"
        )
    case .gzip:
        throw .usage("\(debugQuoted(r.kernel)) is gzip-compressed; decompress it to an arm64 Image")
    case .unknown:
        throw .usage(
            "\(debugQuoted(r.kernel)) is not an arm64 Linux Image (no ARM\\x64 magic at offset 0x38, booting.rst §4)"
        )
    }
    _ = try checkInput(r.initrd, follow: .follow, cap: maxInitrdBytes)
    let minMem = VZVirtualMachineConfiguration.minimumAllowedMemorySize
    let maxMem = VZVirtualMachineConfiguration.maximumAllowedMemorySize
    guard (minMem...maxMem).contains(r.memory) else {
        throw .usage("--mem must be between \(minMem >> 20)M and \(maxMem >> 20)M on this host")
    }
    let minCPU = VZVirtualMachineConfiguration.minimumAllowedCPUCount
    let maxCPU = VZVirtualMachineConfiguration.maximumAllowedCPUCount
    guard (minCPU...maxCPU).contains(r.cpus) else {
        throw .usage("--cpus must be between \(minCPU) and \(maxCPU) on this host")
    }
}

// ANCHOR: vz_linux_config
/// The whole machine definition for a Linux guest under VZ. Everything else (memory map,
/// interrupt controller, device tree, boot protocol, device models) is Apple's.
func makeLinuxConfiguration(_ r: LinuxRequest, console: VZSerialPortAttachment)
    -> VZVirtualMachineConfiguration
{
    let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: r.kernel))
    bootLoader.initialRamdiskURL = URL(fileURLWithPath: r.initrd)
    bootLoader.commandLine = r.cmdline

    // One virtio-console port: the guest's `hvc0`.
    let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
    serial.attachment = console

    let config = VZVirtualMachineConfiguration()
    config.platform = VZGenericPlatformConfiguration()
    config.bootLoader = bootLoader
    config.cpuCount = r.cpus
    config.memorySize = r.memory
    config.serialPorts = [serial]
    config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]  // virtio-rng, like M12
    return config
}
// ANCHOR_END: vz_linux_config

@MainActor
func runLinux(_ args: [String]) throws(VZMacError) -> Bool {
    let r = try parseLinux(args)
    try checkLinuxInputs(r)

    let pump = ConsolePump()
    let attachment = VZFileHandleSerialPortAttachment(
        fileHandleForReading: FileHandle.standardInput,
        fileHandleForWriting: pump.guestOutput.fileHandleForWriting)
    let config = makeLinuxConfiguration(r, console: attachment)
    do {
        try config.validate()
    } catch {
        // A missing `com.apple.security.virtualization` entitlement surfaces here.
        throw .failure("configuration rejected by Virtualization.framework: \(describe(error))")
    }
    if r.dryRun {
        note("configuration valid: linux, \(r.cpus) vCPUs, \(r.memory >> 20) MiB, console hvc0")
        return false
    }
    let runner = VMRunner(configuration: config, console: pump)
    retainForever(runner)
    runner.run(seconds: r.seconds, onTimeout: .forceStop)
    return true
}

/// Keep an object alive until the process exits (the VM delegate is weak).
@MainActor private var keptAlive: [AnyObject] = []

@MainActor
func retainForever(_ object: AnyObject) {
    keptAlive.append(object)
}
