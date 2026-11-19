// Args.swift: command-line parsing, size parsing and exit codes for vz-mac.
//
// Why hand-written and strict: this is a teaching tool with five subcommands, so a dependency
// (swift-argument-parser) would cost more than it saves (CLAUDE.md "minimal dependencies").
// The rules mirror macvmm's CLI (threat model PATH-8, architecture §13.1):
//   - an unknown option, a missing value, a repeated option or a positional argument is a usage
//     error (exit 2), never ignored;
//   - sizes are parsed with checked multiplication, so `--mem 99999999999G` is exit 2, not a
//     wrapped value;
//   - every count has an explicit range.
// Exit codes reuse macvmm's table (architecture §13.2) where the meaning carries over.
import Foundation

// ANCHOR: vz_exit_codes
/// Process exit codes. The numbers match macvmm's (architecture §13.2) so scripts and the
/// course can treat both VMMs alike.
enum ExitStatus: Int32 {
    /// The guest stopped itself (power off), or the command finished.
    case ok = 0
    /// Tool or Virtualization.framework error (including a missing entitlement).
    case error = 1
    /// Usage or configuration error: bad flag, missing file, invalid size.
    case usage = 2
    /// The guest stopped with an error (`virtualMachine(_:didStopWithError:)`).
    case guestFatal = 3
    /// `--seconds` expired and the guest did not stop when asked.
    case timeout = 5
    /// SIGINT or SIGTERM.
    case interrupted = 130
}
// ANCHOR_END: vz_exit_codes

/// An error that maps to an exit status and a one-line message.
struct VZMacError: Error, CustomStringConvertible, Equatable {
    let status: ExitStatus
    let description: String

    static func usage(_ message: String) -> VZMacError {
        VZMacError(status: .usage, description: message)
    }

    static func failure(_ message: String) -> VZMacError {
        VZMacError(status: .error, description: message)
    }
}

/// Parsed `--name value` options and `--flag` switches of one subcommand.
struct Options: Equatable {
    var values: [String: String] = [:]
    var flags: Set<String> = []

    func value(_ name: String) -> String? { values[name] }

    func required(_ name: String) throws(VZMacError) -> String {
        guard let v = values[name] else {
            throw .usage("missing required option \(name)")
        }
        return v
    }

    func has(_ name: String) -> Bool { flags.contains(name) }
}

/// Parse `args` (the words after the subcommand). `valued` options take exactly one value,
/// `switches` take none. Anything else is a usage error.
func parseOptions(_ args: [String], valued: Set<String>, switches: Set<String>) throws(VZMacError)
    -> Options
{
    var out = Options()
    var i = 0
    while i < args.count {
        let a = args[i]
        if valued.contains(a) {
            guard i + 1 < args.count else {
                throw .usage("option \(a) needs a value")
            }
            guard out.values[a] == nil else {
                throw .usage("option \(a) given twice")
            }
            out.values[a] = args[i + 1]
            i += 2
        } else if switches.contains(a) {
            guard !out.flags.contains(a) else {
                throw .usage("option \(a) given twice")
            }
            out.flags.insert(a)
            i += 1
        } else if a.hasPrefix("-") {
            throw .usage("unknown option \(debugQuoted(a))")
        } else {
            throw .usage("unexpected argument \(debugQuoted(a))")
        }
    }
    return out
}

/// The largest accepted size string, in characters: 20 digits plus a suffix is already more
/// than `UInt64.max`, and a cap keeps hostile input from costing anything.
let maxSizeTextLength = 24

/// Parse a byte size: decimal digits with an optional binary suffix `K`, `M`, `G` or `T`
/// (case-insensitive; `512M` is 512 MiB). Overflow is an error, never a wrap (PATH-8).
func parseSize(_ text: String) throws(VZMacError) -> UInt64 {
    guard !text.isEmpty, text.utf8.count <= maxSizeTextLength else {
        throw .usage("invalid size \(debugQuoted(text))")
    }
    var digits = Substring(text)
    var shift: UInt64 = 0
    if let last = text.last, !last.isNumber {
        switch last {
        case "K", "k": shift = 10
        case "M", "m": shift = 20
        case "G", "g": shift = 30
        case "T", "t": shift = 40
        default: throw .usage("invalid size \(debugQuoted(text)): unknown suffix")
        }
        digits = digits.dropLast()
    }
    guard !digits.isEmpty, digits.allSatisfy({ $0.isASCII && $0.isNumber }) else {
        throw .usage("invalid size \(debugQuoted(text))")
    }
    guard let base = UInt64(digits) else {
        throw .usage("invalid size \(debugQuoted(text)): too large")
    }
    let (scaled, overflow) = base.multipliedReportingOverflow(by: UInt64(1) << shift)
    guard !overflow else {
        throw .usage("invalid size \(debugQuoted(text)): too large")
    }
    return scaled
}

/// Parse a decimal integer in `range` (no sign, no suffix).
func parseCount(_ text: String, name: String, range: ClosedRange<Int>) throws(VZMacError) -> Int {
    guard text.utf8.count <= 10, !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }),
        let v = Int(text), range.contains(v)
    else {
        throw .usage(
            "\(name) must be an integer in \(range.lowerBound)...\(range.upperBound), got \(debugQuoted(text))"
        )
    }
    return v
}

/// A value quoted for a message, with control characters escaped, so that a hostile argument
/// (or a hostile file name) cannot write escape sequences to the terminal (threat model TTY-8).
func debugQuoted(_ s: String) -> String {
    var out = "\""
    for scalar in s.unicodeScalars.prefix(256) {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case _ where scalar.value < 0x20 || (0x7f...0x9f).contains(scalar.value):
            out += String(format: "\\u{%x}", scalar.value)
        default: out.unicodeScalars.append(scalar)
        }
    }
    if s.unicodeScalars.count > 256 { out += "…" }
    return out + "\""
}

/// Write one line to stderr, prefixed `vz-mac: `. Every message the tool itself prints goes to
/// stderr, so it can never be confused with guest console output on stdout (threat model AS10).
func note(_ message: String) {
    FileHandle.standardError.write(Data("vz-mac: \(message)\n".utf8))
}

/// Write a `VZ guest state: …` line (stderr; the course and test.sh look for these markers).
func stateLine(_ state: String) {
    FileHandle.standardError.write(Data("VZ guest state: \(state)\n".utf8))
}
