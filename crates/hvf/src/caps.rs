//! Host capability probe: what this Mac's hypervisor can do, asked before creating anything.
//!
//! **Why probe instead of assuming:** the IPA width, the vCPU limit and EL2 support differ by
//! chip and macOS release. The M5 Pro reports a 40-bit maximum IPA (default 36), 64 vCPUs and EL2
//! support (`spikes/hvf-hello/RESULTS.md` findings 3 and 4, `[V]`); an M1 reports less. The VMM
//! sizes its machine from these numbers (PLAN §1: "the smallest IPA ≥ 36 that covers the
//! layout, capped at the HVF maximum"). None of these queries needs a VM.
//!
//! The host page size matters because `hv_vm_map` needs host VA, IPA and size aligned to it with
//! the default 16 KiB IPA granule (spike finding 1).
//!
//! The ID registers a guest will see (`ID_AA64MMFR0_EL1` and friends; ARM ARM, each
//! register's description) can be read
//! before any VM exists through a vCPU *configuration* object, [`feature_reg`]. Fields that need
//! a post-15.0 call (granule, SME vector length) are `None` on hosts without it.

use crate::error::{CallError, check};
use crate::ffi;
use crate::host::OsObject;
use crate::vm::IpaGranule;

/// What the hypervisor on this host supports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// `hv_vm_get_max_vcpu_count`.
    pub max_vcpus: u32,
    /// `hv_vm_config_get_max_ipa_size`, in bits.
    pub max_ipa_bits: u32,
    /// `hv_vm_config_get_default_ipa_size`, in bits.
    pub default_ipa_bits: u32,
    /// `hv_vm_config_get_el2_supported` (nested virtualization, macOS 15+).
    pub el2_supported: bool,
    /// Host page size in bytes (`sysconf(_SC_PAGESIZE)`): 16384 on Apple Silicon.
    pub page_size: usize,
    /// `hv_vm_config_get_default_ipa_granule` (macOS 26+), else `None`.
    pub default_ipa_granule: Option<IpaGranule>,
    /// `hv_sme_config_get_max_svl_bytes` (macOS 15.2+); `None` without the call or without SME.
    pub max_svl_bytes: Option<usize>,
}

impl Capabilities {
    /// Ask the framework. Each query is independent of any VM.
    pub fn probe() -> Result<Capabilities, CallError> {
        let mut max_vcpus = 0u32;
        // SAFETY: the out-pointer refers to a live, writable, properly aligned local `u32`.
        check("hv_vm_get_max_vcpu_count", unsafe {
            ffi::hv_vm_get_max_vcpu_count(&mut max_vcpus)
        })?;
        let mut max_ipa_bits = 0u32;
        // SAFETY: as above, a local `u32` out-parameter.
        check("hv_vm_config_get_max_ipa_size", unsafe {
            ffi::hv_vm_config_get_max_ipa_size(&mut max_ipa_bits)
        })?;
        let mut default_ipa_bits = 0u32;
        // SAFETY: as above, a local `u32` out-parameter.
        check("hv_vm_config_get_default_ipa_size", unsafe {
            ffi::hv_vm_config_get_default_ipa_size(&mut default_ipa_bits)
        })?;
        let mut el2_supported = false;
        // SAFETY: a local `bool` out-parameter; C `bool` and Rust `bool` share size and ABI.
        check("hv_vm_config_get_el2_supported", unsafe {
            ffi::hv_vm_config_get_el2_supported(&mut el2_supported)
        })?;
        let opt = crate::optional::get();
        let default_ipa_granule = opt.hv_vm_config_get_default_ipa_granule.and_then(|f| {
            let mut raw: ffi::hv_ipa_granule_t = 0;
            // SAFETY: `f` is the resolved framework function; `raw` is a live out-parameter.
            let rc = unsafe { f(&mut raw) };
            (rc == ffi::HV_SUCCESS)
                .then(|| IpaGranule::from_raw(raw))
                .flatten()
        });
        let max_svl_bytes = opt.hv_sme_config_get_max_svl_bytes.and_then(|f| {
            let mut v = 0usize;
            // SAFETY: `f` is the resolved framework function; `v` is a live out-parameter.
            let rc = unsafe { f(&mut v) };
            (rc == ffi::HV_SUCCESS && v != 0).then_some(v)
        });
        Ok(Capabilities {
            max_vcpus,
            max_ipa_bits,
            default_ipa_bits,
            el2_supported,
            page_size: host_page_size(),
            default_ipa_granule,
            max_svl_bytes,
        })
    }
}

/// Read one ID register the guest will see, from a fresh vCPU configuration. No VM needed.
pub fn feature_reg(reg: ffi::hv_feature_reg_t) -> Result<u64, CallError> {
    // SAFETY: no preconditions; NULL becomes an error.
    let config = OsObject::new("hv_vcpu_config_create", unsafe {
        ffi::hv_vcpu_config_create()
    })?;
    let mut v = 0u64;
    // SAFETY: `config` is a live `hv_vcpu_config_t`; `v` is a live out-parameter; the
    // framework validates `reg`.
    check("hv_vcpu_config_get_feature_reg", unsafe {
        ffi::hv_vcpu_config_get_feature_reg(config.as_ptr(), reg, &mut v)
    })?;
    Ok(v)
}

/// The host page size. `sysconf` cannot fail for `_SC_PAGESIZE` on Darwin; a nonsensical
/// answer is reported as 0 rather than trusted.
pub fn host_page_size() -> usize {
    // SAFETY: `sysconf` takes an integer and has no memory-safety preconditions.
    let raw = unsafe { ffi::sysconf(ffi::_SC_PAGESIZE) };
    usize::try_from(raw).unwrap_or(0)
}

#[cfg(all(test, feature = "hvf-tests"))]
mod hvf_tests {
    use super::*;

    /// The spike's numbers for the dev machine (M5 Pro, macOS 27.2): guest MMFR0 advertises a
    /// 40-bit PARange (field [3:0] = 2), and every post-15.0 probe answers.
    #[test]
    fn probe_and_feature_regs() {
        let caps = Capabilities::probe().expect("probe");
        assert!(caps.max_vcpus >= 1);
        assert!(caps.max_ipa_bits >= caps.default_ipa_bits);
        assert_eq!(caps.page_size, 16384);
        let mmfr0 = feature_reg(ffi::HV_FEATURE_REG_ID_AA64MMFR0_EL1).expect("MMFR0");
        assert!(mmfr0 & 0xf >= 1, "PARange {mmfr0:#x}");
        assert!(
            feature_reg(0xffff).is_err(),
            "an undefined feature register is refused"
        );
    }
}
