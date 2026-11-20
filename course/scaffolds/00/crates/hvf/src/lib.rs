//! `hvf`: your FFI to Apple's Hypervisor.framework, and thin safe wrappers around it.
//!
//! This is one of the two places `unsafe` is allowed (the other is `vmm`'s
//! `memory/host.rs`). Every `unsafe` block gets a `// SAFETY:` comment saying why it is sound.
//! Chapter 01 starts here: `hv_return_t`, `HvError`, and your first `extern "C"` block.
#![deny(unsafe_op_in_unsafe_fn, clippy::undocumented_unsafe_blocks)]
