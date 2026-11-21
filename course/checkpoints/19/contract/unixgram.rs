// Checkpoint 19 contract, frozen from the reference test crates/vmm/tests/unixgram.rs.
// It names only items chapters 15 to 19 teach; the harness runs it against your crates.
//! Host acceptance: the `--net unixgram` backend over real Unix datagram sockets in a
//! private temp directory (see docs/security/threat-model.md). Needs no HVF.
//!
//! The socket setup goes through `hostio::open_unixgram`, exactly as `HostIo::open` does it, so
//! the directory check and the socket-replacement rules are the ones under test. The
//! "no `peer=` without `,learn`" rule is a parse error in the CLI (`macvmm` unit test
//! `cli::tests::net_flags`, e2e `net_requires_peer`): `NetPeer` has no "unset" variant, so the
//! library cannot even express it.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use vmm::backend::hostio::{InputError, open_unixgram};
use vmm::config::{NetPeer, NetSpec};
use vmm::net::NetBackend;
use vmm::net::unixgram::{SOCKET_BUFFER, UnixgramBackend};

/// A fresh 0700 directory for one test (short: `sun_path` holds 103 bytes).
fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("mvu{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::DirBuilder::new().mode(0o700).create(&d).unwrap();
    d
}

fn spec(local: &Path, peer: &Path) -> NetSpec {
    NetSpec {
        local: local.to_path_buf(),
        peer: NetPeer::Path(peer.to_path_buf()),
        mac: None,
    }
}

/// `recv` until a frame arrives or 2 s pass (a quiet error is a timeout or a dropped datagram).
fn recv_frame(b: &UnixgramBackend) -> io::Result<Vec<u8>> {
    let mut buf = vec![0u8; 2048];
    let t0 = Instant::now();
    loop {
        match b.recv(&mut buf) {
            Ok(n) => return Ok(buf[..n].to_vec()),
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock
                    && t0.elapsed() < Duration::from_secs(2) => {}
            Err(e) => return Err(e),
        }
    }
}

fn frame(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(13).wrapping_add(seed))
        .collect()
}

/// A connected pair `a.sock` ⇄ `b.sock` in `d`.
fn pair(d: &Path) -> (UnixgramBackend, UnixgramBackend) {
    let (a, b) = (d.join("a.sock"), d.join("b.sock"));
    (
        open_unixgram(&spec(&a, &b)).unwrap(),
        open_unixgram(&spec(&b, &a)).unwrap(),
    )
}

/// bind/send over a temp-dir pair moves a 1514-byte frame each way; both socket buffers read
/// back ≥ 1 MiB; the socket file is a socket; the read timeout keeps `recv` short.
#[test]
fn a_pair_moves_full_frames_both_ways() {
    let d = dir("pair");
    let (a, b) = pair(&d);
    let fa = frame(1514, 1);
    let fb = frame(1514, 2);
    a.send(&fa).unwrap();
    assert_eq!(recv_frame(&b).unwrap(), fa);
    b.send(&fb).unwrap();
    assert_eq!(recv_frame(&a).unwrap(), fb);
    for s in [&a, &b] {
        let (snd, rcv) = s.buffers().unwrap();
        assert!(snd >= SOCKET_BUFFER && rcv >= SOCKET_BUFFER, "{snd} {rcv}");
    }
    // An idle recv returns within about the 100 ms timeout.
    let t0 = Instant::now();
    let mut buf = [0u8; 2048];
    let e = a.recv(&mut buf).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::WouldBlock);
    assert!(
        t0.elapsed() < Duration::from_millis(500),
        "{:?}",
        t0.elapsed()
    );
    // 1 MiB of buffer: several hundred full frames queue without a drop.
    for i in 0..400u32 {
        a.send(&frame(1514, i as u8)).unwrap();
    }
    for _ in 0..400 {
        recv_frame(&b).unwrap();
    }
    assert_eq!(a.rx_dropped_foreign() + b.rx_dropped_foreign(), 0);
    let _ = std::fs::remove_dir_all(&d);
}

/// The peer need not exist yet (VM B starts before VM A): send fails and is dropped by the
/// caller; once the peer binds, frames flow without any reconnect.
#[test]
fn the_peer_may_appear_later() {
    let d = dir("later");
    let a = open_unixgram(&spec(&d.join("a.sock"), &d.join("b.sock"))).unwrap();
    assert!(a.send(&frame(60, 1)).is_err());
    let b = open_unixgram(&spec(&d.join("b.sock"), &d.join("a.sock"))).unwrap();
    a.send(&frame(60, 2)).unwrap();
    assert_eq!(recv_frame(&b).unwrap(), frame(60, 2));
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-4: a regular file at LOCAL is refused and left alone.
#[test]
fn replacing_a_regular_file_is_refused() {
    let d = dir("file");
    let x = d.join("x");
    std::fs::write(&x, b"precious").unwrap();
    let e = open_unixgram(&spec(&x, &d.join("y"))).unwrap_err();
    assert!(matches!(e, InputError::NetNotSocket { .. }), "{e:?}");
    assert!(
        e.to_string()
            .contains("refusing to replace non-socket path"),
        "{e}"
    );
    assert_eq!(std::fs::read(&x).unwrap(), b"precious");
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-4: a stale socket of ours (its owner is gone) is replaced.
#[test]
fn a_stale_socket_of_ours_is_replaced() {
    let d = dir("stale");
    let a = d.join("a.sock");
    drop(UnixDatagram::bind(&a).unwrap()); // the file stays, nobody is bound
    assert!(std::fs::symlink_metadata(&a).is_ok());
    let b = open_unixgram(&spec(&a, &d.join("b.sock"))).unwrap();
    assert_eq!(b.local(), a.as_path());
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-4: a live socket at LOCAL (another process is bound) is refused, and it keeps working.
#[test]
fn a_live_socket_is_refused_and_untouched() {
    let d = dir("live");
    let a = d.join("a.sock");
    let live = UnixDatagram::bind(&a).unwrap();
    let e = open_unixgram(&spec(&a, &d.join("b.sock"))).unwrap_err();
    assert!(matches!(e, InputError::NetLiveSocket { .. }), "{e:?}");
    assert!(
        e.to_string().contains("refusing to replace a live socket"),
        "{e}"
    );
    let probe = UnixDatagram::unbound().unwrap();
    probe.send_to(b"still here", &a).unwrap();
    let mut buf = [0u8; 32];
    let n = live.recv(&mut buf).unwrap();
    assert_eq!(&buf[..n], b"still here");
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-4: a symlink at LOCAL pointing at a live socket elsewhere (say `$SSH_AUTH_SOCK`) is
/// refused without following it: the link and the target are untouched.
#[test]
fn a_symlink_to_a_live_socket_is_refused() {
    let d = dir("link");
    let target = d.join("agent.sock");
    let agent = UnixDatagram::bind(&target).unwrap();
    let a = d.join("a.sock");
    std::os::unix::fs::symlink(&target, &a).unwrap();
    let e = open_unixgram(&spec(&a, &d.join("b.sock"))).unwrap_err();
    assert!(matches!(e, InputError::NetNotSocket { .. }), "{e:?}");
    assert!(
        std::fs::symlink_metadata(&a)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    let probe = UnixDatagram::unbound().unwrap();
    probe.send_to(b"ok", &target).unwrap();
    let mut buf = [0u8; 8];
    assert_eq!(agent.recv(&mut buf).unwrap(), 2);
    // A symlink to a *stale* socket is refused too: only a real socket file is ever replaced.
    let stale = d.join("gone.sock");
    drop(UnixDatagram::bind(&stale).unwrap());
    let a2 = d.join("a2.sock");
    std::os::unix::fs::symlink(&stale, &a2).unwrap();
    assert!(matches!(
        open_unixgram(&spec(&a2, &d.join("b.sock"))),
        Err(InputError::NetNotSocket { .. })
    ));
    assert!(
        std::fs::symlink_metadata(&stale).is_ok(),
        "the target is untouched"
    );
    drop(agent);
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-3: LOCAL (or the peer) in a world-writable or group-writable directory is refused.
#[test]
fn an_unsafe_directory_is_refused() {
    let d = dir("unsafe");
    let open = d.join("open");
    std::fs::create_dir(&open).unwrap();
    for mode in [0o777, 0o770, 0o1777] {
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(mode)).unwrap();
        let e = open_unixgram(&spec(&open.join("a.sock"), &d.join("b.sock"))).unwrap_err();
        assert!(matches!(e, InputError::NetDir { .. }), "{mode:o}: {e:?}");
        assert!(e.to_string().contains("unsafe socket directory"), "{e}");
        let e = open_unixgram(&spec(&d.join("a.sock"), &open.join("b.sock"))).unwrap_err();
        assert!(
            matches!(e, InputError::NetDir { .. }),
            "peer dir {mode:o}: {e:?}"
        );
    }
    assert!(
        std::fs::symlink_metadata(open.join("a.sock")).is_err(),
        "nothing was bound"
    );
    // A symlinked directory is refused too (it is checked with symlink_metadata).
    let link = d.join("dirlink");
    std::os::unix::fs::symlink(&d, &link).unwrap();
    assert!(matches!(
        open_unixgram(&spec(&link.join("a.sock"), &d.join("b.sock"))),
        Err(InputError::NetDir { .. })
    ));
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-1 (`net_peer_check`): a third socket that sends to LOCAL is dropped and counted, even
/// while the real peer's frames keep flowing; an unnamed sender is dropped too.
#[test]
fn net_peer_check() {
    let d = dir("peer");
    let (a, b) = pair(&d);
    let intruder = UnixDatagram::bind(d.join("evil.sock")).unwrap();
    for i in 0..10u8 {
        intruder.send_to(&frame(60, i), d.join("a.sock")).unwrap();
    }
    let unnamed = UnixDatagram::unbound().unwrap();
    unnamed.send_to(&frame(60, 99), d.join("a.sock")).unwrap();
    b.send(&frame(100, 7)).unwrap();
    // The 11 forged datagrams come first and are each refused; then the peer's frame.
    let mut buf = vec![0u8; 2048];
    let mut refused = 0;
    let got = loop {
        match a.recv(&mut buf) {
            Ok(n) => break buf[..n].to_vec(),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => refused += 1,
            Err(e) => panic!("{e}"),
        }
    };
    assert_eq!(got, frame(100, 7));
    assert_eq!(refused, 11);
    assert_eq!(a.rx_dropped_foreign(), 11);
    assert_eq!(b.rx_dropped_foreign(), 0);
    let _ = std::fs::remove_dir_all(&d);
}

/// NET-1 with the peer named through a symlinked directory: the resolved spelling of *our*
/// configuration is accepted, but a received source path is compared byte for byte and never
/// resolved: a sender whose path *resolves* to an accepted spelling, but is spelled
/// differently, is refused.
#[test]
fn peer_spellings_are_resolved_on_our_side_only() {
    let d = dir("spell");
    // A names its peer as `d/b.sock`; B binds the same socket under the resolved directory
    // (`$TMPDIR` is under `/var`, a symlink to `/private/var`, the same shape as macOS's
    // `/tmp → /private/tmp`). The resolved spelling of *our* configuration is accepted.
    let resolved = std::fs::canonicalize(&d).unwrap();
    assert_ne!(resolved, d, "the test needs $TMPDIR behind a symlink");
    let a = open_unixgram(&spec(&d.join("a.sock"), &d.join("b.sock"))).unwrap();
    let b = open_unixgram(&spec(&resolved.join("b.sock"), &d.join("a.sock"))).unwrap();
    b.send(&frame(60, 3)).unwrap();
    assert_eq!(recv_frame(&a).unwrap(), frame(60, 3));
    assert_eq!(a.rx_dropped_foreign(), 0);
    // B goes away. Liars then bind *the peer's own socket file* (`resolved/b.sock`) under other
    // spellings: through a symlinked directory, and with a `.` component. Each source address
    // canonicalises to the accepted `resolved/b.sock`, so only a byte-for-byte comparison
    // refuses them.
    drop(b);
    let link = d.join("link");
    std::os::unix::fs::symlink(&resolved, &link).unwrap();
    let spellings = [link.join("b.sock"), d.join(".").join("b.sock")];
    let mut buf = [0u8; 2048];
    for (i, liar_path) in spellings.iter().enumerate() {
        let _ = std::fs::remove_file(resolved.join("b.sock"));
        let liar = UnixDatagram::bind(liar_path).unwrap();
        assert_eq!(
            std::fs::canonicalize(liar_path).unwrap(),
            resolved.join("b.sock"),
            "the liar's path resolves to an accepted spelling"
        );
        liar.send_to(&frame(60, 4), d.join("a.sock")).unwrap();
        assert_eq!(
            a.recv(&mut buf).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied,
            "{liar_path:?}"
        );
        assert_eq!(a.rx_dropped_foreign(), i as u64 + 1);
    }
    let _ = std::fs::remove_dir_all(&d);
}

/// A datagram's source is the sender's `sun_path` exactly as bound, so a *relative* source
/// (`b.sock`) can come from any directory. (1) With a relative `peer=b.sock`, a sender that
/// binds `b.sock` from another directory is refused, and the real peer (bound absolute, as
/// macvmm always binds) is accepted. (2) `,learn` never learns a relative sender.
///
/// The only test in this binary that changes the working directory; every other test uses
/// absolute paths only, so they are unaffected.
#[test]
fn relative_source_paths_are_never_accepted() {
    // `current_dir` reports the resolved path, so work in the resolved directory throughout.
    let d = std::fs::canonicalize(dir("rel")).unwrap();
    let evil = d.join("evil");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&evil)
        .unwrap();
    let cwd = std::env::current_dir().unwrap();
    std::env::set_current_dir(&d).unwrap();
    // (1) A's peer is the relative `b.sock`, i.e. `d/b.sock`.
    let a = open_unixgram(&NetSpec {
        local: d.join("a.sock"),
        peer: NetPeer::Path(PathBuf::from("b.sock")),
        mac: None,
    })
    .unwrap();
    assert_eq!(a.peer(), Some(d.join("b.sock").as_path()));
    std::env::set_current_dir(&evil).unwrap();
    let liar = UnixDatagram::bind("b.sock").unwrap(); // evil/b.sock, source "b.sock"
    std::env::set_current_dir(&d).unwrap();
    let learner = open_unixgram(&NetSpec {
        local: d.join("l.sock"),
        peer: NetPeer::Learn,
        mac: None,
    })
    .unwrap();
    // (2) A relative sender (`r.sock`, bound in `d`) is the first to reach the learner.
    let rel = UnixDatagram::bind("r.sock").unwrap();
    std::env::set_current_dir(&cwd).unwrap();

    liar.send_to(&frame(60, 1), d.join("a.sock")).unwrap();
    let mut buf = [0u8; 2048];
    assert_eq!(
        a.recv(&mut buf).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        a.rx_dropped_foreign(),
        1,
        "the relative impostor is foreign"
    );
    let b = UnixDatagram::bind(d.join("b.sock")).unwrap();
    b.send_to(&frame(60, 2), d.join("a.sock")).unwrap();
    assert_eq!(recv_frame(&a).unwrap(), frame(60, 2));
    assert_eq!(a.rx_dropped_foreign(), 1);

    rel.send_to(&frame(60, 3), d.join("l.sock")).unwrap();
    assert_eq!(
        learner.recv(&mut buf).unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(learner.peer().is_none(), "a relative sender is not learned");
    assert_eq!(learner.rx_dropped_foreign(), 1);
    let first = UnixDatagram::bind(d.join("first.sock")).unwrap();
    first.send_to(&frame(60, 4), d.join("l.sock")).unwrap();
    assert_eq!(recv_frame(&learner).unwrap(), frame(60, 4));
    assert_eq!(learner.peer(), Some(d.join("first.sock").as_path()));
    let _ = std::fs::remove_dir_all(&d);
}

/// `,learn` (NET-2, PLAN D17): the first named sender is locked in as the peer; a second sender
/// is then dropped and counted; frames go to the learned peer; before learning, send fails.
#[test]
fn learn_locks_to_the_first_sender() {
    let d = dir("learn");
    let a = open_unixgram(&NetSpec {
        local: d.join("a.sock"),
        peer: NetPeer::Learn,
        mac: None,
    })
    .unwrap();
    assert!(a.peer().is_none());
    assert_eq!(
        a.send(&frame(60, 0)).unwrap_err().kind(),
        io::ErrorKind::NotConnected
    );
    // An unnamed sender cannot become the peer.
    UnixDatagram::unbound()
        .unwrap()
        .send_to(&frame(60, 1), d.join("a.sock"))
        .unwrap();
    let first = UnixDatagram::bind(d.join("first.sock")).unwrap();
    let second = UnixDatagram::bind(d.join("second.sock")).unwrap();
    first.send_to(&frame(60, 2), d.join("a.sock")).unwrap();
    second.send_to(&frame(60, 3), d.join("a.sock")).unwrap();
    first.send_to(&frame(60, 4), d.join("a.sock")).unwrap();
    let mut buf = vec![0u8; 2048];
    let mut got = Vec::new();
    while got.len() < 2 {
        match a.recv(&mut buf) {
            Ok(n) => got.push(buf[..n].to_vec()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {}
            Err(e) => panic!("{e}"),
        }
    }
    assert_eq!(got, vec![frame(60, 2), frame(60, 4)]);
    assert_eq!(
        a.rx_dropped_foreign(),
        2,
        "the unnamed sender and the second sender"
    );
    assert_eq!(a.peer(), Some(d.join("first.sock").as_path()));
    a.send(&frame(60, 5)).unwrap();
    let mut b2 = [0u8; 64];
    let n = first.recv(&mut b2).unwrap();
    assert_eq!(b2[..n].to_vec(), frame(60, 5));
    let _ = std::fs::remove_dir_all(&d);
}

/// `VmConfig::validate` refuses a NIC that is its own peer and the same LOCAL twice.
#[test]
fn config_rules() {
    let mut cfg = vmm::VmConfig::default();
    cfg.boot.kernel = Some("k".into());
    cfg.net = vec![spec(Path::new("/x/a"), Path::new("/x/a"))];
    assert!(cfg.validate().is_err());
    cfg.net = vec![
        spec(Path::new("/x/a"), Path::new("/x/b")),
        spec(Path::new("/x/a"), Path::new("/x/c")),
    ];
    assert!(cfg.validate().is_err());
    cfg.net.pop();
    assert!(cfg.validate().is_ok());
}
