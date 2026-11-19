//! `cargo xtask unzboot IN OUT`: unwrap an EFI zboot kernel into a raw arm64 Image (PLAN M9;
//! threat model LDR-4, SC-5, SC-6; course ch13).
//!
//! **Why this exists.** Alpine ships `vmlinuz-virt` as an *EFI zboot* image: a small PE/COFF
//! EFI application whose payload is the gzip-compressed real kernel (Linux
//! `drivers/firmware/efi/libstub/zboot-header.S`, `Makefile.zboot`). Firmware runs the EFI stub,
//! which inflates the kernel and jumps to it. We direct-boot without firmware, so someone has to
//! inflate it, and that someone must **not** be the VMM: a decompressor parsing an attacker's
//! stream is a large surface, and the VMM process holds the hypervisor entitlement. So the VMM
//! refuses zboot (LDR-4) and this host tool does the unwrap once, after `scripts/fetch.sh` has
//! verified the input's sha256 (SC-5: verify before parse).
//!
//! **The header** (`zboot-header.S`; QEMU's `unpack_efi_zboot_image` reads the same fields):
//!
//! | Offset | Size | Field |
//! |---|---|---|
//! | 0 | 2 | `MZ` (the DOS/PE magic) |
//! | 4 | 4 | `zimg` |
//! | 8 | 4 | payload offset (LE, from the start of the file) |
//! | 12 | 4 | payload size (LE) |
//! | 24 | 32 | compression type, NUL-terminated (`gzip`, `lzma`, `zstd`, ...) |
//!
//! **Rules.** Every offset is checked (`checked_add`, inside the file); only `gzip` is
//! accepted, because `/usr/bin/gzip` is part of macOS and needs no dependency; the payload must
//! start with the gzip magic `1f 8b` (RFC 1952 §2.3.1). It is piped through
//! `/usr/bin/gzip -dc` (an absolute path, no shell, no `PATH` lookup), and the output is
//! **capped at 256 MiB** ([`MAX_OUTPUT`], SC-6): a decompression bomb is cut off with an error,
//! never written in full. The result must be an arm64 Image (`ARM\x64` at offset 56,
//! booting.rst §4) or nothing is written. The output file is created with `O_EXCL` and
//! `O_NOFOLLOW`, so it never replaces or writes through an existing file or link.

use std::fmt;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The largest inflated kernel accepted (SC-6, architecture §21.5).
pub const MAX_OUTPUT: u64 = 256 << 20;
/// The largest zboot input read (Alpine's is ~10 MiB).
pub const MAX_INPUT: u64 = 128 << 20;
/// macOS's gzip. Absolute: never resolved through `PATH`.
pub const GZIP: &str = "/usr/bin/gzip";
/// The header bytes read.
pub const HEADER_LEN: usize = 56;

/// Why an unwrap failed.
#[derive(Debug)]
pub enum ZbootError {
    NotZboot,
    Truncated,
    PayloadOutOfFile { offset: u64, size: u64, file: u64 },
    Compression(String),
    NotGzip,
    TooLarge,
    Gzip(String),
    NotAnImage,
    Io(String, io::Error),
}

impl fmt::Display for ZbootError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ZbootError::NotZboot => f.write_str("not an EFI zboot image (no MZ / zimg magic)"),
            ZbootError::Truncated => f.write_str("file too short for the zboot header"),
            ZbootError::PayloadOutOfFile { offset, size, file } => write!(
                f,
                "payload {offset:#x}+{size:#x} lies outside the {file:#x}-byte file"
            ),
            ZbootError::Compression(c) => {
                write!(f, "unsupported compression {c:?} (only gzip is supported)")
            }
            ZbootError::NotGzip => f.write_str("payload does not start with the gzip magic"),
            ZbootError::TooLarge => write!(
                f,
                "inflated payload exceeds the {} MiB cap (SC-6)",
                MAX_OUTPUT >> 20
            ),
            ZbootError::Gzip(e) => write!(f, "gzip failed: {e}"),
            ZbootError::NotAnImage => {
                f.write_str("inflated payload is not an arm64 Image (no ARM\\x64 at offset 56)")
            }
            ZbootError::Io(what, e) => write!(f, "{what}: {e}"),
        }
    }
}

impl std::error::Error for ZbootError {}

/// The parsed header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZbootHeader {
    pub payload_offset: u64,
    pub payload_size: u64,
    pub compression: String,
}

fn le32(b: &[u8], off: usize) -> Option<u64> {
    let v: [u8; 4] = b.get(off..off.checked_add(4)?)?.try_into().ok()?;
    Some(u64::from(u32::from_le_bytes(v)))
}

/// Parse and check the header of `b` (module docs). The payload range is inside `b`.
pub fn parse(b: &[u8]) -> Result<ZbootHeader, ZbootError> {
    if b.get(0..2) != Some(b"MZ".as_slice()) || b.get(4..8) != Some(b"zimg".as_slice()) {
        return Err(ZbootError::NotZboot);
    }
    if b.len() < HEADER_LEN {
        return Err(ZbootError::Truncated);
    }
    let payload_offset = le32(b, 8).ok_or(ZbootError::Truncated)?;
    let payload_size = le32(b, 12).ok_or(ZbootError::Truncated)?;
    let comp = b.get(24..56).ok_or(ZbootError::Truncated)?;
    let comp = match comp.iter().position(|&c| c == 0) {
        Some(n) => comp.get(..n).unwrap_or_default(),
        None => {
            return Err(ZbootError::Compression(
                String::from_utf8_lossy(comp).into(),
            ));
        }
    };
    let compression = String::from_utf8_lossy(comp).into_owned();
    let file = b.len() as u64;
    let end = payload_offset.checked_add(payload_size);
    if payload_size == 0 || end.is_none_or(|e| e > file) || payload_offset < HEADER_LEN as u64 {
        return Err(ZbootError::PayloadOutOfFile {
            offset: payload_offset,
            size: payload_size,
            file,
        });
    }
    if compression != "gzip" {
        return Err(ZbootError::Compression(compression));
    }
    Ok(ZbootHeader {
        payload_offset,
        payload_size,
        compression,
    })
}

/// Inflate `gz` with `gzip -dc` (the program `gzip`; tests pass the real one), reading at most
/// `cap` bytes of output: one byte more is [`ZbootError::TooLarge`] and the child is killed.
pub fn gunzip_capped(gzip: &Path, gz: &[u8], cap: u64) -> Result<Vec<u8>, ZbootError> {
    if !gz.starts_with(&[0x1f, 0x8b]) {
        return Err(ZbootError::NotGzip);
    }
    let mut child = Command::new(gzip)
        .arg("-dc")
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ZbootError::Io(format!("cannot run {}", gzip.display()), e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(ZbootError::Gzip("no stdin".into()))?;
    let input = gz.to_vec();
    // Feed stdin from a thread so a full stdout pipe cannot deadlock us.
    let feeder = std::thread::spawn(move || {
        let _ = stdin.write_all(&input); // EPIPE when we kill it on the cap: fine
    });
    let stdout = child
        .stdout
        .take()
        .ok_or(ZbootError::Gzip("no stdout".into()))?;
    let mut out = Vec::new();
    let read = stdout.take(cap.saturating_add(1)).read_to_end(&mut out);
    let over = out.len() as u64 > cap;
    if over || read.is_err() {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|e| ZbootError::Io("waiting for gzip".into(), e))?;
    let _ = feeder.join();
    let mut stderr = String::new();
    if let Some(e) = child.stderr.take() {
        let _ = e.take(4096).read_to_string(&mut stderr);
    }
    if over {
        return Err(ZbootError::TooLarge);
    }
    read.map_err(|e| ZbootError::Io("reading gzip output".into(), e))?;
    if !status.success() {
        return Err(ZbootError::Gzip(format!("{status}: {}", stderr.trim())));
    }
    Ok(out)
}

// ANCHOR: zboot_unwrap
/// Unwrap the zboot file `b` into the raw Image bytes (module docs), using `gzip`.
pub fn unwrap_with(gzip: &Path, b: &[u8]) -> Result<Vec<u8>, ZbootError> {
    let h = parse(b)?;
    let start = usize::try_from(h.payload_offset).map_err(|_| ZbootError::Truncated)?;
    let len = usize::try_from(h.payload_size).map_err(|_| ZbootError::Truncated)?;
    let payload = b
        .get(start..start.checked_add(len).ok_or(ZbootError::Truncated)?)
        .ok_or(ZbootError::Truncated)?;
    let image = gunzip_capped(gzip, payload, MAX_OUTPUT)?;
    if image.get(56..60) != Some(b"ARM\x64".as_slice()) {
        return Err(ZbootError::NotAnImage);
    }
    Ok(image)
}
// ANCHOR_END: zboot_unwrap

/// Read at most `cap` bytes of a regular file (refusing anything else and bigger files).
pub fn read_capped(path: &Path, cap: u64) -> Result<Vec<u8>, ZbootError> {
    let f = std::fs::File::open(path)
        .map_err(|e| ZbootError::Io(format!("cannot open {}", path.display()), e))?;
    let meta = f
        .metadata()
        .map_err(|e| ZbootError::Io(format!("cannot stat {}", path.display()), e))?;
    if !meta.is_file() {
        return Err(ZbootError::Io(
            format!("{}", path.display()),
            io::Error::other("not a regular file"),
        ));
    }
    let mut b = Vec::new();
    f.take(cap.saturating_add(1))
        .read_to_end(&mut b)
        .map_err(|e| ZbootError::Io(format!("cannot read {}", path.display()), e))?;
    if b.len() as u64 > cap {
        return Err(ZbootError::Io(
            format!("{}", path.display()),
            io::Error::other(format!("larger than {cap} bytes")),
        ));
    }
    Ok(b)
}

/// Create `path` for writing: a new file only (`O_EXCL`), never through a symlink, mode 0644
/// (a kernel image is data, never executable on the host: SC-4).
pub fn create_new(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .custom_flags(crate::O_NOFOLLOW)
        .open(path)
}

/// `cargo xtask unzboot IN OUT`.
pub fn run(input: &Path, output: &Path) -> Result<PathBuf, ZbootError> {
    let b = read_capped(input, MAX_INPUT)?;
    let image = unwrap_with(Path::new(GZIP), &b)?;
    let mut f = create_new(output)
        .map_err(|e| ZbootError::Io(format!("cannot create {}", output.display()), e))?;
    f.write_all(&image)
        .and_then(|()| f.sync_all())
        .map_err(|e| ZbootError::Io(format!("cannot write {}", output.display()), e))?;
    Ok(output.to_path_buf())
}
