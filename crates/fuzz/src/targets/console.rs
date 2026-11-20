//! Target `console`: the virtio-console device (`vmm::virtio::console`; virtio 1.2 §5.3;
//! threat model TTY-1, VQ-8, VQ-9) on the `virtqueue` target's rings: the input's ring is the
//! **transmitq** (guest output), and a fixed receiveq takes host input.
//!
//! **Input:** the `virtqueue` layout (size capped at 64); the bytes after it are pushed as host
//! keyboard input.
//!
//! **Invariants:** the device writes only into WRITE descriptors and the used rings (it never
//! writes into the guest's TX buffers); everything that reaches the sink passed the terminal
//! filter, so it contains only allow-listed sequences (TTY-1, TTY-3; the `ansi` target's
//! reference recognizer); the sink received at most 3 bytes per guest byte (each byte is at worst
//! one U+FFFD); no panic.

use super::virtqueue::{self, INPUT_LEN, Spec, audit_writes, table_snapshot};
use super::{Probe, rng::capped};
use crate::Target;
use std::sync::Arc;
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SerialInput, Sink};
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::virtio::console::{CONSOLE_QUEUE_SIZE, RX_QUEUE, TX_QUEUE};
use vmm::virtio::{Console, Queue, VirtioDevice, VirtioInterrupt};

pub const TARGET: Target = Target {
    name: "console",
    run,
    seed,
    mutate,
    max_len: INPUT_LEN + 256,
};

/// The receiveq: 4 writable 64-byte buffers in region B.
const RX_DESC: u64 = super::RAM_B;
const RX_AVAIL: u64 = super::RAM_B + 0x400;
const RX_USED: u64 = super::RAM_B + 0x800;
const RX_BUF: u64 = super::RAM_B + 0x1000;

fn seed(rng: &mut crate::rng::Rng) -> Vec<u8> {
    let mut b = virtqueue::seed(rng);
    // Guest TX bytes are whatever the buffers hold: fill some with escape-heavy text.
    let n = rng.index(64);
    let mut keys = rng.bytes(n);
    for k in &mut keys {
        if rng.one_in(3) {
            *k = rng.pick(&crate::mutate::INTERESTING_BYTES).unwrap_or(0);
        }
    }
    b.extend_from_slice(&keys);
    b
}

fn mutate(rng: &mut crate::rng::Rng, buf: &mut Vec<u8>) {
    virtqueue::mutate(rng, buf);
}

pub fn run(data: &[u8]) -> crate::Verdict {
    let ring = capped(data, CONSOLE_QUEUE_SIZE.trailing_zeros() as u8);
    let (spec, mem) = virtqueue::prepared(&ring)?;
    // Guest output: every TX buffer byte comes from the guest; scribble text into the buffer
    // areas so the filter has something to chew on.
    let text: Vec<u8> = data.iter().rev().take(4096).copied().collect();
    for (i, chunk) in text.chunks(64).enumerate() {
        let at = virtqueue::BUF_A + 0x200 * u64::try_from(i).unwrap_or(0);
        let _ = mem.write(GuestAddress(at), chunk);
    }
    let table = table_snapshot(&spec, &mem);
    // The receiveq.
    for i in 0..4u64 {
        let d = vmm::virtio::Descriptor {
            addr: RX_BUF + 64 * i,
            len: 64,
            flags: vmm::virtio::chain::F_WRITE,
            next: 0,
        };
        super::ctx(
            mem.write(GuestAddress(RX_DESC + 16 * i), &d.to_le_bytes()),
            "rx",
        )?;
        super::ctx(
            mem.write_u16(
                GuestAddress(RX_AVAIL + 4 + 2 * i),
                u16::try_from(i).unwrap_or(0),
            ),
            "rx avail",
        )?;
    }
    super::ctx(mem.write_u16(GuestAddress(RX_AVAIL + 2), 4), "rx avail.idx")?;
    let mut rxq = Queue::new(4);
    rxq.set_size(4);
    rxq.set_desc_table(GuestAddress(RX_DESC));
    rxq.set_avail_ring(GuestAddress(RX_AVAIL));
    rxq.set_used_ring(GuestAddress(RX_USED));
    rxq.set_ready(true);

    let probe = Probe::default();
    let sink = Arc::new(Sink::new(
        "fuzz",
        Box::new(probe.clone()),
        FilterPolicy::Safe,
    ));
    let input = Arc::new(SerialInput::console());
    let mut con = Console::new(sink, Some(input.clone()));
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    super::ctx(con.activate(gm, vec![rxq, spec.queue()], vi), "activate")?;
    let keys = data.get(INPUT_LEN..).unwrap_or_default();
    input.push(keys);
    mem.enable_log();
    let mut tx_bytes = 0u64;
    for round in 0..spec.rounds {
        let idx = spec.per_round.wrapping_mul(round.wrapping_add(1));
        super::ctx(
            mem.write_u16(GuestAddress(spec.avail + 2), idx),
            "avail.idx",
        )?;
        if con.process_queue(TX_QUEUE, CONSOLE_QUEUE_SIZE).is_err() {
            break;
        }
        let _ = con.process_queue(RX_QUEUE, CONSOLE_QUEUE_SIZE);
    }
    let (tx, _) = con.transferred();
    tx_bytes = tx_bytes.saturating_add(tx);
    let log: Vec<_> = mem
        .log()
        .into_iter()
        .filter(|a| !(a.write && a.addr == spec.avail + 2))
        .collect();
    // RX writes (into the receiveq's buffers and used ring) are legitimate too.
    let mut rx_table = table.clone();
    rx_table.extend((0..4u64).map(|i| (RX_BUF + 64 * i, 64, 2)));
    let rx_used: Vec<_> = log
        .iter()
        .filter(|a| !super::within(a.addr, a.len, RX_USED, 6 + 8 * 4))
        .copied()
        .collect();
    let Spec { used, .. } = spec;
    if !virtqueue::self_modifying(&spec, &table) {
        audit_writes(&spec, used, &rx_table, &rx_used)?;
    }
    let out = probe.bytes();
    if !super::ansi::strictly_allowed(&out) {
        return Err(format!(
            "the console sink received a sequence outside the TTY-3 allow-list: {:?}",
            out.escape_ascii().to_string()
        ));
    }
    let bound = tx_bytes.saturating_mul(3).saturating_add(64);
    if u64::try_from(out.len()).unwrap_or(u64::MAX) > bound {
        return Err(format!(
            "{} sink bytes for {tx_bytes} guest bytes",
            out.len()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = crate::rng::Rng::new(4);
        for _ in 0..300 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
