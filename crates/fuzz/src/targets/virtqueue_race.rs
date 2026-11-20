//! Target `virtqueue_race`: the `virtqueue` rings, plus a **second thread that rewrites ring bytes
//! while the device walks them** (threat model §9.3, TEST-4; flaw class "double fetch").
//!
//! **Why a racing thread.** Guest RAM is shared with running vCPUs: between two reads of the same
//! descriptor, a malicious driver on another vCPU can change it. A walker that validates `len`
//! and then reads `len` again uses a value nobody checked (time-of-check to time-of-use; MEM-7
//! "copy once, then validate the copy"). The deterministic `virtqueue_toctou` host test catches
//! this with a mutation hook at a chosen read; this target does it the way a guest would, with
//! real concurrency, so it also finds re-reads that test did not anticipate.
//!
//! The racer writes random descriptors (biased toward huge lengths and addresses past the end of
//! RAM) and random entries of the `avail` ring the device actually reads (`spec.avail`, which
//! moves when the input packs the rings at the end of region B), through `VecMemory::write` like
//! a vCPU store.
//!
//! **Invariants:** no panic; no hang (the driver's watchdog, 1 s by default); every buffer of a
//! validated chain is inside one RAM region and within `max_total`; and each descriptor was read
//! once per successful pop (the access log). The racer's own writes are in the log too, so this
//! target does not audit the device's writes; `virtqueue` does.
//!
//! **Two variants.** The access-log checks (read once, read count) catch a double fetch
//! deterministically, *without* the racer: the plain `virtqueue` target finds one too. To show
//! that the racer itself has teeth, `scripts/bughunt-selftest.sh` runs the hidden variant
//! `virtqueue_race_only` ([`RACE_ONLY`]), which keeps the racer and drops the access log: there
//! a double fetch is found only when the racer really changes a descriptor between the check
//! and the second read, and the walker then hands out a buffer outside RAM (VQ-4).
//!
//! The extra input bytes at offset `INPUT_LEN` pick the racer's seed.

use super::virtqueue::{
    self, IND, IND_ENTRIES, INPUT_LEN, chain_in_ram, descriptor_reads, read_once,
};
use crate::Target;
use crate::rng::Rng;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use vmm::memory::prelude::*;

pub const TARGET: Target = Target {
    name: "virtqueue_race",
    run,
    seed,
    mutate: virtqueue::mutate,
    max_len: INPUT_LEN + 8,
};

fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = virtqueue::seed(rng);
    b.extend_from_slice(&rng.next_u64().to_le_bytes());
    b
}

/// The racer alone, no access-log checks (module docs). Not in `targets::ALL`, so neither
/// `list` nor `all` runs it; `fuzz virtqueue_race_only` does (`fuzz::find`).
pub const RACE_ONLY: Target = Target {
    name: "virtqueue_race_only",
    run: run_race_only,
    seed,
    mutate: virtqueue::mutate,
    max_len: INPUT_LEN + 8,
};

/// Run one ring with a racer and every check (module docs).
pub fn run(data: &[u8]) -> crate::Verdict {
    race(data, true)
}

/// Run one ring with a racer, without the access-log checks (module docs, [`RACE_ONLY`]).
pub fn run_race_only(data: &[u8]) -> crate::Verdict {
    race(data, false)
}

fn race(data: &[u8], log_checks: bool) -> crate::Verdict {
    let (spec, mem) = virtqueue::prepared(data)?;
    let racer_seed = crate::mutate::get_le(data, INPUT_LEN, 8);
    let stop = Arc::new(AtomicBool::new(false));
    let racer = {
        let (mem, stop) = (Arc::clone(&mem), Arc::clone(&stop));
        let size = u64::from(spec.size);
        let (desc, avail) = (spec.desc, spec.avail);
        std::thread::spawn(move || {
            let mut r = Rng::new(racer_seed);
            let mut n = 0u32;
            while !stop.load(Ordering::Relaxed) && n < 20_000 {
                n += 1;
                let (table, entries) = if r.coin() {
                    (desc, size)
                } else {
                    (IND, IND_ENTRIES as u64)
                };
                let at = table + 16 * r.below(entries);
                match r.below(4) {
                    // len: huge, or just past the end of the region.
                    0 => {
                        let len = r
                            .pick(&[u32::MAX, 0x8000_0000, 0x4_0000, 0x1_0001])
                            .unwrap_or(0);
                        let _ = mem.write(GuestAddress(at + 8), &len.to_le_bytes());
                    }
                    // addr: into the hole between the regions, or past RAM.
                    1 => {
                        let addr = super::RAM_A + super::RAM_A_SIZE - 1 - r.below(8);
                        let _ = mem.write(GuestAddress(at), &addr.to_le_bytes());
                    }
                    // flags/next.
                    2 => {
                        let _ = mem.write(GuestAddress(at + 12), &r.next_u64().to_le_bytes()[..4]);
                    }
                    _ => {
                        let slot = r.below(size);
                        let _ = mem.write_u16(
                            GuestAddress(avail + 4 + 2 * slot),
                            u16::try_from(r.below(size)).unwrap_or(0),
                        );
                    }
                }
                if n.is_multiple_of(64) {
                    std::thread::yield_now();
                }
            }
        })
    };
    let verdict = walk(&spec, &mem, log_checks);
    stop.store(true, Ordering::Relaxed);
    if racer.join().is_err() {
        return Err("the racer thread panicked".into());
    }
    verdict
}

fn walk(spec: &virtqueue::Spec, mem: &vmm::memory::VecMemory, log_checks: bool) -> crate::Verdict {
    let mut q = spec.queue();
    let max_reads = 2 * usize::from(spec.size) + 1;
    for round in 0..spec.rounds {
        let idx = spec.per_round.wrapping_mul(round.wrapping_add(1));
        let _ = mem.write_u16(GuestAddress(spec.avail + 2), idx);
        for _ in 0..=spec.size {
            if log_checks {
                mem.enable_log();
            }
            let chain = match q.pop(mem) {
                Ok(None) => break,
                Ok(Some(c)) => c,
                Err(_) => return Ok(()),
            };
            let validated = chain.into_validated(spec.max_total);
            let reads = if log_checks {
                descriptor_reads(&mem.log())
            } else {
                Vec::new()
            };
            if reads.len() > max_reads {
                return Err(format!(
                    "{} descriptor reads in one pop (VQ-5)",
                    reads.len()
                ));
            }
            let Ok(v) = validated else { return Ok(()) };
            read_once(&reads)?;
            chain_in_ram(&v, spec.max_total)?;
            let fill = vec![0x5au8; usize::try_from(v.writable_len.min(1 << 20)).unwrap_or(0)];
            let Ok(written) = v.write_writable(mem, &fill) else {
                return Err("a write into a validated buffer failed".into());
            };
            if q.add_used(mem, v.head, written).is_err() {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn racing_seeds_hold() {
        let mut rng = Rng::new(3);
        for _ in 0..200 {
            let s = seed(&mut rng);
            assert_eq!(run(&s), Ok(()));
            assert_eq!(run_race_only(&s), Ok(()));
        }
    }
}
