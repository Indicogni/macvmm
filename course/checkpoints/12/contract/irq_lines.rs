// Checkpoint 12 contract (PLAN M27 L1), frozen from the reference test crates/vmm/tests/irq_lines.rs.
// It names only items the chapter 12 lesson teaches; the harness runs it against your crates.
//! Host test `irq_lines` (PLAN M8 "Acceptance: host" and "Security tests"; architecture §6.3;
//! threat model §10.2 M8).
//!
//! 1. `GicSpi::new` refuses an INTID outside the GIC's SPI range or inside the MSI block, with
//!    a fake range provider (no HVF needed);
//! 2. a failing `hv_gic_set_spi` (a fake backend) is never fatal and is logged once per line;
//! 3. the PL011's level, driven through a `GicSpi` on a recording backend, rises with input,
//!    drops when the guest drains the RX FIFO, and drops when `IMSC` masks it, exactly what the
//!    `irq` guest relies on (IAR1 → drain → EOIR, ARM DDI 0183G §3.3.10-12).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use vmm::arch::layout::{GIC_V2M_INTIDS, PL011_INTID, PL031_INTID, VIRTIO_FIRST_INTID};
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SerialInput, Sink};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl011::{DR, IMSC, MIS, Pl011, int};
use vmm::irq::{GicSpi, IrqLine, SpiBackend, SpiError, SpiLimits};

/// Records every `set_spi` call; optionally fails them all.
#[derive(Clone, Default)]
struct FakeGic {
    calls: Arc<Mutex<Vec<(u32, bool)>>>,
    fail: bool,
}

impl SpiBackend for FakeGic {
    fn set_spi(&self, intid: u32, level: bool) -> Result<(), hvf::CallError> {
        self.calls.lock().unwrap().push((intid, level));
        if self.fail {
            Err(hvf::CallError {
                call: "hv_gic_set_spi",
                error: hvf::HvError::BadArgument,
            })
        } else {
            Ok(())
        }
    }
}

impl FakeGic {
    fn levels(&self) -> Vec<bool> {
        self.calls.lock().unwrap().iter().map(|c| c.1).collect()
    }
    fn last(&self) -> Option<bool> {
        self.calls.lock().unwrap().last().map(|c| c.1)
    }
}

/// The M5 Pro's GIC (spike finding 15) and the board's MSI block.
fn m5_limits() -> SpiLimits {
    SpiLimits {
        spi: 32..1020,
        msi: Some(GIC_V2M_INTIDS),
    }
}

#[test]
fn gic_spi_validates_its_intid() {
    let l = m5_limits();
    for ok in [
        32,
        PL011_INTID,
        PL031_INTID,
        VIRTIO_FIRST_INTID,
        79,
        144,
        1019,
    ] {
        let line = GicSpi::new(ok, &l, FakeGic::default()).unwrap();
        assert_eq!(line.intid(), ok);
    }
    for bad in [0, 15, 16, 27, 31, 1020, 1023, u32::MAX] {
        assert!(
            matches!(
                GicSpi::new(bad, &l, FakeGic::default()),
                Err(SpiError::NotAnSpi { .. })
            ),
            "{bad}"
        );
    }
    for msi in [80, 100, 143] {
        let e = GicSpi::new(msi, &l, FakeGic::default()).unwrap_err();
        assert!(matches!(e, SpiError::InMsiRange { .. }), "{msi}");
        assert!(e.to_string().contains("gic-v2m"), "{e}");
    }
    // A smaller (fake) framework range moves the bound, and no MSI block frees 80..143.
    let small = SpiLimits {
        spi: 32..64,
        msi: None,
    };
    assert!(GicSpi::new(63, &small, FakeGic::default()).is_ok());
    let e = GicSpi::new(64, &small, FakeGic::default()).unwrap_err();
    assert_eq!(
        e.to_string(),
        "INTID 64 is not an SPI the GIC implements (32..64)"
    );
    assert!(
        GicSpi::new(
            80,
            &SpiLimits {
                spi: 32..1020,
                msi: None
            },
            FakeGic::default()
        )
        .is_ok()
    );
    // An empty or inverted range rejects everything.
    let empty = SpiLimits {
        spi: 40..40,
        msi: None,
    };
    assert!(GicSpi::new(40, &empty, FakeGic::default()).is_err());
}

#[test]
fn set_spi_failure_is_never_fatal() {
    let gic = FakeGic {
        fail: true,
        ..FakeGic::default()
    };
    let line = GicSpi::new(PL011_INTID, &m5_limits(), gic.clone()).unwrap();
    for i in 0..10_000u32 {
        line.set_level(i % 2 == 0); // a guest toggling the line: no panic, no error out
    }
    assert_eq!(
        gic.calls.lock().unwrap().len(),
        10_000,
        "every call still tried"
    );
    assert!(gic.calls.lock().unwrap().iter().all(|c| c.0 == PL011_INTID));
}

struct Rig {
    uart: Arc<Mutex<Pl011>>,
    input: Arc<SerialInput>,
    gic: FakeGic,
}

fn rig() -> Rig {
    let sink = Arc::new(Sink::new(
        "t",
        Box::new(std::io::sink()),
        FilterPolicy::Safe,
    ));
    let input = Arc::new(SerialInput::new());
    let gic = FakeGic::default();
    let line: Arc<dyn IrqLine> =
        Arc::new(GicSpi::new(PL011_INTID, &m5_limits(), gic.clone()).unwrap());
    let uart = Arc::new(Mutex::new(Pl011::new(sink, Some(Arc::clone(&input)), line)));
    let weak = Arc::downgrade(&uart);
    input.set_hook(Some(Arc::new(move || {
        if let Some(u) = weak.upgrade() {
            u.lock().unwrap().input_ready();
        }
    })));
    Rig { uart, input, gic }
}

impl Rig {
    fn read(&self, off: u64) -> u64 {
        self.uart.lock().unwrap().read(off, AccessSize::B4)
    }
    fn write(&self, off: u64, v: u64) {
        self.uart.lock().unwrap().write(off, AccessSize::B4, v);
    }
}

/// The `irq` guest's sequence, through the real `GicSpi` and PL011: the level drops when the
/// RX FIFO drains.
#[test]
fn pl011_level_drops_when_rx_drains() {
    let r = rig();
    assert_eq!(r.gic.last(), Some(false), "reset drives the line low");
    r.write(IMSC, u64::from(int::RX | int::RT));
    assert_eq!(r.gic.last(), Some(false), "nothing received yet");
    for byte in *b"abc" {
        assert_eq!(r.input.push(&[byte]), 1);
        assert_eq!(r.gic.last(), Some(true), "input raises INTID 33");
        assert_eq!(r.read(MIS) & u64::from(int::RX), u64::from(int::RX));
        // The handler: drain until the line drops.
        assert_eq!(r.read(DR), u64::from(byte));
        assert_eq!(
            r.gic.last(),
            Some(false),
            "drained: the line drops before EOI"
        );
    }
    // Two bytes queued: the line stays up until the second is read.
    r.input.push(b"xy");
    assert_eq!(r.read(DR), u64::from(b'x'));
    assert_eq!(r.gic.last(), Some(true));
    assert_eq!(r.read(DR), u64::from(b'y'));
    assert_eq!(r.gic.last(), Some(false));
    let levels = r.gic.levels();
    assert!(levels.windows(2).any(|w| w == [true, false]));
}

/// The level also drops when the guest masks the source in `IMSC`, and comes back on unmask.
#[test]
fn pl011_level_drops_when_imsc_masks() {
    let r = rig();
    r.write(IMSC, u64::from(int::RX));
    r.input.push(b"z");
    assert_eq!(r.gic.last(), Some(true));
    r.write(IMSC, 0);
    assert_eq!(r.gic.last(), Some(false), "masked");
    r.write(IMSC, u64::from(int::RT));
    assert_eq!(
        r.gic.last(),
        Some(true),
        "RT also reflects a non-empty FIFO"
    );
    r.write(IMSC, u64::from(int::TX)); // TX latched by no write yet: still low
    assert_eq!(r.gic.last(), Some(false));
    assert_eq!(r.read(DR), u64::from(b'z'));
    assert_eq!(r.gic.last(), Some(false));
}
