//! Platform devices: what sits behind the MMIO bus's windows (architecture §10).
//!
//! Each device implements [`crate::bus::MmioDevice`] and lives at the address
//! `arch/layout.rs` gives it; `machine/virt.rs` registers it, one block per device. They
//! arrive milestone by milestone, each as an additive `mod` line here (PLAN §2.1):
//!
//! - [`testdev`] (M4, `--testdev`): 512 scratch registers, for testing MMIO decode itself;
//! - [`pl011`], [`pl031`] (M6): the serial console and the real-time clock;
//! - [`razwi`] (M6): read-as-zero windows (the unused GIC redistributor frames);
//! - [`flash`] (M18, `--bios`): flash bank 0's write-ignore trap handler.
//!
//! **Rules for every device** (threat model MMIO-8; architecture §10):
//! - **total over its window**: every `(offset, size)` the bus can pass (`offset + size ≤`
//!   the window) gets an answer, including unaligned offsets and widths the device does not
//!   support: read-as-zero / write-ignored plus a rate-limited `guest_warn!`;
//! - register arrays are reached with `.get()`, never indexed with a guest offset (RUST-3);
//! - nothing a guest does here can panic, allocate without a cap, or block on host I/O.
//!
//! Every file in this directory is guest-facing, so each carries the RUST-1 deny attribute.

// M18: flash bank 0 (writes ignored, MMIO-10).
pub mod flash;
pub mod pl011;
pub mod pl031;
pub mod razwi;
pub mod testdev;
