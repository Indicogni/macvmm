// Hostile-input tests (PLAN §2.2 "every new parser has a hostile-input test file"). Each feeds
// deliberately malformed bytes to one of vz-mac's parsers and asserts a defined result: filtered
// output, an error value, never a crash. Fixed-seed property tests use an in-file xorshift PRNG
// (PLAN §0.3: no dependencies, seed printed on failure).
import Foundation
import Testing

@testable import vz_mac

/// xorshift64*: deterministic, dependency-free.
struct XorShift {
    var state: UInt64
    mutating func next() -> UInt64 {
        state ^= state >> 12
        state ^= state << 25
        state ^= state >> 27
        return state &* 0x2545_F491_4F6C_DD1D
    }
}

func filtered(_ bytes: [UInt8], chunk: Int = .max) -> [UInt8] {
    var f = StrictConsoleFilter()
    var out: [UInt8] = []
    var i = 0
    while i < bytes.count {
        let end = min(bytes.count, i + chunk)
        f.feed(bytes[i..<end], into: &out)
        i = end
    }
    f.finish(into: &out)
    return out
}

func filtered(_ s: String) -> String {
    String(decoding: filtered(Array(s.utf8)), as: UTF8.self)
}

// MARK: Console filter (threat model TTY-5 `strict`)

@Suite struct ConsoleFilterHostile {
    @Test func plainTextUnchanged() {
        let s = "macvmm-initramfs: ready\r\n\tok\u{8} é 日本 🙂\n"
        #expect(filtered(s) == s)
    }

    /// The TTY-3 attack strings: none may reach the terminal as a live control.
    @Test(arguments: [
        ("\u{1b}]0;pwned\u{7}", "^[]0;pwned^G"),  // OSC title
        ("\u{1b}]52;c;Y3VybCBldmlsCg==\u{7}", "^[]52;c;Y3VybCBldmlsCg==^G"),  // OSC 52 clipboard
        ("\u{1b}[6n", "^[[6n"),  // DSR: the reply would land in the host shell
        ("\u{1b}[c", "^[[c"),  // DA
        ("\u{1b}[21t", "^[[21t"),  // title report
        ("\u{1b}P+q544e\u{1b}\\", "^[P+q544e^[\\"),  // DCS / XTGETTCAP
        ("\u{1b}c", "^[c"),  // RIS
        ("\u{1b}[?1000h", "^[[?1000h"),  // mouse reporting
        ("\u{1b}]1337;File=x\u{7}", "^[]1337;File=x^G"),  // iTerm2
        ("\u{0e}\u{0f}\u{0}\u{5}\u{b}\u{c}", "^N^O^@^E^K^L"),  // SO SI NUL ENQ VT FF
        ("\u{7f}", "^?"),
    ])
    func escapesRenderedVisibly(_ input: String, _ expected: String) {
        #expect(filtered(input) == expected)
    }

    @Test func rawC1Rendered() {
        // 0x9b is an 8-bit CSI; 0x9d an 8-bit OSC.
        #expect(filtered([0x9B, 0x32, 0x4A, 0x9D]) == Array("\\x9b2J\\x9d".utf8))
    }

    @Test func utf8EncodedC1Rendered() {
        #expect(filtered("\u{9b}2J\u{85}") == "\\u{9b}2J\\u{85}")
    }

    @Test(arguments: [
        [UInt8]([0xC0, 0x80]),  // overlong NUL
        [0xC1, 0xBF],  // overlong
        [0xE0, 0x80, 0x9B],  // overlong 3-byte CSI
        [0xF0, 0x80, 0x80, 0x9B],  // overlong 4-byte CSI
        [0xED, 0xA0, 0x80],  // surrogate U+D800
        [0xF4, 0x90, 0x80, 0x80],  // > U+10FFFF
        [0xF8, 0x88, 0x80, 0x80, 0x80],  // 5-byte form
        [0xFF],
        [0x80],  // stray continuation (raw C1 range)
        [0xBF],  // stray continuation
    ])
    func invalidUTF8NeverPassesThrough(_ bytes: [UInt8]) {
        let out = filtered(bytes)
        #expect(isSafeTerminalText(out), "\(bytes) -> \(out)")
    }

    @Test func truncatedSequenceReplaced() {
        #expect(filtered([0x41, 0xE6, 0x97]) == [0x41, 0xEF, 0xBF, 0xBD])
        // A sequence cut short by ESC: the ESC is still shown visibly, not swallowed.
        #expect(filtered([0xE6, 0x1B, 0x5B]) == [0xEF, 0xBF, 0xBD] + Array("^[[".utf8))
    }

    @Test func chunkBoundariesDoNotMatter() {
        let s = Array("a日本🙂\u{1b}[31mé\u{9b}".utf8) + [0xE0, 0x80]
        let whole = filtered(s)
        for chunk in 1...5 {
            #expect(filtered(s, chunk: chunk) == whole, "chunk size \(chunk)")
        }
    }

    /// Property: for random bytes the output is valid UTF-8, contains no ESC, no C0 other than
    /// HT/LF/CR/BS, no DEL, and no C1 code point.
    @Test func randomBytesProperty() {
        let seed: UInt64 = 0x5EED_0020
        var rng = XorShift(state: seed)
        for iteration in 0..<10_000 {
            let len = Int(rng.next() % 64)
            var bytes: [UInt8] = []
            for _ in 0..<len { bytes.append(UInt8(truncatingIfNeeded: rng.next())) }
            let out = filtered(bytes, chunk: 1 + Int(rng.next() % 7))
            if !isSafeTerminalText(out) {
                Issue.record("seed \(seed) iteration \(iteration): unsafe output for \(bytes)")
                return
            }
        }
    }
}

/// The TTY-5 output invariant: valid UTF-8 with no ESC, no C0 other than HT/LF/CR/BS, no DEL
/// and no C1 code point (so 0x80-0x9F bytes can only be UTF-8 continuation bytes).
func isSafeTerminalText(_ bytes: [UInt8]) -> Bool {
    guard let text = String(validating: bytes, as: UTF8.self) else { return false }
    return text.unicodeScalars.allSatisfy { scalar in
        let v = scalar.value
        let allowedC0 = v == 0x09 || v == 0x0A || v == 0x0D || v == 0x08
        return !((v < 0x20 && !allowedC0) || v == 0x7F || (0x80...0x9F).contains(v))
    }
}

// MARK: Kernel header classification (booting.rst §4)

@Suite struct KernelHeaderHostile {
    func header(_ edit: (inout [UInt8]) -> Void) -> [UInt8] {
        var h = [UInt8](repeating: 0, count: 64)
        edit(&h)
        return h
    }

    @Test func arm64Image() {
        let h = header { $0.replaceSubrange(0x38..<0x3C, with: arm64ImageMagic) }
        #expect(classifyKernel(h) == .arm64Image)
    }

    @Test func zbootAndGzip() {
        let z = header {
            $0[0] = 0x4D
            $0[1] = 0x5A
            $0.replaceSubrange(4..<8, with: Array("zimg".utf8))
        }
        #expect(classifyKernel(z) == .efiZboot)
        #expect(classifyKernel([0x1F, 0x8B, 0x08]) == .gzip)
    }

    @Test(arguments: [
        [UInt8](), [0x4D], [0x4D, 0x5A], Array(repeating: 0xFF, count: 64),
        Array(repeating: 0, count: 0x3B),  // magic would be cut off
        Array("ARM\u{64}".utf8),  // magic at the wrong offset
    ])
    func garbageIsUnknown(_ h: [UInt8]) {
        #expect(classifyKernel(h) == .unknown)
    }

    @Test func magicNeedsFullHeader() {
        // 0x3C bytes contain the magic but not the full 64-byte header: refuse.
        var h = [UInt8](repeating: 0, count: 0x3C)
        h.replaceSubrange(0x38..<0x3C, with: arm64ImageMagic)
        #expect(classifyKernel(h) == .unknown)
    }

    @Test func randomHeadersNeverCrash() {
        var rng = XorShift(state: 0xC0FFEE)
        for _ in 0..<10_000 {
            let len = Int(rng.next() % 80)
            let h = (0..<len).map { _ in UInt8(truncatingIfNeeded: rng.next()) }
            _ = classifyKernel(h)
        }
    }
}

// MARK: ECID (machine-identifier plist)

@Suite struct ECIDHostile {
    func plist(_ obj: Any, binary: Bool = false) -> Data {
        try! PropertyListSerialization.data(
            fromPropertyList: obj, format: binary ? .binary : .xml, options: 0)
    }

    @Test func parsesRealShape() throws {
        #expect(try parseECID(plist(["ECID": 0x1234_5678_9ABC_DEF0 as Int64])) == 0x1234_5678_9ABC_DEF0)
        #expect(try parseECID(plist(["ECID": 42], binary: true)) == 42)
        #expect(formatECID(0xABC) == "ECID=0x0000000000000abc")
    }

    /// [V-local] Real ECIDs exceed Int64.max (one seen: 0xca8d706a46fe7143); plists store them
    /// as unsigned 64-bit integers, which must not be rejected as "negative".
    @Test func ecidAboveInt64Max() throws {
        let xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0"><dict><key>ECID</key><integer>14595445569137570115</integer></dict></plist>
            """
        #expect(try parseECID(Data(xml.utf8)) == 0xCA8D_706A_46FE_7143)
        let binary = plist(["ECID": NSNumber(value: UInt64.max)], binary: true)
        #expect(try parseECID(binary) == UInt64.max)
    }

    @Test func extraKeysTolerated() throws {
        #expect(try parseECID(plist(["ECID": 7, "Other": "x"])) == 7)
    }

    @Test(arguments: [
        Data(), Data("not a plist".utf8), Data([0x62, 0x70, 0x6C, 0x69, 0x73, 0x74, 0x30, 0x30]),  // truncated bplist
        Data(repeating: 0xFF, count: 100),
    ])
    func garbage(_ d: Data) {
        #expect(throws: VZMacError.self) { try parseECID(d) }
    }

    @Test func wrongShapes() {
        let cases: [Any] = [
            ["ecid": 1],  // wrong key case
            ["ECID": "0x1234"],  // string
            ["ECID": 1.5],  // real
            ["ECID": true],  // bool
            ["ECID": Date()],
            ["ECID": Data([1, 2])],
            ["ECID": [1]],
            ["ECID": -1],  // negative
            [1, 2, 3],  // array, not a dictionary
            "ECID",
        ]
        for c in cases {
            #expect(throws: VZMacError.self, "\(c)") { try parseECID(plist(c)) }
        }
    }

    @Test func oversizedRefused() {
        let big = plist(["ECID": 1, "pad": String(repeating: "a", count: 70_000)])
        #expect(throws: VZMacError.self) { try parseECID(big) }
    }

    @Test func randomBytesNeverCrash() {
        var rng = XorShift(state: 0xEC1D)
        for _ in 0..<2_000 {
            let len = Int(rng.next() % 96)
            var d = Data(Array("bplist00".utf8))
            for _ in 0..<len { d.append(UInt8(truncatingIfNeeded: rng.next())) }
            _ = try? parseECID(d)
        }
    }
}

// MARK: TOFU record and URL policy (DECISIONS D3, SC-2, PATH-7)

@Suite struct DownloadPolicyHostile {
    @Test(arguments: [
        "https://updates.cdn-apple.com/2026FallFCS/fullrestores/x/UniversalMac_27.2_Restore.ipsw",
        "https://swcdn.apple.com/x.ipsw", "https://apple.com/x.ipsw", "https://updates.cdn-apple.com:443/x",
    ])
    func allowed(_ s: String) {
        #expect(isAllowedIPSWURL(URL(string: s)!))
    }

    @Test(arguments: [
        "http://updates.cdn-apple.com/x.ipsw",  // not HTTPS
        "ftp://apple.com/x", "file:///tmp/x.ipsw",
        "https://evilapple.com/x",  // suffix without a dot
        "https://apple.com.evil.example/x",
        "https://user:pw@updates.cdn-apple.com/x",  // credentials
        "https://updates.cdn-apple.com:8443/x",  // odd port
        "https:///x",
    ])
    func refused(_ s: String) {
        if let u = URL(string: s) { #expect(!isAllowedIPSWURL(u)) }
    }

    @Test(arguments: ["25A5279m", "27C101", "a"]) func goodBuilds(_ b: String) {
        #expect(isValidBuildVersion(b))
    }

    @Test(arguments: ["", "../x", "a/b", "25A 1", String(repeating: "A", count: 17), "x.ipsw", "é", "a\u{0}"])
    func badBuilds(_ b: String) {
        #expect(!isValidBuildVersion(b))
    }

    @Test func tofuRoundTrip() {
        let r = TOFURecord(sha256: String(repeating: "ab", count: 32), size: 123, url: "https://apple.com/x")
        #expect(TOFURecord.parse(r.serialized(firstSeen: "2026-11-18T00:00:00Z")) == r)
    }

    @Test(arguments: [
        "", "sha256 xyz\nsize 1\nurl u\n",  // bad hex
        "sha256 \(String(repeating: "AB", count: 32))\nsize 1\nurl u\n",  // uppercase hex
        "sha256 \(String(repeating: "ab", count: 32))\nsize -1\nurl u\n",
        "sha256 \(String(repeating: "ab", count: 32))\nurl u\n",  // no size
        "sha256 \(String(repeating: "ab", count: 32))\nsize 1\nurl u\nevil line\n",
        "sha256 \(String(repeating: "ab", count: 32))\nsize 1\nurl u\nunknown-key x\n",
    ])
    func tofuMalformed(_ text: String) {
        #expect(TOFURecord.parse(text) == nil)
    }
}

// MARK: The real VZ format (no VM is created, so no entitlement is needed)

import Virtualization

@Suite struct RealMachineIdentifier {
    /// [V-local] `VZMacMachineIdentifier.dataRepresentation` is a plist with an integer `ECID`
    /// (macos-guest.md §1.2). If Apple changes the format this test fails first.
    @Test func freshIdentifierParses() throws {
        let a = VZMacMachineIdentifier()
        let b = VZMacMachineIdentifier()
        let ea = try parseECID(a.dataRepresentation)
        let eb = try parseECID(b.dataRepresentation)
        #expect(ea != eb, "each identifier is a new ECID")
        #expect(VZMacMachineIdentifier(dataRepresentation: a.dataRepresentation) == a)
    }

    @Test func vzRejectsWhatWeReject() {
        #expect(VZMacMachineIdentifier(dataRepresentation: Data("junk".utf8)) == nil)
    }
}
