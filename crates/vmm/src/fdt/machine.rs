//! The `virt` machine's device tree (architecture §12.2; `docs/research/guest-boot.md` §1.4;
//! course ch10).
//!
//! **Why a device tree at all.** An arm64 kernel does not probe for hardware: it learns where
//! RAM, the interrupt controller, the timer and the UART are from the DTB whose address the
//! boot loader puts in `x0` (Linux `Documentation/arch/arm64/booting.rst` §2 "Setup the device
//! tree", §4 "Call the kernel image": `x0 = physical address of device tree blob`). U-Boot and
//! EDK2 read the same blob at the start of RAM. So this file is the guest's whole view of the
//! board, and every value in it comes from `arch/layout.rs` (the single source of truth): if a
//! node and the layout ever disagreed, the guest would drive a device that is not there.
//!
//! **The tree** mirrors QEMU `virt` (`hw/arm/virt.c`, checked property by property in
//! `guest-boot.md` §1.4), so stock kernels and firmware need nothing special:
//!
//! | Node | Binding | Notes |
//! |---|---|---|
//! | `/` | DT spec §3.2 | `linux,dummy-virt`, `model = "macvmm-virt"`, 2 address and 2 size cells, `interrupt-parent = <&gic>`, `dma-coherent` |
//! | `/chosen` | DT spec §3.6 | `bootargs` (≤ 2047 bytes + NUL, FDT-2), `stdout-path`, initrd range, `rng-seed` (64 bytes), `kaslr-seed` |
//! | `/memory@40000000` | DT spec §3.4 | one bank, `--mem` bytes |
//! | `/cpus/cpu@N` | DT spec §3.7, `arm/cpus.yaml` | `reg = MPIDR & 0xff00ffffff`, `enable-method = "psci"` |
//! | `/psci` | `arm/psci.yaml` | `method = "hvc"`: we trap HVC and implement SMCCC/PSCI (M5) |
//! | `/timer` | `timer/arm,arch_timer.yaml` | PPIs 13, 14, 11, 10, level; no `clock-frequency`, so guests read `CNTFRQ_EL0` (24 MHz) |
//! | `/intc@8000000` | `interrupt-controller/arm,gic-v3.yaml` | GICD + `ncpus` redistributor frames, `#interrupt-cells = 3` |
//! | `/apb-pclk` | `clock/fixed-clock.yaml` | 24 MHz. Mandatory: the AMBA bus refuses to probe a PrimeCell without `apb_pclk` (`drivers/amba/bus.c`) |
//! | `/pl011@9000000`, `/pl031@9010000` | `serial/arm,pl011.yaml`, `rtc/arm,pl031.yaml` | SPI 1 and 2, with `clocks`/`clock-names` |
//! | `/virtio_mmio@…` | `virtio/mmio.yaml` | one per **populated** slot only (none until M11) |
//!
//! **Interrupt specifiers** for `arm,gic-v3` are three cells `<type number flags>`
//! (`include/dt-bindings/interrupt-controller/arm-gic.h`): type 0 = SPI (INTID = 32 + n),
//! 1 = PPI (INTID = 16 + n); flags 4 = level-high (`irq.h`). Every device line on this board is
//! level-high (PLAN §1).
//!
//! **Phandles** are fixed: gic = 1, apb_pclk = 2. Nothing is allocated at run time, so the blob
//! for a given [`MachineDesc`] is byte-for-byte reproducible, and the golden DTS
//! (`tests/golden/virt-1cpu-512m.dts`) can pin it.
//!
//! **Seeds** (FDT-3, FDT-4). [`MachineDesc`] takes `rng_seed` and `kaslr_seed` as plain inputs,
//! so tests are deterministic; the machine build fills them from `backend::entropy` on every
//! boot ([`MachineDesc::from_entropy`]). `--dtb-out` writes [`redact_seeds`]'s copy, with both
//! values zeroed in place, so a dumped DTB never records a boot's KASLR seed or initial
//! entropy. `MachineDesc`'s `Debug` prints neither.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::writer::{
    FDT_BEGIN_NODE, FDT_END, FDT_END_NODE, FDT_HEADER_SIZE, FDT_MAGIC, FDT_NOP, FDT_PROP, FdtError,
    FdtWriter,
};
use crate::arch::layout::{
    GICD_BASE, GICD_SIZE, GICR_BASE, Layout, MAX_CPUS, PL011_BASE, PL031_BASE, RAM_BASE, Region,
    VIRTIO_MMIO_STRIDE, VTIMER_INTID,
};
use crate::backend::entropy::Entropy;
use core::fmt;

/// Fixed phandles (module docs).
pub const GIC_PHANDLE: u32 = 1;
pub const APB_PCLK_PHANDLE: u32 = 2;
/// The fixed APB clock, 24 MHz like QEMU (`virt.c`, `create_fdt`: `clk24mhz`).
pub const APB_PCLK_HZ: u32 = 24_000_000;
/// Interrupt-specifier cells (`dt-bindings/interrupt-controller/arm-gic.h`, `irq.h`).
pub const GIC_SPI: u32 = 0;
pub const GIC_PPI: u32 = 1;
pub const IRQ_TYPE_LEVEL_HIGH: u32 = 4;
/// The four architected-timer PPIs in the order `arm,arch_timer.yaml` lists them: secure
/// physical (13 → INTID 29), non-secure physical (14 → 30), **virtual** (11 → 27, the one
/// HVF delivers as `HV_EXIT_REASON_VTIMER_ACTIVATED`) and hypervisor physical (10 → 26).
pub const TIMER_PPIS: [u32; 4] = [13, 14, 11, 10];
/// `/chosen/rng-seed` length. Linux accepts any length; 64 bytes (512 bits) is what QEMU and
/// U-Boot pass and more than the pool needs to be fully seeded.
pub const RNG_SEED_LEN: usize = 64;
/// The longest `bootargs` string. Linux copies at most `COMMAND_LINE_SIZE` = 2048 bytes
/// *including* the NUL (`arch/arm64/include/uapi/asm/setup.h`, `drivers/of/fdt.c`), so a longer
/// line would be cut silently; we refuse it instead (FDT-2).
pub const MAX_BOOTARGS: usize = 2047;
/// The MPIDR affinity fields that make up a `cpu@N` `reg` (`arm/cpus.yaml`: Aff3 in bits
/// 39:32, Aff2..Aff0 in bits 23:0; bits 31:24 are not affinity).
pub const MPIDR_AFFINITY_MASK: u64 = 0xff_00ff_ffff;

/// Everything about one boot that the tree describes. Pure data: tests fill the seeds with
/// fixed values, the machine build with [`MachineDesc::from_entropy`].
#[derive(Clone, PartialEq, Eq)]
pub struct MachineDesc {
    /// Number of vCPUs, `1..=MAX_CPUS`.
    pub ncpus: u32,
    /// RAM size in bytes (checked against the layout again here).
    pub mem_bytes: u64,
    /// `/chosen/bootargs`, if any (M9: the kernel command line).
    pub bootargs: Option<String>,
    /// `/chosen/linux,initrd-{start,end}`: `[start, end)` (M9).
    pub initrd: Option<(u64, u64)>,
    /// The populated virtio-mmio slot indices (M11), each `< VIRTIO_MMIO_SLOTS`.
    pub virtio_slots: Vec<usize>,
    /// `/chosen/rng-seed`.
    pub rng_seed: [u8; RNG_SEED_LEN],
    /// `/chosen/kaslr-seed`.
    pub kaslr_seed: u64,
}

impl fmt::Debug for MachineDesc {
    /// Never prints the seeds (FDT-4: logs and `--dry-run` must not reveal them).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MachineDesc")
            .field("ncpus", &self.ncpus)
            .field("mem_bytes", &self.mem_bytes)
            .field("bootargs", &self.bootargs)
            .field("initrd", &self.initrd)
            .field("virtio_slots", &self.virtio_slots)
            .field("rng_seed", &"<redacted>")
            .field("kaslr_seed", &"<redacted>")
            .finish()
    }
}

impl MachineDesc {
    /// A description with fresh seeds from the host CSPRNG (FDT-3): what every real boot uses.
    pub fn from_entropy(
        ncpus: u32,
        mem_bytes: u64,
        entropy: &Entropy,
    ) -> std::io::Result<MachineDesc> {
        let mut rng_seed = [0u8; RNG_SEED_LEN];
        entropy.fill(&mut rng_seed)?;
        Ok(MachineDesc {
            ncpus,
            mem_bytes,
            bootargs: None,
            initrd: None,
            virtio_slots: Vec::new(),
            rng_seed,
            kaslr_seed: entropy.u64()?,
        })
    }
}

fn bad(why: impl Into<String>) -> FdtError {
    FdtError::InvalidMachine(why.into())
}

/// The layout row starting at `base` (so a node name and its `reg` come from the same row).
fn row(layout: &Layout, base: u64) -> Result<&Region, FdtError> {
    layout
        .regions
        .iter()
        .find(|r| r.base == base)
        .ok_or_else(|| bad(format!("no layout region at {base:#x}")))
}

/// `<GIC_SPI n IRQ_TYPE_LEVEL_HIGH>` for an SPI INTID (32..=1019, GIC spec IHI 0069 §2.2).
pub fn spi_cells(intid: u32) -> Result<[u32; 3], FdtError> {
    match intid.checked_sub(32) {
        Some(n) if intid <= 1019 => Ok([GIC_SPI, n, IRQ_TYPE_LEVEL_HIGH]),
        _ => Err(bad(format!("INTID {intid} is not an SPI"))),
    }
}

/// An AMBA PrimeCell node (`arm,primecell.yaml`) named from its layout row: `reg`, one
/// level-high SPI, and the APB clock(s) the AMBA bus enables before probing.
fn primecell(
    w: &mut FdtWriter,
    region: &Region,
    compatible: &[&str],
    clock_names: &[&str],
    with_gic: bool,
) -> Result<(), FdtError> {
    let intid = region
        .intid
        .ok_or_else(|| bad(format!("{} has no interrupt", region.name)))?;
    let n = w.begin_node(&format!("{}@{}", region.name, region.unit_address()))?;
    w.prop_strs("compatible", compatible)?;
    w.prop_cells("reg", &reg64(region.base, region.size))?;
    if with_gic {
        w.prop_cells("interrupts", &spi_cells(intid)?)?;
    }
    let clocks: Vec<u32> = clock_names.iter().map(|_| APB_PCLK_PHANDLE).collect();
    w.prop_cells("clocks", &clocks)?;
    w.prop_strs("clock-names", clock_names)?;
    w.end_node(n)
}

/// One `<u64 address u64 size>` entry with 2 address and 2 size cells.
fn reg64(addr: u64, size: u64) -> [u32; 4] {
    let hi = |v: u64| u32::try_from(v >> 32).unwrap_or(u32::MAX);
    let lo = |v: u64| u32::try_from(v & 0xffff_ffff).unwrap_or(u32::MAX);
    [hi(addr), lo(addr), hi(size), lo(size)]
}

/// The DT path the console lives at (`/chosen/stdout-path`, DT spec §3.6).
pub fn stdout_path(layout: &Layout) -> Result<String, FdtError> {
    let r = row(layout, PL011_BASE)?;
    Ok(format!("/{}@{}", r.name, r.unit_address()))
}

// ANCHOR: fdt_machine_chosen
/// `/chosen` (DT spec §3.6; booting.rst §2; Linux `drivers/of/fdt.c`).
fn chosen(w: &mut FdtWriter, layout: &Layout, d: &MachineDesc) -> Result<(), FdtError> {
    let n = w.begin_node("chosen")?;
    if let Some(args) = &d.bootargs {
        // FDT-2: Linux would silently truncate a longer line; a NUL would end it early.
        if args.len() > MAX_BOOTARGS || args.as_bytes().contains(&0) {
            return Err(bad(format!(
                "bootargs must be at most {MAX_BOOTARGS} bytes without NUL"
            )));
        }
        w.prop_str("bootargs", args)?;
    }
    w.prop_str("stdout-path", &stdout_path(layout)?)?;
    if let Some((start, end)) = d.initrd {
        if start >= end {
            return Err(bad("initrd end must be above its start"));
        }
        // Two cells each; the end is exclusive (Linux `early_init_dt_check_for_initrd`).
        w.prop_u64("linux,initrd-start", start)?;
        w.prop_u64("linux,initrd-end", end)?;
    }
    // Fresh per boot from the host CSPRNG (FDT-3); zeroed in --dtb-out copies (FDT-4).
    w.prop_bytes("rng-seed", &d.rng_seed)?;
    w.prop_u64("kaslr-seed", d.kaslr_seed)?;
    w.end_node(n)
}
// ANCHOR_END: fdt_machine_chosen

fn memory(w: &mut FdtWriter, layout: &Layout, d: &MachineDesc) -> Result<(), FdtError> {
    layout
        .ram_end(d.mem_bytes)
        .map_err(|e| bad(format!("memory: {e}")))?;
    let n = w.begin_node(&format!("memory@{RAM_BASE:x}"))?;
    w.prop_str("device_type", "memory")?;
    w.prop_cells("reg", &reg64(RAM_BASE, d.mem_bytes))?;
    w.end_node(n)
}

/// `/cpus` (DT spec §3.7). `reg` is the MPIDR affinity the vCPU is given
/// (`arch::regs::mpidr`), which the GIC redistributor of that vCPU also reports.
fn cpus(w: &mut FdtWriter, d: &MachineDesc) -> Result<(), FdtError> {
    let regs: Vec<u64> = (0..d.ncpus)
        .map(|i| {
            let i = usize::try_from(i).unwrap_or(usize::MAX);
            crate::arch::regs::mpidr(i) & MPIDR_AFFINITY_MASK
        })
        .collect();
    // One address cell unless some CPU has Aff3 ≠ 0 (cpus.yaml).
    let two = regs.iter().any(|&r| r > u64::from(u32::MAX));
    let n = w.begin_node("cpus")?;
    w.prop_u32("#address-cells", if two { 2 } else { 1 })?;
    w.prop_u32("#size-cells", 0)?;
    for reg in regs {
        let c = w.begin_node(&format!("cpu@{reg:x}"))?;
        w.prop_str("device_type", "cpu")?;
        w.prop_str("compatible", "arm,arm-v8")?;
        if two {
            w.prop_u64("reg", reg)?;
        } else {
            w.prop_u32("reg", u32::try_from(reg).unwrap_or(u32::MAX))?;
        }
        w.prop_str("enable-method", "psci")?;
        w.end_node(c)?;
    }
    w.end_node(n)
}

fn psci(w: &mut FdtWriter) -> Result<(), FdtError> {
    let n = w.begin_node("psci")?;
    w.prop_strs("compatible", &["arm,psci-1.0", "arm,psci-0.2", "arm,psci"])?;
    w.prop_str("method", "hvc")?;
    w.end_node(n)
}

// ANCHOR: fdt_machine_timer
/// `/timer` (`arm,arch_timer.yaml`). No `clock-frequency`: the binding says firmware should
/// set `CNTFRQ_EL0` instead, and HVF does (24 MHz, spike finding 4).
fn timer(w: &mut FdtWriter, with_gic: bool) -> Result<(), FdtError> {
    let n = w.begin_node("timer")?;
    w.prop_strs("compatible", &["arm,armv8-timer", "arm,armv7-timer"])?;
    w.prop_null("always-on")?;
    if with_gic {
        let cells: Vec<u32> = TIMER_PPIS
            .iter()
            .flat_map(|&ppi| [GIC_PPI, ppi, IRQ_TYPE_LEVEL_HIGH])
            .collect();
        w.prop_cells("interrupts", &cells)?;
    }
    w.end_node(n)
}
// ANCHOR_END: fdt_machine_timer

// ANCHOR: fdt_machine_gic
/// `/intc@8000000` (`arm,gic-v3.yaml`): the in-kernel GICv3 HVF emulates at the layout bases
/// (`vm::create_vm`). `reg[0]` is the distributor, `reg[1]` one redistributor region of
/// `ncpus` 128 KiB frames (RD_base + SGI_base, IHI 0069 §12.10). No ITS and no v2m frame: the
/// virtio-mmio devices use wired SPIs.
fn gic(w: &mut FdtWriter, layout: &Layout, d: &MachineDesc) -> Result<(), FdtError> {
    let gicr = layout
        .gicr_size(d.ncpus)
        .ok_or_else(|| bad(format!("{} vCPUs (1..={MAX_CPUS})", d.ncpus)))?;
    let n = w.begin_node(&format!("intc@{GICD_BASE:x}"))?;
    w.prop_str("compatible", "arm,gic-v3")?;
    w.prop_u32("#interrupt-cells", 3)?;
    w.prop_null("interrupt-controller")?;
    w.prop_u32("#address-cells", 2)?;
    w.prop_u32("#size-cells", 2)?;
    w.prop_null("ranges")?;
    w.prop_u32("#redistributor-regions", 1)?;
    let mut reg = reg64(GICD_BASE, GICD_SIZE).to_vec();
    reg.extend_from_slice(&reg64(GICR_BASE, gicr));
    w.prop_cells("reg", &reg)?;
    w.prop_u32("phandle", GIC_PHANDLE)?;
    w.end_node(n)
}
// ANCHOR_END: fdt_machine_gic

fn apb_pclk(w: &mut FdtWriter) -> Result<(), FdtError> {
    let n = w.begin_node("apb-pclk")?;
    w.prop_str("compatible", "fixed-clock")?;
    w.prop_u32("#clock-cells", 0)?;
    w.prop_u32("clock-frequency", APB_PCLK_HZ)?;
    w.prop_str("clock-output-names", "clk24mhz")?;
    w.prop_u32("phandle", APB_PCLK_PHANDLE)?;
    w.end_node(n)
}

// ANCHOR: fdt_machine_virtio_slot
/// One `/virtio_mmio@…` node (`virtio/mmio.yaml`; virtio 1.2 §4.2.2): slot `i` of the layout,
/// its 0x200-byte window and its level-high SPI (16 + i). Only populated slots are described:
/// a node for an empty slot would make the guest probe a device that answers "no device".
fn virtio_slot(w: &mut FdtWriter, layout: &Layout, slot: usize) -> Result<(), FdtError> {
    let (base, intid) = layout
        .virtio_slot(slot)
        .ok_or_else(|| bad(format!("virtio slot {slot} does not exist")))?;
    let n = w.begin_node(&format!("virtio_mmio@{base:x}"))?;
    w.prop_str("compatible", "virtio,mmio")?;
    w.prop_cells("reg", &reg64(base, VIRTIO_MMIO_STRIDE))?;
    w.prop_cells("interrupts", &spi_cells(intid)?)?;
    w.prop_null("dma-coherent")?;
    w.end_node(n)
}
// ANCHOR_END: fdt_machine_virtio_slot

/// Build the blob for `desc` on `layout` (module docs). Deterministic for a given `desc`.
pub fn build_dtb(layout: &Layout, desc: &MachineDesc) -> Result<Vec<u8>, FdtError> {
    build_dtb_with(layout, desc, true)
}

/// [`build_dtb`], or with `with_gic = false` the tree of the `--irqchip none` teaching mode
/// (M8, architecture §9.1): no `intc` node, no root `interrupt-parent`, and no `interrupts`
/// on the timer and the PrimeCells, since nothing could deliver them. Test guests in that
/// mode do not read the tree; this keeps it self-consistent anyway (no dangling phandle).
pub fn build_dtb_with(
    layout: &Layout,
    desc: &MachineDesc,
    with_gic: bool,
) -> Result<Vec<u8>, FdtError> {
    if desc.ncpus == 0 || desc.ncpus > MAX_CPUS {
        return Err(bad(format!("{} vCPUs (1..={MAX_CPUS})", desc.ncpus)));
    }
    let mut slots = desc.virtio_slots.clone();
    slots.sort_unstable();
    if slots.windows(2).any(|p| p.first() == p.get(1)) {
        return Err(bad("a virtio slot is listed twice"));
    }
    let mut w = FdtWriter::new();
    let root = w.begin_node("")?;
    w.prop_str("compatible", "linux,dummy-virt")?;
    w.prop_str("model", "macvmm-virt")?;
    w.prop_u32("#address-cells", 2)?;
    w.prop_u32("#size-cells", 2)?;
    if with_gic {
        w.prop_u32("interrupt-parent", GIC_PHANDLE)?;
    }
    w.prop_null("dma-coherent")?;
    chosen(&mut w, layout, desc)?;
    memory(&mut w, layout, desc)?;
    cpus(&mut w, desc)?;
    psci(&mut w)?;
    timer(&mut w, with_gic)?;
    if with_gic {
        gic(&mut w, layout, desc)?;
    }
    apb_pclk(&mut w)?;
    primecell(
        &mut w,
        row(layout, PL011_BASE)?,
        &["arm,pl011", "arm,primecell"],
        &["uartclk", "apb_pclk"],
        with_gic,
    )?;
    primecell(
        &mut w,
        row(layout, PL031_BASE)?,
        &["arm,pl031", "arm,primecell"],
        &["apb_pclk"],
        with_gic,
    )?;
    for slot in slots {
        virtio_slot(&mut w, layout, slot)?;
    }
    w.end_node(root)?;
    // The boot CPU is vCPU 0, whose `reg` is 0.
    w.finish(0)
}

/// The vtimer PPI the tree lists must be the one the layout (and HVF) uses.
const _: () = assert!(TIMER_PPIS[2] + 16 == VTIMER_INTID);

/// A copy of `blob` (one [`build_dtb`] produced) with the values of every `rng-seed` and
/// `kaslr-seed` property zeroed in place, so lengths and offsets are unchanged (FDT-4: what
/// `--dtb-out` writes).
///
/// This walks the structure block's tokens (DT spec §5.4) just far enough to find property
/// values. It is not `fdt/reader.rs` (which must stay unreachable from `macvmm run`, FDT-1),
/// it only ever sees the blob the VMM itself just generated, and it is bounds-checked anyway.
/// Both properties must be found exactly once, so a redaction can never silently do nothing.
pub fn redact_seeds(blob: &[u8]) -> Result<Vec<u8>, FdtError> {
    let be = |at: usize| -> Result<usize, FdtError> {
        let b: [u8; 4] = at
            .checked_add(4)
            .and_then(|end| blob.get(at..end))
            .and_then(|s| s.try_into().ok())
            .ok_or(FdtError::Malformed("truncated"))?;
        usize::try_from(u32::from_be_bytes(b)).map_err(|_| FdtError::Malformed("offset"))
    };
    if blob.len() < FDT_HEADER_SIZE || be(0)? != FDT_MAGIC as usize || be(4)? != blob.len() {
        return Err(FdtError::Malformed("not a complete device tree"));
    }
    let (off_struct, off_strings) = (be(8)?, be(12)?);
    let strings_end = off_strings
        .checked_add(be(32)?)
        .ok_or(FdtError::Malformed("strings block"))?;
    let strings = blob
        .get(off_strings..strings_end)
        .ok_or(FdtError::Malformed("strings block"))?;
    let end = off_struct
        .checked_add(be(36)?)
        .filter(|&e| e <= blob.len())
        .ok_or(FdtError::Malformed("structure block"))?;
    let align4 = |p: usize| p.checked_next_multiple_of(4).unwrap_or(usize::MAX);
    let step = |p: usize, n: usize| p.saturating_add(n);
    let mut out = blob.to_vec();
    let (mut rng, mut kaslr) = (0u32, 0u32);
    let mut pos = off_struct;
    while pos < end {
        let tok = be(pos)?;
        pos = step(pos, 4);
        match u32::try_from(tok).unwrap_or(u32::MAX) {
            FDT_BEGIN_NODE => {
                let name_len = blob
                    .get(pos..end)
                    .and_then(|s| s.iter().position(|&b| b == 0))
                    .ok_or(FdtError::Malformed("unterminated node name"))?;
                pos = align4(step(step(pos, name_len), 1));
            }
            FDT_END_NODE | FDT_NOP => {}
            FDT_PROP => {
                let (len, nameoff) = (be(pos)?, be(step(pos, 4))?);
                let value = step(pos, 8);
                let value_end = value
                    .checked_add(len)
                    .filter(|&e| e <= end)
                    .ok_or(FdtError::Malformed("property value"))?;
                let name = strings
                    .get(nameoff..)
                    .and_then(|s| s.split(|&b| b == 0).next())
                    .ok_or(FdtError::Malformed("property name"))?;
                let counter = match name {
                    b"rng-seed" => Some(&mut rng),
                    b"kaslr-seed" => Some(&mut kaslr),
                    _ => None,
                };
                if let Some(c) = counter {
                    *c = c.saturating_add(1);
                    out.get_mut(value..value_end)
                        .ok_or(FdtError::Malformed("property value"))?
                        .fill(0);
                }
                pos = align4(value_end);
            }
            FDT_END => break,
            _ => return Err(FdtError::Malformed("unknown token")),
        }
    }
    if rng != 1 || kaslr != 1 {
        return Err(FdtError::Malformed(
            "seed properties not found exactly once",
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spi_cells_bounds() {
        assert_eq!(spi_cells(33), Ok([0, 1, 4]));
        assert_eq!(spi_cells(1019), Ok([0, 987, 4]));
        assert!(spi_cells(31).is_err());
        assert!(spi_cells(1020).is_err());
        assert_eq!(reg64(0x1_2345_6789, 0x10), [1, 0x2345_6789, 0, 0x10]);
    }

    #[test]
    fn debug_never_prints_seeds() {
        let d = MachineDesc {
            ncpus: 1,
            mem_bytes: 64 << 20,
            bootargs: None,
            initrd: None,
            virtio_slots: vec![],
            rng_seed: [0xab; RNG_SEED_LEN],
            kaslr_seed: 0x1234_5678_9abc_def0,
        };
        let s = format!("{d:?}");
        assert!(!s.contains("171") && !s.contains("ab, ab") && !s.contains("1234"));
        assert!(s.contains("<redacted>"));
    }
}
