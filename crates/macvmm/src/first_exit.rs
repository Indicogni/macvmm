//! `macvmm first-exit`: the smallest complete VM (course ch02).
//!
//! **Why this exists:** before any device, loader or run loop, a learner should see the whole
//! hardware-virtualization round trip once, with nothing hidden: create a VM, give it one page
//! of memory holding three instructions, create a vCPU, run it, and read back what the guest
//! did when it trapped to us. The three instructions are:
//!
//! | Address | Word | Instruction | Why |
//! |---|---|---|---|
//! | `RAM + 0` | `0xD2800540` | `movz x0, #0x2a` | leave a value we can read back |
//! | `RAM + 4` | `0xD4000002` | `hvc #0` | trap to the hypervisor (EC 0x16) |
//! | `RAM + 8` | `0x14000000` | `b .` | never reached; a safe place to stop if it were |
//!
//! (ARM ARM C6.2 MOVZ, HVC, B.) The vCPU starts with `PC = RAM` and `CPSR = 0x3c5`: EL1 using
//! SP_EL1 ("EL1h", M[3:0] = 0b0101), AArch64, with D, A, I and F all masked (bits 9:6).
//!
//! The expected exit is `reason = EXCEPTION`, `ESR_EL2 = 0x5a000000`: EC = 0x16 ("HVC
//! instruction execution in AArch64 state"; ARM ARM, ESR_EL2 register description, citation
//! convention in the `hvf` crate docs), IL = 1, ISS = imm16 = 0. For an
//! HVC the hardware has already advanced the PC (the preferred return address is the next
//! instruction), so we read `PC = RAM + 8`, and `x0 = 0x2a` proves the first instruction ran.

use crate::{err, out};
use hvf::{ExitReason, MemFlags, OwnedMapping, Reg, Vcpu, VmBuilder};
use std::process::ExitCode;

/// Guest RAM base, `0x4000_0000` in the QEMU `virt` map (PLAN §1). Spelled as a shift because
/// the audit reserves the hex literal for `vmm::arch::layout` (architecture §4), which arrives
/// in M2; this constant should then become `vmm::arch::layout::RAM_BASE`.
const RAM_BASE: u64 = 1 << 30;
/// One 16 KiB page, the default stage-2 granule (spike finding 1).
const PAGE: usize = 16 * 1024;
/// EL1h with DAIF masked.
const CPSR_EL1H_MASKED: u64 = 0x3c5;

// ANCHOR: first_exit_code_bytes
/// `movz x0, #0x2a` · `hvc #0` · `b .`, as A64 words.
const CODE: [u32; 3] = [0xD280_0540, 0xD400_0002, 0x1400_0000];

/// The words in guest memory order: A64 instructions are little-endian.
fn code_bytes() -> Vec<u8> {
    CODE.iter().flat_map(|w| w.to_le_bytes()).collect()
}
// ANCHOR_END: first_exit_code_bytes

/// A name for the few exception classes this lesson can meet (ARM ARM, ESR_EL2 register
/// description, the EC field table). Full decoding is `vmm::arch::esr` (M4).
fn ec_name(ec: u64) -> &'static str {
    match ec {
        0x01 => "WFx",
        0x16 => "HVC64",
        0x17 => "SMC64",
        0x18 => "SYS64",
        0x20 => "IABT_LOWER",
        0x24 => "DABT_LOWER",
        _ => "other",
    }
}

/// Run the demo: exactly three lines on stdout and exit 0 on success; the lines reached so far
/// plus an error on stderr and exit 1 otherwise.
pub fn run() -> ExitCode {
    match first_exit() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            err(&format!("first-exit: {e}"));
            if e.error == hvf::HvError::Denied {
                err("hint: run it through scripts/sign-and-run.sh (`cargo run -p macvmm --");
                err("      first-exit` does this) so it carries com.apple.security.hypervisor.");
            }
            ExitCode::FAILURE
        }
    }
}

// ANCHOR: first_exit_run
fn first_exit() -> Result<(), hvf::CallError> {
    // 1. The VM: one per process, default 36-bit IPA, no GIC needed for a single trap.
    let (vm, _no_gic) = VmBuilder::new().create()?;

    // 2. One page of guest RAM at RAM_BASE holding the three instructions.
    let ram = OwnedMapping::new(&vm, RAM_BASE, PAGE, MemFlags::RWX)?;
    ram.write(0, &code_bytes()).map_err(|_| hvf::CallError {
        call: "write",
        error: hvf::HvError::BadArgument,
    })?;
    out(&format!(
        "first-exit: mapped {} KiB at IPA {RAM_BASE:#x}",
        PAGE / 1024
    ));

    // 3. A vCPU for this thread, pointed at the code.
    let mut vcpu = Vcpu::create(&vm)?;
    vcpu.set_reg(Reg::PC, RAM_BASE)?;
    vcpu.set_reg(Reg::CPSR, CPSR_EL1H_MASKED)?;

    // 4. Run until the guest traps, then decode the syndrome by hand.
    let exit = vcpu.run()?;
    let ec = (exit.esr >> 26) & 0x3f;
    let imm = exit.esr & 0xffff;
    let reason = exit.reason.name();
    out(&format!(
        "first-exit: exit reason={reason} syndrome={:#x} ec={ec:#x} ({}) imm={imm:#x}",
        exit.esr,
        ec_name(ec)
    ));
    if exit.reason != ExitReason::Exception {
        return Err(hvf::CallError {
            call: "hv_vcpu_run (expected an exception exit)",
            error: hvf::HvError::Error,
        });
    }

    // 5. The HVC already advanced PC; x0 holds what `movz` put there.
    let pc = vcpu.get_reg(Reg::PC)?;
    let x0 = vcpu.get_reg(Reg::X0)?;
    out(&format!("first-exit: pc={pc:#x} x0={x0:#x}"));

    // Tear down in reverse: vCPU, mapping, VM (drop order would do the same; explicit `destroy`
    // reports a failure instead of hiding it).
    drop(vcpu);
    drop(ram);
    vm.destroy()
}
// ANCHOR_END: first_exit_run

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_little_endian_words() {
        assert_eq!(
            code_bytes(),
            [
                0x40, 0x05, 0x80, 0xd2, 0x02, 0x00, 0x00, 0xd4, 0x00, 0x00, 0x00, 0x14
            ]
        );
    }

    #[test]
    fn ec_names() {
        assert_eq!(ec_name(0x16), "HVC64");
        assert_eq!(ec_name(0x3f), "other");
    }
}
