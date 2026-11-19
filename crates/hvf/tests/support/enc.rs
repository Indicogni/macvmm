//! A tiny hand-rolled A64 encoder, copied from `spikes/hvf-hello/src/enc.rs` (PLAN M1), where
//! `check-encodings.sh` re-assembled every instruction with clang and found all 1025 identical.
//! Additions since the copy carry a note; each was checked the same way (clang + objdump).
//!
//! ARM ARM DDI 0487, section C6 "A64 Base Instruction Descriptions"; each instruction is kept
//! together with its assembler mnemonic so a listing can be re-assembled and diffed.

pub struct Asm {
    pub base: u64,
    pub words: Vec<(u32, String)>,
}

/// System register coordinates (op0, op1, CRn, CRm, op2), as in the ARM ARM tables.
#[derive(Clone, Copy)]
pub struct SysReg {
    pub name: &'static str,
    pub op0: u32,
    pub op1: u32,
    pub crn: u32,
    pub crm: u32,
    pub op2: u32,
}

macro_rules! sr {
    ($n:ident, $o0:expr, $o1:expr, $n_:expr, $m:expr, $o2:expr) => {
        pub const $n: SysReg = SysReg {
            name: stringify!($n),
            op0: $o0,
            op1: $o1,
            crn: $n_,
            crm: $m,
            op2: $o2,
        };
    };
}
sr!(CNTVCT_EL0, 3, 3, 14, 0, 2);
sr!(CNTFRQ_EL0, 3, 3, 14, 0, 0);
sr!(CNTV_CTL_EL0, 3, 3, 14, 3, 1);
sr!(CNTV_CVAL_EL0, 3, 3, 14, 3, 2);
sr!(PMCR_EL0, 3, 3, 9, 12, 0);
sr!(CURRENTEL, 3, 0, 4, 2, 2);
sr!(ICC_PMR_EL1, 3, 0, 4, 6, 0);
sr!(ICC_IAR1_EL1, 3, 0, 12, 12, 0);
sr!(ICC_EOIR1_EL1, 3, 0, 12, 12, 1);
sr!(ICC_SRE_EL1, 3, 0, 12, 12, 5);
sr!(ICC_IGRPEN1_EL1, 3, 0, 12, 12, 7);

impl SysReg {
    fn bits(&self) -> u32 {
        // Bits [20:5] of MRS/MSR(register): op0[1:0]=20:19 op1=18:16 CRn=15:12 CRm=11:8 op2=7:5
        (self.op0 << 19) | (self.op1 << 16) | (self.crn << 12) | (self.crm << 8) | (self.op2 << 5)
    }
    /// The value Hypervisor.framework uses for `hv_sys_reg_t`.
    #[allow(dead_code)]
    pub fn hv_id(&self) -> u16 {
        ((self.op0 << 14) | (self.op1 << 11) | (self.crn << 7) | (self.crm << 3) | self.op2) as u16
    }
}

impl Asm {
    pub fn new(base: u64) -> Self {
        Asm {
            base,
            words: Vec::new(),
        }
    }
    /// Guest address of the next instruction to be emitted.
    pub fn here(&self) -> u64 {
        self.base + 4 * self.words.len() as u64
    }
    fn emit(&mut self, w: u32, m: String) -> u64 {
        let at = self.here();
        self.words.push((w, m));
        at
    }
    /// Pad with NOPs up to guest address `addr` (used to place the vector table).
    pub fn org(&mut self, addr: u64) {
        while self.here() < addr {
            self.nop();
        }
        assert_eq!(self.here(), addr);
    }
    pub fn bytes(&self) -> Vec<u8> {
        self.words
            .iter()
            .flat_map(|(w, _)| w.to_le_bytes())
            .collect()
    }

    /// MOVZ Xd, #imm16, LSL #(hw*16)   (C6.2.235)
    pub fn movz(&mut self, rd: u32, imm16: u32, hw: u32) -> u64 {
        self.emit(
            0xD280_0000 | (hw << 21) | (imm16 << 5) | rd,
            format!("movz x{rd}, #{imm16:#x}, lsl #{}", hw * 16),
        )
    }
    /// MOVK Xd, #imm16, LSL #(hw*16)
    pub fn movk(&mut self, rd: u32, imm16: u32, hw: u32) -> u64 {
        self.emit(
            0xF280_0000 | (hw << 21) | (imm16 << 5) | rd,
            format!("movk x{rd}, #{imm16:#x}, lsl #{}", hw * 16),
        )
    }
    /// Load a 32-bit constant into Xd (MOVZ + MOVK).
    pub fn mov32(&mut self, rd: u32, v: u32) {
        self.movz(rd, v & 0xffff, 0);
        if v >> 16 != 0 {
            self.movk(rd, v >> 16, 1);
        }
    }
    /// HVC #imm16  (C6.2.150)  -> EC 0x16 at EL2
    pub fn hvc(&mut self, imm: u32) -> u64 {
        self.emit(0xD400_0002 | (imm << 5), format!("hvc #{imm:#x}"))
    }
    /// SMC #imm16  -> trapped by HCR_EL2.TSC as EC 0x17
    pub fn smc(&mut self, imm: u32) -> u64 {
        self.emit(0xD400_0003 | (imm << 5), format!("smc #{imm:#x}"))
    }
    /// STR Wt, [Xn, #imm]  (unsigned offset, imm multiple of 4)
    pub fn str_w(&mut self, rt: u32, rn: u32, imm: u32) -> u64 {
        let t = if rt == 31 {
            "wzr".to_string()
        } else {
            format!("w{rt}")
        };
        self.emit(
            0xB900_0000 | ((imm / 4) << 10) | (rn << 5) | rt,
            format!("str {t}, [x{rn}, #{imm}]"),
        )
    }
    /// LDR Wt, [Xn, #imm]
    pub fn ldr_w(&mut self, rt: u32, rn: u32, imm: u32) -> u64 {
        self.emit(
            0xB940_0000 | ((imm / 4) << 10) | (rn << 5) | rt,
            format!("ldr w{rt}, [x{rn}, #{imm}]"),
        )
    }
    /// LDR Xt, [Xn, #imm]  (imm multiple of 8)
    pub fn ldr_x(&mut self, rt: u32, rn: u32, imm: u32) -> u64 {
        self.emit(
            0xF940_0000 | ((imm / 8) << 10) | (rn << 5) | rt,
            format!("ldr x{rt}, [x{rn}, #{imm}]"),
        )
    }
    /// STP Xt1, Xt2, [Xn]  (signed offset 0)
    pub fn stp_x(&mut self, rt: u32, rt2: u32, rn: u32) -> u64 {
        self.emit(
            0xA900_0000 | (rt2 << 10) | (rn << 5) | rt,
            format!("stp x{rt}, x{rt2}, [x{rn}]"),
        )
    }
    /// STR Xt, [Xn, #imm]  (imm multiple of 8)
    pub fn str_x(&mut self, rt: u32, rn: u32, imm: u32) -> u64 {
        let t = if rt == 31 {
            "xzr".to_string()
        } else {
            format!("x{rt}")
        };
        self.emit(
            0xF900_0000 | ((imm / 8) << 10) | (rn << 5) | rt,
            format!("str {t}, [x{rn}, #{imm}]"),
        )
    }
    /// MRS Xt, <sysreg>
    pub fn mrs(&mut self, rt: u32, r: SysReg) -> u64 {
        self.emit(
            0xD530_0000 | r.bits() | rt,
            format!("mrs x{rt}, {}", r.name),
        )
    }
    /// MSR <sysreg>, Xt   (rt = 31 means XZR)
    pub fn msr(&mut self, r: SysReg, rt: u32) -> u64 {
        let reg = if rt == 31 {
            "xzr".to_string()
        } else {
            format!("x{rt}")
        };
        self.emit(
            0xD510_0000 | r.bits() | rt,
            format!("msr {}, {reg}", r.name),
        )
    }
    /// MSR DAIFClr, #imm4
    pub fn daifclr(&mut self, imm: u32) -> u64 {
        self.emit(0xD503_40FF | (imm << 8), format!("msr daifclr, #{imm}"))
    }
    pub fn isb(&mut self) -> u64 {
        self.emit(0xD503_3FDF, "isb".into())
    }
    pub fn wfi(&mut self) -> u64 {
        self.emit(0xD503_207F, "wfi".into())
    }
    pub fn wfe(&mut self) -> u64 {
        self.emit(0xD503_205F, "wfe".into())
    }
    pub fn nop(&mut self) -> u64 {
        self.emit(0xD503_201F, "nop".into())
    }
    pub fn eret(&mut self) -> u64 {
        self.emit(0xD69F_03E0, "eret".into())
    }
    /// B <target>  (PC-relative, +/-128MB)
    pub fn b(&mut self, target: u64) -> u64 {
        let off = (target as i64 - self.here() as i64) / 4;
        let rel = off * 4;
        self.emit(
            0x1400_0000 | (off as u32 & 0x03ff_ffff),
            format!("b . + ({rel})"),
        )
    }
    /// BR Xn
    pub fn br(&mut self, rn: u32) -> u64 {
        self.emit(0xD61F_0000 | (rn << 5), format!("br x{rn}"))
    }
    /// UMOV Xd, Vn.D[index] (ARM ARM C6.2 "UMOV"; `mov.d` in Apple's syntax). Added for
    /// `simd_q5_roundtrip`; clang: `umov x0, v5.d[0]` = 0x4e083ca0, `v5.d[1]` -> x1 = 0x4e183ca1.
    pub fn umov_d(&mut self, rd: u32, vn: u32, index: u32) -> u64 {
        let imm5 = ((index & 1) << 4) | 0b01000;
        self.emit(
            0x4E00_3C00 | (imm5 << 16) | (vn << 5) | rd,
            format!("umov x{rd}, v{vn}.d[{index}]"),
        )
    }
    /// ADD Xd, Xn, Xm, LSR #shift
    pub fn add_lsr(&mut self, rd: u32, rn: u32, rm: u32, shift: u32) -> u64 {
        self.emit(
            0x8B40_0000 | (rm << 16) | (shift << 10) | (rn << 5) | rd,
            format!("add x{rd}, x{rn}, x{rm}, lsr #{shift}"),
        )
    }
}
