//! Requests from the host user to a running VM: quit (Ctrl-A x, SIGINT, SIGTERM, SIGHUP) and
//! "show me the last exits" (Ctrl-A t, SIGUSR1) (architecture §14.1, §14.4, §16; threat model
//! LOG-6, TTY-9).
//!
//! **Why a separate attach point.** The threads that hear the user (the CLI's stdin and signal
//! threads) live for the whole process, but each boot builds a fresh `Machine` with its own
//! [`VmControl`] (architecture §14.5: a reboot is a rebuild). [`HostCtl`] is the stable place in
//! between, owned by `HostIo`: `Machine::run` *attaches* the boot's `VmControl` for as long as
//! it runs, and [`HostCtl::request_quit`] stops whatever boot is attached, or, between two
//! boots, makes the next attach stop at once. The quit flag and the attachment share one mutex,
//! so a quit can never fall into the gap between two boots.
//!
//! **The exit rings.** Each vCPU keeps its last 256 exits in an `ExitRing` (architecture §16).
//! A vCPU thread registers its ring here while it runs, so a ring dump can be printed from the
//! stdin or signal thread without stopping the guest. A dump contains only numbers and names
//! from static tables, because every record does (LOG-5, TTY-8): it is safe to print on the
//! user's terminal.
//!
//! **The boot's `--stats` report** (M8) is left here by `Machine::run` when it ends, because the
//! CLI prints it only after the verdict and the terminal restore (TTY-6), and a reboot builds a
//! new `Machine`. Each boot replaces the previous report; the lines hold numbers and static
//! names only (LOG-5).
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::control::{StopReason, VmControl};
use crate::sync::lock;
use crate::trace::ExitRing;
use std::sync::{Arc, Mutex, Weak};

// ANCHOR: hostctl_inner
#[derive(Debug, Default)]
struct Inner {
    current: Option<Weak<VmControl>>,
    quit: bool,
    rings: Vec<(usize, Weak<ExitRing>)>,
}
// ANCHOR_END: hostctl_inner

/// The process-lifetime attach point for user requests (module docs).
#[derive(Debug, Default)]
pub struct HostCtl {
    inner: Mutex<Inner>,
    /// The last boot's `--stats` lines (M8).
    stats: Mutex<Vec<String>>,
}

/// Detaches the boot's `VmControl` when dropped (end of `Machine::run`).
#[derive(Debug)]
pub struct Attached<'a> {
    host: &'a HostCtl,
}

impl Drop for Attached<'_> {
    fn drop(&mut self) {
        let mut inner = lock(&self.host.inner);
        inner.current = None;
        inner.rings.clear();
    }
}

impl HostCtl {
    pub fn new() -> HostCtl {
        HostCtl::default()
    }

    // ANCHOR: hostctl_attach
    /// Attach this boot's `ctl` until the guard drops. If the user already asked to quit, the
    /// boot is stopped at once.
    pub fn attach<'a>(&'a self, ctl: &Arc<VmControl>) -> Attached<'a> {
        let quit = {
            let mut inner = lock(&self.inner);
            inner.current = Some(Arc::downgrade(ctl));
            inner.quit
        };
        if quit {
            ctl.request_stop(StopReason::UserQuit);
        }
        Attached { host: self }
    }

    /// The user asked to quit: stop the attached boot (exit code 130), and every later one.
    /// Returns true the first time.
    pub fn request_quit(&self) -> bool {
        let (first, current) = {
            let mut inner = lock(&self.inner);
            let first = !inner.quit;
            inner.quit = true;
            (first, inner.current.as_ref().and_then(Weak::upgrade))
        };
        if let Some(ctl) = current {
            ctl.request_stop(StopReason::UserQuit);
        }
        first
    }
    // ANCHOR_END: hostctl_attach

    /// True once [`HostCtl::request_quit`] was called.
    pub fn quit_requested(&self) -> bool {
        lock(&self.inner).quit
    }

    /// Store the boot's `--stats` report (replacing the previous boot's).
    pub fn set_stats(&self, lines: Vec<String>) {
        *lock(&self.stats) = lines;
    }

    /// The last boot's `--stats` report (empty if none was stored).
    pub fn stats(&self) -> Vec<String> {
        lock(&self.stats).clone()
    }

    // ANCHOR: hostctl_dump_rings
    /// Make vCPU `index`'s ring visible to [`HostCtl::dump_rings`] while it runs.
    pub fn register_ring(&self, index: usize, ring: &Arc<ExitRing>) {
        let mut inner = lock(&self.inner);
        inner.rings.retain(|(i, _)| *i != index);
        inner.rings.push((index, Arc::downgrade(ring)));
    }

    /// Forget vCPU `index`'s ring.
    pub fn unregister_ring(&self, index: usize) {
        lock(&self.inner).rings.retain(|(i, _)| *i != index);
    }

    /// The registered rings as text: one header per vCPU, then one JSON record per line,
    /// oldest first. Numbers and static names only.
    pub fn dump_rings(&self) -> String {
        let rings: Vec<(usize, Arc<ExitRing>)> = lock(&self.inner)
            .rings
            .iter()
            .filter_map(|(i, w)| w.upgrade().map(|r| (*i, r)))
            .collect();
        crate::trace::dump_rings(&rings) // the format lives with the records
    }
    // ANCHOR_END: hostctl_dump_rings
}

#[cfg(test)]
#[allow(clippy::indexing_slicing)] // tests: a panic fails it
mod tests {
    use super::*;
    use crate::trace::ExitRecord;

    #[test]
    fn quit_reaches_the_attached_boot_and_the_next() {
        let host = HostCtl::new();
        let ctl = Arc::new(VmControl::new());
        {
            let _a = host.attach(&ctl);
            assert!(!ctl.is_stopping());
            assert!(host.request_quit());
            assert!(!host.request_quit(), "only the first counts");
            assert!(ctl.is_stopping());
            assert!(matches!(ctl.take_reason(), Some(StopReason::UserQuit)));
        }
        // Between boots: the next attach stops at once.
        let next = Arc::new(VmControl::new());
        let _b = host.attach(&next);
        assert!(next.is_stopping());
        assert!(host.quit_requested());
    }

    #[test]
    fn stats_report_is_kept_until_replaced() {
        let host = HostCtl::new();
        assert!(host.stats().is_empty());
        host.set_stats(vec!["a".into()]);
        host.set_stats(vec!["b".into(), "c".into()]);
        assert_eq!(host.stats(), vec!["b".to_owned(), "c".to_owned()]);
    }

    #[test]
    fn ring_dump_lists_registered_rings() {
        let host = HostCtl::new();
        assert_eq!(host.dump_rings(), "no vCPU is running\n");
        let ring = Arc::new(ExitRing::new());
        ring.push(ExitRecord::default());
        host.register_ring(0, &ring);
        let d = host.dump_rings();
        assert!(
            d.starts_with("vcpu0: last 1 exits, oldest first:\n  {"),
            "{d}"
        );
        host.unregister_ring(0);
        assert_eq!(host.dump_rings(), "no vCPU is running\n");
        let ctl = Arc::new(VmControl::new());
        host.register_ring(1, &ring);
        drop(host.attach(&ctl));
        assert_eq!(host.dump_rings(), "no vCPU is running\n", "detach clears");
    }
}
