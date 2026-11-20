//! Target `zboot`: the EFI zboot header parser (`xtask::zboot::parse`; Linux
//! `drivers/firmware/efi/libstub/zboot-header.S`; threat model LDR-4, SC-5, SC-6) that finds the
//! gzip payload inside Alpine's `vmlinuz-virt` before `gzip -dc` inflates it.
//!
//! Only the parser is fuzzed: the inflation is `/usr/bin/gzip` (docs/dependencies.md), which a
//! fuzzer must not spawn millions of times.
//!
//! **Invariants:** `parse` returns `Err`, or a header whose payload `[offset, offset + size)` is
//! non-empty, lies inside the file and after the 56-byte header, and whose compression is
//! `gzip`.

use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use xtask::zboot::{HEADER_LEN, parse};

pub const TARGET: Target = Target {
    name: "zboot",
    run,
    seed,
    mutate,
    max_len: 512,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let Ok(h) = parse(data) else { return Ok(()) };
    let file = u64::try_from(data.len()).unwrap_or(u64::MAX);
    let end = h.payload_offset.checked_add(h.payload_size);
    if h.payload_size == 0
        || end.is_none_or(|e| e > file)
        || h.payload_offset < HEADER_LEN as u64
        || h.compression != "gzip"
    {
        return Err(format!("accepted header {h:?} for a {file}-byte file"));
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let len = HEADER_LEN + rng.index(400);
    let mut b = vec![0u8; len];
    b[..2].copy_from_slice(b"MZ");
    b[4..8].copy_from_slice(b"zimg");
    let off = HEADER_LEN as u64 + rng.below(16);
    put_le(&mut b, 8, 4, off);
    put_le(
        &mut b,
        12,
        4,
        rng.below((len as u64).saturating_sub(off)).max(1),
    );
    b[24..28].copy_from_slice(b"gzip");
    b
}

fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let at = rng.pick(&[8usize, 12]).unwrap_or(8);
    let v = rng
        .pick(&[0u64, 1, 55, 56, buf.len() as u64, u64::from(u32::MAX)])
        .unwrap_or(0);
    put_le(buf, at, 4, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(24);
        for _ in 0..5_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
