//! SC-14 (threat model, flaw F24; PLAN M15 security test): `cargo xtask audit` fails on a
//! script, test or lesson that hands a disk image to a host parser (`hdiutil attach`, `mount`,
//! `open`), and stays quiet on Rust calls, guest-side commands and lessons that forbid it.

use std::path::PathBuf;
use xtask::audit::{self, Report};
use xtask::image_audit::{audit_text, offending_commands, offending_rust_commands};

struct TempTree(PathBuf);

impl TempTree {
    fn new(tag: &str) -> TempTree {
        let dir =
            std::env::temp_dir().join(format!("xtask-image-audit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let t = TempTree(dir);
        // The minimal clean tree of tests/audit.rs: one hypervisor-only plist, an empty
        // allowlist, a vmm crate with its crate-level deny.
        t.write(
            "entitlements.plist",
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\t<key>com.apple.security.hypervisor</key>\n\t<true/>\n</dict>\n</plist>\n",
        );
        t.write(
            "docs/dependencies.md",
            "# deps\n<!-- allowlist:begin -->\n```\n```\n<!-- allowlist:end -->\n",
        );
        t.write("Cargo.toml", "[workspace]\nmembers = [\"crates/vmm\"]\n");
        t.write("crates/vmm/Cargo.toml", "[package]\nname = \"vmm\"\n");
        t.write(
            "crates/vmm/src/lib.rs",
            "#![deny(unsafe_code)]\npub fn f() {}\n",
        );
        t
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn findings(&self) -> Vec<(String, usize, &'static str)> {
        audit::audit(&self.0)
            .unwrap()
            .findings
            .iter()
            .map(|f| (f.path.clone(), f.line, f.rule))
            .collect()
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const RULE: &str = "no-host-mount-of-guest-image";

/// The PLAN M15 security test: a temp tree with one offending line fails the whole audit, at
/// that file and line; the same tree without it passes.
#[test]
fn audit_rejects_host_mount_of_guest_image() {
    let t = TempTree::new("reject");
    t.write(
        "scripts/inspect.sh",
        "#!/usr/bin/env bash\nset -euo pipefail\ncp -c \"$T/r.img\" x.img\nhdiutil attach \"$T/r.img\"\n",
    );
    assert_eq!(
        t.findings(),
        vec![("scripts/inspect.sh".to_owned(), 4, RULE)]
    );
    t.write(
        "scripts/inspect.sh",
        "#!/usr/bin/env bash\nset -euo pipefail\ncp -c \"$T/r.img\" x.img\n",
    );
    assert!(t.findings().is_empty(), "{:?}", t.findings());
    // The same rule in every scanned tree: a lesson and a test.
    t.write(
        "course/part4/ch18.md",
        "Then run `open disk.img` to look inside.\n",
    );
    t.write(
        "crates/macvmm/tests/e2e_x.rs",
        "// let _ = sh(\"mount -t msdos /dev/disk4 x.raw\");\n",
    );
    let mut got = t.findings();
    got.sort();
    assert_eq!(
        got,
        vec![
            ("course/part4/ch18.md".to_owned(), 1, RULE),
            ("crates/macvmm/tests/e2e_x.rs".to_owned(), 1, RULE)
        ]
    );
}

#[test]
fn offending_lines() {
    for line in [
        "hdiutil attach r.img",
        "hdiutil attach -readonly \"$T/r.img\"",
        "sudo mount -t ext4 disk.IMG /mnt",
        "mount disk.raw /mnt",
        "x=1; open \"$HOME/vm/r.img\"",
        "out=$(hdiutil mount disk.img)",
        "ls && open r.img",
        "`hdiutil attach disk.img`",
        "if true; then mount r.img /mnt; fi",
        // Absolute paths: this repo runs host tools that way (review of M15).
        "/usr/bin/hdiutil attach \"$T/r.img\"",
        "/sbin/mount -t msdos /dev/disk4 x.img",
        "/sbin/mount_msdos /dev/disk4s1 x.img",
        "/usr/bin/open r.img",
        "sudo /sbin/mount r.img",
        // Options after sudo, wrappers and assignments keep command position.
        "sudo -n mount disk.img /mnt",
        "sudo -u root mount disk.img /mnt",
        "env FOO=1 hdiutil attach disk.img",
        "x=1; nohup open disk.img",
        "FOO=1 /usr/bin/open r.raw",
        // hdiutil attach/mount whatever the argument: a variable hides the path.
        "hdiutil attach \"$IMG\"",
        "hdiutil mount -readonly \"${disk}\"",
        // A negation in an earlier command of the line does not exempt this one.
        "echo no; hdiutil attach r.img",
        "[ \"$x\" = never ] && mount r.img /mnt",
        "echo \"do not\" | open r.img",
    ] {
        assert_eq!(offending_commands(line).len(), 1, "{line}");
    }
}

#[test]
fn harmless_lines() {
    for line in [
        // Rust calls are not commands.
        "let f = File::open(&img)?;",
        "OpenOptions::new().read(true).open(&disk.img)",
        // Guest-side commands without an image path (scripts/initramfs/init).
        "mount -t squashfs -o ro /dev/vdb /.modloop",
        "mount -t ext4 /dev/vda /newroot",
        "mount -o remount,ro /",
        // An image path in a different command of the same line.
        "mount /dev/vda /mnt; cp r.img backup.img",
        // Prose: the word is not in command position.
        "the guest can mount r.img itself",
        "we open the r.img file read-only",
        // Image-ish names that are not images.
        "mount /dev/vda /mnt/img",
        "open docs/raw-notes.md",
        // Prose that names hdiutil without running it.
        "the hdiutil tool can attach images",
    ] {
        assert!(offending_commands(line).is_empty(), "{line}");
    }
}

#[test]
fn teaching_the_rule_is_allowed() {
    let mut r = Report::default();
    audit_text(
        "course/x.md",
        "Never run `hdiutil attach disk.img` on a guest-written image.\n\
         Do not `mount` r.img on the host.\n\
         You must not open r.img with Finder: open r.img is the bug.\n",
        &mut r,
    );
    assert!(r.findings.is_empty(), "{:?}", r.findings);
    audit_text(
        "course/y.md",
        "- `hdiutil attach disk.img`\n> $ mount r.img /mnt\n",
        &mut r,
    );
    assert_eq!(r.findings.len(), 2, "{:?}", r.findings);
}

/// The Rust form: `Command::new("…")` naming a mount/attach/open tool is a finding whatever
/// its arguments, bare or by absolute path, on one line or split by rustfmt; other programs,
/// variables and `File::open` are not.
#[test]
fn rust_command_forms() {
    for src in [
        "Command::new(\"/usr/bin/hdiutil\").args([\"attach\", \"r.img\"])",
        "Command::new(\"hdiutil\").args([\"attach\", \"disk.img\"])",
        "std::process::Command::new(\"/sbin/mount\")",
        "Command::new(\"mount_msdos\")",
        "Command::new(\"/usr/bin/open\").arg(&clone)",
        "Command::new(r\"diskutil\")",
        "let c = Command::new(\n        \"/usr/bin/hdiutil\",\n    );",
    ] {
        assert_eq!(offending_rust_commands(src).len(), 1, "{src}");
    }
    for src in [
        "Command::new(\"/bin/cp\").arg(\"-c\")",
        "Command::new(e2fsck).arg(\"-fn\")",
        "Command::new(\"/usr/bin/shasum\")",
        "Command::new(\"opener\")",
        "let f = File::open(\"r.img\")?;",
    ] {
        assert!(offending_rust_commands(src).is_empty(), "{src}");
    }
    // Through the whole audit, at the right line, only in `.rs` files.
    let t = TempTree::new("rust");
    t.write(
        "crates/macvmm/tests/e2e_y.rs",
        "use std::process::Command;\nfn f() {\n    let _ = Command::new(\"/usr/bin/hdiutil\")\n        .args([\"attach\", \"x\"]);\n}\n",
    );
    assert_eq!(
        t.findings(),
        vec![("crates/macvmm/tests/e2e_y.rs".to_owned(), 3, RULE)]
    );
}
