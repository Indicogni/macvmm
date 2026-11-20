//! `cargo xtask mkrootfs --out F --size 256M`: an ext4 root filesystem image built from the
//! Alpine minirootfs (PLAN M15; course ch18 part 2; threat model SC-5, SC-7, SC-9, SC-14).
//!
//! **Why a disk root at all.** Until M14 the guest's root was the initramfs: a RAM copy that
//! vanishes at every reset, so nothing a guest writes can survive a reboot. A real root
//! filesystem on a virtio-blk disk is what turns "it booted" into "it is a computer": the
//! guest's writes reach the host file through `VIRTIO_BLK_T_OUT` and `T_FLUSH` (virtio 1.2
//! §5.2.6), and the next boot reads them back (`linux_rootfs_persist`).
//!
//! **Pipeline** (each step names the rule it implements):
//! 1. **Verify before parse** (SC-5). The input's sha256 (`/usr/bin/shasum -a 256`, the tool
//!    `scripts/fetch.sh` uses) must equal the pin of the same file name in
//!    `scripts/fetch-manifest.txt`. The bytes are read once from one `O_NOFOLLOW` descriptor
//!    and exactly those bytes are hashed, so what is verified is what is parsed; nothing (not
//!    even `gzip`) sees them before the hash matched.
//! 2. `gzip -dc` with an output cap ([`MAX_TAR`]), through [`crate::zboot::gunzip_capped`]
//!    (`/usr/bin/gzip` by absolute path, empty environment).
//! 3. Extraction into a fresh `mktemp -d`-style directory with [`crate::tar`] (SC-7: two passes,
//!    symlinks last and kept as data, `O_NOFOLLOW_ANY`, setuid/setgid stripped). The extractor
//!    clears the execute bits on the host (SC-4: no `chmod +x` of downloaded bytes).
//! 4. `/sbin/macvmm-init` (our tracked script) is added with `O_CREAT|O_EXCL|O_NOFOLLOW_ANY`
//!    into a `sbin` that must be a real directory the extraction made, never through a link.
//! 5. The **intended** modes (from the tar headers, sticky bit kept, setid stripped) are
//!    written to `/.macvmm-modes`. The initramfs `rootfs` case applies them **inside the
//!    guest** before the first `exec` from the new root and deletes the file, so execute bits
//!    exist only where they are harmless: in the guest (see [`MODES_FILE`]).
//! 6. `mkfs.ext4 -F -t ext4 -L root -d <staging> -E root_owner=0:0` (Homebrew e2fsprogs, PLAN
//!    D8) on a pre-sized `<out>.part`, then an atomic rename. `-d` copies the staging tree only
//!    (SC-9); file owners stay our uid, and `/sbin/macvmm-init` runs `chown 0:0` in the guest on
//!    its first boot.
//!
//! **What this tool never does** (SC-14): it does not mount, attach or open the image it made,
//! and it never runs on a guest-written image. Inspecting a guest disk is done by attaching it
//! `,ro` to a fresh guest.
//!
//! The ext4 on-disk format itself is not a lesson topic (course CONCEPTS.md: pointer to the
//! kernel's `Documentation/filesystems/ext4/`); `mkfs.ext4 -d` is the standard way to build one
//! from a directory without root or a loop device.

use crate::tar::{self, Kind, Options, Reader};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The pinned minirootfs (`scripts/fetch-manifest.txt`, set `rootfs`).
pub const MINIROOTFS: &str = "alpine-minirootfs-3.24.4-aarch64.tar.gz";
/// The largest compressed input read (the 3.24.4 minirootfs is 4.0 MB).
pub const MAX_GZ: u64 = 64 << 20;
/// The decompressed tar cap (SC-6; the 3.24.4 minirootfs is 8.9 MB).
pub const MAX_TAR: u64 = 256 << 20;
/// Image size bounds: ext4 with a journal needs a few MiB of metadata; 8 GiB is far beyond
/// any test.
pub const MIN_SIZE: u64 = 32 << 20;
pub const MAX_SIZE: u64 = 8 << 30;
/// The modes manifest at the image root, consumed and deleted by the initramfs `rootfs` case
/// (`scripts/initramfs/init`, anchor `initramfs_rootfs`). One line per regular file or
/// directory: `<octal mode> <path relative to />`; `.` is the root directory. Paths are
/// restricted to [`path_ok`] characters so a shell `read -r mode path` loop parses them
/// exactly.
pub const MODES_FILE: &str = ".macvmm-modes";
/// Where our init lands in the image.
pub const INIT_PATH: &str = "sbin/macvmm-init";
/// Homebrew's keg-only e2fsprogs, Apple Silicon then Intel prefix (`brew --prefix e2fsprogs`).
pub const MKFS_CANDIDATES: [&str; 2] = [
    "/opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4",
    "/usr/local/opt/e2fsprogs/sbin/mkfs.ext4",
];
/// The oldest e2fsprogs accepted (SC-14: e2fsck parses guest-written images in
/// `rootfs_fsck_clean`; 1.46.6 fixed CVE-2022-1304, and 1.47.0 is the first release of the
/// current series).
pub const E2FS_MIN: (u32, u32, u32) = (1, 47, 0);
/// `/usr/bin/shasum`, by absolute path (never `PATH`).
pub const SHASUM: &str = "/usr/bin/shasum";
/// Exit status for "the e2fsprogs tool is missing" (`EX_UNAVAILABLE`, sysexits.h).
pub const EX_UNAVAILABLE: u8 = 69;

/// Every failure of this tool, with whether it was the missing-tool case.
#[derive(Debug)]
pub struct RootfsError {
    pub message: String,
    pub tool_missing: bool,
}

impl RootfsError {
    fn new(message: impl Into<String>) -> RootfsError {
        RootfsError {
            message: message.into(),
            tool_missing: false,
        }
    }
}

impl std::fmt::Display for RootfsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for RootfsError {
    fn from(message: String) -> RootfsError {
        RootfsError::new(message)
    }
}

// ---------------------------------------------------------------------------------------------
// Step 1: verify before parse (SC-5)

/// The pinned sha256 of manifest entry `name` (`<set> <name> <sha256> <source>…`). A `TOFU`
/// entry, a missing one or a malformed hash is an error: only a real pin authorises parsing.
pub fn pinned_sha256(manifest: &str, name: &str) -> Result<String, String> {
    for raw in manifest.lines() {
        let line = raw.split('#').next().unwrap_or("");
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 4 || f[1] != name {
            continue;
        }
        let h = f[2];
        if h.len() == 64 && h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Ok(h.to_owned());
        }
        return Err(format!(
            "manifest entry {name} has no sha256 pin ({h}); SC-5 forbids parsing it"
        ));
    }
    Err(format!("no manifest entry named {name}"))
}

/// `shasum -a 256 FILE`, as 64 lowercase hex characters.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let out = Command::new(SHASUM)
        .args(["-a", "256", "--"])
        .arg(path)
        .env_clear()
        .output()
        .map_err(|e| format!("cannot run {SHASUM}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{SHASUM} failed on {}: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let h = text.split_whitespace().next().unwrap_or("");
    if h.len() != 64 || !h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(format!("unexpected {SHASUM} output {text:?}"));
    }
    Ok(h.to_owned())
}

/// The sha256 of `data`, by piping it through `shasum -a 256` (a feeder thread, so a full
/// stdout pipe cannot deadlock us).
pub fn sha256_bytes(data: &[u8]) -> Result<String, String> {
    use std::process::Stdio;
    let mut child = Command::new(SHASUM)
        .args(["-a", "256"])
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run {SHASUM}: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin for shasum")?;
    let input = data.to_vec();
    let feeder = std::thread::spawn(move || stdin.write_all(&input));
    let out = child
        .wait_with_output()
        .map_err(|e| format!("waiting for {SHASUM}: {e}"))?;
    let fed = feeder
        .join()
        .map_err(|_| "shasum feeder panicked".to_owned())?;
    fed.map_err(|e| format!("writing to {SHASUM}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{SHASUM} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let h = text.split_whitespace().next().unwrap_or("");
    if h.len() != 64 || !h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err(format!("unexpected {SHASUM} output {text:?}"));
    }
    Ok(h.to_owned())
}

/// Read `input` (a regular file, not through a symlink, at most `cap` bytes) after checking
/// its sha256 against the manifest pin for its file name (SC-5). Returns the bytes.
pub fn read_verified(input: &Path, manifest: &Path, cap: u64) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let name = input
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} has no file name", input.display()))?;
    let text = std::fs::read_to_string(manifest)
        .map_err(|e| format!("cannot read {}: {e}", manifest.display()))?;
    let want = pinned_sha256(&text, name)?;
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(crate::O_NOFOLLOW)
        .open(input)
        .map_err(|e| {
            format!(
                "cannot open {} ({e}); run scripts/fetch.sh rootfs",
                input.display()
            )
        })?;
    let meta = f
        .metadata()
        .map_err(|e| format!("cannot stat {}: {e}", input.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a regular file", input.display()));
    }
    if meta.len() > cap {
        return Err(format!(
            "{} is {} bytes, over the {cap}-byte cap",
            input.display(),
            meta.len()
        ));
    }
    // Read the bytes once from the fd we hold, then hash exactly those bytes (shasum on
    // stdin): what is verified is what gets parsed, with no window for a swapped file.
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    Read::by_ref(&mut f)
        .take(cap.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {}: {e}", input.display()))?;
    if bytes.len() as u64 > cap {
        return Err(format!("{} grew past the {cap}-byte cap", input.display()));
    }
    let got = sha256_bytes(&bytes)?;
    if got != want {
        return Err(format!(
            "sha256 mismatch for {}: expected {want}, got {got} (SC-5); run scripts/fetch.sh rootfs",
            input.display()
        ));
    }
    Ok(bytes)
}

// ---------------------------------------------------------------------------------------------
// Steps 3-5: staging

/// The characters a modes-manifest path may use (Alpine's minirootfs needs only these).
pub fn path_ok(p: &str) -> bool {
    !p.is_empty()
        && p.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b'+' | b'-' | b'/')
        })
}

/// The intended permission bits of every directory and regular file in `tar_bytes`, keyed by
/// normalised name (`""` is the archive root): the ustar mode with setuid/setgid removed and
/// the sticky bit kept (`/tmp` is `1777`). Symlinks have no mode of their own and hard links
/// share their target's inode, so neither is listed.
pub fn intended_modes(tar_bytes: &[u8]) -> Result<BTreeMap<String, u32>, String> {
    let opts = Options::default();
    let mut r = Reader::new(tar_bytes, opts);
    let mut modes = BTreeMap::new();
    while let Some((m, _)) = r.next_member().map_err(|e| e.to_string())? {
        if !matches!(m.kind, Kind::Dir | Kind::File) {
            continue;
        }
        let name = tar::normalize(&m.name, opts.limits.max_name)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        modes.insert(name, m.mode & 0o1777);
    }
    Ok(modes)
}

/// Render the modes manifest ([`MODES_FILE`]): sorted, one `<mode> <path>` per line.
pub fn modes_manifest(modes: &BTreeMap<String, u32>) -> Result<String, String> {
    let mut out = String::from("# macvmm mkrootfs: <octal mode> <path>; applied in the guest\n");
    for (name, mode) in modes {
        let shown = if name.is_empty() { "." } else { name.as_str() };
        if !path_ok(shown) {
            return Err(format!(
                "member {name:?} has characters outside [A-Za-z0-9._@+/-]; refusing to list it"
            ));
        }
        out.push_str(&format!("{mode:04o} {shown}\n"));
    }
    Ok(out)
}

/// What [`stage`] did.
#[derive(Debug)]
pub struct Staged {
    pub report: tar::Report,
    /// Entries in the modes manifest.
    pub modes: usize,
}

#[cfg(target_os = "macos")]
const OPEN_NOFOLLOW: i32 = crate::O_NOFOLLOW_ANY;
#[cfg(not(target_os = "macos"))]
const OPEN_NOFOLLOW: i32 = crate::O_NOFOLLOW;

/// Create `dir/name` as a new file holding `data` (never through a symlink, never over an
/// existing name). `dir` must be a real directory, not a link.
fn create_in(dir: &Path, name: &str, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let meta = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !meta.file_type().is_dir() {
        return Err(format!(
            "{} is not a real directory (a symlink or a file); refusing to write through it",
            dir.display()
        ));
    }
    let path = dir.join(name);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(OPEN_NOFOLLOW)
        .open(&path)
        .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    f.write_all(data)
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Steps 3-5 of the module docs: extract `tar_bytes` into the fresh, empty directory `root`
/// (SC-7), add `init` as `/sbin/macvmm-init`, and write the modes manifest.
pub fn stage(tar_bytes: &[u8], root: &Path, init: &[u8]) -> Result<Staged, String> {
    let mut modes = intended_modes(tar_bytes)?;
    let report = tar::extract(tar_bytes, root, Options::default()).map_err(|e| e.to_string())?;
    // `extract` resolved `root` once; do the same, then never follow a link below it.
    let real = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let (dir, file) = INIT_PATH.rsplit_once('/').unwrap_or(("", INIT_PATH));
    if !modes.contains_key(dir) {
        return Err(format!(
            "the archive has no /{dir} directory for /{INIT_PATH}"
        ));
    }
    create_in(&real.join(dir), file, init)?;
    modes.insert(INIT_PATH.to_owned(), 0o755);
    modes.entry(String::new()).or_insert(0o755);
    let manifest = modes_manifest(&modes)?;
    create_in(&real, MODES_FILE, manifest.as_bytes())?;
    Ok(Staged {
        report,
        modes: modes.len(),
    })
}

/// A private work directory under `$TMPDIR` (`mktemp -d` semantics: a new name, mode 0700,
/// created with `mkdir`, which fails rather than reuse anything), removed on drop.
/// `remove_dir_all` does not follow symlinks (std, since CVE-2022-21658).
pub struct WorkDir(pub PathBuf);

impl WorkDir {
    pub fn new(tag: &str) -> Result<WorkDir, String> {
        use std::os::unix::fs::DirBuilderExt;
        let base = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        for i in 0..100u32 {
            let p = base.join(format!("macvmm-{tag}.{}.{nanos:x}.{i}", std::process::id()));
            match std::fs::DirBuilder::new().mode(0o700).create(&p) {
                Ok(()) => return Ok(WorkDir(p)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("cannot create {}: {e}", p.display())),
            }
        }
        Err(format!(
            "cannot create a work directory in {}",
            base.display()
        ))
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------------------------
// Step 6: mkfs.ext4

/// `mke2fs 1.47.4 (6-Mar-2025)` → `(1, 47, 4)`.
pub fn parse_e2fs_version(text: &str) -> Option<(u32, u32, u32)> {
    let word = text
        .split_whitespace()
        .skip_while(|w| *w != "mke2fs")
        .nth(1)?;
    let mut it = word.split('.').map(|p| p.parse::<u32>().ok());
    let a = it.next()??;
    let b = it.next()??;
    let c = it.next().flatten().unwrap_or(0);
    Some((a, b, c))
}

/// The `mkfs.ext4` to use: `$MACVMM_MKFS_EXT4` if set (an absolute path), else Homebrew's
/// keg-only e2fsprogs ([`MKFS_CANDIDATES`]), else `mkfs.ext4` on `PATH`. Missing is an error
/// with the install hint and `tool_missing` set.
pub fn find_mkfs() -> Result<PathBuf, RootfsError> {
    if let Some(p) = std::env::var_os("MACVMM_MKFS_EXT4") {
        let p = PathBuf::from(p);
        if p.is_absolute() && p.is_file() {
            return Ok(p);
        }
        return Err(RootfsError::new(format!(
            "MACVMM_MKFS_EXT4={} is not an absolute path to a file",
            p.display()
        )));
    }
    for c in MKFS_CANDIDATES {
        if Path::new(c).is_file() {
            return Ok(PathBuf::from(c));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            let p = d.join("mkfs.ext4");
            if d.is_absolute() && p.is_file() {
                return Ok(p);
            }
        }
    }
    Err(RootfsError {
        message: "mkfs.ext4 not found: install e2fsprogs with `brew install e2fsprogs` \
                  (keg-only; PLAN D8, scripts/setup.sh), then re-run"
            .into(),
        tool_missing: true,
    })
}

/// Check `mkfs`'s e2fsprogs version against [`E2FS_MIN`] (SC-14).
pub fn check_version(mkfs: &Path) -> Result<(u32, u32, u32), String> {
    let out = Command::new(mkfs)
        .arg("-V")
        .env_clear()
        .output()
        .map_err(|e| format!("cannot run {}: {e}", mkfs.display()))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let v = parse_e2fs_version(&text)
        .ok_or_else(|| format!("cannot read the e2fsprogs version from {text:?}"))?;
    if v < E2FS_MIN {
        return Err(format!(
            "e2fsprogs {}.{}.{} is older than {}.{}.{} (SC-14); run: brew upgrade e2fsprogs",
            v.0, v.1, v.2, E2FS_MIN.0, E2FS_MIN.1, E2FS_MIN.2
        ));
    }
    Ok(v)
}

/// Make `size` bytes of ext4 at `part` from the staging tree `root` (module docs, step 6).
/// `part` is created fresh (no symlink, no reuse) and pre-sized; mkfs then uses the file size.
pub fn mkfs(mkfs: &Path, root: &Path, part: &Path, size: u64) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(m) = std::fs::symlink_metadata(part) {
        if !m.file_type().is_file() {
            return Err(format!(
                "{} exists and is not a regular file",
                part.display()
            ));
        }
        std::fs::remove_file(part).map_err(|e| format!("cannot remove {}: {e}", part.display()))?;
    }
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(crate::O_NOFOLLOW)
        .open(part)
        .map_err(|e| format!("cannot create {}: {e}", part.display()))?;
    f.set_len(size)
        .map_err(|e| format!("cannot size {}: {e}", part.display()))?;
    drop(f);
    let out = Command::new(mkfs)
        .args(["-F", "-t", "ext4", "-L", "root", "-d"])
        .arg(root)
        .args(["-E", "root_owner=0:0"])
        .arg(part)
        .env_clear()
        .output()
        .map_err(|e| format!("cannot run {}: {e}", mkfs.display()))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(part);
        return Err(format!(
            "{} failed ({}):\n{}{}",
            mkfs.display(),
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The command

/// `mkrootfs` arguments.
#[derive(Clone, Debug)]
pub struct Args {
    pub out: PathBuf,
    pub size: u64,
    /// The minirootfs tarball (default: `<cache>/`[`MINIROOTFS`]).
    pub minirootfs: PathBuf,
    /// Our init (default: `scripts/rootfs/macvmm-init`).
    pub init: PathBuf,
    /// The fetch manifest holding the pin (default: `scripts/fetch-manifest.txt`).
    pub manifest: PathBuf,
}

/// `cargo xtask mkrootfs`: the whole pipeline. Returns the summary line.
pub fn run(a: &Args) -> Result<String, RootfsError> {
    if a.size < MIN_SIZE || a.size > MAX_SIZE || !a.size.is_multiple_of(1 << 20) {
        return Err(RootfsError::new(format!(
            "--size must be a whole number of MiB between {} MiB and {} GiB",
            MIN_SIZE >> 20,
            MAX_SIZE >> 30
        )));
    }
    if let Ok(m) = std::fs::symlink_metadata(&a.out)
        && !m.file_type().is_file()
    {
        return Err(RootfsError::new(format!(
            "{} exists and is not a regular file",
            a.out.display()
        )));
    }
    // The tool check first: no point unpacking anything without it.
    let mkfs_bin = find_mkfs()?;
    let version = check_version(&mkfs_bin)?;
    let init = std::fs::read(&a.init).map_err(|e| format!("{}: {e}", a.init.display()))?;
    let gz = read_verified(&a.minirootfs, &a.manifest, MAX_GZ)?; // SC-5
    let tar_bytes = crate::zboot::gunzip_capped(Path::new(crate::zboot::GZIP), &gz, MAX_TAR)
        .map_err(|e| format!("{}: {e}", a.minirootfs.display()))?;
    let work = WorkDir::new("rootfs")?;
    let root = work.0.join("root");
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&root)
            .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    }
    let staged = stage(&tar_bytes, &root, &init)?;
    let mut part = a.out.clone().into_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    mkfs(&mkfs_bin, &root, &part, a.size)?;
    std::fs::rename(&part, &a.out).map_err(|e| {
        format!(
            "cannot rename {} to {}: {e}",
            part.display(),
            a.out.display()
        )
    })?;
    let r = &staged.report;
    let setid = if r.setid_stripped.is_empty() {
        "none".to_owned()
    } else {
        r.setid_stripped.join(",")
    };
    Ok(format!(
        "mkrootfs: OK {} ({} bytes; {} files, {} dirs, {} symlinks, {} hard links; {} modes \
         applied in the guest; setid stripped: {setid}; e2fsprogs {}.{}.{})",
        a.out.display(),
        a.size,
        r.files,
        r.dirs,
        r.symlinks,
        r.hardlinks,
        staged.modes,
        version.0,
        version.1,
        version.2
    ))
}
