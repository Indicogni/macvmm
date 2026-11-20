//! Target `elf`: the ELF64 loader for test guests (`vmm::loader::elf`; ELF-64 Object File
//! Format 1.5 §§3–4; threat model LDR-1, LDR-2) on mutated files.
//!
//! **Input:** the file bytes. Seeds are valid AArch64 executables with 1–3 `PT_LOAD` segments,
//! built here like `crates/vmm/tests/elf_hostile.rs` does.
//!
//! **Invariants** (threat model §9.3 "elf"): `parse` returns `Err`, or a plan whose segments
//! each lie inside RAM, overlap neither each other nor the reserved DTB window, have
//! `filesz <= memsz` and file bytes inside the file, and whose entry point is inside an
//! executable segment (the loader's contract is the entry *byte*: an entry in a segment's last
//! three bytes, or misaligned, makes the guest fault, not the VMM); `load` of an accepted plan then succeeds in a RAM of exactly that size.

use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use vmm::arch::layout::{DTB_MAX_TEST_GUEST, RAM_BASE, TEST_GUEST_BASE};
use vmm::loader::elf;
use vmm::loader::{Placement, RamRange};
use vmm::memory::{GuestAddress, VecMemory};

pub const TARGET: Target = Target {
    name: "elf",
    run,
    seed,
    mutate,
    max_len: 0x1000,
};

/// A small RAM (2 MiB), so that every iteration can afford to load into it.
const RAM: RamRange = RamRange {
    base: RAM_BASE,
    size: 2 << 20,
};

fn reserved() -> [Placement; 1] {
    [Placement {
        what: "dtb".into(),
        addr: RAM_BASE,
        len: DTB_MAX_TEST_GUEST,
    }]
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let res = reserved();
    let Ok(img) = elf::parse(data, RAM, &res) else {
        return Ok(());
    };
    let file_len = u64::try_from(data.len()).unwrap_or(u64::MAX);
    for (i, s) in img.segments.iter().enumerate() {
        if !RAM.contains(s.paddr, s.memsz) {
            return Err(format!(
                "segment {i} {:#x}+{:#x} outside RAM",
                s.paddr, s.memsz
            ));
        }
        if s.filesz > s.memsz || s.offset.checked_add(s.filesz).is_none_or(|e| e > file_len) {
            return Err(format!("segment {i} file range bad: {s:?}"));
        }
        if res
            .iter()
            .any(|r| super::overlap(s.paddr, s.memsz, r.addr, r.len))
        {
            return Err(format!("segment {i} overlaps the DTB window"));
        }
        for (j, t) in img.segments.iter().enumerate().skip(i + 1) {
            if super::overlap(s.paddr, s.memsz, t.paddr, t.memsz) {
                return Err(format!("segments {i} and {j} overlap"));
            }
        }
    }
    if !img
        .segments
        .iter()
        .any(|s| s.exec && super::within(img.entry, 1, s.paddr, s.memsz))
    {
        return Err(format!(
            "entry {:#x} not in an executable segment",
            img.entry
        ));
    }
    let mem = VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)])
        .map_err(|e| format!("VecMemory: {e:?}"))?;
    elf::load(&img, data, &mem).map_err(|e| format!("load of an accepted plan failed: {e}"))
}

/// A valid executable: up to three PT_LOAD segments in the test-guest area.
pub fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![0u8; 0x100];
    b[..4].copy_from_slice(b"\x7fELF");
    b[4] = 2;
    b[5] = 1;
    b[6] = 1;
    put_le(&mut b, 16, 2, 2); // ET_EXEC
    put_le(&mut b, 18, 2, 183); // EM_AARCH64
    put_le(&mut b, 20, 4, 1);
    put_le(&mut b, 24, 8, TEST_GUEST_BASE);
    put_le(&mut b, 32, 8, 64);
    put_le(&mut b, 52, 2, 64);
    put_le(&mut b, 54, 2, 56);
    let n = 1 + rng.index(3);
    put_le(&mut b, 56, 2, n as u64);
    let mut addr = TEST_GUEST_BASE;
    let mut off = 0x100u64;
    for i in 0..n {
        let filesz = 4 + rng.below(0x100);
        let memsz = filesz + rng.below(0x1000);
        let o = 64 + i * 56;
        put_le(&mut b, o, 4, 1);
        put_le(&mut b, o + 4, 4, if i == 0 { 5 } else { 6 });
        put_le(&mut b, o + 8, 8, off);
        put_le(&mut b, o + 16, 8, addr);
        put_le(&mut b, o + 24, 8, addr);
        put_le(&mut b, o + 32, 8, filesz);
        put_le(&mut b, o + 40, 8, memsz);
        b.extend(std::iter::repeat_n(
            0x11u8,
            usize::try_from(filesz).unwrap_or(0),
        ));
        off += filesz;
        addr = (addr + memsz + 0xfff) & !0xfff;
    }
    b
}

/// Aim a program-header field at a boundary.
fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let ph = 64 + 56 * rng.index(3);
    let field = rng.pick(&[8usize, 16, 24, 32, 40]).unwrap_or(8);
    let v = match rng.below(4) {
        0 => rng.pick(&crate::mutate::INTERESTING_U64).unwrap_or(0),
        1 => RAM_BASE + RAM.size - rng.below(0x100),
        2 => RAM_BASE + rng.below(DTB_MAX_TEST_GUEST + 0x100),
        _ => crate::mutate::get_le(buf, ph + field, 8).wrapping_add(rng.below(0x2000)),
    };
    put_le(buf, ph + field, 8, v);
    if rng.one_in(4) {
        put_le(buf, 56, 2, rng.pick(&[0u64, 1, 4, 0xffff]).unwrap_or(0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_load() {
        let mut r = Rng::new(6);
        for _ in 0..500 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            assert!(
                elf::parse(&s, RAM, &reserved()).is_ok(),
                "seed must be valid"
            );
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
