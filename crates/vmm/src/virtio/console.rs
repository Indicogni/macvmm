//! virtio-console: a byte stream to and from the host, as a virtio device (virtio 1.2 §5.3
//! "Console Device"; architecture §11.3, §14.4; threat model TTY-1, TTY-10, VQ-8, VQ-9,
//! VQ-11, SINK-1, LOG-4; course ch17, the faded exercise after virtio-rng).
//!
//! **What it is for.** The PL011 moves one byte per trapped register write: every character
//! Linux prints costs a VM exit. A virtio-console moves a whole *buffer* per doorbell: the
//! driver puts up to a page of text in guest RAM, rings once, and the device copies it out.
//! Linux shows it as `/dev/hvc0` (`drivers/char/virtio_console.c` on top of the `hvc` tty
//! layer). It is also the second device of ch17 because it has the one thing virtio-rng lacks:
//! data flowing *in both directions*, through two queues with opposite buffer directions.
//!
//! **The device as offered** (§5.3.2–§5.3.5):
//! - device ID 3, **two queues**: `receiveq` 0 (host → guest; the driver posts
//!   *device-writable* buffers and we fill them) and `transmitq` 0 (guest → host; the driver
//!   posts *device-readable* buffers and we read them) (§5.3.2);
//! - **no feature bits** of its own (§5.3.3): no `VIRTIO_CONSOLE_F_SIZE` (the host's terminal
//!   size is not the guest's business), no `F_MULTIPORT` (so exactly one port: ports 2 onwards
//!   and the control queues exist only with it, §5.3.2, §5.3.6.2), no `F_EMERG_WRITE`;
//! - configuration space (§5.3.4) `{cols: le16, rows: le16, max_nr_ports: le32, emerg_wr:
//!   le32}`: 12 bytes, all zero and read-only. Each field is valid only with a feature we do
//!   not offer, so a driver never relies on them; writes (an `emerg_wr` without the feature)
//!   are ignored (VQ-13).
//!
//! **TX: guest output is hostile to the host terminal (TTY-1, anchor `console_tx`).** Each
//! transmitq chain's readable bytes are copied into a fresh zeroed bounce buffer (VQ-11), then
//! handed to the console's [`Sink`](crate::backend::serial::Sink), whose `write_guest` runs
//! them through *this sink's own* `AnsiFilter` before anything reaches stdout or a file, on
//! every sink type, `isatty` or not. The sink is the SINK-1 queue: this worker never calls
//! `write(2)` itself and waits at most 10 ms for queue space **per batch** (the one bounded
//! wait allowed under a device mutex, architecture §14.2): every chain of a batch writes with
//! the same [`FullWait`], so once a stalled stdout reader has cost 10 ms the rest of the batch
//! is dropped and counted without waiting, and a batch of 64 chains cannot hold the device
//! mutex for 64 × 10 ms. File sinks keep their LOG-4 byte cap. The chain goes back with `len = 0`: the
//! device wrote nothing into it (VQ-9); writable descriptors on the transmitq are never
//! written.
//!
//! **RX: input is bounded while the guest posts nothing (TTY-10, anchor `console_rx`).** Host
//! bytes wait in a [`SerialInput`] (4 KiB, never blocking: when it is full the stdin thread
//! drops and counts, and still parses Ctrl-A x). A receiveq pass first looks at the input:
//! with nothing to deliver it **pops no chain**, so the driver's buffers stay posted and no
//! empty buffer is ever returned. Otherwise each chain gets `min(writable_len, queued)` bytes
//! and goes back with exactly that `len` (VQ-9). The driver must post only device-writable
//! buffers on a receiveq (§5.3.6.1): readable descriptors in an RX chain are ignored, and a
//! chain with **no** writable byte is a driver error (DEVICE_NEEDS_RESET), so the "never an
//! empty buffer" rule has no exception. Bytes leave the input only after they were written
//! into guest memory ([`SerialInput::peek_into`], then [`SerialInput::discard`]): a failed
//! write (NEEDS_RESET) loses no typed byte, and `reset` keeps them for the next driver. Two events start a pass: the driver's
//! QueueNotify on queue 0 (it posted buffers) and the input queue's hook (bytes arrived),
//! which rings the worker's doorbell for queue 0 (`machine::virt`).
//!
//! **Hostile-input rules** (on top of `queue.rs` and `chain.rs`): every chain passes
//! `into_validated(CONSOLE_MAX_TOTAL)` (VQ-4..VQ-8), so a chain whose readable or writable total
//! exceeds 64 KiB is `QueueError::TooLarge`, which is DEVICE_NEEDS_RESET (VQ-10); at most
//! `budget` chains per call (VQ-12).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{
    DEVICE_ID_CONSOLE, MAX_BOUNCE, Queue, QueueError, QueueProgress, ValidatedChain, VirtioDevice,
    VirtioError, VirtioInterrupt, features,
};
use crate::backend::serial::{FullWait, SerialInput, SinkHandle};
use crate::memory::{GuestAddress, GuestMemoryOrdered};
use std::sync::Arc;

/// The maximum size of each of the two queues (architecture §11.3).
pub const CONSOLE_QUEUE_SIZE: u16 = 64;
/// `receiveq` of port 0 (§5.3.2): host → guest, device-writable buffers.
pub const RX_QUEUE: usize = 0;
/// `transmitq` of port 0 (§5.3.2): guest → host, device-readable buffers.
pub const TX_QUEUE: usize = 1;
/// The most bytes one chain may carry, in either direction (VQ-8): one bounce buffer (VQ-11).
pub const CONSOLE_MAX_TOTAL: u64 = MAX_BOUNCE as u64;
/// `struct virtio_console_config` (§5.3.4): cols, rows, max_nr_ports, emerg_wr.
pub const CONSOLE_CONFIG_LEN: u32 = 12;

/// What the device holds between DRIVER_OK and reset.
struct Active {
    mem: Arc<dyn GuestMemoryOrdered>,
    rx: Queue,
    tx: Queue,
    irq: Arc<VirtioInterrupt>,
}

/// The virtio-console device model (module docs).
pub struct Console {
    sink: SinkHandle,
    input: Option<Arc<SerialInput>>,
    active: Option<Active>,
    tx_bytes: u64,
    rx_bytes: u64,
}

impl core::fmt::Debug for Console {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Console")
            .field("active", &self.active.is_some())
            .field("input", &self.input.is_some())
            .field("tx_bytes", &self.tx_bytes)
            .field("rx_bytes", &self.rx_bytes)
            .finish_non_exhaustive()
    }
}

impl Console {
    /// A console whose output goes to `sink` (`HostIo.console`) and whose input comes from
    /// `input` (`HostIo.console_input`), or from nothing when stdin is not bound to it.
    pub fn new(sink: SinkHandle, input: Option<Arc<SerialInput>>) -> Console {
        Console {
            sink,
            input,
            active: None,
            tx_bytes: 0,
            rx_bytes: 0,
        }
    }

    /// Bytes transmitted (guest → sink, before filtering) and received (host → guest).
    pub fn transferred(&self) -> (u64, u64) {
        (self.tx_bytes, self.rx_bytes)
    }
}

/// Copy a validated chain's readable bytes out of guest memory, in order, into one fresh,
/// zeroed buffer (VQ-11). `readable_len ≤ CONSOLE_MAX_TOTAL` was checked by `into_validated`,
/// and every descriptor was range-checked during the walk; a read that still fails (memory
/// changed shape) is an `Err`, never a panic.
fn read_readable(
    mem: &dyn GuestMemoryOrdered,
    chain: &ValidatedChain,
) -> Result<Vec<u8>, VirtioError> {
    let total = usize::try_from(chain.readable_len)
        .map_err(|_| VirtioError::Device("console chain larger than the address space"))?;
    let mut buf = vec![0u8; total];
    let mut done: usize = 0;
    for d in &chain.readable {
        let len = usize::try_from(d.len).unwrap_or(usize::MAX);
        let end = done
            .checked_add(len)
            .ok_or(VirtioError::Device("console chain length overflow"))?;
        let dst = buf
            .get_mut(done..end)
            .ok_or(VirtioError::Device("console chain longer than its total"))?;
        mem.read(GuestAddress(d.addr), dst)
            .map_err(|e| VirtioError::Queue(QueueError::Memory(e)))?;
        done = end;
    }
    Ok(buf)
}

impl VirtioDevice for Console {
    fn device_id(&self) -> u32 {
        DEVICE_ID_CONSOLE
    }
    /// receiveq 0 and transmitq 0, nothing else: no `F_MULTIPORT` (§5.3.2).
    fn queue_max_sizes(&self) -> &[u16] {
        &[CONSOLE_QUEUE_SIZE, CONSOLE_QUEUE_SIZE]
    }
    /// No `F_SIZE`, `F_MULTIPORT` or `F_EMERG_WRITE` (§5.3.3): only `VERSION_1`.
    fn device_features(&self) -> u64 {
        features::VERSION_1
    }
    fn ack_features(&mut self, _accepted: u64) {}
    fn config_len(&self) -> u32 {
        CONSOLE_CONFIG_LEN
    }
    /// All zero (module docs): no field is valid without a feature we do not offer.
    fn read_config(&self, _offset: u32, data: &mut [u8]) {
        data.fill(0);
    }
    /// Read-only (VQ-13): `emerg_wr` needs `F_EMERG_WRITE`, which is not offered.
    fn write_config(&mut self, _offset: u32, _data: &[u8]) {}

    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        let mut it = queues.into_iter();
        let rx = it.next().ok_or(VirtioError::NoSuchQueue(RX_QUEUE))?;
        let tx = it.next().ok_or(VirtioError::NoSuchQueue(TX_QUEUE))?;
        self.active = Some(Active { mem, rx, tx, irq });
        Ok(())
    }

    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        match index {
            RX_QUEUE => self.process_rx(budget),
            TX_QUEUE => self.process_tx(budget),
            other => Err(VirtioError::NoSuchQueue(other)),
        }
    }

    fn reset(&mut self) {
        // VQ-14: both queues and the memory handle go. Queued host input stays queued (it
        // belongs to the user, not to this driver instance) and is bounded (TTY-10).
        self.active = None;
    }
}

impl Console {
    // ANCHOR: console_tx
    /// transmitq: copy each chain's readable bytes into a fresh buffer and hand them to the
    /// sink, which filters them (TTY-1) and queues them for its writer thread (SINK-1).
    fn process_tx(&mut self, budget: u16) -> Result<QueueProgress, VirtioError> {
        let Some(a) = self.active.as_mut() else {
            return Err(VirtioError::NotActivated);
        };
        let budget = budget.min(a.tx.size()); // VQ-12: one ring's worth at most
        let mem = &*a.mem;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        // SINK-1: one 10 ms full-queue budget for the whole batch (one device-mutex hold).
        let mut wait = FullWait::new();
        for n in 0..=budget {
            if n == budget {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = a.tx.pop(mem)? else {
                break;
            };
            // VQ-4..VQ-8: every descriptor checked; each direction's total capped at 64 KiB.
            let req = chain.into_validated(CONSOLE_MAX_TOTAL)?;
            let bytes = read_readable(mem, &req)?; // VQ-11: fresh, zeroed, never reused
            // TTY-1: the sink's own AnsiFilter runs before any host byte is written; LOG-4
            // caps a file sink; SINK-1: never write(2), and at most 10 ms of waiting for
            // queue space in the whole batch (`wait` is shared by every chain).
            self.sink.write_guest_within(&bytes, &mut wait);
            // VQ-9: nothing was written into the chain (writable descriptors are ignored).
            a.tx.add_used(mem, req.head, 0)?;
            self.tx_bytes = self.tx_bytes.saturating_add(req.readable_len);
            used = true;
        }
        if used && a.tx.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(progress)
    }
    // ANCHOR_END: console_tx

    // ANCHOR: console_rx
    /// receiveq: fill posted buffers from the input queue. With no input, no chain is popped:
    /// the driver's buffers stay posted, and the input waits (bounded) for the next pass.
    fn process_rx(&mut self, budget: u16) -> Result<QueueProgress, VirtioError> {
        let Some(a) = self.active.as_mut() else {
            return Err(VirtioError::NotActivated);
        };
        let Some(input) = self.input.as_ref() else {
            return Ok(QueueProgress::Drained); // stdin is not bound to this console
        };
        let budget = budget.min(a.rx.size()); // VQ-12
        let mem = &*a.mem;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        for n in 0..=budget {
            // Only this thread takes bytes out of `input`, so "not empty" stays true until we
            // take them: a chain is popped only when it will carry at least one byte.
            if input.is_empty() {
                break;
            }
            if n == budget {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = a.rx.pop(mem)? else {
                break; // no buffer posted: the bytes stay queued (TTY-10)
            };
            let req = chain.into_validated(CONSOLE_MAX_TOTAL)?;
            // §5.3.6.1: the driver must not put device-readable buffers in a receiveq. Readable
            // descriptors are ignored (never read or written); a chain with nothing writable
            // could only go back empty, so it is a driver error (NEEDS_RESET), and the input
            // stays queued.
            if req.writable_len == 0 {
                return Err(VirtioError::Device(
                    "console receiveq chain has no device-writable buffer (§5.3.6.1)",
                ));
            }
            let room = usize::try_from(req.writable_len)
                .map_err(|_| VirtioError::Device("console chain larger than the address space"))?;
            let mut buf = vec![0u8; room]; // VQ-11
            // Copy first, take after the write succeeded: a failed write loses no input.
            let got = input.peek_into(&mut buf);
            let data = buf.get(..got).unwrap_or_default();
            let written = req.write_writable(mem, data)?;
            input.discard(usize::try_from(written).unwrap_or(got));
            a.rx.add_used(mem, req.head, written)?; // VQ-9: the bytes actually written
            self.rx_bytes = self.rx_bytes.saturating_add(u64::from(written));
            used = true;
        }
        if used && a.rx.should_interrupt(mem)? {
            a.irq.signal_used();
        }
        Ok(progress)
    }
    // ANCHOR_END: console_rx
}
