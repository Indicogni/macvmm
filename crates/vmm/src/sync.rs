//! Locking helpers.
//!
//! **Why not `mutex.lock().unwrap()`:** `unwrap` is banned in this crate (architecture §4), and
//! `Mutex::lock` fails only when another thread panicked while holding the lock ("poisoning").
//! [`lock`] returns the guard anyway.
//!
//! **What recovery is for (threat model RUST-7, flaw F15).** A panic on any vCPU or worker
//! thread is a VMM bug, and it stops the whole VM with exit code 1. Poison recovery exists only
//! so that the *shutdown path* still works after such a panic: restoring the terminal, flushing
//! a disk with `sync_all`, joining threads, printing the fatal report. It MUST NOT be used to
//! keep a VM running on device state that a panic may have left half-updated: that would hide
//! the bug and could turn a logic error into memory confusion later. Code that runs while the
//! VM runs relies on the panic propagating through the thread scope, not on this function.

use std::sync::{Mutex, MutexGuard};

/// Lock `m`, recovering the guard if a panicking thread poisoned it (see the module docs for
/// when that is allowed).
pub fn lock<T: ?Sized>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn lock_recovers_from_poison() {
        let m = Arc::new(Mutex::new(41));
        let m2 = Arc::clone(&m);
        let joined = std::thread::spawn(move || {
            let _guard = m2.lock().unwrap();
            panic!("poison the mutex (expected in this test)");
        })
        .join();
        assert!(joined.is_err());
        assert!(m.is_poisoned());
        *lock(&m) += 1;
        assert_eq!(*lock(&m), 42);
    }
}
