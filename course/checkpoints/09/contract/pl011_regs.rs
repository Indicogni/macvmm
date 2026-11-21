// Checkpoint 09 contract, frozen from the reference test crates/vmm/tests/pl011_regs.rs.
// It names only items the chapter 09 lesson teaches; the harness runs it against your crates.
//! Host test: the PL011 register model (host acceptance; ARM DDI 0183G §3.3; threat model: docs/security/threat-model.md).
//!
//! The UART is driven exactly as the bus drives it (`MmioDevice::read`/`write` with an offset
//! and an access size), with an in-memory sink for TX, a real `SerialInput` (and its push
//! hook) for RX, and a `TestIrq` that records every level change of the interrupt line.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Write;
use std::sync::{Arc, Mutex};
use vmm::backend::ansi::FilterPolicy;
use vmm::backend::serial::{SERIAL_INPUT_CAP, SerialInput, Sink};
use vmm::bus::{AccessSize, MmioDevice};
use vmm::devices::pl011::{
    CR, DR, FR, ICR, IMSC, LCR_H, LCR_H_FEN, MIS, PL011_FIFO_DEPTH, PL011_SIZE, Pl011, RIS, fr, int,
};
use vmm::irq::TestIrq;

#[derive(Clone, Default)]
struct Out(Arc<Mutex<Vec<u8>>>);

impl Write for Out {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Rig {
    uart: Arc<Mutex<Pl011>>,
    out: Out,
    input: Arc<SerialInput>,
    irq: Arc<TestIrq>,
}

fn rig() -> Rig {
    let out = Out::default();
    let sink = Arc::new(Sink::new("t", Box::new(out.clone()), FilterPolicy::Safe));
    let input = Arc::new(SerialInput::new());
    let irq = Arc::new(TestIrq::new());
    let uart = Arc::new(Mutex::new(Pl011::new(
        sink,
        Some(Arc::clone(&input)),
        irq.clone(),
    )));
    // The production hook (machine/mod.rs): a push wakes the UART.
    let weak = Arc::downgrade(&uart);
    input.set_hook(Some(Arc::new(move || {
        if let Some(u) = weak.upgrade() {
            u.lock().unwrap().input_ready();
        }
    })));
    Rig {
        uart,
        out,
        input,
        irq,
    }
}

impl Rig {
    fn r(&self, off: u64) -> u64 {
        self.uart.lock().unwrap().read(off, AccessSize::B4)
    }
    fn w(&self, off: u64, v: u64) {
        self.uart.lock().unwrap().write(off, AccessSize::B4, v);
    }
}

#[test]
fn reset_state() {
    let r = rig();
    assert_eq!(r.r(FR), 0x90, "TXFE | RXFE");
    assert_eq!(r.r(CR), 0x300);
    assert_eq!(r.r(RIS), 0);
    assert_eq!(r.r(MIS), 0);
    assert_eq!(r.r(IMSC), 0);
    assert_eq!(r.r(DR), 0, "empty FIFO reads 0");
    assert!(!r.irq.level());
}

#[test]
fn dr_write_transmits_through_the_filter_and_sets_tx() {
    let r = rig();
    for b in b"hi\x1b[6n!\n" {
        r.w(DR, u64::from(*b) | 0xffff_ff00); // only the low 8 bits are data
    }
    assert_eq!(&*r.out.0.lock().unwrap(), b"hi!\n", "TTY-1: DSR dropped");
    assert_eq!(r.r(RIS) & u64::from(int::TX), u64::from(int::TX));
    assert_ne!(r.r(FR) & u64::from(fr::TXFE), 0, "TXFE stays 1");
    assert_eq!(r.r(FR) & u64::from(fr::TXFF | fr::BUSY), 0);
    // Masked TX: no line until IMSC.TX.
    assert!(!r.irq.level());
    r.w(IMSC, u64::from(int::TX));
    assert!(r.irq.level());
    assert_eq!(r.r(MIS), u64::from(int::TX));
    r.w(ICR, u64::from(int::TX));
    assert_eq!(r.r(RIS), 0);
    assert!(!r.irq.level());
    assert_eq!(r.irq.transitions(), vec![true, false]);
}

#[test]
fn rx_push_fills_the_fifo_and_drives_rx_rt() {
    let r = rig();
    r.w(IMSC, u64::from(int::RX | int::RT));
    r.irq.clear();
    assert_eq!(r.input.push(b"ok"), 2);
    // FEN = 0: a one-byte holding register; the second byte waits in SerialInput.
    assert_eq!(r.r(FR) & u64::from(fr::RXFE), 0);
    assert_ne!(r.r(FR) & u64::from(fr::RXFF), 0);
    let rx_rt = u64::from(int::RX | int::RT);
    assert_eq!(r.r(RIS) & rx_rt, rx_rt);
    assert_eq!(r.r(MIS), rx_rt);
    assert_eq!(r.input.len(), 1);
    assert_eq!(r.r(DR), u64::from(b'o'));
    assert_eq!(r.r(DR), u64::from(b'k'), "refilled from SerialInput on pop");
    assert_ne!(r.r(FR) & u64::from(fr::RXFE), 0);
    assert_eq!(r.r(RIS), 0);
    // Raised once at the first push, lowered once when drained.
    assert_eq!(r.irq.transitions(), vec![true, false]);
}

#[test]
fn icr_cannot_hide_a_non_empty_fifo() {
    let r = rig();
    r.w(IMSC, u64::from(int::RX));
    r.input.push(b"z");
    r.w(ICR, u64::from(int::ALL));
    // Level semantics: the condition still holds, so the line stays up until the FIFO drains.
    assert!(r.irq.level());
    assert_eq!(r.r(DR), u64::from(b'z'));
    assert!(!r.irq.level());
}

#[test]
fn fifo_of_32_and_the_33rd_byte_stays_in_serial_input() {
    let r = rig();
    r.w(LCR_H, u64::from(LCR_H_FEN));
    let bytes: Vec<u8> = (0..=PL011_FIFO_DEPTH as u8).collect(); // 33 bytes
    assert_eq!(r.input.push(&bytes), 33);
    assert_eq!(r.uart.lock().unwrap().rx_len(), PL011_FIFO_DEPTH);
    assert_eq!(r.input.len(), 1, "the 33rd byte waits in SerialInput");
    assert_ne!(r.r(FR) & u64::from(fr::RXFF), 0);
    for want in 0..=PL011_FIFO_DEPTH as u64 {
        assert_eq!(r.r(DR), want);
    }
    assert!(r.input.is_empty());
    assert_ne!(r.r(FR) & u64::from(fr::RXFE), 0);
}

#[test]
fn serial_input_is_bounded_at_4k_and_never_blocks() {
    let r = rig();
    let big = vec![b'a'; 3 * SERIAL_INPUT_CAP];
    let t0 = std::time::Instant::now();
    let accepted = r.input.push(&big);
    assert!(t0.elapsed() < std::time::Duration::from_millis(100));
    assert_eq!(accepted, SERIAL_INPUT_CAP);
    assert_eq!(r.input.dropped(), (2 * SERIAL_INPUT_CAP) as u64);
    // The push hook then moved one byte into the UART's holding register (FEN = 0).
    assert_eq!(r.input.len(), SERIAL_INPUT_CAP - 1);
    assert_eq!(r.uart.lock().unwrap().rx_len(), 1);
}

#[test]
fn identification_registers() {
    let r = rig();
    let want = [0x11u64, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];
    for (i, w) in want.iter().enumerate() {
        let off = 0xfe0 + 4 * i as u64;
        assert_eq!(r.r(off), *w, "offset {off:#x}");
        assert_eq!(
            r.uart.lock().unwrap().read(off, AccessSize::B1),
            *w,
            "8-bit"
        );
    }
    // Read-only: a write changes nothing.
    r.w(0xfe0, 0);
    assert_eq!(r.r(0xfe0), 0x11);
}

#[test]
fn narrow_accesses() {
    let r = rig();
    // earlycon-style 8-bit DR writes and FR reads.
    r.uart
        .lock()
        .unwrap()
        .write(DR, AccessSize::B1, u64::from(b'Q'));
    assert_eq!(r.uart.lock().unwrap().read(FR, AccessSize::B1), 0x90);
    assert_eq!(r.uart.lock().unwrap().read(FR, AccessSize::B2), 0x90);
    // 16-bit register writes zero-extend; reads return the low bits.
    r.uart.lock().unwrap().write(CR, AccessSize::B2, 0x0301);
    assert_eq!(r.r(CR), 0x301);
    assert_eq!(r.uart.lock().unwrap().read(CR, AccessSize::B1), 0x01);
    assert_eq!(&*r.out.0.lock().unwrap(), b"Q");
    // 64-bit and misaligned accesses are RAZ/WI (MMIO-8).
    r.uart.lock().unwrap().write(CR, AccessSize::B8, 0);
    assert_eq!(r.r(CR), 0x301);
    assert_eq!(r.uart.lock().unwrap().read(FR, AccessSize::B8), 0);
    assert_eq!(r.uart.lock().unwrap().read(FR + 1, AccessSize::B1), 0);
    r.uart
        .lock()
        .unwrap()
        .write(DR + 2, AccessSize::B1, u64::from(b'X'));
    assert_eq!(
        &*r.out.0.lock().unwrap(),
        b"Q",
        "misaligned DR write ignored"
    );
}

/// PLAN M6 security test (MMIO-8): every offset × every width inside the window, reads and
/// writes, never panics; afterwards the device still works.
#[test]
fn every_offset_and_width_is_total() {
    let r = rig();
    r.input.push(&[0x55; 64]);
    for size in [
        AccessSize::B1,
        AccessSize::B2,
        AccessSize::B4,
        AccessSize::B8,
    ] {
        let mut off = 0u64;
        while off + size.bytes() <= PL011_SIZE {
            let v = r.uart.lock().unwrap().read(off, size);
            assert_eq!(v & !size.mask(), 0, "read wider than the access");
            if off != DR {
                r.uart.lock().unwrap().write(off, size, u64::MAX);
            }
            off += 1;
        }
    }
    // Still a UART: reset the mask, transmit, receive.
    r.w(ICR, u64::MAX);
    r.w(DR, u64::from(b'k'));
    assert!(r.out.0.lock().unwrap().ends_with(b"k"));
}
