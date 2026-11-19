//! Security tests for the M20 audit rules (`xtask::vz_audit`, threat model AS9, SIGN-1, SC-1):
//! each builds a minimal tree, plants one violation, and checks the audit catches it.

use std::path::PathBuf;
use xtask::audit::{self, Report};
use xtask::vz_audit;

struct TempTree(PathBuf);

const VZ_OK: &str = "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>com.apple.security.virtualization</key>\n\t<true/>\n</dict>\n</plist>\n";
const SCRIPT_OK: &str =
    "#!/usr/bin/env bash\nset -euo pipefail\nIFS=$'\\n\\t'\numask 077\necho ok\n";
const ALLOW: &str = "# comment\nno sudo\nnever run csrutil\n";

impl TempTree {
    fn new(tag: &str) -> TempTree {
        let dir = std::env::temp_dir().join(format!("xtask-vz-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = TempTree(dir);
        t.write("tools/vz-mac/vz-mac.entitlements", VZ_OK);
        t.write("tools/vz-mac/run.sh", SCRIPT_OK);
        t.write("docs/security/forbidden-advice.txt", ALLOW);
        t.write(
            "course/ch23.md",
            "macvmm needs no SIP change and no sudo.\nA pseudo-terminal; sudoers is a file.\n",
        );
        t
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn report(&self) -> Report {
        let mut r = Report::default();
        vz_audit::audit_tools(&self.0, &mut r).unwrap();
        r
    }
    fn rules(&self) -> Vec<&'static str> {
        self.report().findings.iter().map(|f| f.rule).collect()
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn clean_tree_passes() {
    let t = TempTree::new("clean");
    let r = t.report();
    assert!(r.findings.is_empty(), "{:?}", r.findings);
    assert!(r.files_scanned >= 3);
}

#[test]
fn forbidden_advice_is_caught_in_every_tree() {
    for (i, rel) in [
        "course/x.md",
        "docs/macos/status.md",
        "tools/vz-mac/README.md",
    ]
    .iter()
    .enumerate()
    {
        let t = TempTree::new(&format!("advice{i}"));
        t.write(
            rel,
            "First, run `sudo nvram boot-args=amfi_get_out_of_my_way=1`.\n",
        );
        let r = t.report();
        let hits: Vec<_> = r
            .findings
            .iter()
            .filter(|f| f.rule == "forbidden-advice")
            .collect();
        assert_eq!(hits.len(), 2, "{rel}: {:?}", r.findings);
        assert_eq!(hits[0].line, 1);
    }
}

#[test]
fn every_word_and_case() {
    let t = TempTree::new("words");
    t.write(
        "course/a.md",
        "Boot to recovery and type CSRUTIL disable.\nSudo make me a sandwich.\nsudo\n",
    );
    assert_eq!(
        t.rules()
            .iter()
            .filter(|r| **r == "forbidden-advice")
            .count(),
        3
    );
}

#[test]
fn allowlisted_phrase_must_cover_the_occurrence() {
    let t = TempTree::new("cover");
    // "no sudo" is allowed, but the second `sudo` on the line is outside it.
    t.write(
        "course/a.md",
        "We need no sudo here, but then run sudo make install.\n",
    );
    assert_eq!(t.rules(), vec!["forbidden-advice"]);
}

#[test]
fn word_boundaries() {
    assert_eq!(
        vz_audit::word_matches("pseudo sudoers sudo_x xsudo", "sudo"),
        vec![]
    );
    assert_eq!(vz_audit::word_matches("(sudo) `sudo`", "sudo"), vec![1, 8]);
    assert_eq!(vz_audit::word_matches("sudo", "sudo"), vec![0]);
}

#[test]
fn allowlist_cannot_whitelist_advice() {
    let t = TempTree::new("badallow");
    t.write(
        "docs/security/forbidden-advice.txt",
        "run sudo make install\nno sip change\nnever sudo\n",
    );
    t.write("course/a.md", "run sudo make install\n");
    let r = t.report();
    let bad: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.rule == "forbidden-advice-allowlist")
        .map(|f| f.line)
        .collect();
    assert_eq!(bad, vec![1, 2], "{:?}", r.findings); // advice; names no forbidden word
    assert!(r.findings.iter().any(|f| f.rule == "forbidden-advice"));
}

#[test]
fn vz_entitlements_exact() {
    let extra = VZ_OK.replace(
        "</dict>",
        "\t<key>com.apple.security.hypervisor</key>\n\t<true/>\n</dict>",
    );
    let private = VZ_OK.replace(
        "</dict>",
        "\t<key>com.apple.private.virtualization</key>\n\t<true/>\n</dict>",
    );
    let falsy = VZ_OK.replace("<true/>", "<false/>");
    let missing = "<plist><dict></dict></plist>";
    let twice = VZ_OK.replace(
        "</dict>",
        "\t<key>com.apple.security.virtualization</key>\n\t<true/>\n</dict>",
    );
    for (i, bad) in [extra, private, falsy, missing.to_owned(), twice]
        .iter()
        .enumerate()
    {
        let t = TempTree::new(&format!("ent{i}"));
        t.write("tools/vz-mac/vz-mac.entitlements", bad);
        assert!(t.rules().contains(&"vz-entitlements"), "case {i}");
    }
    // A key hidden in an XML comment does not count.
    let t = TempTree::new("entcomment");
    t.write(
        "tools/vz-mac/vz-mac.entitlements",
        &VZ_OK.replace(
            "<dict>",
            "<dict><!-- <key>com.apple.vm.networking</key><true/> -->",
        ),
    );
    assert!(t.rules().is_empty());
}

#[test]
fn vz_entitlements_file_required() {
    let t = TempTree::new("noent");
    std::fs::remove_file(t.0.join("tools/vz-mac/vz-mac.entitlements")).unwrap();
    assert_eq!(t.rules(), vec!["vz-entitlements"]);
}

#[test]
fn tool_scripts_follow_sc1() {
    for (i, (text, n)) in [
        ("#!/bin/sh\necho\n", 1),
        ("#!/usr/bin/env bash\necho\n", 3),
        (
            "#!/usr/bin/env bash\nset -euo pipefail\n# umask 077 in a comment does not count\n",
            2,
        ),
    ]
    .iter()
    .enumerate()
    {
        let t = TempTree::new(&format!("sc1-{i}"));
        t.write("tools/vz-mac/test.sh", text);
        let r = t.rules();
        assert_eq!(
            r.iter().filter(|x| **x == "sc1-preamble").count(),
            *n,
            "case {i}: {r:?}"
        );
    }
}

#[test]
fn apple_binaries_refused() {
    for (i, rel) in [
        "tools/vz-mac/UniversalMac_27.2_Restore.ipsw",
        "docs/macos/AVPBooter.vmapple2.bin",
        "course/site/src/assets/x.IPSW",
    ]
    .iter()
    .enumerate()
    {
        let t = TempTree::new(&format!("apple{i}"));
        t.write(rel, "x");
        assert!(t.rules().contains(&"no-apple-binaries"), "{rel}");
    }
}

#[test]
fn build_output_is_skipped() {
    let t = TempTree::new("skip");
    t.write("tools/vz-mac/.build/debug/notes.txt", "run sudo\n");
    t.write("course/site/node_modules/x/README.md", "run sudo\n");
    assert!(t.rules().is_empty());
}

#[test]
fn full_audit_includes_the_m20_rules() {
    // `audit::audit` (what scripts/check-unsafe runs) calls `vz_audit::audit_tools`.
    let t = TempTree::new("full");
    t.write("course/a.md", "sudo it\n");
    let rules: Vec<_> = audit::audit(&t.0)
        .unwrap()
        .findings
        .iter()
        .map(|f| f.rule)
        .collect();
    assert!(rules.contains(&"forbidden-advice"), "{rules:?}");
}

// ---- Review fixes (M20 round 2): the allow-list grammar, phrase word boundaries, and the
// walk failing closed on non-UTF-8 files, symlinks and directories merely named `dist`.

fn count(r: &Report, rule: &str) -> usize {
    r.findings.iter().filter(|f| f.rule == rule).count()
}

#[test]
fn allowlist_rejects_advice_that_contains_a_negation() {
    for (i, phrase) in [
        "if it does not boot, run sudo csrutil disable",
        "run csrutil disable, no questions asked",
        "never mind, sudo",
        "no sudo csrutil",
        "sudo no",
        "not sudo please",
        "never run run run run run sudo",
    ]
    .iter()
    .enumerate()
    {
        let t = TempTree::new(&format!("negadvice{i}"));
        t.write("docs/security/forbidden-advice.txt", &format!("{phrase}\n"));
        t.write("course/ch23.md", &format!("In recovery, {phrase}.\n"));
        let r = t.report();
        assert_eq!(
            count(&r, "forbidden-advice-allowlist"),
            1,
            "{phrase}: {:?}",
            r.findings
        );
        assert!(
            count(&r, "forbidden-advice") >= 1,
            "{phrase}: {:?}",
            r.findings
        );
    }
}

#[test]
fn forbidding_phrase_grammar() {
    for ok in [
        "no sudo",
        "no `sudo`",
        "never asks you to run csrutil",
        "without sudo",
        "doesn't need sudo",
        "never amfi_get_out_of_my_way",
    ] {
        assert!(vz_audit::is_forbidding_phrase(ok), "{ok}");
    }
    for bad in [
        "sudo",
        "no",
        "please no sudo",
        "no sudo here",
        "no, sudo",
        "no sip change",
        "no sudo\u{a0}",
    ] {
        assert!(!vz_audit::is_forbidding_phrase(bad), "{bad}");
    }
}

#[test]
fn repo_allowlist_is_well_formed() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let text = std::fs::read_to_string(root.join(vz_audit::ALLOWLIST)).unwrap();
    let mut r = Report::default();
    let phrases = vz_audit::parse_allowlist(&text, &mut r);
    assert!(r.findings.is_empty(), "{:?}", r.findings);
    assert!(!phrases.is_empty());
}

#[test]
fn phrases_match_on_word_boundaries() {
    let t = TempTree::new("pianosudo");
    // ALLOW holds "no sudo" and "never run csrutil".
    t.write(
        "docs/security/forbidden-advice.txt",
        "no sudo\nno csrutil\nnever run csrutil\n",
    );
    t.write(
        "course/ch24.md",
        "In recovery, type: piano sudo\nthen: casino sudo\nnever run csrutilx csrutil\n",
    );
    let r = t.report();
    let lines: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.rule == "forbidden-advice")
        .map(|f| f.line)
        .collect();
    assert_eq!(lines, vec![1, 2, 3], "{:?}", r.findings);
    // The phrase still covers its own occurrence.
    let t = TempTree::new("nosudook");
    t.write("course/ch24.md", "This needs no sudo. (No sudo!)\n");
    assert!(t.rules().is_empty(), "{:?}", t.report().findings);
}

#[test]
fn non_utf8_file_is_still_scanned() {
    let t = TempTree::new("latin1");
    let mut bytes = b"Caf\xe9\nsudo nvram boot-args=amfi_get_out_of_my_way=1\n".to_vec();
    bytes.extend_from_slice(b"\xff\xfe run sudo csrutil disable\n");
    std::fs::write(t.0.join("course/ch23.md"), bytes).unwrap();
    let r = t.report();
    assert_eq!(count(&r, "forbidden-advice"), 4, "{:?}", r.findings);
}

#[cfg(unix)]
#[test]
fn symlinks_are_findings() {
    let t = TempTree::new("links");
    t.write("spikes/advice.md", "run sudo csrutil disable\n");
    std::os::unix::fs::symlink("../spikes/advice.md", t.0.join("course/ch23-link.md")).unwrap();
    std::fs::create_dir_all(t.0.join("docs")).unwrap();
    std::os::unix::fs::symlink(
        "/System/Library/Frameworks/Virtualization.framework",
        t.0.join("docs/AVPBooter.vmapple2.bin"),
    )
    .unwrap();
    std::os::unix::fs::symlink("../../spikes", t.0.join("tools/vz-mac/spikes")).unwrap();
    let r = t.report();
    let mut links: Vec<_> = r
        .findings
        .iter()
        .filter(|f| f.rule == "no-symlink")
        .map(|f| f.path.as_str())
        .collect();
    links.sort();
    assert_eq!(
        links,
        vec![
            "course/ch23-link.md",
            "docs/AVPBooter.vmapple2.bin",
            "tools/vz-mac/spikes"
        ],
        "{:?}",
        r.findings
    );
}

#[cfg(unix)]
#[test]
fn symlinked_top_level_tree_is_a_finding() {
    let t = TempTree::new("toplink");
    std::fs::remove_dir_all(t.0.join("course")).unwrap();
    t.write("elsewhere/a.md", "sudo\n");
    std::os::unix::fs::symlink("elsewhere", t.0.join("course")).unwrap();
    assert!(
        t.rules().contains(&"no-symlink"),
        "{:?}",
        t.report().findings
    );
}

#[test]
fn only_exact_build_output_paths_are_skipped() {
    for (i, rel) in [
        "course/23/dist/steps.md",
        "course/target/x.md",
        "docs/macos/node_modules/x.md",
        "tools/vz-mac/Sources/.build/x.md",
        "tools/other/.build/x.md",
    ]
    .iter()
    .enumerate()
    {
        let t = TempTree::new(&format!("noskip{i}"));
        t.write(rel, "sudo csrutil disable\n");
        let r = t.report();
        assert_eq!(count(&r, "forbidden-advice"), 2, "{rel}: {:?}", r.findings);
    }
    let t = TempTree::new("skipexact");
    t.write("course/site/dist/x.html", "sudo\n");
    t.write("tools/vz-mac/.swiftpm/x", "sudo\n");
    assert!(t.rules().is_empty(), "{:?}", t.report().findings);
}

#[test]
fn avpbooter_check_ignores_case() {
    for (i, rel) in ["docs/avpbooter.vmapple2.bin", "course/AvpBooter.bin"]
        .iter()
        .enumerate()
    {
        let t = TempTree::new(&format!("avpcase{i}"));
        t.write(rel, "x");
        assert!(t.rules().contains(&"no-apple-binaries"), "{rel}");
    }
}
