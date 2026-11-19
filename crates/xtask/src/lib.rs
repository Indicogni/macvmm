//! `xtask`: host-side tooling for the macvmm repository (the cargo-xtask pattern).
//!
//! **Why Rust and not Python** (architecture §19 item 9): the tools that check the repository
//! and prepare guest artifacts are part of the trusted build, so they get the same language,
//! toolchain pin and review as the VMM. Nothing here runs inside a VM.
//!
//! The library half exists so that `tests/` can drive each tool against temporary trees; the
//! binary in `main.rs` is a thin dispatcher. Later milestones add modules here (`zboot`, `cpio`,
//! `tar` in M9, `rootfs` in M15, `sparse` in M19, `checkpoint`/`learner` in M27) as additive
//! `pub mod` lines.
#![forbid(unsafe_code)]

pub mod anchors;
pub mod audit;
pub mod cpio;
pub mod disk;
pub mod rust_lex;
pub mod tar;
pub mod vectors;
pub mod vz_audit;
pub mod zboot;

/// `O_NOFOLLOW` (`<sys/fcntl.h>`): no `libc` in this crate, so the values are spelled here.
#[cfg(target_os = "macos")]
pub const O_NOFOLLOW: i32 = 0x0100;
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub const O_NOFOLLOW: i32 = 0o100_000;
#[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
pub const O_NOFOLLOW: i32 = 0o400_000;
/// macOS `O_NOFOLLOW_ANY`: refuse a symlink in *any* path component (macOS 11+).
#[cfg(target_os = "macos")]
pub const O_NOFOLLOW_ANY: i32 = 0x2000_0000;
/// `O_NONBLOCK`, so opening a FIFO never blocks.
#[cfg(target_os = "macos")]
pub const O_NONBLOCK: i32 = 0x0004;
#[cfg(target_os = "linux")]
pub const O_NONBLOCK: i32 = 0o4000;
