//! `VirtioInterrupt`: the virtio-mmio `InterruptStatus` register and the device's one
//! level-sensitive interrupt line, kept consistent under **one mutex** (virtio 1.2 §4.2.2;
//! architecture §11.1; threat model VQ-16).
//!
//! **The protocol.** InterruptStatus bit 0 ("used buffer notification") means the device put
//! something in a used ring; bit 1 ("configuration change notification") means the config space
//! changed or the device needs a reset (§2.1.2, §4.2.2). The device sets a bit and raises the
//! line; the driver's handler reads InterruptStatus, writes the bits it handled to
//! InterruptACK, and the line drops when no bit is left. The line is level-sensitive (the DT
//! says `<0 (16+i) 4>`, ADR-0003), so it *is* the expression `status != 0`.
//!
//! **Why one mutex for both.** The bit and the level are set from different threads: the
//! worker (used buffers, M12), the vCPU that wrote InterruptACK, the transport on a NEEDS_RESET.
//! If the status update and `set_level` were separate steps, a worker could set bit 0 and raise
//! the line just as a vCPU's ACK, having cleared the *old* bits, computes "now 0" and lowers it:
//! a lost interrupt, and a driver that sleeps forever. Under one lock the line always equals
//! `status != 0` after every operation (the invariant the M22 `virtio_mmio` fuzz target checks).
//! `set_level` may be called under the lock because `hv_gic_set_spi` does not block `[V]`
//! (architecture §14.2: the interrupt mutex is last in the lock order).
//!
//! **DEVICE_NEEDS_RESET lives here too** (M11). Whoever detects a broken ring (the transport at
//! DRIVER_OK, the inline notify path, M12's worker) calls [`VirtioInterrupt::set_needs_reset`],
//! which latches the flag and raises a config interrupt in one step; the transport ORs the flag
//! into the Status register. Keeping it next to the interrupt state means the worker needs no
//! handle on the transport (which would invert the lock order).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::irq::IrqLine;
use crate::sync::lock;
use std::sync::{Arc, Mutex};

/// InterruptStatus bit 0: a used buffer was added (§4.2.2).
pub const INT_USED_RING: u32 = 1;
/// InterruptStatus bit 1: the configuration changed (or NEEDS_RESET, §2.1.2).
pub const INT_CONFIG: u32 = 2;
/// The only InterruptStatus bits that exist; ACK values are masked to these (VQ-16).
pub const INT_MASK: u32 = INT_USED_RING | INT_CONFIG;

#[derive(Debug, Default)]
struct State {
    status: u32,
    needs_reset: bool,
}

/// InterruptStatus + the line (module docs).
pub struct VirtioInterrupt {
    state: Mutex<State>,
    line: Arc<dyn IrqLine>,
}

impl core::fmt::Debug for VirtioInterrupt {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("VirtioInterrupt")
            .field("state", &*lock(&self.state))
            .finish_non_exhaustive()
    }
}

impl VirtioInterrupt {
    /// A device interrupt driving `line` (a `GicSpi` on INTID 48 + slot, or a `TestIrq`).
    pub fn new(line: Arc<dyn IrqLine>) -> VirtioInterrupt {
        VirtioInterrupt {
            state: Mutex::new(State::default()),
            line,
        }
    }

    // ANCHOR: virtio_interrupt_level
    fn raise(&self, bit: u32) {
        let mut s = lock(&self.state);
        s.status |= bit;
        // Under the lock: the line equals `status != 0` after every operation (module docs).
        self.line.set_level(true);
    }

    /// The device added used buffers: set bit 0 and raise the line.
    pub fn signal_used(&self) {
        self.raise(INT_USED_RING);
    }

    /// The configuration changed: set bit 1 and raise the line.
    pub fn signal_config(&self) {
        self.raise(INT_CONFIG);
    }

    /// InterruptACK: clear `bits` (masked to bits 0–1) and lower the line once no bit
    /// is left.
    pub fn ack(&self, bits: u32) {
        let mut s = lock(&self.state);
        s.status &= !(bits & INT_MASK);
        if s.status == 0 {
            self.line.set_level(false);
        }
    }
    // ANCHOR_END: virtio_interrupt_level

    /// InterruptStatus.
    pub fn status(&self) -> u32 {
        lock(&self.state).status
    }

    // ANCHOR: virtio_needs_reset
    /// Latch DEVICE_NEEDS_RESET and raise a configuration interrupt (§2.1.2).
    pub fn set_needs_reset(&self) {
        let mut s = lock(&self.state);
        s.needs_reset = true;
        s.status |= INT_CONFIG;
        self.line.set_level(true);
    }
    // ANCHOR_END: virtio_needs_reset

    /// True after [`set_needs_reset`](Self::set_needs_reset), until [`reset`](Self::reset).
    pub fn needs_reset(&self) -> bool {
        lock(&self.state).needs_reset
    }

    /// Status ← 0: clear everything and lower the line.
    pub fn reset(&self) {
        let mut s = lock(&self.state);
        *s = State::default();
        self.line.set_level(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::irq::TestIrq;

    #[test]
    fn level_follows_status() {
        let irq = Arc::new(TestIrq::new());
        let vi = VirtioInterrupt::new(irq.clone());
        vi.signal_used();
        vi.signal_config();
        assert_eq!((vi.status(), irq.level()), (3, true));
        vi.ack(1);
        assert_eq!((vi.status(), irq.level()), (2, true));
        vi.ack(0xffff_fffc); // unknown bits only: masked away (VQ-16)
        assert_eq!((vi.status(), irq.level()), (2, true));
        vi.ack(u32::MAX);
        assert_eq!((vi.status(), irq.level()), (0, false));
        vi.set_needs_reset();
        assert!(vi.needs_reset() && irq.level() && vi.status() == INT_CONFIG);
        vi.reset();
        assert!(!vi.needs_reset() && !irq.level() && vi.status() == 0);
        assert_eq!(irq.transitions(), vec![true, false, true, false]);
    }
}
