//! Host tests of learner mode (PLAN M27 "Acceptance: host" and the security test
//! `learner_never_overwrites`): `start` never overwrites, every path stays inside `learner/`
//! (no `..`, no symlink escape), a lifeline round-trips the learner's files byte for byte, and
//! `gen-scaffold` turns `LEARNER` regions into stubs with a golden output. Each test builds a
//! small fake course repository in a temporary directory; nothing touches the real tree.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use xtask::learner::{self, Progress, init, lifeline, scaffold, start};

/// A fresh scratch directory for one test.
fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("xtask-learner-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn write(p: &Path, text: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// A fake course repository: the empty template, a chapter-04 scaffold, a journal template
/// and a two-file reference `memory` module.
fn fake_repo(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    write(
        &repo.join("course/scaffolds/00/Cargo.toml"),
        "[workspace]\nmembers = []\n",
    );
    write(&repo.join("course/scaffolds/00/.gitignore"), "/target\n");
    write(
        &repo.join("course/scaffolds/04/files/crates/vmm/src/memory/address.rs"),
        "// scaffold address\n",
    );
    write(
        &repo.join("course/scaffolds/04/files/crates/vmm/src/lib.rs"),
        "pub mod memory;\n",
    );
    write(
        &repo.join("course/journal/04.md"),
        "# Journal 04\n## Q1\n> q\n",
    );
    write(
        &repo.join("crates/vmm/src/memory/address.rs"),
        "// reference address\n",
    );
    write(
        &repo.join("crates/vmm/src/memory/region.rs"),
        "// reference region\n",
    );
    write(
        &repo.join("crates/vmm/src/virtio/queue.rs"),
        "// reference queue\n",
    );
    repo
}

/// `learner init` (without the build) in `root/learner`.
fn fresh_learner(root: &Path, repo: &Path) -> PathBuf {
    let l = root.join("learner");
    assert_eq!(init::init_with(repo, &l, false).unwrap(), "learner: ready");
    l
}

#[test]
fn init_creates_a_git_workspace_and_refuses_to_reinit() {
    let root = scratch("init");
    let repo = fake_repo(&root);
    let l = fresh_learner(&root, &repo);
    assert!(l.join(".git").is_dir(), "the learner's own repository");
    assert!(l.join("Cargo.toml").is_file());
    assert_eq!(
        Progress::load(&l.join(".progress.toml")).unwrap().started,
        ["00"]
    );
    // Never overwrites: a second init, or an init over a file or a symlink, changes nothing.
    fs::write(l.join("Cargo.toml"), "mine\n").unwrap();
    assert!(init::init_with(&repo, &l, false).is_err());
    assert_eq!(fs::read_to_string(l.join("Cargo.toml")).unwrap(), "mine\n");
    std::os::unix::fs::symlink(&repo, root.join("link")).unwrap();
    assert!(init::init_with(&repo, &root.join("link"), false).is_err());
    let _ = fs::remove_dir_all(&root);
}

/// PLAN M27 security test `learner_never_overwrites`.
#[test]
fn learner_never_overwrites() {
    let root = scratch("never-overwrites");
    let repo = fake_repo(&root);
    let l = fresh_learner(&root, &repo);
    // The learner already wrote their own lib.rs.
    write(
        &l.join("crates/vmm/src/lib.rs"),
        "// my lib\npub mod memory;\npub mod arch;\n",
    );
    let r = start::start(&repo, &l, "04", "worked").unwrap();
    assert_eq!((r.copied, r.present), (2, 0), "address.rs and the journal");
    assert_eq!(r.conflicts.len(), 1);
    assert_eq!(r.conflicts[0].0, "crates/vmm/src/lib.rs");
    // Theirs is untouched; the scaffold's version sits next to it.
    assert_eq!(
        fs::read_to_string(l.join("crates/vmm/src/lib.rs")).unwrap(),
        "// my lib\npub mod memory;\npub mod arch;\n"
    );
    assert_eq!(
        fs::read_to_string(l.join("crates/vmm/src/lib.rs.scaffold")).unwrap(),
        "pub mod memory;\n"
    );
    // A learner edit to a copied file survives a second start, which copies nothing.
    write(
        &l.join("crates/vmm/src/memory/address.rs"),
        "// my address\n",
    );
    let again = start::start(&repo, &l, "04", "worked").unwrap();
    assert_eq!(again.copied, 0);
    assert_eq!(
        fs::read_to_string(l.join("crates/vmm/src/memory/address.rs")).unwrap(),
        "// my address\n"
    );
    let p = Progress::load(&l.join(".progress.toml")).unwrap();
    assert!(p.started.contains(&"04".to_owned()));
    assert_eq!(p.levels, [("04".to_owned(), "worked".to_owned())]);

    // Paths outside the workspace are refused before anything is written.
    for bad in [
        "../../etc/x",
        "/etc/x",
        "a/../../x",
        "..",
        "vmm::../x",
        "Memory",
        "a-b",
    ] {
        assert!(
            lifeline::borrow(&repo, &l, bad).is_err(),
            "lifeline {bad:?} was accepted"
        );
    }
    for bad in ["../x", "/abs", "a/./b", "a//b", ""] {
        assert!(learner::safe_dest(&l, bad).is_err(), "safe_dest {bad:?}");
    }

    // A symlinked target is refused: the learner's memory/ directory points outside.
    let outside = root.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::remove_dir_all(l.join("crates/vmm/src/memory")).unwrap();
    std::os::unix::fs::symlink(&outside, l.join("crates/vmm/src/memory")).unwrap();
    let e = lifeline::borrow(&repo, &l, "memory").unwrap_err();
    assert!(e.contains("symlink"), "{e}");
    assert!(
        fs::read_dir(&outside).unwrap().next().is_none(),
        "nothing written outside"
    );
    assert!(
        start::start(&repo, &l, "04", "worked").is_err(),
        "start through the link"
    );
    assert!(
        fs::read_dir(&outside).unwrap().next().is_none(),
        "nothing written outside"
    );
    // A symlinked file is refused too (neither followed nor replaced).
    fs::remove_file(l.join("crates/vmm/src/memory")).unwrap();
    fs::create_dir_all(l.join("crates/vmm/src/virtio")).unwrap();
    fs::write(outside.join("target.rs"), "outside\n").unwrap();
    std::os::unix::fs::symlink(
        outside.join("target.rs"),
        l.join("crates/vmm/src/virtio/queue.rs"),
    )
    .unwrap();
    assert!(lifeline::borrow(&repo, &l, "vmm::virtio::queue").is_err());
    assert_eq!(
        fs::read_to_string(outside.join("target.rs")).unwrap(),
        "outside\n"
    );
    assert!(
        Progress::load(&l.join(".progress.toml"))
            .unwrap()
            .borrowed
            .is_empty()
    );
    // A symlink planted at the progress file's temporary name is never written through, and
    // `.progress.toml` does not become a link (review finding: `fs::write` followed it).
    let progress = l.join(".progress.toml");
    let before = fs::read_to_string(&progress).unwrap();
    std::os::unix::fs::symlink(outside.join("target.rs"), l.join(".progress.toml.tmp")).unwrap();
    let mut p = Progress::load(&progress).unwrap();
    p.passed.push("04".into());
    let e = p.save(&progress).unwrap_err();
    assert!(e.contains("not a regular file"), "{e}");
    assert_eq!(
        fs::read_to_string(outside.join("target.rs")).unwrap(),
        "outside\n"
    );
    assert!(
        !fs::symlink_metadata(&progress)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&progress).unwrap(), before);
    // A stale regular temporary file (a crash mid-save) is replaced, and the save lands.
    fs::remove_file(l.join(".progress.toml.tmp")).unwrap();
    fs::write(l.join(".progress.toml.tmp"), "stale\n").unwrap();
    p.save(&progress).unwrap();
    assert!(
        Progress::load(&progress)
            .unwrap()
            .passed
            .contains(&"04".to_owned())
    );
    assert!(!l.join(".progress.toml.tmp").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn lifeline_borrow_then_return_round_trips_byte_exactly() {
    let root = scratch("lifeline");
    let repo = fake_repo(&root);
    let l = fresh_learner(&root, &repo);
    let mine: &[u8] = b"// my address\n\xff\x00 not even UTF-8\n";
    fs::create_dir_all(l.join("crates/vmm/src/memory")).unwrap();
    fs::write(l.join("crates/vmm/src/memory/address.rs"), mine).unwrap();
    // region.rs does not exist in the learner's tree yet: the lifeline creates it.
    let out = lifeline::borrow(&repo, &l, "memory").unwrap();
    assert!(out[0].contains("copied 2 reference file(s)"), "{out:?}");
    assert_eq!(
        fs::read_to_string(l.join("crates/vmm/src/memory/address.rs")).unwrap(),
        "// reference address\n"
    );
    assert_eq!(
        fs::read(l.join("crates/vmm/src/memory/address.rs.mine")).unwrap(),
        mine
    );
    let p = Progress::load(&l.join(".progress.toml")).unwrap();
    assert_eq!(p.borrowed, ["memory"]);
    assert_eq!(p.lifeline_created, ["crates/vmm/src/memory/region.rs"]);
    // Borrowing twice is refused and changes nothing.
    assert!(lifeline::borrow(&repo, &l, "memory").is_err());
    lifeline::give_back(&repo, &l, "memory").unwrap();
    assert_eq!(
        fs::read(l.join("crates/vmm/src/memory/address.rs")).unwrap(),
        mine
    );
    assert!(!l.join("crates/vmm/src/memory/address.rs.mine").exists());
    assert!(
        !l.join("crates/vmm/src/memory/region.rs").exists(),
        "created file removed"
    );
    let p = Progress::load(&l.join(".progress.toml")).unwrap();
    assert!(p.borrowed.is_empty() && p.lifeline_created.is_empty());
    assert!(
        lifeline::give_back(&repo, &l, "memory").is_err(),
        "not borrowed"
    );
    // Fully qualified names name the same module.
    lifeline::borrow(&repo, &l, "vmm::virtio::queue").unwrap();
    assert_eq!(
        Progress::load(&l.join(".progress.toml")).unwrap().borrowed,
        ["virtio::queue"]
    );
    lifeline::give_back(&repo, &l, "virtio::queue").unwrap();
    // A module the reference does not have is an error.
    assert!(lifeline::borrow(&repo, &l, "nope").is_err());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn lifeline_makes_cargo_see_the_change() {
    // fs::copy keeps the source's (older) mtime; the lifeline must not, or cargo keeps the
    // learner's stale build (found on the machine in M27).
    let root = scratch("lifeline-mtime");
    let repo = fake_repo(&root);
    let l = fresh_learner(&root, &repo);
    let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    fs::File::options()
        .write(true)
        .open(repo.join("crates/vmm/src/memory/address.rs"))
        .unwrap()
        .set_modified(old)
        .unwrap();
    let before = std::time::SystemTime::now() - std::time::Duration::from_secs(5);
    lifeline::borrow(&repo, &l, "memory").unwrap();
    let m = fs::metadata(l.join("crates/vmm/src/memory/address.rs")).unwrap();
    assert!(
        m.modified().unwrap() > before,
        "lifeline copy kept the old mtime"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn progress_file_round_trips_and_is_stable() {
    let root = scratch("progress");
    let p = Progress {
        started: vec!["00".into(), "04".into()],
        passed: vec!["00".into()],
        borrowed: vec!["virtio::queue".into()],
        lifeline_created: vec![],
        levels: vec![("04".into(), "worked".into())],
    };
    let path = root.join(".progress.toml");
    p.save(&path).unwrap();
    assert_eq!(Progress::load(&path).unwrap(), p);
    assert!(
        fs::read_to_string(&path)
            .unwrap()
            .contains("never uploaded")
    );
    // The file lands in every learner's workspace, so it must pass the learner-text lint
    // (no internal plan or milestone IDs).
    for line in fs::read_to_string(&path).unwrap().lines() {
        let probs = xtask::lessons::notation_problems(line);
        assert!(probs.is_empty(), "{line:?}: {probs:?}");
    }
    // A symlinked progress file is not written through.
    fs::remove_file(&path).unwrap();
    fs::write(root.join("elsewhere"), "x").unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), &path).unwrap();
    assert!(p.save(&path).is_err());
    assert_eq!(fs::read_to_string(root.join("elsewhere")).unwrap(), "x");
    let _ = fs::remove_dir_all(&root);
}

// --- gen-scaffold ------------------------------------------------------------------------

/// The fixtures spell `//` as `@@` so that `check-anchors`, which scans this file too, does
/// not take their markers for real ones; [`rs`] turns them back.
const TWO_HOLES: &str = "\
//! A reference file with two holes.
pub fn checked_add(a: u64, b: u64) -> Option<u64> {
    @@ ANCHOR: lesson_view
    @@ LEARNER: add_body
    a.checked_add(b)
    @@ LEARNER_END: add_body
    @@ ANCHOR_END: lesson_view
}

pub fn locate(x: u64) -> bool {
        @@ LEARNER: locate_body
        let y = x + 1;
        y > 3
        @@ LEARNER_END: locate_body
}
";

const TWO_HOLES_GOLDEN: &str = "\
//! A reference file with two holes.
pub fn checked_add(a: u64, b: u64) -> Option<u64> {
    @@ LEARNER: add_body
    todo!(\"LEARNER: add_body\")
    @@ LEARNER_END: add_body
}

pub fn locate(x: u64) -> bool {
        @@ LEARNER: locate_body
        todo!(\"LEARNER: locate_body\")
        @@ LEARNER_END: locate_body
}
";

fn rs(fixture: &str) -> String {
    fixture.replace("@@", "//")
}

#[test]
fn scaffold_golden_two_holes() {
    let got = scaffold::stub_file("a.rs", &rs(TWO_HOLES), scaffold::Stub::Rust).unwrap();
    assert_eq!(got, rs(TWO_HOLES_GOLDEN));
    assert_eq!(scaffold::holes(&rs(TWO_HOLES), scaffold::Stub::Rust), 2);
    let sh = "#!/bin/sh\nset -eu\n# LEARNER: greet\necho hi\n# LEARNER_END: greet\necho done\n";
    assert_eq!(
        scaffold::stub_file("x.sh", sh, scaffold::Stub::Shell).unwrap(),
        "#!/bin/sh\nset -eu\n# LEARNER: greet\necho \"LEARNER: greet is not written yet\" >&2; exit 1\n# LEARNER_END: greet\necho done\n"
    );
}

#[test]
fn scaffold_unbalanced_or_nested_markers_are_errors() {
    let r = scaffold::Stub::Rust;
    for (what, text) in [
        ("never closed", "// LEARNER: a\nx\n"),
        ("end without start", "x\n// LEARNER_END: a\n"),
        ("mismatched names", "// LEARNER: a\nx\n// LEARNER_END: b\n"),
        (
            "nested",
            "// LEARNER: a\n// LEARNER: b\nx\n// LEARNER_END: b\n// LEARNER_END: a\n",
        ),
        (
            "duplicate",
            "// LEARNER: a\nx\n// LEARNER_END: a\n// LEARNER: a\ny\n// LEARNER_END: a\n",
        ),
        ("bad name", "// LEARNER: a/b\nx\n// LEARNER_END: a/b\n"),
    ] {
        assert!(
            scaffold::stub_file("t.rs", text, r).is_err(),
            "{what} was accepted"
        );
    }
}

#[test]
fn scaffold_generation_writes_and_checks_files() {
    let root = scratch("gen");
    let repo = root.join("repo");
    write(&repo.join("crates/vmm/src/a.rs"), &rs(TWO_HOLES));
    write(
        &repo.join("course/scaffolds/05/manifest.toml"),
        "chapter = \"05\"\nfiles = [\"crates/vmm/src/a.rs\"]\n",
    );
    assert!(
        scaffold::generate(&repo, "05", true).is_err(),
        "stale before generation"
    );
    let out = scaffold::generate(&repo, "05", false).unwrap();
    assert!(out[0].contains("1 files with 2 holes"), "{out:?}");
    assert_eq!(
        fs::read_to_string(repo.join("course/scaffolds/05/files/crates/vmm/src/a.rs")).unwrap(),
        rs(TWO_HOLES_GOLDEN)
    );
    assert!(scaffold::generate(&repo, "05", true).is_ok());
    // A manifest naming a path outside the repository, or an unknown key, is refused.
    write(
        &repo.join("course/scaffolds/06/manifest.toml"),
        "chapter = \"06\"\nfiles = [\"../../etc/passwd\"]\n",
    );
    assert!(scaffold::generate(&repo, "06", false).is_err());
    write(
        &repo.join("course/scaffolds/07/manifest.toml"),
        "chapter = \"07\"\nfiles = []\nupload = true\n",
    );
    assert!(scaffold::generate(&repo, "07", false).is_err());
    assert!(
        scaffold::generate(&repo, "00", false).is_err(),
        "00 is hand-made"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn real_scaffolds_are_current() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = scaffold::generate(&repo, "04", true).unwrap_or_else(|e| panic!("{e}"));
    assert!(out[0].starts_with("SCAFFOLD OK: 04"), "{out:?}");
}

#[test]
fn levels_follow_the_fading_schedule() {
    assert_eq!(start::default_level("00"), "worked");
    assert_eq!(start::default_level("05"), "worked");
    assert_eq!(start::default_level("06"), "completion");
    assert_eq!(start::default_level("13"), "spec");
    assert_eq!(start::default_level("21"), "open");
    let root = scratch("levels");
    let repo = fake_repo(&root);
    let l = fresh_learner(&root, &repo);
    assert!(start::start(&repo, &l, "04", "expert").is_err());
    assert!(start::start(&repo, &l, "4", "worked").is_err());
    // `open` copies only the journal.
    let r = start::start(&repo, &l, "04", "open").unwrap();
    assert_eq!(r.copied, 1);
    assert!(!l.join("crates/vmm/src/memory/address.rs").exists());
    let _ = fs::remove_dir_all(&root);
}

/// Most chapters have no generated scaffold: `start` must copy the journal alone, at every
/// level, and say so (backlog: `start 06` used to be suspected of failing on the missing
/// `course/scaffolds/06/files`).
#[test]
fn start_without_a_scaffold_copies_only_the_journal() {
    let root = scratch("no-scaffold");
    let repo = fake_repo(&root);
    write(&repo.join("course/journal/06.md"), "# Journal 06\n");
    let l = fresh_learner(&root, &repo);
    for level in start::LEVELS {
        let r = start::start(&repo, &l, "06", level).unwrap();
        assert!(r.journal_only, "{level}");
        assert!(r.conflicts.is_empty(), "{level}");
        assert_eq!(r.copied + r.present, 1, "{level}: the journal only");
    }
    assert_eq!(
        fs::read_to_string(l.join("journal/06.md")).unwrap(),
        "# Journal 06\n"
    );
    let out = start::main(&repo, &l, &["06".to_owned()]).unwrap();
    assert!(
        out.iter().any(|s| s.contains("no scaffold files")),
        "{out:?}"
    );
    let p = Progress::load(&l.join(".progress.toml")).unwrap();
    assert!(p.started.contains(&"06".to_owned()));
    assert!(
        p.levels
            .contains(&("06".to_owned(), "completion".to_owned()))
    );
    // A scaffold directory with neither manifest nor files (only notes) is empty too.
    write(&repo.join("course/scaffolds/07/README"), "notes\n");
    write(&repo.join("course/journal/07.md"), "# Journal 07\n");
    let r = start::start(&repo, &l, "07", "completion").unwrap();
    assert_eq!((r.copied, r.journal_only), (1, true));
    // A chapter with neither scaffold nor journal copies nothing and still records the start.
    let r = start::start(&repo, &l, "09", "completion").unwrap();
    assert_eq!((r.copied, r.present, r.journal_only), (0, 0, true));
    // A scaffold with files is not journal-only.
    let r = start::start(&repo, &l, "04", "worked").unwrap();
    assert!(!r.journal_only);
    let _ = fs::remove_dir_all(&root);
}

/// A manifest without generated files is a course bug, reported, never a silent empty copy.
#[test]
fn start_with_a_manifest_but_no_files_is_a_course_bug() {
    let root = scratch("manifest-no-files");
    let repo = fake_repo(&root);
    write(
        &repo.join("course/scaffolds/08/manifest.toml"),
        "chapter = \"08\"\nfiles = []\n",
    );
    write(&repo.join("course/journal/08.md"), "# Journal 08\n");
    let l = fresh_learner(&root, &repo);
    let e = start::start(&repo, &l, "08", "completion").unwrap_err();
    assert!(e.contains("gen-scaffold 08"), "{e}");
    assert!(!l.join("journal/08.md").exists(), "nothing copied");
    // At `open` the scaffold is not consulted, so the journal still arrives.
    let r = start::start(&repo, &l, "08", "open").unwrap();
    assert_eq!(r.copied, 1);
    // `files` as a plain file (not a directory) is refused too.
    write(&repo.join("course/scaffolds/10/files"), "oops\n");
    assert!(start::start(&repo, &l, "10", "completion").is_err());
    let _ = fs::remove_dir_all(&root);
}

/// Only a *missing* scaffold means "journal only": any other error reading
/// `course/scaffolds/NN/files` (here, a permission denied) is reported with its path.
#[test]
fn start_reports_an_unreadable_scaffold() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch("unreadable-scaffold");
    let repo = fake_repo(&root);
    write(&repo.join("course/journal/12.md"), "# Journal 12\n");
    let dir = repo.join("course/scaffolds/12");
    fs::create_dir_all(dir.join("files")).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o000)).unwrap();
    let l = fresh_learner(&root, &repo);
    let res = start::start(&repo, &l, "12", "completion");
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    // Root ignores permission bits; the check is meaningful only for a normal user.
    if !is_root() {
        let e = res.unwrap_err();
        assert!(e.contains("scaffolds/12/files"), "{e}");
        assert!(!l.join("journal/12.md").exists(), "nothing copied");
    }
    let _ = fs::remove_dir_all(&root);
}

fn is_root() -> bool {
    std::process::Command::new("id")
        .arg("-u")
        .output()
        .is_ok_and(|o| o.stdout.starts_with(b"0\n"))
}

/// The count line agrees with the count.
#[test]
fn plural_agrees_with_the_count() {
    assert_eq!(start::plural(0, "file"), "0 files");
    assert_eq!(start::plural(1, "file"), "1 file");
    assert_eq!(start::plural(2, "file"), "2 files");
}

/// The real course tree: `start NN` at each chapter's default level succeeds for every
/// chapter with a journal, and copies that journal.
#[test]
fn real_course_starts_every_chapter() {
    let real = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let root = scratch("real-starts");
    let fake = fake_repo(&root);
    let l = fresh_learner(&root, &fake);
    let mut seen = 0;
    for n in 0..=27u8 {
        let id = format!("{n:02}");
        let journal = real.join("course/journal").join(format!("{id}.md"));
        if !journal.is_file() {
            continue;
        }
        let level = start::default_level(&id);
        let r = start::start(&real, &l, &id, level).unwrap_or_else(|e| panic!("start {id}: {e}"));
        assert!(r.conflicts.is_empty(), "start {id}: {:?}", r.conflicts);
        assert_eq!(
            fs::read(l.join("journal").join(format!("{id}.md"))).unwrap(),
            fs::read(&journal).unwrap(),
            "journal {id}"
        );
        seen += 1;
    }
    assert!(seen >= 26, "only {seen} chapters have journals");
    assert!(
        l.join("crates/vmm/src/memory/address.rs").is_file(),
        "04's scaffold"
    );
    let _ = fs::remove_dir_all(&root);
}
