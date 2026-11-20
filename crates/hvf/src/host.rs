//! libSystem shims: host time, OS-object release, and guest-memory allocation.
//!
//! **Why here and not in `vmm`:** each of these is a C call, so it needs `unsafe`, and `unsafe`
//! is quarantined to this crate (architecture §4). The wrappers are deliberately thin: they say
//! what the host does and leave policy (which offset to give the vtimer, when to free RAM) to
//! `vmm`. Later milestones add their shims here (termios and signals in M6, `getentropy` in M7,
//! `setrlimit`/`O_NOFOLLOW_ANY` in M3/M4, `sandbox_init` in M22) as additive edits (PLAN §2.1).
//!
//! **Time.** The guest's virtual counter is the host's `mach_absolute_time()` minus a per-vCPU
//! offset: `CNTVCT_EL0 = mach_absolute_time() - vtimer_offset` (`hv_vcpu.h`,
//! `hv_vcpu_set_vtimer_offset`). On Apple Silicon one tick is 1/24 MHz and the guest's CNTFRQ_EL0
//! reads 24 MHz (spike finding 4), so [`timebase`] is how the VMM converts ticks to time.
//!
//! **Allocation.** `hv_vm_allocate` returns page-aligned anonymous memory "suitable to be mapped
//! as guest memory" with accurate memory accounting (`hv_vm_allocate.h`). [`Allocation`] owns
//! one such block and deallocates it on drop. It hands out only a raw pointer, never a Rust
//! reference: the guest can write the memory at any time, so a `&[u8]` over it would be a lie
//! the compiler could act on (threat model MEM-5).

use crate::error::{CallError, HvError, check};
use crate::ffi;
use core::ffi::c_void;
use core::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};

/// Bytes deliberately leaked by [`Allocation::leak`] since the process started (threat model
/// MEM-11: memory that a stage-2 mapping might still reach is never freed or reused).
static LEAKED_BYTES: AtomicU64 = AtomicU64::new(0);

/// Number of `hv_vm_deallocate` calls made (by `Drop` or [`deallocate`]), successful or not.
static DEALLOCATE_CALLS: AtomicU64 = AtomicU64::new(0);

/// Total bytes leaked on purpose so far (fail-closed teardown, MEM-11). `--stats` and the
/// teardown tests read it.
pub fn leaked_bytes() -> u64 {
    LEAKED_BYTES.load(Ordering::SeqCst)
}

/// How many times `hv_vm_deallocate` has been called in this process. The MEM-11 tests assert
/// that a failed teardown does not move it.
pub fn deallocate_calls() -> u64 {
    DEALLOCATE_CALLS.load(Ordering::SeqCst)
}

// ANCHOR: host_timebase
/// The host tick counter (`mach_absolute_time`). Monotonic; never fails.
pub fn mach_absolute_time() -> u64 {
    // SAFETY: no arguments, no preconditions; it only reads the system clock.
    unsafe { ffi::mach_absolute_time() }
}

/// `mach_timebase_info`: `nanoseconds = ticks * numer / denom`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timebase {
    pub numer: u32,
    pub denom: u32,
}

impl Timebase {
    /// Convert host ticks to nanoseconds, saturating instead of overflowing.
    pub fn ticks_to_nanos(self, ticks: u64) -> u64 {
        if self.denom == 0 {
            return 0;
        }
        let n = u128::from(ticks) * u128::from(self.numer) / u128::from(self.denom);
        u64::try_from(n).unwrap_or(u64::MAX)
    }
}

/// The host timebase. `None` if the kernel call fails (it does not in practice) or reports a
/// zero denominator, which would make every conversion meaningless.
pub fn timebase() -> Option<Timebase> {
    let mut info = ffi::mach_timebase_info_data_t::default();
    // SAFETY: `info` is a live, writable `mach_timebase_info_data_t` with the C layout
    // (checked by `check-ffi.sh`).
    let kr = unsafe { ffi::mach_timebase_info(&mut info) };
    (kr == 0 && info.denom != 0).then_some(Timebase {
        numer: info.numer,
        denom: info.denom,
    })
}
// ANCHOR_END: host_timebase

/// The host's macOS release as `(major, minor)`, from `sysctl kern.osproductversion`
/// (for example `(27, 2)`). `None` if the value cannot be read or parsed.
pub fn macos_version() -> Option<(u32, u32)> {
    let mut buf = [0u8; 32];
    let mut len = buf.len();
    // SAFETY: the name is a static NUL-terminated string; `buf`/`len` describe a live writable
    // buffer and its size, which the kernel never exceeds (it fails with ENOMEM instead); no new
    // value is written (`newp` NULL, `newlen` 0).
    let rc = unsafe {
        ffi::sysctlbyname(
            c"kern.osproductversion".as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            core::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    let text = buf.get(..len)?;
    let text = core::str::from_utf8(text).ok()?.trim_end_matches('\0');
    let mut parts = text.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().map_or(Some(0), |m| m.parse().ok())?;
    Some((major, minor))
}

// ANCHOR: os_object
/// Owns one retained OS object (`hv_*_config_t`, `hv_gic_state_t`) and releases it on drop.
pub(crate) struct OsObject {
    ptr: NonNull<c_void>,
}

impl OsObject {
    /// Wrap a freshly created object; NULL (the `*_create` functions' only failure) becomes an
    /// error attributed to `call`.
    pub(crate) fn new(call: &'static str, ptr: *mut c_void) -> Result<OsObject, CallError> {
        NonNull::new(ptr)
            .map(|ptr| OsObject { ptr })
            .ok_or(CallError {
                call,
                error: HvError::NoResources,
            })
    }

    /// The raw object, valid for as long as `self` lives.
    pub(crate) fn as_ptr(&self) -> *mut c_void {
        self.ptr.as_ptr()
    }
}

impl Drop for OsObject {
    fn drop(&mut self) {
        // SAFETY: `ptr` is a non-NULL object returned retained by an `hv_*_create` function,
        // owned solely by this wrapper, and released exactly once here.
        unsafe { ffi::os_release(self.ptr.as_ptr()) }
    }
}
// ANCHOR_END: os_object

/// Host memory from `hv_vm_allocate`, released with `hv_vm_deallocate` on drop.
///
/// The block is zero-or-garbage as the framework returns it (M2 verifies zero-fill, MEM-10).
/// Access goes through raw pointers only; see the module docs for why there is no slice view.
#[derive(Debug)]
pub struct Allocation {
    ptr: NonNull<u8>,
    len: usize,
}

// SAFETY: the allocation is plain anonymous memory with no thread affinity; the type hands out
// only raw pointers, so sharing or moving it between threads cannot create a data race in safe
// code. Whoever dereferences the pointer takes on the synchronization duty.
unsafe impl Send for Allocation {}
// SAFETY: as above; `&Allocation` exposes nothing but the pointer value and length.
unsafe impl Sync for Allocation {}

impl Allocation {
    /// Start of the block (host page aligned).
    pub fn as_ptr(&self) -> *mut u8 {
        self.ptr.as_ptr()
    }

    /// Length in bytes (a multiple of the host page size).
    pub fn len(&self) -> usize {
        self.len
    }

    /// Always false: zero-sized allocations are refused by [`allocate`].
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Give up ownership without freeing: the memory stays allocated for the life of the
    /// process. This is the fail-closed path when a mapping of it could not be removed
    /// (threat model MEM-11): memory the guest might still reach must never be reused.
    ///
    /// The size is added to [`leaked_bytes`].
    pub fn leak(self) -> (NonNull<u8>, usize) {
        let (ptr, len) = self.into_raw();
        let bytes = u64::try_from(len).unwrap_or(u64::MAX);
        // A statistics counter. It cannot wrap in practice: leaking needs real allocations,
        // and the host cannot hand out 2^64 bytes.
        LEAKED_BYTES.fetch_add(bytes, Ordering::SeqCst);
        (ptr, len)
    }

    /// Give up ownership without freeing and without counting it as a leak (the caller frees
    /// it, as [`deallocate`] does).
    fn into_raw(self) -> (NonNull<u8>, usize) {
        let me = core::mem::ManuallyDrop::new(self);
        (me.ptr, me.len)
    }
}

impl Drop for Allocation {
    fn drop(&mut self) {
        // A failure cannot be reported from `drop`; the block is then simply leaked by the
        // framework, which is the safe direction.
        DEALLOCATE_CALLS.fetch_add(1, Ordering::SeqCst);
        // SAFETY: `ptr`/`len` describe exactly one block returned by `hv_vm_allocate`, owned by
        // this value and freed once, here. Owners that map it (`OwnedMapping`, `vmm`'s
        // `GuestRam`) unmap it before dropping, or `leak` it instead.
        let _ = unsafe { ffi::hv_vm_deallocate(self.ptr.as_ptr().cast(), self.len) };
    }
}

// ANCHOR: host_allocate
/// `hv_vm_allocate(len)`. `len` must be a non-zero multiple of the host page size; that is
/// checked here first (reported as `hv_vm_allocate: HV_BAD_ARGUMENT`), because the header only
/// promises behaviour for page multiples.
pub fn allocate(len: usize) -> Result<Allocation, CallError> {
    let page = crate::caps::host_page_size();
    if len == 0 || page == 0 || !len.is_multiple_of(page) {
        return Err(CallError {
            call: "hv_vm_allocate",
            error: HvError::BadArgument,
        });
    }
    let mut ptr: *mut c_void = core::ptr::null_mut();
    // SAFETY: `ptr` is a live out-parameter; `len` is a non-zero page multiple; flags are the
    // documented default.
    check("hv_vm_allocate", unsafe {
        ffi::hv_vm_allocate(&mut ptr, len, ffi::HV_ALLOCATE_DEFAULT)
    })?;
    let ptr = NonNull::new(ptr.cast::<u8>()).ok_or(CallError {
        call: "hv_vm_allocate",
        error: HvError::NoResources,
    })?;
    Ok(Allocation { ptr, len })
}
// ANCHOR_END: host_allocate

/// `hv_vm_deallocate`, reporting the framework's answer (dropping an [`Allocation`] does the
/// same call but has to discard the result). Owners that keep a deallocation counter or must
/// log a failed free (M2's `GuestRam`, threat model MEM-11) use this; the rules for when a
/// block may be freed at all are the same as for drop: it must no longer be mapped.
///
/// On failure the block is not touched again: it stays allocated (leaked), which is the safe
/// direction.
pub fn deallocate(alloc: Allocation) -> Result<(), CallError> {
    let (ptr, len) = alloc.into_raw();
    DEALLOCATE_CALLS.fetch_add(1, Ordering::SeqCst);
    // SAFETY: `ptr`/`len` describe exactly one block returned by `hv_vm_allocate`; `into_raw`
    // gave up the `Allocation`'s ownership, so this is the only free of it and `Drop` will not
    // run.
    check("hv_vm_deallocate", unsafe {
        ffi::hv_vm_deallocate(ptr.as_ptr().cast(), len)
    })
}

// ANCHOR: host_process_hardening
// Process hardening shims (M3; threat model PATH-6, PROC-4). `vmm` and `macvmm` forbid
// `unsafe`, so the two libSystem calls they need at startup live here.

/// `umask(2)`: set the file-mode creation mask and return the previous one. macvmm sets
/// `0o077` at startup so every file it creates (sinks, traces, DTBs) is 0600 (PATH-6).
pub fn set_umask(mask: u16) -> u16 {
    // SAFETY: `umask` takes a plain integer, cannot fail and touches no memory of ours.
    let old = unsafe { libc::umask(libc::mode_t::from(mask)) };
    old & 0o7777
}

/// `RLIMIT_CORE`: the maximum core-file size.
pub const RLIMIT_CORE: i32 = libc::RLIMIT_CORE;
/// `RLIMIT_NOFILE`: the maximum number of open file descriptors (lowered in M22).
pub const RLIMIT_NOFILE: i32 = libc::RLIMIT_NOFILE;

/// `getrlimit(2)`: `(soft, hard)` for `resource`.
pub fn get_rlimit(resource: i32) -> std::io::Result<(u64, u64)> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `lim` is a live, writable `struct rlimit`; the kernel validates `resource`.
    if unsafe { libc::getrlimit(resource, &mut lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((lim.rlim_cur, lim.rlim_max))
}

/// `setrlimit(2)` with `soft = hard = value`. Lowering a limit never needs privileges.
pub fn set_rlimit(resource: i32, value: u64) -> std::io::Result<()> {
    let lim = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: `lim` is a live `struct rlimit` the kernel only reads.
    if unsafe { libc::setrlimit(resource, &lim) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// `O_NONBLOCK`, for `OpenOptionsExt::custom_flags`: opening a FIFO for reading blocks until a
/// writer appears, so `HostIo` opens inputs non-blocking and *then* checks `S_ISREG` on the fd
/// (PATH-2). On a regular file the flag has no effect on reads.
pub const O_NONBLOCK: i32 = libc::O_NONBLOCK;
// ANCHOR_END: host_process_hardening

// Output-file shims (M4; threat model PATH-3..6). `HostIo` opens `--trace` (and from M6 the
// file sinks and `--dtb-out`) with these flags and checks the owner on the fd.

/// `O_NOFOLLOW` (`sys/fcntl.h`: `0x00000100`): `open(2)` fails with `ELOOP` if the *last*
/// path component is a symbolic link. Defeats the planted `/tmp/trace.jsonl ->
/// ~/.ssh/authorized_keys` link (PATH-3, attacker A4).
pub const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;
/// `O_NOFOLLOW_ANY` (`sys/fcntl.h`: `0x20000000`, macOS 11+): `open(2)` fails with `ELOOP` if
/// *any* component of the path is a symbolic link. `HostIo` resolves the parent directory
/// first (the user's own symlinks, such as `/tmp -> private/tmp`, are user intent) and then
/// opens `<resolved parent>/<name>` with this flag, so a component swapped for a link after
/// the resolution is refused instead of followed. It also refuses a link as the *last*
/// component, and it must be used **instead of** `O_NOFOLLOW`, not with it: the combination
/// fails with `EINVAL` (verified on macOS 27.2 in M4, `docs/research/hvf-api.md`).
pub const O_NOFOLLOW_ANY: i32 = libc::O_NOFOLLOW_ANY;
/// `ELOOP`: what `open(2)` returns when `O_NOFOLLOW`/`O_NOFOLLOW_ANY` met a symbolic link.
pub const ELOOP: i32 = libc::ELOOP;

/// `getuid(2)`: the real user id, to check that an output file is ours (PATH-3).
pub fn getuid() -> u32 {
    // SAFETY: `getuid` takes no arguments, cannot fail and touches no memory of ours.
    unsafe { libc::getuid() }
}

// Terminal shims (M6; threat model PROC-1, TTY-6; architecture §14.4). `macvmm/src/term.rs`
// decides *when* the terminal is raw and restores it on every exit path; these wrappers only
// say what termios(4) does. POSIX.1-2017 XBD §11 "General Terminal Interface" defines the
// flags; the macOS values come from `sys/termios.h` (mirrored by `libc`).

/// File descriptor 0.
pub const STDIN_FILENO: i32 = 0;
/// File descriptor 1.
pub const STDOUT_FILENO: i32 = 1;
/// File descriptor 2.
pub const STDERR_FILENO: i32 = 2;

/// `isatty(3)`: is `fd` a terminal? Raw mode is only ever set on a TTY (PROC-1), and the exit
/// reset sequence is only written to one (TTY-6).
pub fn isatty(fd: i32) -> bool {
    // SAFETY: `isatty` only inspects the descriptor number; an invalid one returns 0.
    unsafe { libc::isatty(fd) == 1 }
}

/// A saved terminal state (`struct termios`), opaque to callers.
#[derive(Clone, Copy)]
pub struct Termios {
    saved: libc::termios,
}

impl core::fmt::Debug for Termios {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("Termios")
            .field("iflag", &self.saved.c_iflag)
            .field("oflag", &self.saved.c_oflag)
            .field("lflag", &self.saved.c_lflag)
            .finish_non_exhaustive()
    }
}

impl Termios {
    /// `tcgetattr(2)`: the current settings of `fd`.
    pub fn get(fd: i32) -> std::io::Result<Termios> {
        // SAFETY: `termios` is plain old data; all-zero is a valid (if meaningless) value that
        // `tcgetattr` overwrites completely on success.
        let mut t: libc::termios = unsafe { core::mem::zeroed() };
        // SAFETY: `t` is a live, writable `struct termios`; the kernel validates `fd`.
        if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Termios { saved: t })
    }

    /// `tcsetattr(fd, TCSANOW, self)`: put these settings back.
    pub fn apply(&self, fd: i32) -> std::io::Result<()> {
        // SAFETY: `self.saved` is a `struct termios` obtained from `tcgetattr`; the kernel only
        // reads it.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &self.saved) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    // ANCHOR: term_raw_variant
    /// The "raw for a serial console" variant of these settings, as QEMU's stdio backend
    /// makes it (`qemu_chr_set_echo_stdio`): no line buffering, no echo, no signal keys (so
    /// Ctrl-C reaches the guest, architecture §14.4), no input translation, 8-bit chars, one
    /// byte per read. Output post-processing (`OPOST`, so `\n` still becomes `\r\n`) is kept,
    /// which is why this is not `cfmakeraw`: the VMM's own stderr lines stay readable.
    pub fn raw_variant(&self) -> Termios {
        let mut t = self.saved;
        t.c_iflag &= !(libc::IGNBRK
            | libc::BRKINT
            | libc::PARMRK
            | libc::ISTRIP
            | libc::INLCR
            | libc::IGNCR
            | libc::ICRNL
            | libc::IXON);
        t.c_oflag |= libc::OPOST;
        t.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON | libc::ISIG | libc::IEXTEN);
        t.c_cflag &= !(libc::CSIZE | libc::PARENB);
        t.c_cflag |= libc::CS8;
        if let Some(c) = t.c_cc.get_mut(libc::VMIN) {
            *c = 1;
        }
        if let Some(c) = t.c_cc.get_mut(libc::VTIME) {
            *c = 0;
        }
        Termios { saved: t }
    }
    // ANCHOR_END: term_raw_variant

    /// True if the two states have the same flags and control characters (for tests).
    pub fn same_as(&self, other: &Termios) -> bool {
        let (a, b) = (&self.saved, &other.saved);
        a.c_iflag == b.c_iflag
            && a.c_oflag == b.c_oflag
            && a.c_cflag == b.c_cflag
            && a.c_lflag == b.c_lflag
            && a.c_cc == b.c_cc
    }
}

/// `tcflush(fd, TCIFLUSH)`: discard input the terminal received but nobody read. On exit this
/// throws away a terminal's reply to a query, or a keystroke meant for the guest, so the host
/// shell never reads it (TTY-6 step 3).
pub fn tcflush_input(fd: i32) -> std::io::Result<()> {
    // SAFETY: plain integers; the kernel validates `fd`.
    if unsafe { libc::tcflush(fd, libc::TCIFLUSH) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

// The self-pipe signal shim (M6; threat model PROC-2; architecture §14.1 "signal" thread).
//
// **Why a pipe.** A signal handler interrupts arbitrary code, possibly while that code holds a
// lock or is inside `malloc`, so it may only call async-signal-safe functions (POSIX.1-2017
// XSH §2.4.3; `write(2)` is on the list, `pthread_mutex_lock` and `malloc` are not). The
// classic answer (D. J. Bernstein's self-pipe trick) is a handler that writes one byte, the
// signal number, into a pipe, and an ordinary thread that reads the pipe and does the real
// work with no restrictions. The handler saves and restores `errno`, because the interrupted
// code may be between a failing call and its read of `errno`. The write end is non-blocking:
// if the pipe is somehow full, the signal is dropped instead of deadlocking the handler (one
// pending byte already means "a signal came"). Both ends are close-on-exec (PROC-3).

/// `SIGINT` (Ctrl-C in a cooked terminal, `kill -INT`).
pub const SIGINT: i32 = libc::SIGINT;
/// `SIGTERM` (`kill`, the default).
pub const SIGTERM: i32 = libc::SIGTERM;
/// `SIGHUP` (the terminal went away).
pub const SIGHUP: i32 = libc::SIGHUP;
/// `SIGUSR1` (macvmm: dump the exit rings, LOG-6).
pub const SIGUSR1: i32 = libc::SIGUSR1;

/// The pipe's write end, for the handler. -1 until [`SignalPipe::install`] ran.
static SIGNAL_WRITE_FD: core::sync::atomic::AtomicI32 = core::sync::atomic::AtomicI32::new(-1);

// ANCHOR: signal_pipe
/// The signal handler: one `write(2)` of the signal number, `errno` preserved (PROC-2).
extern "C" fn on_signal(sig: libc::c_int) {
    // SAFETY: `__error` returns this thread's `errno` slot; reading and writing it is
    // async-signal-safe (it is a plain thread-local int).
    let errno = unsafe { libc::__error() };
    // SAFETY: as above; `errno` is a valid pointer for the life of the thread.
    let saved = unsafe { *errno };
    let fd = SIGNAL_WRITE_FD.load(core::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        let byte = u8::try_from(sig).unwrap_or(0);
        // SAFETY: `write` is async-signal-safe; `byte` is a live one-byte buffer; a full or
        // closed pipe just fails, which is fine (the signal is then dropped).
        let _ = unsafe { libc::write(fd, (&raw const byte).cast(), 1) };
    }
    // SAFETY: restoring the value read above into the same thread-local slot.
    unsafe { *errno = saved };
}
// ANCHOR_END: signal_pipe

fn cloexec(fd: i32, nonblock: bool) -> std::io::Result<()> {
    // SAFETY: plain `fcntl` calls on a descriptor this module just created.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    if nonblock {
        // SAFETY: as above.
        let fl = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        // SAFETY: as above.
        if fl < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// The read end of the process's signal self-pipe.
#[derive(Debug)]
pub struct SignalPipe {
    read_fd: i32,
}

impl SignalPipe {
    /// Create the pipe and route `signals` to it (`sigaction` with `SA_RESTART`, so ordinary
    /// blocking calls elsewhere are restarted instead of failing with `EINTR`). Call once per
    /// process; a second call is refused (`AlreadyExists`), because the handler has one pipe.
    pub fn install(signals: &[i32]) -> std::io::Result<SignalPipe> {
        let mut fds = [-1i32; 2];
        // SAFETY: `fds` is a live two-element array, as `pipe(2)` requires.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let [read_fd, write_fd] = fds;
        let setup = cloexec(read_fd, false).and_then(|()| cloexec(write_fd, true));
        let installed = setup.and_then(|()| {
            SIGNAL_WRITE_FD
                .compare_exchange(
                    -1,
                    write_fd,
                    core::sync::atomic::Ordering::SeqCst,
                    core::sync::atomic::Ordering::SeqCst,
                )
                .map(|_| ())
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::AlreadyExists))
        });
        if let Err(e) = installed {
            // SAFETY: closing the two descriptors created above, which nothing else uses.
            unsafe {
                libc::close(read_fd);
                libc::close(write_fd);
            }
            return Err(e);
        }
        for &sig in signals {
            // SAFETY: `sigaction` is plain old data; all-zero is a valid starting value.
            let mut sa: libc::sigaction = unsafe { core::mem::zeroed() };
            sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
            sa.sa_flags = libc::SA_RESTART;
            // SAFETY: `sa.sa_mask` is a live `sigset_t`.
            unsafe { libc::sigemptyset(&mut sa.sa_mask) };
            // SAFETY: `sa` is a fully initialised `struct sigaction` whose handler only does
            // async-signal-safe work (above); the old action is not needed (NULL).
            if unsafe { libc::sigaction(sig, &sa, core::ptr::null_mut()) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(SignalPipe { read_fd })
    }

    /// Block until a signal arrives and return its number. `EINTR` is retried.
    pub fn wait(&self) -> std::io::Result<i32> {
        loop {
            let mut byte = 0u8;
            // SAFETY: `byte` is a live one-byte buffer; `read_fd` is our pipe's read end.
            let n = unsafe { libc::read(self.read_fd, (&raw mut byte).cast(), 1) };
            match n {
                1 => return Ok(i32::from(byte)),
                0 => return Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)),
                _ => {
                    let e = std::io::Error::last_os_error();
                    if e.kind() != std::io::ErrorKind::Interrupted {
                        return Err(e);
                    }
                }
            }
        }
    }
}

/// `raise(3)` (for tests of the signal path).
pub fn raise(sig: i32) -> std::io::Result<()> {
    // SAFETY: plain integer; the kernel validates it.
    if unsafe { libc::raise(sig) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

// Raw and bounded writes (M6 review; threat model SINK-1, TTY-6, PROC-2). Two kinds of code
// must write to fd 1 or fd 2 without ever waiting on a reader:
// - the log writer thread (`vmm::log`) writes with plain `write(2)` and may block, but it must
//   not hold std's global stderr lock while it does, or every other `std::io::stderr()` user
//   (the panic hook, for one) would block behind it: [`write_fd`];
// - the last-resort exit paths (a second quit signal, the panic hook, the TTY-6 fallback when
//   the stdio sink could not write the reset) must finish even when the terminal or pipe is
//   stalled (`| less` waiting for a key, Ctrl-S flow control): [`write_bounded`].
//
// `write_bounded` does not set `O_NONBLOCK`: that flag belongs to the *open file description*,
// which a terminal shares with the user's shell, so setting it could break the shell after we
// exit. Instead it asks `poll(2)` whether the descriptor is writable before each write, and
// writes at most 256 bytes at a time. A pipe that polls writable has at least `PIPE_BUF` (512)
// bytes free (POSIX.1-2017 XSH `write`), so the write cannot block; a terminal that polls
// writable is below its low-water mark, which leaves more room than one chunk.

/// One `write(2)` of `buf` to `fd`; `EINTR` is retried. Returns the bytes written.
pub fn write_fd(fd: i32, buf: &[u8]) -> std::io::Result<usize> {
    loop {
        // SAFETY: `buf` is a live slice of `buf.len()` readable bytes; the kernel only reads
        // it and validates `fd`.
        let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
        if let Ok(n) = usize::try_from(n) {
            return Ok(n);
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

// ANCHOR: host_bounded_write
/// Write as much of `buf` to `fd` as can go **without blocking**, waiting at most `timeout`
/// in total for the descriptor to become writable (module comment above). Returns the bytes
/// written; never fails, never blocks longer than `timeout` plus one small write.
pub fn write_bounded(fd: i32, buf: &[u8], timeout: std::time::Duration) -> usize {
    const CHUNK: usize = 256;
    let start = std::time::Instant::now();
    let mut done = 0usize;
    while let Some(rest) = buf.get(done..).filter(|r| !r.is_empty()) {
        let left = timeout.saturating_sub(start.elapsed());
        let ms = libc::c_int::try_from(left.as_millis()).unwrap_or(libc::c_int::MAX);
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: `pfd` is one live, writable `struct pollfd`, and we pass a count of 1.
        let ready = unsafe { libc::poll(&mut pfd, 1, ms) };
        if ready < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if ready <= 0 || pfd.revents & libc::POLLOUT == 0 {
            break; // timed out, or an error/hang-up on the descriptor
        }
        let take = rest.get(..rest.len().min(CHUNK)).unwrap_or(rest);
        match write_fd(fd, take) {
            Ok(0) => break,
            Ok(n) => done = done.saturating_add(n),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        if start.elapsed() >= timeout && done < buf.len() {
            break;
        }
    }
    done
}
// ANCHOR_END: host_bounded_write

/// `_exit(2)`: end the process at once, running no `atexit` handler and no destructor, taking
/// no lock. The second-quit-signal path uses it (PROC-2): every lock in the process may be held
/// by a thread stuck in `write(2)`, and this must still exit.
pub fn exit_now(code: i32) -> ! {
    // SAFETY: `_exit` is async-signal-safe and takes a plain integer; it does not return.
    unsafe { libc::_exit(code) }
}

// ANCHOR: host_getentropy
// Entropy shim (M7; threat model FDT-3). The DTB's `rng-seed` and `kaslr-seed` come from the
// OS CSPRNG. `getentropy(2)` needs no file descriptor, so it keeps working after the M22
// sandbox lockdown, and it never blocks once the kernel's generator is seeded (always, by the
// time a user can log in).

/// The most bytes one `getentropy(2)` call may return (`sys/random.h`: `GETENTROPY_MAX`, 256;
/// a larger request fails with `EINVAL`).
pub const GETENTROPY_MAX: usize = 256;

/// `getentropy(2)`: fill `buf` (at most [`GETENTROPY_MAX`] bytes) from the kernel CSPRNG.
/// Larger buffers are refused here rather than by the kernel; `vmm::backend::entropy` loops.
pub fn getentropy(buf: &mut [u8]) -> std::io::Result<()> {
    if buf.len() > GETENTROPY_MAX {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    // SAFETY: `buf` is a live, writable slice of exactly `buf.len()` bytes (≤ 256, checked
    // above), and the kernel writes at most that many.
    if unsafe { libc::getentropy(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
// ANCHOR_END: host_getentropy

// ANCHOR: socket_buffers
// Socket-buffer shim (M24; architecture §11.3, threat model NET-5). macOS sizes an AF_UNIX
// datagram socket for chat, not for a NIC: `net.local.dgram.recvspace = 4096` (verified on the
// dev machine) queues only two 1514-byte frames before the sender gets `ENOBUFS`. The
// `--net unixgram` backend therefore raises both buffers to 1 MiB with `setsockopt(2)`
// (`SO_SNDBUF`, `SO_RCVBUF`, `sys/socket.h`), well under `kern.ipc.maxsockbuf = 8 MiB`.
// std has no setter for these, so the call lives here with the other `unsafe` FFI.

/// `ENOBUFS` (`sys/errno.h`: 55): what `sendto(2)` on a macOS AF_UNIX datagram socket returns
/// *at once* when the receiver's buffer is full. It does not block, even on a blocking socket
/// with a write timeout (verified on macOS 27.2 in M24), so the backend retries it itself.
pub const ENOBUFS: i32 = libc::ENOBUFS;

/// `setsockopt(fd, SOL_SOCKET, SO_SNDBUF, snd)` then `SO_RCVBUF, rcv`. Either failing is an
/// error: the NIC would silently drop most frames with the default sizes, so the caller fails
/// startup instead (PLAN M24 design notes).
pub fn set_socket_buffers(fd: i32, snd: usize, rcv: usize) -> std::io::Result<()> {
    for (opt, value) in [(libc::SO_SNDBUF, snd), (libc::SO_RCVBUF, rcv)] {
        let v = libc::c_int::try_from(value)
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        let len = libc::socklen_t::try_from(core::mem::size_of::<libc::c_int>())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        // SAFETY: `&v` points at a live `c_int` for the duration of the call and `len` is its
        // exact size; the kernel only reads it and validates `fd` and `opt` itself.
        let rc = unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                opt,
                (&raw const v).cast::<libc::c_void>(),
                len,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

// ANCHOR_END: socket_buffers

/// `getsockopt` of `SO_SNDBUF` and `SO_RCVBUF`: `(snd, rcv)` as the kernel applied them (the
/// M24 tests check that both read back at least 1 MiB).
pub fn socket_buffers(fd: i32) -> std::io::Result<(usize, usize)> {
    let mut out = [0usize; 2];
    for (slot, opt) in out.iter_mut().zip([libc::SO_SNDBUF, libc::SO_RCVBUF]) {
        let mut v: libc::c_int = 0;
        let mut len = libc::socklen_t::try_from(core::mem::size_of::<libc::c_int>())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
        // SAFETY: `&mut v` and `&mut len` are live and writable; `len` says how many bytes `v`
        // holds, and the kernel writes at most that many and updates `len`.
        let rc = unsafe {
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                opt,
                (&raw mut v).cast::<libc::c_void>(),
                &mut len,
            )
        };
        if rc != 0 {
            return Err(std::io::Error::last_os_error());
        }
        *slot = usize::try_from(v).map_err(|_| std::io::Error::other("negative buffer size"))?;
    }
    let [snd, rcv] = out;
    Ok((snd, rcv))
}

// CPU-time shim (M8; architecture §16 "Stats"). `--stats` compares the host CPU time the whole
// process used during a boot with the wall time it took: CURRICULUM ch12 checks that a guest
// idling in in-kernel WFI costs under 10 % of one host CPU.

// ANCHOR: host_process_cpu_time
/// `getrusage(RUSAGE_SELF)`: user + system CPU time of the whole process (every thread,
/// including the vCPU threads while they are inside `hv_vcpu_run`). `None` if the call fails.
pub fn process_cpu_time() -> Option<std::time::Duration> {
    // SAFETY: an all-zero `struct rusage` is a valid value of that plain-data C struct.
    let mut ru: libc::rusage = unsafe { core::mem::zeroed() };
    // SAFETY: `ru` is a live, writable `struct rusage`; `RUSAGE_SELF` is a valid selector.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return None;
    }
    let tv = |t: libc::timeval| {
        let secs = u64::try_from(t.tv_sec).ok()?;
        let micros = u32::try_from(t.tv_usec).ok()?;
        Some(std::time::Duration::from_secs(secs) + std::time::Duration::from_micros(micros.into()))
    };
    Some(tv(ru.ru_utime)? + tv(ru.ru_stime)?)
}
// ANCHOR_END: host_process_cpu_time

#[cfg(test)]
mod cpu_time_tests {
    /// `getrusage` works and the process CPU time moves forward with work.
    #[test]
    fn process_cpu_time_advances() {
        let a = super::process_cpu_time().unwrap();
        let mut x = 0u64;
        let start = std::time::Instant::now();
        while start.elapsed() < std::time::Duration::from_millis(30) {
            x = std::hint::black_box(x.wrapping_add(1));
        }
        let b = super::process_cpu_time().unwrap();
        assert!(b > a, "{a:?} -> {b:?} ({x})");
    }
}

// Confinement shims (M22; threat model SBX-1..SBX-4, PROC-4). `macvmm/src/sandbox.rs` owns the
// policy (the SBPL profile, when to apply it, what the self-test expects); these wrappers only
// say what libSystem does.
//
// `sandbox_init` is declared in the SDK's `usr/include/sandbox.h` (macOS 27.2):
//     int sandbox_init(const char *profile, uint64_t flags, char **errorbuf);
//     void sandbox_free_error(char *errorbuf);
// The header marks it deprecated since 10.8 and documents only `flags = SANDBOX_NAMED` (a
// built-in profile name). Passing SBPL *text* with `flags = 0` is the undocumented mode that
// `sandbox-exec -p` uses; it is verified on this machine (threat model §13, M22) but may break
// in any release, which is why `--sandbox` fails closed (SBX-4). It lives in
// `libsystem_sandbox.dylib`, part of libSystem, so no extra link flag is needed.
// ANCHOR: host_sandbox
unsafe extern "C" {
    fn sandbox_init(
        profile: *const libc::c_char,
        flags: u64,
        errorbuf: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn sandbox_free_error(errorbuf: *mut libc::c_char);
}

/// Apply the SBPL `profile` to this process, irrevocably (`sandbox_init(profile, 0, &err)`).
/// `Err` carries libsandbox's message (for example a profile syntax error, or "already in a
/// sandbox"). Threads that exist keep running under the new profile.
pub fn sandbox_init_profile(profile: &str) -> Result<(), String> {
    let c = std::ffi::CString::new(profile).map_err(|_| "the profile contains a NUL byte")?;
    let mut err: *mut libc::c_char = core::ptr::null_mut();
    // SAFETY: `c` is a NUL-terminated string that outlives the call; `err` is a live, writable
    // `char *` slot that `sandbox_init` sets to NULL or to a string it allocated.
    let rc = unsafe { sandbox_init(c.as_ptr(), 0, &mut err) };
    let msg = if err.is_null() {
        None
    } else {
        // SAFETY: on error `sandbox_init` stored a NUL-terminated string it owns in `err`; we
        // copy it before freeing it below.
        let m = unsafe { std::ffi::CStr::from_ptr(err) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: `err` came from `sandbox_init` and is freed exactly once, as `sandbox.h`
        // requires; it is not used afterwards.
        unsafe { sandbox_free_error(err) };
        Some(m)
    };
    match (rc, msg) {
        (0, _) => Ok(()),
        (_, Some(m)) => Err(m),
        (rc, None) => Err(format!("sandbox_init returned {rc}")),
    }
}

// ANCHOR_END: host_sandbox

/// The highest open file descriptor below `limit`, found with `fcntl(fd, F_GETFD)` (which only
/// asks whether `fd` is open). Used to lower `RLIMIT_NOFILE` to what the process needs (PROC-4).
pub fn highest_open_fd(limit: i32) -> Option<i32> {
    (0..limit).rev().find(|&fd| {
        // SAFETY: `F_GETFD` reads the descriptor flags of `fd`; an fd that is not open returns
        // -1 (EBADF). No memory of ours is touched.
        unsafe { libc::fcntl(fd, libc::F_GETFD) != -1 }
    })
}

/// Self-test probe (SBX-3 item 4): try to `open(path, O_RDONLY)`. `Ok` means the open
/// succeeded, which under the lockdown is a failure of the sandbox.
pub fn probe_open(path: &str) -> std::io::Result<()> {
    let c = std::ffi::CString::new(path).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    // SAFETY: `c` is a NUL-terminated path that outlives the call.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `fd` was just returned by `open` and is closed exactly once.
    unsafe { libc::close(fd) };
    Ok(())
}

/// Self-test probe: a TCP `connect` to 127.0.0.1 port 1. `Ok` or `ECONNREFUSED` mean the
/// request reached the network stack (not confined); `EPERM`/`EACCES` mean the sandbox refused
/// it. (On macOS `socket(2)` itself is not mediated by `network*`; `connect`, `bind` and
/// `sendto` are, verified in M22.)
pub fn probe_connect_loopback() -> std::io::Result<()> {
    // SAFETY: plain syscall with integer arguments.
    let s = unsafe { libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0) };
    if s < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let addr = libc::sockaddr_in {
        sin_len: u8::try_from(core::mem::size_of::<libc::sockaddr_in>()).unwrap_or(16),
        sin_family: u8::try_from(libc::AF_INET).unwrap_or(2),
        sin_port: 1u16.to_be(),
        sin_addr: libc::in_addr {
            s_addr: 0x7f00_0001u32.to_be(),
        },
        sin_zero: [0; 8],
    };
    let len = libc::socklen_t::try_from(core::mem::size_of::<libc::sockaddr_in>()).unwrap_or(16);
    // SAFETY: `addr` is a fully initialised `sockaddr_in` of `len` bytes that outlives the call;
    // `s` is the socket created above.
    let rc = unsafe { libc::connect(s, (&raw const addr).cast(), len) };
    let r = if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    };
    // SAFETY: `s` is open and closed exactly once.
    unsafe { libc::close(s) };
    r
}

/// Self-test probe: `posix_spawn` the program at `path` with no arguments and an empty
/// environment, and reap it. `Ok` means a process was created (not confined).
pub fn probe_spawn(path: &str) -> std::io::Result<()> {
    let c = std::ffi::CString::new(path).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let argv = [c.as_ptr().cast_mut(), core::ptr::null_mut()];
    let envp = [core::ptr::null_mut()];
    let mut pid: libc::pid_t = 0;
    // SAFETY: `path`, `argv` and `envp` are NULL-terminated as posix_spawn(2) requires and
    // outlive the call; NULL file actions and attributes mean the defaults.
    let rc = unsafe {
        libc::posix_spawn(
            &mut pid,
            c.as_ptr(),
            core::ptr::null(),
            core::ptr::null(),
            argv.as_ptr(),
            envp.as_ptr(),
        )
    };
    if rc != 0 {
        return Err(std::io::Error::from_raw_os_error(rc));
    }
    let mut status = 0;
    // SAFETY: `pid` is our child; `status` is a live int.
    unsafe { libc::waitpid(pid, &mut status, 0) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The output flags match `sys/fcntl.h` and `sys/errno.h` of the macOS SDK (checked by
    /// hand against the headers in M4; libc mirrors them).
    #[test]
    fn output_flags_match_the_sdk_headers() {
        assert_eq!(O_NOFOLLOW, 0x0000_0100);
        assert_eq!(O_NOFOLLOW_ANY, 0x2000_0000);
        assert_eq!(ELOOP, 62);
        // A file this process creates is owned by `getuid()`.
        let p = std::env::temp_dir().join(format!("hvf-getuid-{}", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        let owner = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(&p).unwrap());
        let _ = std::fs::remove_file(&p);
        assert_eq!(owner, getuid());
    }

    /// PROC-2: the handler turns a signal into one byte on the pipe; a second install is
    /// refused (the handler has one pipe).
    #[test]
    fn signal_pipe_delivers_and_installs_once() {
        let pipe = SignalPipe::install(&[SIGUSR1]).expect("install");
        raise(SIGUSR1).unwrap();
        assert_eq!(pipe.wait().unwrap(), SIGUSR1);
        let again = SignalPipe::install(&[SIGUSR1]).unwrap_err();
        assert_eq!(again.kind(), std::io::ErrorKind::AlreadyExists);
    }

    /// A pipe or `/dev/null` is not a terminal, and has no termios (PROC-1: raw mode is only
    /// attempted on a TTY).
    #[test]
    fn non_terminals_are_not_ttys() {
        let f = std::fs::File::open("/dev/null").unwrap();
        let fd = std::os::fd::AsRawFd::as_raw_fd(&f);
        assert!(!isatty(fd));
        assert!(Termios::get(fd).is_err());
        assert!(tcflush_input(fd).is_err());
        assert!(!isatty(-1));
    }

    /// SINK-1 / TTY-6 fallback: a pipe nobody reads fills up, and `write_bounded` then returns
    /// within its timeout instead of blocking; what it did write is readable, in order.
    #[test]
    fn write_bounded_never_blocks_on_a_full_pipe() {
        use std::io::Read as _;
        use std::os::fd::AsRawFd as _;
        let (mut r, w) = std::io::pipe().unwrap();
        let big = vec![b'z'; 1 << 20];
        let t = std::time::Instant::now();
        let n = write_bounded(w.as_raw_fd(), &big, std::time::Duration::from_millis(50));
        let took = t.elapsed();
        assert!(n > 0 && n < big.len(), "{n}");
        assert!(took < std::time::Duration::from_secs(1), "{took:?}");
        // Full now: a zero timeout writes nothing and returns at once.
        assert_eq!(
            write_bounded(w.as_raw_fd(), b"x", std::time::Duration::ZERO),
            0
        );
        assert_eq!(write_fd(w.as_raw_fd(), b"").unwrap(), 0);
        drop(w);
        let mut got = Vec::new();
        r.read_to_end(&mut got).unwrap();
        assert_eq!(got.len(), n);
        assert!(got.iter().all(|&b| b == b'z'));
        assert!(write_fd(-1, b"x").is_err());
        assert_eq!(write_bounded(-1, b"x", std::time::Duration::ZERO), 0);
    }

    /// M24: a bad fd or an oversized value is an error, never a panic. (The 1 MiB round trip on
    /// a real socket is `vmm/tests/unixgram.rs`: sockets may only be named under
    /// `vmm/src/net/` and in test crates, RUST-6.)
    #[test]
    fn socket_buffers_refuse_bad_input() {
        assert!(set_socket_buffers(-1, 1, 1).is_err());
        assert!(socket_buffers(-1).is_err());
        assert!(set_socket_buffers(0, usize::MAX, 1).is_err());
    }

    #[test]
    fn rlimit_roundtrip_in_bounds() {
        let (soft, hard) = get_rlimit(RLIMIT_NOFILE).unwrap();
        assert!(soft <= hard);
        assert!(get_rlimit(-1).is_err());
    }

    #[test]
    fn timebase_converts() {
        let tb = timebase().expect("timebase");
        assert!(tb.numer > 0 && tb.denom > 0);
        // 24 MHz on Apple Silicon: 125/3 ns per tick. Other values are fine; just convert.
        assert_eq!(
            Timebase {
                numer: 125,
                denom: 3
            }
            .ticks_to_nanos(24_000_000),
            1_000_000_000
        );
        assert_eq!(Timebase { numer: 1, denom: 0 }.ticks_to_nanos(5), 0);
        assert_eq!(
            Timebase {
                numer: u32::MAX,
                denom: 1
            }
            .ticks_to_nanos(u64::MAX),
            u64::MAX
        );
        let (major, _minor) = macos_version().expect("kern.osproductversion");
        assert!(major >= 15, "decision D7 floor");
        let a = mach_absolute_time();
        let b = mach_absolute_time();
        assert!(b >= a);
    }

    #[test]
    fn allocate_rejects_bad_sizes() {
        let page = crate::caps::host_page_size();
        for len in [0, 1, page - 1, page + 1] {
            let err = allocate(len).unwrap_err();
            assert_eq!(err.error, HvError::BadArgument, "len {len}");
        }
    }

    /// Behind `hvf-tests`: a hosted CI runner without a hypervisor may refuse the call.
    #[cfg(feature = "hvf-tests")]
    #[test]
    fn allocate_then_drop_or_leak() {
        let page = crate::caps::host_page_size();
        let a = allocate(2 * page).expect("hv_vm_allocate");
        assert_eq!(a.len(), 2 * page);
        assert!(!a.is_empty());
        assert!((a.as_ptr() as usize).is_multiple_of(page));
        drop(a);
        let b = allocate(page).expect("hv_vm_allocate");
        let want = b.as_ptr();
        let (ptr, len) = b.leak();
        assert_eq!((ptr.as_ptr(), len), (want, page));
        let c = allocate(page).expect("hv_vm_allocate");
        deallocate(c).expect("hv_vm_deallocate reports success");
    }
}
