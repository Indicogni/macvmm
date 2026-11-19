//! Text output for test guests: `core::fmt::Write` over a selectable byte backend.
//!
//! **Backends.** [`Backend::Hvc`] (the default) sends each byte with DEBUG_PUTC (`hvc.rs`);
//! it needs nothing from the VMM but the hypercall. [`Backend::Pl011`] writes the PL011 data
//! register (ARM PrimeCell UART PL011 TRM, DDI 0183, §3.3.1 `UARTDR` and §3.3.3 `UARTFR`),
//! which the VMM emulates since M6 (`uart::enable_console` selects it and enables the FIFOs).
//! Either way the VMM passes the bytes through its `AnsiFilter` before they reach a terminal.
//!
//! **Why an `AtomicU8` for the selection.** Statics need interior mutability, and the
//! alternative (`static mut`) needs `unsafe` at every use. A *relaxed* atomic load or store
//! compiles to a plain `ldrb`/`strb`, which is fine on Device memory with the MMU off;
//! read-modify-write atomics (exclusives) would not be, and none are used.

use core::fmt;
use core::sync::atomic::{AtomicU8, Ordering};

/// Where console bytes go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Backend {
    /// DEBUG_PUTC hypercalls (default).
    Hvc = 0,
    /// The PL011 at the `virt` UART0 address (M6).
    Pl011 = 1,
}

static BACKEND: AtomicU8 = AtomicU8::new(Backend::Hvc as u8);

/// PL011 UART0 in the QEMU `virt` map (PLAN §1).
const PL011_BASE: usize = 0x0900_0000;
/// `UARTFR` offset and its TX-FIFO-full bit.
const PL011_FR: usize = 0x18;
const PL011_FR_TXFF: u32 = 1 << 5;

/// Choose the console backend for all later output.
pub fn set_backend(b: Backend) {
    BACKEND.store(b as u8, Ordering::Relaxed);
}

fn pl011_putc(byte: u8) {
    let dr = PL011_BASE as *mut u32;
    let fr = (PL011_BASE + PL011_FR) as *const u32;
    // SAFETY: the VMM maps no RAM here; these are 32-bit aligned MMIO accesses to the
    // emulated UART, which has no side effects on guest memory.
    unsafe {
        while core::ptr::read_volatile(fr) & PL011_FR_TXFF != 0 {}
        core::ptr::write_volatile(dr, u32::from(byte));
    }
}

/// Write one byte to the current backend.
pub fn putc(byte: u8) {
    if BACKEND.load(Ordering::Relaxed) == Backend::Pl011 as u8 {
        pl011_putc(byte);
    } else {
        crate::hvc::debug_putc(byte);
    }
}

/// The console as a `core::fmt::Write` sink.
pub struct Console;

impl fmt::Write for Console {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        for b in s.bytes() {
            putc(b);
        }
        Ok(())
    }
}

/// Used by the `print!` macros.
pub fn print_fmt(args: fmt::Arguments<'_>) {
    let _ = fmt::Write::write_fmt(&mut Console, args);
}

/// Print to the guest console.
#[macro_export]
macro_rules! print {
    ($($arg:tt)*) => { $crate::console::print_fmt(format_args!($($arg)*)) };
}

/// Print a line to the guest console.
#[macro_export]
macro_rules! println {
    () => { $crate::console::putc(b'\n') };
    ($($arg:tt)*) => {{
        $crate::console::print_fmt(format_args!($($arg)*));
        $crate::console::putc(b'\n');
    }};
}
