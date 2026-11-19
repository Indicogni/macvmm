//! Build script for the test guests: hand our linker script to `rust-lld`.
//!
//! **Why a build script:** `aarch64-unknown-none` links with the bundled `rust-lld` (GNU
//! flavour) and, without a script, would place code at address 0, which is flash in the
//! machine map (PLAN §1). Every guest must instead be linked at its load address, `0x4008_0000`
//! (CURRICULUM ch03), so the ELF loader and `--raw F@0x40080000` put each byte where the code
//! expects it. `-T` replaces the default script for every binary of this package.
#![forbid(unsafe_code)]

fn main() {
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned());
    println!("cargo:rustc-link-arg=-T{dir}/common/link.ld");
    println!("cargo:rerun-if-changed=common/link.ld");
    println!("cargo:rerun-if-changed=build.rs");
}
