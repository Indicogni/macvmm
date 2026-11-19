// ECID.swift: `vz-mac ecid`, the guest's Exclusive Chip ID from a bundle's machine identifier.
//
// Why: on a physical Mac the ECID is a per-chip serial that Apple's signing server (TSS) binds
// boot objects to ("personalization"). A VZ macOS guest gets a synthetic one inside its
// `VZMacMachineIdentifier`. QEMU's `vmapple` machine needs the same value (`-M vmapple,uuid=`)
// to boot a VZ-installed disk, and M21 will need it for the cfg region (macos-guest.md §1.2,
// §3.4). `VZMacMachineIdentifier.dataRepresentation` is documented only as "opaque"
// (`VZMacMachineIdentifier.h`); **[V-local, macOS 27.2]** it is a property list holding one
// key, `ECID`, an integer. Because the format is undocumented, this parser is strict and says
// so when the format changes instead of guessing.
//
// Hostile-input rules: the file is read with a 64 KiB cap and `O_NOFOLLOW`; the plist must be a
// dictionary whose `ECID` is an integer (not a bool, real, string or date) in `0...UInt64.max`.
import Foundation

/// Cap on `MachineIdentifier.bin` / `HardwareModel.bin` (real ones are well under 1 KiB).
let maxIdentifierBytes: UInt64 = 64 << 10

/// Extract the ECID from a `VZMacMachineIdentifier.dataRepresentation` blob.
func parseECID(_ data: Data) throws(VZMacError) -> UInt64 {
    guard UInt64(data.count) <= maxIdentifierBytes else {
        throw .failure("machine identifier is \(data.count) bytes; the limit is \(maxIdentifierBytes)")
    }
    let plist: Any
    do {
        plist = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    } catch {
        throw .failure("machine identifier is not a property list (format changed?)")
    }
    guard let dict = plist as? [String: Any] else {
        throw .failure("machine identifier plist is not a dictionary (format changed?)")
    }
    guard let raw = dict["ECID"] else {
        throw .failure("machine identifier has no ECID key (format changed?)")
    }
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFNumberGetTypeID(),
        !CFNumberIsFloatType(number)
    else {
        throw .failure("machine identifier ECID is not an integer")
    }
    // Property-list integers are signed 64-bit, or unsigned 64-bit when above Int64.max.
    let signed = number.int64Value
    if signed >= 0 { return UInt64(signed) }
    if String(cString: number.objCType) == "Q" { return number.uint64Value }
    throw .failure("machine identifier ECID is negative")
}

/// `ECID=0x…`: the line `docs/macos/status.md` records.
func formatECID(_ ecid: UInt64) -> String {
    String(format: "ECID=0x%016llx", ecid)
}

let ecidUsage = "vz-mac ecid --bundle DIR"

@MainActor
func runECID(_ args: [String]) throws(VZMacError) {
    let o = try parseOptions(args, valued: ["--bundle"], switches: [])
    let bundle = MacBundle(path: try o.required("--bundle"))
    try checkPrivateDirectory(bundle.path)
    let data = try readSmallFile(
        bundle.machineIdentifier, follow: .noFollow, cap: maxIdentifierBytes)
    let ecid = try parseECID(data)
    print(formatECID(ecid))
}
