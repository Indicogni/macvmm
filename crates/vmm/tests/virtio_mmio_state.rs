//! PLAN M11 acceptance (host): the virtio-mmio v2 transport's register file and status state
//! machine (virtio 1.2 §2.1, §2.2, §4.2.2, §4.2.3; architecture §11.1; threat model VQ-1,
//! VQ-13..VQ-16). Every case drives `VirtioMmio` through `MmioDevice::read/write` exactly as a
//! vCPU's trapped access would, with a `MockDevice`, `VecMemory` and `TestIrq`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use std::sync::{Arc, Mutex};
use virtio_support::*;
use vmm::bus::{AccessSize, MmioDevice};
use vmm::irq::TestIrq;
use vmm::memory::prelude::*;
use vmm::virtio::mmio::{MAGIC_VALUE, VENDOR_ID, reg};
use vmm::virtio::{VirtioInterrupt, VirtioMmio, features, status as st};

const V1_HI: u32 = 1; // VERSION_1 is bit 32: bit 0 of the high word

struct Fx {
    t: VirtioMmio,
    irq: Arc<TestIrq>,
    mem: Arc<vmm::memory::VecMemory>,
    log: Arc<Mutex<MockLog>>,
}

impl Fx {
    fn new() -> Fx {
        Fx::with(MockDevice::new(&[256, 64]))
    }
    fn with(dev: MockDevice) -> Fx {
        let log = dev.log.clone();
        let irq = Arc::new(TestIrq::new());
        let mem = mem();
        let gm: Arc<dyn GuestMemoryOrdered> = mem.clone();
        let t = VirtioMmio::new(
            Arc::new(Mutex::new(dev)),
            Arc::new(VirtioInterrupt::new(irq.clone())),
            Some(gm),
        )
        .unwrap();
        Fx { t, irq, mem, log }
    }
    fn r(&mut self, off: u64) -> u32 {
        self.t.read(off, AccessSize::B4) as u32
    }
    fn w(&mut self, off: u64, v: u32) {
        self.t.write(off, AccessSize::B4, u64::from(v));
    }
    fn status(&mut self) -> u32 {
        self.r(reg::STATUS)
    }
    /// ACK, DRIVER, write `lo/hi` features, FEATURES_OK; returns the Status read back.
    fn negotiate(&mut self, lo: u32, hi: u32) -> u32 {
        self.w(reg::STATUS, st::ACKNOWLEDGE);
        self.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER);
        self.w(reg::DRIVER_FEATURES_SEL, 0);
        self.w(reg::DRIVER_FEATURES, lo);
        self.w(reg::DRIVER_FEATURES_SEL, 1);
        self.w(reg::DRIVER_FEATURES, hi);
        self.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER | st::FEATURES_OK);
        self.status()
    }
    /// Program queue `sel` with size `n` at the given rings, and make it ready.
    fn setup_queue(&mut self, sel: u32, n: u32, desc: u64, avail: u64, used: u64) {
        self.w(reg::QUEUE_SEL, sel);
        self.w(reg::QUEUE_NUM, n);
        for (lo, a) in [
            (reg::QUEUE_DESC_LOW, desc),
            (reg::QUEUE_DRIVER_LOW, avail),
            (reg::QUEUE_DEVICE_LOW, used),
        ] {
            self.w(lo, a as u32);
            self.w(lo + 4, (a >> 32) as u32);
        }
        self.w(reg::QUEUE_READY, 1);
    }
    /// The full handshake with queue 0 at the default rings; returns Status.
    fn up(&mut self) -> u32 {
        assert_eq!(self.negotiate(0, V1_HI), 11);
        self.setup_queue(0, 8, DESC, AVAIL, USED);
        self.w(reg::STATUS, 15);
        self.status()
    }
}

const DRIVER_OK_ALL: u32 = 15;

#[test]
fn identity_registers() {
    let mut f = Fx::new();
    assert_eq!(f.r(reg::MAGIC), MAGIC_VALUE);
    assert_eq!(f.r(reg::VERSION), 2);
    assert_eq!(f.r(reg::DEVICE_ID), 4);
    assert_eq!(f.r(reg::VENDOR_ID), VENDOR_ID);
    // Identity registers are read-only.
    f.w(reg::DEVICE_ID, 9);
    assert_eq!(f.r(reg::DEVICE_ID), 4);
}

#[test]
fn empty_slot_is_magic_version_and_device_id_0() {
    let mut e = VirtioMmio::empty();
    assert_eq!(e.read(reg::MAGIC, AccessSize::B4) as u32, MAGIC_VALUE);
    assert_eq!(e.read(reg::VERSION, AccessSize::B4), 2);
    assert_eq!(e.read(reg::DEVICE_ID, AccessSize::B4), 0);
    for off in (0x00c..0x200).step_by(4) {
        assert_eq!(e.read(off, AccessSize::B4), 0, "{off:#x}");
        e.write(off, AccessSize::B4, u64::MAX);
    }
    assert_eq!(e.read(reg::STATUS, AccessSize::B4), 0, "writes are ignored");
    assert_eq!(e.read(reg::MAGIC, AccessSize::B1), 0, "narrow: RAZ");
}

#[test]
fn status_bits_only_in_order() {
    let mut f = Fx::new();
    for bad in [
        st::FEATURES_OK,
        st::DRIVER_OK,
        st::ACKNOWLEDGE | st::FEATURES_OK,
        st::DRIVER | st::DRIVER_OK, // DRIVER implies ACK, but DRIVER_OK still skips FEATURES_OK
    ] {
        f.w(reg::STATUS, bad);
        assert_eq!(f.status(), 0, "{bad:#x} from 0");
    }
    // M18: DRIVER implies ACKNOWLEDGE (U-Boot writes DRIVER alone after a reset).
    f.w(reg::STATUS, st::DRIVER);
    assert_eq!(f.status(), st::ACKNOWLEDGE | st::DRIVER);
    f.w(reg::STATUS, 0);
    f.w(reg::STATUS, st::ACKNOWLEDGE);
    f.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER_OK); // skips DRIVER and FEATURES_OK
    assert_eq!(f.status(), st::ACKNOWLEDGE);
    f.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER);
    f.w(reg::STATUS, st::ACKNOWLEDGE | st::DRIVER | st::DRIVER_OK); // skips FEATURES_OK
    assert_eq!(f.status(), 3);
}

#[test]
fn status_bits_cannot_be_cleared_except_by_reset() {
    let mut f = Fx::new();
    f.w(reg::STATUS, 1);
    f.w(reg::STATUS, 3);
    f.w(reg::STATUS, 1);
    assert_eq!(f.status(), 3);
    f.w(reg::STATUS, 2);
    assert_eq!(f.status(), 3);
}

#[test]
fn unknown_and_device_owned_status_bits_are_refused() {
    let mut f = Fx::new();
    f.w(reg::STATUS, 1);
    for bad in [
        1 | 16,
        1 | 32,
        1 | st::DEVICE_NEEDS_RESET,
        1 | 0x100,
        0xffff_ff01,
    ] {
        f.w(reg::STATUS, bad);
        assert_eq!(f.status(), 1, "{bad:#x}");
    }
}

#[test]
fn features_ok_requires_version_1() {
    let mut f = Fx::new();
    assert_eq!(f.negotiate(1, 0), 3, "FEATURES_OK must not latch");
    assert!(f.log.lock().unwrap().acked.is_none());
}

#[test]
fn features_ok_refuses_unoffered_bits() {
    let mut f = Fx::new();
    assert_eq!(f.negotiate(1 | 1 << 5, V1_HI), 3);
}

#[test]
fn features_ok_refuses_every_feature_v1_never_offers() {
    for bit in [
        features::EVENT_IDX,
        features::ACCESS_PLATFORM,
        features::RING_PACKED,
        features::NOTIFICATION_DATA,
        features::RING_RESET,
        features::INDIRECT_DESC, // not offered by this mock
    ] {
        let mut f = Fx::new();
        let all = features::VERSION_1 | bit;
        assert_eq!(f.negotiate(all as u32, (all >> 32) as u32), 3, "{bit:#x}");
    }
}

#[test]
fn features_ok_refuses_bits_beyond_63() {
    let mut f = Fx::new();
    f.w(reg::STATUS, 1);
    f.w(reg::STATUS, 3);
    f.w(reg::DRIVER_FEATURES_SEL, 2);
    f.w(reg::DRIVER_FEATURES, 1);
    assert_eq!(f.negotiate(0, V1_HI) & st::FEATURES_OK, 0);
}

#[test]
fn features_ok_latches_and_acks_the_accepted_set() {
    let mut f = Fx::new();
    f.w(reg::DEVICE_FEATURES_SEL, 0);
    assert_eq!(f.r(reg::DEVICE_FEATURES), 1);
    f.w(reg::DEVICE_FEATURES_SEL, 1);
    assert_eq!(f.r(reg::DEVICE_FEATURES), V1_HI);
    f.w(reg::DEVICE_FEATURES_SEL, 7);
    assert_eq!(f.r(reg::DEVICE_FEATURES), 0);
    assert_eq!(f.negotiate(1, V1_HI), 11);
    assert_eq!(f.log.lock().unwrap().acked, Some(features::VERSION_1 | 1));
    // After FEATURES_OK the feature set is fixed.
    f.w(reg::DRIVER_FEATURES_SEL, 0);
    f.w(reg::DRIVER_FEATURES, 0);
    f.w(reg::STATUS, DRIVER_OK_ALL);
    assert_eq!(f.log.lock().unwrap().acked, Some(features::VERSION_1 | 1));
}

#[test]
fn driver_features_before_driver_bit_are_ignored() {
    let mut f = Fx::new();
    f.w(reg::DRIVER_FEATURES_SEL, 1);
    f.w(reg::DRIVER_FEATURES, V1_HI); // Status is 0: ignored
    f.w(reg::STATUS, 1);
    f.w(reg::STATUS, 3);
    f.w(reg::STATUS, 11);
    assert_eq!(f.status(), 3, "VERSION_1 was never accepted");
}

#[test]
fn queue_num_must_be_a_power_of_two_up_to_the_max() {
    let mut f = Fx::new();
    f.w(reg::QUEUE_SEL, 1);
    assert_eq!(f.r(reg::QUEUE_NUM_MAX), 64);
    for bad in [0, 3, 100, 128, 65, 0x1_0000 + 16, u32::MAX] {
        f.w(reg::QUEUE_NUM, bad);
        assert_eq!(f.t.queue(1).unwrap().size(), 64, "{bad:#x}");
    }
    f.w(reg::QUEUE_NUM, 16);
    assert_eq!(f.t.queue(1).unwrap().size(), 16);
}

#[test]
fn queue_sel_out_of_range_reads_0_and_ignores_writes() {
    let mut f = Fx::new();
    for sel in [2, 31, u32::MAX] {
        f.w(reg::QUEUE_SEL, sel);
        assert_eq!(f.r(reg::QUEUE_NUM_MAX), 0);
        assert_eq!(f.r(reg::QUEUE_READY), 0);
        f.w(reg::QUEUE_NUM, 4);
        f.w(reg::QUEUE_READY, 1);
        f.w(reg::QUEUE_DESC_LOW, 0x1000);
    }
    assert!(!f.t.queue(0).unwrap().ready() && !f.t.queue(1).unwrap().ready());
    assert!(f.t.queue(2).is_none());
}

#[test]
fn queue_registers_are_frozen_once_ready() {
    let mut f = Fx::new();
    f.setup_queue(0, 8, DESC, AVAIL, USED);
    f.w(reg::QUEUE_NUM, 16);
    f.w(reg::QUEUE_DESC_LOW, 0x1234_0000);
    f.w(reg::QUEUE_DRIVER_HIGH, 1);
    f.w(reg::QUEUE_DEVICE_LOW, 0);
    let q = f.t.queue(0).unwrap();
    assert_eq!(q.size(), 8);
    assert_eq!(q.desc_table().0, DESC);
    assert_eq!(q.avail_ring().0, AVAIL);
    assert_eq!(q.used_ring().0, USED);
    // QueueReady may go back to 0 before DRIVER_OK, which unfreezes the queue.
    f.w(reg::QUEUE_READY, 0);
    f.w(reg::QUEUE_NUM, 16);
    assert_eq!(f.t.queue(0).unwrap().size(), 16);
}

#[test]
fn queue_registers_are_frozen_after_driver_ok() {
    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    f.w(reg::QUEUE_SEL, 1); // a queue that is not ready
    f.w(reg::QUEUE_NUM, 8);
    f.w(reg::QUEUE_DESC_LOW, 0x2000);
    f.w(reg::QUEUE_READY, 1);
    assert!(!f.t.queue(1).unwrap().ready());
    assert_eq!(f.t.queue(1).unwrap().size(), 64);
    f.w(reg::QUEUE_SEL, 0);
    f.w(reg::QUEUE_READY, 0);
    assert!(f.t.queue(0).unwrap().ready());
}

#[test]
fn ring_addresses_are_hi_shl_32_or_lo() {
    let mut f = Fx::new();
    f.w(reg::QUEUE_SEL, 0);
    f.w(reg::QUEUE_DESC_HIGH, 0x1);
    f.w(reg::QUEUE_DESC_LOW, 0xffff_fff0);
    assert_eq!(f.t.queue(0).unwrap().desc_table().0, 0x1_ffff_fff0);
    f.w(reg::QUEUE_DESC_LOW, 0x10);
    f.w(reg::QUEUE_DESC_HIGH, 0xffff_ffff);
    assert_eq!(f.t.queue(0).unwrap().desc_table().0, 0xffff_ffff_0000_0010);
}

#[test]
fn narrow_or_unaligned_control_accesses_are_raz_wi() {
    let mut f = Fx::new();
    for (off, size) in [
        (reg::MAGIC, AccessSize::B1),
        (reg::MAGIC, AccessSize::B2),
        (reg::MAGIC, AccessSize::B8),
        (reg::MAGIC + 1, AccessSize::B4),
        (reg::VERSION + 2, AccessSize::B2),
    ] {
        assert_eq!(f.t.read(off, size), 0, "{off:#x} {size:?}");
    }
    f.t.write(reg::STATUS, AccessSize::B1, 1);
    f.t.write(reg::STATUS, AccessSize::B2, 1);
    f.t.write(reg::STATUS, AccessSize::B8, 1);
    f.t.write(reg::STATUS + 1, AccessSize::B4, 1);
    assert_eq!(f.status(), 0);
}

#[test]
fn config_space_is_bounded_per_device_and_read_only_fields_ignore_writes() {
    let mut f = Fx::new();
    assert_eq!(f.t.read(reg::CONFIG, AccessSize::B1), 1);
    assert_eq!(f.t.read(reg::CONFIG + 2, AccessSize::B2), 0x0403);
    assert_eq!(f.t.read(reg::CONFIG, AccessSize::B4), 0x0403_0201);
    assert_eq!(f.t.read(reg::CONFIG, AccessSize::B8), 0x0807_0605_0403_0201);
    // Beyond the 8-byte config space: RAZ, and the write never reaches the device.
    assert_eq!(f.t.read(reg::CONFIG + 6, AccessSize::B4), 0);
    assert_eq!(f.t.read(reg::CONFIG + 8, AccessSize::B1), 0);
    assert_eq!(f.t.read(reg::CONFIG + 0xff, AccessSize::B1), 0);
    f.t.write(reg::CONFIG + 7, AccessSize::B2, 0xffff);
    assert!(f.log.lock().unwrap().config_writes.is_empty());
    // Read-only bytes 0..4 ignore writes; 4..8 take them.
    f.t.write(reg::CONFIG, AccessSize::B8, u64::MAX);
    assert_eq!(f.t.read(reg::CONFIG, AccessSize::B8), 0xffff_ffff_0403_0201);
}

#[test]
fn config_generation_is_stable_and_bumps_on_change() {
    let mut f = Fx::new();
    let g = f.r(reg::CONFIG_GENERATION);
    assert_eq!(f.r(reg::CONFIG_GENERATION), g);
    f.w(reg::CONFIG_GENERATION, 99); // read-only
    assert_eq!(f.r(reg::CONFIG_GENERATION), g);
    f.t.write(reg::CONFIG + 4, AccessSize::B4, 0); // a driver write is not a device change
    assert_eq!(f.r(reg::CONFIG_GENERATION), g);
    f.t.config_changed();
    assert_eq!(f.r(reg::CONFIG_GENERATION), g.wrapping_add(1));
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 2);
    assert!(f.irq.level());
}

#[test]
fn writing_0_resets_everything() {
    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    f.w(reg::QUEUE_SEL, 1);
    f.w(reg::DEVICE_FEATURES_SEL, 1);
    f.t.config_changed();
    assert!(f.irq.level());
    f.w(reg::STATUS, 0);
    assert_eq!(f.status(), 0);
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 0);
    assert!(!f.irq.level());
    assert_eq!(
        f.r(reg::QUEUE_READY),
        0,
        "QueueSel reset to 0, queue 0 not ready"
    );
    let q = f.t.queue(0).unwrap();
    assert!(!q.ready() && q.size() == 256 && q.desc_table().0 == 0);
    assert_eq!(f.r(reg::DEVICE_FEATURES), 1, "selector back to 0");
    assert_eq!(f.log.lock().unwrap().resets, 1);
    // And the device can be brought up again from scratch.
    assert_eq!(f.up(), DRIVER_OK_ALL);
    assert_eq!(f.log.lock().unwrap().activations, 2);
}

#[test]
fn driver_ok_with_a_ring_outside_ram_sets_needs_reset_and_a_config_interrupt() {
    let mut f = Fx::new();
    assert_eq!(f.negotiate(0, V1_HI), 11);
    f.setup_queue(0, 8, DESC, AVAIL, RAM_END - 8); // used ring straddles the end of RAM
    f.w(reg::STATUS, DRIVER_OK_ALL);
    assert_eq!(f.status(), DRIVER_OK_ALL | st::DEVICE_NEEDS_RESET);
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 2);
    assert!(f.irq.level());
    assert_eq!(f.log.lock().unwrap().activations, 0, "never activated");
}

#[test]
fn driver_ok_with_misaligned_or_mmio_rings_sets_needs_reset() {
    for (desc, avail, used) in [
        (DESC + 8, AVAIL, USED),  // descriptor table: 16-byte alignment
        (DESC, AVAIL + 1, USED),  // avail: 2
        (DESC, AVAIL, USED + 2),  // used: 4
        (MMIO_ADDR, AVAIL, USED), // MMIO is not RAM
        (u64::MAX - 15, AVAIL, USED),
    ] {
        let mut f = Fx::new();
        assert_eq!(f.negotiate(0, V1_HI), 11);
        f.setup_queue(0, 8, desc, avail, used);
        f.w(reg::STATUS, DRIVER_OK_ALL);
        assert_ne!(
            f.status() & st::DEVICE_NEEDS_RESET,
            0,
            "{desc:#x} {avail:#x} {used:#x}"
        );
    }
}

#[test]
fn activation_failure_sets_needs_reset() {
    let mut dev = MockDevice::new(&[8]);
    dev.fail_activate = true;
    let mut f = Fx::with(dev);
    assert_eq!(f.up(), DRIVER_OK_ALL | st::DEVICE_NEEDS_RESET);
    assert!(f.irq.level());
}

#[test]
fn needs_reset_freezes_the_device_until_status_0() {
    let mut dev = MockDevice::new(&[8]);
    dev.fail_activate = true;
    let mut f = Fx::with(dev);
    f.up();
    f.w(reg::QUEUE_NOTIFY, 0);
    f.w(reg::STATUS, DRIVER_OK_ALL);
    assert_eq!(f.status(), DRIVER_OK_ALL | st::DEVICE_NEEDS_RESET);
    f.w(reg::STATUS, 0);
    assert_eq!(f.status(), 0);
    assert!(!f.irq.level());
}

#[test]
fn failed_is_latched() {
    let mut f = Fx::new();
    f.w(reg::STATUS, 1);
    f.w(reg::STATUS, 3 | st::FAILED);
    assert_eq!(f.status(), 1 | st::FAILED);
    f.w(reg::STATUS, 3);
    assert_eq!(f.status(), 1 | st::FAILED);
    f.w(reg::STATUS, 0);
    assert_eq!(f.status(), 0);
}

#[test]
fn interrupt_ack_protocol_lowers_the_line() {
    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    let mut ring = Ring::new(f.mem.clone(), 8);
    ring.set_desc(0, d(BUF, 32, WRITE, 0));
    ring.push(0);
    f.w(reg::QUEUE_NOTIFY, 0);
    assert_eq!(ring.used_idx(), 1);
    assert_eq!(ring.used_elem(0), (0, 32));
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 1);
    assert!(f.irq.level());
    f.w(reg::INTERRUPT_ACK, 2); // the wrong bit: stays high
    assert!(f.irq.level());
    f.w(reg::INTERRUPT_ACK, 0xffff_fffd); // unknown bits masked (VQ-16): clears bit 0
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 0);
    assert!(!f.irq.level());
    assert_eq!(f.irq.transitions(), vec![true, false]);
}

#[test]
fn queue_notify_out_of_range_or_too_early_is_ignored() {
    let mut f = Fx::new();
    let mut ring = Ring::new(f.mem.clone(), 8);
    ring.set_desc(0, d(BUF, 32, WRITE, 0));
    ring.push(0);
    f.w(reg::QUEUE_NOTIFY, 0); // before DRIVER_OK
    assert_eq!(f.up(), DRIVER_OK_ALL);
    for bad in [1, 2, 31, u32::MAX] {
        f.w(reg::QUEUE_NOTIFY, bad); // 1 exists but is not ready; the rest do not exist
    }
    assert_eq!(ring.used_idx(), 0);
    assert!(f.log.lock().unwrap().chains.is_empty());
    f.w(reg::QUEUE_NOTIFY, 0);
    assert_eq!(ring.used_idx(), 1);
}

#[test]
fn a_queue_error_while_processing_sets_needs_reset() {
    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    let mut ring = Ring::new(f.mem.clone(), 8);
    ring.set_desc(0, d(BUF, 32, NEXT, 0)); // a self-loop
    ring.push(0);
    f.w(reg::QUEUE_NOTIFY, 0);
    assert_eq!(f.status(), DRIVER_OK_ALL | st::DEVICE_NEEDS_RESET);
    assert_eq!(f.r(reg::INTERRUPT_STATUS), 2);
    assert_eq!(ring.used_idx(), 0, "nothing was returned");
}

#[test]
fn queue_reset_is_raz() {
    let mut f = Fx::new();
    f.w(reg::QUEUE_RESET, 1);
    assert_eq!(f.r(reg::QUEUE_RESET), 0);
    for wo in [
        reg::QUEUE_NUM,
        reg::QUEUE_DESC_LOW,
        reg::DRIVER_FEATURES,
        reg::QUEUE_NOTIFY,
    ] {
        assert_eq!(f.r(wo), 0, "write-only {wo:#x} reads 0");
    }
}

#[test]
fn transport_refuses_badly_built_devices() {
    let irq = || Arc::new(VirtioInterrupt::new(Arc::new(TestIrq::new())));
    let mut no_v1 = MockDevice::new(&[8]);
    no_v1.features = 1;
    let mut packed = MockDevice::new(&[8]);
    packed.features |= features::RING_PACKED;
    let odd = MockDevice::new(&[6]);
    for dev in [no_v1, packed, odd] {
        assert!(VirtioMmio::new(Arc::new(Mutex::new(dev)), irq(), None).is_err());
    }
}

/// M22 fuzz-target invariant, as a property here: after every step of a random register
/// sequence, the line equals `InterruptStatus != 0` and DRIVER_OK is never set without
/// FEATURES_OK (threat model §9.3 `virtio_mmio`).
#[test]
fn random_register_sequences_keep_the_invariants() {
    let s = seed(0x5eed_0011);
    let mut rng = XorShift::new(s);
    for _ in 0..200 {
        let mut f = Fx::new();
        for _ in 0..200 {
            let off = rng.below(0x110) & !3;
            let v = match rng.below(4) {
                0 => rng.below(16) as u32,
                1 => [1, 3, 11, 15, 0][rng.below(5) as usize],
                _ => rng.next() as u32,
            };
            if rng.below(2) == 0 {
                f.w(off, v);
            } else {
                f.r(off);
            }
            let status = f.status();
            assert_eq!(f.irq.level(), f.r(reg::INTERRUPT_STATUS) != 0, "seed {s}");
            if status & st::DRIVER_OK != 0 {
                assert_ne!(status & st::FEATURES_OK, 0, "seed {s}");
            }
        }
    }
}

/// virtio 1.2 §4.2.2 SHMLen/SHMBase: a shared-memory region that does not exist reads length
/// -1 and base all-ones. No v1 device has one, so every SHMSel value gets that answer; Linux
/// `vm_get_shm_region` treats anything else (including 0) as a present region.
#[test]
fn shared_memory_registers_report_no_region() {
    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    for sel in [0, 1, 7, u32::MAX] {
        f.w(reg::SHM_SEL, sel);
        let len = u64::from(f.r(reg::SHM_LEN_HIGH)) << 32 | u64::from(f.r(reg::SHM_LEN_LOW));
        let base = u64::from(f.r(reg::SHM_BASE_HIGH)) << 32 | u64::from(f.r(reg::SHM_BASE_LOW));
        assert_eq!(len, u64::MAX, "SHMLen for id {sel:#x} is -1");
        assert_eq!(base, u64::MAX, "SHMBase for id {sel:#x} is all-ones");
    }
    // Writes to the read-only halves change nothing; SHMSel writes break nothing.
    f.w(reg::SHM_LEN_LOW, 0);
    f.w(reg::SHM_BASE_HIGH, 0);
    assert_eq!(f.r(reg::SHM_LEN_LOW), u32::MAX);
    assert_eq!(f.r(reg::SHM_BASE_HIGH), u32::MAX);
    assert_eq!(f.status(), DRIVER_OK_ALL);
    // An empty slot stays all-RAZ (§4.2.3.1.1: the driver stops at DeviceID 0).
    let mut e = VirtioMmio::empty();
    assert_eq!(e.read(reg::SHM_LEN_LOW, AccessSize::B4), 0);
}

/// VQ-14 (and the M12 `worker_budget` precursor): Status = 0 must wait for an in-flight batch.
/// This thread plays the worker mid-batch by holding the device mutex; a "vCPU" thread writes
/// Status = 0. Until the mutex is released the write must not complete and the device must
/// still hold its queues and its memory handle; afterwards it has reset and dropped both.
/// The memory handle is observed through `Arc::strong_count` on the test's `VecMemory`:
/// the test, the transport and (while activated) the device each hold one.
#[test]
fn status_0_waits_for_the_device_mutex_before_dropping_queues_vq14() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    let mut f = Fx::new();
    assert_eq!(f.up(), DRIVER_OK_ALL);
    let Fx {
        mut t, mem, log, ..
    } = f;
    assert_eq!(
        Arc::strong_count(&mem),
        3,
        "test + transport + activated device"
    );
    let device = Arc::clone(t.device());
    let batch = device.lock().unwrap(); // the "worker" is mid-batch

    let done = Arc::new(AtomicBool::new(false));
    let (started_tx, started_rx) = mpsc::channel();
    let vcpu = {
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            t.write(reg::STATUS, AccessSize::B4, 0);
            done.store(true, Ordering::SeqCst);
            t
        })
    };
    started_rx.recv().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !done.load(Ordering::SeqCst),
        "Status = 0 completed while a batch held the device mutex"
    );
    assert_eq!(log.lock().unwrap().resets, 0, "reset ran under the batch");
    assert_eq!(
        Arc::strong_count(&mem),
        3,
        "the device's memory handle was dropped under the batch"
    );

    drop(batch); // the batch finishes
    let mut t = vcpu.join().unwrap();
    assert!(done.load(Ordering::SeqCst));
    assert_eq!(log.lock().unwrap().resets, 1);
    assert_eq!(
        Arc::strong_count(&mem),
        2,
        "the device dropped its memory handle"
    );
    let q = t.queue(0).unwrap();
    assert!(
        !q.ready() && q.desc_table().0 == 0,
        "the transport's queues are fresh"
    );
    assert_eq!(t.read(reg::STATUS, AccessSize::B4), 0);
}
