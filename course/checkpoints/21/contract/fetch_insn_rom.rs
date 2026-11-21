// Checkpoint 21 contract, frozen from the reference test crates/vmm/tests/fetch_insn_rom.rs.
// It names only items the chapter 21 lesson teaches; the harness runs it against your crates.
//! Host test: the ISV = 0 instruction fetch from flash ROM (`arch::stage1_walk::fetch_insn_rom`;
//! threat model: docs/security/threat-model.md).
//!
//! The on-machine `uboot_prompt` e2e test shows the hook working for U-Boot's first `STP`;
//! this file pins down, without HVF, *when* the hook is consulted and when it must not be:
//!
//! - the ROM is asked only after `GuestMemory` said `NotRam`: a PC in RAM, a misaligned PC and
//!   every walk error never reach it (a counting fake ROM checks that);
//! - with the MMU off the PC is the IPA; with it on, a VA that a block maps onto the ROM IPA
//!   is read from the ROM at the *translated* address;
//! - page tables are still read from RAM only: `TTBR0` pointing into the ROM is
//!   `Walk(TableOutsideRam)`, not a ROM read;
//! - a ROM miss (an IPA past the ROM's end, or a misaligned word) is still `NotRam`.
//!
//! `RomRegion`'s own `read_insn` (an `hv_vm_allocate`d buffer, so it needs the hypervisor
//! entitlement) is checked for alignment and bounds in `rom_dma.rs` under `--features
//! hvf-tests`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicUsize, Ordering};
use vmm::arch::layout::{FLASH_SIZE, FLASH0_BASE};
use vmm::arch::stage1_walk::{
    FetchError, InsnRom, TranslationRegs, WalkError, fetch_insn, fetch_insn_rom,
};
use vmm::memory::{GuestAddress, GuestMemory, VecMemory};

const RAM: u64 = 0x4000_0000;
const RAM_SIZE: u64 = 1 << 20;
/// The fake ROM's size: one 64 KiB window at `FLASH0_BASE`.
const ROM_SIZE: u64 = 64 << 10;

/// A ROM of words at `FLASH0_BASE` that counts every question it is asked, and the IPAs.
struct FakeRom {
    words: Vec<u32>,
    calls: AtomicUsize,
    last: std::sync::Mutex<Option<u64>>,
}

impl FakeRom {
    /// Word `i` is `0xd503_0000 | i` (distinct, recognisable values).
    fn new() -> FakeRom {
        FakeRom {
            words: (0..(ROM_SIZE / 4) as u32)
                .map(|i| 0xd503_0000 | i)
                .collect(),
            calls: AtomicUsize::new(0),
            last: std::sync::Mutex::new(None),
        }
    }
    fn word_at(&self, ipa: u64) -> u32 {
        self.words[((ipa - FLASH0_BASE) / 4) as usize]
    }
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl InsnRom for FakeRom {
    /// The same contract as `RomRegion::read_u32`: aligned and in bounds, else `None`.
    fn read_insn(&self, ipa: u64) -> Option<u32> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        *self.last.lock().unwrap() = Some(ipa);
        if !ipa.is_multiple_of(4) {
            return None;
        }
        let i = ipa.checked_sub(FLASH0_BASE)? / 4;
        self.words.get(usize::try_from(i).ok()?).copied()
    }
}

/// A ROM that answers *every* IPA, so a test can tell "not consulted" from "consulted and
/// missed".
struct GreedyRom(AtomicUsize);

impl InsnRom for GreedyRom {
    fn read_insn(&self, _ipa: u64) -> Option<u32> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Some(0xdead_beef)
    }
}

fn ram() -> VecMemory {
    VecMemory::new(&[(GuestAddress(RAM), RAM_SIZE)]).unwrap()
}

/// MMU off: the PC is the IPA.
const MMU_OFF: TranslationRegs = TranslationRegs {
    sctlr_el1: 0,
    tcr_el1: 0,
    ttbr0_el1: 0,
    ttbr1_el1: 0,
};

// TCR_EL1 (ARM ARM D19.2): T0SZ = 25 (39-bit VAs), TG0 = 4K, IPS = 48 bits, TTBR1 walks off.
// With 4K pages and 39 VA bits the walk starts at level 1, where a block maps 1 GiB.
const TCR_39_4K: u64 = 25 | (0b101 << 32) | (1 << 23);
/// The level-1 table, in RAM.
const L1: u64 = RAM + 0x1000;
/// VA 0x0..1 GiB → IPA 0x0 (flash, MMIO); VA 2..3 GiB → IPA 0x4000_0000 (RAM).
const VA_RAM: u64 = 0x8000_0000;

/// MMU on with `ttbr0`, and the level-1 table at `L1` written: entry 0 a block at IPA 0 (the
/// ROM), entry 2 a block at RAM, entry 1 invalid.
fn mmu_on(mem: &VecMemory, ttbr0: u64) -> TranslationRegs {
    mem.write_u64(GuestAddress(L1), 0x1).unwrap(); // block, OA 0
    mem.write_u64(GuestAddress(L1 + 8), 0).unwrap(); // invalid
    mem.write_u64(GuestAddress(L1 + 16), RAM | 0x1).unwrap(); // block, OA RAM
    TranslationRegs {
        sctlr_el1: 1,
        tcr_el1: TCR_39_4K,
        ttbr0_el1: ttbr0,
        ttbr1_el1: 0,
    }
}

/// MMU off, PC in the ROM: the word comes from the ROM, asked once, at the PC.
#[test]
fn mmu_off_pc_in_rom_reads_the_rom() {
    let mem = ram();
    let rom = FakeRom::new();
    for off in [0, 0x100, ROM_SIZE - 4] {
        let pc = FLASH0_BASE + off;
        let before = rom.calls();
        let w = fetch_insn_rom(&mem, Some(&rom), &MMU_OFF, pc).unwrap();
        assert_eq!(w, rom.word_at(pc), "pc {pc:#x}");
        assert_eq!(rom.calls(), before + 1);
        assert_eq!(*rom.last.lock().unwrap(), Some(pc));
    }
    // Without a ROM it is exactly `fetch_insn`: NotRam.
    let pc = FLASH0_BASE + 0x100;
    let none = fetch_insn_rom(&mem, None, &MMU_OFF, pc);
    assert_eq!(none, Err(FetchError::NotRam { pc, ipa: pc }));
    assert_eq!(none, fetch_insn(&mem, &MMU_OFF, pc));
}

/// A PC in RAM is read from RAM; the ROM is never consulted, even one that would answer.
#[test]
fn pc_in_ram_never_consults_the_rom() {
    let mem = ram();
    mem.write_u32(GuestAddress(RAM + 0x80), 0xa900_0801)
        .unwrap();
    let rom = GreedyRom(AtomicUsize::new(0));
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &MMU_OFF, RAM + 0x80),
        Ok(0xa900_0801)
    );
    // MMU on: VA 2 GiB + 0x80 is RAM + 0x80.
    let regs = mmu_on(&mem, L1);
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, VA_RAM + 0x80),
        Ok(0xa900_0801)
    );
    assert_eq!(rom.0.load(Ordering::SeqCst), 0);
}

/// A misaligned PC and every walk error are returned as they are: no ROM fallback.
#[test]
fn misaligned_and_walk_errors_do_not_fall_back() {
    let mem = ram();
    let rom = GreedyRom(AtomicUsize::new(0));
    // Misaligned, in the ROM, with the MMU off.
    let pc = FLASH0_BASE + 0x102;
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &MMU_OFF, pc),
        Err(FetchError::Misaligned { pc })
    );
    let regs = mmu_on(&mem, L1);
    // An invalid level-1 descriptor (VA 1..2 GiB).
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, 0x4000_0100),
        Err(FetchError::Walk(WalkError::InvalidDescriptor {
            level: 1,
            desc: 0
        }))
    );
    // A VA above the 39-bit TTBR0 range.
    let va = 1 << 40;
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, va),
        Err(FetchError::Walk(WalkError::VaOutOfRange { va }))
    );
    // MMIO-5: the page tables themselves are in the ROM. They are read from RAM only, so this
    // is TableOutsideRam, not a ROM read (the greedy ROM would have "found" a descriptor).
    let regs = mmu_on(&mem, FLASH0_BASE + 0x1000);
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, 0x100),
        Err(FetchError::Walk(WalkError::TableOutsideRam {
            level: 1,
            addr: FLASH0_BASE + 0x1000
        }))
    );
    assert_eq!(rom.0.load(Ordering::SeqCst), 0, "the ROM was consulted");
}

/// MMU on: a VA that a block maps onto the ROM is read from the ROM at the translated IPA.
#[test]
fn mmu_on_va_mapped_to_rom_reads_the_rom() {
    let mem = ram();
    let rom = FakeRom::new();
    let regs = mmu_on(&mem, L1);
    let va = 0x2000; // block 0: VA = IPA here, but the IPA is what reaches the ROM
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, va),
        Ok(rom.word_at(FLASH0_BASE + 0x2000))
    );
    assert_eq!(*rom.last.lock().unwrap(), Some(FLASH0_BASE + 0x2000));
    assert_eq!(rom.calls(), 1);
}

/// A ROM miss is still `NotRam`, with the PC and the IPA: past the ROM's end, between the
/// ROM and RAM, and at the far end of the flash window.
#[test]
fn rom_miss_is_not_ram() {
    let mem = ram();
    let rom = FakeRom::new();
    for pc in [
        FLASH0_BASE + ROM_SIZE,
        FLASH0_BASE + FLASH_SIZE - 4,
        0x0900_0000,
        RAM + RAM_SIZE,
    ] {
        let before = rom.calls();
        assert_eq!(
            fetch_insn_rom(&mem, Some(&rom), &MMU_OFF, pc),
            Err(FetchError::NotRam { pc, ipa: pc }),
            "pc {pc:#x}"
        );
        assert_eq!(rom.calls(), before + 1, "asked once");
    }
    // MMU on: VA 0x10_0000 maps (block 0) to IPA 0x10_0000, past the 64 KiB fake ROM.
    let regs = mmu_on(&mem, L1);
    assert_eq!(
        fetch_insn_rom(&mem, Some(&rom), &regs, 0x10_0000),
        Err(FetchError::NotRam {
            pc: 0x10_0000,
            ipa: 0x10_0000
        })
    );
}
