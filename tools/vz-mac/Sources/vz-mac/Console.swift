// Console.swift: the guest console (virtio-console `hvc0`) as seen from the host terminal.
//
// Why a filter: everything the guest writes to its console is attacker-controlled (threat model
// A1, surface S11). Raw guest bytes on a terminal can retitle it, write the clipboard (OSC 52),
// query it so its reply lands in the host shell, or exploit terminal-emulator bugs (TTY-1,
// assets AS2). macvmm applies its `AnsiFilter` to every guest byte stream regardless of
// `isatty` (TTY-1). vz-mac is a demonstration tool for boot logs, not an interactive terminal,
// so it applies the simplest policy in the threat model: **`strict`** (TTY-5):
//   - printable ASCII and valid UTF-8 pass, plus CR, LF, HT and BS;
//   - every other C0 control is rendered visibly in caret form (`ESC` → `^[`, `BEL` → `^G`),
//     and DEL → `^?`;
//   - C1 controls (U+0080–U+009F) are rendered visibly whether raw 8-bit (`\x9b`) or
//     UTF-8-encoded (`\u{9b}`), because some terminals act on either;
//   - invalid or overlong UTF-8 and surrogates → U+FFFD.
// The filter is a streaming state machine: O(1) per byte, at most 3 bytes of pending state, and
// it cannot fail. Because nothing the guest sends can set a terminal mode, the exit-hygiene
// reset of TTY-6 is not needed; TTY-7 (our last line is ours) is kept: the pump remembers whether
// the last byte it wrote was LF, and if the guest left the cursor mid-line (a drawn fake prompt
// such as `root@host:~# `) vz-mac prints a newline before its final `vz-mac: …` line on stderr.
//
// Data path: VZ writes the guest's console bytes into a pipe (`VZFileHandleSerialPortAttachment`,
// `VZFileHandleSerialPortAttachment.h`); a dedicated reader thread filters them into stdout.
// Host keyboard input goes the other way unfiltered (it is the user's own input).
import Darwin
import Foundation

/// TTY-5 `strict` output filter for guest console bytes.
struct StrictConsoleFilter {
    /// Bytes of an incomplete UTF-8 sequence (at most 3 are ever held).
    private var pending: [UInt8] = []
    /// Total length of the sequence `pending` started, or 0 when idle.
    private var expected = 0

    private static let replacement: [UInt8] = [0xEF, 0xBF, 0xBD]  // U+FFFD

    /// Filter `input`, appending the bytes that are safe to show to `out`.
    mutating func feed<S: Sequence>(_ input: S, into out: inout [UInt8]) where S.Element == UInt8 {
        for b in input { feedByte(b, into: &out) }
    }

    /// End of stream: an unfinished UTF-8 sequence becomes U+FFFD.
    mutating func finish(into out: inout [UInt8]) {
        if expected != 0 {
            out += Self.replacement
            pending.removeAll(keepingCapacity: true)
            expected = 0
        }
    }

    // ANCHOR: vz_console_filter
    private mutating func feedByte(_ b: UInt8, into out: inout [UInt8]) {
        if expected != 0 {
            if b & 0xC0 == 0x80 {
                pending.append(b)
                if pending.count == expected { completeSequence(into: &out) }
                return
            }
            // A lead or ASCII byte cut the sequence short: replace it, then handle `b` afresh.
            out += Self.replacement
            pending.removeAll(keepingCapacity: true)
            expected = 0
        }
        switch b {
        case 0x20...0x7E, 0x0A, 0x0D, 0x09, 0x08:
            out.append(b)
        case 0x00...0x1F:
            out += [UInt8(ascii: "^"), b + 0x40]  // ESC -> ^[, BEL -> ^G, NUL -> ^@
        case 0x7F:
            out += Array("^?".utf8)
        case 0x80...0x9F:
            out += Array(String(format: "\\x%02x", b).utf8)  // raw 8-bit C1, e.g. CSI 0x9b
        case 0xC2...0xDF:
            start(b, length: 2)
        case 0xE0...0xEF:
            start(b, length: 3)
        case 0xF0...0xF4:
            start(b, length: 4)
        default:  // 0xA0...0xBF stray continuation, 0xC0, 0xC1, 0xF5...0xFF never valid
            out += Self.replacement
        }
    }

    // ANCHOR_END: vz_console_filter

    private mutating func start(_ lead: UInt8, length: Int) {
        pending.removeAll(keepingCapacity: true)
        pending.append(lead)
        expected = length
    }

    // ANCHOR: vz_console_utf8
    private mutating func completeSequence(into out: inout [UInt8]) {
        var cp: UInt32
        switch expected {
        case 2: cp = UInt32(pending[0] & 0x1F)
        case 3: cp = UInt32(pending[0] & 0x0F)
        default: cp = UInt32(pending[0] & 0x07)
        }
        for c in pending.dropFirst() { cp = (cp << 6) | UInt32(c & 0x3F) }
        let minimum: UInt32 = expected == 2 ? 0x80 : (expected == 3 ? 0x800 : 0x1_0000)
        if cp < minimum || cp > 0x10_FFFF || (0xD800...0xDFFF).contains(cp) {
            out += Self.replacement  // overlong, out of range, or a surrogate
        } else if (0x80...0x9F).contains(cp) {
            out += Array(String(format: "\\u{%x}", cp).utf8)  // UTF-8-encoded C1
        } else {
            out += pending
        }
        pending.removeAll(keepingCapacity: true)
        expected = 0
    }
    // ANCHOR_END: vz_console_utf8
}

/// Copies guest console bytes from a pipe to stdout through `StrictConsoleFilter`, on its own
/// thread, so a slow terminal never stalls the main queue that drives the VM.
final class ConsolePump: @unchecked Sendable {
    /// The pipe VZ writes guest output into. Its write end goes to the serial-port attachment.
    let guestOutput = Pipe()
    private let lock = NSLock()
    private var stopping = false
    private let idle = DispatchSemaphore(value: 0)
    private var thread: Thread?
    /// Where filtered output goes: stdout, or a pipe in tests.
    private let outputFD: Int32
    private var bytesIn: UInt64 = 0
    /// TTY-7: true while the last byte written to stdout was LF (or nothing was written).
    private var atLineStart = true

    /// Total guest console bytes read so far.
    var totalBytes: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return bytesIn
    }

    init(output: Int32 = STDOUT_FILENO) {
        self.outputFD = output
    }

    /// Start the reader thread.
    func start() {
        let t = Thread { [self] in self.run() }
        t.name = "vz-mac console"
        thread = t
        t.start()
    }

    private func isStopping() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopping
    }

    private func run() {
        let fd = guestOutput.fileHandleForReading.fileDescriptor
        var filter = StrictConsoleFilter()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        var out: [UInt8] = []
        out.reserveCapacity(4 * buf.count)
        while true {
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, 100)
            if ready < 0 && errno == EINTR { continue }
            if ready <= 0 {
                // Idle for 100 ms: if the VM has stopped, everything it wrote has been drained.
                if isStopping() { break }
                continue
            }
            let n = buf.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }  // EOF or error: nothing more will arrive
            lock.lock()
            bytesIn += UInt64(n)
            lock.unlock()
            out.removeAll(keepingCapacity: true)
            filter.feed(buf[0..<n], into: &out)
            emit(out)
        }
        out.removeAll(keepingCapacity: true)
        filter.finish(into: &out)
        emit(out)
        idle.signal()
    }

    /// Write filtered bytes to stdout and remember whether they ended a line (TTY-7).
    private func emit(_ out: [UInt8]) {
        guard let last = out.last else { return }
        _ = out.withUnsafeBytes { writeAll(outputFD, $0) }
        lock.lock()
        atLineStart = last == 0x0A
        lock.unlock()
    }

    /// Called once the VM has stopped: wait (at most `timeout` seconds) until the pipe has been
    /// idle for 100 ms, so the guest's last lines reach stdout before the tool exits. Returns
    /// whether the guest's output ended at the start of a line (TTY-7: if not, the caller prints
    /// a newline before its own last line).
    @discardableResult
    func drain(timeout: Double = 2.0) -> Bool {
        lock.lock()
        let already = stopping
        stopping = true
        lock.unlock()
        if !already, thread != nil {
            _ = idle.wait(timeout: .now() + timeout)
        }
        lock.lock()
        defer { lock.unlock() }
        return atLineStart
    }
}
