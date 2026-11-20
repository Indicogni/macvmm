//! Exit handling: what one decoded exit means and what the VMM does about it (architecture
//! §8.2, §8.3; course ch07; threat model MMIO-1, HC-1, LOG-1).
//!
//! **Decoding** lives in `arch/esr.rs` ([`Exit::from_hv`]): pure, total, host-tested. This
//! module is the **policy**: [`handle`] follows the PC-advance table of architecture §8.2,
//! verified on this machine (spike findings 5–7):
//!
//! | Exit | Handler | PC after |
//! |---|---|---|
//! | `Canceled` | the loop re-checks the stop flag (a kick may be sticky or spurious) | unchanged |
//! | `Hvc` | `smccc::dispatch(Conduit::Hvc)` | **unchanged**: the hardware already advanced it |
//! | `Smc` | `smccc::dispatch(Conduit::Smc)` | +4 |
//! | `DataAbort` | `vcpu::mmio::handle`: ISV = 1 from the syndrome, ISV = 0 by decoding the instruction (M17) | +4 after emulation; set by `inject` on an abort |
//! | `SysReg` | `arch::sysreg::handle` (M5): emulate, RAZ/WI, or inject UNDEF | +4 on emulate; set by `inject` on UNDEF |
//! | `Wfx` | in-kernel GIC: defensive (never seen), warn once, yield. `--irqchip none` (M8): sleep until the `CNTV_CVAL` deadline or a stop ([`nogic_wfi`]) | +4 |
//! | `VtimerActivated` | in-kernel GIC: defensive, warn once, unmask the vtimer. `--irqchip none` (M8): raise the vCPU's IRQ line (`timer::NoGicTimer`) | unchanged |
//! | `InstructionAbort`, `Brk`, `Unknown` | `Stop(GuestFatal)` with the full dump | — |
//!
//! Why the PC rules differ: HVC is a *call*, an exception taken after the instruction
//! completed, so `ELR_EL2` already points past it; SMC (trapped by HCR_EL2.TSC), a data abort
//! and a sysreg trap are *faults*, taken before the instruction completed, so the PC points at
//! it and the VMM must step over the instruction it emulated (ARM ARM DDI 0487, D1.10
//! "Exception entry", the preferred return address of each class).
//!
//! **Injection** (M5, `arch/inject.rs`). A sysreg the policy refuses becomes an UNDEF *in the
//! guest*: the handler reads `PC`, `CPSR`, `VBAR_EL1` and `SCTLR_EL1`, computes the exception
//! entry, writes `ELR/SPSR/ESR_EL1`, `CPSR` and `PC`, and resumes **without** advancing the PC
//! (it now points at the guest's vector). A mode the injector cannot handle (AArch32, EL2) is
//! a `GuestFatal` (HC-7).
//!
//! **Every handler fills the trace record** (`trace::ExitRecord`): the MMIO fields, the SMCCC
//! function name, the action. A fatal exit is `action: "stop"`, with the register dump from
//! [`VcpuRegs::dump`]; the run loop then attaches the last 32 exits from the ring.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::mmio::{self, MmioOutcome};
use super::regs::RegDump;
use crate::arch::esr::{DataAbort, Exit, SysRegAccess, fsc_name};
use crate::arch::inject::{self, Injection, VcpuState};
use crate::arch::sysreg::{self, SysRegOutcome, SysRegState};
use crate::backend::serial::Sink;
use crate::bus::Bus;
use crate::config::MmioPolicy;
use crate::control::{GuestFatal, StopReason, VmControl};
use crate::error::{Error, Result};
use crate::memory::GuestMemory;
use crate::smccc::{self, Conduit};
use crate::timer::{self, NoGicTimer, WfiWait};
use crate::trace::{Action, ExitRecord};
use hvf::SysReg;
use std::sync::atomic::{AtomicBool, Ordering};

/// What the run loop does next.
#[derive(Debug)]
pub enum ExitAction {
    Resume {
        advance_pc: bool,
    },
    Stop(StopReason),
    /// PSCI CPU_OFF: this vCPU is off; the run loop parks it until a CPU_ON or the stop (M5).
    CpuOff,
}

/// Register access the handlers need. `n = 31` means XZR: it reads as 0 and writes are
/// discarded. Implemented by [`super::Vcpu`], and by a fake in tests.
pub trait VcpuRegs {
    fn index(&self) -> usize;
    fn x(&self, n: u8) -> Result<u64>;
    fn set_x(&mut self, n: u8, value: u64) -> Result<()>;
    fn pc(&self) -> Result<u64>;
    fn cpsr(&self) -> Result<u64>;
    fn unmask_vtimer(&mut self) -> Result<()>;
    /// The full register snapshot for a fatal dump (`None` if it cannot be read).
    fn dump(&self) -> Option<RegDump>;
    /// Read a system register through `hv_vcpu_get_sys_reg` (exception injection, M5).
    fn sys_reg(&self, _r: SysReg) -> Result<u64> {
        Err(Error::Internal(
            "this register file has no system registers",
        ))
    }
    /// Write a system register (exception injection only: never a value from a trapped
    /// `MSR`, HC-6).
    fn set_sys_reg(&mut self, _r: SysReg, _v: u64) -> Result<()> {
        Err(Error::Internal(
            "this register file has no system registers",
        ))
    }
    /// Set the PC (exception injection).
    fn set_pc(&mut self, _v: u64) -> Result<()> {
        Err(Error::Internal("this register file cannot set the PC"))
    }
    /// Set the CPSR (exception injection).
    fn set_cpsr(&mut self, _v: u64) -> Result<()> {
        Err(Error::Internal("this register file cannot set the CPSR"))
    }
    /// The vCPU's emulated debug-lock registers (OS lock, per vCPU, HC-6).
    fn sysreg_state(&mut self) -> Option<&mut SysRegState> {
        None
    }
    /// The VMM-side timer line in the `--irqchip none` mode (M8, architecture §9.1); `None`
    /// with the in-kernel GIC.
    fn nogic(&mut self) -> Option<&mut NoGicTimer> {
        None
    }
}

/// Everything else the handlers may touch.
pub struct ExitEnv<'a> {
    pub mem: &'a dyn GuestMemory,
    pub serial: &'a Sink,
    pub ctl: &'a VmControl,
    pub bus: &'a Bus,
    pub generation: u64,
    pub debug_calls: bool,
    pub unhandled_mmio: MmioPolicy,
    /// M21: a machine profile's observer of the exits (the vmapple first-probe trace). `None`
    /// for the `virt` machine, which then behaves exactly as without it.
    pub watch: Option<&'a dyn ExitWatch>,
    /// M18: the flash ROM (`--bios`), so the ISV = 0 path can fetch an instruction executing
    /// in place from it (`arch::stage1_walk::fetch_insn_rom`). Read-only; `None` without one.
    pub rom: Option<&'a dyn crate::arch::stage1_walk::InsnRom>,
}

// ANCHOR: exit_env_new
impl<'a> ExitEnv<'a> {
    /// The environment as chapter 08 knows it: memory, the serial sink, the VM control block
    /// and the device bus, with generation 0, the debug hypercalls off and the default
    /// `--unhandled-mmio fatal` policy. Every field a later chapter adds (M18 `rom`, M21
    /// `watch`) starts as `None` here, so code (and the frozen checkpoint contracts) that
    /// builds an `ExitEnv` with `ExitEnv { debug_calls: true, ..ExitEnv::new(..) }` keeps
    /// compiling at every chapter, whatever fields the struct has grown since.
    pub fn new(
        mem: &'a dyn GuestMemory,
        serial: &'a Sink,
        ctl: &'a VmControl,
        bus: &'a Bus,
    ) -> Self {
        Self {
            mem,
            serial,
            ctl,
            bus,
            generation: 0,
            debug_calls: false,
            unhandled_mmio: MmioPolicy::Fatal,
            watch: None,
            rom: None,
        }
    }
}
// ANCHOR_END: exit_env_new

/// An MMIO access that reached no device (M21, [`ExitWatch::unclaimed_mmio`]). Numbers only:
/// nothing in it is a string the guest chose (TTY-8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnclaimedAccess {
    /// The PC of the faulting instruction.
    pub pc: u64,
    pub ipa: u64,
    /// The access size in bytes (1, 2, 4 or 8).
    pub size: u8,
    /// `Some(value)` for a store (masked to `size`), `None` for a load.
    pub write: Option<u64>,
}

// ANCHOR: exit_watch
/// A machine profile's hook into exit handling (M21; PLAN M21 `unknown.rs`). The `virt`
/// machine has none. The experimental vmapple profile uses it to say where the boot ROM
/// first trapped, to stop at a hypercall it does not implement, and to log what the ROM
/// touches instead of stopping at the first unknown device (ADR-0008 decision 3).
///
/// Both methods run on the vCPU thread that took the exit, so they must be cheap and must
/// never block (architecture §14.2). They see only numbers, never guest strings.
pub trait ExitWatch: Sync {
    /// Called before `exit` is handled. `Ok(Some(reason))` stops the VM with a `GuestFatal`
    /// (exit code 3) carrying `reason` instead of handling the exit.
    fn before_exit(&self, regs: &dyn VcpuRegs, exit: &Exit) -> Result<Option<String>>;
    /// An access to no device. `Some(verdict)` replaces the `--unhandled-mmio` policy for it;
    /// `None` leaves the policy in charge.
    fn unclaimed_mmio(&self, access: &UnclaimedAccess) -> Option<MmioVerdict>;
    /// An ISV = 0 access the M17 decoder refused (MMIO-4/6), before the synchronous external
    /// abort is injected. `Some(reason)` stops the VM instead (exit code 3); `None`, the
    /// default and the `virt` behaviour, injects the abort.
    fn refused_isv0(&self, _access: &RefusedAccess) -> Option<String> {
        None
    }
}
// ANCHOR_END: exit_watch

/// An ISV = 0 data abort that was not emulated (M21, [`ExitWatch::refused_isv0`]). Nothing was
/// decoded, so the size and the value are unknown; only the syndrome's facts remain. Numbers
/// and a static reason only (TTY-8, LOG-5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefusedAccess {
    /// The PC of the faulting instruction.
    pub pc: u64,
    /// The exit IPA.
    pub ipa: u64,
    /// `ESR.WnR`.
    pub write: bool,
    /// No device is mapped at `ipa` (the access would have gone to the unhandled-MMIO path).
    pub unclaimed: bool,
}

/// What [`unhandled_mmio_policy`] decided.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MmioVerdict {
    /// Stop with this message (exit code 3).
    Fatal(String),
    /// Read as zero / ignore the write, and resume.
    RazWi,
}

// ANCHOR: unhandled_mmio_policy
/// A guest access to an IPA that is neither RAM nor a device (architecture §8.3 step 1).
/// `fatal` (the default) stops the VM with a message only the VMM prints; `log` makes the
/// access RAZ/WI and warns, rate-limited, because the guest decides how often it happens
/// (LOG-1).
pub fn unhandled_mmio_policy(policy: MmioPolicy, ipa: u64, da: &DataAbort, pc: u64) -> MmioVerdict {
    let dir = if da.wnr { "write" } else { "read" };
    let what = format!(
        "unhandled MMIO {dir} at {ipa:#x} size {} pc {pc:#x}",
        da.size_bytes()
    );
    match policy {
        MmioPolicy::Fatal => MmioVerdict::Fatal(what),
        MmioPolicy::Log => {
            crate::guest_warn!("{what} (ignored: --unhandled-mmio log)");
            MmioVerdict::RazWi
        }
    }
}
// ANCHOR_END: unhandled_mmio_policy

/// Build the `GuestFatal` stop for the current vCPU state (architecture §15).
fn fatal(
    regs: &dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    rec: &mut ExitRecord,
    reason: String,
) -> Result<ExitAction> {
    rec.action = Some(Action::Stop);
    let pc = regs.pc()?;
    let dump = regs.dump();
    // The PC is a VA once the guest's MMU is on: fetch through its stage 1 (M17).
    let insn = super::dump::insn_at_pc(env.mem, dump.as_ref(), pc);
    Ok(ExitAction::Stop(StopReason::GuestFatal(Box::new(
        GuestFatal {
            vcpu: Some(regs.index()),
            reason,
            pc,
            esr: raw.esr,
            ipa: raw.ipa,
            cpsr: regs.cpsr()?,
            insn,
            exit: Some(*exit),
            regs: dump.map(Box::new),
            last_exits: Vec::new(),
        },
    ))))
}

fn smccc_call(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    conduit: Conduit,
    imm: u16,
    rec: &mut ExitRecord,
) -> Result<ExitAction> {
    let x = [regs.x(0)?, regs.x(1)?, regs.x(2)?, regs.x(3)?];
    let [x0, ..] = x;
    rec.func = smccc::function_name(x0);
    rec.action = Some(if smccc::is_psci(x0) {
        Action::Psci
    } else {
        Action::Smccc
    });
    let ctx = smccc::Ctx {
        mem: env.mem,
        serial: env.serial,
        ctl: env.ctl,
        vcpu: regs.index(),
        generation: env.generation,
        debug_calls: env.debug_calls,
    };
    match smccc::dispatch(&ctx, &smccc::Call { conduit, imm, x }) {
        smccc::Outcome::Stop(r) => Ok(ExitAction::Stop(r)),
        smccc::Outcome::CpuOff => Ok(ExitAction::CpuOff),
        smccc::Outcome::Return(values) => {
            for (n, v) in (0u8..).zip(values) {
                if let Some(v) = v {
                    regs.set_x(n, v)?;
                }
            }
            Ok(ExitAction::Resume {
                advance_pc: conduit == Conduit::Smc,
            })
        }
    }
}

/// The one-line reason for an exit class that always stops the VM (the last row of the
/// PC-advance table). Numbers and static names only (LOG-5).
fn fatal_reason(exit: &Exit, raw: &hvf::VcpuExit, pc: u64) -> String {
    match *exit {
        Exit::SysReg(_) => format!("system register access trapped at pc {pc:#x}: {exit}"),
        Exit::InstructionAbort { ifsc, .. } => format!(
            "instruction abort at pc {pc:#x}: {} at IPA {:#x} (ifsc {ifsc:#x})",
            fsc_name(ifsc).unwrap_or("fault"),
            raw.ipa
        ),
        Exit::Brk { imm } => format!("brk #{imm:#x} at pc {pc:#x} (no debugger attached)"),
        Exit::Unknown { ec, .. } if raw.reason == hvf::ExitReason::Exception => {
            format!("unhandled exception class {ec:#x} at pc {pc:#x}")
        }
        Exit::Unknown { .. } => "hv_vcpu_run returned an unknown exit reason".into(),
        _ => format!("unexpected exit at pc {pc:#x}: {exit}"),
    }
}

/// Write an [`Injection`] into the vCPU: the exception-entry registers, then `CPSR` and `PC`.
fn apply_injection(regs: &mut dyn VcpuRegs, inj: &Injection) -> Result<()> {
    regs.set_sys_reg(SysReg::ELR_EL1, inj.elr_el1)?;
    regs.set_sys_reg(SysReg::SPSR_EL1, inj.spsr_el1)?;
    regs.set_sys_reg(SysReg::ESR_EL1, inj.esr_el1)?;
    if let Some(far) = inj.far_el1 {
        regs.set_sys_reg(SysReg::FAR_EL1, far)?;
    }
    regs.set_cpsr(inj.cpsr)?;
    regs.set_pc(inj.pc)
}

/// The state [`inject`] needs, read from the vCPU at the trap.
fn inject_state(regs: &dyn VcpuRegs) -> Result<VcpuState> {
    Ok(VcpuState {
        pc: regs.pc()?,
        cpsr: regs.cpsr()?,
        vbar_el1: regs.sys_reg(SysReg::VBAR_EL1)?,
        sctlr_el1: regs.sys_reg(SysReg::SCTLR_EL1)?,
    })
}

/// Inject an UNDEF for the instruction at the PC and resume at the guest's vector (the PC is
/// not advanced). A mode the injector refuses stops the VM (HC-7).
pub fn inject_undef(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    rec: &mut ExitRecord,
) -> Result<ExitAction> {
    let st = inject_state(regs)?;
    match inject::undef(&st) {
        Ok(inj) => {
            apply_injection(regs, &inj)?;
            rec.action = Some(Action::InjectUndef);
            Ok(ExitAction::Resume { advance_pc: false })
        }
        Err(e) => {
            let why = format!("{e} at pc {:#x}", st.pc);
            fatal(regs, env, exit, raw, rec, why)
        }
    }
}

/// Inject a synchronous external data abort at `far` (M17: an ISV = 0 access the VMM refuses
/// to emulate, MMIO-4/MMIO-6) and resume at the guest's vector (the PC is not advanced). A
/// mode the injector refuses stops the VM (HC-7).
fn inject_abort(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    rec: &mut ExitRecord,
    far: u64,
    write: bool,
) -> Result<ExitAction> {
    let st = inject_state(regs)?;
    match inject::data_abort(&st, far, write) {
        Ok(inj) => {
            apply_injection(regs, &inj)?;
            rec.action = Some(Action::InjectAbort);
            Ok(ExitAction::Resume { advance_pc: false })
        }
        Err(e) => {
            let why = format!("{e} at pc {:#x}", st.pc);
            fatal(regs, env, exit, raw, rec, why)
        }
    }
}

// ANCHOR: sysreg_trap
/// A trapped `MSR`/`MRS` (EC 0x18; architecture §8.4). The policy (`arch::sysreg`) decides;
/// an emulated access steps over the instruction, anything else becomes an UNDEF in the guest
/// with a rate-limited warning naming the register (HC-6, LOG-1).
fn sysreg_trap(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    access: &SysRegAccess,
    rec: &mut ExitRecord,
) -> Result<ExitAction> {
    let reg = access.encoding();
    rec.sysreg = sysreg::static_name(reg);
    // Always the number too: the M10 trap log must identify unnamed registers (§8.4).
    rec.sysreg_enc = Some(reg.0);
    let value = if access.read { 0 } else { regs.x(access.rt)? };
    let mut fallback = SysRegState::default();
    let state = match regs.sysreg_state() {
        Some(st) => st,
        None => &mut fallback,
    };
    match sysreg::handle(state, access, value) {
        SysRegOutcome::Read(v) => {
            regs.set_x(access.rt, v)?; // XZR (rt = 31) discards it
            rec.value = Some(v);
            rec.action = Some(Action::Sysreg);
            Ok(ExitAction::Resume { advance_pc: true })
        }
        SysRegOutcome::Written => {
            rec.value = Some(value);
            rec.action = Some(Action::Sysreg);
            Ok(ExitAction::Resume { advance_pc: true })
        }
        SysRegOutcome::Undef => {
            crate::guest_warn!(
                "vcpu{}: {} {} at pc {:#x}: injecting UNDEF",
                regs.index(),
                if access.read { "MRS" } else { "MSR" },
                sysreg::display_name(reg),
                regs.pc()?
            );
            inject_undef(regs, env, exit, raw, rec)
        }
    }
}
// ANCHOR_END: sysreg_trap

// A guest triggers these two, so they go through `guest_warn!` (LOG-1). The flags make them
// once-per-process on top of that: each is a single "this should not happen" diagnostic, not
// a per-event message.
static VTIMER_WARNED: AtomicBool = AtomicBool::new(false);
static WFX_WARNED: AtomicBool = AtomicBool::new(false);

// ANCHOR: nogic_wfi
/// A WFI in the `--irqchip none` mode (architecture §9.1): if no IRQ is pending, sleep until
/// the guest's `CNTV_CVAL` deadline, in slices of at most `timer::NOGIC_WFI_SLICE`, each one
/// woken early by a stop, so a guest that never arms its timer cannot hold up `--timeout` or a
/// quit. `CNTV_CTL`/`CNTV_CVAL` are re-read every slice (they are guest-controlled; their
/// handling is total, `timer::nogic_wfi_wait`). Then step over the WFI.
pub fn nogic_wfi(regs: &mut dyn VcpuRegs, env: &ExitEnv<'_>) -> Result<ExitAction> {
    loop {
        if env.ctl.is_stopping() {
            break;
        }
        let ctl = regs.sys_reg(SysReg::CNTV_CTL_EL0)?;
        let cval = regs.sys_reg(SysReg::CNTV_CVAL_EL0)?;
        let Some(t) = regs.nogic() else { break };
        if t.irq_pending(ctl) {
            break; // the pending IRQ ends the WFI at once
        }
        let (offset, tb) = (t.offset, t.timebase);
        let now = hvf::host::mach_absolute_time();
        match timer::nogic_wfi_wait(ctl, cval, offset, now, tb) {
            WfiWait::Wake => break,
            WfiWait::Sleep(d) => {
                if env.ctl.sleep_unless_stopped(d) {
                    break;
                }
            }
        }
    }
    Ok(ExitAction::Resume { advance_pc: true })
}
// ANCHOR_END: nogic_wfi

// ANCHOR: exit_pc_rules
/// Handle one decoded exit (module docs, the PC-advance table). `raw` is the framework's exit
/// record (ESR, IPA); `rec` is this exit's trace record, which the handler completes.
pub fn handle(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    rec: &mut ExitRecord,
) -> Result<ExitAction> {
    match *exit {
        Exit::Canceled => Ok(ExitAction::Resume { advance_pc: false }),
        Exit::Hvc { imm } => smccc_call(regs, env, Conduit::Hvc, imm, rec),
        Exit::Smc { imm } => smccc_call(regs, env, Conduit::Smc, imm, rec),
        Exit::DataAbort(da) => {
            let pc = regs.pc()?;
            match mmio::handle(regs, env, raw, &da, pc, rec)? {
                MmioOutcome::Done => Ok(ExitAction::Resume { advance_pc: true }),
                MmioOutcome::Fatal(why) => fatal(regs, env, exit, raw, rec, why),
                MmioOutcome::Abort { far, write } => {
                    inject_abort(regs, env, exit, raw, rec, far, write)
                }
            }
        }
        Exit::Wfx { .. } if regs.nogic().is_some() => nogic_wfi(regs, env),
        Exit::VtimerActivated if regs.nogic().is_some() => {
            // The framework has masked the vtimer; the line stays up until the guest handles
            // or disarms the timer (`Vcpu::run`'s before-entry rule).
            if let Some(t) = regs.nogic() {
                t.vtimer_activated();
            }
            Ok(ExitAction::Resume { advance_pc: false })
        }
        Exit::Wfx { .. } => {
            if !WFX_WARNED.swap(true, Ordering::Relaxed) {
                crate::guest_warn!("WFx exit with the in-kernel GIC (unexpected); yielding");
            }
            std::thread::yield_now();
            Ok(ExitAction::Resume { advance_pc: true })
        }
        Exit::VtimerActivated => {
            if !VTIMER_WARNED.swap(true, Ordering::Relaxed) {
                crate::guest_warn!(
                    "VTIMER_ACTIVATED with the in-kernel GIC (unexpected); unmasking"
                );
            }
            regs.unmask_vtimer()?;
            Ok(ExitAction::Resume { advance_pc: false })
        }
        Exit::SysReg(access) => sysreg_trap(regs, env, exit, raw, &access, rec),
        Exit::InstructionAbort { .. } | Exit::Brk { .. } | Exit::Unknown { .. } => {
            let why = fatal_reason(exit, raw, regs.pc()?);
            fatal(regs, env, exit, raw, rec, why)
        }
    }
}
// ANCHOR_END: exit_pc_rules

/// [`handle`], after the machine profile's [`ExitWatch`] (M21) had its look: the run loop's
/// entry point. Without a watch (the `virt` machine) this is exactly `handle`; with one, the
/// watch may stop the VM at an exit it does not support, with a `GuestFatal` (exit code 3).
pub fn handle_watched(
    regs: &mut dyn VcpuRegs,
    env: &ExitEnv<'_>,
    exit: &Exit,
    raw: &hvf::VcpuExit,
    rec: &mut ExitRecord,
) -> Result<ExitAction> {
    if let Some(w) = env.watch
        && let Some(why) = w.before_exit(&*regs, exit)?
    {
        return fatal(regs, env, exit, raw, rec, why);
    }
    handle(regs, env, exit, raw, rec)
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
pub(crate) mod tests {
    use super::*;
    use crate::backend::ansi::FilterPolicy;
    use crate::memory::{GuestAddress, VecMemory};
    use hvf::{ExitReason, VcpuExit};

    /// A register file that resolves `n` exactly as [`crate::vcpu::Vcpu`] does: through
    /// `hvf::Reg::x` into the `hv_reg_t` number space, where 31 is `HV_REG_PC`. So if the
    /// SRT-31-is-XZR mapping ever broke, a test would see the PC move, as a real guest would.
    #[derive(Default)]
    pub(crate) struct Fake {
        pub x: [u64; 31],
        pub pc: u64,
        /// `set_x(31, _)` calls, which `Reg::x` turns into a discard (XZR).
        pub xzr_writes: u32,
        /// System registers by `hv_sys_reg_t` (injection tests).
        pub sys: std::collections::BTreeMap<u16, u64>,
        /// `None` reads as `0x3c5`.
        pub cpsr: Option<u64>,
        pub sysregs: SysRegState,
        /// The `--irqchip none` timer line (M8), when the test enables that mode.
        pub nogic: Option<NoGicTimer>,
    }
    impl Fake {
        fn slot(&mut self, r: hvf::Reg) -> Option<&mut u64> {
            if r == hvf::Reg::PC {
                Some(&mut self.pc)
            } else {
                self.x.get_mut(usize::try_from(r.0).ok()?)
            }
        }
    }
    impl VcpuRegs for Fake {
        fn index(&self) -> usize {
            0
        }
        fn x(&self, n: u8) -> Result<u64> {
            Ok(match hvf::Reg::x(n) {
                Some(r) if r == hvf::Reg::PC => self.pc,
                Some(r) => usize::try_from(r.0)
                    .ok()
                    .and_then(|i| self.x.get(i).copied())
                    .unwrap_or(0),
                None => 0, // XZR
            })
        }
        fn set_x(&mut self, n: u8, v: u64) -> Result<()> {
            match hvf::Reg::x(n) {
                Some(r) => {
                    if let Some(slot) = self.slot(r) {
                        *slot = v;
                    }
                }
                None => self.xzr_writes = self.xzr_writes.saturating_add(1),
            }
            Ok(())
        }
        fn pc(&self) -> Result<u64> {
            Ok(self.pc)
        }
        fn cpsr(&self) -> Result<u64> {
            Ok(self.cpsr.unwrap_or(0x3c5))
        }
        fn unmask_vtimer(&mut self) -> Result<()> {
            Ok(())
        }
        fn sys_reg(&self, r: SysReg) -> Result<u64> {
            Ok(self.sys.get(&r.0).copied().unwrap_or(0))
        }
        fn set_sys_reg(&mut self, r: SysReg, v: u64) -> Result<()> {
            self.sys.insert(r.0, v);
            Ok(())
        }
        fn set_pc(&mut self, v: u64) -> Result<()> {
            self.pc = v;
            Ok(())
        }
        fn set_cpsr(&mut self, v: u64) -> Result<()> {
            self.cpsr = Some(v);
            Ok(())
        }
        fn sysreg_state(&mut self) -> Option<&mut SysRegState> {
            Some(&mut self.sysregs)
        }
        fn nogic(&mut self) -> Option<&mut NoGicTimer> {
            self.nogic.as_mut()
        }
        fn dump(&self) -> Option<RegDump> {
            Some(RegDump {
                x: self.x,
                pc: self.pc,
                cpsr: 0x3c5,
                ..RegDump::default()
            })
        }
    }

    pub(crate) const RAM: u64 = 0x4000_0000;

    pub(crate) fn with_env_bus<R>(
        policy: MmioPolicy,
        bus: &Bus,
        f: impl FnOnce(&ExitEnv<'_>) -> R,
    ) -> R {
        let mem = VecMemory::new(&[(GuestAddress(RAM), 1 << 20)]).unwrap();
        mem.write_u32(GuestAddress(RAM + 0x80), 0xb900_0001)
            .unwrap();
        let sink = Sink::new("t", Box::new(std::io::sink()), FilterPolicy::Safe);
        let ctl = VmControl::new();
        let env = ExitEnv {
            mem: &mem,
            serial: &sink,
            ctl: &ctl,
            bus,
            generation: 0,
            debug_calls: true,
            unhandled_mmio: policy,
            watch: None,
            rom: None,
        };
        f(&env)
    }

    fn with_env<R>(policy: MmioPolicy, f: impl FnOnce(&ExitEnv<'_>) -> R) -> R {
        with_env_bus(policy, &Bus::new(), f)
    }

    /// The spike's `str w1, [x0]` to an unmapped IPA (finding 7).
    const STR_W1_ESR: u64 = 0x9381_0046;

    fn raw(esr: u64, ipa: u64) -> VcpuExit {
        VcpuExit {
            reason: ExitReason::Exception,
            esr,
            far: ipa,
            ipa,
        }
    }

    fn go(r: &mut Fake, env: &ExitEnv<'_>, esr: u64, ipa: u64) -> (ExitAction, ExitRecord) {
        let raw = raw(esr, ipa);
        let exit = Exit::from_hv(raw.reason, raw.esr);
        let mut rec = ExitRecord::default();
        let a = handle(r, env, &exit, &raw, &mut rec).unwrap();
        (a, rec)
    }

    #[test]
    fn unhandled_write_is_fatal_by_default() {
        with_env(MmioPolicy::Fatal, |env| {
            let mut r = Fake {
                pc: RAM + 0x80,
                ..Fake::default()
            };
            match go(&mut r, env, STR_W1_ESR, 0x0c00_0000) {
                (ExitAction::Stop(StopReason::GuestFatal(g)), rec) => {
                    assert_eq!(
                        g.reason,
                        "unhandled MMIO write at 0xc000000 size 4 pc 0x40000080"
                    );
                    assert_eq!(g.insn, Some(0xb900_0001));
                    assert_eq!((g.esr, g.ipa), (STR_W1_ESR, 0x0c00_0000));
                    assert!(g.regs.is_some() && g.exit.is_some());
                    assert_eq!(rec.action, Some(Action::Stop));
                }
                other => panic!("{other:?}"),
            }
        });
    }

    #[test]
    fn log_policy_is_raz_wi() {
        with_env(MmioPolicy::Log, |env| {
            let mut r = Fake {
                pc: RAM,
                ..Fake::default()
            };
            r.x[3] = 0xdead;
            // ldr w3, [x0]: a read, SRT = 3.
            let esr = STR_W1_ESR & !(1 << 6) & !(0x1f << 16) | (3 << 16);
            let (a, rec) = go(&mut r, env, esr, 0x0c00_0000);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert_eq!(r.x[3], 0);
            assert_eq!((rec.action, rec.value), (Some(Action::Mmio), Some(0)));
        });
    }

    #[test]
    fn every_fatal_class_stops_with_a_dump() {
        with_env(MmioPolicy::Log, |env| {
            let mut r = Fake {
                pc: 0x200,
                ..Fake::default()
            };
            for (esr, want) in [
                (
                    0x8200_0006u64,
                    "instruction abort at pc 0x200: translation fault at IPA 0x200",
                ),
                (0xf200_0001, "brk #0x1 at pc 0x200"),
                (0x0200_0000, "unhandled exception class 0x0 at pc 0x200"),
                (0x9600_0021, "unhandled exception class 0x25 at pc 0x200"),
            ] {
                match go(&mut r, env, esr, 0x200) {
                    (ExitAction::Stop(StopReason::GuestFatal(g)), rec) => {
                        assert!(g.reason.starts_with(want), "{esr:#x}: {}", g.reason);
                        assert_eq!(g.insn, None, "pc 0x200 is not RAM");
                        assert_eq!(rec.action, Some(Action::Stop));
                    }
                    other => panic!("{esr:#x}: {other:?}"),
                }
            }
            let raw = VcpuExit {
                reason: ExitReason::Unknown,
                esr: 0,
                far: 0,
                ipa: 0,
            };
            let exit = Exit::from_hv(raw.reason, raw.esr);
            let a = handle(&mut r, env, &exit, &raw, &mut ExitRecord::default()).unwrap();
            assert!(
                matches!(a, ExitAction::Stop(StopReason::GuestFatal(g)) if g.reason.contains("unknown exit reason"))
            );
        });
    }

    #[test]
    fn hvc_keeps_pc_smc_advances() {
        with_env(MmioPolicy::Fatal, |env| {
            let mut r = Fake::default();
            r.x[0] = 0xC600_00FF;
            let (a, rec) = go(&mut r, env, 0x5a00_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: false }));
            assert_eq!(r.x[0], u64::MAX);
            assert_eq!((rec.func, rec.action), (None, Some(Action::Smccc)));
            r.x[0] = 0xC600_4D04;
            let (a, rec) = go(&mut r, env, 0x5e00_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert_eq!(r.x[..2], [0, 0]);
            assert_eq!(rec.func, Some("DEBUG_BOOT_COUNT"));
            r.x[0] = 0x8400_0008;
            let (a, rec) = go(&mut r, env, 0x5a00_0000, 0);
            assert!(matches!(a, ExitAction::Stop(StopReason::PowerOff)));
            assert_eq!(
                (rec.func, rec.action),
                (Some("PSCI_SYSTEM_OFF"), Some(Action::Psci))
            );
            let (a, _) = go(&mut r, env, 0x0400_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }), "WFI");
            let raw = VcpuExit {
                reason: ExitReason::Canceled,
                esr: 0,
                far: 0,
                ipa: 0,
            };
            let a = handle(
                &mut r,
                env,
                &Exit::Canceled,
                &raw,
                &mut ExitRecord::default(),
            );
            assert!(matches!(a, Ok(ExitAction::Resume { advance_pc: false })));
        });
    }

    #[test]
    fn pmcr_read_injects_undef() {
        with_env(MmioPolicy::Fatal, |env| {
            let mut r = Fake {
                pc: RAM + 0x100,
                ..Fake::default()
            };
            r.sys.insert(SysReg::VBAR_EL1.0, RAM + 0x800);
            r.sys.insert(SysReg::SCTLR_EL1.0, 1 << 23); // SPAN = 1: PAN unchanged
            r.x[4] = 0x1234;
            // `mrs x4, pmcr_el0` (spike finding 9).
            let (a, rec) = go(&mut r, env, 0x6230_e499, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: false }));
            assert_eq!(r.pc, RAM + 0xa00, "VBAR + 0x200 (EL1h)");
            assert_eq!(r.sys[&SysReg::ELR_EL1.0], RAM + 0x100);
            assert_eq!(r.sys[&SysReg::ESR_EL1.0], 0x0200_0000);
            assert_eq!(r.sys[&SysReg::SPSR_EL1.0], 0x3c5);
            assert_eq!(r.cpsr, Some(0x3c5));
            assert_eq!(r.x[4], 0x1234, "Rt untouched");
            assert_eq!(rec.sysreg, Some("PMCR_EL0"));
            assert_eq!(rec.sysreg_enc, Some(SysReg::PMCR_EL0.0));
            assert_eq!(rec.action, Some(Action::InjectUndef));
        });
    }

    /// A forwarded register nobody names still has an identity in the trace: its encoding
    /// (architecture §8.4: the M10 trap log is built from these records).
    #[test]
    fn unnamed_sysreg_is_identified_by_encoding() {
        with_env(MmioPolicy::Fatal, |env| {
            let mut r = Fake {
                pc: RAM + 0x100,
                ..Fake::default()
            };
            r.sys.insert(SysReg::VBAR_EL1.0, RAM + 0x800);
            let reg = SysReg::new(3, 0, 15, 0, 0); // S3_0_C15_C0_0, IMPLEMENTATION DEFINED
            let esr = (0x18u64 << 26) | (1 << 25) | u64::from(reg.to_iss(1, true));
            let (a, rec) = go(&mut r, env, esr, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: false }));
            assert_eq!(rec.sysreg, None);
            assert_eq!(rec.sysreg_enc, Some(0xc780));
            assert_eq!(rec.action, Some(Action::InjectUndef));
            assert!(
                rec.to_json()
                    .contains(r#""sysreg_enc":"0xc780","action":"inject_undef""#)
            );
        });
    }

    #[test]
    fn os_lock_is_emulated_and_steps_over() {
        with_env(MmioPolicy::Fatal, |env| {
            let mut r = Fake::default();
            let lar = 0x6000_0000 | u64::from(SysReg::OSLAR_EL1.to_iss(2, false));
            let lsr = 0x6000_0000 | u64::from(SysReg::OSLSR_EL1.to_iss(3, true));
            r.x[2] = 0;
            let (a, rec) = go(&mut r, env, lar, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert_eq!(
                (rec.sysreg, rec.action),
                (Some("OSLAR_EL1"), Some(Action::Sysreg))
            );
            let (a, rec) = go(&mut r, env, lsr, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert_eq!((r.x[3], rec.value), (0x8, Some(0x8)));
            // An AArch32 mode cannot take the injected UNDEF: fatal, not a panic (HC-7).
            r.cpsr = Some(0x10);
            let (a, _) = go(&mut r, env, 0x6230_e499, 0);
            assert!(
                matches!(a, ExitAction::Stop(StopReason::GuestFatal(g)) if g.reason.contains("unsupported PSTATE mode"))
            );
        });
    }

    /// M8 Part A (architecture §9.1): VTIMER_ACTIVATED raises the line without moving the PC;
    /// a WFI wakes at once while the timer asserts, sleeps until the CVAL deadline otherwise,
    /// and never outlives a stop (even with the timer disabled: `nogic_wfi_deadline`).
    #[test]
    fn nogic_vtimer_and_wfi() {
        use crate::timer::cntv_ctl;
        use std::time::{Duration, Instant};
        with_env(MmioPolicy::Fatal, |env| {
            let offset = hvf::host::mach_absolute_time();
            let mut r = Fake {
                pc: RAM,
                nogic: Some(NoGicTimer::new(offset, hvf::host::timebase())),
                ..Fake::default()
            };
            let raw = VcpuExit {
                reason: ExitReason::VtimerActivated,
                esr: 0,
                far: 0,
                ipa: 0,
            };
            let exit = Exit::from_hv(raw.reason, raw.esr);
            let a = handle(&mut r, env, &exit, &raw, &mut ExitRecord::default()).unwrap();
            assert!(matches!(a, ExitAction::Resume { advance_pc: false }));
            assert!(r.nogic.unwrap().line());
            // The timer still asserts: WFI does not sleep.
            r.sys
                .insert(SysReg::CNTV_CTL_EL0.0, cntv_ctl::ENABLE | cntv_ctl::ISTATUS);
            let t = Instant::now();
            let (a, _) = go(&mut r, env, 0x0400_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert!(t.elapsed() < Duration::from_millis(50));
            // Armed 30 ms ahead (24 MHz counter): WFI sleeps until then.
            r.nogic = Some(NoGicTimer::new(offset, hvf::host::timebase()));
            let now_cnt = hvf::host::mach_absolute_time() - offset;
            r.sys.insert(SysReg::CNTV_CTL_EL0.0, cntv_ctl::ENABLE);
            r.sys.insert(SysReg::CNTV_CVAL_EL0.0, now_cnt + 24_000 * 30);
            let t = Instant::now();
            let (a, _) = go(&mut r, env, 0x0400_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            let slept = t.elapsed();
            assert!(slept >= Duration::from_millis(25), "{slept:?}");
            assert!(slept < Duration::from_secs(2), "{slept:?}");
            // Timer disabled and a stop already requested: back at once.
            r.sys.insert(SysReg::CNTV_CTL_EL0.0, 0);
            env.ctl.request_stop(StopReason::Timeout);
            let t = Instant::now();
            let (a, _) = go(&mut r, env, 0x0400_0000, 0);
            assert!(matches!(a, ExitAction::Resume { advance_pc: true }));
            assert!(t.elapsed() < Duration::from_millis(50));
        });
    }
}
