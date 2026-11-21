// Checkpoint 07 contract, frozen from the reference test crates/vmm/tests/esr_vectors.rs.
// It names only items the chapter 07 lesson teaches; the harness runs it against your crates.
//! Host test: `Exit::from_hv` against the ESR vector corpus, plus the decode panic sweep (acceptance; threat model: docs/security/threat-model.md).
//!
//! `tests/data/esr_vectors.json` holds ≥ 40 `ESR_EL2` values with the decode each must give,
//! written from the field values by an encoder that shares no code with `arch/esr.rs` (ARM ARM
//! DDI 0487, D17.2.40), plus the syndromes observed on real hardware (`"observed"`). The same
//! file is the ESR lab's data (`cargo xtask export-vectors`).
//!
//! The sweep feeds 1,000,000 xorshift64* values (fixed seed, printed on failure; `MACVMM_SEED`
//! replays one) through `Exit::decode` and `Exit::from_hv` with every exit reason: none may
//! panic, and the result must be consistent with the EC field.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use vmm::arch::esr::{DataAbort, Exit, SysRegAccess, esr_ec};

// ---------------------------------------------------------------------------------------------
// A minimal JSON reader (objects, arrays, strings without escapes beyond \" and \\, integers,
// booleans). Test-only; the corpus is ours.

#[derive(Clone, Debug, PartialEq)]
enum J {
    Obj(BTreeMap<String, J>),
    Arr(Vec<J>),
    Str(String),
    Num(u64),
    Bool(bool),
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(self.s[self.i], c, "expected {:?} at {}", c as char, self.i);
        self.i += 1;
    }
    fn value(&mut self) -> J {
        self.ws();
        match self.s[self.i] {
            b'{' => {
                self.i += 1;
                let mut m = BTreeMap::new();
                loop {
                    self.ws();
                    if self.s[self.i] == b'}' {
                        self.i += 1;
                        return J::Obj(m);
                    }
                    let J::Str(k) = self.value() else {
                        panic!("key")
                    };
                    self.eat(b':');
                    let v = self.value();
                    assert!(m.insert(k, v).is_none(), "duplicate key");
                    self.ws();
                    if self.s[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut v = Vec::new();
                loop {
                    self.ws();
                    if self.s[self.i] == b']' {
                        self.i += 1;
                        return J::Arr(v);
                    }
                    v.push(self.value());
                    self.ws();
                    if self.s[self.i] == b',' {
                        self.i += 1;
                    }
                }
            }
            b'"' => {
                self.i += 1;
                let mut out = Vec::new();
                while self.s[self.i] != b'"' {
                    if self.s[self.i] == b'\\' {
                        self.i += 1;
                    }
                    out.push(self.s[self.i]);
                    self.i += 1;
                }
                self.i += 1;
                J::Str(String::from_utf8(out).unwrap())
            }
            b't' => {
                self.i += 4;
                J::Bool(true)
            }
            b'f' => {
                self.i += 5;
                J::Bool(false)
            }
            _ => {
                let start = self.i;
                while self.s[self.i].is_ascii_digit() {
                    self.i += 1;
                }
                J::Num(
                    std::str::from_utf8(&self.s[start..self.i])
                        .unwrap()
                        .parse()
                        .unwrap(),
                )
            }
        }
    }
}

fn parse(text: &str) -> J {
    let mut p = P {
        s: text.as_bytes(),
        i: 0,
    };
    let v = p.value();
    p.ws();
    assert_eq!(p.i, p.s.len(), "trailing data");
    v
}

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s.strip_prefix("0x").expect("0x prefix"), 16).unwrap()
}

fn get<'a>(o: &'a BTreeMap<String, J>, k: &str) -> &'a J {
    o.get(k).unwrap_or_else(|| panic!("missing {k:?}"))
}

fn num(f: &BTreeMap<String, J>, k: &str) -> u64 {
    match get(f, k) {
        J::Num(n) => *n,
        J::Str(s) => hex(s),
        other => panic!("{k}: {other:?}"),
    }
}

fn u8f(f: &BTreeMap<String, J>, k: &str) -> u8 {
    u8::try_from(num(f, k)).unwrap()
}

fn u16f(f: &BTreeMap<String, J>, k: &str) -> u16 {
    u16::try_from(num(f, k)).unwrap()
}

fn flag(f: &BTreeMap<String, J>, k: &str) -> bool {
    match get(f, k) {
        J::Bool(b) => *b,
        other => panic!("{k}: {other:?}"),
    }
}

/// The `Exit` a vector expects.
fn expected(exit: &str, f: Option<&BTreeMap<String, J>>) -> Exit {
    let f = || f.expect("fields");
    match exit {
        "Canceled" => Exit::Canceled,
        "VtimerActivated" => Exit::VtimerActivated,
        "Wfx" => Exit::Wfx { ti: u8f(f(), "ti") },
        "Hvc" => Exit::Hvc {
            imm: u16f(f(), "imm"),
        },
        "Smc" => Exit::Smc {
            imm: u16f(f(), "imm"),
        },
        "Brk" => Exit::Brk {
            imm: u16f(f(), "imm"),
        },
        "SysReg" => Exit::SysReg(SysRegAccess {
            op0: u8f(f(), "op0"),
            op1: u8f(f(), "op1"),
            crn: u8f(f(), "crn"),
            crm: u8f(f(), "crm"),
            op2: u8f(f(), "op2"),
            rt: u8f(f(), "rt"),
            read: flag(f(), "read"),
        }),
        "InstructionAbort" => Exit::InstructionAbort {
            ifsc: u8f(f(), "ifsc"),
            s1ptw: flag(f(), "s1ptw"),
        },
        "DataAbort" => Exit::DataAbort(DataAbort {
            isv: flag(f(), "isv"),
            sas: u8f(f(), "sas"),
            sse: flag(f(), "sse"),
            srt: u8f(f(), "srt"),
            sf: flag(f(), "sf"),
            ar: flag(f(), "ar"),
            fnv: flag(f(), "fnv"),
            s1ptw: flag(f(), "s1ptw"),
            wnr: flag(f(), "wnr"),
            dfsc: u8f(f(), "dfsc"),
        }),
        "Unknown" => Exit::Unknown {
            ec: u8f(f(), "ec"),
            esr: num(f(), "esr"),
        },
        other => panic!("unknown exit {other:?}"),
    }
}

fn reason(s: &str) -> hvf::ExitReason {
    match s {
        "exception" => hvf::ExitReason::Exception,
        "canceled" => hvf::ExitReason::Canceled,
        "vtimer" => hvf::ExitReason::VtimerActivated,
        "unknown" => hvf::ExitReason::Unknown,
        other => panic!("reason {other:?}"),
    }
}

const CORPUS: &str = include_str!("data/esr_vectors.json");

#[test]
fn esr_vectors() {
    let J::Obj(top) = parse(CORPUS) else {
        panic!("top")
    };
    let J::Arr(vectors) = get(&top, "vectors") else {
        panic!("vectors")
    };
    assert!(vectors.len() >= 40, "PLAN M4: at least 40 vectors");
    let mut observed = 0;
    let mut kinds = std::collections::BTreeSet::new();
    for v in vectors {
        let J::Obj(v) = v else { panic!("vector") };
        let J::Str(name) = get(v, "name") else {
            panic!()
        };
        let J::Str(r) = get(v, "reason") else {
            panic!()
        };
        let J::Str(esr) = get(v, "esr") else { panic!() };
        let J::Str(exit) = get(v, "exit") else {
            panic!()
        };
        let fields = match v.get("fields") {
            Some(J::Obj(f)) => Some(f),
            _ => None,
        };
        if v.contains_key("observed") {
            observed += 1;
        }
        kinds.insert(exit.clone());
        let want = expected(exit, fields);
        let got = Exit::from_hv(reason(r), hex(esr));
        assert_eq!(got, want, "vector {name:?} (esr {esr})");
        if r == "exception" {
            assert_eq!(got, Exit::decode(hex(esr)), "{name}");
        }
        // The Display form is total too, and never contains a control character.
        assert!(!got.to_string().chars().any(char::is_control), "{name}");
    }
    assert!(observed >= 10, "{observed} observed vectors");
    assert_eq!(kinds.len(), 10, "every Exit variant is covered: {kinds:?}");
}

/// PLAN M4 security test (MMIO-1): 1,000,000 xorshift ESRs, no panic, consistent with EC.
#[test]
fn decode_never_panics_sweep() {
    let seed: u64 = std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x00e5_2d0c_0de5_eed5);
    let mut x = seed.max(1);
    let reasons = [
        hvf::ExitReason::Exception,
        hvf::ExitReason::Canceled,
        hvf::ExitReason::VtimerActivated,
        hvf::ExitReason::Unknown,
        hvf::ExitReason::Other(u32::MAX),
    ];
    for i in 0..1_000_000u64 {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let esr = x.wrapping_mul(0x2545_f491_4f6c_dd1d);
        let exit = Exit::decode(esr);
        let ec = esr_ec(esr);
        let consistent = match exit {
            Exit::Wfx { ti } => ec == 0x01 && ti < 4,
            Exit::Hvc { imm } => ec == 0x16 && u64::from(imm) == esr & 0xffff,
            Exit::Smc { .. } => ec == 0x17,
            Exit::SysReg(s) => ec == 0x18 && s.rt < 32 && s.op0 < 4,
            Exit::InstructionAbort { ifsc, .. } => ec == 0x20 && ifsc < 64,
            Exit::DataAbort(d) => {
                ec == 0x24 && d.sas < 4 && d.srt < 32 && d.dfsc < 64 && d.size_bytes() <= 8
            }
            Exit::Brk { .. } => ec == 0x3c,
            Exit::Unknown { ec: e, esr: s } => {
                e == ec && s == esr && ![0x01, 0x16, 0x17, 0x18, 0x20, 0x24, 0x3c].contains(&ec)
            }
            Exit::Canceled | Exit::VtimerActivated => false,
        };
        assert!(
            consistent,
            "seed {seed:#x} iter {i}: esr {esr:#x} -> {exit:?}"
        );
        let r = reasons[usize::try_from(i % 5).unwrap()];
        let _ = Exit::from_hv(r, esr);
        if i % 1000 == 0 {
            let _ = exit.to_string();
        }
    }
}
