//! `RazWi`: a window that reads as zero and ignores writes (architecture §10; threat model
//! MMIO-8).
//!
//! **Why.** Some address ranges belong to the board but hold nothing a guest should use, and
//! "unhandled MMIO, stop the VM" would be wrong for them. The `virt` board's GIC redistributor
//! window is the case in point: QEMU reserves room for up to 123 redistributor frames
//! (`0x080A_0000..0x0900_0000`), HVF's in-kernel GIC implements one 128 KiB frame per vCPU
//! (`hv_gic_get_redistributor_size`), and the rest of the window is architecturally
//! "reserved, RAZ/WI" (GICv3 architecture specification, ARM IHI 0069H, §12.10: reserved
//! register space is RES0; a guest walking the frames stops at `GICR_TYPER.Last`). So the
//! remainder is put on the bus as a `RazWi`, which answers every access with 0 and logs it at
//! debug level only: it is not a guest bug worth a warning. The guest decides how often it
//! happens, so the log line is rate-limited per call site like every guest-triggerable message
//! (`guest_debug!`, threat model LOG-1): with `--log debug`, a guest hammering the window gets
//! the first 10 lines and then one in 1000, and costs only its own exits.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::bus::{AccessSize, MmioDevice};

/// A read-as-zero, write-ignored window named `name` (for the debug log).
#[derive(Clone, Copy, Debug)]
pub struct RazWi {
    name: &'static str,
}

impl RazWi {
    pub fn new(name: &'static str) -> RazWi {
        RazWi { name }
    }
}

impl MmioDevice for RazWi {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        crate::guest_debug!(
            "{}: {}-byte read at offset {offset:#x} (RAZ)",
            self.name,
            size.bytes()
        );
        0
    }

    fn write(&mut self, offset: u64, size: AccessSize, _value: u64) {
        crate::guest_debug!(
            "{}: {}-byte write at offset {offset:#x} (WI)",
            self.name,
            size.bytes()
        );
    }
}
