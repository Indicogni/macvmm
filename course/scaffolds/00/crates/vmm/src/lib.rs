//! `vmm`: your VMM library. Guest memory (ch04), the exit loop (ch07), devices (ch09), the
//! device tree (ch10), interrupts (ch11, ch12) and the loaders (ch13) live here.
//!
//! `unsafe` is denied crate-wide; ch04 allows it in exactly one module, `memory/host.rs`, the
//! only code that touches guest memory through a raw pointer.
#![deny(unsafe_code)]
