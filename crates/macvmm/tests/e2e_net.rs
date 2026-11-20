//! E2E suite `net` (PLAN M24; course ch19): virtio-net over Unix datagram sockets, no
//! entitlement and no host network stack (architecture §11.3; threat model NET-1..6).
//!
//! ```text
//! scripts/test-e2e.sh net
//! # = cargo test -p macvmm --features hvf-tests --test e2e_net -- --test-threads=1
//! ```
//!
//! - `two_vms_ping_and_nc`: two Linux VMs (`scripts/initramfs/init` cases `net-b` and `net-a`)
//!   joined by a socket pair ping each other and move 32 MiB with busybox `nc`; both print the
//!   sha256 and the test compares them. The `--stats` NIC lines are printed (risk R12).
//! - `net_foreign_sender_dropped` (NET-1): the same, while a test-owned third socket sends 100
//!   forged ARP frames to A's socket; A still pings 5/5 and counts exactly 100 foreign drops.
//! - `net_bind_refuses_file`, `net_refuses_live_socket` (NET-4), `net_requires_peer` (NET-2):
//!   exit code 2 before any VM exists, with the documented message.
//! - `virtio_probe_net`: the bare-metal probe sees DeviceID 1 in slot 0 and negotiates.
#![cfg(feature = "hvf-tests")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::time::Duration;
use support::{Outcome, Running, artifact, expect, expect_code, guest, run, scratch};

const T10: Duration = Duration::from_secs(10);
const T150: Duration = Duration::from_secs(150);
const CMDLINE: &str = "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1";

/// A short private socket directory (`sun_path` holds 103 bytes; `$TMPDIR` is long).
fn sockdir(tag: &str) -> PathBuf {
    let d = scratch(tag);
    std::fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
    d
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The argv of one Linux NIC VM: `case` is `net-a` or `net-b`.
fn linux_vm(kernel: &str, initrd: &str, net: &str, case: &str) -> Vec<String> {
    [
        "run",
        "--kernel",
        kernel,
        "--initrd",
        initrd,
        "--mem",
        "512M",
        "--on-reset",
        "exit",
        "--timeout",
        "120",
        "--stats",
        "--net",
        net,
        "--cmdline",
        &format!("{CMDLINE} macvmm.test={case}"),
    ]
    .iter()
    .map(|a| a.to_string())
    .collect()
}

fn refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// The value after `sha256=` on the line with `marker`.
fn sha_after(o: &Outcome, marker: &str) -> String {
    let line = o
        .stdout
        .lines()
        .find(|l| l.contains(marker))
        .unwrap_or_else(|| panic!("no {marker:?} line\n{}", o.dump()));
    line.split("sha256=").nth(1).unwrap_or("").trim().to_owned()
}

/// The `--stats` NIC line (`macvmm: stats: net0 slot 0: ...`).
fn nic_stats(o: &Outcome) -> String {
    o.stderr
        .lines()
        .find(|l| l.starts_with("macvmm: stats: net0"))
        .unwrap_or_else(|| panic!("no NIC stats line\n{}", o.dump()))
        .to_owned()
}

/// A forged ARP request (who-has 10.0.0.1 tell 10.0.0.66) from a MAC nobody owns.
fn forged_arp(i: u8) -> Vec<u8> {
    let mut f = vec![0xff; 6]; // broadcast
    f.extend_from_slice(&[0x02, 0xba, 0xd0, 0x00, 0x00, i]);
    f.extend_from_slice(&[0x08, 0x06, 0, 1, 0x08, 0, 6, 4, 0, 1]);
    f.extend_from_slice(&[0x02, 0xba, 0xd0, 0x00, 0x00, i, 10, 0, 0, 66]);
    f.extend_from_slice(&[0; 6]);
    f.extend_from_slice(&[10, 0, 0, 1]);
    f
}

/// Boot B (`net-b`), wait for `listening`, then run A (`net-a`) while `during` runs once A's
/// eth0 is up. Returns (A, B).
fn two_vms(tag: &str, during: impl FnOnce(&Path)) -> Option<(Outcome, Outcome)> {
    let (Some(kernel), Some(initrd)) = (
        artifact("Image-virt", "linux"),
        artifact("initramfs-test.img", "linux"),
    ) else {
        return None; // skipped (MACVMM_E2E_ALLOW_SKIP=1)
    };
    let t = sockdir(tag);
    let (a, b) = (t.join("a.sock"), t.join("b.sock"));
    let net_b = format!("unixgram:{},peer={},mac=02:6d:76:00:00:02", s(&b), s(&a));
    let net_a = format!("unixgram:{},peer={},mac=02:6d:76:00:00:01", s(&a), s(&b));
    let argv_b = linux_vm(&kernel, &initrd, &net_b, "net-b");
    let mut vm_b = Running::spawn(&refs(&argv_b), true);
    assert!(
        vm_b.wait_for("macvmm-net: listening", Duration::from_secs(60)),
        "VM B never listened"
    );
    let argv_a = linux_vm(&kernel, &initrd, &net_a, "net-a");
    let mut vm_a = Running::spawn(&refs(&argv_a), true);
    assert!(
        vm_a.wait_for("macvmm-net: eth0 10.0.0.1 up", Duration::from_secs(60)),
        "VM A's eth0 never came up"
    );
    during(&t);
    let (oa, _) = vm_a.finish(T150);
    let (ob, _) = vm_b.finish(T150);
    let _ = std::fs::remove_dir_all(&t);
    Some((oa, ob))
}

/// PLAN M24 on-machine acceptance: ping 5/5 and 32 MiB with equal hashes; both exit 0.
#[test]
fn two_vms_ping_and_nc() {
    let Some((a, b)) = two_vms("n2", |_| {}) else {
        return;
    };
    expect_code("two_vms_ping_and_nc (A)", &a, 0);
    expect_code("two_vms_ping_and_nc (B)", &b, 0);
    expect("net-a", &a);
    expect("net-b", &b);
    let (sa, sb) = (
        sha_after(&a, "macvmm-net: sent 33554432 bytes"),
        sha_after(&b, "macvmm-net: received 33554432 bytes"),
    );
    assert_eq!(sa.len(), 64, "{sa:?}");
    assert_eq!(sa, sb, "the hashes differ\n{}\n{}", a.dump(), b.dump());
    // Risk R12: the drop counters of a clean run, for the hand-off report.
    eprintln!("R12 A {}", nic_stats(&a));
    eprintln!("R12 B {}", nic_stats(&b));
    eprintln!("R12 A wall {:?}, B wall {:?}", a.wall, b.wall);
}

/// NET-1 on machine: 100 forged ARP frames from a third socket during the ping are dropped and
/// counted; the ping and the transfer are unaffected.
#[test]
fn net_foreign_sender_dropped() {
    let Some((a, b)) = two_vms("nf", |t| {
        let evil = UnixDatagram::bind(t.join("evil.sock")).unwrap();
        for i in 0..100u8 {
            evil.send_to(&forged_arp(i), t.join("a.sock")).unwrap();
        }
    }) else {
        return;
    };
    expect_code("net_foreign_sender_dropped (A)", &a, 0);
    expect_code("net_foreign_sender_dropped (B)", &b, 0);
    expect("net-a", &a);
    let line = nic_stats(&a);
    assert!(
        line.contains("rx_dropped_foreign=100"),
        "{line}\n{}",
        a.dump()
    );
    assert!(nic_stats(&b).contains("rx_dropped_foreign=0"));
    eprintln!("NET-1 A {line}");
}

/// NET-4: a regular file at LOCAL is refused (exit 2) and left alone. (Rev 1.2 made `peer=`
/// mandatory, so the PLAN row's `--net unixgram:$T/x` gains a `peer=`; without it the CLI
/// stops earlier, which `net_requires_peer` covers.)
#[test]
fn net_bind_refuses_file() {
    let t = sockdir("nb");
    let x = t.join("x");
    std::fs::write(&x, b"precious").unwrap();
    let net = format!("unixgram:{},peer={}", s(&x), s(&t.join("y")));
    let o = run(
        &[
            "run",
            "--net",
            &net,
            "--kernel",
            &guest("hello"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("net_bind_refuses_file", &o, 2);
    assert!(
        o.stderr.contains("refusing to replace non-socket path"),
        "{}",
        o.dump()
    );
    assert_eq!(std::fs::read(&x).unwrap(), b"precious");
    let _ = std::fs::remove_dir_all(&t);
}

/// NET-2: `--net unixgram:LOCAL` without `peer=` (and without `,learn`) is a usage error.
#[test]
fn net_requires_peer() {
    let t = sockdir("np");
    let net = format!("unixgram:{}", s(&t.join("p.sock")));
    let o = run(
        &[
            "run",
            "--net",
            &net,
            "--kernel",
            &guest("hello"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("net_requires_peer", &o, 2);
    assert!(o.stderr.contains("needs peer="), "{}", o.dump());
    assert!(!t.join("p.sock").exists(), "nothing was bound");
    let _ = std::fs::remove_dir_all(&t);
}

/// PLAN M24: the bare-metal probe finds virtio-net (DeviceID 1) in slot 0 and negotiates
/// VERSION_1; the DT lists one node.
#[test]
fn virtio_probe_net() {
    let t = sockdir("vp");
    let net = format!(
        "unixgram:{},peer={}",
        s(&t.join("p.sock")),
        s(&t.join("q.sock"))
    );
    let o = run(
        &[
            "run",
            "--mem",
            "64M",
            "--net",
            &net,
            "--kernel",
            &guest("virtio-probe"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("virtio_probe_net", &o, 0);
    expect("virtio-probe-net", &o);
    let _ = std::fs::remove_dir_all(&t);
}

/// NET-4: a second process asking for a live socket's path is refused with exit 2, and the VM
/// that owns the socket keeps running.
#[test]
fn net_refuses_live_socket() {
    let Some(kernel) = artifact("Image-virt", "linux") else {
        return;
    };
    let Some(initrd) = artifact("initramfs-test.img", "linux") else {
        return;
    };
    let t = sockdir("nl");
    let b = t.join("b.sock");
    let net_b = format!("unixgram:{},peer={}", s(&b), s(&t.join("a.sock")));
    let argv_b = linux_vm(&kernel, &initrd, &net_b, "net-b");
    let mut vm_b = Running::spawn(&refs(&argv_b), true);
    assert!(
        vm_b.wait_for("macvmm-net: listening", Duration::from_secs(60)),
        "VM B never listened"
    );
    let net = format!("unixgram:{},peer={}", s(&b), s(&t.join("c.sock")));
    let o = run(
        &[
            "run",
            "--net",
            &net,
            "--kernel",
            &guest("hello"),
            "--timeout",
            "10",
        ],
        T10,
    );
    expect_code("net_refuses_live_socket", &o, 2);
    assert!(
        o.stderr.contains("refusing to replace a live socket"),
        "{}",
        o.dump()
    );
    assert!(
        vm_b.child.try_wait().unwrap().is_none(),
        "VM B must keep running"
    );
    assert!(
        std::fs::symlink_metadata(&b).is_ok(),
        "B's socket is untouched"
    );
    vm_b.signal("TERM");
    let (ob, _) = vm_b.finish(T10);
    assert_eq!(ob.code, Some(130), "{}", ob.dump());
    let _ = std::fs::remove_dir_all(&t);
}
