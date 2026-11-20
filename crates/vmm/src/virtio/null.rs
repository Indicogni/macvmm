//! `NullDevice`: what sits in an empty virtio-mmio slot (architecture §11.1, "Empty slots").
//!
//! **Why empty slots are on the bus at all.** QEMU's `virt` board always has 32 virtio-mmio
//! transports at `0x0a00_0000 + i·0x200`, and firmware such as U-Boot and EDK2 may probe every
//! slot whether or not the DT lists it. virtio 1.2 §4.2.3.1.1 says what an empty transport looks
//! like: a valid MagicValue and Version, **DeviceID 0**, and "the driver MUST ignore a device
//! with DeviceID 0x0". So the window answers instead of being "unhandled MMIO", and everything
//! else reads as zero and ignores writes (the transport special-cases DeviceID 0). Empty slots
//! are not in the DT (`fdt/machine.rs`): a node would only make Linux probe a device that is
//! not there.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{DEVICE_ID_NONE, Queue, QueueProgress, VirtioDevice, VirtioError, VirtioInterrupt};
use crate::memory::GuestMemoryOrdered;
use std::sync::Arc;

// ANCHOR: virtio_null_device
/// The empty-slot device: ID 0, no queues, no features, no config.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullDevice;

impl VirtioDevice for NullDevice {
    fn device_id(&self) -> u32 {
        DEVICE_ID_NONE
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &[]
    }
    fn device_features(&self) -> u64 {
        0
    }
    fn ack_features(&mut self, _accepted: u64) {}
    fn read_config(&self, _offset: u32, data: &mut [u8]) {
        data.fill(0);
    }
    fn write_config(&mut self, _offset: u32, _data: &[u8]) {}
    fn activate(
        &mut self,
        _mem: Arc<dyn GuestMemoryOrdered>,
        _queues: Vec<Queue>,
        _irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        Err(VirtioError::Device("an empty slot cannot be activated"))
    }
    fn process_queue(&mut self, index: usize, _budget: u16) -> Result<QueueProgress, VirtioError> {
        Err(VirtioError::NoSuchQueue(index))
    }
    fn reset(&mut self) {}
}
// ANCHOR_END: virtio_null_device
