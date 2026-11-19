// Host-only tests for vz-mac's CLI parsing (threat model PATH-8): unknown, repeated or missing
// options are usage errors; sizes never wrap; counts are range-checked. None creates a VM.
import Testing

@testable import vz_mac

@Suite struct OptionParsing {
    @Test func acceptsValuedAndSwitch() throws {
        let o = try parseOptions(["--kernel", "K", "--dry-run"], valued: ["--kernel"], switches: ["--dry-run"])
        #expect(o.value("--kernel") == "K")
        #expect(o.has("--dry-run"))
    }

    @Test(arguments: [
        ["--bogus"],  // unknown option
        ["--kernel"],  // missing value
        ["--kernel", "a", "--kernel", "b"],  // repeated
        ["--dry-run", "--dry-run"],  // repeated switch
        ["stray"],  // positional
        ["-k", "K"],  // short options are not accepted
    ])
    func rejectsBadArgs(_ args: [String]) {
        #expect(throws: VZMacError.self) {
            try parseOptions(args, valued: ["--kernel"], switches: ["--dry-run"])
        }
        do {
            _ = try parseOptions(args, valued: ["--kernel"], switches: ["--dry-run"])
        } catch {
            #expect(error.status == .usage)
        }
    }

    @Test func requiredOptionMissing() {
        let o = Options()
        #expect(throws: VZMacError.usage("missing required option --bundle")) {
            try o.required("--bundle")
        }
    }

    @Test func valueMayLookLikeAFlag() throws {
        // `--cmdline --x` takes "--x" as the value, like getopt: values are never re-parsed.
        let o = try parseOptions(["--cmdline", "--x"], valued: ["--cmdline"], switches: [])
        #expect(o.value("--cmdline") == "--x")
    }
}

@Suite struct SizeParsing {
    @Test(arguments: [
        ("512M", UInt64(512) << 20), ("1G", UInt64(1) << 30), ("4k", UInt64(4096)), ("0", UInt64(0)),
        ("1048576", UInt64(1_048_576)), ("2T", UInt64(2) << 40),
        ("16777215T", UInt64(16_777_215) << 40),
    ])
    func valid(_ text: String, _ value: UInt64) throws {
        #expect(try parseSize(text) == value)
    }

    @Test(arguments: [
        "", "M", "12X", "-1", "+5", "1.5G", " 1G", "1G ", "1GB", "0x10", "99999999999G",
        "16777216T", "18446744073709551616", "１２", "1\u{0}", String(repeating: "9", count: 40),
        "١٢٣",  // Arabic-Indic digits are numbers to Swift, not to us
    ])
    func invalid(_ text: String) {
        #expect(throws: VZMacError.self) { try parseSize(text) }
    }
}

@Suite struct CountParsing {
    @Test func inRange() throws {
        #expect(try parseCount("4", name: "--cpus", range: 1...64) == 4)
        #expect(try parseCount("64", name: "--cpus", range: 1...64) == 64)
    }

    @Test(arguments: ["0", "65", "-1", "", "4x", "99999999999999999999", " 4", "٤"])
    func outOfRange(_ text: String) {
        #expect(throws: VZMacError.self) { try parseCount(text, name: "--cpus", range: 1...64) }
    }
}

@Suite struct Quoting {
    @Test func escapesControls() {
        #expect(debugQuoted("a\u{1b}]0;x\u{7}b") == "\"a\\u{1b}]0;x\\u{7}b\"")
        #expect(debugQuoted("\u{9b}31m") == "\"\\u{9b}31m\"")
        #expect(debugQuoted("q\"\\") == "\"q\\\"\\\\\"")
    }

    @Test func truncatesLongInput() {
        let q = debugQuoted(String(repeating: "a", count: 10_000))
        #expect(q.count < 300)
        #expect(q.hasSuffix("…\""))
    }
}

@Suite struct LinuxRequestParsing {
    @Test func defaults() throws {
        let r = try parseLinux(["--kernel", "K", "--initrd", "I", "--cmdline", "console=hvc0"])
        #expect(r.memory == 512 << 20)
        #expect(r.cpus == 2)
        #expect(r.seconds == nil)
        #expect(!r.dryRun)
    }

    @Test(arguments: [
        ["--initrd", "I", "--cmdline", "c"],  // no kernel
        ["--kernel", "K", "--cmdline", "c"],  // no initrd
        ["--kernel", "K", "--initrd", "I"],  // no cmdline
        ["--kernel", "K", "--initrd", "I", "--cmdline", "c", "--mem", "1000K"],  // not MiB-aligned
        ["--kernel", "K", "--initrd", "I", "--cmdline", "c", "--cpus", "0"],
        ["--kernel", "K", "--initrd", "I", "--cmdline", "c", "--seconds", "0"],
        ["--kernel", "K", "--initrd", "I", "--cmdline", "c\u{1b}[2J"],  // escape in cmdline
        ["--kernel", "K", "--initrd", "I", "--cmdline", "a\nb"],
        ["--kernel", "K", "--initrd", "I", "--cmdline", String(repeating: "x", count: 2048)],
    ])
    func rejects(_ args: [String]) {
        #expect(throws: VZMacError.self) { try parseLinux(args) }
    }

    @Test func cmdlineAtLimit() throws {
        try checkCmdline(String(repeating: "x", count: maxCmdlineBytes))
    }
}
