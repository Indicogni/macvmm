//! Target `image`: the arm64 Linux `Image` header parser and placement (`vmm::loader::image`;
//! Linux `Documentation/arch/arm64/booting.rst` §4; threat model LDR-3, LDR-4).
//!
//! **Input:** the first bytes of an Image (the 64-byte header plus a little text); the seed is
//! the Alpine 6.18 header shape from `crates/vmm/tests/image_hostile.rs`.
//!
//! **Invariants:** `place` returns `Err`, or a placement whose `[load, end)` lies inside RAM,
//! starts at a 2 MiB-aligned base plus `text_offset` (booting.rst §4), and records the file's
//! true length (a file longer than `image_size` is then refused by `image::load`).

use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use vmm::arch::layout::{LINUX_ALIGN, RAM_BASE};
use vmm::loader::RamRange;
use vmm::loader::image;

pub const TARGET: Target = Target {
    name: "image",
    run,
    seed,
    mutate,
    max_len: 0x400,
};

pub const RAM: RamRange = RamRange {
    base: RAM_BASE,
    size: 512 << 20,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let Ok(img) = image::place(data, RAM) else {
        return Ok(());
    };
    let len = img.end.checked_sub(img.load).ok_or("end < load")?;
    if !RAM.contains(img.load, len) {
        return Err(format!("image {:#x}..{:#x} outside RAM", img.load, img.end));
    }
    let base = img
        .load
        .checked_sub(img.header.text_offset)
        .ok_or("load below text_offset")?;
    if !base.is_multiple_of(LINUX_ALIGN) {
        return Err(format!(
            "base {base:#x} (load {:#x} - text_offset {:#x}) not 2 MiB aligned",
            img.load, img.header.text_offset
        ));
    }
    // A file longer than `image_size` is refused later, by `image::load` (LDR-3).
    if img.file_len != u64::try_from(data.len()).unwrap_or(u64::MAX) {
        return Err(format!("file_len {} vs file {}", img.file_len, data.len()));
    }
    Ok(())
}

/// A valid header: `b +0x40`, text_offset, image_size, flags, magic `ARM\x64` (booting.rst §4).
pub fn header(rng: &mut Rng, len: usize) -> Vec<u8> {
    let mut b = vec![0u8; len.max(64)];
    put_le(&mut b, 0, 4, 0x1400_0010);
    put_le(&mut b, 8, 8, if rng.one_in(4) { 0x8_0000 } else { 0 });
    put_le(&mut b, 16, 8, 0x10_0000 + (rng.below(64) << 20));
    put_le(
        &mut b,
        24,
        8,
        rng.pick(&[0b1010u64, 0b0010, 0b1000, 0]).unwrap_or(0),
    );
    b[56..60].copy_from_slice(b"ARM\x64");
    b
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let len = 64 + rng.index(0x300);
    header(rng, len)
}

fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let field = rng.pick(&[8usize, 16, 24]).unwrap_or(8);
    let v = rng.pick(&crate::mutate::INTERESTING_U64).unwrap_or(0);
    let v = if rng.coin() {
        v
    } else {
        crate::mutate::get_le(buf, field, 8) ^ (1 << rng.below(64))
    };
    put_le(buf, field, 8, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_place() {
        let mut r = Rng::new(10);
        for _ in 0..2_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
