//! Target `stage1`: the guest stage-1 page-table walker used for ISV=0 emulation
//! (`vmm::arch::stage1_walk`; Arm ARM D8.2 "Translation process", D8.3 descriptor formats,
//! D24.2.205 TCR_EL1; threat model MMIO-5).
//!
//! **Why fuzz it.** The tables are guest memory: a hostile kernel controls every descriptor,
//! including ones that point back at themselves, outside RAM, or at a level that should not
//! exist for the granule. The walker must terminate, read only RAM, and never trust a level.
//!
//! **Input:** TCR selector and raw bits, the two TTBR table indices, SCTLR.M, the VA, then up to
//! 16 KiB of page-table bytes copied to the start of guest RAM.
//!
//! **Invariants** (threat model §9.3 "stage1"): the walk terminates within the level bound
//! (at most [`MAX_LEVELS`] descriptor reads, each an aligned 8-byte read); a translation has a
//! level ≤ 3, a power-of-two mapping size, and keeps the VA's offset within that mapping.

use super::Input;
use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use vmm::arch::stage1_walk::{MAX_LEVELS, TranslationRegs, translate};
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};

pub const TARGET: Target = Target {
    name: "stage1",
    run,
    seed,
    mutate,
    max_len: HDR + TABLES,
};

const HDR: usize = 40;
const TABLES: usize = 0x4000;
const TABLE_RAM: u64 = super::RAM_A;

/// Plausible TCR_EL1 values: T0SZ/T1SZ 16..=39, the three granules (D24.2.205).
fn tcr(sel: u8, raw: u64) -> u64 {
    let tsz = 16 + u64::from(sel % 24);
    let tg0 = [0b00u64, 0b10, 0b01][usize::from(sel / 24 % 3)] << 14;
    let tg1 = [0b10u64, 0b01, 0b11][usize::from(sel / 72 % 3)] << 30;
    match sel % 8 {
        7 => raw,
        _ => tsz | tsz << 16 | tg0 | tg1 | (raw & (1 << 7 | 1 << 23 | 1 << 37 | 1 << 38)),
    }
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut i = Input::new(data);
    let sel = i.u8();
    let raw = i.u64();
    let t0 = u64::from(i.u8() % 4);
    let t1 = u64::from(i.u8() % 4);
    let m = i.bool();
    let va = i.u64();
    let _ = i.bytes(HDR - 20);
    let tables = i.rest();
    let mem = VecMemory::new(&[(GuestAddress(TABLE_RAM), TABLES as u64)])
        .map_err(|e| format!("VecMemory: {e:?}"))?;
    let n = tables.len().min(TABLES);
    super::ctx(
        mem.write(GuestAddress(TABLE_RAM), tables.get(..n).unwrap_or_default()),
        "tables",
    )?;
    let regs = TranslationRegs {
        sctlr_el1: u64::from(m),
        tcr_el1: tcr(sel, raw),
        ttbr0_el1: TABLE_RAM + 0x1000 * t0,
        ttbr1_el1: TABLE_RAM + 0x1000 * t1,
    };
    mem.enable_log();
    let r = translate(&mem, &regs, va);
    let log = mem.log();
    if log.len() > MAX_LEVELS as usize {
        return Err(format!(
            "{} descriptor reads for one walk (bound {MAX_LEVELS})",
            log.len()
        ));
    }
    if let Some(a) = log
        .iter()
        .find(|a| a.write || a.len != 8 || a.addr % 8 != 0)
    {
        return Err(format!("walker made a non-descriptor access {a:?}"));
    }
    if let Ok(t) = r {
        if t.level > 3 {
            return Err(format!("translation at level {}", t.level));
        }
        if t.mapping_size != 0 {
            if !t.mapping_size.is_power_of_two() {
                return Err(format!("mapping size {:#x}", t.mapping_size));
            }
            let mask = t.mapping_size - 1;
            if t.ipa & mask != va & mask {
                return Err(format!(
                    "va {va:#x} -> ipa {:#x} loses the offset within a {:#x} mapping",
                    t.ipa, t.mapping_size
                ));
            }
        }
    }
    Ok(())
}

/// Random descriptors, with valid table/page bits and output addresses inside the tables.
fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![0u8; HDR + TABLES];
    b[0] = rng.byte();
    b[9] = rng.byte();
    b[10] = rng.byte();
    b[11] = 1;
    put_le(&mut b, 12, 8, rng.next_u64() & 0x0000_ffff_ffff_ffff);
    for k in 0..TABLES / 8 {
        if rng.one_in(4) {
            let next = TABLE_RAM + 0x1000 * rng.below(4);
            let kind = rng.pick(&[0b11u64, 0b01, 0b00, 0b10]).unwrap_or(3);
            put_le(&mut b, HDR + 8 * k, 8, next | 1 << 10 | kind);
        }
    }
    b
}

fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let k = rng.index(TABLES / 8);
    let v = match rng.below(3) {
        0 => (TABLE_RAM + 8 * rng.below(TABLES as u64 / 8)) | 0b11,
        1 => rng.pick(&crate::mutate::INTERESTING_U64).unwrap_or(0),
        _ => (TABLE_RAM + 0x1000 * rng.below(4)) | 0b11,
    };
    put_le(buf, HDR + 8 * k, 8, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(15);
        for _ in 0..500 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
