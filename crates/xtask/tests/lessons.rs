//! The lesson lint (`scripts/check-lessons`) and the capture helper (`scripts/capture-cmd`):
//! a miniature course tree with one good lesson, then one mutation per rule.

use std::fs;
use std::path::{Path, PathBuf};
use xtask::capture;
use xtask::lessons::{self, Level};

const CHAPTERS_JSON: &str = r#"{
  "chapters": [
    {"id": "00", "part": "0", "number": "0.1", "slug": "intro", "title": "Intro", "runs": "browser", "minutes": 60, "labs": [], "primers": [], "prereqs": [], "file": "course/chapters/0/00-intro.md"},
    {"id": "01", "part": "0", "number": "0.2", "slug": "demo", "title": "A demo: first steps", "runs": "mac+browser", "minutes": 90, "labs": ["demo-lab"], "primers": ["os-basics"], "prereqs": ["00"], "file": "course/chapters/0/01-demo.md"}
  ],
  "primers": [{"slug": "os-basics"}, {"slug": "aarch64-reading"}],
  "labs": [{"name": "demo-lab"}]
}"#;

const GLOSSARY: &str = "# Glossary\n\nIntro.\n\n## Primers\n\n- **svc** (supervisor call): An app's call to its kernel. Taught in `os-basics`.\n\n## Chapter 00\n\n## Chapter 01\n\n- **VM exit**: The moment the guest stops and our VMM runs.\n- **ESR** (exception syndrome register): Why an exception happened.\n";

const LESSON: &str = "---
title: A demo: first steps
part: 0
chapter: 0.2
id: 01
runs: mac+browser
minutes: 90
prereqs: [00]
start_tag: ch-00
labs: [demo-lab]
command: scripts/checkpoint.sh 01
expect: CHECKPOINT 01 PASS
---

:::retrieval

:::concepts
- **Core, taught here:** the [VM exit](/build-your-own/vmm/glossary/#vm-exit).
- **Core, from earlier:** none.
- **Primers (read first):** `os-basics` (the `svc` instruction).
- **Pointers:** none.
- **Forward definitions:** none.
:::

A guest stops. Why? This chapter closes row 1 of the ledger. The ESR (exception syndrome register) says why.

:::objectives
- Decode a syndrome.
- Predict the PC after an exit.
:::

## Running it

:::predict Where does the PC point?
After the call.
:::

:::code anchor=demo_code file=src/demo.rs

:::lab demo-lab

> **Aside.** A note.

:::stopping-point Good place to stop.

```sh
cargo run -q -p macvmm -- first-exit
```

## Checkpoint

:::checkpoint

:::term source=captures/01-demo.txt

### What's next

More.

### Open question

What changed?

## Spec hunt

- The ARM ARM, ESR_EL2: which class is `0x16`?
- The header: which thread may run a vCPU?
";

const JOURNAL: &str = "# Journal 01: A demo: first steps\n\n## Predict\n\n> Where?\n\n## Q1\n\n> *Observe.* What?\n\n## Q2\n\n> *Transfer, the open question.* Why?\n";
const RUBRIC: &str =
    "# Rubric 01: A demo: first steps\n\n## Q1\n\n- an idea\n\n## Q2\n\n- another\n";

fn retrieval(n: usize) -> String {
    let mut s = String::from("# Retrieval 01: A demo: first steps\n");
    for i in 1..=n {
        s.push_str(&format!("\n## R{i}\nQ: question {i}?\nA: answer {i}.\n"));
    }
    s
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// A complete, valid miniature course tree.
fn tree(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("xtask-lessons-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    write(&root, "course/chapters.json", CHAPTERS_JSON);
    write(&root, "course/GLOSSARY.md", GLOSSARY);
    write(&root, "course/primers/os-basics.md", "# primer\n");
    write(
        &root,
        "course/captures/01-demo.txt",
        "# scripts/capture-cmd 01: real output.\n$ x\nexit: 0\n",
    );
    write(
        &root,
        "src/demo.rs",
        "// ANCHOR: demo_code\nfn demo() {}\n// ANCHOR_END: demo_code\n",
    );
    write(&root, "course/chapters/0/01-demo.md", LESSON);
    write(&root, "course/retrieval/01.md", &retrieval(6));
    write(&root, "course/journal/01.md", JOURNAL);
    write(&root, "course/journal/01.rubric.md", RUBRIC);
    write(
        &root,
        "course/checkpoints/01/checkpoint.toml",
        "id = \"01\"\nslug = \"demo\"\n\n[[run]]\nname = \"demo\"\nargs = [\"first-exit\"]\nexpect_exit_code = 0\n\n[journal]\nfile = \"journal/01.md\"\nquestions = 2\npredict = true\n",
    );
    root
}

fn errors(root: &Path) -> Vec<String> {
    let r = lessons::run(root, &[]).unwrap();
    r.diags
        .iter()
        .filter(|d| d.level == Level::Error)
        .map(|d| d.to_string())
        .collect()
}

fn mutate(root: &Path, rel: &str, from: &str, to: &str) {
    let p = root.join(rel);
    let t = fs::read_to_string(&p).unwrap();
    assert!(t.contains(from), "fixture lacks {from:?}");
    fs::write(p, t.replacen(from, to, 1)).unwrap();
}

fn assert_error(root: &Path, needle: &str) {
    let e = errors(root);
    assert!(
        e.iter().any(|m| m.contains(needle)),
        "no error containing {needle:?} in {e:#?}"
    );
}

#[test]
fn good_tree_passes() {
    let root = tree("good");
    let r = lessons::run(&root, &[]).unwrap();
    let errs: Vec<_> = r.diags.iter().filter(|d| d.level == Level::Error).collect();
    assert!(errs.is_empty(), "{errs:#?}");
    assert_eq!(r.lessons, 1);
    // Chapter ids resolve to the lesson file too.
    let r = lessons::run(&root, &["01".to_owned()]).unwrap();
    assert_eq!(r.lessons, 1);
}

#[test]
fn front_matter_must_match_chapters_json() {
    let root = tree("fm");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "chapter: 0.2",
        "chapter: 0.3",
    );
    assert_error(&root, "`chapter: 0.3` but course/chapters.json says");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "expect: CHECKPOINT 01 PASS\n",
        "",
    );
    assert_error(&root, "front matter lacks `expect`");
}

#[test]
fn concepts_box_needs_all_groups_in_order() {
    let root = tree("concepts");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "- **Pointers:** none.\n",
        "",
    );
    assert_error(&root, "lacks `- **Pointers:**`");
}

#[test]
fn required_primer_must_exist() {
    let root = tree("primer");
    fs::remove_file(root.join("course/primers/os-basics.md")).unwrap();
    assert_error(&root, "primer course/primers/os-basics.md does not exist");
}

#[test]
fn opening_puzzle_cites_the_ledger() {
    let root = tree("ledger");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "row 1 of the ledger",
        "row 1",
    );
    assert_error(&root, "cites the ledger row");
}

#[test]
fn code_anchor_must_resolve() {
    let root = tree("anchor");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "anchor=demo_code",
        "anchor=nope",
    );
    assert_error(&root, "anchor \"nope\" not found in src/demo.rs");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        " file=src/demo.rs",
        "",
    );
    assert_error(&root, "needs both `anchor=NAME` and `file=PATH`");
}

#[test]
fn captures_must_exist_with_a_header() {
    let root = tree("capture");
    write(&root, "course/captures/01-demo.txt", "no header\n");
    assert_error(&root, "no `# ` provenance header");
    fs::remove_file(root.join("course/captures/01-demo.txt")).unwrap();
    assert_error(&root, "capture course/captures/01-demo.txt does not exist");
}

#[test]
fn author_notation_is_an_error_in_lessons_and_journals() {
    let root = tree("notation");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "More.",
        "More, per M4 [V].",
    );
    assert_error(&root, "looks like a milestone ID");
    assert_error(&root, "author evidence tag [V]");
    mutate(
        &root,
        "course/journal/01.md",
        "What?",
        "What (novice review 2.2)?",
    );
    assert_error(&root, "review reference");
}

#[test]
fn checkpoint_section_shape() {
    let root = tree("cp");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "### Open question\n\nWhat changed?\n",
        "",
    );
    assert_error(
        &root,
        "ends with `### What's next` then `### Open question`",
    );
    let root = tree("cp2");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "- The header: which thread may run a vCPU?\n",
        "",
    );
    assert_error(&root, "`## Spec hunt` has 1 items");
}

#[test]
fn directives_inside_blockquotes_and_code_fences_are_refused() {
    let root = tree("quote");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "> **Aside.** A note.",
        "> **Aside.** A note.\n>\n> :::term source=captures/01-demo.txt",
    );
    assert_error(&root, "directive inside a blockquote");
    let root = tree("fence");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "```sh\ncargo",
        "```rust\ncargo",
    );
    assert_error(&root, "a `rust` code fence");
    let root = tree("label");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "> **Aside.**",
        "> **Note.**",
    );
    assert_error(&root, "callout label \"Note\"");
}

#[test]
fn companions_are_checked() {
    let root = tree("companions");
    write(&root, "course/retrieval/01.md", &retrieval(4));
    assert_error(&root, "4 items; a bank has 6 to 10");
    mutate(&root, "course/journal/01.md", "## Q2", "## Q3");
    assert_error(&root, "expected `## Q2`, found `## Q3`");
    fs::remove_file(root.join("course/journal/01.rubric.md")).unwrap();
    assert_error(&root, "missing the journal rubric");
}

#[test]
fn journal_count_must_match_checkpoint_toml() {
    let root = tree("jcount");
    mutate(
        &root,
        "course/checkpoints/01/checkpoint.toml",
        "questions = 2",
        "questions = 3",
    );
    assert_error(&root, "2 questions, but checkpoint.toml says questions = 3");
}

#[test]
fn glossary_links_and_format() {
    let root = tree("gloss");
    mutate(
        &root,
        "course/chapters/0/01-demo.md",
        "#vm-exit",
        "#vm-exits",
    );
    assert_error(&root, "glossary link #vm-exits has no entry");
    let root = tree("gloss2");
    mutate(
        &root,
        "course/GLOSSARY.md",
        "- **ESR**",
        "- **VM exit**: duplicate.\n- **ESR**",
    );
    assert_error(&root, "duplicate term \"VM exit\"");
    let root = tree("gloss3");
    mutate(
        &root,
        "course/GLOSSARY.md",
        "- **ESR** (exception",
        "* ESR (exception",
    );
    assert_error(&root, "not an entry");
}

#[test]
fn notation_rules() {
    let n = |s: &str| lessons::notation_problems(s).len();
    assert_eq!(n("Runs on an Apple M4 and an M5 Pro."), 0);
    assert_eq!(n("The L1 cache is small."), 0);
    assert_eq!(n("`M4` inside code is ignored"), 0);
    assert_eq!(n("See risk K11."), 1);
    assert_eq!(n("Done in M4."), 1);
    assert_eq!(n("The L2 level."), 1);
    assert_eq!(n("architecture §4"), 1);
    assert_eq!(n("[U] maybe"), 1);
    assert_eq!(n("Write an ADR first."), 0);
    let s = lessons::style_problems("This is just simply ch05.");
    assert_eq!(s.len(), 3, "{s:?}");
}

#[test]
fn shown_code_comments_must_be_free_of_author_notation() {
    // A tracking ID in a comment inside a region a lesson shows is an error, reported at
    // the source line.
    let root = tree("codenote");
    mutate(
        &root,
        "src/demo.rs",
        "fn demo() {}",
        "/// Refuse a looping chain (VQ-5, architecture \u{a7}11.2).\nfn demo() {}",
    );
    assert_error(&root, "src/demo.rs:2: error: anchor \"demo_code\"");
    assert_error(&root, "VQ-5");
    assert_error(&root, "`architecture \u{a7}`");
    // Code (here a string literal) is not a comment, and comments outside every shown
    // region are not checked.
    let root = tree("codenote2");
    mutate(
        &root,
        "src/demo.rs",
        "fn demo() {}",
        "fn demo() { let _ = \"M12 // VQ-5\"; }",
    );
    mutate(
        &root,
        "src/demo.rs",
        "// ANCHOR_END: demo_code\n",
        "// ANCHOR_END: demo_code\n// PLAN M3, VQ-5\n",
    );
    let r = lessons::run(&root, &[]).unwrap();
    let errs: Vec<_> = r.diags.iter().filter(|d| d.level == Level::Error).collect();
    assert!(errs.is_empty(), "{errs:#?}");
}

#[test]
fn code_notation_rules() {
    let n = |s: &str| lessons::code_notation_problems(s).len();
    // External specs cited by section, chips, standards and ADRs are fine.
    assert_eq!(
        n("// virtio 1.2 \u{a7}2.7.5; DEN 0022 \u{a7}5.1.3; ARM ARM D19.2"),
        0
    );
    assert_eq!(
        n("/// 64 KiB on the M5 Pro; UTF-8 and SHA-256; ADR-0003"),
        0
    );
    assert_eq!(
        n("/// `PageSize::K16` and `HC-6` in code spans are code"),
        0
    );
    // The project's own tracking vocabulary is not.
    assert_eq!(n("// the hop budget (VQ-5)"), 1);
    assert_eq!(n("// BLK-2..BLK-5, SIGN-4"), 3);
    assert_eq!(n("/// The exit code (architecture \u{a7}13.2)."), 1);
    assert_eq!(n("/// file (threat model \u{a7}7.14)"), 1);
    assert_eq!(n("/// like M12 (PLAN D12)"), 2);
    assert_eq!(n("/// advanced the PC (spike finding 5)"), 1);
    assert_eq!(n("/// relative to the repo root (S14), risk K11, R12"), 3);
    assert_eq!(n("/// [frozen ch09]"), 1);
    assert_eq!(n("/// bound as `[V]`"), 1);
}

#[test]
fn comment_text_by_syntax() {
    use xtask::anchors::Syntax;
    let rs = Syntax::Slash { block: false };
    assert_eq!(lessons::comment_text("    x(); // VQ-1", rs), "// VQ-1");
    assert_eq!(
        lessons::comment_text("let s = \"a // b\"; // c", rs),
        "// c"
    );
    assert_eq!(lessons::comment_text("let q = '\"'; // c", rs), "// c");
    assert_eq!(lessons::comment_text("let s = \"a // b\";", rs), "");
    assert_eq!(
        lessons::comment_text(" * block (SC-3)", Syntax::Slash { block: true }),
        "* block (SC-3)"
    );
    assert_eq!(
        lessons::comment_text("x=\"${y#z}\" # c", Syntax::Hash),
        "# c"
    );
    assert_eq!(lessons::comment_text("echo \"$#\"", Syntax::Hash), "");
    assert_eq!(
        lessons::comment_text("<a/> <!-- c -->", Syntax::Html),
        "<!-- c -->"
    );
}

#[test]
fn front_matter_parser() {
    let fm =
        lessons::parse_front_matter("---\ntitle: A: b\nlabs: [x, y]\nlist:\n- a  # c\n---\nbody\n")
            .unwrap();
    assert_eq!(fm.get("title"), Some(&lessons::FmValue::Str("A: b".into())));
    assert_eq!(
        fm.get("labs"),
        Some(&lessons::FmValue::List(vec!["x".into(), "y".into()]))
    );
    assert_eq!(
        fm.get("list"),
        Some(&lessons::FmValue::List(vec!["a".into()]))
    );
    assert_eq!(fm.body_line, 7);
    assert!(lessons::parse_front_matter("no front matter").is_err());
    assert!(lessons::parse_front_matter("---\na: 1\na: 2\n---\n").is_err());
}

#[test]
fn slugs_and_capture_names() {
    assert_eq!(lessons::slug("VM exit"), "vm-exit");
    assert_eq!(lessons::slug("CPSR / PSTATE"), "cpsr-pstate");
    assert_eq!(lessons::slug("EL0, EL1, EL2, EL3"), "el0-el1-el2-el3");
    assert!(lessons::valid_capture_name("02-first-exit.txt"));
    assert!(lessons::valid_capture_name("03-hello-trace.trace.jsonl"));
    assert!(!lessons::valid_capture_name("2-x.txt"));
    assert!(!lessons::valid_capture_name("02-Bad.txt"));
    assert!(!lessons::valid_capture_name("02-.txt"));
    assert!(!lessons::valid_capture_name("02-x.log"));
}

#[test]
fn capture_args_and_sanitizing() {
    let a = capture::parse_args(
        &[
            "--timeout",
            "5",
            "--note",
            "n",
            "--subst",
            "/a/b=<t>",
            "course/captures/02-x.txt",
            "--",
            "echo",
            "hi",
        ]
        .map(String::from),
    )
    .unwrap();
    assert_eq!(a.timeout, 5);
    assert_eq!(a.cmd, ["echo", "hi"]);
    assert_eq!(a.substs, [("/a/b".to_owned(), "<t>".to_owned())]);
    assert!(capture::parse_args(&["out.txt".to_owned()]).is_err());
    assert!(capture::parse_args(&["--timeout", "0", "o", "--", "x"].map(String::from)).is_err());
    let s = capture::sanitize(
        "/a/b/c and /a/bc\u{1b}[31m",
        &[
            ("/a".into(), "<repo>".into()),
            ("/a/b".into(), "<tree>".into()),
        ],
    );
    assert_eq!(s, "<tree>/c and <tree>c\\x1b[31m");
}
