//! Shared helpers for the virtio host tests (`virtio_mmio_state.rs`, `virtqueue_hostile.rs`,
//! `virtqueue_toctou.rs`): a guest RAM (`VecMemory`), a split-ring builder that plays the
//! driver, a `MockDevice` that plays a device model, and the xorshift PRNG (seeded, so a failure replays).
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::sync::{Arc, Mutex};
use vmm::memory::prelude::*;
use vmm::memory::{Access, VecMemory};
use vmm::virtio::chain::{F_INDIRECT, F_NEXT, F_WRITE};
use vmm::virtio::{
    Descriptor, Queue, QueueError, QueueProgress, ValidatedChain, VirtioDevice, VirtioError,
    VirtioInterrupt, features,
};

pub const RAM: u64 = 0x4000_0000;
pub const RAM_SIZE: u64 = 0x10_0000; // 1 MiB
pub const RAM_END: u64 = RAM + RAM_SIZE;
/// Default ring placement inside RAM (each far enough apart for N = 256).
pub const DESC: u64 = RAM + 0x1000;
pub const AVAIL: u64 = RAM + 0x4000;
pub const USED: u64 = RAM + 0x5000;
/// Buffers start here.
pub const BUF: u64 = RAM + 0x8000;
/// An address in the PL011 window: MMIO, never RAM.
pub const MMIO_ADDR: u64 = 0x0900_0000;

pub fn mem() -> Arc<VecMemory> {
    Arc::new(VecMemory::new(&[(GuestAddress(RAM), RAM_SIZE)]).unwrap())
}

/// xorshift64* (Vigna 2016).
pub struct XorShift(pub u64);
impl XorShift {
    pub fn new(seed: u64) -> XorShift {
        XorShift(seed.max(1))
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

/// Print a test note to stderr (no `print!` in crates/vmm, RUST-5).
pub fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// `MACVMM_SEED` or a default.
pub fn seed(default: u64) -> u64 {
    std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

pub fn d(addr: u64, len: u32, flags: u16, next: u16) -> Descriptor {
    Descriptor {
        addr,
        len,
        flags,
        next,
    }
}
pub const NEXT: u16 = F_NEXT;
pub const WRITE: u16 = F_WRITE;
pub const INDIRECT: u16 = F_INDIRECT;

/// The driver's side of one split ring.
pub struct Ring {
    pub mem: Arc<VecMemory>,
    pub size: u16,
    pub desc: u64,
    pub avail: u64,
    pub used: u64,
    pub avail_idx: u16,
}

impl Ring {
    pub fn new(mem: Arc<VecMemory>, size: u16) -> Ring {
        Ring::at(mem, size, DESC, AVAIL, USED)
    }
    pub fn at(mem: Arc<VecMemory>, size: u16, desc: u64, avail: u64, used: u64) -> Ring {
        Ring {
            mem,
            size,
            desc,
            avail,
            used,
            avail_idx: 0,
        }
    }
    /// The device-side queue for this ring, ready.
    pub fn queue(&self) -> Queue {
        let mut q = Queue::new(self.size);
        q.set_size(self.size);
        q.set_desc_table(GuestAddress(self.desc));
        q.set_avail_ring(GuestAddress(self.avail));
        q.set_used_ring(GuestAddress(self.used));
        q.set_ready(true);
        q
    }
    pub fn set_desc(&self, i: u16, desc: Descriptor) {
        self.mem
            .write(
                GuestAddress(self.desc + 16 * u64::from(i)),
                &desc.to_le_bytes(),
            )
            .unwrap();
    }
    /// Write a descriptor into an arbitrary table (indirect tables).
    pub fn set_desc_at(&self, table: u64, i: u16, desc: Descriptor) {
        self.mem
            .write(GuestAddress(table + 16 * u64::from(i)), &desc.to_le_bytes())
            .unwrap();
    }
    /// Publish `head` in the next avail slot and bump avail.idx.
    pub fn push(&mut self, head: u16) {
        let slot = u64::from(self.avail_idx % self.size);
        self.mem
            .write_u16(GuestAddress(self.avail + 4 + 2 * slot), head)
            .unwrap();
        self.avail_idx = self.avail_idx.wrapping_add(1);
        self.mem
            .write_u16(GuestAddress(self.avail + 2), self.avail_idx)
            .unwrap();
    }
    pub fn set_avail_idx(&mut self, idx: u16) {
        self.avail_idx = idx;
        self.mem
            .write_u16(GuestAddress(self.avail + 2), idx)
            .unwrap();
    }
    pub fn set_avail_flags(&self, flags: u16) {
        self.mem.write_u16(GuestAddress(self.avail), flags).unwrap();
    }
    pub fn used_idx(&self) -> u16 {
        self.mem.read_u16(GuestAddress(self.used + 2)).unwrap()
    }
    /// Used element `slot`: `(id, len)`.
    pub fn used_elem(&self, slot: u16) -> (u32, u32) {
        let a = self.used + 4 + 8 * u64::from(slot % self.size);
        (
            self.mem.read_u32(GuestAddress(a)).unwrap(),
            self.mem.read_u32(GuestAddress(a + 4)).unwrap(),
        )
    }
}

/// Pop one chain and validate it (the common path of the hostile tests).
pub fn pop_validated(
    q: &mut Queue,
    mem: &VecMemory,
    max_total: u64,
) -> Result<Option<ValidatedChain>, QueueError> {
    match q.pop(mem)? {
        None => Ok(None),
        Some(c) => c.into_validated(max_total).map(Some),
    }
}

/// Reads of `[addr, addr + 16)` in the access log.
pub fn reads_of(log: &[Access], addr: u64, len: u64) -> usize {
    log.iter()
        .filter(|a| !a.write && !a.fence && a.addr == addr && a.len == len)
        .count()
}

/// What the mock device recorded.
#[derive(Debug, Default)]
pub struct MockLog {
    pub acked: Option<u64>,
    pub activations: usize,
    pub resets: usize,
    pub chains: Vec<ValidatedChain>,
    pub config_writes: Vec<(u32, Vec<u8>)>,
}

/// A device model for transport and queue tests: config bytes 0..4 read-only, 4..8 writable;
/// `process_queue` fills writable buffers with `0xab` and returns the chain with the byte count.
pub struct MockDevice {
    pub id: u32,
    pub sizes: Vec<u16>,
    pub features: u64,
    pub config: [u8; 8],
    pub max_total: u64,
    pub fail_activate: bool,
    pub log: Arc<Mutex<MockLog>>,
    mem: Option<Arc<dyn GuestMemoryOrdered>>,
    queues: Vec<Queue>,
    irq: Option<Arc<VirtioInterrupt>>,
}

impl MockDevice {
    pub fn new(sizes: &[u16]) -> MockDevice {
        MockDevice {
            id: 4,
            sizes: sizes.to_vec(),
            features: features::VERSION_1 | 1,
            config: [1, 2, 3, 4, 5, 6, 7, 8],
            max_total: 64 * 1024,
            fail_activate: false,
            log: Arc::new(Mutex::new(MockLog::default())),
            mem: None,
            queues: Vec::new(),
            irq: None,
        }
    }
}

impl VirtioDevice for MockDevice {
    fn device_id(&self) -> u32 {
        self.id
    }
    fn queue_max_sizes(&self) -> &[u16] {
        &self.sizes
    }
    fn device_features(&self) -> u64 {
        self.features
    }
    fn ack_features(&mut self, accepted: u64) {
        self.log.lock().unwrap().acked = Some(accepted);
    }
    fn config_len(&self) -> u32 {
        8
    }
    fn read_config(&self, offset: u32, data: &mut [u8]) {
        let o = offset as usize;
        data.copy_from_slice(&self.config[o..o + data.len()]);
    }
    fn write_config(&mut self, offset: u32, data: &[u8]) {
        self.log
            .lock()
            .unwrap()
            .config_writes
            .push((offset, data.to_vec()));
        for (i, b) in data.iter().enumerate() {
            let at = offset as usize + i;
            if at >= 4 {
                self.config[at] = *b; // bytes 0..4 are read-only (VQ-13)
            }
        }
    }
    fn activate(
        &mut self,
        mem: Arc<dyn GuestMemoryOrdered>,
        queues: Vec<Queue>,
        irq: Arc<VirtioInterrupt>,
    ) -> Result<(), VirtioError> {
        if self.fail_activate {
            return Err(VirtioError::Device("mock activation failure"));
        }
        self.log.lock().unwrap().activations += 1;
        self.mem = Some(mem);
        self.queues = queues;
        self.irq = Some(irq);
        Ok(())
    }
    fn process_queue(&mut self, index: usize, budget: u16) -> Result<QueueProgress, VirtioError> {
        let mem = self.mem.clone().ok_or(VirtioError::NotActivated)?;
        let q = self
            .queues
            .get_mut(index)
            .ok_or(VirtioError::NoSuchQueue(index))?;
        let mut used = false;
        let mut progress = QueueProgress::Drained;
        for n in 0..=budget {
            if n == budget {
                progress = QueueProgress::MoreWork;
                break;
            }
            let Some(chain) = q.pop(&*mem)? else { break };
            let v = chain.into_validated(self.max_total)?;
            let fill = vec![0xab; v.writable_len as usize];
            let written = v.write_writable(&*mem, &fill)?;
            q.add_used(&*mem, v.head, written)?;
            self.log.lock().unwrap().chains.push(v);
            used = true;
        }
        if used
            && q.should_interrupt(&*mem)?
            && let Some(irq) = &self.irq
        {
            irq.signal_used();
        }
        Ok(progress)
    }
    fn reset(&mut self) {
        self.log.lock().unwrap().resets += 1;
        self.mem = None;
        self.queues.clear();
        self.irq = None;
    }
}
