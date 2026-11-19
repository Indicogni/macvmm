//! `irq`: a device interrupt end to end, through the in-kernel GICv3 (course ch12, PLAN M8).
//!
//! 0. read `ID_AA64PFR0_EL1.GIC` with an `MRS`, as Linux does before it touches `ICC_*`, and
//!    print `irq: pfr0.gic=N` (risk R3, from the guest's side: 1 = GICv3 system registers);
//! 1. GICv3 bring-up (`guest::gic::init`: distributor with DS = 1 and Group 1, this CPU's
//!    redistributor found by affinity and woken, `ICC_PMR = 0xff`, `IGRPEN1 = 1`);
//! 2. route SPI 1 (INTID 33, the PL011) to this CPU: `GICD_IROUTER` = our affinity, Group 1,
//!    priority, level, enable;
//! 3. enable the PL011's receive and receive-timeout interrupts (`UARTIMSC.RXIM | RTIM`, ARM DDI
//!    0183G §3.3.10), print `irq: ready`, and sleep in WFI;
//! 4. the handler acknowledges with `ICC_IAR1_EL1`, drains the RX FIFO (which lowers the
//!    PL011's level line, so the GIC does not re-deliver), then writes `ICC_EOIR1_EL1`;
//! 5. after 3 interrupts it prints `irq: 3 irqs intid=33 spurious=N` and powers off.
//!
//! The VMM's part is a single `hv_gic_set_spi(33, level)` per change of the UART's
//! `(RIS & IMSC) != 0` (architecture §6.3); everything else here happens without one exit.
#![no_std]
#![no_main]

use core::sync::atomic::{AtomicU32, Ordering};
use guest::exceptions::{ExceptionFrame, set_irq_hook};
use guest::{gic, println, timer, uart};

guest::entry!(main);

/// `+= 1` with a plain load and store: with the MMU off RAM is Device memory, where exclusives
/// and atomics fault (DFSC 0x35), and only this CPU touches the counters.
fn bump(c: &AtomicU32) {
    c.store(c.load(Ordering::Relaxed).wrapping_add(1), Ordering::Relaxed);
}

const PL011_INTID: u32 = 33;
const UARTIMSC: usize = uart::PL011_BASE + 0x038;
const RXIM_RTIM: u32 = (1 << 4) | (1 << 6);

static IRQS: AtomicU32 = AtomicU32::new(0);
static SPURIOUS: AtomicU32 = AtomicU32::new(0);
static OTHER: AtomicU32 = AtomicU32::new(0);
static LAST_INTID: AtomicU32 = AtomicU32::new(0);
static BYTES: AtomicU32 = AtomicU32::new(0);

fn on_irq(_frame: &mut ExceptionFrame) {
    let intid = gic::ack();
    if intid == gic::SPURIOUS {
        bump(&SPURIOUS);
        return;
    }
    if intid == PL011_INTID {
        while uart::getc().is_some() {
            bump(&BYTES);
        }
        bump(&IRQS);
    } else {
        bump(&OTHER);
    }
    LAST_INTID.store(intid, Ordering::Relaxed);
    gic::eoi(intid);
}

fn main(_x0: u64) {
    uart::enable_console();
    println!("irq: pfr0.gic={}", gic::pfr0_gic());
    let Some(_rd) = gic::init() else {
        println!("irq: no redistributor for mpidr {:#x}", gic::mpidr());
        guest::hvc::debug_exit(1);
    };
    gic::enable_spi(PL011_INTID, gic::mpidr());
    set_irq_hook(Some(on_irq));
    // SAFETY: an aligned 32-bit store to the emulated UART's interrupt mask.
    unsafe { core::ptr::write_volatile(UARTIMSC as *mut u32, RXIM_RTIM) };
    println!("irq: ready");
    while IRQS.load(Ordering::Relaxed) < 3 {
        timer::wait_for_interrupt();
    }
    println!(
        "irq: {} irqs intid={} spurious={} other={} bytes={}",
        IRQS.load(Ordering::Relaxed),
        LAST_INTID.load(Ordering::Relaxed),
        SPURIOUS.load(Ordering::Relaxed),
        OTHER.load(Ordering::Relaxed),
        BYTES.load(Ordering::Relaxed)
    );
}
