// Checkpoint 16 contract, frozen from the reference test crates/vmm/tests/virtqueue_hostile.rs.
// It names only items chapters 04, 15 and 16 teach; the harness runs it against your crates.
//! Host acceptance: the split virtqueue against a hostile driver (virtio 1.2 §2.7;
//! threat model: docs/security/threat-model.md). Each case builds a ring in a
//! `VecMemory` the way a (malicious) driver would, then asserts the exact `QueueError`, or the
//! exact accepted chain for the positive cases. Never a panic.
//!
//! The table cases double as the course corpus: `virtqueue_corpus_is_current` regenerates
//! `tests/data/virtqueue_vectors.json` from them and the real queue code, and
//! `cargo xtask export-vectors` publishes it as `course/site/labs/vectors/virtqueue.json` for the
//! ch16 virtqueue visualiser (one corpus, two readers: the lab cannot show a verdict the VMM
//! does not give).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use virtio_support::*;
use vmm::memory::prelude::*;
use vmm::virtio::{Descriptor, QueueError, Ring as R};

const TABLE: u64 = RAM + 0x2_0000;
const K64: u64 = 64 * 1024;

type Outcome = Result<Option<(usize, usize, u64, u64)>, QueueError>;

#[derive(Clone)]
struct Case {
    name: &'static str,
    about: &'static str,
    size: u16,
    indirect: bool,
    rings: (u64, u64, u64),
    descs: Vec<(u16, Descriptor)>,
    tables: Vec<(u64, Vec<Descriptor>)>,
    heads: Vec<u16>,
    avail_idx: Option<u16>,
    positions: Option<(u16, u16)>,
    max_total: u64,
    expect: Outcome,
}

fn base(name: &'static str, about: &'static str) -> Case {
    Case {
        name,
        about,
        size: 8,
        indirect: false,
        rings: (DESC, AVAIL, USED),
        descs: Vec::new(),
        tables: Vec::new(),
        heads: vec![0],
        avail_idx: None,
        positions: None,
        max_total: K64,
        expect: Ok(None),
    }
}

fn ok(r: usize, w: usize, rl: u64, wl: u64) -> Outcome {
    Ok(Some((r, w, rl, wl)))
}

fn err(e: QueueError) -> Outcome {
    Err(e)
}

fn cases() -> Vec<Case> {
    use QueueError::*;
    let b = |n, a| base(n, a);
    let one = |c: Case, desc: Descriptor| Case {
        descs: vec![(0, desc)],
        ..c
    };
    let ind = |c: Case| Case {
        indirect: true,
        ..c
    };
    vec![
        // ---- positive cases --------------------------------------------------------------
        Case {
            descs: vec![(0, d(BUF, 16, NEXT, 1)), (1, d(BUF + 0x100, 512, WRITE, 0))],
            expect: ok(1, 1, 16, 512),
            ..b(
                "readable_then_writable",
                "a request header the device reads, then a buffer it writes",
            )
        },
        Case {
            heads: vec![],
            expect: Ok(None),
            ..b(
                "empty_ring",
                "avail.idx equals our next_avail: nothing to do",
            )
        },
        Case {
            size: 4,
            descs: vec![
                (0, d(BUF, 1, NEXT, 1)),
                (1, d(BUF, 1, NEXT, 2)),
                (2, d(BUF, 1, NEXT, 3)),
                (3, d(BUF, 1, 0, 0)),
            ],
            expect: ok(4, 0, 4, 0),
            ..b(
                "chain_of_exactly_n",
                "a chain using all N descriptors is the longest legal one",
            )
        },
        Case {
            descs: vec![(0, d(BUF, K64 as u32, WRITE, 0))],
            expect: ok(0, 1, 0, K64),
            ..b(
                "total_exactly_at_cap",
                "writable_len equal to max_total is accepted",
            )
        },
        ind(Case {
            descs: vec![(0, d(TABLE, 48, INDIRECT, 0))],
            tables: vec![(
                TABLE,
                vec![
                    d(BUF, 16, NEXT, 1),
                    d(BUF + 16, 16, NEXT, 2),
                    d(BUF + 32, 64, WRITE, 0),
                ],
            )],
            expect: ok(2, 1, 32, 64),
            ..b(
                "indirect_table",
                "one descriptor pointing at a table of three",
            )
        }),
        ind(Case {
            descs: vec![
                (0, d(BUF, 16, NEXT, 1)),
                (1, d(TABLE, 16, INDIRECT | WRITE, 0)),
            ],
            tables: vec![(TABLE, vec![d(BUF + 64, 32, WRITE, 0)])],
            expect: ok(1, 1, 16, 32),
            ..b(
                "direct_then_indirect",
                "direct descriptors may precede the indirect one; its F_WRITE is ignored",
            )
        }),
        Case {
            size: 4,
            positions: Some((65534, 65534)),
            descs: vec![(2, d(BUF, 8, WRITE, 0))],
            heads: vec![2],
            expect: ok(0, 1, 0, 8),
            ..b(
                "avail_idx_near_wrap",
                "ring positions near 65535 (the indices are 16-bit and wrap)",
            )
        },
        Case {
            heads: vec![0, 0, 0, 0, 0, 0, 0, 0],
            descs: vec![(0, d(BUF, 8, 0, 0))],
            expect: ok(1, 0, 8, 0),
            ..b("avail_full_ring", "exactly N pending entries is legal")
        },
        // ---- loops and lengths (VQ-5) ----------------------------------------------------
        one(
            Case {
                expect: err(ChainTooLong { budget: 8 }),
                ..b("self_loop", "a descriptor whose next is itself")
            },
            d(BUF, 8, NEXT, 0),
        ),
        Case {
            descs: vec![(0, d(BUF, 8, NEXT, 1)), (1, d(BUF, 8, NEXT, 0))],
            expect: err(ChainTooLong { budget: 8 }),
            ..b("two_cycle", "0 -> 1 -> 0")
        },
        Case {
            descs: (0..5).map(|i| (i, d(BUF, 8, NEXT, (i + 1) % 5))).collect(),
            expect: err(ChainTooLong { budget: 8 }),
            ..b("five_cycle", "0 -> 1 -> 2 -> 3 -> 4 -> 0")
        },
        Case {
            size: 4,
            descs: vec![
                (0, d(BUF, 1, NEXT, 1)),
                (1, d(BUF, 1, NEXT, 2)),
                (2, d(BUF, 1, NEXT, 3)),
                (3, d(BUF, 1, NEXT, 1)),
            ],
            expect: err(ChainTooLong { budget: 4 }),
            ..b("chain_longer_than_n", "N descriptors and then one more hop")
        },
        one(
            Case {
                expect: err(NextOutOfRange {
                    next: 8,
                    table_len: 8,
                }),
                ..b("next_ge_n", "next = N")
            },
            d(BUF, 8, NEXT, 8),
        ),
        one(
            Case {
                expect: err(NextOutOfRange {
                    next: 0xffff,
                    table_len: 8,
                }),
                ..b("next_u16_max", "next = 65535")
            },
            d(BUF, 8, NEXT, 0xffff),
        ),
        Case {
            heads: vec![8],
            expect: err(HeadOutOfRange { head: 8, size: 8 }),
            ..b("head_ge_n", "the avail ring names descriptor N")
        },
        Case {
            heads: vec![0xffff],
            expect: err(HeadOutOfRange {
                head: 0xffff,
                size: 8,
            }),
            ..b("head_u16_max", "the avail ring names descriptor 65535")
        },
        // ---- buffer addresses and lengths (VQ-4) ------------------------------------------
        one(
            Case {
                expect: err(Overflow {
                    addr: u64::MAX - 10,
                    len: u32::MAX,
                }),
                ..b("len_u32_max_overflow", "addr + len wraps past 2^64")
            },
            d(u64::MAX - 10, u32::MAX, 0, 0),
        ),
        one(
            Case {
                expect: err(Overflow {
                    addr: u64::MAX,
                    len: 1,
                }),
                ..b("addr_u64_max", "a one-byte buffer at the last address")
            },
            d(u64::MAX, 1, 0, 0),
        ),
        one(
            Case {
                expect: err(BufferOutOfRam {
                    addr: MMIO_ADDR,
                    len: 4,
                }),
                ..b(
                    "addr_in_mmio",
                    "a buffer inside the PL011: DMA must never reach a device (MEM-3)",
                )
            },
            d(MMIO_ADDR, 4, WRITE, 0),
        ),
        one(
            Case {
                expect: err(BufferOutOfRam {
                    addr: RAM_END - 8,
                    len: 16,
                }),
                ..b(
                    "buffer_straddles_ram_end",
                    "the last 8 bytes of RAM and 8 beyond",
                )
            },
            d(RAM_END - 8, 16, WRITE, 0),
        ),
        one(
            Case {
                expect: err(BufferOutOfRam {
                    addr: RAM - 4,
                    len: 8,
                }),
                ..b("buffer_below_ram", "a buffer that starts below RAM")
            },
            d(RAM - 4, 8, 0, 0),
        ),
        one(
            Case {
                expect: err(BufferOutOfRam { addr: 0, len: 4096 }),
                ..b("buffer_at_zero", "IPA 0 is flash or a hole, never RAM")
            },
            d(0, 4096, 0, 0),
        ),
        one(
            Case {
                expect: err(ZeroLength { index: 0 }),
                ..b("zero_length", "a zero-length descriptor")
            },
            d(BUF, 0, 0, 0),
        ),
        Case {
            descs: vec![(0, d(BUF, 8, NEXT, 3)), (3, d(BUF, 0, WRITE, 0))],
            expect: err(ZeroLength { index: 3 }),
            ..b(
                "zero_length_mid_chain",
                "a zero-length descriptor second in the chain",
            )
        },
        // ---- direction and totals (VQ-7, VQ-8) --------------------------------------------
        Case {
            descs: vec![(0, d(BUF, 8, WRITE | NEXT, 1)), (1, d(BUF, 8, 0, 0))],
            expect: err(ReadableAfterWritable),
            ..b(
                "writable_before_readable",
                "a device-readable descriptor after a writable one (§2.7.4.2)",
            )
        },
        Case {
            max_total: 1024,
            descs: vec![(0, d(BUF, 1000, NEXT, 1)), (1, d(BUF, 100, 0, 0))],
            expect: err(TooLarge {
                total: 1100,
                max: 1024,
            }),
            ..b(
                "readable_len_over_cap",
                "readable_len above the device's max_total",
            )
        },
        Case {
            max_total: 1024,
            descs: vec![
                (0, d(BUF, 600, WRITE | NEXT, 1)),
                (1, d(BUF, 600, WRITE, 0)),
            ],
            expect: err(TooLarge {
                total: 1200,
                max: 1024,
            }),
            ..b(
                "writable_len_over_cap",
                "writable_len above the device's max_total",
            )
        },
        one(
            Case {
                expect: err(TooLarge {
                    total: 0x8_0000,
                    max: K64,
                }),
                ..b(
                    "one_descriptor_over_cap",
                    "a single 512 KiB writable descriptor, in RAM but above the 64 KiB cap",
                )
            },
            d(RAM, 0x8_0000, WRITE, 0),
        ),
        // ---- avail ring (VQ-2) -----------------------------------------------------------
        Case {
            heads: vec![],
            avail_idx: Some(9),
            expect: err(AvailIdxJump {
                avail_idx: 9,
                next_avail: 0,
                size: 8,
            }),
            ..b("avail_idx_jump_n_plus_1", "avail.idx moved by N + 1")
        },
        Case {
            heads: vec![],
            avail_idx: Some(0x8000),
            expect: err(AvailIdxJump {
                avail_idx: 0x8000,
                next_avail: 0,
                size: 8,
            }),
            ..b("avail_idx_jump_half", "avail.idx moved by 32768")
        },
        Case {
            heads: vec![],
            positions: Some((5, 5)),
            avail_idx: Some(4),
            expect: err(AvailIdxJump {
                avail_idx: 4,
                next_avail: 5,
                size: 8,
            }),
            ..b(
                "avail_idx_backwards",
                "avail.idx moved backwards (65535 pending)",
            )
        },
        // ---- indirect (VQ-6) -------------------------------------------------------------
        one(
            Case {
                expect: err(IndirectNotNegotiated),
                ..b(
                    "indirect_not_negotiated",
                    "F_INDIRECT without VIRTIO_F_INDIRECT_DESC",
                )
            },
            d(TABLE, 16, INDIRECT, 0),
        ),
        ind(one(
            Case {
                expect: err(NestedIndirect),
                ..b(
                    "indirect_points_at_itself",
                    "the table is the descriptor table, whose entry 0 is the indirect descriptor",
                )
            },
            d(DESC, 16, INDIRECT, 0),
        )),
        ind(Case {
            descs: vec![(0, d(TABLE, 16, INDIRECT, 0))],
            tables: vec![(TABLE, vec![d(TABLE + 0x100, 16, INDIRECT, 0)])],
            expect: err(NestedIndirect),
            ..b(
                "nested_indirect",
                "an indirect descriptor inside an indirect table",
            )
        }),
        ind(Case {
            descs: vec![(0, d(TABLE, 16, INDIRECT | NEXT, 1)), (1, d(BUF, 8, 0, 0))],
            tables: vec![(TABLE, vec![d(BUF, 8, 0, 0)])],
            expect: err(IndirectWithNext),
            ..b("indirect_with_next", "F_INDIRECT together with F_NEXT")
        }),
        ind(one(
            Case {
                expect: err(BadIndirectLen { len: 24 }),
                ..b(
                    "indirect_len_not_multiple_of_16",
                    "a table of 1.5 descriptors",
                )
            },
            d(TABLE, 24, INDIRECT, 0),
        )),
        ind(one(
            Case {
                expect: err(BadIndirectLen { len: 9 * 16 }),
                ..b("indirect_len_over_n", "a table of N + 1 descriptors")
            },
            d(TABLE, 9 * 16, INDIRECT, 0),
        )),
        ind(one(
            Case {
                expect: err(BadIndirectLen { len: 0 }),
                ..b("indirect_len_zero", "an empty indirect table")
            },
            d(TABLE, 0, INDIRECT, 0),
        )),
        ind(one(
            Case {
                expect: err(BufferOutOfRam {
                    addr: RAM_END - 16,
                    len: 32,
                }),
                ..b(
                    "indirect_table_outside_ram",
                    "a table straddling the end of RAM",
                )
            },
            d(RAM_END - 16, 32, INDIRECT, 0),
        )),
        ind(one(
            Case {
                expect: err(BufferOutOfRam {
                    addr: MMIO_ADDR,
                    len: 32,
                }),
                ..b("indirect_table_in_mmio", "a table inside the PL011")
            },
            d(MMIO_ADDR, 32, INDIRECT, 0),
        )),
        ind(Case {
            descs: vec![(0, d(TABLE, 32, INDIRECT, 0))],
            tables: vec![(TABLE, vec![d(BUF, 8, NEXT, 1), d(BUF, 8, NEXT, 0)])],
            expect: err(ChainTooLong { budget: 2 }),
            ..b(
                "indirect_loop",
                "a 2-cycle inside a 2-entry indirect table: the budget restarts at len/16",
            )
        }),
        ind(Case {
            descs: vec![(0, d(TABLE, 32, INDIRECT, 0))],
            tables: vec![(TABLE, vec![d(BUF, 8, NEXT, 2), d(BUF, 8, 0, 0)])],
            expect: err(NextOutOfRange {
                next: 2,
                table_len: 2,
            }),
            ..b(
                "indirect_next_out_of_table",
                "next beyond the indirect table, though < N",
            )
        }),
        ind(Case {
            descs: vec![(0, d(TABLE, 32, INDIRECT, 0))],
            tables: vec![(TABLE, vec![d(BUF, 8, WRITE | NEXT, 1), d(BUF, 8, 0, 0)])],
            expect: err(ReadableAfterWritable),
            ..b(
                "indirect_readable_after_writable",
                "the direction rule holds inside indirect tables",
            )
        }),
        // ---- ring placement (VQ-1) -------------------------------------------------------
        Case {
            rings: (DESC + 8, AVAIL, USED),
            heads: vec![],
            expect: err(Unaligned {
                ring: R::Desc,
                addr: DESC + 8,
            }),
            ..b(
                "unaligned_desc_table",
                "the descriptor table must be 16-byte aligned",
            )
        },
        Case {
            rings: (DESC, AVAIL + 1, USED),
            heads: vec![],
            expect: err(Unaligned {
                ring: R::Avail,
                addr: AVAIL + 1,
            }),
            ..b(
                "unaligned_avail_ring",
                "the avail ring must be 2-byte aligned",
            )
        },
        Case {
            rings: (DESC, AVAIL, USED + 2),
            heads: vec![],
            expect: err(Unaligned {
                ring: R::Used,
                addr: USED + 2,
            }),
            ..b(
                "unaligned_used_ring",
                "the used ring must be 4-byte aligned",
            )
        },
        Case {
            rings: (RAM_END - 64, AVAIL, USED),
            heads: vec![],
            expect: err(RingOutOfRam {
                ring: R::Desc,
                addr: RAM_END - 64,
                len: 128,
            }),
            ..b(
                "desc_table_straddles_ram_end",
                "16·N bytes do not fit before the end of RAM",
            )
        },
        Case {
            rings: (DESC, RAM_END - 16, USED),
            heads: vec![],
            expect: err(RingOutOfRam {
                ring: R::Avail,
                addr: RAM_END - 16,
                len: 22,
            }),
            ..b("avail_ring_straddles_ram_end", "6 + 2·N bytes do not fit")
        },
        Case {
            rings: (DESC, AVAIL, RAM_END - 64),
            heads: vec![],
            expect: err(RingOutOfRam {
                ring: R::Used,
                addr: RAM_END - 64,
                len: 70,
            }),
            ..b("used_ring_straddles_ram_end", "6 + 8·N bytes do not fit")
        },
        Case {
            rings: (DESC, MMIO_ADDR, USED),
            heads: vec![],
            expect: err(RingOutOfRam {
                ring: R::Avail,
                addr: MMIO_ADDR,
                len: 22,
            }),
            ..b("avail_ring_in_mmio", "a ring inside a device window")
        },
        Case {
            rings: (u64::MAX - 15, AVAIL, USED),
            heads: vec![],
            expect: err(RingOutOfRam {
                ring: R::Desc,
                addr: u64::MAX - 15,
                len: 128,
            }),
            ..b(
                "desc_table_at_top_of_address_space",
                "the end overflows 2^64",
            )
        },
    ]
}

/// Run one case: build the ring, validate, pop and validate one chain.
fn run(c: &Case) -> Outcome {
    let mem = mem();
    let (desc, avail, used) = c.rings;
    let mut ring = Ring::at(mem.clone(), c.size, desc, avail, used);
    for (i, dsc) in &c.descs {
        ring.set_desc(*i, *dsc);
    }
    for (addr, table) in &c.tables {
        for (i, dsc) in table.iter().enumerate() {
            ring.set_desc_at(*addr, i as u16, *dsc);
        }
    }
    if let Some((a, _)) = c.positions {
        ring.set_avail_idx(a);
    }
    for h in &c.heads {
        ring.push(*h);
    }
    if let Some(idx) = c.avail_idx {
        ring.set_avail_idx(idx);
    }
    let mut q = ring.queue();
    q.set_indirect(c.indirect);
    if let Some((a, u)) = c.positions {
        q.set_positions(a, u);
    }
    q.validate(&*mem)?;
    let v = pop_validated(&mut q, &mem, c.max_total)?;
    Ok(v.map(|v| {
        (
            v.readable.len(),
            v.writable.len(),
            v.readable_len,
            v.writable_len,
        )
    }))
}

fn run_named(name: &str) {
    let all = cases();
    let c = all.iter().find(|c| c.name == name).expect("no such case");
    assert_eq!(run(c), c.expect, "case {name}: {}", c.about);
}

macro_rules! table_tests {
    ($($name:ident),* $(,)?) => {
        $( #[test] fn $name() { run_named(stringify!($name)); } )*
        /// Every table case has exactly one `#[test]` and vice versa.
        #[test]
        fn every_case_has_a_test() {
            let tests = [$(stringify!($name)),*];
            let names: Vec<_> = cases().iter().map(|c| c.name).collect();
            assert_eq!(tests.len(), names.len());
            for n in &names {
                assert!(tests.contains(n), "{n} has no test");
            }
        }
    };
}

table_tests!(
    readable_then_writable,
    empty_ring,
    chain_of_exactly_n,
    total_exactly_at_cap,
    indirect_table,
    direct_then_indirect,
    avail_idx_near_wrap,
    avail_full_ring,
    self_loop,
    two_cycle,
    five_cycle,
    chain_longer_than_n,
    next_ge_n,
    next_u16_max,
    head_ge_n,
    head_u16_max,
    len_u32_max_overflow,
    addr_u64_max,
    addr_in_mmio,
    buffer_straddles_ram_end,
    buffer_below_ram,
    buffer_at_zero,
    zero_length,
    zero_length_mid_chain,
    writable_before_readable,
    readable_len_over_cap,
    writable_len_over_cap,
    one_descriptor_over_cap,
    avail_idx_jump_n_plus_1,
    avail_idx_jump_half,
    avail_idx_backwards,
    indirect_not_negotiated,
    indirect_points_at_itself,
    nested_indirect,
    indirect_with_next,
    indirect_len_not_multiple_of_16,
    indirect_len_over_n,
    indirect_len_zero,
    indirect_table_outside_ram,
    indirect_table_in_mmio,
    indirect_loop,
    indirect_next_out_of_table,
    indirect_readable_after_writable,
    unaligned_desc_table,
    unaligned_avail_ring,
    unaligned_used_ring,
    desc_table_straddles_ram_end,
    avail_ring_straddles_ram_end,
    used_ring_straddles_ram_end,
    avail_ring_in_mmio,
    desc_table_at_top_of_address_space,
);

// ---- cases that need more than one pop, or look at the used ring ------------------------

#[test]
fn size_not_a_power_of_two_or_zero_is_refused() {
    let mem = mem();
    let ring = Ring::new(mem.clone(), 8);
    for size in [0u16, 3, 6, 12] {
        let mut q = ring.queue();
        q.set_size(size);
        assert_eq!(q.validate(&*mem), Err(QueueError::BadSize { size, max: 8 }));
        assert!(q.pop(&*mem).is_err());
    }
}

#[test]
fn not_ready_queue_refuses_work() {
    let mem = mem();
    let ring = Ring::new(mem.clone(), 8);
    let mut q = ring.queue();
    q.set_ready(false);
    assert_eq!(q.pop(&*mem).err(), Some(QueueError::NotReady));
    assert_eq!(q.add_used(&*mem, 0, 0), Err(QueueError::NotReady));
}

#[test]
fn a_broken_queue_stays_broken_until_reset() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 8, 0, 0));
    ring.push(9); // head ≥ N
    ring.push(0); // a good chain behind it
    let mut q = ring.queue();
    assert!(q.pop(&*mem).is_err());
    assert!(q.is_broken());
    assert_eq!(q.pop(&*mem).err(), Some(QueueError::Broken));
    assert_eq!(q.add_used(&*mem, 0, 0), Err(QueueError::Broken));
}

#[test]
fn avail_and_used_idx_wrap_at_65535() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 4);
    for i in 0..4 {
        ring.set_desc(i, d(BUF + 64 * u64::from(i), 16, WRITE, 0));
    }
    ring.set_avail_idx(65533);
    let mut q = ring.queue();
    q.set_positions(65533, 65533);
    for i in 0..4u16 {
        ring.push(i);
    }
    assert_eq!(ring.avail_idx, 1, "avail.idx wrapped");
    let mut heads = Vec::new();
    while let Some(v) = pop_validated(&mut q, &mem, K64).unwrap() {
        heads.push(v.head);
        q.add_used(&*mem, v.head, 16).unwrap();
    }
    assert_eq!(heads, vec![0, 1, 2, 3]);
    assert_eq!(q.next_avail(), 1);
    assert_eq!(ring.used_idx(), 1, "used.idx wrapped: 65533 + 4");
    // The used elements sit at slots 65533..65537 mod 4 = 1, 2, 3, 0.
    assert_eq!(ring.used_elem(1).0, 0);
    assert_eq!(ring.used_elem(0).0, 3);
}

#[test]
fn add_used_writes_the_exact_len() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(3, d(BUF, 100, WRITE | NEXT, 4));
    ring.set_desc(4, d(BUF + 0x200, 100, WRITE, 0));
    ring.push(3);
    let mut q = ring.queue();
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    assert_eq!(v.writable_len, 200);
    // The device produced 150 bytes, not the 200 available (VQ-9).
    let written = v.write_writable(&*mem, &[0x5a; 150]).unwrap();
    assert_eq!(written, 150);
    q.add_used(&*mem, v.head, written).unwrap();
    assert_eq!(ring.used_elem(0), (3, 150));
    assert_eq!(ring.used_idx(), 1);
    assert_eq!(mem.read_u8(GuestAddress(BUF + 0x200 + 49)).unwrap(), 0x5a);
    assert_eq!(
        mem.read_u8(GuestAddress(BUF + 0x200 + 50)).unwrap(),
        0,
        "untouched"
    );
    assert!(q.add_used(&*mem, 8, 0).is_err(), "head ≥ N");
}

#[test]
fn used_idx_release_order() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 8, WRITE, 0));
    ring.push(0);
    let mut q = ring.queue();
    mem.enable_log();
    let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
    q.add_used(&*mem, v.head, 8).unwrap();
    assert!(q.should_interrupt(&*mem).unwrap());
    let log = mem.log();
    // pop: an acquire load of avail.idx comes first, before the ring entry and descriptor.
    assert!(
        log[0].ordered && !log[0].write && log[0].addr == AVAIL + 2,
        "{log:?}"
    );
    let elem = log
        .iter()
        .position(|a| a.write && !a.ordered && a.addr == USED + 4 && a.len == 8)
        .expect("used element written as one 8-byte copy");
    let idx = log
        .iter()
        .position(|a| a.write && a.ordered && a.addr == USED + 2 && a.len == 2)
        .expect("release store of used.idx");
    let fence = log.iter().position(|a| a.fence).expect("SeqCst fence");
    let flags = log
        .iter()
        .position(|a| !a.write && !a.fence && a.addr == AVAIL && a.len == 2)
        .expect("avail.flags read");
    assert!(elem < idx && idx < fence && fence < flags, "{log:?}");
}

#[test]
fn no_interrupt_is_respected() {
    let mem = mem();
    let ring = Ring::new(mem.clone(), 8);
    let q = ring.queue();
    ring.set_avail_flags(1);
    assert!(!q.should_interrupt(&*mem).unwrap());
    ring.set_avail_flags(0);
    assert!(q.should_interrupt(&*mem).unwrap());
    ring.set_avail_flags(0xfffe); // other bits mean nothing
    assert!(q.should_interrupt(&*mem).unwrap());
}

#[test]
fn many_chains_in_one_ring() {
    let mem = mem();
    let mut ring = Ring::new(mem.clone(), 256);
    let mut q = ring.queue();
    for round in 0..3u16 {
        for i in 0..256u16 {
            ring.set_desc(i, d(BUF + u64::from(i) * 16, 16, WRITE, 0));
            ring.push(i);
        }
        for i in 0..256u16 {
            let v = pop_validated(&mut q, &mem, K64).unwrap().unwrap();
            assert_eq!(v.head, i, "round {round}");
            q.add_used(&*mem, v.head, 16).unwrap();
        }
        assert!(pop_validated(&mut q, &mem, K64).unwrap().is_none());
    }
    assert_eq!(ring.used_idx(), 768);
}

// ---- queue_pop_model: random rings against a reference model of the split ring -----------

/// The reference: the same rules, written as plainly as possible over a snapshot of RAM with
/// u128 arithmetic, independent of `queue.rs`/`chain.rs`.
fn model(
    ram: &[u8],
    size: u16,
    indirect: bool,
    next_avail: u16,
    max_total: u64,
) -> Result<Option<Vec<Descriptor>>, &'static str> {
    let rd = |addr: u64, n: usize| -> Option<&[u8]> {
        let off = addr.checked_sub(RAM)? as usize;
        ram.get(off..off.checked_add(n)?)
    };
    let in_ram = |addr: u64, len: u64| {
        len > 0
            && u128::from(addr) >= u128::from(RAM)
            && u128::from(addr) + u128::from(len) <= u128::from(RAM_END)
    };
    let u16at = |a| u16::from_le_bytes(rd(a, 2).unwrap().try_into().unwrap());
    let avail_idx = u16at(AVAIL + 2);
    let pending = avail_idx.wrapping_sub(next_avail);
    if pending > size {
        return Err("AvailIdxJump");
    }
    if pending == 0 {
        return Ok(None);
    }
    let head = u16at(AVAIL + 4 + 2 * u64::from(next_avail % size));
    if head >= size {
        return Err("HeadOutOfRange");
    }
    let desc_at = |table: u64, i: u16| {
        let b = rd(table + 16 * u64::from(i), 16).unwrap();
        Descriptor {
            addr: u64::from_le_bytes(b[0..8].try_into().unwrap()),
            len: u32::from_le_bytes(b[8..12].try_into().unwrap()),
            flags: u16::from_le_bytes(b[12..14].try_into().unwrap()),
            next: u16::from_le_bytes(b[14..16].try_into().unwrap()),
        }
    };
    let (mut table, mut tlen, mut hops, mut inside) = (DESC, size, u32::from(size), false);
    let mut i = head;
    let mut out = Vec::new();
    let (mut rsum, mut wsum, mut seen_w) = (0u128, 0u128, false);
    loop {
        if hops == 0 {
            return Err("ChainTooLong");
        }
        hops -= 1;
        let x = desc_at(table, i);
        if x.flags & INDIRECT != 0 {
            if !indirect {
                return Err("IndirectNotNegotiated");
            }
            if inside {
                return Err("NestedIndirect");
            }
            if x.flags & NEXT != 0 {
                return Err("IndirectWithNext");
            }
            if x.len == 0 || x.len % 16 != 0 || x.len / 16 > u32::from(size) {
                return Err("BadIndirectLen");
            }
            if u128::from(x.addr) + u128::from(x.len) > u128::from(u64::MAX) {
                return Err("Overflow");
            }
            if !in_ram(x.addr, u64::from(x.len)) {
                return Err("BufferOutOfRam");
            }
            table = x.addr;
            tlen = (x.len / 16) as u16;
            hops = x.len / 16;
            inside = true;
            i = 0;
            continue;
        }
        if x.len == 0 {
            return Err("ZeroLength");
        }
        if u128::from(x.addr) + u128::from(x.len) > u128::from(u64::MAX) {
            return Err("Overflow");
        }
        if !in_ram(x.addr, u64::from(x.len)) {
            return Err("BufferOutOfRam");
        }
        let next = if x.flags & NEXT != 0 {
            if x.next >= tlen {
                return Err("NextOutOfRange");
            }
            Some(x.next)
        } else {
            None
        };
        if x.flags & WRITE != 0 {
            seen_w = true;
            wsum += u128::from(x.len);
            if wsum > u128::from(max_total) {
                return Err("TooLarge");
            }
        } else {
            if seen_w {
                return Err("ReadableAfterWritable");
            }
            rsum += u128::from(x.len);
            if rsum > u128::from(max_total) {
                return Err("TooLarge");
            }
        }
        out.push(x);
        match next {
            Some(n) => i = n,
            None => return Ok(Some(out)),
        }
    }
}

fn kind(e: &QueueError) -> &'static str {
    match e {
        QueueError::AvailIdxJump { .. } => "AvailIdxJump",
        QueueError::HeadOutOfRange { .. } => "HeadOutOfRange",
        QueueError::ChainTooLong { .. } => "ChainTooLong",
        QueueError::IndirectNotNegotiated => "IndirectNotNegotiated",
        QueueError::NestedIndirect => "NestedIndirect",
        QueueError::IndirectWithNext => "IndirectWithNext",
        QueueError::BadIndirectLen { .. } => "BadIndirectLen",
        QueueError::Overflow { .. } => "Overflow",
        QueueError::BufferOutOfRam { .. } => "BufferOutOfRam",
        QueueError::ZeroLength { .. } => "ZeroLength",
        QueueError::NextOutOfRange { .. } => "NextOutOfRange",
        QueueError::TooLarge { .. } => "TooLarge",
        QueueError::ReadableAfterWritable => "ReadableAfterWritable",
        _ => "other",
    }
}

#[test]
fn queue_pop_model() {
    let s = seed(0x0016_d00d);
    let mut rng = XorShift::new(s);
    let iters = if cfg!(debug_assertions) {
        10_000
    } else {
        100_000
    };
    let mut outcomes = std::collections::BTreeMap::<&str, u32>::new();
    for it in 0..iters {
        let mem = mem();
        let size = 1u16 << rng.below(5); // 1..=16
        let indirect = rng.below(2) == 0;
        let mut ring = Ring::new(mem.clone(), size);
        // Random descriptor tables: the main one and two indirect tables.
        let pick_addr = |rng: &mut XorShift| match rng.below(8) {
            0 => TABLE,
            1 => TABLE + 0x400,
            2 => RAM_END - rng.below(64),
            3 => MMIO_ADDR,
            4 => u64::MAX - rng.below(64),
            _ => BUF + rng.below(0x1000),
        };
        let pick = |rng: &mut XorShift, n: u16| Descriptor {
            addr: pick_addr(rng),
            len: match rng.below(6) {
                0 => 0,
                1 => u32::MAX,
                2 => 16 * (1 + rng.below(u64::from(n) + 1)) as u32,
                3 => 1 + rng.below(40) as u32,
                _ => 1 + rng.below(0x2_0000) as u32,
            },
            flags: (rng.below(8) as u16) & if rng.below(3) == 0 { 7 } else { 3 },
            next: rng.below(u64::from(n) + 2) as u16,
        };
        for i in 0..size {
            ring.set_desc(i, pick(&mut rng, size));
        }
        for t in [TABLE, TABLE + 0x400] {
            for i in 0..size {
                ring.set_desc_at(t, i, pick(&mut rng, size));
            }
        }
        let start = rng.next() as u16;
        ring.set_avail_idx(start);
        for _ in 0..rng.below(u64::from(size) + 1) {
            let h = if rng.below(10) == 0 {
                size + rng.below(4) as u16
            } else {
                rng.below(u64::from(size)) as u16
            };
            ring.push(h);
        }
        if rng.below(10) == 0 {
            ring.set_avail_idx(rng.next() as u16);
        }
        let max_total = [K64, 1024, u64::MAX][rng.below(3) as usize];
        let mut snapshot = vec![0u8; RAM_SIZE as usize];
        mem.read(GuestAddress(RAM), &mut snapshot).unwrap();
        let want = model(&snapshot, size, indirect, start, max_total);
        let mut q = ring.queue();
        q.set_indirect(indirect);
        q.set_positions(start, start);
        let got = match q.pop(&*mem) {
            Err(e) => Err(kind(&e)),
            Ok(None) => Ok(None),
            Ok(Some(c)) => match c.into_validated(max_total) {
                Err(e) => Err(kind(&e)),
                Ok(v) => Ok(Some([v.readable, v.writable].concat())),
            },
        };
        assert_eq!(
            got, want,
            "iteration {it}, seed {s} (MACVMM_SEED={s} to replay)"
        );
        *outcomes
            .entry(match &want {
                Ok(Some(_)) => "ok",
                Ok(None) => "empty",
                Err(e) => e,
            })
            .or_default() += 1;
    }
    say(&format!(
        "queue_pop_model: seed {s}, {iters} rings: {outcomes:?}"
    ));
    assert!(
        outcomes.get("ok").copied().unwrap_or(0) > 50,
        "{outcomes:?}"
    );
    assert!(
        outcomes.len() >= 8,
        "the generator reaches most outcomes: {outcomes:?}"
    );
}

// ---- the course corpus -------------------------------------------------------------------

const CORPUS: &str = "tests/data/virtqueue_vectors.json";

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

fn desc_json(index: Option<u16>, x: &Descriptor) -> String {
    let i = index
        .map(|i| format!("\"index\": {i}, "))
        .unwrap_or_default();
    format!(
        "{{{i}\"addr\": \"{:#x}\", \"len\": {}, \"flags\": {}, \"next\": {}}}",
        x.addr, x.len, x.flags, x.next
    )
}

fn corpus() -> String {
    let mut items = Vec::new();
    for c in cases() {
        let outcome = match run(&c) {
            Ok(None) => "{\"empty\": true}".to_owned(),
            Ok(Some((r, w, rl, wl))) => format!(
                "{{\"readable\": {r}, \"writable\": {w}, \"readable_len\": {rl}, \"writable_len\": {wl}}}"
            ),
            Err(e) => format!("{{\"error\": {}}}", json_str(&format!("{e:?}"))),
        };
        let descs: Vec<String> = c
            .descs
            .iter()
            .map(|(i, x)| desc_json(Some(*i), x))
            .collect();
        let tables: Vec<String> = c
            .tables
            .iter()
            .map(|(a, t)| {
                let ds: Vec<String> = t.iter().map(|x| desc_json(None, x)).collect();
                format!(
                    "{{\"addr\": \"{a:#x}\", \"descriptors\": [{}]}}",
                    ds.join(", ")
                )
            })
            .collect();
        let heads: Vec<String> = c.heads.iter().map(u16::to_string).collect();
        items.push(format!(
            "    {{\n      \"name\": {},\n      \"about\": {},\n      \"queue_size\": {},\n      \"indirect_negotiated\": {},\n      \"desc_table\": \"{:#x}\",\n      \"avail_ring\": \"{:#x}\",\n      \"used_ring\": \"{:#x}\",\n      \"descriptors\": [{}],\n      \"indirect_tables\": [{}],\n      \"avail_heads\": [{}],\n      \"avail_idx_override\": {},\n      \"start_index\": {},\n      \"max_total\": {},\n      \"outcome\": {}\n    }}",
            json_str(c.name),
            json_str(c.about),
            c.size,
            c.indirect,
            c.rings.0,
            c.rings.1,
            c.rings.2,
            descs.join(", "),
            tables.join(", "),
            heads.join(", "),
            c.avail_idx.map_or("null".to_owned(), |i| i.to_string()),
            c.positions.map_or(0, |p| p.0),
            c.max_total,
            outcome
        ));
    }
    format!(
        "{{\n  \"about\": \"macvmm split-virtqueue vectors (virtio 1.2 §2.7): each ring as a hostile driver built it, and the verdict of crates/vmm/src/virtio/{{queue,chain}}.rs. RAM is [{RAM:#x}, {RAM_END:#x}); {MMIO_ADDR:#x} is the PL011. Generated by crates/vmm/tests/virtqueue_hostile.rs.\",\n  \"vectors\": [\n{}\n  ]\n}}\n",
        items.join(",\n")
    )
}

#[test]
fn virtqueue_corpus_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(CORPUS);
    let want = corpus();
    if std::env::var_os("MACVMM_BLESS_GOLDEN").is_some() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        have == want,
        "{CORPUS} is out of date: run MACVMM_BLESS_GOLDEN=1 cargo test -p vmm --test virtqueue_hostile, then cargo xtask export-vectors"
    );
}
