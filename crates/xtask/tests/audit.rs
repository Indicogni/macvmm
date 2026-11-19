//! Security tests for `cargo xtask audit` (PLAN M0): each builds a minimal clean tree, plants one
//! violation, and checks the audit catches it.

use std::path::PathBuf;
use xtask::audit;

struct TempTree(PathBuf);

impl TempTree {
    /// A clean tree: a plist with only the hypervisor key, a vmm crate, an empty allowlist.
    fn clean(tag: &str) -> TempTree {
        let dir = std::env::temp_dir().join(format!("xtask-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = TempTree(dir);
        t.write("entitlements.plist", PLIST_OK);
        t.write(
            "docs/dependencies.md",
            "# deps\n<!-- allowlist:begin -->\n```\n```\n<!-- allowlist:end -->\n",
        );
        t.write("Cargo.toml", "[workspace]\nmembers = [\"crates/vmm\"]\n");
        t.write(
            "crates/vmm/Cargo.toml",
            "[package]\nname = \"vmm\"\n[dependencies]\nhvf = { path = \"../hvf\" }\n",
        );
        t.write("crates/vmm/src/lib.rs", "//! Docs mention `unsafe` and println!(\"x\").\n#![deny(unsafe_code)]\npub fn f() {}\n");
        t.write(
            "crates/hvf/src/lib.rs",
            "pub fn g() {\n    // SAFETY: test\n    unsafe { h() }\n}\n",
        );
        t
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn rules(&self) -> Vec<&'static str> {
        audit::audit(&self.0)
            .unwrap()
            .findings
            .iter()
            .map(|f| f.rule)
            .collect()
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PLIST_OK: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>com.apple.security.hypervisor</key>\n\t<true/>\n</dict>\n</plist>\n";

#[test]
fn clean_tree_passes() {
    let t = TempTree::clean("clean");
    let report = audit::audit(&t.0).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    assert!(audit::audit_deps(&t.0).unwrap().findings.is_empty());
}

#[test]
fn audit_rejects_extra_entitlement() {
    let t = TempTree::clean("jit");
    t.write(
        "entitlements.plist",
        &PLIST_OK.replace(
            "</dict>",
            "\t<key>com.apple.security.cs.allow-jit</key>\n\t<true/>\n</dict>",
        ),
    );
    assert_eq!(t.rules(), vec!["entitlements"]);
}

#[test]
fn audit_rejects_missing_or_false_hypervisor_key() {
    let t = TempTree::clean("nokey");
    t.write(
        "entitlements.plist",
        &PLIST_OK.replace("<true/>", "<false/>"),
    );
    assert_eq!(t.rules(), vec!["entitlements"]);
    t.write("entitlements.plist", "<plist><dict></dict></plist>");
    assert_eq!(t.rules(), vec!["entitlements"]);
}

#[test]
fn println_in_vmm_fails() {
    let t = TempTree::clean("println");
    t.write(
        "crates/vmm/src/bus.rs",
        "pub fn f() {\n    println!(\"guest said hi\");\n}\n",
    );
    assert_eq!(t.rules(), vec!["no-print"]);
}

#[test]
fn unlisted_dependency_fails_and_listed_one_passes() {
    let t = TempTree::clean("deps");
    t.write(
        "crates/vmm/Cargo.toml",
        "[package]\nname = \"vmm\"\n[dependencies]\nserde = \"1\"\n",
    );
    assert_eq!(t.rules(), vec!["deps-allowlist"]);
    t.write(
        "docs/dependencies.md",
        "<!-- allowlist:begin -->\nserde  # test only\n<!-- allowlist:end -->\n",
    );
    assert!(t.rules().is_empty());
}

#[test]
fn lockfile_third_party_package_must_be_allowlisted() {
    let t = TempTree::clean("lock");
    t.write(
        "Cargo.lock",
        "version = 4\n\n[[package]]\nname = \"vmm\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"itoa\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"00\"\n",
    );
    let findings = audit::audit_deps(&t.0).unwrap().findings;
    assert_eq!(findings.len(), 1);
    assert!(findings[0].message.contains("itoa"));
}

#[test]
fn unsafe_outside_quarantine_and_missing_safety_fail() {
    let t = TempTree::clean("unsafe");
    t.write("crates/vmm/src/bus.rs", "pub fn f() { unsafe { g() } }\n");
    t.write(
        "crates/hvf/src/vm.rs",
        "pub fn f() {\n    let a = 1;\n    unsafe { g(a) }\n}\n",
    );
    let mut rules = t.rules();
    rules.sort();
    assert_eq!(rules, vec!["safety-comment", "unsafe-quarantine"]);
}

#[test]
fn layout_literal_outside_layout_fails() {
    let t = TempTree::clean("literal");
    t.write(
        "crates/vmm/src/devices/pl011.rs",
        "pub const BASE: u64 = 0x0900_0000;\n",
    );
    assert_eq!(t.rules(), vec!["layout-literal"]);
    t.write("crates/vmm/src/devices/pl011.rs", "pub fn f() {}\n");
    t.write(
        "crates/vmm/src/arch/layout.rs",
        "pub const UART: u64 = 0x0900_0000;\n",
    );
    assert!(t.rules().is_empty());
}

#[test]
fn command_net_and_file_open_locations() {
    let t = TempTree::clean("locations");
    t.write("crates/vmm/src/a.rs", "use std::process::Command;\nuse std::net::TcpStream;\npub fn f() { let _ = std::fs::File::open(\"x\"); }\n");
    let mut rules = t.rules();
    rules.sort();
    assert_eq!(rules, vec!["hostio-only", "no-command", "no-net"]);
}

#[test]
fn crate_root_must_forbid_unsafe() {
    let t = TempTree::clean("forbid");
    t.write("crates/macvmm/src/main.rs", "fn main() {}\n");
    assert_eq!(t.rules(), vec!["forbid-unsafe"]);
    t.write(
        "crates/macvmm/src/main.rs",
        "#![forbid(unsafe_code)]\nfn main() {}\n",
    );
    assert!(t.rules().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Regression cases from the M0 review: each was `AUDIT OK` before the fix.

#[test]
fn feature_named_like_path_does_not_make_a_dependency_local() {
    let t = TempTree::clean("xpath");
    t.write(
        "crates/vmm/Cargo.toml",
        "[package]\nname = \"vmm\"\n[dependencies]\nhvf = { path = \"../hvf\" }\nevil = { version = \"1\", features = [\"xpath\"] }\n",
    );
    let findings = audit::audit(&t.0).unwrap().findings;
    assert_eq!(findings.len(), 1, "{findings:?}");
    assert_eq!(findings[0].rule, "deps-allowlist");
    assert!(findings[0].message.contains("evil"));
}

#[test]
fn allowlisted_name_from_git_patch_or_outside_path_fails() {
    let t = TempTree::clean("sources");
    t.write(
        "docs/dependencies.md",
        "<!-- allowlist:begin -->\nlibc\n<!-- allowlist:end -->\n",
    );
    t.write(
        "crates/vmm/Cargo.toml",
        "[package]\nname = \"vmm\"\n[dependencies]\nlibc = { git = \"https://example.com/evil-libc\" }\n\
         foo = { git = \"https://example.com/some/path/foo\" }\n\
         bar = { version = \"1\", registry = \"workspace-mirror\" }\n\
         out = { path = \"../../../vendor/out\" }\n",
    );
    t.write(
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/vmm\"]\n[patch.crates-io]\nevilcrate = { git = \"https://example.com/e\" }\n",
    );
    t.write(
        "Cargo.lock",
        "version = 4\n\n[[package]]\nname = \"libc\"\nversion = \"0.2.0\"\nsource = \"git+https://example.com/evil-libc#abc\"\n",
    );
    let rules: Vec<&str> = audit::audit(&t.0)
        .unwrap()
        .findings
        .iter()
        .map(|f| f.rule)
        .collect();
    // libc (git), foo (git), bar (registry), out (path), [patch.crates-io].
    assert_eq!(
        rules.iter().filter(|r| **r == "deps-source").count(),
        5,
        "{rules:?}"
    );
    let deps = audit::audit_deps(&t.0).unwrap().findings;
    assert!(
        deps.iter()
            .any(|f| f.path == "Cargo.lock" && f.rule == "deps-source"),
        "{deps:?}"
    );
}

#[test]
fn lexer_desync_cannot_hide_unsafe_or_allow() {
    let t = TempTree::clean("lexer");
    t.write(
        "crates/vmm/src/a/lexer.rs",
        "#[rustfmt::skip] const A: [char; 2] = ['\\'','\"'];\n\
         #[allow(unsafe_code)] pub fn h() { unsafe { core::hint::unreachable_unchecked() } }\n\
         const B: &str = \"\";\n",
    );
    let mut rules = t.rules();
    rules.sort();
    assert_eq!(rules, vec!["unsafe-allow", "unsafe-quarantine"]);
}

#[test]
fn nested_target_hidden_and_path_modules_are_scanned_or_refused() {
    let t = TempTree::clean("scope");
    let bad = "#![allow(unsafe_code)]\npub fn f() { unsafe { g() }; std::process::Command::new(\"sh\"); }\n";
    t.write(
        "crates/vmm/src/lib.rs",
        "#![deny(unsafe_code)]\n#[path = \".priv/x.rs\"]\nmod x;\npub mod gdbstub;\n",
    );
    t.write("crates/vmm/src/gdbstub/mod.rs", "pub mod target;\n");
    t.write("crates/vmm/src/gdbstub/target/mod.rs", bad);
    t.write("crates/vmm/src/.priv/x.rs", bad);
    let findings = audit::audit(&t.0).unwrap().findings;
    let has = |path: &str, rule: &str| findings.iter().any(|f| f.path == path && f.rule == rule);
    assert!(has("crates/vmm/src/lib.rs", "no-path-attr"), "{findings:?}");
    for p in [
        "crates/vmm/src/gdbstub/target/mod.rs",
        "crates/vmm/src/.priv/x.rs",
    ] {
        assert!(has(p, "unsafe-quarantine"), "{p}: {findings:?}");
        assert!(has(p, "unsafe-allow"), "{p}: {findings:?}");
        assert!(has(p, "no-command"), "{p}: {findings:?}");
    }
}

#[test]
fn symlinks_in_scanned_trees_fail() {
    let t = TempTree::clean("symlink");
    t.write("outside/evil.rs", "pub fn f() { unsafe { g() } }\n");
    std::os::unix::fs::symlink(
        t.0.join("outside/evil.rs"),
        t.0.join("crates/vmm/src/evil.rs"),
    )
    .unwrap();
    assert_eq!(t.rules(), vec!["no-symlink"]);
}

#[test]
fn tests_dir_inside_src_is_library_code() {
    let t = TempTree::clean("srctests");
    t.write(
        "crates/vmm/src/devices/tests/helpers.rs",
        "use std::process::Command;\nuse std::net::TcpStream;\npub fn f() { let _ = std::fs::File::open(\"x\"); }\n",
    );
    let mut rules = t.rules();
    rules.sort();
    assert_eq!(rules, vec!["hostio-only", "no-command", "no-net"]);
}

#[test]
fn import_spellings_of_banned_items_fail() {
    let t = TempTree::clean("spellings");
    t.write(
        "crates/vmm/src/a/net.rs",
        "use std::{io, net::TcpStream};\nuse std::process::*;\nuse std::process as p;\nuse std::fs::File as F;\n\
         pub fn f() { Command::new(\"a\"); p::Command::new(\"b\"); F::open(\"c\"); std::fs::copy(\"d\", \"e\"); }\n",
    );
    let findings = audit::audit(&t.0).unwrap().findings;
    let lines = |rule: &str| {
        let mut v: Vec<usize> = findings
            .iter()
            .filter(|f| f.rule == rule)
            .map(|f| f.line)
            .collect();
        v.dedup();
        v
    };
    assert_eq!(lines("no-net"), vec![1], "{findings:?}");
    // The glob and the rename are flagged at the import, which covers their later uses.
    assert_eq!(lines("no-command"), vec![2, 3], "{findings:?}");
    assert_eq!(lines("hostio-only"), vec![4, 5], "{findings:?}");
}
