//! `UnixgramBackend`: a NIC whose wire is a pair of Unix datagram sockets (architecture §11.3;
//! threat model §7.14 NET-1..6; course ch19).
//!
//! **Why Unix datagrams.** Real host networking on macOS goes through `vmnet`, which needs the
//! restricted `com.apple.vm.networking` entitlement; macvmm ships with only
//! `com.apple.security.hypervisor` (SIGN-1). Two VMs can still talk Ethernet to each other if
//! each NIC is one `AF_UNIX`/`SOCK_DGRAM` socket and each frame is one datagram: datagrams keep
//! message boundaries (one `recv` = one frame, no framing protocol to parse) and never cross the
//! machine. There is no host network stack anywhere (NET-6): no TCP, no UDP, no routing.
//!
//! ```text
//!   VM A  eth0 ── virtio-net ── a.sock  ⇄  b.sock ── virtio-net ── eth0  VM B
//!                              (bind)      (peer=)
//! ```
//!
//! **Sizes** (`[V]` on the dev machine): `net.local.dgram.maxdgram = 2048` (one 1514-byte frame
//! fits), `net.local.dgram.recvspace = 4096` (two frames queue, then the sender gets `ENOBUFS`),
//! `kern.ipc.maxsockbuf = 8 MiB`. [`UnixgramBackend::bind`] raises both buffers to
//! [`SOCKET_BUFFER`] (1 MiB) through `hvf::host::set_socket_buffers` and fails startup if the
//! kernel refuses. `maxdgram` is only the *default* send buffer, **not** a cap on what can
//! arrive: a sender that raises its own `SO_SNDBUF` (as this backend does) can send a 4000-byte
//! datagram `[V]`. The receiver's 2048-byte buffer (`virtio::net::RX_BUFFER`) then silently
//! truncates it to 2048 bytes, which is still longer than any frame, so it is dropped as a bad
//! length, never delivered as a "valid" truncated frame.
//!
//! **Who may talk to us (NET-1, NET-2, F19).** On macOS a `connect()`ed datagram socket still
//! *receives* from any sender that can write to its path `[V]`, so connecting is not a filter.
//! Every received datagram's source address is compared with the peer path; a mismatch or an
//! unnamed sender is dropped, counted (`rx_dropped_foreign`) and warned about (rate-limited).
//! The peer path is given (`peer=`); the opt-in `,learn` mode locks it to the first sender with
//! an *absolute* path for the lifetime of the backend, logs it, and checks every later datagram
//! against it. A source address is the sender's `sun_path` exactly as it was bound `[V]`, so a
//! relative one (`s.sock`) says nothing about *which* `s.sock`: it is never accepted, and never
//! learned (a later `send_to("s.sock")` would resolve it against *our* working directory).
//!
//! **Sending.** The socket is not `connect`ed: every frame is a `send_to(peer)`. The peer often
//! does not exist yet when we start (the e2e test starts VM B before VM A, and B's peer is A's
//! socket), and a connected socket would also stay attached to a peer's *old* socket after that
//! peer restarts and rebinds. `send_to` resolves the path for every frame, so both cases just
//! work, and NET-1 is unchanged. A full peer returns `ENOBUFS` immediately (it does not honour a
//! write timeout `[V]`), so `send` retries for at most [`SEND_TIMEOUT`] and then drops.
//!
//! **What is *not* here:** every check on the socket *path* (the private directory NET-3, the
//! stale-socket replacement NET-4) is filesystem access, so it lives in `backend/hostio.rs`
//! (HOSTIO-1), which calls [`probe`] and then [`UnixgramBackend::bind`]. This file is the only
//! place in `crates/vmm` that names `std::os::unix::net` (RUST-6 audit rule `no-net`).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use super::backend::{NetBackend, SEND_TIMEOUT};
use crate::net::backend::RECV_TIMEOUT;
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::net::UnixDatagram;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Both socket buffers, in bytes (module docs): about 690 full-size frames each way.
pub const SOCKET_BUFFER: usize = 1 << 20;
/// The pause between two `ENOBUFS` retries of one frame.
const SEND_RETRY_PAUSE: Duration = Duration::from_micros(100);

/// Warn about a dropped datagram, rate-limited (LOG-1: whoever can write to LOCAL can trigger
/// it as often as they like). Not `guest_warn!`: the sender is a host process, not the guest.
/// The path is printed with `{:?}` (LOG-2): it is chosen by that process.
fn warn_foreign(local: &Path, source: Option<&Path>, why: &str) {
    static LIMIT: crate::log::RateLimit = crate::log::RateLimit::new();
    match LIMIT.admit() {
        Some(0) => crate::warn!("net {local:?}: datagram from {source:?} dropped: {why} (NET-1)"),
        Some(n) => crate::warn!(
            "net {local:?}: datagram from {source:?} dropped: {why} (NET-1; {n} similar \
             messages suppressed)"
        ),
        None => {}
    }
}

/// Who the peer is (NET-2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PeerSpec {
    /// `peer=PATH`: frames go to `target`; a datagram is accepted only if its source address is
    /// exactly one of `accept` (the absolute spellings of the same path: absolute, and with the
    /// directory resolved; `hostio.rs` computes them; never a relative one, module docs). No received path is ever resolved, so a
    /// sender cannot pass the check by binding a symlink to the peer.
    Fixed {
        target: PathBuf,
        accept: Vec<PathBuf>,
    },
    /// `,learn` (PLAN D17): the first sender with an absolute path becomes the peer, once, for
    /// good.
    Learn,
}

#[derive(Debug)]
enum Peer {
    Fixed {
        target: PathBuf,
        accept: Vec<PathBuf>,
    },
    Learn(OnceLock<PathBuf>),
}

/// Why the socket could not be set up (all usage errors: exit code 2 through `HostIo`).
#[derive(Debug)]
pub enum SetupError {
    /// `bind(LOCAL)` failed (path too long for `sun_path`, address in use, ...).
    Bind(io::Error),
    /// The kernel refused 1 MiB socket buffers.
    Buffers(io::Error),
    /// Setting the read or write timeout failed.
    Timeouts(io::Error),
}

impl core::fmt::Display for SetupError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SetupError::Bind(e) => write!(f, "bind failed: {e}"),
            SetupError::Buffers(e) => write!(
                f,
                "the kernel refused {SOCKET_BUFFER}-byte socket buffers (SO_SNDBUF/SO_RCVBUF; \
                 check sysctl kern.ipc.maxsockbuf): {e}"
            ),
            SetupError::Timeouts(e) => write!(f, "cannot set the socket timeouts: {e}"),
        }
    }
}

/// What a test `connect` says about an existing socket file (NET-4).
#[derive(Debug)]
pub enum Probe {
    /// Something is bound there: another process owns it.
    Live,
    /// `ECONNREFUSED`: a socket file nobody is bound to any more (left by a crashed VM).
    Stale,
    /// Anything else (wrong socket type, permissions, ...): not provably stale.
    Unknown(io::Error),
}

// ANCHOR: unixgram_probe
/// Is the socket at `path` live? A datagram `connect` to a bound socket succeeds; to a socket
/// file whose owner is gone it fails with `ECONNREFUSED` `[V]`. Only `Stale` may be replaced.
pub fn probe(path: &Path) -> Probe {
    let sock = match UnixDatagram::unbound() {
        Ok(s) => s,
        Err(e) => return Probe::Unknown(e),
    };
    match sock.connect(path) {
        Ok(()) => Probe::Live,
        Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => Probe::Stale,
        Err(e) => Probe::Unknown(e),
    }
}
// ANCHOR_END: unixgram_probe

/// One NIC's socket (module docs).
#[derive(Debug)]
pub struct UnixgramBackend {
    sock: UnixDatagram,
    local: PathBuf,
    peer: Peer,
    foreign: AtomicU64,
}

impl UnixgramBackend {
    // ANCHOR: unixgram_bind
    /// Bind `local` (already checked and, if stale, removed by `HostIo`: NET-3, NET-4), raise
    /// both buffers to [`SOCKET_BUFFER`], and set the timeouts: reads wait at most
    /// [`RECV_TIMEOUT`] so the RX thread sees its stop flag. The socket file is 0600 because of
    /// the startup `umask(0o077)` (PATH-6); the umask is never changed around `bind`, which
    /// would race with every other thread creating a file.
    pub fn bind(local: &Path, peer: PeerSpec) -> Result<UnixgramBackend, SetupError> {
        let sock = UnixDatagram::bind(local).map_err(SetupError::Bind)?;
        hvf::host::set_socket_buffers(sock.as_raw_fd(), SOCKET_BUFFER, SOCKET_BUFFER)
            .map_err(SetupError::Buffers)?;
        // Blocking mode on purpose: `O_NONBLOCK` is a property of the open file, shared by
        // the RX thread's `recv` and the worker's `send` (PLAN M24 design notes).
        sock.set_read_timeout(Some(RECV_TIMEOUT))
            .map_err(SetupError::Timeouts)?;
        sock.set_write_timeout(Some(SEND_TIMEOUT))
            .map_err(SetupError::Timeouts)?;
        let peer = match peer {
            PeerSpec::Fixed { target, accept } => Peer::Fixed { target, accept },
            PeerSpec::Learn => Peer::Learn(OnceLock::new()),
        };
        Ok(UnixgramBackend {
            sock,
            local: local.to_path_buf(),
            peer,
            foreign: AtomicU64::new(0),
        })
    }
    // ANCHOR_END: unixgram_bind

    /// The bound path.
    pub fn local(&self) -> &Path {
        &self.local
    }

    /// `(SO_SNDBUF, SO_RCVBUF)` as the kernel applied them.
    pub fn buffers(&self) -> io::Result<(usize, usize)> {
        hvf::host::socket_buffers(self.sock.as_raw_fd())
    }

    /// The peer path frames go to: `peer=`, or the learned one (`None` before the first
    /// sender in `,learn` mode).
    pub fn peer(&self) -> Option<&Path> {
        match &self.peer {
            Peer::Fixed { target, .. } => Some(target),
            Peer::Learn(l) => l.get().map(PathBuf::as_path),
        }
    }

    // ANCHOR: unixgram_peer_check
    /// NET-1: may a datagram from `source` reach the guest? Exact byte comparison only; an
    /// unnamed sender or a relative source path never may (module docs). In `,learn` mode the
    /// first sender with an absolute path is locked in as the peer and logged (NET-2); only the
    /// RX thread calls this, so there is no race between two "first" senders inside the process.
    /// `Err` carries why a datagram was refused, for the warning.
    fn accepts(&self, source: Option<&Path>) -> Result<(), &'static str> {
        let Some(src) = source else {
            return Err("unnamed sender");
        };
        if !src.is_absolute() {
            return Err("relative source path");
        }
        let ok = match &self.peer {
            Peer::Fixed { accept, .. } => accept.iter().any(|a| a.as_os_str() == src.as_os_str()),
            Peer::Learn(learned) => {
                if let Some(p) = learned.get() {
                    return if p.as_os_str() == src.as_os_str() {
                        Ok(())
                    } else {
                        Err("not the learned peer")
                    };
                }
                if learned.set(src.to_path_buf()).is_ok() {
                    crate::warn!(
                        "net {:?}: learned peer {:?}; it is locked for the lifetime of the VM",
                        self.local,
                        src
                    );
                }
                learned
                    .get()
                    .is_some_and(|p| p.as_os_str() == src.as_os_str())
            }
        };
        if ok { Ok(()) } else { Err("not the peer") }
    }
    // ANCHOR_END: unixgram_peer_check
}

impl NetBackend for UnixgramBackend {
    fn send(&self, frame: &[u8]) -> io::Result<()> {
        let Some(target) = self.peer() else {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        };
        let start = Instant::now();
        loop {
            match self.sock.send_to(frame, target) {
                Ok(n) if n == frame.len() => return Ok(()),
                Ok(_) => return Err(io::Error::other("short datagram send")),
                Err(e)
                    if (e.raw_os_error() == Some(hvf::host::ENOBUFS)
                        || e.kind() == io::ErrorKind::WouldBlock)
                        && start.elapsed() < SEND_TIMEOUT =>
                {
                    std::thread::sleep(SEND_RETRY_PAUSE);
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        let (n, from) = self.sock.recv_from(buf)?;
        match self.accepts(from.as_pathname()) {
            Ok(()) => Ok(n),
            Err(why) => {
                self.foreign.fetch_add(1, Ordering::Relaxed);
                warn_foreign(&self.local, from.as_pathname(), why);
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            }
        }
    }

    fn rx_dropped_foreign(&self) -> u64 {
        self.foreign.load(Ordering::Relaxed)
    }
}
