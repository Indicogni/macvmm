//! `macvmm doctor`: can this Mac, and this binary, run a VM?
//!
//! **Why a doctor** (course ch00/ch01): the commonest first failure is not a VMM bug but a
//! binary that was built and run without being signed, which makes `hv_vm_create` return
//! `HV_DENIED` (spike, `docs/research/hvf-api.md` §1). The doctor checks the signing contract
//! first and then asks the framework, in this order (PLAN M0 design notes):
//!
//! 1. the code signature: the entitlement set is exactly `{com.apple.security.hypervisor}`
//!    (SIGN-1, TEST-9) and the hardened runtime flag is set (SIGN-3);
//! 2. `hv_vm_create`; 3. IPA limits; 4. EL2; 5. max vCPUs;
//! 6. `hv_gic_create` (risk R1: the in-kernel GICv3 needs macOS 15, decision D7);
//! 7. the host page size; 8. 100 × VM create/destroy (teardown really releases the VM).
//!
//! **Why the hardened runtime matters** (threat model SIGN-3, `[V]` §13): without it, dyld
//! honours `DYLD_*` variables in the entitled process, so anything that can set the launch
//! environment can inject code. `scripts/sign.sh --debug` omits the flag so lldb can attach;
//! it marks the signature identifier with [`DEBUG_ID_SUFFIX`], and the doctor then reports a
//! warning instead of a failure.
//!
//! This file is one of the two places allowed to use `std::process::Command` (PROC-3): it runs
//! `/usr/bin/codesign` by absolute path, never through a shell.

use crate::{LogLevel, err, out};
use std::process::{Command, ExitCode};

/// The only entitlement macvmm may carry (SIGN-1).
const HYPERVISOR_ENTITLEMENT: &str = "com.apple.security.hypervisor";
/// Appended to the signing identifier by `scripts/sign.sh --debug`.
const DEBUG_ID_SUFFIX: &str = ".debug-signing";
/// Iterations of the create/destroy loop.
const CREATE_DESTROY_ROUNDS: u32 = 100;

/// Capability-probe placement for the in-kernel GIC. Any 64 KiB-aligned, non-overlapping pair
/// answers "can a GIC be created?"; the machine's real addresses come from
/// `vmm::arch::layout` (M2), the single source of truth for the memory map.
const PROBE_GIC: hvf::GicConfig = hvf::GicConfig {
    distributor_base: 0,
    redistributor_base: 0x1_0000,
    msi: None,
};

/// Collects failures so every check runs and the summary is complete.
struct Doctor {
    log: LogLevel,
    failures: u32,
}

impl Doctor {
    fn fail(&mut self, line: &str, detail: &str) {
        self.failures = self.failures.saturating_add(1);
        out(line);
        err(&format!("macvmm doctor: {detail}"));
    }
}

// ANCHOR: doctor_checks
/// Run every check in order; exit 0 only if all of them passed.
pub fn run(log: LogLevel) -> ExitCode {
    let mut d = Doctor { log, failures: 0 };
    out("macvmm doctor");
    check_signature(&mut d); // 1. SIGN-1 entitlements, SIGN-3 hardened runtime
    let vm_ok = check_vm_create(&mut d); // 2. the entitlement actually works
    check_capabilities(&mut d); // 3-5. IPA limits, EL2, max vCPUs
    if vm_ok {
        check_gic(&mut d); // 6. in-kernel GICv3 (macOS 15+, risk R1)
    } else {
        out("in-kernel GICv3 (hv_gic_create): SKIPPED (no VM)");
    }
    out(&format!("page size: {}", hvf::caps::host_page_size())); // 7.
    if vm_ok {
        check_create_destroy(&mut d); // 8. teardown really releases the VM
    } else {
        out(&format!(
            "vm create/destroy x{CREATE_DESTROY_ROUNDS}: SKIPPED (no VM)"
        ));
    }
    if d.failures == 0 {
        out("DOCTOR OK");
        ExitCode::SUCCESS
    } else {
        err(&format!("DOCTOR FAILED: {} problem(s)", d.failures));
        ExitCode::from(1)
    }
}
// ANCHOR_END: doctor_checks

// ANCHOR: doctor_vm_create
/// Check 2: create and destroy a default VM. `HV_DENIED` means the entitlement is missing.
fn check_vm_create(d: &mut Doctor) -> bool {
    match hvf::VmBuilder::new()
        .create()
        .and_then(|(vm, _gic)| vm.destroy())
    {
        Ok(()) => {
            out("hv_vm_create: OK");
            true
        }
        Err(e) => {
            d.fail(
                &format!("hv_vm_create: FAILED ({})", e.error),
                &e.to_string(),
            );
            if e.error == hvf::HvError::Denied {
                err("hint: this binary lacks com.apple.security.hypervisor. Build and run it");
                err("      through scripts/sign-and-run.sh (`cargo run -p macvmm -- doctor`");
                err("      does this), or sign it with scripts/sign.sh.");
            }
            false
        }
    }
}
// ANCHOR_END: doctor_vm_create

/// Checks 3-5: what the hypervisor supports (no VM needed).
fn check_capabilities(d: &mut Doctor) {
    match hvf::Capabilities::probe() {
        Ok(c) => {
            out(&format!(
                "max IPA: {} bits (default {})",
                c.max_ipa_bits, c.default_ipa_bits
            ));
            out(&format!(
                "EL2 supported: {}",
                if c.el2_supported { "yes" } else { "no" }
            ));
            out(&format!("max vCPUs: {}", c.max_vcpus));
        }
        Err(e) => d.fail(
            &format!("capabilities: FAILED ({})", e.error),
            &e.to_string(),
        ),
    }
}

/// Check 6: a VM with an in-kernel GICv3.
fn check_gic(d: &mut Doctor) {
    let gic = hvf::VmBuilder::new()
        .with_gic(PROBE_GIC)
        .create()
        .and_then(|(vm, _gic)| vm.destroy());
    match gic {
        Ok(()) => out("in-kernel GICv3 (hv_gic_create): OK"),
        Err(e) => d.fail(
            &format!("in-kernel GICv3 (hv_gic_create): FAILED ({})", e.error),
            &format!("{e} (the in-kernel GIC needs macOS 15 or later)"),
        ),
    }
}

/// Check 8: repeated create/destroy, which fails if teardown leaks the VM.
fn check_create_destroy(d: &mut Doctor) {
    match create_destroy_loop(CREATE_DESTROY_ROUNDS) {
        Ok(()) => out(&format!("vm create/destroy x{CREATE_DESTROY_ROUNDS}: OK")),
        Err((round, e)) => d.fail(
            &format!("vm create/destroy x{CREATE_DESTROY_ROUNDS}: FAILED at round {round}"),
            &e.to_string(),
        ),
    }
}

// ANCHOR: doctor_create_destroy
fn create_destroy_loop(rounds: u32) -> Result<(), (u32, hvf::CallError)> {
    for round in 1..=rounds {
        hvf::VmBuilder::new()
            .create()
            .and_then(|(vm, _gic)| vm.destroy())
            .map_err(|e| (round, e))?;
    }
    Ok(())
}
// ANCHOR_END: doctor_create_destroy

/// Check 1: entitlements (SIGN-1) and the hardened-runtime flag (SIGN-3).
fn check_signature(d: &mut Doctor) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            d.fail(
                "codesign entitlements: FAILED",
                &format!("cannot locate own binary: {e}"),
            );
            return;
        }
    };
    let ents = codesign(&["-d", "--entitlements", "-", "--xml"], &exe);
    let info = codesign(&["-dv"], &exe);
    let (ents, info) = match (ents, info) {
        (Ok(e), Ok(i)) => (e, i),
        (Err(e), _) | (_, Err(e)) => {
            d.fail(
                "codesign entitlements: FAILED",
                &format!("running /usr/bin/codesign: {e}"),
            );
            return;
        }
    };
    if d.log >= LogLevel::Debug {
        err(&format!(
            "debug: codesign entitlements output: {:?}",
            ents.stdout
        ));
        err(&format!("debug: codesign -dv output: {:?}", info.stderr));
    }

    match judge_entitlements(&entitlement_entries(&ents.stdout)) {
        Ok(()) => out(&format!(
            "codesign entitlements: {HYPERVISOR_ENTITLEMENT} only"
        )),
        Err(problem) => d.fail(
            &format!("codesign entitlements: FAILED ({problem})"),
            &format!("entitlements must be exactly {{{HYPERVISOR_ENTITLEMENT}}}: {problem}"),
        ),
    }

    let sig = signature_info(&info.stderr);
    if sig.runtime {
        out("hardened runtime: yes");
    } else if sig.debug_signing {
        out("hardened runtime: no (debug signing)");
        err("warning: debug signing omits the hardened runtime; DYLD_* variables are honoured");
    } else {
        d.fail(
            "hardened runtime: no",
            "the hardened runtime flag is missing (SIGN-3); sign with scripts/sign.sh",
        );
    }
}

struct Output {
    stdout: String,
    stderr: String,
}

/// Run `/usr/bin/codesign ARGS EXE` (absolute path, no shell, no environment-dependent lookup).
fn codesign(args: &[&str], exe: &std::path::Path) -> std::io::Result<Output> {
    let o = Command::new("/usr/bin/codesign")
        .args(args)
        .arg(exe)
        .output()?;
    Ok(Output {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    })
}

/// `(key, value)` pairs from codesign's entitlement dump. Accepts the XML plist form (`--xml`)
/// and the bracketed form newer `codesign` prints without it. `value` is `Some(bool)` for
/// boolean values and `None` for anything else.
fn entitlement_entries(text: &str) -> Vec<(String, Option<bool>)> {
    let mut entries = Vec::new();
    if text.contains("<key>") {
        let mut rest = text;
        while let Some(start) = rest.find("<key>") {
            let after = &rest[start + "<key>".len()..];
            let Some(end) = after.find("</key>") else {
                break;
            };
            let key = after[..end].trim().to_owned();
            let tail = after[end + "</key>".len()..].trim_start();
            let value = if tail.starts_with("<true/>") {
                Some(true)
            } else if tail.starts_with("<false/>") {
                Some(false)
            } else {
                None
            };
            entries.push((key, value));
            rest = &after[end..];
        }
    } else {
        let mut lines = text.lines().map(str::trim).peekable();
        while let Some(line) = lines.next() {
            if let Some(key) = line.strip_prefix("[Key]") {
                let mut value = None;
                if lines.peek() == Some(&"[Value]") {
                    lines.next();
                    value = match lines.peek().copied() {
                        Some("[Bool] true") => Some(true),
                        Some("[Bool] false") => Some(false),
                        _ => None,
                    };
                }
                entries.push((key.trim().to_owned(), value));
            }
        }
    }
    entries
}

/// SIGN-1: exactly one entitlement, the hypervisor key, set to `true`.
fn judge_entitlements(entries: &[(String, Option<bool>)]) -> Result<(), String> {
    let extra: Vec<&str> = entries
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| *k != HYPERVISOR_ENTITLEMENT)
        .collect();
    if !extra.is_empty() {
        return Err(format!("unexpected entitlements: {}", extra.join(", ")));
    }
    match entries {
        [] => Err("no entitlements".to_owned()),
        [(_, Some(true))] => Ok(()),
        [(_, _)] => Err(format!("{HYPERVISOR_ENTITLEMENT} is not true")),
        _ => Err(format!("{HYPERVISOR_ENTITLEMENT} listed more than once")),
    }
}

struct SignatureInfo {
    runtime: bool,
    debug_signing: bool,
}

/// Parse `codesign -dv` (stderr): the `flags=0x10002(adhoc,runtime)` word of the
/// `CodeDirectory` line and the `Identifier=` line.
fn signature_info(text: &str) -> SignatureInfo {
    let runtime = text
        .lines()
        .filter(|l| l.starts_with("CodeDirectory"))
        .flat_map(str::split_whitespace)
        .filter_map(|w| w.strip_prefix("flags="))
        .any(|f| f.split(['(', ')', ',']).any(|flag| flag == "runtime"));
    let debug_signing = text
        .lines()
        .filter_map(|l| l.strip_prefix("Identifier="))
        .any(|id| id.trim_end().ends_with(DEBUG_ID_SUFFIX));
    SignatureInfo {
        runtime,
        debug_signing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML_OK: &str = r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>"#;

    #[test]
    fn xml_single_hypervisor_key_passes() {
        let e = entitlement_entries(XML_OK);
        assert_eq!(e, vec![(HYPERVISOR_ENTITLEMENT.to_owned(), Some(true))]);
        assert_eq!(judge_entitlements(&e), Ok(()));
    }

    #[test]
    fn bracket_form_is_understood() {
        let text = "[Dict]\n\t[Key] com.apple.security.hypervisor\n\t[Value]\n\t\t[Bool] true\n";
        assert_eq!(judge_entitlements(&entitlement_entries(text)), Ok(()));
    }

    #[test]
    fn extra_or_missing_entitlements_fail() {
        let jit = XML_OK.replace(
            "</dict>",
            "<key>com.apple.security.cs.allow-jit</key><true/></dict>",
        );
        let err = judge_entitlements(&entitlement_entries(&jit)).unwrap_err();
        assert!(err.contains("com.apple.security.cs.allow-jit"), "{err}");
        assert!(judge_entitlements(&entitlement_entries("")).is_err());
        let falsy = XML_OK.replace("<true/>", "<false/>");
        assert!(judge_entitlements(&entitlement_entries(&falsy)).is_err());
        let twice = XML_OK.replace(
            "</dict>",
            "<key>com.apple.security.hypervisor</key><true/></dict>",
        );
        assert!(judge_entitlements(&entitlement_entries(&twice)).is_err());
    }

    #[test]
    fn runtime_flag_and_debug_identifier() {
        let rt = "Identifier=macvmm\nCodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1+1\n";
        let s = signature_info(rt);
        assert!(s.runtime && !s.debug_signing);
        let dbg =
            "Identifier=macvmm.debug-signing\nCodeDirectory v=20400 flags=0x2(adhoc) hashes=1\n";
        let s = signature_info(dbg);
        assert!(!s.runtime && s.debug_signing);
        let linker = "CodeDirectory v=20400 flags=0x20002(adhoc,linker-signed) hashes=1\n";
        assert!(!signature_info(linker).runtime);
    }
}
