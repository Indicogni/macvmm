//! `dtb-reader`: read the device tree the VMM passed in `x0` and print what a kernel would look
//! at first (PLAN M7; course ch10).
//!
//! Linux finds its DTB through `x0` (`Documentation/arch/arm64/booting.rst` §4), checks the
//! header, then reads `/memory` for RAM, `/cpus` for the CPUs, `/chosen` for its command line,
//! console and seeds, and the device nodes for the UART. This guest does the same and prints one
//! marker per item, so the e2e test (`dtb_reader`) proves the blob reached guest RAM intact and
//! says what `fdt/machine.rs` meant it to say.
//!
//! **Seeds are never printed** (threat model FDT-4): only whether `rng-seed` (64 bytes) and
//! `kaslr-seed` are non-zero, which shows the guest got real seeds even though the `--dtb-out`
//! copy of the same boot has them zeroed.
#![no_std]
#![no_main]

use guest::fdt::Fdt;
use guest::println;

guest::entry!(main);

fn be64(b: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(..8)?.try_into().ok()?))
}

fn first_str(b: &[u8]) -> &str {
    let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    core::str::from_utf8(&b[..end]).unwrap_or("<not utf-8>")
}

fn fail(what: &str) -> ! {
    println!("dtb-reader: FAIL {what}");
    guest::hvc::debug_exit(1)
}

fn main(x0: u64) {
    println!("dtb-reader: x0={x0:#x}");
    // SAFETY: the VMM puts the DTB at the start of RAM and passes its address in x0; the slot
    // is mapped RAM of at least `totalsize` bytes (loader/plan.rs).
    let fdt = match unsafe { Fdt::from_addr(x0) } {
        Ok(f) => f,
        Err(e) => fail(e),
    };
    println!("dtb-reader: magic ok");

    let model = fdt.prop("/", "model").unwrap_or_else(|| fail("no /model"));
    println!("dtb-reader: model={}", first_str(model));

    // ANCHOR: dtb_reader_memory
    let mut mem_name = "";
    fdt.children("/", "memory@", |n| mem_name = n);
    let mut path = [0u8; 64];
    let mem_path = join(&mut path, mem_name);
    let reg = fdt
        .prop(mem_path, "reg")
        .unwrap_or_else(|| fail("no memory reg"));
    let (base, size) = match (be64(reg), reg.get(8..).and_then(be64)) {
        (Some(b), Some(s)) if reg.len() == 16 => (b, s),
        _ => fail("memory reg is not one <u64 u64> pair"),
    };
    println!("dtb-reader: {mem_name} reg={base:#x}+{size:#x}");
    // ANCHOR_END: dtb_reader_memory

    let mut uart = "";
    fdt.children("/", "pl011@", |n| uart = n);
    let mut path = [0u8; 64];
    let uart_path = join(&mut path, uart);
    let compat = fdt
        .prop(uart_path, "compatible")
        .unwrap_or_else(|| fail("no pl011 compatible"));
    println!("dtb-reader: {uart} compatible={}", first_str(compat));

    let cpus = fdt.children("/cpus", "cpu@", |_| {});
    println!("dtb-reader: cpus={cpus}");

    let stdout = fdt
        .prop("/chosen", "stdout-path")
        .unwrap_or_else(|| fail("no stdout-path"));
    println!("dtb-reader: stdout-path={}", first_str(stdout));

    match fdt.prop("/chosen", "rng-seed") {
        Some(s) if s.len() == 64 && s.iter().any(|&b| b != 0) => {
            println!("dtb-reader: rng-seed nonzero")
        }
        Some(s) => println!("dtb-reader: rng-seed zero (len {})", s.len()),
        None => fail("no rng-seed"),
    }
    match fdt.prop("/chosen", "kaslr-seed").and_then(be64) {
        Some(0) => println!("dtb-reader: kaslr-seed zero"),
        Some(_) => println!("dtb-reader: kaslr-seed nonzero"),
        None => fail("no kaslr-seed"),
    }
    println!("dtb-reader: done");
}

/// `"/" + name` in a stack buffer (no allocator).
fn join<'b>(buf: &'b mut [u8; 64], name: &str) -> &'b str {
    let n = name.len().min(buf.len() - 1);
    buf[0] = b'/';
    buf[1..=n].copy_from_slice(&name.as_bytes()[..n]);
    core::str::from_utf8(&buf[..=n]).unwrap_or("/")
}
