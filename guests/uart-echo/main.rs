//! `uart-echo`: the PL011 in both directions and the PL031 (course ch09, PLAN M6).
//!
//! 1. switch the console to the PL011 and print `uart-echo: ready`;
//! 2. read one line by polling the UART (the e2e test types `ping`);
//! 3. if the line is `ping`, print `pong`;
//! 4. read the PL031 `RTCDR`, turn the seconds into a year and print `uart-echo: rtc year=<Y>`
//!    (the test asserts Y ≥ 2025, which proves the RTC follows the host's wall clock);
//! 5. return, which powers off (exit code 0).
//!
//! Every byte goes through the VMM's MMIO path: TX is a store to `UARTDR`, RX is a poll of
//! `UARTFR.RXFE` and a load of `UARTDR`, all ISV = 1 data aborts emulated by `devices/pl011.rs`.
#![no_std]
#![no_main]

use guest::{println, uart};

guest::entry!(main);

fn main(_x0: u64) {
    uart::enable_console();
    println!("uart-echo: ready");
    let mut buf = [0u8; 64];
    let n = uart::read_line(&mut buf);
    let line = buf.get(..n).unwrap_or(&[]);
    if line == b"ping" {
        println!("pong");
    } else {
        println!("uart-echo: got a {}-byte line, not ping", n);
    }
    let secs = uart::rtc_seconds();
    println!("uart-echo: rtc seconds={secs}");
    println!("uart-echo: rtc year={}", uart::year_of(secs));
}
