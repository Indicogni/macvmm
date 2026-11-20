//! Host tests for `xtask::sparse` (PLAN M19 "Security tests"; threat model SC-6).
//!
//! - 1 MiB of mixed zero and non-zero 64 KiB blocks (plus a short non-zero tail and a trailing
//!   zero run) round-trips byte-identically, and a large zero gap really is a hole;
//! - an output path that is a symlink is refused and its target is untouched;
//! - an existing output file is refused (never replaced);
//! - a stream over the cap deletes the output.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;
use std::path::PathBuf;
use xtask::sparse::{self, BLOCK, SparseError};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("macvmm-xtask-sparse-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// 1 MiB = 16 blocks; the pattern decides which are zero. Block 15 is zero, so the file ends
/// in a hole that only `set_len` creates.
fn mixed_mib() -> Vec<u8> {
    let zero_blocks = [0usize, 2, 3, 7, 8, 9, 12, 15];
    let mut v = Vec::with_capacity(16 * BLOCK);
    for b in 0..16 {
        if zero_blocks.contains(&b) {
            v.extend(std::iter::repeat_n(0u8, BLOCK));
        } else {
            // Mostly zero with one non-zero byte at a block-dependent offset: still "data".
            let mut blk = vec![0u8; BLOCK];
            blk[(b * 4099) % BLOCK] = u8::try_from(b + 1).unwrap();
            blk[BLOCK - 1] = 0xA5;
            v.extend(blk);
        }
    }
    assert_eq!(v.len(), 1 << 20);
    v
}

#[test]
fn round_trip_mixed_mib_is_byte_identical() {
    let d = tmp("roundtrip");
    let out = d.join("out.raw");
    let data = mixed_mib();
    let s = sparse::write_to_path(&mut Cursor::new(&data), &out, sparse::MAX_OUTPUT).unwrap();
    assert_eq!(s.len, 1 << 20);
    assert_eq!(
        s.written,
        8 * BLOCK as u64,
        "only the 8 data blocks are written"
    );
    let back = std::fs::read(&out).unwrap();
    assert_eq!(back.len(), data.len());
    assert!(back == data, "round trip differs");
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(&out).unwrap();
    // Not executable (SC-4).
    assert_eq!(md.mode() & 0o111, 0);
    let _ = std::fs::remove_dir_all(&d);
}

/// The skipped blocks really become holes. APFS (observed on macOS 27.2) only keeps a hole
/// for a zero gap of more than about 8 MiB; smaller gaps are allocated and zero-filled on
/// close, so this uses a 32 MiB gap. (The FreeBSD image's free space is gigabytes of zeros.)
#[test]
fn large_zero_gap_is_a_hole() {
    let d = tmp("hole");
    let out = d.join("out.raw");
    let mut data = vec![0x11u8; BLOCK];
    data.extend(std::iter::repeat_n(0u8, 32 << 20));
    data.extend(vec![0x22u8; BLOCK]);
    data.extend(std::iter::repeat_n(0u8, 32 << 20));
    let s = sparse::write_to_path(&mut Cursor::new(&data), &out, sparse::MAX_OUTPUT).unwrap();
    assert_eq!(s.written, 2 * BLOCK as u64);
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(&out).unwrap();
    assert_eq!(md.len(), data.len() as u64);
    assert!(
        md.blocks() * 512 < 8 << 20,
        "expected a sparse file: {} bytes allocated for {} bytes",
        md.blocks() * 512,
        md.len()
    );
    assert!(std::fs::read(&out).unwrap() == data);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn unaligned_tail_round_trips() {
    let d = tmp("tail");
    let out = d.join("out.raw");
    let mut data = mixed_mib();
    data.extend_from_slice(b"tail");
    data.extend(std::iter::repeat_n(0u8, 1000));
    sparse::write_to_path(&mut Cursor::new(&data), &out, sparse::MAX_OUTPUT).unwrap();
    assert!(std::fs::read(&out).unwrap() == data);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn all_zero_input_is_one_hole() {
    let d = tmp("zero");
    let out = d.join("out.raw");
    let data = vec![0u8; 3 * BLOCK + 17];
    let s = sparse::write_to_path(&mut Cursor::new(&data), &out, sparse::MAX_OUTPUT).unwrap();
    assert_eq!(s.written, 0);
    assert_eq!(std::fs::metadata(&out).unwrap().len(), data.len() as u64);
    assert!(std::fs::read(&out).unwrap() == data);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn symlink_output_is_refused() {
    let d = tmp("symlink");
    let target = d.join("victim");
    std::fs::write(&target, b"keep me").unwrap();
    let link = d.join("out.raw");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let e = sparse::write_to_path(&mut Cursor::new(vec![1u8; 10]), &link, sparse::MAX_OUTPUT)
        .unwrap_err();
    assert!(matches!(e, SparseError::Io(..)), "{e}");
    assert_eq!(std::fs::read(&target).unwrap(), b"keep me");
    assert!(
        std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn existing_output_is_refused() {
    let d = tmp("exists");
    let out = d.join("out.raw");
    std::fs::write(&out, b"old").unwrap();
    assert!(
        sparse::write_to_path(&mut Cursor::new(vec![1u8; 10]), &out, sparse::MAX_OUTPUT).is_err()
    );
    assert_eq!(std::fs::read(&out).unwrap(), b"old");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn over_cap_deletes_output() {
    let d = tmp("cap");
    let out = d.join("out.raw");
    let data = mixed_mib();
    let e = sparse::write_to_path(&mut Cursor::new(&data), &out, (1 << 20) - 1).unwrap_err();
    assert!(matches!(e, SparseError::TooLarge(_)), "{e}");
    assert!(!out.exists(), "an over-cap output must be deleted");
    // Exactly at the cap is accepted.
    sparse::write_to_path(&mut Cursor::new(&data), &out, 1 << 20).unwrap();
    let _ = std::fs::remove_dir_all(&d);
}
