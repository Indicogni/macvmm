//! The QEMU-`virt`-compatible board (architecture §5.1, ADR-0003): what `Machine::build` puts
//! where. The addresses themselves live only in `arch/layout.rs` (the single source of truth);
//! this file says which of them a `virt` machine populates.
//!
//! **M3** populates only RAM: one region at `RAM_BASE` of `--mem` bytes. The in-kernel GIC is
//! created by `vm::create_vm`. Device registration ([`register_devices`]: the testdev in M4;
//! virtio-mmio slots from M11) is added here, one block per device, by the milestone that brings
//! it (PLAN §2.1: additive, block-local edits). The devices every machine has (M6: the PL011,
//! the PL031, the unused GIC redistributor frames) are [`register_platform`].
//!
//! **M11: virtio-mmio.** All 32 slots are on the bus ([`register_virtio`]); the populated
//! ones ([`virtio_populated`], none until M12) also get a DT node.
//!
//! **M8: interrupt lines.** With the in-kernel GIC, [`platform_irqs`] wires the PL011 to SPI 1
//! (INTID 33) and the PL031 to SPI 2 (INTID 34), each a validated `irq::GicSpi` built from the
//! live GIC's SPI range ([`register_platform_with`]). In the `--irqchip none` teaching mode
//! there is no controller, so both lines are `NullIrq` (architecture §9.1).

use crate::arch::layout::{
    GICR_BASE, GICR_WINDOW_END, Layout, PL011_BASE, PL011_INTID, PL031_BASE, PL031_INTID, RAM_BASE,
    TESTDEV_BASE,
};
use crate::backend::serial::{SerialInput, SinkHandle};
use crate::bus::Bus;
use crate::config::VmConfig;
use crate::devices::pl011::{PL011_SIZE, Pl011};
use crate::devices::pl031::{PL031_SIZE, Pl031};
use crate::devices::razwi::RazWi;
use crate::devices::testdev::{TESTDEV_SIZE, TestDev};
use crate::error::{Error, Result};
use crate::irq::{GicSpi, IrqLine, NullIrq, SpiLimits};
use crate::memory::GuestAddress;
use crate::virtio::VirtioMmio;
use crate::virtio::mmio::WINDOW_SIZE as VIRTIO_WINDOW;
use std::sync::{Arc, Mutex};

/// The RAM regions of a `virt` machine with `size` bytes of RAM (already validated by
/// `Layout::ram_end`).
pub fn ram_regions(size: u64) -> [(GuestAddress, u64); 1] {
    [(GuestAddress(RAM_BASE), size)]
}

/// Put the devices `cfg` asks for on `bus` (one block per device, PLAN §2.1).
pub fn register_devices(cfg: &VmConfig, bus: &mut Bus) -> Result<()> {
    // M4: the scratch-register test device, only with --testdev.
    if cfg.testdev {
        bus.insert(
            "testdev",
            TESTDEV_BASE,
            TESTDEV_SIZE,
            Arc::new(Mutex::new(TestDev::new())),
        )
        .map_err(Error::Bus)?;
    }
    Ok(())
}

// ANCHOR: virtio_slots
/// The populated virtio-mmio slots for `cfg`, in slot order (ADR-0005: `--disk` in CLI order,
/// then `--rng`, `--console`, `--net`). M11 brings the transport and no device, so every slot
/// is empty; M12+ add one block each here and in [`register_virtio`]. The DTB describes
/// exactly these slots (`fdt/machine.rs`).
pub fn virtio_populated(_cfg: &VmConfig) -> Vec<usize> {
    Vec::new()
}

/// Put all 32 virtio-mmio transports on `bus` (M11, architecture §11.1): a device in each
/// slot [`virtio_populated`] names (none yet), and an empty transport (`NullDevice`: Magic,
/// Version 2, DeviceID 0, the rest RAZ/WI) everywhere else, so firmware that probes every slot
/// gets the answer virtio 1.2 §4.2.3.1.1 defines instead of an unhandled-MMIO stop.
///
/// Empty slots hold no guest-memory handle and no interrupt line: they can never activate.
pub fn register_virtio(cfg: &VmConfig, bus: &mut Bus) -> Result<()> {
    let populated = virtio_populated(cfg);
    let layout = Layout::virt();
    for slot in 0..crate::arch::layout::VIRTIO_MMIO_SLOTS {
        let (base, _intid) = layout
            .virtio_slot(slot)
            .ok_or(Error::Internal("virtio slot outside the layout"))?;
        if populated.contains(&slot) {
            return Err(Error::Internal("no virtio device model exists yet (M12+)"));
        }
        bus.insert(
            "virtio-mmio",
            base,
            VIRTIO_WINDOW,
            Arc::new(Mutex::new(VirtioMmio::empty())),
        )
        .map_err(Error::Bus)?;
    }
    Ok(())
}
// ANCHOR_END: virtio_slots

/// The interrupt lines of the platform devices.
#[derive(Clone)]
pub struct PlatformIrqs {
    pub pl011: Arc<dyn IrqLine>,
    pub pl031: Arc<dyn IrqLine>,
}

impl PlatformIrqs {
    /// Lines connected to nothing (no-GIC mode, host tests).
    pub fn none() -> PlatformIrqs {
        PlatformIrqs {
            pl011: Arc::new(NullIrq),
            pl031: Arc::new(NullIrq),
        }
    }
}

// ANCHOR: pl011_irq_wiring
/// The platform lines for this boot: `GicSpi(33)` for the PL011 and `GicSpi(34)` for the PL031
/// on the in-kernel GIC (PLAN §1, each validated against the GIC's SPI range and the MSI block,
/// threat model §10.2 M8), or `NullIrq` without a GIC.
pub fn platform_irqs(gic: Option<&hvf::Gic>) -> Result<PlatformIrqs> {
    let Some(gic) = gic else {
        return Ok(PlatformIrqs::none());
    };
    let limits = SpiLimits::of(gic).map_err(|err| Error::Hv {
        op: "query the GIC's SPI range",
        err,
    })?;
    let line = |intid: u32| -> Result<Arc<dyn IrqLine>> {
        let spi = GicSpi::new(intid, &limits, gic.handle())
            .map_err(|e| Error::Config(format!("in-kernel GIC: {e}")))?;
        Ok(Arc::new(spi))
    };
    Ok(PlatformIrqs {
        pl011: line(PL011_INTID)?,
        pl031: line(PL031_INTID)?,
    })
}
// ANCHOR_END: pl011_irq_wiring

/// [`register_platform_with`] with both lines connected to nothing (M6 behaviour; host tests).
pub fn register_platform(
    bus: &mut Bus,
    serial: &SinkHandle,
    input: &Arc<SerialInput>,
    ncpus: u32,
) -> Result<Arc<Mutex<Pl011>>> {
    register_platform_with(bus, serial, input, ncpus, PlatformIrqs::none())
}

// ANCHOR: register_platform
/// Put the devices every `virt` machine has on `bus` (M6, architecture §5.1, §10):
/// - the PL011 UART0, transmitting to `serial` and receiving from `input`;
/// - the PL031 RTC;
/// - a RAZ/WI window over the part of the GIC redistributor window that `ncpus` vCPUs leave
///   unused (the in-kernel GIC implements one 128 KiB frame per vCPU).
///
/// Their interrupt lines are `irqs` ([`platform_irqs`]: the in-kernel GIC's SPI 1 and SPI 2
/// from M8). Returns the UART so the caller can connect `input`'s push hook to it.
pub fn register_platform_with(
    bus: &mut Bus,
    serial: &SinkHandle,
    input: &Arc<SerialInput>,
    ncpus: u32,
    irqs: PlatformIrqs,
) -> Result<Arc<Mutex<Pl011>>> {
    let uart = Arc::new(Mutex::new(Pl011::new(
        Arc::clone(serial),
        Some(Arc::clone(input)),
        irqs.pl011,
    )));
    bus.insert("pl011", PL011_BASE, PL011_SIZE, uart.clone())
        .map_err(Error::Bus)?;
    bus.insert(
        "pl031",
        PL031_BASE,
        PL031_SIZE,
        Arc::new(Mutex::new(Pl031::with_clock(
            crate::timer::pl031_time_base(),
            irqs.pl031,
        ))),
    )
    .map_err(Error::Bus)?;
    let frames = Layout::virt()
        .gicr_size(ncpus)
        .ok_or(Error::Internal("vCPU count outside 1..=MAX_CPUS"))?;
    let rest = GICR_BASE
        .checked_add(frames)
        .filter(|start| *start < GICR_WINDOW_END);
    if let Some(start) = rest {
        bus.insert(
            "gicr-unused",
            start,
            GICR_WINDOW_END.saturating_sub(start),
            Arc::new(Mutex::new(RazWi::new("gicr-unused"))),
        )
        .map_err(Error::Bus)?;
    }
    Ok(uart)
}
// ANCHOR_END: register_platform

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::layout::{Layout, RAM_DEFAULT};

    #[test]
    fn testdev_only_with_the_flag_and_inside_its_layout_row() {
        let mut bus = Bus::new();
        register_devices(&VmConfig::default(), &mut bus).unwrap();
        assert!(bus.is_empty());
        let cfg = VmConfig {
            testdev: true,
            ..VmConfig::default()
        };
        register_devices(&cfg, &mut bus).unwrap();
        assert_eq!(bus.device_at(TESTDEV_BASE), Some(("testdev", 0)));
        let row = Layout::virt().find(TESTDEV_BASE).unwrap();
        assert_eq!((row.name, row.size), ("testdev", TESTDEV_SIZE));
        // Registering twice is an overlap, a VMM bug reported as an error, never a panic.
        assert!(matches!(
            register_devices(&cfg, &mut bus),
            Err(Error::Bus(_))
        ));
    }

    #[test]
    fn platform_devices_sit_in_their_layout_rows() {
        use crate::backend::serial::Sink;
        let mut bus = Bus::new();
        let sink = Arc::new(Sink::none());
        let input = Arc::new(SerialInput::new());
        register_platform(&mut bus, &sink, &input, 1).unwrap();
        for (name, base, size) in [
            ("pl011", PL011_BASE, PL011_SIZE),
            ("pl031", PL031_BASE, PL031_SIZE),
        ] {
            assert_eq!(bus.device_at(base), Some((name, 0)));
            let row = Layout::virt().find(base).unwrap();
            assert_eq!((row.name, row.size), (name, size));
        }
        // The first redistributor frame is HVF's; the rest of the window is RAZ/WI.
        assert_eq!(bus.device_at(GICR_BASE), None);
        assert_eq!(
            bus.device_at(GICR_BASE + 0x2_0000),
            Some(("gicr-unused", 0))
        );
        assert_eq!(
            bus.device_at(GICR_WINDOW_END - 1).map(|d| d.0),
            Some("gicr-unused")
        );
        assert_eq!(
            bus.read(GICR_BASE + 0x3_0000, crate::bus::AccessSize::B4),
            Ok(0)
        );
        // FR after reset (PLAN M6: 0x90).
        assert_eq!(
            bus.read(PL011_BASE + 0x18, crate::bus::AccessSize::B4),
            Ok(0x90)
        );
        // With every frame in use, there is no remainder.
        let mut full = Bus::new();
        register_platform(&mut full, &sink, &input, crate::arch::layout::MAX_CPUS).unwrap();
        assert_eq!(
            full.len(),
            2 + usize::from(GICR_BASE + 64 * 0x2_0000 < GICR_WINDOW_END)
        );
        assert!(register_platform(&mut Bus::new(), &sink, &input, 0).is_err());
    }

    #[test]
    fn all_32_virtio_slots_answer_as_empty() {
        use crate::arch::layout::{VIRTIO_MMIO_BASE, VIRTIO_MMIO_SLOTS, VIRTIO_MMIO_STRIDE};
        use crate::bus::AccessSize;
        let mut bus = Bus::new();
        register_virtio(&VmConfig::default(), &mut bus).unwrap();
        assert_eq!(bus.len(), VIRTIO_MMIO_SLOTS);
        assert!(virtio_populated(&VmConfig::default()).is_empty());
        for i in 0..VIRTIO_MMIO_SLOTS as u64 {
            let base = VIRTIO_MMIO_BASE + i * VIRTIO_MMIO_STRIDE;
            assert_eq!(bus.device_at(base), Some(("virtio-mmio", 0)));
            assert_eq!(bus.read(base, AccessSize::B4), Ok(0x7472_6976));
            assert_eq!(bus.read(base + 4, AccessSize::B4), Ok(2));
            assert_eq!(bus.read(base + 8, AccessSize::B4), Ok(0));
            assert_eq!(bus.read(base + 0x1ff, AccessSize::B1), Ok(0));
        }
        let row = Layout::virt().find(VIRTIO_MMIO_BASE).unwrap();
        assert_eq!(row.size, VIRTIO_MMIO_SLOTS as u64 * VIRTIO_MMIO_STRIDE);
    }

    #[test]
    fn one_ram_region_at_the_layout_base() {
        let [(base, size)] = ram_regions(RAM_DEFAULT);
        assert_eq!(base, GuestAddress(RAM_BASE));
        assert_eq!(Layout::virt().ram_end(size), Ok(RAM_BASE + RAM_DEFAULT));
    }
}
