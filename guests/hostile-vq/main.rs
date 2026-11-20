//! `hostile-vq`: TEST-7 phase 5, virtqueue attacks (threat model §9.4; PLAN M11, extended by
//! M12 (rng), M14 (blk) and M16 (live TOCTOU from a second vCPU)).
//!
//! **M11 part (no device yet).** On all 32 empty slots:
//! 1. a full driver handshake with hostile values: every Status value 0..=255 in turn,
//!    features with every high bit set, QueueNum 0/3/65535, ring addresses near `u64::MAX`,
//!    in MMIO, in the unmapped hole just above RAM and straddling the end of RAM (RAM's end
//!    is read from the DTB's `/memory` node, so the straddle follows `--mem`), QueueReady,
//!    DRIVER_OK; an empty slot must ignore all of it (Status reads 0, DeviceID stays 0:
//!    virtio 1.2 §4.2.3.1.1);
//! 2. QueueNotify with out-of-range queue numbers (0..64 and `u32::MAX`);
//! 3. narrow and unaligned accesses (1/2/8 bytes, offset +1) to every control register, which
//!    must read as zero (§4.2.2.1, VQ-13), and config-space reads at every width.
//!
//! **M12 part (`--rng`).** A slot that holds virtio-rng (DeviceID 4) is attacked as a
//! device instead: after a correct handshake the guest publishes one hostile request at a
//! time — a descriptor self-loop and a 2-cycle, `next` out of range, a head ≥ N, `avail.idx`
//! jumping by N + 1, a zero-length buffer, a writable buffer in the PL011's MMIO window, an
//! indirect table in MMIO (indirect descriptors are not even negotiated), a buffer straddling
//! the end of RAM, `len = u32::MAX`, a 64 KiB + 1 request (VQ-8), and a used ring placed at the
//! very end of RAM (refused at DRIVER_OK). Each must end in DEVICE_NEEDS_RESET (Status bit 64)
//! with a configuration interrupt (InterruptStatus bit 1), the worker thread doing the
//! detection asynchronously; then the guest resets the device (Status = 0). A final well-formed
//! request must still be served: the device recovers and the VMM never stopped.
//!
//! **M14 part (`--disk`).** A slot that holds virtio-blk (DeviceID 2) gets the blk attacks of
//! threat model §7.3, each on a freshly handshaken 256-entry queue: a sector past the end and
//! one straddling it, `sector × 512` overflowing (`2^55`), a length that is not a multiple of
//! 512, 127 data segments (`seg_max` is 126), a writable header, an 8-byte header and an
//! unknown request type must each come back with a status (IOERR, or UNSUPP for the type) and
//! a used `len` of exactly 1, the device still healthy (BLK-1..4, VQ-9); a missing status
//! descriptor, a zero-length status and a data buffer in MMIO must end in NEEDS_RESET. On a
//! `,ro` disk an OUT must be IOERR (BLK-5). Afterwards GET_ID must return `macvmm-disk0` and a
//! read of sector 0 must succeed. The e2e test checks that the image's sha256 is unchanged.
//!
//! The VMM must not stop; the guest checks what it read back and exits 0.
#![no_std]
#![no_main]

use guest::fdt::Fdt;
use guest::hostile::{
    ALIGNMENT_FAULTS, VIRTIO_BASE, VIRTIO_SLOTS, VIRTIO_STRIDE, install_fault_counter, mmio_read,
    mmio_write, vreg_read, vreg_write,
};
use guest::println;

guest::entry!(main);

const STATUS: u64 = 0x070;
const DEVICE_ID: u64 = 0x008;
const QUEUE_NOTIFY: u64 = 0x050;
const INTERRUPT_STATUS: u64 = 0x060;
const INTERRUPT_ACK: u64 = 0x064;
const NEEDS_RESET: u32 = 64;
const DEVICE_ID_RNG: u32 = 4;

/// The rng attack's rings and buffer (M12): desc at +0, avail at +1024, used at +2048, the
/// buffer at +4096. 16 descriptors (QS).
const QS: u32 = 16;
#[repr(C, align(4096))]
struct Area([u8; 8192]);
static mut AREA: Area = Area([0; 8192]);
const F_NEXT: u16 = 1;
const F_WRITE: u16 = 2;
const F_INDIRECT: u16 = 4;
/// The PL011: MMIO, never RAM.
const MMIO: u64 = 0x0900_0000;

fn area() -> u64 {
    &raw const AREA as u64
}

fn poke<T>(addr: u64, v: T) {
    // SAFETY: callers pass aligned addresses inside `AREA`, a static of this guest that no
    // Rust reference points at.
    unsafe { core::ptr::write_volatile(addr as *mut T, v) }
}

fn peek<T: Copy>(addr: u64) -> T {
    // SAFETY: as `poke`.
    unsafe { core::ptr::read_volatile(addr as *const T) }
}

/// The driver side of the handshake (virtio 1.2 §3.1.1) with queue 0 at `rings`
/// (`[desc, avail, used]`); returns Status after DRIVER_OK.
fn rng_up(slot: u64, rings: [u64; 3]) -> u32 {
    for off in (0..4096).step_by(8) {
        poke::<u64>(area() + off, 0);
    }
    vreg_write(slot, STATUS, 0);
    vreg_write(slot, STATUS, 1);
    vreg_write(slot, STATUS, 3);
    vreg_write(slot, 0x024, 0);
    vreg_write(slot, 0x020, 0);
    vreg_write(slot, 0x024, 1);
    vreg_write(slot, 0x020, 1); // VERSION_1 only
    vreg_write(slot, STATUS, 11);
    vreg_write(slot, 0x030, 0);
    vreg_write(slot, 0x038, QS);
    for (lo, a) in [(0x080, rings[0]), (0x090, rings[1]), (0x0a0, rings[2])] {
        let (l, h) = halves(a);
        vreg_write(slot, lo, l);
        vreg_write(slot, lo + 4, h);
    }
    vreg_write(slot, 0x044, 1);
    vreg_write(slot, STATUS, 15);
    vreg_read(slot, STATUS)
}

fn desc(i: u64, addr: u64, len: u32, flags: u16, next: u16) {
    let at = area() + 16 * i;
    poke::<u64>(at, addr);
    poke::<u32>(at + 8, len);
    poke::<u16>(at + 12, flags);
    poke::<u16>(at + 14, next);
}

/// Publish `head` in avail slot 0, then `avail.idx = idx`, and ring the doorbell.
fn publish(slot: u64, head: u16, idx: u16) {
    let avail = area() + 1024;
    poke::<u16>(avail + 4, head);
    // SAFETY: a barrier instruction; orders the entry before the index (§2.7.13).
    unsafe { core::arch::asm!("dmb ishst", options(nostack, preserves_flags)) };
    poke::<u16>(avail + 2, idx);
    vreg_write(slot, QUEUE_NOTIFY, 0);
}

/// Poll `cond` for up to one second of guest time.
fn within_1s(mut cond: impl FnMut() -> bool) -> bool {
    let deadline = guest::cntvct() + guest::cntfrq();
    while guest::cntvct() < deadline {
        if cond() {
            return true;
        }
    }
    cond()
}

/// One attack: did the device reach NEEDS_RESET with a config interrupt, return nothing, and
/// come back to Status 0 after the driver's reset?
fn attack_ok(slot: u64) -> bool {
    let reached = within_1s(|| vreg_read(slot, STATUS) & NEEDS_RESET != 0);
    let config_irq = vreg_read(slot, INTERRUPT_STATUS) & 2 != 0;
    let nothing_used = peek::<u16>(area() + 2048 + 2) == 0;
    vreg_write(slot, INTERRUPT_ACK, 3);
    vreg_write(slot, STATUS, 0);
    reached && config_irq && nothing_used && vreg_read(slot, STATUS) == 0
}

/// The M12 attacks on an rng slot (module docs). Returns the number of failed checks.
fn rng_attacks(slot: u64, ram_end: u64) -> u64 {
    let rings = [area(), area() + 1024, area() + 2048];
    let buf = area() + 4096;
    type Attack = (&'static str, fn(u64, u64));
    let attacks: [Attack; 11] = [
        ("self-loop", |b, _| desc(0, b, 8, F_WRITE | F_NEXT, 0)),
        ("2-cycle", |b, _| {
            desc(0, b, 8, F_WRITE | F_NEXT, 1);
            desc(1, b + 8, 8, F_WRITE | F_NEXT, 0);
        }),
        ("next out of range", |b, _| {
            desc(0, b, 8, F_WRITE | F_NEXT, 200)
        }),
        ("zero length", |b, _| desc(0, b, 0, F_WRITE, 0)),
        ("buffer in MMIO", |_, _| desc(0, MMIO, 32, F_WRITE, 0)),
        ("indirect table in MMIO", |_, _| {
            desc(0, MMIO, 16 * 4, F_INDIRECT, 0)
        }),
        ("buffer straddles the end of RAM", |_, end| {
            desc(0, end - 16, 32, F_WRITE, 0)
        }),
        ("len u32::MAX", |b, _| desc(0, b, u32::MAX, F_WRITE, 0)),
        ("64 KiB + 1 request", |b, _| {
            desc(0, b, 64 * 1024 + 1, F_WRITE, 0)
        }),
        ("head out of range", |b, _| desc(0, b, 8, F_WRITE, 0)),
        ("avail.idx jump", |b, _| desc(0, b, 8, F_WRITE, 0)),
    ];
    let mut bad = 0u64;
    let mut ok = 0u64;
    for (name, build) in attacks {
        if rng_up(slot, rings) != 15 {
            println!("hostile-vq: FAILED: rng slot {slot} handshake before {name}");
            bad += 1;
            continue;
        }
        build(buf, ram_end);
        match name {
            "head out of range" => publish(slot, 999, 1),
            "avail.idx jump" => publish(slot, 0, QS as u16 + 1),
            _ => publish(slot, 0, 1),
        }
        if attack_ok(slot) {
            ok += 1;
        } else {
            println!("hostile-vq: FAILED: rng attack {name} did not end in NEEDS_RESET");
            bad += 1;
        }
    }
    // Rings at the end of RAM: refused at DRIVER_OK itself, before any doorbell.
    let s = rng_up(slot, [rings[0], rings[1], ram_end - 4]);
    if s & NEEDS_RESET != 0 && attack_ok(slot) {
        ok += 1;
    } else {
        println!("hostile-vq: FAILED: a used ring at the end of RAM was accepted ({s:#x})");
        bad += 1;
    }
    // The device still works after all of that.
    let recovered = rng_up(slot, rings) == 15 && {
        desc(0, buf, 32, F_WRITE, 0);
        publish(slot, 0, 1);
        within_1s(|| peek::<u16>(area() + 2048 + 2) == 1)
            && peek::<u32>(area() + 2048 + 8) == 32
            && (0..32).any(|i| peek::<u8>(buf + i) != 0)
    };
    vreg_write(slot, INTERRUPT_ACK, 3);
    vreg_write(slot, STATUS, 0);
    println!(
        "hostile-vq: rng slot {slot}: {ok} attacks ended in needs-reset, {}",
        if recovered {
            "recovered"
        } else {
            "FAILED to recover"
        }
    );
    bad + u64::from(!recovered)
}

// ---- M14: virtio-blk attacks ----

const DEVICE_ID_BLOCK: u32 = 2;
/// The blk attack's queue size: large enough for a 127-segment chain (header + 127 + status).
const BQS: u32 = 256;
/// Rings and buffers for the blk attacks: desc +0 (256 × 16), avail +4096, used +8192,
/// header +12288, status +12352, one 512-byte data sector +12800.
#[repr(C, align(4096))]
struct BlkArea([u8; 16384]);
static mut BLK_AREA: BlkArea = BlkArea([0; 16384]);
const B_AVAIL: u64 = 4096;
const B_USED: u64 = 8192;
const B_HDR: u64 = 12288;
const B_STATUS: u64 = 12352;
const B_DATA: u64 = 12800;
/// virtio-blk request types and status values (virtio 1.2 §5.2.6).
const T_IN: u32 = 0;
const T_OUT: u32 = 1;
const T_GET_ID: u32 = 8;
const S_OK: u8 = 0;
const S_IOERR: u8 = 1;
const S_UNSUPP: u8 = 2;
/// `VIRTIO_BLK_F_RO` (§5.2.3).
const BLK_F_RO: u32 = 1 << 5;

fn barea() -> u64 {
    &raw const BLK_AREA as u64
}

fn bdesc(i: u64, addr: u64, len: u32, flags: u16, next: u16) {
    let at = barea() + 16 * i;
    poke::<u64>(at, addr);
    poke::<u32>(at + 8, len);
    poke::<u16>(at + 12, flags);
    poke::<u16>(at + 14, next);
}

/// Handshake a blk slot with a 256-entry queue in `BLK_AREA` (VERSION_1 only: no indirect).
fn blk_up(slot: u64) -> u32 {
    for off in (0..16384).step_by(8) {
        poke::<u64>(barea() + off, 0);
    }
    vreg_write(slot, STATUS, 0);
    vreg_write(slot, STATUS, 1);
    vreg_write(slot, STATUS, 3);
    vreg_write(slot, 0x024, 0);
    vreg_write(slot, 0x020, 0);
    vreg_write(slot, 0x024, 1);
    vreg_write(slot, 0x020, 1);
    vreg_write(slot, STATUS, 11);
    vreg_write(slot, 0x030, 0);
    vreg_write(slot, 0x038, BQS);
    for (lo, a) in [
        (0x080, barea()),
        (0x090, barea() + B_AVAIL),
        (0x0a0, barea() + B_USED),
    ] {
        let (l, h) = halves(a);
        vreg_write(slot, lo, l);
        vreg_write(slot, lo + 4, h);
    }
    vreg_write(slot, 0x044, 1);
    vreg_write(slot, STATUS, 15);
    vreg_read(slot, STATUS)
}

/// Publish head 0 as the first request and ring the doorbell.
fn blk_publish(slot: u64) {
    poke::<u16>(barea() + B_AVAIL + 4, 0);
    // SAFETY: a barrier instruction; orders the entry before the index (§2.7.13).
    unsafe { core::arch::asm!("dmb ishst", options(nostack, preserves_flags)) };
    poke::<u16>(barea() + B_AVAIL + 2, 1);
    vreg_write(slot, QUEUE_NOTIFY, 0);
}

fn blk_header(kind: u32, sector: u64) {
    poke::<u32>(barea() + B_HDR, kind);
    poke::<u32>(barea() + B_HDR + 4, 0);
    poke::<u64>(barea() + B_HDR + 8, sector);
    poke::<u8>(barea() + B_STATUS, 0xee);
}

/// A well-formed three-part request: header, `n` data descriptors of `len` bytes (all on the
/// same buffer), status.
fn blk_chain(kind: u32, sector: u64, n: u16, len: u32) {
    blk_header(kind, sector);
    bdesc(0, barea() + B_HDR, 16, F_NEXT, 1);
    let dir = if kind == T_OUT { 0 } else { F_WRITE };
    for i in 0..n {
        bdesc(1 + u64::from(i), barea() + B_DATA, len, dir | F_NEXT, 2 + i);
    }
    bdesc(1 + u64::from(n), barea() + B_STATUS, 1, F_WRITE, 0);
}

/// The request came back (used.idx = 1) with `status` and used `len`, and the device did not
/// need a reset.
fn blk_answered(slot: u64, status: u8, len: u32) -> bool {
    let back = within_1s(|| peek::<u16>(barea() + B_USED + 2) == 1);
    let ok = back
        && peek::<u8>(barea() + B_STATUS) == status
        && peek::<u32>(barea() + B_USED + 8) == len
        && vreg_read(slot, STATUS) & NEEDS_RESET == 0;
    vreg_write(slot, INTERRUPT_ACK, 3);
    vreg_write(slot, STATUS, 0);
    ok
}

/// The chain was refused as a whole: NEEDS_RESET plus a config interrupt, nothing returned.
fn blk_reset_ok(slot: u64) -> bool {
    let reached = within_1s(|| vreg_read(slot, STATUS) & NEEDS_RESET != 0);
    let config_irq = vreg_read(slot, INTERRUPT_STATUS) & 2 != 0;
    let nothing_used = peek::<u16>(barea() + B_USED + 2) == 0;
    vreg_write(slot, INTERRUPT_ACK, 3);
    vreg_write(slot, STATUS, 0);
    reached && config_irq && nothing_used && vreg_read(slot, STATUS) == 0
}

/// The M14 attacks on a blk slot (module docs). Returns the number of failed checks.
fn blk_attacks(slot: u64) -> u64 {
    let ro = {
        vreg_write(slot, 0x014, 0);
        vreg_read(slot, 0x010) & BLK_F_RO != 0
    };
    let capacity = u64::from(vreg_read(slot, 0x100)) | (u64::from(vreg_read(slot, 0x104)) << 32);
    println!("hostile-vq: blk slot {slot}: capacity {capacity} sectors ro={}", ro as u8);
    type Attack = (&'static str, fn(u64), u8, u32);
    // (name, build(capacity), expected status, expected used len); 0xff = NEEDS_RESET.
    let attacks: [Attack; 11] = [
        ("sector past the end", |c| blk_chain(T_IN, c, 1, 512), S_IOERR, 1),
        ("sector straddles the end", |c| blk_chain(T_IN, c - 1, 2, 512), S_IOERR, 1),
        ("sector * 512 overflows", |_| blk_chain(T_IN, 1 << 55, 1, 512), S_IOERR, 1),
        ("length not a multiple of 512", |_| blk_chain(T_IN, 0, 1, 100), S_IOERR, 1),
        ("127 segments", |_| blk_chain(T_IN, 0, 127, 512), S_IOERR, 1),
        ("writable header", |_| {
            blk_chain(T_IN, 0, 1, 512);
            bdesc(0, barea() + B_HDR, 16, F_WRITE | F_NEXT, 1);
        }, S_IOERR, 1),
        ("short header", |_| {
            blk_chain(T_IN, 0, 1, 512);
            bdesc(0, barea() + B_HDR, 8, F_NEXT, 1);
        }, S_IOERR, 1),
        ("unknown type", |_| blk_chain(0x4d56, 0, 1, 512), S_UNSUPP, 1),
        ("missing status", |_| {
            blk_header(T_OUT, 0);
            bdesc(0, barea() + B_HDR, 16, F_NEXT, 1);
            bdesc(1, barea() + B_DATA, 512, 0, 0);
        }, 0xff, 0),
        ("zero-length status", |_| {
            blk_chain(T_IN, 0, 1, 512);
            bdesc(2, barea() + B_STATUS, 0, F_WRITE, 0);
        }, 0xff, 0),
        ("data in MMIO", |_| {
            blk_chain(T_IN, 0, 1, 512);
            bdesc(1, MMIO, 512, F_WRITE | F_NEXT, 2);
        }, 0xff, 0),
    ];
    let (mut bad, mut statused, mut resets) = (0u64, 0u64, 0u64);
    for (name, build, status, len) in attacks {
        if blk_up(slot) != 15 {
            println!("hostile-vq: FAILED: blk slot {slot} handshake before {name}");
            bad += 1;
            continue;
        }
        build(capacity);
        blk_publish(slot);
        let ok = if status == 0xff {
            let ok = blk_reset_ok(slot);
            resets += u64::from(ok);
            ok
        } else {
            let ok = blk_answered(slot, status, len);
            statused += u64::from(ok);
            ok
        };
        if !ok {
            println!("hostile-vq: FAILED: blk attack {name}");
            bad += 1;
        }
    }
    // A write to a read-only disk is IOERR; to a read-write one it would be OK, so the guest
    // only attempts it when RO is offered.
    if ro {
        let ok = blk_up(slot) == 15 && {
            blk_chain(T_OUT, 0, 1, 512);
            blk_publish(slot);
            blk_answered(slot, S_IOERR, 1)
        };
        statused += u64::from(ok);
        if !ok {
            println!("hostile-vq: FAILED: blk OUT on a read-only disk was not IOERR");
            bad += 1;
        }
    }
    // The device still works: GET_ID returns `macvmm-disk0` and a read of sector 0 is OK.
    let id_ok = blk_up(slot) == 15 && {
        blk_chain(T_GET_ID, 0, 1, 20);
        blk_publish(slot);
        let ok = blk_answered(slot, S_OK, 21);
        let want = b"macvmm-disk0";
        ok && (0..want.len()).all(|i| peek::<u8>(barea() + B_DATA + i as u64) == want[i])
    };
    let read_ok = blk_up(slot) == 15 && {
        blk_chain(T_IN, 0, 1, 512);
        blk_publish(slot);
        blk_answered(slot, S_OK, 513)
    };
    let recovered = id_ok && read_ok;
    println!(
        "hostile-vq: blk slot {slot}: {statused} attacks answered with a status, {resets} ended in needs-reset, {}",
        if recovered {
            "recovered"
        } else {
            "FAILED to recover"
        }
    );
    bad + u64::from(!recovered)
}

/// The end of guest RAM from the DTB at `x0`: `/memory@...` `reg = <base size>` (two cells
/// each, as the VMM's FDT writes them). `None` if the tree or the node is unreadable.
fn ram_end(x0: u64) -> Option<u64> {
    // SAFETY: the VMM passes the DTB address in x0; its slot is mapped RAM of at least
    // `totalsize` bytes (loader/plan.rs), and `from_addr` checks the header first.
    let fdt = unsafe { Fdt::from_addr(x0) }.ok()?;
    let mut name = "";
    fdt.children("/", "memory@", |n| name = n);
    let mut buf = [0u8; 64];
    let path_len = name.len().checked_add(1).filter(|&l| l <= buf.len())?;
    buf[0] = b'/';
    buf.get_mut(1..path_len)?.copy_from_slice(name.as_bytes());
    let path = core::str::from_utf8(buf.get(..path_len)?).ok()?;
    let reg = fdt.prop(path, "reg")?;
    if reg.len() != 16 {
        return None;
    }
    let cell = |i: usize| Some(u64::from_be_bytes(reg.get(i..i + 8)?.try_into().ok()?));
    cell(0)?.checked_add(cell(8)?)
}

/// The low and high 32-bit halves of a ring address, as the Low/High registers take it.
fn halves(a: u64) -> (u32, u32) {
    (a as u32, (a >> 32) as u32)
}

fn main(x0: u64) {
    install_fault_counter();
    let mut bad = 0u64;
    let Some(end) = ram_end(x0) else {
        println!("hostile-vq: FAILED: cannot read the RAM size from the DTB");
        return;
    };
    println!("hostile-vq: RAM ends at {end:#x}");
    // The hole: the first byte past RAM. The straddle: a used ring whose first 4 bytes are
    // RAM's last 4, so it runs off the end for every queue size (6 + 8·N > 4 bytes).
    let (hole_lo, hole_hi) = halves(end);
    let (straddle_lo, straddle_hi) = halves(end - 4);
    let mut empty = 0u64;
    for slot in 0..VIRTIO_SLOTS {
        match vreg_read(slot, DEVICE_ID) {
            0 => empty += 1,
            DEVICE_ID_RNG => {
                bad += rng_attacks(slot, end);
                continue;
            }
            DEVICE_ID_BLOCK => {
                bad += blk_attacks(slot);
                continue;
            }
            id => {
                println!("hostile-vq: slot {slot} holds device {id}: not attacked");
                continue;
            }
        }
        // 1. hostile handshakes
        for v in 0..=255u32 {
            vreg_write(slot, STATUS, v);
            bad += u64::from(vreg_read(slot, STATUS) != 0);
        }
        for (off, v) in [
            (0x024, 1),
            (0x020, u32::MAX),
            (0x024, 2),
            (0x020, u32::MAX), // DriverFeatures
            (0x030, 0),
            (0x038, 0),
            (0x038, 3),
            (0x038, 0xffff), // QueueSel, QueueNum
            (0x080, 0xffff_fff0),
            (0x084, 0xffff_ffff), // desc at u64::MAX - 15
            (0x090, 0x0900_0000),
            (0x094, 0), // avail in the PL011
            (0x0a0, hole_lo),
            (0x0a4, hole_hi), // used in the hole just above RAM
            (0x0a0, straddle_lo),
            (0x0a4, straddle_hi), // used straddling the end of RAM
            (0x044, 1),
            (0x070, 1),
            (0x070, 3),
            (0x070, 11),
            (0x070, 15),
            (0x0c0, 1),        // QueueReset
            (0x064, u32::MAX), // InterruptACK
        ] {
            vreg_write(slot, off, v);
        }
        bad += u64::from(vreg_read(slot, STATUS) != 0);
        bad += u64::from(vreg_read(slot, DEVICE_ID) != 0);
        bad += u64::from(vreg_read(slot, 0x044) != 0);
        // 2. QueueNotify out of range
        for q in (0..64).chain([u32::MAX]) {
            vreg_write(slot, 0x050, q);
        }
        // 3. narrow and unaligned accesses
        let base = VIRTIO_BASE + slot * VIRTIO_STRIDE;
        for off in (0..0x100).step_by(4) {
            for width in [1u32, 2, 8] {
                // An 8-byte access at a 4-but-not-8-aligned offset faults in the guest (Device
                // memory), leaving the destination register unwritten: nothing to compare.
                let v = mmio_read(base + off, width);
                if off % u64::from(width) == 0 {
                    bad += u64::from(v != 0);
                }
                mmio_write(base + off, width, u64::MAX);
            }
            let _ = mmio_read(base + off + 1, 4); // misaligned: an alignment fault in the guest
        }
        for off in 0x100..0x200u64 {
            for width in [1u32, 2, 4, 8] {
                if off % u64::from(width) == 0 && off + u64::from(width) <= 0x200 {
                    bad += u64::from(mmio_read(base + off, width) != 0);
                    mmio_write(base + off, width, u64::MAX);
                }
            }
        }
    }
    println!(
        "hostile-vq: {empty} empty slots attacked, {} alignment faults, {bad} unexpected values",
        ALIGNMENT_FAULTS.get()
    );
    if bad == 0 {
        println!("hostile-vq: survived");
    } else {
        println!("hostile-vq: FAILED");
    }
}
