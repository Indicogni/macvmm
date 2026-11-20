//! The QEMU-`virt`-compatible board (architecture §5.1, ADR-0003): what `Machine::build` puts
//! where. The addresses themselves live only in `arch/layout.rs` (the single source of truth);
//! this file says which of them a `virt` machine populates.
//!
//! **M3** populates only RAM: one region at `RAM_BASE` of `--mem` bytes. The in-kernel GIC is
//! created by `vm::create_vm`. Device registration ([`register_devices`]: the testdev in M4;
//! virtio-mmio slots from M11) is added here, one block per device, by the milestone that brings
//! it (PLAN §2.1: additive, block-local edits). The devices every machine has (M6: the PL011,
//! the PL031, the unused GIC redistributor frames) are [`register_platform`].
//!
//! **M11: virtio-mmio.** All 32 slots are on the bus ([`register_virtio_with`]); the populated
//! ones ([`virtio_populated`]) also get a DT node.
//!
//! **M12: devices in slots.** [`virtio_assignment`] packs the requested devices into slots in
//! the ADR-0005 order (disks, rng, console, net); each populated slot gets its device model, an
//! interrupt line on SPI 16 + slot, and a worker thread (`virtio::worker`).
//!
//! **M14: disks.** Each `--disk` becomes a virtio-blk ([`VirtioKind::Blk`]) in CLI order, before
//! every other device, over the `HostIo` disk backend it names (`VirtioEnv::disks`).
//!
//! **M13: the console.** `--console` adds a virtio-console after `--rng`; when stdin is bound
//! to it (`--console stdio`), its input queue's push hook rings the console worker's receiveq
//! doorbell ([`connect_console_input`]).
//!
//! **M24: NICs.** Each `--net` becomes a virtio-net ([`VirtioKind::Net`]) after the console,
//! over the `HostIo` socket it names (`VirtioEnv::nets`). Besides its worker (TX) a NIC has an
//! RX thread (`virtio::net::spawn_rx`), attached to the worker as its `Companion`, so it is
//! stopped and joined with the workers before guest RAM is freed (MEM-9).
//!
//! **M8: interrupt lines.** With the in-kernel GIC, [`platform_irqs`] wires the PL011 to SPI 1
//! (INTID 33) and the PL031 to SPI 2 (INTID 34), each a validated `irq::GicSpi` built from the
//! live GIC's SPI range ([`register_platform_with`]). In the `--irqchip none` teaching mode
//! there is no controller, so both lines are `NullIrq` (architecture §9.1).

use crate::arch::layout::{
    GICR_BASE, GICR_WINDOW_END, Layout, PL011_BASE, PL011_INTID, PL031_BASE, PL031_INTID, RAM_BASE,
    TESTDEV_BASE,
};
use crate::backend::entropy::Entropy;
use crate::backend::file::BlockBackend;
use crate::backend::serial::{SerialInput, SinkHandle};
use crate::bus::Bus;
use crate::config::VmConfig;
use crate::control::VmControl;
use crate::devices::pl011::{PL011_SIZE, Pl011};
use crate::devices::pl031::{PL031_SIZE, Pl031};
use crate::devices::razwi::RazWi;
use crate::devices::testdev::{TESTDEV_SIZE, TestDev};
use crate::error::{Error, Result};
use crate::irq::{GicSpi, IrqLine, NullIrq, SpiLimits};
use crate::memory::{GuestAddress, GuestMemoryOrdered};
use crate::virtio::mmio::WINDOW_SIZE as VIRTIO_WINDOW;
use crate::virtio::{
    Blk, Console, QueueNotifier, Rng, VirtioDevice, VirtioInterrupt, VirtioMmio, Worker,
};
use std::sync::{Arc, Mutex};

/// The RAM regions of a `virt` machine with `size` bytes of RAM (already validated by
/// `Layout::ram_end`).
pub fn ram_regions(size: u64) -> [(GuestAddress, u64); 1] {
    [(GuestAddress(RAM_BASE), size)]
}

// ANCHOR: testdev_register
/// Put the devices `cfg` asks for on `bus` (one block per device).
pub fn register_devices(cfg: &VmConfig, bus: &mut Bus) -> Result<()> {
    // The scratch-register test device, only with --testdev.
    if cfg.testdev {
        bus.insert(
            "testdev",
            TESTDEV_BASE,
            TESTDEV_SIZE,
            Arc::new(Mutex::new(TestDev::new())),
        )
        .map_err(Error::Bus)?;
    }
    Ok(())
}
// ANCHOR_END: testdev_register

// ANCHOR: slot_assignment
/// The device model in a populated virtio-mmio slot (architecture §11.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VirtioKind {
    /// virtio-blk (M14) over `--disk` number `n` (an index into `VirtioEnv::disks`).
    Blk(usize),
    /// virtio-rng (M12, `--rng`).
    Rng,
    /// virtio-console (M13, `--console`).
    Console,
    /// virtio-net (M24) over `--net` number `n` (an index into `VirtioEnv::nets`).
    Net(usize),
}

impl VirtioKind {
    /// The short name used for the worker thread (`virtio-rng-0`) and in logs.
    pub fn name(self) -> &'static str {
        match self {
            VirtioKind::Blk(_) => "blk",
            VirtioKind::Rng => "rng",
            VirtioKind::Console => "console",
            VirtioKind::Net(_) => "net",
        }
    }
}

/// Which device goes in which slot (ADR-0005 decision 2): `--disk` in CLI order, then `--rng`,
/// then `--console`, then `--net`, packed from slot 0. The order is fixed so that guest-visible
/// names are stable: the first `--disk` is always slot 0 and so always Linux's `/dev/vda`,
/// whatever other devices are added. Each milestone adds its block here, in that order.
pub fn virtio_assignment(cfg: &VmConfig) -> Vec<(usize, VirtioKind)> {
    let mut kinds: Vec<VirtioKind> = Vec::new();
    // M14: one entry per `--disk`, in CLI order, first: disk 0 is always /dev/vda.
    kinds.extend((0..cfg.disks.len()).map(VirtioKind::Blk));
    // M12: then `--rng`.
    if cfg.rng {
        kinds.push(VirtioKind::Rng);
    }
    // M13: then `--console`.
    if cfg.console.is_some() {
        kinds.push(VirtioKind::Console);
    }
    // M24: then one entry per `--net`, in CLI order.
    kinds.extend((0..cfg.net.len()).map(VirtioKind::Net));
    kinds.into_iter().enumerate().collect()
}
// ANCHOR_END: slot_assignment

/// The populated virtio-mmio slots for `cfg`, in slot order ([`virtio_assignment`]). The DTB
/// describes exactly these slots (`fdt/machine.rs`).
pub fn virtio_populated(cfg: &VmConfig) -> Vec<usize> {
    virtio_assignment(cfg)
        .into_iter()
        .map(|(slot, _)| slot)
        .collect()
}

/// What a populated slot needs from the machine being built (M12).
pub struct VirtioEnv<'a> {
    /// Guest RAM, where the rings and buffers live.
    pub mem: Arc<dyn GuestMemoryOrdered>,
    /// The in-kernel GIC (`None` in the `--irqchip none` mode and in host tests: then the
    /// device lines are `NullIrq`).
    pub gic: Option<&'a hvf::Gic>,
    /// The host CSPRNG (`HostIo.entropy`, FDT-3).
    pub entropy: Entropy,
    /// The VM a worker panic stops (RUST-7).
    pub ctl: Arc<VmControl>,
    /// M13: the console's TX sink (`HostIo.console`); required when `--console` is given.
    pub console: Option<SinkHandle>,
    /// M13: the console's input queue (`HostIo.console_input`) when stdin is bound to it
    /// (`--console stdio`), else `None`: the console then never receives.
    pub console_input: Option<Arc<SerialInput>>,
    /// M14: the `--disk` backends in command-line order (`HostIo.disks`: opened, checked and
    /// locked before any HVF call); `VirtioKind::Blk(n)` serves `disks[n]`.
    pub disks: Vec<Arc<dyn BlockBackend>>,
    /// M24: the `--net` sockets and MACs in command-line order (`HostIo.nets`: bound and
    /// checked before any HVF call); `VirtioKind::Net(n)` serves `nets[n]`.
    pub nets: Vec<crate::net::NetHost>,
}

// ANCHOR: virtio_register_empty
/// Put all 32 virtio-mmio transports on `bus` with no device in any of them (host tests).
/// Refuses a `cfg` that asks for a device: use [`register_virtio_with`].
pub fn register_virtio(cfg: &VmConfig, bus: &mut Bus) -> Result<()> {
    if !virtio_populated(cfg).is_empty() {
        return Err(Error::Internal(
            "register_virtio cannot build devices: use register_virtio_with",
        ));
    }
    for slot in 0..crate::arch::layout::VIRTIO_MMIO_SLOTS {
        let (base, _intid) = Layout::virt()
            .virtio_slot(slot)
            .ok_or(Error::Internal("virtio slot outside the layout"))?;
        insert_transport(bus, base, VirtioMmio::empty())?;
    }
    Ok(())
}
// ANCHOR_END: virtio_register_empty

fn insert_transport(bus: &mut Bus, base: u64, t: VirtioMmio) -> Result<()> {
    bus.insert("virtio-mmio", base, VIRTIO_WINDOW, Arc::new(Mutex::new(t)))
        .map_err(Error::Bus)
}

// ANCHOR: virtio_slots
/// Put all 32 virtio-mmio transports on `bus` (M11, architecture §11.1): the device
/// [`virtio_assignment`] names in each populated slot, each with its own interrupt line
/// (INTID 48 + slot on the in-kernel GIC, validated like the PL011's) and its own worker
/// thread ([`populated_slot`]), and an empty transport (`NullDevice`: Magic, Version 2,
/// DeviceID 0, the rest RAZ/WI) everywhere else, so firmware that probes every slot gets the
/// answer virtio 1.2 §4.2.3.1.1 defines instead of an unhandled-MMIO stop.
///
/// Returns the workers; the machine stops and joins them before it frees guest RAM (MEM-9).
/// Empty slots hold no guest-memory handle and no interrupt line: they can never activate.
pub fn register_virtio_with(
    cfg: &VmConfig,
    bus: &mut Bus,
    env: &VirtioEnv<'_>,
) -> Result<Vec<Arc<Worker>>> {
    let assigned = virtio_assignment(cfg);
    let layout = Layout::virt();
    let limits = match env.gic {
        Some(gic) => Some(SpiLimits::of(gic).map_err(|err| Error::Hv {
            op: "query the GIC's SPI range",
            err,
        })?),
        None => None,
    };
    let mut workers = Vec::new();
    for slot in 0..crate::arch::layout::VIRTIO_MMIO_SLOTS {
        let (base, intid) = layout
            .virtio_slot(slot)
            .ok_or(Error::Internal("virtio slot outside the layout"))?;
        let Some(&(_, kind)) = assigned.iter().find(|(s, _)| *s == slot) else {
            insert_transport(bus, base, VirtioMmio::empty())?;
            continue;
        };
        let line: Arc<dyn IrqLine> = match (env.gic, &limits) {
            (Some(gic), Some(limits)) => Arc::new(
                GicSpi::new(intid, limits, gic.handle())
                    .map_err(|e| Error::Config(format!("in-kernel GIC: {e}")))?,
            ),
            _ => Arc::new(NullIrq),
        };
        let (transport, worker) = populated_slot(kind, slot, line, env)?;
        // M13: typed input rings the console's receiveq (architecture §14.4).
        if let (VirtioKind::Console, Some(input)) = (kind, &env.console_input) {
            connect_console_input(input, &worker);
        }
        workers.push(worker);
        insert_transport(bus, base, transport)?;
    }
    Ok(workers)
}
// ANCHOR_END: virtio_slots

/// M14: the virtio-blk model for `--disk` number `n`, over the backend `HostIo` opened.
fn blk_device(env: &VirtioEnv<'_>, n: usize) -> Result<Arc<Mutex<dyn VirtioDevice>>> {
    let disk = env
        .disks
        .get(n)
        .ok_or(Error::Internal("--disk without an open disk image"))?;
    Ok(Arc::new(Mutex::new(Blk::new(Arc::clone(disk), n))))
}

// ANCHOR: virtio_slot_device
/// One populated slot: the device model, its transport, and its worker thread, which
/// is the transport's doorbell target (`QueueNotifier`), so a QueueNotify on a vCPU only sets
/// a bit and returns. The worker's per-queue budget is the device's queue maximum, so one busy
/// queue cannot starve the others.
fn populated_slot(
    kind: VirtioKind,
    slot: usize,
    line: Arc<dyn IrqLine>,
    env: &VirtioEnv<'_>,
) -> Result<(VirtioMmio, Arc<Worker>)> {
    // A NIC's typed handle, for its RX thread.
    let mut nic: Option<(usize, Arc<Mutex<crate::virtio::Net>>)> = None;
    let device: Arc<Mutex<dyn VirtioDevice>> = match kind {
        VirtioKind::Blk(n) => blk_device(env, n)?,
        VirtioKind::Rng => Arc::new(Mutex::new(Rng::new(env.entropy))),
        VirtioKind::Console => console_device(env)?,
        VirtioKind::Net(n) => {
            let host = env
                .nets
                .get(n)
                .ok_or(Error::Internal("--net without an open socket"))?;
            let dev = Arc::new(Mutex::new(crate::virtio::Net::new(
                host.mac,
                Arc::clone(&host.backend),
            )));
            nic = Some((n, Arc::clone(&dev)));
            dev
        }
    };
    let budgets = crate::sync::lock(&device).queue_max_sizes().to_vec();
    let interrupt = Arc::new(VirtioInterrupt::new(line));
    let mut transport = VirtioMmio::new(
        Arc::clone(&device),
        Arc::clone(&interrupt),
        Some(Arc::clone(&env.mem)),
    )
    .map_err(Error::Internal)?;
    let worker = Worker::spawn(
        &format!("virtio-{}-{slot}", kind.name()),
        device,
        Arc::clone(&interrupt),
        budgets,
        Arc::clone(&env.ctl),
    )
    .map_err(|_| Error::Internal("cannot spawn a virtio worker thread"))?;
    if let Some((n, dev)) = nic {
        attach_net_rx(&worker, slot, n, dev, interrupt, &env.ctl)?;
    }
    let notifier: Arc<dyn QueueNotifier> = worker.clone();
    transport.set_notifier(Some(notifier));
    Ok((transport, worker))
}
// ANCHOR_END: virtio_slot_device

// ANCHOR: net_rx_attach
/// Start NIC `n`'s RX thread (`virtio::net::spawn_rx`) and attach it to the slot's worker
/// as its `Companion`, so stopping the workers (before guest RAM is freed) also stops and
/// joins it, and its counters come out in `--stats`.
fn attach_net_rx(
    worker: &Worker,
    slot: usize,
    n: usize,
    dev: Arc<Mutex<crate::virtio::Net>>,
    interrupt: Arc<VirtioInterrupt>,
    ctl: &Arc<VmControl>,
) -> Result<()> {
    let rx = crate::virtio::net::spawn_rx(
        &format!("virtio-net-rx-{slot}"),
        &format!("net{n} slot {slot}"),
        dev,
        interrupt,
        Arc::clone(ctl),
    )
    .map_err(|_| Error::Internal("cannot spawn a virtio-net RX thread"))?;
    worker.attach(Arc::new(rx));
    Ok(())
}
// ANCHOR_END: net_rx_attach

/// M13: the virtio-console model over `HostIo`'s console sink and (when stdin is bound to it)
/// its input queue.
fn console_device(env: &VirtioEnv<'_>) -> Result<Arc<Mutex<dyn VirtioDevice>>> {
    let sink = env
        .console
        .clone()
        .ok_or(Error::Internal("--console without a console sink"))?;
    Ok(Arc::new(Mutex::new(Console::new(
        sink,
        env.console_input.clone(),
    ))))
}

// ANCHOR: console_input_hook
/// The console input hook: bytes the stdin thread pushes into the console's input queue ring
/// this boot's console worker for the receiveq, exactly as a guest QueueNotify would; the
/// worker fills whatever RX buffers are posted (`virtio::console`, anchor `console_rx`). The
/// hook holds a `Weak`, so it never keeps a torn-down boot's worker alive, and a doorbell for
/// a stopped worker is a no-op; the next boot installs its own hook.
fn connect_console_input(input: &Arc<SerialInput>, worker: &Arc<Worker>) {
    let weak = Arc::downgrade(worker);
    input.set_hook(Some(Arc::new(move || {
        if let Some(w) = weak.upgrade() {
            w.notify(crate::virtio::console::RX_QUEUE);
        }
    })));
}
// ANCHOR_END: console_input_hook

/// The interrupt lines of the platform devices.
#[derive(Clone)]
pub struct PlatformIrqs {
    pub pl011: Arc<dyn IrqLine>,
    pub pl031: Arc<dyn IrqLine>,
}

impl PlatformIrqs {
    /// Lines connected to nothing (no-GIC mode, host tests).
    pub fn none() -> PlatformIrqs {
        PlatformIrqs {
            pl011: Arc::new(NullIrq),
            pl031: Arc::new(NullIrq),
        }
    }
}

// ANCHOR: pl011_irq_wiring
/// The platform lines for this boot: `GicSpi(33)` for the PL011 and `GicSpi(34)` for the PL031
/// on the in-kernel GIC (each validated against the GIC's SPI range and the MSI block before
/// the guest runs, so a wiring bug can never reach the framework), or `NullIrq` without a GIC.
pub fn platform_irqs(gic: Option<&hvf::Gic>) -> Result<PlatformIrqs> {
    let Some(gic) = gic else {
        return Ok(PlatformIrqs::none());
    };
    let limits = SpiLimits::of(gic).map_err(|err| Error::Hv {
        op: "query the GIC's SPI range",
        err,
    })?;
    let line = |intid: u32| -> Result<Arc<dyn IrqLine>> {
        let spi = GicSpi::new(intid, &limits, gic.handle())
            .map_err(|e| Error::Config(format!("in-kernel GIC: {e}")))?;
        Ok(Arc::new(spi))
    };
    Ok(PlatformIrqs {
        pl011: line(PL011_INTID)?,
        pl031: line(PL031_INTID)?,
    })
}
// ANCHOR_END: pl011_irq_wiring

// ANCHOR: register_platform_wrapper
/// [`register_platform_with`] with both interrupt lines connected to nothing: the chapter 09
/// machine, and the host tests.
pub fn register_platform(
    bus: &mut Bus,
    serial: &SinkHandle,
    input: &Arc<SerialInput>,
    ncpus: u32,
) -> Result<Arc<Mutex<Pl011>>> {
    register_platform_with(bus, serial, input, ncpus, PlatformIrqs::none())
}
// ANCHOR_END: register_platform_wrapper

// ANCHOR: register_platform
/// Put the devices every `virt` machine has on `bus` (the memory map in `arch/layout.rs`):
/// - the PL011 UART0, transmitting to `serial` and receiving from `input`;
/// - the PL031 RTC;
/// - a RAZ/WI window over the part of the interrupt controller's per-CPU window that `ncpus`
///   vCPUs leave unused (one 128 KiB frame per vCPU; chapter 12 explains the frames).
///
/// Their interrupt lines are `irqs` (connected to nothing until the interrupt controller
/// arrives in chapter 12). Returns the UART so the caller can connect `input`'s push hook.
pub fn register_platform_with(
    bus: &mut Bus,
    serial: &SinkHandle,
    input: &Arc<SerialInput>,
    ncpus: u32,
    irqs: PlatformIrqs,
) -> Result<Arc<Mutex<Pl011>>> {
    let uart = Arc::new(Mutex::new(Pl011::new(
        Arc::clone(serial),
        Some(Arc::clone(input)),
        irqs.pl011,
    )));
    bus.insert("pl011", PL011_BASE, PL011_SIZE, uart.clone())
        .map_err(Error::Bus)?;
    bus.insert(
        "pl031",
        PL031_BASE,
        PL031_SIZE,
        Arc::new(Mutex::new(Pl031::with_clock(
            crate::timer::pl031_time_base(),
            irqs.pl031,
        ))),
    )
    .map_err(Error::Bus)?;
    // ANCHOR: gicr_unused_razwi
    let frames = Layout::virt()
        .gicr_size(ncpus)
        .ok_or(Error::Internal("vCPU count outside 1..=MAX_CPUS"))?;
    let rest = GICR_BASE
        .checked_add(frames)
        .filter(|start| *start < GICR_WINDOW_END);
    if let Some(start) = rest {
        bus.insert(
            "gicr-unused",
            start,
            GICR_WINDOW_END.saturating_sub(start),
            Arc::new(Mutex::new(RazWi::new("gicr-unused"))),
        )
        .map_err(Error::Bus)?;
    }
    // ANCHOR_END: gicr_unused_razwi
    Ok(uart)
}
// ANCHOR_END: register_platform

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::layout::{Layout, RAM_DEFAULT};

    #[test]
    fn testdev_only_with_the_flag_and_inside_its_layout_row() {
        let mut bus = Bus::new();
        register_devices(&VmConfig::default(), &mut bus).unwrap();
        assert!(bus.is_empty());
        let cfg = VmConfig {
            testdev: true,
            ..VmConfig::default()
        };
        register_devices(&cfg, &mut bus).unwrap();
        assert_eq!(bus.device_at(TESTDEV_BASE), Some(("testdev", 0)));
        let row = Layout::virt().find(TESTDEV_BASE).unwrap();
        assert_eq!((row.name, row.size), ("testdev", TESTDEV_SIZE));
        // Registering twice is an overlap, a VMM bug reported as an error, never a panic.
        assert!(matches!(
            register_devices(&cfg, &mut bus),
            Err(Error::Bus(_))
        ));
    }

    #[test]
    fn platform_devices_sit_in_their_layout_rows() {
        use crate::backend::serial::Sink;
        let mut bus = Bus::new();
        let sink = Arc::new(Sink::none());
        let input = Arc::new(SerialInput::new());
        register_platform(&mut bus, &sink, &input, 1).unwrap();
        for (name, base, size) in [
            ("pl011", PL011_BASE, PL011_SIZE),
            ("pl031", PL031_BASE, PL031_SIZE),
        ] {
            assert_eq!(bus.device_at(base), Some((name, 0)));
            let row = Layout::virt().find(base).unwrap();
            assert_eq!((row.name, row.size), (name, size));
        }
        // The first redistributor frame is HVF's; the rest of the window is RAZ/WI.
        assert_eq!(bus.device_at(GICR_BASE), None);
        assert_eq!(
            bus.device_at(GICR_BASE + 0x2_0000),
            Some(("gicr-unused", 0))
        );
        assert_eq!(
            bus.device_at(GICR_WINDOW_END - 1).map(|d| d.0),
            Some("gicr-unused")
        );
        assert_eq!(
            bus.read(GICR_BASE + 0x3_0000, crate::bus::AccessSize::B4),
            Ok(0)
        );
        // FR after reset (PLAN M6: 0x90).
        assert_eq!(
            bus.read(PL011_BASE + 0x18, crate::bus::AccessSize::B4),
            Ok(0x90)
        );
        // With every frame in use, there is no remainder.
        let mut full = Bus::new();
        register_platform(&mut full, &sink, &input, crate::arch::layout::MAX_CPUS).unwrap();
        assert_eq!(
            full.len(),
            2 + usize::from(GICR_BASE + 64 * 0x2_0000 < GICR_WINDOW_END)
        );
        assert!(register_platform(&mut Bus::new(), &sink, &input, 0).is_err());
    }

    #[test]
    fn all_32_virtio_slots_answer_as_empty() {
        use crate::arch::layout::{VIRTIO_MMIO_BASE, VIRTIO_MMIO_SLOTS, VIRTIO_MMIO_STRIDE};
        use crate::bus::AccessSize;
        let mut bus = Bus::new();
        register_virtio(&VmConfig::default(), &mut bus).unwrap();
        assert_eq!(bus.len(), VIRTIO_MMIO_SLOTS);
        assert!(virtio_populated(&VmConfig::default()).is_empty());
        for i in 0..VIRTIO_MMIO_SLOTS as u64 {
            let base = VIRTIO_MMIO_BASE + i * VIRTIO_MMIO_STRIDE;
            assert_eq!(bus.device_at(base), Some(("virtio-mmio", 0)));
            assert_eq!(bus.read(base, AccessSize::B4), Ok(0x7472_6976));
            assert_eq!(bus.read(base + 4, AccessSize::B4), Ok(2));
            assert_eq!(bus.read(base + 8, AccessSize::B4), Ok(0));
            assert_eq!(bus.read(base + 0x1ff, AccessSize::B1), Ok(0));
        }
        let row = Layout::virt().find(VIRTIO_MMIO_BASE).unwrap();
        assert_eq!(row.size, VIRTIO_MMIO_SLOTS as u64 * VIRTIO_MMIO_STRIDE);
    }

    /// M12: ADR-0005 slot order, and a populated slot answers as its device.
    #[test]
    fn rng_goes_in_the_first_free_slot_with_a_worker() {
        use crate::arch::layout::{VIRTIO_MMIO_BASE, VIRTIO_MMIO_SLOTS, VIRTIO_MMIO_STRIDE};
        use crate::bus::AccessSize;
        use crate::memory::VecMemory;
        let cfg = VmConfig {
            rng: true,
            ..VmConfig::default()
        };
        assert_eq!(virtio_assignment(&cfg), vec![(0, VirtioKind::Rng)]);
        assert_eq!(virtio_populated(&cfg), vec![0]);
        assert!(register_virtio(&cfg, &mut Bus::new()).is_err());
        let mem = Arc::new(VecMemory::new(&[(GuestAddress(RAM_BASE), 0x10_0000)]).unwrap());
        let env = VirtioEnv {
            mem,
            gic: None,
            entropy: Entropy::os(),
            ctl: Arc::new(VmControl::new()),
            console: None,
            console_input: None,
            disks: Vec::new(),
            nets: Vec::new(),
        };
        let mut bus = Bus::new();
        let workers = register_virtio_with(&cfg, &mut bus, &env).unwrap();
        assert_eq!(bus.len(), VIRTIO_MMIO_SLOTS);
        assert_eq!(workers.len(), 1);
        assert_eq!(workers.first().map(|w| w.name()), Some("virtio-rng-0"));
        assert_eq!(bus.read(VIRTIO_MMIO_BASE + 8, AccessSize::B4), Ok(4));
        for i in 1..VIRTIO_MMIO_SLOTS as u64 {
            let base = VIRTIO_MMIO_BASE + i * VIRTIO_MMIO_STRIDE;
            assert_eq!(bus.read(base + 8, AccessSize::B4), Ok(0), "slot {i}");
        }
        assert!(workers.iter().all(|w| !w.stop()));
        // Without --rng nothing is populated and no worker exists.
        let none = register_virtio_with(&VmConfig::default(), &mut Bus::new(), &env).unwrap();
        assert!(none.is_empty());
    }

    /// M13: the console goes after `--rng` (ADR-0005), answers as DeviceID 3 with two queues,
    /// and stdin pushed into its input queue rings its worker.
    #[test]
    fn console_goes_after_rng_and_its_input_rings_the_worker() {
        use crate::arch::layout::{VIRTIO_MMIO_BASE, VIRTIO_MMIO_STRIDE};
        use crate::backend::serial::Sink;
        use crate::bus::AccessSize;
        use crate::config::SinkSpec;
        use crate::memory::VecMemory;
        let cfg = VmConfig {
            rng: true,
            console: Some(SinkSpec::default()),
            ..VmConfig::default()
        };
        assert_eq!(
            virtio_assignment(&cfg),
            vec![(0, VirtioKind::Rng), (1, VirtioKind::Console)]
        );
        let mem = Arc::new(VecMemory::new(&[(GuestAddress(RAM_BASE), 0x10_0000)]).unwrap());
        let input = Arc::new(SerialInput::new());
        let mut env = VirtioEnv {
            mem,
            gic: None,
            entropy: Entropy::os(),
            ctl: Arc::new(VmControl::new()),
            console: None,
            console_input: Some(Arc::clone(&input)),
            disks: Vec::new(),
            nets: Vec::new(),
        };
        // A console without its sink is a VMM bug, reported, never a panic.
        assert!(register_virtio_with(&cfg, &mut Bus::new(), &env).is_err());
        env.console = Some(Arc::new(Sink::none()));
        let mut bus = Bus::new();
        let workers = register_virtio_with(&cfg, &mut bus, &env).unwrap();
        assert_eq!(
            workers.iter().map(|w| w.name()).collect::<Vec<_>>(),
            vec!["virtio-rng-0", "virtio-console-1"]
        );
        let base = VIRTIO_MMIO_BASE + VIRTIO_MMIO_STRIDE;
        assert_eq!(bus.read(base + 8, AccessSize::B4), Ok(3));
        // A push rings the console's worker (queue 0); the device is not activated, so the
        // batch is a no-op and the bytes stay queued.
        let before = workers[1].batches();
        input.push(b"hi");
        let t0 = std::time::Instant::now();
        while workers[1].batches() == before && t0.elapsed().as_secs() < 2 {
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(workers[1].batches() > before, "the hook rang the worker");
        assert_eq!(input.len(), 2);
        assert!(workers.iter().all(|w| !w.stop()));
        // After the worker is gone the hook is a no-op.
        drop(workers);
        drop(bus);
        input.push(b"!");
        assert_eq!(input.len(), 3);
    }

    #[test]
    fn one_ram_region_at_the_layout_base() {
        let [(base, size)] = ram_regions(RAM_DEFAULT);
        assert_eq!(base, GuestAddress(RAM_BASE));
        assert_eq!(Layout::virt().ram_end(size), Ok(RAM_BASE + RAM_DEFAULT));
    }
}
