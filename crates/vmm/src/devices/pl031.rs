//! `Pl031`: the ARM PrimeCell Real Time Clock (PL031) at `0x0901_0000`: how a guest learns
//! the wall-clock time at boot (architecture §10; course ch09; threat model MMIO-8, MMIO-9).
//!
//! **Why an RTC at all.** The architected counter (`CNTVCT_EL0`) says how much time *passed*,
//! not what time it *is*. Linux reads the date once from an RTC (`rtc-pl031`, then
//! `hctosys`), and so does `uart-echo` (it prints the year). QEMU's `virt` board has a PL031,
//! so the guest needs no driver of ours.
//!
//! Registers (*ARM PrimeCell Real Time Clock (PL031) TRM*, ARM DDI 0224B, §3.2-§3.3):
//!
//! | Offset | Register | Model |
//! |---|---|---|
//! | 0x000 | `RTCDR` (§3.3.1) | read-only: host wall-clock seconds + the guest's offset, as a u32 |
//! | 0x004 | `RTCMR` (§3.3.2) | the match value; writing it arms the match interrupt |
//! | 0x008 | `RTCLR` (§3.3.3) | write: set the clock (`DR` becomes this value from now on); read: the last value loaded |
//! | 0x00c | `RTCCR` (§3.3.4) | reads 1 (the counter always runs); writes ignored |
//! | 0x010 | `RTCIMSC` (§3.3.5) | bit 0 masks the match interrupt |
//! | 0x014 | `RTCRIS` (§3.3.6) | bit 0: the match happened |
//! | 0x018 | `RTCMIS` (§3.3.7) | `RIS & IMSC` |
//! | 0x01c | `RTCICR` (§3.3.8) | write 1 to clear `RIS` |
//! | 0xfe0-0xfec | `RTCPeriphID0-3` | `31 10 14 00` |
//! | 0xff0-0xffc | `RTCPCellID0-3` | `0d f0 05 b1` |
//!
//! **Time and the guest's offset (MMIO-9).** `DR = host_seconds + offset`, where `offset` is
//! what the guest set with `LR` and the host time is the wall clock (`SystemTime::now()`), read
//! on every access and clamped so it never goes below the last value returned ([`host_clock`]).
//! Reading the wall clock each time keeps `DR` right across host sleep: a monotonic clock such
//! as Rust's `Instant` (`CLOCK_UPTIME_RAW` on Darwin) stops while the Mac sleeps, so "boot
//! time + elapsed" would lag the real date by the total sleep time. The clamp keeps the other
//! property an RTC needs: if the host clock is stepped backwards (NTP), `DR` holds still until
//! the wall clock catches up instead of running backwards. The RTC counts in 32-bit seconds and wraps, so the arithmetic is
//! `wrapping_*` on u32 by definition: a guest that loads `LR = 0xffff_fff0` sees `DR` wrap to 0
//! after 16 s, and no value can overflow anything.
//!
//! **The match interrupt.** The PL031 raises it when the counter *equals* `MR` (TRM §3.3.2, `RTCMR`), so
//! an `MR` in the past fires only after the 32-bit counter wraps, some 136 years later. As in
//! QEMU's `pl031_set_alarm`, a write to `MR` or `LR` arms the alarm `MR - DR` seconds (unsigned,
//! wrapping u32) into the future, firing at once if that is 0; a later `LR` write re-arms it
//! from the new `DR`. Once the host clock reaches the armed second, `RIS` is set and the line
//! is driven to `RIS & IMSC` (architecture §6.3).
//!
//! **Who notices the match (M8).** A guest that arms an alarm (Linux `rtc-pl031` writes `MR`
//! and `IMSC`, then waits for the interrupt) does not touch the device again until the
//! interrupt arrives, so the match cannot wait for a register access. The first arming starts
//! one helper thread per RTC (`pl031-alarm`): it sleeps on a condvar until the armed second
//! (at most [`ALARM_MAX_SLEEP`] at a time, then [`ALARM_POLL`] slices within the last second,
//! because the host clock counts whole seconds and its phase is unknown), then sets `RIS` and
//! drives the line under the device's state lock, exactly as a register access would. Every
//! access also still checks the match, so the result is the same whichever comes first. A far
//! alarm (an `MR` in the past is ~136 years away) costs one wake-up a minute; an RTC whose
//! alarm is never armed has no thread. Dropping the device stops and joins it. Lock order: the
//! thread takes only the RTC's inner state lock, never the bus's device mutex, and
//! `IrqLine::set_level` does not block (architecture §14.2).
//!
//! **Total over the window (MMIO-8)**: 8-, 16- and 32-bit accesses at 4-byte-aligned register
//! offsets work; anything else is RAZ/WI with a rate-limited `guest_warn!`.
#![deny(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::cast_possible_truncation
)]

use crate::bus::{AccessSize, MmioDevice};
use crate::irq::IrqLine;
use crate::sync::lock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

/// The window size (architecture §5.1 `pl031` row).
pub const PL031_SIZE: u64 = 0x1000;

pub const DR: u64 = 0x000;
pub const MR: u64 = 0x004;
pub const LR: u64 = 0x008;
pub const CR: u64 = 0x00c;
pub const IMSC: u64 = 0x010;
pub const RIS: u64 = 0x014;
pub const MIS: u64 = 0x018;
pub const ICR: u64 = 0x01c;
/// First identification register (`RTCPeriphID0`).
pub const ID_BASE: u64 = 0xfe0;
/// `RTCPeriphID0-3`, `RTCPCellID0-3` (TRM §3.3.9-16; QEMU `pl031_id`).
pub const ID_BYTES: [u8; 8] = [0x31, 0x10, 0x14, 0x00, 0x0d, 0xf0, 0x05, 0xb1];

// ANCHOR: pl031_host_clock
/// Where the host's seconds come from: the real clock, or a test's.
pub type WallClock = Box<dyn Fn() -> u64 + Send>;

/// Host wall-clock seconds, read on every call and never below the last value returned
/// (module docs: correct across host sleep, never backwards).
pub fn host_clock() -> WallClock {
    let last = AtomicU64::new(0);
    Box::new(move || {
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        last.fetch_max(now, Ordering::Relaxed).max(now)
    })
}
// ANCHOR_END: pl031_host_clock

/// The longest one alarm-thread sleep lasts before it re-reads the host clock: the wall
/// clock can jump (host sleep, NTP) while a monotonic wait does not see it.
pub const ALARM_MAX_SLEEP: Duration = Duration::from_secs(60);

/// The alarm thread's re-check period within the last second before the match (the host
/// clock counts whole seconds, so this bounds how late the interrupt can be).
pub const ALARM_POLL: Duration = Duration::from_millis(100);

/// The RTC's registers and match state, shared with the alarm thread.
struct Regs {
    clock: WallClock,
    /// `DR - host_seconds`, wrapping (set through `LR`).
    offset: u32,
    mr: u32,
    lr: u32,
    imsc: u32,
    ris: u32,
    /// The host second (as [`WallClock`] counts) at which the armed match fires; `None` when
    /// no match is pending.
    alarm: Option<u64>,
    irq: Arc<dyn IrqLine>,
    /// Ends the alarm thread (set by `Drop`).
    quit: bool,
}

struct Shared {
    regs: Mutex<Regs>,
    cv: Condvar,
}

/// The ARM PL031 RTC (module docs).
pub struct Pl031 {
    shared: Arc<Shared>,
    /// The alarm thread, started by the first arming (module docs).
    alarm_thread: Option<JoinHandle<()>>,
    /// Spawning it failed once; the match is then evaluated on register accesses only.
    no_thread: bool,
}

impl core::fmt::Debug for Pl031 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let r = lock(&self.shared.regs);
        f.debug_struct("Pl031")
            .field("offset", &r.offset)
            .field("mr", &r.mr)
            .field("ris", &r.ris)
            .field("alarm", &r.alarm)
            .finish_non_exhaustive()
    }
}

impl Pl031 {
    /// An RTC reading the host's wall clock.
    pub fn new(irq: Arc<dyn IrqLine>) -> Pl031 {
        Pl031::with_clock(host_clock(), irq)
    }

    /// An RTC reading `clock` (seconds since the Unix epoch).
    pub fn with_clock(clock: WallClock, irq: Arc<dyn IrqLine>) -> Pl031 {
        Pl031 {
            shared: Arc::new(Shared {
                regs: Mutex::new(Regs {
                    clock,
                    offset: 0,
                    mr: 0,
                    lr: 0,
                    imsc: 0,
                    ris: 0,
                    alarm: None,
                    irq,
                    quit: false,
                }),
                cv: Condvar::new(),
            }),
            alarm_thread: None,
            no_thread: false,
        }
    }

    /// `RTCDR`: the guest's view of the time (MMIO-9).
    pub fn dr(&self) -> u32 {
        lock(&self.shared.regs).dr()
    }

    /// Start the alarm thread if a match is armed and none runs yet, and wake it so it sees the
    /// new deadline.
    fn kick_alarm(&mut self) {
        if self.alarm_thread.is_none() && !self.no_thread {
            let sh = Arc::clone(&self.shared);
            match std::thread::Builder::new()
                .name("pl031-alarm".into())
                .spawn(move || alarm_loop(&sh))
            {
                Ok(t) => self.alarm_thread = Some(t),
                Err(e) => {
                    self.no_thread = true;
                    crate::warn!(
                        "pl031: cannot start the alarm thread ({e}); the match interrupt fires only on RTC accesses"
                    );
                }
            }
        }
        self.shared.cv.notify_one();
    }
}

impl Drop for Pl031 {
    fn drop(&mut self) {
        lock(&self.shared.regs).quit = true;
        self.shared.cv.notify_one();
        if let Some(t) = self.alarm_thread.take() {
            let _ = t.join();
        }
    }
}

// ANCHOR: pl031_alarm_thread
/// The alarm thread (module docs, "Who notices the match"): wait for the armed host second,
/// then set `RIS` and drive the line, under the same lock as the registers.
fn alarm_loop(sh: &Shared) {
    let mut r = lock(&sh.regs);
    loop {
        if r.quit {
            return;
        }
        let wait = match r.alarm {
            None => None,
            Some(at) => {
                let now = (r.clock)();
                if now >= at {
                    r.check_match();
                    r.update_irq();
                    continue;
                }
                let left = at.saturating_sub(now);
                Some(if left > 1 {
                    Duration::from_secs(left.saturating_sub(1)).min(ALARM_MAX_SLEEP)
                } else {
                    ALARM_POLL
                })
            }
        };
        r = match wait {
            None => sh.cv.wait(r).unwrap_or_else(PoisonError::into_inner),
            Some(d) => {
                sh.cv
                    .wait_timeout(r, d)
                    .unwrap_or_else(PoisonError::into_inner)
                    .0
            }
        };
    }
}
// ANCHOR_END: pl031_alarm_thread

impl Regs {
    fn host_secs(&self) -> u32 {
        low32((self.clock)())
    }

    // ANCHOR: pl031_read_dr
    /// `RTCDR`: the guest's view of the time, `host + offset` in wrapping u32 seconds.
    fn dr(&self) -> u32 {
        self.host_secs().wrapping_add(self.offset)
    }
    // ANCHOR_END: pl031_read_dr

    // ANCHOR: pl031_match
    /// Arm the match for when the counter next *equals* `MR`: `MR - DR` seconds from now,
    /// unsigned and wrapping, so an `MR` in the past is ~2^32 s away (module docs; QEMU
    /// `pl031_set_alarm`).
    fn arm(&mut self) {
        let now = (self.clock)();
        let ticks = self.mr.wrapping_sub(low32(now).wrapping_add(self.offset));
        self.alarm = Some(now.saturating_add(u64::from(ticks)));
    }

    /// Set the match flag once the armed second has come (on an access or from the alarm
    /// thread, whichever is first).
    fn check_match(&mut self) {
        if self.alarm.is_some_and(|at| (self.clock)() >= at) {
            self.alarm = None;
            self.ris = 1;
        }
    }
    // ANCHOR_END: pl031_match

    fn update_irq(&self) {
        self.irq.set_level(self.ris & self.imsc & 1 != 0);
    }

    // ANCHOR: pl031_read_reg
    fn read_reg(&self, offset: u64) -> Option<u32> {
        Some(match offset {
            DR => self.dr(),
            MR => self.mr,
            LR => self.lr,
            CR => 1,
            IMSC => self.imsc,
            RIS => self.ris,
            MIS => self.ris & self.imsc,
            ICR => 0,
            0xfe0..=0xffc => {
                let i = usize::try_from(offset.checked_sub(ID_BASE)? / 4).ok()?;
                u32::from(*ID_BYTES.get(i)?)
            }
            _ => return None,
        })
    }
    // ANCHOR_END: pl031_read_reg

    // ANCHOR: pl031_write_reg
    fn write_reg(&mut self, offset: u64, v: u32) -> bool {
        match offset {
            MR => {
                self.mr = v;
                self.arm();
            }
            LR => {
                // From now on DR counts up from `v` (TRM §3.3.3): wrapping, by definition. The
                // counter jumped, so the match is re-armed from the new value (QEMU does the
                // same).
                self.lr = v;
                self.offset = v.wrapping_sub(self.host_secs());
                self.arm();
            }
            IMSC => self.imsc = v & 1,
            ICR => self.ris &= !(v & 1),
            DR | CR | RIS | MIS | 0xfe0..=0xffc => {} // read-only, or writes ignored
            _ => return false,
        }
        true
    }
    // ANCHOR_END: pl031_write_reg
}

/// The RTC is a 32-bit seconds counter: keep the low 32 bits (it wraps in 2106).
fn low32(secs: u64) -> u32 {
    u32::try_from(secs & 0xffff_ffff).unwrap_or(0)
}

fn reg_offset(offset: u64, size: AccessSize) -> Option<u64> {
    (offset.is_multiple_of(4) && size != AccessSize::B8 && offset < PL031_SIZE).then_some(offset)
}

impl MmioDevice for Pl031 {
    fn read(&mut self, offset: u64, size: AccessSize) -> u64 {
        let v = {
            let mut r = lock(&self.shared.regs);
            r.check_match();
            let v = reg_offset(offset, size).and_then(|o| r.read_reg(o));
            r.update_irq();
            v
        };
        match v {
            Some(v) => u64::from(v) & size.mask(),
            None => {
                crate::guest_warn!(
                    "pl031: {}-byte read at offset {offset:#x} names no register (read as zero)",
                    size.bytes()
                );
                0
            }
        }
    }

    fn write(&mut self, offset: u64, size: AccessSize, value: u64) {
        let v = u32::try_from(value & size.mask() & 0xffff_ffff).unwrap_or(0);
        let (ok, armed) = {
            let mut r = lock(&self.shared.regs);
            let ok = reg_offset(offset, size).is_some_and(|o| r.write_reg(o, v));
            r.check_match();
            r.update_irq();
            (ok, r.alarm.is_some())
        };
        if armed {
            self.kick_alarm();
        }
        if !ok {
            crate::guest_warn!(
                "pl031: {}-byte write at offset {offset:#x} names no register (ignored)",
                size.bytes()
            );
        }
    }
}
