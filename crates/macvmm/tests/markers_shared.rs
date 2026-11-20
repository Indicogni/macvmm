//! The e2e harness's marker rules against the fixture table it shares with the checkpoint
//! harness (PLAN M27 host acceptance "markers: the same fixture table as the e2e support crate,
//! so both implementations agree"). The table lives in `crates/xtask/tests/data/` and is also
//! run by `crates/xtask/tests/checkpoint.rs` against `xtask::checkpoint::markers`; if the two
//! implementations of PLAN §0.3 ever disagree, one of the two tests fails. Host only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::check_markers;

/// One fixture: name, spec, stdout, stderr, expectation.
struct Fixture {
    name: String,
    parts: [String; 3],
    ok: bool,
}

/// The fixture format (documented at the top of the table; same rules as
/// `xtask::checkpoint::markers::parse_fixtures`, written out again here on purpose: this test
/// crate does not depend on xtask).
fn parse(text: &str) -> Vec<Fixture> {
    let mut out: Vec<Fixture> = Vec::new();
    let mut bufs: [Vec<&str>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let mut cur: Option<(String, Option<bool>)> = None;
    let mut section: Option<usize> = None;
    let flush = |cur: &mut Option<(String, Option<bool>)>,
                 bufs: &mut [Vec<&str>; 3],
                 out: &mut Vec<Fixture>| {
        if let Some((name, ok)) = cur.take() {
            out.push(Fixture {
                ok: ok.unwrap_or_else(|| panic!("fixture {name:?} has no expect")),
                name,
                parts: bufs.each_mut().map(|b| std::mem::take(b).join("\n")),
            });
        }
    };
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("=== ") {
            flush(&mut cur, &mut bufs, &mut out);
            cur = Some((name.trim().to_owned(), None));
            section = None;
            continue;
        }
        let Some((_, ok)) = cur.as_mut() else {
            assert!(line.starts_with('#') || line.trim().is_empty(), "{line:?}");
            continue;
        };
        match line {
            "--- spec" => section = Some(0),
            "--- stdout" => section = Some(1),
            "--- stderr" => section = Some(2),
            "--- expect" => section = Some(3),
            _ => match section {
                Some(3) => match line.trim() {
                    "ok" => *ok = Some(true),
                    "err" => *ok = Some(false),
                    "" => {}
                    other => panic!("expect {other:?}"),
                },
                Some(s) => bufs[s].push(line),
                None => panic!("text outside a section: {line:?}"),
            },
        }
    }
    flush(&mut cur, &mut bufs, &mut out);
    out
}

#[test]
fn e2e_marker_rules_agree_with_the_shared_table() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../xtask/tests/data/markers_fixtures.txt");
    let text = std::fs::read_to_string(&path).unwrap();
    let fixtures = parse(&text);
    assert!(fixtures.len() >= 25, "{} fixtures", fixtures.len());
    for f in &fixtures {
        let [spec, stdout, stderr] = &f.parts;
        let got = check_markers(spec, stdout, stderr);
        assert_eq!(got.is_ok(), f.ok, "fixture {:?}: {got:?}", f.name);
    }
}
