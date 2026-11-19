//! The flattened device tree: how the guest learns what the board looks like (architecture
//! §6.7, §12.2; Devicetree Specification v0.4; course ch10).
//!
//! - [`writer`]: a generic FDT serializer (DT spec ch. 5), with the format's rules enforced.
//! - [`machine`]: the `virt` board's tree, built from `arch/layout.rs`, plus the `--dtb-out`
//!   seed redaction (FDT-4).
//! - `reader`: a bounds-checked parser, compiled **only** for tests and the `test-util`
//!   feature (fuzzing, the e2e harness). The VMM generates device trees and never parses one
//!   (threat model FDT-1); `cargo xtask audit` (rule `fdt-reader-unreachable`) checks that no
//!   non-test code names it and that this declaration stays gated.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

pub mod machine;
#[cfg(any(test, feature = "test-util"))]
pub mod reader;
pub mod writer;

pub use machine::{MachineDesc, build_dtb, build_dtb_with, redact_seeds};
pub use writer::{FdtError, FdtWriter, NodeId};
