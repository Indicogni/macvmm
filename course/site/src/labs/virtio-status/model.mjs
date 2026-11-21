// virtio-status model: the virtio-mmio version 2 transport of chapter 15 as a pure function of
// (state, register access). No DOM, no I/O: node --test imports this file directly.
//
// It is a port of the reference transport, crates/vmm/src/virtio/mmio.rs (`read_reg`,
// `write_reg`, `write_status`, `features_ok`, `driver_ok`, `reset`, `notify`, the access-width
// rules of `impl MmioDevice`), of `VirtioInterrupt` (crates/vmm/src/virtio/interrupt.rs) and of
// `Queue::size_ok` / `Queue::validate` (crates/vmm/src/virtio/queue.rs). The rules are applied in
// the same order as the Rust, and each warning is the text the reference logs, so a learner can
// match the lab against their own run. Spec: virtio 1.2 sections 2.1 (device status), 2.2
// (feature bits), 3.1.1 (driver initialization), 4.2.2 (MMIO register layout).
//
// Two presets replay real traces captured on an Apple Silicon Mac (course/captures/
// 15-handshake-trace.txt and 15-linux-handshake.txt); model.test.mjs compares formatTrace() with
// both captures line for line.
//
// What is simplified (the view repeats this to the reader): there is no ring in memory, so a
// valid doorbell always "completes one request" and raises the used-buffer interrupt; the
// device never fails on its own (no activation errors, no broken chains); the rng and blk
// devices are reduced to their identity, feature set, queue size and config bytes.

export const SLOT_BASE = 0x0a00_0000; // virtio-mmio slot 0 on the QEMU virt memory map
export const WINDOW = 0x200; // one transport window
export const RAM_BASE = 0x4000_0000;
export const MAX_ACTIONS = 256;
export const MAX_SHARE = 4096;
export const SIZES = [1, 2, 4, 8];

export const MAGIC_VALUE = 0x7472_6976; // "virt" little-endian
export const MMIO_VERSION = 2;
export const VENDOR_ID = 0x4d56_4d4d; // "MMVM" little-endian
export const NO_SHM_REGION = 0xffff_ffff;

export const REG = Object.freeze({
  MAGIC: 0x000, VERSION: 0x004, DEVICE_ID: 0x008, VENDOR_ID: 0x00c,
  DEVICE_FEATURES: 0x010, DEVICE_FEATURES_SEL: 0x014,
  DRIVER_FEATURES: 0x020, DRIVER_FEATURES_SEL: 0x024,
  QUEUE_SEL: 0x030, QUEUE_NUM_MAX: 0x034, QUEUE_NUM: 0x038, QUEUE_READY: 0x044,
  QUEUE_NOTIFY: 0x050, INTERRUPT_STATUS: 0x060, INTERRUPT_ACK: 0x064, STATUS: 0x070,
  QUEUE_DESC_LOW: 0x080, QUEUE_DESC_HIGH: 0x084,
  QUEUE_DRIVER_LOW: 0x090, QUEUE_DRIVER_HIGH: 0x094,
  QUEUE_DEVICE_LOW: 0x0a0, QUEUE_DEVICE_HIGH: 0x0a4,
  SHM_SEL: 0x0ac, SHM_LEN_LOW: 0x0b0, SHM_LEN_HIGH: 0x0b4, SHM_BASE_LOW: 0x0b8, SHM_BASE_HIGH: 0x0bc,
  QUEUE_RESET: 0x0c0, CONFIG_GENERATION: 0x0fc, CONFIG: 0x100,
});

// Names and one-line notes for the register picker and the log. `rw`: r readable, w writable.
export const REGISTERS = [
  { off: REG.MAGIC, name: "MagicValue", rw: "r", note: "always 0x74726976, the letters \"virt\"" },
  { off: REG.VERSION, name: "Version", rw: "r", note: "2, the modern virtio-mmio layout" },
  { off: REG.DEVICE_ID, name: "DeviceID", rw: "r", note: "2 disk, 4 entropy, 0 nobody home" },
  { off: REG.VENDOR_ID, name: "VendorID", rw: "r", note: "who made it; ours reads \"MMVM\"" },
  { off: REG.DEVICE_FEATURES, name: "DeviceFeatures", rw: "r", note: "32 of the offered feature bits, chosen by DeviceFeaturesSel" },
  { off: REG.DEVICE_FEATURES_SEL, name: "DeviceFeaturesSel", rw: "w", note: "0 for bits 0 to 31, 1 for bits 32 to 63" },
  { off: REG.DRIVER_FEATURES, name: "DriverFeatures", rw: "w", note: "32 of the bits the driver accepts, chosen by DriverFeaturesSel" },
  { off: REG.DRIVER_FEATURES_SEL, name: "DriverFeaturesSel", rw: "w", note: "0 for bits 0 to 31, 1 for bits 32 to 63" },
  { off: REG.QUEUE_SEL, name: "QueueSel", rw: "w", note: "which queue the queue registers act on" },
  { off: REG.QUEUE_NUM_MAX, name: "QueueNumMax", rw: "r", note: "the largest size the device allows for that queue" },
  { off: REG.QUEUE_NUM, name: "QueueNum", rw: "w", note: "the size the driver chose: a power of two up to QueueNumMax" },
  { off: REG.QUEUE_READY, name: "QueueReady", rw: "rw", note: "1: this queue is set up" },
  { off: REG.QUEUE_NOTIFY, name: "QueueNotify", rw: "w", note: "the doorbell: the value is a queue index" },
  { off: REG.INTERRUPT_STATUS, name: "InterruptStatus", rw: "r", note: "bit 0 used buffers, bit 1 configuration changed" },
  { off: REG.INTERRUPT_ACK, name: "InterruptACK", rw: "w", note: "the bits the driver has handled" },
  { off: REG.STATUS, name: "Status", rw: "rw", note: "the device status; writing 0 resets the device" },
  { off: REG.QUEUE_DESC_LOW, name: "QueueDescLow", rw: "w", note: "descriptor table address, low 32 bits" },
  { off: REG.QUEUE_DESC_HIGH, name: "QueueDescHigh", rw: "w", note: "descriptor table address, high 32 bits" },
  { off: REG.QUEUE_DRIVER_LOW, name: "QueueDriverLow", rw: "w", note: "driver area (available ring), low 32 bits" },
  { off: REG.QUEUE_DRIVER_HIGH, name: "QueueDriverHigh", rw: "w", note: "driver area (available ring), high 32 bits" },
  { off: REG.QUEUE_DEVICE_LOW, name: "QueueDeviceLow", rw: "w", note: "device area (used ring), low 32 bits" },
  { off: REG.QUEUE_DEVICE_HIGH, name: "QueueDeviceHigh", rw: "w", note: "device area (used ring), high 32 bits" },
  { off: REG.SHM_SEL, name: "SHMSel", rw: "w", note: "shared-memory region selector; no device here has one" },
  { off: REG.SHM_LEN_LOW, name: "SHMLenLow", rw: "r", note: "all ones: no such region" },
  { off: REG.SHM_LEN_HIGH, name: "SHMLenHigh", rw: "r", note: "all ones: no such region" },
  { off: REG.SHM_BASE_LOW, name: "SHMBaseLow", rw: "r", note: "all ones: no such region" },
  { off: REG.SHM_BASE_HIGH, name: "SHMBaseHigh", rw: "r", note: "all ones: no such region" },
  { off: REG.QUEUE_RESET, name: "QueueReset", rw: "rw", note: "read/write in the spec, but here it reads 0 and ignores writes: per-queue reset (RING_RESET) is never offered" },
  { off: REG.CONFIG_GENERATION, name: "ConfigGeneration", rw: "r", note: "changes whenever the device changes its config space" },
];
const REG_BY_OFF = new Map(REGISTERS.map((r) => [r.off, r]));

export const STATUS = Object.freeze({
  ACKNOWLEDGE: 1, DRIVER: 2, DRIVER_OK: 4, FEATURES_OK: 8, DEVICE_NEEDS_RESET: 64, FAILED: 128,
});
/** The four values a driver may write, in order (`STATUS_STEPS` in mmio.rs). */
export const STATUS_STEPS = [0x1, 0x3, 0xb, 0xf];
export const STATUS_BITS = [
  { mask: 1, name: "ACKNOWLEDGE", meaning: "I have seen a virtio device" },
  { mask: 2, name: "DRIVER", meaning: "and I have a driver for it" },
  { mask: 4, name: "DRIVER_OK", meaning: "the queues are set up, start working" },
  { mask: 8, name: "FEATURES_OK", meaning: "these are the features I will use; the device may refuse" },
  { mask: 16, name: "bit 4", meaning: "not defined" },
  { mask: 32, name: "bit 5", meaning: "not defined" },
  { mask: 64, name: "DEVICE_NEEDS_RESET", meaning: "set by the device: I gave up on you, write 0" },
  { mask: 128, name: "FAILED", meaning: "set by the driver: I gave up on this device" },
];

export const INT = Object.freeze({ USED: 1, CONFIG: 2, MASK: 3 });

// Feature bits as BigInt (the set is 64 bits wide).
export const F = Object.freeze({
  INDIRECT_DESC: 1n << 28n, EVENT_IDX: 1n << 29n, VERSION_1: 1n << 32n, ACCESS_PLATFORM: 1n << 33n,
  RING_PACKED: 1n << 34n, NOTIFICATION_DATA: 1n << 38n, RING_RESET: 1n << 40n,
  BLK_SEG_MAX: 1n << 2n, BLK_RO: 1n << 5n, BLK_BLK_SIZE: 1n << 6n, BLK_FLUSH: 1n << 9n,
});
export const NEVER_OFFERED = F.EVENT_IDX | F.ACCESS_PLATFORM | F.RING_PACKED | F.NOTIFICATION_DATA | F.RING_RESET;
const COMMON_FEATURE_NAMES = new Map([
  [28, "INDIRECT_DESC"], [29, "EVENT_IDX"], [32, "VERSION_1"], [33, "ACCESS_PLATFORM"],
  [34, "RING_PACKED"], [38, "NOTIFICATION_DATA"], [40, "RING_RESET"],
]);
const BLK_FEATURE_NAMES = new Map([[2, "SEG_MAX"], [5, "RO"], [6, "BLK_SIZE"], [9, "FLUSH"]]);

const U32 = 0xffff_ffffn;
const MASK64 = (1n << 64n) - 1n;

function le(bytes, value, n) {
  let v = BigInt(value);
  for (let i = 0; i < n; i++) { bytes.push(Number(v & 0xffn)); v >>= 8n; }
}
function blkConfig(capacitySectors) {
  const c = [];
  le(c, capacitySectors, 8); // capacity, in 512-byte sectors
  le(c, 64 * 1024, 4); // size_max (its feature is not offered)
  le(c, 126, 4); // seg_max
  le(c, 0, 4); // geometry (not offered)
  le(c, 512, 4); // blk_size
  return Object.freeze(c);
}

/** The devices a slot can hold (the reference's rng and blk, and the empty slot). */
export const DEVICES = Object.freeze({
  rng: Object.freeze({
    key: "rng", id: 4, name: "entropy device", queues: Object.freeze([64]),
    features: F.VERSION_1, config: Object.freeze([]), configNote: "none (the entropy device has no config space)",
  }),
  blk: Object.freeze({
    key: "blk", id: 2, name: "disk (64 MiB image)", queues: Object.freeze([256]),
    features: F.VERSION_1 | F.INDIRECT_DESC | F.BLK_SEG_MAX | F.BLK_BLK_SIZE | F.BLK_FLUSH,
    config: blkConfig(0x20000),
    configNote: "24 bytes: capacity 0x20000 sectors at 0x100, size_max at 0x108, seg_max 126 at 0x10c, geometry at 0x110, blk_size 512 at 0x114",
  }),
  empty: Object.freeze({
    key: "empty", id: 0, name: "empty slot", queues: Object.freeze([]),
    features: 0n, config: Object.freeze([]), configNote: "none",
  }),
});

// ---- small helpers ------------------------------------------------------------------------

export function hex(v, pad = 0) {
  const s = (typeof v === "bigint" ? v : BigInt(v)).toString(16);
  return `0x${pad ? s.padStart(pad, "0") : s}`;
}
const join = (lo, hi) => (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

export function regName(off) {
  const r = REG_BY_OFF.get(off);
  if (r) return r.name;
  if (off >= REG.CONFIG && off < WINDOW) return `config ${hex(off - REG.CONFIG)}`;
  return hex(off, 3);
}

export function statusNames(v) {
  if (v === 0) return "0 (reset)";
  return STATUS_BITS.filter((b) => (v & b.mask) !== 0).map((b) => b.name).join(" | ");
}

export function featureNames(bits, deviceKey) {
  const out = [];
  const b = BigInt(bits) & MASK64;
  for (let i = 0; i < 64; i++) {
    if (((b >> BigInt(i)) & 1n) === 0n) continue;
    const name = COMMON_FEATURE_NAMES.get(i) ?? (deviceKey === "blk" ? BLK_FEATURE_NAMES.get(i) : undefined);
    out.push(name ? `${name} (bit ${i})` : `bit ${i}`);
  }
  return out;
}

// ---- state --------------------------------------------------------------------------------

function newQueue(max) {
  return { max, size: max, ready: false, desc: [0, 0], avail: [0, 0], used: [0, 0] };
}

/** A freshly built transport for `deviceKey` with `ramMiB` of guest RAM at 0x4000_0000. */
export function initial(deviceKey = "rng", ramMiB = 64) {
  const d = DEVICES[deviceKey];
  if (!d) throw new Error(`unknown device ${deviceKey}`);
  return {
    device: d.key, ramMiB,
    status: 0, devSel: 0, drvSel: 0, drvLo: 0, drvHi: 0, beyond: false,
    queueSel: 0, queues: d.queues.map(newQueue),
    intStatus: 0, needsReset: false, line: false, transitions: [],
    configGen: 0, acked: null, activations: 0, resets: 0, notifies: 0,
  };
}

function clone(s) {
  return {
    ...s,
    queues: s.queues.map((q) => ({ ...q, desc: [...q.desc], avail: [...q.avail], used: [...q.used] })),
    transitions: [...s.transitions],
  };
}

/** Status as the driver reads it: NEEDS_RESET is reported through the interrupt state. */
export function statusRead(s) {
  return s.needsReset ? (s.status | STATUS.DEVICE_NEEDS_RESET) : s.status;
}

export function driverFeatures(s) { return join(s.drvLo, s.drvHi); }
export function ramEnd(s) { return RAM_BASE + s.ramMiB * 1024 * 1024; }

function setLine(s, level) {
  if (s.line !== level) s.transitions.push(level);
  s.line = level;
}
function raise(s, bit) { s.intStatus |= bit; setLine(s, true); }
function ack(s, bits) {
  s.intStatus &= ~(bits & INT.MASK);
  if (s.intStatus === 0) setLine(s, false);
}
function setNeedsReset(s) { s.needsReset = true; s.intStatus |= INT.CONFIG; setLine(s, true); }

/** `Queue::validate`: size, then each ring's alignment and that it lies inside RAM. */
export function validateQueue(s, q) {
  if (!(q.size !== 0 && q.size <= q.max && isPow2(q.size))) {
    return { ok: false, debug: `BadSize { size: ${q.size}, max: ${q.max} }`, plain: `size ${q.size} is not a power of two up to ${q.max}` };
  }
  const n = BigInt(q.size);
  const rings = [
    ["Desc", "descriptor table", join(...q.desc), 16n, 16n * n],
    ["Avail", "driver area", join(...q.avail), 2n, 6n + 2n * n],
    ["Used", "device area", join(...q.used), 4n, 6n + 8n * n],
  ];
  const lo = BigInt(RAM_BASE);
  const hi = BigInt(ramEnd(s));
  for (const [ring, label, addr, align, len] of rings) {
    if (addr % align !== 0n) {
      return { ok: false, unaligned: true, debug: `Unaligned { ring: ${ring}, addr: ${addr} }`, plain: `the ${label} at ${hex(addr)} is not ${align}-byte aligned` };
    }
    const end = addr + len; // BigInt: cannot overflow; the Rust uses checked_add
    if (!(addr >= lo && end <= hi && end <= MASK64)) {
      return {
        ok: false, debug: `RingOutOfRam { ring: ${ring}, addr: ${addr}, len: ${len} }`,
        plain: `the ${label} at ${hex(addr)} (${len} bytes) is not inside guest RAM (${hex(RAM_BASE)} to ${hex(ramEnd(s))})`,
      };
    }
  }
  return { ok: true };
}

// ---- one register access ------------------------------------------------------------------

/**
 * Apply one action and return { state, read, label, effect, log, taken }.
 * action: { op: "r", off, size } | { op: "w", off, size, val } | { op: "c" } (the device
 * changes its config space: `config_changed`). `read` is a BigInt for reads, else null.
 * `log` is { level: "warn" | "debug", text } when the reference logs something.
 * `taken` is true or false for writes (did the device take the write?), else null.
 * `but` is a short clause when the device took the write and then refused something
 * (DRIVER_OK latches, then a bad ring sets DEVICE_NEEDS_RESET), else null.
 */
export function apply(state, action) {
  const err = validateAction(action);
  if (err) throw new Error(err);
  const s = clone(state);
  const out = { state: s, read: null, label: describeAction(action), effect: "", log: null, taken: null, but: null };
  const dev = DEVICES[s.device];
  const warn = (text) => { out.log = { level: "warn", text: `virtio-mmio: ${text}` }; };
  const debug = (text) => { out.log = { level: "debug", text: `virtio-mmio: ${text}` }; };

  if (action.op === "c") {
    if (dev.key !== "blk") {
      out.effect = dev.id === 0
        ? "Nothing happens: there is no device in this slot to change anything, and its interrupt line is not connected."
        : "Nothing happens: the entropy device has no config space, so it never changes one. Only the disk does this (when its image is resized).";
      return out;
    }
    s.configGen = (s.configGen + 1) >>> 0;
    raise(s, INT.CONFIG);
    out.effect = `The device changed its config space: ConfigGeneration is now ${s.configGen} and InterruptStatus bit 1 (configuration changed) is set, so the line is high.`;
    return out;
  }

  const { off, size } = action;
  if (action.op === "r") {
    if (off >= REG.CONFIG) {
      out.read = readConfig(s, dev, off, size, warn, out);
      return out;
    }
    if (size !== 4 || off % 4 !== 0) {
      warn(`${size}-byte read at ${hex(off)} is not an aligned 32-bit access (RAZ)`);
      out.read = 0n;
      out.effect = "Control registers take aligned 32-bit accesses only, so this read returns 0 (read as zero) and the device logs a warning." + (off % size !== 0 ? MISALIGNED_NOTE : "");
      return out;
    }
    out.read = BigInt(readReg(s, dev, off, debug, out) >>> 0);
    return out;
  }

  // Writes.
  const val = action.val;
  if (off >= REG.CONFIG) {
    writeConfig(s, dev, off, size, warn, out);
    return out;
  }
  if (size !== 4 || off % 4 !== 0) {
    warn(`${size}-byte write at ${hex(off)} is not an aligned 32-bit access (WI)`);
    out.taken = false;
    out.effect = "Control registers take aligned 32-bit accesses only, so this write is ignored and the device logs a warning." + (off % size !== 0 ? MISALIGNED_NOTE : "");
    return out;
  }
  writeReg(s, dev, off, val >>> 0, warn, debug, out);
  if (out.taken === null) out.taken = out.log === null;
  return out;
}

const MISALIGNED_NOTE = " On real hardware a misaligned access to device memory normally faults inside the guest first and never reaches the VMM; the device checks anyway, because it must never trust the access it is given.";

function readReg(s, dev, off, debug, out) {
  const name = regName(off);
  if (dev.id === 0) {
    const v = off === REG.MAGIC ? MAGIC_VALUE : off === REG.VERSION ? MMIO_VERSION : 0;
    out.effect = off === REG.MAGIC || off === REG.VERSION
      ? `An empty slot still answers ${name}, so a guest scanning the fixed addresses gets a defined answer.`
      : `An empty slot reads 0 everywhere except MagicValue and Version. DeviceID 0 means nobody is home, and the driver must ignore the slot.`;
    return v;
  }
  const q = s.queues[s.queueSel];
  switch (off) {
    case REG.MAGIC: out.effect = "The letters \"virt\", read as a little-endian number: this is a virtio-mmio transport."; return MAGIC_VALUE;
    case REG.VERSION: out.effect = "Version 2: the modern register layout (version 1 was the legacy layout, which we do not implement)."; return MMIO_VERSION;
    case REG.DEVICE_ID: out.effect = `DeviceID ${dev.id}: an ${dev.id === 4 ? "entropy device" : "block device (a disk)"}.`; return dev.id;
    case REG.VENDOR_ID: out.effect = "VendorID: the letters \"MMVM\". Any value is allowed."; return VENDOR_ID;
    case REG.DEVICE_FEATURES: {
      const v = s.devSel === 0 ? Number(dev.features & U32) : s.devSel === 1 ? Number((dev.features >> 32n) & U32) : 0;
      out.effect = s.devSel > 1
        ? `DeviceFeaturesSel is ${s.devSel}: bits beyond 63 read 0 here.`
        : `Offered feature bits ${s.devSel * 32} to ${s.devSel * 32 + 31}: ${listOrNone(featureNames(BigInt(v) << BigInt(32 * s.devSel), dev.key))}.`;
      return v;
    }
    case REG.QUEUE_NUM_MAX:
      out.effect = q ? `Queue ${s.queueSel} may hold at most ${q.max} descriptors.` : `QueueSel ${s.queueSel} names no queue, so this reads 0.`;
      return q ? q.max : 0;
    case REG.QUEUE_READY:
      out.effect = q ? `Queue ${s.queueSel} is ${q.ready ? "" : "not "}ready.` : `QueueSel ${s.queueSel} names no queue, so this reads 0.`;
      return q ? (q.ready ? 1 : 0) : 0;
    case REG.INTERRUPT_STATUS:
      out.effect = s.intStatus === 0
        ? "Nothing to report: InterruptStatus is 0 and the line is low."
        : `${intNames(s.intStatus)}. The driver handles ${s.intStatus === 3 ? "them" : "it"} and then writes the same bits to InterruptACK.`;
      return s.intStatus;
    case REG.STATUS: {
      const v = statusRead(s);
      out.effect = statusReadEffect(s, v);
      return v;
    }
    case REG.SHM_LEN_LOW: case REG.SHM_LEN_HIGH: case REG.SHM_BASE_LOW: case REG.SHM_BASE_HIGH:
      out.effect = "All ones: no such shared-memory region. Reading 0 would claim region 0 exists, at address 0, empty.";
      return NO_SHM_REGION;
    case REG.QUEUE_RESET: out.effect = "QueueReset reads 0: per-queue reset is a feature we never offer."; return 0;
    case REG.CONFIG_GENERATION:
      out.effect = `ConfigGeneration is ${s.configGen}. A driver reads it before and after reading config fields, and reads again if it changed in between.`;
      return s.configGen;
    default:
      debug(`read of write-only or reserved register ${hex(off)} (RAZ)`);
      out.effect = REG_BY_OFF.has(off)
        ? `${name} is write-only, so a read returns 0.`
        : "No register here: the read returns 0.";
      return 0;
  }
}

function statusReadEffect(s, v) {
  if (s.needsReset) return `Status reads ${hex(v)}: DEVICE_NEEDS_RESET (64) is set. The device refuses all work until the driver writes 0.`;
  if (v & STATUS.FAILED) return `Status reads ${hex(v)}: FAILED is latched until the driver writes 0.`;
  if (v === 0) return "Status reads 0: the device is reset.";
  return `Status reads ${hex(v)}: ${statusNames(v)}.`;
}

function intNames(v) {
  const parts = [];
  if (v & INT.USED) parts.push("bit 0, used buffers added");
  if (v & INT.CONFIG) parts.push("bit 1, configuration changed (this includes DEVICE_NEEDS_RESET)");
  return `InterruptStatus ${hex(v)}: ${parts.join(", and ")}`;
}

function listOrNone(xs) { return xs.length ? xs.join(", ") : "none"; }

function writeReg(s, dev, off, v, warn, debug, out) {
  if (dev.id === 0) {
    debug(`write to an empty slot at ${hex(off)} (WI)`);
    out.effect = "An empty slot ignores every write.";
    return;
  }
  switch (off) {
    case REG.DEVICE_FEATURES_SEL:
      s.devSel = v;
      out.effect = v <= 1 ? `DeviceFeatures now shows offered bits ${v * 32} to ${v * 32 + 31}.` : `DeviceFeatures now reads 0 (selector ${v} is beyond bit 63).`;
      return;
    case REG.DRIVER_FEATURES_SEL:
      s.drvSel = v;
      out.effect = v <= 1 ? `The next DriverFeatures write sets accepted bits ${v * 32} to ${v * 32 + 31}.` : `The next DriverFeatures write is for bits beyond 63, which nobody offers.`;
      return;
    case REG.DRIVER_FEATURES: return writeDriverFeatures(s, dev, v, warn, out);
    case REG.QUEUE_SEL:
      s.queueSel = v;
      out.effect = s.queues[v] ? `The queue registers now act on queue ${v}.` : `QueueSel ${v} names no queue (this device has ${s.queues.length}). Queue registers will read 0 and ignore writes.`;
      return;
    case REG.QUEUE_NUM: {
      const q = selectedWritable(s, "QueueNum", warn, out);
      if (!q) return;
      if (v <= 0xffff && v !== 0 && v <= q.max && isPow2(v)) {
        q.size = v;
        out.effect = `Queue ${s.queueSel} will have ${v} descriptors.`;
      } else {
        warn(`QueueNum ${v} ignored: not a power of two in 1..=${q.max}`);
        out.effect = `${v} is not a power of two from 1 to ${q.max}, so the size stays ${q.size}. The ring arithmetic of chapter 16 depends on a power of two.`;
      }
      return;
    }
    case REG.QUEUE_READY: {
      if (s.status & STATUS.DRIVER_OK) {
        warn("QueueReady ignored after DRIVER_OK");
        out.effect = "After DRIVER_OK the device is using the queue, so QueueReady is frozen too.";
        return;
      }
      const q = s.queues[s.queueSel];
      if (!q) {
        warn(`QueueReady for queue ${s.queueSel}, which does not exist`);
        out.effect = `QueueSel ${s.queueSel} names no queue, so the write is ignored.`;
        return;
      }
      if (v === 0 || v === 1) {
        q.ready = v === 1;
        out.effect = v === 1
          ? `Queue ${s.queueSel} is ready: its size and ring addresses are frozen from now on.`
          : `Queue ${s.queueSel} is not ready any more, so its registers can change again (allowed before DRIVER_OK).`;
      } else {
        warn(`QueueReady ${v} ignored`);
        out.effect = "QueueReady takes only 0 or 1.";
      }
      return;
    }
    case REG.QUEUE_NOTIFY: return notify(s, v, warn, out);
    case REG.INTERRUPT_ACK: {
      const before = s.intStatus;
      ack(s, v);
      const cleared = before & ~s.intStatus;
      out.effect = (v & ~INT.MASK) ? "Only bits 0 and 1 mean anything; the others are masked away. " : "";
      out.effect += cleared
        ? `Cleared ${hex(cleared)}. InterruptStatus is now ${hex(s.intStatus)}, so the line is ${s.line ? "still high" : "low"}.`
        : `Nothing it names was pending: InterruptStatus stays ${hex(s.intStatus)} and the line stays ${s.line ? "high" : "low"}.`;
      return;
    }
    case REG.STATUS: return writeStatus(s, dev, v, warn, out);
    case REG.SHM_SEL:
      debug(`SHMSel ${v} ignored: no shared-memory regions`);
      out.effect = "No device here has a shared-memory region, so the selector is ignored.";
      return;
    case REG.QUEUE_DESC_LOW: case REG.QUEUE_DESC_HIGH: return writeRingAddr(s, off, v, "desc", "descriptor table", warn, out);
    case REG.QUEUE_DRIVER_LOW: case REG.QUEUE_DRIVER_HIGH: return writeRingAddr(s, off, v, "avail", "driver area", warn, out);
    case REG.QUEUE_DEVICE_LOW: case REG.QUEUE_DEVICE_HIGH: return writeRingAddr(s, off, v, "used", "device area", warn, out);
    default:
      debug(`write to read-only or reserved register ${hex(off)} (WI)`);
      out.effect = off === REG.QUEUE_RESET
        ? "QueueReset is writable in the spec, but only when the driver accepted per-queue reset (RING_RESET), which we never offer. So the write is ignored."
        : REG_BY_OFF.has(off) ? `${regName(off)} is read-only: the write is ignored.` : "No register here: the write is ignored.";
  }
}

function selectedWritable(s, what, warn, out) {
  const frozen = (s.status & STATUS.DRIVER_OK) !== 0;
  const q = s.queues[s.queueSel];
  if (!q) {
    warn(`${what} for queue ${s.queueSel}, which does not exist`);
    out.effect = `QueueSel ${s.queueSel} names no queue, so the write is ignored.`;
    return null;
  }
  if (frozen || q.ready) {
    warn(`${what} for queue ${s.queueSel} ignored: the queue is ready or DRIVER_OK is set`);
    out.effect = frozen
      ? "DRIVER_OK is set: the device is using this queue, so its registers are frozen. A driver that could move a live ring could make the device read memory nobody checked."
      : `Queue ${s.queueSel} is ready, so its registers are frozen. The driver may write 0 to QueueReady first to change them.`;
    return null;
  }
  return q;
}

function writeRingAddr(s, off, v, key, label, warn, out) {
  const high = off % 8 !== 0;
  const q = selectedWritable(s, "a ring address", warn, out);
  if (!q) return;
  if (high) q[key][1] = v; else q[key][0] = v;
  out.effect = `The ${high ? "high" : "low"} half of queue ${s.queueSel}'s ${label} changed; the other half was kept. The address is now ${hex(join(...q[key]))}.`;
}

function writeDriverFeatures(s, dev, v, warn, out) {
  if ((s.status & STATUS.DRIVER) === 0 || (s.status & STATUS.FEATURES_OK) !== 0) {
    warn(`DriverFeatures ignored in status ${s.status} (virtio section 3.1.1 order)`);
    out.effect = (s.status & STATUS.FEATURES_OK)
      ? "FEATURES_OK is set: the feature set is fixed, so the write is ignored."
      : "Features are accepted only after DRIVER is set, so the write is ignored.";
    return;
  }
  if (s.drvSel === 0) {
    s.drvLo = v;
    out.effect = `The driver accepts bits 0 to 31: ${listOrNone(featureNames(BigInt(v), dev.key))}.`;
  } else if (s.drvSel === 1) {
    s.drvHi = v;
    out.effect = `The driver accepts bits 32 to 63: ${listOrNone(featureNames(BigInt(v) << 32n, dev.key))}.`;
  } else if (v !== 0) {
    s.beyond = true;
    out.effect = "The driver accepts bits beyond 63, which nobody offered: FEATURES_OK will be refused.";
  } else {
    out.effect = "Accepting nothing beyond bit 63 changes nothing.";
  }
}

function writeStatus(s, dev, v, warn, out) {
  if (v === 0) {
    s.resets += 1;
    s.queues = dev.queues.map(newQueue);
    s.status = 0; s.devSel = 0; s.drvSel = 0; s.drvLo = 0; s.drvHi = 0; s.beyond = false; s.queueSel = 0;
    s.intStatus = 0; s.needsReset = false; setLine(s, false);
    s.acked = null;
    out.effect = "Writing 0 resets the device: queues, selectors and accepted features are cleared, InterruptStatus is 0 and the line is low. This is the one way back.";
    return;
  }
  if (v & STATUS.FAILED) {
    s.status |= STATUS.FAILED;
    out.effect = "The driver set FAILED: it gave up on the device. FAILED stays until the driver writes 0, and the device does nothing more.";
    return;
  }
  if ((s.status & STATUS.FAILED) || s.needsReset) {
    warn(`Status ${v} ignored: the device needs a reset (write 0)`);
    out.effect = s.needsReset
      ? "The device has set DEVICE_NEEDS_RESET, so it ignores every Status write except 0."
      : "FAILED is set, so the device ignores every Status write except 0.";
    return;
  }
  const implied = v & STATUS.DRIVER ? (v | STATUS.ACKNOWLEDGE) : v;
  if ((s.status & ~implied) !== 0 || !STATUS_STEPS.includes(implied)) {
    warn(`Status ${implied} after ${s.status} ignored: bits out of order`);
    out.effect = statusOrderEffect(s.status, implied);
    return;
  }
  const added = implied & ~s.status;
  const note = implied !== v ? "DRIVER implies ACKNOWLEDGE (a compatibility rule for U-Boot, which writes DRIVER alone after a reset). " : "";
  if ((added & STATUS.FEATURES_OK) && !featuresOk(s, dev, warn, out)) {
    s.status = implied & (STATUS.ACKNOWLEDGE | STATUS.DRIVER);
    out.taken = false;
    return;
  }
  s.status = implied;
  if (added & STATUS.FEATURES_OK) {
    out.effect = `${note}FEATURES_OK latched: every accepted bit was offered and VERSION_1 is among them. The device now knows the feature set (${listOrNone(featureNames(s.acked, dev.key))}); the driver reads Status back to check.`;
  } else if (added & STATUS.DRIVER_OK) {
    driverOk(s, warn, out);
  } else if (added & STATUS.DRIVER) {
    out.effect = `${note}DRIVER: "and I have a driver for it". Features may be accepted now.`;
  } else if (added & STATUS.ACKNOWLEDGE) {
    out.effect = "ACKNOWLEDGE: \"I have seen a virtio device\".";
  } else {
    out.effect = `${note}Status stays ${hex(s.status)}: no new bit.`;
  }
}

function statusOrderEffect(cur, v) {
  if ((cur & ~v) !== 0) return `This write would clear bits that are set (${hex(cur)} to ${hex(v)}). Bits only accumulate; writing 0 is the one way back. Status stays ${hex(cur)}.`;
  if (v & ~0xf & ~STATUS.FAILED) return `${hex(v)} contains bits the driver may not set (DEVICE_NEEDS_RESET is the device's, and bits 4, 5 and 8 up mean nothing). Status stays ${hex(cur)}.`;
  const next = STATUS_STEPS.find((x) => (x & ~cur) !== 0 && (cur & ~x) === 0);
  return `${hex(v)} skips a step: after ${hex(cur)} the next legal value is ${hex(next)}. The order is 0x1, 0x3, 0xb, 0xf. Status stays ${hex(cur)}.`;
}

function featuresOk(s, dev, warn, out) {
  const accepted = driverFeatures(s);
  const unoffered = accepted & ~dev.features & MASK64;
  if (unoffered !== 0n || s.beyond) {
    warn(`FEATURES_OK refused: features ${hex(unoffered)} were not offered`);
    out.effect = s.beyond && unoffered === 0n
      ? "Refused: the driver accepted bits beyond 63, which were never offered. FEATURES_OK does not latch; the driver reads Status back, sees it clear, and must give up."
      : `Refused: the driver accepted ${listOrNone(featureNames(unoffered, dev.key))}, which the device never offered. FEATURES_OK does not latch; the driver reads Status back, sees it clear, and must give up.`;
    return false;
  }
  if ((accepted & F.VERSION_1) === 0n) {
    warn("FEATURES_OK refused: VIRTIO_F_VERSION_1 not accepted");
    out.effect = "Refused: the driver did not accept VERSION_1 (bit 32). Without it the device cannot know that the driver follows the virtio 1.x rules, so the spec says the device must refuse (virtio 1.2 sections 2.2.1 and 6.1). FEATURES_OK does not latch; the driver reads Status back, sees it clear, and must give up.";
    return false;
  }
  s.acked = accepted;
  return true;
}

export const ALIGN_NOTE = " The reference also checks each ring's alignment (virtio 1.2 section 2.7, the split virtqueue alignment table). Your chapter 15 validate checks only that each ring is inside RAM; chapter 16 adds this check.";

function driverOk(s, warn, out) {
  for (let i = 0; i < s.queues.length; i++) {
    const q = s.queues[i];
    if (!q.ready) continue;
    const r = validateQueue(s, q);
    if (!r.ok) {
      warn(`queue ${i} refused at DRIVER_OK: virtqueue: ${r.debug}`);
      setNeedsReset(s);
      out.taken = true; // DRIVER_OK did latch; the device then refused the ring
      out.but = "then refused the ring: DEVICE_NEEDS_RESET";
      out.effect = `DRIVER_OK latched, and the device checked queue ${i}'s rings before trusting them: ${r.plain}. It sets DEVICE_NEEDS_RESET, raises a configuration interrupt (InterruptStatus bit 1, line high), and refuses all work until the driver writes 0.${r.unaligned ? ALIGN_NOTE : ""}`;
      return;
    }
  }
  s.activations += 1;
  const ready = s.queues.map((q, i) => (q.ready ? i : null)).filter((i) => i !== null);
  out.effect = ready.length
    ? `DRIVER_OK: the device checked ${ready.length === 1 ? `queue ${ready[0]}'s rings` : "every ready queue's rings"} (aligned, inside RAM; your chapter 15 version checks only the RAM part) and is now working. Queue registers are frozen.`
    : "DRIVER_OK: no queue is ready, so there was nothing to check. The device is working, with no queue to work on.";
}

function notify(s, v, warn, out) {
  if (!(s.status & STATUS.DRIVER_OK) || (s.status & STATUS.FAILED) || s.needsReset) {
    warn(`QueueNotify ${v} ignored in status ${statusRead(s)}`);
    out.effect = s.needsReset
      ? "The device needs a reset, so it ignores the doorbell."
      : (s.status & STATUS.FAILED) ? "FAILED is set, so the doorbell is ignored." : "The doorbell counts only after DRIVER_OK: the device has not been told its rings are valid.";
    return;
  }
  const q = s.queues[v];
  if (!q || !q.ready) {
    warn(`QueueNotify ${v} ignored: no such ready queue (${s.queues.length} queues)`);
    out.effect = q ? `Queue ${v} is not ready, so there is nothing to look at.` : `There is no queue ${v} (this device has ${s.queues.length}).`;
    return;
  }
  s.notifies += 1;
  raise(s, INT.USED);
  out.effect = `The doorbell for queue ${v}. The device takes the request from the ring (chapter 16 shows how), completes it, and sets InterruptStatus bit 0 (used buffers): the line goes high.`;
}

function readConfig(s, dev, off, size, warn, out) {
  const o = off - REG.CONFIG;
  if (dev.id === 0 || o + size > dev.config.length) {
    warn(`config access of ${size} bytes at ${hex(o)} outside the ${dev.config.length}-byte config space (RAZ/WI)`);
    out.effect = dev.config.length
      ? `The config space is ${dev.config.length} bytes; ${size} bytes at offset ${hex(o)} do not fit, so the read returns 0.`
      : "This device has no config space, so the read returns 0.";
    return 0n;
  }
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(dev.config[o + i]);
  out.effect = configFieldEffect(dev, o, size, v);
  return v;
}

function configFieldEffect(dev, o, size, v) {
  if (dev.key !== "blk") return `Config bytes ${hex(o)} to ${hex(o + size - 1)}.`;
  const fields = [[0, 8, "capacity, in 512-byte sectors"], [8, 4, "size_max (its feature is not offered, so drivers ignore it)"], [12, 4, "seg_max, the most data segments per request"], [16, 4, "geometry (not offered)"], [20, 4, "blk_size, the sector size the disk prefers"]];
  const f = fields.find(([fo, fl]) => o >= fo && o + size <= fo + fl);
  const whole = f && o === f[0] && size === f[1];
  const what = whole ? f[2] : f ? `part of ${f[2]}` : "bytes from more than one field";
  const rule = whole ? "" : " The device answers (it is lenient), but a driver must not do this: the spec requires each config field to be read at its natural width and alignment (virtio 1.2 section 4.2.2.2).";
  return `Config ${hex(o)}, ${size} byte${size === 1 ? "" : "s"}: ${what}. Value ${hex(v)}${f && f[0] === 0 && o === 4 ? " (the high half)" : ""}.${rule}`;
}

function writeConfig(s, dev, off, size, warn, out) {
  const o = off - REG.CONFIG;
  if (dev.id === 0 || o + size > dev.config.length) {
    warn(`config access of ${size} bytes at ${hex(o)} outside the ${dev.config.length}-byte config space (RAZ/WI)`);
    out.taken = false;
    out.effect = dev.config.length
      ? `The config space is ${dev.config.length} bytes; ${size} bytes at offset ${hex(o)} do not fit, so the write is ignored.`
      : "This device has no config space, so the write is ignored.";
    return;
  }
  out.taken = false;
  out.effect = "The disk's config fields are all read-only, so the device ignores the write (no warning: the access was in range).";
}

// ---- actions, presets, replay --------------------------------------------------------------

export function validateAction(a) {
  if (!a || typeof a !== "object") return "not an action";
  if (a.op === "c") return null;
  if (a.op !== "r" && a.op !== "w") return "unknown operation";
  if (!Number.isInteger(a.off) || a.off < 0 || a.off >= WINDOW) return `the offset must be from 0x000 to ${hex(WINDOW - 1, 3)}`;
  if (!SIZES.includes(a.size)) return "the width must be 1, 2, 4 or 8 bytes";
  if (a.op === "w" && (!Number.isInteger(a.val) || a.val < 0 || a.val > 0xffff_ffff)) return "the value must be a 32-bit number";
  return null;
}

export function describeAction(a) {
  if (a.op === "c") return "device changes its config";
  const notes = [];
  if (a.size !== 4) notes.push(`${a.size}-byte`);
  if (a.off % a.size !== 0) notes.push("misaligned");
  const tail = notes.length ? ` (${notes.join(", ")})` : "";
  const name = regName(a.off);
  return a.op === "r" ? `read ${name}${tail}` : `write ${name} = ${hex(a.val)}${tail}`;
}

const ACTION_RE = /^(?:c|r([0-9a-f]{1,3})(?:\.([1248]))?|w([0-9a-f]{1,3})\.([0-9a-f]{1,8})(?:\.([1248]))?)$/;

export function encodeAction(a) {
  if (a.op === "c") return "c";
  const sz = a.size === 4 ? "" : `.${a.size}`;
  return a.op === "r" ? `r${a.off.toString(16)}${sz}` : `w${a.off.toString(16)}.${a.val.toString(16)}${sz}`;
}

/** Parse one encoded action; null if malformed or out of range. */
export function decodeAction(t) {
  const m = ACTION_RE.exec(t);
  if (!m) return null;
  let a;
  if (t === "c") a = { op: "c" };
  else if (m[1] !== undefined) a = { op: "r", off: parseInt(m[1], 16), size: m[2] ? Number(m[2]) : 4 };
  else a = { op: "w", off: parseInt(m[3], 16), val: parseInt(m[4], 16), size: m[5] ? Number(m[5]) : 4 };
  return validateAction(a) ? null : a;
}

export function decodeActions(str) {
  if (str === "") return [];
  const parts = str.split("_");
  if (parts.length > MAX_ACTIONS) return null;
  const out = [];
  for (const p of parts) {
    const a = decodeAction(p);
    if (!a) return null;
    out.push(a);
  }
  return out;
}

function acts(str) {
  const a = decodeActions(str);
  if (!a) throw new Error(`bad preset actions: ${str}`);
  return Object.freeze(a.map(Object.freeze));
}

// Building blocks for the misbehaving drivers (all against the entropy device in 64 MiB).
const ID = "r0_r4_r8_w70.0_w70.1_w70.3_w14.1_r10";
const FEAT = "w24.0_w20.0_w24.1_w20.1_w70.b_r70";
const queue = (d = "40085000", a = "40085400", u = "40085800") => `w30.0_r34_w38.10_w80.${d}_w84.0_w90.${a}_w94.0_wa0.${u}_wa4.0_w44.1`;
const UP = "w70.f_r70";
const BELL = "w50.0_r60_w64.1";

// `needs`: the chapter 15 section a misbehaving scenario builds on, so the view can tell a
// reader who meets the lab right after the status table which scenarios to save for later.
export const PRESETS = Object.freeze([
  {
    key: "probe", group: "captured", device: "rng", ramMiB: 64,
    title: "The probe's handshake",
    about: "The course's probe guest brings up the entropy device in slot 0. These are the 33 accesses traced on a real Mac (the chapter's trace): status 0, 1, 3, 0xb, 0xf, one queue, one doorbell, one interrupt.",
    actions: acts(`r0_r4_r0.1_r0.2_r0.8_r8_w70.0_w70.1_w70.3_w14.1_r10_w24.0_w20.0_w24.1_w20.1_w70.b_r70_r8_${queue()}_${UP}_${BELL}`),
  },
  {
    key: "linux", group: "captured", device: "blk", ramMiB: 512,
    title: "Linux brings up a disk",
    about: "Linux's own virtio-blk driver bringing up a 64 MiB disk in a 512 MiB guest: the first 40 accesses traced on a real Mac. It reads Status back after the reset, after ACKNOWLEDGE and after FEATURES_OK, accepts only the features it knows (0x10000244: SEG_MAX, BLK_SIZE, FLUSH, INDIRECT_DESC, VERSION_1), and reads the disk's size from the config space before DRIVER_OK.",
    actions: acts("r0_r4_r8_rc_w70.0_r70_w70.1_r70_w70.3_w14.1_r10_w14.0_r10_w24.1_w20.1_w24.0_w20.10000244_r70_w70.b_r70_w30.0_r44_r34_w38.100_w80.4405c000_w84.0_w90.4405d000_w94.0_wa0.4405e000_wa4.0_w44.1_r10c_r114_rfc_r100_r104_rfc_r70_w70.f_w50.0"),
  },
  {
    key: "skip-features", group: "misbehaves", needs: "The handshake is a state machine", device: "rng", ramMiB: 64,
    title: "Skips FEATURES_OK",
    about: "After DRIVER the driver jumps straight to DRIVER_OK, without agreeing on features.",
    actions: acts(`${ID}_w70.7_r70_w70.f_r70`),
  },
  {
    key: "no-version1", group: "misbehaves", needs: "Features: the device has the last word", device: "rng", ramMiB: 64,
    title: "Does not accept VERSION_1",
    about: "A buggy driver accepts no feature at all, so not VERSION_1, and still asks for FEATURES_OK. Without VERSION_1 the device cannot know the driver follows the 1.x rules, so it must refuse. The driver finds FEATURES_OK clear, gives up with FAILED, and then tries DRIVER_OK anyway. (A truly legacy driver would read Version 2 and stop there.)",
    actions: acts(`${ID}_w24.0_w20.0_w24.1_w20.0_w70.b_r70_w70.83_r70_w70.f_r70_w70.0_r70`),
  },
  {
    key: "unoffered", group: "misbehaves", needs: "Features: the device has the last word", device: "rng", ramMiB: 64,
    title: "Accepts a feature nobody offered",
    about: "The driver accepts EVENT_IDX (bit 29) as well as VERSION_1. The entropy device never offered it, and our devices never implement it.",
    actions: acts(`${ID}_w24.0_w20.20000000_w24.1_w20.1_w70.b_r70`),
  },
  {
    key: "beyond-63", group: "misbehaves", needs: "Features: the device has the last word", device: "rng", ramMiB: 64,
    title: "Accepts a bit beyond 63",
    about: "The driver selects feature word 2 (bits 64 to 95) and sets a bit there.",
    actions: acts(`${ID}_w24.0_w20.0_w24.1_w20.1_w24.2_w20.1_w70.b_r70`),
  },
  {
    key: "late-features", group: "misbehaves", needs: "Features: the device has the last word", device: "rng", ramMiB: 64,
    title: "Changes features after FEATURES_OK",
    about: "Once FEATURES_OK has latched, the driver tries to withdraw VERSION_1, then carries on.",
    actions: acts(`${ID}_${FEAT}_w24.1_w20.0_r70_${queue()}_${UP}`),
  },
  {
    key: "bad-queue-size", group: "misbehaves", needs: "Queue registers, and when they freeze", device: "rng", ramMiB: 64,
    title: "Bad queue sizes",
    about: "QueueNumMax says 64. The driver tries 100 (not a power of two), 128 (too big) and 0, then 16.",
    actions: acts(`${ID}_${FEAT}_w30.0_r34_w38.64_w38.80_w38.0_w38.10_w80.40085000_w84.0_w90.40085400_w94.0_wa0.40085800_wa4.0_w44.1_${UP}`),
  },
  {
    key: "outside-ram", group: "misbehaves", needs: "DRIVER_OK: the device commits", device: "rng", ramMiB: 64,
    title: "A ring past the end of RAM",
    about: "The used ring starts 128 bytes before the end of the guest's 64 MiB, but a 16-entry used ring is 134 bytes long. Watch DRIVER_OK, the interrupt, and the reset that recovers.",
    actions: acts(`${ID}_${FEAT}_${queue("40085000", "40085400", "43ffff80")}_${UP}_w50.0_r60_w64.2_r60_r70_w70.0_r70`),
  },
  {
    key: "ring-in-mmio", group: "misbehaves", needs: "DRIVER_OK: the device commits", device: "rng", ramMiB: 64,
    title: "A ring on top of the UART",
    about: "The descriptor table is placed at 0x0900_0000, the PL011's registers. That is not RAM.",
    actions: acts(`${ID}_${FEAT}_${queue("9000000")}_${UP}_r60`),
  },
  {
    key: "misaligned", group: "misbehaves", needs: "DRIVER_OK: the device commits", device: "rng", ramMiB: 64,
    title: "A misaligned descriptor table",
    about: "The descriptor table must be 16-byte aligned; the driver puts it 8 bytes off. The reference checks alignment at DRIVER_OK (virtio 1.2 section 2.7, the split virtqueue alignment table). Your chapter 15 validate checks only that each ring is inside RAM, so it would accept this queue; chapter 16 adds the alignment check.",
    actions: acts(`${ID}_${FEAT}_${queue("40085008")}_${UP}`),
  },
  {
    key: "high-half", group: "misbehaves", needs: "Queue registers, and when they freeze", device: "rng", ramMiB: 64,
    title: "Forgets the high half",
    about: "The driver writes QueueDescHigh = 1 by mistake, then the right low half. Each half write keeps the other half, so the address is 0x1_4008_5000, far outside RAM.",
    actions: acts(`${ID}_${FEAT}_w30.0_r34_w38.10_w84.1_w80.40085000_w90.40085400_w94.0_wa0.40085800_wa4.0_w44.1_${UP}`),
  },
  {
    key: "late-queue-write", group: "misbehaves", needs: "Queue registers, and when they freeze", device: "rng", ramMiB: 64,
    title: "Moves a live queue",
    about: "After DRIVER_OK the driver tries to move the descriptor table, resize the queue and mark it not ready. If the device accepted these, a hostile guest could swap a checked ring for an unchecked one.",
    actions: acts(`${ID}_${FEAT}_${queue()}_${UP}_w80.0_w38.20_w44.0_r44`),
  },
  {
    key: "notify-early", group: "misbehaves", needs: "The doorbell, and \"done\"", device: "rng", ramMiB: 64,
    title: "Rings the doorbell too early",
    about: "A doorbell before DRIVER_OK, one for a queue that does not exist, and then a valid one.",
    actions: acts(`${ID}_${FEAT}_w50.0_${queue()}_${UP}_w50.3_w50.0_r60_w64.1`),
  },
  {
    key: "narrow", group: "misbehaves", needs: "One transport per slot", device: "rng", ramMiB: 64,
    title: "Narrow and misaligned accesses",
    about: "Control registers take aligned 32-bit accesses only. The driver tries 1-, 2- and 8-byte accesses and a misaligned one, then does it right. On real hardware the misaligned one would normally fault inside the guest before reaching the VMM; the device checks anyway, because it must never trust the access it is given.",
    actions: acts("r0_r0.1_w70.1.1_w70.1.2_w70.1.8_w71.1_r70_w70.1_r70"),
  },
  {
    key: "wrong-ack", group: "misbehaves", needs: "The doorbell, and \"done\"", device: "rng", ramMiB: 64,
    title: "Acknowledges the wrong bit",
    about: "After a used-buffer interrupt the driver writes 2 to InterruptACK, then writes 0xfffffffd.",
    actions: acts(`${ID}_${FEAT}_${queue()}_${UP}_w50.0_r60_w64.2_r60_w64.fffffffd_r60`),
  },
  {
    key: "huge-queue-sel", group: "misbehaves", needs: "Queue registers, and when they freeze", device: "rng", ramMiB: 64,
    title: "Selects queue 4,294,967,295",
    about: "QueueSel takes any 32-bit value; the device has one queue.",
    actions: acts(`${ID}_${FEAT}_w30.ffffffff_r34_r44_w38.4_w80.1000_w44.1_w30.0_r34_r44`),
  },
  {
    key: "uboot", group: "misbehaves", needs: "The handshake is a state machine", device: "rng", ramMiB: 64,
    title: "Writes DRIVER alone (U-Boot)",
    about: "U-Boot sets ACKNOWLEDGE, later resets the device, and then writes DRIVER (2) without ACKNOWLEDGE. QEMU accepts it, so we do too.",
    actions: acts("r0_r4_r8_w70.1_r70_w70.0_w70.2_r70"),
  },
  {
    key: "empty-slot", group: "misbehaves", needs: "Is anybody there? The empty slot", device: "empty", ramMiB: 64,
    title: "Talks to an empty slot",
    about: "A slot with no device: it answers MagicValue and Version, reads 0 everywhere else, and ignores writes.",
    actions: acts("r0_r4_r8_r10_w70.1_r70_w30.0_r34"),
  },
  { key: "rng", group: "blank", device: "rng", ramMiB: 64, title: "Entropy device, no steps", about: "An entropy device in slot 0 and 64 MiB of RAM. Write and read the registers yourself.", actions: acts("") },
  { key: "blk", group: "blank", device: "blk", ramMiB: 512, title: "Disk, no steps", about: "A 64 MiB virtio disk in slot 0 and 512 MiB of RAM. Write and read the registers yourself.", actions: acts("") },
  { key: "empty", group: "blank", device: "empty", ramMiB: 64, title: "Empty slot, no steps", about: "No device in slot 0. Write and read the registers yourself.", actions: acts("") },
].map(Object.freeze));
const PRESET_BY_KEY = new Map(PRESETS.map((p) => [p.key, p]));
export function preset(key) { return PRESET_BY_KEY.get(key) ?? null; }

export const DEFAULT_PRESET = "probe";
/** The reference share string quoted in LABS.md: the finished "ring past the end of RAM" walk. */
export const REFERENCE_SHARE = "outside-ram";

/** Replay `actions` on preset `key`'s device; rows[0] is the initial state. */
export function replay(key, actions) {
  const p = preset(key);
  if (!p) throw new Error(`unknown preset ${key}`);
  let s = initial(p.device, p.ramMiB);
  const rows = [{ state: s, action: null, read: null, label: "start", effect: `A freshly built ${DEVICES[p.device].name} in slot 0; Status is 0.`, log: null, taken: null }];
  for (const a of actions) {
    const r = apply(s, a);
    s = r.state;
    rows.push({ ...r, action: a });
  }
  return rows;
}

/** The capture's format: one line per exit, `"ipa":"0x…","wnr":…,"value":"0x…"`. */
export function traceLine(row) {
  const a = row.action;
  if (!a || a.op === "c") return null;
  const value = a.op === "w" ? hex(a.val) : hex(row.read);
  return `"ipa":"${hex(SLOT_BASE + a.off)}","wnr":${a.op === "w"},"value":"${value}"`;
}
export function formatTrace(rows) {
  return rows.map(traceLine).filter((l) => l !== null).join("\n");
}

/** Predict-the-outcome scoring: `guess` is "takes" or "ignores". */
export function scoreGuess(guess, taken) {
  if (guess !== "takes" && guess !== "ignores") return null;
  if (taken === null) return null;
  const actual = taken ? "takes" : "ignores";
  return { guess, actual, right: guess === actual };
}

// ---- share state --------------------------------------------------------------------------
// `<preset>` (the preset's own steps, all applied), `<preset>~N` (N applied), or
// `<preset>:<actions>[~N]` when the steps differ from the preset's. Actions are joined by `_`:
// `w<off>.<val>[.<size>]`, `r<off>[.<size>]`, `c`; hex without 0x, size in bytes, default 4.

function sameActions(a, b) {
  return a.length === b.length && a.every((x, i) => encodeAction(x) === encodeAction(b[i]));
}

export function encodeShare({ preset: key, actions, cursor }) {
  const p = preset(key);
  if (!p) return "";
  const own = sameActions(actions, p.actions);
  let s = own ? key : `${key}:${actions.map(encodeAction).join("_")}`;
  if (cursor < actions.length) s += `~${cursor}`;
  return s;
}

/** Hostile-input-safe parse of a share string; null if anything is off. */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > MAX_SHARE) return null;
  const m = /^([a-z0-9-]{1,24})(?::([0-9a-fcrw._]*))?(?:~(\d{1,3}))?$/.exec(str);
  if (!m) return null;
  const p = preset(m[1]);
  if (!p) return null;
  const actions = m[2] === undefined ? [...p.actions] : decodeActions(m[2]);
  if (!actions) return null;
  const cursor = m[3] === undefined ? actions.length : Number(m[3]);
  if (cursor > actions.length) return null;
  return { preset: p.key, actions, cursor };
}

/** Parse a number typed by the reader: decimal or 0x hex, `_` allowed, at most `max`. */
export function parseNumber(text, max = 0xffff_ffff) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/_/g, "").toLowerCase();
  if (t.length === 0 || t.length > 12) return null;
  let v;
  if (/^0x[0-9a-f]{1,8}$/.test(t)) v = parseInt(t.slice(2), 16);
  else if (/^[0-9]{1,10}$/.test(t)) v = Number(t);
  else return null;
  return v <= max ? v : null;
}

/** The queue view: addresses as BigInt, whether frozen, and the DRIVER_OK check if it ran now. */
export function queueView(s, i) {
  const q = s.queues[i];
  if (!q) return null;
  return {
    index: i, max: q.max, size: q.size, ready: q.ready,
    desc: join(...q.desc), avail: join(...q.avail), used: join(...q.used),
    frozen: q.ready || (s.status & STATUS.DRIVER_OK) !== 0,
    check: validateQueue(s, q),
  };
}

/** Where the handshake stands: index into STATUS_STEPS of the last step reached, or -1. */
export function stepIndex(s) {
  return STATUS_STEPS.indexOf(s.status & 0xf);
}
