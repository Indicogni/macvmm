//! vCPUs: the wrapper around `hvf::Vcpu`, its reset, the exit handlers and the run loop
//! (architecture §6.5, §8).
//!
//! - [`Vcpu`] (this file): creation, MPIDR, the boot-time register state ([`Vcpu::reset`]),
//!   and register access through the [`exit::VcpuRegs`] trait, which is what lets the exit
//!   handlers be host-tested with a fake vCPU.
//! - [`exit`]: classify an exit and decide what it means (pure, host-tested).
//! - [`run_loop`]: enter the guest, handle the exit, repeat, until the VM stops.
//! - [`manager`]: create the vCPU threads one at a time and wait for the stop (SMP, M16).
//! - [`wait`]: a parked (PSCI OFF) vCPU's wait and the start gate (M16).
//! - [`mmio`]: data-abort (MMIO) emulation for ISV = 1 (M4).
//! - [`regs`] and [`dump`]: the register snapshot and the fatal-stop report (M4).
//!
//! **Thread rule** (spike finding 19, `hvf` crate docs): a vCPU's registers can only be
//! touched by the thread that created it. `hvf::Vcpu` is `!Send`, so the compiler enforces it;
//! other threads only ever get its `VcpuHandle` to kick it.

pub mod dump;
pub mod exit;
pub mod manager;
pub mod mmio;
pub mod regs;
pub mod run_loop;
pub mod wait;

use crate::arch::regs::sctlr;
use crate::arch::sysreg::SysRegState;
use crate::error::{Error, Result};
use crate::timer::{LineKicker, NOGIC_LINE_RECHECK, NoGicTimer};
use exit::VcpuRegs;
use hvf::{Reg, SysReg, Vm};
use regs::RegDump;

// ANCHOR: boot_params
/// The architectural state a vCPU starts from: its entry point, boot arguments and mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BootParams {
    pub pc: u64,
    /// `x0..x3` (booting.rst §4: x0 = DTB, x1..x3 = 0).
    pub x: [u64; 4],
    pub cpsr: u64,
}

/// `SCTLR_EL1` bits cleared at reset: M (bit 0, stage-1 MMU), C (bit 2, data cache), I
/// (bit 12, instruction cache) (ARM ARM D19.2.118 SCTLR_EL1; booting.rst §4 "MMU off").
pub const SCTLR_MMU_CACHES: u64 = sctlr::M | sctlr::C | sctlr::I;

/// `MPIDR_EL1` for vCPU `index` (the rule lives in `arch::regs::mpidr`).
pub fn mpidr_for(index: usize) -> u64 {
    crate::arch::regs::mpidr(index)
}
// ANCHOR_END: boot_params

// ANCHOR: vmm_vcpu_struct
fn hv(op: &'static str) -> impl FnOnce(hvf::CallError) -> Error {
    move |err| Error::Hv { op, err }
}

/// One vCPU, owned by its thread.
pub struct Vcpu<'vm> {
    /// The no-GIC stale-line kick (`timer::LineKicker`, `--irqchip none` only). Declared
    /// first so it is dropped (its thread joined) before `inner` destroys the vCPU it kicks.
    nogic_kick: Option<LineKicker>,
    inner: hvf::Vcpu<'vm>,
    pub index: usize,
    pub mpidr: u64,
    /// The emulated OS-lock registers (`arch::sysreg`), one set per vCPU.
    sysregs: SysRegState,
    /// The VMM-side timer interrupt line, only in the `--irqchip none` teaching mode
    /// (`timer.rs`). `None` with the in-kernel GIC.
    nogic: Option<NoGicTimer>,
}
// ANCHOR_END: vmm_vcpu_struct

impl<'vm> Vcpu<'vm> {
    // ANCHOR: vmm_vcpu_create
    /// Create vCPU `index` on the calling thread and give it its MPIDR. The MPIDR must be
    /// written explicitly: HVF's own copy reads 0 until we do (the guest still reads
    /// `0x80000000` on vCPU 0), and `hv_gic_get_redistributor_base` (chapter 12) refuses
    /// until the vCPU's affinity has been set by this write (`hv_gic.h`). The redistributor
    /// slot it returns follows creation order, not the value written.
    pub fn create(vm: &'vm Vm, index: usize) -> Result<Vcpu<'vm>> {
        let inner = hvf::Vcpu::create(vm).map_err(hv("create vCPU"))?;
        let mpidr = mpidr_for(index);
        inner
            .set_sys_reg(SysReg::MPIDR_EL1, mpidr)
            .map_err(hv("set MPIDR_EL1"))?;
        Ok(Vcpu {
            nogic_kick: None,
            inner,
            index,
            mpidr,
            sysregs: SysRegState::default(),
            nogic: None,
        })
    }
    // ANCHOR_END: vmm_vcpu_create

    // ANCHOR: vcpu_enable_nogic
    /// Switch this vCPU to the no-GIC teaching mode (`--irqchip none`): the VMM delivers the
    /// timer interrupt itself (`timer.rs` module docs). Call before the first run. Starts the
    /// helper thread that bounds a stale pending IRQ (`timer::LineKicker`).
    pub fn enable_nogic(&mut self, offset: u64) -> Result<()> {
        let h = self.inner.handle();
        let kick = LineKicker::spawn(format!("vcpu{}-irqkick", self.index), move || {
            // A stale handle after the vCPU is gone is harmless (`hvf::vcpus_exit` docs); the
            // kicker is joined before the vCPU is destroyed anyway.
            let _ = hvf::vcpus_exit(&[h]);
        })
        .map_err(|_| Error::Internal("cannot spawn the no-GIC line kicker thread"))?;
        self.nogic_kick = Some(kick);
        self.nogic = Some(NoGicTimer::new(offset, hvf::host::timebase()));
        Ok(())
    }
    // ANCHOR_END: vcpu_enable_nogic

    /// This vCPU's GIC redistributor base (`hv_gic_get_redistributor_base`). Only valid once
    /// MPIDR_EL1 was written (spike finding 17), which [`Vcpu::create`] does; `vcpu::manager`
    /// checks it equals `GICR_BASE + index × 0x2_0000` (architecture §8.1 step 2).
    pub fn redistributor_base(&self) -> Result<u64> {
        self.inner
            .gic_redistributor_base()
            .map_err(hv("get the GIC redistributor base"))
    }

    /// `hv_vcpu_get_exec_time` in host ticks (`--stats`, M8).
    pub fn exec_time(&self) -> Result<u64> {
        self.inner.exec_time().map_err(hv("get exec time"))
    }

    /// `hv_vcpu_get_wait_for_interrupt_time` in host ticks: `None` before macOS 27 or
    /// without a GIC (`HV_UNSUPPORTED`, spike) (`--stats`, M8).
    pub fn wfi_time(&self) -> Option<u64> {
        self.inner.wfi_time().ok().flatten()
    }

    // ANCHOR: nogic_before_entry
    /// The no-GIC before-entry rule: drop the line and unmask the vtimer once the guest handled
    /// or disarmed it; while the line is up, assert the IRQ for this run (the framework clears
    /// it after every run, `hv_vcpu.h`) and arm the kick that ends the run within
    /// `timer::NOGIC_LINE_RECHECK`: the guest silences the timer without an exit, and the
    /// pending IRQ would otherwise outlive it for the whole run.
    fn nogic_before_entry(&mut self) -> Result<()> {
        let Some(t) = self.nogic.as_mut() else {
            return Ok(());
        };
        let masked = self.inner.vtimer_mask().map_err(hv("get vtimer mask"))?;
        let ctl = if masked || t.line() {
            self.inner
                .get_sys_reg(SysReg::CNTV_CTL_EL0)
                .map_err(hv("get CNTV_CTL_EL0"))?
        } else {
            0
        };
        let action = t.before_entry(masked, ctl);
        if action.unmask {
            self.inner
                .set_vtimer_mask(false)
                .map_err(hv("unmask vtimer"))?;
        }
        if action.assert_irq {
            // Verified on a real Mac: this call succeeds when there is no GIC.
            self.inner
                .set_pending_interrupt(false, true)
                .map_err(hv("set pending IRQ"))?;
        }
        if let Some(k) = &self.nogic_kick {
            if action.assert_irq {
                k.arm(NOGIC_LINE_RECHECK);
            } else {
                k.disarm();
            }
        }
        Ok(())
    }
    // ANCHOR_END: nogic_before_entry

    // ANCHOR: vcpu_reset
    /// Put the vCPU in its boot state (chapter 06: the CPU's *reset state*, as opposed to a
    /// system reset the guest asks for through PSCI). Only what a guest relies on is set:
    /// - `PC` = the entry point and `x0..x3` = the boot arguments (booting.rst section 4:
    ///   x0 = the device tree address);
    /// - `CPSR` = `0x3c5` by default: EL1h, D/A/I/F masked (`arch::regs::Pstate`);
    /// - `SCTLR_EL1.{M,C,I} = 0`: translation and caches off, the state booting.rst requires;
    /// - the VM-wide virtual-counter offset (chapter 11: the same value on every vCPU, so the
    ///   guest's counter starts near 0 and agrees across CPUs).
    ///
    /// `MPIDR_EL1` was set by [`Vcpu::create`]. Every other register keeps HVF's default,
    /// which reads 0 through the API, `SCTLR_EL1` included. A dump still shows `SCTLR_EL1 =
    /// 0x30000180`: its RES1 bits (7, 8, 28, 29 on this CPU) read as 1 whatever is written
    /// (verified on a real Mac). Clearing only M, C and I is a defensive habit: change only
    /// the bits you mean to change.
    pub fn reset(&self, boot: &BootParams, vtimer_offset: u64) -> Result<()> {
        let v = &self.inner;
        v.set_reg(Reg::PC, boot.pc).map_err(hv("set PC"))?;
        for (i, value) in boot.x.iter().enumerate() {
            let reg = u8::try_from(i)
                .ok()
                .and_then(Reg::x)
                .ok_or(Error::Internal("x index"))?;
            v.set_reg(reg, *value).map_err(hv("set x0..x3"))?;
        }
        v.set_reg(Reg::CPSR, boot.cpsr).map_err(hv("set CPSR"))?;
        let sctlr = v
            .get_sys_reg(SysReg::SCTLR_EL1)
            .map_err(hv("get SCTLR_EL1"))?;
        v.set_sys_reg(SysReg::SCTLR_EL1, sctlr & !SCTLR_MMU_CACHES)
            .map_err(hv("set SCTLR_EL1"))?;
        v.set_vtimer_offset(vtimer_offset)
            .map_err(hv("set vtimer offset"))?;
        Ok(())
    }
    // ANCHOR_END: vcpu_reset

    // ANCHOR: vcpu_power_on
    /// Start this vCPU at a PSCI CPU_ON entry point (DEN 0022 §5.1.4, architecture §8.6):
    /// `PC = entry`, `x0 = ctx`, `x1..x3 = 0`, `CPSR = 0x3c5`, MMU and caches off. The vtimer
    /// offset was set at creation and stays the VM-wide one. The OS lock is a cold-reset value.
    // ANCHOR: vcpu_power_on_fn
    pub fn power_on(&mut self, on: &crate::psci::PowerOn) -> Result<()> {
        let v = &self.inner;
        v.set_reg(Reg::PC, on.entry).map_err(hv("set PC"))?;
        for (n, value) in [(0u8, on.ctx), (1, 0), (2, 0), (3, 0)] {
            let reg = Reg::x(n).ok_or(Error::Internal("x index"))?;
            v.set_reg(reg, value).map_err(hv("set x0..x3"))?;
        }
        v.set_reg(Reg::CPSR, crate::arch::regs::pstate::EL1H_MASKED)
            .map_err(hv("set CPSR"))?;
        let sctlr = v
            .get_sys_reg(SysReg::SCTLR_EL1)
            .map_err(hv("get SCTLR_EL1"))?;
        v.set_sys_reg(SysReg::SCTLR_EL1, sctlr & !SCTLR_MMU_CACHES)
            .map_err(hv("set SCTLR_EL1"))?;
        self.sysregs = SysRegState::default();
        Ok(())
    }
    // ANCHOR_END: vcpu_power_on_fn
    // ANCHOR_END: vcpu_power_on

    /// Snapshot every register the fatal dump prints (`vcpu::regs`).
    pub fn regs_dump(&self) -> Result<RegDump> {
        RegDump::capture(&self.inner).map_err(hv("read registers for the dump"))
    }

    /// The kick handle for other threads.
    pub fn handle(&self) -> hvf::VcpuHandle {
        self.inner.handle()
    }

    // ANCHOR: vcpu_run_nogic
    /// Enter the guest until the next exit (in the no-GIC mode, after the before-entry rule).
    pub fn run(&mut self) -> Result<hvf::VcpuExit> {
        self.nogic_before_entry()?;
        self.inner.run().map_err(hv("run vCPU"))
    }
    // ANCHOR_END: vcpu_run_nogic

    // ANCHOR: vcpu_advance_pc
    /// Advance the PC by one instruction (A64 instructions are 4 bytes).
    pub fn advance_pc(&mut self) -> Result<()> {
        let pc = self.pc()?;
        self.inner
            .set_reg(Reg::PC, pc.wrapping_add(4))
            .map_err(hv("set PC"))
    }
    // ANCHOR_END: vcpu_advance_pc
}

impl VcpuRegs for Vcpu<'_> {
    fn index(&self) -> usize {
        self.index
    }
    // ANCHOR: vcpu_regs_xzr
    fn x(&self, n: u8) -> Result<u64> {
        match Reg::x(n) {
            Some(r) => self.inner.get_reg(r).map_err(hv("get Xn")),
            None => Ok(0), // XZR
        }
    }
    fn set_x(&mut self, n: u8, value: u64) -> Result<()> {
        match Reg::x(n) {
            Some(r) => self.inner.set_reg(r, value).map_err(hv("set Xn")),
            None => Ok(()), // writes to XZR are discarded
        }
    }
    // ANCHOR_END: vcpu_regs_xzr
    fn pc(&self) -> Result<u64> {
        self.inner.get_reg(Reg::PC).map_err(hv("get PC"))
    }
    fn cpsr(&self) -> Result<u64> {
        self.inner.get_reg(Reg::CPSR).map_err(hv("get CPSR"))
    }
    fn unmask_vtimer(&mut self) -> Result<()> {
        self.inner
            .set_vtimer_mask(false)
            .map_err(hv("unmask vtimer"))
    }
    fn dump(&self) -> Option<RegDump> {
        self.regs_dump().ok()
    }
    fn sys_reg(&self, r: SysReg) -> Result<u64> {
        self.inner
            .get_sys_reg(r)
            .map_err(hv("get a system register"))
    }
    fn set_sys_reg(&mut self, r: SysReg, v: u64) -> Result<()> {
        self.inner
            .set_sys_reg(r, v)
            .map_err(hv("set a system register"))
    }
    fn set_pc(&mut self, v: u64) -> Result<()> {
        self.inner.set_reg(Reg::PC, v).map_err(hv("set PC"))
    }
    fn set_cpsr(&mut self, v: u64) -> Result<()> {
        self.inner.set_reg(Reg::CPSR, v).map_err(hv("set CPSR"))
    }
    fn sysreg_state(&mut self) -> Option<&mut SysRegState> {
        Some(&mut self.sysregs)
    }
    fn nogic(&mut self) -> Option<&mut NoGicTimer> {
        self.nogic.as_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpidr_layout() {
        assert_eq!(mpidr_for(0), 0x8000_0000);
        assert_eq!(mpidr_for(15), 0x8000_000f);
        assert_eq!(mpidr_for(16), 0x8000_0100);
        assert_eq!(mpidr_for(63), 0x8000_030f);
    }
}
