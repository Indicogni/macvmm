// Trust-on-first-use cache decisions (DECISIONS D3, threat model SC-10), the download redirect
// policy (SC-2) and the console's TTY-7 line tracking. None of these needs a VZ object or the
// network: `tofuDecision` reads only the cache directory, the redirect delegate method is
// called directly on a task that is never resumed, and the console pump reads from a pipe.
import CryptoKit
import Darwin
import Foundation
import Testing

@testable import vz_mac

private func sha256Hex(_ bytes: [UInt8]) -> String {
    SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
}

private func recordText(sha: String, size: Int) -> [UInt8] {
    Array(
        TOFURecord(sha256: sha, size: UInt64(size), url: "https://updates.cdn-apple.com/x.ipsw")
            .serialized(firstSeen: "2026-11-18T00:00:00Z").utf8)
}

@Suite struct TOFUCacheDecision {
    let payload: [UInt8] = Array("not really an ipsw".utf8)

    private func paths(_ t: TempDir) -> (String, String) {
        (t.path + "/27C101.ipsw", t.path + "/27C101.ipsw.tofu")
    }

    private func expectFatal(_ t: TempDir, _ needle: String) {
        let (ipsw, rec) = paths(t)
        do {
            let d = try tofuDecision(ipsw: ipsw, recordPath: rec)
            Issue.record("expected a fatal error containing \(needle.debugDescription), got \(d)")
        } catch {
            #expect(error.status == .error)
            #expect(error.description.contains(needle), "\(error.description)")
        }
    }

    @Test func emptyCacheDownloads() throws {
        let t = TempDir()
        let (ipsw, rec) = paths(t)
        #expect(try tofuDecision(ipsw: ipsw, recordPath: rec) == .download)
    }

    @Test func matchingRecordReuses() throws {
        let t = TempDir()
        let (ipsw, rec) = paths(t)
        _ = t.file("27C101.ipsw", payload)
        _ = t.file("27C101.ipsw.tofu", recordText(sha: sha256Hex(payload), size: payload.count))
        #expect(
            try tofuDecision(ipsw: ipsw, recordPath: rec)
                == .reuse(sha256: sha256Hex(payload), size: UInt64(payload.count)))
    }

    @Test func mismatchedSHAIsFatal() {
        let t = TempDir()
        _ = t.file("27C101.ipsw", payload)
        _ = t.file("27C101.ipsw.tofu", recordText(sha: String(repeating: "0", count: 64), size: payload.count))
        expectFatal(t, "does not match its first-use record")
    }

    @Test func mismatchedSizeIsFatal() {
        let t = TempDir()
        _ = t.file("27C101.ipsw", payload)
        _ = t.file("27C101.ipsw.tofu", recordText(sha: sha256Hex(payload), size: payload.count + 1))
        expectFatal(t, "does not match its first-use record")
    }

    @Test func recordWithoutIPSWIsFatal() {
        let t = TempDir()
        _ = t.file("27C101.ipsw.tofu", recordText(sha: sha256Hex(payload), size: payload.count))
        expectFatal(t, "the IPSW")
    }

    @Test func ipswWithoutRecordIsFatal() {
        let t = TempDir()
        _ = t.file("27C101.ipsw", payload)
        expectFatal(t, "has no TOFU record")
    }

    /// An empty record is what an interrupted non-atomic write leaves; it must fail closed
    /// before any download, never be read as "no record".
    @Test(arguments: [[UInt8](), Array("sha256 xyz\n".utf8), [0xFF, 0xFE, 0x00]])
    func malformedRecordIsFatalBeforeDownload(_ bytes: [UInt8]) {
        let t = TempDir()
        _ = t.file("27C101.ipsw.tofu", bytes)
        expectFatal(t, "unreadable or malformed")
    }

    @Test func symlinkedRecordIsFatal() throws {
        let t = TempDir()
        let (_, rec) = paths(t)
        let real = t.file("elsewhere", recordText(sha: sha256Hex(payload), size: payload.count))
        _ = t.file("27C101.ipsw", payload)
        #expect(symlink(real, rec) == 0)
        expectFatal(t, "unreadable or malformed")
    }

    @Test func symlinkedIPSWIsFatal() throws {
        let t = TempDir()
        let (ipsw, _) = paths(t)
        let real = t.file("elsewhere.ipsw", payload)
        _ = t.file("27C101.ipsw.tofu", recordText(sha: sha256Hex(payload), size: payload.count))
        #expect(symlink(real, ipsw) == 0)
        do {
            _ = try tofuDecision(ipsw: ipsw, recordPath: paths(t).1)
            Issue.record("a symlinked cached IPSW was accepted")
        } catch {
            #expect(error.description.contains("refusing symlink"), "\(error.description)")
        }
    }

    @Test func recordIsWrittenAtomicallyAndNeverReplaced() throws {
        let t = TempDir()
        let (_, rec) = paths(t)
        let r = TOFURecord(sha256: sha256Hex(payload), size: UInt64(payload.count), url: "https://apple.com/x")
        _ = t.file("27C101.ipsw.tofu.tmp", Array("stale".utf8))  // left by an interrupted run
        try writeTOFURecord(r, to: rec, firstSeen: "now")
        let text = String(decoding: try readSmallFile(rec, follow: .noFollow, cap: 4096), as: UTF8.self)
        #expect(TOFURecord.parse(text) == r)
        #expect(!FileManager.default.fileExists(atPath: rec + ".tmp"))
        #expect(throws: VZMacError.self) { try writeTOFURecord(r, to: rec, firstSeen: "again") }
        #expect(!FileManager.default.fileExists(atPath: rec + ".tmp"))
    }
}

/// Collects what the redirect delegate method decided.
private final class RedirectBox: @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [URLRequest?] = []
    func put(_ r: URLRequest?) {
        lock.lock()
        answers.append(r)
        lock.unlock()
    }
    var all: [URLRequest?] {
        lock.lock()
        defer { lock.unlock() }
        return answers
    }
}

@Suite struct RedirectPolicy {
    private func decide(_ target: String) -> URLRequest?? {
        let dl = IPSWDownload(destination: "/nonexistent/never-written")
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        // Never resumed: no network traffic.
        let task = session.downloadTask(with: URL(string: "https://updates.cdn-apple.com/a.ipsw")!)
        let response = HTTPURLResponse(
            url: URL(string: "https://updates.cdn-apple.com/a.ipsw")!, statusCode: 302,
            httpVersion: "HTTP/1.1", headerFields: ["Location": target])!
        let box = RedirectBox()
        dl.urlSession(
            session, task: task, willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: target)!), completionHandler: { box.put($0) })
        #expect(box.all.count == 1, "the completion handler is called exactly once")
        return box.all.first
    }

    @Test(arguments: ["https://swcdn.apple.com/b.ipsw", "https://updates.cdn-apple.com/c.ipsw"])
    func appleHTTPSRedirectFollowed(_ target: String) {
        #expect(decide(target)??.url?.absoluteString == target)
    }

    @Test(arguments: [
        "http://updates.cdn-apple.com/b.ipsw",  // downgrade to HTTP
        "https://evil.example/b.ipsw",
        "https://updates.cdn-apple.com.evil.example/b.ipsw",
        "https://u:p@swcdn.apple.com/b.ipsw",
        "ftp://swcdn.apple.com/b.ipsw",
    ])
    func otherRedirectRefused(_ target: String) {
        let answer = decide(target)
        #expect(answer != nil, "the completion handler was called")
        #expect(answer! == nil, "redirect to \(target) must be refused")
    }
}

@Suite struct ConsoleLineTracking {
    /// Feed `bytes` through a pump whose output is a pipe; return whether the pump reports the
    /// cursor at column 0 and what it wrote.
    private func pump(_ bytes: [UInt8]) -> (Bool, [UInt8]) {
        var fds: [Int32] = [0, 0]
        #expect(pipe(&fds) == 0)
        let p = ConsolePump(output: fds[1])
        p.start()
        let w = p.guestOutput.fileHandleForWriting
        if !bytes.isEmpty { w.write(Data(bytes)) }
        try? w.close()
        let atStart = p.drain()
        close(fds[1])
        let reader = FileHandle(fileDescriptor: fds[0], closeOnDealloc: true)
        let out = [UInt8](reader.readDataToEndOfFile())
        return (atStart, out)
    }

    @Test func partialPromptIsMidLine() {
        let (atStart, out) = pump(Array("booted\nroot@host:~# ".utf8))
        #expect(!atStart, "TTY-7: vz-mac must print a newline before its last line")
        #expect(out == Array("booted\nroot@host:~# ".utf8))
    }

    @Test func completeLineIsAtLineStart() {
        #expect(pump(Array("reboot: Power down\n".utf8)).0)
    }

    @Test func carriageReturnDoesNotCount() {
        // CR leaves the fake prompt's tail on screen if our line is shorter, so only LF counts.
        #expect(!pump(Array("root@host:~# \r".utf8)).0)
    }

    @Test func noOutputIsAtLineStart() {
        #expect(pump([]).0)
    }
}
