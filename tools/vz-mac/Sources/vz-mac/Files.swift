// Files.swift: the only place vz-mac opens host files itself.
//
// Why a narrow, POSIX-level layer: the same path rules as macvmm apply (threat model §7.8):
//   - PATH-1/PATH-2: inputs are opened `O_RDONLY|O_CLOEXEC` and checked with `fstat` on the
//     descriptor (not the path), and must be regular files, so `/dev/zero` or a FIFO is refused
//     instead of read forever. User-given input symlinks are followed (user intent); files
//     *inside a bundle* are opened with `O_NOFOLLOW`, because vz-mac created them and a symlink
//     there means someone else changed the bundle.
//   - PATH-3/PATH-6: outputs are created `O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, never
//     truncating an existing file, so a planted `out -> ~/.ssh/authorized_keys` link is refused.
//   - SC-14: files a guest has written (aux.img, disk.img) are hostile to host *parsers*. vz-mac
//     never parses them: it hands them to Virtualization.framework or copies bytes (`trim-aux`).
//     It never mounts or attaches them (no `hdiutil attach`).
// Everything a guest can influence is read with an explicit byte cap.
import Darwin
import Foundation

/// How an input path is opened.
enum FollowPolicy {
    /// A path the user typed (`--kernel`, `--ipsw`): follow a symlink (PATH-1).
    case follow
    /// A file inside a bundle vz-mac created: refuse a symlink.
    case noFollow
}

/// The result of `fstat` on an opened input.
struct InputInfo {
    let size: UInt64
    let device: UInt64
    let inode: UInt64
}

private func errnoText(_ code: Int32 = errno) -> String {
    String(cString: strerror(code))
}

/// Open `path` read-only and check it is a regular file of at most `cap` bytes. Returns the
/// descriptor (the caller closes it) and its metadata.
func openInput(_ path: String, follow: FollowPolicy, cap: UInt64) throws(VZMacError) -> (
    Int32, InputInfo
) {
    // O_NONBLOCK: opening a FIFO read-only would otherwise block until a writer appears, so
    // `--kernel some-fifo` would hang instead of being refused. It is cleared again below once
    // fstat has shown a regular file (for which it has no effect anyway).
    var flags = O_RDONLY | O_CLOEXEC | O_NONBLOCK
    if follow == .noFollow { flags |= O_NOFOLLOW }
    let fd = open(path, flags)
    if fd < 0 {
        let e = errno
        if e == ELOOP {
            throw .usage("refusing symlink: \(debugQuoted(path))")
        }
        throw .usage("cannot open \(debugQuoted(path)): \(errnoText(e))")
    }
    var st = stat()
    guard fstat(fd, &st) == 0 else {
        let e = errno
        close(fd)
        throw .failure("fstat \(debugQuoted(path)): \(errnoText(e))")
    }
    guard (st.st_mode & S_IFMT) == S_IFREG else {
        close(fd)
        throw .usage("not a regular file: \(debugQuoted(path))")
    }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    let size = UInt64(max(st.st_size, 0))
    guard size <= cap else {
        close(fd)
        throw .usage("\(debugQuoted(path)) is \(size) bytes; the limit is \(cap)")
    }
    return (fd, InputInfo(size: size, device: UInt64(st.st_dev), inode: UInt64(st.st_ino)))
}

/// Check an input without keeping it open (VZ opens kernel, initrd and disks itself by URL).
func checkInput(_ path: String, follow: FollowPolicy, cap: UInt64) throws(VZMacError) -> InputInfo {
    let (fd, info) = try openInput(path, follow: follow, cap: cap)
    close(fd)
    return info
}

/// Read up to `count` bytes from the start of a file (for header checks).
func readPrefix(_ path: String, count: Int, follow: FollowPolicy, cap: UInt64) throws(VZMacError)
    -> [UInt8]
{
    let (fd, _) = try openInput(path, follow: follow, cap: cap)
    defer { close(fd) }
    var buf = [UInt8](repeating: 0, count: count)
    var got = 0
    while got < count {
        let n = buf.withUnsafeMutableBytes { raw in
            pread(fd, raw.baseAddress! + got, count - got, off_t(got))
        }
        if n < 0 {
            if errno == EINTR { continue }
            throw .failure("read \(debugQuoted(path)): \(errnoText())")
        }
        if n == 0 { break }
        got += n
    }
    return Array(buf.prefix(got))
}

/// Read a whole small file (at most `cap` bytes).
func readSmallFile(_ path: String, follow: FollowPolicy, cap: UInt64) throws(VZMacError) -> Data {
    let (fd, info) = try openInput(path, follow: follow, cap: cap)
    defer { close(fd) }
    var data = Data(count: Int(info.size))
    var got = 0
    let total = Int(info.size)
    while got < total {
        let n = data.withUnsafeMutableBytes { raw in
            read(fd, raw.baseAddress! + got, total - got)
        }
        if n < 0 {
            if errno == EINTR { continue }
            throw .failure("read \(debugQuoted(path)): \(errnoText())")
        }
        if n == 0 { break }  // the file shrank under us: return what is there
        got += n
    }
    return data.prefix(got)
}

/// Create a new output file: `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC`, mode 0600. An
/// existing file (or symlink) at `path` is refused, never truncated.
func createOutput(_ path: String) throws(VZMacError) -> Int32 {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    if fd < 0 {
        let e = errno
        if e == EEXIST {
            throw .usage("refusing to overwrite existing \(debugQuoted(path))")
        }
        throw .usage("cannot create \(debugQuoted(path)): \(errnoText(e))")
    }
    return fd
}

/// Write all of `bytes` to `fd`, retrying short writes and EINTR.
func writeAll(_ fd: Int32, _ bytes: UnsafeRawBufferPointer) -> Bool {
    var off = 0
    while off < bytes.count {
        let n = write(fd, bytes.baseAddress! + off, bytes.count - off)
        if n < 0 {
            if errno == EINTR { continue }
            return false
        }
        off += n
    }
    return true
}

/// Write `data` to a new 0600 file (see `createOutput`).
func writeNewFile(_ path: String, _ data: Data) throws(VZMacError) {
    let fd = try createOutput(path)
    let ok = data.withUnsafeBytes { writeAll(fd, $0) }
    let closed = close(fd) == 0
    guard ok, closed else {
        unlink(path)
        throw .failure("write \(debugQuoted(path)) failed: \(errnoText())")
    }
}

/// Create a new, empty, sparse file of `size` bytes (a raw disk image: VZ requires a multiple
/// of 512 bytes, `VZDiskImageStorageDeviceAttachment.h`).
func createSparseFile(_ path: String, size: UInt64) throws(VZMacError) {
    guard size % 512 == 0, size <= UInt64(Int64.max) else {
        throw .usage("disk size must be a multiple of 512 bytes")
    }
    let fd = try createOutput(path)
    let ok = ftruncate(fd, off_t(size)) == 0
    let e = errno
    close(fd)
    guard ok else {
        unlink(path)
        throw .failure("ftruncate \(debugQuoted(path)): \(errnoText(e))")
    }
}

/// Create a directory with mode 0700. It must not exist yet (a bundle is never reused or
/// merged), and its parent must exist.
func createPrivateDirectory(_ path: String) throws(VZMacError) {
    if mkdir(path, 0o700) != 0 {
        let e = errno
        if e == EEXIST {
            throw .usage("\(debugQuoted(path)) already exists; choose a new bundle directory")
        }
        throw .usage("cannot create \(debugQuoted(path)): \(errnoText(e))")
    }
}

/// Check that `path` is a real directory (not a symlink) owned by the current user and not
/// writable by group or others: the cache-directory rule SC-3, reused for bundles.
func checkPrivateDirectory(_ path: String) throws(VZMacError) {
    var st = stat()
    guard lstat(path, &st) == 0 else {
        throw .usage("cannot stat \(debugQuoted(path)): \(errnoText())")
    }
    guard (st.st_mode & S_IFMT) == S_IFDIR else {
        throw .usage("\(debugQuoted(path)) is not a directory (a symlink is refused)")
    }
    guard st.st_uid == getuid() else {
        throw .usage("\(debugQuoted(path)) is not owned by the current user")
    }
    guard (st.st_mode & 0o022) == 0 else {
        throw .usage("\(debugQuoted(path)) is group- or world-writable")
    }
}

/// `trim-aux`: copy `input` to a new file `output`, skipping the first `skip` bytes.
///
/// Why: QEMU's vmapple documentation (`docs/system/arm/vmapple.rst`, macos-guest.md §3.4) says
/// the first 0x4000 bytes of VZ's auxiliary storage are VZ metadata that its pflash model must
/// not see (`dd … bs=0x4000 skip=1`). The bytes after them were written by the guest, so they
/// are copied, never interpreted (SC-14). The input must be longer than `skip`, the output must
/// be new (`O_EXCL`, so it cannot be the input), and a failed copy removes the partial output.
// ANCHOR: vz_trim_aux
func trimPrefix(input: String, output: String, skip: UInt64, cap: UInt64) throws(VZMacError)
    -> UInt64
{
    let (src, info) = try openInput(input, follow: .noFollow, cap: cap)
    defer { close(src) }
    guard info.size > skip else {
        throw .usage(
            "\(debugQuoted(input)) is \(info.size) bytes; expected more than the \(skip)-byte VZ header")
    }
    let dst = try createOutput(output)
    var offset = off_t(skip)
    var copied: UInt64 = 0
    var buf = [UInt8](repeating: 0, count: 1 << 20)
    var failure: String?
    while failure == nil {
        let n = buf.withUnsafeMutableBytes { pread(src, $0.baseAddress!, $0.count, offset) }
        if n < 0 {
            if errno == EINTR { continue }
            failure = "read \(debugQuoted(input)): \(errnoText())"
            break
        }
        if n == 0 { break }
        if !buf.withUnsafeBytes({ writeAll(dst, UnsafeRawBufferPointer(rebasing: $0[0..<n])) }) {
            failure = "write \(debugQuoted(output)): \(errnoText())"
            break
        }
        offset += off_t(n)
        copied += UInt64(n)
        if copied > cap {
            failure = "\(debugQuoted(input)) grew past the \(cap)-byte limit while copying"
        }
    }
    if close(dst) != 0, failure == nil {
        failure = "close \(debugQuoted(output)): \(errnoText())"
    }
    if let failure {
        unlink(output)
        throw .failure(failure)
    }
    return copied
}
// ANCHOR_END: vz_trim_aux
