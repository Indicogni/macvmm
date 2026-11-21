// Checkpoint 21 contract, frozen from the reference test crates/vmm/tests/insn_decode.rs.
// It names only items the chapter 21 lesson teaches; the harness runs it against your crates.
//! Host test: the ISV=0 load/store decoder (`arch/insn.rs`, acceptance; threat model: docs/security/threat-model.md).
//!
//! - `corpus_decodes_as_expected`: `tests/data/insn_corpus.txt` holds ≥ 60 supported vectors
//!   (every class × writeback mode × size) and an undecodable list. Its words are proved to be
//!   clang's encodings by `scripts/check-insn-corpus.sh`; its expected decodes are written by
//!   hand from ARM ARM C6.2. This test checks the decoder against them.
//! - `random_words_decode_totally`: 200,000 xorshift64* words (half forced into the load/store
//!   group) decode without panicking, and every accepted decode satisfies the invariants the
//! emulator relies on (a seeded property test; `MACVMM_SEED` replays a run).
//! - The `plan_*` tests and `isv0_ipa_mismatch_aborts` cover the exit-IPA authority.
//!   `isv0_pair_across_devices_aborts` covers the same-device rule for LDP/STP, and the
//!   `execute_*` tests cover "writeback only after both accesses succeed". Each runs against a
//!   `MockBus` whose access log must stay empty whenever the emulation is refused.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};
use vmm::arch::insn::{
    BusAccess, Commit, Direction, ExitFacts, Gpr, Index, Insn, Isv0Bus, Isv0Error, LoadExt, Mapped,
    MemInsn, Offset, Operands, Refusal, SpSel, Unsupported, decode, emulate_isv0, execute,
    plan_isv0,
};
use vmm::arch::regs::Pstate;
use vmm::bus::AccessSize;

const CORPUS: &str = include_str!("data/insn_corpus.txt");

fn describe(w: u32) -> String {
    match decode(w) {
        Ok(i) => i.to_string(),
        Err(u) => u.to_string(),
    }
}

/// `(word, assembly, expected)` for every non-comment corpus line.
fn corpus() -> Vec<(u32, String, String)> {
    CORPUS
        .lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .map(|l| {
            let cols: Vec<&str> = l.split(" | ").collect();
            assert_eq!(cols.len(), 3, "malformed corpus line: {l}");
            let w = u32::from_str_radix(cols[0], 16).expect("hex word");
            (w, cols[1].to_string(), cols[2].to_string())
        })
        .collect()
}

/// Which addressing class a decoded single access belongs to, for the coverage check.
fn class_of(m: &MemInsn) -> &'static str {
    match (m.rt2.is_some(), m.index, m.offset) {
        (true, ..) => "pair",
        (false, Index::Offset, Offset::Reg { .. }) => "reg",
        (false, Index::Offset, Offset::Imm(_)) => "imm",
        (false, Index::Pre, _) => "pre",
        (false, Index::Post, _) => "post",
    }
}

#[test]
fn corpus_decodes_as_expected() {
    let mut failures = Vec::new();
    let mut supported = 0;
    let mut skipped = 0;
    let mut unsupported = BTreeSet::new();
    let mut covered = BTreeSet::new();
    for (w, asm, expected) in corpus() {
        let got = describe(w);
        if got != expected {
            failures.push(format!(
                "{w:08x} {asm:40} expected `{expected}`, got `{got}`"
            ));
        }
        match decode(w) {
            Ok(Insn::Mem(m)) => {
                supported += 1;
                let pair_kind = match (m.dir, m.size) {
                    (Direction::Load(LoadExt::Sign64), AccessSize::B4) if m.rt2.is_some() => "sw",
                    _ => "",
                };
                covered.insert((
                    class_of(&m),
                    m.is_store(),
                    m.size.bytes(),
                    pair_kind,
                    m.index,
                ));
            }
            Ok(Insn::Prefetch) => supported += 1,
            Ok(Insn::CacheMaintenance) => skipped += 1,
            Err(u) => {
                unsupported.insert(u.name());
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(supported >= 60, "only {supported} supported vectors");
    // DC/IC by VA are skipped (KVM's CM = 1 rule), not aborted; DC ZVA stays an abort.
    assert!(skipped >= 6, "only {skipped} cache-maintenance vectors");

    // Every class × writeback × size (PLAN M17 acceptance).
    for store in [false, true] {
        for size in [1, 2, 4, 8] {
            for (class, index) in [
                ("imm", Index::Offset),
                ("pre", Index::Pre),
                ("post", Index::Post),
                ("reg", Index::Offset),
            ] {
                let key = (class, store, size, "", index);
                assert!(covered.contains(&key), "corpus lacks {key:?}");
            }
        }
        for size in [4, 8] {
            for index in [Index::Offset, Index::Pre, Index::Post] {
                let key = ("pair", store, size, "", index);
                assert!(covered.contains(&key), "corpus lacks {key:?}");
            }
        }
    }
    for index in [Index::Offset, Index::Pre, Index::Post] {
        assert!(
            covered.contains(&("pair", false, 4, "sw", index)),
            "no ldpsw {index:?}"
        );
    }
    // Every unsupported class the plan names, and the CONSTRAINED UNPREDICTABLE refusals.
    for name in [
        "exclusive",
        "atomic",
        "ordered",
        "simd-fp",
        "dc-zva",
        "address-translation",
        "literal",
        "unprivileged",
        "non-temporal-pair",
        "pointer-auth",
        "memory-tag",
        "unpredictable",
        "unallocated",
        "not-load-store",
    ] {
        assert!(
            unsupported.contains(name),
            "no undecodable vector of class {name}"
        );
    }
}

fn xorshift(x: &mut u64) -> u64 {
    *x ^= *x >> 12;
    *x ^= *x << 25;
    *x ^= *x >> 27;
    x.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

/// The invariants `vcpu/mmio.rs` relies on for an accepted decode.
fn check_invariants(w: u32, m: &MemInsn) {
    assert!(
        m.rt < 32 && m.rn < 32,
        "{w:08x}: register out of range {m:?}"
    );
    if let Some(rt2) = m.rt2 {
        assert!(rt2 < 32, "{w:08x}");
        assert!(
            matches!(m.size, AccessSize::B4 | AccessSize::B8),
            "{w:08x}: pair size"
        );
        assert!(
            matches!(m.offset, Offset::Imm(_)),
            "{w:08x}: pair with register offset"
        );
        if !m.is_store() {
            assert_ne!(m.rt, rt2, "{w:08x}: ldp with Rt == Rt2 accepted");
        }
    }
    if m.writes_back() && m.rn != 31 {
        assert_ne!(m.rn, m.rt, "{w:08x}: writeback with Rn == Rt accepted");
        assert_ne!(
            Some(m.rn),
            m.rt2,
            "{w:08x}: writeback with Rn == Rt2 accepted"
        );
    }
    match m.offset {
        Offset::Imm(i) => assert!((-4096..=32760).contains(&i), "{w:08x}: offset {i}"),
        Offset::Reg { rm, shift, .. } => {
            assert!(rm < 32 && shift <= 3, "{w:08x}");
            assert_eq!(
                m.index,
                Index::Offset,
                "{w:08x}: register offset with writeback"
            );
        }
    }
    if let Direction::Load(LoadExt::Sign32) = m.dir {
        assert!(matches!(m.size, AccessSize::B1 | AccessSize::B2), "{w:08x}");
    }
}

/// PLAN M17 security test: random words decode totally (≥ 10,000; here 200,000).
#[test]
fn random_words_decode_totally() {
    let seed: u64 = std::env::var("MACVMM_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x1517_0dec_0de5_eed5);
    let mut x = seed.max(1);
    let mut accepted = 0u32;
    for i in 0..200_000u32 {
        let r = xorshift(&mut x);
        let mut w = (r >> 32) as u32;
        if i % 2 == 1 {
            // Force the load/store group with V = 0 (bit 27 set, bits 26 and 25 clear).
            w = (w | (1 << 27)) & !(0b11 << 25);
        }
        let shown = describe(w);
        assert!(!shown.is_empty(), "seed {seed} word {w:08x}");
        if let Ok(Insn::Mem(m)) = decode(w) {
            accepted += 1;
            check_invariants(w, &m);
            // Address and value helpers are total for arbitrary register values.
            let _ = m.addresses(r, r.rotate_left(17));
            let _ = m.load_value(r);
        }
    }
    assert!(
        accepted > 10_000,
        "only {accepted} accepted: the forced half should mostly decode"
    );
}

fn mem(w: u32) -> MemInsn {
    match decode(w) {
        Ok(Insn::Mem(m)) => m,
        other => panic!("{w:08x} decoded to {other:?}"),
    }
}

#[test]
fn address_arithmetic() {
    // ldr x1, [x2, #8]! : access at base + 8, base becomes base + 8.
    let m = mem(0xf8408c41);
    assert_eq!(m.addresses(0x1000, 0), (0x1008, 0x1008));
    // ldr x30, [sp], #16 : access at base, base becomes base + 16.
    let m = mem(0xf84107fe);
    assert_eq!(m.base(), Gpr::Sp);
    assert_eq!(m.addresses(0x8000, 0), (0x8000, 0x8010));
    // stp x29, x30, [sp, #-16]!
    let m = mem(0xa9bf7bfd);
    assert_eq!(m.addresses(0x8000, 0), (0x7ff0, 0x7ff0));
    // str w1, [x2, w3, uxtw #2] with w3 = 0xffff_ffff (upper bits of x3 ignored).
    let m = mem(0xb8235841);
    assert_eq!(
        m.addresses(0x1000, 0xdead_0000_ffff_ffff).0,
        0x1000 + 0x3_ffff_fffc
    );
    // str x1, [x2, w3, sxtw] with w3 = -1.
    let m = mem(0xf823c841);
    assert_eq!(m.addresses(0x1000, 0xffff_ffff).0, 0xfff);
    // ldr x1, [x2, xzr]: the index register is XZR.
    let m = mem(0xf87f6841);
    assert_eq!(m.index_reg(), Some(Gpr::Zr));
    // Address arithmetic is modulo 2^64 (ARM ARM J1.1), not an overflow.
    let m = mem(0xf8408c41);
    assert_eq!(m.addresses(u64::MAX - 3, 0), (4, 4));
}

#[test]
fn load_extension() {
    // ldrsb w17, [x18, #3]
    assert_eq!(mem(0x39c00e51).load_value(0x80), 0xffff_ff80);
    // ldrsb x19, [x20, #5]
    assert_eq!(mem(0x39801693).load_value(0x80), 0xffff_ffff_ffff_ff80);
    // ldrsh w21, [x22, #10]: bits above the size in the raw value are ignored.
    assert_eq!(mem(0x79c016d5).load_value(0xdead_7fff), 0x7fff);
    // ldrsh x23, [x24, #14]
    assert_eq!(mem(0x79801f17).load_value(0x8001), 0xffff_ffff_ffff_8001);
    // ldrsw x25, [x26, #20]
    assert_eq!(
        mem(0xb9801759).load_value(0x8000_0000),
        0xffff_ffff_8000_0000
    );
    // ldr w13, [x14, #12]: zero-extended, upper raw bits dropped.
    assert_eq!(mem(0xb9400dcd).load_value(u64::MAX), 0xffff_ffff);
    // ldpsw x1, x2, [x3]
    assert_eq!(mem(0x69400861).load_value(0xffff_fffe), u64::MAX - 1);
}

#[test]
fn gather_reads_only_what_is_needed() {
    // str x1, [x2, w3, sxtw]: base, index and data.
    let m = mem(0xf823c841);
    let mut asked = Vec::new();
    let ops = Operands::gather(&m, |g| {
        asked.push(g);
        Ok::<u64, ()>(match g {
            Gpr::X(n) => u64::from(n) * 0x100,
            _ => unreachable!(),
        })
    })
    .unwrap();
    assert_eq!(asked, vec![Gpr::X(2), Gpr::X(3), Gpr::X(1)]);
    assert_eq!(
        ops,
        Operands {
            base: 0x200,
            index: 0x300,
            rt: 0x100,
            rt2: 0
        }
    );
    // ldp x29, x30, [sp], #16: only the base (SP) is read.
    let m = mem(0xa8c17bfd);
    let mut asked = Vec::new();
    Operands::gather(&m, |g| {
        asked.push(g);
        Ok::<u64, ()>(0)
    })
    .unwrap();
    assert_eq!(asked, vec![Gpr::Sp]);
    // stp xzr, xzr, [x0]: XZR is never read through the callback.
    let m = mem(0xa9007c1f);
    let mut asked = Vec::new();
    Operands::gather(&m, |g| {
        asked.push(g);
        Ok::<u64, ()>(7)
    })
    .unwrap();
    assert_eq!(asked, vec![Gpr::X(0)]);
    // Errors from the register file propagate.
    assert_eq!(
        Operands::gather(&m, |_| Err::<u64, &str>("hvf")),
        Err("hvf")
    );
}

const PAGE_VA: u64 = 0xffff_0000_1000_0000;
const DEV_IPA: u64 = 0x0b00_0000;

/// A stage-1 map with one 4 KiB page: `PAGE_VA` → `DEV_IPA`.
fn one_page(va: u64) -> Option<Mapped> {
    (va >> 12 == PAGE_VA >> 12).then_some(page(DEV_IPA | (va & 0xfff)))
}

/// A translation that lies in a 4 KiB stage-1 page.
fn page(ipa: u64) -> Mapped {
    Mapped {
        ipa,
        mapping_size: 0x1000,
    }
}

/// A mock MMIO bus for the ISV = 0 tests: device windows, preset read values, an optional
/// failing address, and a log of every device access (`r8 0x...`, `w8 0x...=0x...`).
#[derive(Default)]
struct MockBus {
    windows: Vec<(u64, u64)>,
    values: BTreeMap<u64, u64>,
    fail: Option<u64>,
    log: Vec<String>,
}

impl MockBus {
    fn new(windows: &[(u64, u64)]) -> MockBus {
        MockBus {
            windows: windows.to_vec(),
            ..MockBus::default()
        }
    }
}

impl Isv0Bus for MockBus {
    type Error = &'static str;

    fn window(&self, ipa: u64, size: AccessSize) -> Option<u64> {
        let end = ipa.checked_add(size.bytes())?;
        self.windows
            .iter()
            .find(|&&(base, len)| base <= ipa && end <= base + len)
            .map(|&(base, _)| base)
    }

    fn read(&mut self, ipa: u64, size: AccessSize) -> Result<u64, Self::Error> {
        self.log.push(format!("r{} {ipa:#x}", size.bytes()));
        if self.fail == Some(ipa) {
            return Err("injected bus error");
        }
        Ok(self.values.get(&ipa).copied().unwrap_or(0) & size.mask())
    }

    fn write(&mut self, ipa: u64, size: AccessSize, value: u64) -> Result<(), Self::Error> {
        self.log
            .push(format!("w{} {ipa:#x}={value:#x}", size.bytes()));
        if self.fail == Some(ipa) {
            return Err("injected bus error");
        }
        Ok(())
    }
}

/// One device window covering the page `one_page` maps.
fn dev() -> MockBus {
    MockBus::new(&[(DEV_IPA, 0x1000)])
}

#[test]
fn plan_stp_pre_index() {
    // stp x29, x30, [sp, #-16]!  with SP = PAGE_VA + 0x110.
    let m = mem(0xa9bf7bfd);
    let ops = Operands {
        base: PAGE_VA + 0x110,
        index: 0,
        rt: 0x1111,
        rt2: 0x2222,
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x100,
        wnr: true,
    };
    let p = plan_isv0(&m, &ops, exit, &mut one_page, &dev()).unwrap();
    assert_eq!(p.va, PAGE_VA + 0x100);
    assert_eq!(
        p.first,
        BusAccess {
            ipa: DEV_IPA + 0x100,
            size: AccessSize::B8,
            write: Some(0x1111)
        }
    );
    assert_eq!(
        p.second,
        Some(BusAccess {
            ipa: DEV_IPA + 0x108,
            size: AccessSize::B8,
            write: Some(0x2222)
        })
    );
    assert_eq!(p.writeback, Some((Gpr::Sp, PAGE_VA + 0x100)));
}

#[test]
fn plan_ldp_w_post_index_and_store_masking() {
    // ldp w1, w2, [x3], #8
    let m = mem(0x28c10861);
    let ops = Operands {
        base: PAGE_VA + 0x20,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x20,
        wnr: false,
    };
    let p = plan_isv0(&m, &ops, exit, &mut one_page, &dev()).unwrap();
    assert_eq!(p.first.write, None);
    assert_eq!(p.second.unwrap().ipa, DEV_IPA + 0x24);
    assert_eq!(p.writeback, Some((Gpr::X(3), PAGE_VA + 0x28)));
    // strh w1, [x2, #-2]! : the store value is masked to the access size.
    let m = mem(0x781fec41);
    let ops = Operands {
        base: PAGE_VA + 0x12,
        rt: 0xdead_beef,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x10,
        wnr: true,
    };
    let p = plan_isv0(&m, &ops, exit, &mut one_page, &dev()).unwrap();
    assert_eq!(p.first.write, Some(0xbeef));
    assert_eq!(p.second, None);
}

/// PLAN M17 security test (MMIO-4, F17): a decoded address in a different page from the exit
/// IPA, and a store instruction with a read syndrome, both refuse (→ inject an abort) and make
/// no bus access: the mock bus's log stays empty through the whole emulation call.
#[test]
fn isv0_ipa_mismatch_aborts() {
    let mut bus = dev();
    // str x1, [x2, #8]  where x2 + 8 lies one page above the faulting IPA's page.
    let m = mem(0xf9000441);
    let ops = Operands {
        base: PAGE_VA + 0x1000,
        rt: 5,
        ..Operands::default()
    };
    let two_pages = |va: u64| Some(page(DEV_IPA + (va - PAGE_VA)));
    let exit = ExitFacts {
        ipa: DEV_IPA + 8,
        wnr: true,
    };
    assert_eq!(
        emulate_isv0(&m, &ops, exit, &mut { two_pages }, &mut bus),
        Err(Isv0Error::Refused(Refusal::AddressMismatch {
            decoded: DEV_IPA + 0x1008,
            exit: DEV_IPA + 8
        }))
    );
    assert_eq!(
        bus.log,
        Vec::<String>::new(),
        "page mismatch touched the bus"
    );
    // Same page, different offset: still a mismatch (the exit IPA is a full byte address).
    let ops = Operands {
        base: PAGE_VA,
        rt: 5,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x10,
        wnr: true,
    };
    assert!(matches!(
        emulate_isv0(&m, &ops, exit, &mut one_page, &mut bus),
        Err(Isv0Error::Refused(Refusal::AddressMismatch { .. }))
    ));
    assert_eq!(
        bus.log,
        Vec::<String>::new(),
        "offset mismatch touched the bus"
    );
    // A store whose syndrome says read (WnR = 0): the code changed under us.
    let exit = ExitFacts {
        ipa: DEV_IPA + 8,
        wnr: false,
    };
    assert_eq!(
        emulate_isv0(&m, &ops, exit, &mut one_page, &mut bus),
        Err(Isv0Error::Refused(Refusal::Direction {
            insn_store: true,
            wnr: false
        }))
    );
    assert_eq!(bus.log, Vec::<String>::new(), "store/WnR=0 touched the bus");
    // And a load whose syndrome says write.
    let ld = mem(0xf9400c2f); // ldr x15, [x1, #24]
    let ops = Operands {
        base: PAGE_VA,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 24,
        wnr: true,
    };
    assert!(matches!(
        emulate_isv0(&ld, &ops, exit, &mut one_page, &mut bus),
        Err(Isv0Error::Refused(Refusal::Direction {
            insn_store: false,
            wnr: true
        }))
    ));
    assert_eq!(bus.log, Vec::<String>::new(), "load/WnR=1 touched the bus");
    // The direction check happens before any translation is attempted.
    let mut called = false;
    let _ = emulate_isv0(
        &ld,
        &ops,
        exit,
        &mut |_| {
            called = true;
            None
        },
        &mut bus,
    );
    assert!(!called);
    assert!(bus.log.is_empty());
    // Control: the same load with the right syndrome does reach the device, so the empty logs
    // above are the refusals' doing.
    let exit = ExitFacts {
        ipa: DEV_IPA + 24,
        wnr: false,
    };
    assert!(emulate_isv0(&ld, &ops, exit, &mut one_page, &mut bus).is_ok());
    assert_eq!(bus.log, vec![format!("r8 {:#x}", DEV_IPA + 24)]);
}

/// PLAN M17 security checklist (MMIO-4, F17): an LDP/STP's second access must hit the same
/// device. The guest's page tables map one contiguous VA range over two adjacent device windows
/// (identity here); a pair whose elements land in different windows, or whose second element
/// straddles a window end or falls off the bus, is refused with no access to either device.
#[test]
fn isv0_pair_across_devices_aborts() {
    const A: u64 = 0x0a00_0000; // two adjacent 0x200 windows, like the virtio-mmio slots
    const B: u64 = A + 0x200;
    let two_devs = || MockBus::new(&[(A, 0x200), (B, 0x200)]);
    let ident = |va: u64| Some(Mapped::identity(va));
    // stp x1, x2, [x3] with x3 = A + 0x1f8: element 1 is A's last word, element 2 is B's first.
    let stp = mem(0xa9000861);
    let ops = Operands {
        base: A + 0x1f8,
        rt: 0x11,
        rt2: 0x22,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: A + 0x1f8,
        wnr: true,
    };
    let mut bus = two_devs();
    assert_eq!(
        emulate_isv0(&stp, &ops, exit, &mut { ident }, &mut bus),
        Err(Isv0Error::Refused(Refusal::CrossDevice {
            first: Some(A),
            second: Some(B)
        }))
    );
    assert_eq!(
        bus.log,
        Vec::<String>::new(),
        "cross-device stp touched a device"
    );
    // The same through the planner alone (what a W6 caller that plans first sees).
    assert!(matches!(
        plan_isv0(&stp, &ops, exit, &mut { ident }, &two_devs()),
        Err(Refusal::CrossDevice { .. })
    ));
    // ldp w1, w2, [x3] at B + 0x1fc: element 2 is past the last window (unmapped).
    let ldp = mem(0x29400861);
    let ops = Operands {
        base: B + 0x1fc,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: B + 0x1fc,
        wnr: false,
    };
    let mut bus = two_devs();
    assert_eq!(
        emulate_isv0(&ldp, &ops, exit, &mut { ident }, &mut bus),
        Err(Isv0Error::Refused(Refusal::CrossDevice {
            first: Some(B),
            second: None
        }))
    );
    assert!(bus.log.is_empty(), "pair off the bus touched a device");
    // A misaligned stp whose first element straddles A's end (A + 0x1fc..A + 0x204).
    let ops = Operands {
        base: A + 0x1fc,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: A + 0x1fc,
        wnr: true,
    };
    let mut bus = two_devs();
    assert_eq!(
        emulate_isv0(&stp, &ops, exit, &mut { ident }, &mut bus),
        Err(Isv0Error::Refused(Refusal::CrossDevice {
            first: None,
            second: Some(B)
        }))
    );
    assert!(bus.log.is_empty(), "straddling pair touched a device");
    // Control: the same pair fully inside A is emulated, both elements in order.
    let ops = Operands {
        base: A + 0x1f0,
        rt: 0x11,
        rt2: 0x22,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: A + 0x1f0,
        wnr: true,
    };
    let mut bus = two_devs();
    assert!(emulate_isv0(&stp, &ops, exit, &mut { ident }, &mut bus).is_ok());
    assert_eq!(
        bus.log,
        vec![
            format!("w8 {:#x}=0x11", A + 0x1f0),
            format!("w8 {:#x}=0x22", A + 0x1f8)
        ]
    );
}

#[test]
fn execute_returns_extended_loads_and_writeback() {
    // ldpsw x1, x2, [x3], #8 : both words sign-extended to 64 bits, base += 8.
    let m = mem(0x68c10861);
    let mut bus = dev();
    bus.values.insert(DEV_IPA + 0x40, 0x8000_0000);
    bus.values.insert(DEV_IPA + 0x44, 0x7fff_ffff);
    let ops = Operands {
        base: PAGE_VA + 0x40,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x40,
        wnr: false,
    };
    assert_eq!(
        emulate_isv0(&m, &ops, exit, &mut one_page, &mut bus),
        Ok(Commit {
            loads: [
                Some((Gpr::X(1), 0xffff_ffff_8000_0000)),
                Some((Gpr::X(2), 0x7fff_ffff))
            ],
            writeback: Some((Gpr::X(3), PAGE_VA + 0x48)),
        })
    );
    // ldp xzr, x2, [x3] : the XZR element is read from the device but never committed.
    let m = mem(0xa940087f);
    let ops = Operands {
        base: PAGE_VA + 0x40,
        ..Operands::default()
    };
    let c = emulate_isv0(&m, &ops, exit, &mut one_page, &mut dev()).unwrap();
    assert_eq!(c.loads[0], None);
    assert!(matches!(c.loads[1], Some((Gpr::X(2), _))));
    assert_eq!(c.writeback, None);
    // A store commits no register except the writeback.
    let m = mem(0xa9bf7bfd); // stp x29, x30, [sp, #-16]!
    let ops = Operands {
        base: PAGE_VA + 0x110,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x100,
        wnr: true,
    };
    let c = emulate_isv0(&m, &ops, exit, &mut one_page, &mut dev()).unwrap();
    assert_eq!(c.loads, [None, None]);
    assert_eq!(c.writeback, Some((Gpr::Sp, PAGE_VA + 0x100)));
}

/// Writeback only after both accesses succeed (MMIO-4): a failing second access yields an
/// error and no [`Commit`], so the caller changes no register.
#[test]
fn execute_failure_commits_nothing() {
    let m = mem(0xa9c10864); // ldp x4, x2, [x3, #16]!
    assert!(m.writes_back());
    let ops = Operands {
        base: PAGE_VA + 0x10,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0x20,
        wnr: false,
    };
    let mut bus = dev();
    bus.fail = Some(DEV_IPA + 0x28);
    assert_eq!(
        emulate_isv0(&m, &ops, exit, &mut one_page, &mut bus),
        Err(Isv0Error::Bus("injected bus error"))
    );
    let plan = plan_isv0(&m, &ops, exit, &mut one_page, &dev()).unwrap();
    assert_eq!(
        execute(&plan, &mut bus),
        Err("injected bus error"),
        "a failed access must not produce register updates"
    );
}

#[test]
fn plan_pair_must_stay_contiguous() {
    // stp x1, x2, [x3] with x3 = PAGE_VA + 0xff8: the second element crosses into an
    // unmapped VA page.
    let m = mem(0xa9000861); // stp x1, x2, [x3]
    let ops = Operands {
        base: PAGE_VA + 0xff8,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0xff8,
        wnr: true,
    };
    assert_eq!(
        plan_isv0(&m, &ops, exit, &mut one_page, &dev()),
        Err(Refusal::PairMismatch {
            decoded: None,
            expected: DEV_IPA + 0x1000
        })
    );
    // The second element maps, but not to exit IPA + 8.
    let scattered = |va: u64| {
        Some(page(if va & 0xfff == 0 {
            0x5000
        } else {
            DEV_IPA + (va & 0xfff)
        }))
    };
    assert_eq!(
        plan_isv0(&m, &ops, exit, &mut { scattered }, &dev()),
        Err(Refusal::PairMismatch {
            decoded: Some(0x5000),
            expected: DEV_IPA + 0x1000
        })
    );
    // An exit IPA at the top of the address space cannot have a second element.
    let ident = |va: u64| Some(Mapped::identity(va));
    let ops = Operands {
        base: u64::MAX - 7,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: u64::MAX - 7,
        wnr: true,
    };
    assert_eq!(
        plan_isv0(&m, &ops, exit, &mut { ident }, &dev()),
        Err(Refusal::Overflow)
    );
    // The decoded address does not translate at all.
    let ops = Operands {
        base: 0x1234_5000,
        ..Operands::default()
    };
    assert_eq!(
        plan_isv0(&m, &ops, exit, &mut one_page, &dev()),
        Err(Refusal::Untranslatable { va: 0x1234_5000 })
    );
}

/// MMIO-4 review fix: the hardware checked stage-1 permissions only for the page that holds
/// the faulting element. A pair whose second element falls on the next 4 KiB page is refused,
/// even though that page maps contiguously onto the same 8 KiB device window (its descriptor
/// could be read-only or kernel-only). Inside one 2 MiB block, or with the MMU off, the same
/// pair is emulated.
#[test]
fn isv0_pair_across_stage1_pages_aborts() {
    let big = || MockBus::new(&[(DEV_IPA, 0x2000)]);
    // stp x1, x2, [x3] at PAGE_VA + 0xff8: element 2 is the first word of the next VA page.
    let stp = mem(0xa9000861);
    let ops = Operands {
        base: PAGE_VA + 0xff8,
        rt: 0x11,
        rt2: 0x22,
        ..Operands::default()
    };
    let exit = ExitFacts {
        ipa: DEV_IPA + 0xff8,
        wnr: true,
    };
    let two_pages = |va: u64| Some(page(DEV_IPA + (va - PAGE_VA)));
    let mut bus = big();
    assert_eq!(
        emulate_isv0(&stp, &ops, exit, &mut { two_pages }, &mut bus),
        Err(Isv0Error::Refused(Refusal::CrossesMapping {
            va: PAGE_VA + 0xff8,
            len: 16,
            mapping_size: 0x1000
        }))
    );
    assert!(bus.log.is_empty(), "page-crossing pair touched the device");
    // A single access that crosses the page is refused the same way (str x1, [x3, #-4]!).
    let str_x = mem(0xf81fcc61);
    let ops1 = Operands {
        base: PAGE_VA + 0x1000,
        rt: 0x11,
        ..Operands::default()
    };
    let exit1 = ExitFacts {
        ipa: DEV_IPA + 0xffc,
        wnr: true,
    };
    assert!(matches!(
        plan_isv0(&str_x, &ops1, exit1, &mut { two_pages }, &big()),
        Err(Refusal::CrossesMapping { len: 8, .. })
    ));
    // Control: one 2 MiB block holds both elements, so one descriptor covers the whole pair.
    let block = |va: u64| {
        Some(Mapped {
            ipa: DEV_IPA + (va - PAGE_VA),
            mapping_size: 0x20_0000,
        })
    };
    let mut bus = big();
    assert!(emulate_isv0(&stp, &ops, exit, &mut { block }, &mut bus).is_ok());
    assert_eq!(bus.log.len(), 2, "{:?}", bus.log);
    // Control: MMU off, no stage-1 permissions to bypass.
    let ops = Operands {
        base: DEV_IPA + 0xff8,
        ..ops
    };
    let mut bus = big();
    let ident = |va: u64| Some(Mapped::identity(va));
    assert!(emulate_isv0(&stp, &ops, exit, &mut { ident }, &mut bus).is_ok());
    assert_eq!(bus.log.len(), 2, "{:?}", bus.log);
}

#[test]
fn sp_selection_follows_pstate() {
    assert_eq!(SpSel::from_pstate(Pstate(0x3c5)), Some(SpSel::El1)); // EL1h
    assert_eq!(SpSel::from_pstate(Pstate(0x3c4)), Some(SpSel::El0)); // EL1t
    assert_eq!(SpSel::from_pstate(Pstate(0x0)), Some(SpSel::El0)); // EL0t
    assert_eq!(SpSel::from_pstate(Pstate(0x9)), None); // EL2h
    assert_eq!(SpSel::from_pstate(Pstate(0x10)), None); // AArch32
}

#[test]
fn unpredictable_forms_are_refused_but_register_31_is_not_a_conflict() {
    // str xzr, [sp, #-16]! : Rn = Rt = 31 means SP and XZR, which is well defined.
    let m = mem(0xf81f0fff);
    assert_eq!((m.base(), m.transfer()), (Gpr::Sp, Gpr::Zr));
    // ldp x1, x2, [x2], #16 (Rn == Rt2) and stp x1, x2, [x1, #16]! (Rn == Rt).
    for w in [0xa8c10841u32, 0xa9810821] {
        assert!(
            matches!(decode(w), Err(Unsupported::Unpredictable(_))),
            "{w:08x}"
        );
    }
    // Without writeback, Rn == Rt is fine: ldr x1, [x1, #8].
    assert!(decode(0xf9400421).is_ok());
}
