//! A minimal GICv3 driver for test guests: the distributor, this CPU's redistributor, and the
//! CPU interface's system registers (course ch12; PLAN M8; architecture §9).
//!
//! **Which GIC.** macvmm uses Hypervisor.framework's in-kernel GICv3 (ADR-0004) at the QEMU
//! `virt` addresses: GICD at `0x0800_0000`, the redistributors from `0x080A_0000`, one 128 KiB
//! frame pair per vCPU (RD_base + SGI_base). Guest accesses to both are handled inside the
//! kernel with zero exits to the VMM (spike finding 13), and so are the `ICC_*` registers. The
//! framework's GIC reports `GICD_CTLR.DS = 1` (one security state, finding 15), so the guest
//! sees one interrupt group to enable, Group 1, and needs no secure-side setup.
//!
//! **Bring-up, in the order the GICv3 architecture specification (ARM IHI 0069) requires:**
//! 1. [`init_distributor`]: `GICD_CTLR.ARE` (affinity routing, §12.9.4) and `EnableGrp1`, then
//!    wait for `GICD_CTLR.RWP` to clear (§12.9.4: register writes have taken effect);
//! 2. [`Redist::find`]: walk the redistributor frames and pick the one whose 64-bit
//!    `GICR_TYPER.Affinity` (§12.11.37, bits 63:32) equals this CPU's MPIDR affinity. **The
//!    read must be 64 bits wide**: a 32-bit read of `GICR_TYPER` returns 0 on HVF (spike
//!    finding 18), so `Last` (bit 4) and the affinity would never be seen. Frames are assigned
//!    in vCPU *creation* order, not by MPIDR (finding 17), which is why the guest searches;
//! 3. [`Redist::wake`]: clear `GICR_WAKER.ProcessorSleep` (bit 1) and wait for
//!    `ChildrenAsleep` (bit 2) to clear (§12.11.43), or the redistributor never forwards an
//!    interrupt to this CPU;
//! 4. [`init_cpu_interface`]: `ICC_SRE_EL1.SRE = 1` (system-register interface, §12.2.21),
//!    `ICC_PMR_EL1 = 0xff` (let every priority through, §12.2.16), `ICC_BPR1_EL1 = 0`, and
//!    `ICC_IGRPEN1_EL1 = 1` (§12.2.14).
//!
//! Then per interrupt: an SPI (INTID 32..1019) is configured in the distributor
//! ([`enable_spi`]: group, priority, level trigger, `GICD_IROUTER` = this CPU's affinity,
//! enable); an SGI/PPI (0..31) in this CPU's redistributor SGI_base frame ([`Redist::enable_ppi`]).
//! A handler acknowledges with [`ack`] (`ICC_IAR1_EL1`, INTID 1023 = spurious, §2.2.1) and
//! finishes with [`eoi`] (`ICC_EOIR1_EL1`, priority drop + deactivate with `EOImode = 0`).
//!
//! All MMIO accesses are naturally aligned 32- or 64-bit `ldr`/`str` (the priority bytes are
//! written with a 32-bit read-modify-write) so they work with the MMU off.

use core::arch::asm;

/// GICD base in the `virt` map (PLAN §1).
pub const GICD_BASE: usize = 0x0800_0000;
/// First redistributor frame (PLAN §1).
pub const GICR_BASE: usize = 0x080A_0000;
/// One vCPU's redistributor: RD_base (64 KiB) + SGI_base (64 KiB) (IHI 0069 §12.10).
pub const GICR_STRIDE: usize = 0x2_0000;
/// The end of the redistributor window (where the PL011 starts).
pub const GICR_WINDOW_END: usize = 0x0900_0000;
/// The INTID `ICC_IAR1_EL1` returns when nothing is pending (IHI 0069 §2.2.1).
pub const SPURIOUS: u32 = 1023;

const GICD_CTLR: usize = 0x0000;
const GICD_IGROUPR: usize = 0x0080;
const GICD_ISENABLER: usize = 0x0100;
const GICD_IPRIORITYR: usize = 0x0400;
const GICD_ICFGR: usize = 0x0c00;
const GICD_IROUTER: usize = 0x6000;
const CTLR_ENABLE_GRP1: u32 = 1 << 1;
const CTLR_ARE: u32 = 1 << 4;
const CTLR_DS: u32 = 1 << 6;
const CTLR_RWP: u32 = 1 << 31;

const GICR_TYPER: usize = 0x0008;
const GICR_WAKER: usize = 0x0014;
const TYPER_LAST: u64 = 1 << 4;
const WAKER_PROCESSOR_SLEEP: u32 = 1 << 1;
const WAKER_CHILDREN_ASLEEP: u32 = 1 << 2;
const SGI_BASE: usize = 0x1_0000;
const GICR_IGROUPR0: usize = SGI_BASE + 0x0080;
const GICR_ISENABLER0: usize = SGI_BASE + 0x0100;
const GICR_IPRIORITYR: usize = SGI_BASE + 0x0400;

/// The priority every test interrupt gets (lower is more urgent; anything below the 0xff mask).
pub const PRIORITY: u8 = 0x80;

fn rd32(addr: usize) -> u32 {
    // SAFETY: an aligned 32-bit load from a GIC register (handled by the in-kernel GIC).
    unsafe { core::ptr::read_volatile(addr as *const u32) }
}

fn wr32(addr: usize, v: u32) {
    // SAFETY: an aligned 32-bit store to a GIC register.
    unsafe { core::ptr::write_volatile(addr as *mut u32, v) }
}

fn rd64(addr: usize) -> u64 {
    // SAFETY: an aligned 64-bit load (one `ldr x`) from a GIC register; GICR_TYPER must be read
    // 64 bits wide (module docs).
    unsafe { core::ptr::read_volatile(addr as *const u64) }
}

fn wr64(addr: usize, v: u64) {
    // SAFETY: an aligned 64-bit store to a GIC register (GICD_IROUTER<n>).
    unsafe { core::ptr::write_volatile(addr as *mut u64, v) }
}

/// Set one priority byte with an aligned 32-bit read-modify-write.
fn set_priority_byte(base: usize, intid: u32, prio: u8) {
    let word = base + (intid as usize & !3);
    let shift = (intid % 4) * 8;
    let v = (rd32(word) & !(0xff << shift)) | (u32::from(prio) << shift);
    wr32(word, v);
}

/// This CPU's MPIDR_EL1.
pub fn mpidr() -> u64 {
    let v: u64;
    // SAFETY: reads an ID register; no side effects.
    unsafe { asm!("mrs {}, mpidr_el1", out(reg) v, options(nomem, nostack)) };
    v
}

/// The affinity as `GICR_TYPER` reports it (Aff3.Aff2.Aff1.Aff0 in 32 bits).
pub fn affinity32(mpidr: u64) -> u32 {
    let aff3 = (mpidr >> 32) & 0xff;
    ((aff3 << 24) | (mpidr & 0x00ff_ffff)) as u32
}

/// The affinity as `GICD_IROUTER` wants it (Aff3 in bits 39:32, Interrupt_Routing_Mode = 0).
pub fn irouter_affinity(mpidr: u64) -> u64 {
    mpidr & 0xff_00ff_ffff
}

fn wait_rwp() {
    while rd32(GICD_BASE + GICD_CTLR) & CTLR_RWP != 0 {
        core::hint::spin_loop();
    }
}

// ANCHOR: guest_gic_init
/// Step 1: enable affinity routing and Group 1 in the distributor.
pub fn init_distributor() {
    let ctlr = rd32(GICD_BASE + GICD_CTLR);
    wr32(
        GICD_BASE + GICD_CTLR,
        (ctlr & CTLR_DS) | CTLR_ARE | CTLR_ENABLE_GRP1,
    );
    wait_rwp();
}

/// Step 4: the CPU interface (system registers).
pub fn init_cpu_interface() {
    // SAFETY: GICv3 CPU-interface system registers (IHI 0069 §12.2); EL1 owns them, and the
    // writes only change which interrupts this CPU accepts.
    unsafe {
        asm!(
            "mrs {t}, icc_sre_el1",
            "orr {t}, {t}, #1",
            "msr icc_sre_el1, {t}",
            "isb",
            "msr icc_pmr_el1, {pmr}",
            "msr icc_bpr1_el1, xzr",
            "msr icc_igrpen1_el1, {one}",
            "isb",
            t = out(reg) _,
            pmr = in(reg) 0xffu64,
            one = in(reg) 1u64,
            options(nostack),
        );
    }
}

/// Steps 1–4 for the calling CPU: distributor, redistributor lookup and wake (`Redist`,
/// anchor `guest_gic_redist`), CPU interface.
/// Returns the redistributor, or `None` if no frame matches this CPU's affinity.
pub fn init() -> Option<Redist> {
    init_distributor();
    let rd = Redist::find(mpidr())?;
    rd.wake();
    init_cpu_interface();
    Some(rd)
}
// ANCHOR_END: guest_gic_init

// ANCHOR: guest_gic_redist
/// One CPU's redistributor.
#[derive(Clone, Copy, Debug)]
pub struct Redist {
    /// RD_base of the frame.
    pub base: usize,
}

impl Redist {
    /// Step 2: the frame whose 64-bit `GICR_TYPER.Affinity` is `mpidr`'s, or `None`.
    pub fn find(mpidr: u64) -> Option<Redist> {
        let want = affinity32(mpidr);
        let mut base = GICR_BASE;
        while base + GICR_STRIDE <= GICR_WINDOW_END {
            let typer = rd64(base + GICR_TYPER);
            if (typer >> 32) as u32 == want {
                return Some(Redist { base });
            }
            if typer & TYPER_LAST != 0 {
                return None;
            }
            base += GICR_STRIDE;
        }
        None
    }

    /// Step 3: wake the redistributor (`GICR_WAKER`).
    pub fn wake(self) {
        let w = self.base + GICR_WAKER;
        wr32(w, rd32(w) & !WAKER_PROCESSOR_SLEEP);
        while rd32(w) & WAKER_CHILDREN_ASLEEP != 0 {
            core::hint::spin_loop();
        }
    }
}
// ANCHOR_END: guest_gic_redist

impl Redist {
    /// Route SGI/PPI `intid` (0..31) to Group 1 at [`PRIORITY`] and enable it.
    pub fn enable_ppi(self, intid: u32) {
        let bit = 1u32 << (intid % 32);
        let g = self.base + GICR_IGROUPR0;
        wr32(g, rd32(g) | bit);
        set_priority_byte(self.base + GICR_IPRIORITYR, intid, PRIORITY);
        wr32(self.base + GICR_ISENABLER0, bit);
    }
}

/// `ID_AA64PFR0_EL1.GIC` (bits 27:24, ARM ARM D19.2.64) as **this CPU** sees it, read with an
/// `MRS` in the guest: 1 = the GICv3/v4 CPU-interface system registers are implemented. Linux
/// checks this field before it touches any `ICC_*` register, so it is the guest-side half of
/// risk R3 (the VMM-side read through `hv_vcpu_get_sys_reg` is `hvf_gic_live`'s).
pub fn pfr0_gic() -> u64 {
    let v: u64;
    // SAFETY: an EL1-readable ID register; no side effects.
    unsafe { asm!("mrs {}, id_aa64pfr0_el1", out(reg) v, options(nomem, nostack)) };
    (v >> 24) & 0xf
}

// ANCHOR: guest_gic_enable_spi
/// Configure SPI `intid` (32..1019): Group 1, [`PRIORITY`], level-sensitive, routed to the CPU
/// with MPIDR `target`, enabled (IHI 0069 §12.9: IGROUPR, IPRIORITYR, ICFGR, IROUTER,
/// ISENABLER).
pub fn enable_spi(intid: u32, target: u64) {
    let n = intid as usize;
    let bit = 1u32 << (intid % 32);
    let g = GICD_BASE + GICD_IGROUPR + (n / 32) * 4;
    wr32(g, rd32(g) | bit);
    set_priority_byte(GICD_BASE + GICD_IPRIORITYR, intid, PRIORITY);
    let cfg = GICD_BASE + GICD_ICFGR + (n / 16) * 4;
    wr32(cfg, rd32(cfg) & !(2 << ((intid % 16) * 2))); // 0 = level-sensitive
    wr64(GICD_BASE + GICD_IROUTER + n * 8, irouter_affinity(target));
    wr32(GICD_BASE + GICD_ISENABLER + (n / 32) * 4, bit);
    wait_rwp();
}
// ANCHOR_END: guest_gic_enable_spi

// ANCHOR: guest_gic_ack_eoi
/// Acknowledge the highest-priority pending Group 1 interrupt (`ICC_IAR1_EL1`); [`SPURIOUS`]
/// when there is none.
pub fn ack() -> u32 {
    let v: u64;
    // SAFETY: reading IAR1 acknowledges an interrupt; it has no memory effects.
    unsafe { asm!("mrs {}, icc_iar1_el1", out(reg) v, options(nomem, nostack)) };
    (v & 0x00ff_ffff) as u32
}

/// End the interrupt `intid` returned by [`ack`] (`ICC_EOIR1_EL1`). Never for [`SPURIOUS`].
pub fn eoi(intid: u32) {
    // SAFETY: writing EOIR1 drops the running priority and deactivates `intid`.
    unsafe { asm!("msr icc_eoir1_el1, {}", "isb", in(reg) u64::from(intid), options(nostack)) };
}
// ANCHOR_END: guest_gic_ack_eoi
