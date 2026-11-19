// Host tests for vz-mac's file layer (threat model PATH-1..6, SC-3, SC-14): trim-aux copies
// bytes without parsing them, never overwrites, never follows a planted symlink, and refuses
// devices, directories and short inputs. Each test works in its own fresh temporary directory.
import Darwin
import Foundation
import Testing

@testable import vz_mac

/// A fresh 0700 temporary directory, removed when the test ends.
final class TempDir {
    let path: String

    init() {
        var template = Array((NSTemporaryDirectory() + "vz-mac-test.XXXXXX").utf8CString)
        let p = template.withUnsafeMutableBufferPointer { mkdtemp($0.baseAddress!) }
        path = String(cString: p!)
    }

    func file(_ name: String, _ bytes: [UInt8]) -> String {
        let p = path + "/" + name
        FileManager.default.createFile(atPath: p, contents: Data(bytes), attributes: [.posixPermissions: 0o600])
        return p
    }

    deinit {
        try? FileManager.default.removeItem(atPath: path)
    }
}

@Suite struct TrimAux {
    @Test func stripsExactlyTheHeader() throws {
        let t = TempDir()
        var bytes = [UInt8](repeating: 0xAA, count: 0x4000)
        bytes += (0..<5000).map { UInt8(truncatingIfNeeded: $0) }
        let input = t.file("aux.img", bytes)
        let out = t.path + "/aux.trimmed"
        let n = try trimPrefix(input: input, output: out, skip: 0x4000, cap: 1 << 30)
        #expect(n == 5000)
        let got = try Data(contentsOf: URL(fileURLWithPath: out))
        #expect(Array(got) == Array(bytes[0x4000...]))
        var st = stat()
        #expect(stat(out, &st) == 0)
        #expect(st.st_mode & 0o777 == 0o600, "outputs are 0600 (PATH-6)")
    }

    @Test(arguments: [0, 1, 0x3FFF, 0x4000])
    func tooShortRefused(_ size: Int) {
        let t = TempDir()
        let input = t.file("aux.img", [UInt8](repeating: 1, count: size))
        let out = t.path + "/out"
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: input, output: out, skip: 0x4000, cap: 1 << 30)
        }
        #expect(!FileManager.default.fileExists(atPath: out), "no output on failure")
    }

    @Test func existingOutputNeverOverwritten() throws {
        let t = TempDir()
        let input = t.file("aux.img", [UInt8](repeating: 1, count: 0x5000))
        let out = t.file("precious", Array("keep me".utf8))
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: input, output: out, skip: 0x4000, cap: 1 << 30)
        }
        #expect(try String(contentsOfFile: out, encoding: .utf8) == "keep me")
    }

    @Test func outputIsInputRefused() {
        let t = TempDir()
        let input = t.file("aux.img", [UInt8](repeating: 1, count: 0x5000))
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: input, output: input, skip: 0x4000, cap: 1 << 30)
        }
        #expect((try? Data(contentsOf: URL(fileURLWithPath: input)).count) == 0x5000)
    }

    @Test func plantedOutputSymlinkNotFollowed() throws {
        let t = TempDir()
        let input = t.file("aux.img", [UInt8](repeating: 1, count: 0x5000))
        let victim = t.file("victim", Array("secret".utf8))
        let link = t.path + "/out"
        #expect(symlink(victim, link) == 0)
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: input, output: link, skip: 0x4000, cap: 1 << 30)
        }
        #expect(try String(contentsOfFile: victim, encoding: .utf8) == "secret")
    }

    @Test func symlinkedAuxInBundleRefused() {
        let t = TempDir()
        let real = t.file("real", [UInt8](repeating: 1, count: 0x5000))
        let aux = t.path + "/aux.img"
        #expect(symlink(real, aux) == 0)
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: aux, output: t.path + "/out", skip: 0x4000, cap: 1 << 30)
        }
    }

    @Test func capEnforced() {
        let t = TempDir()
        let input = t.file("aux.img", [UInt8](repeating: 1, count: 0x5000))
        #expect(throws: VZMacError.self) {
            try trimPrefix(input: input, output: t.path + "/out", skip: 0x4000, cap: 0x4FFF)
        }
    }
}

@Suite struct Inputs {
    @Test(arguments: ["/dev/zero", "/dev/null", "/"])
    func nonRegularRefused(_ path: String) {
        #expect(throws: VZMacError.usage("not a regular file: \(debugQuoted(path))")) {
            try checkInput(path, follow: .follow, cap: 1 << 40)
        }
    }

    @Test func fifoRefusedWithoutBlocking() {
        // A read-only open of a FIFO with no writer blocks; `openInput` opens O_NONBLOCK, so a
        // FIFO is refused at once by the regular-file check (PATH-2) instead of hanging.
        let t = TempDir()
        let fifo = t.path + "/fifo"
        #expect(mkfifo(fifo, 0o600) == 0)
        #expect(throws: VZMacError.usage("not a regular file: \(debugQuoted(fifo))")) {
            try checkInput(fifo, follow: .follow, cap: 1 << 20)
        }
    }

    @Test func userSymlinkFollowedBundleSymlinkNot() throws {
        let t = TempDir()
        let real = t.file("Image", [UInt8](repeating: 0, count: 64))
        let link = t.path + "/link"
        #expect(symlink(real, link) == 0)
        _ = try checkInput(link, follow: .follow, cap: 1 << 20)  // PATH-1: user intent
        #expect(throws: VZMacError.self) { try checkInput(link, follow: .noFollow, cap: 1 << 20) }
    }

    @Test func sizeCap() {
        let t = TempDir()
        let f = t.file("big", [UInt8](repeating: 0, count: 100))
        #expect(throws: VZMacError.self) { try checkInput(f, follow: .follow, cap: 99) }
    }

    @Test func prefixOfShortFile() throws {
        let t = TempDir()
        let f = t.file("short", [1, 2, 3])
        #expect(try readPrefix(f, count: 64, follow: .follow, cap: 1 << 20) == [1, 2, 3])
    }
}

@Suite struct Directories {
    @Test func bundleDirectoryRules() throws {
        let t = TempDir()
        let b = t.path + "/bundle"
        try createPrivateDirectory(b)
        try checkPrivateDirectory(b)
        #expect(throws: VZMacError.self) { try createPrivateDirectory(b) }  // never reused
        #expect(chmod(b, 0o777) == 0)
        #expect(throws: VZMacError.self) { try checkPrivateDirectory(b) }  // SC-3
        let link = t.path + "/link"
        #expect(symlink(b, link) == 0)
        #expect(throws: VZMacError.self) { try checkPrivateDirectory(link) }
    }

    @Test func sparseDisk() throws {
        let t = TempDir()
        let d = t.path + "/disk.img"
        try createSparseFile(d, size: 1 << 30)
        var st = stat()
        #expect(stat(d, &st) == 0)
        #expect(st.st_size == 1 << 30)
        #expect(st.st_blocks < 1024, "sparse: no blocks allocated")
        #expect(throws: VZMacError.self) { try createSparseFile(t.path + "/odd.img", size: 1000) }
        #expect(throws: VZMacError.self) { try createSparseFile(d, size: 1 << 20) }  // exists
    }

    @Test func bundlePathsNormalised() {
        #expect(MacBundle(path: "/x/y///").aux == "/x/y/aux.img")
        #expect(MacBundle(path: "/").path == "/")
    }
}
