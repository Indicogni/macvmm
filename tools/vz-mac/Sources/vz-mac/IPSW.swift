// IPSW.swift: getting a macOS restore image (`.ipsw`) for `vz-mac install`.
//
// Why this is the one download that is not sha256-pinned: Apple rotates restore-image URLs and
// publishes no stable hash, so `--latest` cannot use `scripts/fetch-manifest.txt`. The lead's
// decision **DECISIONS D3** allows exactly this exception (ADR-0008 decision 5, threat model
// SC-10):
//   - the URL is the one Virtualization.framework returns
//     (`VZMacOSRestoreImage.fetchLatestSupported`, `VZMacOSRestoreImage.h`);
//   - it must be HTTPS on an Apple host, and so must every redirect (SC-2's
//     `--proto-redir '=https'`, enforced in `urlSession(_:task:willPerformHTTPRedirection:…)`);
//   - trust on first use: the first download's size and sha256 are printed and recorded in
//     `${MACVMM_CACHE}/ipsw/<build>.ipsw.tofu`; a later mismatch is fatal;
//   - the real integrity check is Apple's: the restore payloads are signed and verified by
//     VZ/AVPBooter during install. Nothing from the IPSW is ever executed, mounted or unpacked
//     on the host (SC-4); vz-mac only hashes it and passes its path to VZ;
//   - opt-in only: never run by `test.sh` or any default test.
// A user-supplied `--ipsw F` is preferred and documented first; it is hashed and recorded the
// same way (in the bundle's `bundle-info.txt`).
import CryptoKit
import Darwin
import Foundation
@preconcurrency import Virtualization

/// Largest IPSW accepted (bytes). macOS 27 restore images are ~18 GB.
let maxIPSWBytes: UInt64 = 40 << 30

/// The download/restore-image URL policy: HTTPS, no credentials, an Apple host.
func isAllowedIPSWURL(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil,
        let host = url.host?.lowercased(), !host.isEmpty
    else { return false }
    // A port other than the default is not expected from Apple's CDN.
    if let port = url.port, port != 443 { return false }
    return host == "apple.com" || host.hasSuffix(".apple.com") || host.hasSuffix(".cdn-apple.com")
}

/// A restore image build number (e.g. `25A5279m`) becomes a file name, so it must be short and
/// alphanumeric: no `/`, no `..`, nothing a server could use to steer a path (PATH-7).
func isValidBuildVersion(_ s: String) -> Bool {
    (1...16).contains(s.utf8.count) && s.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) }
}

/// Streaming sha256 of a file, read through `openInput` (regular file, size cap).
func sha256File(_ path: String, follow: FollowPolicy, cap: UInt64) throws(VZMacError) -> (
    String, UInt64
) {
    let (fd, info) = try openInput(path, follow: follow, cap: cap)
    defer { close(fd) }
    var hasher = SHA256()
    var buf = [UInt8](repeating: 0, count: 8 << 20)
    var total: UInt64 = 0
    while true {
        let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
        if n < 0 {
            if errno == EINTR { continue }
            throw .failure("read \(debugQuoted(path)): \(String(cString: strerror(errno)))")
        }
        if n == 0 { break }
        buf.withUnsafeBytes { hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: $0[0..<n])) }
        total += UInt64(n)
        guard total <= cap else { throw .usage("\(debugQuoted(path)) grew past \(cap) bytes") }
    }
    _ = info
    let hex = hasher.finalize().map { String(format: "%02x", $0) }.joined()
    return (hex, total)
}

/// The TOFU record next to a cached IPSW.
struct TOFURecord: Equatable {
    var sha256: String
    var size: UInt64
    var url: String

    func serialized(firstSeen: String) -> String {
        "# vz-mac trust-on-first-use record (DECISIONS D3)\nsha256 \(sha256)\nsize \(size)\nurl \(url)\nfirst-seen \(firstSeen)\n"
    }

    /// Parse a record; `nil` for anything malformed (a fatal error in `tofuDecision`, never
    /// "no record").
    static func parse(_ text: String) -> TOFURecord? {
        var sha: String?
        var size: UInt64?
        var url: String?
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("#") { continue }
            let parts = line.split(separator: " ", maxSplits: 1)
            guard parts.count == 2 else { return nil }
            let value = String(parts[1])
            switch parts[0] {
            case "sha256":
                guard value.utf8.count == 64,
                    value.utf8.allSatisfy({ (0x30...0x39).contains($0) || (0x61...0x66).contains($0) })
                else { return nil }
                sha = value
            case "size": size = UInt64(value)
            case "url": url = value
            case "first-seen": break
            default: return nil
            }
        }
        guard let sha, let size, let url else { return nil }
        return TOFURecord(sha256: sha, size: size, url: url)
    }
}

/// `${MACVMM_CACHE:-$HOME/.cache/macvmm}/ipsw`, created 0700 and checked (SC-3).
func ipswCacheDirectory() throws(VZMacError) -> String {
    let env = ProcessInfo.processInfo.environment
    let base: String
    if let c = env["MACVMM_CACHE"], !c.isEmpty {
        guard c.hasPrefix("/") else { throw .usage("MACVMM_CACHE must be an absolute path") }
        base = c
    } else if let home = env["HOME"], home.hasPrefix("/") {
        base = home + "/.cache/macvmm"
    } else {
        throw .usage("set MACVMM_CACHE (no HOME)")
    }
    for dir in [base, base + "/ipsw"] {
        if mkdir(dir, 0o700) != 0 && errno != EEXIST {
            throw .usage("cannot create \(debugQuoted(dir)): \(String(cString: strerror(errno)))")
        }
        try checkPrivateDirectory(dir)
    }
    return base + "/ipsw"
}

/// Download `url` to `destination` (which must not exist), HTTPS-only including redirects, at
/// most `maxIPSWBytes`, printing progress on stderr.
final class IPSWDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let destination: String
    private let lock = NSLock()
    private var result: Result<Void, VZMacError>?
    private var lastPercent = -1
    private let done = DispatchSemaphore(value: 0)

    init(destination: String) {
        self.destination = destination
    }

    /// Blocking: run on a background thread, never on the main queue.
    func run(_ url: URL) -> Result<Void, VZMacError> {
        let config = URLSessionConfiguration.ephemeral  // no cookies, no shared cache
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session.downloadTask(with: url).resume()
        done.wait()
        session.finishTasksAndInvalidate()
        lock.lock()
        defer { lock.unlock() }
        return result ?? .failure(.failure("download ended without a result"))
    }

    private func complete(_ r: Result<Void, VZMacError>) {
        lock.lock()
        let first = result == nil
        if first { result = r }
        lock.unlock()
        if first { done.signal() }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        if let next = request.url, isAllowedIPSWURL(next) {
            completionHandler(request)
        } else {
            complete(.failure(.failure("refusing redirect to a non-HTTPS or non-Apple URL")))
            task.cancel()
            completionHandler(nil)
        }
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesWritten > Int64(maxIPSWBytes) || totalBytesExpectedToWrite > Int64(maxIPSWBytes) {
            complete(.failure(.failure("IPSW larger than the \(maxIPSWBytes)-byte limit")))
            downloadTask.cancel()
            return
        }
        guard totalBytesExpectedToWrite > 0 else { return }
        let percent = Int(totalBytesWritten * 100 / totalBytesExpectedToWrite)
        lock.lock()
        let show = percent != lastPercent && percent % 5 == 0
        if show { lastPercent = percent }
        lock.unlock()
        if show { note("download \(percent)% of \(totalBytesExpectedToWrite) bytes") }
    }

    func urlSession(
        _ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL
    ) {
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            complete(.failure(.failure("HTTP status \(http.statusCode)")))
            return
        }
        // The temporary file disappears when this method returns: move it now. moveItem refuses
        // an existing destination, so a planted file or link is never overwritten.
        do {
            try FileManager.default.moveItem(atPath: location.path, toPath: destination)
            complete(.success(()))
        } catch {
            complete(.failure(.failure("cannot move the download into place: \(describe(error))")))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        if let error {
            complete(.failure(.failure("download failed: \(describe(error))")))
        } else {
            complete(.failure(.failure("download finished without a file")))
        }
    }
}

/// What to do about `<build>.ipsw` in the cache, decided from the cache alone (no VZ object, so
/// it is unit-tested). Trust on first use (DECISIONS D3, threat model SC-10) fails closed:
///
/// | record (`.tofu`)            | IPSW      | decision |
/// |---|---|---|
/// | absent                      | absent    | `.download` (first use) |
/// | present, matches            | present   | `.reuse` (sha256 and size re-verified now) |
/// | present, sha256/size differ | present   | fatal: the cached file changed |
/// | present                     | absent    | fatal: the record must not be silently replaced |
/// | absent                      | present   | fatal: an IPSW nobody recorded is not trusted |
/// | unreadable, malformed, symlink, not a regular file | any | fatal, **before** any download |
///
/// A malformed record is never read as "no record": that would download ~18 GB and then fail
/// on the record that is still there.
enum TOFUDecision: Equatable {
    case download
    case reuse(sha256: String, size: UInt64)
}

/// `lstat` existence: `true`/`false`, or an error other than "not there".
private func entryExists(_ path: String) throws(VZMacError) -> Bool {
    var st = stat()
    if lstat(path, &st) == 0 { return true }
    let e = errno
    if e == ENOENT { return false }
    throw .failure("cannot stat \(debugQuoted(path)): \(String(cString: strerror(e)))")
}

func tofuDecision(ipsw: String, recordPath: String) throws(VZMacError) -> TOFUDecision {
    let hasRecord = try entryExists(recordPath)
    let hasIPSW = try entryExists(ipsw)
    guard hasRecord else {
        if hasIPSW {
            throw .failure(
                "\(debugQuoted(ipsw)) exists but has no TOFU record \(debugQuoted(recordPath)); vz-mac will not trust or overwrite it: pass it with --ipsw, or delete it to download afresh")
        }
        return .download
    }
    let record: TOFURecord
    do throws(VZMacError) {
        let data = try readSmallFile(recordPath, follow: .noFollow, cap: 4096)
        guard let text = String(data: data, encoding: .utf8), let r = TOFURecord.parse(text) else {
            throw VZMacError.failure("malformed")
        }
        record = r
    } catch {
        throw .failure(
            "TOFU record \(debugQuoted(recordPath)) is unreadable or malformed (\(error.description)); inspect it, and delete it (and \(debugQuoted(ipsw)) if present) only if you know why")
    }
    guard hasIPSW else {
        throw .failure(
            "a TOFU record exists but the IPSW \(debugQuoted(ipsw)) is missing; delete \(debugQuoted(recordPath)) to start over")
    }
    let (sha, size) = try sha256File(ipsw, follow: .noFollow, cap: maxIPSWBytes)
    guard sha == record.sha256, size == record.size else {
        throw .failure(
            "cached IPSW does not match its first-use record (sha256 \(sha) size \(size), recorded \(record.sha256) size \(record.size)); delete \(debugQuoted(ipsw)) and \(debugQuoted(recordPath)) only if you know why it changed")
    }
    return .reuse(sha256: sha, size: size)
}

/// Write a new TOFU record atomically: the bytes go to `<record>.tmp` first and are then
/// published with `link(2)`, which fails rather than replace an existing record, so a crash or
/// Ctrl-C never leaves a truncated record behind (it would be refused as malformed next time).
func writeTOFURecord(_ record: TOFURecord, to recordPath: String, firstSeen: String) throws(VZMacError) {
    let tmp = recordPath + ".tmp"
    unlink(tmp)  // a stale temporary from an interrupted run (unlink never follows a symlink)
    try writeNewFile(tmp, Data(record.serialized(firstSeen: firstSeen).utf8))
    defer { unlink(tmp) }
    guard link(tmp, recordPath) == 0 else {
        throw .failure("cannot publish \(debugQuoted(recordPath)): \(String(cString: strerror(errno)))")
    }
}

/// `--latest`: fetch the restore-image metadata from VZ, then download (or reuse) the IPSW
/// under the TOFU rules. Returns the local path, its sha256 and size.
func fetchLatestIPSW(_ image: VZMacOSRestoreImage) async throws(VZMacError) -> (String, String, UInt64) {
    let url = image.url
    guard isAllowedIPSWURL(url) else {
        throw .failure("restore image URL \(debugQuoted(url.absoluteString)) is not HTTPS on an Apple host")
    }
    let build = image.buildVersion
    guard isValidBuildVersion(build) else {
        throw .failure("unexpected build version \(debugQuoted(build))")
    }
    let dir = try ipswCacheDirectory()
    let ipsw = "\(dir)/\(build).ipsw"
    let recordPath = ipsw + ".tofu"

    note("checking \(debugQuoted(ipsw)) against its TOFU record")
    if case .reuse(let sha, let size) = try tofuDecision(ipsw: ipsw, recordPath: recordPath) {
        return (ipsw, sha, size)
    }
    let part = ipsw + ".part"
    unlink(part)  // a stale partial download (unlink never follows a symlink)
    note("downloading \(debugQuoted(url.absoluteString)) (build \(build)) to \(debugQuoted(part))")
    let downloader = IPSWDownload(destination: part)
    let outcome = await Task.detached { downloader.run(url) }.value
    if case .failure(let e) = outcome {
        unlink(part)
        throw e
    }
    let sha: String
    let size: UInt64
    do throws(VZMacError) {
        (sha, size) = try sha256File(part, follow: .noFollow, cap: maxIPSWBytes)
        let first = TOFURecord(sha256: sha, size: size, url: url.absoluteString)
        try writeTOFURecord(first, to: recordPath, firstSeen: ISO8601DateFormatter().string(from: Date()))
    } catch {
        unlink(part)
        throw error
    }
    // RENAME_EXCL: never replace an IPSW that appeared while we downloaded.
    guard renamex_np(part, ipsw, UInt32(RENAME_EXCL)) == 0 else {
        let e = errno
        unlink(part)
        unlink(recordPath)
        throw .failure("rename \(debugQuoted(part)): \(String(cString: strerror(e)))")
    }
    note("IPSW first use: size \(size) sha256 \(sha) recorded in \(debugQuoted(recordPath)) (DECISIONS D3)")
    return (ipsw, sha, size)
}
