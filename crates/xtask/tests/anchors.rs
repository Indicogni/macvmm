//! The ADR-0006 anchor corpus. Each case is a small source text and the problems the checker
//! must report for it; the site builder's JS implementation must agree on the same cases.

use std::path::PathBuf;
use xtask::anchors::{self, ProblemKind, Syntax};

const RS: Syntax = Syntax::Slash { block: false };

fn kinds(text: &str, syntax: Syntax) -> Vec<ProblemKind> {
    anchors::scan("t", text, syntax)
        .1
        .into_iter()
        .map(|p| p.kind)
        .collect()
}

#[test]
fn balanced_anchor_extracts_dedented_body() {
    let src = "fn a() {}\n    // ANCHOR: two\n    let x = 1;\n        let y = 2;\n    // ANCHOR_END: two\n";
    let (regions, problems) = anchors::scan("t.rs", src, RS);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(regions.len(), 1);
    assert_eq!(regions[0].name, "two");
    assert_eq!((regions[0].start_line, regions[0].end_line), (2, 5));
    assert_eq!(regions[0].body, vec!["let x = 1;", "    let y = 2;"]);
}

#[test]
fn nested_anchors_drop_inner_markers() {
    let src =
        "// ANCHOR: outer\na\n// ANCHOR: inner\nb\n// ANCHOR_END: inner\nc\n// ANCHOR_END: outer\n";
    let (regions, problems) = anchors::scan("t.rs", src, RS);
    assert!(problems.is_empty(), "{problems:?}");
    let outer = regions.iter().find(|r| r.name == "outer").unwrap();
    assert_eq!(outer.body, vec!["a", "b", "c"]);
    let inner = regions.iter().find(|r| r.name == "inner").unwrap();
    assert_eq!(inner.body, vec!["b"]);
}

#[test]
fn duplicate_anchor_is_an_error() {
    let src = "// ANCHOR: d\nx\n// ANCHOR_END: d\n// ANCHOR: d\ny\n// ANCHOR_END: d\n";
    assert_eq!(kinds(src, RS), vec![ProblemKind::Duplicate("d".into())]);
}

#[test]
fn unterminated_anchor_is_an_error() {
    assert_eq!(
        kinds("// ANCHOR: open\nx\n", RS),
        vec![ProblemKind::Unterminated("open".into())]
    );
}

#[test]
fn end_without_start_is_an_error() {
    assert_eq!(
        kinds("x\n// ANCHOR_END: ghost\n", RS),
        vec![ProblemKind::EndWithoutStart("ghost".into())]
    );
}

#[test]
fn partial_overlap_is_an_error() {
    let src = "// ANCHOR: a\n1\n// ANCHOR: b\n2\n// ANCHOR_END: a\n3\n// ANCHOR_END: b\n";
    assert_eq!(
        kinds(src, RS),
        vec![ProblemKind::PartialOverlap {
            closing: "a".into(),
            open: "b".into()
        }]
    );
}

#[test]
fn empty_region_is_an_error() {
    assert_eq!(
        kinds("// ANCHOR: e\n\n   \n// ANCHOR_END: e\n", RS),
        vec![ProblemKind::Empty("e".into())]
    );
    // A region holding only a nested region's markers is empty too... but the inner one is
    // reported as well.
    let src = "// ANCHOR: o\n// ANCHOR: i\n// ANCHOR_END: i\n// ANCHOR_END: o\n";
    assert_eq!(
        kinds(src, RS),
        vec![
            ProblemKind::Empty("o".into()),
            ProblemKind::Empty("i".into())
        ]
    );
}

#[test]
fn region_longer_than_sixty_lines_is_an_error() {
    let body: String = (0..61).map(|i| format!("line{i}\n")).collect();
    let src = format!("// ANCHOR: long\n{body}// ANCHOR_END: long\n");
    assert_eq!(
        kinds(&src, RS),
        vec![ProblemKind::TooLong {
            name: "long".into(),
            lines: 61
        }]
    );
    let ok: String = (0..60).map(|i| format!("line{i}\n")).collect();
    assert!(kinds(&format!("// ANCHOR: ok\n{ok}// ANCHOR_END: ok\n"), RS).is_empty());
}

#[test]
fn three_comment_syntaxes() {
    let sh = "#!/usr/bin/env bash\n# ANCHOR: sh_part\necho hi\n# ANCHOR_END: sh_part\n";
    let md = "<!-- ANCHOR: md_part -->\ntext\n<!-- ANCHOR_END: md_part -->\n";
    let rs = "// ANCHOR: rs_part\nfn f() {}\n// ANCHOR_END: rs_part\n";
    for (path, text, name) in [
        ("a.sh", sh, "sh_part"),
        ("a.md", md, "md_part"),
        ("a.rs", rs, "rs_part"),
    ] {
        let syntax = Syntax::for_path(path).unwrap();
        let (regions, problems) = anchors::scan(path, text, syntax);
        assert!(problems.is_empty(), "{path}: {problems:?}");
        assert_eq!(
            regions.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec![name]
        );
    }
    // The wrong syntax for a file type is not a marker.
    assert!(anchors::scan("a.rs", md, RS).0.is_empty());
    // C also accepts block comments.
    let c = "/* ANCHOR: c_part */\nint x;\n/* ANCHOR_END: c_part */\n";
    assert_eq!(
        anchors::scan("a.c", c, Syntax::for_path("a.c").unwrap())
            .0
            .len(),
        1
    );
}

#[test]
fn linker_scripts_accept_hash_and_block_comments() {
    // ADR-0006 writes `#` for linker scripts (lld accepts it); `/* */` is the GNU ld-portable
    // form. Both are markers in a `.ld` file; `//` is not a linker-script comment.
    let ld = Syntax::for_path("guests/link.ld").unwrap();
    assert_eq!(ld, Syntax::Linker);
    let hash = "SECTIONS {\n# ANCHOR: ld_hash\n  . = 0x40080000;\n# ANCHOR_END: ld_hash\n}\n";
    let block = "SECTIONS {\n/* ANCHOR: ld_block */\n  .text : { *(.text*) }\n/* ANCHOR_END: ld_block */\n}\n";
    for (text, name) in [(hash, "ld_hash"), (block, "ld_block")] {
        let (regions, problems) = anchors::scan("link.ld", text, ld);
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(
            regions.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
            vec![name]
        );
    }
    let slash = "// ANCHOR: ld_slash\nx\n// ANCHOR_END: ld_slash\n";
    assert!(anchors::scan("link.ld", slash, ld).0.is_empty());
}

#[test]
fn prose_mentions_and_fences_are_not_markers() {
    let md = "Use `// ANCHOR: name` in Rust.\n```rust\n// ANCHOR: in_fence\n```\n<!-- ANCHOR: real -->\nx\n<!-- ANCHOR_END: real -->\n";
    let (regions, problems) = anchors::scan("doc.md", md, Syntax::Html);
    assert!(problems.is_empty(), "{problems:?}");
    assert_eq!(regions.len(), 1);
}

#[test]
fn invalid_names_are_errors() {
    assert_eq!(
        kinds("// ANCHOR: Bad-Name\nx\n// ANCHOR_END: Bad-Name\n", RS).len(),
        2
    );
    assert!(anchors::valid_name("esr_decode_data_abort"));
    assert!(
        !anchors::valid_name("1abc") && !anchors::valid_name("") && !anchors::valid_name("a-b")
    );
}

#[test]
fn learner_markers_follow_the_same_rules() {
    let src = "// LEARNER: hole\nx\n// LEARNER_END: hole\n// LEARNER: open\n";
    assert_eq!(
        kinds(src, RS),
        vec![ProblemKind::Unterminated("open".into())]
    );
}

/// A throwaway repository tree under the system temp dir, removed on drop.
struct TempTree(PathBuf);

impl TempTree {
    fn new(tag: &str) -> TempTree {
        let dir = std::env::temp_dir().join(format!("xtask-anchors-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempTree(dir)
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn lesson_references_resolve_or_fail() {
    let t = TempTree::new("refs");
    t.write("crates/vmm/src/a.rs", "// ANCHOR: present\nfn f() {}\n// ANCHOR_END: present\n// ANCHOR: unused\nfn g() {}\n// ANCHOR_END: unused\n");
    t.write(
        "course/chapters/p/01-x.md",
        ":::code anchor=present file=crates/vmm/src/a.rs\n\
         :::code anchor=absent file=crates/vmm/src/a.rs\n\
         :::code anchor=present file=crates/vmm/src/missing.rs\n\
         ```\n:::code anchor=ignored file=nowhere.rs\n```\n",
    );
    let report = anchors::check_repo(&t.0).unwrap();
    let kinds: Vec<&ProblemKind> = report.problems.iter().map(|p| &p.kind).collect();
    assert_eq!(
        kinds,
        vec![
            &ProblemKind::MissingAnchor {
                file: "crates/vmm/src/a.rs".into(),
                name: "absent".into()
            },
            &ProblemKind::MissingFile("crates/vmm/src/missing.rs".into()),
        ]
    );
    assert_eq!(report.references, 3);
    assert!(
        report.warnings.iter().any(|w| w.contains("\"unused\"")),
        "{:?}",
        report.warnings
    );
}
