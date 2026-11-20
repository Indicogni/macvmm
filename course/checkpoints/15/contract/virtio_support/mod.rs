// Checkpoint 15 contract helpers, adapted from the reference crates/vmm/tests/virtio_support/mod.rs.
// Chapter 15 has no ring walk yet (chapter 16 writes it), so this mock device never reads a
// ring: its `process_queue` records which queue was rung and reports a used buffer.
//! Shared helpers for the chapter 15 transport tests: guest RAM in a vector (`VecMemory`) and a
//! `MockDevice` that plays a device model behind the transport.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use vmm::memory::VecMemory;
use vmm::memory::prelude::*;
use vmm::virtio::{Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt, features};

pub const RAM: u64 = 0x4000_0000;
pub const RAM_SIZE: u64 = 0x10_0000; // 1 MiB
pub const RAM_END: u64 = RAM + RAM_SIZE;
/// Default ring placement inside RAM (each far enough apart for a queue of 256).
pub const DESC: u64 = RAM + 0x1000;
pub const AVAIL: u64 = RAM + 0x4000;
pub const USED: u64 = RAM + 0x5000;

pub fn mem() -> Arc<VecMemory> {
    Arc::new(VecMemory::new(&[(GuestAddress(RAM), RAM_SIZE)]).unwrap())
}

/// What the mock device recorded.
#[derive(Debug, Default)]
pub struct MockLog {
    pub acked: Option<u64>,
    pub activations: usize,
    pub resets: usize,
    /// The queue index of every `process_queue` call (one per accepted doorbell).
    pub notified: Vec<usize>,
    pub config_writes: Vec<(u32, Vec<u8>)>,
}

/// A device model for transport tests: device ID 4, features `VERSION_1 | 1`, config bytes
/// 0..4 read-only and 4..8 writable. `process_queue` logs the queue and raises a used-buffer
/// interrupt, as a device that finished one request would.
pub struct MockDevice {
    pub id: u32,
    pub sizes: Vec<u16>,
    pub features: u64,
    pub config: [u8; 8],
    pub log: Arc<Mutex<MockLog>>,
    irq: Option<Arc<VirtioInterrupt>>,
    queues: Vec<Queue>,
}

impl MockDevice {
    pub fn new(sizes: &[u16]) -> MockDevice {
        MockDevice {
            id: 4,
            sizes: sizes.to_vec(),
            features: features::VERSION_1 | 1,
            config: [1, 2, 3, 4, 5, 6, 7, 8],
            log: Arc::new(Mutex::new(MockLog::default())),
            irq: None,
            queues: Vec::new(),
        }
    }
}

impl VirtioDevice for MockDevice {
    fn device_id(&self) -> u32 {
        self.id
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &self.sizes
    }
    fn device_features(&self) -> u64 {
        self.features
    }
    fn ack_features(&mut self, accepted: u64) {
        self.log.lock().unwrap().acked = Some(accepted);
    }
    fn config_len(&self) -> u32 {
        8
    }
    fn read_config(&self, offset: u32, data: &mut [u8]) {
        let o = offset as usize;
        data.copy_from_slice(&self.config[o..o + data.len()]);
    }
    fn write_config(&mut self, offset: u32, data: &[u8]) {
        self.log
            .lock()
            .unwrap()
            .config_writes
            .push((offset, data.to_vec()));
        for (i, b) in data.iter().enumerate() {
            let at = offset as usize + i;
            if at >= 4 {
                self.config[at] = *b; // bytes 0..4 are read-only
            }
        }
    }
    fn activate(
        &mut self,
        _mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        self.log.lock().unwrap().activations += 1;
        self.queues = queues;
        self.irq = Some(irq);
        Ok(())
    }
    fn process_queue(&mut self, index: usize, _budget: u16) -> Result<QueueProgress, VirtioError> {
        self.log.lock().unwrap().notified.push(index);
        if let Some(irq) = &self.irq {
            irq.signal_used();
        }
        Ok(QueueProgress::Drained)
    }
    fn reset(&mut self) {
        self.log.lock().unwrap().resets += 1;
        self.queues.clear();
        self.irq = None;
    }
}
