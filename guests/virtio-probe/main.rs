//! `virtio-probe`: the driver's first look at the virtio-mmio slots (course ch15, PLAN M11;
//! virtio 1.2 §4.2.2, §4.2.3.1).
//!
//! 1. **Scan.** For each of the 32 slots at `0x0a00_0000 + i·0x200`: MagicValue must be
//!    `0x74726976` ("virt") and Version 2 (§4.2.3.1.1: "the driver MUST ignore a device with
//!    MagicValue which is not 0x74726976 … Version which is not 0x2"); DeviceID 0 means "no
//!    device here".
//! 2. **Narrow reads.** The control registers take aligned 32-bit accesses only (§4.2.2.1);
//!    a 1-, 2- or 8-byte read of MagicValue must read as zero (RAZ), not as part of "virt".
//! 3. **The DT agrees.** The device tree lists a `virtio_mmio@…` node only for a populated
//!    slot (architecture §11.1), so the node count must equal the number of non-zero IDs.
//! 4. **Handshake** (§3.1.1), on every populated slot: reset, ACKNOWLEDGE, DRIVER, accept
//!    `VIRTIO_F_VERSION_1` only, FEATURES_OK (read back), give queue 0 a ring in this guest's
//!    RAM, DRIVER_OK, and print the final Status. M11 has no device, so this path runs from M12
//!    (virtio-rng) on.
//! 5. **One entropy request** (M12, §5.4.6), on a virtio-rng slot (DeviceID 4): one 32-byte
//!    device-writable descriptor, published through the available ring (descriptor and ring
//!    entry first, a `dmb` write barrier, then `avail.idx`: §2.7.13), a QueueNotify, then poll
//!    `used.idx` for up to one second. The used element must name our descriptor with
//!    `len = 32`, and the 32 bytes must not all be zero.
//!
//! **Memory with the MMU off.** This guest never turns its MMU on, so its accesses to the
//! rings are Device-nGnRnE (ARM ARM D8.2.12: with stage 1 disabled, data accesses are Device):
//! uncached and in program order. The VMM's worker reads and writes the same RAM through its
//! cacheable host mapping; Apple's stage-2 mapping keeps the two coherent, so no cache
//! maintenance is needed here (the `memtest` guest's DEBUG_MEMHASH relies on the same).
#![no_std]
#![no_main]

use guest::fdt::Fdt;
use guest::hostile::{VIRTIO_SLOTS, mmio_read, vreg_read, vreg_write};
use guest::println;

guest::entry!(main);

const MAGIC: u64 = 0x000;
const VERSION: u64 = 0x004;
const DEVICE_ID: u64 = 0x008;
const DEVICE_FEATURES: u64 = 0x010;
const DEVICE_FEATURES_SEL: u64 = 0x014;
const DRIVER_FEATURES: u64 = 0x020;
const DRIVER_FEATURES_SEL: u64 = 0x024;
const QUEUE_SEL: u64 = 0x030;
const QUEUE_NUM_MAX: u64 = 0x034;
const QUEUE_NUM: u64 = 0x038;
const QUEUE_READY: u64 = 0x044;
const QUEUE_NOTIFY: u64 = 0x050;
const INTERRUPT_STATUS: u64 = 0x060;
const INTERRUPT_ACK: u64 = 0x064;
const STATUS: u64 = 0x070;
const QUEUE_DESC_LOW: u64 = 0x080;
const QUEUE_DESC_HIGH: u64 = 0x084;
const QUEUE_DRIVER_LOW: u64 = 0x090;
const QUEUE_DRIVER_HIGH: u64 = 0x094;
const QUEUE_DEVICE_LOW: u64 = 0x0a0;
const QUEUE_DEVICE_HIGH: u64 = 0x0a4;
const MAGIC_VALUE: u32 = 0x7472_6976;

/// Queue 0's rings for the handshake: 16 descriptors, aligned for every part (§2.7).
const QSIZE: u32 = 16;
#[repr(C, align(4096))]
struct Rings([u8; 4096]);
static mut RINGS: Rings = Rings([0; 4096]);
/// Offsets of the three parts inside `RINGS` (each aligned well past §2.7's 16/2/4).
const DESC_OFF: u64 = 0;
const AVAIL_OFF: u64 = 16 * 64;
const USED_OFF: u64 = 2048;
/// The entropy request's buffer.
#[repr(C, align(64))]
struct Buf([u8; 64]);
static mut RNG_BUF: Buf = Buf([0; 64]);
const RNG_REQUEST: u32 = 32;
/// virtio 1.2 §5: the entropy device.
const DEVICE_ID_RNG: u32 = 4;

fn handshake(slot: u64) -> u32 {
    vreg_write(slot, STATUS, 0);
    vreg_write(slot, STATUS, 1);
    vreg_write(slot, STATUS, 1 | 2);
    vreg_write(slot, DEVICE_FEATURES_SEL, 1);
    let hi = vreg_read(slot, DEVICE_FEATURES);
    vreg_write(slot, DRIVER_FEATURES_SEL, 0);
    vreg_write(slot, DRIVER_FEATURES, 0);
    vreg_write(slot, DRIVER_FEATURES_SEL, 1);
    vreg_write(slot, DRIVER_FEATURES, hi & 1); // VERSION_1 (bit 32) only
    vreg_write(slot, STATUS, 1 | 2 | 8);
    if vreg_read(slot, STATUS) & 8 == 0 {
        return vreg_read(slot, STATUS);
    }
    let id = vreg_read(slot, DEVICE_ID);
    println!("virtio-probe: slot {slot} device {id} features ok");
    vreg_write(slot, QUEUE_SEL, 0);
    let max = vreg_read(slot, QUEUE_NUM_MAX);
    if max != 0 {
        let base = &raw const RINGS as u64;
        let (desc, avail, used) = (base + DESC_OFF, base + AVAIL_OFF, base + USED_OFF);
        vreg_write(slot, QUEUE_NUM, QSIZE.min(max));
        for (lo, hi, a) in [
            (QUEUE_DESC_LOW, QUEUE_DESC_HIGH, desc),
            (QUEUE_DRIVER_LOW, QUEUE_DRIVER_HIGH, avail),
            (QUEUE_DEVICE_LOW, QUEUE_DEVICE_HIGH, used),
        ] {
            vreg_write(slot, lo, a as u32);
            vreg_write(slot, hi, (a >> 32) as u32);
        }
        vreg_write(slot, QUEUE_READY, 1);
    }
    vreg_write(slot, STATUS, 1 | 2 | 8 | 4);
    vreg_read(slot, STATUS)
}

/// Write `v` to guest RAM at `addr` (one volatile store of exactly its width).
fn poke<T>(addr: u64, v: T) {
    // SAFETY: every caller passes an address inside `RINGS` or `RNG_BUF`, statics of this
    // guest that no Rust reference points at while the device owns them; alignment holds
    // because each offset is a multiple of the type's size.
    unsafe { core::ptr::write_volatile(addr as *mut T, v) }
}

fn peek<T: Copy>(addr: u64) -> T {
    // SAFETY: as `poke`: an aligned address inside this guest's own statics.
    unsafe { core::ptr::read_volatile(addr as *const T) }
}

/// A write barrier: the descriptor and the ring entry are visible before `avail.idx` (the
/// driver side of the pairing in `crates/vmm/src/virtio/queue.rs`, §2.7.13 step 3).
fn wmb() {
    // SAFETY: a barrier instruction; no memory is accessed.
    unsafe { core::arch::asm!("dmb ishst", options(nostack, preserves_flags)) };
}

/// One 32-byte entropy request on queue 0 of `slot` (module docs, step 5). Returns the used
/// length and whether the bytes were not all zero, or `None` on a timeout or a wrong element.
fn rng_request(slot: u64) -> Option<(u32, bool)> {
    let base = &raw const RINGS as u64;
    let (desc, avail, used) = (base + DESC_OFF, base + AVAIL_OFF, base + USED_OFF);
    let buf = &raw const RNG_BUF as u64;
    // Descriptor 0: {addr, len, flags = VIRTQ_DESC_F_WRITE, next = 0} (§2.7.5).
    poke::<u64>(desc, buf);
    poke::<u32>(desc + 8, RNG_REQUEST);
    poke::<u16>(desc + 12, 2);
    poke::<u16>(desc + 14, 0);
    poke::<u16>(avail, 0); // flags: we want the interrupt (not used here: we poll)
    poke::<u16>(avail + 4, 0); // ring[0] = head 0
    wmb();
    poke::<u16>(avail + 2, 1); // avail.idx = 1
    vreg_write(slot, QUEUE_NOTIFY, 0);
    let deadline = guest::cntvct() + guest::cntfrq();
    while peek::<u16>(used + 2) != 1 {
        if guest::cntvct() > deadline {
            return None;
        }
    }
    let (id, len) = (peek::<u32>(used + 4), peek::<u32>(used + 8));
    if id != 0 {
        return None;
    }
    let nonzero = (0..u64::from(RNG_REQUEST)).any(|i| peek::<u8>(buf + i) != 0);
    // Acknowledge the used-buffer interrupt (§4.2.2 InterruptACK).
    let pending = vreg_read(slot, INTERRUPT_STATUS);
    vreg_write(slot, INTERRUPT_ACK, pending);
    Some((len, nonzero))
}

fn main(x0: u64) {
    let (mut magic_ok, mut empty, mut populated, mut narrow_bad) = (0u64, 0u64, 0u64, 0u64);
    for slot in 0..VIRTIO_SLOTS {
        let base = guest::hostile::VIRTIO_BASE + slot * guest::hostile::VIRTIO_STRIDE;
        if vreg_read(slot, MAGIC) == MAGIC_VALUE && vreg_read(slot, VERSION) == 2 {
            magic_ok += 1;
        } else {
            println!("virtio-probe: FAILED: slot {slot} magic/version");
        }
        for width in [1, 2, 8] {
            if mmio_read(base + MAGIC, width) != 0 {
                narrow_bad += 1;
            }
        }
        match vreg_read(slot, DEVICE_ID) {
            0 => empty += 1,
            id => {
                populated += 1;
                let status = handshake(slot);
                println!("virtio-probe: slot {slot} device id {id} status {status:#x}");
                if id == DEVICE_ID_RNG && status == 0xf {
                    match rng_request(slot) {
                        Some((len, true)) => println!("virtio-probe: rng {len} bytes nonzero"),
                        Some((len, false)) => {
                            println!("virtio-probe: FAILED: rng {len} bytes all zero")
                        }
                        None => println!("virtio-probe: FAILED: rng request timed out"),
                    }
                }
            }
        }
    }
    if magic_ok == VIRTIO_SLOTS {
        println!("virtio-probe: {magic_ok} slots magic ok version 2");
    }
    println!("virtio-probe: {empty} empty (device id 0)");
    if narrow_bad == 0 {
        println!("virtio-probe: narrow read RAZ ok");
    } else {
        println!("virtio-probe: FAILED: {narrow_bad} narrow reads returned data");
    }
    // SAFETY: the VMM passes the DTB address in x0; its slot is mapped RAM (loader/plan.rs).
    match unsafe { Fdt::from_addr(x0) } {
        Ok(fdt) => {
            let nodes = fdt.children("/", "virtio_mmio@", |_| {}) as u64;
            println!(
                "virtio-probe: dt lists {nodes} virtio_mmio nodes {}",
                if nodes == populated { "ok" } else { "FAILED" }
            );
        }
        Err(e) => println!("virtio-probe: FAILED: no DTB: {e}"),
    }
}
