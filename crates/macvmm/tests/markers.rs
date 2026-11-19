//! Host test of the e2e harness's marker rules (PLAN §0.3), so a broken matcher cannot make an
//! on-machine test pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{check_markers, find_wild};

#[test]
fn wildcards_stay_on_one_line() {
    assert_eq!(find_wild("ab x=0x12 cd", "x=0x*", 0), Some(7));
    assert!(find_wild("pc 0x40081010\n", "pc 0x4008*", 0).is_some());
    assert!(find_wild("a\nb", "a*b", 0).is_none());
    assert!(find_wild("in 5 ticks, 9 ns/exit", "in * ticks, * ns/exit", 0).is_some());
    assert!(find_wild("in 5 ticks\n, 9 ns/exit", "in * ticks, * ns/exit", 0).is_none());
    assert!(find_wild("é ok", "ok", 1).is_some());
    assert!(find_wild("", "x", 0).is_none());
}

#[test]
fn order_streams_and_negatives() {
    let spec = "one\ntwo\n[stderr] boom *\n!never\n";
    assert!(check_markers(spec, "one two", "boom 1").is_ok());
    assert!(check_markers(spec, "two one", "boom 1").is_err(), "order");
    assert!(check_markers(spec, "one two", "").is_err(), "stderr marker");
    assert!(
        check_markers(spec, "one two", "boom 1 never").is_err(),
        "negative on stderr"
    );
    assert!(
        check_markers(spec, "one two never", "boom 1").is_err(),
        "negative on stdout"
    );
    assert!(check_markers("![stderr] x\n", "x", "").is_ok());
    assert!(check_markers("\n\n", "", "").is_ok());
    // A stdout marker never matches text that only appears on stderr (AS10).
    assert!(check_markers("[stderr] unhandled MMIO\n", "unhandled MMIO", "").is_err());
}
