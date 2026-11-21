// Checkpoint 10 contract, frozen from the reference test crates/vmm/tests/fdt_writer.rs.
// It names only items the chapter 10 lesson teaches; the harness runs it against your crates.
//! `FdtWriter` rules and the `reader.rs` hostile-input cases (host acceptance;
//! threat model: docs/security/threat-model.md; Devicetree Specification v0.4 ch. 5).
//!
//! The writer is checked against the format rules directly (header fields, alignment, string
//! dedup, ordering, names, size cap), then through the test-only reader (a round trip must
//! preserve the tree). `fdt_reader_hostile` feeds the reader malformed blobs: every one must be
//! an `Err`, never a panic, because the reader is the future fuzz target (chapter 25).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use vmm::fdt::reader::{self, Node, ReadError};
use vmm::fdt::writer::{
    FDT_HEADER_SIZE, FDT_LAST_COMP_VERSION, FDT_MAGIC, FDT_MAX_SIZE, FDT_VERSION,
};
use vmm::fdt::{FdtError, FdtWriter};

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

fn put32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_be_bytes());
}

/// A small tree with two `compatible` properties, a reservation and three levels.
fn sample() -> Vec<u8> {
    let mut w = FdtWriter::new();
    w.add_mem_reserve(0x4000_0000, 0x1000).unwrap();
    let root = w.begin_node("").unwrap();
    w.prop_str("compatible", "linux,dummy-virt").unwrap();
    w.prop_u32("#address-cells", 2).unwrap();
    let a = w.begin_node("uart@9000000").unwrap();
    w.prop_strs("compatible", &["arm,pl011", "arm,primecell"])
        .unwrap();
    w.prop_cells("reg", &[0, 0x0900_0000, 0, 0x1000]).unwrap();
    w.prop_null("dma-coherent").unwrap();
    let b = w.begin_node("child").unwrap();
    w.prop_u64("big", 0x0102_0304_0506_0708).unwrap();
    w.prop_bytes("odd", &[1, 2, 3]).unwrap();
    w.end_node(b).unwrap();
    w.end_node(a).unwrap();
    w.end_node(root).unwrap();
    w.finish(5).unwrap()
}

#[test]
fn header_magic_version_and_alignment() {
    let blob = sample();
    assert_eq!(be32(&blob, 0), FDT_MAGIC);
    assert_eq!(be32(&blob, 4) as usize, blob.len(), "totalsize");
    assert_eq!(be32(&blob, 20), FDT_VERSION);
    assert_eq!(be32(&blob, 20), 17);
    assert_eq!(be32(&blob, 24), FDT_LAST_COMP_VERSION);
    assert_eq!(be32(&blob, 24), 16);
    assert_eq!(be32(&blob, 28), 5, "boot_cpuid_phys");
    let (off_struct, off_strings, off_rsv) = (be32(&blob, 8), be32(&blob, 12), be32(&blob, 16));
    assert_eq!(off_rsv % 8, 0, "reservation map 8-byte aligned");
    assert_eq!(off_struct % 4, 0, "structure block 4-byte aligned");
    assert!(off_rsv as usize >= FDT_HEADER_SIZE);
    assert_eq!(be32(&blob, 36) % 4, 0, "size_dt_struct");
    assert_eq!(
        off_strings + be32(&blob, 32),
        be32(&blob, 4),
        "strings block ends the blob"
    );
    // Reservation map: our entry, then the {0, 0} terminator.
    let rsv = &blob[off_rsv as usize..];
    assert_eq!(
        u64::from_be_bytes(rsv[0..8].try_into().unwrap()),
        0x4000_0000
    );
    assert_eq!(u64::from_be_bytes(rsv[8..16].try_into().unwrap()), 0x1000);
    assert!(rsv[16..32].iter().all(|&b| b == 0));
    // The structure block ends with FDT_END.
    let end = (off_struct + be32(&blob, 36)) as usize;
    assert_eq!(be32(&blob, end - 4), 9);
}

#[test]
fn strings_are_deduplicated() {
    let blob = sample();
    let strings = &blob[be32(&blob, 12) as usize..];
    let names: Vec<&[u8]> = strings
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .collect();
    let compat = names.iter().filter(|n| **n == b"compatible").count();
    assert_eq!(
        compat, 1,
        "two compatible properties → one string-table entry"
    );
    // Every distinct name appears exactly once.
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), names.len());
}

#[test]
fn ordering_and_balance_errors() {
    // A property after a child is an error (DT spec §5.4.2).
    let mut w = FdtWriter::new();
    let root = w.begin_node("").unwrap();
    let c = w.begin_node("c").unwrap();
    w.end_node(c).unwrap();
    assert!(matches!(
        w.prop_u32("late", 1),
        Err(FdtError::PropAfterChild { .. })
    ));
    w.end_node(root).unwrap();

    // An unbalanced end_node: closing the parent while a child is open.
    let mut w = FdtWriter::new();
    let root = w.begin_node("").unwrap();
    let _child = w.begin_node("c").unwrap();
    assert_eq!(w.end_node(root), Err(FdtError::UnbalancedEnd));
    // ... and finishing with a node open.
    assert_eq!(w.finish(0), Err(FdtError::Unfinished));

    // end_node with nothing open (a NodeId from another writer).
    let mut other = FdtWriter::new();
    let foreign = other.begin_node("").unwrap();
    let mut w = FdtWriter::new();
    assert_eq!(w.end_node(foreign), Err(FdtError::UnbalancedEnd));
}

#[test]
fn names_with_nul_or_slash_are_refused() {
    let mut w = FdtWriter::new();
    let _root = w.begin_node("").unwrap();
    for bad in ["a\0b", "a/b", "/", "cpu@0/x", "", "sp ace", "\u{e9}"] {
        assert!(
            matches!(w.begin_node(bad), Err(FdtError::InvalidNodeName { .. })),
            "{bad:?}"
        );
    }
    for bad in ["a\0", "x/y", "", "has space"] {
        assert!(
            matches!(w.prop_null(bad), Err(FdtError::InvalidPropName { .. })),
            "{bad:?}"
        );
    }
    assert!(matches!(
        w.prop_str("bootargs", "a\0b"),
        Err(FdtError::StringHasNul { .. })
    ));
    assert!(matches!(
        w.prop_strs("compatible", &["ok", "b\0ad"]),
        Err(FdtError::StringHasNul { .. })
    ));
}

#[test]
fn blob_over_two_mib_is_an_error() {
    let mut w = FdtWriter::new();
    let _root = w.begin_node("").unwrap();
    let big = vec![0u8; FDT_MAX_SIZE];
    assert!(matches!(
        w.prop_bytes("big", &big),
        Err(FdtError::TooLarge { .. })
    ));
    // Growing by many small properties hits the same cap.
    let mut w = FdtWriter::new();
    let root = w.begin_node("").unwrap();
    let chunk = vec![0u8; 64 << 10];
    let mut n = 0;
    let err = loop {
        match w.prop_bytes("p", &chunk) {
            Ok(()) => n += 1,
            Err(e) => break e,
        }
        assert!(n < 64, "the cap never triggered");
    };
    assert!(matches!(err, FdtError::TooLarge { max, .. } if max == FDT_MAX_SIZE));
    // Just under the cap still works.
    w.end_node(root).unwrap();
    let blob = w.finish(0).unwrap();
    assert!(blob.len() <= FDT_MAX_SIZE);
    assert!(blob.len() > FDT_MAX_SIZE - (64 << 10) - 4096);
}

/// FDT-2's cap is exact: a blob of exactly `FDT_MAX_SIZE` bytes is accepted, one 4-byte cell
/// more is refused (by `prop_bytes`, before it touches the buffers).
#[test]
fn blob_of_exactly_two_mib_is_accepted() {
    // header (40) + reservation terminator (16) + BEGIN_NODE "" (8) + PROP header (12)
    // + value + END_NODE (4) + END (4) + strings "abc\0" (4) = 88 + value.
    let fixed = FDT_HEADER_SIZE + 16 + 8 + 12 + 4 + 4 + 4;
    let build = |value_len: usize| -> Result<Vec<u8>, FdtError> {
        let mut w = FdtWriter::new();
        let root = w.begin_node("")?;
        w.prop_bytes("abc", &vec![0u8; value_len])?;
        w.end_node(root)?;
        w.finish(0)
    };
    let exact = FDT_MAX_SIZE - fixed;
    assert_eq!(exact % 4, 0);
    let blob = build(exact).unwrap();
    assert_eq!(blob.len(), FDT_MAX_SIZE);
    let f = reader::parse(&blob).unwrap();
    assert_eq!(f.root.prop("abc").unwrap().value.len(), exact);
    // One byte more pads to one cell more: refused.
    assert_eq!(
        build(exact + 1),
        Err(FdtError::TooLarge {
            size: FDT_MAX_SIZE + 4,
            max: FDT_MAX_SIZE
        })
    );
}

#[test]
fn empty_root_name_works() {
    let mut w = FdtWriter::new();
    let root = w.begin_node("").unwrap();
    w.end_node(root).unwrap();
    let blob = w.finish(0).unwrap();
    let f = reader::parse(&blob).unwrap();
    assert_eq!(f.root, Node::default());
    // header + terminator-only reservation map + BEGIN_NODE "" (8) + END_NODE + END.
    assert_eq!(blob.len(), FDT_HEADER_SIZE + 16 + 8 + 4 + 4);
}

#[test]
fn round_trip_preserves_the_tree() {
    let f = reader::parse(&sample()).unwrap();
    assert_eq!(f.header.boot_cpuid_phys, 5);
    assert_eq!(f.reservations, vec![(0x4000_0000, 0x1000)]);
    assert_eq!(
        f.root.prop("compatible").unwrap().str(),
        Some("linux,dummy-virt")
    );
    assert_eq!(f.root.prop("#address-cells").unwrap().u32(), Some(2));
    let uart = f.find("/uart@9000000").unwrap();
    assert_eq!(
        uart.prop("compatible").unwrap().strs(),
        Some(vec!["arm,pl011", "arm,primecell"])
    );
    assert_eq!(
        uart.prop("reg").unwrap().cells(),
        Some(vec![0, 0x0900_0000, 0, 0x1000])
    );
    assert!(uart.prop("dma-coherent").unwrap().value.is_empty());
    let child = f.find("/uart@9000000/child").unwrap();
    assert_eq!(
        child.prop("big").unwrap().u64(),
        Some(0x0102_0304_0506_0708)
    );
    assert_eq!(child.prop("odd").unwrap().value, vec![1, 2, 3]);
    // Property order and child order are preserved.
    let names: Vec<&str> = uart.props.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["compatible", "reg", "dma-coherent"]);
    let paths: Vec<String> = f.root.walk().into_iter().map(|(p, _)| p).collect();
    assert_eq!(paths, ["/", "/uart@9000000", "/uart@9000000/child"]);
}

/// FDT-1's counterpart: the reader is a future fuzz target, so malformed blobs are `Err`,
/// never a panic.
#[test]
fn fdt_reader_hostile() {
    let good = sample();
    let off_struct = be32(&good, 8) as usize;
    let off_strings = be32(&good, 12) as usize;

    // Truncated header (every length below 40).
    for len in 0..FDT_HEADER_SIZE {
        assert_eq!(
            reader::parse(&good[..len]),
            Err(ReadError::TruncatedHeader),
            "{len}"
        );
    }
    // Every truncation of the blob is an error.
    for len in FDT_HEADER_SIZE..good.len() {
        assert!(reader::parse(&good[..len]).is_err(), "truncated to {len}");
    }
    // Bad magic.
    let mut b = good.clone();
    put32(&mut b, 0, 0xdead_beef);
    assert_eq!(reader::parse(&b), Err(ReadError::BadMagic(0xdead_beef)));
    // totalsize past the buffer, below the header, over 2 MiB.
    for t in [
        good.len() as u32 + 1,
        39,
        u32::MAX,
        (FDT_MAX_SIZE + 1) as u32,
    ] {
        let mut b = good.clone();
        put32(&mut b, 4, t);
        assert!(
            matches!(reader::parse(&b), Err(ReadError::BadTotalSize(_))),
            "{t}"
        );
    }
    // Versions.
    let mut b = good.clone();
    put32(&mut b, 20, 15);
    assert!(matches!(
        reader::parse(&b),
        Err(ReadError::BadVersion { .. })
    ));
    // Block offsets and sizes outside the blob, misaligned, overflowing.
    for (field, v) in [
        (8, u32::MAX),
        (8, 2),
        (12, u32::MAX),
        (16, 3),
        (16, u32::MAX - 7),
        (32, u32::MAX),
        (36, u32::MAX - 3),
        (36, 6),
        (8, 0),
    ] {
        let mut b = good.clone();
        put32(&mut b, field, v);
        assert!(reader::parse(&b).is_err(), "field {field} = {v:#x}");
    }
    // A string offset past the strings block.
    let first_prop = find_token(&good, off_struct, 3);
    let mut b = good.clone();
    put32(&mut b, first_prop + 8, be32(&good, 32) + 100);
    assert!(matches!(
        reader::parse(&b),
        Err(ReadError::BadNameOffset(_))
    ));
    // ... or pointing at the last byte with no NUL after it inside the block.
    let mut b = good.clone();
    let size_strings = be32(&good, 32);
    b[off_strings + size_strings as usize - 1] = b'x';
    assert!(reader::parse(&b).is_err());
    // A property length past the structure block.
    let mut b = good.clone();
    put32(&mut b, first_prop + 4, u32::MAX);
    assert!(matches!(reader::parse(&b), Err(ReadError::Truncated(_))));
    // An unterminated node name: fill the structure block from the first name on with 'a'.
    let mut b = good.clone();
    let struct_end = off_struct + be32(&good, 36) as usize;
    for x in &mut b[off_struct + 4..struct_end] {
        *x = b'a';
    }
    assert_eq!(reader::parse(&b), Err(ReadError::UnterminatedName));
    // An unknown token.
    let mut b = good.clone();
    put32(&mut b, off_struct, 0x77);
    assert_eq!(reader::parse(&b), Err(ReadError::BadToken(0x77)));
    // FDT_END_NODE first, FDT_END first, a second root.
    let mut b = good.clone();
    put32(&mut b, off_struct, 2);
    assert!(matches!(reader::parse(&b), Err(ReadError::BadStructure(_))));
    let mut b = good.clone();
    put32(&mut b, off_struct, 9);
    assert!(matches!(reader::parse(&b), Err(ReadError::BadStructure(_))));
    // A reservation map with no terminator inside the blob: point it at the last 8 bytes.
    let mut b = good.clone();
    let near_end = ((good.len() - 8) & !7) as u32;
    put32(&mut b, 16, near_end);
    let last = b.len();
    b[near_end as usize..last].fill(0xff);
    assert!(reader::parse(&b).is_err());
    // ... and one whose entries never end before totalsize (every byte non-zero).
    let mut b = good.clone();
    let rsv = be32(&good, 16) as usize;
    b[rsv..rsv + 16].fill(0x11);
    let _ = reader::parse(&b); // the structure block follows: must just not panic
    // Deep nesting: 100 BEGIN_NODEs.
    let mut w = FdtWriter::new();
    let r = w.begin_node("").unwrap();
    w.end_node(r).unwrap();
    let small = w.finish(0).unwrap();
    let mut deep = small[..FDT_HEADER_SIZE + 16].to_vec();
    deep.extend_from_slice(&1u32.to_be_bytes());
    deep.extend_from_slice(&[0; 4]); // the root, named ""
    for _ in 0..100 {
        deep.extend_from_slice(&1u32.to_be_bytes());
        deep.extend_from_slice(b"n\0\0\0");
    }
    deep.extend_from_slice(&9u32.to_be_bytes());
    let len = deep.len() as u32;
    put32(&mut deep, 4, len);
    put32(&mut deep, 12, len);
    put32(&mut deep, 32, 0);
    put32(&mut deep, 36, len - (FDT_HEADER_SIZE as u32 + 16));
    assert_eq!(reader::parse(&deep), Err(ReadError::TooComplex));
    // Random corruption: flip bytes all over the good blob, never panic.
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    for _ in 0..20_000 {
        let mut b = good.clone();
        for _ in 0..1 + (x % 4) {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let i = (x as usize) % b.len();
            b[i] = (x >> 32) as u8;
        }
        let _ = reader::parse(&b);
    }
}

/// The offset of the first structure-block token equal to `tok` (walking token by token).
fn find_token(blob: &[u8], off_struct: usize, tok: u32) -> usize {
    let mut pos = off_struct;
    loop {
        let t = be32(blob, pos);
        if t == tok {
            return pos;
        }
        pos += 4;
        match t {
            1 => {
                let nul = blob[pos..].iter().position(|&b| b == 0).unwrap();
                pos = (pos + nul + 1).next_multiple_of(4);
            }
            3 => {
                let len = be32(blob, pos) as usize;
                pos = (pos + 8 + len).next_multiple_of(4);
            }
            _ => {}
        }
    }
}
