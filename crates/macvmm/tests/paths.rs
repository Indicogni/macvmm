//! Host test: the input half of the path policy (PLAN M3 security tests; threat model PATH-1,
//! PATH-2, LDR-1, HOSTIO-1).
//!
//! These run the `macvmm` binary *unsigned*: `HostIo::open` refuses each input before any
//! Hypervisor.framework call, so they need no entitlement and run in hosted CI. Each must end
//! with exit code 2, the `not a regular file:` message, and quickly (a FIFO must never block
//! the open). M4 adds the trace cases of the output half (PATH-3..6 for `--trace`): a
//! symlinked target, a hard-linked target, an output that is an input, and the 0600 mode. M6 adds
//! the same cases for `--serial file:F` (PATH-3..6), plus a file owned by another user.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn scratch(test: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("macvmm-paths-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run `macvmm run <flag> <value>` and return (exit code, stderr, wall time).
fn run(flag: &str, value: &Path) -> (Option<i32>, String, Duration) {
    let t0 = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_macvmm"))
        .args(["run", "--mem", "64M", flag])
        .arg(value)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // A hang (a blocking FIFO open) must fail the test, not wedge it.
    let deadline = t0 + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() > deadline {
            let _ = child.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        t0.elapsed(),
    )
}

fn assert_refused(flag: &str, value: &Path) {
    let (code, stderr, wall) = run(flag, value);
    assert_eq!(code, Some(2), "{flag} {value:?}: {stderr}");
    assert!(
        stderr.contains("not a regular file:"),
        "{flag} {value:?}: {stderr}"
    );
    assert!(
        wall < Duration::from_secs(2),
        "{flag} {value:?} took {wall:?}"
    );
}

#[test]
fn fifo_dev_zero_directory_and_symlink_are_refused() {
    let dir = scratch("refused");
    let fifo = dir.join("fifo");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let link = dir.join("zero-link");
    std::os::unix::fs::symlink("/dev/zero", &link).unwrap();
    for input in [
        fifo.as_path(),
        Path::new("/dev/zero"),
        dir.as_path(),
        link.as_path(),
    ] {
        assert_refused("--kernel", input);
        let raw = PathBuf::from(format!("{}@0x40080000", input.display()));
        assert_refused("--raw", &raw);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn missing_and_oversized_inputs_are_usage_errors() {
    let dir = scratch("sizes");
    let (code, stderr, _) = run("--kernel", &dir.join("nope"));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("cannot open"), "{stderr}");
    let big = dir.join("big.bin");
    std::fs::File::create(&big)
        .unwrap()
        .set_len((64 << 20) + 1)
        .unwrap();
    let (code, stderr, _) = run("--kernel", &big);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(
        stderr.contains("exceeds the size cap of 67108864 bytes"),
        "{stderr}"
    );
    // A regular file that is not an ELF is refused by the loader, still before any HVF call.
    let junk = dir.join("junk");
    std::fs::write(&junk, b"not an elf").unwrap();
    let (code, stderr, _) = run("--kernel", &junk);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("not an ELF"), "{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_flag_is_exit_2_with_usage() {
    let out = Command::new(env!("CARGO_BIN_EXE_macvmm"))
        .args(["run", "--frobnicate"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("unknown flag") && stderr.contains("usage: macvmm run"),
        "{stderr}"
    );
}

/// Run `macvmm run --mem 64M <args>` unsigned and return (exit code, stderr).
fn run_args(args: &[&std::ffi::OsStr]) -> (Option<i32>, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_macvmm"))
        .args(["run", "--mem", "64M"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn trace_arg(p: &Path) -> std::ffi::OsString {
    let mut s = std::ffi::OsString::from("exits:");
    s.push(p);
    s
}

/// PATH-3: a symlinked `--trace` target is refused (exit 2) and its target is not touched, even
/// when the target is a file the user owns.
#[test]
fn trace_symlink_is_refused() {
    let dir = scratch("trace_symlink");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let victim = dir.join("authorized_keys");
    std::fs::write(&victim, b"precious").unwrap();
    let link = dir.join("t.jsonl");
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        &trace_arg(&link),
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("refusing symlinked output"), "{stderr}");
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-3: a `--trace` target that is a hard link to another file (attacker A4 planting
/// `ln ~victim/.zshrc /tmp/trace.jsonl`) is refused (exit 2) and the other file is not touched.
#[test]
fn trace_hard_link_is_refused() {
    let dir = scratch("trace_hard_link");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let victim = dir.join("precious");
    std::fs::write(&victim, b"IMPORTANT USER DATA").unwrap();
    let link = dir.join("t.jsonl");
    std::fs::hard_link(&victim, &link).unwrap();
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        &trace_arg(&link),
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("hard links"), "{stderr}");
    assert_eq!(std::fs::read(&victim).unwrap(), b"IMPORTANT USER DATA");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-4: `--trace exits:<the kernel file>` is refused (same inode) and the kernel is intact.
#[test]
fn trace_onto_an_input_is_refused() {
    let dir = scratch("trace_clash");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"kernel bytes").unwrap();
    // The same inode through a second name (a hard link) is caught too.
    let alias = dir.join("alias");
    std::fs::hard_link(&kernel, &alias).unwrap();
    for out in [&kernel, &alias] {
        let (code, stderr) = run_args(&[
            "--kernel".as_ref(),
            kernel.as_os_str(),
            "--trace".as_ref(),
            &trace_arg(out),
        ]);
        assert_eq!(code, Some(2), "{stderr}");
        assert!(stderr.contains("it is the same file as"), "{stderr}");
        assert_eq!(std::fs::read(&kernel).unwrap(), b"kernel bytes");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-6: a trace file macvmm creates is 0600, and an existing one is narrowed to 0600 and
/// truncated. (The kernel is junk, so the run stops with exit 2 at the loader, after `HostIo`
/// opened the output.)
#[test]
fn created_trace_is_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("trace_mode");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let t = dir.join("t.jsonl");
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        &trace_arg(&t),
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("not an ELF"), "{stderr}");
    assert_eq!(
        std::fs::metadata(&t).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::write(&t, b"old").unwrap();
    std::fs::set_permissions(&t, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (code, _) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        &trace_arg(&t),
    ]);
    assert_eq!(code, Some(2));
    let meta = std::fs::metadata(&t).unwrap();
    assert_eq!((meta.permissions().mode() & 0o777, meta.len()), (0o600, 0));
    // A bad --trace value is a usage error.
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        "t.jsonl".as_ref(),
    ]);
    assert_eq!(code, Some(2));
    assert!(stderr.contains("exits:FILE"), "{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// M7: `--dtb-out F` is an output under PATH-3..6 like `--trace`: a symlink, a hard link and
/// an input are refused (exit 2) and left intact; a created file is 0600. (The junk kernel
/// stops the run at the loader, after `HostIo` opened the output.)
#[test]
fn dtb_out_path_policy() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("dtb_out");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let victim = dir.join("precious");
    std::fs::write(&victim, b"IMPORTANT").unwrap();
    let sym = dir.join("sym.dtb");
    std::os::unix::fs::symlink(&victim, &sym).unwrap();
    let hard = dir.join("hard.dtb");
    std::fs::hard_link(&victim, &hard).unwrap();
    for (out, why) in [
        (&sym, "refusing symlinked output"),
        (&hard, "hard links"),
        (&kernel, "it is the same file as"),
    ] {
        let (code, stderr) = run_args(&[
            "--kernel".as_ref(),
            kernel.as_os_str(),
            "--dtb-out".as_ref(),
            out.as_os_str(),
        ]);
        assert_eq!(code, Some(2), "{out:?}: {stderr}");
        assert!(stderr.contains(why), "{out:?}: {stderr}");
    }
    assert_eq!(std::fs::read(&victim).unwrap(), b"IMPORTANT");
    assert_eq!(std::fs::read(&kernel).unwrap(), b"not an elf");
    let created = dir.join("v.dtb");
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--dtb-out".as_ref(),
        created.as_os_str(),
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert_eq!(
        std::fs::metadata(&created).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- M6: `--serial file:F` (PATH-3..6) ----

fn serial_arg(p: &Path) -> std::ffi::OsString {
    let mut s = std::ffi::OsString::from("file:");
    s.push(p);
    s
}

fn run_serial(kernel: &Path, out: &std::ffi::OsStr) -> (Option<i32>, String) {
    run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--serial".as_ref(),
        out,
    ])
}

/// PATH-3: `--serial file:<symlink>` is refused (exit 2) and the link's target is untouched.
#[test]
fn serial_file_symlink_is_refused() {
    let dir = scratch("serial_symlink");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let victim = dir.join("authorized_keys");
    std::fs::write(&victim, b"precious").unwrap();
    let link = dir.join("serial.log");
    std::os::unix::fs::symlink(&victim, &link).unwrap();
    let (code, stderr) = run_serial(&kernel, &serial_arg(&link));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("refusing symlinked output"), "{stderr}");
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    // A hard link to someone else's file is refused too.
    let hard = dir.join("hard.log");
    std::fs::hard_link(&victim, &hard).unwrap();
    let (code, stderr) = run_serial(&kernel, &serial_arg(&hard));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("hard links"), "{stderr}");
    assert_eq!(std::fs::read(&victim).unwrap(), b"precious");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-4: `--serial file:<the kernel>` is refused and the kernel is intact; so is a serial
/// file that is also the trace file.
#[test]
fn serial_file_onto_an_input_or_another_output_is_refused() {
    let dir = scratch("serial_clash");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"kernel bytes").unwrap();
    let (code, stderr) = run_serial(&kernel, &serial_arg(&kernel));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("it is the same file as"), "{stderr}");
    assert_eq!(std::fs::read(&kernel).unwrap(), b"kernel bytes");
    let both = dir.join("out.txt");
    let (code, stderr) = run_args(&[
        "--kernel".as_ref(),
        kernel.as_os_str(),
        "--trace".as_ref(),
        &trace_arg(&both),
        "--serial".as_ref(),
        &serial_arg(&both),
    ]);
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("it is the same file as"), "{stderr}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-6: a serial file macvmm creates is 0600; an existing one is narrowed to 0600 and
/// truncated. Bad `--serial` values are usage errors.
#[test]
fn created_serial_file_is_0600_and_bad_values_are_usage_errors() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("serial_mode");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let out = dir.join("s.txt");
    let (code, stderr) = run_serial(&kernel, &serial_arg(&out));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("not an ELF"), "{stderr}");
    assert_eq!(
        std::fs::metadata(&out).unwrap().permissions().mode() & 0o777,
        0o600
    );
    std::fs::write(&out, b"old").unwrap();
    std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o644)).unwrap();
    let mut arg = serial_arg(&out);
    arg.push(",strict,max=4K");
    let (code, _) = run_serial(&kernel, &arg);
    assert_eq!(code, Some(2));
    let meta = std::fs::metadata(&out).unwrap();
    assert_eq!((meta.permissions().mode() & 0o777, meta.len()), (0o600, 0));
    for bad in [
        "file:",
        "tty",
        "stdio,max=1K",
        "file:x,max=0",
        "file:x,raw,strict",
        "stdio,loud",
    ] {
        let (code, stderr) = run_serial(&kernel, bad.as_ref());
        assert_eq!(code, Some(2), "{bad}: {stderr}");
        assert!(stderr.contains("--serial"), "{bad}: {stderr}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// PATH-3: an existing output owned by another user is refused. Creating such a file needs
/// another account, so the test looks for a writable one in `/private/tmp` and skips with a
/// message when there is none (the owner check itself is unit-tested in `hostio.rs`).
#[test]
fn serial_file_owned_by_another_user_is_refused() {
    use std::os::unix::fs::MetadataExt;
    let me = std::fs::metadata(env!("CARGO_MANIFEST_DIR")).unwrap().uid();
    let foreign = std::fs::read_dir("/private/tmp").ok().and_then(|it| {
        it.filter_map(Result::ok).map(|e| e.path()).find(|p| {
            std::fs::symlink_metadata(p).is_ok_and(|m| {
                m.file_type().is_file() && m.uid() != me && m.mode() & 0o002 != 0 && m.nlink() == 1
            })
        })
    });
    let Some(path) = foreign else {
        eprintln!(
            "SKIP serial_file_owned_by_another_user_is_refused: no world-writable file owned by \
             another user in /private/tmp (creating one needs another account)"
        );
        return;
    };
    let dir = scratch("serial_foreign");
    let kernel = dir.join("kernel");
    std::fs::write(&kernel, b"not an elf").unwrap();
    let before = std::fs::read(&path).unwrap_or_default();
    let (code, stderr) = run_serial(&kernel, &serial_arg(&path));
    assert_eq!(code, Some(2), "{stderr}");
    assert!(stderr.contains("owned by another user"), "{stderr}");
    assert_eq!(std::fs::read(&path).unwrap_or_default(), before);
    let _ = std::fs::remove_dir_all(&dir);
}
