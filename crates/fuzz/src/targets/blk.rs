//! Target `blk`: the virtio-blk device model (`vmm::virtio::blk`; virtio 1.2 §5.2; architecture
//! §11.3; threat model BLK-1..BLK-7, BLK-9, VQ-8, VQ-9, VQ-11) against hostile requests and a
//! failing backend.
//!
//! **Input:** byte 0 flags (bit 0 read-only disk, bit 1 the driver accepts no optional feature,
//! bit 2 `INDIRECT_DESC` on the queue, bit 3 the backend's `sync` fails, bit 4 the backend
//! returns short reads, bit 5 EIO on reads); byte 1 the request count; then 24 bytes per request:
//! `type: u32, sector: u64, data descriptors: u8, three lengths: u16 × 3, write mask: u8,
//! status length: u8, header length: u8` (0 = 16), 2 spare bytes. The target lays each request
//! out as a chain (header, data, status) in guest RAM, as a driver would.
//!
//! **Invariants** (threat model §9.3 "blk"):
//! 1. the mock backend sees no access outside `[0, capacity)` and **no write at all** on a
//!    read-only disk (BLK-2, BLK-4);
//! 2. every completed request's status byte is 0, 1 or 2 (OK, IOERR, UNSUPP; §5.2.6), and the
//!    status of a request that was not completed is untouched;
//! 3. the used `len` never exceeds the chain's writable length (VQ-9);
//! 4. every read buffer handed to the backend was zeroed first (VQ-11: no stale host bytes).

use super::{Input, ram};
use crate::Target;
use crate::mutate::put_le;
use crate::rng::Rng;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use vmm::backend::file::BlockBackend;
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::virtio::blk::{BLK_QUEUE_SIZE, req};
use vmm::virtio::chain::{F_INDIRECT, F_NEXT, F_WRITE};
use vmm::virtio::{Blk, Descriptor, VirtioDevice, VirtioInterrupt};

pub const TARGET: Target = Target {
    name: "blk",
    run,
    seed,
    mutate,
    max_len: 2 + 24 * MAX_REQS,
};

const MAX_REQS: usize = 8;
const SECTORS: u64 = 64;
const DESC: u64 = super::RAM_A + 0x1000;
const AVAIL: u64 = super::RAM_A + 0x2000;
const USED: u64 = super::RAM_A + 0x3000;
const IND: u64 = super::RAM_A + 0x5000;
/// Each request's buffers live in its own 0x6000-byte slot from here.
const SLOTS: u64 = super::RAM_A + 0x8000;
const SLOT: u64 = 0x6000;
const SENTINEL: u8 = 0xee;

/// An in-memory disk that records violations instead of panicking.
struct Disk {
    data: Mutex<Vec<u8>>,
    ro: bool,
    fail_sync: bool,
    short: bool,
    eio: bool,
    violation: Mutex<Option<String>>,
    dirty: AtomicBool,
}

impl Disk {
    fn flag(&self, why: String) {
        if let Ok(mut v) = self.violation.lock() {
            v.get_or_insert(why);
        }
    }
    fn span(&self, off: u64, len: usize) -> Option<(usize, usize)> {
        let start = usize::try_from(off).ok()?;
        let end = start.checked_add(len)?;
        let cap = usize::try_from(SECTORS * 512).ok()?;
        (end <= cap).then_some((start, end))
    }
}

impl BlockBackend for Disk {
    fn capacity_sectors(&self) -> u64 {
        SECTORS
    }
    fn read_only(&self) -> bool {
        self.ro
    }
    fn read_at(&self, buf: &mut [u8], offset: u64) -> io::Result<usize> {
        if buf.iter().any(|b| *b != 0) {
            self.dirty.store(true, Ordering::SeqCst);
        }
        if self.eio {
            return Err(io::Error::from_raw_os_error(5));
        }
        let Some((s, e)) = self.span(offset, buf.len()) else {
            self.flag(format!(
                "read of {} bytes at {offset:#x} past the {SECTORS}-sector disk (BLK-2)",
                buf.len()
            ));
            return Ok(0);
        };
        let n = if self.short { (e - s) / 2 } else { e - s };
        let d = self.data.lock().map_err(|_| io::Error::other("lock"))?;
        if let (Some(dst), Some(src)) = (buf.get_mut(..n), d.get(s..s + n)) {
            dst.copy_from_slice(src);
        }
        Ok(n)
    }
    fn write_at(&self, buf: &[u8], offset: u64) -> io::Result<usize> {
        if self.ro {
            self.flag("a write reached the backend of a read-only disk (BLK-4)".into());
        }
        let Some((s, e)) = self.span(offset, buf.len()) else {
            self.flag(format!(
                "write of {} bytes at {offset:#x} past the {SECTORS}-sector disk (BLK-2)",
                buf.len()
            ));
            return Ok(0);
        };
        let mut d = self.data.lock().map_err(|_| io::Error::other("lock"))?;
        if let Some(dst) = d.get_mut(s..e) {
            dst.copy_from_slice(buf);
        }
        Ok(buf.len())
    }
    fn sync(&self) -> io::Result<()> {
        if self.fail_sync {
            Err(io::Error::from_raw_os_error(5))
        } else {
            Ok(())
        }
    }
}

struct Request {
    head: u16,
    /// The last writable byte: where the device puts the status (BLK-3).
    status_at: Option<u64>,
    /// The byte there before the device ran.
    initial: u8,
    writable: u64,
}

/// Run one batch of requests (module docs).
pub fn run(data: &[u8]) -> crate::Verdict {
    let mut input = Input::new(data);
    let flags = input.u8();
    let count = 1 + usize::from(input.u8()) % MAX_REQS;
    let disk = Arc::new(Disk {
        data: Mutex::new(vec![0x5a; usize::try_from(SECTORS * 512).unwrap_or(0)]),
        ro: flags & 1 != 0,
        fail_sync: flags & 8 != 0,
        short: flags & 16 != 0,
        eio: flags & 32 != 0,
        violation: Mutex::new(None),
        dirty: AtomicBool::new(false),
    });
    let mem = ram()?;
    let mut blk = Blk::new(disk.clone(), 0);
    let accepted = if flags & 2 != 0 {
        vmm::virtio::features::VERSION_1
    } else {
        blk.device_features()
    };
    blk.ack_features(accepted);
    let mut q = vmm::virtio::Queue::new(BLK_QUEUE_SIZE);
    q.set_size(BLK_QUEUE_SIZE);
    q.set_desc_table(GuestAddress(DESC));
    q.set_avail_ring(GuestAddress(AVAIL));
    q.set_used_ring(GuestAddress(USED));
    let indirect = flags & 4 != 0;
    q.set_indirect(indirect);
    q.set_ready(true);
    let vi = Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
    super::ctx(blk.activate(gm, vec![q], vi), "activate")?;

    let w = |addr: u64, b: &[u8]| super::ctx(mem.write(GuestAddress(addr), b), "setup");
    let mut next_desc: u16 = 0;
    let mut next_ind: u64 = 0;
    let mut reqs = Vec::new();
    for i in 0..count {
        let rtype = input.u32();
        let sector = input.u64();
        let ndata = usize::from(input.u8() % 4);
        let lens = [input.u16(), input.u16(), input.u16()];
        let wmask = input.u8();
        let status_len = u32::from(input.u8() % 4);
        let hdr_len = match input.u8() {
            0 => 16,
            n => u32::from(n % 32),
        };
        let _ = input.u16();
        let slot = SLOTS + SLOT * u64::try_from(i).unwrap_or(0);
        let mut hdr = [0u8; 16];
        put_le(&mut hdr, 0, 4, u64::from(rtype));
        put_le(&mut hdr, 8, 8, sector);
        w(slot, &hdr)?;
        let mut chain = vec![Descriptor {
            addr: slot,
            len: hdr_len,
            flags: 0,
            next: 0,
        }];
        let mut at = slot + 0x100;
        let mut writable = 0u64;
        for (k, &l) in lens.iter().enumerate().take(ndata) {
            let l = u32::from(l) % 0x1800;
            let write = wmask & (1 << k) != 0;
            chain.push(Descriptor {
                addr: at,
                len: l,
                flags: if write { F_WRITE } else { 0 },
                next: 0,
            });
            if write {
                writable += u64::from(l);
            }
            at += 0x1800;
        }
        let status = slot + SLOT - 0x10;
        w(status, &[SENTINEL])?;
        if status_len > 0 {
            chain.push(Descriptor {
                addr: status,
                len: status_len,
                flags: F_WRITE,
                next: 0,
            });
            writable += u64::from(status_len);
        }
        let status_at = chain
            .iter()
            .rev()
            .find(|d| d.flags & F_WRITE != 0 && d.len > 0)
            .map(|d| d.addr + u64::from(d.len) - 1);
        let initial = match status_at {
            Some(a) => super::ctx(mem.read_u8(GuestAddress(a)), "status")?,
            None => 0,
        };
        // Link the chain, in the main table or through the indirect table.
        let n = u16::try_from(chain.len()).unwrap_or(0);
        let (table, base) = if indirect && i % 2 == 1 {
            (IND + 16 * next_ind, 0u16)
        } else {
            (DESC + 16 * u64::from(next_desc), next_desc)
        };
        for (k, d) in chain.iter_mut().enumerate() {
            let k = u16::try_from(k).unwrap_or(0);
            if k + 1 < n {
                d.flags |= F_NEXT;
                d.next = base + k + 1;
            }
            w(table + 16 * u64::from(k), &d.to_le_bytes())?;
        }
        let head = next_desc;
        if indirect && i % 2 == 1 {
            let d = Descriptor {
                addr: table,
                len: 16 * u32::from(n),
                flags: F_INDIRECT,
                next: 0,
            };
            w(DESC + 16 * u64::from(next_desc), &d.to_le_bytes())?;
            next_desc += 1;
            next_ind += u64::from(n);
        } else {
            next_desc += n;
        }
        super::ctx(
            mem.write_u16(
                GuestAddress(AVAIL + 4 + 2 * u64::try_from(i).unwrap_or(0)),
                head,
            ),
            "avail",
        )?;
        reqs.push(Request {
            head,
            status_at,
            initial,
            writable,
        });
    }
    super::ctx(
        mem.write_u16(GuestAddress(AVAIL + 2), u16::try_from(count).unwrap_or(0)),
        "avail.idx",
    )?;
    let _ = blk.process_queue(0, BLK_QUEUE_SIZE);

    if let Some(v) = disk.violation.lock().ok().and_then(|v| v.clone()) {
        return Err(v);
    }
    if disk.dirty.load(Ordering::SeqCst) {
        return Err("a read buffer handed to the backend was not zeroed (VQ-11)".into());
    }
    let used = super::ctx(mem.read_u16(GuestAddress(USED + 2)), "used.idx")?;
    let mut done = vec![false; reqs.len()];
    for slot in 0..u64::from(used.min(BLK_QUEUE_SIZE)) {
        let id = super::ctx(mem.read_u32(GuestAddress(USED + 4 + 8 * slot)), "used id")?;
        let len = super::ctx(mem.read_u32(GuestAddress(USED + 8 + 8 * slot)), "used len")?;
        let Some((k, r)) = reqs
            .iter()
            .enumerate()
            .find(|(_, r)| u32::from(r.head) == id)
        else {
            return Err(format!("used element names head {id}, never posted"));
        };
        if u64::from(len) > r.writable {
            return Err(format!(
                "used len {len} > writable {} for head {id} (VQ-9)",
                r.writable
            ));
        }
        if let Some(d) = done.get_mut(k) {
            *d = true;
        }
        if let Some(a) = r.status_at {
            let s = super::ctx(mem.read_u8(GuestAddress(a)), "status")?;
            if s > 2 {
                return Err(format!("status byte {s} for head {id} (§5.2.6)"));
            }
        }
    }
    for (r, d) in reqs.iter().zip(&done) {
        if let (false, Some(a)) = (*d, r.status_at) {
            let s = super::ctx(mem.read_u8(GuestAddress(a)), "status")?;
            if s != r.initial {
                return Err(format!(
                    "head {} was not completed but its status byte changed to {s}",
                    r.head
                ));
            }
        }
    }
    Ok(())
}

/// Well-formed reads, writes, flushes and GET_IDs.
fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![rng.byte() & 0x3f, rng.below(MAX_REQS as u64) as u8];
    for _ in 0..MAX_REQS {
        let (t, wmask) = match rng.below(4) {
            0 => (req::IN, 0xff),
            1 => (req::OUT, 0),
            2 => (req::FLUSH, 0),
            _ => (req::GET_ID, 0xff),
        };
        let mut r = [0u8; 24];
        put_le(&mut r, 0, 4, u64::from(t));
        put_le(&mut r, 4, 8, rng.below(SECTORS + 2));
        r[12] = if t == req::FLUSH {
            0
        } else {
            1 + rng.below(3) as u8
        };
        for k in 0..3 {
            put_le(&mut r, 13 + 2 * k, 2, 512 * (1 + rng.below(4)));
        }
        r[19] = wmask;
        r[20] = 1;
        r[21] = 0;
        b.extend_from_slice(&r);
    }
    b
}

/// Aim a request field at a boundary.
fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    if buf.len() < 2 + 24 {
        return;
    }
    let r = 2 + 24 * rng.index((buf.len() - 2) / 24);
    match rng.below(4) {
        0 => put_le(
            buf,
            r,
            4,
            rng.pick(&[0u64, 1, 4, 8, 11, 13, 0xffff_ffff]).unwrap_or(0),
        ),
        1 => put_le(
            buf,
            r + 4,
            8,
            rng.pick(&[
                SECTORS - 1,
                SECTORS,
                SECTORS + 1,
                u64::MAX,
                u64::MAX >> 9,
                1 << 55,
            ])
            .unwrap_or(0),
        ),
        2 => put_le(
            buf,
            r + 13 + 2 * rng.index(3),
            2,
            rng.pick(&[0u64, 1, 511, 513, 4096, 0x17ff]).unwrap_or(0),
        ),
        _ => {
            if let Some(f) = buf.first_mut() {
                *f ^= 1 << rng.below(6);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut rng = Rng::new(5);
        for _ in 0..500 {
            let mut s = seed(&mut rng);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut rng, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
