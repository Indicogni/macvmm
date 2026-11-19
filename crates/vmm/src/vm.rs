//! VM creation and fail-closed teardown (architecture §6.7, §14.5; threat model MEM-9, MEM-11).
//!
//! **Creation.** [`create_vm`] picks the IPA width: the smallest value ≥ 36 that covers the
//! layout and RAM (`Layout::ipa_bits_needed`). A wider IPA space than needed only costs deeper
//! stage-2 tables, and asking for more than the host supports makes `hv_vm_create` fail with
//! `HV_UNSUPPORTED` (spike finding 3), so the limit is checked first and reported as a
//! configuration error naming both numbers (40 bits on the M5 Pro). The in-kernel GICv3 is
//! created inside the same call at the `layout.rs` bases, because `hv_gic.h` requires
//! `hv_gic_create` after `hv_vm_create` and before any `hv_vcpu_create` (ADR-0004).
//! [`create_vm_with`] can leave it out, for the `--irqchip none` teaching mode (M8,
//! architecture §9.1).
//!
//! **Startup assertions** (M8, architecture §9; [`check_gic`]). The layout, the DTB and the
//! guests all *assume* the framework's GIC geometry; they are checked against what the live
//! framework reports, once per boot, before any vCPU exists: a 64 KiB distributor, a 128 KiB
//! redistributor per vCPU (GIC spec IHI 0069 §12.10: RD_base + SGI_base frames), an SPI range
//! holding every INTID `layout.rs` wires, the EL1 virtual timer at INTID 27 and the EL1
//! physical timer at INTID 30 (the PPIs the DT `timer` node lists, `arm,arch_timer.yaml`). A
//! future macOS that changed one would otherwise boot guests with a silently wrong DTB; instead
//! the build fails with a message naming both values.
//!
//! **Teardown** ([`teardown`]) runs the order of architecture §14.5 and turns every failure
//! into the safe outcome:
//! 1. every holder of the `Arc<GuestRam>` (vCPU threads, device workers) has gone (MEM-9). If
//!    one has not, the RAM is still reachable from host code, so it is leaked and the caller
//!    gets an error: a strictly stronger check than a debug assertion, and it holds in release
//!    builds too;
//! 2. unmap every RAM region (and the ROM, if any);
//! 3. `hv_vm_destroy`;
//! 4. free the host blocks **only if** steps 2 and 3 both succeeded
//!    (`memory::host::teardown_action`). Otherwise the blocks are leaked and the caller gets
//!    `Error::Hv { op: "teardown", .. }`.
//!
//! The run loop (`vmm::run`, M3/M5) propagates that error with `?`: it ends the process with
//! exit code 1 and **never** rebuilds the machine for a reboot (MEM-11, flaw F22), because a
//! VM whose teardown failed may still map memory the host is about to reuse.
#![forbid(unsafe_code)]

use crate::arch::layout::{
    GICD_BASE, GICD_SIZE, GICR_BASE, GICR_FRAME_SIZE, Layout, VIRTIO_MMIO_SLOTS,
};
use crate::config::IrqChip;
use crate::error::{Error, Result};
use crate::memory::{GuestRam, RomRegion, TeardownAction};
use core::ops::Range;
use hvf::{CallError, Capabilities, Gic, GicConfig, GicInterrupt, Vm, VmBuilder};
use std::sync::Arc;

// ANCHOR: vm_create_with_gic
/// Create the process's VM, with an in-kernel GICv3 at the layout's GICD/GICR bases, for a
/// machine whose RAM ends at `ram_end`.
pub fn create_vm(layout: &Layout, ram_end: u64, caps: &Capabilities) -> Result<(Vm, Gic)> {
    let bits = layout.ipa_bits_needed(ram_end);
    if bits > caps.max_ipa_bits {
        return Err(Error::Config(format!(
            "the machine needs a {bits}-bit IPA space; this host supports {}",
            caps.max_ipa_bits
        )));
    }
    let gic = GicConfig {
        distributor_base: GICD_BASE,
        redistributor_base: GICR_BASE,
        msi: None,
    };
    let (vm, gic) = VmBuilder::new()
        .ipa_bits(bits)
        .with_gic(gic)
        .create()
        .map_err(|err| Error::Hv {
            op: "create VM",
            err,
        })?;
    let gic = gic.ok_or(Error::Internal("VmBuilder::with_gic returned no GIC"))?;
    Ok((vm, gic))
}
// ANCHOR_END: vm_create_with_gic

/// [`create_vm`] for `irqchip`: with the in-kernel GICv3, or without any interrupt controller
/// (`--irqchip none`, architecture §9.1). The GIC is `Some` exactly when one was created.
pub fn create_vm_with(
    layout: &Layout,
    ram_end: u64,
    caps: &Capabilities,
    irqchip: IrqChip,
) -> Result<(Vm, Option<Gic>)> {
    match irqchip {
        IrqChip::InKernelGicV3 => create_vm(layout, ram_end, caps).map(|(vm, gic)| (vm, Some(gic))),
        IrqChip::None => {
            let bits = layout.ipa_bits_needed(ram_end);
            if bits > caps.max_ipa_bits {
                return Err(Error::Config(format!(
                    "the machine needs a {bits}-bit IPA space; this host supports {}",
                    caps.max_ipa_bits
                )));
            }
            let (vm, _) = VmBuilder::new()
                .ipa_bits(bits)
                .create()
                .map_err(|err| Error::Hv {
                    op: "create VM",
                    err,
                })?;
            Ok((vm, None))
        }
    }
}

/// The in-kernel GIC as the framework reports it (the inputs of [`check_gic_facts`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GicFacts {
    pub distributor_size: u64,
    pub redistributor_size: u64,
    /// `hv_gic_get_spi_interrupt_range`, half-open.
    pub spi: Range<u32>,
    /// `hv_gic_get_intid(HV_GIC_INT_EL1_VIRTUAL_TIMER)`.
    pub vtimer: u32,
    /// `hv_gic_get_intid(HV_GIC_INT_EL1_PHYSICAL_TIMER)`.
    pub ptimer: u32,
}

impl GicFacts {
    /// Ask the live framework.
    pub fn query(gic: &Gic) -> Result<GicFacts> {
        let hv = |err| Error::Hv {
            op: "query the in-kernel GIC",
            err,
        };
        let size = |r: core::result::Result<usize, CallError>| {
            r.map_err(hv).map(|v| u64::try_from(v).unwrap_or(u64::MAX))
        };
        Ok(GicFacts {
            distributor_size: size(gic.distributor_size())?,
            redistributor_size: size(gic.redistributor_size())?,
            spi: gic.spi_range().map_err(hv)?,
            vtimer: gic.intid(GicInterrupt::El1VirtualTimer).map_err(hv)?,
            ptimer: gic.intid(GicInterrupt::El1PhysicalTimer).map_err(hv)?,
        })
    }
}

/// The EL1 virtual timer PPI the DT `timer` node and the guests assume (PLAN §1).
pub const EXPECTED_VTIMER_INTID: u32 = 27;
/// The EL1 physical timer PPI (PLAN §1).
pub const EXPECTED_PTIMER_INTID: u32 = 30;

/// Every SPI INTID the `virt` layout wires: each region's line and the 32 virtio-mmio slots.
pub fn layout_spis(layout: &Layout) -> Vec<u32> {
    let mut v: Vec<u32> = layout.regions.iter().filter_map(|r| r.intid).collect();
    v.extend((0..VIRTIO_MMIO_SLOTS).filter_map(|i| layout.virtio_slot(i).map(|(_, intid)| intid)));
    v
}

// ANCHOR: gic_create_checks
/// The startup assertions of architecture §9 (module docs). Each failure names the value the
/// framework reported and the one macvmm needs.
pub fn check_gic_facts(f: &GicFacts, layout: &Layout) -> Result<()> {
    let mismatch = |what: &str, got: String, want: String| {
        Err(Error::Config(format!(
            "in-kernel GIC: {what} is {got}, but macvmm's machine layout needs {want}"
        )))
    };
    if f.distributor_size != GICD_SIZE {
        return mismatch(
            "the distributor size",
            format!("{:#x}", f.distributor_size),
            format!("{GICD_SIZE:#x}"),
        );
    }
    if f.redistributor_size != GICR_FRAME_SIZE {
        return mismatch(
            "the per-vCPU redistributor size",
            format!("{:#x}", f.redistributor_size),
            format!("{GICR_FRAME_SIZE:#x}"),
        );
    }
    if let Some(intid) = layout_spis(layout).into_iter().find(|i| !f.spi.contains(i)) {
        return mismatch(
            "the SPI range",
            format!("{}..{}", f.spi.start, f.spi.end),
            format!("one containing INTID {intid}"),
        );
    }
    if f.vtimer != EXPECTED_VTIMER_INTID {
        return mismatch(
            "the EL1 virtual timer INTID",
            f.vtimer.to_string(),
            EXPECTED_VTIMER_INTID.to_string(),
        );
    }
    if f.ptimer != EXPECTED_PTIMER_INTID {
        return mismatch(
            "the EL1 physical timer INTID",
            f.ptimer.to_string(),
            EXPECTED_PTIMER_INTID.to_string(),
        );
    }
    Ok(())
}

/// [`check_gic_facts`] on the live GIC (`Machine::build`, `hvf_gic_live`).
pub fn check_gic(gic: &Gic, layout: &Layout) -> Result<()> {
    check_gic_facts(&GicFacts::query(gic)?, layout)
}
// ANCHOR_END: gic_create_checks

/// The IPA width [`create_vm`] will request for this RAM end.
pub fn ipa_bits(layout: &Layout, ram_end: u64) -> u32 {
    layout.ipa_bits_needed(ram_end)
}

/// Keep the first error of a sequence of framework calls.
fn first_err(acc: &mut Option<CallError>, r: core::result::Result<(), CallError>) {
    if let Err(e) = r
        && acc.is_none()
    {
        *acc = Some(e);
    }
}

/// Tear the machine's memory and VM down in the MEM-9/MEM-11 order (module docs). Returns `Ok`
/// only if every block was freed.
///
/// `_gic` is taken only so the caller gives the token up. It is inert: `hv_gic.h` has no
/// destroy call, the in-kernel GIC dies with the VM in `hv_vm_destroy`, and `Vm::destroy`
/// retires the generation the token checks, so §14.5's "`Gic` before `Vm`" step needs no code.
/// The token itself is dropped when this function returns, after the VM.
pub fn teardown(
    vm: Vm,
    _gic: Option<Gic>,
    ram: Arc<GuestRam>,
    rom: Option<RomRegion>,
) -> Result<()> {
    let ram = match Arc::try_unwrap(ram) {
        Ok(ram) => ram,
        Err(still_shared) => {
            // A worker or vCPU thread still holds guest memory (MEM-9): never free it. Its
            // `Drop` will leak, because `mark_leak` is sticky.
            still_shared.mark_leak();
            if let Some(rom) = rom {
                let _ = rom.release(false);
            }
            let _ = vm.destroy();
            return Err(Error::Internal(
                "guest RAM still shared at teardown (MEM-9); leaked",
            ));
        }
    };
    let mut failed = None;
    first_err(&mut failed, ram.unmap(&vm));
    if let Some(rom) = &rom {
        first_err(&mut failed, rom.unmap(&vm));
    }
    let unmap_ok = failed.is_none();
    let destroyed = vm.destroy();
    let destroy_ok = destroyed.is_ok();
    first_err(&mut failed, destroyed);
    let gone = unmap_ok && destroy_ok;
    let mut action = ram.release(gone);
    if let Some(rom) = rom
        && rom.release(gone) == TeardownAction::Leak
    {
        action = TeardownAction::Leak;
    }
    match (failed, action) {
        (Some(err), _) => Err(Error::Hv {
            op: "teardown",
            err,
        }),
        (None, TeardownAction::Deallocate) => Ok(()),
        (None, TeardownAction::Leak) => Err(Error::Internal(
            "guest memory leaked although teardown succeeded",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A way to break one fact, and the message that must name both values.
    type Case = (fn(&mut GicFacts), &'static str);

    fn m5() -> GicFacts {
        GicFacts {
            distributor_size: 0x1_0000,
            redistributor_size: 0x2_0000,
            spi: 32..1020,
            vtimer: 27,
            ptimer: 30,
        }
    }

    /// The startup assertions accept the M5 Pro's GIC and name both values on a mismatch.
    #[test]
    fn gic_checks_name_both_values() {
        let l = Layout::virt();
        check_gic_facts(&m5(), l).unwrap();
        let cases: [Case; 5] = [
            (
                |f| f.distributor_size = 0x2_0000,
                "is 0x20000, but macvmm's machine layout needs 0x10000",
            ),
            (
                |f| f.redistributor_size = 0x4_0000,
                "is 0x40000, but macvmm's machine layout needs 0x20000",
            ),
            (
                |f| f.spi = 32..64,
                "is 32..64, but macvmm's machine layout needs one containing INTID 64",
            ),
            (
                |f| f.vtimer = 28,
                "virtual timer INTID is 28, but macvmm's machine layout needs 27",
            ),
            (
                |f| f.ptimer = 29,
                "physical timer INTID is 29, but macvmm's machine layout needs 30",
            ),
        ];
        for (break_it, want) in cases {
            let mut f = m5();
            break_it(&mut f);
            let e = check_gic_facts(&f, l).unwrap_err().to_string();
            assert!(e.contains(want), "{e}");
        }
        let spis = layout_spis(l);
        assert!(spis.contains(&33) && spis.contains(&34) && spis.contains(&79));
    }
}
