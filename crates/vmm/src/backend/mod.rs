//! Host-side backends: what the VMM reads from and writes to on the host (architecture §3,
//! §21.1 boundaries B2 and B3).
//!
//! - [`hostio`]: every host input opened and read once (HOSTIO-1, PATH-1..8).
//! - [`ansi`]: the terminal allow-list filter on every guest byte stream (TTY-1..4).
//! - [`serial`]: the guest output sinks, each a bounded queue drained by its own writer thread
//!   (RUST-5, SINK-1, LOG-4), and the console input queue `SerialInput` (TTY-10).
//! - [`entropy`]: the host CSPRNG (`getentropy(2)`) for the DTB seeds (M7, FDT-3) and
//!   virtio-rng (M12).
//! - [`file`]: the block backend, a raw disk image behind `pread`/`pwrite` (M14, BLK-5..11).
//!
//! Every module here is guest-facing or host-input-facing, so each carries the RUST-1 deny
//! attribute.

pub mod ansi;
pub mod entropy;
pub mod file;
pub mod hostio;
pub mod serial;
