// Tests for the virtio-status model. Run: node --test 'course/site/**/*.test.mjs'
// The first tests replay the two captured presets and compare them, line for line, with the real
// traces the chapter prints (course/captures/15-handshake-trace.txt and 15-linux-handshake.txt).
// Most of the rest port crates/vmm/tests/virtio_mmio_state.rs and the unit test in
// crates/vmm/src/virtio/interrupt.rs, so the lab and the Rust transport cannot drift apart.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  REG, REGISTERS, STATUS, STATUS_STEPS, INT, F, NEVER_OFFERED, MAGIC_VALUE, VENDOR_ID, NO_SHM_REGION, DEVICES,
  PRESETS, DEFAULT_PRESET, REFERENCE_SHARE, MAX_ACTIONS, MAX_SHARE,
  initial, apply, replay, formatTrace, statusRead, driverFeatures, preset, queueView, stepIndex,
  encodeShare, decodeShare, decodeAction, encodeAction, decodeActions, parseNumber, scoreGuess,
  validateAction, describeAction, statusNames, featureNames, hex,
} from "./model.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const CAPTURES = here("../../../../captures/");
const LABS_MD = here("../../../LABS.md");
const MMIO_RS = here("../../../../../crates/vmm/src/virtio/mmio.rs");
const MOD_RS = here("../../../../../crates/vmm/src/virtio/mod.rs");

const V1_HI = 1;
const RAM_END = 0x4400_0000; // 64 MiB at 0x4000_0000

// A rig in the shape of the Rust fixture: w/r at 32 bits on the entropy device (or another).
function rig(device = "rng", ramMiB = 64) {
  let s = initial(device, ramMiB);
  let last = null;
  const f = {
    get s() { return s; },
    get last() { return last; },
    w(off, val, size = 4) { last = apply(s, { op: "w", off, val: val >>> 0, size }); s = last.state; return last; },
    r(off, size = 4) { last = apply(s, { op: "r", off, size }); s = last.state; return Number(last.read); },
    status() { return f.r(REG.STATUS); },
    negotiate(lo, hi) {
      f.w(REG.STATUS, STATUS.ACKNOWLEDGE);
      f.w(REG.STATUS, STATUS.ACKNOWLEDGE | STATUS.DRIVER);
      f.w(REG.DRIVER_FEATURES_SEL, 0);
      f.w(REG.DRIVER_FEATURES, lo);
      f.w(REG.DRIVER_FEATURES_SEL, 1);
      f.w(REG.DRIVER_FEATURES, hi);
      f.w(REG.STATUS, 0xb);
      return f.status();
    },
    setupQueue(sel, n, desc, avail, used) {
      f.w(REG.QUEUE_SEL, sel);
      f.w(REG.QUEUE_NUM, n);
      for (const [lo, a] of [[REG.QUEUE_DESC_LOW, desc], [REG.QUEUE_DRIVER_LOW, avail], [REG.QUEUE_DEVICE_LOW, used]]) {
        f.w(lo, Number(BigInt(a) & 0xffff_ffffn));
        f.w(lo + 4, Number(BigInt(a) >> 32n));
      }
      f.w(REG.QUEUE_READY, 1);
    },
    up() {
      assert.equal(f.negotiate(0, V1_HI), 0xb);
      f.setupQueue(0, 8, DESC, AVAIL, USED);
      f.w(REG.STATUS, 0xf);
      return f.status();
    },
  };
  return f;
}
const DESC = 0x4008_5000, AVAIL = 0x4008_5400, USED = 0x4008_5800;

function captureLines(name) {
  const text = readFileSync(`${CAPTURES}${name}`, "utf8").split("\n");
  const start = text.indexOf("--- stdout ---");
  const end = text.indexOf("--- stderr ---");
  return text.slice(start + 1, end).filter((l) => l.length > 0);
}

for (const [key, file] of [["probe", "15-handshake-trace.txt"], ["linux", "15-linux-handshake.txt"]]) {
  test(`preset ${key} reproduces captures/${file} line for line`, (t) => {
    if (!existsSync(`${CAPTURES}${file}`)) { t.skip(`capture missing: ${file}`); return; }
    const want = captureLines(file);
    const got = formatTrace(replay(key, preset(key).actions)).split("\n");
    assert.equal(got.length, want.length);
    assert.deepEqual(got, want);
  });
}

test("the probe's run ends where the chapter says", () => {
  const rows = replay("probe", preset("probe").actions);
  const s = rows.at(-1).state;
  assert.equal(statusRead(s), 0xf);
  assert.equal(s.intStatus, 0);
  assert.equal(s.line, false);
  assert.deepEqual(s.transitions, [true, false]);
  assert.equal(s.acked, F.VERSION_1);
  assert.equal(s.queues[0].size, 16);
  // Status writes 0, 1, 3, 0xb, 0xf, every one taken.
  const writes = rows.filter((r) => r.action && r.action.op === "w" && r.action.off === REG.STATUS);
  assert.deepEqual(writes.map((r) => r.action.val), [0, 1, 3, 0xb, 0xf]);
  assert.ok(writes.every((r) => r.taken === true));
  // The three narrow reads: RAZ with the reference's warning text (15-probe-rng.txt stderr).
  const narrow = rows.filter((r) => r.log && /not an aligned 32-bit access/.test(r.log.text)).map((r) => r.log.text);
  assert.deepEqual(narrow, [
    "virtio-mmio: 1-byte read at 0x0 is not an aligned 32-bit access (RAZ)",
    "virtio-mmio: 2-byte read at 0x0 is not an aligned 32-bit access (RAZ)",
    "virtio-mmio: 8-byte read at 0x0 is not an aligned 32-bit access (RAZ)",
  ]);
  if (existsSync(`${CAPTURES}15-probe-rng.txt`)) {
    const stderr = readFileSync(`${CAPTURES}15-probe-rng.txt`, "utf8");
    for (const line of narrow) assert.ok(stderr.includes(`guest: ${line}`), line);
  }
});

test("Linux's disk: features, config space and queue match the capture's numbers", () => {
  const rows = replay("linux", preset("linux").actions);
  const s = rows.at(-1).state;
  assert.equal(s.acked, (1n << 32n) | 0x1000_0244n);
  assert.equal(s.queues[0].size, 256);
  assert.equal(statusRead(s), 0xf);
  assert.equal(s.intStatus, INT.USED, "the doorbell completed one request");
  assert.ok(rows.every((r) => r.log === null), "Linux never trips a warning");
});

test("LABS.md quotes the reference share string and this lab's row", () => {
  const p = preset(REFERENCE_SHARE);
  assert.equal(encodeShare({ preset: p.key, actions: [...p.actions], cursor: p.actions.length }), "outside-ram");
  if (existsSync(LABS_MD)) {
    const md = readFileSync(LABS_MD, "utf8");
    assert.ok(md.includes("| `virtio-status` |"), "LABS.md has the virtio-status row");
    assert.ok(md.includes("`outside-ram`"), "LABS.md names the reference");
  }
});

test("constants match the Rust source", (t) => {
  if (!existsSync(MMIO_RS) || !existsSync(MOD_RS)) { t.skip("reference source not found"); return; }
  const mmio = readFileSync(MMIO_RS, "utf8");
  const mod = readFileSync(MOD_RS, "utf8");
  const num = (src, name, ty = "(?:32|64)") => {
    const m = new RegExp(`pub const ${name}: u${ty} = (0x[0-9a-f_]+|\\d+);`).exec(src);
    assert.ok(m, name);
    return Number(m[1].replace(/_/g, ""));
  };
  for (const [js, rust] of Object.entries({
    MAGIC: "MAGIC", VERSION: "VERSION", DEVICE_ID: "DEVICE_ID", VENDOR_ID: "VENDOR_ID", DEVICE_FEATURES: "DEVICE_FEATURES",
    DEVICE_FEATURES_SEL: "DEVICE_FEATURES_SEL", DRIVER_FEATURES: "DRIVER_FEATURES", DRIVER_FEATURES_SEL: "DRIVER_FEATURES_SEL",
    QUEUE_SEL: "QUEUE_SEL", QUEUE_NUM_MAX: "QUEUE_NUM_MAX", QUEUE_NUM: "QUEUE_NUM", QUEUE_READY: "QUEUE_READY",
    QUEUE_NOTIFY: "QUEUE_NOTIFY", INTERRUPT_STATUS: "INTERRUPT_STATUS", INTERRUPT_ACK: "INTERRUPT_ACK", STATUS: "STATUS",
    QUEUE_DESC_LOW: "QUEUE_DESC_LOW", QUEUE_DESC_HIGH: "QUEUE_DESC_HIGH", QUEUE_DRIVER_LOW: "QUEUE_DRIVER_LOW",
    QUEUE_DRIVER_HIGH: "QUEUE_DRIVER_HIGH", QUEUE_DEVICE_LOW: "QUEUE_DEVICE_LOW", QUEUE_DEVICE_HIGH: "QUEUE_DEVICE_HIGH",
    SHM_SEL: "SHM_SEL", SHM_LEN_LOW: "SHM_LEN_LOW", QUEUE_RESET: "QUEUE_RESET", CONFIG_GENERATION: "CONFIG_GENERATION", CONFIG: "CONFIG",
  })) assert.equal(REG[js], num(mmio, rust), js);
  assert.equal(MAGIC_VALUE, num(mmio, "MAGIC_VALUE", "32"));
  assert.equal(VENDOR_ID, num(mmio, "VENDOR_ID", "32"));
  for (const k of ["ACKNOWLEDGE", "DRIVER", "DRIVER_OK", "FEATURES_OK", "DEVICE_NEEDS_RESET", "FAILED"]) assert.equal(STATUS[k], num(mod, k), k);
  for (const k of ["INDIRECT_DESC", "EVENT_IDX", "VERSION_1", "ACCESS_PLATFORM", "RING_PACKED", "NOTIFICATION_DATA", "RING_RESET"]) {
    const m = new RegExp(`pub const ${k}: u64 = 1 << (\\d+);`).exec(mod);
    assert.ok(m, k);
    assert.equal(F[k], 1n << BigInt(m[1]), k);
  }
  assert.equal(NEVER_OFFERED, F.EVENT_IDX | F.ACCESS_PLATFORM | F.RING_PACKED | F.NOTIFICATION_DATA | F.RING_RESET);
  assert.match(mod, /pub const DEVICE_ID_RNG: u32 = 4;/);
  assert.match(mod, /pub const DEVICE_ID_BLOCK: u32 = 2;/);
});

// ---- ports of virtio_mmio_state.rs (the mock there has queues [256, 64]; we use the rng) ----

test("identity registers, read-only", () => {
  const f = rig();
  assert.equal(f.r(REG.MAGIC), MAGIC_VALUE);
  assert.equal(f.r(REG.VERSION), 2);
  assert.equal(f.r(REG.DEVICE_ID), 4);
  assert.equal(f.r(REG.VENDOR_ID), VENDOR_ID);
  f.w(REG.DEVICE_ID, 9);
  assert.equal(f.last.taken, false);
  assert.equal(f.r(REG.DEVICE_ID), 4);
});

test("empty slot is magic, version and device id 0", () => {
  const f = rig("empty");
  assert.equal(f.r(REG.MAGIC), MAGIC_VALUE);
  assert.equal(f.r(REG.VERSION), 2);
  assert.equal(f.r(REG.DEVICE_ID), 0);
  for (let off = 0x00c; off < 0x200; off += 4) {
    assert.equal(f.r(off), 0, hex(off));
    f.w(off, 0xffff_ffff);
  }
  assert.equal(f.status(), 0);
  assert.equal(f.r(REG.MAGIC, 1), 0, "narrow: RAZ");
});

test("status bits only in order", () => {
  const f = rig();
  for (const bad of [STATUS.FEATURES_OK, STATUS.DRIVER_OK, 1 | 8, 2 | 4]) {
    f.w(REG.STATUS, bad);
    assert.equal(f.status(), 0, hex(bad));
  }
  f.w(REG.STATUS, STATUS.DRIVER);
  assert.equal(f.status(), 3, "DRIVER implies ACKNOWLEDGE");
  f.w(REG.STATUS, 0);
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 1 | 4);
  assert.equal(f.status(), 1);
  f.w(REG.STATUS, 3);
  f.w(REG.STATUS, 3 | 4);
  assert.equal(f.status(), 3);
  assert.equal(f.last.read, 3n);
});

test("status bits cannot be cleared except by reset", () => {
  const f = rig();
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 3);
  f.w(REG.STATUS, 1);
  assert.equal(f.last.log.text, "virtio-mmio: Status 1 after 3 ignored: bits out of order");
  assert.equal(f.status(), 3);
  f.w(REG.STATUS, 2);
  assert.equal(f.status(), 3);
});

test("unknown and device-owned status bits are refused", () => {
  const f = rig();
  f.w(REG.STATUS, 1);
  for (const bad of [1 | 16, 1 | 32, 1 | STATUS.DEVICE_NEEDS_RESET, 1 | 0x100, 0xffff_ff01]) {
    f.w(REG.STATUS, bad);
    assert.equal(f.status(), 1, hex(bad));
  }
});

test("any write with FAILED set latches FAILED (write_status checks it before the order)", () => {
  const f = rig();
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 0xffff_ff81);
  assert.equal(f.status(), 0x81);
});

test("FEATURES_OK requires VERSION_1", () => {
  const f = rig();
  assert.equal(f.negotiate(1, 0), 3);
  assert.equal(f.s.acked, null);
});

test("FEATURES_OK refuses unoffered bits", () => {
  const f = rig();
  assert.equal(f.negotiate(1 | (1 << 5), V1_HI), 3);
});

test("FEATURES_OK refuses every feature v1 never offers (and INDIRECT_DESC on the rng)", () => {
  for (const bit of [F.EVENT_IDX, F.ACCESS_PLATFORM, F.RING_PACKED, F.NOTIFICATION_DATA, F.RING_RESET, F.INDIRECT_DESC]) {
    const f = rig();
    const all = F.VERSION_1 | bit;
    assert.equal(f.negotiate(Number(all & 0xffff_ffffn), Number(all >> 32n)), 3, hex(bit));
  }
});

test("FEATURES_OK refuses bits beyond 63", () => {
  const f = rig();
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 3);
  f.w(REG.DRIVER_FEATURES_SEL, 2);
  f.w(REG.DRIVER_FEATURES, 1);
  assert.equal(f.negotiate(0, V1_HI) & STATUS.FEATURES_OK, 0);
});

test("FEATURES_OK latches and the feature set is then fixed", () => {
  const f = rig("blk", 512);
  f.w(REG.DEVICE_FEATURES_SEL, 0);
  assert.equal(f.r(REG.DEVICE_FEATURES), 0x1000_0244);
  f.w(REG.DEVICE_FEATURES_SEL, 1);
  assert.equal(f.r(REG.DEVICE_FEATURES), V1_HI);
  f.w(REG.DEVICE_FEATURES_SEL, 7);
  assert.equal(f.r(REG.DEVICE_FEATURES), 0);
  assert.equal(f.negotiate(0x4, V1_HI), 0xb);
  assert.equal(f.s.acked, F.VERSION_1 | 4n);
  f.w(REG.DRIVER_FEATURES_SEL, 0);
  f.w(REG.DRIVER_FEATURES, 0);
  assert.equal(f.last.taken, false);
  assert.equal(driverFeatures(f.s), F.VERSION_1 | 4n);
});

test("DriverFeatures before the DRIVER bit is ignored", () => {
  const f = rig();
  f.w(REG.DRIVER_FEATURES_SEL, 1);
  f.w(REG.DRIVER_FEATURES, V1_HI);
  assert.equal(f.last.log.text, "virtio-mmio: DriverFeatures ignored in status 0 (virtio section 3.1.1 order)");
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 3);
  f.w(REG.STATUS, 11);
  assert.equal(f.status(), 3);
});

test("QueueNum must be a power of two up to the max", () => {
  const f = rig();
  assert.equal(f.r(REG.QUEUE_NUM_MAX), 64);
  for (const bad of [0, 3, 100, 128, 65, 0x1_0000 + 16, 0xffff_ffff]) {
    f.w(REG.QUEUE_NUM, bad);
    assert.equal(f.s.queues[0].size, 64, hex(bad));
  }
  f.w(REG.QUEUE_NUM, 16);
  assert.equal(f.s.queues[0].size, 16);
});

test("QueueSel out of range reads 0 and ignores writes", () => {
  const f = rig();
  for (const sel of [1, 31, 0xffff_ffff]) {
    f.w(REG.QUEUE_SEL, sel);
    assert.equal(f.r(REG.QUEUE_NUM_MAX), 0);
    assert.equal(f.r(REG.QUEUE_READY), 0);
    f.w(REG.QUEUE_NUM, 4);
    f.w(REG.QUEUE_READY, 1);
    f.w(REG.QUEUE_DESC_LOW, 0x1000);
  }
  assert.equal(f.s.queues[0].ready, false);
  assert.equal(f.s.queues[0].desc[0], 0);
});

test("queue registers are frozen once ready; QueueReady 0 unfreezes before DRIVER_OK", () => {
  const f = rig();
  f.setupQueue(0, 8, DESC, AVAIL, USED);
  f.w(REG.QUEUE_NUM, 16);
  f.w(REG.QUEUE_DESC_LOW, 0x1234_0000);
  f.w(REG.QUEUE_DRIVER_HIGH, 1);
  f.w(REG.QUEUE_DEVICE_LOW, 0);
  const q = queueView(f.s, 0);
  assert.equal(q.size, 8);
  assert.equal(q.desc, BigInt(DESC));
  assert.equal(q.avail, BigInt(AVAIL));
  assert.equal(q.used, BigInt(USED));
  f.w(REG.QUEUE_READY, 0);
  f.w(REG.QUEUE_NUM, 16);
  assert.equal(f.s.queues[0].size, 16);
});

test("queue registers are frozen after DRIVER_OK (the chapter's deliberate break)", () => {
  const f = rig();
  assert.equal(f.up(), 0xf);
  f.w(REG.QUEUE_NUM, 4);
  f.w(REG.QUEUE_DESC_LOW, 0x2000);
  f.w(REG.QUEUE_READY, 0);
  assert.equal(f.last.log.text, "virtio-mmio: QueueReady ignored after DRIVER_OK");
  assert.equal(f.s.queues[0].ready, true);
  assert.equal(f.s.queues[0].size, 8);
  assert.equal(f.s.queues[0].desc[0], DESC);
});

test("ring addresses are hi << 32 | lo", () => {
  const f = rig();
  f.w(REG.QUEUE_DESC_HIGH, 1);
  f.w(REG.QUEUE_DESC_LOW, 0xffff_fff0);
  assert.equal(queueView(f.s, 0).desc, 0x1_ffff_fff0n);
  f.w(REG.QUEUE_DESC_LOW, 0x10);
  f.w(REG.QUEUE_DESC_HIGH, 0xffff_ffff);
  assert.equal(queueView(f.s, 0).desc, 0xffff_ffff_0000_0010n);
});

test("narrow or unaligned control accesses are RAZ/WI", () => {
  const f = rig();
  for (const [off, size] of [[REG.MAGIC, 1], [REG.MAGIC, 2], [REG.MAGIC, 8], [REG.MAGIC + 1, 4], [REG.VERSION + 2, 2]]) {
    assert.equal(f.r(off, size), 0, `${hex(off)} ${size}`);
  }
  for (const [off, size] of [[REG.STATUS, 1], [REG.STATUS, 2], [REG.STATUS, 8], [REG.STATUS + 1, 4]]) {
    f.w(off, 1, size);
    assert.equal(f.last.taken, false);
  }
  assert.equal(f.status(), 0);
});

test("config space is bounded per device and read-only on the disk", () => {
  const f = rig("blk", 512);
  assert.equal(f.r(REG.CONFIG, 4), 0x20000);
  assert.equal(f.r(REG.CONFIG + 4, 4), 0);
  assert.equal(f.r(REG.CONFIG + 0xc, 4), 126);
  assert.equal(f.r(REG.CONFIG + 0x14, 4), 512);
  assert.equal(f.last.read, 512n);
  f.r(REG.CONFIG, 8);
  assert.equal(f.last.read, 0x20000n);
  f.r(REG.CONFIG + 8, 8);
  assert.equal(f.last.read, (126n << 32n) | 0x10000n);
  assert.equal(f.r(REG.CONFIG + 0x16, 4), 0, "beyond the 24-byte space");
  assert.match(f.last.log.text, /outside the 24-byte config space/);
  assert.equal(f.r(REG.CONFIG + 0xff, 1), 0);
  f.w(REG.CONFIG, 0xffff_ffff, 4);
  assert.equal(f.last.taken, false);
  assert.equal(f.r(REG.CONFIG, 4), 0x20000);
  const g = rig();
  assert.equal(g.r(REG.CONFIG, 1), 0, "the rng has no config space");
  assert.equal(g.last.log.text, "virtio-mmio: config access of 1 bytes at 0x0 outside the 0-byte config space (RAZ/WI)");
});

test("ConfigGeneration is stable and bumps on a device change", () => {
  const f = rig("blk", 512);
  const g = f.r(REG.CONFIG_GENERATION);
  assert.equal(f.r(REG.CONFIG_GENERATION), g);
  f.w(REG.CONFIG_GENERATION, 99);
  assert.equal(f.r(REG.CONFIG_GENERATION), g);
  let s = apply(f.s, { op: "c" }).state;
  assert.equal(s.configGen, g + 1);
  assert.equal(s.intStatus, INT.CONFIG);
  assert.equal(s.line, true);
});

test("writing 0 resets everything", () => {
  const f = rig();
  assert.equal(f.up(), 0xf);
  f.w(REG.QUEUE_SEL, 1);
  f.w(REG.DEVICE_FEATURES_SEL, 1);
  f.w(REG.QUEUE_NOTIFY, 0); // the doorbell names its queue; QueueSel does not matter
  assert.equal(f.s.line, true);
  f.w(REG.STATUS, 0);
  assert.equal(f.status(), 0);
  assert.equal(f.r(REG.INTERRUPT_STATUS), 0);
  assert.equal(f.s.line, false);
  assert.equal(f.r(REG.QUEUE_READY), 0, "QueueSel reset to 0, queue 0 not ready");
  const q = f.s.queues[0];
  assert.ok(!q.ready && q.size === 64 && q.desc[0] === 0);
  assert.equal(f.r(REG.DEVICE_FEATURES), 0, "selector back to 0: the rng offers nothing in bits 0-31");
  assert.equal(f.s.resets, 1);
  assert.equal(f.up(), 0xf);
  assert.equal(f.s.activations, 2);
});

test("DRIVER_OK with a ring outside RAM sets NEEDS_RESET and a config interrupt", () => {
  const f = rig();
  assert.equal(f.negotiate(0, V1_HI), 0xb);
  f.setupQueue(0, 8, DESC, AVAIL, RAM_END - 8);
  f.w(REG.STATUS, 0xf);
  assert.equal(f.last.taken, true);
  assert.equal(f.last.log.text, `virtio-mmio: queue 0 refused at DRIVER_OK: virtqueue: RingOutOfRam { ring: Used, addr: ${RAM_END - 8}, len: 70 }`);
  assert.equal(f.status(), 0xf | STATUS.DEVICE_NEEDS_RESET);
  assert.equal(f.r(REG.INTERRUPT_STATUS), 2);
  assert.equal(f.s.line, true);
  assert.equal(f.s.activations, 0);
});

test("DRIVER_OK with misaligned or MMIO rings sets NEEDS_RESET", () => {
  for (const [d, a, u] of [[DESC + 8, AVAIL, USED], [DESC, AVAIL + 1, USED], [DESC, AVAIL, USED + 2], [0x0900_0000, AVAIL, USED], [0xffff_ffff_ffff_fff0n, AVAIL, USED]]) {
    const f = rig();
    assert.equal(f.negotiate(0, V1_HI), 0xb);
    f.setupQueue(0, 8, d, a, u);
    f.w(REG.STATUS, 0xf);
    assert.notEqual(f.status() & STATUS.DEVICE_NEEDS_RESET, 0, `${hex(d)} ${hex(a)} ${hex(u)}`);
  }
});

test("NEEDS_RESET freezes the device until Status 0", () => {
  const f = rig();
  f.negotiate(0, V1_HI);
  f.setupQueue(0, 8, 0x0900_0000, AVAIL, USED);
  f.w(REG.STATUS, 0xf);
  f.w(REG.QUEUE_NOTIFY, 0);
  assert.equal(f.last.log.text, "virtio-mmio: QueueNotify 0 ignored in status 79");
  f.w(REG.STATUS, 0xf);
  assert.equal(f.last.log.text, "virtio-mmio: Status 15 ignored: the device needs a reset (write 0)");
  assert.equal(f.status(), 0x4f);
  f.w(REG.STATUS, 0);
  assert.equal(f.status(), 0);
  assert.equal(f.s.line, false);
});

test("FAILED is latched", () => {
  const f = rig();
  f.w(REG.STATUS, 1);
  f.w(REG.STATUS, 3 | STATUS.FAILED);
  assert.equal(f.status(), 1 | STATUS.FAILED);
  f.w(REG.STATUS, 3);
  assert.equal(f.status(), 1 | STATUS.FAILED);
  f.w(REG.STATUS, 0);
  assert.equal(f.status(), 0);
});

test("the InterruptACK protocol lowers the line (interrupt.rs level_follows_status)", () => {
  const f = rig("blk", 512);
  assert.equal(f.up(), 0xf);
  f.w(REG.QUEUE_NOTIFY, 0);
  assert.equal(f.r(REG.INTERRUPT_STATUS), 1);
  assert.equal(f.s.line, true);
  f.w(REG.INTERRUPT_ACK, 2);
  assert.equal(f.s.line, true);
  f.w(REG.INTERRUPT_ACK, 0xffff_fffd);
  assert.equal(f.r(REG.INTERRUPT_STATUS), 0);
  assert.equal(f.s.line, false);
  assert.deepEqual(f.s.transitions, [true, false]);
  // Both causes, then ack one at a time.
  let s = apply(apply(f.s, { op: "w", off: REG.QUEUE_NOTIFY, val: 0, size: 4 }).state, { op: "c" }).state;
  assert.equal(s.intStatus, 3);
  s = apply(s, { op: "w", off: REG.INTERRUPT_ACK, val: 1, size: 4 }).state;
  assert.deepEqual([s.intStatus, s.line], [2, true]);
  s = apply(s, { op: "w", off: REG.INTERRUPT_ACK, val: 0xffff_fffc, size: 4 }).state;
  assert.deepEqual([s.intStatus, s.line], [2, true]);
  s = apply(s, { op: "w", off: REG.INTERRUPT_ACK, val: 0xffff_ffff, size: 4 }).state;
  assert.deepEqual([s.intStatus, s.line], [0, false]);
});

test("QueueNotify out of range or too early is ignored", () => {
  const f = rig();
  f.w(REG.QUEUE_NOTIFY, 0);
  assert.equal(f.last.taken, false);
  assert.equal(f.up(), 0xf);
  for (const bad of [1, 2, 31, 0xffff_ffff]) {
    f.w(REG.QUEUE_NOTIFY, bad);
    assert.equal(f.last.taken, false);
  }
  assert.equal(f.last.log.text, "virtio-mmio: QueueNotify 4294967295 ignored: no such ready queue (1 queues)");
  assert.equal(f.s.notifies, 0);
  f.w(REG.QUEUE_NOTIFY, 0);
  assert.equal(f.s.notifies, 1);
});

test("QueueReset is RAZ and shared-memory registers report no region", () => {
  const f = rig();
  f.w(REG.QUEUE_RESET, 1);
  assert.equal(f.r(REG.QUEUE_RESET), 0);
  for (const off of [REG.SHM_LEN_LOW, REG.SHM_LEN_HIGH, REG.SHM_BASE_LOW, REG.SHM_BASE_HIGH]) assert.equal(f.r(off), NO_SHM_REGION);
  f.w(REG.SHM_SEL, 0);
  assert.equal(f.r(REG.SHM_LEN_LOW), NO_SHM_REGION);
});

// ---- presets, invariants, share state -----------------------------------------------------

test("every misbehaving preset ends where its story says", () => {
  const end = (k) => replay(k, preset(k).actions).at(-1).state;
  assert.equal(statusRead(end("skip-features")), 3);
  assert.equal(statusRead(end("no-version1")), 0);
  assert.equal(statusRead(end("unoffered")), 3);
  assert.equal(statusRead(end("beyond-63")), 3);
  assert.equal(end("late-features").acked, F.VERSION_1);
  assert.equal(end("bad-queue-size").queues[0].size, 16);
  assert.equal(statusRead(end("outside-ram")), 0);
  for (const k of ["ring-in-mmio", "misaligned", "high-half"]) assert.equal(statusRead(end(k)), 0x4f, k);
  assert.equal(queueView(end("high-half"), 0).desc, 0x1_4008_5000n);
  assert.equal(end("late-queue-write").queues[0].desc[0], 0x4008_5000);
  assert.equal(end("notify-early").notifies, 1);
  assert.equal(statusRead(end("narrow")), 1);
  assert.equal(end("wrong-ack").line, false);
  assert.equal(end("huge-queue-sel").queues[0].ready, false);
  assert.equal(statusRead(end("uboot")), 3);
  assert.equal(statusRead(end("empty-slot")), 0);
  // The reference walk: DRIVER_OK refused the ring, the reset recovered.
  const rows = replay("outside-ram", preset("outside-ram").actions);
  const reads = rows.filter((r) => r.read !== null).map((r) => [r.label, Number(r.read)]);
  assert.deepEqual(reads.filter(([l]) => l === "read Status").map(([, v]) => v), [0xb, 0x4f, 0x4f, 0]);
});

test("presets are well formed", () => {
  const keys = new Set();
  for (const p of PRESETS) {
    assert.ok(!keys.has(p.key), p.key);
    keys.add(p.key);
    assert.ok(DEVICES[p.device], p.key);
    assert.ok(p.actions.length <= MAX_ACTIONS);
    assert.ok(/^[a-z0-9-]{1,24}$/.test(p.key));
    assert.ok(!/§|\bM\d+\b|\bVQ-\d+|PLAN|CURRICULUM/.test(p.title + p.about), `${p.key}: author notation`);
    const share = encodeShare({ preset: p.key, actions: [...p.actions], cursor: p.actions.length });
    assert.equal(share, p.key);
    assert.deepEqual(decodeShare(share).actions.map(encodeAction), p.actions.map(encodeAction));
  }
  assert.ok(keys.has(DEFAULT_PRESET));
  assert.equal(PRESETS.filter((p) => p.group === "misbehaves").length >= 10, true);
});

test("random register sequences keep the invariants", () => {
  let seed = 0x1234_5678;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const offs = [0x14, 0x20, 0x24, 0x30, 0x38, 0x44, 0x50, 0x64, 0x70, 0x80, 0x84, 0x90, 0x94, 0xa0, 0xa4, 0x100, 0x1fc, 0x71];
  const vals = [0, 1, 2, 3, 0xb, 0xf, 0x7, 0x80, 0x40, 16, 64, 0xffff_ffff, 0x4008_5000];
  for (const dev of ["rng", "blk", "empty"]) {
    let s = initial(dev, 64);
    for (let i = 0; i < 4000; i++) {
      const a = rnd(5) === 0
        ? { op: "r", off: offs[rnd(offs.length)], size: [1, 2, 4, 8][rnd(4)] }
        : { op: "w", off: offs[rnd(offs.length)], val: vals[rnd(vals.length)], size: rnd(8) === 0 ? 1 : 4 };
      s = apply(s, a).state;
      const st = s.status & ~STATUS.FAILED;
      assert.ok(st === 0 || STATUS_STEPS.includes(st), `status ${st}`);
      assert.equal(s.line, s.intStatus !== 0);
      if (s.status & STATUS.FEATURES_OK) {
        assert.ok(s.acked !== null);
        assert.equal(s.acked & ~DEVICES[dev].features, 0n, "only offered bits");
        assert.notEqual(s.acked & F.VERSION_1, 0n);
      }
      for (const q of s.queues) assert.ok(q.size >= 1 && q.size <= q.max && (q.size & (q.size - 1)) === 0);
      if ((s.status & STATUS.DRIVER_OK) && !s.needsReset) {
        for (let k = 0; k < s.queues.length; k++) if (s.queues[k].ready) assert.ok(queueView(s, k).check.ok);
      }
    }
  }
});

test("share strings: round trip, partial cursors, custom steps", () => {
  assert.equal(encodeShare({ preset: "probe", actions: [...preset("probe").actions], cursor: 0 }), "probe~0");
  const custom = decodeShare("rng:w70.1_w70.3_r70.1_c~2");
  assert.deepEqual(custom.actions, [
    { op: "w", off: 0x70, val: 1, size: 4 }, { op: "w", off: 0x70, val: 3, size: 4 },
    { op: "r", off: 0x70, size: 1 }, { op: "c" },
  ]);
  assert.equal(custom.cursor, 2);
  assert.equal(encodeShare(custom), "rng:w70.1_w70.3_r70.1_c~2");
  assert.deepEqual(decodeShare("blk:"), { preset: "blk", actions: [], cursor: 0 });
});

test("hostile share strings are refused, never thrown", () => {
  const bad = [
    null, undefined, 42, "", "nope", "probe~34", "probe~-1", "probe~1000", "rng:w200.1", "rng:w70.100000000",
    "rng:w70.1.3", "rng:x70", "rng:w70", "rng:r70.16", "PROBE", "probe:", "rng:w70.1__w70.3",
    "rng:" + Array(MAX_ACTIONS + 1).fill("r0").join("_"), "x".repeat(MAX_SHARE + 1), "rng:w70.1~", "__proto__", "constructor",
    "rng:<script>", "rng:w70.1;alert(1)",
  ];
  for (const b of bad) {
    if (b === "probe:") { assert.deepEqual(decodeShare(b), { preset: "probe", actions: [], cursor: 0 }); continue; }
    assert.equal(decodeShare(b), null, String(b).slice(0, 40));
  }
  assert.ok(decodeShare("rng:" + Array(MAX_ACTIONS).fill("r0").join("_")));
});

test("actions: validation, encoding, labels", () => {
  assert.equal(validateAction({ op: "w", off: 0x70, val: 1, size: 4 }), null);
  assert.match(validateAction({ op: "w", off: 0x200, val: 1, size: 4 }), /offset/);
  assert.match(validateAction({ op: "r", off: 0, size: 3 }), /width/);
  assert.match(validateAction({ op: "w", off: 0, val: -1, size: 4 }), /32-bit/);
  assert.match(validateAction({ op: "w", off: 0, val: 2 ** 32, size: 4 }), /32-bit/);
  assert.match(validateAction({ op: "x" }), /unknown/);
  assert.throws(() => apply(initial(), { op: "w", off: 0x70, val: 1.5, size: 4 }));
  assert.deepEqual(decodeAction("w70.f"), { op: "w", off: 0x70, val: 15, size: 4 });
  assert.equal(decodeActions("r0_bad"), null);
  assert.equal(describeAction({ op: "w", off: 0x70, val: 0xb, size: 4 }), "write Status = 0xb");
  assert.equal(describeAction({ op: "r", off: 0, size: 1 }), "read MagicValue (1-byte)");
  assert.equal(describeAction({ op: "w", off: 0x71, val: 1, size: 4 }), "write 0x071 = 0x1 (misaligned)");
  assert.equal(describeAction({ op: "r", off: 0x10c, size: 4 }), "read config 0xc");
  assert.equal(describeAction({ op: "c" }), "device changes its config");
});

test("helpers", () => {
  assert.equal(parseNumber("0x0a00_0070"), 0x0a00_0070);
  assert.equal(parseNumber("15"), 15);
  assert.equal(parseNumber("0x1_0000_0000"), null);
  assert.equal(parseNumber("4294967296"), null);
  assert.equal(parseNumber("1e3"), null);
  assert.equal(parseNumber(" "), null);
  assert.equal(parseNumber("0x200", 0x1ff), null);
  assert.equal(statusNames(0xb), "ACKNOWLEDGE | DRIVER | FEATURES_OK");
  assert.equal(statusNames(0), "0 (reset)");
  assert.deepEqual(featureNames(0x1_1000_0244n, "blk"), ["SEG_MAX (bit 2)", "BLK_SIZE (bit 6)", "FLUSH (bit 9)", "INDIRECT_DESC (bit 28)", "VERSION_1 (bit 32)"]);
  assert.deepEqual(featureNames(1n << 5n, "rng"), ["bit 5"]);
  assert.deepEqual(scoreGuess("takes", true), { guess: "takes", actual: "takes", right: true });
  assert.deepEqual(scoreGuess("takes", false), { guess: "takes", actual: "ignores", right: false });
  assert.equal(scoreGuess(null, true), null);
  assert.equal(scoreGuess("takes", null), null);
  assert.equal(stepIndex(initial()), -1);
  const s = replay("probe", preset("probe").actions).at(-1).state;
  assert.equal(stepIndex(s), 3);
  assert.equal(hex(0x4008_5000), "0x40085000");
});

test("apply never mutates its input", () => {
  const s0 = initial("rng", 64);
  const snap = JSON.stringify(s0, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  for (const a of preset("probe").actions) apply(s0, a);
  apply(s0, { op: "c" });
  assert.equal(JSON.stringify(s0, (k, v) => (typeof v === "bigint" ? v.toString() : v)), snap);
});

test("only the disk changes its config; the rng and the empty slot ignore the device-side action", () => {
  for (const dev of ["rng", "empty"]) {
    const r = apply(initial(dev, 64), { op: "c" });
    assert.equal(r.state.configGen, 0);
    assert.equal(r.state.intStatus, 0);
    assert.equal(r.state.line, false);
    assert.match(r.effect, /^Nothing happens/);
  }
  const r = apply(initial("blk", 512), { op: "c" });
  assert.deepEqual([r.state.configGen, r.state.intStatus, r.state.line], [1, INT.CONFIG, true]);
});

test("review wording: alignment provenance, refused-ring clause, config widths, QueueReset", () => {
  const mis = replay("misaligned", preset("misaligned").actions);
  const dok = mis.find((r) => r.action && r.action.op === "w" && r.action.off === REG.STATUS && r.action.val === 0xf);
  assert.equal(dok.taken, true);
  assert.equal(dok.but, "then refused the ring: DEVICE_NEEDS_RESET");
  assert.match(dok.effect, /chapter 15 validate checks only that each ring is inside RAM; chapter 16 adds this check/);
  assert.match(preset("misaligned").about, /chapter 16 adds the alignment check/);
  const out = replay("outside-ram", preset("outside-ram").actions).find((r) => r.but);
  assert.ok(out && !/chapter 16 adds/.test(out.effect), "the RAM check is chapter 15's own");
  const f = rig("blk", 512);
  f.r(REG.CONFIG + 0xc, 2);
  assert.match(f.last.effect, /part of seg_max.*a driver must not do this.*4\.2\.2\.2/);
  f.r(REG.CONFIG + 0xc, 4);
  assert.doesNotMatch(f.last.effect, /must not/);
  assert.equal(REGISTERS.find((r) => r.off === REG.QUEUE_RESET).rw, "rw");
  f.w(REG.QUEUE_RESET, 1);
  assert.match(f.last.effect, /RING_RESET/);
  assert.doesNotMatch(preset("no-version1").about, /legacy virtio accepts/);
  assert.doesNotMatch(preset("linux").about, /offers no feature|after each step/);
  for (const p of PRESETS.filter((x) => x.group === "misbehaves")) assert.ok(p.needs, `${p.key} names the section it needs`);
});
