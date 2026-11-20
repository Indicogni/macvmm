//! Target `virtio_mmio`: the virtio-mmio transport's register file and status machine
//! (`vmm::virtio::mmio`; virtio 1.2 §4.2.2, §3.1; threat model VQ-13..VQ-16) driven by
//! arbitrary sequences of guest accesses, with a mock device behind it.
//!
//! **Input:** a sequence of 11-byte operations `[kind, offset lo, offset hi, value × 8]`:
//! bit 0 of `kind` is write, bits 1–2 the width (1, 2, 4, 8 bytes); the offset is masked to the
//! 0x200-byte window. A queue notify runs the mock device inline, exactly as a vCPU would.
//!
//! **Invariants** (threat model §9.3 "virtio_mmio"):
//! 1. the status never shows DRIVER_OK unless it shows FEATURES_OK and the device was handed a
//!    feature set containing `VERSION_1` (§3.1.1, VQ-15);
//! 2. no queue register changes while the queue is ready (§4.2.2.2: the driver MUST NOT, and
//!    the device ignores it, VQ-14);
//! 3. the interrupt line is high exactly when `InterruptStatus != 0` (§4.2.2, level-triggered
//!    SPIs, architecture §6.3), after every access;
//! 4. no panic.

use super::{Input, ram};
use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use std::sync::{Arc, Mutex};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::virtio::mmio::reg;
use vmm::virtio::{
    Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt, VirtioMmio, features,
    status as st,
};

pub const TARGET: Target = Target {
    name: "virtio_mmio",
    run,
    seed,
    mutate,
    max_len: 11 * 256,
};

/// The registers a driver touches, for seeds and mutations.
const REGS: [u64; 22] = [
    reg::MAGIC,
    reg::DEVICE_FEATURES,
    reg::DEVICE_FEATURES_SEL,
    reg::DRIVER_FEATURES,
    reg::DRIVER_FEATURES_SEL,
    reg::QUEUE_SEL,
    reg::QUEUE_NUM_MAX,
    reg::QUEUE_NUM,
    reg::QUEUE_READY,
    reg::QUEUE_NOTIFY,
    reg::INTERRUPT_STATUS,
    reg::INTERRUPT_ACK,
    reg::STATUS,
    reg::QUEUE_DESC_LOW,
    reg::QUEUE_DESC_HIGH,
    reg::QUEUE_DRIVER_LOW,
    reg::QUEUE_DRIVER_HIGH,
    reg::QUEUE_DEVICE_LOW,
    reg::QUEUE_DEVICE_HIGH,
    reg::QUEUE_RESET,
    reg::CONFIG_GENERATION,
    reg::CONFIG,
];

/// A device model that records what the transport told it.
struct Mock {
    acked: Arc<Mutex<Option<u64>>>,
    mem: Option<Arc<dyn GuestMemoryOrdered>>,
    queues: Vec<Queue>,
    irq: Option<Arc<VirtioInterrupt>>,
    config: [u8; 8],
}

impl VirtioDevice for Mock {
    fn device_id(&self) -> u32 {
        4
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &[16, 4]
    }
    fn device_features(&self) -> u64 {
        features::VERSION_1 | features::INDIRECT_DESC | 1
    }
    fn ack_features(&mut self, accepted: u64) {
        if let Ok(mut a) = self.acked.lock() {
            *a = Some(accepted);
        }
    }
    fn config_len(&self) -> u32 {
        8
    }
    fn read_config(&self, offset: u32, data: &mut [u8]) {
        let o = usize::try_from(offset).unwrap_or(usize::MAX);
        if let Some(src) = self.config.get(o..o.saturating_add(data.len())) {
            data.copy_from_slice(src);
        }
    }
    fn write_config(&mut self, offset: u32, data: &[u8]) {
        let o = usize::try_from(offset).unwrap_or(usize::MAX);
        if let Some(dst) = self.config.get_mut(o..o.saturating_add(data.len())) {
            dst.copy_from_slice(data);
        }
    }
    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        self.mem = Some(mem);
        self.queues = queues;
        self.irq = Some(irq);
        Ok(())
    }
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        let mem = self.mem.clone().ok_or(VirtioError::NotActivated)?;
        let q = self
            .queues
            .get_mut(index)
            .ok_or(VirtioError::NoSuchQueue(index))?;
        let mut used = false;
        for _ in 0..budget {
            let Some(chain) = q.pop(&*mem)? else {
                break;
            };
            let v = chain.into_validated(64 << 10)?;
            let fill = vec![0xab; usize::try_from(v.writable_len).unwrap_or(0)];
            let n = v.write_writable(&*mem, &fill)?;
            q.add_used(&*mem, v.head, n)?;
            used = true;
        }
        if used
            && q.should_interrupt(&*mem)?
            && let Some(irq) = &self.irq
        {
            irq.signal_used();
        }
        Ok(QueueProgress::Drained)
    }
    fn reset(&mut self) {
        if let Ok(mut a) = self.acked.lock() {
            *a = None;
        }
        self.mem = None;
        self.queues.clear();
        self.irq = None;
    }
}

fn size_of(code: u8) -> AccessSize {
    match (code >> 1) & 3 {
        0 => AccessSize::B1,
        1 => AccessSize::B2,
        2 => AccessSize::B4,
        _ => AccessSize::B8,
    }
}

/// What a ready queue looks like from outside (invariant 2).
fn snapshot(t: &VirtioMmio, i: usize) -> Option<(u16, u64, u64, u64)> {
    t.queue(i).filter(|q| q.ready()).map(|q| {
        (
            q.size(),
            q.desc_table().0,
            q.avail_ring().0,
            q.used_ring().0,
        )
    })
}

/// Run one access sequence (module docs).
pub fn run(data: &[u8]) -> crate::Verdict {
    let mem = ram()?;
    let irq = Arc::new(TestIrq::new());
    let acked = Arc::new(Mutex::new(None));
    let dev = Mock {
        acked: Arc::clone(&acked),
        mem: None,
        queues: Vec::new(),
        irq: None,
        config: [0; 8],
    };
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    let mut t = VirtioMmio::new(
        Arc::new(Mutex::new(dev)),
        Arc::new(VirtioInterrupt::new(irq.clone())),
        Some(gm),
    )
    .map_err(|e| format!("transport: {e}"))?;
    // ANCHOR: fuzz_mmio_sequence
    let mut input = Input::new(data);
    let mut steps = 0;
    while !input.is_empty() && steps < 256 {
        steps += 1;
        let kind = input.u8();
        let offset = u64::from(input.u16()) % 0x200;
        let value = input.u64();
        let size = size_of(kind);
        let before = [snapshot(&t, 0), snapshot(&t, 1)];
        if kind & 1 == 1 {
            t.write(offset, size, value);
            for (i, b) in before.iter().enumerate() {
                if let (Some(b), Some(a)) = (b, snapshot(&t, i))
                    && *b != a
                {
                    return Err(format!(
                        "queue {i} changed while ready ({b:?} -> {a:?}) by a write of {value:#x} \
                         at {offset:#x} (VQ-14)"
                    ));
                }
            }
        } else {
            let _ = t.read(offset, size);
        }
        // ANCHOR_END: fuzz_mmio_sequence
        if t.is_dead() {
            continue;
        }
        let status = t.status();
        if status & st::DRIVER_OK != 0 {
            let a = acked.lock().map(|a| *a).unwrap_or(None);
            if status & st::FEATURES_OK == 0 || a.is_none_or(|f| f & features::VERSION_1 == 0) {
                return Err(format!(
                    "DRIVER_OK with status {status:#x} and accepted features {a:?} (§3.1.1, VQ-15)"
                ));
            }
        }
        let isr = t.read(reg::INTERRUPT_STATUS, AccessSize::B4);
        if irq.level() != (isr != 0) {
            return Err(format!(
                "interrupt line {} but InterruptStatus {isr:#x}",
                irq.level()
            ));
        }
    }
    Ok(())
}

fn op(b: &mut Vec<u8>, write: bool, offset: u64, value: u64) {
    let mut rec = [0u8; 11];
    rec[0] = u8::from(write) | (2 << 1);
    put_le(&mut rec, 1, 2, offset);
    put_le(&mut rec, 3, 8, value);
    b.extend_from_slice(&rec);
}

/// A full driver handshake (§3.1.1) with queue 0 set up in RAM and a notify, then noise.
fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = Vec::new();
    let base = super::RAM_A + 0x1000;
    op(&mut b, true, reg::STATUS, 1);
    op(&mut b, true, reg::STATUS, 3);
    op(&mut b, true, reg::DRIVER_FEATURES_SEL, 1);
    op(&mut b, true, reg::DRIVER_FEATURES, 1);
    op(&mut b, true, reg::DRIVER_FEATURES_SEL, 0);
    op(&mut b, true, reg::DRIVER_FEATURES, rng.below(2) << 28);
    op(&mut b, true, reg::STATUS, 11);
    op(&mut b, true, reg::QUEUE_SEL, 0);
    op(&mut b, true, reg::QUEUE_NUM, 1 << rng.below(5));
    op(&mut b, true, reg::QUEUE_DESC_LOW, base & 0xffff_ffff);
    op(
        &mut b,
        true,
        reg::QUEUE_DRIVER_LOW,
        (base + 0x1000) & 0xffff_ffff,
    );
    op(
        &mut b,
        true,
        reg::QUEUE_DEVICE_LOW,
        (base + 0x2000) & 0xffff_ffff,
    );
    op(&mut b, true, reg::QUEUE_READY, 1);
    op(&mut b, true, reg::STATUS, 15);
    for _ in 0..rng.index(16) {
        let off = rng.pick(&REGS).unwrap_or(0);
        op(&mut b, rng.coin(), off, rng.below(64));
    }
    op(&mut b, true, reg::QUEUE_NOTIFY, 0);
    op(&mut b, false, reg::INTERRUPT_STATUS, 0);
    op(&mut b, true, reg::INTERRUPT_ACK, 1);
    b
}

/// Aim one operation at a real register with a boundary value or a status bit pattern.
fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let ops = buf.len() / 11;
    if ops == 0 {
        return;
    }
    let at = rng.index(ops) * 11;
    match rng.below(3) {
        0 => put_le(buf, at + 1, 2, rng.pick(&REGS).unwrap_or(0)),
        1 => put_le(
            buf,
            at + 3,
            8,
            rng.pick(&[0u64, 1, 3, 7, 11, 15, 0x40, 0x80, 0xff, u64::MAX])
                .unwrap_or(0),
        ),
        _ => {
            if let Some(k) = buf.get_mut(at) {
                *k ^= 1 << rng.below(3);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshakes_hold() {
        let mut rng = Rng::new(11);
        for _ in 0..1_000 {
            let mut s = seed(&mut rng);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut rng, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
