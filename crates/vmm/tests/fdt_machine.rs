//! The `virt` machine's device tree (PLAN M7 "Acceptance: host" and "Security tests";
//! architecture §12.2; threat model FDT-2, FDT-3, FDT-4).
//!
//! Every check reads the blob back through the test-only `fdt::reader`, so it judges the bytes
//! a guest would see, not the builder's intentions. The golden comparison decompiles the blob
//! with `dtc -I dtb -O dts` (a dev-only tool: `brew install dtc`) and compares it with
//! `tests/golden/virt-1cpu-512m.dts`, which is exactly what
//! `macvmm run --mem 512M --kernel <test guest> --dtb-out F` writes (seeds zeroed, FDT-4).
//! Without `dtc` the comparison prints `dtc not installed; golden comparison skipped`; the
//! M7 acceptance run had it installed. `MACVMM_BLESS_GOLDEN=1` rewrites the golden file
//! (review the diff before keeping it).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Command;
use vmm::arch::layout::{
    GICD_BASE, GICR_BASE, GICR_FRAME_SIZE, Layout, PL011_BASE, PL031_BASE, RAM_BASE,
};
use vmm::arch::regs::mpidr;
use vmm::backend::entropy::Entropy;
use vmm::fdt::machine::{MAX_BOOTARGS, MPIDR_AFFINITY_MASK, RNG_SEED_LEN};
use vmm::fdt::reader::{self, Fdt, Node};
use vmm::fdt::{FdtError, MachineDesc, build_dtb, redact_seeds};

const MIB: u64 = 1 << 20;

/// The golden machine: 1 vCPU, 512 MiB, a test-guest boot (no bootargs, no initrd), fixed seeds.
fn golden_desc() -> MachineDesc {
    let mut rng_seed = [0u8; RNG_SEED_LEN];
    for (i, b) in rng_seed.iter_mut().enumerate() {
        *b = i as u8 + 1;
    }
    MachineDesc {
        ncpus: 1,
        mem_bytes: 512 * MIB,
        bootargs: None,
        initrd: None,
        virtio_slots: vec![],
        rng_seed,
        kaslr_seed: 0x0123_4567_89ab_cdef,
    }
}

/// A tree with every optional part: bootargs, initrd, 4 CPUs, two virtio slots.
fn full_desc() -> MachineDesc {
    MachineDesc {
        ncpus: 4,
        mem_bytes: 1 << 30,
        bootargs: Some("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1".into()),
        initrd: Some((0x4260_0000, 0x42f0_0000)),
        virtio_slots: vec![3, 0],
        ..golden_desc()
    }
}

fn parse(desc: &MachineDesc) -> Fdt {
    reader::parse(&build_dtb(Layout::virt(), desc).unwrap()).unwrap()
}

fn node<'a>(f: &'a Fdt, path: &str) -> &'a Node {
    f.find(path)
        .unwrap_or_else(|| panic!("missing node {path}"))
}

fn cells(f: &Fdt, path: &str, prop: &str) -> Vec<u32> {
    node(f, path)
        .prop(prop)
        .unwrap_or_else(|| panic!("{path}: no {prop}"))
        .cells()
        .unwrap()
}

/// The first address of `n`'s `reg`, with `addr_cells` taken from its parent (DT spec §2.3.5).
fn first_reg_addr(n: &Node, addr_cells: u32) -> Option<u64> {
    let c = n.prop("reg")?.cells()?;
    Some(match addr_cells {
        1 => u64::from(c[0]),
        2 => (u64::from(c[0]) << 32) | u64::from(c[1]),
        other => panic!("#address-cells {other}"),
    })
}

#[test]
fn every_expected_node_exists_with_unit_addresses_matching_reg() {
    for desc in [golden_desc(), full_desc()] {
        let f = parse(&desc);
        let mut expected = vec![
            "/".to_owned(),
            "/chosen".into(),
            format!("/memory@{RAM_BASE:x}"),
            "/cpus".into(),
            "/psci".into(),
            "/timer".into(),
            format!("/intc@{GICD_BASE:x}"),
            "/apb-pclk".into(),
            format!("/pl011@{PL011_BASE:x}"),
            format!("/pl031@{PL031_BASE:x}"),
        ];
        for i in 0..desc.ncpus {
            expected.push(format!(
                "/cpus/cpu@{:x}",
                mpidr(i as usize) & MPIDR_AFFINITY_MASK
            ));
        }
        for &s in &desc.virtio_slots {
            let (base, _) = Layout::virt().virtio_slot(s).unwrap();
            expected.push(format!("/virtio_mmio@{base:x}"));
        }
        let mut got: Vec<String> = f.root.walk().into_iter().map(|(p, _)| p).collect();
        got.sort();
        expected.sort();
        assert_eq!(got, expected);
        // Unit address = lowercase hex of the first reg address, no 0x, no leading zeros
        // (DT spec §2.2.1). The address cells come from the parent.
        for (path, n) in f.root.walk() {
            let Some((_, unit)) = n.name.split_once('@') else {
                assert!(
                    n.prop("reg").is_none() || path == "/",
                    "{path} has reg but no @"
                );
                continue;
            };
            let parent = path.rsplit_once('/').unwrap().0;
            let parent = if parent.is_empty() { "/" } else { parent };
            let ac = node(&f, parent)
                .prop("#address-cells")
                .unwrap()
                .u32()
                .unwrap();
            let addr = first_reg_addr(n, ac).unwrap_or_else(|| panic!("{path}: no reg"));
            assert_eq!(unit, format!("{addr:x}"), "{path}");
        }
    }
}

#[test]
fn root_chosen_memory_and_phandles() {
    let f = parse(&golden_desc());
    let root = &f.root;
    assert_eq!(
        root.prop("compatible").unwrap().str(),
        Some("linux,dummy-virt")
    );
    assert_eq!(root.prop("model").unwrap().str(), Some("macvmm-virt"));
    assert_eq!(root.prop("#address-cells").unwrap().u32(), Some(2));
    assert_eq!(root.prop("#size-cells").unwrap().u32(), Some(2));
    assert!(root.prop("dma-coherent").unwrap().value.is_empty());
    // Phandles: gic = 1, apb_pclk = 2; everything points at them.
    let gic = format!("/intc@{GICD_BASE:x}");
    assert_eq!(cells(&f, &gic, "phandle"), [1]);
    assert_eq!(cells(&f, "/apb-pclk", "phandle"), [2]);
    assert_eq!(cells(&f, "/", "interrupt-parent"), [1]);
    let uart = format!("/pl011@{PL011_BASE:x}");
    let rtc = format!("/pl031@{PL031_BASE:x}");
    assert_eq!(cells(&f, &uart, "clocks"), [2, 2]);
    assert_eq!(
        node(&f, &uart).prop("clock-names").unwrap().strs(),
        Some(vec!["uartclk", "apb_pclk"])
    );
    assert_eq!(cells(&f, &rtc, "clocks"), [2]);
    assert_eq!(cells(&f, "/apb-pclk", "clock-frequency"), [24_000_000]);
    assert_eq!(cells(&f, "/apb-pclk", "#clock-cells"), [0]);
    // Memory: one bank, the RAM base and --mem bytes.
    let mem = format!("/memory@{RAM_BASE:x}");
    assert_eq!(
        node(&f, &mem).prop("device_type").unwrap().str(),
        Some("memory")
    );
    assert_eq!(cells(&f, &mem, "reg"), [0, RAM_BASE as u32, 0, 512 << 20]);
    // Chosen: the console path, seeds, and nothing a test-guest boot does not have.
    let chosen = node(&f, "/chosen");
    assert_eq!(
        chosen.prop("stdout-path").unwrap().str(),
        Some(format!("/pl011@{PL011_BASE:x}").as_str())
    );
    assert_eq!(chosen.prop("rng-seed").unwrap().value.len(), 64);
    assert_eq!(
        chosen.prop("kaslr-seed").unwrap().u64(),
        Some(0x0123_4567_89ab_cdef)
    );
    assert!(chosen.prop("bootargs").is_none());
    assert!(chosen.prop("linux,initrd-start").is_none());
    // PSCI over HVC.
    assert_eq!(node(&f, "/psci").prop("method").unwrap().str(), Some("hvc"));
    assert_eq!(
        node(&f, "/psci").prop("compatible").unwrap().strs(),
        Some(vec!["arm,psci-1.0", "arm,psci-0.2", "arm,psci"])
    );
    // Boot CPU in the header.
    assert_eq!(f.header.boot_cpuid_phys, 0);
    assert!(f.reservations.is_empty());
}

#[test]
fn gic_timer_and_uart_interrupts() {
    let f = parse(&golden_desc());
    let gic = format!("/intc@{GICD_BASE:x}");
    assert_eq!(cells(&f, &gic, "#interrupt-cells"), [3]);
    assert_eq!(
        node(&f, &gic).prop("compatible").unwrap().str(),
        Some("arm,gic-v3")
    );
    assert!(node(&f, &gic).prop("interrupt-controller").is_some());
    assert_eq!(cells(&f, &gic, "#redistributor-regions"), [1]);
    assert_eq!(
        cells(&f, &gic, "reg"),
        [
            0,
            GICD_BASE as u32,
            0,
            0x1_0000,
            0,
            GICR_BASE as u32,
            0,
            GICR_FRAME_SIZE as u32
        ]
    );
    // Exactly the four architected-timer PPIs, level-high.
    assert_eq!(
        cells(&f, "/timer", "interrupts"),
        [1, 13, 4, 1, 14, 4, 1, 11, 4, 1, 10, 4]
    );
    assert!(node(&f, "/timer").prop("always-on").is_some());
    assert!(node(&f, "/timer").prop("clock-frequency").is_none());
    assert_eq!(
        cells(&f, &format!("/pl011@{PL011_BASE:x}"), "interrupts"),
        [0, 1, 4]
    );
    assert_eq!(
        cells(&f, &format!("/pl031@{PL031_BASE:x}"), "interrupts"),
        [0, 2, 4]
    );
    assert_eq!(
        node(&f, &format!("/pl011@{PL011_BASE:x}"))
            .prop("compatible")
            .unwrap()
            .strs(),
        Some(vec!["arm,pl011", "arm,primecell"])
    );
}

#[test]
fn cpus_follow_mpidr_and_the_redistributor_window_grows() {
    for n in [1u32, 2, 16, 17, 64] {
        let f = parse(&MachineDesc {
            ncpus: n,
            ..golden_desc()
        });
        let cpus = node(&f, "/cpus");
        assert_eq!(cpus.prop("#address-cells").unwrap().u32(), Some(1));
        assert_eq!(cpus.prop("#size-cells").unwrap().u32(), Some(0));
        assert_eq!(cpus.children.len(), n as usize);
        for (i, c) in cpus.children.iter().enumerate() {
            let reg = mpidr(i) & MPIDR_AFFINITY_MASK;
            assert_eq!(c.name, format!("cpu@{reg:x}"));
            assert_eq!(c.prop("reg").unwrap().u32(), Some(reg as u32));
            assert_eq!(c.prop("enable-method").unwrap().str(), Some("psci"));
            assert_eq!(c.prop("compatible").unwrap().str(), Some("arm,arm-v8"));
            assert_eq!(c.prop("device_type").unwrap().str(), Some("cpu"));
        }
        let gic = cells(&f, &format!("/intc@{GICD_BASE:x}"), "reg");
        assert_eq!(u64::from(gic[7]), GICR_FRAME_SIZE * u64::from(n));
    }
    // cpu 16 is the second cluster: Aff1 = 1.
    let f = parse(&MachineDesc {
        ncpus: 17,
        ..golden_desc()
    });
    assert!(f.find("/cpus/cpu@100").is_some());
    for bad in [0, 65, u32::MAX] {
        let r = build_dtb(
            Layout::virt(),
            &MachineDesc {
                ncpus: bad,
                ..golden_desc()
            },
        );
        assert!(matches!(r, Err(FdtError::InvalidMachine(_))), "{bad}");
    }
    // The biggest tree still fits the 512 KiB slot in front of a test guest.
    let blob = build_dtb(
        Layout::virt(),
        &MachineDesc {
            ncpus: 64,
            ..full_desc()
        },
    )
    .unwrap();
    assert!(blob.len() < 16 << 10, "{}", blob.len());
}

#[test]
fn chosen_bootargs_initrd_and_their_limits() {
    let f = parse(&full_desc());
    let chosen = node(&f, "/chosen");
    assert_eq!(
        chosen.prop("bootargs").unwrap().str(),
        Some("console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1")
    );
    assert_eq!(
        chosen.prop("linux,initrd-start").unwrap().u64(),
        Some(0x4260_0000)
    );
    assert_eq!(
        chosen.prop("linux,initrd-end").unwrap().u64(),
        Some(0x42f0_0000)
    );
    // FDT-2: bootargs ≤ 2047 bytes (+ NUL = COMMAND_LINE_SIZE), no NUL.
    let ok = MachineDesc {
        bootargs: Some("a".repeat(MAX_BOOTARGS)),
        ..golden_desc()
    };
    assert!(build_dtb(Layout::virt(), &ok).is_ok());
    for bad in [
        "a".repeat(MAX_BOOTARGS + 1),
        "console=ttyAMA0\0root=/dev/evil".into(),
    ] {
        let d = MachineDesc {
            bootargs: Some(bad),
            ..golden_desc()
        };
        assert!(
            matches!(
                build_dtb(Layout::virt(), &d),
                Err(FdtError::InvalidMachine(_))
            ),
            "bootargs refused"
        );
    }
    for initrd in [(0x4300_0000, 0x4300_0000), (0x4300_0000, 0x4200_0000)] {
        let d = MachineDesc {
            initrd: Some(initrd),
            ..golden_desc()
        };
        assert!(build_dtb(Layout::virt(), &d).is_err());
    }
    // RAM sizes go through the layout's rules.
    for mem in [0, 63 * MIB, 65 * MIB, u64::MAX] {
        let d = MachineDesc {
            mem_bytes: mem,
            ..golden_desc()
        };
        assert!(build_dtb(Layout::virt(), &d).is_err(), "{mem:#x}");
    }
}

#[test]
fn virtio_slots_only_when_populated() {
    let f = parse(&golden_desc());
    assert!(!f.root.children.iter().any(|c| c.name.starts_with("virtio")));
    let f = parse(&full_desc());
    let slots: Vec<&Node> = f
        .root
        .children
        .iter()
        .filter(|c| c.name.starts_with("virtio_mmio@"))
        .collect();
    let names: Vec<&str> = slots.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(
        names,
        ["virtio_mmio@a000000", "virtio_mmio@a000600"],
        "sorted by slot"
    );
    assert_eq!(
        slots[0].prop("interrupts").unwrap().cells(),
        Some(vec![0, 16, 4])
    );
    assert_eq!(
        slots[1].prop("interrupts").unwrap().cells(),
        Some(vec![0, 19, 4])
    );
    assert_eq!(
        slots[1].prop("reg").unwrap().cells(),
        Some(vec![0, 0x0a00_0600, 0, 0x200])
    );
    assert_eq!(
        slots[0].prop("compatible").unwrap().str(),
        Some("virtio,mmio")
    );
    assert!(slots[0].prop("dma-coherent").is_some());
    for bad in [vec![1, 1], vec![32], vec![usize::MAX]] {
        let d = MachineDesc {
            virtio_slots: bad,
            ..golden_desc()
        };
        assert!(build_dtb(Layout::virt(), &d).is_err());
    }
}

#[test]
fn deterministic_for_a_given_desc() {
    let a = build_dtb(Layout::virt(), &full_desc()).unwrap();
    let b = build_dtb(Layout::virt(), &full_desc()).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.len() % 4, 0);
}

/// FDT-3: two machine builds with the real entropy source get different seeds.
#[test]
fn seeds_differ_per_run() {
    let e = Entropy::os();
    let seeds = |_: u32| {
        let d = MachineDesc::from_entropy(1, 512 * MIB, &e).unwrap();
        let f = parse(&d);
        let c = node(&f, "/chosen");
        (
            c.prop("rng-seed").unwrap().value.clone(),
            c.prop("kaslr-seed").unwrap().u64().unwrap(),
        )
    };
    let (r1, k1) = seeds(1);
    let (r2, k2) = seeds(2);
    assert_eq!(r1.len(), 64);
    assert_ne!(r1, r2, "rng-seed repeated across builds");
    assert_ne!(k1, k2, "kaslr-seed repeated across builds");
    assert!(r1.iter().any(|&b| b != 0));
}

/// FDT-4: the `--dtb-out` copy has both seeds zeroed in place; every other byte is unchanged.
#[test]
fn dtb_out_zeroes_seeds() {
    for desc in [golden_desc(), full_desc()] {
        let blob = build_dtb(Layout::virt(), &desc).unwrap();
        let red = redact_seeds(&blob).unwrap();
        assert_eq!(red.len(), blob.len());
        let f = reader::parse(&red).unwrap();
        let chosen = node(&f, "/chosen");
        assert_eq!(chosen.prop("rng-seed").unwrap().value, vec![0u8; 64]);
        assert_eq!(chosen.prop("kaslr-seed").unwrap().u64(), Some(0));
        // Locate the two values in the original and check every other byte matches.
        let rng_at = find(&blob, &desc.rng_seed).unwrap();
        let kaslr_at = find(&blob, &desc.kaslr_seed.to_be_bytes()).unwrap();
        for (i, (a, b)) in blob.iter().zip(&red).enumerate() {
            let in_rng = (rng_at..rng_at + 64).contains(&i);
            let in_kaslr = (kaslr_at..kaslr_at + 8).contains(&i);
            if in_rng || in_kaslr {
                assert_eq!(*b, 0, "byte {i}");
            } else {
                assert_eq!(a, b, "byte {i} changed");
            }
        }
        // Redacting twice is a no-op; a blob that is not ours is refused.
        assert_eq!(redact_seeds(&red).unwrap(), red);
        assert!(redact_seeds(&blob[..blob.len() - 1]).is_err());
        assert!(redact_seeds(&[]).is_err());
    }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Run `dtc -I dtb -O dts` on `blob`; `None` if dtc is not installed.
fn dtc(blob: &[u8], name: &str) -> Option<(bool, String, String)> {
    let dir = std::env::temp_dir().join(format!("macvmm-fdt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let input = dir.join(name);
    std::fs::write(&input, blob).unwrap();
    let out = match Command::new("dtc")
        .args(["-I", "dtb", "-O", "dts", "-o", "-"])
        .arg(&input)
        .output()
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("cannot run dtc: {e}"),
    };
    let _ = std::fs::remove_file(&input);
    Some((
        out.status.success(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    ))
}

/// A line on the test's stderr (crates/vmm bans the print macros, RUST-5).
fn say(line: &str) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "{line}");
}

fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/virt-1cpu-512m.dts")
}

/// The decompiled tree matches the frozen golden file, and `dtc` prints no warning.
#[test]
fn golden_dts_matches() {
    let blob = redact_seeds(&build_dtb(Layout::virt(), &golden_desc()).unwrap()).unwrap();
    let Some((ok, dts, warnings)) = dtc(&blob, "golden.dtb") else {
        say("dtc not installed; golden comparison skipped");
        return;
    };
    assert!(ok, "dtc failed: {warnings}");
    assert_eq!(warnings, "", "dtc warnings on the golden tree");
    if std::env::var_os("MACVMM_BLESS_GOLDEN").is_some() {
        std::fs::write(golden_path(), &dts).unwrap();
    }
    let golden = std::fs::read_to_string(golden_path()).unwrap();
    assert_eq!(dts, golden, "DTS differs from {}", golden_path().display());
    say(&format!(
        "golden comparison ran: {} lines match",
        golden.lines().count()
    ));
}

/// Every optional part (bootargs, initrd, SMP, virtio slots) is also warning-free in dtc.
#[test]
fn full_tree_is_dtc_clean() {
    let blob = build_dtb(Layout::virt(), &full_desc()).unwrap();
    let Some((ok, dts, warnings)) = dtc(&blob, "full.dtb") else {
        say("dtc not installed; golden comparison skipped");
        return;
    };
    assert!(ok, "dtc failed: {warnings}");
    assert_eq!(warnings, "", "dtc warnings");
    assert!(dts.contains("virtio_mmio@a000600"), "{dts}");
}

// ---------------------------------------------------------------------------------------------
// The course corpus (PLAN M7: `cargo xtask export-vectors` publishes it as
// `course/site/labs/vectors/fdt.json` for the ch10 DTB lab). One corpus, two readers: this test
// regenerates it from the real writer and reader and fails if the checked-in file differs, so
// the lab can never show a blob or a decode the VMM does not produce.

const CORPUS: &str = "tests/data/fdt_vectors.json";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// One valid vector: the blob and its decode (every node, every property as hex).
fn valid_vector(name: &str, about: &str, blob: &[u8]) -> String {
    let f = reader::parse(blob).unwrap();
    let nodes: Vec<String> = f
        .root
        .walk()
        .into_iter()
        .map(|(path, n)| {
            let props: Vec<String> = n
                .props
                .iter()
                .map(|p| {
                    format!(
                        "{{\"name\": {}, \"value\": \"{}\"}}",
                        json_str(&p.name),
                        hex(&p.value)
                    )
                })
                .collect();
            format!(
                "        {{\"path\": {}, \"props\": [{}]}}",
                json_str(&path),
                props.join(", ")
            )
        })
        .collect();
    format!(
        "    {{\n      \"name\": {},\n      \"about\": {},\n      \"dtb\": \"{}\",\n      \"error\": null,\n      \"nodes\": [\n{}\n      ]\n    }}",
        json_str(name),
        json_str(about),
        hex(blob),
        nodes.join(",\n")
    )
}

/// One hostile vector: a malformed blob and the reader's verdict.
fn hostile_vector(name: &str, about: &str, blob: &[u8]) -> String {
    let err = reader::parse(blob).unwrap_err();
    format!(
        "    {{\n      \"name\": {},\n      \"about\": {},\n      \"dtb\": \"{}\",\n      \"error\": {},\n      \"nodes\": []\n    }}",
        json_str(name),
        json_str(about),
        hex(blob),
        json_str(&format!("{err:?}"))
    )
}

fn corpus() -> String {
    let mut w = vmm::fdt::FdtWriter::new();
    let r = w.begin_node("").unwrap();
    w.end_node(r).unwrap();
    let empty = w.finish(0).unwrap();
    let mut w = vmm::fdt::FdtWriter::new();
    let r = w.begin_node("").unwrap();
    w.prop_str("compatible", "a,board").unwrap();
    let n = w.begin_node("uart@1000").unwrap();
    w.prop_strs("compatible", &["arm,pl011", "arm,primecell"])
        .unwrap();
    w.prop_cells("reg", &[0, 0x1000, 0, 0x100]).unwrap();
    w.end_node(n).unwrap();
    w.end_node(r).unwrap();
    let dedup = w.finish(0).unwrap();
    let golden = redact_seeds(&build_dtb(Layout::virt(), &golden_desc()).unwrap()).unwrap();
    let full = redact_seeds(&build_dtb(Layout::virt(), &full_desc()).unwrap()).unwrap();
    let mut bad_magic = golden.clone();
    bad_magic[0] = 0xde;
    let mut bad_nameoff = dedup.clone();
    let off_struct = u32::from_be_bytes(dedup[8..12].try_into().unwrap()) as usize;
    // The first token after the root's BEGIN_NODE "" (8 bytes) is the root's first FDT_PROP.
    let prop = off_struct + 8;
    bad_nameoff[prop + 8..prop + 12].copy_from_slice(&0x7fff_ffffu32.to_be_bytes());
    let vectors = [
        valid_vector(
            "empty-root",
            "The smallest valid tree: a root node named \"\" and nothing else.",
            &empty,
        ),
        valid_vector(
            "strings-dedup",
            "Two compatible properties share one strings-block entry (DT spec 5.5).",
            &dedup,
        ),
        valid_vector(
            "virt-1cpu-512m",
            "What macvmm run --mem 512M --kernel <test guest> --dtb-out writes (seeds zeroed, FDT-4).",
            &golden,
        ),
        valid_vector(
            "virt-4cpu-1g-full",
            "Bootargs, an initrd, four CPUs and two virtio-mmio slots (seeds zeroed).",
            &full,
        ),
        hostile_vector(
            "bad-magic",
            "The first word is not 0xd00dfeed: rejected before anything else is read.",
            &bad_magic,
        ),
        hostile_vector(
            "truncated-header",
            "Only 20 of the 40 header bytes.",
            &golden[..20],
        ),
        hostile_vector(
            "nameoff-past-strings",
            "A property's name offset points far past the strings block.",
            &bad_nameoff,
        ),
    ];
    format!(
        "{{\n  \"about\": \"macvmm FDT vectors: generated by crates/vmm/tests/fdt_machine.rs from fdt::writer and fdt::reader; published by cargo xtask export-vectors. Hex is the exact blob; nodes are its decode.\",\n  \"vectors\": [\n{}\n  ]\n}}\n",
        vectors.join(",\n")
    )
}

#[test]
fn course_corpus_is_current() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(CORPUS);
    let want = corpus();
    if std::env::var_os("MACVMM_BLESS_GOLDEN").is_some() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{CORPUS} is out of date: run MACVMM_BLESS_GOLDEN=1 cargo test -p vmm --test fdt_machine, then cargo xtask export-vectors"
    );
}
