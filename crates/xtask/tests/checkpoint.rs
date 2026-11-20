//! Host tests of the checkpoint harness (PLAN M27 "Acceptance: host" and "Security tests"):
//! the definition parser over every real `checkpoint.toml`, the `toml_lite`/`json_lite` caps,
//! the marker rules against the fixture table shared with the e2e harness, the journal check
//! and the report shapes of CURRICULUM §3.3. Nothing here needs HVF.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use xtask::checkpoint::{self, json_lite, markers, report, run, toml_lite};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

// --- the shared marker fixture table ---------------------------------------------------------

#[test]
fn marker_fixtures_agree() {
    let text = std::fs::read_to_string(repo().join("crates/xtask/tests/data/markers_fixtures.txt"))
        .unwrap();
    let fixtures = markers::parse_fixtures(&text).unwrap();
    assert!(fixtures.len() >= 25, "{} fixtures", fixtures.len());
    for f in &fixtures {
        let got = markers::check(&f.spec, &f.stdout, &f.stderr);
        assert_eq!(got.is_ok(), f.ok, "fixture {:?}: {got:?}", f.name);
    }
}

#[test]
fn fixture_format_errors() {
    assert!(
        markers::parse_fixtures("=== a\n--- spec\nx\n").is_err(),
        "no expect"
    );
    assert!(markers::parse_fixtures("stray\n").is_err());
    assert!(markers::parse_fixtures("=== a\n--- expect\nmaybe\n").is_err());
    assert!(markers::parse_fixtures("=== a\nfree text\n").is_err());
}

#[test]
fn mismatch_names_the_first_failing_line() {
    let m = markers::check("one\n\ntwo\n[stderr] three\n", "one two", "").unwrap_err();
    assert_eq!(m.line, 4);
    assert_eq!(m.marker, "[stderr] three");
    assert_eq!((m.tally.matched, m.tally.total), (2, 3));
}

// --- every real checkpoint definition --------------------------------------------------------

#[test]
fn every_checkpoint_definition_loads() {
    let ids = checkpoint::all_ids(&repo());
    let want: Vec<String> = (0..=12).map(|n| format!("{n:02}")).collect();
    for id in &want {
        assert!(ids.contains(id), "checkpoint {id} has no checkpoint.toml");
    }
    for id in &ids {
        let cp = checkpoint::load(&repo(), id).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(&cp.id, id);
        assert!(!cp.slug.is_empty(), "{id}: slug");
        assert_eq!(cp.hints.len(), 4, "{id}: the four hint rungs");
        let journal = cp
            .journal
            .as_ref()
            .unwrap_or_else(|| panic!("{id}: [journal]"));
        // The template the learner gets has exactly the questions the checkpoint asks for.
        let template =
            std::fs::read_to_string(repo().join(format!("course/journal/{id}.md"))).unwrap();
        let qs = template.lines().filter(|l| l.starts_with("## Q")).count();
        assert_eq!(qs, journal.questions, "{id}: journal question count");
        // Every marker file a run names parses, and every run asserts an exit code (AS10).
        for r in &cp.runs {
            for rel in [&r.serial, &r.trace].into_iter().flatten() {
                let spec = std::fs::read_to_string(cp.dir.join(rel)).unwrap();
                assert!(!markers::parse(&spec).is_empty(), "{id}/{rel}: empty");
            }
        }
    }
}

fn write_cp(dir: &Path, id: &str, toml: &str) -> PathBuf {
    let d = dir.join("course/checkpoints").join(id);
    std::fs::create_dir_all(d.join("expected")).unwrap();
    std::fs::write(d.join("expected/x.txt"), "x\n").unwrap();
    std::fs::write(d.join("checkpoint.toml"), toml).unwrap();
    d
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("xtask-checkpoint-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn hostile_definitions_are_refused() {
    let root = scratch("hostile-defs");
    let base = "id = \"03\"\n[[run]]\nname = \"a\"\nargs = [\"run\"]\nexpect_exit_code = 0\n";
    write_cp(&root, "03", base);
    assert!(checkpoint::load(&root, "03").is_ok());
    let cases = [
        (
            "marker path escapes",
            base.replace("expect_exit_code", "serial = \"../../x\"\nexpect_exit_code"),
        ),
        (
            "absolute marker path",
            base.replace(
                "expect_exit_code",
                "serial = \"/etc/passwd\"\nexpect_exit_code",
            ),
        ),
        ("no exit code", base.replace("expect_exit_code = 0\n", "")),
        ("exit code out of range", base.replace("= 0\n", "= 256\n")),
        (
            "timeout too long",
            base.replace("expect_exit_code", "timeout = 601\nexpect_exit_code"),
        ),
        (
            "unknown key",
            base.replace("expect_exit_code", "upload = true\nexpect_exit_code"),
        ),
        ("unknown table", format!("{base}[telemetry]\nx = 1\n")),
        ("id mismatch", base.replace("\"03\"", "\"04\"")),
        ("bad run name", base.replace("\"a\"", "\"../a\"")),
        (
            "guest placeholder without guest",
            base.replace("[\"run\"]", "[\"run\", \"{guest}\"]"),
        ),
        (
            "requires a later checkpoint",
            base.replace("id = \"03\"", "id = \"03\"\nrequires = [\"04\"]"),
        ),
        (
            "bad step",
            base.replace(
                "expect_exit_code",
                "steps = [\"exec:rm\"]\nexpect_exit_code",
            ),
        ),
        (
            "bad signal",
            base.replace(
                "expect_exit_code",
                "steps = [\"signal:KILL\"]\nexpect_exit_code",
            ),
        ),
        ("two execs", base.replace("args", "command = [\"x\"]\nargs")),
        (
            "odd blob",
            base.replace("expect_exit_code", "blob_hex = \"abc\"\nexpect_exit_code"),
        ),
    ];
    for (what, text) in cases {
        write_cp(&root, "03", &text);
        assert!(
            checkpoint::load(&root, "03").is_err(),
            "{what} was accepted:\n{text}"
        );
    }
    assert!(checkpoint::load(&root, "1").is_err());
    assert!(checkpoint::load(&root, "28").is_err());
    assert!(checkpoint::load(&root, "../03").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

/// A `contract_hvf` run must name its deadline (it bounds the build too) and can only expect
/// exit 0 (review finding: both keys used to be accepted and ignored).
#[test]
fn contract_hvf_runs_need_a_timeout_and_exit_zero() {
    let root = scratch("hvf-defs");
    let base = "id = \"03\"\n[[run]]\nname = \"h\"\ncontract_hvf = \"contract/x.rs\"\ntimeout = 60\nexpect_exit_code = 0\n";
    let d = write_cp(&root, "03", base);
    std::fs::create_dir_all(d.join("contract")).unwrap();
    std::fs::write(d.join("contract/x.rs"), "").unwrap();
    let cp = checkpoint::load(&root, "03").unwrap();
    assert_eq!(cp.runs[0].timeout_s, 60);
    write_cp(&root, "03", &base.replace("timeout = 60\n", ""));
    assert!(
        checkpoint::load(&root, "03")
            .unwrap_err()
            .contains("timeout")
    );
    write_cp(&root, "03", &base.replace("= 0\n", "= 1\n"));
    assert!(
        checkpoint::load(&root, "03")
            .unwrap_err()
            .contains("exits 0")
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The hard kill reaches grandchildren, and a grandchild that keeps the output pipes open
/// cannot hang the harness (review findings: `child.kill()` hit only the direct child and the
/// pipe readers were joined without a limit).
#[test]
fn run_child_kill_reaches_the_whole_process_group() {
    use std::process::Command;
    use std::time::{Duration, Instant};
    // The child outlives its timeout and has a grandchild holding the pipes for 60 s.
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "sleep 60 & exec sleep 61"]);
    let t = Instant::now();
    let p = run::run_child(c, &[], Duration::from_secs(1), true).unwrap();
    assert!(p.killed);
    assert!(
        t.elapsed() < run::HARD_KILL_GRACE + Duration::from_secs(8),
        "{:?}",
        t.elapsed()
    );
    // The child exits at once, but leaves a grandchild holding stdout for 60 s.
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "echo hi; sleep 60 &"]);
    let t = Instant::now();
    let p = run::run_child(c, &[], Duration::from_secs(30), true).unwrap();
    assert!(!p.killed);
    assert_eq!(p.code, Some(0));
    assert!(p.stdout.contains("hi"));
    assert!(
        t.elapsed() < run::PIPE_GRACE * 3 + Duration::from_secs(3),
        "{:?}",
        t.elapsed()
    );
    // An ordinary child is untouched by all this.
    let mut c = Command::new("/bin/sh");
    c.args(["-c", "echo out; echo err >&2; exit 3"]);
    let p = run::run_child(c, &[], Duration::from_secs(30), true).unwrap();
    assert_eq!((p.code, p.killed, p.pipes_held), (Some(3), false, false));
    assert_eq!((p.stdout.as_str(), p.stderr.as_str()), ("out\n", "err\n"));
}

#[test]
fn oversized_or_symlinked_definition_is_refused() {
    let root = scratch("big-defs");
    let d = write_cp(
        &root,
        "05",
        &format!("id = \"05\"\n#{}\n", "x".repeat(toml_lite::MAX_INPUT)),
    );
    assert!(checkpoint::load(&root, "05").unwrap_err().contains("cap"));
    std::fs::remove_file(d.join("checkpoint.toml")).unwrap();
    std::fs::write(root.join("real.toml"), "id = \"05\"\n").unwrap();
    std::os::unix::fs::symlink(root.join("real.toml"), d.join("checkpoint.toml")).unwrap();
    assert!(
        checkpoint::load(&root, "05").is_err(),
        "symlinked checkpoint.toml"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn arguments() {
    let r = repo();
    let s = |v: &[&str]| v.iter().map(|x| (*x).to_owned()).collect::<Vec<_>>();
    assert!(checkpoint::parse_args(&r, &s(&["07", "--ref"])).is_ok());
    assert_eq!(
        checkpoint::parse_args(&r, &s(&["all", "--ref"]))
            .unwrap()
            .ids
            .len(),
        checkpoint::all_ids(&r).len()
    );
    assert!(checkpoint::parse_args(&r, &s(&["07", "--ref", "--impl", "x"])).is_err());
    assert!(checkpoint::parse_args(&r, &s(&["7"])).is_err());
    assert!(checkpoint::parse_args(&r, &s(&["07", "--upload"])).is_err());
    assert!(checkpoint::parse_args(&r, &s(&["07", "--impl", "x", "--capture"])).is_err());
    // No target means `./learner` when it exists: captures need an explicit --ref.
    assert!(checkpoint::parse_args(&r, &s(&["07", "--capture"])).is_err());
    assert!(checkpoint::parse_args(&r, &s(&["07", "--ref", "--capture"])).is_ok());
    assert!(checkpoint::parse_args(&r, &s(&[])).is_err());
}

// --- toml_lite caps (PLAN M27 security test) ---------------------------------------------------

#[test]
fn toml_lite_parses_the_supported_subset() {
    let d = toml_lite::parse(
        "# c\nid = \"07\" # trailing\nn = -1_000\nb = true\nlit = 'C:\\x'\nesc = \"a\\tb\\u0001\"\n\
         arr = [\n  \"x\",\n  \"y\", # c\n]\n[contract]\ntests = []\n[[run]]\nname = \"a\"\n[[run]]\nname = \"b\"\n",
    )
    .unwrap();
    assert_eq!(d.root.str("id").unwrap(), Some("07"));
    assert_eq!(d.root.int("n").unwrap(), Some(-1000));
    assert_eq!(d.root.bool("b").unwrap(), Some(true));
    assert_eq!(d.root.str("lit").unwrap(), Some("C:\\x"));
    assert_eq!(d.root.str("esc").unwrap(), Some("a\tb\u{1}"));
    assert_eq!(d.root.strs("arr").unwrap().unwrap(), ["x", "y"]);
    assert_eq!(d.arrays["run"].len(), 2);
    // Quoting round-trips through the parser.
    let q = toml_lite::quote("a\"b\\c\n\u{1}");
    let back = toml_lite::parse(&format!("k = {q}\n")).unwrap();
    assert_eq!(back.root.str("k").unwrap(), Some("a\"b\\c\n\u{1}"));
}

#[test]
fn toml_lite_refuses_everything_outside_the_subset() {
    let refused = [
        ("unterminated string", "a = \"abc\n"),
        ("unterminated literal", "a = 'abc\n"),
        ("duplicate key", "a = 1\na = 2\n"),
        ("table redefined", "[t]\n[t]\n"),
        ("table and array of tables", "[t]\n[[t]]\n"),
        ("root key then table", "t = 1\n[t]\n"),
        ("inline table", "a = { b = 1 }\n"),
        ("nested array", "a = [[\"x\"]]\n"),
        ("array of integers", "a = [1, 2]\n"),
        ("dotted key", "a.b = 1\n"),
        ("dotted table", "[a.b]\n"),
        ("quoted key", "\"a\" = 1\n"),
        ("float", "a = 1.5\n"),
        ("date", "a = 2026-11-19\n"),
        ("multi-line string", "a = \"\"\"x\"\"\"\n"),
        ("control character", "a = \"x\u{7}y\"\n"),
        ("bad escape", "a = \"\\q\"\n"),
        ("integer overflow", "a = 9223372036854775808\n"),
        ("missing value", "a =\n"),
        ("unterminated array", "a = [\"x\",\n"),
        ("garbage after value", "a = 1 2\n"),
    ];
    for (what, text) in refused {
        assert!(
            toml_lite::parse(text).is_err(),
            "{what} was accepted: {text:?}"
        );
    }
}

#[test]
fn toml_lite_caps_input_at_64_kib() {
    let mut s = String::from("a = 1\n");
    while s.len() <= toml_lite::MAX_INPUT {
        s.push_str("# padding padding padding padding padding padding padding\n");
    }
    let e = toml_lite::parse(&s).unwrap_err();
    assert!(e.to_string().contains("max 65536"), "{e}");
    // Exactly at the cap is fine.
    let mut ok = String::from("a = 1\n");
    ok.push_str(&"#".repeat(toml_lite::MAX_INPUT - ok.len()));
    assert!(toml_lite::parse(&ok).is_ok());
}

// --- json_lite caps (PLAN M27 security test) ---------------------------------------------------

#[test]
fn json_lite_parses_every_captured_trace_line() {
    let dir = repo().join("course/captures");
    let mut lines = 0usize;
    for e in std::fs::read_dir(&dir).unwrap().filter_map(Result::ok) {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let text = run::read_trace(&p).unwrap();
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            let v =
                json_lite::parse_line(l).unwrap_or_else(|e| panic!("{}: {e}: {l}", p.display()));
            assert!(v.get_str("reason").is_some(), "{l}");
            lines += 1;
        }
    }
    assert!(
        lines >= 100,
        "only {lines} captured trace lines (run scripts/capture.sh all)"
    );
    // TRACE.md's own example.
    let ex = r#"{"t_ns":1234,"vcpu":0,"reason":"exception","ec":"0x24","pc":"0x40080010","ipa":"0x9000000","wnr":true,"size":4,"reg":2,"value":"0x48","action":"mmio"}"#;
    assert_eq!(
        json_lite::parse_line(ex).unwrap().get_str("action"),
        Some("mmio")
    );
}

#[test]
fn json_lite_refuses_long_lines_deep_nesting_and_bad_json() {
    let long = format!("{{\"a\":\"{}\"}}", "x".repeat(json_lite::MAX_LINE));
    assert!(json_lite::parse_line(&long).is_err(), "line over 64 KiB");
    assert!(json_lite::parse_line("[[[[1]]]]").is_ok(), "depth 4");
    assert!(json_lite::parse_line("[[[[[1]]]]]").is_err(), "depth 5");
    assert!(
        json_lite::parse_line(r#"{"a":{"b":{"c":{"d":{}}}}}"#).is_err(),
        "depth 5"
    );
    let deep = format!("{}{}", "[".repeat(100_000), "]".repeat(100_000));
    assert!(json_lite::parse_line(&deep).is_err(), "no stack overflow");
    for bad in [
        "",
        "{",
        "{\"a\":1,}",
        "{\"a\":1}{}",
        "{\"a\" 1}",
        "[01]",
        "[1.]",
        "\"\\x\"",
        "\"\u{1}\"",
        "{\"a\":1,\"a\":2}",
        "nul",
        "\"\\ud800\"",
        "{\"a\":tru}",
        "[1,]",
    ] {
        assert!(json_lite::parse_line(bad).is_err(), "{bad:?} was accepted");
    }
    for good in [
        "null",
        "true",
        "-0.5e+3",
        "\"\\u00e9\"",
        "{}",
        "[]",
        " {\"a\" : [1, \"b\"]} ",
    ] {
        assert!(json_lite::parse_line(good).is_ok(), "{good:?} was refused");
    }
}

#[test]
fn trace_reader_refuses_non_json_and_symlinks() {
    let d = scratch("trace");
    std::fs::write(d.join("t.jsonl"), "{\"reason\":\"exception\"}\nnot json\n").unwrap();
    assert!(
        run::read_trace(&d.join("t.jsonl"))
            .unwrap_err()
            .contains("line 2")
    );
    std::fs::write(d.join("ok.jsonl"), "{\"reason\":\"exception\"}\n").unwrap();
    std::os::unix::fs::symlink(d.join("ok.jsonl"), d.join("link.jsonl")).unwrap();
    assert!(run::read_trace(&d.join("link.jsonl")).is_err());
    assert!(run::read_trace(&d.join("missing.jsonl")).is_err());
    let _ = std::fs::remove_dir_all(&d);
}

// --- L3 journal and the report shapes (CURRICULUM §3.3) ---------------------------------------

#[test]
fn journal_needs_every_answer_and_the_predict_guess() {
    let t = "# J\n## Predict\n> prompt\n<!-- hint -->\nerror\n## Q1\n> q\nanswer\n## Q2\n> q\n";
    let c = run::check_journal(t, 2, true);
    assert_eq!((c.answered, c.predict), (1, Some(true)));
    let c = run::check_journal("## Q1\na\n## Q2\nb\n", 2, true);
    assert_eq!((c.answered, c.predict), (2, Some(false)));
    // The unedited template answers nothing.
    let template = std::fs::read_to_string(repo().join("course/journal/04.md")).unwrap();
    let c = run::check_journal(&template, 5, true);
    assert_eq!((c.answered, c.predict), (0, Some(false)));
}

#[test]
fn report_lines_have_the_curriculum_shape() {
    use report::Status;
    assert_eq!(
        report::level_line(
            Status::Pass,
            "L1 contract",
            "esr_decode (40 tests), mmio_decode (12 tests)"
        ),
        "[PASS] L1 contract  esr_decode (40 tests), mmio_decode (12 tests)"
    );
    assert_eq!(
        report::level_line(Status::Pass, "L2 run", "mmio-probe: 3/3 serial markers"),
        "[PASS] L2 run       mmio-probe: 3/3 serial markers"
    );
    assert_eq!(
        report::level_line(Status::Info, "L3 journal", "4/4 answered"),
        "[INFO] L3 journal   4/4 answered"
    );
    assert_eq!(report::verdict("07", true, &[]), "CHECKPOINT 07 PASS");
    assert_eq!(
        report::verdict("07", true, &["vcpu::mmio".into()]),
        "CHECKPOINT 07 PASS (borrowed: vcpu::mmio)"
    );
    assert_eq!(report::summary(13, 13), "CHECKPOINTS: 13/13 PASS");
    // Output of the code under test is echoed with its control characters made visible.
    assert!(!report::sanitize("\u{1b}]0;pwned\u{7}").contains('\u{1b}'));
}

#[test]
fn checkpoint_paths_stay_inside() {
    for bad in [
        "", "/x", "../x", "a/../b", "a//b", "./a", "a/.", "a b", "a\\b", "é",
    ] {
        assert!(!checkpoint::safe_rel(bad), "{bad:?}");
    }
    for good in ["expected/x.txt", "contract/data/v.json", "a-b_c.d"] {
        assert!(checkpoint::safe_rel(good), "{good:?}");
    }
}
