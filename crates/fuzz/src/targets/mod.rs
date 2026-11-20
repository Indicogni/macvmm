//! The fuzz targets (threat model §9.3) and the helpers they share.
//!
//! Every target reads its input through [`Input`], which is **total**: reading past the end
//! yields zeros, so any byte string is a valid input and the interesting question is only what
//! the code under test does with it. The shared guest RAM ([`ram`]) has **two regions with a hole
//! between them**, because "a buffer lies entirely in one region" (VQ-4, MEM-2) can only be
//! violated, and therefore only be checked, when there is more than one region.

use crate::Target;
use std::io::Write;
use std::sync::{Arc, Mutex};
use vmm::arch::layout::RAM_BASE;
use vmm::memory::{GuestAddress, VecMemory};

pub mod ansi;
pub mod blk;
pub mod cli;
pub mod console;
pub mod cpio;
pub mod elf;
pub mod esr;
pub mod image;
pub mod initrd_plan;
pub mod insn;
pub mod pl011;
pub mod pl031;
pub mod razwi;
pub mod rng;
pub mod smccc;
pub mod stage1;
pub mod tar;
pub mod testdev;
pub mod virtio_mmio;
pub mod virtqueue;
pub mod virtqueue_race;
pub mod zboot;

/// The registry `main.rs` and `lib.rs` use.
pub static ALL: &[Target] = &[
    virtqueue::TARGET,
    virtqueue_race::TARGET,
    virtio_mmio::TARGET,
    blk::TARGET,
    rng::TARGET,
    console::TARGET,
    elf::TARGET,
    image::TARGET,
    initrd_plan::TARGET,
    esr::TARGET,
    insn::TARGET,
    stage1::TARGET,
    pl011::TARGET,
    pl031::TARGET,
    testdev::TARGET,
    razwi::TARGET,
    smccc::TARGET,
    ansi::TARGET,
    cli::TARGET,
    tar::TARGET,
    cpio::TARGET,
    zboot::TARGET,
];

/// Targets `find` knows but `list` and `all` skip: variants that exist for
/// `scripts/bughunt-selftest.sh`, not for the acceptance run.
pub static HIDDEN: &[Target] = &[virtqueue_race::RACE_ONLY];

/// A total reader over the fuzz input (module docs).
pub struct Input<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Input<'a> {
    pub fn new(data: &'a [u8]) -> Input<'a> {
        Input { data, pos: 0 }
    }
    /// True once every byte was consumed.
    pub fn is_empty(&self) -> bool {
        self.pos >= self.data.len()
    }
    pub fn u8(&mut self) -> u8 {
        let b = self.data.get(self.pos).copied().unwrap_or(0);
        self.pos = self.pos.saturating_add(1);
        b
    }
    pub fn le(&mut self, n: usize) -> u64 {
        let v = crate::mutate::get_le(self.data, self.pos, n);
        self.pos = self.pos.saturating_add(n);
        v
    }
    pub fn u16(&mut self) -> u16 {
        u16::try_from(self.le(2)).unwrap_or(0)
    }
    pub fn u32(&mut self) -> u32 {
        u32::try_from(self.le(4)).unwrap_or(0)
    }
    pub fn u64(&mut self) -> u64 {
        self.le(8)
    }
    pub fn bool(&mut self) -> bool {
        self.u8() & 1 == 1
    }
    /// The next `n` bytes (fewer at the end of the input).
    pub fn bytes(&mut self, n: usize) -> &'a [u8] {
        let start = self.pos.min(self.data.len());
        let end = start.saturating_add(n).min(self.data.len());
        self.pos = self.pos.saturating_add(n);
        self.data.get(start..end).unwrap_or_default()
    }
    /// Everything not yet consumed.
    pub fn rest(&mut self) -> &'a [u8] {
        let start = self.pos.min(self.data.len());
        self.pos = self.data.len();
        self.data.get(start..).unwrap_or_default()
    }
}

/// Region A of the fuzz RAM: 256 KiB at the machine's RAM base.
pub const RAM_A: u64 = RAM_BASE;
pub const RAM_A_SIZE: u64 = 0x4_0000;
/// Region B: 64 KiB, 256 KiB after A's end (the hole in between is not RAM).
pub const RAM_B: u64 = RAM_BASE + 0x8_0000;
pub const RAM_B_SIZE: u64 = 0x1_0000;
/// Both regions, for [`in_one_region`] and the mutators.
pub const REGIONS: [(u64, u64); 2] = [(RAM_A, RAM_A_SIZE), (RAM_B, RAM_B_SIZE)];

/// The two-region guest RAM (module docs).
pub fn ram() -> Result<Arc<VecMemory>, String> {
    VecMemory::new(&[
        (GuestAddress(RAM_A), RAM_A_SIZE),
        (GuestAddress(RAM_B), RAM_B_SIZE),
    ])
    .map(Arc::new)
    .map_err(|e| format!("VecMemory: {e:?}"))
}

/// True if `[addr, addr + len)` lies inside a single region, computed in `u128` so that the
/// check itself cannot overflow (the reference model the code under test is compared with).
pub fn in_one_region(addr: u64, len: u64) -> bool {
    let (a, l) = (u128::from(addr), u128::from(len));
    REGIONS.iter().any(|&(b, s)| {
        let (b, s) = (u128::from(b), u128::from(s));
        l > 0 && a >= b && a + l <= b + s
    })
}

/// True if `[a, a + alen)` and `[b, b + blen)` overlap (`u128`, no overflow).
pub fn overlap(a: u64, alen: u64, b: u64, blen: u64) -> bool {
    let (a, alen, b, blen) = (
        u128::from(a),
        u128::from(alen),
        u128::from(b),
        u128::from(blen),
    );
    a < b + blen && b < a + alen
}

/// True if `[a, a + alen)` lies inside `[b, b + blen)`.
pub fn within(a: u64, alen: u64, b: u64, blen: u64) -> bool {
    let (a, alen, b, blen) = (
        u128::from(a),
        u128::from(alen),
        u128::from(b),
        u128::from(blen),
    );
    a >= b && a + alen <= b + blen
}

/// A `Write` that keeps what it was given (a sink's destination in device targets).
#[derive(Clone, Default)]
pub struct Probe(pub Arc<Mutex<Vec<u8>>>);

impl Write for Probe {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        if let Ok(mut v) = self.0.lock() {
            // Bounded: a target never needs more than this to check its invariants.
            if v.len() < (1 << 20) {
                v.extend_from_slice(b);
            }
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Probe {
    pub fn bytes(&self) -> Vec<u8> {
        self.0.lock().map(|v| v.clone()).unwrap_or_default()
    }
}

/// Turn a `Result<_, E: Debug>` into a verdict-friendly `Result<_, String>`.
pub fn ctx<T, E: core::fmt::Debug>(r: Result<T, E>, what: &str) -> Result<T, String> {
    r.map_err(|e| format!("{what}: {e:?}"))
}

/// Make the byte stream of a generic mutation the default structural mutation.
pub fn no_structure(_rng: &mut crate::rng::Rng, _buf: &mut Vec<u8>) {}

/// One guest access to an MMIO device (the `pl011`, `pl031`, `testdev` and `razwi` targets):
/// 11 input bytes `[kind, offset lo, offset hi, value × 8]`. Bit 0 of `kind` is write, bits
/// 1–2 the width; bit 3 is a target-specific "host event" (input arrives, time passes).
#[derive(Clone, Copy, Debug)]
pub struct MmioOp {
    pub write: bool,
    pub size: vmm::bus::AccessSize,
    pub offset: u64,
    pub value: u64,
    pub event: bool,
}

/// Decode up to 512 operations, offsets masked to a `window`-byte device (a power of two).
pub fn mmio_ops(data: &[u8], window: u64) -> Vec<MmioOp> {
    use vmm::bus::AccessSize;
    let mut i = Input::new(data);
    let mut ops = Vec::new();
    while !i.is_empty() && ops.len() < 512 {
        let kind = i.u8();
        let offset = u64::from(i.u16()) & (window - 1);
        let value = i.u64();
        let size = match (kind >> 1) & 3 {
            0 => AccessSize::B1,
            1 => AccessSize::B2,
            2 => AccessSize::B4,
            _ => AccessSize::B8,
        };
        ops.push(MmioOp {
            write: kind & 1 == 1,
            size,
            offset,
            value,
            event: kind & 8 != 0,
        });
    }
    ops
}

/// A seed of `n` MMIO operations mostly aimed at `regs`, 32-bit, small values.
pub fn mmio_seed(rng: &mut crate::rng::Rng, regs: &[u64], n: usize) -> Vec<u8> {
    let mut b = Vec::new();
    for _ in 0..n {
        let mut rec = [0u8; 11];
        rec[0] = u8::from(rng.coin()) | 2 << 1 | if rng.one_in(6) { 8 } else { 0 };
        let off = if rng.one_in(8) {
            rng.below(0x1000)
        } else {
            regs.get(rng.index(regs.len())).copied().unwrap_or(0)
        };
        crate::mutate::put_le(&mut rec, 1, 2, off);
        let v = if rng.coin() {
            rng.below(0x800)
        } else {
            rng.next_u64()
        };
        crate::mutate::put_le(&mut rec, 3, 8, v);
        b.extend_from_slice(&rec);
    }
    b
}

/// A read result never has bits above its width (MMIO-7: the vCPU writes it to a register).
pub fn fits(op: &MmioOp, v: u64) -> crate::Verdict {
    if v & !op.size.mask() != 0 {
        return Err(format!(
            "{}-byte read at {:#x} returned {v:#x}",
            op.size.bytes(),
            op.offset
        ));
    }
    Ok(())
}
