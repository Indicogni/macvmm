// hostile-guest model: chapter 25's fuzzer, in the browser.
//
// A line-by-line port of the reference's dependency-free fuzzer for the `virtqueue` target:
//   crates/fuzz/src/rng.rs            xorshift64* and Rng::derive (SplitMix64 finalizer)
//   crates/fuzz/src/mutate.rs         byte mutators and the descriptor-shape mutator
//   crates/fuzz/src/targets/mod.rs    the two-region RAM, in_one_region, within
//   crates/fuzz/src/targets/virtqueue.rs   input layout, seed(), mutate(), run(), complete()
//   crates/fuzz/src/main.rs           the loop: Rng::derive(seed, i), seed, 0-8 mutations, run
// running against ports of chapter 16's device side:
//   crates/vmm/src/virtio/chain.rs    the descriptor walk (hop budget, indirect, into_validated)
//   crates/vmm/src/virtio/queue.rs    pop and add_used
//   crates/vmm/src/memory/vec_mem.rs  VecMemory with its access log; region.rs `locate`
// and the five planted bugs of crates/fuzz/planted/ as switches.
//
// The order of every random draw is the Rust order, so iteration i of seed s produces the same
// bytes as `cargo run -p fuzz -- virtqueue --seed s`; the tests check the captured iteration
// numbers (7, 250, 22, 4, 23,338,941) and messages, and a table recorded from the Rust fuzzer.
//
// Pure module: no DOM, no I/O. 64-bit values are BigInt; lengths (u32) are Numbers.

const M64 = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------------------------
// The PRNG (rng.rs)

export class Rng {
  constructor(seed) {
    const s = BigInt.asUintN(64, BigInt(seed));
    this.s = s === 0n ? 1n : s; // seed 0 is mapped to 1 (0 is a fixed point of xorshift)
  }

  /** A generator for (seed, stream): iteration `stream` regenerated without the ones before. */
  static derive(seed, stream) {
    let z = BigInt.asUintN(64, BigInt(seed)) ^ ((BigInt(stream) * 0x9e3779b97f4a7c15n) & M64);
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return new Rng(z ^ (z >> 31n));
  }

  nextU64() {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & M64;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & M64;
  }

  /** A value in 0..n (0 when n is 0; a draw is still consumed, as in Rust). */
  below(n) {
    const v = this.nextU64();
    if (n === 0) return 0;
    return Number(v % BigInt(n));
  }
  index(n) { return this.below(n); }
  oneIn(n) { return this.below(n) === 0; }
  byte() { return Number(this.nextU64() & 0xffn); }
  coin() { return (this.nextU64() & 1n) === 1n; }
  pick(items) { return items[this.index(items.length)]; }
}

// ---------------------------------------------------------------------------------------------
// Little-endian helpers over a plain array of byte values (mutate.rs put_le / get_le)

export function putLe(buf, off, n, v) {
  if (off + n > buf.length) return; // "if they fit"
  let x = BigInt.asUintN(64, BigInt(v));
  for (let i = 0; i < n; i++) {
    buf[off + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

export function getLe(buf, off, n) {
  let v = 0n;
  for (let i = Math.min(n, 8) - 1; i >= 0; i--) {
    const b = buf[off + i];
    v = (v << 8n) | BigInt(b === undefined ? 0 : b);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// The fuzz RAM (targets/mod.rs): two regions and a hole, so "inside one region" can fail.

export const RAM_A = 0x4000_0000n;
export const RAM_A_SIZE = 0x4_0000n;
export const RAM_B = 0x4008_0000n;
export const RAM_B_SIZE = 0x1_0000n;
export const REGIONS = [[RAM_A, RAM_A_SIZE], [RAM_B, RAM_B_SIZE]];
export const PL011_BASE = 0x0900_0000n;

/** [addr, addr + len) inside one region, in unbounded arithmetic (the oracle). */
export function inOneRegion(addr, len) {
  return REGIONS.some(([b, s]) => len > 0n && addr >= b && addr + len <= b + s);
}

/** [a, a + alen) inside [b, b + blen). */
export function within(a, alen, b, blen) {
  return a >= b && a + alen <= b + blen;
}

// ---------------------------------------------------------------------------------------------
// Input layout (targets/virtqueue.rs)

export const MAX_SIZE = 256;
export const IND_ENTRIES = 64;
export const HEADS_OFF = 8;
export const DESC_OFF = HEADS_OFF + 2 * MAX_SIZE; // 520
export const IND_OFF = DESC_OFF + 16 * MAX_SIZE; // 4616
export const INPUT_LEN = IND_OFF + 16 * IND_ENTRIES; // 5640

export const DESC = RAM_A + 0x1000n;
export const AVAIL = RAM_A + 0x2000n;
export const USED = RAM_A + 0x3000n;
export const IND = RAM_A + 0x4000n;
export const BUF_A = RAM_A + 0x8000n;

const F_NEXT = 1;
const F_WRITE = 2;
const F_INDIRECT = 4;

export const INTERESTING_BYTES = [
  0x1b, 0x5b, 0x5d, 0x50, 0x5f, 0x9b, 0x9d, 0x07, 0xc2, 0xe2, 0xf0, 0x80, 0x00, 0xff, 0x3b, 0x3f,
];
export const INTERESTING_U64 = [
  0n, 1n, 2n, 0x7fn, 0x80n, 0xffn, 0xffffn, 0x8000_0000n, 0xffff_ffffn, 0x1_0000_0000n,
  0x7fff_ffff_ffff_ffffn, 0x8000_0000_0000_0000n, M64 - 1n, M64,
];

export function hex(v) {
  return `0x${BigInt(v).toString(16)}`;
}

/** Which field an input byte belongs to (for the mutation notes and the hex view). */
export function describeOffset(off) {
  if (off === 0) return "queue size";
  if (off === 1) return "options";
  if (off === 2 || off === 3) return "chains per round";
  if (off === 4) return "byte cap";
  if (off === 5) return "rounds";
  if (off < HEADS_OFF) return "unused header byte";
  if (off < DESC_OFF) return `avail entry ${(off - HEADS_OFF) >> 1}`;
  const field = (r) => (r < 8 ? "addr" : r < 12 ? "len" : r < 14 ? "flags" : "next");
  if (off < IND_OFF) return `descriptor ${(off - DESC_OFF) >> 4} ${field((off - DESC_OFF) & 15)}`;
  if (off < INPUT_LEN) return `indirect-table entry ${(off - IND_OFF) >> 4} ${field((off - IND_OFF) & 15)}`;
  return "past the layout";
}

// ---------------------------------------------------------------------------------------------
// Mutators (mutate.rs). `notes`, when given, collects one plain sentence per mutation.

/** One generic byte-level mutation, keeping buf at most maxLen long. */
export function mutateBytes(rng, buf, maxLen, notes) {
  if (buf.length === 0) {
    buf.push(rng.byte());
    notes?.push("byte: the input was empty, one random byte added");
    return;
  }
  const at = rng.index(buf.length);
  const where = `byte ${at} (${describeOffset(at)})`;
  switch (rng.below(9)) {
    case 0: {
      const bit = rng.below(8);
      buf[at] ^= 1 << bit;
      notes?.push(`byte: flip bit ${bit} of ${where}`);
      break;
    }
    case 1: {
      buf[at] = rng.byte();
      notes?.push(`byte: random value ${hex(buf[at])} at ${where}`);
      break;
    }
    case 2:
    case 3: {
      buf[at] = rng.pick(INTERESTING_BYTES);
      notes?.push(`byte: escape-biased value ${hex(buf[at])} (one of 16 bytes that start or steer terminal escape sequences and UTF-8 characters) at ${where}`);
      break;
    }
    case 4: {
      const n = 1 << rng.below(4);
      const v = rng.pick(INTERESTING_U64);
      putLe(buf, at, n, v);
      notes?.push(`byte: boundary integer ${hex(v)} as ${n} byte${n > 1 ? "s" : ""} at ${where}${at + n > buf.length ? " (did not fit, skipped)" : ""}`);
      break;
    }
    case 5: {
      const n = 1 + rng.index(8);
      let added = 0;
      for (let k = 0; k < n; k++) {
        if (buf.length >= maxLen) break;
        const v = rng.pick(INTERESTING_BYTES);
        buf.splice(Math.min(at, buf.length), 0, v);
        added++;
      }
      notes?.push(`byte: insert ${added} byte${added === 1 ? "" : "s"} at ${where} ${added ? "(everything after shifts)" : "(no change: the input is full)"}`);
      break;
    }
    case 6: {
      const n = 1 + rng.index(16);
      const end = Math.min(at + n, buf.length);
      buf.splice(at, end - at);
      notes?.push(`byte: delete ${end - at} byte${end - at === 1 ? "" : "s"} from ${where} (everything after shifts)`);
      break;
    }
    case 7: {
      const n = 1 + rng.index(32);
      const end = Math.min(at + n, buf.length);
      const chunk = buf.slice(at, end);
      const room = Math.max(0, maxLen - buf.length);
      const take = Math.min(chunk.length, room);
      buf.splice(at, 0, ...chunk.slice(0, take));
      notes?.push(`byte: duplicate ${take} byte${take === 1 ? "" : "s"} at ${where}${take ? "" : " (no change: the input is full)"}`);
      break;
    }
    default: {
      const up = rng.coin();
      buf[at] = (buf[at] + (up ? 1 : 255)) & 0xff;
      notes?.push(`byte: ${up ? "add 1 to" : "subtract 1 from"} ${where}`);
    }
  }
  if (buf.length > maxLen) buf.length = maxLen;
}

/** One structural mutation of a table of n 16-byte records at `table` (mutate::descriptor). */
export function mutateDescriptor(rng, buf, table, n, shape, notes) {
  if (n === 0) return;
  const i = rng.index(n);
  const rec = table + 16 * i;
  const name = `${table === IND_OFF ? "indirect-table entry" : "descriptor"} ${i}`;
  switch (rng.below(6)) {
    case 0: {
      const bit = rng.pick([F_NEXT, F_WRITE, F_INDIRECT]);
      putLe(buf, rec + 12, 2, getLe(buf, rec + 12, 2) ^ BigInt(bit));
      notes?.push(`shape: toggle ${bit === 1 ? "NEXT" : bit === 2 ? "WRITE" : "INDIRECT"} on ${name}`);
      break;
    }
    case 1: {
      const j = rng.index(i + 1); // a back edge: next = some j <= i, with NEXT set
      putLe(buf, rec + 14, 2, j);
      putLe(buf, rec + 12, 2, getLe(buf, rec + 12, 2) | 1n);
      notes?.push(`shape: back edge, ${name} next = ${j} with NEXT set${j === i ? " (points at itself)" : ""}`);
      break;
    }
    case 2: {
      const addr = getLe(buf, rec, 8);
      let len;
      let why;
      switch (rng.below(4)) {
        case 0: len = 0n; why = "0"; break;
        case 1: len = 0xffff_ffffn; why = "0xffffffff"; break;
        case 2: len = 0x8000_0000n; why = "0x80000000"; break;
        default: {
          const r = shape.regions[rng.index(shape.regions.length)];
          const target = r ? BigInt.asUintN(64, r[0] + BigInt(rng.below(Number(r[1] < 1n ? 1n : r[1] > 64n ? 64n : r[1])))) : 0n;
          len = BigInt.asUintN(64, target - addr + 1n) & 0xffff_ffffn;
          const end = BigInt.asUintN(64, addr + len - 1n);
          if (len === 0n) why = `0 (aimed at ${hex(target)}; the 32-bit length wraps to 0)`;
          else if (end === target) why = `${hex(len)}, so it ends at ${hex(target)}`;
          else why = `${hex(len)} (aimed at ${hex(target)}; the 32-bit length wraps, so it ends at ${hex(end)})`;
        }
      }
      putLe(buf, rec + 8, 4, len);
      notes?.push(`shape: ${name} len = ${why}`);
      break;
    }
    case 3: {
      let addr;
      let why;
      switch (rng.below(4)) {
        case 0: {
          const r = shape.regions[rng.index(shape.regions.length)];
          addr = r ? BigInt.asUintN(64, r[0] + r[1] - BigInt(1 + rng.below(32))) : 0n;
          why = "the last bytes of a region";
          break;
        }
        case 1: {
          const r = shape.regions[rng.index(shape.regions.length)];
          addr = r ? BigInt.asUintN(64, r[0] + r[1] + BigInt(rng.below(16))) : 0n;
          why = "just past a region";
          break;
        }
        case 2: {
          const k = rng.index(shape.specials.length);
          addr = shape.specials[k] ?? 0n;
          why = shape.specialNames?.[k] ?? "a special address";
          break;
        }
        default:
          addr = rng.pick(INTERESTING_U64);
          why = "a boundary integer";
      }
      putLe(buf, rec, 8, addr);
      notes?.push(`shape: ${name} addr = ${hex(addr)} (${why})`);
      break;
    }
    case 4: {
      putLe(buf, rec + 14, 2, (i + 1) % n);
      putLe(buf, rec + 12, 2, getLe(buf, rec + 12, 2) | 1n);
      notes?.push(`shape: forward chain, ${name} next = ${(i + 1) % n} with NEXT set`);
      break;
    }
    default: {
      const v = rng.pick(INTERESTING_U64);
      putLe(buf, rec + 14, 2, v);
      notes?.push(`shape: ${name} next = ${hex(v & 0xffffn)}`);
    }
  }
}

const SPECIALS = [DESC, AVAIL, USED, IND, PL011_BASE, RAM_A + RAM_A_SIZE];
const SHAPE = {
  regions: REGIONS,
  specials: SPECIALS,
  specialNames: ["the descriptor table", "the avail ring", "the used ring", "the indirect table", "the UART", "the hole"],
};

/** The target's structural mutation (virtqueue::mutate). */
export function mutateTarget(rng, buf, notes) {
  while (buf.length < INPUT_LEN) buf.push(0);
  const size = 1 << ((buf[0] ?? 0) % 9);
  const times = 1 + rng.index(3);
  for (let t = 0; t < times; t++) {
    const k = rng.below(8);
    if (k <= 3) mutateDescriptor(rng, buf, DESC_OFF, size, SHAPE, notes);
    else if (k <= 5) mutateDescriptor(rng, buf, IND_OFF, IND_ENTRIES, SHAPE, notes);
    else if (k === 6) {
      const slot = rng.index(MAX_SIZE);
      const v = rng.pick([0, 1, size - 1, size, 0xffff]);
      putLe(buf, HEADS_OFF + 2 * slot, 2, v);
      notes?.push(`shape: avail entry ${slot} = ${v}${v >= size ? " (not a descriptor of this queue)" : ""}`);
    } else {
      const v = rng.pick([0, 1, size, size + 1, 0x8000, 0xffff]);
      putLe(buf, 2, 2, v);
      notes?.push(`shape: chains per round = ${v}${v > size ? " (more than the queue holds: an index jump)" : ""}`);
    }
  }
}

/** A random well-formed ring (virtqueue::seed). */
export function seedInput(rng) {
  const b = new Array(INPUT_LEN).fill(0);
  const exp = rng.oneIn(4) ? rng.below(9) : rng.below(5);
  const size = 1 << exp;
  const indirect = rng.coin();
  b[0] = exp;
  const packed = rng.oneIn(4) ? 2 : 0;
  const noInt = rng.oneIn(3) ? 4 : 0;
  b[1] = (indirect ? 1 : 0) | packed | noInt;
  b[4] = rng.below(4);
  b[5] = rng.below(4);
  let nextDesc = 0;
  let nextInd = 0;
  const heads = [];
  while (nextDesc < size && heads.length < size) {
    const head = nextDesc;
    let parts = 1 + rng.index(4);
    const useInd = indirect && rng.oneIn(3) && nextInd + parts <= IND_ENTRIES;
    if (!useInd) parts = Math.min(parts, size - nextDesc);
    const writeFrom = rng.index(parts + 1);
    const buffer = (k) => {
      const [base, sz] = rng.coin() ? [BUF_A, RAM_A + RAM_A_SIZE - BUF_A] : [RAM_B, RAM_B_SIZE];
      const len = 1 + rng.below(1024);
      const addr = base + BigInt(rng.below(Number(sz) - len));
      return [addr, len, k >= writeFrom ? 2 : 0];
    };
    if (useInd) {
      const rec = DESC_OFF + 16 * nextDesc;
      putLe(b, rec, 8, IND + BigInt(16 * nextInd));
      putLe(b, rec + 8, 4, 16 * parts);
      putLe(b, rec + 12, 2, 4);
      nextDesc += 1;
      for (let k = 0; k < parts; k++) {
        let [addr, len, flags] = buffer(k);
        const r = IND_OFF + 16 * (nextInd + k);
        if (k + 1 < parts) {
          flags |= 1;
          putLe(b, r + 14, 2, k + 1);
        }
        putLe(b, r, 8, addr);
        putLe(b, r + 8, 4, len);
        putLe(b, r + 12, 2, flags);
      }
      nextInd += parts;
    } else {
      for (let k = 0; k < parts; k++) {
        let [addr, len, flags] = buffer(k);
        const r = DESC_OFF + 16 * (nextDesc + k);
        if (k + 1 < parts) {
          flags |= 1;
          putLe(b, r + 14, 2, nextDesc + k + 1);
        }
        putLe(b, r, 8, addr);
        putLe(b, r + 8, 4, len);
        putLe(b, r + 12, 2, flags);
      }
      nextDesc += parts;
    }
    heads.push(head);
    if (rng.oneIn(3)) break;
  }
  for (let slot = 0; slot < MAX_SIZE; slot++) {
    putLe(b, HEADS_OFF + 2 * slot, 2, heads[slot % Math.max(heads.length, 1)] ?? 0);
  }
  putLe(b, 2, 2, heads.length);
  return b;
}

/**
 * Iteration `iter` of a run with `seed` (main.rs's loop body): a fresh well-formed ring, then
 * 0 to 8 mutations, each by coin toss structural or byte-level. Returns the bytes and, with
 * `withNotes`, one sentence per mutation.
 */
export function generate(seed, iter, withNotes = false) {
  const rng = Rng.derive(BigInt(seed), BigInt(iter));
  const input = seedInput(rng);
  const notes = withNotes ? [] : undefined;
  const rounds = rng.below(9);
  for (let r = 0; r < rounds; r++) {
    if (rng.coin()) mutateTarget(rng, input, notes);
    else mutateBytes(rng, input, INPUT_LEN, notes);
  }
  if (input.length > INPUT_LEN) input.length = INPUT_LEN;
  return { input: Uint8Array.from(input), notes: notes ?? [], rounds };
}

// ---------------------------------------------------------------------------------------------
// Guest memory (vec_mem.rs + region.rs locate), with the access log the invariants read

class Memory {
  constructor() {
    this.regions = [
      { base: RAM_A, end: RAM_A + RAM_A_SIZE, bytes: new Uint8Array(Number(RAM_A_SIZE)) },
      { base: RAM_B, end: RAM_B + RAM_B_SIZE, bytes: new Uint8Array(Number(RAM_B_SIZE)) },
    ];
    this.log = null;
  }

  /** region.rs `locate`: the region and offset, or an error object. */
  locate(addr, len) {
    const end = addr + len;
    if (end > M64) return { err: `Overflow { addr: ${addr}, len: ${len} }` };
    const oob = { err: `OutOfBounds { addr: ${addr}, len: ${len} }` };
    if (len === 0n) return oob;
    let r = null;
    for (const s of this.regions) if (s.base <= addr) r = s;
    if (!r || end > r.end) return oob;
    return { r, off: Number(addr - r.base) };
  }

  checkRange(addr, len) {
    return !this.locate(addr, len).err;
  }

  read(addr, n, ordered = false) {
    const at = this.locate(addr, BigInt(n));
    if (at.err) return at;
    if (this.log) this.log.push({ addr, len: n, write: false, ordered });
    return { bytes: at.r.bytes, off: at.off };
  }

  write(addr, data, ordered = false) {
    const at = this.locate(addr, BigInt(data.length));
    if (at.err) return at;
    at.r.bytes.set(data, at.off);
    if (this.log) this.log.push({ addr, len: data.length, write: true, ordered });
    return {};
  }

  /** A run of n equal bytes (the device's fill), without building a large array first. */
  fill(addr, n, value) {
    const at = this.locate(addr, BigInt(n));
    if (at.err) return at;
    at.r.bytes.fill(value, at.off, at.off + n);
    if (this.log) this.log.push({ addr, len: n, write: true, ordered: false });
    return {};
  }

  readU16(addr, ordered = false) {
    if (ordered && (addr & 1n) !== 0n) return { err: `Unaligned { addr: ${addr} }` };
    const r = this.read(addr, 2, ordered);
    if (r.err) return r;
    return { v: r.bytes[r.off] | (r.bytes[r.off + 1] << 8) };
  }

  writeU16(addr, v, ordered = false) {
    if (ordered && (addr & 1n) !== 0n) return { err: `Unaligned { addr: ${addr} }` };
    return this.write(addr, [v & 0xff, (v >> 8) & 0xff], ordered);
  }

  readDesc(addr) {
    const r = this.read(addr, 16);
    if (r.err) return r;
    const b = r.bytes;
    const o = r.off;
    let a = 0n;
    for (let i = 7; i >= 0; i--) a = (a << 8n) | BigInt(b[o + i]);
    return {
      d: {
        addr: a,
        len: (b[o + 8] | (b[o + 9] << 8) | (b[o + 10] << 16) | (b[o + 11] << 24)) >>> 0,
        flags: b[o + 12] | (b[o + 13] << 8),
        next: b[o + 14] | (b[o + 15] << 8),
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The planted bugs (crates/fuzz/planted/*.patch)

export const PLANTS = [
  {
    id: "ref", n: 0, file: null, name: "No plant: the reference",
    what: "The unmodified walker and queue. A fuzzer that finds nothing here is the control.",
  },
  {
    id: "p1", n: 1, file: "01-chain-range-no-checked-add.patch", name: "Plant 1: no checked_add",
    what: "chain.rs judges a buffer by its first and last byte, computed with wrapping arithmetic, instead of as one span.",
  },
  {
    id: "p2", n: 2, file: "02-chain-no-hop-budget.patch", name: "Plant 2: no hop budget",
    what: "chain.rs no longer counts hops, so a next that points back is walked until something else gives up.",
  },
  {
    id: "p3", n: 3, file: "03-used-idx-off-by-one.patch", name: "Plant 3: used-ring index off by one",
    what: "queue.rs computes the used-ring slot as next_used % (N + 1) instead of % N.",
  },
  {
    id: "p4", n: 4, file: "04-desc-len-double-fetch.patch", name: "Plant 4: double fetch",
    what: "chain.rs reads a descriptor again after validating it and keeps the second len.",
  },
  {
    id: "p5", n: 5, file: "05-chain-verdict-cache.patch", name: "Plant 5: verdict cache",
    what: "chain.rs skips the RAM check for a buffer at the same address as the buffer two hops earlier (the first and third buffers of a three-buffer chain), whatever its length. The chapter calls it the second plant.",
  },
];

export function plantById(id) {
  return PLANTS.find((p) => p.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The descriptor walk (chain.rs), with the plants

/**
 * The real fuzzer's watchdog calls an iteration over 2 s a hang. Measured on the reference Mac
 * (plant 2 applied, `--replay` of a size-2 ring whose descriptor 0 points at itself), the walk does
 * about 35 million descriptor reads a second: 67,108,865 reads took 1.89 s and failed invariant 2,
 * 4,294,967,297 did not finish in 60 s. A pop past this many reads is reported as a hang.
 */
export const HANG_READS = 70_000_000;

/** A guard on reads actually performed here (loops are skipped ahead, so it never trips). */
const WALK_GUARD = 1_000_000;

function err(kind, text) {
  return { kind, text };
}

class Chain {
  constructor(mem, table, queueSize, head, indirectAllowed, plant, rec) {
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
    this.plant = plant;
    this.seen = [null, null];
    this.rec = rec; // trace sink or null
    this.reads = 0;
    this.skipped = 0; // reads accounted for by skipping whole loops (plant 2 only)
  }

  readDesc(index) {
    if (index >= this.tableLen) {
      return { e: err("NextOutOfRange", `next ${index} is outside a table of ${this.tableLen}`) };
    }
    const addr = this.table + 16n * BigInt(index);
    if (addr > M64) return { e: err("Overflow", `table address overflows at entry ${index}`) };
    this.reads++;
    if (this.reads - this.skipped > WALK_GUARD) return { e: err("Hang", `still walking after ${WALK_GUARD.toLocaleString("en-US")} descriptor reads`), hang: true };
    const r = this.mem.readDesc(addr);
    if (r.err) return { e: err("Memory", `descriptor read at ${hex(addr)} failed: ${r.err}`) };
    return { d: r.d, addr };
  }

  note(entry) {
    if (this.rec && this.rec.length < 64) this.rec.push(entry);
    if (this.rec) this.rec.total = (this.rec.total ?? 0) + 1;
  }

  step() {
    for (;;) {
      if (this.next === null) return { d: null };
      const index = this.next;
      if (this.plant !== 2) {
        if (this.budget === 0) {
          const budget = this.inIndirect ? this.tableLen : this.queueSize;
          return { e: err("ChainTooLong", `the hop budget of ${budget} ran out`) };
        }
        this.budget -= 1;
      }
      const got = this.readDesc(index);
      if (got.e) return got;
      const d = got.d;
      const where = { table: this.inIndirect ? "indirect" : "main", index, at: got.addr, ...d };
      if (d.flags & F_INDIRECT) {
        const e = this.enterIndirect(d);
        this.note({ ...where, verdict: e ? e.text : `enter the indirect table (${this.tableLen} entries)` , bad: !!e });
        if (e) return { e };
        continue;
      }
      if (d.len === 0) {
        this.note({ ...where, verdict: "refused: zero length", bad: true });
        return { e: err("ZeroLength", `descriptor ${index} has length 0`) };
      }
      const len = BigInt(d.len);
      if (this.plant === 1) {
        // PLANTED BUG 1: first and last byte, wrapping arithmetic, no span check.
        const last = BigInt.asUintN(64, d.addr + len - 1n);
        if (!this.mem.checkRange(d.addr, 1n) || !this.mem.checkRange(last, 1n)) {
          this.note({ ...where, verdict: "refused: first or last byte not in RAM", bad: true });
          return { e: err("BufferOutOfRam", `${hex(d.addr)}+${hex(d.len)} is not in RAM`) };
        }
      } else {
        if (d.addr + len > M64) {
          this.note({ ...where, verdict: "refused: addr + len overflows", bad: true });
          return { e: err("Overflow", `${hex(d.addr)}+${hex(d.len)} overflows`) };
        }
        const cached = this.plant === 5 && this.seen[0] !== null && this.seen[0].addr === d.addr;
        if (!cached && !this.mem.checkRange(d.addr, len)) {
          this.note({ ...where, verdict: "refused: not inside one RAM region", bad: true });
          return { e: err("BufferOutOfRam", `${hex(d.addr)}+${hex(d.len)} is not inside one RAM region`) };
        }
        if (this.plant === 5) this.seen = [this.seen[1], { addr: d.addr, len: d.len }];
        if (cached) where.cached = true;
      }
      let next = null;
      if (d.flags & F_NEXT) {
        if (d.next >= this.tableLen) {
          this.note({ ...where, verdict: `refused: next ${d.next} outside the table`, bad: true });
          return { e: err("NextOutOfRange", `next ${d.next} is outside a table of ${this.tableLen}`) };
        }
        next = d.next;
      }
      this.next = next;
      let out = d;
      if (this.plant === 4) {
        // PLANTED BUG 4: read the descriptor again and keep the second len.
        const again = this.readDesc(index);
        if (again.e) return again;
        out = { ...d, len: again.d.len };
        where.again = true;
      }
      this.note({ ...where, verdict: where.cached ? "accepted without a RAM check (same address as two hops back)" : "accepted", bad: false, write: (d.flags & F_WRITE) !== 0 });
      return { d: out };
    }
  }

  enterIndirect(d) {
    if (!this.indirectAllowed) return err("IndirectNotNegotiated", "indirect descriptors were not negotiated");
    if (this.inIndirect) return err("NestedIndirect", "an indirect table inside an indirect table");
    if (d.flags & F_NEXT) return err("IndirectWithNext", "an indirect descriptor with NEXT set");
    const entries = Math.floor(d.len / 16);
    if (d.len === 0 || d.len % 16 !== 0 || entries > this.queueSize) {
      return err("BadIndirectLen", `indirect table length ${hex(d.len)} is not 16 to ${16 * this.queueSize} in steps of 16`);
    }
    const len = BigInt(d.len);
    if (d.addr + len > M64) return err("Overflow", `${hex(d.addr)}+${hex(d.len)} overflows`);
    if (!this.mem.checkRange(d.addr, len)) {
      return err("BufferOutOfRam", `indirect table ${hex(d.addr)}+${hex(d.len)} is not inside one RAM region`);
    }
    this.table = d.addr;
    this.tableLen = entries;
    this.next = 0;
    this.budget = entries;
    this.inIndirect = true;
    return null;
  }

  nextItem() {
    if (this.failed) return null;
    const r = this.step();
    if (r.e) {
      this.failed = true;
      return r;
    }
    if (r.d === null) {
      this.next = null;
      return null;
    }
    return r;
  }

  /** into_validated: readable before writable, each direction at most maxTotal bytes. */
  intoValidated(maxTotal) {
    const v = { head: this.head, readable: [], writable: [], readableLen: 0, writableLen: 0 };
    // Plant 2 only: a walk with no hop budget can loop for billions of reads before the byte cap
    // stops it. The descriptors do not change during a walk, so when a (table, entry) pair comes
    // round again the loop repeats exactly; skip whole loops, counting their reads, until the
    // cap is near, then walk the rest. The read count comes out the same as walking every step.
    const seen = this.plant === 2 ? new Map() : null;
    for (;;) {
      if (seen && !this.failed && this.next !== null) {
        const key = `${this.inIndirect ? 1 : 0}:${this.table}:${this.next}`;
        const prev = seen.get(key);
        if (!prev) seen.set(key, { reads: this.reads, r: v.readableLen, w: v.writableLen });
        else {
          seen.clear();
          const dR = v.readableLen - prev.r;
          const dW = v.writableLen - prev.w;
          const dReads = this.reads - prev.reads;
          if ((dR === 0) !== (dW === 0)) {
            const write = dW > 0;
            const step = write ? dW : dR;
            const total = write ? v.writableLen : v.readableLen;
            const k = Math.floor((maxTotal - total) / step) - 1;
            if (k > 0) {
              this.reads += k * dReads;
              this.skipped += k * dReads;
              if (write) v.writableLen += k * step;
              else v.readableLen += k * step;
              if (this.rec) this.rec.total = (this.rec.total ?? 0) + k * dReads;
            }
          }
        }
      }
      const it = this.nextItem();
      if (it === null) return { v };
      if (it.e) return it;
      const d = it.d;
      if (d.flags & F_WRITE) {
        const t = v.writableLen + d.len;
        if (t > maxTotal) return { e: err("TooLarge", `writable total ${t} is over the cap ${maxTotal}`) };
        v.writableLen = t;
        v.writable.push(d);
      } else {
        if (v.writable.length) return { e: err("ReadableAfterWritable", "a readable buffer after a writable one") };
        const t = v.readableLen + d.len;
        if (t > maxTotal) return { e: err("TooLarge", `readable total ${t} is over the cap ${maxTotal}`) };
        v.readableLen = t;
        v.readable.push(d);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The queue (queue.rs)

class Queue {
  constructor(spec, plant) {
    this.size = spec.size;
    this.desc = spec.desc;
    this.avail = spec.avail;
    this.used = spec.used;
    this.indirect = spec.indirect;
    this.nextAvail = 0;
    this.nextUsed = 0;
    this.broken = false;
    this.plant = plant;
  }

  pop(mem, rec) {
    const r = this.popInner(mem, rec);
    if (r.e && r.e.kind !== "Broken") this.broken = true;
    return r;
  }

  popInner(mem, rec) {
    if (this.broken) return { e: err("Broken", "the queue is broken until the device is reset") };
    const idx = mem.readU16(this.avail + 2n, true);
    if (idx.err) return { e: err("Memory", `avail.idx: ${idx.err}`) };
    const pending = (idx.v - this.nextAvail) & 0xffff;
    if (pending > this.size) {
      return { e: err("AvailIdxJump", `avail.idx ${idx.v} is ${pending} ahead of ours (${this.nextAvail}); the queue holds ${this.size}`) };
    }
    if (pending === 0) return { chain: null };
    const slot = this.nextAvail & (this.size - 1);
    const head = mem.readU16(this.avail + 4n + 2n * BigInt(slot));
    if (head.err) return { e: err("Memory", `avail entry: ${head.err}`) };
    if (head.v >= this.size) return { e: err("HeadOutOfRange", `head ${head.v} is outside a queue of ${this.size}`) };
    this.nextAvail = (this.nextAvail + 1) & 0xffff;
    return { chain: new Chain(mem, this.desc, this.size, head.v, this.indirect, this.plant, rec), head: head.v };
  }

  addUsed(mem, head, written) {
    if (this.broken) return { e: err("Broken", "broken") };
    if (head >= this.size) return { e: err("HeadOutOfRange", "head") };
    const slot = this.plant === 3 ? this.nextUsed % (this.size + 1) : this.nextUsed & (this.size - 1);
    const elem = [head & 0xff, (head >> 8) & 0xff, 0, 0, written & 0xff, (written >>> 8) & 0xff, (written >>> 16) & 0xff, (written >>> 24) & 0xff];
    const w = mem.write(this.used + 4n + 8n * BigInt(slot), elem);
    if (w.err) return { e: err("Memory", `used element: ${w.err}`), slot };
    this.nextUsed = (this.nextUsed + 1) & 0xffff;
    const i = mem.writeU16(this.used + 2n, this.nextUsed, true);
    if (i.err) return { e: err("Memory", `used.idx: ${i.err}`), slot };
    return { slot };
  }
}

// ---------------------------------------------------------------------------------------------
// The target (virtqueue.rs): decode, write the rings, pop, validate, complete, check invariants

const CAPS = [64 << 10, 4 << 10, 1 << 20, 2 ** 32];

/** Spec::decode, a total reader: missing bytes read as zero. */
export function decodeSpec(data) {
  const at = (i) => data[i] ?? 0;
  const size = 1 << (at(0) % 9);
  const flags = at(1);
  const perRound = at(2) | (at(3) << 8);
  const maxTotal = CAPS[at(4) % 4];
  const rounds = 1 + (at(5) % 4);
  let desc = DESC;
  let avail = AVAIL;
  let used = USED;
  const packed = (flags & 2) !== 0;
  if (packed) {
    const n = BigInt(size);
    const end = RAM_B + RAM_B_SIZE;
    used = (end - (6n + 8n * n)) & ~3n;
    avail = (used - (6n + 2n * n)) & ~1n;
    desc = (avail - 16n * n) & ~15n;
  }
  return {
    size, indirect: (flags & 1) !== 0, packed, noInterrupt: (flags & 4) !== 0,
    perRound, maxTotal, rounds, desc, avail, used,
  };
}

function writeRings(spec, data, mem) {
  const slice = (off, n) => (off > data.length ? null : data.subarray(off, Math.min(off + n, data.length)));
  const table = new Uint8Array(16 * spec.size);
  const src = slice(DESC_OFF, table.length);
  if (src) table.set(src);
  mem.write(spec.desc, table);
  const ind = new Uint8Array(16 * IND_ENTRIES);
  const isrc = slice(IND_OFF, ind.length);
  if (isrc) ind.set(isrc);
  mem.write(IND, ind);
  const avail = new Array(4 + 2 * spec.size).fill(0);
  putLe(avail, 0, 2, spec.noInterrupt ? 1 : 0);
  putLe(avail, 2, 2, spec.perRound);
  for (let slot = 0; slot < spec.size; slot++) {
    putLe(avail, 4 + 2 * slot, 2, getLe(data, HEADS_OFF + 2 * slot, 2));
  }
  mem.write(spec.avail, avail);
}

/** Invariant 3: no descriptor address read twice; the smallest repeated address, or null. */
function firstRepeat(addrs) {
  const s = [...addrs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (let i = 1; i < s.length; i++) if (s[i] === s[i - 1]) return s[i];
  return null;
}

export const INVARIANTS = [
  { n: 1, text: "No panic, and a ring error marks the queue broken." },
  { n: 2, text: "Bounded work: at most 2N + 1 descriptor reads per pop.", tag: "VQ-5" },
  { n: 3, text: "Each descriptor of a validated chain was read once.", tag: "MEM-7" },
  { n: 4, text: "Every validated buffer lies inside one RAM region, each direction within the cap.", tag: "VQ-4 (span) / VQ-8 (totals)" },
  { n: 5, text: "The device writes only into the chain's writable buffers and the used ring.", tag: "VQ-9" },
];

/**
 * Run one input (virtqueue::run). Returns { ok, message, invariant, hang, spec, pops, outcome }.
 * A pass that ends on a refusal also carries `notReached`: the first invariant virtqueue::run did
 * not get to check for that last pop (it returns Ok before them, as the Rust does).
 * `message` is the Rust verdict text, byte for byte. With `trace`, `pops` describes every pop
 * (the last one in full: each descriptor read, the verdict, the device's writes).
 */
export function runInput(data, plantN = 0, trace = false) {
  const spec = decodeSpec(data);
  const mem = new Memory();
  writeRings(spec, data, mem);
  const q = new Queue(spec, plantN);
  const maxReads = 2 * spec.size + 1;
  const pops = trace ? [] : null;
  let completed = 0;
  const done = (ok, message, invariant, outcome, extra = {}) => ({ ok, message, invariant, outcome, spec, pops, ...extra });
  for (let round = 0; round < spec.rounds; round++) {
    const idx = (spec.perRound * (round + 1)) & 0xffff;
    mem.writeU16(spec.avail + 2n, idx);
    for (let k = 0; k <= spec.size; k++) {
      mem.log = [];
      const rec = trace ? [] : null;
      const p = q.pop(mem, rec);
      const pop = trace ? { round, availIdx: idx, reads: rec } : null;
      if (pop) pops.push(pop);
      if (p.e) {
        // A ring error latches: the second pop is refused too, so the target is satisfied.
        if (pop) pop.error = p.e;
        if (q.broken && q.pop(mem, null).e) return done(true, null, null, `pop refused (${p.e.kind}): the queue is broken until reset, as it should be`, { notReached: 3 });
        return done(false, "a ring error did not latch the queue as broken", 1, "invariant 1 broken");
      }
      if (p.chain === null) {
        if (pop) pop.empty = true;
        break;
      }
      if (pop) pop.head = p.head;
      const validated = p.chain.intoValidated(spec.maxTotal);
      const reads = [];
      let count = p.chain.skipped;
      for (const a of mem.log) {
        if (!a.write && a.len === 16) {
          count++;
          if (reads.length <= maxReads) reads.push(a.addr);
        }
      }
      if (pop) pop.readCount = count;
      if (validated.hang || count > HANG_READS) {
        if (pop) pop.error = validated.e ?? null;
        const what = validated.hang ? validated.e.text : `${count} descriptor reads in one pop`;
        return done(false, `HANG: ${what}, over the reference fuzzer's 2 s watchdog`, 2, "hang", { hang: true, reads: count });
      }
      if (count > maxReads) {
        if (pop) pop.error = validated.e ?? null;
        return done(false, `${count} descriptor reads for one pop of a size-${spec.size} queue (VQ-5 hop budget)`, 2, "invariant 2 broken");
      }
      if (validated.e) {
        if (pop) pop.error = validated.e;
        return done(true, null, null, `chain refused (${validated.e.kind}): the device would set DEVICE_NEEDS_RESET`, { notReached: 3 });
      }
      const v = validated.v;
      if (pop) pop.validated = v;
      const rep = firstRepeat(reads);
      if (rep !== null) {
        return done(false, `descriptor at ${hex(rep)} read twice in one pop (double fetch, MEM-7)`, 3, "invariant 3 broken");
      }
      for (const d of [...v.readable, ...v.writable]) {
        if (!inOneRegion(d.addr, BigInt(d.len))) {
          if (pop) pop.bad = { addr: d.addr, len: d.len };
          return done(false, `validated buffer ${hex(d.addr)}+${hex(d.len)} is not inside one RAM region (VQ-4)`, 4, "invariant 4 broken");
        }
      }
      const sum = (ds) => ds.reduce((t, d) => t + d.len, 0);
      if (v.readableLen > spec.maxTotal || v.writableLen > spec.maxTotal || sum(v.readable) !== v.readableLen || sum(v.writable) !== v.writableLen) {
        return done(false, `chain totals r=${v.readableLen} w=${v.writableLen} vs max_total ${spec.maxTotal} (VQ-8)`, 4, "invariant 4 broken");
      }
      const c = complete(spec, mem, q, v, completed, pop);
      if (c.fail) return done(false, c.fail, 5, "invariant 5 broken");
      if (c.stop) return done(true, null, null, "add_used refused: the device would reset", { notReached: 5 });
      completed = c.completed;
    }
  }
  return done(true, null, null, `${completed} chain${completed === 1 ? "" : "s"} completed, every invariant held`);
}

function complete(spec, mem, q, v, completed, pop) {
  const n = BigInt(spec.size);
  mem.log = [];
  let left = Math.min(v.writableLen, 1 << 20);
  let written = 0;
  for (const d of v.writable) {
    if (left === 0) break;
    const k = Math.min(left, d.len);
    const w = mem.fill(d.addr, k, 0xa5);
    if (w.err) return { fail: `write into validated buffers failed: ${w.err}` };
    written += k;
    left -= k;
  }
  if (written > v.writableLen) return { fail: `used len ${written} > writable ${v.writableLen} (VQ-9)` };
  const a = q.addUsed(mem, v.head, written);
  if (pop) pop.usedSlot = a.slot;
  if (a.e) return { stop: true };
  const comp = (completed + 1) & 0xffff;
  if (pop) pop.writes = mem.log.filter((x) => x.write).map((x) => ({ addr: x.addr, len: x.len }));
  for (const w of mem.log) {
    if (!w.write) continue;
    const len = BigInt(w.len);
    const inBuf = v.writable.some((d) => within(w.addr, len, d.addr, BigInt(d.len)));
    const inElems = within(w.addr, len, spec.used + 4n, 8n * n);
    const isIdx = w.addr === spec.used + 2n && w.len === 2;
    if (!(inBuf || inElems || isIdx)) {
      if (pop) pop.badWrite = { addr: w.addr, len: w.len };
      return {
        fail: `device wrote ${hex(w.addr)}+${w.len} outside the writable buffers and the used ring (used ring ${hex(spec.used)}+${hex(6n + 8n * n)}; VQ-9)`,
      };
    }
  }
  const saved = mem.log;
  mem.log = null;
  const u = mem.readU16(spec.used + 2n);
  mem.log = saved;
  if (u.v !== comp) return { fail: `used.idx is ${u.v} after ${comp} completions` };
  return { completed: comp };
}

// ---------------------------------------------------------------------------------------------
// The driver loop and its output lines (main.rs)

/** The middle line: the browser saves nothing (the real driver saves the input to a file). */
export const NOT_SAVED = "input not saved (in the browser; the page URL keeps it)";

/**
 * What `cargo run -p fuzz -- virtqueue` prints for a failure at `iter`, in main.rs's formats:
 * FAILURE, where the input went, the iteration count. A hang is the watchdog's two lines.
 */
export function failureLines(seed, iter, message, hang = false) {
  if (hang) {
    return [
      `fuzz virtqueue: HANG at iteration ${iter} (> 2000 ms); ${NOT_SAVED}`,
      `fuzz virtqueue: ${iter} iterations, 1 failures`,
    ];
  }
  return [
    `fuzz virtqueue: FAILURE at iteration ${iter} (seed ${seed}): ${message}`,
    `fuzz virtqueue: ${NOT_SAVED}`,
    `fuzz virtqueue: ${iter + 1} iterations, 1 failures`,
  ];
}

/** The lines a replay prints. --replay has no watchdog, so a hang gets a lab note instead. */
export function replayLines(r) {
  if (r.ok) return ["fuzz virtqueue: replay OK"];
  if (r.hang) {
    const secs = r.reads ? Math.round(r.reads / 35e6) : null;
    return [`[lab] replay: no verdict. This pop walks ${r.reads ? r.reads.toLocaleString("en-US") : "too many"} descriptors; --replay has no watchdog, so cargo run would keep walking${secs ? ` for about ${secs.toLocaleString("en-US")} s` : ""}.`];
  }
  return [`fuzz virtqueue: replay FAILED: ${r.message}`];
}

/**
 * Fuzz from iteration `from` for at most `count` iterations or until a failure. Returns
 * { next, failure: null | { iter, message, invariant, hang } }.
 */
export function fuzz(seed, plantN, from, count) {
  let i = from;
  const end = from + count;
  for (; i < end; i++) {
    const { input } = generate(seed, i);
    const r = runInput(input, plantN, false);
    if (!r.ok) return { next: i + 1, failure: { iter: i, message: r.message, invariant: r.invariant, hang: !!r.hang } };
  }
  return { next: i, failure: null };
}

// ---------------------------------------------------------------------------------------------
// Minimisation: zero chunks (halves, quarters, ... single bytes) while the same invariant fails

export function nonZero(bytes) {
  let n = 0;
  for (const b of bytes) if (b !== 0) n++;
  return n;
}

/** The input with trailing zero bytes cut (a total reader reads them back as zero anyway). */
export function trimmedLength(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return end;
}

/**
 * Shrink `input` by zeroing chunks, keeping each change after which the run still breaks the
 * same invariant. Deterministic. Returns { bytes, tries, message }. `budget` caps the runs.
 */
export function minimise(input, plantN, budget = 20000) {
  const first = runInput(input, plantN);
  if (first.ok) return { bytes: Uint8Array.from(input), tries: 1, message: null };
  const want = first.invariant;
  let cur = Uint8Array.from(input);
  let tries = 1;
  let message = first.message;
  for (let chunk = Math.max(1, cur.length >> 1); chunk >= 1; chunk >>= 1) {
    let changed = true;
    while (changed) {
      changed = false;
      for (let at = 0; at < cur.length; at += chunk) {
        const end = Math.min(at + chunk, cur.length);
        let any = false;
        for (let i = at; i < end; i++) if (cur[i] !== 0) { any = true; break; }
        if (!any) continue;
        if (tries >= budget) return { bytes: cur, tries, message };
        const trial = Uint8Array.from(cur);
        trial.fill(0, at, end);
        tries++;
        const r = runInput(trial, plantN);
        if (!r.ok && r.invariant === want) {
          cur = trial;
          message = r.message;
          changed = true;
        }
      }
    }
    if (chunk === 1) break;
  }
  return { bytes: cur, tries, message };
}

// ---------------------------------------------------------------------------------------------
// The hand-built reproducer crates/fuzz/planted/05-three-buffers.bin (568 bytes, 17 not zero):
// one chain of three buffers, readable 0x40008000+16, writable 0x40009000+16, writable
// 0x40008000+0x40000. Stored as offset:value pairs so no binary file ships.

const THREE = [
  [0x0, 0x02], [0x2, 0x01], [0x4, 0x02],
  [0x209, 0x80], [0x20b, 0x40], [0x210, 0x10], [0x214, 0x01], [0x216, 0x01],
  [0x219, 0x90], [0x21b, 0x40], [0x220, 0x10], [0x224, 0x03], [0x226, 0x02],
  [0x229, 0x80], [0x22b, 0x40], [0x232, 0x04], [0x234, 0x02],
];
export const THREE_LEN = 568;

export function threeBuffers() {
  const b = new Uint8Array(THREE_LEN);
  for (const [o, v] of THREE) b[o] = v;
  return b;
}

/** The descriptor rows a reader would want to see: the first `limit` of the main table. */
export function tableRows(data, limit = 16) {
  const spec = decodeSpec(data);
  const rows = [];
  for (let i = 0; i < Math.min(spec.size, limit); i++) {
    const o = DESC_OFF + 16 * i;
    rows.push({ index: i, addr: getLe(data, o, 8), len: Number(getLe(data, o + 8, 4)), flags: Number(getLe(data, o + 12, 2)), next: Number(getLe(data, o + 14, 2)) });
  }
  return rows;
}

export function flagNames(f) {
  const out = [];
  if (f & F_NEXT) out.push("NEXT");
  if (f & F_WRITE) out.push("WRITE");
  if (f & F_INDIRECT) out.push("INDIRECT");
  if (f & ~7) out.push(hex(f & ~7 & 0xffff));
  return out.length ? out.join("|") : "-";
}

/** Where an address sits in the fuzz RAM, in words. */
export function placeOf(addr) {
  const a = BigInt(addr);
  if (a >= RAM_A && a < RAM_A + RAM_A_SIZE) return "region A";
  if (a >= RAM_B && a < RAM_B + RAM_B_SIZE) return "region B";
  if (a >= RAM_A + RAM_A_SIZE && a < RAM_B) return "the hole";
  return "outside RAM";
}

// ---------------------------------------------------------------------------------------------
// Share state: `<plant>:<seed>:<iter>` or `<plant>:three`, then `:m` when shrunk.
// Plant ids: ref, p1 ... p5. Seed: decimal u64. Iteration: decimal, at most 2^53 - 1.

export const REFERENCE_SHARE = "p2:1:7";
export const MAX_ITER = Number.MAX_SAFE_INTEGER;

export function parseSeed(text) {
  const t = String(text ?? "").trim();
  if (!/^[0-9]{1,20}$/.test(t)) return null;
  const v = BigInt(t);
  return v > M64 ? null : v;
}

export function parseIter(text) {
  const t = String(text ?? "").trim().replace(/[,_]/g, "");
  if (!/^[0-9]{1,16}$/.test(t)) return null;
  const v = Number(t);
  return Number.isSafeInteger(v) ? v : null;
}

export function encodeShare(s) {
  if (!s || !plantById(s.plant)) return null;
  const tail = s.shrunk ? ":m" : "";
  if (s.three) return `${s.plant}:three${tail}`;
  if (s.iter === null || s.iter === undefined) return null;
  return `${s.plant}:${s.seed}:${s.iter}${tail}`;
}

export function decodeShare(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 64) return null;
  if (!/^[a-z0-9:]+$/.test(text)) return null;
  const parts = text.split(":");
  const plant = plantById(parts[0]);
  if (!plant) return null;
  if (parts[1] === "three") {
    if (parts.length === 2) return { plant: plant.id, three: true, seed: 1n, iter: null, shrunk: false };
    if (parts.length === 3 && parts[2] === "m") return { plant: plant.id, three: true, seed: 1n, iter: null, shrunk: true };
    return null;
  }
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (parts.length === 4 && parts[3] !== "m") return null;
  const seed = parseSeed(parts[1]);
  const iter = parseIter(parts[2]);
  if (seed === null || iter === null || /[,_]/.test(parts[2])) return null;
  return { plant: plant.id, three: false, seed, iter, shrunk: parts.length === 4 };
}
