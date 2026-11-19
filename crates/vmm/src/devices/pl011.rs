//! `Pl011`: the ARM PrimeCell UART (PL011) at `0x0900_0000`, the machine's serial console
//! (architecture §10; course ch09; threat model MMIO-8, MMIO-9, TTY-1, SINK-1).
//!
//! **Why this UART.** QEMU's `virt` board has one, so stock kernels and firmware find their
//! console without a driver of ours: Linux's `amba-pl011` driver and `earlycon=pl011,...`,
//! U-Boot's `serial_pl01x`, EDK2's `PL011UartLib`. The register map and bit names below are
//! from the *ARM PrimeCell UART (PL011) Technical Reference Manual*, ARM DDI 0183G, §3.2
//! (summary table) and §3.3 (one subsection per register); the identification values match
//! what QEMU's `hw/char/pl011.c` returns for the ARM variant, which is what Linux's AMBA bus
//! matches on (`0x00041011`).
//!
//! | Offset | Register | Model |
//! |---|---|---|
//! | 0x000 | `UARTDR` (§3.3.1) | write: transmit one byte; read: pop the RX FIFO |
//! | 0x004 | `UARTRSR/ECR` (§3.3.2) | reads 0 (no line errors); writes clear (nothing to clear) |
//! | 0x018 | `UARTFR` (§3.3.3) | `TXFE` always 1 (transmission is instant); `RXFE`/`RXFF` from the FIFO; reset `0x90` |
//! | 0x020 | `UARTILPR` (§3.3.4) | stored, no effect |
//! | 0x024/0x028 | `UARTIBRD`/`UARTFBRD` (§3.3.5-6) | stored (the baud rate means nothing here) |
//! | 0x02c | `UARTLCR_H` (§3.3.7) | stored; `FEN` (bit 4) selects a 32-byte FIFO, else a 1-byte holding register |
//! | 0x030 | `UARTCR` (§3.3.8) | stored, reset `0x300` (TXE, RXE); enables are not enforced (as in QEMU) |
//! | 0x034 | `UARTIFLS` (§3.3.9) | stored, reset `0x12` |
//! | 0x038 | `UARTIMSC` (§3.3.10) | the interrupt mask (bits 0-10) |
//! | 0x03c | `UARTRIS` (§3.3.11) | raw status: `TXRIS` (bit 5) and `RXRIS`/`RTRIS` (bits 4, 6) |
//! | 0x040 | `UARTMIS` (§3.3.12) | `RIS & IMSC` |
//! | 0x044 | `UARTICR` (§3.3.13) | write 1 to clear a raw status bit |
//! | 0x048 | `UARTDMACR` (§3.3.14) | stored (no DMA) |
//! | 0xfe0-0xfec | `UARTPeriphID0-3` (§3.3.15-18) | `11 10 14 00` |
//! | 0xff0-0xffc | `UARTPCellID0-3` (§3.3.19-22) | `0d f0 05 b1` |
//!
//! **Transmit (SINK-1, TTY-1).** A `DR` write hands the byte to the serial [`Sink`]: it passes
//! the sink's `AnsiFilter` and joins the sink's bounded queue; a writer thread does the
//! `write(2)`. The vCPU never blocks on host output (it waits at most `SINK_FULL_WAIT` for queue
//! space, the only bounded wait allowed under a device mutex). Transmission is instant, so
//! `FR.TXFE` stays 1 and `FR.TXFF` 0, and `RIS.TX` is set on every write, as QEMU does.
//!
//! **Receive (TTY-10, MMIO-9).** Host input waits in the shared [`SerialInput`] (4 KiB). The
//! FIFO here holds 32 bytes with `LCR_H.FEN` set, else 1 (§2.4.3 of the TRM: with the FIFOs
//! disabled they act as one-byte holding registers). It is refilled from `SerialInput` whenever
//! a byte is popped and whenever the stdin thread pushes (the push hook calls
//! [`Pl011::input_ready`]); a byte that does not fit stays in `SerialInput`. `RIS.RX` and
//! `RIS.RT` are set while the FIFO is non-empty: a simplification of the trigger level and the
//! 32-bit-period receive timeout that makes the line level-correct for every driver (Linux
//! reads until `RXFE`, then the line drops).
//!
//! **Interrupt (architecture §6.3).** After every register access and every input push the
//! device drives its line to `(RIS & IMSC) != 0` ([`Pl011::update_irq`]). M6 wires it to a
//! `NullIrq`; M8 to the in-kernel GIC's SPI 1 (INTID 33).
//!
//! **Total over the window (MMIO-8).** Every `(offset, size)` the bus can pass gets an answer:
//! 8-, 16- and 32-bit accesses at a 4-byte-aligned offset reach the register (earlycon uses
//! 8-bit accesses `[U]`; a narrow read returns the low bits, a narrow write zero-extends);
//! 64-bit accesses, misaligned offsets and offsets that name no register are read-as-zero /
//! write-ignored with a rate-limited `guest_warn!`.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::backend::serial::{SerialInput, Sink, SinkHandle};
use crate::bus::{AccessSize, MmioDevice};
use crate::irq::IrqLine;
use std::collections::VecDeque;
use std::sync::Arc;

/// The window size (architecture §5.1 `pl011` row).
pub const PL011_SIZE: u64 = 0x1000;
/// RX FIFO depth with `LCR_H.FEN` set (TRM §2.4.3; MMIO-9).
pub const PL011_FIFO_DEPTH: usize = 32;

pub const DR: u64 = 0x000;
pub const RSR: u64 = 0x004;
pub const FR: u64 = 0x018;
pub const ILPR: u64 = 0x020;
pub const IBRD: u64 = 0x024;
pub const FBRD: u64 = 0x028;
pub const LCR_H: u64 = 0x02c;
pub const CR: u64 = 0x030;
pub const IFLS: u64 = 0x034;
pub const IMSC: u64 = 0x038;
pub const RIS: u64 = 0x03c;
pub const MIS: u64 = 0x040;
pub const ICR: u64 = 0x044;
pub const DMACR: u64 = 0x048;
/// First identification register (`UARTPeriphID0`).
pub const ID_BASE: u64 = 0xfe0;

/// `UARTFR` bits (TRM §3.3.3).
pub mod fr {
    pub const BUSY: u32 = 1 << 3;
    pub const RXFE: u32 = 1 << 4;
    pub const TXFF: u32 = 1 << 5;
    pub const RXFF: u32 = 1 << 6;
    pub const TXFE: u32 = 1 << 7;
}

/// Interrupt bits, shared by `IMSC`, `RIS`, `MIS` and `ICR` (TRM §3.3.10-13).
pub mod int {
    pub const RX: u32 = 1 << 4;
    pub const TX: u32 = 1 << 5;
    pub const RT: u32 = 1 << 6;
    /// Every defined bit (`RIMIM` .. `OEIM`).
    pub const ALL: u32 = 0x7ff;
}

/// `UARTLCR_H.FEN`: enable the FIFOs.
pub const LCR_H_FEN: u32 = 1 << 4;
/// `UARTFR` after reset: both FIFOs empty.
pub const FR_RESET: u32 = fr::TXFE | fr::RXFE;
/// `UARTCR` after reset: transmit and receive enabled, UART disabled (TRM §3.3.8).
pub const CR_RESET: u32 = 0x300;
/// `UARTIFLS` after reset: both FIFO trigger levels at 1/2 (TRM §3.3.9).
pub const IFLS_RESET: u32 = 0x12;
/// `UARTPeriphID0-3`, `UARTPCellID0-3` (TRM §3.3.15-22; QEMU `pl011_id_arm`).
pub const ID_BYTES: [u8; 8] = [0x11, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];

/// The UART's state.
pub struct Pl011 {
    ilpr: u32,
    ibrd: u32,
    fbrd: u32,
    lcr_h: u32,
    cr: u32,
    ifls: u32,
    imsc: u32,
    dmacr: u32,
    /// The latched raw status bits that are not derived from the FIFO (only `TX` today).
    latched: u32,
    rx: VecDeque<u8>,
    sink: SinkHandle,
    input: Option<Arc<SerialInput>>,
    irq: Arc<dyn IrqLine>,
}

impl core::fmt::Debug for Pl011 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Pl011")
            .field("rx", &self.rx.len())
            .field("imsc", &self.imsc)
            .field("ris", &self.ris())
            .finish_non_exhaustive()
    }
}

impl Pl011 {
    /// A UART in its reset state that transmits to `sink`, receives from `input` (if any) and
    /// drives `irq`.
    pub fn new(sink: SinkHandle, input: Option<Arc<SerialInput>>, irq: Arc<dyn IrqLine>) -> Pl011 {
        let mut u = Pl011 {
            ilpr: 0,
            ibrd: 0,
            fbrd: 0,
            lcr_h: 0,
            cr: CR_RESET,
            ifls: IFLS_RESET,
            imsc: 0,
            dmacr: 0,
            latched: 0,
            rx: VecDeque::with_capacity(PL011_FIFO_DEPTH),
            sink,
            input,
            irq,
        };
        u.refill();
        u.update_irq();
        u
    }

    /// The RX FIFO depth the guest selected (`LCR_H.FEN`).
    fn depth(&self) -> usize {
        if self.lcr_h & LCR_H_FEN != 0 {
            PL011_FIFO_DEPTH
        } else {
            1
        }
    }

    /// Move bytes from `SerialInput` into the FIFO until it is full (lock order: this device's
    /// mutex is held, `SerialInput`'s is taken inside `pop`).
    fn refill(&mut self) {
        let Some(input) = &self.input else { return };
        while self.rx.len() < self.depth() {
            match input.pop() {
                Some(b) => self.rx.push_back(b),
                None => break,
            }
        }
    }

    /// The raw interrupt status (`UARTRIS`).
    pub fn ris(&self) -> u32 {
        let rx = if self.rx.is_empty() {
            0
        } else {
            int::RX | int::RT
        };
        (self.latched | rx) & int::ALL
    }

    fn fr(&self) -> u32 {
        let mut v = fr::TXFE;
        if self.rx.is_empty() {
            v |= fr::RXFE;
        }
        if self.rx.len() >= self.depth() {
            v |= fr::RXFF;
        }
        v
    }

    // ANCHOR: pl011_update_irq
    /// Drive the interrupt line to the OR of the masked status (`UARTMIS != 0`): a level, not
    /// an event, recomputed after every access and every input push (architecture §6.3).
    pub fn update_irq(&self) {
        self.irq.set_level(self.ris() & self.imsc != 0);
    }
    // ANCHOR_END: pl011_update_irq

    /// Host input arrived in `SerialInput` (the push hook): refill the FIFO and update the line.
    pub fn input_ready(&mut self) {
        self.refill();
        self.update_irq();
    }

    /// Bytes in the RX FIFO.
    pub fn rx_len(&self) -> usize {
        self.rx.len()
    }

    // ANCHOR: pl011_write_dr
    /// A guest store to `UARTDR`: transmit the low byte. It goes through the sink's terminal
    /// filter (TTY-1) onto the sink's bounded queue (SINK-1); `write(2)` happens on the sink's
    /// writer thread, never here. The transmit "completes" at once, so `RIS.TX` is set.
    fn write_dr(&mut self, value: u32) {
        let byte = u8::try_from(value & 0xff).unwrap_or(0); // 8 data bits; the rest ignored
        Sink::write_guest(&self.sink, &[byte]);
        self.latched |= int::TX;
    }
    // ANCHOR_END: pl011_write_dr

    /// A guest load from `UARTDR`: pop the FIFO (0 when empty), then refill it.
    fn read_dr(&mut self) -> u32 {
        let v = self.rx.pop_front().map_or(0, u32::from);
        self.refill();
        v
    }

    fn read_reg(&mut self, offset: u64) -> Option<u32> {
        Some(match offset {
            DR => self.read_dr(),
            RSR => 0,
            FR => self.fr(),
            ILPR => self.ilpr,
            IBRD => self.ibrd,
            FBRD => self.fbrd,
            LCR_H => self.lcr_h,
            CR => self.cr,
            IFLS => self.ifls,
            IMSC => self.imsc,
            RIS => self.ris(),
            MIS => self.ris() & self.imsc,
            ICR => 0, // write-only
            DMACR => self.dmacr,
            0xfe0..=0xffc => {
                let i = usize::try_from(offset.checked_sub(ID_BASE)? / 4).ok()?;
                u32::from(*ID_BYTES.get(i)?)
            }
            _ => return None,
        })
    }

    fn write_reg(&mut self, offset: u64, v: u32) -> bool {
        match offset {
            DR => self.write_dr(v),
            RSR => {} // clears the (always clear) error flags
            ILPR => self.ilpr = v & 0xff,
            IBRD => self.ibrd = v & 0xffff,
            FBRD => self.fbrd = v & 0x3f,
            LCR_H => {
                // Turning the FIFO off with bytes in it keeps them until they are read (FR
                // shows RXFF); no input is lost by a mode change.
                self.lcr_h = v & 0xff;
                self.refill();
            }
            CR => self.cr = v & 0xffff,
            IFLS => self.ifls = v & 0x3f,
            IMSC => self.imsc = v & int::ALL,
            ICR => self.latched &= !v,
            DMACR => self.dmacr = v & 0x7,
            FR | RIS | MIS | 0xfe0..=0xffc => {} // read-only
            _ => return false,
        }
        true
    }
}

/// The register an access names, if it is one this device answers: 4-byte aligned, at most
/// 32 bits wide.
fn reg_offset(offset: u64, size: AccessSize) -> Option<u64> {
    (offset.is_multiple_of(4) && size != AccessSize::B8 && offset < PL011_SIZE).then_some(offset)
}

impl MmioDevice for Pl011 {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        let v = reg_offset(offset, size).and_then(|o| self.read_reg(o));
        self.update_irq();
        match v {
            Some(v) => u64::from(v) & size.mask(),
            None => {
                crate::guest_warn!(
                    "pl011: {}-byte read at offset {offset:#x} names no register (read as zero)",
                    size.bytes()
                );
                0
            }
        }
    }

    fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
        // `value` holds the low `size` bytes; registers are 32 bits.
        let v = u32::try_from(value & size.mask() & 0xffff_ffff).unwrap_or(0);
        let ok = reg_offset(offset, size).is_some_and(|o| self.write_reg(o, v));
        self.update_irq();
        if !ok {
            crate::guest_warn!(
                "pl011: {}-byte write at offset {offset:#x} names no register (ignored)",
                size.bytes()
            );
        }
    }
}
