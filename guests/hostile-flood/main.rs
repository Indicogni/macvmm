//! `hostile-flood`: TEST-7 phase 8, an output flood into a capped file sink (threat model
//! §9.4, LOG-4, SINK-1; PLAN M11). Run with `--serial file:F,max=1M`.
//!
//! The guest writes 4 MiB of text to the PL011 data register as fast as it can (no FR polling:
//! macvmm's TX FIFO is never full), then powers off. The file sink must stop at **exactly**
//! 1 MiB with one warning: a guest decides how much it prints, the host decides how much disk
//! that may cost. The VM itself keeps running (the bytes past the cap are dropped and counted),
//! and exits 0.
#![no_std]
#![no_main]

use guest::hostile::mmio_write;
use guest::{psci, uart};

guest::entry!(main);

/// PL011 UARTDR (PLAN §1 base; TRM §3.3.1).
const UART_DR: u64 = 0x0900_0000;
/// 4 MiB, in lines of 64 bytes.
const TOTAL: usize = 4 << 20;
const LINE: &[u8; 64] = b"hostile-flood: 0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJK.\n";

fn main(_x0: u64) {
    uart::enable_console();
    for _ in 0..TOTAL / LINE.len() {
        for &b in LINE {
            mmio_write(UART_DR, 4, u64::from(b));
        }
    }
    psci::power_off()
}
