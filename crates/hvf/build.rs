//! Link Hypervisor.framework. The `#[link]` attribute in `ffi.rs` says the same thing; emitting
//! it here as well keeps the framework on the link line for every target in this crate (tests,
//! examples) and documents the dependency in one obvious place.

fn main() {
    println!("cargo:rustc-link-lib=framework=Hypervisor");
    println!("cargo:rerun-if-changed=build.rs");
}
