//! A polled PL011 driver for test guests, and the PL031 clock (course ch09; PLAN M6).
//!
//! **Polled, not interrupt-driven.** A test guest has no GIC driver (that is ch11/ch12), so it
//! talks to the UART the way early boot code does: spin on the flag register, then touch the
//! data register (ARM PrimeCell UART PL011 TRM, ARM DDI 0183G, §3.3.1 `UARTDR`, §3.3.3
//! `UARTFR`). Every one of these accesses is a stage-2 fault the VMM emulates (`devices/pl011.rs`
//! in the VMM), so a polling loop costs one exit per iteration; that is fine for a test.
//!
//! - [`enable_console`] switches `print!`/`println!` from DEBUG_PUTC to the PL011;
//! - [`getc`] / [`read_line`] receive what the host typed (macvmm's stdin thread feeds the
//!   UART's RX FIFO);
//! - [`rtc_seconds`] reads the PL031 `RTCDR` (ARM DDI 0224B §3.3.1) and [`year_of`] turns it
//!   into a calendar year.
//!
//! The accesses are 32-bit `ldr`/`str w` to naturally aligned registers: single-register
//! loads and stores give the VMM a valid syndrome (ISV = 1), so it never has to decode the
//! instruction (architecture §8.3).

use crate::console::{self, Backend};

/// PL011 UART0 and PL031 RTC in the QEMU `virt` map (PLAN §1).
pub const PL011_BASE: usize = 0x0900_0000;
pub const PL031_BASE: usize = 0x0901_0000;

const DR: usize = 0x000;
const FR: usize = 0x018;
const LCR_H: usize = 0x02c;
const FR_RXFE: u32 = 1 << 4;
const FR_TXFF: u32 = 1 << 5;
const LCR_H_FEN: u32 = 1 << 4;
const LCR_H_WLEN8: u32 = 3 << 5;

fn read(base: usize, off: usize) -> u32 {
    // SAFETY: an aligned 32-bit load from an emulated device register; the VMM maps no RAM
    // there, so this has no effect on guest memory.
    unsafe { core::ptr::read_volatile((base + off) as *const u32) }
}

fn write(base: usize, off: usize, v: u32) {
    // SAFETY: an aligned 32-bit store to an emulated device register (as above).
    unsafe { core::ptr::write_volatile((base + off) as *mut u32, v) }
}

/// Enable the FIFOs and 8-bit words (TRM §3.3.7), then send all console output through the
/// PL011 instead of DEBUG_PUTC.
pub fn enable_console() {
    write(PL011_BASE, LCR_H, LCR_H_FEN | LCR_H_WLEN8);
    console::set_backend(Backend::Pl011);
}

/// Transmit one byte (waits while the TX FIFO is full; macvmm's never is).
pub fn putc(byte: u8) {
    while read(PL011_BASE, FR) & FR_TXFF != 0 {}
    write(PL011_BASE, DR, u32::from(byte));
}

/// One received byte, if the RX FIFO has one.
pub fn getc() -> Option<u8> {
    if read(PL011_BASE, FR) & FR_RXFE != 0 {
        None
    } else {
        Some((read(PL011_BASE, DR) & 0xff) as u8)
    }
}

/// Poll until a byte arrives.
pub fn getc_blocking() -> u8 {
    loop {
        if let Some(b) = getc() {
            return b;
        }
        core::hint::spin_loop();
    }
}

/// Read one line (up to CR or LF) into `buf`, without the terminator; bytes past the buffer
/// are dropped. Returns the line's length.
pub fn read_line(buf: &mut [u8]) -> usize {
    let mut n = 0;
    loop {
        let b = getc_blocking();
        if b == b'\n' || b == b'\r' {
            return n;
        }
        if let Some(slot) = buf.get_mut(n) {
            *slot = b;
            n += 1;
        }
    }
}

/// The PL031's `RTCDR`: seconds since the Unix epoch, as the VMM reports them.
pub fn rtc_seconds() -> u32 {
    read(PL031_BASE, DR)
}

/// The Gregorian year of `secs` seconds after 1970-01-01 (H. Hinnant's `civil_from_days`
/// algorithm, valid for every u32 input).
pub fn year_of(secs: u32) -> u32 {
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    year as u32
}
