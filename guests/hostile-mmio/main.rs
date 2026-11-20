//! `hostile-mmio`: TEST-7 phase 1, the MMIO sweep (threat model §9.4; PLAN M11). Run with
//! `--testdev --unhandled-mmio log`; every virtio slot is empty.
//!
//! For every trapped device window of the `virt` board (PL011, PL031, the 32 virtio-mmio
//! slots, the testdev, the RAZ/WI remainder of the GIC redistributor window) and a slice of the
//! never-populated hole: **every 1-byte offset, every width (1/2/4/8), a read and a write of a
//! random value**, then 20,000 random accesses anywhere in those windows. Misaligned accesses
//! take an alignment fault inside the guest (Device memory, MMU off); aligned ones trap to the
//! VMM, including the ones that straddle a device's end (the bus refuses them as `Straddle`,
//! which `--unhandled-mmio log` answers as RAZ/WI). The VMM must survive all of it: no stop, no
//! panic, exit 0, and the guest prints the counts.
//!
//! Output goes through DEBUG_PUTC, not the PL011, because the sweep writes random values to
//! the UART's control registers.
#![no_std]
#![no_main]

use guest::hostile::{
    ALIGNMENT_FAULTS, DATA_ABORTS, XorShift, install_fault_counter, mmio_read, mmio_write,
};
use guest::println;

guest::entry!(main);

/// `(name, base, size)` of every window swept (PLAN §1; the GICR remainder starts after the
/// one 128 KiB redistributor frame of a single vCPU).
const WINDOWS: &[(&str, u64, u64)] = &[
    ("pl011", 0x0900_0000, 0x1000),
    ("pl031", 0x0901_0000, 0x1000),
    ("virtio-mmio", 0x0a00_0000, 0x4000),
    ("testdev", 0x0b00_0000, 0x1000),
    ("gicr-unused", 0x080c_0000, 0x1000),
    ("probe-hole", 0x0c00_0000, 0x100),
];

fn main(_x0: u64) {
    install_fault_counter();
    let mut rng = XorShift::new(0x4d11_0001);
    let mut accesses: u64 = 0;
    for &(name, base, size) in WINDOWS {
        for off in 0..size {
            for width in [1u32, 2, 4, 8] {
                let a = base + off;
                let _ = mmio_read(a, width);
                mmio_write(a, width, rng.next());
                accesses += 2;
            }
        }
        println!("hostile-mmio: swept {name} ({size:#x} bytes)");
    }
    for _ in 0..20_000 {
        let (_, base, size) = WINDOWS[rng.below(WINDOWS.len() as u64) as usize];
        let a = base + rng.below(size);
        let width = 1u32 << rng.below(4);
        if rng.below(2) == 0 {
            let _ = mmio_read(a, width);
        } else {
            mmio_write(a, width, rng.next());
        }
        accesses += 1;
    }
    println!(
        "hostile-mmio: {accesses} accesses, {} alignment faults, {} other data aborts",
        ALIGNMENT_FAULTS.get(),
        DATA_ABORTS.get()
    );
    println!("hostile-mmio: survived");
}
