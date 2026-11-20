//! The opening puzzle of chapter 16, as a test: one descriptor whose `next` names itself,
//! published once in the available ring, walked with the bare `DescriptorChain` iterator (no
//! byte cap, unlike `into_validated`). With the hop budget the walk stops after N descriptors
//! with `ChainTooLong`; with the budget commented out it never stops (the lesson's first
//! deliberate breakage). Host only: `VecMemory`, no Hypervisor.framework call.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod virtio_support;

use virtio_support::*;

// ANCHOR: walk_self_loop
#[test]
fn walk_a_self_loop() {
    let mem = mem();
    // N = 8. Descriptor 0: 8 bytes at 0x4000_8000, NEXT set, next = 0 (itself).
    let mut ring = Ring::new(mem.clone(), 8);
    ring.set_desc(0, d(BUF, 8, NEXT, 0));
    ring.push(0); // ring[0] = head 0, avail.idx = 1
    let mut q = ring.queue();
    let chain = q.pop(&*mem).unwrap().expect("one request is pending");
    let mut count: u64 = 0;
    for item in chain {
        match item {
            Ok(_) => count += 1,
            Err(e) => {
                say(&format!(
                    "walk_a_self_loop: refused after {count} descriptors: {e}"
                ));
                return;
            }
        }
    }
    panic!("the walk ended normally after {count} descriptors");
}
// ANCHOR_END: walk_self_loop
