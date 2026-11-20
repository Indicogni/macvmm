//! Target `virtqueue`: the split-ring device side (`vmm::virtio::queue`, `chain`) against
//! arbitrary rings (virtio 1.2 §2.7; architecture §11.2; threat model VQ-2..VQ-10, MEM-7).
//!
//! **Input** (fixed offsets, so the structural mutators know where descriptors are):
//!
//! | Bytes | Field |
//! |---|---|
//! | 0 | queue size: `1 << (b % 9)`, 1..=256 |
//! | 1 | bit 0 `INDIRECT_DESC` negotiated, bit 1 rings packed at the end of region B, bit 2 `avail.flags = NO_INTERRUPT` |
//! | 2..4 | avail entries published per round (more than the size is an index jump, VQ-2) |
//! | 4 | `max_total` (VQ-8): 64 KiB, 4 KiB, 1 MiB or 4 GiB |
//! | 5 | rounds: the driver republishes `1 + b % 4` times, so `used.idx` wraps the ring |
//! | 8..520 | the 256 avail-ring entries |
//! | 520.. | the descriptor table (256 × 16 bytes), then a 64-entry indirect table |
//!
//! **Invariants** (threat model §9.3 "virtqueue"):
//! 1. no panic, and a ring error latches the queue as broken (VQ-10);
//! 2. bounded work: at most `2N + 1` descriptor reads per pop (VQ-5, the hop budget);
//! 3. a chain that validated read each of its descriptors **once** (MEM-7: no double fetch);
//! 4. every buffer of a validated chain lies entirely in one RAM region (VQ-4) and each
//!    direction's total is at most `max_total` (VQ-8);
//! 5. the device writes only inside the chain's writable buffers, the used-ring element slots
//!    and `used.idx` (VQ-9), and `used.idx` advances by exactly one per completed chain.

use super::{Input, REGIONS, in_one_region, ram, within};
use crate::Target;
use crate::mutate::{self, RamShape, put_le};
use crate::rng::Rng;
use std::sync::Arc;
use vmm::arch::layout::PL011_BASE;
use vmm::memory::prelude::*;
use vmm::memory::{Access, VecMemory};
use vmm::virtio::Queue;

pub const TARGET: Target = Target {
    name: "virtqueue",
    run,
    seed,
    mutate,
    max_len: INPUT_LEN,
};

/// Input layout (module docs).
pub const HEADS_OFF: usize = 8;
pub const DESC_OFF: usize = HEADS_OFF + 2 * MAX_SIZE;
pub const IND_OFF: usize = DESC_OFF + 16 * MAX_SIZE;
pub const INPUT_LEN: usize = IND_OFF + 16 * IND_ENTRIES;
pub const MAX_SIZE: usize = 256;
pub const IND_ENTRIES: usize = 64;

/// Where the rings and the indirect table live in guest RAM (default placement).
pub const DESC: u64 = super::RAM_A + 0x1000;
pub const AVAIL: u64 = super::RAM_A + 0x2000;
pub const USED: u64 = super::RAM_A + 0x3000;
pub const IND: u64 = super::RAM_A + 0x4000;
/// Buffers go above this in region A (and anywhere in region B).
pub const BUF_A: u64 = super::RAM_A + 0x8000;

/// The decoded ring description.
#[derive(Clone, Debug)]
pub struct Spec {
    pub size: u16,
    pub indirect: bool,
    pub no_interrupt: bool,
    pub per_round: u16,
    pub max_total: u64,
    pub rounds: u16,
    pub desc: u64,
    pub avail: u64,
    pub used: u64,
}

impl Spec {
    pub fn decode(data: &[u8]) -> Spec {
        let mut i = Input::new(data);
        let size = 1u16 << (i.u8() % 9);
        let flags = i.u8();
        let per_round = i.u16();
        let max_total = match i.u8() % 4 {
            0 => 64 << 10,
            1 => 4 << 10,
            2 => 1 << 20,
            _ => 1 << 32,
        };
        let rounds = 1 + u16::from(i.u8() % 4);
        let (desc, avail, used) = if flags & 2 != 0 {
            packed_rings(size)
        } else {
            (DESC, AVAIL, USED)
        };
        Spec {
            size,
            indirect: flags & 1 != 0,
            no_interrupt: flags & 4 != 0,
            per_round,
            max_total,
            rounds,
            desc,
            avail,
            used,
        }
    }

    /// Bytes of the used ring: flags, idx, N elements, avail_event (§2.7.8).
    pub fn used_len(&self) -> u64 {
        6 + 8 * u64::from(self.size)
    }

    /// A ready device-side queue for this ring.
    pub fn queue(&self) -> Queue {
        let mut q = Queue::new(self.size);
        q.set_size(self.size);
        q.set_desc_table(GuestAddress(self.desc));
        q.set_avail_ring(GuestAddress(self.avail));
        q.set_used_ring(GuestAddress(self.used));
        q.set_indirect(self.indirect);
        q.set_ready(true);
        q
    }
}

/// The three rings packed against the end of region B, as tight as their alignment allows
/// (§2.7: descriptor table 16, avail 2, used 4), so an off-by-one runs off the end of RAM.
fn packed_rings(size: u16) -> (u64, u64, u64) {
    let n = u64::from(size);
    let end = super::RAM_B + super::RAM_B_SIZE;
    let used = (end - (6 + 8 * n)) & !3;
    let avail = (used - (6 + 2 * n)) & !1;
    let desc = (avail - 16 * n) & !15;
    (desc, avail, used)
}

/// Write the driver's side of the ring from the input into `mem` (round 0's `avail.idx`).
pub fn write_rings(spec: &Spec, data: &[u8], mem: &VecMemory) -> Result<(), String> {
    let get = |off: usize, n: usize| data.get(off..off.saturating_add(n).min(data.len()));
    let mut table = vec![0u8; 16 * usize::from(spec.size)];
    if let Some(src) = get(DESC_OFF, table.len()) {
        table
            .get_mut(..src.len())
            .unwrap_or_default()
            .copy_from_slice(src);
    }
    let w = |addr: u64, b: &[u8]| {
        mem.write(GuestAddress(addr), b)
            .map_err(|e| format!("ring setup at {addr:#x}: {e:?}"))
    };
    w(spec.desc, &table)?;
    let mut ind = vec![0u8; 16 * IND_ENTRIES];
    if let Some(src) = get(IND_OFF, ind.len()) {
        ind.get_mut(..src.len())
            .unwrap_or_default()
            .copy_from_slice(src);
    }
    w(IND, &ind)?;
    let mut avail = vec![0u8; 4 + 2 * usize::from(spec.size)];
    put_le(&mut avail, 0, 2, u64::from(spec.no_interrupt));
    put_le(&mut avail, 2, 2, u64::from(spec.per_round));
    for slot in 0..usize::from(spec.size) {
        let head = crate::mutate::get_le(data, HEADS_OFF + 2 * slot, 2);
        put_le(&mut avail, 4 + 2 * slot, 2, head);
    }
    w(spec.avail, &avail)
}

/// The 16-byte (descriptor) reads in an access log.
pub fn descriptor_reads(log: &[Access]) -> Vec<u64> {
    log.iter()
        .filter(|a| !a.write && !a.fence && a.len == 16)
        .map(|a| a.addr)
        .collect()
}

/// Invariant 3: no address appears twice.
pub fn read_once(reads: &[u64]) -> Result<(), String> {
    let mut seen = reads.to_vec();
    seen.sort_unstable();
    match seen.windows(2).find(|w| w.first() == w.get(1)) {
        Some(w) => Err(format!(
            "descriptor at {:#x} read twice in one pop (double fetch, MEM-7)",
            w.first().copied().unwrap_or(0)
        )),
        None => Ok(()),
    }
}

/// Invariant 4 on one validated chain.
pub fn chain_in_ram(v: &vmm::virtio::ValidatedChain, max_total: u64) -> Result<(), String> {
    for d in v.readable.iter().chain(&v.writable) {
        if !in_one_region(d.addr, u64::from(d.len)) {
            return Err(format!(
                "validated buffer {:#x}+{:#x} is not inside one RAM region (VQ-4)",
                d.addr, d.len
            ));
        }
    }
    let sum = |ds: &[vmm::virtio::Descriptor]| ds.iter().map(|d| u64::from(d.len)).sum::<u64>();
    if v.readable_len > max_total
        || v.writable_len > max_total
        || sum(&v.readable) != v.readable_len
        || sum(&v.writable) != v.writable_len
    {
        return Err(format!(
            "chain totals r={} w={} vs max_total {max_total} (VQ-8)",
            v.readable_len, v.writable_len
        ));
    }
    Ok(())
}

// ANCHOR: fuzz_virtqueue_target
/// Run one ring (module docs for the input and the invariants).
pub fn run(data: &[u8]) -> crate::Verdict {
    let spec = Spec::decode(data);
    let mem = ram()?;
    write_rings(&spec, data, &mem)?;
    let mut q = spec.queue();
    // Invariant 2: the hop budget is N per table, and an indirect table has at most N entries.
    let max_reads = 2 * usize::from(spec.size) + 1;
    let mut completed: u16 = 0;
    for round in 0..spec.rounds {
        let idx = spec.per_round.wrapping_mul(round.wrapping_add(1));
        mem.write_u16(GuestAddress(spec.avail + 2), idx)
            .map_err(|e| format!("avail.idx: {e:?}"))?;
        for _ in 0..=spec.size {
            mem.enable_log(); // the access log of this one pop
            let chain = match q.pop(&*mem) {
                Ok(None) => break,
                Ok(Some(c)) => c,
                Err(_) if q.is_broken() && q.pop(&*mem).is_err() => return Ok(()), // VQ-10
                Err(_) => return Err("a ring error did not latch the queue as broken".into()),
            };
            let validated = chain.into_validated(spec.max_total);
            let reads = descriptor_reads(&mem.log());
            if reads.len() > max_reads {
                return Err(format!(
                    "{} descriptor reads for one pop of a size-{} queue (VQ-5 hop budget)",
                    reads.len(),
                    spec.size
                ));
            }
            let Ok(v) = validated else {
                return Ok(()); // the device would set NEEDS_RESET here
            };
            read_once(&reads)?; // invariant 3 (MEM-7)
            chain_in_ram(&v, spec.max_total)?; // invariant 4 (VQ-4, VQ-8)
            match complete(&spec, &mem, &mut q, &v, completed)? {
                Some(c) => completed = c,
                None => return Ok(()),
            }
        }
    }
    Ok(())
}
// ANCHOR_END: fuzz_virtqueue_target

/// Invariant 5: complete `v` the way a device does (fill its writable buffers, `add_used`),
/// then audit every write that made and the new `used.idx`. `Ok(None)`: `add_used` refused (a
/// broken ring; the device would reset), nothing more to check.
fn complete(
    spec: &Spec,
    mem: &VecMemory,
    q: &mut Queue,
    v: &vmm::virtio::ValidatedChain,
    completed: u16,
) -> Result<Option<u16>, String> {
    let n = u64::from(spec.size);
    mem.enable_log();
    let fill = vec![0xa5u8; usize::try_from(v.writable_len.min(1 << 20)).unwrap_or(0)];
    let written = v
        .write_writable(mem, &fill)
        .map_err(|e| format!("write into validated buffers failed: {e:?}"))?;
    if u64::from(written) > v.writable_len {
        return Err(format!(
            "used len {written} > writable {} (VQ-9)",
            v.writable_len
        ));
    }
    if q.add_used(mem, v.head, written).is_err() {
        return Ok(None);
    }
    let completed = completed.wrapping_add(1);
    for a in mem.log().iter().filter(|a| a.write && !a.fence) {
        let in_buf = v
            .writable
            .iter()
            .any(|d| within(a.addr, a.len, d.addr, u64::from(d.len)));
        let in_elems = within(a.addr, a.len, spec.used + 4, 8 * n);
        let is_idx = a.addr == spec.used + 2 && a.len == 2;
        if !(in_buf || in_elems || is_idx) {
            return Err(format!(
                "device wrote {:#x}+{} outside the writable buffers and the used ring \
                 (used ring {:#x}+{:#x}; VQ-9)",
                a.addr,
                a.len,
                spec.used,
                spec.used_len()
            ));
        }
    }
    let used_idx = mem
        .read_u16(GuestAddress(spec.used + 2))
        .map_err(|e| format!("used.idx: {e:?}"))?;
    if used_idx != completed {
        return Err(format!(
            "used.idx is {used_idx} after {completed} completions"
        ));
    }
    Ok(Some(completed))
}

/// A random well-formed ring: `k` chains of 1..=4 buffers, readable before writable, some
/// through the indirect table, buffers anywhere in either region.
pub fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![0u8; INPUT_LEN];
    let exp = if rng.one_in(4) {
        rng.below(9)
    } else {
        rng.below(5)
    };
    let size = 1usize << exp;
    let indirect = rng.coin();
    b[0] = exp as u8;
    b[1] =
        u8::from(indirect) | if rng.one_in(4) { 2 } else { 0 } | if rng.one_in(3) { 4 } else { 0 };
    b[4] = rng.below(4) as u8;
    b[5] = rng.below(4) as u8;
    let mut next_desc = 0usize;
    let mut next_ind = 0usize;
    let mut heads = Vec::new();
    while next_desc < size && heads.len() < size {
        let head = next_desc;
        let parts = 1 + rng.index(4);
        let use_ind = indirect && rng.one_in(3) && next_ind + parts <= IND_ENTRIES;
        let parts = if use_ind {
            parts
        } else {
            parts.min(size - next_desc)
        };
        let write_from = rng.index(parts + 1);
        let buffer = |rng: &mut Rng, k: usize| -> (u64, u64, u64) {
            let (base, size) = if rng.coin() {
                (BUF_A, super::RAM_A + super::RAM_A_SIZE - BUF_A)
            } else {
                (super::RAM_B, super::RAM_B_SIZE)
            };
            let len = 1 + rng.below(1024);
            let addr = base + rng.below(size - len);
            let flags = if k >= write_from { 2 } else { 0 };
            (addr, len, flags)
        };
        if use_ind {
            let rec = DESC_OFF + 16 * next_desc;
            put_le(&mut b, rec, 8, IND + 16 * next_ind as u64);
            put_le(&mut b, rec + 8, 4, 16 * parts as u64);
            put_le(&mut b, rec + 12, 2, 4);
            next_desc += 1;
            for k in 0..parts {
                let (addr, len, mut flags) = buffer(rng, k);
                let rec = IND_OFF + 16 * (next_ind + k);
                if k + 1 < parts {
                    flags |= 1;
                    put_le(&mut b, rec + 14, 2, (k + 1) as u64);
                }
                put_le(&mut b, rec, 8, addr);
                put_le(&mut b, rec + 8, 4, len);
                put_le(&mut b, rec + 12, 2, flags);
            }
            next_ind += parts;
        } else {
            for k in 0..parts {
                let (addr, len, mut flags) = buffer(rng, k);
                let rec = DESC_OFF + 16 * (next_desc + k);
                if k + 1 < parts {
                    flags |= 1;
                    put_le(&mut b, rec + 14, 2, (next_desc + k + 1) as u64);
                }
                put_le(&mut b, rec, 8, addr);
                put_le(&mut b, rec + 8, 4, len);
                put_le(&mut b, rec + 12, 2, flags);
            }
            next_desc += parts;
        }
        heads.push(head);
        if rng.one_in(3) {
            break;
        }
    }
    for slot in 0..MAX_SIZE {
        let h = heads.get(slot % heads.len().max(1)).copied().unwrap_or(0);
        put_le(&mut b, HEADS_OFF + 2 * slot, 2, h as u64);
    }
    put_le(&mut b, 2, 2, heads.len() as u64);
    b
}

/// Structural mutation: descriptor shapes in either table, or the header and avail entries.
pub fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    if buf.len() < INPUT_LEN {
        buf.resize(INPUT_LEN, 0);
    }
    let specials = [
        DESC,
        AVAIL,
        USED,
        IND,
        PL011_BASE,
        super::RAM_A + super::RAM_A_SIZE,
    ];
    let shape = RamShape {
        regions: &REGIONS,
        specials: &specials,
    };
    let size = 1usize << (buf.first().copied().unwrap_or(0) % 9);
    for _ in 0..1 + rng.index(3) {
        match rng.below(8) {
            0..=3 => mutate::descriptor(rng, buf, DESC_OFF, size, &shape),
            4 | 5 => mutate::descriptor(rng, buf, IND_OFF, IND_ENTRIES, &shape),
            6 => {
                let slot = rng.index(MAX_SIZE);
                let v = rng.pick(&[0u64, 1, size as u64 - 1, size as u64, u64::from(u16::MAX)]);
                put_le(buf, HEADS_OFF + 2 * slot, 2, v.unwrap_or(0));
            }
            _ => {
                let v = rng.pick(&[0u64, 1, size as u64, size as u64 + 1, 0x8000, 0xffff]);
                put_le(buf, 2, 2, v.unwrap_or(0));
            }
        }
    }
}

/// The `(addr, len, flags)` of every descriptor in the main and indirect tables, read before
/// a device runs: the reference for auditing its writes (device targets `rng`, `console`).
pub fn table_snapshot(spec: &Spec, mem: &VecMemory) -> Vec<(u64, u64, u16)> {
    let mut out = Vec::new();
    let tables = [(spec.desc, u64::from(spec.size)), (IND, IND_ENTRIES as u64)];
    for (base, n) in tables {
        for i in 0..n {
            let a = GuestAddress(base + 16 * i);
            let (Ok(addr), Ok(len), Ok(flags)) = (
                mem.read_u64(a),
                mem.read_u32(GuestAddress(a.0 + 8)),
                mem.read_u16(GuestAddress(a.0 + 12)),
            ) else {
                continue;
            };
            out.push((addr, u64::from(len), flags));
        }
    }
    out
}

/// True if the guest pointed a writable buffer at its own rings or indirect table. The device's
/// data then rewrites descriptors mid-run, so a snapshot taken before the run no longer says
/// which buffers are writable, and [`audit_writes`] cannot judge. (Legal for a guest to do; it
/// only corrupts its own rings.)
pub fn self_modifying(spec: &Spec, table: &[(u64, u64, u16)]) -> bool {
    let rings = [
        (spec.desc, 16 * u64::from(spec.size)),
        (IND, 16 * IND_ENTRIES as u64),
        (spec.avail, 6 + 2 * u64::from(spec.size)),
        (spec.used, spec.used_len()),
    ];
    table
        .iter()
        .any(|&(a, l, f)| f & 2 != 0 && rings.iter().any(|&(r, rl)| super::overlap(a, l, r, rl)))
}

/// Audit a device's writes (VQ-9, "readable descriptors are never written"): each logged write
/// must lie in a descriptor marked WRITE, or in the used ring's element slots or `used.idx`.
pub fn audit_writes(
    spec: &Spec,
    used: u64,
    table: &[(u64, u64, u16)],
    log: &[Access],
) -> crate::Verdict {
    let n = u64::from(spec.size);
    for a in log.iter().filter(|a| a.write && !a.fence) {
        let in_writable = table
            .iter()
            .any(|&(addr, len, flags)| flags & 2 != 0 && within(a.addr, a.len, addr, len));
        let in_used = within(a.addr, a.len, used + 4, 8 * n) || (a.addr == used + 2 && a.len == 2);
        if !(in_writable || in_used) {
            return Err(format!(
                "device wrote {:#x}+{}: not a writable buffer, not the used ring (VQ-9)",
                a.addr, a.len
            ));
        }
    }
    Ok(())
}

/// Shared with `virtqueue_race`: the guest RAM after `write_rings`, ready to race.
pub fn prepared(data: &[u8]) -> Result<(Spec, Arc<VecMemory>), String> {
    let spec = Spec::decode(data);
    let mem = ram()?;
    write_rings(&spec, data, &mem)?;
    Ok((spec, mem))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_pass_and_mutants_never_panic() {
        let mut rng = Rng::new(1);
        for _ in 0..2_000 {
            let s = seed(&mut rng);
            assert_eq!(run(&s), Ok(()), "a well-formed ring must pass");
            let mut m = s.clone();
            mutate(&mut rng, &mut m);
            crate::mutate::bytes(&mut rng, &mut m, INPUT_LEN);
            let _ = run(&m);
        }
        assert!(run(&[]).is_ok());
    }
}
