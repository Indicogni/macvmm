//! `BootPlan`: where every boot image goes and how the boot vCPU starts (architecture §6.7,
//! §12.3; threat model LDR-5).
//!
//! **Why a separate, pure planning step.** Deciding *where* is policy and has no side
//! effects, so it can be printed (`--dry-run`, M9), property-tested without HVF (LDR-5, M9),
//! and checked completely *before* a VM is created. Loading is then mechanical: copy what the
//! plan says, through `GuestMemory`.
//!
//! **Images, then the device tree.** The plan holds the ELF and `--raw` placements and the
//! entry state. The start of RAM belongs to the device tree (PLAN §1: the DTB at the RAM base,
//! 8-byte aligned, booting.rst §2): no image may overlap its first 512 KiB (where test guests
//! begin), and `x0` is its address (booting.rst §4: `x0 = physical address of device tree
//! blob`). The tree's contents depend on the machine, not on the images, so it is built after
//! planning; [`BootPlan::set_dtb_len`] then sizes the slot to the actual blob and checks it
//! against [`BootPlan::dtb_limit`]: at most 2 MiB (`DTB_MAX`, booting.rst §2) and never past
//! the lowest loaded image (M7).
//!
//! **Entry state** (Linux `Documentation/arch/arm64/booting.rst` §4, which our test guests
//! follow too): `CPSR = 0x3c5` (EL1h, D, A, I and F masked), PC = the ELF entry, or the first
//! `--raw` address when there is no `--kernel`.
//!
//! **M9: the Linux boot.** For an arm64 Image the plan is the PLAN §1 table: the 2 MiB DTB
//! slot at the RAM base, the kernel at `LINUX_IMAGE_BASE + text_offset` covering its whole
//! `image_size` ([`image::place`]), the initrd at the next 2 MiB boundary above that, inside
//! the booting.rst §4 window ([`initrd::place`]), PC = the kernel's first byte and `x0` = the
//! DTB. `--initrd` and `--cmdline` are Linux-only and refused for ELF and `--raw` boots, and
//! the command line is checked against FDT-2 here, so a bad one is exit code 2 before any VM
//! exists. The plan is pure and deterministic; `tests/bootplan.rs` checks it with 10,000
//! random size combinations (LDR-5).
//!
//! **M18: the firmware boot** ([`plan_firmware`]). With `--bios` nothing is loaded into RAM
//! but the device tree: the image goes into flash bank 0 (`loader::firmware`), and the vCPU
//! starts where a real Cortex-A core starts after reset on QEMU's `virt` board, at the bottom
//! of flash (`PC = FLASH0_BASE = 0`; QEMU `hw/arm/boot.c` enters `-bios` firmware at the flash
//! base). The device tree still sits at the start of RAM with `x0` pointing at it: QEMU puts
//! it there for firmware too, and U-Boot's `qemu-arm` board finds it at that address
//! (`board/emulation/qemu-arm/qemu-arm.c`, `board_fdt_blob_setup`), while firmware that
//! follows the Linux convention reads `x0`. The slot may use the full 2 MiB (no image above
//! it), and `CPSR = 0x3c5` (EL1h, DAIF masked) is the reset state firmware expects at EL1:
//! the guest has no EL2 here (architecture §8.4). `--initrd`, `--cmdline`, `--kernel` and
//! `--raw` are refused with `--bios` (`config.rs`): the firmware loads the OS from a disk.

#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::{ImageKind, LoaderError, RamRange, detect, elf, image, initrd, overlaps, raw};
use crate::arch::layout::{DTB_MAX, DTB_MAX_TEST_GUEST, PL011_BASE};
use crate::memory::{GuestAddress, GuestMemory};
use core::fmt;
use std::sync::Arc;

/// EL1h with DAIF masked: `M[3:0] = 0b0101`, `F I A D` = bits 6..9 (ARM ARM C5.2.18, SPSR_EL2).
pub const CPSR_EL1H_DAIF_MASKED: u64 = 0x3c5;
/// The longest kernel command line: Linux keeps `COMMAND_LINE_SIZE` = 2048 bytes *including*
/// the NUL (`arch/arm64/include/uapi/asm/setup.h`), so 2047 characters (FDT-2).
pub const MAX_CMDLINE: usize = crate::fdt::machine::MAX_BOOTARGS;

// ANCHOR: linux_cmdline_default
/// The command line an Image gets without `--cmdline` (architecture §12.1): the PL011 as the
/// console and as the early console, so even a kernel that dies before its serial driver
/// probes prints something (`earlycon=pl011,<addr>` selects `drivers/tty/serial/amba-pl011.c`'s
/// early console, Linux `Documentation/admin-guide/kernel-parameters.txt` "earlycon"; `ttyAMA0`
/// is the name that driver gives the first PL011). The e2e tests add `panic=-1` (reboot at
/// once on a panic, which `--on-reset exit` turns into exit code 4) and `macvmm.test=<case>`
/// for the test initramfs (PLAN M10). Built from `layout.rs`: the one place a UART address
/// appears in a string.
pub fn default_cmdline() -> String {
    format!("console=ttyAMA0 earlycon=pl011,{PL011_BASE:#010x}")
}
// ANCHOR_END: linux_cmdline_default

/// One thing placed in guest RAM.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub what: String,
    pub addr: u64,
    pub len: u64,
}

/// The boot inputs, as bytes from `HostIo`.
#[derive(Clone, Copy, Debug, Default)]
pub struct BootInputs<'a> {
    pub kernel: Option<&'a [u8]>,
    pub raw: &'a [(u64, Arc<[u8]>)],
    /// `--initrd` (M9; Image kernels only).
    pub initrd: Option<&'a [u8]>,
    /// `--cmdline` (M9; Image kernels only). `None` gives an Image [`default_cmdline`].
    pub cmdline: Option<&'a str>,
}

/// The complete, validated boot plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootPlan {
    pub entry: u64,
    pub cpsr: u64,
    pub x0: u64,
    /// The guest RAM this plan was checked against.
    pub ram: RamRange,
    /// The device-tree slot: reserved by [`plan`], sized to the blob by
    /// [`BootPlan::set_dtb_len`] (M7).
    pub dtb: Placement,
    /// The largest blob that fits: `min(DTB_MAX, RAM size, lowest image - RAM base)`.
    pub dtb_limit: u64,
    /// Every image, in load order.
    pub images: Vec<Placement>,
    /// The parsed kernel ELF, if `--kernel` was an ELF.
    pub elf: Option<elf::ElfImage>,
    /// The placed arm64 Image, if `--kernel` was one (M9).
    pub image: Option<image::ArmImage>,
    /// The initrd `[start, end)` (M9), for `/chosen/linux,initrd-{start,end}`.
    pub initrd: Option<(u64, u64)>,
    /// `/chosen/bootargs` (M9): `--cmdline`, or [`default_cmdline`] for an Image.
    pub bootargs: Option<String>,
    /// M18: the `--bios` image in flash bank 0 (outside RAM: not one of `images`).
    pub firmware: Option<Placement>,
}

/// The row label of a placement in the printed plan.
fn label(what: &str) -> &'static str {
    if what.starts_with("kernel") {
        "kernel"
    } else if what.starts_with("initrd") {
        "initrd"
    } else if what.starts_with("ELF") {
        "elf"
    } else if what.starts_with("--raw") {
        "raw"
    } else if what.starts_with("device tree") {
        "dtb"
    } else if what.starts_with("firmware") {
        "flash0"
    } else {
        "image"
    }
}

impl fmt::Display for BootPlan {
    /// The `--dry-run` plan (PLAN M9): one row per placement, `label  start..end  what`, then
    /// the entry state. Hex without padding, so the rows read like the PLAN §1 table.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ram_end = self.ram.base.saturating_add(self.ram.size);
        writeln!(
            f,
            "{:<8}{:#x}..{ram_end:#x}  {} MiB",
            "ram",
            self.ram.base,
            self.ram.size >> 20
        )?;
        let rows = self
            .firmware
            .iter()
            .chain(core::iter::once(&self.dtb))
            .chain(&self.images);
        for p in rows {
            let end = p.addr.saturating_add(p.len);
            writeln!(
                f,
                "{:<8}{:#x}..{end:#x}  {} ({} bytes)",
                label(&p.what),
                p.addr,
                p.what,
                p.len
            )?;
        }
        if let Some(img) = &self.image {
            writeln!(
                f,
                "{:<8}text_offset={:#x} image_size={:#x} file={:#x} page_size={:?}",
                "header",
                img.header.text_offset,
                img.header.image_size,
                img.file_len,
                img.header.page_size
            )?;
        }
        if let Some(args) = &self.bootargs {
            writeln!(f, "{:<8}{args:?}", "cmdline")?;
        }
        writeln!(
            f,
            "{:<8}pc={:#x} x0={:#x} cpsr={:#x}",
            "entry", self.entry, self.x0, self.cpsr
        )
    }
}

/// Validate `--cmdline` (FDT-2): at most [`MAX_CMDLINE`] bytes and no NUL, which would end the
/// DT string early.
pub fn check_cmdline(s: &str) -> Result<(), LoaderError> {
    if s.len() > MAX_CMDLINE || s.as_bytes().contains(&0) {
        return Err(LoaderError::BadCmdline { len: s.len() });
    }
    Ok(())
}

/// Plan a boot into `ram` (module docs). Every overlap and bound is checked here. Pure: no
/// I/O, no HVF, deterministic (LDR-5).
pub fn plan(ram: RamRange, inputs: &BootInputs<'_>) -> Result<BootPlan, LoaderError> {
    let dtb = Placement {
        what: "device tree (reserved)".into(),
        addr: ram.base,
        len: DTB_MAX_TEST_GUEST.min(ram.size),
    };
    let mut images: Vec<Placement> = Vec::new();
    let mut entry = None;
    let mut parsed = None;
    let mut arm_image = None;
    let mut initrd_range = None;
    let mut bootargs = None;
    if let Some(args) = inputs.cmdline {
        check_cmdline(args)?;
    }
    let kind = inputs.kernel.map(detect);
    if kind != Some(ImageKind::ArmImage) {
        if inputs.initrd.is_some() {
            return Err(LoaderError::LinuxOnly { what: "--initrd" });
        }
        if inputs.cmdline.is_some() {
            return Err(LoaderError::LinuxOnly { what: "--cmdline" });
        }
    }
    if let Some(bytes) = inputs.kernel {
        match detect(bytes) {
            ImageKind::Elf => {
                let img = elf::parse(bytes, ram, core::slice::from_ref(&dtb))?;
                entry = Some(img.entry);
                images.extend(img.segments.iter().map(|s| Placement {
                    what: format!("ELF segment {}", s.index),
                    addr: s.paddr,
                    len: s.memsz,
                }));
                parsed = Some(img);
            }
            ImageKind::ArmImage => {
                let img = image::place(bytes, ram)?;
                let p = img.placement();
                if overlaps(p.addr, p.len, dtb.addr, DTB_MAX.min(ram.size)) {
                    return Err(LoaderError::OverlapsDtb { what: p.what });
                }
                // booting.rst §4: PC = the kernel's first byte (the Image header's `code0`).
                entry = Some(img.load);
                images.push(p);
                if let Some(rd) = inputs.initrd {
                    let size = u64::try_from(rd.len()).unwrap_or(u64::MAX);
                    let (start, end) = initrd::place(ram, img.load, img.end, size)?;
                    images.push(Placement {
                        what: "initrd".into(),
                        addr: start,
                        len: size,
                    });
                    initrd_range = Some((start, end));
                }
                bootargs = Some(inputs.cmdline.map_or_else(default_cmdline, str::to_owned));
                arm_image = Some(img);
            }
            ImageKind::EfiZboot => return Err(LoaderError::EfiZboot),
            ImageKind::Raw => return Err(LoaderError::NotAKernel),
        }
    }
    for (index, (addr, bytes)) in inputs.raw.iter().enumerate() {
        let len = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        let p = raw::check_placement(ram, index, *addr, len)?;
        if overlaps(p.addr, p.len, dtb.addr, dtb.len) {
            return Err(LoaderError::OverlapsDtb { what: p.what });
        }
        if let Some(other) = images
            .iter()
            .find(|o| overlaps(p.addr, p.len, o.addr, o.len))
        {
            return Err(LoaderError::Overlap {
                a: p.what,
                b: other.what.clone(),
            });
        }
        entry = entry.or(Some(p.addr));
        images.push(p);
    }
    let entry = entry.ok_or(LoaderError::NoImage)?;
    // ANCHOR: plan_dtb_limit
    // The DTB may grow up to 2 MiB, but never into the lowest image (images above RAM are
    // impossible here: every placement was checked against `ram` above).
    let lowest = images.iter().map(|p| p.addr).min().unwrap_or(u64::MAX);
    let dtb_limit = DTB_MAX.min(ram.size).min(lowest.saturating_sub(ram.base));
    // ANCHOR_END: plan_dtb_limit
    Ok(BootPlan {
        entry,
        cpsr: CPSR_EL1H_DAIF_MASKED,
        x0: dtb.addr,
        ram,
        dtb,
        dtb_limit,
        images,
        elf: parsed,
        image: arm_image,
        initrd: initrd_range,
        bootargs,
        firmware: None,
    })
}

// ANCHOR: bootplan_firmware
/// Plan a firmware boot (M18, module docs): `image` goes into the flash bank `rom`
/// (`(base, size)`, checked here against LDR-1), RAM holds only the device tree, and the
/// vCPU starts at the bottom of flash with `x0` = the DTB. Pure, like [`plan`].
pub fn plan_firmware(
    ram: RamRange,
    rom: (u64, u64),
    image: &[u8],
) -> Result<BootPlan, LoaderError> {
    let (rom_base, rom_size) = rom;
    super::firmware::check_rom_image(image, rom_size).map_err(LoaderError::Firmware)?;
    let len = u64::try_from(image.len()).unwrap_or(u64::MAX);
    Ok(BootPlan {
        entry: rom_base, // the reset vector: the first word of flash
        cpsr: CPSR_EL1H_DAIF_MASKED,
        x0: ram.base, // the DTB (booting.rst §4; U-Boot qemu-arm reads it at the RAM base)
        ram,
        dtb: Placement {
            what: "device tree (reserved)".into(),
            addr: ram.base,
            len: DTB_MAX.min(ram.size),
        },
        dtb_limit: DTB_MAX.min(ram.size),
        images: Vec::new(),
        elf: None,
        image: None,
        initrd: None,
        bootargs: None,
        firmware: Some(Placement {
            what: format!("firmware (flash bank 0, {rom_size:#x}-byte ROM, rest zero)"),
            addr: rom_base,
            len,
        }),
    })
}
// ANCHOR_END: bootplan_firmware

impl BootPlan {
    /// Size the device-tree slot to a `len`-byte blob, which must fit in
    /// [`BootPlan::dtb_limit`] (module docs).
    pub fn set_dtb_len(&mut self, len: u64) -> Result<(), LoaderError> {
        if len == 0 || len > self.dtb_limit {
            return Err(LoaderError::DtbTooLarge {
                len,
                limit: self.dtb_limit,
            });
        }
        self.dtb = Placement {
            what: "device tree".into(),
            addr: self.dtb.addr,
            len,
        };
        Ok(())
    }
}

/// Copy the device tree into its slot. `dtb` must be the blob [`BootPlan::set_dtb_len`] sized
/// the slot for.
pub fn load_dtb(plan: &BootPlan, dtb: &[u8], mem: &dyn GuestMemory) -> Result<(), LoaderError> {
    let len = u64::try_from(dtb.len()).unwrap_or(u64::MAX);
    if len != plan.dtb.len || len > plan.dtb_limit {
        return Err(LoaderError::DtbTooLarge {
            len,
            limit: plan.dtb_limit,
        });
    }
    mem.write(GuestAddress(plan.dtb.addr), dtb)?;
    Ok(())
}

/// Copy every image of `plan` into `mem`.
pub fn load(
    plan: &BootPlan,
    inputs: &BootInputs<'_>,
    mem: &dyn GuestMemory,
) -> Result<(), LoaderError> {
    if let (Some(img), Some(bytes)) = (&plan.elf, inputs.kernel) {
        elf::load(img, bytes, mem)?;
    }
    if let (Some(img), Some(bytes)) = (&plan.image, inputs.kernel) {
        image::load(img, bytes, mem)?;
    }
    if let (Some((start, end)), Some(bytes)) = (plan.initrd, inputs.initrd) {
        if u64::try_from(bytes.len()).ok() != end.checked_sub(start) {
            return Err(LoaderError::OutsideRam {
                what: "initrd".into(),
                addr: start,
                len: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
            });
        }
        mem.write(GuestAddress(start), bytes)?;
    }
    for (addr, bytes) in inputs.raw {
        mem.write(GuestAddress(*addr), bytes)?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::arch::layout::{RAM_BASE, RAM_MIN};

    const RAM: RamRange = RamRange {
        base: RAM_BASE,
        size: RAM_MIN,
    };

    fn plan_raw(addr: u64) -> BootPlan {
        let raw: Vec<(u64, Arc<[u8]>)> = vec![(addr, Arc::from(&b"\x00\x00\x00\x14"[..]))];
        plan(
            RAM,
            &BootInputs {
                raw: &raw,
                ..BootInputs::default()
            },
        )
        .unwrap()
    }

    /// M18: the firmware plan: PC = the flash base, x0 = the DTB at the RAM base, nothing in
    /// RAM but the 2 MiB DTB slot, and the LDR-1 size rules.
    #[test]
    fn firmware_plan_enters_flash_with_x0_the_dtb() {
        use crate::arch::layout::{FLASH_BANK_SIZE, FLASH0_BASE};
        use crate::loader::firmware::FirmwareError;
        let rom = (FLASH0_BASE, FLASH_BANK_SIZE);
        let mut p = plan_firmware(RAM, rom, &[0x14; 4096]).unwrap();
        assert_eq!((p.entry, p.x0, p.cpsr), (FLASH0_BASE, RAM_BASE, 0x3c5));
        assert!(p.images.is_empty());
        assert_eq!(p.dtb_limit, DTB_MAX);
        let fw = p.firmware.clone().unwrap();
        assert_eq!((fw.addr, fw.len), (FLASH0_BASE, 4096));
        p.set_dtb_len(DTB_MAX).unwrap();
        let text = p.to_string();
        assert!(text.contains("flash0  0x0..0x1000  firmware"), "{text}");
        assert!(text.contains("pc=0x0 x0=0x40000000"), "{text}");
        assert_eq!(
            plan_firmware(RAM, rom, &[]),
            Err(LoaderError::Firmware(FirmwareError::Empty))
        );
        let big = vec![0u8; usize::try_from(FLASH_BANK_SIZE).unwrap() + 1];
        assert_eq!(
            plan_firmware(RAM, rom, &big),
            Err(LoaderError::Firmware(FirmwareError::TooLarge {
                len: FLASH_BANK_SIZE + 1,
                rom: FLASH_BANK_SIZE
            }))
        );
        // A full bank fits exactly.
        big.get(..big.len() - 1)
            .map(|full| plan_firmware(RAM, rom, full).unwrap())
            .unwrap();
    }

    /// M7: x0 is the DTB address; the slot is sized to the blob and capped by the lowest
    /// image and by 2 MiB.
    #[test]
    fn dtb_slot_is_sized_and_capped() {
        let mut p = plan_raw(DTB_MAX_TEST_GUEST + RAM_BASE); // a test guest at +512 KiB
        assert_eq!(p.x0, RAM_BASE);
        assert_eq!(p.dtb_limit, DTB_MAX_TEST_GUEST);
        p.set_dtb_len(1687).unwrap();
        assert_eq!((p.dtb.addr, p.dtb.len), (RAM_BASE, 1687));
        assert!(p.to_string().contains("device tree"));
        assert_eq!(
            p.set_dtb_len(DTB_MAX_TEST_GUEST + 1),
            Err(LoaderError::DtbTooLarge {
                len: DTB_MAX_TEST_GUEST + 1,
                limit: DTB_MAX_TEST_GUEST
            })
        );
        assert!(p.set_dtb_len(0).is_err());
        // An image far up in RAM leaves the full 2 MiB.
        let mut p = plan_raw(RAM_BASE + (32 << 20));
        assert_eq!(p.dtb_limit, DTB_MAX);
        p.set_dtb_len(DTB_MAX).unwrap();
        assert!(p.set_dtb_len(DTB_MAX + 1).is_err());
        // load_dtb refuses a blob of another size than the slot.
        let mem = crate::memory::VecMemory::new(&[(GuestAddress(RAM.base), RAM.size)]).unwrap();
        let mut p = plan_raw(RAM_BASE + DTB_MAX_TEST_GUEST);
        p.set_dtb_len(8).unwrap();
        assert!(load_dtb(&p, &[1; 9], &mem).is_err());
        load_dtb(&p, &[7; 8], &mem).unwrap();
        assert_eq!(mem.read_u32(GuestAddress(RAM_BASE)).unwrap(), 0x0707_0707);
    }
}
