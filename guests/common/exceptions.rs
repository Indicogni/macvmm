//! The EL1 exception vector table: save the interrupted context, let the guest catch a
//! synchronous exception and resume, or report it and stop the VM (PLAN M4; course ch06).
//!
//! **Why every guest has one.** Without a table, `VBAR_EL1` holds whatever reset left there,
//! and the first fault jumps to an arbitrary address: the guest wanders off and the test times
//! out with no clue (`self-fault` shows exactly that, on purpose, by setting `VBAR_EL1 = 0`).
//! With it, any exception prints its class and syndrome and ends the VM with
//! `DEBUG_EXIT(0xE0 + kind)`, so a test fails fast with exit code 6 and a readable line.
//!
//! **Layout** (ARM ARM DDI 0487, D1.10.2 "Exception vectors"): 16 entries of 0x80 bytes at a
//! 2 KiB-aligned base, in four groups of four (synchronous, IRQ, FIQ, SError): current EL with
//! SP_EL0, current EL with SP_ELx, lower EL using AArch64, lower EL using AArch32. `kind` is
//! the entry index 0..15. Taking an exception to EL1 always switches to `SP_EL1`
//! (`PSTATE.SP = 1`), so the handlers run on the CPU's own stack whatever the guest was using.
//!
//! **The frame.** Each entry reserves an [`ExceptionFrame`] on the stack and stores `x0, x1`;
//! the common tail stores `x2..x30`, `ELR_EL1`, `SPSR_EL1`, `ESR_EL1` and `FAR_EL1` (ARM ARM,
//! the register descriptions of each), then calls [`guest_exception`] with the kind and the
//! frame. If that returns, the tail writes `ELR_EL1`/`SPSR_EL1` back from the (possibly
//! edited) frame, restores every register and `eret`s: the guest resumes at `frame.elr`.
//!
//! **Hooks.** A guest that *expects* a synchronous exception (M5's `sysreg-probe` checks that
//! an UNDEF is injected; `regcheck` checks the table itself with an `svc`) installs a
//! [`SyncHook`] with [`set_sync_hook`]. The hook sees the frame and returns `true` to resume
//! (after moving `elr` past the instruction if it was a fault; an `svc` already points past
//! itself). FIQ and SError are never hooked. **IRQs** (M8) go to an [`IrqHook`] installed
//! with [`set_irq_hook`]: the `irq` and `timer` guests acknowledge the GIC there, and
//! `timer-nogic` silences the timer; the frame is restored and `eret` resumes the interrupted
//! code. An IRQ with no hook installed is reported like any other unexpected exception.

use core::arch::global_asm;
use core::sync::atomic::{AtomicUsize, Ordering};

/// The saved context, as the assembly below lays it out (288 bytes, a multiple of 16 so the
/// stack stays aligned, AAPCS64 §6.4.5.1).
#[repr(C)]
#[derive(Debug)]
pub struct ExceptionFrame {
    /// `x0..x30` at the exception.
    pub x: [u64; 31],
    /// `ELR_EL1`: where `eret` resumes. Edit it to skip a faulting instruction.
    pub elr: u64,
    /// `SPSR_EL1`: the interrupted PSTATE, restored by `eret`.
    pub spsr: u64,
    /// `ESR_EL1`: why (EC in bits 31:26).
    pub esr: u64,
    /// `FAR_EL1`: the faulting address, for aborts.
    pub far: u64,
    _pad: u64,
}

const _: () = assert!(core::mem::size_of::<ExceptionFrame>() == 288);

impl ExceptionFrame {
    /// `ESR_EL1.EC`.
    pub fn ec(&self) -> u64 {
        (self.esr >> 26) & 0x3f
    }
}

global_asm!(
    r#"
    .section .vectors, "ax"
    .balign 2048
    .global guest_vectors
guest_vectors:
    .irp kind, 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15
    .balign 128
    sub     sp, sp, #288
    stp     x0, x1, [sp, #0]
    mov     x0, #\kind
    b       guest_vector_common
    .endr

guest_vector_common:
    stp     x2, x3, [sp, #16]
    stp     x4, x5, [sp, #32]
    stp     x6, x7, [sp, #48]
    stp     x8, x9, [sp, #64]
    stp     x10, x11, [sp, #80]
    stp     x12, x13, [sp, #96]
    stp     x14, x15, [sp, #112]
    stp     x16, x17, [sp, #128]
    stp     x18, x19, [sp, #144]
    stp     x20, x21, [sp, #160]
    stp     x22, x23, [sp, #176]
    stp     x24, x25, [sp, #192]
    stp     x26, x27, [sp, #208]
    stp     x28, x29, [sp, #224]
    mrs     x9, elr_el1
    stp     x30, x9, [sp, #240]
    mrs     x9, spsr_el1
    mrs     x10, esr_el1
    stp     x9, x10, [sp, #256]
    mrs     x9, far_el1
    str     x9, [sp, #272]
    mov     x1, sp
    bl      guest_exception
    ldp     x30, x9, [sp, #240]
    msr     elr_el1, x9
    ldr     x9, [sp, #256]
    msr     spsr_el1, x9
    ldp     x2, x3, [sp, #16]
    ldp     x4, x5, [sp, #32]
    ldp     x6, x7, [sp, #48]
    ldp     x8, x9, [sp, #64]
    ldp     x10, x11, [sp, #80]
    ldp     x12, x13, [sp, #96]
    ldp     x14, x15, [sp, #112]
    ldp     x16, x17, [sp, #128]
    ldp     x18, x19, [sp, #144]
    ldp     x20, x21, [sp, #160]
    ldp     x22, x23, [sp, #176]
    ldp     x24, x25, [sp, #192]
    ldp     x26, x27, [sp, #208]
    ldp     x28, x29, [sp, #224]
    ldp     x0, x1, [sp, #0]
    add     sp, sp, #288
    eret
"#
);

/// The names of the 16 vector entries, by index.
const KINDS: [&str; 16] = [
    "sync, EL1t",
    "irq, EL1t",
    "fiq, EL1t",
    "serror, EL1t",
    "sync, EL1h",
    "irq, EL1h",
    "fiq, EL1h",
    "serror, EL1h",
    "sync, lower EL A64",
    "irq, lower EL A64",
    "fiq, lower EL A64",
    "serror, lower EL A64",
    "sync, lower EL A32",
    "irq, lower EL A32",
    "fiq, lower EL A32",
    "serror, lower EL A32",
];

/// A synchronous-exception hook: return `true` to resume at `frame.elr`.
pub type SyncHook = fn(&mut ExceptionFrame) -> bool;

/// The installed hook as a function-pointer address (0 = none).
static SYNC_HOOK: AtomicUsize = AtomicUsize::new(0);

/// Install (`Some`) or remove (`None`) the synchronous-exception hook.
pub fn set_sync_hook(hook: Option<SyncHook>) {
    SYNC_HOOK.store(hook.map_or(0, |h| h as usize), Ordering::SeqCst);
}

fn sync_hook() -> Option<SyncHook> {
    match SYNC_HOOK.load(Ordering::SeqCst) {
        0 => None,
        // SAFETY: the only non-zero values ever stored come from `set_sync_hook`, which stores
        // a valid `SyncHook` function pointer cast to `usize`; casting it back yields that same
        // function pointer (function pointers and `usize` have the same size on AArch64).
        addr => Some(unsafe { core::mem::transmute::<usize, SyncHook>(addr) }),
    }
}

/// An IRQ hook: runs for every IRQ (vector entries 1, 5, 9, 13); the guest resumes after it.
pub type IrqHook = fn(&mut ExceptionFrame);

/// The installed IRQ hook as a function-pointer address (0 = none).
static IRQ_HOOK: AtomicUsize = AtomicUsize::new(0);

/// Install (`Some`) or remove (`None`) the IRQ hook (M8).
pub fn set_irq_hook(hook: Option<IrqHook>) {
    IRQ_HOOK.store(hook.map_or(0, |h| h as usize), Ordering::SeqCst);
}

fn irq_hook() -> Option<IrqHook> {
    match IRQ_HOOK.load(Ordering::SeqCst) {
        0 => None,
        // SAFETY: only `set_irq_hook` stores non-zero values, each a valid `IrqHook` cast to
        // `usize` (same size as a function pointer on AArch64).
        addr => Some(unsafe { core::mem::transmute::<usize, IrqHook>(addr) }),
    }
}

/// Called by the vector table (module docs). Returns to resume; otherwise reports and stops.
#[unsafe(no_mangle)]
pub extern "C" fn guest_exception(kind: u64, frame: &mut ExceptionFrame) {
    let synchronous = kind % 4 == 0;
    if synchronous
        && let Some(hook) = sync_hook()
        && hook(frame)
    {
        return;
    }
    if kind % 4 == 1
        && let Some(hook) = irq_hook()
    {
        hook(frame);
        return;
    }
    let name = usize::try_from(kind)
        .ok()
        .and_then(|k| KINDS.get(k))
        .copied()
        .unwrap_or("?");
    crate::println!(
        "guest exception: kind={kind} ({name}) esr={:#x} ec={:#x} elr={:#x} far={:#x}",
        frame.esr,
        frame.ec(),
        frame.elr,
        frame.far
    );
    let code = 0xE0u32.saturating_add(u32::try_from(kind & 0xf).unwrap_or(0));
    crate::hvc::debug_exit(code)
}
