//! Post-baseline functions, found at run time with `dlsym`.
//!
//! **Why not link them:** the baseline is macOS 15.0 (ADR-0002 item 2, decision D7). A function
//! the SDK marks `API_AVAILABLE(macos(15.2))` or later, linked statically, would make dyld refuse
//! to *start* macvmm on an older host. Weak linking (`#[linkage = "extern_weak"]`) is unstable,
//! so each newer symbol is looked up once with `dlsym(RTLD_DEFAULT, "name")`. A missing symbol
//! yields `None`: the feature degrades, the process never fails to load.
//!
//! | Symbol family | macOS | Used for |
//! |---|---|---|
//! | `hv_sme_config_get_max_svl_bytes`, `hv_vcpu_{get,set}_sme_*` | 15.2 | SME state (snapshots, M25) |
//! | `hv_vm_config_{get_default_,get_,set_}ipa_granule` | 26.0 | the 4 KiB IPA granule option |
//! | `hv_vcpu_get_wait_for_interrupt_time` | 27.0 | `--stats` WFI time |
//! | `hv_vcpu_{get,set}_serror` | 27.0 | SError injection |
//! | `hv_vcpu_invalidate_tlb` | 27.0 | guest TLBI on behalf of a guest hypervisor |
//!
//! (ADR-0002 lists the 26.0/27.0 ones; the 15.2 SME functions are here for the same reason.)
//!
//! **Trust:** the names are `&'static CStr` constants, never built from input; the NUL is part
//! of the type, and a name that is not a valid C string fails to *compile* (the `const`
//! `CStr::from_bytes_with_nul` in the macro below), so `dlsym` can never read past it. Each pointer
//! is cast to the signature transcribed from the header next to it; `scripts/check-ffi.sh`
//! confirms every name exists in the SDK with exactly the availability listed in [`SYMBOLS`].

use crate::ffi::*;
use core::ffi::{CStr, c_void};
use core::ptr::NonNull;
use std::sync::OnceLock;

/// Look one symbol up in every image loaded so far.
fn lookup(name: &'static CStr) -> Option<NonNull<c_void>> {
    let handle = core::ptr::without_provenance_mut::<c_void>(RTLD_DEFAULT as usize);
    // SAFETY: `name` is a `CStr`, so it is NUL-terminated by construction and `dlsym` cannot
    // read past its end; `'static` keeps it alive for the call. `RTLD_DEFAULT` is the
    // documented pseudo-handle. `dlsym` only reads the string and returns NULL when the symbol
    // is absent.
    NonNull::new(unsafe { dlsym(handle, name.as_ptr()) })
}

macro_rules! optional_fns {
    ($( $(#[$meta:meta])* $name:ident ( $($arg:ty),* ) since $since:literal; )*) => {
        /// The resolved post-15.0 functions. `None` means this macOS does not have it.
        #[derive(Clone, Copy, Debug)]
        pub struct Optional {
            $( $(#[$meta])* pub $name: Option<unsafe extern "C" fn($($arg),*) -> hv_return_t>, )*
        }

        /// `(symbol, first macOS release that has it)` for every optional function. Read by
        /// the ABI oracle (`examples/abi_dump.rs`).
        pub const SYMBOLS: &[(&str, &str)] = &[ $( (stringify!($name), $since), )* ];

        impl Optional {
            /// The names of the functions this host does not have, in [`SYMBOLS`] order.
            pub fn missing(&self) -> Vec<&'static str> {
                let mut v = Vec::new();
                $( if self.$name.is_none() { v.push(stringify!($name)); } )*
                v
            }
        }

        fn resolve() -> Optional {
            Optional {
                // The name is checked at compile time: an inline `const` that panics (a
                // build error) unless the bytes form exactly one NUL-terminated C string.
                $( $name: lookup(const {
                    match CStr::from_bytes_with_nul(concat!(stringify!($name), "\0").as_bytes()) {
                        Ok(c) => c,
                        Err(_) => panic!(concat!("not a C string: ", stringify!($name))),
                    }
                }).map(|p| {
                    // SAFETY: `p` is the address of the framework function of this exact name,
                    // and the signature on the left is transcribed from its header declaration
                    // (the same text as the comment beside it). Function pointers and data
                    // pointers have the same size and representation on arm64 Darwin.
                    unsafe {
                        core::mem::transmute::<
                            NonNull<c_void>,
                            unsafe extern "C" fn($($arg),*) -> hv_return_t,
                        >(p)
                    }
                }), )*
            }
        }
    };
}

optional_fns! {
    // hv_sme_config.h, hv_vcpu.h (macOS 15.2)
    /// `hv_return_t hv_sme_config_get_max_svl_bytes(size_t *value)`.
    hv_sme_config_get_max_svl_bytes(*mut usize) since "15.2";
    /// `hv_vcpu_get_sme_state(hv_vcpu_t, hv_vcpu_sme_state_t *)`.
    hv_vcpu_get_sme_state(hv_vcpu_t, *mut hv_vcpu_sme_state_t) since "15.2";
    /// `hv_vcpu_set_sme_state(hv_vcpu_t, const hv_vcpu_sme_state_t *)`.
    hv_vcpu_set_sme_state(hv_vcpu_t, *const hv_vcpu_sme_state_t) since "15.2";
    /// `hv_vcpu_get_sme_z_reg(hv_vcpu_t, hv_sme_z_reg_t, uint8_t *value, size_t length)`.
    hv_vcpu_get_sme_z_reg(hv_vcpu_t, hv_sme_z_reg_t, *mut u8, usize) since "15.2";
    /// `hv_vcpu_set_sme_z_reg(hv_vcpu_t, hv_sme_z_reg_t, const uint8_t *value, size_t length)`.
    hv_vcpu_set_sme_z_reg(hv_vcpu_t, hv_sme_z_reg_t, *const u8, usize) since "15.2";
    /// `hv_vcpu_get_sme_p_reg(hv_vcpu_t, hv_sme_p_reg_t, uint8_t *value, size_t length)`.
    hv_vcpu_get_sme_p_reg(hv_vcpu_t, hv_sme_p_reg_t, *mut u8, usize) since "15.2";
    /// `hv_vcpu_set_sme_p_reg(hv_vcpu_t, hv_sme_p_reg_t, const uint8_t *value, size_t length)`.
    hv_vcpu_set_sme_p_reg(hv_vcpu_t, hv_sme_p_reg_t, *const u8, usize) since "15.2";
    /// `hv_vcpu_get_sme_za_reg(hv_vcpu_t, uint8_t *value, size_t length)`.
    hv_vcpu_get_sme_za_reg(hv_vcpu_t, *mut u8, usize) since "15.2";
    /// `hv_vcpu_set_sme_za_reg(hv_vcpu_t, const uint8_t *value, size_t length)`.
    hv_vcpu_set_sme_za_reg(hv_vcpu_t, *const u8, usize) since "15.2";
    /// `hv_vcpu_get_sme_zt0_reg(hv_vcpu_t, hv_sme_zt0_uchar64_t *value)`.
    hv_vcpu_get_sme_zt0_reg(hv_vcpu_t, *mut hv_sme_zt0_uchar64_t) since "15.2";
    /// `hv_vcpu_set_sme_zt0_reg(hv_vcpu_t, const hv_sme_zt0_uchar64_t *value)`.
    hv_vcpu_set_sme_zt0_reg(hv_vcpu_t, *const hv_sme_zt0_uchar64_t) since "15.2";

    // hv_vm_config.h (macOS 26.0)
    /// `hv_vm_config_get_default_ipa_granule(hv_ipa_granule_t *granule)`.
    hv_vm_config_get_default_ipa_granule(*mut hv_ipa_granule_t) since "26.0";
    /// `hv_vm_config_get_ipa_granule(hv_vm_config_t, hv_ipa_granule_t *granule)`.
    hv_vm_config_get_ipa_granule(hv_vm_config_t, *mut hv_ipa_granule_t) since "26.0";
    /// `hv_vm_config_set_ipa_granule(hv_vm_config_t, hv_ipa_granule_t granule)`.
    hv_vm_config_set_ipa_granule(hv_vm_config_t, hv_ipa_granule_t) since "26.0";

    // hv_vcpu.h (macOS 27.0)
    /// `hv_vcpu_get_wait_for_interrupt_time(hv_vcpu_t, uint64_t *time)`.
    hv_vcpu_get_wait_for_interrupt_time(hv_vcpu_t, *mut u64) since "27.0";
    /// `hv_vcpu_get_serror(hv_vcpu_t, bool *pending)`.
    hv_vcpu_get_serror(hv_vcpu_t, *mut bool) since "27.0";
    /// `hv_vcpu_set_serror(hv_vcpu_t, bool pending)`.
    hv_vcpu_set_serror(hv_vcpu_t, bool) since "27.0";
    /// `hv_vcpu_invalidate_tlb(hv_vcpu_t, hv_tlbi_op_t op, uint64_t param)`.
    hv_vcpu_invalidate_tlb(hv_vcpu_t, hv_tlbi_op_t, u64) since "27.0";
}

static RESOLVED: OnceLock<Optional> = OnceLock::new();

// ANCHOR: optional_get
/// The optional functions, resolved on first use and cached for the life of the process.
pub fn get() -> &'static Optional {
    RESOLVED.get_or_init(resolve)
}
// ANCHOR_END: optional_get

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_table_is_well_formed() {
        assert_eq!(SYMBOLS.len(), 18);
        for (name, since) in SYMBOLS {
            assert!(name.starts_with("hv_"), "{name}");
            assert!(
                name.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            );
            assert!(
                matches!(*since, "15.2" | "26.0" | "27.0"),
                "{name}: {since}"
            );
        }
    }

    /// Every symbol whose `since` release is not newer than the running macOS must resolve: on
    /// the 27.2 dev machine that is all 18, so a typo in a name, or a symbol Apple dropped,
    /// fails here instead of silently degrading a feature to `None`. On an older host only the
    /// symbols that release has are required.
    #[test]
    fn resolves_on_this_host() {
        fn parse(v: &str) -> (u32, u32) {
            let (major, minor) = v.split_once('.').expect("since is major.minor");
            (major.parse().unwrap(), minor.parse().unwrap())
        }
        let o = get();
        let missing = o.missing();
        assert!(missing.len() <= SYMBOLS.len());
        if let Some(host) = crate::host::macos_version() {
            let required: Vec<&str> = SYMBOLS
                .iter()
                .filter(|(_, since)| parse(since) <= host)
                .map(|(name, _)| *name)
                .filter(|name| missing.contains(name))
                .collect();
            assert!(
                required.is_empty(),
                "macOS {host:?} should have {required:?} ({o:?})"
            );
            if host.0 >= 27 {
                assert!(missing.is_empty(), "{missing:?}");
            }
        }
        // A name that does not exist must come back as `None`, not crash.
        assert!(lookup(c"hv_this_function_does_not_exist").is_none());
    }
}
