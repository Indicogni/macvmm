//! Target `rng`: the virtio-rng device (`vmm::virtio::rng`; virtio 1.2 §5.4; threat model VQ-8,
//! VQ-9, VQ-11) on the `virtqueue` target's rings.
//!
//! **Input:** the `virtqueue` layout, with the queue size capped at the device's 64.
//!
//! **Invariants** (threat model §9.3 "rng, console"): every used `len` is at most the per-request
//! cap [`RNG_MAX_REQUEST`] and at most the chain's writable length; the device writes only into
//! descriptors marked WRITE and the used ring (readable descriptors are never written); no panic.

use super::virtqueue::{self, Spec, audit_writes, table_snapshot};
use crate::Target;
use std::sync::Arc;
use vmm::backend::entropy::Entropy;
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::virtio::rng::{RNG_MAX_REQUEST, RNG_QUEUE_SIZE};
use vmm::virtio::{Rng, VirtioDevice, VirtioInterrupt};

pub const TARGET: Target = Target {
    name: "rng",
    run,
    seed: virtqueue::seed,
    mutate: virtqueue::mutate,
    max_len: virtqueue::INPUT_LEN,
};

/// Cap the size code at the device's queue size (64 = `1 << 6`).
pub fn capped(data: &[u8], max_exp: u8) -> Vec<u8> {
    let mut d = data.to_vec();
    if let Some(b) = d.first_mut() {
        *b = (*b % 9).min(max_exp);
    }
    d
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let data = capped(data, RNG_QUEUE_SIZE.trailing_zeros() as u8);
    let (spec, mem) = virtqueue::prepared(&data)?;
    let Spec { used, .. } = spec;
    let table = table_snapshot(&spec, &mem);
    let mut dev = Rng::new(Entropy::os());
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    super::ctx(dev.activate(gm, vec![spec.queue()], vi), "activate")?;
    mem.enable_log();
    for round in 0..spec.rounds {
        let idx = spec.per_round.wrapping_mul(round.wrapping_add(1));
        super::ctx(
            mem.write_u16(GuestAddress(spec.avail + 2), idx),
            "avail.idx",
        )?;
        if dev.process_queue(0, RNG_QUEUE_SIZE).is_err() {
            break;
        }
    }
    let log = mem.log();
    // The target's own avail.idx stores are the "driver": drop them before the audit.
    let device: Vec<_> = log
        .into_iter()
        .filter(|a| !(a.write && a.addr == spec.avail + 2))
        .collect();
    // A guest that points writable buffers at its own rings makes the snapshot stale (and the
    // used lengths read back its own data): nothing left to judge.
    if virtqueue::self_modifying(&spec, &table) {
        return Ok(());
    }
    audit_writes(&spec, used, &table, &device)?;
    let used_idx = super::ctx(mem.read_u16(GuestAddress(used + 2)), "used.idx")?;
    for slot in 0..u64::from(used_idx.min(spec.size)) {
        let len = super::ctx(mem.read_u32(GuestAddress(used + 8 + 8 * slot)), "used len")?;
        if u64::from(len) > RNG_MAX_REQUEST {
            return Err(format!("rng used len {len} > cap {RNG_MAX_REQUEST} (VQ-8)"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng as R;

    #[test]
    fn seeds_hold() {
        let mut r = R::new(2);
        for _ in 0..300 {
            let mut s = virtqueue::seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            virtqueue::mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
