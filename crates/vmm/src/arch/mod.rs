//! Architecture- and board-level facts: the machine memory map (`layout`, M2), ESR decoding
//! (`esr`, M4) and register helpers (`regs`, M4). Later milestones add the sysreg policy and exception
//! injection (`sysreg`, `inject`, M5) and the ISV=0 decoder and stage-1 walker (M17), each as an
//! additive `mod` line here (PLAN §2.1).

pub mod esr;
pub mod inject;
pub mod insn;
pub mod layout;
pub mod regs;
pub mod stage1_walk;
pub mod sysreg;
