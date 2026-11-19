//! `xtask unzboot` (PLAN M9; threat model LDR-4, SC-6). Synthetic zboot files only: the gzip
//! payloads are made here with the system `/usr/bin/gzip`, no kernel is committed.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use xtask::zboot::{self, GZIP, MAX_OUTPUT, ZbootError};

/// gzip `data` with `/usr/bin/gzip -c`, streaming (so a large input never sits in memory twice).
fn gzip_stream(len: u64, fill: impl Fn(u64) -> u8) -> Vec<u8> {
    let mut child = Command::new(GZIP)
        .args(["-1", "-c"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let chunk: Vec<u8> = (0..(1u64 << 20)).map(&fill).collect();
    let writer = std::thread::spawn(move || {
        let mut left = len;
        while left > 0 {
            let n = left.min(chunk.len() as u64) as usize;
            stdin.write_all(&chunk[..n]).unwrap();
            left -= n as u64;
        }
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert!(out.status.success());
    out.stdout
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let data = data.to_vec();
    gzip_stream(data.len() as u64, move |i| data[i as usize % data.len()])
}

/// A synthetic arm64 Image of `len` bytes.
fn image(len: usize) -> Vec<u8> {
    let mut b: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
    b[56..60].copy_from_slice(b"ARM\x64");
    b
}

/// A zboot wrapper around `payload` (zboot-header.S layout), with the payload at 0x100.
fn zboot_file(payload: &[u8], comp: &str) -> Vec<u8> {
    let mut b = vec![0u8; 0x100];
    b[0..2].copy_from_slice(b"MZ");
    b[4..8].copy_from_slice(b"zimg");
    b[8..12].copy_from_slice(&0x100u32.to_le_bytes());
    b[12..16].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    b[24..24 + comp.len()].copy_from_slice(comp.as_bytes());
    b.extend_from_slice(payload);
    b.extend_from_slice(&[0xAA; 64]); // trailing PE data, as in a real zboot
    b
}

#[test]
fn synthetic_gzip_payload_round_trips() {
    let img = image(200_000);
    let z = zboot_file(&gzip(&img), "gzip");
    let h = zboot::parse(&z).unwrap();
    assert_eq!((h.payload_offset, h.compression.as_str()), (0x100, "gzip"));
    assert_eq!(zboot::unwrap_with(Path::new(GZIP), &z).unwrap(), img);
    // Through the file API: the output is created fresh and never overwritten.
    let dir = std::env::temp_dir().join(format!("xtask-zboot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("vmlinuz"), &z).unwrap();
    zboot::run(&dir.join("vmlinuz"), &dir.join("Image")).unwrap();
    assert_eq!(std::fs::read(dir.join("Image")).unwrap(), img);
    assert!(zboot::run(&dir.join("vmlinuz"), &dir.join("Image")).is_err());
    std::os::unix::fs::symlink(dir.join("victim"), dir.join("link")).unwrap();
    assert!(zboot::run(&dir.join("vmlinuz"), &dir.join("link")).is_err());
    assert!(!dir.join("victim").exists());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn truncated_or_overlong_offsets_are_errors() {
    let payload = gzip(&image(4096));
    let good = zboot_file(&payload, "gzip");
    // Truncated header.
    assert!(matches!(
        zboot::parse(&good[..40]),
        Err(ZbootError::Truncated)
    ));
    // Payload running past the end of the file.
    let mut z = good.clone();
    z.truncate(0x100 + payload.len() - 1);
    assert!(matches!(
        zboot::parse(&z),
        Err(ZbootError::PayloadOutOfFile { .. })
    ));
    // Offset + size overflowing 32 bits stays an error (computed in u64).
    let mut z = good.clone();
    z[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
    z[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(
        zboot::parse(&z),
        Err(ZbootError::PayloadOutOfFile { .. })
    ));
    // Offset into the header itself, and a zero size.
    let mut z = good.clone();
    z[8..12].copy_from_slice(&8u32.to_le_bytes());
    assert!(zboot::parse(&z).is_err());
    let mut z = good.clone();
    z[12..16].copy_from_slice(&0u32.to_le_bytes());
    assert!(zboot::parse(&z).is_err());
    // Not a zboot at all.
    assert!(matches!(
        zboot::parse(&image(64)),
        Err(ZbootError::NotZboot)
    ));
    // A payload that is not gzip, and gzip of something that is not an Image.
    let z = zboot_file(&[0u8; 32], "gzip");
    assert!(matches!(
        zboot::unwrap_with(Path::new(GZIP), &z),
        Err(ZbootError::NotGzip)
    ));
    let z = zboot_file(&gzip(&[1u8; 100]), "gzip");
    assert!(matches!(
        zboot::unwrap_with(Path::new(GZIP), &z),
        Err(ZbootError::NotAnImage)
    ));
    // Corrupt gzip data: gzip fails, we report it.
    let mut bad = payload.clone();
    let mid = bad.len() / 2;
    bad[mid] ^= 0xff;
    bad.truncate(bad.len() - 4);
    let z = zboot_file(&bad, "gzip");
    assert!(zboot::unwrap_with(Path::new(GZIP), &z).is_err());
}

#[test]
fn unsupported_compression_is_an_error() {
    let payload = gzip(&image(4096));
    for comp in ["zstd", "lzma", "gzip2", "gzi", ""] {
        let z = zboot_file(&payload, comp);
        assert!(
            matches!(zboot::parse(&z), Err(ZbootError::Compression(_))),
            "{comp:?}"
        );
    }
    // No NUL inside the 32-byte field.
    let mut z = zboot_file(&payload, "gzip");
    z[24..56].copy_from_slice(&[b'g'; 32]);
    assert!(matches!(zboot::parse(&z), Err(ZbootError::Compression(_))));
}

/// SC-6: a payload that inflates past 256 MiB (a synthetic gzip of zeros) is cut off with an
/// error, and nothing past the cap is buffered.
#[test]
fn bomb_past_256_mib_is_cut_off() {
    let bomb = gzip_stream(MAX_OUTPUT + (1 << 20), |_| 0);
    assert!(bomb.len() < 2 << 20, "the bomb is small: {}", bomb.len());
    let z = zboot_file(&bomb, "gzip");
    assert!(matches!(
        zboot::unwrap_with(Path::new(GZIP), &z),
        Err(ZbootError::TooLarge)
    ));
    // Exactly at the cap is allowed by the capped reader itself.
    let at = gzip_stream(4096, |_| 0);
    assert_eq!(
        zboot::gunzip_capped(Path::new(GZIP), &at, 4096)
            .unwrap()
            .len(),
        4096
    );
    assert!(matches!(
        zboot::gunzip_capped(Path::new(GZIP), &at, 4095),
        Err(ZbootError::TooLarge)
    ));
}
