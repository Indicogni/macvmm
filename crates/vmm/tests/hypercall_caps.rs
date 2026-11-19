//! Host security tests: hypercall caps and the reboot loop (PLAN M5 "Security tests"; threat
//! model HC-2, HC-5, HOSTIO-1; flaws F3, F7).
//!
//! - `memhash_len_cap`: DEBUG_MEMHASH with `len = 1 GiB + 1` is `-2` (HC-2).
//! - `memhash_stops_between_chunks`: a 1 GiB hash whose stop flag is raised after the first
//!   64 MiB chunk returns early, having read about 64 MiB, not 1 GiB (HC-2, F7).
//! - `debug_hvc_defaults`: under `DebugHvc::Auto` the debug calls are off for an arm64 Image
//!   boot and on for ELF and `--raw`; `--debug-hvc` / `--no-debug-hvc` override (HC-2).
//! - `debug_hvc_auto_image_off` (M10): the same, for the real Alpine 6.18 Image header.
//! - `reset_storm_*`: the reboot loop turns the 11th reset within 10 s into
//!   `GuestFatal("reset storm")` (exit 3) and does not trip on resets spread over time; the
//!   clock is injected (HC-5).
//! - `timeout_spans_reboots`: `--timeout` is one deadline for the whole run. Resets spread
//!   out so HC-5 never trips still end in `Timeout` (exit 5) once it passes, and every boot is
//!   handed the same absolute deadline (architecture §13.1; injected clock).
//! - `reboot_reads_no_paths`: a `HostIo` built from a temp file keeps working after the file is
//!   deleted: two in-process reboots plan and load the machine from `HostIo`'s bytes alone
//!   (HOSTIO-1, F3), with a fake VM builder in place of HVF.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use vmm::backend::serial::Sink;
use vmm::config::{BootSource, DebugHvc, RawSpec, ResetAction, SinkKind, SinkSpec, VmConfig};
use vmm::control::{StopReason, VmControl};
use vmm::loader::BootInputs;
use vmm::memory::{GuestAddress, GuestMemory, MemoryError, VecMemory};
use vmm::smccc::{MAX_MEMHASH_LEN, MEMHASH_STOP_CHUNK, memhash};
use vmm::{HostIo, machine};

const RAM: u64 = 0x4000_0000;

#[test]
fn memhash_len_cap() {
    let mem = VecMemory::new(&[(GuestAddress(RAM), 1 << 20)]).unwrap();
    let ctl = VmControl::new();
    assert_eq!(memhash(&mem, RAM, MAX_MEMHASH_LEN + 1, &ctl), None);
    assert_eq!(MAX_MEMHASH_LEN, 1 << 30);
    assert!(memhash(&mem, RAM, 1 << 20, &ctl).is_some());
}

/// A 1 GiB "RAM" with no backing: reads return zeros and are counted; after `stop_after`
/// bytes the VM's stop is requested, as a Ctrl-A x on another thread would.
struct Counting<'a> {
    read: AtomicU64,
    stop_after: u64,
    ctl: &'a VmControl,
}

impl GuestMemory for Counting<'_> {
    fn read(&self, _addr: GuestAddress, buf: &mut [u8]) -> Result<(), MemoryError> {
        buf.fill(0);
        let n = self.read.fetch_add(buf.len() as u64, Ordering::SeqCst) + buf.len() as u64;
        if n >= self.stop_after {
            self.ctl.request_stop(StopReason::UserQuit);
        }
        Ok(())
    }
    fn write(&self, addr: GuestAddress, buf: &[u8]) -> Result<(), MemoryError> {
        Err(MemoryError::OutOfBounds {
            addr: addr.0,
            len: buf.len() as u64,
        })
    }
    fn check_range(&self, addr: GuestAddress, len: u64) -> bool {
        len > 0
            && addr.0 >= RAM
            && addr
                .0
                .checked_add(len)
                .is_some_and(|e| e <= RAM + (1 << 30))
    }
}

#[test]
fn memhash_stops_between_chunks() {
    let ctl = VmControl::new();
    let mem = Counting {
        read: AtomicU64::new(0),
        stop_after: MEMHASH_STOP_CHUNK,
        ctl: &ctl,
    };
    assert_eq!(
        memhash(&mem, RAM, MAX_MEMHASH_LEN, &ctl),
        None,
        "stopped: -2"
    );
    let read = mem.read.load(Ordering::SeqCst);
    assert!(
        (MEMHASH_STOP_CHUNK..=MEMHASH_STOP_CHUNK + (64 << 10)).contains(&read),
        "read {read} bytes"
    );
    // Without a stop the full 1 GiB is hashed (zeros) and succeeds.
    let ctl = VmControl::new();
    let mem = Counting {
        read: AtomicU64::new(0),
        stop_after: u64::MAX,
        ctl: &ctl,
    };
    assert!(memhash(&mem, RAM, MAX_MEMHASH_LEN, &ctl).is_some());
    assert_eq!(mem.read.load(Ordering::SeqCst), MAX_MEMHASH_LEN);
}

fn host_with(kernel: Option<Vec<u8>>, raw: Vec<(u64, Vec<u8>)>) -> HostIo {
    HostIo::from_bytes(
        kernel.map(Arc::from),
        raw.into_iter().map(|(a, b)| (a, Arc::from(b))).collect(),
        Arc::new(Sink::none()),
    )
}

#[test]
fn debug_hvc_defaults() {
    // An arm64 Image: `ARM\x64` at offset 56 (booting.rst §4).
    let mut image = vec![0u8; 64];
    image[56..60].copy_from_slice(b"ARM\x64");
    let elf = b"\x7fELF\x02\x01\x01".to_vec();
    let image_boot = host_with(Some(image), vec![]);
    let elf_boot = host_with(Some(elf), vec![]);
    let raw_boot = host_with(None, vec![(RAM + 0x8_0000, vec![0; 4])]);
    let mut cfg = VmConfig::default();
    assert_eq!(cfg.debug_hvc, DebugHvc::Auto);
    let on = |cfg: &VmConfig, h: &HostIo| cfg.debug_calls_enabled(machine::is_test_guest(cfg, h));
    assert!(!on(&cfg, &image_boot), "Image: off under Auto");
    assert!(on(&cfg, &elf_boot), "ELF: on under Auto");
    assert!(on(&cfg, &raw_boot), "--raw: on under Auto");
    cfg.debug_hvc = DebugHvc::On;
    assert!(on(&cfg, &image_boot), "--debug-hvc overrides");
    cfg.debug_hvc = DebugHvc::Off;
    assert!(!on(&cfg, &elf_boot), "--no-debug-hvc overrides");
}

/// The first 64 bytes of Alpine 6.18.60-0-virt's `Image-virt` (the arm64 Image header,
/// booting.rst §4: `MZ` + branch, text_offset 0, image_size 0x22a_0000, flags 0xa, `ARM\x64`
/// at 56, PE offset 0x40). A header is not kernel code; the full Image is never committed.
const ALPINE_IMAGE_HEADER: [u8; 64] = [
    0x4d, 0x5a, 0x40, 0xfa, 0x27, 0xb4, 0x55, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x2a, 0x02, 0x00, 0x00, 0x00, 0x00, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x52, 0x4d, 0x64, 0x40, 0x00, 0x00, 0x00,
];

/// PLAN M10 security test (HC-2): `debug_hvc_defaults` rerun against the *real* Alpine Image
/// header, not a synthetic one: `DebugHvc::Auto` resolves to off. When `scripts/fetch.sh linux`
/// has run, the cached `Image-virt` must start with exactly these bytes, so the fixture cannot
/// drift from the pinned kernel (the sha256 pin in fetch-manifest.txt covers the rest). The
/// cache is found by the e2e rule (`macvmm/tests/support` `cache_dir`): `MACVMM_CACHE`, a
/// relative value taken from the repo root, default `<repo>/.cache/macvmm`. Without the file
/// (a host-only `cargo test` before any fetch) the cross-check is skipped with a note on stderr,
/// and the rest of the test still runs on the fixture.
#[test]
fn debug_hvc_auto_image_off() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let cache = match std::env::var_os("MACVMM_CACHE") {
        Some(c) if std::path::Path::new(&c).is_absolute() => std::path::PathBuf::from(c),
        Some(c) => repo.join(c),
        None => repo.join(".cache/macvmm"),
    };
    let image = cache.join("Image-virt");
    match std::fs::read(&image) {
        Ok(real) => assert_eq!(
            real.get(..64),
            Some(&ALPINE_IMAGE_HEADER[..]),
            "the cached Image-virt header differs from the fixture"
        ),
        Err(e) => {
            // A note on the test's stderr (crates/vmm bans the print macros, RUST-5).
            use std::io::Write as _;
            let _ = writeln!(
                std::io::stderr(),
                "note: {} not readable ({e}): fixture not cross-checked against the real \
                 Image; run scripts/fetch.sh linux",
                image.display()
            );
        }
    }
    let mut kernel = ALPINE_IMAGE_HEADER.to_vec();
    kernel.resize(4096, 0);
    assert_eq!(
        vmm::loader::detect(&kernel),
        vmm::loader::ImageKind::ArmImage,
        "the Alpine header is detected as an arm64 Image"
    );
    let host = host_with(Some(kernel), vec![]);
    let cfg = VmConfig::default();
    assert_eq!(cfg.debug_hvc, DebugHvc::Auto);
    assert!(
        !machine::is_test_guest(&cfg, &host),
        "an Image is not a test guest"
    );
    assert!(
        !cfg.debug_calls_enabled(machine::is_test_guest(&cfg, &host)),
        "DebugHvc::Auto must be off for the Alpine Image (HC-2)"
    );
}

fn raw_cfg(path: std::path::PathBuf) -> VmConfig {
    let mut cfg = VmConfig::default();
    cfg.mem_bytes = 64 << 20;
    cfg.boot = BootSource {
        kernel: None,
        raw: vec![RawSpec {
            path,
            addr: RAM + 0x8_0000,
        }],
        ..BootSource::default()
    };
    cfg.serial = SinkSpec {
        kind: SinkKind::None,
        ..SinkSpec::default()
    };
    cfg
}

#[test]
fn reset_storm_trips_on_the_eleventh_within_ten_seconds() {
    let cfg = raw_cfg("unused.bin".into());
    let host = host_with(None, vec![(RAM + 0x8_0000, vec![0; 4])]);
    let t0 = Instant::now();
    let tick = Mutex::new(0u64);
    let mut boots = 0u64;
    let r = vmm::run_with(
        &cfg,
        &host,
        || {
            let mut t = tick.lock().unwrap();
            *t += 1;
            t0 + Duration::from_millis(*t * 10)
        },
        |_, _, generation, _| {
            assert_eq!(generation, boots, "generation counts the boots");
            boots += 1;
            Ok(StopReason::Reset)
        },
    )
    .unwrap();
    match r {
        StopReason::GuestFatal(g) => assert!(g.reason.starts_with("reset storm"), "{}", g.reason),
        other => panic!("{other:?}"),
    }
    assert_eq!(boots, 11, "10 reboots allowed, the 11th reset trips");
}

#[test]
fn reset_storm_spread_resets_do_not_trip() {
    let cfg = raw_cfg("unused.bin".into());
    let host = host_with(None, vec![(RAM + 0x8_0000, vec![0; 4])]);
    let t0 = Instant::now();
    let mut t = 0u64;
    let mut boots = 0u64;
    let r = vmm::run_with(
        &cfg,
        &host,
        || {
            t += 1;
            t0 + Duration::from_millis(t * 1100) // 10 resets take 11 s
        },
        |_, _, generation, _| {
            boots += 1;
            Ok(if generation < 30 {
                StopReason::Reset
            } else {
                StopReason::PowerOff
            })
        },
    )
    .unwrap();
    assert!(matches!(r, StopReason::PowerOff), "{r:?}");
    assert_eq!(boots, 31);
    // `--on-reset exit`: the first reset is the verdict (exit code 4), no reboot.
    let mut cfg = cfg;
    cfg.on_reset = ResetAction::Exit;
    let mut boots = 0;
    let r = vmm::run_with(&cfg, &host, Instant::now, |_, _, _, _| {
        boots += 1;
        Ok(StopReason::Reset)
    })
    .unwrap();
    assert_eq!((r.exit_code(), boots), (4, 1));
}

#[test]
fn timeout_spans_reboots() {
    let mut cfg = raw_cfg("unused.bin".into());
    cfg.timeout = Some(Duration::from_secs(3));
    let host = host_with(None, vec![(RAM + 0x8_0000, vec![0; 4])]);
    let t0 = Instant::now();
    // The fake clock: each boot "runs" 1.1 s before it resets, so 10 resets take 11 s and the
    // storm limit never trips (as `reset_storm_spread_resets_do_not_trip`).
    let clock = std::cell::Cell::new(t0);
    let mut deadlines = Vec::new();
    let r = vmm::run_with(
        &cfg,
        &host,
        || clock.get(),
        |_, _, generation, deadline| {
            deadlines.push(deadline);
            assert!(generation < 100, "a reset loop must not outlive --timeout");
            let d = deadline.expect("--timeout set: every boot gets the deadline");
            let end = clock.get() + Duration::from_millis(1100);
            if end >= d {
                // What `Machine::run` does when the shared deadline passes mid-boot.
                clock.set(d);
                return Ok(StopReason::Timeout);
            }
            clock.set(end);
            Ok(StopReason::Reset)
        },
    )
    .unwrap();
    assert!(matches!(r, StopReason::Timeout), "{r:?}");
    assert_eq!(r.exit_code(), 5);
    let want = Some(t0 + Duration::from_secs(3));
    assert_eq!(deadlines, [want; 3], "boots 0, 1, 2 share one deadline");

    // A reset that comes back after the deadline is a timeout, without another boot.
    let clock = std::cell::Cell::new(t0);
    let mut boots = 0;
    let r = vmm::run_with(
        &cfg,
        &host,
        || clock.get(),
        |_, _, _, _| {
            boots += 1;
            clock.set(t0 + Duration::from_secs(4));
            Ok(StopReason::Reset)
        },
    )
    .unwrap();
    assert_eq!((r.exit_code(), boots), (5, 1));

    // No `--timeout`: no deadline, the reboot loop runs until the guest stops.
    cfg.timeout = None;
    let r = vmm::run_with(&cfg, &host, Instant::now, |_, _, generation, deadline| {
        assert_eq!(deadline, None);
        Ok(if generation < 3 {
            StopReason::Reset
        } else {
            StopReason::PowerOff
        })
    })
    .unwrap();
    assert!(matches!(r, StopReason::PowerOff), "{r:?}");
}

#[test]
fn reboot_reads_no_paths() {
    let dir = std::env::temp_dir().join(format!("macvmm-reboot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("guest.bin");
    let payload: Vec<u8> = (0..4096u32).map(|i| (i * 31 + 7) as u8).collect();
    std::fs::write(&path, &payload).unwrap();
    let cfg = raw_cfg(path.clone());
    let host = HostIo::open(&cfg).unwrap();
    // The file is gone (and could have been replaced): the reboots must not notice.
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, b"swapped between boots").unwrap();
    std::fs::remove_file(&path).unwrap();
    let mut seen = Vec::new();
    let r = vmm::run_with(&cfg, &host, Instant::now, |cfg, host, generation, _| {
        // The fake VM builder: everything `Machine::build` does before HVF, from `host` only.
        let plan = machine::plan_boot(cfg, host)?;
        let mem = VecMemory::new(&[(GuestAddress(RAM), cfg.mem_bytes)]).unwrap();
        let inputs = BootInputs {
            kernel: host.kernel.as_deref(),
            raw: &host.raw,
            ..BootInputs::default()
        };
        vmm::loader::plan::load(&plan, &inputs, &mem)?;
        let mut back = vec![0u8; payload.len()];
        mem.read(GuestAddress(RAM + 0x8_0000), &mut back).unwrap();
        assert_eq!(back, payload, "boot {generation} loaded the original bytes");
        seen.push(generation);
        Ok(if generation < 2 {
            StopReason::Reset
        } else {
            StopReason::PowerOff
        })
    })
    .unwrap();
    assert!(matches!(r, StopReason::PowerOff));
    assert_eq!(seen, [0, 1, 2], "two in-process reboots");
    let _ = std::fs::remove_dir_all(&dir);
}
