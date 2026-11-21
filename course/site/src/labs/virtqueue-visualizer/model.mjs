// virtqueue-visualizer model: a split virtqueue (virtio 1.2 section 2.7) played by two actors, the
// guest's driver and our device, over a small guest RAM. Pure ES module: no DOM, no I/O, so
// `node --test` imports it and the browser imports the same file (course/site/LABS.md section 3).
//
// The device side is a port of the reference VMM, rule for rule and in the same order:
//   Queue::validate, Queue::pop, Queue::add_used, Queue::should_interrupt  (crates/vmm/src/virtio/queue.rs)
//   DescriptorChain::read_desc, ::step, ::enter_indirect, ::into_validated,
//   ValidatedChain::write_writable                                          (crates/vmm/src/virtio/chain.rs)
//   QueueError and its Display ("virtqueue: {Debug}")                       (crates/vmm/src/virtio/mod.rs)
//   RegionTable::locate / contains (check_range)                            (crates/vmm/src/memory/region.rs)
// and the guest RAM is a port of the test double VecMemory (crates/vmm/src/memory/vec_mem.rs):
// every device read is counted and logged, and a "guest write after a read" hook plays a second
// CPU rewriting a descriptor while we walk it. model.test.mjs checks the port against every case
// in course/site/labs/vectors/virtqueue.json (exported from crates/vmm/tests/virtqueue_hostile.rs)
// and against the chapter 16 captures.
//
// Guest addresses are u64, so they are BigInt here; u16 indices and u32 lengths are Numbers.
//
// State is { cfg, actions }: a configuration plus the list of actions taken. Everything else
// (memory, both sides' counters, the last walk) is derived by replaying the actions with
// simulate(), so Undo is "drop the last action" and the share link is the action list.

// ---------------------------------------------------------------------------------------------
// Constants (virtio 1.2 section 2.7.5 and 2.7.7; the reference's names)

export const F_NEXT = 1;
export const F_WRITE = 2;
export const F_INDIRECT = 4;
export const DESC_SIZE = 16;
export const AVAIL_F_NO_INTERRUPT = 1;
/** VirtioInterrupt status bits: a used buffer, a configuration change (NEEDS_RESET). */
export const INT_USED = 1;
export const INT_CONFIG = 2;

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;

/** The test suite's machine (crates/vmm/tests/virtio_support/mod.rs). */
export const RAM_BASE = 0x4000_0000n;
export const RING_RAM_SIZE = 0x10_0000n; // 1 MiB, as the test suite and the vectors use
export const TOY_RAM_SIZE = 0x2000_0000n; // 512 MiB, as chapter 15's Linux runs use
export const LAYOUT = Object.freeze({
  desc: RAM_BASE + 0x1000n,
  avail: RAM_BASE + 0x4000n,
  used: RAM_BASE + 0x5000n,
  buf: RAM_BASE + 0x8000n, // each descriptor index i owns a 4 KiB buffer at buf + 0x1000 * i
  table: RAM_BASE + 0x2_0000n, // indirect tables: table + 0x100 * i for main descriptor i
});
/** An address in the PL011's window: a device, never RAM. */
export const MMIO_ADDR = 0x0900_0000n;
/** virtio-mmio slot 0 and the three registers the toy uses (chapter 15). */
export const SLOT0 = 0x0a00_0000n;
export const REG_QUEUE_NOTIFY = 0x050;
export const REG_INTERRUPT_STATUS = 0x060;
export const REG_INTERRUPT_ACK = 0x064;

export const SIZES = [1, 2, 4, 8, 16];
export const CAPS = Object.freeze({ "10000": 0x1_0000n, "400": 0x400n, none: U64_MAX });
export const CAP_LABELS = Object.freeze({
  "10000": "64 KiB (what virtio-rng and virtio-console pass)",
  "400": "1 KiB",
  none: "none (virtio-net passes no cap)",
});
export const STARTS = [0, 0xfffe];
/** With the hop budget removed, a loop never ends; the simulation gives up here and says so. */
export const HOP_LIMIT = 20_000;
export const MAX_ACTIONS = 64;
export const MAX_DESCS_PER_REQUEST = 3;
export const MAX_BUFFER_LEN = 0x1000;

// Where each rule is taught. Chapter 16 is "Split virtqueues", chapter 15 "virtio-mmio".
export const CH15 = "/build-your-own/vmm/virtio/virtio-mmio/";
export const CH16 = "/build-your-own/vmm/virtio/virtqueues/";
export const RULES = Object.freeze({
  ring: { href: `${CH16}#three-tables-in-guest-ram`, code: "Queue::validate", chapter: 16, section: "Three tables in guest RAM" },
  idx: { href: `${CH16}#indices-that-never-wrap-at-n`, code: "Queue::pop", chapter: 16, section: "Indices that never wrap at N" },
  head: { href: `${CH16}#indices-that-never-wrap-at-n`, code: "Queue::pop", chapter: 16, section: "Indices that never wrap at N" },
  budget: { href: `${CH16}#the-hop-budget`, code: "DescriptorChain::step", chapter: 16, section: "The hop budget" },
  desc: { href: `${CH16}#descriptors-and-chains`, code: "DescriptorChain::step", chapter: 16, section: "Descriptors and chains" },
  indirect: { href: `${CH16}#indirect-descriptors`, code: "DescriptorChain::enter_indirect", chapter: 16, section: "Indirect descriptors" },
  total: { href: `${CH16}#descriptors-and-chains`, code: "DescriptorChain::into_validated", chapter: 16, section: "Descriptors and chains" },
  used: { href: `${CH16}#two-cpus-one-ring-no-lock`, code: "Queue::add_used", chapter: 16, section: "Two CPUs, one ring, no lock" },
  notify: { href: `${CH16}#two-cpus-one-ring-no-lock`, code: "Queue::should_interrupt", chapter: 16, section: "Two CPUs, one ring, no lock" },
  error: { href: `${CH16}#when-the-guest-breaks-the-rules`, code: "report_error", chapter: 16, section: "When the guest breaks the rules" },
  toctou: { href: `${CH16}#the-guest-writes-while-we-read`, code: "DescriptorChain::read_desc", chapter: 16, section: "The guest writes while we read" },
  doorbell: { href: `${CH15}#the-doorbell-and-done`, code: "QueueNotify", chapter: 15, section: "The doorbell, and \"done\"" },
});

// ---------------------------------------------------------------------------------------------
// Formatting helpers (learner-facing text uses the course's 0x4000_8000 style)

/** 0x4000_8000: hex with an underscore every four digits. */
export function hexAddr(v) {
  const raw = BigInt(v).toString(16);
  // At least 8 digits, then whole groups of 4: 0x0900_0000, 0x0a00_0050, 0xffff_ffff_ffff_fff5.
  const s = raw.padStart(Math.max(8, Math.ceil(raw.length / 4) * 4), "0");
  const parts = [];
  for (let i = s.length; i > 0; i -= 4) parts.unshift(s.slice(Math.max(0, i - 4), i));
  return `0x${parts.join("_")}`;
}
/** 0x0001: a u16 index, four digits. */
export function hex16(v) {
  return `0x${(v & 0xffff).toString(16).padStart(4, "0").toUpperCase()}`;
}
export function hex(v) {
  return `0x${BigInt(v).toString(16)}`;
}
export function flagNames(flags) {
  const n = [];
  if (flags & F_NEXT) n.push("NEXT");
  if (flags & F_WRITE) n.push("WRITE");
  if (flags & F_INDIRECT) n.push("INDIRECT");
  const rest = flags & ~7;
  if (rest) n.push(hex(rest));
  return n.length ? n.join("|") : "none";
}
export function grouped(n) {
  return BigInt(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
const u16 = (v) => v & 0xffff;

// ---------------------------------------------------------------------------------------------
// Errors: QueueError and MemoryError, printed exactly as Rust's derived Debug prints them

export class VqError extends Error {
  /** @param {string} kind  @param {Array<[string, number|bigint|string]>} fields  @param {VqError} [inner] */
  constructor(kind, fields = [], inner = null) {
    super(kind);
    this.kind = kind;
    this.fields = fields;
    this.inner = inner;
  }
}
/** A walk the simulation stopped because it would never end (only with the hop budget removed). */
export class Hang extends Error {
  constructor(hops) {
    super("hang");
    this.hops = hops;
  }
}

const memErr = (kind, fields) => new VqError("Memory", [], new VqError(kind, fields));

/** Rust's `{:?}` of a QueueError: `ChainTooLong { budget: 8 }`, `Memory(OutOfBounds { .. })`. */
export function debugOf(e) {
  if (e.kind === "Memory" && e.inner) return `Memory(${debugOf(e.inner)})`;
  if (!e.fields.length) return e.kind;
  return `${e.kind} { ${e.fields.map(([k, v]) => `${k}: ${String(v)}`).join(", ")} }`;
}
/** The reference's Display: `virtqueue: {self:?}`. */
export function displayOf(e) {
  return `virtqueue: ${debugOf(e)}`;
}

// ---------------------------------------------------------------------------------------------
// Guest RAM: a sparse port of VecMemory (regions, bounds rules, read counter, access log, hook)

const PAGE = 4096n;

export class Memory {
  /** @param {Array<{base: bigint, size: bigint}>} regions  one or more RAM regions */
  constructor(regions) {
    this.regions = regions.map((r) => ({ base: BigInt(r.base), size: BigInt(r.size) }))
      .sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
    this.pages = new Map();
    this.reads = 0;
    /** A guest write that fires once, right after the first device read overlapping `trigger`. */
    this.hook = null;
    /** The device's accesses since the last clear: {op, addr, len, ordered, what}. */
    this.log = [];
  }

  /** RegionTable::locate: null when [addr, addr + len) is inside one region, else the error. */
  locate(addr, len) {
    const end = addr + len;
    if (end > U64_MAX) return new VqError("Overflow", [["addr", addr], ["len", len]]);
    const oob = new VqError("OutOfBounds", [["addr", addr], ["len", len]]);
    if (len === 0n) return oob;
    let span = null;
    for (const r of this.regions) if (r.base <= addr) span = r;
    if (!span || end > span.base + span.size) return oob;
    return null;
  }
  /** GuestMemory::check_range. */
  checkRange(addr, len) {
    return this.locate(BigInt(addr), BigInt(len)) === null;
  }

  /** Raw bytes for drawing: no bounds rule, no counting, zeros where nothing was written. */
  peek(addr, n) {
    const out = new Uint8Array(n);
    let i = 0;
    while (i < n) {
      const a = addr + BigInt(i);
      const off = Number(a % PAGE);
      const take = Math.min(n - i, Number(PAGE) - off);
      const page = this.pages.get(a / PAGE);
      if (page) out.set(page.subarray(off, off + take), i);
      i += take;
    }
    return out;
  }
  poke(addr, bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const a = addr + BigInt(i);
      const key = a / PAGE;
      let page = this.pages.get(key);
      if (!page) {
        if (bytes[i] === 0) continue;
        page = new Uint8Array(Number(PAGE));
        this.pages.set(key, page);
      }
      page[Number(a % PAGE)] = bytes[i];
    }
  }
  /** A guest (driver) write: the bounds rules apply, nothing is logged as a device access. */
  guestWrite(addr, bytes) {
    const e = this.locate(addr, BigInt(bytes.length));
    if (e) throw new VqError("Memory", [], e);
    this.poke(addr, bytes);
  }

  /** A device read (GuestMemory::read / read_obj): bounds-checked, logged, counted. */
  read(addr, n, what = "", ordered = false) {
    const e = this.locate(addr, BigInt(n));
    if (e) throw new VqError("Memory", [], e);
    const bytes = this.peek(addr, n);
    this.log.push({ op: "read", addr, len: n, ordered, what });
    this.reads += 1;
    if (this.hook && this.hookDue(addr, n)) {
      const h = this.hook;
      this.hook = null;
      if (!this.locate(h.addr, BigInt(h.bytes.length))) {
        this.poke(h.addr, h.bytes);
        this.log.push({ op: "guest", addr: h.addr, len: h.bytes.length, ordered: false, what: h.what });
      }
    }
    return bytes;
  }
  /** VecMemory's Mutation fires after `afterReads` reads; the lab's fires after a read of `trigger`. */
  hookDue(addr, n) {
    const h = this.hook;
    if (h.afterReads !== undefined) return this.reads >= h.afterReads;
    return addr < h.trigger + BigInt(h.span) && h.trigger < addr + BigInt(n);
  }
  write(addr, bytes, what = "", ordered = false) {
    const e = this.locate(addr, BigInt(bytes.length));
    if (e) throw new VqError("Memory", [], e);
    this.poke(addr, bytes);
    this.log.push({ op: "write", addr, len: bytes.length, ordered, what });
  }
  readU16(addr, what) {
    const b = this.read(addr, 2, what);
    return b[0] | (b[1] << 8);
  }
  readU32(addr, what) {
    const b = this.read(addr, 4, what);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  /** GuestMemoryOrdered::read_u16_acquire. */
  readU16Acquire(addr, what) {
    if (addr % 2n !== 0n) throw memErr("Unaligned", [["addr", addr]]);
    const b = this.read(addr, 2, what, true);
    return b[0] | (b[1] << 8);
  }
  /** GuestMemoryOrdered::write_u16_release. */
  writeU16Release(addr, val, what) {
    if (addr % 2n !== 0n) throw memErr("Unaligned", [["addr", addr]]);
    this.write(addr, le16(val), what, true);
  }
  /** GuestMemoryOrdered::fence_seq_cst. */
  fence(what) {
    this.log.push({ op: "fence", addr: 0n, len: 0, ordered: true, what });
  }
}

export function le16(v) {
  return Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
}
export function le32(v) {
  return Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function le64(v) {
  const out = new Uint8Array(8);
  let x = BigInt.asUintN(64, BigInt(v));
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Descriptor::to_le_bytes: {addr: le64, len: le32, flags: le16, next: le16}. */
export function encodeDesc(d) {
  const out = new Uint8Array(16);
  out.set(le64(d.addr), 0);
  out.set(le32(d.len), 8);
  out.set(le16(d.flags), 12);
  out.set(le16(d.next), 14);
  return out;
}
/** Descriptor::decode_le. */
export function decodeDesc(b) {
  let addr = 0n;
  for (let i = 7; i >= 0; i--) addr = (addr << 8n) | BigInt(b[i]);
  return {
    addr,
    len: (b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24)) >>> 0,
    flags: b[12] | (b[13] << 8),
    next: b[14] | (b[15] << 8),
  };
}
export const desc = (addr, len, flags, next) => ({ addr: BigInt(addr), len, flags, next });

// ---------------------------------------------------------------------------------------------
// The walker: DescriptorChain (chain.rs)

/**
 * One chain's buffers, walked out of a hostile table. `opts.budget = false` removes the hop
 * budget (deliberate breakage 1); `opts.reread = true` hands out `len` from a fresh read of guest
 * memory instead of the validated copy (deliberate breakage 3). `rec(entry)` receives every check.
 */
export class DescriptorChain {
  constructor(mem, table, queueSize, head, indirectAllowed, opts = {}, rec = () => {}) {
    this.mem = mem;
    this.head = head;
    this.queueSize = queueSize;
    this.table = table;
    this.tableLen = queueSize;
    this.next = head;
    this.budget = queueSize;
    this.inIndirect = false;
    this.indirectAllowed = indirectAllowed;
    this.failed = false;
    this.useBudget = opts.budget !== false;
    this.reread = opts.reread === true;
    this.hopLimit = opts.hopLimit ?? HOP_LIMIT;
    this.rec = rec;
    this.hops = 0;
  }

  readDesc(index) {
    if (index >= this.tableLen) {
      throw new VqError("NextOutOfRange", [["next", index], ["table_len", this.tableLen]]);
    }
    const addr = this.table + BigInt(DESC_SIZE * index);
    if (addr > U64_MAX) throw new VqError("Overflow", [["addr", this.table], ["len", index]]);
    const where = this.inIndirect ? `indirect descriptor ${index}` : `descriptor ${index}`;
    return decodeDesc(this.mem.read(addr, DESC_SIZE, `copy ${where} (16 bytes, once)`));
  }

  step() {
    for (;;) {
      if (this.next === null) return null;
      const index = this.next;
      this.hops += 1;
      if (this.hops > this.hopLimit) throw new Hang(this.hops - 1);
      const table = this.inIndirect ? "indirect" : "main";
      if (this.useBudget) {
        if (this.budget === 0) {
          const budget = this.inIndirect ? this.tableLen : this.queueSize;
          this.rec({ hop: this.hops, rule: "budget", ok: false, text: `hop ${this.hops}: budget exhausted (${budget} hops allowed in this table)` });
          throw new VqError("ChainTooLong", [["budget", budget]]);
        }
        this.rec({ hop: this.hops, rule: "budget", head: true, ok: true, table, index, text: `hop ${this.hops}: ${table === "main" ? "descriptor" : "indirect descriptor"} ${index} (budget ${this.budget} → ${this.budget - 1})` });
        this.budget -= 1;
      } else {
        this.rec({ hop: this.hops, rule: "budget", head: true, ok: null, table, index, text: `hop ${this.hops}: ${table === "main" ? "descriptor" : "indirect descriptor"} ${index} (no hop budget)` });
      }
      let d;
      try {
        d = this.readDesc(index);
      } catch (e) {
        if (e instanceof VqError && e.kind === "NextOutOfRange") {
          this.rec({ hop: this.hops, rule: "desc", ok: false, text: `index ${index} is not below the table's ${this.tableLen} entries` });
        }
        throw e;
      }
      this.rec({ hop: this.hops, rule: "desc", ok: true, copy: d, text: `copied once: addr ${hexAddr(d.addr)}, len ${d.len}, flags ${flagNames(d.flags)}, next ${d.next}` });
      if (d.flags & F_INDIRECT) {
        this.enterIndirect(d);
        continue;
      }
      if (d.len === 0) {
        this.rec({ hop: this.hops, rule: "desc", ok: false, text: "len is 0: an empty buffer is refused" });
        throw new VqError("ZeroLength", [["index", index]]);
      }
      const end = d.addr + BigInt(d.len);
      if (end > U64_MAX) {
        this.rec({ hop: this.hops, rule: "desc", ok: false, text: `addr + len passes 2^64 (checked_add fails)` });
        throw new VqError("Overflow", [["addr", d.addr], ["len", d.len]]);
      }
      if (!this.mem.checkRange(d.addr, BigInt(d.len))) {
        this.rec({ hop: this.hops, rule: "desc", ok: false, text: `${hexAddr(d.addr)} + ${d.len} bytes is not inside one RAM region` });
        throw new VqError("BufferOutOfRam", [["addr", d.addr], ["len", d.len]]);
      }
      this.rec({ hop: this.hops, rule: "desc", ok: true, text: `len ${d.len} is not 0; ${hexAddr(d.addr)} to ${hexAddr(end)} is inside RAM` });
      if (d.flags & F_NEXT) {
        if (d.next >= this.tableLen) {
          this.rec({ hop: this.hops, rule: "desc", ok: false, text: `next ${d.next} is not below the table's ${this.tableLen} entries` });
          throw new VqError("NextOutOfRange", [["next", d.next], ["table_len", this.tableLen]]);
        }
        this.rec({ hop: this.hops, rule: "desc", ok: true, text: `NEXT is set; next ${d.next} < ${this.tableLen}` });
        this.next = d.next;
      } else {
        this.rec({ hop: this.hops, rule: "desc", ok: true, text: "NEXT is clear: the chain ends here" });
        this.next = null;
      }
      if (this.reread) {
        const fresh = this.mem.readU32(this.table + BigInt(DESC_SIZE * index) + 8n, `re-read len of descriptor ${index} (the double fetch)`);
        if (fresh !== d.len) {
          this.rec({ hop: this.hops, rule: "toctou", ok: false, text: `len re-read from guest memory: ${fresh}, not the checked ${d.len}` });
        }
        return { ...d, len: fresh };
      }
      return d;
    }
  }

  enterIndirect(d) {
    const fail = (text, e) => {
      this.rec({ hop: this.hops, rule: "indirect", ok: false, text });
      throw e;
    };
    if (!this.indirectAllowed) fail("INDIRECT, but VIRTIO_F_INDIRECT_DESC was not negotiated", new VqError("IndirectNotNegotiated"));
    if (this.inIndirect) fail("INDIRECT inside an indirect table: nesting is refused", new VqError("NestedIndirect"));
    if (d.flags & F_NEXT) fail("INDIRECT together with NEXT is refused", new VqError("IndirectWithNext"));
    const entries = Math.floor(d.len / DESC_SIZE);
    if (d.len === 0 || d.len % DESC_SIZE !== 0 || entries > this.queueSize) {
      fail(`table length ${d.len} is 0, not a multiple of 16, or more than ${this.queueSize} descriptors`, new VqError("BadIndirectLen", [["len", d.len]]));
    }
    if (d.addr + BigInt(d.len) > U64_MAX) fail("table address + length passes 2^64", new VqError("Overflow", [["addr", d.addr], ["len", d.len]]));
    if (!this.mem.checkRange(d.addr, BigInt(d.len))) {
      fail(`the table at ${hexAddr(d.addr)} (${d.len} bytes) is not inside one RAM region`, new VqError("BufferOutOfRam", [["addr", d.addr], ["len", d.len]]));
    }
    this.rec({ hop: this.hops, rule: "indirect", ok: true, text: `INDIRECT: a table of ${entries} descriptors at ${hexAddr(d.addr)}; the budget restarts at ${entries}` });
    this.table = d.addr;
    this.tableLen = entries;
    this.next = 0;
    this.budget = entries;
    this.inIndirect = true;
  }

  /** Iterator::next: after the first error, nothing more. Returns a descriptor, null, or throws. */
  nextDesc() {
    if (this.failed) return null;
    try {
      const d = this.step();
      if (d === null) this.next = null;
      return d;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }

  /** into_validated: readable before writable, each direction's total at most maxTotal. */
  intoValidated(maxTotal) {
    const v = { head: this.head, readable: [], writable: [], readableLen: 0n, writableLen: 0n };
    for (;;) {
      const d = this.nextDesc();
      if (d === null) break;
      const len = BigInt(d.len);
      if (d.flags & F_WRITE) {
        const t = v.writableLen + len;
        if (t > maxTotal || t > U64_MAX) {
          this.rec({ hop: this.hops, rule: "total", ok: false, text: `writable total ${grouped(t)} bytes is over the device's cap of ${grouped(maxTotal)}` });
          throw new VqError("TooLarge", [["total", t > U64_MAX ? U64_MAX : t], ["max", maxTotal]]);
        }
        v.writableLen = t;
        v.writable.push(d);
      } else {
        if (v.writable.length) {
          this.rec({ hop: this.hops, rule: "total", ok: false, text: "a readable buffer after a writable one" });
          throw new VqError("ReadableAfterWritable");
        }
        const t = v.readableLen + len;
        if (t > maxTotal || t > U64_MAX) {
          this.rec({ hop: this.hops, rule: "total", ok: false, text: `readable total ${grouped(t)} bytes is over the device's cap of ${grouped(maxTotal)}` });
          throw new VqError("TooLarge", [["total", t > U64_MAX ? U64_MAX : t], ["max", maxTotal]]);
        }
        v.readableLen = t;
        v.readable.push(d);
      }
    }
    this.rec({ rule: "total", ok: true, text: `readable before writable; totals ${grouped(v.readableLen)} readable and ${grouped(v.writableLen)} writable bytes, cap ${maxTotal === U64_MAX ? "none" : grouped(maxTotal)}` });
    return v;
  }
}

/** ValidatedChain::write_writable: fill the writable buffers in order; return the bytes written. */
export function writeWritable(mem, v, count, byteAt = (i) => i % 251) {
  let done = 0;
  for (const d of v.writable) {
    if (done >= count) break;
    const n = Math.min(count - done, d.len);
    const chunk = new Uint8Array(n);
    for (let i = 0; i < n; i++) chunk[i] = byteAt(done + i);
    mem.write(d.addr, chunk, `write ${n} bytes of reply into ${hexAddr(d.addr)}`);
    done += n;
  }
  if (done > U32_MAX) throw new VqError("TooLarge", [["total", BigInt(done)], ["max", BigInt(U32_MAX)]]);
  return done;
}

// ---------------------------------------------------------------------------------------------
// The queue: Queue (queue.rs)

export const QUEUE_SIZE_MAX = 32768;

export class Queue {
  constructor(maxSize) {
    this.maxSize = Math.min(maxSize, QUEUE_SIZE_MAX);
    this.size = this.maxSize;
    this.ready = false;
    this.desc = 0n;
    this.avail = 0n;
    this.used = 0n;
    this.nextAvail = 0;
    this.nextUsed = 0;
    this.indirect = false;
    this.broken = false;
  }
  sizeOk(size) {
    return size !== 0 && size <= this.maxSize && (size & (size - 1)) === 0;
  }
  setPositions(nextAvail, nextUsed) {
    this.nextAvail = u16(nextAvail);
    this.nextUsed = u16(nextUsed);
  }
  checkUsable() {
    if (this.broken) throw new VqError("Broken");
    if (!this.ready || !this.sizeOk(this.size)) throw new VqError("NotReady");
  }
  /** `at`: base + head + elem * i, checked. */
  at(base, head, elem, i) {
    const a = base + BigInt(head) + BigInt(elem) * BigInt(i);
    if (a > U64_MAX) throw new VqError("Overflow", [["addr", base], ["len", i]]);
    return a;
  }

  validate(mem, rec = () => {}) {
    if (!this.sizeOk(this.size)) throw new VqError("BadSize", [["size", this.size], ["max", this.maxSize]]);
    const n = BigInt(this.size);
    const rings = [
      ["Desc", "descriptor table", this.desc, 16n, 16n * n],
      ["Avail", "available ring", this.avail, 2n, 2n * n + 6n],
      ["Used", "used ring", this.used, 4n, 8n * n + 6n],
    ];
    for (const [ring, name, addr, align, len] of rings) {
      if (addr % align !== 0n) {
        rec({ rule: "ring", ok: false, text: `${name} at ${hexAddr(addr)} is not ${align}-byte aligned` });
        throw new VqError("Unaligned", [["ring", ring], ["addr", addr]]);
      }
      if (!mem.checkRange(addr, len)) {
        rec({ rule: "ring", ok: false, text: `${name}: ${len} bytes at ${hexAddr(addr)} are not inside one RAM region` });
        throw new VqError("RingOutOfRam", [["ring", ring], ["addr", addr], ["len", len]]);
      }
      rec({ rule: "ring", ok: true, text: `${name}: ${len} bytes at ${hexAddr(addr)}, ${align}-byte aligned, inside RAM` });
    }
  }

  pop(mem, opts = {}, rec = () => {}) {
    try {
      return this.popInner(mem, opts, rec);
    } catch (e) {
      if (e instanceof VqError && e.kind !== "NotReady" && e.kind !== "Broken") this.broken = true;
      throw e;
    }
  }
  popInner(mem, opts, rec) {
    this.checkUsable();
    const availIdx = mem.readU16Acquire(this.at(this.avail, 2, 0, 0), "acquire load of avail.idx");
    const pending = u16(availIdx - this.nextAvail);
    const sum = `avail.idx − next_avail = ${hex16(availIdx)} − ${hex16(this.nextAvail)} = ${pending} (u16)`;
    if (pending > this.size) {
      rec({ rule: "idx", ok: false, text: `${sum}, more than N = ${this.size}: no honest driver can do that` });
      throw new VqError("AvailIdxJump", [["avail_idx", availIdx], ["next_avail", this.nextAvail], ["size", this.size]]);
    }
    if (pending === 0) {
      rec({ rule: "idx", ok: true, text: `${sum}: nothing pending` });
      return null;
    }
    rec({ rule: "idx", ok: true, text: `${sum}, at most N = ${this.size}` });
    const slot = this.nextAvail & (this.size - 1);
    const head = mem.readU16(this.at(this.avail, 4, 2, slot), `copy avail.ring[${slot}] (the head, once)`);
    if (head >= this.size) {
      rec({ rule: "head", ok: false, text: `head = avail.ring[${slot}] = ${head}, not below N = ${this.size}` });
      throw new VqError("HeadOutOfRange", [["head", head], ["size", this.size]]);
    }
    rec({ rule: "head", ok: true, text: `head = avail.ring[${slot}] = ${head}, below N = ${this.size}; next_avail becomes ${hex16(this.nextAvail + 1)}` });
    this.nextAvail = u16(this.nextAvail + 1);
    return new DescriptorChain(mem, this.desc, this.size, head, this.indirect, opts, rec);
  }

  addUsed(mem, head, written, rec = () => {}) {
    this.checkUsable();
    if (head >= this.size) throw new VqError("HeadOutOfRange", [["head", head], ["size", this.size]]);
    const slot = this.nextUsed & (this.size - 1);
    const elem = new Uint8Array(8);
    elem.set(le32(head), 0);
    elem.set(le32(written), 4);
    mem.write(this.at(this.used, 4, 8, slot), elem, `write used.ring[${slot}] = {id ${head}, len ${written}}`);
    this.nextUsed = u16(this.nextUsed + 1);
    mem.writeU16Release(this.at(this.used, 2, 0, 0), this.nextUsed, "release store of used.idx");
    rec({ rule: "used", ok: true, text: `used.ring[${slot}] = {id ${head}, len ${written}}, then a release store of used.idx = ${hex16(this.nextUsed)}` });
  }

  shouldInterrupt(mem, rec = () => {}) {
    mem.fence("fence(SeqCst)");
    const flags = mem.readU16(this.avail, "load avail.flags");
    const want = (flags & AVAIL_F_NO_INTERRUPT) === 0;
    rec({ rule: "notify", ok: true, text: want ? "fence, then avail.flags = 0: the driver wants an interrupt" : "fence, then avail.flags has NO_INTERRUPT: no interrupt (the driver will poll)" });
    return want;
  }
}

// ---------------------------------------------------------------------------------------------
// The vectors: run one case of virtqueue.json exactly as virtqueue_hostile.rs's run() does

/** Build the ring a vector describes, then validate, pop and validate one chain. */
export function runVector(v) {
  const mem = new Memory([{ base: RAM_BASE, size: RING_RAM_SIZE }]);
  const n = v.queue_size;
  const descAddr = BigInt(v.desc_table);
  const avail = BigInt(v.avail_ring);
  const used = BigInt(v.used_ring);
  const tryPoke = (addr, bytes) => {
    if (!mem.locate(addr, BigInt(bytes.length))) mem.poke(addr, bytes);
  };
  for (const d of v.descriptors) tryPoke(descAddr + BigInt(16 * d.index), encodeDesc(desc(d.addr, d.len, d.flags, d.next)));
  for (const t of v.indirect_tables) {
    t.descriptors.forEach((d, i) => tryPoke(BigInt(t.addr) + BigInt(16 * i), encodeDesc(desc(d.addr, d.len, d.flags, d.next))));
  }
  let availIdx = 0;
  if (v.start_index) availIdx = u16(v.start_index);
  tryPoke(avail + 2n, le16(availIdx));
  for (const h of v.avail_heads) {
    tryPoke(avail + 4n + 2n * BigInt(availIdx % n), le16(h));
    availIdx = u16(availIdx + 1);
    tryPoke(avail + 2n, le16(availIdx));
  }
  if (v.avail_idx_override !== null && v.avail_idx_override !== undefined) tryPoke(avail + 2n, le16(v.avail_idx_override));
  const q = new Queue(n);
  q.size = n;
  q.desc = descAddr;
  q.avail = avail;
  q.used = used;
  q.ready = true;
  q.indirect = v.indirect_negotiated;
  if (v.start_index) q.setPositions(v.start_index, v.start_index);
  try {
    q.validate(mem);
    const chain = q.pop(mem);
    if (!chain) return { empty: true };
    const r = chain.intoValidated(BigInt(v.max_total));
    return { readable: r.readable.length, writable: r.writable.length, readable_len: Number(r.readableLen), writable_len: Number(r.writableLen) };
  } catch (e) {
    if (e instanceof VqError) return { error: debugOf(e) };
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Hostile driver requests (the "driver misbehaves" menu). Each writes descriptors the way a
// hostile guest would and publishes its head; the device's next "process one" meets it.

export const HOSTILE = [
  { id: "loop", label: "Self-loop: next points at itself", about: "The chapter's opening puzzle: addr inside RAM, len 8, NEXT set, next = its own index. Every field passes every single-field check.", descs: 1 },
  { id: "cycle", label: "Two descriptors pointing at each other", about: "A 2-cycle: a → b → a → ... The hop budget catches every loop shape the same way.", descs: 2 },
  { id: "next", label: "next past the table (next = N)", about: "NEXT is set and next names a descriptor the table does not have.", descs: 1 },
  { id: "mmio", label: "Buffer in the PL011's window", about: "addr 0x0900_0000 is a device, not RAM. A device that wrote there would be poking the UART on the guest's behalf.", descs: 1 },
  { id: "end", label: "Buffer straddling the end of RAM", about: "16 bytes starting 8 bytes before the end of RAM: the first half is fine, the second is not.", descs: 1 },
  { id: "huge", label: "len = 0xFFFF_FFFF", about: "A writable buffer of almost 4 GiB (0xFFFF_FFFF bytes) inside 1 MiB of RAM.", descs: 1 },
  { id: "wrap", label: "addr + len past 2^64", about: "addr is 11 below 2^64 and len is 0xFFFF_FFFF: unchecked addition would wrap to a small address.", descs: 1 },
  { id: "zero", label: "Zero-length buffer", about: "len 0. Refusing it also guarantees every hop adds at least one byte to the totals.", descs: 1 },
  { id: "order", label: "Writable before readable", about: "A device-writable buffer, then a device-readable one: the device could not read the whole request before writing its reply.", descs: 2 },
  { id: "cap", label: "One 512 KiB writable buffer", about: "Inside RAM and well formed, but over a 64 KiB cap, the one virtio-rng and virtio-console pass. Try it with the cap set to none. A disk never meets this refusal: virtio-blk passes a cap of about 2 TiB and answers a request that is too big with an IOERR status instead (chapter 18).", descs: 1 },
  { id: "head", label: "Head out of range (head = N)", about: "The available ring names descriptor N, one past the end of the table.", descs: 0 },
  { id: "jump", label: "avail.idx jumps by N + 1", about: "The driver claims N + 1 new requests in a ring of N slots.", descs: 0 },
  { id: "back", label: "avail.idx moves backwards (an index wrap)", about: "The driver writes avail.idx one lower than before. In 16-bit arithmetic avail.idx − next_avail then wraps below 0 to 65,535 pending requests, more than N: the check that catches a jump catches this too.", descs: 0 },
  { id: "ind", label: "Indirect table of two descriptors", about: "One ring descriptor with INDIRECT points at a table of two (16 readable bytes, 64 writable). Legal only if indirect descriptors were negotiated.", descs: 1 },
  { id: "indnext", label: "INDIRECT together with NEXT", about: "An indirect descriptor that also claims a next one.", descs: 1 },
  { id: "nest", label: "Indirect inside an indirect table", about: "The indirect table's only entry is itself INDIRECT.", descs: 1 },
  { id: "indlen", label: "Indirect table of 24 bytes", about: "A table length that is not a whole number of 16-byte descriptors.", descs: 1 },
  { id: "flip", label: "Rewrite a descriptor after the device copies it", about: "Two descriptors (16 readable bytes, 64 writable). Right after the device copies the first, the guest rewrites it in RAM: addr in the PL011's window, len 0xFFFF_FFFF, NEXT|WRITE, next pointing at itself. Which copy does the device use?", descs: 2 },
];
const HOSTILE_IDS = new Set(HOSTILE.map((h) => h.id));

// Named request shapes for the driver's "Add request" (readable/writable, length).
export const REQUEST_SHAPES = [
  { id: "blkread", label: "Disk read: header, data, status", spec: [["r", 16], ["w", 512], ["w", 1]] },
  { id: "blkwrite", label: "Disk write: header, data, status", spec: [["r", 16], ["r", 512], ["w", 1]] },
  { id: "rng", label: "Entropy: one 64-byte writable buffer", spec: [["w", 64]] },
  { id: "one", label: "One 8-byte readable buffer", spec: [["r", 8]] },
];

// ---------------------------------------------------------------------------------------------
// Configuration, actions and the share string

export function defaultConfig(mode = "toy") {
  if (mode === "toy") return { mode: "toy" };
  return { mode: "ring", n: 8, start: 0, cap: "10000", indirect: false, budget: true, reread: false };
}
/** The page's start state: the toy, except in chapter 16's embed, which starts on the full ring. */
export function initialState(startMode = "toy") {
  return { cfg: defaultConfig(startMode === "ring" ? "ring" : "toy"), actions: [] };
}

/**
 * Which mode an embed starts in when no share link says otherwise. Chapter 16's text asks for
 * requests, hostile mode and the wrap scenario straight away, so its embed opens on the full ring;
 * chapter 15 and the standalone page open on the toy.
 */
export function startModeFor({ pathname = "", standalone = false } = {}) {
  if (!standalone && typeof pathname === "string" && /\/virtio\/virtqueues\/?$/.test(pathname)) return "ring";
  return "toy";
}

/** Is `state` the untouched start state of a page that starts in `startMode`? */
export function isStartState(state, startMode = "toy") {
  if (state.actions.length) return false;
  return encodeRaw(state) === encodeRaw(initialState(startMode));
}

/** Parse a request spec "r10.w200.w1" (hex lengths). Hardened: 1-3 parts, 1..0x1000 bytes. */
export function parseSpec(s) {
  if (typeof s !== "string" || s.length > 40) return null;
  const parts = s.split(".");
  if (parts.length < 1 || parts.length > MAX_DESCS_PER_REQUEST) return null;
  const out = [];
  for (const p of parts) {
    const m = /^([rw])([0-9a-f]{1,4})$/.exec(p);
    if (!m) return null;
    const len = parseInt(m[2], 16);
    if (len < 1 || len > MAX_BUFFER_LEN) return null;
    out.push([m[1], len]);
  }
  return out;
}
export function specToken(spec) {
  return `q${spec.map(([k, len]) => `${k}${len.toString(16)}`).join(".")}`;
}

function validToken(t) {
  if (t === "n" || t === "p" || t === "u" || t === "z" || t === "f") return true;
  if (t.startsWith("q")) return parseSpec(t.slice(1)) !== null;
  if (t.startsWith("h")) return HOSTILE_IDS.has(t.slice(1));
  return false;
}

/**
 * The share string. The page's start state (`startMode`: the toy, or chapter 16's fresh full ring)
 * is null, which clears the hash.
 */
export function encode(state, startMode = "toy") {
  return isStartState(state, startMode) ? null : encodeRaw(state);
}

function encodeRaw(state) {
  const c = state.cfg;
  if (c.mode === "toy") return state.actions.length ? `toy.${state.actions.length}` : "toy";
  let s = `ring-n${c.n}-s${c.start.toString(16)}-c${c.cap}`;
  if (c.indirect) s += "-i";
  if (!c.budget) s += "-nobudget";
  if (c.reread) s += "-reread";
  if (state.actions.length) s += `:${state.actions.join("_")}`;
  return s;
}

/** Parse a share string; null for anything malformed. Actions are replayed and cut at the first one not allowed. */
export function decode(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 1200) return null;
  let m = /^toy(?:\.([0-8]))?$/.exec(str);
  if (m) {
    const k = m[1] ? Number(m[1]) : 0;
    return { cfg: defaultConfig("toy"), actions: Array.from({ length: k }, () => "s") };
  }
  m = /^ring-n(\d{1,2})-s([0-9a-f]{1,4})-c(10000|400|none)((?:-i)?)((?:-nobudget)?)((?:-reread)?)(?::(.+))?$/.exec(str);
  if (!m) return null;
  const n = Number(m[1]);
  if (!SIZES.includes(n)) return null;
  const cfg = { mode: "ring", n, start: parseInt(m[2], 16), cap: m[3], indirect: m[4] === "-i", budget: m[5] !== "-nobudget", reread: m[6] === "-reread" };
  const tokens = m[7] ? m[7].split("_") : [];
  if (tokens.length > MAX_ACTIONS || !tokens.every(validToken)) return null;
  // Keep the allowed prefix (a shared link cannot smuggle in an action the lab would refuse).
  const world = newWorld(cfg);
  const actions = [];
  for (const t of tokens) {
    const r = apply(world, t);
    if (!r.ok) break;
    actions.push(t);
  }
  return { cfg, actions };
}

// ---------------------------------------------------------------------------------------------
// The world: both actors and the guest RAM, rebuilt by replaying actions

function ringRegions(cfg) {
  return [{ base: RAM_BASE, size: cfg.mode === "toy" ? TOY_RAM_SIZE : RING_RAM_SIZE }];
}

export function newWorld(cfg) {
  const n = cfg.mode === "toy" ? 1 : cfg.n;
  const start = cfg.mode === "toy" ? 0 : cfg.start;
  const w = {
    cfg,
    n,
    start,
    cap: cfg.mode === "toy" ? CAPS["10000"] : CAPS[cfg.cap],
    mem: new Memory(ringRegions(cfg)),
    queue: null,
    drv: null,
    dev: null,
    exits: { doorbell: 0, handler: 0, reset: 0 },
    disk: null,
    last: null,
    history: [],
  };
  setUp(w);
  return w;
}

/** The driver's setup and DRIVER_OK: zeroed rings, both sides' counters at `start`, validated. */
function setUp(w) {
  const { n, start, mem } = w;
  mem.poke(LAYOUT.desc, new Uint8Array(16 * n));
  mem.poke(LAYOUT.avail, new Uint8Array(6 + 2 * n));
  mem.poke(LAYOUT.used, new Uint8Array(6 + 8 * n));
  mem.poke(LAYOUT.avail + 2n, le16(start));
  mem.poke(LAYOUT.used + 2n, le16(start));
  mem.hook = null;
  const q = new Queue(n);
  q.size = n;
  q.desc = LAYOUT.desc;
  q.avail = LAYOUT.avail;
  q.used = LAYOUT.used;
  q.ready = true;
  q.indirect = w.cfg.mode === "ring" && w.cfg.indirect;
  q.setPositions(start, start);
  q.validate(mem);
  w.queue = q;
  w.drv = { availIdx: start, lastUsed: start, free: Array.from({ length: n }, (_, i) => i), inflight: new Map(), noInterrupt: false };
  w.dev = { status: "ok", notified: false, intStatus: 0 };
}

const bufFor = (i) => LAYOUT.buf + 0x1000n * BigInt(i);
const tableFor = (i) => LAYOUT.table + 0x100n * BigInt(i);

function takeFree(w, count) {
  const out = w.drv.free.slice(0, count);
  w.drv.free = w.drv.free.slice(count);
  return out;
}

function outstanding(w) {
  return u16(w.drv.availIdx - w.drv.lastUsed);
}

/** The driver publishes `head` in the next avail slot and bumps avail.idx (Ring::push). */
function publish(w, head) {
  const slot = w.drv.availIdx % w.n;
  w.mem.guestWrite(LAYOUT.avail + 4n + 2n * BigInt(slot), le16(head));
  w.drv.availIdx = u16(w.drv.availIdx + 1);
  w.mem.guestWrite(LAYOUT.avail + 2n, le16(w.drv.availIdx));
  return slot;
}

function refuse(text) {
  return { ok: false, text };
}

/** Driver: add one request whose descriptors are `descs` (addr omitted = the index's own buffer). */
function addRequest(w, descs, label) {
  const idx = takeFree(w, descs.length);
  idx.forEach((i, k) => {
    const d = descs[k];
    const last = k === idx.length - 1;
    const flags = (d.write ? F_WRITE : 0) | (last ? 0 : F_NEXT);
    w.mem.guestWrite(LAYOUT.desc + 16n * BigInt(i), encodeDesc(desc(d.addr ?? bufFor(i), d.len, flags, last ? 0 : idx[k + 1])));
  });
  const before = w.drv.availIdx;
  const slot = publish(w, idx[0]);
  w.drv.inflight.set(idx[0], { indices: idx, label });
  return {
    ok: true,
    text: `Driver: ${label}, head ${idx[0]} (${idx.join(" → ")}), in avail.ring[${slot}]; avail.idx ${hex16(before)} → ${hex16(w.drv.availIdx)}. No exit: the device does not know yet.`,
    changed: { desc: idx, avail: [slot] },
  };
}

function addHostile(w, id) {
  const h = HOSTILE.find((x) => x.id === id);
  const n = w.n;
  const idx = takeFree(w, h.descs);
  const put = (i, d) => w.mem.guestWrite(LAYOUT.desc + 16n * BigInt(i), encodeDesc(d));
  const putAt = (t, i, d) => w.mem.guestWrite(t + 16n * BigInt(i), encodeDesc(d));
  const [a, b] = idx;
  switch (id) {
    case "loop": put(a, desc(bufFor(a), 8, F_NEXT, a)); break;
    case "cycle": put(a, desc(bufFor(a), 8, F_NEXT, b)); put(b, desc(bufFor(b), 8, F_NEXT, a)); break;
    case "next": put(a, desc(bufFor(a), 16, F_NEXT, n)); break;
    case "mmio": put(a, desc(MMIO_ADDR, 4, 0, 0)); break;
    case "end": put(a, desc(RAM_BASE + RING_RAM_SIZE - 8n, 16, 0, 0)); break;
    case "huge": put(a, desc(bufFor(a), U32_MAX, F_WRITE, 0)); break;
    case "wrap": put(a, desc(U64_MAX - 10n, U32_MAX, 0, 0)); break;
    case "zero": put(a, desc(bufFor(a), 0, 0, 0)); break;
    case "order": put(a, desc(bufFor(a), 16, F_NEXT | F_WRITE, b)); put(b, desc(bufFor(b), 16, 0, 0)); break;
    case "cap": put(a, desc(bufFor(a), 0x8_0000, F_WRITE, 0)); break;
    case "ind": {
      const t = tableFor(a);
      putAt(t, 0, desc(bufFor(a), 16, F_NEXT, 1));
      putAt(t, 1, desc(bufFor(a) + 0x100n, 64, F_WRITE, 0));
      put(a, desc(t, 32, F_INDIRECT, 0));
      break;
    }
    case "indnext": {
      const t = tableFor(a);
      putAt(t, 0, desc(bufFor(a), 8, 0, 0));
      put(a, desc(t, 16, F_INDIRECT | F_NEXT, a));
      break;
    }
    case "nest": {
      const t = tableFor(a);
      putAt(t, 0, desc(t + 0x80n, 16, F_INDIRECT, 0));
      put(a, desc(t, 16, F_INDIRECT, 0));
      break;
    }
    case "indlen": put(a, desc(tableFor(a), 24, F_INDIRECT, 0)); break;
    case "flip": {
      put(a, desc(bufFor(a), 16, F_NEXT, b));
      put(b, desc(bufFor(b) + 0x100n, 64, F_WRITE, 0));
      const at = LAYOUT.desc + 16n * BigInt(a);
      w.mem.hook = { trigger: at, span: 16, addr: at, bytes: encodeDesc(desc(MMIO_ADDR, U32_MAX, F_NEXT | F_WRITE, a)), what: `the guest rewrites descriptor ${a}: addr ${hexAddr(MMIO_ADDR)}, len 0xFFFF_FFFF, NEXT|WRITE, next ${a}` };
      break;
    }
    default: break;
  }
  if (id === "jump" || id === "back") {
    const before = w.drv.availIdx;
    w.drv.availIdx = u16(id === "jump" ? before + n + 1 : before - 1);
    w.mem.guestWrite(LAYOUT.avail + 2n, le16(w.drv.availIdx));
    const claim = id === "jump" ? `claiming ${n + 1} new requests in a ring of ${n}` : `one lower: to the device that is ${grouped(u16(w.drv.availIdx - w.queue.nextAvail))} pending`;
    return { ok: true, text: `Hostile driver: avail.idx ${hex16(before)} → ${hex16(w.drv.availIdx)}, ${claim}.`, changed: { avail: [] } };
  }
  const head = id === "head" ? n : a;
  const before = w.drv.availIdx;
  const slot = publish(w, head);
  if (id !== "head") w.drv.inflight.set(head, { indices: idx, label: h.label.toLowerCase() });
  const where = id === "head" ? `head ${n}` : `head ${a}${idx.length > 1 ? ` (${idx.join(", ")})` : ""}`;
  return {
    ok: true,
    text: `Hostile driver: ${h.label.charAt(0).toLowerCase()}${h.label.slice(1)}; ${where} in avail.ring[${slot}], avail.idx ${hex16(before)} → ${hex16(w.drv.availIdx)}.`,
    changed: { desc: idx, avail: [slot] },
  };
}

function doorbell(w) {
  w.exits.doorbell += 1;
  if (w.dev.status === "reset") {
    return { ok: true, text: `Driver: store to QueueNotify (${hexAddr(SLOT0 + BigInt(REG_QUEUE_NOTIFY))}): one VM exit, ignored. The device needs a reset and ignores the doorbell until the driver writes 0 to Status.` };
  }
  w.dev.notified = true;
  return { ok: true, text: `Driver: store to QueueNotify (${hexAddr(SLOT0 + BigInt(REG_QUEUE_NOTIFY))}): one VM exit. The device will look at the ring.` };
}

function walkOpts(w) {
  if (w.cfg.mode === "toy") return {};
  return { budget: w.cfg.budget, reread: w.cfg.reread };
}

/** Hops whose checks are kept in full at the start of a walk; after that only the last two. */
export const TRACE_HEAD_HOPS = 16;

/** A check recorder that keeps a long walk's trace small: the first hops, a gap, the last two. */
function boundedRecorder() {
  const head = [];
  let tail = [];
  const post = [];
  let omitted = 0;
  const rec = (e) => {
    if (e.hop === undefined) {
      (tail.length ? post : head).push(e);
      return;
    }
    if (e.hop <= TRACE_HEAD_HOPS) {
      head.push(e);
      return;
    }
    tail.push(e);
    const keepFrom = e.hop - 1;
    const before = tail.length;
    tail = tail.filter((x) => x.hop >= keepFrom);
    if (tail.length < before) omitted = Math.max(omitted, keepFrom - 1 - TRACE_HEAD_HOPS);
  };
  const list = () => {
    const gap = omitted ? [{ gap: true, hops: omitted, text: `... ${grouped(omitted)} more hops like these ...` }] : [];
    return [...head, ...gap, ...tail, ...post];
  };
  return { rec, list };
}

/** Device: take one chain and serve it (pop, walk, reply, add_used, maybe interrupt). */
function processOne(w) {
  const trace = boundedRecorder();
  const rec = trace.rec;
  w.mem.log = [];
  const res = { ok: true, log: w.mem.log, changed: { used: [] } };
  let chain = null;
  try {
    chain = w.queue.pop(w.mem, walkOpts(w), rec);
    if (!chain) {
      w.dev.notified = false;
      res.text = "Device: avail.idx equals next_avail, so nothing is pending. It stops looking until the next doorbell.";
      res.outcome = "empty";
      res.checks = trace.list();
      return res;
    }
    const v = chain.intoValidated(w.cap);
    res.hops = chain.hops;
    res.chain = v;
    const want = Number(v.writableLen > BigInt(U32_MAX) ? BigInt(U32_MAX) : v.writableLen);
    // A disk request ends in a 1-byte status buffer; write 0 there (VIRTIO_BLK_S_OK) rather than
    // filler, so the bytes the reader sees are ones a real disk could write.
    const lastW = v.writable[v.writable.length - 1];
    const statusAt = v.writable.length >= 2 && lastW.len === 1 ? want - 1 : -1;
    const written = writeWritable(w.mem, v, want, (i) => (i === statusAt ? 0 : i % 251));
    const slot = w.queue.nextUsed & (w.n - 1);
    w.queue.addUsed(w.mem, v.head, written, rec);
    res.changed.used = [slot];
    const irq = w.queue.shouldInterrupt(w.mem, rec);
    if (irq) w.dev.intStatus |= INT_USED;
    res.outcome = "ok";
    res.written = written;
    res.checks = trace.list();
    res.text = `Device: the request at head ${v.head} is valid (${v.readable.length} readable, ${v.writable.length} writable, ${chain.hops} hop${chain.hops === 1 ? "" : "s"}). It wrote ${grouped(written)} byte${written === 1 ? "" : "s"} and reported used.len = ${written}${irq ? ", then raised the interrupt line (no exit with the in-kernel GIC)" : "; the driver asked for no interrupt"}.`;
    return res;
  } catch (e) {
    if (e instanceof Hang) {
      w.dev.status = "hung";
      res.outcome = "hang";
      res.hops = e.hops;
      res.checks = trace.list();
      res.text = `Device: still walking after ${grouped(e.hops)} hops, with no end in sight. On a real host this loop never ends: one 16-byte guest write pins a host thread. Turn the hop budget back on.`;
      return res;
    }
    if (!(e instanceof VqError)) throw e;
    w.dev.status = "reset";
    w.dev.notified = false;
    w.dev.intStatus |= INT_CONFIG;
    res.outcome = "error";
    res.error = e;
    res.debug = debugOf(e);
    res.hops = chain ? chain.hops : 0;
    rec({ rule: "error", ok: false, text: `${displayOf(e)}: DEVICE_NEEDS_RESET, and a configuration interrupt` });
    res.checks = trace.list();
    const after = chain && chain.hops ? ` at hop ${grouped(chain.hops)}` : "";
    res.text = `Device: ${displayOf(e)}${after}. It sets DEVICE_NEEDS_RESET, raises a configuration interrupt and ignores the doorbell until the driver writes 0 to Status. The VM keeps running.`;
    return res;
  }
}

/** Driver: the interrupt handler, then reclaim every used entry. */
function reclaim(w) {
  const usedIdx = decodeU16(w.mem.peek(LAYOUT.used + 2n, 2));
  const line = w.dev.intStatus !== 0;
  const parts = [];
  if (line) {
    const bits = w.dev.intStatus;
    w.exits.handler += 2;
    w.dev.intStatus = 0;
    parts.push(`Interrupt handler: read InterruptStatus (${hex(bits)}) and wrote InterruptACK: two VM exits; the line drops.`);
    if (bits & INT_CONFIG) parts.push("Bit 1, configuration changed, is set; reading Status (one more exit, not counted here) shows DEVICE_NEEDS_RESET.");
  }
  const done = [];
  let k = 0;
  while (w.drv.lastUsed !== usedIdx && k < w.n) {
    const slot = w.drv.lastUsed % w.n;
    const e = w.mem.peek(LAYOUT.used + 4n + 8n * BigInt(slot), 8);
    const id = (e[0] | (e[1] << 8) | (e[2] << 16) | (e[3] << 24)) >>> 0;
    const len = (e[4] | (e[5] << 8) | (e[6] << 16) | (e[7] << 24)) >>> 0;
    const req = w.drv.inflight.get(id);
    if (req) {
      w.drv.inflight.delete(id);
      w.drv.free = [...w.drv.free, ...req.indices].sort((x, y) => x - y);
    }
    done.push(`head ${id} (${len} byte${len === 1 ? "" : "s"})`);
    w.drv.lastUsed = u16(w.drv.lastUsed + 1);
    k += 1;
  }
  if (done.length) parts.push(`Driver: used.idx is ${hex16(usedIdx)}; reclaimed ${done.join(", ")} and freed their descriptors.`);
  else parts.push("Driver: no new used entries.");
  return { ok: true, text: parts.join(" ") };
}

function resetDevice(w) {
  w.exits.reset += 1;
  setUp(w);
  return { ok: true, text: "Driver: wrote 0 to Status (one VM exit). The device forgets everything; the driver zeroes the rings and sets the queue up again (more register writes, not counted here)." };
}

function toggleFlags(w) {
  w.drv.noInterrupt = !w.drv.noInterrupt;
  w.mem.guestWrite(LAYOUT.avail, le16(w.drv.noInterrupt ? AVAIL_F_NO_INTERRUPT : 0));
  return { ok: true, text: w.drv.noInterrupt ? "Driver: set NO_INTERRUPT in avail.flags (\"I will poll, do not interrupt me\")." : "Driver: cleared NO_INTERRUPT in avail.flags (interrupts wanted again)." };
}

function decodeU16(b) {
  return b[0] | (b[1] << 8);
}

const HUNG = "The device thread is stuck in an endless walk; nothing else happens until you undo or reset the lab.";

/** Why `token` is not allowed in world `w` right now, or null. Cheap: it changes nothing. */
export function whyNot(w, token) {
  if (w.cfg.mode === "toy") {
    return w.history.length >= TOY_STEPS.length ? "The toy is finished. Reset it, or switch to the full ring." : null;
  }
  if (typeof token !== "string" || !validToken(token)) return "Unknown action.";
  if (w.dev.status === "hung") return token === "z" ? "The device thread is stuck in an endless walk: a register write cannot reach it. Undo, or reset the lab." : HUNG;
  const need = token.startsWith("q") ? parseSpec(token.slice(1)).length
    : token.startsWith("h") ? HOSTILE.find((x) => x.id === token.slice(1)).descs : 0;
  if (token.startsWith("q") || token.startsWith("h")) {
    if (w.drv.free.length < need) return `The driver has ${w.drv.free.length} free descriptor${w.drv.free.length === 1 ? "" : "s"} and this request needs ${need}. Reclaim used ones first.`;
    if (token !== "hjump" && token !== "hback" && outstanding(w) >= w.n) return `All ${w.n} ring slots are waiting for the device. Reclaim used ones first.`;
    return null;
  }
  if (token === "p") {
    if (w.dev.status === "reset") return "The device needs a reset: it does no work until the driver writes 0 to Status.";
    if (!w.dev.notified) return "No doorbell yet: the device has not been told to look. Ring the doorbell first.";
    return null;
  }
  if (token === "u") {
    const usedIdx = decodeU16(w.mem.peek(LAYOUT.used + 2n, 2));
    if (w.dev.intStatus === 0 && usedIdx === w.drv.lastUsed) return "Nothing to reclaim: used.idx equals the driver's last_used and no interrupt is pending.";
    return null;
  }
  return null;
}

/** Apply one action token to the (mutable) world. Returns {ok, text, ...}. */
export function apply(w, token) {
  const no = whyNot(w, token);
  if (no) return refuse(no);
  let r;
  if (w.cfg.mode === "toy") r = toyStep(w);
  else if (token === "n") r = doorbell(w);
  else if (token === "p") r = processOne(w);
  else if (token === "u") r = reclaim(w);
  else if (token === "z") r = resetDevice(w);
  else if (token === "f") r = toggleFlags(w);
  else if (token.startsWith("q")) {
    const spec = parseSpec(token.slice(1));
    const shape = REQUEST_SHAPES.find((sh) => specToken(sh.spec) === token);
    const label = shape ? shape.label.split(":")[0].toLowerCase() : `request (${spec.map(([k, l]) => `${k === "r" ? "readable" : "writable"} ${l}`).join(", ")})`;
    r = addRequest(w, spec.map(([k, len]) => ({ write: k === "w", len })), label);
  } else r = addHostile(w, token.slice(1));
  r.token = token;
  w.last = r;
  w.history.push(r);
  return r;
}

// ---------------------------------------------------------------------------------------------
// The toy (chapter 15): one descriptor, one doorbell, one "done", in eight steps

export const TOY_DATA_ADDR = 0x4410_0000n;
export const TOY_LEN = 4096;
export const TOY_SECTOR = 8;
const TOY_TEXT = "Hello from the guest, sector 8. ";
export function toyByte(i) {
  return TOY_TEXT.charCodeAt(i % TOY_TEXT.length);
}

export const TOY_STEPS = [
  { who: "guest", title: "Write the data", text: `The guest kernel writes the data, ${TOY_LEN} bytes at ${hexAddr(TOY_DATA_ADDR)}, into its own RAM. No exit: it is ordinary memory.` },
  { who: "guest", title: "Write a description", text: `It writes a description into the ring: descriptor 0 says "${TOY_LEN} bytes at ${hexAddr(TOY_DATA_ADDR)}, the device reads them", and the available ring says "the request at descriptor 0 is ready" (avail.idx 0 → 1). Still no exit.` },
  { who: "guest", title: "Ring the doorbell", text: `It stores to the doorbell, QueueNotify at offset 0x050 of the device's window (${hexAddr(SLOT0 + BigInt(REG_QUEUE_NOTIFY))}). This is the first VM exit.` },
  { who: "vmm", title: "Read the ring", text: "Our VMM reads the ring through GuestMemory: avail.idx, the head index, then the 16-byte descriptor, copied once and checked." },
  { who: "vmm", title: "Do the I/O", text: `It copies the ${TOY_LEN} bytes straight out of guest RAM (this copy is the DMA) and writes them to sector ${TOY_SECTOR} of the disk.` },
  { who: "vmm", title: "Write \"done\"", text: "It writes \"done\" into the used ring: id 0, len 0 (len counts only the bytes the device wrote into the guest's buffers, and this request had none), then publishes used.idx = 1." },
  { who: "vmm", title: "Raise the line", text: "It raises the interrupt line. With chapter 12's in-kernel GIC this costs no exit." },
  { who: "guest", title: "Take the interrupt", text: "The guest takes the interrupt. On virtio-mmio its handler reads InterruptStatus (0x060) and writes InterruptACK (0x064): two more exits. It sees used.idx = 1 and frees descriptor 0." },
];

function toyStep(w) {
  const k = w.history.length; // 0-based index of the step being taken
  const r = { ok: true, text: `Step ${k + 1} of 8: ${TOY_STEPS[k].text}`, toyStep: k + 1, changed: {} };
  const checks = [];
  const rec = (e) => checks.push(e);
  switch (k) {
    case 0: {
      const data = new Uint8Array(TOY_LEN);
      for (let i = 0; i < TOY_LEN; i++) data[i] = toyByte(i);
      w.mem.guestWrite(TOY_DATA_ADDR, data);
      r.changed = { data: true };
      break;
    }
    case 1: {
      const a = addRequest(w, [{ addr: TOY_DATA_ADDR, len: TOY_LEN, write: false }], "toy write");
      r.changed = a.changed;
      break;
    }
    case 2:
      w.exits.doorbell += 1;
      w.dev.notified = true;
      break;
    case 3: {
      w.mem.log = [];
      const chain = w.queue.pop(w.mem, {}, rec);
      w.toyChain = chain.intoValidated(w.cap);
      r.log = w.mem.log;
      r.checks = checks;
      break;
    }
    case 4: {
      w.mem.log = [];
      const d = w.toyChain.readable[0];
      const bytes = w.mem.read(d.addr, d.len, `copy ${d.len} bytes of data out of guest RAM (the DMA)`);
      w.disk = { sector: TOY_SECTOR, bytes };
      r.log = w.mem.log;
      r.changed = { disk: true };
      break;
    }
    case 5: {
      w.mem.log = [];
      w.queue.addUsed(w.mem, w.toyChain.head, 0, rec);
      w.dev.notified = false;
      r.log = w.mem.log;
      r.checks = checks;
      r.changed = { used: [0] };
      break;
    }
    case 6: {
      w.mem.log = [];
      if (w.queue.shouldInterrupt(w.mem, rec)) w.dev.intStatus |= INT_USED;
      r.log = w.mem.log;
      r.checks = checks;
      break;
    }
    case 7: {
      const rr = reclaim(w);
      r.extra = rr.text;
      break;
    }
    default: break;
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// Public API for the view

/** Replay `state` and describe everything the view draws. Never throws on a valid state. */
export function simulate(state) {
  return snapshot(replay(state));
}

/** A picture of the world: the three areas as the bytes in RAM say, plus both sides' counters. */
export function snapshot(w) {
  const { n, mem } = w;
  const descs = [];
  const owner = new Map();
  for (const [head, req] of w.drv.inflight) req.indices.forEach((i, k) => owner.set(i, { head, pos: k }));
  for (let i = 0; i < n; i++) {
    const d = decodeDesc(mem.peek(LAYOUT.desc + 16n * BigInt(i), 16));
    descs.push({ index: i, ...d, owner: owner.get(i) ?? null, free: w.drv.free.includes(i) });
  }
  const availFlags = decodeU16(mem.peek(LAYOUT.avail, 2));
  const availIdx = decodeU16(mem.peek(LAYOUT.avail + 2n, 2));
  const availRing = [];
  for (let i = 0; i < n; i++) availRing.push(decodeU16(mem.peek(LAYOUT.avail + 4n + 2n * BigInt(i), 2)));
  const usedFlags = decodeU16(mem.peek(LAYOUT.used, 2));
  const usedIdx = decodeU16(mem.peek(LAYOUT.used + 2n, 2));
  const usedRing = [];
  for (let i = 0; i < n; i++) {
    const e = mem.peek(LAYOUT.used + 4n + 8n * BigInt(i), 8);
    usedRing.push({ id: (e[0] | (e[1] << 8) | (e[2] << 16) | (e[3] << 24)) >>> 0, len: (e[4] | (e[5] << 8) | (e[6] << 16) | (e[7] << 24)) >>> 0 });
  }
  const indirect = [];
  for (const d of descs) {
    if (d.flags & F_INDIRECT && d.owner && mem.checkRange(d.addr, BigInt(Math.max(16, Math.min(d.len, 256))))) {
      const count = Math.min(Math.floor(d.len / 16), 16) || 1;
      const rows = [];
      for (let i = 0; i < count; i++) rows.push({ index: i, ...decodeDesc(mem.peek(d.addr + 16n * BigInt(i), 16)) });
      indirect.push({ from: d.index, addr: d.addr, len: d.len, rows });
    }
  }
  return {
    cfg: w.cfg,
    n,
    start: w.start,
    cap: w.cap,
    ram: mem.regions,
    descs,
    indirect,
    avail: { addr: LAYOUT.avail, flags: availFlags, idx: availIdx, ring: availRing },
    used: { addr: LAYOUT.used, flags: usedFlags, idx: usedIdx, ring: usedRing },
    device: {
      nextAvail: w.queue.nextAvail,
      nextUsed: w.queue.nextUsed,
      broken: w.queue.broken,
      status: w.dev.status,
      notified: w.dev.notified,
      intStatus: w.dev.intStatus,
      line: w.dev.intStatus !== 0,
      pending: u16(availIdx - w.queue.nextAvail),
    },
    driver: {
      availIdx: w.drv.availIdx,
      lastUsed: w.drv.lastUsed,
      free: [...w.drv.free],
      inflight: [...w.drv.inflight].map(([head, r]) => ({ head, indices: r.indices, label: r.label })),
      noInterrupt: w.drv.noInterrupt,
      unreclaimed: u16(usedIdx - w.drv.lastUsed),
    },
    exits: { ...w.exits, total: w.exits.doorbell + w.exits.handler + w.exits.reset },
    disk: w.disk,
    last: w.last,
    history: w.history.map((h) => ({ token: h.token, text: h.text, outcome: h.outcome ?? null })),
    toyStep: w.cfg.mode === "toy" ? w.history.length : null,
    hook: mem.hook ? { addr: mem.hook.addr } : null,
  };
}

/** Replay `state` into a world (for whyNot on several tokens after one replay). */
export function replay(state) {
  const w = newWorld(state.cfg);
  for (const t of state.actions) apply(w, t);
  return w;
}

/** Is `token` allowed after `state`? Returns null or the reason it is not. */
export function canDo(state, token) {
  return whyNot(replay(state), token);
}

/** The next state, or the same object when the action is refused or meaningless. */
export function step(state, action) {
  switch (action.type) {
    case "do": {
      if (state.actions.length >= MAX_ACTIONS) return state;
      if (canDo(state, action.token) !== null) return state;
      return { cfg: state.cfg, actions: [...state.actions, action.token] };
    }
    case "undo":
      return state.actions.length ? { cfg: state.cfg, actions: state.actions.slice(0, -1) } : state;
    case "reset":
      return { cfg: state.cfg, actions: [] };
    case "mode":
      if (action.mode === state.cfg.mode) return state;
      return { cfg: defaultConfig(action.mode), actions: [] };
    case "config": {
      if (state.cfg.mode !== "ring") return state;
      const cfg = { ...state.cfg, ...action.cfg };
      if (!SIZES.includes(cfg.n) || !(cfg.cap in CAPS) || !Number.isInteger(cfg.start) || cfg.start < 0 || cfg.start > 0xffff) return state;
      // Ring geometry changes start a fresh ring; walker options keep the actions (replayed).
      const geometry = cfg.n !== state.cfg.n || cfg.start !== state.cfg.start || cfg.indirect !== state.cfg.indirect;
      const next = { cfg, actions: geometry ? [] : state.actions };
      if (!geometry) {
        // Replay; keep only the allowed prefix under the new options.
        const w = newWorld(cfg);
        const kept = [];
        for (const t of next.actions) {
          if (!apply(w, t).ok) break;
          kept.push(t);
        }
        next.actions = kept;
      }
      return next;
    }
    case "load":
      return { cfg: { ...action.state.cfg }, actions: [...action.state.actions] };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios: one click to a prepared ring, the device's step left to the reader

export const PRESETS = [
  { id: "read", title: "A normal disk read", goal: "Three descriptors: a 16-byte header the device reads, 512 bytes it fills, a status byte. Process it, then reclaim.", state: "ring-n8-s0-c10000:qr10.w200.w1_n" },
  { id: "puzzle", title: "The opening puzzle: a self-loop", goal: "Descriptor 0 points at itself. Press Device: process one and count the hops.", state: "ring-n8-s0-c10000:hloop_n" },
  { id: "nobudget", title: "Self-loop, hop budget removed", goal: "The hop budget is switched off (chapter 16, 'The hop budget'). With a 64 KiB cap still in place, which guard stops the walk, and after how many hops?", state: "ring-n8-s0-c10000-nobudget:hloop_n" },
  { id: "hang", title: "Self-loop, no budget and no cap", goal: "The virtio-net case: nothing else bounds the walk.", state: "ring-n8-s0-cnone-nobudget:hloop_n" },
  { id: "wrap", title: "Indices crossing 65535", goal: "next_avail starts at 0xFFFE and the driver adds four requests: watch the slots go 6, 7, 0, 1 and the count stay right.", state: "ring-n8-sfffe-c10000:qw40_qw40_qw40_qw40_n" },
  { id: "jump", title: "avail.idx jumps by N + 1", goal: "A count no honest driver can produce.", state: "ring-n8-s0-c10000:hjump_n" },
  { id: "mmio", title: "A buffer in the PL011's window", goal: "addr 0x0900_0000 is a device register, not RAM.", state: "ring-n8-s0-c10000:hmmio_n" },
  { id: "flip", title: "Rewritten after the check", goal: "The guest rewrites descriptor 0 right after the device copies it (chapter 16, 'The guest writes while we read'). Our VMM's walker uses its copy.", state: "ring-n8-s0-c10000:hflip_n" },
  { id: "reread", title: "Rewritten after the check, len re-read", goal: "The same rewrite, but the walker hands out len from a second read of guest memory instead of its copy (chapter 16, 'The guest writes while we read').", state: "ring-n8-s0-c10000-reread:hflip_n" },
  { id: "indirect", title: "An indirect table", goal: "With indirect descriptors negotiated, one ring slot carries a table of two.", state: "ring-n8-s0-c10000-i:hind_n" },
];

/**
 * "Try next": the honest driver's next move from this state, for a reader who has never seen a
 * ring (add a request, ring the doorbell, process it, reclaim it). Ring mode only; null in the toy.
 */
export function nextHint(snap) {
  if (snap.cfg.mode !== "ring") return null;
  const d = snap.device;
  if (d.status === "hung") return "Undo, or turn the hop budget back on in Ring settings.";
  if (d.status === "reset") return "Driver: reset the device. It does nothing else until then.";
  if (d.pending > 0 && !d.notified) return "Driver: ring the doorbell, so the device looks at the ring.";
  if (d.pending > 0) return "Device: process one, and read the checks it ran.";
  if (snap.driver.unreclaimed > 0 || d.line) return "Driver: reclaim used, to take the finished requests back.";
  if (!snap.history.length) return "Driver: add request (a disk read is already chosen), or pick a scenario.";
  return "Add another request, or switch on hostile mode and publish a misbehaviour.";
}

/** One-line summary for the live region. */
export function summary(snap) {
  if (snap.cfg.mode === "toy") {
    if (snap.toyStep === 0) return `Toy ring: one descriptor, one doorbell, one "done". Press Next step. Exits so far: 0.`;
    // The step's own sentence first: it says what happened and whether it cost an exit.
    const extra = snap.last.extra ? ` ${snap.last.extra}` : "";
    return `Step ${snap.toyStep} of 8: ${snap.last.text}${extra} Exits so far: ${snap.exits.total}.`;
  }
  const last = snap.last ? snap.last.text : "A fresh ring: nothing published yet.";
  return `${last} Pending for the device: ${snap.device.pending}. Exits: ${snap.exits.total}.`;
}
