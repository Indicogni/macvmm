//! Interrupt lines: how a device tells the interrupt controller "I need attention"
//! (architecture §6.3; course ch09, frozen in ch11).
//!
//! **One wire per device, level-sensitive.** Every macvmm device interrupt is described in
//! the DTB as level-high (`<0 n 4>`, DT spec §2.4 and the GICv3 binding), which is what the
//! PL011 and PL031 TRMs specify: the line is the OR of the device's *masked* interrupt status
//! (PL011 `UARTMIS`, ARM DDI 0183G §3.3.12; PL031 `RTCMIS`, ARM DDI 0224 §3.3.7). So the device
//! model never "sends an interrupt". After every register access and every input event it
//! recomputes `(RIS & IMSC) != 0` and drives the line to that level ([`IrqLine::set_level`]);
//! the controller latches it, and the guest's handler clears the cause through the device's
//! clear register, which lowers the line again. Calling `set_level` with an unchanged level is
//! harmless (idempotent), so devices do not need to remember what they last drove.
//!
//! **Implementations.**
//! - [`NullIrq`]: a line connected to nothing. M6 wired the PL011 and PL031 to it; from M8 it
//!   is only used in the no-GIC teaching mode (`--irqchip none`, architecture §9.1), where the
//!   vCPU has one interrupt input (the timer) and device lines go nowhere;
//! - [`TestIrq`]: records each level *change*, for host tests;
//! - [`GicSpi`] (M8): `hv_gic_set_spi(intid, level)` on HVF's in-kernel GICv3, which is
//!   thread-safe and non-blocking `[V]` (spike finding 14), so it may be called with a device
//!   mutex held (architecture §14.2).
//!
//! **Why `GicSpi` validates its INTID up front** (threat model §10.2 M8). A wired device line is
//! a *Shared Peripheral Interrupt*: INTIDs 32..1019 in the GICv3 architecture (IHI 0069 §2.2,
//! "INTIDs"), of which the framework implements `hv_gic_get_spi_interrupt_range` (32 + 988 on
//! the M5 Pro). An INTID outside that range, or one the board reserves for MSIs (the GICv2m
//! block, INTIDs 80..143, PLAN §1), would be a wiring bug in macvmm; it is refused when the
//! machine is built ([`GicSpi::new`]), never discovered later as an `HV_BAD_ARGUMENT` on a
//! guest-triggered path. The range comes from a [`SpiLimits`], so host tests use a fake one.
//!
//! **A failing `hv_gic_set_spi` is never fatal.** The guest decides when a line moves (every
//! UART register access does), so an error there must not become a VMM crash or a log flood:
//! it is logged once per line (an `AtomicBool`) and otherwise ignored. The line then simply
//! does not reach the guest, which is a device that "lost" an interrupt, not a host failure.
//!
//! The trait is `Send + Sync` because a line is driven from vCPU threads (register accesses),
//! the stdin thread (input arrives) and, from M11, virtio worker threads.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::arch::layout::{GIC_V2M_INTIDS, IntidRange};
use crate::sync::lock;
use core::ops::Range;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

// ANCHOR: irq_line_trait
/// One level-sensitive interrupt line. Frozen: devices depend on exactly this.
pub trait IrqLine: Send + Sync {
    /// Drive the line. All macvmm device lines are level-sensitive: assert while the device
    /// condition holds, deassert when it clears. Idempotent.
    fn set_level(&self, high: bool);
}
// ANCHOR_END: irq_line_trait

/// A line connected to nothing (M6, and `--irqchip none` from M8).
#[derive(Clone, Copy, Debug, Default)]
pub struct NullIrq;

impl IrqLine for NullIrq {
    fn set_level(&self, _high: bool) {}
}

// ANCHOR: test_irq
/// A line that records its level changes, for host tests.
#[derive(Debug, Default)]
pub struct TestIrq {
    state: Mutex<TestIrqState>,
}

#[derive(Debug, Default)]
struct TestIrqState {
    level: bool,
    /// Each change of level, in order (`true` = raised).
    transitions: Vec<bool>,
    /// Every `set_level` call, changed or not.
    calls: u64,
}

impl TestIrq {
    pub fn new() -> TestIrq {
        TestIrq::default()
    }

    /// The current level.
    pub fn level(&self) -> bool {
        lock(&self.state).level
    }

    /// The level changes seen so far, oldest first.
    pub fn transitions(&self) -> Vec<bool> {
        lock(&self.state).transitions.clone()
    }

    /// Forget the recorded changes (the level is kept).
    pub fn clear(&self) {
        lock(&self.state).transitions.clear();
    }

    /// How many times `set_level` was called.
    pub fn calls(&self) -> u64 {
        lock(&self.state).calls
    }
}

impl IrqLine for TestIrq {
    fn set_level(&self, high: bool) {
        let mut s = lock(&self.state);
        s.calls = s.calls.saturating_add(1);
        if s.level != high {
            s.level = high;
            // Bounded in practice by the test; a device cannot call this without a test.
            s.transitions.push(high);
        }
    }
}
// ANCHOR_END: test_irq

// ANCHOR: spi_backend
/// Where a [`GicSpi`] sends its level: `hvf::GicHandle` on a real machine, a recorder in host
/// tests. `Send + Sync` because every [`IrqLine`] is.
pub trait SpiBackend: Send + Sync {
    /// `hv_gic_set_spi(intid, level)`.
    fn set_spi(&self, intid: u32, level: bool) -> Result<(), hvf::CallError>;
}

impl SpiBackend for hvf::GicHandle {
    fn set_spi(&self, intid: u32, level: bool) -> Result<(), hvf::CallError> {
        hvf::GicHandle::set_spi(self, intid, level)
    }
}
// ANCHOR_END: spi_backend

/// The INTIDs a wired line may use: the framework's SPI range minus the MSI block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpiLimits {
    /// `hv_gic_get_spi_interrupt_range` as a half-open range (`32..1020` on the M5 Pro).
    pub spi: Range<u32>,
    /// INTIDs reserved for MSIs (inclusive), which no wired line may take.
    pub msi: Option<IntidRange>,
}

/// Why [`GicSpi::new`] refused an INTID (a macvmm wiring bug, reported at build time).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpiError {
    /// Outside the framework's SPI range.
    NotAnSpi { intid: u32, spi: Range<u32> },
    /// Inside the MSI block.
    InMsiRange { intid: u32, msi: IntidRange },
}

impl core::fmt::Display for SpiError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SpiError::NotAnSpi { intid, spi } => write!(
                f,
                "INTID {intid} is not an SPI the GIC implements ({}..{})",
                spi.start, spi.end
            ),
            SpiError::InMsiRange { intid, msi } => write!(
                f,
                "INTID {intid} lies in the {} MSI block ({}..={})",
                msi.name, msi.first, msi.last
            ),
        }
    }
}

impl std::error::Error for SpiError {}

// ANCHOR: spi_limits_check
impl SpiLimits {
    /// The limits of the live in-kernel GIC: its SPI range, minus the board's GICv2m MSI block
    /// (the board reserves INTIDs 80..143 for MSIs whether or not a frame is configured).
    pub fn of(gic: &hvf::Gic) -> Result<SpiLimits, hvf::CallError> {
        Ok(SpiLimits {
            spi: gic.spi_range()?,
            msi: Some(GIC_V2M_INTIDS),
        })
    }

    /// Is `intid` a valid wired line?
    pub fn check(&self, intid: u32) -> Result<(), SpiError> {
        if !self.spi.contains(&intid) {
            return Err(SpiError::NotAnSpi {
                intid,
                spi: self.spi.clone(),
            });
        }
        if let Some(msi) = self.msi
            && msi.contains(intid)
        {
            return Err(SpiError::InMsiRange { intid, msi });
        }
        Ok(())
    }
}
// ANCHOR_END: spi_limits_check

// ANCHOR: gic_spi_set_level
/// A level-sensitive line wired to one SPI of the in-kernel GIC (`hv_gic_set_spi`, `hv_gic.h`).
pub struct GicSpi<B: SpiBackend = hvf::GicHandle> {
    intid: u32,
    backend: B,
    /// Set after the first `hv_gic_set_spi` failure, so it is logged once per line.
    failed: AtomicBool,
}

impl<B: SpiBackend> GicSpi<B> {
    /// Wire `intid` through `backend`, if `limits` allow it (module docs).
    pub fn new(intid: u32, limits: &SpiLimits, backend: B) -> Result<GicSpi<B>, SpiError> {
        limits.check(intid)?;
        Ok(GicSpi {
            intid,
            backend,
            failed: AtomicBool::new(false),
        })
    }

    /// The INTID this line drives.
    pub fn intid(&self) -> u32 {
        self.intid
    }
}

impl<B: SpiBackend> IrqLine for GicSpi<B> {
    /// `hv_gic_set_spi(intid, high)`. Non-blocking and callable with a device mutex held. An
    /// error is logged once for this line and otherwise ignored (module docs): never fatal.
    fn set_level(&self, high: bool) {
        if let Err(e) = self.backend.set_spi(self.intid, high)
            && !self.failed.swap(true, Ordering::Relaxed)
        {
            crate::guest_warn!(
                "interrupt line INTID {}: {e} (further errors on this line are not logged)",
                self.intid
            );
        }
    }
}
// ANCHOR_END: gic_spi_set_level

impl<B: SpiBackend> core::fmt::Debug for GicSpi<B> {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("GicSpi")
            .field("intid", &self.intid)
            .finish()
    }
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;

    struct Failing;
    impl SpiBackend for Failing {
        fn set_spi(&self, _: u32, _: bool) -> Result<(), hvf::CallError> {
            Err(hvf::CallError {
                call: "hv_gic_set_spi",
                error: hvf::HvError::BadArgument,
            })
        }
    }

    /// Security checklist M8: an `hv_gic_set_spi` failure is logged once per line.
    #[test]
    fn set_spi_failure_logged_once_per_line() {
        let limits = SpiLimits {
            spi: 32..1020,
            msi: Some(GIC_V2M_INTIDS),
        };
        let a = GicSpi::new(33, &limits, Failing).unwrap();
        let b = GicSpi::new(34, &limits, Failing).unwrap();
        crate::log::test_capture::start();
        for _ in 0..100 {
            a.set_level(true);
            b.set_level(false);
        }
        let lines = crate::log::test_capture::finish();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("INTID 33") && lines[1].contains("INTID 34"));
        assert!(format!("{a:?}").contains("33"));
    }

    #[test]
    fn test_irq_records_only_changes() {
        let irq = TestIrq::new();
        irq.set_level(false);
        irq.set_level(true);
        irq.set_level(true);
        irq.set_level(false);
        assert_eq!(irq.transitions(), vec![true, false]);
        assert_eq!(irq.calls(), 4);
        assert!(!irq.level());
        irq.clear();
        assert!(irq.transitions().is_empty());
        NullIrq.set_level(true);
    }
}
