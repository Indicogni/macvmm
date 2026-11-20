//! The fatal-stop report: everything a reader needs to say why a guest died, in the order
//! they need it (architecture §15; course ch06 objective 3, ch07 objective 4; threat model
//! LOG-5).
//!
//! **Layout** (one item per line, printed on stderr under `macvmm: guest fatal: <reason>`):
//!
//! ```text
//! vcpu0: data abort (EC 0x24): ISV=1 SAS=2 (4 bytes) ... DFSC=0x6 (translation fault)
//!   esr=0x93810046 ipa=0xc000000
//!   x0=0x000000000c000000 x1=0x000000000000004d x2=... x3=...
//!   ...                                                   (X0..X30, four per line)
//!   sp_el0=0x0 sp_el1=0x40100000
//!   pc=0x40080010 cpsr=0x3c5 (EL1h, DAIF, nzcv)
//!   ELR_EL1=0x0 SPSR_EL1=0x0 ESR_EL1=0x0 (EC 0x00) FAR_EL1=0x0
//!   VBAR_EL1=0x40080800 SCTLR_EL1=0x30d00800 TCR_EL1=0x0 TTBR0_EL1=0x0 TTBR1_EL1=0x0
//!   insn at pc: 0xb9000001
//! last exits: 1 (oldest first)
//!   {"t_ns":...,"vcpu":0,"reason":"exception","ec":"0x24",...}
//! ```
//!
//! Named registers print without zero padding (`pc=0x200`, `ELR_EL1=0x40080010`), so a marker
//! file can match a prefix with `*`; the general-purpose registers are padded to 16 digits so
//! the columns line up. **The second-fault hint:** when the PC sits on an exception-vector
//! entry (`VBAR_EL1 + 0x000..0x800`, at a 0x80 boundary), the guest took an exception at EL1
//! first and its handler then faulted; the line `note:` says so and points at `ELR_EL1` and
//! `ESR_EL1` (ch06's self-fault chain, link 6).
//!
//! **The instruction at the PC** (M17) is fetched through the guest's own stage 1
//! ([`insn_at_pc`], `arch::stage1_walk::fetch_insn`): with the MMU on the PC is a virtual
//! address, so reading guest RAM at it directly would show the wrong word (or nothing). The
//! translation registers come from the same [`RegDump`]. A PC that does not translate to RAM
//! prints `insn at pc: not readable (...)`.
//!
//! **Safe to print** (LOG-5): every field is a number or a static name. No guest byte (not
//! even the instruction word as text) reaches the terminal.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::regs::RegDump;
use crate::arch::esr::{self, Exit};
use crate::arch::regs::Pstate;
use crate::arch::stage1_walk::{self, TranslationRegs};
use crate::control::GuestFatal;
use crate::memory::GuestMemory;
use core::fmt::Write as _;

/// The vector-table window (16 entries of 0x80 bytes; ARM ARM D1.10.2 "Exception vectors").
const VECTOR_TABLE_SIZE: u64 = 0x800;
const VECTOR_ENTRY: u64 = 0x80;

fn ec_suffix(esr: u64) -> String {
    let ec = esr::esr_ec(esr);
    match esr::ec_name(ec) {
        Some(n) => format!(" (EC {ec:#04x}: {n})"),
        None => format!(" (EC {ec:#04x})"),
    }
}

// ANCHOR: regdump_format
/// The register block of the dump (module docs), each line indented by two spaces.
pub fn format_regs(d: &RegDump) -> String {
    let mut s = String::with_capacity(1024);
    for (row, chunk) in d.x.chunks(4).enumerate() {
        s.push(' ');
        for (col, v) in chunk.iter().enumerate() {
            let n = row.saturating_mul(4).saturating_add(col);
            let _ = write!(s, " x{n}={v:#018x}");
        }
        s.push('\n');
    }
    let _ = writeln!(s, "  sp_el0={:#x} sp_el1={:#x}", d.sp_el0, d.sp_el1);
    let _ = writeln!(
        s,
        "  pc={:#x} cpsr={:#x} ({})",
        d.pc,
        d.cpsr,
        Pstate(d.cpsr)
    );
    let _ = writeln!(
        s,
        "  ELR_EL1={:#x} SPSR_EL1={:#x} ESR_EL1={:#x}{} FAR_EL1={:#x}",
        d.elr_el1,
        d.spsr_el1,
        d.esr_el1,
        ec_suffix(d.esr_el1),
        d.far_el1
    );
    let _ = writeln!(
        s,
        "  VBAR_EL1={:#x} SCTLR_EL1={:#x} TCR_EL1={:#x} TTBR0_EL1={:#x} TTBR1_EL1={:#x}",
        d.vbar_el1, d.sctlr_el1, d.tcr_el1, d.ttbr0_el1, d.ttbr1_el1
    );
    let off = d.pc.wrapping_sub(d.vbar_el1);
    if off < VECTOR_TABLE_SIZE && off.is_multiple_of(VECTOR_ENTRY) {
        let _ = writeln!(
            s,
            "  note: pc is VBAR_EL1 + {off:#x}, an exception vector: the guest took an \
             exception at EL1 first, so ELR_EL1 and ESR_EL1 describe the first fault"
        );
    }
    s
}
// ANCHOR_END: regdump_format

// ANCHOR: dump_insn_at_pc
/// The instruction word at `pc`, read through the guest's stage-1 translation as the dump `d`
/// records it (module docs). Without a dump the MMU state is unknown, and the PC is read as an
/// IPA, which is right for every guest that has not turned its MMU on.
pub fn insn_at_pc(mem: &dyn GuestMemory, d: Option<&RegDump>, pc: u64) -> Option<u32> {
    let regs = d.map_or_else(TranslationRegs::default, |d| TranslationRegs {
        sctlr_el1: d.sctlr_el1,
        tcr_el1: d.tcr_el1,
        ttbr0_el1: d.ttbr0_el1,
        ttbr1_el1: d.ttbr1_el1,
    });
    stage1_walk::fetch_insn(mem, &regs, pc).ok()
}
// ANCHOR_END: dump_insn_at_pc

/// The whole report for `g` (module docs), without the `guest fatal:` line the CLI prints.
/// A machine-level verdict (`g.vcpu` is `None`, for example the reset storm) has no vCPU
/// state, so its report is empty: printing `vcpu0: pc=0x0 (EL0t)` would send the reader after
/// a vCPU that was never there.
pub fn format_fatal(g: &GuestFatal) -> String {
    let Some(vcpu) = g.vcpu else {
        return String::new();
    };
    let mut s = String::with_capacity(4096);
    match &g.exit {
        Some(exit) => {
            let _ = writeln!(s, "vcpu{vcpu}: {exit}");
        }
        None => {
            let _ = writeln!(s, "vcpu{vcpu}:");
        }
    }
    let _ = write!(s, "  esr={:#x}", g.esr);
    if let Some(Exit::DataAbort(_) | Exit::InstructionAbort { .. }) = g.exit {
        let _ = write!(s, " ipa={:#x}", g.ipa);
    }
    s.push('\n');
    match &g.regs {
        Some(d) => s.push_str(&format_regs(d)),
        None => {
            let _ = writeln!(
                s,
                "  pc={:#x} cpsr={:#x} ({}) (registers unavailable)",
                g.pc,
                g.cpsr,
                Pstate(g.cpsr)
            );
        }
    }
    match g.insn {
        Some(w) => {
            let _ = writeln!(s, "  insn at pc: {w:#010x}");
        }
        None => s.push_str("  insn at pc: not readable (the pc does not translate to RAM)\n"),
    }
    let _ = writeln!(s, "last exits: {} (oldest first)", g.last_exits.len());
    for r in &g.last_exits {
        let _ = writeln!(s, "  {}", r.to_json());
    }
    s
}

#[cfg(test)]
#[allow(clippy::indexing_slicing, clippy::arithmetic_side_effects)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::trace::{Action, ExitRecord};

    /// PLAN M4 `dump::tests::format_golden`: the self-fault case of ch06 (an instruction abort
    /// at VBAR_EL1 + 0x200 after an alignment fault at EL1), byte for byte.
    #[test]
    fn format_golden() {
        let mut d = RegDump::default();
        for (i, x) in d.x.iter_mut().enumerate() {
            *x = i as u64 * 0x1111;
        }
        d.sp_el1 = 0x4010_0000;
        d.pc = 0x200;
        d.cpsr = 0x3c5;
        d.elr_el1 = 0x4008_0abc;
        d.spsr_el1 = 0x3c5;
        d.esr_el1 = 0x9600_0021;
        d.far_el1 = 0x4010_0001;
        d.sctlr_el1 = 0x30d0_0802;
        let exit = Exit::decode(0x8200_0006);
        let rec = ExitRecord {
            t_ns: 5000,
            ec: Some(0x20),
            pc: Some(0x200),
            ipa: Some(0x200),
            action: Some(Action::Stop),
            ..ExitRecord::default()
        };
        let g = GuestFatal {
            vcpu: Some(0),
            reason: "instruction abort at pc 0x200".into(),
            pc: 0x200,
            esr: 0x8200_0006,
            ipa: 0x200,
            cpsr: 0x3c5,
            insn: None,
            exit: Some(exit),
            regs: Some(Box::new(d)),
            last_exits: vec![rec],
        };
        let want = "\
vcpu0: instruction abort (EC 0x20): IFSC=0x6 S1PTW=0 (translation fault)
  esr=0x82000006 ipa=0x200
  x0=0x0000000000000000 x1=0x0000000000001111 x2=0x0000000000002222 x3=0x0000000000003333
  x4=0x0000000000004444 x5=0x0000000000005555 x6=0x0000000000006666 x7=0x0000000000007777
  x8=0x0000000000008888 x9=0x0000000000009999 x10=0x000000000000aaaa x11=0x000000000000bbbb
  x12=0x000000000000cccc x13=0x000000000000dddd x14=0x000000000000eeee x15=0x000000000000ffff
  x16=0x0000000000011110 x17=0x0000000000012221 x18=0x0000000000013332 x19=0x0000000000014443
  x20=0x0000000000015554 x21=0x0000000000016665 x22=0x0000000000017776 x23=0x0000000000018887
  x24=0x0000000000019998 x25=0x000000000001aaa9 x26=0x000000000001bbba x27=0x000000000001cccb
  x28=0x000000000001dddc x29=0x000000000001eeed x30=0x000000000001fffe
  sp_el0=0x0 sp_el1=0x40100000
  pc=0x200 cpsr=0x3c5 (EL1h, DAIF, nzcv)
  ELR_EL1=0x40080abc SPSR_EL1=0x3c5 ESR_EL1=0x96000021 (EC 0x25: data abort, same EL) FAR_EL1=0x40100001
  VBAR_EL1=0x0 SCTLR_EL1=0x30d00802 TCR_EL1=0x0 TTBR0_EL1=0x0 TTBR1_EL1=0x0
  note: pc is VBAR_EL1 + 0x200, an exception vector: the guest took an exception at EL1 first, so ELR_EL1 and ESR_EL1 describe the first fault
  insn at pc: not readable (the pc does not translate to RAM)
last exits: 1 (oldest first)
  {\"t_ns\":5000,\"vcpu\":0,\"reason\":\"exception\",\"ec\":\"0x20\",\"pc\":\"0x200\",\"ipa\":\"0x200\",\"action\":\"stop\"}
";
        assert_eq!(format_fatal(&g), want);
    }

    #[test]
    fn without_registers() {
        let g = GuestFatal {
            vcpu: Some(1),
            reason: "x".into(),
            pc: 0x4008_0000,
            esr: 0,
            ipa: 0,
            cpsr: 0x3c4,
            insn: Some(0xd503_201f),
            exit: None,
            regs: None,
            last_exits: vec![],
        };
        let s = format_fatal(&g);
        assert!(s.contains("pc=0x40080000 cpsr=0x3c4 (EL1t, DAIF, nzcv) (registers unavailable)"));
        assert!(s.contains("insn at pc: 0xd503201f"));
        assert!(s.ends_with("last exits: 0 (oldest first)\n"));
        // A machine-level verdict: no report at all.
        assert_eq!(format_fatal(&GuestFatal::machine("reset storm")), "");
    }

    /// PLAN M17 "show the instruction at the PC through the walk": with the MMU on in the
    /// dump, the PC is a VA. VA `RAM + 0x6000` maps to IPA `RAM + 0x5000`; the identity IPA
    /// holds a different word, which only a dump that skipped the walk would print.
    #[test]
    fn insn_at_pc_walks_stage1() {
        use crate::memory::{GuestAddress, VecMemory};
        const RAM: u64 = 0x4000_0000;
        const TABLE: u64 = 0b11; // a table at levels 1–2, a page at level 3 (D8.3)
        let (l1, l2, l3) = (RAM + 0x1000, RAM + 0x2000, RAM + 0x3000);
        let (pc_va, pc_ipa) = (RAM + 0x6000, RAM + 0x5000);
        let mem = VecMemory::new(&[(GuestAddress(RAM), 1 << 20)]).unwrap();
        for (table, index, v) in [
            (l1, 1, l2 | TABLE),
            (l2, 0, l3 | TABLE),
            (l3, 6, pc_ipa | TABLE),
        ] {
            mem.write_u64(GuestAddress(table + index * 8), v).unwrap();
        }
        mem.write_u32(GuestAddress(pc_ipa), 0xa940_0801).unwrap(); // ldp x1, x2, [x0]
        mem.write_u32(GuestAddress(pc_va), 0xd503_201f).unwrap(); // nop, at the identity IPA
        let d = RegDump {
            pc: pc_va,
            sctlr_el1: 1,
            // T0SZ = 25 (levels 1–3), TG0 = 4K, IPS = 48 bits, EPD1.
            tcr_el1: 25 | (0b101 << 32) | (1 << 23),
            ttbr0_el1: l1,
            ..RegDump::default()
        };
        assert_eq!(insn_at_pc(&mem, Some(&d), pc_va), Some(0xa940_0801));
        // Without a dump the MMU state is unknown and the PC is read as an IPA.
        assert_eq!(insn_at_pc(&mem, None, pc_va), Some(0xd503_201f));
        // MMU off in the dump: identity.
        let off = RegDump {
            sctlr_el1: 0,
            ..d.clone()
        };
        assert_eq!(insn_at_pc(&mem, Some(&off), pc_va), Some(0xd503_201f));
        // A PC VA that does not translate: nothing to show.
        assert_eq!(insn_at_pc(&mem, Some(&d), pc_va + 0x1000), None);
    }
}
